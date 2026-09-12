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

// ===========================================================================
// rb-41 — R-rb-25-X9 (ADR-0222 known-limit 2, closed by the ADR-0224 native
// host migration): the REKEY exists-predicate for the NPC pair, exercised
// against REAL rows instead of against its own source text.
//
// `npc::has_quest_or_dialogue_state` is the only two-armed predicate of the
// six: quest progress OR dialogue state. One test per arm, each registering
// ONLY its own table so the other arm reads an empty table — that is what makes
// each test sensitive to ITS arm alone, and what makes hollowing either arm
// (still reading the table, returning a value decoupled from the read) red
// exactly one of them.
// ===========================================================================

/// EARS R-rb-25-X9 (quest arm): `npc::has_quest_or_dialogue_state` must answer
/// from the CURRENT rows of `player_quest`, for the ASKED owner — false with no
/// row, false while only a stranger owns one, true once the owner owns one,
/// false again once the owner's row is gone (while the stranger's row
/// survives). Dialogue state is never seeded here, so every true below is owed
/// to the quest arm. The paired `accounts::account_has_game_data` assertions
/// pin the NPC disjunct of the six-way `||` chain that decides whether a guest
/// holds game data.
///
/// kills:
///   - a hollowed quest arm, `let _ = <the quest read>;` followed by a return
///     value that only reflects dialogue state: the owner-row assertion goes
///     red while every source scan stays green (and the dialogue-arm test
///     below stays green, naming the broken arm).
///   - an arm that answers does-the-table-hold-ANY-row instead of
///     does-THIS-owner-hold-one: the stranger-only assertion goes red, and so
///     does the post-removal assertion (the stranger's row is still there).
///   - a latched or memoised answer that never returns to false once it has
///     seen a row: the post-removal assertion goes red.
///   - deleting the NPC disjunct from `accounts::account_has_game_data`: the
///     paired account assertion goes red while the direct predicate assertion
///     stays green.
#[test]
fn rb41_quest_state_tracks_real_quest_rows() {
    let fx = crate::native_host_tests::fixture();
    let t = fx.table::<PlayerQuestRow>("player_quest", "owner_identity", |r| r.owner_identity);
    let ctx = fx.ctx();
    let owner = Identity::from_byte_array([21u8; 32]);
    let stranger = Identity::from_byte_array([22u8; 32]);

    assert!(
        !crate::npc::has_quest_or_dialogue_state(&ctx, owner),
        "has_quest_or_dialogue_state must be false for an owner with neither quest progress \
         nor dialogue state: both tables are empty here"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be false while the owner owns no row in ANY REKEY table: \
         no row of any kind has been seeded yet"
    );

    // Payload columns are irrelevant to a presence predicate; ownership is the
    // whole question, so they stay empty/zero on purpose.
    t.seed(&PlayerQuestRow {
        pq_id: 9_002,
        owner_identity: stranger,
        quest_id: String::new(),
        step_index: 0,
    });
    assert!(
        !crate::npc::has_quest_or_dialogue_state(&ctx, owner),
        "has_quest_or_dialogue_state must stay false when the ONLY quest row belongs to a \
         different owner: the quest arm answers per-owner, never table-is-non-empty"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must stay false when the only seeded row belongs to a stranger: \
         a guest claim keys on the CALLER identity, not on global table population"
    );

    t.seed(&PlayerQuestRow {
        pq_id: 9_001,
        owner_identity: owner,
        quest_id: String::new(),
        step_index: 0,
    });
    assert!(
        crate::npc::has_quest_or_dialogue_state(&ctx, owner),
        "has_quest_or_dialogue_state must report true through its QUEST arm while the owner \
         holds quest progress and no dialogue state at all; a quest arm that reads the table \
         and then contributes a constant false (the ADR-0222 known-limit hollow) fails exactly \
         here. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be true through its NPC disjunct while the owner holds \
         quest progress and nothing else; a deleted disjunct fails exactly here. Indexes the \
         generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    assert_eq!(
        t.remove(owner),
        1,
        "the owner had exactly one quest row to remove: a different count means the seeded \
         state was not the state this test reasons about"
    );
    assert!(
        !crate::npc::has_quest_or_dialogue_state(&ctx, owner),
        "has_quest_or_dialogue_state must return to false once the owner's quest row is gone: \
         the answer tracks live rows, so it can never latch on a row that no longer exists"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must return to false once the owner's last REKEY-table row is \
         gone: this is the state in which a guest claim is allowed to proceed"
    );
    assert!(
        crate::npc::has_quest_or_dialogue_state(&ctx, stranger),
        "removing the owner's row must leave the stranger's quest row untouched: without this \
         the negative above could be explained by an emptied table rather than by owner \
         scoping. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
}

/// EARS R-rb-25-X9 (dialogue arm): `npc::has_quest_or_dialogue_state` must
/// answer from the CURRENT rows of `player_dialogue_state`, for the ASKED
/// owner — false with no row, false while only a stranger owns one, true once
/// the owner owns one, false again once the owner's row is gone (while the
/// stranger's row survives). Quest progress is never seeded here, so every true
/// below is owed to the dialogue arm. The paired
/// `accounts::account_has_game_data` assertions pin the NPC disjunct of the
/// six-way `||` chain that decides whether a guest holds game data.
///
/// kills:
///   - a hollowed dialogue arm, `let _ = <the dialogue read>;` followed by a
///     return value that only reflects quest progress: the owner-row assertion
///     goes red while every source scan stays green (and the quest-arm test
///     above stays green, naming the broken arm).
///   - dropping the dialogue arm from the `||` chain entirely: same assertion.
///   - an arm that answers does-the-table-hold-ANY-row instead of
///     does-THIS-owner-hold-one: the stranger-only assertion goes red, and so
///     does the post-removal assertion (the stranger's row is still there).
///   - a latched or memoised answer that never returns to false once it has
///     seen a row: the post-removal assertion goes red.
///   - deleting the NPC disjunct from `accounts::account_has_game_data`: the
///     paired account assertion goes red while the direct predicate assertion
///     stays green.
#[test]
fn rb41_dialogue_state_tracks_real_dialogue_rows() {
    let fx = crate::native_host_tests::fixture();
    let t = fx.table::<PlayerDialogueStateRow>("player_dialogue_state", "owner_identity", |r| {
        r.owner_identity
    });
    let ctx = fx.ctx();
    let owner = Identity::from_byte_array([23u8; 32]);
    let stranger = Identity::from_byte_array([24u8; 32]);

    assert!(
        !crate::npc::has_quest_or_dialogue_state(&ctx, owner),
        "has_quest_or_dialogue_state must be false for an owner with neither dialogue state \
         nor quest progress: both tables are empty here"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be false while the owner owns no row in ANY REKEY table: \
         no row of any kind has been seeded yet"
    );

    t.seed(&PlayerDialogueStateRow {
        owner_identity: stranger,
        flags: Vec::new(),
        done_quests: Vec::new(),
    });
    assert!(
        !crate::npc::has_quest_or_dialogue_state(&ctx, owner),
        "has_quest_or_dialogue_state must stay false when the ONLY dialogue row belongs to a \
         different owner: the dialogue arm answers per-owner, never table-is-non-empty"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must stay false when the only seeded row belongs to a stranger: \
         a guest claim keys on the CALLER identity, not on global table population"
    );

    // An all-empty dialogue row is a legal row: presence, not payload, is what
    // the predicate answers.
    t.seed(&PlayerDialogueStateRow {
        owner_identity: owner,
        flags: Vec::new(),
        done_quests: Vec::new(),
    });
    assert!(
        crate::npc::has_quest_or_dialogue_state(&ctx, owner),
        "has_quest_or_dialogue_state must report true through its DIALOGUE arm while the owner \
         holds a dialogue row and no quest progress at all, whatever that row carries; a \
         dialogue arm that reads the table and then contributes a constant false (the ADR-0222 \
         known-limit hollow) fails exactly here. Indexes the generated code asked the host \
         for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be true through its NPC disjunct while the owner holds a \
         dialogue row and nothing else; a deleted disjunct fails exactly here. Indexes the \
         generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    assert_eq!(
        t.remove(owner),
        1,
        "the owner had exactly one dialogue row to remove: a different count means the seeded \
         state was not the state this test reasons about"
    );
    assert!(
        !crate::npc::has_quest_or_dialogue_state(&ctx, owner),
        "has_quest_or_dialogue_state must return to false once the owner's dialogue row is \
         gone: the answer tracks live rows, so it can never latch on a row that no longer exists"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must return to false once the owner's last REKEY-table row is \
         gone: this is the state in which a guest claim is allowed to proceed"
    );
    assert!(
        crate::npc::has_quest_or_dialogue_state(&ctx, stranger),
        "removing the owner's row must leave the stranger's dialogue row untouched: without \
         this the negative above could be explained by an emptied table rather than by owner \
         scoping. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
}

// ===========================================================================
// rb-80 — R-rb-46-ERASEWRITERS (ADR-0250 D2/D3/D5/D8): the para-4.7 deletion
// gate on `talk` AND `advance_dialogue`.
//
// E1 (spec M22 §4.7) names "quest turn-in grants" as the harm. MEASURED FINDING
// (ADR-0250 D2): the turn-in grants do NOT happen in `advance_dialogue`.
// `apply_quest_trigger` (npc.rs:154-222, whose `QuestComplete` arm grants items
// at :215 and currency at :217) has EXACTLY ONE caller — `talk` (npc.rs:308) —
// and the only shipped quest completes on a `Talk` trigger, so the reward lands
// in `talk`. Gating `advance_dialogue` alone would leave the path the criterion
// names open one reducer over. BOTH are gated; both write ERASE-policy tables
// (`inventory` via `grant_item`, `player_wallet` via `grant_currency`,
// `player_quest`, `player_dialogue_state`, `player_conversation`).
//
// `dismiss_dialogue` is CLASSIFY-OPEN (PRV1-10, ADR-0250 D5) and its whole body
// is frozen by the census test below, so the classification is an assertion
// rather than a snapshot.
//
// SCAN SUBSTRATE. Every scan reuses THIS file's existing helpers only
// (`NPC_SOURCE`, `strip_npc_comments`, `m22s3b_blank_strings`,
// `extract_npc_fn_body`, `squash_ws`, `D12R_DQUOTE`) — no third stripper
// (ADR-0003). Every production needle is assembled from fragments and the double
// quote and both braces are spelled as NUMBERS: four evals concatenate every
// `.rs` under `server-module/src` in sorted order and take the FIRST hit of a
// declaration needle, and THIS FILE SORTS BEFORE `raising.rs` and `taming.rs`.
// This file carries no stripper-precondition helper of its own, so clause 0b/0c
// asserts the four substrate landmines on the RAW file, loudly, citing rb-78's
// crate-wide `[rb78/scan-substrate]` clause as the outer net.
//
// HONEST LIMITS, once for the block. The source pins read text, never
// behaviour. The executed matrices read behaviour but stop at the first guard
// PAST the gate: `Fixture::table` keys rows by the indexed column, so the
// `u64`-keyed `character` index is never seeded, an unregistered index yields no
// rows in this host, and every write syscall ABORTS the process (uncatchable, so
// `#[should_panic]` is unavailable). They prove a deletion-gated caller is
// REFUSED exactly where an admitted one is let through — not that an item moved.
// ===========================================================================

/// The fully-qualified gate call, up to and including its open paren.
fn rb80_gate_opener() -> String {
    ["crate::guards::require_not_", "deleting("].concat()
}

/// The bare wrapper name — what an alias, a re-export, a function-pointer
/// binding or a differently-argued sibling all still mention.
fn rb80_gate_bare_name() -> String {
    ["require_not_", "deleting"].concat()
}

/// The gate STATEMENT in both spellings rustfmt can produce, on the view
/// `m22s3b_blank_strings` leaves behind.
///
/// That blanker overwrites the string DELIMITERS as well as the payload, so the
/// reducer tag reads as nothing at all here — which is why the tag is pinned
/// separately, on the strings-INTACT view, by clause T. Two needles because the
/// trailing-comma form is what rustfmt writes when an argument list wraps, and a
/// pin that knows only the plain form is defeated by an honest re-wrap, which
/// would drop the gate count to zero and make every clause below it vacuous.
fn rb80_gate_needles() -> (String, String) {
    let call = rb80_gate_opener();
    (
        [call.as_str(), "ctx,)?;"].concat(),
        [call.as_str(), "ctx,,)?;"].concat(),
    )
}

/// `npc.rs` with comments stripped, string literals blanked and ALL whitespace
/// squashed out — this file's house pipeline (`m22s3b_erase_npc_state_shape`),
/// applied to the whole file instead of one body.
fn rb80_squashed_file() -> String {
    squash_ws(&m22s3b_blank_strings(&strip_npc_comments(NPC_SOURCE)))
}

/// The comments-stripped, strings-blanked, whitespace-squashed body of an
/// `npc.rs` function. Fails LOUD rather than vacuously when the declaration is
/// gone: a missing landmark must never read as a satisfied pin.
fn rb80_scan_body(fn_name: &str) -> String {
    let stripped = m22s3b_blank_strings(&strip_npc_comments(NPC_SOURCE));
    let body = extract_npc_fn_body(&stripped, fn_name).unwrap_or_else(|| {
        panic!(
            "rb-80 [rb80/extract] E1 FAIL: `npc.rs` declares no function named `{fn_name}` whose \
             brace-bounded body can be sliced out. Either the reducer was renamed or removed — in \
             which case every pin scoped to it is vacuous and must be re-derived from ADR-0250 — \
             or its opening brace or matching close is gone."
        )
    });
    let squashed = squash_ws(body);
    assert!(
        !squashed.is_empty(),
        "rb-80 [rb80/extract] E1 FAIL (non-vacuity): the extracted `{fn_name}` body is EMPTY, so \
         every clause below would be asserting properties of nothing."
    );
    squashed
}

/// The comments-stripped, strings-INTACT, whitespace-squashed body of an
/// `npc.rs` function — the only view on which the reducer TAG inside the gate
/// call is visible.
///
/// Sound on this file for the same reason `talk_zone_check_uses_ne_not_eq`
/// (:554) is sound on it: the braces inside `npc.rs`'s hand-built JSON log lines
/// are BALANCED, so `extract_npc_fn_body`'s depth walk still closes on the
/// body's own brace.
fn rb80_intact_body(fn_name: &str) -> String {
    let stripped = strip_npc_comments(NPC_SOURCE);
    let body = extract_npc_fn_body(&stripped, fn_name).unwrap_or_else(|| {
        panic!(
            "rb-80 [rb80/extract] E1 FAIL (strings-intact view): `npc.rs` declares no function \
             named `{fn_name}`. The tag clause below cannot run over a body that does not exist."
        )
    });
    squash_ws(body)
}

/// The four substrate hazards this file's strippers do not model, asserted on
/// the RAW source because on a stripped view every one of them is
/// tautologically absent.
///
/// `r#` opens a raw string the blanker cannot close; a double quote spelled as a
/// CHAR literal inverts string/code polarity for the rest of the file; a brace
/// CHAR literal survives both strippers and desynchronises the depth walk by
/// exactly one (enough to slice the wrong body, and enough to make a gate nested
/// in a never-taken branch report as top level); an UNPAIRED block-comment
/// opener blanks the file to its last byte, which would make every clause below
/// read `Ok` about text it never looked at. rb-78's crate-wide
/// `[rb78/scan-substrate]` clause is the outer net for all four; this is the
/// local one, and it names the file.
fn rb80_assert_scan_substrate(raw: &str) {
    let sq = char::from(0x27u8).to_string();
    let dq = char::from(D12R_DQUOTE).to_string();
    let raw_opener = ["r", "#"].concat();
    let quote_landmine = [sq.as_str(), dq.as_str(), sq.as_str()].concat();
    for landmine in [raw_opener.as_str(), quote_landmine.as_str()] {
        assert!(
            !raw.contains(landmine),
            "rb-80 [rb80/scan-substrate] SCAN PRECONDITION: `npc.rs` contains {landmine} , which \
             this file's string blanker does not model — it would blank the wrong byte range and \
             hollow out every clause below into a green verdict about text that no longer exists. \
             Extend the blanker (or spell the character with a Unicode escape, as \
             `guards.rs::json_escape` does) before adding such a literal; never delete this check."
        );
    }
    // rb-80 (verifier V1): a PLAIN raw string, not only the `r#` opener, also
    // defeats this file's blanker (no raw-string lexer: the backslash before the
    // real closer is read as an escape, the closer is swallowed, and every byte up
    // to the next quote is blanked). MEASURED: it hid a below-gate early exit from
    // the return census while every other clause stayed green. Reject any `r`
    // directly followed by a double quote whose preceding byte is not an
    // identifier byte (a byte-string `br` opener counts too).
    let rdq = char::from(0x22u8).to_string();
    let raw_str_opener = ["r", rdq.as_str()].concat();
    let raw_bytes = raw.as_bytes();
    let is_ident = |b: u8| b.is_ascii_alphanumeric() || b == 0x5Fu8;
    for (at, _) in raw.match_indices(raw_str_opener.as_str()) {
        let opener = match at {
            0 => true,
            1 => raw_bytes[0] == 0x62u8,
            _ => {
                !is_ident(raw_bytes[at - 1])
                    || (raw_bytes[at - 1] == 0x62u8 && !is_ident(raw_bytes[at - 2]))
            }
        };
        assert!(
            !opener,
            "rb-80 [rb80/scan-substrate] SCAN PRECONDITION: `npc.rs` spells a raw-string opener at \
             byte {at}. This file's blanker has no raw-string lexer: a backslash before the real \
             closer is read as an escape, the closer is swallowed, and every byte up to the next \
             quote is blanked — MEASURED (verifier V1) to hide a below-gate early exit from the \
             return census while every other clause stayed green. Spell the literal as an \
             ordinary string, or teach the blanker raw strings; never delete this check."
        );
    }
    for code in [0x7Bu8, 0x7Du8] {
        let brace = char::from(code).to_string();
        let landmine = [sq.as_str(), brace.as_str(), sq.as_str()].concat();
        assert!(
            !raw.contains(landmine.as_str()),
            "rb-80 [rb80/scan-substrate] SCAN PRECONDITION: `npc.rs` contains the character \
             literal {landmine} , which both strippers keep. Its brace desynchronises \
             `extract_npc_fn_body`'s depth walk and clause C's depth count by one — enough to \
             slice the wrong body, and enough to make a gate nested inside a never-taken branch \
             report as a top-level statement."
        );
    }
    let open_marker = ["/", "*"].concat();
    let close_marker = ["*", "/"].concat();
    let n_open = raw.matches(open_marker.as_str()).count();
    let n_close = raw.matches(close_marker.as_str()).count();
    assert_eq!(
        n_open, n_close,
        "rb-80 [rb80/scan-substrate] SCAN PRECONDITION: `npc.rs` carries {n_open} block-comment \
         opener(s) and {n_close} closer(s). An UNPAIRED opener makes `strip_npc_comments` hunt a \
         closer that never comes and blank the file to its LAST BYTE: the gate needle disappears \
         with it, every count below reads zero, and the verdict would be silent, total vacuity \
         that looks exactly like a clean file. Counted on the RAW text, because by the time the \
         scan has the stripped view there is nothing left to count."
    );
}

/// The FROZEN statement prefix above `talk`'s deletion gate: comments stripped,
/// string literals AND their delimiters blanked, all whitespace removed.
///
/// HAND-DERIVED, NEVER READ FROM THE FILE (ADR-0250 D2, ADR-0227 D3/D4,
/// PRV1-9): the caller binding, then Step 1's joined let-else with its
/// rejection, then NOTHING ELSE — the gate sits above the character row, the NPC
/// lookup, the zone and range checks, the dialogue-tree content read, the
/// auto-effects and every write.
///
/// BYTE-IDENTICAL to `heal_party`'s frozen prefix in `raising_tests.rs`, which
/// is exactly why each site also pins an anti-transposition landmark inside its
/// own body (here: the single `apply_quest_trigger(` call). Without one, the two
/// literals could be swapped between files and no clause anywhere would notice.
/// Compared by EQUALITY, never `starts_with`/`contains`.
fn rb80_talk_prefix() -> String {
    let open = char::from(0x7Bu8).to_string();
    let close = char::from(0x7Du8).to_string();
    [
        concat!("letme=ctx.s", "ender();"),
        concat!(
            "letSome(p)=ctx.db.play",
            "er().iden",
            "tity().find",
            "(me)else"
        ),
        open.as_str(),
        concat!("returnErr(.to_", "string());"),
        close.as_str(),
        ";",
    ]
    .concat()
}

/// The FROZEN statement prefix above `advance_dialogue`'s deletion gate.
///
/// HAND-DERIVED (ADR-0250 D3): the caller binding, Step 1's PK-scoped
/// conversation let-else, then Step 1.5's joined let-else — and nothing else.
/// The gate is NECESSARILY above npc.rs:345, the first write in this body (a
/// conversation delete in the npc-missing arm), and above the two `log::warn!`
/// dismiss arms at :354/:363, which is what keeps rb-78's macro grammar
/// (ADR-0248 D4) green for this region.
///
/// The two rejection fragments are spelled with DIFFERENT split points on
/// purpose: one shared constructor would mean a single wrong edit moved both
/// halves of the literal together, and the runtime ties (`returnErr(` twice,
/// two braces of each kind) are what notice if one of them is dropped.
fn rb80_advance_prefix() -> String {
    let open = char::from(0x7Bu8).to_string();
    let close = char::from(0x7Du8).to_string();
    [
        concat!("letme=ctx.s", "ender();"),
        concat!(
            "letSome(conv)=ctx.db.player_conv",
            "ersation().owner_iden",
            "tity().find",
            "(me)else"
        ),
        open.as_str(),
        concat!("returnErr(.to_", "string());"),
        close.as_str(),
        ";",
        concat!(
            "letSome(p)=ctx.db.play",
            "er().iden",
            "tity().find",
            "(me)else"
        ),
        open.as_str(),
        concat!("returnErr(", ".to_string());"),
        close.as_str(),
        ";",
    ]
    .concat()
}

/// Assert that `fn_name`'s body in `npc.rs` carries the deletion gate exactly
/// once, as a reachable top-level `?`-propagating statement that nothing above
/// it can skip, with the FROZEN prefix above it and the ordering anchors around
/// it. Returns the scanned body and the gate's byte offset, because
/// `advance_dialogue` adds one clause of its own (W) that has to continue from
/// exactly those two values.
///
/// A per-file copy of the `economy_tests.rs` helper of the same shape: every
/// `*_tests.rs` is a `cfg(test)` submodule of its own production file and
/// none can reach another's bare `fn` items, so sharing would need a new
/// `pub(crate) mod` (the precedent `content_cache_tests.rs:361-368` records for
/// its own stripper copies). Driven once per gated reducer so each failure names
/// its own reducer.
///
/// EVERY clause is required and NONE may be relaxed to make a build green — a
/// pin that cannot be satisfied is a plan defect, to be re-derived from ADR-0250
/// and the spec. Clause A reports FIRST because it is the security claim, and
/// under first-failure-wins every clause after it is meaningless while the gate
/// is absent.
fn rb80_assert_gate_pinned(
    fn_name: &str,
    expected_prefix: &str,
    ties: &[(&str, usize)],
    above: &[(&str, &str)],
    below: &[(&str, &str)],
) -> (String, usize) {
    // --- Clause 0b/0c: the substrate landmines, on the RAW file --------------
    rb80_assert_scan_substrate(NPC_SOURCE);

    // --- Clause 0a: exactly ONE declaration to scan, paren-free --------------
    let squashed_file = rb80_squashed_file();
    let paren_free = ["fn", fn_name].concat();
    let n_decl = squashed_file.matches(paren_free.as_str()).count();
    assert_eq!(
        n_decl, 1,
        "rb-80 [rb80/twin] SCAN PRECONDITION: the squashed, paren-free declaration bytes of \
         `{fn_name}` occur {n_decl} time(s) in `npc.rs` and must occur EXACTLY once. MORE THAN \
         ONE means a second declaration whose NAME EXTENDS this one's exists in the file; \
         `extract_npc_fn_body` takes the FIRST hit, so a twin above would hand every clause below \
         a gate-less body that passes and says nothing about the reducer clients call. ZERO means \
         the reducer was renamed or removed and every pin scoped to it is vacuous — re-derive \
         them from ADR-0250, never by relaxing this count."
    );

    // --- Clause A: the gate statement is present EXACTLY once ----------------
    let body = rb80_scan_body(fn_name);
    let (plain, trailing) = rb80_gate_needles();
    let n_gate = body.matches(plain.as_str()).count() + body.matches(trailing.as_str()).count();
    let head: String = body.chars().take(320).collect();
    assert_eq!(
        n_gate, 1,
        "rb-80 [rb80/gate-count] E1 FAIL: `{fn_name}` contains {n_gate} deletion-gate \
         statement(s) and must contain EXACTLY ONE. ZERO IS THE RED STATE AT HEAD — the gate has \
         not been wired into this reducer yet, so a mid-grace or terminal account still collects \
         quest rewards and dialogue item grants into an inventory the cascade is about to erase. \
         The needle is the FULLY QUALIFIED call ending in `?;`, in either the inline or the \
         trailing-comma form, so an unqualified call reached through an import — behaviourally \
         identical, and therefore invisible to the executed matrix beside this test — reads as \
         ZERO here. So does a discarded verdict (`let _ = ..`, `.ok();`), which compiles, lints \
         clean under -D warnings and gates nothing. TWO means a duplicate, under which every \
         ordering clause anchors on a first hit a second call can sit behind. Body (first 320 \
         chars):\n{head}"
    );

    let gate_at = body
        .find(plain.as_str())
        .or_else(|| body.find(trailing.as_str()))
        .expect("rb-80: the gate statement counted 1 but could not be located");

    // --- Clause C: the gate sits at the body's TOP level ---------------------
    let open = char::from(0x7Bu8);
    let close = char::from(0x7Du8);
    let opens = body[..gate_at].matches(open).count();
    let closes = body[..gate_at].matches(close).count();
    assert_eq!(
        opens, closes,
        "rb-80 [rb80/depth] E1 FAIL (unconditional): the deletion gate in `{fn_name}` sits at \
         brace depth {opens} minus {closes} — INSIDE a nested block — and must sit at the body's \
         top level. A gate wrapped in a never-satisfied condition, a loop or a match arm no real \
         call enters leaves every text needle here satisfied while the reducer decides nothing. \
         This is the shape a whole-body `contains` check cannot see."
    );

    // --- Clause D: the gate is its own statement, not an attributed one ------
    let semi = char::from(0x3Bu8);
    let prev = body[..gate_at].chars().next_back();
    assert!(
        prev.is_none_or(|c| c == semi || c == close),
        "rb-80 [rb80/boundary] E1 FAIL: in `{fn_name}` the deletion gate is preceded by {prev:?}, \
         which is not a statement boundary (a semicolon, a closing brace, or the start of the \
         body). THE CASE THIS EXISTS FOR: a conditional-compilation attribute on the gate \
         statement leaves a closing square bracket here — under it every test in this crate \
         executes the gate while the published wasm is compiled WITHOUT it. The same clause kills \
         a discarded binding (an equals sign), a combinator that swallows the verdict (a dot) and \
         a macro that swallows the whole call (an open paren). Re-derive the placement from \
         ADR-0250 D2/D3; never widen this clause."
    );

    // --- Clause E: no conditional compilation anywhere in the body -----------
    let attr_open = ["#", "["].concat();
    let cfg_macro = ["cfg", "!("].concat();
    for needle in [attr_open.as_str(), cfg_macro.as_str()] {
        let n = body.matches(needle).count();
        assert_eq!(
            n, 0,
            "rb-80 [rb80/cfg] E1 FAIL: `{fn_name}` contains {n} occurrence(s) of {needle} and \
             must contain ZERO — a conditional-compilation attribute or macro on ANY statement \
             here is the deployment-dependent gate clause D describes, reached from further away. \
             Dialogue guards must compile into every build. Green at HEAD; keep it that way. NOTE \
             this clause is BODY-scoped and cannot see a FILE-scope switch; the cfg census in \
             `rb80_npc_reducer_roster_and_open_writers_are_pinned` is what closes that."
        );
    }

    // --- Clause F: exactly ONE mention of the wrapper, by bare name ----------
    let bare = rb80_gate_bare_name();
    let n_bare = body.matches(bare.as_str()).count();
    assert_eq!(
        n_bare, 1,
        "rb-80 [rb80/bare-name] E1 FAIL (caller-only): `{fn_name}` mentions the deletion-gate \
         wrapper {n_bare} time(s) by BARE NAME and must mention it EXACTLY once. WHAT TWO \
         ACTUALLY IS: clause A already pins the fully-qualified `?;` STATEMENT at exactly one, so \
         a SECOND bare mention is a second decision path spelled some other way — an alias, a \
         re-export or a function-pointer binding of the wrapper; a local wrapper AROUND the \
         wrapper (a closure or a nested fn in this body, which clause A's statement needle walks \
         straight past); or a duplicated call whose verdict is swallowed instead of propagated \
         (`let _ = ..`, `.ok();`, a call inside a closure). NOT the identity-parameterised \
         sibling: ADR-0227 D2 makes THIS wrapper caller-only by SIGNATURE, and rb-76 pins the two \
         bare names prefix-free precisely so neither census inflates the other — so the sibling's \
         name does not contain this one and this clause is blind to it BY CONSTRUCTION. Its \
         containment is owned crate-wide by `guards_tests.rs`'s \
         `rb76_subject_gate_and_begin_encounter_are_contained_crate_wide` clause (a), which pins \
         that name at ZERO in every scanned module but `guards.rs` and `battle.rs`. The executed \
         matrix cannot see any of this: the native host's dummy sender is the only identity that \
         ever calls. ZERO means clause A matched a qualified call without the name, which is a \
         scan defect."
    );

    // --- Clause P: the WHOLE prefix above the gate is frozen ----------------
    let got = &body[..gate_at];
    assert_eq!(
        got, expected_prefix,
        "rb-80 [rb80/prefix] E1 FAIL: the squashed text ABOVE `{fn_name}`'s deletion gate is not \
         the frozen guard prefix.\n      Got:      {got:?}\n      Expected: {expected_prefix:?}\n \
         WHAT THIS KILLS: every statement that can run before a caller reaches the gate — the \
         seven CI-clean survivors rb-79 measured, enumerated once in ADR-0249 D2, each of which \
         keeps the gate statement, its `?`, its depth, its tag and rb-46's textual return census \
         byte-identically green. RE-DERIVATION CONTRACT: this literal comes from ADR-0250 D2/D3 \
         and ADR-0227 D3/D4 plus PRV1-9. If an honest refactor reds it, re-derive it from those \
         decisions in a new ADR. NEVER paste the current body in to make it green, and never \
         relax the equality to `starts_with` or `contains` — both readmit every survivor \
         ADR-0249 D2 names."
    );

    // --- Clause P's runtime ties, on the FROZEN literal ---------------------
    for &(needle, want) in ties {
        let n = expected_prefix.matches(needle).count();
        assert_eq!(
            n, want,
            "rb-80 [rb80/tie] E1 FAIL: the frozen prefix for `{fn_name}` contains `{needle}` {n} \
             time(s) and the derivation requires {want}. THIS CLAUSE GUARDS ONE FAILURE MODE: a \
             literal regenerated from a body somebody already changed, which would turn the \
             strongest pin in this slice into a photograph of the defect. The ties are spelled \
             from a THIRD set of split points on purpose. Re-derive from ADR-0250 D2/D3, never \
             from the file."
        );
    }

    // --- Clause R: every early exit in the WHOLE body is a rejection ---------
    let return_kw = ["ret", "urn"].concat();
    let return_err = ["ret", "urnErr("].concat();
    let n_return = body.matches(return_kw.as_str()).count();
    let n_return_err = body.matches(return_err.as_str()).count();
    assert_eq!(
        n_return, n_return_err,
        "rb-80 [rb80/early-exit] E1 FAIL: `{fn_name}` contains {n_return} early exit(s) but only \
         {n_return_err} of them return an `Err`. Every early exit in a gated reducer must be a \
         REJECTION; one that returns anything else routes the caller AROUND the rest of the body, \
         and clause P only constrains the region ABOVE the gate — this is the BELOW-gate half \
         (the BELOW-gate region is otherwise UNPINNED — an else-wrapped delegation with no `return`, a \
         delegation reaching a write helper through a fn-pointer binding, a raw table-accessor write \
         and an identity rebinding all pass every clause here: R-rb-80-BELOWGATE, \
         R-rb-80-FNPTRDELEGATE, R-rb-80-RAWWRITE, each measured). HONEST LIMIT: a `macro_rules!` expanding to a \
         conditional return contains no textual `return` and evades this clause — that is rb-78's \
         crate-wide grammar (ADR-0248), which refuses every bang macro between the item boundary \
         and the gate. Never widen the needle to make this green."
    );

    // --- Clause G: every ordering anchor occurs EXACTLY once -----------------
    // --- Clause H: above < gate < below, in the listed order -----------------
    let mut cursor = 0usize;
    for &(needle, role) in above {
        let n = body.matches(needle).count();
        assert_eq!(
            n, 1,
            "rb-80 [rb80/anchor] E1 FAIL (anti-vacuity): the anchor `{needle}` — {role} — occurs \
             {n} time(s) in `{fn_name}` and must occur EXACTLY once. ZERO makes every ordering \
             clause unfireable, so the pin would pass over a reducer whose landmark moved or was \
             renamed; TWO makes the comparison depend on which copy is found first. RE-DERIVE THE \
             PIN AGAINST THE CURRENT BODY AND ADR-0250; never delete an anchor to make this green."
        );
        let at = body
            .find(needle)
            .unwrap_or_else(|| panic!("rb-80: anchor `{needle}` counted 1 but was not located"));
        assert!(
            cursor <= at && at < gate_at,
            "rb-80 [rb80/order] E1 FAIL (placement): in `{fn_name}` the anchor `{needle}` — \
             {role} — is at offset {at}, which is not between the previous anchor ({cursor}) and \
             the deletion gate ({gate_at}). ADR-0227 D3/D4 orders the gate immediately AFTER \
             caller standing is established, so a caller with no standing is told THAT, not \
             something about their account lifecycle."
        );
        cursor = at;
    }
    cursor = gate_at;
    for &(needle, role) in below {
        let n = body.matches(needle).count();
        assert_eq!(
            n, 1,
            "rb-80 [rb80/anchor] E1 FAIL (anti-vacuity): the anchor `{needle}` — {role} — occurs \
             {n} time(s) in `{fn_name}` and must occur EXACTLY once. With zero the landmark this \
             pin orders the gate against is gone and the ordering claim is vacuous; with two the \
             comparison depends on which copy is found first."
        );
        let at = body
            .find(needle)
            .unwrap_or_else(|| panic!("rb-80: anchor `{needle}` counted 1 but was not located"));
        assert!(
            cursor < at,
            "rb-80 [rb80/order] E1 FAIL (decision before irreversible effect): in `{fn_name}` the \
             anchor `{needle}` — {role} — is at offset {at}, at or BEFORE the previous landmark \
             ({cursor}); the deletion gate is at {gate_at}. A gate that runs once the quest row \
             has been inserted, the item granted or the conversation row written gates nothing: \
             the transaction still rolls back on the reject, but the reducer has reordered its own \
             guards so a later refactor — or a partial-failure path — commits a grant for an \
             account that may not open new commitments. The executed matrix cannot see this: the \
             native host aborts the process on any write syscall, so it never reaches the effect."
        );
        cursor = at;
    }

    // --- Clause T: the tag is this reducer's own fn name ---------------------
    let dq = char::from(D12R_DQUOTE).to_string();
    let tagged = [
        rb80_gate_opener().as_str(),
        "ctx,",
        dq.as_str(),
        fn_name,
        dq.as_str(),
        ")?;",
    ]
    .concat();
    let tagged_wrapped = [
        rb80_gate_opener().as_str(),
        "ctx,",
        dq.as_str(),
        fn_name,
        dq.as_str(),
        ",)?;",
    ]
    .concat();
    let intact = rb80_intact_body(fn_name);
    let n_tag =
        intact.matches(tagged.as_str()).count() + intact.matches(tagged_wrapped.as_str()).count();
    assert_eq!(
        n_tag, 1,
        "rb-80 [rb80/tag] E1 FAIL: on the strings-INTACT view `{fn_name}` carries {n_tag} gate \
         call(s) tagged with its OWN function name and must carry exactly one. This file gates \
         TWO reducers whose gate statements are otherwise byte-identical, so a copy-pasted tag is \
         the likeliest single-character defect here (register row M6): it makes every mid-grace \
         refusal in one reducer indistinguishable from the other's in `log_reject`'s structured \
         warn, and no other clause in this slice can see it, because the view every other clause \
         runs on has the string payload blanked."
    );

    (body, gate_at)
}

/// Seed the one `player` row Step 1 / Step 1.5's joined check needs.
///
/// The handle is registered against the SAME fixture the caller's account handle
/// comes from — rows live in the host store, not in the handle. A plain struct
/// literal, the house pattern for `Player`: unlike `Account` it has no pure
/// constructor to route through and carries no legal-state invariant.
fn rb80_seed_player(fx: &crate::native_host_tests::Fixture, me: Identity) {
    let players = fx.table::<crate::schema::Player>("player", "identity", |r| r.identity);
    players.seed(&crate::schema::Player {
        identity: me,
        entity_id: 7,
        name: String::new(),
        online: true,
        last_input_seq: 0,
    });
}

/// Seed the caller's `player_conversation` row — `advance_dialogue`'s Step 1
/// PK-scoped lookup, which sits ABOVE the gate, so without this row every state
/// would return "no active conversation" and the whole five-state matrix would
/// be vacuous in both directions.
fn rb80_seed_conversation(fx: &crate::native_host_tests::Fixture, me: Identity) {
    let convs = fx.table::<crate::schema::PlayerConversation>(
        "player_conversation",
        "owner_identity",
        |r| r.owner_identity,
    );
    convs.seed(&crate::schema::PlayerConversation {
        owner_identity: me,
        npc_entity_id: 1,
        current_node_id: "n".to_string(),
    });
}

/// A mid-grace account row for somebody who is NOT the caller.
///
/// Seeded once and never removed, so the account table is never empty of
/// deleting rows. Without it a TABLE-keyed gate — refuse if ANYBODY is deleting
/// — is observationally identical to the caller-keyed one in all five states.
/// `remove` and `find` are `Identity`-keyed, so this row never disturbs the
/// per-state `remove(me) == 1` assertions.
fn rb80_seed_deleting_stranger(
    acct: &crate::native_host_tests::Handle<'_, crate::schema::Account>,
) {
    let stranger = Identity::from_byte_array([9u8; 32]);
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, String::new(), 0),
        1,
    ));
}

