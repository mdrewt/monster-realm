//! `accounts_tests` — gating tests for M21a (ADR-0179, AUTH-1..38 in-scope).
//!
//! Declared from `accounts.rs` as `#[path = "accounts_tests.rs"] mod accounts_tests;`
//! so `super::` resolves to the `accounts` module: the pure decision seams,
//! constants, and the `use crate::schema::{Account, AccountStatus, GuestClaim}`
//! aliases are all reachable via `use super::*` (same pattern as economy_tests).
//!
//! There is NO way to construct a `ReducerContext` in this crate, so the split is:
//!   - every behavioural criterion that lands on a pure seam is an EXECUTED test;
//!   - every ctx-bound shell property is a SOURCE SCAN over the frozen production
//!     files (`accounts.rs`/`lib.rs`/`schema.rs`/the rekey helpers) via `include_str!`.
//!
//! SCAN HYGIENE (memory card): cross-file eval scanners concatenate every
//! `server-module/src/**` file and do NOT strip string literals. Therefore this
//! file NEVER writes a contiguous scanner needle (a table attribute macro, a
//! reducer attribute macro, the monster dual-write chain, a wallet accessor, a
//! profile insert, etc.) — every such needle is assembled at runtime via
//! `concat!` / `[..].concat()`. This file contains NO wallet token at all
//! (currency-integrity ACCESSOR_BYPASS scans every file except
//! economy.rs/schema.rs/economy_tests.rs) — wallet pure tests live in
//! economy_tests.rs, not here.
//!
//! The three-stage strip pipeline (`strip_rust_strings` -> `strip_rust_comments`
//! -> `squash_ws`) is copied from ranking_tests.rs so that string/comment content
//! in the SCANNED production file cannot create false needle matches. A second
//! pipeline (`stripped_keep_strings`) preserves string CONTENT (comments removed,
//! string-context-aware so a URL's `//` is not mistaken for a line comment) for
//! the reject-MESSAGE contract scans.
//!
//! NOTE FOR THE M21c G6 (REKEY_COMPLETENESS) AUTHOR — the four new-table
//! `Identity` columns need these manifest policies (M21a ships no G6 eval/const,
//! CUT per /simplify #7):
//!   - `account.identity`                          -> EXEMPT (destination key; a claim never re-keys an account row)
//!   - `account.claimed_from`                      -> EXEMPT (audit provenance; must survive by design, AUTH-21)
//!   - `guest_claim.guest_identity`                -> BLOCKED (consumed+deleted by consume_claim_and_disarm, AUTH-34)
//!   - `guest_claim_reaper_schedule.guest_identity` -> BLOCKED (same transaction disarm, AUTH-34)

#![cfg(test)]

use super::*;

// ===========================================================================
// Scan machinery (local copies — per-module convention, do NOT import from
// sibling _tests.rs). strings -> comments -> squash_ws.
// ===========================================================================

/// Blank the CONTENT (and delimiters) of `"..."` / `r"..."` / `r#"..."#` string
/// literals with spaces. Must run BEFORE `strip_rust_comments`. (Copy of the
/// ranking_tests.rs helper; char/byte literals such as `b'0'` are intentionally
/// not handled — accounts.rs' only relevant literals are byte-range matches that
/// contain no scanner needles.)
fn strip_rust_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;
    while i < len {
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
                        let mut closing: usize = 0;
                        while k < len && bytes[k] == b'#' && closing < hashes {
                            closing += 1;
                            k += 1;
                        }
                        if closing == hashes {
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
        }
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

/// Blank `/* ... */` and `// ...` comments with spaces. Run AFTER
/// `strip_rust_strings`.
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
    String::from_utf8(out).expect("comment-stripped source must be valid UTF-8")
}

/// Remove all whitespace (rustfmt-proof needle matching).
fn squash_ws(src: &str) -> String {
    src.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Full structural pipeline: strings blanked -> comments blanked -> whitespace
/// squashed. Use for identifier / ordering / count / write-token scans.
fn stripped_for_scan(src: &str) -> String {
    squash_ws(&strip_rust_comments(&strip_rust_strings(src)))
}

/// Remove comments but PRESERVE string-literal content, tracking string context
/// so a `//` inside a string (the ALLOWED_ISSUERS URL) is not treated as a line
/// comment. Followed by `squash_ws`, this yields a view in which reject-MESSAGE
/// text survives so the message contracts (AUTH-15/16/18/20 etc.) are scannable.
fn strip_comments_keep_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;
    while i < len {
        if bytes[i] == b'"' {
            out.push(bytes[i]);
            i += 1;
            while i < len {
                if bytes[i] == b'\\' && i + 1 < len {
                    out.push(bytes[i]);
                    out.push(bytes[i + 1]);
                    i += 2;
                } else if bytes[i] == b'"' {
                    out.push(bytes[i]);
                    i += 1;
                    break;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            continue;
        }
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).expect("comment-stripped (strings kept) source must be valid UTF-8")
}

/// Whitespace-squashed view with string content preserved (for message scans).
fn stripped_keep_strings(src: &str) -> String {
    squash_ws(&strip_comments_keep_strings(src))
}

/// Extract the brace-bounded body of a fn from an ALREADY-squashed source. Depth
/// counter over `{`/`}`. `fn_needle` is the squashed signature prefix, e.g.
/// `fnstart_guest_claim(`.
fn extract_squashed_fn_body<'a>(squashed: &'a str, fn_needle: &str) -> Option<&'a str> {
    let fn_start = squashed.find(fn_needle)?;
    let after = &squashed[fn_start..];
    let brace_rel = after.find('{')?;
    let body_start = fn_start + brace_rel + 1;
    let bytes = squashed.as_bytes();
    let mut depth: usize = 1;
    let mut i = body_start;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&squashed[body_start..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Extract the squashed signature slice (fn_needle .. first `{`).
fn extract_squashed_fn_sig<'a>(squashed: &'a str, fn_needle: &str) -> Option<&'a str> {
    let fn_start = squashed.find(fn_needle)?;
    let after = &squashed[fn_start..];
    let brace_rel = after.find('{')?;
    Some(&squashed[fn_start..fn_start + brace_rel])
}

/// First-occurrence byte index of `needle` in `hay`, or panic with context.
fn idx(hay: &str, needle: &str) -> usize {
    hay.find(needle)
        .unwrap_or_else(|| panic!("scan needle not found (expected present): {needle:?}"))
}

// Sources under test (frozen production; scans are RED under the documented
// proof-of-teeth mutations, GREEN against the correct impl).
const ACCOUNTS_RS: &str = include_str!("accounts.rs");
const LIB_RS: &str = include_str!("lib.rs");
const SCHEMA_RS: &str = include_str!("schema.rs");
const MONSTER_MGMT_RS: &str = include_str!("monster_mgmt.rs");
const RANKING_RS: &str = include_str!("ranking.rs");

// Squashed fn-needle fragments, split mid-token so this file never self-matches
// if it is itself ever concatenated into a scan.
fn nd_complete() -> String {
    concat!("fncomplete_guest", "_claim(").to_string()
}
fn nd_start() -> String {
    concat!("fnstart_guest", "_claim(").to_string()
}
fn nd_provision() -> String {
    concat!("fnprovision_or_touch", "_account(").to_string()
}
fn nd_reaper() -> String {
    concat!("fnguest_claim", "_reaper(").to_string()
}

/// The exact set of tables `accounts.rs` may WRITE (D0 write-isolation).
///
/// FOUR as of rb-24 (M22 S3, spec para 4.4): the deletion reaper OWN schedule
/// table is colocated in this module under the ADR-0056 exception, exactly as
/// `guest_claim_reaper_schedule` is, so `arm_deletion_reaper` and
/// `disarm_deletion_reaper` write it directly rather than through an owning
/// module. Widening an allowlist can only ever LOOSEN a gate, so the widening is
/// paid for twice: `rb24_owned_write_set_covers_the_deletion_schedule` proves
/// the new entry is EXERCISED by a real write in accounts.rs, and
/// `rb24_schedule_table_sole_writers` proves every such write lives inside one
/// of the two reviewed helper bodies. The JS twin of this list —
/// `OWNED_TABLES` in `evals/guest-claim-integrity.eval.mjs` — must be widened in
/// the SAME commit or its [W/write-target] clause reds on the sanctioned arm.
fn allowed_write_tables() -> [String; 4] {
    [
        "account".to_string(),
        concat!("guest", "_claim").to_string(),
        concat!("guest_claim_reaper", "_schedule").to_string(),
        concat!("account_deletion_reaper", "_schedule").to_string(),
    ]
}

// ===========================================================================
// G2 SOURCE-DERIVED REDUCER ENUMERATION (ADR-0195 D6) — the Rust port of
// `evals/guest-claim-integrity.eval.mjs`'s `parseReducers`,
// `parseScheduledTargets`, `isWireSafeType` and `checkNoClientIdentity`.
//
// WHY A PORT AND NOT A NEEDLE LIST: the shipped G2 mirror iterated FIVE
// hardcoded reducer needles, so an ADDED reducer was invisible to it — which is
// precisely the shape of both PROVEN account-takeover bypasses:
//   E1  a struct-wrapped Identity (`ClaimTarget { guest_identity: Identity }`)
//       passed as a reducer argument. It declares no `: Identity` parameter, so
//       a substring ban is green on it.
//   E2  a wire-safe `String` parameter plus an `Identity::from_hex` call in the
//       body. A parameter-type analysis alone never sees it.
// Both compile and pass `clippy --all-targets -D warnings`. The defense is
// therefore a POSITIVE wire-safe-scalar allowlist plus an Identity-constructor
// ban plus an EXACT name-set pin — never "the type text contains Identity".
//
// EVERYTHING BELOW RUNS OVER `stripped_for_scan` OUTPUT: strings blanked ->
// comments blanked -> ALL whitespace squashed. So the `spacetimedb::reducer`
// attribute reads as one contiguous token and a parameter reads `name:&Type`.
// The one place this matters structurally is the `fn` token walk: whitespace
// squashing fuses `pub fn` into `pubfn`, so a naive word-boundary test would
// reject every `pub` reducer in the tree (see `is_fn_token_at`).
// ===========================================================================

/// Is `b` a Rust identifier byte? (Word-boundary tests over squashed source.)
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Is `c` a Rust identifier char?
fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Does a standalone `fn` TOKEN start at byte `k` of an already-squashed source?
///
/// Two conditions, and the first is not decoration:
///   - a word char must FOLLOW `fn` (the function's name). This is what rejects
///     the fn-POINTER type form `handler:fn(u8)->u8`, whose `fn` is followed by
///     `(`;
///   - the preceding byte must not be a word char — EXCEPT for the `pub`
///     visibility keyword, which whitespace squashing has fused onto the front
///     (`pub fn` -> `pubfn`). Missing that exception would make this enumerator
///     see zero reducers in the live tree and report "clean" about nothing.
fn is_fn_token_at(squashed: &str, k: usize) -> bool {
    let bytes = squashed.as_bytes();
    if k + 2 >= bytes.len() || !is_word_byte(bytes[k + 2]) {
        return false;
    }
    if k == 0 || !is_word_byte(bytes[k - 1]) {
        return true;
    }
    let before = &squashed[..k];
    before.ends_with("pub") && (before.len() == 3 || !is_word_byte(bytes[before.len() - 4]))
}

/// Every `spacetimedb::reducer`-attributed fn in an already-squashed source, as
/// `(fn name, [(param name, param type)])`.
///
/// PARAMS ONLY: the walk stops at the balanced close of the parameter list, so a
/// return type is out of scope — return values are not client input, which is
/// exactly the scope the JS twin uses.
///
/// TOLERANT walk-forward to the next `fn` token: stacked attributes between the
/// reducer attribute and the fn are LEGAL and precedented (`trading.rs` stacks
/// `#[allow(clippy::too_many_arguments)]` on a reducer), so requiring "nothing
/// but optional `pub`" would false-RED on arrival. Parity with `parseReducers`.
///
/// FAIL-LOUD, never `continue` (ADR-0195 D7): an attribute with no following
/// `fn`, or an unbalanced parameter list, PANICS. Refusing to classify is the
/// safe direction — an unparsed reducer is an UNGATED reducer.
fn parse_reducers(squashed: &str) -> Vec<(String, Vec<(String, String)>)> {
    const ATTR: &str = concat!("#[spacetimedb::", "reducer");
    let bytes = squashed.as_bytes();
    let mut out: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let mut pos = 0usize;
    while let Some(rel) = squashed[pos..].find(ATTR) {
        let at = pos + rel;
        pos = at + ATTR.len();
        // Parity with parseReducers' `]`/`(` guard: accept ONLY the bare
        // `spacetimedb::reducer` attribute and its parenthesised
        // `spacetimedb::reducer(..)` form, never a longer identifier that merely
        // STARTS with `reducer`.
        let after = bytes.get(pos).copied();
        if after != Some(b']') && after != Some(b'(') {
            continue;
        }

        let mut fn_at: Option<usize> = None;
        let mut k = pos;
        while k + 1 < bytes.len() {
            if bytes[k] == b'f' && bytes[k + 1] == b'n' && is_fn_token_at(squashed, k) {
                fn_at = Some(k);
                break;
            }
            k += 1;
        }
        let fn_at = fn_at.unwrap_or_else(|| {
            panic!(
                "G2 PARSE FAIL: the reducer attribute at byte {at} of the squashed \
                 source is not followed by any `fn` token. Refusing to classify is \
                 the fail-loud direction: an unparsed reducer is an UNGATED reducer."
            )
        });

        let name_start = fn_at + 2;
        let mut name_end = name_start;
        while name_end < bytes.len() && is_word_byte(bytes[name_end]) {
            name_end += 1;
        }
        let name = squashed[name_start..name_end].to_string();
        assert!(
            !name.is_empty(),
            "G2 PARSE FAIL: a reducer's `fn` token at byte {fn_at} is followed by no \
             name — an unparsed reducer is an UNGATED reducer."
        );

        let open = squashed[name_end..]
            .find('(')
            .map(|r| name_end + r)
            .unwrap_or_else(|| {
                panic!(
                    "G2 PARSE FAIL: reducer `{name}` has no parameter list at all — \
                     refusing to classify it as parameterless."
                )
            });
        let mut depth: usize = 0;
        let mut close: Option<usize> = None;
        for (off, ch) in squashed[open..].char_indices() {
            if ch == '(' {
                depth += 1;
            } else if ch == ')' {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + off);
                    break;
                }
            }
        }
        let close = close.unwrap_or_else(|| {
            panic!(
                "G2 PARSE FAIL: reducer `{name}`'s parameter list has UNBALANCED \
                 parens — the scan cannot say what it takes from the wire, so it \
                 must not say `clean` either."
            )
        });

        let mut params: Vec<(String, String)> = Vec::new();
        for seg in split_param_list(&squashed[open + 1..close]) {
            params.push(split_param_name_and_type(&seg));
        }
        out.push((name, params));
    }
    out
}

/// Split a squashed parameter list at DEPTH-0 commas.
///
/// An EMPTY trailing segment is skipped: rustfmt writes a trailing comma into
/// every wrapped signature, and `guest_claim_reaper`'s signature is wrapped in
/// the live tree today — without the skip its parameter list parses as
/// `[ctx, args, <empty>]` and the empty segment is classified as a non-scalar
/// parameter, false-REDing the gate on arrival.
///
/// Angle depth is tracked alongside paren/bracket depth (a `-` before `>` is the
/// `->` arrow, not a close) so a generic parameter type is never split at a
/// comma INSIDE its type arguments. Braces are deliberately NOT tracked: a Rust
/// parameter type cannot contain one, and this file's scan hygiene forbids
/// spelling a brace char literal.
fn split_param_list(inner: &str) -> Vec<String> {
    let bytes = inner.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut depth: i32 = 0;
    let mut angle: i32 = 0;
    let mut last = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b'<' => angle += 1,
            b'>' => {
                if i == 0 || bytes[i - 1] != b'-' {
                    angle = (angle - 1).max(0);
                }
            }
            b',' if depth == 0 && angle == 0 => {
                out.push(inner[last..i].to_string());
                last = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(inner[last..].to_string());
    out.retain(|seg| !seg.is_empty());
    out
}

/// Split one squashed parameter segment into `(name, type)` at the FIRST
/// depth-0 colon that is not part of a `::` path separator. A segment with no
/// such colon yields `(text, text)` — JS parity, and it keeps an unparseable
/// segment VISIBLE to the wire-safe allowlist instead of dropping it.
fn split_param_name_and_type(seg: &str) -> (String, String) {
    let bytes = seg.as_bytes();
    let mut depth: i32 = 0;
    let mut angle: i32 = 0;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b'<' => angle += 1,
            b'>' => {
                if i == 0 || bytes[i - 1] != b'-' {
                    angle = (angle - 1).max(0);
                }
            }
            b':' if depth == 0 && angle == 0 => {
                if i + 1 < bytes.len() && bytes[i + 1] == b':' {
                    i += 2;
                    continue;
                }
                return (seg[..i].to_string(), seg[i + 1..].to_string());
            }
            _ => {}
        }
        i += 1;
    }
    (seg.to_string(), seg.to_string())
}

/// Is this parameter type a wire-safe scalar, recursing through `Option<..>` and
/// `Vec<..>`?
///
/// A POSITIVE allowlist is the whole point (ADR-0195 D6): "the type text
/// contains Identity" misses E1's `ClaimTarget` and any type ALIAS
/// (`type Ident = Identity;` -> `guest: Ident`) by construction, while the
/// allowlist rejects every composite with one rule.
fn is_wire_safe_type(ty: &str) -> bool {
    const WIRE_SCALARS: [&str; 14] = [
        "String", "bool", "u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128",
        "f32", "f64",
    ];
    let t: String = ty.chars().filter(|c| !c.is_whitespace()).collect();
    if WIRE_SCALARS.contains(&t.as_str()) {
        return true;
    }
    for wrapper in ["Option<", "Vec<"] {
        if t.starts_with(wrapper) && t.ends_with('>') {
            return is_wire_safe_type(&t[wrapper.len()..t.len() - 1]);
        }
    }
    false
}

/// Every `scheduled(<reducer>)` table declared in an already-squashed source,
/// mapped to the struct name that follows it: `(reducer name, struct name)`.
///
/// Only a SAME-FILE scheduled table can justify a struct-typed reducer argument
/// — its `Identity` fields are written by the scheduler, not by a client.
fn parse_scheduled_targets(squashed: &str) -> Vec<(String, String)> {
    const ATTR: &str = concat!("#[spacetimedb::", "table(");
    const SCHED: &str = concat!("sched", "uled(");
    const STRUCT: &str = concat!("pub", "struct");
    let mut out: Vec<(String, String)> = Vec::new();
    let mut pos = 0usize;
    while let Some(rel) = squashed[pos..].find(ATTR) {
        let at = pos + rel;
        pos = at + ATTR.len();
        // The `(` of `table(` is the last byte of ATTR.
        let open = at + ATTR.len() - 1;
        let mut depth: usize = 0;
        let mut close: Option<usize> = None;
        for (off, ch) in squashed[open..].char_indices() {
            if ch == '(' {
                depth += 1;
            } else if ch == ')' {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + off);
                    break;
                }
            }
        }
        let Some(close) = close else { continue };
        let attr_args = &squashed[open + 1..close];
        let Some(sched_rel) = attr_args.find(SCHED) else {
            continue;
        };
        let reducer: String = attr_args[sched_rel + SCHED.len()..]
            .chars()
            .take_while(|c| is_word_char(*c))
            .collect();
        if reducer.is_empty() {
            continue;
        }
        let Some(struct_rel) = squashed[close..].find(STRUCT) else {
            continue;
        };
        let s = close + struct_rel + STRUCT.len();
        let struct_name: String = squashed[s..]
            .chars()
            .take_while(|c| is_word_char(*c))
            .collect();
        out.push((reducer, struct_name));
    }
    out
}

/// The scheduler guard, pinned as a REJECTING EARLY RETURN rather than as a bare
/// comparison, in squashed form.
///
/// The eval's adversarial pass found the carve-out was satisfied by
/// `let scheduler_only = ctx.sender() != ctx.database_identity(); let _ = scheduler_only;`
/// — which contains the comparison, compiles, is clippy-clean, and rejects
/// NOBODY, so any client can invoke the scheduled reducer with a hand-built row
/// naming any victim identity. `{return` rather than `{returnErr(` so a future
/// refactor to the equally valid silent-ignore `return Ok(());` form does not
/// false-RED.
///
/// SDK 2.x spelling (ADR-0197): `sender` is a METHOD (`ctx.sender()`), and the
/// module identity is `ctx.database_identity()` — `ctx.identity()` is deprecated.
/// Both halves are pinned: a body that compares `ctx.sender()` against anything
/// else is not the scheduler-only guard.
fn scheduler_guard_needle() -> String {
    concat!("ifctx.sender()!=", "ctx.database_identity(){", "return").to_string()
}

/// The Identity CONSTRUCTORS banned outright in `accounts.rs` (E2 defense).
/// Nothing in this module legitimately CONSTRUCTS an Identity: every identity it
/// handles arrives from `ctx.sender()` or from a row it read.
fn identity_ctor_needles() -> [String; 4] {
    [
        concat!("Identity::", "from_hex(").to_string(),
        concat!("Identity::", "from_byte_array(").to_string(),
        concat!("Identity::", "from_be_byte_array(").to_string(),
        concat!("Identity::", "from_str(").to_string(),
    ]
}

/// The FULL G2 param rule over an already-squashed source: `Err(reason)` naming
/// the first violation, `Ok(())` when every enumerated reducer's every parameter
/// is either the ctx handle, a wire-safe scalar, or the guarded scheduled
/// struct.
///
/// Returning a value instead of asserting inline is what lets the machinery
/// self-teeth drive this checker over synthetic fixtures — an always-red checker
/// is indistinguishable from a working one until a GOOD fixture proves
/// otherwise.
fn g2_client_identity_violation(squashed: &str) -> Result<(), String> {
    let reducers = parse_reducers(squashed);
    let scheduled = parse_scheduled_targets(squashed);

    // Non-vacuity — the Rust twin of the eval's [R/name-set] empty guard. With
    // zero reducers parsed, every clause below passes on an empty source, so
    // this is a hard failure rather than a skip.
    if reducers.is_empty() {
        return Err(
            "[R/name-set] no reducer declaration was parsed out of the scanned source — the \
             scan reached the wrong file, the attribute spelling changed, or the stripper \
             blanked the declarations. Every clause below would pass VACUOUSLY"
                .to_string(),
        );
    }

    for (name, params) in &reducers {
        for (k, (p_name, p_type)) in params.iter().enumerate() {
            // (a) The ctx handle. Mirrors the eval's [R/param-types] exemption
            // exactly: position 0 AND a type ending in `ReducerContext`, so a
            // context smuggled into a later position is still classified.
            if k == 0 && p_type.ends_with("ReducerContext") {
                continue;
            }
            // (b) A wire-safe scalar.
            if is_wire_safe_type(p_type) {
                continue;
            }
            // (c) The scheduled-struct carve-out — same-file `scheduled(..)`
            // target, param type EQUAL to the scheduled struct, AND a rejecting
            // scheduler guard in the body. Narrow enough that E1's `ClaimTarget`
            // is still rejected.
            let sched_struct = scheduled
                .iter()
                .find(|(r, _)| r == name)
                .map(|(_, s)| s.as_str());
            if sched_struct == Some(p_type.as_str()) {
                let needle = format!("fn{name}(");
                let body = extract_squashed_fn_body(squashed, &needle).unwrap_or("");
                if body.contains(&scheduler_guard_needle()) {
                    continue;
                }
                return Err(format!(
                    "[R/param-types] reducer `{name}` takes the scheduled struct `{p_type}` \
                     but its body does not contain the rejecting scheduler guard `{}` — \
                     without it ANY client can invoke the scheduled reducer directly and \
                     hand it a hand-built row, which is precisely the \
                     client-supplied-Identity hole the carve-out assumes is closed",
                    scheduler_guard_needle()
                ));
            }
            return Err(format!(
                "[R/param-types] reducer `{name}` declares the parameter `{p_name}:{p_type}`, \
                 which is not a wire-safe scalar (String / bool / u8..u128 / i8..i128 / f32 / \
                 f64, or Option<..>/Vec<..> of those). A red-team PROVED this exact shape: a \
                 `SpacetimeType` struct with one Identity field, taken as a reducer argument \
                 and re-keyed onto ctx.sender() — it declares no `: Identity` parameter, \
                 compiles, passes clippy -D warnings, and is a code-less transfer of ANY \
                 identity's game data. The ONLY sanctioned composite argument is the \
                 same-file scheduled struct whose reducer body carries the scheduler guard"
            ));
        }
    }
    Ok(())
}

// ===========================================================================
// PURE-UNIT TESTS over the functional core (no ReducerContext required).
// ===========================================================================

fn ident(b: u8) -> Identity {
    Identity::from_byte_array([b; 32])
}

/// A distinguishable baseline `Account` (created != last_login so the
/// touch/transition seams can be proven field-precise).
///
/// `terminal_at_ms: None` is the M22-S2 addition: the fresh baseline is a live
/// account, never a completed tombstone, so every pre-existing fixture that
/// spreads `..base_account(n)` keeps exactly the state it was written for.
fn base_account(b: u8) -> Account {
    Account {
        identity: ident(b),
        auth_issuer: "issuer-under-test".to_string(),
        created_at_ms: 10,
        last_login_at_ms: 20,
        status: AccountStatus::Active,
        deletion_requested_at_ms: None,
        claimed_from: None,
        claimed_at_ms: None,
        terminal_at_ms: None,
    }
}

/// AUTH-2 (pure): `issuer_allowed` is an EXACT-match allowlist — no prefix,
/// suffix, or case tolerance. A multi-tenant issuer that merely starts/ends with
/// an allowed value must NOT pass (that is the confused-deputy vector D1 guards).
///
/// Kills: swapping `contains(&issuer)` for a `starts_with` / `to_lowercase()`
/// tolerant compare.
#[test]
fn auth2_issuer_allowed_is_exact_match() {
    let valid = ALLOWED_ISSUERS[0];
    assert!(
        issuer_allowed(valid, ALLOWED_ISSUERS),
        "AUTH-2: the configured allowed issuer must pass its own allowlist."
    );
    assert!(
        !issuer_allowed(&format!("{valid}extra"), ALLOWED_ISSUERS),
        "AUTH-2: issuer_allowed must NOT tolerate a suffix (no prefix-match)."
    );
    assert!(
        !issuer_allowed(&format!("prefix{valid}"), ALLOWED_ISSUERS),
        "AUTH-2: issuer_allowed must NOT tolerate a prefix."
    );
    assert!(
        !issuer_allowed(&valid.to_uppercase(), ALLOWED_ISSUERS),
        "AUTH-2: issuer_allowed must be case-SENSITIVE."
    );
    assert!(
        !issuer_allowed("urn:example:unallowed", ALLOWED_ISSUERS),
        "AUTH-2: an unrelated issuer must be rejected."
    );
    assert!(
        !issuer_allowed("", ALLOWED_ISSUERS),
        "AUTH-2: the empty issuer must be rejected."
    );
}

/// AUTH-3 (pure): `audience_allowed` accepts iff at least one `aud` entry is
/// allowlisted; an EMPTY `aud` vec rejects (the token was minted for no audience
/// at all); matching is exact/case-sensitive; a multi-`aud` token passes on any
/// single hit.
///
/// Kills: an `is_empty() || ...` short-circuit that treats an empty audience as
/// "no constraint"; a case-folding compare.
#[test]
fn auth3_audience_allowed_semantics() {
    let good = ALLOWED_AUDIENCE[0].to_string();
    assert!(
        !audience_allowed(&[], ALLOWED_AUDIENCE),
        "AUTH-3: an empty aud array must be rejected (no audience => reject)."
    );
    assert!(
        audience_allowed(std::slice::from_ref(&good), ALLOWED_AUDIENCE),
        "AUTH-3: a single allowlisted aud entry must pass."
    );
    assert!(
        audience_allowed(
            &["unrelated-app".to_string(), good.clone()],
            ALLOWED_AUDIENCE
        ),
        "AUTH-3: a multi-aud token passes if ANY entry is allowlisted."
    );
    assert!(
        !audience_allowed(&["unrelated-app".to_string()], ALLOWED_AUDIENCE),
        "AUTH-3: a token whose aud contains no allowlisted value is rejected."
    );
    assert!(
        !audience_allowed(&[good.to_uppercase()], ALLOWED_AUDIENCE),
        "AUTH-3: audience matching must be case-SENSITIVE."
    );
}

/// AUTH-4 (pure): a freshly provisioned account is `Active`, unclaimed,
/// undeletion-flagged, and `created_at_ms == last_login_at_ms == now`.
///
/// Kills: seeding `PendingDeletion`, pre-populating `claimed_from`, or letting
/// created/last_login diverge at insert time.
#[test]
fn auth4_new_account_row_is_fresh_active() {
    let row = new_account_row(ident(7), "iss-abc".to_string(), 42);
    assert_eq!(row.identity, ident(7), "AUTH-4: identity is ctx.sender().");
    assert_eq!(row.auth_issuer, "iss-abc", "AUTH-4: auth_issuer recorded.");
    assert_eq!(
        row.status,
        AccountStatus::Active,
        "AUTH-4: status == Active."
    );
    assert!(row.claimed_from.is_none(), "AUTH-4: claimed_from == None.");
    assert!(
        row.claimed_at_ms.is_none(),
        "AUTH-4: claimed_at_ms == None."
    );
    assert!(
        row.deletion_requested_at_ms.is_none(),
        "AUTH-4: deletion_requested_at_ms == None."
    );
    assert_eq!(row.created_at_ms, 42, "AUTH-4: created_at_ms == now.");
    assert_eq!(row.last_login_at_ms, 42, "AUTH-4: last_login_at_ms == now.");
}

/// AUTH-5 (pure): `touch_login` stamps ONLY `last_login_at_ms`; the other seven
/// fields are byte-equal to the input.
///
/// Kills (proof-of-teeth): also stamping `created_at_ms = now`, or resetting
/// `status`, in the "row already exists" branch.
#[test]
fn auth5_touch_login_updates_only_last_login() {
    let before = base_account(3);
    let after = touch_login(before.clone(), 99);
    assert_eq!(
        after.last_login_at_ms, 99,
        "AUTH-5: last_login_at_ms := now."
    );
    assert_eq!(
        after.created_at_ms, before.created_at_ms,
        "AUTH-5: created_at_ms MUST NOT change on login (kills the created:=now mutant)."
    );
    assert_eq!(
        after.identity, before.identity,
        "AUTH-5: identity unchanged."
    );
    assert_eq!(
        after.auth_issuer, before.auth_issuer,
        "AUTH-5: auth_issuer unchanged."
    );
    assert_eq!(after.status, before.status, "AUTH-5: status unchanged.");
    assert_eq!(
        after.deletion_requested_at_ms, before.deletion_requested_at_ms,
        "AUTH-5: deletion flag unchanged."
    );
    assert_eq!(
        after.claimed_from, before.claimed_from,
        "AUTH-5: claimed_from unchanged."
    );
    assert_eq!(
        after.claimed_at_ms, before.claimed_at_ms,
        "AUTH-5: claimed_at_ms unchanged."
    );
}

/// AUTH-5 (pure): `touch_login` on a NON-Active account stamps ONLY
/// `last_login_at_ms` and leaves every lifecycle + claim field byte-identical.
///
/// `provision_or_touch_account` calls `touch_login` on ANY existing row on every
/// reconnect — including a `PendingDeletion` account that has already claimed a
/// guest — but `auth5_touch_login_updates_only_last_login` only exercises the
/// fresh-Active fixture. A regression that clobbered `status` /
/// `deletion_requested_at_ms` / `claimed_from` / `claimed_at_ms` on the
/// reconnect path would silently resurrect a deletion-pending account (or wipe
/// its claim provenance) and still pass every current test. The precondition
/// `account_state_is_legal` check pins that the fixture is a real legal
/// PendingDeletion+claimed state, not an accidentally-illegal straw man.
///
/// Kills: a `touch_login` regression that resets `status` to Active, drops the
///        deletion timestamp, or clears either half of the claim provenance pair
///        when re-stamping the login time on a non-Active account.
#[test]
fn auth5_touch_login_preserves_non_active_lifecycle_and_claim_fields() {
    let before = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(500),
        claimed_from: Some(ident(9)),
        claimed_at_ms: Some(600),
        ..base_account(4)
    };
    // Precondition: the fixture must be a LEGAL PendingDeletion+claimed state, so
    // the test proves preservation of a real state rather than of a straw man
    // the invariant would have rejected anyway.
    assert!(
        account_state_is_legal(&before),
        "AUTH-5 precondition: the PendingDeletion+claimed fixture must itself be a \
         legal account state before touch_login can be asked to preserve it."
    );

    let after = touch_login(before.clone(), 777);

    assert_eq!(
        after.last_login_at_ms, 777,
        "AUTH-5: last_login_at_ms := now, even on a non-Active account."
    );
    assert_eq!(
        after.status, before.status,
        "AUTH-5: status MUST NOT change on reconnect — a login must never resurrect \
         a PendingDeletion account to Active."
    );
    assert_eq!(
        after.deletion_requested_at_ms, before.deletion_requested_at_ms,
        "AUTH-5: the deletion timestamp MUST survive a reconnect (dropping it would \
         silently cancel a pending deletion)."
    );
    assert_eq!(
        after.claimed_from, before.claimed_from,
        "AUTH-5: claimed_from (audit provenance, AUTH-21) MUST survive a reconnect."
    );
    assert_eq!(
        after.claimed_at_ms, before.claimed_at_ms,
        "AUTH-5: claimed_at_ms MUST survive a reconnect."
    );
    assert_eq!(
        after.created_at_ms, before.created_at_ms,
        "AUTH-5: created_at_ms unchanged."
    );
    assert_eq!(
        after.identity, before.identity,
        "AUTH-5: identity unchanged."
    );
    assert_eq!(
        after.auth_issuer, before.auth_issuer,
        "AUTH-5: auth_issuer unchanged."
    );
    assert!(
        account_state_is_legal(&after),
        "AUTH-5: the reconnected account must remain a legal state."
    );
}

