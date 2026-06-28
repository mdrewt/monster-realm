//! `inventory` — server-module domain submodule (M8.9, ADR-0056 / ADR-0059).
//!
//! The single item-mutation surface (ADR-0018): every grant/consume path for the
//! `inventory` table routes through `grant_item` / `consume_one` here, so the
//! single-stack-per-`(owner, item_id)` discipline and the delete-at-zero / capped
//! invariants live in one place (recruit bait now; training food, shop, quest
//! reward later). Item counts are PUBLIC / world-readable — no transport RLS
//! (no `client_visibility_filter` in this toolchain, ADR-0040/0046); owner-scoping
//! is a client subscription filter only; per-owner transport RLS is the M16
//! residual. The row carries ONLY (owner, item_id, count) — no gene/seed field.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::schema::inventory;
// `grant_item` (dev-only, ADR-0054) is the sole constructor of an `Inventory` row
// and the only user of the `Table::insert` trait method here — gate both imports
// so the default (non-dev) build stays warning-clean (red-team F6). `consume_one`
// (ungated) needs only `Identity` + the generated index/PK accessor traits.
#[cfg(feature = "dev_reducers")]
use crate::schema::Inventory;
#[cfg(feature = "dev_reducers")]
use spacetimedb::Table;
use spacetimedb::{Identity, ReducerContext};

/// Per-stack cap. A single `(owner, item_id)` stack is capped at this count;
/// further grants are no-ops once at/over the cap. Used only by the dev-gated
/// `grant_item`, so it shares the gate (non-dev hygiene).
// 9999: four-digit cap for UI legibility; no game-design constraint — tunable (ADR-0059 residual c).
#[cfg(feature = "dev_reducers")]
pub(crate) const MAX_ITEM_STACK: u32 = 9999;

/// Grant `qty` of `item_id` to `owner`, merging into the owner's existing stack
/// if present (capped, monotone) or inserting a new row otherwise. SINGLE stack
/// per `(owner, item_id)`: always find-then-update.
///
/// Hardened (ADR-0059 red-team F2/F3): a `qty == 0` grant is a no-op (never an
/// empty zombie row); the existing-stack branch only grows when below the cap, so
/// a grant can never SHRINK an already-at/over-cap stack. Keeps `saturating_add`.
///
/// Currently the ONLY caller is the dev/test reducer `grant_bait`, so this helper
/// shares its `dev_reducers` gate to avoid a dead-code warning in release builds
/// (ADR-0054). A production grant path (M12 quest / M13 shop / training food) will
/// introduce a non-dev caller; drop the gate then.
// Crate-internal; the sole inventory inserter (ADR-0018/0046 single-stack surface).
#[cfg(feature = "dev_reducers")]
pub(crate) fn grant_item(ctx: &ReducerContext, owner: Identity, item_id: u32, qty: u32) {
    if qty == 0 {
        return;
    }
    let existing = ctx
        .db
        .inventory()
        .owner_identity()
        .filter(owner)
        .find(|r| r.item_id == item_id);
    match existing {
        Some(mut row) => {
            // Monotone cap: only grow when below the cap, so an already-over-cap
            // stack is never shrunk by the `.min(MAX_ITEM_STACK)` (red-team F3).
            if row.count < MAX_ITEM_STACK {
                row.count = row.count.saturating_add(qty).min(MAX_ITEM_STACK);
                ctx.db.inventory().inv_id().update(row);
            }
        }
        None => {
            ctx.db.inventory().insert(Inventory {
                inv_id: 0, // auto_inc
                owner_identity: owner,
                item_id,
                count: qty.min(MAX_ITEM_STACK),
            });
        }
    }
}

/// Consume exactly one of `item_id` from `owner`. Rejects (`Err`) when the stack
/// is absent or already empty. Uses `checked_sub` — NEVER a bare decrement — so
/// an empty stack can never underflow into a 2^32 windfall. Delete-at-zero on both
/// paths (ADR-0059): a pre-existing zombie (`count == 0`) is deleted before the
/// reject, and a stack drained to 0 is deleted rather than left as an empty row.
pub(crate) fn consume_one(
    ctx: &ReducerContext,
    owner: Identity,
    item_id: u32,
) -> Result<(), String> {
    let mut row = ctx
        .db
        .inventory()
        .owner_identity()
        .filter(owner)
        .find(|r| r.item_id == item_id)
        .ok_or_else(|| "item not in inventory".to_string())?;
    if row.count == 0 {
        // Self-cleaning: remove any pre-existing zombie row before rejecting.
        ctx.db.inventory().inv_id().delete(row.inv_id);
        return Err("item count is zero".to_string());
    }
    row.count = row
        .count
        .checked_sub(1)
        .ok_or_else(|| "item count is zero".to_string())?;
    if row.count == 0 {
        ctx.db.inventory().inv_id().delete(row.inv_id);
    } else {
        ctx.db.inventory().inv_id().update(row);
    }
    Ok(())
}
