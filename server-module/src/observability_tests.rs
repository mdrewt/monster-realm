//! `observability` domain-submodule tests (m20a, ADR-0180 D6) — behavioral half
//! plus gate **G7**, the Rust-side mirror of the eval layer's G1 bare-`log::`
//! ratchet.
//!
//! Wired from `observability.rs` as
//! `#[cfg(test)] #[path = "observability_tests.rs"] mod observability_tests;`
//! (the `playtest.rs:204` idiom), so `super` resolves to `observability`.
//!
//! WHY A SECOND SCANNER. `evals/observability-log-wrapper.eval.mjs` already
//! enforces the OBS-2 ratchet in JavaScript. This module re-implements the SAME
//! counting rule INDEPENDENTLY, in Rust, and compares against the same committed
//! `.log-baseline`. Two implementations across a toolchain boundary is the
//! `accounts_tests.rs` / `ranking-security.eval.mjs` precedent: a bug in one
//! scanner cannot make both green. Nothing is imported from the eval — that
//! would collapse the two into one.
//!
//! THE COUNTING RULE (identical to the eval's, restated so the two can be diffed
//! by eye):
//!   1. recursive walk of `server-module/src`, `.rs` only, `_tests.rs` excluded
//!      (so THIS file is self-excluded);
//!   2. per file, blank every line whose TRIMMED form starts with a double
//!      slash (covers the plain, doc and inner-doc forms) — the ONLY stripping;
//!   3. count `log::info!` / `log::warn!` / `log::error!` / `log::log!`, each
//!      followed by any run of whitespace and/or COMPLETE block comments, then
//!      one of the three macro delimiters (the comment skip closes a compiled
//!      proof-of-concept where a comment sits between the `!` and its paren);
//!   4. flat-ban, zero tolerance, in every non-test file including the blessed
//!      emission points: `use log` and `use ::log` as tokens, `extern crate
//!      log`, and the `rustfmt::skip` attribute anywhere. The last one is not a
//!      logging construct: it is what lets the spaced macro path
//!      `log :: warn ! (...)` — which matches no needle in either scanner —
//!      survive `cargo fmt --check`. Banning it keeps fmt as the normalizer.
//!      ACCEPTED RESIDUAL (disclosed): a comment spliced inside the macro PATH
//!      itself still evades the needles; it too needs the skip attribute to
//!      survive fmt, so the ban is the practical net.
//!
//! SOURCE-SCAN HYGIENE (house rules, learned the hard way):
//!   - every needle is assembled with `concat!`, so this file never contains a
//!     contiguous copy of what it searches for and cannot satisfy its own scan
//!     (or anyone else's crate-wide concatenated scan);
//!   - no double quote is ever spelled as a CHAR literal (`guards_tests` G-5a:
//!     the repo's text-level strippers have no char-literal lexer, and one bare
//!     quote inverts string/code polarity for the rest of the file);
//!   - a slash immediately followed by an asterisk is never written anywhere in
//!     this file, not even in prose: the evals' comment stripper is a non-greedy
//!     regex over sources concatenated in sorted filename order, and an unpaired
//!     opener swallows a LATER file's contents (guards_tests G-5b).

use super::*;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

// ===========================================================================
// Behavioral half — the pure `build_log_line` envelope (ADR-0180 D6/D15).
//
// Emission contract, fixed deterministic order:
//   {"evt":"<esc>",<extra_fields_json>,"cause":"<esc>",
//    "sched":{"target_reducer":"<esc>","scheduled_at":<i64>},"phase":"<esc>"}
// Optional fields appear only when `Some`, each comma-prefixed; an empty
// `extra_fields_json` must not leave a dangling comma.
// ===========================================================================

/// The heartbeat envelope, byte for byte (OBS-1/OBS-4).
///
/// Kills: an impl that emits the breadcrumb keys unconditionally (as `null`,
/// or as empty strings), and one that reorders `evt` after the extra fragment.
#[test]
fn build_log_line_all_none_is_the_bare_envelope() {
    let line = build_log_line("heartbeat", "\"content_version\":19", Breadcrumb::default());
    assert_eq!(
        line, "{\"evt\":\"heartbeat\",\"content_version\":19}",
        "all-None Breadcrumb must emit evt + the extra fragment and nothing else"
    );
}

/// Empty extra fragment must not leave a dangling comma.
///
/// Kills: `format!("{{\"evt\":\"{e}\",{extra}}}")` — the obvious first draft,
/// which emits invalid JSON (`{"evt":"x",}`) that Loki silently drops.
#[test]
fn build_log_line_empty_extra_has_no_dangling_comma() {
    let line = build_log_line("x", "", Breadcrumb::default());
    assert_eq!(line, "{\"evt\":\"x\"}");
    assert!(
        !line.contains(",}"),
        "empty extra_fields_json produced a dangling comma: {line}"
    );
}

/// `cause` alone.
#[test]
fn build_log_line_cause_only() {
    let bc = Breadcrumb {
        cause: Some("zone_7"),
        ..Breadcrumb::default()
    };
    assert_eq!(
        build_log_line("warp", "", bc),
        "{\"evt\":\"warp\",\"cause\":\"zone_7\"}"
    );
}

/// `sched` alone renders a NESTED OBJECT with an UNQUOTED i64, and negative
/// values survive (the scheduler's `scheduled_at` is a raw millisecond i64).
///
/// Kills: an impl that quotes `scheduled_at` (breaks numeric range queries) and
/// one that flattens the pair into two sibling keys.
#[test]
fn build_log_line_sched_only_nests_an_unquoted_i64() {
    let bc = Breadcrumb {
        sched: Some(("movement_tick", -42)),
        ..Breadcrumb::default()
    };
    assert_eq!(
        build_log_line("enqueue", "", bc),
        "{\"evt\":\"enqueue\",\"sched\":{\"target_reducer\":\"movement_tick\",\"scheduled_at\":-42}}"
    );
}

/// `sched` at the i64 extremes — no truncation, no scientific notation.
#[test]
fn build_log_line_sched_handles_i64_bounds() {
    let bc = Breadcrumb {
        sched: Some(("t", i64::MIN)),
        ..Breadcrumb::default()
    };
    let line = build_log_line("e", "", bc);
    assert!(
        line.contains(&format!("\"scheduled_at\":{}", i64::MIN)),
        "i64::MIN was not rendered verbatim: {line}"
    );
}

/// `phase` alone. (Value deliberately NOT `enter`/`exit`: `$trace_pair_set` must
/// stay EMPTY through m20a — see the AM7 assertion further down.)
#[test]
fn build_log_line_phase_only() {
    let bc = Breadcrumb {
        phase: Some("event"),
        ..Breadcrumb::default()
    };
    assert_eq!(
        build_log_line("tick", "", bc),
        "{\"evt\":\"tick\",\"phase\":\"event\"}"
    );
}

/// All three breadcrumbs plus an extra fragment, in the ONE canonical order
/// cause -> sched -> phase.
///
/// Kills: an impl that renders the optional fields in `Option`-discovery or
/// hash order — the relay's reconstruction keys on field order being stable.
#[test]
fn build_log_line_all_three_in_fixed_order() {
    let bc = Breadcrumb {
        cause: Some("c"),
        sched: Some(("t", 7)),
        phase: Some("event"),
    };
    assert_eq!(
        build_log_line("x", "\"a\":1", bc),
        "{\"evt\":\"x\",\"a\":1,\"cause\":\"c\",\"sched\":{\"target_reducer\":\"t\",\
         \"scheduled_at\":7},\"phase\":\"event\"}"
    );
}

/// Every escaped position uses `guards::json_escape`'s vocabulary: a double
/// quote becomes backslash-quote, a backslash doubles, a newline takes its short
/// form, and a control character becomes a four-digit lowercase `\u` escape.
///
/// Kills: an impl that interpolates `evt` raw (a quote in `evt` would let a
/// caller inject sibling keys) and one that re-implements escaping with
/// sequential `str::replace` (which double-escapes an inserted backslash).
#[test]
fn build_log_line_escapes_evt() {
    assert_eq!(
        build_log_line("a\u{0022}b", "", Breadcrumb::default()),
        "{\"evt\":\"a\\\"b\"}"
    );
    assert_eq!(
        build_log_line("a\\b", "", Breadcrumb::default()),
        "{\"evt\":\"a\\\\b\"}"
    );
    assert_eq!(
        build_log_line("a\nb", "", Breadcrumb::default()),
        "{\"evt\":\"a\\nb\"}"
    );
    assert_eq!(
        build_log_line("a\u{0001}b", "", Breadcrumb::default()),
        "{\"evt\":\"a\\u0001b\"}"
    );
}

/// The same escaping applies to `cause`, `phase` and `sched.0` — the three other
/// caller-controlled string positions.
#[test]
fn build_log_line_escapes_every_breadcrumb_string() {
    let bc = Breadcrumb {
        cause: Some("c\u{0022}c"),
        sched: Some(("t\\t", 1)),
        phase: Some("p\u{0001}p"),
    };
    assert_eq!(
        build_log_line("e", "", bc),
        "{\"evt\":\"e\",\"cause\":\"c\\\"c\",\"sched\":{\"target_reducer\":\"t\\\\t\",\
         \"scheduled_at\":1},\"phase\":\"p\\u0001p\"}"
    );
}

/// `heartbeat_fields` renders exactly one unquoted numeric field (OBS-4).
///
/// Kills: an impl that quotes the version (breaks numeric comparison in the
/// mismatch panel) or that adds a synthesized id alongside it.
#[test]
fn heartbeat_fields_is_one_unquoted_numeric_field() {
    assert_eq!(heartbeat_fields(19), "\"content_version\":19");
    assert_eq!(heartbeat_fields(0), "\"content_version\":0");
}

/// `heartbeat_fields` composes into the full envelope without a dangling comma.
#[test]
fn heartbeat_fields_composes_into_the_envelope() {
    assert_eq!(
        build_log_line("heartbeat", &heartbeat_fields(0), Breadcrumb::default()),
        "{\"evt\":\"heartbeat\",\"content_version\":0}"
    );
}

/// Interval pin (60s): four Prometheus scrapes per beat at D2's 15s interval, so
/// a dead-man alert has resolution; a hot interval would put a write-free
/// reducer on the scheduler every tick.
///
/// Kills: a "temporary" debugging value left behind (`from_secs(1)`).
#[test]
fn heartbeat_interval_is_sixty_seconds() {
    assert_eq!(
        super::MR_HEARTBEAT_INTERVAL,
        Duration::from_secs(60),
        "MR_HEARTBEAT_INTERVAL must stay 60s (ADR-0180 D2: >= 4 scrapes per beat)"
    );
}

// ---------------------------------------------------------------------------
// AM6 — reserved-key enforcement on the raw `extra_fields_json` fragment.
//
// The fragment is pre-rendered and trusted (same posture as every existing
// hand-rolled site), so a caller could smuggle a SECOND `"evt"` / `"cause"` /
// `"sched"` / `"phase"` key into the line. Loki's JSON parser is last-key-wins:
// the smuggled value would silently override the structural one, forging both
// the event type and a trace-pair breadcrumb. A `debug_assert!` makes that a
// developer-time panic. These are `#[cfg(debug_assertions)]` because the assert
// compiles out of the release wasm.
//
// `mr_log_breadcrumb` has no other panic path (it builds a String and hands it
// to the log facade), so a bare `#[should_panic]` cannot pass for a wrong reason.
// ---------------------------------------------------------------------------

#[test]
#[cfg(debug_assertions)]
#[should_panic]
fn extra_fragment_may_not_smuggle_evt() {
    mr_log_breadcrumb("x", "\"evt\":\"y\"", Breadcrumb::default());
}

#[test]
#[cfg(debug_assertions)]
#[should_panic]
fn extra_fragment_may_not_smuggle_cause() {
    mr_log_breadcrumb("x", "\"cause\":\"forged\"", Breadcrumb::default());
}

#[test]
#[cfg(debug_assertions)]
#[should_panic]
fn extra_fragment_may_not_smuggle_sched() {
    mr_log_breadcrumb("x", "\"sched\":{}", Breadcrumb::default());
}

#[test]
#[cfg(debug_assertions)]
#[should_panic]
fn extra_fragment_may_not_smuggle_phase() {
    mr_log_breadcrumb("x", "\"phase\":\"exit\"", Breadcrumb::default());
}

/// A legitimate fragment must NOT trip the guard — otherwise the assert above
/// could be satisfied by an unconditional `debug_assert!(false)`.
#[test]
fn legitimate_extra_fragment_does_not_panic() {
    mr_log("heartbeat", &heartbeat_fields(19));
    mr_log_breadcrumb(
        "warp",
        "\"zone_id\":7",
        Breadcrumb {
            cause: Some("zone_7"),
            ..Breadcrumb::default()
        },
    );
}

// ===========================================================================
// G7 — Rust-side source scanner. Independent implementation of the SAME rule.
// ===========================================================================

/// Per-level bare-`log::` invocation counts for one file.
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
struct Counts {
    info: u32,
    warn: u32,
    error: u32,
    logbang: u32,
}

impl Counts {
    fn total(self) -> u32 {
        self.info + self.warn + self.error + self.logbang
    }
}

/// The two blessed emission points (ADR-0180 D6). They carry pinned baseline
/// rows — so a NEW bare call inside them still fails — but are excluded from
/// the grandfathered total.
const BLESSED: [&str; 2] = ["guards.rs", "observability.rs"];

/// The 10 grandfathered domain files sum to exactly this, as of m20a landing.
const GRANDFATHERED_TOTAL: u32 = 53;

/// Blank every line whose trimmed form opens a line comment. The ONLY stripping.
fn scrub_comment_lines(src: &str) -> String {
    let opener = concat!("/", "/");
    let mut out = String::with_capacity(src.len());
    for (i, line) in src.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        if !line.trim_start().starts_with(opener) {
            out.push_str(line);
        }
    }
    out
}

/// Any run of whitespace and/or complete block comments, then one of the three
/// Rust macro delimiters.
///
/// The block-comment skip closes a compiled proof-of-concept: `log::warn!` then
/// a block comment then `("x")` is a real emission that a whitespace-only walk
/// scores as zero. Byte-identical to `delimiterFollows` in
/// `evals/observability-log-wrapper.eval.mjs` — the two scanners must agree.
/// The markers are assembled from single characters so this file never spells
/// either one contiguously (see the module header's hygiene note).
fn delimiter_follows(text: &str, idx: usize) -> bool {
    let open = concat!("/", "*");
    let close = concat!("*", "/");
    let ws = |c: char| c == ' ' || c == '\t' || c == '\n' || c == '\r';
    let mut rest = &text[idx..];
    loop {
        let trimmed = rest.trim_start_matches(ws);
        if let Some(after) = trimmed.strip_prefix(open) {
            match after.find(close) {
                Some(end) => {
                    rest = &after[end + close.len()..];
                }
                // An unterminated block comment is never an invocation.
                None => return false,
            }
            continue;
        }
        return matches!(trimmed.chars().next(), Some('(') | Some('{') | Some('['));
    }
}

/// Every needle is `concat!`-assembled so this file never spells one contiguously.
fn needles() -> [(&'static str, usize); 4] {
    [
        (concat!("log", "::info!"), 0),
        (concat!("log", "::warn!"), 1),
        (concat!("log", "::error!"), 2),
        (concat!("log", "::log!"), 3),
    ]
}

fn count_needles(src: &str) -> Counts {
    let text = scrub_comment_lines(src);
    let mut c = Counts::default();
    for (needle, slot) in needles() {
        for (at, _) in text.match_indices(needle) {
            if !delimiter_follows(&text, at + needle.len()) {
                continue;
            }
            match slot {
                0 => c.info += 1,
                1 => c.warn += 1,
                2 => c.error += 1,
                _ => c.logbang += 1,
            }
        }
    }
    c
}

/// `use log` / `use ::log` / `extern crate log` as TOKENS — the character after
/// `log` must be a colon, a space, a semicolon or end of input, so
/// `use log_helper` is clean and `use crate::log` (a legitimate module path)
/// does not hit either. The leading-double-colon form is included because
/// `use ::log::info as i;` is idiomatic, rustfmt-silent, and was not matched by
/// the plain `use log` needle.
///
/// Plus the outright ban on `rustfmt::skip`: the spaced macro path
/// `log :: warn ! (...)` defeats every needle above, and plain `cargo fmt
/// --check` normalizes it back to the canonical spelling — but ONLY for code
/// rustfmt is allowed to touch. Banning the attribute keeps fmt as the
/// normalizer. Byte-identical to `flatBanHits` in the eval.
fn flat_ban_hits(src: &str) -> Vec<&'static str> {
    let text = scrub_comment_lines(src);
    let mut hits = Vec::new();
    for marker in [
        concat!("use", " log"),
        concat!("use", " ::log"),
        concat!("extern crate", " log"),
    ] {
        for (at, _) in text.match_indices(marker) {
            let next = text[at + marker.len()..].chars().next();
            if matches!(next, None | Some(':') | Some(' ') | Some(';')) {
                hits.push(marker);
            }
        }
    }
    let skip = concat!("rustfmt", "::skip");
    if text.contains(skip) {
        hits.push(skip);
    }
    hits
}