/// The five-state executed matrix, driven once per gated reducer so a single
/// dropped gate fails with a message naming which one.
///
/// `call` is a closure rather than a reducer path because the two reducers take
/// different argument lists. `ordinary` is the exact next-guard error of the
/// admitted states, pinned EXACTLY rather than as any-error: otherwise a
/// regression in the joined check (which returns a different error) would
/// masquerade as a pass in all three admitted states and the whole positive
/// control would go quietly vacuous.
fn rb80_assert_refused_only_while_gated(
    what: &str,
    fx: &crate::native_host_tests::Fixture,
    acct: &crate::native_host_tests::Handle<'_, crate::schema::Account>,
    me: Identity,
    call: &dyn Fn() -> Result<(), String>,
    ordinary_text: &str,
) {
    let ordinary: Result<(), String> = Err(ordinary_text.to_string());
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let active = crate::accounts::new_account_row(me, String::new(), 0);
    let pending = crate::accounts::requested_deletion(active.clone(), 1);
    let terminal = crate::accounts::terminal_account(pending.clone(), 2);

    rb80_seed_deleting_stranger(acct);

    // --- State 1: no account row for the caller (a guest) -------------------
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-80 E1 FAIL (admitted state, no account row): `{what}` returned {got:?} for a joined \
         caller with NO account row, while a STRANGER's row is mid-grace. A caller who never \
         authenticated is not inside the deletion gate and must be admitted into the ordinary \
         guard chain. A deletion reject here means the gate answers from the TABLE rather than \
         from the caller's own row. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 2: an Active account row --------------------------------------
    acct.seed(&active);
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-80 E1 FAIL (admitted state, Active account): `{what}` returned {got:?} for a caller \
         whose account row is `Active` (a stranger's row is mid-grace). This is the ordinary \
         player, and refusing them is a TOTAL DIALOGUE OUTAGE that every source pin in this slice \
         would report as correctly gated — the call text is byte-identical whichever way the \
         decision runs. It is also exactly what a row-EXISTS-keyed fake produces, what an \
         any-row-pending TABLE scan produces, and what an inverted branch produces."
    );

    // --- State 3: mid-grace (PendingDeletion) --------------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture ({what}): exactly one `Active` account row was seeded for the CALLER and \
         must be removed before the next state is pushed — `seed` appends rather than upserting, \
         so a miscount would leave two rows for one identity and the unique-index lookup would \
         assert instead of answering. `remove` is Identity-keyed, so the stranger's row is \
         deliberately untouched and must never be counted here."
    );
    acct.seed(&pending);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-80 E1 FAIL (refused state, mid-grace): `{what}` returned {got:?} for a caller whose \
         account is `PendingDeletion`; it must return the module's single static deletion reject. \
         THIS IS THE RED STATE AT HEAD — at HEAD neither dialogue reducer carries a deletion \
         gate, so a mid-grace account still starts quests, collects turn-in rewards and takes \
         item grants into rows the cascade is about to erase. The expected value is compared \
         against the CONSTANT, never a re-typed literal, so a reworded reason cannot drift \
         silently into text no client ever receives."
    );

    // --- State 4: terminal (PendingDeletion + the marker) -------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture ({what}): exactly one `PendingDeletion` account row was seeded for the \
         CALLER and must be removed before the terminal row is pushed (`seed` appends, it never \
         upserts; the stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-80 E1 FAIL (refused state, terminal): `{what}` returned {got:?} for a caller whose \
         account carries the M22 terminal marker. An already-erased account has no inventory, no \
         wallet and no quest rows left — the cascade deleted them — so a grant here would \
         recreate rows the deletion just removed. The pure decision is an explicit disjunction \
         (`accounts::should_reject_for_deletion`) precisely so this state is fail-closed even on \
         the illegal `Active`-plus-marker shape."
    );

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture ({what}): exactly one terminal account row was seeded for the CALLER and \
         must be removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-80 E1 FAIL (admitted state, row removed): `{what}` returned {got:?} once the caller's \
         account row was gone again (the stranger's mid-grace row is still there). The verdict \
         must track LIVE rows FOR THE CALLER: an answer that latches on a row it has already seen \
         — a memoised predicate, a cached decision, a process-wide flag — would keep refusing this \
         identity forever, and an any-row-pending answer would refuse it because of somebody \
         else. No state above can distinguish either of those from a correct gate on its own."
    );
}

