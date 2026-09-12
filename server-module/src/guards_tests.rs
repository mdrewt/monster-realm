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

// ===========================================================================
// 11r-c (ADR-0168 D3) — the battle guard is PER-REDUCER, never inside
// `authorize_move`
//
// `guards.rs` is deliberately UNCHANGED by slice 11r-c. This section is the
// fence that keeps it that way: a source scan asserting `authorize_move` — the
// shared preamble of `enqueue_move`, `set_move` AND `clear_queue` — carries no
// battle guard.
//
// Source-guard pattern (house convention, same as `movement_tests.rs`): read the
// production source via `include_str!`, strip comments AND string literals,
// squash whitespace, search for **concat!-assembled** needles. No needle is
// written verbatim here, so neither this scan nor any eval that concatenates
// every `.rs` file under `server-module/src` can be satisfied by the test's own
// text.
//
// WARNING when editing any comment in this crate: a slash immediately followed
// by an asterisk opens a block comment for the evals' REGEX comment-stripper,
// which runs over the concatenated sources and swallows everything up to the
// next closing marker — ACROSS FILE BOUNDARIES. Writing that sequence here
// (e.g. as a glob) silently deletes a later file's reducers from the eval's view
// and false-REDs an unrelated check. Never write it; say ".rs file under <dir>"
// instead.
// ===========================================================================

const GUARDS_RS: &str = include_str!("guards.rs");

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

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// If a STRING literal starts at `i`, the index one past its closing delimiter.
///
/// Covers `"…"`, `b"…"`, and raw `r"…"` / `r#"…"#` / `r##"…"##` plus the `br`
/// forms. A `b` / `r` prefix only counts when it is not itself part of a longer
/// identifier, so `ctx.db` and `require_owner` are never mistaken for openers.
fn string_literal_end(bytes: &[u8], i: usize) -> Option<usize> {
    let len = bytes.len();
    let first = bytes[i];
    if first != DQUOTE && first != b'r' && first != b'b' {
        return None;
    }
    let prev_is_ident = i > 0 && is_ident_byte(bytes[i - 1]);
    let mut p = i;
    if first == b'b' {
        if prev_is_ident || p + 1 >= len {
            return None;
        }
        if bytes[p + 1] != DQUOTE && bytes[p + 1] != b'r' {
            return None;
        }
        p += 1;
    } else if first == b'r' && prev_is_ident {
        return None;
    }
    if bytes[p] == b'r' {
        let mut hashes = 0usize;
        while p + 1 + hashes < len && bytes[p + 1 + hashes] == b'#' {
            hashes += 1;
        }
        if p + 1 + hashes >= len || bytes[p + 1 + hashes] != DQUOTE {
            return None;
        }
        let mut j = p + 2 + hashes;
        while j < len {
            if bytes[j] == DQUOTE {
                let mut k = 0usize;
                while k < hashes && j + 1 + k < len && bytes[j + 1 + k] == b'#' {
                    k += 1;
                }
                if k == hashes {
                    return Some(j + 1 + hashes);
                }
            }
            j += 1;
        }
        return Some(len);
    }
    let mut j = p + 1;
    while j < len {
        if bytes[j] == b'\\' {
            j += 2;
        } else if bytes[j] == DQUOTE {
            return Some(j + 1);
        } else {
            j += 1;
        }
    }
    Some(len)
}

/// If a CHAR (or byte-char) literal starts at `i`, the index one past it.
///
/// A `'` is only read as a literal when a closing `'` follows within four bytes;
/// otherwise it is a lifetime tick and is left alone. The point of this branch is
/// a char literal HOLDING a double quote: unconsumed, that quote opens a phantom
/// string literal and everything after it would be blanked.
fn char_literal_end(bytes: &[u8], i: usize) -> Option<usize> {
    let len = bytes.len();
    if bytes[i] != b'\'' {
        return None;
    }
    let escaped = i + 1 < len && bytes[i + 1] == b'\\';
    let first = if escaped { 3 } else { 2 };
    for k in first..=4 {
        if i + k < len && bytes[i + k] == b'\'' {
            return Some(i + k + 1);
        }
    }
    None
}

fn strip_comments_and_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else if let Some(end) = string_literal_end(bytes, i) {
            i = end;
        } else if let Some(end) = char_literal_end(bytes, i) {
            while i < end {
                out[i] = bytes[i];
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// Loud preconditions covering the two constructs the stripper deliberately does
/// NOT handle. A silent misalignment in a stripper is the worst failure mode for
/// a source-scan gate — it blanks the wrong bytes and the assertion below turns
/// vacuous — so each fails with an explicit message instead.
///
/// 1. **Raw strings with three or more hashes.** Depth 0/1/2 is handled.
/// 2. **A surviving block-comment CLOSE marker in the stripped output**, which
///    means a NESTED block comment: this stripper stops at the FIRST close
///    marker, so the outer comment's tail would be handed to the scan as if it
///    were code. Correctly stripped source cannot contain one.
fn assert_stripper_preconditions(raw: &str, stripped: &str) {
    let deep_raw = ["r#", "##"].concat();
    assert!(
        !raw.contains(deep_raw.as_str()),
        "SCAN PRECONDITION: `guards.rs` contains a raw-string opener with three or \
         more hashes, which this file's byte-sequential stripper does not handle — \
         it would blank the wrong byte range and hollow out the fence below. Extend \
         the stripper's hash-depth handling before adding such a literal."
    );
    let close_marker = ["*", "/"].concat();
    assert!(
        !stripped.contains(close_marker.as_str()),
        "SCAN PRECONDITION: a block-comment CLOSE marker survived stripping, which \
         means `guards.rs` contains a NESTED block comment. This stripper stops at \
         the FIRST close marker, so the outer comment's tail is handed to the scan \
         as if it were executable code. Un-nest the comment, or extend the stripper \
         with a nesting depth counter."
    );
}

/// `guards.rs` with comments AND string literals blanked and ALL whitespace
/// squashed out, so a rustfmt line split can never cause a false RED and no
/// inert text can move the count below.
fn squashed_guards() -> String {
    let stripped = strip_comments_and_strings(GUARDS_RS);
    assert_stripper_preconditions(GUARDS_RS, &stripped);
    stripped.split_whitespace().collect()
}

/// **ADR-0168 D3 consequence fence** — `authorize_move` must carry NO battle
/// guard.
///
/// GREEN at HEAD and GREEN after slice 11r-c (which changes `movement.rs` only);
/// RED the moment someone "de-duplicates" the two inline intake guards into the
/// shared move authorizer.
///
/// WHY THIS IS A REAL HAZARD, not a hypothetical: 11r-c adds the SAME four-line
/// battle-reject block to `enqueue_move` and to `set_move`. Two identical copies
/// in adjacent reducers is exactly the shape that invites a helper — and
/// `authorize_move` is sitting right there, already called by both of them. But
/// it is called by THREE reducers: hoisting the guard into it silently guards
/// `clear_queue` too, voiding ADR-0168 D3's anti-decision without a single line
/// of `clear_queue` changing. The three D3 reasons that would be voided:
///   1. `clear_queue` is pure cancellation — it cannot cause movement and enables
///      no attack.
///   2. Rejecting it forces the stale pre-battle queue to survive to battle end,
///      turning the post-battle stale drain into a GUARANTEED behavior.
///   3. It denies an honest key-release cancel while the battle overlay opens.
///
/// This is the Rust-side half of a matched pair: `movement_tests.rs`'s
/// `clear_queue_is_deliberately_not_battle_guarded` pins `clear_queue`'s entire
/// body (so the guard cannot be added there directly, nor through a renamed
/// wrapper), and this test closes the one remaining route — adding it upstream in
/// the shared authorizer, where `clear_queue`'s own body never changes at all
/// (red-team HIGH-4 / the former eval-B6 check, moved into Rust where it runs in
/// the same `cargo test` as the thing it protects).
///
/// The needle is `is_in_ongoing_battle` WITHOUT a trailing `(`: inside this region
/// a bare mention — a re-import, a path fragment, a `let f = is_in_ongoing_battle;`
/// function value — is just as much a smell as a call.
///
/// HONEST LIMITS. (a) Region-scoped by text, from `pub(crate) fn authorize_move(`
/// to the next `pub(crate) fn`: it deliberately does NOT forbid `guards.rs` from
/// containing the predicate (it DEFINES it, at `guards.rs:264`), only from using
/// it in this one function. (b) A differently-NAMED battle predicate called from
/// `authorize_move` would not be seen here — that class is covered from the other
/// side by `movement_tests.rs`'s I3 count (`is_in_ongoing_battle(` exactly 4× in
/// `movement.rs`) and NEW-3 (no local shim definition), since any such helper must
/// ultimately reach the SSOT. (c) Source scan, not execution: this crate has no
/// reducer-executing harness (ADR-0156 P7).
#[test]
fn authorize_move_carries_no_battle_guard() {
    let squashed = squashed_guards();

    // Region anchor. `authorize_move` is `pub(crate) fn`, not `pub fn` — the
    // whole of guards.rs is crate-internal.
    let fn_marker = ["pub(crate)fnauthorize", "_move("].concat();
    let n_marker = squashed.matches(fn_marker.as_str()).count();
    assert_eq!(
        n_marker, 1,
        "FENCE PRECONDITION (ADR-0168 D3): `pub(crate)fnauthorize_move(` must \
         appear EXACTLY ONCE in the squashed `guards.rs`; found {n_marker}. With \
         zero, the function was renamed or moved and the fence below cannot be \
         built; with two, the region extractor takes the first match and a decoy \
         definition could hide the real one's contents from this scan."
    );

    let start = squashed
        .find(fn_marker.as_str())
        .expect("guards_tests: `pub(crate)fnauthorize_move(` not found in guards.rs");
    let rest_at = start + fn_marker.len();
    let next_fn = ["pub(crate)", "fn"].concat();
    let end = squashed[rest_at..]
        .find(next_fn.as_str())
        .map_or(squashed.len(), |off| rest_at + off);
    let region = &squashed[start..end];

    let ssot = ["is_in_ongoing", "_battle"].concat();
    let n_guard = region.matches(ssot.as_str()).count();
    assert_eq!(
        n_guard, 0,
        "TEETH (ADR-0168 D3 consequence, green at HEAD): `authorize_move`'s region \
         (`pub(crate) fn authorize_move(` … next `pub(crate) fn`) must contain ZERO \
         occurrences of `is_in_ongoing_battle`; found {n_guard}. \
         The battle guard is PER-REDUCER BY DESIGN. `authorize_move` is the shared \
         preamble of THREE reducers — `enqueue_move`, `set_move` and `clear_queue` \
         — and 11r-c guards only the first two. Hoisting the guard in here to \
         de-duplicate the two identical inline copies would silently guard \
         `clear_queue` as well, voiding ADR-0168 D3's anti-decision without one \
         line of `clear_queue` changing: (1) `clear_queue` is pure cancellation, it \
         cannot cause movement and enables no attack; (2) rejecting it forces the \
         stale pre-battle queue to survive to battle end, turning the post-battle \
         stale drain into a GUARANTEED behavior — strictly worse; (3) it denies an \
         honest key-release cancel exactly while the battle overlay is opening. \
         `guards.rs` is UNCHANGED by slice 11r-c; this is the fence that keeps the \
         guard inline in `movement.rs`. It pairs with \
         `movement_tests.rs::clear_queue_is_deliberately_not_battle_guarded` (which \
         pins `clear_queue`'s whole body, closing the direct and renamed-wrapper \
         routes); this test closes the upstream route. \
         If a future slice really must guard all three, change ADR-0168 D3 FIRST \
         and re-argue the three reasons — never delete this fence to make a build \
         green."
    );
}

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

/// The ASCII single quote (apostrophe) byte, spelled as a NUMBER.
///
/// Used only to ASSEMBLE the G-5 needle for a char-literal double quote. The
/// three-byte sequence it builds must never appear literally in this file — it
/// is the exact landmine G-5 exists to detect, and this file sorts before
/// `lib.rs` in the evals' concatenation order.
const SQUOTE: u8 = 0x27;

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

/// **G-4** (ADR-0170 D5) — `log_reject` must escape BOTH `reducer` and `reason`.
///
/// ASSERTION-RED once `json_escape` exists: at HEAD `log_reject`'s single
/// `log::warn!` interpolates both parameters raw, so a RON/serde parse error
/// carrying a double quote emits a malformed JSON log line.
///
/// WHY BOTH ARGUMENTS. `reason` is the obvious one (it carries parser output
/// across the trust boundary). `reducer` is the non-obvious one, and is why this
/// test counts TWO escapes rather than one: production holds ~127 `log_reject(`
/// call sites and most pass a name literal, but several helpers in `guards.rs` /
/// `pvp.rs` / `trading.rs` FORWARD a `&str` parameter, so "the reducer name is
/// always a literal" is an unenforced convention, not an invariant. This is the
/// reject path, never a hot path, so escaping both costs nothing.
///
/// The scan runs over the comment- AND string-blanked, whitespace-squashed
/// `guards.rs` produced by [`squashed_guards`], so a doc comment or a log message
/// mentioning the function cannot satisfy any needle — only executable code can.
/// The needles accept the call WITHOUT its closing paren so a borrow or an
/// `.as_ref()` at the call site does not false-RED, and the region is anchored
/// exactly the way [`authorize_move_carries_no_battle_guard`] anchors its own:
/// from the `pub(crate) fn` marker to the next `pub(crate) fn`.
///
/// WHAT EACH LAYER KILLS.
///   * count >= 2 — kills escaping neither argument (HEAD) and escaping only one.
///   * the two named needles — kill the same argument escaped TWICE, which
///     satisfies a bare count while leaving the other one raw.
///   * the surviving `log::warn!(` — kills an impl that escapes both arguments
///     and then drops or downgrades the log call itself, which would make every
///     assertion above vacuously true while deleting the observability this whole
///     seam exists to protect.
///   * **ZERO `let_` in the region** — kills the DISCARD idiom
///     `let _ = json_escape(reason);` sitting beside a raw interpolation, which
///     satisfies every needle above while every log line stays malformed. The
///     three-character needle catches `let _ =`, `let _esc =` and
///     `let _: String =` alike; the legitimate shadowing form
///     `let reducer = json_escape(reducer);` squashes to `letreducer=` and does
///     not match.
///
/// THE DISCARD IDIOM IS CLOSED BY THAT NEEDLE, NOT BY THE LINT GATE. An earlier
/// draft of this comment claimed `-D warnings` made the discard a build failure.
/// That is WRONG: `let _ = expr;` binds the wildcard pattern, which
/// `unused_variables` never reports (and `let _esc = ..` would at most be a
/// warning-level lint, not the hard error the claim assumed). The same evasion
/// with the same wrong justification was found and fixed once before in this
/// crate — `trading_tests.rs:1959-2039`.
///
/// HONEST LIMITS. (a) With the discard closed, what remains unpinned is only
/// "escaped into the wrong slot of the right log line": the format string is
/// blanked before matching (the same trade `movement_tests.rs:658-669` records),
/// so the scan sees that both parameters are escaped and that nothing throws the
/// results away, but not which placeholder consumes which. That residue is
/// covered from the other side by G-1..G-3, which prove the function is worth
/// calling at all. (b) Source scan, not execution: `log_reject` writes to the
/// host logger and this crate has no harness that can read it back (ADR-0156 P7).
#[test]
fn log_reject_escapes_both_reducer_and_reason() {
    let squashed = squashed_guards();

    let marker = ["pub(crate)fnlog", "_reject("].concat();
    let n_marker = squashed.matches(marker.as_str()).count();
    assert_eq!(
        n_marker, 1,
        "SCAN PRECONDITION (11r-g G-4): `pub(crate)fnlog_reject(` must appear EXACTLY \
         ONCE in the squashed `guards.rs`; found {n_marker}. With zero the reject \
         logger was renamed or moved and the region below cannot be built; with two \
         the region extractor takes the FIRST match, so a decoy definition could \
         carry the escapes while the real one still interpolates raw."
    );

    let start = squashed
        .find(marker.as_str())
        .expect("guards_tests: `pub(crate)fnlog_reject(` not found in guards.rs");
    let rest_at = start + marker.len();
    let next_fn = ["pub(crate)", "fn"].concat();
    let end = squashed[rest_at..]
        .find(next_fn.as_str())
        .map_or(squashed.len(), |off| rest_at + off);
    let region = &squashed[start..end];

    let esc = ["json", "_escape("].concat();
    let n_esc = region.matches(esc.as_str()).count();
    assert!(
        n_esc >= 2,
        "TEETH (11r-g G-4, ADR-0170 D5): `log_reject`'s body must call the escape \
         helper at least TWICE — once for `reducer`, once for `reason` — but it \
         calls it {n_esc} time(s). At HEAD the count is 0: both parameters are \
         interpolated raw into a hand-built JSON object, so a reason carrying a \
         double quote (a RON/serde parse error, a forwarded validator message) \
         closes the JSON string early and the whole log line is emitted malformed. \
         `reducer` is escaped too because several helpers forward a `&str` parameter \
         rather than a literal — see this test's doc comment. Comments AND string \
         literals are blanked before this count, so only executable calls are seen."
    );

    let esc_reducer = ["json", "_escape(reducer"].concat();
    assert!(
        region.contains(esc_reducer.as_str()),
        "TEETH (11r-g G-4, ADR-0170 D5): `log_reject` must pass its `reducer` \
         parameter through the escape helper — the squashed body must contain the \
         call applied to `reducer`. The bare count above is satisfied by escaping \
         `reason` twice; only this needle proves the FIRST interpolated field is \
         escaped as well. ~127 `log_reject(` call sites exist and several forward a \
         `&str` parameter, so an unescaped reducer name is reachable from the trust \
         boundary."
    );

    let esc_reason = ["json", "_escape(reason"].concat();
    assert!(
        region.contains(esc_reason.as_str()),
        "TEETH (11r-g G-4, ADR-0170 D5): `log_reject` must pass its `reason` \
         parameter through the escape helper — the squashed body must contain the \
         call applied to `reason`. This is the primary vector: `reason` carries \
         parser-generated and validator-generated text straight into a hand-built \
         JSON string."
    );

    let warn = ["log::wa", "rn!("].concat();
    assert!(
        region.contains(warn.as_str()),
        "ANTI-VACUITY (11r-g G-4): `log_reject` must still contain a `log::warn!(` \
         call. An implementation that escapes both arguments and then deletes or \
         downgrades the log call satisfies every needle above while removing the \
         observability the whole seam exists to protect."
    );

    // The discard kill. Green at HEAD (the body is a single `log::warn!` with no
    // bindings at all) and it must STAY green: every needle above is satisfied by
    // `let _ = json_escape(reducer); let _ = json_escape(reason); log::warn!(..)`
    // with both parameters still interpolated raw. That shell is neither a compile
    // error nor a lint failure — see this test's doc comment and the identical
    // finding at trading_tests.rs:1959-2039.
    let discard = ["let", "_"].concat();
    let n_discard = region.matches(discard.as_str()).count();
    assert_eq!(
        n_discard, 0,
        "TEETH (11r-g G-4, ADR-0170 D5): `log_reject`'s region contains {n_discard} \
         underscore binding(s) (`let _`) and must contain ZERO. \
         WHAT THIS KILLS: `let _ = json_escape(reducer); let _ = json_escape(reason);` \
         placed beside a `log::warn!` that still interpolates both parameters RAW. \
         That shell satisfies the escape COUNT and both named needles above while \
         emitting exactly the malformed JSON this seam exists to prevent, and it is \
         caught by nothing else: `let _ = expr;` binds the wildcard pattern, so \
         `unused_variables` never fires and `-D warnings` is silent (the same evasion, \
         with the same wrong 'the lint gate catches it' justification, was found and \
         fixed before at trading_tests.rs:1959-2039). \
         Use the escaped values directly in the format arguments, or bind them by \
         shadowing under their real names — `let reducer = json_escape(reducer);` \
         squashes to `letreducer=` and does not match this needle. Green at HEAD; if \
         it ever fires, the escape results are being thrown away."
    );
}

/// **G-5(a)** (ADR-0170, scan-substrate invariant) — none of the three production
/// files this slice touches may spell a double quote as a CHAR literal.
///
/// GREEN AT HEAD and green after the slice; RED the moment the obvious spelling
/// of the quote character lands in `guards.rs`'s new `json_escape`. It must be
/// written as a Unicode escape inside the char literal (or reached through a
/// numeric constant), never as a bare quote between two apostrophes.
///
/// WHY THIS IS A REAL HAZARD, not tidiness. Every text-level stripper in this
/// repo — the evals' `stripRustStrings`, and the byte-sequential
/// [`strip_comments_and_strings`] in this very file — either has no char-literal
/// lexer at all or bounds it to four bytes. A lone double quote inside a char
/// literal therefore reads as OPENING a string literal and inverts string/code
/// polarity for the rest of that file. The measured cost of exactly this mistake,
/// recorded in this file's own `DQUOTE` doc comment: `pub fn init(` in `lib.rs`
/// was blanked and the zone-warp eval failed with "init not found" — a loud
/// failure pointing at a completely innocent file. `cargo test` runs in seconds
/// and the eval suite does not, so this fence is the fast local canary for the
/// eval layer's W-pre precondition, deliberately NOT a second copy of it.
///
/// The needle is assembled from `char::from(SQUOTE)` / `char::from(DQUOTE)` so
/// the landmine sequence never appears in this file either — a scan that carries
/// its own counterexample is worse than no scan.
///
/// HONEST LIMIT: three named files, not the whole crate. The eval layer owns the
/// crate-wide sweep (and records four pre-existing landmines in test files that
/// are outside this slice's touch set); this fence covers exactly the files
/// 11r-g edits, which is where a new landmine would come from.
#[test]
fn touched_production_sources_have_no_char_literal_double_quote() {
    let sq = char::from(SQUOTE).to_string();
    let dq = double_quote();
    let needle = [sq.as_str(), dq.as_str(), sq.as_str()].concat();

    let files = [
        ("guards.rs", GUARDS_RS),
        ("movement.rs", include_str!("movement.rs")),
        ("content_cache.rs", include_str!("content_cache.rs")),
    ];

    for (name, src) in files {
        let n = src.matches(needle.as_str()).count();
        assert_eq!(
            n, 0,
            "TEETH (11r-g G-5a, ADR-0170 scan substrate): `{name}` contains {n} \
             char-literal double quote(s). Spell the character with a Unicode escape \
             inside the char literal instead. A lone double quote in a char literal \
             is read as a STRING OPENER by every text-level stripper in this repo \
             (the evals' `stripRustStrings` has no char-literal lexer; this file's \
             own stripper bounds one to four bytes), which inverts string/code \
             polarity for the rest of that file and blanks whatever follows. The \
             observed blast radius was `pub fn init(` in `lib.rs` disappearing and an \
             unrelated eval failing with 'init not found'. Green at HEAD — keep it \
             that way."
        );
    }
}

/// **G-5(b)** (ADR-0170, scan-substrate invariant) — block-comment markers stay
/// balanced in the three production files this slice touches.
///
/// GREEN AT HEAD (all three files contain zero of either marker) and green after
/// the slice. RED if an unpaired opener lands in a comment — for example the
/// natural way to write a file glob while documenting the new logging.
///
/// WHY: the evals' comment stripper is a non-greedy REGEX applied to source that
/// is concatenated in sorted filename order. An unpaired opener swallows
/// everything up to the next closer ACROSS FILE BOUNDARIES, silently deleting a
/// later file's reducers from the eval's view and false-REDing a check that has
/// nothing to do with this slice. This crate already carries a written warning
/// about it in three places (the 11r-c section above, `movement_tests.rs:676-682`
/// and `movement.rs`); this is the executable version.
///
/// Counts must be EQUAL rather than zero: a legitimately paired block comment is
/// fine, an unpaired opener (or a stray closer) is not. Both markers are
/// assembled from single characters so this file never spells either one
/// contiguously — the same discipline `assert_stripper_preconditions`'s own
/// `close_marker` uses.
///
/// HONEST LIMIT: equal counts are necessary, not sufficient — one opener and one
/// closer in the WRONG order would balance. That shape cannot be written by
/// accident in a comment (a stray closer outside a comment does not compile), and
/// the stripper-precondition assertion in [`squashed_guards`] independently
/// catches a nested comment.
#[test]
fn touched_production_sources_have_balanced_block_comment_markers() {
    let open_marker = ["/", "*"].concat();
    let close_marker = ["*", "/"].concat();

    let files = [
        ("guards.rs", GUARDS_RS),
        ("movement.rs", include_str!("movement.rs")),
        ("content_cache.rs", include_str!("content_cache.rs")),
    ];

    for (name, src) in files {
        let opens = src.matches(open_marker.as_str()).count();
        let closes = src.matches(close_marker.as_str()).count();
        assert_eq!(
            opens, closes,
            "TEETH (11r-g G-5b, ADR-0170 scan substrate): `{name}` has {opens} \
             block-comment opener(s) but {closes} closer(s). The evals strip comments \
             with a non-greedy REGEX over sources concatenated in sorted filename \
             order, so an unpaired opener swallows everything up to the next closer \
             ACROSS FILE BOUNDARIES — it deletes a later file's reducers from the \
             eval's view and turns an unrelated check RED with a misleading message. \
             If you need the sequence in prose, spell it out in words instead. All \
             three files start at 0 and 0; green at HEAD."
        );
    }
}

// ===========================================================================
// m22-s5 (PRV1-9 / PRV1-10, spec para 4.7, ADR-0225) — the gameplay deletion
// gate: SCAN half.
//
// EARS criteria encoded by this block:
//
//   PRV1-9  WHILE the caller's account is inside the para-4.7 deletion gate,
//           WHEN the caller invokes `propose_trade`, `challenge_pvp` or
//           `accept_challenge`, the server module SHALL reject the call before
//           any write, with a single static reason.
//   PRV1-10 The `guards.rs` gate SHALL DELEGATE the decision to the accounts
//           SSOT (`crate::accounts::is_pending_deletion` ->
//           `should_reject_for_deletion`) and SHALL NOT re-derive the
//           status-or-terminal-marker disjunction; exactly three reducers are
//           gated and every other reducer stays deliberately open.
//
// RED STATE of this block at HEAD (before the S5 implementation lands):
//   * `m22s5_gate_delegates_fused_and_unconditional` — RED: the wrapper does
//     not exist in `guards.rs`, so body extraction fails LOUD.
//   * `m22s5_guards_never_rederives_deletion_disjunction` — RED: the wrapper
//     count is 0 and must be 1 (the five ban clauses are already green).
//   * `m22s5_is_pending_deletion_delegates_to_should_reject` — GREEN at HEAD
//     ON PURPOSE. The far hop (`accounts.rs:338-344`) already delegates since
//     m22-s3; this is the fence that keeps the delegation the S5 wrapper is
//     built on from being inlined away underneath it. Deliberately a SEPARATE
//     test from every red one (the split reason recorded at
//     `movement_tests.rs:917-921`: folded into a failing test it could never
//     be observed passing).
//   * `m22s5_gated_reducer_census_is_exactly_three` — RED: the gated set is
//     empty and must be the three named reducers.
//   * `m22s5_already_open_reducers_are_not_gated` — GREEN at HEAD, a fence.
//   * `m22s5_gate_precedes_first_write_in_every_gated_reducer` — RED: no
//     gated body carries the call, which fails LOUD rather than vacuously.
//   * `m22s5_gate_body_performs_no_write` — RED: extraction fails LOUD.
//   * `m22s5_gate_call_sites_are_fully_tagged` — RED: all four counts are 0.
//
// SCAN SUBSTRATE RULES honoured throughout (breaking them breaks OTHER
// slices' gates, not this one): every needle naming a production symbol is
// assembled from fragments, no failure message quotes a searched needle
// verbatim, no raw double-quote CHARACTER literal is written anywhere, and
// neither block-comment marker is ever spelled contiguously.
// ===========================================================================

const M22S5_TRADING_RS: &str = include_str!("trading.rs");
const M22S5_PVP_RS: &str = include_str!("pvp.rs");
const M22S5_ACCOUNTS_RS: &str = include_str!("accounts.rs");

/// Whitespace-squashed view. Squashing is what makes every composite needle
/// below rustfmt-proof: a call split across lines still matches.
fn m22s5_squash(src: &str) -> String {
    src.split_whitespace().collect()
}

/// Loud preconditions that must hold for EITHER pipeline below to be sound.
///
/// 1. No deep raw-string opener (three or more hashes) — the same construct
///    `assert_stripper_preconditions` refuses for `guards.rs`, restated for
///    the other three files S5 scans. Silent misalignment in a stripper is the
///    worst failure mode for a source-scan gate: it blanks the wrong bytes and
///    every assertion downstream turns vacuous.
/// 2. Balanced block-comment markers. Both stripping pipelines stop at the
///    FIRST close marker, so an unpaired opener hands the rest of the file to
///    the scan as if it were executable code (or swallows real code). This is
///    the same invariant `touched_production_sources_have_balanced_block_comment_markers`
///    pins for the 11r-g file set, restated for the four files S5 scans.
fn m22s5_assert_source_is_scannable(label: &str, raw: &str) {
    let deep_raw = ["r#", "##"].concat();
    assert!(
        !raw.contains(deep_raw.as_str()),
        "SCAN PRECONDITION (m22-s5): `{label}` contains a raw-string opener with three or \
         more hashes, which this file's byte-sequential stripper does not handle — it \
         would blank the wrong byte range and hollow out every m22-s5 assertion that reads \
         the result. Extend the stripper's hash-depth handling before adding such a \
         literal, and re-derive every count in this block against it."
    );

    let open_marker = ["/", "*"].concat();
    let close_marker = ["*", "/"].concat();
    let opens = raw.matches(open_marker.as_str()).count();
    let closes = raw.matches(close_marker.as_str()).count();
    assert_eq!(
        opens, closes,
        "SCAN PRECONDITION (m22-s5): `{label}` has {opens} block-comment opener(s) but \
         {closes} closer(s). Both stripping pipelines in this block stop at the FIRST \
         closer, so an unpaired opener either swallows real reducer bodies (turning a \
         census silently vacuous) or hands comment prose to the scan as code. Spell the \
         sequence out in words if it is needed in prose."
    );
}

/// `src` with comments AND string-literal payloads blanked, then squashed.
///
/// Reuses this file's own [`strip_comments_and_strings`] so the S5 scans and
/// the 11r-c / 11r-g fences agree byte-for-byte on what the source says.
/// The extra preconditions here are the ones the REDUCER-BODY extractor needs
/// and the guards.rs-only helper does not: a brace CHAR literal survives this
/// stripper (it has a bounded char lexer) and would desync the brace matcher
/// by one, which is exactly enough to mis-slice a reducer body.
fn m22s5_stripped_squashed(label: &str, src: &str) -> String {
    m22s5_assert_source_is_scannable(label, src);
    let stripped = strip_comments_and_strings(src);

    let close_marker = ["*", "/"].concat();
    assert!(
        !stripped.contains(close_marker.as_str()),
        "SCAN PRECONDITION (m22-s5): a block-comment CLOSE marker survived stripping of \
         `{label}`, which means a NESTED block comment. The stripper stops at the first \
         closer, so the outer comment's tail reaches the scan as code."
    );

    let squashed = m22s5_squash(&stripped);

    let brace_open_char = ["'", "{", "'"].concat();
    let brace_close_char = ["'", "}", "'"].concat();
    assert!(
        !squashed.contains(brace_open_char.as_str())
            && !squashed.contains(brace_close_char.as_str()),
        "SCAN PRECONDITION (m22-s5): `{label}` contains a brace CHAR literal. The stripper \
         consumes char literals atomically and KEEPS them, so that brace survives into the \
         squashed text and shifts every brace-matched reducer body by one — enough to make \
         a nested, never-executed gate report top level. Spell the character with a Unicode \
         escape, or teach the extractor about char literals; never delete this check."
    );

    let opens = squashed.matches('{').count();
    let closes = squashed.matches('}').count();
    assert_eq!(
        opens, closes,
        "SCAN PRECONDITION (m22-s5): the stripped+squashed view of `{label}` has {opens} \
         open brace(s) and {closes} close brace(s). The reducer-body extractor below is a \
         brace matcher; on unbalanced input it slices the wrong region and every census \
         count silently becomes meaningless. Investigate the stripper against the file \
         rather than relaxing any assertion downstream."
    );

    squashed
}

/// `src` with COMMENTS ONLY removed — string-literal payloads SURVIVE — then
/// squashed.
///
/// A copy of this file's [`strip_comments_and_strings`] state machine with the
/// string-blanking arm replaced by a COPY arm (the literal is still consumed
/// atomically, so a `//` or a brace inside a string can never be mis-lexed).
/// Needed because the S5 log-tag pin is precisely a claim about a string
/// payload: on the string-BLANKED view every reducer's tag reads as an empty
/// literal, so a guard filing its reject under the wrong reducer's name is
/// invisible there. Same trade `pvp_tests.rs`'s `ra_squash_comments_only`
/// records for the ADR-0189 tag cross-pin.
fn m22s5_strip_comments_only(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else if let Some(end) = string_literal_end(bytes, i) {
            while i < end {
                out[i] = bytes[i];
                i += 1;
            }
        } else if let Some(end) = char_literal_end(bytes, i) {
            while i < end {
                out[i] = bytes[i];
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("comment-stripped source must be valid UTF-8")
}

/// Comments-only stripped, whitespace-squashed view of `src`.
fn m22s5_comments_only_squashed(label: &str, src: &str) -> String {
    m22s5_assert_source_is_scannable(label, src);
    m22s5_squash(&m22s5_strip_comments_only(src))
}

/// The brace-bounded body of the function whose squashed declaration starts at
/// `marker`, or `None`.
///
/// Brace matching starts AT the marker, never at file start: `guards.rs`
/// legitimately contains a Unicode-escape char literal whose braces survive
/// stripping (`json_escape`'s two structural arms), so a whole-file depth
/// count would be desynced before it ever reached the S5 wrapper.
fn m22s5_squashed_fn_body(squashed: &str, marker: &str) -> Option<String> {
    let start = squashed.find(marker)?;
    let after = &squashed[start..];
    let open = after.find('{')?;
    let bytes = after.as_bytes();
    let mut depth = 1usize;
    let mut k = open + 1;
    while k < bytes.len() {
        match bytes[k] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(after[open + 1..k].to_string());
                }
            }
            _ => {}
        }
        k += 1;
    }
    None
}

/// The squashed declaration marker of the S5 wrapper.
fn m22s5_wrapper_marker() -> String {
    ["fnrequire_not_", "deleting("].concat()
}

/// The S5 wrapper's brace-bounded, squashed body. Fails LOUD when it cannot be
/// extracted — which IS the red state at HEAD.
fn m22s5_require_not_deleting_body() -> String {
    let squashed = m22s5_stripped_squashed("guards.rs", GUARDS_RS);
    let marker = m22s5_wrapper_marker();
    let n = squashed.matches(marker.as_str()).count();
    assert_eq!(
        n, 1,
        "m22-s5 PRV1-10 FAIL (extraction): the S5 deletion-gate wrapper is declared {n} \
         time(s) in `guards.rs`; it must be declared EXACTLY ONCE. \
         ZERO is the RED STATE AT HEAD — the wrapper does not exist yet, and this test \
         fails LOUD rather than passing vacuously over a body it never found. \
         TWO would let the region extractor take the FIRST match, so a decoy definition \
         could carry the delegation while the real one re-derives the disjunction."
    );

    m22s5_squashed_fn_body(&squashed, marker.as_str()).unwrap_or_else(|| {
        panic!(
            "m22-s5 PRV1-10 FAIL (extraction): the S5 deletion-gate wrapper is declared in \
             `guards.rs` but its brace-bounded body could not be sliced. Either the braces \
             are unbalanced from the declaration onward, or the declaration is followed by \
             something other than a body. Fail LOUD: a pin that silently skips when its \
             anchor moves is worth nothing."
        )
    })
}

/// The fully-qualified call text every gated reducer must carry, in the
/// string-BLANKED normal form (the tag payload is gone, only the call shape
/// remains). Split so this file's own text is never the thing a scan finds.
fn m22s5_gate_call_needle() -> String {
    ["crate::guards::require_not_", "deleting("].concat()
}

/// The bare wrapper name, for the already-open census (a re-export, an alias
/// binding or a call all mention it — the census bans the NAME, not just the
/// fully-qualified call).
fn m22s5_gate_bare_name() -> String {
    ["require_not_", "deleting"].concat()
}

/// Every `#[spacetimedb::reducer]` body in `squashed`, as `(name, body)` pairs.
///
/// PANICS on any parse ambiguity rather than skipping: a census that silently
/// drops a reducer it could not parse is a census that reports the wrong set
/// while looking healthy. The strings-blanked view has no comment or string
/// braces left (the preconditions in [`m22s5_stripped_squashed`] prove it), so
/// brace matching is exact here.
fn m22s5_reducer_bodies(label: &str, squashed: &str) -> Vec<(String, String)> {
    let attr_full = ["#[spacetimedb::", "reducer]"].concat();
    let attr_open = ["#[spacetimedb::", "reducer"].concat();
    let n_full = squashed.matches(attr_full.as_str()).count();
    let n_open = squashed.matches(attr_open.as_str()).count();
    assert_eq!(
        n_open, n_full,
        "m22-s5 CENSUS PARSE AMBIGUITY in `{label}`: {n_open} reducer attribute opener(s) \
         but {n_full} in the bare no-argument form this extractor understands. A \
         parameterised reducer attribute (a lifecycle hook, for instance) is present and \
         would be SKIPPED, silently shrinking the census set. Extend the extractor \
         deliberately; do not narrow the assertion that reads it."
    );
    assert!(
        n_full > 0,
        "m22-s5 CENSUS ANTI-VACUITY: `{label}` yielded ZERO reducers. Either the attribute \
         spelling changed or the stripping pipeline blanked the file, and every set/count \
         assertion downstream would pass over an empty world."
    );

    let pub_fn = ["pub", "fn"].concat();
    let bare_fn = "fn";
    let mut out: Vec<(String, String)> = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = squashed[cursor..].find(attr_full.as_str()) {
        let attr_at = cursor + rel;
        let after = attr_at + attr_full.len();
        let rest = &squashed[after..];
        let (sig, sig_abs) = if let Some(r) = rest.strip_prefix(pub_fn.as_str()) {
            (r, after + pub_fn.len())
        } else if let Some(r) = rest.strip_prefix(bare_fn) {
            (r, after + bare_fn.len())
        } else {
            let dump: String = rest.chars().take(80).collect();
            panic!(
                "m22-s5 CENSUS PARSE AMBIGUITY in `{label}`: the reducer attribute at \
                 squashed offset {attr_at} is not immediately followed by a function \
                 declaration. Something (another attribute, a visibility form this \
                 extractor does not know) sits between them, so the reducer's name and \
                 body cannot be attributed. Extend the extractor. Text after the \
                 attribute began: {dump:?}"
            )
        };

        let paren = sig.find('(').unwrap_or_else(|| {
            panic!(
                "m22-s5 CENSUS PARSE AMBIGUITY in `{label}`: a reducer declaration at \
                 squashed offset {sig_abs} has no argument list."
            )
        });
        let name = &sig[..paren];
        assert!(
            !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
            "m22-s5 CENSUS PARSE AMBIGUITY in `{label}`: the reducer declared at squashed \
             offset {sig_abs} does not have a plain identifier name (generics or a path \
             form would land here). The census keys on names, so an unparseable one must \
             stop the run, never be skipped. Parsed: {name:?}"
        );

        let brace_rel = sig[paren..].find('{').unwrap_or_else(|| {
            panic!(
                "m22-s5 CENSUS PARSE AMBIGUITY in `{label}`: reducer `{name}` has no body \
                 brace after its argument list."
            )
        });
        let body_start = paren + brace_rel + 1;
        let bytes = sig.as_bytes();
        let mut depth = 1usize;
        let mut k = body_start;
        let mut end: Option<usize> = None;
        while k < bytes.len() {
            match bytes[k] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(k);
                        break;
                    }
                }
                _ => {}
            }
            k += 1;
        }
        let end = end.unwrap_or_else(|| {
            panic!(
                "m22-s5 CENSUS PARSE AMBIGUITY in `{label}`: reducer `{name}`'s body brace \
                 never closes. The whole-file balance precondition passed, so this is a \
                 real extractor defect — stop rather than return a truncated body."
            )
        });

        out.push((name.to_string(), sig[body_start..end].to_string()));
        cursor = sig_abs + end + 1;
    }
    out
}

