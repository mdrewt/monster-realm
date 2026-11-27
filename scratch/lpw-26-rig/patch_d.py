#!/usr/bin/env python3
"""Prototype D (lpw-26): the movement interval row exists only while a zone has work; NPC wander
has its own interval row. Run from the prototype worktree's root."""
p = 'server-module/src/movement.rs'
s = open(p).read()


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, (s.count(old), old[:80])
    s = s.replace(old, new)


# --- 1. arm: the movement row exists only while there is work ---------------------------------
rep('''pub(crate) fn arm_zone_tick(ctx: &ReducerContext, zone_id: u32) {
    if ctx
        .db
        .movement_tick_schedule()
        .iter()
        .any(|s| s.zone_id == zone_id)
    {
        return;
    }
    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: 0,
            zone_id,
            scheduled_at: ScheduleAt::Interval(
                Duration::from_millis(STEP_MS.unsigned_abs()).into(),
            ),
        });
}
''', '''pub(crate) fn arm_zone_tick(ctx: &ReducerContext, zone_id: u32) {
    if ctx
        .db
        .movement_tick_schedule()
        .iter()
        .any(|s| s.zone_id == zone_id)
    {
        return;
    }
    // PROTOTYPE lpw-26 D: the zone holds a movement row only while it has work. The first
    // tick of a burst of work is a one-shot at the next multiple of `STEP_MS` on the server
    // clock, so an input waits for its first tick as long as it does under a free-running
    // interval; that tick inserts the interval row the rest of the burst rides. Built with
    // LPW26_NO_KICK set, the interval row is inserted here instead and first fires one
    // `STEP_MS` after this call.
    let scheduled_at = if KICK_AT_GRID {
        let now = now_ms(ctx);
        let grid = (now.div_euclid(STEP_MS) + 1) * STEP_MS;
        ScheduleAt::Time(spacetimedb::Timestamp::from_micros_since_unix_epoch(
            grid * 1000,
        ))
    } else {
        step_interval()
    };
    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: 0,
            zone_id,
            scheduled_at,
        });
}

/// PROTOTYPE lpw-26 D: off when the build sets LPW26_NO_KICK.
const KICK_AT_GRID: bool = option_env!("LPW26_NO_KICK").is_none();

fn step_interval() -> ScheduleAt {
    ScheduleAt::Interval(Duration::from_millis(STEP_MS.unsigned_abs()).into())
}

/// PROTOTYPE lpw-26 D: arm the tick of the zone character `entity_id` stands in. Called by
/// every writer of a `move_intent` row, since an intent write is what gives a zone
/// player-side work.
pub(crate) fn arm_tick_for(ctx: &ReducerContext, entity_id: u64) {
    if let Some(ch) = ctx.db.character().entity_id().find(entity_id) {
        arm_zone_tick(ctx, ch.zone_id);
    }
}

/// PROTOTYPE lpw-26 D: is there anything in `zone` the next tick has to do? A character
/// whose row still shows a step (it has ended by the next tick), a private intent pair the
/// row does not publish yet, or an undrained input that can drain. A queue held by a battle
/// is not work.
fn zone_has_work(ctx: &ReducerContext, zone: u32) -> bool {
    let chars: Vec<Character> = ctx.db.character().zone_id().filter(zone).collect();
    chars.into_iter().any(|c| {
        if c.action != ActionState::Idle {
            return true;
        }
        let Some(intent) = ctx.db.move_intent().entity_id().find(c.entity_id) else {
            return false;
        };
        if c.move_queue != intent.queue || c.acked_seq != intent.last_input_seq {
            return true;
        }
        if intent.queue.is_empty() {
            return false;
        }
        !ctx.db
            .player()
            .entity_id()
            .filter(c.entity_id)
            .next()
            .map(|p| is_in_ongoing_battle(ctx, p.identity))
            .unwrap_or(false)
    })
}

/// PROTOTYPE lpw-26 D: NPC wander has its own schedule, one interval row per zone that holds
/// a player's character and an NPC that wanders. Its interval is the wander cadence.
#[spacetimedb::table(accessor = npc_wander_schedule, scheduled(npc_wander_tick))]
pub struct NpcWanderSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub zone_id: u32,
    pub scheduled_at: ScheduleAt,
}

/// PROTOTYPE lpw-26 D: arm `zone_id`'s wander row. Called by every path that puts a
/// player's character into a zone. A zone whose NPCs never wander gets no row.
pub(crate) fn arm_zone_wander(ctx: &ReducerContext, zone_id: u32) {
    if !ctx
        .db
        .npc()
        .zone_id()
        .filter(zone_id)
        .any(|n| n.wander_radius > 0)
    {
        return;
    }
    if ctx
        .db
        .npc_wander_schedule()
        .iter()
        .any(|s| s.zone_id == zone_id)
    {
        return;
    }
    ctx.db.npc_wander_schedule().insert(NpcWanderSchedule {
        id: 0,
        zone_id,
        scheduled_at: ScheduleAt::Interval(
            Duration::from_millis(
                STEP_MS.unsigned_abs() * game_core::npc::rules::NPC_STEP_TICKS,
            )
            .into(),
        ),
    });
}

fn zone_is_occupied(ctx: &ReducerContext, zone: u32) -> bool {
    let ids: Vec<u64> = ctx
        .db
        .character()
        .zone_id()
        .filter(zone)
        .map(|c| c.entity_id)
        .collect();
    ids.iter()
        .any(|&id| ctx.db.move_intent().entity_id().find(id).is_some())
        || ids.iter().any(|&id| is_player_character(ctx, id))
}

/// PROTOTYPE lpw-26 D: one wander beat for `sched.zone_id`. Scheduler-only. The beat that
/// finds no player's character in the zone sends its NPCs home and removes its own row.
#[spacetimedb::reducer]
pub fn npc_wander_tick(ctx: &ReducerContext, sched: NpcWanderSchedule) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("npc_wander_tick is scheduler-only".to_string());
    }
    let zone = sched.zone_id;
    if !zone_is_occupied(ctx, zone) {
        reset_npcs_home(ctx, zone);
        ctx.db.npc_wander_schedule().id().delete(sched.id);
        return Ok(());
    }
    let now = Millis(now_ms(ctx));
    let Ok(map) = crate::content_cache::cached_zone_tile_map(zone) else {
        return Ok(());
    };
    let tick_counter: u64 = now.0.unsigned_abs() / (STEP_MS.unsigned_abs().max(1));
    let npc_entity_ids: Vec<u64> = ctx
        .db
        .npc()
        .zone_id()
        .filter(zone)
        .map(|n| n.entity_id)
        .collect();
    let conversing: Vec<u64> = ctx
        .db
        .player_conversation()
        .iter()
        .filter(|c| npc_entity_ids.contains(&c.npc_entity_id))
        .filter(|c| conversation_is_live(ctx, c, zone))
        .map(|c| c.npc_entity_id)
        .collect();
    for entity_id in npc_entity_ids {
        if conversing.contains(&entity_id) {
            continue;
        }
        let Some(npc_row) = ctx.db.npc().entity_id().find(entity_id) else {
            continue;
        };
        let Some(mut ch) = ctx.db.character().entity_id().find(entity_id) else {
            continue;
        };
        let current = TilePos {
            x: ch.tile_x,
            y: ch.tile_y,
        };
        let home = TilePos {
            x: npc_row.home_x,
            y: npc_row.home_y,
        };
        let st = char_state(&ch);
        let Some(dir) = npc_decide(
            current,
            home,
            npc_row.wander_radius,
            st.facing,
            entity_id,
            tick_counter,
            map,
        ) else {
            continue;
        };
        let next_state = apply_move(&st, MoveInput::Step(dir), map, now);
        apply_state(&mut ch, &next_state);
        // Written at rest: the client draws a remote whose row says Idle on a tile it has
        // not reached yet as walking, so no later tick has to settle the row.
        ch.action = ActionState::Idle;
        ctx.db.character().entity_id().update(ch);
    }
    Ok(())
}
''')

