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
// pt-b2 emit-wiring source-scan tests (ADR-0131)
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
    let bait_needle = "bait_item_id";

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

// =========================================================================
// 12r-d (E2) — the LAST ADR-0089 park marker
//
// The call-site swap itself is gated in `content_cache_tests.rs`
// (`pvp_and_taming_hot_paths_use_the_cached_accessors` /
// `pvp_and_taming_no_longer_call_the_uncached_loaders`); this file owns the
// COMMENT half, because the marker lives in `taming.rs` and a comment scan must
// run on RAW source, which is the one view every other guard in this file
// deliberately strips away.
// =========================================================================

/// **12r-d E2** — `taming.rs` carries no remaining ADR-0089 PARK marker.
///
/// ASSERTION-RED at HEAD: taming.rs:205-206 carries a two-line comment opening
/// with the ADR-0089 park tag and asserting that the uncached abilities loader
/// "is NOT cached — it re-parses RON per call", with caching named as a
/// follow-up. (The tag itself is never spelled contiguously in this file; see
/// the needle note below.)
///
/// WHY DELETING IT IS PART OF THE WORK, NOT COSMETIC. 11r-g removed the two
/// identical markers from `battle.rs` the moment its swap made them false, and
/// left this one standing ONLY because `taming.rs:207` was outside its declared
/// touch set (ADR-0170 residual 2 — the reason recorded in
/// `content_cache_tests.rs`'s C-10 doc comment). 12r-d swaps that call site, so
/// the comment becomes an assertion the code contradicts: it tells a future
/// reader that abilities are deliberately uncached here, which is precisely the
/// argument someone uses to "restore" the uncached call and silently undo the
/// slice. A stale comment about a caching decision is a trap with a long fuse.
///
/// SCANNED ON RAW, UN-STRIPPED SOURCE on purpose. The marker lives in a `//`
/// comment, so every comment-stripping view in this file would report zero and
/// the test would be vacuous in BOTH directions — green at HEAD and green after,
/// proving nothing either way. The `MODULE_SOURCE` constant is the raw text.
///
/// THE NEEDLE IS ASSEMBLED FROM FRAGMENTS so this test file never spells the
/// marker contiguously: several evals concatenate every source file under
/// `server-module/src` (the `*_tests.rs` files included) into one scan blob, and
/// a verbatim copy inside the test that FORBIDS the marker would be found by
/// them — the EG2 poisoning precedent. Same idiom, same reason, as
/// `content_cache_tests.rs`'s C-10.
///
/// KILLS: a swap that lands the code change and leaves the comment behind (the
/// most likely partial fix — nothing else in the suite reads comments), and a
/// "fix" that merely reworded the marker's prose while keeping the `PARK(ADR-…`
/// tag that the crate's park inventory is greppable by.
#[test]
fn taming_rs_carries_no_remaining_adr_0089_park_marker() {
    // Vacuity guard: an emptied/moved file must never read as marker-free.
    assert!(
        MODULE_SOURCE.len() > 2000,
        "vacuity guard (12r-d E2): taming.rs is only {} bytes — the file was \
         truncated, emptied or moved, and the absence assertion below would pass \
         against a hollow haystack",
        MODULE_SOURCE.len()
    );

    let needle = ["PARK(ADR-", "0089"].concat();
    let n = MODULE_SOURCE.matches(needle.as_str()).count();
    assert_eq!(
        n, 0,
        "TEETH (12r-d E2, ADR-0170 D2 residual 2): `taming.rs` still carries {n} \
         ADR-0089 PARK marker(s) matching the assembled needle `{needle}`; it must \
         carry ZERO. HEAD has 1, at taming.rs:205-206, stating that the abilities \
         registry is NOT cached at this call site. Once 12r-d swaps :207 to \
         `crate::content_cache::cached_abilities()?` that statement is FALSE, and a \
         false comment about a caching decision is exactly what persuades a future \
         reader to 'restore' the uncached call. 11r-g deleted the two identical \
         markers from `battle.rs` for the same reason and left this one only because \
         the call site was out of its scope. Scanned on RAW source because the marker \
         lives in a comment."
    );
}

// =========================================================================
// rb-80 — R-rb-46-ERASEWRITERS (ADR-0250 D4/D6/D8): the para-4.7 deletion gate
// on `grant_bait`.
//
// E1 names "the taming recruit grant_item path". MEASURED FINDING (ADR-0250 D4):
// that path is a MISATTRIBUTION — no recruit path calls `grant_item`. The ONE
// `grant_item(` call in `taming.rs` is at :297, inside `grant_bait`, a
// `cfg(feature = "dev_reducers")` DEV reducer that credits the CALLER's own
// `inventory` (an ERASE-policy table) with up to 99 items per call. It is gated
// here on the `battle::start_wild_battle` precedent (ADR-0236 D2/D3: a dev-only
// reducer that ships in the CI-built dev wasm gets the same gate as a
// client-callable one).
//
// `attempt_recruit` is CLASSIFY-OPEN (PRV1-10, ADR-0250 D6): its bait
// `consume_one` (:119) and its success-path monster insert both happen INSIDE an
// already-open wild battle behind the ownership and `Ongoing` guards — the
// `submit_attack` / `use_battle_item` class, which rb-46's census explicitly
// refuses to gate, and whose monster rows the cascade erases anyway (PRV1-6b).
// The census below pins that classification mechanically.
//
// SCAN SUBSTRATE. Every scan reuses THIS file's existing helpers only
// (`MODULE_SOURCE`, `strip_rust_comments`, `strip_rust_strings_taming`,
// `squash_ws_taming`, `stripped_taming_for_scan`, `extract_fn_body`) in the house
// three-stage order — no third stripper (ADR-0003). Every production needle is
// assembled from fragments and the double quote and both braces are spelled as
// NUMBERS. This file sorts AFTER `taming.rs`, so `evals/dev-reducer-gating` and
// `evals/recruit-reducer-security` still take their FIRST declaration hit from
// the production file; the rule is kept anyway, because the concatenation order
// is not this test's to rely on.
//
// HONEST LIMITS. The source pins read text, never behaviour. The executed matrix
// (the LAST test here, the crate's first `cfg(feature = "dev_reducers")`
// test) reads behaviour but stops at the first guard PAST the gate: `item_row`
// is `u32`-keyed, the fixture keys rows by the indexed column, an unregistered
// index yields no rows in this host, and every write syscall ABORTS the process
// (uncatchable, so `#[should_panic]` is unavailable). It proves a deletion-gated
// caller is REFUSED exactly where an admitted one is let through — not that an
// item stack changed.
// =========================================================================

/// The fully-qualified gate call, up to and including its open paren.
fn rb80_gate_opener() -> String {
    concat!("crate::guards::require_not", "_deleting(").to_string()
}