/// AUTH-8 (pure): `is_valid_claim_code` accepts EXACTLY 64 lowercase-hex chars.
///
/// Kills (proof-of-teeth): swapping the explicit `b'0'..=b'9' | b'a'..=b'f'`
/// match for `is_ascii_hexdigit()` (accepts uppercase); a `>=`/`<=` length
/// mistake; a byte-length-vs-char-length confusion on non-ASCII input.
#[test]
fn auth8_is_valid_claim_code_charset_and_length() {
    let ok = "0123456789abcdef".repeat(4); // 64 lowercase hex
    assert_eq!(ok.len(), 64);
    assert!(
        is_valid_claim_code(&ok),
        "AUTH-8: 64 lowercase hex is valid."
    );
    assert!(
        is_valid_claim_code(&"0".repeat(64)),
        "AUTH-8: 64 zeros is valid."
    );
    assert!(
        !is_valid_claim_code(&"a".repeat(63)),
        "AUTH-8: 63 chars is too short."
    );
    assert!(
        !is_valid_claim_code(&"a".repeat(65)),
        "AUTH-8: 65 chars is too long."
    );
    assert!(!is_valid_claim_code(""), "AUTH-8: empty is invalid.");
    // Exactly one uppercase hex digit must reject (the is_ascii_hexdigit mutant).
    let mut one_upper = "a".repeat(63);
    one_upper.push('A');
    assert!(
        !is_valid_claim_code(&one_upper),
        "AUTH-8: a single uppercase 'A' must reject (kills is_ascii_hexdigit)."
    );
    // A non-hex letter.
    let mut one_g = "a".repeat(63);
    one_g.push('g');
    assert!(!is_valid_claim_code(&one_g), "AUTH-8: 'g' is not hex.");
    // Leading space.
    let mut spaced = " ".to_string();
    spaced.push_str(&"a".repeat(63));
    assert!(
        !is_valid_claim_code(&spaced),
        "AUTH-8: whitespace is invalid."
    );
    // 64 chars of a multi-byte glyph (U+00E9, 2 bytes each): char-count 64 but
    // byte-len 128 => reject (the length check is on len(), reinforced by charset).
    let glyphs: String = "\u{e9}".repeat(64);
    assert!(
        !is_valid_claim_code(&glyphs),
        "AUTH-8: 64 non-ASCII chars (128 bytes) must reject."
    );
    // A 64-BYTE non-ASCII string (32 * U+00E9): correct byte length, wrong charset.
    let sixtyfour_bytes: String = "\u{e9}".repeat(32);
    assert_eq!(sixtyfour_bytes.len(), 64);
    assert!(
        !is_valid_claim_code(&sixtyfour_bytes),
        "AUTH-8: 64 BYTES of non-hex must reject on charset."
    );
}

/// AUTH-9 (pure): `claim_row` binds the fields as passed and derives
/// `expires_at_ms == created_at_ms + CLAIM_TTL_MS`.
///
/// Kills: an off-by-TTL expiry, or swapping `created`/`expires`.
#[test]
fn auth9_claim_row_binds_fields_and_derives_expiry() {
    let row = claim_row(ident(5), "deadbeef".to_string(), "Ash".to_string(), 1000);
    assert_eq!(
        row.guest_identity,
        ident(5),
        "AUTH-9: bound to ctx.sender()."
    );
    assert_eq!(row.code, "deadbeef", "AUTH-9: code stored verbatim.");
    assert_eq!(
        row.guest_name, "Ash",
        "AUTH-9: guest_name is the server-supplied player.name snapshot."
    );
    assert_eq!(row.created_at_ms, 1000, "AUTH-9: created_at_ms == now.");
    assert_eq!(
        row.expires_at_ms,
        1000 + CLAIM_TTL_MS,
        "AUTH-9: expires_at_ms == now + CLAIM_TTL_MS."
    );
}

/// AUTH-9/16 boundary (pure): `claim_expires_at` saturates, and CLAIM_TTL_MS is
/// the documented 15 minutes.
#[test]
fn auth9_claim_expires_at_saturates() {
    assert_eq!(CLAIM_TTL_MS, 15 * 60 * 1000, "CLAIM_TTL_MS is 15 minutes.");
    assert_eq!(claim_expires_at(1000), 1000 + CLAIM_TTL_MS);
    assert_eq!(
        claim_expires_at(i64::MAX),
        i64::MAX,
        "AUTH-9: expiry uses saturating_add (no overflow panic)."
    );
}

/// AUTH-16 / AUTH-27 (pure): `claim_is_expired` is boundary-INCLUSIVE
/// (`now >= expires`).
///
/// Kills: a strict `>` that would leave a code usable for one extra instant at
/// the boundary (and would let the reaper skip a just-expired row).
#[test]
fn auth16_claim_is_expired_boundary_inclusive() {
    assert!(
        !claim_is_expired(100, 99),
        "AUTH-16: before expiry => not expired."
    );
    assert!(
        claim_is_expired(100, 100),
        "AUTH-16: at the expiry instant => expired (boundary inclusive)."
    );
    assert!(
        claim_is_expired(100, 101),
        "AUTH-16: past expiry => expired."
    );
}

/// AUTH-21 (pure): `claimed_account` stamps provenance (`claimed_from`,
/// `claimed_at_ms`) once and changes nothing else.
///
/// Kills: a mutant that also flips `status`, or overwrites `identity`.
#[test]
fn auth21_claimed_account_stamps_provenance_only() {
    let before = base_account(4);
    let guest = ident(200);
    let after = claimed_account(before.clone(), guest, 7);
    assert_eq!(
        after.claimed_from,
        Some(guest),
        "AUTH-21: claimed_from := Some(guest)."
    );
    assert_eq!(
        after.claimed_at_ms,
        Some(7),
        "AUTH-21: claimed_at_ms := Some(now)."
    );
    assert_eq!(
        after.identity, before.identity,
        "AUTH-21: identity unchanged."
    );
    assert_eq!(after.status, before.status, "AUTH-21: status unchanged.");
    assert_eq!(
        after.auth_issuer, before.auth_issuer,
        "AUTH-21: auth_issuer unchanged."
    );
    assert_eq!(
        after.created_at_ms, before.created_at_ms,
        "AUTH-21: created unchanged."
    );
    assert_eq!(
        after.last_login_at_ms, before.last_login_at_ms,
        "AUTH-21: last_login unchanged."
    );
}

/// AUTH-28 (pure): `needs_deletion_write` and `requested_deletion`. The second
/// `delete_account` call (already `PendingDeletion`) writes nothing.
///
/// Kills (proof-of-teeth): `needs_deletion_write` returning `true`
/// unconditionally (re-stamps the timestamp on the second call).
#[test]
fn auth28_deletion_write_gate_and_transition() {
    assert!(
        needs_deletion_write(AccountStatus::Active),
        "AUTH-28: an Active account must be transitioned (write required)."
    );
    assert!(
        !needs_deletion_write(AccountStatus::PendingDeletion),
        "AUTH-28: a second delete on PendingDeletion writes nothing (idempotent)."
    );
    let before = base_account(6);
    let after = requested_deletion(before.clone(), 7);
    assert_eq!(
        after.status,
        AccountStatus::PendingDeletion,
        "AUTH-28: status := PendingDeletion."
    );
    assert_eq!(
        after.deletion_requested_at_ms,
        Some(7),
        "AUTH-28: deletion_requested_at_ms := Some(now)."
    );
    // Nothing else moves.
    assert_eq!(
        after.identity, before.identity,
        "AUTH-28: identity unchanged."
    );
    assert_eq!(
        after.created_at_ms, before.created_at_ms,
        "AUTH-28: created unchanged."
    );
    assert_eq!(
        after.last_login_at_ms, before.last_login_at_ms,
        "AUTH-28: last_login unchanged."
    );
    assert_eq!(
        after.claimed_from, before.claimed_from,
        "AUTH-28: claimed_from unchanged."
    );
    assert_eq!(
        after.claimed_at_ms, before.claimed_at_ms,
        "AUTH-28: claimed_at_ms unchanged."
    );
}

/// AUTH-29 (pure): `cancelled_deletion` returns a `PendingDeletion` account to
/// `Active`, clears the flag, and PRESERVES spent-claim provenance (a cancel must
/// never resurrect a claim).
///
/// Kills: a mutant that also clears `claimed_from`/`claimed_at_ms`.
#[test]
fn auth29_cancelled_deletion_preserves_claim_provenance() {
    let guest = ident(150);
    let pending = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(5),
        claimed_from: Some(guest),
        claimed_at_ms: Some(3),
        ..base_account(8)
    };
    let after = cancelled_deletion(pending.clone());
    assert_eq!(
        after.status,
        AccountStatus::Active,
        "AUTH-29: status := Active."
    );
    assert!(
        after.deletion_requested_at_ms.is_none(),
        "AUTH-29: deletion flag cleared."
    );
    assert_eq!(
        after.claimed_from,
        Some(guest),
        "AUTH-29: claimed_from PRESERVED (a cancel never resurrects a spent claim)."
    );
    assert_eq!(
        after.claimed_at_ms,
        Some(3),
        "AUTH-29: claimed_at_ms preserved."
    );
    assert_eq!(
        after.identity, pending.identity,
        "AUTH-29: identity unchanged."
    );
    assert_eq!(
        after.created_at_ms, pending.created_at_ms,
        "AUTH-29: created unchanged."
    );
}

/// AUTH-38 (pure): `needs_cancel_write` — a cancel on an already-`Active`
/// account writes nothing (idempotent no-op, symmetric with AUTH-28).
#[test]
fn auth38_cancel_write_gate() {
    assert!(
        !needs_cancel_write(AccountStatus::Active),
        "AUTH-38: cancel on Active writes nothing."
    );
    assert!(
        needs_cancel_write(AccountStatus::PendingDeletion),
        "AUTH-38: cancel on PendingDeletion must write (reverses the flag)."
    );
}

/// AUTH-15/35 (pure): the two indistinguishable-code paths share ONE reject
/// reason constant, so a caller cannot tell "never existed" from "already
/// consumed" (no code-existence oracle, D3).
#[test]
fn auth15_shared_reject_reason_constant() {
    assert_eq!(
        ERR_INVALID_CODE, "invalid or already-used code",
        "AUTH-15/35: the shared reject reason is the spec contract string."
    );
}

// ===========================================================================
// SOURCE-SCAN TESTS (ctx-bound shell properties). GREEN against the frozen
// production; each has a documented proof-of-teeth mutation that flips it RED.
// ===========================================================================

/// AUTH-1 / G3 (ANON_PASSTHROUGH): `on_connect` (lib.rs) makes the `has_jwt()`
/// early return the FIRST statement — an anonymous connection can never reach an
/// `Err` path (returning `Err` disconnects the client). The provisioning
/// delegation runs strictly AFTER the guard.
///
/// Kills (proof-of-teeth): move `provision_or_touch_account(ctx)` above the
/// `has_jwt()` return — then an unrecognized-audience `Err` becomes reachable for
/// what is, in practice, the host's own anonymous token, disconnecting players.
#[test]
fn auth1_on_connect_has_jwt_gate_is_first_and_no_err_before() {
    let squashed = stripped_for_scan(LIB_RS);
    let needle = concat!("fnon", "_connect(");
    let body = extract_squashed_fn_body(&squashed, needle)
        .expect("AUTH-1: fn on_connect not found in lib.rs");

    let has_jwt = "has_jwt(";
    let provision = concat!("provision_or_touch", "_account(");
    assert!(
        body.contains(has_jwt),
        "AUTH-1: on_connect must gate on has_jwt()."
    );
    assert!(
        body.contains(concat!("returnOk", "(())")),
        "AUTH-1: on_connect must early-return Ok(()) for the JWT-less case."
    );
    assert!(
        body.contains(provision),
        "AUTH-1: on_connect must delegate to provision_or_touch_account."
    );
    assert!(
        idx(body, has_jwt) < idx(body, provision),
        "AUTH-1: the has_jwt() gate MUST precede the provisioning delegation \
         (proof-of-teeth: moving provisioning first exposes an Err to anonymous clients)."
    );
    assert!(
        idx(body, has_jwt) < idx(body, concat!("returnOk", "(())")),
        "AUTH-1: has_jwt() is the first statement, before the early Ok(())."
    );
    assert!(
        !body.contains("Err("),
        "AUTH-1: on_connect's own body must contain NO Err( literal — an anonymous \
         connection must never be disconnected (D4)."
    );
}

/// AUTH-2/AUTH-3 / G3 (ISSUER_AND_AUDIENCE, D1 asymmetric): `provision_or_touch_account`
/// checks BOTH `iss` and `aud`. The unrecognized-ISSUER branch reaches a rate-limited
/// `return Ok` (fail-safe to anonymous — the host's own token path). The
/// unrecognized-AUDIENCE branch reaches a `return Err` (disconnect — a same-issuer
/// confused-deputy token). Both checks precede any account insert.
///
/// Kills (proof-of-teeth): delete the audience block (issuer-only check) — the
/// `audience_allowed(` needle disappears; a cross-app token would then provision.
/// Also kills making the issuer branch `return Err` (would disconnect everyone).
#[test]
fn auth2_3_provision_checks_issuer_then_audience_asymmetric() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_provision())
        .expect("AUTH-2/3: fn provision_or_touch_account not found in accounts.rs");

    // All four decision tokens present.
    for (needle, what) in [
        (".issuer(", "reads the iss claim"),
        (".audience(", "reads the aud claim"),
        ("issuer_allowed(", "checks iss against ALLOWED_ISSUERS"),
        ("audience_allowed(", "checks aud against ALLOWED_AUDIENCE"),
    ] {
        assert!(
            body.contains(needle),
            "AUTH-2/3: provision_or_touch_account must contain `{needle}` ({what}). \
             An issuer-only check (missing audience_allowed) is the BAD fixture D1 forbids."
        );
    }

    let i_issuer = idx(body, "issuer_allowed(");
    let i_aud = idx(body, "audience_allowed(");
    assert!(
        i_issuer < i_aud,
        "AUTH-2/3: the issuer check must precede the audience check."
    );

    // Issuer-unrecognized branch: a rate-limited Ok BEFORE the audience check.
    let issuer_branch = &body[i_issuer..i_aud];
    assert!(
        issuer_branch.contains(".check("),
        "AUTH-2: the unrecognized-issuer branch logs via a rate-LIMITER (.check(...)) — \
         it is the modal path (host anonymous token) and must not flood."
    );
    assert!(
        issuer_branch.contains(concat!("returnOk", "(())")),
        "AUTH-2: the unrecognized-issuer branch must return Ok(()) (fail-safe to \
         anonymous, NEVER disconnect)."
    );

    // Audience-unrecognized branch: a disconnecting Err AFTER the audience check.
    let after_aud = &body[i_aud..];
    assert!(
        after_aud.contains(concat!("returnErr", "(")),
        "AUTH-3: the unrecognized-audience branch must return Err (disconnect a \
         same-issuer cross-app confused-deputy token)."
    );

    // Both checks precede the account insert.
    let insert_needle = concat!("account()", ".insert(");
    let i_insert = idx(body, insert_needle);
    assert!(
        i_aud < i_insert,
        "AUTH-2/3: issuer AND audience must both be validated before any account insert."
    );
}

/// AUTH-6 / D9: no email / email_hash / raw JWT `sub` is ever stored. The
/// `Account` struct field list (schema.rs) carries no `email`/`subject` token,
/// and accounts.rs never calls `.subject(` or `raw_payload(`.
///
/// Kills: adding an `email_hash: String` column, or reading `claims.subject()`
/// into a stored field.
#[test]
fn auth6_no_email_or_subject_stored() {
    // Account struct field list (comment-stripped, strings kept, squashed).
    let schema = stripped_keep_strings(SCHEMA_RS);
    let acct_marker = concat!("struct", "Account{");
    let acct_start = schema
        .find(acct_marker)
        .expect("AUTH-6: struct Account not found in schema.rs");
    let after = &schema[acct_start..];
    let open = after
        .find('{')
        .expect("AUTH-6: Account body brace not found");
    let field_bytes = after.as_bytes();
    let mut depth = 0usize;
    let mut end = open;
    for (i, &b) in field_bytes.iter().enumerate().skip(open) {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = i;
                    break;
                }
            }
            _ => {}
        }
    }
    let fields = &after[open..=end];
    assert!(
        !fields.contains("email"),
        "AUTH-6/D9: the Account struct must carry no `email`/`email_hash` field. Body: {fields:?}"
    );
    assert!(
        !fields.contains("subject"),
        "AUTH-6/D9: the Account struct must carry no `auth_subject`/subject field. Body: {fields:?}"
    );

    // accounts.rs never touches the raw sub claim.
    let acc = stripped_for_scan(ACCOUNTS_RS);
    assert!(
        !acc.contains(concat!(".sub", "ject(")),
        "AUTH-6/D9: accounts.rs must not read claims.subject() (the raw JWT sub)."
    );
    assert!(
        !acc.contains(concat!("raw", "_payload(")),
        "AUTH-6/D9: accounts.rs must not read the raw JWT payload."
    );
}

/// AUTH-36 / G12 (NO_PII_IN_REJECT_LOGS): every `log_reject(` argument list in
/// accounts.rs uses a static reason — never `format!`, never a raw JWT claim
/// identifier (`issuer`/`subject`/`audience`/`claims`).
///
/// Kills (proof-of-teeth): change a reason to `format!("issuer {} rejected", issuer)`
/// — the `format!` token and the lowercase `issuer` identifier both surface in the
/// argument span.
#[test]
fn auth36_reject_logs_carry_no_pii() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let spans = log_reject_arg_spans(&squashed);
    assert!(
        !spans.is_empty(),
        "AUTH-36: expected at least one log_reject( call in accounts.rs."
    );
    for span in &spans {
        assert!(
            !span.contains(concat!("format", "!")),
            "AUTH-36: a log_reject reason must be a static literal, never format!(...). \
             Offending arg span: {span:?}"
        );
        for claim in ["issuer", "subject", "audience", "claims"] {
            assert!(
                !span.contains(claim),
                "AUTH-36: no raw JWT claim identifier (`{claim}`) may appear inside a \
                 log_reject argument. Offending arg span: {span:?}"
            );
        }
    }
}

/// Extract each `log_reject(` call's argument text (between its outer parens)
/// from an already-squashed source.
fn log_reject_arg_spans(squashed: &str) -> Vec<String> {
    let marker = concat!("log", "_reject(");
    let bytes = squashed.as_bytes();
    let mut spans = Vec::new();
    let mut start = 0;
    while let Some(rel) = squashed[start..].find(marker) {
        let open = start + rel + marker.len() - 1; // index of '('
        let mut depth = 0i32;
        let mut end = open;
        let mut i = open;
        while i < bytes.len() {
            match bytes[i] {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = i;
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        spans.push(squashed[open + 1..end].to_string());
        start = end + 1;
    }
    spans
}

/// AUTH-7/8/9 (scan): `start_guest_claim` gates on `is_account_holder` (the
/// account-row predicate, D4 — NOT has_jwt), validates the code, snapshots the
/// name server-side from `player.name`, and takes NO client `name` argument.
///
/// (Per /simplify: NO guard-ordering pin here — there is no code-resolution
/// oracle in start_guest_claim, so ordering has no security rationale.)
///
/// Kills: dropping the account-holder gate (AUTH-7); dropping code validation
/// (AUTH-8); accepting a client-supplied `name` instead of `player.name` (AUTH-9).
#[test]
fn auth7_8_9_start_guest_claim_gates_and_name_source() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_start())
        .expect("AUTH-7/8/9: fn start_guest_claim not found in accounts.rs");

    assert!(
        body.contains(concat!("is_account", "_holder(")),
        "AUTH-7: start_guest_claim must reject an account holder via is_account_holder(."
    );
    assert!(
        body.contains(concat!("is_valid_claim", "_code(")),
        "AUTH-8: start_guest_claim must validate the code via is_valid_claim_code(."
    );
    assert!(
        body.contains("player.name"),
        "AUTH-9: the guest_name is snapshotted from player.name server-side."
    );

    // The signature takes exactly (ctx, code: String) — no client name argument.
    let sig = extract_squashed_fn_sig(&squashed, &nd_start())
        .expect("AUTH-9: start_guest_claim signature not found");
    assert!(
        sig.contains("code:String"),
        "AUTH-9: start_guest_claim(ctx, code: String) — the code is the only argument."
    );
    assert!(
        !sig.contains("name:"),
        "AUTH-9: start_guest_claim must NOT take a `name:` argument (server-populated only). \
         Signature: {sig:?}"
    );
}

/// AUTH-10 (scan): `start_guest_claim` consumes+disarms any prior claim BEFORE
/// inserting the new `guest_claim` row (the PK is `guest_identity`, so
/// insert-before-delete would PK-collide), and arms the reaper AFTER the insert.
///
/// Kills (proof-of-teeth): move `consume_claim_and_disarm` after the insert
/// (unique-constraint abort / orphaned schedule row).
#[test]
fn auth10_start_guest_claim_replaces_before_insert() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_start())
        .expect("AUTH-10: fn start_guest_claim not found");

    let consume = concat!("consume_claim_and", "_disarm(");
    let insert = concat!("guest", "_claim().insert(");
    let arm = concat!("arm_claim", "_reaper(");
    let i_consume = idx(body, consume);
    let i_insert = idx(body, insert);
    let i_arm = idx(body, arm);
    assert!(
        i_consume < i_insert,
        "AUTH-10: consume_claim_and_disarm MUST precede the guest_claim insert \
         (insert-before-delete PK-collides on guest_identity)."
    );
    assert!(
        i_arm > i_insert,
        "AUTH-10: the reaper is armed AFTER the new claim row is inserted."
    );
}

/// AUTH-11 / G4 (NO_SERVER_RNG): the accounts code path never calls
/// `ctx.rng(`/`ctx.random(` — the claim secret is client-minted (D3).
#[test]
fn auth11_no_server_rng_in_accounts() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    assert!(
        !squashed.contains(concat!("ctx.", "rng(")),
        "AUTH-11: accounts.rs must not call ctx.rng()."
    );
    assert!(
        !squashed.contains(concat!("ctx.", "random(")),
        "AUTH-11: accounts.rs must not call ctx.random()."
    );
}

/// AUTH-12/13/14 (scan, PARTITION check per /simplify): in `complete_guest_claim`
/// every caller-state guard (has_jwt, account lookup, pending-deletion,
/// already-claimed) runs strictly BEFORE any code resolution (validate code,
/// resolve the claim row). This closes the claim-code oracle: an unauthorized
/// caller can never probe code validity.
///
/// Kills (proof-of-teeth): move `guest_claim().code().find(` above the account /
/// pending / claimed guards — the partition boundary is violated.
#[test]
fn auth12_13_14_caller_state_guards_precede_code_resolution() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_complete())
        .expect("AUTH-12/13/14: fn complete_guest_claim not found");

    let caller_state = [
        ("has_jwt(", "AUTH-12 JWT pre-filter"),
        (
            concat!("account()", ".identity().find("),
            "AUTH-12 account-holder",
        ),
        (
            concat!("is_pending", "_deletion("),
            "AUTH-13 pending-deletion",
        ),
        ("claimed_from", "AUTH-14 one-claim-per-account"),
    ];
    let code_resolution = [
        (
            concat!("is_valid_claim", "_code("),
            "AUTH-15a code well-formed",
        ),
        (
            concat!("guest", "_claim().code().find("),
            "AUTH-15b/35 claim lookup",
        ),
    ];

    let mut max_caller = 0usize;
    for (needle, what) in caller_state {
        assert!(
            body.contains(needle),
            "AUTH-12/13/14: caller-state guard `{needle}` ({what}) must be present."
        );
        max_caller = max_caller.max(idx(body, needle));
    }
    let mut min_code = usize::MAX;
    for (needle, what) in code_resolution {
        assert!(
            body.contains(needle),
            "AUTH-15: code-resolution needle `{needle}` ({what}) must be present."
        );
        min_code = min_code.min(idx(body, needle));
    }
    assert!(
        max_caller < min_code,
        "AUTH-12/13/14 PARTITION: every caller-state guard (max index {max_caller}) must \
         precede all code resolution (min index {min_code}) — otherwise the reducer is a \
         claim-code oracle for an unauthorized caller."
    );
}

/// AUTH-15/35 (scan): the malformed-code guard AND the never-existed/consumed
/// guard both reject with the SAME `ERR_INVALID_CODE` constant — exactly two
/// references inside `complete_guest_claim` (no code-existence oracle).
///
/// Kills: giving guard 6 a distinct message (count drops to 1 — a caller could
/// distinguish "well-formed but unknown" from "malformed").
#[test]
fn auth15_two_shared_err_invalid_code_refs() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_complete())
        .expect("AUTH-15: fn complete_guest_claim not found");
    let count = body.matches("ERR_INVALID_CODE").count();
    assert_eq!(
        count, 2,
        "AUTH-15/35: complete_guest_claim must reference ERR_INVALID_CODE exactly twice \
         (malformed + never-existed/consumed, one indistinguishable reason). Found {count}."
    );
}

/// AUTH-16 (amended) + AUTH-26 (scan): the ENTIRE reject region of
/// `complete_guest_claim` — every guard from 1 through 11, INCLUDING the expiry
/// branch — performs ZERO row writes and never consumes the claim. A reducer
/// `Err` rolls back its own writes, so any "cleanup" here is a no-op at best and
/// a burned code at worst; expired-claim cleanup is the reaper's job alone.
///
/// The reject region is the body up to the success entry point `rekey_all(`.
///
/// Kills (proof-of-teeth): add `consume_claim_and_disarm(` to the expiry (or any)
/// reject branch — a rejected/expired claim would silently burn the code.
#[test]
fn auth16_26_reject_region_is_side_effect_free() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_complete())
        .expect("AUTH-16/26: fn complete_guest_claim not found");
    let rekey = concat!("rekey", "_all(");
    let reject_region = &body[..idx(body, rekey)];

    for (verb, what) in [
        (concat!(".ins", "ert("), "insert"),
        (concat!(".upd", "ate("), "update"),
        (concat!(".del", "ete("), "delete"),
    ] {
        assert!(
            !reject_region.contains(verb),
            "AUTH-26: the reject region (guards 1..11, incl. expiry) must contain no \
             `{what}` write — every Err path is non-mutating."
        );
    }
    assert!(
        !reject_region.contains(concat!("consume_claim_and", "_disarm(")),
        "AUTH-16/26: no reject branch may consume the claim (the expiry path leaves the \
         row intact; the reaper owns expired cleanup)."
    );
    assert!(
        !reject_region.contains(concat!("delete", "_claim(")),
        "AUTH-16/26: no reject branch may delete the claim row directly either."
    );
}

/// AUTH-17/18/19/20 (scan): the remaining `complete_guest_claim` guards.
/// AUTH-17: reject when the resolved guest identity equals the caller.
/// AUTH-18: the guest's `player` presence row must be absent (the liveness oracle).
/// AUTH-19: neither identity may be mid-battle — the SSOT predicate `is_in_ongoing_battle` is called TWICE (guest + caller) and accounts.rs never touches the battle table itself (D0/G5).
/// AUTH-20: the destination-owns-no-game-data guard is the LAST guard before the re-key.
///
/// Kills: dropping any of these guards; re-deriving battle liveness instead of
/// reusing the SSOT (would drop one of the two calls or add a battle accessor).
#[test]
fn auth17_18_19_20_completion_guards_present() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_complete())
        .expect("AUTH-17..20: fn complete_guest_claim not found");

    // AUTH-17. Order-agnostic: `guest == me` and `me == guest` are behaviorally
    // identical (Identity: Eq); pinning one operand order would false-RED on an
    // innocent refactor without adding teeth (/simplify finding, 2026-08-08).
    assert!(
        body.contains("guest==me") || body.contains("me==guest"),
        "AUTH-17: complete_guest_claim must reject when guest == me (own-session claim)."
    );
    // AUTH-18.
    assert!(
        body.contains(concat!("player()", ".identity().find(")),
        "AUTH-18: complete_guest_claim must read the guest's player presence row."
    );
    // AUTH-19.
    let battle_pred = concat!("is_in_ongoing", "_battle(");
    let battle_count = body.matches(battle_pred).count();
    assert_eq!(
        battle_count, 2,
        "AUTH-19: is_in_ongoing_battle must be called TWICE (guest + caller). Found {battle_count}."
    );
    // AUTH-20: last guard before the re-key.
    let has_data = concat!("account_has_game", "_data(");
    let rekey = concat!("rekey", "_all(");
    assert!(
        body.contains(has_data),
        "AUTH-20: the destination-owns-no-game-data guard must be present."
    );
    assert!(
        idx(body, has_data) < idx(body, rekey),
        "AUTH-20: account_has_game_data must gate BEFORE rekey_all (fail-closed)."
    );
}

/// AUTH-19 / G5: accounts.rs never touches the `battle` table directly — battle
/// liveness is delegated to the reused SSOT predicate.
#[test]
fn auth19_g5_no_direct_battle_access() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    assert!(
        !squashed.contains(concat!("ctx.db.", "battle(")),
        "AUTH-19/G5: accounts.rs must not access ctx.db.battle() (reuse is_in_ongoing_battle)."
    );
}

/// AUTH-34 (scan, single-use): on the SUCCESS path (from `rekey_all(` to the
/// final `Ok(())`) the claim is consumed+disarmed BEFORE the account provenance
/// update and before returning Ok — and `consume_claim_and_disarm` appears
/// EXACTLY ONCE in the whole reducer (success only; the expiry path does NOT
/// consume, per the AUTH-16 amendment).
///
/// Kills (proof-of-teeth): move the consume into the expiry branch only (success
/// region loses the consume — a completed claim stays replayable for the TTL);
/// or add a second consume in a reject branch (count != 1).
#[test]
fn auth34_success_consumes_before_ok_exactly_once() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_complete())
        .expect("AUTH-34: fn complete_guest_claim not found");

    let consume = concat!("consume_claim_and", "_disarm(");
    let total = body.matches(consume).count();
    assert_eq!(
        total, 1,
        "AUTH-34: exactly ONE consume_claim_and_disarm in complete_guest_claim (success only). \
         Found {total}."
    );

    let rekey = concat!("rekey", "_all(");
    let success_region = &body[idx(body, rekey)..];
    assert!(
        success_region.contains(consume),
        "AUTH-34: the success region must consume the claim."
    );
    let i_consume = idx(success_region, consume);
    let acct_update = concat!("account()", ".identity().update(");
    assert!(
        i_consume < idx(success_region, acct_update),
        "AUTH-34: consume must precede the account provenance update."
    );
    // The final Ok(()) is the last such token in the body.
    let last_ok = body
        .rfind(concat!("Ok", "(())"))
        .expect("AUTH-34: complete_guest_claim must end in Ok(())");
    assert!(
        idx(body, rekey) + i_consume < last_ok,
        "AUTH-34: consume must occur before the reducer returns Ok(())."
    );
}

/// AUTH-15/16/17/18/20 + start/reaper (scan): the exact reject MESSAGE strings
/// the spec mandates are present in accounts.rs source (comment-stripped, string
/// content preserved). These are the caller-facing contract strings.
///
/// Kills: silently changing a mandated reject message (a UX/contract regression).
#[test]
fn reject_message_contracts_present() {
    let kept = stripped_keep_strings(ACCOUNTS_RS);
    // Needles are the squashed message content, assembled to avoid self-match.
    let messages = [
        (
            concat!("invalidoralready", "-usedcode"),
            "AUTH-15/35 invalid-or-already-used",
        ),
        (concat!("code", "expired"), "AUTH-16 code expired"),
        (
            concat!("cannotclaimyour", "ownsession"),
            "AUTH-17 own-session",
        ),
        (
            concat!("closeyourothertab", ",thenretry"),
            "AUTH-18 stale-tab",
        ),
        (
            concat!("alreadyhas", "gamedata"),
            "AUTH-20 destination has data",
        ),
        (concat!("already", "signedin"), "AUTH-7 account holder"),
        (
            concat!("invalid", "claimcode"),
            "AUTH-8 malformed code (start)",
        ),
        (
            concat!("guest_claim_reaperis", "scheduler-only"),
            "AUTH-27 scheduler-only",
        ),
    ];
    for (needle, what) in messages {
        assert!(
            kept.contains(needle),
            "reject-message contract ({what}): accounts.rs must contain the mandated reject \
             message (squashed needle {needle:?})."
        );
    }
}

