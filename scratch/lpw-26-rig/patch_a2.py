#!/usr/bin/env python3
"""Prototype A, second pass: explicit schedule-row ids, so re-arming never takes a value from the
table's sequence."""
p = 'server-module/src/movement.rs'
s = open(p).read()
old = '''    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: 0,
            zone_id,
            scheduled_at: ScheduleAt::Time(spacetimedb::Timestamp::from_micros_since_unix_epoch(
                at_ms * 1000,
            )),
        });
}
'''
new = '''    // A zone's rows carry one of two ids the module chooses, so arming never takes a value
    // from the table's sequence (each one taken rewrites a system row). They sit above every
    // id a sequence handed out to a row a live database still holds. The running tick's row
    // still holds one of the two until the host deletes it.
    let first = (1u64 << 40) + u64::from(zone_id) * 2;
    let id = if calling == Some(first) { first + 1 } else { first };
    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id,
            zone_id,
            scheduled_at: ScheduleAt::Time(spacetimedb::Timestamp::from_micros_since_unix_epoch(
                at_ms * 1000,
            )),
        });
}
'''
assert s.count(old) == 1
s = s.replace(old, new)
open(p, 'w').write(s)
print('patched A2')
