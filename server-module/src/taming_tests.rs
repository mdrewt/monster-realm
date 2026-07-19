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

// =========================================================================
// pt-b2 emit-wiring source-scan tests (ADR-0130)
//
// These parse taming.rs to verify the playtest emit is wired correctly:
//   RT-PTB2-01: record_recruit_event is called EXACTLY ONCE in attempt_recruit,
//               AFTER the `let success =` roll line and BEFORE `if success`.
//
// The three-stage scan pipeline (string-strip → comment-strip → squash_ws) is
// required per ADR-0125 M17.5d mandatory discipline.  Needles assembled with
// concat!() to prevent self-match.
//
// RED state today: record_recruit_event does not exist in the current taming.rs
// → count == 0, and the after-roll / before-branch ordering checks both fail.
// =========================================================================

/// Strip Rust string literals from `src` (taming-local copy, same as
/// ranking_tests.rs / pvp_tests.rs per-module convention, ADR-0125 anti-pattern #5).
///
/// Must run BEFORE strip_rust_comments so `//` inside a string literal is
/// already blanked before the comment pass walks the buffer.
fn strip_rust_strings_taming(src: &str) -> String {
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
                out.push(b' ');
                out.resize(out.len() + hashes, b' ');
                out.push(b' ');
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
                            out.push(b' ');
                            out.resize(out.len() + hashes, b' ');
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
            out.push(b' ');
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
                    out.push(b' ');
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

/// Remove all whitespace characters (rustfmt-proof composite needles,
/// ADR-0125 mandatory third pipeline stage).
fn squash_ws_taming(src: &str) -> String {
    src.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Full three-stage scan pipeline for taming.rs: strip strings → strip
/// comments → squash_ws.  All RT-PTB2-01 scan tests must use this.
fn stripped_taming_for_scan(src: &str) -> String {
    squash_ws_taming(&strip_rust_comments(&strip_rust_strings_taming(src)))
}

/// RT-PTB2-01 (a): `record_recruit_event(` appears EXACTLY ONCE in the
/// `attempt_recruit` function body.
///
/// The spec requires a single call at the single-site immediately after the
/// roll (spec: "EXACTLY one call, capturing pre-roll HP").  Two calls would
/// double-count every recruit attempt in the playtest analytics.
///
/// Kills:
///   - impl that adds a second call in the success branch (double-record on
///     capture) — count becomes 2 → assertion fails
///   - impl that adds a second call in the failure branch — same
///   - impl that omits the call entirely — count == 0 → assertion fails
///
/// RED today: record_recruit_event absent in taming.rs → count == 0.
#[test]
fn rt_ptb2_01a_record_recruit_event_called_exactly_once() {
    let squashed = stripped_taming_for_scan(MODULE_SOURCE);

    // Extract just the attempt_recruit body for a bounded count.
    let stripped_for_body = strip_rust_comments(&strip_rust_strings_taming(MODULE_SOURCE));
    let body = extract_fn_body(&stripped_for_body, "attempt_recruit")
        .expect("RT-PTB2-01a: attempt_recruit must exist in taming.rs");
    let body_squashed = squash_ws_taming(body);

    // Count occurrences of the call in the body (squashed).
    // Split at "record_recruit" to prevent self-match in this test file.
    let call_needle = concat!("record_recruit", "_event(");
    let count = body_squashed.matches(call_needle).count();

    assert_eq!(
        count, 1,
        "RT-PTB2-01a FAIL: `record_recruit_event(` appears {} time(s) in the \
         `attempt_recruit` body (squashed). Must appear EXACTLY once — a second call \
         would double-count the event. \
         Needle (squashed): {:?}. \
         RED today: 0 (record_recruit_event not yet in taming.rs).",
        count, call_needle
    );

    // Also verify the call does not appear ELSEWHERE in the full squashed source
    // at a higher count than 1 (this catches a second call outside attempt_recruit
    // that somehow escaped the body extraction).
    let total_count = squashed.matches(call_needle).count();
    assert_eq!(
        total_count, 1,
        "RT-PTB2-01a FAIL: `record_recruit_event(` appears {} time(s) across the whole \
         taming.rs (squashed). Must appear exactly once total (only in attempt_recruit). \
         A second call site anywhere in the file must fail this check.",
        total_count
    );
}

/// RT-PTB2-01 (b): the `record_recruit_event` call appears AFTER the
/// `let success =` roll line and BEFORE the `if success {` branch.
///
/// This is the both-paths-single-site tooth from the spec: the single call
/// must capture pre-branch state (HP at roll time) and cover both outcome
/// paths without duplicating.
///
/// Index ordering in the squashed body:
///   pos(let success=) < pos(record_recruit_event() < pos(if success{)
///
/// Kills:
///   - impl that puts the call inside `if success { ... }` (only records
///     successes, misses failures)
///   - impl that puts the call before the roll `let success =` (wrong HP: call
///     happens before the roll result is known)
///   - impl that puts the call after `if success { ... } else { ... }` (records
///     after the branch, losing the single-site guarantee)
///
/// RED today: record_recruit_event absent → all positions == None → assertion fails.
#[test]
fn rt_ptb2_01b_record_recruit_event_after_roll_before_branch() {
    let stripped_for_body = strip_rust_comments(&strip_rust_strings_taming(MODULE_SOURCE));
    let body = extract_fn_body(&stripped_for_body, "attempt_recruit")
        .expect("RT-PTB2-01b: attempt_recruit must exist in taming.rs");
    let body_squashed = squash_ws_taming(body);

    // The needle for the roll line (squashed).
    // Split at "letsuccess" to avoid matching the `if success` guard.
    // The actual squashed form of `let success = game_core::attempt_recruit(chance, roll);`
    // is `letsuccess=game_core::attempt_recruit(chance,roll);`.
    let roll_needle = concat!("letsuccess=game_core::", "attempt_recruit(chance,roll)");

    // The needle for the emit call (squashed).
    let call_needle = concat!("record_recruit", "_event(");

    // The needle for the success branch (squashed).
    // `if success {` squashes to `ifsuccess{`.
    let branch_needle = concat!("if", "success{");

    let roll_pos = body_squashed.find(roll_needle);
    let call_pos = body_squashed.find(call_needle);
    let branch_pos = body_squashed.find(branch_needle);

    // All three must be present before we check ordering.
    let roll_pos = roll_pos.unwrap_or_else(|| {
        panic!(
            "RT-PTB2-01b FAIL: roll needle {:?} not found in attempt_recruit body (squashed). \
             Expected `let success = game_core::attempt_recruit(chance, roll);`.",
            roll_needle
        )
    });
    let call_pos = call_pos.unwrap_or_else(|| {
        panic!(
            "RT-PTB2-01b FAIL: call needle {:?} not found in attempt_recruit body (squashed). \
             record_recruit_event not yet in taming.rs — RED state.",
            call_needle
        )
    });
    let branch_pos = branch_pos.unwrap_or_else(|| {
        panic!(
            "RT-PTB2-01b FAIL: branch needle {:?} not found in attempt_recruit body (squashed). \
             Expected `if success {{`.",
            branch_needle
        )
    });

    assert!(
        roll_pos < call_pos,
        "RT-PTB2-01b FAIL: record_recruit_event call (pos {}) appears BEFORE the roll \
         `let success = ...` (pos {}). The call must come AFTER the roll so it captures \
         the pre-branch state at roll-time, not before success is determined. \
         Kills: impl that emits before rolling.",
        call_pos,
        roll_pos
    );

    assert!(
        call_pos < branch_pos,
        "RT-PTB2-01b FAIL: record_recruit_event call (pos {}) appears AFTER `if success {{` \
         (pos {}). The call must come BEFORE the branch so it covers BOTH outcomes \
         (success and failure) in a single site. \
         Kills: impl that only records successes by placing the call inside `if success`.",
        call_pos,
        branch_pos
    );
}

/// RT-PTB2-01 (c): strengthening — the call passes the pre-roll locals
/// `bw.wild_species_id`, `hp_permille(wild_current_hp, wild_max_hp)`,
/// and `bait_item_id` (capturing state at roll time, not post-branch).
///
/// Squashed needle checks confirm the actual argument shapes. These close the
/// string-literal evasion gate (three-stage pipeline applied before search).
///
/// Kills:
///   - impl that passes `bw.wild_species_id` from inside the success branch
///     (bw is consumed there; would be a borrow error OR a wrong species)
///   - impl that hardcodes species_id=0 instead of reading from bw
///   - impl that passes `None` as bait_item_id (ignoring the bait argument)
#[test]
fn rt_ptb2_01c_record_recruit_event_passes_correct_args() {
    let squashed = stripped_taming_for_scan(MODULE_SOURCE);

    // Needle: bw.wild_species_id passed to the call.
    // Split at "bw.wild_" to prevent self-match.
    let species_needle = concat!("bw.wild_", "species_id");
    // Needle: hp_permille called with the pre-roll locals.
    // Split at "hp_permille" since that's the fn name.
    let hp_needle = concat!("hp_permille(", "wild_current_hp,wild_max_hp)");
    // Needle: bait_item_id is passed (not hardcoded None).
    let bait_needle = concat!("bait_item_id");

    // All three must appear in the squashed taming.rs source — we don't narrow
    // to the body here because the body extraction is already tested in (a)/(b).
    // These are argument shapes that must appear somewhere in taming.rs.
    assert!(
        squashed.contains(species_needle),
        "RT-PTB2-01c FAIL: taming.rs (squashed) does not contain {:?}. \
         record_recruit_event must pass `bw.wild_species_id` (pre-roll wild species). \
         RED today: call absent.",
        species_needle
    );

    assert!(
        squashed.contains(hp_needle),
        "RT-PTB2-01c FAIL: taming.rs (squashed) does not contain {:?}. \
         record_recruit_event must pass `hp_permille(wild_current_hp, wild_max_hp)` \
         (pre-roll HP permille, using the pre-roll local variables). \
         RED today: call absent.",
        hp_needle
    );

    assert!(
        squashed.contains(bait_needle),
        "RT-PTB2-01c FAIL: taming.rs (squashed) does not contain {:?}. \
         record_recruit_event must pass `bait_item_id` (the optional bait argument). \
         RED today: call absent.",
        bait_needle
    );
}
