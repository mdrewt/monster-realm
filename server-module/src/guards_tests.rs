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

/// #27c: allowlist (letters/numbers/spaces on the NFC form) rejects the
/// spoofing classes the old control-char blocklist missed.
/// Kills: an impl that only rejects `char::is_control` (bidi overrides and
/// zero-width chars are Cf, NOT control — they passed the old check).
#[test]
fn validate_name_rejects_spoofing_characters() {
    // bidi override (RLO) — display-order spoof
    assert!(validate_name("Ash\u{202E}hsA").is_err());
    // bidi isolate
    assert!(validate_name("Ash\u{2066}x").is_err());
    // zero-width space / zero-width joiner — invisible-name impersonation
    assert!(validate_name("A\u{200B}sh").is_err());
    assert!(validate_name("A\u{200D}sh").is_err());
    // punctuation is outside the letters/numbers/spaces allowlist
    assert!(validate_name("Ash_K").is_err());
    // interior spaces stay allowed
    assert_eq!(validate_name("Ash Ketchum").as_deref(), Ok("Ash Ketchum"));
}

/// #27c: NFC — decomposed input canonicalizes to the composed spelling, so
/// two visually-identical names cannot coexist as distinct byte strings.
/// Kills: an impl that skips normalization (decomposed `e``\u{301}` would
/// either be stored raw or rejected, breaking the equality below).
#[test]
fn validate_name_nfc_normalizes() {
    let decomposed = "Pok\u{0065}\u{0301}mon"; // e + COMBINING ACUTE ACCENT
    let composed = "Pok\u{00E9}mon"; // precomposed é
    assert_eq!(validate_name(decomposed).as_deref(), Ok(composed));
    assert_eq!(validate_name(composed).as_deref(), Ok(composed));
    // non-Latin letters remain allowed (is_alphanumeric is Unicode-aware)
    assert!(validate_name("\u{30B5}\u{30C8}\u{30B7}").is_ok()); // katakana
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
/// never block evolution.
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

// ===========================================================================
// m17.5a (ADR-0122): is_in_ongoing_battle_either_role unit tests
//
// `is_in_ongoing_battle_either_role(as_player, as_opponent) -> bool` is the
// PURE CORE of the both-role ongoing-battle guard (ADR-0122 D1).  The thin
// ctx wrapper `is_in_ongoing_battle(ctx, identity)` delegates to this core
// and is pinned by source-scan only (no branch logic to mutate).
//
// Signature under test (to be added to guards.rs):
//   pub(crate) fn is_in_ongoing_battle_either_role(
//       as_player:   impl Iterator<Item = impl std::borrow::Borrow<crate::schema::Battle>>,
//       as_opponent: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::Battle>>,
//   ) -> bool
//
// TDD marker: all seven tests below were authored COMPILE-RED before
// `is_in_ongoing_battle_either_role` existed in guards.rs (m17a precedent,
// guards_tests.rs:394 block); implementation has since landed and all are green.
//
// Fixture discipline (plan-review N-1 / red-team F6, BINDING):
//   `make_test_battle`'s hardcoded `opponent_identity = [0u8;32]` IS WILD_IDENTITY.
//   The opponent-arm tests (`either_role_opponent_ongoing_true` and
//   `either_role_opponent_wild_sentinel_false`) therefore MUST NOT reuse that
//   helper unmodified for the battle carrying the non-WILD opponent: they call
//   `make_pvp_test_battle` (already defined above at line ~401) with explicit
//   non-WILD identities.  Both opponent-arm tests also pass an EMPTY player-arm
//   iterator so the opponent arm is the ONLY possible signal source — a broken
//   opponent arm cannot be masked by a player-arm hit.
//
// Mutation bite mapping (for ADR-0118 §4):
//   - Deleting the opponent arm from the core  →  flips `either_role_opponent_ongoing_true`
//     and `laundering_two_ongoing_rows` RED (unit gate bites).
//   - Deleting the `!= WILD_IDENTITY` clause   →  flips
//     `either_role_opponent_wild_sentinel_false` RED.
//   - Removing the call from any reducer       →  flips its eval criterion RED.
// ===========================================================================

/// m17.5a-1: empty / empty → false.
/// Kills: an always-true implementation.
#[test]
fn either_role_no_battle_false() {
    let result = is_in_ongoing_battle_either_role(
        std::iter::empty::<Battle>(),
        std::iter::empty::<Battle>(),
    );
    assert!(
        !result,
        "m17.5a FAIL: is_in_ongoing_battle_either_role(empty, empty) must be false; \
         kills: an always-true impl (would return true with no battles)"
    );
}

/// m17.5a-2: player arm has one Ongoing battle → true.
/// The opponent arm is empty so only the player arm can produce the result.
/// Kills: an impl that drops the player arm (returns false unconditionally or
/// only checks the opponent arm).
#[test]
fn either_role_player_ongoing_true() {
    // make_test_battle uses player_identity=[1;32], opponent_identity=[0;32]=WILD.
    // The player arm receives this Ongoing row; the opponent arm is empty.
    let ongoing = make_test_battle(1, game_core::BattleOutcome::Ongoing, vec![]);
    let result =
        is_in_ongoing_battle_either_role(std::iter::once(ongoing), std::iter::empty::<Battle>());
    assert!(
        result,
        "m17.5a FAIL: player arm has Ongoing battle → must be true; \
         kills: dropped-player-arm impl (would return false)"
    );
}

/// m17.5a-3: EMPTY player arm + opponent arm has Ongoing with non-WILD opponent → true.
/// This is the core bite: the opponent arm is the ONLY possible source of the result.
/// A broken opponent arm (arm dropped) cannot be masked by the player arm (empty here).
/// Non-WILD opponent: player=[1;32], opponent=[2;32].
/// Kills: an impl that drops the opponent arm entirely (the central gap this slice closes).
#[test]
fn either_role_opponent_ongoing_true() {
    // Fixture: real side-A identity [1;32], real side-B identity [2;32] (non-WILD).
    // player_identity=[1;32] means the PLAYER-ROLE (side A) is [1;32].
    // We supply this as the opponent-arm battle with opponent_identity=[2;32].
    // We want to test: identity [2;32] is the *opponent* → they appear only in
    // the opponent arm. So the battle has player_identity=[1;32] and
    // opponent_identity=[2;32]; the caller querying for [2;32] gets this row
    // ONLY from the opponent arm.
    let player_id = spacetimedb::Identity::from_byte_array([1u8; 32]);
    let opponent_id = spacetimedb::Identity::from_byte_array([2u8; 32]);
    // make_pvp_test_battle creates an Ongoing battle with the given player/opponent.
    let pvp_battle = make_pvp_test_battle(player_id, opponent_id);

    // CRITICAL: player arm is EMPTY — the opponent arm is the only signal source.
    let result =
        is_in_ongoing_battle_either_role(std::iter::empty::<Battle>(), std::iter::once(pvp_battle));
    assert!(
        result,
        "m17.5a FAIL: empty player arm + opponent arm has Ongoing(non-WILD) → must be true; \
         kills: impl that drops the opponent arm (the ADR-0122 core gap)"
    );
}

/// m17.5a-4: EMPTY player arm + opponent arm row has opponent_identity == WILD_IDENTITY → false.
/// The WILD_IDENTITY refinement MUST be preserved: a wild/practice battle's sentinel
/// opponent must NOT match a caller who merely happens to be querying the opponent arm.
/// Note: the wild battle's REAL side-A owner is still caught by the player arm (separate arm),
/// but here the player arm is empty and the opponent-arm row has opponent == WILD_IDENTITY.
/// Kills: an impl that drops the `!= WILD_IDENTITY` refinement (would return true).
#[test]
fn either_role_opponent_wild_sentinel_false() {
    // A battle whose opponent_identity IS WILD_IDENTITY — using make_test_battle's
    // built-in [0;32] opponent (which IS WILD_IDENTITY).
    let wild_battle = make_test_battle(1, game_core::BattleOutcome::Ongoing, vec![]);
    // Verify the fixture's opponent IS WILD_IDENTITY (documents intent and guards regression).
    assert_eq!(
        wild_battle.opponent_identity,
        crate::WILD_IDENTITY,
        "fixture invariant: make_test_battle's opponent_identity must be WILD_IDENTITY ([0;32])"
    );

    // CRITICAL: player arm is EMPTY — only the opponent arm supplies rows.
    let result = is_in_ongoing_battle_either_role(
        std::iter::empty::<Battle>(),
        std::iter::once(wild_battle),
    );
    assert!(
        !result,
        "m17.5a FAIL: empty player arm + opponent-arm row with opponent==WILD_IDENTITY → must be false; \
         the WILD_IDENTITY refinement (ADR-0122 D1) must be preserved so wild battles \
         do not spuriously match a caller via the opponent arm. \
         Kills: impl that drops the != WILD_IDENTITY clause (would return true)"
    );
}

/// m17.5a-5: both arms non-Ongoing → false.
/// Battle exists in both arms but it is completed (SideAWins) — must not block.
/// Kills: an impl that checks row presence without checking the outcome (would return true).
#[test]
fn either_role_won_battle_false() {
    let player_id = spacetimedb::Identity::from_byte_array([1u8; 32]);
    let opponent_id = spacetimedb::Identity::from_byte_array([2u8; 32]);
    // Completed battle (SideAWins) — not Ongoing.
    let mut won_battle = make_pvp_test_battle(player_id, opponent_id);
    won_battle.state.outcome = game_core::BattleOutcome::SideAWins;

    let result = is_in_ongoing_battle_either_role(
        std::iter::once(won_battle.clone()),
        std::iter::once(won_battle),
    );
    assert!(
        !result,
        "m17.5a FAIL: both arms have a completed (SideAWins) battle → must be false; \
         kills: impl that checks battle presence without checking outcome (would return true)"
    );
}

/// m17.5a-6: caller is BOTH player_identity AND opponent_identity of one Ongoing
/// self/practice battle (same row in both iterators) → true.
///
/// Documentation fixture: BOTH arms fire here because caller != WILD_IDENTITY.
/// This is the practice/self-battle shape (ADR-0045 self-battle sentinel is the
/// caller's own identity, NOT WILD_IDENTITY — so the opponent arm's
/// `!= WILD_IDENTITY` check passes and the opponent arm contributes too).
/// No unique mutant claim: row 2 (`either_role_player_ongoing_true`) already kills
/// the dropped-player-arm mutant; this test documents the short-circuit behavior.
#[test]
fn either_role_practice_self_both_arms() {
    // Self-battle: player_identity == opponent_identity == [3;32] (non-WILD).
    let self_id = spacetimedb::Identity::from_byte_array([3u8; 32]);
    let self_battle = make_pvp_test_battle(self_id, self_id);

    // Both arms receive this same Ongoing self-battle row.
    // The player arm fires (Ongoing) and short-circuits via `||`; the opponent
    // arm is NOT evaluated for this fixture.  Documents: a practice self-battle
    // is caught by the player arm alone; the opponent arm need not fire.
    let result = is_in_ongoing_battle_either_role(
        std::iter::once(self_battle.clone()),
        std::iter::once(self_battle),
    );
    assert!(
        result,
        "m17.5a FAIL: self/practice Ongoing battle in both arms → must be true; \
         documents: both arms fire because the caller's identity is not WILD_IDENTITY; \
         no unique mutant claim (either_role_player_ongoing_true kills that mutant)"
    );
}

/// m17.5a-7: laundering exploit closed — two scenarios:
///
/// SCENARIO A (two_row_both_arms): caller is side-A of an Ongoing wild battle
/// (player arm) AND side-B (opponent, non-WILD) of a distinct Ongoing PvP battle
/// (opponent arm) → true.  This is the laundering precondition: before the fix,
/// the side-B PvP check was missing, so the wild battle's guard only checked the
/// player arm.
///
/// SCENARIO B (pvp_row_only): empty player arm, opponent arm has only the PvP
/// row → true.  This is the exploit's core: the accepting player (side-B) can
/// open a second battle because the player-only guard misses them.  The opponent
/// arm alone is sufficient to block this.
///
/// Kills: the whole ADR-0122 gap (an impl that only checks the player arm would
/// return false for scenario B, failing this test).
#[test]
fn laundering_two_ongoing_rows() {
    // pvp_side_a=[4;32] is side-A of the PvP battle (player_identity).
    // subject=[5;32] is the subject under test: they are side-B (opponent_identity)
    // of the PvP battle, and also side-A (player_identity) of their own wild battle.
    let pvp_side_a = spacetimedb::Identity::from_byte_array([4u8; 32]);
    let subject = spacetimedb::Identity::from_byte_array([5u8; 32]);

    // Wild battle: subject [5;32] is player_identity (side A of their own wild battle).
    // Use make_pvp_test_battle with WILD_IDENTITY as opponent.
    let wild_battle = make_pvp_test_battle(subject, crate::WILD_IDENTITY);
    // PvP battle: subject=[5;32] is opponent_identity (side B); pvp_side_a is side-A.
    let pvp_battle = make_pvp_test_battle(pvp_side_a, subject);

    // SCENARIO A: two rows, one per arm.
    // Player arm: wild_battle (subject as player_identity — their own wild battle).
    // Opponent arm: pvp_battle (subject as opponent_identity — their PvP side-B slot).
    // Kills: an impl missing BOTH arms; scenario B (empty player arm) independently
    // kills the dropped-opponent-arm mutant, and either_role_player_ongoing_true kills
    // the dropped-player-arm mutant — scenario A's contribution is documenting the
    // combined two-row laundering precondition.
    let result_a = is_in_ongoing_battle_either_role(
        std::iter::once(wild_battle),
        std::iter::once(pvp_battle.clone()),
    );
    assert!(
        result_a,
        "m17.5a FAIL (scenario A): subject as side-A wild + side-B PvP in respective arms → must be true; \
         kills: any impl that misses BOTH arms simultaneously"
    );

    // SCENARIO B: empty player arm, only the PvP row in the opponent arm.
    // This is the exploit's core: the accepting player (subject) appears ONLY as
    // opponent_identity — the pre-fix player-only guard missed them entirely.
    // Kills: an impl that only checks the player arm (dropped-opponent-arm mutant).
    let result_b =
        is_in_ongoing_battle_either_role(std::iter::empty::<Battle>(), std::iter::once(pvp_battle));
    assert!(
        result_b,
        "m17.5a FAIL (scenario B — the exploit precondition executed): \
         empty player arm + PvP row in opponent arm (subject as side-B, non-WILD) → must be true; \
         kills: an impl that only checks the player arm (the pre-fix behavior — would return false \
         because the player arm is empty, missing the PvP side-B slot entirely)"
    );
}

// ---------------------------------------------------------------------------
// Comment- AND string-stripping helper — a LOCAL copy on purpose.
//
// Byte-identical to the copy in `movement_tests.rs` (the sibling test modules
// `pvp_tests.rs:64`, `trading_tests.rs:457`, `taming_tests.rs:42` and
// `economy_tests.rs:936` each keep their own comment-only variants). A shared
// `scan_helpers` module would need a `lib.rs` edit, and `lib.rs` is explicitly
// OUTSIDE this slice's touch set — the same call ADR-0166 recorded as residual
// R5. Duplicated deliberately, not by accident.
//
// Removed bytes are replaced with spaces so byte offsets are preserved (the
// squash step drops them again anyway).
//
// STRING LITERALS ARE BLANKED TOO, for the reason documented at length in
// `movement_tests.rs`: a red-team satisfied a whole file of needles with a dead
// `let _decoy = r#"<needle text>"#;`. Here it matters for the opposite polarity —
// this file's fence asserts an ABSENCE (`authorize_move` contains no battle
// guard), so blanking literals removes false ALARMS (a log message naming the
// predicate) while leaving every executable call visible. The two files must
// agree on what "the source says" or one could be green while the other is red
// about the same bytes.
//
// Handled in one sequential pass: block comments, line comments, `"…"` (with
// `\` escapes), `b"…"`, raw strings `r"…"` / `r#"…"#` / `r##"…"##` and their `br`
// forms, and char / byte-char literals (consumed ATOMICALLY — `guards.rs:58` has
// a real one, `c == ' '`, and a char literal holding a double quote would
// otherwise open a phantom string and blank the rest of the file, which is also
// why `DQUOTE` below is a number). `assert_stripper_preconditions` fails loudly
// on the two constructs this does NOT handle.
// ---------------------------------------------------------------------------

/// The ASCII double-quote byte, spelled as a NUMBER on purpose.
///
/// Writing the obvious byte-char literal would put a bare, unpaired double-quote
/// CHARACTER into this file's source. The evals concatenate every `.rs` file in
/// this crate and run `stripRustStrings` over the result — a stripper with no
/// char-literal lexer — so that quote reads as opening a string literal and
/// inverts string/code polarity for everything after it. This file sorts before
/// `lib.rs`, and the measured cost of the obvious spelling was exactly that:
/// `pub fn init(` was blanked and the zone-warp eval's W5 check failed with
/// "init not found". Every double-quote in this file is now part of a balanced
/// Rust string literal; keep it that way.
const DQUOTE: u8 = 0x22;

// ===========================================================================
// 11r-g (ADR-0170 D5) — `json_escape` at the `log_reject` choke point
//
// EARS criteria covered by this section:
//
//   G-1  `json_escape(s)` SHALL escape the two JSON structural characters —
//        backslash and double quote — in ONE forward pass over `s.chars()`, so
//        that a backslash immediately followed by a double quote is escaped
//        exactly once each (sequential `str::replace` passes double-escape the
//        backslashes an earlier pass inserted).
//   G-2  `json_escape` SHALL escape every character below 0x20 (the three short
//        forms for 0x0A/0x0D/0x09, every other one as a four-digit lowercase
//        backslash-u escape) and SHALL pass 0x20, 0x7F and every non-ASCII
//        scalar value through unchanged.
//   G-3  (properties) the output SHALL contain no raw character below 0x20 for
//        ANY input, and input containing no backslash, no double quote and no
//        control character SHALL round-trip byte-identical.
//   G-4  `log_reject` SHALL pass BOTH `reducer` and `reason` through
//        `json_escape` before interpolating them into its hand-built JSON
//        (~127 call sites exist; several forward a `&str` parameter, so
//        "the reducer name is always a literal" is an unenforced convention).
//   G-5  the three production files this slice touches SHALL contain no
//        char-literal double quote and SHALL keep their block-comment markers
//        balanced — the repo's source-scan substrate (eval W-pre plus every
//        per-file stripper helper in this crate) mis-lexes otherwise, and the
//        blast radius is a FALSE RED in an unrelated file's gate.
//
// RED STATE.
//   * G-1, G-2, G-3 are COMPILE-RED: `json_escape` does not exist in
//     `guards.rs`, so `use super::*;` cannot resolve it and the crate does not
//     build. This is the established house precedent for a new pure seam
//     (`content_cache_tests.rs:14-25`, the M10b block above).
//   * G-4 is ASSERTION-RED once the symbol exists: `log_reject`'s body at HEAD
//     interpolates `reducer` and `reason` raw.
//   * G-5 is a GREEN-AT-HEAD fence. It is deliberately a SEPARATE `#[test]`
//     from every red one (the split reason `movement_tests.rs:917-921` records:
//     folded into a failing test it could never be observed passing).
//
// SCAN SUBSTRATE RULES honoured by everything below (violating them breaks
// OTHER slices' gates, not this one): every needle naming a production symbol
// is assembled from fragments, no raw double-quote CHARACTER literal is written
// anywhere in this file, and no block-comment opener/closer is ever spelled
// contiguously — the two markers used by the G-5 scan are built from parts,
// exactly like `assert_stripper_preconditions`'s own `close_marker` above.
// ===========================================================================

use proptest::prelude::*;

/// The ASCII backslash byte, spelled as a NUMBER for the same reason `DQUOTE`
/// above is: this file must contain no bare delimiter characters that a
/// text-level stripper could mis-lex.
const BACKSLASH: u8 = 0x5C;

/// The ASCII backslash as a one-character `String`.
fn backslash() -> String {
    char::from(BACKSLASH).to_string()
}

/// The ASCII double quote as a one-character `String`.
fn double_quote() -> String {
    char::from(DQUOTE).to_string()
}

/// The expected two-character short-form escape (backslash + `letter`).
fn short_escape(letter: &str) -> String {
    [backslash().as_str(), letter].concat()
}

/// The expected six-character escape (backslash + `u00` + two lowercase digits).
fn u_escape(hex: &str) -> String {
    [backslash().as_str(), "u00", hex].concat()
}

/// One table row: `json_escape(input)` must equal `expected`, exactly.
///
/// `label` names the row so a failure points at the case rather than at the
/// (deliberately unprintable) bytes; each row's mutant is named in the doc
/// comment of the test that drives it.
fn assert_escapes(label: &str, input: &str, expected: &str) {
    let got = json_escape(input);
    assert_eq!(
        got, expected,
        "TEETH (11r-g G-1/G-2, ADR-0170 D5) row `{label}`: json_escape({input:?}) \
         returned {got:?} but must return {expected:?}. `json_escape` is the choke \
         point that keeps `log_reject`'s hand-built JSON well-formed for adversarial \
         or parser-generated reason strings; a row that fails here means some log \
         line is emitted malformed and silently dropped by the log ingest. See this \
         test's doc comment for the specific wrong implementation the row kills."
    );
}

/// **G-1** — backslash and double quote are escaped, in ONE forward pass.
///
/// The rows and the wrong implementations they kill:
///   * `empty` / `plain` — kills an impl that mangles or truncates ordinary text
///     (e.g. one that returns `String::new()` unconditionally).
///   * `bs` (a lone backslash becomes two) — kills the classic escape-the-quote-
///     only impl, which leaves the backslash raw so the JSON reader treats the
///     NEXT character as an escape introducer.
///   * `dq` (a lone double quote becomes backslash + quote) — kills an impl that
///     only escapes backslashes, and kills the QUOTE-FIRST sequential
///     `s.replace(quote, ..).replace(backslash, ..)` impl outright: its second
///     pass doubles the backslash its first pass just inserted, leaving a RAW
///     quote that terminates the JSON string early.
///   * `bs_then_dq` — THE ADJACENCY ATTACK named in ADR-0170 D5. Input is a
///     backslash immediately followed by a quote; the only correct output is
///     three backslashes then a quote. A quote-first sequential impl emits FOUR
///     backslashes then a quote (it re-escapes its own insertions), so a table
///     that only tested each character in isolation would miss it.
///   * `dq_then_bs`, `bs_bs`, `embedded`, `sentence` — the same adjacency
///     property in the other order, doubled, and in the middle of real text;
///     they kill an impl that special-cases only the first or last character.
///
/// COMPILE-RED: `json_escape` does not exist in `guards.rs` yet.
#[test]
fn json_escape_escapes_backslash_and_quote_in_one_pass() {
    let b = backslash();
    let q = double_quote();

    let bb = [b.as_str(), b.as_str()].concat();
    let bbbb = [bb.as_str(), bb.as_str()].concat();
    let esc_q = [b.as_str(), q.as_str()].concat();
    let bs_then_dq = [b.as_str(), q.as_str()].concat();
    let bs_then_dq_out = [bb.as_str(), esc_q.as_str()].concat();
    let dq_then_bs = [q.as_str(), b.as_str()].concat();
    let dq_then_bs_out = [esc_q.as_str(), bb.as_str()].concat();
    let embedded = ["a", bs_then_dq.as_str(), "b"].concat();
    let embedded_out = ["a", bs_then_dq_out.as_str(), "b"].concat();
    let sentence = ["he said ", q.as_str(), "hi", q.as_str()].concat();
    let sentence_out = ["he said ", esc_q.as_str(), "hi", esc_q.as_str()].concat();

    assert_escapes("empty", "", "");
    assert_escapes("plain", "not owner", "not owner");
    assert_escapes("bs", &b, &bb);
    assert_escapes("dq", &q, &esc_q);
    assert_escapes("bs_then_dq", &bs_then_dq, &bs_then_dq_out);
    assert_escapes("dq_then_bs", &dq_then_bs, &dq_then_bs_out);
    assert_escapes("bs_bs", &bb, &bbbb);
    assert_escapes("embedded", &embedded, &embedded_out);
    assert_escapes("sentence", &sentence, &sentence_out);
}

/// **G-2** — the control-character boundary, and everything that must NOT change.
///
/// The rows and the wrong implementations they kill:
///   * 0x00, 0x08, 0x0B, 0x0C, 0x1F become six-character lowercase escapes.
///     These kill (a) an impl that emits only the three short forms and passes
///     every other control character through RAW — a raw NUL or VT inside a JSON
///     string is a hard parse error; (b) an impl that adds the JSON backspace
///     (0x08) and form-feed (0x0C) short forms, which ADR-0170 D5 deliberately
///     does NOT sanction — the contract is exactly three short forms and a
///     four-digit escape for everything else; (c) an impl that emits UPPERCASE
///     hex or fewer than four digits, both of which are invalid or ambiguous
///     JSON escapes.
///   * 0x09, 0x0A, 0x0D become the `t` / `n` / `r` short forms. These kill an
///     impl that four-digit-encodes ALL control characters (contract violation
///     in the other direction) and an impl that maps the wrong letter to the
///     wrong byte.
///   * 0x20 (space), 0x7F (DEL), U+00E9 and U+1F600 pass through unchanged.
///     0x20 kills an off-by-one `<= 0x20` boundary that would mangle every space
///     in every reason string. 0x7F kills an `is_ascii_control()`-based impl:
///     DEL *is* an ASCII control character but is NOT below 0x20, and it is
///     legal raw JSON. The two non-ASCII rows kill an over-eager impl that
///     escapes all non-ASCII — Rust `char` iteration cannot produce a lone
///     surrogate, so pass-through is valid JSON by construction (ADR-0170 D5),
///     and re-encoding would also mangle the astral-plane row.
///
/// COMPILE-RED: `json_escape` does not exist in `guards.rs` yet.
#[test]
fn json_escape_control_char_boundary_table() {
    let cases = [
        (0x00u32, u_escape("00")),
        (0x08u32, u_escape("08")),
        (0x09u32, short_escape("t")),
        (0x0Au32, short_escape("n")),
        (0x0Bu32, u_escape("0b")),
        (0x0Cu32, u_escape("0c")),
        (0x0Du32, short_escape("r")),
        (0x1Fu32, u_escape("1f")),
        (0x20u32, " ".to_string()),
        (0x7Fu32, char::from(0x7Fu8).to_string()),
        (0x00E9u32, "\u{00E9}".to_string()),
        (0x1F600u32, "\u{1F600}".to_string()),
    ];

    for (codepoint, expected) in cases {
        let c = char::from_u32(codepoint).expect("G-2 table codepoint must be a valid char");
        let input = c.to_string();
        let label = format!("U+{codepoint:04X}");
        assert_escapes(&label, &input, &expected);
    }
}

/// Arbitrary `String`s, control characters included — the G-3(a) generator.
fn arb_any_string() -> impl Strategy<Value = String> {
    prop::collection::vec(any::<char>(), 0..24).prop_map(|v| v.into_iter().collect::<String>())
}

/// Arbitrary `String`s with every backslash, double quote and control character
/// REMOVED (filtered, never rejected — so the generator has no rejection budget
/// to exhaust) — the G-3(b) generator.
fn arb_plain_string() -> impl Strategy<Value = String> {
    prop::collection::vec(any::<char>(), 0..24).prop_map(|v| {
        v.into_iter()
            .filter(|c| u32::from(*c) >= 0x20)
            .filter(|c| *c != char::from(BACKSLASH) && *c != char::from(DQUOTE))
            .collect::<String>()
    })
}

proptest! {
    /// **G-3(a)** — for ANY input, the output contains no raw character below 0x20.
    ///
    /// The whole-of-domain version of the G-2 table: the table names the eight
    /// interesting control bytes, this covers all thirty-two in every position
    /// and combination. Kills an impl that handles the control characters it was
    /// shown a test for and passes the rest through raw, and an impl whose
    /// control-character arm is unreachable because an earlier arm matched first.
    /// A raw control byte inside a JSON string is a hard parse error, so the log
    /// line is dropped — exactly the observability hole ADR-0170 D5 closes.
    ///
    /// No hand-rolled JSON unescaper oracle: this is a one-directional structural
    /// property, so there is no second implementation to get wrong.
    ///
    /// COMPILE-RED: `json_escape` does not exist in `guards.rs` yet.
    #[test]
    fn json_escape_output_has_no_raw_control_chars(s in arb_any_string()) {
        let out = json_escape(&s);
        let offender = out.chars().find(|c| u32::from(*c) < 0x20);
        prop_assert!(
            offender.is_none(),
            "TEETH (11r-g G-3a, ADR-0170 D5): json_escape emitted a RAW control \
             character U+{:04X} for input {:?} (output {:?}). Every character below \
             0x20 must leave as an escape sequence; a raw one makes the surrounding \
             hand-built JSON log line unparseable and the line is dropped.",
            offender.map_or(0u32, u32::from),
            s,
            out
        );
    }

    /// **G-3(b)** — text with no backslash, no double quote and no control
    /// character round-trips byte-identical.
    ///
    /// Kills an over-eager impl: one that escapes the JSON-optional forward
    /// slash, one that escapes all non-ASCII, one that escapes 0x7F, and one
    /// that normalises or re-orders anything. It is the exact complement of
    /// G-3(a): together they pin "escape precisely the characters that need
    /// escaping, and nothing else". Without this half, `json_escape` could
    /// satisfy G-3(a) by escaping every character in the input.
    ///
    /// COMPILE-RED: `json_escape` does not exist in `guards.rs` yet.
    #[test]
    fn json_escape_is_identity_on_plain_text(s in arb_plain_string()) {
        let out = json_escape(&s);
        prop_assert!(
            out == s,
            "TEETH (11r-g G-3b, ADR-0170 D5): json_escape changed input {:?} into \
             {:?}, but input containing no backslash, no double quote and no \
             character below 0x20 must pass through UNCHANGED. Escaping more than \
             the contract says corrupts every reason string a human has to read and \
             breaks the multi-byte scalar values the pass-through rule preserves.",
            s,
            out
        );
    }
}

// ===========================================================================
// m22-s5 (PRV1-9 / PRV1-10, spec para 4.7, ADR-0225) — the gameplay deletion
// gate: BEHAVIOURAL half.
//
// These two tests EXECUTE the pure decision seam rather than reading the
// source, so they close the residue every scan in the sibling block records:
// the scans prove the wrapper delegates and is called in the right places,
// these prove the thing being delegated to actually decides the right way and
// says something a client can act on.
//
// COMPILE-RED at HEAD: neither the reason constant nor the pure gate exists in
// `guards.rs`, so `use super::*;` cannot resolve them and the crate does not
// build. That is the established house precedent for a new pure seam
// (`content_cache_tests.rs:14-25`, and the 11r-g `json_escape` block above).
// Apply this block ONLY after the scan block, and expect the whole crate's
// test build to fail until the implementation lands.
// ===========================================================================

/// **PRV1-9 (truth table)** — the pure gate is a total, two-row decision.
///
/// `deletion_gate` mirrors `pvp.rs`'s `ranked_account_gate` (pvp.rs:104): a
/// ctx-free, I/O-free predicate-to-`Result` adapter, which is what makes it
/// exhaustively testable in-crate when reducer bodies are not (ADR-0156 P7).
///
/// WHAT EACH ROW KILLS:
///   * `false` -> `Ok` — kills the inverted branch (`if !rejected`), which
///     would refuse EVERY caller of all three gated reducers: a total outage
///     of trading and PvP challenges, shipped green by every source scan in
///     the sibling block because the delegation text is unchanged.
///   * `true` -> `Err` — kills the always-`Ok` stub, the shape a hollowed
///     implementation naturally lands on. Matched against the CONSTANT rather
///     than a re-typed literal: a test that re-types the reason cannot see a
///     reason that was reworded on one side only, and would silently start
///     asserting against text no client ever receives.
#[test]
fn m22s5_deletion_gate_truth_table() {
    assert_eq!(
        deletion_gate(false),
        Ok(()),
        "m22-s5 PRV1-9 FAIL (truth table, not-deleting row): an account that is NOT inside \
         the deletion gate must be admitted. An inverted branch here is not a subtle bug: \
         it refuses every caller of all three gated reducers — a total trading and \
         PvP-challenge outage — while every source scan in the sibling block stays green, \
         because the delegation text is byte-identical either way."
    );
    assert_eq!(
        deletion_gate(true),
        Err(REJECT_DELETION_GATED),
        "m22-s5 PRV1-9 FAIL (truth table, deleting row): an account inside the deletion \
         gate must be refused, with the module's single static reason. The `Err` half \
         kills the always-Ok stub a hollowed implementation lands on; comparing against \
         the CONSTANT (not a re-typed literal) is what keeps this test honest if the \
         reason is ever reworded — a re-typed copy would drift silently and start \
         asserting text no client ever receives."
    );
}

// rb76-compile-red-begin
/// **ADR-0246 D2 (behaviour)** — the subject gate answers from the NAMED
/// SUBJECT: it refuses the two deletion-gated states, ADMITS the three others,
/// and consults neither `ctx.sender()` nor the table at large.
///
/// The shipped wrapper runs under the rb-41 native host (`native_host_tests`,
/// ADR-0222 amendment) against real `account` rows through seven calls — five
/// subject states plus two sender-vs-subject controls — with the
/// exact verdict pinned in each. The three admitted states are the positive
/// control, and they are what make the two refused states mean anything.
///
/// SCOPE NOTE: today this matrix overlaps the `begin_encounter` matrix in
/// `battle_tests.rs` almost entirely, because that reducer helper is the seam's
/// ONLY consumer. It is kept as a DECOUPLING FENCE — the wrapper's own truth
/// table, independent of any consumer — so that if a second consumer is ever
/// sanctioned (and the census widened deliberately) the seam still has a
/// consumer-free witness. Do not re-widen the battle-side test to carry this.
///
/// TWO CONTROLS CARRY THE WHOLE POINT OF THIS SLICE, and neither exists in the
/// rb-46 matrix this test is modelled on:
///
///   * A STRANGER'S MID-GRACE ROW IS SEEDED FIRST AND NEVER REMOVED. Without it
///     the table only ever holds the subject's row, so a TABLE-keyed gate —
///     refuse if ANYBODY is deleting — is observationally identical to a
///     subject-keyed one in every state. With it, the three admitted states are
///     reachable only by a gate that keys on the identity it was HANDED.
///   * THE SENDER'S OWN ROW IS DRIVEN INDEPENDENTLY OF THE SUBJECT'S, in both
///     directions. `ctx.sender()` under this host is the all-zero identity, and
///     on the real grass path it is the MODULE identity — never the walker. A
///     wrapper that quietly reads `ctx.sender()` instead of its parameter (the
///     single most plausible copy-paste from the caller-only sibling one screen
///     above it in the same file) would pass a matrix that only ever moves the
///     subject's row: the sender has no row, so it would admit everybody, and
///     the three admitted states would all be green for the wrong reason. The
///     sender-mid-grace-while-subject-Active row makes that wrapper REFUSE an
///     admitted state; the sender-Active-while-subject-mid-grace row makes it
///     ADMIT a refused one. One of the two fires whichever way the mistake is
///     spelled.
///
/// Rows are built with the shipped pure constructors only, so this test can
/// never assemble a state the module itself cannot; `terminal_account`
/// debug-asserts legality, which is why the illegal active-plus-marker shape is
/// not reachable here and is left to `accounts_tests`' truth table (ADR-0236
/// D5). `seed` PUSHES rather than upserting, so each state removes the previous
/// row and asserts that exactly one row went — and because `remove` is
/// `Identity`-keyed, neither the stranger's row nor the sender's affects that
/// count.
///
/// WHY THIS IS SAFE TO EXECUTE AT ALL: the wrapper is READ-ONLY. Every write
/// syscall aborts the process under this host (uncatchable, so `#[should_panic]`
/// cannot be used), and this seam performs a single indexed point read.
///
/// COMPILE-RED AT HEAD: `crate::guards::require_subject_not_deleting` does not
/// exist, so the crate's test build fails to resolve it. Excise this test
/// between its two marker comments to observe the assertion-RED of the five
/// tests that do compile.
///
/// kills:
///   - the dropped gate and any later deletion of it;
///   - INVERTED POLARITY, which no source scan in this slice can see: the
///     `Active` and no-row states would start returning the deletion reject.
///     Inverted, this gate refuses EVERY walker — a total outage of wild
///     encounters — while every text pin in this block stays byte-identical;
///   - A SENDER-KEYED READ (`ctx.sender()` in place of the parameter): the two
///     sender-driven controls above catch it in both spellings;
///   - A TABLE-WIDE OR ANY-ROW-PENDING FAKE: the three admitted states fail
///     while the stranger is mid-grace. (Written as a full-table iteration it
///     aborts the process on the unmodelled scan syscall instead — also a
///     failure, and a louder one.);
///   - a row-EXISTS-keyed fake (`is_some()` in place of the status test): the
///     `Active` state fails;
///   - a latched or memoised answer that never returns to admitting: the final
///     removed-row state fails;
///   - a gate keyed on the mid-grace status alone that ignores the terminal
///     marker: that row still passes today (the marker implies the status on a
///     legal row) — recorded honestly, it is a fail-closed regression fence, not
///     an independent kill.
#[test]
fn rb76_subject_gate_answers_from_the_named_subject() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let sender = ctx.sender();
    let subject = spacetimedb::Identity::from_byte_array([7u8; 32]);
    let stranger = spacetimedb::Identity::from_byte_array([9u8; 32]);

    let call = || crate::guards::require_subject_not_deleting(&ctx, subject);

    let admitted: Result<(), String> = Ok(());
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let subject_active = crate::accounts::new_account_row(subject, String::new(), 0);
    let subject_pending = crate::accounts::requested_deletion(subject_active.clone(), 1);
    let subject_terminal = crate::accounts::terminal_account(subject_pending.clone(), 2);
    let sender_active = crate::accounts::new_account_row(sender, String::new(), 0);
    let sender_pending = crate::accounts::requested_deletion(sender_active.clone(), 1);

    // A mid-grace STRANGER, seeded once and never removed: the account table is
    // never empty of deleting rows, so an any-row-pending gate cannot masquerade
    // as a subject-keyed one in the three admitted states below.
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, String::new(), 0),
        1,
    ));

    // --- State 1: the subject has no account row (a guest) ------------------
    let got = call();
    assert_eq!(
        got,
        admitted,
        "rb-76 ADR-0246 D2 FAIL (admitted, no subject row): the subject gate returned \
         {got:?} for a subject with NO account row, while a STRANGER's row is mid-grace. A \
         walker who never authenticated is not inside the para-4.7 deletion gate and must be \
         admitted; a reject here means the gate answers from the TABLE rather than from the \
         row belonging to the identity it was handed. Indexes the generated code asked the \
         host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 2: the subject's row is Active -------------------------------
    acct.seed(&subject_active);
    let got = call();
    assert_eq!(
        got, admitted,
        "rb-76 ADR-0246 D2 FAIL (admitted, Active subject): the subject gate returned \
         {got:?} for a subject whose account row is `Active` (a stranger's row is \
         mid-grace). This is the ordinary player walking through grass, and refusing them is \
         a TOTAL OUTAGE of wild encounters that every source pin in this slice would report \
         as correctly gated — the call text is byte-identical whichever way the decision \
         runs. It is also what a row-EXISTS-keyed fake produces, what an any-row-pending \
         table scan produces, and what an inverted branch produces."
    );

    // --- Control A: the SENDER is mid-grace while the subject is Active -----
    // `ctx.sender()` is the all-zero identity here and the MODULE identity on the
    // real grass path — never the walker. A wrapper that reads the context sender
    // instead of its parameter is the most plausible copy-paste from the
    // caller-only sibling one screen above it in `guards.rs`, and every state that
    // moves only the SUBJECT's row is blind to it.
    acct.seed(&sender_pending);
    let got = call();
    assert_eq!(
        got, admitted,
        "rb-76 ADR-0246 D2 FAIL (subject-keyed, sender mid-grace): the subject gate returned \
         {got:?} while the SUBJECT's row is `Active` and the CONTEXT SENDER's own row is \
         mid-grace. The gate must answer about the identity it was HANDED. This row is the \
         reason the wrapper takes a subject at all: on the scheduled grass path \
         `ctx.sender()` is the MODULE identity, so a sender-keyed read there asks about an \
         account no player owns — and would refuse, or admit, every walker in the zone \
         together. Nothing in the wrapper's signature can prevent that spelling; only this \
         row can see it."
    );
    assert_eq!(
        acct.remove(sender),
        1,
        "rb-76 fixture: exactly one mid-grace row was seeded for the CONTEXT SENDER and must \
         be removed before the refused states below — `seed` appends rather than upserting, \
         so a miscount would leave two rows for one identity and the unique-index lookup \
         would assert instead of answering. `remove` is Identity-keyed, so the stranger's \
         and the subject's rows are deliberately untouched and must never be counted here."
    );

    // --- State 3: the subject is mid-grace ----------------------------------
    assert_eq!(
        acct.remove(subject),
        1,
        "rb-76 fixture: exactly one `Active` row was seeded for the SUBJECT and must be \
         removed before the mid-grace row is pushed (`seed` appends, it never upserts)."
    );
    acct.seed(&subject_pending);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-76 ADR-0246 D2 FAIL (refused, subject mid-grace): the subject gate returned \
         {got:?} for a subject whose account is inside the deletion grace window; it must \
         return the module's single static deletion reject. THIS IS THE CRITERION: a \
         mid-grace walker must not open a new wild-battle commitment, because the para-4.4 \
         cascade would then have to boot a live battle it never created. The expected value \
         is compared against the CONSTANT, never a re-typed literal, so a reworded reason \
         cannot drift silently into text no client ever receives."
    );

    // --- Control B: the SENDER is Active while the subject is mid-grace -----
    // The mirror image of control A: a sender-keyed read now ADMITS a state that
    // must be refused.
    acct.seed(&sender_active);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-76 ADR-0246 D2 FAIL (subject-keyed, sender Active): the subject gate returned \
         {got:?} while the SUBJECT is mid-grace and the CONTEXT SENDER's own row is \
         `Active`. This is the mirror of the control above and it is the sharper half: a \
         sender-keyed read ADMITS the state that must be refused, so the feature looks \
         present in review, passes every source pin, and gates nothing at all on the path it \
         was written for."
    );
    assert_eq!(
        acct.remove(sender),
        1,
        "rb-76 fixture: exactly one `Active` row was seeded for the CONTEXT SENDER and must \
         be removable; the stranger's and the subject's rows stay."
    );

    // --- State 4: the subject carries the terminal marker -------------------
    assert_eq!(
        acct.remove(subject),
        1,
        "rb-76 fixture: exactly one mid-grace row was seeded for the SUBJECT and must be \
         removed before the terminal row is pushed."
    );
    acct.seed(&subject_terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-76 ADR-0246 D2 FAIL (refused, subject terminal): the subject gate returned \
         {got:?} for a subject whose account carries the M22 terminal marker. An \
         already-erased account must never open a new commitment: its game data is gone, so \
         the encounter would be opened against rows the cascade has already deleted. The \
         pure decision is an explicit disjunction precisely so this state is fail-closed \
         even on the illegal active-plus-marker shape."
    );

    // --- State 5: the subject's row is gone again ---------------------------
    assert_eq!(
        acct.remove(subject),
        1,
        "rb-76 fixture: exactly one terminal row was seeded for the SUBJECT and must be \
         removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, admitted,
        "rb-76 ADR-0246 D2 FAIL (admitted, subject row removed): the subject gate returned \
         {got:?} once the subject's account row was gone again (the stranger's mid-grace row \
         is still there). The verdict must track LIVE rows FOR THE NAMED SUBJECT: an answer \
         that latches on a row it has already seen — a memoised predicate, a cached \
         decision, a process-wide flag — would keep refusing this identity forever, and an \
         any-row-pending answer would refuse it because of somebody else. No state above can \
         distinguish either of those from a correct gate on its own."
    );
}
/// Seed the one `player` row `join_game`'s joined check needs.
///
/// A plain struct literal, the house pattern for `Player` (`rb46_seed_player`,
/// `rb80_seed_player`): unlike `Account` it has no pure constructor to route
/// through and carries no legal-state invariant. The handle is registered
/// against the SAME fixture the account handle comes from — rows live in the
/// host store, not in the handle.
fn rb128_seed_player(fx: &crate::native_host_tests::Fixture, me: spacetimedb::Identity) {
    let players = fx.table::<crate::schema::Player>("player", "identity", |r| r.identity);
    players.seed(&crate::schema::Player {
        identity: me,
        entity_id: 7,
        name: String::new(),
        online: true,
        last_input_seq: 0,
    });
}

