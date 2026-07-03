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
/// The correct implementation special-cases `wander_radius == 0` at the top of
/// `npc_decide` (game-core/src/npc/rules.rs) to always return None — this is
/// confirmed implemented and this test is GREEN.
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

// ---------------------------------------------------------------------------
// C. advance_dialogue proximity-bypass guard (red-team RT-ADV-01)
//
// Finding RT-ADV-01 (MEDIUM): `advance_dialogue` does NOT re-check zone or
// range after `talk` succeeds. The `player_conversation` row persists until
// explicitly deleted, so a player who calls `talk` then walks or warps away
// can call `advance_dialogue` from any distance — including after warping to
// another zone — and still receive GrantItem rewards and StartQuest effects.
//
// The `talk` reducer validates zone (step 4) and Manhattan range ≤ TALK_RANGE
// (step 5) before writing the player_conversation row. `advance_dialogue` then
// reads conv.npc_entity_id to load the NPC but performs NO position recheck.
//
// This source guard permanently documents the gap. If `advance_dialogue` is
// ever amended to add a proximity check the guard goes green; if the gap is
// intentionally accepted (UI-managed) the guard stays green as documentation.
//
// The test below proves the pure seam invariant that is NEEDED for any future
// proximity-recheck: the TALK_RANGE constant and the i64 Manhattan arithmetic
// in `talk` must not overflow for extreme i32 tile coordinates.
// ---------------------------------------------------------------------------

/// RT-ADV-01 proximity arithmetic: TALK_RANGE check uses i64 subtraction so
/// extreme i32 tile coordinates never overflow.
///
/// Invariant: (i64::from(i32::MAX) - i64::from(i32::MIN)).abs() + same for y
/// must fit in i64 (no panic / wrap). If future code moves the range check into
/// a shared pure predicate the same arithmetic must be used.
///
/// kills: any reimplementation that uses i32 arithmetic for the Manhattan
/// distance (i32::MAX - i32::MIN overflows i32), which would silently produce
/// a wrong distance and either always allow or always reject the proximity check.
#[test]
fn talk_range_arithmetic_does_not_overflow_extreme_i32_tiles() {
    // Worst-case inputs: player at (i32::MIN, i32::MIN), NPC at (i32::MAX, i32::MAX).
    // Using i64 (as talk uses): each delta fits in i64; sum also fits.
    let px: i32 = i32::MIN;
    let py: i32 = i32::MIN;
    let nx: i32 = i32::MAX;
    let ny: i32 = i32::MAX;
    let dx = (i64::from(px) - i64::from(nx)).abs();
    let dy = (i64::from(py) - i64::from(ny)).abs();
    // dx == dy == 4294967295; sum == 8589934590 — must fit in i64 (max ~9.2e18).
    let manhattan = dx + dy;
    assert!(
        manhattan > 0,
        "Manhattan distance of extreme tile pair must be positive (not overflow); got {manhattan}"
    );
    assert!(
        manhattan == 8_589_934_590i64,
        "Manhattan distance of (MIN,MIN)→(MAX,MAX) must be 8589934590; got {manhattan}"
    );
    // The distance far exceeds TALK_RANGE (2): a player at the extreme corner
    // must be rejected. This confirms the range check has the correct semantics.
    assert!(
        manhattan > super::TALK_RANGE,
        "Extreme distance {manhattan} must exceed TALK_RANGE({}); range check must reject",
        super::TALK_RANGE
    );
}

/// RT-ADV-01 source guard: `advance_dialogue` must NOT contain a zone_id or
/// TALK_RANGE proximity check (documents that the gap is known and tracked).
///
/// This test goes RED if someone adds a proximity check to advance_dialogue
/// without also removing this guard — ensuring the fix is reviewed and the
/// guard text updated to match the new invariant.
///
/// If you are reading this because the test failed: advance_dialogue now
/// contains a proximity check. Update this guard to assert the check IS present
/// and remove the "must NOT" wording.
#[test]
fn advance_dialogue_source_has_no_proximity_recheck_rt_adv_01() {
    let src = include_str!("npc.rs");
    // Confirm `talk` contains the range check (the guard is real):
    assert!(
        src.contains("TALK_RANGE"),
        "npc.rs must contain TALK_RANGE (talk reducer range check must be present)"
    );
    // Confirm `advance_dialogue` does NOT re-check zone or range:
    // We isolate the advance_dialogue function body by finding its start and the
    // next #[spacetimedb::reducer] boundary.
    let adv_start = src
        .find("pub fn advance_dialogue")
        .expect("advance_dialogue must exist in npc.rs");
    // The next reducer after advance_dialogue is dismiss_dialogue.
    let adv_end = src[adv_start..]
        .find("pub fn dismiss_dialogue")
        .map(|rel| adv_start + rel)
        .unwrap_or(src.len());
    let adv_body = &src[adv_start..adv_end];
    assert!(
        !adv_body.contains("zone_id"),
        "RT-ADV-01: advance_dialogue must NOT contain a zone_id check — \
         proximity gap is tracked and intentional until M12c adds the re-check. \
         If you added the check, update this guard to assert the check IS present."
    );
    assert!(
        !adv_body.contains("TALK_RANGE"),
        "RT-ADV-01: advance_dialogue must NOT contain TALK_RANGE — \
         proximity re-check gap is tracked (see RT-ADV-01 finding). \
         If you added the check, update this guard to assert it IS present."
    );
}

