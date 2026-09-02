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
/// `provision_or_touch_account` calls `touch_login` on every existing row that
/// does NOT carry the M22 terminal marker — m22-s3b's PRV1-8(b) reset arm
/// (ADR-0228 D4) intercepts the marked ones ahead of this branch and rebuilds
/// them from `new_account_row`, and `m22s3b_touch_login_scope_excludes_terminal`
/// is what pins that narrowing — including a `PendingDeletion` account that has
/// already claimed a guest — but
/// `auth5_touch_login_updates_only_last_login` only exercises the
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

    // m22-s3b (ADR-0228 D6): AUTH-13's Guard 3 SPLITS into a terminal half and a
    // mid-grace half so a completed erasure gets the DISTINCT
    // REJECT_ALREADY_DELETED reason. BOTH halves are caller-state checks and both
    // belong in this partition — adding the terminal needle here is what keeps
    // the split from quietly landing on the code-resolution side of the boundary,
    // where it would become a claim-code oracle for an already-erased account.
    // The mid-grace needle STAYS: the split must not replace one guard with the
    // other.
    let caller_state = [
        ("has_jwt(", "AUTH-12 JWT pre-filter"),
        (
            concat!("account()", ".identity().find("),
            "AUTH-12 account-holder",
        ),
        (
            concat!("account_has_terminal", "_marker(&account)"),
            "AUTH-13a already-deleted (m22-s3b, ADR-0228 D6)",
        ),
        (
            concat!("is_pending", "_deletion("),
            "AUTH-13b pending-deletion",
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
/// SCOPE — THIS IS A PARTIAL TOOTH, AND WHAT COMPLETES IT IS NAMED. What follows
/// is pinned here: the PURE PREDICATE rejects the shape. That a reducer path
/// refuses to PRODUCE the shape is pinned ELSEWHERE, and as of m22-s3 it IS
/// pinned: `m22s3_terminal_guards_precede_state_writes` proves
/// `cancel_account_deletion` carries the PRV1-4 terminal guard ahead of both the
/// AUTH-38 gate and the `cancelled_deletion` write (and `delete_account` the
/// matching Ok-shaped guard ahead of AUTH-28), and
/// `m22s3_cancelled_deletion_rejects_terminal_input` proves the constructor
/// itself refuses a terminal input. ADR-0225 records the decision.
///
/// THE ONE HALF STILL OPEN, stated plainly: the constructor-level refusal is a
/// `debug_assert!`, which the shipped wasm compiles out (the workspace
/// `Cargo.toml` `[profile.release]` section sets `overflow-checks` and nothing
/// else — the profile fact the ACCOUNT LEGAL-STATE INVARIANT banner in this file
/// already records). In a release build the reducer guard is therefore the ONLY
/// thing standing between a late cancel and this illegal state. Whether that
/// refusal should be promoted to an `Err` in every profile is re-pointed to S3b
/// in ADR-0225; it is not urgent, because nothing in the tree writes `Some` to
/// `terminal_at_ms` until the S3b cascade lands.
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
/// Does NOT kill: `cancel_account_deletion` reactivating a terminal account —
///        but that is now covered, by `m22s3_terminal_guards_precede_state_writes`
///        (the guard is present, first, at depth zero, and ahead of both the
///        AUTH-38 gate and the write) and by
///        `m22s3_cancelled_deletion_rejects_terminal_input` (the constructor
///        refuses the input). What remains uncovered anywhere is the RELEASE
///        profile, where the constructor `debug_assert!` is compiled out and the
///        reducer guard stands alone — re-pointed to S3b in ADR-0225.
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
/// EXACTLY TWO places — the claim-time purge and the cascade step.
///
/// RE-DERIVED 1 -> 2 BY m22-s3b, AND PAID FOR (ADR-0228 D7(b)). `export_bundle`
/// is an ERASE-policy table (spec §3), and ADR-0228 D1 reuses the shipped
/// `privacy::purge_export_bundles` for its cascade step rather than minting a
/// second helper — so the deletion reaper is now a second, sanctioned caller
/// beside `complete_guest_claim`'s rb-22 claim-time purge.
///
/// The compensation for the widening is `m22s3b_purge_named_twice_claim_and_cascade`
/// below, which pins WHICH two bodies the two calls live in and asserts ZERO
/// elsewhere in the file as arithmetic. Without it, a bare bump to 2 would let a
/// second purge land anywhere — in `rekey_all`, say, where it is invisible to
/// both ceremonies' reviewers — and still read as correct.
#[test]
fn rb22_purge_called_exactly_once_in_accounts_rs() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let call = rb22_nd_purge_call();
    let n = m22_count_occurrences(&squashed, &call);
    assert_eq!(
        n, 2,
        "rb-22 [call/whole-file]: accounts.rs must name `{call}` EXACTLY twice; found {n}. \
         The two sanctioned sites are the rb-22 claim-time purge inside complete_guest_claim \
         and the m22-s3b cascade step inside account_deletion_reaper. ZERO or ONE means one \
         of them was deleted or moved into another module's helper (where neither ceremony's \
         reviewers see it); THREE or more means a purge site exists that no scoped test in \
         this file constrains."
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
            2,
            "the TWO sanctioned call sites: the rb-22 qualified call inside \
             complete_guest_claim that the call-site test pins statement by statement, \
             and the m22-s3b cascade step inside account_deletion_reaper (ADR-0228 D1 \
             reuses the shipped helper for the export_bundle ERASE rather than minting a \
             second one). The compensating pin \
             m22s3b_purge_named_twice_claim_and_cascade fixes BOTH occurrences to those \
             exact two bodies and asserts zero elsewhere as arithmetic, so this widening \
             from 1 is net-neutral. The module-header mention is a COMMENT and is blanked \
             from this view, so 2 means exactly two CODE namings. THREE means a further \
             call — and one written UNQUALIFIED under a local import is INVISIBLE to the \
             crate-path-prefixed needle the whole-file test uses. ONE means the cascade \
             step was deleted; ZERO means the claim-time delegation went with it",
        ),
        "privacy.rs" => (
            2,
            "the helper's own declaration plus the ONE sanctioned m22-s4 call site inside \
             request_data_export (purge-before-write, ADR-0226). The compensating pin \
             m22s4_purge_named_twice_declaration_and_call in privacy_tests.rs pins BOTH \
             occurrences to exactly those two shapes, so this widening from 1 is \
             net-neutral. THREE means a wrapper or re-export that hands a different \
             owner to a body the frozen-body pin still reports as correct. ONE means \
             the export reducer's purge-before-write was deleted; ZERO means the \
             declaration was renamed or deleted",
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

/// THE FROZEN REAPER BODY for m22-s3b (ADR-0228 D2/D3): the rejecting scheduler
/// guard, the row lookup keyed on the SCHEDULER-supplied identity, ONE clock
/// read, the PRV1-5 recheck WITH its not-yet-due re-arm branch, the spec para
/// 4.4 cascade in manifest order, and the PRV1-6e terminal stamp LAST. Note that
/// `stripped_for_scan` blanks string literals, so the reject reason reads as an
/// empty argument here.
///
/// AUTHORED FROM THE PLAN, never by printing what an implementation produced.
/// The order IS the spec para-4.4 step list: 6a `resolve_all_live_interactions`,
/// 6b the eight delegated erases plus the export purge, then 6d
/// `erase_character_rows` BEFORE 6c `anonymize_display_names`, then
/// `battle::anonymize_battles`, then 6e the terminal stamp as the LAST write.
///
/// EVERY FRAGMENT IS TRANSCRIBED INDEPENDENTLY, at different split points from
/// `m22s3_nd_reaper_recheck_guard()` and from every `m22s3b_nd_*` call needle,
/// and that is a correction of a MEASURED hole rather than style. Building this
/// literal FROM the needle helpers made the two artefacts one artefact: deleting
/// the negation inside the helper moved the needle and the expected literal
/// together, so the consumer test stayed green on an inverted recheck — a
/// two-token cheat. Two independent spellings of the same plan statement cannot
/// be edited in one place, and the consumer test asserts they still agree.
///
/// THE SUBJECT IS SPELLED OUT AT EVERY DELEGATED CALL (ADR-0228, RT-3): each of
/// the thirteen calls passes `(ctx, args.account_identity)` directly, never a
/// local binding, so a single re-pointed `let` cannot silently retarget the
/// whole cascade at another identity while every call site still reads right.
fn rb24_frozen_reaper_body() -> String {
    [
        scheduler_guard_needle(),
        concat!("Err(.to", "_string());}").to_string(),
        concat!(
            "letSome(account)=ctx.db.acc",
            "ount().identity().find(args.account",
            "_identity)else{returnOk(());};"
        )
        .to_string(),
        concat!("letn", "ow=now", "_ms(ctx);").to_string(),
        concat!(
            "if!re",
            "aper_should_run_cas",
            "cade(&account,now){iflet",
            "Some(requested)=reaper_re",
            "arm_at_ms(&account,now){arm_dele",
            "tion_reaper(ctx,args.acc",
            "ount_identity,requested);}return",
            "Ok(());}"
        )
        .to_string(),
        concat!(
            "crate::resolve_all_live",
            "_interactions(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::monster_mgmt::era",
            "se_monsters(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::inventory::era",
            "se_inventory(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::npc::era",
            "se_npc_state(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::raising::era",
            "se_heal_cooldown(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::economy::era",
            "se_wallet(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::playtest::era",
            "se_playtest_events(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::trading::era",
            "se_trade_offers(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::pvp::era",
            "se_pvp_rows(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::privacy::purge_expo",
            "rt_bundles(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::era",
            "se_character_rows(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::ranking::anonymize_disp",
            "lay_names(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "crate::battle::anonymize",
            "_battles(ctx,args.acc",
            "ount_identity);"
        )
        .to_string(),
        concat!(
            "ctx.db.acc",
            "ount().identity().upd",
            "ate(terminal_acc",
            "ount(anonymized_acc",
            "ount(account),now));"
        )
        .to_string(),
        "Ok(())".to_string(),
    ]
    .concat()
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
         transitioned: the m22-s3 PRV1-5 recheck no-ops that fire rather than erasing a live \
         account, but the one-shot row is consumed for nothing and the request is lost."
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

/// PRV1-1 / PRV1-5 (call-site census, crate-wide): the arm helper is DECLARED
/// once and CALLED from exactly THREE reviewed sites, all inside `accounts.rs`.
///
/// RE-DERIVED 2 -> 4 BY m22-s3b, AND PAID FOR (ADR-0228 D7(f)). Until this slice
/// there was one arm call, in `delete_account`. m22-s3b adds two more, each of
/// which is a real obligation rather than a convenience:
///   * the reaper's NOT-YET-DUE branch (ADR-0228 D3(a)). The runtime deletes the
///     fired one-shot schedule row whatever the reducer does, so a not-yet-due
///     fire that simply returns drops the reaper and leaves the account
///     `PendingDeletion` with nothing armed — forever.
///   * `ensure_deletion_reapers_armed` (ADR-0221 R2 / ADR-0228 D3(b)), the
///     init/sync sweep for the population whose one-shot already fired under the
///     pre-S3b code.
///
/// A BARE BUMPED NUMBER WOULD DELETE THE TOOTH, so the widening is compensated
/// per SITE: exactly one arm call inside `delete_account`'s span, exactly one
/// inside the reaper's span, exactly one inside the sweep's span, ZERO anywhere
/// else in the file (asserted as arithmetic, not as a hopeful absence), and the
/// ARGUMENT LIST pinned at each of the three. Without the argument pins a call
/// relocated between the three spans still counts 4 while arming the wrong
/// identity, or arming from a fresh clock read instead of the row's own request
/// stamp — which extends the grace window on every fire (ADR-0228 D3: the fire
/// instant is ALWAYS `deletion_fire_at_ms(requested)`, never `now + GRACE`).
///
/// SCOPE, STATED HONESTLY: the helper is module-private, so the compiler already
/// refuses a call from another module. What this census adds on top is (a) a
/// fourth, unreviewed call site INSIDE accounts.rs, and (b) a same-named twin
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
        let expected = if *path == "accounts.rs" { 4 } else { 0 };
        assert_eq!(
            n, expected,
            "[rb24/arm-census-site] {path} names the arm helper {n} time(s); exactly {expected} \
             is allowed. For accounts.rs that budget is the declaration plus the THREE \
             sanctioned call sites — delete_account (PRV1-1), the reaper not-yet-due re-arm \
             (PRV1-5, ADR-0228 D3a) and ensure_deletion_reapers_armed (ADR-0221 R2). For every \
             other module it is zero: an arm outside those three ceremonies schedules an \
             irreversible cascade for whatever identity IT derives, outside everything this \
             slice reviewed."
        );
        total += n;
    }
    assert_eq!(
        total, 4,
        "[rb24/arm-census-total] the crate must name the arm helper exactly four times in \
         total (one declaration plus three reviewed call sites); found {total}."
    );
    assert_eq!(
        decls, 1,
        "[rb24/arm-decl-unique] the crate must DECLARE the arm helper exactly once; found \
         {decls}. A same-named twin in a second module makes a grep for the arm site answer \
         with a helper nothing in this slice constrains."
    );

    // --- per-SITE scoped pins: the compensation for the 2 -> 4 widening ------
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let arm_call = rb24_nd_arm_call();

    let sites: [(&str, String, String, &str); 3] = [
        (
            "delete_account",
            rb24_nd_delete_account_decl(),
            format!("{arm_call}ctx,me,now);"),
            "PRV1-1: the request path arms the reaper for the CALLER, from the SAME `now` \
             binding the status write used. A fresh clock read here silently decouples the \
             instant stamped on the row from the instant the fire time derives from, so the \
             grace window a player actually receives depends on reducer timing.",
        ),
        (
            "account_deletion_reaper",
            rb24_nd_reaper_decl(),
            format!("{arm_call}ctx,args.account_identity,requested);"),
            "PRV1-5 / ADR-0228 D3a: the not-yet-due branch re-arms for the SCHEDULER-supplied \
             identity, at the instant the pure `reaper_rearm_at_ms` seam returned — which is \
             derived from the row's OWN `deletion_requested_at_ms`. `now + GRACE` here would \
             extend the window by a full grace period on every fire, so a player who never \
             cancels is never deleted.",
        ),
        (
            "ensure_deletion_reapers_armed",
            m22s3b_nd_ensure_decl(),
            format!("{arm_call}ctx,identity,requested_at_ms);"),
            "ADR-0221 R2 / ADR-0228 D3b: the init and sync sweep arms each row the pure \
             `plan_deletion_rearms` seam emitted, using the pair that seam produced. Deriving \
             the fire instant here instead would put the R2 population on a different clock \
             from every other arm site.",
        ),
    ];

    let mut scoped_total = 0usize;
    for (what, decl, statement, why) in &sites {
        let (start, end) = rb24_fn_body_span(&squashed, decl);
        let span = &squashed[start..end];
        let n = rb24_net_arm_mentions(span);
        assert_eq!(
            n, 1,
            "[rb24/arm-call-in-{what}] {what} must name the arm helper EXACTLY once; found \
             {n}. ZERO means this ceremony arms nothing — {why} MORE THAN ONE is a second \
             schedule row for the same subject, which fires a second cascade that the PRV1-3 \
             disarm (it deletes every matching row) would mask in testing and double every \
             side effect in production."
        );
        assert_eq!(
            m22_count_occurrences(span, statement),
            1,
            "[rb24/arm-shape-{what}] the arm call inside {what} must be the exact statement \
             `{statement}`. {why} A site census alone says NOTHING about the argument list: a \
             call relocated between the three sanctioned spans, or re-argued at a different \
             identity or a different instant, keeps every count in this test at its expected \
             value."
        );
        scoped_total += n;
    }
    assert_eq!(
        scoped_total, 3,
        "[rb24/arm-scoped-total] the three scoped spans account for {scoped_total} arm \
         call(s); they must account for exactly 3."
    );
    let file_total = rb24_net_arm_mentions(&squashed);
    assert_eq!(
        file_total - decls - scoped_total,
        0,
        "[rb24/arm-zero-elsewhere] accounts.rs names the arm helper {file_total} time(s); the \
         declaration accounts for {decls} and the three reviewed spans for {scoped_total}, \
         leaving {} unaccounted. Those are arm sites OUTSIDE every ceremony this slice \
         reviewed — the shape that matters is one dropped into a reject path or a shared \
         helper, where it schedules an irreversible cascade for whatever identity is in \
         scope. This clause is arithmetic rather than a hopeful absence check precisely so a \
         new site cannot hide behind the per-span counts.",
        file_total - decls - scoped_total
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
/// reaper still pointing at it. Since m22-s3 the reaper rechecks status, so that
/// fire no-ops rather than cascading — which makes the disarm defense in depth
/// and scheduler-slot hygiene rather than the only line, and PRV1-3 still names
/// the delete as required. Two independent refusals is the design, not one.
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
         early exit leaves an Active account with a live reaper still aimed at it. The m22-s3 \
         PRV1-5 recheck no-ops that fire, so this is the second of two independent refusals \
         rather than the last one — PRV1-3 still requires the delete. Region text: {region:?}"
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

// ---------------------------------------------------------------------------
// m22-s3b call needles. AUTHORED FROM THE PLAN (ADR-0228 D1/D2), never derived
// by printing what an implementation produced. Split mid-token, per the file
// header rule, so this file never carries a contiguous cascade call site that a
// whole-tree scanner could count as a real one.
//
// EVERY ONE OF THESE IS A SECOND, INDEPENDENT TRANSCRIPTION of a fragment of
// `rb24_frozen_reaper_body()`, which is split at DIFFERENT points on purpose.
// `rb24_deletion_reaper_body_is_pinned_cascade` asserts the two agree, so a
// silent edit to one artefact cannot move the other with it.
// ---------------------------------------------------------------------------

/// The delegated-call SUBJECT, spelled at every cascade call site (ADR-0228,
/// RT-3): the reducer context plus the identity the SCHEDULER supplied, passed
/// directly rather than through a local binding.
fn m22s3b_nd_subject() -> String {
    concat!("(ctx,args.account", "_identity)").to_string()
}

fn m22s3b_nd_resolver_call() -> String {
    concat!("crate::resolve_all_live", "_interactions(").to_string()
}

fn m22s3b_nd_erase_monsters() -> String {
    concat!("crate::monster_mgmt::erase", "_monsters(").to_string()
}

fn m22s3b_nd_erase_inventory() -> String {
    concat!("crate::inventory::erase", "_inventory(").to_string()
}

fn m22s3b_nd_erase_npc_state() -> String {
    concat!("crate::npc::erase", "_npc_state(").to_string()
}

fn m22s3b_nd_erase_heal_cooldown() -> String {
    concat!("crate::raising::erase", "_heal_cooldown(").to_string()
}

fn m22s3b_nd_erase_wallet() -> String {
    concat!("crate::economy::erase", "_wallet(").to_string()
}

fn m22s3b_nd_erase_playtest_events() -> String {
    concat!("crate::playtest::erase", "_playtest_events(").to_string()
}

fn m22s3b_nd_erase_trade_offers() -> String {
    concat!("crate::trading::erase", "_trade_offers(").to_string()
}

fn m22s3b_nd_erase_pvp_rows() -> String {
    concat!("crate::pvp::erase", "_pvp_rows(").to_string()
}

fn m22s3b_nd_purge_bundles() -> String {
    concat!("crate::privacy::purge_export", "_bundles(").to_string()
}

fn m22s3b_nd_erase_character_rows() -> String {
    concat!("crate::erase_character", "_rows(").to_string()
}

fn m22s3b_nd_anonymize_names() -> String {
    concat!("crate::ranking::anonymize_display", "_names(").to_string()
}

fn m22s3b_nd_anonymize_battles() -> String {
    concat!("crate::battle::anonymize", "_battles(").to_string()
}

/// The one sanctioned row write the reaper performs itself (6e). Every other
/// step is delegated to the owning module (G5 MODULE_WRITE_ISOLATION).
fn m22s3b_nd_account_update() -> String {
    concat!("ctx.db.account().identity().upd", "ate(").to_string()
}

fn m22s3b_nd_terminal_ctor() -> String {
    concat!("terminal_acc", "ount(").to_string()
}

fn m22s3b_nd_anonymized_ctor() -> String {
    concat!("anonymized_acc", "ount(").to_string()
}

/// The pure re-arm seam, as the not-yet-due branch calls it.
fn m22s3b_nd_rearm_seam() -> String {
    concat!("reaper_rearm_at", "_ms(&account,now)").to_string()
}

/// The THIRTEEN delegated cascade calls, in the plan order (ADR-0228 D2).
/// Label first so a failure names the step rather than a needle.
fn m22s3b_delegated_calls() -> Vec<(&'static str, String)> {
    vec![
        (
            "6a resolve_all_live_interactions",
            m22s3b_nd_resolver_call(),
        ),
        ("6b monster + monster_pub", m22s3b_nd_erase_monsters()),
        ("6b inventory", m22s3b_nd_erase_inventory()),
        (
            "6b npc dialogue/quest/conversation",
            m22s3b_nd_erase_npc_state(),
        ),
        ("6b heal_cooldown", m22s3b_nd_erase_heal_cooldown()),
        ("6b wallet", m22s3b_nd_erase_wallet()),
        ("6b playtest_event", m22s3b_nd_erase_playtest_events()),
        (
            "6b trade_offer + its schedule",
            m22s3b_nd_erase_trade_offers(),
        ),
        (
            "6b battle_challenge + battle_action",
            m22s3b_nd_erase_pvp_rows(),
        ),
        ("6b export_bundle", m22s3b_nd_purge_bundles()),
        ("6d character", m22s3b_nd_erase_character_rows()),
        ("6c player + profile names", m22s3b_nd_anonymize_names()),
        ("6c battle + its joins", m22s3b_nd_anonymize_battles()),
    ]
}

/// S3B CASCADE (m22-s3b, PRV1-6a..6e + PRV1-5 re-arm): the deletion reaper body
/// is EXACTLY the rejecting scheduler guard, the scheduler-keyed row lookup, ONE
/// clock read, the recheck WITH its re-arm branch, the thirteen delegated
/// cascade calls in spec para-4.4 order, the terminal stamp, and `Ok(())`.
///
/// WHAT CHANGED, AND WHY THE PIN SURVIVED IT AGAIN. rb-24 froze a bare no-op;
/// m22-s3 replaced that with the PRV1-5 recheck skeleton; m22-s3b replaces that
/// with the cascade. ADR-0221 R1 asked for retirement once the body grew and
/// ADR-0228 D7(a) records the deliberate deviation for the third time: this is
/// the widest and most dangerous body in the module, every statement in it is
/// irreversible, and a containment pin cannot tell a complete cascade from one
/// missing a step. Retiring it is how an unreviewed step lands.
///
/// CLAUSE ORDER IS LOAD-BEARING (red-team B1). Every needle clause runs BEFORE
/// the equality and is AUTHORED FROM THE PLAN, never derived by printing what an
/// implementation produced. Equality alone is forgeable in the one direction
/// that matters: an arm that inverts the recheck, drops a delegated erase, or
/// stamps the terminal marker before the cascade, and then regenerates the
/// equality literal from its own output, is GREEN on equality alone.
///
/// COUNT BEFORE INDEX, EVERYWHERE (RT-18). Every ordering clause asserts the two
/// needles occur EXACTLY ONCE before comparing their offsets: a first-hit index
/// over a decoy second occurrence is a steerable anchor, and this body is long
/// enough for a decoy to hide in.
///
/// The scan blanks string literals, so the reject reason reads as an empty
/// argument — the reason TEXT is covered by `reject_message_contracts_present`,
/// not here, and that split is deliberate: a message contract and a control-flow
/// contract should not fail as one another.
///
/// Kills: an inverted recheck (the polarity needle counts zero); a not-due
///        branch that returns without re-arming, which drops the reaper the
///        runtime has already deleted and strands the account PendingDeletion
///        forever; a re-arm hoisted OUT of the not-due branch, which re-arms an
///        account the cascade is about to erase; a lookup keyed on the sender;
///        a SECOND clock read, which lets the recheck and the re-arm fire time
///        disagree; any delegated call dropped, reordered across the two pinned
///        boundaries, or re-argued at a local binding instead of
///        `args.account_identity`; `erase_character_rows` moved AFTER the player
///        tombstone (the §4.4 character-before-player order); the terminal stamp
///        written anywhere but last, or more than once; ANY direct row write in
///        this body other than that one account update (every other step must be
///        delegated to its owning module, G5).
#[test]
fn rb24_deletion_reaper_body_is_pinned_cascade() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &rb24_nd_reaper_decl())
        .expect("[rb24/reaper-body-scope] fn account_deletion_reaper was not found");
    let frozen = rb24_frozen_reaper_body();

    // --- (0) TWO-TRANSCRIPTION INDEPENDENCE ---------------------------------
    // Every plan needle used below must ALSO be a substring of the frozen
    // literal, which is split at different points. If the two disagree, one of
    // them was edited alone and the pin has silently stopped meaning what its
    // messages claim.
    let polarity = m22s3_nd_reaper_recheck_guard();
    assert!(
        frozen.contains(polarity.as_str()),
        "[rb24/reaper-needle-independence] the recheck needle {polarity:?} and the \
         frozen-body literal are two INDEPENDENT transcriptions of the same plan statement, \
         and they disagree — so one of them was edited alone. They were once built from a \
         single helper, and a two-token edit inside that helper then moved the needle and \
         the expected literal together, leaving an inverted recheck green. This clause is \
         what makes independence checkable instead of merely asserted in a comment."
    );
    for (label, needle) in m22s3b_delegated_calls() {
        assert!(
            frozen.contains(needle.as_str()),
            "[rb24/reaper-needle-independence] the plan needle for step {label} ({needle:?}) \
             is not a substring of the frozen body literal. The two are deliberately split \
             at different points so neither can be edited into agreement with the other by \
             accident; a mismatch means one artefact moved alone and every clause below is \
             now asserting something other than the plan."
        );
    }

    // --- (1) SUBJECT: every delegated call names the scheduler's identity ----
    let subject = m22s3b_nd_subject();
    let n_subject = m22_count_occurrences(body, &subject);
    assert_eq!(
        n_subject, 13,
        "[rb24/reaper-subject-census] the reaper body must pass {subject:?} to EXACTLY 13 \
         delegated calls (the resolver, eight erases, the export purge, the character \
         join-sweep, the display-name anonymize and the battle anonymize); found \
         {n_subject}. Spelling the subject at every call site is what makes a re-pointed \
         `let me = ...` unrepresentable: one local binding above the cascade would retarget \
         thirteen irreversible steps at another account while every call site still reads \
         correctly. FEWER means a step was dropped or re-argued at a binding; MORE means an \
         unreviewed fourteenth delegated call."
    );
    let n_sender = m22_count_occurrences(body, "ctx.sender()");
    assert_eq!(
        n_sender, 1,
        "[rb24/reaper-sender-census] the reaper body must name `ctx.sender()` EXACTLY once \
         — inside the scheduler-only guard; found {n_sender}. This reducer is invoked by \
         the SCHEDULER, so after the guard `ctx.sender()` IS the module identity: a second \
         use anywhere below it derives the cascade subject from the module rather than from \
         the schedule row, which erases nothing and stamps the wrong account terminal."
    );

    // The ROW LOOKUP subject, carried forward from the m22-s3 pin this test
    // re-derives (r2). The 13-count census above proves every DELEGATED call
    // names the scheduler-supplied identity; it says nothing about the lookup
    // that decides WHICH ROW the cascade is about, because that call spells
    // `find(args.account_identity)` with no `ctx,` prefix and therefore matches
    // no delegated-subject needle. Keeping the m22-s3 needle in service — rather
    // than dropping it when the subject clause was rewritten — is what stops the
    // lookup silently re-keying on the sender, which after the scheduler guard
    // is the MODULE identity: the recheck would then run against the wrong row,
    // or against no row at all, and the equality literal would be regenerated
    // around it.
    let subject = m22s3_nd_reaper_row_lookup();
    assert!(
        frozen.contains(subject.as_str()),
        "[rb24/reaper-needle-independence] the row-lookup needle {subject:?} is not a \
         substring of the frozen body literal. The two are transcribed separately and split \
         at different points, so a mismatch means one artefact was edited alone and the \
         clause below is asserting something other than the plan."
    );
    assert_eq!(
        m22_count_occurrences(body, &subject),
        1,
        "[rb24/reaper-recheck-subject] the reaper must look the account row up by the \
         identity the SCHEDULER supplied, {subject:?}, EXACTLY once. Authored from the plan \
         and asserted ahead of the equality: the scheduler guard has already proven the \
         sender IS the module, so a lookup keyed on the sender reads the module identity — \
         the recheck then runs against the wrong row, or against no row at all, and a \
         regenerated equality literal would ratify it."
    );

    // --- (2) POLARITY + RE-ARM, both inside the not-due branch --------------
    assert_eq!(
        m22_count_occurrences(body, &polarity),
        1,
        "[rb24/reaper-recheck-polarity] the reaper body must carry the PRV1-5 recheck AND \
         its re-arm branch {polarity:?} EXACTLY once. Authored from the plan and asserted \
         ahead of the equality on purpose: an arm that drops the negation, or empties the \
         re-arm branch, and then regenerates the equality literal from its own output is \
         green on equality alone — and a recheck of the wrong polarity cascades on precisely \
         the accounts that are Active, already terminal, or still inside their grace window."
    );
    let rearm_seam = m22s3b_nd_rearm_seam();
    assert_eq!(
        m22_count_occurrences(body, &rearm_seam),
        1,
        "[rb24/reaper-rearm-seam] the reaper must consult {rearm_seam:?} EXACTLY once. The \
         re-arm decision is a PURE seam (ADR-0228 D3) precisely so its truth table is a \
         behavioural test rather than a source scan; a second consultation, or an inline \
         re-derivation in place of it, moves that decision back out of reach of \
         `m22s3b_reaper_rearm_at_ms_truth_table`."
    );
    assert_eq!(
        rb24_net_arm_mentions(body),
        1,
        "[rb24/reaper-arms-once] the reaper body must name the arm helper EXACTLY once — \
         the one re-arm inside the not-yet-due branch. ZERO is the m22-s3 defect this slice \
         exists to close: the runtime deletes the fired one-shot row regardless of outcome, \
         so a not-yet-due fire that returns without re-arming drops the schedule and leaves \
         the account PendingDeletion with nothing armed, forever. MORE THAN ONE arms a \
         second cascade for the same request."
    );

    // --- (3) ORDERING, count before index (RT-18) ---------------------------
    let resolver = m22s3b_nd_resolver_call();
    let first_erase = m22s3b_nd_erase_monsters();
    assert_eq!(
        m22_count_occurrences(body, &resolver),
        1,
        "[rb24/reaper-resolver-once] the reaper must call the shared live-interaction \
         resolver {resolver:?} EXACTLY once. ZERO leaves a deleted account's live trades, \
         PvP battles, wild battle and outgoing challenges pointing at rows the next twelve \
         statements erase — the soft-lock the spec para-4.4 step-1 note calls the single \
         highest-value correction of the whole design."
    );
    assert_eq!(
        m22_count_occurrences(body, &first_erase),
        1,
        "[rb24/reaper-first-erase-once] the reaper must call {first_erase:?} EXACTLY once. \
         The ordering clause below anchors on it, so a decoy second occurrence would steer \
         a first-hit index at a statement nobody reviewed."
    );
    let at_resolver = idx(body, &resolver);
    let at_first_erase = idx(body, &first_erase);
    assert!(
        at_resolver < at_first_erase,
        "[rb24/reaper-resolve-before-erase] PRV1-6a: the resolver (offset {at_resolver}) \
         must run BEFORE the first erase (offset {at_first_erase}). Every force-resolve \
         helper reads the rows the erases delete — a trade offer's monster ids, a battle's \
         party — so resolving afterwards resolves against rows that are already gone and \
         leaves the surviving counterparty in a battle or trade that can never settle."
    );

    let char_rows = m22s3b_nd_erase_character_rows();
    let names = m22s3b_nd_anonymize_names();
    assert_eq!(
        m22_count_occurrences(body, &char_rows),
        1,
        "[rb24/reaper-character-once] the reaper must sweep the character join {char_rows:?} \
         EXACTLY once; the ordering clause below anchors on it."
    );
    assert_eq!(
        m22_count_occurrences(body, &names),
        1,
        "[rb24/reaper-names-once] the reaper must anonymize the display names {names:?} \
         EXACTLY once; the ordering clause below anchors on it."
    );
    let at_char = idx(body, &char_rows);
    let at_names = idx(body, &names);
    assert!(
        at_char < at_names,
        "[rb24/reaper-character-before-player] PRV1-6d: the `character` join-sweep (offset \
         {at_char}) must precede the `player` tombstone write (offset {at_names}). Spec \
         para 3 pins that order explicitly: `player` survives as the anchor every join and \
         live multi-user row points at, and `character` is reached ONLY through \
         `player.entity_id` — anonymize the player first and the join key is still there, \
         but the ordering the spec gate depends on is gone and the next reader cannot tell \
         which of the two rows is the anchor."
    );

    // --- (4) THE TERMINAL STAMP IS THE LAST, AND THE ONLY, ROW WRITE --------
    let update = m22s3b_nd_account_update();
    assert_eq!(
        m22_count_occurrences(body, &update),
        1,
        "[rb24/reaper-update-once] the reaper must write the account row EXACTLY once, \
         through {update:?}. ZERO means PRV1-6e never stamps `terminal_at_ms` and the \
         cascade repeats on every re-arm; MORE THAN ONE is a second, unreviewed account \
         write, and a stamp written before the cascade completes is exactly what PRV1-6e \
         forbids."
    );
    for (verb, what) in [
        (concat!(".ins", "ert("), "insert"),
        (concat!(".del", "ete("), "delete"),
    ] {
        assert_eq!(
            m22_count_occurrences(body, verb),
            0,
            "[rb24/reaper-delegates-every-write] the reaper body performs a direct `{what}` \
             row write. G5 MODULE_WRITE_ISOLATION closes accounts.rs at its four owned \
             tables, so EVERY erase and anonymize step must go through a `pub(crate)` \
             helper in the table's owning module (the `rekey_all` delegation precedent). A \
             direct write here is a write nobody in the owning module reviewed, and it is \
             invisible to that module's own shape pin."
        );
    }
    let terminal_ctor = m22s3b_nd_terminal_ctor();
    assert_eq!(
        m22_count_occurrences(body, &terminal_ctor),
        1,
        "[rb24/reaper-terminal-once] {terminal_ctor:?} must appear EXACTLY once in the \
         reaper body. This is the reachability half of ADR-0228 D5: the legality of the \
         terminal write is a theorem that holds only because the recheck has already \
         established PendingDeletion with a request stamp, and the debug_assert inside the \
         constructor compiles out of release. A second stamp site is a second, unproven \
         path to the one irreversible state in this module."
    );
    assert_eq!(
        m22_count_occurrences(body, &m22s3b_nd_anonymized_ctor()),
        1,
        "[rb24/reaper-anonymize-once] the account row must be composed through \
         `anonymized_account(` EXACTLY once. Stamping `terminal_at_ms` WITHOUT it leaves the \
         live `auth_issuer` on a row the spec para 3 requires to carry the tombstone \
         sentinel — a completed deletion that still records which OAuth provider the person \
         signed in with."
    );
    let at_update = idx(body, &update);
    let at_terminal = idx(body, &terminal_ctor);
    assert!(
        at_update < at_terminal,
        "[rb24/reaper-terminal-inside-update] the terminal constructor (offset {at_terminal}) \
         must sit INSIDE the one account update (offset {at_update}), not in a separate \
         earlier statement. A `let row = terminal_account(..);` hoisted above the cascade \
         computes the tombstone before the erases run and then writes it whatever happened \
         in between — PRV1-6e requires the stamp only AFTER 6a-6d complete without error."
    );
    assert!(
        at_names < at_update,
        "[rb24/reaper-terminal-last] the account update (offset {at_update}) must be the \
         LAST step, after every erase and anonymize (the display-name anonymize sits at \
         offset {at_names}). PRV1-6e is explicit that `terminal_at_ms` is set only once \
         steps 1-4 have completed; stamped earlier, a mid-cascade abort would leave a row \
         that reads as fully deleted with its data still present."
    );

    // --- (5) EQUALITY, last -------------------------------------------------
    assert_eq!(
        body, frozen,
        "[rb24/reaper-body] the deletion reaper body is not the m22-s3b frozen cascade \
         (rejecting scheduler guard, scheduler-keyed row lookup, ONE clock read, the PRV1-5 \
         recheck with its re-arm branch, the thirteen delegated calls in spec para-4.4 \
         order, the terminal stamp, then Ok(())). Every statement in this body is \
         irreversible, so this pin is EXACT rather than containment: a containment check \
         cannot tell a complete cascade from one missing a step, and it is green on an \
         appended foreign write, a dead-branch wrapper and a shadowed binding alike — all \
         four measured, all clippy-clean. If the sanctioned body legitimately changes, \
         re-derive this literal FROM ADR-0228 D2's step list, re-review the guard position \
         and the re-arm obligation in the same change, and update it consciously."
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
/// RE-DERIVED 3 -> 4 BY m22-s3b, AND PAID FOR (r2). The ADR-0221 R2 sweep
/// `ensure_deletion_reapers_armed` has to know which identities ALREADY carry a
/// schedule row — otherwise it re-arms every mid-grace account on every publish
/// — so it adds a FOURTH reach for this accessor. That reach is READ-ONLY: an
/// `.iter()` feeding the pure `plan_deletion_rearms` seam, with the actual
/// arming delegated to `arm_deletion_reaper`, whose body is separately frozen.
///
/// A bare bump to 4 would delete the tooth (any of the four sites could then
/// move anywhere), so the widening is compensated per SITE: the sweep's span
/// must hold EXACTLY ONE reach, that reach must be the `.iter()` READ, and the
/// sweep's body must contain ZERO row-write verbs of its own. Together those
/// say the new site can read the schedule table and cannot write it — which is
/// what keeps the two frozen-body pins the only description of how a schedule
/// row is ever created or removed.
///
/// Kills: a schedule write inlined into delete_account, cancel_account_deletion,
///        complete_guest_claim or the reaper itself; a third WRITING helper; the
///        reaper self-disarm (a fifth occurrence, outside all three spans); and
///        a sweep that arms rows by inserting schedule rows DIRECTLY instead of
///        delegating to the frozen arm helper — which would bypass the
///        `deletion_fire_at_ms` derivation and the saturating ms-to-us multiply
///        that pin exists to hold.
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
        total, 4,
        "[rb24/sole-writer-census] accounts.rs must reach the deletion schedule accessor \
         EXACTLY four times: once for the arm insert, twice for the disarm (the \
         account_identity filter and the primary-key delete), and once for the ADR-0221 R2 \
         sweep's READ-ONLY iteration over the already-armed set. Found {total}. FEWER means a \
         helper lost its reach — the arm or one half of the two-phase disarm, or the sweep's \
         already-armed read, whose absence makes the sweep re-arm every mid-grace account on \
         every publish. MORE means a site exists that none of the three span clauses below \
         constrains — including one reached through an aliased db handle."
    );

    let (arm_start, arm_end) = rb24_fn_body_span(&squashed, &rb24_nd_arm_decl());
    let (dis_start, dis_end) = rb24_fn_body_span(&squashed, &rb24_nd_disarm_decl());
    let (ens_start, ens_end) = rb24_fn_body_span(&squashed, &m22s3b_nd_ensure_decl());
    assert_eq!(
        m22_count_occurrences(&squashed[arm_start..arm_end], &accessor_call),
        1,
        "[rb24/sole-writer-arm] the arm helper must reach the schedule accessor exactly once. \
         The total-of-four clause alone does not pin the SPLIT: four occurrences all inside \
         one helper satisfies it."
    );
    assert_eq!(
        m22_count_occurrences(&squashed[dis_start..dis_end], &accessor_call),
        2,
        "[rb24/sole-writer-disarm] the disarm helper must reach the schedule accessor exactly \
         twice — once to filter the index, once to delete by primary key. One occurrence means \
         the two-phase shape collapsed into a delete inside the iteration."
    );

    // --- THE FOURTH SITE IS A READ, AND ONLY A READ (r2 compensation) -------
    let ens_span = &squashed[ens_start..ens_end];
    assert_eq!(
        m22_count_occurrences(ens_span, &accessor_call),
        1,
        "[rb24/sole-writer-sweep] the ADR-0221 R2 sweep must reach the schedule accessor \
         EXACTLY once — the already-armed read. ZERO means it cannot tell an armed row from \
         an unarmed one, so every publish adds another schedule row for every mid-grace \
         account and fires one full cascade per row. MORE THAN ONE is a second reach in a \
         body that is supposed only to look."
    );
    let read_only_reach = [accessor_call.as_str(), ")", concat!(".it", "er()")].concat();
    assert_eq!(
        m22_count_occurrences(ens_span, &read_only_reach),
        1,
        "[rb24/sole-writer-sweep-is-a-read] the sweep's one reach must be the iteration \
         `{read_only_reach}`. That spelling is what makes it a READ: it is the only shape \
         that can produce the already-armed identity set the pure `plan_deletion_rearms` seam \
         consumes, and it chains no write verb. A reach spelled any other way in this body is \
         a reach whose purpose this census cannot vouch for."
    );
    for (verb, what) in [
        (concat!(".ins", "ert("), "insert"),
        (concat!(".upd", "ate("), "update"),
        (concat!(".del", "ete("), "delete"),
    ] {
        assert_eq!(
            m22_count_occurrences(ens_span, verb),
            0,
            "[rb24/sole-writer-sweep-no-write] the ADR-0221 R2 sweep performs a direct \
             `{what}` row write. It must not: arming is DELEGATED to `arm_deletion_reaper`, \
             whose body is frozen by `rb24_arm_deletion_reaper_body_frozen` precisely so the \
             fire instant is derived through `deletion_fire_at_ms` and the ms-to-us multiply \
             saturates. A schedule row inserted directly here bypasses both, and it does so \
             for the whole overdue R2 population at once — the largest single batch of \
             irreversible cascades this module can schedule."
        );
    }

    let mut scan = 0usize;
    let mut seen = 0usize;
    while let Some(rel) = squashed[scan..].find(accessor_call.as_str()) {
        let at = scan + rel;
        let inside_arm = at >= arm_start && at < arm_end;
        let inside_disarm = at >= dis_start && at < dis_end;
        let inside_sweep = at >= ens_start && at < ens_end;
        assert!(
            inside_arm || inside_disarm || inside_sweep,
            "[rb24/sole-writer-scope] accounts.rs reaches the deletion schedule accessor at \
             squashed offset {at}, which lies OUTSIDE the arm helper body \
             ({arm_start}..{arm_end}), the disarm helper body ({dis_start}..{dis_end}) and \
             the R2 sweep body ({ens_start}..{ens_end}). Every touch of this table must go \
             through one of those three reviewed bodies: an inline insert in a reducer \
             bypasses the frozen fire-instant derivation, and an inline delete in the reaper \
             is the ADR-0126 D6 self-disarm that races the runtime own delete of the fired \
             one-shot row."
        );
        seen += 1;
        scan = at + accessor_call.len();
    }
    assert_eq!(
        seen, 4,
        "[rb24/sole-writer-walk] the position walk visited {seen} occurrence(s) where the \
         census counted 4. The two counts must agree or the scope clause above ran over a \
         different set of sites than the census measured."
    );
}

// ===========================================================================
// M22-S3 (slice m22-s3, ADR-0225) — THE TERMINAL-MARKER PREDICATES, THE PRV1-4
// GUARDS, AND THE PRV1-5 REAPER RECHECK.
//
// EARS criteria (`specs/monster-realm-v2/M22-privacy-compliance.spec.md` §7.4):
//   PRV1-4  WHEN `cancel_account_deletion` is called for an account that
//           already carries a terminal marker THE SYSTEM SHALL reject the call
//           with a static reason and write nothing — a completed erasure is
//           not reversible, and reversing it would resurrect a tombstone.
//   PRV1-5  WHEN the deletion-grace reaper fires THE SYSTEM SHALL re-check the
//           live row (status is `PendingDeletion`, no terminal marker yet, the
//           request is past its grace window) and no-op unless all three hold.
//   PRV1-7  `should_reject_for_deletion(&Account)` is the spec §4.7 named
//           single entry point for the deletion gate. THIS SLICE SHIPS THE
//           PREDICATE ONLY; the reducer-by-reducer ENFORCEMENT is S5/S6 and is
//           deliberately not gated here (ADR-0225).
//
// SCOPE, STATED PLAINLY SO THESE TESTS ARE NOT MISREAD AS MORE THAN THEY ARE:
// the spec §4.4 five-step cascade is NOT in this slice. G5 MODULE_WRITE_ISOLATION
// closes the accounts.rs write set at four tables, so every erase step needs a
// new `pub(crate)` helper in ten owning modules; that is S3b. What lands here is
// the recheck SKELETON plus the two terminal guards that keep an already-erased
// account from being resurrected or re-armed in the meantime.
//
// SCAN HYGIENE — the file header rule, restated because this section adds
// needles for a file that a dozen unmigrated evals concatenate wholesale (every
// `.rs` under `server-module/src`, `_tests.rs` siblings included). Every needle
// below is assembled from `concat!` fragments, so this file never carries a
// contiguous guard statement, accessor chain or call site that such a scanner
// could count as a real one — a bare needle here would satisfy those scans
// VACUOUSLY, which is the exact false-green this rule exists to prevent. This
// section contains no block comment, no raw string, no apostrophe and no bare
// double-quote character inside any comment.
//
// WHY ONE STRUCTURE TEST (T3) AND SEVEN PURE ONES: there is no way to construct
// a `ReducerContext` in this crate, so a reducer BODY has no runtime harness at
// all. Everything that can be a pure seam is one and is EXECUTED; the two guard
// PLACEMENTS — which are ordering properties of a reducer body — are provable
// only over the source. ADR-0225 records that justification once.
// ===========================================================================

// ---------------------------------------------------------------------------
// m22-s3 needles. AUTHORED FROM THE PLAN, never derived by running the impl and
// copying what it printed (red-team B1). Split mid-token, per the file rule.
// ---------------------------------------------------------------------------

/// The squashed terminal-marker predicate call as both guards spell it.
fn m22s3_nd_marker_call() -> String {
    concat!("account_has_terminal", "_marker(&account)").to_string()
}

/// PRV1-4 — the WHOLE cancel-side guard statement, squashed.
///
/// `stripped_for_scan` blanks string literals, so the reducer-name argument of
/// `reject(..)` reads as EMPTY between the open paren and the comma — the same
/// shape the frozen reaper body pins as `Err(.to_string())`. The needle is the
/// whole statement rather than the condition alone: a condition that is present
/// but whose branch does something other than reject is the measured
/// present-but-inert family, and it satisfies every containment clause.
fn m22s3_nd_cancel_terminal_guard() -> String {
    [
        "if".to_string(),
        m22s3_nd_marker_call(),
        concat!("{returnrej", "ect(,me,").to_string(),
        concat!("REJECT_ALREADY", "_DELETED);}").to_string(),
    ]
    .concat()
}

/// PRV1-2 / W1b — the WHOLE delete-side guard statement, squashed. `Ok` shape,
/// not `reject`: PRV1-2 says a delete on an account already heading for deletion
/// returns `Ok(())` and writes nothing, and a terminal row is the extreme case
/// of that state.
fn m22s3_nd_delete_terminal_guard() -> String {
    [
        "if".to_string(),
        m22s3_nd_marker_call(),
        concat!("{returnOk", "(());}").to_string(),
    ]
    .concat()
}

/// PRV1-5 — the reaper-side recheck statement, squashed. The `!` is the whole
/// point: this is the POLARITY needle (see
/// `rb24_deletion_reaper_body_is_pinned_cascade`).
///
/// m22-s3b (ADR-0228 D3) EXTENDS it with the RE-ARM BRANCH. The runtime deletes
/// the fired one-shot schedule row regardless of what this reducer does, so the
/// old bare `return Ok(());` on a not-yet-due account dropped the reaper with
/// nothing armed and the account stayed `PendingDeletion` forever. The re-arm is
/// therefore part of the SAME plan statement as the recheck, and pinning them
/// together is what stops the branch being re-emptied one edit later.
///
/// The clock is the HOISTED `now` binding, not a second `now_ms(ctx)` read: the
/// recheck and the re-arm fire instant must be derived from ONE instant, or a
/// row can read not-due against one clock and be re-armed against another.
fn m22s3_nd_reaper_recheck_guard() -> String {
    concat!(
        "if!reaper_should_run",
        "_cascade(&account,now){",
        "ifletSome(requested)=reaper_rearm",
        "_at_ms(&account,now){",
        "arm_deletion",
        "_reaper(ctx,args.account_identity,requested);}",
        "returnOk(());}"
    )
    .to_string()
}

/// PRV1-5 — the SUBJECT needle: the reaper must look the row up by the identity
/// the SCHEDULER handed it, never by anything else.
fn m22s3_nd_reaper_row_lookup() -> String {
    concat!(".find(args.account", "_identity)").to_string()
}

/// The ASCII double quote, built from its code point so this section never
/// spells a backslash-escaped quote or a quote-bearing char literal (file
/// header rule). Only the strings-KEPT needle below needs it.
fn m22s3_dq() -> char {
    char::from(0x22u8)
}

/// PRV1-4, strings-KEPT twin of `m22s3_nd_cancel_terminal_guard()`: the same
/// statement with the reducer-name argument of `reject(..)` still readable.
///
/// `stripped_for_scan` BLANKS string literals, so the squashed-and-blanked
/// needle matches whatever reducer tag the guard passes — a guard tagged
/// `start_guest_claim` was MEASURED green against it, which merges two
/// audit-log classes and misattributes every PRV1-4 reject in the reject log.
/// Matching this needle in `stripped_keep_strings` output pins the tag AND its
/// adjacency to the guard in one contiguous substring, with no brace walk over
/// a string-bearing view.
fn m22s3_nd_cancel_terminal_guard_tagged() -> String {
    let q = m22s3_dq();
    [
        "if".to_string(),
        m22s3_nd_marker_call(),
        concat!("{returnrej", "ect(").to_string(),
        format!("{q}{}{q}", concat!("cancel_account", "_deletion")),
        concat!(",me,REJECT_ALREADY", "_DELETED);}").to_string(),
    ]
    .concat()
}

/// The squashed declaration needle for the deletion-gate SSOT wrapper.
fn m22s3_nd_pending_decl() -> String {
    concat!("fnis_pending", "_deletion(").to_string()
}

/// The squashed declaration needle for the reaper recheck predicate.
fn m22s3_nd_cascade_decl() -> String {
    concat!("fnreaper_should_run", "_cascade(").to_string()
}

/// The squashed delegation needle: `is_pending_deletion` must ASK the shared
/// gate predicate, with no negation of its answer.
fn m22s3_nd_pending_delegation() -> String {
    concat!(".is_some_and(|a|should_reject", "_for_deletion(&a))").to_string()
}

/// The same account, plus a LEGAL claim-provenance pair and off-baseline
/// `auth_issuer` / `last_login_at_ms`.
///
/// FIXTURE MONOCULTURE IS A MEASURED HOLE: every m22s3 truth-table row spreads
/// `base_account(n)`, so all four of `claimed_from`, `claimed_at_ms`,
/// `auth_issuer` and `last_login_at_ms` carry the same value on every row — and
/// a predicate that ALSO reads one of them answers identically everywhere and is
/// invisible. Three such wrong implementations were measured green. Each table
/// below therefore carries one TWIN of an expected-false row and one TWIN of an
/// expected-true row built through this helper: the false twin kills a disjunct
/// that ORs claim provenance IN, the true twin kills a conjunct that ANDs it
/// OUT. One twin alone closes only one of the two polarities.
///
/// Legality is preserved by construction — the claim pair is set on BOTH halves
/// (AUTH-21) and no lifecycle field moves — so a twin is exactly its base row
/// plus fields the predicate under test must not be reading.
fn m22s3_claim_variant(account: Account) -> Account {
    Account {
        auth_issuer: "issuer-variant-under-test".to_string(),
        last_login_at_ms: 4_242,
        claimed_from: Some(ident(77)),
        claimed_at_ms: Some(1_234),
        ..account
    }
}

// ---------------------------------------------------------------------------
// m22-s3 / PRV1-4 — THE TERMINAL-MARKER PREDICATE.
// ---------------------------------------------------------------------------

/// PRV1-4 (pure, table-driven): `account_has_terminal_marker` answers
/// `terminal_at_ms.is_some()` and NOTHING else.
///
/// NAMING DIVERGENCE FROM THE SPEC, RECORDED RATHER THAN PAPERED OVER: spec §4.1
/// defines `terminal` as the CONJUNCTION (status `PendingDeletion` AND a request
/// stamp AND a marker). This predicate is deliberately the MARKER HALF alone, and
/// the fourth row is why. On the illegal `Active` + marker shape — a resurrected
/// tombstone, which `account_state_is_legal` rejects and which nothing in this
/// slice can write — the conjunction answers `false` and would wave the row
/// through both guards; the marker half answers `true` and refuses it. That is
/// FAIL-CLOSED, and it is the only behaviour difference between the two
/// spellings. ADR-0225 records the divergence.
///
/// The legality column is not decoration: it pins that row 4 really is the
/// ILLEGAL shape the fail-closed argument is about, so this test cannot quietly
/// become a claim about a legal state that the invariant would have rejected
/// anyway.
///
/// Kills: a predicate mutated to a constant (either constant fires on at least
///        two rows); a predicate that ANDs in the status check (row 4 flips to
///        false — the laundering shape below would then reach the state write);
///        a predicate that reads `deletion_requested_at_ms` instead (row 2
///        flips to true and row 3 is unchanged, so a one-row test would miss it);
///        a predicate that also reads claim provenance, `auth_issuer` or
///        `last_login_at_ms` — rows 5 and 6 are the claim-variant twins of rows
///        1 and 3 and must answer exactly what their twins answer (measured
///        hole: every other row spreads the same `base_account`, so such a
///        predicate is invisible without them).
#[test]
fn m22s3_account_has_terminal_marker_truth_table() {
    let cases: [(&str, Account, bool, bool); 6] = [
        (
            "LEGAL live account: Active, no terminal marker",
            base_account(1),
            false,
            true,
        ),
        (
            "LEGAL grace window: PendingDeletion + request stamp, no marker yet",
            Account {
                status: AccountStatus::PendingDeletion,
                deletion_requested_at_ms: Some(50),
                ..base_account(1)
            },
            false,
            true,
        ),
        (
            "LEGAL tombstone: PendingDeletion + request stamp + terminal marker",
            Account {
                status: AccountStatus::PendingDeletion,
                deletion_requested_at_ms: Some(50),
                terminal_at_ms: Some(900),
                ..base_account(1)
            },
            true,
            true,
        ),
        (
            "ILLEGAL resurrected tombstone: Active + terminal marker",
            Account {
                terminal_at_ms: Some(900),
                ..base_account(1)
            },
            true,
            false,
        ),
        (
            "LEGAL claimed live account: claim provenance must not read as a marker",
            m22s3_claim_variant(base_account(1)),
            false,
            true,
        ),
        (
            "LEGAL claimed tombstone: claim provenance must not hide the marker",
            m22s3_claim_variant(Account {
                status: AccountStatus::PendingDeletion,
                deletion_requested_at_ms: Some(50),
                terminal_at_ms: Some(900),
                ..base_account(1)
            }),
            true,
            true,
        ),
    ];

    for (label, account, expected_marker, expected_legal) in cases {
        assert_eq!(
            account_state_is_legal(&account),
            expected_legal,
            "[m22s3/marker-fixture] the fixture {label:?} is not the state it claims to be. \
             The fail-closed argument for this predicate is ABOUT the illegal shape, so the \
             row that is supposed to be illegal must actually be one."
        );
        assert_eq!(
            account_has_terminal_marker(&account),
            expected_marker,
            "[m22s3/marker] account_has_terminal_marker disagreed on {label:?}. It is \
             `terminal_at_ms.is_some()` and nothing else — deliberately the MARKER HALF of \
             spec §4.1 `terminal`, not the conjunction. FAIL-CLOSED IS THE WHOLE POINT: on \
             the illegal Active-plus-marker row it must still answer TRUE, because an \
             already-erased account must never be cancelled back to life or re-armed for a \
             second cascade just because its status column was corrupted."
        );
    }
}

/// PRV1-4 (pure, const value): `REJECT_ALREADY_DELETED` is a non-empty, STATIC,
/// DISTINCT reject reason.
///
/// Distinctness is the security property, not tidiness. Every other reason in
/// this module answers a question the caller is allowed to ask; this one answers
/// `your account is already gone`, and a caller that cannot tell it apart from
/// `no account` or `sign in required` cannot be told the truth by the UI at all.
/// Sharing a string with another guard would also silently merge two audit-log
/// classes into one.
///
/// The brace clause is the STATIC half: `reject` takes `&str` and logs it
/// verbatim (G12 no-PII-in-logs), so a reason carrying a format placeholder is
/// either a lie in the log or the first step toward interpolating account data
/// into it.
///
/// Kills: an empty string (the caller sees a blank reject); a BLANK-ISH string —
///        a single space, or padding around a one-character reason — which was
///        measured green against non-empty plus distinct plus no-braces alone;
///        a zero-width or bidi-override character that renders blank or
///        reversed; a copy-paste of an existing reason; a `format!`-shaped
///        template smuggled in as a const.
#[test]
fn m22s3_reject_already_deleted_is_distinct_and_static() {
    assert!(
        !REJECT_ALREADY_DELETED.is_empty(),
        "[m22s3/reject-nonempty] REJECT_ALREADY_DELETED is empty. A reject whose reason is \
         the empty string is indistinguishable from no reason at all, in the client error \
         and in the reject log alike."
    );

    let trimmed = REJECT_ALREADY_DELETED.trim();
    assert_eq!(
        trimmed, REJECT_ALREADY_DELETED,
        "[m22s3/reject-trim-stable] REJECT_ALREADY_DELETED carries leading or trailing \
         whitespace. Non-emptiness alone was MEASURED insufficient: a single space passes it, \
         renders as a blank error in the client and as a blank reason in the reject log, and \
         is still distinct from every other reason so the distinctness clauses below stay \
         green too."
    );
    assert!(
        trimmed.len() >= 10,
        "[m22s3/reject-substantive] REJECT_ALREADY_DELETED trims to {} byte(s), which is too \
         short to be a sentence a player can act on. PRV1-4 requires a DISTINCT, non-generic \
         error; a one- or two-character reason is technically distinct and practically a \
         blank.",
        trimmed.len()
    );
    assert!(
        REJECT_ALREADY_DELETED
            .chars()
            .all(|c| c.is_ascii_graphic() || c == ' '),
        "[m22s3/reject-printable] REJECT_ALREADY_DELETED contains a character that is not \
         printable ASCII. A zero-width or bidi-override character renders blank or reversed \
         wherever this reason is shown and logged, while passing every length and \
         distinctness clause — the same property game-core pins on its tombstone sentinels."
    );

    for brace in ["{", "}"] {
        assert!(
            !REJECT_ALREADY_DELETED.contains(brace),
            "[m22s3/reject-static] REJECT_ALREADY_DELETED contains {brace:?}. Reject reasons \
             in this module are STATIC literals: `reject` hands the reason straight to \
             `log_reject`, and a placeholder is the shape that grows into an interpolated \
             account detail in a log line (ADR-0179 G12)."
        );
    }

    // Every reject reason accounts.rs can hand a caller today. Consts where the
    // name is in scope, literal text where the reason is an inline literal.
    let others: [(&str, &str); 15] = [
        ("AUTH-12/37/38 no-JWT", concat!("sign in ", "required")),
        ("AUTH-12/37/38 no account row", concat!("no ", "account")),
        (
            "AUTH-7 already an account holder",
            concat!("already ", "signed in"),
        ),
        (
            "AUTH-8 malformed claim code",
            concat!("invalid ", "claim code"),
        ),
        ("AUTH-9 no player row", concat!("not ", "joined")),
        (
            "AUTH-13 pending deletion",
            concat!("account ", "pending deletion"),
        ),
        (
            "AUTH-14 one claim per account",
            concat!("account ", "already claimed"),
        ),
        ("AUTH-15/35 shared code reason", ERR_INVALID_CODE),
        ("AUTH-16 expired code", concat!("code ", "expired")),
        (
            "AUTH-17 own-session claim",
            concat!("cannot claim your ", "own session"),
        ),
        (
            "AUTH-18 stale tab",
            concat!("close your other tab, ", "then retry"),
        ),
        (
            "AUTH-19 mid-battle",
            concat!("already in an ", "ongoing battle"),
        ),
        (
            "AUTH-20 destination has data",
            concat!("already has ", "game data"),
        ),
        ("AUTH-36 unrecognized issuer", REJECT_UNRECOGNIZED_ISSUER),
        (
            "AUTH-36 unrecognized audience",
            REJECT_UNRECOGNIZED_AUDIENCE,
        ),
    ];
    for (what, other) in others {
        assert_ne!(
            REJECT_ALREADY_DELETED, other,
            "[m22s3/reject-distinct] REJECT_ALREADY_DELETED is byte-identical to the \
             {what} reason {other:?}. PRV1-4 is a distinct outcome — the account is gone, \
             not absent, not unauthenticated, not mid-claim — and a caller that cannot \
             distinguish the two cannot be shown a truthful message. Two guards sharing one \
             literal also collapse two audit-log classes into one."
        );
    }
}

// ---------------------------------------------------------------------------
// m22-s3 / PRV1-4 + W1b — THE GUARD PLACEMENTS (the ONE structure test).
// ---------------------------------------------------------------------------

/// PRV1-4 (cancel) and PRV1-2 (delete): each terminal guard exists EXACTLY ONCE,
/// sits at the top level of the reducer it belongs to, and runs BEFORE that
/// reducer reaches its idempotency gate or its state write.
///
/// WHY A SOURCE SCAN AT ALL: a reducer body cannot be executed from this crate
/// (there is no way to build a `ReducerContext`), so a guard PLACEMENT has no
/// runtime harness. ADR-0225 records that justification.
///
/// ORDER IS THE CLAUSE THAT MATTERS, and it is a red-team fix (plan R3): a guard
/// placed AFTER `needs_cancel_write` still contains every needle and still reads
/// as present, while the reducer has already decided to write. On the cancel
/// side that write is `cancelled_deletion`, which flips a completed tombstone
/// back to `Active` and clears the request stamp — the row is then an ordinary
/// live account whose data was already erased.
///
/// ON THE DELETE SIDE THE ORDERING CLOSES A MEASURED LAUNDERING PATH: the
/// illegal `Active` + marker row passes `needs_deletion_write(Active) == true`,
/// gets re-written by `requested_deletion` into a LEGAL `PendingDeletion` +
/// request + marker row, and ARMS A SECOND CASCADE against an account that has
/// already been erased once. The guard returns `Ok(())` rather than rejecting so
/// PRV1-2 keeps its letter (a delete on an account already heading for deletion
/// is a silent no-op), and behaviour on every legal state is unchanged.
///
/// POSITION IS NOT ENOUGH ON ITS OWN, and that is a measured finding rather than
/// a hunch. A guard can be textually perfect, first, and at depth zero and still
/// be DEAD: `let account = Account { terminal_at_ms: None, ..account };` slipped
/// in above it rebinds the subject, so the guard reads a row whose marker was
/// just stripped and can never fire. The subject-binding census below is what
/// closes it — each body binds `account` exactly once, through the `let ... else`
/// lookup, and never rebinds it.
///
/// THE DELEGATION CLAUSE IS HERE AND NOT IN A PURE TEST because the thing that
/// can go wrong is a NEGATION, not a value: `is_pending_deletion` inverted to
/// `.is_some_and(|a| !should_reject_for_deletion(&a))` was measured green across
/// the whole suite, and it turns the AUTH-13 guard of `complete_guest_claim`
/// inside out — every account mid-deletion may claim, and every ordinary account
/// may not. No ctx-bound test can execute it, so the polarity is pinned as text.
///
/// Kills: a guard moved below the idempotency gate or below the state write
///        (both orderings); a second decoy copy of either guard that steers a
///        first-hit anchored read; a guard nested inside a conditional block,
///        which sits at brace depth greater than zero and never runs on the path
///        that matters; a guard placed in the WRONG reducer (the whole-file
///        count stays at one while the body-scoped lookup fails);
///        a shadowed subject binding that makes either guard permanently dead;
///        a PRV1-4 reject tagged with another reducer name (the blanked-string
///        needle cannot see the tag; the strings-kept twin can);
///        an inverted `is_pending_deletion` delegation;
///        a `reaper_should_run_cascade` re-composed over the gameplay gate, or
///        one that stops delegating the grace window to game-core.
#[test]
fn m22s3_terminal_guards_precede_state_writes() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);

    // --- cancel_account_deletion (PRV1-4) -----------------------------------
    //
    // RE-DERIVED 1 -> 2 BY m22-s3b, AND PAID FOR PER SPAN. ADR-0228 D6 splits
    // `complete_guest_claim`'s Guard 3 so a terminal-marker destination is
    // refused with the SAME distinct REJECT_ALREADY_DELETED reason the cancel
    // path uses. In the string-BLANKED view the reducer-name argument of
    // `reject(..)` is empty, so the two guards squash to the SAME text and a
    // whole-file count of 1 became mechanically unsatisfiable. The compensation
    // is strictly stronger than the number it replaces: each of the two bodies is
    // pinned to EXACTLY ONE occurrence, so a guard that moved from one reducer to
    // the other — or a decoy third copy in a helper — reds where a bumped whole
    // -file count would not. The audit TAG of each is pinned separately, on the
    // strings-KEPT view, by the two `..._tagged` needles.
    let cancel_guard = m22s3_nd_cancel_terminal_guard();
    let n_cancel_guard = m22_count_occurrences(&squashed, &cancel_guard);
    assert_eq!(
        n_cancel_guard, 2,
        "[m22s3/cancel-guard-unique] accounts.rs must carry the terminal-marker reject guard \
         {cancel_guard:?} EXACTLY twice; found {n_cancel_guard}. The two sites are \
         cancel_account_deletion (PRV1-4: a completed erasure is not reversible) and \
         complete_guest_claim's Guard 3a (ADR-0228 D6: an already-deleted destination gets \
         the distinct reason instead of the generic mid-grace one). They read IDENTICALLY \
         here because this view blanks the reducer-name argument. FEWER means one of the two \
         guards is missing, mis-spelled, or was written as a condition whose branch does \
         something other than reject — and a cancel on a completed tombstone then flips it \
         back to Active. MORE is a decoy that steers a first-hit anchored read at a copy \
         nobody reviewed."
    );

    let (cancel_start, cancel_end) = rb24_fn_body_span(&squashed, &rb24_nd_cancel_decl());
    let cancel_body = &squashed[cancel_start..cancel_end];
    assert_eq!(
        m22_count_occurrences(cancel_body, &cancel_guard),
        1,
        "[m22s3/cancel-guard-span] cancel_account_deletion must carry the terminal guard \
         EXACTLY once. This per-span clause is the compensation for the whole-file count \
         widening to 2: without it, BOTH occurrences could sit in complete_guest_claim while \
         the cancel path — the one PRV1-4 actually names — has none, and the whole-file \
         count would still read 2."
    );
    let (claim_guard_start, claim_guard_end) = rb24_fn_body_span(&squashed, &nd_complete());
    assert_eq!(
        m22_count_occurrences(&squashed[claim_guard_start..claim_guard_end], &cancel_guard),
        1,
        "[m22s3/claim-guard-span] complete_guest_claim must carry the terminal guard EXACTLY \
         once (ADR-0228 D6 Guard 3a). The mirror of the clause above: with only the cancel \
         span pinned, both occurrences could sit in cancel_account_deletion and the claim \
         ceremony would still hand an already-erased account the generic mid-grace reason — \
         which is the message split D6 exists to make."
    );
    let at_cancel_guard = cancel_body.find(cancel_guard.as_str()).unwrap_or_else(|| {
        panic!(
            "[m22s3/cancel-guard-scope] the one PRV1-4 guard in accounts.rs is NOT inside \
                 cancel_account_deletion. A whole-file count of one is green on a guard that \
                 landed in a helper, in another reducer, or in dead code, while the reducer \
                 PRV1-4 names still cancels a completed deletion."
        )
    });

    assert_eq!(
        rb24_brace_depth(&cancel_body[..at_cancel_guard]),
        0,
        "[m22s3/cancel-guard-depth0] the PRV1-4 guard sits inside a nested block of \
         cancel_account_deletion rather than at the top level of the body. A conditional \
         guard is no guard: an enclosing condition that is false on the terminal path keeps \
         every count- and ordering-based clause here green while the cancel proceeds."
    );

    let cancel_gate = concat!("needs_cancel", "_write(");
    let cancel_write = concat!(".upd", "ate(cancelled", "_deletion");
    let at_cancel_gate = idx(cancel_body, cancel_gate);
    let at_cancel_write = idx(cancel_body, cancel_write);
    assert!(
        at_cancel_guard < at_cancel_gate,
        "[m22s3/cancel-guard-before-gate] the PRV1-4 terminal guard (offset \
         {at_cancel_guard}) must precede the AUTH-38 idempotency gate (offset \
         {at_cancel_gate}). Behind the gate the reducer has already decided the row needs a \
         write, and a terminal row IS PendingDeletion, so the gate says yes — the guard then \
         has to undo a decision instead of preventing it. Guard-first is also what makes the \
         reducer fail-closed on the illegal Active-plus-marker row, where the gate says no \
         for the wrong reason."
    );
    assert!(
        at_cancel_guard < at_cancel_write,
        "[m22s3/cancel-guard-before-write] the PRV1-4 terminal guard (offset \
         {at_cancel_guard}) must precede the `cancelled_deletion` state write (offset \
         {at_cancel_write}). After the write the tombstone is already back to Active with its \
         request stamp cleared: the account reads as an ordinary live account whose data was \
         irreversibly erased, and no later statement can restore it."
    );

    let tagged = m22s3_nd_cancel_terminal_guard_tagged();
    assert_eq!(
        m22_count_occurrences(&stripped_keep_strings(ACCOUNTS_RS), &tagged),
        1,
        "[m22s3/cancel-guard-audit-tag] the PRV1-4 guard must reject under its OWN reducer \
         tag, {tagged:?}. Every clause above reads the string-BLANKED view, in which the \
         reducer-name argument of reject is empty — so a guard tagged with another reducer \
         name satisfies all of them, and was measured green. The tag is what `log_reject` \
         writes, so the wrong one silently files every late-cancel reject under a different \
         audit-log class."
    );

    // --- delete_account (W1b, PRV1-2 letter) --------------------------------
    let delete_guard = m22s3_nd_delete_terminal_guard();
    assert_eq!(
        m22_count_occurrences(&squashed, &delete_guard),
        1,
        "[m22s3/delete-guard-unique] accounts.rs must carry the W1b terminal guard \
         {delete_guard:?} EXACTLY once. ZERO reopens the measured laundering path: the \
         illegal Active-plus-marker row passes needs_deletion_write(Active), is re-written \
         into a legal PendingDeletion-plus-marker row, and arms a SECOND cascade on an \
         account that was already erased. MORE THAN ONE is a decoy copy."
    );

    let (delete_start, delete_end) = rb24_fn_body_span(&squashed, &rb24_nd_delete_account_decl());
    let delete_body = &squashed[delete_start..delete_end];
    let at_delete_guard = delete_body.find(delete_guard.as_str()).unwrap_or_else(|| {
        panic!(
            "[m22s3/delete-guard-scope] the one W1b guard in accounts.rs is NOT inside \
                 delete_account. A whole-file count of one is green on a guard that landed \
                 somewhere else entirely, while the laundering path through delete_account \
                 stays open."
        )
    });

    assert_eq!(
        rb24_brace_depth(&delete_body[..at_delete_guard]),
        0,
        "[m22s3/delete-guard-depth0] the W1b terminal guard sits inside a nested block of \
         delete_account rather than at the top level. An enclosing condition that is false \
         on the terminal path keeps the count and ordering clauses green while the \
         re-arm laundering path stays reachable."
    );

    let delete_gate = concat!("needs_deletion", "_write(");
    let at_delete_gate = idx(delete_body, delete_gate);
    assert!(
        at_delete_guard < at_delete_gate,
        "[m22s3/delete-guard-before-gate] the W1b terminal guard (offset {at_delete_guard}) \
         must precede the AUTH-28 idempotency gate (offset {at_delete_gate}). That gate keys \
         on STATUS ALONE: on the illegal Active-plus-marker row it returns true, the row is \
         re-stamped into a legal PendingDeletion-plus-marker row, and arm_deletion_reaper \
         schedules a second cascade over an account whose data is already gone. Behind the \
         gate the guard cannot stop that; ahead of it, it never starts."
    );

    // --- the subject both guards read must be the row that was looked up ----
    let lookup_bind = concat!("letSome(acc", "ount)=");
    for (what, body) in [
        ("cancel_account_deletion", cancel_body),
        ("delete_account", delete_body),
    ] {
        for shadow in [concat!("letacc", "ount"), concat!("letmutacc", "ount")] {
            assert_eq!(
                m22_count_occurrences(body, shadow),
                0,
                "[m22s3/subject-no-shadow] {what} rebinds `account` ({shadow:?}). A rebind \
                 above the terminal guard makes the guard PERMANENTLY DEAD while every \
                 count, depth and ordering clause above stays green — the measured shape is \
                 one line that spreads the row with the marker cleared, after which the \
                 guard inspects a subject that no longer carries what it exists to detect."
            );
        }
        assert_eq!(
            m22_count_occurrences(body, lookup_bind),
            1,
            "[m22s3/subject-single-lookup] {what} must bind `account` EXACTLY once, through \
             the row lookup. Zero means the guard reads something that is not the caller \
             live row; more than one means a second binding shadows the first, which is the \
             same dead-guard shape from the other direction."
        );
    }

    // --- the deletion gate SSOT delegates, and does not invert the answer ---
    let (pending_start, pending_end) = rb24_fn_body_span(&squashed, &m22s3_nd_pending_decl());
    let delegation = m22s3_nd_pending_delegation();
    assert_eq!(
        m22_count_occurrences(&squashed[pending_start..pending_end], &delegation),
        1,
        "[m22s3/pending-delegation] is_pending_deletion must ask the shared gate predicate \
         exactly as {delegation:?} — note the absence of a negation, which is the whole \
         clause. Inverting it to the `!should_reject_for_deletion` form was MEASURED green \
         across the entire suite while turning AUTH-13 inside out: `complete_guest_claim` \
         would then admit every account mid-deletion and refuse every ordinary one. There is \
         no ReducerContext in this crate, so this polarity has no runtime harness."
    );

    // --- the reaper recheck is defined directly, over the game-core SSOT ----
    let (cascade_start, cascade_end) = rb24_fn_body_span(&squashed, &m22s3_nd_cascade_decl());
    let cascade_body = &squashed[cascade_start..cascade_end];
    for (needle, why) in [
        (
            concat!("==AccountStatus::", "PendingDeletion"),
            "the status conjunct must be spelled DIRECTLY here, not borrowed from \
             should_reject_for_deletion — a composition over the gameplay gate was measured \
             green, and it hands a future S5 widening of that gate the power to widen what \
             the reaper irreversibly erases",
        ),
        (
            concat!("game_core::is_deletion", "_due("),
            "the grace window has ONE SSOT in game-core (spec para 4.3) — a locally re-derived \
             comparison against a hand-typed constant is a second copy of the window, free to \
             drift, and an operator retune would then move only one of them",
        ),
    ] {
        assert_eq!(
            m22_count_occurrences(cascade_body, needle),
            1,
            "[m22s3/cascade-shape] reaper_should_run_cascade must contain {needle:?} exactly \
             once: {why}."
        );
    }
}

