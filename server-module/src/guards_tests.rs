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

// ---------------------------------------------------------------------------
// M10b Slice 2 — `reject_if_in_battle` guard (3 unit tests)
//
// The function under test (must be added to guards.rs):
//   pub(crate) fn reject_if_in_battle(
//       battles: impl Iterator<Item = &Battle>,
//       monster_id: u64,
//   ) -> Result<(), String>
//
// Spec (M10 §3): WHEN `evolve` or `fuse` is called for a monster that is part
// of an ongoing battle THE SYSTEM SHALL reject with Err("monster is in an
// ongoing battle"). A completed battle (outcome != Ongoing) must NOT block.
//
// RED state: compile-RED until `reject_if_in_battle` is added to guards.rs and
// re-exported through `use super::*;`. That is intentional — tests ARE the contract.
//
// PROOF-OF-TEETH per test:
//   - test_reject_if_in_battle_accepts_when_no_battle: kills "always Err" impl.
//   - test_reject_if_in_battle_rejects_when_in_ongoing: kills "always Ok" impl /
//     impl that ignores the BattleOutcome check.
//   - test_reject_if_in_battle_accepts_when_battle_won: kills an impl that
//     rejects based solely on battle existence without checking the outcome.
// ---------------------------------------------------------------------------

use crate::schema::Battle;
use game_core::{BattleOutcome, BattleSide, BattleState};

/// Build a minimal `Battle` row with the given outcome and `party_monster_ids`.
fn make_test_battle(battle_id: u64, outcome: BattleOutcome, party_monster_ids: Vec<u64>) -> Battle {
    let dummy = game_core::BattleMonster {
        species_id: 1,
        affinity: game_core::Affinity::Fire,
        level: 10,
        current_hp: 50,
        max_hp: 50,
        stats: game_core::StatBlock {
            hp: 50,
            attack: 40,
            defense: 40,
            speed: 40,
            sp_attack: 40,
            sp_defense: 40,
        },
        known_skill_ids: vec![],
        status: None,
    };
    Battle {
        battle_id,
        player_identity: spacetimedb::Identity::from_byte_array([1u8; 32]),
        opponent_identity: spacetimedb::Identity::from_byte_array([0u8; 32]),
        state: BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![dummy.clone()],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![dummy],
            },
            outcome,
            turn_number: 1,
            weather: None,
        },
        party_monster_ids,
        opponent_monster_ids: vec![],
        created_at_ms: 0,
    }
}

/// Slice 2 test 1: monster not in any battle → Ok (the guard must not reject).
/// PROOF-OF-TEETH: kills an impl that always returns Err (vacuous always-reject).
/// Without a correct happy-path test, an implementer could satisfy
/// `test_reject_if_in_battle_rejects_when_in_ongoing` with `return Err(...)` unconditionally.
#[test]
fn test_reject_if_in_battle_accepts_when_no_battle() {
    // No battles in the iterator — the monster is free.
    let battles: Vec<Battle> = vec![];
    let monster_id = 42u64;

    let result = reject_if_in_battle(battles.iter(), monster_id);

    assert!(
        result.is_ok(),
        "TEETH: monster not in any battle must return Ok; \
         kills: an always-Err impl that would block every evolve/fuse call; \
         got Err: {:?}",
        result.err()
    );
}

/// Slice 2 test 2: monster is in a battle with outcome=Ongoing → Err containing
/// "monster is in an ongoing battle".
/// PROOF-OF-TEETH: kills an impl that returns Ok unconditionally (missing the guard);
/// this is the core correctness requirement from M10 spec §3.
#[test]
fn test_reject_if_in_battle_rejects_when_in_ongoing() {
    let monster_id = 42u64;
    // Battle is ONGOING and includes monster 42 in its party.
    let battles = [make_test_battle(
        1,
        BattleOutcome::Ongoing,
        vec![monster_id],
    )];

    let result = reject_if_in_battle(battles.iter(), monster_id);

    assert!(
        result.is_err(),
        "TEETH: monster in an ongoing battle must return Err; \
         kills: an always-Ok impl (missing the reject_if_in_battle guard entirely); \
         this is the load-bearing safety check that prevents evolving/fusing an \
         escrowed monster mid-combat"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("ongoing battle"),
        "error message must contain \"ongoing battle\"; got: {:?}",
        msg
    );
}

