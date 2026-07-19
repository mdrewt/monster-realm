//! `playtest` domain-submodule tests — pt-b2 (ADR-0131).
//!
//! Declared from `server-module/src/playtest.rs` as:
//!   `#[cfg(test)] #[path = "playtest_tests.rs"] mod playtest_tests;`
//! so `super::` resolves to `playtest.rs`.
//!
//! Because `playtest.rs` does not yet exist, `include_str!("playtest.rs")`
//! would be a compile error that would prevent ALL tests in this crate from
//! running and expressing their RED state.  To avoid that problem the
//! source-scan tests read playtest.rs at RUNTIME via `std::fs::read_to_string`
//! inside each test body; if the file is absent the test fails with a clear
//! message.  Only the pure-seam tests use `super::` (compile-fail RED until
//! the impl adds the functions).
//!
//! ## RED state (before implementation)
//!
//! - Pure-seam tests (`hp_permille_*`, `playtest_kind_*`, `plan_reap_*`,
//!   `plan_reaper_arm_*`, `build_playtest_event_*`) — **compile-fail RED**
//!   because `super::hp_permille` / `super::PlaytestKind` / `super::plan_reap`
//!   / `super::plan_reaper_arm` / `super::ArmPlan` / `super::build_playtest_event`
//!   / `super::PlaytestEvent` do not exist in the (absent) `playtest.rs`.
//!
//! - Source-scan tests — **runtime-RED** (file absent → `read_to_string` returns
//!   Err → test fails with "playtest.rs not found").
//!
//! ## Scan pipeline
//!
//! Every source-scan test MUST run the three-stage pipeline:
//!   1. `strip_rust_strings`  — blanks `"..."`, `r"..."`, `r#"..."#` content.
//!   2. `strip_rust_comments` — blanks `// ...` and `/* ... */` regions.
//!   3. `squash_ws`           — removes all whitespace (rustfmt-proof).
//!
//! Per ADR-0125 / M17.5d mandatory discipline: string-strip BEFORE comment-strip
//! so that `//` inside a string literal is already blanked before the comment
//! pass walks the buffer.  `squash_ws` makes composite needles rustfmt-proof.
//! Needles are assembled with `concat!()` so this file cannot self-match.

use spacetimedb::Identity;

// ===========================================================================
// ── Scan helpers (local copy — per-module convention, ADR-0125 anti-pattern #5)
// ===========================================================================

/// Strip Rust string literals from `src`, replacing their content (and
/// delimiters) with spaces.  Handles normal `"..."` with `\"` escapes and
/// raw strings `r"..."` / `r#"..."#` (up to 6 `#` hashes).
///
/// Must be the FIRST stage of the scan pipeline.
fn strip_rust_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;

    while i < len {
        // Raw string: r"..." or r#"..."# (up to 6 hashes).
        if bytes[i] == b'r' {
            let mut hashes: usize = 0;
            let mut j = i + 1;
            while j < len && bytes[j] == b'#' && hashes < 6 {
                hashes += 1;
                j += 1;
            }
            if j < len && bytes[j] == b'"' {
                // IS a raw string literal.
                out.push(b' '); // r
                out.resize(out.len() + hashes, b' '); // opening # hashes
                out.push(b' '); // opening "
                j += 1;
                loop {
                    if j >= len {
                        break;
                    }
                    if bytes[j] == b'"' {
                        let mut k = j + 1;
                        let mut closing_hashes: usize = 0;
                        while k < len && bytes[k] == b'#' && closing_hashes < hashes {
                            closing_hashes += 1;
                            k += 1;
                        }
                        if closing_hashes == hashes {
                            out.push(b' '); // closing "
                            out.resize(out.len() + hashes, b' '); // closing # hashes
                            j = k;
                            break;
                        }
                    }
                    out.push(b' ');
                    j += 1;
                }
                i = j;
                continue;
            }
            // Not a raw string — fall through.
        }

        // Normal double-quoted string literal.
        if bytes[i] == b'"' {
            out.push(b' '); // opening "
            i += 1;
            loop {
                if i >= len {
                    break;
                }
                if bytes[i] == b'\\' && i + 1 < len {
                    out.push(b' ');
                    out.push(b' ');
                    i += 2;
                } else if bytes[i] == b'"' {
                    out.push(b' '); // closing "
                    i += 1;
                    break;
                } else {
                    out.push(b' ');
                    i += 1;
                }
            }
            continue;
        }

        out.push(bytes[i]);
        i += 1;
    }

    String::from_utf8(out).expect("string-stripped source must be valid UTF-8")
}

/// Strip Rust block comments (`/* ... */`) and line comments (`// ...`).
/// Replaces comment content with spaces (preserves byte-count for line numbers).
///
/// Run AFTER `strip_rust_strings` so a block-comment or line-comment opener
/// inside a string literal is already blanked before this pass.
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