// ---------------------------------------------------------------------------
// m22-s3 / PRV1-5 — THE REAPER-SIDE RECHECK PREDICATE.
// ---------------------------------------------------------------------------

/// PRV1-5 (pure, exhaustive table): `reaper_should_run_cascade` is true for
/// EXACTLY ONE of the twelve `(status, terminal marker, request stamp)`
/// combinations — `PendingDeletion`, no marker, and a request past its grace
/// window — and false for the other eleven.
///
/// The three conjuncts are decoupled on purpose (plan reviewer M2): this
/// predicate is defined DIRECTLY, not as `should_reject_for_deletion` plus
/// extras, so a future S5 widening of the gate predicate cannot silently widen
/// what the reaper is willing to erase.
///
/// WHY EVERY ILLEGAL COMBINATION IS IN THE TABLE: this predicate reads a LIVE
/// row, and the reaper fires minutes-to-days after the request. Rows that
/// `account_state_is_legal` forbids are exactly the rows a bug elsewhere would
/// produce, and the reaper is the one caller whose no-op is free and whose
/// false-positive is irreversible. Answering `false` on all of them is the
/// fail-closed direction and is asserted, not assumed.
///
/// The single-true-row clause is a tooth on the TABLE, not on the predicate: a
/// table whose only positive row was edited away would otherwise pass against a
/// predicate mutated to constant `false`.
///
/// Kills: dropping the status conjunct (rows 3 and 6 flip); dropping the
///        terminal conjunct (row 12 flips, which is a SECOND cascade over an
///        already-erased account); dropping the due-ness conjunct (rows 7 and 8
///        flip, erasing inside the grace window a player is still entitled to);
///        an `is_deletion_due(None, _) == true` regression (row 7 flips — for
///        THIS predicate the blast radius is every stamp-less PendingDeletion
///        row, since the status conjunct already excludes ordinary accounts; the
///        every-account reading belongs to `is_deletion_due` itself, not here);
///        a predicate that also reads claim provenance, `auth_issuer` or
///        `last_login_at_ms` (rows 13 and 14 are the claim-variant twins of rows
///        8 and 9 and must answer exactly what their twins answer);
///        either constant mutant.
#[test]
fn m22s3_reaper_should_run_cascade_truth_table() {
    // A fixed clock, and the two request instants that sit on either side of the
    // grace boundary relative to it. Derived from the game-core SSOT so an
    // operator retune of the window cannot silently invert a row.
    const NOW_MS: i64 = 1_900_000_000_000;
    let due = NOW_MS - DELETION_GRACE_MS_DEFAULT;
    let not_due = NOW_MS - DELETION_GRACE_MS_DEFAULT + 1;

    let row = |status: AccountStatus, requested: Option<i64>, terminal: Option<i64>| Account {
        status,
        deletion_requested_at_ms: requested,
        terminal_at_ms: terminal,
        ..base_account(3)
    };

    let cases: [(&str, Account, bool); 14] = [
        (
            "Active / no marker / no request",
            row(AccountStatus::Active, None, None),
            false,
        ),
        (
            "Active / no marker / request inside the grace window",
            row(AccountStatus::Active, Some(not_due), None),
            false,
        ),
        (
            "Active / no marker / request past the grace window",
            row(AccountStatus::Active, Some(due), None),
            false,
        ),
        (
            "Active / marker / no request",
            row(AccountStatus::Active, None, Some(900)),
            false,
        ),
        (
            "Active / marker / request inside the grace window",
            row(AccountStatus::Active, Some(not_due), Some(900)),
            false,
        ),
        (
            "Active / marker / request past the grace window",
            row(AccountStatus::Active, Some(due), Some(900)),
            false,
        ),
        (
            "PendingDeletion / no marker / no request (ILLEGAL intermediate; a \
             CANCELLED account is Active with no stamp, not this)",
            row(AccountStatus::PendingDeletion, None, None),
            false,
        ),
        (
            "PendingDeletion / no marker / request inside the grace window",
            row(AccountStatus::PendingDeletion, Some(not_due), None),
            false,
        ),
        (
            "PendingDeletion / no marker / request past the grace window",
            row(AccountStatus::PendingDeletion, Some(due), None),
            true,
        ),
        (
            "PendingDeletion / marker / no request",
            row(AccountStatus::PendingDeletion, None, Some(900)),
            false,
        ),
        (
            "PendingDeletion / marker / request inside the grace window",
            row(AccountStatus::PendingDeletion, Some(not_due), Some(900)),
            false,
        ),
        (
            "PendingDeletion / marker / request past the grace window",
            row(AccountStatus::PendingDeletion, Some(due), Some(900)),
            false,
        ),
        (
            "CLAIM TWIN of row 8: claim provenance must not shorten the grace window",
            m22s3_claim_variant(row(AccountStatus::PendingDeletion, Some(not_due), None)),
            false,
        ),
        (
            "CLAIM TWIN of row 9: claim provenance must not exempt a row from the cascade",
            m22s3_claim_variant(row(AccountStatus::PendingDeletion, Some(due), None)),
            true,
        ),
    ];

    let positives = cases.iter().filter(|c| c.2).count();
    assert_eq!(
        positives, 2,
        "[m22s3/cascade-table-shape] this table must declare EXACTLY TWO cascading rows — \
         the one combination that cascades, and its claim-provenance twin, which must agree \
         with it; it declares {positives}. The table is the specification here, so a table \
         that lost a positive row would pass against a predicate mutated to a constant false \
         and report that PRV1-5 is proven."
    );

    for (label, account, expected) in cases {
        assert_eq!(
            reaper_should_run_cascade(&account, NOW_MS),
            expected,
            "[m22s3/cascade-table] reaper_should_run_cascade disagreed on {label:?}. The \
             rule is the CONJUNCTION of three independent conjuncts: status is \
             PendingDeletion, `terminal_at_ms` is still None, and the request is past its \
             grace window. Dropping the status conjunct erases a live account; dropping the \
             terminal conjunct runs a SECOND cascade over an account that was already \
             erased; dropping the due-ness conjunct erases inside the grace window the \
             player was promised. A no-op here is free and an erasure is not, so every \
             illegal combination must answer false too."
        );
    }
}

