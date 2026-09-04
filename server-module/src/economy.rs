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

use crate::guards::{
    escrowed_currency_amount, escrowed_item_qty, require_owner, saturating_sub_u32,
    saturating_sub_u64,
};
use crate::inventory::{consume_one, grant_item};
use crate::schema::{
    inventory, item_row, player, player_wallet, shop_item_row, trade_offer, PlayerWallet,
};
use game_core::currency::{apply_grant, apply_spend};
use game_core::{check_currency_headroom, check_item_headroom};
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

/// Read-only balance query — the only sanctioned path to read player_wallet outside
/// of `grant_currency` / `spend_currency` (ADR-0081 single-surface discipline).
/// Returns 0 if no wallet row exists.
pub(crate) fn wallet_balance(ctx: &ReducerContext, owner: Identity) -> u64 {
    ctx.db
        .player_wallet()
        .owner_identity()
        .find(owner)
        .map(|r| r.balance)
        .unwrap_or(0)
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
/// 1. Verify caller is a joined player (`require_owner` before any spend), then the
///    deletion gate (ADR-0236, spec para 4.7) — reject a mid-grace or terminal caller
///    before any further read.
/// 2. Look up the `shop_item_row` for `(shop_id, item_id)` — reject if not stocked.
/// 3. Compute total = `buy_price × qty` (server-side, checked_mul — no overflow).
/// 4. Trade-escrow guard (TR-9, ADR-0106) — reject if the currency is locked in
///    an active offer.
/// 5. Receiver-cap headroom (m17.5c, ADR-0124) — `check_item_headroom` on the
///    RAW stack count, reject-not-destroy BEFORE the spend.
/// 6. `spend_currency` — reject if insufficient funds or no wallet.
/// 7. `grant_item` — credit the purchased items.
///
/// Prices come from the `shop_item_row` content table; the client never provides
/// a price or total (classic economy exploit blocked at the reducer boundary,
/// ADR-0082 §D1).
#[spacetimedb::reducer]
pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) -> Result<(), String> {
    let me = ctx.sender();

    // ADR-0081 forward obligation: require_owner before spend_currency.
    let p = ctx
        .db
        .player()
        .identity()
        .find(me)
        .ok_or_else(|| "not joined".to_string())?;
    require_owner(ctx, "buy", p.identity)?;

    // Deletion gate (ADR-0236 D2, spec para 4.7): standing is established, so a
    // mid-grace or terminal account is refused HERE — before the stock lookup, the
    // escrow/headroom reads and the spend. Fully qualified + `?;` (both pinned).
    crate::guards::require_not_deleting(ctx, "buy")?;

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

    // Trade escrow guard (TR-9, ADR-0106): reject if currency is locked in an active offer.
    let escrowed = escrowed_currency_amount(
        ctx.db
            .trade_offer()
            .initiator()
            .filter(me)
            .chain(ctx.db.trade_offer().counterparty().filter(me)),
        me,
    );
    let balance = wallet_balance(ctx, me);
    let available = saturating_sub_u64(balance, escrowed);
    if total > available {
        return Err("currency is in an active trade".to_string());
    }

    // m17.5c (ADR-0124 reject-not-destroy): receiver-cap reject BEFORE the spend.
    // RAW stack count, not escrow-netted — grant_item credits the raw stack;
    // escrow is a spend-lock, not a receive-lock.
    let current_count = ctx
        .db
        .inventory()
        .owner_identity()
        .filter(me)
        .find(|r| r.item_id == item_id)
        .map(|r| r.count)
        .unwrap_or(0);
    check_item_headroom(current_count, qty, item_id).map_err(|e| e.to_string())?;

    // Spend first — if this fails the whole reducer transaction rolls back.
    spend_currency(ctx, me, total)?;

    // Grant items — runs only if spend succeeded.
    grant_item(ctx, me, item_id, qty);

    Ok(())
}