/// Slice 2 test 3: monster is in a battle with outcome=SideAWins (battle is over) → Ok.
/// PROOF-OF-TEETH: kills an impl that rejects any monster present in ANY battle row,
/// without checking whether the battle is still ongoing. A completed battle must
/// never block evolution or fusion.
#[test]
fn test_reject_if_in_battle_accepts_when_battle_won() {
    let monster_id = 42u64;
    // Battle references monster 42 in its party BUT outcome is SideAWins (completed).
    let battles = [make_test_battle(
        1,
        BattleOutcome::SideAWins,
        vec![monster_id],
    )];

    let result = reject_if_in_battle(battles.iter(), monster_id);

    assert!(
        result.is_ok(),
        "TEETH: monster in a COMPLETED battle (SideAWins) must return Ok; \
         kills: an impl that rejects based solely on battle-row existence without \
         checking outcome (would permanently lock the monster after its first battle); \
         got Err: {:?}",
        result.err()
    );
}

/// validate_name accepts a string of exactly MAX_NAME_LEN characters.
/// Mutant guards.rs:42 replaces `>` with `>=` in `name.chars().count() > MAX_NAME_LEN`,
/// which would incorrectly reject a name of exactly MAX_NAME_LEN length.
/// The spec: names UP TO MAX_NAME_LEN characters are valid (> is the correct operator).
/// KILLS: guards.rs:42:29 (> → >= in the name-length guard).
#[test]
fn validate_name_accepts_exactly_max_name_len_chars() {
    // MAX_NAME_LEN = 24. A 24-char name is within the limit (> not >=).
    let name = "a".repeat(MAX_NAME_LEN);
    assert!(
        validate_name(&name).is_ok(),
        "validate_name({MAX_NAME_LEN}-char string) must be Ok; \
         the length check uses `> MAX_NAME_LEN` (strictly greater than), \
         so exactly MAX_NAME_LEN chars is allowed. \
         Mutant replaces `>` with `>=`, making this return Err (off-by-one rejection). \
         Got Err: {:?}",
        validate_name(&name).err()
    );
    // Verify the one-over boundary is still Err (regression guard).
    let too_long = "a".repeat(MAX_NAME_LEN + 1);
    assert!(
        validate_name(&too_long).is_err(),
        "validate_name({}-char string) must be Err (one over MAX_NAME_LEN)",
        MAX_NAME_LEN + 1
    );
}

// ===========================================================================
// m17a (ADR-0119): is_ranked_pvp unit tests (RL-6, D4)
//
// `is_ranked_pvp(&Battle) -> bool` is defined as:
//   player_identity != opponent_identity && opponent_identity != WILD_IDENTITY
//
// Home: guards.rs (the battle-authz guard family SSOT — require_owner,
// require_pvp_participant live here; ADR-0119 D4).
//
// Three cases:
//   1. Distinct players, non-wild opponent → true  (ranked PvP battle)
//   2. Self-battle (player == opponent)    → false (practice/friendly battle)
//   3. Wild battle (opponent == WILD)      → false (PvE wild encounter)
//
// ALL THREE tests are COMPILE-RED until `is_ranked_pvp` is added to guards.rs
// and becomes visible via `use super::*;` at the top of this file.
// ===========================================================================