/// `(name, body)` pairs for BOTH scanned reducer files, in file order.
fn m22s5_all_reducer_bodies() -> Vec<(&'static str, String, String)> {
    let files: [(&'static str, &'static str); 2] =
        [("trading.rs", M22S5_TRADING_RS), ("pvp.rs", M22S5_PVP_RS)];
    let mut out = Vec::new();
    for (label, src) in files {
        let squashed = m22s5_stripped_squashed(label, src);
        for (name, body) in m22s5_reducer_bodies(label, &squashed) {
            out.push((label, name, body));
        }
    }
    out
}

/// **PRV1-10 (a)** — the wrapper DELEGATES, in ONE fused expression, and does
/// nothing else.
///
/// The prefix pin is the whole tooth. `contains` would be satisfied by a body
/// that computes the fused call and then ignores it, negates it, rebinds it, or
/// diverts around it; `starts_with` says the delegation IS the leading (and,
/// with the clauses below, the only) expression. What each clause kills:
///
///   * PREFIX — kills a NEGATED fused argument (the polarity inversion: every
///     gated reducer would then reject exactly the accounts that are NOT
///     deleting), kills a rebind that computes the predicate into a local and
///     hands the pure gate something else, and kills a leading early-return
///     that diverts around the delegation entirely.
///   * COUNT == 1 — kills a decoy fused call sitting beside the real, wrong
///     one; with the prefix alone, a second copy is invisible.
///   * NO always-false conditional, NO conditional-compilation attribute, NO
///     conditional-compilation macro — the unconditional claim's three standard
///     evasions. The attribute form in particular keeps the exact statement text
///     in the file and in every source scan while compiling it OUT of the
///     shipped wasm: present in review, absent in production (the ADR-0189
///     red-team F3 finding, restated here).
///   * THE REJECT LOG, APPLIED TO THE `reducer` PARAMETER, EXACTLY ONCE — kills
///     a wrapper that rejects correctly but files the reject under a hard-coded
///     name, losing the operator's only record of WHICH reducer refused; and
///     kills a double-logging shape.
///   * NO direct reach for the logging facade — kills a wrapper that bypasses
///     the reject-logger choke point and hand-builds its own log line, skipping
///     the ADR-0170 D5 escaping that the shared reject logger owns.
///
/// HONEST LIMIT: source scan, not execution — this crate has no
/// reducer-executing harness (ADR-0156 P7). The behavioural half is
/// `m22s5_deletion_gate_truth_table`, which runs the pure decision seam.
#[test]
fn m22s5_gate_delegates_fused_and_unconditional() {
    let body = m22s5_require_not_deleting_body();

    // Two closing forms are accepted for the fused call: the single-line form
    // and the form rustfmt produces when it splits the call one argument per
    // line and adds a trailing comma (the EA-CHR-01 tolerance precedent).
    let fused_plain = [
        "deletion_gate(crate::accounts::is_pending_",
        "deletion(ctx,ctx.sender())).map_err(",
    ]
    .concat();
    let fused_trailing = [
        "deletion_gate(crate::accounts::is_pending_",
        "deletion(ctx,ctx.sender(),)).map_err(",
    ]
    .concat();

    assert!(
        body.starts_with(fused_plain.as_str()) || body.starts_with(fused_trailing.as_str()),
        "m22-s5 PRV1-10 FAIL (fused-delegation prefix): the wrapper's body must BEGIN with \
         the fused delegation into the accounts SSOT, immediately chained into the \
         reject-mapping combinator. It does not. A `contains`-style pin would accept a \
         body that negates the predicate, rebinds it into a local before passing something \
         else, or returns early above it — all three keep the delegation text in the file \
         while inverting or skipping the decision. Expected leading text (squashed, \
         trailing-comma form): {fused_trailing:?}. Body began: {body:?}"
    );

    // EXACT-EQUALITY body pin (artifact red-team, m22-s5): the prefix assertion
    // above never looks PAST the prefix, and a measured CI-green bypass appended
    // a trailing recovery combinator after the reject-mapping closure — every
    // reject the gate produced was converted back into success while all prior
    // clauses stayed green. The wrapper's body is a single fused expression and
    // nothing else; whole-body equality is the only shape that rejects trailing
    // text of ANY spelling. Two accepted bodies: single-line and the
    // trailing-comma form rustfmt produces on a split.
    let closure_tail = ["|e|{log_re", "ject(reducer,ctx.sender(),e);e.to_string()})"].concat();
    let body_plain = [fused_plain.as_str(), closure_tail.as_str()].concat();
    let body_trailing = [fused_trailing.as_str(), closure_tail.as_str()].concat();
    assert!(
        body == body_plain || body == body_trailing,
        "m22-s5 PRV1-10 FAIL (whole-body equality): the wrapper's body must BE the fused \
         delegation chained into the reject-mapping closure, byte-for-byte in the squashed \
         view, with NOTHING after it. Trailing text of any kind — a recovery combinator, a \
         second statement, an appended expression — can silently convert the reject back \
         into success while the prefix, count, and log clauses above all stay green (a \
         measured bypass). Expected (squashed): {body_plain:?}. Got: {body:?}"
    );

    let n_fused =
        body.matches(fused_plain.as_str()).count() + body.matches(fused_trailing.as_str()).count();
    assert_eq!(
        n_fused, 1,
        "m22-s5 PRV1-10 FAIL (fused-delegation count): the wrapper's body contains \
         {n_fused} fused delegation(s); it must contain EXACTLY ONE. The prefix assertion \
         above is blind to a SECOND copy — a decoy leading call followed by the real, \
         differently-argued one satisfies it while the effective decision comes from the \
         second."
    );

    let if_false = ["if", "false"].concat();
    let n_if_false = body.matches(if_false.as_str()).count();
    assert_eq!(
        n_if_false, 0,
        "m22-s5 PRV1-10 FAIL (unconditional): the wrapper's body contains {n_if_false} \
         always-false conditional(s). A never-taken branch leaves every needle in this \
         test satisfiable while the gate decides nothing."
    );

    let cfg_attr = ["#", "[cfg"].concat();
    assert!(
        !body.contains(cfg_attr.as_str()),
        "m22-s5 PRV1-10 FAIL (unconditional): the wrapper's body carries a conditional \
         compilation attribute. That keeps the exact statement text in the file and in \
         every source scan while compiling it OUT of the shipped wasm — the gate would be \
         present in review and absent in production."
    );

    let cfg_macro = ["cfg", "!("].concat();
    assert!(
        !body.contains(cfg_macro.as_str()),
        "m22-s5 PRV1-10 FAIL (unconditional): the wrapper's body uses the conditional \
         compilation MACRO. Same defect as the attribute form in the clause above, reached \
         through an expression instead: the gate becomes deployment-dependent while every \
         text pin stays green."
    );

    let log_call = ["log_re", "ject(reducer,"].concat();
    let n_log = body.matches(log_call.as_str()).count();
    assert_eq!(
        n_log, 1,
        "m22-s5 PRV1-9 FAIL (reject provenance): the wrapper's body logs the reject with \
         its `reducer` parameter {n_log} time(s); it must do so EXACTLY ONCE. With zero, \
         either nothing is logged or a hard-coded name is logged instead, and the \
         operator's only record of which reducer refused a deletion-gated caller points at \
         the wrong place (the wrapper is shared by three reducers, so the parameter is the \
         ONLY thing that distinguishes them). With two, one reject produces two lines."
    );

    let log_path = ["log", "::"].concat();
    let n_log_path = body.matches(log_path.as_str()).count();
    assert_eq!(
        n_log_path, 0,
        "m22-s5 PRV1-9 FAIL (choke point): the wrapper's body reaches the logging facade \
         directly {n_log_path} time(s) and must reach it ZERO times. Every reject line in \
         this crate goes through the shared reject logger, which is the ADR-0170 D5 choke \
         point that escapes both interpolated fields; a hand-built line beside it emits \
         malformed JSON for any reason string carrying a structural character and the log \
         ingest drops it silently."
    );
}

/// **PRV1-10 (b)** — `guards.rs` never re-derives the deletion disjunction.
///
/// Spec para 4.1 defines the terminal state as a CONJUNCTION and para 4.7's
/// gate as a DISJUNCTION over it (`accounts.rs:292-305`). The explicit second
/// disjunct is the fail-closed arm for the illegal active-plus-marker shape and
/// must never be simplified away — which is precisely what happens when a
/// second module writes its own copy: the copy is written against the LEGAL
/// states, the fail-closed arm quietly disappears, and a resurrected tombstone
/// is waved through into new trades and challenges.
///
/// Run on the comments-stripped, strings-KEPT view ON PURPOSE. For a BAN,
/// over-inclusive is the correct posture: a mention in a log message or a
/// reject reason is itself the smell (it means the vocabulary crossed the
/// module boundary), and keeping payloads immunises the ban against a
/// string-stripper desync that would otherwise blank real code and turn the
/// whole ban silently green — the 13r-c / ADR-0181 false-GREEN class.
///
/// The five ban clauses are GREEN AT HEAD and must stay green. The declaration
/// count is the RED one: the wrapper does not exist yet.
#[test]
fn m22s5_guards_never_rederives_deletion_disjunction() {
    let squashed = m22s5_comments_only_squashed("guards.rs", GUARDS_RS);

    // Every needle is split so this test file's own text can never satisfy a
    // scan, nor trip one that concatenates every source file in this crate.
    let bans: [(String, &str); 5] = [
        (
            ["Pending", "Deletion"].concat(),
            "the pending-deletion status variant",
        ),
        (
            ["terminal_", "at_ms"].concat(),
            "the terminal-marker column",
        ),
        (["Account", "Status"].concat(), "the account status enum"),
        (
            ["account_has_terminal_", "marker"].concat(),
            "the marker-half predicate",
        ),
        (
            ["ctx.db.acc", "ount("].concat(),
            "a direct account-table read",
        ),
    ];

    for (needle, what) in bans {
        let n = squashed.matches(needle.as_str()).count();
        assert_eq!(
            n, 0,
            "m22-s5 PRV1-10 FAIL (no re-derivation): `guards.rs` mentions {what} {n} \
             time(s) and must mention it ZERO times. The para-4.7 gate has ONE SSOT, in \
             `accounts.rs` (the module that OWNS the account table, per its own \
             write-isolation rule), and the guards-side wrapper exists to DELEGATE to it. \
             A second spelling here is not a duplicate — it is a second, divergent \
             definition: a widening of the SSOT disjunction would silently stop applying \
             to the gameplay gate, and a copy written against the legal states drops the \
             fail-closed arm that refuses an already-erased account. Green at HEAD; if \
             this fires, delegate instead of re-deriving."
        );
    }

    let marker = m22s5_wrapper_marker();
    let n_decl = squashed.matches(marker.as_str()).count();
    assert_eq!(
        n_decl, 1,
        "m22-s5 PRV1-10 FAIL (wrapper exists, exactly once): `guards.rs` declares the S5 \
         deletion-gate wrapper {n_decl} time(s) and must declare it EXACTLY ONCE. ZERO is \
         the RED STATE AT HEAD. Without this clause the five bans above would pass \
         perfectly on a `guards.rs` that has no gate at all — an absence gate is vacuous \
         unless something also pins the presence it is scoping."
    );
}

/// **PRV1-10 (c)** — the far hop stays delegated.
///
/// The S5 wrapper delegates to `accounts::is_pending_deletion`, which since
/// m22-s3 delegates in turn to `should_reject_for_deletion` — the SSOT that
/// carries the fail-closed second disjunct. This test pins the SECOND hop.
/// Without it, the whole S5 chain can be gutted one module away: inline the
/// status test inside `is_pending_deletion` and every guards-side assertion in
/// this block stays green while the gate silently narrows back to
/// status-only, waving a terminal (already-erased) account into new trades and
/// challenges.
///
/// GREEN AT HEAD ON PURPOSE — the hop already exists (`accounts.rs:338-344`).
/// This is a fence on an existing decision, not a proof of new teeth, and it
/// is a separate `#[test]` from every red one so it can be observed passing.
#[test]
fn m22s5_is_pending_deletion_delegates_to_should_reject() {
    let squashed = m22s5_stripped_squashed("accounts.rs", M22S5_ACCOUNTS_RS);
    let marker = ["fnis_pending_", "deletion("].concat();
    let n_marker = squashed.matches(marker.as_str()).count();
    assert_eq!(
        n_marker, 1,
        "m22-s5 PRV1-10 FAIL (far hop, extraction): `accounts.rs` declares the \
         context-bound deletion predicate {n_marker} time(s); it must declare it EXACTLY \
         ONCE. With zero it was renamed or moved and the S5 wrapper's delegation target no \
         longer exists; with two, the extractor below takes the FIRST match and a decoy \
         could carry the delegation while the real one inlines it."
    );

    let body = m22s5_squashed_fn_body(&squashed, marker.as_str()).unwrap_or_else(|| {
        panic!(
            "m22-s5 PRV1-10 FAIL (far hop, extraction): the context-bound deletion \
             predicate is declared in `accounts.rs` but its brace-bounded body could not \
             be sliced. Fail LOUD rather than pass over a body never found."
        )
    });

    let ssot = ["should_reject_for_", "deletion("].concat();
    let n_ssot = body.matches(ssot.as_str()).count();
    assert_eq!(
        n_ssot, 1,
        "m22-s5 PRV1-10 FAIL (far hop): the context-bound deletion predicate calls the \
         pure SSOT decision {n_ssot} time(s); it must call it EXACTLY ONCE. ZERO is the \
         gutting mutant: an inline status comparison here narrows the gate back to \
         status-only and drops the fail-closed arm for the illegal active-plus-marker \
         shape, so an already-erased account is admitted to new trades, battles and \
         challenges — and every guards-side assertion in this block stays green, because \
         nothing in `guards.rs` changed. Two would mean the row is consulted twice, which \
         is a different function than the one the S5 wrapper was reasoned about."
    );

    let row_read = ["ctx.db.acc", "ount().identity().find("].concat();
    assert!(
        body.contains(row_read.as_str()),
        "m22-s5 PRV1-10 FAIL (far hop, anti-vacuity): the context-bound deletion predicate \
         must still READ the account row it judges. Without the lookup the SSOT call \
         count above is satisfiable by a body that decides on a fabricated or defaulted \
         row, and the predicate answers the same thing for every caller."
    );

    // EXACT-EQUALITY body pin (artifact red-team, m22-s5): the two containment
    // clauses above are blind to LEADING code, and a measured CI-green bypass
    // prepended a short-circuit return on a condition rustc cannot constant-fold
    // (a timestamp comparison that is true for every real invocation) — the row
    // read and the SSOT call both survived textually while the predicate went
    // dead for every caller in production, gutting the S5 gate AND the
    // guest-claim guard that shares this predicate. Whole-body equality rejects
    // leading and trailing code of any spelling; this fn is a frozen SSOT seam
    // and a refactor of it must co-edit this pin deliberately.
    let expected_body = [
        row_read.as_str(),
        "identity).is_some_and(|a|",
        ssot.as_str(),
        "&a))",
    ]
    .concat();
    assert!(
        body == expected_body,
        "m22-s5 PRV1-10 FAIL (far hop, whole-body equality): the context-bound deletion \
         predicate's body must BE the account-row lookup fed straight into the pure SSOT \
         decision, byte-for-byte in the squashed view — no leading code (a short-circuit \
         return before the lookup deadens the gate for every caller while both containment \
         clauses above stay green: a measured bypass), no trailing code, no rebinds. \
         Expected (squashed): {expected_body:?}. Got: {body:?}"
    );
}

/// **PRV1-9 (a)** — EXACTLY three gated reducers, named.
///
/// A count alone is satisfied by gating three arbitrary reducers; a membership
/// check alone is satisfied by gating those three PLUS everything else. This
/// asserts the SET, which is the actual spec claim: `propose_trade`,
/// `challenge_pvp`, `accept_challenge` and nothing else. Over-gating is a real
/// defect, not merely untidy — gating `cancel_trade` or `decline_challenge`
/// would trap a deleting player's counterparty inside a commitment that can
/// no longer be unwound, which is the exact opposite of what para 4.7 is for.
///
/// The per-file BANS close the other direction: a reducer that reaches for the
/// accounts predicate (or the account table) DIRECTLY has re-derived the gate
/// inside a reducer body, where none of the `guards.rs` fences can see it.
#[test]
fn m22s5_gated_reducer_census_is_exactly_three() {
    let call = m22s5_gate_call_needle();
    let bodies = m22s5_all_reducer_bodies();

    let found: std::collections::BTreeSet<String> = bodies
        .iter()
        .filter(|(_, _, body)| body.contains(call.as_str()))
        .map(|(_, name, _)| name.clone())
        .collect();

    let expected: std::collections::BTreeSet<String> = [
        ["propose_", "trade"].concat(),
        ["challenge_", "pvp"].concat(),
        ["accept_", "challenge"].concat(),
    ]
    .into_iter()
    .collect();

    let missing: Vec<&String> = expected.difference(&found).collect();
    let extra: Vec<&String> = found.difference(&expected).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "m22-s5 PRV1-9 FAIL (gated-reducer census): the set of reducers carrying the \
         deletion gate is wrong. Missing: {missing:?}. Unexpectedly gated: {extra:?}. \
         Found: {found:?}. \
         AT HEAD the found set is EMPTY — that is the red state. \
         IF YOU ADDED A REDUCER that opens a NEW commitment between two players, gate it \
         and add its name here. IF YOU ADDED ONE THAT DOES NOT, classify it already-open \
         DELIBERATELY by adding it to the already-open census test in this block, and say \
         why in the slice notes. Never delete a name from the expected set to make a \
         build green: over-gating traps a counterparty inside an unwindable commitment, \
         under-gating lets a deleting account open new ones — both are spec breaks, and \
         only this SET assertion can tell them apart."
    );

    let per_file: [(&str, &str, usize); 2] = [
        ("trading.rs", M22S5_TRADING_RS, 1),
        ("pvp.rs", M22S5_PVP_RS, 2),
    ];
    let mut total = 0usize;
    for (label, src, want) in per_file {
        let squashed = m22s5_stripped_squashed(label, src);
        let n = squashed.matches(call.as_str()).count();
        total += n;
        assert_eq!(
            n, want,
            "m22-s5 PRV1-9 FAIL (call-site count): `{label}` contains {n} deletion-gate \
             call(s) and must contain exactly {want}. The set assertion above reads \
             REDUCER BODIES only; this whole-file count additionally catches a gate call \
             hoisted into a private helper (where the body-keyed set cannot attribute it) \
             and a duplicated call inside one body."
        );
    }
    assert_eq!(
        total, 3,
        "m22-s5 PRV1-9 FAIL (call-site total): {total} deletion-gate call(s) across both \
         reducer files; the spec fixes it at three, one per gated reducer."
    );

    let file_bans: [(&str, &str); 2] = [("trading.rs", M22S5_TRADING_RS), ("pvp.rs", M22S5_PVP_RS)];
    // The last two bans close the census extractor's camouflage class (artifact
    // red-team, m22-s5): a conditional-compilation attribute wrapper or a
    // renamed attribute import would make a reducer INVISIBLE to the extractor
    // above (silently absent from both the gated and already-open sets) rather
    // than a loud parse ambiguity. Neither spelling exists in either file today;
    // a future legitimate use must extend the extractor first, deliberately.
    let bypass: [(String, &str); 7] = [
        (
            ["crate::accounts::is_pending_", "deletion("].concat(),
            "the accounts-side context predicate",
        ),
        (
            ["should_reject_for_", "deletion("].concat(),
            "the pure SSOT decision",
        ),
        (
            ["ctx.db.acc", "ount("].concat(),
            "a direct account-table read",
        ),
        (
            ["crate::accounts::refuses_commitment_", "opened_at("].concat(),
            "the stamp-aware accounts-side context predicate (rb-47) — reachable from a \
             reducer file ONLY through the guards wrapper",
        ),
        (
            ["opened_commitment_is_", "refused("].concat(),
            "the pure stamp-aware decision (rb-47)",
        ),
        (
            ["cfg_", "attr("].concat(),
            "a conditional-compilation attribute wrapper (census camouflage)",
        ),
        (
            ["::reducer", "as"].concat(),
            "a renamed reducer-attribute import (census camouflage)",
        ),
    ];
    for (label, src) in file_bans {
        let squashed = m22s5_stripped_squashed(label, src);
        for (needle, what) in &bypass {
            let n = squashed.matches(needle.as_str()).count();
            assert_eq!(
                n, 0,
                "m22-s5 PRV1-9 FAIL (bypass ban): `{label}` reaches {what} directly {n} \
                 time(s) and must reach it ZERO times. Every gated reducer goes through \
                 the shared wrapper, which is what makes the census above meaningful: a \
                 reducer that consults the predicate itself is gated by a rule NO fence in \
                 this block constrains — it can invert the polarity, log nothing, or run \
                 after the write, and the set assertion above still reports three. Green \
                 at HEAD; keep it that way."
            );
        }
    }
}

