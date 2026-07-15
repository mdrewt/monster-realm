//! `trading` — server-module domain submodule (M15, ADR-0106).
//!
//! Thin imperative shell: validate caller + ownership, delegate rule-level checks
//! to `game_core::trading`, write the `trade_offer` table. The atomic swap re-reads
//! live `monster`/`inventory`/`player_wallet` rows in one SpacetimeDB transaction
//! before executing any ownership transfer (TR-15, ADR-0106 D3).
//!
//! Flow: propose_trade → respond_trade(accept) → confirm_trade → atomic swap.
//! Cancellation paths: cancel_trade (either party) + on_disconnect (lib.rs).
//! Liveness: a scheduled TTL reaper deletes offers older than `TRADE_OFFER_TTL_MS`
//! (16.5f-4, ADR-0117); every offer-deletion path disarms its schedule row.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::economy::{grant_currency, spend_currency, wallet_balance};
use crate::guards::{escrowed_currency_amount, escrowed_item_qty, log_reject, reject_if_in_battle};
use crate::inventory::{consume_one, grant_item};
use crate::marshal::{now_ms, pub_from_monster};
use crate::schema::{battle, inventory, monster, monster_pub, player, trade_offer, TradeOffer};
use game_core::{
    authorize_confirm, authorize_respond, build_swap_plan, check_headroom, is_offer_stale,
    make_monster_card, validate_proposal, ItemStack, LiveMonsterOwner, MonsterCard, ProposalSide,
    TradeItem, TradeSide, TradeStatus, TRADE_OFFER_TTL_MS,
};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Returns true if `owner` has any active (Pending or ConfirmedByCounterparty)
/// trade offer, as either initiator or counterparty (TR-20, D4).
/// Uses the two btree indexes — O(active_offers_for_owner), not O(total).
fn has_active_trade(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db
        .trade_offer()
        .initiator()
        .filter(owner)
        .any(|t| t.status.is_active())
        || ctx
            .db
            .trade_offer()
            .counterparty()
            .filter(owner)
            .any(|t| t.status.is_active())
}

/// Build display-only `MonsterCard` snapshots from the given monster IDs.
/// Rejects if any ID is not found or not owned by `expected_owner`.
fn build_cards(
    ctx: &ReducerContext,
    monster_ids: &[u64],
    expected_owner: Identity,
    reducer: &str,
) -> Result<Vec<MonsterCard>, String> {
    let me = ctx.sender;
    let mut cards = Vec::with_capacity(monster_ids.len());
    for &mid in monster_ids {
        let Some(m) = ctx.db.monster().monster_id().find(mid) else {
            let e = format!("monster {mid} not found");
            log_reject(reducer, me, &e);
            return Err(e);
        };
        if m.owner_identity != expected_owner {
            let e = format!("monster {mid} not owned by caller");
            log_reject(reducer, me, &e);
            return Err(e);
        }
        cards.push(make_monster_card(
            m.monster_id,
            m.species_id,
            m.nickname.clone(),
            m.level,
            m.current_hp,
            m.stat_hp,
        ));
    }
    Ok(cards)
}

// ---------------------------------------------------------------------------
// TTL reaper (16.5f-4, ADR-0117)
// ---------------------------------------------------------------------------

// Scheduled table colocated with its reducer (ADR-0056 exception, mirrors pvp_deadline_schedule).
// PRIVATE — prevents client schedule manipulation; the underlying facts are already public via trade_offer.
#[spacetimedb::table(name = trade_offer_reaper_schedule, scheduled(trade_offer_reaper))]
pub struct TradeOfferReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    /// The trade offer this schedule guards (auto_inc — never reused, no ABA).
    #[index(btree)]
    pub trade_id: u64,
}

