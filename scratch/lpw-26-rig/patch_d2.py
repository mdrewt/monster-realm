#!/usr/bin/env python3
"""Prototype D, second pass: explicit schedule-row ids (no sequence write per arm) and a linger of
five steps before the interval row is removed."""
p = 'server-module/src/movement.rs'
s = open(p).read()


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, (s.count(old), old[:80])
    s = s.replace(old, new)


rep('''    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: 0,
            zone_id,
            scheduled_at,
        });
}
''', '''    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: if KICK_AT_GRID {
                kick_id(zone_id)
            } else {
                interval_id(zone_id)
            },
            zone_id,
            scheduled_at,
        });
}

/// PROTOTYPE lpw-26 D: schedule rows carry ids the module chooses, so arming never takes a
/// value from the table's sequence (each one taken rewrites a system row). They sit above
/// every id a sequence handed out to a row a live database still holds.
const EXPLICIT_ID_BASE: u64 = 1 << 40;

fn kick_id(zone: u32) -> u64 {
    EXPLICIT_ID_BASE + u64::from(zone) * 2
}

fn interval_id(zone: u32) -> u64 {
    EXPLICIT_ID_BASE + u64::from(zone) * 2 + 1
}

/// PROTOTYPE lpw-26 D: how long a zone's interval row outlives its last work, so inputs a
/// moment apart ride one interval row.
const LINGER_MS: i64 = STEP_MS * 5;

/// Has every player's character in `zone` been untouched for `LINGER_MS`? The stamp is the
/// character row's own, written whenever an input is applied.
fn lingered(ctx: &ReducerContext, zone: u32, now: i64) -> bool {
    let chars: Vec<Character> = ctx.db.character().zone_id().filter(zone).collect();
    chars
        .into_iter()
        .filter(|c| ctx.db.move_intent().entity_id().find(c.entity_id).is_some())
        .all(|c| now.saturating_sub(c.move_started_at_ms) >= LINGER_MS)
}
''')
rep('''    ctx.db.npc_wander_schedule().insert(NpcWanderSchedule {
        id: 0,
        zone_id,''', '''    ctx.db.npc_wander_schedule().insert(NpcWanderSchedule {
        id: EXPLICIT_ID_BASE + u64::from(zone_id),
        zone_id,''')
i = s.index('    // PROTOTYPE lpw-26 D: the zone keeps an interval row only while the next tick has work.')
j = s.index('''    Ok(())
}

/// A conversation pins its NPC only while''')
s = s[:i] + '''    // PROTOTYPE lpw-26 D: the one-shot that opens a burst of work inserts the interval row
    // the burst rides (the host deletes the one-shot row itself after this call). An interval
    // tick removes its own row once the zone has no work and has lingered.
    let called_by_interval = matches!(sched.scheduled_at, ScheduleAt::Interval(_));
    if !called_by_interval {
        if !ctx
            .db
            .movement_tick_schedule()
            .iter()
            .any(|s| s.zone_id == zone && matches!(s.scheduled_at, ScheduleAt::Interval(_)))
        {
            ctx.db
                .movement_tick_schedule()
                .insert(MovementTickSchedule {
                    id: interval_id(zone),
                    zone_id: zone,
                    scheduled_at: step_interval(),
                });
        }
    } else if !zone_has_work(ctx, zone) && lingered(ctx, zone, now.0) {
        ctx.db.movement_tick_schedule().id().delete(sched.id);
    }

''' + s[j:]
open(p, 'w').write(s)
print('patched D2')
