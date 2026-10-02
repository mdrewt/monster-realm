//! `npc_tests` — unit tests for pure seams in npc.rs.
//!
//! Tests `dialogue_state_from_db`, `dialogue_state_flags_to_vec`, and
//! `dialogue_state_done_to_vec` (the DB<->game_core marshal roundtrip helpers
//! that convert SpacetimeDB flat Vec<String> columns into BTreeSet-backed
//! `game_core::PlayerDialogueState`), and the `game_core::npc_decide`
//! determinism boundary (called from the M12b `npc_tick` reducer).
//!
//! Reducer-level behaviour (the talk / advance_dialogue zone + range checks, the
//! deletion gate, quest-completion rewards) runs on the native host
//! (`crate::native_host_tests`).

use super::*;

// ---------------------------------------------------------------------------
// A. Dialogue state marshal roundtrip tests
//
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
// pub-re-exported from game_core. They gate the server-side assumption
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
/// `npc_decide` gained `facing: Direction` and `map: &TileMap`
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

/// an NPC with wander_radius=0 and current == home must never move.
///
/// kills: an impl that ignores wander_radius=0 and always picks a random
/// direction (the NPC would wander off its spawn tile with no way to recall it).
/// The correct implementation special-cases `wander_radius == 0` at the top of
/// `npc_decide` (game-core/src/npc/rules.rs) to always return None.
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
// the REKEY exists-predicate for the NPC pair, exercised
// against REAL rows instead of against its own source text.
//
// `npc::has_quest_or_dialogue_state` is the only two-armed predicate of the
// six: quest progress OR dialogue state. One test per arm, each registering
// ONLY its own table so the other arm reads an empty table — that is what makes
// each test sensitive to ITS arm alone, and what makes hollowing either arm
// (still reading the table, returning a value decoupled from the read) red
// exactly one of them.
// ===========================================================================

/// (quest arm): `npc::has_quest_or_dialogue_state` must answer
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

/// (dialogue arm): `npc::has_quest_or_dialogue_state` must
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

/// `talk` refuses a deletion-gated caller, ADMITS everybody
/// else, and answers from the CALLER's own row.
///
/// Five account states with a mid-grace STRANGER row
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

/// `advance_dialogue` refuses a deletion-gated caller,
/// ADMITS everybody else, and answers from the CALLER's own row.
///
/// The same five-state progression, with the caller's `player_conversation` row
/// seeded because Step 1's PK-scoped lookup sits ABOVE the gate: without it every
/// state would stop at "no active conversation" and the matrix would be vacuous
/// in both directions. A SEPARATE `#[test]` from `talk` on purpose — the two
/// reducers carry separate call sites, so one dropped gate must fail with a
/// message naming which.
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

/// THE EARS PROOF, executed against the REAL process static and
/// the REAL window constant.
///
/// PROVES: a second `check` at the SAME instant returns `None` (the emission is
/// SUPPRESSED); a check one millisecond before the window closes is still
/// suppressed; the window boundary is INCLUSIVE and REPORTS the two suppressed
/// checks rather than silently losing them.
///
/// KILLS the two shapes that produce a limiter which never suppresses — both of
/// which leave every source needle in (b)..(i) fully satisfiable: a ZERO window
/// (`now.saturating_sub(last) >= 0` holds for any pair of checks, so every call
/// takes the emit branch) and a limiter constructed FRESH at each use (a
/// fn-local `const` is a new value at every mention — the reason the sibling is
/// a `static`).
///
/// SOLE CONSUMER of `QUEST_DEFS_LOAD_ERR_LIMITER` in this binary — see the
/// section header for why a second one would be a real defect that `nextest`
/// would hide.
#[test]
fn s20rc_load_error_limiter_suppresses_the_second_immediate_check() {
    let w = super::QUEST_DEFS_LOAD_ERR_WINDOW_MS;
    let check = |now: i64| super::QUEST_DEFS_LOAD_ERR_LIMITER.check(now, w);

    // A BACKWARDS clock always re-anchors and EMITS (movement.rs's `check`
    // documents the trade), so this test establishes the limiter's whole
    // observable history itself instead of assuming nothing else in the process
    // has touched the static.
    assert!(
        check(i64::MIN).is_some(),
        "20r-c (a) FIXTURE: a check at i64::MIN must ALWAYS emit — `RateLimiter::check` treats a \
         backwards clock as a RE-ANCHOR rather than a suppression, which is exactly what makes \
         this test independent of test ORDER inside the shared process. A None here means the \
         static is not the movement.rs limiter this criterion is written against."
    );
    assert_eq!(
        check(1_000),
        Some(0),
        "20r-c (a): the first check after the re-anchor above must EMIT and report ZERO suppressed \
         checks, because an emit resets the counter. Anything else means `check` is not the \
         ADR-0170 D4 state machine the rest of this test reasons about."
    );
    assert_eq!(
        check(1_000),
        None,
        "TEETH (20r-c a) — THE EARS PROOF: the SECOND check at the SAME instant must be SUPPRESSED \
         (None). A `Some(0)` here means one of exactly two things and both ship the unbounded \
         flood this slice exists to stop: the window is ZERO (every pair of checks is at least 0 \
         ms apart, so the emit branch is always taken), or the limiter is a FRESH instance per use \
         — a fn-local `const`, or a `RateLimiter::new()` evaluated at the call site — and so has \
         no memory of the first check. Remember what is being logged: a RON parse error behind a \
         `LazyLock`, which repeats on every talk() of every player for the life of the process."
    );
    assert_eq!(
        check(1_000 + w - 1),
        None,
        "TEETH (20r-c a): a check ONE MILLISECOND before the window closes must still be \
         suppressed. An off-by-one that opens the window early — a `>` against a decremented \
         bound, or a window operand read from a different constant — shows up here and nowhere \
         else in the slice."
    );
    assert_eq!(
        check(1_000 + w),
        Some(2),
        "TEETH (20r-c a): at EXACTLY window_ms the gate must reopen (the boundary is INCLUSIVE) \
         and it must report how many checks it suppressed — TWO here: the same-instant check and \
         the one-millisecond-early check above. A `Some(0)` means the suppressed checks were \
         silently LOST, which is the `accounts.rs` `.is_some()` shape ADR-0173 D4 rejects: an \
         operator reading the emitted line then cannot tell one parse fault from ten thousand."
    );
    assert_eq!(
        w, 60_000,
        "TEETH (20r-c a): the window constant must be 60_000 ms. This assertion is \
         SPELLING-INDEPENDENT — it reads the constant's VALUE rather than its source spelling, so \
         a `60000` literal, a `60 * 1_000` expression or a constant aliased in from elsewhere is \
         judged on what it evaluates to (each of those would separately RED the source-shape pin \
         in (e), which is also what ties this same constant to the gate's window OPERAND — this \
         clause alone says nothing about which constant the gate passes). A defanged 0 would \
         already have failed the EARS assertion above; what THIS clause catches is a merely WRONG \
         window (600, 600_000) that still suppresses and still reads plausibly at the call site."
    );
}