/// Remove ALL whitespace characters (rustfmt-proof composite-needle matching,
/// per ADR-0125 mandatory third pipeline stage).
fn squash_ws(src: &str) -> String {
    src.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Full three-stage scan pipeline: strip strings → strip comments → squash_ws.
/// ALL source-scan tests MUST use this helper, never a partial pipeline.
fn stripped_for_scan(src: &str) -> String {
    squash_ws(&strip_rust_comments(&strip_rust_strings(src)))
}

/// Extract the body of a named `fn` from `src` (comment+string-stripped but
/// NOT squashed — brace-depth walking requires whitespace to remain).
///
/// Finds `pub fn <name>(` or `fn <name>(`, walks to the first `{`, then counts
/// braces to find the matching `}`.  Returns the slice BETWEEN the outer braces
/// (exclusive), or `None` if not found.
fn extract_fn_body<'a>(src: &'a str, name: &str) -> Option<&'a str> {
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

/// Runtime read of playtest.rs for source-scan tests.
/// Returns Err (with a descriptive message) if the file is absent, so tests
/// fail RED with a clear message rather than a cryptic panic.
fn read_playtest_rs() -> Result<String, String> {
    // The canonical path relative to server-module/src/ during `cargo test`.
    std::fs::read_to_string("src/playtest.rs")
        .map_err(|e| format!("playtest.rs not found — file must exist before source-scan tests can pass (pt-b2 not yet implemented): {e}"))
}

// ===========================================================================
// ── hp_permille pure-seam tests (compile-fail RED until playtest.rs exists)
// ===========================================================================

/// PT-B2 — hp_permille: max==0 returns 0 (no division by zero).
///
/// Kills: impl that does `current * 1000 / max` without guarding max==0 (panic
/// or nonsense result on zero denominator).
#[test]
fn hp_permille_max_zero_returns_zero() {
    assert_eq!(
        super::hp_permille(0, 0),
        0,
        "PT-B2 hp_permille: max==0 must return 0 (guard against divide-by-zero). \
         A u16 division by zero is a panic in debug builds."
    );
    assert_eq!(
        super::hp_permille(100, 0),
        0,
        "PT-B2 hp_permille: current>0 but max==0 must return 0 (still guards max==0)."
    );
}

/// PT-B2 — hp_permille: current==max returns exactly 1000 (full HP).
///
/// Kills: off-by-one where `current * 1000 / max` returns 999 due to integer
/// floor truncation when current==max (a correct impl returns min(1000, floor)).
#[test]
fn hp_permille_full_hp_returns_1000() {
    assert_eq!(
        super::hp_permille(100, 100),
        1000,
        "PT-B2 hp_permille: current==max must return 1000 (100% HP → 1000‰). \
         An off-by-one floor impl returns 999 here."
    );
    assert_eq!(
        super::hp_permille(1, 1),
        1000,
        "PT-B2 hp_permille: current==max==1 must return 1000."
    );
}

/// PT-B2 — hp_permille: half HP returns approximately 500 (integer floor).
///
/// Kills: impl that rounds instead of floors, or that uses floating-point
/// division and reintroduces rounding errors.
#[test]
fn hp_permille_half_hp_returns_500_floor() {
    // 50/100 → 500 exactly.
    assert_eq!(
        super::hp_permille(50, 100),
        500,
        "PT-B2 hp_permille: 50/100 must return 500 (integer floor)."
    );
    // 1/3 → floor(333.3) = 333, NOT 334.
    assert_eq!(
        super::hp_permille(1, 3),
        333,
        "PT-B2 hp_permille: 1/3 must return 333 (floor, not round). \
         Rounding would give 333 here (same), but 2/3 would give 666 vs 667."
    );
    // 2/3 → floor(666.6) = 666.
    assert_eq!(
        super::hp_permille(2, 3),
        666,
        "PT-B2 hp_permille: 2/3 must return 666 (floor, not 667)."
    );
}

/// PT-B2 — hp_permille: current > max is clamped to 1000.
///
/// Kills: impl that returns >1000 for an overheal scenario (e.g. a temporary HP
/// buff). The contract specifies `min(1000, current*1000/max)`.
#[test]
fn hp_permille_over_max_is_clamped_to_1000() {
    assert_eq!(
        super::hp_permille(200, 100),
        1000,
        "PT-B2 hp_permille: current > max must be clamped to 1000. \
         Without the clamp, an overheal would return 2000 (overflow for u16 if \
         current*1000 overflows, or just a wrong value)."
    );
    assert_eq!(
        super::hp_permille(u16::MAX, 1),
        1000,
        "PT-B2 hp_permille: u16::MAX / 1 must still be clamped to 1000."
    );
}

