#!/usr/bin/env python3
"""Prototype B (lpw-26): the zone's interval row slows to five steps while the zone is quiescent
(no player-side work and no NPC that wanders) and returns to one step on the next intent write.
Run from the prototype worktree's root."""
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
    // PROTOTYPE lpw-26 B: a slow row is replaced by a fast one; a fast one is kept.
    let rows: Vec<MovementTickSchedule> = ctx
        .db
        .movement_tick_schedule()
        .iter()
        .filter(|s| s.zone_id == zone_id)
        .collect();
    if rows.iter().any(|s| !is_slow(&s.scheduled_at)) {
        return;
    }
    for row in rows {
        ctx.db.movement_tick_schedule().id().delete(row.id);
    }
    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: 0,
            zone_id,
            scheduled_at: interval_of(STEP_MS.unsigned_abs()),
        });
}

/// PROTOTYPE lpw-26 B: the quiescent interval, five steps.
const SLOW_MS: u64 = STEP_MS.unsigned_abs() * 5;

fn interval_of(ms: u64) -> ScheduleAt {
    ScheduleAt::Interval(Duration::from_millis(ms).into())
}

fn is_slow(at: &ScheduleAt) -> bool {
    match at {
        ScheduleAt::Interval(d) => d.to_micros().unsigned_abs() == SLOW_MS * 1000,
        ScheduleAt::Time(_) => false,
    }
}

/// PROTOTYPE lpw-26 B: arm the fast tick of the zone character `entity_id` stands in. Called
/// by every writer of a `move_intent` row.
pub(crate) fn arm_tick_for(ctx: &ReducerContext, entity_id: u64) {
    if let Some(ch) = ctx.db.character().entity_id().find(entity_id) {
        arm_zone_tick(ctx, ch.zone_id);
    }
}

/// PROTOTYPE lpw-26 B: is there anything in `zone` the next tick has to do? A character whose
/// row still shows a step, a private intent pair the row does not publish yet, an undrained
/// input that can drain, or an NPC that wanders. A queue held by a battle is not work.
fn zone_has_work(ctx: &ReducerContext, zone: u32) -> bool {
    if ctx
        .db
        .npc()
        .zone_id()
        .filter(zone)
        .any(|n| n.wander_radius > 0)
    {
        return true;
    }
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
''')

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

rep('''        ctx.db.character().entity_id().update(ch);
    }

    Ok(())
}

/// A conversation pins its NPC only while''', '''        ctx.db.character().entity_id().update(ch);
    }

    // PROTOTYPE lpw-26 B: a fast row whose zone has gone quiescent is replaced by a slow one;
    // a slow row whose zone has work again is replaced by a fast one.
    let slow = is_slow(&sched.scheduled_at);
    let work = zone_has_work(ctx, zone);
    if work == slow {
        ctx.db.movement_tick_schedule().id().delete(sched.id);
        ctx.db
            .movement_tick_schedule()
            .insert(MovementTickSchedule {
                id: 0,
                zone_id: zone,
                scheduled_at: interval_of(if work {
                    STEP_MS.unsigned_abs()
                } else {
                    SLOW_MS
                }),
            });
    }

    Ok(())
}

/// A conversation pins its NPC only while''')
open(p, 'w').write(s)
print('patched B')