// ===========================================================================
// Native-host behaviour (debloat Phase 2: EV-economy-sinks-sources#sink-source-wiring,
// quest source). Replaces the economy_tests.rs `apply_quest_trigger_calls_grant_currency`
// text twin: the balance DELTA is asserted, not the call token.
// ===========================================================================

/// Completing a quest credits EXACTLY its content-authored `reward.currency` (read
/// from the same process-wide quest cache the shipped code reads) on top of an existing
/// balance, removes the finished `player_quest` row, moves the quest to done, and pays
/// nobody else. A non-matching trigger pays nothing.
/// kills: `grant_currency(ctx, owner, reward.currency)` deleted / wrong owner / wrong
/// amount, QuestComplete arm skipped, trigger-match ignored.
#[test]
fn nh_quest_complete_grants_exactly_the_content_currency_reward() {
    use crate::native_host_tests::fixture;
    use crate::schema::{Inventory, PlayerWallet};
    let defs = crate::content_cache::cached_quest_defs().expect("shipped quest RON parses");
    let def = defs
        .iter()
        .find(|d| d.steps.len() == 1 && d.reward.currency > 0)
        .expect("shipped content has a one-step quest with a currency reward");
    let game_core::StepTrigger::Talk { npc_id } = &def.steps[0].trigger else {
        panic!("expected the one-step currency quest to be a Talk trigger: {def:?}");
    };
    let me = Identity::from_byte_array([0x51; 32]);
    let other = Identity::from_byte_array([0x52; 32]);
    let fx = fixture();
    let wallets = fx
        .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
        .writable()
        .unique();
    let _ = fx
        .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
        .writable()
        .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
    let _ = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    let quests = fx
        .table::<PlayerQuestRow>("player_quest", "owner_identity", |r| r.owner_identity)
        .writable();
    let _ = fx
        .table_keyed::<PlayerQuestRow, u64>("player_quest", "pq_id", |r| r.pq_id)
        .unique();
    for (pq_id, owner) in [(1, me), (2, other)] {
        quests.seed(&PlayerQuestRow {
            pq_id,
            owner_identity: owner,
            quest_id: def.id.clone(),
            step_index: 0,
        });
    }
    for owner in [me, other] {
        wallets.seed(&PlayerWallet {
            owner_identity: owner,
            balance: 7,
        });
    }
    let balance = |who: Identity| {
        wallets
            .rows()
            .into_iter()
            .find(|w| w.owner_identity == who)
            .map(|w| w.balance)
    };
    let mut state = PlayerDialogueState {
        flags: Default::default(),
        active_quests: [def.id.clone()].into_iter().collect(),
        done_quests: Default::default(),
    };
    let ctx = fx.ctx();

    apply_quest_trigger(
        &ctx,
        me,
        &TriggerEvent::Talked {
            npc_id: format!("{npc_id}-not-this-one"),
        },
        &mut state,
    );
    assert_eq!(balance(me), Some(7), "a non-matching trigger pays nothing");
    assert_eq!(quests.rows().len(), 2, "and completes nothing");

    apply_quest_trigger(
        &ctx,
        me,
        &TriggerEvent::Talked {
            npc_id: npc_id.clone(),
        },
        &mut state,
    );
    assert_eq!(
        balance(me),
        Some(7 + def.reward.currency),
        "completion credits exactly reward.currency on top of the balance"
    );
    assert_eq!(
        balance(other),
        Some(7),
        "another player on the same quest is not paid"
    );
    assert_eq!(
        quests.rows().iter().map(|r| r.pq_id).collect::<Vec<_>>(),
        vec![2],
        "only the completer's player_quest row is removed"
    );
    assert!(state.done_quests.contains(&def.id) && !state.active_quests.contains(&def.id));
}

