//! `trading` — server-module domain submodule.
//!
//! The `trade_offer` table is drain-only. No reducer creates an offer:
//! `propose_trade`, `respond_trade` and `confirm_trade` are retired and return
//! `LEGACY_TRADE_RETIRED` without reading or writing a row. They stay callable
//! so the generated client bindings keep their shape. Trades run through
//! `trading_session`.
//!
//! What is live here is how an existing offer row leaves the table:
//! `cancel_trade` (either party), `cancel_trades_on_disconnect` (lib.rs), the
//! account-deletion helpers, and a scheduled TTL reaper that deletes offers
//! older than `TRADE_OFFER_TTL_MS`. Every offer-deletion path disarms its
//! schedule row.

use crate::guards::log_reject;
use crate::marshal::now_ms;
use crate::schema::trade_offer;
use game_core::{is_offer_stale, TradeItem};
use spacetimedb::{Identity, ReducerContext, ScheduleAt};

// ---------------------------------------------------------------------------
// TTL reaper
// ---------------------------------------------------------------------------

// Scheduled table colocated with its reducer.
// PRIVATE — prevents client schedule manipulation; the underlying facts are already public via trade_offer.
#[spacetimedb::table(accessor = trade_offer_reaper_schedule, scheduled(trade_offer_reaper))]
pub struct TradeOfferReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    /// The trade offer this schedule guards (auto_inc — never reused, no ABA).
    #[index(btree)]
    pub trade_id: u64,
}

/// Disarm the reaper schedule(s) for `trade_id`. Called at every offer-deletion
/// site so no orphaned schedule row survives its offer. Collect-before-delete
/// (mirrors `cancel_trades_on_disconnect`): gather the scheduled_ids via the
/// trade_id btree filter first, then delete each via the primary key.
fn disarm_trade_reaper(ctx: &ReducerContext, trade_id: u64) {
    let scheduled_ids: Vec<u64> = ctx
        .db
        .trade_offer_reaper_schedule()
        .trade_id()
        .filter(trade_id)
        .map(|s| s.scheduled_id)
        .collect();
    for sid in scheduled_ids {
        ctx.db
            .trade_offer_reaper_schedule()
            .scheduled_id()
            .delete(sid);
    }
}

/// The caller's live INCOMING offers — every active
/// `trade_offer` naming `counterparty` on the counterparty column, read through
/// its btree index — projected to `(trade_id, created_at_ms)` so the accounts
/// module can judge them against the deletion request without this module ever
/// reading account state. Counterparty column ONLY: the accounts module
/// declines offers made TO the caller; an offer the caller opened is not read
/// here. `is_active()` is the shared liveness spelling
/// (`cancel_trades_on_disconnect`); both variants are active today, so the
/// filter is forward-defensive against a future terminal variant.
pub(crate) fn open_offers_addressed_to(
    ctx: &ReducerContext,
    counterparty: Identity,
) -> Vec<(u64, i64)> {
    ctx.db
        .trade_offer()
        .counterparty()
        .filter(counterparty)
        .filter(|o| o.status.is_active())
        .map(|o| (o.trade_id, o.created_at_ms))
        .collect()
}

/// Decline the given offers — disarm each TTL schedule row
/// first, then delete the offer (the `erase_trade_offers` order). Called only
/// from `accounts::cancel_account_deletion` with the ids
/// `accounts::plan_declines_at_cancel` selected; the policy lives there, this
/// is the write half kept inside the module that owns `trade_offer` (D0). No
/// assets move: escrow is guard-in-place, so a delete here has the
/// same effect as `cancel_trade`. EA-REAPER-02 site 5.
pub(crate) fn decline_offers(ctx: &ReducerContext, trade_ids: &[u64]) {
    for &trade_id in trade_ids {
        disarm_trade_reaper(ctx, trade_id);
        ctx.db.trade_offer().trade_id().delete(trade_id);
    }
}