/// PT-B2 — hp_permille: current==0 returns 0 (fainted monster).
///
/// Kills: impl that returns 1 or some non-zero floor due to a rounding bug.
#[test]
fn hp_permille_zero_current_returns_zero() {
    assert_eq!(
        super::hp_permille(0, 100),
        0,
        "PT-B2 hp_permille: current==0 must return 0 (fainted, 0‰)."
    );
    assert_eq!(
        super::hp_permille(0, 1),
        0,
        "PT-B2 hp_permille: current==0, any max must return 0."
    );
}

/// PT-B2 — hp_permille: all outputs are ≤ 1000 (property exhaustive over
/// small values). Tests the full domain for small u16 values to prove the
/// clamp is universally applied.
///
/// Kills: any impl where the clamp only covers the specific `current > max`
/// branch but not the multiplication overflow path.
#[test]
fn hp_permille_result_always_leq_1000() {
    // Exhaustive for a grid of (current, max) pairs covering the likely
    // edge-case space. NOT a property test requiring fast-check — the pure
    // math is simple enough for a targeted exhaustive check.
    let test_cases: &[(u16, u16)] = &[
        (0, 1),
        (1, 1),
        (1, 2),
        (999, 1000),
        (1000, 1000),
        (1001, 1000),
        (u16::MAX, u16::MAX),
        (u16::MAX, 1),
        (100, 100),
        (50, 100),
        (0, 0),
    ];
    for &(current, max) in test_cases {
        let result = super::hp_permille(current, max);
        assert!(
            result <= 1000,
            "PT-B2 hp_permille: result must always be ≤ 1000 (clamp 0..=1000). \
             Got {} for current={}, max={}.",
            result,
            current,
            max
        );
    }
}

// ===========================================================================
// ── PlaytestKind::code() pinned literal test (compile-fail RED)
// ===========================================================================

/// PT-B2 — PlaytestKind::RecruitAttempt.code() must return the pinned literal 1.
///
/// Kills:
///   - impl that uses `self as u16` (would return 0 for the first variant,
///     not 1; the spec says EXPLICIT literal `RecruitAttempt => 1`).
///   - impl that accidentally maps RecruitAttempt to 2 or any other value.
///   - impl that changes the variant ordering and breaks the `as u16` shorthand.
///
/// RATIONALE: source-scan below separately checks absence of `as u16`, but this
/// executed test is the primary mutation-killing pin for the value itself.
#[test]
fn playtest_kind_recruit_attempt_code_is_1() {
    assert_eq!(
        super::PlaytestKind::RecruitAttempt.code(),
        1u16,
        "PT-B2 PlaytestKind::RecruitAttempt.code() must return exactly 1. \
         The spec pins the explicit literal: `RecruitAttempt => 1`. \
         Using `self as u16` would return 0 (first variant ordinal in Rust). \
         A mutation to code() => 2 must also fail this test."
    );
}

// ===========================================================================
// ── plan_reap pure-seam tests (compile-fail RED)
// ===========================================================================

/// PT-B2 plan_reap (a): all-fresh rows, count ≤ cap → returns [].
///
/// Kills: impl that always deletes something regardless of TTL or cap.
#[test]
fn plan_reap_all_fresh_under_cap_returns_empty() {
    let now_ms = 10_000_i64;
    let ttl_ms = 5_000_i64;
    let cap = 10u64;
    // 3 rows, all created 1 ms ago (well within TTL), count < cap.
    let rows: Vec<(u64, i64)> = vec![(1, 9_999), (2, 9_998), (3, 9_997)];
    let result = super::plan_reap(&rows, now_ms, ttl_ms, cap, 100);
    assert!(
        result.is_empty(),
        "PT-B2 plan_reap (a): all-fresh rows under cap must return [] (nothing to delete). \
         Got: {:?}.",
        result
    );
}

/// PT-B2 plan_reap (b): count > cap, none expired → returns OLDEST (count-cap) ids.
///
/// This is the primary cap-eviction tooth. The spec says: from the fresh
/// (non-expired) rows, return the oldest `(fresh_count - cap)` ids. Input is
/// sorted ascending by event_id (oldest first).
///
/// Kills:
///   - impl that keeps the oldest and deletes the newest (wrong eviction direction)
///   - impl that returns just the count correct but picks wrong ids (length-only check)
///   - impl that returns cap ids instead of (count - cap) ids
#[test]
fn plan_reap_over_cap_no_expired_returns_oldest() {
    let now_ms = 100_000_i64;
    let ttl_ms = 60_000_i64; // 60s TTL
    let cap = 3u64;
    let batch = 100;
    // 5 fresh rows (created 1s ago — well within 60s TTL), ids 10..14 ascending.
    // count(5) > cap(3) → must evict 2 oldest: ids 10, 11.
    let rows: Vec<(u64, i64)> = vec![
        (10, 99_000), // oldest
        (11, 99_100),
        (12, 99_200),
        (13, 99_300),
        (14, 99_400), // newest
    ];
    let mut result = super::plan_reap(&rows, now_ms, ttl_ms, cap, batch);
    result.sort_unstable();
    assert_eq!(
        result,
        vec![10u64, 11],
        "PT-B2 plan_reap (b): over-cap with no expired rows must evict the OLDEST \
         (count-cap) ids. cap=3, count=5 → evict 2 oldest (ids 10,11). \
         Kills: impl that keeps oldest and deletes newest (would return [13,14])."
    );
}

