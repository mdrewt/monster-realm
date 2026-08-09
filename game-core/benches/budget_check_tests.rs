//! OBS-6 proof-of-teeth for the perf-budget gate (m20a, ADR-0180 D7).
//!
//! REGISTRATION (the specialist's job, not this file's): `game-core/Cargo.toml`
//! gains
//! ```toml
//! [[test]]
//! name = "perf_budget_predicate"
//! path = "benches/budget_check_tests.rs"
//! ```
//! so these run under `just test` (`cargo nextest run --workspace`) without a
//! criterion bench ever executing. Do not edit `Cargo.toml` from here.
//!
//! `budgets.rs` lives beside this file and is shared verbatim with
//! `hot_paths.rs` — one `BUDGETS` table, one comparison function, no second
//! copy of the ceilings to drift (§6c).
//!
//! WHAT THESE TESTS BUY (anti-pattern 1, "wire-but-never-bites"): the gate is
//! only worth its runtime if a regression actually reddens it. Below: a seeded
//! regression must be NAMED, a clean run must be silent, the boundary must be
//! `<=` and not `<`, a budgeted id with NO measurement must be reported (a
//! criterion run that silently skipped a bench is otherwise a vacuous green),
//! and — AM1, the attack path Swatinem/rust-cache opens — a STALE
//! `estimates.json` restored from a previous CI run must never be read back as
//! this run's measurement.
//!
//! DETERMINISM: no wall clock anywhere. `std::time::Instant::now` /
//! `SystemTime::now` are clippy-banned workspace-wide with `-D warnings`
//! (`clippy.toml`), so temp directories are made unique with
//! `std::process::id()` plus a per-test tag instead.

#[path = "budgets.rs"]
mod budgets;

use crate::budgets::Budget;
use std::fs;
use std::path::{Path, PathBuf};

/// The 7 hot paths OBS-5 names (plan §6e — every signature verified).
const EXPECTED_IDS: [&str; 7] = [
    "apply_move",
    "derive_stats",
    "resolve_turn",
    "resolve_encounter",
    "evolution_eligible_paths",
    "evolve",
    "map_for",
];

const EPS: f64 = 1e-9;

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < EPS
}

// ---------------------------------------------------------------------------
// The committed budget table
// ---------------------------------------------------------------------------

/// OBS-5: a benchmark AND a committed budget for each named hot path — no more,
/// no fewer.
///
/// Kills: quietly dropping an id whose bench turned out to be awkward to build
/// (the gate would still be green while covering six paths), and adding an
/// unnamed extra that no bench produces (which `missing` would then flag on
/// every run until someone raised its ceiling to infinity).
#[test]
fn budgets_covers_exactly_the_seven_named_hot_paths() {
    let mut ids: Vec<&str> = budgets::BUDGETS.iter().map(|b| b.id).collect();
    ids.sort_unstable();
    let mut expected: Vec<&str> = EXPECTED_IDS.to_vec();
    expected.sort_unstable();
    assert_eq!(
        ids, expected,
        "BUDGETS must name exactly the 7 hot paths from observability-performance-plan.md §2"
    );

    let mut deduped = ids.clone();
    deduped.dedup();
    assert_eq!(
        deduped.len(),
        ids.len(),
        "BUDGETS contains a duplicate id — the second entry's ceiling would silently shadow \
         (or be shadowed by) the first"
    );
}

/// A zero or negative ceiling is either a placeholder never replaced with a
/// measurement, or a gate that can never fail. Both are review rejects.
#[test]
fn every_ceiling_is_a_positive_nanosecond_figure() {
    for b in budgets::BUDGETS {
        assert!(
            b.ceiling_ns > 0.0 && b.ceiling_ns.is_finite(),
            "budget `{}` has a non-positive/non-finite ceiling ({}) — every ceiling must be a \
             real measured figure (AM11: inline comment records value, date and conditions)",
            b.id,
            b.ceiling_ns
        );
    }
}

// ---------------------------------------------------------------------------
// `violations` — the seeded-regression half of OBS-6
// ---------------------------------------------------------------------------

fn two_budgets() -> Vec<Budget> {
    vec![
        Budget {
            id: "fast_path",
            ceiling_ns: 100.0,
        },
        Budget {
            id: "slow_path",
            ceiling_ns: 10_000.0,
        },
    ]
}