/// AUTH-21 (scan): `rekey_all` re-keys every REKEY-policy table via its delegated
/// owning-module helper, in D6-manifest order, and the fallible monster re-key
/// propagates with `?` (a broken dual-write rolls the whole claim back).
///
/// Kills: dropping a table from the manifest; reordering the monster re-key to be
/// non-fallible (dropping the `?`).
#[test]
fn auth21_rekey_all_delegates_every_table_in_order() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, concat!("fnrekey", "_all("))
        .expect("AUTH-21: fn rekey_all not found");

    let ordered = [
        concat!("rekey", "_monsters("),
        concat!("rekey", "_inventory("),
        concat!("rekey", "_npc_state("),
        concat!("rekey", "_heal_cooldown("),
        concat!("rekey", "_wallet("),
        concat!("rekey", "_profile("),
    ];
    let mut prev = 0usize;
    for needle in ordered {
        assert!(
            body.contains(needle),
            "AUTH-21: rekey_all must call {needle}."
        );
        let at = idx(body, needle);
        assert!(
            at >= prev,
            "AUTH-21: rekey_all must invoke helpers in D6-manifest order; {needle} out of order."
        );
        prev = at;
    }
    // The monster re-key is the fail-loud fallible one.
    assert!(
        body.contains(concat!("rekey_monsters(ctx,from,to)", "?")),
        "AUTH-21/22: rekey_all must propagate rekey_monsters' Result with `?` (fail-loud)."
    );
}

/// AUTH-22 (scan): `rekey_monsters` (monster_mgmt.rs) re-keys the `monster` row
/// AND its `monster_pub` twin in ONE function body, deriving the pub row via
/// `pub_from_monster(` (never a literal tier), and fails LOUD (`else { return Err`)
/// when the pub twin is missing. Rust-side mirror of monster-dual-write.eval.mjs.
///
/// Kills (proof-of-teeth): drop the monster_pub mirror, or drop `pub_from_monster`
/// and hand-patch `owner_identity` (fabricated / stale tier).
#[test]
fn auth22_rekey_monsters_dual_write_fail_loud() {
    let squashed = stripped_for_scan(MONSTER_MGMT_RS);
    let body = extract_squashed_fn_body(&squashed, concat!("fnrekey", "_monsters("))
        .expect("AUTH-22: fn rekey_monsters not found in monster_mgmt.rs");

    for (needle, what) in [
        (
            concat!("monster()", ".monster_id().update("),
            "private monster re-key",
        ),
        (
            concat!("monster", "_pub().monster_id().update("),
            "public twin re-key",
        ),
        (
            concat!("pub_from", "_monster("),
            "derived pub row (never a literal tier)",
        ),
        (
            concat!("else{return", "Err"),
            "fail-loud on a missing pub twin",
        ),
    ] {
        assert!(
            body.contains(needle),
            "AUTH-22: rekey_monsters body must contain `{needle}` ({what})."
        );
    }
}

/// AUTH-23 (scan): `rekey_profile` (ranking.rs) NEVER deletes a `profile` row —
/// it copies stats forward and zeroes/tombstones in place.
///
/// Kills: replacing the in-place zero with a delete of the guest's profile row.
#[test]
fn auth23_rekey_profile_never_deletes() {
    let squashed = stripped_for_scan(RANKING_RS);
    let body = extract_squashed_fn_body(&squashed, concat!("fnrekey", "_profile("))
        .expect("AUTH-23: fn rekey_profile not found in ranking.rs");
    assert!(
        !body.contains(concat!(".del", "ete(")),
        "AUTH-23: rekey_profile must contain NO delete — profile rows are never deleted \
         (copy-forward + in-place zero/tombstone)."
    );
}

/// AUTH-27 (scan): `guest_claim_reaper` is scheduler-only, re-checks staleness,
/// deletes exactly the PK row named by `args` via `delete_claim`, and does NOT
/// self-disarm (the runtime deletes the fired one-shot schedule row).
///
/// NOTE (divergence from the draft's literal `.delete(args.guest_identity)`): the
/// production reaper deletes through the `delete_claim(ctx, args.guest_identity)`
/// helper, which internally is the guest_identity-PK delete. The scan pins the
/// helper call (the keyed delete), matching the frozen impl.
///
/// Kills (proof-of-teeth): add a self-disarm (races the runtime delete); remove
/// the staleness re-check (reaps a fresh replacement claim); replace the keyed
/// delete with an unfiltered iterate-and-delete.
#[test]
fn auth27_reaper_scheduler_only_keyed_delete_no_self_disarm() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_reaper())
        .expect("AUTH-27: fn guest_claim_reaper not found");

    assert!(
        body.contains(concat!("ctx.sender()!=ctx.", "database_identity()")),
        "AUTH-27: the reaper must guard scheduler-only \
         (ctx.sender() != ctx.database_identity())."
    );
    // rb-24 hardening (kept ALONGSIDE the bare-comparison clause above so a
    // failure still distinguishes no-comparison-at-all from present-but-inert):
    // the guard must OPEN the body in its rejecting form. The bare needle stops
    // at the fused return token and is a forgeable PREFIX — a helper call whose
    // name merely starts with those six letters contains it, compiles, and
    // rejects nobody (measured, rb-24 red-team F1).
    {
        let guard = scheduler_guard_needle();
        let rejecting = format!("{guard}Err(");
        assert!(
            body.starts_with(rejecting.as_str()),
            "AUTH-27: guest_claim_reaper must OPEN with the rejecting scheduler guard — the \
             comparison being merely PRESENT somewhere in the body admits an inert form that \
             rejects nobody."
        );
    }
    assert!(
        body.contains(concat!("claim_is", "_expired(")),
        "AUTH-27: the reaper must re-check staleness (never reap a fresh replacement claim)."
    );
    assert!(
        body.contains(concat!("delete_claim(ctx,args.", "guest_identity)")),
        "AUTH-27: the reaper must delete exactly the PK row named by args via delete_claim."
    );
    assert!(
        !body.contains(concat!("disarm_claim", "_reaper(")),
        "AUTH-27/C3: the reaper must NOT self-disarm (the runtime deletes the fired schedule row)."
    );
    assert!(
        !body.contains(concat!("consume_claim_and", "_disarm(")),
        "AUTH-27/C3: the reaper must use delete_claim (row only), never consume_claim_and_disarm."
    );
    assert!(
        !body.contains(concat!("guest_claim_reaper", "_schedule(")),
        "AUTH-27/C3: the reaper body must not write the schedule table."
    );
}

/// AUTH-37 (scan): `delete_account` rejects a caller with no JWT, then binds the
/// account row, then gates the write with `needs_deletion_write` (idempotent).
///
/// Kills: dropping the JWT gate (an anonymous caller could flag deletion);
/// dropping the idempotency gate (a second call re-stamps the timestamp).
#[test]
fn auth37_delete_account_jwt_then_account_then_gate() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, concat!("fndelete", "_account("))
        .expect("AUTH-37: fn delete_account not found");
    let has_jwt = "has_jwt(";
    let find = concat!("account()", ".identity().find(");
    let gate = concat!("needs_deletion", "_write(");
    assert!(
        body.contains(has_jwt),
        "AUTH-37: delete_account must gate on has_jwt()."
    );
    assert!(
        body.contains(find),
        "AUTH-37: delete_account must bind the account row."
    );
    assert!(
        body.contains(gate),
        "AUTH-37/28: delete_account must gate the write (idempotent)."
    );
    assert!(
        idx(body, has_jwt) < idx(body, find) && idx(body, find) < idx(body, gate),
        "AUTH-37: order must be has_jwt -> account lookup -> needs_deletion_write."
    );
}

/// AUTH-38 (scan): `cancel_account_deletion` gates on has_jwt, binds the account,
/// then gates the write with `needs_cancel_write` (idempotent no-op on Active).
#[test]
fn auth38_cancel_account_deletion_shape() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, concat!("fncancel_account", "_deletion("))
        .expect("AUTH-38: fn cancel_account_deletion not found");
    let has_jwt = "has_jwt(";
    let find = concat!("account()", ".identity().find(");
    let gate = concat!("needs_cancel", "_write(");
    assert!(
        body.contains(has_jwt),
        "AUTH-38: cancel must gate on has_jwt()."
    );
    assert!(
        body.contains(find),
        "AUTH-38: cancel must bind the account row."
    );
    assert!(
        body.contains(gate),
        "AUTH-38: cancel must gate the write via needs_cancel_write."
    );
    assert!(
        idx(body, has_jwt) < idx(body, find) && idx(body, find) < idx(body, gate),
        "AUTH-38: order must be has_jwt -> account lookup -> needs_cancel_write."
    );
}

/// G2 (NO_CLIENT_IDENTITY): every parameter of every reducer ENUMERATED FROM
/// SOURCE in accounts.rs is either the `ctx` handle, a wire-safe scalar, or the
/// same-file scheduled struct WITH its rejecting scheduler guard. The subject
/// identity is `ctx.sender()` and nothing else (ADR-0179 G2 / AUTH-6).
///
/// This replaces a five-needle hardcoded loop with the full defense set its JS
/// twin (`guest-claim-integrity.eval.mjs::checkNoClientIdentity`) carries —
/// ADR-0195 D6. The needle loop was blind to an ADDED reducer, and its
/// `:Identity` substring ban was blind to BOTH proven takeover shapes.
///
/// Kills:
///   - adding a `guest: Identity` (or `Option<Identity>`, or `Vec<Identity>`)
///     parameter to ANY reducer, including one this file never heard of;
///   - E1, the struct-wrapped Identity (`target: ClaimTarget`) — no `: Identity`
///     parameter appears anywhere, so a substring ban is green on it;
///   - a type ALIAS (`guest: Ident`), invisible to any Identity-spelling ban;
///   - neutering the scheduler guard on `guest_claim_reaper` to the
///     `let scheduler_only = ...; let _ = ...;` form, which keeps the comparison,
///     compiles, passes clippy — and rejects nobody;
///   - a scan that reached the wrong file / a stripper that blanked the
///     declarations: zero parsed reducers is a hard failure, not a pass.
#[test]
fn g2_no_reducer_takes_identity_parameter() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    if let Err(reason) = g2_client_identity_violation(&squashed) {
        panic!("G2 (NO_CLIENT_IDENTITY) FAIL over accounts.rs: {reason}");
    }
}

/// G2 ([R/name-set]): the reducer surface of accounts.rs is EXACTLY the six
/// sanctioned names — pinned by sorted SET EQUALITY, never by a count and never
/// by containment.
///
/// SIX as of rb-24 (M22 S3): `account_deletion_reaper` is added, and it is the
/// conscious re-review this pin exists to force. It takes only the ctx handle
/// and the SAME-FILE scheduled struct, it derives no identity from client text,
/// and its body opens with the rejecting scheduler guard — the three questions
/// ADR-0179 G2 asks of a new entry point, each pinned by its own rb24_ test. The
/// JS ledger needs NO edit for this name: `REDUCER_SANCTIONS` in
/// `evals/guest-claim-integrity.eval.mjs` already lists it with
/// `status: 'PLANNED'` and `PLANNED_PIN` already contains it, which is exactly
/// the permitted-when-present notion that file was restructured to provide.
///
/// Every reducer in this module is a client-reachable entry point into the
/// re-key machinery, so ADDING one is a security-relevant event that must be
/// re-reviewed right here; a MISSING name means a client entry point silently
/// disappeared. The maintenance tax (one conscious line per new reducer) is the
/// intended cost.
///
/// Kills: both proven takeover bypasses, which are ADDITIVE reducers — a `>= 6`
///        count check and an "each expected name is present" check are green on
///        both; a rotted enumerator that parses zero reducers (the empty set is
///        itself a set mismatch).
#[test]
fn g2_reducer_name_set_is_pinned() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let mut found: Vec<String> = parse_reducers(&squashed)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    found.sort();
    let expected: Vec<String> = vec![
        concat!("account_deletion", "_reaper").to_string(),
        concat!("cancel_account", "_deletion").to_string(),
        concat!("complete_guest", "_claim").to_string(),
        concat!("delete", "_account").to_string(),
        concat!("guest_claim", "_reaper").to_string(),
        concat!("start_guest", "_claim").to_string(),
    ];
    assert_eq!(
        found, expected,
        "G2 [R/name-set]: the enumerated reducer surface of accounts.rs changed. \
         Set equality, not a count and not containment: the two PROVEN takeover \
         bypasses are ADDITIVE reducers. If this addition/removal is intended, \
         re-review the new entry point against ADR-0179 G2 (does it take only \
         wire-safe scalars? does it derive identity from ctx.sender() alone?) and \
         then update this pin CONSCIOUSLY."
    );
}

/// G2 ([R/identity-ctor], E2 defense): accounts.rs never CONSTRUCTS an Identity.
///
/// Every identity this module handles comes from `ctx.sender()` or from a row it
/// read. `Identity::from_hex` is `pub` in spacetimedb-lib, which is what makes
/// E2 a two-line unauthenticated account-takeover reducer: a wire-safe `String`
/// parameter plus an `Identity::from_hex` call on it in the body. The parameter
/// analysis above never sees it, because the parameter is perfectly wire-safe.
///
/// Kills: E2 in every spelling of the constructor.
#[test]
fn g2_no_identity_constructor() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    for ctor in identity_ctor_needles() {
        assert!(
            !squashed.contains(ctor.as_str()),
            "G2 [R/identity-ctor]: accounts.rs calls `{ctor}` — nothing in this module \
             legitimately constructs an Identity. A red-team PROVED the constructor is \
             the whole attack: a reducer taking a wire-safe `String` hex code, turning \
             it into an Identity and re-keying that identity's monsters, inventory, \
             wallet, NPC state and profile onto ctx.sender(). Derive identity from \
             ctx.sender() or from a row you read, never from client text."
        );
    }
}

/// G5 (MODULE_WRITE_ISOLATION, D0): every `.insert(`/`.update(`/`.delete(` in
/// accounts.rs is chained off one of the three tables this module OWNS
/// (`account`, `guest_claim`, `guest_claim_reaper_schedule`). A write to any
/// pre-existing table must be delegated to that table's owning module.
///
/// The extractor walks every write verb, finds the nearest preceding `ctx.db.`,
/// and reads the accessor name — asserting it is in the owned set.
///
/// Kills (proof-of-teeth): add a direct `monster` (or any other pre-existing
/// table) write chain in accounts.rs instead of delegating — the extracted
/// accessor is outside the owned set.
#[test]
fn g5_writes_only_owned_tables() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let targets = write_target_accessors(&squashed);
    let allowed = allowed_write_tables();
    assert!(
        !targets.is_empty(),
        "G5: expected accounts.rs to contain at least one owned-table write."
    );
    for t in &targets {
        assert!(
            allowed.iter().any(|a| a == t),
            "G5/D0: accounts.rs writes table `{t}` which is NOT one of the three owned tables \
             {allowed:?}. Every write to a pre-existing table must be delegated to its owning \
             module."
        );
    }
}

/// G5 helper: the accessor name behind every `ctx.db.<t>()....(insert|update|delete)(`
/// write verb in an already-squashed source.
fn write_target_accessors(squashed: &str) -> Vec<String> {
    let prefix = concat!("ctx", ".db.");
    let verbs = [
        concat!(".ins", "ert(").to_string(),
        concat!(".upd", "ate(").to_string(),
        concat!(".del", "ete(").to_string(),
    ];
    let mut acc = Vec::new();
    for verb in &verbs {
        let mut start = 0;
        while let Some(rel) = squashed[start..].find(verb.as_str()) {
            let vpos = start + rel;
            if let Some(dbrel) = squashed[..vpos].rfind(prefix) {
                let after = &squashed[dbrel + prefix.len()..];
                let name: String = after
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if !name.is_empty() {
                    acc.push(name);
                }
            }
            start = vpos + verb.len();
        }
    }
    acc
}

/// G5 (D0): accounts.rs contains NO wallet accessor token at all — even a READ of
/// the wallet is banned outside economy.rs (currency-integrity ACCESSOR_BYPASS),
/// so `economy::wallet_exists` is the delegated seam.
#[test]
fn g5_no_wallet_accessor_in_accounts() {
    let kept = strip_comments_keep_strings(ACCOUNTS_RS);
    let token = ["player", "_wallet"].concat();
    assert!(
        !kept.contains(token.as_str()),
        "G5/D0: accounts.rs must not reference the wallet table directly (delegate to economy)."
    );
}

// ===========================================================================
// ACCOUNT LEGAL-STATE INVARIANT (ADR-0195 D1/D3) — `Account` permits illegal
// states by construction: `status: AccountStatus` plus an INDEPENDENT
// `deletion_requested_at_ms: Option<i64>`, and a half-settable
// `claimed_from`/`claimed_at_ms` pair. Folding those into the enum would change
// live column TYPES (non-additive under ADR-0006/ADR-0173 D5), so the invariant
// is expressed as ONE pure predicate that every Account-returning constructor
// `debug_assert!`s, plus an exact struct-shape tripwire that forces M22 to
// re-derive the predicate consciously when the shape moves.
//
// PROFILE INDEPENDENCE: the `debug_assert!`s compile out of release wasm
// (ADR-0049 policy), so the two tests below — a direct table-driven test of the
// predicate and the shape tripwire — are the teeth that exist in EVERY profile.
// ===========================================================================

/// W3-1 (pure, table-driven): `account_state_is_legal` accepts exactly the legal
/// (status, deletion stamp, claim pair) combinations and rejects every illegal
/// one.
///
/// The clauses:
///   - `Active` implies `deletion_requested_at_ms.is_none()`;
///   - `PendingDeletion` implies `deletion_requested_at_ms.is_some()`;
///   - `claimed_from.is_some() == claimed_at_ms.is_some()` (provenance is a
///     PAIR — a half-set pair is an account that was claimed at no time, or at a
///     time by nobody).
///
/// Kills: a predicate mutated to a constant `true` (the four illegal rows fire)
///        or to a constant `false` (the three legal rows fire) — this is the
///        mutation-cap defense, and it is the ONLY invariant test that survives
///        a release build where `debug_assert!` is a no-op;
///        a predicate that checks only the status half and leaves the claim pair
///        unconstrained (rows 6 and 7), or only the claim pair (rows 4 and 5).
#[test]
fn auth_account_state_invariant_table() {
    let cases: [(&str, Account, bool); 7] = [
        ("LEGAL: Active, no deletion stamp", base_account(1), true),
        (
            "LEGAL: PendingDeletion with a stamp",
            Account {
                status: AccountStatus::PendingDeletion,
                deletion_requested_at_ms: Some(50),
                ..base_account(1)
            },
            true,
        ),
        (
            "LEGAL: both halves of the claim provenance set",
            Account {
                claimed_from: Some(ident(2)),
                claimed_at_ms: Some(30),
                ..base_account(1)
            },
            true,
        ),
        (
            "ILLEGAL: Active but a deletion stamp survives",
            Account {
                status: AccountStatus::Active,
                deletion_requested_at_ms: Some(50),
                ..base_account(1)
            },
            false,
        ),
        (
            "ILLEGAL: PendingDeletion with no stamp",
            Account {
                status: AccountStatus::PendingDeletion,
                deletion_requested_at_ms: None,
                ..base_account(1)
            },
            false,
        ),
        (
            "ILLEGAL: claimed_from set, claimed_at_ms missing",
            Account {
                claimed_from: Some(ident(2)),
                claimed_at_ms: None,
                ..base_account(1)
            },
            false,
        ),
        (
            "ILLEGAL: claimed_at_ms set, claimed_from missing",
            Account {
                claimed_from: None,
                claimed_at_ms: Some(30),
                ..base_account(1)
            },
            false,
        ),
    ];

    for (label, account, expected) in cases {
        assert_eq!(
            account_state_is_legal(&account),
            expected,
            "W3-1: account_state_is_legal disagreed on the case {label:?}. The invariant \
             is: Active implies no deletion stamp; PendingDeletion implies a stamp; \
             claimed_from and claimed_at_ms are set together or not at all. A predicate \
             that answers the same thing for every input is not an invariant."
        );
    }
}

/// W3-2 (pure): all FIVE Account-returning constructors return a LEGAL state,
/// chained fresh -> touched -> requested -> cancelled -> claimed so each one is
/// fed a real predecessor rather than a hand-built fixture.
///
/// The `debug_assert!`s inside the constructors are debug-profile-only; these
/// assertions are not, which is why the chain is checked here as well as there.
///
/// Kills: `requested_deletion` setting `PendingDeletion` without stamping the
///        timestamp (or stamping without transitioning); `cancelled_deletion`
///        returning to `Active` while leaving the stamp behind;
///        `claimed_account` setting only one half of the provenance pair;
///        `new_account_row` minting a row that is already `PendingDeletion`.
///        The transition assertions alongside each legality check stop a
///        constructor that satisfies the invariant by doing NOTHING.
#[test]
fn auth_constructors_return_legal_states() {
    let fresh = new_account_row(ident(7), "issuer-under-test".to_string(), 100);
    assert!(
        account_state_is_legal(&fresh),
        "W3-2: new_account_row must return a legal state (Active, no deletion stamp, \
         no claim provenance). Got status {:?} / stamp {:?} / claim {:?}+{:?}",
        fresh.status,
        fresh.deletion_requested_at_ms,
        fresh.claimed_from,
        fresh.claimed_at_ms
    );

    let touched = touch_login(fresh.clone(), 200);
    assert!(
        account_state_is_legal(&touched),
        "W3-2: touch_login must return a legal state (it stamps last_login only)."
    );
    assert_eq!(
        touched.last_login_at_ms, 200,
        "W3-2 vacuity: touch_login must actually stamp the login time — a constructor \
         that returns its input unchanged satisfies every invariant trivially."
    );

    let requested = requested_deletion(touched.clone(), 300);
    assert!(
        account_state_is_legal(&requested),
        "W3-2: requested_deletion must return a legal state — PendingDeletion IMPLIES \
         a deletion timestamp. Got status {:?} / stamp {:?}",
        requested.status,
        requested.deletion_requested_at_ms
    );
    assert_eq!(
        requested.status,
        AccountStatus::PendingDeletion,
        "W3-2 vacuity: requested_deletion must transition the status."
    );
    assert_eq!(
        requested.deletion_requested_at_ms,
        Some(300),
        "W3-2 vacuity: requested_deletion must stamp the request time."
    );

    let cancelled = cancelled_deletion(requested.clone());
    assert!(
        account_state_is_legal(&cancelled),
        "W3-2: cancelled_deletion must return a legal state — Active IMPLIES no \
         deletion timestamp. Got status {:?} / stamp {:?}",
        cancelled.status,
        cancelled.deletion_requested_at_ms
    );
    assert_eq!(
        cancelled.status,
        AccountStatus::Active,
        "W3-2 vacuity: cancelled_deletion must transition the status back."
    );

    let claimed = claimed_account(cancelled.clone(), ident(8), 400);
    assert!(
        account_state_is_legal(&claimed),
        "W3-2: claimed_account must return a legal state — the provenance pair is set \
         together or not at all. Got claim {:?}+{:?}",
        claimed.claimed_from,
        claimed.claimed_at_ms
    );
    assert_eq!(
        claimed.claimed_from,
        Some(ident(8)),
        "W3-2 vacuity: claimed_account must stamp the claimed-from identity."
    );
    assert_eq!(
        claimed.claimed_at_ms,
        Some(400),
        "W3-2 vacuity: claimed_account must stamp the claim time."
    );
}

/// W3-4 (scan): the `Account` field list and the `AccountStatus` variant list are
/// pinned by EXACT EQUALITY against the current shape.
///
/// EXACT EQUALITY, never `.contains`: an APPENDED field survives every
/// containment check while silently widening the state space the invariant
/// reasons about. A reorder must red too: BSATN layout is order-sensitive.
///
/// M22-S2 RE-DERIVATION (spec §4.1). The shape move this tripwire was written to
/// intercept has happened: `Account` gains `terminal_at_ms: Option<i64>`,
/// appended LAST and carrying `#[default(None)]` so the column is additive under
/// ADR-0006. The pin below was re-derived FROM THE SPEC, not rubber-stamped to
/// match the code, and the re-derivation the tripwire's contract demands was
/// carried out rather than deferred: `account_state_is_legal` gained the clause
/// `terminal_at_ms.is_some()` implies (`PendingDeletion` AND
/// `deletion_requested_at_ms.is_some()`), driven by
/// `account_legal_state_rejects_terminal_without_request`,
/// `account_legal_state_rejects_terminal_while_active` and
/// `account_legal_state_accepts_legal_terminal_shape` at the end of this file.
/// The attribute is part of the pinned text on purpose — `#[default(None)]` is
/// what makes the column an automigration-safe append rather than a republish.
///
/// The extraction mirrors `auth6_no_email_or_subject_stored`'s (comments
/// stripped, string content preserved, whitespace squashed, brace-walked from
/// the struct marker), so a doc-comment edit on the struct — which ADR-0195 D5
/// explicitly expects, and which M22-S2 makes to `auth_issuer` — does NOT trip
/// this pin. Only the declaration text does.
///
/// Kills: appending a further field to `Account`, or adding a `Deleted,` variant
///        to `AccountStatus`, without re-deriving the legality predicate and the
///        five constructor postconditions; a containment-based pin (green on
///        both); appending `terminal_at_ms` WITHOUT `#[default(None)]`, or
///        inserting it mid-struct (either is a non-additive migration);
///        a containment pin that would also be green on both of those.
#[test]
fn schema_account_struct_shape_tripwire() {
    let schema = stripped_keep_strings(SCHEMA_RS);

    let account_marker = concat!("struct", "Account{");
    let fields = extract_squashed_fn_body(&schema, account_marker).unwrap_or_else(|| {
        panic!(
            "W3-4: the Account struct declaration was not found in schema.rs (marker \
             {account_marker:?} over the comment-stripped, whitespace-squashed source). \
             The tripwire cannot pin a shape it cannot read — this is a hard failure, \
             not a skip."
        )
    });
    let expected_fields = concat!(
        "#[primary",
        "_key]",
        "pubidentity:Identity,",
        "pubauth_issuer:String,",
        "pubcreated_at_ms:i64,",
        "publast_login_at_ms:i64,",
        "pubstatus:AccountStatus,",
        "pubdeletion_requested_at_ms:Opt",
        "ion<i64>,",
        "pubclaimed_from:Opt",
        "ion<Identity>,",
        "pubclaimed_at_ms:Opt",
        "ion<i64>,",
        "#[def",
        "ault(None)]",
        "pubterminal_at_ms:Opt",
        "ion<i64>,",
    );
    assert_eq!(
        fields, expected_fields,
        "W3-4: Account's shape changed — re-derive account_state_is_legal + the \
         constructor debug_asserts (ADR-0195), then update this pin consciously. \
         A new field can widen the illegal-state space the predicate is blind to \
         (that is exactly how `deletion_requested_at_ms` came to float free of \
         `status`), and a field REORDER changes the BSATN layout of a live table."
    );

    let status_marker = concat!("enum", "AccountStatus{");
    let variants = extract_squashed_fn_body(&schema, status_marker).unwrap_or_else(|| {
        panic!(
            "W3-4: the AccountStatus enum declaration was not found in schema.rs \
             (marker {status_marker:?}). The tripwire cannot pin a variant list it \
             cannot read."
        )
    });
    assert_eq!(
        variants, "Active,PendingDeletion,",
        "W3-4: AccountStatus's variant list changed — re-derive account_state_is_legal \
         + the constructor debug_asserts (ADR-0195), then update this pin consciously. \
         Every new variant needs its own answer to `which timestamp fields must be set \
         in this state?`, and the predicate's match arms are where that answer lives."
    );
}

// ===========================================================================
// MACHINERY SELF-TEETH — prove the heavy extractors BITE. If these fail, the
// scans above cannot be trusted regardless of their results.
// ===========================================================================

/// Proves the string/comment strip pipeline blanks a needle hidden in a string
/// literal (the F1 evasion) and detects a genuine occurrence.
#[test]
fn machinery_strip_pipeline_teeth() {
    let needle = concat!("audience", "_allowed(");
    // GOOD: real call survives.
    let good = "fn f(){ if !audience_allowed(a, B) { return; } }";
    assert!(
        stripped_for_scan(good).contains(needle),
        "machinery: a genuine audience_allowed( call must survive stripping."
    );
    // EVASION: same text only inside a dead string literal must be blanked.
    let evasion = format!("fn f(){{ let _ = \"{}\"; return; }}", needle);
    assert!(
        !stripped_for_scan(&evasion).contains(needle),
        "machinery (F1): a needle inside a string literal must be blanked by strip_rust_strings."
    );
    // A URL's `//` must NOT be swallowed as a comment in the strings-kept view.
    let url = "const X: &str = \"https://example.invalid/\"; fn g(){}";
    assert!(
        stripped_keep_strings(url).contains(concat!("https:", "//example.invalid/")),
        "machinery: strip_comments_keep_strings must preserve a URL's // (not a comment)."
    );
}

/// Proves the partition extractor bites: a fixture that resolves the code BEFORE
/// the caller-state guards must FAIL the max-caller < min-code assertion, while a
/// correctly-ordered fixture passes.
#[test]
fn machinery_partition_teeth() {
    let has_jwt = "has_jwt(";
    let acct = concat!("account()", ".identity().find(");
    let code_find = concat!("guest", "_claim().code().find(");

    // GOOD: caller-state precedes code resolution.
    let good = format!(
        "fn f(){{ if !ctx.sender_auth().{has_jwt}) {{}} let a = ctx.db.{acct}me); \
         let c = ctx.db.{code_find}x); }}"
    );
    let gs = stripped_for_scan(&good);
    let gb = extract_squashed_fn_body(&gs, "fnf(").unwrap();
    assert!(
        idx(gb, acct) < idx(gb, code_find),
        "machinery: GOOD partition fixture should place the account lookup before code find."
    );

    // BAD: code resolution first — the partition boundary is inverted.
    let bad = format!(
        "fn f(){{ let c = ctx.db.{code_find}x); if !ctx.sender_auth().{has_jwt}) {{}} \
         let a = ctx.db.{acct}me); }}"
    );
    let bs = stripped_for_scan(&bad);
    let bb = extract_squashed_fn_body(&bs, "fnf(").unwrap();
    assert!(
        idx(bb, code_find) < idx(bb, acct),
        "machinery: the BAD fixture (code find first) must invert the partition — proving the \
         auth12_13_14 assertion would fire on this shape."
    );
}

/// Proves the G5 accessor extractor flags a forbidden-table write and accepts an
/// owned-table write.
#[test]
fn machinery_g5_accessor_teeth() {
    // BAD: a monster write — the whole chain assembled from parts so this file
    // never carries the contiguous dangerous needle.
    let chain = concat!("ctx.db.", "monster()", ".monster_id()", ".update(");
    let bad = format!("fn f(){{ {chain} m); }}");
    let bad_targets = write_target_accessors(&stripped_for_scan(&bad));
    assert!(
        bad_targets.iter().any(|t| t == "monster"),
        "machinery: the G5 extractor must surface a forbidden `monster` write accessor."
    );

    // GOOD: an account write is in the owned set.
    let good_chain = concat!("ctx.db.", "account()", ".ins", "ert(");
    let good = format!("fn f(){{ {good_chain} row); }}");
    let good_targets = write_target_accessors(&stripped_for_scan(&good));
    assert!(
        good_targets
            .iter()
            .all(|t| allowed_write_tables().iter().any(|a| a == t)),
        "machinery: an account write must be inside the owned-table allowlist."
    );
}

/// Proves the G12 log_reject argument extractor bites: a `format!`-with-`issuer`
/// reason is flagged; a static-const reason is clean.
#[test]
fn machinery_g12_log_reject_teeth() {
    // BAD: a formatted reason echoing the raw issuer claim.
    let bad = format!(
        "fn f(){{ {}(\"r\", s, &{}(\"issuer {{}} bad\", issuer)); }}",
        concat!("log", "_reject"),
        concat!("form", "at!")
    );
    let bad_spans = log_reject_arg_spans(&stripped_for_scan(&bad));
    assert_eq!(
        bad_spans.len(),
        1,
        "machinery: one log_reject span expected in the BAD fixture."
    );
    assert!(
        bad_spans[0].contains("issuer") && bad_spans[0].contains(concat!("form", "at!")),
        "machinery: the G12 extractor must surface `issuer` and `format!` in the BAD span."
    );

    // GOOD: a static const reason — no claim identifier, no format!.
    let good = format!(
        "fn f(){{ {}(\"r\", s, REASON_CONST); }}",
        concat!("log", "_reject")
    );
    let good_spans = log_reject_arg_spans(&stripped_for_scan(&good));
    assert_eq!(
        good_spans.len(),
        1,
        "machinery: one log_reject span expected in the GOOD fixture."
    );
    for claim in ["issuer", "subject", "audience", "claims"] {
        assert!(
            !good_spans[0].contains(claim),
            "machinery: a static-const reason must carry no claim identifier ({claim})."
        );
    }
    assert!(
        !good_spans[0].contains(concat!("form", "at!")),
        "machinery: a static-const reason must carry no format!."
    );
}