/// PT-B2 plan_reap (c): some expired rows → ALL expired ids are returned.
///
/// Kills: impl that ignores TTL expiry and only applies cap eviction.
#[test]
fn plan_reap_expired_rows_all_returned() {
    let now_ms = 100_000_i64;
    let ttl_ms = 10_000_i64; // 10s TTL
    let cap = 100u64; // large cap so no cap-eviction
    let batch = 100;
    // Rows 1 and 2: expired (created 20s ago, ttl is 10s).
    // Rows 3 and 4: fresh (created 1s ago).
    let rows: Vec<(u64, i64)> = vec![
        (1, 80_000), // expired: now - created = 20000 >= ttl 10000
        (2, 85_000), // expired: 15000 >= 10000
        (3, 99_000), // fresh: 1000 < 10000
        (4, 99_500), // fresh: 500 < 10000
    ];
    let mut result = super::plan_reap(&rows, now_ms, ttl_ms, cap, batch);
    result.sort_unstable();
    assert_eq!(
        result,
        vec![1u64, 2],
        "PT-B2 plan_reap (c): expired rows (now - created >= ttl) must all be returned. \
         IDs 1 and 2 are expired; ids 3 and 4 are fresh and under cap."
    );
}

/// PT-B2 plan_reap (d): expired rows + over-cap fresh rows → union of both.
///
/// Kills: impl that only handles one condition (expired OR cap) but not both
/// simultaneously in the same call.
#[test]
fn plan_reap_expired_plus_over_cap_returns_union() {
    let now_ms = 100_000_i64;
    let ttl_ms = 10_000_i64; // 10s TTL
    let cap = 2u64;
    let batch = 100;
    // Rows 1,2: expired.
    // Rows 3,4,5: fresh (created 1s ago), count(3) > cap(2) → oldest 1 fresh evicted.
    let rows: Vec<(u64, i64)> = vec![
        (1, 80_000), // expired
        (2, 85_000), // expired
        (3, 99_000), // fresh, oldest
        (4, 99_100), // fresh
        (5, 99_200), // fresh, newest
    ];
    let mut result = super::plan_reap(&rows, now_ms, ttl_ms, cap, batch);
    result.sort_unstable();
    // Expired: [1, 2]. Fresh over-cap: count=3, cap=2 → evict 1 oldest fresh = id 3.
    // Union = [1, 2, 3].
    assert_eq!(
        result,
        vec![1u64, 2, 3],
        "PT-B2 plan_reap (d): expired + over-cap must return the union. \
         Expired=[1,2], fresh count=3 over cap=2 → oldest fresh evicted=[3]. \
         Union=[1,2,3]."
    );
}

/// PT-B2 plan_reap (e): result truncated to `batch` when delete-set > batch.
///
/// Kills: impl that ignores the batch limit (returns all matching ids regardless
/// of how many that is, making a single tick unboundedly expensive).
#[test]
fn plan_reap_truncated_to_batch() {
    let now_ms = 100_000_i64;
    let ttl_ms = 1_000_i64; // 1s TTL — all rows will be expired
    let cap = 0u64; // also all are over-cap for good measure
    let batch = 3;
    // 6 rows all expired (created 90s ago), ids 1..6 ascending.
    let rows: Vec<(u64, i64)> = vec![
        (1, 9_000),
        (2, 9_100),
        (3, 9_200),
        (4, 9_300),
        (5, 9_400),
        (6, 9_500),
    ];
    let result = super::plan_reap(&rows, now_ms, ttl_ms, cap, batch);
    assert_eq!(
        result.len(),
        3,
        "PT-B2 plan_reap (e): result must be truncated to `batch`=3. \
         Without truncation, all 6 expired rows would be returned, making the \
         tick O(unbounded). Got: {:?}.",
        result
    );
    // The spec says oldest are deleted first when truncating.
    let mut result = result;
    result.sort_unstable();
    assert_eq!(
        result,
        vec![1u64, 2, 3],
        "PT-B2 plan_reap (e): when truncating to batch, must return the OLDEST \
         ids (front of sorted input), not arbitrary ids. Got: {:?}.",
        result
    );
}

