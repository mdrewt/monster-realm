//! `economy` — server-module domain submodule (M13a, ADR-0081).
//!
//! The single wallet-mutation surface (mirrors ADR-0018/inventory.rs).
//! Every currency grant/spend routes through `grant_currency` / `spend_currency`
//! here so the single-surface discipline (no direct balance add-assign) is enforced
//! in one place.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0081 — keep it stable.

use crate::schema::{player_wallet, PlayerWallet};
use game_core::currency::{apply_grant, apply_spend};
use spacetimedb::{Identity, ReducerContext, Table};

/// Grant `amount` of currency to `owner`. 0-amount is a no-op (never inserts
/// a phantom wallet row). Upserts via `apply_grant` (capped at MAX_BALANCE).
// Crate-internal; the sole wallet-credit path (ADR-0081 single-surface discipline).
// Allow until wired to a reducer in a later M13 slice.
#[allow(dead_code)]
pub(crate) fn grant_currency(ctx: &ReducerContext, owner: Identity, amount: u64) {
    if amount == 0 {
        return;
    }
    match ctx.db.player_wallet().owner_identity().find(owner) {
        Some(mut row) => {
            row.balance = apply_grant(row.balance, amount);
            ctx.db.player_wallet().owner_identity().update(row);
        }
        None => {
            ctx.db.player_wallet().insert(PlayerWallet {
                owner_identity: owner,
                balance: apply_grant(0, amount),
            });
        }
    }
}

/// Debit `amount` from `owner`'s wallet. Returns `Err` when the wallet row is
/// absent or the balance is insufficient.
// Crate-internal; the sole wallet-debit path (ADR-0081 single-surface discipline).
// Allow until wired to a reducer in a later M13 slice.
#[allow(dead_code)]
pub(crate) fn spend_currency(
    ctx: &ReducerContext,
    owner: Identity,
    amount: u64,
) -> Result<(), String> {
    if amount == 0 {
        return Ok(());
    }
    let mut row = ctx
        .db
        .player_wallet()
        .owner_identity()
        .find(owner)
        .ok_or_else(|| "no wallet".to_string())?;
    row.balance = apply_spend(row.balance, amount).map_err(|e| e.to_string())?;
    ctx.db.player_wallet().owner_identity().update(row);
    Ok(())
}

#[cfg(test)]
#[path = "economy_tests.rs"]
#[allow(unused_imports)]
mod economy_tests;
