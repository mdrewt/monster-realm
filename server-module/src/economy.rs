//! `economy` — server-module domain submodule (M13a, ADR-0081).
//!
//! The single wallet-mutation surface (mirrors ADR-0018/inventory.rs).
//! Every currency grant/spend routes through `grant_currency` / `spend_currency`
//! here so the single-surface discipline (no direct balance add-assign) is enforced
//! in one place.
//!
//! STUB: function bodies panic. The implementer replaces the panics.
//! RED STATE: tests in economy_tests.rs are the contract, not this file.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0081 — keep it stable.

use crate::schema::{player_wallet, PlayerWallet};
use game_core::currency::{apply_grant, apply_spend};
use spacetimedb::{Identity, ReducerContext, Table};

/// Grant `amount` of currency to `owner`. 0-amount is a no-op (never inserts
/// a phantom wallet row). Upserts via `apply_grant` (capped at MAX_BALANCE).
// Crate-internal; the sole wallet-credit path (ADR-0081 single-surface discipline).
pub(crate) fn grant_currency(ctx: &ReducerContext, owner: Identity, amount: u64) {
    // STUB — implementer replaces this body.
    panic!("grant_currency not yet implemented")
}

/// Debit `amount` from `owner`'s wallet. Returns `Err` when the wallet row is
/// absent or the balance is insufficient.
// Crate-internal; the sole wallet-debit path (ADR-0081 single-surface discipline).
pub(crate) fn spend_currency(
    ctx: &ReducerContext,
    owner: Identity,
    amount: u64,
) -> Result<(), String> {
    // STUB — implementer replaces this body.
    panic!("spend_currency not yet implemented")
}

#[cfg(test)]
#[path = "economy_tests.rs"]
mod economy_tests;