/// PRV1-5 (pure, boundary + saturation): the grace window is boundary-INCLUSIVE,
/// a future-dated request is never due, and the arithmetic SATURATES.
///
/// SATURATION IS A PRODUCTION CRASH PROPERTY, not a curiosity: the workspace sets
/// `[profile.release] overflow-checks = true`, so a wrapping subtraction inside
/// the reaper panics, and a panic in a scheduled reducer aborts that whole
/// transaction on every single fire. The two extreme pairs below are the ones a
/// non-saturating subtraction cannot survive.
///
/// Kills: a strict `>` boundary (the exact-boundary row flips, and every player
///        waits one extra tick); an absolute `now >= GRACE` test that ignores the
///        request instant (the future-dated row flips, and so does row 8 of the
///        table above); a plain `-` in place of `saturating_sub` (the extreme
///        pairs panic in a debug build and in release).
#[test]
fn m22s3_reaper_should_run_cascade_grace_boundary() {
    let requested: i64 = 1_700_000_000_000;
    let pending = |stamp: Option<i64>| Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: stamp,
        ..base_account(4)
    };

    assert!(
        reaper_should_run_cascade(
            &pending(Some(requested)),
            requested + DELETION_GRACE_MS_DEFAULT
        ),
        "[m22s3/grace-boundary-inclusive] at EXACTLY `requested + DELETION_GRACE_MS_DEFAULT` \
         the request is due and the cascade must run. The repo convention for every cooldown \
         and staleness test is boundary-inclusive; a strict comparison here silently adds one \
         scheduler tick to every deletion and makes the reaper fire time and the due-ness \
         test disagree by one instant."
    );
    assert!(
        !reaper_should_run_cascade(
            &pending(Some(requested)),
            requested + DELETION_GRACE_MS_DEFAULT - 1
        ),
        "[m22s3/grace-boundary-strict] one millisecond BEFORE the boundary the request is not \
         yet due. This is the clause that makes the grace window real: the window is the \
         players entire opportunity to cancel, and an off-by-one in this direction erases \
         data a millisecond early with no recourse."
    );
    assert!(
        !reaper_should_run_cascade(&pending(Some(requested + 1)), requested),
        "[m22s3/grace-future-dated] a request stamped in the FUTURE relative to `now` (clock \
         skew across a host restart) must read as not due. Elapsed time is measured relative \
         to the request, never as an absolute instant — a request-blind threshold test marks \
         every account due the moment the epoch clock passes the raw number."
    );

    assert!(
        !reaper_should_run_cascade(&pending(Some(i64::MAX)), i64::MAX),
        "[m22s3/grace-saturate-max] `requested == now == i64::MAX` must answer false without \
         panicking. Zero elapsed is not a grace window."
    );
    assert!(
        reaper_should_run_cascade(&pending(Some(i64::MIN)), i64::MAX),
        "[m22s3/grace-saturate-wide] the widest possible elapsed span must CLAMP to i64::MAX \
         and read as due, not overflow. A plain subtraction here panics under \
         `overflow-checks`, and a panic inside a scheduled reducer aborts the transaction on \
         every fire — the deletion would then never complete and the failure would repeat \
         forever."
    );
    assert!(
        !reaper_should_run_cascade(&pending(Some(i64::MAX)), i64::MIN),
        "[m22s3/grace-saturate-negative] the widest possible NEGATIVE span must clamp to \
         i64::MIN and read as not due rather than overflowing into a due answer."
    );
}

// ---------------------------------------------------------------------------
// m22-s3 / PRV1-7 — THE SHARED DELETION-GATE PREDICATE.
// ---------------------------------------------------------------------------

/// PRV1-7 (pure, table-driven): `should_reject_for_deletion` is the DISJUNCTION
/// `status == PendingDeletion || account_has_terminal_marker(&account)`.
///
/// LOCATION IS PART OF THE CONTRACT (ADR-0225): this predicate lives in
/// `accounts.rs` and takes `&Account`. Spec §7.3 reads as if it belonged in
/// game-core; it cannot, because it is the SSOT that `is_pending_deletion`
/// delegates to, and S5 guards.rs must call it rather than re-derive it.
///
/// THE DISJUNCTION MATTERS BOTH WAYS. Row 4 is the illegal Active-plus-marker
/// shape: the status half alone answers false and would let an erased account
/// keep playing, so the marker half is what makes the gate fail-closed. Row 2 is
/// the ordinary grace-window account: the marker half alone answers false and
/// the entire M21 pending-deletion gate would evaporate, so the status half
/// carries the behaviour every existing pin depends on. Neither half is
/// redundant; a mutant that keeps only one is caught by exactly one row.
///
/// This is also the delegation proof for `is_pending_deletion`, which becomes
/// `.is_some_and(|a| should_reject_for_deletion(&a))`: on every LEGAL state a
/// terminal marker implies PendingDeletion, so behaviour is unchanged, and the
/// AUTH-13 guard of `complete_guest_claim` becomes terminal-aware for free.
///
/// Kills: collapsing the disjunction to either conjunct alone (one row each);
///        either constant mutant; a third disjunct added without re-deriving the
///        `is_pending_deletion` delegation; a disjunct that reads claim
///        provenance, `auth_issuer` or `last_login_at_ms` (rows 5 and 6 are the
///        claim-variant twins of rows 1 and 3); a fixture that silently stops
///        being the legal or illegal state its label claims.
#[test]
fn m22s3_should_reject_for_deletion_truth_table() {
    let cases: [(&str, Account, bool, bool); 6] = [
        (
            "LEGAL live account: Active, no terminal marker — gameplay allowed",
            base_account(5),
            false,
            true,
        ),
        (
            "LEGAL grace window: PendingDeletion, no marker — gated",
            Account {
                status: AccountStatus::PendingDeletion,
                deletion_requested_at_ms: Some(10),
                ..base_account(5)
            },
            true,
            true,
        ),
        (
            "LEGAL tombstone: PendingDeletion + marker — gated",
            Account {
                status: AccountStatus::PendingDeletion,
                deletion_requested_at_ms: Some(10),
                terminal_at_ms: Some(20),
                ..base_account(5)
            },
            true,
            true,
        ),
        (
            "ILLEGAL resurrected tombstone: Active + marker — gated, fail-closed",
            Account {
                terminal_at_ms: Some(20),
                ..base_account(5)
            },
            true,
            false,
        ),
        (
            "LEGAL claimed live account: claim provenance must not gate gameplay",
            m22s3_claim_variant(base_account(5)),
            false,
            true,
        ),
        (
            "LEGAL claimed tombstone: claim provenance must not un-gate an erased account",
            m22s3_claim_variant(Account {
                status: AccountStatus::PendingDeletion,
                deletion_requested_at_ms: Some(10),
                terminal_at_ms: Some(20),
                ..base_account(5)
            }),
            true,
            true,
        ),
    ];

    for (label, account, expected, expected_legal) in cases {
        assert_eq!(
            account_state_is_legal(&account),
            expected_legal,
            "[m22s3/gate-fixture] the fixture {label:?} is not the state it claims to be. The \
             fail-closed argument for the marker half is ABOUT the illegal shape, so the row \
             that is supposed to be illegal must actually be one — and the claim twins must \
             actually be legal, or they would prove nothing about a state the system can hold."
        );
        assert_eq!(
            should_reject_for_deletion(&account),
            expected,
            "[m22s3/gate-predicate] should_reject_for_deletion disagreed on {label:?}. It is \
             the explicit disjunction `status == PendingDeletion OR terminal marker present` \
             (spec §4.7). The status half is what every M21 pending-deletion pin depends on; \
             the marker half is what refuses an account whose data is already erased even if \
             its status column says otherwise. Dropping either half is caught by exactly one \
             row of this table; rows 5 and 6 catch a third disjunct that reads claim \
             provenance, `auth_issuer` or `last_login_at_ms` instead."
        );
    }
}

// ---------------------------------------------------------------------------
// m22-s3 / PRV1-4 residual — THE CONSTRUCTOR-LEVEL HALF OF THE TERMINAL GUARD.
// ---------------------------------------------------------------------------

/// PRV1-4 (constructor postcondition): `cancelled_deletion` REFUSES a terminal
/// input — the ADR-0195 D3 legality `debug_assert!` fires rather than returning
/// a resurrected tombstone.
///
/// This is the second half of the residual R-m22-s2-S3-CANCEL-TERMINAL. The W1
/// guard in `cancel_account_deletion` is the first half and is what actually
/// protects production; this test pins the constructor-level backstop that
/// documents WHY the guard has to exist. The input row is LEGAL by construction
/// (`PendingDeletion` + request stamp + marker, spec §4.1) and the OUTPUT is not:
/// `cancelled_deletion` clears the status and the stamp but cannot clear the
/// marker, so it would hand back `Active` + marker — the exact illegal shape
/// `account_state_is_legal` forbids and the exact row the fail-closed marker
/// predicate exists to refuse.
///
/// PROFILE DEPENDENCE, STATED RATHER THAN IMPLIED: `debug_assert!` compiles out
/// of a release build (ADR-0049), so this tooth exists in the test profile only.
/// That is precisely the gap the W1 source guard covers, and the Err-promotion
/// question for release builds is re-pointed to S3b in ADR-0225 — nothing in
/// this slice writes `terminal_at_ms`, so no release-build path can reach here.
///
/// Kills: deleting the legality `debug_assert!` from `cancelled_deletion`; a
///        `cancelled_deletion` widened to also clear `terminal_at_ms`, which
///        would make the panic disappear by silently un-deleting an account.
#[test]
#[should_panic(expected = "cancelled_deletion: illegal Account state")]
fn m22s3_cancelled_deletion_rejects_terminal_input() {
    let terminal = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(500),
        terminal_at_ms: Some(900),
        ..base_account(9)
    };
    // The INPUT is a legal completed-deletion row (spec §4.1). If this clause
    // ever fires it panics with a DIFFERENT message, so the expected-substring
    // match still fails rather than letting the test pass for the wrong reason.
    assert!(
        account_state_is_legal(&terminal),
        "[m22s3/t9-precondition] the fixture must itself be a LEGAL completed-deletion row \
         before the constructor can be asked to refuse it; otherwise this test proves only \
         that an already-illegal straw man is illegal."
    );
    let _ = cancelled_deletion(terminal);
}