/// Arm the TTL reaper for a newly-inserted offer.
///
/// The deadline is computed FROM THE MS-FLOORED `created_at_ms` (not raw micros) —
/// kills the ms-truncation edge where the schedule could fire fractionally before
/// `is_offer_stale`'s ms clock reaches the TTL boundary (ADR-0117 D4).
fn schedule_trade_reaper(ctx: &ReducerContext, trade_id: u64, created_at_ms: i64) {
    let deadline_micros = created_at_ms
        .saturating_mul(1_000)
        .saturating_add(TRADE_OFFER_TTL_MS.saturating_mul(1_000));
    ctx.db
        .trade_offer_reaper_schedule()
        .insert(TradeOfferReaperSchedule {
            scheduled_id: 0, // auto_inc
            scheduled_at: ScheduleAt::Time(spacetimedb::Timestamp::from_micros_since_unix_epoch(
                deadline_micros,
            )),
            trade_id,
        });
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

/// Scheduled reaper: delete a trade offer that has outlived `TRADE_OFFER_TTL_MS`.
///
/// This is a SCHEDULER-ONLY reducer — clients must never call it directly.
/// Guard: `ctx.sender != ctx.identity()` (identical to `pvp_deadline_reaper`,
/// ADR-0056). Staleness is re-checked via `is_offer_stale` so an early fire or
/// clock skew never reaps a fresh offer.
#[spacetimedb::reducer]
pub fn trade_offer_reaper(
    ctx: &ReducerContext,
    args: TradeOfferReaperSchedule,
) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
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

/// Propose a trade: escrow the listed assets and await the counterparty's response.
///
/// Guards (in order):
/// 1. Caller must be joined.
/// 2. Counterparty != caller (no self-trade, TR-21).
/// 3. Neither party has an active offer (TR-20 / D4).
/// 4. validate_proposal (empty offer / duplicate monster IDs / zero-qty items, TR-1/22).
/// 5. All initiator monsters exist and are owned by caller.
/// 6. All counterparty monsters exist and are owned by counterparty.
/// 7. No initiator monster is in an Ongoing battle (`reject_if_in_battle`, chains
///    both `player_identity()` and `opponent_identity()` indexes — ADR-0112 D1/D2).
/// 8. No counterparty monster is in an Ongoing battle (same guard, same coverage).
///
/// On success: inserts a `trade_offer` row with `status = Pending`. Assets are
/// NOT moved — the `reject_if_monster_in_trade` / `escrowed_*` guards enforce
/// the escrow invariant in every mutating reducer (ADR-0106 D3).
#[allow(clippy::too_many_arguments)]
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
    let me = ctx.sender;

    // Must be joined.
    ctx.db
        .player()
        .identity()
        .find(me)
        .ok_or_else(|| "not joined".to_string())?;

    // Counterparty must be a joined player (prevents phantom-offer DoS, ADR-0106).
    ctx.db
        .player()
        .identity()
        .find(counterparty)
        .ok_or_else(|| "counterparty is not a joined player".to_string())?;

    // Validate via pure game-core rules.
    validate_proposal(
        has_active_trade(ctx, me),
        has_active_trade(ctx, counterparty),
        me == counterparty,
        ProposalSide {
            monster_ids: &initiator_monster_ids,
            items: &initiator_items,
            currency: initiator_currency,
        },
        ProposalSide {
            monster_ids: &counterparty_monster_ids,
            items: &counterparty_items,
            currency: counterparty_currency,
        },
    )
    .map_err(|e| {
        let msg = e.to_string();
        log_reject("propose_trade", me, &msg);
        msg
    })?;

    // Currency balance checks: reject offers listing more currency than the party owns.
    // Prevents the counterparty_currency=MAX DoS that locks all currency-dependent reducers.
    if initiator_currency > 0 {
        let bal = wallet_balance(ctx, me);
        // Escrow is provably 0 here under ADR-0106 D4 (one active offer per player — validate_proposal above already rejected active-trade parties); kept symmetric for the auction-house extension (ADR-0117 D3).
        let escrowed = escrowed_currency_amount(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(me)
                .chain(ctx.db.trade_offer().counterparty().filter(me)),
            me,
        );
        if initiator_currency > bal.saturating_sub(escrowed) {
            let e = "insufficient currency for trade offer".to_string();
            log_reject("propose_trade", me, &e);
            return Err(e);
        }
    }
    if counterparty_currency > 0 {
        let cp_bal = wallet_balance(ctx, counterparty);
        // Escrow is provably 0 here under ADR-0106 D4 (one active offer per player — validate_proposal above already rejected active-trade parties); kept symmetric for the auction-house extension (ADR-0117 D3).
        let escrowed = escrowed_currency_amount(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(counterparty)
                .chain(ctx.db.trade_offer().counterparty().filter(counterparty)),
            counterparty,
        );
        if counterparty_currency > cp_bal.saturating_sub(escrowed) {
            let e = "counterparty has insufficient currency for this trade".to_string();
            log_reject("propose_trade", me, &e);
            return Err(e);
        }
    }
    // Item inventory checks: reject offers listing more items than the party owns.
    // Prevents stuck-ConfirmedByCounterparty from a phantom item offer.
    for item in &initiator_items {
        let count = ctx
            .db
            .inventory()
            .owner_identity()
            .filter(me)
            .find(|r| r.item_id == item.item_id)
            .map(|r| r.count)
            .unwrap_or(0);
        let escrowed = escrowed_item_qty(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(me)
                .chain(ctx.db.trade_offer().counterparty().filter(me)),
            me,
            item.item_id,
        );
        if item.qty > count.saturating_sub(escrowed) {
            let e = format!("insufficient inventory for item {}", item.item_id);
            log_reject("propose_trade", me, &e);
            return Err(e);
        }
    }
    for item in &counterparty_items {
        let count = ctx
            .db
            .inventory()
            .owner_identity()
            .filter(counterparty)
            .find(|r| r.item_id == item.item_id)
            .map(|r| r.count)
            .unwrap_or(0);
        // Escrow is provably 0 here under ADR-0106 D4 (one active offer per player — validate_proposal above already rejected active-trade parties); kept symmetric for the auction-house extension (ADR-0117 D3).
        let escrowed = escrowed_item_qty(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(counterparty)
                .chain(ctx.db.trade_offer().counterparty().filter(counterparty)),
            counterparty,
            item.item_id,
        );
        if item.qty > count.saturating_sub(escrowed) {
            let e = format!(
                "counterparty has insufficient inventory for item {}",
                item.item_id
            );
            log_reject("propose_trade", me, &e);
            return Err(e);
        }
    }

    // Battle interlock guards (16.5a-1, 16.5a-2, ADR-0112): reject if any offered monster
    // is in an ongoing battle. Both player_identity and opponent_identity btree indexes are
    // chained so PvP side-B participants (whose battles index under opponent_identity per
    // ADR-0109) are caught alongside PvE / PvP side-A participants.
    for &mid in &initiator_monster_ids {
        let i_battles = ctx
            .db
            .battle()
            .player_identity()
            .filter(me)
            .chain(ctx.db.battle().opponent_identity().filter(me));
        reject_if_in_battle(i_battles, mid).inspect_err(|e| log_reject("propose_trade", me, e))?;
    }
    for &mid in &counterparty_monster_ids {
        let cp_battles = ctx
            .db
            .battle()
            .player_identity()
            .filter(counterparty)
            .chain(ctx.db.battle().opponent_identity().filter(counterparty));
        reject_if_in_battle(cp_battles, mid).inspect_err(|e| log_reject("propose_trade", me, e))?;
    }

    // Build display snapshots (also validates ownership).
    let initiator_cards = build_cards(ctx, &initiator_monster_ids, me, "propose_trade")?;
    let counterparty_cards = build_cards(
        ctx,
        &counterparty_monster_ids,
        counterparty,
        "propose_trade",
    )?;

    // Capture the insert return — the auto_inc trade_id only exists on the returned
    // row (ADR-0072 capture-insert).
    let inserted = ctx.db.trade_offer().insert(TradeOffer {
        trade_id: 0, // auto_inc
        initiator: me,
        counterparty,
        initiator_monster_ids,
        initiator_items,
        initiator_currency,
        counterparty_monster_ids,
        counterparty_items,
        counterparty_currency,
        initiator_cards,
        counterparty_cards,
        status: TradeStatus::Pending,
        created_at_ms: now_ms(ctx),
    });
    schedule_trade_reaper(ctx, inserted.trade_id, inserted.created_at_ms);

    Ok(())
}