/// **PRV1-9 (b)** — the nine already-open reducers stay open, deliberately.
///
/// Para 4.7 gates the reducers that OPEN a new commitment. The nine here either
/// unwind an existing one (`respond_trade`, `confirm_trade`, `cancel_trade`,
/// `decline_challenge`, `cancel_challenge`), advance a battle already in
/// progress (`submit_pvp_action`), or are scheduler-only liveness reapers
/// (`trade_offer_reaper`, `battle_challenge_reaper`, `pvp_deadline_reaper`).
/// Gating any of them is the trap-state defect: a deleting player's
/// counterparty could no longer decline, cancel, confirm or finish, and the
/// escrow the gate exists to protect would be frozen rather than released. The
/// scheduler-only three are worse still — `ctx.sender()` there is the DATABASE
/// identity, so a caller-keyed gate would consult the wrong account entirely.
///
/// SINCE rb-47 (ADR-0237) one of the nine carries a SECOND, narrower gate:
/// `respond_trade` refuses an ACCEPTING response to an offer created after the
/// caller's own deletion request, through a DIFFERENT wrapper whose bare name is
/// not the one this fence pins. It is still never BLANKET-gated, and declines
/// still pass untouched — which is exactly the trap-state reasoning above, held
/// in place by the new gate's PLACEMENT below the decline block rather than by
/// this census. A hit here still means the blanket gate was added.
///
/// Every name is asserted to EXIST first: a fence over a reducer that was
/// renamed away silently stops fencing anything.
///
/// GREEN AT HEAD and after the slice; a separate `#[test]` from every red one.
#[test]
fn m22s5_already_open_reducers_are_not_gated() {
    let bare = m22s5_gate_bare_name();
    let bodies = m22s5_all_reducer_bodies();

    let open_set: [String; 9] = [
        ["respond_", "trade"].concat(),
        ["confirm_", "trade"].concat(),
        ["cancel_", "trade"].concat(),
        ["trade_offer_", "reaper"].concat(),
        ["decline_", "challenge"].concat(),
        ["cancel_", "challenge"].concat(),
        ["submit_pvp_", "action"].concat(),
        ["battle_challenge_", "reaper"].concat(),
        ["pvp_deadline_", "reaper"].concat(),
    ];

    for name in open_set {
        let hit = bodies.iter().find(|(_, n, _)| *n == name);
        let (label, _, body) = hit.unwrap_or_else(|| {
            panic!(
                "m22-s5 PRV1-9 FAIL (already-open census, anti-vacuity): reducer `{name}` \
                 was not found in either reducer file. This fence asserts an ABSENCE \
                 inside that reducer, so a missing reducer makes it vacuous. If the \
                 reducer was renamed, update this list DELIBERATELY and re-argue whether \
                 the new one is open or gated; if it was deleted, remove it here and say \
                 so in the slice notes."
            )
        });
        let n = body.matches(bare.as_str()).count();
        assert_eq!(
            n, 0,
            "m22-s5 PRV1-9 FAIL (over-gating): `{name}` in `{label}` mentions the deletion \
             gate {n} time(s) and must mention it ZERO times. This reducer is open BY \
             DESIGN: it unwinds, advances or reaps an EXISTING commitment rather than \
             opening a new one. Gating it turns the grace window into a trap — the \
             deleting player's counterparty can no longer decline, cancel or complete, so \
             the escrow this gate protects is frozen instead of released, and a \
             scheduler-only reaper would consult the DATABASE identity's account rather \
             than any player's. The bare NAME is the needle, so an alias or a wrapper \
             around the gate is caught here too. If a future spec really gates one of \
             these, change the spec first, then this list — never the reverse. \
             SCOPE, since rb-47 (ADR-0237): `respond_trade` also carries a \
             STAMP-CONDITIONED refusal, through a different wrapper with a different bare \
             name. That is not blanket gating and cannot be reported here — so a hit is \
             still the blanket gate, and still the trap-state defect."
        );
    }
}

/// **PRV1-9 (c)** — decision before irreversible effect, in every gated body.
///
/// A gate that runs after the row exists does not gate anything: the trade
/// offer is already inserted, the challenge already sent, the ranked battle
/// already created, and the reject merely tells the caller about a commitment
/// that now exists. Both the anchors and the write set fail LOUD when absent —
/// an ordering pin whose landmark disappeared is a pin that passes on anything.
#[test]
fn m22s5_gate_precedes_first_write_in_every_gated_reducer() {
    let call = m22s5_gate_call_needle();
    let bodies = m22s5_all_reducer_bodies();

    // The last four entries are the write-performing pub(crate) helpers a
    // gated reducer could reach TODAY without any local write verb appearing in
    // its own body (artifact red-team, m22-s5): a helper's insert/update text
    // lives in the helper's file, invisible to this body-scoped scan. A named
    // list is a stopgap, not a closure — a NEW write helper must be added here
    // deliberately, and the anti-vacuity clause below is what forces that.
    let write_verbs: [String; 13] = [
        ["()", ".insert("].concat(),
        ["()", ".update("].concat(),
        ["()", ".delete("].concat(),
        ["start_pvp_", "battle("].concat(),
        ["schedule_trade_", "reaper("].concat(),
        ["schedule_challenge_", "reaper("].concat(),
        ["schedule_", "deadline("].concat(),
        ["disarm_challenge_", "reaper("].concat(),
        ["disarm_trade_", "reaper("].concat(),
        ["grant_", "item("].concat(),
        ["consume_", "one("].concat(),
        ["grant_", "currency("].concat(),
        ["spend_", "currency("].concat(),
    ];

    let gated: [String; 3] = [
        ["propose_", "trade"].concat(),
        ["challenge_", "pvp"].concat(),
        ["accept_", "challenge"].concat(),
    ];

    for name in gated {
        let hit = bodies.iter().find(|(_, n, _)| *n == name);
        let (label, _, body) = hit.unwrap_or_else(|| {
            panic!(
                "m22-s5 PRV1-9 FAIL (ordering, anti-vacuity): gated reducer `{name}` was \
                 not found in either reducer file, so the ordering pin cannot fire."
            )
        });

        let gate_pos = body.find(call.as_str()).unwrap_or_else(|| {
            panic!(
                "m22-s5 PRV1-9 FAIL (ordering): `{name}` in `{label}` carries NO deletion \
                 gate, so there is nothing to order. THIS IS THE RED STATE AT HEAD — the \
                 gate has not been implemented yet. Failing loud here is deliberate: an \
                 ordering assertion that quietly skips an ungated reducer would report \
                 success on a module with no gate at all."
            )
        });

        let first_write = write_verbs
            .iter()
            .filter_map(|v| body.find(v.as_str()))
            .min()
            .unwrap_or_else(|| {
                panic!(
                    "m22-s5 PRV1-9 FAIL (ordering, anti-vacuity): `{name}` in `{label}` \
                     contains NONE of the known write verbs, so `gate before first write` \
                     is trivially true and this assertion proves nothing. Either the \
                     reducer stopped writing (in which case ask whether it still needs \
                     gating) or it writes through a verb this list does not know — add it \
                     here rather than accepting the vacuous pass."
                )
            });

        assert!(
            gate_pos < first_write,
            "m22-s5 PRV1-9 FAIL (decision before irreversible effect): in `{name}` \
             (`{label}`) the deletion gate sits at squashed offset {gate_pos}, AFTER the \
             first write at offset {first_write}. A gate that runs once the row exists \
             does not gate anything — the trade offer is inserted, the challenge is sent, \
             or the ranked battle is created, and the reject only reports a commitment \
             that the deleting account has ALREADY opened. Move the gate above every \
             write in this reducer."
        );
    }
}

/// **PRV1-9 (d)** — the gate itself writes nothing.
///
/// The wrapper runs on the reject path of three reducers. A write inside it
/// would be a side effect nobody reviewing a call site can see, and on the
/// Ok path it would fire on EVERY gated call. Kept as its own test so the
/// ordering pin above and this one fail with distinct, separable messages.
#[test]
fn m22s5_gate_body_performs_no_write() {
    let body = m22s5_require_not_deleting_body();
    let writes: [String; 3] = [
        ["()", ".insert("].concat(),
        ["()", ".update("].concat(),
        ["()", ".delete("].concat(),
    ];
    for w in writes {
        let n = body.matches(w.as_str()).count();
        assert_eq!(
            n, 0,
            "m22-s5 PRV1-9 FAIL (pure gate): the deletion-gate wrapper's body performs {n} \
             table write(s) and must perform ZERO. It is a shared preamble for three \
             reducers and runs on every call, accepted or rejected; a write here is \
             invisible at all three call sites and fires on the happy path too."
        );
    }
}