// ---------------------------------------------------------------------------
// G2 ENUMERATOR SELF-TEETH (ADR-0195 D6) — every fixture below is a SQUASHED
// synthetic source, fragment-assembled with `concat!` so this test file can
// never self-match when an eval concatenates the whole `server-module` src tree
// and comment-strips WITHOUT blanking string literals.
//
// Both polarities are covered on purpose: BAD fixtures prove the checker bites,
// GOOD fixtures prove it is not simply always-red (an always-red checker is
// indistinguishable from a working one until a GOOD fixture says otherwise).
// ---------------------------------------------------------------------------

/// The squashed reducer attribute, fragment-assembled once for every fixture.
fn fx_reducer_attr() -> &'static str {
    concat!("#[spacetimedb::", "reducer]")
}

/// Proves the source-derived enumerator sees BOTH reducers in a two-reducer
/// source and that the E1 struct-wrapped-Identity shape is FLAGGED while a
/// scalar-only reducer PASSES.
///
/// kills: the hardcoded five-needle loop this replaced (it cannot see an ADDED
///        reducer at all); a `contains(":Identity")` substring ban — the fixture
///        asserts that needle is absent from the E1 text, so the old check was
///        provably green on a code-less account-takeover reducer.
#[test]
fn machinery_g2_enumerator_and_e1_teeth() {
    let attr = fx_reducer_attr();
    let e1 = concat!(
        "pub",
        "fn",
        "complete_claim_for(ctx:&ReducerContext,target:ClaimTarget)",
        "->Result<(),String>{rekey(ctx,target.guest_identity,ctx.sender())}"
    );
    let clean = concat!(
        "pub",
        "fn",
        "set_nickname(ctx:&ReducerContext,nickname:String,slot:u8)",
        "->Result<(),String>{Ok(())}"
    );

    let both = [attr, e1, attr, clean].concat();
    let reducers = parse_reducers(&both);
    assert_eq!(
        reducers.len(),
        2,
        "machinery: BOTH attributed fns must be enumerated from source — an \
         enumerator that finds one is the hardcoded-list failure mode with extra \
         steps. Parsed: {reducers:?}"
    );
    assert_eq!(
        reducers[0].0, "complete_claim_for",
        "machinery: the walk-forward must land on the fn the attribute decorates."
    );
    assert_eq!(
        reducers[1].0, "set_nickname",
        "machinery: the second attribute must be found after the first fn's body."
    );
    assert_eq!(
        reducers[0].1,
        vec![
            ("ctx".to_string(), "&ReducerContext".to_string()),
            ("target".to_string(), "ClaimTarget".to_string()),
        ],
        "machinery: the parameter list must split at the depth-0 comma and at the \
         first non-`::` colon."
    );

    // The whole point of the positive allowlist: the OLD substring ban is
    // provably blind to this fixture.
    assert!(
        !both.contains(concat!(":Ident", "ity")),
        "machinery: the E1 fixture must contain NO `: Identity` parameter text — that \
         absence is exactly why a substring ban was green on a proven takeover."
    );

    let reason = g2_client_identity_violation(&both).expect_err(
        "machinery: a reducer taking a `SpacetimeType` struct with an Identity field \
         must be FLAGGED — it is a code-less transfer of any identity's game data.",
    );
    assert!(
        reason.contains("complete_claim_for") && reason.contains("ClaimTarget"),
        "machinery: the violation must NAME the reducer and the offending type. Got: \
         {reason:?}"
    );

    // GOOD: the scalar-only reducer alone must PASS.
    let good = [attr, clean].concat();
    if let Err(reason) = g2_client_identity_violation(&good) {
        panic!("machinery: a ctx + String + u8 reducer must PASS, got: {reason}");
    }
}

/// Proves the wire-safe allowlist accepts exactly the scalar surface (recursing
/// through `Option<..>` / `Vec<..>`) and rejects every composite.
///
/// kills: an allowlist widened to "anything that is not spelled Identity" — the
///        alias `Ident` and the struct `ClaimTarget` are both caught here by the
///        POSITIVE rule and by nothing else.
#[test]
fn machinery_g2_wire_safe_allowlist_teeth() {
    for good in [
        "String",
        "bool",
        "u8",
        "u128",
        "i64",
        "f32",
        "Option<i64>",
        "Vec<String>",
        "Option<Vec<u32>>",
    ] {
        assert!(
            is_wire_safe_type(good),
            "machinery: `{good}` is a wire-safe scalar (or a wrapper of one) and must \
             be accepted — a false RED here blocks legitimate reducers."
        );
    }
    for bad in [
        "Identity",
        "Option<Identity>",
        "Vec<Identity>",
        "ClaimTarget",
        "Ident",
        "&ReducerContext",
        "Option<ClaimTarget>",
    ] {
        assert!(
            !is_wire_safe_type(bad),
            "machinery: `{bad}` is NOT a wire-safe scalar — a composite argument is one \
             whose fields the server cannot vouch for, and the positive allowlist is \
             the only rule that catches a type ALIAS."
        );
    }
}

/// Proves the two client-supplied-Identity parameter shapes a substring ban
/// misses are both FLAGGED end-to-end through the checker.
///
/// kills: `guest: Option<Identity>` (the old `:Identity` needle never matched
///        `:Option<Identity>` — the fixture asserts that absence);
///        `guest: Ident`, a type alias that spells nothing at all.
#[test]
fn machinery_g2_identity_param_shapes_are_flagged() {
    let attr = fx_reducer_attr();

    let optioned = [
        attr,
        concat!(
            "pub",
            "fn",
            "adopt(ctx:&ReducerContext,guest:Opt",
            "ion<Identity>)->Result<(),String>{Ok(())}"
        ),
    ]
    .concat();
    assert!(
        !optioned.contains(concat!(":Ident", "ity")),
        "machinery: `:Option<Identity>` contains no `:Identity` substring — that is why \
         the substring ban had to go."
    );
    let reason = g2_client_identity_violation(&optioned)
        .expect_err("machinery: an `Option<Identity>` parameter must be FLAGGED.");
    assert!(
        reason.contains("adopt"),
        "machinery: the violation must name the reducer. Got: {reason:?}"
    );

    let aliased = [
        attr,
        concat!(
            "pub",
            "fn",
            "adopt(ctx:&ReducerContext,guest:Ident)->Result<(),String>{Ok(())}"
        ),
    ]
    .concat();
    assert!(
        !aliased.contains(concat!(":Ident", "ity")),
        "machinery: a `type Ident = Identity;` alias spells no Identity anywhere."
    );
    let reason = g2_client_identity_violation(&aliased).expect_err(
        "machinery: a type-alias identity parameter must be FLAGGED by the positive \
         wire-safe allowlist.",
    );
    assert!(
        reason.contains("adopt") && reason.contains("Ident"),
        "machinery: the violation must name the reducer and the alias. Got: {reason:?}"
    );
}

/// Proves an EMPTY enumeration is a hard failure, never a vacuous pass (the Rust
/// twin of the eval's `[R/name-set]` non-vacuity guard).
///
/// kills: commenting out every reducer attribute (or pointing the scan at the
///        wrong file, or a stripper that blanks the declarations) and reading the
///        resulting silence as "no reducer takes an Identity".
#[test]
fn machinery_g2_empty_enumeration_fails_loud() {
    let reason = g2_client_identity_violation("")
        .expect_err("machinery: an EMPTY source must FAIL — every clause is vacuous on it.");
    assert!(
        reason.contains("[R/name-set]"),
        "machinery: the empty set must be reported as a name-set failure. Got: {reason:?}"
    );

    // The realistic spelling of the same hole: the attributes are all commented
    // out, so the stripped source carries none of them.
    let commented_out = format!(
        "//{}\npub fn f(ctx: &ReducerContext) {{}}",
        fx_reducer_attr()
    );
    let squashed = stripped_for_scan(&commented_out);
    assert!(
        parse_reducers(&squashed).is_empty(),
        "machinery: the fixture must strip to zero reducers for this case to be the \
         empty-set case at all."
    );
    let reason = g2_client_identity_violation(&squashed)
        .expect_err("machinery: an all-commented-out reducer surface must FAIL LOUD.");
    assert!(reason.contains("[R/name-set]"), "machinery: got {reason:?}");
}

/// GOOD fixtures — the three legal shapes that must NOT red.
///
/// kills: a strict "nothing but optional `pub` between the attribute and the fn"
///        walk (`trading.rs` already stacks `#[allow(clippy::too_many_arguments)]`
///        on a reducer, so that rule false-REDs on arrival);
///        a comma split that classifies rustfmt's trailing empty segment as a
///        non-scalar parameter (the live `guest_claim_reaper` signature is
///        wrapped and carries that comma today);
///        a paren-walk that runs past the parameter list into the return type
///        and flags `-> Result<Identity, String>` (return values are not client
///        input — JS parity).
#[test]
fn machinery_g2_good_fixtures_pass() {
    let attr = fx_reducer_attr();

    let stacked = [
        attr,
        "#[allow(clippy::too_many_arguments)]",
        concat!(
            "pub",
            "fn",
            "noisy(ctx:&ReducerContext,a:u8,b:u8,c:u8)->Result<(),String>{Ok(())}"
        ),
    ]
    .concat();
    let parsed = parse_reducers(&stacked);
    assert_eq!(
        parsed.len(),
        1,
        "machinery: a stacked attribute must not hide the reducer. Parsed: {parsed:?}"
    );
    assert_eq!(parsed[0].0, "noisy", "machinery: wrong fn name parsed.");
    assert_eq!(
        parsed[0].1.len(),
        4,
        "machinery: ctx + three scalars = four parameters. Parsed: {:?}",
        parsed[0].1
    );
    if let Err(reason) = g2_client_identity_violation(&stacked) {
        panic!("machinery: the stacked-attribute reducer must PASS, got: {reason}");
    }

    let trailing = [
        attr,
        concat!(
            "pub",
            "fn",
            "wrapped(ctx:&ReducerContext,code:String,slot:u8,)->Result<(),String>{Ok(())}"
        ),
    ]
    .concat();
    let parsed = parse_reducers(&trailing);
    assert_eq!(
        parsed[0].1.len(),
        3,
        "machinery: rustfmt's trailing comma leaves an EMPTY segment that must be \
         skipped, not classified as a non-scalar parameter. Parsed: {:?}",
        parsed[0].1
    );
    if let Err(reason) = g2_client_identity_violation(&trailing) {
        panic!("machinery: the trailing-comma signature must PASS, got: {reason}");
    }

    let returning = [
        attr,
        concat!(
            "pub",
            "fn",
            "mint(ctx:&ReducerContext,seed:String)->Result<Identity,String>{Ok(ctx.sender())}"
        ),
    ]
    .concat();
    let parsed = parse_reducers(&returning);
    assert_eq!(
        parsed[0].1.len(),
        2,
        "machinery: the paren-walk must stop at the balanced close of the PARAMETER \
         list. Parsed: {:?}",
        parsed[0].1
    );
    assert!(
        !parsed[0].1.iter().any(|(_, t)| t.contains("Result")),
        "machinery: no return-type text may leak into the parameter list. Parsed: {:?}",
        parsed[0].1
    );
    if let Err(reason) = g2_client_identity_violation(&returning) {
        panic!(
            "machinery: an Identity in the RETURN type is out of scope (params only, \
                JS parity), got: {reason}"
        );
    }
}

/// Proves the scheduled-struct carve-out is gated on the REJECTING guard, not on
/// the mere presence of the comparison.
///
/// kills: neutering `guest_claim_reaper`'s guard to
///        `let scheduler_only = ctx.sender() != ctx.database_identity(); let _ = scheduler_only;`
///        — it keeps the comparison, compiles, passes clippy, and rejects NOBODY,
///        so any client can invoke the scheduled reducer with a hand-built row
///        naming any victim identity;
///        a carve-out widened to "any struct argument" (the GOOD half proves the
///        legitimate shape still passes, so the fix for the BAD half cannot be
///        `always red`).
#[test]
fn machinery_g2_scheduler_carveout_teeth() {
    let table_attr = concat!(
        "#[spacetimedb::",
        "table(",
        "accessor=x_schedule,",
        "sched",
        "uled(",
        "reap_x))]"
    );
    let struct_decl = concat!("pub", "struct", "XSchedule{pubid:u64,}");
    let attr = fx_reducer_attr();
    let sig = concat!(
        "pub",
        "fn",
        "reap_x(ctx:&ReducerContext,args:XSchedule)->Result<(),String>{"
    );
    let rejecting_guard = concat!(
        "ifctx.sender()!=",
        "ctx.database_identity(){",
        "returnErr(e);}"
    );
    let neutered_guard =
        "letscheduler_only=ctx.sender()!=ctx.database_identity();let_=scheduler_only;";
    let tail = "delete_x(ctx,args.id);}";

    assert_eq!(
        parse_scheduled_targets(&[table_attr, struct_decl].concat()),
        vec![("reap_x".to_string(), "XSchedule".to_string())],
        "machinery: the scheduled table must map to the struct that follows it — \
         without that mapping the carve-out below can never apply and the gate is \
         merely always-red."
    );

    let bad = [table_attr, struct_decl, attr, sig, neutered_guard, tail].concat();
    let reason = g2_client_identity_violation(&bad).expect_err(
        "machinery: the scheduled struct argument must be REJECTED when the body \
         carries no rejecting early return.",
    );
    assert!(
        reason.contains("reap_x") && reason.contains("scheduler guard"),
        "machinery: the violation must name the reducer and the missing guard. Got: \
         {reason:?}"
    );

    let good = [table_attr, struct_decl, attr, sig, rejecting_guard, tail].concat();
    if let Err(reason) = g2_client_identity_violation(&good) {
        panic!(
            "machinery: the legitimate scheduled reducer (same-file scheduled table, \
             param type EQUAL to the scheduled struct, rejecting guard present) must \
             PASS, got: {reason}"
        );
    }
}

/// Proves the enumerator PANICS instead of `continue`-ing when an attribute is
/// not followed by any `fn` (ADR-0195 D7 fail-loud).
///
/// kills: a `continue` that silently drops an attribute the parser did not
///        understand — an unparsed reducer is an UNGATED reducer, and the
///        remaining clauses would report `clean` about a surface they never saw.
#[test]
#[should_panic(expected = "G2 PARSE FAIL")]
fn machinery_g2_attribute_without_fn_panics() {
    let orphan = [
        fx_reducer_attr(),
        concat!("pub", "structNotAFunction{puba:u8,}"),
    ]
    .concat();
    let _ = parse_reducers(&orphan);
}

/// Proves an unbalanced parameter list PANICS rather than parsing as
/// `no parameters` (which would be a silent pass for every clause).
#[test]
#[should_panic(expected = "UNBALANCED")]
fn machinery_g2_unbalanced_param_list_panics() {
    let truncated = [
        fx_reducer_attr(),
        concat!("pub", "fn", "half(ctx:&ReducerContext,code:String"),
    ]
    .concat();
    let _ = parse_reducers(&truncated);
}

/// Proves the `]`/`(` attribute-disambiguation guard in `parse_reducers`
/// discriminates: a longer identifier that merely STARTS with `reducer`
/// (`spacetimedb::reducer_helper`) attached to a `pub fn` is NOT enumerated,
/// while a real `spacetimedb::reducer` fn in the SAME fixture IS. The fixture
/// carries both so it proves the guard discriminates, not that it drops
/// everything.
///
/// kills: dropping the `after != Some(b']') && after != Some(b'(')` check, which
///        would treat every `reducer`-prefixed attribute (a `reducer_helper`
///        derive/macro, say) as a reducer — enumerating a fn that is NOT a
///        client entry point, poisoning both the exact name-set pin and the
///        wire-safe param scan with a phantom reducer.
#[test]
fn machinery_g2_attr_disambiguation_guard_teeth() {
    let helper_attr = concat!("#[spacetimedb::", "reducer_helper]");
    let helper_fn = concat!(
        "pub",
        "fn",
        "not_a_reducer(ctx:&ReducerContext)->Result<(),String>{Ok(())}"
    );
    let real_attr = fx_reducer_attr();
    let real_fn = concat!(
        "pub",
        "fn",
        "real_one(ctx:&ReducerContext,code:String)->Result<(),String>{Ok(())}"
    );

    let fixture = [helper_attr, helper_fn, real_attr, real_fn].concat();
    let names: Vec<String> = parse_reducers(&fixture)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        names,
        vec!["real_one".to_string()],
        "machinery: the `]`/`(` guard must enumerate ONLY the real \
         `spacetimedb::reducer` fn. A longer identifier that merely starts with \
         `reducer` (`spacetimedb::reducer_helper`) is NOT a client-callable \
         reducer and must not be classified as one — otherwise a phantom fn \
         poisons the name-set pin and the param scan. Enumerated: {names:?}"
    );
}

// ===========================================================================
// M22-S2 — DATA-LIFECYCLE MANIFEST / export_bundle SHAPE / TERMINAL COLUMN.
//
// Spec: M22-privacy-compliance.spec.md §3 (the exhaustive 38-table deletion
// partition), §4.1 (`Account.terminal_at_ms`), §5 (export scope + the
// `export_bundle` chunk contract). Ledger gates X1..X8.
//
// WHY THIS SECTION ADDS SIXTEEN MORE `include_str!` CONSTS: the five at :260-264
// were sized for the M21a surface. Measured on the fork tree
// (00de7055aba717a3d7fe20efaaeed9330e5df50c), {accounts, lib, schema,
// monster_mgmt, ranking}.rs declare 31 of the 38 live tables — a totality census
// built on that set is GREEN while seven tables (mr_heartbeat_schedule,
// playtest_event, playtest_reaper_schedule, movement_tick_schedule,
// trade_offer_reaper_schedule, pvp_deadline_schedule,
// battle_challenge_reaper_schedule) carry no deletion policy at all. The census
// below therefore scans the crate root plus EVERY `mod` the crate declares, and
// pins that list against the live `mod` declarations in both directions.
//
// SCAN HYGIENE — this file's header rules apply verbatim to everything below:
//   * the table-attribute macro is NEVER written contiguously (assembled with
//     `concat!`), so an eval that concatenates `server-module/src` and
//     comment-strips WITHOUT blanking string literals cannot mistake this test
//     file for a table declaration;
//   * the wallet table name is split the same way — the file header declares
//     that this file carries no contiguous wallet token, and although
//     currency-integrity's ACCESSOR_BYPASS bans only the wallet ACCESSOR call
//     and the wallet struct literal, the declared convention is honoured;
//   * no block-comment delimiter of any kind appears in this section.
// ===========================================================================

use crate::schema::{DataLifecycleEntry, DeletionPolicy, DATA_LIFECYCLE_MANIFEST};

// --- Additional frozen sources under scan (crate root + every lib.rs `mod`) ---
const M22_BATTLE_RS: &str = include_str!("battle.rs");
const M22_CONTENT_RS: &str = include_str!("content.rs");
const M22_CONTENT_CACHE_RS: &str = include_str!("content_cache.rs");
const M22_ECONOMY_RS: &str = include_str!("economy.rs");
const M22_EVOLUTION_RS: &str = include_str!("evolution.rs");
const M22_GUARDS_RS: &str = include_str!("guards.rs");
const M22_INVENTORY_RS: &str = include_str!("inventory.rs");
const M22_MARSHAL_RS: &str = include_str!("marshal.rs");
const M22_MOVEMENT_RS: &str = include_str!("movement.rs");
const M22_NPC_RS: &str = include_str!("npc.rs");
const M22_OBSERVABILITY_RS: &str = include_str!("observability.rs");
const M22_PLAYTEST_RS: &str = include_str!("playtest.rs");
const M22_PRIVACY_RS: &str = include_str!("privacy.rs");
const M22_PVP_RS: &str = include_str!("pvp.rs");
const M22_RAISING_RS: &str = include_str!("raising.rs");
const M22_TAMING_RS: &str = include_str!("taming.rs");
const M22_TRADING_RS: &str = include_str!("trading.rs");

/// The JS re-key manifest, read as TEXT (never imported): T9 proves the two
/// manifests cannot drift apart on a table rename or split.
const M22_REKEY_EVAL_MJS: &str = include_str!("../../evals/guest-claim-integrity.eval.mjs");

// ---------------------------------------------------------------------------
// M22 scan machinery. Every helper is `m22_`-prefixed so it can never collide
// with a same-named helper elsewhere in this 3000-line file.
// ---------------------------------------------------------------------------

/// The squashed table-attribute prefix, split so this file never carries the
/// contiguous scanner needle (file header rule).
fn m22_nd_table_attr() -> String {
    concat!("#[spacetimedb::", "table", "(").to_string()
}

/// The squashed first attribute argument every live table declaration must
/// carry (`parseTableSchemas` and `[G6/parse]` both require it FIRST).
fn m22_nd_accessor() -> String {
    concat!("access", "or=").to_string()
}

/// Non-overlapping occurrences of `needle` in `hay`.
fn m22_count_occurrences(hay: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut n = 0usize;
    let mut start = 0usize;
    while let Some(rel) = hay[start..].find(needle) {
        n += 1;
        start += rel + needle.len();
    }
    n
}

/// Every non-test Rust source in the crate that CAN declare a table: the crate
/// root plus each `mod` lib.rs declares. A table can only exist in a compiled
/// module, and every compiled module is reachable from this list — which
/// `data_lifecycle_manifest_totality_bidirectional` re-proves against the live
/// `mod` declarations in both directions rather than asserting it in prose.
fn m22_scanned_sources() -> Vec<(&'static str, &'static str)> {
    vec![
        ("lib.rs", LIB_RS),
        ("accounts.rs", ACCOUNTS_RS),
        ("battle.rs", M22_BATTLE_RS),
        ("content.rs", M22_CONTENT_RS),
        ("content_cache.rs", M22_CONTENT_CACHE_RS),
        ("economy.rs", M22_ECONOMY_RS),
        ("evolution.rs", M22_EVOLUTION_RS),
        ("guards.rs", M22_GUARDS_RS),
        ("inventory.rs", M22_INVENTORY_RS),
        ("marshal.rs", M22_MARSHAL_RS),
        ("monster_mgmt.rs", MONSTER_MGMT_RS),
        ("movement.rs", M22_MOVEMENT_RS),
        ("npc.rs", M22_NPC_RS),
        ("observability.rs", M22_OBSERVABILITY_RS),
        ("playtest.rs", M22_PLAYTEST_RS),
        ("privacy.rs", M22_PRIVACY_RS),
        ("pvp.rs", M22_PVP_RS),
        ("raising.rs", M22_RAISING_RS),
        ("ranking.rs", RANKING_RS),
        ("schema.rs", SCHEMA_RS),
        ("taming.rs", M22_TAMING_RS),
        ("trading.rs", M22_TRADING_RS),
    ]
}

/// Every table-attribute accessor name declared in one source, read from the
/// string-blanked, comment-blanked, whitespace-squashed view (so a table name
/// quoted inside a doc comment or a string literal can never inject a phantom
/// entry into the census).
///
/// FAIL LOUD, never skip: an attribute whose FIRST argument is not `accessor =`
/// is exactly the spelling `parseTableSchemas` cannot read, which hides that
/// table from `[G6/parse]`, from the schema baseline AND from this census at
/// once. Refusing to classify is the safe direction.
fn m22_table_accessors(path: &str, src: &str) -> Vec<String> {
    let squashed = stripped_for_scan(src);
    let attr = m22_nd_table_attr();
    let accessor = m22_nd_accessor();
    let mut out: Vec<String> = Vec::new();
    let mut start = 0usize;
    while let Some(rel) = squashed[start..].find(attr.as_str()) {
        let at = start + rel + attr.len();
        let rest = &squashed[at..];
        let tail = match rest.strip_prefix(accessor.as_str()) {
            Some(tail) => tail,
            None => {
                let preview: String = rest.chars().take(60).collect();
                panic!(
                    "T1 fail-loud: a table attribute in {path} does not open with the \
                     accessor argument. parseTableSchemas requires `accessor =` to be the \
                     FIRST attribute argument; a declaration it cannot read hides that \
                     table from the re-key manifest, from the schema baseline and from \
                     this deletion-policy census simultaneously. Attribute text: {preview:?}"
                )
            }
        };
        let mut name = String::new();
        for c in tail.chars() {
            if !is_word_char(c) {
                break;
            }
            name.push(c);
        }
        assert!(
            !name.is_empty(),
            "T1 fail-loud: a table attribute in {path} declares an EMPTY accessor name."
        );
        out.push(name);
        start = at;
    }
    out
}

/// Every `mod <name>;` declared anywhere in the scanned sources, minus the
/// `#[path]`-included sibling test modules (whose names all end in `tests`).
///
/// Line-oriented over the comment-blanked, string-blanked source: a commented
/// out `mod` and a `mod` spelled inside a string literal are both invisible,
/// while `pub mod` / `pub(crate) mod` are both seen. Inline `mod x { .. }`
/// blocks declare no FILE and are correctly ignored (no trailing `;`).
fn m22_declared_mod_names() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, src) in m22_scanned_sources() {
        let clean = strip_rust_comments(&strip_rust_strings(src));
        for line in clean.lines() {
            let mut text = line.trim();
            if let Some(rest) = text.strip_prefix("pub(crate)") {
                text = rest.trim_start();
            } else if let Some(rest) = text.strip_prefix("pub ") {
                text = rest.trim_start();
            }
            let rest = match text.strip_prefix("mod ") {
                Some(rest) => rest.trim(),
                None => continue,
            };
            let name = match rest.strip_suffix(';') {
                Some(name) => name.trim(),
                None => continue,
            };
            if name.is_empty() || !name.chars().all(is_word_char) {
                continue;
            }
            if name.ends_with("tests") {
                continue;
            }
            out.push(name.to_string());
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Delete every `/` and every whitespace character from RAW source. This is the
/// only view in which a doc phrase that rustfmt wrapped across two `///` lines
/// reads as ONE token, which is what makes a stale-comment ban unfoolable by a
/// re-wrap.
fn m22_squashed_no_slashes(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    for c in src.chars() {
        if c.is_whitespace() || c == '/' {
            continue;
        }
        out.push(c);
    }
    out
}

/// The contiguous run of `///` doc lines immediately preceding the line that
/// declares `field_decl`, joined with single spaces.
///
/// LOCALIZED ON PURPOSE (red-team finding): a whole-file `contains` check for
/// the tombstone sentinel is satisfied by that sentinel appearing ANYWHERE in
/// schema.rs — in the new manifest's `basis` prose, say — while the field's own
/// comment stays stale-but-reworded. The caller separately proves `field_decl`
/// occurs exactly once, so "the block before it" is unambiguous.
fn m22_doc_block_before(src: &str, field_decl: &str) -> String {
    let at = src.find(field_decl).unwrap_or_else(|| {
        panic!(
            "T6 fail-loud: the declaration {field_decl:?} was not found in schema.rs, so \
             the localized doc-comment scan has no scope and would pass vacuously."
        )
    });
    let line_start = match src[..at].rfind('\n') {
        Some(i) => i + 1,
        None => 0,
    };
    let mut block: Vec<&str> = Vec::new();
    for line in src[..line_start].lines().rev() {
        let text = line.trim();
        if !text.starts_with("///") {
            break;
        }
        block.push(text);
    }
    block.reverse();
    block.join(" ")
}

/// Blank every `//`-to-end-of-line comment in a JS source.
///
/// Deliberately naive about strings: it is applied ONLY so the brace walk and
/// the key scan below cannot be derailed by comment prose. Verified against the
/// live manifest block, whose value strings contain no line-comment delimiter —
/// but whose COMMENT prose does contain apostrophes, and one apostrophe inside a
/// comment silently swallowed the `battle_challenge.target` key when this scan
/// was first drafted without the strip.
fn m22_strip_js_line_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut in_comment = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            in_comment = false;
            out.push(b'\n');
            i += 1;
            continue;
        }
        if !in_comment && bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            in_comment = true;
            i += 2;
            continue;
        }
        if !in_comment {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8(out).expect("comment-stripped JS source must be valid UTF-8")
}

/// Is `s` shaped like a `table.column` manifest key?
fn m22_is_table_column_key(s: &str) -> bool {
    let mut dots = 0usize;
    for c in s.chars() {
        if c == '.' {
            dots += 1;
            continue;
        }
        if !is_word_char(c) {
            return false;
        }
    }
    if dots != 1 {
        return false;
    }
    match s.split_once('.') {
        Some((table, column)) => !table.is_empty() && !column.is_empty(),
        None => false,
    }
}

/// Every `'table.column':` key inside the JS `REKEY_MANIFEST` object literal.
///
/// The block is delimited by a brace walk from the sole
/// `REKEY_MANIFEST = freezeManifest({` anchor; a key is a single-quoted span
/// immediately followed by `:` that is shaped like a column key, so the object
/// VALUES — which are also single-quoted, and one of which is double-quoted and
/// contains two apostrophes — cannot be mistaken for keys.
fn m22_rekey_manifest_keys() -> Vec<String> {
    let src = m22_strip_js_line_comments(M22_REKEY_EVAL_MJS);
    let anchor = concat!("REKEY_MAN", "IFEST = freezeManifest({");
    let at = src.find(anchor).unwrap_or_else(|| {
        panic!(
            "T9 fail-loud: the anchor {anchor:?} was not found in \
             evals/guest-claim-integrity.eval.mjs. The JS manifest moved or was renamed; \
             the cross-manifest consistency proof has no input and must NOT pass vacuously."
        )
    });
    let open = at + anchor.len() - 1;
    let bytes = src.as_bytes();
    assert_eq!(
        bytes[open], b'{',
        "T9 fail-loud: the anchor did not land on the object literal's opening brace."
    );
    let mut depth = 0usize;
    let mut end = open;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = i;
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    assert!(
        end > open,
        "T9 fail-loud: the REKEY_MANIFEST object literal is not brace-balanced from its \
         anchor, so the key scan would read an arbitrary suffix of the file."
    );

    let block = &src[open..end];
    let block_bytes = block.as_bytes();
    let mut keys: Vec<String> = Vec::new();
    let mut k = 0usize;
    while k < block_bytes.len() {
        if block_bytes[k] != b'\'' {
            k += 1;
            continue;
        }
        let mut j = k + 1;
        while j < block_bytes.len() && block_bytes[j] != b'\'' {
            j += 1;
        }
        if j >= block_bytes.len() {
            break;
        }
        let span = &block[k + 1..j];
        let after = if j + 1 < block_bytes.len() {
            block_bytes[j + 1]
        } else {
            b' '
        };
        if after == b':' && m22_is_table_column_key(span) {
            keys.push(span.to_string());
        }
        k = j + 1;
    }
    keys
}

// ---------------------------------------------------------------------------
// T1 / X3 — MANIFEST TOTALITY, BIDIRECTIONAL.
// ---------------------------------------------------------------------------