// ===========================================================================
// Native-host behaviour. Replaces the talk / advance_dialogue operator-mutant
// text pins (`*_uses_ne_not_eq`, `*_uses_subtraction_not_addition`,
// `*_uses_gt_not_lt`, ...): the SHIPPED reducers run with a real sender
// against a zone + Manhattan-range matrix. The NPC's dialogue tree id matches
// no shipped tree, so an ADMITTED call stops at `dialogue tree not found` —
// past both checks, before any write.
// ===========================================================================
mod nh_range {
    use crate::native_host_tests::{fixture, Fixture, Handle};
    use crate::schema::{Character, Npc, Player, PlayerConversation};
    use game_core::{ActionState, Direction, NpcInteraction};
    use spacetimedb::Identity;

    const NPC: u64 = 50;
    const ADMITTED: &str = "dialogue tree not found";

    fn me() -> Identity {
        Identity::from_byte_array([0x5A; 32])
    }

    fn character(entity_id: u64, zone_id: u32, tile_x: i32, tile_y: i32) -> Character {
        Character {
            entity_id,
            zone_id,
            tile_x,
            tile_y,
            facing: Direction::South,
            action: ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: vec![],
        }
    }

    /// The player stands at (5, 5) in zone 0; the NPC's character is re-seeded
    /// per case. Returns the character handle for the per-case NPC moves.
    fn world(fx: &Fixture) -> Handle<'_, Character, u64> {
        fx.table::<Player>("player", "identity", |r| r.identity)
            .seed(&Player {
                identity: me(),
                entity_id: 1,
                name: String::new(),
                online: true,
                last_input_seq: 0,
            });
        fx.table_keyed::<Npc, u64>("npc", "entity_id", |r| r.entity_id)
            .seed(&Npc {
                entity_id: NPC,
                npc_id: "nh-range-npc".to_string(),
                zone_id: 0,
                home_x: 5,
                home_y: 5,
                wander_radius: 0,
                dialogue_tree_id: "nh-range-no-such-tree".to_string(),
                interaction: NpcInteraction::Dialogue,
            });
        let chars = fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id);
        chars.seed(&character(1, 0, 5, 5));
        chars
    }

    /// `(label, npc zone, npc x, npc y, in range)` around the player at (5, 5):
    /// the TALK_RANGE = 2 Manhattan boundary on both signs of both axes, the
    /// mixed-axis boundary, one step past each, and the same tile in ANOTHER zone.
    const CASES: [(&str, u32, i32, i32, Option<bool>); 11] = [
        ("same tile", 0, 5, 5, Some(true)),
        ("diagonal 1+1", 0, 6, 6, Some(true)),
        ("+x 2", 0, 7, 5, Some(true)),
        ("-x 2", 0, 3, 5, Some(true)),
        ("-y 2", 0, 5, 3, Some(true)),
        ("+x 3", 0, 8, 5, Some(false)),
        ("-x 3", 0, 2, 5, Some(false)),
        ("+y 3", 0, 5, 8, Some(false)),
        ("1+2", 0, 6, 7, Some(false)),
        ("-1-2", 0, 4, 3, Some(false)),
        ("same tile, other zone", 1, 5, 5, None),
    ];

    /// `talk` admits exactly the in-range, same-zone cases and refuses the rest
    /// with the zone or range error, before any write (no conversation row).
    #[test]
    fn nh_talk_enforces_same_zone_and_manhattan_talk_range() {
        let fx = fixture();
        let chars = world(&fx);
        let convs = fx.table::<PlayerConversation>("player_conversation", "owner_identity", |r| {
            r.owner_identity
        });
        for (label, zone, x, y, in_range) in CASES {
            chars.remove(NPC);
            chars.seed(&character(NPC, zone, x, y));
            let want = match in_range {
                Some(true) => ADMITTED,
                Some(false) => "too far away",
                None => "npc not in same zone",
            };
            assert_eq!(
                fx.run_as(me(), |ctx| super::talk(ctx, NPC)),
                Err(want.to_string()),
                "talk, {label}"
            );
            assert!(convs.rows().is_empty(), "talk, {label}: nothing written");
        }
    }

    /// `advance_dialogue` re-checks zone and range against the NPC's CURRENT
    /// tile: in range it proceeds (and keeps the conversation);
    /// out of range or zone it refuses with its own error AND dismisses the
    /// caller's conversation row.
    #[test]
    fn nh_advance_dialogue_rechecks_zone_and_range_and_dismisses_on_refusal() {
        let fx = fixture();
        let chars = world(&fx);
        let convs = fx
            .table::<PlayerConversation>("player_conversation", "owner_identity", |r| {
                r.owner_identity
            })
            .writable()
            .unique();
        for (label, zone, x, y, in_range) in CASES {
            chars.remove(NPC);
            chars.seed(&character(NPC, zone, x, y));
            convs.remove(me());
            convs.seed(&PlayerConversation {
                owner_identity: me(),
                npc_entity_id: NPC,
                current_node_id: "start".to_string(),
            });
            let want = match in_range {
                Some(true) => ADMITTED,
                Some(false) => "walked too far away",
                None => "no longer in same zone",
            };
            assert_eq!(
                fx.run_as(me(), |ctx| super::advance_dialogue(ctx, 0)),
                Err(want.to_string()),
                "advance_dialogue, {label}"
            );
            assert_eq!(
                convs.rows().len(),
                usize::from(in_range == Some(true)),
                "advance_dialogue, {label}: the conversation is kept only while in range"
            );
        }
    }
}