fn src_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Recursive walk (AM4) — `.rs` only, `_tests.rs` excluded. Keys are paths
/// relative to `server-module/src`, forward-slash separated.
fn collect_src(dir: &Path, prefix: &str, out: &mut BTreeMap<String, String>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("G7: cannot read {}: {e}", dir.display()))
        .map(|e| e.expect("G7: unreadable dir entry").path())
        .collect();
    entries.sort();
    for path in entries {
        let name = path
            .file_name()
            .expect("G7: entry with no file name")
            .to_string_lossy()
            .to_string();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            collect_src(&path, &rel, out);
        } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") {
            let text = fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("G7: cannot read {}: {e}", path.display()));
            out.insert(rel, text);
        }
    }
}

fn scan_tree() -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    collect_src(&src_root(), "", &mut map);
    assert!(
        map.len() >= 10,
        "G7: only {} non-test .rs files found under server-module/src — the walk is broken \
         (a scanner that sees nothing passes everything)",
        map.len()
    );
    map
}

fn baseline_path() -> PathBuf {
    src_root().join(".log-baseline")
}

/// Parse the committed baseline into `(rows, declared_total)`.
fn parse_baseline(text: &str) -> (BTreeMap<String, Counts>, u32) {
    let mut rows: BTreeMap<String, Counts> = BTreeMap::new();
    let mut declared: Option<u32> = None;
    let total_marker = concat!("#", " total ");
    for (i, raw) in text.split('\n').enumerate() {
        if raw.trim().is_empty() {
            continue;
        }
        if raw.starts_with('#') {
            if let Some(rest) = raw.strip_prefix(total_marker) {
                assert!(
                    declared.is_none(),
                    "G7: .log-baseline line {} declares a second total header",
                    i + 1
                );
                declared = Some(rest.trim().parse::<u32>().unwrap_or_else(|e| {
                    panic!("G7: .log-baseline line {}: bad total ({e})", i + 1)
                }));
            }
            continue;
        }
        let cols: Vec<&str> = raw.split('\t').collect();
        assert_eq!(
            cols.len(),
            5,
            "G7: .log-baseline line {} has {} tab-separated columns, expected 5",
            i + 1,
            cols.len()
        );
        let num = |k: usize| -> u32 {
            cols[k]
                .trim()
                .parse::<u32>()
                .unwrap_or_else(|e| panic!("G7: .log-baseline line {}: bad count ({e})", i + 1))
        };
        let prev = rows.insert(
            cols[0].to_string(),
            Counts {
                info: num(1),
                warn: num(2),
                error: num(3),
                logbang: num(4),
            },
        );
        assert!(
            prev.is_none(),
            "G7: .log-baseline line {} duplicates the row for {}",
            i + 1,
            cols[0]
        );
    }
    let declared = declared
        .expect("G7: .log-baseline carries no total header line (the anti-hand-edit self-check)");
    (rows, declared)
}

fn read_baseline() -> (BTreeMap<String, Counts>, u32) {
    let path = baseline_path();
    let text = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "G7: cannot read {} ({e}). Generate it with \
             `node evals/observability-log-wrapper.eval.mjs --write` (OBS-2 ratchet).",
            path.display()
        )
    });
    parse_baseline(&text)
}

fn grandfathered_total(rows: &BTreeMap<String, Counts>) -> u32 {
    rows.iter()
        .filter(|(f, _)| !BLESSED.contains(&f.as_str()))
        .map(|(_, c)| c.total())
        .sum()
}

/// **G7 core** — the committed baseline must equal an independent recount of the
/// tree, exactly, in both directions.
///
/// Kills: a NEW bare `log::` call in any file (including a new file or a
/// subdirectory), a same-file level swap, a silent DECREASE absorbed without
/// regenerating, and a baseline row whose file has been deleted.
#[test]
fn g7_log_baseline_matches_an_independent_recount() {
    let tree = scan_tree();
    let (rows, _) = read_baseline();

    for file in rows.keys() {
        assert!(
            tree.contains_key(file),
            "G7: .log-baseline lists `{file}`, but no such non-test .rs file exists under \
             server-module/src — regenerate the baseline"
        );
    }

    let mut drift: Vec<String> = Vec::new();
    for (file, src) in &tree {
        let got = count_needles(src);
        let want = rows.get(file).copied().unwrap_or_default();
        if got != want {
            drift.push(format!("{file}: baseline {want:?}, scanned {got:?}"));
        }
    }
    assert!(
        drift.is_empty(),
        "G7 (OBS-2 ratchet): .log-baseline drift in {} file(s): {}. A HIGHER count is a NEW \
         bare log:: call site — route it through observability::mr_log (ADR-0180 D6). A LOWER \
         count means ratchet forward: regenerate with \
         `node evals/observability-log-wrapper.eval.mjs --write` and explain the delta in the PR.",
        drift.len(),
        drift.join(" | ")
    );
}

/// The committed total must be honest AND must still be the m20a landing figure.
///
/// Kills baseline laundering: regenerating `--write` to absorb a newly added
/// bare call would move this number, and moving it here is a reviewed edit to a
/// gating test the implementer may not make.
#[test]
fn g7_grandfathered_total_is_53() {
    let tree = scan_tree();
    let (rows, declared) = read_baseline();

    let recomputed = grandfathered_total(&rows);
    assert_eq!(
        declared, recomputed,
        "G7: .log-baseline's total header ({declared}) contradicts its own rows ({recomputed}) \
         over the grandfathered files — the header was hand-edited"
    );

    let mut scanned_total = 0u32;
    for (file, src) in &tree {
        if BLESSED.contains(&file.as_str()) {
            continue;
        }
        scanned_total += count_needles(src).total();
    }
    assert_eq!(
        scanned_total, GRANDFATHERED_TOTAL,
        "G7: the tree now has {scanned_total} grandfathered bare log:: call sites; m20a landed \
         with exactly {GRANDFATHERED_TOTAL} across 10 domain files. Migrating those 53 to mr_log \
         is a NAMED FOLLOW-UP slice — if that is what happened, this pin moves in that slice's \
         reviewed diff, not in a retrofit."
    );
    assert_eq!(
        declared, GRANDFATHERED_TOTAL,
        "G7: the committed baseline total is {declared}, expected {GRANDFATHERED_TOTAL}"
    );
}

/// The blessed emission points carry their own pinned rows (AM3), so a second
/// bare call inside `guards.rs` or `observability.rs` is caught even though they
/// are exempt from the grandfathered total.
#[test]
fn g7_blessed_files_are_pinned_not_exempt() {
    let (rows, _) = read_baseline();
    let guards = rows
        .get("guards.rs")
        .copied()
        .expect("G7: guards.rs must have its own .log-baseline row (AM3)");
    assert_eq!(
        guards,
        Counts {
            info: 0,
            warn: 1,
            error: 0,
            logbang: 0
        },
        "G7: guards.rs must pin exactly one warn site (log_reject, the D6 SSOT)"
    );
    let obs = rows
        .get("observability.rs")
        .copied()
        .expect("G7: observability.rs must have its own .log-baseline row (AM3)");
    assert_eq!(
        obs,
        Counts {
            info: 1,
            warn: 0,
            error: 0,
            logbang: 0
        },
        "G7: observability.rs must pin exactly one info site — mr_log_breadcrumb's single \
         emission point. More than one means a second, unrouted logging path exists."
    );
}

/// AM2 flat ban: an aliased or glob import of the `log` crate launders every
/// needle the ratchet counts (`use log::warn as w;` then `w!(...)`).
#[test]
fn g7_no_log_crate_import_in_any_non_test_file() {
    let mut offenders: Vec<String> = Vec::new();
    for (file, src) in &scan_tree() {
        let hits = flat_ban_hits(src);
        if !hits.is_empty() {
            offenders.push(format!("{file} ({})", hits.join(", ")));
        }
    }
    assert!(
        offenders.is_empty(),
        "G7 (AM2 flat ban): {} — importing the log crate by name or alias defeats the OBS-2 \
         ratchet entirely. Emit through observability::mr_log.",
        offenders.join("; ")
    );
}

// ---------------------------------------------------------------------------
// Structural assertions over `observability.rs` itself.
// ---------------------------------------------------------------------------

fn observability_source() -> String {
    let path = src_root().join("observability.rs");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("G7: cannot read {} ({e})", path.display()))
}

/// Body of `fn <name>` by brace counting over the comment-scrubbed source.
/// Returns `None` when the braces never balance — fail-loud, never a silent
/// empty body that would make every "contains no mutator" assertion vacuous.
fn fn_body(src: &str, fn_name: &str) -> Option<String> {
    let text = scrub_comment_lines(src);
    let marker = format!("fn {fn_name}");
    let at = text.find(&marker)?;
    let open = at + text[at..].find('{')?;
    let mut depth = 0usize;
    for (i, ch) in text[open..].char_indices() {
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(text[open + 1..open + i].to_string());
            }
        }
    }
    None
}

fn mutator_needles() -> [&'static str; 3] {
    [
        concat!(".", "insert("),
        concat!(".", "update("),
        concat!(".", "delete("),
    ]
}

/// The scheduler-only preamble every scheduled reducer in this repo carries.
/// `concat!`-assembled, like every other needle here, so this test file never
/// spells it contiguously and can never satisfy a crate-wide scan with its own
/// text — including the fixtures below, which are all built FROM this constant.
const GUARD_NEEDLE: &str = concat!("ctx.sender() != ", "ctx.database_identity()");

/// Predicate half of [`g7_mr_heartbeat_guard_is_pinned_first`], separated so the
/// teeth can drive it with fixtures through exactly the `fn_body` path the real
/// scan uses (comment stripping included).
///
/// `Ok(())` iff the guard is present AND precedes both the Config read and the
/// emission AND no statement runs ahead of it.
fn guard_is_pinned_first(body: &str) -> Result<(), String> {
    let config_read = concat!("config", "()");
    let emission = concat!("mr_log", "(");

    let Some(guard_at) = body.find(GUARD_NEEDLE) else {
        return Err(format!(
            "the body contains no `{GUARD_NEEDLE}` guard (a commented-out one does not count \
             — comment lines are stripped before this scan)"
        ));
    };

    // Required, not optional: without an emission to order against, every
    // comparison below would be vacuously satisfied.
    let Some(emit_at) = body.find(emission) else {
        return Err(
            "the body makes no mr_log emission, so the guard-ordering check would be vacuous"
                .to_string(),
        );
    };
    if guard_at > emit_at {
        return Err(format!(
            "the guard is at byte {guard_at}, AFTER the emission at byte {emit_at} — the forged \
             heartbeat line is already on the wire by the time the caller is rejected"
        ));
    }

    // Compared only when present: a future refactor may move the read into a
    // helper, and that is not this test's business.
    if let Some(config_at) = body.find(config_read) {
        if guard_at > config_at {
            return Err(format!(
                "the guard is at byte {guard_at}, AFTER the Config read at byte {config_at} — an \
                 unauthenticated caller reaches the database before being rejected"
            ));
        }
    }

    if body[..guard_at].contains(';') {
        return Err(format!(
            "a statement runs BEFORE the guard at byte {guard_at} (a `;` precedes it) — the \
             guard must be the FIRST statement in the body, per the playtest_reaper precedent"
        ));
    }
    Ok(())
}

/// OBS-1: the heartbeat emits exactly one line and writes NO row.
///
/// Scoped to the reducer body, which is what OBS-1 actually constrains — the
/// schedule arm (`ensure_mr_heartbeat`) must of course insert its singleton row.
/// The companion test below closes the "hide the write in a helper" bypass.
#[test]
fn g7_mr_heartbeat_emits_once_and_mutates_nothing() {
    let src = observability_source();
    let body = fn_body(&src, "mr_heartbeat")
        .expect("G7: could not extract mr_heartbeat's body (unbalanced braces?)");
    assert!(
        !body.trim().is_empty(),
        "G7: mr_heartbeat's extracted body is empty — the scan would be vacuous"
    );

    let plain = body.matches(concat!("mr_log", "(")).count();
    let with_bc = body.matches(concat!("mr_log_", "breadcrumb(")).count();
    let emissions = plain + with_bc;
    assert_eq!(
        emissions, 1,
        "G7 (OBS-1): mr_heartbeat's body makes {emissions} mr_log emission call(s); exactly one \
         is required"
    );

    for needle in mutator_needles() {
        assert_eq!(
            body.matches(needle).count(),
            0,
            "G7 (OBS-1): mr_heartbeat's body calls `{needle}` — the heartbeat must never insert, \
             update or delete a row"
        );
    }
}

/// **G7 / reducer-security parity** — `mr_heartbeat`'s scheduler-only guard is
/// present, and is the FIRST statement in the body.
///
/// Every other scheduled reducer in this repo already has a structural gate
/// pinning this preamble — `playtest_tests.rs:738-780`,
/// `pvp-challenge-reaper.eval.mjs:130-142`,
/// `trade-reducer-security.eval.mjs:412`, `accounts_tests.rs:1420-1427`.
/// `mr_heartbeat` had none: deleting its sender/identity comparison today left
/// every gate in the repo green. (The guard text is spelled ONCE in this file,
/// `concat!`-assembled as `GUARD_NEEDLE`, per the module header's hygiene rule.)
///
/// WHY IT MATTERS MORE HERE THAN ELSEWHERE. An unguarded `mr_heartbeat` is
/// callable BY NAME by any client, and its whole output is the `evt:"heartbeat"`
/// line the dead-man's-switch alert keys on (m20b). A client that can forge
/// beats can keep the alert quiet while the module is actually dead — it
/// defeats precisely the one failure this reducer exists to surface. (This is
/// also why AM16 tells m20b to alert on the log-derived S2 counter rather than
/// `mr_heartbeat`'s `committed="false"` rate: the log line is guard-gated, the
/// call rate is not.)
///
/// FIRST, not merely present: a guard that runs after the Config read has
/// already let an unauthenticated caller touch the database, and one that runs
/// after the emission has already put the forged line on the wire.
#[test]
fn g7_mr_heartbeat_guard_is_pinned_first() {
    let src = observability_source();
    let body = fn_body(&src, "mr_heartbeat").expect("G7: could not extract mr_heartbeat's body");
    if let Err(reason) = guard_is_pinned_first(&body) {
        panic!(
            "G7 (scheduler-only guard, OBS-1 / ADR-0180 D6): {reason}. Restore the \
             `playtest_reaper` preamble as the first statement of mr_heartbeat:\n    \
             if <sender/identity mismatch> {{ return Err(\"mr_heartbeat is \
             scheduler-only\".to_string()); }}"
        );
    }
}

/// The schedule arm is the ONLY writer in `observability.rs`, so no helper
/// reachable from the heartbeat can smuggle a write past the body scan above.
#[test]
fn g7_only_the_schedule_arm_writes_in_observability_rs() {
    let src = observability_source();
    let scrubbed = scrub_comment_lines(&src);
    let arm = fn_body(&src, "ensure_mr_heartbeat")
        .expect("G7: could not extract ensure_mr_heartbeat's body");
    for needle in mutator_needles() {
        let in_file = scrubbed.matches(needle).count();
        let in_arm = arm.matches(needle).count();
        assert_eq!(
            in_file, in_arm,
            "G7 (OBS-1): observability.rs has {in_file} `{needle}` call(s) but only {in_arm} \
             inside ensure_mr_heartbeat — the idempotent schedule arm is the only place this \
             module may write"
        );
    }
}

/// ADR-0179 D6: no `macro_rules!` in this module (the hand-rolled envelope is
/// the SSOT; a macro hides the emission point from every source scanner).
#[test]
fn g7_observability_rs_declares_no_macro() {
    let src = scrub_comment_lines(&observability_source());
    assert_eq!(
        src.matches(concat!("macro_", "rules!")).count(),
        0,
        "G7: observability.rs declares a macro — ADR-0179 D6 forbids one here"
    );
}