/// **PRV1-9 (e)** — every call site names ITS OWN reducer.
///
/// Run on the comments-stripped, strings-KEPT view: this is the only pin in
/// the block that can see the tag, because every other pipeline blanks string
/// payloads and all three call sites become byte-identical there. A gate that
/// rejects correctly but files the reject under a sibling reducer's name
/// points the operator's only record of a refused, deletion-gated commitment
/// at the wrong reducer — and the wrapper is SHARED by three of them, so the
/// tag is the only thing that distinguishes the three rejects in the log.
///
/// The per-file TOTALS are what make the three exact-statement pins airtight:
/// without them, a duplicated call (correct tag, wrong place) satisfies every
/// count above.
#[test]
fn m22s5_gate_call_sites_are_fully_tagged() {
    let call = m22s5_gate_call_needle();
    let dq = double_quote();

    // Both closing forms are accepted — the single-line call and the form
    // rustfmt produces when it splits and adds a trailing comma.
    let site = |tag: &str, trailing: bool| -> String {
        let comma = if trailing { "," } else { "" };
        [
            call.as_str(),
            "ctx,",
            dq.as_str(),
            tag,
            dq.as_str(),
            comma,
            ")?;",
        ]
        .concat()
    };

    let cases: [(&str, &str, &str, usize); 3] = [
        ("trading.rs", M22S5_TRADING_RS, "propose_trade", 1),
        ("pvp.rs", M22S5_PVP_RS, "challenge_pvp", 2),
        ("pvp.rs", M22S5_PVP_RS, "accept_challenge", 2),
    ];

    for (label, src, tag, file_total) in cases {
        let squashed = m22s5_comments_only_squashed(label, src);
        let plain = site(tag, false);
        let trailing = site(tag, true);
        let n =
            squashed.matches(plain.as_str()).count() + squashed.matches(trailing.as_str()).count();
        assert_eq!(
            n, 1,
            "m22-s5 PRV1-9 FAIL (call-site tag): `{label}` contains {n} deletion-gate call \
             site(s) tagged for `{tag}`; it must contain EXACTLY ONE. This is the only pin \
             in the block evaluated with string payloads INTACT — every other pipeline \
             blanks them, which makes all three call sites byte-identical and a swapped \
             tag invisible. A wrong tag files the reject under a sibling reducer's name, \
             and since one shared wrapper serves all three reducers the tag is the ONLY \
             record of which commitment was actually refused. The trailing `?;` is part of \
             the pin: a discarded result compiles, lints clean, and gates nothing. \
             Expected (squashed, trailing-comma form): {trailing:?}"
        );

        let n_file = squashed.matches(call.as_str()).count();
        assert_eq!(
            n_file, file_total,
            "m22-s5 PRV1-9 FAIL (call-site total, tagged view): `{label}` contains \
             {n_file} deletion-gate call(s) and must contain exactly {file_total}. The \
             exact-statement pin above counts only correctly-tagged sites; this total is \
             what rejects a SECOND, differently-tagged or untagged call sitting beside it \
             — including a copy in a reducer that must stay open."
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

/// **PRV1-9 (reason contract)** — the reject reason is static, PII-free, and
/// DISTINCT from every neighbouring account-lifecycle reject.
///
/// WHY EACH CLAUSE:
///   * NON-EMPTY — an empty reason reaches the client as a blank error toast.
///   * NO FORMAT HOLE — the reason must be a fixed literal, never a template.
///     A hole is how caller-controlled or row-derived text (an identity, an
///     email, a name) reaches a log line and a client error string: the whole
///     point of a static reason on a privacy path is that it can carry no
///     subject data at all.
///   * DISTINCT from `complete_guest_claim`'s Guard 3 reason
///     (`accounts.rs:536`) — that guard consults the SAME predicate this gate
///     delegates to. Sharing one string would make the two indistinguishable
///     to a client that has to phrase them differently (one says `your claim
///     cannot proceed`, the other says `you cannot open new commitments`), and
///     would make the two rejects indistinguishable in the log as well.
///   * DISTINCT from the PRV1-4 late-cancel reason (`accounts.rs:81`,
///     `REJECT_ALREADY_DELETED`, a private const — referenced here by its
///     literal, with the line cited, because module privacy puts the binding
///     out of reach). That one means `this is over and cannot be reversed`;
///     this one means `this is in progress and new commitments are paused`.
///     Collapsing them tells a player mid-grace that their account is already
///     permanently deleted, which is both false and unrecoverable advice — the
///     cancel affordance is still live.
///
/// Distinctness is asserted in BOTH directions (neither string contains the
/// other), not merely as inequality: a reason built by appending to a
/// neighbour's text is still indistinguishable by prefix matching, which is
/// how clients key affordances off reject strings.
#[test]
fn m22s5_reject_reason_is_static_pii_free_and_distinct() {
    let reason = REJECT_DELETION_GATED;

    assert!(
        !reason.is_empty(),
        "m22-s5 PRV1-9 FAIL (reason contract): the deletion-gate reject reason is empty. \
         It reaches the client verbatim as the error for a refused trade or challenge; an \
         empty string is a blank toast the player cannot act on."
    );

    let hole = "\u{007B}";
    let n_hole = reason.matches(hole).count();
    assert_eq!(
        n_hole, 0,
        "m22-s5 PRV1-9 FAIL (reason contract): the deletion-gate reject reason contains \
         {n_hole} format hole(s) and must contain ZERO. The reason must be a fixed \
         literal, never a template: a hole is exactly how row-derived or caller-derived \
         text (an identity, a name, an issuer) reaches both the client error string and \
         the reject log line. On a privacy path the whole value of a static reason is \
         that it can carry no subject data at all."
    );

    // `complete_guest_claim` Guard 3 (accounts.rs:536) — the OTHER consumer of
    // the same SSOT predicate this gate delegates to.
    let claim_guard_reason = "account pending deletion";
    // PRV1-4 late-cancel reason (accounts.rs:81, `REJECT_ALREADY_DELETED`).
    // Spelled as a literal because the binding is a private `const` in
    // `accounts` and module privacy puts it out of reach from here.
    let terminal_cancel_reason = "this account has already been permanently deleted";

    let neighbours: [(&str, &str); 2] = [
        (claim_guard_reason, "the guest-claim pending-deletion guard"),
        (terminal_cancel_reason, "the late-cancel terminal reject"),
    ];

    for (other, what) in neighbours {
        assert_ne!(
            reason, other,
            "m22-s5 PRV1-9 FAIL (reason distinctness): the deletion-gate reject reason is \
             IDENTICAL to {what}'s reason. The two mean different things and the client \
             must phrase them differently; sharing one string also makes the two rejects \
             indistinguishable in the operator's log."
        );
        assert!(
            !reason.contains(other),
            "m22-s5 PRV1-9 FAIL (reason distinctness): the deletion-gate reject reason \
             CONTAINS {what}'s reason. Inequality alone is not enough — clients key \
             affordances off substring and prefix matches on reject strings, so a reason \
             built by appending to a neighbour's text still fires the neighbour's \
             affordance."
        );
        assert!(
            !other.contains(reason),
            "m22-s5 PRV1-9 FAIL (reason distinctness): {what}'s reason CONTAINS the \
             deletion-gate reject reason. Same defect as the clause above with the \
             containment the other way round: the shorter string still matches inside the \
             longer one, so the two paths remain indistinguishable to any client or log \
             filter that matches on substrings."
        );
    }
}

// ===========================================================================
// rb-46 (residual R-m22-s5-X12, ADR-0236 D1) — the caller-only deletion gate
// reaches PvE battle start and the shop.
//
// EARS criterion encoded by this block:
//
//   R-m22-s5-X12  WHILE the caller's account is inside the para-4.7 deletion
//                 gate, WHEN the caller invokes `start_battle`,
//                 `start_wild_battle`, `buy` or `sell`, the server module SHALL
//                 refuse the call before any write, through the ONE shared
//                 caller-only wrapper, tagged with the refusing reducer's own
//                 name.
//
// SCOPE NOTE ON THE m22-s5 CENSUS ABOVE — read this before touching it.
// `m22s5_gated_reducer_census_is_exactly_three` stays CORRECT and is
// deliberately left unedited by this slice: its claim is scope-LOCAL to the two
// files it scans, trading.rs and pvp.rs. The CRATE-WIDE caller set of the
// wrapper was never three. m22-s3b (ADR-0228 D7h) added a fourth caller,
// ranking::set_profile_name, and rb-46 adds four more (start_battle,
// start_wild_battle, buy, sell) for eight in total. The test below is the
// AUTHORITATIVE per-file set for battle.rs and economy.rs; no test in this crate
// claims a crate-wide total, and none should without scanning every reducer
// file. If a later slice wants that total, it must add the scan, not widen a
// scoped one.
//
// SUBSTRATE: the proven m22-s5 pipeline, reused and NOT re-derived (ADR-0003).
//   * `m22s5_stripped_squashed` — comments and string payloads blanked, all
//     whitespace squashed. Carries its own loud preconditions (no deep raw
//     string, balanced block-comment markers, no brace CHAR literal, balanced
//     braces) which now also run against the two new sources. Used for the SET,
//     the whole-file bare-name count and the bypass bans.
//   * `m22s5_comments_only_squashed` — string payloads INTACT. The ONLY view in
//     which a reducer's log tag is visible at all; every payload-blanking view
//     renders all four call sites byte-identical.
//
// RED STATE AT HEAD: no call site exists in either file, so the gated SET is
// EMPTY and the first set assertion fails naming both missing reducers of
// battle.rs. Everything else in this test (the anti-vacuity name checks, the
// bypass bans) is GREEN at HEAD by design and must stay green afterwards.
//
// SCAN SUBSTRATE RULES honoured here, as in the m22-s5 block above: every needle
// naming a production symbol is assembled from fragments, no raw double-quote
// CHARACTER literal is written anywhere, and no block-comment marker is ever
// spelled contiguously.
// ===========================================================================

/// The PvE/wild battle reducer file, for the rb-46 per-file gate census.
const RB46_BATTLE_RS: &str = include_str!("battle.rs");

/// The shop/wallet reducer file, for the rb-46 per-file gate census.
const RB46_ECONOMY_RS: &str = include_str!("economy.rs");

/// The bare reducer-attribute marker, squashed — the boundary between one
/// reducer's declaration region and the next one's.
fn rb46_reducer_attr() -> String {
    ["#[spacetimedb::", "reducer]"].concat()
}

/// The four reducer names rb-46 gates, assembled from fragments.
///
/// Each name doubles as the log TAG its own call site must carry, which is why
/// one list serves both the SET assertion and the tag pins.
fn rb46_gated_names() -> [String; 4] {
    [
        ["start_", "battle"].concat(),
        ["start_wild_", "battle"].concat(),
        ["b", "uy"].concat(),
        ["se", "ll"].concat(),
    ]
}

/// **R-m22-s5-X12 (census)** — the gated SET, the per-file call count, the
/// per-site log tag, and the bans that keep the census meaningful.
///
/// Four claims, none of which the others can stand in for:
///
///   1. THE SET, per file: exactly `start_battle` + `start_wild_battle` in
///      battle.rs, exactly `buy` + `sell` in economy.rs. A count alone is
///      satisfied by gating two arbitrary reducers; a membership check alone is
///      satisfied by gating those two PLUS everything else. Over-gating is a
///      real defect here, not untidiness: gating `submit_attack`, `swap_active`,
///      `flee` or `use_battle_item` would trap a deleting player inside a battle
///      they can no longer finish or flee, and gating a wallet helper
///      (`grant_currency` / `spend_currency`, both in economy.rs) would
///      force-terminate value delivery mid-battle — the PRV1-10 break ADR-0236
///      D1 names. The third helper on that reasoning, `consume_one`, lives in
///      inventory.rs and is therefore outside BOTH scanned files: this census
///      cannot see it, and nothing here claims otherwise.
///   2. THE WHOLE-FILE BARE-NAME COUNT of two per file. The set assertion reads
///      REDUCER BODIES only, so it is blind to a gate call hoisted into a
///      private helper, to a duplicate inside one body, and to a `..._for(ctx,
///      other)` sibling of the wrapper. The bare NAME is the needle, so an alias
///      binding or a wrapper around the wrapper is counted too.
///      SCOPE, since rb-76 (ADR-0246): `battle.rs` now also carries a
///      SUBJECT-parameterised deletion wrapper, called once from
///      `begin_encounter`. Its bare name is PREFIX-FREE against this one (that
///      is asserted, in both directions, by
///      `rb76_subject_gate_wrapper_is_declared_once_fused_and_unconditional`),
///      so this count deliberately does not see it and correctly stays at two.
///      That sibling takes an identity, so it cannot borrow ADR-0227 D2's
///      structural caller-only guarantee; its containment is a crate-wide
///      census of its own,
///      `rb76_subject_gate_and_begin_encounter_are_contained_crate_wide`. Do
///      not widen this needle to cover it — the two wrappers have different
///      allowed call sets, and one count cannot state both.
///   3. THE LOG TAG, on the string-BEARING view, with the site required to sit
///      inside its OWN reducer's declaration region. The count alone kills a
///      single wrong tag; the region check is what kills a SWAP (buy tagged for
///      sell and sell tagged for buy), under which every count is still one.
///   4. THE BYPASS BANS: no reducer in either file may reach the accounts
///      predicate, the pure SSOT decision, the account table, or (since rb-47,
///      ADR-0237) either half of the stamp-aware seam directly: the ctx-bound
///      `refuses_commitment_opened_at` and the pure `opened_commitment_is_refused`,
///      whose one sanctioned consumer is the caller-only wrapper in `guards.rs`.
///      Nor may either file hide a reducer from the extractor behind a
///      conditional-compilation attribute wrapper or a renamed attribute
///      import. A reducer that consults the predicate itself is gated by a rule
///      NO fence in this crate constrains: it can invert the polarity, log
///      nothing, or run after the write, and the set assertion still reports it
///      as gated. The stamp-aware pair is worse still: its ctx-bound half takes
///      an IDENTITY, so a reducer calling it directly can ask about a third
///      party (the deletion-status oracle ADR-0227 D4 forbids).
///
/// RED AT HEAD: neither file carries a call site, so the found set is EMPTY and
/// the SET assertion fails first, naming `start_battle` and `start_wild_battle`
/// as missing. The bare-name count (0, must be 2) and all four tag pins (0, must
/// be 1) are red behind it.
///
/// kills:
///   - M1/M2/M3/M4, dropping any one of the four call sites — the SET assertion
///     names the missing reducer, and the bare-name count falls to 1.
///   - M9, gating an already-open battle reducer (`submit_attack`): reported as
///     unexpectedly gated by the SET assertion, and the file count reads 3.
///   - M10, gating a wallet helper (`spend_currency`): invisible to the SET (a
///     helper is not a reducer body) but the whole-file bare-name count reads 3.
///   - M11, an import-shadowed unqualified call: the qualified needle no longer
///     matches, so the reducer drops out of the SET while the bare-name count
///     still reads 2 — the two clauses disagree, which is exactly the signal.
///   - M12, a duplicated call: the file count reads 3.
///   - M13, deleting the call and leaving a decoy `//` comment behind it: both
///     views strip comments first, so the decoy satisfies nothing.
///   - M6, a wrong tag (`sell` inside `buy`): the per-tag count for `buy` reads
///     0 and for `sell` reads 2; a full SWAP of the two tags keeps both counts
///     at 1 and dies on the declaration-region clause instead.
///   - a `cfg_attr`-wrapped or renamed reducer attribute, which would make a
///     reducer INVISIBLE to the extractor (silently absent from the set) rather
///     than a loud parse ambiguity.
///
/// HONEST LIMIT: source scan. It says the call is written, is qualified, is
/// tagged and is in the right reducer; it cannot say the call runs, that nothing
/// above it returns early, or that it runs before the write. Reachability and
/// ordering are pinned beside each reducer (`battle_tests.rs` /
/// `economy_tests.rs`, clauses C/D/H/I there), and polarity is proven by
/// executing the reducers under the native host in those same files.
#[test]
fn rb46_gated_reducer_census_battle_and_economy() {
    let call = m22s5_gate_call_needle();
    let bare = m22s5_gate_bare_name();
    let dq = double_quote();
    let attr = rb46_reducer_attr();
    let names = rb46_gated_names();

    let bypass: [(String, &str); 7] = [
        (
            ["crate::accounts::is_pending_", "deletion("].concat(),
            "the accounts-side context predicate",
        ),
        (
            ["should_reject_for_", "deletion("].concat(),
            "the pure SSOT decision",
        ),
        (
            ["ctx.db.acc", "ount("].concat(),
            "a direct account-table read",
        ),
        (
            ["crate::accounts::refuses_commitment_", "opened_at("].concat(),
            "the stamp-aware accounts-side context predicate (rb-47) — reachable from a \
             reducer file ONLY through the guards wrapper",
        ),
        (
            ["opened_commitment_is_", "refused("].concat(),
            "the pure stamp-aware decision (rb-47)",
        ),
        (
            ["cfg_", "attr("].concat(),
            "a conditional-compilation attribute wrapper (census camouflage)",
        ),
        (
            ["::reducer", "as"].concat(),
            "a renamed reducer-attribute import (census camouflage)",
        ),
    ];

    let files: [(&str, &str, [&str; 2]); 2] = [
        (
            "battle.rs",
            RB46_BATTLE_RS,
            [names[0].as_str(), names[1].as_str()],
        ),
        (
            "economy.rs",
            RB46_ECONOMY_RS,
            [names[2].as_str(), names[3].as_str()],
        ),
    ];

    for (label, src, expect) in files {
        let squashed = m22s5_stripped_squashed(label, src);
        let bodies = m22s5_reducer_bodies(label, &squashed);

        // --- anti-vacuity: both expected reducers must EXIST ----------------
        for name in expect {
            let declared = bodies.iter().any(|(n, _)| n.as_str() == name);
            assert!(
                declared,
                "rb-46 R-m22-s5-X12 FAIL (census anti-vacuity): `{label}` declares no \
                 reducer named `{name}`, so every claim below about it would pass over a \
                 reducer that does not exist. Either it was renamed — in which case decide \
                 DELIBERATELY whether the new name opens a commitment and update this list \
                 and ADR-0236 D1 together — or the extractor stopped seeing it, which is a \
                 scan defect to investigate rather than a list to shorten."
            );
        }

        // --- the SET ---------------------------------------------------------
        let found: std::collections::BTreeSet<String> = bodies
            .iter()
            .filter(|(_, body)| body.contains(call.as_str()))
            .map(|(n, _)| n.clone())
            .collect();
        let expected: std::collections::BTreeSet<String> =
            expect.iter().map(|n| (*n).to_string()).collect();
        let missing: Vec<&String> = expected.difference(&found).collect();
        let extra: Vec<&String> = found.difference(&expected).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "rb-46 R-m22-s5-X12 FAIL (gated-reducer census): the set of `{label}` reducers \
             carrying the deletion gate is wrong. Missing: {missing:?}. Unexpectedly gated: \
             {extra:?}. Found: {found:?}. Expected: {expected:?}. \
             AT HEAD the found set is EMPTY — that is the red state, and it is what this \
             slice exists to fix. \
             IF YOU ADDED A REDUCER that OPENS a new commitment (a battle, a purchase, a \
             sale), gate it and add its name here. IF YOU ADDED ONE THAT DOES NOT, leave it \
             open deliberately and say why in the slice notes. Never delete a name from the \
             expected set to make a build green: under-gating lets a mid-grace or terminal \
             account open new commitments the deletion cascade will then have to unwind, \
             and over-gating traps a deleting player inside a battle they can no longer \
             finish or flee. Only this SET assertion can tell the two apart."
        );

        // --- the whole-file bare-name count ---------------------------------
        let n_bare = squashed.matches(bare.as_str()).count();
        assert_eq!(
            n_bare, 2,
            "rb-46 R-m22-s5-X12 FAIL (call-site count): `{label}` mentions the deletion-gate \
             wrapper {n_bare} time(s) and must mention it EXACTLY twice — once per gated \
             reducer in this file. ZERO is the RED STATE AT HEAD. The SET assertion above \
             reads REDUCER BODIES only, so this whole-file count is what additionally \
             catches a gate call hoisted into a private helper (where the body-keyed set \
             cannot attribute it), a second call duplicated inside one body, and a \
             differently-named sibling wrapper — the needle is the BARE NAME, so an alias \
             binding or a re-export is counted here too. \
             SCOPE, since rb-76 (ADR-0246): the SUBJECT-parameterised sibling this file's \
             `rb76_subject_gate_and_begin_encounter_are_contained_crate_wide` contains has a \
             PREFIX-FREE bare name, so it can neither raise nor lower this number. If this \
             count ever reads three in `battle.rs`, it is a real third call site of the \
             CALLER-ONLY wrapper — investigate it; it is not the rb-76 gate."
        );

        // --- the bypass bans (green at HEAD; keep them green) ----------------
        for (needle, what) in &bypass {
            let n = squashed.matches(needle.as_str()).count();
            assert_eq!(
                n, 0,
                "rb-46 R-m22-s5-X12 FAIL (bypass ban): `{label}` reaches {what} directly {n} \
                 time(s) and must reach it ZERO times. Every gated reducer goes through the \
                 shared caller-only wrapper, and that is what makes the census above mean \
                 anything: a reducer that consults the deletion predicate itself is gated by \
                 a rule no fence in this crate constrains — it can invert the polarity, log \
                 nothing, or run after the write, and the SET assertion would still report \
                 it as gated. The last two needles close the extractor's camouflage class: \
                 a conditional-compilation attribute wrapper or a renamed attribute import \
                 makes a whole reducer INVISIBLE to the body extractor, which is a silent \
                 absence rather than a loud parse failure. The two rb-47 needles ban the \
                 stamp-aware seam on the same reasoning, and its ctx-bound half is the \
                 sharper hazard: it takes an IDENTITY, so a direct call can answer about a \
                 third party. All seven are ZERO at HEAD."
            );
        }
    }

    // --- the log tag, on the string-BEARING view -----------------------------
    let tag_cases: [(&str, &str, &str); 4] = [
        ("battle.rs", RB46_BATTLE_RS, names[0].as_str()),
        ("battle.rs", RB46_BATTLE_RS, names[1].as_str()),
        ("economy.rs", RB46_ECONOMY_RS, names[2].as_str()),
        ("economy.rs", RB46_ECONOMY_RS, names[3].as_str()),
    ];

    for (label, src, tag) in tag_cases {
        let squashed = m22s5_comments_only_squashed(label, src);

        // Both closing forms are accepted. The INLINE form is the expected one:
        // `fn_call_width` (60) bounds the ARGUMENT LIST, not the whole call
        // expression (`raising.rs:680` is the in-tree counter-example — a
        // 67-column call kept inline on 52 columns of arguments), and the widest
        // argument list among these four sites is 24 columns. The trailing-comma
        // form is accepted only as future-proofing against a rename long enough
        // to push an argument list past that width.
        let plain = [call.as_str(), "ctx,", dq.as_str(), tag, dq.as_str(), ")?;"].concat();
        let trailing = [call.as_str(), "ctx,", dq.as_str(), tag, dq.as_str(), ",)?;"].concat();

        let n =
            squashed.matches(plain.as_str()).count() + squashed.matches(trailing.as_str()).count();
        assert_eq!(
            n, 1,
            "rb-46 R-m22-s5-X12 FAIL (call-site tag): `{label}` contains {n} deletion-gate \
             call site(s) tagged for `{tag}`; it must contain EXACTLY ONE. ZERO is the RED \
             STATE AT HEAD. This is the only pin in this test evaluated with string payloads \
             INTACT — every other view blanks them, which renders all four call sites \
             byte-identical and a swapped tag invisible. One wrapper serves all four \
             reducers, so the tag is the ONLY record of which commitment was actually \
             refused; a wrong tag files the reject under a sibling reducer's name and the \
             operator's log points at the wrong place. The trailing `?;` is part of the pin: \
             a discarded result compiles, lints clean and gates nothing. Expected (squashed, \
             the inline form rustfmt produces here): {plain:?}"
        );

        // The site must sit inside its OWN reducer's declaration region — from
        // that reducer's declaration to the next reducer attribute in the file.
        // The region is a SUPERSET of the body (private helpers declared between
        // two reducers fall inside it), which is deliberate: it needs no brace
        // matching, and brace matching is unsound on this view — string payloads
        // survive here, and the format braces in `battle.rs`'s log lines balance
        // only by accident (recorded at `battle_tests.rs:1414-1422`). Combined
        // with the SET assertion above, which reads real bodies on the
        // payload-blanked view, a call parked in a helper is still caught.
        let site = squashed
            .find(plain.as_str())
            .or_else(|| squashed.find(trailing.as_str()))
            .unwrap_or_else(|| {
                panic!(
                    "rb-46 R-m22-s5-X12 FAIL (call-site tag): the tagged site for `{tag}` \
                     counted 1 in `{label}` but could not be located. This is a scan defect \
                     — investigate the view, never relax the pin."
                )
            });

        let decl = ["pubfn", tag, "("].concat();
        let n_decl = squashed.matches(decl.as_str()).count();
        assert_eq!(
            n_decl, 1,
            "rb-46 R-m22-s5-X12 FAIL (tag region anchor): `{label}` declares `{tag}` \
             {n_decl} time(s) in the squashed comments-only view; it must declare it EXACTLY \
             once. With zero the reducer was renamed or its visibility changed and the region \
             below cannot be built; with two the region extractor takes the FIRST match, so a \
             decoy declaration could host the tagged call while the real reducer stays \
             ungated."
        );
        let decl_at = squashed
            .find(decl.as_str())
            .expect("rb-46: the reducer declaration counted 1 but could not be located");
        let region_end = squashed[decl_at..]
            .find(attr.as_str())
            .map_or(squashed.len(), |off| decl_at + off);
        assert!(
            site > decl_at && site < region_end,
            "rb-46 R-m22-s5-X12 FAIL (tag belongs to its own reducer): in `{label}` the call \
             site tagged `{tag}` sits at squashed offset {site}, OUTSIDE that reducer's own \
             declaration region ({decl_at}..{region_end}). This is the clause that kills a \
             tag SWAP — two gated reducers exchanging each other's tags keeps every count in \
             this test at one while both rejects are filed under the wrong reducer, so no \
             count can see it. A tag is not decoration: the wrapper is shared, and the tag is \
             the operator's only record of which commitment a deletion-gated caller was \
             refused."
        );
    }
}

// ===========================================================================
// rb-76 (residual R-rb-46-GRASSPATH, ADR-0246) — the scheduler-opened grass-path
// wild encounter is a GATED commitment, refused for a mid-grace or terminal
// WALKER through the crate's first identity-PARAMETERISED deletion wrapper.
//
// EARS criterion encoded by this block:
//
//   R-rb-46-GRASSPATH  WHILE the WALKING PLAYER's account is inside the para-4.7
//                      deletion gate, WHEN the scheduled `movement_tick` opens a
//                      grass encounter for that player, the server module SHALL
//                      refuse the encounter before any write, keyed on the
//                      SERVER-DERIVED walker identity — never on `ctx.sender()`,
//                      which on the scheduler path is the MODULE identity and
//                      would make a caller-only gate answer about an account no
//                      player owns.
//
// WHY A SECOND WRAPPER, AND WHY IT CANNOT REUSE THE m22-s5 ONE.
// `require_not_deleting` is caller-only BY SIGNATURE (ADR-0227 D2): it takes no
// identity, so no call site can ever point it at a third party. That structural
// guarantee is exactly what makes it useless on the scheduler path, where the
// caller IS the database. ADR-0246 D2 therefore ships a sibling that takes the
// SUBJECT as a parameter and consequently CANNOT claim that guarantee. Two
// things replace it, and both live below:
//   * the whole-body byte pin plus the exact signature
//     (`rb76_subject_gate_wrapper_is_declared_once_fused_and_unconditional`),
//     which is what stops the parameterised wrapper from growing a second
//     behaviour or a conditional-compilation switch;
//   * a CRATE-WIDE containment census
//     (`rb76_subject_gate_and_begin_encounter_are_contained_crate_wide`), which
//     is what stops a SECOND consumer pointing it at a counterparty — the
//     deletion-status oracle ADR-0227 D4 forbids.
// The executed matrix (`rb76_subject_gate_answers_from_the_named_subject`) is
// the third leg: it proves the wrapper answers from the NAMED SUBJECT rather
// than from `ctx.sender()` or from the table, which no source scan can see.
//
// RED STATE OF THIS BLOCK AT HEAD:
//   * `rb76_subject_gate_wrapper_is_declared_once_fused_and_unconditional` —
//     RED: the wrapper is declared ZERO times in `guards.rs`, so the very first
//     clause fails and body extraction would fail LOUD behind it.
//   * `rb76_subject_gate_and_begin_encounter_are_contained_crate_wide` — RED:
//     the anti-vacuity count of the new bare name in `guards.rs` is 0 and must
//     be 1, and the accounts-predicate count there is 1 and must be 2. Every
//     BAN clause in that test is GREEN at HEAD by design (nothing names a
//     symbol that does not exist yet) and must stay green afterwards.
//   * `rb76_subject_gate_answers_from_the_named_subject` — COMPILE-RED: the
//     symbol does not exist, so `crate::guards::require_subject_not_deleting`
//     does not resolve and the crate's test build fails. That is the established
//     house precedent for a new seam (`content_cache_tests.rs:14-25`, the 11r-g
//     `json_escape` block above). It is fenced by the
//     `rb76-compile-red-begin` / `rb76-compile-red-end` markers so the
//     assertion-RED of the other five tests can be recorded at HEAD with it
//     temporarily excised.
//
// SCAN SUBSTRATE RULES honoured throughout, exactly as in the m22-s5 and rb-46
// blocks above (breaking them breaks OTHER slices' gates, not this one): every
// needle naming a production symbol is assembled from fragments, no raw
// double-quote CHARACTER literal is written anywhere, and no block-comment
// marker is ever spelled contiguously.
// ===========================================================================

/// The crate root, for the rb-76 crate-wide containment census. `lib.rs` is a
/// module file like any other — it declares reducers of its own — so it is
/// SCANNED as well as parsed for the `mod` roster.
const RB76_LIB_RS: &str = include_str!("lib.rs");

/// The bare name of the new subject-parameterised wrapper (ADR-0246 D2).
///
/// The BARE name is the census needle on purpose: a `use` alias, a re-export, a
/// function-pointer binding and a fully-qualified call all mention it, while a
/// needle anchored on `crate::guards::` would see only the last of the four.
fn rb76_subject_gate_bare_name() -> String {
    ["require_subject_not_", "deleting"].concat()
}

/// The squashed declaration marker of the new wrapper.
fn rb76_subject_gate_marker() -> String {
    ["fnrequire_subject_not_", "deleting("].concat()
}

/// The accounts-side context predicate, by bare name — the seam whose
/// crate-wide containment ADR-0246 closes in passing (it takes an IDENTITY, so
/// any module that calls it directly is a deletion-status oracle about whatever
/// account it names).
fn rb76_accounts_predicate_bare_name() -> String {
    ["is_pending_", "deletion"].concat()
}

/// The grass-path choke point both wild-encounter callers share, as a CALL
/// (the trailing paren keeps the `use crate::battle::{begin_encounter, ..}`
/// import binding out of the count — that binding is pinned separately).
fn rb76_begin_encounter_call() -> String {
    ["begin_", "encounter("].concat()
}

/// Comments-stripped, string-blanked, whitespace-squashed view of an ARBITRARY
/// module in this crate.
///
/// Deliberately NOT [`m22s5_stripped_squashed`], and the difference is
/// load-bearing rather than stylistic: that helper additionally asserts there is
/// no brace CHAR literal and that braces balance, because its caller
/// brace-MATCHES reducer bodies. `privacy.rs` legitimately spells `'{'` and
/// `'}'` as char literals all through its hand-rolled JSON builder, so those two
/// preconditions would fail LOUD on a file this census only ever substring-counts.
/// The stripping pipeline itself is this file's own
/// [`strip_comments_and_strings`] and [`m22s5_squash`], byte-for-byte — no
/// second stripper is introduced (ADR-0003).
///
/// The two preconditions that DO matter for a substring count are kept, through
/// this file's own [`m22s5_assert_source_is_scannable`]: a raw-string opener
/// with three or more hashes (which the byte-sequential stripper mis-parses) and
/// unbalanced block-comment markers (which make the stripper swallow real code
/// and turn every ban below silently vacuous).
fn rb76_module_squashed(label: &str, src: &str) -> String {
    m22s5_assert_source_is_scannable(label, src);
    m22s5_squash(&strip_comments_and_strings(src))
}

/// Every module `lib.rs` declares, MINUS `guards` (which HOLDS the wrapper and
/// is therefore scanned separately, with its own exact counts) and minus the
/// `#[path]`-included sibling test modules (whose names all end in `tests`),
/// PLUS the crate root itself.
///
/// `accounts` and `schema` are deliberately IN the list, unlike the rb-47
/// roster this helper is copied from: rb-76's bans are about the new
/// subject-keyed wrapper and about `begin_encounter`, neither of which either
/// module may name, and `accounts` additionally carries the only sanctioned
/// declaration of the deletion predicate so it doubles as an anti-vacuity anchor.
///
/// Line-oriented over the comment-blanked view, mirroring
/// `trading_tests.rs`'s `rb47_scanned_module_names` and
/// `accounts_tests.rs`'s `m22_declared_mod_names` — COPIED, never imported, per
/// this crate's local-machinery-per-module convention (the same call ADR-0166
/// recorded as residual R5). A commented-out `mod` is invisible, `pub mod` and
/// `pub(crate) mod` are both seen, and an inline `mod x { .. }` block declares
/// no FILE so it is correctly ignored (no trailing semicolon). The comments-only
/// view is deliberate: it preserves every newline byte-for-byte, which a
/// line-oriented parse depends on.
///
/// DERIVED, never enumerated. A hand-written roster is exactly the hole this
/// closes: the next module added to the crate would simply not be on it.
fn rb76_scanned_module_names() -> Vec<String> {
    let clean = m22s5_strip_comments_only(RB76_LIB_RS);
    let mut out: Vec<String> = vec!["lib".to_string()];
    for line in clean.lines() {
        let mut text = line.trim();
        if let Some(rest) = text.strip_prefix("pub(crate)") {
            text = rest.trim_start();
        } else if let Some(rest) = text.strip_prefix("pub ") {
            text = rest.trim_start();
        }
        let Some(rest) = text.strip_prefix("mod ") else {
            continue;
        };
        let Some(name) = rest.trim().strip_suffix(';') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        if name.ends_with("tests") || name == "guards" {
            continue;
        }
        out.push(name.to_string());
    }
    out.sort();
    out.dedup();
    out
}

/// For every path-relocating attribute in `lib.rs`, the name of the `mod` it
/// relocates — or an EMPTY string when the attribute is not followed by a module
/// declaration at all.
///
/// THE HOLE THIS EXISTS FOR. [`rb76_scanned_module_names`] maps a declared name
/// `x` to the file `src/x.rs`. A path-relocating attribute breaks that mapping:
/// `mod battle;` relocated to some other file would make this census read
/// `battle.rs` while the compiler reads something else, so every count below
/// would be about a file the crate does not build. Today every such attribute in
/// `lib.rs` relocates a `*tests` module — which the roster excludes anyway — and
/// this helper is what keeps that true.
///
/// The attribute marker is assembled from fragments, like every other needle in
/// this file. Attribute and blank lines between the attribute and the
/// declaration are skipped (the conditional-compilation attribute sits above the
/// path attribute in three of the four live cases, and below it in none).
/// ASSUMES the attribute and its `mod` declaration sit on SEPARATE lines (true
/// of all four live cases); a single-line `#[path = ..] mod x;` would be read as
/// an attribute whose target is the NEXT declaration — extend the parser before
/// writing one.
fn rb76_path_attribute_targets() -> Vec<String> {
    let clean = m22s5_strip_comments_only(RB76_LIB_RS);
    let attr = ["#", "[path"].concat();
    let lines: Vec<&str> = clean.lines().collect();
    let mut out: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if !line.trim_start().starts_with(attr.as_str()) {
            continue;
        }
        let mut target = String::new();
        let mut j = i + 1;
        while j < lines.len() {
            let mut text = lines[j].trim();
            if text.is_empty() || text.starts_with('#') {
                j += 1;
                continue;
            }
            if let Some(rest) = text.strip_prefix("pub(crate)") {
                text = rest.trim_start();
            } else if let Some(rest) = text.strip_prefix("pub ") {
                text = rest.trim_start();
            }
            if let Some(rest) = text.strip_prefix("mod ") {
                if let Some(name) = rest.trim().strip_suffix(';') {
                    target = name.trim().to_string();
                }
            }
            break;
        }
        out.push(target);
    }
    out
}

/// **ADR-0246 D2 (declaration)** — the subject gate exists EXACTLY once, with
/// the exact signature, and its body IS the fused delegation and nothing else.
///
/// WHY EACH CLAUSE, AND WHAT IT KILLS:
///
///   * DECLARED ONCE — zero is the RED STATE AT HEAD and is what this slice
///     exists to fix; two lets the body extractor take the FIRST match, so a
///     decoy definition could carry the delegation while the shipped one
///     re-derives the account-state disjunction.
///   * THE EXACT SQUASHED SIGNATURE — the parameter LIST is the security
///     surface of this wrapper. Its caller-only sibling takes no identity at
///     all (ADR-0227 D2), so its signature carries the guarantee; this one
///     takes a subject, so the signature is instead what pins that it takes
///     exactly ONE identity, by value, and returns the same `Result<(), String>`
///     shape every gated call site propagates with `?`. A second identity
///     parameter, an `Option<Identity>`, or a `bool` return would each be a
///     different contract wearing the same name.
///   * WHOLE-BODY EQUALITY — the tooth. `contains` is satisfied by a body that
///     computes the fused call and then negates it, rebinds it, diverts around
///     it, or appends a recovery combinator that converts every reject back into
///     success. That last shape is not hypothetical: it is a MEASURED CI-green
///     bypass of the m22-s5 wrapper, recorded at
///     `m22s5_gate_delegates_fused_and_unconditional` above, and a prefix pin
///     alone could not see it. Whole-body equality rejects leading AND trailing
///     text of any spelling.
///   * NO ALWAYS-FALSE CONDITIONAL, NO CONDITIONAL-COMPILATION ATTRIBUTE, NO
///     CONDITIONAL-COMPILATION MACRO — the unconditional claim's three standard
///     evasions. The attribute form in particular keeps the exact statement text
///     in the file and in every source scan while compiling it OUT of the
///     shipped wasm: present in review, absent in production (the ADR-0189
///     red-team F3 finding).
///   * NO LOGGING, IN EITHER SPELLING — this is the one place this wrapper
///     deliberately DIFFERS from both siblings, and the ban is the decision.
///     `begin_encounter`'s contract gives observability to the CALLER, and the
///     grass path calls it at tick rate: a warn per refused encounter is roughly
///     one per second per deleting walker for the whole seven-day grace window,
///     an unbounded client-triggered emitter that would also retain the
///     identities of accounts the cascade is about to erase (ADR-0246 D2; the
///     rate-limited alternative is what `movement.rs` already owns for the
///     arms that SHOULD log). A `log_reject(` here would additionally need a
///     reducer TAG, and there is no reducer name to give it — the refusing
///     frame is a scheduler tick.
///   * PREFIX-FREENESS AGAINST BOTH SIBLINGS — asserted in BOTH directions, not
///     as mere inequality. Every deletion-gate census in this crate counts a
///     BARE NAME as a substring: `rb46_gated_reducer_census_battle_and_economy`
///     pins `require_not_deleting` at exactly two occurrences in `battle.rs`,
///     and `m22s5_already_open_reducers_are_not_gated` pins it at zero inside
///     nine reducer bodies. A new name CONTAINING either sibling's name would
///     silently inflate every one of those counts and force somebody to "fix"
///     a correct number; a name CONTAINED BY one would be invisible to its own
///     census. This clause is what makes the census arithmetic in both files
///     stay true without either of them being edited.
///   * THE ADR-0227 D2 WITNESS — the caller-only sibling's full squashed
///     signature, counted once. This slice's whole argument is that the
///     structural caller-only guarantee is SIGNATURE-BORNE and is NOT claimed
///     for the new wrapper. If somebody later adds an identity parameter to the
///     caller-only one, that argument evaporates and every containment claim
///     here is about the wrong world — so the premise is pinned, here, where the
///     reader is standing.
///
/// RED AT HEAD: the declaration count is ZERO and the first assertion names it.
/// The prefix-freeness clause and the ADR-0227 D2 witness are GREEN at HEAD by
/// design (they are properties of names that already exist) and must stay green.
///
/// HONEST LIMIT: source scan. It says the wrapper is written, is fused, is
/// unconditional and is silent; it cannot say it DECIDES correctly. That is
/// `rb76_subject_gate_answers_from_the_named_subject` below, which executes it.
#[test]
fn rb76_subject_gate_wrapper_is_declared_once_fused_and_unconditional() {
    let squashed = m22s5_stripped_squashed("guards.rs", GUARDS_RS);
    let marker = rb76_subject_gate_marker();

    let n_decl = squashed.matches(marker.as_str()).count();
    assert_eq!(
        n_decl, 1,
        "rb-76 ADR-0246 D2 FAIL (declared exactly once): `guards.rs` declares the \
         subject-parameterised deletion wrapper {n_decl} time(s) and must declare it \
         EXACTLY ONCE. ZERO IS THE RED STATE AT HEAD — the wrapper does not exist yet, \
         so a mid-grace or terminal walker still opens a grass-path wild battle that the \
         para-4.4 cascade will later have to boot. TWO would let the body extractor below \
         take the FIRST match, so a decoy definition could carry the byte-pinned \
         delegation while the shipped one re-derives the account-state disjunction \
         `accounts` owns."
    );

    // --- the exact signature -------------------------------------------------
    // Both param-list forms are accepted. The declaration line is 106 columns, so
    // rustfmt breaks the parameters vertically exactly as it does for
    // `require_commitment_predates_deletion`; the squashed view is whitespace-free,
    // which makes that break invisible, and the trailing-comma form is what a
    // vertical break leaves behind.
    let sig_plain = [
        "pub(crate)fnrequire_subject_not_",
        "deleting(ctx:&Reducer",
        "Context,subject:Identity)->Result<(),String>{",
    ]
    .concat();
    let sig_trailing = [
        "pub(crate)fnrequire_subject_not_",
        "deleting(ctx:&Reducer",
        "Context,subject:Identity,)->Result<(),String>{",
    ]
    .concat();
    let n_sig = squashed.matches(sig_plain.as_str()).count()
        + squashed.matches(sig_trailing.as_str()).count();
    assert_eq!(
        n_sig, 1,
        "rb-76 ADR-0246 D2 FAIL (signature): `guards.rs` carries {n_sig} declaration(s) of \
         the subject gate with the sanctioned signature; it must carry EXACTLY ONE. ZERO is \
         the RED STATE AT HEAD. The PARAMETER LIST is this wrapper's entire security \
         surface: its caller-only sibling takes no identity at all, so ADR-0227 D2's \
         guarantee is carried by that sibling's signature, and this one — which takes a \
         subject — can only be held to taking exactly ONE identity, by value, and returning \
         the same `Result<(), String>` every gated call site propagates with the try \
         operator. A second identity parameter, an optional subject, a `bool` return or a \
         borrowed identity would each be a DIFFERENT contract wearing the same name, and \
         every containment count in this file would still read correct. Expected (squashed, \
         inline form): {sig_plain:?}"
    );

    let body = m22s5_squashed_fn_body(&squashed, marker.as_str()).unwrap_or_else(|| {
        panic!(
            "rb-76 ADR-0246 D2 FAIL (extraction): the subject gate is declared in \
             `guards.rs` but its brace-bounded body could not be sliced. Either the braces \
             are unbalanced from the declaration onward, or the declaration is followed by \
             something other than a body. Fail LOUD: a pin that silently skips when its \
             anchor moves is worth nothing."
        )
    });

    // --- whole-body equality -------------------------------------------------
    let fused_plain = [
        "deletion_gate(crate::accounts::is_pending_",
        "deletion(ctx,subject",
    ]
    .concat();
    let fused_trailing = [
        "deletion_gate(crate::accounts::is_pending_",
        "deletion(ctx,subject,",
    ]
    .concat();
    let tail = [")).map_err(|e|e.to", "_string())"].concat();
    let body_plain = [fused_plain.as_str(), tail.as_str()].concat();
    let body_trailing = [fused_trailing.as_str(), tail.as_str()].concat();
    assert!(
        body == body_plain || body == body_trailing,
        "rb-76 ADR-0246 D2 FAIL (whole-body equality): the subject gate's body must BE the \
         fused delegation into the accounts SSOT, mapped straight onto the module's single \
         static reason, byte-for-byte in the squashed view, with NOTHING before it and \
         NOTHING after it. \
         WHAT LEADING TEXT KILLS: a short-circuit return above the delegation deadens the \
         gate for every real caller while the delegation text survives every containment \
         needle — a MEASURED CI-green bypass of the sibling seam, recorded at \
         `m22s5_is_pending_deletion_delegates_to_should_reject` above. \
         WHAT TRAILING TEXT KILLS: a recovery combinator appended after the mapping closure \
         converts every reject the gate produces back into success, and a prefix pin cannot \
         see it — also MEASURED, at `m22s5_gate_delegates_fused_and_unconditional`. \
         WHAT THE MAPPING PINS: the reject leaves as the module's ONE static reason, so the \
         wrapper never learns the mid-grace / terminal state split that PRV1-10 keeps in \
         `accounts`. Expected (squashed): {body_plain:?}. Got: {body:?}"
    );

    // --- unconditional -------------------------------------------------------
    let if_false = ["if", "false"].concat();
    let n_if_false = body.matches(if_false.as_str()).count();
    assert_eq!(
        n_if_false, 0,
        "rb-76 ADR-0246 D2 FAIL (unconditional): the subject gate's body contains \
         {n_if_false} always-false conditional(s) and must contain ZERO. A never-taken \
         branch leaves every needle in this test satisfiable while the gate decides nothing \
         for anybody."
    );

    let attr_open = ["#", "["].concat();
    let n_attr = body.matches(attr_open.as_str()).count();
    assert_eq!(
        n_attr, 0,
        "rb-76 ADR-0246 D2 FAIL (unconditional): the subject gate's body carries {n_attr} \
         attribute(s) and must carry ZERO. A conditional-compilation attribute keeps the \
         exact statement text in the file and in every source scan while compiling it OUT \
         of the shipped wasm — the gate would be present in review and absent in \
         production, and the executed matrix below would run it happily because tests build \
         with the test configuration."
    );

    let cfg_macro = ["cfg", "!("].concat();
    let n_cfg = body.matches(cfg_macro.as_str()).count();
    assert_eq!(
        n_cfg, 0,
        "rb-76 ADR-0246 D2 FAIL (unconditional): the subject gate's body uses the \
         conditional-compilation MACRO {n_cfg} time(s) and must use it ZERO times. Same \
         defect as the attribute form in the clause above, reached through an expression \
         instead of an attribute, and the whole-body equality clause names it only as a \
         byte difference — this clause is what says WHY."
    );

    // --- the non-logging decision (ADR-0246 D2) ------------------------------
    let log_path = ["log", "::"].concat();
    let n_log_path = body.matches(log_path.as_str()).count();
    assert_eq!(
        n_log_path, 0,
        "rb-76 ADR-0246 D2 FAIL (non-logging): the subject gate's body reaches the logging \
         facade {n_log_path} time(s) and must reach it ZERO times. This wrapper is SILENT \
         BY DECISION, and that is the one place it deliberately differs from both siblings. \
         The grass path calls it at TICK RATE: a line per refused encounter is roughly one \
         per second per deleting walker for the whole seven-day grace window — an unbounded \
         CLIENT-TRIGGERED emitter that also retains, in the operator's log, the identities \
         of accounts the deletion cascade is about to erase. `begin_encounter`'s contract \
         gives observability to its CALLER, and `movement.rs` already owns the \
         rate-limited arms for the failures that SHOULD be reported."
    );

    let log_call = ["log_re", "ject("].concat();
    let n_log_call = body.matches(log_call.as_str()).count();
    assert_eq!(
        n_log_call, 0,
        "rb-76 ADR-0246 D2 FAIL (non-logging): the subject gate's body calls the shared \
         reject logger {n_log_call} time(s) and must call it ZERO times. Beyond the \
         tick-rate flood the clause above describes, this spelling cannot even be written \
         honestly here: the reject logger takes a reducer TAG, and the refusing frame is a \
         SCHEDULER TICK with no reducer name to give it — every candidate tag would be a \
         fiction filed under somebody else's reducer."
    );

    // --- prefix-freeness against both siblings (green at HEAD) ---------------
    let new_bare = rb76_subject_gate_bare_name();
    let sibling_caller = ["require_not_", "deleting"].concat();
    let sibling_stamp = ["require_commitment_predates_", "deletion"].concat();
    for sibling in [sibling_caller.as_str(), sibling_stamp.as_str()] {
        assert!(
            !new_bare.contains(sibling) && !sibling.contains(new_bare.as_str()),
            "rb-76 ADR-0246 D2 FAIL (prefix-freeness): the subject gate's bare name and the \
             existing wrapper `{sibling}` contain one another. Every deletion-gate census in \
             this crate counts a BARE NAME as a SUBSTRING — \
             `rb46_gated_reducer_census_battle_and_economy` in this file pins the caller-only \
             name at exactly two occurrences in `battle.rs`, and \
             `m22s5_already_open_reducers_are_not_gated` pins it at zero inside nine reducer \
             bodies. A containing name silently inflates every one of those counts and forces \
             somebody to 'fix' a number that was right; a contained name is invisible to its \
             own census. GREEN AT HEAD and after the slice — this is a constraint on the NAME \
             CHOICE, and the remedy when it fires is to rename the new wrapper, never to \
             relax a sibling's count."
        );
    }

    // --- the ADR-0227 D2 premise this whole slice rests on (green at HEAD) ---
    let d2_witness = [
        "fnrequire_not_",
        "deleting(ctx:&ReducerContext,reducer:&str)->Result<(),String>",
    ]
    .concat();
    let n_d2 = squashed.matches(d2_witness.as_str()).count();
    assert_eq!(
        n_d2, 1,
        "rb-76 ADR-0246 D2 FAIL (premise witness): `guards.rs` declares the CALLER-ONLY \
         deletion wrapper with its no-identity signature {n_d2} time(s); it must declare it \
         EXACTLY ONCE. This slice's entire argument is that ADR-0227 D2's structural \
         caller-only guarantee is SIGNATURE-BORNE — it holds because that wrapper takes a \
         reducer tag and nothing else — and that the guarantee is therefore NOT claimed for \
         the subject-parameterised sibling, which is why containment for the sibling is a \
         crate-wide census instead. If somebody adds an identity parameter to the \
         caller-only wrapper, that premise evaporates and every containment claim in this \
         block is about a world that no longer exists. GREEN AT HEAD; it is pinned here, \
         beside the reasoning, rather than left implicit."
    );
}

/// **ADR-0246 D2/D3 (containment)** — the subject gate reaches exactly TWO
/// production files, `begin_encounter` reaches exactly two, and the
/// accounts-side deletion predicate stays inside its three sanctioned modules.
///
/// WHY A CENSUS AND NOT A SIGNATURE. The caller-only wrapper is contained BY
/// CONSTRUCTION: it has no identity parameter, so a second consumer can only
/// ever ask about its own caller. The subject-parameterised one has no such
/// defence — a call in `pvp.rs` keyed on the CHALLENGE TARGET would refuse a
/// challenge based on a stranger's account lifecycle state, which is both a
/// privacy leak and the D4 violation ADR-0227 argued through in full. Nothing
/// in the wrapper can prevent that; only a census over every module can see it.
///
/// FIVE CLAUSES, none of which the others can stand in for:
///
///   (a) THE SUBJECT GATE'S FOOTPRINT — `guards.rs` exactly 1 (the declaration;
///       the body does not recurse), `battle.rs` exactly 1 (the single call site
///       inside `begin_encounter`), every other scanned module exactly 0. The
///       needle is the BARE NAME, so an alias import, a re-export and a
///       function-pointer binding are all counted; a needle anchored on the
///       qualified path would see none of them.
///   (b) `begin_encounter`'s FOOTPRINT — `movement.rs` 1 (the grass-path call),
///       `battle.rs` 2 (the declaration plus the dev-only `start_wild_battle`
///       call), every other module 0. This is what makes clause (a) mean
///       something: gating the ONE choke point is only equivalent to gating the
///       grass path while that choke point has no third caller. A new caller
///       elsewhere in the crate would be a wild encounter opened outside the
///       gate, and the count is what forces it to be argued. `movement.rs` must
///       additionally carry the import BINDING exactly once — the grass path
///       calls the function unqualified, so the binding is the only text that
///       says which `begin_encounter` it is.
///   (c) THE ACCOUNTS PREDICATE — allowed only in `accounts` (which DECLARES it,
///       at least twice counting its own guest-claim consumer), `guards` (whose
///       two wrappers are its only sanctioned gameplay consumers, so exactly 2
///       after this slice) and `privacy` (exactly 1, the export gate). ZERO
///       everywhere else. It takes an IDENTITY: a module that calls it directly
///       chooses the subject and is gated by a rule NO fence in this crate
///       constrains — it can invert the polarity, refuse silently, or answer
///       about a third party. ADR-0227 D4 stated this for the caller-only
///       wrapper; ADR-0246 closes it crate-wide in passing, which is only
///       coherent because the three allowances are asserted as MINIMA, not
///       merely exempted.
///   (d) ANTI-VACUITY ON THE ROSTER — at least ten modules, eight of them named,
///       and an unreadable module PANICS by name rather than being skipped. A
///       ban applied to a short list is a ban that passes because it looked
///       nowhere, and skipping is how a census goes quietly blind.
///   (e) THE PATH-RELOCATION HOLE — this census maps a declared name `x` onto
///       the file `src/x.rs`. A path-relocating attribute breaks that mapping
///       silently: the census would read one file while the compiler reads
///       another, and every count above would be about a file the crate does not
///       build. Every such attribute in `lib.rs` must relocate a `*tests`
///       module, which the roster excludes anyway, and at least one must exist
///       so the check is not scanning for a spelling nothing uses.
///
/// RED AT HEAD: clause (a)'s anti-vacuity count in `guards.rs` is 0 and must be
/// 1, and clause (c)'s `guards.rs` count is 1 and must be 2. Every BAN in this
/// test is GREEN at HEAD — a symbol that does not exist is named nowhere — and
/// the whole point is that they stay green as the slice lands and as modules are
/// added afterwards.
///
/// kills:
///   - a SECOND consumer of the subject gate anywhere in the crate, including
///     the counterparty-keyed `pvp.rs` shape ADR-0227 D4 forbids, and including
///     one reached through a `use` alias or a function pointer;
///   - the gate wired into `movement.rs` directly instead of into the shared
///     choke point (clause (a) reads 1 in `movement.rs`, which must be 0);
///   - a new third caller of `begin_encounter` — a wild encounter opened outside
///     the gate, invisible to every pin in `battle_tests.rs`;
///   - a module reaching the accounts predicate itself to re-derive the gate;
///   - a path-relocated module that would make this whole census scan the wrong
///     files.
///
/// HONEST LIMIT: substring counts over a stripped view. The per-module
/// length floor catches a WHOLESALE blanking of a file (the class a stray
/// quote in a char literal produces), not a partial one; the load-bearing
/// files are each independently anchored by a POSITIVE count in this same
/// test — `guards.rs` by two, `battle.rs` by two, `movement.rs` by two,
/// `accounts` and `privacy` by their predicate minima, `lib.rs` by the roster
/// size — so a blanked file there is loud rather than silent.
/// HONEST LIMITS. (1) `guards.rs` and `lib.rs` are read at compile time
/// (`include_str!`) while the other rostered modules are read from disk at RUN
/// time (`std::fs::read_to_string`), so a stale test binary run over edited
/// sources reports on bytes it did not compile — relevant to mutation runners,
/// which must rebuild between rows. (2) Since rb-76, `lib.rs` is subject to the
/// scan-substrate preconditions (no deep raw string, balanced block-comment
/// markers): an edit there that trips them reds this test from outside the
/// slice's touch set, by design — it is a real stripper hazard in that file.
#[test]
fn rb76_subject_gate_and_begin_encounter_are_contained_crate_wide() {
    let bare = rb76_subject_gate_bare_name();
    let begin = rb76_begin_encounter_call();
    let predicate = rb76_accounts_predicate_bare_name();

    // --- (d) anti-vacuity on the derived roster ------------------------------
    let modules = rb76_scanned_module_names();
    assert!(
        modules.len() >= 10,
        "rb-76 ADR-0246 FAIL (containment, anti-vacuity): only {} module(s) were derived \
         from the crate root's `mod` declarations: {modules:?}. The crate declares far more \
         than ten. A short list means the line-oriented parse stopped matching — a block \
         comment swallowing declarations, a re-spelling, or a move of the module wiring — \
         and a ban applied to a short list is a ban that passes because it looked nowhere.",
        modules.len()
    );
    for required in [
        "trading", "pvp", "battle", "economy", "ranking", "privacy", "movement", "accounts",
    ] {
        assert!(
            modules.iter().any(|m| m.as_str() == required),
            "rb-76 ADR-0246 FAIL (containment, anti-vacuity): the derived module list does \
             not contain `{required}`; it is {modules:?}. These eight are named explicitly: \
             six own reducers that act between two players (where a counterparty-keyed \
             deletion-status oracle would be written), `movement` owns the grass path this \
             slice gates, and `accounts` owns the predicate clause (c) contains. A list \
             missing any of them is not scanning what this test claims to scan."
        );
    }

    // --- (e) the path-relocation hole ----------------------------------------
    let targets = rb76_path_attribute_targets();
    assert!(
        !targets.is_empty(),
        "rb-76 ADR-0246 FAIL (containment, anti-vacuity): `lib.rs` carries ZERO \
         path-relocating attributes, so this clause is scanning for a spelling that no \
         longer exists and would pass over any number of relocated modules. The crate \
         declares its sibling test modules that way today; if that wiring changed, this \
         check must be re-derived against the new shape, never deleted."
    );
    for target in &targets {
        assert!(
            target.ends_with("tests"),
            "rb-76 ADR-0246 FAIL (containment, path relocation): a path-relocating attribute \
             in `lib.rs` relocates `{target}` (an EMPTY name means the attribute is not \
             followed by a module declaration at all), and every one of them must relocate a \
             module whose name ends in `tests`. THE HOLE THIS CLOSES: this census maps a \
             declared name `x` onto the file `src/x.rs`. A relocated PRODUCTION module would \
             make every count in this test read a file the crate does not build — the bans \
             would all pass, over the wrong bytes, silently. Teach \
             `rb76_scanned_module_names` the path DELIBERATELY; never drop the module and \
             never widen this clause."
        );
    }

    // --- guards.rs: the declaring file, excluded from the bans below ---------
    let guards = rb76_module_squashed("guards.rs", GUARDS_RS);
    let n_guards_bare = guards.matches(bare.as_str()).count();
    assert_eq!(
        n_guards_bare, 1,
        "rb-76 ADR-0246 D2 FAIL (containment, anti-vacuity): the subject gate's bare name \
         matches `guards.rs` {n_guards_bare} time(s) and must match EXACTLY once — the \
         declaration. ZERO IS THE RED STATE AT HEAD, and it is what makes every ban below \
         currently vacuous: a census that bans a spelling nothing uses proves nothing at \
         all. TWO means the body recurses or a second wrapper appeared in the very file the \
         bans trust, which \
         `rb76_subject_gate_wrapper_is_declared_once_fused_and_unconditional` owns in full."
    );
    let n_guards_predicate = guards.matches(predicate.as_str()).count();
    assert_eq!(
        n_guards_predicate, 2,
        "rb-76 ADR-0246 D2 FAIL (containment, sanctioned consumers): `guards.rs` names the \
         accounts-side deletion predicate {n_guards_predicate} time(s) and must name it \
         EXACTLY twice — once in the caller-only wrapper, once in the subject-parameterised \
         one. ONE IS THE RED STATE AT HEAD (only the caller-only wrapper exists). THREE \
         would mean a third consumer appeared in the file that clause (c) exempts from its \
         crate-wide ban, which is the one place such a consumer could hide from it."
    );
    let n_guards_begin = guards.matches(begin.as_str()).count();
    assert_eq!(
        n_guards_begin, 0,
        "rb-76 ADR-0246 D2 FAIL (containment, caller census): `guards.rs` calls \
         `begin_encounter(` {n_guards_begin} time(s) and must call it ZERO times. `guards.rs` \
         is the one module the derived roster below exempts, so clause (b)'s per-module \
         count never sees it; this assertion closes that gap — a wild-battle opener hidden in \
         the guards module would otherwise be a third caller the census reports as absent."
    );

    // --- the derived modules -------------------------------------------------
    let root = env!("CARGO_MANIFEST_DIR");
    let import = ["usecrate::battle::{begin_", "encounter,"].concat();
    for name in &modules {
        let path = format!("{root}/src/{name}.rs");
        let src = std::fs::read_to_string(path.as_str()).unwrap_or_else(|err| {
            panic!(
                "rb-76 ADR-0246 FAIL (containment, unscanned module): `lib.rs` declares \
                 module `{name}` but its source could not be read at `{path}` ({err}). An \
                 unreadable module is an UNSCANNED module, and this census refuses to skip \
                 one: skipping is how a ban goes quietly blind. If the module is \
                 path-relocated, teach `rb76_scanned_module_names` the path — never drop \
                 the module."
            )
        });
        let squashed = rb76_module_squashed(name.as_str(), &src);
        let include_macro = ["inclu", "de!("].concat();
        let n_include = src.matches(include_macro.as_str()).count();
        assert_eq!(
            n_include, 0,
            "rb-76 ADR-0246 FAIL (containment, textual inclusion): `{name}.rs` pulls source in \
             with the `include!` macro {n_include} time(s) and must do so ZERO times. An \
             included fragment declares no `mod`, so it is invisible to this roster AND to the \
             crate's `mod`-line censuses — the artifact red-team MEASURED a counterparty-keyed \
             consumer of the subject gate hidden in such a fragment passing every clause here \
             CI-green. (`include_str!` is a different token and stays allowed — it embeds \
             data, not code.) Counted on the RAW source so a fragment in a string cannot hide \
             it either."
        );
        assert!(
            squashed.len() >= 200,
            "rb-76 ADR-0246 FAIL (containment, blanking canary): the stripped, squashed \
             view of `{name}.rs` is only {} byte(s) long. Every module in this crate is \
             hundreds of lines; a view this short means the stripping pipeline blanked the \
             file — a char literal holding a double quote inverts string/code polarity for \
             everything after it (guards_tests G-5a records the measured blast radius) — \
             and every count below would be a vacuous zero. Investigate the stripper \
             against that file; never relax a count downstream of this.",
            squashed.len()
        );

        // (a) the subject gate's footprint
        let want_bare = usize::from(name.as_str() == "battle");
        let n_bare = squashed.matches(bare.as_str()).count();
        assert_eq!(
            n_bare, want_bare,
            "rb-76 ADR-0246 D2/D3 FAIL (containment): `{name}.rs` names the \
             subject-parameterised deletion gate {n_bare} time(s) and must name it exactly \
             {want_bare} time(s). `battle.rs` is the ONE sanctioned consumer — the single \
             call inside `begin_encounter`, the choke point both wild-encounter callers \
             share (ADR-0246 D3) — and every other module must name it ZERO times. \
             AT HEAD `battle.rs` reads 0 and must read 1: that is the red half of this \
             clause and the wiring this slice exists to add. \
             A NON-ZERO COUNT ANYWHERE ELSE is the defect this census exists for: unlike \
             its caller-only sibling, this wrapper TAKES A SUBJECT, so a call site chooses \
             whose account it asks about. A counterparty-keyed call in `pvp.rs` would refuse \
             a challenge on the strength of a STRANGER's account lifecycle state — a privacy \
             leak and the ADR-0227 D4 violation restated by ADR-0246 — and it would red \
             nothing else in this slice: the wrapper is untouched, every pin on it still \
             passes, and the reducer would even behave 'sensibly'. The needle is the BARE \
             NAME, so an alias import, a re-export and a function-pointer binding are all \
             counted here."
        );

        // (b) the choke point's footprint
        let want_begin = match name.as_str() {
            "movement" => 1,
            "battle" => 2,
            _ => 0,
        };
        let n_begin = squashed.matches(begin.as_str()).count();
        assert_eq!(
            n_begin, want_begin,
            "rb-76 ADR-0246 D3 FAIL (choke point): `{name}.rs` calls `begin_encounter(` \
             {n_begin} time(s) and must call it exactly {want_begin} time(s). THE \
             ARITHMETIC: `battle.rs` 2 (the declaration plus the dev-only `start_wild_battle` \
             call), `movement.rs` 1 (the scheduled grass path), everything else 0. \
             WHY THIS CLAUSE EXISTS: gating the one choke point is equivalent to gating the \
             grass path ONLY while that choke point has no third caller. A new caller \
             anywhere in the crate is a wild-battle commitment opened somewhere this slice \
             never reasoned about, and NOTHING in `battle_tests.rs` would see it — the pins \
             there read `begin_encounter`'s own body, not who calls it. If a later slice \
             adds a legitimate caller, re-derive this number DELIBERATELY and re-argue the \
             gate's placement; never lower it to make a build green. GREEN AT HEAD."
        );

        if name.as_str() == "movement" {
            let n_import = squashed.matches(import.as_str()).count();
            assert_eq!(
                n_import, 1,
                "rb-76 ADR-0246 D3/D4 FAIL (import binding): `movement.rs` binds \
                 `begin_encounter` from the battle module {n_import} time(s) and must bind \
                 it EXACTLY once — squashed, `usecrate::battle::{{begin_encounter,`. The \
                 grass path calls the function UNQUALIFIED, so this binding is the only text \
                 in the file that says WHICH `begin_encounter` runs there. With zero, the \
                 call in clause (b) is resolving to something else — a file-local shim \
                 answering whatever it likes, which would route the whole grass path around \
                 the gate while every other count in this test stays correct. GREEN AT HEAD \
                 and it must stay green: ADR-0246 D4 changes the arm INSIDE the error \
                 handler, not the import."
            );
        }

        // (c) the accounts predicate's crate-wide containment
        let n_predicate = squashed.matches(predicate.as_str()).count();
        match name.as_str() {
            "accounts" => {
                assert_eq!(
                    n_predicate, 2,
                    "rb-76 ADR-0246 FAIL (predicate containment): `accounts.rs` names the \
                     context-bound deletion predicate {n_predicate} time(s) and must name it \
                     EXACTLY twice — the declaration plus its own guest-claim consumer. Fewer \
                     means the predicate was renamed or moved, so the crate-wide ban below is \
                     banning a spelling nothing uses and would pass over every module. MORE is \
                     the artifact red-team's MEASURED bypass: a `pub(crate) use \
                     is_pending_deletion as <alias>;` re-export (or a one-line wrapper fn) in \
                     this exempt file lets any other module consult the predicate about a \
                     third party under a name this census never spells — a floor of two \
                     admitted it CI-green. An exact count is what makes the exemption a \
                     boundary rather than a hole. GREEN AT HEAD."
                );
                let alias = ["useis_pending_", "deletion"].concat();
                let n_alias = squashed.matches(alias.as_str()).count();
                assert_eq!(
                    n_alias, 0,
                    "rb-76 ADR-0246 FAIL (predicate containment): `accounts.rs` re-exports or \
                     `use`-binds the context-bound deletion predicate {n_alias} time(s) and \
                     must do so ZERO times — a re-export is a second spelling of an \
                     identity-taking oracle that the bare-name census cannot see in the \
                     consuming module."
                );
            }
            "privacy" => assert_eq!(
                n_predicate, 1,
                "rb-76 ADR-0246 FAIL (predicate containment, anti-vacuity): `privacy.rs` \
                 names the context-bound deletion predicate {n_predicate} time(s) and must \
                 name it EXACTLY once — `request_data_export`'s PRV1-7 grace-window reject, \
                 the one sanctioned non-guards consumer in the crate. ZERO means that gate \
                 was removed or re-spelled and a mid-grace caller can export again; TWO \
                 means a second, unreviewed subject-choosing call appeared in the file this \
                 clause exempts. GREEN AT HEAD."
            ),
            _ => assert_eq!(
                n_predicate, 0,
                "rb-76 ADR-0246 FAIL (predicate containment): `{name}.rs` reaches the \
                 context-bound deletion predicate directly {n_predicate} time(s) and must \
                 reach it ZERO times. That predicate takes an IDENTITY: a module calling it \
                 itself chooses BOTH the subject and what to do with the verdict, and NO \
                 fence in this crate constrains either — it can invert the polarity, refuse \
                 silently, run after the write, or answer about a third party (the \
                 deletion-status oracle ADR-0227 D4 forbids). Only the two `guards.rs` \
                 wrappers and `privacy.rs`'s export gate may consume it. ADR-0227 D4 stated \
                 this for the caller-only wrapper over four files; ADR-0246 closes it \
                 CRATE-WIDE, which is what makes the subject-parameterised wrapper's \
                 containment argument complete. GREEN AT HEAD; the whole point is that it \
                 stays that way as modules are added."
            ),
        }
    }

    // --- the filesystem is the roster's SUPERSET check ------------------------
    // The roster above is derived from `lib.rs`'s `mod` lines. A production source
    // file that no `mod` line names is exactly a file this census never opens —
    // and `include!`-style inclusion (banned per module above) is the one way
    // such a file still reaches the compiler. So every Rust source file directly under `src/` that is not a
    // sibling test module and not the exempt `guards.rs` MUST be on the roster;
    // an unknown file is a loud failure naming it, never a silent skip.
    let src_dir = format!("{root}/src");
    let mut on_disk: Vec<String> = std::fs::read_dir(src_dir.as_str())
        .unwrap_or_else(|err| panic!("rb-76: cannot list `{src_dir}` ({err})"))
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|file| file.strip_suffix(".rs").map(str::to_string))
        .filter(|stem| !stem.ends_with("tests") && stem != "guards")
        .collect();
    on_disk.sort();
    let unknown: Vec<&String> = on_disk
        .iter()
        .filter(|stem| !modules.iter().any(|m| m == *stem))
        .collect();
    assert!(
        unknown.is_empty(),
        "rb-76 ADR-0246 FAIL (containment, unrostered source): `src/` contains production \
         source file(s) that no `lib.rs` `mod` line declares and this census therefore never \
         scanned: {unknown:?}. Either declare the module in `lib.rs` (the roster is derived \
         from those lines and will pick it up) or, if it is a test module, name it `*tests.rs` \
         so the sibling-test exemption applies. A production file reachable only by textual \
         inclusion is the artifact red-team's MEASURED hiding place for a third-party \
         deletion-status oracle."
    );
    assert!(
        on_disk.len() >= 10,
        "rb-76 ADR-0246 FAIL (containment, anti-vacuity): only {} production source file(s) \
         were listed under `src/`; the crate has far more. A short listing means the \
         directory walk is looking in the wrong place, and a superset check over an empty set \
         passes vacuously.",
        on_disk.len()
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
// rb76-compile-red-end

// ===========================================================================
// rb-77 — the crate root wires every module BARE and UNCONDITIONAL (residual
// R-rb-46-LIBRSMOD). ADR-0247 carries the rationale, the clause list and the
// measured bypasses; this block is the grammar. Appended BELOW the rb-76 marker
// above; no line an earlier slice wrote is touched.
//
// SUBSTRATE RULES, as everywhere above (breaking them breaks OTHER slices'
// gates): needles AND fixture bodies are fragment-assembled, every double quote
// comes from `double_quote()`, a block-comment marker is never spelled
// contiguously — say it in words — no raw-identifier prefix, no three-hash
// raw-string opener, and no failure message quotes a needle this file searches
// for IN ITS OWN SOURCE (the decision-record number is searched for in `lib.rs`
// only, so it is spelled out in prose here).
//
// The live test is green once the ADR-0247 D5 reviewer note exists on the crate
// root's `guards` declaration line; the teeth are the fixture matrix below and
// the ledger's X5 live mutant register on the REAL files.
// ===========================================================================

/// The module keyword.
fn rb77_kw_mod() -> String {
    ["mo", "d"].concat()
}

/// The visibility token the site parser looks back for.
fn rb77_kw_pub() -> String {
    ["pu", "b"].concat()
}

/// The conditional attribute marker, stopping BEFORE the argument list so the
/// attribute-wrapper spelling matches it too.
fn rb77_needle_cfg() -> String {
    ["#[c", "fg"].concat()
}

/// The one conditional attribute either scanned file may carry.
fn rb77_attr_cfg_test() -> String {
    ["#[c", "fg(test)]"].concat()
}

/// A path-relocating attribute over `file`, as source (fixtures only).
fn rb77_attr_path(file: &str) -> String {
    let q = double_quote();
    format!("{open}{q}{file}{q}]", open = ["#", "[path = "].concat())
}

/// The test-module prefix in SQUASHED form (the path argument is blanked).
fn rb77_testmod_prefix() -> String {
    format!(
        "{cfg}{path}",
        cfg = rb77_attr_cfg_test(),
        path = ["#", "[path=]"].concat()
    )
}

/// The INNER-attribute conditional marker.
fn rb77_needle_cfg_inner() -> String {
    ["#!", "[cfg"].concat()
}

/// The conditional MACRO marker, DELIMITER-AGNOSTIC on purpose: a macro accepts
/// all three bracket kinds, and the brace and square spellings compile, pass
/// fmt and clippy, and were measured shipping an unconditional wrapper bypass
/// into the wasm build while a paren-anchored needle read zero hits.
fn rb77_needle_cfg_macro() -> String {
    ["cf", "g!"].concat()
}

/// The source-inclusion macro marker, delimiter-agnostic for the same reason.
/// The `_str` and `_bytes` siblings do not contain it.
fn rb77_needle_include() -> String {
    ["inclu", "de!"].concat()
}

/// The two bytes that open a RAW IDENTIFIER. Raw STRINGS are blanked by the
/// stripper first, so a hit is an identifier.
fn rb77_needle_raw_ident() -> String {
    ["r", "#"].concat()
}

/// A block-comment CLOSE marker, assembled — never spelled contiguously.
fn rb77_needle_close_marker() -> String {
    ["*", "/"].concat()
}

/// A block-comment OPEN marker, assembled — never spelled contiguously.
fn rb77_needle_open_marker() -> String {
    ["/", "*"].concat()
}

/// Every bracket CHAR literal. The stripper consumes char literals ATOMICALLY
/// and KEEPS them, so such a literal reaches the depth counter as a real
/// bracket. The byte-literal spelling contains the plain one as a substring, so
/// these six needles cover twelve spellings.
fn rb77_needle_bracket_chars() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for bracket in ["(", ")", "{", "}", "[", "]"] {
        out.push(["'", bracket, "'"].concat());
    }
    out
}

/// The target-architecture predicate the measured module swaps select on.
fn rb77_token_target_arch() -> String {
    ["target_", "arch"].concat()
}

/// The RAW `lib.rs` line marker of the anchor declaration (ADR-0247 D5).
fn rb77_line_guards_decl() -> String {
    ["mod gu", "ards;"].concat()
}

/// The decision record the reviewer note must cite.
fn rb77_note_adr() -> String {
    ["ADR-0", "247"].concat()
}

/// One `mod` declaration read out of the squashed view at bracket depth zero.
struct Rb77Site {
    name: String,
    /// The delimiter was an opening brace: an INLINE module body, not a file.
    inline: bool,
    /// The byte immediately before the keyword; `None` only at offset zero.
    prev: Option<u8>,
    /// Up to 24 squashed bytes before the keyword, for the failure message.
    prefix: String,
    /// Offset of the keyword in the squashed view (the prefix check needs it).
    at: usize,
}

/// Every depth-zero `mod` declaration in `squashed`, plus the labels raised
/// while reading it. Depth covers all THREE bracket kinds: a conditional
/// attribute closes its own brackets BEFORE the declaration it applies to, a
/// macro invocation's token tree never reaches depth zero, and an inline module
/// body's contents are not crate-root declarations.
///
/// THE TWO DEPTH DIRECTIONS ARE NOT SYMMETRIC. An unmatched CLOSER saturates at
/// zero, so it can only make the scan see MORE sites — a loud false alarm. An
/// unmatched OPENER strands the counter above zero and SILENTLY HIDES every
/// later declaration, which is a green verdict over a file nobody scanned. In
/// practice that opener is a bracket CHAR literal, and exactly two things guard
/// the direction: the live test's roster floors, and the verdict's
/// `[rb77/char-literal-bracket]` clause. Neither is redundant with the other.
///
/// The parser never skips silently: a keyword at an item boundary whose
/// name-plus-delimiter shape cannot be read raises `[rb77/mod-unparsed:<i>]`,
/// because a raw identifier spells a declaration rustc accepts and a text scan
/// cannot. It over-approximates, and says so: a hypothetical squashed `;modes;`
/// would be read as a site named `es`, and a crate-level INNER attribute
/// immediately before the first declaration would raise `[rb77/mod-not-bare]`.
/// Neither shape exists in this crate, and the matcher is deliberately NOT
/// widened for shapes that do not exist.
fn rb77_declaration_sites(squashed: &str) -> (Vec<Rb77Site>, Vec<String>) {
    let bytes = squashed.as_bytes();
    let len = bytes.len();
    let keyword = rb77_kw_mod();
    let keyword = keyword.as_bytes();
    let visibility = rb77_kw_pub();
    let visibility = visibility.as_bytes();
    let mut sites: Vec<Rb77Site> = Vec::new();
    let mut labels: Vec<String> = Vec::new();
    let mut depth: usize = 0;
    let mut i = 0usize;
    while i < len {
        match bytes[i] {
            b'{' | b'(' | b'[' => depth += 1,
            b'}' | b')' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
        if depth != 0 || !bytes[i..].starts_with(keyword) {
            i += 1;
            continue;
        }
        let prev = if i == 0 { None } else { Some(bytes[i - 1]) };
        let after_visibility =
            i >= visibility.len() && &bytes[i - visibility.len()..i] == visibility;
        let inside_word = match prev {
            Some(p) => is_ident_byte(p) || p == b'.' || p == b':',
            None => false,
        };
        // A visibility token is itself made of identifier bytes, so it must be
        // recognised BEFORE the inside-a-longer-identifier skip; otherwise the
        // one declaration shape that is visible crate-wide is the one shape
        // this parser never sees.
        if !after_visibility && inside_word {
            i += 1;
            continue;
        }
        let mut j = i + keyword.len();
        while j < len && is_ident_byte(bytes[j]) {
            j += 1;
        }
        let delim = if j < len { Some(bytes[j]) } else { None };
        if j == i + keyword.len() || !matches!(delim, Some(b';' | b'{')) {
            labels.push(format!(
                "[rb77/mod-unparsed:{i}] a module declaration at that squashed byte offset \
                 could not be read as a name followed by an item delimiter. A raw identifier \
                 is the spelling that does this: the compiler accepts the declaration and \
                 every literal needle in this grammar walks straight past it."
            ));
            i += 1;
            continue;
        }
        sites.push(Rb77Site {
            name: String::from_utf8_lossy(&bytes[i + keyword.len()..j]).into_owned(),
            inline: delim == Some(b'{'),
            prev,
            prefix: String::from_utf8_lossy(&bytes[i.saturating_sub(24)..i]).into_owned(),
            at: i,
        });
        i = j;
    }
    (sites, labels)
}

/// The whole rb-77 grammar (ADR-0247 D2/D3) as a pure function of both sources.
///
/// NON-SHORT-CIRCUITING: every clause runs, so one applied module swap names
/// every rule it breaks instead of only the first a reader reaches. `Ok(())` is
/// the shipped state. [`rb76_module_squashed`] supplies the substrate and its
/// two loud preconditions (a three-hash raw-string opener; unequal
/// block-comment marker counts); the third precondition this grammar needs — a
/// surviving CLOSE marker, i.e. a NESTED block comment — is raised HERE as a
/// label rather than a panic, so a fixture can assert it.
///
/// `file` is a ROLE name, not a path: the fixtures pass synthetic sources under
/// the same two role names, so a fixture failure reads exactly like a live one.
fn rb77_wiring_verdict(lib_src: &str, guards_src: &str) -> Result<(), String> {
    let lib_name = "lib.rs";
    let guards_name = "guards.rs";
    let mut labels: Vec<String> = Vec::new();
    let mut lib_sites: Vec<Rb77Site> = Vec::new();
    let mut lib_squashed = String::new();
    let testmod_prefix = rb77_testmod_prefix();
    let cfg_needle = rb77_needle_cfg();
    let cfg_test = rb77_attr_cfg_test();
    let include_needle = rb77_needle_include();

    for (file, raw) in [(lib_name, lib_src), (guards_name, guards_src)] {
        let squashed = rb76_module_squashed(file, raw);
        if squashed.contains(rb77_needle_close_marker().as_str()) {
            labels.push(format!(
                "[rb77/scan-substrate:{file}] a block-comment CLOSE marker survived stripping: a \
                 NESTED block comment. The stripper stops at the FIRST closer and hands the \
                 outer comment's tail to this scan AS CODE — which is how a bare anchor \
                 declaration is forged out of comment text."
            ));
        }
        if rb77_needle_bracket_chars()
            .iter()
            .any(|needle| squashed.contains(needle.as_str()))
        {
            labels.push(format!(
                "[rb77/char-literal-bracket:{file}] a bracket CHAR literal survived stripping. \
                 It strands the site parser's depth counter above zero, so every declaration \
                 BELOW it is invisible to this scan — an attribute or visibility violation down \
                 there reads as Ok, and only the live roster floors would notice."
            ));
        }
        let (sites, parse_labels) = rb77_declaration_sites(&squashed);
        for label in parse_labels {
            labels.push(format!("{label} (in {file})"));
        }
        for site in &sites {
            let name = &site.name;
            if site.inline {
                labels.push(format!(
                    "[rb77/mod-inline-body:{name}] `{file}` declares that module with an inline \
                     body, not as a file module — which lets it relocate or re-export a nested \
                     declaration, so the name a call resolves to is no longer the file the pins \
                     in this crate read."
                ));
                continue;
            }
            if name.ends_with("tests") {
                let bytes = squashed.as_bytes();
                let plen = testmod_prefix.len();
                let at = site.at;
                let framed = at >= plen
                    && &bytes[at - plen..at] == testmod_prefix.as_bytes()
                    && (at == plen || matches!(bytes[at - plen - 1], b';' | b'}'));
                if !framed {
                    labels.push(format!(
                        "[rb77/testmod-prefix:{name}] that test module in `{file}` is not \
                         preceded by exactly the test attribute plus the path attribute at an \
                         item boundary — squashed bytes before it: `{prefix}`. Anything else \
                         wearing the suffix would inherit the relaxed class rule.",
                        prefix = site.prefix
                    ));
                }
            } else if !matches!(site.prev, None | Some(b';' | b'}')) {
                labels.push(format!(
                    "[rb77/mod-not-bare:{name}] that production module in `{file}` is not \
                     declared BARE — squashed bytes before it: `{prefix}`. An attribute, a \
                     visibility, a macro or a block: each resolves the name to a file no \
                     scanner here reads.",
                    prefix = site.prefix
                ));
            }
        }
        if squashed
            .match_indices(cfg_needle.as_str())
            .any(|(at, _)| !squashed[at..].starts_with(cfg_test.as_str()))
        {
            labels.push(format!(
                "[rb77/cfg-not-test:{file}] a conditional-compilation attribute that is not the \
                 exact test-configuration one — the clause an architecture-selected twin trips. \
                 The marker stops before the argument list, so the wrapper spelling trips it too."
            ));
        }
        if squashed.contains(rb77_needle_cfg_inner().as_str()) {
            labels.push(format!(
                "[rb77/cfg-inner:{file}] an INNER conditional-compilation attribute. Applied \
                 from inside, it conditions the whole remaining file without ever appearing on \
                 a declaration line."
            ));
        }
        if squashed.contains(rb77_needle_cfg_macro().as_str()) {
            labels.push(format!(
                "[rb77/cfg-macro:{file}] the conditional MACRO: the same swap one level down, \
                 selecting an EXPRESSION by target instead of an item. The needle is delimiter- \
                 agnostic because the brace and square spellings were measured shipping an \
                 unconditional wrapper bypass past a paren-anchored one."
            ));
        }
        if raw.contains(include_needle.as_str()) || squashed.contains(include_needle.as_str()) {
            labels.push(format!(
                "[rb77/include-macro:{file}] a textual source-inclusion macro — the swap moved \
                 inside the file. Delimiter-agnostic, and counted on the RAW source AND the \
                 squashed view: whitespace before the bang evades the raw count, squashing \
                 closes it back up."
            ));
        }
        if squashed.contains(rb77_needle_raw_ident().as_str()) {
            labels.push(format!(
                "[rb77/raw-ident:{file}] a RAW IDENTIFIER survived into the squashed view (raw \
                 STRINGS are blanked first, so an identifier is the only survivor). It is the \
                 spelling measured to compile, pass fmt and clippy, and turn every literal \
                 attribute needle in this grammar into a no-op."
            ));
        }
        if file == lib_name {
            lib_sites = sites;
            lib_squashed = squashed;
        }
    }

    let production: Vec<&str> = lib_sites
        .iter()
        .filter(|s| !s.name.ends_with("tests"))
        .map(|s| s.name.as_str())
        .collect();
    let anchors = production
        .iter()
        .copied()
        .filter(|n| *n == "guards")
        .count();
    if anchors != 1 {
        labels.push(format!(
            "[rb77/guards-anchor] the crate root declares the authorization-wrapper module \
             {anchors} time(s) at bracket depth zero; exactly once is required. ABSENCE is how \
             the alias, the nested re-export and the macro token tree all present, and a second \
             declaration would let a decoy carry this pin while the shipped one is relocated."
        ));
    }
    let mut names: Vec<&str> = production.clone();
    names.push("guards");
    names.sort_unstable();
    names.dedup();
    let alias_bytes = lib_squashed.as_bytes();
    for name in names {
        let needle = format!("as{name}");
        let aliased = lib_squashed.match_indices(needle.as_str()).any(|(at, _)| {
            let end = at + needle.len();
            end >= alias_bytes.len() || !is_ident_byte(alias_bytes[end])
        });
        if aliased {
            labels.push(format!(
                "[rb77/mod-alias:{name}] the crate root binds that module name as an ALIAS of \
                 something else. No left word boundary is required on purpose — squashing glues \
                 the rename keyword onto the identifier before it — while the right-hand side IS \
                 bounded, so a longer identifier does not false-alarm."
            ));
        }
    }

    if labels.is_empty() {
        return Ok(());
    }
    Err(format!(
        "rb-77 ADR-0247 FAIL — {count} clause(s):\n  - {body}",
        count = labels.len(),
        body = labels.join("\n  - ")
    ))
}

/// Assert that `sources` is rejected AND that each expected clause label is
/// among the collected ones. A fixture half spelled as the empty string is an
/// explicit statement that the fixture says nothing about that file.
fn rb77_assert_rejected(case: &str, sources: (String, String), expected: &[&str]) {
    let (lib, guards) = sources;
    let Err(message) = rb77_wiring_verdict(&lib, &guards) else {
        panic!(
            "rb-77 ADR-0247 TEETH FAIL ({case}): the verdict ACCEPTED this wiring — a frozen \
             module swap measured to compile, to ship a different file in the wasm build, and \
             to leave every other pin in this crate green."
        );
    };
    for label in expected {
        assert!(
            message.contains(label),
            "rb-77 ADR-0247 TEETH FAIL ({case}): rejected, but never by the clause `{label}` \
             this fixture exists to exercise — that clause is unproven and some other rule is \
             carrying the rejection. Collected:\n{message}"
        );
    }
}

/// F0 — the clean control; if this is rejected, no rejection below proves anything.
fn rb77_fx_clean() -> (String, String) {
    let lib = format!(
        "{m} guards;\n{m} battle;\n{m} accounts;\n{c}\n{px}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        px = rb77_attr_path("x_tests.rs")
    );
    let guards = format!(
        "{c}\n{pg}\n{m} guards_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        pg = rb77_attr_path("guards_tests.rs")
    );
    (lib, guards)
}

/// F1 — the literal rb-46 PoC X4, two lines; kills a declaration-line-only read.
/// Squashing erases newlines, so the SINGLE-line spelling is byte-identical input.
fn rb77_fx_two_line_poc() -> (String, String) {
    let lib = format!(
        "{m} accounts;\n{m} battle;\n\
         {cfg}(not({ta} = {q}wasm32{q}))]\n{m} guards;\n\
         {cfg}({ta} = {q}wasm32{q})]\n{pw}\n{m} guards;\n\
         {c}\n{px}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        q = double_quote(),
        cfg = rb77_needle_cfg(),
        ta = rb77_token_target_arch(),
        pw = rb77_attr_path("guards_wasm.rs"),
        px = rb77_attr_path("x_tests.rs")
    );
    (lib, String::new())
}

/// F3 — the attribute WRAPPER carrying the relocation as an argument.
fn rb77_fx_attribute_wrapper() -> (String, String) {
    let lib = format!(
        "{m} accounts;\n{m} battle;\n\
         {cfg}_attr({ta} = {q}wasm32{q}, path = {q}guards_wasm.rs{q})]\n{m} guards;\n\
         {c}\n{px}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        q = double_quote(),
        cfg = rb77_needle_cfg(),
        ta = rb77_token_target_arch(),
        px = rb77_attr_path("x_tests.rs")
    );
    (lib, String::new())
}

/// F4 — renamed module plus rename import; kills a grammar blind to what is GONE.
fn rb77_fx_alias_trio() -> (String, String) {
    let lib = format!(
        "{m} accounts;\n{m} battle;\n{m} guards_wasm;\n\
         use guards_wasm as guards;\n\
         {c}\n{px}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        px = rb77_attr_path("x_tests.rs")
    );
    (lib, String::new())
}

/// F5 — anchor relocated into an inline body and re-exported; kills a depth-blind count.
fn rb77_fx_nested_reexport() -> (String, String) {
    let lib = format!(
        "{m} accounts;\n{m} battle;\n\
         {m} native {{ {pn} pub {m} guards; }}\n\
         use native::guards;\n\
         {c}\n{px}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        pn = rb77_attr_path("guards.rs"),
        px = rb77_attr_path("x_tests.rs")
    );
    (lib, String::new())
}

/// F6 — a bare-looking declaration inside a macro token tree; kills anchor forgery.
fn rb77_fx_macro_token_tree() -> (String, String) {
    let lib = format!(
        "{m} accounts;\n{m} battle;\n\
         wire! {{ ; {m} guards; }}\n\
         {c}\n{px}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        px = rb77_attr_path("x_tests.rs")
    );
    (lib, String::new())
}

/// F7 — the anchor given a visibility; kills the inside-an-identifier skip.
fn rb77_fx_visible_anchor() -> (String, String) {
    let lib = format!(
        "{m} accounts;\n{m} battle;\npub {m} guards;\n{c}\n{px}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        px = rb77_attr_path("x_tests.rs")
    );
    (lib, String::new())
}

/// F8 — the anchor wearing the TEST framing; the class is the NAME, not the attribute.
fn rb77_fx_testframed_anchor() -> (String, String) {
    let lib = format!(
        "{m} accounts;\n{m} battle;\n{c}\n{pw}\n{m} guards;\n{c}\n{px}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        pw = rb77_attr_path("guards_wasm.rs"),
        px = rb77_attr_path("x_tests.rs")
    );
    (lib, String::new())
}

/// F9 — conditional textual inclusion plus a paren conditional macro, INSIDE the
/// wrapper file: the ban rb-76 loops over a roster that excludes this very file.
fn rb77_fx_guards_conditional_include() -> (String, String) {
    let lib = format!("{m} guards;\n", m = rb77_kw_mod());
    let guards = format!(
        "{cfg}({ta} = {q}wasm32{q})]\n{inc}({q}guards_wasm.rs{q});\n\
         pub(crate) fn beta() -> bool {{ {mac}({ta} = {q}wasm32{q}) }}\n\
         {c}\n{pg}\n{m} guards_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        q = double_quote(),
        cfg = rb77_needle_cfg(),
        ta = rb77_token_target_arch(),
        inc = rb77_needle_include(),
        mac = rb77_needle_cfg_macro(),
        pg = rb77_attr_path("guards_tests.rs")
    );
    (lib, guards)
}

/// F10 — raw-identifier attributes and name; the conditional clause does NOT fire.
fn rb77_fx_raw_identifiers() -> (String, String) {
    let lib = format!(
        "{m} accounts;\n{m} battle;\n\
         #[{r}cfg(not({ta} = {q}wasm32{q}))]\n{m} {r}guards;\n\
         #[{r}cfg({ta} = {q}wasm32{q})]\n#[{r}path = {q}guards_wasm.rs{q}]\n{m} {r}guards;\n\
         {c}\n{px}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        q = double_quote(),
        r = rb77_needle_raw_ident(),
        ta = rb77_token_target_arch(),
        px = rb77_attr_path("x_tests.rs")
    );
    (lib, String::new())
}

/// F11 — a nested block comment forging a bare anchor out of comment text.
fn rb77_fx_nested_comment_phantom() -> (String, String) {
    let lib = format!(
        "{m} accounts;\n{m} battle;\n\
         {open} {open} {close} ; {m} guards; {close}\n\
         {c}\n{px}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        open = rb77_needle_open_marker(),
        close = rb77_needle_close_marker(),
        px = rb77_attr_path("x_tests.rs")
    );
    (lib, String::new())
}

/// F12 — inclusion with whitespace before the bang; kills a RAW-only count.
fn rb77_fx_spaced_include() -> (String, String) {
    let lib = format!("{m} guards;\n", m = rb77_kw_mod());
    let guards = format!(
        "{spaced}({q}guards_wasm.rs{q});\n{c}\n{pg}\n{m} guards_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        q = double_quote(),
        spaced = ["inclu", "de !"].concat(),
        pg = rb77_attr_path("guards_tests.rs")
    );
    (lib, guards)
}

/// F13 — a test module with the conditional attribute but NO path attribute;
/// the sole fixture for the two-class rule, and the only label it raises.
fn rb77_fx_unframed_testmod() -> (String, String) {
    let lib = format!(
        "{m} guards;\n{m} battle;\n{c}\n{m} x_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test()
    );
    (lib, String::new())
}

/// F14 — an INNER conditional attribute plus the BRACE-delimited conditional macro.
fn rb77_fx_guards_inner_cfg_and_brace_macro() -> (String, String) {
    let lib = format!("{m} guards;\n", m = rb77_kw_mod());
    let guards = format!(
        "{inner}({ta} = {q}wasm32{q})]\n\
         pub(crate) fn beta() -> bool {{ {mac} {{{ta} = {q}wasm32{q}}} }}\n\
         {c}\n{pg}\n{m} guards_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        q = double_quote(),
        inner = rb77_needle_cfg_inner(),
        mac = rb77_needle_cfg_macro(),
        ta = rb77_token_target_arch(),
        pg = rb77_attr_path("guards_tests.rs")
    );
    (lib, guards)
}

/// F15 — the BRACE-delimited inclusion macro, no paren spelling anywhere.
fn rb77_fx_guards_brace_include() -> (String, String) {
    let lib = format!("{m} guards;\n", m = rb77_kw_mod());
    let guards = format!(
        "{inc} {{{q}guards_wasm.rs{q}}}\n{c}\n{pg}\n{m} guards_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        q = double_quote(),
        inc = rb77_needle_include(),
        pg = rb77_attr_path("guards_tests.rs")
    );
    (lib, guards)
}

/// F16 — a bracket CHAR literal at depth zero, above a visibility violation that
/// the stranded depth counter would otherwise hide completely.
fn rb77_fx_bracket_char_literal() -> (String, String) {
    let lib = format!(
        "{m} guards;\n{m} battle;\n{c}\n{px}\n{m} x_tests;\n\
         pub(crate) const OPEN: char = {oc};\n\
         pub {m} taming;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        px = rb77_attr_path("x_tests.rs"),
        oc = ["'", "{", "'"].concat()
    );
    (lib, String::new())
}

/// F17 — an extra outer attribute stacked above the test hook; kills a prefix
/// check that ignores what precedes the framing — the mutant the verifier measured surviving.
fn rb77_fx_stacked_attribute_on_test_hook() -> (String, String) {
    let lib = format!("{m} guards;\n", m = rb77_kw_mod());
    let guards = format!(
        "{extra}\n{c}\n{pg}\n{m} guards_tests;\n",
        m = rb77_kw_mod(),
        c = rb77_attr_cfg_test(),
        extra = ["#[al", "low(dead_code)]"].concat(),
        pg = rb77_attr_path("guards_tests.rs")
    );
    (lib, guards)
}

/// **ADR-0247 D4 (live oracle)** — the REAL crate root wires every module bare
/// and unconditional, the REAL wrapper file carries nothing conditional beyond
/// its test hook, and the D5 reviewer note is on the anchor's own line.
///
/// The verdict IS the invariant; it already folds in every parse label. The
/// counts after it are POSITIVE CONTROLS, not floors for their own sake: they
/// prove both needle families still match real text, and together with
/// `[rb77/char-literal-bracket]` they are the only things that would notice a
/// stranded depth counter silently hiding the tail of a file. rb-76's clause
/// (d) names the same modules line-by-line but EXCLUDES `guards`; this parse is
/// byte-level and INCLUDES it. The note clause asserts that a deliverable of
/// this slice exists — an assertion about the tree, not a ratchet.
#[test]
fn rb77_crate_root_wires_every_module_bare_and_unconditional() {
    if let Err(message) = rb77_wiring_verdict(RB76_LIB_RS, GUARDS_RS) {
        panic!(
            "rb-77 ADR-0247 FAIL (live): the shipped crate root or the shipped wrapper file \
             violates the module-wiring grammar. Every clause below names the rule it broke; a \
             conditional or relocated declaration here means the wasm build compiles a file no \
             pin in this crate reads.\n{message}"
        );
    }

    let (lib_sites, _lib_parse_labels) =
        rb77_declaration_sites(&rb76_module_squashed("lib.rs", RB76_LIB_RS));
    let production: Vec<&str> = lib_sites
        .iter()
        .filter(|s| !s.name.ends_with("tests"))
        .map(|s| s.name.as_str())
        .collect();
    assert!(
        production.len() >= 20,
        "rb-77 ADR-0247 FAIL (live floor): the byte-level parse found only {count} production \
         module(s) in the crate root; the crate declares twenty-one today. A count below twenty \
         means the PARSE changed, not the crate — and a parse that sees nothing bans nothing. \
         Found: {production:?}",
        count = production.len()
    );
    let lib_test_sites = lib_sites
        .iter()
        .filter(|s| s.name.ends_with("tests"))
        .count();
    assert!(
        lib_test_sites >= 1,
        "rb-77 ADR-0247 FAIL (live control): the crate root declares no test-class module, so \
         the test-module framing rule matched nothing real and its clause proves nothing."
    );

    let (guards_sites, _guards_parse_labels) =
        rb77_declaration_sites(&rb76_module_squashed("guards.rs", GUARDS_RS));
    let guards_test_sites = guards_sites
        .iter()
        .filter(|s| s.name.ends_with("tests"))
        .count();
    assert!(
        guards_test_sites >= 1,
        "rb-77 ADR-0247 FAIL (live control): the wrapper file declares no test-class module, so \
         the one conditional attribute it is allowed to carry was not seen at all and the \
         file-wide conditional bans are unproven against real text."
    );

    let decl = rb77_line_guards_decl();
    let adr = rb77_note_adr();
    let declared = RB76_LIB_RS
        .lines()
        .filter(|l| l.starts_with(decl.as_str()))
        .count();
    assert_eq!(
        declared, 1,
        "rb-77 ADR-0247 FAIL (note anchor): the crate root has {declared} line(s) beginning with \
         the anchor declaration and must have exactly one. This is the positive control for the \
         clause below: without it, a renamed or moved declaration would make the note check pass \
         by looking at nothing."
    );
    let noted = RB76_LIB_RS
        .lines()
        .filter(|l| l.starts_with(decl.as_str()) && l.contains(adr.as_str()))
        .count();
    assert_eq!(
        noted, 1,
        "rb-77 ADR-0247 FAIL (reviewer note, D5): {noted} of the crate root's anchor declaration \
         line(s) cite this slice's decision record; exactly one must. The note is half the \
         residual's disposition — the half a reviewer reads without running anything — and it \
         belongs on the declaration line itself, where a trailing comment shifts no later line \
         and therefore moves no knowledge-bundle line stamp."
    );
}

/// **ADR-0247 D4 (fixture matrix)** — sixteen frozen module-swap inputs, each
/// rejected by the clause it exists to exercise, plus the clean control.
///
/// Every fixture writes its OWN full text from fragments: no shared builder and
/// no base-plus-mutation, so one bad helper cannot make the whole matrix
/// vacuous, and no contiguous production marker enters this file's source. The
/// expected labels are hand-written here and produced independently by the
/// collector, so the pair is a transcription check rather than a tautology, and
/// they are asserted by MEMBERSHIP — a genuinely broken wiring breaks several
/// clauses at once. The wrong wiring each row kills is named in the fixture's
/// own doc comment above; every one of them was MEASURED to compile, pass fmt
/// and clippy, and leave rb-76 and every other pin byte-identically green.
#[test]
fn rb77_module_swap_fixtures_are_rejected_by_clause() {
    let (lib, guards) = rb77_fx_clean();
    if let Err(message) = rb77_wiring_verdict(&lib, &guards) {
        panic!(
            "rb-77 ADR-0247 TEETH FAIL (F0 clean control): the verdict REJECTED an honest \
             wiring. Every rejection below is meaningless while this is red — a grammar that \
             refuses everything proves nothing about the swaps it is supposed to catch.\n\
             {message}"
        );
    }

    rb77_assert_rejected(
        "F1 two-line twin",
        rb77_fx_two_line_poc(),
        &["[rb77/cfg-not-test:lib.rs]", "[rb77/mod-not-bare:guards]"],
    );
    rb77_assert_rejected(
        "F3 attribute wrapper",
        rb77_fx_attribute_wrapper(),
        &["[rb77/cfg-not-test:lib.rs]", "[rb77/mod-not-bare:guards]"],
    );
    rb77_assert_rejected(
        "F4 alias trio",
        rb77_fx_alias_trio(),
        &["[rb77/guards-anchor]", "[rb77/mod-alias:guards]"],
    );
    rb77_assert_rejected(
        "F5 nested re-export",
        rb77_fx_nested_reexport(),
        &["[rb77/mod-inline-body:native]", "[rb77/guards-anchor]"],
    );
    rb77_assert_rejected(
        "F6 macro token tree",
        rb77_fx_macro_token_tree(),
        &["[rb77/guards-anchor]"],
    );
    rb77_assert_rejected(
        "F7 visibility",
        rb77_fx_visible_anchor(),
        &["[rb77/mod-not-bare:guards]"],
    );
    rb77_assert_rejected(
        "F8 test framing",
        rb77_fx_testframed_anchor(),
        &["[rb77/mod-not-bare:guards]"],
    );
    rb77_assert_rejected(
        "F9 in-file inclusion plus paren macro",
        rb77_fx_guards_conditional_include(),
        &[
            "[rb77/cfg-not-test:guards.rs]",
            "[rb77/include-macro:guards.rs]",
            "[rb77/cfg-macro:guards.rs]",
        ],
    );
    rb77_assert_rejected(
        "F10 raw identifiers",
        rb77_fx_raw_identifiers(),
        &["[rb77/raw-ident:lib.rs]", "[rb77/mod-unparsed:"],
    );
    rb77_assert_rejected(
        "F11 nested comment phantom",
        rb77_fx_nested_comment_phantom(),
        &["[rb77/scan-substrate:lib.rs]"],
    );
    rb77_assert_rejected(
        "F12 spaced inclusion",
        rb77_fx_spaced_include(),
        &["[rb77/include-macro:guards.rs]"],
    );
    rb77_assert_rejected(
        "F13 unframed test module",
        rb77_fx_unframed_testmod(),
        &["[rb77/testmod-prefix:x_tests]"],
    );
    rb77_assert_rejected(
        "F14 inner attribute plus brace macro",
        rb77_fx_guards_inner_cfg_and_brace_macro(),
        &["[rb77/cfg-inner:guards.rs]", "[rb77/cfg-macro:guards.rs]"],
    );
    rb77_assert_rejected(
        "F15 brace inclusion",
        rb77_fx_guards_brace_include(),
        &["[rb77/include-macro:guards.rs]"],
    );
    rb77_assert_rejected(
        "F16 bracket char literal",
        rb77_fx_bracket_char_literal(),
        &["[rb77/char-literal-bracket:lib.rs]"],
    );
    rb77_assert_rejected(
        "F17 stacked attribute on the test hook",
        rb77_fx_stacked_attribute_on_test_hook(),
        &["[rb77/testmod-prefix:guards_tests]"],
    );
}

// ===========================================================================
// rb-78 — NO MACRO EXPANDS ABOVE A DELETION GATE (residual R-rb-46-MACRORET).
// ADR-0248 carries the rationale, the clause list and the measured bypasses;
// this block is the grammar. Appended BELOW the rb-77 matrix above; no line an
// earlier slice wrote is touched.
//
// EARS criterion encoded by this block:
//
//   R-rb-46-MACRORET  WHERE a reducer prefix precedes one of the three
//                     fully-qualified deletion-gate wrapper calls, the server
//                     module SHALL expand NO macro above that gate other than
//                     the standard-library string builder, and SHALL NOT
//                     re-spell, alias, glob-import or macro-import that
//                     builder's name in ANY crate module — so that no early
//                     `return` can reach a gated prefix from a DEFINITION the
//                     rb-46 textual return census cannot see.
//
// WHY THIS IS MATERIAL, not hypothetical. rb-46 clause I
// (`battle_tests.rs:6886-6929`) counts textual `return` tokens in a reducer
// prefix and requires each to be the tagged reject spelling. A macro's
// `return` lives in the macro DEFINITION, outside every prefix, so that count
// stays byte-identically correct while the expansion diverts every real caller
// around the gate. That clause says so ITSELF, in the HONEST RESIDUAL sentence
// of its own failure message (`battle_tests.rs:6922-6924`): this block is the
// disposition of the residual that sentence registered.
//
// The literal proof-of-concept — a module-scope two-line rule invoked one line
// above `battle.rs`'s `start_battle` gate, admitting every sender that is not
// the all-zero wild sentinel — was MEASURED at this slice's base commit to pass
// `cargo fmt --check`, all 900 tests, and clippy with warnings denied
// (`memory/projects/gates/rb-78.red-before.md` section 1).
// Eight of the ten live gate sites are open to that shape; the other two are
// already closed by whole-prefix equality (rb-76 on `begin_encounter`, rb-47 on
// `respond_trade`).
//
// SCOPE, stated so nobody widens it later. This block says NOTHING about the
// gate STATEMENT itself (a conditional attribute on that line is rb-79's), and
// it pins NO site total — rb-46's and rb-76's censuses own the call-site sets.
// It bans no macro DEFINITION crate-wide either: every route that matters
// passes either through a gate REGION or through the re-spelling clauses, and
// a definition ban would red the first legitimate helper macro for no reach.
//
// RED STATE of this block at HEAD:
//   * `rb78_no_macro_expands_above_any_deletion_gate` — RED on the NOTE clause
//     ONLY. `guards.rs` carries no reviewer note citing this slice's decision
//     record between the pure decision seam and the caller-only wrapper. Every
//     macro clause is GREEN at HEAD BY CONSTRUCTION (the shipped tree is
//     clean), which is exactly why the teeth are the fixture matrix below plus
//     the ledger's X5 live mutant register on the REAL files — a source-scan
//     gate whose only evidence is "the clean tree passes" has no teeth at all.
//   * `rb78_macro_divert_fixtures_are_rejected_by_clause` — GREEN at HEAD and
//     after the slice. It is the tooth, not the ratchet.
//
// SCAN SUBSTRATE RULES, as everywhere above (breaking them breaks OTHER
// slices' gates, not this one): every needle naming a production symbol or a
// banned spelling is assembled from fragments, every double quote inside
// fixture text comes from `double_quote()`, a block-comment marker is never
// spelled contiguously — say it in words — no raw double-quote CHARACTER
// literal is written anywhere, and no failure message quotes a needle this
// grammar searches for IN ITS OWN SOURCE (the reviewer note is searched for in
// `guards.rs` only, so the note's decision-record number is spelled out only
// in fragments).
// ===========================================================================

/// The six bytes of the one macro name admitted above a deletion gate.
fn rb78_token_format() -> String {
    ["for", "mat"].concat()
}

/// The admitted macro name PLUS the one admitted delimiter.
fn rb78_needle_format_bang() -> String {
    [rb78_token_format().as_str(), "!("].concat()
}

/// The caller-only wrapper, as a FULLY-QUALIFIED call (ADR-0227 D2).
fn rb78_needle_caller_gate() -> String {
    ["crate::guards::require_not_", "deleting("].concat()
}

/// The subject-parameterised wrapper, as a fully-qualified call (ADR-0246 D2).
fn rb78_needle_subject_gate() -> String {
    ["crate::guards::require_subject_not_", "deleting("].concat()
}

/// The stamp-aware wrapper, as a fully-qualified call (ADR-0237 D3).
fn rb78_needle_stamp_gate() -> String {
    ["crate::guards::require_commitment_predates_", "deletion("].concat()
}

/// All three deletion-gate call needles.
///
/// The QUALIFIED spelling is the needle on purpose, and this is the one place
/// in the crate where that is the right choice rather than the bare name: the
/// region this grammar slices is defined by a CALL SITE, and the qualified form
/// is what every site is independently pinned to carry (rb-46 clause A, rb-47,
/// rb-76, m22-s3b). A bare-name needle would additionally match the three
/// declarations in `guards.rs`, which have no prefix to scan.
fn rb78_gate_needles() -> [String; 3] {
    [
        rb78_needle_caller_gate(),
        rb78_needle_subject_gate(),
        rb78_needle_stamp_gate(),
    ]
}

/// The path roots a glob import may legitimately carry, in SQUASHED form.
///
/// Squashing removes the space between the import keyword and the path root, so
/// `use super::*;` reaches this scan glued as `usesuper::*`. The glued spellings
/// are therefore listed EXPLICITLY rather than stripped off, so a longer
/// identifier merely ENDING in one of the three (`mysuper`, `notcrate`) is still
/// rejected. All three name files this very scan already reads, which is the
/// whole reason they are safe: a macro re-exported from inside the crate cannot
/// hide from a crate-wide census.
fn rb78_glob_roots() -> [&'static str; 9] {
    [
        "super",
        "self",
        "crate",
        "usesuper",
        "useself",
        "usecrate",
        "pubusesuper",
        "pubuseself",
        "pubusecrate",
    ]
}

/// Comments-stripped, string-blanked, whitespace-squashed view.
///
/// Deliberately NOT [`rb76_module_squashed`], and the difference is the whole
/// reason this helper exists: that one ASSERTS its preconditions and therefore
/// PANICS, which a fixture matrix cannot observe. The stripping pipeline is this
/// file's own [`strip_comments_and_strings`] and [`m22s5_squash`], byte for
/// byte — no third stripper is introduced (ADR-0003) — and the preconditions
/// are re-raised as LABELS inside [`rb78_macro_verdict`] instead.
fn rb78_squashed(raw: &str) -> String {
    m22s5_squash(&strip_comments_and_strings(raw))
}

/// Every qualified deletion-gate REGION in `squashed`, in file order.
///
/// REGION = from one past the last `;` or `}` at BRACE depth zero before a gate
/// needle, up to the needle itself. That boundary is the enclosing ITEM's start,
/// so the region holds the reducer's attributes, its whole signature AND its
/// body prefix. Three consequences, each load-bearing:
///
///   * a WHOLE-FUNCTION wrapper macro puts its own bang-plus-brace inside the
///     region (the gate is nested in the macro's token tree, so no item
///     boundary intervenes);
///   * a function GENERATED from a rule definition does the same, because the
///     definition's braces never return the depth counter to zero;
///   * a macro in SIGNATURE position (`v: ty!()`) is inside the region too,
///     which a body-only scan would walk straight past.
///
/// THE DEPTH COUNTER IS BRACE-ONLY. Parentheses and square brackets are
/// deliberately not counted: an attribute closes its own square brackets before
/// the item it applies to, and counting them would make an unbalanced attribute
/// argument strand the region start. The cost of brace-only counting is exactly
/// one hazard — a brace CHAR literal — and that hazard is closed by the
/// `[rb78/char-literal-bracket]` clause, which is why the two must never be
/// separated. The failure DIRECTION is also asymmetric and safe: an unmatched
/// opener strands the counter above zero, which makes regions LONGER (loud,
/// over-approximating), never shorter.
fn rb78_region_texts(squashed: &str) -> Vec<String> {
    let mut sites: Vec<usize> = Vec::new();
    for needle in &rb78_gate_needles() {
        for (at, _) in squashed.match_indices(needle.as_str()) {
            sites.push(at);
        }
    }
    if sites.is_empty() {
        return Vec::new();
    }
    sites.sort_unstable();
    sites.dedup();

    let bytes = squashed.as_bytes();
    let mut boundaries: Vec<usize> = Vec::new();
    let mut depth = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth = depth.saturating_sub(1);
        }
        if depth == 0 && (b == b';' || b == b'}') {
            boundaries.push(i + 1);
        }
        i += 1;
    }

    let mut out: Vec<String> = Vec::new();
    for at in sites {
        let start = boundaries
            .iter()
            .rev()
            .find(|&&b| b <= at)
            .copied()
            .unwrap_or(0);
        out.push(String::from_utf8_lossy(&bytes[start..at]).into_owned());
    }
    out
}