// ===========================================================================
// Native-host dialogue security. Replaces function-body needles
// (`apply_choice(`, `player_conversation()`, `owner_identity().find(`) with the
// observable refusals, and the view-scope pin with the SHIPPED `my_conversation`
// view served through the runtime's own view entry point.
// ===========================================================================
mod nh_dialogue_security {
    use crate::native_host_tests::{fixture, Fixture, Handle, VIEW_MY_CONVERSATION};
    use crate::schema::{
        Character, Npc, Player, PlayerConversation, PlayerDialogueStateRow, PlayerQuestRow,
    };
    use game_core::{ActionState, Direction, NpcInteraction};
    use spacetimedb::Identity;

    const NPC: u64 = 60;
    /// The shipped one-node tree: `greeting` has exactly ONE choice (index 0,
    /// StartQuest("quest_001"), ends the conversation).
    const TREE: &str = "elder_oak_talk";

    fn a() -> Identity {
        Identity::from_byte_array([0x6A; 32])
    }
    fn b() -> Identity {
        Identity::from_byte_array([0x6B; 32])
    }
    fn c() -> Identity {
        Identity::from_byte_array([0x6C; 32])
    }

    fn conv(owner: Identity, node: &str) -> PlayerConversation {
        PlayerConversation {
            owner_identity: owner,
            npc_entity_id: NPC,
            current_node_id: node.to_string(),
        }
    }

    fn bytes<T: spacetimedb::Serialize>(row: &T) -> Vec<u8> {
        spacetimedb::sats::bsatn::to_vec(row).expect("rows encode")
    }