/// SEEDED REGRESSION: one id at 2x its ceiling must be reported, BY NAME, and
/// nothing else must be.
///
/// Kills: a `violations` that returns an empty Vec unconditionally, one that
/// reports a count without an id (unactionable CI output), and one that
/// compares every measurement against a single global ceiling — `fast_path` at
/// 200ns is over its own 100ns ceiling but far under `slow_path`'s 10µs one.
#[test]
fn violations_names_the_regressed_id_and_only_it() {
    let budgets_table = two_budgets();
    let measured = [("fast_path", 200.0), ("slow_path", 2_500.0)];
    let found = budgets::violations(&measured, &budgets_table);
    assert_eq!(
        found.len(),
        1,
        "expected exactly one violation, got {found:?}"
    );
    assert!(
        found[0].contains("fast_path"),
        "the violation message must name the offending id; got: {}",
        found[0]
    );
    assert!(
        !found[0].contains("slow_path"),
        "a within-budget id was reported as a violation: {}",
        found[0]
    );
}

/// Two simultaneous regressions must BOTH be reported.
///
/// Kills: an early `return` after the first violation, which hides the second
/// regression until the first is fixed (two review cycles instead of one).
#[test]
fn violations_reports_every_regression_not_just_the_first() {
    let budgets_table = two_budgets();
    let measured = [("fast_path", 400.0), ("slow_path", 40_000.0)];
    let found = budgets::violations(&measured, &budgets_table);
    assert_eq!(found.len(), 2, "both regressions must be reported: {found:?}");
    let joined = found.join(" | ");
    assert!(joined.contains("fast_path") && joined.contains("slow_path"), "{joined}");
}

/// A healthy run is silent.
#[test]
fn violations_is_empty_when_everything_is_well_inside_budget() {
    let budgets_table = two_budgets();
    let measured = [("fast_path", 25.0), ("slow_path", 2_500.0)];
    assert!(
        budgets::violations(&measured, &budgets_table).is_empty(),
        "a run at a quarter of every ceiling must produce no violations"
    );
}

/// Boundary: EXACTLY at the ceiling passes.
///
/// Kills a `>=` comparison, which would fail a run that is precisely on budget
/// and push someone to inflate the ceiling for no measured reason.
#[test]
fn violations_boundary_exactly_at_ceiling_passes() {
    let budgets_table = two_budgets();
    let measured = [("fast_path", 100.0), ("slow_path", 10_000.0)];
    assert!(
        budgets::violations(&measured, &budgets_table).is_empty(),
        "a measurement exactly equal to its ceiling must pass (the comparison is `>`)"
    );
}

/// Boundary: one nanosecond over fails.
///
/// Kills an inverted comparison and a `>` on the wrong operand order — both
/// produce a gate that is permanently green.
#[test]
fn violations_boundary_one_ns_over_fails() {
    let budgets_table = two_budgets();
    let measured = [("fast_path", 101.0), ("slow_path", 10_000.0)];
    let found = budgets::violations(&measured, &budgets_table);
    assert_eq!(found.len(), 1, "one ns over budget must fail: {found:?}");
    assert!(found[0].contains("fast_path"), "{}", found[0]);
}

// ---------------------------------------------------------------------------
// `missing` — closes the vacuous-green hole
// ---------------------------------------------------------------------------

/// A budgeted id with NO measurement must be named.
///
/// Kills the loudest vacuous green of all: criterion silently not running a
/// bench (renamed id, filtered run, panicking fixture) leaves `violations`
/// empty and the gate green while that hot path is entirely unmeasured.
#[test]
fn missing_names_a_budgeted_id_with_no_measurement() {
    let budgets_table = two_budgets();
    let measured = [("fast_path", 10.0)];
    let absent = budgets::missing(&measured, &budgets_table);
    assert_eq!(absent, vec!["slow_path"], "the unmeasured id must be named");
}

/// A complete measurement set reports nothing missing.
#[test]
fn missing_is_empty_for_a_complete_measurement_set() {
    let budgets_table = two_budgets();
    let measured = [("fast_path", 10.0), ("slow_path", 20.0)];
    assert!(
        budgets::missing(&measured, &budgets_table).is_empty(),
        "a complete set must report nothing missing"
    );
    let nothing: [(&str, f64); 0] = [];
    assert_eq!(
        budgets::missing(&nothing, &budgets_table).len(),
        2,
        "an EMPTY measurement set must report every budgeted id — a bench binary that produced \
         no estimates at all is the failure this closes"
    );
}

