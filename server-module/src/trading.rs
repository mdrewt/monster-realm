//! `trading` — server-module domain submodule (M15, ADR-0106).
//!
//! Thin imperative shell: validate caller + ownership, delegate rule-level checks
//! to `game_core::trading`, write the `trade_offer` table. The atomic swap re-reads
//! live `monster`/`inventory`/`player_wallet` rows in one SpacetimeDB transaction
//! before executing any ownership transfer (TR-15, ADR-0106 D3).
//!
//! Flow: propose_trade → respond_trade(accept) → confirm_trade → atomic swap.
//! Cancellation paths: cancel_trade (either party) + on_disconnect (lib.rs).
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::economy::{grant_currency, spend_currency, wallet_balance};
use crate::guards::{escrowed_item_qty, log_reject, reject_if_in_battle};
use crate::inventory::{consume_one, grant_item};
use crate::marshal::{now_ms, pub_from_monster};
use crate::schema::{battle, inventory, monster, monster_pub, player, trade_offer, TradeOffer};
use game_core::{
    build_swap_plan, make_monster_card, validate_proposal, LiveMonsterOwner, MonsterCard,
    ProposalSide, TradeItem, TradeSide, TradeStatus,
};
use spacetimedb::{Identity, ReducerContext, Table};

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
        if initiator_currency > bal {
            let e = "insufficient currency for trade offer".to_string();
            log_reject("propose_trade", me, &e);
            return Err(e);
        }
    }
    if counterparty_currency > 0 {
        let cp_bal = wallet_balance(ctx, counterparty);
        if counterparty_currency > cp_bal {
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
        if item.qty > count {
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

    ctx.db.trade_offer().insert(TradeOffer {
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

    Ok(())
}

/// Counterparty responds to a Pending offer.
///
/// - `accepted = false` → row deleted (escrow released, no assets moved, TR-13).
/// - `accepted = true` → status → ConfirmedByCounterparty (TR-14).
#[spacetimedb::reducer]
pub fn respond_trade(ctx: &ReducerContext, trade_id: u64, accepted: bool) -> Result<(), String> {
    let me = ctx.sender;

    let Some(offer) = ctx.db.trade_offer().trade_id().find(trade_id) else {
        return Err("trade offer not found".to_string());
    };
    if offer.counterparty != me {
        let e = "not the counterparty".to_string();
        log_reject("respond_trade", me, &e);
        return Err(e);
    }
    if offer.status != TradeStatus::Pending {
        let e = "offer is not in Pending state".to_string();
        log_reject("respond_trade", me, &e);
        return Err(e);
    }

    if !accepted {
        // Rejection: delete the row → guard released, no assets move (TR-13).
        ctx.db.trade_offer().trade_id().delete(trade_id);
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
/// Re-reads all live rows, verifies ownership still matches the offer, then
/// executes the ownership/item/currency transfers in one transaction and deletes
/// the offer row (TR-15/TR-16, ADR-0106 D3).
#[spacetimedb::reducer]
pub fn confirm_trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String> {
    let me = ctx.sender;

    let Some(offer) = ctx.db.trade_offer().trade_id().find(trade_id) else {
        return Err("trade offer not found".to_string());
    };
    if offer.initiator != me {
        let e = "not the initiator".to_string();
        log_reject("confirm_trade", me, &e);
        return Err(e);
    }
    if offer.status != TradeStatus::ConfirmedByCounterparty {
        let e = "offer is not in ConfirmedByCounterparty state".to_string();
        log_reject("confirm_trade", me, &e);
        return Err(e);
    }

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
    }
}

#[cfg(test)]
#[path = "trading_tests.rs"]
mod trading_tests;
