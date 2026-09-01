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
/// instead of computing deterministically from
/// (current, home, radius, facing, npc_id, tick, map).
/// The server calls npc_decide once per tick per NPC; different calls with the
/// same inputs must agree (no drift between replicas).
///
/// ADR-0159 D2: `npc_decide` gained `facing: Direction` and `map: &TileMap`
/// params (collision-/radius-aware wander); this call site is updated
/// positionally (facing=North, map=the real zone_0() grid) — the assertion
/// itself (determinism) is unaffected by the migration.
#[test]
fn npc_decide_same_inputs_same_direction() {
    let map = game_core::zone_0();
    let home = game_core::TilePos { x: 5, y: 5 };
    let current = game_core::TilePos { x: 4, y: 5 };
    let a = game_core::npc_decide(
        current,
        home,
        2,
        game_core::Direction::North,
        99u64,
        42u64,
        &map,
    );
    let b = game_core::npc_decide(
        current,
        home,
        2,
        game_core::Direction::North,
        99u64,
        42u64,
        &map,
    );
    assert_eq!(a, b, "npc_decide must be deterministic");
}

/// M12b: an NPC with wander_radius=0 and current == home must never move.
///
/// kills: an impl that ignores wander_radius=0 and always picks a random
/// direction (the NPC would wander off its spawn tile with no way to recall it).
/// The correct implementation special-cases `wander_radius == 0` at the top of
/// `npc_decide` (game-core/src/npc/rules.rs) to always return None — this is
/// confirmed implemented and this test is GREEN.
///
/// ADR-0159 D2: unaffected by the migration (the radius==0 pinned-stay special
/// case is checked before any facing/map consultation); call site updated
/// positionally.
#[test]
fn npc_decide_radius_zero_never_moves() {
    let map = game_core::zone_0();
    let home = game_core::TilePos { x: 5, y: 5 };
    let dir = game_core::npc_decide(
        home,
        home,
        0,
        game_core::Direction::South,
        42u64,
        7u64,
        &map,
    );
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

/// RT-ADV-01 FIXED (M12c): advance_dialogue must contain both a zone_id check
/// AND a TALK_RANGE check (proximity re-check) to close the security gap found
/// in RT-ADV-01.
///
/// This test is RED before M12c implementation: advance_dialogue currently has
/// NO zone_id or TALK_RANGE in its body (documented by the old guard, now deleted).
/// When M12c adds the proximity re-check, this test turns GREEN.
///
/// Kills: any impl that adds the check to talk but omits it from advance_dialogue,
/// leaving the session-persistent player_conversation row exploitable — a player
/// who talks then warps away can still call advance_dialogue from any zone/range.
///
/// Do NOT remove this test unless the invariant is intentionally changed to
/// UI-managed proximity (with a separate architectural decision recorded).
#[test]
fn advance_dialogue_has_proximity_recheck_rt_adv_01_fixed() {
    let src = include_str!("npc.rs");
    // Confirm `talk` still contains the range check (baseline sanity).
    assert!(
        src.contains("TALK_RANGE"),
        "npc.rs must contain TALK_RANGE (talk reducer range check must be present)"
    );
    // Isolate advance_dialogue body: from its fn def to the next pub fn.
    let adv_start = src
        .find("pub fn advance_dialogue")
        .expect("advance_dialogue must exist in npc.rs");
    let adv_end = src[adv_start..]
        .find("pub fn dismiss_dialogue")
        .map(|rel| adv_start + rel)
        .unwrap_or(src.len());
    let adv_body = &src[adv_start..adv_end];
    assert!(
        adv_body.contains("zone_id"),
        "RT-ADV-01 FIXED: advance_dialogue must contain a zone_id check — \
         M12c must add a zone membership re-check to close RT-ADV-01. \
         Without it, a player who talks then warps to another zone can still \
         call advance_dialogue and receive GrantItem / StartQuest effects. \
         This test is RED until M12c adds the check."
    );
    assert!(
        adv_body.contains("TALK_RANGE"),
        "RT-ADV-01 FIXED: advance_dialogue must contain a TALK_RANGE check — \
         M12c must add a proximity distance re-check to close RT-ADV-01. \
         Without it, a player who moves out of range during an active conversation \
         can still advance dialogue choices and receive rewards. \
         This test is RED until M12c adds the check."
    );
    assert!(
        adv_body.contains("advance_dialogue_dismissed"),
        "RT-ADV-01 FIXED: advance_dialogue must log 'advance_dialogue_dismissed' \
         when the conversation is auto-dismissed on walk-away or zone change. \
         Silent dismissal makes operational debugging impossible. \
         This test is RED until M12c adds the log event."
    );
}

/// M12c NPC zone policy: NPCs must NOT be warped through warp tiles.
///
/// `movement_tick` in movement.rs must use `unwrap_or(true)` (not `unwrap_or(false)`)
/// so that characters WITHOUT a player row (i.e. NPCs) are treated as "in battle"
/// for warp purposes — meaning they SKIP the warp path and stay in their zone.
///
/// The current code at the warp guard reads:
///   .unwrap_or(false); // NPCs have no player row → treat as not in battle → warp them
/// M12c must change this to:
///   .unwrap_or(true);  // NPCs have no player row → skip warp (no player = no warp)
///
/// This test goes RED until M12c makes that change: it asserts `unwrap_or(true)`
/// is present and `unwrap_or(false)` is absent at the warp guard site.
///
/// Kills: any impl that keeps unwrap_or(false) causing NPCs to teleport through
/// warp tiles — an NPC wandering over a warp tile would jump zones and become
/// permanently unreachable from the player (wrong zone) until a server restart.
#[test]
fn npc_warp_guard_skips_warp_for_no_player_row() {
    let src = include_str!("movement.rs");
    // The warp guard block contains the unwrap_or call that decides whether NPCs
    // are warped. We find the warp guard region by locating the battle lookup
    // pattern. The change from false→true is load-bearing for NPC zone policy.
    assert!(
        !src.contains(".unwrap_or(false); // NPCs have no player row"),
        "M12c NPC zone policy VIOLATED: movement.rs still has `unwrap_or(false)` \
         at the warp guard — NPCs with no player row are treated as NOT in battle \
         and therefore WARPED through warp tiles. M12c must change this to \
         `unwrap_or(true)` so NPCs skip the warp path entirely. \
         This test is RED until M12c makes that change."
    );
    assert!(
        src.contains(".unwrap_or(true)"),
        "M12c NPC zone policy: movement.rs must use `unwrap_or(true)` at the warp \
         guard so that NPCs (no player row) skip warp tiles. \
         This test is RED until M12c changes unwrap_or(false) to unwrap_or(true)."
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

// ===========================================================================
// Source-guard tests for `talk` and `advance_dialogue` range-check arithmetic
// (following the battle_tests.rs / content_tests.rs source-guard pattern).
//
// These kill mutants in npc.rs that change arithmetic operators in reducer
// bodies that cannot be reached by unit tests (require ReducerContext/DB).
//
// Killed mutants:
//   talk:      217:28 (!=→==), 222:45 (-→+), 223:45 (-→+),
//              224:11 (+→*), 224:16 (>→<), 231:49 (==→!=)
//   advance:   308:28 (!=→==), 315:45 (-→+), 316:45 (-→+),
//              317:11 (+→*), 317:16 (>→<), 328:49 (==→!=), 333:54 (==→!=)
// ===========================================================================

const NPC_SOURCE: &str = include_str!("npc.rs");

/// Strip Rust block comments and line comments (same pattern as battle_tests.rs).
fn strip_npc_comments(src: &str) -> String {
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
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// Extract the body of a named fn from `src` (comment-stripped).
fn extract_npc_fn_body<'a>(src: &'a str, name: &str) -> Option<&'a str> {
    let pub_needle = format!("pub fn {}(", name);
    let priv_needle = format!("fn {}(", name);
    let fn_start = src
        .find(pub_needle.as_str())
        .or_else(|| src.find(priv_needle.as_str()))?;
    let after_fn = &src[fn_start..];
    let brace_offset = after_fn.find('{')?;
    let body_start = fn_start + brace_offset + 1;
    let mut depth: usize = 1;
    let mut rel: usize = 0;
    let chars: Vec<char> = src[body_start..].chars().collect();
    let mut char_pos = 0;
    while char_pos < chars.len() && depth > 0 {
        match chars[char_pos] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        rel += chars[char_pos].len_utf8();
        char_pos += 1;
    }
    if depth == 0 {
        Some(&src[body_start..body_start + rel])
    } else {
        None
    }
}

// --- talk source-guard tests ------------------------------------------------

/// Source-guard: `talk` must check zone inequality (!=), not equality (==).
/// Mutant 217:28 (replace != with ==) would accept players in the WRONG zone.
/// KILLS: npc.rs:217:28 (zone_id != npc_char.zone_id → zone_id == npc_char.zone_id).
#[test]
fn talk_zone_check_uses_ne_not_eq() {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "talk").expect("pub fn talk must exist in npc.rs");
    // The zone inequality: must reject when player_char.zone_id != npc_char.zone_id.
    // Build needle from parts to avoid self-match (this test is NOT inside npc.rs).
    let zone_ne = ["player_char.zone_id", " != npc_char.zone_id"].concat();
    assert!(
        body.contains(zone_ne.as_str()),
        "TEETH(npc.rs:217): `talk` must contain `player_char.zone_id != npc_char.zone_id`; \
         the mutant replaces != with == causing players in the WRONG zone to pass \
         and players in the SAME zone to be rejected (completely inverted zone guard)"
    );
}

/// Source-guard: `talk` computes dx/dy by SUBTRACTION, not addition.
/// Mutants 222:45 and 223:45 replace `-` with `+` in the tile-delta arithmetic.
/// With `+`, dx = (player_x + npc_x).abs() — a large positive distance even for
/// adjacent tiles — making the range guard always reject (nobody can ever talk).
/// KILLS: npc.rs:222:45 and npc.rs:223:45.
#[test]
fn talk_dx_dy_uses_subtraction_not_addition() {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "talk").expect("pub fn talk must exist in npc.rs");
    // Check that the dx delta uses subtraction. Assembled from parts.
    let dx_sub = ["tile_x) - i64", "::from(npc_char.tile_x)"].concat();
    assert!(
        body.contains(dx_sub.as_str()),
        "TEETH(npc.rs:222): `talk` dx computation must use subtraction \
         (`tile_x) - i64::from(npc_char.tile_x)`); \
         mutant replaces `-` with `+`, making distance = sum of coordinates \
         (always huge) so no player is ever close enough to talk"
    );
    let dy_sub = ["tile_y) - i64", "::from(npc_char.tile_y)"].concat();
    assert!(
        body.contains(dy_sub.as_str()),
        "TEETH(npc.rs:223): `talk` dy computation must use subtraction; \
         mutant replaces `-` with `+` making distance wrong (always large)"
    );
}