/// Every macro expansion inside one gate region, as clause labels.
///
/// THE ALLOW-LIST IS A BYTE SEQUENCE, not a concept: the six bytes of the
/// standard string builder, immediately followed by an opening PAREN, with the
/// byte before the name neither an identifier byte nor a colon. Everything else
/// that is a bang followed by one of the three delimiters is labelled, with the
/// macro's own name in the label so the failure names the divert rather than the
/// rule.
///
/// THE KEYWORD EXEMPTIONS ARE NOT A HOLE. `if`, `while`, `match`, `return`,
/// `break` and `in` can legitimately precede a parenthesised unary negation
/// (`if !(a && b)`), and squashing glues the keyword onto the bang. A macro
/// cannot bear a keyword name — that requires a raw identifier, which is its own
/// clause on this same region — so an attacker cannot claim any exemption on
/// this list. An EMPTY name is exempt for the same reason: a macro must have a
/// name, so `== !(x)` and an inner attribute's `#!` are both unary, not calls.
///
/// DISCLOSED AND FAIL-CLOSED, in this order of likelihood: a builder call glued
/// to a preceding keyword — an early return of a built string — reads as a macro
/// whose name is that keyword and the builder run together, and is LABELLED (see
/// the F20 fixture, which asserts it); the brace and square delimiter forms of
/// the builder are NOT allow-listed; and a C-string literal, which this crate's
/// shared stripper does not model, would leave a stray prefix byte before the
/// name. All three are loud false REDs on honest code, all three are zero on the
/// tree today, and the remedy for each is to re-derive the allow-list
/// DELIBERATELY — never to widen the byte sequence so that a whole class slips
/// through with it.
fn rb78_region_macro_labels(file: &str, region: &str) -> Vec<String> {
    let admitted_name = rb78_token_format();
    let exempt = ["if", "while", "match", "return", "break", "in"];
    let bytes = region.as_bytes();
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(48)]).into_owned();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'!' {
            i += 1;
            continue;
        }
        let delim = match bytes.get(i + 1) {
            Some(&d) if d == b'(' || d == b'{' || d == b'[' => d,
            _ => {
                i += 1;
                continue;
            }
        };
        let mut s = i;
        while s > 0 && is_ident_byte(bytes[s - 1]) {
            s -= 1;
        }
        let name = String::from_utf8_lossy(&bytes[s..i]).into_owned();
        if name.is_empty() || exempt.iter().any(|k| name == *k) {
            i += 1;
            continue;
        }
        let before = if s == 0 { None } else { Some(bytes[s - 1]) };
        let admitted = name == admitted_name
            && delim == b'('
            && !matches!(before, Some(b) if is_ident_byte(b) || b == b':');
        if !admitted {
            out.push(format!(
                "[rb78/macro-above-gate:{file}:{name}] a macro expands between the enclosing \
                 item boundary and a fully-qualified deletion-gate call, so whatever it emits \
                 runs BEFORE the gate. Its expansion is not in this file, is not in that \
                 reducer's prefix, and is therefore invisible to rb-46 clause I's textual \
                 return census — the measured, CI-clean shape this whole block exists for. \
                 Only the standard string builder spelled with a paren and reached without a \
                 path qualifier is admitted; NEVER widen that byte sequence to quiet a new \
                 macro, add the macro's own gating instead. Region begins: {head:?}"
            ));
        }
        i += 1;
    }
    out
}