/// The bare wrapper name — what an alias, a re-export, a function-pointer
/// binding or a differently-argued sibling all still mention.
fn rb80_gate_bare_name() -> String {
    concat!("require_not", "_deleting").to_string()
}

/// The gate STATEMENT in both spellings rustfmt can produce, on the view
/// `strip_rust_strings_taming` leaves behind.
///
/// That stripper replaces the string DELIMITERS as well as the payload with
/// spaces, so the reducer tag reads as nothing at all here — which is why the tag
/// is pinned separately, on the strings-INTACT view, by clause T. Two needles
/// because the trailing-comma form is what rustfmt writes when an argument list
/// wraps, and a pin that knows only the plain form is defeated by an honest
/// re-wrap, which would drop the gate count to zero and make every clause below
/// it vacuous.
fn rb80_gate_needles() -> (String, String) {
    let call = rb80_gate_opener();
    (
        [call.as_str(), "ctx,)?;"].concat(),
        [call.as_str(), "ctx,,)?;"].concat(),
    )
}

/// The comments-stripped, strings-blanked, whitespace-squashed body of a
/// `taming.rs` function, in the house three-stage order
/// (`rt_ptb2_01b_record_recruit_event_after_roll_before_branch`, :354-357).
fn rb80_scan_body(fn_name: &str) -> String {
    let stripped = strip_rust_comments(&strip_rust_strings_taming(MODULE_SOURCE));
    let body = extract_fn_body(&stripped, fn_name).unwrap_or_else(|| {
        panic!(
            "rb-80 [rb80/extract] E1 FAIL: `taming.rs` declares no function named `{fn_name}` \
             whose brace-bounded body can be sliced out. Either the reducer was renamed or \
             removed — in which case every pin scoped to it is vacuous and must be re-derived \
             from ADR-0250 — or its opening brace or matching close is gone."
        )
    });
    let squashed = squash_ws_taming(body);
    assert!(
        !squashed.is_empty(),
        "rb-80 [rb80/extract] E1 FAIL (non-vacuity): the extracted `{fn_name}` body is EMPTY, so \
         every clause below would be asserting properties of nothing."
    );
    squashed
}

/// The comments-stripped, strings-INTACT, whitespace-squashed body of a
/// `taming.rs` function — the only view on which the reducer TAG inside the gate
/// call is visible.
///
/// Running the comment stripper WITHOUT the string stripper is sound on this
/// file: no string literal in `taming.rs` contains a comment opener, and the
/// braces inside its two hand-built JSON log lines are BALANCED, so
/// `extract_fn_body`'s depth walk still closes on the body's own brace. Clause
/// 0b/0c asserts both preconditions on the RAW file rather than assuming them.
fn rb80_intact_body(fn_name: &str) -> String {
    let stripped = strip_rust_comments(MODULE_SOURCE);
    let body = extract_fn_body(&stripped, fn_name).unwrap_or_else(|| {
        panic!(
            "rb-80 [rb80/extract] E1 FAIL (strings-intact view): `taming.rs` declares no function \
             named `{fn_name}`. The tag clause below cannot run over a body that does not exist."
        )
    });
    squash_ws_taming(body)
}

/// The substrate hazards this file's strippers do not model, asserted on the RAW
/// source because on a stripped view every one of them is tautologically absent.
///
/// A double quote spelled as a CHAR literal inverts string/code polarity for the
/// rest of the file; a brace CHAR literal survives both strippers and
/// desynchronises `extract_fn_body`'s depth walk by exactly one (enough to slice
/// the wrong body, and enough to make a gate nested in a never-taken branch
/// report as top level); an UNPAIRED block-comment opener blanks the file to its
/// last byte, which would make every clause below read green about text it never
/// looked at; a comment opener INSIDE a string literal is the one hazard the
/// strings-intact view has and the house pipeline does not. Raw strings are NOT
/// asserted absent here — `strip_rust_strings_taming` models them (`:199-234`),
/// which is exactly why this file's precondition set differs from
/// `raising_tests.rs`'s. rb-78's crate-wide `[rb78/scan-substrate]` clause is the
/// outer net; this is the local one, and it names the file.
fn rb80_assert_scan_substrate(raw: &str) {
    let sq = char::from(0x27u8).to_string();
    let dq = char::from(0x22u8).to_string();
    let quote_landmine = [sq.as_str(), dq.as_str(), sq.as_str()].concat();
    assert!(
        !raw.contains(quote_landmine.as_str()),
        "rb-80 [rb80/scan-substrate] SCAN PRECONDITION: `taming.rs` spells a double quote as a \
         CHAR literal. Neither stripper in this file has a char lexer, so that quote reads as a \
         string OPENER and inverts string/code polarity for the rest of the file — every needle \
         below would then search text that no longer exists and report a missing gate or a \
         satisfied ordering. Spell it with a Unicode escape (`guards.rs::json_escape` is the \
         in-tree precedent); never delete this check."
    );
    for code in [0x7Bu8, 0x7Du8] {
        let brace = char::from(code).to_string();
        let landmine = [sq.as_str(), brace.as_str(), sq.as_str()].concat();
        assert!(
            !raw.contains(landmine.as_str()),
            "rb-80 [rb80/scan-substrate] SCAN PRECONDITION: `taming.rs` contains the character \
             literal {landmine} , which both strippers keep. Its brace desynchronises \
             `extract_fn_body`'s depth walk and clause C's depth count by one — enough to slice \
             the wrong body, and enough to make a gate nested inside a never-taken branch report \
             as a top-level statement."
        );
    }
    let open_marker = ["/", "*"].concat();
    let close_marker = ["*", "/"].concat();
    let n_open = raw.matches(open_marker.as_str()).count();
    let n_close = raw.matches(close_marker.as_str()).count();
    assert_eq!(
        n_open, n_close,
        "rb-80 [rb80/scan-substrate] SCAN PRECONDITION: `taming.rs` carries {n_open} \
         block-comment opener(s) and {n_close} closer(s). An UNPAIRED opener makes \
         `strip_rust_comments` hunt a closer that never comes and blank the file to its LAST \
         BYTE: the gate needle disappears with it, every count below reads zero, and the verdict \
         would be silent, total vacuity that looks exactly like a clean file. Counted on the RAW \
         text, because by the time the scan has the stripped view there is nothing left to count."
    );
    assert!(
        raw.len() > 2000,
        "rb-80 [rb80/scan-substrate] SCAN PRECONDITION (vacuity): `taming.rs` is only {} bytes — \
         the file was truncated, emptied or moved, and every count below would report a clean \
         verdict about a hollow haystack. Mirrors this file's own 12r-d E2 guard (:523).",
        raw.len()
    );
    let line_marker = ["/", "/"].concat();
    let n_line_raw = raw.matches(line_marker.as_str()).count();
    let n_line_outside = strip_rust_strings_taming(raw)
        .matches(line_marker.as_str())
        .count();
    assert_eq!(
        n_line_raw, n_line_outside,
        "rb-80 [rb80/scan-substrate] SCAN PRECONDITION: `taming.rs` spells {n_line_raw} \
         line-comment marker(s) in its raw text but only {n_line_outside} survive string \
         stripping, so at least one lives INSIDE a string literal. That is the ONE hazard the \
         strings-INTACT view used by clause T has and the house pipeline does not: \
         `strip_rust_comments` run on its own blanks from that marker to the end of the line, \
         taking real code — possibly the gate statement — with it, and clause T would then report \
         a missing tag for a reducer that carries one. Run the string stripper first (the house \
         order) or spell the marker differently."
    );
    let n_dq_raw = raw.matches(dq.as_str()).count();
    let n_dq_outside_comments = strip_rust_comments(raw).matches(dq.as_str()).count();
    assert_eq!(
        n_dq_raw, n_dq_outside_comments,
        "rb-80 [rb80/scan-substrate] SCAN PRECONDITION: `taming.rs` spells {n_dq_raw} double \
         quote(s) in its raw text but only {n_dq_outside_comments} of them survive comment \
         stripping, so at least one lives INSIDE A COMMENT. THIS FILE STRIPS STRINGS BEFORE \
         COMMENTS (`stripped_taming_for_scan`, :277-279), so a comment carrying an ODD number of \
         quotes opens a PHANTOM STRING LITERAL in `strip_rust_strings_taming`, which then blanks \
         every byte — NEWLINES INCLUDED — up to the next quote anywhere in the file. Two such \
         comments make all the code between them vanish leaving NO RESIDUE: no line-comment \
         marker, no brace, no unpaired block comment, nothing for any other precondition here to \
         trip on. The gate statement, the frozen prefix above it and every early exit below it \
         would simply not be in the text, and clause P and the return census would be reporting \
         about a haystack that was blanked out from under them. MEASURED 68 == 68 on the shipped \
         file. The remedy is to move the quote out of the comment (backticks read better in prose \
         anyway) or to teach this file's pipeline comments-before-strings; never delete this \
         check, and never satisfy it by deleting the clauses it protects."
    );
}