/// Counterparty responds to a Pending offer.
///
/// Role + status authorization is delegated to the pure `authorize_respond`
/// (role FIRST — no status leak to non-parties; 16.5f-1, ADR-0117).
///
/// - `accepted = false` → row deleted (escrow released, no assets moved, TR-13).
/// - `accepted = true` → status → ConfirmedByCounterparty (TR-14).
#[spacetimedb::reducer]
pub fn respond_trade(ctx: &ReducerContext, trade_id: u64, accepted: bool) -> Result<(), String> {
    let me = ctx.sender;

    let Some(offer) = ctx.db.trade_offer().trade_id().find(trade_id) else {
        return Err("trade offer not found".to_string());
    };
    authorize_respond(&offer.status, offer.counterparty == me).map_err(|e| {
        let msg = e.to_string();
        log_reject("respond_trade", me, &msg);
        msg
    })?;

    if !accepted {
        // Rejection: delete the row → guard released, no assets move (TR-13).
        ctx.db.trade_offer().trade_id().delete(trade_id);
        disarm_trade_reaper(ctx, trade_id);
        return Ok(());
    }

    // Acceptance: advance to ConfirmedByCounterparty (TR-14).
    let mut updated = offer;
    updated.status = TradeStatus::ConfirmedByCounterparty;
    ctx.db.trade_offer().trade_id().update(updated);

    Ok(())
}