/// **E1 (source)** — `talk` carries the para-4.7 deletion gate, in the house
/// spelling, at depth zero, with NOTHING above it but the caller binding and the
/// joined check, and above every grant.
///
/// `talk` is IN SCOPE because it is the sole caller of `apply_quest_trigger`,
/// whose `QuestComplete` arm is the "quest turn-in grant" the criterion names
/// (ADR-0250 D2). It also inserts `player_quest` rows and routes `GrantItem`
/// auto-effects through `apply_effects_to_db`.
///
/// RED AT HEAD on clause `[rb80/gate-count]`: `talk` carries no deletion gate,
/// so the count is ZERO.
///
/// kills: M2 (the dropped `talk` gate) · M5 (`let _ = ..` discard) · M7 (the
/// gate moved below the first grant) · M8 (a `cfg(test)` attribute on the gate statement
/// — clauses D and E) · M9 (an unqualified, import-shadowed call) · M10 (a
/// duplicate gate) · M6 (the tag swapped with `advance_dialogue`'s — clause T,
/// the only clause that can see it) · M13/M15/M16 (a sender-keyed early `Ok`, a
/// rejection-SHAPED `return Err(e);` and a wild-sentinel shadow above the gate —
/// clause P; the first and third are invisible to the executed matrix because
/// the native host's sender IS `WILD_IDENTITY`).
#[test]
fn rb80_talk_carries_the_deletion_gate() {
    let name = ["ta", "lk"].concat();
    let expected = rb80_talk_prefix();
    let open = char::from(0x7Bu8).to_string();
    let close = char::from(0x7Du8).to_string();
    let ties: [(&str, usize); 9] = [
        (concat!("letme", "="), 1),
        (concat!("ctx.se", "nder()"), 1),
        (concat!("player().id", "entity().find(me)"), 1),
        (concat!("return", "Err("), 1),
        (concat!(".to_s", "tring());"), 1),
        (concat!("crat", "e::"), 0),
        (concat!("?", ";"), 0),
        (open.as_str(), 1),
        (close.as_str(), 1),
    ];
    let above: [(&str, &str); 1] = [(
        concat!("player().id", "entity().find(me)"),
        "Step 1's caller-joined lookup — standing is established exactly there, so the preamble \
         reads joined, then not-deleting (ADR-0227 D3)",
    )];
    let below: [(&str, &str); 3] = [
        (
            concat!("character().entity_id()", ".find(p.entity_id)"),
            "the character lookup, the first read that must run AFTER the gate",
        ),
        (
            concat!("apply_effects", "_to_db("),
            "the auto-effects router (npc.rs:289) — the `GrantItem` path into `inventory`, an \
             ERASE-policy table",
        ),
        (
            concat!("apply_quest", "_trigger("),
            "the quest-trigger call (npc.rs:308), whose `QuestComplete` arm grants items and \
             currency — the harm E1 names, and this site's anti-transposition landmark: `talk`'s \
             frozen prefix is byte-identical to `heal_party`'s, so without a landmark inside this \
             body the two literals could be swapped between files unnoticed",
        ),
    ];
    rb80_assert_gate_pinned(name.as_str(), expected.as_str(), &ties, &above, &below);
}