/// Source-guard: `talk` computes Manhattan distance as dx + dy, not dx * dy.
/// Mutant 224:11 replaces `+` with `*`, turning Manhattan into an area product
/// (always too large unless on exact axis), breaking range checks for adjacent tiles.
/// KILLS: npc.rs:224:11 (dx + dy → dx * dy).
#[test]
fn talk_manhattan_uses_addition_not_multiplication() {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "talk").expect("pub fn talk must exist in npc.rs");
    // The Manhattan distance formula. Assembled to avoid self-match.
    let manhattan = ["dx + dy > ", "TALK_RANGE"].concat();
    assert!(
        body.contains(manhattan.as_str()),
        "TEETH(npc.rs:224): `talk` range check must use `dx + dy > TALK_RANGE` \
         (Manhattan distance with ADDITION); \
         mutant replaces `+` with `*` turning it into a product (dx * dy > ...) — \
         a player at (0,2) from NPC has dx=0,dy=2 → product=0, always passes; \
         a player at (1,1) from NPC has dx=1,dy=1 → product=1, TALK_RANGE=2 passes \
         when it shouldn't — wrong distance metric"
    );
}

/// Source-guard: `talk` range check uses `>` (greater-than), not `<` (less-than).
/// Mutant 224:16 replaces `>` with `<` in `if dx + dy > TALK_RANGE`, causing
/// talk to accept far-away players and reject nearby ones (completely inverted).
/// KILLS: npc.rs:224:16 (> → <).
#[test]
fn talk_range_check_uses_gt_not_lt() {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "talk").expect("pub fn talk must exist in npc.rs");
    // Positive: `> TALK_RANGE` must be present.
    let gt_range = "dy > TALK_RANGE";
    assert!(
        body.contains(gt_range),
        "TEETH(npc.rs:224): `talk` range guard must use `> TALK_RANGE`; \
         mutant replaces `>` with `<`, accepting players far away and rejecting nearby ones"
    );
    // Negative: `< TALK_RANGE` must NOT be present in this context.
    let lt_range = "dy < TALK_RANGE";
    assert!(
        !body.contains(lt_range),
        "TEETH(npc.rs:224): `talk` range guard must NOT use `< TALK_RANGE`; \
         found `dy < TALK_RANGE` which inverts the proximity check (rejects adjacent tiles)"
    );
}

/// Source-guard: `talk` dialogue-tree lookup uses `==` (equality), not `!=`.
/// Mutant 231:49 replaces `==` with `!=` in `find(|t| t.id == npc_row.dialogue_tree_id)`,
/// causing talk to pick a tree whose ID does NOT match the NPC's dialogue_tree_id —
/// wrong NPC conversation or always-None (nothing matches when trees are checked for inequality).
/// KILLS: npc.rs:231:49 (== → !=).
#[test]
fn talk_dialogue_tree_lookup_uses_eq_not_ne() {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "talk").expect("pub fn talk must exist in npc.rs");
    // The dialogue tree lookup uses ==. Assembled from parts.
    let tree_eq = ["t.id ==", " npc_row.dialogue_tree_id"].concat();
    assert!(
        body.contains(tree_eq.as_str()),
        "TEETH(npc.rs:231): `talk` dialogue-tree lookup must use `t.id == npc_row.dialogue_tree_id`; \
         mutant replaces `==` with `!=` causing the wrong tree to be selected \
         (one whose ID does NOT match the NPC) — garbled dialogue or always-Err('dialogue tree not found')"
    );
}

// --- advance_dialogue source-guard tests ------------------------------------

/// Source-guard: `advance_dialogue` zone check uses `!=`, not `==`.
/// Mutant 308:28 replaces `!=` with `==` in the zone re-check.
/// With `==`: the reducer would ACCEPT players in the wrong zone (dismissed when same zone!).
/// The RT-ADV-01 fix added this exact zone re-check; inverting it reopens the vulnerability.
/// KILLS: npc.rs:308:28 (player_char.zone_id != npc_char.zone_id → ==).
#[test]
fn advance_dialogue_zone_check_uses_ne_not_eq() {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "advance_dialogue")
        .expect("pub fn advance_dialogue must exist in npc.rs");
    let zone_ne = ["player_char.zone_id", " != npc_char.zone_id"].concat();
    assert!(
        body.contains(zone_ne.as_str()),
        "TEETH(npc.rs:308): `advance_dialogue` must contain `player_char.zone_id != npc_char.zone_id`; \
         the RT-ADV-01 zone re-check (M12c) must use inequality; mutant replaces != with == \
         causing dismissal for SAME-zone players and acceptance across zones (inverted guard)"
    );
}

/// Source-guard: `advance_dialogue` computes dx/dy by SUBTRACTION, not addition.
/// Mutants 315:45 and 316:45 replace `-` with `+` in the proximity re-check arithmetic.
/// KILLS: npc.rs:315:45 and npc.rs:316:45.
#[test]
fn advance_dialogue_dx_dy_uses_subtraction_not_addition() {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "advance_dialogue")
        .expect("pub fn advance_dialogue must exist in npc.rs");
    let dx_sub = ["tile_x) - i64", "::from(npc_char.tile_x)"].concat();
    assert!(
        body.contains(dx_sub.as_str()),
        "TEETH(npc.rs:315): `advance_dialogue` dx computation must use subtraction; \
         mutant replaces `-` with `+` making distance wrong (sum not delta)"
    );
    let dy_sub = ["tile_y) - i64", "::from(npc_char.tile_y)"].concat();
    assert!(
        body.contains(dy_sub.as_str()),
        "TEETH(npc.rs:316): `advance_dialogue` dy computation must use subtraction; \
         mutant replaces `-` with `+` making distance wrong"
    );
}

/// Source-guard: `advance_dialogue` range check uses `dx + dy > TALK_RANGE`.
/// Mutant 317:11 replaces `+` with `*`; mutant 317:16 replaces `>` with `<`.
/// KILLS: npc.rs:317:11 (+→*) and npc.rs:317:16 (>→<).
#[test]
fn advance_dialogue_range_check_uses_manhattan_gt_talk_range() {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "advance_dialogue")
        .expect("pub fn advance_dialogue must exist in npc.rs");
    let manhattan_gt = ["dx + dy > ", "TALK_RANGE"].concat();
    assert!(
        body.contains(manhattan_gt.as_str()),
        "TEETH(npc.rs:317): `advance_dialogue` range check must use `dx + dy > TALK_RANGE`; \
         mutant 317:11 replaces `+` with `*` (product vs Manhattan); \
         mutant 317:16 replaces `>` with `<` (inverted — dismisses nearby players, \
         accepts far ones). Both must be absent."
    );
    // Negative check for inverted operator — scoped to advance_dialogue body only:
    let lt_range = "dy < TALK_RANGE";
    assert!(
        !body.contains(lt_range),
        "TEETH(npc.rs:317): `advance_dialogue` must NOT use `dy < TALK_RANGE`; \
         found inverted range guard (accepts far players, rejects nearby ones)"
    );
}

