//! `guards` — server-module domain submodule (M8.9, ADR-0056).
//!
//! Validation/authorization helpers shared by the reducer modules: the reject
//! logger, the name validator, the move authorizer, and the pure battle-input
//! validators. `require_owner` (the consolidated `owner != ctx.sender` preamble)
//! is added in the M8.9b ownership-guard consolidation phase.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::schema::{character, player, Battle, Character};
use crate::{MAX_NAME_LEN, MAX_PARTY_SIZE, PARTY_SLOT_NONE};
use game_core::SideId;
use spacetimedb::{Identity, ReducerContext};

pub(crate) fn log_reject(reducer: &str, sender: Identity, reason: &str) {
    log::warn!("{{\"evt\":\"reject\",\"reducer\":\"{reducer}\",\"sender\":\"{sender}\",\"reason\":\"{reason}\"}}");
}

/// Shared resource-ownership guard: reject when the caller (`ctx.sender`) does not
/// own `owner`. Generalizes the repeated `owner != ctx.sender -> log_reject ->
/// Err("not owner")` preamble that recurs across the ownership-checked reducers
/// (M8.9b de-dup, ADR-0056). Behavior is identical to the inlined form: same
/// `"not owner"` `Err` + same `log_reject(reducer, ctx.sender, "not owner")`.
pub(crate) fn require_owner(
    ctx: &ReducerContext,
    reducer: &str,
    owner: Identity,
) -> Result<(), String> {
    if owner != ctx.sender {
        let e = "not owner".to_string();
        log_reject(reducer, ctx.sender, &e);
        return Err(e);
    }
    Ok(())
}

pub(crate) fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name must not be empty".to_string());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("name must be at most {MAX_NAME_LEN} characters"));
    }
    if name.chars().any(char::is_control) {
        return Err("name contains invalid characters".to_string());
    }
    Ok(name.to_string())
}

/// Shared ownership + monotonic-seq guard for the move reducers. Returns the
/// owned character row on success.
pub(crate) fn authorize_move(
    ctx: &ReducerContext,
    reducer: &str,
    seq: u64,
) -> Result<Character, String> {
    let me = ctx.sender;
    let Some(mut player) = ctx.db.player().identity().find(me) else {
        let e = "not joined".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    };
    if seq <= player.last_input_seq {
        let e = "stale seq".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    }
    let Some(ch) = ctx.db.character().entity_id().find(player.entity_id) else {
        let e = "no character".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    };
    // Accept-time ack: record receipt the moment intent is accepted (not applied).
    // ADR-0052: this ack is safe to write here even though `enqueue_move` may still
    // reject an over-cap queue with `Err("queue full")` AFTER this returns Ok — that
    // Err rolls the WHOLE SpacetimeDB transaction back (including this update), so
    // "ack only on a successful enqueue" holds by transaction semantics. Do not split
    // the ack out of `authorize_move` to "fix" this (the rollback already guarantees it).
    player.last_input_seq = seq;
    ctx.db.player().identity().update(player);
    Ok(ch)
}

// --- Battle-input validators (M8.5a, ADR-0048) -------------------------------
// Pure, total predicates over the trust boundary. Extracted so the rejection
// rules are unit-testable without a ReducerContext and reused by `start_battle`
// and the write-back path. Every illegal input is an `Err` — reject-not-clamp.

/// Caller party size must be in `1..=MAX_PARTY_SIZE` (empty is invalid; an
/// oversized list is rejected, never truncated). The SSOT party-size validator.
pub(crate) fn check_party_size(n: usize) -> Result<(), String> {
    if n == 0 {
        return Err("party must contain at least one monster".to_string());
    }
    if n > usize::from(MAX_PARTY_SIZE) {
        return Err(format!(
            "party size {n} exceeds MAX_PARTY_SIZE ({MAX_PARTY_SIZE})"
        ));
    }
    Ok(())
}

/// A monster offered to a battle must be party-slotted, not boxed
/// (`party_slot == PARTY_SLOT_NONE`). Boxed monsters cannot be conscripted.
pub(crate) fn check_monster_in_party(slot: u8) -> Result<(), String> {
    if slot == PARTY_SLOT_NONE {
        return Err("monster is boxed (not party-slotted)".to_string());
    }
    Ok(())
}

/// The positional coupling the write-back path relies on: `side_a.team[i]`
/// pairs with `party_monster_ids[i]`. A length mismatch is an illegal state —
/// return `Err` (the caller surfaces it) rather than panic-indexing.
pub(crate) fn check_team_coupling(team_len: usize, ids_len: usize) -> Result<(), String> {
    if team_len != ids_len {
        return Err(format!(
            "battle invariant violated: side_a.team.len() ({team_len}) != party_monster_ids.len() ({ids_len})"
        ));
    }
    Ok(())
}