/// The FROZEN statement prefix above `grant_bait`'s deletion gate: comments
/// stripped, string literals AND their delimiters blanked, all whitespace
/// removed.
///
/// HAND-DERIVED, NEVER READ FROM THE FILE (ADR-0250 D4, PRV1-9). `grant_bait`
/// has NO standing guard at all — no joined check, no ownership check — so
/// "immediately after standing is established" degenerates to "immediately after
/// the caller binding", and the whole prefix is ONE statement. That is why this
/// site has no above-the-gate ordering anchor: an equality against a one-statement
/// literal is strictly stronger than any anchor, because it refuses a statement
/// nobody thought to enumerate. Compared by EQUALITY, never
/// `starts_with`/`contains`.
fn rb80_grant_bait_prefix() -> String {
    concat!("letme=ctx.sen", "der();").to_string()
}

/// Assert that `fn_name`'s body in `taming.rs` carries the deletion gate exactly
/// once, as a reachable top-level `?`-propagating statement that nothing above it
/// can skip, with the FROZEN prefix above it and the ordering anchors below it.
///
/// A per-file copy of the `economy_tests.rs` helper of the same shape: every
/// `*_tests.rs` is a `cfg(test)` submodule of its own production file and none
/// can reach another's bare `fn` items, so sharing would need a new
/// `pub(crate) mod`. EVERY clause is required and NONE may be relaxed to make a
/// build green — a pin that cannot be satisfied is a plan defect, to be
/// re-derived from ADR-0250 and the spec. Clause A reports FIRST because it is
/// the security claim, and under first-failure-wins every clause after it is
/// meaningless while the gate is absent.
fn rb80_assert_gate_pinned(
    fn_name: &str,
    expected_prefix: &str,
    ties: &[(&str, usize)],
    above: &[(&str, &str)],
    below: &[(&str, &str)],
) {
    // --- Clause 0b/0c: the substrate landmines, on the RAW file --------------
    rb80_assert_scan_substrate(MODULE_SOURCE);

    // --- Clause 0a: exactly ONE declaration to scan, paren-free --------------
    let squashed_file = stripped_taming_for_scan(MODULE_SOURCE);
    let paren_free = ["fn", fn_name].concat();
    let n_decl = squashed_file.matches(paren_free.as_str()).count();
    assert_eq!(
        n_decl, 1,
        "rb-80 [rb80/twin] SCAN PRECONDITION: the squashed, paren-free declaration bytes of \
         `{fn_name}` occur {n_decl} time(s) in `taming.rs` and must occur EXACTLY once. MORE THAN \
         ONE means a second declaration whose NAME EXTENDS this one's exists in the file; \
         `extract_fn_body` takes the FIRST hit, so a twin above would hand every clause below a \
         gate-less body that passes and says nothing about the reducer clients call. ZERO means \
         the reducer was renamed or removed and every pin scoped to it is vacuous — re-derive \
         them from ADR-0250, never by relaxing this count."
    );

    // --- Clause A: the gate statement is present EXACTLY once ----------------
    let body = rb80_scan_body(fn_name);
    let (plain, trailing) = rb80_gate_needles();
    let n_gate = body.matches(plain.as_str()).count() + body.matches(trailing.as_str()).count();
    let head: String = body.chars().take(320).collect();
    assert_eq!(
        n_gate, 1,
        "rb-80 [rb80/gate-count] E1 FAIL: `{fn_name}` contains {n_gate} deletion-gate \
         statement(s) and must contain EXACTLY ONE. ZERO IS THE RED STATE AT HEAD — the gate has \
         not been wired into this reducer yet, so a mid-grace or terminal account can still mint \
         itself up to 99 items per call into an `inventory` the cascade is about to erase, in the \
         dev wasm CI builds and publishes for the e2e suite. The needle is the FULLY QUALIFIED \
         call ending in `?;`, in either the inline or the trailing-comma form, so an unqualified \
         call reached through an import — behaviourally identical, and therefore invisible to the \
         executed matrix beside this test — reads as ZERO here. So does a discarded verdict \
         (`let _ = ..`, `.ok();`), which compiles, lints clean under -D warnings and gates \
         nothing. TWO means a duplicate, under which every ordering clause anchors on a first hit \
         a second call can sit behind. Body (first 320 chars):\n{head}"
    );

    let gate_at = body
        .find(plain.as_str())
        .or_else(|| body.find(trailing.as_str()))
        .expect("rb-80: the gate statement counted 1 but could not be located");

    // --- Clause C: the gate sits at the body's TOP level ---------------------
    let open = char::from(0x7Bu8);
    let close = char::from(0x7Du8);
    let opens = body[..gate_at].matches(open).count();
    let closes = body[..gate_at].matches(close).count();
    assert_eq!(
        opens, closes,
        "rb-80 [rb80/depth] E1 FAIL (unconditional): the deletion gate in `{fn_name}` sits at \
         brace depth {opens} minus {closes} — INSIDE a nested block — and must sit at the body's \
         top level. A gate wrapped in a never-satisfied condition, a loop or a match arm no real \
         call enters leaves every text needle here satisfied while the reducer decides nothing. \
         This is the shape a whole-body `contains` check cannot see."
    );

    // --- Clause D: the gate is its own statement, not an attributed one ------
    let semi = char::from(0x3Bu8);
    let prev = body[..gate_at].chars().next_back();
    assert!(
        prev.is_none_or(|c| c == semi || c == close),
        "rb-80 [rb80/boundary] E1 FAIL: in `{fn_name}` the deletion gate is preceded by {prev:?}, \
         which is not a statement boundary (a semicolon, a closing brace, or the start of the \
         body). THE CASE THIS EXISTS FOR: a conditional-compilation attribute on the gate \
         statement leaves a closing square bracket here — and in THIS reducer that shape is \
         especially plausible, because the whole item is already behind a feature attribute, so a \
         second one on the gate statement reads like more of the same while making the gate \
         present in review and absent in the wasm CI publishes. The same clause kills a discarded \
         binding (an equals sign), a combinator that swallows the verdict (a dot) and a macro that \
         swallows the whole call (an open paren). Re-derive the placement from ADR-0250 D4."
    );

    // --- Clause E: no conditional compilation anywhere in the body -----------
    let attr_open = ["#", "["].concat();
    let cfg_macro = ["cfg", "!("].concat();
    for needle in [attr_open.as_str(), cfg_macro.as_str()] {
        let n = body.matches(needle).count();
        assert_eq!(
            n, 0,
            "rb-80 [rb80/cfg] E1 FAIL: `{fn_name}` contains {n} occurrence(s) of {needle} and \
             must contain ZERO. The feature attribute that gates this whole reducer is on the \
             ITEM, outside the body, which is exactly why a body-scoped ban on a SECOND \
             conditional-compilation switch is still meaningful here: it is the one place a gate \
             can be made to vanish from the dev wasm while every other clause stays green. Green \
             at HEAD; keep it that way. NOTE this clause is BODY-scoped and cannot see a \
             FILE-scope switch; the cfg census in \
             `rb80_taming_reducer_roster_and_open_writers_are_pinned` is what closes that."
        );
    }

    // --- Clause F: exactly ONE mention of the wrapper, by bare name ----------
    let bare = rb80_gate_bare_name();
    let n_bare = body.matches(bare.as_str()).count();
    assert_eq!(
        n_bare, 1,
        "rb-80 [rb80/bare-name] E1 FAIL (caller-only): `{fn_name}` mentions the deletion-gate \
         wrapper {n_bare} time(s) by BARE NAME and must mention it EXACTLY once. WHAT TWO \
         ACTUALLY IS: clause A already pins the fully-qualified `?;` STATEMENT at exactly one, so \
         a SECOND bare mention is a second decision path spelled some other way — an alias, a \
         re-export or a function-pointer binding of the wrapper; a local wrapper AROUND the \
         wrapper (a closure or a nested fn in this body, which clause A's statement needle walks \
         straight past); or a duplicated call whose verdict is swallowed instead of propagated \
         (`let _ = ..`, `.ok();`, a call inside a closure). NOT the identity-parameterised \
         sibling: ADR-0227 D2 makes THIS wrapper caller-only by SIGNATURE, and rb-76 pins the two \
         bare names prefix-free precisely so neither census inflates the other — so the sibling's \
         name does not contain this one and this clause is blind to it BY CONSTRUCTION. Its \
         containment is owned crate-wide by `guards_tests.rs`'s \
         `rb76_subject_gate_and_begin_encounter_are_contained_crate_wide` clause (a), which pins \
         that name at ZERO in every scanned module but `guards.rs` and `battle.rs`. The executed \
         matrix cannot see any of this: the native host's dummy sender is the only identity that \
         ever calls. ZERO means clause A matched a qualified call without the name, which is a \
         scan defect."
    );

    // --- Clause P: the WHOLE prefix above the gate is frozen ----------------
    let got = &body[..gate_at];
    assert_eq!(
        got, expected_prefix,
        "rb-80 [rb80/prefix] E1 FAIL: the squashed text ABOVE `{fn_name}`'s deletion gate is not \
         the frozen guard prefix.\n      Got:      {got:?}\n      Expected: {expected_prefix:?}\n \
         WHAT THIS KILLS: every statement that can run before a caller reaches the gate — the \
         seven CI-clean survivors rb-79 measured, enumerated once in ADR-0249 D2, each of which \
         keeps the gate statement, its `?`, its depth, its tag and rb-46's textual return census \
         byte-identically green. This reducer has no standing guard of its own, so the frozen \
         prefix is ONE statement and this equality is the whole above-the-gate claim. \
         RE-DERIVATION CONTRACT: the literal comes from ADR-0250 D4 and PRV1-9. NEVER paste the \
         current body in to make it green, and never relax the equality to `starts_with` or \
         `contains` — both readmit every survivor ADR-0249 D2 names."
    );

    // --- Clause P's runtime ties, on the FROZEN literal ---------------------
    for &(needle, want) in ties {
        let n = expected_prefix.matches(needle).count();
        assert_eq!(
            n, want,
            "rb-80 [rb80/tie] E1 FAIL: the frozen prefix for `{fn_name}` contains `{needle}` {n} \
             time(s) and the derivation requires {want}. THIS CLAUSE GUARDS ONE FAILURE MODE: a \
             literal regenerated from a body somebody already changed, which would turn the \
             strongest pin in this slice into a photograph of the defect. The ties are spelled \
             from a THIRD set of split points on purpose. Re-derive from ADR-0250 D4, never from \
             the file."
        );
    }

    // --- Clause R: every early exit in the WHOLE body is a rejection ---------
    let return_kw = concat!("ret", "urn");
    let return_err = concat!("ret", "urnErr(");
    let n_return = body.matches(return_kw).count();
    let n_return_err = body.matches(return_err).count();
    assert_eq!(
        n_return, n_return_err,
        "rb-80 [rb80/early-exit] E1 FAIL: `{fn_name}` contains {n_return} early exit(s) but only \
         {n_return_err} of them return an `Err`. Every early exit in a gated reducer must be a \
         REJECTION; one that returns anything else routes the caller AROUND the rest of the body, \
         and clause P only constrains the region ABOVE the gate — this is the BELOW-gate half \
         (registered as R-rb-80-BELOWGATE for the delegation shape a write-verb census, not a \
         return census, is what catches). HONEST LIMIT: a `macro_rules!` expanding to a \
         conditional return contains no textual `return` and evades this clause — that is rb-78's \
         crate-wide grammar (ADR-0248), which refuses every bang macro between the item boundary \
         and the gate. Never widen the needle to make this green."
    );

    // --- Clause G: every ordering anchor occurs EXACTLY once -----------------
    // --- Clause H: above < gate < below, in the listed order -----------------
    let mut cursor = 0usize;
    for &(needle, role) in above {
        let n = body.matches(needle).count();
        assert_eq!(
            n, 1,
            "rb-80 [rb80/anchor] E1 FAIL (anti-vacuity): the anchor `{needle}` — {role} — occurs \
             {n} time(s) in `{fn_name}` and must occur EXACTLY once."
        );
        let at = body
            .find(needle)
            .unwrap_or_else(|| panic!("rb-80: anchor `{needle}` counted 1 but was not located"));
        assert!(
            cursor <= at && at < gate_at,
            "rb-80 [rb80/order] E1 FAIL (placement): in `{fn_name}` the anchor `{needle}` — \
             {role} — is at offset {at}, not between the previous anchor ({cursor}) and the \
             deletion gate ({gate_at})."
        );
        cursor = at;
    }
    cursor = gate_at;
    for &(needle, role) in below {
        let n = body.matches(needle).count();
        assert_eq!(
            n, 1,
            "rb-80 [rb80/anchor] E1 FAIL (anti-vacuity): the anchor `{needle}` — {role} — occurs \
             {n} time(s) in `{fn_name}` and must occur EXACTLY once. With zero the landmark this \
             pin orders the gate against is gone and the ordering claim is vacuous; with two the \
             comparison depends on which copy is found first."
        );
        let at = body
            .find(needle)
            .unwrap_or_else(|| panic!("rb-80: anchor `{needle}` counted 1 but was not located"));
        assert!(
            cursor < at,
            "rb-80 [rb80/order] E1 FAIL (decision before irreversible effect): in `{fn_name}` the \
             anchor `{needle}` — {role} — is at offset {at}, at or BEFORE the previous landmark \
             ({cursor}); the deletion gate is at {gate_at}. A gate that runs after the stack has \
             been credited gates nothing: the transaction still rolls back on the reject, but the \
             reducer has reordered its own guards so a later refactor — or a partial-failure path \
             — commits an item grant for an account that may not open new commitments. The \
             executed matrix cannot see this: the native host aborts the process on any write \
             syscall, so it never reaches the grant at all."
        );
        cursor = at;
    }

    // --- Clause T: the tag is this reducer's own fn name ---------------------
    let dq = char::from(0x22u8).to_string();
    let tagged = [
        rb80_gate_opener().as_str(),
        "ctx,",
        dq.as_str(),
        fn_name,
        dq.as_str(),
        ")?;",
    ]
    .concat();
    let tagged_wrapped = [
        rb80_gate_opener().as_str(),
        "ctx,",
        dq.as_str(),
        fn_name,
        dq.as_str(),
        ",)?;",
    ]
    .concat();
    let intact = rb80_intact_body(fn_name);
    let n_tag =
        intact.matches(tagged.as_str()).count() + intact.matches(tagged_wrapped.as_str()).count();
    assert_eq!(
        n_tag, 1,
        "rb-80 [rb80/tag] E1 FAIL: on the strings-INTACT view `{fn_name}` carries {n_tag} gate \
         call(s) tagged with its OWN function name and must carry exactly one. The tag is the only \
         thing that names the refusing reducer in `log_reject`'s structured warn — and this body \
         already passes its own name to `log_reject` twice, so a copy-pasted tag here would make \
         the gate's warn disagree with the two beside it. No other clause in this slice can see \
         it: the view every other clause runs on has the string payload blanked."
    );
}