/// OBS-49: exactly ONE new table, and it is the heartbeat schedule.
#[test]
fn g7_observability_rs_declares_exactly_one_scheduled_table() {
    let src = scrub_comment_lines(&observability_source());
    let attr = concat!("#[spacetimedb::", "table(");
    assert_eq!(
        src.matches(attr).count(),
        1,
        "G7 (OBS-49): observability.rs must declare exactly one table — no new table for \
         server-side trace reconstruction"
    );
    let at = src.find(attr).expect("G7: table attribute vanished");
    let end = src[at..]
        .find(concat!(")", "]"))
        .expect("G7: unterminated table attribute");
    let decl = &src[at..at + end + 2];
    assert!(
        decl.contains(concat!("scheduled(", "mr_heartbeat)")),
        "G7 (OBS-3/OBS-49): the table attribute must be `scheduled(mr_heartbeat)`, got: {decl}"
    );
}

/// OBS-4: correlation is `(function, ts)` plus `content_version` — never a
/// synthesized id, never an RNG draw.
#[test]
fn g7_observability_rs_has_no_synthesized_correlation_id() {
    let src = scrub_comment_lines(&observability_source());
    assert!(
        src.contains(concat!("content_", "version")),
        "G7 (OBS-4): observability.rs never mentions content_version"
    );
    for banned in [
        concat!("correlation_", "id"),
        concat!("trace_", "id"),
        concat!("ctx.", "rng()"),
    ] {
        assert_eq!(
            src.matches(banned).count(),
            0,
            "G7 (OBS-3/OBS-4): observability.rs contains `{banned}` — connection_id is the sole \
             correlation key, and scheduled lines correlate by (function, ts) + content_version"
        );
    }
}

/// AM7: `$trace_pair_set` is EMPTY through m20a. m20e's G9 asserts set-equality
/// between these call-site literals and the relay's committed config and
/// SUPERSEDES this assertion; until then any pair literal breaks G9 against an
/// empty config.
#[test]
fn g7_trace_pair_set_stays_empty() {
    let enter = concat!("Some(\"", "enter\")");
    let exit = concat!("Some(\"", "exit\")");
    let mut offenders: Vec<String> = Vec::new();
    for (file, src) in &scan_tree() {
        if src.contains(enter) || src.contains(exit) {
            offenders.push(file.clone());
        }
    }
    assert!(
        offenders.is_empty(),
        "G7 (AM7/OBS-50): {} contain(s) an enter/exit phase literal — $trace_pair_set must stay \
         EMPTY through m20a; breadcrumb pairing lands with m20e's G9",
        offenders.join(", ")
    );
}

// ---------------------------------------------------------------------------
// Teeth for THIS scanner. Every fixture is `concat!`-assembled from harmless
// fragments, never a raw string literal holding a needle, so the fixtures cannot
// pollute this file's own (or any crate-wide) scan.
// ---------------------------------------------------------------------------

/// Doc-comment prose that MENTIONS a macro is not a call site. This is the exact
/// "56 vs 53" miscount ADR-0180 corrected twice.
#[test]
fn scanner_teeth_doc_comment_mentions_are_not_call_sites() {
    let fixture = [
        concat!(
            "/",
            "/",
            "/ at most one `log",
            "::warn!` per 60_000 ms of injected clock"
        ),
        concat!(
            "/",
            "/",
            "! module doc: never call log",
            "::error!(e) directly; use mr_log"
        ),
        concat!("    /", "/ log", "::info!(x); // parked during debugging"),
        "fn real() {}",
    ]
    .join("\n");
    assert_eq!(
        count_needles(&fixture),
        Counts::default(),
        "TEETH: doc-comment mentions were counted as invocations"
    );
}

/// A real invocation IS counted — otherwise the tooth above would pass for a
/// scanner that counts nothing at all.
#[test]
fn scanner_teeth_real_invocation_is_counted() {
    let fixture = concat!("fn f() { log", "::info!(x); }");
    assert_eq!(
        count_needles(fixture).info,
        1,
        "TEETH: a real call site was missed"
    );
}

/// AM2 / red-team 1.1: `log::log!(Level::Warn, ...)` emits at warn level without
/// ever spelling `log::warn!`.
#[test]
fn scanner_teeth_log_bang_is_counted() {
    let fixture = concat!("fn f() { log", "::log!(Level::Warn, e); }");
    let c = count_needles(fixture);
    assert_eq!(c.logbang, 1, "TEETH: the generic log macro was not counted");
    assert_eq!(
        c.warn, 0,
        "TEETH: the generic log macro leaked into the warn bucket"
    );
}

/// AM2 / red-team 1.2: Rust macros accept brace and bracket delimiters, so a
/// paren-only anchor is trivially dodged.
#[test]
fn scanner_teeth_brace_and_bracket_delimiters_are_counted() {
    let braced = concat!("fn f() { log", "::warn!{ e } }");
    assert_eq!(
        count_needles(braced).warn,
        1,
        "TEETH: brace-delimited call missed"
    );
    let bracketed = concat!("fn f() { log", "::error![ e ]; }");
    assert_eq!(
        count_needles(bracketed).error,
        1,
        "TEETH: bracket-delimited call missed"
    );
}

/// rustfmt may wrap a long call so the delimiter lands on the next line.
#[test]
fn scanner_teeth_whitespace_split_invocation_is_counted() {
    let fixture = concat!("fn f() {\n    log", "::warn!\n(\n        e,\n    );\n}");
    assert_eq!(
        count_needles(fixture).warn,
        1,
        "TEETH: a line-wrapped invocation dodged the needle"
    );
}

/// AM2 / red-team 1.3 + HIGH-4: alias imports in every spelling, and the
/// negative controls that keep the ban from firing on an unrelated identifier
/// or on the legitimate `crate::log` module path.
#[test]
fn scanner_teeth_flat_ban_catches_aliases_only() {
    for bad in [
        concat!("use", " log::warn as w;"),
        concat!("use", " log as l;"),
        concat!("use", " log;"),
        concat!("use", " ::log::info as i;"),
        concat!("pub use", " ::log;"),
        concat!("extern crate", " log;"),
    ] {
        assert_eq!(
            flat_ban_hits(bad).len(),
            1,
            "TEETH (HIGH-4): the flat ban missed a log-crate import: {bad}"
        );
    }
    for good in [
        concat!("use", " log_helper::thing;"),
        concat!("use", " logging::other;"),
        concat!("use", " crate::log::helper;"),
        concat!("use", " ::logging::other;"),
        concat!("/", "/ ", "use", " log::warn as w;"),
    ] {
        assert!(
            flat_ban_hits(good).is_empty(),
            "TEETH: the flat ban false-positived on a harmless line: {good}"
        );
    }
}

/// HIGH-3(a) — `#[rustfmt::skip]` is banned outright in non-test files.
///
/// The attack it closes: the spaced macro path `log :: warn ! (...)` compiles,
/// emits, and matches NO needle in either scanner. Plain `cargo fmt --check`
/// rewrites it back to the canonical spelling, so it can only survive review
/// under a skip attribute. Banning the attribute restores fmt as the normalizer.
/// The residual (the spaced path itself is uncounted) is pinned below so a
/// future reader knows it is known, not missed.
#[test]
fn scanner_teeth_rustfmt_skip_is_flat_banned() {
    let attr = concat!("#[rustfmt", "::skip]");
    let spaced = concat!("fn f() { log :: warn ", "! (e); }");
    let src = [attr, spaced].join("\n");
    assert!(
        !flat_ban_hits(&src).is_empty(),
        "TEETH (HIGH-3): a rustfmt-skip attribute was not flagged by the flat ban"
    );
    assert_eq!(
        count_needles(spaced),
        Counts::default(),
        "TEETH: the spaced macro path is now COUNTED — the documented residual has changed, \
         update both scanners' header notes"
    );
    assert!(
        flat_ban_hits("fn f() { let x = 1; }").is_empty(),
        "TEETH: the rustfmt-skip ban false-positived on ordinary code"
    );
}

/// HIGH-3(b) — a block comment spliced between the `!` and its delimiter.
#[test]
fn scanner_teeth_comment_spliced_invocation_is_counted() {
    let open = concat!("/", "*");
    let close = concat!("*", "/");
    let spliced = [
        concat!("fn f() { log", "::warn!"),
        open,
        " c ",
        close,
        "(e); }",
    ]
    .concat();
    assert_eq!(
        count_needles(&spliced).warn,
        1,
        "TEETH (HIGH-3): a comment-spliced invocation dodged the needle"
    );

    let multi = [
        concat!("fn f() { log", "::error!"),
        " ",
        open,
        "a",
        close,
        "\n  ",
        open,
        "b",
        close,
        "(e); }",
    ]
    .concat();
    assert_eq!(
        count_needles(&multi).error,
        1,
        "TEETH: multiple spliced comments plus a line break dodged the needle"
    );

    let unterminated = [
        concat!("fn f() { log", "::info! "),
        open,
        " never closed (e); }",
    ]
    .concat();
    assert_eq!(
        count_needles(&unterminated),
        Counts::default(),
        "TEETH: an unterminated block comment was scored as an invocation"
    );
}

/// The body extractor must stop at the function's own closing brace, and must
/// report failure (not an empty body) when the braces do not balance.
#[test]
fn scanner_teeth_fn_body_is_scoped_and_fails_loud() {
    let src = [
        "pub fn mr_heartbeat(ctx: &C, _s: S) -> Result<(), String> {",
        "    mr_log(a, b);",
        "    Ok(())",
        "}",
        "pub(crate) fn ensure_mr_heartbeat(ctx: &C) {",
        concat!("    ctx.db.mr_heartbeat_schedule().", "insert(row);"),
        "}",
    ]
    .join("\n");
    let body = fn_body(&src, "mr_heartbeat").expect("TEETH: well-formed body must extract");
    assert!(
        !body.contains(concat!(".", "insert(")),
        "TEETH: the body scan leaked into ensure_mr_heartbeat"
    );
    assert_eq!(
        body.matches(concat!("mr_log", "(")).count(),
        1,
        "TEETH: the body scan lost the emission call"
    );
    let arm = fn_body(&src, "ensure_mr_heartbeat").expect("TEETH: arm body must extract");
    assert!(
        arm.contains(concat!(".", "insert(")),
        "TEETH: the arm body lost its insert"
    );
    assert!(
        fn_body(
            "pub fn mr_heartbeat() {\n    mr_log(a, b);\n",
            "mr_heartbeat"
        )
        .is_none(),
        "TEETH: unbalanced braces returned a body instead of failing loud"
    );
}

/// Wrap body lines in a `mr_heartbeat` signature so the fixture goes through the
/// real `fn_body` extractor (comment stripping and all).
fn heartbeat_fixture(lines: &[&str]) -> String {
    let mut all: Vec<&str> = vec!["pub fn mr_heartbeat(ctx: &C, _s: S) -> Result<(), String> {"];
    all.extend_from_slice(lines);
    all.push("    Ok(())");
    all.push("}");
    all.join("\n")
}

fn guard_check(src: &str) -> Result<(), String> {
    let body = fn_body(src, "mr_heartbeat").expect("TEETH: fixture body must extract");
    guard_is_pinned_first(&body)
}

/// Teeth for [`guard_is_pinned_first`] — six ways a deleted, disabled or
/// demoted scheduler-only guard must bite, plus the positive control.
///
/// Every fixture is assembled FROM `GUARD_NEEDLE`, so this file still never
/// spells the guard contiguously.
#[test]
fn scanner_teeth_guard_pin_bites() {
    let guarded = ["    if ", GUARD_NEEDLE, " { return Err(e); }"].concat();
    let commented = ["    // if ", GUARD_NEEDLE, " { return Err(e); }"].concat();
    let config_line = ["    let cv = ctx.db.config", "().id().find(0);"].concat();
    let emit_line = "    mr_log(a, b);";

    // GOOD: guard, then the Config read, then the emission.
    let good = heartbeat_fixture(&[guarded.as_str(), config_line.as_str(), emit_line]);
    assert!(
        guard_check(&good).is_ok(),
        "TEETH: the canonical guarded body was rejected: {:?}",
        guard_check(&good)
    );

    // BAD 1 — the audit's exact scenario: the guard is simply deleted.
    let missing = heartbeat_fixture(&[config_line.as_str(), emit_line]);
    assert!(
        guard_check(&missing).is_err(),
        "TEETH: a body with NO scheduler-only guard passed — any client could forge heartbeats"
    );

    // BAD 2 — the guard commented out. `fn_body` strips comment lines, so the
    // needle must vanish; a scan over raw source would call this green.
    let disabled = heartbeat_fixture(&[commented.as_str(), config_line.as_str(), emit_line]);
    assert!(
        guard_check(&disabled).is_err(),
        "TEETH: a COMMENTED-OUT guard passed — the comment scrub is not being applied"
    );

    // BAD 3 — guard present but after the emission: the line is already out.
    let late = heartbeat_fixture(&[config_line.as_str(), emit_line, guarded.as_str()]);
    assert!(
        guard_check(&late).is_err(),
        "TEETH: a guard placed AFTER the emission passed"
    );

    // BAD 4 — guard present but after the Config read.
    let after_read = heartbeat_fixture(&[config_line.as_str(), guarded.as_str(), emit_line]);
    assert!(
        guard_check(&after_read).is_err(),
        "TEETH: a guard placed AFTER the Config read passed"
    );

    // BAD 5 — a statement runs before the guard, so it is no longer first.
    let preceded = heartbeat_fixture(&[
        "    let _ = ctx.db.player().count();",
        guarded.as_str(),
        config_line.as_str(),
        emit_line,
    ]);
    assert!(
        guard_check(&preceded).is_err(),
        "TEETH: a statement running BEFORE the guard passed"
    );

    // BAD 6 — non-vacuity: with no emission to order against, the check must
    // refuse rather than silently pass every comparison.
    let no_emit = heartbeat_fixture(&[guarded.as_str(), config_line.as_str()]);
    assert!(
        guard_check(&no_emit).is_err(),
        "TEETH: a body with no mr_log emission passed vacuously"
    );
}

/// The baseline parser must reject a malformed row rather than skipping it —
/// a skipped row is a silently unpinned file.
#[test]
#[should_panic]
fn scanner_teeth_baseline_parser_rejects_a_short_row() {
    let text = [concat!("#", " total 1"), "battle.rs\t1\t0"].join("\n");
    let _ = parse_baseline(&text);
}

/// The parser must round-trip a well-formed baseline.
#[test]
fn scanner_teeth_baseline_parser_reads_a_good_file() {
    let text = [
        concat!("#", " generated header"),
        concat!("#", " total 3"),
        "battle.rs\t1\t0\t1\t0",
        "guards.rs\t0\t1\t0\t0",
        "lib.rs\t1\t0\t0\t0",
    ]
    .join("\n");
    let (rows, declared) = parse_baseline(&text);
    assert_eq!(declared, 3);
    assert_eq!(rows.len(), 3);
    assert_eq!(
        grandfathered_total(&rows),
        3,
        "TEETH: the blessed guards.rs row must not inflate the grandfathered total"
    );
}

// ===========================================================================
// m20e (T5) — the RUST HALF of two cross-toolchain gates. Append-only block;
// nothing above this line changed.
//
// D6 GOLDEN MIRROR. `ops/observability/relay/fixtures/breadcrumb-golden.json`
// is read by BOTH this file and `ops/observability/relay/parse.test.mjs`, and
// the two consumers read DIFFERENT LAYERS of it (AM4). This side asserts only
// `build_log_line(...) == expected_module_json`, byte for byte; it never looks
// at `host_line`, which is the JS side's business. That split is what makes the
// fixture a contract instead of a copy: the envelope cannot drift on either
// side without one of the two suites reddening, and neither suite can be
// "fixed" by editing the other's expectations.
//
// OBS-50 RUST HALF. A SECOND, independent scanner (the file header's "WHY A
// SECOND SCANNER" reasoning applies unchanged) finds the reducers whose own
// function body carries BOTH phase literals, and asserts set equality against
// the relay's committed `$trace_pair_set`. `evals/observability-stack-config.
// eval.mjs` does the same thing in JavaScript with its own walker; a bug in
// one cannot make both green, and the empty-set case is only honest because
// each scanner is separately proven to DETECT a synthetic pair.
//
// JSON is hand-parsed, strictly and fail-loud: `serde_json` is not a dependency
// of this crate and adding one for a test would be a real dependency for a
// test-only need. The parser REJECTS duplicate keys, trailing content and
// non-integer numbers, so the i64 bounds in the fixture cannot round-trip
// through a float.
//
// The file's SOURCE-SCAN HYGIENE rules (header :37-47) bind this block too:
// every needle is `concat!`-assembled, the double quote and the backslash are
// spelled as scalar-value escapes rather than as bare char literals, and no
// slash-asterisk appears anywhere.
// ===========================================================================