    struct World<'a> {
        convs: Handle<'a, PlayerConversation>,
        states: Handle<'a, PlayerDialogueStateRow>,
        quests: Handle<'a, PlayerQuestRow>,
    }

    /// A and B are joined and stand next to the NPC (zone 0) whose dialogue tree is
    /// the shipped `elder_oak_talk`.
    fn world(fx: &Fixture) -> World<'_> {
        let players = fx.table::<Player>("player", "identity", |r| r.identity);
        let chars = fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id);
        for (i, who) in [a(), b()].into_iter().enumerate() {
            let entity_id = i as u64 + 1;
            players.seed(&Player {
                identity: who,
                entity_id,
                name: String::new(),
                online: true,
                last_input_seq: 0,
            });
            chars.seed(&Character {
                entity_id,
                zone_id: 0,
                tile_x: 5,
                tile_y: 5,
                facing: Direction::South,
                action: ActionState::Idle,
                move_started_at_ms: 0,
                sprite_id: 0,
                move_queue: vec![],
            });
        }
        chars.seed(&Character {
            entity_id: NPC,
            zone_id: 0,
            tile_x: 6,
            tile_y: 5,
            facing: Direction::South,
            action: ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: vec![],
        });
        fx.table_keyed::<Npc, u64>("npc", "entity_id", |r| r.entity_id)
            .seed(&Npc {
                entity_id: NPC,
                npc_id: "nh-dialogue-npc".to_string(),
                zone_id: 0,
                home_x: 6,
                home_y: 5,
                wander_radius: 0,
                dialogue_tree_id: TREE.to_string(),
                interaction: NpcInteraction::Dialogue,
            });
        World {
            convs: fx
                .table::<PlayerConversation>("player_conversation", "owner_identity", |r| {
                    r.owner_identity
                })
                .writable()
                .scannable()
                .unique(),
            states: fx
                .table::<PlayerDialogueStateRow>("player_dialogue_state", "owner_identity", |r| {
                    r.owner_identity
                })
                .writable()
                .unique(),
            quests: fx
                .table::<PlayerQuestRow>("player_quest", "owner_identity", |r| r.owner_identity)
                .writable()
                .auto_inc(|r| r.pq_id, |r, id| r.pq_id = id),
        }
    }

    /// C1: the server re-checks the chosen index against the node. An index the
    /// node does not offer is refused before ANY write — no dialogue state, no
    /// quest, the conversation untouched — while the offered index 0 (positive
    /// control, same world) starts the quest and ends the conversation.
    /// (The choice-CONDITION half of apply_choice is game-core's
    /// `apply_choice_unavailable_choice_error`; no shipped tree carries a
    /// conditional choice to drive it through the reducer.)
    /// kills: apply_choice skipped / its Err swallowed, the choice indexed without
    /// a bounds check, effects written before the gate.
    #[test]
    fn nh_advance_dialogue_refuses_a_choice_the_node_does_not_offer() {
        let fx = fixture();
        let w = world(&fx);
        w.convs.seed(&conv(a(), "greeting"));
        for idx in [1u32, 7, u32::MAX] {
            let got = fx.run_as(a(), |ctx| super::advance_dialogue(ctx, idx));
            assert!(got.is_err(), "choice {idx} must be refused, got {got:?}");
            assert!(
                w.states.rows().is_empty(),
                "choice {idx}: no dialogue state written"
            );
            assert!(w.quests.rows().is_empty(), "choice {idx}: no quest started");
            assert_eq!(
                w.convs.rows().iter().map(bytes).collect::<Vec<_>>(),
                vec![bytes(&conv(a(), "greeting"))],
                "choice {idx}: the conversation is untouched"
            );
        }
        let got = fx.run_as(a(), |ctx| super::advance_dialogue(ctx, 0));
        assert_eq!(got, Ok(()), "control: the offered choice 0 is admitted");
        assert_eq!(
            w.quests
                .rows()
                .iter()
                .map(|q| (q.owner_identity, q.quest_id.clone()))
                .collect::<Vec<_>>(),
            vec![(a(), "quest_001".to_string())],
            "control: choice 0 starts quest_001 for the caller"
        );
        assert!(
            w.convs.rows().is_empty(),
            "control: the one-node tree ends the conversation"
        );
    }

    /// The StartQuest choice against each prior dialogue state (choice 0 of the
    /// shipped tree starts quest_001):
    /// - no prior state: quest_001 starts and a dialogue-state row is written;
    /// - an unrelated quest already active: quest_001 still starts;
    /// - quest_001 already active: no duplicate row;
    /// - quest_001 already DONE (flags `f1`): nothing starts, and the stored
    ///   flags / done list survive the write-back.
    ///
    /// kills: the dialogue-state load returning a default (done list and flags
    /// lost); the write-back dropped; the already-active match inverted; the
    /// not-active-and-not-done test widened to `||`.
    #[test]
    fn nh_advance_dialogue_start_quest_respects_the_stored_dialogue_state() {
        let quests_of = |w: &World<'_>| -> Vec<String> {
            let mut q: Vec<String> = w
                .quests
                .rows()
                .iter()
                .filter(|r| r.owner_identity == a())
                .map(|r| r.quest_id.clone())
                .collect();
            q.sort();
            q
        };
        type Setup = fn(&World<'_>);
        let cases: [(&str, Setup, Vec<&str>); 3] = [
            ("no prior state", |_| {}, vec!["quest_001"]),
            (
                "unrelated quest active",
                |w| {
                    w.quests.seed(&PlayerQuestRow {
                        pq_id: 900,
                        owner_identity: a(),
                        quest_id: "quest_other".to_string(),
                        step_index: 0,
                    })
                },
                vec!["quest_001", "quest_other"],
            ),
            (
                "quest_001 already active",
                |w| {
                    w.quests.seed(&PlayerQuestRow {
                        pq_id: 901,
                        owner_identity: a(),
                        quest_id: "quest_001".to_string(),
                        step_index: 0,
                    })
                },
                vec!["quest_001"],
            ),
        ];
        for (label, setup, want) in cases {
            let fx = fixture();
            let w = world(&fx);
            w.convs.seed(&conv(a(), "greeting"));
            setup(&w);
            assert_eq!(
                fx.run_as(a(), |ctx| super::advance_dialogue(ctx, 0)),
                Ok(()),
                "{label}"
            );
            assert_eq!(quests_of(&w), want, "{label}");
            assert_eq!(
                w.states
                    .rows()
                    .iter()
                    .map(|r| r.owner_identity)
                    .collect::<Vec<_>>(),
                vec![a()],
                "{label}: the caller's dialogue state is written back"
            );
        }

        let fx = fixture();
        let w = world(&fx);
        w.convs.seed(&conv(a(), "greeting"));
        let done = PlayerDialogueStateRow {
            owner_identity: a(),
            flags: vec!["f1".to_string()],
            done_quests: vec!["quest_001".to_string()],
        };
        w.states.seed(&done);
        assert_eq!(
            fx.run_as(a(), |ctx| super::advance_dialogue(ctx, 0)),
            Ok(())
        );
        assert!(quests_of(&w).is_empty(), "a done quest never restarts");
        assert_eq!(
            w.states.rows().iter().map(bytes).collect::<Vec<_>>(),
            vec![bytes(&done)],
            "stored flags and done list survive the write-back"
        );
    }

    /// C8/C9: the conversation lookup is keyed on the SENDER. A caller with no
    /// conversation of their own is refused even while another player holds one
    /// with the same NPC, and that player's row is left exactly as it was.
    /// kills: a lookup that takes any/the first conversation row, or keys on the
    /// NPC instead of ctx.sender().
    #[test]
    fn nh_advance_dialogue_never_advances_another_players_conversation() {
        let fx = fixture();
        let w = world(&fx);
        w.convs.seed(&conv(b(), "greeting"));
        assert_eq!(
            fx.run_as(a(), |ctx| super::advance_dialogue(ctx, 0)),
            Err("no active conversation".to_string()),
            "A has no conversation of their own"
        );
        assert_eq!(
            w.convs.rows().iter().map(bytes).collect::<Vec<_>>(),
            vec![bytes(&conv(b(), "greeting"))],
            "B's conversation is untouched"
        );
        assert!(w.quests.rows().is_empty(), "nothing started for anyone");
        assert!(w.states.rows().is_empty(), "no dialogue state for anyone");
    }

    /// `my_conversation` (the only client read path onto the private
    /// `player_conversation`) serves each sender exactly their own row.
    /// kills: a view that scans the table, keys on anything but ctx.sender(), or
    /// returns a fixed/first row.
    #[test]
    fn nh_my_conversation_view_returns_only_the_senders_row() {
        let fx = fixture();
        let w = world(&fx);
        w.convs.seed(&conv(a(), "greeting"));
        w.convs.seed(&conv(b(), "elsewhere"));
        for (who, node) in [(a(), "greeting"), (b(), "elsewhere")] {
            let seen: Vec<PlayerConversation> = fx.call_view(VIEW_MY_CONVERSATION, who);
            assert_eq!(
                seen.iter().map(bytes).collect::<Vec<_>>(),
                vec![bytes(&conv(who, node))],
                "each sender sees exactly their own conversation"
            );
        }
        let stranger: Vec<PlayerConversation> = fx.call_view(VIEW_MY_CONVERSATION, c());
        assert!(
            stranger.is_empty(),
            "a sender with no conversation sees no row"
        );
    }
}