# --- 2. entry sites arm the wander row, not the movement row ---------------------------------
rep('''        lead_level: 0,
    });
    arm_zone_tick(ctx, zone_id);
''', '''        lead_level: 0,
    });
    arm_zone_wander(ctx, zone_id);
''')
rep('''                    ctx.db.move_intent().entity_id().update(intent);
                    arm_zone_tick(ctx, to_zone);
''', '''                    ctx.db.move_intent().entity_id().update(intent);
                    arm_zone_wander(ctx, to_zone);
''')
rep('''    ctx.db.move_intent().entity_id().update(intent);
    arm_zone_tick(ctx, zone_id);
    Ok(())
}
''', '''    ctx.db.move_intent().entity_id().update(intent);
    arm_zone_wander(ctx, zone_id);
    Ok(())
}
''')

# --- 3. intent writers arm the movement row ---------------------------------------------------
rep('''    intent.queue.push(input);
    ctx.db.move_intent().entity_id().update(intent);
    // THE movement call site''', '''    intent.queue.push(input);
    let entity_id = intent.entity_id;
    ctx.db.move_intent().entity_id().update(intent);
    arm_tick_for(ctx, entity_id);
    // THE movement call site''')
rep('''    intent.queue.clear();
    intent.queue.push(input);
    ctx.db.move_intent().entity_id().update(intent);
    Ok(())
''', '''    intent.queue.clear();
    intent.queue.push(input);
    let entity_id = intent.entity_id;
    ctx.db.move_intent().entity_id().update(intent);
    arm_tick_for(ctx, entity_id);
    Ok(())
''')
rep('''    let mut intent = authorize_move(ctx, "clear_queue", seq)?;
    intent.queue.clear();
    ctx.db.move_intent().entity_id().update(intent);
    Ok(())
''', '''    let mut intent = authorize_move(ctx, "clear_queue", seq)?;
    intent.queue.clear();
    let entity_id = intent.entity_id;
    ctx.db.move_intent().entity_id().update(intent);
    arm_tick_for(ctx, entity_id);
    Ok(())
''')
rep('''    if intent.queue.is_empty() {
        return;
    }
    intent.queue.clear();
    ctx.db.move_intent().entity_id().update(intent);
}
''', '''    if intent.queue.is_empty() {
        return;
    }
    intent.queue.clear();
    let entity_id = intent.entity_id;
    ctx.db.move_intent().entity_id().update(intent);
    arm_tick_for(ctx, entity_id);
}
''')