/// T1 / X3: the set of live table-attribute accessor names across EVERY
/// non-test module of the crate equals the set of
/// `DATA_LIFECYCLE_MANIFEST` table keys, each exactly once on BOTH sides — and
/// the scanned file list is itself pinned to the crate's live `mod`
/// declarations in both directions, so the new-file blind spot is closed rather
/// than merely documented.
///
/// Spec §3 calls the classification an "exhaustive partition over all 38
/// tables". Exhaustive is a set-equality claim, and a set-equality claim needs
/// both directions: a forward-only check (every manifest key is a live table) is
/// green on a manifest that classifies three tables, and a reverse-only check
/// (every live table has an entry) is green on a manifest full of phantom rows
/// for tables that no longer exist.
///
/// Kills: dropping one entry (a live table with no policy — spec §4.4 walks the
///        manifest, not the schema, so an unlisted table is simply never
///        cascaded);
///        a phantom entry for a table that does not exist;
///        the SAME table listed twice on either side (a second entry with a
///        different policy is how a re-classification hides — the dup walk over
///        both sorted lists runs BEFORE the set compare so it cannot be
///        satisfied by coincidence);
///        deleting a table AND its entry in one diff to dodge classification
///        (the >= 39 floor);
///        adding a `mod` to the crate and leaving it out of this scan;
///        the pre-existing five-file `include_str!` set, which sees 31 of 38.
#[test]
fn data_lifecycle_manifest_totality_bidirectional() {
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;
    let sources = m22_scanned_sources();

    let mut census: Vec<String> = Vec::new();
    for (path, src) in &sources {
        for name in m22_table_accessors(path, src) {
            census.push(name);
        }
    }
    assert!(
        census.len() >= 39,
        "T1 non-vacuity: only {} table declarations were found across the {} scanned \
         modules; the tree carries 39 and rb-24 adds account_deletion_reaper_schedule. \
         A census that shrank is a census that stopped looking, and every set \
         comparison below would then be comparing two small sets.",
        census.len(),
        sources.len()
    );
    census.sort();

    let mut declared: Vec<String> = Vec::new();
    for entry in manifest {
        declared.push(entry.table.to_string());
    }
    assert!(
        declared.len() >= 40,
        "T1 ratchet: DATA_LIFECYCLE_MANIFEST has {} entries; the tree's 39 live tables \
         plus rb-24's `account_deletion_reaper_schedule` is 40. Set equality alone is \
         satisfied by deleting a table AND its entry in one diff, which is exactly how a \
         table dodges classification; this floor is the ADR-0006 additive ratchet \
         against that.",
        declared.len()
    );
    declared.sort();

    for pair in census.windows(2) {
        assert_ne!(
            pair[0], pair[1],
            "T1: the accessor `{}` is DECLARED by two live table attributes. The census \
             cannot be compared as a SET until the declarations are unique.",
            pair[0]
        );
    }
    for pair in declared.windows(2) {
        assert_ne!(
            pair[0], pair[1],
            "T1: the table `{}` has TWO DATA_LIFECYCLE_MANIFEST entries. A duplicate entry \
             is how a quiet re-classification hides: the stale row keeps every set-equality \
             check green while the cascade reads whichever row it finds first.",
            pair[0]
        );
    }

    assert_eq!(
        census, declared,
        "T1 / spec §3: the live table census and DATA_LIFECYCLE_MANIFEST's table keys are \
         not the same set. Every live table needs an explicit deletion policy (spec §3 is \
         an EXHAUSTIVE partition, and §4.4's cascade walks the manifest rather than the \
         schema), and every manifest entry must name a table that still exists. Add the \
         missing entry — or delete the stale one — in the SAME commit as the schema change."
    );

    // --- mod census: the scanned list IS the crate's module list ------------
    let mods = m22_declared_mod_names();
    assert!(
        mods.len() >= 20,
        "T1 extraction rot: only {} `mod` declarations were parsed out of the crate; lib.rs \
         alone declares 20. A mod census that cannot read the module list cannot close the \
         new-file blind spot it exists to close.",
        mods.len()
    );
    for name in &mods {
        let file = format!("{name}.rs");
        let scanned = sources.iter().any(|(path, _)| *path == file);
        assert!(
            scanned,
            "T1 (mod census): the crate declares `mod {name};` but `{file}` is NOT scanned \
             by `m22_scanned_sources`, so every table it declares is invisible to this \
             totality proof and would carry no deletion policy. Add the module to the scan \
             list AND give each of its tables a DATA_LIFECYCLE_MANIFEST entry."
        );
    }
    for (path, _) in &sources {
        if *path == "lib.rs" {
            continue;
        }
        let stem = path.trim_end_matches(".rs");
        let is_live_mod = mods.iter().any(|name| name == stem);
        assert!(
            is_live_mod,
            "T1 (mod census, reverse): `{path}` is scanned but no `mod {stem};` declares it \
             anywhere in the crate. Either the module was removed (drop it from the scan \
             list) or the scan list has drifted away from the crate it claims to cover."
        );
    }
}

// ---------------------------------------------------------------------------
// T2 / X4 — THE SPEC §3 PARTITION, PINNED BY VALUE.
// ---------------------------------------------------------------------------

/// T2 / X4: the four spec §3 name-sets, transcribed from the spec text (NOT
/// derived from the census) and pinned by SET EQUALITY per policy, plus all five
/// `ViaJoin` PAYLOADS pinned by exact parent value.
///
/// The four sets START from spec §3's own recount — "38 = 12 ERASE +
/// 4 ANONYMIZE, 5 JOIN-ONLY, 17 NOT-OWNED" — and the live tree is now 40
/// entries (13 ERASE, 4 ANONYMIZE, 5 JOIN-ONLY, 18 NOT-OWNED), because M22
/// adds two tables the §3 recount predates.
///
/// The `Erase` list carries one table beyond the spec's twelve: `export_bundle`.
/// A snapshot of personal data is itself personal data, so the export bundle is
/// erased by the same cascade that produced it (spec §5's 7-day TTL reaper is a
/// SECOND, independent expiry, not a substitute for the cascade).
///
/// The `NotOwned` list carries one beyond the spec's seventeen:
/// `account_deletion_reaper_schedule` (rb-24). It is scheduler bookkeeping, not
/// player data: the row holds only an auto-inc id, the fire instant the RUNTIME
/// reads, and the account identity — and it is the row whose own reducer runs
/// the cascade, so cascading over it would be a table deleting the schedule that
/// is mid-flight. Its two real lifecycles are both explicit and both elsewhere:
/// the runtime deletes the fired one-shot row (ADR-0126 D6), and
/// `cancel_account_deletion` disarms a pending one (PRV1-3, ADR-0126 D4, pinned
/// by `rb24_cancel_disarms_the_reaper`). `guest_claim_reaper_schedule` carries
/// the same policy for the same class of reason.
///
/// The five parents are pinned BY VALUE, not merely proven live: each was
/// verified against the real join column in source before being written here —
/// `character.entity_id` -> `player.entity_id` (schema.rs), `battle_wild.
/// battle_id` -> `battle.battle_id`, `pvp_deadline_schedule.battle_id` ->
/// `battle` (pvp.rs:130-141), `battle_challenge_reaper_schedule.challenge_id` ->
/// `battle_challenge` (pvp.rs:169-178), `trade_offer_reaper_schedule.trade_id`
/// -> `trade_offer` (trading.rs:113-122).
///
/// Kills: a quiet re-classification (moving `battle` from ANONYMIZE to ERASE
///        destroys settled ranked history that a surviving opponent's
///        `my_battle` view still resolves — spec §3);
///        moving `config` out of NOT-OWNED (a cascade that acts on it deletes
///        global game config, because its owner_identity is a zeroed singleton
///        default rather than a per-row key);
///        a wrong `ViaJoin` parent, which a liveness-only check admits: pointing
///        `battle_wild` at `battle_challenge` type-checks, names a live table
///        that is not itself ViaJoin, and orphans every wild-battle seed row;
///        counting instead of comparing (a `len() == 12` check is green on any
///        twelve tables).
#[test]
fn data_lifecycle_partition_matches_spec_section3() {
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;

    let mut erase: Vec<&str> = Vec::new();
    let mut anonymize: Vec<&str> = Vec::new();
    let mut join_only: Vec<(&str, &str)> = Vec::new();
    let mut not_owned: Vec<&str> = Vec::new();
    for entry in manifest {
        match entry.policy {
            DeletionPolicy::Erase => erase.push(entry.table),
            DeletionPolicy::Anonymize => anonymize.push(entry.table),
            DeletionPolicy::ViaJoin(parent) => join_only.push((entry.table, parent)),
            DeletionPolicy::NotOwned => not_owned.push(entry.table),
        }
    }
    erase.sort_unstable();
    anonymize.sort_unstable();
    join_only.sort_unstable();
    not_owned.sort_unstable();

    // Spec §3 ERASE (12) + this slice's own `export_bundle` (spec §5 / plan D2).
    let expected_erase = [
        "battle_action",
        "battle_challenge",
        "export_bundle",
        "heal_cooldown",
        "inventory",
        "monster",
        "monster_pub",
        "player_conversation",
        "player_dialogue_state",
        "player_quest",
        concat!("player", "_wallet"),
        "playtest_event",
        "trade_offer",
    ];
    assert_eq!(
        erase, expected_erase,
        "T2 / spec §3 ERASE: the row-deleted set is wrong. Spec §3 names exactly twelve \
         (monster, monster_pub, inventory, player_dialogue_state, player_quest, \
         player_conversation, heal_cooldown, the wallet, playtest_event, trade_offer, \
         battle_challenge, battle_action) and this slice adds `export_bundle` — a snapshot \
         of personal data is itself personal data. A table moved OUT of this set survives \
         the cascade; a table moved IN is deleted when the spec says it must survive."
    );

    let expected_anonymize = ["account", "battle", "player", "profile"];
    assert_eq!(
        anonymize, expected_anonymize,
        "T2 / spec §3 ANONYMIZE: exactly four rows survive with their identity/PII fields \
         overwritten — `player` (the anchor `character` and every still-live multi-user row \
         point at), `profile` (ADR-0119's explicit never-delete invariant), `account` \
         (auth_issuer becomes the tombstone SENTINEL, keeping the column non-nullable) and \
         `battle` (terminal PvP rows demonstrably persist, so a surviving opponent's \
         my_battle view must still resolve them months later)."
    );

    let expected_join_only = [
        ("battle_challenge_reaper_schedule", "battle_challenge"),
        ("battle_wild", "battle"),
        ("character", "player"),
        ("pvp_deadline_schedule", "battle"),
        ("trade_offer_reaper_schedule", "trade_offer"),
    ];
    assert_eq!(
        join_only, expected_join_only,
        "T2 / spec §3 JOIN-ONLY: the five structurally-invisible tables and their OWNING \
         PARENTS are pinned by value. These tables carry no Identity column, so \
         findIdentityColumns cannot see them and nothing else in the repo can re-derive the \
         parent. Each parent here was checked against the real join column: \
         character.entity_id -> player.entity_id, battle_wild.battle_id -> battle, \
         pvp_deadline_schedule.battle_id -> battle, \
         battle_challenge_reaper_schedule.challenge_id -> battle_challenge, \
         trade_offer_reaper_schedule.trade_id -> trade_offer."
    );

    let expected_not_owned = [
        concat!("account_deletion_reaper", "_schedule"),
        "config",
        "encounter",
        "evolution_path",
        "guest_claim",
        "guest_claim_reaper_schedule",
        "heal_location_row",
        "item_row",
        "movement_tick_schedule",
        "mr_heartbeat_schedule",
        "npc",
        "playtest_reaper_schedule",
        "shop_item_row",
        "shop_row",
        "skill_row",
        "species_row",
        "type_relation_row",
        "zone_def",
    ];
    assert_eq!(
        not_owned, expected_not_owned,
        "T2 / spec §3 NOT-OWNED: exactly eighteen tables hold no per-player data — spec §3's \
         seventeen plus rb-24's `account_deletion_reaper_schedule`, which is scheduler \
         bookkeeping whose two lifecycles (the runtime deleting a fired one-shot, and the \
         PRV1-3 cancel disarm) are both explicit and neither of them a cascade step. Every \
         one is an EXPLICIT registry entry with a mandatory reason — never a silent \
         omission — because the two failure directions are symmetric: cascading over \
         `config` deletes global game config, and quietly dropping a genuinely-owned table \
         out of the cascade leaves an unerased copy of a deleted player's data."
    );
}

// ---------------------------------------------------------------------------
// T3 / X5 — BASIS PROSE, THE `config` SINGLETON PIN, AND SLASH HYGIENE.
// ---------------------------------------------------------------------------

/// T3 / X5: every `basis` is real prose (floor length), `config`'s basis
/// contains the word `singleton`, and NO manifest string literal contains a `/`.
///
/// THE SLASH BAN IS NOT COSMETIC — IT IS MEASURED. `battle-schema-snapshot`
/// parses RAW Rust with a string-UNAWARE comment stripper, in both its live
/// drift check AND its `--write` regenerator. One block-comment opener inside
/// one `basis` string literal therefore deletes every subsequent table from the
/// committed baseline, self-consistently: the regenerated baseline and the live
/// parse agree, both are missing the tail of the schema, and the drift gate
/// reports PASS over a truncated world. Banning `/` outright in manifest strings
/// is exact (no legal basis prose needs one) and closes the whole family —
/// opener, closer and the line-comment form — in one clause.
///
/// The floor length is the anti-placeholder clause: spec §3 makes the reason
/// MANDATORY, and a basis of `""` (or `"n a"`) turns the registry back into the
/// silent omission it exists to abolish.
///
/// Kills: blanking one basis to the empty string, or to a two-word placeholder;
///        rewording `config`'s basis so it no longer says `singleton` (spec §3
///        requires that word to stay grep-checkable, so a future promotion of
///        `config.owner_identity` to an indexed column re-triggers a human
///        decision instead of silently passing);
///        putting a comment delimiter in any manifest string (the measured
///        baseline-blinding above).
#[test]
fn data_lifecycle_basis_nonempty_config_singleton() {
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;
    let mut config_seen = false;

    for entry in manifest {
        let table = entry.table;
        let basis = entry.basis;
        assert!(
            basis.len() >= 20,
            "T3: the `{table}` entry's basis is {} byte(s) long; at least 20 is required. \
             Spec §3 makes the reason MANDATORY — an empty or placeholder basis is the \
             silent omission the explicit registry exists to abolish, and it is what the \
             next reader consults before deciding whether a cascade may touch the table.",
            basis.len()
        );
        assert!(
            !basis.contains('/'),
            "T3: the `{table}` entry's basis contains a slash. NO manifest string may. \
             battle-schema-snapshot parses RAW source with a string-UNAWARE comment \
             stripper in BOTH its drift check and its regenerator, so a comment delimiter \
             inside one basis literal silently deletes every LATER table from the committed \
             baseline — self-consistently, so the drift gate stays green over a truncated \
             schema. Reword without the slash."
        );
        assert!(
            !table.contains('/'),
            "T3: the table key `{table}` contains a slash — see the basis clause above; the \
             same baseline-blinding applies to every string literal in this manifest."
        );
        if let DeletionPolicy::ViaJoin(parent) = entry.policy {
            assert!(
                !parent.contains('/'),
                "T3: the `{table}` entry's ViaJoin parent `{parent}` contains a slash — see \
                 the basis clause above."
            );
        }
        if table == "config" {
            config_seen = true;
            assert!(
                basis.contains("singleton"),
                "T3 / spec §3: `config`'s basis must contain the word `singleton`. Its \
                 owner_identity is a zeroed singleton DEFAULT, not a per-row key, so the \
                 naive `has an Identity column implies per-player` heuristic wrongly \
                 nominates it and a cascade that acts on it deletes global game config. \
                 Spec §3 requires the word to stay grep-checkable so a future promotion of \
                 that column to an indexed role re-triggers a human decision. Got: {basis:?}"
            );
        }
    }

    assert!(
        config_seen,
        "T3 non-vacuity: DATA_LIFECYCLE_MANIFEST has no `config` entry at all, so the \
         singleton clause above never ran. Fail loud rather than pass on an absent row."
    );
}

/// T3 / X5 (second half): every `ViaJoin` parent is a table the manifest itself
/// classifies, and that parent's own policy is NOT `ViaJoin`.
///
/// A dangling parent is a cascade step that sweeps nothing. A CHAINED parent
/// (`a` via `b`, `b` via `c`) is worse: spec §4.4 step 4 sweeps join-only rows
/// transitively AT THE OWNING PARENT'S CASCADE STEP, and a parent that is itself
/// join-only has no cascade step of its own — the chain's tail is never reached,
/// so those rows survive the deletion silently.
///
/// Kills: a `ViaJoin("batle")` typo (a parent no entry names);
///        `character` -> `battle_wild` (both join-only: a chain whose head never
///        runs);
///        a self-referential `ViaJoin` naming the entry's own table.
#[test]
fn data_lifecycle_via_join_parents_live_and_unchained() {
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;

    let mut pairs: Vec<(&str, &str)> = Vec::new();
    for entry in manifest {
        if let DeletionPolicy::ViaJoin(parent) = entry.policy {
            pairs.push((entry.table, parent));
        }
    }
    assert_eq!(
        pairs.len(),
        5,
        "T3 non-vacuity: spec §3 names exactly five JOIN-ONLY tables, so this scan must have \
         five parents to check. Zero ViaJoin entries would make every clause below \
         vacuously true."
    );

    for (table, parent) in &pairs {
        assert_ne!(
            table, parent,
            "T3: the `{table}` entry names ITSELF as its owning parent. A self-join has no \
             cascade step that could ever sweep it."
        );
        let parent_entry = manifest.iter().find(|candidate| candidate.table == *parent);
        let policy = match parent_entry {
            Some(entry) => &entry.policy,
            None => panic!(
                "T3: the `{table}` entry is swept via `{parent}`, but no \
                 DATA_LIFECYCLE_MANIFEST entry names that table. A dangling parent is a \
                 cascade step that sweeps nothing — the rows survive account deletion."
            ),
        };
        assert!(
            !matches!(policy, DeletionPolicy::ViaJoin(_)),
            "T3: the `{table}` entry is swept via `{parent}`, whose OWN policy is \
             {policy:?}. Spec §4.4 step 4 sweeps join-only rows at the OWNING PARENT'S \
             cascade step, and a parent that is itself join-only has no cascade step of its \
             own — so the chain's tail is never reached and those rows survive the deletion \
             silently. Point the entry at the real owner."
        );
    }
}

// ---------------------------------------------------------------------------
// T4 / X6 — EXPORT SCOPE, AS A POSITIVE BIJECTION.
// ---------------------------------------------------------------------------

/// T4 / X6: the `exportable == true` set equals EXACTLY the seventeen tables
/// spec §5 admits — set equality, BOTH directions.
///
/// POSITIVE, NOT NEGATIVE, and all three plan lenses converged on why: a
/// negative-only spot check ("battle_wild is false, guest_claim is false") is
/// satisfied by an ALL-FALSE manifest, which ships a dead export feature — spec
/// §5's walk filters on `exportable: true`, so an all-false manifest produces an
/// empty bundle for every subject-access request while every gate stays green.
/// Set equality in both directions is the only shape that rejects an over-broad
/// AND an empty export scope.
///
/// The seventeen are the twelve spec-ERASE tables + the four ANONYMIZE tables +
/// `character`. The `false` side includes the three the spec calls out by name:
/// `battle_wild` (the raw RNG individuality seed, a must-never-leak),
/// `guest_claim` (a live secret code) and `export_bundle` itself (the export's
/// own output — including it makes the walk self-feeding).
///
/// Kills: the measured all-false cheat; flipping `battle_wild` to true (leaks
///        the seed a literal "dump every matched row" export would carry);
///        flipping `export_bundle` to true; adding a NOT-OWNED registry table to
///        the export (global game content is not the requester's personal data).
#[test]
fn data_lifecycle_export_scope_structurally_narrower() {
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;

    let mut exportable: Vec<&str> = Vec::new();
    for entry in manifest {
        if entry.exportable {
            exportable.push(entry.table);
        }
    }
    exportable.sort_unstable();

    let expected_exportable = [
        "account",
        "battle",
        "battle_action",
        "battle_challenge",
        "character",
        "heal_cooldown",
        "inventory",
        "monster",
        "monster_pub",
        "player",
        "player_conversation",
        "player_dialogue_state",
        "player_quest",
        concat!("player", "_wallet"),
        "playtest_event",
        "profile",
        "trade_offer",
    ];
    assert_eq!(
        exportable, expected_exportable,
        "T4 / spec §5: the exportable set is wrong. It must be EXACTLY the twelve ERASE \
         tables + the four ANONYMIZE tables + `character`. Both directions matter: an \
         all-false manifest passes every negative spot check and ships an export feature \
         that returns an empty bundle for every request (§5's walk filters on \
         `exportable: true`), while a manifest that exports one table too many leaks either \
         a must-never-leak seed or global content the requester does not own."
    );

    for banned in ["battle_wild", "guest_claim", "export_bundle"] {
        assert!(
            !exportable.contains(&banned),
            "T4 / spec §5: `{banned}` must carry `exportable: false`. Export scope is a \
             THIRD, orthogonal axis and must be structurally NARROWER than deletion scope: \
             battle_wild carries the raw RNG individuality seed, guest_claim carries a live \
             secret, and export_bundle is the export's own output."
        );
    }
}

// ---------------------------------------------------------------------------
// T9 / X3 — CROSS-MANIFEST CONSISTENCY.
// ---------------------------------------------------------------------------

/// T9 / X3: every key of the JS `REKEY_MANIFEST` names a table that
/// `DATA_LIFECYCLE_MANIFEST` also classifies.
///
/// The slice deliberately shipped TWO manifests (the Rust deletion/export
/// classification in schema.rs, the JS re-key policy in the eval) because, at
/// the time, object-valued JS entries were measured red-on-arrival against
/// `[G6/consumed]`, which inferred REKEY from `typeof policy === 'string'`.
/// rb-2 replaced that inference with an explicit `policy` discriminator
/// (ADR-0208 D1); the split survives because the two classify different things
/// in different languages, and that deviation is only safe if the two cannot
/// drift apart. This is the clause that makes it so: both are independently
/// tied to the same live Rust sources, and a table renamed or split on one side
/// must surface on the other.
///
/// The extraction FAILS LOUD below twenty keys. A scan that silently returns
/// nothing is indistinguishable from a scan that found no violation, and this
/// one reads a foreign-language file whose formatting nothing in the Rust
/// toolchain gates.
///
/// Kills: renaming a table in schema.rs and leaving the JS key behind (or vice
///        versa); splitting a table and updating only one manifest; an
///        extraction that quietly degrades to zero keys and reports success.
#[test]
fn data_lifecycle_cross_manifest_consistency() {
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;
    let keys = m22_rekey_manifest_keys();

    assert!(
        keys.len() >= 20,
        "T9 extraction rot: only {} `table.column` key(s) were read out of the JS \
         REKEY_MANIFEST; the live tree carries 24 and rb-24 adds \
         account_deletion_reaper_schedule.account_identity for 25 (a new Identity COLUMN \
         mechanically forces a manifest entry — [G6/declared] re-derives the column set \
         from live source every run). An extractor that quietly stopped finding keys \
         reports `consistent` about a manifest it never read. Keys seen: {keys:?}",
        keys.len()
    );
    assert!(
        keys.iter().any(|key| key == "account.identity"),
        "T9 extraction anchor: the stable key `account.identity` is not among the extracted \
         keys, so the scan is reading something other than the manifest."
    );

    for key in &keys {
        let table = match key.split_once('.') {
            Some((table, _)) => table,
            None => panic!("T9: extracted key {key:?} is not `table.column` shaped."),
        };
        let classified = manifest.iter().any(|entry| entry.table == table);
        assert!(
            classified,
            "T9: the JS REKEY_MANIFEST policies `{key}`, but DATA_LIFECYCLE_MANIFEST has no \
             entry for the table `{table}`. The two manifests have drifted: the M22 cascade \
             reads the Rust one and would skip this table entirely, while the claim re-key \
             path still believes it exists. Update BOTH in the same commit."
        );
    }
}

// ---------------------------------------------------------------------------
// T7 / X2 — THE `export_bundle` TABLE: SHAPE AND PRIVACY.
// ---------------------------------------------------------------------------

/// T7 / X2: `export_bundle` is declared PRIVATE with exactly the eight columns
/// of the S2/S4/S8 chunk contract, in order, with the exact types.
///
/// Pinned by EXACT EQUALITY over the comment-stripped, string-preserving,
/// whitespace-squashed declaration — the same mechanics as
/// `schema_account_struct_shape_tripwire`, for the same reason: BSATN layout is
/// order-sensitive, and a containment check is green on an appended field, a
/// reordered pair and a widened type alike.
///
/// The privacy half is pinned three ways, because `public` on a VIEW attribute
/// is inert while `public` on a TABLE is the entire security boundary: the table
/// attribute's ONLY argument must be `accessor = export_bundle`, that attribute
/// must occur exactly once, and no `accessor = export_bundle,` spelling — which
/// is what ANY additional attribute argument would produce — may appear anywhere
/// in schema.rs.
///
/// The derive-before-attribute order is pinned too, and is not style:
/// `parseTableSchemas` matches the table attribute immediately followed by
/// `pub struct`, so a derive placed AFTER that attribute makes the whole
/// declaration unreadable to `[G6/parse]`, to the schema baseline and to T1's
/// census.
///
/// Kills: adding `public` to the attribute (the bundle is one player's entire
///        personal-data dump — a public table hands it to every client);
///        renaming or reordering any column (S4's TTL reaper and S8's client
///        assembler both consume these names in this order);
///        widening `chunk_index`/`total_chunks`, or dropping the `#[auto_inc]`
///        on the synthetic primary key;
///        dropping the btree index on `owner_identity` (the owner-scoped view
///        and the cascade both filter on it);
///        declaring the derive after the table attribute;
///        declaring a second `export_bundle` table.
#[test]
fn export_bundle_struct_shape_and_privacy() {
    let schema = stripped_keep_strings(SCHEMA_RS);

    let expected_head = concat!(
        "#[derive(Clone)]",
        "#[spacetimedb::",
        "table",
        "(",
        "access",
        "or=export_bundle)]",
        "pub",
        "structExportBundle{",
    );
    assert_eq!(
        m22_count_occurrences(&schema, expected_head),
        1,
        "T7 / X2: schema.rs must declare `export_bundle` exactly once, as `#[derive(Clone)]` \
         followed by a table attribute whose ONLY argument is `accessor = export_bundle`, \
         followed by `pub struct ExportBundle`. Anything else is one of: a `public` table \
         (the bundle is one player's whole personal-data dump), an attribute-argument order \
         parseTableSchemas cannot read, a derive placed after the attribute (same effect), \
         or a second declaration."
    );

    let attr_prefix = concat!(
        "#[spacetimedb::",
        "table",
        "(",
        "access",
        "or=export_bundle"
    );
    assert_eq!(
        m22_count_occurrences(&schema, attr_prefix),
        1,
        "T7 / X2: exactly one table attribute in schema.rs may name the `export_bundle` \
         accessor."
    );
    assert_eq!(
        m22_count_occurrences(&schema, concat!("access", "or=export_bundle,")),
        0,
        "T7 / X2: the `export_bundle` table attribute carries an EXTRA argument. `public` is \
         the dangerous one — unlike the `public` on a view attribute (inert, ADR-0194/0198), \
         `public` on a TABLE is the whole security boundary. Spec §5's sanctioned idiom is \
         the private table plus an owner-scoped view BODY."
    );

    let marker = concat!("struct", "ExportBundle{");
    let fields = extract_squashed_fn_body(&schema, marker).unwrap_or_else(|| {
        panic!(
            "T7 / X2: the ExportBundle struct declaration was not found in schema.rs (marker \
             {marker:?} over the comment-stripped, whitespace-squashed source). The shape \
             pin cannot check a declaration it cannot read — hard failure, never a skip."
        )
    });
    let expected_fields = concat!(
        "#[primary",
        "_key]",
        "#[auto",
        "_inc]",
        "pubchunk_id:u64,",
        "#[index(btree)]",
        "pubowner_identity:Identity,",
        "pubrequest_id:u64,",
        "pubtable_name:String,",
        "pubchunk_index:u32,",
        "pubtotal_chunks:u32,",
        "pubpayload_json:String,",
        "pubcreated_at_ms:i64,",
    );
    assert_eq!(
        fields, expected_fields,
        "T7 / X2 / spec §5: `export_bundle`'s column list is not the S2/S4/S8 chunk \
         contract. It must be exactly, in order: chunk_id (u64, primary key, auto_inc — \
         views strip primary keys, and a primary-key column may carry no default), \
         owner_identity (Identity, btree), request_id (u64), table_name (String), \
         chunk_index (u32), total_chunks (u32), payload_json (String), created_at_ms (i64 — \
         server-stamped at insert; the S4 TTL reaper re-derives staleness from it, so no \
         caller can supply it). S4's reaper and S8's client assembler both read these names \
         in this order; a rename or a reorder breaks them silently, and a reorder also \
         changes the BSATN layout of a live table."
    );
}

// ---------------------------------------------------------------------------
// T6 / X7 — THE `auth_issuer` DOC COMMENT.
// ---------------------------------------------------------------------------

/// T6 / X7: `Account.auth_issuer` no longer claims it is never updated, and its
/// OWN doc-comment block names the one sanctioned exception.
///
/// Spec §3 is explicit: the M22 cascade overwrites `auth_issuer` with the
/// `TOMBSTONE_AUTH_ISSUER` sentinel (a String, not null — widening the column to
/// `Option<String>` would be exactly the non-additive, semantics-changing edit
/// §4.1 declines to make), and "S2 must update that comment, because leaving it
/// stale would make the next reader believe the field is immutable".
///
/// TWO CLAUSES, AND THE SECOND IS LOCALIZED. The whole-file clause bans the
/// stale phrase in a slash-free, whitespace-free view, so it cannot be dodged by
/// a rustfmt re-wrap that moves the line break. The second clause reads ONLY the
/// contiguous `///` block immediately above `pub auth_issuer: String,` — a
/// wide-window `contains` is satisfied by the sentinel appearing anywhere else
/// in schema.rs (the manifest's own `basis` prose will mention it) while the
/// field's comment stays stale-but-reworded, which is a red-team finding, not a
/// hypothetical.
///
/// Kills: leaving the comment untouched; rewording it without naming the
///        exception; naming `TOMBSTONE_AUTH_ISSUER` somewhere else in the file
///        and calling it done.
#[test]
fn auth_issuer_doc_comment_states_deletion_exception() {
    let flat = m22_squashed_no_slashes(SCHEMA_RS);
    let stale = concat!("Neverupdated", "afterinsert");
    assert!(
        !flat.contains(stale),
        "T6 / X7 / spec §3: schema.rs still claims `auth_issuer` is never updated after \
         insert. M22 makes the deletion cascade the ONE sanctioned exception — it writes \
         game_core::TOMBSTONE_AUTH_ISSUER over that column — so the comment is now false. \
         The needle is matched with all whitespace AND all slashes removed, so re-wrapping \
         the doc comment across different lines does not dodge it."
    );

    let decl = "pub auth_issuer: String,";
    assert_eq!(
        m22_count_occurrences(SCHEMA_RS, decl),
        1,
        "T6 fail-loud: {decl:?} must occur exactly once in schema.rs for `the doc block \
         immediately above it` to be an unambiguous localization."
    );

    let block = m22_doc_block_before(SCHEMA_RS, decl);
    assert!(
        !block.is_empty(),
        "T6 fail-loud: `{decl}` carries NO doc-comment block at all. A field whose \
         mutability rule just changed and whose comment was deleted is worse than a stale \
         comment, not better."
    );
    assert!(
        block.contains("TOMBSTONE_AUTH_ISSUER"),
        "T6 / X7: the doc-comment block on `auth_issuer` does not name \
         `TOMBSTONE_AUTH_ISSUER`. This clause is LOCALIZED to the field's own block on \
         purpose: a whole-file check is satisfied by the sentinel appearing in the \
         manifest's basis prose while this comment stays stale. Block read: {block:?}"
    );
    assert!(
        block.to_lowercase().contains("deletion"),
        "T6 / X7: the doc-comment block on `auth_issuer` names the sentinel but never says \
         WHEN it is written. State the exception: the M22 account-deletion cascade is the \
         only writer. Block read: {block:?}"
    );
}

// ---------------------------------------------------------------------------
// T8 / X8 — THE LEGAL-STATE PREDICATE, EXTENDED FOR `terminal_at_ms`.
// ---------------------------------------------------------------------------

/// T8 / X8: `terminal_at_ms.is_some()` implies `PendingDeletion` AND a deletion
/// request stamp — a terminal marker with no request behind it is illegal.
///
/// Spec §4.1 defines the terminal predicate as
/// `status == PendingDeletion && terminal_at_ms.is_some()`, and §4.4 step 5 sets
/// the marker ONLY after steps 1-4 complete, i.e. only inside a live deletion.
/// The existing invariant (ADR-0195 D3) ties `status` to
/// `deletion_requested_at_ms`; without a matching clause for the new column,
/// `Active` + `terminal_at_ms: Some(..)` — an account that was erased and then
/// resurrected — reads as a perfectly legal state.
///
/// The `Active` row below is the one that BITES: under the pre-M22 predicate
/// (Active implies no request stamp) it is LEGAL, so only the new clause can
/// reject it. The `PendingDeletion` row is already illegal under the old clause
/// and is here to pin that the extension did not weaken what was enforced.
///
/// Kills: shipping `terminal_at_ms` with no legality rule at all — the
///        illegal-states-representable smell the struct-shape tripwire's own
///        contract exists to force a conscious re-derivation of;
///        a clause that checks only the status half and ignores the stamp.
#[test]
fn account_legal_state_rejects_terminal_without_request() {
    for status in [AccountStatus::Active, AccountStatus::PendingDeletion] {
        let account = Account {
            status,
            deletion_requested_at_ms: None,
            terminal_at_ms: Some(900),
            ..base_account(11)
        };
        assert!(
            !account_state_is_legal(&account),
            "T8 / spec §4.1: an account carrying a terminal marker but NO deletion request \
             stamp is an illegal state (status was {status:?}). The cascade sets \
             terminal_at_ms only as its LAST step (§4.4 step 5), after a request was \
             recorded and its grace window elapsed, so a terminal marker with nothing \
             behind it means either the request stamp was cleared under a completed \
             deletion or the marker was written by something that is not the reaper."
        );
    }
}