/// PT-B2 plan_reap (f): TTL boundary exactness.
///
/// - A row at `created = now - ttl` IS deleted (>= means "at least TTL old").
/// - A row at `created = now - ttl + 1` is NOT deleted (one ms newer than cutoff).
///
/// Kills: impl that uses `>` instead of `>=` (off-by-one, rows exactly at the
/// TTL boundary are never deleted — a subtle leak).
#[test]
fn plan_reap_ttl_boundary_exactness() {
    let now_ms = 10_000_i64;
    let ttl_ms = 5_000_i64;
    let cap = 100u64; // large cap, no cap eviction
    let batch = 100;

    // Row at EXACTLY the boundary: now - created = ttl → MUST be deleted.
    let at_boundary: Vec<(u64, i64)> = vec![(1, 5_000)]; // now(10000) - created(5000) = 5000 == ttl(5000)
    let result = super::plan_reap(&at_boundary, now_ms, ttl_ms, cap, batch);
    assert_eq!(
        result,
        vec![1u64],
        "PT-B2 plan_reap (f) AT-boundary: row with created_at = now - ttl ({}) must be \
         deleted (>= comparison). \
         Kills: impl using > instead of >=.",
        at_boundary[0].1
    );

    // Row one ms fresher than boundary: now - created = ttl - 1 → MUST NOT be deleted.
    let just_fresh: Vec<(u64, i64)> = vec![(2, 5_001)]; // now - created = 4999 < 5000
    let result = super::plan_reap(&just_fresh, now_ms, ttl_ms, cap, batch);
    assert!(
        result.is_empty(),
        "PT-B2 plan_reap (f) JUST-FRESH: row with created_at = now - ttl + 1 ({}) must NOT \
         be deleted (4999 < 5000). \
         Kills: impl using > that turns into wrong boundary when rearranged.",
        just_fresh[0].1
    );
}

// ===========================================================================
// ── plan_reaper_arm pure-seam tests (compile-fail RED)
// ===========================================================================

/// PT-B2 plan_reaper_arm: empty existing_ids → insert one, delete nothing.
///
/// Kills: impl that does nothing on empty (singleton invariant not enforced on
/// arm — the reaper would never be scheduled).
#[test]
fn plan_reaper_arm_empty_inserts_one() {
    let plan = super::plan_reaper_arm(&[]);
    assert!(
        plan.insert_one,
        "PT-B2 plan_reaper_arm: empty existing_ids must set insert_one=true \
         (no reaper scheduled yet → must insert the singleton row)."
    );
    assert!(
        plan.delete_ids.is_empty(),
        "PT-B2 plan_reaper_arm: empty existing_ids must have no delete_ids. \
         Got: {:?}.",
        plan.delete_ids
    );
}

/// PT-B2 plan_reaper_arm: single existing id → no insert, no delete.
///
/// Kills: impl that always inserts (would create duplicates) or always deletes
/// (would remove the only singleton, breaking the schedule entirely).
#[test]
fn plan_reaper_arm_single_existing_no_change() {
    let plan = super::plan_reaper_arm(&[7u64]);
    assert!(
        !plan.insert_one,
        "PT-B2 plan_reaper_arm: one existing row must set insert_one=false \
         (singleton already present — do not create a duplicate)."
    );
    assert!(
        plan.delete_ids.is_empty(),
        "PT-B2 plan_reaper_arm: one existing row must have empty delete_ids \
         (the single row IS the singleton — keep it). Got: {:?}.",
        plan.delete_ids
    );
}

/// PT-B2 plan_reaper_arm: multiple existing ids → no insert, delete all but first.
///
/// Kills: impl that keeps the last instead of the first (wrong dedup direction),
/// or that deletes all (would destroy the singleton), or that does nothing (would
/// leave duplicates that fire the reaper multiple times).
#[test]
fn plan_reaper_arm_multiple_keeps_first_deletes_rest() {
    let plan = super::plan_reaper_arm(&[7u64, 9, 11]);
    assert!(
        !plan.insert_one,
        "PT-B2 plan_reaper_arm: multiple existing rows must set insert_one=false \
         (at least one row present already)."
    );
    let mut got = plan.delete_ids.clone();
    got.sort_unstable();
    assert_eq!(
        got,
        vec![9u64, 11],
        "PT-B2 plan_reaper_arm: must keep the FIRST id (7) and delete the rest (9, 11). \
         Kills: impl that keeps last and deletes rest (would return [7, 9]); \
         impl that deletes all (would return [7, 9, 11])."
    );
}

// ===========================================================================
// ── build_playtest_event pure-seam tests (compile-fail RED)
// ===========================================================================