/// The whole rb-78 grammar (ADR-0248 D2/D3) as a pure function of the sources.
///
/// NON-SHORT-CIRCUITING: every clause runs over every file, so one applied
/// divert names every rule it breaks instead of only the first a reader reaches.
/// `Ok(())` is the shipped state.
///
/// `file` is a ROLE name, not a path: the fixtures pass synthetic sources under
/// the same role names the live test uses, so a fixture failure reads exactly
/// like a live one.
///
/// THE CLAUSES, and what each one kills:
///
///   * `[rb78/scan-substrate:<file>]` — a deep raw-string opener, unbalanced
///     block-comment markers, or a surviving CLOSE marker (a NESTED comment).
///     Each makes the shared stripper blank the wrong byte range, which turns
///     every clause below it silently vacuous. Raised as a LABEL rather than the
///     panic its sibling helpers use, so the matrix can prove it fires.
///   * `[rb78/format-respelt:<file>]` — the builder's name reached through a
///     PATH (`std::` / `crate::`), imported by name, or DEFINED locally as a
///     rule. Each of those makes the allow-listed byte sequence resolve to
///     something else entirely, so the one admitted macro becomes the divert.
///   * `[rb78/format-alias:<file>]` — the builder's NAME bound to some other
///     item by a rename import. No left word boundary is required on purpose
///     (squashing glues the rename keyword onto the identifier before it) while
///     the right-hand side IS bounded, so a longer identifier does not
///     false-alarm. The respelt clause CANNOT see this shape: the name there
///     sits directly after an identifier byte.
///   * `[rb78/macro-use:<file>]` — a legacy macro import, which drops a
///     dependency's exported rules into this crate's root namespace under names
///     no import line in any module mentions.
///   * `[rb78/glob-import:<file>]` — a glob whose path root is not one of the
///     three in-crate roots. This is the ONE route by which a dependency's
///     exported rule can shadow the admitted builder without any module naming
///     it; the crate's only production glob today re-imports a parent module
///     this same scan reads.
///   * `[rb78/char-literal-bracket:<file>]`, gate-bearing files only — a brace
///     CHAR literal survives the stripper and strands the region's depth
///     counter. `privacy.rs` legitimately spells both and carries no gate, which
///     is exactly why this clause is scoped to files that DO.
///   * `[rb78/raw-ident:<file>]` — a raw identifier inside a region. It is the
///     spelling that lets a macro wear a keyword name, which is the only way the
///     exemption list above could ever be claimed by an attacker.
///   * `[rb78/macro-above-gate:<file>:<macro>]` — the clause itself.
fn rb78_macro_verdict(sources: &[(String, String)]) -> Result<(), String> {
    let mut labels: Vec<String> = Vec::new();

    let deep_raw = ["r#", "##"].concat();
    let open_marker = rb77_needle_open_marker();
    let close_marker = rb77_needle_close_marker();
    let raw_ident = rb77_needle_raw_ident();
    let token_format = rb78_token_format();
    let format_bang = rb78_needle_format_bang();
    let alias_format = ["as", token_format.as_str()].concat();
    let macro_use = ["macro_", "use"].concat();
    let glob = [":", ":*"].concat();
    let glob_roots = rb78_glob_roots();
    let bracket_chars = [["'", "{", "'"].concat(), ["'", "}", "'"].concat()];

    for (file, raw) in sources {
        // --- substrate, as labels rather than panics -------------------------
        if raw.contains(deep_raw.as_str()) {
            labels.push(format!(
                "[rb78/scan-substrate:{file}] a raw-string opener with three or more hashes. \
                 The crate's shared byte-sequential stripper does not handle it, so it blanks \
                 the wrong byte range and every clause below reads text nobody wrote. Extend \
                 the stripper's hash-depth handling before adding such a literal."
            ));
        }
        let opens = raw.matches(open_marker.as_str()).count();
        let closes = raw.matches(close_marker.as_str()).count();
        if opens != closes {
            labels.push(format!(
                "[rb78/scan-substrate:{file}] {opens} block-comment opener(s) against {closes} \
                 closer(s) in the RAW source. The stripper stops at the first closer, so an \
                 unpaired opener swallows real reducer prefixes — the one failure that makes a \
                 macro ban pass because it looked at nothing."
            ));
        }
        let squashed = rb78_squashed(raw);
        if squashed.contains(close_marker.as_str()) {
            labels.push(format!(
                "[rb78/scan-substrate:{file}] a block-comment CLOSE marker survived stripping: \
                 a NESTED block comment. The stripper stops at the FIRST closer and hands the \
                 outer comment's tail to this scan AS CODE, which is how a whole gate region \
                 gets forged — or hidden — out of comment text."
            ));
        }
        let bytes = squashed.as_bytes();

        // --- the builder's name, re-spelled ----------------------------------
        let mut respelt = false;
        for (at, _) in squashed.match_indices(token_format.as_str()) {
            let before = if at == 0 { None } else { Some(bytes[at - 1]) };
            let end = at + token_format.len();
            let inside_word = matches!(before, Some(b) if is_ident_byte(b))
                || (end < bytes.len() && is_ident_byte(bytes[end]));
            if inside_word {
                continue;
            }
            if before == Some(b':') || !squashed[at..].starts_with(format_bang.as_str()) {
                respelt = true;
            }
        }
        if respelt {
            labels.push(format!(
                "[rb78/format-respelt:{file}] the one admitted macro name appears path-qualified, \
                 or bounded as an identifier without the admitted paren delimiter after it. Both \
                 shapes mean the allow-listed byte sequence no longer resolves to the standard \
                 builder: a path form reaches somebody else's item, an import binds the name, and \
                 a local rule definition shadows it outright — after which the ONE macro this \
                 grammar lets through above a gate is the divert. The remedy is to spell the \
                 builder plainly; never widen this clause to admit a qualifier."
            ));
        }

        // --- the builder's name, aliased -------------------------------------
        let aliased = squashed
            .match_indices(alias_format.as_str())
            .any(|(at, _)| {
                let end = at + alias_format.len();
                end >= bytes.len() || !is_ident_byte(bytes[end])
            });
        if aliased {
            labels.push(format!(
                "[rb78/format-alias:{file}] the admitted macro name is bound as an ALIAS of some \
                 other item. No left word boundary is required on purpose — squashing glues the \
                 rename keyword onto the identifier before it — while the right-hand side IS \
                 bounded, so a longer identifier does not false-alarm. The re-spelling clause \
                 above cannot see this shape at all: there the name sits directly after an \
                 identifier byte and is skipped as part of a longer word."
            ));
        }

        // --- legacy macro import ---------------------------------------------
        if squashed.contains(macro_use.as_str()) {
            labels.push(format!(
                "[rb78/macro-use:{file}] a legacy macro import. It drops every exported rule of \
                 a dependency into this crate's root namespace, so a divert above a gate needs \
                 no import line in the module that uses it and no module in this crate ever \
                 names the macro it expands."
            ));
        }

        // --- glob imports -----------------------------------------------------
        let mut globbed: Option<String> = None;
        for (at, _) in squashed.match_indices(glob.as_str()) {
            let mut s = at;
            while s > 0 && is_ident_byte(bytes[s - 1]) {
                s -= 1;
            }
            let root = String::from_utf8_lossy(&bytes[s..at]).into_owned();
            if !glob_roots.iter().any(|k| root == *k) {
                globbed = Some(root);
            }
        }
        if let Some(root) = globbed {
            labels.push(format!(
                "[rb78/glob-import:{file}] a glob import rooted at `{root}`, which is not one of \
                 the three in-crate roots. THE ROUTE THIS CLOSES: a dependency that exports a \
                 rule named exactly like the admitted builder shadows it in this module, with no \
                 line anywhere in this crate naming the macro — the path form, the by-name import \
                 and the legacy macro import are each closed by a clause above, and this was the \
                 last one left. The in-crate roots stay allowed because everything they can \
                 re-export lives in a file this same census already reads."
            ));
        }

        // --- everything below needs at least one gate site in this file -------
        let regions = rb78_region_texts(&squashed);
        if regions.is_empty() {
            continue;
        }

        if bracket_chars
            .iter()
            .any(|needle| squashed.contains(needle.as_str()))
        {
            labels.push(format!(
                "[rb78/char-literal-bracket:{file}] a brace CHAR literal survived stripping in a \
                 file that CARRIES a deletion gate. The stripper consumes char literals \
                 atomically and KEEPS them, so that brace reaches the region parser's depth \
                 counter as a real one and strands it — after which the region boundary for \
                 every gate below is wrong. Scoped to gate-bearing files deliberately: the \
                 privacy module spells both braces in its hand-rolled serializer and carries no \
                 gate at all. Spell the character with a Unicode escape; never delete this \
                 check, and never separate it from the brace-only depth counter it guards."
            ));
        }

        for region in &regions {
            if region.contains(raw_ident.as_str()) {
                labels.push(format!(
                    "[rb78/raw-ident:{file}] a RAW IDENTIFIER inside a deletion-gate region (raw \
                     STRINGS are blanked first, so an identifier is the only survivor). It is \
                     the one spelling that lets a macro wear a keyword NAME, which is the only \
                     way the unary-negation exemptions in this grammar could ever be claimed by \
                     an attacker rather than by honest code."
                ));
                break;
            }
        }

        for region in &regions {
            labels.extend(rb78_region_macro_labels(file, region));
        }
    }

    if labels.is_empty() {
        return Ok(());
    }
    Err(format!(
        "rb-78 ADR-0248 FAIL — {count} clause(s):\n  - {body}",
        count = labels.len(),
        body = labels.join("\n  - ")
    ))
}