/// T8 / X8: `account_state_is_legal` classifies an `Active` account carrying a
/// terminal marker as ILLEGAL.
///
/// SCOPE — THIS IS A PARTIAL TOOTH, AND THE MISSING HALF IS NAMED. What follows
/// is pinned: the PURE PREDICATE rejects the shape. What is NOT pinned, by this
/// test or by anything else in this file: that a reducer path refuses to PRODUCE
/// the shape. On the tree S2 ships, one demonstrably can. `needs_cancel_write`
/// (`accounts.rs`) is `matches!(status, PendingDeletion)` and a terminal account
/// IS `PendingDeletion`, so a late `cancel_account_deletion` is not
/// short-circuited; `cancelled_deletion` (`accounts.rs`) then sets `Active` +
/// `None` and carries `terminal_at_ms` forward through `..existing`; and its only
/// guard is a `debug_assert!` that the shipped wasm compiles out (the workspace
/// `Cargo.toml`'s `[profile.release]` sets `overflow-checks` and nothing else —
/// the profile fact this file's ACCOUNT LEGAL-STATE INVARIANT banner already
/// records). In a release build that constructor structurally CAN mint the state
/// asserted illegal below.
///
/// That gap is SLICE SCOPE, not an oversight, and it is owned elsewhere: the
/// reducer-side rejection is spec §4.5 "Late cancel" / criterion PRV1-4 — WHEN
/// `cancel_account_deletion` is called by an identity whose `terminal_at_ms` is
/// `Some` THE SYSTEM SHALL reject with a distinct, non-generic error and SHALL
/// NOT reactivate the account — which spec §7.2 assigns to S3. S2's declared
/// touches exclude reducer bodies, and no S2 constructor ever writes `Some` to
/// the column, so the illegal state is unreachable until S3 lands. S3 must ship
/// that guard AND a constructor-level test for `cancelled_deletion`; a residual
/// is filed to that effect. Do not read this test as covering it.
///
/// Spec §4.1's terminal predicate is `status == PendingDeletion &&
/// terminal_at_ms.is_some()`, so Active + a marker is a resurrected tombstone:
/// every gate that asks "is this account terminal?" answers no, while the row
/// records that its data was already erased.
///
/// BOTH request shapes are exercised, and they bite different clauses. With
/// `Some(request)` the row is already illegal under the pre-M22 status rule
/// (Active implies no stamp) — that row proves the extension did not
/// accidentally LOOSEN the existing invariant. With `None` the row is legal
/// under the pre-M22 predicate and can only be rejected by the new terminal
/// clause — that row is the tooth.
///
/// Kills: a terminal clause spelled `terminal.is_some() implies
///        deletion_requested_at_ms.is_some()` that forgets the status half (the
///        None row still reds, but such a clause admits Active + Some(stamp) +
///        Some(terminal), which the first row here catches);
///        a terminal clause deleted outright;
///        a predicate that answers the same thing for every input.
///
/// Does NOT kill: `cancel_account_deletion` reactivating a terminal account. See
///        the scope note above — that is S3's PRV1-4 guard, the `debug_assert!`
///        is compiled out of release, and NO test in this file covers it today.
#[test]
fn account_legal_state_rejects_terminal_while_active() {
    let cases: [(&str, Option<i64>); 2] = [
        ("with a deletion request stamp", Some(500)),
        ("with no deletion request stamp", None),
    ];
    for (label, requested) in cases {
        let account = Account {
            status: AccountStatus::Active,
            deletion_requested_at_ms: requested,
            terminal_at_ms: Some(900),
            ..base_account(12)
        };
        assert!(
            !account_state_is_legal(&account),
            "T8 / spec §4.1: an Active account carrying a terminal marker ({label}) is an \
             illegal state. The terminal predicate is `status == PendingDeletion && \
             terminal_at_ms.is_some()`, so an Active row with a marker is a resurrected \
             tombstone: every terminal check reads `not terminal` while the row records \
             that the account's data was already erased."
        );
    }
}

/// T8 / X8: the ONE legal terminal shape — `PendingDeletion` + a request stamp +
/// a terminal marker — is ACCEPTED, and the all-`None` fresh shape stays legal.
///
/// This is the anti-over-strictness half, and a reviewer found the cheat it
/// kills: a clause spelled `account.terminal_at_ms.is_none()` (or any
/// always-reject-`Some` variant) passes BOTH negative tests above and breaks
/// S3's reaper on its very first write — the constructor `debug_assert!` that
/// stamps the marker would fire in every debug build, and the predicate would
/// declare the completed-deletion state itself illegal.
///
/// Kills: an always-reject-Some terminal clause; a predicate mutated to a
///        constant `false`, which the two negative tests above cannot see.
#[test]
fn account_legal_state_accepts_legal_terminal_shape() {
    let terminal = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(500),
        terminal_at_ms: Some(900),
        ..base_account(13)
    };
    assert!(
        account_state_is_legal(&terminal),
        "T8 / spec §4.4 step 5: PendingDeletion + Some(requested) + Some(terminal) is the \
         state a COMPLETED cascade leaves behind, and it must be LEGAL. A clause spelled \
         `terminal_at_ms.is_none()` satisfies both negative terminal tests and makes the one \
         state S3's reaper actually writes illegal — every constructor debug_assert would \
         fire on the first real deletion."
    );

    let fresh = base_account(14);
    assert!(
        fresh.terminal_at_ms.is_none(),
        "T8 fixture: the baseline account must carry no terminal marker for the next \
         assertion to be about the all-None shape at all."
    );
    assert!(
        account_state_is_legal(&fresh),
        "T8: the fresh Active account (no request stamp, no terminal marker, no claim \
         provenance) must remain LEGAL. A terminal clause that rejects the ABSENCE of a \
         marker inverts the rule and makes every ordinary account illegal."
    );
}

// ===========================================================================
// rb-22 (ADR-0220) — PRE-CLAIM `export_bundle` ORPHAN, PURGED AT CLAIM TIME.
//
// EO-1 / EO-2 / EO-3 / EO-6. This is the arm that COMPILES ON THE PRE-FIX TREE:
// it reads only `ACCOUNTS_RS` / `LIB_RS` (already `include_str!`-ed above) plus a
// RUNTIME `std::fs` read of `src/privacy.rs` (the pvp_tests.rs:734 / ranking.rs
// precedent — an `include_str!` of a file that does not exist yet is a COMPILE
// error, which would make the proof-of-teeth RED indistinguishable from a broken
// build). Nothing here references `M22_PRIVACY_RS`: that census constant is the
// implementer's own mechanically-forced edit (F2), and a gating test that
// depended on it could not be run before the fix.
//
// SCAN HYGIENE (this file's header rule, and the rb-22 plan's F4/F5): every
// needle below is assembled from `concat!` fragments, so this file never carries
// a contiguous write-verb chain, table or reducer attribute, outer cfg-test
// attribute, or `mod privacy_tests;`-shaped declaration that a whole-tree scanner
// (a dozen evals concatenate EVERY `.rs` file under `server-module/src`,
// `_tests.rs` files included) could count as a real one. This section also
// contains no block comment, no raw string, no backslash-escaped quote
// character, and no char literal holding a quote character.
// ===========================================================================

/// A literal double quote, built from its byte (0x22) so this section carries
/// neither a backslash-escaped quote — which unbalances a naive quote-pairing
/// stripper in an eval that concatenates this file — nor a quote inside a char
/// literal, which blinds a naive char-literal-unaware scanner. Memory card:
/// server-module source-scan gotchas — use 0x22 constants.
fn rb22_dq() -> char {
    char::from(34u8)
}

/// The squashed call needle for the delegated purge, split mid-token so this
/// file never carries the contiguous call site a future call-site census would
/// count.
fn rb22_nd_purge_call() -> String {
    concat!("crate::privacy::", "purge_export", "_bundles(").to_string()
}

/// The squashed `fn` needle for the helper itself.
fn rb22_nd_purge_fn() -> String {
    concat!("fnpurge_export", "_bundles(").to_string()
}

/// THE FROZEN BODY PIN (red-team counter-tooth: the exact-equality backstop).
///
/// Derived by running the real three-stage pipeline over the sanctioned source
/// by hand: `strip_rust_strings` (no strings here) -> `strip_rust_comments` ->
/// `squash_ws`, which removes ALL whitespace including newlines. `privacy_tests`
/// carries a POSITIVE CONTROL that re-derives this exact string from source text
/// through the live pipeline, so this literal can never become unsatisfiable.
///
/// Containment pins alone were MEASURED insufficient (red-team `/tmp/rb22-attack`):
/// `if false ...` around a correct body, a shadowed `let ids = Vec::new();`, a
/// shadowed in-loop `let id: u64 = 0;` and an appended aliased foreign write all
/// satisfy every needle-based clause and are clippy-clean. Equality kills the
/// whole family in one assertion.
fn rb22_frozen_purge_body() -> String {
    [
        "letids:Vec<u64>=",
        concat!("ctx", ".db."),
        concat!("export", "_bundle()"),
        ".owner_identity().filter(owner).map(|c|c.chunk_id).collect();",
        "foridinids{",
        concat!("ctx", ".db."),
        concat!("export", "_bundle()"),
        concat!(".chunk_id().del", "ete(id);"),
        "}",
    ]
    .concat()
}

/// The squashed signature slice `extract_squashed_fn_sig` returns.
///
/// NOTE (measured against the real helper, accounts_tests.rs:245-250): the slice
/// starts at the `fn_needle`, so it does NOT include the visibility keyword.
/// `pub(crate)` is therefore pinned SEPARATELY, as a prefix containment check.
fn rb22_frozen_purge_sig() -> String {
    concat!(
        "fnpurge_export",
        "_bundles(ctx:&ReducerContext,owner:Identity)"
    )
    .to_string()
}

/// The sanctioned sibling-test declaration in `privacy.rs`, in the
/// comment-stripped / strings-kept / whitespace-squashed view.
///
/// It is load-bearing beyond tidiness: an INNER `#![cfg(test)]` does NOT contain
/// the OUTER attribute substring that `monster-privacy.eval.mjs`'s `[SCOPE]`
/// clause (:2759-2815) searches for, so that clause justifies excluding
/// `privacy_tests.rs` from its scan surface ONLY through this PARENT
/// declaration. Without it, `privacy_tests.rs` is an unjustified exclusion (eval
/// RED) and — worse for this slice — the whole GREEN-arm test module is never
/// compiled, silently emptying the gate.
fn rb22_nd_test_mod_decl() -> String {
    let dq = rb22_dq();
    format!(
        "{}{dq}privacy_tests.rs{dq}{}",
        concat!("#[cfg", "(test)]", "#[pa", "th="),
        concat!("]", "modprivacy_tests;")
    )
}

/// RAW-text view for the module-header doc-truth scan: whitespace, `/` and `!`
/// deleted, so a doc phrase rustfmt wrapped across two `//!` lines still reads as
/// ONE token. Mirrors `m22_squashed_no_slashes` (:3263), which exists for exactly
/// this reason — a comment cannot be scanned in any COMMENT-STRIPPED view.
fn rb22_header_squash(src: &str) -> String {
    src.chars()
        .filter(|c| !c.is_whitespace() && *c != '/' && *c != '!')
        .collect()
}

/// EO-1 (call site): `complete_guest_claim` delegates the guest's `export_bundle`
/// purge EXACTLY ONCE, as a bare top-level statement, on the straight-line
/// success path between `rekey_all` and `consume_claim_and_disarm`, with the
/// RETIRED GUEST identity as the argument.
///
/// Nine clauses, each with its own pinned message (coarse mutants only ever prove
/// the first assertion — every later clause needs a surgical mutant pinned by
/// FAILURE MESSAGE):
///   count / statement-form / four ordering anchors / reachability / guest-shadow
///   / brace depth.
///
/// Kills: dropping the call; a second unreviewed call; the call re-argued to `me`
///        (which purges the CLAIMER's chunks and leaves the guest's behind);
///        wrapping it in `if ... ` or in a never-invoked closure (both keep every
///        containment clause green); an early `return` inserted above it; and the
///        MEASURED `let guest = me;` shadow, which re-points a textually perfect
///        call at the wrong identity.
#[test]
fn rb22_claim_purges_guest_export_bundles_call_site() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_complete())
        .expect("rb-22 [call/scope]: fn complete_guest_claim not found in accounts.rs");
    let call = rb22_nd_purge_call();

    // --- (1) exactly once, in this reducer -----------------------------------
    let n = m22_count_occurrences(body, &call);
    assert_eq!(
        n, 1,
        "rb-22 [call/count]: complete_guest_claim must call `{call}` EXACTLY once; found {n}. \
         ZERO means a guest's pre-claim export_bundle chunks stay owned by the RETIRED guest \
         identity forever: the S3 deletion cascade keys on a live account's own identity and \
         structurally cannot reach them, and S4's 7-day TTL reaper is a second, independent \
         expiry rather than a reachability guarantee. MORE THAN ONE is a second, unreviewed \
         purge site."
    );

    // --- (2) a bare STATEMENT with the GUEST argument ------------------------
    // `;<call>ctx,guest);` in squashed text pins three things at once: the
    // argument (not `me`), statement position (not an operand of a closure or an
    // iterator adaptor), and the preceding statement terminator. The eval's
    // [S/depth0] clause documents the two MEASURED depth-0 shapes this kills:
    // `let _p = || purge(...)` and `std::iter::empty().for_each(|_| purge(...))`.
    let statement = format!(";{call}ctx,guest);");
    assert!(
        body.contains(statement.as_str()),
        "rb-22 [call/statement]: the purge call in complete_guest_claim is not the bare \
         statement `{statement}`. Either its argument is not the retired GUEST identity \
         (purging the claimer's own chunks instead — a no-op that leaves the orphan), or the \
         call is an OPERAND of something else: a closure binding or an iterator adaptor is \
         brace-depth 0, satisfies every containment and ordering clause here, and never runs."
    );

    // --- (3) ordering on the success path ------------------------------------
    let rekey = concat!("rekey", "_all(ctx,guest,me)?;");
    let consume = concat!("consume_claim_and", "_disarm(ctx,guest);");
    let update = concat!("account()", ".identity().update(claimed_account(");
    let at_rekey = idx(body, rekey);
    let at_purge = idx(body, &call);
    let at_consume = idx(body, consume);
    let at_update = idx(body, update);
    let at_ok = body
        .rfind(concat!("Ok", "(())"))
        .expect("rb-22 [call/order-ok]: complete_guest_claim must end in Ok(())");
    assert!(
        at_rekey < at_purge,
        "rb-22 [call/order-rekey]: the purge (offset {at_purge}) must run AFTER \
         `rekey_all(ctx, guest, me)?;` (offset {at_rekey}). rekey_all is fallible and its `?` \
         rolls the whole transaction back, so a purge sequenced before it can be undone by a \
         later re-key failure while the caller is told the claim failed."
    );
    assert!(
        at_purge < at_consume,
        "rb-22 [call/order-consume]: the purge (offset {at_purge}) must run BEFORE \
         consume_claim_and_disarm (offset {at_consume}). The consume+disarm is the last \
         reference to the guest's claim row; sequencing the erase after it buys nothing and \
         puts the slice's only new write outside the reviewed re-key/consume block."
    );
    assert!(
        at_consume < at_update,
        "rb-22 [call/order-update]: the AUTH-34 consume must still precede the account \
         provenance update (consume at {at_consume}, update at {at_update}). rb-22 inserts one \
         statement into this sequence and must not perturb the shipped ordering."
    );
    assert!(
        at_update < at_ok,
        "rb-22 [call/order-ok]: the provenance update (offset {at_update}) must precede the \
         trailing Ok(()) (offset {at_ok})."
    );

    // --- (4) REACHABILITY, not just position ---------------------------------
    // The eval's [S/reachable] (guest-claim-integrity.eval.mjs:1542-1555) bans the
    // token `return` in this region because the success path is straight-line by
    // design — every reject guard is guards 1..11, all of which precede rekey_all.
    //
    // TOKEN SEMANTICS, MEASURED: a word boundary is required on the LEFT ONLY.
    // `squash_ws` fuses `return Err(..)` into `returnErr(` and `return Ok(())` into
    // `returnOk(())`, so ALSO requiring a non-word byte on the right would blind
    // this clause to precisely the early-exit shapes it exists to catch. The
    // left-only rule still rejects an identifier such as `early_return`.
    //
    // WIDENED to `at_consume` (rb-22 artifact red-team, Finding 2): ending the
    // scan at `at_purge` left the purge -> consume GAP unguarded on the Rust
    // arm. An early `return` there (`if is_account_holder(ctx, me) { return
    // Ok(()); }`) skips consume_claim_and_disarm (AUTH-34 single-use) and the
    // AUTH-21 provenance stamp while the reducer returns Ok. This region now
    // matches the eval's own [S/reachable] span (rekey_all -> consume).
    let region = &body[at_rekey..at_consume];
    let mut scan = 0usize;
    while let Some(rel) = region[scan..].find("return") {
        let at = scan + rel;
        let is_token = at == 0 || !is_word_byte(region.as_bytes()[at - 1]);
        assert!(
            !is_token,
            "rb-22 [call/reachable]: a `return` token sits between `rekey_all(ctx, guest, me)?;` \
             and the purge call. After the re-key the success path is straight-line by design, \
             so a return here either makes the purge dead code or adds an exit that skips it — \
             while the count, statement, ordering and depth clauses above all stay GREEN, \
             because every one of them reasons about POSITION and none about REACHABILITY. \
             Region text: {region:?}"
        );
        scan = at + "return".len();
    }

    // --- (5) no `guest` shadow / rebind (MEASURED red-team finding) -----------
    // `let guest = me;` inserted anywhere above the purge re-points a textually
    // PERFECT call at the caller's own identity: the count, statement, argument,
    // ordering, reachability and depth clauses are all satisfied, the code is
    // clippy-clean, and the guest's chunks are never touched. The reducer binds
    // `guest` exactly once, from `claim.guest_identity`.
    let shadow = concat!("let", "guest");
    let binds = m22_count_occurrences(body, shadow);
    assert_eq!(
        binds, 1,
        "rb-22 [call/no-shadow]: complete_guest_claim binds `guest` {binds} time(s); exactly ONE \
         binding is allowed (`let guest = claim.guest_identity;`). A shadow or rebind of `guest` \
         is BANNED in this reducer: a second binding re-points the purge — and the AUTH-21 \
         re-key and the AUTH-34 consume with it — at a different identity while every textual \
         clause in this test stays green. Red-team MEASURED this exact shape as clippy-clean."
    );

    // --- (6) brace depth 0 (no conditional / no nested block) ----------------
    let mut depth: i32 = 0;
    for c in body[..at_purge].chars() {
        if c == '{' {
            depth += 1;
        } else if c == '}' {
            depth -= 1;
        }
    }
    assert_eq!(
        depth, 0,
        "rb-22 [call/depth0]: the purge call sits at brace depth {depth} inside \
         complete_guest_claim, not at the top level of the fn body. A conditional purge is a \
         conditional erasure: a guard that is always FALSE at this point in the reducer keeps \
         every count-, argument-, ordering- and region-based clause green while the chunks are \
         never deleted."
    );
}

/// EO-1 (uniqueness, whole file): `accounts.rs` names the delegated purge in
/// EXACTLY ONE place.
///
/// The body-scoped test above pins the call that lives in `complete_guest_claim`;
/// this one pins that there is no OTHER. Together they are total: a call moved
/// out of the reducer (into `rekey_all`, say, where it is invisible to the claim
/// ceremony's own review) fails the scoped test while keeping this count at one,
/// and a decoy second call site fails this one while keeping the scoped test
/// green.
#[test]
fn rb22_purge_called_exactly_once_in_accounts_rs() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let call = rb22_nd_purge_call();
    let n = m22_count_occurrences(&squashed, &call);
    assert_eq!(
        n, 1,
        "rb-22 [call/whole-file]: accounts.rs must name `{call}` EXACTLY once; found {n}. Zero \
         means the delegation was deleted or moved into another module's helper (where the \
         claim ceremony's own reviewers never see it); more than one means a second purge site \
         exists that no scoped test in this file constrains."
    );
}

/// EO-1 (wiring): `lib.rs` compiles the new module UNCONDITIONALLY.
///
/// `mod privacy;` must be declared exactly once and must carry NO cfg attribute
/// and no path attribute. A cfg-test-gated declaration compiles the helper into
/// the TEST binary only — every source scan in this slice stays green while the
/// published wasm module contains no purge at all. A path attribute on the
/// declaration re-points the module at a different file, so the file this slice's
/// tests read is not the file the crate compiles.
///
/// The attribute look-back is bounded to the declaration's own ITEM SPAN (from
/// the end of the previous item — the previous `;` or `}` — up to the
/// declaration), so an unrelated cfg attribute elsewhere in lib.rs can neither
/// vouch for nor incriminate this one.
#[test]
fn rb22_lib_wires_mod_privacy() {
    let squashed = stripped_for_scan(LIB_RS);
    let squashed_decl = concat!("mod", "privacy;");
    let n = m22_count_occurrences(&squashed, squashed_decl);
    assert_eq!(
        n, 1,
        "rb-22 [lib/decl-count]: lib.rs must declare `mod privacy;` exactly once; found {n} \
         occurrence(s) of the squashed form `{squashed_decl}`. Without the declaration the new \
         owning module is not part of the crate at all: privacy.rs is dead text on disk, the \
         call in accounts.rs does not resolve, and the sibling privacy_tests module is never \
         compiled."
    );

    let clean = strip_rust_comments(&strip_rust_strings(LIB_RS));
    let decl = concat!("mod ", "privacy;");
    let at = clean.find(decl).unwrap_or_else(|| {
        panic!(
            "rb-22 [lib/decl-missing]: the declaration `{decl}` was not found in the \
             comment-stripped lib.rs, so the attribute look-back below has no scope and would \
             pass VACUOUSLY."
        )
    });
    let prev_end = clean[..at].rfind([';', '}']).map_or(0, |i| i + 1);
    let span = &clean[prev_end..at];
    assert!(
        !span.contains(concat!("#[cfg", "(")),
        "rb-22 [lib/cfg]: `mod privacy;` carries a cfg attribute in its item span ({span:?}). A \
         cfg-test gate here compiles the purge helper into the TEST binary only: every source \
         scan in this slice stays GREEN while the PUBLISHED module never deletes a single \
         export_bundle row. The module must be unconditional."
    );
    assert!(
        !span.contains(concat!("#[pa", "th")),
        "rb-22 [lib/path]: `mod privacy;` carries a path attribute in its item span ({span:?}). \
         A re-pointed module means the file this slice's scans read is NOT the file the crate \
         compiles — the gate would then be measuring dead text on disk."
    );
}

/// EO-2 (helper shape) + EO-6 (proof-of-teeth ordering): `src/privacy.rs` exists
/// and defines `purge_export_bundles` with EXACTLY the sanctioned body.
///
/// RUNTIME READ, not `include_str!`, on purpose: an `include_str!` of a file that
/// does not exist yet is a COMPILE error, and a build that does not compile
/// cannot produce a named-test RED. This is the pvp_tests.rs:734 /
/// observability_tests.rs:438 idiom (`env!("CARGO_MANIFEST_DIR")` + `std::fs`),
/// and it is what makes the pre-fix RED capturable by name.
///
/// This test DUPLICATES the privacy-side equality pin deliberately: the two arms
/// have different failure messages, so a mutation can be attributed to either,
/// and this arm survives even if the sibling module is ever restructured.
///
/// Kills: the helper missing / declared twice; a renamed or re-typed signature;
///        a `pub fn` (crate-external surface) or a private fn (unreachable from
///        accounts.rs); ANY deviation of the body — dead branch, extra binding,
///        shadowed `ids`, shadowed loop `id`, appended foreign write, a
///        one-row-only delete, a full-table sweep; and a missing sibling-test
///        declaration, which would silently delete the entire GREEN arm.
#[test]
fn rb22_privacy_module_exists_with_purge_body() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("privacy.rs");
    let src = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "rb-22: server-module/src/privacy.rs must exist and define purge_export_bundles \
             [privacy/missing-file] (read of {} failed: {e})",
            path.display()
        )
    });

    let squashed = stripped_for_scan(&src);
    let fn_needle = rb22_nd_purge_fn();

    let n = m22_count_occurrences(&squashed, &fn_needle);
    assert_eq!(
        n, 1,
        "rb-22 [privacy/decl]: privacy.rs must define `{fn_needle}` exactly once; found {n}. \
         Zero means the module is still a stub (or the helper was renamed) and the guest's \
         pre-claim export chunks are never erased."
    );

    let sig = extract_squashed_fn_sig(&squashed, &fn_needle)
        .expect("rb-22 [privacy/sig]: the helper signature has no opening brace");
    assert_eq!(
        sig,
        rb22_frozen_purge_sig(),
        "rb-22 [privacy/sig]: the helper signature is not the frozen one. It must take the \
         reducer context under the name `ctx` and an OWNER-GENERIC `owner: Identity` (never a \
         claim-specific `guest`), so the S3 account-deletion cascade can reuse the same helper \
         verbatim when it lands."
    );
    assert!(
        squashed.contains(concat!("pub(crate)fnpurge_export", "_bundles(")),
        "rb-22 [privacy/vis]: the helper must be `pub(crate)`. A private fn is unreachable from \
         accounts.rs (the call would not compile), and a bare `pub` widens the crate's external \
         surface for no reason."
    );

    let body = extract_squashed_fn_body(&squashed, &fn_needle)
        .expect("rb-22 [privacy/body-extract]: the helper body is not brace-balanced");
    assert_eq!(
        body,
        rb22_frozen_purge_body(),
        "rb-22 [privacy/body]: purge_export_bundles body must be exactly the flat \
         filter-collect-delete sequence — no conditionals, no extra bindings, no extra \
         statements (kills dead-branch, shadowed-ids, shadowed-id, aliased-write bypasses; \
         red-team /tmp/rb22-attack)."
    );

    let kept = squash_ws(&strip_comments_keep_strings(&src));
    let decl = rb22_nd_test_mod_decl();
    assert!(
        kept.contains(decl.as_str()),
        "rb-22 [privacy/testmod]: privacy.rs must end with `{decl}` (the accounts.rs:608-610 \
         form). It is load-bearing twice over: without it the sibling GREEN-arm test module is \
         never compiled, so every rb22p_ test silently ceases to exist; and monster-privacy's \
         SCOPE clause justifies excluding a `_tests.rs` file from its scan surface only via \
         this PARENT declaration, because an inner `#![cfg(test)]` does not contain the \
         substring the eval looks for."
    );
}

/// EO-3 (doc truth, D0): the `accounts.rs` WRITE-ISOLATION header names the
/// privacy delegate.
///
/// The shipped header states that EVERY write to a pre-existing table goes
/// through a `rekey_*` helper in one of six named modules. rb-22 adds a seventh
/// delegate that is not a re-key, so leaving that paragraph unedited makes the D0
/// doc — the first thing the next reader of this module consults before adding a
/// write — actively FALSE.
///
/// Scanned over RAW text with whitespace, `/` and `!` deleted, because the claim
/// lives in a COMMENT and every comment-stripping view blanks it. Mirrors
/// `m22_squashed_no_slashes` (:3263) so a rustfmt re-wrap across two `//!` lines
/// cannot fool the scan. This is a doc-truth tooth and nothing more: it does not
/// claim to be behavioural evidence.
#[test]
fn rb22_accounts_header_names_the_privacy_delegate() {
    let marker = "\nuse ";
    let end = ACCOUNTS_RS.find(marker).unwrap_or_else(|| {
        panic!(
            "rb-22 [header/scope]: no top-level `use` item was found in accounts.rs, so the \
             module-header region is undefined and this scan would run over the whole file \
             (where the delegate is legitimately named in code) and pass VACUOUSLY."
        )
    });
    let header = rb22_header_squash(&ACCOUNTS_RS[..end]);
    assert!(
        !header.is_empty(),
        "rb-22 [header/scope]: the module-header region of accounts.rs is empty."
    );

    for (needle, what) in [
        (
            "privacy",
            "the owning module the export_bundle write is delegated to",
        ),
        (
            concat!("purge_export", "_bundles"),
            "the delegated helper complete_guest_claim now calls",
        ),
    ] {
        assert!(
            header.contains(needle),
            "rb-22 [header/doc-truth]: the accounts.rs WRITE-ISOLATION header does not mention \
             `{needle}` ({what}). The shipped paragraph claims every delegated write goes \
             through a `rekey_` helper in one of six named modules; rb-22 adds a delegate that \
             is neither a re-key nor in that list, so an unedited header states something that \
             is no longer true about this module's write surface."
        );
    }
}

/// DIAGNOSTIC ONLY, never a gate: how many occurrences of `needle` in an
/// ALREADY-SQUASHED source are bare identifier tokens — a non-word byte on BOTH
/// sides. The census below asserts on the RAW occurrence count and reports this
/// split only so a failure says WHY it fired (see the boundary note there).
fn rb22_bare_token_occurrences(squashed: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let bytes = squashed.as_bytes();
    let mut n = 0usize;
    let mut start = 0usize;
    while let Some(rel) = squashed[start..].find(needle) {
        let at = start + rel;
        let end = at + needle.len();
        let left_free = at == 0 || !is_word_byte(bytes[at - 1]);
        let right_free = end >= bytes.len() || !is_word_byte(bytes[end]);
        if left_free && right_free {
            n += 1;
        }
        start = end;
    }
    n
}

/// The sanctioned naming budget for one census file: how many times that file
/// may NAME the delegated purge helper, and why that number and no other.
fn rb22_purge_naming_budget(path: &str) -> (usize, &'static str) {
    match path {
        "accounts.rs" => (
            1,
            "the ONE sanctioned call site, the qualified call inside \
             complete_guest_claim that the call-site test pins statement by statement. \
             The module-header mention is a COMMENT and is blanked from this view, so 1 \
             means exactly one CODE naming. TWO means a second call — and a second one \
             written UNQUALIFIED under a local import is INVISIBLE to the \
             crate-path-prefixed needle the whole-file test uses. ZERO means the \
             delegation was deleted or moved",
        ),
        "privacy.rs" => (
            1,
            "the helper's own declaration and nothing else. TWO means the owning module \
             names it a second time — a wrapper or a re-export that hands a different \
             owner to a body the frozen-body pin still reports as correct. ZERO means \
             the declaration was renamed or deleted",
        ),
        _ => (
            0,
            "no module other than accounts.rs may name it at all. The helper is \
             `pub(crate)`, so EVERY module in the crate is already a legal caller, and a \
             caller here deletes export_bundle rows for whatever owner IT derives — \
             outside the claim ceremony this slice reviewed, and invisible to every \
             accounts.rs-scoped gate in it. An aliasing import counts as a naming: even \
             `use ... as p;` must spell the original name once",
        ),
    }
}

/// EO-1 (crate-wide naming census) — reducer-security-auditor Nit 2: NO module
/// other than `accounts.rs` may NAME the delegated purge helper.
///
/// `rb22_purge_called_exactly_once_in_accounts_rs` scans accounts.rs ONLY, and
/// the helper is `pub(crate)` — which makes every module in the crate a legal
/// caller. A THIRD module (economy.rs, say) that adds an aliasing import and
/// calls the helper with a badly-derived owner keeps every shipped rb-22 gate
/// GREEN while erasing export chunks no reviewer of the claim ceremony ever saw.
/// This test is what turns "there is exactly one call site" from a convention
/// into an enforced fact.
///
/// SURFACE: `m22_scanned_sources()` (:3146) — the crate root plus every `mod`
/// lib.rs declares, `_tests.rs` siblings excluded by construction (test code is
/// not compiled into the published wasm, so it cannot erase a live row).
/// `data_lifecycle_manifest_totality_bidirectional` pins that list against the
/// crate's live `mod` declarations in BOTH directions, which is what closes the
/// "add a module and leave it out of the census" hole; the [census/coverage]
/// clause here is the local backstop against a census that merely shrank.
///
/// NEEDLE: the BARE token — no paren, no `crate::privacy::` prefix. One needle
/// therefore catches all three spellings at once: the qualified call, an
/// unqualified call under a plain import, and an ALIASED import, because even
/// `use ... as p;` must spell the original name once before renaming it.
///
/// WORD BOUNDARIES — DELIBERATELY NOT REQUIRED ON EITHER SIDE. Measured against
/// this file's own `stripped_for_scan`, whose `squash_ws` deletes ALL
/// whitespace:
///   * RIGHT: an aliasing import squashes to `..._bundlesasp;` — the byte after
///     the needle is `a`, a WORD byte. A right-hand `is_word_byte` test would
///     score the alias as part of a longer identifier and DROP it: a silent
///     GREEN on precisely the bypass this test exists to kill.
///   * LEFT: the declaration squashes to `pub(crate)fnpurge...` — the byte
///     before the needle is `n`, a WORD byte. A left-hand test would drop the
///     declaration, and a third module's same-named twin declaration with it.
///
/// This is the same fusion hazard the [call/reachable] clause documents in the
/// opposite direction (there `squash_ws` fuses `return Err(..)` into
/// `returnErr(`, so a RIGHT boundary had to be dropped). The accepted cost is a
/// FALSE RED on a longer identifier sharing the prefix (a `_v2` twin): that is
/// the safe direction, and it is loud — the message names the file, the count
/// and the bare-versus-fused split. Under-counting would be a silent green on an
/// unreviewed second erasure path.
///
/// Kills: the W24 aliased third-module call (`use ... as p;` plus `p(ctx, x);`
///        in economy.rs); a fully-qualified third-module call; an unqualified
///        third-module call under a plain import; a same-named twin declared in
///        another module; a SECOND naming inside privacy.rs itself; a second
///        UNQUALIFIED call inside accounts.rs, which the crate-path-prefixed
///        needle of the whole-file test cannot see; and deletion of the
///        sanctioned call, which takes accounts.rs to 0.
///
/// Does NOT kill: a caller in a `_tests.rs` sibling (outside the published wasm
///        by construction, and outside this census by construction); a
///        consistently-renamed helper — the signature and frozen-body pins in
///        `rb22_privacy_module_exists_with_purge_body` own that.
#[test]
fn rb22_purge_named_nowhere_else_in_crate() {
    let needle = concat!("purge_export", "_bundles");
    let sources = m22_scanned_sources();
    let paths: Vec<&str> = sources.iter().map(|(p, _)| *p).collect();

    // --- anti-vacuity: the scanned surface itself ----------------------------
    let n_paths = paths.len();
    assert!(
        n_paths >= 20,
        "rb-22 [census/coverage]: the crate-wide census lists only {n_paths} source(s) \
         ({paths:?}); the live tree lists 22. A shrunken census is a census that stopped \
         looking — every per-file count below would then be GREEN about files nobody scanned, \
         and the module a bypass lands in is exactly the one an attacker would drop from this \
         list."
    );
    for required in ["accounts.rs", "privacy.rs"] {
        assert!(
            paths.contains(&required),
            "rb-22 [census/coverage]: the census does not include {required} ({paths:?}). Those \
             two files are the only ones with a NON-ZERO naming budget: without them the loop \
             below proves only that a set of modules that were never allowed to name the helper \
             do not name it, and the sanctioned call site is unmeasured."
        );
    }

    // --- one budget per compiled module --------------------------------------
    for (path, src) in &sources {
        let squashed = stripped_for_scan(src);
        let n = m22_count_occurrences(&squashed, needle);
        let bare = rb22_bare_token_occurrences(&squashed, needle);
        let fused = n.saturating_sub(bare);
        let (expected, why) = rb22_purge_naming_budget(path);
        assert_eq!(
            n, expected,
            "rb-22 [census/site]: {path} names the bare purge token {n} time(s); exactly \
             {expected} is allowed — {why}. Boundary diagnostic: {bare} of the {n} are bare \
             identifier tokens and {fused} are fused into a longer run of identifier bytes. In \
             the whitespace-squashed view that fused shape is EITHER an aliasing import (the \
             `as p;` tail fuses onto the name) OR a longer identifier sharing the prefix, and \
             this census counts BOTH on purpose: dropping the fused ones would blind it to the \
             alias, which is the exact bypass it exists to catch."
        );
    }
}

