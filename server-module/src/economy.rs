//! `economy` — server-module domain submodule.
//!
//! The single wallet-mutation surface.
//! Every currency grant/spend routes through `grant_currency` / `spend_currency`
//! here so the single-surface discipline (no direct balance add-assign) is enforced
//! in one place.
//!
//! `buy` and `sell` are server-priced, atomic and reject-not-clamp, call
//! `require_owner` before every spend or consume, and serve only a caller standing
//! within reach of a shop NPC.
//!
//! The spend rule for an asset a trade can lock (`check_currency_spend`,
//! `check_item_spend`) lives here too: a plain shortfall is told apart from a holding
//! a trade has locked.

use crate::guards::{
    character_of, escrowed_currency_of, escrowed_item_qty_of, is_in_ongoing_battle, log_reject,
    require_owner, saturating_sub_u32, saturating_sub_u64,
};
use crate::inventory::{consume_n, grant_item, item_count, ERR_NOT_ENOUGH_ITEM};
use crate::marshal::char_state;
use crate::schema::{item_row, npc, player, player_wallet, shop_item_row, PlayerWallet};
use game_core::currency::{apply_grant, apply_spend};
use game_core::interact::{npc_offers_shop, within_npc_reach};
use game_core::{check_currency_headroom, check_item_headroom, TilePos};
use spacetimedb::{Identity, ReducerContext, Table};

/// Grant `amount` of currency to `owner`. 0-amount is a no-op (never inserts
/// a phantom wallet row). Upserts via `apply_grant` (capped at MAX_BALANCE).
// Crate-internal; the sole wallet-credit path.
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
/// of `grant_currency` / `spend_currency`.
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
// Crate-internal; the sole wallet-debit path.
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
// The spend rule
// ---------------------------------------------------------------------------

/// Refusal when a currency spend exceeds the wallet balance.
pub(crate) const ERR_NOT_ENOUGH_CURRENCY: &str = "not enough currency";
/// Refusal when the balance covers a spend but the part not locked in trades does not.
pub(crate) const ERR_CURRENCY_IN_TRADE: &str = "currency is in an active trade";
/// Refusal when a stack covers a spend but the part not locked in trades does not.
pub(crate) const ERR_ITEM_IN_TRADE: &str = "item is in an active trade";

/// The spend rule for an asset a trade can lock. `held` is the raw holding and `free` the
/// part of it no trade locks. A request beyond `held` is a plain shortfall (`short`),
/// whatever is locked; a request `held` covers but `free` does not names the trade
/// (`in_trade`). Spending exactly `free` is allowed.
fn check_spend<T: PartialOrd>(
    want: T,
    held: T,
    free: T,
    short: &str,
    in_trade: &str,
) -> Result<(), String> {
    if want > held {
        return Err(short.to_string());
    }
    if want > free {
        return Err(in_trade.to_string());
    }
    Ok(())
}

/// The spend rule for currency: `balance` is the raw wallet balance and `escrowed` the
/// amount the owner's trades lock (`guards::escrowed_currency_of`).
pub(crate) fn check_currency_spend(want: u64, balance: u64, escrowed: u64) -> Result<(), String> {
    check_spend(
        want,
        balance,
        saturating_sub_u64(balance, escrowed),
        ERR_NOT_ENOUGH_CURRENCY,
        ERR_CURRENCY_IN_TRADE,
    )
}

/// The spend rule for one item: `count` is the raw stack count (`inventory::item_count`)
/// and `escrowed` the quantity the owner's trades lock (`guards::escrowed_item_qty_of`).
pub(crate) fn check_item_spend(want: u32, count: u32, escrowed: u32) -> Result<(), String> {
    check_spend(
        want,
        count,
        saturating_sub_u32(count, escrowed),
        ERR_NOT_ENOUGH_ITEM,
        ERR_ITEM_IN_TRADE,
    )
}

// ---------------------------------------------------------------------------
// M13b reducers: buy / sell
// ---------------------------------------------------------------------------

/// `buy` and `sell` reject reason when no NPC offering the shop stands within reach of the
/// caller. One text for a caller with no character, one in another zone and one too far away.
const ERR_SHOP_OUT_OF_REACH: &str = "the shop is not close enough";