/// Assert that `sources` is rejected AND that each expected clause label is
/// among the collected ones.
fn rb78_assert_rejected(case: &str, sources: Vec<(String, String)>, expected: &[&str]) {
    let Err(message) = rb78_macro_verdict(&sources) else {
        panic!(
            "rb-78 ADR-0248 TEETH FAIL ({case}): the verdict ACCEPTED this source. Every shape \
             in this matrix either routes a real caller around an authorization gate while \
             leaving the gate statement, its log tag and rb-46's textual return census \
             byte-identically green, or is a scan-integrity hazard that would let such a route \
             go undetected. An accepted fixture means the clause guarding against one of these \
             is missing."
        );
    };
    for label in expected {
        assert!(
            message.contains(label),
            "rb-78 ADR-0248 TEETH FAIL ({case}): rejected, but never by the clause `{label}` \
             this fixture exists to exercise — that clause is unproven and some other rule is \
             carrying the rejection. Collected:\n{message}"
        );
    }
}

/// The bare reducer attribute, assembled.
fn rb78_attr_reducer() -> String {
    ["#[spacetimedb::", "reducer]"].concat()
}

/// One fully-qualified CALLER-ONLY gate statement, as an indented body line.
fn rb78_gate_line(tag: &str) -> String {
    let q = double_quote();
    format!(
        "    {call}ctx, {q}{tag}{q})?;",
        call = rb78_needle_caller_gate()
    )
}

/// One fully-qualified SUBJECT-keyed gate statement, as an indented body line.
fn rb78_subject_gate_line() -> String {
    format!(
        "    {call}ctx, subject)?;",
        call = rb78_needle_subject_gate()
    )
}

/// One fully-qualified STAMP-aware gate statement, as an indented body line.
fn rb78_stamp_gate_line(tag: &str) -> String {
    let q = double_quote();
    format!(
        "    {call}ctx, {q}{tag}{q}, offer.created_at_ms)?;",
        call = rb78_needle_stamp_gate()
    )
}

