//! `trading_session` — the trade swap machinery: display-card snapshots, the
//! trade-time trainer-bond reset, the netted receiver-stack construction the
//! headroom check reads, and the atomic apply of a game-core `SwapPlan`.
//!
//! No reducers live here. `trading::propose_trade` snapshots cards and
//! `trading::confirm_trade` nets the receiver stacks and applies the plan,
//! passing `PARTY_SLOT_NONE` as every transferred monster's destination, so a
//! traded monster arrives in Storage.

use crate::economy::{grant_currency, spend_currency};
use crate::guards::log_reject;
use crate::inventory::{consume_one, grant_item};
use crate::marshal::pub_from_monster;
use crate::schema::{inventory, monster, monster_pub, Monster};
use game_core::raising::rules::{reset_bond_on_trade, TrainerBond};
use game_core::{
    make_monster_card, ApplyStep, ItemStack, MonsterCard, SwapPlan, TradeItem, TradeSide,
};
use spacetimedb::{Identity, ReducerContext};

/// Trade-time bond reset — the imperative half of game-core's
/// `reset_bond_on_trade` (decision "Trading resets the bond, not the monster"):
/// copy the seven Trust / Quality-Time columns into a `TrainerBond`, run the
/// rule, copy them back. The struct literal and the destructure both name every
/// field (no `..`), so a bond field added in game-core is a compile error here
/// until the row copies it; no other column of `m` is named, so this cannot
/// touch level, genes, xp or essence. Called from `apply_swap`'s transfer
/// loop only — never from the guest-claim re-key
/// (`monster_mgmt::rekey_monsters`), which is the SAME trainer under a new
/// identity.
fn reset_trainer_bond(m: &mut Monster) {
    let mut bond = TrainerBond {
        trust_favorable_count: m.trust_favorable_count,
        trust_unfavorable_count: m.trust_unfavorable_count,
        trust_favorable_battle_day_epoch: m.trust_favorable_battle_day_epoch,
        quality_time_ticks_total: m.quality_time_ticks_total,
        quality_time_accum_ms: m.quality_time_accum_ms,
        quality_time_window_ms: m.quality_time_window_ms,
        quality_time_window_start_ms: m.quality_time_window_start_ms,
    };
    reset_bond_on_trade(&mut bond);
    let TrainerBond {
        trust_favorable_count,
        trust_unfavorable_count,
        trust_favorable_battle_day_epoch,
        quality_time_ticks_total,
        quality_time_accum_ms,
        quality_time_window_ms,
        quality_time_window_start_ms,
    } = bond;
    m.trust_favorable_count = trust_favorable_count;
    m.trust_unfavorable_count = trust_unfavorable_count;
    m.trust_favorable_battle_day_epoch = trust_favorable_battle_day_epoch;
    m.quality_time_ticks_total = quality_time_ticks_total;
    m.quality_time_accum_ms = quality_time_accum_ms;
    m.quality_time_window_ms = quality_time_window_ms;
    m.quality_time_window_start_ms = quality_time_window_start_ms;
}