/// The double quote, never spelled as a bare char literal (header :41-43).
const DQUOTE: char = '\u{0022}';
/// The backslash, same reason (the `guards::json_escape` precedent).
const BSLASH: char = '\u{005C}';

/// The two call-site phase literals, assembled so this file never spells either
/// contiguously and can never satisfy its own (or the eval's) tree scan.
const PHASE_ENTER: &str = concat!("Some(", "\"enter\")");
const PHASE_EXIT: &str = concat!("Some(", "\"exit\")");
/// The reducer attribute that makes a function body attributable to a NAME.
const REDUCER_ATTR: &str = concat!("#[spacetimedb", "::reducer");

// ---------------------------------------------------------------------------
// A strict, fail-loud JSON reader (no serde_json).
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum Json {
    Null,
    Bool(bool),
    /// The RAW digit text. Never an f64: the fixture pins both i64 bounds, and
    /// a float round-trip would silently move the last digit of each.
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    /// A Vec rather than a map, so a DUPLICATE KEY is detectable instead of
    /// being silently resolved last-key-wins — which is the very forgery the
    /// fixture's own `forged-duplicate-evt` case describes.
    Obj(Vec<(String, Json)>),
}

struct JsonReader {
    chars: Vec<char>,
    at: usize,
}

impl JsonReader {
    fn new(text: &str) -> Self {
        Self {
            chars: text.chars().collect(),
            at: 0,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.at += 1;
        }
        c
    }

    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c == ' ' || c == '\n' || c == '\r' || c == '\t' {
                self.at += 1;
            } else {
                break;
            }
        }
    }

    fn expect(&mut self, want: char) -> Result<(), String> {
        match self.bump() {
            Some(c) if c == want => Ok(()),
            other => Err(format!(
                "char {}: expected {want}, found {other:?}",
                self.at
            )),
        }
    }

    fn literal(&mut self, word: &str, out: Json) -> Result<Json, String> {
        for want in word.chars() {
            match self.bump() {
                Some(c) if c == want => {}
                other => {
                    return Err(format!(
                        "char {}: expected the literal {word}, found {other:?}",
                        self.at
                    ));
                }
            }
        }
        Ok(out)
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect(DQUOTE)?;
        let mut out = String::new();
        loop {
            let c = match self.bump() {
                Some(c) => c,
                None => return Err("unterminated string".to_string()),
            };
            if c == DQUOTE {
                return Ok(out);
            }
            if c == BSLASH {
                let esc = match self.bump() {
                    Some(e) => e,
                    None => return Err("unterminated escape sequence".to_string()),
                };
                match esc {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    'b' => out.push('\u{0008}'),
                    'f' => out.push('\u{000C}'),
                    '/' => out.push('/'),
                    DQUOTE => out.push(DQUOTE),
                    BSLASH => out.push(BSLASH),
                    'u' => {
                        let mut hex = String::new();
                        for _ in 0..4 {
                            match self.bump() {
                                Some(h) => hex.push(h),
                                None => return Err("truncated unicode escape".to_string()),
                            }
                        }
                        let code = u32::from_str_radix(&hex, 16)
                            .map_err(|e| format!("bad unicode escape {hex}: {e}"))?;
                        match char::from_u32(code) {
                            Some(ch) => out.push(ch),
                            None => {
                                return Err(format!("unicode escape {hex} is not a scalar value"));
                            }
                        }
                    }
                    other => return Err(format!("char {}: unknown escape {other}", self.at)),
                }
                continue;
            }
            if (c as u32) < 0x20 {
                return Err(format!(
                    "char {}: raw control character in a string",
                    self.at
                ));
            }
            out.push(c);
        }
    }

    /// Integers only. A fraction or an exponent is a LOUD error rather than a
    /// tolerated widening: this fixture's whole point is byte-exact values.
    fn number(&mut self) -> Result<String, String> {
        let start = self.at;
        if self.peek() == Some('-') {
            self.at += 1;
        }
        let mut digits = 0usize;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.at += 1;
                digits += 1;
            } else {
                break;
            }
        }
        if digits == 0 {
            return Err(format!("char {start}: a number with no digits"));
        }
        match self.peek() {
            Some('.' | 'e' | 'E') => Err(format!(
                "char {start}: a non-integer number. The fixture pins both i64 bounds, so a \
                 float round-trip would move their last digit."
            )),
            _ => Ok(self.chars[start..self.at].iter().collect()),
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.expect('[')?;
        let mut out: Vec<Json> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(']') {
            self.at += 1;
            return Ok(Json::Arr(out));
        }
        loop {
            out.push(self.value()?);
            self.skip_ws();
            match self.bump() {
                Some(',') => continue,
                Some(']') => return Ok(Json::Arr(out)),
                other => {
                    return Err(format!(
                        "char {}: expected a comma or a closing bracket, found {other:?}",
                        self.at
                    ));
                }
            }
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.expect('{')?;
        let mut out: Vec<(String, Json)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some('}') {
            self.at += 1;
            return Ok(Json::Obj(out));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            if out.iter().any(|(k, _)| k == &key) {
                return Err(format!(
                    "char {}: duplicate key {key}. Last-key-wins is exactly the forgery this \
                     fixture exists to describe, so the reader refuses to resolve it.",
                    self.at
                ));
            }
            self.skip_ws();
            self.expect(':')?;
            let value = self.value()?;
            out.push((key, value));
            self.skip_ws();
            match self.bump() {
                Some(',') => continue,
                Some('}') => return Ok(Json::Obj(out)),
                other => {
                    return Err(format!(
                        "char {}: expected a comma or a closing brace, found {other:?}",
                        self.at
                    ));
                }
            }
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.skip_ws();
        match self.peek() {
            Some(DQUOTE) => Ok(Json::Str(self.string()?)),
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some('t') => self.literal("true", Json::Bool(true)),
            Some('f') => self.literal("false", Json::Bool(false)),
            Some('n') => self.literal("null", Json::Null),
            Some(c) if c == '-' || c.is_ascii_digit() => Ok(Json::Num(self.number()?)),
            other => Err(format!("char {}: unexpected {other:?}", self.at)),
        }
    }
}

fn parse_json(text: &str) -> Result<Json, String> {
    let mut reader = JsonReader::new(text);
    let value = reader.value()?;
    reader.skip_ws();
    if reader.at != reader.chars.len() {
        return Err(format!(
            "char {}: trailing content after the top-level value",
            reader.at
        ));
    }
    // DOCUMENT-level strictness, not just value-level. A bare scalar or array is
    // legal JSON but is not a legal document for either file this reader serves
    // (the golden fixture and trace-pair-set.json are both objects). Accepting
    // one would let a truncated or replaced file parse "successfully" and then
    // panic later, in a field lookup, with a message about the missing field
    // rather than about the corrupted document.
    if !matches!(value, Json::Obj(_)) {
        return Err(format!(
            "the top-level value is a bare {value:?}, not a JSON object — both documents this \
             reader parses are objects, so this file is corrupted or was replaced"
        ));
    }
    Ok(value)
}

fn json_obj<'a>(value: &'a Json, what: &str) -> &'a Vec<(String, Json)> {
    match value {
        Json::Obj(fields) => fields,
        other => panic!("m20e: {what} is not a JSON object ({other:?})"),
    }
}

fn json_field<'a>(fields: &'a [(String, Json)], key: &str, what: &str) -> &'a Json {
    fields
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v)
        .unwrap_or_else(|| panic!("m20e: {what} carries no `{key}` field"))
}

fn json_str<'a>(fields: &'a [(String, Json)], key: &str, what: &str) -> &'a str {
    match json_field(fields, key, what) {
        Json::Str(s) => s.as_str(),
        other => panic!("m20e: {what}.{key} is not a string ({other:?})"),
    }
}

fn json_opt_str<'a>(fields: &'a [(String, Json)], key: &str, what: &str) -> Option<&'a str> {
    match json_field(fields, key, what) {
        Json::Null => None,
        Json::Str(s) => Some(s.as_str()),
        other => panic!("m20e: {what}.{key} is neither a string nor null ({other:?})"),
    }
}

fn json_bool(fields: &[(String, Json)], key: &str, what: &str) -> bool {
    match json_field(fields, key, what) {
        Json::Bool(b) => *b,
        other => panic!("m20e: {what}.{key} is not a boolean ({other:?})"),
    }
}

fn json_i64(fields: &[(String, Json)], key: &str, what: &str) -> i64 {
    match json_field(fields, key, what) {
        Json::Num(raw) => raw
            .parse::<i64>()
            .unwrap_or_else(|e| panic!("m20e: {what}.{key} is not an i64 ({e})")),
        other => panic!("m20e: {what}.{key} is not a number ({other:?})"),
    }
}

// ---------------------------------------------------------------------------
// D6 cross-language golden fixture.
// ---------------------------------------------------------------------------

fn relay_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("ops")
        .join("observability")
        .join("relay")
}

fn golden_fixture_path() -> PathBuf {
    relay_dir().join("fixtures").join("breadcrumb-golden.json")
}

fn read_golden_fixture() -> Json {
    let path = golden_fixture_path();
    let text = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "D6 golden: cannot read {} ({e}). The fixture is the CONTRACT between \
             observability.rs and the relay parser; without it neither side is pinned.",
            path.display()
        )
    });
    parse_json(&text).unwrap_or_else(|e| {
        panic!(
            "D6 golden: {} does not parse: {e}. A fixture that cannot be read must FAIL both \
             sides, never be skipped by either.",
            path.display()
        )
    })
}

/// Every case id the fixture must still carry, grouped by the AM13 category it
/// covers. Named individually, never counted: a bare count is satisfied by
/// duplicating the easy case, and deleting the one awkward case is exactly the
/// edit this list exists to bite.
const REQUIRED_CASE_IDS: [&str; 19] = [
    // baseline + prose
    "heartbeat-plain",
    "prose-message",
    // cause-keyed
    "cause-enter",
    "cause-exit",
    // sched-keyed
    "sched-enter",
    "sched-exit",
    // escaping
    "escaping-quote-backslash",
    "escaping-control-chars",
    "escaping-nested-evt-in-string",
    // duplicate-key forgery (one that must be rejected, two that must not be)
    "forged-duplicate-evt",
    "nested-evt-object",
    // i64 content_version bounds
    "content-version-i64-max",
    "content-version-i64-min",
    // mixed-length ts
    "ts-short",
    "ts-precision",
    // non-JSON and malformed host lines
    "non-json-line",
    "json-array-line",
    "missing-message",
    "missing-ts",
];

/// The 13 cases that carry a module payload; the other 6 are JS-only (a forged
/// line, a prose message, and four malformed host envelopes) and this side
/// deliberately has nothing to say about them.
const GOLDEN_MODULE_CASES: usize = 13;

fn golden_cases(doc: &Json) -> &Vec<Json> {
    let root = json_obj(doc, "the golden fixture");
    match json_field(root, "schema", "the golden fixture") {
        Json::Num(raw) if raw == "1" => {}
        other => panic!("D6 golden: schema is {other:?}, expected 1"),
    }
    match json_field(root, "cases", "the golden fixture") {
        Json::Arr(cases) => cases,
        other => panic!("D6 golden: `cases` is not an array ({other:?})"),
    }
}

/// Deletion bites: the exact case count AND every committed id by name.
#[test]
fn d6_golden_fixture_carries_every_committed_case_id() {
    let doc = read_golden_fixture();
    let cases = golden_cases(&doc);
    let ids: Vec<&str> = cases
        .iter()
        .map(|c| json_str(json_obj(c, "a golden case"), "id", "a golden case"))
        .collect();

    assert_eq!(
        ids.len(),
        REQUIRED_CASE_IDS.len(),
        "D6 golden: the fixture carries {} cases, {} are committed. Thinning the fixture is a \
         reviewed decision in BOTH suites, never a quiet edit in one.",
        ids.len(),
        REQUIRED_CASE_IDS.len()
    );
    for required in REQUIRED_CASE_IDS {
        assert!(
            ids.contains(&required),
            "D6 golden: the committed case `{required}` is gone. Each id covers a category the \
             AM13 coverage list names; a count alone would be satisfied by a duplicate."
        );
    }
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    let before = sorted.len();
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        before,
        "D6 golden: duplicate case ids — two cases sharing an id make the id-based coverage \
         assertions above meaningless"
    );
}

/// The mirror itself: `build_log_line` must reproduce every committed
/// `expected_module_json` byte for byte.
///
/// Kills: any drift in the envelope's field ORDER, its comma placement, its
/// `sched` nesting, or `json_escape`'s escaping table — each of which would
/// leave the relay parsing a shape the module no longer emits, with nothing
/// else in the tree to notice.
#[test]
fn d6_golden_fixture_mirrors_build_log_line() {
    let doc = read_golden_fixture();
    let cases = golden_cases(&doc);
    let mut mirrored = 0usize;
    let mut skipped = 0usize;

    for case in cases {
        let fields = json_obj(case, "a golden case");
        let id = json_str(fields, "id", "a golden case");
        let forged = json_bool(fields, "forged", id);
        let expected = json_opt_str(fields, "expected_module_json", id);

        if expected.is_none() {
            assert!(
                json_opt_str(fields, "evt", id).is_none(),
                "D6 golden: case `{id}` has no expected_module_json but still declares an evt — \
                 the Rust mirror skips it, so a module-layer input there is unread and untested"
            );
            skipped += 1;
            continue;
        }
        assert!(
            !forged,
            "D6 golden: case `{id}` is marked forged AND carries an expected_module_json. A \
             forged line is one build_log_line cannot produce; the two fields contradict."
        );

        let evt = json_str(fields, "evt", id);
        let extra = json_str(fields, "extra_fields_json", id);
        let crumb = json_obj(json_field(fields, "breadcrumb", id), "breadcrumb");
        let cause = json_opt_str(crumb, "cause", id);
        let phase = json_opt_str(crumb, "phase", id);
        let sched = match json_field(crumb, "sched", id) {
            Json::Null => None,
            Json::Obj(inner) => Some((
                json_str(inner, "target_reducer", id),
                json_i64(inner, "scheduled_at", id),
            )),
            other => panic!("D6 golden: case `{id}` has a malformed sched ({other:?})"),
        };

        let line = build_log_line(
            evt,
            extra,
            Breadcrumb {
                cause,
                sched,
                phase,
            },
        );
        assert_eq!(
            line,
            expected.unwrap(),
            "D6 golden: case `{id}` — build_log_line no longer reproduces the committed \
             envelope. The relay parses what this function emits; fix the emitter or, if the \
             envelope changed on purpose, regenerate BOTH layers of the fixture and say so in \
             the PR."
        );
        mirrored += 1;
    }

    assert_eq!(
        mirrored, GOLDEN_MODULE_CASES,
        "D6 golden: {mirrored} cases were mirrored, {GOLDEN_MODULE_CASES} are committed. A \
         scanner that mirrors nothing passes everything."
    );
    assert_eq!(
        skipped,
        REQUIRED_CASE_IDS.len() - GOLDEN_MODULE_CASES,
        "D6 golden: {skipped} cases were skipped as JS-only; the committed split is \
         {GOLDEN_MODULE_CASES} module cases and the rest"
    );
}

// ---------------------------------------------------------------------------
// OBS-50 Rust half — the second, independent paired-call-site scanner (AM5).
// ---------------------------------------------------------------------------

/// What one file's scan found. `orphans` is the granularity blind spot made
/// visible: a phase literal outside every reducer body cannot be attributed to
/// a reducer NAME, so it is reported rather than silently dropped.
struct PhaseScan {
    paired: Vec<String>,
    reducers_scanned: usize,
    attrs_seen: usize,
    orphans: usize,
}