/// Source-guard: `advance_dialogue` dialogue-tree and node lookups use `==`, not `!=`.
/// Mutant 328:49 replaces `==` with `!=` in the tree lookup;
/// mutant 333:54 replaces `==` with `!=` in the current-node lookup.
/// KILLS: npc.rs:328:49 and npc.rs:333:54.
#[test]
fn advance_dialogue_node_lookups_use_equality_not_inequality() {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "advance_dialogue")
        .expect("pub fn advance_dialogue must exist in npc.rs");
    // Dialogue tree lookup.
    let tree_eq = ["t.id ==", " npc_row.dialogue_tree_id"].concat();
    assert!(
        body.contains(tree_eq.as_str()),
        "TEETH(npc.rs:328): `advance_dialogue` tree lookup must use `t.id == npc_row.dialogue_tree_id`; \
         mutant replaces == with != selecting the wrong tree for the NPC"
    );
    // Current node lookup.
    let node_eq = ["n.id ==", " conv.current_node_id"].concat();
    assert!(
        body.contains(node_eq.as_str()),
        "TEETH(npc.rs:333): `advance_dialogue` node lookup must use `n.id == conv.current_node_id`; \
         mutant replaces == with != selecting the wrong node (one that is NOT the current node)"
    );
}

// ===========================================================================
// T4 (11r-i): `apply_quest_trigger` must log a rate-limited, escaped
// `quest_def_missing` structured warn when a player's active `PlayerQuestRow`
// references a `quest_id` absent from the compiled-in quest defs (npc.rs's
// `let Some(def) = quest_defs.iter().find(..) else { continue; }` arm,
// currently ~npc.rs:157-160).
//
// RED at HEAD for T4-a..T4-f: none of this logging exists yet, so
// `quest_def_missing_arm()` below currently returns just `"continue;"`.
// T4-g is a non-regression pin and is GREEN at HEAD (and must stay green).
//
// Whitespace-squashed, comment-stripped, brace-matched scanning (same
// discipline as movement_tests.rs's ADR-0170 D4 rate-limiter teeth) so a
// rustfmt line split can never cause a false RED, and no needle can be
// satisfied by inert text (e.g. this test file's own strings, which is why
// every needle here is built via `.concat()` from parts rather than written
// as one long literal matching npc.rs verbatim).
// ===========================================================================

/// `npc.rs` with comments stripped and ALL whitespace squashed out.
fn squash_ws(s: &str) -> String {
    s.split_whitespace().collect()
}

/// Index just past the `)` that balances the `(` at byte offset `open_idx`
/// in `s` (`s.as_bytes()[open_idx]` must be `(`). Depth-counts parens only;
/// safe here because every squashed span this is used on is either plain
/// Rust expression syntax or a hand-built JSON log literal containing no
/// parens (the established convention in guards.rs / movement.rs).
fn matching_paren_end(s: &str, open_idx: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    if bytes.get(open_idx) != Some(&b'(') {
        return None;
    }
    let mut depth = 0i32;
    let mut i = open_idx;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Same as [`matching_paren_end`] but for `{` / `}`.
fn matching_brace_end(s: &str, open_idx: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    if bytes.get(open_idx) != Some(&b'{') {
        return None;
    }
    let mut depth = 0i32;
    let mut i = open_idx;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Isolate the INNER content (braces excluded) of the
/// `let Some(def) = quest_defs.iter().find(|d| d.id == row.quest_id) else { .. };`
/// arm inside `apply_quest_trigger` — the exact site T4 must edit. Squashed
/// (comment-stripped + whitespace-collapsed) so rustfmt reflow of the `let ..
/// else` line cannot desync this from the real source.
///
/// At HEAD this returns exactly `"continue;"`. After T4, it must return the
/// escape-binding statement + the rate-limit gate + `log::warn!(..)`, still
/// ending in `continue;` (T4-f — control flow is unchanged).
///
/// LATENT CONSTRAINT (auditor nit, not fixed here — out of proportion to
/// rewrite as a full lexer): `matching_brace_end` below counts `{`/`}` bytes
/// with NO string-literal lexer, so it cannot tell a brace that is part of
/// Rust syntax from one sitting inside a string literal. This function works
/// correctly ONLY because the shipped `log::warn!("{{\"evt\":..}}", ..)`
/// format string happens to be brace-BALANCED (every JSON `{`/`}` is escaped
/// as a matched `{{`/`}}` pair, and every `{escaped_quest_id}` capture is a
/// matched `{`/`}` pair). A hypothetical future edit that introduces an
/// unescaped, UNBALANCED brace inside some new string literal in this
/// function would desync this extraction silently (wrong span, not a panic)
/// rather than fail loudly. The assertion just below is a best-effort canary
/// for that class of edit: it is necessary-but-not-sufficient (a lone stray
/// `{` paired with an unrelated stray `}` elsewhere in the function would
/// still balance the COUNT while desyncing the SPAN), so it does not replace
/// the need for a human to keep the constraint in mind — it just fails loudly
/// on the common case instead of drifting silently.
fn quest_def_missing_arm() -> String {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "apply_quest_trigger")
        .expect("fn apply_quest_trigger must exist in npc.rs");
    let squashed = squash_ws(body);
    assert_eq!(
        squashed.matches('{').count(),
        squashed.matches('}').count(),
        "npc_tests T4: apply_quest_trigger's squashed body has an UNEQUAL count \
         of `{{` vs `}}` — the brace-matching extraction below has no \
         string-literal lexer and silently assumes the whole function's braces \
         are globally balanced (true today only because every JSON brace in the \
         `log::warn!` format string is escaped as a matched `{{`/`}}` pair). An \
         edit that breaks this global balance must fail LOUDLY here rather than \
         let `quest_def_missing_arm` silently mis-slice the arm. squashed body \
         was: {squashed:?}"
    );
    let lookup = ["quest_defs.iter().find(|d|d.id==row.quest_id)", "else{"].concat();
    let start = squashed.find(lookup.as_str()).unwrap_or_else(|| {
        panic!(
            "npc_tests T4: could not find the quest-def lookup `{lookup}` inside \
             apply_quest_trigger's squashed body — has the `let Some(def) = \
             quest_defs.iter().find(..) else {{ .. }}` shape changed? \
             squashed body was: {squashed:?}"
        )
    });
    let brace_open = start + lookup.len() - 1;
    let brace_close = matching_brace_end(&squashed, brace_open).unwrap_or_else(|| {
        panic!("npc_tests T4: unbalanced braces after the quest-def-missing `else {{`")
    });
    squashed[brace_open + 1..brace_close - 1].to_string()
}

/// Split `s` on top-level (paren-depth-0) commas only. Sufficient for
/// `.check(<clock-expr>, <window-expr>)` argument lists: the only nested
/// parenthesised sub-expression seen in practice is a clock call like
/// `crate::marshal::now_ms(ctx)`, which itself contains no comma.
fn split_top_level_commas(s: &str) -> Vec<&str> {
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut parts = Vec::new();
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts
}

/// Parse a `if let Some(suppressed) = <LIMITER>.check(<args>) { log::warn!(<args>) }`
/// gate as ONE contiguous (whitespace-squashed) expression. Returns
/// `(check_args, warn_args)` on a full match, `None` otherwise.
///
/// Deliberately does NOT pin the limiter's static name (T4's spec does not
/// prescribe one) — only that SOME identifier's `.check(` result is what the
/// `if let Some(suppressed) = ..` binds, and that `log::warn!(` opens
/// IMMEDIATELY inside that `if`'s body, with nothing else between `)` and
/// `{log::warn!(`. This is what makes `let _ = LIMITER.check(..);
/// log::warn!(..);` (limiter consulted, answer discarded) fail to match: that
/// cheat squashes to `let_=LIMITER.check(..);log::warn!(..);`, which contains
/// neither `ifletSome(suppressed)=` immediately before `.check(` nor
/// `){log::warn!(` immediately after it.
fn find_rate_limited_warn(squashed_arm: &str) -> Option<(String, String)> {
    let gate_open = ["ifletSome(suppressed)", "="].concat();
    let gate_start = squashed_arm.find(gate_open.as_str())?;
    let after_eq = &squashed_arm[gate_start + gate_open.len()..];

    let check_marker = ".check(";
    let check_rel = after_eq.find(check_marker)?;
    let limiter_ident = &after_eq[..check_rel];
    if limiter_ident.is_empty()
        || !limiter_ident
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':')
    {
        return None;
    }

    let check_open = check_rel + check_marker.len() - 1;
    let check_close = matching_paren_end(after_eq, check_open)?;
    let check_args = after_eq[check_open + 1..check_close - 1].to_string();

    // `check_close` is the index just PAST the matching `)` of `.check(..)`,
    // so back up one to re-include that `)` in the marker we match against.
    let tail = &after_eq[check_close - 1..];
    let warn_open_marker = "){log::warn!(";
    if !tail.starts_with(warn_open_marker) {
        return None;
    }
    let warn_open = check_close - 1 + warn_open_marker.len() - 1;
    let warn_close = matching_paren_end(after_eq, warn_open)?;
    let warn_args = after_eq[warn_open + 1..warn_close - 1].to_string();

    Some((check_args, warn_args))
}