/// PT-B2 build_playtest_event: bait_item_id=None maps to 0 in the row.
///
/// Kills: impl that stores None as Some(0) or that leaves the field undefined.
#[test]
fn build_playtest_event_none_bait_maps_to_zero() {
    let id = Identity::from_byte_array([1u8; 32]);
    let row = super::build_playtest_event(id, 1, 12345, 42, 99, 500, None, true);
    assert_eq!(
        row.bait_item_id, 0,
        "PT-B2 build_playtest_event: bait_item_id=None must store 0 (sentinel 'no bait'). \
         Got: {}.",
        row.bait_item_id
    );
}

/// PT-B2 build_playtest_event: bait_item_id=Some(3) maps to 3 in the row.
///
/// Kills: impl that ignores the Some value and always stores 0 or a wrong id.
#[test]
fn build_playtest_event_some_bait_maps_to_value() {
    let id = Identity::from_byte_array([2u8; 32]);
    let row = super::build_playtest_event(id, 1, 0, 0, 0, 0, Some(3u32), false);
    assert_eq!(
        row.bait_item_id, 3,
        "PT-B2 build_playtest_event: bait_item_id=Some(3) must store 3. \
         Got: {}.",
        row.bait_item_id
    );
}

/// PT-B2 build_playtest_event: event_id must be 0 (auto_inc placeholder).
///
/// Kills: impl that sets event_id to a non-zero value (the auto_inc column
/// must be 0 on insert so SpacetimeDB fills it in).
#[test]
fn build_playtest_event_id_is_zero_placeholder() {
    let id = Identity::from_byte_array([3u8; 32]);
    let row = super::build_playtest_event(id, 1, 0, 0, 0, 0, None, false);
    assert_eq!(
        row.event_id, 0,
        "PT-B2 build_playtest_event: event_id must be 0 (auto_inc placeholder). \
         SpacetimeDB fills in the real id on insert. Got: {}.",
        row.event_id
    );
}

/// PT-B2 build_playtest_event: all other fields pass through unchanged.
///
/// Kills:
///   - impl that swaps kind and hp_permille
///   - impl that ignores the success flag
///   - impl that truncates species_id or battle_id
///   - impl that stores a wrong identity
#[test]
fn build_playtest_event_passthrough_fields() {
    let id = Identity::from_byte_array([42u8; 32]);
    let kind: u16 = 7;
    let now_ms: i64 = 99_999;
    let battle_id: u64 = 12345;
    let species_id: u32 = 678;
    let hp_pm: u16 = 333;
    let success = true;

    let row = super::build_playtest_event(
        id, kind, now_ms, battle_id, species_id, hp_pm, None, success,
    );

    assert_eq!(row.identity, id, "identity passthrough");
    assert_eq!(row.kind, kind, "kind passthrough");
    assert_eq!(row.created_at_ms, now_ms, "created_at_ms passthrough");
    assert_eq!(row.battle_id, battle_id, "battle_id passthrough");
    assert_eq!(row.species_id, species_id, "species_id passthrough");
    assert_eq!(row.hp_permille, hp_pm, "hp_permille passthrough");
    assert_eq!(row.success, success, "success passthrough");
}

// ===========================================================================
// ── Source-scan tests over playtest.rs (runtime-RED — file absent today)
// ===========================================================================

/// PT-B2-SCAN-01: `playtest_reaper` reducer body has the scheduler-only identity
/// guard BEFORE any table delete.
///
/// The guard shape must be `ctx.sender != ctx.identity()` in the reducer body.
/// This is the same pattern as pvp_deadline_reaper (EA-PVP-02) and
/// battle_challenge_reaper (EA-CHR-03) — a consistent project convention.
///
/// Kills:
///   - impl that omits the guard (any client can call the reaper and delete
///     arbitrary events)
///   - impl that puts the guard AFTER a delete (partial deletion before abort)
///   - a string-literal evasion where the guard text appears only in a comment
///     or string (three-stage pipeline closes this)
#[test]
fn scan_playtest_reaper_has_scheduler_guard_before_delete() {
    let src = match read_playtest_rs() {
        Ok(s) => s,
        Err(e) => panic!("{}", e),
    };
    // ADR-0125 discipline: string-strip BEFORE comment-strip (a `//` inside a string
    // literal must be blanked before the comment pass walks the buffer).
    let stripped = strip_rust_comments(&strip_rust_strings(&src));

    let body = extract_fn_body(&stripped, "playtest_reaper")
        .expect("PT-B2-SCAN-01: `playtest_reaper` function not found in playtest.rs");

    let guard = concat!("ctx.sender", " != ", "ctx.identity()");
    let delete_needle = concat!("playtest_event()", ".event_id().delete");

    assert!(
        body.contains(guard),
        "PT-B2-SCAN-01 FAIL: `playtest_reaper` body does not contain the \
         scheduler-only identity guard `ctx.sender != ctx.identity()`. \
         Without this guard, any client can call the reaper and delete \
         arbitrary playtest_event rows (ADR-0126 precedent / EA-PVP-02 / EA-CHR-03)."
    );

    // Guard must appear BEFORE any playtest_event delete in the function body.
    let guard_pos = body.find(guard).unwrap();
    let delete_pos = body.find(delete_needle);
    if let Some(dp) = delete_pos {
        assert!(
            guard_pos < dp,
            "PT-B2-SCAN-01 FAIL: the scheduler guard appears AFTER a delete call \
             in `playtest_reaper` body (guard at byte {}, delete at byte {}). \
             The guard must be the FIRST action so malicious callers are rejected \
             before any rows are touched.",
            guard_pos,
            dp
        );
    }
}