// ===========================================================================
// rb-24 (M22 S3, first arm) — THE DELETION REAPER SCHEDULE: ARMED ON REQUEST,
// DISARMED ON CANCEL.
//
// EARS criteria (`specs/monster-realm-v2/M22-privacy-compliance.spec.md` §7.4):
//   PRV1-1  WHEN `delete_account` is called by an authenticated identity with
//           `account.status == Active` THE SYSTEM SHALL transition `status` to
//           `PendingDeletion`, set `deletion_requested_at_ms`, and insert
//           EXACTLY ONE `AccountDeletionReaperSchedule` row for that identity.
//   PRV1-3  WHEN `cancel_account_deletion` is called by an identity in
//           `PendingDeletion` whose `terminal_at_ms` is `None` THE SYSTEM SHALL
//           ... delete that identity pending `AccountDeletionReaperSchedule`
//           row.
//   E1      the new scheduled reducer rejects every non-scheduler caller (spec
//           §4.4: `Scheduler-only guard, identical in shape to accounts.rs`).
//   S3-boundary  this slice ships the ARM/DISARM wiring plus a DELIBERATELY
//           EMPTY reaper body. The cascade itself (PRV1-6a..PRV1-6e), the
//           reaper-side recheck (PRV1-5) and the late-cancel terminal error
//           (PRV1-4) are LATER arms of S3 and are NOT gated here.
//
// SCAN HYGIENE — the file header rule, restated because this section adds a
// second scheduled table and a second reaper to a file a dozen evals
// concatenate wholesale (every `.rs` under `server-module/src`, `_tests.rs`
// siblings included). Every needle below is assembled from `concat!` fragments,
// so this file never carries a contiguous table attribute, reducer attribute,
// accessor call, write-verb chain or reaper call site that such a scanner could
// count as a real one. This section contains no block comment, no raw string,
// no backslash-escaped quote character, no char literal holding a quote, and no
// bare double-quote character inside any comment.
//
// WHY THE FROZEN-BODY PINS ARE EXACT EQUALITY and not containment: the rb-22
// red-team measured four clippy-clean shapes that satisfy every containment
// clause over a correct-looking body — an `if false` wrapper, a shadowed
// binding, a shadowed loop variable, and an appended aliased foreign write.
// Equality kills that whole family in one assertion, and the same four shapes
// apply verbatim to a collect-then-delete disarm helper.
// ===========================================================================

use game_core::{is_deletion_due, DELETION_GRACE_MS_DEFAULT};

// ---------------------------------------------------------------------------
// rb-24 needles. Split mid-token, per the file header rule.
// ---------------------------------------------------------------------------

/// The squashed table attribute the new schedule table must carry, verbatim.
fn rb24_nd_table_attr() -> String {
    [
        concat!("#[spacetimedb::", "table", "("),
        concat!("access", "or=account_deletion_reaper", "_schedule,"),
        concat!("sched", "uled(account_deletion", "_reaper))]"),
    ]
    .concat()
}

/// The accessor-naming PREFIX of that attribute. ANY second declaration of the
/// same accessor — with or without extra arguments such as `public` — contains
/// it, which is what makes the uniqueness clause total rather than a pin on one
/// spelling.
fn rb24_nd_table_attr_prefix() -> String {
    [
        concat!("#[spacetimedb::", "table", "("),
        concat!("access", "or=account_deletion_reaper", "_schedule"),
    ]
    .concat()
}

/// The squashed struct marker (`extract_squashed_fn_body` brace-walks from it).
fn rb24_nd_struct_marker() -> String {
    concat!("struct", "AccountDeletionReaperSchedule{").to_string()
}

/// The PREFIX-AGNOSTIC accessor method token: a leading `.` then the accessor
/// name and its opening paren, with NO `ctx.db.` prefix. rb-24 red-team
/// (artifact pass) MEASURED that `let d = &ctx.db;` then `d.<accessor>()`
/// squashes without the `ctx.db.` prefix, so a prefixed needle misses an
/// aliased write entirely (the shared `write_target_accessors` alias hole). A
/// leading-dot method token matches the accessor call through ANY receiver
/// (`ctx.db.`, an aliased handle, a further-chained handle) while still not
/// matching the `accessor = <name>,` attribute (comma, no leading dot) or the
/// CamelCase struct type.
fn rb24_nd_accessor_method() -> String {
    concat!(".account_deletion_reaper", "_schedule(").to_string()
}

/// The accessor NAME, as `allowed_write_tables` and `write_target_accessors`
/// spell it.
fn rb24_nd_sched_accessor() -> String {
    concat!("account_deletion_reaper", "_schedule").to_string()
}

fn rb24_nd_arm_decl() -> String {
    concat!("fnarm_deletion", "_reaper(").to_string()
}

fn rb24_nd_disarm_decl() -> String {
    concat!("fndisarm_deletion", "_reaper(").to_string()
}

fn rb24_nd_arm_call() -> String {
    concat!("arm_deletion", "_reaper(").to_string()
}

fn rb24_nd_disarm_call() -> String {
    concat!("disarm_deletion", "_reaper(").to_string()
}

fn rb24_nd_reaper_decl() -> String {
    concat!("fnaccount_deletion", "_reaper(").to_string()
}

fn rb24_nd_delete_account_decl() -> String {
    concat!("fndelete", "_account(").to_string()
}

fn rb24_nd_cancel_decl() -> String {
    concat!("fncancel_account", "_deletion(").to_string()
}

// ---------------------------------------------------------------------------
// rb-24 scan machinery.
// ---------------------------------------------------------------------------

/// Occurrences of the ARM call token in an already-squashed source, EXCLUDING
/// the ones that are merely the tail of a DISARM mention.
///
/// Written as arithmetic rather than as a word-boundary test, and the reason is
/// measured against this file own `squash_ws`:
///   - the DISARM call token CONTAINS the ARM call token outright (the former is
///     the latter with a three-letter prefix), so a plain count over-reports by
///     one per disarm mention. A test that asserts `the arm token does not
///     appear in the cancel reducer` is therefore UNSATISFIABLE as literally
///     stated, because the sanctioned disarm call carries the arm token as a
///     substring;
///   - a LEFT word-boundary test does not fix it either: the squashed
///     DECLARATION fuses the `fn` keyword onto the front of the name, so the
///     byte to the left of the arm token there is a word byte and a
///     left-boundary rule silently drops the declaration — and a same-named twin
///     declared in another module with it. This is the same `squash_ws` fusion
///     hazard the rb-22 census documents in the opposite direction.
///
/// Subtraction is exact: two matches of the arm needle can never overlap, and
/// every disarm occurrence carries exactly one arm substring.
fn rb24_net_arm_mentions(squashed: &str) -> usize {
    let arm = m22_count_occurrences(squashed, &rb24_nd_arm_call());
    let disarm = m22_count_occurrences(squashed, &rb24_nd_disarm_call());
    assert!(
        arm >= disarm,
        "[rb24/net-count] the arm-mention arithmetic is broken: {arm} occurrence(s) of the arm \
         token against {disarm} of the disarm token, yet every disarm occurrence must contain \
         exactly one arm substring. The needle spelling changed and this counter can no longer \
         be trusted, so it must not report a number."
    );
    arm - disarm
}

/// The `(start, end)` byte offsets of a fn body inside an ALREADY-SQUASHED
/// source — the same brace walk `extract_squashed_fn_body` performs, returning
/// the offsets it discards.
///
/// The sole-writer census has to ask WHERE each accessor call sits, and it must
/// not inherit `write_target_accessors` nearest-preceding-`ctx.db.`
/// attribution: that walk has measured alias holes (an anchorless write is
/// dropped, an aliased one is misattributed to the previous accessor), which
/// would make a census built on it silently under-report.
fn rb24_fn_body_span(squashed: &str, fn_needle: &str) -> (usize, usize) {
    let fn_start = squashed.find(fn_needle).unwrap_or_else(|| {
        panic!(
            "[rb24/span] the fn needle {fn_needle:?} was not found in the squashed source, so \
             every span-scoped clause that depends on it has NO scope and would pass \
             vacuously. Fail loud rather than skip."
        )
    });
    let brace_rel = squashed[fn_start..]
        .find('{')
        .unwrap_or_else(|| panic!("[rb24/span] {fn_needle:?} is followed by no opening brace."));
    let body_start = fn_start + brace_rel + 1;
    let bytes = squashed.as_bytes();
    let mut depth: usize = 1;
    let mut i = body_start;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return (body_start, i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    panic!("[rb24/span] the body of {fn_needle:?} is not brace-balanced.")
}

/// The balanced `(..)` span (delimiters excluded) opening at or after `from`.
fn rb24_paren_span(squashed: &str, from: usize) -> (usize, usize) {
    let rel = squashed[from..]
        .find('(')
        .unwrap_or_else(|| panic!("[rb24/paren] no opening paren at or after offset {from}."));
    let open = from + rel;
    let bytes = squashed.as_bytes();
    let mut depth: usize = 0;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return (open + 1, i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    panic!("[rb24/paren] the argument list opened at offset {open} is unbalanced.")
}

/// Brace depth of an already-squashed fn-body PREFIX.
fn rb24_brace_depth(prefix: &str) -> i32 {
    let mut depth: i32 = 0;
    for c in prefix.chars() {
        if c == '{' {
            depth += 1;
        } else if c == '}' {
            depth -= 1;
        }
    }
    depth
}

/// Does an already-squashed region contain a bare `return` TOKEN?
///
/// Word boundary on the LEFT ONLY, exactly as the rb-22 reachability clause
/// documents: `squash_ws` fuses `return Err(..)` into `returnErr(` and
/// `return Ok(())` into `returnOk(())`, so ALSO requiring a non-word byte on the
/// right would blind this to precisely the early-exit shapes it exists to
/// catch. The left-only rule still rejects an identifier such as `early_return`.
fn rb24_has_return_token(region: &str) -> bool {
    let bytes = region.as_bytes();
    let mut scan = 0usize;
    while let Some(rel) = region[scan..].find("return") {
        let at = scan + rel;
        if at == 0 || !is_word_byte(bytes[at - 1]) {
            return true;
        }
        scan = at + "return".len();
    }
    false
}

/// THE FROZEN ARM BODY. Derived by hand through the live three-stage pipeline
/// (`strip_rust_strings` -> `strip_rust_comments` -> `squash_ws`) over the
/// sanctioned source, so a comment inside the helper is invisible here and a
/// rustfmt re-wrap cannot move a byte of it. The trailing comma after the
/// `saturating_mul` argument is rustfmt-forced (the call wraps at 100 columns)
/// and is present in the shipped `arm_claim_reaper` twin.
fn rb24_frozen_arm_body() -> String {
    [
        concat!("ctx", ".db."),
        concat!("account_deletion_reaper", "_schedule()"),
        concat!(".ins", "ert("),
        "AccountDeletionReaperSchedule{",
        "scheduled_id:0,",
        "scheduled_at:ScheduleAt::Time(Timestamp::from_micros_since_unix_epoch(",
        concat!(
            "deletion_fire_at",
            "_ms(requested_at_ms).saturating_mul(1_000),"
        ),
        ")),",
        "account_identity:account,",
        "});",
    ]
    .concat()
}

/// The frozen arm SIGNATURE slice `extract_squashed_fn_sig` returns (it starts
/// at the fn needle, so the visibility keyword is deliberately outside it).
fn rb24_frozen_arm_sig() -> String {
    concat!(
        "fnarm_deletion",
        "_reaper(ctx:&ReducerContext,account:Identity,requested_at_ms:i64)"
    )
    .to_string()
}

/// THE FROZEN DISARM BODY — the two-phase collect-then-delete shape ADR-0126
/// mandates and `disarm_claim_reaper` already implements. Deleting inside the
/// filter iteration mutates the table being iterated; a filter on the wrong
/// column, or a delete keyed on the wrong column, disarms either nothing or
/// somebody else schedule row, and every containment clause stays green on all
/// three.
fn rb24_frozen_disarm_body() -> String {
    [
        "letids:Vec<u64>=",
        concat!("ctx", ".db."),
        concat!("account_deletion_reaper", "_schedule()"),
        concat!(
            ".account",
            "_identity().filter(account).map(|s|s.scheduled_id).collect();"
        ),
        "foridinids{",
        concat!("ctx", ".db."),
        concat!("account_deletion_reaper", "_schedule()"),
        concat!(".scheduled_id().del", "ete(id);"),
        "}",
    ]
    .concat()
}

/// The frozen disarm SIGNATURE slice.
fn rb24_frozen_disarm_sig() -> String {
    concat!(
        "fndisarm_deletion",
        "_reaper(ctx:&ReducerContext,account:Identity)"
    )
    .to_string()
}

/// THE FROZEN REAPER BODY for THIS slice: the rejecting scheduler guard and
/// nothing else. Note that `stripped_for_scan` blanks string literals, so the
/// reject reason reads as an empty argument here.
///
/// This pin is DESIGNED TO RED when the cascade lands. That is deliberate and
/// is the S3-boundary tooth: the arm that ships the cascade must come back to
/// this literal, re-derive it from the spec §4.4 step list, and re-review the
/// scheduler guard position at the same time — rather than growing the body one
/// unreviewed statement at a time under a containment pin that never notices.
fn rb24_frozen_reaper_body() -> String {
    let guard = scheduler_guard_needle();
    let tail = concat!("Err(.to", "_string());}Ok(())").to_string();
    [guard, tail].concat()
}

// ---------------------------------------------------------------------------
// rb-24 / PRV1-1 — THE SCHEDULE TABLE.
// ---------------------------------------------------------------------------

/// PRV1-1 (spec §4.4): `account_deletion_reaper_schedule` is declared in
/// `accounts.rs` exactly once, PRIVATE, with exactly the three ADR-0126 D6
/// columns in order — and no fourth.
///
/// Pinned by EXACT EQUALITY over the string-blanked, comment-blanked,
/// whitespace-squashed declaration, the same mechanics as
/// `export_bundle_struct_shape_and_privacy` and for the same reasons: BSATN
/// layout is order-sensitive, and a containment check is green on an appended
/// field, a reordered pair and a widened type alike.
///
/// The MISSING FOURTH COLUMN is the security property, not tidiness. Spec §4.4
/// makes the minimal field set explicit: `deliberately no timestamp field, so
/// staleness can only derive from the live account row own
/// `deletion_requested_at_ms` plus the injected clock, never from anything a
/// caller could supply`. A `requested_at_ms: i64` column here would be a
/// caller-supplied staleness input on a row a client can hand-build if the
/// scheduler guard is ever weakened.
///
/// Kills: adding `public` to the attribute (a scheduled row naming an identity
///        whose account is about to be erased is not client data);
///        a SECOND attribute naming the same accessor with extra arguments,
///        which an exact-text pin alone is blind to;
///        adding, renaming, reordering or re-typing any column;
///        dropping the `#[auto_inc]` on the synthetic primary key (every arm
///        would then insert `scheduled_id: 0` and collide);
///        dropping the btree index on `account_identity` (the disarm path
///        filters on it — without the index the filter does not compile as a
///        column accessor at all, and the sanctioned shape is what PRV1-3
///        depends on).
#[test]
fn rb24_deletion_schedule_table_shape_and_privacy() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);

    let attr = rb24_nd_table_attr();
    assert_eq!(
        m22_count_occurrences(&squashed, &attr),
        1,
        "[rb24/table-attr] accounts.rs must carry the table attribute `{attr}` EXACTLY once. \
         ZERO means the scheduled table this slice exists to add is missing, mis-spelled, or \
         declared in schema.rs instead of colocated with its reducer — and the \
         `scheduled(..)` attribute resolves as a bare ident only in the file that declares the \
         reducer (the ADR-0056 exception). MORE THAN ONE is a second declaration of the same \
         schedule."
    );

    let prefix = rb24_nd_table_attr_prefix();
    assert_eq!(
        m22_count_occurrences(&squashed, &prefix),
        1,
        "[rb24/table-attr-unique] exactly one table attribute in accounts.rs may name the \
         `{prefix}` accessor. This clause is separate from the exact-text one above on \
         purpose: an exact pin proves the sanctioned declaration EXISTS and says nothing about \
         a SECOND attribute naming the same accessor with a different argument list."
    );

    let at = idx(&squashed, &prefix);
    let (arg_start, arg_end) = rb24_paren_span(&squashed, at);
    let args = &squashed[arg_start..arg_end];
    assert!(
        !args.contains("public"),
        "[rb24/table-private] the schedule table attribute carries a `public` argument \
         (arguments read: {args:?}). Unlike the inert `public` on a VIEW attribute, `public` \
         on a TABLE is the entire security boundary: this row names the identity of an account \
         that has requested deletion, together with the wall-clock instant its data will be \
         erased. Publishing that is a directory of pending deletions."
    );

    let marker = rb24_nd_struct_marker();
    assert_eq!(
        m22_count_occurrences(&squashed, &marker),
        1,
        "[rb24/table-struct-unique] the schedule struct must be declared exactly once in \
         accounts.rs, so the brace walk below has an unambiguous target."
    );
    let fields = extract_squashed_fn_body(&squashed, &marker).unwrap_or_else(|| {
        panic!(
            "[rb24/table-struct-read] the schedule struct declaration was not found in \
             accounts.rs (marker {marker:?} over the string-blanked, comment-blanked, \
             whitespace-squashed source). The shape pin cannot check a declaration it cannot \
             read — hard failure, never a skip."
        )
    });

    let expected_fields = [
        concat!("#[primary", "_key]"),
        concat!("#[auto", "_inc]"),
        "pubscheduled_id:u64,",
        "pubscheduled_at:ScheduleAt,",
        concat!("#[index(", "btree)]"),
        "pubaccount_identity:Identity,",
    ]
    .concat();
    assert_eq!(
        fields, expected_fields,
        "[rb24/table-columns] the schedule table column list is not the ADR-0126 D6 shape. It \
         must be exactly, in order: scheduled_id (u64, primary key, auto_inc), scheduled_at \
         (ScheduleAt — the column the runtime itself reads to fire the one-shot), \
         account_identity (Identity, btree — the column the PRV1-3 disarm filters on). A \
         reorder also changes the BSATN layout of a live table, and the `scheduled(..)` \
         attribute is automigration-frozen, so a shape change here is a destructive republish \
         rather than an additive migration."
    );

    let lower = fields.to_lowercase();
    assert!(
        !lower.contains("timestamp"),
        "[rb24/table-no-timestamp] the schedule table declares a timestamp column. Spec §4.4 \
         is explicit that the field set is minimal and deliberately carries NO timestamp, so \
         staleness derives only from the live account row own deletion_requested_at_ms plus \
         the injected clock. A stamp on the SCHEDULE row is an input a caller could supply if \
         the scheduler guard is ever weakened, and it is a second source of truth for due-ness \
         the moment it disagrees with the account row."
    );
    assert!(
        !lower.contains("_at_ms"),
        "[rb24/table-no-stamp-column] the schedule table declares an `_at_ms` column — see the \
         timestamp clause above. The one legitimate time-carrying column here is \
         `scheduled_at`, which the RUNTIME owns."
    );
    assert_eq!(
        m22_count_occurrences(fields, "pub"),
        3,
        "[rb24/table-field-count] the schedule table must declare exactly three columns. This \
         clause is a coarse restatement of the exact-equality pin above, and it exists so a \
         failure message says WHICH kind of drift happened when both fire."
    );
}

// ---------------------------------------------------------------------------
// rb-24 / PRV1-1 — THE FIRE INSTANT, AS A PURE SEAM.
// ---------------------------------------------------------------------------

/// PRV1-1 (spec §4.3 boundary): `deletion_fire_at_ms(t)` is the exact instant at
/// which `game_core::is_deletion_due` flips true for a request stamped at `t`.
///
/// The two halves are what make this a boundary and not a smoke test: DUE at
/// `fire`, NOT DUE at `fire - 1`. Together they pin the offset to
/// `DELETION_GRACE_MS_DEFAULT` exactly — a fire instant computed with a larger
/// constant is still due at `fire - 1`, and one computed with a smaller
/// constant is not yet due at `fire`.
///
/// The explicit value clause is separate so a failure attributes: a fire time
/// derived from `CLAIM_TTL_MS` (the other TTL constant in scope in this module,
/// also an `i64` in milliseconds) type-checks, compiles, is clippy-clean, and
/// schedules the irreversible cascade fifteen minutes after the request instead
/// of a week.
///
/// Kills: an off-by-one fire instant in either direction; a fire time derived
///        from the wrong constant; a `saturating_sub` in place of the add.
#[test]
fn rb24_deletion_fire_at_ms_boundary() {
    for t in [0i64, 1i64, 1_700_000_000_000i64] {
        let fire = deletion_fire_at_ms(t);
        assert_eq!(
            fire,
            t + DELETION_GRACE_MS_DEFAULT,
            "[rb24/fire-value] deletion_fire_at_ms({t}) must be the request instant plus \
             game_core::DELETION_GRACE_MS_DEFAULT. The grace window is a game-core constant \
             with one SSOT; a fire time derived from any other duration in scope schedules the \
             irreversible cascade at a moment nobody chose."
        );
        assert!(
            is_deletion_due(Some(t), fire),
            "[rb24/fire-due-at] a request stamped at {t} must read as DUE at its own fire \
             instant. `is_deletion_due` is boundary-INCLUSIVE; a fire time one millisecond \
             early schedules a reaper invocation that finds the account not yet due and — \
             under this slice one-shot schedule, which nothing re-arms — never fires again."
        );
        assert!(
            !is_deletion_due(Some(t), fire - 1),
            "[rb24/fire-not-due-before] a request stamped at {t} must NOT read as due one \
             millisecond before its fire instant. Without this half the fire time is pinned \
             only from below: any instant at or after the true boundary satisfies the clause \
             above, including one a year late."
        );
    }
}

/// PRV1-1 (saturation bound): `deletion_fire_at_ms` clamps at `i64::MAX` rather
/// than overflowing, and the KNOWN divergence that clamping produces is
/// documented BY ASSERTION rather than in prose.
///
/// The saturating add is not defensive decoration: the workspace `Cargo.toml`
/// release profile sets `overflow-checks = true`, so a wrapping add would be a
/// panic that aborts the whole `delete_account` transaction in production.
///
/// THE THIRD ASSERTION DOCUMENTS A BOUND, IT DOES NOT ASSERT DESIRED SEMANTICS.
/// At a saturating request stamp the fire instant clamps to `i64::MAX`, and the
/// elapsed window from the request to that clamped instant is then SHORTER than
/// the grace window — so the account reads as NOT due at its own fire time and
/// the one-shot reaper no-ops forever. That is a real edge of the design, it is
/// unreachable with any wall clock (the stamp is milliseconds since the Unix
/// epoch), and it is recorded here so the next reader finds it as a measured
/// fact rather than rediscovering it. It must not be read as a requirement that
/// a saturating request never completes.
///
/// Kills: a plain `+` (release-profile overflow panic inside a reducer);
///        a `checked_add(..).unwrap_or(0)` fallback, which would make a
///        saturating request due IMMEDIATELY — the opposite failure, and the
///        dangerous direction.
#[test]
fn rb24_deletion_fire_at_ms_saturates() {
    assert_eq!(
        deletion_fire_at_ms(i64::MAX - 1),
        i64::MAX,
        "[rb24/fire-saturate-near-max] the fire instant must CLAMP at i64::MAX. The release \
         profile enables overflow-checks, so a wrapping add here is a panic that aborts the \
         whole delete_account transaction rather than a wrong number."
    );
    assert_eq!(
        deletion_fire_at_ms(i64::MAX),
        i64::MAX,
        "[rb24/fire-saturate-max] the fire instant must clamp at i64::MAX for the extreme \
         request stamp too."
    );
    assert!(
        !is_deletion_due(Some(i64::MAX - 1), deletion_fire_at_ms(i64::MAX - 1)),
        "[rb24/fire-saturation-divergence] this clause DOCUMENTS A BOUND, it does not assert \
         desired semantics. At a saturating request stamp the fire instant clamps, so the \
         elapsed window to that instant is shorter than the grace window and the account never \
         reads as due. If this assertion ever fails, the clamping behaviour changed — most \
         likely to a fallback that makes a saturating request due IMMEDIATELY, which is the \
         dangerous direction. Re-derive the bound from the spec before editing this line."
    );
}

/// PRV1-1 (parity property): across a spread of non-saturating request stamps,
/// `deletion_fire_at_ms` and `game_core::is_deletion_due` agree exactly — due at
/// the fire instant, not due one millisecond earlier.
///
/// This is the same rule as the boundary test, driven over a wider input set so
/// a fire instant computed with any input-DEPENDENT error (a proportional
/// window, a stamp-truncating rounding step, a sign flip on a negative
/// clock-skewed stamp) is caught rather than only a constant offset. The
/// negative stamp is in the spread on purpose: `is_deletion_due` documents that
/// the subtraction saturates in both directions, so a future-dated or
/// negative-clock request must not silently invert.
///
/// Kills: a window scaled by the request stamp; a truncating conversion through
///        seconds; an implementation that special-cases zero.
#[test]
fn rb24_deletion_fire_at_ms_parity_with_is_deletion_due() {
    let spread: [i64; 7] = [
        -1,
        0,
        1,
        1_000,
        1_700_000_000_000,
        1_767_225_600_000,
        i64::MAX - DELETION_GRACE_MS_DEFAULT,
    ];
    for t in spread {
        assert!(
            t <= i64::MAX - DELETION_GRACE_MS_DEFAULT,
            "[rb24/parity-fixture-nonsaturating] the fixture stamp {t} saturates, so the two \
             clauses below would be asserting the documented saturation divergence rather than \
             the parity property. Saturation is covered by its own test."
        );
        let fire = deletion_fire_at_ms(t);
        assert!(
            is_deletion_due(Some(t), fire),
            "[rb24/parity-due] a request stamped at {t} must read as DUE at its computed fire \
             instant {fire}. The reaper is armed at that instant and this slice arms it exactly \
             once, so a fire time the due-predicate disagrees with is a deletion request that \
             is never carried out and never reported as failed."
        );
        assert!(
            !is_deletion_due(Some(t), fire - 1),
            "[rb24/parity-not-due] a request stamped at {t} must NOT read as due one \
             millisecond before its computed fire instant {fire}. Failing only here means the \
             fire time is LATE relative to the grace window the player was promised."
        );
    }
}

// ---------------------------------------------------------------------------
// rb-24 / PRV1-1 — THE ARM, WIRED INTO `delete_account`.
// ---------------------------------------------------------------------------

/// PRV1-1 (spec §4.2): `delete_account` arms the deletion reaper as its LAST
/// step, after the status write, from the SAME `now` the status write used.
///
/// Spec §4.2 places the schedule-insert last on purpose: a crash mid-reducer
/// then leaves `PendingDeletion` with no schedule row, which is always safely
/// re-driveable by a repeat `delete_account` (idempotent per AUTH-28) or by
/// `cancel_account_deletion`. The reverse order leaves an armed reaper for an
/// account that was never transitioned.
///
/// SEVEN CLAUSES, each separately tagged. Coarse mutants only ever prove the
/// first assertion in a test — every later clause needs a surgical mutant that
/// can be attributed by FAILURE MESSAGE:
///   statement-form / net count / update shape / ordering / reachability /
///   brace depth / the two binding-uniqueness rules.
///
/// THE `(account,now)` PIN IS THE LOAD-BEARING ONE. Passing the pure
/// `requested_deletion` constructor a FRESH clock reading instead of the shared
/// `now` binding compiles, is clippy-clean and reads correctly — but it is a
/// SECOND clock read, so the instant stamped on the row and the instant the
/// fire time is derived from are two different numbers. The grace window a
/// player is actually granted then depends on how long the reducer spent
/// between the two reads, and nothing anywhere else in the tree would notice.
/// Pinning the argument list as `(account,now)` forces one binding, read once,
/// shared by the row stamp and the schedule alike.
///
/// Kills: dropping the arm call; a second unreviewed arm; the arm sequenced
///        BEFORE the status write; the arm re-argued from a fresh clock read or
///        from a different identity; an early `return` inserted between the
///        write and the arm; the arm wrapped in a conditional or a never-invoked
///        closure (both keep every containment and ordering clause green); a
///        `let now = ...` shadow that re-points the fire time; a `let me = ...`
///        rebind that arms the reaper for somebody else.
#[test]
fn rb24_delete_account_arms_the_reaper_last() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &rb24_nd_delete_account_decl())
        .expect("[rb24/arm-scope] fn delete_account was not found in accounts.rs");

    let statement = format!(";{}ctx,me,now);", rb24_nd_arm_call());
    assert_eq!(
        m22_count_occurrences(body, &statement),
        1,
        "[rb24/arm-statement] delete_account must contain the bare statement `{statement}` \
         exactly once. The leading and trailing semicolons pin STATEMENT POSITION, not merely \
         presence: a call that is an OPERAND of something else — a closure binding, an \
         iterator adaptor — sits at brace depth 0, satisfies every containment and ordering \
         clause in this test, and never runs. The argument list pins that the reaper is armed \
         for the CALLER identity from the SHARED `now` binding."
    );
    assert_eq!(
        rb24_net_arm_mentions(body),
        1,
        "[rb24/arm-count] delete_account must name the arm helper exactly once. More than one \
         is a second schedule row for the same request: PRV1-1 says EXACTLY ONE \
         AccountDeletionReaperSchedule row, and a second row fires a second cascade that the \
         PRV1-3 disarm — which deletes every matching row — would mask in testing but which \
         doubles every side effect in production."
    );

    let update = concat!(".upd", "ate(requested_deletion(account,now))");
    assert_eq!(
        m22_count_occurrences(body, update),
        1,
        "[rb24/arm-update-shape] delete_account must stamp the account row exactly once, and \
         with the SHARED `now` binding rather than a second clock reading. A per-call \
         `now_ms(ctx)` inside the update compiles, is clippy-clean, and silently decouples the \
         instant recorded on the row from the instant the reaper fire time is derived from, so \
         the grace window a player actually receives depends on reducer timing."
    );

    let at_update = idx(body, update);
    let at_stmt = idx(body, &statement);
    assert!(
        at_update < at_stmt,
        "[rb24/arm-after-update] the arm call (offset {at_stmt}) must run AFTER the status \
         write (offset {at_update}). Spec §4.2 places the schedule-insert last so a crash \
         mid-reducer leaves PendingDeletion with no schedule row — always re-driveable. Armed \
         first, the same crash leaves a live reaper aimed at an account that was never \
         transitioned, and this slice ships no reaper-side status recheck to catch it."
    );

    let region = &body[at_update..at_stmt];
    assert!(
        !rb24_has_return_token(region),
        "[rb24/arm-reachable] a `return` token sits between the status write and the arm call. \
         Every other clause in this test reasons about POSITION and none about REACHABILITY, \
         so an early exit here leaves the account PendingDeletion with no reaper armed — a \
         deletion request that is accepted, displayed to the player, and never carried out. \
         Region text: {region:?}"
    );

    assert_eq!(
        rb24_brace_depth(&body[..at_stmt]),
        0,
        "[rb24/arm-depth0] the arm call sits inside a nested block of delete_account rather \
         than at the top level of the fn body. A conditional arm is a conditional deletion: a \
         guard that is always false at this point keeps every count-, argument-, ordering- and \
         region-based clause above green while no schedule row is ever inserted."
    );

    assert_eq!(
        m22_count_occurrences(body, "letnow="),
        1,
        "[rb24/wire-no-shadow] delete_account must bind `now` exactly once. A second binding \
         re-points the fire time at a different instant while the textually perfect arm \
         statement above stays green — the measured shadow shape from the rb-22 red-team, \
         applied to a clock instead of an identity."
    );
    assert_eq!(
        m22_count_occurrences(body, concat!("letnow=now", "_ms(ctx);")),
        1,
        "[rb24/wire-now-source] the single `now` binding in delete_account must come from the \
         module injected-clock seam. A literal, a cached static or a value derived from a row \
         would make the grace window something other than wall-clock time since the request."
    );
    assert_eq!(
        m22_count_occurrences(body, "letme="),
        1,
        "[rb24/wire-no-rebind] delete_account must bind `me` exactly once. A rebind re-points \
         the armed schedule at an identity other than the caller, which is a scheduled \
         irreversible erasure of somebody else account, and every textual clause above stays \
         green."
    );
    assert_eq!(
        m22_count_occurrences(body, "letme=ctx.sender();"),
        1,
        "[rb24/wire-me-source] the single `me` binding must be `ctx.sender()`. The subject \
         identity of every reducer in this module is the sender and nothing else (ADR-0179 \
         G2); an identity read from a row or a parameter is the client-supplied-Identity hole."
    );
}