/// T4-a: the quest-def-missing arm must name its event `quest_def_missing`.
///
/// KILLS: an impl that adds SOME log but under a different/no event name,
/// or a later edit that deletes the event name while leaving other T4 shape
/// (log::warn!, rate limiting) in place — this test still catches the
/// deleted/renamed event specifically.
#[test]
fn apply_quest_trigger_missing_def_logs_named_event() {
    let arm = quest_def_missing_arm();
    let event_name = ["quest_def", "_missing"].concat();
    assert!(
        arm.contains(event_name.as_str()),
        "TEETH (T4-a): apply_quest_trigger's quest-def-missing arm must contain \
         the event name `quest_def_missing`. RED at HEAD (arm is just \
         `continue;`). Kills: deleting the event, or renaming it to something \
         else while otherwise satisfying T4's other teeth. Arm was: {arm:?}"
    );
}

/// T4-b: the log macro must be `log::warn!`, never `log::info!` / `debug!` /
/// `trace!`.
///
/// KILLS: severity downgrade — an operator relying on WARN-level alerting for
/// content-authoring defects (a `PlayerQuestRow.quest_id` with no matching
/// `QuestDef`) would never see it at info/debug/trace level in production.
#[test]
fn apply_quest_trigger_missing_def_uses_warn_severity() {
    let arm = quest_def_missing_arm();
    let warn_macro = ["log::", "warn!("].concat();
    assert!(
        arm.contains(warn_macro.as_str()),
        "TEETH (T4-b): apply_quest_trigger's quest-def-missing arm must contain \
         `log::warn!(`. RED at HEAD. Arm was: {arm:?}"
    );
    for bad in ["info!(", "debug!(", "trace!("] {
        let downgraded = ["log::", bad].concat();
        assert!(
            !arm.contains(downgraded.as_str()),
            "TEETH (T4-b): apply_quest_trigger's quest-def-missing arm must NOT \
             use `log::{bad}` for the quest_def_missing event — found it. A \
             content-authoring defect (dangling quest_id) logged below WARN is \
             effectively invisible to production alerting. Arm was: {arm:?}"
        );
    }
}

/// T4-c: the `log::warn!` must be GATED by a `RateLimiter.check(..)` call, as
/// ONE contiguous expression, and the clock argument must be the injected
/// `now_ms(ctx)` (never a wall clock — ADR-0003).
///
/// KILLS: `let _ = LIMITER.check(..); log::warn!(..);` — the limiter is
/// consulted, its `Option<u32>` answer thrown away, and the warn fires on
/// EVERY tick for EVERY player with a dangling quest, unbounded. A
/// presence-only `arm.contains("LIMITER.check(")` needle is satisfied by that
/// exact cheat; only the contiguous `ifletSome(suppressed)=..check(..){
/// log::warn!(` shape rules it out.
#[test]
fn apply_quest_trigger_missing_def_warn_is_rate_limit_gated() {
    let arm = quest_def_missing_arm();
    let gate = find_rate_limited_warn(&arm);
    assert!(
        gate.is_some(),
        "TEETH (T4-c): apply_quest_trigger's quest-def-missing warn must be \
         gated as ONE contiguous expression: `if let Some(suppressed) = \
         <LIMITER>.check(<now>, <window_ms>) {{ log::warn!(..) }}`. RED at HEAD \
         (arm is just `continue;`). Kills: `let _ = LIMITER.check(..); \
         log::warn!(..);` (limiter consulted, answer discarded — unbounded \
         warn flood). Arm was: {arm:?}"
    );
    let (check_args, _warn_args) = gate.unwrap();
    assert!(
        check_args.contains("now_ms"),
        "TEETH (T4-c): the RateLimiter.check(..) call's clock argument must be \
         the tick's injected `now_ms(ctx)` (crate::marshal::now_ms), never a \
         wall clock (ADR-0003). check(..) args were: {check_args:?}"
    );
}

/// T4-i — WINDOW-OPERAND NAMED-CONSTANT TOOTH (reducer-security audit finding).
///
/// T4-c above only asserts `check_args.contains("now_ms")` — it never
/// inspects the SECOND argument to `.check(..)`. A cheat that writes
/// `.check(crate::marshal::now_ms(ctx), 0)` passes T4-a through T4-h: with
/// `window_ms == 0`, the `now.saturating_sub(l) >= window_ms` branch in
/// `movement.rs`'s `RateLimiter::check` is ALWAYS true (any two calls,
/// however close in time, are ≥ 0 ms apart), so the warn fires on EVERY
/// dangling `player_quest` row on EVERY `talk()` call, completely unbounded —
/// exactly the flood T4-c's own doc comment claims to kill.
///
/// This tooth pins the window operand to the bare NAMED constant
/// `QUEST_DEF_MISSING_WINDOW_MS` (never a numeric literal, and never some
/// other identifier), AND separately pins that constant's own declared value
/// at `60_000` — otherwise a mutant that keeps the operand correctly NAMED
/// but redefines the constant itself to `0` would satisfy the first half of
/// this test while still producing the exact unbounded flood the naming
/// check exists to prevent.
///
/// KILLS: `.check(crate::marshal::now_ms(ctx), 0)` (or any other bare numeric
/// literal / wrongly-named identifier in the window position), and
/// separately, `const QUEST_DEF_MISSING_WINDOW_MS: i64 = 0;` (constant
/// declared under the right name but defanged to zero).
#[test]
fn apply_quest_trigger_missing_def_window_operand_is_named_constant() {
    let arm = quest_def_missing_arm();
    let gate = find_rate_limited_warn(&arm).expect(
        "TEETH (T4-i): the rate-limit gate around log::warn! must exist (see \
         apply_quest_trigger_missing_def_warn_is_rate_limit_gated) before its \
         check(..) arguments can be split",
    );
    let (check_args, _warn_args) = gate;

    let parts = split_top_level_commas(&check_args);
    assert_eq!(
        parts.len(),
        2,
        "TEETH (T4-i): `.check(..)` must take exactly two top-level, \
         comma-separated arguments (clock, window_ms); got {} in check(..) \
         args {check_args:?}",
        parts.len()
    );
    assert_eq!(
        parts[1], "QUEST_DEF_MISSING_WINDOW_MS",
        "TEETH (T4-i, reducer-security audit kill): the SECOND argument to \
         `.check(..)` (the window operand) must be the bare identifier \
         `QUEST_DEF_MISSING_WINDOW_MS` — not a numeric literal such as `0` \
         (which makes `now.saturating_sub(l) >= window_ms` in movement.rs's \
         `RateLimiter::check` ALWAYS true, so the warn fires unbounded on \
         every dangling row on every talk() call — the exact flood T4-c's doc \
         comment claims to kill) and not some OTHER identifier. Got {:?} in \
         check(..) args {check_args:?}",
        parts[1]
    );

    // Second angle: pin the constant's own declared value at file scope, so a
    // mutant that keeps the operand correctly NAMED but redefines the
    // constant itself to 0 is still caught. Whitespace-tolerant (rustfmt may
    // reflow the `const .. = ..;` line) and underscore-in-literal tolerant
    // (`60_000` vs `60000`), matching the ENCOUNTER_ERR_WINDOW_MS precedent in
    // movement_tests.rs.
    let squashed_full = squash_ws(&strip_npc_comments(NPC_SOURCE));
    let const_prefix = ["constQUEST_DEF_MISSING_WINDOW", "_MS:i64="].concat();
    let const_variants = [
        [const_prefix.as_str(), "60_000;"].concat(),
        [const_prefix.as_str(), "60000;"].concat(),
    ];
    let const_ok = const_variants
        .iter()
        .any(|v| squashed_full.contains(v.as_str()));
    assert!(
        const_ok,
        "TEETH (T4-i, reducer-security audit kill): npc.rs must declare \
         `const QUEST_DEF_MISSING_WINDOW_MS: i64 = 60_000;` (the `60000` \
         spelling is also accepted) at file scope. Without this pin, a mutant \
         that flips the constant's VALUE to 0 (while leaving the operand's \
         NAME intact, satisfying the assertion above) is invisible to the \
         whole suite, yet produces the same unbounded-flood defect T4-c \
         exists to prevent."
    );
}

