#!/usr/bin/env python3
"""Prototype A (lpw-26): the zone's tick is a one-shot row, armed only while work is pending or
an NPC move is coming due, at a multiple of STEP_MS on the server clock. Run from the prototype
worktree's root."""
p = 'server-module/src/movement.rs'
s = open(p).read()


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, (s.count(old), old[:80])
    s = s.replace(old, new)


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
    // PROTOTYPE lpw-26 A: the next multiple of `STEP_MS` on the server clock.
    let at_ms = (now_ms(ctx).div_euclid(STEP_MS) + 1) * STEP_MS;
    arm_zone_tick_at(ctx, zone_id, at_ms, None);
}

fn sched_ms(at: &ScheduleAt) -> Option<i64> {
    match at {
        ScheduleAt::Time(t) => Some(t.to_micros_since_unix_epoch() / 1000),
        ScheduleAt::Interval(_) => None,
    }
}

/// PROTOTYPE lpw-26 A: arm `zone_id`'s one-shot tick for `at_ms`. A zone holds one pending
/// row at most: a row already due at or before `at_ms` is kept, a later one is replaced.
/// `calling` is the row whose tick is running (the host deletes it after the call), which
/// never counts as pending. An interval row a live database still holds is left for its own
/// next tick to convert.
fn arm_zone_tick_at(ctx: &ReducerContext, zone_id: u32, at_ms: i64, calling: Option<u64>) {
    let pending: Vec<MovementTickSchedule> = ctx
        .db
        .movement_tick_schedule()
        .iter()
        .filter(|s| s.zone_id == zone_id && Some(s.id) != calling)
        .collect();
    for row in pending {
        match sched_ms(&row.scheduled_at) {
            None => return,
            Some(t) if t <= at_ms => return,
            Some(_) => {
                ctx.db.movement_tick_schedule().id().delete(row.id);
            }
        }
    }
    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: 0,
            zone_id,
            scheduled_at: ScheduleAt::Time(spacetimedb::Timestamp::from_micros_since_unix_epoch(
                at_ms * 1000,
            )),
        });
}

/// PROTOTYPE lpw-26 A: arm the tick of the zone character `entity_id` stands in. Called by
/// every writer of a `move_intent` row.
pub(crate) fn arm_tick_for(ctx: &ReducerContext, entity_id: u64) {
    if let Some(ch) = ctx.db.character().entity_id().find(entity_id) {
        arm_zone_tick(ctx, ch.zone_id);
    }
}

/// PROTOTYPE lpw-26 A: is there anything in `zone` the next tick has to do? A character whose
/// row still shows a step, a private intent pair the row does not publish yet, or an undrained
/// input that can drain. A queue held by a battle is not work.
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

/// PROTOTYPE lpw-26 A: the first tick after `tick` on which an NPC of `zone` that wanders may
/// step, or `None` when the zone has none.
fn next_npc_due_tick(ctx: &ReducerContext, zone: u32, tick: u64) -> Option<u64> {
    ctx.db
        .npc()
        .zone_id()
        .filter(zone)
        .filter(|n| n.wander_radius > 0)
        .map(|n| {
            let period = game_core::npc::rules::NPC_STEP_TICKS;
            let phase = tick.wrapping_add(1).wrapping_add(n.entity_id) % period;
            tick + 1 + (period - phase) % period
        })
        .min()
}
''')

# intent writers arm
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

# the tick: logical tick time, interval-row conversion, unoccupied branch, re-arm
rep('''    let occupied = chars.iter().any(|(_, intent)| intent.is_some())
        || chars.iter().any(|&(id, _)| is_player_character(ctx, id));
    if !occupied {
        reset_npcs_home(ctx, zone);
        ctx.db.movement_tick_schedule().id().delete(sched.id);
        return Ok(());
    }
    let now = Millis(now_ms(ctx));''', '''    // PROTOTYPE lpw-26 A: an interval row a live database held at publish is removed by its
    // own first tick, which then arms one-shots like any other.
    let called_by_interval = matches!(sched.scheduled_at, ScheduleAt::Interval(_));
    if called_by_interval {
        ctx.db.movement_tick_schedule().id().delete(sched.id);
    }
    let occupied = chars.iter().any(|(_, intent)| intent.is_some())
        || chars.iter().any(|&(id, _)| is_player_character(ctx, id));
    if !occupied {
        // Nothing is armed again: the host deletes the one-shot row after this call.
        reset_npcs_home(ctx, zone);
        return Ok(());
    }
    let now = Millis(now_ms(ctx));
    // The tick this call stands for: the row's own time, or the clock's when the call is late
    // by a whole tick or the row is an interval row.
    let tick_ms = sched_ms(&sched.scheduled_at)
        .unwrap_or(0)
        .max(now.0.div_euclid(STEP_MS) * STEP_MS);''')
rep('''    let tick_counter: u64 = now.0.unsigned_abs() / (STEP_MS.unsigned_abs().max(1));''',
    '''    let tick_counter: u64 = tick_ms.unsigned_abs() / (STEP_MS.unsigned_abs().max(1));''')
rep('''        ctx.db.character().entity_id().update(ch);
    }

    Ok(())
}

/// A conversation pins its NPC only while''', '''        ctx.db.character().entity_id().update(ch);
    }

    // PROTOTYPE lpw-26 A: arm the next tick only where there is work for one: the next tick
    // when a character has work now, else the tick an NPC's next step comes due on, else none.
    let next_tick = if zone_has_work(ctx, zone) {
        Some(tick_counter + 1)
    } else {
        next_npc_due_tick(ctx, zone, tick_counter)
    };
    if let Some(t) = next_tick {
        let at_ms = i64::try_from(t).unwrap_or(i64::MAX / STEP_MS) * STEP_MS;
        arm_zone_tick_at(ctx, zone, at_ms, Some(sched.id));
    }

    Ok(())
}

/// A conversation pins its NPC only while''')
rep('''            return Ok(()); // logged no-op: a content failure must not abort the tick''',
    '''            return Ok(()); // logged no-op: a content failure must not abort the tick (not re-armed)''')
s = s.replace('use std::time::Duration;\n', '')
open(p, 'w').write(s)
print('patched A')