/// **E1 (source)** — `grant_bait` carries the para-4.7 deletion gate, in the
/// house spelling, at depth zero, with NOTHING above it but the caller binding,
/// and above the `grant_item` credit.
///
/// NOT `cfg(feature = "dev_reducers")`: this is a text scan of
/// `include_str!("taming.rs")`, so it runs — and must run — in the DEFAULT build
/// too. That matters: the feature is off by default, so a default-feature test
/// run is the only place most contributors would ever see this gate break, and a
/// cfg-gated source pin would be silent exactly there.
///
/// RED AT HEAD on clause `[rb80/gate-count]`: `grant_bait` carries no deletion
/// gate, so the count is ZERO.
///
/// kills: M4 (the dropped `grant_bait` gate) · M5 (`let _ = ..` discard) · M7
/// (the gate moved below `grant_item`) · M8 (a conditional-compilation attribute
/// on the gate statement — clauses D and E, the likeliest shape here because the
/// item already carries one) · M9 (an unqualified, import-shadowed call) ·
/// M10 (a duplicate gate) · M6 (a copy-pasted tag — clause T) · M13/M15/M16 (a
/// sender-keyed early `Ok`, a rejection-SHAPED `return Err(e);` and a
/// wild-sentinel shadow above the gate — clause P, which for this one-statement
/// prefix is an exact equality).
#[test]
fn rb80_grant_bait_carries_the_deletion_gate() {
    let name = concat!("grant_", "bait");
    let expected = rb80_grant_bait_prefix();
    let open = char::from(0x7Bu8).to_string();
    let close = char::from(0x7Du8).to_string();
    // Eight ties, not ten. The frozen literal is ONE 19-byte statement, so the
    // two DB-lookup rows the sibling sites carry cannot occur in it at any count
    // — 28 and 46 bytes — and the transposition they nominally guarded is caught
    // twice over by the brace and rejection rows below, which fire on both
    // sibling literals. The SIX zero-rows that remain are not decoration: the
    // threat this clause names is a literal REGENERATED from an altered body, and
    // each of them fires on one — a crate path (a sender-keyed early `Ok`, a
    // wild-sentinel shadow), a brace pair (any inserted block), a rejection-shaped
    // early exit, a second fallible call. Here clause P is an equality against one
    // statement, so these six are the whole defence against a re-photographed
    // literal.
    let ties: [(&str, usize); 8] = [
        (concat!("let", "me="), 1),
        (concat!("ctx.", "sender()"), 1),
        (concat!("returnErr", "("), 0),
        (concat!(".to_string", "());"), 0),
        (concat!("c", "rate::"), 0),
        (concat!("?", ";"), 0),
        (open.as_str(), 0),
        (close.as_str(), 0),
    ];
    let below: [(&str, &str); 2] = [
        (
            concat!("item_row().id().", "find(item_id)"),
            "the item-content lookup (taming.rs:286) — the first DB read, and the first thing \
             that must run AFTER the gate",
        ),
        (
            concat!("grant_", "item("),
            "the inventory credit (taming.rs:297) — the irreversible ERASE-table effect the whole \
             ordering exists to sit above, and the ONE `grant_item` call E1's misattributed \
             'recruit grant_item path' actually refers to",
        ),
    ];
    rb80_assert_gate_pinned(name, expected.as_str(), &ties, &[], &below);
}