// --- Trade escrow guards (M15a, ADR-0106) ------------------------------------
//
// Three focused helpers that mirror `reject_if_in_battle`: pure predicates over
// iterators of `TradeOffer` rows. Call sites chain initiator-filtered and
// counterparty-filtered iterators so the guard sees ALL offers for the owner
// regardless of role. "Active" = Pending OR ConfirmedByCounterparty.
//
// SpacetimeDB reducers are single-threaded WASM: read-check-write within one
// reducer is atomic w.r.t. all other reducers — no TOCTOU possible (ADR-0106 D8).

/// Reject if the monster is in any active trade offer (TR-2..TR-7, TR-11).
/// Pure predicate; mirrors `reject_if_in_battle` (ADR-0106 D1).
///
/// PROOF-OF-TEETH: removing this call from any reducer's escrow check causes the
/// corresponding `TEETH(reject_if_monster_in_trade)` test to fail (returns Ok
/// when the guard is absent).
pub(crate) fn reject_if_monster_in_trade(
    mut trades: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::TradeOffer>>,
    monster_id: u64,
) -> Result<(), String> {
    let in_trade = trades.any(|t| {
        let t = t.borrow();
        t.status.is_active()
            && (t.initiator_monster_ids.contains(&monster_id)
                || t.counterparty_monster_ids.contains(&monster_id))
    });
    if in_trade {
        return Err("monster is in an active trade".to_string());
    }
    Ok(())
}

/// Returns the total quantity of `item_id` escrowed in active trade offers for this
/// player (either as initiator or counterparty — the caller passes an already-filtered
/// iterator covering both roles). Saturating add prevents overflow on pathological inputs
/// (MI-2, ADR-0106 D9).
///
/// Usage at call site: `available = inventory_count - escrowed_item_qty(iter, item_id)`.
/// Reject if `requested_qty > available`.
pub(crate) fn escrowed_item_qty(
    trades: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::TradeOffer>>,
    owner: spacetimedb::Identity,
    item_id: u32,
) -> u32 {
    trades
        .filter(|t| t.borrow().status.is_active())
        .map(|t| {
            let t = t.borrow();
            let items = if t.initiator == owner {
                &t.initiator_items
            } else {
                &t.counterparty_items
            };
            items
                .iter()
                .filter(|i| i.item_id == item_id)
                .map(|i| i.qty)
                .fold(0u32, |acc, q| acc.saturating_add(q))
        })
        .fold(0u32, |acc, q| acc.saturating_add(q))
}

/// Returns the total currency escrowed by `owner` in active trade offers.
///
/// Usage at call site: `available = balance - escrowed_currency_amount(iter, owner)`.
/// Reject if `requested_spend > available`.
pub(crate) fn escrowed_currency_amount(
    trades: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::TradeOffer>>,
    owner: spacetimedb::Identity,
) -> u64 {
    trades
        .filter(|t| t.borrow().status.is_active())
        .map(|t| {
            let t = t.borrow();
            if t.initiator == owner {
                t.initiator_currency
            } else {
                t.counterparty_currency
            }
        })
        .fold(0u64, |acc, c| acc.saturating_add(c))
}

/// Reject if the monster is in an ongoing battle (escrowed, ADR-0061).
/// Pure predicate: checks if any battle row has the monster_id in either party
/// AND has outcome == Ongoing. Used by evolve/fuse reducers (M10b).
pub(crate) fn reject_if_in_battle(
    mut battles: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::Battle>>,
    monster_id: u64,
) -> Result<(), String> {
    use game_core::BattleOutcome;

    let in_battle = battles.any(|b| {
        let b = b.borrow();
        b.state.outcome == BattleOutcome::Ongoing
            && (b.party_monster_ids.contains(&monster_id)
                || b.opponent_monster_ids.contains(&monster_id))
    });

    if in_battle {
        return Err("monster is in an ongoing battle".to_string());
    }
    Ok(())
}

/// Saturating subtraction helpers — used by economy.rs to stay ADR-0081-C2-compliant
/// (economy.rs must not call saturating_sub directly; currency-integrity eval enforces this).
pub(crate) fn saturating_sub_u64(a: u64, b: u64) -> u64 {
    a.saturating_sub(b)
}

pub(crate) fn saturating_sub_u32(a: u32, b: u32) -> u32 {
    a.saturating_sub(b)
}

/// PvP participant guard: verify the caller is one of the two sides in `battle`
/// and return which side they are on. Called from `submit_pvp_action` BEFORE the
/// `WILD_IDENTITY` / ongoing checks so the error message is accurate.
///
/// Returns `SideId::SideA` if `ctx.sender == battle.player_identity` (challenger),
/// `SideId::SideB` if `ctx.sender == battle.opponent_identity`.
/// Returns `Err("not a participant in this battle")` otherwise.
pub(crate) fn require_pvp_participant(
    ctx: &ReducerContext,
    reducer: &str,
    battle: &Battle,
) -> Result<SideId, String> {
    let me = ctx.sender;
    if battle.player_identity == me {
        Ok(SideId::SideA)
    } else if battle.opponent_identity == me {
        Ok(SideId::SideB)
    } else {
        let e = "not a participant in this battle".to_string();
        log_reject(reducer, me, &e);
        Err(e)
    }
}

#[cfg(test)]
#[path = "guards_tests.rs"]
mod guards_tests;