/// "Paired reducer" means BOTH literals inside ONE reducer function's body
/// (AM5), found by brace tracking over the comment-scrubbed source — the same
/// rule the JS scanner implements, arrived at independently here.
///
/// `attrs_seen` is counted in its own pass over the SAME scrubbed text, so
/// `attrs_seen != reducers_scanned` means the brace walk derailed rather than
/// that the tree changed. A derailed walk stops finding call sites, which is
/// precisely the vacuous green this gate must not have.
///
/// The tracker counts braces without lexing string or char literals — the same
/// simplification `fn_body` above and the three other brace walkers in this
/// crate make. CHECKED, not assumed, at authoring time: no reducer-bearing
/// non-test file spells a brace as a CHAR literal (the only ones in the tree
/// live in `content.rs`, which declares no reducer, and in `_tests.rs` files,
/// which `collect_src` excludes), every brace inside a format string is a
/// balanced pair, and comment lines are scrubbed first. If a future edit breaks
/// that, the counts diverge and the assertion fires with a message saying so —
/// a loud, actionable failure rather than a silently truncated scan.
fn scan_phase_pairs(src: &str) -> PhaseScan {
    let text = scrub_comment_lines(src);
    let mut attrs_seen = 0usize;
    let mut at = 0usize;
    while let Some(rel) = text[at..].find(REDUCER_ATTR) {
        attrs_seen += 1;
        at += rel + REDUCER_ATTR.len();
    }

    let mut paired: Vec<String> = Vec::new();
    let mut bodies: Vec<(usize, usize)> = Vec::new();
    let mut reducers_scanned = 0usize;
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(REDUCER_ATTR) {
        let attr_at = from + rel;
        let fn_marker = concat!("fn", " ");
        let fn_rel = match text[attr_at..].find(fn_marker) {
            Some(k) => k,
            None => break,
        };
        let name_at = attr_at + fn_rel + fn_marker.len();
        let name_end = text[name_at..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .map_or(text.len(), |k| name_at + k);
        let name = text[name_at..name_end].to_string();
        let open = match text[name_end..].find('{') {
            Some(k) => name_end + k,
            None => break,
        };
        let mut depth = 0usize;
        let mut close: Option<usize> = None;
        for (i, ch) in text[open..].char_indices() {
            if ch == '{' {
                depth += 1;
            } else if ch == '}' {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + i);
                    break;
                }
            }
        }
        let close = match close {
            Some(k) => k,
            None => break,
        };
        reducers_scanned += 1;
        let body = &text[open + 1..close];
        if body.contains(PHASE_ENTER) && body.contains(PHASE_EXIT) {
            paired.push(name);
        }
        bodies.push((open, close));
        from = close;
    }

    let mut orphans = 0usize;
    for needle in [PHASE_ENTER, PHASE_EXIT] {
        let mut cursor = 0usize;
        while let Some(rel) = text[cursor..].find(needle) {
            let pos = cursor + rel;
            if !bodies.iter().any(|&(o, c)| pos > o && pos < c) {
                orphans += 1;
            }
            cursor = pos + needle.len();
        }
    }

    PhaseScan {
        paired,
        reducers_scanned,
        attrs_seen,
        orphans,
    }
}

fn scan_tree_phase_pairs() -> PhaseScan {
    let mut all = PhaseScan {
        paired: Vec::new(),
        reducers_scanned: 0,
        attrs_seen: 0,
        orphans: 0,
    };
    for src in scan_tree().values() {
        let one = scan_phase_pairs(src);
        all.paired.extend(one.paired);
        all.reducers_scanned += one.reducers_scanned;
        all.attrs_seen += one.attrs_seen;
        all.orphans += one.orphans;
    }
    all.paired.sort();
    all.paired.dedup();
    all
}

fn trace_pair_set_path() -> PathBuf {
    relay_dir().join("trace-pair-set.json")
}

/// The committed `$trace_pair_set`, read in the same fail-loud stages the eval's
/// G9d uses. ABSENCE IS NOT THE EMPTY SET.
fn read_trace_pair_set() -> Vec<String> {
    let path = trace_pair_set_path();
    let text = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "G9 (OBS-50): cannot read {} ({e}). ABSENCE IS NOT THE EMPTY SET — a missing or \
             unreadable config must FAIL here, never read as `no reducer is instrumented`, or \
             the set equality below passes vacuously forever.",
            path.display()
        )
    });
    let doc = parse_json(&text)
        .unwrap_or_else(|e| panic!("G9 (OBS-50): {} does not parse: {e}", path.display()));
    let root = json_obj(&doc, "trace-pair-set.json");
    match json_field(root, "schema", "trace-pair-set.json") {
        Json::Num(raw) if raw == "1" => {}
        other => panic!("G9 (OBS-50): trace-pair-set.json schema is {other:?}, expected 1"),
    }
    let members = match json_field(root, "trace_pair_set", "trace-pair-set.json") {
        Json::Arr(items) => items,
        other => panic!("G9 (OBS-50): `trace_pair_set` is not an array ({other:?})"),
    };
    let mut names: Vec<String> = Vec::new();
    for item in members {
        match item {
            Json::Str(s) if !s.trim().is_empty() => names.push(s.clone()),
            other => panic!("G9 (OBS-50): membership entry {other:?} is not a reducer name"),
        }
    }
    names.sort();
    names.dedup();
    names
}

/// OBS-50's single-source-of-truth extension (spec:652-655), enforced from the
/// Rust side: the committed `$trace_pair_set` equals the set of reducers that
/// actually carry a paired enter/exit breadcrumb — neither a superset nor a
/// subset, with the two directions reported separately.
///
/// This is the SECOND implementation of that rule; the first lives in
/// `evals/observability-stack-config.eval.mjs` (G9f) and shares no code with
/// this one. While the set is empty on both sides, the teeth below are what
/// make the equality mean anything.
#[test]
fn g9_trace_pair_set_equals_paired_call_sites() {
    let scan = scan_tree_phase_pairs();

    assert!(
        scan.attrs_seen >= 10,
        "G9 (OBS-50): only {} reducer attributes were found across the tree — the scan sees \
         almost nothing, and a scanner that sees nothing passes everything",
        scan.attrs_seen
    );
    assert_eq!(
        scan.reducers_scanned, scan.attrs_seen,
        "G9 (OBS-50): {} reducer attributes but only {} bodies extracted — the brace walk \
         derailed part-way, so every call site after the derailment is invisible",
        scan.attrs_seen, scan.reducers_scanned
    );
    assert_eq!(
        scan.orphans, 0,
        "G9 (OBS-50): {} phase literal(s) sit OUTSIDE every reducer body. Such a literal cannot \
         be attributed to a reducer name, so neither this scanner nor the JS one can decide \
         membership for it — move the emission into the reducer body or widen BOTH scanners.",
        scan.orphans
    );

    let configured = read_trace_pair_set();
    let missing: Vec<&String> = configured
        .iter()
        .filter(|name| !scan.paired.iter().any(|found| found == *name))
        .collect();
    let extra: Vec<&String> = scan
        .paired
        .iter()
        .filter(|name| !configured.iter().any(|want| want == *name))
        .collect();

    assert!(
        missing.is_empty(),
        "G9 (OBS-50) SUPERSET: {missing:?} are in $trace_pair_set but no reducer body carries a \
         paired enter/exit breadcrumb for them — the config promises spans that will never exist"
    );
    assert!(
        extra.is_empty(),
        "G9 (OBS-50) SUBSET: {extra:?} carry a paired enter/exit breadcrumb but are NOT in \
         $trace_pair_set — the relay will drop their crumbs, so the instrumentation is dead \
         weight and OBS-51's pre-merge comparison was never run for them"
    );
}

// ---------------------------------------------------------------------------
// Teeth for the phase-pair scanner and the JSON reader. Every fixture is built
// FROM the `concat!`-assembled constants above, so this file still never spells
// a needle contiguously.
// ---------------------------------------------------------------------------

fn reducer_fixture(name: &str, body: &[&str]) -> String {
    let mut lines: Vec<String> = vec![
        concat!("#[spacetimedb", "::reducer]").to_string(),
        format!("pub fn {name}(ctx: &ReducerContext) -> Result<(), String> {{"),
    ];
    for line in body {
        lines.push((*line).to_string());
    }
    lines.push("    Ok(())".to_string());
    lines.push("}".to_string());
    lines.join("\n")
}

fn breadcrumb_call(phase_literal: &str) -> String {
    [
        "    mr_log_breadcrumb(e, x, Breadcrumb { cause: c, phase: ",
        phase_literal,
        ", ..Default::default() });",
    ]
    .concat()
}

/// THE tooth that makes an empty-versus-empty equality honest: a synthetic
/// reducer whose own body carries both literals MUST be detected. Without this,
/// a scanner that finds nothing is indistinguishable from a tree that contains
/// nothing, and G9 above is green forever by accident.
#[test]
fn scanner_teeth_phase_pair_scan_detects_a_real_pair() {
    let src = reducer_fixture(
        "synthetic_paired",
        &[
            breadcrumb_call(PHASE_ENTER).as_str(),
            "    if ctx.sender() != ctx.database_identity() { return Err(e); }",
            breadcrumb_call(PHASE_EXIT).as_str(),
        ],
    );
    let scan = scan_phase_pairs(&src);
    assert_eq!(
        scan.paired,
        vec!["synthetic_paired".to_string()],
        "TEETH: a reducer body carrying BOTH phase literals was not detected — an empty scan \
         result would make the OBS-50 set equality vacuously green"
    );
    assert_eq!(scan.reducers_scanned, 1, "TEETH: the body walk lost the fn");
    assert_eq!(scan.attrs_seen, 1, "TEETH: the attribute count is wrong");
    assert_eq!(
        scan.orphans, 0,
        "TEETH: literals inside a reducer body were reported as orphans"
    );
}

/// The AM5 granularity rule, from three directions: a pair SPLIT across two
/// reducers is not a pair, a doc-comment MENTION is not a call site, and a
/// literal outside every reducer body is reported rather than dropped.
#[test]
fn scanner_teeth_phase_pairs_are_function_body_scoped() {
    // NEGATIVE CONTROL — enter in one reducer, exit in another, same file. A
    // file-wide `contains(enter) && contains(exit)` calls this a pair.
    let split = [
        reducer_fixture("only_enter", &[breadcrumb_call(PHASE_ENTER).as_str()]),
        reducer_fixture("only_exit", &[breadcrumb_call(PHASE_EXIT).as_str()]),
    ]
    .join("\n\n");
    let split_scan = scan_phase_pairs(&split);
    assert!(
        split_scan.paired.is_empty(),
        "TEETH (AM5): enter in one reducer and exit in ANOTHER registered as a pair: {:?}",
        split_scan.paired
    );
    assert_eq!(
        split_scan.reducers_scanned, 2,
        "TEETH: the split fixture must yield two scanned bodies"
    );

    // A doc-comment mention is not a call site (the 56-vs-53 miscount class).
    let mention = [
        concat!("/", "/", "/ emits ").to_string(),
        PHASE_ENTER.to_string(),
        " then ".to_string(),
        PHASE_EXIT.to_string(),
        "\n".to_string(),
        reducer_fixture("documented", &["    let _ = ctx;"]),
    ]
    .concat();
    let mention_scan = scan_phase_pairs(&mention);
    assert!(
        mention_scan.paired.is_empty(),
        "TEETH: a doc-comment mention of both literals registered as a paired reducer"
    );

    // A helper that is not a reducer cannot be attributed to a reducer name, so
    // both of its literals must surface as orphans rather than vanish.
    let helper = [
        "fn helper_not_a_reducer() {",
        breadcrumb_call(PHASE_ENTER).as_str(),
        breadcrumb_call(PHASE_EXIT).as_str(),
        "}",
    ]
    .join("\n");
    let helper_scan = scan_phase_pairs(&helper);
    assert!(
        helper_scan.paired.is_empty(),
        "TEETH: a non-reducer helper registered as a paired reducer"
    );
    assert_eq!(
        helper_scan.orphans, 2,
        "TEETH: a phase literal outside every reducer body must be REPORTED, not dropped"
    );

    // Non-vacuity of the whole tooth: the same call, inside a reducer, IS found.
    let real = reducer_fixture(
        "paired",
        &[
            breadcrumb_call(PHASE_ENTER).as_str(),
            breadcrumb_call(PHASE_EXIT).as_str(),
        ],
    );
    assert_eq!(
        scan_phase_pairs(&real).paired.len(),
        1,
        "TEETH: the positive control stopped being detected, so every assertion above is vacuous"
    );
}

/// The JSON reader must refuse the shapes a lenient one would quietly accept.
/// Each of these would let a corrupted fixture read as a valid, thinner one.
#[test]
fn scanner_teeth_json_reader_is_strict() {
    let good = parse_json(
        "{\"schema\":1,\"cases\":[{\"id\":\"a\",\"n\":-9223372036854775808,\"b\":true}]}",
    )
    .expect("TEETH: a well-formed document was rejected");
    let root = json_obj(&good, "fixture");
    let cases = match json_field(root, "cases", "fixture") {
        Json::Arr(items) => items,
        other => panic!("TEETH: cases parsed as {other:?}"),
    };
    let first = json_obj(&cases[0], "case");
    assert_eq!(json_str(first, "id", "case"), "a");
    assert_eq!(
        json_i64(first, "n", "case"),
        i64::MIN,
        "TEETH: the i64 lower bound did not survive the reader — a float path would move it"
    );
    assert!(json_bool(first, "b", "case"));

    for (label, text) in [
        ("a duplicate key", "{\"evt\":\"a\",\"evt\":\"b\"}"),
        ("trailing content", "{\"a\":1} junk"),
        ("an unterminated string", "{\"a\":\"b"),
        ("a non-integer number", "{\"a\":1.5}"),
        ("an unknown escape", "{\"a\":\"\\q\"}"),
        ("a bare identifier", "{a:1}"),
        ("a missing comma", "{\"a\":1 \"b\":2}"),
        ("a truncated object", "{\"a\":1"),
        ("a bare value where an object is expected", "42"),
    ] {
        assert!(
            parse_json(text).is_err(),
            "TEETH: the reader accepted {label} — a lenient reader turns a corrupted fixture \
             into a valid, thinner one"
        );
    }

    // The escapes the fixture actually relies on must round-trip exactly.
    let escaped = parse_json("{\"c\":\"a\\\"b\\\\c\\t\\n\"}")
        .expect("TEETH: the escaping fixture shape was rejected");
    let fields = json_obj(&escaped, "escaped");
    assert_eq!(
        json_str(fields, "c", "escaped"),
        "a\u{0022}b\u{005C}c\t\n",
        "TEETH: the reader's escape table does not match the fixture's"
    );
}

// ===========================================================================
// rb-84 — every scheduled function is CLASSIFIED in recording.rules.yml.
//
// Closes R-rb-48-SLOCLASS. No ADR number assigned — the rationale for which
// scheduled functions sit on the lateness allowlist and which are excluded
// lives in `ops/observability/rules/recording.rules.yml`, mr-scheduler group,
// numbered-provenance item (5).
//
// THE RULE. WHEN the module declares a scheduled function (a table attribute
// carrying a `scheduled` argument in a non-test `server-module/src` file), THE
// SYSTEM SHALL classify that name in EXACTLY ONE of two places in the yml:
//   (a) the lateness ALLOWLIST — the `function` regex matcher of the starts
//       selector and of the on-time selector, which must agree; or
//   (b) the EXCLUSION bullet block — the `#`-comment lines directly under the
//       single comment line carrying the marker phrase in item (5), each bullet
//       being a dash, a space and a backticked identifier.
// Checked in all three directions: unclassified (declared, listed nowhere),
// double-listed (allowed AND excluded) and phantom (listed, never declared).
//
// The yml grammar parsed here (the implementer ships it; the teeth below define
// it): the allowlist is EVERY LIVE SELECTOR ON THE SCHEDULED-DELAY HISTOGRAM —
// discovery is anchored on the metric NAME in the comment-stripped text (a
// matcher in a comment is not live), never on a quote style: the `function`
// matcher may be double-, single- or backtick-quoted with any whitespace
// around `=~` (all valid PromQL), and a selector on that metric with no
// `function` matcher, or with any operator other than `=~`, fails loud. The
// comment-stripping is quote-aware `#` cutting with the same live-text
// semantics as `stripHashComments` in
// `evals/observability-stack-config.eval.mjs`; the marker line must sit INSIDE
// the mr-scheduler group (after its `- name:` line, before its first live
// selector); the bullet block ends at the first bare `#` line or the first
// non-comment line; any other comment line inside the block is a continuation
// of the previous bullet's reason and is ignored even when it carries
// backticks.
//
// Every needle below is `concat!`-assembled (module-header hygiene), and the
// fixtures are composed FROM those same constants (`rb84_bullet`,
// `rb84_fixture`), never from a second spelling of them.
// ===========================================================================

