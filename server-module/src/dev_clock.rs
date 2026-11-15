//! `dev_clock` — server-module domain submodule.
//!
//! Dev-only control of the tactical turn clock: `dev_expire_tactical_window` lets the module
//! owner expire an open turn window at once, so an e2e does not wait a real deadline. Every item
//! compiles only with the `dev_reducers` feature, which no release recipe passes.

// Each import is dev-gated like its only user `dev_expire_tactical_window`: ungated, it would be
// an unused-import warning in the non-dev build.
#[cfg(feature = "dev_reducers")]
use crate::guards::log_reject;
#[cfg(feature = "dev_reducers")]
use crate::marshal::now_ms;
#[cfg(feature = "dev_reducers")]
use crate::schema::{battle_clock, battle_tactical, battle_unit, config, BattleClock, SideRow};
#[cfg(feature = "dev_reducers")]
use crate::tactics::{dev_arm_deadline, tactical_deadline_sched};
#[cfg(feature = "dev_reducers")]
use game_core::tactics::types::{Phase, TurnState};
#[cfg(feature = "dev_reducers")]
use spacetimedb::{Identity, ReducerContext};

/// DEV/TEST: expire the open turn window of `side` (0 = A, 1 = B) of an Active tactical battle
/// now. Module owner only: the caller must be the `config` row's registered `owner_identity`
/// (the `sync_content` check), so a player is refused even in a dev build.
///
/// It moves the window's `deadline_ms` to the call's time and arms one deadline fire at that
/// time. The scheduler's `tactical_deadline_fire` then expires the window as it does at a real
/// deadline (PvP: an AutoPass strike; wild: the AutoFlee) and deletes the window's original
/// deadline row. Every refusal is logged and writes nothing.
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn dev_expire_tactical_window(
    ctx: &ReducerContext,
    battle_id: u64,
    side: u8,
) -> Result<(), String> {
    let me = ctx.sender();
    // Deletion gate: the first check, before any read of the battle.
    crate::guards::require_not_deleting(ctx, "dev_expire_tactical_window")?;
    let reject = |reason: &str| -> Result<(), String> {
        log_reject("dev_expire_tactical_window", me, reason);
        Err(reason.to_string())
    };
    // The all-zero identity is `config`'s "owner never registered" value; no caller owns that.
    let unregistered = Identity::from_byte_array([0u8; 32]);
    let is_owner = ctx
        .db
        .config()
        .id()
        .find(0)
        .is_some_and(|cfg| cfg.owner_identity != unregistered && cfg.owner_identity == me);
    if !is_owner {
        return reject("caller is not the module owner");
    }
    let side = match side {
        0 => SideRow::A,
        1 => SideRow::B,
        _ => return reject("side must be 0 or 1"),
    };
    let Some(tactical) = ctx.db.battle_tactical().battle_id().find(battle_id) else {
        return reject("no such tactical battle");
    };
    if tactical.phase != Phase::Active {
        return reject("battle is not active");
    }
    // The window the fire accepts is the waiting unit's, on that unit's side clock.
    let TurnState::Waiting(unit_id) = tactical.turn_state else {
        return reject("no open turn window");
    };
    let Some(unit) = ctx.db.battle_unit().unit_id().find(unit_id) else {
        return reject("no open turn window");
    };
    let Some(clock) = ctx
        .db
        .battle_clock()
        .battle_id()
        .filter(battle_id)
        .find(|c| c.side == unit.side && c.window_open_ms.is_some())
    else {
        return reject("no open turn window");
    };
    if unit.side != side {
        return reject("the other side's window is open");
    }
    let window_seq = clock.window_seq;
    let pending = ctx
        .db
        .tactical_deadline_sched()
        .battle_id()
        .filter(battle_id)
        .any(|row| row.unit_id == unit_id && row.window_seq == window_seq);
    if !pending {
        return reject("no pending deadline for the open window");
    }
    let now = now_ms(ctx);
    ctx.db.battle_clock().clock_id().update(BattleClock {
        deadline_ms: Some(now),
        ..clock
    });
    dev_arm_deadline(ctx, battle_id, unit_id, window_seq, now);
    Ok(())
}

#[cfg(test)]
#[path = "dev_clock_tests.rs"]
mod dev_clock_tests;