/// T4-d — ESCAPE-BINDING TOOTH (the red-team cheat).
///
/// A red-team-proven cheat passes every naive tooth above: compute an
/// escaped value into an UNUSED binding (not `let _ =`, so clippy stays
/// silent), then interpolate the RAW, un-escaped `row.quest_id` into the
/// `log::warn!` call anyway:
///
/// ```ignore
/// let _escaped = crate::guards::json_escape(&row.quest_id); // unused
/// if let Some(suppressed) = LIMITER.check(crate::marshal::now_ms(ctx), 60_000) {
///     log::warn!("{{\"evt\":\"quest_def_missing\",\"quest_id\":\"{}\",\"suppressed\":{}}}",
///                row.quest_id, suppressed); // RAW, unescaped
/// }
/// ```
///
/// This pins the escape call's output BINDING NAME (implementer: name it
/// exactly `escaped_quest_id`) and requires that exact identifier to be an
/// argument of the `log::warn!(..)` call, AND that `row.quest_id` is NOT.
///
/// KILLS: computing `json_escape(&row.quest_id)` into a binding nobody reads
/// while the warn interpolates the raw field — a `quest_id` containing a
/// double-quote or backslash then corrupts the hand-built JSON log line,
/// breaking downstream log parsing (exactly what `json_escape` exists to
/// prevent, per guards.rs's `log_reject` precedent).
///
/// CLOSED (auditor nit): the three assertions above only prove the escape
/// call's output BINDING NAME reaches `log::warn!`, not that the binding
/// still HOLDS the escaped VALUE there — a shadow-rebind cheat passes all
/// three: `let escaped_quest_id = json_escape(&row.quest_id); let
/// escaped_quest_id = row.quest_id.clone();` satisfies the "exact escape
/// statement present" check (the first line), and by the time `log::warn!`
/// reads `escaped_quest_id` it holds the raw, un-escaped value (the second
/// line shadowed it) — yet `warn_args.contains(ESCAPED_BINDING)` and
/// `!warn_args.contains("row.quest_id")` both still hold, because the warn
/// call only ever references the IDENTIFIER, never the literal text
/// `row.quest_id`. The additional assertion below closes this: it requires
/// `escaped_quest_id` to be `let`-bound EXACTLY ONCE in the arm, which the
/// shadow-rebind cheat violates (two bindings of the same name).
#[test]
fn apply_quest_trigger_missing_def_warn_uses_escaped_quest_id_binding() {
    const ESCAPED_BINDING: &str = "escaped_quest_id";
    let arm = quest_def_missing_arm();

    let escape_stmt = [
        "let",
        ESCAPED_BINDING,
        "=crate::guards::json_escape(&row.quest_id);",
    ]
    .concat();
    assert!(
        arm.contains(escape_stmt.as_str()),
        "TEETH (T4-d ESCAPE-BINDING, red-team cheat kill): apply_quest_trigger's \
         quest-def-missing arm must bind the escaped quest_id to the EXACT \
         identifier `{ESCAPED_BINDING}`, via the contiguous statement `let \
         {ESCAPED_BINDING} = crate::guards::json_escape(&row.quest_id);` — not \
         found. RED at HEAD (arm is just `continue;`). This exact binding name \
         is required so this test can prove the SAME value that was escaped is \
         the one that reaches `log::warn!` (see the next assertion) — a \
         differently-named, unread escape binding is the red-team's proven \
         cheat: `let _escaped = json_escape(&row.quest_id);` (unused, not \
         `let _ =`, so clippy stays silent) while `log::warn!` interpolates \
         raw `row.quest_id`. Arm was: {arm:?}"
    );

    let gate = find_rate_limited_warn(&arm).expect(
        "TEETH (T4-d): the rate-limit gate around log::warn! must exist \
         (see apply_quest_trigger_missing_def_warn_is_rate_limit_gated) before \
         its argument list can be checked for escape-binding use",
    );
    let (_check_args, warn_args) = gate;

    assert!(
        warn_args.contains(ESCAPED_BINDING),
        "TEETH (T4-d ESCAPE-BINDING): the log::warn!(..) call must interpolate \
         the identifier `{ESCAPED_BINDING}` (the json_escape output) — either as \
         a positional argument or an inline `{{{ESCAPED_BINDING}}}` capture. \
         Got log::warn!(..) args = {warn_args:?}. This is the red-team's exact \
         cheat: an escaped value computed and never read."
    );
    assert!(
        !warn_args.contains("row.quest_id"),
        "TEETH (T4-d ESCAPE-BINDING): the log::warn!(..) call must NOT pass \
         `row.quest_id` directly — the RAW, un-escaped field must never reach \
         the hand-built JSON format string. Got log::warn!(..) args = \
         {warn_args:?}. A quest_id containing a double-quote or backslash would \
         corrupt the JSON log line otherwise."
    );

    let let_binding_marker = ["let", ESCAPED_BINDING, "="].concat();
    let n_let_bindings = arm.matches(let_binding_marker.as_str()).count();
    assert_eq!(
        n_let_bindings, 1,
        "TEETH (T4-d ESCAPE-BINDING, shadow-rebind cheat kill): the identifier \
         `{ESCAPED_BINDING}` must be `let`-bound exactly ONCE in the arm. Found \
         {n_let_bindings}. Kills the shadow-rebind cheat that defeats the two \
         assertions above by NAME alone: `let {ESCAPED_BINDING} = \
         crate::guards::json_escape(&row.quest_id); let {ESCAPED_BINDING} = \
         row.quest_id.clone();` — the first statement satisfies the 'exact \
         escape statement present' assertion, the SECOND rebinds the same name \
         to the RAW value before `log::warn!` reads it, so the warn \
         interpolates the identifier `{ESCAPED_BINDING}` (satisfying that \
         assertion too) while its VALUE at the point of use is the un-escaped \
         raw quest_id — the escape call becomes dead code that clippy's \
         `unused_variables` does not flag (the binding IS read, just not the \
         one that was escaped). Arm was: {arm:?}"
    );
}

/// T4-e: exactly ONE `log::warn!` site in the quest-def-missing arm.
///
/// KILLS: shotgunning — e.g. an extra debug-oriented `log::warn!` left in
/// alongside the real one, doubling log volume and confusing the single
/// `quest_def_missing` event's cardinality assumptions.
#[test]
fn apply_quest_trigger_missing_def_has_exactly_one_warn_site() {
    let arm = quest_def_missing_arm();
    let warn_marker = ["log::", "warn!("].concat();
    let n = arm.matches(warn_marker.as_str()).count();
    assert_eq!(
        n, 1,
        "TEETH (T4-e): apply_quest_trigger's quest-def-missing arm must contain \
         exactly ONE `log::warn!(` site; found {n}. RED at HEAD (found 0). \
         Arm was: {arm:?}"
    );
}

/// T4-h — WHOLE-ARM RAW-LEAK TOOTH (red-team-proven second cheat, distinct
/// from T4-d).
///
/// T4-d only inspects the SANCTIONED `log::warn!(..)` call's OWN argument
/// list. It is blind to a SECOND, unrelated statement placed anywhere else in
/// the arm that leaks the raw, un-escaped `row.quest_id` — proven by
/// executing `quest_def_missing_arm()` / `find_rate_limited_warn` against a
/// synthetic cheat arm containing the correctly-escaped, correctly-gated warn
/// PLUS an ungated second line:
///
/// ```ignore
/// let escaped_quest_id = crate::guards::json_escape(&row.quest_id);
/// if let Some(suppressed) = QUEST_DEF_MISSING_LIMITER
///     .check(crate::marshal::now_ms(ctx), QUEST_DEF_MISSING_WINDOW_MS)
/// {
///     log::warn!("{{\"evt\":\"quest_def_missing\",\"quest_id\":\"{}\",\"suppressed\":{}}}",
///                escaped_quest_id, suppressed);
/// }
/// log::error!("debug: raw quest_id was {}", row.quest_id); // UNGATED LEAK
/// continue;
/// ```
///
/// This passes T4-a through T4-g (T4-e's "exactly one `log::warn!`" count is
/// untouched — the leak uses `log::error!`) while the raw, unescaped
/// `quest_id` still reaches the log, defeating the ADR-0170 D5 property
/// `json_escape` exists to enforce.
///
/// KILLS: any second, ungated (or even gated) statement anywhere in the arm
/// that references `row.quest_id` outside the one sanctioned
/// `json_escape(&row.quest_id)` call, and — via a second, independent angle —
/// any second `log::`-prefixed macro invocation of ANY severity in the arm.
/// Either assertion alone kills the cheat above; both are cheap, so both are
/// kept.
#[test]
fn apply_quest_trigger_missing_def_raw_quest_id_appears_nowhere_else() {
    let arm = quest_def_missing_arm();

    let n_quest_id = arm.matches("row.quest_id").count();
    assert_eq!(
        n_quest_id, 1,
        "TEETH (T4-h, red-team second-statement leak kill): `row.quest_id` \
         must appear EXACTLY ONCE anywhere in the whole quest-def-missing arm \
         — the single sanctioned use inside \
         `json_escape(&row.quest_id)`. Found {n_quest_id}. Kills: emitting the \
         correctly-escaped, correctly-gated `log::warn!` AND ALSO a second, \
         ungated statement that leaks the raw value, e.g. \
         `log::error!(\"debug: raw quest_id was {{}}\", row.quest_id);` placed \
         ANYWHERE in the arm — T4-d only inspects the gated warn!'s own \
         argument list and is blind to this. Arm was: {arm:?}"
    );

    let log_macro_marker = ["log", "::"].concat();
    let n_log_sites = arm.matches(log_macro_marker.as_str()).count();
    assert_eq!(
        n_log_sites, 1,
        "TEETH (T4-h, red-team second-statement leak kill, second angle): the \
         quest-def-missing arm must contain exactly ONE `log::`-prefixed macro \
         invocation IN TOTAL, of any severity — not merely one `log::warn!` \
         (T4-e already pins that narrower count). Found {n_log_sites}. Kills \
         the same cheat above via a second, independent angle: an extra \
         `log::error!(..)` / `log::info!(..)` / `log::debug!(..)` / \
         `log::trace!(..)` anywhere in the arm, gated or not, escaped or not. \
         Arm was: {arm:?}"
    );
}