/// Initiator confirms a ConfirmedByCounterparty offer → atomic swap.
///
/// Role + status authorization is delegated to the pure `authorize_confirm`
/// (role FIRST — no status leak to non-parties; 16.5f-1, ADR-0117).
///
/// Re-reads all live rows, verifies ownership still matches the offer, then
/// executes the ownership/item/currency transfers in one transaction and deletes
/// the offer row (TR-15/TR-16, ADR-0106 D3).
#[spacetimedb::reducer]
pub fn confirm_trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String> {
    let me = ctx.sender;

    let Some(offer) = ctx.db.trade_offer().trade_id().find(trade_id) else {
        return Err("trade offer not found".to_string());
    };
    authorize_confirm(&offer.status, offer.initiator == me).map_err(|e| {
        let msg = e.to_string();
        log_reject("confirm_trade", me, &msg);
        msg
    })?;

    // Re-read live monster rows + verify ownership (TR-15).
    let mut i_live: Vec<LiveMonsterOwner> = Vec::with_capacity(offer.initiator_monster_ids.len());
    for &mid in &offer.initiator_monster_ids {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(mid)
            .ok_or_else(|| format!("monster {mid} not found during swap"))?;
        i_live.push(LiveMonsterOwner {
            monster_id: mid,
            owner_matches_expected: m.owner_identity == offer.initiator,
        });
    }
    let mut c_live: Vec<LiveMonsterOwner> =
        Vec::with_capacity(offer.counterparty_monster_ids.len());
    for &mid in &offer.counterparty_monster_ids {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(mid)
            .ok_or_else(|| format!("monster {mid} not found during swap"))?;
        c_live.push(LiveMonsterOwner {
            monster_id: mid,
            owner_matches_expected: m.owner_identity == offer.counterparty,
        });
    }

    // Battle interlock re-assertion (defense-in-depth, 16.5a-1, ADR-0112).
    // A battle may start between respond_trade (status → ConfirmedByCounterparty) and
    // confirm_trade. Re-check BEFORE build_swap_plan so the transaction aborts cleanly
    // without planning any ownership transfer. Covers PvP side-B via opponent_identity.
    for &mid in &offer.initiator_monster_ids {
        reject_if_in_battle(
            ctx.db
                .battle()
                .player_identity()
                .filter(offer.initiator)
                .chain(ctx.db.battle().opponent_identity().filter(offer.initiator)),
            mid,
        )
        .inspect_err(|e| log_reject("confirm_trade", me, e))?;
    }
    for &mid in &offer.counterparty_monster_ids {
        reject_if_in_battle(
            ctx.db
                .battle()
                .player_identity()
                .filter(offer.counterparty)
                .chain(
                    ctx.db
                        .battle()
                        .opponent_identity()
                        .filter(offer.counterparty),
                ),
            mid,
        )
        .inspect_err(|e| log_reject("confirm_trade", me, e))?;
    }

    // Receiver cap headroom check (16.5b-1, ADR-0113): reject BEFORE any transfer if
    // crediting items/currency to the receiver would exceed MAX_ITEM_STACK or MAX_BALANCE.
    // Prevents silent value destruction via grant_item/grant_currency clamping.
    {
        // Initiator RECEIVES counterparty_items + counterparty_currency.
        // Subtract any qty the initiator is simultaneously SENDING of the same item_id so
        // the headroom check uses the post-debit effective count, not the pre-debit raw count.
        // Without this, a symmetric same-item swap (give 15 of X, receive 20 of X while
        // holding 9990) falsely rejects: 9990+20>9999 but net 9990-15+20=9995 is fine.
        let i_stacks: Vec<ItemStack> = offer
            .counterparty_items
            .iter()
            .map(|ti| {
                let raw_count = ctx
                    .db
                    .inventory()
                    .owner_identity()
                    .filter(offer.initiator)
                    .find(|r| r.item_id == ti.item_id)
                    .map(|r| r.count)
                    .unwrap_or(0);
                let sending_qty = offer
                    .initiator_items
                    .iter()
                    .find(|si| si.item_id == ti.item_id)
                    .map(|si| si.qty)
                    .unwrap_or(0);
                ItemStack {
                    item_id: ti.item_id,
                    current_count: raw_count.saturating_sub(sending_qty),
                }
            })
            .collect();
        // Counterparty RECEIVES initiator_items + initiator_currency.
        // Same net-quantity correction applied symmetrically.
        let c_stacks: Vec<ItemStack> = offer
            .initiator_items
            .iter()
            .map(|ti| {
                let raw_count = ctx
                    .db
                    .inventory()
                    .owner_identity()
                    .filter(offer.counterparty)
                    .find(|r| r.item_id == ti.item_id)
                    .map(|r| r.count)
                    .unwrap_or(0);
                let sending_qty = offer
                    .counterparty_items
                    .iter()
                    .find(|si| si.item_id == ti.item_id)
                    .map(|si| si.qty)
                    .unwrap_or(0);
                ItemStack {
                    item_id: ti.item_id,
                    current_count: raw_count.saturating_sub(sending_qty),
                }
            })
            .collect();
        let i_balance = wallet_balance(ctx, offer.initiator);
        let c_balance = wallet_balance(ctx, offer.counterparty);
        check_headroom(
            &offer.counterparty_items,
            &i_stacks,
            offer.counterparty_currency,
            i_balance,
            &offer.initiator_items,
            &c_stacks,
            offer.initiator_currency,
            c_balance,
        )
        .map_err(|e| {
            let msg = e.to_string();
            log_reject("confirm_trade", me, &msg);
            msg
        })?;
    }

    // Build the mutation plan (pure, fails if ownership changed).
    let plan = build_swap_plan(
        &i_live,
        &c_live,
        &offer.initiator_items,
        &offer.counterparty_items,
        offer.initiator_currency,
        offer.counterparty_currency,
    )
    .map_err(|e| {
        let msg = e.to_string();
        log_reject("confirm_trade", me, &msg);
        msg
    })?;

    // Apply monster transfers (dual-write monster + monster_pub, clear party_slot).
    for xfer in &plan.monster_transfers {
        let new_owner = if xfer.new_owner_idx == TradeSide::Counterparty {
            offer.counterparty
        } else {
            offer.initiator
        };

        let mut m = ctx
            .db
            .monster()
            .monster_id()
            .find(xfer.monster_id)
            .ok_or_else(|| format!("monster {} gone during apply", xfer.monster_id))?;
        m.owner_identity = new_owner;
        m.party_slot = crate::PARTY_SLOT_NONE;
        let mut mp = pub_from_monster(&m);
        mp.owner_identity = new_owner;
        mp.party_slot = crate::PARTY_SLOT_NONE;
        ctx.db.monster().monster_id().update(m);
        ctx.db.monster_pub().monster_id().update(mp);
    }

    // Apply item transfers.
    for xfer in &plan.item_transfers {
        let (from, to) = if xfer.from_initiator {
            (offer.initiator, offer.counterparty)
        } else {
            (offer.counterparty, offer.initiator)
        };
        // consume_one returns Err if insufficient — the whole transaction rolls back.
        for _ in 0..xfer.qty {
            consume_one(ctx, from, xfer.item_id)?;
        }
        grant_item(ctx, to, xfer.item_id, xfer.qty);
    }

    // Apply currency transfers.
    for xfer in &plan.currency_transfers {
        let (from, to) = if xfer.from_initiator {
            (offer.initiator, offer.counterparty)
        } else {
            (offer.counterparty, offer.initiator)
        };
        spend_currency(ctx, from, xfer.amount)?;
        grant_currency(ctx, to, xfer.amount);
    }

    // Delete the offer row — releases the escrow guard (TR-16).
    ctx.db.trade_offer().trade_id().delete(trade_id);
    disarm_trade_reaper(ctx, trade_id);

    Ok(())
}

/// Cancel a trade offer. Either party may cancel before the swap executes.
///
/// Deletes the row → escrow released, no assets moved (TR-17).
/// Both Pending and ConfirmedByCounterparty can be cancelled.
#[spacetimedb::reducer]
pub fn cancel_trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String> {
    let me = ctx.sender;

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

/// Cancel all active offers for a disconnecting player (TR-18). Called from
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