/// Build a minimal Battle fixture for is_ranked_pvp tests.
/// Reuses the `make_test_battle` constructor already in this module and
/// injects custom player_identity / opponent_identity.
fn make_pvp_test_battle(
    player_identity: spacetimedb::Identity,
    opponent_identity: spacetimedb::Identity,
) -> Battle {
    // Reuse the existing helper with an Ongoing outcome and empty party.
    let mut b = make_test_battle(999, game_core::BattleOutcome::Ongoing, vec![]);
    b.player_identity = player_identity;
    b.opponent_identity = opponent_identity;
    b
}

/// m17a-RL-6 / D4: distinct non-wild players → is_ranked_pvp returns true.
///
/// This is the core ranked-PvP classification: two different real players.
///
/// Kills: an impl that always returns false (missing the feature), or one that
/// uses `==` instead of `!=` (inverts both conditions), or one that only checks
/// one of the two conditions.
/// COMPILE-RED: is_ranked_pvp does not yet exist in guards.rs.
#[test]
fn m17a_is_ranked_pvp_distinct_players_non_wild_is_true() {
    let player = spacetimedb::Identity::from_byte_array([1u8; 32]);
    // Opponent: different from player AND different from WILD (all-zeros).
    let opponent = spacetimedb::Identity::from_byte_array([2u8; 32]);

    let battle = make_pvp_test_battle(player, opponent);

    assert!(
        is_ranked_pvp(&battle),
        "m17a-RL-6 FAIL: is_ranked_pvp must return true when player_identity ({:?}) \
         != opponent_identity ({:?}) AND opponent_identity != WILD_IDENTITY. \
         This is the ranked PvP classification (ADR-0119 D4). \
         Kills: always-false impl, inverted conditions, or single-condition check.",
        player,
        opponent
    );
}

/// m17a-RL-6 / D4: self-battle (player == opponent) → is_ranked_pvp returns false.
///
/// Practice / sandbox battles use the caller's own identity as opponent.
/// They must never rate — RL-6 "friendly battles shall never rate".
///
/// Kills: an impl that returns true for self-battles (would charge ratings for
/// practice grinding), or one that only checks the wild condition.
/// COMPILE-RED: is_ranked_pvp does not yet exist in guards.rs.
#[test]
fn m17a_is_ranked_pvp_self_battle_is_false() {
    let player = spacetimedb::Identity::from_byte_array([3u8; 32]);
    // opponent == player: practice/sandbox self-battle.
    let battle = make_pvp_test_battle(player, player);

    assert!(
        !is_ranked_pvp(&battle),
        "m17a-RL-6 FAIL: is_ranked_pvp must return false for a self-battle \
         (player_identity == opponent_identity — practice/sandbox). \
         Friendly battles must never rate (RL-6, ADR-0119 D4). \
         Kills: an impl that only checks opponent != WILD_IDENTITY and misses the \
         player == opponent short-circuit."
    );
}

/// m17a-RL-6 / D4: wild battle (opponent == WILD_IDENTITY) → is_ranked_pvp returns false.
///
/// Wild encounters use the zero-byte sentinel as opponent_identity (ADR-0045).
/// They must never rate — RL-6 "friendly battles shall never rate".
///
/// Kills: an impl that returns true for wild battles (would charge ratings for
/// every wild encounter), or one that only checks player != opponent.
/// COMPILE-RED: is_ranked_pvp does not yet exist in guards.rs.
#[test]
fn m17a_is_ranked_pvp_wild_battle_is_false() {
    let player = spacetimedb::Identity::from_byte_array([4u8; 32]);
    // WILD_IDENTITY = all-zero bytes (crate constant).
    let wild = crate::WILD_IDENTITY;

    let battle = make_pvp_test_battle(player, wild);

    assert!(
        !is_ranked_pvp(&battle),
        "m17a-RL-6 FAIL: is_ranked_pvp must return false when opponent_identity is \
         WILD_IDENTITY (zero-byte sentinel for wild encounters, ADR-0045). \
         Wild battles must never rate (RL-6, ADR-0119 D4). \
         Kills: an impl that only checks player != opponent and misses the wild check."
    );
}