/// PT-B2-SCAN-02 (RT-PTB2-02 / M-2): `ensure_playtest_reaper` (or the schedule
/// insert inside `playtest_reaper` / `ensure_playtest_reaper`) uses
/// `ScheduleAt::Interval` and NOT `ScheduleAt::Time`.
///
/// Using `ScheduleAt::Time` schedules a one-shot run; `Interval` is required
/// for a recurring reaper. This mirrors the `movement_tick_schedule` pattern
/// (lib.rs `ensure_zone_schedules`).
///
/// Kills: impl that uses the one-shot `ScheduleAt::Time(...)` form.
#[test]
fn scan_playtest_schedule_uses_interval_not_time() {
    let src = match read_playtest_rs() {
        Ok(s) => s,
        Err(e) => panic!("{}", e),
    };
    // String-strip + comment-strip before scanning to prevent evasion via string
    // literal or comment containing the needle.
    // ADR-0125 discipline: string-strip BEFORE comment-strip (a `//` inside a string
    // literal must be blanked before the comment pass walks the buffer).
    let stripped = strip_rust_comments(&strip_rust_strings(&src));

    let interval_needle = concat!("ScheduleAt::", "Interval(");
    assert!(
        stripped.contains(interval_needle),
        "PT-B2-SCAN-02 FAIL: playtest.rs does not contain `ScheduleAt::Interval(`. \
         The reaper schedule row must use Interval for recurring execution, not Time \
         (RT-PTB2-02 / M-2). Using Time would result in a one-shot reap."
    );

    // Negative: ScheduleAt::Time must NOT appear (it is the one-shot form).
    // Assembled with concat!() to avoid self-match in this test file.
    let time_needle = concat!("ScheduleAt::", "Time(");
    assert!(
        !stripped.contains(time_needle),
        "PT-B2-SCAN-02 FAIL: playtest.rs contains `ScheduleAt::Time(` — this is the \
         one-shot form. Reaper schedules must use `ScheduleAt::Interval` for recurring \
         execution (RT-PTB2-02 / M-2)."
    );
}

/// PT-B2-SCAN-03: `PlaytestKind` does NOT carry `SpacetimeType` in its derive
/// and `code()` has no `as u16` cast anywhere in the file.
///
/// SpacetimeType on the kind enum would leak the variant list to the client
/// via the schema. The code() fn must use explicit match arms so future
/// variants require explicit assignment (not just reordering).
///
/// Kills:
///   - impl that adds `#[derive(SpacetimeType)]` to PlaytestKind (client leak)
///   - impl that uses `self as u16` in code() (ordinal-dependent, fragile)
#[test]
fn scan_playtest_kind_no_spacetime_type_no_as_u16() {
    let src = match read_playtest_rs() {
        Ok(s) => s,
        Err(e) => panic!("{}", e),
    };
    // ADR-0125 discipline: string-strip BEFORE comment-strip (a `//` inside a string
    // literal must be blanked before the comment pass walks the buffer).
    let stripped = strip_rust_comments(&strip_rust_strings(&src));
    let squashed = squash_ws(&stripped);

    // Negative: SpacetimeType must NOT appear adjacent to PlaytestKind.
    // We scan the un-squashed stripped source for the derive line specifically.
    // Needle: `derive(...SpacetimeType...)` near `PlaytestKind`.
    // Approach: check that the squashed source does not contain the token
    // `SpacetimeType` anywhere (playtest.rs has no other reason to use it).
    let st_needle = "SpacetimeType";
    assert!(
        !squashed.contains(st_needle),
        "PT-B2-SCAN-03 FAIL: playtest.rs contains `SpacetimeType` — this must NOT \
         be derived on `PlaytestKind` (would expose variant list to clients via schema). \
         The kind field is stored as u16; use the `code()` method for the mapping."
    );

    // Negative: `as u16` must not appear in the code() function body.
    // Extract the code() body for a narrower check.
    let code_body = extract_fn_body(&stripped, "code")
        .expect("PT-B2-SCAN-03: `code` function not found in playtest.rs");
    let as_u16_needle = "as u16";
    assert!(
        !squash_ws(code_body).contains(&squash_ws(as_u16_needle)),
        "PT-B2-SCAN-03 FAIL: `code()` body contains `as u16` cast. \
         The spec requires explicit match arms with literal values \
         (e.g. `RecruitAttempt => 1`) so future variants require explicit \
         assignment rather than relying on discriminant ordering."
    );
}

