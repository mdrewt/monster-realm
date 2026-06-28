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
pub(crate) fn authorize_move(ctx: &ReducerContext, reducer: &str, seq: u64) -> Result<Character, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_rejects_bad() {
        assert!(validate_name("  ").is_err());
        assert!(validate_name(&"x".repeat(25)).is_err());
        assert_eq!(validate_name("  Ash ").as_deref(), Ok("Ash"));
    }

    /// The party-slot sentinel does not collide with any valid slot.
    #[test]
    fn party_slot_sentinel_outside_valid_range() {
        for slot in 0..MAX_PARTY_SIZE {
            assert_ne!(
                slot, PARTY_SLOT_NONE,
                "sentinel collides with valid slot {slot}"
            );
        }
    }

    /// §3-criterion-2: check_party_size(0) must be Err — an empty party is
    /// invalid; start_battle with zero monsters must be rejected.
    /// Kills: an impl that uses `n > MAX_PARTY_SIZE` only (misses the lower
    /// bound; `1..=MAX_PARTY_SIZE` is the valid range).
    #[test]
    fn party_size_cap_rejects_empty() {
        assert!(
            check_party_size(0).is_err(),
            "check_party_size(0) must be Err (empty party is not valid; range is 1..=MAX_PARTY_SIZE)"
        );
    }

    /// §3-criterion-2: check_party_size(1) must be Ok — minimum valid party.
    /// Kills: an impl that rejects any n < 2 (fencepost).
    #[test]
    fn party_size_cap_accepts_minimum() {
        assert!(
            check_party_size(1).is_ok(),
            "check_party_size(1) must be Ok (minimum valid party of 1)"
        );
    }

    /// §3-criterion-2: check_party_size(MAX_PARTY_SIZE) must be Ok — the
    /// maximum is inclusive.
    /// Kills: an impl that uses `>= MAX_PARTY_SIZE` instead of `> MAX_PARTY_SIZE`
    /// (off-by-one that rejects a full but legal party of 6).
    #[test]
    fn party_size_cap_accepts_max() {
        assert!(
            check_party_size(MAX_PARTY_SIZE as usize).is_ok(),
            "check_party_size(MAX_PARTY_SIZE) must be Ok (max is inclusive, not exclusive)"
        );
    }

    /// §3-criterion-2: check_party_size(MAX_PARTY_SIZE + 1) must be Err —
    /// one over the cap is rejected.
    /// Kills: a clamp-not-reject impl that silently truncates to 6 and returns Ok.
    #[test]
    fn party_size_cap_rejects_oversized() {
        assert!(
            check_party_size(MAX_PARTY_SIZE as usize + 1).is_err(),
            "check_party_size(MAX_PARTY_SIZE + 1) must be Err (oversized party must be rejected, not clamped)"
        );
    }

    /// §3-criterion-2: check_party_size(100) must be Err — far over the cap.
    /// Kills: an impl that only rejects n exactly equal to MAX_PARTY_SIZE+1
    /// rather than all n > MAX_PARTY_SIZE.
    #[test]
    fn party_size_cap_rejects_large() {
        assert!(
            check_party_size(100).is_err(),
            "check_party_size(100) must be Err (any n > MAX_PARTY_SIZE is rejected)"
        );
    }

    /// §3-criterion-3: equal lengths must be Ok — the normal post-battle path.
    /// Kills: an impl that always returns Err.
    #[test]
    fn team_coupling_accepts_equal_lengths() {
        assert!(
            check_team_coupling(3, 3).is_ok(),
            "check_team_coupling(3, 3) must be Ok (lengths match)"
        );
    }

    /// §3-criterion-3: (1, 1) must be Ok — minimal valid single-monster battle.
    /// Kills: a "both >= 3" mutation that only accepts larger counts, and an
    /// impl that has an off-by-one requiring lengths > 1.
    #[test]
    fn team_coupling_accepts_minimal_valid() {
        assert!(
            check_team_coupling(1, 1).is_ok(),
            "check_team_coupling(1, 1) must be Ok (single monster on each side)"
        );
    }

    /// §3-criterion-3: (6, 6) must be Ok — full party, all coupled.
    /// Kills: an impl that only accepts small counts.
    #[test]
    fn team_coupling_accepts_max_party_equal() {
        assert!(
            check_team_coupling(6, 6).is_ok(),
            "check_team_coupling(6, 6) must be Ok (full party with matching ids)"
        );
    }

    /// §3-criterion-3: team_len > ids_len must be Err — the team has MORE
    /// monsters than recorded ids, so indexed access would panic.
    /// Kills: an impl that only checks the other direction, or uses unchecked
    ///        indexing (team[i] where i >= ids.len() would panic).
    #[test]
    fn team_coupling_rejects_length_mismatch_team_longer() {
        assert!(
            check_team_coupling(3, 2).is_err(),
            "check_team_coupling(3, 2) must be Err (team has 3 members but only 2 ids — panic path)"
        );
    }

    /// §3-criterion-3: team_len < ids_len must be Err — the ids list has MORE
    /// entries than actual team members, indicating a consistency bug.
    /// Kills: an impl that silently ignores trailing ids (wrong; an invariant
    ///        violation must surface as an Err, not a silent truncation).
    #[test]
    fn team_coupling_rejects_length_mismatch_ids_longer() {
        assert!(
            check_team_coupling(0, 1).is_err(),
            "check_team_coupling(0, 1) must be Err (0 team members but 1 id — invariant violation)"
        );
    }

    /// §3-criterion-2 (boxed): slot 0 is a valid party position; must be Ok.
    /// Kills: an impl that rejects slot 0 (confuses the first slot with empty).
    #[test]
    fn check_monster_in_party_accepts_first_slot() {
        assert!(
            check_monster_in_party(0).is_ok(),
            "check_monster_in_party(0) must be Ok (slot 0 is a valid party position)"
        );
    }

    /// §3-criterion-2 (boxed): the last valid party slot (MAX_PARTY_SIZE - 1)
    /// must be Ok.
    /// Kills: an impl that rejects any slot >= MAX_PARTY_SIZE - 1.
    #[test]
    fn check_monster_in_party_accepts_last_valid_slot() {
        assert!(
            check_monster_in_party(MAX_PARTY_SIZE - 1).is_ok(),
            "check_monster_in_party(MAX_PARTY_SIZE - 1) must be Ok (last valid party slot)"
        );
    }

    /// §3-criterion-2 (boxed): PARTY_SLOT_NONE (255) signals a boxed monster
    /// and must be Err — start_battle must reject boxed monsters.
    /// Kills: an impl that accepts all u8 values including the sentinel; an
    ///        impl that only rejects values > MAX_PARTY_SIZE (missing the exact
    ///        sentinel check); an impl that returns Ok(()) unconditionally.
    #[test]
    fn check_monster_in_party_rejects_party_slot_none() {
        assert!(
            check_monster_in_party(PARTY_SLOT_NONE).is_err(),
            "check_monster_in_party(PARTY_SLOT_NONE) must be Err (255 = boxed; must be rejected)"
        );
    }
}