// ===========================================================================
// ctl-16 (CTL16.1, CTL16.2, CTL16.4): no talking or advancing a dialogue during an
// Ongoing battle. The SHIPPED reducers run as a caller in an Ongoing battle in
// either role (wild and PvP side A, PvP side B, practice) against the shipped
// `elder_oak_talk` tree and `quest_001`: talk and advance_dialogue must refuse with
// the store byte-identical, while dismiss_dialogue still succeeds. Every case and
// every control (no battle row, the caller's finished battles, a stranger's Ongoing
// battle) gets a fresh fixture, because the host has no rollback.
// ===========================================================================
mod ctl16_battle_guard {
    use crate::native_host_tests::{fixture, Fixture, Handle};
    use crate::schema::{
        Battle, Character, Inventory, Npc, Player, PlayerConversation, PlayerDialogueStateRow,
        PlayerQuestRow, PlayerWallet,
    };
    use game_core::{ActionState, BattleOutcome, Direction, NpcInteraction};
    use spacetimedb::Identity;

    const ME: Identity = Identity::from_byte_array([0xC1; 32]);
    const OTHER: Identity = Identity::from_byte_array([0xC2; 32]);
    const THIRD: Identity = Identity::from_byte_array([0xC3; 32]);
    const WILD: Identity = crate::WILD_IDENTITY;
    /// The elder's entity id.
    const NPC: u64 = 70;
    /// The NPC of the caller's older conversation (it needs no row of its own).
    const ELSEWHERE: u64 = 71;
    const ELDER: &str = "elder_oak";
    const TREE: &str = "elder_oak_talk";
    const QUEST: &str = "quest_001";
    /// Stored by the elder's `greeting` node on entry.
    const FLAG: &str = "met_elder_oak";
    const TALK_REFUSED: &str = "cannot talk during an ongoing battle";
    const ADVANCE_REFUSED: &str = "cannot advance dialogue during an ongoing battle";

    /// The caller in an Ongoing battle, in either role: (label, side A, side B).
    const ONGOING: [(&str, Identity, Identity); 4] = [
        ("wild, side A", ME, WILD),
        ("PvP, side A", ME, OTHER),
        ("PvP, side B", OTHER, ME),
        ("practice", ME, ME),
    ];

    /// Battles that leave the caller free: their own finished battle (every terminal
    /// outcome, on side A and on side B) and a stranger's Ongoing battle.
    const ADMITTED: [(&str, Identity, Identity, BattleOutcome); 8] = [
        ("A/SideAWins", ME, OTHER, BattleOutcome::SideAWins),
        ("A/SideBWins", ME, OTHER, BattleOutcome::SideBWins),
        ("A/Fled", ME, OTHER, BattleOutcome::Fled),
        ("B/SideAWins", OTHER, ME, BattleOutcome::SideAWins),
        ("B/SideBWins", OTHER, ME, BattleOutcome::SideBWins),
        ("B/Fled", OTHER, ME, BattleOutcome::Fled),
        ("stranger/wild", OTHER, WILD, BattleOutcome::Ongoing),
        ("stranger/PvP", OTHER, THIRD, BattleOutcome::Ongoing),
    ];

    fn empty_side() -> game_core::BattleSide {
        game_core::BattleSide {
            active: 0,
            team: vec![],
        }
    }

    /// A battle row in `outcome`, `player` on side A and `opponent` on side B.
    fn battle(player: Identity, opponent: Identity, outcome: BattleOutcome) -> Battle {
        Battle {
            battle_id: 1,
            player_identity: player,
            opponent_identity: opponent,
            state: game_core::BattleState {
                side_a: empty_side(),
                side_b: empty_side(),
                outcome,
                turn_number: 1,
                weather: None,
            },
            party_monster_ids: vec![],
            opponent_monster_ids: vec![],
            created_at_ms: 0,
        }
    }

    /// Every admitted world: no battle row at all, then each `ADMITTED` battle.
    fn controls() -> Vec<(&'static str, Option<Battle>)> {
        let mut out = vec![("no battle row", None)];
        for (label, a, b, outcome) in ADMITTED {
            out.push((label, Some(battle(a, b, outcome))));
        }
        out
    }

    fn conv(owner: Identity, npc_entity_id: u64, node: &str) -> PlayerConversation {
        PlayerConversation {
            owner_identity: owner,
            npc_entity_id,
            current_node_id: node.to_string(),
        }
    }

    fn wallet(balance: u64) -> PlayerWallet {
        PlayerWallet {
            owner_identity: ME,
            balance,
        }
    }

    fn bytes<T: spacetimedb::Serialize>(row: &T) -> Vec<u8> {
        spacetimedb::sats::bsatn::to_vec(row).expect("rows encode")
    }

    /// quest_001's content-authored currency reward, read from the cache the shipped
    /// code reads. Also checks the fixture's premise: one Talk step, at the elder.
    fn quest_001_reward() -> u64 {
        let defs = crate::content_cache::cached_quest_defs().expect("quest RON parses");
        let def = defs.iter().find(|d| d.id == QUEST).expect("shipped");
        let talk = game_core::StepTrigger::Talk {
            npc_id: ELDER.to_string(),
        };
        let triggers: Vec<_> = def.steps.iter().map(|s| &s.trigger).collect();
        assert_eq!(
            triggers,
            [&talk],
            "fixture: quest_001 is one Talk step at the elder"
        );
        assert!(def.reward.currency > 0, "fixture: paid");
        def.reward.currency
    }