/// Scheduled reaper: delete a trade offer that has outlived `TRADE_OFFER_TTL_MS`.
///
/// This is a SCHEDULER-ONLY reducer — clients must never call it directly.
/// Guard: `ctx.sender() != ctx.database_identity()` (identical to `pvp_deadline_reaper`).
/// Staleness is re-checked via `is_offer_stale` so an early fire or
/// clock skew never reaps a fresh offer.
///
/// No self-disarm: one-shot `ScheduleAt::Time` rows are deleted BY THE RUNTIME
/// after the reducer returns ("Scheduled reducers delete the row after execution"
/// — SpacetimeDB docs, schedule-tables §Row Lifecycle).
/// A self-delete here would race the runtime's post-execution delete.
#[spacetimedb::reducer]
pub fn trade_offer_reaper(
    ctx: &ReducerContext,
    args: TradeOfferReaperSchedule,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("trade_offer_reaper is scheduler-only".to_string());
    }
    let Some(offer) = ctx.db.trade_offer().trade_id().find(args.trade_id) else {
        return Ok(()); // offer completed/cancelled before TTL — no-op (schedule row was consumed on fire)
    };
    if !is_offer_stale(offer.created_at_ms, now_ms(ctx)) {
        return Ok(()); // defensive: fired early/clock skew — never reap a fresh offer
    }
    let trade_id = args.trade_id;
    log::info!("{{\"evt\":\"trade_offer_reaped\",\"trade_id\":{trade_id}}}");
    ctx.db.trade_offer().trade_id().delete(args.trade_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/// The one error every retired legacy trade reducer returns.
const LEGACY_TRADE_RETIRED: &str = "this trade flow is retired; trade face to face instead";

/// Retired: its only statement returns `LEGACY_TRADE_RETIRED`. It reads no row
/// and writes none, whatever the arguments, so no offer naming another player's
/// assets can be created and no error depends on another player's wallet or
/// inventory. The signature is the generated binding's shape.
#[allow(clippy::too_many_arguments, unused_variables)]
#[spacetimedb::reducer]
pub fn propose_trade(
    ctx: &ReducerContext,
    counterparty: Identity,
    initiator_monster_ids: Vec<u64>,
    initiator_items: Vec<TradeItem>,
    initiator_currency: u64,
    counterparty_monster_ids: Vec<u64>,
    counterparty_items: Vec<TradeItem>,
    counterparty_currency: u64,
) -> Result<(), String> {
    Err(LEGACY_TRADE_RETIRED.to_string())
}

/// Retired: its only statement returns `LEGACY_TRADE_RETIRED`; no row is read
/// or written. An offer still in the table leaves through `cancel_trade`, the
/// TTL reaper, a disconnect or account deletion.
#[allow(unused_variables)]
#[spacetimedb::reducer]
pub fn respond_trade(ctx: &ReducerContext, trade_id: u64, accepted: bool) -> Result<(), String> {
    Err(LEGACY_TRADE_RETIRED.to_string())
}

/// Retired: its only statement returns `LEGACY_TRADE_RETIRED`; no row is read
/// or written and no asset moves.
#[allow(unused_variables)]
#[spacetimedb::reducer]
pub fn confirm_trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String> {
    Err(LEGACY_TRADE_RETIRED.to_string())
}

/// Cancel a trade offer. Either party may cancel.
///
/// Deletes the row, which releases the escrow guard; no asset moves.
/// Both Pending and ConfirmedByCounterparty can be cancelled.
#[spacetimedb::reducer]
pub fn cancel_trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String> {
    let me = ctx.sender();

    let Some(offer) = ctx.db.trade_offer().trade_id().find(trade_id) else {
        return Err("trade offer not found".to_string());
    };
    if offer.initiator != me && offer.counterparty != me {
        let e = "not a party to this trade".to_string();
        log_reject("cancel_trade", me, &e);
        return Err(e);
    }
    if !offer.status.is_active() {
        // Should be unreachable (terminal rows are deleted), but guard defensively.
        return Err("trade offer is already terminal".to_string());
    }

    ctx.db.trade_offer().trade_id().delete(trade_id);
    disarm_trade_reaper(ctx, trade_id);
    Ok(())
}

/// delete every `trade_offer` naming `owner` on EITHER side — initiator AND
/// counterparty, with NO liveness filter (contrast
/// `cancel_trades_on_disconnect` below, which is active-only by design) — and
/// disarm each offer's TTL schedule row (the JOIN_ONLY sweep riding its
/// parent, the disarm idiom). After the cascade's 6a resolve this is
/// defense-in-depth over an already-empty set; it must still exist and sweep
/// BOTH columns, or an incoming offer the deleted player never answered
/// survives in a public table naming them. Called only from
/// `accounts::account_deletion_reaper`.
pub(crate) fn erase_trade_offers(ctx: &ReducerContext, owner: Identity) {
    let ids: Vec<u64> = ctx
        .db
        .trade_offer()
        .initiator()
        .filter(owner)
        .map(|o| o.trade_id)
        .chain(
            ctx.db
                .trade_offer()
                .counterparty()
                .filter(owner)
                .map(|o| o.trade_id),
        )
        .collect();
    for id in ids {
        disarm_trade_reaper(ctx, id);
        ctx.db.trade_offer().trade_id().delete(id);
    }
}

/// Cancel all active offers for a disconnecting player. Called from
/// `on_disconnect` in lib.rs. Uses indexed filters — O(offers for player), not O(total).
pub(crate) fn cancel_trades_on_disconnect(ctx: &ReducerContext, player: Identity) {
    // Collect IDs first to avoid mutating while iterating.
    let to_cancel: Vec<u64> = ctx
        .db
        .trade_offer()
        .initiator()
        .filter(player)
        .filter(|t| t.status.is_active())
        .map(|t| t.trade_id)
        .chain(
            ctx.db
                .trade_offer()
                .counterparty()
                .filter(player)
                .filter(|t| t.status.is_active())
                .map(|t| t.trade_id),
        )
        .collect();

    for trade_id in to_cancel {
        ctx.db.trade_offer().trade_id().delete(trade_id);
        disarm_trade_reaper(ctx, trade_id);
    }
}

#[cfg(test)]
#[path = "trading_tests.rs"]
mod trading_tests;