/// Every `fn` name that carries a BARE reducer attribute in `squashed`, in file
/// order: after each attribute occurrence, skip to the next `fn` token and take
/// the identifier up to its opening paren.
///
/// A parse, not a needle list: the SET it returns is compared against the
/// hand-written roster, so a reducer ADDED to this file without a gate decision
/// reds the census instead of slipping in behind a per-name pin nobody wrote.
fn rb80_reducer_names(squashed: &str) -> Vec<String> {
    let attr = concat!("#[spacetimedb", "::reducer]");
    let fn_kw = concat!("f", "n");
    let lparen = char::from(0x28u8);
    let mut out: Vec<String> = Vec::new();
    for (at, _) in squashed.match_indices(attr) {
        let rest = &squashed[at + attr.len()..];
        let Some(kw) = rest.find(fn_kw) else {
            continue;
        };
        let after = &rest[kw + fn_kw.len()..];
        let Some(paren) = after.find(lparen) else {
            continue;
        };
        out.push(after[..paren].to_string());
    }
    out
}

/// **E1 (the second arm, mechanically)** — `taming.rs` carries EXACTLY ONE
/// deletion gate, its reducer roster is closed, its conditional-compilation
/// surface is exactly the three attributes the dev-reducer gate needs, its
/// ERASE-table write verbs are the ones this slice reasoned about, and
/// `attempt_recruit` keeps exactly the one bait burn its PRV1-10 classification
/// is argued from.
///
/// `attempt_recruit` is CLASSIFIED OPEN (PRV1-10, ADR-0250 D6)
/// because its bait `consume_one` and its success-path monster insert happen
/// INSIDE an already-open wild battle behind the ownership and `Ongoing` guards
/// — the `submit_attack` / `use_battle_item` class (`battle.rs:1063`'s
/// `consume_one` is ungated for the same reason, and rb-46's census refuses to
/// gate in-battle reducers), and the cascade erases the monster rows anyway
/// (PRV1-6b). Pinning the burn COUNT is what keeps that argument honest: a second
/// `consume_one` in that body would be a bait burn on a path the PRV1-10 argument
/// never covered.
///
/// RED AT HEAD on clause `[rb80/file-count]`: the file mentions the wrapper ZERO
/// times.
///
/// kills: M19 (a gate quietly added to `attempt_recruit` — the file count goes to
/// 2, and gating an in-battle action is the PRV1-10 violation ADR-0250 D6 argues
/// against) · a gate hoisted into a file-local helper (same count) · M17 (a
/// wire-name twin over an ungated fn while the gated Rust item is demoted — the
/// attribute counts disagree and the name SET changes) · M14 (a file-scope
/// `cfg(debug_assertions)` constant pair, or a fourth `#[cfg]` that takes the
/// gate out of the dev wasm — clause E is body-scoped and cannot see either) ·
/// M18 (a below-gate `if me != WILD { twin() } else { .. }` that duplicates the
/// credit — the write-verb census counts 2 `grant_item(`).
#[test]
fn rb80_taming_reducer_roster_and_open_writers_are_pinned() {
    rb80_assert_scan_substrate(MODULE_SOURCE);
    let squashed = stripped_taming_for_scan(MODULE_SOURCE);

    // --- (a) the file-wide bare-name count ----------------------------------
    let bare = rb80_gate_bare_name();
    let n_bare = squashed.matches(bare.as_str()).count();
    assert_eq!(
        n_bare, 1,
        "rb-80 [rb80/file-count] E1 FAIL: `taming.rs` mentions the deletion-gate wrapper {n_bare} \
         time(s) by BARE NAME and must mention it EXACTLY once — `grant_bait`'s call and nothing \
         else. ZERO IS THE RED STATE AT HEAD. TWO means either `attempt_recruit` was gated \
         without re-arguing its PRV1-10 classification (gating an action INSIDE an already-open \
         battle is what PRV1-10 forbids, and it would trap the player in a battle they cannot \
         finish) or the gate was hoisted into a file-local helper where no per-body pin can see \
         it. The needle is the BARE name, so it also catches an alias, a re-export and a \
         function-pointer binding."
    );

    // --- (b0) the file's WHOLE attribute budget -----------------------------
    let attr_open = ["#", "["].concat();
    let n_attrs = squashed.matches(attr_open.as_str()).count();
    assert_eq!(
        n_attrs, 6,
        "rb-80 [rb80/attr-budget] E1 FAIL: `taming.rs` carries {n_attrs} attribute opener(s) and \
         must carry exactly SIX. WHY A TOTAL AND NOT JUST THE ROSTER: the roster clauses below \
         key on the LITERAL `spacetimedb`-qualified attribute text, and four measured spellings \
         publish a client-callable reducer while counting ZERO there — the attribute imported by \
         name, the crate aliased on its `use` line, the attribute renamed inside a braced import, \
         and a NEIGHBOURING macro that is not `reducer` at all. Every one of them needs an \
         attribute opener, so a fifth entry point cannot be added without moving this number. THE \
         BUDGET IS FULLY ACCOUNTED, which is what stops it being balanced by a deletion: three \
         `cfg` attributes (clause (c) pins that count exactly), two bare reducer attributes \
         (clause (b)), and the ONE `path` attribute that wires this test module to its file — \
         delete that and this census stops being compiled at all. GREEN AT HEAD and after the \
         fix: an anti-bypass clause, not part of this slice's RED."
    );

    // --- (b) the reducer roster is closed -----------------------------------
    let attr_bare = concat!("#[spacetimedb", "::reducer]");
    let attr_any = concat!("#[spacetimedb", "::reducer");
    let n_bare_attr = squashed.matches(attr_bare).count();
    let n_any_attr = squashed.matches(attr_any).count();

    // --- (b0b) the reducer macro is reached through the crate path, nowhere else
    let path_token = ["::red", "ucer"].concat();
    let n_path_token = squashed.matches(path_token.as_str()).count();
    assert_eq!(
        n_path_token, n_bare_attr,
        "rb-80 [rb80/attr-path] E1 FAIL: `taming.rs` spells the path-qualified reducer token \
         {n_path_token} time(s) while carrying {n_bare_attr} bare reducer attribute(s); the two \
         must AGREE. Every bare attribute contains this token, so the count can only ever be \
         GREATER — which means what this clause really asserts is that the file mentions the \
         reducer macro NOWHERE ELSE: not on a `use` line that imports it by name (then \
         `#[reducer]` publishes an entry point the roster clause below cannot see), and not \
         through an aliased crate path (`#[<alias>::reducer]`, same result). The braced-rename \
         and wrong-macro spellings leave this count alone and are caught by the attribute budget \
         above instead; the two clauses are a pair and neither is redundant. GREEN AT HEAD and \
         after the fix."
    );
    assert_eq!(
        n_any_attr, n_bare_attr,
        "rb-80 [rb80/roster] E1 FAIL: `taming.rs` carries {n_any_attr} reducer attribute(s) but \
         only {n_bare_attr} of them are the BARE form. A parameterised attribute is a WIRE-NAME \
         twin: it publishes a reducer under a name clients call while the Rust item every pin in \
         this slice reads is a different, possibly gated, function (rb-79 register row M13)."
    );
    assert_eq!(
        n_bare_attr, 2,
        "rb-80 [rb80/roster] E1 FAIL: `taming.rs` carries {n_bare_attr} bare reducer attribute(s) \
         and must carry 2. Reported BEFORE the name set because it is the clearer signal and \
         because it is not implied by it: the parse below SKIPS an attribute it cannot resolve to \
         a declaration, so a third reducer written in a shape the parser walks past would leave \
         the set equal to the roster while the file published one more."
    );
    let mut got = rb80_reducer_names(squashed.as_str());
    got.sort();
    let mut want_names = vec![
        concat!("attempt_", "recruit").to_string(),
        concat!("grant_", "bait").to_string(),
    ];
    want_names.sort();
    assert_eq!(
        got, want_names,
        "rb-80 [rb80/roster] E1 FAIL: the reducers `taming.rs` publishes are {got:?} and the \
         roster this slice reasoned about is {want_names:?}. A reducer ADDED here is an \
         ERASE-table writer nobody made a gate decision about; a reducer REMOVED makes the pin \
         that names it vacuous. Both are re-derived from §4.7's trigger predicate and ADR-0250, \
         never by editing this list to match the file."
    );

    // --- (c) the conditional-compilation surface ----------------------------
    let cfg_attr = ["#", "[cfg"].concat();
    let cfg_macro = ["cfg", "!("].concat();
    let debug_flag = ["debug_", "assertions"].concat();
    let arch_flag = ["target_", "arch"].concat();
    for (needle, want, why) in [
        (
            cfg_attr.as_str(),
            3usize,
            "EXACTLY the three the dev-reducer gate needs: the feature attribute on the \
             `grant_item` import (:18), the one on `grant_bait` itself (:280, which \
             `evals/dev-reducer-gating` requires to sit directly above the reducer attribute) \
             and the `cfg(test)` attribute on the child test module (:301). A FOURTH is the \
             shape that takes the deletion gate out of the wasm CI publishes while every \
             body-scoped clause stays green",
        ),
        (
            cfg_macro.as_str(),
            0usize,
            "the expression form of the same defect, which clause C would report only as a \
             nested block",
        ),
        (
            debug_flag.as_str(),
            0usize,
            "the measured file-scope constant pair (rb-46 clause I's second survivor): tests \
             build with debug assertions on, the shipped wasm is `--release`, so a constant \
             consulted above or below the gate is true here and false in production",
        ),
        (
            arch_flag.as_str(),
            0usize,
            "the cross-target twin of the same shape — a body selected for wasm32 that the \
             native test binary never compiles (the class ADR-0247 closes for `lib.rs`)",
        ),
    ] {
        let n = squashed.matches(needle).count();
        assert_eq!(
            n, want,
            "rb-80 [rb80/cfg-census] E1 FAIL: `taming.rs` contains `{needle}` {n} time(s) and \
             must contain {want} — {why}. Green at HEAD; keep it that way."
        );
    }

    // --- (d) the ERASE-table write verbs ------------------------------------
    for (needle, want, why) in [
        (
            concat!("grant_", "item("),
            1usize,
            "ONE inventory credit in this whole module, `grant_bait`'s (:297). A second is the \
             below-gate delegation shape: a twin that repeats the credit for every caller the \
             gate would have refused",
        ),
        (
            concat!("consume_", "one("),
            1usize,
            "ONE inventory burn, `attempt_recruit`'s bait consume (:119) — the write PRV1-10 \
             classifies as an in-battle action rather than a new commitment. A second burn \
             anywhere in this file is an ERASE-table write that argument never covered",
        ),
    ] {
        let n = squashed.matches(needle).count();
        assert_eq!(
            n, want,
            "rb-80 [rb80/write-census] E1 FAIL: `taming.rs` calls `{needle}` {n} time(s) and must \
             call it {want} — {why}. This census is what kills the in-file ungated twin: every \
             clause of the source pin above is scoped to ONE body, so a duplicated write in a \
             second function is invisible to all of them."
        );
    }

    // --- (e) attempt_recruit stays the PRV1-10 classification it claims -----
    let recruit = concat!("attempt_", "recruit");
    let recruit_body = rb80_scan_body(recruit);
    let burn = concat!("consume_", "one(");
    let n_burn = recruit_body.matches(burn).count();
    assert_eq!(
        n_burn, 1,
        "rb-80 [rb80/open-body] E1 FAIL (the deliberate classification): `attempt_recruit` burns \
         inventory {n_burn} time(s) and the body ADR-0250 D6 classified OPEN burns it exactly \
         once — the optional bait, consumed BEFORE the roll, inside an already-open wild battle \
         behind the ownership and `Ongoing` guards. That single burn is the whole PRV1-10 \
         argument for leaving this reducer ungated (`battle.rs:1063`'s `consume_one` in \
         `use_battle_item` is ungated for the identical reason). A SECOND burn would be a bait \
         spend on a path the argument never covered, and ZERO would mean the argument is about a \
         body that no longer exists — either way the classification must be re-argued in a new \
         ADR, not repaired by loosening this count."
    );
    let n_bare_in_body = recruit_body.matches(rb80_gate_bare_name().as_str()).count();
    assert_eq!(
        n_bare_in_body, 0,
        "rb-80 [rb80/open-body] E1 FAIL: `attempt_recruit` mentions the deletion-gate wrapper \
         {n_bare_in_body} time(s) and must mention it ZERO times. This is the `m22s5_already_open_\
         reducers_are_not_gated` shape: PRV1-10 says an already-live battle is never \
         force-terminated, and a gate here refuses a mid-grace player's move INSIDE a battle they \
         already opened, trapping the row until the reaper collects it. If a future slice decides \
         otherwise, it re-argues PRV1-10 in an ADR and edits this clause deliberately."
    );
}