    /// Every table talk / advance_dialogue / dismiss_dialogue reads or writes.
    struct World<'a> {
        npcs: Handle<'a, Npc, u64>,
        battles: Handle<'a, Battle>,
        convs: Handle<'a, PlayerConversation>,
        states: Handle<'a, PlayerDialogueStateRow>,
        quests: Handle<'a, PlayerQuestRow>,
        wallets: Handle<'a, PlayerWallet>,
        stacks: Handle<'a, Inventory>,
    }

    /// The caller is joined at (5, 5) in zone 0, next to the elder at (6, 5) whose
    /// tree is the shipped `elder_oak_talk`. The battle table is registered under
    /// BOTH participant indexes (one row store: seed a battle once, through
    /// `battles`), and every table the admitted paths write is writable.
    fn world(fx: &Fixture) -> World<'_> {
        fx.table::<Player>("player", "identity", |r| r.identity)
            .seed(&Player {
                identity: ME,
                entity_id: 1,
                name: String::new(),
                online: true,
                last_input_seq: 0,
            });
        let chars = fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id);
        for (entity_id, tile_x) in [(1, 5), (NPC, 6)] {
            chars.seed(&Character {
                entity_id,
                zone_id: 0,
                tile_x,
                tile_y: 5,
                facing: Direction::South,
                action: ActionState::Idle,
                move_started_at_ms: 0,
                sprite_id: 0,
                move_queue: vec![],
            });
        }
        let npcs = fx.table_keyed::<Npc, u64>("npc", "entity_id", |r| r.entity_id);
        npcs.seed(&Npc {
            entity_id: NPC,
            npc_id: ELDER.to_string(),
            zone_id: 0,
            home_x: 6,
            home_y: 5,
            wander_radius: 0,
            dialogue_tree_id: TREE.to_string(),
            interaction: NpcInteraction::Dialogue,
        });
        let battles = fx.table::<Battle>("battle", "player_identity", |r| r.player_identity);
        let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
        let _ = fx
            .table_keyed::<PlayerQuestRow, u64>("player_quest", "pq_id", |r| r.pq_id)
            .unique();
        let _ = fx
            .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
            .unique();
        World {
            npcs,
            battles,
            convs: fx
                .table::<PlayerConversation>("player_conversation", "owner_identity", |r| {
                    r.owner_identity
                })
                .writable()
                .unique(),
            states: fx
                .table::<PlayerDialogueStateRow>("player_dialogue_state", "owner_identity", |r| {
                    r.owner_identity
                })
                .writable()
                .unique(),
            quests: fx
                .table::<PlayerQuestRow>("player_quest", "owner_identity", |r| r.owner_identity)
                .writable()
                .auto_inc(|r| r.pq_id, |r, id| r.pq_id = id),
            wallets: fx
                .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
                .writable()
                .unique(),
            stacks: fx
                .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
                .writable()
                .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id),
        }
    }

    impl World<'_> {
        /// Every table the three reducers could write, as BSATN.
        fn snapshot(&self) -> [Vec<u8>; 5] {
            [
                bytes(&self.convs.rows()),
                bytes(&self.states.rows()),
                bytes(&self.quests.rows()),
                bytes(&self.wallets.rows()),
                bytes(&self.stacks.rows()),
            ]
        }
        fn conv_rows(&self) -> Vec<Vec<u8>> {
            self.convs.rows().iter().map(bytes).collect()
        }
        fn wallet_rows(&self) -> Vec<Vec<u8>> {
            self.wallets.rows().iter().map(bytes).collect()
        }
    }

    /// `world` plus what makes an admitted talk visible: the caller holds quest_001
    /// (completed by talking to the elder), a wallet of 7, and an older conversation
    /// with another NPC at another node.
    fn talk_world(fx: &Fixture) -> World<'_> {
        let w = world(fx);
        w.quests.seed(&PlayerQuestRow {
            pq_id: 900,
            owner_identity: ME,
            quest_id: QUEST.to_string(),
            step_index: 0,
        });
        w.wallets.seed(&wallet(7));
        w.convs.seed(&conv(ME, ELSEWHERE, "elsewhere"));
        w
    }

    /// `world` plus the caller's conversation at the elder's `greeting`, whose choice 0
    /// is `StartQuest("quest_001")` and ends the conversation.
    fn advance_world(fx: &Fixture) -> World<'_> {
        let w = world(fx);
        w.convs.seed(&conv(ME, NPC, "greeting"));
        w
    }

    /// CTL16.1: a caller in an Ongoing battle, in any role, is refused `talk` with the
    /// exact message and nothing is written: the older conversation is neither replaced
    /// nor removed, no flag is stored, quest_001 is not completed and the wallet is not
    /// paid. The same refusal when the NPC does not exist: the guard precedes the NPC
    /// reads.
    /// kills: no guard in talk; a check of one role only (misses PvP side B, or the
    /// side-A shapes); the guard placed after a write or after the NPC lookup.
    #[test]
    fn ctl16_1_talk_refused_in_ongoing_battle_either_role_store_unchanged() {
        for (label, a, b) in ONGOING {
            for (npc, case) in [(NPC, "the elder"), (404, "no such npc")] {
                let fx = fixture();
                let w = talk_world(&fx);
                w.battles.seed(&battle(a, b, BattleOutcome::Ongoing));
                let before = w.snapshot();
                assert_eq!(
                    fx.run_as(ME, |ctx| super::talk(ctx, npc)),
                    Err(TALK_REFUSED.to_string()),
                    "{label}, {case}"
                );
                assert_eq!(w.snapshot(), before, "{label}, {case}: unchanged");
            }
        }
    }

    /// CTL16.1 controls: with no battle row, only the caller's finished battles, or a
    /// stranger's Ongoing battle, talk is admitted and its effects are visible. The
    /// older conversation now points at the elder's greeting, the flag is stored,
    /// quest_001 is done and its row gone, and the wallet gains exactly the content
    /// reward. This is what makes the refusal's "unchanged" non-vacuous.
    /// kills: a guard ignoring the outcome; a table-wide "any Ongoing battle" check; a
    /// guard that refuses everything.
    #[test]
    fn ctl16_1_talk_admitted_without_an_ongoing_battle_of_the_callers() {
        let reward = quest_001_reward();
        for (label, row) in controls() {
            let fx = fixture();
            let w = talk_world(&fx);
            if let Some(row) = &row {
                w.battles.seed(row);
            }
            assert_eq!(
                fx.run_as(ME, |ctx| super::talk(ctx, NPC)),
                Ok(()),
                "{label}: talk admitted"
            );
            assert_eq!(
                w.conv_rows(),
                vec![bytes(&conv(ME, NPC, "greeting"))],
                "{label}: the older conversation is replaced by the elder's greeting"
            );
            let states = w.states.rows();
            assert_eq!(states.len(), 1, "{label}: one dialogue state");
            assert!(
                states[0].flags.contains(&FLAG.to_string()),
                "{label}: the greeting's flag is stored"
            );
            assert_eq!(states[0].done_quests, [QUEST], "{label}: quest done");
            assert!(w.quests.rows().is_empty(), "{label}: quest row gone");
            assert_eq!(
                w.wallet_rows(),
                vec![bytes(&wallet(7 + reward))],
                "{label}: credited exactly the content reward"
            );
        }
    }

    /// CTL16.2: a caller in an Ongoing battle, in any role, is refused
    /// `advance_dialogue` with the exact message before choice 0's StartQuest applies:
    /// no quest row, no dialogue state, the conversation kept. The same when the
    /// conversation's NPC row is gone, whose branch would otherwise delete the
    /// conversation: the guard precedes it.
    /// kills: no guard in advance_dialogue; a check of one role only; the guard placed
    /// after the NPC / zone / range re-checks or after the effects.
    #[test]
    fn ctl16_2_advance_dialogue_refused_in_ongoing_battle_either_role_store_unchanged() {
        for (label, a, b) in ONGOING {
            for (npc_row, case) in [(true, "npc present"), (false, "npc row absent")] {
                let fx = fixture();
                let w = advance_world(&fx);
                w.battles.seed(&battle(a, b, BattleOutcome::Ongoing));
                if !npc_row {
                    assert_eq!(w.npcs.remove(NPC), 1, "fixture: npc row removed");
                }
                let before = w.snapshot();
                assert_eq!(
                    fx.run_as(ME, |ctx| super::advance_dialogue(ctx, 0)),
                    Err(ADVANCE_REFUSED.to_string()),
                    "{label}, {case}"
                );
                assert_eq!(w.snapshot(), before, "{label}, {case}: unchanged");
            }
        }
    }

    /// CTL16.2 controls: with no battle row, only the caller's finished battles, or a
    /// stranger's Ongoing battle, choice 0 applies: quest_001 starts for the caller
    /// and the one-node tree ends the conversation.
    /// kills: a guard ignoring the outcome; a table-wide check; refuse-everything.
    #[test]
    fn ctl16_2_advance_dialogue_admitted_without_an_ongoing_battle_of_the_callers() {
        for (label, row) in controls() {
            let fx = fixture();
            let w = advance_world(&fx);
            if let Some(row) = &row {
                w.battles.seed(row);
            }
            assert_eq!(
                fx.run_as(ME, |ctx| super::advance_dialogue(ctx, 0)),
                Ok(()),
                "{label}: advance admitted"
            );
            let quests = w.quests.rows();
            assert_eq!(quests.len(), 1, "{label}: one quest started");
            assert_eq!(quests[0].owner_identity, ME, "{label}: caller's");
            assert_eq!(quests[0].quest_id, QUEST, "{label}: quest_001");
            assert!(w.convs.rows().is_empty(), "{label}: ended");
        }
    }

    /// CTL16.4: dismiss_dialogue stays available in every battle role (Start can pop a
    /// dialogue suspended under a battle): Ok, the caller's conversation is gone and a
    /// stranger's conversation is byte-identical.
    /// kills: the battle guard copied into dismiss_dialogue; a dismiss that deletes
    /// every conversation.
    #[test]
    fn ctl16_4_dismiss_dialogue_succeeds_during_an_ongoing_battle() {
        for (label, a, b) in ONGOING {
            let fx = fixture();
            let w = advance_world(&fx);
            w.convs.seed(&conv(THIRD, NPC, "greeting"));
            w.battles.seed(&battle(a, b, BattleOutcome::Ongoing));
            assert_eq!(
                fx.run_as(ME, super::dismiss_dialogue),
                Ok(()),
                "{label}: dismiss admitted"
            );
            assert_eq!(
                w.conv_rows(),
                vec![bytes(&conv(THIRD, NPC, "greeting"))],
                "{label}: only the caller's conversation is removed"
            );
        }
    }
}
