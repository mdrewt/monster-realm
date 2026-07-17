//! `pvp` server-module gating tests — M16a PvP spine (ADR-0109).
//!
//! Source-guard pattern: read production source via `include_str!`, strip comments,
//! search for assembled needles. The needle string is never written verbatim in this
//! file — it is built with `concat!()` — so the test cannot pass by matching itself.
//!
//! EARS criteria covered:
//!   EA-PVP-01  `battle_action` table in schema.rs has NO `public` keyword —
//!              must-never-leak (ADR-0015, ADR-0109).
//!   EA-PVP-02  `pvp_deadline_reaper` has the scheduler-only identity guard in pvp.rs.
//!   EA-PVP-03  `battle_challenge`, `battle_action`, and `pvp_deadline_schedule` all
//!              appear in evals/baselines/table-schemas.json.
//!   EA-PVP-04  `ChallengeStatus` and `PvpAction` appear in
//!              evals/baselines/spacetime-types.json.
//!   EA-PVP-05  `on_disconnect` in lib.rs calls both `pvp::forfeit_on_disconnect` and
//!              `pvp::cancel_challenges_on_disconnect`.
//!   EA-PVP-06  `PVP_TURN_DEADLINE_MS` constant is exactly 60_000 (one minute).
//!   EA-PVP-07  `resolve_pvp_turn_if_ready` is called from `submit_pvp_action`
//!              (both-submitted inline resolution).
//!   EA-PVP-08  `pvp` module is declared in `lib.rs`.
//!   EA-PVP-09  `battle_challenge` table in schema.rs is `public` (clients must
//!              be able to subscribe to incoming challenges).
//!   EA-PVP-10  `BattleChallenge` and `BattleAction` are declared in schema.rs.
//!
//! Red-team finding (fixed in this PR):
//!   RT-M16-08  `resolve_pvp_turn_if_ready` must call `write_back_battle_results`
//!              BEFORE updating the battle row to its terminal state, so the GC
//!              sweep inside `write_back_battle_results` does not delete the
//!              current battle row before clients see the terminal outcome frame.

// ---------------------------------------------------------------------------
// Source constants
// ---------------------------------------------------------------------------

const PVP_RS: &str = include_str!("pvp.rs");
const SCHEMA_RS: &str = include_str!("schema.rs");
const LIB_RS: &str = include_str!("lib.rs");
const TABLE_SCHEMAS_JSON: &str = include_str!("../../evals/baselines/table-schemas.json");
const SPACETIME_TYPES_JSON: &str = include_str!("../../evals/baselines/spacetime-types.json");

// ---------------------------------------------------------------------------
// Comment-stripping helper (mirrors m14_5d_1a_tests.rs)
// ---------------------------------------------------------------------------