use std::collections::BTreeSet;

/// The lateness-allowlist marker of item (5) — a `#` comment line carrying it
/// opens the exclusion bullet block.
const RB84_MARKER: &str = concat!("DELIBERATELY ", "EXCLUDED");

/// Prefix of one exclusion bullet, after the leading `#` and whitespace.
const RB84_BULLET: &str = concat!("- ", "`");

/// The scheduled-delay histogram. Every LIVE selector on it is read as an
/// allowlist, whatever quote style its `function` matcher uses.
const RB84_METRIC: &str = concat!("spacetime_scheduled_function_", "delay_seconds_bucket");

/// The CANONICAL spelling of the opening of a live `function` regex matcher —
/// what the fixtures compose by default. The reader itself does not look for
/// this text (it is quote-style-agnostic and anchors on `RB84_METRIC`).
const RB84_SELECTOR: &str = concat!("function=", "~\"");

/// The group of recording.rules.yml whose item (5) carries the marker block.
const RB84_GROUP: &str = "mr-scheduler";

/// Every scheduled function the module declares today. A NEW scheduled function
/// must be classified in recording.rules.yml item (5) AND added to this pin.
const RB84_SCHEDULED_FUNCTIONS: [&str; 9] = [
    "account_deletion_reaper",
    "battle_challenge_reaper",
    "export_bundle_reaper",
    "guest_claim_reaper",
    "movement_tick",
    "mr_heartbeat",
    "playtest_reaper",
    "pvp_deadline_reaper",
    "trade_offer_reaper",
];

/// GATE mirror of eval G13a's `SCHEDULED_FN_NAMES` — defense in depth so a
/// consistent allow<->exclude SWAP (every name still classified exactly once)
/// cannot pass the union/disjoint check below. This is NOT a consumer copy of
/// the allowlist (ADR-0180's drift trap is about consumers): the rule set is
/// still the SSOT, and this pin only refuses to let it change silently.
const RB84_LATENESS_ALLOWLIST: [&str; 4] = [
    "movement_tick",
    "trade_offer_reaper",
    "pvp_deadline_reaper",
    "battle_challenge_reaper",
];

fn rb84_set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|n| (*n).to_string()).collect()
}

fn rb84_is_ident(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Every scheduled function NAME declared across `tree`, read out of the table
/// attribute's `scheduled` argument after `scrub_comment_lines`. The paren walk
/// is the shape of `evolution_tests::scheduled_reducer_names`, ported so both
/// scanners agree on what "scheduled" means. Panics (fail loud) on a name that
/// is declared twice: the roster pin could not say which one the yml classifies.
fn rb84_scheduled_roster(tree: &BTreeMap<String, String>) -> BTreeSet<String> {
    const ATTR: &str = concat!("#[spacetimedb::", "table(");
    const SCHED: &str = concat!("scheduled", "(");
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    for (file, raw) in tree {
        let text = scrub_comment_lines(raw);
        let mut pos = 0usize;
        while let Some(idx) = text[pos..].find(ATTR) {
            let args_start = pos + idx + ATTR.len();
            // Walk to the `)` that closes the attribute's own paren.
            let mut depth: usize = 1;
            let mut attr_end = text.len();
            for (off, ch) in text[args_start..].char_indices() {
                if ch == '(' {
                    depth += 1;
                } else if ch == ')' {
                    depth -= 1;
                    if depth == 0 {
                        attr_end = args_start + off;
                        break;
                    }
                }
            }
            let args = &text[args_start..attr_end];
            if let Some(sched_idx) = args.find(SCHED) {
                let name: String = args[sched_idx + SCHED.len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                if !name.is_empty() {
                    if let Some(prev) = seen.insert(name.clone(), file.clone()) {
                        panic!(
                            "rb84: scheduled function `{name}` is declared twice ({prev} and \
                             {file}) — the roster cannot say which declaration the yml classifies"
                        );
                    }
                }
            }
            pos = attr_end.max(args_start);
        }
    }
    seen.into_keys().collect()
}

/// Quote-aware YAML comment stripping with the same live-text semantics as
/// `stripHashComments` in the eval: a line is cut at the first `#` that sits
/// outside single or double quotes (a `#` INSIDE a quoted string is never a
/// comment). A whole-line comment is blanked here, which the eval's version
/// does not bother to do (it keeps the leading whitespace) — the live text is
/// identical either way. Line count is preserved, so a line index into the
/// stripped text is a line index into the raw text. Byte-wise, because every
/// character that matters is ASCII and cutting at an ASCII byte is always a
/// char boundary; the quote bytes are spelled numerically (module hygiene).
fn rb84_strip_yml_comments(raw: &str) -> String {
    const DQ: u8 = 0x22;
    const SQ: u8 = 0x27;
    let mut out = String::with_capacity(raw.len());
    for (i, line) in raw.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        if line.trim_start().starts_with('#') {
            continue;
        }
        let bytes = line.as_bytes();
        let mut quote: u8 = 0;
        let mut cut = bytes.len();
        for (at, &b) in bytes.iter().enumerate() {
            if quote != 0 {
                if b == quote {
                    quote = 0;
                }
            } else if b == DQ || b == SQ {
                quote = b;
            } else if b == b'#' {
                cut = at;
                break;
            }
        }
        out.push_str(&line[..cut]);
    }
    out
}

/// PromQL string delimiters, as bytes (module hygiene: never a quote CHAR
/// literal). A backtick-quoted value is a raw string; all three are valid.
const RB84_DQ: u8 = 0x22;
const RB84_SQ: u8 = 0x27;
const RB84_BT: u8 = 0x60;

/// Byte index of the first `}` in `body_rest` that sits outside a quoted
/// value, or None when the selector body never closes.
fn rb84_selector_body_end(body_rest: &str) -> Option<usize> {
    let mut quote: u8 = 0;
    for (at, &b) in body_rest.as_bytes().iter().enumerate() {
        if quote != 0 {
            if b == quote {
                quote = 0;
            }
        } else if b == RB84_DQ || b == RB84_SQ || b == RB84_BT {
            quote = b;
        } else if b == b'}' {
            return Some(at);
        }
    }
    None
}

/// The comma-separated matchers of one selector body, split on commas that sit
/// outside quoted values; blank segments (a trailing comma) are dropped.
fn rb84_split_matchers(body: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut quote: u8 = 0;
    let mut start = 0usize;
    for (at, &b) in body.as_bytes().iter().enumerate() {
        if quote != 0 {
            if b == quote {
                quote = 0;
            }
        } else if b == RB84_DQ || b == RB84_SQ || b == RB84_BT {
            quote = b;
        } else if b == b',' {
            out.push(&body[start..at]);
            start = at + 1;
        }
    }
    out.push(&body[start..]);
    out.into_iter().filter(|s| !s.trim().is_empty()).collect()
}

/// One `label op value` matcher, parsed TOLERANTLY from a selector segment: a
/// label name, optional whitespace, one of `=~` `!~` `!=` `=`, optional
/// whitespace, a value opened by a double quote, a single quote or a backtick
/// and closed by the SAME byte, then nothing but whitespace. Returns
/// (label, operator, value). Err on any other shape — a matcher this reader
/// cannot parse must fail loud, never read as "not the function matcher".
fn rb84_parse_matcher(seg: &str) -> Result<(String, &'static str, String), String> {
    let seg = seg.trim();
    let label: String = seg
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    if label.is_empty() {
        return Err(format!("matcher `{seg}` does not start with a label name"));
    }
    let rest = seg[label.len()..].trim_start();
    let op = ["=~", "!~", "!=", "="]
        .into_iter()
        .find(|o| rest.starts_with(*o))
        .ok_or_else(|| format!("matcher `{seg}` has no operator after `{label}`"))?;
    let rest = rest[op.len()..].trim_start();
    let bytes = rest.as_bytes();
    let quote = match bytes.first() {
        Some(&q) if q == RB84_DQ || q == RB84_SQ || q == RB84_BT => q,
        _ => {
            return Err(format!(
                "matcher `{seg}` has no quoted value after `{label}{op}`"
            ))
        }
    };
    let close = bytes
        .iter()
        .enumerate()
        .skip(1)
        .find(|&(_, &b)| b == quote)
        .map(|(at, _)| at)
        .ok_or_else(|| format!("matcher `{seg}` never closes its value quote"))?;
    if !rest[close + 1..].trim().is_empty() {
        return Err(format!(
            "matcher `{seg}` carries trailing text after its closing quote"
        ));
    }
    Ok((label, op, rest[1..close].to_string()))
}

/// Every live selector on `RB84_METRIC` in `stripped`, in file order, each as
/// the set of its `function` regex matcher's `|`-separated alternatives
/// (trimmed, empties dropped). Discovery is by METRIC NAME, so no quote style
/// or whitespace spelling of the matcher can hide a selector. Err (fail loud,
/// never an empty or missing allowlist) when the metric is not followed by a
/// `{...}` body, the body never closes, a matcher is malformed, the selector
/// carries no `function` matcher (an unfiltered selector would silently widen
/// the SLO to every function), two of them, or one whose operator is not `=~`.
fn rb84_function_selectors(stripped: &str) -> Result<Vec<BTreeSet<String>>, String> {
    let mut out = Vec::new();
    for (at, _) in stripped.match_indices(RB84_METRIC) {
        let after = &stripped[at + RB84_METRIC.len()..];
        let body_rest = match after.trim_start_matches([' ', '\t']).strip_prefix('{') {
            Some(body_rest) => body_rest,
            None => {
                return Err(format!(
                    "the selector on `{RB84_METRIC}` at byte {at} has no `{{...}}` body — an \
                     unfiltered selector would widen the SLO to every scheduled function"
                ));
            }
        };
        let end = rb84_selector_body_end(body_rest).ok_or_else(|| {
            format!("the selector on `{RB84_METRIC}` at byte {at} never closes its `{{`")
        })?;
        let mut function: Option<BTreeSet<String>> = None;
        for seg in rb84_split_matchers(&body_rest[..end]) {
            let (label, op, value) = rb84_parse_matcher(seg)
                .map_err(|e| format!("selector on `{RB84_METRIC}` at byte {at}: {e}"))?;
            if label != "function" {
                continue;
            }
            if op != "=~" {
                return Err(format!(
                    "unsupported matcher on the scheduled-delay metric at byte {at}: \
                     `function{op}` — only a `=~` alternation is an allowlist"
                ));
            }
            if function.is_some() {
                return Err(format!(
                    "the selector on `{RB84_METRIC}` at byte {at} carries two `function` \
                     matchers; the allowlist must be one alternation"
                ));
            }
            function = Some(
                value
                    .split('|')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect(),
            );
        }
        match function {
            Some(set) => out.push(set),
            None => {
                return Err(format!(
                    "the selector on `{RB84_METRIC}` at byte {at} has no `function` matcher — \
                     an unfiltered selector would widen the SLO to every scheduled function"
                ));
            }
        }
    }
    Ok(out)
}

/// The exclusion bullet block of item (5), parsed from the RAW yml (it lives in
/// comments). Err on: zero marker lines, more than one, zero bullets, a
/// duplicate bullet, or a bullet name that is empty or not `[a-z0-9_]+`.
fn rb84_exclusions(raw: &str) -> Result<BTreeSet<String>, String> {
    let lines: Vec<&str> = raw.split('\n').collect();
    let markers: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.trim_start().starts_with('#') && l.contains(RB84_MARKER))
        .map(|(i, _)| i + 1)
        .collect();
    let start = match markers.as_slice() {
        [one] => *one,
        [] => {
            return Err(format!(
                "no `#` comment line carries the `{RB84_MARKER}` marker, so there is no \
                 exclusion bullet block to read"
            ));
        }
        many => {
            return Err(format!(
                "{} comment lines carry the `{RB84_MARKER}` marker (lines {many:?}); exactly \
                 one is required or the bullet block is ambiguous",
                many.len()
            ));
        }
    };
    let mut names: BTreeSet<String> = BTreeSet::new();
    for (offset, line) in lines[start..].iter().enumerate() {
        let trimmed = line.trim();
        if trimmed == "#" || !trimmed.starts_with('#') {
            break;
        }
        let body = trimmed[1..].trim_start();
        let after = match body.strip_prefix(RB84_BULLET) {
            Some(after) => after,
            None => continue,
        };
        let lineno = start + offset + 1;
        let name = match after.find('`') {
            Some(end) => &after[..end],
            None => {
                return Err(format!(
                    "exclusion bullet on line {lineno} has no closing backtick: {trimmed}"
                ));
            }
        };
        if !rb84_is_ident(name) {
            return Err(format!(
                "exclusion bullet on line {lineno} names `{name}`, which is not a bare \
                 [a-z0-9_]+ identifier"
            ));
        }
        if !names.insert(name.to_string()) {
            return Err(format!(
                "exclusion bullet on line {lineno} lists `{name}` a second time"
            ));
        }
    }
    if names.is_empty() {
        return Err(format!(
            "the `{RB84_MARKER}` marker on line {start} is followed by no bullet of the form \
             `- `name`` before the block ends (bare `#` line or non-comment line)"
        ));
    }
    Ok(names)
}

/// Exactly-once classification, ALL THREE directions, one message naming every
/// offender (sorted) under its own heading. Never folded into a single set
/// equality: an unclassified name and a phantom name cancel out in one.
fn rb84_classify(
    roster: &BTreeSet<String>,
    allow: &BTreeSet<String>,
    excl: &BTreeSet<String>,
) -> Result<(), String> {
    let unclassified: Vec<&str> = roster
        .iter()
        .filter(|n| !allow.contains(*n) && !excl.contains(*n))
        .map(String::as_str)
        .collect();
    let both: Vec<&str> = allow
        .iter()
        .filter(|n| excl.contains(*n))
        .map(String::as_str)
        .collect();
    let phantom: Vec<&str> = allow
        .union(excl)
        .filter(|n| !roster.contains(*n))
        .map(String::as_str)
        .collect();
    let mut sections: Vec<String> = Vec::new();
    if !unclassified.is_empty() {
        sections.push(format!(
            "unclassified (declared, in neither the allowlist nor the exclusion block): \
             {unclassified:?}"
        ));
    }
    if !both.is_empty() {
        sections.push(format!(
            "both (allowlisted AND excluded — a name is classified exactly once): {both:?}"
        ));
    }
    if !phantom.is_empty() {
        sections.push(format!(
            "phantom (listed in the yml but no scheduled table declares it): {phantom:?}"
        ));
    }
    if sections.is_empty() {
        Ok(())
    } else {
        Err(sections.join("; "))
    }
}

/// The marker line sits INSIDE the `group` group: strictly after that group's
/// `- name:` line, strictly before the group's first live line reading
/// `RB84_METRIC`, and before any later `- name:` line. Without this, the
/// marker + bullet block relocated under another group still parses (the
/// bullet reader scans the whole file) while item (5) no longer documents the
/// selectors it sits beside. Err names the group.
fn rb84_marker_is_inside_group(raw: &str, group: &str) -> Result<(), String> {
    let lines: Vec<&str> = raw.split('\n').collect();
    let group_line = format!("- name: {group}");
    let groups: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.trim() == group_line)
        .map(|(i, _)| i + 1)
        .collect();
    let group_ln = match groups.as_slice() {
        [one] => *one,
        [] => {
            return Err(format!(
                "no `{group_line}` line in the yml — the `{RB84_MARKER}` marker block must sit \
                 inside the `{group}` group"
            ));
        }
        many => {
            return Err(format!(
                "{} `{group_line}` lines (lines {many:?}); exactly one is required",
                many.len()
            ));
        }
    };
    let markers: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.trim_start().starts_with('#') && l.contains(RB84_MARKER))
        .map(|(i, _)| i + 1)
        .collect();
    let marker_ln = match markers.as_slice() {
        [one] => *one,
        _ => {
            return Err(format!(
                "expected exactly one `#` line carrying the `{RB84_MARKER}` marker, found {} \
                 (lines {markers:?})",
                markers.len()
            ));
        }
    };
    // Line-preserving stripping, so a stripped line index is a raw line index.
    let stripped = rb84_strip_yml_comments(raw);
    let metric_ln = stripped
        .split('\n')
        .enumerate()
        .skip(group_ln)
        .find(|(_, l)| l.contains(RB84_METRIC))
        .map(|(i, _)| i + 1)
        .ok_or_else(|| {
            format!(
                "no live line after `{group_line}` (line {group_ln}) reads `{RB84_METRIC}`, so \
                 the `{group}` group has no selector for the `{RB84_MARKER}` block to precede"
            )
        })?;
    let next_group_ln = lines
        .iter()
        .enumerate()
        .skip(group_ln)
        .find(|(_, l)| l.trim_start().starts_with("- name:"))
        .map(|(i, _)| i + 1)
        .unwrap_or(usize::MAX);
    if marker_ln <= group_ln || marker_ln >= metric_ln || marker_ln >= next_group_ln {
        return Err(format!(
            "the `{RB84_MARKER}` marker (line {marker_ln}) is not inside the `{group}` group: it \
             must sit after `{group_line}` (line {group_ln}) and before that group's first live \
             selector on `{RB84_METRIC}` (line {metric_ln})"
        ));
    }
    Ok(())
}

