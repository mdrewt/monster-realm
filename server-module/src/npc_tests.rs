//! `npc_tests` — M12b gating unit tests for pure seams in npc.rs.
//!
//! Tests `dialogue_state_from_db`, `dialogue_state_flags_to_vec`, and
//! `dialogue_state_done_to_vec` (the DB<->game_core marshal roundtrip helpers
//! that convert SpacetimeDB flat Vec<String> columns into BTreeSet-backed
//! `game_core::PlayerDialogueState`), and the `game_core::npc_decide`
//! determinism boundary (called from the M12b `npc_tick` reducer).
//!
//! RED state: this file does not compile until npc.rs is created with
//! `dialogue_state_from_db`, `dialogue_state_flags_to_vec`, `dialogue_state_done_to_vec`.
//! Reducer-level tests (T-TALK-*, T-ADV-*, T-QUEST-*) are in the eval
//! (no SpacetimeDB test harness in this project; all unit tests are pure).

use super::*;
use std::collections::BTreeSet;

// ---------------------------------------------------------------------------
// A. Dialogue state marshal roundtrip tests
//
// Functions under test (will live in server-module/src/npc.rs):
//
//   pub(crate) fn dialogue_state_from_db(
//       flags_vec: Vec<String>,
//       done_quests_vec: Vec<String>,
//       active_quest_ids: Vec<String>,
//   ) -> game_core::PlayerDialogueState
//
//   pub(crate) fn dialogue_state_flags_to_vec(
//       state: &game_core::PlayerDialogueState,
//   ) -> Vec<String>
//
//   pub(crate) fn dialogue_state_done_to_vec(
//       state: &game_core::PlayerDialogueState,
//   ) -> Vec<String>
//
// None of these exist yet — the tests compile only after the implementer
// creates npc.rs and declares the #[path] module link from a domain file.
// ---------------------------------------------------------------------------

/// M12b: flags roundtrip through from_db → flags_to_vec yields sorted BTreeSet order.
///
/// kills: an impl that stores flags in an unsorted Vec (the client and server
/// would compare flag sets differently depending on insertion order, causing
/// false "no flag" misses on conditions like HasFlag("flag_b")).
/// BTreeSet guarantees deterministic sorted order regardless of input order.
#[test]
fn dialogue_state_from_db_round_trips_flags() {
    // Input in reverse alphabetical order: BTreeSet must sort them.
    let flags = vec!["flag_b".to_string(), "flag_a".to_string()];
    let state = dialogue_state_from_db(flags, vec![], vec![]);
    let out = dialogue_state_flags_to_vec(&state);
    assert_eq!(
        out,
        vec!["flag_a".to_string(), "flag_b".to_string()],
        "dialogue_state_flags_to_vec must return flags in BTreeSet sorted order; \
         got {:?} (input was [flag_b, flag_a] — unsorted impl would fail here)",
        out
    );
}

/// M12b: active_quest_ids passed to from_db populate state.active_quests.
///
/// kills: an impl that ignores the active_quest_ids parameter entirely, or
/// stores them in done_quests instead (quest advance conditions like
/// QuestActive("quest_001") would always return false — all quests stalled).
#[test]
fn dialogue_state_from_db_active_quests_populated() {
    let state = dialogue_state_from_db(vec![], vec![], vec!["quest_001".to_string()]);
    assert!(
        state.active_quests.contains("quest_001"),
        "state.active_quests must contain 'quest_001' after passing it as active_quest_ids; \
         got active_quests: {:?}",
        state.active_quests
    );
    assert!(
        state.done_quests.is_empty(),
        "state.done_quests must be empty when done_quests_vec is empty; \
         got: {:?}",
        state.done_quests
    );
    assert!(
        state.flags.is_empty(),
        "state.flags must be empty when flags_vec is empty; got: {:?}",
        state.flags
    );
}