/// **E1 (source)** — `advance_dialogue` carries the para-4.7 deletion gate, at
/// depth zero, with NOTHING above it but the caller binding and the two
/// caller-state lookups, and ABOVE the first write in the body.
///
/// Clause W is this site's own: `advance_dialogue` writes on its REJECT paths
/// (the npc-missing, npc-character-missing, wrong-zone and walked-away arms each
/// DELETE the caller's conversation row), so "above the first write" is a
/// stronger and different claim here than "above the happy-path effect". The
/// gate must precede ALL FIVE conversation deletes, which is also what puts it
/// above the two `log::warn!` arms at npc.rs:354/:363 and keeps rb-78's
/// macro-expansion grammar (ADR-0248 D4) green for this region.
///
/// RED AT HEAD on clause `[rb80/gate-count]`: the count is ZERO.
///
/// kills: M3 (the dropped `advance_dialogue` gate) · M5 · M7 (the gate placed
/// below the npc-missing delete — clause W's first-occurrence check, which no
/// other clause in this slice owns) · M8 · M9 · M10 · M6 (the tag swapped with
/// `talk`'s) · M13/M15/M16 (clause P).
#[test]
fn rb80_advance_dialogue_carries_the_deletion_gate() {
    let name = ["advance_", "dialogue"].concat();
    let expected = rb80_advance_prefix();
    let open = char::from(0x7Bu8).to_string();
    let close = char::from(0x7Du8).to_string();
    let ties: [(&str, usize); 10] = [
        (concat!("letme", "="), 1),
        (concat!("ctx.se", "nder()"), 1),
        (concat!("player().id", "entity().find(me)"), 1),
        (
            concat!("player_conversa", "tion().owner_identity().find(me)"),
            1,
        ),
        (concat!("return", "Err("), 2),
        (concat!(".to_s", "tring());"), 2),
        (concat!("crat", "e::"), 0),
        (concat!("?", ";"), 0),
        (open.as_str(), 2),
        (close.as_str(), 2),
    ];
    let above: [(&str, &str); 2] = [
        (
            concat!("player_conversa", "tion().owner_identity().find(me)"),
            "Step 1's PK-scoped conversation lookup (F1: player A cannot advance player B's \
             conversation) — the gate sits below it so a caller with no conversation is told \
             THAT, not something about their account lifecycle",
        ),
        (
            concat!("player().id", "entity().find(me)"),
            "Step 1.5's caller-joined lookup — where standing is established (ADR-0227 D3)",
        ),
    ];
    let below: [(&str, &str); 3] = [
        (
            concat!("character().entity_id()", ".find(p.entity_id)"),
            "the character lookup, the first read that must run AFTER the gate",
        ),
        (
            concat!("apply_", "choice("),
            "the dialogue security gate (npc.rs:385) whose effects reach `player_quest`, \
             `player_dialogue_state` and `inventory` — and this site's anti-transposition \
             landmark",
        ),
        (
            concat!("apply_effects", "_to_db("),
            "the DB-side effects router (npc.rs:392) — the `GrantItem` path into `inventory` and \
             the `StartQuest` path into `player_quest`. Pinned HERE, inside this body, because \
             the file-wide write census CANNOT see it: that count (3) folds the declaration in \
             with both call sites, so a call MOVED out of this reducer into a helper below the \
             gate nets ZERO there. Exactly-once-in-this-body, ordered after the gate, is what \
             notices",
        ),
    ];
    let (body, gate_at) =
        rb80_assert_gate_pinned(name.as_str(), expected.as_str(), &ties, &above, &below);

    // --- Clause W: the gate precedes EVERY conversation delete --------------
    let delete = concat!("player_conversa", "tion().owner_identity().dele", "te(me)");
    let n_delete = body.matches(delete).count();
    assert_eq!(
        n_delete, 5,
        "rb-80 [rb80/first-write] E1 FAIL (anti-vacuity): `advance_dialogue` deletes the caller's \
         conversation row {n_delete} time(s) and the body this pin was derived against does it \
         FIVE times — the npc-missing arm (npc.rs:345), the npc-character-missing arm (:349), the \
         wrong-zone arm (:353), the walked-away arm (:362) and the end-of-dialogue arm (:405). \
         FEWER means a reject path stopped cleaning up and the ordering claim below covers less \
         than it says; MORE means a sixth write this pin never reasoned about. Re-derive against \
         the current body, never by loosening the count."
    );
    let first_delete = body
        .find(delete)
        .expect("rb-80: the conversation delete counted 5 but the first could not be located");
    assert!(
        gate_at < first_delete,
        "rb-80 [rb80/first-write] E1 FAIL: `advance_dialogue`'s deletion gate is at offset \
         {gate_at} but its FIRST write — a delete of the caller's own `player_conversation` row, \
         an ERASE-policy table — is at {first_delete}. This reducer writes on its REJECT paths, so \
         a gate placed after the npc-missing arm would let a mid-grace caller mutate an \
         ERASE-policy table before being refused. No other clause in this slice owns that: the \
         ordering anchors below the gate name the happy-path effects, and the executed matrix \
         never reaches a write at all (the native host aborts the process on the syscall)."
    );
}