/// **E1 (behaviour)** — `grant_bait` refuses a deletion-gated caller, ADMITS
/// everybody else, and answers from the CALLER's own row.
///
/// THE CRATE'S FIRST `cfg(feature = "dev_reducers")` TEST, because the
/// reducer it calls only exists under that feature: `cargo nextest run
/// --workspace` does not compile it, `just lint` (clippy `--all-features`) does,
/// and CI builds the dev wasm for the e2e suite. Its seed helpers are INLINED
/// rather than shared with the source tests above so the DEFAULT build carries no
/// `dead_code` under `-D warnings`. Run it with
/// `cargo nextest run -p monster-realm-module --features dev_reducers`.
///
/// Five account states with a mid-grace STRANGER row present throughout; the
/// three admitted states are the positive control and they are what make the two
/// refused states mean anything. WHY THE ADMITTED STATES ERR: `item_row` is
/// `u32`-keyed and the fixture keys rows by the indexed column, so that index is
/// never registered, an unregistered index yields no rows in this host, and the
/// reducer stops at the item lookup — ONE guard past the gate and before the
/// bait-classification check and the credit. Every write syscall ABORTS the
/// process (uncatchable), which is why this test asserts refusals and admissions
/// and nothing deeper. The ordinary error is pinned EXACTLY rather than as
/// any-error: otherwise a regression that turned the item lookup into a different
/// rejection would masquerade as a pass in all three admitted states.
///
/// RED AT HEAD on the `PendingDeletion` state: with no gate the reducer returns
/// the ordinary next-guard error there.
///
/// kills: M4 (the dropped gate) · M5 (a discarded verdict) · M8 (an unreachable
/// placement) · M11 (a constant reject in `guards` — the three admitted states) ·
/// M12 (inverted polarity, invisible to every source pin in this slice — the
/// `Active` and no-row states would return the deletion reject, which breaks
/// `client/e2e/recruit.spec.ts`, whose caller holds an Active account) · a
/// row-EXISTS-keyed fake (the `Active` state) · a TABLE-WIDE or any-row-pending
/// fake (the three admitted states, while the stranger is mid-grace) · a latched
/// or memoised answer (the removed-row state).
#[cfg(feature = "dev_reducers")]
#[test]
fn rb80_grant_bait_is_refused_only_while_the_caller_is_deletion_gated() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let call = || crate::taming::grant_bait(&ctx, 1, 1);

    let ordinary: Result<(), String> = Err("item not found".to_string());
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let active = crate::accounts::new_account_row(me, String::new(), 0);
    let pending = crate::accounts::requested_deletion(active.clone(), 1);
    let terminal = crate::accounts::terminal_account(pending.clone(), 2);

    // Inlined mid-grace STRANGER row: present in every one of the five states and
    // never removed, so the account table is never empty of deleting rows.
    // Without it a TABLE-keyed gate — refuse if ANYBODY is deleting — is
    // observationally identical to the caller-keyed one everywhere below.
    // `remove` and `find` are Identity-keyed, so this row never disturbs the
    // per-state `remove(me) == 1` assertions. Inlined rather than shared because
    // the default build compiles neither this test nor a helper it alone uses.
    let stranger = spacetimedb::Identity::from_byte_array([9u8; 32]);
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, String::new(), 0),
        1,
    ));

    // --- State 1: no account row for the caller (a guest) -------------------
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-80 E1 FAIL (admitted state, no account row): `grant_bait` returned {got:?} for a \
         caller with NO account row, while a STRANGER's row is mid-grace. A caller who never \
         authenticated is not inside the deletion gate and must be admitted into the ordinary \
         guard chain; the expected error is the item lookup's. A deletion reject here means the \
         gate answers from the TABLE rather than from the caller's own row. Indexes the generated \
         code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 2: an Active account row --------------------------------------
    acct.seed(&active);
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-80 E1 FAIL (admitted state, Active account): `grant_bait` returned {got:?} for a \
         caller whose account row is `Active` (a stranger's row is mid-grace). This is the \
         ordinary dev/e2e caller — `client/e2e/recruit.spec.ts` grants bait with an Active \
         account — and refusing them breaks the recruit e2e while every source pin in this slice \
         reports the gate as correctly wired: the call text is byte-identical whichever way the \
         decision runs. It is also exactly what a row-EXISTS-keyed fake produces, what an \
         any-row-pending TABLE scan produces, and what an inverted branch produces."
    );

    // --- State 3: mid-grace (PendingDeletion) --------------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture: exactly one `Active` account row was seeded for the CALLER and must be \
         removed before the next state is pushed — `seed` appends rather than upserting, so a \
         miscount would leave two rows for one identity and the unique-index lookup would assert \
         instead of answering. `remove` is Identity-keyed, so the stranger's row is deliberately \
         untouched and must never be counted here."
    );
    acct.seed(&pending);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-80 E1 FAIL (refused state, mid-grace): `grant_bait` returned {got:?} for a caller \
         whose account is `PendingDeletion`; it must return the module's single static deletion \
         reject. THIS IS THE RED STATE AT HEAD — at HEAD `grant_bait` carries no deletion gate, so \
         a mid-grace account can still mint itself 99 items per call into an `inventory` the \
         cascade is about to erase. The expected value is compared against the CONSTANT, never a \
         re-typed literal, so a reworded reason cannot drift silently into text no client ever \
         receives."
    );

    // --- State 4: terminal (PendingDeletion + the marker) -------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture: exactly one `PendingDeletion` account row was seeded for the CALLER and \
         must be removed before the terminal row is pushed (`seed` appends, it never upserts; the \
         stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-80 E1 FAIL (refused state, terminal): `grant_bait` returned {got:?} for a caller \
         whose account carries the M22 terminal marker. An already-erased account has no \
         inventory left — the cascade deleted it — so a grant here would recreate rows the \
         deletion just removed. The pure decision is an explicit disjunction \
         (`accounts::should_reject_for_deletion`) precisely so this state is fail-closed even on \
         the illegal `Active`-plus-marker shape."
    );

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture: exactly one terminal account row was seeded for the CALLER and must be \
         removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-80 E1 FAIL (admitted state, row removed): `grant_bait` returned {got:?} once the \
         caller's account row was gone again (the stranger's mid-grace row is still there). The \
         verdict must track LIVE rows FOR THE CALLER: an answer that latches on a row it has \
         already seen — a memoised predicate, a cached decision, a process-wide flag — would keep \
         refusing this identity forever, and an any-row-pending answer would refuse it because of \
         somebody else. No state above can distinguish either of those from a correct gate on its \
         own."
    );
}