/// Sell `qty` units of `item_id` from the caller's inventory.
///
/// Server flow (reject-not-clamp, server-priced, atomic):
/// 1. Verify caller is a joined player (`require_owner` before any consume/grant),
///    then the deletion gate (ADR-0236, spec para 4.7) — reject a mid-grace or
///    terminal caller before any further read.
/// 2. Look up `sell_price` from `item_row` — reject if 0 ("item cannot be sold").
/// 3. Compute total = `sell_price × qty` (server-side, checked_mul) — an
///    overflow rejects here, pre-filtering the headroom check in step 5
///    (defense-in-depth, F10).
/// 4. Trade-escrow guard (TR-8, ADR-0106) — reject if the item is locked in an
///    active offer.
/// 5. Proceeds-cap headroom (m17.5c, ADR-0124) — `check_currency_headroom` on
///    the RAW balance, reject-not-destroy BEFORE any consume.
/// 6. `consume_one × qty` — reject if any call fails (insufficient items).
///    Transaction atomicity: a partial-loop `Err` rolls back ALL prior consume_ones.
/// 7. `grant_currency` — credit the proceeds.
///
/// sell_price comes from the `item_row` content table; the client never provides
/// a price (ADR-0082 §D2 / §D1).
#[spacetimedb::reducer]
pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String> {
    let me = ctx.sender();

    // ADR-0081 forward obligation: require_owner before any resource modification.
    let p = ctx
        .db
        .player()
        .identity()
        .find(me)
        .ok_or_else(|| "not joined".to_string())?;
    require_owner(ctx, "sell", p.identity)?;

    // Deletion gate (ADR-0236 D2, spec para 4.7): standing is established, so a
    // mid-grace or terminal account is refused HERE — before the item lookup, the
    // escrow/headroom reads and the consume. Fully qualified + `?;` (both pinned).
    crate::guards::require_not_deleting(ctx, "sell")?;

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

    // Trade escrow guard (TR-8, ADR-0106): reject if the item is locked in an active offer.
    let escrowed = escrowed_item_qty(
        ctx.db
            .trade_offer()
            .initiator()
            .filter(me)
            .chain(ctx.db.trade_offer().counterparty().filter(me)),
        me,
        item_id,
    );
    let current_count = ctx
        .db
        .inventory()
        .owner_identity()
        .filter(me)
        .find(|r| r.item_id == item_id)
        .map(|r| r.count)
        .unwrap_or(0);
    let available_count = saturating_sub_u32(current_count, escrowed);
    if qty > available_count {
        return Err("item is in an active trade".to_string());
    }

    // m17.5c (ADR-0124 reject-not-destroy): proceeds-cap reject BEFORE consuming —
    // the sell side is value-destruction with no rollback backstop, because
    // grant_currency is infallible and saturates. RAW balance, not escrow-netted —
    // escrow is a spend-lock, not a receive-lock. The checked_mul above pre-filters
    // this check for overflow (defense-in-depth, F10).
    let balance = wallet_balance(ctx, me);
    check_currency_headroom(balance, total).map_err(|e| e.to_string())?;

    // Consume qty units — each consume_one is checked; an Err rolls back the txn.
    for _ in 0..qty {
        consume_one(ctx, me, item_id)?;
    }

    grant_currency(ctx, me, total);

    Ok(())
}

// --- M21 guest→account wallet re-key (ADR-0179 D6, AUTH-23/24) ----------------

/// Zero a wallet row's balance in place, preserving its PK. Pure seam so the
/// "balance becomes 0, owner unchanged" property is unit-testable without a
/// `ReducerContext`. NEVER produces a delete (AUTH-23).
pub(crate) fn zeroed_wallet(row: PlayerWallet) -> PlayerWallet {
    PlayerWallet { balance: 0, ..row }
}

/// M22 §4.4 step 6b (PRV1-6b, ADR-0228 D1/D7c): delete `owner`'s wallet row
/// outright — the ONE sanctioned `player_wallet` delete in the crate.
/// `player_wallet` is ERASE-classified (spec §3 / `DATA_LIFECYCLE_MANIFEST`):
/// a surviving zeroed row is exactly the orphaned data the operator's
/// issue-#403 Option B ruling excludes. The ux2/ADR-0154 never-delete gate in
/// `economy_tests.rs` exempts exactly this fn BY NAME and pins this body to
/// the single PK point delete — anything more here is a gate red. Called only
/// from `accounts::account_deletion_reaper` (ACCESSOR_BYPASS keeps every
/// wallet touch inside this module). Declared BEFORE `rekey_wallet`: the
/// currency-integrity zero-arg pin scans forward from that fn unbounded.
pub(crate) fn erase_wallet(ctx: &ReducerContext, owner: Identity) {
    ctx.db.player_wallet().owner_identity().delete(owner);
}

/// Re-key the guest's wallet balance onto `to` by CREDIT-FORWARD, then zero the
/// guest's row in place — NEVER delete it (AUTH-23/24, ADR-0081 single-surface).
/// Must live in `economy.rs`: `currency-integrity.eval.mjs` ACCESSOR_BYPASS bans
/// even a READ of `player_wallet()` from any other module, so `accounts.rs`
/// delegates here. Read the balance BEFORE zeroing; `grant_currency` writes a
/// different PK (`to != from`, guaranteed by AUTH-17), so credit-then-zero is
/// race-free and the balance is never lost. A zero-balance guest creates no
/// phantom destination row (`grant_currency`'s 0-amount early return).
pub(crate) fn rekey_wallet(ctx: &ReducerContext, from: Identity, to: Identity) {
    if let Some(row) = ctx.db.player_wallet().owner_identity().find(from) {
        grant_currency(ctx, to, row.balance);
        ctx.db
            .player_wallet()
            .owner_identity()
            .update(zeroed_wallet(row));
    }
}

/// True if `owner` has a `player_wallet` row (for
/// `accounts::account_has_game_data`; ADR-0179 D5 guard 3). Lives here because
/// ACCESSOR_BYPASS gates wallet reads, not just writes. Distinct from
/// `wallet_balance` — "row present" is not "balance > 0" (a zeroed post-claim
/// guest row still exists).
pub(crate) fn wallet_exists(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db
        .player_wallet()
        .owner_identity()
        .find(owner)
        .is_some()
}

#[cfg(test)]
#[path = "economy_tests.rs"]
#[allow(unused_imports)]
mod economy_tests;