// ===========================================================================
// rb-34 (residual R-rb-7-X8-residual; ledger gate X2) — THE GUEST-CLAIM RE-KEY
// DELEGATE IS REACHABLE FROM EXACTLY ONE accounts.rs CALL SITE.
//
// EARS criterion: WHILE the spec para 4.4 cascade (S3b) has not landed, the
// ranking-side re-key delegate `rekey` + `_profile` SHALL be reachable from
// EXACTLY ONE accounts.rs call site, that site SHALL lie inside the claim-flow
// fan-out helper `rekey` + `_all`, AND the fan-out helper itself SHALL have
// exactly one call site, inside the claim-completion reducer — so the deletion
// cascade slot of the reaper, or any other site in this file, cannot reach the
// guest-claim tombstone writer directly, by alias, OR by the one-hop-up route
// through the fan-out helper, without a RED. (The reviewer lens measured the
// one-hop-up route: ADR-0225 itself names the fan-out helper as the cascade's
// delegation precedent, so a lazy cascade calling IT is the invited shape.)
//
// WHY THE DELEGATE AND NOT THE WRITER: the tombstone writer in ranking.rs and
// the sentinel const it writes are BOTH module-private (rb-7, ADR-0211), so
// this delegate is the ONLY crate-visible path from accounts.rs to a rename
// that ALSO zeroes rating, wins and losses. Reached from the cascade slot it
// renames a DELETED account to the sentinel that means an unclaimed guest whose
// ranked stats were carried forward, and zeroes ladder columns the cascade was
// supposed to erase outright: the wrong tombstone, on the wrong subject, in the
// one flow that cannot be undone. M22 has its own deletion sentinel in
// game-core, and the cascade must write that one.
//
// ORTHOGONAL TO THE FROZEN REAPER-BODY PIN, ON PURPOSE.
// `rb24_deletion_reaper_body_is_pinned_cascade` was re-derived when the m22-s3b
// cascade landed, exactly as its own failure message instructed — so the literal
// it pins today is a DIFFERENT literal from the one this section was written
// beside. This tooth is about the DELEGATE rather than the body text, so it
// survived that re-derivation unchanged and is still standing over the shipped
// cascade: the cascade must reach the deletion tombstone in game-core, never the
// guest-claim sentinel this delegate writes.
//
// RATCHET CLASS, BORN GREEN BY DESIGN — the same class as
// `g5_no_wallet_accessor_in_accounts` (:2211),
// `auth19_g5_no_direct_battle_access` (:1729), `g5_writes_only_owned_tables`
// (:2159) and the AUTH-23 never-deletes delegate scan (:1911). HEAD satisfies
// it already; the bite is proven by MUTATION, not by a pre-fix RED.
//
// SCAN HYGIENE — the file header rule, restated because this section adds
// needles for a token a crate-wide census may later count. Every needle is
// assembled from `concat!` fragments and every prose mention is split the same
// way, so this section carries no contiguous delegate token, no contiguous
// qualified call site and no contiguous fn declaration for the dozen evals that
// concatenate every .rs file under server-module/src, _tests.rs siblings
// included. It contains no block comment, no raw string, no apostrophe, no bare
// double-quote character inside a comment, and it never spells the guest-claim
// sentinel VALUE — spelling that value a second time anywhere is what
// `rb7_guest_claim_tombstone_*` in ranking_tests.rs exists to refuse.
// ===========================================================================

/// X2 (scan, whole file + body): accounts.rs NAMES the guest-claim re-key
/// delegate exactly once, that one naming IS the crate-qualified direct call,
/// and it sits inside the claim-flow fan-out helper.
///
/// FIVE CLAUSES, each with its own pinned message — a coarse mutant only ever
/// proves the FIRST assertion, so every later clause needs a surgical mutant
/// pinned by FAILURE MESSAGE:
///   1. the BARE delegate token occurs exactly once in the string-blanked,
///      comment-blanked, whitespace-squashed view of accounts.rs;
///   2. the crate-qualified CALL occurs exactly once, which together with (1)
///      makes that single naming the call and nothing else;
///   3. the fan-out helper is DECLARED exactly once — the anti-decoy clause for
///      the first-hit body extractor;
///   4. the qualified call occurs exactly once INSIDE that declared body;
///   5. the fan-out helper ITSELF is reached from exactly one call site, and
///      that site lies inside the claim-completion reducer — the one-hop-up
///      pin, without which a cascade could skip naming the delegate entirely
///      and call the fan-out helper instead, re-keying the deleted account's
///      rows onto a second identity and MATERIALISING a fresh profile row
///      (stats copied forward) under the guest-claim sentinel.
///
/// ACCEPTED FALSE-RED COST (shared with the rb-22 census at the lines cited
/// below): clause 1's bare token and clause 5's call token carry no right-hand
/// word boundary, so a longer sibling identifier sharing the prefix — a batch
/// variant of the delegate, say — counts too and REDs. That cost is the price
/// of catching the aliasing import, and the remedy on a legitimate hit is the
/// same conscious re-derivation every message below asks for.
///
/// CLAUSE 1 IS THE ALIAS CLAUSE AND IS DELIBERATELY BROADER THAN CLAUSE 2. Its
/// needle is the bare token: no paren, no path prefix, and no word boundary on
/// either side. One needle therefore catches every spelling at once — the
/// qualified call, a call under a plain import, a call through a MODULE alias
/// (`use crate::ranking as r;` and then a call qualified by `r`), an ALIASING
/// import (which must spell the original name once before renaming it), and an
/// fn-pointer or const binding of the path (which names it with no paren at
/// all). Requiring a word boundary on the right would DROP the aliasing import,
/// because `squash_ws` fuses the renaming tail onto the name — the measured
/// hazard the rb-22 census records at :4961.
///
/// Kills: a second call site anywhere in accounts.rs, the MEASURED one being a
///        lazy S3b cascade in the reaper cascade slot that hands the delegate
///        the deleted account identity twice (clause 1, then clause 2);
///        an aliasing import plus a call through the alias (clause 1 alone —
///        clause 2 never sees it);
///        a module-alias import plus a call qualified through that alias
///        (clause 1 alone);
///        an fn-pointer or const binding of the path (clause 1 alone);
///        deletion of the sanctioned call, which takes clause 1 to zero;
///        a decoy second declaration of the fan-out helper, which would steer
///        the first-hit body extractor (clause 3);
///        the call moved OUT of the fan-out helper while both whole-file counts
///        stay at one (clause 4) — that is the deletion-cascade shape exactly;
///        the call moved into a private wrapper the fan-out helper then calls
///        (clause 4, deliberately — see below);
///        the ONE-HOP-UP route — a cascade that never names the delegate and
///        instead calls the fan-out helper with the deleted identity and a
///        tombstone destination (clause 5) — the reviewer-measured shape that
///        passed the first four clauses green.
///
/// Does NOT kill: a NEW wrapper in ranking.rs that reaches the private writer
///        under a different name, nor a re-export of the delegate OR of the
///        fan-out helper from a third module reached through that other path.
///        Neither changes a byte of accounts.rs, so no clause here can see
///        them; both need a crate-wide naming census in the shape of
///        `rb22_purge_named_nowhere_else_in_crate`
///        (:4993), and both are deferred to ledger rb-34 X5 / S3b rather than
///        claimed here.
///        A reentrant call to the claim-completion reducer itself would count
///        under clause 5's reducer-name census below only if spelled; reached
///        some other way it is runtime-guarded — guard 3 rejects a
///        PendingDeletion caller — and is not claimed here.
///        A call textually inside the fan-out helper but INERT (bound to a
///        closure, say) is also outside this gate: NO textual gate owns
///        inertness — the AUTH-21 manifest scan (:1835) is a containment scan
///        that a closure-bound spelling still satisfies; that shape breaks the
///        claim flow itself and is behavioural-test territory.
///
/// THE HELPER-HOP FALSE-RED IS INTENDED RATCHET BEHAVIOUR. Moving the call one
/// level down, into a private helper that the fan-out helper calls, reds clause
/// 4 (and the AUTH-21 manifest scan with it). That indirection is the hazard in
/// miniature: it decouples the one call site from the claim ceremony that
/// reviews it, and leaves the new wrapper one line away from the cascade slot,
/// reachable from there without ever naming the delegate again.
#[test]
fn rb34_guest_claim_rekey_delegate_reachable_only_from_rekey_all() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let bare = concat!("rekey", "_profile");
    let qualified = concat!("crate::ranking::", "rekey", "_profile(");
    let fan_out = concat!("fnrekey", "_all(");

    // --- (1) exactly ONE naming of the delegate, in any spelling -------------
    let named = m22_count_occurrences(&squashed, bare);
    assert_eq!(
        named, 1,
        "[rb34/delegate-naming] accounts.rs must name the guest-claim re-key delegate \
         EXACTLY once; found {named}. That delegate is the only crate-visible path from \
         this module to the module-private writer that renames a profile row to the \
         guest-claim sentinel AND zeroes its ladder stats, so every naming of it is a \
         reachability edge to the WRONG tombstone. The measured hazard is a lazy S3b \
         cascade calling it in the deletion cascade slot of the reaper, which renders a \
         DELETED account as a claimed guest with zeroed rating, wins and losses while the \
         whole CI stays green. AN ALIASING IMPORT AND AN fn-POINTER BINDING TRIP THIS \
         CLAUSE BY DESIGN: both must spell the name once, and neither carries the \
         qualified call shape the next clause counts. ZERO means the claim flow lost its \
         ranked re-key. A genuinely new legitimate call site is SUPPOSED to fire this pin: \
         re-derive it consciously, re-review where the two identity arguments at the new \
         site come from, and update the counts in the SAME change under ledger rb-34 X5 \
         and the S3b cascade requirements."
    );

    // --- (2) that one naming IS the crate-qualified direct call --------------
    let calls = m22_count_occurrences(&squashed, qualified);
    assert_eq!(
        calls, 1,
        "[rb34/delegate-qualified-call] accounts.rs must carry the crate-qualified delegate \
         call EXACTLY once; found {calls}. With the naming census above at one, this clause \
         is what makes the single naming a CALL at the sanctioned path rather than an \
         import, a re-export or a binding — and a second qualified call is a second, \
         unreviewed reach for the guest-claim tombstone writer, from a flow no reviewer of \
         the claim ceremony ever saw: a deleted account rendered as a claimed guest, with \
         its ladder stats zeroed instead of erased. ZERO means the sanctioned call is no \
         longer spelled at the crate-qualified path — an unqualified call under a plain \
         import is the measured shape, and the naming census above is what still sees it. \
         If a new call site is genuinely warranted, re-derive this pin and its counts \
         consciously in the same change, under ledger rb-34 X5 and the S3b cascade \
         requirements."
    );

    // --- (3) the fan-out helper is declared exactly once (anti-decoy) --------
    let decls = m22_count_occurrences(&squashed, fan_out);
    assert_eq!(
        decls, 1,
        "[rb34/fanout-decl-unique] accounts.rs must declare the claim-flow fan-out helper \
         EXACTLY once; found {decls}. The body extractor below anchors on the FIRST hit, so \
         a second declaration — an inner-module twin, say — silently re-points the call-site \
         clause at a body nobody reviewed, while both counts above stay at one. Count, \
         never index: a first-hit anchor is forgeable by a decoy. ZERO means the helper was \
         renamed or deleted; re-derive this needle, the call-site clause below, and the \
         AUTH-21 manifest scan's twin needle in the same conscious change."
    );

    // --- (4) and the one call lives INSIDE that declared body ----------------
    let body = extract_squashed_fn_body(&squashed, fan_out)
        .expect("[rb34/fanout-scope] the claim fan-out helper was not found in accounts.rs");
    let inside = m22_count_occurrences(body, qualified);
    assert_eq!(
        inside, 1,
        "[rb34/call-site-inside-fanout] the qualified delegate call must sit inside the \
         claim-flow fan-out helper EXACTLY once; found {inside}. ZERO is the shape that \
         matters: the one qualified call counted above then lives SOMEWHERE ELSE in \
         accounts.rs — the deletion cascade slot of the grace reaper being the measured one \
         — where it renames a DELETED account to the guest-claim sentinel and zeroes the \
         ladder stats the cascade was supposed to erase outright. A hop through a private \
         wrapper that the fan-out helper then calls reds here too, deliberately: the \
         indirection decouples the one call site from the claim ceremony that reviews it, \
         and leaves that wrapper one line away from the cascade slot. If S3b is landing a \
         legitimately new site, re-derive this pin and its counts consciously in the same \
         change, with a fresh review of where the identity arguments come from (ledger \
         rb-34 X5)."
    );

    // --- (5) the fan-out helper itself: one call site, in the claim reducer --
    // Reviewer-measured one-hop-up route: with only clauses 1-4, a cascade
    // calling the fan-out helper (never naming the delegate) re-keys the
    // deleted account's rows onto a second identity and MATERIALISES a fresh
    // profile row under the guest-claim sentinel — stats copied forward by the
    // delegate's own get-or-init — while every count above stays at one.
    let fan_out_call = concat!("rekey", "_all(");
    let claim_reducer_decl = concat!("fncomplete", "_guest", "_claim(");
    let claim_reducer_name = concat!("complete", "_guest", "_claim(");
    let fan_out_sites = m22_count_occurrences(&squashed, fan_out_call);
    assert_eq!(
        fan_out_sites, 2,
        "[rb34/fanout-single-caller] the claim fan-out helper must appear at EXACTLY two \
         sites in accounts.rs — its declaration and its one sanctioned call in the \
         claim-completion reducer; found {fan_out_sites}. A THIRD site is the one-hop-up \
         route to the guest-claim tombstone writer that never names the delegate: the \
         measured shape is the deletion cascade calling the fan-out helper with the deleted \
         identity and a tombstone destination, which re-keys every table onto the tombstone \
         identity and inserts a fresh profile row carrying the deleted account's ladder \
         stats under the guest-claim sentinel. ONE means the sanctioned claim-flow call was \
         deleted; the claim ceremony lost its re-key. A genuinely new legitimate caller must \
         re-derive this pin consciously (ledger rb-34 X5 / the S3b cascade requirements)."
    );
    let reducer_decls = m22_count_occurrences(&squashed, claim_reducer_decl);
    assert_eq!(
        reducer_decls, 1,
        "[rb34/claim-reducer-decl-unique] accounts.rs must declare the claim-completion \
         reducer EXACTLY once; found {reducer_decls}. The body extractor below anchors on \
         the FIRST hit — a decoy twin re-points the caller-site clause at an unreviewed \
         body. ZERO means the reducer was renamed; re-derive this needle in the same change."
    );
    let reducer_namings = m22_count_occurrences(&squashed, claim_reducer_name);
    assert_eq!(
        reducer_namings, 1,
        "[rb34/claim-reducer-never-called-here] the claim-completion reducer's name must \
         occur EXACTLY once in accounts.rs — its own declaration; found {reducer_namings}. \
         A second spelling is an internal reentrant call, which would reach the delegate \
         through the whole claim ceremony from a flow that was never reviewed for it. \
         (Runtime guard 3 also rejects a PendingDeletion caller, but this pin fires at \
         test time, not after a deploy.)"
    );
    let claim_body = extract_squashed_fn_body(&squashed, claim_reducer_decl).expect(
        "[rb34/claim-reducer-scope] the claim-completion reducer was not found in accounts.rs",
    );
    let fan_out_in_claim = m22_count_occurrences(claim_body, fan_out_call);
    assert_eq!(
        fan_out_in_claim, 1,
        "[rb34/fanout-call-inside-claim-reducer] the fan-out helper's one sanctioned call \
         must sit inside the claim-completion reducer EXACTLY once; found \
         {fan_out_in_claim}. ZERO with the site census above still at two means the call \
         moved to another flow — the deletion cascade being the measured hazard — where it \
         re-keys a deleted account's rows instead of a claimed guest's. Re-derive \
         consciously (ledger rb-34 X5)."
    );
}

// ===========================================================================
// m22-s3b (ADR-0228) — THE SPEC PARA-4.4 CASCADE: DELEGATED ERASE/ANONYMIZE,
// THE ONE-SHOT RE-ARM, AND PRV1-8(b) FRESH RE-REGISTRATION.
//
// EARS criteria (`specs/monster-realm-v2/M22-privacy-compliance.spec.md` §7.4):
//   PRV1-6a  force-resolve every live interaction via
//            `resolve_all_live_interactions` BEFORE any row is erased.
//   PRV1-6b  delete every ERASE-policy row owned by the identity.
//   PRV1-6c  overwrite every ANONYMIZE-policy row's identity/PII fields with
//            the tombstone constants, leaving PK and mechanical fields intact.
//   PRV1-6d  delete every JOIN_ONLY row reachable via its pinned parent join.
//   PRV1-6e  stamp `terminal_at_ms` ONLY after 6a..6d complete, and never
//            otherwise.
//   PRV1-19  a practice battle (player_identity == opponent_identity) is
//            visited and tombstoned EXACTLY ONCE, not twice.
//   PRV1-8(b) a terminal identity re-registering is RESET to `new_account_row`
//            defaults with NO pre-deletion value carried forward.
//
// SCOPE SPLIT, restated because it decides the shape of every test below: there
// is no way to construct a `ReducerContext` in this crate, so every rule that
// can be a pure seam IS one and is EXECUTED; the residue that exists only as
// wiring inside a reducer body — placement, ordering, delegation — is pinned by
// source scan. ADR-0228 records that justification once.
//
// SCAN HYGIENE — the file header rule, restated because this section adds
// needles for a file a dozen unmigrated evals concatenate wholesale (every
// `.rs` under `server-module/src`, `_tests.rs` siblings included). Every needle
// below is assembled from `concat!` fragments, so this file never carries a
// contiguous cascade call site, accessor chain or reducer declaration that such
// a scanner could count as a real one. This section contains no block comment,
// no raw string, no apostrophe and no bare double-quote character inside any
// comment.
// ===========================================================================

/// The squashed declaration needle for the ADR-0221 R2 init/sync sweep.
fn m22s3b_nd_ensure_decl() -> String {
    concat!("fnensure_deletion_reapers", "_armed(").to_string()
}

/// The squashed call needle for that sweep, as `init` and `sync_content` spell
/// it (the body lives in accounts.rs because the sole-writer teeth close the
/// schedule table to every other module — ADR-0228 D3b).
fn m22s3b_nd_ensure_call() -> String {
    concat!("accounts::ensure_deletion_reapers", "_armed(").to_string()
}

/// PRV1-8(b) — the terminal-reset match arm of `provision_or_touch_account`,
/// squashed. The MARKER HALF keys the guard, not spec para 4.1's conjunction:
/// on the illegal Active-plus-marker shape a fresh reset is the fail-closed
/// direction (ADR-0228 D4).
fn m22s3b_nd_terminal_reset_arm() -> String {
    concat!(
        "Some(existing)ifaccount_has_terminal",
        "_marker(&existing)=>{"
    )
    .to_string()
}

/// ADR-0228 D6 — the WHOLE Guard 3a statement of `complete_guest_claim`, with
/// its reducer tag INTACT (the strings-KEPT view).
///
/// `stripped_for_scan` BLANKS string literals, so the blanked needle matches
/// whatever reducer tag the guard passes — and since the cancel-side PRV1-4
/// guard is byte-identical once blanked, the blanked view alone cannot tell the
/// two apart at all. Matching this needle in `stripped_keep_strings` output pins
/// the tag AND its adjacency to the guard in one contiguous substring.
fn m22s3b_nd_claim_terminal_guard_tagged() -> String {
    let q = m22s3_dq();
    [
        "if".to_string(),
        m22s3_nd_marker_call(),
        concat!("{returnrej", "ect(").to_string(),
        format!("{q}{}{q}", concat!("complete_guest", "_claim")),
        concat!(",me,REJECT_ALREADY", "_DELETED);}").to_string(),
    ]
    .concat()
}

