//! `observability` domain-submodule tests (m20a, ADR-0180 D6) — the pure
//! `build_log_line` / heartbeat envelope, the reserved-key guard on the raw
//! extra-fields fragment, and the D6 cross-language golden fixture.
//!
//! Wired from `observability.rs` as
//! `#[cfg(test)] #[path = "observability_tests.rs"] mod observability_tests;`
//! (the `playtest.rs:204` idiom), so `super` resolves to `observability`.

use super::*;
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
// m20e (T5) — D6 GOLDEN MIRROR. `ops/observability/relay/fixtures/breadcrumb-golden.json`
// is read by BOTH this file and `ops/observability/relay/parse.test.mjs`, and
// the two consumers read DIFFERENT LAYERS of it (AM4). This side asserts only
// `build_log_line(...) == expected_module_json`, byte for byte; it never looks
// at `host_line`, which is the JS side's business. That split is what makes the
// fixture a contract instead of a copy: the envelope cannot drift on either
// side without one of the two suites reddening, and neither suite can be
// "fixed" by editing the other's expectations.
//
// JSON is hand-parsed, strictly and fail-loud: `serde_json` is not a dependency
// of this crate and adding one for a test would be a real dependency for a
// test-only need. The parser REJECTS duplicate keys, trailing content and
// non-integer numbers, so the i64 bounds in the fixture cannot round-trip
// through a float.
//
// The double quote and the backslash are spelled as scalar-value escapes
// rather than as bare char literals.
// ===========================================================================

/// The double quote, never spelled as a bare char literal.
const DQUOTE: char = '\u{0022}';
/// The backslash, same reason (the `guards::json_escape` precedent).
const BSLASH: char = '\u{005C}';

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
