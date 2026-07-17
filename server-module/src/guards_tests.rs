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