/// The inner `(start, end)` byte span of the brace block that OPENS at or after
/// `from` in an ALREADY-SQUASHED source. Fails LOUD: a span-scoped clause whose
/// span could not be read must not report a pass.
fn m22s3b_block_span(squashed: &str, from: usize) -> (usize, usize) {
    let rel = squashed[from..].find('{').unwrap_or_else(|| {
        panic!("[m22s3b/span] no opening brace at or after squashed offset {from}.")
    });
    let open = from + rel;
    let bytes = squashed.as_bytes();
    let mut depth: usize = 0;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return (open + 1, i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    panic!("[m22s3b/span] the block opened at squashed offset {open} is not brace-balanced.")
}

/// A LEGAL mid-grace account: `PendingDeletion` with a request stamp and no
/// terminal marker — the one state the cascade is reachable from, and therefore
/// the only input `anonymized_account` / `terminal_account` are ever handed in
/// production. Off-baseline `auth_issuer` and `last_login_at_ms` on purpose:
/// a constructor that silently reset either would be invisible against a fixture
/// that carried the baseline values.
fn m22s3b_mid_grace(b: u8, requested: i64) -> Account {
    Account {
        auth_issuer: "issuer-before-deletion".to_string(),
        created_at_ms: 111,
        last_login_at_ms: 222,
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(requested),
        ..base_account(b)
    }
}

// ---------------------------------------------------------------------------
// m22-s3b / PRV1-6c + PRV1-6e — THE TWO ACCOUNT CONSTRUCTORS (pure).
// ---------------------------------------------------------------------------

/// PRV1-6c (pure): `anonymized_account` overwrites `auth_issuer` with the
/// game-core tombstone sentinel and changes NOTHING else.
///
/// Spec §3 is explicit that the sentinel is a String, never a widening to
/// `Option<String>`, and that `identity` / `created_at_ms` / `claimed_from` /
/// `claimed_at_ms` are RETAINED (AUTH-29's invariant: a cancel-provenance chain
/// must never read as un-claimed). So this constructor is a one-field rewrite
/// and every other field is asserted individually — a whole-struct compare would
/// name only the first divergence.
///
/// THE SENTINEL IS READ FROM game-core, NEVER RE-TYPED. `game_core::
/// TOMBSTONE_AUTH_ISSUER` is the SSOT; a hand-typed literal here would pass
/// against a hand-typed literal there and prove nothing about the pair.
///
/// Kills: an implementation that clears `auth_issuer` to the empty string (which
///        the manifest basis explicitly rejects — the field must stay
///        distinguishable from an unset one); one that also stamps
///        `terminal_at_ms` (which would make the 6e step unobservable and put
///        the terminal write outside the one place ADR-0228 D5's legality
///        theorem covers); one that clears the claim provenance (AUTH-29); one
///        that resets `status` (the recheck has already established
///        PendingDeletion and the legality theorem depends on it); an identity
///        function (the sentinel assertion fires).
#[test]
fn m22s3b_anonymized_account_truth() {
    let before = m22s3b_mid_grace(21, 1_700_000_000_000);
    assert!(
        account_state_is_legal(&before),
        "[m22s3b/anon-fixture] the mid-grace fixture must itself be a LEGAL account state \
         before the constructor can be asked to preserve it — otherwise this test proves \
         only that an already-illegal straw man stays illegal."
    );
    let after = anonymized_account(before.clone());

    assert_eq!(
        after.auth_issuer,
        game_core::TOMBSTONE_AUTH_ISSUER,
        "[m22s3b/anon-issuer] PRV1-6c: `auth_issuer` must become \
         `game_core::TOMBSTONE_AUTH_ISSUER`. Spec §3 makes this the ONE sanctioned update to \
         a column whose own doc comment used to read `never updated after insert`, and it is \
         a SENTINEL rather than a null so the column type stays unchanged. Read from \
         game-core rather than re-typed here: a literal on both sides would agree with \
         itself forever."
    );
    assert_ne!(
        after.auth_issuer, before.auth_issuer,
        "[m22s3b/anon-issuer-moved] the constructor returned the caller's own issuer. An \
         identity function satisfies every preservation clause below and leaves the deleted \
         account still recording which OAuth provider the person signed in with."
    );

    assert_eq!(
        after.identity, before.identity,
        "[m22s3b/anon-identity] the primary key is RETAINED — spec §3 lists `identity` among \
         the retained columns, and every surviving multi-user row still points at it."
    );
    assert_eq!(
        after.created_at_ms, before.created_at_ms,
        "[m22s3b/anon-created] `created_at_ms` is retained (spec §3)."
    );
    assert_eq!(
        after.last_login_at_ms, before.last_login_at_ms,
        "[m22s3b/anon-last-login] `last_login_at_ms` is retained — ADR-0228 records that \
         retention as a NAMED deletion-completeness limitation rather than scrubbing a column \
         the shipped manifest basis does not list."
    );
    assert_eq!(
        after.status, before.status,
        "[m22s3b/anon-status] `status` must NOT move. ADR-0228 D5's legality theorem is \
         exactly `reaper_should_run_cascade` established PendingDeletion, and neither \
         constructor touches status, the request stamp or the claim pair — so legality holds \
         by field-disjointness. A constructor that resets status breaks the theorem and the \
         debug_assert that encodes it."
    );
    assert_eq!(
        after.deletion_requested_at_ms, before.deletion_requested_at_ms,
        "[m22s3b/anon-request-stamp] the request stamp is retained: it is half of the spec \
         §4.1 terminal predicate and the input to every re-arm decision."
    );
    assert_eq!(
        after.claimed_from, before.claimed_from,
        "[m22s3b/anon-claimed-from] claim provenance is RETAINED (AUTH-29 / spec §3): a \
         deleted account that reads as never-claimed would let the same guest identity fund \
         a second claim."
    );
    assert_eq!(
        after.claimed_at_ms, before.claimed_at_ms,
        "[m22s3b/anon-claimed-at] the other half of the claim pair is retained too — the two \
         are set together or not at all, and `account_state_is_legal` enforces the pairing."
    );
    assert_eq!(
        after.terminal_at_ms, before.terminal_at_ms,
        "[m22s3b/anon-not-terminal] `anonymized_account` must NOT stamp the terminal marker. \
         PRV1-6e says the stamp happens only after 6a-6d complete, and the cascade composes \
         `terminal_account(anonymized_account(account), now)` so the stamp is one, named, \
         reviewable step. Stamping here makes that step invisible."
    );
    assert!(
        account_state_is_legal(&after),
        "[m22s3b/anon-legal] the anonymized row must remain a LEGAL account state. This is \
         the pure half of ADR-0228 D5: the constructor carries the same debug_assert as its \
         siblings, and debug_assert compiles out of release, so the property is asserted here \
         where it exists in every profile."
    );

    // Claim-variant twin: the constructor must not read the claim pair or the
    // login stamp (the fixture-monoculture hole this file records at :6675).
    let claimed = m22s3_claim_variant(m22s3b_mid_grace(22, 1_700_000_000_000));
    assert!(
        account_state_is_legal(&claimed),
        "[m22s3b/anon-twin-fixture] the claim-variant twin must itself be legal."
    );
    let claimed_after = anonymized_account(claimed.clone());
    assert_eq!(
        claimed_after.auth_issuer,
        game_core::TOMBSTONE_AUTH_ISSUER,
        "[m22s3b/anon-twin] a CLAIMED account must be anonymized identically. Every other \
         fixture in this test spreads the same base row, so a constructor that also branched \
         on claim provenance would answer the same thing everywhere and be invisible without \
         this twin."
    );
    assert_eq!(
        claimed_after.claimed_from, claimed.claimed_from,
        "[m22s3b/anon-twin-provenance] the twin's claim provenance survives too."
    );
}

/// PRV1-6e (pure): `terminal_account` stamps `terminal_at_ms = Some(now)` and
/// changes NOTHING else.
///
/// The marker is the whole M22 terminal state: spec §4.1 defines terminal as
/// `status == PendingDeletion && terminal_at_ms.is_some()`, every guard shipped
/// in m22-s3 keys on it, and this constructor is the only writer.
///
/// Kills: a constructor that also flips `status` (which would make the terminal
///        predicate unrepresentable and fire the legality debug_assert); one
///        that clears `deletion_requested_at_ms` (same — the marker implies a
///        request behind it); one that stamps a constant or a re-read clock
///        instead of the `now` it was handed (the cascade passes the SAME `now`
///        the recheck used, so a second clock read would put the stamp at an
///        instant nothing else in the transaction agrees with); one that also
///        anonymizes (which would make the two steps inseparable and let the
///        composition be written in either order).
#[test]
fn m22s3b_terminal_account_truth() {
    let before = anonymized_account(m22s3b_mid_grace(23, 1_700_000_000_000));
    assert!(
        before.terminal_at_ms.is_none(),
        "[m22s3b/terminal-fixture] the input must carry NO marker yet, or the stamp \
         assertion below would be about a row that was already terminal."
    );
    assert!(
        account_state_is_legal(&before),
        "[m22s3b/terminal-fixture-legal] the input must be a legal mid-grace row: the \
         constructor's own debug_assert is about the OUTPUT, and an illegal input would make \
         this test a claim about a state the system cannot hold."
    );

    let now: i64 = 1_900_000_000_000;
    let after = terminal_account(before.clone(), now);

    assert_eq!(
        after.terminal_at_ms,
        Some(now),
        "[m22s3b/terminal-stamp] PRV1-6e: `terminal_at_ms` must become EXACTLY `Some(now)` — \
         the instant the caller passed, not one this constructor read for itself. The reaper \
         hands it the SAME `now` the PRV1-5 recheck used, so a second clock read here would \
         record a completion instant that disagrees with the due-ness decision that \
         authorised it."
    );
    assert_eq!(
        after.status, before.status,
        "[m22s3b/terminal-status] `status` must NOT move. Spec §4.1 declines a third \
         AccountStatus variant precisely so the terminal state is `PendingDeletion` PLUS the \
         marker; flipping status here makes the terminal predicate unsatisfiable and every \
         shipped terminal guard dead."
    );
    assert_eq!(
        after.deletion_requested_at_ms, before.deletion_requested_at_ms,
        "[m22s3b/terminal-request-stamp] the request stamp must survive: \
         `account_state_is_legal` requires a marker to imply BOTH PendingDeletion and a \
         request behind it, so clearing it here produces the resurrected-tombstone shape the \
         invariant exists to forbid."
    );
    assert_eq!(
        after.auth_issuer, before.auth_issuer,
        "[m22s3b/terminal-issuer] this constructor must not touch `auth_issuer`. The cascade \
         composes the two as `terminal_account(anonymized_account(account), now)`; folding \
         the anonymize in here would make the composition order unobservable and leave the \
         reaper body pin unable to tell one step from two."
    );
    assert_eq!(
        after.identity, before.identity,
        "[m22s3b/terminal-identity] the primary key is unchanged."
    );
    assert_eq!(
        after.created_at_ms, before.created_at_ms,
        "[m22s3b/terminal-created] `created_at_ms` is unchanged."
    );
    assert_eq!(
        after.last_login_at_ms, before.last_login_at_ms,
        "[m22s3b/terminal-last-login] `last_login_at_ms` is unchanged."
    );
    assert_eq!(
        after.claimed_from, before.claimed_from,
        "[m22s3b/terminal-claimed-from] claim provenance is unchanged (AUTH-29)."
    );
    assert_eq!(
        after.claimed_at_ms, before.claimed_at_ms,
        "[m22s3b/terminal-claimed-at] the other half of the claim pair is unchanged."
    );
    assert!(
        account_state_is_legal(&after),
        "[m22s3b/terminal-legal] the completed-deletion row must be LEGAL: PendingDeletion + \
         a request stamp + a marker is exactly the state spec §4.1 defines and T8 already \
         pins as legal. This is the assertion ADR-0228 D5 calls a theorem, made checkable in \
         every profile rather than only where debug_assert survives."
    );
    assert!(
        account_has_terminal_marker(&after),
        "[m22s3b/terminal-marker-visible] the shipped marker predicate must SEE the stamp \
         this constructor wrote. Without this clause the two could drift — a stamp written \
         into some other column would satisfy every field assertion above while every \
         terminal guard in the module keeps waving the row through."
    );
    assert!(
        should_reject_for_deletion(&after),
        "[m22s3b/terminal-gated] the completed-deletion row must be refused by the spec §4.7 \
         gate. This is the end-to-end consequence of the stamp and the reason it is the LAST \
         step: from this instant the account can open no new commitment."
    );
}

// ---------------------------------------------------------------------------
// m22-s3b / PRV1-5 — THE RE-ARM DECISION, AS A PURE SEAM.
// ---------------------------------------------------------------------------

/// PRV1-5 (pure, table-driven): `reaper_rearm_at_ms` returns `Some(requested)`
/// for EXACTLY the not-yet-due mid-grace row, and `None` for everything else.
///
/// DEFINED DIRECTLY, NEVER AS `!reaper_should_run_cascade` (ADR-0228 D3). That
/// negation is ALSO true for an `Active` row and for an already-terminal row, so
/// a re-arm keyed on it would re-arm a cancelled account forever and would
/// re-arm an ERASED one — a permanent scheduler loop over a row the cascade has
/// already finished with. Rows 1-6 and 10-12 are what make that distinction
/// observable.
///
/// THE `None` REQUEST ROW IS THE B3 ROW AND IS NOT DECORATION. `PendingDeletion`
/// with no request stamp is an ILLEGAL intermediate (`account_state_is_legal`
/// forbids it) that a bug elsewhere could still produce. The sanctioned
/// implementation resolves the stamp FIRST — `let requested =
/// account.deletion_requested_at_ms?;` — and therefore answers `None`: no
/// re-arm, fail-closed. Every `.unwrap_or(..)` spelling is either a disguised
/// `now`-relative re-arm or an epoch-past hot loop, and both pass a table that
/// omits this row.
///
/// THE VALUE IS THE ROW'S OWN REQUEST STAMP, never `now`. `arm_deletion_reaper`
/// derives the fire instant through `deletion_fire_at_ms`, so returning `now`
/// here would silently grant a fresh full grace window on every fire and a
/// player who never cancels would never be deleted. The positive rows assert the
/// returned value by equality, not merely by is_some().
///
/// Kills: composing over `reaper_should_run_cascade` (rows 1-6 and 10-12 flip);
///        returning `Some(now)` or `Some(now + GRACE)` (the value assertions);
///        `.unwrap_or(0)` on a missing stamp (row 13 flips to `Some`);
///        dropping the terminal conjunct (rows 10-12 flip, re-arming an erased
///        account forever); dropping the due-ness conjunct (row 9 flips, so a
///        due account is re-armed instead of cascaded and the deletion never
///        completes); a predicate that also reads claim provenance,
///        `auth_issuer` or `last_login_at_ms` (rows 14 and 15 are the
///        claim-variant twins of rows 8 and 9); either constant mutant.
#[test]
fn m22s3b_reaper_rearm_at_ms_truth_table() {
    const NOW_MS: i64 = 1_900_000_000_000;
    let due = NOW_MS - DELETION_GRACE_MS_DEFAULT;
    let not_due = NOW_MS - DELETION_GRACE_MS_DEFAULT + 1;

    let row = |status: AccountStatus, requested: Option<i64>, terminal: Option<i64>| Account {
        status,
        deletion_requested_at_ms: requested,
        terminal_at_ms: terminal,
        ..base_account(31)
    };

    // (label, row, expected re-arm instant, expected legality)
    //
    // SIXTEEN rows as of r2: the reviewer asked for the FUTURE-STAMP row (a
    // request dated after `now`, which host clock skew across a restart can
    // genuinely produce). It is the one shape where the two ways of writing the
    // due-ness test disagree, so it belongs in the table rather than only in the
    // loop-freedom property below.
    let cases: [(&str, Account, Option<i64>, bool); 16] = [
        (
            "Active / no marker / no request — an ordinary live account",
            row(AccountStatus::Active, None, None),
            None,
            true,
        ),
        (
            "Active / no marker / request inside the window (ILLEGAL: a cancel clears \
             the stamp, so Active with a stamp cannot happen)",
            row(AccountStatus::Active, Some(not_due), None),
            None,
            false,
        ),
        (
            "Active / no marker / request past the window (ILLEGAL, same shape)",
            row(AccountStatus::Active, Some(due), None),
            None,
            false,
        ),
        (
            "Active / marker / no request (ILLEGAL resurrected tombstone)",
            row(AccountStatus::Active, None, Some(900)),
            None,
            false,
        ),
        (
            "Active / marker / request inside the window (ILLEGAL)",
            row(AccountStatus::Active, Some(not_due), Some(900)),
            None,
            false,
        ),
        (
            "Active / marker / request past the window (ILLEGAL)",
            row(AccountStatus::Active, Some(due), Some(900)),
            None,
            false,
        ),
        (
            "PendingDeletion / no marker / NO request (ILLEGAL intermediate — the B3 \
             row: fail closed, never re-arm off a missing stamp)",
            row(AccountStatus::PendingDeletion, None, None),
            None,
            false,
        ),
        (
            "PendingDeletion / no marker / request inside the window — THE re-arm row",
            row(AccountStatus::PendingDeletion, Some(not_due), None),
            Some(not_due),
            true,
        ),
        (
            "PendingDeletion / no marker / request past the window — cascade, do NOT \
             re-arm",
            row(AccountStatus::PendingDeletion, Some(due), None),
            None,
            true,
        ),
        (
            "PendingDeletion / marker / no request (ILLEGAL)",
            row(AccountStatus::PendingDeletion, None, Some(900)),
            None,
            false,
        ),
        (
            "PendingDeletion / marker / request inside the window — already erased, \
             never re-arm",
            row(AccountStatus::PendingDeletion, Some(not_due), Some(900)),
            None,
            true,
        ),
        (
            "PendingDeletion / marker / request past the window — already erased",
            row(AccountStatus::PendingDeletion, Some(due), Some(900)),
            None,
            true,
        ),
        (
            "PendingDeletion / no marker / request EXACTLY at the boundary — due, so \
             the cascade runs and nothing is re-armed",
            row(
                AccountStatus::PendingDeletion,
                Some(NOW_MS - DELETION_GRACE_MS_DEFAULT),
                None,
            ),
            None,
            true,
        ),
        (
            "CLAIM TWIN of row 8: claim provenance must not change the re-arm instant",
            m22s3_claim_variant(row(AccountStatus::PendingDeletion, Some(not_due), None)),
            Some(not_due),
            true,
        ),
        (
            "CLAIM TWIN of row 9: claim provenance must not exempt a due row from the \
             cascade by re-arming it instead",
            m22s3_claim_variant(row(AccountStatus::PendingDeletion, Some(due), None)),
            None,
            true,
        ),
        (
            "PendingDeletion / no marker / request stamped in the FUTURE (host clock \
             skew across a restart) — not due, so re-arm at the row's OWN future stamp",
            row(
                AccountStatus::PendingDeletion,
                Some(NOW_MS + DELETION_GRACE_MS_DEFAULT),
                None,
            ),
            Some(NOW_MS + DELETION_GRACE_MS_DEFAULT),
            true,
        ),
    ];

    let positives = cases.iter().filter(|c| c.2.is_some()).count();
    assert_eq!(
        positives, 3,
        "[m22s3b/rearm-table-shape] this table must declare EXACTLY THREE re-arming rows — \
         the not-yet-due mid-grace combination, its claim-provenance twin, and the \
         future-dated stamp; it declares {positives}. The table IS the specification here, so \
         a table that lost its positive rows would pass against a seam mutated to constant \
         `None` and report that the re-arm obligation is discharged. \
         WHY THE FUTURE ROW EARNS ITS PLACE (reviewer minor, added in r2): a request stamped \
         AFTER `now` is reachable — `now_ms(ctx)` is the host's injected clock and a restart \
         can move it backwards, which `game_core::is_deletion_due` documents by saturating \
         the subtraction in BOTH directions. It is also the single shape where the two ways \
         of writing due-ness part company: `now - requested >= GRACE` (the SSOT) answers \
         not-due and re-arms, while a request-blind `now >= GRACE` answers DUE and cascades — \
         erasing an account whose grace window has not started, let alone elapsed. Every \
         other row in this table agrees under both spellings, so without this one the \
         request-blind formulation is invisible here and survives on the strength of the \
         loop-freedom property alone."
    );

    for (label, account, expected, expected_legal) in cases {
        assert_eq!(
            account_state_is_legal(&account),
            expected_legal,
            "[m22s3b/rearm-fixture] the fixture {label:?} is not the state it claims to be. \
             The fail-closed argument for the missing-stamp row is ABOUT an illegal shape, so \
             the rows labelled ILLEGAL must actually be illegal and the rest must actually be \
             reachable states."
        );
        assert_eq!(
            reaper_rearm_at_ms(&account, NOW_MS),
            expected,
            "[m22s3b/rearm-table] reaper_rearm_at_ms disagreed on {label:?}. The rule is \
             defined DIRECTLY (ADR-0228 D3): resolve the request stamp FIRST and answer None \
             if it is absent, then `Some(requested)` iff the row is PendingDeletion, carries \
             no terminal marker, and is NOT yet due. It is never `!reaper_should_run_cascade` \
             — that negation is also true for Active and for already-erased rows, so it would \
             re-arm a cancelled account forever and re-arm an erased one into a permanent \
             scheduler loop. The VALUE is the row's own request stamp, never `now`: a \
             now-relative answer grants a fresh grace window on every fire, so a player who \
             never cancels is never deleted."
        );
    }

    // --- LOOP-FREEDOM, over wall-clock-representable stamps ------------------
    // ADR-0228 D3: not-due IFF `deletion_fire_at_ms(requested) > now`, so every
    // re-arm this seam authorises schedules STRICTLY LATER than the fire that
    // produced it. That is what makes the one-shot chain terminate instead of
    // spinning. The saturation band (`requested > i64::MAX - GRACE`) clamps the
    // fire instant to i64::MAX — a permanent no-op, documented in ADR-0221 Known
    // limits and NOT asserted here as a universal theorem, which is why the
    // spread below is bounded to representable wall-clock stamps.
    let clocks: [i64; 4] = [0, 1_700_000_000_000, 1_900_000_000_000, 2_500_000_000_000];
    for now in clocks {
        for delta in [0i64, 1, 1_000, DELETION_GRACE_MS_DEFAULT - 1] {
            let requested = now.saturating_sub(delta);
            let pending = Account {
                status: AccountStatus::PendingDeletion,
                deletion_requested_at_ms: Some(requested),
                terminal_at_ms: None,
                ..base_account(32)
            };
            let answer = reaper_rearm_at_ms(&pending, now);
            if let Some(r) = answer {
                assert!(
                    deletion_fire_at_ms(r) > now,
                    "[m22s3b/rearm-loop-freedom] re-arming a request stamped at {requested} \
                     against clock {now} returned {r}, whose fire instant is \
                     {} — NOT strictly later than now. A re-arm at or before the current \
                     instant fires again immediately and the reaper spins: the same row is \
                     re-read, found not-due (or found due and cascaded twice), and re-armed, \
                     forever. Not-due and `deletion_fire_at_ms(requested) > now` are the SAME \
                     condition by construction, and this property is what holds the two \
                     together.",
                    deletion_fire_at_ms(r)
                );
            }
        }
    }
}

/// ADR-0221 R2 / ADR-0228 D3(b) (pure): `plan_deletion_rearms` emits ONE
/// `(identity, fire instant)` pair per mid-grace row that has NO schedule row
/// yet, skipping Active rows, terminal rows, stamp-less rows and rows already
/// armed — in input order, deterministically.
///
/// WHY THE SWEEP EXISTS AT ALL: the pre-S3b reaper dropped the fired one-shot
/// row on every not-yet-due fire, so the live tree can hold accounts sitting
/// `PendingDeletion` with nothing armed. Nothing else will ever delete them.
///
/// WHY IT IS A PURE SEAM: `ensure_deletion_reapers_armed` takes a
/// `ReducerContext` and cannot be executed here, so the decision — which is the
/// part that can be wrong — is factored out exactly as `plan_schedule_reconcile`
/// is for the zone schedules.
///
/// IDEMPOTENCE IS ASSERTED BY REPLAY, NOT BY INSPECTION: the second call feeds
/// the first call's own output back in as the already-armed set and must emit
/// nothing. A publish runs this on every `sync_content`, so a plan that re-armed
/// an armed row would multiply schedule rows on every deploy and fire one
/// cascade per row.
///
/// THE EMITTED INSTANT IS THE ROW'S RAW `deletion_requested_at_ms`, never `now`
/// and never a pre-shifted fire time. ADR-0228 D3 puts the grace arithmetic in
/// exactly ONE place — `arm_deletion_reaper`, whose frozen body applies
/// `deletion_fire_at_ms` itself — and the sweep's call site is pinned as
/// `arm_deletion_reaper(ctx, identity, requested_at_ms)`. A plan that shifted the
/// stamp here would therefore have it shifted AGAIN downstream, giving the whole
/// overdue population `requested + 2 x GRACE`: a silent double grace window that
/// both pins would have forced while each read correctly alone. A past-due
/// instant is LEGAL (a `ScheduleAt::Time` in the past fires immediately, which is
/// exactly what the overdue R2 population needs), so there is nothing to clamp.
///
/// Kills: a sweep that arms Active rows (row A), terminal rows (row T), rows
///        with no request stamp (row S) or rows that already have a schedule
///        (row D); one that derives the instant from a clock instead of the
///        row's own stamp; one that pre-applies the grace window and so doubles
///        it; one that treats the already-armed list positionally rather than as
///        a set; one that panics on an empty account table (the state `init`
///        runs against); one that emits a row twice; one that is not idempotent
///        under replay; a `HashSet`-ordered output, which would make the write
///        order of a publish nondeterministic.
#[test]
fn m22s3b_plan_deletion_rearms_idempotent() {
    let requested_a: i64 = 1_700_000_000_000;
    let requested_b: i64 = 1_700_000_500_000;

    let active = base_account(41);
    let pending_unarmed_1 = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(requested_a),
        ..base_account(42)
    };
    let pending_already_armed = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(requested_a),
        ..base_account(43)
    };
    let terminal = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(requested_a),
        terminal_at_ms: Some(requested_a + 10),
        ..base_account(44)
    };
    let pending_no_stamp = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: None,
        ..base_account(45)
    };
    let pending_unarmed_2 = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(requested_b),
        ..base_account(46)
    };

    for (label, account, legal) in [
        ("Active", &active, true),
        ("pending unarmed 1", &pending_unarmed_1, true),
        ("pending already armed", &pending_already_armed, true),
        ("terminal", &terminal, true),
        ("pending with no stamp (ILLEGAL)", &pending_no_stamp, false),
        ("pending unarmed 2", &pending_unarmed_2, true),
    ] {
        assert_eq!(
            account_state_is_legal(account),
            legal,
            "[m22s3b/sweep-fixture] the {label} fixture is not the state it claims to be; \
             the skip rules below are ABOUT those states."
        );
    }

    let rows = [
        active,
        pending_unarmed_1,
        pending_already_armed,
        terminal,
        pending_no_stamp,
        pending_unarmed_2,
    ];
    let armed = [ident(43)];

    // --- THE PAIR IS (identity, RAW request stamp) --------------------------
    //
    // CORRECTED IN r2, and the correction is a real contract defect the first
    // draft would have shipped. `arm_deletion_reaper` derives the fire instant
    // ITSELF — its frozen body (`rb24_arm_deletion_reaper_body_frozen`) is
    // `deletion_fire_at_ms(requested_at_ms).saturating_mul(1_000)` — and
    // `[rb24/arm-shape-ensure_deletion_reapers_armed]` pins the sweep's call as
    // `arm_deletion_reaper(ctx, identity, requested_at_ms)`. So a plan that
    // emitted `deletion_fire_at_ms(requested)` would be handing an ALREADY-SHIFTED
    // instant to a helper that shifts it again: `requested + 2 x GRACE` for the
    // whole ADR-0221 R2 population, a silent DOUBLE grace window, and the two
    // pins would have forced it while each read correctly on its own.
    //
    // ADR-0228 D3's rule is that ONE place computes the fire instant, and that
    // place is `arm_deletion_reaper`. Every producer therefore hands it the raw
    // stamp: `reaper_rearm_at_ms` returns `Some(requested)`, and this seam emits
    // the row's own `deletion_requested_at_ms` unchanged.
    let plan = plan_deletion_rearms(&rows, &armed);
    assert_eq!(
        plan,
        vec![(ident(42), requested_a), (ident(46), requested_b)],
        "[m22s3b/sweep-plan] the sweep must emit EXACTLY the two mid-grace rows that have no \
         schedule row yet, each paired with its OWN RAW `deletion_requested_at_ms`, in input \
         order. \
         RAW, NOT `deletion_fire_at_ms(..)`: `arm_deletion_reaper` — the one place ADR-0228 D3 \
         puts that arithmetic — applies the grace window itself, so a pre-shifted value here \
         is applied TWICE and the whole overdue population gets `requested + 2 x GRACE`. That \
         is the same defect as a now-relative answer, reached by a different route: an account \
         that asked to be deleted is silently granted a second full grace window it never \
         asked for, on every publish. \
         Every other row is skipped for its own reason and each is a distinct wrong \
         implementation: an Active row has nothing pending (arming it schedules an erasure \
         nobody requested); a TERMINAL row is already erased (arming it runs a second cascade \
         and re-erases rows another account may since own); a row with NO request stamp is the \
         illegal shape a bug elsewhere produces, and arming it needs an invented instant; and \
         a row that ALREADY has a schedule gets a SECOND one, so a publish multiplies \
         schedule rows and fires one cascade per row. Deriving the instant from a CLOCK \
         instead of the row's stamp is the third way to reach the same place."
    );

    // --- IDEMPOTENCE BY REPLAY ----------------------------------------------
    let now_armed: Vec<Identity> = armed
        .iter()
        .copied()
        .chain(plan.iter().map(|(id, _)| *id))
        .collect();
    let replay = plan_deletion_rearms(&rows, &now_armed);
    assert!(
        replay.is_empty(),
        "[m22s3b/sweep-idempotent] replaying the sweep with its own output folded into the \
         already-armed set must emit NOTHING; it emitted {replay:?}. `sync_content` runs this \
         on every publish, so a sweep that re-arms an already-armed row adds one schedule row \
         per deploy and fires one full cascade per row — and each of those cascades carries \
         two unindexed full-table sweeps (the §8.3 escalated volume residual), multiplied by \
         publish frequency."
    );

    // --- MEMBERSHIP IS A SET TEST, NOT A POSITIONAL ONE (reviewer minor, r2) -
    //
    // The already-armed list comes from a DB read of the schedule table, which
    // can legitimately hold more than one row for an identity (the PRV1-3 disarm
    // deletes every matching row precisely because that is representable). A
    // plan that zipped or indexed the two lists rather than testing membership
    // would answer correctly for the main case above and wrongly here.
    let dup_armed = [ident(43), ident(43), ident(42)];
    let with_dups = plan_deletion_rearms(&rows, &dup_armed);
    assert_eq!(
        with_dups,
        vec![(ident(46), requested_b)],
        "[m22s3b/sweep-armed-is-a-set] with `{dup_armed:?}` already armed the sweep must emit \
         ONLY the one mid-grace row that is not in that set; it emitted {with_dups:?}. The \
         already-armed list is read from the schedule table, where a DUPLICATE entry for one \
         identity is representable — that is why the PRV1-3 disarm collects and deletes EVERY \
         matching row rather than one. A plan that pairs the two lists positionally, or that \
         assumes the armed set is deduplicated, answers correctly for the ordinary case and \
         re-arms an already-armed account here."
    );

    // --- AN EMPTY WORLD IS A NO-OP, NOT A PANIC (reviewer minor, r2) --------
    let no_rows: [Account; 0] = [];
    let empty_plan = plan_deletion_rearms(&no_rows, &armed);
    assert!(
        empty_plan.is_empty(),
        "[m22s3b/sweep-empty-input] a sweep over ZERO accounts must emit nothing and must not \
         panic; it emitted {empty_plan:?}. `init` calls this on a database that has just been \
         created, where the account table is genuinely empty — so this is the FIRST input the \
         seam ever sees in production, not a synthetic edge. An implementation that indexes \
         its input before checking length, or that unwraps a `first()`, fails here and \
         aborts the whole `init` reducer."
    );

    // --- NON-VACUITY --------------------------------------------------------
    let none_armed: [Identity; 0] = [];
    let all = plan_deletion_rearms(&rows, &none_armed);
    assert_eq!(
        all.len(),
        3,
        "[m22s3b/sweep-nonvacuous] with an EMPTY already-armed set the sweep must emit all \
         THREE mid-grace rows (including the one the main case skipped only because it was \
         already armed); it emitted {all:?}. Without this clause a seam mutated to return an \
         empty vector satisfies both assertions above and the whole R2 population stays \
         unarmed forever."
    );
    assert_eq!(
        all[1],
        (ident(43), requested_a),
        "[m22s3b/sweep-order] the emitted order must follow the INPUT order, so the write \
         order of a publish is deterministic. A HashSet-backed plan answers correctly as a \
         SET and reorders between runs, which makes a failure impossible to reproduce. The \
         instant is the RAW request stamp here for the same reason as the main case: \
         `arm_deletion_reaper` owns the grace arithmetic and applies it once."
    );
}

// ---------------------------------------------------------------------------
// m22-s3b / PRV1-6a — THE EXTRACTED RESOLVER (structure, lib.rs).
// ---------------------------------------------------------------------------

/// PRV1-6a (scan): `resolve_all_live_interactions` contains EXACTLY the four
/// `on_disconnect` force-resolve calls, in the shipped order, and performs NO
/// row write of its own.
///
/// SPEC §4.4 STEP 1 IS EMPHATIC ABOUT THE SOURCE OF THE LIST: the bundle is the
/// codebase's OWN `on_disconnect` dispatch, verbatim and in its existing order —
/// never a hazard list rebuilt from the table census, which silently drops
/// `resolve_wild_battle_on_disconnect` because no scheduled reaper covers the
/// wild battle row class. A deleted account's abandoned wild battle would then
/// be soft-locked forever. The spec calls that the single highest-value
/// correction its adversarial pass produced, so the four calls are pinned by
/// name AND by order rather than by count.
///
/// THE NO-WRITE CLAUSE IS WHAT KEEPS THE EXTRACTION HONEST: the resolver is a
/// pure dispatcher over four helpers that each own their own writes. A row write
/// added here is a write in `lib.rs`, outside every owning module's shape pin
/// and outside the cascade's own delegation doctrine.
///
/// Kills: a fifth call added to the bundle without review; any of the four
///        dropped (the count clause); the wild-battle resolve reordered ahead of
///        the PvP forfeit or the challenge cancel (the ordering clauses); an
///        inlined write that bypasses the owning module.
#[test]
fn m22s3b_resolver_body_order() {
    let squashed = stripped_for_scan(LIB_RS);
    let body =
        extract_squashed_fn_body(&squashed, &m22s3b_nd_resolver_decl()).unwrap_or_else(|| {
            panic!(
                "[m22s3b/resolver-scope] fn resolve_all_live_interactions was not found in \
                 lib.rs. Spec §4.4 step 1 factors the four on_disconnect force-resolve calls \
                 into ONE `pub(crate)` helper shared by both callers, so a future fifth \
                 resolver is picked up by the disconnect hook AND by the deletion cascade \
                 automatically. Fail LOUD rather than pass vacuously."
            )
        });

    let ordered = [
        (
            concat!("trading::cancel_trades_on", "_disconnect("),
            "TR-18: cancel every active trade offer, while the offer lookup can still \
             resolve the player identity",
        ),
        (
            concat!("pvp::forfeit_on", "_disconnect("),
            "ADR-0109 D8: forfeit any ongoing PvP battle, while write_back identity lookups \
             still resolve",
        ),
        (
            concat!("battle::resolve_wild_battle_on", "_disconnect("),
            "ADR-0138: auto-flee and GC the wild battle/battle_wild pair — NO scheduled \
             reaper covers that row class, so dropping this call soft-locks the abandoned \
             wild battle forever. This is the call a table-census-derived hazard list loses",
        ),
        (
            concat!("pvp::cancel_challenges_on", "_disconnect("),
            "ADR-0109 D9: cancel pending outgoing challenges",
        ),
    ];

    let mut prev: Option<usize> = None;
    for (needle, why) in ordered {
        let n = m22_count_occurrences(body, needle);
        assert_eq!(
            n, 1,
            "[m22s3b/resolver-call] resolve_all_live_interactions must call `{needle}` \
             EXACTLY once ({why}); found {n}. ZERO drops one whole class of live interaction \
             from BOTH the disconnect hook and the deletion cascade in one edit — which is \
             precisely the leverage the shared extraction buys and precisely why it needs its \
             own pin. MORE THAN ONE is a duplicated force-resolve whose second run acts on \
             rows the first already removed."
        );
        let at = idx(body, needle);
        if let Some(p) = prev {
            assert!(
                p < at,
                "[m22s3b/resolver-order] `{needle}` (offset {at}) is out of the shipped \
                 on_disconnect order (previous call at offset {p}). Spec §4.4 step 1 says the \
                 bundle is that dispatch VERBATIM and in its existing order: the three battle \
                 helpers touch disjoint row classes today, but the order is what a reviewer \
                 diffs the extraction against, and re-ordering it is how a future fifth call \
                 lands in the wrong place."
            );
        }
        prev = Some(at);
    }

    for (verb, what) in [
        (concat!(".ins", "ert("), "insert"),
        (concat!(".upd", "ate("), "update"),
        (concat!(".del", "ete("), "delete"),
    ] {
        assert_eq!(
            m22_count_occurrences(body, verb),
            0,
            "[m22s3b/resolver-no-write] resolve_all_live_interactions performs a direct \
             `{what}` row write. It is a DISPATCHER: each of the four helpers owns its own \
             writes, inside the module whose tests pin their shape. A write added here lives \
             in lib.rs, where no owning-module shape pin can see it, and it runs on EVERY \
             disconnect as well as on every cascade."
        );
    }

    // --- EXACT EQUALITY, LAST (added in r2) ---------------------------------
    //
    // Everything above is a count and an ordering, and a red-team measured that
    // the whole set is satisfiable by a resolver that never resolves: wrap the
    // four calls in `if false { .. }`, or open the body with an unconditional
    // `return;`, or add a guard that skips them for the deletion caller — every
    // needle is still present, every count is still 1, and every offset
    // comparison still holds, while the bundle force-resolves nothing at all and
    // the cascade proceeds to erase rows that live trades and battles still
    // reference. Position clauses are structurally blind to reachability, so the
    // finale is equality: the body IS the four dispatch statements and nothing
    // else. That is also exactly what spec §4.4 step 1 asks for — the
    // `on_disconnect` dispatch, VERBATIM — so the pin and the requirement are the
    // same sentence.
    //
    // The literal is transcribed INDEPENDENTLY of the `ordered` needles above,
    // split at different points, so a silent edit to one artefact cannot move the
    // other with it; the containment clause below is what makes that independence
    // checkable rather than merely asserted in a comment.
    let expected = [
        concat!("trading::cancel_trades_on", "_disconnect(ctx,identity);"),
        concat!("pvp::forfeit_on", "_disconnect(ctx,identity);"),
        concat!(
            "battle::resolve_wild_battle_on",
            "_disconnect(ctx,identity);"
        ),
        concat!("pvp::cancel_challenges_on", "_disconnect(ctx,identity);"),
    ]
    .concat();
    for (needle, _why) in ordered {
        assert!(
            expected.contains(needle),
            "[m22s3b/resolver-literal-independence] the plan needle `{needle}` is not a \
             substring of the frozen resolver literal. The two are transcribed separately and \
             split at different points on purpose, so a mismatch means one artefact was \
             edited alone and the equality below is now asserting something other than the \
             plan."
        );
    }
    assert_eq!(
        body, expected,
        "[m22s3b/resolver-body-exact] the body of `resolve_all_live_interactions` is not \
         EXACTLY the four `on_disconnect` dispatch statements. Spec §4.4 step 1 says the \
         bundle is that dispatch VERBATIM and in its existing order, so equality here is the \
         requirement rather than an extra constraint on it. Every other clause in this test \
         reasons about POSITION or COUNT and is therefore blind to REACHABILITY: an \
         `if false {{ .. }}` wrapper, an early `return;` above the calls, or a caller-keyed \
         guard that skips them for the deletion path keeps all four needles present, all four \
         counts at 1 and every offset comparison true — while the bundle resolves NOTHING and \
         the cascade goes on to erase monsters, wallets and inventories that live trades and \
         ongoing battles still reference. The subject is spelled `identity` at every call \
         because that is this helper's parameter: a local rebinding above the calls would \
         retarget all four at once. If the sanctioned body legitimately changes, re-derive \
         this literal FROM the lib.rs `on_disconnect` dispatch in the same change."
    );
}

/// The squashed declaration needle for the extracted resolver.
fn m22s3b_nd_resolver_decl() -> String {
    concat!("fnresolve_all_live", "_interactions(").to_string()
}