/// The REAL rule file, read at test time. ABSENCE IS NOT THE EMPTY SET.
fn rb84_read_recording_rules() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("ops")
        .join("observability")
        .join("rules")
        .join("recording.rules.yml");
    fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "rb84: cannot read {} ({e}). The rule file is the SSOT for the scheduled-function \
             lateness allowlist; an unreadable SSOT must FAIL here, never read as empty.",
            path.display()
        )
    })
}

/// One exclusion bullet as it appears after the `#` and its indentation,
/// composed from `RB84_BULLET` so no fixture spells the prefix a second way.
fn rb84_bullet(name: &str, reason: &str) -> String {
    format!("{RB84_BULLET}{name}` {reason}")
}

/// One live rule line on `RB84_METRIC` whose selector body is `matcher`
/// followed by the `le` bucket edge, in the exact shape the yml ships.
fn rb84_rule_line(matcher: &str, le: &str) -> String {
    format!("          sum by (function) (rate({RB84_METRIC}{{{matcher},le=\"{le}\"}}[5m]))")
}

/// Minimal yml in the shape item (5) ships: a `#` provenance block carrying
/// the marker line, `bullets` (an empty entry renders as a bare `#` line), a
/// bare `#` terminator, then the starts and on-time rules whose selector
/// bodies open with `matcher_starts` / `matcher_on_time` VERBATIM — the
/// spelling of the `function` matcher is the caller's.
fn rb84_fixture_with_matchers(
    bullets: &[String],
    matcher_starts: &str,
    matcher_on_time: &str,
) -> String {
    let mut lines: Vec<String> = vec![
        "groups:".to_string(),
        format!("  - name: {RB84_GROUP}"),
        "    interval: 15s".to_string(),
        "    rules:".to_string(),
        "      #   (5) The in-scope functions are the ones in the matcher below.".to_string(),
        format!("      #       {RB84_MARKER}, listed so the exclusion is auditable:"),
    ];
    for bullet in bullets {
        if bullet.is_empty() {
            lines.push("      #".to_string());
        } else {
            lines.push(format!("      #       {bullet}"));
        }
    }
    lines.push("      #".to_string());
    for (name, matcher, le) in [
        ("starts", matcher_starts, "+Inf"),
        ("on_time", matcher_on_time, "0.05"),
    ] {
        lines.push(format!(
            "      - record: mr:scheduled_function_{name}:rate5m"
        ));
        lines.push("        expr: |".to_string());
        lines.push(rb84_rule_line(matcher, le));
    }
    lines.push("      - record: mr:scheduled_function_late:ratio5m".to_string());
    lines.push("        expr: |".to_string());
    lines.push("          1 - (a / b)".to_string());
    lines.join("\n")
}

/// `rb84_fixture_with_matchers` with the CANONICAL matcher spelling
/// (`RB84_SELECTOR`), `allow_starts` / `allow_on_time` being the alternations.
fn rb84_fixture(bullets: &[String], allow_starts: &str, allow_on_time: &str) -> String {
    rb84_fixture_with_matchers(
        bullets,
        &format!("{RB84_SELECTOR}{allow_starts}\""),
        &format!("{RB84_SELECTOR}{allow_on_time}\""),
    )
}

/// **rb-84 core** — the module's scheduled-function roster and the rule file
/// agree, exactly once per name, in both directions.
///
/// RED on the pristine yml: item (5) names its exclusions in prose, so the
/// bullet block is empty and `rb84_exclusions` returns Err; and
/// `export_bundle_reaper` / `account_deletion_reaper` are in neither list.
///
/// Kills: a yml that drops a name from one selector but not the other (drift);
/// a swap that moves an excluded name onto the allowlist while keeping every
/// name classified once (the literal allowlist pin); a NEW scheduled table that
/// nobody classified (the roster pin AND the unclassified direction); a stale
/// bullet for a deleted reaper (phantom); a name that is both allowed and
/// excluded (both).
#[test]
fn rb84_every_scheduled_function_is_classified_in_recording_rules() {
    let roster = rb84_scheduled_roster(&scan_tree());
    assert_eq!(
        roster,
        rb84_set(&RB84_SCHEDULED_FUNCTIONS),
        "rb84: the set of scheduled functions declared under server-module/src changed. A new \
         scheduled function must be classified in recording.rules.yml item (5) — allowlisted in \
         BOTH selectors or listed as an exclusion bullet — AND added to RB84_SCHEDULED_FUNCTIONS"
    );

    let raw = rb84_read_recording_rules();
    let stripped = rb84_strip_yml_comments(&raw);
    let selectors = rb84_function_selectors(&stripped).unwrap_or_else(|e| {
        panic!(
            "rb84: a live selector on the scheduled-delay histogram in recording.rules.yml \
             is malformed or unfiltered: {e}"
        )
    });
    assert_eq!(
        selectors.len(),
        2,
        "rb84: expected exactly two live selectors on `{RB84_METRIC}` (starts + on-time) in \
         recording.rules.yml, found {}: {selectors:?}. A third selector anywhere in the file \
         is a second allowlist, whatever quote style its matcher uses.",
        selectors.len()
    );
    assert_eq!(
        selectors[0], selectors[1],
        "rb84: DRIFT — the starts selector and the on-time selector carry different allowlists; \
         the ratio rule divides one by the other, so a name in only one side records nonsense"
    );
    assert_eq!(
        selectors[0],
        rb84_set(&RB84_LATENESS_ALLOWLIST),
        "rb84: the lateness allowlist changed (gate mirror of eval G13a's SCHEDULED_FN_NAMES; \
         a consistent allow<->exclude swap would otherwise pass the exactly-once check). If \
         the change is deliberate, update item (5)'s rationale, the eval pin and this pin."
    );

    rb84_marker_is_inside_group(&raw, RB84_GROUP).unwrap_or_else(|e| {
        panic!(
            "rb84: the exclusion bullet block is not where item (5) of the `{RB84_GROUP}` \
             group keeps it: {e}"
        )
    });
    let exclusions = rb84_exclusions(&raw).unwrap_or_else(|e| {
        panic!(
            "rb84: recording.rules.yml item (5) has no parseable exclusion bullet block: {e}. \
             Every scheduled function that is NOT on the lateness allowlist must appear as a \
             `- `name`` bullet directly under the marker line."
        )
    });
    rb84_classify(&roster, &selectors[0], &exclusions).unwrap_or_else(|e| {
        panic!(
            "rb84: scheduled functions are not classified exactly once in \
             recording.rules.yml item (5): {e}"
        )
    });
}

// ---------------------------------------------------------------------------
// Teeth — pure, on inline fixtures. Each names the wrong implementation it
// kills; together they DEFINE the item (5) grammar the implementer ships.
// ---------------------------------------------------------------------------

/// Kills: a classifier that only checks `allow ∪ excl ⊇ roster` by COUNT, or
/// that folds the three directions into one set equality where an unclassified
/// name and a phantom name cancel out.
#[test]
fn rb84_tooth_unclassified_name_is_named() {
    let roster = rb84_set(&["a_tick", "b_reaper", "x_reaper"]);
    let err = rb84_classify(&roster, &rb84_set(&["a_tick"]), &rb84_set(&["b_reaper"]))
        .expect_err("TEETH: a declared-but-unlisted name was accepted");
    assert!(
        err.contains("unclassified") && err.contains("x_reaper"),
        "TEETH: the unclassified offender is not named under its heading: {err}"
    );
    assert!(
        !err.contains("both") && !err.contains("phantom"),
        "TEETH: a purely unclassified case reported other directions: {err}"
    );
    // Non-vacuity: the fully classified sibling is Ok.
    rb84_classify(
        &rb84_set(&["a_tick", "b_reaper"]),
        &rb84_set(&["a_tick"]),
        &rb84_set(&["b_reaper"]),
    )
    .expect("TEETH: a correctly classified roster was rejected");
}

/// Kills: a classifier that checks only `roster ⊆ allow ∪ excl` — a name that
/// is BOTH allowlisted and excluded satisfies the union and must still fail.
#[test]
fn rb84_tooth_double_listed_name_is_named() {
    let roster = rb84_set(&["dup_reaper", "other_tick"]);
    let err = rb84_classify(
        &roster,
        &rb84_set(&["dup_reaper", "other_tick"]),
        &rb84_set(&["dup_reaper"]),
    )
    .expect_err("TEETH: a name listed on both sides was accepted");
    assert!(
        err.contains("both") && err.contains("dup_reaper"),
        "TEETH: the double-listed offender is not named under `both`: {err}"
    );
    assert!(
        !err.contains("unclassified") && !err.contains("phantom"),
        "TEETH: a purely double-listed case reported other directions: {err}"
    );
}

/// Kills: a classifier that never checks the reverse direction — a stale bullet
/// for a reaper that no longer exists would otherwise sit in the yml forever.
#[test]
fn rb84_tooth_phantom_listed_name_is_named() {
    let roster = rb84_set(&["a_tick"]);
    let err = rb84_classify(
        &roster,
        &rb84_set(&["a_tick"]),
        &rb84_set(&["ghost_reaper"]),
    )
    .expect_err("TEETH: a listed-but-undeclared name was accepted");
    assert!(
        err.contains("phantom") && err.contains("ghost_reaper"),
        "TEETH: the phantom offender is not named under `phantom`: {err}"
    );
    assert!(
        !err.contains("unclassified") && !err.contains("both"),
        "TEETH: a purely phantom case reported other directions: {err}"
    );
}

/// Kills: a parser that reads only the FIRST selector (or dedups the two), so
/// a name dropped from the on-time side alone would still pass.
#[test]
fn rb84_tooth_selector_drift_is_detected() {
    let raw = rb84_fixture(&[rb84_bullet("e_reaper", "(harmless)")], "a|b|c|d", "a|b|c");
    let selectors = rb84_function_selectors(&rb84_strip_yml_comments(&raw))
        .expect("TEETH: two canonical selectors were rejected");
    assert_eq!(
        selectors.len(),
        2,
        "TEETH: both selectors must be found: {selectors:?}"
    );
    assert_eq!(selectors[0], rb84_set(&["a", "b", "c", "d"]));
    assert_eq!(selectors[1], rb84_set(&["a", "b", "c"]));
    assert_ne!(
        selectors[0], selectors[1],
        "TEETH: a four-name starts selector and a three-name on-time selector parsed equal"
    );
}

/// Kills: a selector reader that scans the RAW yml — a selector left behind in
/// a comment, or in a trailing `#` remark on a live line, would count as live
/// (and its decoy names would join the allowlist).
#[test]
fn rb84_tooth_commented_out_selector_is_not_live() {
    let raw = [
        rb84_fixture(&[rb84_bullet("e_reaper", "(harmless)")], "a|b", "a|b"),
        format!(
            "      # legacy matcher, kept for history: {RB84_METRIC}{{{RB84_SELECTOR}decoy\"}}"
        ),
        "      - record: mr:something_else".to_string(),
        format!("        expr: vector(0) # was {RB84_METRIC}{{{RB84_SELECTOR}decoy2\"}}"),
    ]
    .join("\n");

    let unstripped = rb84_function_selectors(&raw)
        .expect("TEETH: the fixture's four well-formed selectors were rejected");
    assert_eq!(
        unstripped.len(),
        4,
        "TEETH: the fixture must carry two live and two commented selectors: {unstripped:?}"
    );

    let live = rb84_function_selectors(&rb84_strip_yml_comments(&raw))
        .expect("TEETH: the two live selectors were rejected");
    assert_eq!(
        live.len(),
        2,
        "TEETH: comment stripping is not load-bearing — a commented-out selector counted as \
         live: {live:?}"
    );
    for set in &live {
        assert!(
            !set.contains("decoy") && !set.contains("decoy2"),
            "TEETH: a decoy name from a comment leaked into a live selector: {set:?}"
        );
    }
}

/// Kills: a stripper that cuts at the first `#` regardless of quotes (a `#`
/// inside a quoted label value would truncate the live selector after it), one
/// that keeps a trailing `#` remark, and one that does not preserve plain
/// lines byte-for-byte or the line count (the marker-position check indexes
/// stripped lines as raw lines).
#[test]
fn rb84_tooth_stripper_is_quote_aware_and_line_preserving() {
    let quoted = format!(
        "          {RB84_METRIC}{{job=\"a#b\",{RB84_SELECTOR}live_x\"}} # \
         {RB84_METRIC}{{{RB84_SELECTOR}decoy3\"}}"
    );
    let stripped = rb84_strip_yml_comments(&quoted);
    assert_eq!(
        stripped,
        format!("          {RB84_METRIC}{{job=\"a#b\",{RB84_SELECTOR}live_x\"}} "),
        "TEETH: the stripper cut at a `#` inside a quoted string, or kept the trailing remark"
    );
    assert_eq!(
        rb84_function_selectors(&stripped).expect("TEETH: the live selector was rejected"),
        vec![rb84_set(&["live_x"])],
        "TEETH: the live matcher after a quoted `#` was lost, or the trailing decoy survived"
    );
    let three = "   # whole-line comment\nkey: v # tail\nplain: 1";
    assert_eq!(
        rb84_strip_yml_comments(three),
        "\nkey: v \nplain: 1",
        "TEETH: whole-line comments must blank, trailing comments must cut, plain lines must \
         survive byte-for-byte"
    );
    assert_eq!(
        rb84_strip_yml_comments(three).split('\n').count(),
        three.split('\n').count(),
        "TEETH: stripping changed the line count, so stripped line indices are not raw ones"
    );
}

/// Kills (R1, MEASURED bypass): a selector reader anchored on the literal
/// double-quoted opening of the `function` regex matcher — a rogue LIVE rule
/// elsewhere in the file whose matcher is single-quoted (valid PromQL) was
/// invisible to it, so the integration test's "exactly two selectors" held
/// while a third selector silently widened the SLO to `export_bundle_reaper`.
/// Discovery by metric name finds it, and the exactly-two check bites.
#[test]
fn rb84_tooth_rogue_single_quoted_selector_is_counted() {
    let re = concat!("function", "=~");
    let rogue = format!("{re}'export_bundle_reaper',le=\"+Inf\"");
    let raw = [
        rb84_fixture(&[rb84_bullet("e_reaper", "x")], "a|b", "a|b"),
        "  - name: mr-meta".to_string(),
        "    interval: 15s".to_string(),
        "    rules:".to_string(),
        "      - record: mr:rogue_starts:rate5m".to_string(),
        "        expr: |".to_string(),
        format!("          sum by (function) (rate({RB84_METRIC}{{{rogue}}}[5m]))"),
    ]
    .join("\n");
    let selectors = rb84_function_selectors(&rb84_strip_yml_comments(&raw))
        .expect("TEETH: a single-quoted matcher is valid PromQL and must parse");
    assert_eq!(
        selectors.len(),
        3,
        "TEETH: the single-quoted rogue selector was not found by metric name: {selectors:?}"
    );
    assert_eq!(
        selectors[2],
        rb84_set(&["export_bundle_reaper"]),
        "TEETH: the rogue selector's alternation was not read out of its single quotes"
    );
    assert_ne!(
        selectors.len(),
        2,
        "TEETH: the integration test's exactly-two check would not bite on this file"
    );
}

