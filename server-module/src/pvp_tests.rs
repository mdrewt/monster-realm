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
//! m17.5e (ADR-0126) — battle_challenge TTL reaper criteria (tests at the
//! bottom of this file; RED until the reaper is implemented):
//!   EA-CHR-01  `challenge_pvp` arms the TTL reaper AFTER the challenge insert,
//!              with the exact args `(ctx, challenge.challenge_id,
//!              challenge.created_at_ms)` (F1 arg-identity pin).
//!   EA-CHR-02  `disarm_challenge_reaper` is called at ALL FOUR
//!              challenge-deletion sites (accept / decline / cancel /
//!              cancel_challenges_on_disconnect).
//!   EA-CHR-03  `battle_challenge_reaper` has the scheduler-only identity guard
//!              (brace-bounded body scan).
//!   EA-CHR-04  `battle_challenge_reaper` re-checks staleness via the
//!              negation-guard shape and deletes via `challenge_id().delete(`
//!              (body-scoped).
//!   EA-CHR-05  `battle_challenge_reaper_schedule` is baselined in
//!              table-schemas.json and its table attribute is PRIVATE.
//!   EA-CHR-06  `schedule_challenge_reaper` computes the deadline from the
//!              ms-floored `created_at_ms` (ADR-0117 D4) and inserts the
//!              schedule row (survivor-pin).
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
//
// m17.5e T0 (plan B1/F3 — STRENGTHENING edit by the tester): the scan is
// re-bounded from the former unbounded suffix slice (`&stripped[fn_pos..]`)
// to the brace-bounded `extract_pvp_fn_body`.  m17.5e introduces a SECOND
// reducer (battle_challenge_reaper) carrying the same guard token; with the
// old suffix scan, a guard in ANY later fn could satisfy this check even if
// pvp_deadline_reaper itself lost its guard.  Narrower scan region only —
// test name, criterion, and assertion message unchanged.
// ---------------------------------------------------------------------------