/// PRV1-6b/6c/6d (totality): EVERY table the shipped `DATA_LIFECYCLE_MANIFEST`
/// classifies `Erase`, `Anonymize` or `ViaJoin` is reachable from the reaper
/// body through a NAMED helper, and the table-to-helper map is exhaustive by
/// construction.
///
/// THE MAP IS THE DRIFT SURFACE THIS TEST EXISTS TO CLOSE (ADR-0228, S6
/// `[DEL-04]`). Under delegation the reaper body names HELPERS, not table
/// identifiers, so the spec's original per-table presence check has nothing to
/// match on. The map below restores it: the manifest is walked, every classified
/// entry must appear in the map, and every mapped needle must appear in the
/// reaper's own body. A new owner-keyed table therefore cannot be added without
/// either being classified NotOwned (a conscious decision the basis prose must
/// justify) or being wired into the cascade.
///
/// FAIL-LOUD, NEVER SKIP. The match on `DeletionPolicy` is exhaustive with no
/// wildcard arm, so a new policy variant fails to COMPILE here rather than
/// silently falling through; and a classified table missing from the map PANICS
/// rather than being skipped. Refusing to classify is the safe direction — an
/// unmapped table is an unerased table.
///
/// Kills: dropping any delegated call from the cascade (its mapped needle
///        disappears); adding an owner-keyed table without wiring it (the map
///        lookup panics); a new `DeletionPolicy` variant added without deciding
///        what the cascade does with it (compile error).
#[test]
fn m22s3b_cascade_covers_manifest() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &rb24_nd_reaper_decl())
        .expect("[m22s3b/coverage-scope] fn account_deletion_reaper was not found");

    let erase_monsters = m22s3b_nd_erase_monsters();
    let erase_inventory = m22s3b_nd_erase_inventory();
    let erase_npc = m22s3b_nd_erase_npc_state();
    let erase_heal = m22s3b_nd_erase_heal_cooldown();
    let erase_wallet = m22s3b_nd_erase_wallet();
    let erase_playtest = m22s3b_nd_erase_playtest_events();
    let erase_trades = m22s3b_nd_erase_trade_offers();
    let erase_pvp = m22s3b_nd_erase_pvp_rows();
    let purge_bundles = m22s3b_nd_purge_bundles();
    let erase_character = m22s3b_nd_erase_character_rows();
    let anon_names = m22s3b_nd_anonymize_names();
    let anon_battles = m22s3b_nd_anonymize_battles();
    let anon_account = m22s3b_nd_anonymized_ctor();

    // The hand-maintained table -> reaper-needle map. Every ERASE / ANONYMIZE /
    // VIA-JOIN entry of the live manifest must appear here.
    let map: Vec<(&str, &String)> = vec![
        ("monster", &erase_monsters),
        ("monster_pub", &erase_monsters),
        ("inventory", &erase_inventory),
        ("player_dialogue_state", &erase_npc),
        ("player_quest", &erase_npc),
        ("player_conversation", &erase_npc),
        ("heal_cooldown", &erase_heal),
        (concat!("player", "_wallet"), &erase_wallet),
        ("playtest_event", &erase_playtest),
        ("trade_offer", &erase_trades),
        ("battle_challenge", &erase_pvp),
        ("battle_action", &erase_pvp),
        ("export_bundle", &purge_bundles),
        ("player", &anon_names),
        ("profile", &anon_names),
        ("account", &anon_account),
        ("battle", &anon_battles),
        ("character", &erase_character),
        ("battle_wild", &anon_battles),
        ("pvp_deadline_schedule", &anon_battles),
        ("battle_challenge_reaper_schedule", &erase_pvp),
        ("trade_offer_reaper_schedule", &erase_trades),
    ];

    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;
    let mut classified = 0usize;
    for entry in manifest {
        let table = entry.table;
        // EXHAUSTIVE, no wildcard arm: a new policy variant must decide here
        // what the cascade does with it, as a COMPILE error rather than a skip.
        let needs_cascade = match entry.policy {
            DeletionPolicy::Erase => true,
            DeletionPolicy::Anonymize => true,
            DeletionPolicy::ViaJoin(_) => true,
            DeletionPolicy::NotOwned => false,
        };
        if !needs_cascade {
            continue;
        }
        classified += 1;
        let needle = map
            .iter()
            .find(|(t, _)| *t == table)
            .map(|(_, n)| *n)
            .unwrap_or_else(|| {
                panic!(
                    "[m22s3b/coverage-unmapped] DATA_LIFECYCLE_MANIFEST classifies the table \
                     `{table}` for the cascade, but this test's table-to-helper map does not \
                     name it. Under delegation the reaper body names HELPERS rather than \
                     table identifiers, so this map is the only thing that ties the manifest \
                     to the cascade — and it is a hand-maintained drift surface of the same \
                     class as JOIN_ONLY_TABLES. Fail LOUD rather than skip: an unmapped \
                     classified table is an unerased table. Either wire the table into the \
                     cascade and add its entry here, or classify it NotOwned with a basis \
                     that says why."
                )
            });
        assert!(
            body.contains(needle.as_str()),
            "[m22s3b/coverage-missing] the manifest classifies `{table}` for the cascade, and \
             this map routes it through the reaper call `{needle}` — which the reaper body \
             does NOT contain. Spec §4.4 walks the MANIFEST rather than the schema, so a \
             classified table whose helper is missing from the cascade is simply never \
             erased: the rows survive the deletion silently, and nothing else in the tree \
             looks wrong."
        );
    }

    assert_eq!(
        classified, 22,
        "[m22s3b/coverage-census] {classified} manifest entries were classified for the \
         cascade; EXACTLY 22 is the live partition (13 ERASE + 4 ANONYMIZE + 5 JOIN-ONLY). \
         Tightened from a floor in r2 — a `>=` accepts growth silently, and growth is \
         precisely the event that needs a human: a NEW owner-keyed table classified for the \
         cascade must be routed through this test's hand-maintained table-to-helper map, \
         which is a named drift surface of the same class as `JOIN_ONLY_TABLES` (spec §9 \
         residual 3). FEWER means the walk stopped looking and every clause above is green \
         about tables nobody checked; MORE means a table was classified without anyone \
         deciding which helper erases it. Either way, re-derive this number together with the \
         map and with `data_lifecycle_partition_matches_spec_section3`'s four name-sets, in \
         the same conscious change."
    );
}

/// ADR-0221 R2 / ADR-0228 D3(b) (wiring): the re-arm sweep is DECLARED in
/// `accounts.rs` and CALLED from both lifecycle entry points.
///
/// BOTH CALLERS ARE LOAD-BEARING AND FOR DIFFERENT REASONS. `init` runs once, at
/// database creation, and covers a fresh deployment; `sync_content` runs on
/// every publish and is the ONLY thing that can ever reach the accounts already
/// sitting `PendingDeletion` with a fired-and-dropped one-shot row on a live
/// database. Wiring only `init` looks complete and reaches none of them.
///
/// THE BODY LIVES IN accounts.rs, NOT IN lib.rs: the rb-24 sole-writer teeth
/// close `account_deletion_reaper_schedule` to the two reviewed helpers in that
/// module, so a sweep written in lib.rs could not insert a schedule row without
/// breaking the write isolation the whole delegation doctrine rests on.
///
/// Kills: a sweep declared but never called; a sweep called from `init` only
///        (which reaches no existing overdue account); a sweep whose body was
///        written in lib.rs, outside the module that owns the schedule table.
#[test]
fn m22s3b_ensure_rearm_wiring() {
    let accounts = stripped_for_scan(ACCOUNTS_RS);
    let decl = m22s3b_nd_ensure_decl();
    assert_eq!(
        m22_count_occurrences(&accounts, &decl),
        1,
        "[m22s3b/sweep-decl] accounts.rs must declare `{decl}` EXACTLY once. The body belongs \
         HERE and nowhere else: `rb24_schedule_table_sole_writers` closes the deletion \
         schedule table to the arm and disarm helpers in this module, so a sweep declared in \
         another module cannot arm anything without breaking that census."
    );

    // --- THE SWEEP MUST ACTUALLY SWEEP (added in r2) ------------------------
    //
    // Declaration plus two call sites says the sweep EXISTS and RUNS. It says
    // nothing about it doing anything, and a red-team measured the gap: an
    // `ensure_deletion_reapers_armed` whose body is `let _ = ctx;` — or one that
    // builds an empty account list and loops over it — is declared once, called
    // from both lifecycle hooks, arms nothing, and is invisible to every clause
    // in this test. It is also the WORST place for a silent no-op, because the
    // ADR-0221 R2 population it exists to rescue is exactly the set no other code
    // path will ever re-read: those accounts sit `PendingDeletion` with their
    // one-shot already fired and dropped, and nothing else in the tree looks at
    // them again.
    //
    // Three reads, each irreplaceable: the account table (the candidate rows),
    // the schedule table (which of them are ALREADY armed — without it the sweep
    // double-arms on every publish), and the pure `plan_deletion_rearms` seam
    // that decides between them. The seam call is what keeps
    // `m22s3b_plan_deletion_rearms_idempotent` load-bearing: an inline
    // re-derivation of the same rule in the shell is untested by construction.
    let sweep_body = extract_squashed_fn_body(&accounts, &decl).unwrap_or_else(|| {
        panic!(
            "[m22s3b/sweep-scope-body] the brace-bounded body of `{decl}` could not be sliced \
             out of accounts.rs, so every shape clause below has no scope and would pass \
             vacuously. Fail LOUD."
        )
    });
    for (needle, what, why) in [
        (
            concat!("acc", "ount().iter()"),
            "the candidate-row read",
            "the sweep has to look at the account table to find rows sitting PendingDeletion \
             with nothing armed. Without this read there are no candidates and the helper is \
             a no-op that reads as a fix",
        ),
        (
            concat!("account_deletion_reaper", "_schedule().iter()"),
            "the already-armed read",
            "without it the sweep cannot know which rows already carry a schedule, so it \
             re-arms every mid-grace account on EVERY publish — one extra schedule row per \
             deploy, each firing its own full cascade with two unindexed full-table sweeps \
             (the §8.3 volume residual, multiplied by publish frequency)",
        ),
        (
            concat!("plan_deletion", "_rearms(&"),
            "the pure decision seam",
            "the skip rules (Active, terminal, stamp-less, already-armed) are pinned \
             behaviourally by `m22s3b_plan_deletion_rearms_idempotent`, and that test can \
             only reach them through this seam. An inline re-derivation in the shell is \
             untested by construction — and it is the shell, not the seam, that would then \
             decide which accounts get an irreversible cascade scheduled",
        ),
    ] {
        assert!(
            sweep_body.contains(needle),
            "[m22s3b/sweep-shape] `ensure_deletion_reapers_armed` must contain `{needle}` \
             ({what}): {why}. Body read: {sweep_body:?}"
        );
    }

    let lib = stripped_for_scan(LIB_RS);
    let call = m22s3b_nd_ensure_call();
    for (what, needle, why) in [
        (
            "init",
            concat!("fni", "nit("),
            "covers a freshly created database, beside ensure_playtest_reaper and \
             ensure_mr_heartbeat",
        ),
        (
            "sync_content",
            concat!("fnsync", "_content("),
            "is the ONLY entry point that can reach a LIVE database — `init` runs once, at \
             creation, so on any deployed database it is the publish path or nothing",
        ),
    ] {
        let body = extract_squashed_fn_body(&lib, needle).unwrap_or_else(|| {
            panic!(
                "[m22s3b/sweep-scope] fn {what} was not found in lib.rs, so the wiring clause \
                 for it has no scope and would pass vacuously."
            )
        });
        assert_eq!(
            m22_count_occurrences(body, &call),
            1,
            "[m22s3b/sweep-wired-{what}] lib.rs `{what}` must call `{call}` EXACTLY once — it \
             {why}. ZERO leaves the ADR-0221 R2 population (accounts whose one-shot fired \
             under the pre-S3b reaper and was dropped without a re-arm) with nothing armed, \
             forever: no code path anywhere else re-reads those rows."
        );
    }
}

// ---------------------------------------------------------------------------
// m22-s3b / PRV1-8(b) — FRESH RE-REGISTRATION (issue #403, ADR-0228 D4).
// ---------------------------------------------------------------------------

/// PRV1-8(b) (scan): `provision_or_touch_account`'s `Some` branch opens with a
/// terminal-marker match guard that rebuilds the row from `new_account_row`, and
/// that arm precedes the ordinary `touch_login` arm.
///
/// THE MARKER HALF KEYS THE GUARD, not spec §4.1's conjunction (ADR-0228 D4). On
/// the illegal `Active` + marker shape a fresh reset is the fail-closed
/// direction: the erased account stays erased and nothing pre-deletion survives.
/// The conjunction would answer false there and silently reactivate the row.
///
/// `update`, NOT `insert`: the row already exists, so an insert would collide on
/// the identity primary key and abort the connect hook — which returns `Err` and
/// therefore DISCONNECTS the client (the crate doc's rule that AUTH-1 exists
/// for). The arm-span clause pins both the constructor and the write verb.
///
/// PLACEMENT: after the issuer and audience checks (the existing auth2_3 pins
/// keep those first), and BEFORE the touch arm — a reset arm sequenced after
/// `touch_login` never runs, because the earlier arm has already matched.
///
/// Kills: the whole arm missing (the count clause — and §4.6's verified
///        reactivation hole is then open: the same person re-authenticating with
///        the same OAuth account silently revives a terminal row with zero
///        gating); an arm keyed on the §4.1 conjunction instead of the marker
///        half; an arm that calls `touch_login` (carrying every pre-deletion
///        field forward, which is exactly what Option B rules out); an arm that
///        INSERTS rather than updates; an arm placed below the touch arm, where
///        it is unreachable.
#[test]
fn m22s3b_provision_terminal_reset_defaults() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_provision())
        .expect("[m22s3b/reset-scope] fn provision_or_touch_account was not found");

    let arm = m22s3b_nd_terminal_reset_arm();
    let n_arm = m22_count_occurrences(body, &arm);
    assert_eq!(
        n_arm, 1,
        "[m22s3b/reset-arm] provision_or_touch_account must carry the PRV1-8(b) terminal \
         match-guard arm `{arm}` EXACTLY once; found {n_arm}. ZERO leaves the §4.6 \
         reactivation hole open exactly as the spec measured it: `touch_login` neither reads \
         nor gates on `status`, and `Identity = f(iss, sub)`, so the same real person \
         re-authenticating with the same OAuth account hits the `Some` branch and silently \
         reactivates a terminal row with zero rejection and zero gating. MORE THAN ONE is a \
         decoy that steers the span read below at an arm nobody reviewed."
    );

    let at_arm = idx(body, &arm);
    let (span_start, span_end) = m22s3b_block_span(body, at_arm);
    let span = &body[span_start..span_end];
    assert!(
        span.contains(concat!("new_account", "_row(")),
        "[m22s3b/reset-constructor] the terminal-reset arm must rebuild the row through \
         `new_account_row(`. That constructor takes NO existing row, so it CANNOT carry a \
         pre-deletion value forward — which is the whole content of PRV1-8(b). Any other \
         spelling (a struct-update spread over the terminal row, a `touch_login` call) \
         carries fields the operator's Option B ruling says must be gone. Arm span read: \
         {span:?}"
    );
    assert!(
        span.contains(concat!(".upd", "ate(")),
        "[m22s3b/reset-update] the terminal-reset arm must UPDATE the existing row, never \
         insert. The row is already there — its identity is the primary key — so an insert \
         collides and returns `Err` from `provision_or_touch_account`, and an `Err` out of \
         the client_connected hook DISCONNECTS the client (the crate doc rule AUTH-1 exists \
         for). Arm span read: {span:?}"
    );
    assert!(
        !span.contains(concat!("touch", "_login(")),
        "[m22s3b/reset-not-touch] the terminal-reset arm calls `touch_login(`. That stamps \
         ONLY `last_login_at_ms` and leaves `status`, the deletion stamps and the claim \
         provenance exactly as the completed cascade left them — a terminal row that is now \
         also freshly logged in. PRV1-8(b) requires every field at `new_account_row` \
         defaults. Arm span read: {span:?}"
    );

    // --- THE ARM MUST NOT REACH ITS OWN MATCH BINDING (added in r2) ---------
    //
    // A red-team measured the cheat the three clauses above miss:
    //   Some(existing) if account_has_terminal_marker(&existing) => {
    //       ctx.db.account().identity().update(Account {
    //           ..new_account_row(ctx.sender(), issuer.to_string(), now)
    //       });                                   // ..or ..existing, the real one
    //   }
    // Spelled with `..existing` as the struct-update base and the fresh row's
    // fields listed selectively, it calls `new_account_row(`, it calls
    // `.update(`, it never calls `touch_login(` — every clause above is green —
    // and every field the author did not think to name is carried straight
    // through from the erased row. PRV1-8(b) says NO pre-deletion field value
    // survives, so the honest rule is that the reset arm must not be able to SEE
    // the old row at all: the binder is named in the match guard, which sits
    // OUTSIDE this span, so a body that never mentions it cannot carry anything
    // forward no matter what it is written with.
    let binder = m22_count_occurrences(span, "existing");
    assert_eq!(
        binder, 0,
        "[m22s3b/reset-no-spread] the terminal-reset arm names its match binding `existing` \
         {binder} time(s) inside the arm body; it must name it ZERO times. The binder belongs \
         to the GUARD (which is outside this span and is where the marker is tested); the \
         BODY rebuilds the row from `new_account_row`, which takes no existing row at all. \
         Any mention of the old row inside the arm is a route for a pre-deletion value to \
         survive — `Account {{ ..existing }}` being the measured one, which carries every \
         unnamed field forward while satisfying the constructor, update and no-touch_login \
         clauses above. PRV1-8(b) is explicit: every field at `new_account_row` defaults, \
         with `identity` and `auth_issuer` supplied by the LIVE connection. Arm span read: \
         {span:?}"
    );

    let touch = concat!("touch", "_login(");
    assert_eq!(
        m22_count_occurrences(body, touch),
        1,
        "[m22s3b/reset-touch-once] provision_or_touch_account must call `touch_login(` \
         EXACTLY once — the ordinary reconnect arm. The ordering clause below anchors on it, \
         so a second call would steer a first-hit index."
    );
    assert!(
        at_arm < idx(body, touch),
        "[m22s3b/reset-arm-first] the terminal-reset arm must precede the `touch_login` arm. \
         Rust match arms are tried IN ORDER, so a guarded arm placed after the catch-all \
         `Some(existing)` arm can never match: the text would be present, every clause above \
         would be green, and every terminal row would still be silently reactivated."
    );
}

/// PRV1-8(b) (pure): the reset carries NO pre-deletion value forward.
///
/// The structural test above pins that the arm rebuilds through
/// `new_account_row`; this one pins what that buys. `new_account_row` takes no
/// existing row at all, so the property is provable by value: feed it the
/// identity and issuer of a fully-erased account and assert the output shares
/// nothing with its terminal predecessor except the two fields the LIVE
/// CONNECTION supplies.
///
/// EVERY FIELD IS ASSERTED SEPARATELY, and each names a different leak: a
/// surviving `terminal_at_ms` would make the fresh account instantly gated by
/// every §4.7 guard (a trap state, which is precisely what the terminal
/// marker's own justification says it must not be); a surviving
/// `deletion_requested_at_ms` would re-arm a cascade over the new incarnation; a
/// surviving `claimed_from` would keep AUTH-14's one-claim-per-account spent
/// (ADR-0228 D4 accepts the OPPOSITE — the claim slot is restored per
/// incarnation — so a carried-forward claim is a silent deviation from the
/// ruling); a surviving `created_at_ms` would misdate the new account.
///
/// Kills: a reset written as a struct-update spread over the terminal row (every
///        un-named field survives); a `new_account_row` that seeds any field
///        from a caller-supplied row; a `created_at_ms` that diverges from
///        `last_login_at_ms` at insert time.
#[test]
fn m22s3b_touch_login_scope_excludes_terminal() {
    let erased = Account {
        auth_issuer: "issuer-before-deletion".to_string(),
        created_at_ms: 111,
        last_login_at_ms: 222,
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(1_700_000_000_000),
        claimed_from: Some(ident(99)),
        claimed_at_ms: Some(1_600_000_000_000),
        terminal_at_ms: Some(1_800_000_000_000),
        ..base_account(51)
    };
    assert!(
        account_state_is_legal(&erased),
        "[m22s3b/reset-fixture] the fixture must be a LEGAL completed-deletion row — the one \
         state PRV1-8(b) is about. An illegal straw man would prove nothing."
    );
    assert!(
        account_has_terminal_marker(&erased),
        "[m22s3b/reset-fixture-marker] the fixture must carry the terminal marker, or the \
         reset arm would never fire for it."
    );

    let now: i64 = 2_000_000_000_000;
    let fresh = new_account_row(erased.identity, "issuer-after-reset".to_string(), now);

    assert_eq!(
        fresh.identity, erased.identity,
        "[m22s3b/reset-identity] the identity is the ONE thing that carries over — it is the \
         primary key and it is supplied by the live connection, not by the old row."
    );
    assert_eq!(
        fresh.auth_issuer, "issuer-after-reset",
        "[m22s3b/reset-issuer] `auth_issuer` comes from the LIVE token's issuer claim, never \
         from the erased row (whose value is the game-core tombstone sentinel by then)."
    );
    assert_eq!(
        fresh.status,
        AccountStatus::Active,
        "[m22s3b/reset-status] the reset row is `Active`. A row that stayed PendingDeletion \
         would be re-gated by every §4.7 guard the moment it was created."
    );
    assert!(
        fresh.terminal_at_ms.is_none(),
        "[m22s3b/reset-marker-cleared] the terminal marker MUST NOT survive. It is the whole \
         M22 terminal state: carried forward, the newly re-registered account is refused by \
         `should_reject_for_deletion` on its very first gameplay call — a trap state, which \
         is exactly what the marker's own justification (audit plus trap-state PREVENTION) \
         rules out."
    );
    assert!(
        fresh.deletion_requested_at_ms.is_none(),
        "[m22s3b/reset-request-cleared] the deletion request stamp MUST NOT survive: with the \
         status reset to Active it is also the ILLEGAL Active-plus-stamp shape, and the \
         ADR-0221 R2 sweep would read it as a mid-grace row and arm a cascade over an account \
         that never requested one."
    );
    assert!(
        fresh.claimed_from.is_none(),
        "[m22s3b/reset-claim-cleared] claim provenance MUST NOT survive. ADR-0228 D4 records \
         the consequence deliberately: the reset restores a spent claim slot, so AUTH-14's \
         one-claim-per-account becomes per-INCARNATION. The yield is bounded at one starter \
         monster per grace window per OAuth identity, which is exactly the equivalence \
         Option B accepts. Carrying it forward silently reverses that recorded decision."
    );
    assert!(
        fresh.claimed_at_ms.is_none(),
        "[m22s3b/reset-claim-stamp-cleared] the other half of the claim pair must be cleared \
         too — `account_state_is_legal` requires the two to be set together or not at all."
    );
    assert_eq!(
        fresh.created_at_ms, now,
        "[m22s3b/reset-created] `created_at_ms` is the RESET instant, not the erased row's \
         original creation stamp. A carried-forward creation date would date the new \
         incarnation to the deleted one and defeat the point of the reset."
    );
    assert_eq!(
        fresh.last_login_at_ms, now,
        "[m22s3b/reset-last-login] AUTH-4: a freshly provisioned row has \
         `created_at_ms == last_login_at_ms`."
    );
    assert!(
        account_state_is_legal(&fresh),
        "[m22s3b/reset-legal] the reset row must be a legal Active account."
    );
    assert!(
        !should_reject_for_deletion(&fresh),
        "[m22s3b/reset-ungated] the reset row must pass the §4.7 gate. This is the whole \
         point of Option B: the identity is treated like a fresh account, so it can play. A \
         reset that leaves either the status or the marker behind produces an account that \
         exists and can do nothing."
    );
}

/// AUTH-13 / ADR-0228 D6 (scan): `complete_guest_claim` Guard 3 discriminates —
/// the terminal-marker half runs FIRST and rejects with the DISTINCT
/// `REJECT_ALREADY_DELETED` reason; the mid-grace half keeps the generic one.
///
/// WHY THE ORDER: a terminal row IS `PendingDeletion` (spec §4.1 defines
/// terminal as the conjunction), so the generic mid-grace guard matches it too.
/// Behind that guard, the discriminating one can never fire and every
/// already-erased destination is told its account is merely pending deletion —
/// which is false, and which invites the caller to cancel a deletion that has
/// already completed.
///
/// WHY THE TAG IS PINNED SEPARATELY: `stripped_for_scan` blanks string literals,
/// and the cancel-side PRV1-4 guard is byte-identical in that view. The
/// strings-KEPT twin is the only pipeline that can tell the two apart, and the
/// tag is what `log_reject` writes — the wrong one files every already-deleted
/// claim reject under another reducer's audit-log class.
///
/// Kills: the split not made (the terminal needle counts zero and every erased
///        account gets the generic reason); the two halves in the wrong order
///        (the ordering clause); the terminal half rejecting with the generic
///        reason or the mid-grace half with the distinct one (the tagged twin);
///        the mid-grace half DELETED in the name of the split (its own count
///        clause — the two guards answer different questions and both must run);
///        either half moved past the code-resolution boundary, where the reducer
///        becomes a claim-code oracle for an unauthorized caller.
#[test]
fn m22s3b_guard3_terminal_reason_distinct() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let body = extract_squashed_fn_body(&squashed, &nd_complete())
        .expect("[m22s3b/guard3-scope] fn complete_guest_claim was not found");

    // --- TWO INDEPENDENT TRANSCRIPTIONS OF THE MARKER CALL (added in r2) ----
    //
    // Every clause in this test reached the marker through ONE helper,
    // `m22s3_nd_marker_call()`, which is ALSO what the two terminal-guard needles
    // in `m22s3_terminal_guards_precede_state_writes` are built from. That makes
    // the helper a single artefact three gates depend on: an edit inside it — a
    // dropped `&`, a renamed binding, a switch from the marker half to spec
    // §4.1's conjunction — moves every consumer with it, and all three stay
    // green while asserting something nobody chose. That is the same
    // one-artefact hole the frozen reaper body records at
    // `[rb24/reaper-needle-independence]`, and it gets the same treatment: a
    // SECOND spelling, split at different points, plus a clause that makes the
    // agreement checkable instead of assumed.
    let marker = m22s3_nd_marker_call();
    let marker_twin = concat!("acc", "ount_has_term", "inal_marker(&acc", "ount)");
    assert_eq!(
        marker, marker_twin,
        "[m22s3b/guard3-needle-independence] the shared marker needle and this test's own \
         independent transcription disagree: `{marker}` versus `{marker_twin}`. They are \
         split at different points on purpose, so a mismatch means the shared helper was \
         edited alone — and that helper is consumed by BOTH terminal-guard pins as well as by \
         every clause below, so an edit inside it silently re-points three gates at once. \
         Re-derive both spellings from ADR-0228 D4/D6 in the same change: the guard reads the \
         MARKER HALF of spec §4.1 (`terminal_at_ms.is_some()`) on the ALREADY-BOUND row, \
         which is what makes it fail-closed on the illegal Active-plus-marker shape."
    );
    let pending = concat!("is_pending", "_deletion(");
    let n_marker = m22_count_occurrences(body, marker_twin);
    assert_eq!(
        n_marker, 1,
        "[m22s3b/guard3-marker-once] complete_guest_claim must consult `{marker}` EXACTLY \
         once; found {n_marker}. ZERO means the AUTH-13 split was never made and an \
         already-ERASED destination is told its account is merely `pending deletion` — a \
         message that is false and that invites the caller to cancel a deletion which has \
         already completed. The ordering clause below anchors on this needle."
    );
    let n_pending = m22_count_occurrences(body, pending);
    assert_eq!(
        n_pending, 1,
        "[m22s3b/guard3-pending-kept] complete_guest_claim must STILL consult `{pending}` \
         EXACTLY once; found {n_pending}. ADR-0228 D6 SPLITS Guard 3, it does not replace one \
         half with the other: the marker half answers `already erased` and the mid-grace half \
         answers `deletion in progress`, and dropping the second reopens AUTH-13 for every \
         account inside its grace window."
    );

    let at_marker = idx(body, &marker);
    let at_pending = idx(body, pending);
    assert!(
        at_marker < at_pending,
        "[m22s3b/guard3-terminal-first] the terminal-marker half (offset {at_marker}) must \
         run BEFORE the mid-grace half (offset {at_pending}). A terminal row IS \
         `PendingDeletion` — spec §4.1 defines terminal as that conjunction — so the generic \
         guard matches it too. Behind it, the discriminating guard is unreachable for every \
         row it exists to discriminate, and the whole message split is dead text."
    );

    let tagged = m22s3b_nd_claim_terminal_guard_tagged();
    assert_eq!(
        m22_count_occurrences(&stripped_keep_strings(ACCOUNTS_RS), &tagged),
        1,
        "[m22s3b/guard3-audit-tag] the Guard 3a reject must carry its OWN reducer tag and the \
         distinct reason, as `{tagged}`. Every other clause here reads the string-BLANKED \
         view, in which the reducer-name argument of `reject` is empty AND the cancel-side \
         PRV1-4 guard squashes to the identical text — so a guard tagged with another \
         reducer name, or one that rejects with the generic mid-grace literal, satisfies all \
         of them. The tag is what `log_reject` writes into the audit log."
    );

    // The split must stay on the caller-state side of the oracle boundary.
    let min_code = [
        idx(body, concat!("is_valid_claim", "_code(")),
        idx(body, concat!("guest", "_claim().code().find(")),
    ]
    .into_iter()
    .min()
    .expect("[m22s3b/guard3-partition] the code-resolution anchors must exist");
    assert!(
        at_marker < min_code && at_pending < min_code,
        "[m22s3b/guard3-partition] both halves of Guard 3 (offsets {at_marker} and \
         {at_pending}) must precede all code resolution (first at offset {min_code}). The \
         AUTH-12/13/14 partition is what stops this reducer being a claim-code oracle: an \
         unauthorized caller must never learn whether a code is well-formed or live, and an \
         ALREADY-DELETED caller is exactly such a caller."
    );
}

// ---------------------------------------------------------------------------
// m22-s3b — SHAPE PINS FOR THE THREE HELPERS WITH NO `_tests.rs` SIBLING.
//
// `monster_mgmt.rs`, `inventory.rs` and `lib.rs` have no sibling test module of
// their own (ADR-0228, RT-4), so their delegated-helper shape pins live here
// rather than in a new file this slice would have to create.
// ---------------------------------------------------------------------------

/// PRV1-6b (scan): `erase_monsters` deletes the private `monster` row AND its
/// `monster_pub` twin, in ONE function body, both keyed on the owner index.
///
/// THE DUAL WRITE IS THE INVARIANT. `monster_pub` is the public projection of
/// `monster` and the pair is written together everywhere else in the tree
/// (`rekey_monsters` is the direct precedent, and `monster-dual-write.eval.mjs`
/// is the crate-wide gate). Erasing only the private row leaves a PUBLIC row
/// carrying the deleted player's species, level, nickname and derived stats,
/// world-readable, forever — which is not a partial deletion, it is a deletion
/// that leaves the visible half behind.
///
/// Kills: erasing only `monster`; erasing only `monster_pub`; splitting the two
///        across separate functions, where the eval's same-body dual-write rule
///        no longer sees them; a sweep keyed on something other than the owner
///        parameter, which either deletes nothing or deletes everybody's rows.
#[test]
fn m22s3b_erase_monsters_shape() {
    let squashed = stripped_for_scan(MONSTER_MGMT_RS);
    let body = extract_squashed_fn_body(&squashed, concat!("fnerase", "_monsters("))
        .unwrap_or_else(|| {
            panic!(
                "[m22s3b/monsters-scope] monster_mgmt.rs declares no `fn erase_monsters(`. \
                 The cascade delegates the `monster` + `monster_pub` ERASE to this module \
                 because G5 MODULE_WRITE_ISOLATION closes accounts.rs at its four owned \
                 tables. Fail LOUD rather than pass vacuously."
            )
        });
    assert!(
        !body.is_empty(),
        "[m22s3b/monsters-nonvacuous] the erase_monsters body is empty, so every clause below \
         would be asserting properties of nothing."
    );

    for (needle, what) in [
        (
            concat!(".mon", "ster()"),
            "the PRIVATE monster table — the row carrying the hidden genes",
        ),
        (
            concat!(".mon", "ster_pub()"),
            "the PUBLIC projection twin — world-readable, so leaving it behind leaves the \
             VISIBLE half of the deleted player's collection in place",
        ),
    ] {
        assert!(
            body.contains(needle),
            "[m22s3b/monsters-dual-write] erase_monsters must reach `{needle}` ({what}). The \
             two tables are written as a PAIR everywhere else in this module, and both are \
             classified ERASE by the manifest; erasing one of them is not a partial deletion \
             but a deletion that leaves the client-visible copy intact."
        );
    }

    let deletes = m22_count_occurrences(body, concat!(".del", "ete("));
    assert_eq!(
        deletes, 2,
        "[m22s3b/monsters-deletes] erase_monsters performs {deletes} row delete(s); EXACTLY \
         TWO are sanctioned — one per ERASE table, both keyed on the collected `monster_id`. \
         FEWER means one of the pair is only read (the public projection then survives \
         world-readable, or the private row with the hidden genes does). MORE is a third row \
         removal in a helper whose entire remit is those two tables; it would also mean this \
         body reaches a table no owning-module shape pin covers. Tightened from a floor in \
         r2: `>= 2` accepted an unbounded number of extra deletes."
    );
    let iter_call = concat!(".it", "er()");
    assert_eq!(
        m22_count_occurrences(body, iter_call),
        0,
        "[m22s3b/monsters-no-scan] erase_monsters calls `{iter_call}`. `monster` carries a \
         btree index on `owner_identity` and `monster_pub` mirrors it 1:1 by `monster_id`, so \
         the owner's rows are reachable by INDEX and a full-table iteration is never needed. \
         The measured cheat this closes: `ctx.db.monster().iter().filter(..)` alongside the \
         owner filter satisfies every presence clause above while the sweep walks the whole \
         table — and if that filter is ever wrong, absent, or refactored away, the same body \
         deletes every player's collection in the database. An indexed route makes the \
         catastrophic shape unrepresentable rather than merely unlikely."
    );
    let owner_scoped = m22_count_occurrences(body, concat!("owner_identity().fil", "ter(owner)"));
    assert!(
        owner_scoped >= 1,
        "[m22s3b/monsters-owner-scoped] erase_monsters never filters the owner btree index \
         with the `owner` PARAMETER (found {owner_scoped}). ONE is enough and is the expected \
         shape — `monster_pub` mirrors `monster` 1:1 by `monster_id`, so the sanctioned body \
         collects the owner's monster ids ONCE and deletes both tables by that primary key, \
         which is why this clause is a FLOOR rather than a count. What it forbids is a sweep \
         keyed on anything else: either a no-op, or an UNFILTERED full-table delete that \
         erases every player's collection in the database — the catastrophic direction, and \
         one that reads identically to the correct body under a presence-only check."
    );
}

