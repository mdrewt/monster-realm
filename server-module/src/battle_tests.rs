//! `battle` test module — extracted from `battle.rs` (M8.9c, ADR-0056).
//!
//! Behavior-preserving relocation of the inline `#[cfg(test)] mod tests` into a
//! sibling file (matching the game-core `*_tests.rs` convention) so the
//! production module stays lean. Assertions are unchanged; `include_str!`
//! still targets the production `battle.rs` in this same directory.

// =========================================================================
// M8.8b-C: SSOT-wiring source-guard tests
//
// These parse the source text of this file (server-module/src/battle.rs) to
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
const MODULE_SOURCE: &str = include_str!("battle.rs");

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

/// SSOT wiring: the level-up HP heal inside the battle-results write-back
/// must be computed by `game_core::level_up_healed_hp`, not re-inlined.
///
/// Both checks are scoped to the EXTRACTED body of the function that owns
/// the heal so that string literals inside this test module never self-match.
/// The test module lives inside the included source (include_str! captures
/// the whole file), so searching the full stripped source would cause:
///   - the positive needle (`level_up_healed_hp`) to match the failure-message
///     text in this very test → false green;
///   - the negative needle to match the `inline_frag` variable binding in
///     this test → assertion never goes green even after a correct impl.
///
/// Scoping to the production function body eliminates both failure modes.
///
/// RED today: the production body contains the inline formula and no
/// level_up_healed_hp call.
#[test]
fn level_up_heal_is_owned_by_game_core() {
    let stripped = strip_rust_comments(MODULE_SOURCE);

    // Scope both checks to the body of the function that owns the heal.
    // The function name is assembled from parts so the complete literal
    // `fn write_back_battle_results(` does not appear in this test's own
    // source text (which is inside the included file) and thereby confuse
    // a hypothetical future caller of extract_fn_body on this test body.
    let heal_fn = ["write_back", "_battle", "_results"].concat();
    let body = extract_fn_body(&stripped, &heal_fn)
        .expect("the battle-results write-back function must exist in lib.rs");

    // Positive: the production body must delegate to game-core.
    // `level_up_healed_hp` does NOT appear in this test's own text, so
    // the assertion has genuine teeth — it only passes when the production
    // body actually contains that call.
    assert!(
        body.contains("level_up_healed_hp"),
        "TEETH(ADR-0003 residual 7c): the battle-results write-back body must \
         call `level_up_healed_hp` (game_core SSOT for level-up HP heal); \
         the heal formula must not be re-inlined. \
         Replace the inline with `game_core::level_up_healed_hp(m.current_hp, bm.max_hp, derived.hp)`."
    );

    // Negative: the inline formula fragment must be absent from the body.
    // Built from parts so the complete literal does not appear verbatim in
    // this test's text — the body slice is restricted to the production
    // function so the binding below is outside the searched region, but
    // constructing from parts keeps the invariant explicit and mirrors the
    // approach used in the attempt_recruit guard above.
    let inline_frag = ["saturating_sub", "(bm.max_hp)"].concat();
    assert!(
        !body.contains(inline_frag.as_str()),
        "TEETH(ADR-0003 residual 7c): the inline heal fragment \
         `saturating_sub(bm.max_hp)` must be removed from the \
         battle-results write-back body once `level_up_healed_hp` is \
         introduced; re-inlining duplicates the SSOT and risks diverging \
         from the game_core rule. Replace with `game_core::level_up_healed_hp(...)`."
    );
}