/// **E1 (behaviour)** — `talk` refuses a deletion-gated caller, ADMITS everybody
/// else, and answers from the CALLER's own row.
///
/// Five account states under the rb-41 native host with a mid-grace STRANGER row
/// present throughout. The three admitted states are the positive control and
/// they are what make the two refused states mean anything.
///
/// WHY THE ADMITTED STATES ERR: `Fixture::table` keys rows by the indexed
/// column, so the `u64`-keyed `character` index is never registered; an
/// unregistered index yields no rows in this host, so the character lookup finds
/// nothing and the reducer stops ONE guard past the gate — well before the NPC
/// lookup, the dialogue-tree read, the auto-effects and the quest trigger. Every
/// write syscall ABORTS the process, which is why this test asserts refusals and
/// admissions and nothing deeper.
///
/// RED AT HEAD on the `PendingDeletion` state: with no gate the reducer returns
/// the ordinary next-guard error there.
///
/// kills: M2 (the dropped `talk` gate) · M5 (a discarded verdict) · M8 (an
/// unreachable placement) · M11 (a constant reject in `guards` — the three
/// admitted states) · M12 (inverted polarity, invisible to every source pin in
/// this slice) · a row-EXISTS-keyed fake (the `Active` state) · a TABLE-WIDE or
/// any-row-pending fake (the three admitted states, while the stranger is
/// mid-grace) · a latched or memoised answer (the removed-row state). It ALSO
/// kills a gate wired into `advance_dialogue` only.
#[test]
fn rb80_talk_is_refused_only_while_the_caller_is_deletion_gated() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    rb80_seed_player(&fx, me);

    let call = || crate::npc::talk(&ctx, 1);
    rb80_assert_refused_only_while_gated("talk", &fx, &acct, me, &call, "character not found");
}

