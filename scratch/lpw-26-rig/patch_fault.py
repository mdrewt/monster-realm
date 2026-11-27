#!/usr/bin/env python3
"""Fault injection for the lpw-26 recovery measurement (never merged): `movement_tick` panics while
the server clock is before a time a reducer sets. Run from a prototype worktree's root."""
p = 'server-module/src/movement.rs'
s = open(p).read()
old = '''    if ctx.sender() != ctx.database_identity() {
        return Err("movement_tick is scheduler-only".to_string());
    }
    let zone = sched.zone_id;'''
new = '''    if ctx.sender() != ctx.database_identity() {
        return Err("movement_tick is scheduler-only".to_string());
    }
    // PROTOTYPE lpw-26 fault injection: the tick's transaction fails while the fault is set.
    if let Some(f) = ctx.db.lpw26_fault().id().find(0) {
        if now_ms(ctx) < f.until_ms {
            panic!("lpw-26 fault injection");
        }
    }
    let zone = sched.zone_id;'''
assert s.count(old) == 1
s = s.replace(old, new)
old = '''/// Is this character a player's?'''
new = '''/// PROTOTYPE lpw-26 fault injection: while the clock is before `until_ms`, `movement_tick` panics.
#[spacetimedb::table(accessor = lpw26_fault)]
pub struct Lpw26Fault {
    #[primary_key]
    pub id: u8,
    pub until_ms: i64,
}

/// PROTOTYPE lpw-26 fault injection: make every `movement_tick` of the next `ms` milliseconds fail.
#[spacetimedb::reducer]
pub fn lpw26_fail_for(ctx: &ReducerContext, ms: i64) {
    ctx.db.lpw26_fault().id().delete(0);
    ctx.db.lpw26_fault().insert(Lpw26Fault {
        id: 0,
        until_ms: now_ms(ctx) + ms,
    });
}

/// Is this character a player's?'''
assert s.count(old) == 1
s = s.replace(old, new)
open(p, 'w').write(s)
print('patched fault')