/// PRV1-6b (scan): `erase_inventory` sweeps the caller's `inventory` rows
/// through the owner btree index.
///
/// Kills: a helper that reads but never deletes; an unfiltered full-table sweep
///        (every player's items); a sweep keyed on an identity other than the
///        `owner` parameter.
#[test]
fn m22s3b_erase_inventory_shape() {
    let squashed = stripped_for_scan(M22_INVENTORY_RS);
    let body = extract_squashed_fn_body(&squashed, concat!("fnerase", "_inventory("))
        .unwrap_or_else(|| {
            panic!(
                "[m22s3b/inventory-scope] inventory.rs declares no `fn erase_inventory(`. The \
                 cascade delegates the `inventory` ERASE to its owning module (G5). Fail LOUD."
            )
        });
    assert!(
        body.contains(concat!(".inven", "tory()")),
        "[m22s3b/inventory-accessor] erase_inventory must reach the inventory table accessor. \
         Body read: {body:?}"
    );
    assert!(
        body.contains(concat!("owner_identity().fil", "ter(owner)")),
        "[m22s3b/inventory-owner-scoped] erase_inventory must filter the owner btree index \
         with the `owner` PARAMETER. An unfiltered sweep deletes every player's item stacks; \
         a sweep keyed on any other identity deletes the wrong player's. Body read: {body:?}"
    );
    assert!(
        body.contains(concat!(".del", "ete(")),
        "[m22s3b/inventory-deletes] erase_inventory must actually delete rows — a helper that \
         collects ids and never deletes satisfies both clauses above. Body read: {body:?}"
    );
    let iter_call = concat!(".it", "er()");
    assert_eq!(
        m22_count_occurrences(body, iter_call),
        0,
        "[m22s3b/inventory-no-scan] erase_inventory calls `{iter_call}`. `inventory` carries a \
         btree index on `owner_identity`, so the owner's stacks are reachable by INDEX and a \
         full-table iteration is never needed. The measured cheat this closes (added in r2): \
         a body that keeps the owner filter for show and does the real work over \
         `ctx.db.inventory().iter()` satisfies the accessor, owner-filter and delete clauses \
         above while walking every player's rows — and one wrong or missing predicate in that \
         scan deletes the whole table. `inventory` is PUBLIC and world-readable, so the blast \
         radius of that mistake is every player's item counts at once."
    );
}

/// PRV1-6d (scan): `erase_character_rows` reaches the `character` row through
/// the owning `player` row's `entity_id` join, and does NOT delete the `player`
/// row itself.
///
/// `character` is JOIN-ONLY: it carries no `Identity` column at all, so the only
/// route to it is `player.entity_id` (the manifest pins that parent by value).
/// And `player` is ANONYMIZE, not ERASE — spec §3 is explicit that the presence
/// row must SURVIVE as the anchor `character` and every still-live multi-user
/// row point at. A helper that deletes both would remove the anchor the §4.4
/// ordering exists to protect.
///
/// Kills: a sweep that deletes `player` (which spec §3 forbids outright and
///        which would strand every row pointing at it); a helper that never
///        reads `player` at all, which cannot find the join key and therefore
///        deletes nothing.
#[test]
fn m22s3b_erase_character_rows_shape() {
    let squashed = stripped_for_scan(LIB_RS);
    let body = extract_squashed_fn_body(&squashed, concat!("fnerase_character", "_rows("))
        .unwrap_or_else(|| {
            panic!(
                "[m22s3b/character-scope] lib.rs declares no `fn erase_character_rows(`. \
                 `character` has no Identity column, so the JOIN-ONLY sweep needs the \
                 `player.entity_id` lookup and lives beside the other lib.rs helpers that \
                 already do it. Fail LOUD."
            )
        });

    assert!(
        body.contains(concat!("player().identity().fi", "nd(owner)")),
        "[m22s3b/character-join] erase_character_rows must read the OWNING player row by \
         identity to obtain the join key. `character` carries no Identity column at all — \
         that is what JOIN-ONLY means — so without this read there is nothing to key the \
         delete on. Body read: {body:?}"
    );
    assert!(
        body.contains(concat!("character().entity_id().del", "ete(")),
        "[m22s3b/character-delete] erase_character_rows must delete the character row by its \
         `entity_id` primary key. Body read: {body:?}"
    );
    assert_eq!(
        m22_count_occurrences(body, concat!("player().identity().del", "ete(")),
        0,
        "[m22s3b/character-player-survives] erase_character_rows deletes the `player` row. \
         Spec §3 classifies `player` ANONYMIZE, never ERASE: the presence row MUST survive as \
         the anchor that `character` and every still-live multi-user row point at, and the \
         §4.4 character-before-player ordering exists precisely because the two are handled \
         differently. Deleting it here strands every one of those references and makes the \
         ordering pin meaningless. Body read: {body:?}"
    );
    let iter_call = concat!(".it", "er()");
    assert_eq!(
        m22_count_occurrences(body, iter_call),
        0,
        "[m22s3b/character-no-scan] erase_character_rows calls `{iter_call}`. Both tables on \
         this path are reached by KEY: `player` by its `identity` primary key, and `character` \
         by the `entity_id` primary key that read yields. There is at most ONE character row \
         per player, so a full-table iteration is never needed — and it is the shape that \
         makes the catastrophic mistake possible, because `character` carries NO identity \
         column at all (that is what JOIN-ONLY means), so an iteration here has nothing to \
         scope itself with and a missing predicate deletes every character row in the world. \
         Added in r2: the join-read and delete clauses above are both satisfied by a body that \
         also scans."
    );
}

/// EO-1 / PRV1-6b (compensating scoped pin for the 1 -> 2 purge widening,
/// ADR-0228 D7(b)): the two `purge_export_bundles` call sites in `accounts.rs`
/// are EXACTLY the claim-time purge and the cascade step — and nothing else.
///
/// `rb22_purge_called_exactly_once_in_accounts_rs` now allows two namings; on
/// its own that is a strictly looser gate than the one it replaces, because a
/// second call dropped into `rekey_all` — where neither the claim ceremony's
/// reviewers nor the cascade's ever look — reads exactly the same to a whole-file
/// count. This test is the payment: each body is pinned to EXACTLY ONE call and
/// the remainder is asserted to be ZERO as arithmetic, so a third site cannot
/// hide behind the per-body counts and a MOVED site cannot hide behind the total.
///
/// Kills: a purge relocated out of either ceremony; a third call site anywhere
///        in the file; both calls collapsing into one body.
#[test]
fn m22s3b_purge_named_twice_claim_and_cascade() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let call = rb22_nd_purge_call();

    let total = m22_count_occurrences(&squashed, &call);
    assert_eq!(
        total, 2,
        "[m22s3b/purge-total] accounts.rs must name `{call}` EXACTLY twice; found {total}. \
         The per-body clauses below are meaningless if the total has moved."
    );

    let mut scoped = 0usize;
    for (what, decl, why) in [
        (
            "complete_guest_claim",
            nd_complete(),
            "rb-22 / ADR-0220: the guest identity retires at the claim, so its pre-claim \
             export chunks would orphan — the cascade keys on a LIVE account's own identity \
             and structurally cannot reach them",
        ),
        (
            "account_deletion_reaper",
            rb24_nd_reaper_decl(),
            "PRV1-6b / ADR-0228 D1: `export_bundle` is an ERASE-policy table and an export \
             snapshot is itself personal data, so the cascade sweeps it through the SAME \
             owner-generic helper rather than minting a second one",
        ),
    ] {
        let (start, end) = rb24_fn_body_span(&squashed, &decl);
        let n = m22_count_occurrences(&squashed[start..end], &call);
        assert_eq!(
            n, 1,
            "[m22s3b/purge-in-{what}] {what} must call the delegated purge EXACTLY once; \
             found {n}. {why}. ZERO means this ceremony's chunks are never erased while the \
             whole-file count still reads 2 — the exact shape a bumped number cannot see."
        );
        scoped += n;
    }
    assert_eq!(
        total - scoped,
        0,
        "[m22s3b/purge-zero-elsewhere] accounts.rs names the purge {total} time(s) and the \
         two reviewed bodies account for {scoped}, leaving {} elsewhere. A purge outside both \
         ceremonies deletes export_bundle rows for whatever owner IT derives, from a flow \
         neither set of reviewers ever saw — `rekey_all` being the measured hiding place, \
         since ADR-0228 itself names that helper as the cascade's delegation precedent.",
        total - scoped
    );
}

// ===========================================================================
// M22-S6 — DELETION COMPLETENESS FROM DERIVE METADATA (PRV1-15, PRV1-16).
//
// Spec: M22-privacy-compliance.spec.md §3/§4.4, REDIRECTED per ADR-0224 (no new
// evals/*.eval.mjs). Design record: ADR-0229. Ledger gates X1-X5.
// Plan: memory/projects/monster-realm-m22-s6-plan.md (harness repo).
//
// WHAT THIS SECTION DOES NOT RE-DO. `data_lifecycle_manifest_totality_bidirectional`
// (:3524) already proves every LIVE TABLE has a manifest entry; T1/X4 below proves
// something narrower and different — that the entry's row TYPE actually carries (or
// doesn't carry) an `Identity` column, which the totality test cannot see at all.
// `m22s3b_cascade_covers_manifest` (:9493) already proves every classified table maps
// to a reaper-reachable helper NAME; T2/X5 below proves the SAME correspondence plus
// two things that test does not: that the mapped declaration is unique (no decoy
// second declaration steering a first-hit anchor) and that the far end of the chain
// actually PERFORMS a mutating call on that table's own accessor, in the same
// statement as the accessor occurrence (the `erase_monsters`-serves-two-tables
// bypass this ADR names explicitly).
//
// WHY DERIVE METADATA, NOT A SOURCE SCAN (ADR-0224/ADR-0229). `#[spacetimedb::table]`
// derives `SpacetimeType`; calling `<T as SpacetimeType>::make_type` against a
// throwaway `TypespaceBuilder` returns the row's real `AlgebraicType::Product` — the
// same shape the host itself sees. No comment stripper, no string-literal parser, no
// regex: the failure class ADR-0224 retires (a stray `/*` or bare `"` blanking a
// later table from a whole-tree scan) is structurally absent from T1.
//
// SCAN HYGIENE (T2 only; T1 does no text scanning at all): this section's own needle
// helpers are `m22s6_`-prefixed and split mid-token via `concat!`, per this file's
// header rule, so this file never carries a contiguous scanner needle. Only
// `player_wallet` and `account_deletion_reaper_schedule` are split — mirroring
// EXACTLY what the neighbouring m22s3b tests above already do with those two names;
// every other accessor name in this section (`guest_claim`, `monster_pub`,
// `battle_challenge_reaper_schedule`, `trade_offer_reaper_schedule`, ...) is a bare
// literal, matching `data_lifecycle_partition_matches_spec_section3` and
// `m22s3b_cascade_covers_manifest` exactly.
// ===========================================================================

use spacetimedb::sats::AlgebraicType;
use spacetimedb::SpacetimeType;

/// The throwaway `TypespaceBuilder` T1 drives `SpacetimeType::make_type` with.
///
/// INLINES rather than INTERNS: `add` calls `make_ty(self)` straight through and
/// returns the result directly — no `AlgebraicTypeRef` is ever minted, so the
/// `AlgebraicType` this yields for every row type below is fully self-contained
/// (no `Ref` variant anywhere in the tree). That is exactly the shape
/// `m22s6_identity_bearing` below is written against: it recurses through `Sum`/
/// `Product`/`Array` but never needs to resolve a `Ref` through a `Typespace`,
/// because none is ever produced.
///
/// THIS IS WHY THE RECURSION BELOW CARRIES A HARD DEPTH CAP. Because this builder
/// never interns, a genuinely self-referential column type (a struct that embeds
/// itself, directly or through a cycle) would make `make_type` recurse without
/// bound at DERIVE time already — before `m22s6_identity_bearing` ever runs — and
/// the plan's red-team measured, in a scratch crate, that this is a real stack
/// overflow that `SIGABRT`s the whole `cargo nextest` process rather than failing
/// one test. No live table in this crate has such a type today (every nested
/// `#[derive(SpacetimeType)]` struct here is a strict DAG), so the cap below is
/// forward defence, not a live requirement — but it is what turns a future
/// self-referential column into a named, loud test failure instead of a crashed
/// test runner that reports nothing at all.
struct M22s6InlineTypespace;
impl spacetimedb::sats::typespace::TypespaceBuilder for M22s6InlineTypespace {
    fn add(
        &mut self,
        _type_id: std::any::TypeId,
        _name: Option<&'static str>,
        make_ty: impl FnOnce(&mut Self) -> spacetimedb::sats::AlgebraicType,
    ) -> spacetimedb::sats::AlgebraicType {
        make_ty(self)
    }
}

/// True if `ty` carries an `Identity` column at ANY depth — not just as a bare
/// leaf field.
///
/// `AlgebraicType::is_identity()` is a SHALLOW shape check
/// (`ProductType::is_identity()` requires the type to be EXACTLY one field named
/// `__identity__` typed `U256` — verified against the vendored spacetimedb-sats
/// 2.8.1 source this session). The plan's red-team measured that this shallow
/// check is blind to three completely natural column shapes: `Option<Identity>`
/// lowers to a `Sum` (the `some`/`none` tags, `some` holding the identity
/// product), `Vec<Identity>` lowers to an `Array`, and any
/// `#[derive(SpacetimeType)]` newtype wrapping an `Identity` lowers to a
/// DIFFERENTLY-NAMED `Product` (its own field name, not `__identity__`) — all
/// three are exactly what `is_identity()` was written to reject (it exists to
/// distinguish a REAL identity newtype from an arbitrary same-shaped struct).
/// `Option<Identity>` in particular is a completely ordinary column spelling
/// ("assigned_to", "banned_by", "co_owner"), so a shallow check would let a new
/// owner-keyed table be classified `NotOwned` with NO exception-list edit at all
/// — silently reopening the exact hole ADR-0229 exists to close. This walk
/// therefore recurses through `Sum` variants, `Array` element types and nested
/// `Product` fields, testing `is_identity()` at every level before descending
/// further.
///
/// `depth` is a CALLER-SUPPLIED counter (start at 0), asserted against a small
/// cap and panicking BY NAME if exceeded — see `M22s6InlineTypespace`'s doc for
/// why an unbounded recursion here is not merely slow but a measured SIGABRT
/// hazard (the inline builder never interns, so a self-referential column has no
/// `Ref` to stop the walk).
fn m22s6_identity_bearing(ty: &AlgebraicType, depth: usize) -> bool {
    assert!(
        depth <= 12,
        "[m22s6/identity-depth-cap] a column type nested more than 12 levels deep — this walk \
         refuses to recurse further and panics by name instead. The inline \
         M22s6InlineTypespace never interns (no AlgebraicTypeRef is ever produced by `add`), so \
         a genuinely self-referential column type would otherwise recurse without bound and \
         SIGABRT the whole nextest process rather than failing one test loud — measured by the \
         plan's red-team in a scratch crate. No live table has such a type today; this cap is \
         forward defence against one that someday might."
    );
    if ty.is_identity() {
        return true;
    }
    match ty {
        AlgebraicType::Product(p) => {
            for e in p.elements.iter() {
                if m22s6_identity_bearing(&e.algebraic_type, depth + 1) {
                    return true;
                }
            }
            false
        }
        AlgebraicType::Sum(s) => {
            for v in s.variants.iter() {
                if m22s6_identity_bearing(&v.algebraic_type, depth + 1) {
                    return true;
                }
            }
            false
        }
        AlgebraicType::Array(a) => m22s6_identity_bearing(&a.elem_ty, depth + 1),
        _ => false,
    }
}

/// The S6 table-row-type registry (T1): one entry per live `DATA_LIFECYCLE_MANIFEST`
/// table, naming its row STRUCT (never a string transcription of it) so a renamed or
/// removed struct is a COMPILE ERROR here, never a silent skip. Alphabetical by
/// accessor. Verified this session against the live tree: every struct named below
/// was read from its declaring file and confirmed to exist with that exact name and
/// that exact `accessor = ...` attribute.
///
/// Split tokens: ONLY `player_wallet` and `account_deletion_reaper_schedule`,
/// mirroring exactly what `data_lifecycle_partition_matches_spec_section3` (:3671)
/// and `m22s3b_cascade_covers_manifest` (:9493) already do with those two names in
/// this same file — every other accessor here (including `guest_claim`,
/// `monster_pub`, `battle_challenge_reaper_schedule`, `trade_offer_reaper_schedule`)
/// is a bare literal there too, so this registry matches the established convention
/// rather than inventing a stricter one.
fn m22s6_table_row_types() -> Vec<(&'static str, AlgebraicType)> {
    let mut ts = M22s6InlineTypespace;
    vec![
        (
            "account",
            <crate::schema::Account as SpacetimeType>::make_type(&mut ts),
        ),
        (
            concat!("account_deletion_reaper", "_schedule"),
            <crate::accounts::AccountDeletionReaperSchedule as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle",
            <crate::schema::Battle as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_action",
            <crate::schema::BattleAction as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_challenge",
            <crate::schema::BattleChallenge as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_challenge_reaper_schedule",
            <crate::pvp::BattleChallengeReaperSchedule as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_wild",
            <crate::schema::BattleWild as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "character",
            <crate::schema::Character as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "config",
            <crate::schema::Config as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "encounter",
            <crate::schema::EncounterRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "evolution_path",
            <crate::schema::EvolutionPathRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "export_bundle",
            <crate::schema::ExportBundle as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "guest_claim",
            <crate::schema::GuestClaim as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "guest_claim_reaper_schedule",
            <crate::accounts::GuestClaimReaperSchedule as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "heal_cooldown",
            <crate::schema::HealCooldown as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "heal_location_row",
            <crate::schema::HealLocationRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "inventory",
            <crate::schema::Inventory as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "item_row",
            <crate::schema::ItemRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "monster",
            <crate::schema::Monster as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "monster_pub",
            <crate::schema::MonsterPub as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "movement_tick_schedule",
            <crate::movement::MovementTickSchedule as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "mr_heartbeat_schedule",
            <crate::observability::MrHeartbeatSchedule as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "npc",
            <crate::schema::Npc as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "player",
            <crate::schema::Player as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "player_conversation",
            <crate::schema::PlayerConversation as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "player_dialogue_state",
            <crate::schema::PlayerDialogueStateRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "player_quest",
            <crate::schema::PlayerQuestRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            concat!("player", "_wallet"),
            <crate::schema::PlayerWallet as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "playtest_event",
            <crate::playtest::PlaytestEvent as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "playtest_reaper_schedule",
            <crate::playtest::PlaytestReaperSchedule as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "profile",
            <crate::schema::Profile as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "pvp_deadline_schedule",
            <crate::pvp::PvpDeadlineSchedule as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "shop_item_row",
            <crate::schema::ShopItemRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "shop_row",
            <crate::schema::ShopRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "skill_row",
            <crate::schema::SkillRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "species_row",
            <crate::schema::SpeciesRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "trade_offer",
            <crate::schema::TradeOffer as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "trade_offer_reaper_schedule",
            <crate::trading::TradeOfferReaperSchedule as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "type_relation_row",
            <crate::schema::TypeRelationRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "zone_def",
            <crate::schema::ZoneDefRow as SpacetimeType>::make_type(&mut ts),
        ),
    ]
}

/// The number of identity-bearing columns in one registered row type. `ty` MUST be
/// `AlgebraicType::Product` at the top level — every SpacetimeDB table row is a
/// struct, so anything else means `m22s6_table_row_types` names the WRONG Rust type
/// for `accessor`, and every classification clause built on it would be counting
/// columns of something that is not a row at all. Fail loud rather than silently
/// return 0 (0 reads identically to "genuinely no Identity column" everywhere this
/// is consumed, which would be the dangerous silent direction here).
fn m22s6_identity_column_count(accessor: &str, ty: &AlgebraicType) -> usize {
    let AlgebraicType::Product(p) = ty else {
        panic!(
            "[m22s6/registry-shape] the row type registered for `{accessor}` is not a Product \
             at the top level ({ty:?}). Every SpacetimeDB table row is a struct, so a \
             non-Product top-level type means the S6 registry names the WRONG Rust type for \
             `{accessor}` — every R1/R2/R3 clause built on it would then be silently counting \
             columns of something that is not a row at all."
        )
    };
    let mut n = 0usize;
    for e in p.elements.iter() {
        if m22s6_identity_bearing(&e.algebraic_type, 0) {
            n += 1;
        }
    }
    n
}

// ---------------------------------------------------------------------------
// T1 / X4 — THE REGISTRY CANNOT DRIFT FROM THE MANIFEST.
// ---------------------------------------------------------------------------

/// X4 (PRV1-15 totality): the S6 row-type registry and `DATA_LIFECYCLE_MANIFEST`
/// name the SAME set of tables, with no duplicates on either side, the census
/// pinned at 40, and a non-vacuity floor on how many of the 40 are identity-bearing.
///
/// This is DISTINCT from `data_lifecycle_manifest_totality_bidirectional` (:3524),
/// which proves every LIVE TABLE has a manifest entry by scanning table-attribute
/// SOURCE TEXT. That totality test cannot see whether a classified table's row
/// STRUCT actually carries an Identity column — it has no row type in scope at all.
/// This registry closes that gap by naming row TYPES directly, so a struct rename
/// or removal is a compile error here rather than a totality test that keeps
/// passing about a table whose struct no longer exists under that name.
///
/// Kills: a registry entry for a table `DATA_LIFECYCLE_MANIFEST` no longer lists
///        (dead weight that would hide a manifest-side removal from the R1/R2/R3
///        clauses that walk the manifest, not the registry);
///        a manifest table with NO registry entry (R1/R2/R3 below cannot classify
///        it at all — this totality clause is what makes THAT omission loud rather
///        than a silent `unwrap_or_else` skip inside those tests);
///        a duplicate name on either side, which would let one accessor's verdict
///        silently shadow the other's;
///        the identity-bearing count drifting without a corresponding R1/R2/R3
///        edit — a row's columns changed shape (or this registry stopped seeing
///        them) and nobody looked.
#[test]
fn m22s6_table_row_registry_matches_manifest() {
    let registry = m22s6_table_row_types();
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;

    let mut registry_names: Vec<&str> = registry.iter().map(|(name, _)| *name).collect();
    registry_names.sort_unstable();
    for pair in registry_names.windows(2) {
        assert_ne!(
            pair[0], pair[1],
            "[m22s6/registry-dup] the S6 row-type registry names `{}` TWICE. A duplicate entry \
             would let one accessor's identity-bearing verdict silently shadow the other's in \
             every R1/R2/R3 clause below.",
            pair[0]
        );
    }

    let mut manifest_names: Vec<&str> = manifest.iter().map(|e| e.table).collect();
    manifest_names.sort_unstable();
    for pair in manifest_names.windows(2) {
        assert_ne!(
            pair[0], pair[1],
            "[m22s6/manifest-dup] DATA_LIFECYCLE_MANIFEST names `{}` TWICE. This is a manifest- \
             side defect (also caught by `data_lifecycle_manifest_totality_bidirectional`), but \
             it would break the set-equality clause below before this test could say anything \
             useful about identity coverage.",
            pair[0]
        );
    }

    assert_eq!(
        registry_names, manifest_names,
        "[m22s6/registry-vs-manifest] the S6 row-type registry and DATA_LIFECYCLE_MANIFEST do \
         not name the same set of tables. Every manifest entry needs a registered row TYPE so \
         R1/R2/R3 can classify it from the real derive metadata, and a registry entry naming a \
         table the manifest no longer lists is dead weight hiding a manifest-side removal. Add \
         or remove the missing side in the SAME commit as the schema/manifest change."
    );

    let registry_len = registry.len();
    assert_eq!(
        registry_len, 40,
        "[m22s6/registry-census] the S6 row-type registry has {registry_len} entries; the live \
         manifest carries exactly 40 (13 ERASE + 4 ANONYMIZE + 5 JOIN-ONLY + 18 NOT-OWNED, \
         schema.rs :990-992). A registry that grew or shrank without a matching manifest change \
         is a registry nobody reviewed against the schema it claims to cover."
    );

    let mut identity_bearing = 0usize;
    for (_, ty) in &registry {
        if m22s6_identity_bearing(ty, 0) {
            identity_bearing += 1;
        }
    }
    assert_eq!(
        identity_bearing, 21,
        "[m22s6/registry-identity-floor] {identity_bearing} of the 40 registered row types \
         carry an Identity column at some depth; exactly 21 is the live count (the 17 \
         cascade-classified owner-keyed tables R1 below re-derives, plus the 4 frozen NotOwned \
         exceptions R3 below names). A count that drifted without a corresponding R1/R2/R3 edit \
         means either a table's columns changed shape, or this registry stopped seeing them — \
         either way a human needs to look, not have the number silently update itself."
    );
}

// ---------------------------------------------------------------------------
// T1 / X1 — R1: OWNER-KEYED (ERASE/ANONYMIZE) => AT LEAST ONE IDENTITY COLUMN.
// ---------------------------------------------------------------------------

/// X1 (PRV1-15 / R1): every `DATA_LIFECYCLE_MANIFEST` entry classified `Erase` or
/// `Anonymize` proves, from its row struct's OWN SpacetimeDB derive metadata, that
/// it declares at least one direct `Identity` column at any depth.
///
/// The `match` on `entry.policy` is EXHAUSTIVE with no wildcard arm: a new
/// `DeletionPolicy` variant is a compile error here, forcing a conscious decision
/// about whether the new variant is owner-keyed, rather than a silent fall-through.
///
/// Kills: `schema.rs` reclassifying an owner-keyed table (say `monster`) to
///        `NotOwned` — R1's population count catches the reclassification directly
///        (M1, the plan's registered mutation), and even before that, a table with
///        a real owner column classified `NotOwned` is exactly the hole PRV1-15's
///        "with a direct Identity column" clause exists to close (R3 below closes
///        it from the OTHER direction: an owner-keyed table hiding inside
///        `NotOwned`);
///        a table classified `Erase`/`Anonymize` whose row struct is later edited
///        to drop its only Identity column (a table classified for owner-keyed
///        erasure with no owner key cannot be swept by ANY per-owner cascade step —
///        its rows would survive every account deletion silently, forever);
///        a population count that silently grows or shrinks without a matching
///        reclassification (the exact-17 pin below, mirroring the file's own `==`
///        tightening precedent on `m22s3b_cascade_covers_manifest`).
#[test]
fn m22s6_owner_keyed_tables_are_erase_or_anonymize() {
    let registry = m22s6_table_row_types();
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;

    let mut population = 0usize;
    for entry in manifest {
        let table = entry.table;
        let is_owner_keyed = match entry.policy {
            DeletionPolicy::Erase => true,
            DeletionPolicy::Anonymize => true,
            DeletionPolicy::ViaJoin(_) => false,
            DeletionPolicy::NotOwned => false,
        };
        if !is_owner_keyed {
            continue;
        }
        population += 1;

        let (_, ty) = registry
            .iter()
            .find(|(name, _)| *name == table)
            .unwrap_or_else(|| {
                panic!(
                    "[m22s6/x1-unregistered] `{table}` is classified Erase/Anonymize but has no \
                 entry in the S6 row-type registry — `m22s6_table_row_registry_matches_manifest` \
                 should have caught this drift first; run it to find the missing entry."
                )
            });
        let n = m22s6_identity_column_count(table, ty);
        assert!(
            n >= 1,
            "[m22s6/x1-no-identity-column] `{table}` is classified Erase or Anonymize but its \
             row struct carries ZERO Identity columns at any depth (checked via the real derive \
             metadata, not source text). A table classified for owner-keyed erasure with no \
             owner key cannot be swept by ANY per-owner cascade step, however the cascade is \
             wired — its rows would survive every account deletion, forever, with every other \
             gate in the tree reporting green."
        );
    }
    assert_eq!(
        population, 17,
        "[m22s6/x1-population] {population} manifest entries are classified Erase or Anonymize; \
         the live partition is exactly 17 (13 ERASE + 4 ANONYMIZE — schema.rs's own count at \
         :990). A floor would let this population grow silently; an exact count forces a \
         conscious edit to this test alongside any reclassification."
    );
}

// ---------------------------------------------------------------------------
// T1 / X2 — R2: VIAJOIN => EXACTLY ZERO IDENTITY COLUMNS, NO EXCEPTIONS.
// ---------------------------------------------------------------------------