/// T4-f: `continue` must still be the ONLY early-exit statement in the
/// quest-def-missing arm, and it must still be the LAST statement — control
/// flow is unchanged by T4.
///
/// KILLS (three distinct mutants, all closed here):
///  1. dropping `continue` entirely (falling through to code that expects
///     `def` to be `Some`, which would then panic/misbehave on the very row
///     this arm exists to skip) — caught by the `ends_with` check.
///  2. inserting a SECOND, EARLIER `continue;` before the logging/warn code
///     (so the new logging never runs, while a stray trailing `continue;`
///     remains as dead/unreachable text, still satisfying `ends_with`) —
///     caught by pinning the arm contains EXACTLY ONE `continue;` in total.
///  3. inserting an early `return;` before the logging/warn code (exits the
///     whole `apply_quest_trigger` function immediately, skipping the
///     REMAINING `active_rows` for every other dangling quest on this
///     player, not just this row) — the arm's literal text can still end
///     with `continue;` further down as unreachable dead code, which is
///     exactly why a bare `ends_with` check alone does not catch it; caught
///     here by asserting the arm contains no `return` at all.
#[test]
fn apply_quest_trigger_missing_def_arm_still_ends_in_continue() {
    let arm = quest_def_missing_arm();
    assert!(
        arm.trim_end().ends_with("continue;"),
        "TEETH (T4-f): apply_quest_trigger's quest-def-missing arm must still \
         end with `continue;` as its LAST statement (control flow unchanged by \
         T4 — only logging is added before it). Arm was: {arm:?}"
    );
    let n_continue = arm.matches("continue;").count();
    assert_eq!(
        n_continue, 1,
        "TEETH (T4-f STRENGTHENED): the quest-def-missing arm must contain \
         EXACTLY ONE `continue;` in total; found {n_continue}. Kills an impl \
         that inserts a SECOND, EARLIER `continue;` right after building the \
         escaped id but BEFORE the rate-limit gate / `log::warn!` — the new \
         logging code would then never run for ANY row (an unconditional \
         early exit from the loop iteration), while the original trailing \
         `continue;` remains as dead/unreachable text and still satisfies the \
         bare `ends_with` check above. Arm was: {arm:?}"
    );
    assert!(
        !arm.contains("return"),
        "TEETH (T4-f STRENGTHENED): the quest-def-missing arm must not contain \
         any `return` — a `return;` inserted before the logging/warn code \
         would exit the WHOLE `apply_quest_trigger` function immediately \
         (skipping every remaining row in `active_rows`, not just this one), \
         while the arm's textual content still literally ENDS with \
         `continue;` further down as unreachable dead code — satisfying the \
         naive `ends_with(\"continue;\")` check above while completely \
         defeating its intent (this doc comment's original claim to kill \
         'moves the continue earlier' covers this case too: an early return \
         has the same effect as moving the effective exit point earlier). \
         Arm was: {arm:?}"
    );
}

/// T4-g — NON-REGRESSION PIN (not part of T4's new behavior; must stay GREEN).
///
/// Two out-of-scope graders brace-slice `apply_quest_trigger`'s full body and
/// assume `grant_currency` / `grant_item` survive inside it:
/// `evals/economy-sinks-sources.eval.mjs` and
/// `server-module/src/economy_tests.rs:696`
/// (`apply_quest_trigger_calls_grant_currency`). T4 only touches the
/// quest-def-missing arm; this pin makes that non-interference assumption
/// explicit HERE so a T4 diff that (incorrectly) touches the QuestComplete
/// reward-granting arm is caught locally, not just by those other graders.
#[test]
fn apply_quest_trigger_still_grants_currency_and_item_on_quest_complete() {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "apply_quest_trigger")
        .expect("fn apply_quest_trigger must exist in npc.rs");
    assert!(
        body.contains("grant_currency("),
        "NON-REGRESSION (T4-g): apply_quest_trigger must still call \
         grant_currency(..) on QuestComplete — evals/economy-sinks-sources.eval.mjs \
         and server-module/src/economy_tests.rs:696 brace-slice this exact \
         function body and depend on this call surviving. T4 must only add \
         logging to the quest-def-missing arm, never touch reward granting."
    );
    assert!(
        body.contains("grant_item("),
        "NON-REGRESSION (T4-g): apply_quest_trigger must still call \
         grant_item(..) on QuestComplete reward items — see \
         economy-sinks-sources.eval.mjs / economy_tests.rs:696, which brace-slice \
         this body and depend on this call surviving."
    );
}

// ===========================================================================
// 12r-d (E3) — the SECOND hand-built JSON log line in `apply_quest_trigger`
//
// T4 (above) escaped the CONTENT-authored `quest_id` at npc.rs:184-190. The
// sibling line five statements earlier — `quest_defs_load_error` at npc.rs:164 —
// interpolates a raw `{e}` and was never covered: its `e` is
// `cached_quest_defs()`'s error, i.e. a RON PARSE ERROR, which is the single
// most likely string in this crate to contain a double quote (a parser reporting
// an unexpected token quotes it). ADR-0170 D5's rule applies to it identically.
//
// EARS criterion covered:
//
//   E3  `apply_quest_trigger`'s `quest_defs_load_error` line SHALL interpolate a
//       `crate::guards::json_escape`d binding, never the raw `Err` text.
//
// RED STATE: ASSERTION-RED at HEAD — npc.rs:164 reads
// `\"reason\":\"{e}\"` and `apply_quest_trigger` makes exactly ONE
// `json_escape(` call (T4's, for `quest_id`), not two.
//
// SHAPE: this file's native idiom — a CONTIGUOUS, whitespace-squashed,
// comment-stripped mega-needle (the T4-c / T4-i discipline), which is strictly
// TIGHTER than a split "raw absent + capture present" pair: it pins the escaped
// capture into the exact slot of the exact format string, so an escaped value
// interpolated into a DIFFERENT line cannot satisfy it. Needles are assembled
// from parts and the two structural characters are spelled as NUMBERS, never as
// CHARACTER literals (guards_tests G-5a; this file sorts before `npc.rs` in the
// evals' concatenation order, so a contiguous copy here would poison them).
// ===========================================================================

/// The ASCII double quote, spelled as a NUMBER.
///
/// This file must contain no bare delimiter CHARACTER literal: the repo's
/// source scanners have no char-literal lexer, and a quote between apostrophes
/// inverts string/code polarity for the rest of the file.
const D12R_DQUOTE: u8 = 0x22;

/// The two-character sequence a Rust source spells to put a double quote INSIDE
/// a string literal: backslash then quote.
fn d12r_escaped_quote() -> String {
    let mut out = String::new();
    out.push(char::from(0x5Cu8));
    out.push(char::from(D12R_DQUOTE));
    out
}

/// True when the quote byte at `idx` DELIMITS a string literal rather than being
/// an escaped `\"` inside one: a delimiter is preceded by an EVEN number of
/// consecutive backslashes.
///
/// Inlined here (and in `content_tests.rs` / `battle_tests.rs` / `pvp_tests.rs`)
/// because every `*_tests.rs` file is a `#[cfg(test)]` submodule of its own
/// production file and none can reach another's bare `fn` items; there is no
/// shared test-utility crate. Same precedent `content_cache_tests.rs:361-368`
/// records for its own copies of the strippers.
fn d12r_quote_delimits(bytes: &[u8], idx: usize) -> bool {
    let mut n = 0usize;
    let mut i = idx;
    while i > 0 && bytes[i - 1] == b'\\' {
        n += 1;
        i -= 1;
    }
    n.is_multiple_of(2)
}

/// The interior (delimiters excluded) of the double-quoted string literal that
/// CONTAINS byte offset `at`.
fn d12r_format_string_at(src: &str, at: usize) -> Option<&str> {
    let bytes = src.as_bytes();
    let mut i = at;
    let open = loop {
        if bytes[i] == D12R_DQUOTE && d12r_quote_delimits(bytes, i) {
            break i;
        }
        if i == 0 {
            return None;
        }
        i -= 1;
    };
    let mut j = at;
    while j < bytes.len() {
        if bytes[j] == D12R_DQUOTE && d12r_quote_delimits(bytes, j) {
            return Some(&src[open + 1..j]);
        }
        j += 1;
    }
    None
}

/// Byte range of the `log::<level>!( .. )` invocation that CONTAINS `at`.
///
/// Walks parens from the macro's `(`, JUMPING OVER string literals so a paren
/// inside a message cannot unbalance the walk. `end` is just past the `)`.
fn d12r_log_call_range(src: &str, at: usize) -> Option<(usize, usize)> {
    let marker = ["log", "::"].concat();
    let start = src[..at].rfind(marker.as_str())?;
    let bytes = src.as_bytes();
    let open = start + src[start..].find('(')?;
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        if bytes[i] == D12R_DQUOTE && d12r_quote_delimits(bytes, i) {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == D12R_DQUOTE && d12r_quote_delimits(bytes, i) {
                    break;
                }
                i += 1;
            }
        } else if bytes[i] == b'(' {
            depth += 1;
        } else if bytes[i] == b')' {
            depth -= 1;
            if depth == 0 {
                return Some((start, i + 1));
            }
        }
        i += 1;
    }
    None
}