fn strip_rust_comments(src: &str) -> String {
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

// ---------------------------------------------------------------------------
// EA-PVP-01: battle_action table must NOT be public (ADR-0015)
//
// Proof-of-teeth: kills any impl that accidentally marks battle_action as
// `public` — e.g. `#[spacetimedb::table(name = battle_action, public)]`.
// `battle_action` is a private table so clients can never query submitted picks,
// preserving secret-pick semantics.
//
// The source scan strips comments first so a commented-out `// public` doesn't
// trigger a false negative.
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_01_battle_action_is_not_public() {
    let stripped = strip_rust_comments(SCHEMA_RS);
    // Find the battle_action table declaration and assert no `public` on the same
    // attribute line.
    let needle_table = concat!("name = ", "battle_action");
    let public_str = "public";
    let pos = stripped.find(needle_table).expect(
        "EA-PVP-01: `name = battle_action` declaration not found in schema.rs — \
         the BattleAction table must be declared there",
    );
    // Look at the line containing this declaration.
    let line_start = stripped[..pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
    let line_end = stripped[pos..]
        .find('\n')
        .map(|p| pos + p)
        .unwrap_or(stripped.len());
    let decl_line = &stripped[line_start..line_end];
    assert!(
        !decl_line.contains(public_str),
        "EA-PVP-01 FAIL: `battle_action` table declaration contains `public` keyword — \
         this table MUST be private (must-never-leak, ADR-0015, ADR-0109 D4). \
         Found on line: {:?}",
        decl_line
    );
}

// ---------------------------------------------------------------------------
// EA-PVP-02: pvp_deadline_reaper has the scheduler-only identity guard
//
// Proof-of-teeth: kills an impl that forgets the scheduler-only guard,
// allowing any client to call pvp_deadline_reaper and trigger forfeits.
// The guard pattern: `ctx.sender != ctx.identity()`.
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_02_deadline_reaper_has_scheduler_guard() {
    let stripped = strip_rust_comments(PVP_RS);
    // The guard must appear in pvp_deadline_reaper.
    let reaper_fn = concat!("fn ", "pvp_deadline_reaper");
    let guard_pattern = concat!("ctx.sender", " != ", "ctx.identity()");
    let fn_pos = stripped
        .find(reaper_fn)
        .expect("EA-PVP-02: `pvp_deadline_reaper` function not found in pvp.rs");
    // Find the next closing brace after the function (heuristic: scan forward
    // until we see the guard pattern).
    let fn_body = &stripped[fn_pos..];
    assert!(
        fn_body.contains(guard_pattern),
        "EA-PVP-02 FAIL: `pvp_deadline_reaper` in pvp.rs is missing the \
         scheduler-only identity guard (`ctx.sender != ctx.identity()`). \
         Without this guard, any client can call the reaper and trigger \
         arbitrary forfeits. This guard is required (ADR-0109, matches the \
         `movement_tick` pattern in movement.rs)."
    );
}

// ---------------------------------------------------------------------------
// EA-PVP-03: all three new tables appear in table-schemas.json
//
// Proof-of-teeth: kills an impl that adds the tables but forgets to update
// the eval baseline — the eval gate would then fire on the next CI run.
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_03_new_tables_in_table_schemas_json() {
    for table_name in &[
        concat!("battle", "_challenge"),
        concat!("battle", "_action"),
        concat!("pvp_deadline", "_schedule"),
    ] {
        assert!(
            TABLE_SCHEMAS_JSON.contains(table_name),
            "EA-PVP-03 FAIL: `{}` not found in evals/baselines/table-schemas.json. \
             The schema-snapshot eval will red-flag this — update the baseline.",
            table_name
        );
    }
}

// ---------------------------------------------------------------------------
// EA-PVP-04: ChallengeStatus and PvpAction in spacetime-types.json
//
// Proof-of-teeth: kills an impl that adds the types to the Rust source but
// omits them from the SpacetimeType baseline — the types eval would then fire.
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_04_new_types_in_spacetime_types_json() {
    for type_name in &["ChallengeStatus", "PvpAction"] {
        assert!(
            SPACETIME_TYPES_JSON.contains(type_name),
            "EA-PVP-04 FAIL: `{}` not found in evals/baselines/spacetime-types.json. \
             Update the baseline after adding the SpacetimeType derive.",
            type_name
        );
    }
}

// ---------------------------------------------------------------------------
// EA-PVP-05: on_disconnect calls both PvP helpers
//
// Proof-of-teeth: kills an impl that registers pvp.rs but forgets to wire
// forfeit_on_disconnect or cancel_challenges_on_disconnect into on_disconnect,
// leaving liveness broken on client drop.
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_05_on_disconnect_calls_pvp_helpers() {
    let stripped = strip_rust_comments(LIB_RS);
    for needle in &[
        concat!("pvp::", "forfeit_on_disconnect"),
        concat!("pvp::", "cancel_challenges_on_disconnect"),
    ] {
        assert!(
            stripped.contains(needle),
            "EA-PVP-05 FAIL: `{}` not found in lib.rs `on_disconnect`. \
             PvP forfeit-on-disconnect and challenge cancellation must be wired \
             into the disconnect lifecycle reducer (ADR-0109 D8/D9).",
            needle
        );
    }
}

// ---------------------------------------------------------------------------
// EA-PVP-06: PVP_TURN_DEADLINE_MS = 60_000
//
// Proof-of-teeth: kills an impl that changes the constant without updating the
// spec — 60 s is the agreed turn deadline (ADR-0109 D3).
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_06_turn_deadline_constant_is_sixty_seconds() {
    use super::PVP_TURN_DEADLINE_MS;
    assert_eq!(
        PVP_TURN_DEADLINE_MS, 60_000,
        "EA-PVP-06 FAIL: PVP_TURN_DEADLINE_MS must be 60_000 (60 seconds in milliseconds). \
         Found {}. Update the ADR if you change the deadline.",
        PVP_TURN_DEADLINE_MS
    );
}

// ---------------------------------------------------------------------------
// EA-PVP-07: resolve_pvp_turn_if_ready called from submit_pvp_action
//
// Proof-of-teeth: kills an impl that decouples the both-submitted check from
// the action submission, breaking the "inline resolution in same transaction"
// guarantee (ADR-0109 D7).
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_07_submit_pvp_action_calls_resolve_if_ready() {
    let stripped = strip_rust_comments(PVP_RS);
    let submit_fn = concat!("fn ", "submit_pvp_action");
    let resolve_call = concat!("resolve_pvp_turn", "_if_ready");
    let fn_pos = stripped
        .find(submit_fn)
        .expect("EA-PVP-07: `submit_pvp_action` function not found in pvp.rs");
    let fn_body = &stripped[fn_pos..];
    assert!(
        fn_body.contains(resolve_call),
        "EA-PVP-07 FAIL: `submit_pvp_action` in pvp.rs does not call \
         `resolve_pvp_turn_if_ready`. Both-submitted resolution must happen \
         inline in the same SpacetimeDB transaction as the second pick (ADR-0109 D7)."
    );
}

// ---------------------------------------------------------------------------
// EA-PVP-08: `mod pvp` declared in lib.rs
//
// Proof-of-teeth: kills an impl that creates pvp.rs but forgets to declare
// the module — the module's reducers would be invisible to SpacetimeDB.
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_08_pvp_module_declared_in_lib_rs() {
    let stripped = strip_rust_comments(LIB_RS);
    let needle = concat!("mod ", "pvp;");
    assert!(
        stripped.contains(needle),
        "EA-PVP-08 FAIL: `mod pvp;` not found in lib.rs. The pvp module must \
         be declared for SpacetimeDB to register its tables and reducers."
    );
}

// ---------------------------------------------------------------------------
// EA-PVP-09: battle_challenge table is PUBLIC (clients subscribe to challenges)
//
// Proof-of-teeth: kills an impl that accidentally omits `public` from
// battle_challenge — clients would then be unable to see incoming challenges.
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_09_battle_challenge_is_public() {
    let stripped = strip_rust_comments(SCHEMA_RS);
    let needle_table = concat!("name = ", "battle_challenge");
    let pos = stripped.find(needle_table).expect(
        "EA-PVP-09: `name = battle_challenge` not found in schema.rs — \
         BattleChallenge must be declared there",
    );
    let line_start = stripped[..pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
    let line_end = stripped[pos..]
        .find('\n')
        .map(|p| pos + p)
        .unwrap_or(stripped.len());
    let decl_line = &stripped[line_start..line_end];
    assert!(
        decl_line.contains("public"),
        "EA-PVP-09 FAIL: `battle_challenge` table declaration does NOT contain \
         `public`. Clients need to subscribe to see incoming challenges. \
         Found line: {:?}",
        decl_line
    );
}

// ---------------------------------------------------------------------------
// EA-PVP-10: BattleChallenge and BattleAction struct declarations exist
//
// Proof-of-teeth: kills an impl that uses different names, or puts the structs
// in the wrong file, making them unreachable from other modules.
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_10_schema_structs_declared() {
    for struct_name in &["BattleChallenge", "BattleAction"] {
        let full_needle = format!("pub struct {struct_name}");
        assert!(
            SCHEMA_RS.contains(&full_needle),
            "EA-PVP-10 FAIL: `{}` struct declaration not found in schema.rs. \
             All table structs must be declared in schema.rs (ADR-0056).",
            struct_name
        );
    }
}

// ---------------------------------------------------------------------------
// Compile-time smoke: PvpDeadlineSchedule is constructable
//
// This test exists to verify that all the fields are correctly named and typed.
// A wrong field name would fail compilation before this test runs.
// ---------------------------------------------------------------------------

#[test]
fn pvp_deadline_schedule_fields_are_correct() {
    use super::PvpDeadlineSchedule;
    use spacetimedb::ScheduleAt;
    use std::time::Duration;

    let sched = PvpDeadlineSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Interval(Duration::from_millis(60_000).into()),
        battle_id: 42,
        turn_number: 3,
    };
    assert_eq!(sched.battle_id, 42);
    assert_eq!(sched.turn_number, 3);
}

// ---------------------------------------------------------------------------
// RT-M16-01: challenge_pvp MUST check that the TARGET is not in an ongoing
// battle before inserting a BattleChallenge row.
//
// Finding: `challenge_pvp` guards the CALLER with `is_in_ongoing_battle`
// but never calls `is_in_ongoing_battle(ctx, target)`. A player who is busy
// in an active PvP or PvE battle can still receive challenge rows that pile up
// in the public `battle_challenge` table. When the target finishes their
// current battle and calls `accept_challenge`, the battle creates fine — but
// during the acceptance window the target is simultaneously "in a battle" and
// "has a pending incoming challenge", violating the mutual-exclusion invariant
// documented in the guard order comment (guard 4 in accept_challenge re-checks
// `is_in_ongoing_battle`, so acceptance is correctly blocked, but the
// INSERTION of the challenge row is not, causing UX clutter and a potential
// accept race on simultaneous battle-end + accept).
//
// Proof-of-teeth: kills any impl that checks the target ONLY inside
// accept_challenge's guard 4 and not at insertion time in challenge_pvp.
// After the fix, challenge_pvp must call is_in_ongoing_battle for the target.
// ---------------------------------------------------------------------------

#[test]
fn rt_m16_01_challenge_pvp_guards_target_not_in_battle() {
    let stripped = strip_rust_comments(PVP_RS);

    // Locate the challenge_pvp function body.
    let fn_marker = concat!("fn ", "challenge_pvp");
    let fn_pos = stripped
        .find(fn_marker)
        .expect("RT-M16-01: `challenge_pvp` not found in pvp.rs");

    // Find the closing of challenge_pvp: it ends before `accept_challenge` begins.
    let accept_marker = concat!("fn ", "accept_challenge");
    let accept_pos = stripped[fn_pos..]
        .find(accept_marker)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());

    let challenge_pvp_body = &stripped[fn_pos..accept_pos];

    // The fix requires calling is_in_ongoing_battle with the target variable.
    // We look for the pattern `is_in_ongoing_battle` followed nearby by `target`
    // anywhere in the challenge_pvp body.
    let guard_call = concat!("is_in_ongoing", "_battle");
    assert!(
        challenge_pvp_body.contains(guard_call),
        "RT-M16-01 FAIL: `challenge_pvp` in pvp.rs does not call \
         `is_in_ongoing_battle` at all within its body. \
         A challenger can send a challenge to a player who is already in an \
         ongoing battle, bypassing the pre-insertion guard. \
         Fix: add `is_in_ongoing_battle(ctx, target)` check before inserting \
         the BattleChallenge row (after guard 3, before guard 8)."
    );

    // Tighter check: the guard call must appear with `target` as the argument,
    // not just `me`. We look for the literal two-argument pattern.
    let target_guard = concat!("is_in_ongoing_battle(ctx, ", "target)");
    assert!(
        challenge_pvp_body.contains(target_guard),
        "RT-M16-01 FAIL: `challenge_pvp` calls `is_in_ongoing_battle` but only \
         for the caller (`me`), NOT for the `target`. A player in an ongoing \
         battle can be challenged, cluttering their challenge inbox and creating \
         an accept race. \
         Fix: add `is_in_ongoing_battle(ctx, target)` check in challenge_pvp \
         after the existing `is_in_ongoing_battle(ctx, me)` guard."
    );
}

// ---------------------------------------------------------------------------
// RT-M16-02: write_back_battle_results MUST NOT treat a real PvP opponent as
// a practice target when awarding XP to the challenger.
//
// Finding: `write_back_battle_results` in battle.rs computes:
//   `let is_practice = battle.opponent_identity != WILD_IDENTITY;`
// This flag was introduced in M12.5e2 for SELF-vs-SELF sandbox battles
// (ADR-0078). In PvP battles, `opponent_identity` is a real player (not
// WILD_IDENTITY), so `is_practice` evaluates to TRUE for every PvP win.
// Consequently the challenger only earns `floor(base_xp / 10)` even though
// they beat a real opponent. PvP victory XP must be full-rate, not 1/10.
//
// The fix is to distinguish a true practice/sandbox battle
// (opponent_identity == ctx.sender at start_battle time, where the opponent
// IS the challenger's own self) from a real PvP battle. One correct expression:
//   `let is_practice = battle.player_identity == battle.opponent_identity;`
//
// Proof-of-teeth: kills any impl that uses `!= WILD_IDENTITY` as the
// is_practice predicate and thus penalises PvP winners at 1/10 XP.
// After the fix the source scan must no longer contain the broken expression.
// ---------------------------------------------------------------------------

#[test]
fn rt_m16_02_pvp_win_is_not_classified_as_practice() {
    let battle_rs = include_str!("battle.rs");
    let stripped = strip_rust_comments(battle_rs);

    // The broken expression: using != WILD_IDENTITY as the practice flag.
    // This is the literal text we expect to disappear after the fix.
    let broken_expr = concat!(
        "is_practice = battle.opponent_identity != ",
        "WILD_IDENTITY"
    );
    assert!(
        !stripped.contains(broken_expr),
        "RT-M16-02 FAIL: `write_back_battle_results` in battle.rs uses \
         `opponent_identity != WILD_IDENTITY` as the `is_practice` flag. \
         This incorrectly marks every PvP battle (where opponent_identity is a \
         real player, not WILD_IDENTITY) as a practice battle, penalising the \
         challenger with only 1/10 XP on a PvP win. \
         Fix: replace with `player_identity == opponent_identity` (self-battle \
         is the only legitimate practice scenario) so real PvP victories grant \
         full XP."
    );
}

// ---------------------------------------------------------------------------
// RT-M16-03: write_back_battle_results MUST GC stale terminal battle rows
// for the OPPONENT (side B) in PvP battles, not only for player_identity.
//
// Finding: The `old_terminal_ids` cleanup in `write_back_battle_results`
// queries `battle().player_identity().filter(player)` — it only sweeps old
// terminal battles where the CHALLENGER is player_identity (side A). In a PvP
// battle where side B wins (`SideBWins`), old terminal battles where the
// OPPONENT was in side B are never GC'd via `opponent_identity` index.
// Over time this causes an unbounded accumulation of terminal battle rows for
// the opponent identity, bloating the public `battle` table.
//
// Proof-of-teeth: kills any impl that has ONLY a player_identity GC pass
// inside write_back_battle_results without also GC-ing via opponent_identity.
// After the fix, write_back_battle_results must contain an opponent_identity
// GC sweep for PvP terminal outcomes.
// ---------------------------------------------------------------------------

#[test]
fn rt_m16_03_write_back_battle_results_gcs_opponent_terminal_battles() {
    let battle_rs = include_str!("battle.rs");
    let stripped = strip_rust_comments(battle_rs);

    // Find write_back_battle_results body (it ends before write_back_party_hp
    // which is declared just above it, so we search from its fn declaration).
    let fn_marker = concat!("fn write_back_battle", "_results");
    let fn_pos = stripped
        .find(fn_marker)
        .expect("RT-M16-03: `write_back_battle_results` not found in battle.rs");

    // We look for opponent_identity filtering in the GC pass — the fix must
    // add a sweep like: `battle().opponent_identity().filter(opponent)` inside
    // write_back_battle_results for PvP terminal rows.
    let opponent_gc_needle = concat!("opponent_identity()", ".filter");
    let fn_body = &stripped[fn_pos..];
    assert!(
        fn_body.contains(opponent_gc_needle),
        "RT-M16-03 FAIL: `write_back_battle_results` in battle.rs does not GC \
         old terminal battle rows by `opponent_identity`. \
         In PvP battles where side B wins, old terminal battles where the \
         losing player was `opponent_identity` (side B) are never deleted, \
         causing unbounded `battle` table growth for the opponent identity. \
         Fix: add a second GC sweep inside write_back_battle_results that \
         deletes old terminal battle rows indexed by `opponent_identity` for \
         PvP outcomes (outcome is SideBWins, i.e. the opponent won)."
    );
}

// ---------------------------------------------------------------------------
// RT-M16-05: apply_pvp_forfeit MUST NOT leave a battle stuck in Ongoing
// state if write_back_party_hp_pvp_side_b returns Err.
//
// Finding: `apply_pvp_forfeit` calls `write_back_party_hp_pvp_side_b(…)?`
// before `ctx.db.battle().battle_id().update(battle)`. If the HP write-back
// returns Err (e.g. ownership changed for a side-B monster), the `?` causes
// early return and `update(battle)` never runs, leaving the battle row with
// outcome=Ongoing in the database. Both players are then permanently locked
// out of new PvP battles (is_in_ongoing_battle returns true forever), and the
// stale `battle_action` rows are never cleaned up either.
//
// The same issue exists in resolve_pvp_turn_if_ready: if either write-back
// returns Err, the battle row is never updated to its terminal state.
//
// Proof-of-teeth: kills any impl where the write-back Err propagates before
// the battle row update runs. After the fix, the battle row must be updated
// to its terminal outcome BEFORE propagating a write-back error (or the
// error must be logged-and-continued rather than propagated via `?`).
// ---------------------------------------------------------------------------

#[test]
fn rt_m16_05_apply_pvp_forfeit_updates_battle_before_propagating_writeback_err() {
    let stripped = strip_rust_comments(PVP_RS);

    // Locate apply_pvp_forfeit body.
    let fn_marker = concat!("fn apply_pvp", "_forfeit");
    let fn_pos = stripped
        .find(fn_marker)
        .expect("RT-M16-05: `apply_pvp_forfeit` not found in pvp.rs");

    // Find write_back_party_hp_pvp_side_b call site and the battle update site.
    let side_b_call = concat!("write_back_party_hp_pvp", "_side_b");
    let battle_update = concat!("battle().battle_id()", ".update");

    let fn_body = &stripped[fn_pos..];

    let side_b_pos = fn_body
        .find(side_b_call)
        .expect("RT-M16-05: `write_back_party_hp_pvp_side_b` call not found in apply_pvp_forfeit");
    let update_pos = fn_body
        .find(battle_update)
        .expect("RT-M16-05: `battle().battle_id().update` not found in apply_pvp_forfeit");

    // The battle update must come BEFORE the write-back propagation can abort.
    // Specifically: if the write-back uses `?` (propagation), the battle update
    // MUST appear before the `?` suffix on the side_b call.
    // We detect this by checking whether the update appears BEFORE the side_b call.
    assert!(
        update_pos < side_b_pos,
        "RT-M16-05 FAIL: In `apply_pvp_forfeit`, `write_back_party_hp_pvp_side_b` \
         is called with `?` BEFORE `battle().battle_id().update(battle)`. \
         If the HP write-back returns Err (e.g. ownership change for a side-B \
         monster), the battle row is never updated to its terminal outcome — \
         both players remain permanently locked in an `Ongoing` battle they \
         cannot escape. \
         Fix: update the battle row (set terminal outcome) BEFORE calling \
         write-back helpers, or log-and-continue on write-back errors instead \
         of propagating them with `?`."
    );
}

// ---------------------------------------------------------------------------
// ChallengeStatus enum coverage
//
// All four variants must be equality-comparable (PartialEq derived).
// Proof-of-teeth: kills an impl that adds/renames variants without updating
// the complete match in pvp.rs (exhaustive match would then fail to compile).
// ---------------------------------------------------------------------------

#[test]
fn challenge_status_variants_are_distinct() {
    use crate::schema::ChallengeStatus;
    let variants = [
        ChallengeStatus::Pending,
        ChallengeStatus::Accepted,
        ChallengeStatus::Declined,
        ChallengeStatus::Cancelled,
    ];
    for (i, a) in variants.iter().enumerate() {
        for (j, b) in variants.iter().enumerate() {
            if i == j {
                assert_eq!(a, b, "variant {i} must equal itself");
            } else {
                assert_ne!(a, b, "variants {i} and {j} must be distinct");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// RT-M16-08: resolve_pvp_turn_if_ready MUST call write_back_battle_results
// BEFORE updating the battle row to its terminal state.
//
// Finding: in `resolve_pvp_turn_if_ready` (pvp.rs), when the battle reaches
// a terminal outcome, the code:
//   1. ctx.db.battle().battle_id().update(battle);   ← commits terminal state
//   2. write_back_battle_results(ctx, &battle_for_wb);
//
// Inside `write_back_battle_results` (battle.rs), the GC sweep at the
// "GC prior terminal battles" block collects ALL terminal battle rows for
// player_identity where outcome != Ongoing. Since step 1 has already committed
// the terminal outcome, the CURRENT battle is included in the sweep and deleted.
// Clients subscribed to the `battle` table see the row disappear rather than
// transitioning to a terminal outcome frame — the win/loss screen never fires.
//
// The fix (mirroring submit_attack / swap_active in battle.rs) is to call
// write_back_battle_results BEFORE ctx.db.battle().battle_id().update(battle),
// so the GC sweep only sees prior terminals (the current row is still Ongoing
// during the sweep, as documented in write_back_battle_results' own invariant
// comment).
//
// Proof-of-teeth: kills any impl where the battle row update (to terminal state)
// appears BEFORE the write_back_battle_results call in the terminal branch of
// resolve_pvp_turn_if_ready.
// After the fix, write_back_battle_results must appear BEFORE the update call.
// ---------------------------------------------------------------------------

#[test]
fn rt_m16_08_resolve_pvp_turn_if_ready_calls_writeback_before_battle_update() {
    let stripped = strip_rust_comments(PVP_RS);

    // Locate resolve_pvp_turn_if_ready body.
    let fn_marker = concat!("fn resolve_pvp_turn", "_if_ready");
    let fn_pos = stripped
        .find(fn_marker)
        .expect("RT-M16-08: `resolve_pvp_turn_if_ready` not found in pvp.rs");

    // Find apply_pvp_forfeit — that's where resolve_pvp ends and forfeit begins.
    // resolve_pvp_turn_if_ready ends before apply_pvp_forfeit.
    let next_fn = concat!("fn apply_pvp", "_forfeit");
    let next_fn_pos = stripped[fn_pos..]
        .find(next_fn)
        .map(|p| fn_pos + p)
        .unwrap_or(stripped.len());

    let fn_body = &stripped[fn_pos..next_fn_pos];

    // In the terminal branch we look for the write_back call and the battle update.
    let wb_call = concat!("write_back_battle", "_results");
    let update_call = concat!("battle().battle_id()", ".update");

    let wb_pos = fn_body.find(wb_call).expect(
        "RT-M16-08: `write_back_battle_results` call not found in resolve_pvp_turn_if_ready",
    );
    let update_pos = fn_body.find(update_call).expect(
        "RT-M16-08: `battle().battle_id().update` call not found in resolve_pvp_turn_if_ready",
    );

    // After the fix: write_back must come BEFORE the update in the terminal branch.
    // The invariant from write_back_battle_results' own comment: callers must call
    // update() AFTER write_back returns so the GC sweep only targets prior terminals.
    //
    // Correct assertion: wb_pos < update_pos means "writeback appears earlier (smaller
    // offset) in the source than the battle row update" — i.e. writeback runs first.
    // The BROKEN state has update_pos < wb_pos (update runs first, then writeback),
    // which causes the GC sweep inside writeback to delete the current battle row.
    assert!(
        wb_pos < update_pos,
        "RT-M16-08 FAIL: In `resolve_pvp_turn_if_ready`, `battle().battle_id().update` \
         (at offset {update_pos}) appears BEFORE `write_back_battle_results` \
         (at offset {wb_pos}). \
         This violates write_back_battle_results' own ordering invariant: the battle \
         row must still be Ongoing during the GC sweep inside write_back_battle_results, \
         otherwise the current (just-committed-terminal) battle row is included in the \
         sweep and deleted — clients see the battle disappear rather than a terminal \
         outcome frame. \
         Fix: move `write_back_battle_results` call to BEFORE the `update(battle)` call \
         in the terminal branch of resolve_pvp_turn_if_ready, mirroring the battle.rs \
         submit_attack / swap_active pattern."
    );
}

// ===========================================================================
// m17a (ADR-0119): Ranked ladder spine tests
//
// Source constants used below (in addition to PVP_RS / SCHEMA_RS / LIB_RS
// already declared at the top of this file):
//
//   BATTLE_RS   — server-module/src/battle.rs  (for single-caller count)
//   TAMING_RS   — server-module/src/taming.rs  (never-deleted scan)
//   TRADING_RS  — server-module/src/trading.rs (never-deleted scan)
//   ECONOMY_RS  — server-module/src/economy.rs (never-deleted scan)
//   MONSTER_MGMT_RS — server-module/src/monster_mgmt.rs (never-deleted scan)
//   EVOLUTION_RS    — server-module/src/evolution.rs    (never-deleted scan)
//   RAISING_RS      — server-module/src/raising.rs      (never-deleted scan)
//   NPC_RS          — server-module/src/npc.rs          (never-deleted scan)
//   MOVEMENT_RS     — server-module/src/movement.rs     (never-deleted scan)
//   CONTENT_RS      — server-module/src/content.rs      (never-deleted scan)
//   SERVER_RANKING_RS — server-module/src/ranking.rs    (runtime-read via std::fs)
//
// Note: SERVER_RANKING_RS is read at runtime (not include_str!) because the
// file does not yet exist; the test asserts the read succeeds so that a missing
// file causes a clear red failure with the message "m17a: server-module/src/ranking.rs
// must exist (RL-7)".
// ===========================================================================

const BATTLE_RS: &str = include_str!("battle.rs");
const TAMING_RS: &str = include_str!("taming.rs");
const TRADING_RS: &str = include_str!("trading.rs");
const ECONOMY_RS: &str = include_str!("economy.rs");
const MONSTER_MGMT_RS: &str = include_str!("monster_mgmt.rs");
const EVOLUTION_RS: &str = include_str!("evolution.rs");
const RAISING_RS: &str = include_str!("raising.rs");
const NPC_RS: &str = include_str!("npc.rs");
const MOVEMENT_RS: &str = include_str!("movement.rs");
const CONTENT_RS: &str = include_str!("content.rs");

// ---------------------------------------------------------------------------
// Helper: extract a function body from a source string (mirrors battle_tests.rs).
// Finds `pub fn <name>(` or `fn <name>(`, counts braces to locate the body.
// ---------------------------------------------------------------------------
fn extract_pvp_fn_body<'a>(src: &'a str, name: &str) -> Option<&'a str> {
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

// ---------------------------------------------------------------------------
// (a) RL-10: settle-funnel exists in pvp.rs
//
// Proof-of-teeth: kills any impl that names the function differently or places
// it outside pvp.rs.
// RED now: settle_pvp_battle does not yet exist.
// ---------------------------------------------------------------------------

/// RL-10 (a): pvp.rs must contain a private `settle_pvp_battle` function.
///
/// This is the single funnel that commits terminal PvP outcomes and calls
/// `apply_pvp_rating` exactly once per decisive battle (ADR-0119 D3).
///
/// Kills: any impl that inlines the commit in each call site rather than
/// unifying into one function, or that names it differently.
/// RED now: function does not yet exist in pvp.rs.
#[test]
fn m17a_rl10_settle_pvp_battle_exists() {
    let stripped = strip_rust_comments(PVP_RS);
    let needle = concat!("fn settle_pvp", "_battle(");
    assert!(
        stripped.contains(needle),
        "m17a-RL-10 FAIL: pvp.rs must contain `{}` — the single funnel for terminal \
         PvP outcome commits (ADR-0119 D3). Without it, apply_pvp_rating could be \
         called from multiple sites, violating exactly-once. RED: function absent.",
        needle
    );
}

// ---------------------------------------------------------------------------
// (b) RL-10: apply_pvp_rating called exactly once across non-ranking-rs sources
//
// The bare identifier concat!("apply_pvp", "_rating") is counted across:
//   PVP_RS + BATTLE_RS + LIB_RS
// Must be exactly 1 occurrence (the call in settle_pvp_battle, path-qualified
// as `ranking::apply_pvp_rating(`).
//
// Contract: the implementer must path-qualify the call as `ranking::apply_pvp_rating(`
// so that a `use` import would NOT add a second bare-identifier occurrence.
// The path-qualified form itself IS the one occurrence counted.
//
// RED now: 0 occurrences (function not yet written).
// ---------------------------------------------------------------------------

/// RL-10 (b): exactly one occurrence of `apply_pvp_rating` across pvp.rs + battle.rs + lib.rs.
///
/// We count the path-qualified call `ranking::apply_pvp_rating(` in PVP_RS,
/// and also count the bare identifier `apply_pvp_rating` in BATTLE_RS and LIB_RS
/// (neither should reference it). Total must be exactly 1.
///
/// Kills: an impl with two call sites (double-count), or one that routes through
/// an alias binding in battle.rs or lib.rs.
/// RED now: 0 occurrences.
#[test]
fn m17a_rl10_apply_pvp_rating_single_callsite() {
    let stripped_pvp = strip_rust_comments(PVP_RS);
    let stripped_battle = strip_rust_comments(BATTLE_RS);
    let stripped_lib = strip_rust_comments(LIB_RS);

    // Needle: the path-qualified call form (one and only acceptable form).
    let call_needle = concat!("ranking::apply_pvp", "_rating(");
    // Bare identifier needle (for battle.rs and lib.rs — must be 0 there).
    let bare_needle = concat!("apply_pvp", "_rating");

    // Count path-qualified calls in pvp.rs — expect exactly 1.
    let pvp_call_count = stripped_pvp.matches(call_needle).count();

    // Count bare identifier in battle.rs and lib.rs — expect 0 each.
    let battle_bare_count = stripped_battle.matches(bare_needle).count();
    let lib_bare_count = stripped_lib.matches(bare_needle).count();

    assert_eq!(
        pvp_call_count, 1,
        "m17a-RL-10 FAIL: expected exactly 1 path-qualified call `{}` in pvp.rs, \
         found {}. There must be exactly one call site (settle_pvp_battle) to \
         guarantee exactly-once rating application (ADR-0119 D3).",
        call_needle, pvp_call_count
    );

    assert_eq!(
        battle_bare_count, 0,
        "m17a-RL-10 FAIL: found {} occurrence(s) of `{}` in battle.rs — \
         battle.rs must NOT call apply_pvp_rating directly; all rating application \
         flows through the settle_pvp_battle funnel in pvp.rs.",
        battle_bare_count, bare_needle
    );

    assert_eq!(
        lib_bare_count, 0,
        "m17a-RL-10 FAIL: found {} occurrence(s) of `{}` in lib.rs — \
         lib.rs must NOT call apply_pvp_rating; rating application is pvp.rs-internal.",
        lib_bare_count, bare_needle
    );
}

// ---------------------------------------------------------------------------
// (c) RL-10: both settle sites delegate; direct write_back removed from forfeit
//
// apply_pvp_forfeit body must contain settle_pvp_battle call.
// resolve_pvp_turn_if_ready body must contain settle_pvp_battle call.
// apply_pvp_forfeit body must NOT contain a direct write_back_battle_results call
//   (that call is now inside settle_pvp_battle — moving it out would duplicate).
//
// RED now: settle_pvp_battle does not exist yet.
// ---------------------------------------------------------------------------

/// RL-10 (c1): apply_pvp_forfeit must delegate to settle_pvp_battle.
///
/// Kills: an impl that keeps the direct write_back + update + apply_pvp_rating
/// inline in apply_pvp_forfeit rather than delegating to the funnel.
/// RED now: settle_pvp_battle absent.
#[test]
fn m17a_rl10_forfeit_delegates_to_settle_funnel() {
    let stripped = strip_rust_comments(PVP_RS);
    let settle_needle = concat!("settle_pvp", "_battle(");

    let forfeit_body = extract_pvp_fn_body(&stripped, "apply_pvp_forfeit")
        .expect("m17a-RL-10 (c1): `apply_pvp_forfeit` must exist in pvp.rs");

    assert!(
        forfeit_body.contains(settle_needle),
        "m17a-RL-10 (c1) FAIL: `apply_pvp_forfeit` body must call `{}` to delegate \
         terminal commit to the single funnel. Without this, forfeit path bypasses \
         the once-only apply_pvp_rating guarantee (ADR-0119 D3). RED: absent.",
        settle_needle
    );
}

/// RL-10 (c2): resolve_pvp_turn_if_ready must delegate to settle_pvp_battle.
///
/// Kills: an impl that keeps the both-submit terminal commit inline rather than
/// delegating to the funnel, creating a second call site for apply_pvp_rating.
/// RED now: settle_pvp_battle absent.
#[test]
fn m17a_rl10_resolve_pvp_turn_delegates_to_settle_funnel() {
    let stripped = strip_rust_comments(PVP_RS);
    let settle_needle = concat!("settle_pvp", "_battle(");

    let resolve_body = extract_pvp_fn_body(&stripped, "resolve_pvp_turn_if_ready")
        .expect("m17a-RL-10 (c2): `resolve_pvp_turn_if_ready` must exist in pvp.rs");

    assert!(
        resolve_body.contains(settle_needle),
        "m17a-RL-10 (c2) FAIL: `resolve_pvp_turn_if_ready` body must call `{}` in its \
         terminal branch. Without this, the both-submit path bypasses the once-only \
         apply_pvp_rating guarantee (ADR-0119 D3). RED: absent.",
        settle_needle
    );
}

/// RL-10 (c3): apply_pvp_forfeit body must NOT directly call write_back_battle_results.
///
/// After unification into settle_pvp_battle, the direct call in apply_pvp_forfeit
/// is removed (it now happens inside the funnel). A direct call here would cause
/// write_back_battle_results to run twice per forfeit.
///
/// Kills: an impl that delegates to settle_pvp_battle AND keeps the old direct
/// write_back_battle_results call — double write-back.
/// RED now: apply_pvp_forfeit currently calls write_back_battle_results directly
/// (before the funnel is introduced).
#[test]
fn m17a_rl10_forfeit_no_direct_write_back_results() {
    let stripped = strip_rust_comments(PVP_RS);
    let direct_wb_needle = concat!("write_back_battle", "_results(");

    let forfeit_body = extract_pvp_fn_body(&stripped, "apply_pvp_forfeit")
        .expect("m17a-RL-10 (c3): `apply_pvp_forfeit` must exist in pvp.rs");

    assert!(
        !forfeit_body.contains(direct_wb_needle),
        "m17a-RL-10 (c3) FAIL: `apply_pvp_forfeit` body still contains a direct call \
         to `write_back_battle_results`. After unification into settle_pvp_battle, \
         this call must be removed — it now happens inside the funnel. \
         A direct call here causes double write-back on the forfeit path (ADR-0119 D3). \
         RED now: the direct call exists before the funnel is introduced."
    );
}

// ---------------------------------------------------------------------------
// (d) RL-10: ordering preserved inside settle_pvp_battle
//
// ADR-0119 D3 specifies the invariant commit order:
//   1. write_back_battle_results  (while battle row still Ongoing — RT-M16-08)
//   2. battle().battle_id().update  (commit terminal outcome — before side-B HP — RT-M16-05)
//   3. ranking::apply_pvp_rating  (rating applied to just-committed outcome)
//   4. write_back_party_hp_pvp_side_b  (side-B HP write-back)
//
// Tested via text-offset ordering in the settle fn body.
// RED now: settle_pvp_battle does not exist.
// ---------------------------------------------------------------------------

/// RL-10 (d): commit order inside settle_pvp_battle is write_back → update → rating → side_b_hp.
///
/// All four call offsets must be in strictly ascending order.
///
/// Kills: an impl with the wrong ordering (e.g. rating before update, or side-B HP
/// before rating — violating RT-M16-05 or the ADR-0119 D3 step sequence).
/// RED now: settle_pvp_battle does not exist.
#[test]
fn m17a_rl10_settle_pvp_battle_ordering() {
    let stripped = strip_rust_comments(PVP_RS);

    let settle_body = extract_pvp_fn_body(&stripped, "settle_pvp_battle")
        .expect("m17a-RL-10 (d): `settle_pvp_battle` must exist in pvp.rs (RED: absent)");

    let wb_needle = concat!("write_back_battle", "_results(");
    let update_needle = concat!("battle_id()", ".update");
    let rating_needle = concat!("ranking::apply_pvp", "_rating(");
    let side_b_needle = concat!("write_back_party_hp_pvp", "_side_b(");

    let wb_pos = settle_body.find(wb_needle).unwrap_or_else(|| {
        panic!(
            "m17a-RL-10 (d): `{}` not found in settle_pvp_battle body — \
             step 1 (write_back_battle_results) must be present (ADR-0119 D3 step 1)",
            wb_needle
        )
    });
    let update_pos = settle_body.find(update_needle).unwrap_or_else(|| {
        panic!(
            "m17a-RL-10 (d): `{}` not found in settle_pvp_battle body — \
             step 2 (battle row update to terminal state) must be present (ADR-0119 D3 step 2)",
            update_needle
        )
    });
    let rating_pos = settle_body.find(rating_needle).unwrap_or_else(|| {
        panic!(
            "m17a-RL-10 (d): `{}` not found in settle_pvp_battle body — \
             step 3 (apply_pvp_rating) must be present (ADR-0119 D3 step 3)",
            rating_needle
        )
    });
    let side_b_pos = settle_body.find(side_b_needle).unwrap_or_else(|| {
        panic!(
            "m17a-RL-10 (d): `{}` not found in settle_pvp_battle body — \
             step 4 (write_back_party_hp_pvp_side_b) must be present (ADR-0119 D3 step 4)",
            side_b_needle
        )
    });

    assert!(
        wb_pos < update_pos,
        "m17a-RL-10 (d) ORDER FAIL: write_back_battle_results (pos {wb_pos}) must come \
         BEFORE battle().battle_id().update (pos {update_pos}) — RT-M16-08 ordering \
         (GC sweep must not see the current row as terminal)."
    );
    assert!(
        update_pos < rating_pos,
        "m17a-RL-10 (d) ORDER FAIL: battle().battle_id().update (pos {update_pos}) must \
         come BEFORE ranking::apply_pvp_rating (pos {rating_pos}) — rating is applied \
         to the just-committed outcome (ADR-0119 D3 step 3)."
    );
    assert!(
        rating_pos < side_b_pos,
        "m17a-RL-10 (d) ORDER FAIL: ranking::apply_pvp_rating (pos {rating_pos}) must \
         come BEFORE write_back_party_hp_pvp_side_b (pos {side_b_pos}) — \
         side-B HP is the last step; rating is applied first (ADR-0119 D3 steps 3→4)."
    );
}

// ---------------------------------------------------------------------------
// (e) RL-7: server-module/src/ranking.rs module teeth (runtime file read)
//
// The file is read at runtime so a missing file produces a clear red failure.
// Once the file exists, four invariants are checked:
//   (i)  NO #[spacetimedb::reducer] attribute AND no `reducer as` alias binding.
//   (ii) Contains get_or_init_profile and compute_rating_update; exactly 1
//        compute_rating_update call.
//   (iii) Contains INITIAL_RATING and does NOT contain the literal `1000` outside
//         comments (SSOT pin — the constant is the SSOT, not the literal).
//   (iv) Contains is_ranked_pvp( gate.
//
// RED now: file does not exist → read_to_string fails.
// ---------------------------------------------------------------------------

/// RL-7 (e): server-module/src/ranking.rs must exist and satisfy module invariants.
///
/// Teeth:
///   (i)  No #[spacetimedb::reducer] — ranking.rs is module-write-only (ADR-0119 D6).
///        Also no `reducer as ` alias binding (documented evasion).
///   (ii) get_or_init_profile and compute_rating_update present; exactly 1 call.
///   (iii) INITIAL_RATING const present; literal `1000` absent (SSOT — the constant
///         is the single source of truth, not the integer literal).
///   (iv) is_ranked_pvp( gate present (battle classification used before rating write).
///
/// RED now: file does not exist.
#[test]
fn m17a_rl7_server_ranking_module_invariants() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/ranking.rs"))
        .expect(
            "m17a: server-module/src/ranking.rs must exist (RL-7). \
         Create the file with pub(crate) fn apply_pvp_rating and get_or_init_profile. \
         This test is RED because the file is absent.",
        );

    let stripped = strip_rust_comments(&src);

    // (i) No reducer attribute.
    let reducer_attr = concat!("#[spacetimedb::", "reducer");
    assert!(
        !stripped.contains(reducer_attr),
        "m17a-RL-7 (i) FAIL: server-module/src/ranking.rs must NOT contain `{}`. \
         ranking.rs is module-write-only — no client-callable reducer may write profile \
         (ADR-0119 D6). A future name-setter belongs in a separate reducer file.",
        reducer_attr
    );

    // (i-b) No `reducer as` alias binding (documented evasion — ADR-0119 D6).
    let reducer_alias = concat!("reducer", " as ");
    assert!(
        !stripped.contains(reducer_alias),
        "m17a-RL-7 (i-b) FAIL: server-module/src/ranking.rs must NOT contain `{}`. \
         Binding `reducer` to an alias is the documented evasion of the no-reducer scan \
         (ADR-0119 D6). This binding is also forbidden in ranking.rs.",
        reducer_alias
    );

    // (ii) get_or_init_profile present.
    let init_profile = concat!("get_or_init", "_profile");
    assert!(
        stripped.contains(init_profile),
        "m17a-RL-7 (ii) FAIL: server-module/src/ranking.rs must contain `{}` — \
         the total function that finds-or-inserts a profile row (ADR-0119 D1).",
        init_profile
    );

    // (ii) compute_rating_update present and called exactly once.
    let rating_update = concat!("compute_rating", "_update(");
    let call_count = stripped.matches(rating_update).count();
    assert_eq!(
        call_count, 1,
        "m17a-RL-7 (ii) FAIL: server-module/src/ranking.rs must contain exactly 1 call \
         to `{}` — one compute_rating_update call before either row write ensures \
         zero-sum-breaking partial writes are unrepresentable (ADR-0119 D6). \
         Found {} call(s).",
        rating_update, call_count
    );

    // (iii) INITIAL_RATING const present (SSOT).
    let init_rating_const = concat!("INITIAL", "_RATING");
    assert!(
        stripped.contains(init_rating_const),
        "m17a-RL-7 (iii) FAIL: server-module/src/ranking.rs must reference `{}` \
         from game-core rather than the literal 1000 (SSOT pin — ADR-0119 D1).",
        init_rating_const
    );

    // (iii) Literal `1000` must NOT appear outside comments.
    // The stripped source has all comments blanked; any remaining `1000` is a
    // hard-coded literal that bypasses the INITIAL_RATING SSOT.
    assert!(
        !stripped.contains("1000"),
        "m17a-RL-7 (iii) FAIL: server-module/src/ranking.rs contains the literal `1000` \
         outside comments. The initial rating must reference `game_core::INITIAL_RATING` \
         (SSOT), not the bare literal — a future tuning change would silently diverge."
    );

    // (iv) is_ranked_pvp( gate present.
    let ranked_gate = concat!("is_ranked", "_pvp(");
    assert!(
        stripped.contains(ranked_gate),
        "m17a-RL-7 (iv) FAIL: server-module/src/ranking.rs must contain `{}` — \
         apply_pvp_rating must early-return unless the battle is a ranked PvP battle \
         (ADR-0119 D6: no-op unless is_ranked_pvp && outcome decisive).",
        ranked_gate
    );
}

// ---------------------------------------------------------------------------
// (f) RL-2: profile rows are never deleted (never-deleted scan)
//
// Scans the full set of server-module source files for two needles:
//   Needle 1: chained delete form — `.profile().identity().delete`
//   Needle 2: split-binding evasion — `= ctx.db.profile()`
//              (assigns the profile table accessor to a binding, which could then
//               call .delete() — the documented evasion heuristic from ADR-0119 D1)
//
// GREEN-vacuous today (profile table absent → neither needle matches).
// Paired with (g) which requires the table to exist — the pair together is
// meaningful: (f) proves no delete path exists once (g) proves the table exists.
// Note: this test is GREEN-vacuous today but provides regression protection.
//       It will remain GREEN after implementation only if no delete is added.
// ---------------------------------------------------------------------------

/// RL-2 (f): no code path in any server-module source deletes a profile row.
///
/// Two needles:
///   - Chained delete: `profile().identity().delete`
///   - Split-binding evasion: `= ctx.db.profile()`
///
/// GREEN-vacuous today (table absent). Paired with (g) to form a meaningful gate.
/// Kills: any impl that adds a `profile().identity().delete(...)` call anywhere,
/// or that assigns the profile accessor to a binding for later deletion.
#[test]
fn m17a_rl2_profile_never_deleted_scan() {
    let all_sources = [
        ("pvp.rs", PVP_RS),
        ("battle.rs", BATTLE_RS),
        ("lib.rs", LIB_RS),
        ("schema.rs", SCHEMA_RS),
        ("taming.rs", TAMING_RS),
        ("trading.rs", TRADING_RS),
        ("economy.rs", ECONOMY_RS),
        ("monster_mgmt.rs", MONSTER_MGMT_RS),
        ("evolution.rs", EVOLUTION_RS),
        ("raising.rs", RAISING_RS),
        ("npc.rs", NPC_RS),
        ("movement.rs", MOVEMENT_RS),
        ("content.rs", CONTENT_RS),
    ];

    // Needle 1: chained delete form.
    let delete_needle = concat!("profile().identity()", ".delete");
    // Needle 2: split-binding evasion (assign accessor to a local var).
    let binding_needle = concat!("= ctx.db.", "profile()");

    for (filename, src) in &all_sources {
        let stripped = strip_rust_comments(src);

        assert!(
            !stripped.contains(delete_needle),
            "m17a-RL-2 FAIL in {}: found `{}` — profile rows must NEVER be deleted \
             (persistent leaderboard record, ADR-0119 D1). Remove the delete call.",
            filename,
            delete_needle
        );

        assert!(
            !stripped.contains(binding_needle),
            "m17a-RL-2 FAIL in {}: found `{}` — this pattern assigns the profile \
             table accessor to a binding, which could then call .delete(). \
             Profile rows must never be deleted (ADR-0119 D1). \
             Use `ctx.db.profile().identity().find(id)` inline rather than binding \
             the accessor.",
            filename,
            binding_needle
        );
    }
}

// ---------------------------------------------------------------------------
// (g) RL-1/RL-2: profile table exists, is public, has PK identity, and is
//     NOT referenced in the on_disconnect body.
//
// Table existence + public + field shape: RED now (table absent from schema.rs).
// on_disconnect body must contain ZERO occurrences of profile(): GREEN today
//   (on_disconnect body is fixed and does not touch profile).
// ---------------------------------------------------------------------------

/// RL-1/RL-2 (g1): schema.rs must declare `profile` table as public with correct fields.
///
/// Checks:
///   - `name = profile` and `public` on the same attribute line.
///   - `rating: i32` field present.
///   - `wins: u32` field present.
///   - `losses: u32` field present.
///
/// Kills: an impl that makes profile private (leaderboard clients cannot subscribe),
/// or uses wrong field types (e.g. rating: u32 would break negative-rating semantics).
/// RED now: profile table absent from schema.rs.
#[test]
fn m17a_rl1_profile_table_exists_public_correct_fields() {
    let stripped = strip_rust_comments(SCHEMA_RS);

    // Table attribute: `name = profile` AND `public` on the same line.
    let table_name_needle = concat!("name = profile", ", public");
    assert!(
        stripped.contains(table_name_needle),
        "m17a-RL-1 FAIL: schema.rs must contain `{}` — the profile table must be \
         declared as world-readable (public) for leaderboard subscriptions (ADR-0119 D1). \
         RED: table absent.",
        table_name_needle
    );

    // Field: rating: i32
    let rating_field = concat!("rating", ": i32");
    assert!(
        stripped.contains(rating_field),
        "m17a-RL-1 FAIL: Profile must have `{}` — i32 allows negative ratings \
         (no floor at 0 per ADR-0119 D2; u32 would break the spec).",
        rating_field
    );

    // Field: wins: u32
    let wins_field = concat!("wins", ": u32");
    assert!(
        stripped.contains(wins_field),
        "m17a-RL-1 FAIL: Profile must have `{}` (win counter, ADR-0119 D1).",
        wins_field
    );

    // Field: losses: u32
    let losses_field = concat!("losses", ": u32");
    assert!(
        stripped.contains(losses_field),
        "m17a-RL-1 FAIL: Profile must have `{}` (loss counter, ADR-0119 D1).",
        losses_field
    );
}

/// RL-2 (g2): on_disconnect body must NOT reference the profile table accessor.
///
/// If on_disconnect calls `ctx.db.profile()`, it might delete or mutate profile
/// rows during disconnect — violating the never-deleted invariant.
///
/// GREEN today: the current on_disconnect body is fixed and does not touch profile.
/// This is a PINNED PRECONDITION — if on_disconnect is refactored to touch profile,
/// RL-2 is violated and this test catches it.
///
/// Kills: any future refactor that adds a profile cleanup to on_disconnect.
#[test]
fn m17a_rl2_on_disconnect_does_not_touch_profile() {
    let stripped = strip_rust_comments(LIB_RS);

    let disconnect_body = extract_pvp_fn_body(&stripped, "on_disconnect")
        .expect("m17a-RL-2 (g2): `on_disconnect` must exist in lib.rs");

    // The profile table accessor: `profile(` in a method-call position.
    let profile_accessor = concat!("profile", "(");

    assert!(
        !disconnect_body.contains(profile_accessor),
        "m17a-RL-2 (g2) FAIL: `on_disconnect` body contains `{}` — profile rows \
         must never be touched on disconnect (ADR-0119 D1: persistent leaderboard \
         record, never deleted). Remove any profile reference from on_disconnect.",
        profile_accessor
    );
}

// ---------------------------------------------------------------------------
// (h) RL-6: forfeit_on_disconnect routing is structurally clean — no upstream
//     filter that would silently change the friendly-battle classification.
//
// Two sub-checks (PINNED PRECONDITIONS — GREEN today):
//
//   (h1) forfeit_on_disconnect body must NOT contain a player != opponent
//        short-circuit filter (ADR-0119 D4 reviewer M-2 finding):
//          - No `player_identity != b.opponent_identity` in the collection
//          - No `b.player_identity == b.opponent_identity` filter
//        These patterns would filter out practice self-battles BEFORE the
//        outcome != Ongoing re-check, silently changing the routing assumption.
//
//   (h2) forfeit_on_disconnect body must contain at least 2 occurrences of the
//        `outcome != BattleOutcome::Ongoing` re-check guard (one per battle loop —
//        the exactly-once defense that keeps practice battles from rating).
//
// Both GREEN today. Label clearly as pinned preconditions.
// ---------------------------------------------------------------------------

/// RL-6 (h): forfeit_on_disconnect routing pins — no self-battle upstream filter,
/// two Ongoing re-check guards present.
///
/// PINNED PRECONDITION (GREEN today): pins the routing invariant that practice
/// self-battles are not filtered out upstream before the Ongoing re-check.
/// The rating gate (is_ranked_pvp) operates inside apply_pvp_rating, not here.
///
/// Kills (h1): any refactor adding `player_identity != b.opponent_identity` as a
///   collection filter — would silently exclude practice battles before the Ongoing
///   re-check, changing RL-6 semantics.
/// Kills (h2): removal of either Ongoing re-check loop guard — the cross-transaction
///   exactly-once defense would be weakened.
#[test]
fn m17a_rl6_forfeit_on_disconnect_routing_invariant() {
    let stripped = strip_rust_comments(PVP_RS);

    let forfeit_body = extract_pvp_fn_body(&stripped, "forfeit_on_disconnect")
        .expect("m17a-RL-6 (h): `forfeit_on_disconnect` must exist in pvp.rs");

    // (h1a) No `player_identity != b.opponent_identity` collection filter.
    let bad_filter_neq = concat!("player_identity != b.", "opponent_identity");
    assert!(
        !forfeit_body.contains(bad_filter_neq),
        "m17a-RL-6 (h1a) PINNED PRECONDITION BROKEN: `forfeit_on_disconnect` body \
         contains `{}` — this filters out practice self-battles before the Ongoing \
         re-check, silently changing RL-6 routing. Remove the upstream filter; the \
         classification must happen inside apply_pvp_rating via is_ranked_pvp (ADR-0119 D4).",
        bad_filter_neq
    );

    // (h1b) No `b.player_identity == b.opponent_identity` filter.
    let bad_filter_eq = concat!("b.player_identity == b.", "opponent_identity");
    assert!(
        !forfeit_body.contains(bad_filter_eq),
        "m17a-RL-6 (h1b) PINNED PRECONDITION BROKEN: `forfeit_on_disconnect` body \
         contains `{}` — this pattern short-circuits practice self-battles upstream. \
         Remove it; classification is done by is_ranked_pvp inside apply_pvp_rating.",
        bad_filter_eq
    );

    // (h2) At least 2 `outcome != BattleOutcome::Ongoing` re-check guards.
    let ongoing_recheck = concat!("outcome != BattleOutcome::", "Ongoing");
    let recheck_count = forfeit_body.matches(ongoing_recheck).count();
    assert!(
        recheck_count >= 2,
        "m17a-RL-6 (h2) PINNED PRECONDITION BROKEN: `forfeit_on_disconnect` body contains \
         {} occurrence(s) of `{}` but must have >= 2 (one per battle-iteration loop). \
         These re-checks are the cross-transaction exactly-once defense — without them, \
         a battle resolved in a concurrent transaction could be double-forfeited.",
        recheck_count,
        ongoing_recheck
    );
}