/// X2 (PRV1-15 / R2): every `DATA_LIFECYCLE_MANIFEST` entry classified
/// `ViaJoin(parent)` proves, from the real derive metadata, that its row struct
/// declares EXACTLY ZERO `Identity` columns at any depth — the `DeletionPolicy::
/// ViaJoin` doc comment ("No Identity column; swept transitively via the named
/// parent table", schema.rs :960) stated as a checked fact, with NO exception list.
///
/// No exception list is deliberate, unlike R3: a `ViaJoin` table is invisible to
/// the per-owner cascade BY DESIGN (it is swept only through its parent's step), so
/// an Identity column here is never a defensible exception — it is always either a
/// misclassification (reclassify Erase/Anonymize) or a genuine, silent per-owner
/// leak across every account deletion.
///
/// Kills: `schema.rs` adding an `Option<Identity>` field to a `ViaJoin` table (the
///        plan's registered mutation M2, on `Character`) — the SHALLOW
///        `is_identity()` check would not see it (`Option<Identity>` lowers to a
///        `Sum`), so only the deep walk in `m22s6_identity_bearing` catches it;
///        a `ViaJoin` table whose row struct is edited to wrap its parent's key in
///        a `#[derive(SpacetimeType)]` newtype containing an `Identity` (a
///        differently-named `Product`, also invisible to the shallow check);
///        a population count that silently grows or shrinks (the exact-5 pin).
#[test]
fn m22s6_via_join_tables_carry_no_identity_column() {
    let registry = m22s6_table_row_types();
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;

    let mut population = 0usize;
    for entry in manifest {
        let table = entry.table;
        let is_via_join = match entry.policy {
            DeletionPolicy::Erase => false,
            DeletionPolicy::Anonymize => false,
            DeletionPolicy::ViaJoin(_) => true,
            DeletionPolicy::NotOwned => false,
        };
        if !is_via_join {
            continue;
        }
        population += 1;

        let (_, ty) = registry
            .iter()
            .find(|(name, _)| *name == table)
            .unwrap_or_else(|| {
                panic!(
                    "[m22s6/x2-unregistered] `{table}` is classified ViaJoin but has no entry in \
                 the S6 row-type registry — `m22s6_table_row_registry_matches_manifest` should \
                 have caught this drift first."
                )
            });
        let n = m22s6_identity_column_count(table, ty);
        assert_eq!(
            n, 0,
            "[m22s6/x2-unexpected-identity] `{table}` is classified ViaJoin(_) — its own doc \
             comment says 'No Identity column; swept transitively via the named parent table' — \
             but its row struct carries {n} Identity column(s) at some depth. A ViaJoin table \
             with a real owner key is skipped by every per-owner cascade step (it is swept ONLY \
             via its parent), so an Identity column here is a genuine, silent per-owner data \
             leak across every single account deletion. NO EXCEPTION LIST for this arm: \
             reclassify the table Erase/Anonymize instead of carving out a fifth exception."
        );
    }
    assert_eq!(
        population, 5,
        "[m22s6/x2-population] {population} manifest entries are classified ViaJoin; the live \
         set is exactly 5 (character, battle_wild, pvp_deadline_schedule, \
         battle_challenge_reaper_schedule, trade_offer_reaper_schedule)."
    );
}

// ---------------------------------------------------------------------------
// T1 / X3 — R3: NOTOWNED => ZERO IDENTITY COLUMNS, EXCEPT A FROZEN FOUR.
// ---------------------------------------------------------------------------

/// X3 (PRV1-15 / R3): every `DATA_LIFECYCLE_MANIFEST` entry classified `NotOwned`
/// proves it declares zero direct `Identity` columns at any depth, EXCEPT a
/// census-pinned four-table exception set (`config`, `guest_claim`,
/// `guest_claim_reaper_schedule`, `account_deletion_reaper_schedule`) — each of
/// which already carries a deliberate `basis`. A FIFTH identity-bearing `NotOwned`
/// table fails this test outright and forces a human classification decision,
/// exactly as PRV1-15 / R3 demands.
///
/// The frozen set is ITSELF a residual, named rather than papered over (ADR-0229's
/// own "Residual" section): it is a declared fact living in this test file, so one
/// self-consistent commit CAN add a genuinely owner-keyed `NotOwned` table by
/// registering its row type, appending its accessor to the frozen array below, and
/// bumping BOTH the exception census and the `NotOwned` population count. That is
/// not closable in-test — it is why the last loop below re-checks every frozen name
/// against the LIVE manifest, so a stale exception (naming a removed or renamed
/// table) cannot linger unnoticed once nothing exercises it any more.
///
/// Kills: a new owner-keyed table added to `NotOwned` by accident (a `NotOwned`
///        table whose column set the author never checked against a
///        classification) — this is the single largest deletion-completeness hole
///        measured in the plan's red-team: it satisfies manifest totality (it has
///        an entry) and the basis floor (prose is prose), and is then SKIPPED
///        OUTRIGHT by `m22s3b_cascade_covers_manifest`'s `needs_cascade = false`
///        arm, so its rows silently survive every account deletion forever;
///        one of the frozen four losing its Identity column entirely (the basis
///        prose justifying its exception may now be stale — the exception census
///        would drop below 4 and this test would say so, not silently absorb it);
///        a frozen exception naming a table since removed or renamed from the live
///        manifest (the trailing loop).
#[test]
fn m22s6_not_owned_identity_exceptions_are_frozen() {
    let registry = m22s6_table_row_types();
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;

    let frozen_exceptions: [&str; 4] = [
        "config",
        "guest_claim",
        "guest_claim_reaper_schedule",
        concat!("account_deletion_reaper", "_schedule"),
    ];

    let mut population = 0usize;
    let mut observed_exceptions: Vec<&str> = Vec::new();
    for entry in manifest {
        let table = entry.table;
        let is_not_owned = match entry.policy {
            DeletionPolicy::Erase => false,
            DeletionPolicy::Anonymize => false,
            DeletionPolicy::ViaJoin(_) => false,
            DeletionPolicy::NotOwned => true,
        };
        if !is_not_owned {
            continue;
        }
        population += 1;

        let (_, ty) = registry
            .iter()
            .find(|(name, _)| *name == table)
            .unwrap_or_else(|| {
                panic!(
                    "[m22s6/x3-unregistered] `{table}` is classified NotOwned but has no entry in \
                 the S6 row-type registry — `m22s6_table_row_registry_matches_manifest` should \
                 have caught this drift first."
                )
            });
        let n = m22s6_identity_column_count(table, ty);
        if n == 0 {
            continue;
        }
        assert!(
            frozen_exceptions.contains(&table),
            "[m22s6/x3-unfrozen-identity] `{table}` is classified NotOwned but its row struct \
             carries {n} Identity column(s) at some depth, and `{table}` is NOT one of the four \
             frozen exceptions (config, guest_claim, guest_claim_reaper_schedule, \
             account_deletion_reaper_schedule). A NotOwned table with a real owner key is \
             skipped OUTRIGHT by the cascade walk (`m22s3b_cascade_covers_manifest`'s \
             `needs_cascade = false` arm), so its rows survive every account deletion silently \
             — this is the single largest deletion-completeness hole PRV1-15's 'with a direct \
             Identity column' clause exists to close. Either reclassify `{table}` \
             Erase/Anonymize/ViaJoin, or — if it is genuinely a deliberate exception like the \
             frozen four — that is a PRIVACY-CLASSIFICATION DECISION for a human reviewer, not \
             a test-maintenance edit: bump the frozen array AND the population/exception counts \
             below in the SAME commit."
        );
        observed_exceptions.push(table);
    }

    assert_eq!(
        population, 18,
        "[m22s6/x3-population] {population} manifest entries are classified NotOwned; the live \
         set is exactly 18 (spec §3's seventeen plus rb-24's own \
         account_deletion_reaper_schedule, schema.rs :990-992)."
    );

    let observed_len = observed_exceptions.len();
    assert_eq!(
        observed_len, 4,
        "[m22s6/x3-exception-census] {observed_len} NotOwned table(s) were observed carrying an \
         Identity column; exactly 4 is the frozen count. FEWER than 4 means one of the frozen \
         four no longer needs its exception (its basis prose describing WHY it is exempt may \
         now be stale — a human should re-read it, not just shrink this number); MORE than 4 is \
         structurally impossible to reach here — the loop above would already have panicked on \
         the fifth unfrozen table before this assertion ever ran."
    );

    for name in frozen_exceptions {
        let still_live = manifest.iter().any(|e| e.table == name);
        assert!(
            still_live,
            "[m22s6/x3-stale-exception] the frozen exception `{name}` no longer appears in the \
             live DATA_LIFECYCLE_MANIFEST at all. A stale exception naming a removed or renamed \
             table can never be exercised by the loop above (nothing in the manifest matches it \
             any more) and would linger here unnoticed forever; drop it from the frozen array in \
             the same commit that removed or renamed the table."
        );
    }
}

// ---------------------------------------------------------------------------
// T2 / X5 — THE MANIFEST REACHES THE FAR END OF THE DELEGATED CASCADE.
// ---------------------------------------------------------------------------

/// One row of the T2/X5 cascade-chain map: which entry helper (module source +
/// declaration needle) reaches `table` from the pinned reaper body, and — for the
/// three tables reachable only through a second hop (ADR-0228) — the sub-helper's
/// own module/declaration/call-needle.
struct M22s6ChainEntry {
    table: &'static str,
    /// `true` ONLY for `account`: no separate helper exists for it (the cascade
    /// tombstones `auth_issuer` directly inside `account_deletion_reaper`'s own
    /// body, via `anonymized_account` + the sanctioned `ctx.db.account()...
    /// update(...)`), so the reaper body itself IS the terminal body and the
    /// entry-declaration / reaper-call-needle / declaration-uniqueness clauses
    /// below are skipped for exactly this one row — the plan's own carve-out.
    inline_in_reaper: bool,
    entry_module_src: &'static str,
    entry_module_label: &'static str,
    /// Squashed declaration needle, e.g. `"fnerase_monsters("`. Empty for the
    /// `inline_in_reaper` row (unused).
    entry_decl: String,
    /// The needle naming this helper INSIDE the pinned reaper body — reused
    /// directly from the `m22s3b_nd_*` fns above rather than re-transcribed, so
    /// there is no second spelling of the same call site to drift out of sync.
    /// Empty for the `inline_in_reaper` row (unused).
    entry_call_in_reaper: String,
    via: Option<M22s6ViaHop>,
}

/// The optional second hop: a sub-helper the entry helper delegates to, which is
/// where `table`'s OWN accessor is actually touched (`trade_offer_reaper_schedule`
/// via `disarm_trade_reaper`, `battle_challenge_reaper_schedule` via
/// `disarm_challenge_reaper`, `pvp_deadline_schedule` via `disarm_pvp_deadlines`).
struct M22s6ViaHop {
    module_src: &'static str,
    module_label: &'static str,
    decl: String,
    /// The needle naming this sub-helper INSIDE the entry helper's own body.
    call_in_entry_body: String,
}

fn m22s6_nd_erase_monsters_decl() -> String {
    concat!("fnerase", "_monsters(").to_string()
}
fn m22s6_nd_erase_inventory_decl() -> String {
    concat!("fnerase", "_inventory(").to_string()
}
fn m22s6_nd_erase_npc_state_decl() -> String {
    concat!("fnerase_npc", "_state(").to_string()
}
fn m22s6_nd_erase_heal_cooldown_decl() -> String {
    concat!("fnerase_heal", "_cooldown(").to_string()
}
fn m22s6_nd_erase_wallet_decl() -> String {
    concat!("fnerase", "_wallet(").to_string()
}
fn m22s6_nd_erase_playtest_events_decl() -> String {
    concat!("fnerase_playtest", "_events(").to_string()
}
fn m22s6_nd_erase_trade_offers_decl() -> String {
    concat!("fnerase_trade", "_offers(").to_string()
}
fn m22s6_nd_disarm_trade_reaper_decl() -> String {
    concat!("fndisarm_trade", "_reaper(").to_string()
}
fn m22s6_nd_disarm_trade_reaper_call() -> String {
    concat!("disarm_trade", "_reaper(").to_string()
}
fn m22s6_nd_erase_pvp_rows_decl() -> String {
    concat!("fnerase_pvp", "_rows(").to_string()
}
fn m22s6_nd_disarm_challenge_reaper_decl() -> String {
    concat!("fndisarm_challenge", "_reaper(").to_string()
}
fn m22s6_nd_disarm_challenge_reaper_call() -> String {
    concat!("disarm_challenge", "_reaper(").to_string()
}
fn m22s6_nd_purge_export_bundles_decl() -> String {
    concat!("fnpurge_export", "_bundles(").to_string()
}
fn m22s6_nd_erase_character_rows_decl() -> String {
    concat!("fnerase_character", "_rows(").to_string()
}
fn m22s6_nd_anonymize_display_names_decl() -> String {
    concat!("fnanonymize_display", "_names(").to_string()
}
fn m22s6_nd_anonymize_battles_decl() -> String {
    concat!("fnanonymize", "_battles(").to_string()
}
fn m22s6_nd_disarm_pvp_deadlines_decl() -> String {
    concat!("fndisarm_pvp", "_deadlines(").to_string()
}
fn m22s6_nd_disarm_pvp_deadlines_call() -> String {
    concat!("crate::pvp::disarm_pvp", "_deadlines(").to_string()
}

/// The manifest-driven chain map itself: one row per classified table (22),
/// AUTHORED FROM THE PLAN (ADR-0228's own delegation map), never derived by
/// printing what an implementation produced.
fn m22s6_cascade_chain() -> Vec<M22s6ChainEntry> {
    vec![
        M22s6ChainEntry {
            table: "monster",
            inline_in_reaper: false,
            entry_module_src: MONSTER_MGMT_RS,
            entry_module_label: "monster_mgmt.rs",
            entry_decl: m22s6_nd_erase_monsters_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_monsters(),
            via: None,
        },
        M22s6ChainEntry {
            table: "monster_pub",
            inline_in_reaper: false,
            entry_module_src: MONSTER_MGMT_RS,
            entry_module_label: "monster_mgmt.rs",
            entry_decl: m22s6_nd_erase_monsters_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_monsters(),
            via: None,
        },
        M22s6ChainEntry {
            table: "inventory",
            inline_in_reaper: false,
            entry_module_src: M22_INVENTORY_RS,
            entry_module_label: "inventory.rs",
            entry_decl: m22s6_nd_erase_inventory_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_inventory(),
            via: None,
        },
        M22s6ChainEntry {
            table: "player_dialogue_state",
            inline_in_reaper: false,
            entry_module_src: M22_NPC_RS,
            entry_module_label: "npc.rs",
            entry_decl: m22s6_nd_erase_npc_state_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_npc_state(),
            via: None,
        },
        M22s6ChainEntry {
            table: "player_quest",
            inline_in_reaper: false,
            entry_module_src: M22_NPC_RS,
            entry_module_label: "npc.rs",
            entry_decl: m22s6_nd_erase_npc_state_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_npc_state(),
            via: None,
        },
        M22s6ChainEntry {
            table: "player_conversation",
            inline_in_reaper: false,
            entry_module_src: M22_NPC_RS,
            entry_module_label: "npc.rs",
            entry_decl: m22s6_nd_erase_npc_state_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_npc_state(),
            via: None,
        },
        M22s6ChainEntry {
            table: "heal_cooldown",
            inline_in_reaper: false,
            entry_module_src: M22_RAISING_RS,
            entry_module_label: "raising.rs",
            entry_decl: m22s6_nd_erase_heal_cooldown_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_heal_cooldown(),
            via: None,
        },
        M22s6ChainEntry {
            table: concat!("player", "_wallet"),
            inline_in_reaper: false,
            entry_module_src: M22_ECONOMY_RS,
            entry_module_label: "economy.rs",
            entry_decl: m22s6_nd_erase_wallet_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_wallet(),
            via: None,
        },
        M22s6ChainEntry {
            table: "playtest_event",
            inline_in_reaper: false,
            entry_module_src: M22_PLAYTEST_RS,
            entry_module_label: "playtest.rs",
            entry_decl: m22s6_nd_erase_playtest_events_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_playtest_events(),
            via: None,
        },
        M22s6ChainEntry {
            table: "trade_offer",
            inline_in_reaper: false,
            entry_module_src: M22_TRADING_RS,
            entry_module_label: "trading.rs",
            entry_decl: m22s6_nd_erase_trade_offers_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_trade_offers(),
            via: None,
        },
        M22s6ChainEntry {
            table: "trade_offer_reaper_schedule",
            inline_in_reaper: false,
            entry_module_src: M22_TRADING_RS,
            entry_module_label: "trading.rs",
            entry_decl: m22s6_nd_erase_trade_offers_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_trade_offers(),
            via: Some(M22s6ViaHop {
                module_src: M22_TRADING_RS,
                module_label: "trading.rs",
                decl: m22s6_nd_disarm_trade_reaper_decl(),
                call_in_entry_body: m22s6_nd_disarm_trade_reaper_call(),
            }),
        },
        M22s6ChainEntry {
            table: "battle_challenge",
            inline_in_reaper: false,
            entry_module_src: M22_PVP_RS,
            entry_module_label: "pvp.rs",
            entry_decl: m22s6_nd_erase_pvp_rows_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_pvp_rows(),
            via: None,
        },
        M22s6ChainEntry {
            table: "battle_action",
            inline_in_reaper: false,
            entry_module_src: M22_PVP_RS,
            entry_module_label: "pvp.rs",
            entry_decl: m22s6_nd_erase_pvp_rows_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_pvp_rows(),
            via: None,
        },
        M22s6ChainEntry {
            table: "battle_challenge_reaper_schedule",
            inline_in_reaper: false,
            entry_module_src: M22_PVP_RS,
            entry_module_label: "pvp.rs",
            entry_decl: m22s6_nd_erase_pvp_rows_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_pvp_rows(),
            via: Some(M22s6ViaHop {
                module_src: M22_PVP_RS,
                module_label: "pvp.rs",
                decl: m22s6_nd_disarm_challenge_reaper_decl(),
                call_in_entry_body: m22s6_nd_disarm_challenge_reaper_call(),
            }),
        },
        M22s6ChainEntry {
            table: "export_bundle",
            inline_in_reaper: false,
            entry_module_src: M22_PRIVACY_RS,
            entry_module_label: "privacy.rs",
            entry_decl: m22s6_nd_purge_export_bundles_decl(),
            entry_call_in_reaper: m22s3b_nd_purge_bundles(),
            via: None,
        },
        M22s6ChainEntry {
            table: "character",
            inline_in_reaper: false,
            entry_module_src: LIB_RS,
            entry_module_label: "lib.rs",
            entry_decl: m22s6_nd_erase_character_rows_decl(),
            entry_call_in_reaper: m22s3b_nd_erase_character_rows(),
            via: None,
        },
        M22s6ChainEntry {
            table: "player",
            inline_in_reaper: false,
            entry_module_src: RANKING_RS,
            entry_module_label: "ranking.rs",
            entry_decl: m22s6_nd_anonymize_display_names_decl(),
            entry_call_in_reaper: m22s3b_nd_anonymize_names(),
            via: None,
        },
        M22s6ChainEntry {
            table: "profile",
            inline_in_reaper: false,
            entry_module_src: RANKING_RS,
            entry_module_label: "ranking.rs",
            entry_decl: m22s6_nd_anonymize_display_names_decl(),
            entry_call_in_reaper: m22s3b_nd_anonymize_names(),
            via: None,
        },
        M22s6ChainEntry {
            table: "battle",
            inline_in_reaper: false,
            entry_module_src: M22_BATTLE_RS,
            entry_module_label: "battle.rs",
            entry_decl: m22s6_nd_anonymize_battles_decl(),
            entry_call_in_reaper: m22s3b_nd_anonymize_battles(),
            via: None,
        },
        M22s6ChainEntry {
            table: "battle_wild",
            inline_in_reaper: false,
            entry_module_src: M22_BATTLE_RS,
            entry_module_label: "battle.rs",
            entry_decl: m22s6_nd_anonymize_battles_decl(),
            entry_call_in_reaper: m22s3b_nd_anonymize_battles(),
            via: None,
        },
        M22s6ChainEntry {
            table: "pvp_deadline_schedule",
            inline_in_reaper: false,
            entry_module_src: M22_BATTLE_RS,
            entry_module_label: "battle.rs",
            entry_decl: m22s6_nd_anonymize_battles_decl(),
            entry_call_in_reaper: m22s3b_nd_anonymize_battles(),
            via: Some(M22s6ViaHop {
                module_src: M22_PVP_RS,
                module_label: "pvp.rs",
                decl: m22s6_nd_disarm_pvp_deadlines_decl(),
                call_in_entry_body: m22s6_nd_disarm_pvp_deadlines_call(),
            }),
        },
        M22s6ChainEntry {
            table: "account",
            inline_in_reaper: true,
            entry_module_src: ACCOUNTS_RS,
            entry_module_label: "accounts.rs",
            entry_decl: String::new(),
            entry_call_in_reaper: String::new(),
            via: None,
        },
    ]
}

/// Statement-scoped terminal-body check, T2/X5's core primitive: true if `body`
/// (an ALREADY-SQUASHED fn body) contains at least one occurrence of
/// `accessor_call` (`.{table}(`) immediately followed, before the next `;` OR
/// `{` (whichever comes first), by a mutating call (`.delete(` or `.update(`).
///
/// A body-wide "contains the accessor AND contains a mutation" conjunction is a
/// MEASURED bypass (the plan's red-team, mutant M4 below): `erase_monsters` is
/// the entry helper for BOTH `monster` and `monster_pub`, so replacing
/// `ctx.db.monster_pub().monster_id().delete(id);` with a `.find(id)` read keeps
/// the `monster_pub` ACCESSOR present in the body and borrows the `.delete(` from
/// the sibling `monster` line two statements above — a body-wide conjunction is
/// green on that swap while every `monster_pub` row of every deleted account
/// survives forever. Scoping to the SAME statement (this accessor occurrence's
/// own span, up to the next `;`) closes it: under the swap, `monster_pub`'s only
/// occurrence's span holds `.find(` and never `.delete(`/`.update(`.
///
/// STOPPING AT `{` TOO (not just `;`) is a second, independently-measured
/// correction over the naive "next `;`" rule: `anonymize_display_names` opens
/// with `for p in ctx.db.player().identity().find(owner).into_iter() { ... }` —
/// a `for`-loop HEADER carries no `;` of its own before its `{`, so a scan that
/// only stops at `;` would walk straight through the (empty, on a mutant that
/// deleted the loop body's `.update(...)`) braces and keep going into the NEXT
/// statement, crediting `player` with the UNRELATED `profile` update two
/// statements later — a false pass on a real deletion. Stopping at whichever of
/// `;`/`{` comes first treats the loop header's own iterator expression as its
/// own scope, so a body-wide read there is correctly NOT credited with a
/// mutation two statements away; the real mutating statement inside the loop
/// body is then found and scored on its OWN merits by a later occurrence of the
/// same accessor token.
fn m22s6_accessor_mutated_in_statement(body: &str, accessor_call: &str) -> bool {
    let mut start = 0usize;
    while let Some(rel) = body[start..].find(accessor_call) {
        let at = start + rel;
        let rest = &body[at..];
        let semi = rest.find(';');
        let brace = rest.find('{');
        let end_rel = match (semi, brace) {
            (Some(s), Some(b)) => s.min(b),
            (Some(s), None) => s,
            (None, Some(b)) => b,
            (None, None) => rest.len(),
        };
        let span = &rest[..end_rel];
        if span.contains(".delete(") || span.contains(".update(") {
            return true;
        }
        start = at + accessor_call.len();
    }
    false
}

/// X5 (PRV1-16): every `DATA_LIFECYCLE_MANIFEST` entry classified `Erase`,
/// `Anonymize` or `ViaJoin` proves an end-to-end chain from the pinned reaper
/// body, through its entry helper, through at most one declared `via` sub-helper,
/// to a body that names that table's own accessor AND performs a mutating call —
/// in the SAME statement (see `m22s6_accessor_mutated_in_statement`).
///
/// FOUR CLAUSES PER ROW, each independently load-bearing:
///   1. the table appears in `m22s6_cascade_chain()` at all — an unmapped
///      classified table PANICS rather than being skipped: an unmapped table is
///      an unerased table (fail loud, per ADR-0229 / the same posture
///      `m22s3b_cascade_covers_manifest` already takes one hop earlier);
///   2. the entry helper's declaration occurs EXACTLY ONCE in its module — a
///      first-hit `find()` over a decoy second declaration is a steerable anchor
///      this repo has measured before (memory: "First-hit anchors are
///      forgeable");
///   3. the reaper's own pinned body contains the entry helper's call needle —
///      chains this row to the ALREADY-EXACT-PINNED reaper body
///      (`rb24_deletion_reaper_body_is_pinned_cascade`), so a call dropped from
///      the cascade is caught here even if nothing else in this test file
///      changed;
///   4. the TERMINAL body (the entry helper's own body, or its `via` sub-helper's
///      body when one is declared) names the table's accessor with a mutation in
///      the same statement.
///
/// `account` is special-cased (see `M22s6ChainEntry::inline_in_reaper`): no
/// separate helper exists, so clauses 2-3 are skipped and clause 4 runs directly
/// against the reaper body.
///
/// Kills: an unmapped classified table (M3-adjacent: dropping a table's cascade
///        wiring without also dropping its manifest entry) — this test panics
///        rather than silently passing about a table nobody checked;
///        `crate::inventory::erase_inventory(ctx, args.account_identity);` deleted
///        from the reaper cascade body (the plan's mutant M3) — clause 3 fails:
///        the entry helper's call needle is no longer in the pinned reaper body;
///        `ctx.db.monster_pub().monster_id().delete(id);` replaced with
///        `let _ = ctx.db.monster_pub().monster_id().find(id);` (the plan's
///        mutant M4, the red-team's measured bypass of an unscoped accessor+
///        mutation conjunction) — clause 4 fails FOR `monster_pub` specifically
///        (its only accessor occurrence's statement-scoped span now holds
///        `.find(` and neither `.delete(` nor `.update(`), even though `monster`
///        two lines above still passes and a body-wide conjunction would have
///        stayed green;
///        a declared `via` hop the entry helper never actually calls (an
///        orphaned schedule row every time the entry helper runs);
///        a decoy second declaration of an entry helper or sub-helper anywhere
///        in its module (clause 2/the via-decl-unique clause).
#[test]
fn m22s6_cascade_chain_reaches_every_classified_table() {
    let chain = m22s6_cascade_chain();
    let squashed_accounts = stripped_for_scan(ACCOUNTS_RS);
    let reaper_body = extract_squashed_fn_body(&squashed_accounts, &rb24_nd_reaper_decl()).expect(
        "[m22s6/reaper-scope] fn account_deletion_reaper was not found in accounts.rs, so \
             the whole chain proof below has no reaper body to check against.",
    );

    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;
    let mut classified = 0usize;
    for entry in manifest {
        let table = entry.table;
        let needs_chain = match entry.policy {
            DeletionPolicy::Erase => true,
            DeletionPolicy::Anonymize => true,
            DeletionPolicy::ViaJoin(_) => true,
            DeletionPolicy::NotOwned => false,
        };
        if !needs_chain {
            continue;
        }
        classified += 1;

        let chain_entry = chain.iter().find(|c| c.table == table).unwrap_or_else(|| {
            panic!(
                "[m22s6/chain-unmapped] DATA_LIFECYCLE_MANIFEST classifies `{table}` for the \
                 cascade, but this test's cascade-chain map does not name it. Under delegation \
                 the reaper body names HELPERS, not table identifiers, so an unmapped table has \
                 no proof anywhere that it is ever erased. Fail LOUD rather than skip: an \
                 unmapped classified table is an unerased table."
            )
        });

        let accessor_call = format!(".{table}(");

        if chain_entry.inline_in_reaper {
            assert!(
                m22s6_accessor_mutated_in_statement(reaper_body, &accessor_call),
                "[m22s6/terminal-not-mutated] `{table}` has no separate entry helper — it is \
                 handled inline in account_deletion_reaper's own body — but no occurrence of \
                 `{accessor_call}` in the reaper body is followed, within the SAME statement, by \
                 `.delete(` or `.update(`. The row this cascade step is supposed to tombstone is \
                 never actually written."
            );
            continue;
        }

        let squashed_entry_mod = stripped_for_scan(chain_entry.entry_module_src);
        let n_decl = m22_count_occurrences(&squashed_entry_mod, &chain_entry.entry_decl);
        let decl = &chain_entry.entry_decl;
        let module = chain_entry.entry_module_label;
        assert_eq!(
            n_decl, 1,
            "[m22s6/entry-decl-unique] the entry helper for `{table}` ({decl:?}) must be \
             declared EXACTLY once in {module}; found {n_decl}. A decoy second declaration is a \
             steerable first-hit anchor for the body extraction below."
        );

        let call = &chain_entry.entry_call_in_reaper;
        assert!(
            reaper_body.contains(call.as_str()),
            "[m22s6/entry-unreached] the manifest classifies `{table}` for the cascade via the \
             entry helper {decl:?} in {module}, and this map routes it through the reaper call \
             `{call}` — which `account_deletion_reaper`'s pinned body does NOT contain. A \
             classified table whose entry helper the reaper never calls is simply never erased: \
             its rows survive account deletion silently, and nothing else in the tree looks \
             wrong."
        );

        let entry_body = extract_squashed_fn_body(&squashed_entry_mod, &chain_entry.entry_decl)
            .unwrap_or_else(|| {
                panic!(
                    "[m22s6/entry-body-scope] the body of the entry helper for `{table}` \
                     ({decl:?}) in {module} could not be brace-extracted, so the terminal-body \
                     clause below would have no scope and would pass vacuously."
                )
            });

        let (terminal_body, terminal_module_label): (String, &'static str) = match &chain_entry.via
        {
            None => (entry_body.to_string(), chain_entry.entry_module_label),
            Some(via) => {
                let via_call = &via.call_in_entry_body;
                let via_decl = &via.decl;
                let via_module = via.module_label;
                assert!(
                    entry_body.contains(via_call.as_str()),
                    "[m22s6/via-unreached] `{table}` is routed via the sub-helper \
                         {via_decl:?} in {via_module}, but the entry helper's own body does not \
                         call it ({via_call:?}). A declared via-hop the entry helper never \
                         reaches leaves the child schedule row orphaned every time the entry \
                         helper runs."
                );
                let squashed_via_mod = stripped_for_scan(via.module_src);
                let n_via_decl = m22_count_occurrences(&squashed_via_mod, &via.decl);
                assert_eq!(
                    n_via_decl, 1,
                    "[m22s6/via-decl-unique] the sub-helper for `{table}` ({via_decl:?}) \
                         must be declared EXACTLY once in {via_module}; found {n_via_decl}."
                );
                let via_body = extract_squashed_fn_body(&squashed_via_mod, &via.decl)
                    .unwrap_or_else(|| {
                        panic!(
                            "[m22s6/via-body-scope] the body of the sub-helper for `{table}` \
                                 ({via_decl:?}) in {via_module} could not be brace-extracted."
                        )
                    });
                (via_body.to_string(), via.module_label)
            }
        };

        assert!(
            m22s6_accessor_mutated_in_statement(&terminal_body, &accessor_call),
            "[m22s6/terminal-not-mutated] `{table}`'s terminal body (in {terminal_module_label}) \
             contains no occurrence of `{accessor_call}` immediately followed — within the SAME \
             statement, before the next `;` — by `.delete(` or `.update(`. This is the \
             red-team's measured bypass: `erase_monsters` is the entry helper for BOTH `monster` \
             and `monster_pub`, so swapping `monster_pub`'s `.delete(id);` for a `.find(id)` \
             read keeps the accessor present and borrows the sibling `monster` line's `.delete(` \
             for a body-wide conjunction, while every `monster_pub` row of every deleted account \
             survives forever. A missing mutation here means `{table}`'s rows are READ, never \
             WRITTEN — the table is never actually swept."
        );
    }

    assert_eq!(
        classified, 22,
        "[m22s6/chain-census] {classified} manifest entries are classified for the cascade \
         (Erase/Anonymize/ViaJoin); EXACTLY 22 is the live partition (13 ERASE + 4 ANONYMIZE + 5 \
         JOIN-ONLY). A floor would let this grow silently past the cascade-chain map's coverage; \
         an exact count forces a conscious map edit alongside any reclassification."
    );
}