/// **12r-d E3** — `quest_defs_load_error` interpolates the escaped binding.
///
/// ASSERTION-RED at HEAD on every layer.
///
/// H2 — THE SITE IS LOCATED, NOT COUNTED. An earlier draft counted the good and
/// bad needles as substrings of the whole squashed function body. The red team
/// broke it: a dead string constant holding the exact good-needle text, plus a
/// renamed raw error binding, satisfies "good needle present" and "bad needle
/// absent" with the live log line untouched. This version does what its
/// `content_tests.rs` / `battle_tests.rs` siblings do — locate the event name
/// with `match_indices`, assert its occurrence count EXACTLY (a decoy string is
/// a second occurrence and fails there), then evaluate every needle against
/// THAT site's own format string and its own brace-matched `log::` macro call.
///
/// LAYER BY LAYER, and what each kills:
///   * **Exactly ONE occurrence of the event name in the function.** Kills the
///     dead-string decoy above, a duplicated log site, and a renamed event.
///   * **The RAW `{e}` is absent from the whole MACRO CALL** — not just from the
///     format string, so a positional `, e` argument is caught too. Kills the
///     belt-and-braces shell that adds an escaped line and keeps the raw one.
///   * **The GOOD contiguous tail is present in THAT format string.** Requiring
///     `quest_defs_load_error","reason":"{escaped}"` as one contiguous sequence
///     pins the escaped capture into the reason slot of THIS line; escaping into
///     an unrelated line cannot satisfy it.
///   * **No `{e}` interpolation survives ANYWHERE in the function.** Closes the
///     T4-h class — a second statement elsewhere in the body that leaks the raw
///     `Err`. HEAD has exactly one, so the target is zero and the arithmetic is
///     exact.
///   * **`json_escape(` is called at least TWICE.** The arithmetic: T4's
///     `quest_id` escape (npc.rs:184, must SURVIVE) plus this slice's `reason`
///     escape. A fix that merely MOVES T4's call cannot pass, and a later slice
///     deleting T4's escape trips this test as well as T4's own.
///   * **`escaped` is bound only by `json_escape(&e)`.** Kills the shadow-rebind
///     (T4-d, this file) and — H3 — the placeholder argument
///     `json_escape(&"…")`, which otherwise satisfies every other layer.
#[test]
fn apply_quest_trigger_defs_load_error_uses_an_escaped_binding() {
    const ESCAPED_BINDING: &str = "escaped";

    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, "apply_quest_trigger")
        .expect("fn apply_quest_trigger must exist in npc.rs");

    let bq = d12r_escaped_quote();
    let evt = ["quest_defs_load", "_error"].concat();
    let tail = |slot: &str| {
        [
            evt.as_str(),
            bq.as_str(),
            ",",
            bq.as_str(),
            "reason",
            bq.as_str(),
            ":",
            bq.as_str(),
            slot,
            bq.as_str(),
        ]
        .concat()
    };
    let good = tail(&["{", ESCAPED_BINDING, "}"].concat());
    let raw = ["{", "e}"].concat();

    // --- Layer 1: locate the site; EXACTLY one occurrence --------------------
    let hits: Vec<usize> = body.match_indices(evt.as_str()).map(|(i, _)| i).collect();
    assert_eq!(
        hits.len(),
        1,
        "TEETH (12r-d E3, H2 decoy kill): the event name {evt:?} occurs {} time(s) in \
         `apply_quest_trigger`; it must occur EXACTLY once — in the one \
         `quest_defs_load_error` log line. TWO is the red team's construction: a dead \
         string constant holding the sanctioned line's text satisfies any whole-body \
         substring check while the LIVE log still interpolates the raw `Err`. Zero \
         means the event was renamed or the line deleted, which would make every \
         assertion below vacuous.",
        hits.len()
    );
    let at = hits[0];

    let fmt = d12r_format_string_at(body, at).unwrap_or_else(|| {
        panic!(
            "12r-d E3: the event name {evt:?} in `apply_quest_trigger` is not inside a \
             string literal — this scan locates the log site by its format string, so \
             the line must have been restructured. Re-derive DELIBERATELY."
        )
    });
    let (cs, ce) = d12r_log_call_range(body, at).unwrap_or_else(|| {
        panic!(
            "12r-d E3: could not find the enclosing `log::<level>!( .. )` invocation for \
             {evt:?} — the scan needs it to prove the raw `Err` is gone from the WHOLE \
             call, not just from the format string"
        )
    });
    let call_sq = squash_ws(&body[cs..ce]);

    // --- Layer 2: the raw value is gone from the whole macro call ------------
    assert!(
        !call_sq.contains(raw.as_str()),
        "TEETH (12r-d E3, ADR-0170 D5): the `quest_defs_load_error` log call still \
         carries the RAW `Err` ({raw:?}). That `e` is `cached_quest_defs()`'s error — a \
         RON PARSE error, the shape most likely in this whole crate to contain a double \
         quote, because a parser reporting an unexpected token quotes it. One such \
         character makes the emitted line unparseable and the log ingest drops it, so \
         the ONE diagnostic that says why every quest in the game just stopped \
         advancing is the one that disappears. The check spans the whole macro CALL, so \
         a positional `, e` argument is caught too. Squashed call was: {call_sq:?}"
    );

    // --- Layer 3: the escaped capture is in THIS format string, in the slot --
    assert!(
        fmt.contains(good.as_str()),
        "TEETH (12r-d E3, ADR-0170 D5): the `quest_defs_load_error` format string must \
         carry the contiguous sequence {good:?} — the escaped binding interpolated into \
         the reason slot of THIS line. Not found (RED at HEAD). The needle is CONTIGUOUS \
         and evaluated against this site's OWN format string, so escaping into an \
         unrelated line cannot satisfy it. Write \
         `let {ESCAPED_BINDING} = crate::guards::json_escape(&e);` immediately before \
         the log and interpolate `{{{ESCAPED_BINDING}}}` — the npc.rs:184-190 shape T4 \
         already established in this same function. Format string was: {fmt:?}"
    );

    // --- Layer 4: whole-function raw-leak sweep (the T4-h class) -------------
    let sq = squash_ws(body);
    let n_raw = sq.matches(raw.as_str()).count();
    assert_eq!(
        n_raw, 0,
        "TEETH (12r-d E3, whole-function raw-leak sweep): `apply_quest_trigger` \
         contains {n_raw} raw `{{e}}` interpolation(s) and must contain ZERO. The layers \
         above inspect only the ONE sanctioned call; this closes the T4-h class — a \
         second statement anywhere else in the body that interpolates the un-escaped \
         `Err` (a debug line, a duplicated log) while the sanctioned line is perfectly \
         correct. HEAD has exactly 1, at npc.rs:164, so the target is 0 and the \
         arithmetic is exact."
    );

    // --- Layer 5: escape-call arithmetic ------------------------------------
    let escape_call = ["json", "_escape("].concat();
    let n_escape = sq.matches(escape_call.as_str()).count();
    assert!(
        n_escape >= 2,
        "TEETH (12r-d E3): `apply_quest_trigger` must make at least TWO `json_escape(` \
         calls but makes {n_escape}. THE ARITHMETIC: T4's `quest_id` escape at \
         npc.rs:184 (which must SURVIVE this slice) plus this slice's `reason` escape. \
         Asserting the PAIR means a fix that merely MOVES T4's existing call instead of \
         adding one cannot pass, and a later slice that deletes T4's escape trips this \
         test as well as T4's own."
    );

    // --- Layer 6: binding provenance, ARGUMENT included (H3) ----------------
    // Both the reference and the `as_str()` spelling are accepted (equally
    // correct, equally specific); a placeholder literal matches neither. The
    // closing paren is part of each spelling so `&e)` cannot match `&entity_id)`.
    let escape_args = ["&e)", "e.as_str())"];
    let any_binding = ["let", ESCAPED_BINDING, "="].concat();
    let n_all = sq.matches(any_binding.as_str()).count();
    let mut n_esc = 0usize;
    for arg in escape_args {
        let qualified = [
            "let",
            ESCAPED_BINDING,
            "=crate::guards::json",
            "_escape(",
            arg,
        ]
        .concat();
        let bare = ["let", ESCAPED_BINDING, "=json", "_escape(", arg].concat();
        n_esc += sq.matches(qualified.as_str()).count() + sq.matches(bare.as_str()).count();
    }

    assert!(
        n_esc >= 1,
        "TEETH (12r-d E3): the escaped reason must be bound to the EXACT identifier \
         `{ESCAPED_BINDING}` via \
         `let {ESCAPED_BINDING} = crate::guards::json_escape(&e);` (the bare \
         `json_escape(&e)` and the `e.as_str()` spellings are accepted) — found none. \
         The exact NAME ties the value that was escaped to the identifier the format \
         string interpolates; a differently-named, unread escape binding is the \
         red-team's proven cheat (T4-d, this file). The exact ARGUMENT (H3) kills \
         `let {ESCAPED_BINDING} = json_escape(&\"placeholder\");`, which satisfies every \
         other layer while logging a constant instead of the parse error."
    );
    assert_eq!(
        n_all, n_esc,
        "TEETH (12r-d E3, shadow-rebind + placeholder cheat kill): `{ESCAPED_BINDING}` \
         is `let`-bound {n_all} time(s) but only {n_esc} of those bindings come from \
         `json_escape` applied to the `Err` itself. KILLS \
         `let {ESCAPED_BINDING} = crate::guards::json_escape(&e); \
         let {ESCAPED_BINDING} = e.clone();` — the first statement satisfies the \
         provenance check, the second rebinds the same name to the RAW value before the \
         log reads it, and the format string still interpolates the identifier. The \
         compiler is silent: the binding IS read, just not the one that was escaped. \
         Same cheat, same reasoning, as T4-d at npc_tests.rs:1205-1222."
    );
}