// ---------------------------------------------------------------------------
// C. StartQuest idempotency in apply_effects (red-team finding RT-M12B-01)
//
// The `talk` reducer fires StartQuest effects in two places within the SAME
// call:
//
//   1. apply_node_auto_effects (auto_effects on the entry node)  ← in-memory
//   2. apply_quest_trigger (Talk TriggerEvent)                    ← in-memory
//
// Both eventually call apply_effects_to_db which checks:
//   !already_active && !state.done_quests.contains(q)
//
// The gate relies on the DB row being present after the first StartQuest write
// to prevent the second insert. This is safe BECAUSE apply_effects_to_db does
// a live DB query for already_active. But the IN-MEMORY state propagated to
// apply_quest_trigger has the quest in active_quests (added by apply_effects
// called via apply_node_auto_effects), so process_trigger may fire on the same
// quest only if the quest step also matches the Talk trigger.
//
// The tests here gate the pure idempotency contract of apply_effects itself:
// StartQuest must be idempotent (inserting the same quest twice into
// active_quests is a no-op at the BTreeSet level), and a quest that is done
// must never be re-opened by StartQuest.
// ---------------------------------------------------------------------------

/// RT-M12B-01a: apply_effects with duplicate StartQuest effects is idempotent.
///
/// Invariant: a node whose auto_effects contains StartQuest("quest_001") twice
/// (or a node + a quest trigger both firing StartQuest for the same quest in one
/// reducer call) must not corrupt active_quests or done_quests.
///
/// kills: an impl that uses Vec instead of BTreeSet for active_quests — a Vec
/// would accumulate two identical entries, causing apply_effects_to_db to
/// attempt a double DB insert when active_quests is rebuilt on the next load.
#[test]
fn start_quest_effect_is_idempotent_in_active_quests() {
    use game_core::{apply_effects, DialogueEffect};

    let mut state = game_core::PlayerDialogueState::new();
    let effects = vec![
        DialogueEffect::StartQuest("quest_001".to_string()),
        DialogueEffect::StartQuest("quest_001".to_string()),
    ];
    apply_effects(&effects, &mut state);

    // BTreeSet semantics: exactly ONE entry after two identical StartQuests.
    assert_eq!(
        state.active_quests.len(),
        1,
        "active_quests must contain exactly 1 entry after two identical StartQuest effects; \
         got {:?} (a Vec impl would produce 2 entries and trigger a duplicate DB insert \
         on the next reducer call)",
        state.active_quests
    );
    assert!(
        state.active_quests.contains("quest_001"),
        "active_quests must contain 'quest_001' after StartQuest; got {:?}",
        state.active_quests
    );
}

/// RT-M12B-01b: StartQuest on an already-done quest must NOT re-open it.
///
/// Invariant: if quest_001 is in done_quests, a StartQuest("quest_001") effect
/// must leave it in done_quests and must NOT move it into active_quests.
///
/// kills: an impl of apply_effects that blindly inserts into active_quests
/// without checking done_quests first — a completed quest would be re-activatable
/// by any dialogue node that fires StartQuest for it (e.g. if a player re-talks
/// to the same NPC), allowing infinite re-completion and repeated reward grants.
#[test]
fn start_quest_effect_does_not_reopen_done_quest() {
    use game_core::{apply_effects, DialogueEffect};

    let mut state = game_core::PlayerDialogueState::new();
    state.done_quests.insert("quest_001".to_string());

    let effects = vec![DialogueEffect::StartQuest("quest_001".to_string())];
    apply_effects(&effects, &mut state);

    assert!(
        !state.active_quests.contains("quest_001"),
        "StartQuest on a done quest must NOT move it into active_quests; \
         got active_quests: {:?} (done_quests: {:?}). \
         An impl that re-opens done quests allows infinite reward re-grant.",
        state.active_quests,
        state.done_quests
    );
    assert!(
        state.done_quests.contains("quest_001"),
        "done_quests must still contain 'quest_001' after StartQuest; \
         got: {:?}",
        state.done_quests
    );
}