/// PT-B2-SCAN-04: `ensure_playtest_reaper` calls `plan_reaper_arm` and
/// `record_recruit_event` references `PlaytestKind::RecruitAttempt`.
///
/// These source-scan pins ensure the thin-shell functions wire through
/// the pure seams rather than reimplementing the logic inline.
///
/// Kills:
///   - ensure_playtest_reaper that bypasses the plan_reaper_arm seam (inline logic)
///   - record_recruit_event that hardcodes 1u16 instead of using the enum
#[test]
fn scan_wiring_needles() {
    let src = match read_playtest_rs() {
        Ok(s) => s,
        Err(e) => panic!("{}", e),
    };
    let squashed = stripped_for_scan(&src);

    // ensure_playtest_reaper must call plan_reaper_arm.
    // Split at "plan_reaper" to prevent self-match.
    let arm_needle = concat!("plan_reaper", "_arm(");
    assert!(
        squashed.contains(arm_needle),
        "PT-B2-SCAN-04 FAIL: playtest.rs does not contain `{}` (squashed). \
         `ensure_playtest_reaper` must delegate to the pure `plan_reaper_arm` \
         seam rather than inlining the singleton logic.",
        arm_needle
    );

    // record_recruit_event must reference PlaytestKind::RecruitAttempt.
    // Split at "PlaytestKind::" to prevent self-match.
    let kind_needle = concat!("PlaytestKind::", "RecruitAttempt");
    assert!(
        squashed.contains(kind_needle),
        "PT-B2-SCAN-04 FAIL: playtest.rs does not contain `{}` (squashed). \
         `record_recruit_event` must pass `PlaytestKind::RecruitAttempt.code()` \
         rather than hardcoding the literal 1, so the mapping is owned by the \
         enum's explicit match arm.",
        kind_needle
    );
}

// ===========================================================================
// ── Scan machinery self-teeth (GREEN — verifies the pipeline works)
// ===========================================================================

/// Machinery self-teeth: proves that `stripped_for_scan` correctly:
///   1. Rejects a BAD fixture (needle in comment — must NOT match after stripping).
///   2. Accepts a GOOD fixture (needle in real code — MUST match after stripping).
///   3. Rejects an EVASION fixture (needle only in a string literal — must NOT match).
///
/// If this test fails, the scan helpers themselves are broken and none of the
/// source-scan tests above can be trusted.
#[test]
fn scan_machinery_self_teeth() {
    // Use the scheduler-guard needle (same as scan_playtest_reaper_has_scheduler_guard_before_delete).
    let needle_squashed = squash_ws(concat!("ctx.sender", " != ", "ctx.identity()"));

    // BAD fixture: guard only in a comment.
    let bad_fixture = r#"
        #[spacetimedb::reducer]
        pub fn playtest_reaper(ctx: &ReducerContext, _sched: PlaytestReaperSchedule) -> Result<(), String> {
            // ctx.sender != ctx.identity() — just a comment, not enforced!
            for row in ctx.db.playtest_event().iter() {
                ctx.db.playtest_event().event_id().delete(row.event_id);
            }
            Ok(())
        }
    "#;
    let bad_squashed = stripped_for_scan(bad_fixture);
    assert!(
        !bad_squashed.contains(&needle_squashed),
        "SELF-TEETH BAD: guard in comment should NOT match after stripped_for_scan. \
         The comment-stripping stage is broken."
    );

    // GOOD fixture: guard in real code.
    let good_fixture = r#"
        #[spacetimedb::reducer]
        pub fn playtest_reaper(ctx: &ReducerContext, _sched: PlaytestReaperSchedule) -> Result<(), String> {
            if ctx.sender != ctx.identity() {
                return Err("scheduler only".to_string());
            }
            Ok(())
        }
    "#;
    let good_squashed = stripped_for_scan(good_fixture);
    assert!(
        good_squashed.contains(&needle_squashed),
        "SELF-TEETH GOOD: guard in real code MUST match after stripped_for_scan. \
         The scan pipeline is broken."
    );

    // EVASION fixture: guard only in a string literal.
    let evasion_fixture = format!(
        r#"
        pub fn playtest_reaper(ctx: &ReducerContext, _s: u64) {{
            let _guard_evasion = "{}";
        }}
        "#,
        concat!("ctx.sender", " != ", "ctx.identity()")
    );
    let evasion_squashed = stripped_for_scan(&evasion_fixture);
    assert!(
        !evasion_squashed.contains(&needle_squashed),
        "SELF-TEETH EVASION: guard in string literal must NOT match after stripped_for_scan. \
         The string-stripping stage is broken (red-team F1)."
    );
}