# --- 4. the tick: no occupancy branch, no NPC wander, row kept only while work remains -------
rep('''    let occupied = chars.iter().any(|(_, intent)| intent.is_some())
        || chars.iter().any(|&(id, _)| is_player_character(ctx, id));
    if !occupied {
        reset_npcs_home(ctx, zone);
        ctx.db.movement_tick_schedule().id().delete(sched.id);
        return Ok(());
    }
    let now = Millis(now_ms(ctx));''', '''    let now = Millis(now_ms(ctx));''')
rep('''            return Ok(()); // logged no-op: a content failure must not abort the tick
        }
    };
    for (id, intent) in chars {''', '''            ctx.db.movement_tick_schedule().id().delete(sched.id);
            return Ok(()); // logged no-op: a content failure must not abort the tick
        }
    };
    for (id, intent) in chars {''')
i = s.index('    // NPC wander: deterministic, cadence-gated wander via game_core::npc_decide.')
j = s.index('''    Ok(())
}

/// A conversation pins its NPC only while''')
s = s[:i] + '''    // PROTOTYPE lpw-26 D: the zone keeps an interval row only while the next tick has work.
    // A tick called by the one-shot that opens a burst inserts it; the tick that finds no
    // work removes it. The host deletes the one-shot row itself after this call.
    let called_by_interval = matches!(sched.scheduled_at, ScheduleAt::Interval(_));
    if zone_has_work(ctx, zone) {
        if !called_by_interval
            && !ctx
                .db
                .movement_tick_schedule()
                .iter()
                .any(|s| s.zone_id == zone && matches!(s.scheduled_at, ScheduleAt::Interval(_)))
        {
            ctx.db
                .movement_tick_schedule()
                .insert(MovementTickSchedule {
                    id: 0,
                    zone_id: zone,
                    scheduled_at: step_interval(),
                });
        }
    } else if called_by_interval {
        ctx.db.movement_tick_schedule().id().delete(sched.id);
    }

''' + s[j:]
s = s.replace('use game_core::npc::rules::{in_talk_range, npc_step_due};',
              'use game_core::npc::rules::in_talk_range;')
open(p, 'w').write(s)

p = 'server-module/src/lib.rs'
s = open(p).read()
old = '''    for zone_id in to_add {
        crate::movement::arm_zone_tick(ctx, zone_id);
    }
'''
assert s.count(old) == 1
s = s.replace(old, '''    for zone_id in to_add {
        crate::movement::arm_zone_tick(ctx, zone_id);
    }
    // PROTOTYPE lpw-26 D: every occupied zone gets its wander row back.
    let mut occupied = occupied;
    occupied.sort_unstable();
    occupied.dedup();
    for zone_id in occupied {
        crate::movement::arm_zone_wander(ctx, zone_id);
    }
''')
open(p, 'w').write(s)
print('patched D')