/// F0 — the clean control; if this is rejected, no rejection below proves
/// anything.
///
/// Carries, on purpose, every shape an over-eager matcher would trip on: a
/// macro-laden reducer ABOVE the gated one (which the item-boundary region rule
/// must exclude — a whole-file scan would red here), the admitted builder INSIDE
/// the gated prefix, a logging macro BELOW the gate, parenthesised unary
/// negation glued to a keyword, a not-equals comparison, a negated method call,
/// a closure argument, two attributes on the gated reducer, an in-crate glob in
/// an inline test module, and a PAREN char literal — which is inert to a
/// brace-only depth counter and must stay admitted.
fn rb78_fx_clean() -> Vec<(String, String)> {
    let q = double_quote();
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let cfg = format!("#[cfg(feature = {q}dev_reducers{q})]");
    let builder = format!(
        "            let e = {b}{q}dup{q});",
        b = rb78_needle_format_bang()
    );
    let info = format!("    log::info!({q}admitted{q});");
    let paren_char = format!("    let open = {c};", c = ["'", "(", "'"].concat());
    let src = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn noisy(ctx: &ReducerContext) -> Result<(), String> {",
        "    let v = vec![1u8, 2u8];",
        "    assert!(v.len() == 2);",
        "    debug_assert!(!v.is_empty());",
        "    Ok(())",
        "}",
        "#[allow(clippy::too_many_arguments)]",
        cfg.as_str(),
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext, a: bool, b: bool) -> Result<(), String> {",
        "    let me = ctx.sender();",
        "    if !(a && b) {",
        "        return Err(REJECT.to_string());",
        "    }",
        "    if a != b {",
        "        return Err(REJECT.to_string());",
        "    }",
        "    let ids: Vec<u64> = Vec::new();",
        "    let mut seen = std::collections::HashSet::new();",
        "    for &id in &ids {",
        "        if !seen.insert(id) {",
        builder.as_str(),
        "            return Err(e);",
        "        }",
        "    }",
        "    let p = ctx.db.player().identity().find(me).ok_or_else(|| REJECT.to_string())?;",
        gate.as_str(),
        info.as_str(),
        paren_char.as_str(),
        "    Ok(())",
        "}",
        "#[cfg(test)]",
        "mod tests {",
        "    use super::*;",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F19 — parenthesised unary negation after a keyword, ABOVE a gate: admitted.
///
/// The second control, and it exists for the exemption list specifically. A
/// macro cannot bear the name `break` without a raw identifier (its own clause),
/// so exempting the keyword costs nothing — but only a fixture can prove the
/// exemption is reachable and that it does not swallow the file.
fn rb78_fx_unary_break() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let src = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext, flag: bool) -> Result<(), String> {",
        "    let stop = loop {",
        "        break !(flag);",
        "    };",
        "    if stop {",
        "        return Err(REJECT.to_string());",
        "    }",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F1 — the literal measured proof-of-concept shape: a STATEMENT-position macro
/// one line above the gate. Kills a grammar that only reads expressions.
fn rb78_fx_statement_macro() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let src = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        "    let me = ctx.sender();",
        "    bail!(ctx);",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F2 — EXPRESSION position, above the SUBJECT-keyed gate. Two claims in one
/// row: a bound expansion diverts exactly as a bare statement does, and the
/// region rule is driven by all three wrapper needles, not only the caller-only
/// one (a grammar wired to a single needle would accept this file whole).
fn rb78_fx_expression_macro() -> Vec<(String, String)> {
    let gate = rb78_subject_gate_line();
    let src = [
        "use crate::schema::player;",
        "pub(crate) fn begin(ctx: &ReducerContext, subject: Identity) -> Result<u64, String> {",
        "    let _x = admit!(ctx);",
        gate.as_str(),
        "    Ok(0)",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F3 — a macro nested inside the ADMITTED builder's own argument list. The row
/// the allow-list must not shelter: a needle that stopped at the first admitted
/// name, or that skipped the rest of the call, would read this file as clean.
fn rb78_fx_nested_in_builder() -> Vec<(String, String)> {
    let q = double_quote();
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let builder = format!(
        "    let e = {b}{q}{{}}{q}, evil!(ctx));",
        b = rb78_needle_format_bang()
    );
    let src = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        builder.as_str(),
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F4 — the BRACE delimiter form, above the STAMP-aware gate. A macro accepts
/// all three bracket kinds; rb-77 MEASURED the brace spelling shipping a bypass
/// past a paren-anchored needle, which is why this grammar is delimiter-agnostic
/// everywhere except the one admitted builder.
fn rb78_fx_brace_macro() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_stamp_gate_line("respond");
    let src = [
        "use crate::schema::trade_offer;",
        attr.as_str(),
        "pub fn respond(ctx: &ReducerContext, offer: TradeOffer) -> Result<(), String> {",
        "    admit! { ctx }",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("trading.rs".to_string(), src)]
}

/// F5 — the SQUARE delimiter form. Same class as F4, third bracket kind; square
/// brackets are additionally invisible to the brace-only depth counter, so this
/// also proves the counter does not need them.
fn rb78_fx_square_macro() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let src = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        "    admit![ctx];",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F6 — the rule DEFINED inside the reducer body, directly above its own
/// invocation.
///
/// TWO THINGS THIS KILLS, neither of them F1's. First, the definition's braces
/// and its arm-separating semicolon all sit at brace depth one or deeper, so a
/// region rule that took the last semicolon ANYWHERE (rather than the last one
/// at depth zero) would start the region BELOW the divert and read the file as
/// clean. Second, the definition's own bang is followed by an identifier, not a
/// delimiter, so the grammar must find the INVOCATION rather than the keyword.
fn rb78_fx_inbody_rule_definition() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let src = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        "    macro_rules! rb78_admit {",
        "        ($c:expr) => {",
        "            if $c.sender() != crate::WILD_IDENTITY {",
        "                return Ok(());",
        "            }",
        "        };",
        "    }",
        "    rb78_admit!(ctx);",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F7 — the WHOLE REDUCER wrapped in a macro invocation. The gate statement, its
/// log tag and its `?` are all still written verbatim, so every per-site pin in
/// this crate stays green; what the wrapper emits around them is not in the
/// file. Caught because the region reaches back to the enclosing ITEM boundary,
/// which is above the wrapper's own bang.
fn rb78_fx_whole_fn_wrapper() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("buy");
    let indented_attr = format!("    {attr}");
    let src = [
        "use crate::schema::player;",
        "wrap! {",
        indented_attr.as_str(),
        "    pub fn buy(ctx: &ReducerContext) -> Result<(), String> {",
        "        let me = ctx.sender();",
        gate.as_str(),
        "        Ok(())",
        "    }",
        "}",
    ]
    .join("\n");
    vec![("economy.rs".to_string(), src)]
}

/// F8 — the reducer GENERATED from a rule body, with the divert inside the
/// generated prefix.
///
/// HONEST SCOPE, and it is the reason this row is a fixture rather than a live
/// mutant: a generated reducer whose prefix invokes NO macro is not caught here,
/// because the rule keyword's own bang is followed by an identifier. That shape
/// is already owned elsewhere — the reducer attribute and the signature appear
/// verbatim inside the rule body, so rb-46's body extractor parses the generated
/// reducer exactly as it parses a hand-written one and its clause I counts the
/// textual return. What is NEW here, and what this row pins, is that the region
/// reaches INTO a rule body at all.
fn rb78_fx_generated_reducer() -> Vec<(String, String)> {
    let q = double_quote();
    let attr = rb78_attr_reducer();
    let indented_attr = format!("        {attr}");
    let gate = format!(
        "            {call}ctx, $tag)?;",
        call = rb78_needle_caller_gate()
    );
    let invoke = format!("gen_buy!({q}buy{q});");
    let src = [
        "use crate::schema::player;",
        "macro_rules! gen_buy {",
        "    ($tag:expr) => {",
        indented_attr.as_str(),
        "        pub fn buy(ctx: &ReducerContext) -> Result<(), String> {",
        "            admit!(ctx);",
        gate.as_str(),
        "            Ok(())",
        "        }",
        "    };",
        "}",
        invoke.as_str(),
    ]
    .join("\n");
    vec![("economy.rs".to_string(), src)]
}

/// F9 — the builder reached through a PATH. Two clauses, deliberately: the
/// crate-wide re-spelling ban sees the qualifier anywhere in the file, and the
/// region clause refuses to admit it above a gate. Either alone would leave the
/// other's blind spot open — a qualified call outside any region, and an
/// unqualified shadow inside one.
fn rb78_fx_path_qualified_builder() -> Vec<(String, String)> {
    let q = double_quote();
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let builder = format!(
        "    let e = std::{b}{q}dup{q});",
        b = rb78_needle_format_bang()
    );
    let src = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        builder.as_str(),
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F10 — the builder SHADOWED by a local rule definition, in a SECOND file that
/// carries no gate at all. Kills a verdict that only scans gate-bearing files:
/// the shadow lives in the crate root, the divert it enables lives in a reducer
/// module, and no single file is suspicious on its own.
fn rb78_fx_shadow_rule_in_second_file() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let battle = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    let shadow = format!("macro_rules! {f} {{", f = rb78_token_format());
    let root = [
        "mod battle;",
        shadow.as_str(),
        "    ($($t:tt)*) => {",
        "        String::new()",
        "    };",
        "}",
    ]
    .join("\n");
    vec![
        ("battle.rs".to_string(), battle),
        ("lib.rs".to_string(), root),
    ]
}

/// F11 — the builder's NAME bound to another item by a rename import. The
/// re-spelling clause cannot see this: the name sits directly after an
/// identifier byte there and is skipped as part of a longer word. This row is
/// the whole reason the alias clause requires no LEFT boundary.
fn rb78_fx_rename_import() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let alias = format!("use game_core::evil as {f};", f = rb78_token_format());
    let src = [
        "use crate::schema::player;",
        alias.as_str(),
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F12 — the builder's name imported BY NAME from a dependency. The mirror of
/// F11: here the alias clause is blind (no rename keyword) and the re-spelling
/// clause carries the rejection, because the name is preceded by a path colon.
fn rb78_fx_by_name_import() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let imported = format!("use game_core::{f};", f = rb78_token_format());
    let src = [
        "use crate::schema::player;",
        imported.as_str(),
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F13 — a RAW IDENTIFIER macro name above the gate. Both clauses must fire: the
/// region's raw-identifier ban (the spelling that lets a macro wear a keyword
/// name, which is the only route to claiming an exemption) and the macro clause
/// itself, which reads the name with the raw prefix stripped off by the
/// identifier-byte walk.
fn rb78_fx_raw_identifier_macro() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let raw = format!("    {r}bail!(ctx);", r = rb77_needle_raw_ident());
    let src = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        raw.as_str(),
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F14 — the legacy macro import in the crate root. Every exported rule of the
/// dependency lands in the root namespace, so the divert in the reducer module
/// needs no import line and names nothing importable.
fn rb78_fx_legacy_macro_import() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let battle = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    let legacy = format!("#[{m}]", m = ["macro_", "use"].concat());
    let root = ["mod battle;", legacy.as_str(), "extern crate game_core;"].join("\n");
    vec![
        ("battle.rs".to_string(), battle),
        ("lib.rs".to_string(), root),
    ]
}

/// F15 — a brace CHAR literal in a GATE-BEARING file. It survives the stripper
/// and strands the region parser's depth counter, so every region below it is
/// computed from the wrong boundary. The clause is what keeps the brace-only
/// depth counter honest, and it is scoped to gate-bearing files because the
/// privacy module spells both braces legitimately and carries no gate.
fn rb78_fx_brace_char_literal() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let ch = format!(
        "pub(crate) const OPEN: char = {c};",
        c = ["'", "{", "'"].concat()
    );
    let src = [
        "use crate::schema::player;",
        ch.as_str(),
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F16 — a NESTED block comment in a gate-bearing file. The stripper stops at
/// the first closer, so the outer comment's tail reaches this scan as code: a
/// region boundary, a declaration, anything. Raised as a label rather than the
/// panic the sibling helpers use, precisely so this row can observe it.
fn rb78_fx_nested_block_comment() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let comment = format!(
        "{open} outer {open} inner {close} ; pub fn decoy() {{}} {close}",
        open = rb77_needle_open_marker(),
        close = rb77_needle_close_marker()
    );
    let src = [
        "use crate::schema::player;",
        comment.as_str(),
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F17 — a macro in SIGNATURE position. Nothing in the body is touched, so a
/// body-only scan reads the prefix as empty; the type the macro expands to can
/// carry the divert through a `From` impl or a default. Caught only because the
/// region starts at the item boundary rather than at the body brace.
fn rb78_fx_signature_macro() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let src = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext, v: ty!()) -> Result<(), String> {",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F18 — a GLOB import from a dependency. The last route by which an exported
/// rule can shadow the admitted builder with no line in this crate naming it:
/// the path form, the by-name import and the legacy macro import are each closed
/// by their own clause above, and none of them sees this one.
fn rb78_fx_glob_import() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let src = [
        "use crate::schema::player;",
        "use game_core::*;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F20 — the DISCLOSED fail-closed false RED, asserted so the disclosure is
/// measured rather than promised.
///
/// Squashing glues a preceding keyword onto the builder's name, so an honest
/// `return` of a built string above a gate reads as a macro named
/// `returnformat` and IS rejected. This is deliberate: the alternative is to
/// match the six admitted bytes as a SUFFIX, which would then admit the
/// builder's name wearing ANY prefix an attacker cares to glue in front of it.
/// When this fires on honest code the remedy is to bind the string to a local
/// first — never to loosen the byte sequence.
fn rb78_fx_keyword_glued_builder() -> Vec<(String, String)> {
    let q = double_quote();
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let glued = format!(
        "        return {b}{q}id{q});",
        b = rb78_needle_format_bang()
    );
    let src = [
        "use crate::schema::player;",
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        "    fn describe(id: u64) -> String {",
        glued.as_str(),
        "    }",
        "    let label = describe(1u64);",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F21 — a raw-string opener with THREE hashes in a gate-bearing module.
///
/// The second of the three substrate triggers, and the only one measured on the
/// RAW text rather than on the stripped view — which is why the literal may sit
/// ANYWHERE in the file rather than above the gate. The crate's shared
/// byte-sequential stripper carries a conservative refusal for this construct
/// (`assert_stripper_preconditions`, `m22s5_assert_source_is_scannable`) because
/// a hash depth it mis-parses blanks the WRONG byte range: every clause in this
/// grammar would then read text nobody wrote, and a divert parked in the
/// mis-blanked span would be invisible while the verdict reported Ok. Re-raised
/// here as a LABEL rather than a panic so this row can observe it — and the
/// remedy when it fires is to extend the stripper's hash-depth handling and
/// re-derive, never to drop the precondition.
fn rb78_fx_deep_raw_string() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let deep = format!(
        "pub(crate) const DOC: &str = {r}{q}note{q}{h};",
        r = ["r#", "##"].concat(),
        q = double_quote(),
        h = ["#", "##"].concat()
    );
    let src = [
        "use crate::schema::player;",
        deep.as_str(),
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// F22 — an UNPAIRED block-comment opener above the gate, in a gate-bearing
/// module. The third substrate trigger, and the sharpest of the three.
///
/// WHAT THIS ROW ACTUALLY PROVES. The stripper scans forward from the opener for
/// a closer that never comes, so it blanks the file to its LAST BYTE. The gate
/// needle is gone with it, the region set is EMPTY, and every macro clause below
/// is therefore skipped — meaning that WITHOUT this clause the verdict would
/// return `Ok(())` for a file whose entire contents, diverts included, it never
/// looked at. That is the one failure mode a source-scan gate cannot survive:
/// silent, total vacuity that reads exactly like a clean file. The marker-count
/// check is deliberately taken on the RAW text, because by the time the scan has
/// the stripped view there is nothing left to count.
fn rb78_fx_unpaired_block_comment() -> Vec<(String, String)> {
    let attr = rb78_attr_reducer();
    let gate = rb78_gate_line("gated");
    let opener = format!(
        "{open} the closer is missing on purpose",
        open = rb77_needle_open_marker()
    );
    let src = [
        "use crate::schema::player;",
        opener.as_str(),
        attr.as_str(),
        "pub fn gated(ctx: &ReducerContext) -> Result<(), String> {",
        gate.as_str(),
        "    Ok(())",
        "}",
    ]
    .join("\n");
    vec![("battle.rs".to_string(), src)]
}

/// Every source this grammar scans: the crate root, every module `lib.rs`
/// declares, and the wrapper file itself.
///
/// The roster is DERIVED from the crate root's own declarations
/// ([`rb76_scanned_module_names`], which already includes `lib` and excludes
/// `guards` plus the sibling test modules), never enumerated — a hand-written
/// list is exactly the hole a newly added module would walk through. The crate
/// root and the wrapper file come from the compile-time embeds the sibling
/// blocks already use; every other module is read from disk at RUN time, which
/// means a STALE TEST BINARY run over edited sources reports on bytes it did not
/// compile. That matters only to mutation runners, which must rebuild between
/// rows.
fn rb78_live_sources() -> Vec<(String, String)> {
    let root = env!("CARGO_MANIFEST_DIR");
    let mut out: Vec<(String, String)> = vec![("lib.rs".to_string(), RB76_LIB_RS.to_string())];
    for name in rb76_scanned_module_names() {
        if name == "lib" {
            continue;
        }
        let path = format!("{root}/src/{name}.rs");
        let src = std::fs::read_to_string(path.as_str()).unwrap_or_else(|err| {
            panic!(
                "rb-78 ADR-0248 FAIL (unscanned module): the crate root declares module \
                 `{name}` but its source could not be read at `{path}` ({err}). An unreadable \
                 module is an UNSCANNED module and this grammar refuses to skip one: a legacy \
                 macro import or a glob in ANY module shadows the one admitted builder for the \
                 whole crate. If the module is path-relocated, teach the derived roster the \
                 path — never drop the module."
            )
        });
        out.push((format!("{name}.rs"), src));
    }
    out.push(("guards.rs".to_string(), GUARDS_RS.to_string()));
    out
}

/// TEN squashed function markers that MUST each fall inside some live gate
/// region — at least one per GATE-BEARING MODULE: battle, economy, npc, pvp,
/// raising, ranking, taming, trading. Not a floor, and not the site set
/// (rb-46, rb-76 and rb-80 own those).
///
/// WHY PER-MODULE COVERAGE, AND NOT FEWER ANCHORS. The per-needle control
/// above only asks that each of the three wrapper needles matches somewhere in
/// the crate, and `battle.rs` alone satisfies all three. So an entire other
/// module's sites could stop being spelled fully qualified — an
/// import-shadowed or aliased call — and would simply DROP OUT of the region
/// scan: no region, no macro clause, no complaint, while every other assertion
/// in this test stayed green. One anchor per gate-bearing module is what makes
/// "the slicer reached this file" an assertion rather than an assumption. The
/// set spans all three wrapper needles and every awkward framing the tree
/// carries: a conditional attribute above the reducer attribute
/// (`start_wild_battle`, `grant_bait`) and a helper with no reducer attribute
/// at all (`begin_encounter`). It is one anchor per MODULE, never a second
/// site census — which is why `propose_trade` and `advance_dialogue` are
/// absent (their files are covered by `respond_trade` and `talk`). rb-80
/// RE-DERIVED the last three rows when ADR-0250 D1-D4 made `raising.rs`,
/// `npc.rs` and `taming.rs` gate-bearing; never just delete a row.
fn rb78_region_anchors() -> [String; 10] {
    [
        ["fnstart_", "battle("].concat(),
        ["fnbegin_", "encounter("].concat(),
        ["fnstart_wild_", "battle("].concat(),
        ["fnrespond_", "trade("].concat(),
        ["fnb", "uy("].concat(),
        ["fnchallenge_", "pvp("].concat(),
        ["fnset_profile_", "name("].concat(),
        ["fnheal_", "party("].concat(),
        ["fnt", "alk("].concat(),
        ["fngrant_", "bait("].concat(),
    ]
}

/// The RAW `guards.rs` line marker of this slice's reviewer note (ADR-0248 D5).
fn rb78_note_marker() -> String {
    ["// rb-78 (ADR-0", "248)"].concat()
}

/// The RAW `guards.rs` declaration line of the pure decision seam — the note's
/// UPPER anchor.
fn rb78_line_decision_seam() -> String {
    ["pub(crate) fn deletion_", "gate("].concat()
}

/// The RAW `guards.rs` declaration line of the caller-only wrapper — the note's
/// LOWER anchor.
fn rb78_line_caller_wrapper() -> String {
    ["pub(crate) fn require_not_", "deleting("].concat()
}

/// **ADR-0248 D4 (live oracle)** — no macro expands above any of the crate's
/// fully-qualified deletion gates, the admitted builder's name is neither
/// re-spelled nor re-bound in any module, and the D5 reviewer note sits between
/// the pure decision seam and the caller-only wrapper.
///
/// The verdict IS the invariant; it already folds in every clause and every
/// substrate label. The assertions after it are POSITIVE CONTROLS, not floors
/// for their own sake, and they are what stop this test passing over nothing:
/// each of the three wrapper needles must still match live text, and the region
/// slicer must still reach ten named reducer prefixes covering EVERY
/// gate-bearing module — battle, economy, npc, pvp, raising, ranking, taming and
/// trading. The per-module spread is the load-bearing half: `battle.rs` satisfies all three
/// needles, so without it an entire other module could stop being scanned and
/// only the anchors would notice. Without either, a renamed wrapper, a
/// re-spelled qualification or a stranded depth counter would leave the region
/// set EMPTY and every macro clause would report Ok about a crate it never
/// looked at.
///
/// THE NOTE CLAUSE IS THE ONLY THING RED AT HEAD, and that is the honest shape
/// of this slice: the shipped tree is clean, so every macro clause is green by
/// construction. Proof-of-teeth therefore lives in the fixture matrix below and
/// in the ledger's X5 live mutant register on the REAL files — a source-scan
/// gate whose only evidence is "the clean tree passes" has proved nothing.
///
/// HONEST LIMIT: source scan. It says no macro is WRITTEN above a gate; it
/// cannot say the gate runs, that nothing above it returns early by ordinary
/// means (rb-46 clause I), or that the verdict is correct (the executed
/// matrices in `battle_tests.rs` / `economy_tests.rs` / this file's rb-76
/// matrix). It is also blind to a procedural macro, which needs a manifest
/// dependency and is therefore a different residual class.
#[test]
fn rb78_no_macro_expands_above_any_deletion_gate() {
    let sources = rb78_live_sources();

    if let Err(message) = rb78_macro_verdict(&sources) {
        panic!(
            "rb-78 ADR-0248 FAIL (live): the shipped crate violates the macro-expansion \
             grammar above at least one deletion gate. Every clause below names the rule it \
             broke. A macro above a gate is the MEASURED CI-clean bypass this block exists \
             for: it routes every real caller around an authorization check while the gate \
             statement, its log tag, its `?` and rb-46's textual return census all stay \
             byte-identically green.\n{message}"
        );
    }

    // --- positive controls: the needles and the slicer still reach real text --
    let squashed: Vec<(String, String)> = sources
        .iter()
        .map(|(file, raw)| (file.clone(), rb78_squashed(raw)))
        .collect();
    for needle in &rb78_gate_needles() {
        let hits: usize = squashed
            .iter()
            .map(|(_, text)| text.matches(needle.as_str()).count())
            .sum();
        assert!(
            hits >= 1,
            "rb-78 ADR-0248 FAIL (live control): one of the three fully-qualified deletion-gate \
             wrapper calls matches NOTHING in the whole crate. This grammar slices its regions \
             from those call sites, so a needle that matches nothing contributes no region and \
             every macro clause behind it is vacuous. Either a wrapper was renamed — in which \
             case re-derive the needle here and re-argue its call sites — or a site stopped \
             being fully qualified, which is its own defect and is pinned per file by rb-46, \
             rb-47, rb-76 and m22-s3b. Never delete a needle to make this green."
        );
    }

    let regions: Vec<String> = squashed
        .iter()
        .flat_map(|(_, text)| rb78_region_texts(text))
        .collect();
    for anchor in &rb78_region_anchors() {
        let found = regions.iter().any(|r| r.contains(anchor.as_str()));
        assert!(
            found,
            "rb-78 ADR-0248 FAIL (live control): no gate region contains the squashed \
             declaration `{anchor}`, so EVERY GATE-BEARING MODULE NO LONGER CONTRIBUTES AT \
             LEAST ONE REGION — which is exactly what this control asserts, one anchor per \
             module across battle, economy, npc, pvp, raising, ranking, taming and trading. \
             The needle control above cannot see this: `battle.rs` satisfies all three, so a whole \
             other module can fall out of the scan while that count stays happy, and every \
             macro clause for it is then skipped in silence. The likely causes, in order: that \
             reducer's gate stopped being fully qualified (an import-shadowed or aliased call), \
             a brace CHAR literal stranded the depth counter above zero so every later region \
             starts at the wrong boundary, or the reducer was renamed. Investigate the slicer \
             against the file, and if the reducer really is gone re-derive that module's anchor \
             deliberately; never shorten this list to make a build green — a region that \
             reaches nothing bans nothing."
        );
    }

    // --- the D5 reviewer note (the only RED clause at HEAD) ------------------
    let lines: Vec<&str> = GUARDS_RS.lines().collect();
    let seam = rb78_line_decision_seam();
    let wrapper = rb78_line_caller_wrapper();
    let note = rb78_note_marker();
    let at = |needle: &str| -> Vec<usize> {
        lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.starts_with(needle))
            .map(|(i, _)| i)
            .collect()
    };
    let seam_at = at(seam.as_str());
    let wrapper_at = at(wrapper.as_str());
    let note_at = at(note.as_str());
    let n_seam = seam_at.len();
    let n_wrapper = wrapper_at.len();
    let n_note = note_at.len();

    assert_eq!(
        n_seam, 1,
        "rb-78 ADR-0248 FAIL (note anchor): `guards.rs` has {n_seam} line(s) beginning with the \
         pure decision seam's declaration and must have exactly one. This is half the positive \
         control for the clause below: without both anchors the note check would pass by \
         looking between nothing and nothing."
    );
    assert_eq!(
        n_wrapper, 1,
        "rb-78 ADR-0248 FAIL (note anchor): `guards.rs` has {n_wrapper} line(s) beginning with \
         the caller-only wrapper's declaration and must have exactly one. The other half of the \
         positive control for the clause below."
    );
    assert_eq!(
        n_note, 1,
        "rb-78 ADR-0248 FAIL (reviewer note, D5): {n_note} line(s) of `guards.rs` begin with \
         this slice's reviewer note and exactly one must. ZERO IS THE RED STATE AT HEAD and it \
         is what this slice exists to fix. The note is half the residual's disposition — the \
         half a reviewer reads without running anything: `guards.rs` is where somebody stands \
         when they wonder why these wrappers are called the way they are, and the \
         machine-checked half lives in a test file they may never open. It goes MID-FILE rather \
         than at the end because `guards.rs` carries no knowledge-bundle line stamp, so an \
         inserted comment block shifts nothing gated."
    );

    let note_line = note_at[0];
    let seam_line = seam_at[0];
    let wrapper_line = wrapper_at[0];
    assert!(
        seam_line < note_line && note_line < wrapper_line,
        "rb-78 ADR-0248 FAIL (reviewer note, D5 placement): the note sits at line index \
         {note_line} of `guards.rs`, outside the range between the pure decision seam \
         ({seam_line}) and the caller-only wrapper ({wrapper_line}). The position is the point: \
         the note explains why NO macro may expand above a call to the wrappers below it, and a \
         reader meets it immediately before the first of them. Parked at the top of the file it \
         is a banner nobody reads; parked at the bottom it is behind every wrapper it \
         describes."
    );
}

/// **ADR-0248 D4 (fixture matrix)** — twenty-one frozen macro-divert inputs
/// (F1-F18, F20, F21, F22), each rejected by the clause it exists to exercise,
/// plus two clean controls (F0, F19). All three substrate triggers now have a
/// row of their own: F16 the nested block comment, F21 the deep raw-string
/// opener, F22 the unpaired opener that blanks the file to its last byte. No
/// numeric floor stands on that count anywhere in the code — this sentence is
/// prose, and it is the reader's map, so keep it true when a row is added.
///
/// Every fixture writes its OWN full text from fragments: no shared builder and
/// no base-plus-mutation, so one bad helper cannot make the whole matrix
/// vacuous, and no contiguous production marker enters this file's source. The
/// expected labels are hand-written here and produced independently by the
/// collector, so the pair is a transcription check rather than a tautology, and
/// they are asserted by MEMBERSHIP — a genuinely broken source breaks several
/// clauses at once, and the fixture only claims the one it was written for. The
/// wrong source each row kills is named in the fixture's own doc comment above.
///
/// THE TWO CONTROLS CARRY THE WHOLE MATRIX. F0 holds every shape an over-eager
/// matcher trips on — a macro-laden reducer ABOVE the gated one, the admitted
/// builder inside the gated prefix, a logging macro below the gate, three
/// spellings of a negation, two attributes, an in-crate glob and a paren char
/// literal — and F19 holds the one keyword exemption that is reachable from
/// honest code. A grammar that refuses everything proves nothing about the
/// diverts it is supposed to catch.
#[test]
fn rb78_macro_divert_fixtures_are_rejected_by_clause() {
    if let Err(message) = rb78_macro_verdict(&rb78_fx_clean()) {
        panic!(
            "rb-78 ADR-0248 TEETH FAIL (F0 clean control): the verdict REJECTED an honest \
             source. Every rejection below is meaningless while this is red — and on the real \
             tree it would be a false RED that invites somebody to widen a clause rather than \
             fix a defect, which is the one outcome this whole block must not produce.\n\
             {message}"
        );
    }
    if let Err(message) = rb78_macro_verdict(&rb78_fx_unary_break()) {
        panic!(
            "rb-78 ADR-0248 TEETH FAIL (F19 unary-negation control): the verdict REJECTED a \
             parenthesised unary negation after a keyword. The exemption list exists for \
             exactly this, it is safe because a macro cannot bear a keyword name without a raw \
             identifier (its own clause), and it must stay reachable — otherwise the first \
             honest `break !(flag)` in a gated prefix reds the build.\n{message}"
        );
    }

    rb78_assert_rejected(
        "F1 statement-position macro",
        rb78_fx_statement_macro(),
        &["[rb78/macro-above-gate:battle.rs:bail]"],
    );
    rb78_assert_rejected(
        "F2 expression-position macro above the subject gate",
        rb78_fx_expression_macro(),
        &["[rb78/macro-above-gate:battle.rs:admit]"],
    );
    rb78_assert_rejected(
        "F3 macro nested in the admitted builder's argument",
        rb78_fx_nested_in_builder(),
        &["[rb78/macro-above-gate:battle.rs:evil]"],
    );
    rb78_assert_rejected(
        "F4 brace delimiter above the stamp-aware gate",
        rb78_fx_brace_macro(),
        &["[rb78/macro-above-gate:trading.rs:admit]"],
    );
    rb78_assert_rejected(
        "F5 square delimiter",
        rb78_fx_square_macro(),
        &["[rb78/macro-above-gate:battle.rs:admit]"],
    );
    rb78_assert_rejected(
        "F6 in-body rule definition plus invocation",
        rb78_fx_inbody_rule_definition(),
        &["[rb78/macro-above-gate:battle.rs:rb78_admit]"],
    );
    rb78_assert_rejected(
        "F7 whole-reducer wrapper macro",
        rb78_fx_whole_fn_wrapper(),
        &["[rb78/macro-above-gate:economy.rs:wrap]"],
    );
    rb78_assert_rejected(
        "F8 reducer generated from a rule body",
        rb78_fx_generated_reducer(),
        &["[rb78/macro-above-gate:economy.rs:admit]"],
    );
    rb78_assert_rejected(
        "F9 path-qualified builder",
        rb78_fx_path_qualified_builder(),
        &[
            "[rb78/format-respelt:battle.rs]",
            "[rb78/macro-above-gate:battle.rs:format]",
        ],
    );
    rb78_assert_rejected(
        "F10 builder shadowed by a rule in a second file",
        rb78_fx_shadow_rule_in_second_file(),
        &["[rb78/format-respelt:lib.rs]"],
    );
    rb78_assert_rejected(
        "F11 builder name bound by a rename import",
        rb78_fx_rename_import(),
        &["[rb78/format-alias:battle.rs]"],
    );
    rb78_assert_rejected(
        "F12 builder name imported by name",
        rb78_fx_by_name_import(),
        &["[rb78/format-respelt:battle.rs]"],
    );
    rb78_assert_rejected(
        "F13 raw-identifier macro name",
        rb78_fx_raw_identifier_macro(),
        &[
            "[rb78/raw-ident:battle.rs]",
            "[rb78/macro-above-gate:battle.rs:bail]",
        ],
    );
    rb78_assert_rejected(
        "F14 legacy macro import in the crate root",
        rb78_fx_legacy_macro_import(),
        &["[rb78/macro-use:lib.rs]"],
    );
    rb78_assert_rejected(
        "F15 brace char literal in a gate-bearing file",
        rb78_fx_brace_char_literal(),
        &["[rb78/char-literal-bracket:battle.rs]"],
    );
    rb78_assert_rejected(
        "F16 nested block comment in a gate-bearing file",
        rb78_fx_nested_block_comment(),
        &["[rb78/scan-substrate:battle.rs]"],
    );
    rb78_assert_rejected(
        "F17 macro in signature position",
        rb78_fx_signature_macro(),
        &["[rb78/macro-above-gate:battle.rs:ty]"],
    );
    rb78_assert_rejected(
        "F18 glob import from a dependency",
        rb78_fx_glob_import(),
        &["[rb78/glob-import:battle.rs]"],
    );
    rb78_assert_rejected(
        "F20 disclosed keyword-glued builder (fail-closed false RED)",
        rb78_fx_keyword_glued_builder(),
        &["[rb78/macro-above-gate:battle.rs:returnformat]"],
    );
    rb78_assert_rejected(
        "F21 deep raw-string opener in a gate-bearing file",
        rb78_fx_deep_raw_string(),
        &["[rb78/scan-substrate:battle.rs]"],
    );
    rb78_assert_rejected(
        "F22 unpaired block-comment opener above the gate",
        rb78_fx_unpaired_block_comment(),
        &["[rb78/scan-substrate:battle.rs]"],
    );
}

// ===========================================================================
// rb-80 (ADR-0250 D1-D4) — the rb-78 ANCHOR-ROSTER control for the three
// modules this slice turns into gate-bearing ones.
//
// rb-78's live oracle (`rb78_no_macro_expands_above_any_deletion_gate`) asserts
// that no bang macro expands between a reducer's item boundary and its
// fully-qualified deletion gate, in EVERY module `lib.rs` declares. Its
// coverage, however, is only as wide as `rb78_region_anchors()`: a module whose
// gate stops being fully qualified contributes NO region, and a region that does
// not exist bans nothing. That is why the roster's own doc comment requires a new
// gate-bearing module's anchor to be re-derived DELIBERATELY rather than noticed
// later.
//
// This test is that re-derivation, made mechanical: `raising.rs`, `npc.rs` and
// `taming.rs` each gain a caller-gate call in this slice, so each must appear in
// the roster AND each must actually contribute a live region. Two clauses, in
// this order, because they fail for different reasons and the first is a
// transcription check while the second is the implementation claim.
// ===========================================================================

/// **rb-80 (ADR-0250 D1-D4)** — rb-78's anchor roster covers the three modules
/// this slice makes gate-bearing, and each of them contributes at least one LIVE
/// region to the macro grammar.
///
/// WHAT EACH CLAUSE KILLS, in the order they report:
///   * THE ROSTER SIZE. Ten anchors, one per gate-bearing module (battle,
///     economy, npc, pvp, raising, ranking, taming, trading). Seven is the state
///     before this slice's roster edit and is a RED here: three modules would be
///     gated and invisible to rb-78's grammar, so a macro expanded above any of
///     the four new gates would pass CI in silence.
///   * THE ROSTER CONTENT. Each of the three new anchors must be PRESENT by
///     equality, not merely counted — a roster grown to ten by duplicating an
///     existing row, or by anchoring a module on a reducer that carries no gate,
///     satisfies a size check and covers nothing (register row M20).
///   * THE LIVE REGIONS. Each new anchor must fall inside a region the slicer
///     actually cut out of a live source. This is the clause the implementation
///     has to satisfy: it is RED until the four gates are wired, because a
///     module with no fully-qualified gate call yields no region at all.
///
/// WHY `npc.rs` IS ANCHORED ONCE. `rb78_region_anchors()` is one anchor per
/// MODULE, never a site census: `advance_dialogue`'s own region is pinned by
/// rb-80's `npc_tests.rs` clauses, and adding a second npc row here would start a
/// site list this roster deliberately is not (the same reasoning that keeps
/// `propose_trade` out of it while `trading.rs` is covered by `respond_trade`).
///
/// HONEST LIMIT: this test proves COVERAGE, never cleanliness. Whether a macro
/// actually expands above one of the new gates is rb-78's verdict, which this
/// roster edit brings to bear on three more files; and it says nothing about
/// whether the gates are correct, which is rb-80's business in the three sibling
/// test files.
#[test]
fn rb80_rb78_anchor_roster_covers_the_new_gate_bearing_modules() {
    let anchors = rb78_region_anchors();
    assert_eq!(
        anchors.len(),
        10,
        "rb-80 [rb80/anchor-roster] FAIL: `rb78_region_anchors()` carries {} anchor(s) and must \
         carry 10 — one per GATE-BEARING MODULE, and this slice makes `raising.rs`, `npc.rs` and \
         `taming.rs` three more of them (ADR-0250 D1-D4). SEVEN IS THE PRE-SLICE STATE: under it \
         the three new modules contribute no anchor, so rb-78's live control would stay green \
         while a macro-divert above any of the four new gates went unexamined — the region scan \
         only bans what it reaches. Never shrink this roster to make a build green; re-derive the \
         module's anchor instead.",
        anchors.len()
    );

    let new_anchors = [
        ["fnheal_", "party("].concat(),
        ["fnt", "alk("].concat(),
        ["fngrant_", "bait("].concat(),
    ];

    for wanted in &new_anchors {
        let present = anchors.iter().any(|a| a == wanted);
        assert!(
            present,
            "rb-80 [rb80/anchor-roster] FAIL: `rb78_region_anchors()` does not contain the \
             squashed declaration `{wanted}`. A roster grown to ten by duplicating an existing \
             row, or by anchoring one of the new modules on a reducer that carries no gate, \
             satisfies the size clause above and covers NOTHING (register row M20). Membership is \
             asserted by equality against fragments spelled here independently of the roster's \
             own, so a transcription error in either place surfaces as this failure rather than \
             as silence."
        );
    }

    let sources = rb78_live_sources();
    let squashed: Vec<(String, String)> = sources
        .iter()
        .map(|(file, raw)| (file.clone(), rb78_squashed(raw)))
        .collect();
    let regions: Vec<String> = squashed
        .iter()
        .flat_map(|(_, text)| rb78_region_texts(text))
        .collect();

    for wanted in &new_anchors {
        let found = regions.iter().any(|r| r.contains(wanted.as_str()));
        assert!(
            found,
            "rb-80 [rb80/anchor-region] E1 FAIL: no live rb-78 gate region contains the squashed \
             declaration `{wanted}`, so that module contributes NO region to the macro-expansion \
             grammar. THIS IS THE RED STATE AT HEAD: `raising.rs`, `npc.rs` and `taming.rs` carry \
             no fully-qualified deletion-gate call yet, and the slicer cuts its regions from those \
             call sites — no call, no region, no macro clause, no complaint. After the fix the \
             likely causes, in order: that reducer's gate stopped being fully qualified (an \
             import-shadowed or aliased call), a brace CHAR literal stranded the depth counter \
             above zero so every later region starts at the wrong boundary, or the reducer was \
             renamed. Investigate the slicer against the file; if the reducer really is gone, \
             re-derive that module's anchor deliberately. Regions found: {}.",
            regions.len()
        );
    }
}
