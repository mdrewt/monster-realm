//! Perf-budget table + the pure comparison/read-back helpers (OBS-5/OBS-6,
//! m20a plan §6c, ADR-0180 D7).
//!
//! Shared VERBATIM by two targets — `hot_paths.rs` (the criterion harness,
//! `[[bench]]`) via `mod budgets;` and `budget_check_tests.rs` (the nextest
//! teeth, `[[test]]`) via `#[path = "budgets.rs"]` — so there is exactly one
//! `BUDGETS` table and one comparison function; a second copy of the ceilings
//! cannot drift. Compiled Rust on purpose: no parser surface, typos are
//! compile errors, and the diff is reviewable.
//!
//! Ceilings are ~20x the locally measured mean, rounded UP to a clean figure —
//! the gate catches order-of-magnitude regressions, not 5% drift (AM11: every
//! entry's inline comment records the measured value, date, and conditions).

/// One budgeted hot path: a criterion bench id and its ceiling in nanoseconds.
pub struct Budget {
    pub id: &'static str,
    pub ceiling_ns: f64,
}

/// The 7 hot paths OBS-5 names (plan §6e). Ids are the criterion
/// `bench_function` names verbatim (criterion's dir sanitization is a no-op
/// for `[a-z0-9_]`).
// AM11 provenance, shared conditions for every entry below: measured mean
// (criterion mean.point_estimate) on 2026-08-08, bench profile
// (release + overflow-checks, root Cargo.toml), idle WSL2 dev machine,
// criterion =0.5.1, warm_up 500ms, measurement_time 2s, sample_size 30, real
// shipped content fixtures. Ceiling = ~20x that mean, rounded UP to a clean
// figure. Raising a ceiling without a fresh measured note is a review reject
// (anti-pattern 6, budget inflation).
pub const BUDGETS: &[Budget] = &[
    Budget {
        // measured 1.87 ns mean, 2026-08-08 (conditions above); 20x = 37.4.
        id: "apply_move",
        ceiling_ns: 40.0,
    },
    Budget {
        // measured 4.77 ns mean, 2026-08-08 (conditions above); 20x = 95.4.
        id: "derive_stats",
        ceiling_ns: 100.0,
    },
    Budget {
        // measured 99.7 ns mean, 2026-08-08 (conditions above); 20x = 1994.
        id: "resolve_turn",
        ceiling_ns: 2000.0,
    },
    Budget {
        // measured 14.2 ns mean, 2026-08-08 (conditions above); 20x = 284.
        id: "resolve_encounter",
        ceiling_ns: 300.0,
    },
    Budget {
        // measured 14.9 ns mean, 2026-08-08 (conditions above); 20x = 298.
        id: "evolution_eligible_paths",
        ceiling_ns: 300.0,
    },
    Budget {
        // measured 8.97 ns mean, 2026-08-08 (conditions above); 20x = 179.4.
        id: "evolve",
        ceiling_ns: 200.0,
    },
    Budget {
        // measured 134.5 ns mean, 2026-08-08 (conditions above); 20x = 2690.
        id: "map_for",
        ceiling_ns: 3000.0,
    },
];

/// Every measurement OVER its budget's ceiling, one message per violation,
/// each naming the offending id. Ids match EXACTLY (case- and
/// whitespace-sensitive): criterion's directory names come from the bench ids
/// verbatim, so a lenient comparator would pair a budget with a measurement
/// that was never taken for it. The comparison is `>` — exactly at the ceiling
/// passes (an inclusive bound would push someone to inflate a ceiling for no
/// measured reason).
pub fn violations(measured: &[(&str, f64)], budgets: &[Budget]) -> Vec<String> {
    let mut out = Vec::new();
    for budget in budgets {
        for &(id, ns) in measured {
            if id == budget.id && ns > budget.ceiling_ns {
                out.push(format!(
                    "perf budget violated: `{}` measured {ns:.1} ns > ceiling {:.1} ns",
                    budget.id, budget.ceiling_ns
                ));
            }
        }
    }
    out
}

/// Every budgeted id with NO measurement — the vacuous-green closer: a
/// criterion run that silently skipped a bench must redden the gate, not leave
/// `violations` trivially empty.
pub fn missing(measured: &[(&str, f64)], budgets: &[Budget]) -> Vec<&'static str> {
    budgets
        .iter()
        .filter(|budget| !measured.iter().any(|&(id, _)| id == budget.id))
        .map(|budget| budget.id)
        .collect()
}

/// The slice of criterion's `estimates.json` this gate reads:
/// `mean.point_estimate` (nanoseconds). NO serde defaults anywhere — a
/// criterion version that renames the key must be a loud Err, never 0.0 ns
/// (R4: the file is a documented-private implementation detail; the exact
/// `=0.5.1` pin plus this fail-loud parse is the mitigation, and cargo-criterion
/// is the documented fallback).
#[derive(serde::Deserialize)]
struct EstimatesFile {
    mean: MeanEstimate,
}

#[derive(serde::Deserialize)]
struct MeanEstimate {
    point_estimate: f64,
}

/// Read `<criterion_home>/<id>/new/estimates.json` for every id, returning
/// `(id, mean.point_estimate ns)` pairs. A missing file, malformed JSON, or an
/// absent `mean.point_estimate` is an `Err` NAMING the id — never a skipped
/// entry, never a default measurement.
pub fn read_measurements(
    criterion_home: &std::path::Path,
    ids: &[&str],
) -> Result<Vec<(String, f64)>, String> {
    let mut out = Vec::with_capacity(ids.len());
    for &id in ids {
        let path = criterion_home.join(id).join("new").join("estimates.json");
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("perf budget `{id}`: cannot read {}: {e}", path.display()))?;
        let parsed: EstimatesFile = serde_json::from_str(&text).map_err(|e| {
            format!(
                "perf budget `{id}`: {} has no readable mean.point_estimate: {e}",
                path.display()
            )
        })?;
        out.push((id.to_string(), parsed.mean.point_estimate));
    }
    Ok(out)
}

/// AM1 — stale-dir kill. Remove `<criterion_home>/<id>` for every id BEFORE
/// benching, so a cache-restored `estimates.json` from a previous CI run
/// (Swatinem/rust-cache restores `target/`) can never be read back as this
/// run's measurement. A directory that does not exist is fine (first run on a
/// clean machine).
pub fn clean_ids(criterion_home: &std::path::Path, ids: &[&str]) -> std::io::Result<()> {
    for &id in ids {
        let dir = criterion_home.join(id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
    }
    Ok(())
}