/// Kills (R1): a reader that requires the canonical spelling — spaces or a tab
/// around `=~`, a backtick-quoted or single-quoted value, the `function`
/// matcher not first in the body, a value on another label that READS
/// `function`, and a trailing comma are all valid PromQL and must parse to the
/// same set as the canonical spelling.
#[test]
fn rb84_tooth_selector_spelling_is_tolerated() {
    let plain = rb84_fixture(&[rb84_bullet("e_reaper", "x")], "a|b", "a|b");
    let canonical = rb84_function_selectors(&rb84_strip_yml_comments(&plain))
        .expect("TEETH: the canonical spelling was rejected");
    assert_eq!(
        canonical[0],
        rb84_set(&["a", "b"]),
        "TEETH: positive control"
    );

    let spaced = "function =~ `b|a`";
    let tabbed = "db=\"function\", function\t=~\t'a|b',";
    let raw = rb84_fixture_with_matchers(&[rb84_bullet("e_reaper", "x")], spaced, tabbed);
    let tolerant = rb84_function_selectors(&rb84_strip_yml_comments(&raw))
        .expect("TEETH: a spaced, backtick- or single-quoted matcher was rejected");
    assert_eq!(
        tolerant.len(),
        2,
        "TEETH: a non-canonical spelling hid a selector: {tolerant:?}"
    );
    assert_eq!(
        tolerant[0], canonical[0],
        "TEETH: spaces around `=~` plus a backtick-quoted value did not parse to the same set"
    );
    assert_eq!(
        tolerant[1], canonical[0],
        "TEETH: a tab around `=~`, a single-quoted value, a `function`-valued other label or \
         a trailing comma changed the parsed set"
    );
}

/// Kills (R1): a reader that treats every `function` matcher as an allowlist —
/// `function!~`, `function=` and `function!=` are not alternations, and an
/// exclusion or equality matcher silently read as the allowlist would invert
/// or narrow the SLO. Each must fail loud with the "unsupported matcher" text.
#[test]
fn rb84_tooth_non_regex_function_matcher_fails_loud() {
    for op in ["!~", "=", "!="] {
        let bad = format!("function{op}\"a|b\"");
        let good = format!("{RB84_SELECTOR}a|b\"");
        let raw = rb84_fixture_with_matchers(&[rb84_bullet("e_reaper", "x")], &bad, &good);
        let accepted = format!("TEETH: `function{op}` was read as an allowlist");
        let err = rb84_function_selectors(&rb84_strip_yml_comments(&raw)).expect_err(&accepted);
        let spelled = format!("function{op}");
        assert!(
            err.contains("unsupported matcher") && err.contains(&spelled),
            "TEETH: the `function{op}` error does not name the operator as unsupported: {err}"
        );
    }
}

/// Kills (R1): a reader that tolerates a selector on the metric with NO
/// `function` matcher (an unfiltered rate over every scheduled function), one
/// with no `{...}` body at all, one whose body never closes, one carrying two
/// `function` matchers, and one with a malformed matcher — each must be an
/// Err, never a missing entry or an empty set.
#[test]
fn rb84_tooth_unfiltered_or_malformed_selector_fails_loud() {
    let bullets = [rb84_bullet("e_reaper", "x")];
    let good = format!("{RB84_SELECTOR}a\"");

    let unfiltered = rb84_fixture_with_matchers(&bullets, "db=\"x\"", &good);
    let err = rb84_function_selectors(&rb84_strip_yml_comments(&unfiltered))
        .expect_err("TEETH: a selector with no `function` matcher was accepted");
    assert!(
        err.contains("no `function` matcher"),
        "TEETH: the unfiltered-selector error does not say so: {err}"
    );

    let bare = [
        rb84_fixture(&bullets, "a", "a"),
        "      - record: mr:bare:rate5m".to_string(),
        "        expr: |".to_string(),
        format!("          sum(rate({RB84_METRIC}[5m]))"),
    ]
    .join("\n");
    let err = rb84_function_selectors(&rb84_strip_yml_comments(&bare))
        .expect_err("TEETH: a bare metric with no selector body was accepted");
    assert!(
        err.contains("no `{...}` body"),
        "TEETH: the missing-body error does not say so: {err}"
    );

    let unclosed = [
        rb84_fixture(&bullets, "a", "a"),
        "      - record: mr:unclosed:rate5m".to_string(),
        "        expr: |".to_string(),
        format!("          sum(rate({RB84_METRIC}{{{good},le=\"+Inf\"[5m]))"),
    ]
    .join("\n");
    let err = rb84_function_selectors(&rb84_strip_yml_comments(&unclosed))
        .expect_err("TEETH: a selector body that never closes was accepted");
    assert!(
        err.contains("never closes"),
        "TEETH: the unclosed-body error does not say so: {err}"
    );

    let twice = format!("{good},{good}");
    let doubled = rb84_fixture_with_matchers(&bullets, &twice, &good);
    let err = rb84_function_selectors(&rb84_strip_yml_comments(&doubled))
        .expect_err("TEETH: two `function` matchers in one selector were accepted");
    assert!(
        err.contains("two `function` matchers"),
        "TEETH: the doubled-matcher error does not say so: {err}"
    );

    let unquoted = format!("{}a|b", concat!("function", "=~"));
    let malformed = rb84_fixture_with_matchers(&bullets, &unquoted, &good);
    let err = rb84_function_selectors(&rb84_strip_yml_comments(&malformed))
        .expect_err("TEETH: an unquoted matcher value was accepted");
    assert!(
        err.contains("no quoted value"),
        "TEETH: the unquoted-value error does not say so: {err}"
    );
}

/// Kills (R2, MEASURED): a bullet reader that scans the WHOLE file for the
/// marker — the marker + bullet block relocated under `- name: mr-client`, or
/// moved below the rules it documents, still parsed. The position check
/// requires the marker strictly inside the scheduler group, and its Err names
/// the group.
#[test]
fn rb84_tooth_marker_must_sit_inside_the_scheduler_group() {
    let good = rb84_fixture(&[rb84_bullet("a_reaper", "x")], "m", "m");
    rb84_marker_is_inside_group(&good, RB84_GROUP)
        .expect("TEETH: the positive control's marker is inside the scheduler group");

    // Relocated: the marker block (and the fixture's rules) now sit under
    // mr-client; a scheduler group with its own live selector follows.
    let relocated = [
        good.replacen(&format!("- name: {RB84_GROUP}"), "- name: mr-client", 1),
        format!("  - name: {RB84_GROUP}"),
        "    interval: 15s".to_string(),
        "    rules:".to_string(),
        "      - record: mr:scheduled_function_starts:rate5m".to_string(),
        "        expr: |".to_string(),
        rb84_rule_line(&format!("{RB84_SELECTOR}m\""), "+Inf"),
    ]
    .join("\n");
    rb84_exclusions(&relocated).expect(
        "TEETH precondition: the whole-file bullet reader still parses the relocated block, \
         so the position check is the only thing standing",
    );
    let err = rb84_marker_is_inside_group(&relocated, RB84_GROUP)
        .expect_err("TEETH: a marker block under another group passed the position check");
    assert!(
        err.contains(RB84_GROUP),
        "TEETH: the relocated-marker error does not name the group: {err}"
    );

    // Moved below: still under the scheduler group, but AFTER the selectors it
    // is supposed to precede.
    let below = [
        good.replace(RB84_MARKER, "moved"),
        format!("      # {RB84_MARKER}, listed late:"),
        format!("      #   {}", rb84_bullet("a_reaper", "x")),
    ]
    .join("\n");
    rb84_exclusions(&below)
        .expect("TEETH precondition: the whole-file bullet reader still parses the moved block");
    let err = rb84_marker_is_inside_group(&below, RB84_GROUP)
        .expect_err("TEETH: a marker block below the selectors passed the position check");
    assert!(
        err.contains(RB84_GROUP),
        "TEETH: the moved-below error does not name the group: {err}"
    );

    // No such group at all is its own loud failure, naming the group asked for.
    let err = rb84_marker_is_inside_group(&good, "mr-nowhere")
        .expect_err("TEETH: a group that does not exist passed the position check");
    assert!(
        err.contains("mr-nowhere"),
        "TEETH: the missing-group error does not name the group: {err}"
    );
}

/// Kills: a bullet reader that scans the WHOLE comment block (or the whole
/// file) for `- \`name\`` lines instead of stopping at the block terminator —
/// a bullet after the bare `#` line, or after the rules, would be counted.
/// The mid-block blank `#` line dropping the trailing bullets is the documented
/// false-RED-safe direction: a split block makes the integration test fail
/// loud (unclassified), never silently pass.
#[test]
fn rb84_tooth_bullet_block_ends_at_bare_hash_line() {
    let raw = rb84_fixture(
        &[rb84_bullet("a_reaper", "x"), rb84_bullet("b_reaper", "y")],
        "m",
        "m",
    );
    assert_eq!(
        rb84_exclusions(&raw).expect("TEETH: a two-bullet block was rejected"),
        rb84_set(&["a_reaper", "b_reaper"]),
        "TEETH: the positive control lost a bullet"
    );

    // A blank `#` line mid-block ends it: only the bullets BEFORE it count.
    let split = rb84_fixture(
        &[
            rb84_bullet("a_reaper", "x"),
            String::new(),
            rb84_bullet("late_reaper", "z"),
        ],
        "m",
        "m",
    );
    assert_eq!(
        rb84_exclusions(&split).expect("TEETH: a block cut short by a bare `#` was rejected"),
        rb84_set(&["a_reaper"]),
        "TEETH: a bullet AFTER the bare `#` terminator was counted"
    );

    // A bullet-shaped comment after the rules (past a non-comment line) is not
    // part of the block either.
    let tail = [
        rb84_fixture(&[rb84_bullet("a_reaper", "x")], "m", "m"),
        format!("      # {}", rb84_bullet("tail_reaper", "q")),
    ]
    .join("\n");
    assert_eq!(
        rb84_exclusions(&tail).expect("TEETH: a block followed by rules was rejected"),
        rb84_set(&["a_reaper"]),
        "TEETH: a bullet-shaped comment after the rules was counted as an exclusion"
    );
}

/// Kills: a reader that extracts EVERY backticked token from the block (item
/// (5)'s reasons cite series names and fields in backticks), or one that looks
/// for the bullet prefix ANYWHERE in the line rather than at its start.
#[test]
fn rb84_tooth_continuation_lines_are_not_bullets() {
    let raw = rb84_fixture(
        &[
            rb84_bullet(
                "a_reaper",
                "(a long-horizon sweep whose reason cites `chunks` and",
            ),
            format!(
                "the series `mr:heartbeat:rate5m`; the reason goes on {} mid-line)",
                rb84_bullet("fake", "")
            ),
            rb84_bullet("b_reaper", "y"),
        ],
        "m",
        "m",
    );
    assert_eq!(
        rb84_exclusions(&raw).expect("TEETH: a block with continuation lines was rejected"),
        rb84_set(&["a_reaper", "b_reaper"]),
        "TEETH: a continuation line's backticked token or mid-line bullet fragment was read as \
         an exclusion"
    );
}

/// Kills: a reader that tolerates a missing marker (reads as "no exclusions",
/// letting the integration test pass on a yml with the block deleted), one that
/// takes the FIRST of two marker lines, and one that accepts an empty block.
#[test]
fn rb84_tooth_marker_must_be_unique_and_present() {
    let good = rb84_fixture(&[rb84_bullet("a_reaper", "x")], "m", "m");
    rb84_exclusions(&good).expect("TEETH: the positive control was rejected");

    let no_marker = good.replace(RB84_MARKER, "deliberately omitted");
    let err = rb84_exclusions(&no_marker).expect_err("TEETH: a yml without the marker parsed");
    assert!(
        err.contains("marker"),
        "TEETH: the zero-marker error does not say so: {err}"
    );

    let two_markers = [
        format!("      # a stray earlier {RB84_MARKER} mention"),
        good,
    ]
    .join("\n");
    let err = rb84_exclusions(&two_markers).expect_err("TEETH: two marker lines parsed");
    assert!(
        err.contains("2 comment lines"),
        "TEETH: the duplicate-marker error does not count them: {err}"
    );

    let no_bullets = rb84_fixture(&[], "m", "m");
    let err = rb84_exclusions(&no_bullets).expect_err("TEETH: a marker with no bullets parsed");
    assert!(
        err.contains("no bullet"),
        "TEETH: the empty-block error does not say so: {err}"
    );
}

/// Kills: a reader that accepts an empty name (`- \`\``), a non-identifier
/// (a hyphenated or capitalised token can never match a scheduled function, so
/// it would be a permanent phantom that reads like a real exclusion), or a
/// duplicated bullet (which a set-based reader silently collapses).
#[test]
fn rb84_tooth_bullet_name_must_be_an_identifier() {
    let empty = rb84_fixture(&[rb84_bullet("", "x")], "m", "m");
    let err = rb84_exclusions(&empty).expect_err("TEETH: an empty bullet name parsed");
    assert!(
        err.contains("identifier"),
        "TEETH: the empty-name error does not say so: {err}"
    );

    let bad = rb84_fixture(&[rb84_bullet("Bad-Name", "x")], "m", "m");
    let err = rb84_exclusions(&bad).expect_err("TEETH: a non-identifier bullet name parsed");
    assert!(
        err.contains("Bad-Name") && err.contains("identifier"),
        "TEETH: the bad-name error does not name the offender: {err}"
    );

    let dup = rb84_fixture(
        &[rb84_bullet("a_reaper", "x"), rb84_bullet("a_reaper", "y")],
        "m",
        "m",
    );
    let err = rb84_exclusions(&dup).expect_err("TEETH: a duplicated bullet parsed");
    assert!(
        err.contains("a_reaper") && err.contains("second time"),
        "TEETH: the duplicate-bullet error does not name the offender: {err}"
    );

    // The one bullet no helper can compose: the closing backtick is missing.
    let unclosed = rb84_fixture(&[format!("{RB84_BULLET}a_reaper x")], "m", "m");
    let err = rb84_exclusions(&unclosed).expect_err("TEETH: an unclosed backtick parsed");
    assert!(
        err.contains("closing backtick"),
        "TEETH: the unclosed-backtick error does not say so: {err}"
    );

    assert_eq!(
        rb84_exclusions(&rb84_fixture(&[rb84_bullet("ok_1", "x")], "m", "m"))
            .expect("TEETH: a valid identifier with a digit was rejected"),
        rb84_set(&["ok_1"])
    );
}

/// THE tooth that makes the exact-9 roster pin honest: a synthetic multi-line
/// attribute IS found, a `//`-commented decoy is NOT, a plain (unscheduled)
/// table contributes nothing, and an empty tree yields the empty set — so the
/// caller's exact-9 pin is what fails loud, never a scanner that sees nothing.
///
/// Kills: a scanner that only matches single-line attributes, one that skips
/// comment scrubbing, and one that takes every table's accessor as a name.
#[test]
fn rb84_tooth_roster_scanner_finds_a_synthetic_attribute() {
    let attr = concat!("#[spacetimedb::", "table(");
    let sched = concat!("scheduled", "(");
    let slashes = concat!("/", "/");
    let src = [
        attr.to_string(),
        "    accessor = x_schedule,".to_string(),
        format!("    {sched}x_reaper)"),
        ")]".to_string(),
        "pub struct XSchedule { pub id: u64 }".to_string(),
        format!("{slashes} {attr}accessor = decoy_schedule, {sched}decoy_reaper))]"),
        format!("{attr}accessor = plain_rows, public)]"),
        "pub struct PlainRow { pub id: u64 }".to_string(),
    ]
    .join("\n");
    let mut tree: BTreeMap<String, String> = BTreeMap::new();
    tree.insert("synthetic.rs".to_string(), src);
    assert_eq!(
        rb84_scheduled_roster(&tree),
        rb84_set(&["x_reaper"]),
        "TEETH: the multi-line attribute was missed, the commented decoy was counted, or the \
         unscheduled table contributed a name"
    );
    assert!(
        rb84_scheduled_roster(&BTreeMap::new()).is_empty(),
        "TEETH: an empty tree must yield the empty roster (the caller's exact pin bites)"
    );
}

/// Kills: a scanner that dedups silently — two declarations of one scheduled
/// name would make the roster pin pass while the yml could only classify one.
#[test]
#[should_panic(expected = "is declared twice")]
fn rb84_tooth_roster_scanner_rejects_a_duplicate_declaration() {
    let attr = concat!("#[spacetimedb::", "table(");
    let sched = concat!("scheduled", "(");
    let decl = format!("{attr}accessor = s, {sched}dup_reaper))]");
    let mut tree: BTreeMap<String, String> = BTreeMap::new();
    tree.insert("a.rs".to_string(), decl.clone());
    tree.insert("b.rs".to_string(), decl);
    let _ = rb84_scheduled_roster(&tree);
}