/// A mid-grace account row for somebody who is NOT the caller.
///
/// Seeded once per test and never removed, so the account table is never empty
/// of deleting rows. Without it a TABLE-keyed gate — refuse if ANYBODY is
/// deleting — is observationally identical to the caller-keyed one in all five
/// states. `remove` and `find` are `Identity`-keyed, so this row never disturbs
/// the per-state `remove(me) == 1` assertions.
fn rb128_seed_deleting_stranger(
    acct: &crate::native_host_tests::Handle<'_, crate::schema::Account>,
) {
    let stranger = spacetimedb::Identity::from_byte_array([9u8; 32]);
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, String::new(), 0),
        1,
    ));
}

/// The per-state hook for the twelve reducers whose admitted path stops at a
/// READ: nothing was written in any state, so there is nothing to observe.
fn rb128_no_row_oracle(_refused: bool) {}

/// The five-state executed matrix, driven once per class-(iv) reducer so a
/// single dropped gate fails with a message naming which one.
///
/// States, in the rb-80 order: no account row, `Active`, `PendingDeletion`,
/// `PendingDeletion` plus the terminal marker, row removed. A mid-grace
/// STRANGER is seeded once before state 1 and never removed. Rows are built
/// with the shipped pure constructors only, so this can never assemble a state
/// the module itself cannot. `seed` PUSHES rather than upserting, so each
/// transition removes the caller's previous row and asserts exactly one went.
///
/// `ordinary` is the reducer's own first-guard result in the admitted states,
/// pinned EXACTLY, never as any-error: otherwise a regression in that guard
/// (which returns a different error) would masquerade as a pass in all three
/// admitted states and the positive control would go quietly vacuous. The
/// refused states compare against the CONSTANT, never a re-typed literal.
///
/// `after` runs after every state's assertion, with `true` in the two refused
/// states. `dismiss_dialogue` uses it to OBSERVE the reject-before-any-write
/// claim through its registered table handle; every other reducer passes
/// `rb128_no_row_oracle`.
fn rb128_assert_refused_only_while_gated(
    what: &str,
    fx: &crate::native_host_tests::Fixture,
    acct: &crate::native_host_tests::Handle<'_, crate::schema::Account>,
    me: spacetimedb::Identity,
    call: &dyn Fn() -> Result<(), String>,
    ordinary: Result<(), String>,
    after: &dyn Fn(bool),
) {
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let active = crate::accounts::new_account_row(me, String::new(), 0);
    let pending = crate::accounts::requested_deletion(active.clone(), 1);
    let terminal = crate::accounts::terminal_account(pending.clone(), 2);

    rb128_seed_deleting_stranger(acct);

    // --- State 1: no account row for the caller (a guest) -------------------
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-128 E1 FAIL (state 1 of 5, ADMITTED: no account row): `{what}` returned {got:?} for \
         a caller with NO account row, while a STRANGER's row is mid-grace; it must return its \
         own first-guard result, pinned EXACTLY as {ordinary:?}. A deletion reject here is \
         either an INVERTED gate — a total outage of this reducer for every honest player — or \
         a TABLE-keyed fake that refuses because somebody ELSE is deleting. A different error \
         means the reducer's own guard chain moved under this pin; re-derive the positive \
         control from ADR-0273 D2 rather than loosening it. An `Ok` where the ordinary answer is \
         an `Err` is an early return ABOVE the gate — on this host the sender is the all-zero \
         wild identity, so a fixed-sender return fires here. Indexes the generated code asked \
         the host for: {:?}",
        fx.requested_indexes()
    );
    after(false);

    // --- State 2: an Active account row --------------------------------------
    acct.seed(&active);
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-128 E1 FAIL (state 2 of 5, ADMITTED: Active account): `{what}` returned {got:?} for a \
         caller whose account row is `Active` (a stranger's row is mid-grace); it must return \
         exactly {ordinary:?}. This is the ordinary player, and refusing them is a TOTAL OUTAGE \
         of `{what}` that every source pin in this crate would report as correctly gated — the \
         gate statement is byte-identical whichever way the decision runs. It is what an \
         inverted branch, a row-EXISTS-keyed fake and an any-row-pending table scan all produce."
    );
    after(false);

    // --- State 3: mid-grace (PendingDeletion) --------------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-128 fixture ({what}): exactly one `Active` account row was seeded for the CALLER and \
         must be removed before the mid-grace row is pushed — `seed` appends rather than \
         upserting, so a miscount would leave two rows for one identity and the unique-index \
         lookup would assert instead of answering. `remove` is Identity-keyed, so the stranger's \
         row is untouched and never counted here."
    );
    acct.seed(&pending);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-128 E1 FAIL (state 3 of 5, REFUSED: mid-grace): `{what}` returned {got:?} for a caller \
         whose account is `PendingDeletion`; it must return the module's single static deletion \
         reject, compared against the CONSTANT. THIS IS THE RED STATE AT HEAD: `{what}` sat in \
         the ADR-0258 class-(iv) KNOWN-GAP roster and no slice had gated it, so a mid-grace \
         account keeps writing rows the deletion cascade is about to erase and the reducer \
         answers with its ordinary first-guard result. AFTER THE FIX that same ordinary result \
         means the gate is missing, its verdict is discarded (`let _ =`, `.ok()`), it sits BELOW \
         the reducer's first guard (ADR-0273 D2 puts it first, above every lookup), or it is \
         compiled out of this build; the stamp-aware sibling wrapper admits this row too."
    );
    after(true);

    // --- State 4: terminal (PendingDeletion + the marker) -------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-128 fixture ({what}): exactly one `PendingDeletion` account row was seeded for the \
         CALLER and must be removed before the terminal row is pushed (`seed` appends, it never \
         upserts; the stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-128 E1 FAIL (state 4 of 5, REFUSED: terminal): `{what}` returned {got:?} for a caller \
         whose account carries the M22 terminal marker. An already-erased account has no rows \
         left — the cascade deleted them — so a write here recreates what the deletion just \
         removed. The pure decision is an explicit disjunction \
         (`accounts::should_reject_for_deletion`) precisely so this state is fail-closed even on \
         the illegal `Active`-plus-marker shape."
    );
    after(true);

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-128 fixture ({what}): exactly one terminal account row was seeded for the CALLER and \
         must be removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-128 E1 FAIL (state 5 of 5, ADMITTED: row removed): `{what}` returned {got:?} once the \
         caller's account row was gone again (the stranger's mid-grace row is still there); it \
         must return exactly {ordinary:?}. The verdict must track LIVE rows FOR THE CALLER: an \
         answer that latches on a row it has already seen — a memoised predicate, a cached \
         decision, a process-wide flag — keeps refusing this identity forever, and an \
         any-row-pending answer refuses it because of somebody else. No state above can tell \
         either of those from a correct gate on its own."
    );
    after(false);
}

