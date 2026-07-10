//! fix-nightly (ADR-0088): CLI-seam integration tests for the `tiled_import`
//! binary. These are the ONLY way to kill the two `main` mutants — cargo-mutants
//! cannot reach `main` from a `#[cfg(test)]` unit test, so we spawn the compiled
//! binary via `CARGO_BIN_EXE_tiled_import` and assert on its exit code + stdio.
//!
//! std-only (game-core has no `tempfile` dev-dep): a temp input file is written
//! under `std::env::temp_dir()` with a unique name and removed afterward.
//!
//! kills:
//!   game-core/src/bin/tiled_import.rs:523:19: replace != with == in main
//!   game-core/src/bin/tiled_import.rs:522:5:  replace main with ()

use std::path::PathBuf;
use std::process::Command;

/// Unique temp path helper (std-only; no tempfile crate).
/// Uses the process id + a caller-supplied tag to avoid collisions between
/// concurrently-running test binaries.
fn unique_temp_path(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "mr_tiled_import_{}_{}.json",
        std::process::id(),
        tag
    ));
    p
}

/// Test A — no positional args → the arg-count guard must fail loud.
///
/// `main` computes `args.len()` (== 1 when invoked with no extra args) and
/// checks `args.len() != 3`. The real guard is true → prints "Usage: ..." to
/// stderr and exits 1.
///
/// kills 523:19 (`!= ` → `==`): with `==`, `1 == 3` is false → the usage guard
///   is SKIPPED, `main` falls through to index `args[1]` and PANICS (exit != 1,
///   no "Usage" on stderr) — this test's exit-1 + "Usage" asserts catch that.
/// contributes to 522:5 (`main` → `()`): a no-op main exits 0 with empty stderr,
///   so the exit-1 assert also bites the deleted-main mutant here.
#[test]
fn cli_no_args_prints_usage_and_exits_1() {
    let output = Command::new(env!("CARGO_BIN_EXE_tiled_import"))
        .output()
        .expect("must be able to spawn the tiled_import binary");

    assert_eq!(
        output.status.code(),
        Some(1),
        "no-args invocation must exit with code 1 (bad arg count); \
         got status {:?}. A `!=`→`==` flip skips the usage guard and panics; \
         a deleted `main` exits 0.",
        output.status
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Usage"),
        "no-args invocation must print a Usage message to stderr; got stderr: {stderr:?}"
    );
}

/// Test B — a valid Tiled JSON file + zone_id → success + RON on stdout.
///
/// kills 522:5 (`main` → `()`): a replaced no-op `main` produces NO stdout and
///   never reads the file, so the "success + zone_id in stdout" asserts fail.
///   (The real `main` parses the file and prints the RON `ZoneMapDef`, whose
///   serialization names the `zone_id` field.)
#[test]
fn cli_valid_input_emits_ron_on_stdout() {
    let path = unique_temp_path("valid");
    // Minimal valid Tiled JSON: 2×1 all-floor map, single tile layer.
    let json =
        r#"{"width":2,"height":1,"layers":[{"type":"tilelayer","name":"Tiles","data":[1,1]}]}"#;
    std::fs::write(&path, json).expect("must be able to write the temp input file");

    let output = Command::new(env!("CARGO_BIN_EXE_tiled_import"))
        .arg(&path)
        .arg("7")
        .output()
        .expect("must be able to spawn the tiled_import binary");

    // Clean up the temp file regardless of assertion outcome below.
    let _ = std::fs::remove_file(&path);

    assert!(
        output.status.success(),
        "valid input file + zone_id must exit 0; got status {:?}, stderr: {:?}. \
         A deleted `main` (mutant) would also exit 0 but produce no stdout — the \
         stdout assert below is what distinguishes it.",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("zone_id"),
        "stdout must contain the serialized RON ZoneMapDef (field `zone_id`); \
         got stdout: {stdout:?}. A no-op `main` emits nothing."
    );
    assert!(
        stdout.contains('7'),
        "the RON output must carry the zone_id argument (7); got stdout: {stdout:?}"
    );
}
