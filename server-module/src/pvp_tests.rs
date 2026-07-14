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
