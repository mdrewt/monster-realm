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