/// **E1 (behaviour)** — `advance_dialogue` refuses a deletion-gated caller,
/// ADMITS everybody else, and answers from the CALLER's own row.
///
/// The same five-state progression, with the caller's `player_conversation` row
/// seeded because Step 1's PK-scoped lookup sits ABOVE the gate: without it every
/// state would stop at "no active conversation" and the matrix would be vacuous
/// in both directions. A SEPARATE `#[test]` from `talk` on purpose — the two
/// reducers carry separate call sites, so one dropped gate must fail with a
/// message naming which.
///
/// RED AT HEAD on the `PendingDeletion` state.
///
/// kills: M3 (the dropped `advance_dialogue` gate) · M5 · M8 · M11 · M12 · a
/// row-EXISTS-keyed fake · a TABLE-WIDE or any-row-pending fake · a latched
/// answer · a gate wired into `talk` only.
#[test]
fn rb80_advance_dialogue_is_refused_only_while_the_caller_is_deletion_gated() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    rb80_seed_player(&fx, me);
    rb80_seed_conversation(&fx, me);

    let call = || crate::npc::advance_dialogue(&ctx, 0);
    rb80_assert_refused_only_while_gated(
        "advance_dialogue",
        &fx,
        &acct,
        me,
        &call,
        "character not found",
    );
}

