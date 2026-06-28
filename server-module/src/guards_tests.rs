//! `guards` domain-submodule tests (M8.9c — test relocation, ADR-0056).
//!
//! Extracted verbatim from the former inline `#[cfg(test)] mod tests` in
//! `guards.rs`; every assertion, fixture, and helper is unchanged. Declared
//! from `guards.rs` as `#[path = "guards_tests.rs"] mod guards_tests;`, so
//! `super` still resolves to `guards` exactly as the inline module did.

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
