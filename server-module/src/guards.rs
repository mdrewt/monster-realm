//! `guards` — server-module domain submodule (M8.9, ADR-0056).
//!
//! Validation/authorization helpers shared by the reducer modules: the reject
//! logger, the name validator, the move authorizer, and the pure battle-input
//! validators. `require_owner` (the consolidated `owner != ctx.sender` preamble)
//! is added in the M8.9b ownership-guard consolidation phase.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::schema::{character, player, Character};
use crate::{MAX_NAME_LEN, MAX_PARTY_SIZE, PARTY_SLOT_NONE};
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

/// Reject if the monster is in an ongoing battle (escrowed, ADR-0061).
/// Pure predicate: checks if any battle row has the monster_id in either party
/// AND has outcome == Ongoing. Used by evolve/fuse reducers (M10b).
pub(crate) fn reject_if_in_battle(
    battles: impl Iterator<Item = &'_ crate::schema::Battle>,
    monster_id: u64,
) -> Result<(), String> {
    use game_core::BattleOutcome;

    let in_battle = battles.any(|b| {
        b.state.outcome == BattleOutcome::Ongoing
            && (b.party_monster_ids_a.contains(&monster_id)
                || b.party_monster_ids_b.contains(&monster_id))
    });

    if in_battle {
        return Err("monster is in an ongoing battle".to_string());
    }
    Ok(())
}

#[cfg(test)]
#[path = "guards_tests.rs"]
mod guards_tests;