// ===========================================================================
// m22-s3b (ADR-0228) — THE DELEGATED NPC-STATE ERASE.
//
// EARS criterion PRV1-6b: the cascade deletes every ERASE-policy row owned by
// the deleting identity. THREE of those tables live in this module —
// `player_dialogue_state`, `player_quest` and `player_conversation` — and the
// manifest classifies all three ERASE independently, so one helper must sweep
// all three or the ones it misses simply survive the deletion.
//
// `player_conversation` is single-player NPC DIALOGUE PROGRESS, not chat: spec
// §3 records that correction explicitly, because a design that reasons about it
// as messaging is reasoning about a feature this codebase does not have. It is
// erased for the same reason as the other two, not for a chat-privacy reason.
//
// SCAN HYGIENE: every needle is assembled from fragments (house rule — a dozen
// evals concatenate every `.rs` under server-module/src, `_tests.rs` files
// included), no bare double-quote appears inside any comment here, and this
// section spells no block-comment delimiter.
// ===========================================================================

/// Blank the CONTENT of every double-quoted string literal, preserving byte
/// offsets, so a dead `let _decoy = "<needle>";` cannot satisfy a positive
/// clause below.
///
/// Local and slice-prefixed: every `*_tests.rs` file in this crate is a
/// `#[cfg(test)]` child of its own production file and none can reach another's
/// bare `fn` items (the precedent `content_cache_tests.rs` records for its own
/// stripper copies). It reuses this file's existing `D12R_DQUOTE` byte constant
/// and `d12r_quote_delimits` escape-awareness rather than re-deriving them, so
/// there is one notion of what a string delimiter is in this file.
fn m22s3b_blank_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = bytes.to_vec();
    let mut in_string = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == D12R_DQUOTE && d12r_quote_delimits(bytes, i) {
            out[i] = b' ';
            in_string = !in_string;
        } else if in_string {
            out[i] = b' ';
        }
        i += 1;
    }
    String::from_utf8(out).expect("string-blanked source must be valid UTF-8")
}

/// **PRV1-6b (scan)** — `erase_npc_state` sweeps ALL THREE owner-keyed NPC
/// tables, through their owner columns, and actually deletes.
///
/// ONE HELPER, THREE TABLES, and the count is the point: the manifest classifies
/// `player_dialogue_state`, `player_quest` and `player_conversation`
/// independently, so a helper that sweeps two of them leaves the third's rows —
/// a deleted player's dialogue flags, quest progress or conversation position —
/// owned by an identity that no longer has an account, with nothing anywhere
/// else that will ever remove them. `rekey_npc_state` is the direct precedent
/// for the three-table shape.
///
/// Kills: any one of the three tables omitted; a sweep keyed on something other
///        than the `owner` parameter (which either deletes nothing or, if
///        unfiltered, deletes every player's NPC progress — the catastrophic
///        direction); a helper that collects ids and never deletes.
#[test]
fn m22s3b_erase_npc_state_shape() {
    let stripped = m22s3b_blank_strings(&strip_npc_comments(NPC_SOURCE));
    let name = ["erase_npc", "_state"].concat();
    let body = extract_npc_fn_body(&stripped, name.as_str()).unwrap_or_else(|| {
        panic!(
            "m22-s3b PRV1-6b FAIL (extraction): npc.rs declares no `fn {name}(`. The cascade \
             delegates the `player_dialogue_state`, `player_quest` and \
             `player_conversation` ERASE to this module because G5 MODULE_WRITE_ISOLATION \
             closes accounts.rs at its four owned tables. Without this helper all three \
             tables survive the deletion. Fail LOUD rather than pass vacuously."
        )
    });
    // `extract_npc_fn_body` returns `Option<&str>` (measured in r2 — the
    // authoring pass could not tell statically and used a defensive `&body`,
    // which clippy's `needless_borrow` correctly rejects under -D warnings).
    let squashed = squash_ws(body);
    assert!(
        !squashed.is_empty(),
        "m22-s3b PRV1-6b FAIL (non-vacuity): the `{name}` body is empty, so every clause \
         below would be asserting properties of nothing."
    );

    for (needle, what) in [
        (
            ["player_dialogue", "_state()"].concat(),
            "the dialogue flags and completed-quest set",
        ),
        (
            ["player", "_quest()"].concat(),
            "per-quest progress rows — note there are MANY per owner, so this one is a \
             filtered sweep rather than a point delete",
        ),
        (
            ["player_conver", "sation()"].concat(),
            "the transient conversation position. Spec §3 records what this table is NOT: \
             it is single-player NPC dialogue progress, never chat — no messaging system \
             exists anywhere in this codebase",
        ),
    ] {
        assert!(
            squashed.contains(needle.as_str()),
            "m22-s3b PRV1-6b FAIL (missing table): `{name}` must sweep `{needle}` ({what}). \
             The manifest classifies all three NPC tables ERASE INDEPENDENTLY, so a helper \
             that handles two of them leaves the third's rows owned by an identity with no \
             account and nothing anywhere else that will ever remove them. Body was: \
             {squashed:?}"
        );
    }

    let owner_col = ["owner", "_identity()"].concat();
    let n_owner = squashed.matches(owner_col.as_str()).count();
    assert!(
        n_owner >= 3,
        "m22-s3b PRV1-6b FAIL (owner-scoped): `{name}` reaches `{owner_col}` {n_owner} \
         time(s); all three tables must be swept through their owner column (at least 3). A \
         sweep that does not go through the owner column is either keyed on the wrong thing \
         or UNFILTERED — and an unfiltered sweep here deletes every player's dialogue flags, \
         quest progress and conversation state in the database, which is the catastrophic \
         direction and reads identically to the correct body under a presence-only check. \
         Body was: {squashed:?}"
    );

    // --- THE OWNER PARAMETER IS ACTUALLY PASSED (corrected in r2) -----------
    //
    // The clause this replaces asserted `squashed.contains("owner")` and was
    // VACUOUS: `owner_identity()` contains the substring `owner`, so the clause
    // above already guaranteed it and this one could never fail independently.
    // The property actually wanted is that the owner column is keyed on the
    // PARAMETER — `filter(owner)` for the multi-row table, `delete(owner)` for
    // the two PK-keyed ones — so the needle is the argument list, which
    // `owner_identity()` does not contain.
    let owner_arg = ["(", "owner)"].concat();
    let n_owner_arg = squashed.matches(owner_arg.as_str()).count();
    assert!(
        n_owner_arg >= 3,
        "m22-s3b PRV1-6b FAIL (owner-keyed): `{name}` passes the `owner` PARAMETER as an \
         argument {n_owner_arg} time(s) (`{owner_arg}`); all three tables must be keyed on it \
         (at least 3). Reaching the owner COLUMN is not the same as keying on the owner \
         VALUE: `ctx.db.player_quest().owner_identity().filter(some_other_identity)` reaches \
         the column and sweeps the wrong player, and an unkeyed iteration reaches it and \
         sweeps everybody. This clause replaces one that asserted the body contains `owner` \
         at all — which the `owner_identity()` count above already guaranteed, so it could \
         never fail on its own. Body was: {squashed:?}"
    );

    let iter_call = [".it", "er()"].concat();
    let n_iter = squashed.matches(iter_call.as_str()).count();
    assert_eq!(
        n_iter, 0,
        "m22-s3b PRV1-6b FAIL (no full-table scan): `{name}` calls `{iter_call}` {n_iter} \
         time(s) and must call it ZERO times. All three NPC tables are reachable by KEY for a \
         single owner — two are keyed by `owner_identity` directly and the third carries an \
         owner index — so a full-table iteration is never needed here. It is, however, the \
         shape that makes the catastrophic mistake possible: an iteration whose predicate is \
         wrong, absent, or refactored away deletes every player's dialogue flags, quest \
         progress and conversation state in the database, and reads identically to the \
         correct body under every presence clause above. Added in r2 alongside the same ban \
         in the four sibling erase helpers."
    );

    let deletes = squashed.matches(&["del", "ete("].concat()).count();
    assert_eq!(
        deletes, 3,
        "m22-s3b PRV1-6b FAIL (delete census): `{name}` performs {deletes} row delete(s); \
         EXACTLY THREE are sanctioned, one per ERASE table. FEWER means a table is read and \
         not erased — the manifest classifies all three INDEPENDENTLY, so the missing one's \
         rows simply survive the deletion owned by an identity with no account. MORE means a \
         fourth row removal in a helper whose remit is those three tables, which would also \
         mean this body reaches a table no owning-module shape pin covers. Tightened from a \
         `>= 3` floor in r2: a floor accepts an unbounded number of extra deletes. Body was: \
         {squashed:?}"
    );
}