/// **E1 (behaviour)** — `join_game` refuses a deletion-gated caller, admits
/// everybody else, and answers from the CALLER's own row.
///
/// Positive control: `already joined` (movement.rs:52-56). The caller's `player`
/// row is seeded FIRST on purpose: without it every admitted state runs past the
/// joined check into the `character` insert, and every write syscall ABORTS the
/// test process — a crash, not an assertion. The name argument must pass
/// `validate_name`, which sits above the joined check.
///
/// RED AT HEAD on state 3: with no gate the reducer answers `already joined` to a
/// mid-grace caller too.
///
/// kills: a dropped or discarded gate, and the ADR-0273 D10 rejected placement
/// BELOW the joined check (state 3 answers `already joined` either way) · M9
/// inverted polarity (states 1, 2 and 5) · a table-keyed fake (the admitted
/// states, while the stranger is mid-grace) · a latched answer (state 5).
#[test]
fn rb128_join_game_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    rb128_seed_player(&fx, me);

    let name = ["join_", "game"].concat();
    let call = || crate::movement::join_game(&ctx, "Tester".to_string());
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["already ", "joined"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `enqueue_move` refuses a deletion-gated caller and
/// admits everybody else.
///
/// Positive control: `not joined`, from `authorize_move` (guards.rs:234-238). No
/// `player` row is seeded, so the player index is unregistered and reads nothing;
/// the ADR-0168 D2 battle lock above it reads two unregistered battle indexes and
/// answers false. Nothing is written in any state.
///
/// RED AT HEAD on state 3: with no gate the reducer answers `not joined`.
///
/// kills: M4 (the gate placed below `authorize_move` — state 3 answers
/// `not joined`) · a dropped or discarded gate · M9 · a table-keyed fake · a
/// latched answer. HONEST LIMIT: a gate placed between the battle lock and
/// `authorize_move`, or hoisted INTO `authorize_move` (M8), still refuses here
/// — clause (P) of `rb128_class_iv_reducers_open_with_the_deletion_gate` and the
/// `movement.rs` file total own those.
#[test]
fn rb128_enqueue_move_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["enqueue_", "move"].concat();
    let call = || crate::movement::enqueue_move(&ctx, game_core::MoveInput::Jump, 1);
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["not ", "joined"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `set_move` refuses a deletion-gated caller and admits
/// everybody else.
///
/// Positive control: `not joined`, from `authorize_move`, exactly as for
/// `enqueue_move` (the battle lock above it answers false on this host). A
/// SEPARATE test from `enqueue_move`'s so one dropped gate fails with a message
/// naming which reducer lost it.
///
/// RED AT HEAD on state 3.
///
/// kills: a dropped, discarded or below-`authorize_move` gate on `set_move`
/// only · M9 · a table-keyed fake · a latched answer.
#[test]
fn rb128_set_move_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["set_", "move"].concat();
    let call = || crate::movement::set_move(&ctx, game_core::MoveInput::Jump, 1);
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["not ", "joined"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `clear_queue` refuses a deletion-gated caller and admits
/// everybody else.
///
/// Positive control: `not joined`, from `authorize_move` — `clear_queue` carries
/// no battle lock (ADR-0168 D3, which ADR-0273 D6 keeps; the deletion gate is
/// orthogonal to it).
///
/// RED AT HEAD on state 3.
///
/// kills: a dropped, discarded or below-`authorize_move` gate on `clear_queue` ·
/// M9 · a table-keyed fake · a latched answer.
#[test]
fn rb128_clear_queue_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["clear_", "queue"].concat();
    let call = || crate::movement::clear_queue(&ctx, 1);
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["not ", "joined"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `evolve` refuses a deletion-gated caller and admits
/// everybody else.
///
/// Positive control: `monster not found` (evolution.rs:57-59). The `u64`-keyed
/// `monster` index is unregistered, so the lookup yields nothing and no
/// `Monster` seed is needed — the ADR-0250 D7 proof-vehicle gap closes because
/// the gate now sits ABOVE that lookup (ADR-0273 D5).
///
/// RED AT HEAD on state 3.
///
/// kills: a dropped or discarded gate, or one placed below the monster lookup
/// (state 3 answers `monster not found`) · M14 (the stamp-aware sibling wrapper
/// with an old stamp admits the mid-grace row) · M9 · a table-keyed fake · a
/// latched answer. HONEST LIMIT: M3 (a test-only conditional attribute on the
/// gate statement) runs the gate in THIS build, so it passes here; clauses (P)
/// and (E) of the per-reducer source pin own it.
#[test]
fn rb128_evolve_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["evo", "lve"].concat();
    let call = || crate::evolution::evolve(&ctx, 1, 5);
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["monster not ", "found"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `care` refuses a deletion-gated caller and admits
/// everybody else.
///
/// Positive control: `monster not found` (raising.rs:76-78), for the same
/// unregistered-index reason as `evolve`.
///
/// RED AT HEAD on state 3.
///
/// kills: M1 (the dropped `care` gate) · a discarded or below-lookup gate · M9 ·
/// a table-keyed fake · a latched answer.
#[test]
fn rb128_care_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["ca", "re"].concat();
    let call = || crate::raising::care(&ctx, 1);
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["monster not ", "found"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `train` refuses a deletion-gated caller and admits
/// everybody else.
///
/// Positive control: `monster not found` (raising.rs:150-152), reached before
/// the food-item escrow read, the item lookup and the `consume_one` burn.
///
/// RED AT HEAD on state 3.
///
/// kills: a dropped, discarded or below-lookup gate on `train` (including the
/// M11 alias call, if its verdict is discarded) · M9 · a table-keyed fake · a
/// latched answer.
#[test]
fn rb128_train_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["tra", "in"].concat();
    let call = || crate::raising::train(&ctx, 1, 1);
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["monster not ", "found"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `essence_train` refuses a deletion-gated caller and
/// admits everybody else.
///
/// Positive control: `monster not found` (raising.rs:632-634).
///
/// RED AT HEAD on state 3.
///
/// kills: a dropped, discarded or below-lookup gate on `essence_train` · M9 · a
/// table-keyed fake · a latched answer.
#[test]
fn rb128_essence_train_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["essence_", "train"].concat();
    let call = || crate::raising::essence_train(&ctx, 1, game_core::Affinity::Fire);
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["monster not ", "found"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `consume_crystalized_essence` refuses a deletion-gated
/// caller and admits everybody else.
///
/// Positive control: `monster not found` (raising.rs:679-681), reached before the
/// item escrow read, the content-registry lookup and the `consume_one` burn.
///
/// RED AT HEAD on state 3.
///
/// kills: a dropped, discarded or below-lookup gate on
/// `consume_crystalized_essence` · M9 · a table-keyed fake · a latched answer.
#[test]
fn rb128_consume_crystalized_essence_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["consume_crystalized_", "essence"].concat();
    let call = || crate::raising::consume_crystalized_essence(&ctx, 1, 1);
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["monster not ", "found"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `attempt_recruit` refuses a deletion-gated caller and
/// admits everybody else.
///
/// Positive control: `battle not found` (taming.rs:49-56). The `u64`-keyed
/// `battle` index is unregistered, so the lookup yields nothing — well before the
/// bait `consume_one` and the success-path `monster` insert that make this
/// reducer class (iv) rather than class (i) (ADR-0258 D6, ADR-0273 D4).
///
/// RED AT HEAD on state 3.
///
/// kills: a dropped, discarded or below-lookup gate on `attempt_recruit` · M9 · a
/// table-keyed fake · a latched answer.
#[test]
fn rb128_attempt_recruit_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["attempt_", "recruit"].concat();
    let call = || crate::taming::attempt_recruit(&ctx, 1, None);
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["battle not ", "found"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `set_nickname` refuses a deletion-gated caller and
/// admits everybody else.
///
/// Positive control: `monster not found` (monster_mgmt.rs:23-27). The nickname
/// argument is never reached in any state.
///
/// RED AT HEAD on state 3.
///
/// kills: M2 (a `let _ =` discard of the `set_nickname` gate — state 3 answers
/// `monster not found`) · a dropped or below-lookup gate · M9 · a table-keyed
/// fake · a latched answer.
#[test]
fn rb128_set_nickname_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["set_", "nickname"].concat();
    let call = || crate::monster_mgmt::set_nickname(&ctx, 1, "Rex".to_string());
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["monster not ", "found"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `set_party_slot` refuses a deletion-gated caller and
/// admits everybody else.
///
/// Positive control: `monster not found` (monster_mgmt.rs:61-65).
///
/// RED AT HEAD on state 3.
///
/// kills: a dropped, discarded or below-lookup gate on `set_party_slot` · M6b (a
/// fixed-sender `return Ok(())` above the gate — on this host the sender IS the
/// all-zero wild identity, so state 1 answers `Ok`) · M9 · a table-keyed fake ·
/// a latched answer. HONEST LIMIT: M6a (an argument-keyed early return above the
/// gate on a slot value this test never sends) passes here; clause (P) owns it.
#[test]
fn rb128_set_party_slot_refuses_only_a_deletion_gated_caller() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let name = ["set_party_", "slot"].concat();
    let call = || crate::monster_mgmt::set_party_slot(&ctx, 1, 0);
    rb128_assert_refused_only_while_gated(
        name.as_str(),
        &fx,
        &acct,
        me,
        &call,
        Err(["monster not ", "found"].concat()),
        &rb128_no_row_oracle,
    );
}

/// **E1 (behaviour)** — `dismiss_dialogue` refuses a deletion-gated caller
/// BEFORE its delete, admits everybody else, and never touches a stranger's
/// conversation row.
///
/// Positive control: `Ok(())` — the reducer's whole admitted path is ONE primary
/// key delete of the caller's own `player_conversation` row. That delete is REAL
/// on this host because the index is REGISTERED here (an index-point delete on a
/// registered index is modelled; on an unregistered one it aborts), so the
/// reject-before-any-write claim is OBSERVED through the handle rather than
/// inferred: after every state the caller's row count must be 0 when admitted
/// (the delete ran) and 1 when refused (nothing ran), and a STRANGER's row must
/// be 1 in every state. The oracle then restores exactly one caller row for the
/// next state.
///
/// Rows carry zero or empty payloads on purpose (`rb80_seed_conversation` is the
/// precedent): the reducer reads no column but the key.
///
/// RED AT HEAD on state 3: with no gate the reducer deletes the row and answers
/// `Ok` to a mid-grace caller.
///
/// kills: a dropped or discarded gate · M5 (delete THEN gate — the return values
/// all match, the row oracle does not: on this host nothing rolls the delete
/// back, which is exactly what makes the ordering observable) · M6b (a
/// fixed-sender early `Ok` above the gate — the return value matches, the
/// caller's row survives an admitted state) · M9 · a table-keyed fake · a
/// latched answer · a delete keyed on anything but the caller (the stranger's
/// row).
#[test]
fn rb128_dismiss_dialogue_refuses_only_a_deletion_gated_caller_and_keeps_its_row() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let convs = fx.table::<crate::schema::PlayerConversation>(
        "player_conversation",
        "owner_identity",
        |r| r.owner_identity,
    );
    let ctx = fx.ctx();
    let me = ctx.sender();
    let stranger = spacetimedb::Identity::from_byte_array([9u8; 32]);
    let conversation = |owner: spacetimedb::Identity| crate::schema::PlayerConversation {
        owner_identity: owner,
        npc_entity_id: 0,
        current_node_id: String::new(),
    };
    convs.seed(&conversation(me));
    convs.seed(&conversation(stranger));

    let name = ["dismiss_", "dialogue"].concat();
    let oracle = |refused: bool| {
        let want_mine = usize::from(refused);
        let mine = convs.remove(me);
        assert_eq!(
            mine, want_mine,
            "rb-128 E1 FAIL (dismiss_dialogue row oracle, refused = {refused}): the caller's \
             conversation row count after the call is {mine} and must be {want_mine}. When \
             ADMITTED the reducer's one delete must have run (0 rows left); when REFUSED it must \
             not have run at all (1 row left). A surviving row in an admitted state is an early \
             return ABOVE the delete (on this host the sender is the all-zero wild identity, so a \
             fixed-sender return fires); a missing row in a refused state is a gate placed AFTER \
             the delete — the reject a client sees is correct while the write already happened, \
             which is precisely the ordering ADR-0273 D2 forbids."
        );
        let theirs = convs.remove(stranger);
        assert_eq!(
            theirs, 1,
            "rb-128 E1 FAIL (dismiss_dialogue row oracle, refused = {refused}): the STRANGER's \
             conversation row count is {theirs} and must be 1 in every state. The reducer may \
             only ever delete the caller's own row; any other count is a delete keyed on \
             something other than the caller."
        );
        convs.seed(&conversation(me));
        convs.seed(&conversation(stranger));
    };
    let call = || crate::npc::dismiss_dialogue(&ctx);
    rb128_assert_refused_only_while_gated(name.as_str(), &fx, &acct, me, &call, Ok(()), &oracle);
}