/// Every `fn` name that carries a BARE reducer attribute in `squashed`, in file
/// order: after each attribute occurrence, skip to the next `fn` token and take
/// the identifier up to its opening paren.
///
/// A parse, not a needle list: the SET it returns is compared against the
/// hand-written roster, so a reducer ADDED to this file without a gate decision
/// reds the census instead of slipping in behind a per-name pin nobody wrote.
fn rb80_reducer_names(squashed: &str) -> Vec<String> {
    let attr = ["#[spacetimedb", "::reducer]"].concat();
    let fn_kw = ["f", "n"].concat();
    let lparen = char::from(0x28u8);
    let mut out: Vec<String> = Vec::new();
    for (at, _) in squashed.match_indices(attr.as_str()) {
        let rest = &squashed[at + attr.len()..];
        let Some(kw) = rest.find(fn_kw.as_str()) else {
            continue;
        };
        let after = &rest[kw + fn_kw.len()..];
        let Some(paren) = after.find(lparen) else {
            continue;
        };
        out.push(after[..paren].to_string());
    }
    out
}

/// **E1 (the second arm, mechanically)** — `npc.rs` carries EXACTLY TWO deletion
/// gates, its reducer roster is closed, it compiles unconditionally, its
/// ERASE-table write verbs are the ones this slice reasoned about, and
/// `dismiss_dialogue`'s whole body is frozen as the PRV1-10 classification it
/// claims to be.
///
/// `dismiss_dialogue` is CLASSIFIED OPEN (PRV1-10, ADR-0250
/// D5) because its whole body deletes only the caller's own transient
/// conversation row, and gating it once `talk` and `advance_dialogue` are gated
/// would STRAND that row for the rest of the grace window. The body freeze below
/// is what makes that an assertion instead of a snapshot: the moment the body
/// grows a second statement the classification has to be re-argued.
///
/// RED AT HEAD on clause `[rb80/file-count]`: the file mentions the wrapper ZERO
/// times.
///
/// kills: M19 (a gate quietly added to `dismiss_dialogue` — the file count goes
/// to 3) · a gate hoisted into `apply_effects_to_db` or `apply_quest_trigger`,
/// which take an owner identity and would fire twice per `talk` (same count) ·
/// M17 (a wire-name twin over an ungated fn while the gated Rust item is demoted
/// — the attribute counts disagree and the name SET changes) · M14 (a file-scope
/// `cfg(debug_assertions)` constant pair — clause E is body-scoped and cannot
/// see it) · M18 (a below-gate `if me != WILD { twin() } else { .. }` that
/// duplicates the grants — the write-verb census counts 3 `grant_item(` or 2
/// `grant_currency(`) · a `dismiss_dialogue` quietly grown into a second write
/// path (the body freeze).
#[test]
fn rb80_npc_reducer_roster_and_open_writers_are_pinned() {
    rb80_assert_scan_substrate(NPC_SOURCE);
    let squashed = rb80_squashed_file();

    // --- (a) the file-wide bare-name count ----------------------------------
    let bare = rb80_gate_bare_name();
    let n_bare = squashed.matches(bare.as_str()).count();
    assert_eq!(
        n_bare, 2,
        "rb-80 [rb80/file-count] E1 FAIL: `npc.rs` mentions the deletion-gate wrapper {n_bare} \
         time(s) by BARE NAME and must mention it EXACTLY twice — `talk`'s call and \
         `advance_dialogue`'s, and nothing else. ZERO IS THE RED STATE AT HEAD. THREE means \
         either `dismiss_dialogue` was gated without re-arguing its PRV1-10 classification (which \
         would strand the caller's conversation row for the rest of the grace window) or the gate \
         was hoisted into `apply_effects_to_db` / `apply_quest_trigger`, both of which take an \
         owner identity and would fire twice per `talk`. ONE means one of the two sites lost its \
         gate while the other kept it. The needle is the BARE name, so it also catches an alias, \
         a re-export and a function-pointer binding."
    );

    // --- (b0) the file's WHOLE attribute budget -----------------------------
    let attr_open = ["#", "["].concat();
    let n_attrs = squashed.matches(attr_open.as_str()).count();
    assert_eq!(
        n_attrs, 5,
        "rb-80 [rb80/attr-budget] E1 FAIL: `npc.rs` carries {n_attrs} attribute opener(s) and \
         must carry exactly FIVE. WHY A TOTAL AND NOT JUST THE ROSTER: the roster clauses below \
         key on the LITERAL `spacetimedb`-qualified attribute text, and four measured spellings \
         publish a client-callable reducer while counting ZERO there — the attribute imported by \
         name, the crate aliased on its `use` line, the attribute renamed inside a braced import, \
         and a NEIGHBOURING macro that is not `reducer` at all. Every one of them needs an \
         attribute opener, so a fourth dialogue entry point cannot be added without moving this \
         number. THE BUDGET IS FULLY ACCOUNTED, which is what stops it being balanced by a \
         deletion: one `cfg(test)` attribute (clause (c) pins that count exactly), three bare \
         reducer attributes (clause (b)), and the ONE `path` attribute that wires this test module \
         to its file — delete that and this census stops being compiled at all. GREEN AT HEAD and \
         after the fix: an anti-bypass clause, not part of this slice's RED."
    );

    // --- (b) the reducer roster is closed -----------------------------------
    let attr_bare = ["#[spacetimedb", "::reducer]"].concat();
    let attr_any = ["#[spacetimedb", "::reducer"].concat();
    let n_bare_attr = squashed.matches(attr_bare.as_str()).count();
    let n_any_attr = squashed.matches(attr_any.as_str()).count();

    // --- (b0b) the reducer macro is reached through the crate path, nowhere else
    let path_token = ["::red", "ucer"].concat();
    let n_path_token = squashed.matches(path_token.as_str()).count();
    assert_eq!(
        n_path_token, n_bare_attr,
        "rb-80 [rb80/attr-path] E1 FAIL: `npc.rs` spells the path-qualified reducer token \
         {n_path_token} time(s) while carrying {n_bare_attr} bare reducer attribute(s); the two \
         must AGREE. Every bare attribute contains this token, so the count can only ever be \
         GREATER — which means what this clause really asserts is that the file mentions the \
         reducer macro NOWHERE ELSE: not on a `use` line that imports it by name (then \
         `#[reducer]` publishes an entry point the roster clause below cannot see), and not \
         through an aliased crate path (`#[<alias>::reducer]`, same result). The braced-rename \
         and wrong-macro spellings leave this count alone and are caught by the attribute budget \
         above instead; the two clauses are a pair and neither is redundant. GREEN AT HEAD and \
         after the fix."
    );
    assert_eq!(
        n_any_attr, n_bare_attr,
        "rb-80 [rb80/roster] E1 FAIL: `npc.rs` carries {n_any_attr} reducer attribute(s) but only \
         {n_bare_attr} of them are the BARE form. A parameterised attribute is a WIRE-NAME twin: \
         it publishes a reducer under a name clients call while the Rust item every pin in this \
         slice reads is a different, possibly gated, function (rb-79 register row M13)."
    );
    assert_eq!(
        n_bare_attr, 3,
        "rb-80 [rb80/roster] E1 FAIL: `npc.rs` carries {n_bare_attr} bare reducer attribute(s) \
         and must carry 3. Reported BEFORE the name set because it is the clearer signal and \
         because it is not implied by it: the parse below SKIPS an attribute it cannot resolve to \
         a declaration, so a fourth reducer written in a shape the parser walks past would leave \
         the set equal to the roster while the file published one more."
    );
    let mut got = rb80_reducer_names(squashed.as_str());
    got.sort();
    let mut want_names = vec![
        ["ta", "lk"].concat(),
        ["advance_", "dialogue"].concat(),
        ["dismiss_", "dialogue"].concat(),
    ];
    want_names.sort();
    assert_eq!(
        got, want_names,
        "rb-80 [rb80/roster] E1 FAIL: the reducers `npc.rs` publishes are {got:?} and the roster \
         this slice reasoned about is {want_names:?}. A reducer ADDED here is an ERASE-table \
         writer nobody made a gate decision about; a reducer REMOVED makes the pin that names it \
         vacuous. Both are re-derived from §4.7's trigger predicate and ADR-0250, never by \
         editing this list to match the file."
    );

    // --- (c) the file compiles unconditionally ------------------------------
    let cfg_attr = ["#", "[cfg"].concat();
    let cfg_macro = ["cfg", "!("].concat();
    let debug_flag = ["debug_", "assertions"].concat();
    let arch_flag = ["target_", "arch"].concat();
    for (needle, want, why) in [
        (
            cfg_attr.as_str(),
            1usize,
            "the ONE `cfg(test)` attribute on the child test module (:503) and nothing else. A \
             second is a conditional-compilation switch on production code, which is how a gate \
             becomes present in review and absent in the published wasm",
        ),
        (
            cfg_macro.as_str(),
            0usize,
            "the expression form of the same defect, which clause C would report only as a \
             nested block",
        ),
        (
            debug_flag.as_str(),
            0usize,
            "the measured file-scope constant pair (rb-46 clause I's second survivor): tests \
             build with debug assertions on, the shipped wasm is `--release`, so a constant \
             consulted above or below a gate is true here and false in production",
        ),
        (
            arch_flag.as_str(),
            0usize,
            "the cross-target twin of the same shape — a body selected for wasm32 that the \
             native test binary never compiles (the class ADR-0247 closes for `lib.rs`)",
        ),
    ] {
        let n = squashed.matches(needle).count();
        assert_eq!(
            n, want,
            "rb-80 [rb80/cfg-census] E1 FAIL: `npc.rs` contains `{needle}` {n} time(s) and must \
             contain {want} — {why}. Green at HEAD; keep it that way."
        );
    }

    // --- (d) the ERASE-table write verbs ------------------------------------
    for (needle, want, why) in [
        (
            concat!("grant_", "item("),
            2usize,
            "exactly two item grants — the dialogue `GrantItem` effect (npc.rs:140) and the quest \
             reward loop (:215). A third is the below-gate delegation shape: a twin that repeats \
             the grant for every caller the gate would have refused",
        ),
        (
            concat!("grant_", "currency("),
            1usize,
            "ONE currency grant, the `QuestComplete` reward (:217) — the `player_wallet` write \
             that makes `talk` a §4.7 trigger site at all",
        ),
        (
            concat!("apply_effects", "_to_db("),
            3usize,
            "the declaration (:114) plus exactly two call sites, `talk` (:289) and \
             `advance_dialogue` (:392). A fourth call site is an effects router reached from a \
             body no gate pin covers. HONEST LIMIT: this number folds the declaration in with \
             both calls, so a call MOVED from a gated body into a below-gate helper leaves it at \
             three — which is why each gated body ALSO pins its own `apply_effects_to_db(` at \
             exactly once, ordered after the gate",
        ),
        (
            concat!("apply_quest", "_trigger("),
            2usize,
            "the declaration (:154) plus EXACTLY ONE call site, `talk` (:308). This count is the \
             measured finding ADR-0250 D2 rests on: a second call site would mean the quest \
             turn-in grants can also be reached from a reducer this slice did not gate",
        ),
    ] {
        let n = squashed.matches(needle).count();
        assert_eq!(
            n, want,
            "rb-80 [rb80/write-census] E1 FAIL: `npc.rs` calls `{needle}` {n} time(s) and must \
             call it {want} — {why}. This census is what kills the in-file ungated twin: every \
             clause of the source pins above is scoped to ONE body, so a duplicated write in a \
             second function is invisible to all of them."
        );
    }

    // --- (e) dismiss_dialogue stays the PRV1-10 classification it claims ----
    let dismiss = ["dismiss_", "dialogue"].concat();
    let dismiss_body = rb80_scan_body(dismiss.as_str());
    let expected_dismiss = [
        concat!("ctx.db.player_conver", "sation()"),
        concat!(".owner_ide", "ntity()"),
        concat!(".del", "ete(ctx.sen", "der());"),
        concat!("Ok(", "())"),
    ]
    .concat();
    assert_eq!(
        dismiss_body, expected_dismiss,
        "rb-80 [rb80/open-body] E1 FAIL (the deliberate classification): `dismiss_dialogue`'s \
         whole squashed body is {dismiss_body:?} and the body ADR-0250 D5 classified OPEN is \
         {expected_dismiss:?}. The classification is an ASSERTION, not a snapshot: the reducer is \
         left ungated ONLY because its entire body is one PK point delete of the caller's own \
         transient conversation row, which unwinds an existing interaction (PRV1-10) and whose \
         gating would STRAND that row for the rest of the grace window once `talk` and \
         `advance_dialogue` refuse to replace it. The moment this body grows a second statement — \
         any read of another table, any grant, any second delete — that argument stops holding \
         and the classification must be re-argued in a new ADR, not repaired by re-freezing this \
         literal."
    );
}