/// PRV1-1 (helper body): `arm_deletion_reaper` inserts exactly one schedule row,
/// with the fire instant derived through `deletion_fire_at_ms`, and does nothing
/// else.
///
/// EXACT EQUALITY over the squashed body, because containment was MEASURED
/// insufficient for this exact shape family (rb-22 red-team): an `if false`
/// wrapper around a correct body, a shadowed binding, and an appended foreign
/// write all satisfy every needle-based clause and are clippy-clean.
///
/// The signature pin is separate and carries its own tag: it is what makes the
/// body pin readable — `requested_at_ms` and `account` in the body mean nothing
/// unless the parameters they name are the ones the call site passes.
///
/// Kills: an inline add of a hand-typed grace literal that bypasses the pure
///        seam (a second copy of the window, free to drift from game-core, and
///        an operator retune of the constant would then move only one of them);
///        a fire time in milliseconds where the API wants microseconds (the
///        `saturating_mul(1_000)` is part of the pin);
///        a non-saturating multiply (release-profile overflow panic);
///        `scheduled_at` built from a duration rather than an absolute instant;
///        an extra statement, a dead branch, or a shadowed binding.
#[test]
fn rb24_arm_deletion_reaper_body_frozen() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let sig = extract_squashed_fn_sig(&squashed, &rb24_nd_arm_decl()).unwrap_or_else(|| {
        panic!(
            "[rb24/arm-sig-read] fn arm_deletion_reaper was not found in accounts.rs, or its \
             signature reaches no opening brace. The frozen-body pin below would then have \
             nothing to compare and must not report a pass."
        )
    });
    assert_eq!(
        sig,
        rb24_frozen_arm_sig(),
        "[rb24/arm-sig] the arm helper signature is not the frozen one. It must take the \
         reducer context as `ctx`, the subject as `account: Identity`, and the request instant \
         as `requested_at_ms: i64` — an OWNER-GENERIC identity parameter, never a \
         claim-specific or caller-specific name, and an explicit instant rather than a clock \
         it reads for itself, so the row stamp and the fire time cannot diverge."
    );

    let body = extract_squashed_fn_body(&squashed, &rb24_nd_arm_decl())
        .expect("[rb24/arm-body-read] the arm helper body is not brace-balanced");
    assert_eq!(
        body,
        rb24_frozen_arm_body(),
        "[rb24/arm-body] arm_deletion_reaper must be exactly the single sanctioned insert: one \
         schedule row, `scheduled_id: 0` for auto_inc, an ABSOLUTE fire instant built from \
         deletion_fire_at_ms times 1000 with a SATURATING multiply, and the subject identity. \
         Containment pins were measured insufficient against dead-branch, shadowed-binding and \
         appended-foreign-write shapes, all clippy-clean; equality kills the family in one \
         assertion. If the sanctioned body legitimately changes, re-derive this literal from \
         the spec and update it consciously."
    );
}

/// PRV1-1 (call-site uniqueness, crate-wide): the arm helper is DECLARED once
/// and CALLED once anywhere in the compiled crate, and that one call site is
/// inside `delete_account`.
///
/// The body-scoped test above pins the call that lives in `delete_account`; this
/// one pins that there is no OTHER. Together they are total: a call moved out of
/// the reducer fails the scoped test while keeping this count at two, and a
/// decoy second call site fails this one while keeping the scoped test green.
///
/// SCOPE, STATED HONESTLY: the helper is module-private, so the compiler already
/// refuses a call from another module. What this census adds on top is (a) a
/// second, unreviewed call site INSIDE accounts.rs, and (b) a same-named twin
/// declared in another module, which would make a future reader of a grep
/// believe there is one arm helper when there are two.
///
/// SURFACE: `m22_scanned_sources()` — the crate root plus every `mod` lib.rs
/// declares, with `_tests.rs` siblings excluded by construction (test code is
/// not compiled into the published wasm, so it cannot arm a live reaper).
/// `data_lifecycle_manifest_totality_bidirectional` pins that list against the
/// crate live `mod` declarations in BOTH directions; the coverage clause here is
/// the local backstop against a census that merely shrank.
#[test]
fn rb24_arm_called_exactly_once_in_crate() {
    let sources = m22_scanned_sources();
    let paths: Vec<&str> = sources.iter().map(|(p, _)| *p).collect();
    let n_paths = paths.len();
    assert!(
        n_paths >= 20,
        "[rb24/arm-census-coverage] the crate-wide census lists only {n_paths} source(s) \
         ({paths:?}); the live tree lists 22. A shrunken census is a census that stopped \
         looking, and the module a bypass lands in is exactly the one it would be dropped \
         from."
    );
    assert!(
        paths.contains(&"accounts.rs"),
        "[rb24/arm-census-owner] the census does not include accounts.rs ({paths:?}), which is \
         the ONE file with a non-zero budget. Without it the loop below proves only that a set \
         of modules that were never allowed to name the helper do not name it, and the \
         sanctioned call site is unmeasured."
    );

    let mut total = 0usize;
    let mut decls = 0usize;
    for (path, src) in &sources {
        let squashed = stripped_for_scan(src);
        let n = rb24_net_arm_mentions(&squashed);
        decls += m22_count_occurrences(&squashed, &rb24_nd_arm_decl());
        let expected = if *path == "accounts.rs" { 2 } else { 0 };
        assert_eq!(
            n, expected,
            "[rb24/arm-census-site] {path} names the arm helper {n} time(s); exactly {expected} \
             is allowed. For accounts.rs that budget is the declaration plus the ONE sanctioned \
             call site inside delete_account. For every other module it is zero: an arm outside \
             the deletion request ceremony schedules an irreversible cascade for whatever \
             identity IT derives, outside everything this slice reviewed."
        );
        total += n;
    }
    assert_eq!(
        total, 2,
        "[rb24/arm-census-total] the crate must name the arm helper exactly twice in total \
         (one declaration, one call site); found {total}."
    );
    assert_eq!(
        decls, 1,
        "[rb24/arm-decl-unique] the crate must DECLARE the arm helper exactly once; found \
         {decls}. A same-named twin in a second module makes a grep for the arm site answer \
         with a helper nothing in this slice constrains."
    );

    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let (start, end) = rb24_fn_body_span(&squashed, &rb24_nd_delete_account_decl());
    assert_eq!(
        rb24_net_arm_mentions(&squashed[start..end]),
        1,
        "[rb24/arm-call-in-delete] the single arm call site must sit inside delete_account body \
         span. A call relocated into a shared helper — rekey_all, or the reject path — keeps \
         the crate-wide count at two while moving the schedule insert out of the reducer whose \
         reviewers own it."
    );
}

/// PRV1-3 (call-site uniqueness, crate-wide): the disarm helper is DECLARED
/// once and CALLED once anywhere in the compiled crate, and that one call site
/// is inside `cancel_account_deletion`.
///
/// The MIRROR of `rb24_arm_called_exactly_once_in_crate`, and it is not
/// redundant with the arm census: rb-24 artifact red-team (Finding 2) MEASURED
/// that `rb24_net_arm_mentions` (arm-minus-disarm arithmetic) nets to ZERO for
/// an extra disarm call, because the disarm token CONTAINS the arm token — so a
/// second, unreviewed `disarm_deletion_reaper(ctx, foreign)` in any other
/// function (the PoC used complete_guest_claim, where the argument is a guest
/// identity) leaves the arm census reading net == 2 and is invisible. The
/// disarm deletes EVERY schedule row for the identity it is passed, so an
/// unreviewed call is an unauthorized deletion-cancel primitive for a foreign
/// account. This census counts the disarm CALL token DIRECTLY (nothing longer
/// contains it but its own `fn` declaration, which is the decl budget), never
/// via subtraction.
#[test]
fn rb24_disarm_called_exactly_once_in_crate() {
    let sources = m22_scanned_sources();
    let paths: Vec<&str> = sources.iter().map(|(p, _)| *p).collect();
    let n_paths = paths.len();
    assert!(
        n_paths >= 20,
        "[rb24/disarm-census-coverage] the crate-wide census lists only {n_paths} source(s) \
         ({paths:?}); the live tree lists 22. A shrunken census is a census that stopped \
         looking, and the module a bypass lands in is exactly the one it would be dropped from."
    );
    assert!(
        paths.contains(&"accounts.rs"),
        "[rb24/disarm-census-owner] the census does not include accounts.rs ({paths:?}), which \
         is the ONE file with a non-zero budget."
    );

    let disarm_call = rb24_nd_disarm_call();
    let mut total = 0usize;
    let mut decls = 0usize;
    for (path, src) in &sources {
        let squashed = stripped_for_scan(src);
        // The decl `fndisarm_deletion_reaper(` also contains the call token, so
        // a direct count of the call token over the whole file = decl + calls.
        let n = m22_count_occurrences(&squashed, &disarm_call);
        decls += m22_count_occurrences(&squashed, &rb24_nd_disarm_decl());
        let expected = if *path == "accounts.rs" { 2 } else { 0 };
        assert_eq!(
            n, expected,
            "[rb24/disarm-census-site] {path} names the disarm helper {n} time(s); exactly \
             {expected} is allowed. For accounts.rs that budget is the declaration plus the ONE \
             sanctioned call site inside cancel_account_deletion. For every other module it is \
             zero: a disarm outside the cancel ceremony deletes every pending-deletion schedule \
             row for whatever identity IT derives — an unauthorized cancel for a foreign account, \
             outside everything this slice reviewed."
        );
        total += n;
    }
    assert_eq!(
        total, 2,
        "[rb24/disarm-census-total] the crate must name the disarm helper exactly twice in \
         total (one declaration, one call site); found {total}."
    );
    assert_eq!(
        decls, 1,
        "[rb24/disarm-decl-unique] the crate must DECLARE the disarm helper exactly once; found \
         {decls}."
    );

    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let (start, end) = rb24_fn_body_span(&squashed, &rb24_nd_cancel_decl());
    assert_eq!(
        m22_count_occurrences(&squashed[start..end], &disarm_call),
        1,
        "[rb24/disarm-call-in-cancel] the single disarm call site must sit inside \
         cancel_account_deletion's body span. A call relocated elsewhere keeps the crate-wide \
         count at two while moving the disarm out of the reducer whose reviewers own it."
    );
}

// ---------------------------------------------------------------------------
// rb-24 / PRV1-3 — THE DISARM, WIRED INTO `cancel_account_deletion`.
// ---------------------------------------------------------------------------

/// PRV1-3 (spec §4.5): `cancel_account_deletion` disarms the pending deletion
/// reaper, after the idempotency gate and after the status write.
///
/// Spec §4.5 names this the ADR-0126 D4 clause and warns that it is routinely
/// conflated with D6 (the no-self-disarm rule for a FIRED one-shot). They are
/// different: D6 says a reaper must not delete its own fired row; D4 says every
/// OTHER mutation site must actively delete a schedule row that would otherwise
/// fire stale. Without the disarm, a cancelled account is `Active` with an armed
/// reaper still pointing at it, and this slice ships no reaper-side status
/// recheck — so the cascade would run on a live, cancelled account.
///
/// THE ORDERING IS BEHAVIOURAL, NOT COSMETIC. Placed after the
/// `needs_cancel_write` gate, the disarm is skipped on the idempotent no-op path
/// (an already-Active account has nothing armed), so a second cancel does not
/// sweep a row that a racing third-party request just armed. Placed after the
/// status write, a rollback of the write also rolls back the disarm.
///
/// ONE OF THE TWO NEGATIVE CLAUSES IS ARITHMETIC, NOT A SUBSTRING TEST, and the
/// reason is measured: the disarm call token CONTAINS the arm call token (it is
/// the same name under a three-letter prefix), so a literal `the arm token does
/// not appear in this body` assertion is unsatisfiable against the CORRECT
/// implementation. See `rb24_net_arm_mentions`. The mirror-image clause — no
/// disarm inside the request path — needs no such care, because the containment
/// runs only one way.
///
/// Kills: dropping the disarm; a second unreviewed disarm; the disarm sequenced
///        before the gate (sweeping a freshly armed row on an idempotent
///        re-cancel) or before the status write; an early `return` between them;
///        a conditional or closure-wrapped disarm; a `me` rebind that disarms
///        somebody else schedule; the two polarities crossing — an arm inside
///        cancel, or a disarm inside delete_account.
#[test]
fn rb24_cancel_disarms_the_reaper() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &rb24_nd_cancel_decl())
        .expect("[rb24/disarm-scope] fn cancel_account_deletion was not found in accounts.rs");

    let statement = format!(";{}ctx,me);", rb24_nd_disarm_call());
    assert_eq!(
        m22_count_occurrences(body, &statement),
        1,
        "[rb24/disarm-statement] cancel_account_deletion must contain the bare statement \
         `{statement}` exactly once. The semicolons pin STATEMENT POSITION: a call that is an \
         operand of a closure binding or an iterator adaptor sits at brace depth 0, satisfies \
         every containment and ordering clause here, and never runs — so the cancelled account \
         keeps its armed reaper."
    );
    assert_eq!(
        m22_count_occurrences(body, &rb24_nd_disarm_call()),
        1,
        "[rb24/disarm-count] cancel_account_deletion must name the disarm helper exactly once."
    );

    let gate = concat!("needs_cancel", "_write(");
    let update = concat!(".upd", "ate(cancelled_deletion(account))");
    assert_eq!(
        m22_count_occurrences(body, update),
        1,
        "[rb24/disarm-update-shape] cancel_account_deletion must reverse the status exactly \
         once, through the pure `cancelled_deletion` constructor (which is where the AUTH-29 \
         claim-provenance preservation lives), never through a hand-built row literal."
    );

    let at_gate = idx(body, gate);
    let at_update = idx(body, update);
    let at_stmt = idx(body, &statement);
    assert!(
        at_gate < at_stmt,
        "[rb24/disarm-after-gate] the disarm (offset {at_stmt}) must run AFTER the \
         needs_cancel_write idempotency gate (offset {at_gate}). Ahead of the gate it also runs \
         on the already-Active no-op path, where there is nothing legitimately armed — so a \
         repeat cancel becomes an unconditional schedule sweep for that identity."
    );
    assert!(
        at_update < at_stmt,
        "[rb24/disarm-after-update] the disarm (offset {at_stmt}) must run AFTER the status \
         write (offset {at_update}), mirroring the arm-last rule on the request side: the write \
         is the step that can fail, and the disarm must not outlive a rolled-back reversal."
    );

    let region = &body[at_update..at_stmt];
    assert!(
        !rb24_has_return_token(region),
        "[rb24/disarm-reachable] a `return` token sits between the status write and the disarm. \
         Every other clause here reasons about POSITION and none about REACHABILITY, so an \
         early exit leaves an Active account with a live reaper still aimed at it — and this \
         slice ships no reaper-side status recheck to stop the cascade. Region text: {region:?}"
    );
    assert_eq!(
        rb24_brace_depth(&body[..at_stmt]),
        0,
        "[rb24/disarm-depth0] the disarm sits inside a nested block rather than at the top \
         level of cancel_account_deletion. A conditional disarm is a conditional cancel: a \
         guard that is always false here keeps every other clause green while the reaper stays \
         armed."
    );

    assert_eq!(
        m22_count_occurrences(body, "letme="),
        1,
        "[rb24/disarm-no-rebind] cancel_account_deletion must bind `me` exactly once. A rebind \
         disarms a different identity schedule row: the caller stays armed and somebody else \
         pending deletion is silently cancelled, while every textual clause above stays green."
    );
    assert_eq!(
        m22_count_occurrences(body, "letme=ctx.sender();"),
        1,
        "[rb24/disarm-me-source] the single `me` binding must be `ctx.sender()`."
    );

    assert_eq!(
        rb24_net_arm_mentions(body),
        0,
        "[rb24/cancel-never-arms] cancel_account_deletion names the ARM helper. The two \
         polarities must never cross: arming inside the cancel path re-schedules the cascade \
         the player just cancelled. Counted as arm-minus-disarm arithmetic on purpose — the \
         disarm token literally contains the arm token, so a substring ban would be \
         unsatisfiable against the correct implementation."
    );

    let delete_body = extract_squashed_fn_body(&squashed, &rb24_nd_delete_account_decl())
        .expect("[rb24/disarm-scope-delete] fn delete_account was not found in accounts.rs");
    assert_eq!(
        m22_count_occurrences(delete_body, &rb24_nd_disarm_call()),
        0,
        "[rb24/delete-never-disarms] delete_account names the DISARM helper. A disarm on the \
         request path deletes the row the same reducer just armed — a deletion request that \
         reports success and schedules nothing."
    );
}

/// PRV1-3 (helper body): `disarm_deletion_reaper` collects the matching schedule
/// ids through the `account_identity` btree index and then deletes each by
/// primary key, and does nothing else.
///
/// EXACT EQUALITY, and the two-phase COLLECT-THEN-DELETE shape is the point:
/// deleting inside the filter iteration mutates the table being iterated. The
/// shipped `disarm_claim_reaper` is the precedent this mirrors byte for byte.
///
/// Kills: filtering on the wrong column (a filter on `scheduled_id` type-checks
///        against a u64 and disarms nothing);
///        deleting by the wrong key (a delete keyed on the filtered column
///        rather than the primary key);
///        a single-row `.find(..)` in place of the filter, which leaves every
///        second armed row behind if two ever coexist;
///        an unfiltered full-table sweep, which disarms every OTHER pending
///        account deletion in the database — the catastrophic direction, and one
///        that no containment pin distinguishes from the correct body;
///        a dead branch, an extra binding, a shadowed `ids`, a shadowed loop
///        `id`, or an appended foreign write.
#[test]
fn rb24_disarm_deletion_reaper_body_frozen() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let sig = extract_squashed_fn_sig(&squashed, &rb24_nd_disarm_decl()).unwrap_or_else(|| {
        panic!(
            "[rb24/disarm-sig-read] fn disarm_deletion_reaper was not found in accounts.rs, or \
             its signature reaches no opening brace. The frozen-body pin below would then have \
             nothing to compare and must not report a pass."
        )
    });
    assert_eq!(
        sig,
        rb24_frozen_disarm_sig(),
        "[rb24/disarm-sig] the disarm helper signature is not the frozen one. It must take the \
         reducer context as `ctx` and an OWNER-GENERIC `account: Identity`, so a later arm of \
         S3 — or the cascade itself — can reuse it verbatim rather than growing a second, \
         subtly different sweep."
    );

    let body = extract_squashed_fn_body(&squashed, &rb24_nd_disarm_decl())
        .expect("[rb24/disarm-body-read] the disarm helper body is not brace-balanced");
    assert_eq!(
        body,
        rb24_frozen_disarm_body(),
        "[rb24/disarm-body] disarm_deletion_reaper must be exactly the two-phase \
         collect-then-delete sequence: filter the account_identity btree index, collect the \
         primary keys, then delete each by primary key. Deleting inside the filter iteration \
         mutates the table being iterated; an unfiltered sweep disarms every other pending \
         deletion in the database; and a filter on the wrong column disarms nothing at all — \
         all three read identically to every containment pin."
    );
}

// ---------------------------------------------------------------------------
// rb-24 / E1 + S3-boundary — THE SCHEDULED REDUCER.
// ---------------------------------------------------------------------------

/// E1 (spec §4.4): the deletion reaper rejecting scheduler-only guard is its
/// FIRST statement.
///
/// The needle is pinned as the shared guard IMMEDIATELY FOLLOWED BY `Err(`, not
/// as the bare guard, and that is a red-team finding rather than
/// belt-and-braces. `scheduler_guard_needle()` deliberately stops at the
/// `return` token so a future refactor to the equally valid silent-ignore
/// `return Ok(());` form does not false-RED elsewhere — which makes the bare
/// needle a FORGEABLE PREFIX here. Because `squash_ws` fuses the token with
/// whatever follows it, a body whose guard branch opens with a call to a helper
/// whose NAME merely starts with the six letters of that token (`returned_...`,
/// say) contains the whole needle, compiles, is clippy-clean, and rejects
/// nobody. Requiring the body to START WITH guard-then-`Err(` closes it.
///
/// Why first: this reducer takes the scheduled struct as an argument, and the
/// ONLY thing that makes a struct-typed reducer argument safe (the ADR-0195 D6
/// carve-out that `g2_no_reducer_takes_identity_parameter` depends on) is that
/// the body rejects every non-scheduler caller before reading a field of it.
/// Without the guard, any client can invoke this reducer directly with a
/// hand-built row naming any victim identity.
///
/// Kills: the neutered `let scheduler_only = ...; let _ = scheduler_only;` form,
///        which keeps the comparison and rejects nobody;
///        a guard that compares `ctx.sender()` against anything other than
///        `ctx.database_identity()`;
///        a guard demoted to a non-rejecting statement;
///        a guard moved below any other statement.
#[test]
fn rb24_deletion_reaper_scheduler_guard_is_first_statement() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &rb24_nd_reaper_decl())
        .expect("[rb24/reaper-scope] fn account_deletion_reaper was not found in accounts.rs");
    assert!(
        !body.is_empty(),
        "[rb24/reaper-nonempty] the deletion reaper body is empty, so the guard clause below \
         would be asserting a prefix of nothing."
    );

    let sig = extract_squashed_fn_sig(&squashed, &rb24_nd_reaper_decl())
        .expect("[rb24/reaper-sig-read] the deletion reaper signature reaches no opening brace");
    assert!(
        sig.contains(concat!("AccountDeletion", "ReaperSchedule")),
        "[rb24/reaper-arg-type] the deletion reaper must take the SAME-FILE scheduled struct as \
         its argument type. That equality is the entire precondition of the ADR-0195 D6 \
         carve-out that lets a reducer take a composite argument at all; any other composite \
         type is a client-supplied payload. Signature read: {sig:?}"
    );

    let guard = scheduler_guard_needle();
    let rejecting = format!("{guard}Err(");
    assert!(
        body.starts_with(rejecting.as_str()),
        "[rb24/reaper-guard-first] the deletion reaper body must START with the rejecting \
         scheduler guard, and the rejection must be the guard IMMEDIATELY following token. The \
         shared guard needle deliberately stops at `return` so a silent-ignore refactor does \
         not false-RED elsewhere, which makes it a forgeable PREFIX here: a body opening with \
         the same condition and a helper call that returns nothing contains it, compiles, and \
         rejects nobody — leaving any client free to invoke this reducer with a hand-built row \
         naming any victim. Body read: {body:?}"
    );
    assert_eq!(
        m22_count_occurrences(body, &guard),
        1,
        "[rb24/reaper-guard-unique] the deletion reaper must carry exactly one scheduler guard. \
         A second one is either dead code or a decoy that steers a first-hit anchored scan."
    );
}

/// S3-boundary: the deletion reaper body is EXACTLY the scheduler guard and a
/// trailing `Ok(())` — this slice ships no cascade.
///
/// THIS TEST IS DESIGNED TO GO RED WHEN THE CASCADE LANDS, AND THAT IS THE
/// POINT. Spec §4.4 defines a five-step cascade whose ordering is load-bearing
/// (force-resolve live interactions BEFORE any erase, `character` before the
/// `player` tombstone, the terminal marker only after steps 1 to 4 succeed) and
/// §4.5 adds a reaper-side recheck on status, terminal marker and due-ness.
/// NONE of that is in this slice. An empty body plus a containment pin would let
/// the cascade grow one unreviewed statement at a time; equality forces the arm
/// that ships it to come back to this literal, re-derive it from the spec step
/// list, and re-review the guard position at the same time.
///
/// The scan blanks string literals, so the reject reason reads as an empty
/// argument — the reason TEXT is covered by `reject_message_contracts_present`,
/// not here, and that split is deliberate: a message contract and a control-flow
/// contract should not fail as one another.
///
/// Kills: a cascade smuggled in ahead of the review that owns it; a `todo!()` or
///        `unimplemented!()` body (a panic inside a scheduled reducer aborts the
///        transaction on every fire); a body that silently returns Ok for the
///        scheduler and does nothing else forever without anyone noticing the
///        slice boundary was never closed.
#[test]
fn rb24_deletion_reaper_body_is_frozen_noop() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &rb24_nd_reaper_decl())
        .expect("[rb24/reaper-body-scope] fn account_deletion_reaper was not found");
    assert_eq!(
        body,
        rb24_frozen_reaper_body(),
        "[rb24/reaper-body] the deletion reaper body is not this slice frozen no-op (rejecting \
         scheduler guard, then Ok(())). If the M22 §4.4 cascade is being added, this pin is \
         SUPPOSED to fire: re-derive the expected body from the spec five-step order, re-review \
         the guard position, and update this literal consciously in the same change. Do not \
         relax it to a containment check — that is exactly how an unreviewed step lands."
    );
}

// ---------------------------------------------------------------------------
// rb-24 / D0 — WRITE ISOLATION FOR THE NEW TABLE.
// ---------------------------------------------------------------------------

/// PRV1-1 / PRV1-3 (D0 write isolation): the owned-write allowlist covers the
/// new schedule table, and the widening is EXERCISED rather than decorative.
///
/// Widening an allowlist is the one edit that can only ever LOOSEN a gate, so it
/// needs its own proof that the new entry corresponds to a real write. Without
/// the second clause, adding the accessor name to `allowed_write_tables` and
/// never writing the table at all is green — and so is deleting the arm and the
/// disarm entirely.
///
/// The third clause is the direction `g5_writes_only_owned_tables` already
/// covers, restated here so a failure of THIS test says which side moved.
///
/// Kills: a widened allowlist with no corresponding write (the decorative
///        widening); a write chained off an accessor that is not in the
///        allowlist at all.
#[test]
fn rb24_owned_write_set_covers_the_deletion_schedule() {
    let accessor = rb24_nd_sched_accessor();
    let allowed = allowed_write_tables();
    assert!(
        allowed.contains(&accessor),
        "[rb24/owned-set] the owned-write allowlist does not contain `{accessor}` \
         ({allowed:?}). The deletion reaper schedule is colocated in this module under the \
         ADR-0056 exception exactly as the guest-claim schedule is, so accounts.rs writes it \
         directly; without the entry, g5_writes_only_owned_tables reds on the sanctioned arm."
    );

    let targets = write_target_accessors(&stripped_for_scan(ACCOUNTS_RS));
    assert!(
        targets.contains(&accessor),
        "[rb24/owned-set-nonvacuous] the allowlist names `{accessor}` but accounts.rs performs \
         NO write against that accessor (extracted write targets: {targets:?}). Widening an \
         allowlist can only loosen a gate, so the widening must be paid for by a real write: \
         zero writes here means the arm and the disarm are both gone and the allowlist entry is \
         a permanently open slot."
    );

    for t in &targets {
        assert!(
            allowed.iter().any(|a| a == t),
            "[rb24/owned-set-closed] accounts.rs writes the table `{t}`, which is not in the \
             owned set {allowed:?}. Every write to a pre-existing table must be delegated to \
             that table owning module."
        );
    }
}

/// PRV1-1 / PRV1-3 (sole writers): every reach for the new schedule table in
/// `accounts.rs` lies inside the arm helper or the disarm helper — nowhere else.
///
/// This is the census that makes the two frozen-body pins TOTAL. Those pins
/// prove what the two helpers do; without this one they say nothing about a
/// third site. A schedule insert added directly to a reducer body — or a delete
/// added to the reaper, which would be the ADR-0126 D6 self-disarm violation
/// that races the runtime own delete of the fired row — is invisible to both.
///
/// The span check is computed from a local brace walk rather than reusing
/// `write_target_accessors`, whose nearest-preceding-`ctx.db.` attribution has
/// measured alias holes: an anchorless write is dropped entirely and an aliased
/// one is credited to the previous accessor. A census built on it would
/// under-report exactly the sites it exists to find.
///
/// Kills: a schedule write inlined into delete_account, cancel_account_deletion,
///        complete_guest_claim or the reaper itself; a third helper that writes
///        the table; the reaper self-disarm (a fourth occurrence, and one
///        outside both spans).
#[test]
fn rb24_schedule_table_sole_writers() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    // Prefix-AGNOSTIC method token (rb-24 artifact red-team, Finding 1): a
    // `let d = &ctx.db; d.account_deletion_reaper_schedule()...` write reaches
    // this table WITHOUT the `ctx.db.` prefix and is invisible to a prefixed
    // needle, so the census counts the leading-dot accessor method through ANY
    // receiver. That aliased write armed a FOREIGN identity and passed every
    // other gate — this is the tooth that makes the frozen-body pins TOTAL.
    let accessor_call = rb24_nd_accessor_method();

    let total = m22_count_occurrences(&squashed, &accessor_call);
    assert_eq!(
        total, 3,
        "[rb24/sole-writer-census] accounts.rs must reach the deletion schedule accessor \
         EXACTLY three times: once for the arm insert, and twice for the disarm (the \
         account_identity filter and the primary-key delete). Found {total}. FEWER means a \
         helper lost its write; MORE means a site exists that neither frozen-body pin \
         constrains — including one reached through an aliased db handle."
    );

    let (arm_start, arm_end) = rb24_fn_body_span(&squashed, &rb24_nd_arm_decl());
    let (dis_start, dis_end) = rb24_fn_body_span(&squashed, &rb24_nd_disarm_decl());
    assert_eq!(
        m22_count_occurrences(&squashed[arm_start..arm_end], &accessor_call),
        1,
        "[rb24/sole-writer-arm] the arm helper must reach the schedule accessor exactly once. \
         The total-of-three clause alone does not pin the SPLIT: three occurrences all inside \
         the disarm satisfies it."
    );
    assert_eq!(
        m22_count_occurrences(&squashed[dis_start..dis_end], &accessor_call),
        2,
        "[rb24/sole-writer-disarm] the disarm helper must reach the schedule accessor exactly \
         twice — once to filter the index, once to delete by primary key. One occurrence means \
         the two-phase shape collapsed into a delete inside the iteration."
    );

    let mut scan = 0usize;
    let mut seen = 0usize;
    while let Some(rel) = squashed[scan..].find(accessor_call.as_str()) {
        let at = scan + rel;
        let inside_arm = at >= arm_start && at < arm_end;
        let inside_disarm = at >= dis_start && at < dis_end;
        assert!(
            inside_arm || inside_disarm,
            "[rb24/sole-writer-scope] accounts.rs reaches the deletion schedule accessor at \
             squashed offset {at}, which lies OUTSIDE both the arm helper body \
             ({arm_start}..{arm_end}) and the disarm helper body ({dis_start}..{dis_end}). \
             Every touch of this table must go through one of the two reviewed helpers: an \
             inline insert in a reducer bypasses the frozen fire-instant derivation, and an \
             inline delete in the reaper is the ADR-0126 D6 self-disarm that races the runtime \
             own delete of the fired one-shot row."
        );
        seen += 1;
        scan = at + accessor_call.len();
    }
    assert_eq!(
        seen, 3,
        "[rb24/sole-writer-walk] the position walk visited {seen} occurrence(s) where the \
         census counted 3. The two counts must agree or the scope clause above ran over a \
         different set of sites than the census measured."
    );
}