#[test]
fn ea_pvp_02_deadline_reaper_has_scheduler_guard() {
    // T0 LOW fix (m17.5e red-team): string-strip AFTER comment-strip for
    // consistency with the EA-CHR pipeline (a guard token inside a dead-code
    // string literal cannot satisfy the search).  The brace-bounded body
    // extraction operates on the comment+string-stripped text; the guard token
    // `ctx.sender != ctx.identity()` is not inside any string in pvp.rs so
    // this does not change the match — only closes the pipeline gap.
    let stripped = strip_rust_strings(&strip_rust_comments(PVP_RS));
    // The guard must appear in pvp_deadline_reaper (exact body slice, T0).
    let guard_pattern = concat!("ctx.sender", " != ", "ctx.identity()");
    let fn_body = extract_pvp_fn_body(&stripped, "pvp_deadline_reaper")
        .expect("EA-PVP-02: `pvp_deadline_reaper` function not found in pvp.rs");
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
// ptc5b-T4: on_disconnect calls battle::resolve_wild_battle_on_disconnect
//
// EARS ptc5b-1 (wiring): The `on_disconnect` lifecycle reducer in lib.rs must
// call `battle::resolve_wild_battle_on_disconnect(ctx, me)` so that a player's
// Ongoing WILD battle is GC'd on disconnect (soft-lock prevention).
//
// Co-located with ea_pvp_05 because both scan the same `on_disconnect` body in
// lib.rs for disconnect-lifecycle helper wiring.
//
// RED state: `battle::resolve_wild_battle_on_disconnect` does not yet exist in
// battle.rs, so lib.rs cannot contain the call — the needle is absent today.
//
// PROOF-OF-TEETH: kills any impl that adds resolve_wild_battle_on_disconnect to
// battle.rs but forgets to wire it into on_disconnect, leaving the GC dead code.
// Also kills an impl that calls it from the wrong module (e.g. pvp::resolve_wild…).
// ---------------------------------------------------------------------------

// EARS ptc5b-1
// PROOF-OF-TEETH: kills an impl that adds the fn but omits the on_disconnect call.
#[test]
fn ptc5b_4_wiring_scan_on_disconnect_calls_resolve_wild_battle() {
    let stripped = strip_rust_comments(LIB_RS);
    // Assembled from parts — `resolve_wild_battle_on_disconnect` must not appear
    // verbatim as a single token here, since LIB_RS is lib.rs (not this file),
    // but we follow the concat! convention for consistency and documentation clarity.
    let needle = concat!("battle::", "resolve_wild_battle_on_disconnect");
    assert!(
        stripped.contains(needle),
        "ptc5b-T4 FAIL: `{}` not found in lib.rs. \
         The `on_disconnect` reducer must call `battle::resolve_wild_battle_on_disconnect(ctx, me)` \
         so a player's Ongoing WILD battle is cleaned up on disconnect (soft-lock prevention). \
         Add it immediately after `pvp::forfeit_on_disconnect(ctx, me)` (ptc5b-1 wiring).",
        needle
    );
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
// RT-M16-05: apply_pvp_forfeit must delegate to settle_pvp_battle (M17 rewrite).
//
// Pre-M17 finding (now resolved by the settle_pvp_battle funnel):
//   `apply_pvp_forfeit` used to call `write_back_party_hp_pvp_side_b(…)?`
//   before `ctx.db.battle().battle_id().update(battle)`, risking a stuck-Ongoing
//   battle if the HP write-back returned Err.
//
// Post-M17 invariant (ADR-0119 D3):
//   apply_pvp_forfeit must NOT contain the direct `write_back_party_hp_pvp_side_b`
//   call or the `battle().battle_id().update` call — both now live inside
//   settle_pvp_battle. apply_pvp_forfeit must delegate via `settle_pvp_battle(`.
//   The ordering contract (write_back → update → rating → side_b) is pinned by
//   m17a_rl10_settle_pvp_battle_ordering.
//
// NOTE (B-1): The pre-M17 version used an unbounded slice from `fn_pos` that,
// after the M17 pvp.rs reorder (forfeit now above resolve), swept into
// settle_pvp_battle's body and matched the wrong positions. Rewritten to use
// extract_pvp_fn_body for an exact body slice.
// ---------------------------------------------------------------------------

#[test]
fn rt_m16_05_apply_pvp_forfeit_updates_battle_before_propagating_writeback_err() {
    let stripped = strip_rust_comments(PVP_RS);

    // Use extract_pvp_fn_body for an exact, bounded body slice (B-1 fix).
    let forfeit_body = extract_pvp_fn_body(&stripped, "apply_pvp_forfeit")
        .expect("RT-M16-05: `apply_pvp_forfeit` must exist in pvp.rs");

    // Post-M17: apply_pvp_forfeit must delegate to settle_pvp_battle.
    let settle_needle = concat!("settle_pvp", "_battle(");
    assert!(
        forfeit_body.contains(settle_needle),
        "RT-M16-05 FAIL: `apply_pvp_forfeit` body must contain `{}` — delegation to \
         the single funnel is required post-M17 (ADR-0119 D3). Without it the \
         RT-M16-05 stuck-Ongoing risk is not resolved.",
        settle_needle
    );

    // Post-M17: direct write_back_party_hp_pvp_side_b must NOT appear in forfeit body
    // (it now lives inside settle_pvp_battle — a direct call here would double-run it).
    let side_b_needle = concat!("write_back_party_hp_pvp", "_side_b");
    assert!(
        !forfeit_body.contains(side_b_needle),
        "RT-M16-05 FAIL: `apply_pvp_forfeit` body still contains a direct `{}` call — \
         this was moved into settle_pvp_battle (ADR-0119 D3). A direct call here \
         reintroduces the stuck-Ongoing risk and causes double write-back.",
        side_b_needle
    );

    // Post-M17: direct battle().battle_id().update must NOT appear in forfeit body
    // (also moved into settle_pvp_battle).
    let update_needle = concat!("battle().battle_id()", ".update");
    assert!(
        !forfeit_body.contains(update_needle),
        "RT-M16-05 FAIL: `apply_pvp_forfeit` body still contains a direct `{}` call — \
         the battle row update was moved into settle_pvp_battle (ADR-0119 D3). \
         A direct call here bypasses the funnel ordering guarantee.",
        update_needle
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
// RT-M16-08: resolve_pvp_turn_if_ready must delegate to settle_pvp_battle (M17 rewrite).
//
// Pre-M17 finding (now resolved by the settle_pvp_battle funnel):
//   `resolve_pvp_turn_if_ready` called `ctx.db.battle().battle_id().update(battle)`
//   BEFORE `write_back_battle_results`, causing the GC sweep inside write_back to
//   include the current (now-terminal) battle row and delete it — clients saw the
//   battle disappear rather than a terminal outcome frame.
//
// Post-M17 invariant (ADR-0119 D3):
//   resolve_pvp_turn_if_ready must NOT contain direct calls to
//   `write_back_battle_results(` or `battle().battle_id().update` — both now
//   live inside settle_pvp_battle. resolve_pvp_turn_if_ready must delegate via
//   `settle_pvp_battle(`. The correct ordering (write_back → update → rating →
//   side_b) is pinned by m17a_rl10_settle_pvp_battle_ordering.
//
// NOTE (B-2): The pre-M17 version used a bounded slice resolved by finding
// `fn apply_pvp_forfeit` after fn_pos — after the M17 pvp.rs reorder (forfeit
// is now ABOVE resolve in the file), the forward search found no `apply_pvp_forfeit`
// after resolve's start, so next_fn_pos fell back to stripped.len() and the slice
// swept to EOF (into settle_pvp_battle's body), producing wrong offset comparisons.
// Rewritten to use extract_pvp_fn_body for an exact body slice.
// ---------------------------------------------------------------------------

#[test]
fn rt_m16_08_resolve_pvp_turn_if_ready_calls_writeback_before_battle_update() {
    let stripped = strip_rust_comments(PVP_RS);

    // Use extract_pvp_fn_body for an exact, bounded body slice (B-2 fix).
    let resolve_body = extract_pvp_fn_body(&stripped, "resolve_pvp_turn_if_ready")
        .expect("RT-M16-08: `resolve_pvp_turn_if_ready` must exist in pvp.rs");

    // Post-M17: resolve_pvp_turn_if_ready must NOT contain a direct write_back_battle_results
    // call (now inside settle_pvp_battle — a direct call here bypasses the funnel ordering).
    let wb_needle = concat!("write_back_battle", "_results(");
    assert!(
        !resolve_body.contains(wb_needle),
        "RT-M16-08 FAIL: `resolve_pvp_turn_if_ready` body still contains a direct `{}` call — \
         this was moved into settle_pvp_battle (ADR-0119 D3). A direct call here reintroduces \
         the RT-M16-08 GC-sweep ordering violation (battle row committed terminal before \
         write_back GC sweep runs, deleting the current row).",
        wb_needle
    );

    // Post-M17: resolve_pvp_turn_if_ready must NOT contain a direct battle row update
    // (also moved into settle_pvp_battle).
    let update_needle = concat!("battle().battle_id()", ".update");
    assert!(
        !resolve_body.contains(update_needle),
        "RT-M16-08 FAIL: `resolve_pvp_turn_if_ready` body still contains a direct `{}` call — \
         the battle row update was moved into settle_pvp_battle (ADR-0119 D3). \
         A direct call here bypasses the funnel and reintroduces the ordering violation.",
        update_needle
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
// F2/M-2: additional domain files for single-callsite scope widening.
const CONTENT_CACHE_RS: &str = include_str!("content_cache.rs");
const MARSHAL_RS: &str = include_str!("marshal.rs");
const GUARDS_RS: &str = include_str!("guards.rs");
const INVENTORY_RS: &str = include_str!("inventory.rs");

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
    // F2/M-2 hardening: count the bare needle across ALL non-test domain files,
    // not just pvp.rs + battle.rs + lib.rs. An implementer could introduce a
    // second call site in any module (economy, trading, raising, guards, etc.).
    // Expected total across ALL non-pvp files: 0.
    // Expected count in pvp.rs with path-qualifier: exactly 1.

    // Needle: the path-qualified call form (one and only acceptable form in pvp.rs).
    let call_needle = concat!("ranking::apply_pvp", "_rating(");
    // Bare identifier needle (must not appear in any non-pvp domain file).
    let bare_needle = concat!("apply_pvp", "_rating");

    // Count path-qualified calls in pvp.rs — expect exactly 1.
    let stripped_pvp = strip_rust_comments(PVP_RS);
    let pvp_call_count = stripped_pvp.matches(call_needle).count();
    assert_eq!(
        pvp_call_count, 1,
        "m17a-RL-10 FAIL: expected exactly 1 path-qualified call `{}` in pvp.rs, \
         found {}. There must be exactly one call site (settle_pvp_battle) to \
         guarantee exactly-once rating application (ADR-0119 D3).",
        call_needle, pvp_call_count
    );

    // Count bare identifier across ALL other non-test domain files — expect 0 each.
    // F2: widened from battle.rs+lib.rs to the full domain set.
    let non_pvp_domain: &[(&str, &str)] = &[
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
        ("content_cache.rs", CONTENT_CACHE_RS),
        ("marshal.rs", MARSHAL_RS),
        ("guards.rs", GUARDS_RS),
        ("inventory.rs", INVENTORY_RS),
    ];
    for (filename, src) in non_pvp_domain {
        let stripped = strip_rust_comments(src);
        let count = stripped.matches(bare_needle).count();
        assert_eq!(
            count, 0,
            "m17a-RL-10 FAIL: found {} occurrence(s) of `{}` in {} — \
             only pvp.rs may reference apply_pvp_rating; all other domain files \
             must never call it (rating application funnels through settle_pvp_battle \
             in pvp.rs, ADR-0119 D3). F2: full domain sweep.",
            count, bare_needle, filename
        );
    }
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

/// RL-10 (d): commit order inside settle_pvp_battle is write_back → update → rating →
/// side_b_hp → battle_action sweep (step 5).
///
/// Five steps must be in strictly ascending text-offset order:
///   1. write_back_battle_results  (while battle row still Ongoing — RT-M16-08)
///   2. battle().battle_id().update  (commit terminal outcome)
///   3. ranking::apply_pvp_rating  (rating on just-committed outcome)
///   4. write_back_party_hp_pvp_side_b  (side-B HP write-back)
///   5. battle_action sweep: battle_action().battle_id().iter() + .delete()
///      (GC of submitted actions — must come AFTER side-B HP, ADR-0119 D3 step 5)
///
/// m-4 hardening: step 5 sweep pin added (battle_action GC after side_b_hp).
///
/// Kills: an impl with the wrong ordering (e.g. rating before update, side-B HP
/// before rating, or battle_action GC before side-B HP write-back).
/// RED now: settle_pvp_battle does not exist.
#[test]
fn m17a_rl10_settle_pvp_battle_ordering() {
    let stripped = strip_rust_comments(PVP_RS);

    let settle_body = extract_pvp_fn_body(&stripped, "settle_pvp_battle")
        .expect("m17a-RL-10 (d): `settle_pvp_battle` must exist in pvp.rs (RED: absent)");

    let wb_needle = concat!("write_back_battle", "_results(");
    let update_needle = concat!("battle().battle_id()", ".update");
    let rating_needle = concat!("ranking::apply_pvp", "_rating(");
    let side_b_needle = concat!("write_back_party_hp_pvp", "_side_b(");
    // Step 5: battle_action GC sweep — iter() over actions by battle_id then delete.
    let sweep_iter_needle = concat!("battle_action()", ".battle_id()");
    let sweep_delete_needle = concat!("battle_action()", ".delete");

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
    // Step 5: battle_action sweep (m-4 hardening).
    let sweep_iter_pos = settle_body.find(sweep_iter_needle).unwrap_or_else(|| {
        panic!(
            "m17a-RL-10 (d): `{}` not found in settle_pvp_battle body — \
             step 5 (battle_action GC sweep iter) must be present (ADR-0119 D3 step 5)",
            sweep_iter_needle
        )
    });
    let sweep_delete_pos = settle_body.find(sweep_delete_needle).unwrap_or_else(|| {
        panic!(
            "m17a-RL-10 (d): `{}` not found in settle_pvp_battle body — \
             step 5 (battle_action GC sweep delete) must be present (ADR-0119 D3 step 5)",
            sweep_delete_needle
        )
    });

    assert!(
        wb_pos < update_pos,
        "m17a-RL-10 (d) ORDER FAIL: write_back_battle_results (pos {}) must come \
         BEFORE battle().battle_id().update (pos {}) — RT-M16-08 ordering \
         (GC sweep must not see the current row as terminal).",
        wb_pos,
        update_pos
    );
    assert!(
        update_pos < rating_pos,
        "m17a-RL-10 (d) ORDER FAIL: battle().battle_id().update (pos {}) must \
         come BEFORE ranking::apply_pvp_rating (pos {}) — rating is applied \
         to the just-committed outcome (ADR-0119 D3 step 3).",
        update_pos,
        rating_pos
    );
    assert!(
        rating_pos < side_b_pos,
        "m17a-RL-10 (d) ORDER FAIL: ranking::apply_pvp_rating (pos {}) must \
         come BEFORE write_back_party_hp_pvp_side_b (pos {}) — \
         side-B HP is the last step; rating is applied first (ADR-0119 D3 steps 3→4).",
        rating_pos,
        side_b_pos
    );
    // m-4: step-5 sweep must come AFTER side-B HP write-back.
    assert!(
        side_b_pos < sweep_iter_pos,
        "m17a-RL-10 (d) ORDER FAIL (m-4): write_back_party_hp_pvp_side_b (pos {}) must come \
         BEFORE the battle_action GC sweep iter (pos {}) — the sweep is the final cleanup \
         step after all writes are committed (ADR-0119 D3 step 5).",
        side_b_pos,
        sweep_iter_pos
    );
    assert!(
        sweep_iter_pos <= sweep_delete_pos,
        "m17a-RL-10 (d) ORDER FAIL (m-4): battle_action sweep iter (pos {}) must not come \
         AFTER the delete call (pos {}) — iter precedes delete in the sweep loop.",
        sweep_iter_pos,
        sweep_delete_pos
    );
}

// ---------------------------------------------------------------------------
// (e) RL-7: server-module/src/ranking.rs module teeth (runtime file read)
//
// The file is read at runtime so a missing file produces a clear red failure.
// Once the file exists, four invariants are checked:
//   (i)  EXACTLY ONE #[spacetimedb::reducer] attribute (the set_profile_name
//        name-setter, ADR-0132) AND no `reducer as` alias binding, AND the
//        single reducer `set_profile_name` is profile-untouching.
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
///   (i)   EXACTLY ONE #[spacetimedb::reducer] — ranking.rs declares one
///         client-callable reducer, the profile-untouching `set_profile_name`
///         name-setter (ADR-0132 refines ADR-0119 D6's "zero reducers" to
///         "exactly one profile-untouching name-setter"; the security property
///         "no client-callable reducer writes profile rating/W/L" is preserved
///         because the one reducer touches no profile table at all).
///   (i-a) The single reducer is named `set_profile_name`.
///   (i-b) No `reducer as ` alias binding (documented evasion).
///   (i-c) The `set_profile_name` body is profile-untouching: it contains none
///         of `profile().identity()`, `profile().insert`, `get_or_init_profile(`,
///         `refresh_profile_name(`, `= ctx.db.profile()` (allowlist name-only
///         write; ADR-0132 D3, red-team F1/F2/F3).
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

    // (i) EXACTLY ONE reducer attribute (the set_profile_name name-setter).
    // ADR-0132 refines ADR-0119 D6's original "zero reducers" tooth: the
    // name-setter lives IN ranking.rs (eval A2 couples all profile access here;
    // the declared touch-set is ranking.rs) rather than in a separate reducer
    // file. The module-write-only security property is preserved — the one
    // allowed reducer is profile-untouching (checked by (i-c) below).
    let reducer_attr = concat!("#[spacetimedb::", "reducer");
    let reducer_attr_count = stripped.matches(reducer_attr).count();
    assert_eq!(
        reducer_attr_count, 1,
        "m17a-RL-7 (i) FAIL: server-module/src/ranking.rs must contain EXACTLY 1 `{}` — \
         the single client-callable reducer is the profile-untouching `set_profile_name` \
         name-setter (ADR-0132 refines ADR-0119 D6). Found {} occurrence(s). \
         0 = the reducer is missing (RED pre-impl); >1 = an extra reducer was added, \
         which would need its own review (the module-write-only property forbids any \
         reducer that writes profile rating/W/L).",
        reducer_attr, reducer_attr_count
    );

    // (i-a) The single reducer is named `set_profile_name`.
    // Split "set_profile" across concat! fragments to avoid self-match when
    // pvp_tests.rs is accidentally scanned by the never-deleted repo scan.
    let name_setter_fn = concat!("fn set_profile", "_name(");
    assert!(
        stripped.contains(name_setter_fn),
        "m17a-RL-7 (i-a) FAIL: server-module/src/ranking.rs must contain `{}` — \
         the single reducer must be the name-setter `set_profile_name` (ADR-0132 D1). \
         RED pre-impl: the reducer does not yet exist.",
        name_setter_fn
    );

    // (i-c) The `set_profile_name` body is PROFILE-UNTOUCHING (allowlist name-only
    // write; ADR-0132 D3, red-team F1/F2/F3). Extract the exact brace-bounded body
    // and assert it contains NONE of the profile needles. Needles are split via
    // concat! to prevent self-match. This is the core safety property: the one
    // allowed reducer must not read or write the profile table at all — no eager
    // profile update (F1/F2), no leaderboard-row injection via get_or_init_profile
    // /profile().insert (F3), no split-binding profile accessor.
    let name_setter_body =
        extract_pvp_fn_body(&stripped, "set_profile_name").unwrap_or_else(|| {
            panic!(
                "m17a-RL-7 (i-c): `set_profile_name` function not found in ranking.rs — \
             the reducer must exist for the profile-untouching body check to be \
             meaningful (ADR-0132 D1). RED pre-impl: the reducer does not yet exist."
            )
        });
    for profile_needle in &[
        concat!("profile().", "identity()"),
        concat!("profile().", "insert"),
        concat!("get_or_init", "_profile("),
        concat!("refresh_profile", "_name("),
        concat!("= ctx.db.", "profile()"),
    ] {
        assert!(
            !name_setter_body.contains(profile_needle),
            "m17a-RL-7 (i-c) FAIL: the body of `set_profile_name` in ranking.rs contains \
             `{}` — the name-setter must be PROFILE-UNTOUCHING (ADR-0132 D3). It writes \
             only `player.name` and relies on the ADR-0125 passive mirror to surface the \
             rename on the leaderboard at the next rated game. Any profile read/write here \
             either adds a third profile update (breaks the ==2 pin) or injects a \
             rating-1000 leaderboard row for an unrated player (red-team F1/F2/F3).",
            profile_needle
        );
    }

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

    // (iv-F10) is_ranked_pvp( gate present INSIDE apply_pvp_rating body.
    // Hardening F10: check against the body slice, not the whole file, so a
    // reference to is_ranked_pvp in a comment or a different function does not
    // satisfy this assertion.
    let ranked_gate = concat!("is_ranked", "_pvp(");
    let apply_body = extract_pvp_fn_body(&stripped, "apply_pvp_rating").unwrap_or_else(|| {
        panic!(
            "m17a-RL-7 (iv): `apply_pvp_rating` function not found in ranking.rs — \
             the function must exist for gate-placement checks to be meaningful (ADR-0119 D6)."
        )
    });
    assert!(
        apply_body.contains(ranked_gate),
        "m17a-RL-7 (iv) FAIL: the body of `apply_pvp_rating` in ranking.rs must contain \
         `{}` — apply_pvp_rating must early-return unless the battle is a ranked PvP battle \
         (ADR-0119 D6: no-op unless is_ranked_pvp && outcome decisive). \
         F10: checked against the function body, not the whole file.",
        ranked_gate
    );

    // (v-B1/F4) RL-5: apply_pvp_rating body must increment wins and losses counters
    // using saturating_add (panic-proof, consistent with saturating rating arithmetic).
    // Kills: an impl that updates rating but forgets to track win/loss counts
    // (leaderboard would show ratings but no W/L record — spec RL-5 violation).
    // Needle updated (F4): `.wins + 1` → `.wins.saturating_add(1)` to match the
    // implementer's panic-proof counter increment (consistent with rating handling).
    let wins_needle = concat!(".wins.saturating_", "add(1)");
    assert!(
        apply_body.contains(wins_needle),
        "m17a-RL-5 (v) FAIL: `apply_pvp_rating` body must contain `{}` — \
         the profile wins counter must be incremented with saturating_add on a win \
         (ADR-0119 D1, RL-5; panic-proof, consistent with rating arithmetic). \
         Without this, the leaderboard shows only ratings, not W/L counts.",
        wins_needle
    );
    let losses_needle = concat!(".losses.saturating_", "add(1)");
    assert!(
        apply_body.contains(losses_needle),
        "m17a-RL-5 (v) FAIL: `apply_pvp_rating` body must contain `{}` — \
         the profile losses counter must be incremented with saturating_add on a loss \
         (ADR-0119 D1, RL-5; panic-proof, consistent with rating arithmetic). \
         Without this, the leaderboard shows only ratings, not W/L counts.",
        losses_needle
    );

    // (vi-F3) RL-2: apply_pvp_rating body must NOT delete profile rows.
    // Kills: an impl that deletes the loser's profile row on a loss (would violate
    // the persistent-leaderboard invariant — ADR-0119 D1).
    let delete_needle = concat!("profile().identity()", ".delete");
    assert!(
        !apply_body.contains(delete_needle),
        "m17a-RL-2 (vi) FAIL: `apply_pvp_rating` body contains `{}` — \
         profile rows must NEVER be deleted (persistent leaderboard, ADR-0119 D1). \
         Remove the delete call from apply_pvp_rating.",
        delete_needle
    );
    // Also check for the split-binding evasion inside the function body.
    let binding_needle = concat!("= ctx.db.", "profile()");
    assert!(
        !apply_body.contains(binding_needle),
        "m17a-RL-2 (vi) FAIL: `apply_pvp_rating` body contains `{}` — \
         assigning the profile accessor to a binding risks a .delete() call. \
         Use inline chained access: `ctx.db.profile().identity().find(id)` (ADR-0119 D1).",
        binding_needle
    );

    // (vii-F5) Dormancy gate: ranking.rs must declare its test module.
    // This ensures the dormant ranking_tests.rs file is wired in and executed
    // when the server-module tests run. Without this declaration the tests in
    // ranking_tests.rs are silently dropped.
    let mod_decl = concat!("mod ranking", "_tests");
    assert!(
        stripped.contains(mod_decl),
        "m17a-RL-7 (vii) FAIL: server-module/src/ranking.rs must contain `{}` — \
         the test module declaration that wires ranking_tests.rs into the test suite. \
         Add: `#[cfg(test)] #[path = \"ranking_tests.rs\"] mod ranking_tests;` \
         at the bottom of ranking.rs (ADR-0119 D6, dormancy gate).",
        mod_decl
    );

    // (viii-F9) Compute-before-write: compute_rating_update must appear BEFORE
    // any profile row write (insert or update) in apply_pvp_rating.
    // This guarantees zero-sum-breaking partial writes are unrepresentable:
    // if compute_rating_update panics, no profile row has been written yet.
    let compute_pos = apply_body
        .find(concat!("compute_rating", "_update("))
        .unwrap_or_else(|| {
            panic!(
                "m17a-RL-7 (viii): `compute_rating_update(` not found in apply_pvp_rating body — \
                 required for compute-before-write ordering check (ADR-0119 D6)."
            )
        });

    // First profile row write: either .update( or .insert(
    let update_needle = concat!("profile().identity().", "update(");
    let insert_needle = concat!("profile().", "insert(");
    let first_write_pos = match (
        apply_body.find(update_needle),
        apply_body.find(insert_needle),
    ) {
        (Some(u), Some(i)) => u.min(i),
        (Some(u), None) => u,
        (None, Some(i)) => i,
        (None, None) => panic!(
            "m17a-RL-7 (viii): no profile write (`{}` or `{}`) found in apply_pvp_rating body — \
             the function must write at least one profile row (ADR-0119 D6).",
            update_needle, insert_needle
        ),
    };

    assert!(
        compute_pos < first_write_pos,
        "m17a-RL-7 (viii) ORDER FAIL: `compute_rating_update(` (pos {}) must appear BEFORE \
         the first profile row write (pos {}) in `apply_pvp_rating`. \
         Compute the new ratings first, then write both rows atomically — \
         if the compute panics, no partial write occurs (ADR-0119 D6 F9).",
        compute_pos,
        first_write_pos
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
/// F4+F8/M-3 hardening — two-step pattern:
///   Step 1: find the line containing `name = profile` and verify it also contains `public`.
///           This is a robustness improvement over a single `name = profile, public` needle:
///           it catches orderings like `public, name = profile` and avoids a brittle
///           attribute-argument-order dependency.
///   Step 2: verify field needles `identity: Identity`, `name: String`, `rating: i32`,
///           `wins: u32`, `losses: u32` are present in the schema.
///   Step 3: verify `#[primary_key]` appears before the `identity` field text in the
///           schema (PK ordering — the first annotated field must be the primary key).
///
/// Kills: an impl that makes profile private (leaderboard clients cannot subscribe),
/// or uses wrong field types (e.g. rating: u32 would break negative-rating semantics),
/// or omits required fields, or reorders PK annotation incorrectly.
/// RED now: profile table absent from schema.rs.
#[test]
fn m17a_rl1_profile_table_exists_public_correct_fields() {
    let stripped = strip_rust_comments(SCHEMA_RS);

    // Step 1 (F4): find the line containing `name = profile` and assert it also
    // contains `public`. This tolerates attribute argument reordering.
    let name_needle = concat!("name = ", "profile");
    let profile_line = stripped
        .lines()
        .find(|line| line.contains(name_needle))
        .unwrap_or_else(|| {
            panic!(
                "m17a-RL-1 FAIL: schema.rs has no line containing `{}` — \
                 the profile table declaration is absent (ADR-0119 D1). RED.",
                name_needle
            )
        });
    assert!(
        profile_line.contains("public"),
        "m17a-RL-1 FAIL: the profile table attribute line `{}` does not contain `public` — \
         the table must be world-readable for leaderboard subscriptions (ADR-0119 D1). \
         Add `public` to the #[spacetimedb::table(...)] attribute.",
        profile_line.trim()
    );

    // Step 2 (F8): required struct fields.

    // Field: identity: Identity (the PK field — SpacetimeDB identity type)
    let identity_field = concat!("identity", ": Identity");
    assert!(
        stripped.contains(identity_field),
        "m17a-RL-1 FAIL: Profile struct must have `{}` — the owner identity \
         (primary key for the profile table, ADR-0119 D1).",
        identity_field
    );

    // Field: name: String (display name — RL-1)
    let name_field = concat!("name", ": String");
    assert!(
        stripped.contains(name_field),
        "m17a-RL-1 FAIL: Profile struct must have `{}` — the player display name \
         (ADR-0119 D1, RL-1).",
        name_field
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

    // Step 3 (F8): `#[primary_key]` must appear BEFORE `identity: Identity` in the schema.
    // Kills: a struct where identity is declared without a primary_key annotation, or
    // where the annotation appears on a different field.
    let pk_needle = concat!("#[primary", "_key]");
    let pk_pos = stripped.find(pk_needle).unwrap_or_else(|| {
        panic!(
            "m17a-RL-1 FAIL: schema.rs has no `{}` annotation — the profile table \
             must declare a primary key on the identity field (ADR-0119 D1).",
            pk_needle
        )
    });
    let identity_pos = stripped.find(identity_field).expect("confirmed above");
    assert!(
        pk_pos < identity_pos,
        "m17a-RL-1 FAIL: `{}` (pos {}) must appear BEFORE `{}` (pos {}) in schema.rs — \
         the primary_key annotation must precede the identity field declaration. \
         An impl where #[primary_key] is on a different field, or after identity, \
         violates the ADR-0119 D1 schema contract.",
        pk_needle,
        pk_pos,
        identity_field,
        identity_pos
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

    // m-2 hardening: require the db-accessor form `ctx.db.profile(` rather than
    // the bare `profile(` — the bare form would also match function names containing
    // "profile" (e.g. `get_or_init_profile(`) and produce a false positive.
    // Only a `ctx.db.profile(` call in on_disconnect would actually touch the table.
    let profile_accessor = concat!("ctx.db.", "profile(");

    assert!(
        !disconnect_body.contains(profile_accessor),
        "m17a-RL-2 (g2) FAIL: `on_disconnect` body contains `{}` — this accesses the \
         profile table on disconnect, which risks deleting or mutating profile rows \
         (ADR-0119 D1: persistent leaderboard record, never deleted). \
         Remove any ctx.db.profile() access from on_disconnect. (m-2 needle hardening)",
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

// ---------------------------------------------------------------------------
// RT-M17-01: apply_pvp_rating winner/loser identity mapping is correct for both
// SideAWins and SideBWins.
//
// Finding: the existing tests for apply_pvp_rating only assert TEXT patterns
// (`.wins + 1` and `.losses + 1` present in the function body). They do NOT verify
// WHICH identity variable receives wins vs losses. A swap of the two arms:
//   SideBWins => (battle.player_identity, battle.opponent_identity)  // WRONG
// would make the challenger "win" every time the opponent wins, silently
// mis-attributing ratings and W/L counts. The text-scan tests would still pass.
//
// This test pins the EXACT identity-to-side mapping in the apply_pvp_rating body:
//   SideAWins => winner = player_identity, loser = opponent_identity
//   SideBWins => winner = opponent_identity, loser = player_identity
//
// Two complementary needle checks:
//   (i)  SideAWins arm assigns player_identity to the winner variable (tuple position 0).
//   (ii) SideBWins arm assigns opponent_identity to the winner variable (tuple position 0).
//
// Kills: any impl that swaps the tuple fields in either arm, giving the challenger's
// profile a win when the opponent wins (or the reverse).
// ---------------------------------------------------------------------------

/// RT-M17-01: apply_pvp_rating winner/loser identity mapping — SideAWins arm.
///
/// The SideAWins arm must assign `battle.player_identity` (the challenger, side A)
/// as the winner and `battle.opponent_identity` as the loser.
/// Needle: `SideAWins => (battle.player_identity, battle.opponent_identity)`
///
/// Kills: an impl where both arms use player_identity as winner (would never credit the
/// opponent's profile when they win), or where the tuple fields are reversed in this arm.
#[test]
fn rt_m17_01_apply_pvp_rating_side_a_wins_maps_player_to_winner() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/ranking.rs"))
        .expect("RT-M17-01: server-module/src/ranking.rs must exist");
    let stripped = strip_rust_comments(&src);

    let apply_body = extract_pvp_fn_body(&stripped, "apply_pvp_rating")
        .expect("RT-M17-01: `apply_pvp_rating` must exist in ranking.rs");

    // Needle: the SideAWins arm must list player_identity FIRST (winner) and
    // opponent_identity SECOND (loser) in the tuple. Built with concat! so this file
    // does not self-match when apply_pvp_rating is later inlined or moved.
    let side_a_needle = concat!(
        "SideAWins => (battle.player_identity, battle.",
        "opponent_identity)"
    );
    assert!(
        apply_body.contains(side_a_needle),
        "RT-M17-01 FAIL: `apply_pvp_rating` body does not contain the expected SideAWins arm \
         `{}`. The SideAWins arm must map player_identity to winner and opponent_identity to \
         loser: challenger (side A) won, so challenger's profile gains wins+1 and opponent's \
         gains losses+1. A swapped arm credits the wrong profile. (ADR-0119 D6, RL-5)",
        side_a_needle
    );
}

/// RT-M17-01: apply_pvp_rating winner/loser identity mapping — SideBWins arm.
///
/// The SideBWins arm must assign `battle.opponent_identity` (the opponent, side B)
/// as the winner and `battle.player_identity` as the loser.
/// Needle: `SideBWins => (battle.opponent_identity, battle.player_identity)`
///
/// Kills: an impl that keeps both arms using player_identity as winner (the common
/// copy-paste mistake), or one where the SideBWins arm reverses the tuple.
#[test]
fn rt_m17_01_apply_pvp_rating_side_b_wins_maps_opponent_to_winner() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/ranking.rs"))
        .expect("RT-M17-01: server-module/src/ranking.rs must exist");
    let stripped = strip_rust_comments(&src);

    let apply_body = extract_pvp_fn_body(&stripped, "apply_pvp_rating")
        .expect("RT-M17-01: `apply_pvp_rating` must exist in ranking.rs");

    // Needle: the SideBWins arm must list opponent_identity FIRST (winner) and
    // player_identity SECOND (loser).
    let side_b_needle = concat!(
        "SideBWins => (battle.opponent_identity, battle.",
        "player_identity)"
    );
    assert!(
        apply_body.contains(side_b_needle),
        "RT-M17-01 FAIL: `apply_pvp_rating` body does not contain the expected SideBWins arm \
         `{}`. The SideBWins arm must map opponent_identity to winner and player_identity to \
         loser: the opponent (side B) won, so their profile gains wins+1 and the challenger \
         gains losses+1. A swapped arm would give the challenger a win credit when they lost. \
         (ADR-0119 D6, RL-5)",
        side_b_needle
    );
}

// ===========================================================================
// m17.5e (ADR-0126): battle_challenge TTL reaper — EA-CHR-01..06
//
// A Pending battle_challenge row locks BOTH parties out of new challenges
// (challenge_pvp guards 5b/6); an AFK or disconnected challenger would leave
// that lock in place forever.  The TTL reaper (clone of the m16.5f
// trade_offer_reaper, ADR-0117) bounds that window.
//
// Machinery: `strip_rust_strings` (ADR-0116-hardened shape cloned from
// trading_tests.rs, incl. the backslash-escape branch that also consumes a
// backslash-newline line continuation) + `squash_ws` (m17.5d mandatory,
// ADR-0125) + the existing brace-bounded `extract_pvp_fn_body`.
//
// Scan pipeline for EVERY test below (plan T2): strip comments → strip
// strings → extract the fn body (brace-bounded, NEVER a suffix scan) →
// squash_ws for composite needles.  All needles are concat!-split so this
// file can never satisfy a scan by matching itself.
//
// RED now (m17.5e tester phase): `schedule_challenge_reaper`,
// `disarm_challenge_reaper`, `battle_challenge_reaper`, and
// `battle_challenge_reaper_schedule` do not exist in pvp.rs — every EA-CHR
// test below panics with a named FAIL message.
// ===========================================================================

/// String-literal stripping helper (Finding C, ADR-0116-hardened shape cloned
/// from `strip_rust_strings_trading` in trading_tests.rs).  Replaces the
/// CONTENT of every `"…"` string literal (keeping the quotes) so a needle like
/// `schedule_challenge_reaper(` cannot be hidden inside a dead-code string
/// literal such as `let _dead = "schedule_challenge_reaper(";`.
///
/// The escape branch consumes the backslash AND the byte after it — including
/// a backslash-newline line continuation (the m16.5e string-strip trap) — so a
/// continuation string cannot desynchronise the byte-walker.
///
/// IMPORTANT: call AFTER `strip_rust_comments` so string literals inside
/// comments (already blanked) do not trip the walker.  Raw strings (`r#"…"#`)
/// are NOT handled — acceptable: production pvp.rs contains none.
fn strip_rust_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;
    while i < len {
        if bytes[i] == b'"' {
            // Emit the opening quote, then swallow until the closing (unescaped) quote.
            out.push(b'"');
            i += 1;
            while i < len {
                if bytes[i] == b'\\' {
                    // Escape sequence: consume both the backslash and the next
                    // byte (incl. a backslash-newline line continuation).
                    i += 2;
                } else if bytes[i] == b'"' {
                    out.push(b'"');
                    i += 1;
                    break;
                } else {
                    // Swallow the character (shrinks the string).
                    i += 1;
                }
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).expect("string-stripped source must be valid UTF-8")
}

/// Remove ALL whitespace characters (m17.5d mandatory third pipeline stage,
/// ADR-0125 red-team F1): makes composite-needle matching rustfmt-proof — a
/// call split across lines by rustfmt still matches a squashed needle.
fn squash_ws(src: &str) -> String {
    src.chars().filter(|c| !c.is_whitespace()).collect()
}

/// m17.5e scan input: pvp.rs with comments stripped THEN strings stripped
/// (plan T2 pipeline order).  Body extraction happens on this text (braces and
/// `fn ` tokens still have their whitespace); `squash_ws` is applied to the
/// EXTRACTED body for composite needles.
fn stripped_pvp_for_scan() -> String {
    strip_rust_strings(&strip_rust_comments(PVP_RS))
}

// ---------------------------------------------------------------------------
// EA-CHR-01: challenge_pvp arms the TTL reaper AFTER the challenge insert,
//            with the EXACT argument shape (plan F1 arg-identity pin)
//
// EARS 17.5e-1: challenge_pvp SHALL call
//   schedule_challenge_reaper(ctx, challenge.challenge_id, challenge.created_at_ms)
// AFTER capturing the inserted battle_challenge row — the auto_inc
// challenge_id only exists once the insert returns (EA-REAPER-01 precedent).
//
// TEETH: kills an impl that (a) omits the arm entirely, (b) arms BEFORE the
//        insert (unknown challenge_id), or (c) arms with the wrong args —
//        a literal `0` id arms a reaper that reaps nothing, and a
//        `now_ms(ctx)` time silently shifts the deadline off the row's own
//        created_at_ms (staleness must never be computable from anything a
//        client could supply — plan D6 structural invariant).
// ---------------------------------------------------------------------------

#[test]
fn ea_chr_01_challenge_pvp_arms_reaper_after_insert_with_exact_args() {
    let stripped = stripped_pvp_for_scan();
    let body = extract_pvp_fn_body(&stripped, "challenge_pvp")
        .expect("EA-CHR-01: `challenge_pvp` function not found in pvp.rs");
    let squashed = squash_ws(body);

    let insert_needle = concat!("battle_challenge", "().insert(");
    let insert_pos = squashed.find(insert_needle).unwrap_or_else(|| {
        panic!(
            "EA-CHR-01 FAIL: `battle_challenge().insert(` not found in `challenge_pvp` body. \
             The reaper cannot be armed because no challenge row is inserted."
        )
    });

    // Arg-identity pin (plan F1): nothing may sit between the third argument
    // and the close paren.  Both closing forms are accepted — `)` (single-line
    // call) and `,)` (rustfmt adds a trailing comma when it splits a call
    // across lines; squash_ws collapses that split to the `,)` form).
    let arm_needle = concat!(
        "schedule_challenge_",
        "reaper(ctx,challenge.challenge_id,challenge.created_at_ms)"
    );
    let arm_needle_trailing_comma = concat!(
        "schedule_challenge_",
        "reaper(ctx,challenge.challenge_id,challenge.created_at_ms,)"
    );
    let arm_pos = squashed
        .find(arm_needle)
        .or_else(|| squashed.find(arm_needle_trailing_comma))
        .unwrap_or_else(|| {
            panic!(
                "EA-CHR-01 FAIL: the arm call `schedule_challenge_reaper(ctx, \
                 challenge.challenge_id, challenge.created_at_ms)` (squash_ws'd \
                 arg-identity pin) was not found in `challenge_pvp` body. Without the \
                 arm, a Pending challenge from an AFK/disconnected challenger locks \
                 BOTH parties out of new challenges (guards 5b/6) forever. A wrong-id \
                 arm (literal 0) or a wrong-time arm (now_ms(ctx)) also fails this pin \
                 (plan F1). RED: reaper arm absent (m17.5e)."
            )
        });

    assert!(
        arm_pos > insert_pos,
        "EA-CHR-01 FAIL: the reaper arm (squashed offset {arm_pos}) appears BEFORE \
         `battle_challenge().insert(` (squashed offset {insert_pos}) in `challenge_pvp`. \
         The auto_inc challenge_id only exists after the insert returns; arming first \
         references an unknown id."
    );
}

// ---------------------------------------------------------------------------
// EA-CHR-02: disarm_challenge_reaper called at ALL FOUR challenge-deletion
//            sites (plan D4; mirrors EA-REAPER-02) AND the helper body is
//            non-trivial (survivor-pin against no-op body mutant)
//
// The four sites are EXACTLY the deletion set (plan F8 whole-tree grep):
//   1. accept_challenge   — post-battle-creation delete
//   2. decline_challenge  — target rejects
//   3. cancel_challenge   — challenger withdraws
//   4. cancel_challenges_on_disconnect — bulk delete loop
//
// BODY PINS (m17.5d survivor-pin technique — mutation-testing found a missed
// mutant: `replace disarm_challenge_reaper with ()`): a no-op body passes all
// call-site checks above but leaves orphaned schedule rows that then fire as
// no-ops.  Two shape-based needles pin the collect-before-delete pattern
// (mirrors disarm_trade_reaper, ADR-0117):
//   (a) `.challenge_id().filter(` — the btree filter that gathers scheduled_ids
//   (b) `.scheduled_id().delete(` — the per-pk delete that removes each row
// Variable-name-agnostic: matches any local binding.
//
// TEETH: kills (i) an impl that adds the disarm to only SOME of the four sites;
//        (ii) a no-op / empty-body disarm that passes the call-site check but
//        never actually deletes the schedule row; (iii) a body that deletes by
//        challenge_id directly (if the API changes, this would silent-fail on
//        0 rows and not enforce the per-pk contract).
// ---------------------------------------------------------------------------

#[test]
fn ea_chr_02_disarm_called_at_all_challenge_deletion_sites() {
    let stripped = stripped_pvp_for_scan();

    // Per-site arg-identity pins (LOW gate-hole, red-team finding):
    // `disarm_challenge_reaper(ctx, 0)` passes a presence-only check but arms
    // the disarm for a non-existent id, leaving the real schedule row orphaned.
    // Three reducers pass `challenge_id` (the row's own id); the disconnect
    // bulk loop passes `id` (the loop variable over collected pending_ids).
    // Both `)` and rustfmt trailing-comma `,)` closing forms are accepted.
    //
    // Structure: (fn_name, squashed_call_needle, squashed_call_needle_trailing)
    let sites: &[(&str, &str, &str)] = &[
        (
            "accept_challenge",
            concat!("disarm_challenge_", "reaper(ctx,challenge_id)"),
            concat!("disarm_challenge_", "reaper(ctx,challenge_id,)"),
        ),
        (
            "decline_challenge",
            concat!("disarm_challenge_", "reaper(ctx,challenge_id)"),
            concat!("disarm_challenge_", "reaper(ctx,challenge_id,)"),
        ),
        (
            "cancel_challenge",
            concat!("disarm_challenge_", "reaper(ctx,challenge_id)"),
            concat!("disarm_challenge_", "reaper(ctx,challenge_id,)"),
        ),
        (
            "cancel_challenges_on_disconnect",
            concat!("disarm_challenge_", "reaper(ctx,id)"),
            concat!("disarm_challenge_", "reaper(ctx,id,)"),
        ),
    ];

    for (fn_name, call_needle, call_needle_trailing) in sites {
        let body = extract_pvp_fn_body(&stripped, fn_name)
            .unwrap_or_else(|| panic!("EA-CHR-02: `{fn_name}` function not found in pvp.rs"));
        let squashed = squash_ws(body);
        let found = squashed.contains(call_needle) || squashed.contains(call_needle_trailing);
        assert!(
            found,
            "EA-CHR-02 FAIL: `{fn_name}` is missing the arg-identity disarm call \
             `{call_needle}` (squash_ws'd). A literal-0 call `disarm_challenge_reaper(ctx, 0)` \
             passes a presence-only check but disarms the wrong (non-existent) schedule row — \
             the real schedule row survives and fires as an orphaned no-op later. \
             Plan D4: EVERY deletion site must disarm with the ACTUAL challenge id \
             (EA-REAPER-02 parity). RED: disarm with correct arg absent (m17.5e)."
        );
    }

    // Body survivor-pins: extract disarm_challenge_reaper itself and verify
    // the collect-before-delete shape is present (kills no-op body mutant).
    let disarm_body =
        extract_pvp_fn_body(&stripped, "disarm_challenge_reaper").unwrap_or_else(|| {
            panic!(
                "EA-CHR-02 FAIL: `disarm_challenge_reaper` function not found in pvp.rs — \
                 the helper does not exist yet. RED: m17.5e disarm helper absent."
            )
        });
    let disarm_squashed = squash_ws(disarm_body);

    // (a) btree filter collect: gathers scheduled_ids by challenge_id index.
    let filter_needle = concat!(".challenge_id()", ".filter(");
    assert!(
        disarm_squashed.contains(filter_needle),
        "EA-CHR-02 FAIL: `disarm_challenge_reaper` body is missing `.challenge_id().filter(` \
         (squash_ws'd) — the helper must gather schedule rows via the btree index before \
         deleting them (collect-before-delete pattern, mirrors disarm_trade_reaper ADR-0117). \
         A no-op or empty body fails this pin (survivor-pin against body-replacement mutant)."
    );

    // (b) per-pk delete: removes each row by scheduled_id primary key.
    let delete_needle = concat!(".scheduled_id()", ".delete(");
    assert!(
        disarm_squashed.contains(delete_needle),
        "EA-CHR-02 FAIL: `disarm_challenge_reaper` body is missing `.scheduled_id().delete(` \
         (squash_ws'd) — the helper must delete each schedule row via its primary key. \
         A no-op body or one that only filters without deleting fails this pin."
    );
}

// ---------------------------------------------------------------------------
// EA-CHR-03: battle_challenge_reaper has the scheduler-only identity guard
//            (plan F3 — brace-bounded body scan, never a suffix scan)
//
// TEETH: kills an impl that forgets `ctx.sender != ctx.identity()` — any
//        client could then call the reaper directly and delete other players'
//        pending challenges at will.  Body-scoped so the guard in
//        pvp_deadline_reaper (same token, same file) cannot satisfy it.
// ---------------------------------------------------------------------------

#[test]
fn ea_chr_03_challenge_reaper_has_scheduler_guard() {
    let stripped = stripped_pvp_for_scan();
    let body = extract_pvp_fn_body(&stripped, "battle_challenge_reaper").unwrap_or_else(|| {
        panic!(
            "EA-CHR-03 FAIL: `battle_challenge_reaper` reducer not found in pvp.rs — \
             the TTL reaper does not exist yet. RED: m17.5e reaper absent."
        )
    });
    let squashed = squash_ws(body);
    let guard_needle = concat!("ctx.sender", "!=", "ctx.identity()");
    assert!(
        squashed.contains(guard_needle),
        "EA-CHR-03 FAIL: `battle_challenge_reaper` body is missing the scheduler-only \
         identity guard `ctx.sender != ctx.identity()` (squash_ws'd, brace-bounded scan). \
         Without it any client can invoke the reaper and delete other players' pending \
         challenges (ADR-0109 pvp_deadline_reaper / ADR-0117 trade_offer_reaper pattern)."
    );
}

// ---------------------------------------------------------------------------
// EA-CHR-04: battle_challenge_reaper re-checks staleness via the NEGATION
//            GUARD SHAPE and deletes the row (plan F4 — shape-pinned, bounded)
//
// Required shape (squash_ws'd, trade_offer_reaper clone):
//   `if !is_challenge_stale(`                       — negation guard
//   `<row>.created_at_ms, now_ms(ctx))`             — CORRECT arg order
//   `){ return Ok(()) }`                            — block opens with early-return
//   `challenge_id().delete(`                        — the reap itself
// and the guard must precede the delete (decision-before-irreversible).
//
// TEETH: kills (a) an impl with no stale re-check (early fire — plan D7 —
//        reaps a FRESH challenge), (b) the ignored-result evasion
//        `let _ = is_challenge_stale(...)` (no `if !…` shape), (c) an impl
//        that deletes before checking, (d) TRANSPOSED args
//        `is_challenge_stale(now_ms(ctx), row.created_at_ms)` which computes a
//        negative elapsed and causes the reaper to permanently no-op (HIGH
//        gate-hole, red-team finding), and (e) an empty guard block
//        `if !is_challenge_stale(...) { }` followed by an unconditional delete
//        — the `){ return Ok(()) }` immediate-open shape kills that (MEDIUM
//        gate-hole, red-team finding).
// Body-scoped so the three lifecycle delete sites (accept/decline/cancel)
// cannot satisfy the delete pin.
// ---------------------------------------------------------------------------

#[test]
fn ea_chr_04_challenge_reaper_stale_recheck_guards_the_delete() {
    let stripped = stripped_pvp_for_scan();
    let body = extract_pvp_fn_body(&stripped, "battle_challenge_reaper").unwrap_or_else(|| {
        panic!(
            "EA-CHR-04 FAIL: `battle_challenge_reaper` reducer not found in pvp.rs — \
             the TTL reaper does not exist yet. RED: m17.5e reaper absent."
        )
    });
    let squashed = squash_ws(body);

    let neg_needle = concat!("if!", "is_challenge_stale(");
    let neg_pos = squashed.find(neg_needle).unwrap_or_else(|| {
        panic!(
            "EA-CHR-04 FAIL: the negation guard `if !is_challenge_stale(` was not found \
             in `battle_challenge_reaper` body (squash_ws'd shape pin, plan F4). An \
             ignored-result call (`let _ = is_challenge_stale(...)`) does NOT satisfy \
             this — the staleness result must gate the delete."
        )
    });

    // Arg-order pin (HIGH gate-hole, red-team finding): the squashed arg-tail
    // after `if !is_challenge_stale(` must be `<row>.created_at_ms,now_ms(ctx))`.
    // A transposed call `is_challenge_stale(now_ms(ctx), row.created_at_ms)`
    // computes a *negative* elapsed and the negation always evaluates to false,
    // so the delete is never reached → the reaper permanently no-ops.
    // Both `)` and rustfmt-trailing-comma `,)` closing forms are accepted.
    let arg_tail_needle = concat!(".created_at_ms,", "now_ms(ctx))");
    let arg_tail_needle_trailing = concat!(".created_at_ms,", "now_ms(ctx),)");
    let arg_tail_pos = squashed[neg_pos..]
        .find(arg_tail_needle)
        .or_else(|| squashed[neg_pos..].find(arg_tail_needle_trailing))
        .map(|p| neg_pos + p)
        .unwrap_or_else(|| {
            panic!(
                "EA-CHR-04 FAIL: arg-order pin `.created_at_ms,now_ms(ctx))` not found after \
                 `if !is_challenge_stale(` in `battle_challenge_reaper` (squash_ws'd). A \
                 transposed call `is_challenge_stale(now_ms(ctx), row.created_at_ms)` computes \
                 a negative elapsed and the reaper permanently no-ops (HIGH gate-hole)."
            )
        });

    // Immediate-open shape (MEDIUM gate-hole, red-team finding): the block
    // following the condition must OPEN with `return Ok(())` — squashed form
    // `){returnOk(())`.  An empty guard block `{ }` followed by an
    // unconditional delete satisfies the `if !…` + `return Ok(())` pins but
    // fires the reaper on every invocation regardless of staleness.
    let block_open_needle = concat!(")", "{return", "Ok(())");
    assert!(
        squashed[arg_tail_pos..].contains(block_open_needle),
        "EA-CHR-04 FAIL: the guard block does not immediately open with `return Ok(())` — \
         squashed shape `)<open-brace>returnOk(())` not found after the arg-tail. An empty guard \
         block `if !is_challenge_stale(...) <open-brace><close-brace>` followed by an unconditional \
         delete would fire the reaper on every invocation regardless of staleness (MEDIUM gate-hole)."
    );

    let return_ok_needle = concat!("return", "Ok(())");
    assert!(
        squashed[neg_pos..].contains(return_ok_needle),
        "EA-CHR-04 FAIL: no `return Ok(())` after the `if !is_challenge_stale(` guard in \
         `battle_challenge_reaper` — an early fire (clock skew) must no-op, never reap a \
         fresh challenge (plan D7; trade_offer_reaper parity)."
    );

    // Delete arg-identity pin (MEDIUM gate-hole, red-team finding):
    // `.delete(args.challenge_id)` — kills `.delete(0)` (decorative reaper that
    // ships green with only the open-paren needle).  Both `)` and rustfmt
    // trailing-comma `,)` closing forms are accepted.
    let delete_needle = concat!("challenge_id()", ".delete(args.challenge_id)");
    let delete_needle_trailing = concat!("challenge_id()", ".delete(args.challenge_id,)");
    let delete_pos = squashed
        .find(delete_needle)
        .or_else(|| squashed.find(delete_needle_trailing))
        .unwrap_or_else(|| {
            panic!(
                "EA-CHR-04 FAIL: `challenge_id().delete(args.challenge_id)` not found in \
                 `battle_challenge_reaper` body (squash_ws'd arg-identity pin). A decorative \
                 `.delete(0)` passes the open-paren needle but reaps the wrong (or no) row — \
                 the reaper must delete by the scheduled challenge's own id."
            )
        });

    assert!(
        neg_pos < delete_pos,
        "EA-CHR-04 FAIL: the stale-recheck guard (squashed offset {neg_pos}) must come \
         BEFORE `challenge_id().delete(args.challenge_id)` (squashed offset {delete_pos}) — \
         decision-before-irreversible."
    );
}

// ---------------------------------------------------------------------------
// EA-CHR-05: battle_challenge_reaper_schedule is baselined AND private
//
// (a) The table must appear in evals/baselines/table-schemas.json (append-only
//     regen, ADR-0116) — otherwise the schema-snapshot eval fires next run.
// (b) The real table attribute in pvp.rs must NOT contain `public` — clients
//     must never see or manipulate reaper schedule rows (plan D6;
//     trade_offer_reaper_schedule precedent).
//
// F7 RULE (load-bearing for this file): NO fixture string here may contain an
// unbroken table-macro attribute prefix — the schema-snapshot eval
// concatenates ALL .rs files under server-module/src/ INCLUDING this test file, and its
// parser would treat a fixture as a real table.  This test therefore scans
// only the REAL attribute (needle-based); macro-shaped fixtures live solely in
// evals/pvp-challenge-reaper.eval.mjs (never scanned by the snapshot eval).
//
// TEETH: kills an impl that forgets the baseline entry (a) or marks the
//        schedule table `public` (b) — a public schedule table would leak
//        reap deadlines and invite client-side schedule manipulation.
// ---------------------------------------------------------------------------

#[test]
fn ea_chr_05_reaper_schedule_table_baselined_and_private() {
    // (a) Baseline presence.
    let table_name = concat!("battle_challenge_", "reaper_schedule");
    assert!(
        TABLE_SCHEMAS_JSON.contains(table_name),
        "EA-CHR-05 FAIL: `{}` not found in evals/baselines/table-schemas.json. \
         Append the new schedule-table entry to the baseline (append-only, ADR-0116). \
         RED: table + baseline entry absent (m17.5e).",
        table_name
    );

    // (b) The real attribute in pvp.rs has no `public`.
    let stripped = stripped_pvp_for_scan();
    let name_needle = concat!("name = ", "battle_challenge_reaper_schedule");
    let pos = stripped.find(name_needle).unwrap_or_else(|| {
        panic!(
            "EA-CHR-05 FAIL: `name = battle_challenge_reaper_schedule` not found in pvp.rs — \
             the schedule table must be declared there, colocated with its reducer \
             (trade_offer_reaper_schedule precedent, ADR-0056 exception). \
             RED: table absent (m17.5e)."
        )
    });
    let attr_start = stripped[..pos]
        .rfind("#[")
        .expect("EA-CHR-05: malformed table attribute — no `#[` before the name argument");
    let attr_end = stripped[pos..]
        .find(']')
        .map(|p| pos + p)
        .expect("EA-CHR-05: malformed table attribute — no closing `]` after the name argument");
    let attr = &stripped[attr_start..=attr_end];
    assert!(
        !attr.contains("public"),
        "EA-CHR-05 FAIL: the battle_challenge_reaper_schedule table attribute contains \
         `public` — the schedule table MUST be private (plan D6). Clients must never \
         see or manipulate reaper schedule rows. Found attribute: {:?}",
        attr
    );
}

// ---------------------------------------------------------------------------
// EA-CHR-06: schedule_challenge_reaper deadline is ms-floored (plan F2/N5)
//
// The deadline MUST be computed from the ms-floored created_at_ms
// (ADR-0117 D4): created_at_ms×1000 + CHALLENGE_TTL_MS×1000, saturating.
// The ADJACENT `schedule_deadline` helper in pvp.rs computes from raw
// now-micros and is the WRONG template (plan §7 copy-risk callout) — the
// correct clone source is trading.rs `schedule_trade_reaper`.
//
// TEETH: kills (a) a units bug — a missing ×1000 fires the reaper ~2 minutes
//        early, the `!is_challenge_stale` branch no-ops, the runtime consumes
//        the one-shot row, and the Pending challenge LEAKS FOREVER (plan D7);
//        (b) a whole-body-replacement mutant that keeps the signature but
//        drops the schedule insert (survivor-pin, N5).
// ---------------------------------------------------------------------------

#[test]
fn ea_chr_06_schedule_challenge_reaper_deadline_ms_floored() {
    let stripped = stripped_pvp_for_scan();
    let body = extract_pvp_fn_body(&stripped, "schedule_challenge_reaper").unwrap_or_else(|| {
        panic!(
            "EA-CHR-06 FAIL: `schedule_challenge_reaper` helper not found in pvp.rs — \
             the arm helper does not exist yet. RED: m17.5e helper absent."
        )
    });
    let squashed = squash_ws(body);

    // (a) ms-floored deadline expression (squash_ws'd; rustfmt-proof).
    let deadline_needle = concat!(
        "created_at_ms.saturating_mul(1_000)",
        ".saturating_add(CHALLENGE_TTL_MS.saturating_mul(1_000))"
    );
    assert!(
        squashed.contains(deadline_needle),
        "EA-CHR-06 FAIL: the ms-floored deadline expression \
         created_at_ms×1000 + CHALLENGE_TTL_MS×1000 (both saturating, ADR-0117 D4) was \
         not found in `schedule_challenge_reaper` body. A missing ×1000 fires the reaper \
         early → the stale re-check no-ops → the one-shot schedule row is consumed → the \
         Pending challenge leaks forever (plan D7). Do NOT clone the adjacent \
         `schedule_deadline` (now-based); clone trading.rs `schedule_trade_reaper`."
    );

    // (b) Survivor-pin: the schedule-row insert must be present.
    let insert_needle = concat!("battle_challenge_reaper_schedule", "().insert(");
    assert!(
        squashed.contains(insert_needle),
        "EA-CHR-06 FAIL: `battle_challenge_reaper_schedule().insert(` not found in \
         `schedule_challenge_reaper` body — the arm helper must insert the one-shot \
         schedule row (survivor-pin, plan N5: kills body-replacement mutants)."
    );
}