// ---------------------------------------------------------------------------
// `read_measurements` / `clean_ids` — AM1, the criterion read-back path
// ---------------------------------------------------------------------------

/// Unique per test AND per process, without touching a wall clock.
fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mr-budget-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("could not create the temp criterion home");
    dir
}

fn cleanup(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

/// Criterion's on-disk shape: `<CRITERION_HOME>/<id>/new/estimates.json`, whose
/// `mean.point_estimate` is the nanosecond figure the gate compares.
fn write_estimates(root: &Path, id: &str, mean_ns: f64) {
    let dir = root.join(id).join("new");
    fs::create_dir_all(&dir).expect("could not create the estimates dir");
    let json = format!(
        "{{\"mean\":{{\"confidence_interval\":{{\"confidence_level\":0.95,\
         \"lower_bound\":{lower},\"upper_bound\":{upper}}},\"point_estimate\":{mean_ns},\
         \"standard_error\":1.5}},\"median\":{{\"point_estimate\":{mean_ns}}},\
         \"slope\":null}}",
        lower = mean_ns - 1.0,
        upper = mean_ns + 1.0,
    );
    fs::write(dir.join("estimates.json"), json).expect("could not write estimates.json");
}

/// The happy path: every requested id resolves to its `mean.point_estimate`.
#[test]
fn read_measurements_returns_the_mean_point_estimate() {
    let root = temp_root("read-ok");
    write_estimates(&root, "apply_move", 123.5);
    write_estimates(&root, "map_for", 4_200.0);

    let got = budgets::read_measurements(&root, &["apply_move", "map_for"])
        .expect("a complete criterion home must read back cleanly");
    assert_eq!(got.len(), 2, "expected two measurements, got {got:?}");

    let apply = got
        .iter()
        .find(|(id, _)| id.as_str() == "apply_move")
        .expect("apply_move missing from the read-back");
    assert!(
        close(apply.1, 123.5),
        "apply_move read back as {} ns, expected 123.5 (mean.point_estimate, not median or \
         a lower bound)",
        apply.1
    );
    let map = got
        .iter()
        .find(|(id, _)| id.as_str() == "map_for")
        .expect("map_for missing from the read-back");
    assert!(close(map.1, 4_200.0), "map_for read back as {} ns", map.1);

    cleanup(&root);
}

/// A budgeted id with no criterion directory is an ERROR naming that id — never
/// a silently skipped entry and never a `0.0` default.
///
/// Kills: an `unwrap_or(0.0)` read-back, which would report every unmeasured hot
/// path as infinitely fast and pass the gate forever.
#[test]
fn read_measurements_errors_naming_the_absent_id() {
    let root = temp_root("read-absent");
    write_estimates(&root, "apply_move", 100.0);

    let err = budgets::read_measurements(&root, &["apply_move", "evolve"])
        .expect_err("a missing estimates.json must be an Err, not a default measurement");
    assert!(
        err.contains("evolve"),
        "the error must name the id whose measurement is missing; got: {err}"
    );

    cleanup(&root);
}

/// Unparseable JSON is an ERROR (R4: `estimates.json` is a documented-private
/// criterion implementation detail — the pin can break under us, and it must
/// break LOUDLY).
#[test]
fn read_measurements_errors_on_malformed_json() {
    let root = temp_root("read-malformed");
    let dir = root.join("evolve").join("new");
    fs::create_dir_all(&dir).expect("could not create the estimates dir");
    fs::write(dir.join("estimates.json"), "{not valid json").expect("write");

    let err = budgets::read_measurements(&root, &["evolve"])
        .expect_err("malformed estimates.json must be an Err");
    assert!(
        err.contains("evolve"),
        "the parse error must name the id it came from; got: {err}"
    );

    cleanup(&root);
}

/// Well-formed JSON that lacks `mean.point_estimate` is also an ERROR.
///
/// Kills a serde struct with `#[serde(default)]` on the field: a criterion
/// version that renames the key would yield 0.0 ns for every hot path and a
/// permanently green gate.
#[test]
fn read_measurements_errors_when_mean_point_estimate_is_absent() {
    let root = temp_root("read-noshape");
    let dir = root.join("evolve").join("new");
    fs::create_dir_all(&dir).expect("could not create the estimates dir");
    fs::write(
        dir.join("estimates.json"),
        "{\"median\":{\"point_estimate\":1.0}}",
    )
    .expect("write");

    let err = budgets::read_measurements(&root, &["evolve"])
        .expect_err("estimates.json without mean.point_estimate must be an Err, not 0.0 ns");
    assert!(err.contains("evolve"), "{err}");

    cleanup(&root);
}

/// AM1 (CRITICAL) — STALE-DIR RESURRECTION.
///
/// `Swatinem/rust-cache` restores `target/` between CI runs, so a previous run's
/// `<CRITERION_HOME>/<id>/new/estimates.json` is present before this run starts.
/// If the bench for that id then fails to run, the read-back happily returns the
/// OLD number and the gate passes on a measurement that was never taken. The
/// harness therefore deletes each budgeted id's directory before benching, and
/// this test proves the deletion actually happens.
#[test]
fn clean_ids_removes_a_stale_measurement_directory() {
    let root = temp_root("clean-stale");
    write_estimates(&root, "apply_move", 1.0);
    write_estimates(&root, "map_for", 2.0);
    let stale = root.join("apply_move").join("new").join("estimates.json");
    assert!(stale.exists(), "fixture setup failed: no stale estimates.json");

    budgets::clean_ids(&root, &["apply_move"]).expect("clean_ids must succeed");

    assert!(
        !root.join("apply_move").exists(),
        "clean_ids left the stale `apply_move` directory in place — a cache-restored \
         measurement from a previous run would be read back as this run's result (AM1)"
    );
    assert!(
        root.join("map_for").exists(),
        "clean_ids removed an id it was not asked to clean"
    );
    assert!(
        budgets::read_measurements(&root, &["apply_move"]).is_err(),
        "after clean_ids the stale measurement must be unreadable, not merely stale"
    );

    cleanup(&root);
}

/// `clean_ids` on a criterion home that does not exist yet must be Ok — the very
/// first run on a clean machine has nothing to delete, and an Err there would
/// make the gate fail for everyone once.
#[test]
fn clean_ids_is_idempotent_on_an_empty_home() {
    let root = temp_root("clean-empty");
    budgets::clean_ids(&root, &["apply_move", "evolve"])
        .expect("clean_ids on an empty criterion home must be Ok");
    budgets::clean_ids(&root.join("does-not-exist"), &["apply_move"])
        .expect("clean_ids on a missing criterion home must be Ok");
    cleanup(&root);
}

/// End-to-end over the REAL committed table: a stale directory is cleaned, a
/// fresh measurement is written at a quarter of each committed ceiling, and the
/// gate is silent — then one id is re-written at twice its ceiling and the gate
/// names it. This is the seeded-regression fixture OBS-6 asks for, exercised
/// through the same three functions `hot_paths.rs` calls.
#[test]
fn seeded_regression_round_trip_over_the_committed_budgets() {
    let root = temp_root("round-trip");
    let ids: Vec<&str> = budgets::BUDGETS.iter().map(|b| b.id).collect();

    for b in budgets::BUDGETS {
        write_estimates(&root, b.id, b.ceiling_ns * 8.0);
    }
    budgets::clean_ids(&root, &ids).expect("clean_ids");
    for b in budgets::BUDGETS {
        write_estimates(&root, b.id, b.ceiling_ns / 4.0);
    }

    let measured = budgets::read_measurements(&root, &ids).expect("read_measurements");
    let pairs: Vec<(&str, f64)> = measured.iter().map(|(id, ns)| (id.as_str(), *ns)).collect();
    assert!(
        budgets::missing(&pairs, budgets::BUDGETS).is_empty(),
        "every budgeted id was written, so nothing may be reported missing"
    );
    assert!(
        budgets::violations(&pairs, budgets::BUDGETS).is_empty(),
        "a run at a quarter of every committed ceiling must be silent"
    );

    let victim = &budgets::BUDGETS[0];
    write_estimates(&root, victim.id, victim.ceiling_ns * 2.0);
    let regressed = budgets::read_measurements(&root, &ids).expect("read_measurements");
    let pairs: Vec<(&str, f64)> = regressed.iter().map(|(id, ns)| (id.as_str(), *ns)).collect();
    let found = budgets::violations(&pairs, budgets::BUDGETS);
    assert_eq!(
        found.len(),
        1,
        "a single 2x regression must produce exactly one violation: {found:?}"
    );
    assert!(
        found[0].contains(victim.id),
        "the violation must name `{}`; got: {}",
        victim.id,
        found[0]
    );

    cleanup(&root);
}