/// Refuse the caller unless their character is within reach of an NPC that offers a shop:
/// the shop `shop_id` when it is `Some`, any shop when it is `None`
/// (`game_core::interact::npc_offers_shop`). Reach is measured from each NPC's home tile
/// (`game_core::interact::within_npc_reach`); only the NPCs of the caller's zone are read.
fn require_shop_in_reach(
    ctx: &ReducerContext,
    reducer: &str,
    shop_id: Option<u32>,
) -> Result<(), String> {
    let me = ctx.sender();
    let in_reach = character_of(ctx, me).is_some_and(|ch| {
        let pos = char_state(&ch).pos;
        ctx.db.npc().zone_id().filter(ch.zone_id).any(|npc| {
            let home = TilePos {
                x: npc.home_x,
                y: npc.home_y,
            };
            npc_offers_shop(npc.interaction, shop_id)
                && within_npc_reach(ch.zone_id, pos, npc.zone_id, home, npc.wander_radius)
        })
    });
    if !in_reach {
        log_reject(reducer, me, ERR_SHOP_OUT_OF_REACH);
        return Err(ERR_SHOP_OUT_OF_REACH.to_string());
    }
    Ok(())
}

/// Buy `qty` units of `item_id` from shop `shop_id`.
///
/// Server flow (reject-not-clamp, server-priced, atomic):
/// 1. Verify caller is a joined player (`require_owner` before any spend), then the
///    deletion gate — reject a mid-grace or terminal caller
///    before any further read — then reach: an NPC offering `shop_id` stands within
///    reach of the caller's character — then the ongoing-battle guard (either role).
/// 2. Look up the `shop_item_row` for `(shop_id, item_id)` — reject if not stocked.
/// 3. Compute total = `buy_price × qty` (server-side, checked_mul — no overflow).
/// 4. Spend rule (`check_currency_spend`) — reject a total beyond the balance as a
///    shortfall, and one the balance covers but a trade has locked as in a trade.
/// 5. Receiver-cap headroom — `check_item_headroom` on the
///    RAW stack count, reject-not-destroy BEFORE the spend.
/// 6. `spend_currency` — reject if insufficient funds or no wallet.
/// 7. `grant_item` — credit the purchased items.
///
/// Prices come from the `shop_item_row` content table; the client never provides
/// a price or total (classic economy exploit blocked at the reducer boundary).
#[spacetimedb::reducer]
pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) -> Result<(), String> {
    let me = ctx.sender();

    // require_owner before spend_currency.
    let p = ctx
        .db
        .player()
        .identity()
        .find(me)
        .ok_or_else(|| "not joined".to_string())?;
    require_owner(ctx, "buy", p.identity)?;

    // Deletion gate: standing is established, so a
    // mid-grace or terminal account is refused HERE — before the stock lookup, the
    // escrow/headroom reads and the spend.
    crate::guards::require_not_deleting(ctx, "buy")?;

    // Reach: ahead of the battle guard and of every read of the caller's wallet and
    // inventory, so the refusal is the same whatever they hold.
    require_shop_in_reach(ctx, "buy", Some(shop_id))?;

    // Both-role ongoing-battle guard: no shopping mid-battle.
    if is_in_ongoing_battle(ctx, me) {
        return Err("cannot buy during an ongoing battle".to_string());
    }

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

    // Spend rule: a total beyond the balance is a shortfall; one a trade has locked says so.
    check_currency_spend(
        total,
        wallet_balance(ctx, me),
        escrowed_currency_of(ctx, me),
    )?;

    // receiver-cap reject BEFORE the spend.
    // RAW stack count, not escrow-netted — grant_item credits the raw stack;
    // escrow is a spend-lock, not a receive-lock.
    check_item_headroom(item_count(ctx, me, item_id), qty, item_id).map_err(|e| e.to_string())?;

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
///    then the deletion gate — reject a mid-grace or
///    terminal caller before any further read — then reach: an NPC offering any
///    shop stands within reach of the caller's character — then the ongoing-battle
///    guard (either role).
/// 2. Look up `sell_price` from `item_row` — reject if 0 ("item cannot be sold").
/// 3. Compute total = `sell_price × qty` (server-side, checked_mul) — an
///    overflow rejects here, pre-filtering the headroom check in step 5
///    (defense-in-depth).
/// 4. Spend rule (`check_item_spend`) — reject a quantity beyond the stack as a
///    shortfall, and one the stack covers but a trade has locked as in a trade.
/// 5. Proceeds-cap headroom — `check_currency_headroom` on
///    the RAW balance, reject-not-destroy BEFORE any consume.
/// 6. `consume_n` — debit the whole quantity in one write.
/// 7. `grant_currency` — credit the proceeds.
///
/// sell_price comes from the `item_row` content table; the client never provides
/// a price.
#[spacetimedb::reducer]
pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String> {
    let me = ctx.sender();

    // require_owner before any resource modification.
    let p = ctx
        .db
        .player()
        .identity()
        .find(me)
        .ok_or_else(|| "not joined".to_string())?;
    require_owner(ctx, "sell", p.identity)?;

    // Deletion gate: standing is established, so a
    // mid-grace or terminal account is refused HERE — before the item lookup, the
    // escrow/headroom reads and the consume.
    crate::guards::require_not_deleting(ctx, "sell")?;

    // Reach: any shop NPC buys, so no shop id is asked for. Same placement as `buy`.
    require_shop_in_reach(ctx, "sell", None)?;

    // Both-role ongoing-battle guard: no shopping mid-battle.
    if is_in_ongoing_battle(ctx, me) {
        return Err("cannot sell during an ongoing battle".to_string());
    }

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

    // Spend rule: a quantity beyond the stack is a shortfall; one a trade has locked says so.
    check_item_spend(
        qty,
        item_count(ctx, me, item_id),
        escrowed_item_qty_of(ctx, me, item_id),
    )?;

    // proceeds-cap reject BEFORE consuming — the sell side is value-destruction
    // with no rollback backstop, because grant_currency is infallible and
    // saturates. RAW balance, not escrow-netted — escrow is a spend-lock, not a
    // receive-lock. The checked_mul above pre-filters this check for overflow
    // (defense-in-depth).
    let balance = wallet_balance(ctx, me);
    check_currency_headroom(balance, total).map_err(|e| e.to_string())?;

    consume_n(ctx, me, item_id, qty)?;

    grant_currency(ctx, me, total);

    Ok(())
}

// --- M21 guest→account wallet re-key (AUTH-23/24) ----------------

/// Zero a wallet row's balance in place, preserving its PK. Pure seam so the
/// "balance becomes 0, owner unchanged" property is unit-testable without a
/// `ReducerContext`. NEVER produces a delete (AUTH-23).
pub(crate) fn zeroed_wallet(row: PlayerWallet) -> PlayerWallet {
    PlayerWallet { balance: 0, ..row }
}

/// delete `owner`'s wallet row
/// outright — the ONE sanctioned `player_wallet` delete in the crate.
/// `player_wallet` is ERASE-classified: a surviving zeroed row is exactly the
/// orphaned data. Called only from `accounts::account_deletion_reaper`.
pub(crate) fn erase_wallet(ctx: &ReducerContext, owner: Identity) {
    ctx.db.player_wallet().owner_identity().delete(owner);
}

/// Re-key the guest's wallet balance onto `to` by CREDIT-FORWARD, then zero the
/// guest's row in place — NEVER delete it. Must live in `economy.rs`. Read the
/// balance BEFORE zeroing; `grant_currency` writes a different PK (`to !=
/// from`), so credit-then-zero is race-free and the balance is never lost. A
/// zero-balance guest creates no phantom destination row (`grant_currency`'s
/// 0-amount early return).
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
/// `accounts::account_has_game_data`). Distinct from `wallet_balance` — "row
/// present" is not "balance > 0" (a zeroed post-claim guest row still exists).
pub(crate) fn wallet_exists(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db
        .player_wallet()
        .owner_identity()
        .find(owner)
        .is_some()
}

#[cfg(test)]
#[path = "economy_tests.rs"]
mod economy_tests;