/// Build display-only `MonsterCard` snapshots from the given monster IDs.
/// Rejects if any ID is not found or not owned by `expected_owner`.
pub(crate) fn snapshot_cards(
    ctx: &ReducerContext,
    monster_ids: &[u64],
    expected_owner: Identity,
    reducer: &str,
) -> Result<Vec<MonsterCard>, String> {
    let me = ctx.sender();
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

/// The receiver's post-debit stack for every item in `receiving`, in `receiving`
/// order: its live inventory count minus the qty of the same `item_id` it is
/// simultaneously `sending` (saturating at 0), so the headroom check sees the
/// effective count rather than the raw one. Without the netting a symmetric
/// same-item swap (give 15 of X, receive 20 of X while holding 9990) falsely
/// rejects: 9990+20>9999 but net 9990-15+20=9995 is fine.
pub(crate) fn netted_receiver_stacks(
    ctx: &ReducerContext,
    receiver: Identity,
    receiving: &[TradeItem],
    sending: &[TradeItem],
) -> Vec<ItemStack> {
    receiving
        .iter()
        .map(|ti| {
            let raw_count = ctx
                .db
                .inventory()
                .owner_identity()
                .filter(receiver)
                .find(|r| r.item_id == ti.item_id)
                .map(|r| r.count)
                .unwrap_or(0);
            let sending_qty = sending
                .iter()
                .find(|si| si.item_id == ti.item_id)
                .map(|si| si.qty)
                .unwrap_or(0);
            ItemStack {
                item_id: ti.item_id,
                current_count: raw_count.saturating_sub(sending_qty),
            }
        })
        .collect()
}

/// Apply a `SwapPlan` between `initiator` and `counterparty`: every monster
/// transfer first (new owner, `dest_slot(monster_id)` as its party slot, bond
/// reset), then the item and currency steps in the debits-before-credits order
/// of `SwapPlan::ordered_steps()`. Any `Err` aborts the caller's transaction,
/// so a partial apply never commits.
pub(crate) fn apply_swap(
    ctx: &ReducerContext,
    plan: &SwapPlan,
    initiator: Identity,
    counterparty: Identity,
    dest_slot: impl Fn(u64) -> u8,
) -> Result<(), String> {
    // Apply monster transfers (dual-write monster + monster_pub, set party_slot to the
    // destination slot, reset the trainer bond).
    for xfer in &plan.monster_transfers {
        let new_owner = if xfer.new_owner_idx == TradeSide::Counterparty {
            counterparty
        } else {
            initiator
        };

        let mut m = ctx
            .db
            .monster()
            .monster_id()
            .find(xfer.monster_id)
            .ok_or_else(|| format!("monster {} gone during apply", xfer.monster_id))?;
        m.owner_identity = new_owner;
        let slot = dest_slot(xfer.monster_id);
        m.party_slot = slot;
        // The monster changes trainer: its Trust / Quality-Time bond returns to the
        // fresh-monster baseline BEFORE the projection below, so `monster_pub`'s
        // derived tiers re-derive from the reset counters.
        reset_trainer_bond(&mut m);
        // Copy-forward tier: read the existing monster_pub row;
        // a missing row fails loud (same convention as the monster read above).
        let existing_pub = ctx
            .db
            .monster_pub()
            .monster_id()
            .find(xfer.monster_id)
            .ok_or_else(|| format!("monster_pub {} gone during apply", xfer.monster_id))?;
        let mut mp = pub_from_monster(&m, existing_pub.tier);
        mp.owner_identity = new_owner;
        mp.party_slot = slot;
        ctx.db.monster().monster_id().update(m);
        ctx.db.monster_pub().monster_id().update(mp);
    }

    // Apply item + currency transfers in the debits-before-credits order published
    // by game-core: ALL debits land before ANY credit, so a
    // same-item bilateral swap near a cap credits into an already-debited stack —
    // the netted headroom check above is exact and no clamping grant ever engages
    // (reject-not-clamp). Debit arms read from_initiator (sender); credit
    // arms read to_initiator (receiver) — game-core inverted at emission, so there
    // is NO inversion here.
    for step in plan.ordered_steps() {
        match step {
            ApplyStep::ItemDebit {
                from_initiator,
                item_id,
                qty,
            } => {
                let from = if from_initiator {
                    initiator
                } else {
                    counterparty
                };
                // consume_one returns Err if insufficient — the whole transaction rolls back.
                for _ in 0..qty {
                    consume_one(ctx, from, item_id)?;
                }
            }
            ApplyStep::CurrencyDebit {
                from_initiator,
                amount,
            } => {
                let from = if from_initiator {
                    initiator
                } else {
                    counterparty
                };
                // spend_currency returns Err if insufficient (broke-sender rejection
                // site) — the whole transaction rolls back.
                spend_currency(ctx, from, amount)?;
            }
            ApplyStep::ItemCredit {
                to_initiator,
                item_id,
                qty,
            } => {
                let to = if to_initiator {
                    initiator
                } else {
                    counterparty
                };
                grant_item(ctx, to, item_id, qty);
            }
            ApplyStep::CurrencyCredit {
                to_initiator,
                amount,
            } => {
                let to = if to_initiator {
                    initiator
                } else {
                    counterparty
                };
                grant_currency(ctx, to, amount);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
#[path = "trading_session_tests.rs"]
mod trading_session_tests;
