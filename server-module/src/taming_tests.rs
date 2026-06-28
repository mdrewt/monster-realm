//! `taming` domain-submodule tests (M8.9c — test relocation, ADR-0056).
//!
//! Extracted verbatim from the former inline `#[cfg(test)] mod tests` in
//! `taming.rs`; every assertion, fixture, and helper is unchanged. Declared
//! from `taming.rs` as `#[path = "taming_tests.rs"] mod taming_tests;`, so
//! `super` still resolves to `taming` exactly as the inline module did.

// =========================================================================
// M8.8b-C: SSOT-wiring source-guard tests
//
// These parse the source text of this file (server-module/src/taming.rs) to
// verify that `attempt_recruit` routes turn-advance through `advance_turn`
// (ADR-0003 SSOT) rather than re-implementing it inline, and that the
// level-up HP heal is delegated to `game_core::level_up_healed_hp` rather
// than re-inlined here.
//
// These tests compile on day 1 (they only do string processing) and fail
// at RUNTIME — runtime-RED — because today's source has:
//   `battle.state.turn_number += 1;`  (raw inline increment)
//   `m.current_hp.saturating_add(derived.hp.saturating_sub(bm.max_hp))`
//     (inlined heal formula)
// and does NOT contain `advance_turn` or `level_up_healed_hp`.
//
// Mirror: evals/recruit-reducer-security.eval.mjs (extractReducerBody logic).
// =========================================================================

/// Include the full source of this file at compile time so the guard runs
/// without any filesystem I/O at test time.
const MODULE_SOURCE: &str = include_str!("taming.rs");

/// Strip Rust block comments (`/* ... */`) and line comments (`// ...`) from
/// `src`. Returns a new String with those regions replaced by spaces (same
/// byte-length, so line numbers are preserved for debugging).
///
/// This is a simple linear scanner — no regex crates required.
/// Corner-cases handled:
///   - Nested block comments are NOT supported (Rust does support them, but
///     no production code in this file uses them, and the eval does not either).
///   - String literals containing `/*` or `//` are NOT special-cased — this
///     is intentional: we only need to remove comments so the body-search
///     does not accidentally match a commented-out `turn_number +=`.
fn strip_rust_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            // Block comment: blank everything until the matching `*/`.
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            // Line comment: blank everything to the end of the line.
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    // SAFETY: we only copy ASCII bytes from the original UTF-8 source and
    // replace with spaces (0x20), which are valid UTF-8. The original source
    // is valid UTF-8 (Rust source files must be). So `out` is valid UTF-8.
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
}

/// Extract the body of a named `fn` from `src` (comment-stripped).
///
/// Finds `pub fn <name>(` or `fn <name>(`, walks to the first `{`, then
/// counts braces to find the matching `}`. Returns the slice BETWEEN the
/// outer braces (exclusive), or `None` if the function is not found.
///
/// Mirrors `extractReducerBody` in evals/recruit-reducer-security.eval.mjs.
fn extract_fn_body<'a>(src: &'a str, name: &str) -> Option<&'a str> {
    // Try `pub fn <name>(` first, then `fn <name>(`.
    let pub_needle = format!("pub fn {}(", name);
    let priv_needle = format!("fn {}(", name);
    let fn_start = src
        .find(pub_needle.as_str())
        .or_else(|| src.find(priv_needle.as_str()))?;

    // Walk forward from fn_start to find the opening `{`.
    let after_fn = &src[fn_start..];
    let brace_offset = after_fn.find('{')?;
    let body_start = fn_start + brace_offset + 1; // character after '{'

    // Count brace depth to find the matching '}'.
    // `rel` tracks the byte offset within `src[body_start..]`.
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
        None // unbalanced braces (should not happen in valid Rust)
    }
}

/// SSOT wiring: `attempt_recruit` must delegate the entire failed-recruit
/// battle transition (turn advance + optional strike-back) to the pure
/// game-core fn `resolve_recruit_failure` (ADR-0003). The u16::MAX→Fled
/// terminal, the skill-less-wild guard, and the correct operand order are
/// all owned by that fn and proven by its game-core behavioral tests.
/// Merely calling `advance_turn` directly in the reducer (with the return
/// value ignored, inverted, or anded with wild_has_skills) would pass a
/// purely textual `advance_turn` guard but be behaviorally wrong — hence
/// this guard checks for `resolve_recruit_failure` instead.
///
/// RED today: the reducer body contains `battle.state.turn_number += 1;`
/// and does NOT mention `resolve_recruit_failure`.
///
/// After the implementer's change: body calls `resolve_recruit_failure`
/// and no longer contains a raw `turn_number +=`.
#[test]
fn attempt_recruit_routes_turn_advance_through_game_core() {
    let stripped = strip_rust_comments(MODULE_SOURCE);
    let body = extract_fn_body(&stripped, "attempt_recruit")
        .expect("attempt_recruit function must exist in lib.rs");

    // Positive: the body must call the pure game-core transition fn.
    // This string does NOT appear in this test's own text (the test module
    // body is outside the extracted attempt_recruit slice), so the check
    // has genuine teeth.
    assert!(
        body.contains("resolve_recruit_failure"),
        "TEETH(ADR-0003 SSOT): attempt_recruit body must call \
         `resolve_recruit_failure` (game_core) to handle the failed-recruit \
         battle transition; calling advance_turn directly in the reducer \
         cannot be verified for correct operand order or skill-less-wild \
         handling. Body excerpt (first 400 chars): {:?}",
        &body[..body.len().min(400)]
    );

    // Negative: the body must NOT contain a raw inline turn increment.
    // Constructed from parts so the complete literal does not appear
    // verbatim in this test's own text.
    let forbidden = ["turn_number ", "+="].concat();
    assert!(
        !body.contains(forbidden.as_str()),
        "TEETH(ADR-0003 SSOT): attempt_recruit body must NOT contain a raw \
         `turn_number +=` increment; all turn-advance logic is owned by \
         game_core::resolve_recruit_failure (ADR-0003 residual). \
         Body excerpt (first 400 chars): {:?}",
        &body[..body.len().min(400)]
    );
}