/// M12b: all-empty inputs produce all-empty BTreeSets (zero-crossing invariant).
///
/// kills: an impl that pre-populates any field, or one that initialises
/// active_quests/done_quests/flags from a wrong source (e.g. treats
/// done_quests_vec as flags).
#[test]
fn dialogue_state_from_db_empty_is_all_empty() {
    let state = dialogue_state_from_db(vec![], vec![], vec![]);
    assert!(
        state.flags.is_empty(),
        "flags must be empty for empty input; got: {:?}",
        state.flags
    );
    assert!(
        state.active_quests.is_empty(),
        "active_quests must be empty for empty input; got: {:?}",
        state.active_quests
    );
    assert!(
        state.done_quests.is_empty(),
        "done_quests must be empty for empty input; got: {:?}",
        state.done_quests
    );
}

/// M12b: done_quests roundtrip through from_db → done_to_vec yields sorted order.
///
/// kills: an impl that stores done_quests in an unsorted Vec, or one that
/// confuses done_quests_vec with active_quest_ids (the two columns are additive
/// and must not be swapped — QuestDone("quest_a") would false-miss if quest_a
/// is stored in active_quests instead of done_quests).
#[test]
fn dialogue_state_done_to_vec_round_trips() {
    let done = vec!["quest_b".to_string(), "quest_a".to_string()];
    let state = dialogue_state_from_db(vec![], done, vec![]);
    let out = dialogue_state_done_to_vec(&state);
    assert_eq!(
        out,
        vec!["quest_a".to_string(), "quest_b".to_string()],
        "dialogue_state_done_to_vec must return done_quests in BTreeSet sorted order; \
         got {:?}",
        out
    );
    // Confirm active_quests not contaminated.
    assert!(
        state.active_quests.is_empty(),
        "active_quests must remain empty when only done_quests_vec is supplied; \
         got: {:?}",
        state.active_quests
    );
}

// ---------------------------------------------------------------------------
// B. npc_decide determinism (game-core boundary)
//
// These tests call game_core::npc_decide directly — the function exists and is
// pub-re-exported from game_core. They gate the M12b server-side assumption
// that the function is deterministic (used in npc_tick to advance NPC wander
// every tick without storing the direction).
// ---------------------------------------------------------------------------

/// M12b: npc_decide is deterministic — identical inputs produce identical output.
///
/// kills: any impl that reads wall-clock, OS entropy, or a mutable global RNG
/// instead of computing deterministically from (current, home, radius, npc_id, tick).
/// The server calls npc_decide once per tick per NPC; different calls with the
/// same inputs must agree (no drift between replicas).
#[test]
fn npc_decide_same_inputs_same_direction() {
    let home = game_core::TilePos { x: 5, y: 5 };
    let current = game_core::TilePos { x: 4, y: 5 };
    let a = game_core::npc_decide(current, home, 2, 99u64, 42u64);
    let b = game_core::npc_decide(current, home, 2, 99u64, 42u64);
    assert_eq!(a, b, "npc_decide must be deterministic");
}

/// M12b: an NPC with wander_radius=0 and current == home must never move.
///
/// kills: an impl that ignores wander_radius=0 and always picks a random
/// direction (the NPC would wander off its spawn tile with no way to recall it).
/// When radius is 0 the NPC is "at home" (distance 0 <= radius 0) and the
/// wander path's `h % 5 == 0` stay-probability check eventually triggers; but
/// for radius=0 the spec requires NEVER moving, so the correct implementation
/// must special-case radius=0 OR the distance==0 branch must always yield None.
/// With the current rules.rs impl: distance=0 <= radius=0 → wander path; for
/// at least some seeds h % 5 != 0 → would move; radius=0 is the hard constraint.
/// This test documents the M12b REQUIREMENT; it may drive an impl-level choice
/// to add `if wander_radius == 0 { return None; }` at the top of npc_decide.
#[test]
fn npc_decide_radius_zero_never_moves() {
    let home = game_core::TilePos { x: 5, y: 5 };
    let dir = game_core::npc_decide(home, home, 0, 42u64, 7u64);
    assert!(
        dir.is_none(),
        "NPC with wander_radius=0 must never move; got {:?}",
        dir
    );
}
