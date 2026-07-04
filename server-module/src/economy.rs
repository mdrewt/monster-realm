//! `economy` — server-module domain submodule (M13a/M13b, ADR-0081/ADR-0082).
//!
//! The single wallet-mutation surface (mirrors ADR-0018/inventory.rs).
//! Every currency grant/spend routes through `grant_currency` / `spend_currency`
//! here so the single-surface discipline (no direct balance add-assign) is enforced
//! in one place.
//!
//! M13b (ADR-0082) adds the `buy`/`sell` reducers: server-priced, atomic,
//! reject-not-clamp, with `require_owner` before every spend/consume call.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0081 — keep it stable.

use crate::guards::require_owner;
use crate::inventory::{consume_one, grant_item};
use crate::schema::{item_row, player, player_wallet, shop_item_row, PlayerWallet};
use game_core::currency::{apply_grant, apply_spend};
use spacetimedb::{Identity, ReducerContext, Table};

/// Grant `amount` of currency to `owner`. 0-amount is a no-op (never inserts
/// a phantom wallet row). Upserts via `apply_grant` (capped at MAX_BALANCE).
// Crate-internal; the sole wallet-credit path (ADR-0081 single-surface discipline).
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

// ---------------------------------------------------------------------------
// M13b reducers: buy / sell (ADR-0082)
// ---------------------------------------------------------------------------

/// Buy `qty` units of `item_id` from shop `shop_id`.
///
/// Server flow (reject-not-clamp, server-priced, atomic):
/// 1. Verify caller is a joined player (`require_owner` before any spend).
/// 2. Look up the `shop_item_row` for `(shop_id, item_id)` — reject if not stocked.
/// 3. Compute total = `buy_price × qty` (server-side, checked_mul — no overflow).
/// 4. `spend_currency` — reject if insufficient funds or no wallet.
/// 5. `grant_item` — credit the purchased items.
///
/// Prices come from the `shop_item_row` content table; the client never provides
/// a price or total (classic economy exploit blocked at the reducer boundary,
/// ADR-0082 §D1).
#[spacetimedb::reducer]
pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) -> Result<(), String> {
    let me = ctx.sender;

    // ADR-0081 forward obligation: require_owner before spend_currency.
    let p = ctx
        .db
        .player()
        .identity()
        .find(me)
        .ok_or_else(|| "not joined".to_string())?;
    require_owner(ctx, "buy", p.identity)?;

    if qty == 0 {
        return Err("qty must be > 0".to_string());
    }

    // Look up the shop stock entry — reject if this shop does not stock this item.
    let stock_entry = ctx
        .db
        .shop_item_row()
        .shop_id()
        .filter(shop_id)
        .find(|r| r.item_id == item_id)
        .ok_or_else(|| format!("shop {shop_id} does not stock item {item_id}"))?;

    // Server-computed total (never from client). checked_mul prevents overflow.
    let total = stock_entry
        .buy_price
        .checked_mul(u64::from(qty))
        .ok_or_else(|| "total overflow".to_string())?;

    // Spend first — if this fails the whole reducer transaction rolls back.
    spend_currency(ctx, me, total)?;

    // Grant items — runs only if spend succeeded.
    grant_item(ctx, me, item_id, qty);

    Ok(())
}

/// Sell `qty` units of `item_id` from the caller's inventory.
///
/// Server flow (reject-not-clamp, server-priced, atomic):
/// 1. Verify caller is a joined player (`require_owner` before any consume/grant).
/// 2. Look up `sell_price` from `item_row` — reject if 0 ("item cannot be sold").
/// 3. `consume_one × qty` — reject if any call fails (insufficient items).
///    Transaction atomicity: a partial-loop `Err` rolls back ALL prior consume_ones.
/// 4. Compute total = `sell_price × qty` (server-side, checked_mul).
/// 5. `grant_currency` — credit the proceeds.
///
/// sell_price comes from the `item_row` content table; the client never provides
/// a price (ADR-0082 §D2 / §D1).
#[spacetimedb::reducer]
pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String> {
    let me = ctx.sender;

    // ADR-0081 forward obligation: require_owner before any resource modification.
    let p = ctx
        .db
        .player()
        .identity()
        .find(me)
        .ok_or_else(|| "not joined".to_string())?;
    require_owner(ctx, "sell", p.identity)?;

    if qty == 0 {
        return Err("qty must be > 0".to_string());
    }

    // Validate sell_price from content (0 = not sellable).
    let item = ctx
        .db
        .item_row()
        .id()
        .find(item_id)
        .ok_or_else(|| format!("unknown item {item_id}"))?;
    if item.sell_price == 0 {
        return Err("item cannot be sold".to_string());
    }

    // Server-computed total (never from client). checked_mul prevents overflow.
    // Validated before any mutation so the reducer rejects cleanly before consuming.
    let total = item
        .sell_price
        .checked_mul(u64::from(qty))
        .ok_or_else(|| "total overflow".to_string())?;

    // Consume qty units — each consume_one is checked; an Err rolls back the txn.
    for _ in 0..qty {
        consume_one(ctx, me, item_id)?;
    }

    grant_currency(ctx, me, total);

    Ok(())
}

#[cfg(test)]
#[path = "economy_tests.rs"]
#[allow(unused_imports)]
mod economy_tests;
