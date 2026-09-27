//! `privacy_tests` — behavioural tests for `privacy.rs`: the data-export
//! serializer and manifest totality (M22-S4), the export-bundle reap planners
//! and their tick records, export admission tiers,
//! and the observation-line envelopes.
//!
//! Declared from `privacy.rs` as a cfg-test-gated `#[path]` module, so `super`
//! resolves to `privacy`. The reducer-level export owner scope, admission and
//! the reaper's scheduler guard are exercised natively in `accounts_tests.rs`
//! (`acct_export_*`).

#![cfg(test)]

// ===========================================================================
// Scan machinery (local copies of the accounts_tests.rs helpers, verbatim).
// strings -> comments -> squash_ws.
// ===========================================================================

/// Blank the CONTENT (and delimiters) of string literals with spaces. Must run
/// BEFORE `strip_rust_comments`.
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

/// Blank block and line comments with spaces. Run AFTER `strip_rust_strings`.
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
/// squashed.
fn stripped_for_scan(src: &str) -> String {
    squash_ws(&strip_rust_comments(&strip_rust_strings(src)))
}

/// Extract the brace-bounded body of a fn from an ALREADY-squashed source.
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

/// Extract the squashed signature slice (fn_needle .. first open brace).
fn extract_squashed_fn_sig<'a>(squashed: &'a str, fn_needle: &str) -> Option<&'a str> {
    let fn_start = squashed.find(fn_needle)?;
    let after = &squashed[fn_start..];
    let brace_rel = after.find('{')?;
    Some(&squashed[fn_start..fn_start + brace_rel])
}

/// Non-overlapping occurrences of `needle` in `hay`.
fn rb22p_count(hay: &str, needle: &str) -> usize {
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

// ===========================================================================
// Sources under test, and the frozen contract.
// ===========================================================================

const PRIVACY_RS: &str = include_str!("privacy.rs");
/// A literal double quote built from its byte, so this file carries neither a
/// `\` escape before a quote nor a quote inside a char literal.
fn rb22p_dq() -> char {
    char::from(34u8)
}

// ===========================================================================
// EXPORT GATING TESTS (PRV1-11 / PRV1-12 / PRV1-13 + the S4 security
// amendments).
// every symbol below carries the `m22s4_` / `M22S4_` prefix so it can never
// collide with an `rb22p_` helper.
//
// WHAT THIS GATES (spec M22 section 5):
//   PRV1-11  one chunk per exportable:true table, own rows only, per-column JSON.
//   PRV1-12  no exportable:false table is ever named by the export machinery.
//   PRV1-13  sub-chunking at game_core::EXPORT_CHUNK_ROWS, request-wide
//            chunk_index and total_chunks.
//   plus the S4 guards (subject existence, deletion gate, cooldown), the battle
//   redaction, and the owner-scoped view that is the entire client read path.
//   PRV1-14 (the TTL reaper) LANDED in rb-48 and is gated by the
//   rb48_ block at the end of this file: a global hourly interval singleton, a
//   scheduler-only reducer, and the pure plan_export_reap seam that carries the
//   whole behavioural proof.
//
// THE SPLIT: a ReducerContext was not constructible off-instance when
// this was written (rb-41's native_host_tests changed that; the scans stand as written),
// so every PURE seam below is EXECUTED and every ctx-bound shell property is a
// SOURCE-STRUCTURE pin over PRIVACY_RS through this module's existing
// three-stage strip pipeline. Source pins are the weaker instrument and each
// one says so; the behavioural tests carry the real teeth.

use crate::playtest::{PlaytestEvent, PLAYTEST_EVENT_CAP};
use crate::schema::PlayerWallet as M22s4WalletRow;
use crate::schema::{
    Account, AccountStatus, Battle, BattleAction, BattleChallenge, ChallengeStatus, Character,
    DataLifecycleEntry, DeletionPolicy, HealCooldown, Inventory, Monster, MonsterPub, Player,
    PlayerConversation, PlayerDialogueStateRow, PlayerQuestRow, Profile, TradeOffer,
    DATA_LIFECYCLE_MANIFEST,
};
use game_core::{
    ActionState, Affinity, BattleMonster, BattleOutcome, BattleSide, BattleState, Direction,
    MonsterCard, MoveInput, NatureKind, PvpAction, StatBlock, TradeItem, TradeStatus, TrustTier,
};
use proptest::prelude::*;
use spacetimedb::Identity;

// ===========================================================================
// m22-s4 primitives: the two hazard characters, spelled by code point.
// ===========================================================================

/// A literal backslash, built from its byte so this file never carries a
/// backslash adjacent to a double quote.
fn m22s4_bs() -> char {
    char::from(92u8)
}

/// One LOWERCASE base-16 digit. The escaping contract emits every C0 control as
/// a six-character escape with lowercase hex.
fn m22s4_hex_digit(nibble: u32) -> char {
    char::from_digit(nibble, 16).expect("m22s4: a nibble is always a valid base-16 digit")
}

/// The contract's escape for one C0 control code point: backslash, `u`, `00`,
/// then the byte as two lowercase hex digits. A reference implementation of the
/// RULE, written from the spec — never read off the production source.
fn m22s4_u_esc(code: u32) -> String {
    let mut out = String::new();
    out.push(m22s4_bs());
    out.push('u');
    out.push('0');
    out.push('0');
    out.push(m22s4_hex_digit((code >> 4) & 0xF));
    out.push(m22s4_hex_digit(code & 0xF));
    out
}

/// Backslash + double quote (the escaped-quote output form).
fn m22s4_esc_quote() -> String {
    let mut out = String::new();
    out.push(m22s4_bs());
    out.push(rb22p_dq());
    out
}

/// Two backslashes (the escaped-backslash output form).
fn m22s4_esc_backslash() -> String {
    let mut out = String::new();
    out.push(m22s4_bs());
    out.push(m22s4_bs());
    out
}

// ===========================================================================
// m22-s4 JSON EXPECTATION builders (independent of the production emitter).
//
// The contract: an object is `{` then comma-separated name/value pairs then
// `}`; u64 and i64 are QUOTED decimal strings (JSON.parse silently rounds above
// 2^53 and wallet balances, row ids and input seqs are all u64); everything at
// 32 bits or narrower, plus bool, is a BARE JSON literal.
// ===========================================================================

/// An object from an ORDERED field list. Field order is part of the pin: the
/// serializers emit columns in DECLARATION order, so a reordered struct is a
/// visible diff rather than a silent reshuffle of a durable artifact.
fn m22s4_obj(fields: &[(&str, String)]) -> String {
    let q = rb22p_dq();
    let mut out = String::new();
    out.push('{');
    let mut first = true;
    for (name, value) in fields {
        if !first {
            out.push(',');
        }
        first = false;
        out.push(q);
        out.push_str(name);
        out.push(q);
        out.push(':');
        out.push_str(value);
    }
    out.push('}');
    out
}

/// An array from already-rendered element texts.
fn m22s4_arr(items: &[String]) -> String {
    let mut out = String::new();
    out.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(item);
    }
    out.push(']');
    out
}

/// A BARE JSON number (every column 32 bits or narrower).
fn m22s4_bare(v: i128) -> String {
    v.to_string()
}

/// A QUOTED decimal string (every u64 / i64 column — the 64-bit rule).
fn m22s4_quoted_num(v: i128) -> String {
    let q = rb22p_dq();
    let mut out = String::new();
    out.push(q);
    out.push_str(&v.to_string());
    out.push(q);
    out
}

/// Quote an ALREADY-ESCAPED payload (string columns, enum variant names, hex).
fn m22s4_qtxt(escaped: &str) -> String {
    let q = rb22p_dq();
    let mut out = String::new();
    out.push(q);
    out.push_str(escaped);
    out.push(q);
    out
}

/// The JSON null literal.
fn m22s4_null() -> String {
    "null".to_string()
}

/// A JSON bool literal.
fn m22s4_bool(b: bool) -> String {
    if b {
        "true".to_string()
    } else {
        "false".to_string()
    }
}

// ===========================================================================
// Identity fixtures.
//
// UNIFORM byte arrays on purpose: Identity's Display is fixed-width lowercase
// hex, but whether it renders the byte array big- or little-endian is not
// something this suite should silently depend on. With every byte equal the two
// renderings coincide, so the expected hex is the nibble pair repeated 32
// times either way — an INDEPENDENT spelling of the emitter's output.
// ===========================================================================

/// `Identity::from_byte_array` is banned in privacy.rs (rb22p_no_identity_ctor)
/// and in accounts.rs (the eval's identity-ctor clause). Neither ban covers a
/// `_tests.rs` fixture, and lib.rs uses the same constructor for WILD_IDENTITY.
fn m22s4_id(byte: u8) -> Identity {
    Identity::from_byte_array([byte; 32])
}

/// The 64-character lowercase hex an all-`byte` identity must render as, built
/// WITHOUT calling Display — the independent oracle for the identity emitter.
fn m22s4_id_hex(byte: u8) -> String {
    let mut out = String::new();
    for _ in 0..32 {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The quoted hex an identity column must serialize to.
fn m22s4_qid(id: Identity) -> String {
    m22s4_qtxt(&id.to_string())
}

/// Requester A.
fn m22s4_id_a() -> Identity {
    m22s4_id(0xAB)
}

/// Counterparty B.
fn m22s4_id_b() -> Identity {
    m22s4_id(0x3C)
}

/// A third party who participates in nothing.
fn m22s4_id_c() -> Identity {
    m22s4_id(0x77)
}

// ===========================================================================
// The one adversarial string every String-typed fixture column carries, and its
// escaped form derived from the CONTRACT rather than from the implementation.
// ===========================================================================

/// Quote, backslash, two distinct C0 controls (one of them the line feed, whose
/// two-character short form the contract deliberately does NOT use), a solidus
/// and a DEL (both explicitly UNESCAPED), plus 2-, 3- and 4-byte UTF-8 that must
/// pass through untouched.
fn m22s4_nasty() -> String {
    let mut s = String::new();
    s.push('a');
    s.push(rb22p_dq());
    s.push(m22s4_bs());
    s.push('\u{0001}');
    s.push('\u{000A}');
    s.push('/');
    s.push('\u{007F}');
    s.push('\u{00E9}');
    s.push('\u{4E2D}');
    s.push('\u{1F600}');
    s.push('z');
    s
}

/// `m22s4_nasty()` after the escaping rule, WITHOUT the surrounding quotes.
fn m22s4_nasty_escaped() -> String {
    let mut s = String::new();
    s.push('a');
    s.push_str(&m22s4_esc_quote());
    s.push_str(&m22s4_esc_backslash());
    s.push_str(&m22s4_u_esc(0x01));
    s.push_str(&m22s4_u_esc(0x0A));
    s.push('/');
    s.push('\u{007F}');
    s.push('\u{00E9}');
    s.push('\u{4E2D}');
    s.push('\u{1F600}');
    s.push('z');
    s
}

/// `m22s4_nasty()` as a complete JSON string value.
fn m22s4_nasty_json() -> String {
    m22s4_qtxt(&m22s4_nasty_escaped())
}

// ===========================================================================
// Thin wrappers over the production emitters (each writes into a fresh buffer).
// ===========================================================================

/// `json_escape_into` over a fresh buffer.
fn m22s4_esc(s: &str) -> String {
    let mut out = String::new();
    super::json_escape_into(&mut out, s);
    out
}

/// `json_str_into` over a fresh buffer (quote + escape + quote).
fn m22s4_str(s: &str) -> String {
    let mut out = String::new();
    super::json_str_into(&mut out, s);
    out
}

/// `json_u64_into` over a fresh buffer.
fn m22s4_u64_out(v: u64) -> String {
    let mut out = String::new();
    super::json_u64_into(&mut out, v);
    out
}

/// `json_i64_into` over a fresh buffer.
fn m22s4_i64_out(v: i64) -> String {
    let mut out = String::new();
    super::json_i64_into(&mut out, v);
    out
}

/// `json_u32_into` over a fresh buffer.
fn m22s4_u32_out(v: u32) -> String {
    let mut out = String::new();
    super::json_u32_into(&mut out, v);
    out
}

/// `json_u16_into` over a fresh buffer.
fn m22s4_u16_out(v: u16) -> String {
    let mut out = String::new();
    super::json_u16_into(&mut out, v);
    out
}

/// `json_u8_into` over a fresh buffer.
fn m22s4_u8_out(v: u8) -> String {
    let mut out = String::new();
    super::json_u8_into(&mut out, v);
    out
}

/// `json_i32_into` over a fresh buffer.
fn m22s4_i32_out(v: i32) -> String {
    let mut out = String::new();
    super::json_i32_into(&mut out, v);
    out
}

/// `json_bool_into` over a fresh buffer.
fn m22s4_bool_out(v: bool) -> String {
    let mut out = String::new();
    super::json_bool_into(&mut out, v);
    out
}

/// `json_null_into` over a fresh buffer.
fn m22s4_null_out() -> String {
    let mut out = String::new();
    super::json_null_into(&mut out);
    out
}

/// `json_identity_into` over a fresh buffer.
fn m22s4_ident_out(id: Identity) -> String {
    let mut out = String::new();
    super::json_identity_into(&mut out, id);
    out
}

// ===========================================================================
// The REFERENCE UNESCAPER (test-only, by design).
// ===========================================================================

/// The inverse of the escaping contract. It lives HERE and only here: shipping
/// an inverse in privacy.rs would give the round-trip property a shared bug to
/// agree on.
///
/// STRICT on purpose — an unexpected byte is an Err, never a pass-through, so
/// the property fails on a lossy escaper instead of quietly recovering from it.
fn m22s4_unescape(esc: &str) -> Result<String, String> {
    let chars: Vec<char> = esc.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c != m22s4_bs() {
            if c == rb22p_dq() {
                return Err(format!(
                    "m22s4 [escape/raw-quote]: an UNESCAPED double quote at char {i}. It closes \
                     the JSON string early, so the rest of the payload is parsed as structure."
                ));
            }
            let code = c as u32;
            if code < 0x20 {
                return Err(format!(
                    "m22s4 [escape/raw-control]: a raw C0 control U+{code:04X} at char {i}. Raw \
                     control bytes are invalid inside a JSON string."
                ));
            }
            out.push(c);
            i += 1;
            continue;
        }
        if i + 1 >= chars.len() {
            return Err(
                "m22s4 [escape/trailing]: the output ends in a lone backslash.".to_string(),
            );
        }
        let next = chars[i + 1];
        if next == m22s4_bs() {
            out.push(m22s4_bs());
            i += 2;
            continue;
        }
        if next == rb22p_dq() {
            out.push(rb22p_dq());
            i += 2;
            continue;
        }
        if next != 'u' {
            return Err(format!(
                "m22s4 [escape/unknown]: backslash followed by {next:?} at char {i}. The contract \
                 admits exactly three escapes: the quote, the backslash, and the UNIFORM \
                 six-character control form."
            ));
        }
        if i + 5 >= chars.len() {
            return Err("m22s4 [escape/short-u]: a truncated unicode escape.".to_string());
        }
        let hex: String = chars[i + 2..i + 6].iter().collect();
        if hex.chars().any(|h| h.is_ascii_uppercase()) {
            return Err(format!(
                "m22s4 [escape/case]: the unicode escape {hex:?} uses UPPERCASE hex digits; the \
                 contract is lowercase."
            ));
        }
        let code = u32::from_str_radix(&hex, 16)
            .map_err(|e| format!("m22s4 [escape/hex]: {hex:?} is not four hex digits ({e})"))?;
        let decoded = char::from_u32(code)
            .ok_or_else(|| format!("m22s4 [escape/scalar]: U+{code:04X} is not a scalar value"))?;
        out.push(decoded);
        i += 6;
    }
    Ok(out)
}

// ===========================================================================
// A minimal, WHITESPACE-INTOLERANT JSON well-formedness oracle.
//
// Deliberately not a parser with a value model: it answers exactly one
// question — does this text parse as EXACTLY ONE compact JSON value with no
// trailing garbage? It is the non-vacuity control on the expectation builders
// above (if THEY were wrong, an equality assertion would still pass) and the
// independent instrument the empty-chunk clause reads.
// ===========================================================================

/// Does `s` parse as exactly one compact JSON value?
fn m22s4_json_is_wellformed(s: &str) -> bool {
    let b = s.as_bytes();
    match m22s4_json_value(b, 0) {
        Some(end) => end == b.len(),
        None => false,
    }
}

/// Parse one JSON value at `i`; return the index just past it.
fn m22s4_json_value(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        34u8 => m22s4_json_string(b, i),
        b'{' => m22s4_json_object(b, i),
        b'[' => m22s4_json_array(b, i),
        b't' => m22s4_json_lit(b, i, "true"),
        b'f' => m22s4_json_lit(b, i, "false"),
        b'n' => m22s4_json_lit(b, i, "null"),
        _ => m22s4_json_number(b, i),
    }
}

/// Match a bare literal.
fn m22s4_json_lit(b: &[u8], i: usize, lit: &str) -> Option<usize> {
    let end = i + lit.len();
    if end <= b.len() && &b[i..end] == lit.as_bytes() {
        Some(end)
    } else {
        None
    }
}

/// Parse a JSON string, rejecting raw controls, raw quotes and any escape the
/// contract does not admit.
fn m22s4_json_string(b: &[u8], i: usize) -> Option<usize> {
    if *b.get(i)? != 34u8 {
        return None;
    }
    let mut j = i + 1;
    while j < b.len() {
        let c = b[j];
        if c == 34u8 {
            return Some(j + 1);
        }
        if c < 0x20 {
            return None;
        }
        if c == 92u8 {
            let n = *b.get(j + 1)?;
            if n == b'u' {
                if j + 6 > b.len() {
                    return None;
                }
                if !b[j + 2..j + 6].iter().all(|d| d.is_ascii_hexdigit()) {
                    return None;
                }
                j += 6;
                continue;
            }
            if n != 92u8 && n != 34u8 {
                return None;
            }
            j += 2;
            continue;
        }
        j += 1;
    }
    None
}

/// Parse an integer JSON number (the only numeric shape this export emits).
fn m22s4_json_number(b: &[u8], i: usize) -> Option<usize> {
    let mut j = i;
    if b.get(j) == Some(&b'-') {
        j += 1;
    }
    let start = j;
    while j < b.len() && b[j].is_ascii_digit() {
        j += 1;
    }
    if j == start {
        return None;
    }
    Some(j)
}

/// Parse a JSON array.
fn m22s4_json_array(b: &[u8], i: usize) -> Option<usize> {
    if *b.get(i)? != b'[' {
        return None;
    }
    let mut j = i + 1;
    if b.get(j) == Some(&b']') {
        return Some(j + 1);
    }
    loop {
        j = m22s4_json_value(b, j)?;
        match b.get(j) {
            Some(&b',') => j += 1,
            Some(&b']') => return Some(j + 1),
            _ => return None,
        }
    }
}

/// Parse a JSON object.
fn m22s4_json_object(b: &[u8], i: usize) -> Option<usize> {
    if *b.get(i)? != b'{' {
        return None;
    }
    let mut j = i + 1;
    if b.get(j) == Some(&b'}') {
        return Some(j + 1);
    }
    loop {
        j = m22s4_json_string(b, j)?;
        if b.get(j) != Some(&b':') {
            return None;
        }
        j += 1;
        j = m22s4_json_value(b, j)?;
        match b.get(j) {
            Some(&b',') => j += 1,
            Some(&b'}') => return Some(j + 1),
            _ => return None,
        }
    }
}

// ===========================================================================
// Chunk-payload expectation builders.
//
// Payload shape: an object with the table NAME and a `rows` array. Nothing else
// is duplicated from the ExportBundle columns, so the artifact is
// self-describing after download without restating total_chunks.
// ===========================================================================

/// The literal prefix every chunk payload for `table` must open with.
fn m22s4_chunk_prefix(table: &str) -> String {
    let q = rb22p_dq();
    let mut s = String::new();
    s.push('{');
    s.push(q);
    s.push_str("table");
    s.push(q);
    s.push(':');
    s.push(q);
    s.push_str(table);
    s.push(q);
    s.push(',');
    s.push(q);
    s.push_str("rows");
    s.push(q);
    s.push(':');
    s.push('[');
    s
}

/// The complete expected payload for one chunk.
fn m22s4_expected_payload(table: &str, rows: &[String]) -> String {
    let mut s = m22s4_chunk_prefix(table);
    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(row);
    }
    s.push(']');
    s.push('}');
    s
}

/// A synthetic, uniquely identifiable row text for the planner fixtures.
fn m22s4_row_text(table: &str, index: usize) -> String {
    m22s4_obj(&[("t", m22s4_qtxt(table)), ("i", m22s4_bare(index as i128))])
}

/// The chunk count the sub-chunking rule requires for `rows` rows at `per` per
/// chunk. An INDEPENDENT reference (a saturating loop, never a division): an
/// empty table still emits exactly ONE chunk, which `slice::chunks()` does not.
fn m22s4_expected_chunk_count(rows: usize, per: usize) -> usize {
    assert!(per > 0, "m22s4: the chunk size must be non-zero");
    if rows == 0 {
        return 1;
    }
    let mut count = 0usize;
    let mut left = rows;
    while left > 0 {
        count += 1;
        left = left.saturating_sub(per);
    }
    count
}

/// The whole expected plan for a request: `(table, chunk_index, payload)` in
/// dispatch order, with the request-wide contiguous index.
fn m22s4_reference_plan(
    per_table: &[(&'static str, Vec<String>)],
    per: usize,
) -> Vec<(&'static str, u32, String)> {
    let mut out: Vec<(&'static str, u32, String)> = Vec::new();
    let mut idx: u32 = 0;
    for (table_ref, rows) in per_table {
        let table: &'static str = table_ref;
        if rows.is_empty() {
            out.push((table, idx, m22s4_expected_payload(table, &[])));
            idx += 1;
            continue;
        }
        for slice in rows.chunks(per) {
            out.push((table, idx, m22s4_expected_payload(table, slice)));
            idx += 1;
        }
    }
    out
}

/// Fixture table names for the planner property (never a live accessor name).
const M22S4_PLAN_TABLES: [&str; 5] = ["m22s4_t0", "m22s4_t1", "m22s4_t2", "m22s4_t3", "m22s4_t4"];

/// First-occurrence index of `needle` in `hay`, or a loud panic naming it.
fn m22s4_idx(hay: &str, needle: &str, what: &str) -> usize {
    hay.find(needle).unwrap_or_else(|| {
        panic!(
            "m22s4 [order/missing]: {what} — the needle {needle:?} does not occur in the scanned \
             span at all, so any ORDERING or DEPTH clause reading it would compare a missing \
             position and pass VACUOUSLY. Failing loud instead."
        )
    })
}

/// The squashed, scoped body of one `rows_<table>` shell reader, with its
/// signature pinned first so a renamed or re-shaped reader reds LOUD.
///
/// SIGNATURE NORMALIZATION (the rustfmt vertical-wrap twin). The one-line
/// spelling of the longest reader name is 101 characters, one past rustfmt's
/// max_width, so rustfmt MUST break its parameter list across lines — and its
/// vertical argument form appends a trailing comma, which squashes to
/// `owner:Identity,)`. The escape hatch is not available either: a
/// rustfmt-skip attribute is banned crate-wide, because skipping the formatter
/// defeats fmt-as-normalizer, which every squashed scan in this crate relies
/// on. So the comma is NOT a stylistic choice the implementer can make either
/// way — for that one reader it is mandatory. This helper therefore drops ONE
/// comma sitting immediately before the parameter list's closing paren before
/// comparing. The two spellings are the same Rust: parameter NAMES, TYPES,
/// ARITY and the RETURN TYPE all stay pinned exactly, so nothing this pin
/// exists to protect is loosened — a second parameter still reds, because it
/// changes the text between the parens, not the comma before them.
fn m22s4_rows_body(squashed: &str, table: &str) -> String {
    let needle = format!("fnrows_{table}(");
    let n = rb22p_count(squashed, &needle);
    assert_eq!(
        n, 1,
        "m22s4 [rows/scope]: privacy.rs must declare `{needle}` exactly once; found {n}. Zero is \
         the intended RED before the implementer lands the shell reader; two makes every clause \
         below read whichever one the extractor reaches first."
    );

    let sig = extract_squashed_fn_sig(squashed, &needle)
        .unwrap_or_else(|| panic!("m22s4 [rows/sig]: `{needle}` has no opening brace."));

    // Walk from the parameter list's opening paren to its matching close. The
    // walk is depth-counted rather than a search for the last paren, so a
    // parenthesised TYPE in some future parameter cannot move the target.
    let bytes = sig.as_bytes();
    let open = sig
        .find('(')
        .unwrap_or_else(|| panic!("m22s4 [rows/sig]: `{needle}` has no parameter list."));
    let mut depth = 0usize;
    let mut found: Option<usize> = None;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    found = Some(i);
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let close = found.unwrap_or_else(|| {
        panic!(
            "m22s4 [rows/sig]: the parameter list of `{needle}` is not paren-balanced, so the \
             normalization below would read an arbitrary span. Refusing to classify is the safe \
             direction."
        )
    });
    let normalized: String = if close > 0 && bytes[close - 1] == b',' {
        let mut out = String::with_capacity(sig.len() - 1);
        out.push_str(&sig[..close - 1]);
        out.push_str(&sig[close..]);
        out
    } else {
        sig.to_string()
    };

    let expected =
        format!("fnrows_{table}(ctx:&ReducerContext,owner:Identity)->Result<Vec<String>,String>");
    assert_eq!(
        normalized, expected,
        "m22s4 [rows/sig]: the `{table}` shell reader must carry the frozen signature. The \
         context is named `ctx` (every alias ban in this module keys on that name) and the \
         subject arrives as `owner: Identity` — a reader that takes any OTHER identity-typed \
         parameter, or none, is a caller-chosen-owner read of a private table. The comparison \
         is made after dropping ONE comma sitting immediately before the parameter list's \
         closing paren: that trailing-comma twin is ACCEPTED because rustfmt wraps any \
         signature past its max_width and its vertical argument form emits the comma, while a \
         rustfmt-skip attribute is banned crate-wide (skipping the formatter defeats \
         fmt-as-normalizer, which every squashed scan here depends on) — so for the longest \
         reader name no fmt-canonical spelling can avoid it. Only the comma is normalized; \
         parameter names, types, arity and the return type are still pinned exactly."
    );

    let body = extract_squashed_fn_body(squashed, &needle)
        .unwrap_or_else(|| panic!("m22s4 [rows/scope]: `{needle}` body is not brace-balanced."));
    assert!(
        !body.is_empty(),
        "m22s4 [rows/vacuity]: `{needle}` has an EMPTY body, so every own-rows clause about it \
         would pass over nothing."
    );
    body.to_string()
}

/// The exportable:true table names, read off the LIVE manifest.
fn m22s4_manifest_exportable() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in DATA_LIFECYCLE_MANIFEST {
        if entry.exportable {
            out.push(entry.table.to_string());
        }
    }
    out
}

// ===========================================================================
// Battle fixtures (shared by the four redaction tests).
// ===========================================================================

/// A BattleState carrying deliberately DISTINCTIVE, multi-digit field values.
///
/// It exists so the omission test has something REAL to prove absent: every
/// banned needle in m22s4_battle_state_blob_is_never_emitted is first asserted
/// PRESENT in this value's Debug rendering, which is what proves the ban list
/// names actual BattleState content rather than typos nobody can ever match.
fn m22s4_battle_state() -> BattleState {
    let monster = BattleMonster {
        species_id: 9091,
        affinity: Affinity::Electric,
        level: 213,
        current_hp: 1777,
        max_hp: 8888,
        stats: StatBlock {
            hp: 8181,
            attack: 6161,
            defense: 6262,
            speed: 6363,
            sp_attack: 6464,
            sp_defense: 6565,
        },
        known_skill_ids: vec![7007, 8008],
        status: None,
    };
    BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![monster.clone()],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![monster],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 3131,
        weather: None,
    }
}

/// A battle row with the frozen fixture ids/timestamps and the state blob.
fn m22s4_battle_row(player: Identity, opponent: Identity) -> Battle {
    Battle {
        battle_id: 14,
        player_identity: player,
        opponent_identity: opponent,
        state: m22s4_battle_state(),
        party_monster_ids: vec![1, 2],
        opponent_monster_ids: vec![3],
        created_at_ms: 46,
    }
}

/// The expected json_battle output for one row, given what each identity column
/// and each monster-id list must render as.
///
/// SIX fields, in DECLARATION order, with `state` ABSENT: the state blob is
/// omitted entirely and neither outcome nor turn_number is lifted out of it
/// (they are BattleState fields, not Battle columns).
fn m22s4_expected_battle(
    player: String,
    opponent: String,
    party: String,
    opponent_ids: String,
) -> String {
    m22s4_obj(&[
        ("battle_id", m22s4_quoted_num(14)),
        ("player_identity", player),
        ("opponent_identity", opponent),
        ("party_monster_ids", party),
        ("opponent_monster_ids", opponent_ids),
        ("created_at_ms", m22s4_quoted_num(46)),
    ])
}

/// The party list: u64 elements QUOTED per the 64-bit rule.
fn m22s4_party_ids_json() -> String {
    m22s4_arr(&[m22s4_quoted_num(1), m22s4_quoted_num(2)])
}

/// The opponent list.
fn m22s4_opponent_ids_json() -> String {
    m22s4_arr(&[m22s4_quoted_num(3)])
}

/// A battle_action row for the own-rows fixtures. Both fixtures share ONE
/// battle_id on purpose: a predicate keyed on battle_id instead of on the
/// submitting identity returns true for BOTH rows and is killed here.
fn m22s4_action_row(action_id: u64, who: Identity) -> BattleAction {
    BattleAction {
        action_id,
        battle_id: 99,
        player_identity: who,
        action: PvpAction::Attack { skill_id: 3 },
        turn_number: 7,
        submitted_at_ms: 45,
    }
}

/// A playtest_event row for the own-rows fixtures. Same shared-battle_id trap.
fn m22s4_playtest_row(event_id: u64, who: Identity) -> PlaytestEvent {
    PlaytestEvent {
        event_id,
        identity: who,
        kind: 1,
        created_at_ms: 12345,
        battle_id: 99,
        species_id: 9,
        hp_permille: 750,
        bait_item_id: 3,
        success: true,
    }
}

// ===========================================================================
// PRV1-11 / X1 — the seventeen pure per-table serializers.
// ===========================================================================

/// PRV1-11 / X1: every exportable table's row serializes to EXACTLY the
/// sanctioned JSON object — every column, in declaration order, with the
/// contract's encoding per type.
///
/// EXHAUSTIVE STRUCT LITERALS, no spread and no default, in every fixture. That
/// is the whole privacy posture expressed as a test: a new column added to an
/// exportable table is a COMPILE ERROR here, which forces a deliberate
/// export-or-omit decision per column instead of a silent auto-export.
///
/// EQUALITY, not containment. A containment check is green on an appended
/// field, on a reordered pair and on a widened encoding alike — and the export
/// is a durable artifact a subject may hand to a regulator, so its shape is a
/// contract, not an implementation detail.
///
/// Kills: emitting a u64/i64 as a BARE JSON number (the fixtures deliberately
///        sit past 2^53, where JSON.parse silently rounds);
///        quoting a 32-bit-or-narrower column (breaks the client's arithmetic);
///        dropping or reordering any column;
///        emitting an enum by discriminant instead of by variant NAME;
///        a wildcard match arm that renders two variants alike (every enum
///        fixture picks a NON-first variant, so a match collapsed to its first
///        arm fails);
///        leaking a raw quote / backslash / control byte out of a
///        player-authored string (every String column carries the same
///        adversarial value);
///        emitting null for an empty Vec instead of an empty array.
#[test]
fn m22s4_serializer_per_table_shape() {
    let owner = m22s4_id_a();
    let other = m22s4_id_b();
    let nasty = m22s4_nasty();
    let nasty_json = m22s4_nasty_json();

    // --- monster (44 columns, the widest row in the export) -----------------
    let monster = Monster {
        monster_id: 7,
        owner_identity: owner,
        species_id: 3,
        nickname: nasty.clone(),
        level: 5,
        xp: 1234,
        iv_hp: 11,
        iv_attack: 12,
        iv_defense: 13,
        iv_speed: 14,
        iv_sp_attack: 15,
        iv_sp_defense: 16,
        nature_kind: NatureKind::Sassy,
        ev_hp: 21,
        ev_attack: 22,
        ev_defense: 23,
        ev_speed: 24,
        ev_sp_attack: 25,
        ev_sp_defense: 26,
        stat_hp: 31,
        stat_attack: 32,
        stat_defense: 33,
        stat_speed: 34,
        stat_sp_attack: 35,
        stat_sp_defense: 36,
        current_hp: 41,
        party_slot: 2,
        last_care_at_ms: -9,
        essence_fire: 51,
        essence_water: 52,
        essence_plant: 53,
        essence_electric: 54,
        essence_earth: 55,
        essence_wind: 56,
        essence_light: 57,
        essence_dark: 58,
        trust_favorable_count: 61,
        trust_unfavorable_count: 62,
        trust_favorable_battle_day_epoch: 63,
        quality_time_ticks_total: 64,
        quality_time_accum_ms: 65,
        quality_time_window_ms: 66,
        quality_time_window_start_ms: 9_007_199_254_740_993,
        last_essence_train_at_ms: i64::MIN,
    };
    let out_monster = super::json_monster(&monster);
    assert_eq!(
        out_monster,
        m22s4_obj(&[
            ("monster_id", m22s4_quoted_num(7)),
            ("owner_identity", m22s4_qid(owner)),
            ("species_id", m22s4_bare(3)),
            ("nickname", nasty_json.clone()),
            ("level", m22s4_bare(5)),
            ("xp", m22s4_bare(1234)),
            ("iv_hp", m22s4_bare(11)),
            ("iv_attack", m22s4_bare(12)),
            ("iv_defense", m22s4_bare(13)),
            ("iv_speed", m22s4_bare(14)),
            ("iv_sp_attack", m22s4_bare(15)),
            ("iv_sp_defense", m22s4_bare(16)),
            ("nature_kind", m22s4_qtxt("Sassy")),
            ("ev_hp", m22s4_bare(21)),
            ("ev_attack", m22s4_bare(22)),
            ("ev_defense", m22s4_bare(23)),
            ("ev_speed", m22s4_bare(24)),
            ("ev_sp_attack", m22s4_bare(25)),
            ("ev_sp_defense", m22s4_bare(26)),
            ("stat_hp", m22s4_bare(31)),
            ("stat_attack", m22s4_bare(32)),
            ("stat_defense", m22s4_bare(33)),
            ("stat_speed", m22s4_bare(34)),
            ("stat_sp_attack", m22s4_bare(35)),
            ("stat_sp_defense", m22s4_bare(36)),
            ("current_hp", m22s4_bare(41)),
            ("party_slot", m22s4_bare(2)),
            ("last_care_at_ms", m22s4_quoted_num(-9)),
            ("essence_fire", m22s4_bare(51)),
            ("essence_water", m22s4_bare(52)),
            ("essence_plant", m22s4_bare(53)),
            ("essence_electric", m22s4_bare(54)),
            ("essence_earth", m22s4_bare(55)),
            ("essence_wind", m22s4_bare(56)),
            ("essence_light", m22s4_bare(57)),
            ("essence_dark", m22s4_bare(58)),
            ("trust_favorable_count", m22s4_bare(61)),
            ("trust_unfavorable_count", m22s4_bare(62)),
            ("trust_favorable_battle_day_epoch", m22s4_bare(63)),
            ("quality_time_ticks_total", m22s4_bare(64)),
            ("quality_time_accum_ms", m22s4_bare(65)),
            ("quality_time_window_ms", m22s4_bare(66)),
            (
                "quality_time_window_start_ms",
                m22s4_quoted_num(9_007_199_254_740_993),
            ),
            (
                "last_essence_train_at_ms",
                m22s4_quoted_num(i64::MIN as i128),
            ),
        ]),
        "m22s4 [X1/monster]: the private monster row must emit every column in declaration order \
         — the six IV columns, the six EV columns and the nature NAME included (the export is \
         the SUBJECT's own data, so the need-to-know rule that hides genes from OTHER players \
         does not apply), u64/i64 as QUOTED decimal strings, and the nickname escaped."
    );

    // --- monster_pub (26 columns) -------------------------------------------
    let monster_pub = MonsterPub {
        monster_id: 8,
        owner_identity: owner,
        species_id: 4,
        nickname: nasty.clone(),
        level: 6,
        xp: 4321,
        current_hp: 42,
        stat_hp: 71,
        stat_attack: 72,
        stat_defense: 73,
        stat_speed: 74,
        stat_sp_attack: 75,
        stat_sp_defense: 76,
        party_slot: 3,
        tier: 1,
        essence_fire: 81,
        essence_water: 82,
        essence_plant: 83,
        essence_electric: 84,
        essence_earth: 85,
        essence_wind: 86,
        essence_light: 87,
        essence_dark: 88,
        trust_tier: TrustTier::Devoted,
        quality_time_tier: 4,
        nutrition_pct: 55,
    };
    let out_monster_pub = super::json_monster_pub(&monster_pub);
    assert_eq!(
        out_monster_pub,
        m22s4_obj(&[
            ("monster_id", m22s4_quoted_num(8)),
            ("owner_identity", m22s4_qid(owner)),
            ("species_id", m22s4_bare(4)),
            ("nickname", nasty_json.clone()),
            ("level", m22s4_bare(6)),
            ("xp", m22s4_bare(4321)),
            ("current_hp", m22s4_bare(42)),
            ("stat_hp", m22s4_bare(71)),
            ("stat_attack", m22s4_bare(72)),
            ("stat_defense", m22s4_bare(73)),
            ("stat_speed", m22s4_bare(74)),
            ("stat_sp_attack", m22s4_bare(75)),
            ("stat_sp_defense", m22s4_bare(76)),
            ("party_slot", m22s4_bare(3)),
            ("tier", m22s4_bare(1)),
            ("essence_fire", m22s4_bare(81)),
            ("essence_water", m22s4_bare(82)),
            ("essence_plant", m22s4_bare(83)),
            ("essence_electric", m22s4_bare(84)),
            ("essence_earth", m22s4_bare(85)),
            ("essence_wind", m22s4_bare(86)),
            ("essence_light", m22s4_bare(87)),
            ("essence_dark", m22s4_bare(88)),
            ("trust_tier", m22s4_qtxt("Devoted")),
            ("quality_time_tier", m22s4_bare(4)),
            ("nutrition_pct", m22s4_bare(55)),
        ]),
        "m22s4 [X1/monster_pub]: all 26 columns in declaration order. trust_tier is a \
         five-variant enum whose derived default is the MIDDLE band, so the fixture picks the \
         LAST variant: an encoder collapsed to its first arm, or one that renders the default, \
         fails here."
    );

    // --- inventory ----------------------------------------------------------
    let inventory = Inventory {
        inv_id: 9,
        owner_identity: owner,
        item_id: 12,
        count: 34,
    };
    let out_inventory = super::json_inventory(&inventory);
    assert_eq!(
        out_inventory,
        m22s4_obj(&[
            ("inv_id", m22s4_quoted_num(9)),
            ("owner_identity", m22s4_qid(owner)),
            ("item_id", m22s4_bare(12)),
            ("count", m22s4_bare(34)),
        ]),
        "m22s4 [X1/inventory]: inv_id is u64 (quoted); item_id and count are u32 (bare)."
    );

    // --- player_dialogue_state (two string-list columns) --------------------
    let dialogue = PlayerDialogueStateRow {
        owner_identity: owner,
        flags: vec![nasty.clone(), "plain".to_string()],
        done_quests: vec![],
    };
    let out_dialogue = super::json_player_dialogue_state(&dialogue);
    assert_eq!(
        out_dialogue,
        m22s4_obj(&[
            ("owner_identity", m22s4_qid(owner)),
            (
                "flags",
                m22s4_arr(&[nasty_json.clone(), m22s4_qtxt("plain")]),
            ),
            ("done_quests", m22s4_arr(&[])),
        ]),
        "m22s4 [X1/player_dialogue_state]: a string list is a JSON ARRAY of escaped strings, and \
         an EMPTY list is an empty array — never null and never an omitted key. Dialogue flags \
         gate content branches, so the subject is entitled to them verbatim."
    );

    // --- player_quest -------------------------------------------------------
    let quest = PlayerQuestRow {
        pq_id: 10,
        owner_identity: owner,
        quest_id: nasty.clone(),
        step_index: 3,
    };
    let out_quest = super::json_player_quest(&quest);
    assert_eq!(
        out_quest,
        m22s4_obj(&[
            ("pq_id", m22s4_quoted_num(10)),
            ("owner_identity", m22s4_qid(owner)),
            ("quest_id", nasty_json.clone()),
            ("step_index", m22s4_bare(3)),
        ]),
        "m22s4 [X1/player_quest]: pq_id is u64 (quoted); step_index is u32 (bare)."
    );

    // --- player_conversation ------------------------------------------------
    let conversation = PlayerConversation {
        owner_identity: owner,
        npc_entity_id: 77,
        current_node_id: nasty.clone(),
    };
    let out_conversation = super::json_player_conversation(&conversation);
    assert_eq!(
        out_conversation,
        m22s4_obj(&[
            ("owner_identity", m22s4_qid(owner)),
            ("npc_entity_id", m22s4_quoted_num(77)),
            ("current_node_id", nasty_json.clone()),
        ]),
        "m22s4 [X1/player_conversation]: npc_entity_id is a u64 entity key and is quoted."
    );

    // --- heal_cooldown ------------------------------------------------------
    let heal = HealCooldown {
        owner_identity: owner,
        last_heal_at_ms: 1_700_000_000_000,
    };
    let out_heal = super::json_heal_cooldown(&heal);
    assert_eq!(
        out_heal,
        m22s4_obj(&[
            ("owner_identity", m22s4_qid(owner)),
            ("last_heal_at_ms", m22s4_quoted_num(1_700_000_000_000)),
        ]),
        "m22s4 [X1/heal_cooldown]: a wall-clock ms stamp is i64 and must be a QUOTED decimal \
         string."
    );

    // --- the wallet row (alias-imported; see this block's hygiene header) ----
    let wallet = M22s4WalletRow {
        owner_identity: owner,
        balance: u64::MAX,
    };
    let out_wallet = super::json_player_wallet(&wallet);
    assert_eq!(
        out_wallet,
        m22s4_obj(&[
            ("owner_identity", m22s4_qid(owner)),
            ("balance", m22s4_quoted_num(u64::MAX as i128)),
        ]),
        "m22s4 [X1/wallet]: the balance is u64 and MUST be a quoted decimal string. At u64::MAX a \
         BARE JSON number round-trips through the client parser as a rounded value — a silently \
         WRONG balance in the subject's own export."
    );

    // --- playtest_event -----------------------------------------------------
    let playtest = m22s4_playtest_row(100, owner);
    let out_playtest = super::json_playtest_event(&playtest);
    assert_eq!(
        out_playtest,
        m22s4_obj(&[
            ("event_id", m22s4_quoted_num(100)),
            ("identity", m22s4_qid(owner)),
            ("kind", m22s4_bare(1)),
            ("created_at_ms", m22s4_quoted_num(12345)),
            ("battle_id", m22s4_quoted_num(99)),
            ("species_id", m22s4_bare(9)),
            ("hp_permille", m22s4_bare(750)),
            ("bait_item_id", m22s4_bare(3)),
            ("success", m22s4_bool(true)),
        ]),
        "m22s4 [X1/playtest_event]: identity-scoped telemetry is the subject's personal data \
         (manifest policy Erase, exportable true). kind and hp_permille are u16 and success is a \
         bool — all three BARE."
    );

    // --- trade_offer (nested item and card arrays) --------------------------
    let trade = TradeOffer {
        trade_id: 11,
        initiator: owner,
        counterparty: other,
        initiator_monster_ids: vec![1, 2],
        initiator_items: vec![TradeItem { item_id: 5, qty: 6 }],
        initiator_currency: 1000,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![MonsterCard {
            monster_id: 3,
            species_id: 4,
            nickname: nasty.clone(),
            level: 5,
            current_hp: 6,
            stat_hp: 7,
        }],
        counterparty_cards: vec![],
        status: TradeStatus::ConfirmedByCounterparty,
        created_at_ms: 42,
    };
    let expected_card = m22s4_obj(&[
        ("monster_id", m22s4_quoted_num(3)),
        ("species_id", m22s4_bare(4)),
        ("nickname", nasty_json.clone()),
        ("level", m22s4_bare(5)),
        ("current_hp", m22s4_bare(6)),
        ("stat_hp", m22s4_bare(7)),
    ]);
    let expected_item = m22s4_obj(&[("item_id", m22s4_bare(5)), ("qty", m22s4_bare(6))]);
    let out_trade = super::json_trade_offer(&trade);
    assert_eq!(
        out_trade,
        m22s4_obj(&[
            ("trade_id", m22s4_quoted_num(11)),
            ("initiator", m22s4_qid(owner)),
            ("counterparty", m22s4_qid(other)),
            (
                "initiator_monster_ids",
                m22s4_arr(&[m22s4_quoted_num(1), m22s4_quoted_num(2)]),
            ),
            ("initiator_items", m22s4_arr(&[expected_item])),
            ("initiator_currency", m22s4_quoted_num(1000)),
            ("counterparty_monster_ids", m22s4_arr(&[])),
            ("counterparty_items", m22s4_arr(&[])),
            ("counterparty_currency", m22s4_quoted_num(0)),
            ("initiator_cards", m22s4_arr(&[expected_card])),
            ("counterparty_cards", m22s4_arr(&[])),
            ("status", m22s4_qtxt("ConfirmedByCounterparty")),
            ("created_at_ms", m22s4_quoted_num(42)),
        ]),
        "m22s4 [X1/trade_offer]: nested item and card values are OBJECTS with their own field \
         order; every u64 (trade_id, the monster-id lists, both currency columns, the card's \
         monster_id) is quoted; status is the SECOND variant, so an encoder collapsed to its \
         first arm fails. The spec names battle as the ONLY redacted table, so the counterparty \
         identity on a trade the subject is a party to is exported as-is."
    );

    // --- battle_challenge ---------------------------------------------------
    let challenge = BattleChallenge {
        challenge_id: 12,
        challenger: owner,
        target: other,
        challenger_party_ids: vec![9],
        status: ChallengeStatus::Cancelled,
        created_at_ms: 43,
    };
    let out_challenge = super::json_battle_challenge(&challenge);
    assert_eq!(
        out_challenge,
        m22s4_obj(&[
            ("challenge_id", m22s4_quoted_num(12)),
            ("challenger", m22s4_qid(owner)),
            ("target", m22s4_qid(other)),
            ("challenger_party_ids", m22s4_arr(&[m22s4_quoted_num(9)])),
            ("status", m22s4_qtxt("Cancelled")),
            ("created_at_ms", m22s4_quoted_num(43)),
        ]),
        "m22s4 [X1/battle_challenge]: the challenge status renders as its variant NAME, and the \
         fixture picks the LAST of the four variants so a first-arm collapse fails."
    );

    // --- battle_action (nested payload enum) --------------------------------
    let action = BattleAction {
        action_id: 13,
        battle_id: 44,
        player_identity: owner,
        action: PvpAction::Swap { team_index: 2 },
        turn_number: 7,
        submitted_at_ms: 45,
    };
    let out_action = super::json_battle_action(&action);
    assert_eq!(
        out_action,
        m22s4_obj(&[
            ("action_id", m22s4_quoted_num(13)),
            ("battle_id", m22s4_quoted_num(44)),
            ("player_identity", m22s4_qid(owner)),
            (
                "action",
                m22s4_obj(&[("kind", m22s4_qtxt("Swap")), ("team_index", m22s4_bare(2)),]),
            ),
            ("turn_number", m22s4_bare(7)),
            ("submitted_at_ms", m22s4_quoted_num(45)),
        ]),
        "m22s4 [X1/battle_action]: a payload-carrying enum is a TAGGED OBJECT — a kind \
         discriminator plus the variant's own fields — not a bare variant name, which would \
         silently drop team_index, the entire content of the action. The fixture picks the \
         SECOND variant."
    );

    // --- player -------------------------------------------------------------
    let player = Player {
        identity: owner,
        entity_id: 21,
        name: nasty.clone(),
        online: true,
        last_input_seq: 9_007_199_254_740_993,
    };
    let out_player = super::json_player(&player);
    assert_eq!(
        out_player,
        m22s4_obj(&[
            ("identity", m22s4_qid(owner)),
            ("entity_id", m22s4_quoted_num(21)),
            ("name", nasty_json.clone()),
            ("online", m22s4_bool(true)),
            ("last_input_seq", m22s4_quoted_num(9_007_199_254_740_993)),
        ]),
        "m22s4 [X1/player]: last_input_seq is u64 and the fixture sits one above 2^53 — a bare \
         number here loses the low bit in the client assembler."
    );

    // --- profile (the only signed 32-bit column in the export) --------------
    let profile = Profile {
        identity: owner,
        name: nasty.clone(),
        rating: -25,
        wins: 3,
        losses: 4,
    };
    let out_profile = super::json_profile(&profile);
    assert_eq!(
        out_profile,
        m22s4_obj(&[
            ("identity", m22s4_qid(owner)),
            ("name", nasty_json.clone()),
            ("rating", m22s4_bare(-25)),
            ("wins", m22s4_bare(3)),
            ("losses", m22s4_bare(4)),
        ]),
        "m22s4 [X1/profile]: rating is i32 with no floor and must render BARE and SIGNED — an \
         unsigned emitter would wrap a negative rating to about 4.29 billion."
    );

    // --- account (the only option-bearing row) ------------------------------
    let account = Account {
        identity: owner,
        auth_issuer: nasty.clone(),
        created_at_ms: 1,
        last_login_at_ms: 2,
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(3),
        claimed_from: Some(other),
        claimed_at_ms: Some(5),
        terminal_at_ms: None,
    };
    let out_account = super::json_account(&account);
    assert_eq!(
        out_account,
        m22s4_obj(&[
            ("identity", m22s4_qid(owner)),
            ("auth_issuer", nasty_json.clone()),
            ("created_at_ms", m22s4_quoted_num(1)),
            ("last_login_at_ms", m22s4_quoted_num(2)),
            ("status", m22s4_qtxt("PendingDeletion")),
            ("deletion_requested_at_ms", m22s4_quoted_num(3)),
            ("claimed_from", m22s4_qid(other)),
            ("claimed_at_ms", m22s4_quoted_num(5)),
            ("terminal_at_ms", m22s4_null()),
        ]),
        "m22s4 [X1/account]: a present option renders as the value in its OWN encoding and an \
         absent one renders the null LITERAL — never an omitted key, which would make \
         terminal_at_ms indistinguishable from a schema the client does not know about. The \
         fixture is a LEGAL account state (pending deletion pairs with a request stamp; claim \
         provenance is set as a pair) so it cannot be dismissed as unreachable."
    );

    // --- battle (redacting; the requester is side A) ------------------------
    let battle = m22s4_battle_row(owner, other);
    let out_battle = super::json_battle(&battle, owner).unwrap_or_else(|e| {
        panic!("m22s4 [X1/battle]: json_battle must succeed on a row the requester holds: {e}")
    });
    assert_eq!(
        out_battle,
        m22s4_expected_battle(
            m22s4_qid(owner),
            m22s4_null(),
            m22s4_party_ids_json(),
            m22s4_null(),
        ),
        "m22s4 [X1/battle]: the battle row exports SIX columns in declaration order with `state` \
         omitted entirely, and the counterparty's identity and monster list nulled for a \
         requester on side A."
    );

    // --- character (join-only; the nested move queue) -----------------------
    let character = Character {
        entity_id: 15,
        zone_id: 1,
        tile_x: -4,
        tile_y: 9,
        facing: Direction::West,
        action: ActionState::Jumping,
        move_started_at_ms: 47,
        sprite_id: 0,
        move_queue: vec![MoveInput::Step(Direction::North), MoveInput::Jump],
    };
    let out_character = super::json_character(&character);
    assert_eq!(
        out_character,
        m22s4_obj(&[
            ("entity_id", m22s4_quoted_num(15)),
            ("zone_id", m22s4_bare(1)),
            ("tile_x", m22s4_bare(-4)),
            ("tile_y", m22s4_bare(9)),
            ("facing", m22s4_qtxt("West")),
            ("action", m22s4_qtxt("Jumping")),
            ("move_started_at_ms", m22s4_quoted_num(47)),
            ("sprite_id", m22s4_bare(0)),
            (
                "move_queue",
                m22s4_arr(&[
                    m22s4_obj(&[
                        ("kind", m22s4_qtxt("Step")),
                        ("direction", m22s4_qtxt("North")),
                    ]),
                    m22s4_obj(&[("kind", m22s4_qtxt("Jump"))]),
                ]),
            ),
        ]),
        "m22s4 [X1/character]: tile_x and tile_y are i32 and render BARE and SIGNED; facing and \
         action are the LAST variants of their enums; the move queue is an array of tagged \
         objects where the payload-free variant carries the tag ALONE (a null direction there \
         would invent a field the type does not have)."
    );

    // --- non-vacuity of the expectation builder itself ----------------------
    //
    // Every assertion above compares against a string THIS FILE built. If the
    // builder were wrong in the same way twice it would still pass, so each
    // output is independently re-read by the compact JSON oracle.
    for (label, out) in [
        ("monster", &out_monster),
        ("monster_pub", &out_monster_pub),
        ("inventory", &out_inventory),
        ("player_dialogue_state", &out_dialogue),
        ("player_quest", &out_quest),
        ("player_conversation", &out_conversation),
        ("heal_cooldown", &out_heal),
        ("wallet", &out_wallet),
        ("playtest_event", &out_playtest),
        ("trade_offer", &out_trade),
        ("battle_challenge", &out_challenge),
        ("battle_action", &out_action),
        ("player", &out_player),
        ("profile", &out_profile),
        ("account", &out_account),
        ("battle", &out_battle),
        ("character", &out_character),
    ] {
        assert!(
            m22s4_json_is_wellformed(out),
            "m22s4 [X1/wellformed]: the `{label}` serializer produced text that is NOT exactly \
             one well-formed compact JSON value: {out:?}. The equality clause above compares \
             against a string this test file built, so this independent oracle is what catches a \
             shared mistake in both."
        );
    }
}

/// PRV1-11 / X1 (the zero-state half): an owner who holds NOTHING still gets a
/// well-formed, meaningful export.
///
/// TWO CLAUSES, because empty means two different things in this feature:
///   (a) the PLANNER: a table with no rows still emits EXACTLY ONE chunk whose
///       rows array is empty. `slice::chunks()` on an empty slice yields ZERO
///       chunks, so the planner must special-case it. Without that the table
///       silently vanishes from the export while every count-based test stays
///       green, and the written table_name set stops equalling the manifest's
///       exportable set.
///   (b) the SERIALIZERS: zero-state rows (empty strings, empty lists, all
///       options absent, the zero identity) still produce well-formed objects
///       with every key present.
///
/// Kills: forwarding straight to `chunks(n)` with no empty special case;
///        omitting an empty collection or an absent option instead of emitting
///        an empty array / the null literal;
///        an if-there-is-nothing-return-early shortcut anywhere in the pair.
#[test]
fn m22s4_serializer_empty_owner() {
    // --- (a) the empty table still gets its chunk ---------------------------
    let plan = super::plan_export_chunks(vec![("monster", Vec::new())]);
    assert_eq!(
        plan.len(),
        1,
        "m22s4 [X1/empty-chunk]: a table with zero owned rows must still produce EXACTLY ONE \
         chunk. slice::chunks() on an empty slice yields ZERO chunks, so an implementation that \
         forwards straight to it drops the table from the export entirely — and a compliance \
         export that says NOTHING about a table is not the same artifact as one that says the \
         subject has no rows there."
    );
    assert_eq!(
        plan[0].table, "monster",
        "m22s4 [X1/empty-chunk]: the empty chunk must carry the table it stands for."
    );
    assert_eq!(
        plan[0].chunk_index, 0,
        "m22s4 [X1/empty-chunk]: the sole chunk of the request is index 0."
    );
    let expected_empty = m22s4_expected_payload("monster", &[]);
    assert_eq!(
        plan[0].payload, expected_empty,
        "m22s4 [X1/empty-chunk]: the payload must be the self-describing header with an EMPTY \
         rows array."
    );
    assert!(
        m22s4_json_is_wellformed(&plan[0].payload),
        "m22s4 [X1/empty-chunk]: the empty-table payload is not well-formed JSON: {:?}",
        plan[0].payload
    );

    // --- (b) zero-state rows still serialize --------------------------------
    let zero = m22s4_id(0x00);

    let dialogue = PlayerDialogueStateRow {
        owner_identity: zero,
        flags: vec![],
        done_quests: vec![],
    };
    let out_dialogue = super::json_player_dialogue_state(&dialogue);
    assert_eq!(
        out_dialogue,
        m22s4_obj(&[
            ("owner_identity", m22s4_qid(zero)),
            ("flags", m22s4_arr(&[])),
            ("done_quests", m22s4_arr(&[])),
        ]),
        "m22s4 [X1/zero-state]: two empty string-list columns must BOTH render an empty array."
    );

    let trade = TradeOffer {
        trade_id: 0,
        initiator: zero,
        counterparty: zero,
        initiator_monster_ids: vec![],
        initiator_items: vec![],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    };
    let out_trade = super::json_trade_offer(&trade);
    assert_eq!(
        out_trade,
        m22s4_obj(&[
            ("trade_id", m22s4_quoted_num(0)),
            ("initiator", m22s4_qid(zero)),
            ("counterparty", m22s4_qid(zero)),
            ("initiator_monster_ids", m22s4_arr(&[])),
            ("initiator_items", m22s4_arr(&[])),
            ("initiator_currency", m22s4_quoted_num(0)),
            ("counterparty_monster_ids", m22s4_arr(&[])),
            ("counterparty_items", m22s4_arr(&[])),
            ("counterparty_currency", m22s4_quoted_num(0)),
            ("initiator_cards", m22s4_arr(&[])),
            ("counterparty_cards", m22s4_arr(&[])),
            ("status", m22s4_qtxt("Pending")),
            ("created_at_ms", m22s4_quoted_num(0)),
        ]),
        "m22s4 [X1/zero-state]: six empty collections in one row must all render an empty array, \
         and a zero u64 is still the QUOTED string form."
    );

    let character = Character {
        entity_id: 0,
        zone_id: 0,
        tile_x: 0,
        tile_y: 0,
        facing: Direction::North,
        action: ActionState::Idle,
        move_started_at_ms: 0,
        sprite_id: 0,
        move_queue: vec![],
    };
    let out_character = super::json_character(&character);
    assert_eq!(
        out_character,
        m22s4_obj(&[
            ("entity_id", m22s4_quoted_num(0)),
            ("zone_id", m22s4_bare(0)),
            ("tile_x", m22s4_bare(0)),
            ("tile_y", m22s4_bare(0)),
            ("facing", m22s4_qtxt("North")),
            ("action", m22s4_qtxt("Idle")),
            ("move_started_at_ms", m22s4_quoted_num(0)),
            ("sprite_id", m22s4_bare(0)),
            ("move_queue", m22s4_arr(&[])),
        ]),
        "m22s4 [X1/zero-state]: an empty move queue renders an empty array."
    );

    let account = Account {
        identity: zero,
        auth_issuer: String::new(),
        created_at_ms: 0,
        last_login_at_ms: 0,
        status: AccountStatus::Active,
        deletion_requested_at_ms: None,
        claimed_from: None,
        claimed_at_ms: None,
        terminal_at_ms: None,
    };
    let out_account = super::json_account(&account);
    assert_eq!(
        out_account,
        m22s4_obj(&[
            ("identity", m22s4_qid(zero)),
            ("auth_issuer", m22s4_qtxt("")),
            ("created_at_ms", m22s4_quoted_num(0)),
            ("last_login_at_ms", m22s4_quoted_num(0)),
            ("status", m22s4_qtxt("Active")),
            ("deletion_requested_at_ms", m22s4_null()),
            ("claimed_from", m22s4_null()),
            ("claimed_at_ms", m22s4_null()),
            ("terminal_at_ms", m22s4_null()),
        ]),
        "m22s4 [X1/zero-state]: an EMPTY string is a pair of quotes, not an omitted key and not \
         null; all four absent options render the null literal."
    );

    for (label, out) in [
        ("player_dialogue_state", &out_dialogue),
        ("trade_offer", &out_trade),
        ("character", &out_character),
        ("account", &out_account),
    ] {
        assert!(
            m22s4_json_is_wellformed(out),
            "m22s4 [X1/zero-state/wellformed]: the zero-state `{label}` output is not exactly one \
             well-formed compact JSON value: {out:?}"
        );
    }
}

// ===========================================================================
// PRV1-11 / PRV1-12 / X2 — dispatch totality against the manifest.
// ===========================================================================

/// X2: the exporter registry and the manifest's exportable set are the SAME
/// SET, in BOTH directions, at exactly seventeen tables, in manifest ORDER.
///
/// Neither direction alone is enough. A forward-only check (every exporter
/// names an exportable table) is green on a registry that exports three tables
/// — a silently truncated subject-access response. A reverse-only check (every
/// exportable table has an exporter) is green on a registry that ALSO exports
/// something the manifest marks non-exportable, which is a PRV1-12 breach. The
/// ORDER clause is what makes chunk_index reproducible across two runs.
///
/// Kills: a missing exporter (the table is simply never walked);
///        an exporter for a non-exportable table;
///        two exporters registered under the same name (one shadows the other
///        and the set compare stays green by coincidence);
///        a registry re-sorted away from manifest order, which reshuffles every
///        chunk_index in the artifact for no reason.
#[test]
fn m22s4_exporter_set_equals_manifest_both_directions() {
    let manifest_order = m22s4_manifest_exportable();
    assert_eq!(
        manifest_order.len(),
        17,
        "m22s4 [X2/floor]: DATA_LIFECYCLE_MANIFEST carries {} exportable entries; the spec's \
         export scope is exactly SEVENTEEN (twelve erase tables plus four anonymize tables plus \
         character). If that number legitimately changed, the registry and this floor move \
         together, in one reviewed diff.",
        manifest_order.len()
    );

    let registry: Vec<String> = super::EXPORTERS.iter().map(|e| e.0.to_string()).collect();
    assert_eq!(
        registry.len(),
        17,
        "m22s4 [X2/floor]: the exporter registry carries {} entries; the manifest's exportable \
         set is 17.",
        registry.len()
    );

    let mut sorted_registry = registry.clone();
    sorted_registry.sort();
    for pair in sorted_registry.windows(2) {
        assert_ne!(
            pair[0], pair[1],
            "m22s4 [X2/dup]: the table `{}` is registered TWICE. A duplicate makes one of the two \
             entries dead while every set comparison stays green, and it writes the same \
             table_name into two different chunk groups of one request.",
            pair[0]
        );
    }

    for table in &manifest_order {
        assert!(
            registry.iter().any(|name| name == table),
            "m22s4 [X2/missing]: the manifest marks `{table}` exportable but the registry has no \
             reader for it. PRV1-11 promises one chunk per exportable table; an unregistered \
             table is silently absent from every subject-access response."
        );
    }
    for name in &registry {
        assert!(
            manifest_order.iter().any(|table| table == name),
            "m22s4 [X2/extra]: the registry registers `{name}`, which the manifest does NOT mark \
             exportable. Export scope is a THIRD, orthogonal axis and must stay structurally \
             NARROWER than deletion scope (PRV1-12)."
        );
    }

    assert_eq!(
        registry, manifest_order,
        "m22s4 [X2/order]: the registry must dispatch in MANIFEST ORDER. The two lists hold the \
         same names in a different sequence, so the request-wide chunk_index assigned to each \
         table would depend on the registry's internal ordering rather than on the documented \
         partition order."
    );
}

/// X2 (the const-fn teeth): `exporters_cover_manifest` and its `str_eq` helper
/// actually DECIDE, on fixture inputs the real manifest can never present.
///
/// The shipped const-eval assertion is a compile-time proof over ONE input
/// pair, which is exactly the input for which a hollowed-out predicate that
/// always returns true is indistinguishable from a correct one. These fixtures
/// are the only place the predicate is exercised on inputs that must come back
/// FALSE — plus a positive control, because a predicate that always returns
/// false would satisfy every negative on its own.
///
/// Kills: exporters_cover_manifest hardcoded to true (negatives 1-3);
///        hardcoded to false (the positive control);
///        a one-directional implementation that only checks manifest-to-exporter
///        (negative 2) or only exporter-to-manifest (negative 1);
///        an implementation that never reads the exportable flag (negative 3);
///        str_eq reduced to a length compare or a prefix compare.
#[test]
fn m22s4_exporter_totality_negative_fixtures() {
    // A real fn pointer of the registry's own type, borrowed rather than
    // written, so the fixtures need no shell reader of their own.
    let reader: super::ExportRows = super::EXPORTERS[0].1;

    // --- str_eq: the const-fn string primitive both directions rest on ------
    assert!(
        super::str_eq("alpha", "alpha"),
        "m22s4 [X2/str_eq]: str_eq must accept two equal strings."
    );
    assert!(
        !super::str_eq("alpha", "gamma"),
        "m22s4 [X2/str_eq]: str_eq must reject two DIFFERENT strings of the SAME length — a \
         length-only compare passes this pair."
    );
    assert!(
        !super::str_eq("player", "player_quest"),
        "m22s4 [X2/str_eq]: str_eq must reject a strict PREFIX. This is not hypothetical: the \
         live table names contain that exact prefix pair, so a prefix-tolerant compare would let \
         the `player` exporter satisfy the `player_quest` manifest entry and leave quest progress \
         out of the export."
    );
    assert!(
        !super::str_eq("player_quest", "player"),
        "m22s4 [X2/str_eq]: the prefix rejection must hold in BOTH argument orders."
    );
    assert!(
        super::str_eq("", ""),
        "m22s4 [X2/str_eq]: two empty strings are equal."
    );

    // --- positive control: the predicate can return TRUE --------------------
    let manifest_ok = [
        DataLifecycleEntry {
            table: "alpha",
            policy: DeletionPolicy::Erase,
            basis: "m22s4 fixture: an exportable table",
            exportable: true,
        },
        DataLifecycleEntry {
            table: "gamma",
            policy: DeletionPolicy::NotOwned,
            basis: "m22s4 fixture: a non-exportable table",
            exportable: false,
        },
    ];
    let exporters_ok: [(&str, super::ExportRows); 1] = [("alpha", reader)];
    assert!(
        super::exporters_cover_manifest(&manifest_ok, &exporters_ok),
        "m22s4 [X2/control]: exporters_cover_manifest must return TRUE for a manifest whose one \
         exportable table has exactly one exporter and whose non-exportable table has none. \
         Without this control every negative below is satisfied by a predicate that is simply \
         always false — which would ALSO turn the shipped const assertion into a compile error, \
         a very different failure to debug."
    );

    // --- negative 1: an exportable table with NO exporter -------------------
    let manifest_missing = [
        DataLifecycleEntry {
            table: "alpha",
            policy: DeletionPolicy::Erase,
            basis: "m22s4 fixture: an exportable table with a reader",
            exportable: true,
        },
        DataLifecycleEntry {
            table: "beta",
            policy: DeletionPolicy::Erase,
            basis: "m22s4 fixture: an exportable table with NO reader",
            exportable: true,
        },
    ];
    assert!(
        !super::exporters_cover_manifest(&manifest_missing, &exporters_ok),
        "m22s4 [X2/negative-missing]: a manifest with TWO exportable tables and only ONE exporter \
         must NOT be covered. This is the direction that fires when someone adds an exportable \
         table and forgets the reader — the case PRV1-11's totality claim exists for."
    );

    // --- negative 2: an exporter for a table the manifest never mentions ----
    let exporters_extra: [(&str, super::ExportRows); 2] = [("alpha", reader), ("delta", reader)];
    assert!(
        !super::exporters_cover_manifest(&manifest_ok, &exporters_extra),
        "m22s4 [X2/negative-extra]: an exporter naming a table that appears NOWHERE in the \
         manifest must NOT be covered. Unchecked, this direction lets the walk emit a table the \
         data-lifecycle classification never reviewed."
    );

    // --- negative 3: an exporter for a NON-exportable table -------
    let exporters_false_table: [(&str, super::ExportRows); 2] =
        [("alpha", reader), ("gamma", reader)];
    assert!(
        !super::exporters_cover_manifest(&manifest_ok, &exporters_false_table),
        "m22s4 [X2/negative-not-exportable]: `gamma` IS in the fixture manifest but carries \
         exportable false, and an exporter for it must NOT be covered. An implementation that \
         only checks table-name membership and never reads the exportable flag passes negatives 1 \
         and 2 and fails only here — and it is exactly the shape that would let the wild-seed \
         side table into a subject's export."
    );
}

// ===========================================================================
// PRV1-13 / X4 — sub-chunking and the request-wide index.
// ===========================================================================

/// PRV1-13 / X4: the planner splits at exactly the game-core boundary, and an
/// empty table still emits one chunk.
///
/// Seven row counts around the boundary, each checked for BOTH the chunk COUNT
/// (against an independent saturating-loop reference) and the exact payload of
/// every chunk (so a split at the right count but the wrong offsets fails).
///
/// Kills: an off-by-one boundary (499/500/501 disagree);
///        forwarding an empty vec straight to chunks() (0 rows would yield 0
///        chunks);
///        a planner that re-orders or duplicates rows across the split.
#[test]
fn m22s4_plan_chunks_boundaries() {
    let per = game_core::EXPORT_CHUNK_ROWS as usize;
    assert!(
        per >= 2,
        "m22s4 [X4/vacuity]: the game-core chunk size is {per}; the boundary cases below need at \
         least 2 to be distinguishable."
    );

    for rows_n in [0usize, 1, per - 1, per, per + 1, 2 * per, 2 * per + 1] {
        let rows: Vec<String> = (0..rows_n).map(|i| m22s4_row_text("monster", i)).collect();
        let plan = super::plan_export_chunks(vec![("monster", rows.clone())]);
        let expected_n = m22s4_expected_chunk_count(rows_n, per);
        assert_eq!(
            plan.len(),
            expected_n,
            "m22s4 [X4/count]: {rows_n} row(s) at {per} per chunk must plan {expected_n} chunk(s), \
             not {}. Zero rows is the load-bearing case: slice::chunks() yields NO chunks there, \
             so the table would vanish from the export.",
            plan.len()
        );
        for (k, chunk) in plan.iter().enumerate() {
            assert_eq!(
                chunk.chunk_index, k as u32,
                "m22s4 [X4/index]: chunk {k} of the {rows_n}-row case carries index {}, not {k}.",
                chunk.chunk_index
            );
            assert_eq!(
                chunk.table, "monster",
                "m22s4 [X4/table]: every chunk of a single-table request carries that table."
            );
            let lo = k * per;
            let hi = std::cmp::min(lo + per, rows_n);
            assert_eq!(
                chunk.payload,
                m22s4_expected_payload("monster", &rows[lo..hi]),
                "m22s4 [X4/payload]: chunk {k} of the {rows_n}-row case does not carry rows \
                 {lo}..{hi} in input order. A split with the right COUNT but the wrong offsets \
                 duplicates or drops the subject's rows while every count clause stays green."
            );
        }
    }
}

/// PRV1-13 / X4: the sub-chunk boundary IS the game-core constant, proven both
/// behaviourally and at the call site.
///
/// Kills: a hand-typed 500 in privacy.rs (the source clause), which would keep
///        working today and silently diverge the moment the constant is retuned;
///        a second, differently-sized chunks() call somewhere in the module.
#[test]
fn m22s4_chunk_boundary_is_game_core_constant() {
    let per = game_core::EXPORT_CHUNK_ROWS as usize;

    // --- behavioural: the observed split IS at `per` ------------------------
    let rows: Vec<String> = (0..(2 * per + 1))
        .map(|i| m22s4_row_text("monster", i))
        .collect();
    let plan = super::plan_export_chunks(vec![("monster", rows.clone())]);
    assert_eq!(
        plan.len(),
        3,
        "m22s4 [X4/const-behaviour]: {} rows at {per} per chunk must plan 3 chunks.",
        2 * per + 1
    );
    assert_eq!(
        plan[0].payload,
        m22s4_expected_payload("monster", &rows[0..per]),
        "m22s4 [X4/const-behaviour]: the FIRST chunk must hold exactly the first {per} rows — \
         that count IS game_core::EXPORT_CHUNK_ROWS, read symbolically here so retuning the \
         constant retunes this test with it."
    );
    assert_eq!(
        plan[1].payload,
        m22s4_expected_payload("monster", &rows[per..2 * per]),
        "m22s4 [X4/const-behaviour]: the SECOND chunk must hold the next {per} rows."
    );
    assert_eq!(
        plan[2].payload,
        m22s4_expected_payload("monster", &rows[2 * per..]),
        "m22s4 [X4/const-behaviour]: the remainder chunk must hold the single trailing row."
    );

    // --- source: the call site names the constant ---------------------------
    let squashed = stripped_for_scan(PRIVACY_RS);
    let call = ".chunks(";
    let n = rb22p_count(&squashed, call);
    assert_eq!(
        n, 1,
        "m22s4 [X4/const-site]: privacy.rs contains {n} `{call}` call(s); exactly one is the \
         contract. Zero means the sub-chunking moved somewhere this clause cannot see; two means \
         a second, independently-sized split exists."
    );
    let at = m22s4_idx(&squashed, call, "the sub-chunking call site");
    let rest = &squashed[at + call.len()..];
    let close = m22s4_idx(rest, ")", "the sub-chunking call's closing paren");
    let arg = &rest[..close];
    assert!(
        arg.contains("EXPORT_CHUNK_ROWS"),
        "m22s4 [X4/const-site]: the sub-chunk size is spelled `{arg}`, which does not name \
         EXPORT_CHUNK_ROWS. game-core owns that number and its own doc instructs this module to \
         cast it at the chunks() call site; a hand-typed literal is a second source of truth that \
         passes every behavioural clause today and diverges silently the day it is retuned."
    );
}

/// PRV1-13 / X4 (scale): the largest bounded table in the export plans exactly
/// the count the boundary rule implies.
///
/// The telemetry table is globally capped, so its cap is the realistic worst
/// case for one owner. Both the literal expectation and the derived one are
/// asserted: the literal catches a silently changed cap, the derived one
/// catches a silently changed boundary.
///
/// Kills: a planner that degrades (drops or merges chunks) above some internal
///        size; an off-by-one in the final partial chunk at scale.
#[test]
fn m22s4_plan_chunks_at_playtest_cap_scale() {
    let per = game_core::EXPORT_CHUNK_ROWS as usize;
    let cap = PLAYTEST_EVENT_CAP as usize;
    assert_eq!(
        cap, 20_000,
        "m22s4 [X4/scale-vacuity]: the telemetry cap is {cap}, not the 20000 this scale case was \
         sized against. Re-derive the expected chunk count before editing anything else."
    );

    let rows: Vec<String> = (0..cap)
        .map(|i| m22s4_row_text("playtest_event", i))
        .collect();
    let plan = super::plan_export_chunks(vec![("playtest_event", rows.clone())]);

    assert_eq!(
        plan.len(),
        40,
        "m22s4 [X4/scale]: {cap} rows at {per} per chunk must plan exactly 40 chunks, not {}.",
        plan.len()
    );
    assert_eq!(
        plan.len(),
        m22s4_expected_chunk_count(cap, per),
        "m22s4 [X4/scale-derived]: the planned count must also equal the INDEPENDENTLY derived \
         count, so the literal 40 above and the boundary rule cannot drift apart."
    );
    for (k, chunk) in plan.iter().enumerate() {
        assert_eq!(
            chunk.chunk_index, k as u32,
            "m22s4 [X4/scale]: chunk indices must stay contiguous at scale; chunk {k} carries {}.",
            chunk.chunk_index
        );
        assert_eq!(
            chunk.table, "playtest_event",
            "m22s4 [X4/scale]: every chunk must carry the table it stands for."
        );
    }
    assert_eq!(
        plan[0].payload,
        m22s4_expected_payload("playtest_event", &rows[0..per]),
        "m22s4 [X4/scale]: the first chunk at scale must still hold exactly the first {per} rows."
    );
    assert_eq!(
        plan[39].payload,
        m22s4_expected_payload("playtest_event", &rows[39 * per..cap]),
        "m22s4 [X4/scale]: the LAST chunk must hold the trailing rows and nothing else — the \
         place an off-by-one at scale actually shows up."
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// PRV1-13 / X4 (request-wide invariants): over random per-table row counts,
    /// the plan's chunk_index is EXACTLY 0..N-1 (unique and contiguous ACROSS
    /// tables, not per table), every input table appears, an empty table appears
    /// exactly once, and grouping by table then reading in chunk_index order
    /// reproduces the input row order.
    ///
    /// total_chunks is not a field of the planned chunk: it IS the plan length,
    /// identical on every row of the request, which is what makes the client's
    /// wait rule (collected chunks equals total_chunks) implementable at all. A
    /// per-table index would make that rule incoherent.
    ///
    /// Kills: a per-table chunk_index restarting at 0 for each table;
    ///        a plan that skips or repeats an index;
    ///        a table dropped because it had no rows;
    ///        rows reordered across the split.
    #[test]
    fn m22s4_plan_chunks_request_wide_invariants(
        counts in prop::collection::vec(
            prop::sample::select(vec![0usize, 1, 2, 250, 499, 500, 501, 750, 1000, 1001]),
            1..=5usize,
        ),
    ) {
        let per = game_core::EXPORT_CHUNK_ROWS as usize;
        let mut per_table: Vec<(&'static str, Vec<String>)> = Vec::new();
        for (t, n) in counts.iter().enumerate() {
            let table = M22S4_PLAN_TABLES[t];
            let rows: Vec<String> = (0..*n).map(|i| m22s4_row_text(table, i)).collect();
            per_table.push((table, rows));
        }
        let expected = m22s4_reference_plan(&per_table, per);
        let plan = super::plan_export_chunks(per_table.clone());

        prop_assert_eq!(
            plan.len(),
            expected.len(),
            "the plan must hold one chunk per sub-chunk plus one per EMPTY table"
        );
        for (k, chunk) in plan.iter().enumerate() {
            prop_assert_eq!(
                expected[k].1,
                k as u32,
                "the reference plan itself must number chunks contiguously"
            );
            prop_assert_eq!(
                chunk.chunk_index,
                k as u32,
                "chunk_index must be REQUEST-wide and contiguous, never restarted per table"
            );
            prop_assert_eq!(
                chunk.table,
                expected[k].0,
                "chunks must be grouped by table in dispatch order"
            );
            prop_assert_eq!(
                &chunk.payload,
                &expected[k].2,
                "each chunk must carry its own slice of the input rows, in input order"
            );
        }
        for (table, rows) in &per_table {
            let seen = plan.iter().filter(|c| c.table == *table).count();
            prop_assert!(
                seen >= 1,
                "every input table must appear in the plan, including one with no rows"
            );
            if rows.is_empty() {
                prop_assert_eq!(seen, 1, "a table with no rows must appear EXACTLY once");
            }
        }
    }
}

/// PRV1-11 / X5 (behavioural): the per-turn secret action's own-row predicate
/// answers on IDENTITY, not on the battle.
///
/// TWO ROWS, ONE battle id. That is the whole point: a leaked pending PvP pick
/// is a competitively decisive exploit, and the shape that leaks it is a
/// predicate written against the row's battle rather than its submitter — which
/// a single-row fixture cannot distinguish.
///
/// Kills: a predicate keyed on battle_id (true for BOTH rows here);
///        a predicate that ignores its identity argument (true for both);
///        an inverted comparison (false for both);
///        a predicate keyed on action_id or turn_number.
#[test]
fn m22s4_battle_action_own_predicate() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let c = m22s4_id_c();
    let mine = m22s4_action_row(1, a);
    let theirs = m22s4_action_row(2, b);

    assert_eq!(
        mine.battle_id, theirs.battle_id,
        "m22s4 [X5/action-vacuity]: the two fixtures must share one battle id, or a predicate \
         keyed on the battle would be indistinguishable from a correct one."
    );

    assert!(
        super::battle_action_is_own(&mine, a),
        "m22s4 [X5/action]: the submitter's own row IS their own."
    );
    assert!(
        !super::battle_action_is_own(&theirs, a),
        "m22s4 [X5/action]: the COUNTERPARTY's row in the SAME battle is NOT the subject's. A \
         predicate keyed on battle_id returns true here and hands a live opponent's pending pick \
         to the other player."
    );
    assert!(
        super::battle_action_is_own(&theirs, b),
        "m22s4 [X5/action]: the predicate must answer true for the OTHER identity's own row too, \
         so a constant-false implementation fails."
    );
    assert!(
        !super::battle_action_is_own(&mine, b),
        "m22s4 [X5/action]: mirror image of the leak case."
    );
    assert!(
        !super::battle_action_is_own(&mine, c),
        "m22s4 [X5/action]: a third party who submitted nothing owns neither row."
    );
    assert!(
        !super::battle_action_is_own(&theirs, c),
        "m22s4 [X5/action]: a third party who submitted nothing owns neither row."
    );
}

/// PRV1-11 / X5 (behavioural): the telemetry table's own-row predicate answers
/// on IDENTITY, not on the battle. Same two-row, one-battle trap as above.
///
/// Kills: a predicate keyed on battle_id, event_id, kind or created_at_ms;
///        a predicate that ignores its identity argument;
///        an inverted comparison.
#[test]
fn m22s4_playtest_event_own_predicate() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let c = m22s4_id_c();
    let mine = m22s4_playtest_row(1, a);
    let theirs = m22s4_playtest_row(2, b);

    assert_eq!(
        mine.battle_id, theirs.battle_id,
        "m22s4 [X5/telemetry-vacuity]: the two fixtures must share one battle id."
    );
    assert_eq!(
        mine.kind, theirs.kind,
        "m22s4 [X5/telemetry-vacuity]: the two fixtures must share one event kind, so a \
         predicate keyed on the kind is not accidentally correct."
    );

    assert!(
        super::playtest_event_is_own(&mine, a),
        "m22s4 [X5/telemetry]: the subject's own telemetry row IS their own."
    );
    assert!(
        !super::playtest_event_is_own(&theirs, a),
        "m22s4 [X5/telemetry]: another identity's row from the SAME battle is NOT the subject's. \
         The table is unindexed and must-never-leak, so the scan's only bound is this predicate."
    );
    assert!(
        super::playtest_event_is_own(&theirs, b),
        "m22s4 [X5/telemetry]: the predicate must answer true for the other identity's own row."
    );
    assert!(
        !super::playtest_event_is_own(&mine, b),
        "m22s4 [X5/telemetry]: mirror image of the leak case."
    );
    assert!(
        !super::playtest_event_is_own(&mine, c),
        "m22s4 [X5/telemetry]: a third party owns neither row."
    );
    assert!(
        !super::playtest_event_is_own(&theirs, c),
        "m22s4 [X5/telemetry]: a third party owns neither row."
    );
}

// ===========================================================================
// X6 — the battle redaction (the only redaction that does anything).
// ===========================================================================

/// X6: the side-of-the-battle classifier is TOTAL and answers all four cases.
///
/// `Both` is not a defensive extra: a practice battle stores the same identity
/// on both sides, and collapsing it into `A` (or into `B`) is what would let a
/// later reader redact half of a row the subject wholly owns.
///
/// Kills: an if/else that returns A whenever the subject is on side A and never
///        reaches Both;
///        a classifier that returns A (or B) for a stranger, which would emit a
///        battle between two other players into a third party's export;
///        a comparison against the wrong column.
#[test]
fn m22s4_battle_side_of_truth_table() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let c = m22s4_id_c();

    let pvp = m22s4_battle_row(a, b);
    assert_eq!(
        super::battle_side_of(a, &pvp),
        super::BattleSideOwnership::A,
        "m22s4 [X6/side]: the identity on player_identity holds side A."
    );
    assert_eq!(
        super::battle_side_of(b, &pvp),
        super::BattleSideOwnership::B,
        "m22s4 [X6/side]: the identity on opponent_identity holds side B."
    );
    assert_eq!(
        super::battle_side_of(c, &pvp),
        super::BattleSideOwnership::Neither,
        "m22s4 [X6/side]: a third party holds NEITHER side. This is the arm that stops a filter \
         bug from emitting two other players' battle into a stranger's export."
    );

    let practice = m22s4_battle_row(a, a);
    assert_eq!(
        super::battle_side_of(a, &practice),
        super::BattleSideOwnership::Both,
        "m22s4 [X6/side]: a practice battle stores ONE identity on both columns, and the subject \
         holds BOTH sides. Collapsing this into A (the shape a plain if/else produces) makes the \
         serializer redact half of a row the subject wholly owns."
    );
    assert_eq!(
        super::battle_side_of(c, &practice),
        super::BattleSideOwnership::Neither,
        "m22s4 [X6/side]: a stranger holds neither side of a practice battle either."
    );
}

/// X6: the counterparty's identity AND monster list are nulled, the practice
/// battle is emitted whole, and a row the requester participates in on neither
/// side is a LOUD error.
///
/// Kills: redacting the identity but not the monster-id list (the list is a
///        durable fingerprint of the other player's team);
///        redacting the wrong side (mirror-image bug — both directions are
///        asserted);
///        redacting a practice battle's own second half;
///        silently skipping a not-mine row instead of failing loud, which turns
///        a filter bug into a silent partial export;
///        emitting the counterparty's identity anywhere in the payload (each
///        direction additionally asserts the raw hex is ABSENT, not merely that
///        the column is null).
#[test]
fn m22s4_battle_redacts_counterparty() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let c = m22s4_id_c();
    let row = m22s4_battle_row(a, b);

    // --- the requester is side A -------------------------------------------
    let out_a = super::json_battle(&row, a)
        .unwrap_or_else(|e| panic!("m22s4 [X6/redact]: side A must serialize: {e}"));
    assert_eq!(
        out_a,
        m22s4_expected_battle(
            m22s4_qid(a),
            m22s4_null(),
            m22s4_party_ids_json(),
            m22s4_null(),
        ),
        "m22s4 [X6/redact-a]: for a requester on side A, the OPPONENT identity and the OPPONENT \
         monster-id list must BOTH be null, and the requester's own side must be intact."
    );
    assert!(
        !out_a.contains(&b.to_string()),
        "m22s4 [X6/redact-a]: the counterparty's identity hex appears in the payload. Nulling the \
         column is not enough if the value is echoed anywhere else in the object."
    );
    assert!(
        !out_a.contains(&m22s4_opponent_ids_json()),
        "m22s4 [X6/redact-a]: the counterparty's monster-id list appears in the payload. That \
         list is a durable fingerprint of the other player's team."
    );

    // --- the requester is side B (the mirror image) ------------------------
    let out_b = super::json_battle(&row, b)
        .unwrap_or_else(|e| panic!("m22s4 [X6/redact]: side B must serialize: {e}"));
    assert_eq!(
        out_b,
        m22s4_expected_battle(
            m22s4_null(),
            m22s4_qid(b),
            m22s4_null(),
            m22s4_opponent_ids_json(),
        ),
        "m22s4 [X6/redact-b]: the mirror image. An implementation that always nulls the OPPONENT \
         columns passes the side-A clause and leaks the other player's identity to every side-B \
         requester."
    );
    assert!(
        !out_b.contains(&a.to_string()),
        "m22s4 [X6/redact-b]: the counterparty's identity hex appears in the payload."
    );
    assert!(
        !out_b.contains(&m22s4_party_ids_json()),
        "m22s4 [X6/redact-b]: the counterparty's monster-id list appears in the payload."
    );

    // --- a practice battle is emitted whole --------------------------------
    let practice = m22s4_battle_row(a, a);
    let out_p = super::json_battle(&practice, a)
        .unwrap_or_else(|e| panic!("m22s4 [X6/redact]: a practice battle must serialize: {e}"));
    assert_eq!(
        out_p,
        m22s4_expected_battle(
            m22s4_qid(a),
            m22s4_qid(a),
            m22s4_party_ids_json(),
            m22s4_opponent_ids_json(),
        ),
        "m22s4 [X6/practice]: a practice battle has ONE participant on both sides, so there is no \
         counterparty and NOTHING is redacted. Every column belongs to the subject."
    );
    assert_eq!(
        rb22p_count(&out_p, "null"),
        0,
        "m22s4 [X6/practice]: a practice battle's payload must contain no null at all. A \
         classifier that collapses Both into A would null two of the subject's own columns here."
    );

    // --- neither side is a LOUD error --------------------------------------
    let stranger = super::json_battle(&row, c);
    assert!(
        stranger.is_err(),
        "m22s4 [X6/neither]: serializing a battle the requester participates in on NEITHER side \
         must be a loud error, never a redacted-but-emitted row and never a silent skip. That \
         call is only reachable through a bug in the owner-scoped read, and the whole value of \
         the arm is that such a bug stops the export instead of quietly shipping two other \
         players' battle into a third party's personal-data download."
    );
}

/// X6: the nested battle-state blob is NEVER emitted.
///
/// The state column is a deep game-core structure holding both sides' full
/// team rosters; field-level redaction of it is high-cost and high-risk, so it
/// is OMITTED entirely and the subject's live access to it is unaffected. This
/// test proves the omission by VALUE, not by field name alone: every fixture
/// value inside the state is distinctive and multi-digit, and each is first
/// asserted PRESENT in the state's own debug rendering (so the ban list cannot
/// be a list of typos) and then asserted ABSENT from the payload.
///
/// Kills: emitting the state as a nested object;
///        lifting any part of it (an outcome, a turn counter, a team roster)
///        into the row object;
///        a debug-format fallback that stringifies the whole struct.
#[test]
fn m22s4_battle_state_blob_is_never_emitted() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let row = m22s4_battle_row(a, b);
    let out = super::json_battle(&row, a)
        .unwrap_or_else(|e| panic!("m22s4 [X6/state]: the row must serialize: {e}"));
    let rendered = format!("{:?}", m22s4_battle_state());

    for needle in [
        "9091",
        "213",
        "1777",
        "8888",
        "8181",
        "6161",
        "6262",
        "6363",
        "6464",
        "6565",
        "7007",
        "8008",
        "3131",
        "Electric",
        "Ongoing",
        "side_a",
        "side_b",
        "outcome",
        "turn_number",
        "weather",
        "team",
        "active",
        "known_skill_ids",
        "max_hp",
        "affinity",
        "stats",
    ] {
        assert!(
            rendered.contains(needle),
            "m22s4 [X6/state-vacuity]: `{needle}` does not appear in the battle state's own \
             rendering, so banning it from the payload proves nothing. Fix the fixture, never the \
             ban list."
        );
        assert!(
            !out.contains(needle),
            "m22s4 [X6/state]: the battle payload contains `{needle}`, which comes from the \
             nested state blob. The state column is deliberately OMITTED from the export: it \
             carries both sides' full team rosters, and field-level redaction of a deep nested \
             structure is strictly more code and more risk than omission. Payload: {out:?}"
        );
    }

    assert!(
        !out.contains("state"),
        "m22s4 [X6/state]: the payload names the `state` column. It must not appear as a key at \
         all, not even with a null or an empty value."
    );
    assert_eq!(
        rb22p_count(&out, ":"),
        6,
        "m22s4 [X6/state-arity]: the battle payload must carry EXACTLY six key/value pairs (the \
         seven columns minus the omitted state). A seventh key is either the state creeping back \
         or an unreviewed addition to a durable artifact. Payload: {out:?}"
    );
}

/// X6: the per-turn secret action table needs no redaction because the own-rows
/// filter already makes one structurally impossible — asserted, not assumed.
///
/// The redaction is VACUOUS BY CONSTRUCTION and that is a claim with teeth: it
/// holds only while the own-rows predicate is the SOLE bound on the scan and
/// every surviving row belongs to the subject. Both halves are checked here,
/// behaviourally and structurally.
///
/// Kills: a serializer that nulls the submitter's OWN identity (over-redaction
///        that silently empties the subject's own export);
///        a reader that serializes before it filters, so a foreign row is
///        rendered (and could be logged or partially emitted) on the way;
///        a second, unfiltered read path into the same table.
#[test]
fn m22s4_battle_action_own_rows_only() {
    let a = m22s4_id_a();
    let b = m22s4_id_b();
    let mine = m22s4_action_row(1, a);
    let theirs = m22s4_action_row(2, b);

    // --- behavioural: the filter is what makes the redaction vacuous -------
    let kept: Vec<&BattleAction> = [&mine, &theirs]
        .into_iter()
        .filter(|row| super::battle_action_is_own(row, a))
        .collect();
    assert_eq!(
        kept.len(),
        1,
        "m22s4 [X6/action-filter]: of two rows in one battle, exactly ONE is the subject's."
    );
    assert_eq!(
        kept[0].action_id, 1,
        "m22s4 [X6/action-filter]: the surviving row must be the subject's own."
    );

    let out = super::json_battle_action(kept[0]);
    assert!(
        out.contains(&a.to_string()),
        "m22s4 [X6/action-no-redaction]: the subject's OWN identity must be emitted unredacted. \
         The redaction is vacuous because no counterparty row is ever in the result set — not \
         because the column is blanked. Nulling it here would empty the subject's own export."
    );
    assert!(
        !out.contains(&b.to_string()),
        "m22s4 [X6/action-no-redaction]: no other identity may appear in the payload."
    );
    assert_eq!(
        rb22p_count(&out, "null"),
        0,
        "m22s4 [X6/action-no-redaction]: this table has no nullable column and needs no \
         redaction; a null in the payload means something was blanked that should not have been."
    );

    // --- structural: the scan is bounded BEFORE anything is serialized -----
    let squashed = stripped_for_scan(PRIVACY_RS);
    let body = m22s4_rows_body(&squashed, "battle_action");
    let pred_at = m22s4_idx(&body, "battle_action_is_own(", "the own-row predicate call");
    let ser_at = m22s4_idx(&body, "json_battle_action(", "the row serializer call");
    assert!(
        pred_at < ser_at,
        "m22s4 [X6/action-order]: the reader serializes rows BEFORE narrowing them to the \
         subject's own. The own-rows filter is the only thing standing between an unindexed scan \
         of a must-never-leak table and every player's pending pick, so it must bound the scan, \
         not post-process its output."
    );
    assert_eq!(
        rb22p_count(&body, ".iter()"),
        1,
        "m22s4 [X6/action-order]: exactly one scan; a second read path into this table would be \
         unbounded by the clause above."
    );
}

// ===========================================================================
// X7 — the JSON escaping and numeric-encoding contract.
// ===========================================================================

/// X7: the escaper's edge cases, each spelled from the CONTRACT.
///
/// The rule is deliberately UNIFORM: exactly three escapes exist — the quote,
/// the backslash, and the six-character control form with LOWERCASE hex. No
/// two-character short forms, because one branch is one test family and a short
/// form is a second, separately-buggy path. The solidus and DEL are explicitly
/// NOT escaped, and everything at or above the space passes through as UTF-8.
///
/// Kills: escaping only the quote and not the backslash (or vice versa);
///        a short form for line feed / tab / carriage return;
///        UPPERCASE hex in the control form (a strict consumer rejects neither,
///        but the contract is one spelling and the reference unescaper below
///        enforces it);
///        escaping the solidus or DEL (harmless but off-contract, and it makes
///        the round-trip property's reference implementation wrong);
///        mangling multi-byte UTF-8 by working over bytes instead of chars.
#[test]
fn m22s4_escape_edge_cases() {
    let dq = rb22p_dq().to_string();
    assert_eq!(
        m22s4_esc(&dq),
        m22s4_esc_quote(),
        "m22s4 [X7/quote]: a double quote must become backslash + quote. Unescaped, it CLOSES the \
         JSON string early and the rest of a player-authored name is parsed as structure."
    );

    let bs = m22s4_bs().to_string();
    assert_eq!(
        m22s4_esc(&bs),
        m22s4_esc_backslash(),
        "m22s4 [X7/backslash]: a backslash must be doubled. Left alone it turns the NEXT \
         character into an escape the consumer never intended."
    );

    for code in 0u32..0x20 {
        let c = char::from_u32(code).expect("m22s4 [X7/control]: every C0 code is a scalar value");
        assert_eq!(
            m22s4_esc(&c.to_string()),
            m22s4_u_esc(code),
            "m22s4 [X7/control]: the C0 byte U+{code:04X} must become the UNIFORM six-character \
             escape with lowercase hex. Raw control bytes are invalid inside a JSON string, and a \
             two-character short form for some of them is a second branch with its own bugs."
        );
    }

    assert_eq!(
        m22s4_esc("/"),
        "/",
        "m22s4 [X7/solidus]: the solidus is NOT escaped. Escaping it is legal JSON but it is not \
         this contract, and the reference unescaper would then reject the output."
    );
    assert_eq!(
        m22s4_esc("\u{007F}"),
        "\u{007F}",
        "m22s4 [X7/del]: DEL is not a C0 control and is NOT escaped."
    );
    assert_eq!(
        m22s4_esc("\u{00E9}\u{4E2D}\u{1F600}"),
        "\u{00E9}\u{4E2D}\u{1F600}",
        "m22s4 [X7/utf8]: 2-, 3- and 4-byte UTF-8 pass through untouched. An escaper written over \
         BYTES rather than chars mangles all three."
    );

    assert_eq!(
        m22s4_esc(&m22s4_nasty()),
        m22s4_nasty_escaped(),
        "m22s4 [X7/composite]: the whole adversarial string, escaped in one pass, must equal the \
         concatenation of the per-case rules above."
    );
    assert_eq!(
        m22s4_str(&m22s4_nasty()),
        m22s4_nasty_json(),
        "m22s4 [X7/framing]: the string emitter is quote + escape + quote, and the framing quotes \
         are the ONLY unescaped quotes in its output."
    );

    let mut short_form = String::new();
    short_form.push(m22s4_bs());
    short_form.push('n');
    assert_ne!(
        m22s4_esc("\n"),
        short_form,
        "m22s4 [X7/no-short-form]: the line feed must NOT use the two-character short form. The \
         contract has exactly one control branch on purpose."
    );
}

proptest! {
    /// X7 (round trip): for ANY string, the escaper is LOSSLESS under a
    /// reference unescaper that exists only in this test file.
    ///
    /// The inverse lives here and only here: shipping one in privacy.rs would
    /// give the property a shared bug to agree on. The generator is explicit
    /// rather than the default string strategy, which excludes control
    /// characters — exactly the class this property exists to cover.
    ///
    /// Kills: dropping a character; emitting an escape the contract does not
    ///        admit; uppercase hex; a truncated control escape; double-escaping.
    #[test]
    fn m22s4_escape_roundtrip_property(s in m22s4_arb_text()) {
        let escaped = m22s4_esc(&s);
        match m22s4_unescape(&escaped) {
            Ok(back) => {
                prop_assert_eq!(
                    back,
                    s,
                    "the escaper must be LOSSLESS: unescaping its output must reproduce the input"
                );
            }
            Err(why) => {
                prop_assert!(
                    false,
                    "the escaper emitted text the contract's own inverse rejects: {}",
                    why
                );
            }
        }
    }

    /// X7 (structural): the escaper's output carries NO raw control byte and no
    /// unescaped quote, checked by an INDEPENDENT backslash-parity walk rather
    /// than through the reference unescaper — so a shared misunderstanding
    /// between the escaper and the unescaper cannot make both green.
    ///
    /// Kills: a raw quote surviving into the output (it terminates the string
    ///        early and everything after it is parsed as structure);
    ///        a raw control byte surviving (invalid JSON, and a real injection
    ///        surface in a downloadable artifact);
    ///        an escape whose partner character is itself a control byte;
    ///        a string emitter whose framing quotes are not exactly two.
    #[test]
    fn m22s4_escape_output_has_no_raw_control_or_quote(s in m22s4_arb_text()) {
        let escaped = m22s4_esc(&s);
        let chars: Vec<char> = escaped.chars().collect();
        let mut i = 0usize;
        while i < chars.len() {
            let c = chars[i];
            prop_assert!(
                (c as u32) >= 0x20,
                "a RAW control character survived escaping at char {}",
                i
            );
            if c == m22s4_bs() {
                prop_assert!(i + 1 < chars.len(), "the output ends in a lone backslash");
                prop_assert!(
                    (chars[i + 1] as u32) >= 0x20,
                    "an escape at char {} is followed by a raw control character",
                    i
                );
                i += 2;
                continue;
            }
            prop_assert!(
                c != rb22p_dq(),
                "an UNESCAPED double quote survived at char {}",
                i
            );
            i += 1;
        }

        let quoted = m22s4_str(&s);
        prop_assert_eq!(
            quoted.chars().count(),
            escaped.chars().count() + 2,
            "the string emitter must add exactly two framing quotes and nothing else"
        );
        prop_assert!(
            m22s4_json_is_wellformed(&quoted),
            "the quoted output must parse as exactly ONE JSON string value"
        );
    }
}

/// Text generator for the two escaper properties.
///
/// The DEFAULT string strategy excludes control characters, so it would never
/// exercise the branch this contract is mostly about. This one is weighted
/// toward the hazards: C0 controls, the quote, the backslash, the solidus, DEL,
/// printable ASCII, the basic multilingual plane and astral scalars.
fn m22s4_arb_char() -> impl Strategy<Value = char> {
    prop_oneof![
        4 => prop::char::range('\u{0000}', '\u{001F}'),
        3 => Just(rb22p_dq()),
        3 => Just(m22s4_bs()),
        1 => Just('/'),
        1 => Just('\u{007F}'),
        6 => prop::char::range('\u{0020}', '\u{007E}'),
        3 => prop::char::range('\u{00A0}', '\u{D7FF}'),
        2 => prop::char::range('\u{10000}', '\u{10FFFF}'),
    ]
}

/// A short random text over `m22s4_arb_char`.
fn m22s4_arb_text() -> impl Strategy<Value = String> {
    prop::collection::vec(m22s4_arb_char(), 0..24usize).prop_map(|v| v.into_iter().collect())
}

/// X7: 64-bit integers are QUOTED decimal strings.
///
/// The client assembles the downloaded chunks with a parser whose numbers are
/// doubles, so a bare 64-bit integer above 2^53 comes back SILENTLY WRONG — a
/// wallet balance, a row id or an input sequence off by a few units, in the
/// subject's own personal-data export. Every expected literal below is typed
/// out digit by digit rather than derived from the value under test.
///
/// Kills: a bare emitter for u64 or i64;
///        an emitter that saturates or truncates at the extremes;
///        an emitter that renders the sign outside the quotes.
#[test]
fn m22s4_u64_i64_are_quoted_strings() {
    assert_eq!(
        m22s4_u64_out(0),
        m22s4_qtxt("0"),
        "m22s4 [X7/u64]: zero is still the quoted form — the rule is per TYPE, not per value."
    );
    assert_eq!(
        m22s4_u64_out(9_007_199_254_740_993),
        m22s4_qtxt("9007199254740993"),
        "m22s4 [X7/u64]: one above 2^53 is the smallest value a double cannot represent exactly. \
         A bare number here is the silent-corruption case."
    );
    assert_eq!(
        m22s4_u64_out(u64::MAX),
        m22s4_qtxt("18446744073709551615"),
        "m22s4 [X7/u64]: the maximum must render in full, with no exponent and no rounding."
    );

    assert_eq!(
        m22s4_i64_out(0),
        m22s4_qtxt("0"),
        "m22s4 [X7/i64]: zero is still the quoted form."
    );
    assert_eq!(
        m22s4_i64_out(-1),
        m22s4_qtxt("-1"),
        "m22s4 [X7/i64]: the sign belongs INSIDE the quotes, as part of the decimal text."
    );
    assert_eq!(
        m22s4_i64_out(i64::MIN),
        m22s4_qtxt("-9223372036854775808"),
        "m22s4 [X7/i64]: the minimum has no positive counterpart, so any implementation that \
         negates before formatting overflows here."
    );
    assert_eq!(
        m22s4_i64_out(i64::MAX),
        m22s4_qtxt("9223372036854775807"),
        "m22s4 [X7/i64]: the maximum must render in full."
    );
}

/// X7: everything 32 bits or narrower, and the bool and null literals, are
/// BARE.
///
/// The mirror of the clause above and equally load-bearing: quoting a small
/// integer turns a number into a string in a durable artifact, and the client
/// assembler would then do arithmetic on text.
///
/// Kills: a blanket quoted emitter applied to every integer width;
///        a bool rendered as a quoted word or as 0/1;
///        an absent option rendered as a quoted word.
#[test]
fn m22s4_small_ints_are_bare() {
    let outputs = [
        ("u32/min", m22s4_u32_out(0), "0".to_string()),
        ("u32/max", m22s4_u32_out(u32::MAX), "4294967295".to_string()),
        ("u16/max", m22s4_u16_out(u16::MAX), "65535".to_string()),
        ("u8/max", m22s4_u8_out(u8::MAX), "255".to_string()),
        (
            "i32/min",
            m22s4_i32_out(i32::MIN),
            "-2147483648".to_string(),
        ),
        ("i32/max", m22s4_i32_out(i32::MAX), "2147483647".to_string()),
        ("i32/neg", m22s4_i32_out(-25), "-25".to_string()),
        ("bool/true", m22s4_bool_out(true), "true".to_string()),
        ("bool/false", m22s4_bool_out(false), "false".to_string()),
        ("null", m22s4_null_out(), "null".to_string()),
    ];
    for (label, got, want) in &outputs {
        assert_eq!(
            got, want,
            "m22s4 [X7/bare]: the `{label}` emitter must produce the BARE JSON literal."
        );
        assert!(
            !got.contains(rb22p_dq()),
            "m22s4 [X7/bare]: the `{label}` emitter produced a QUOTE. Quoting a 32-bit-or-narrower \
             column turns a number into a string in a durable artifact, and the client assembler \
             would then do arithmetic on text."
        );
    }
}

/// X7: an identity renders as 64 LOWERCASE hex digits inside quotes.
///
/// Three independent instruments, because a single one is either tautological
/// or blind: the SHAPE (length, charset, case), an INDEPENDENT expected value
/// built by repeating the byte's hex pair (no call to the identity's own
/// formatter), and a tie back to that formatter so the module keeps ONE
/// spelling of the rule.
///
/// Kills: uppercase hex (breaks byte-for-byte comparison against every other
///        identity rendering in the system);
///        a truncated or zero-padded-to-the-wrong-width rendering;
///        a debug rendering that wraps the hex in a type name;
///        an emitter that forgets the quotes (an unquoted hex run is not a JSON
///        value at all);
///        an emitter that renders every identity alike.
#[test]
fn m22s4_identity_is_64_lowercase_hex() {
    let id = m22s4_id(0xAB);
    let out = m22s4_ident_out(id);

    assert_eq!(
        out.chars().count(),
        66,
        "m22s4 [X7/identity-len]: the rendering must be exactly 64 hex digits plus two framing \
         quotes; got {out:?}."
    );
    assert!(
        out.starts_with(rb22p_dq()) && out.ends_with(rb22p_dq()),
        "m22s4 [X7/identity-frame]: the hex must be QUOTED — a bare hex run is not a JSON value."
    );

    let inner: String = out.chars().skip(1).take(64).collect();
    assert!(
        inner.chars().all(|c| c.is_ascii_hexdigit()),
        "m22s4 [X7/identity-charset]: the rendering contains a non-hex character: {inner:?}."
    );
    assert!(
        !inner.chars().any(|c| c.is_ascii_uppercase()),
        "m22s4 [X7/identity-case]: the rendering uses UPPERCASE hex. Every other identity \
         rendering in the system is fixed-width lowercase, and a case mismatch silently breaks \
         string comparison against them: {inner:?}."
    );
    assert_eq!(
        inner,
        m22s4_id_hex(0xAB),
        "m22s4 [X7/identity-value]: the rendering does not match the byte pattern built \
         INDEPENDENTLY of the identity formatter."
    );

    let other = m22s4_id(0x0F);
    assert_eq!(
        m22s4_ident_out(other),
        m22s4_qtxt(&m22s4_id_hex(0x0F)),
        "m22s4 [X7/identity-value]: a second identity, chosen so its hex pair needs a leading \
         zero, must also render exactly."
    );
    assert_ne!(
        m22s4_ident_out(id),
        m22s4_ident_out(other),
        "m22s4 [X7/identity-distinct]: two different identities must not render alike — a \
         constant emitter passes every shape clause above."
    );
    assert_eq!(
        out,
        m22s4_qtxt(&id.to_string()),
        "m22s4 [X7/identity-ssot]: the emitter must be the identity's own display rendering, \
         quoted — not a second, separately-drifting hex formatter."
    );
}

// ===========================================================================
// X8 — the export cooldown (reject, never clamp).
// ===========================================================================

/// X8: the cooldown predicate's truth table, boundary included.
///
/// The boundary is inclusive at exactly the window, matching every other
/// elapsed-time rule in the module. Both extremes are exercised because the
/// release profile has overflow checks ON: a wrapping subtraction here would
/// PANIC inside a reducer and abort its whole transaction in production.
///
/// Kills: a strictly-greater boundary (the request at exactly the window is
///        rejected forever if the caller retries on the same tick);
///        a request-blind comparison against the raw clock (which allows
///        everything once the epoch clock passes the threshold);
///        a wrapping subtraction (panics at the extremes);
///        accepting a future-dated stamp (clock skew would reopen the window).
#[test]
fn m22s4_cooldown_truth_table() {
    let window = super::EXPORT_REQUEST_COOLDOWN_MS;
    assert_eq!(
        window, 60_000,
        "m22s4 [X8/window]: the cooldown window is {window} ms; this suite was sized against \
         60000. Retuning it is free, but the boundary cases below must be re-derived in the same \
         diff."
    );

    assert!(
        super::export_cooldown_elapsed(None, 0),
        "m22s4 [X8/none]: NO prior export means the request is ALLOWED. This polarity is the \
         opposite of the deletion-grace rule's, and copying that function inverts the gate."
    );
    assert!(
        super::export_cooldown_elapsed(None, i64::MIN),
        "m22s4 [X8/none]: the no-prior-export answer cannot depend on the clock at all."
    );

    assert!(
        super::export_cooldown_elapsed(Some(0), window),
        "m22s4 [X8/boundary]: at EXACTLY the window the request is allowed (inclusive boundary)."
    );
    assert!(
        !super::export_cooldown_elapsed(Some(0), window - 1),
        "m22s4 [X8/boundary]: one millisecond below the window the request is REJECTED. This pair \
         is what pins the comparison operator."
    );
    assert!(
        super::export_cooldown_elapsed(Some(0), window + 1),
        "m22s4 [X8/boundary]: past the window the request is allowed."
    );
    assert!(
        !super::export_cooldown_elapsed(Some(0), 0),
        "m22s4 [X8/same-tick]: two requests on the same tick — the flood case this rule exists \
         for — must reject."
    );

    assert!(
        !super::export_cooldown_elapsed(Some(1_000_000), 500_000),
        "m22s4 [X8/skew]: a FUTURE-dated prior export (clock skew) yields negative elapsed time \
         and must read as NOT elapsed. The safe direction is over-rejection."
    );

    assert!(
        !super::export_cooldown_elapsed(Some(i64::MAX), i64::MIN),
        "m22s4 [X8/saturate]: the extreme skew case must SATURATE, not wrap. Overflow checks are \
         on in the release profile, so a wrapping subtraction panics and aborts the reducer's \
         whole transaction."
    );
    assert!(
        super::export_cooldown_elapsed(Some(i64::MIN), i64::MAX),
        "m22s4 [X8/saturate]: the opposite extreme must also saturate rather than wrap, and it \
         is unambiguously past the window."
    );
}

/// X8 (the polarity trap): the cooldown's no-prior-state answer is the OPPOSITE
/// of the deletion-grace rule's, and both are called here so the pair cannot
/// drift.
///
/// The two functions look alike enough to copy: both take an optional prior
/// timestamp plus a clock and compare an elapsed span to a window. Their
/// absent-state arms are inverted, because absent means opposite things — no
/// prior export (so ALLOW) versus no pending deletion request (so NOT DUE).
/// A copy-paste silently inverts one of them.
///
/// Kills: a cooldown whose absent arm rejects (which would make the FIRST
///        export of every subject's life impossible — the criterion this
///        whole slice exists to satisfy);
///        a deletion rule whose absent arm reads as due (which would cascade
///        over every cancelled and every ordinary account).
#[test]
fn m22s4_cooldown_polarity_differs_from_is_deletion_due() {
    let now = 1_700_000_000_000i64;

    let cooldown_none = super::export_cooldown_elapsed(None, now);
    let deletion_none = game_core::is_deletion_due(None, now);

    assert!(
        cooldown_none,
        "m22s4 [X8/polarity]: with NO prior export the cooldown must ALLOW. Absent means `this \
         subject has never exported`, so rejecting here makes the first export impossible."
    );
    assert!(
        !deletion_none,
        "m22s4 [X8/polarity]: with NO deletion request pending the grace rule must answer NOT \
         due. Absent means `cancelled or never requested`, so answering due would cascade over \
         every ordinary account. Asserted here as the fixed point the inversion is measured \
         against — if this ever flips, the comparison below stops meaning anything."
    );
    assert_ne!(
        cooldown_none, deletion_none,
        "m22s4 [X8/polarity]: the two absent-state answers are EQUAL, which means one of the two \
         rules was copied from the other without inverting its absent arm. They take the same \
         argument shapes and compare an elapsed span to a window, so the copy compiles, passes \
         clippy, and silently disables one of the two gates."
    );
}

// ===========================================================================
// E1 / E2 — THE PURE SEAM. This is the whole behavioural half of the slice.
//
// `plan_export_reap(rows, now_ms, ttl_ms, batch)` collects the ids whose age is
// AT LEAST ttl_ms under saturating arithmetic, sorts them ascending and
// truncates to batch. It sorts INTERNALLY: the shell has
// no sort statement, so removing a shell sort cannot silently starve old chunks
// past their expiry, and the batch cap's oldest-first fairness property is a
// property of the seam rather than of an unpinned caller.
// ===========================================================================

/// E1: a chunk older than the TTL is selected for deletion.
///
/// The TTL used here is the SHIPPED constant, so the criterion is tied to the
/// value the module actually runs with rather than to a number this test made
/// up. The magnitude of that constant is pinned separately
/// (`rb48_ttl_is_exactly_seven_days_in_milliseconds`), which keeps mutant
/// attribution clean: a wrong TTL reds there, not here.
#[test]
fn rb48_plan_export_reap_fires_when_due() {
    let ttl = crate::privacy::EXPORT_BUNDLE_TTL_MS;
    let now: i64 = 1_700_000_000_000;
    let rows = [(7u64, now - ttl - 1)];

    let out = crate::privacy::plan_export_reap(&rows, now, ttl, 256);
    assert_eq!(
        out,
        [7u64],
        "rb48 [E1/fires]: a chunk one millisecond past the shipped TTL must be selected for \
         deletion. PRV1-14 is the ONLY expiry an orphaned bundle has — the deletion cascade keys \
         on a live account's own identity and structurally cannot reach a bundle whose owner has \
         been retired — so a reaper that selects nothing here leaves a second, denormalized copy \
         of one player's personal data in every backup, forever."
    );
}

/// E2: nothing expired means nothing deleted.
///
/// Kills a seam that returns every input id (the age test dropped entirely),
/// which is the single worst failure available here: a tick would delete every
/// live export bundle in the database, including one written seconds earlier.
#[test]
fn rb48_plan_export_reap_noop_when_nothing_due() {
    let ttl: i64 = 1_000;
    let now: i64 = 10_000;
    let rows = [
        (1u64, now),
        (2u64, now - 1),
        (3u64, now - (ttl - 1)),
        (4u64, now + 5_000),
    ];

    let out = crate::privacy::plan_export_reap(&rows, now, ttl, 256);
    assert!(
        out.is_empty(),
        "rb48 [E2/noop]: with no chunk older than the TTL the plan must be EMPTY; got {out:?}. A \
         seam that returns its whole input deletes every live bundle on the next tick, including \
         one written seconds ago, and every structural clause about the reducer stays green while \
         it happens. The fourth row carries a FUTURE stamp on purpose: a clock that stepped \
         backwards must read as fresh, never as maximally expired."
    );

    assert!(
        crate::privacy::plan_export_reap(&[], 0, 1, 8).is_empty(),
        "rb48 [E2/noop-empty]: an EMPTY sweep must plan NOTHING. This is the reaper's steady \
         state, not an edge case — it ticks hourly forever, and most databases hold no export \
         bundle at all most of the time — so a seam that fabricates an id from an empty input \
         would delete a row the sweep never saw, on every tick, in the quietest database. Every \
         other case in this block feeds a non-empty slice, so nothing else here would notice."
    );
}

/// E1 / E2 (the boundary, both directions in one test): age EXACTLY the TTL is
/// deleted; one millisecond short is kept.
///
/// Kills the strict-greater boundary, which is the mutant an implementer lands
/// by reflex and which no other test in this file can see: every other row is
/// either far past or far short of the window.
#[test]
fn rb48_plan_export_reap_boundary_exact_ttl() {
    let ttl: i64 = 1_000;
    let now: i64 = 10_000;

    let at_boundary = [(11u64, now - ttl)];
    assert_eq!(
        crate::privacy::plan_export_reap(&at_boundary, now, ttl, 256),
        [11u64],
        "rb48 [E1/boundary-inclusive]: a chunk aged EXACTLY the TTL must be deleted. The boundary \
         is inclusive, matching every other elapsed-time rule in this module (the export cooldown \
         included); a strictly-greater test leaves a chunk sitting on the boundary undeleted on \
         every tick that lands on the same millisecond."
    );

    let under_boundary = [(12u64, now - ttl + 1)];
    assert!(
        crate::privacy::plan_export_reap(&under_boundary, now, ttl, 256).is_empty(),
        "rb48 [E2/boundary-exclusive]: a chunk one millisecond SHORT of the TTL must be kept. \
         Without this direction the boundary clause above is satisfied by a seam that deletes \
         everything."
    );
}

/// E1 / E2 (arithmetic safety): the age comparison SATURATES at both extremes.
///
/// The release profile has overflow checks ON (privacy.rs states this for the
/// cooldown predicate), so a wrapping subtraction PANICS inside a reducer and
/// aborts its whole transaction in production — an unattended scheduled reducer
/// that panics every tick, forever, deleting nothing and emitting nothing (this
/// module is barred from logging by its own header contract).
#[test]
fn rb48_plan_export_reap_extreme_clocks() {
    let ttl: i64 = 1_000;

    assert_eq!(
        crate::privacy::plan_export_reap(&[(1u64, i64::MIN)], i64::MAX, ttl, 256),
        [1u64],
        "rb48 [E1/saturate-high]: the maximum clock against the minimum stamp must SATURATE to a \
         maximal age and select the row. A plain subtraction overflows here and panics."
    );

    assert!(
        crate::privacy::plan_export_reap(&[(2u64, i64::MAX)], i64::MIN, ttl, 256).is_empty(),
        "rb48 [E2/saturate-low]: the minimum clock against the maximum stamp must SATURATE to a \
         minimal age and keep the row. A plain subtraction overflows in the other direction, and \
         a wrapping one reports the freshest possible row as the oldest."
    );

    assert!(
        crate::privacy::plan_export_reap(&[(3u64, 0), (4u64, -1)], 10_000, i64::MAX, 256)
            .is_empty(),
        "rb48 [E2/saturate-ttl]: with a maximal TTL and ordinary stamps nothing can be expired."
    );
}

/// E1 (the per-tick cap, and the oldest-first fairness it depends on): the plan
/// is the `batch` SMALLEST ids, ascending, from UNSORTED input.
///
/// The input is deliberately shuffled. The seam sorts internally, so this is the
/// test that makes the cap fair: without the sort, `truncate` keeps an arbitrary
/// prefix and a given chunk can be skipped past its expiry indefinitely under
/// sustained load while every structural clause stays green.
///
/// Kills: the truncate removed (the whole expired set comes back);
///        the seam's sort removed (the input order comes back);
///        a cap applied before the sort (the wrong ids come back).
#[test]
fn rb48_plan_export_reap_caps_per_tick_oldest_first() {
    let ttl: i64 = 1_000;
    let now: i64 = 10_000;
    let old = now - ttl - 1;
    let rows = [
        (50u64, old),
        (10u64, old),
        (40u64, old),
        (20u64, old),
        (30u64, old),
    ];

    assert_eq!(
        crate::privacy::plan_export_reap(&rows, now, ttl, 3),
        [10u64, 20, 30],
        "rb48 [E1/cap]: with five expired rows and a batch of three the plan must be the three \
         SMALLEST ids, ASCENDING — oldest first, because the primary key is auto-inc and \
         therefore monotone in insertion order. Input order coming back means the seam does not \
         sort; five ids coming back means the cap is gone; any other three means the cap was \
         applied before the sort, which starves the oldest chunk on every tick."
    );

    assert!(
        crate::privacy::plan_export_reap(&rows, now, ttl, 0).is_empty(),
        "rb48 [E1/cap-zero]: a batch of zero must select nothing rather than everything."
    );

    assert_eq!(
        crate::privacy::plan_export_reap(&rows, now, ttl, 5),
        [10u64, 20, 30, 40, 50],
        "rb48 [E1/cap-exact]: a batch equal to the expired population selects all of it."
    );
    assert_eq!(
        crate::privacy::plan_export_reap(&rows, now, ttl, 99),
        [10u64, 20, 30, 40, 50],
        "rb48 [E1/cap-slack]: a batch larger than the expired population is not an error and \
         selects exactly that population — an interval reaper must be able to catch up."
    );
}

/// E1 / E2 (selection is a partition): interleaved fresh and expired rows,
/// shuffled, yield EXACTLY the expired ids, ascending and duplicate-free.
///
/// The ordering and duplicate properties are asserted STRUCTURALLY as well as by
/// value, so the clause still bites if the fixture is ever widened: a duplicate
/// id would be deleted twice, and the second delete of an auto-inc key is a
/// silent no-op that hides a double-count from any future observation.
#[test]
fn rb48_plan_export_reap_mixed_sorted_dedup() {
    let ttl: i64 = 1_000;
    let now: i64 = 10_000;
    let expired = now - ttl;
    let fresh = now - ttl + 1;
    let rows = [
        (9u64, fresh),
        (3u64, expired),
        (7u64, expired),
        (1u64, fresh),
        (5u64, expired),
        (4u64, fresh),
    ];

    let out = crate::privacy::plan_export_reap(&rows, now, ttl, 256);
    assert_eq!(
        out,
        [3u64, 5, 7],
        "rb48 [E1/partition]: only the expired ids may be selected, and they must come back \
         ascending. A fresh id in this list is an unexpired chunk deleted out from under a \
         caller who has not finished downloading it; a missing expired id is PRV1-14 not \
         happening."
    );

    for pair in out.windows(2) {
        assert!(
            pair[0] < pair[1],
            "rb48 [E1/ascending]: the plan is not strictly ascending at {pair:?}. Equal adjacent \
             ids are a DUPLICATE — the second delete of an auto-inc primary key is a silent \
             no-op, so a duplicated plan inflates any count taken from its length while deleting \
             one row."
        );
    }
    for id in &out {
        assert!(
            rows.iter().any(|(row_id, _)| row_id == id),
            "rb48 [E1/subset]: the plan names id {id}, which is not in the input at all. A plan \
             that invents keys deletes rows the sweep never saw."
        );
    }
}

// ===========================================================================
// E1 — THE CONSTANTS. A retention ceiling nobody can read off the source is a
// retention ceiling nobody reviewed.
// ===========================================================================

/// E1: the TTL is seven days, expressed in milliseconds.
///
/// Pinned TWICE, independently: against the decimal magnitude and against the
/// factored day arithmetic. One instrument alone is blind in one direction — the
/// magnitude alone reads as an arbitrary number nobody can check, and the
/// factored form alone is satisfied by any unit at all.
///
/// Kills: a wrong magnitude (a seventy-day TTL keeps a personal-data snapshot
///        ten times longer than the retention statement in the operator runbook,
///        the ADR and the manifest basis all say);
///        a seconds-for-milliseconds unit swap, which makes every chunk expire
///        roughly ten minutes after it is written and silently deletes bundles
///        out from under a client that is still assembling them.
#[test]
fn rb48_ttl_is_exactly_seven_days_in_milliseconds() {
    const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;
    let ttl = crate::privacy::EXPORT_BUNDLE_TTL_MS;

    assert_eq!(
        ttl, 604_800_000_i64,
        "rb48 [E1/ttl-magnitude]: the export TTL must be exactly 604800000 milliseconds. This \
         number is the retention ceiling the manifest basis, ADR-0238 and the operator runbook all \
         state; a bundle is a second, denormalized copy of one player's personal data and lands in \
         every backup taken during its lifetime, so the ceiling is a privacy commitment rather \
         than a tuning knob."
    );
    assert_eq!(
        ttl, SEVEN_DAYS_MS,
        "rb48 [E1/ttl-units]: the export TTL must equal seven days spelled as day arithmetic in \
         MILLISECONDS. Spelled independently of the magnitude clause above precisely so a \
         seconds-for-milliseconds swap cannot satisfy both: the whole module stamps rows with the \
         injected millisecond clock, so a seconds-scaled TTL expires every chunk about ten minutes \
         after it is written."
    );
}

// ===========================================================================
// BEHAVIOURAL ARM.
//
// WHY THEY EXIST AT ALL. Every other rb-65p clause is a SOURCE SCAN, and a
// source scan can only ever say that the right TEXT is in the right place. These
// two say what the line actually CONTAINS. They also carry the ONLY proof of the
// new `json_usize_into` encoder's bare-decimal contract: the ADR-0226 width rule
// (64-bit quoted, 32-bit and below bare) lives in one place, and `usize` had no
// bare-decimal encoder before this slice — `json_u64_into` QUOTES, and
// `json_u32_into(.. as u32)` narrows. The encoder is exercised THROUGH the
// builder rather than directly, because the builder is the only caller that
// matters and a direct test would pin a helper nobody is required to keep.
//
// `request_data_export` itself is not natively executable (`native_host_tests.rs`
// models no INSERT, and the reducer reaches the row-count syscall), so there is
// no behavioural proof of the emission — an honest limit, not a gap.
// ===========================================================================

/// A deterministic fixture identity. This module owns no `use super::*`, so the
/// type is named in full — and the constructor ban that covers privacy.rs is
/// scoped to production source (`rb22p_no_identity_constructor` reads
/// `PRIVACY_RS` only), exactly as the equivalent accounts_tests.rs fixture is.
fn rb65p_ident(b: u8) -> spacetimedb::Identity {
    spacetimedb::Identity::from_byte_array([b; 32])
}

/// X2 (behavioural): `export_fields` renders EXACTLY the sanctioned three-key
/// fragment — the subject QUOTED, both counts BARE.
///
/// The two counts are given DISTINCT fixture values on purpose: `purged` and
/// `written` are both integers, so an honest transposition of the two encoder
/// calls type-checks, is clippy-clean, and satisfies every containment clause in
/// the source-scan arm. Equal fixture values would make this test green on it.
///
/// The identity hex is asserted three ways: the WIDTH (64), the alphabet
/// (lowercase hex), and the exact value for the fixture identity. The third kills
/// a Debug rendering, which is a different string for the same value and would
/// put a type name and a prefix inside a JSON string position.
///
/// Kills: a constant-returning builder (any fixture disagrees);
///        `purged` and `written` transposed;
///        a QUOTED count — which is what `json_u64_into` would produce for the
///        same value (ADR-0226 quotes 64-bit integers because the S8 client
///        loses precision above 2^53), and which no panel or alert can compare
///        numerically;
///        a `purged as u32` narrowing through `json_u32_into`, which renders
///        4_294_967_296 as 0 on the HOST. Scoped honestly: on
///        wasm32 `usize` IS `u32`, so this input is unreachable in the shipped
///        module and the clause pins the ENCODER CONTRACT — the count rendered
///        at the width the purge helper returns, with no cast between them —
///        rather than a production truncation;
///        a builder that OMITS a count when it is zero — the zero case is the
///        FIRST export a subject ever requests, and an absent key reads
///        downstream as `unknown`, not as `none`;
///        an UNQUOTED identity, which is invalid JSON the moment the hex begins
///        with a non-digit;
///        renamed or reordered keys.
#[test]
fn rb65p_export_fields_is_exact() {
    let dq = rb22p_dq();
    let hex = rb65p_ident(7).to_string();

    assert_eq!(
        hex.len(),
        64,
        "rb65p [fields/hex-width]: the fixture identity renders as {} character(s); an Identity \
         is 32 bytes and its Display is fixed-width lowercase hex, so 64 is the only correct \
         width. A different width means the fragment is not rendering Display at all.",
        hex.len()
    );
    assert!(
        hex.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "rb65p [fields/hex-alphabet]: the fixture identity renders as {hex:?}, which is not pure \
         LOWERCASE hex. That alphabet is what makes an identity structurally quote-free and \
         therefore safe to interpolate into a JSON string position without escaping — which is \
         exactly what `json_identity_into` does, with no escape pass at all."
    );
    assert_eq!(
        hex,
        "07".repeat(32),
        "rb65p [fields/hex-value]: the fixture identity is 32 bytes of 0x07, so its hex rendering \
         is `07` thirty-two times, whichever byte order the SDK uses. A different value here \
         means the fragment renders the identity through Debug (a type name plus a prefix) rather \
         than Display."
    );

    let expected = format!("{dq}subject{dq}:{dq}{hex}{dq},{dq}purged{dq}:3,{dq}written{dq}:7");
    assert_eq!(
        super::export_fields(rb65p_ident(7), 3, 7),
        expected,
        "rb65p [fields/exact]: the fragment must be exactly three keys in this order — `subject`, \
         the QUOTED hex of the requesting identity; `purged`, the BARE count of prior chunks this \
         request destroyed; `written`, the BARE count of chunks it wrote. The two counts are 3 \
         and 7 here precisely so a TRANSPOSITION of the two encoder calls — which type-checks, is \
         clippy-clean and satisfies every source-scan clause in this slice — reds by value. The \
         keys are `purged` and `written` rather than rb-40's `chunks`, because that key already \
         means chunks PURGED at the claim site and one key must never name two quantities."
    );

    let both_zero = format!("{dq}subject{dq}:{dq}{hex}{dq},{dq}purged{dq}:0,{dq}written{dq}:0");
    assert_eq!(
        super::export_fields(rb65p_ident(7), 0, 0),
        both_zero,
        "rb65p [fields/zero]: a ZERO count must render as `:0` on BOTH keys, never be omitted and \
         never be suppressed. Zero-purged is the FIRST export a subject ever requests — the one \
         case where `this caller had nothing to purge` and `the purge never ran` are hardest to \
         tell apart, and therefore the exact negative this residual exists to make visible. It is \
         also the first `json_usize_into` boundary: a helper that skips falsy values, or one that \
         renders an empty string, produces a malformed line here and nowhere else."
    );

    let big = super::export_fields(rb65p_ident(7), 4_294_967_296, 1);
    let big_purged = format!("{dq}purged{dq}:4294967296,");
    assert!(
        big.contains(big_purged.as_str()),
        "rb65p [fields/large]: a purge count beyond 32 bits must render as a BARE decimal, \
         unclamped, untruncated and unquoted; got {big:?}. This is the whole reason \
         `json_usize_into` exists: `json_u64_into` would render `{big_purged}` with the number in \
         QUOTES (ADR-0226's width rule — the one failure mode here that IS reachable in the \
         shipped wasm, because it is a rendering decision rather than a width one), and \
         `json_u32_into(purged as u32)` renders this HOST-side input as 0. SCOPE, STATED \
         HONESTLY (ADR-0243 D3): on wasm32 `usize` IS `u32`, so the narrowing half of this tooth \
         is NOT evidence about a production truncation — the input is unreachable there. What it \
         pins is the ENCODER CONTRACT: `purged` is rendered at the width \
         `purge_export_bundles` returns, through the encoder whose whole job is that width, with \
         no cast between them. That is what keeps a future 64-bit host target, or an `as u32` \
         added for tidiness, a conscious change rather than a silent one."
    );

    let f = super::export_fields(rb65p_ident(9), 12, 34);
    assert!(
        f.starts_with(dq),
        "rb65p [fields/leading-quote]: the fragment must START at the opening quote of the first \
         key; got {f:?}. `build_log_line` splices it verbatim after a comma, so any leading byte \
         other than a quote produces malformed JSON in every emitted line — a leading comma in \
         particular gives the envelope `,,`, which no downstream parser recovers from."
    );
    assert!(
        f.ends_with('4'),
        "rb65p [fields/trailing-digit]: the fragment must END on the last digit of the written \
         count; got {f:?}. A trailing comma, brace or quote would either break the envelope or \
         hide a fourth key that the AM6 reserved-key assert never sees in release."
    );
    assert_eq!(
        f.matches(dq).count(),
        8,
        "rb65p [fields/quote-census]: the fragment must carry EXACTLY eight double quotes — three \
         quoted keys (6) plus the one quoted identity value (2) — and none around either count; \
         got {f:?}. TEN or TWELVE means a count was quoted (numerically uncomparable downstream, \
         and the shape `json_u64_into` would produce); SIX means the identity was left bare \
         (invalid JSON as soon as the hex does not parse as a number)."
    );
}

/// X2 (behavioural, composition): the export fragment composes into a
/// well-formed evt-first envelope through the blessed builder, with no dangling
/// comma and exactly four top-level keys.
///
/// Mirrors `rb40_claim_purge_line_composes_into_the_envelope` and
/// `rb65_cascade_line_composes_into_the_envelope` — the same proof for the third
/// pure fragment builder in this family. It is the only test in this file that
/// exercises the REAL composition the reducer performs.
///
/// Kills: a fragment that starts with a comma;
///        a fragment that smuggles a reserved key (the key census counts five
///        instead of four, and last-key-wins would let the smuggled value forge
///        the event type);
///        an envelope whose evt is not first (the relay reconstruction and the
///        Loki label set both key on that position being stable);
///        an empty fragment, which would leave the envelope with one key and the
///        re-export purge unobserved.
#[test]
fn rb65p_export_line_composes_into_the_envelope() {
    let dq = rb22p_dq();
    let evt = "data_export";
    let hex = rb65p_ident(9).to_string();
    let line = crate::observability::build_log_line(
        evt,
        &super::export_fields(rb65p_ident(9), 2, 5),
        crate::observability::Breadcrumb::default(),
    );

    let fragment = format!("{dq}subject{dq}:{dq}{hex}{dq},{dq}purged{dq}:2,{dq}written{dq}:5");
    let expected = format!("{{{dq}evt{dq}:{dq}{evt}{dq},{fragment}}}");
    assert_eq!(
        line, expected,
        "rb65p [line/exact]: the composed line must be the canonical envelope — `evt` first, then \
         the export fragment verbatim, and nothing else. This is the string an operator greps, an \
         alert matches and an erasure audit reads, so it is pinned by value rather than by shape."
    );

    assert!(
        line.starts_with('{') && line.ends_with('}'),
        "rb65p [line/braces]: the composed line must be a single JSON object; got {line:?}."
    );
    assert_eq!(
        line.matches('{').count(),
        1,
        "rb65p [line/one-object]: the line must carry exactly ONE opening brace — no nested \
         object. A `sched` breadcrumb is the only nested shape the builder can emit, and this \
         line takes the default (empty) breadcrumb. Got {line:?}."
    );
    assert!(
        !line.contains(",}"),
        "rb65p [line/no-dangling-comma]: the line ends in a dangling comma ({line:?}), which is \
         invalid JSON. The builder appends a comma before a NON-EMPTY fragment, so this fires \
         when the fragment renders empty — an empty fragment is also a line that observes nothing."
    );
    assert_eq!(
        line.matches(dq).count(),
        12,
        "rb65p [line/quote-census]: the line must carry EXACTLY twelve double quotes — four \
         quoted keys (8) plus two quoted values, the evt and the subject hex (4) — with both \
         counts bare. Got {line:?}."
    );

    let inner = &line[1..line.len() - 1];
    let key_sep = format!("{dq}:");
    assert_eq!(
        inner.matches(key_sep.as_str()).count(),
        4,
        "rb65p [line/four-keys]: the line must carry EXACTLY four top-level keys (`evt`, \
         `subject`, `purged`, `written`); the key-separator census counts {}. A fifth key is \
         either a reserved envelope key smuggled through the fragment (AM6 — last-key-wins would \
         let it forge the event type or a breadcrumb) or an unreviewed field on a privacy-audit \
         record. Got {line:?}",
        inner.matches(key_sep.as_str()).count()
    );
    let evt_prefix = format!("{dq}evt{dq}:");
    assert!(
        inner.starts_with(evt_prefix.as_str()),
        "rb65p [line/evt-first]: `evt` must be the FIRST key of the envelope; got {line:?}. Every \
         downstream consumer (the relay reconstruction, the Loki label set bounded to reducer \
         plus evt) keys on that position being stable."
    );
}

/// marshal.rs, for the injected-clock body pin in T10.
///
/// WHOLE-FILE, and that is sound here rather than merely convenient. The strip
/// pipeline runs strings BEFORE comments, so a raw-string prefix or a bare double
/// quote inside a comment desynchronises it and blanks a span — but marshal.rs
/// carries NEITHER today, the clock is its FIRST item (line 24, above every string
/// literal in the file), and every way a future desync could go is fail-LOUD: a
/// blanked span can only make the declaration census read ZERO, or shorten the
/// extracted body, and both red under a label that names the reason. A desync
/// cannot fabricate the frozen body, which is the only direction that would matter.
const RB85_MARSHAL_RS: &str = include_str!("marshal.rs");

/// How many squashed bytes before a `fn` needle the visibility ban inspects.
///
/// Twenty-four rather than the three a bare `pub` needs: it must also cover
/// `pub(crate)`, `pub(super)` and the longest realistic `pub(in crate::x)`
/// spelling, none of which an enumerated needle list would catch in full.
const RB85_VIS_WINDOW: usize = 24;

/// The squashed `fn` needle for the injected-clock marshal in marshal.rs.
fn rb85_nd_clock_fn() -> String {
    "fnnow_ms(".to_string()
}

/// THE FROZEN INJECTED-CLOCK BODY, squashed (`marshal::now_ms`).
///
/// One expression: the context timestamp in MICROseconds, clamped at zero, divided
/// into milliseconds. Pinned by equality for the reason T10's doc records — a
/// value table cannot see a body that is right on every row it lists and wrong
/// inside the live wall-clock band, and this fn stamps every export chunk the
/// retention rule then measures.
fn rb85_clock_body_pin() -> String {
    "ctx.timestamp.to_micros_since_unix_epoch().max(0)/1000".to_string()
}

/// The injected-clock DECLARATION as source text (positive-control input).
fn rb85_clock_decl_source() -> String {
    "fn now_ms(ctx: &ReducerContext) -> i64 ".to_string()
}

/// The injected-clock BODY as whitespace-bearing source text (control input).
fn rb85_clock_body_source() -> String {
    "\n    ctx.timestamp.to_micros_since_unix_epoch().max(0) / 1000\n".to_string()
}

// --- behavioural oracle helpers ---------------------------------------------

/// Does the SHIPPED expiry seam select a chunk stamped `created` at `now`, for
/// `ttl`? One row in, one answer out.
///
/// Deliberately routed through `crate::privacy::plan_export_reap` rather than
/// re-derived here: the range read is only ever allowed to be an optimisation
/// over the seam, so the seam has to be the oracle. A test that re-spelled the
/// predicate inline would be comparing the slice's arithmetic against a copy of
/// the slice's arithmetic.
fn rb85_seam_says_expired(created: i64, now: i64, ttl: i64) -> bool {
    !crate::privacy::plan_export_reap(
        &[(1u64, created)],
        now,
        ttl,
        crate::privacy::EXPORT_REAP_MAX_READ_PER_TICK,
    )
    .is_empty()
}

/// Seeded extremes for the range-versus-seam property: `(now, created, ttl,
/// seam_expects_expired)`. Every row is outside the reachable strategy domain
/// on purpose — the clock saturation corners are where a range predicate and an
/// age predicate can disagree, and proptest samples 2^53 far too sparsely to
/// land on them.
const RB85_EXTREMES: [(i64, i64, i64, bool); 7] = [
    (i64::MAX, i64::MIN, i64::MAX, true),
    (i64::MIN, i64::MAX, 0, false),
    (0, 0, 0, true),
    (i64::MIN, i64::MIN, 0, true),
    (i64::MAX, i64::MAX, i64::MAX, false),
    (0, i64::MIN, i64::MAX, true),
    (i64::MIN, 0, i64::MAX, false),
];

// ===========================================================================
// T1 / T2 / T8 — THE BEHAVIOURAL AND ARITHMETIC HALF. The cutoff is the only
// new LOGIC this slice ships, so it is the only thing here with a
// return-value oracle, and it has three instruments: a value table, a property
// against the shipped seam, and a body equality pin.
// ===========================================================================

/// T1: `export_reap_cutoff_ms` is exactly the SATURATING subtraction of the ttl
/// from the clock, checked by value.
///
/// The wall-clock row is the red-team's addition: every other row
/// is an extreme or a toy, and a cutoff keyed on a realistic live band would
/// pass a table made only of extremes while returning `now` in production.
///
/// Kills: M4 `saturating_add` for `saturating_sub` — row `(0, TTL)`
/// separates them by sign; M5 a plain `-`, which PANICS on row
/// `(i64::MIN, TTL)` because overflow checks are on in the dev and release
/// profiles alike, and a panic inside a scheduled reducer aborts its whole
/// transaction silently every tick forever; M6 the two arguments TRANSPOSED
/// (both are i64, so it type-checks and is the shape a non-hostile implementer
/// lands by accident) — rows `(1000, 7)` and `(7, 1000)` are a transposed pair
/// with opposite signs; a constant body, and a body that ignores `ttl_ms`
/// entirely — rows `(5, 0)` and `(5, 3)` differ only in the ttl.
///
/// HONEST LIMIT: a value table cannot see a body that is correct on every row
/// it lists and wrong elsewhere. The measured instance of exactly that is the
/// band-keyed cutoff, and it is closed by the body equality pin in
/// `rb85_cutoff_body_exact`, not here.
#[test]
fn rb85_export_reap_cutoff_is_saturating_ttl_subtraction() {
    let ttl = crate::privacy::EXPORT_BUNDLE_TTL_MS;
    assert_eq!(
        ttl, 604_800_000_i64,
        "[rb85/cutoff-value]: this table was sized against the shipped seven-day TTL in \
         milliseconds; the module now ships {ttl}. Re-derive the wall-clock row before editing \
         anything else."
    );

    let cases: [(i64, i64, i64); 12] = [
        (0, 0, 0),
        (0, ttl, -ttl),
        (ttl, ttl, 0),
        (1_760_000_000_000, ttl, 1_759_395_200_000),
        (5, 3, 2),
        (5, 0, 5),
        (1_000, 7, 993),
        (7, 1_000, -993),
        (i64::MIN, ttl, i64::MIN),
        (i64::MIN, i64::MAX, i64::MIN),
        (i64::MAX, 0, i64::MAX),
        (0, i64::MIN, i64::MAX),
    ];

    for (now, ttl_ms, want) in cases {
        let got = crate::privacy::export_reap_cutoff_ms(now, ttl_ms);
        assert_eq!(
            got, want,
            "[rb85/cutoff-value]: the cutoff for now={now} ttl={ttl_ms} must be {want}; got \
             {got}. The cutoff is the NEWEST creation stamp a chunk may carry and still be \
             expired, and it is the bound the btree range is taken over — so a cutoff that is too \
             HIGH re-opens the full scan this slice exists to close, and one that is too LOW \
             silently stops expiring personal data that the retention ceiling says must go."
        );
    }

    assert_eq!(
        crate::privacy::export_reap_cutoff_ms(i64::MAX, -1),
        i64::MAX,
        "[rb85/cutoff-value]: a NEGATIVE ttl at the top of the clock range must SATURATE upward \
         rather than wrap. Saturation in both directions is what keeps an extreme or hostile \
         clock from aborting the tick; the release profile has overflow checks on."
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// T2: the btree range `..=cutoff` selects EXACTLY the seam's expired set on
    /// the reachable domain, and is a SUPERSET of it everywhere else.
    ///
    /// This is the load-bearing property of the whole slice. The range is an
    /// OPTIMISATION over `plan_export_reap`, never a second retention policy:
    /// if the range can ever exclude a row the seam would expire, the reaper
    /// silently stops deleting it and the seven-day ceiling becomes a statement
    /// about intent. Both fns come from `crate::privacy` — the cutoff and the
    /// seam alike — so nothing here is compared against a re-spelling of the
    /// slice's own arithmetic.
    ///
    /// Domain, and why it is the reachable one: `created_at_ms` is server
    /// stamped by `now_ms()`, which clamps at zero — a premise that is now
    /// PINNED, by `rb85_marshal_now_ms_is_millis_clamped_at_zero`, rather than
    /// merely documented — and the write census in
    /// `rb22p_writes_only_export_bundle` pins the only writer, so no row can
    /// carry a negative stamp, and 2^53 is past any clock this code will see.
    /// On that domain the two predicates are EQUIVALENT and the assertion is
    /// two-sided. Over arbitrary i64 ttl the claim weakens to the superset
    /// direction, which is the one the reaper's correctness actually needs.
    ///
    /// The `ttl` strategy is BIASED rather than uniform, deliberately: sampled
    /// uniformly over all of i64 the superset branch below is reached by values
    /// so enormous that the seam can never report expired, so the branch runs
    /// vacuously. The union puts the two values that actually ship (zero and the
    /// retention constant) and the reachable clock range beside the full i64
    /// range, so every case exercises a live branch.
    ///
    /// Kills: any under-reading cutoff, including M2 `..cutoff`
    /// and the ttl-scaled and ttl-transposed families, by the boundary clause;
    /// a cutoff that disagrees with the seam at saturation, by the extremes;
    /// M-RT1's band-keyed cutoff on the sampled cases that land inside the
    /// live band — a REPORTED but not RELIED-ON kill, since the band is a
    /// vanishing fraction of the domain, which is exactly why
    /// `rb85_cutoff_body_exact` owns that mutant.
    ///
    /// HONEST LIMITS: this proves an arithmetic relationship between two pure
    /// fns. It does NOT prove the helper passes the cutoff to the range (T6),
    /// that the range is inclusive in the SOURCE (T6), or that a row the range
    /// yields is actually deleted — the execution proof over a real datastore
    /// is the rb109_ block at the end of this file.
    #[test]
    fn rb85_cutoff_range_matches_the_seam_expired_set(
        now in 0i64..=(1i64 << 53),
        created in 0i64..=(1i64 << 53),
        ttl in prop_oneof![
            Just(0i64),
            Just(crate::privacy::EXPORT_BUNDLE_TTL_MS),
            0i64..=(1i64 << 53),
            0i64..=i64::MAX
        ],
    ) {
        let shipped = crate::privacy::EXPORT_BUNDLE_TTL_MS;
        let cutoff = crate::privacy::export_reap_cutoff_ms(now, shipped);

        let in_range = created <= cutoff;
        let expired = rb85_seam_says_expired(created, now, shipped);
        prop_assert_eq!(
            in_range,
            expired,
            "[rb85/range-matches-seam]: on the reachable domain the btree range and the seam must \
             select the SAME set. A range that is narrower drops rows the retention ceiling says \
             must go, and one that is wider is a full scan wearing a range"
        );

        let any_cutoff = crate::privacy::export_reap_cutoff_ms(now, ttl);
        if rb85_seam_says_expired(created, now, ttl) {
            prop_assert!(
                created <= any_cutoff,
                "[rb85/range-superset]: for ANY ttl the range must be a SUPERSET of the seam \
                 expired set. The seam stays the SSOT predicate over the pre-filtered rows, so \
                 the only thing the range may never do is hide a row from it"
            );
        }

        prop_assert!(
            rb85_seam_says_expired(cutoff, now, shipped),
            "[rb85/range-boundary]: a chunk stamped EXACTLY at the cutoff must be seam-expired. \
             The range terminator is inclusive, so the boundary row is read; if the seam then \
             spared it, the two predicates would disagree on the one row a tick always sees"
        );
        prop_assert!(
            !rb85_seam_says_expired(cutoff.saturating_add(1), now, shipped),
            "[rb85/range-boundary]: one millisecond ABOVE the cutoff must NOT be seam-expired. \
             Without this direction the boundary clause above is satisfied by a seam that expires \
             everything"
        );

        for (x_now, x_created, x_ttl, x_expired) in RB85_EXTREMES {
            let x_cutoff = crate::privacy::export_reap_cutoff_ms(x_now, x_ttl);
            prop_assert_eq!(
                rb85_seam_says_expired(x_created, x_now, x_ttl),
                x_expired,
                "[rb85/range-extremes]: the seam verdict at a saturation corner is pinned, so a \
                 seam that expires everything (or nothing) cannot make the superset clause below \
                 vacuous"
            );
            if x_expired {
                prop_assert!(
                    x_created <= x_cutoff,
                    "[rb85/range-extremes]: at a saturation corner the range still has to \
                     CONTAIN the seam expired row. A clock that stepped to an extreme must not \
                     hide an expired chunk from the reaper"
                );
            }
        }
    }
}

// ===========================================================================
// T10 — THE INJECTED CLOCK ITSELF. Every stamp this slice compares is produced
// by one four-token fn that had no test at all.
// ===========================================================================

/// T10: `marshal::now_ms` converts the injected MICROSECOND timestamp to
/// MILLISECONDS and clamps at zero, by value — and its BODY is frozen, because a
/// value table alone cannot say so.
///
/// WHY THIS IS rb-85's BUSINESS. Every other pin in this slice is RELATIVE: the
/// cutoff is `now - ttl`, the seam compares `now - created` against the ttl, and
/// `created_at_ms` is stamped by this very fn. Change the unit and all of them
/// stay green while the seven-day retention ceiling becomes seven thousand days
/// — or ten minutes, which deletes bundles out from under a client that is still
/// assembling them. The red-team measured both mutants passing the whole suite.
/// It also closes T2's one documented premise: the property's reachable domain
/// starts at zero because this clamp says stamps cannot be negative.
///
/// The context is a `__dummy()` one (the native_host_tests.rs idiom, crate
/// 2.8.1 `src/lib.rs:1043`) with its PUB `timestamp` field assigned per row.
/// This test reads no table, so it reaches no host syscall and cannot link-fail
/// the way a table read in a native test would.
///
/// THE BODY PIN IS ROUND 3, AND IT IS THE CRITICAL HALF (RT-A1). The value table
/// below is nine rows: zero, three sub-second toys, one wall-clock sample, three
/// negatives and the i64 ceiling. A `now_ms` that returns SECONDS — or anything at
/// all — whenever the clock sits inside the LIVE wall-clock band is correct on
/// every one of those rows except the single sampled one, and moving that one row
/// by a thousandth is enough to dodge it. Nothing else in this crate would notice:
/// every other clock instrument in this slice is RELATIVE, so a uniformly scaled
/// stamp keeps every difference proportional, and a band-keyed one simply is not
/// sampled. The test therefore takes the same instrument the two seams take —
/// EQUALITY over the squashed body, through the same live pipeline, with the same
/// independently-spelled positive control proving the pin satisfiable.
///
/// Kills: M19, the divisor scaled (`/1_000_000`) — the wall-clock row separates
/// them by three orders of magnitude; M20, the zero clamp dropped — caught by
/// the two LARGE negative rows, and NOT by `-1`, because integer division
/// truncates toward zero and `-1 / 1000` is already `0`; that row is carried
/// precisely to record why it is not a tooth. Also: a pass-through returning
/// microseconds; a constant; a clock read from anywhere but the context; and
/// RT-A1, the band-keyed unit swap, which ONLY the body equality sees.
///
/// HONEST LIMITS: this pins the CONVERSION and the source text, not the clock.
/// Nothing runnable in this crate can prove the host fills `ctx.timestamp` with
/// the transaction instant, and the body pin is blind to a `to_micros...` or a
/// `max` re-pointed by an import alias or a shadowing trait in marshal.rs — the
/// value table above is what covers that direction, which is why both halves ship.
#[test]
fn rb85_marshal_now_ms_is_millis_clamped_at_zero() {
    let cases: [(i64, i64); 9] = [
        (0, 0),
        (999, 0),
        (1_000, 1),
        (1_999, 1),
        (1_760_000_000_123_456, 1_760_000_000_123),
        (-1, 0),
        (-5_000_000, 0),
        (i64::MIN, 0),
        (i64::MAX, i64::MAX / 1_000),
    ];

    let mut ctx = spacetimedb::ReducerContext::__dummy();
    for (micros, want) in cases {
        ctx.timestamp = spacetimedb::Timestamp::from_micros_since_unix_epoch(micros);
        let got = crate::marshal::now_ms(&ctx);
        assert_eq!(
            got, want,
            "[rb85/clock-units]: the injected clock at {micros} microseconds must marshal to \
             {want} milliseconds; got {got}. This fn stamps every export chunk and feeds every \
             cutoff in this module, so a scaled divisor silently re-points the whole retention \
             rule at a different unit while every relative comparison in the slice stays green, \
             and a dropped clamp lets a pre-epoch clock produce a NEGATIVE stamp — which is the \
             one thing the range property's reachable domain assumes cannot happen."
        );
    }

    // --- RT-A1: the body itself, by equality ---------------------------------
    let clock_needle = rb85_nd_clock_fn();
    let control_source = format!(
        "{}{}{}{}",
        rb85_clock_decl_source(),
        '{',
        rb85_clock_body_source(),
        '}'
    );
    let control = stripped_for_scan(&control_source);
    let control_body = extract_squashed_fn_body(&control, &clock_needle)
        .expect("[rb85/clock-control]: the control fixture has no body");
    assert_eq!(
        control_body,
        rb85_clock_body_pin(),
        "[rb85/clock-control]: the frozen CLOCK body pin is UNSATISFIABLE — the live pipeline \
         derives something else from the sanctioned body text, which is spelled independently of \
         the pin for exactly this reason. An unsatisfiable equality pin reads like a missing \
         implementation and sends the next reader to reverse-engineer the test instead of the \
         spec. Revise the literal FROM THE SPEC, never to match whatever the code happens to say."
    );

    let squashed = stripped_for_scan(RB85_MARSHAL_RS);
    assert!(
        squashed.len() > 400,
        "[rb85/clock-scope]: marshal.rs strips to only {} squashed byte(s) — the scan is reading \
         the wrong file, or the strip pipeline desynchronised on it, and every clause below would \
         then pass over nothing.",
        squashed.len()
    );
    let clock_decls = rb22p_count(&squashed, &clock_needle);
    assert_eq!(
        clock_decls, 1,
        "[rb85/clock-scope]: marshal.rs must define `{clock_needle}` exactly once; found \
         {clock_decls}. ZERO means the one fn that stamps every export chunk was renamed, so the \
         equality clause below would describe nothing; TWO makes the value table above and that \
         clause read whichever definition comes first in the file."
    );
    let clock_body = extract_squashed_fn_body(&squashed, &clock_needle).unwrap_or_else(|| {
        panic!(
            "[rb85/clock-scope]: `{clock_needle}` was found but its body is not brace-balanced, so \
             the equality clause below would run over an arbitrary span and pass VACUOUSLY."
        )
    });
    assert_eq!(
        clock_body,
        rb85_clock_body_pin(),
        "[rb85/clock-body-exact]: the injected clock's body must be EXACTLY the context timestamp \
         in microseconds, clamped at zero, divided into milliseconds — one expression, no branch, \
         no binding, no second statement. MEASURED (round-3 RT-A1): a body that returns SECONDS, \
         or anything else, ONLY while the clock sits inside the live wall-clock band passes the \
         value table above (its rows are toys, negatives and the i64 ceiling, and the single \
         wall-clock row is one point a mutant can step around), passes every relative comparison \
         in this slice, and re-scales the seven-day retention ceiling in production only. This pin \
         is what closes that family. Read: {clock_body:?}"
    );
}

// --- the behavioural seam under test, reached exactly ONCE from this file ----

/// THE ONE call site of the bundle-selection seam in this file.
///
/// Every behavioural test below goes through this wrapper, so
/// `[rb86/seam-scope]` can pin the count of live references from this module to
/// the literal ONE. That is not book-keeping: the seam is PRIVATE, this module
/// is its only test-side reader, and a second spelling somewhere in the file
/// would make the scope clause a statement about nothing.
fn rb86_plan(rows: &[(u64, i64)], now_ms: i64, ttl_ms: i64, max_stamps: usize) -> Vec<i64> {
    crate::privacy::plan_export_reap_stamps(rows, now_ms, ttl_ms, max_stamps)
}

// --- the test-local model of ONE tick ----------------------------------------

/// Build a simulated `export_bundle` population from `(stamp, owner, chunks)`
/// triples, ids assigned in spec order exactly as an auto-inc column would.
fn rb86_bundle_rows(spec: &[(i64, u8, usize)]) -> Vec<(u64, i64, u8)> {
    let mut out: Vec<(u64, i64, u8)> = Vec::new();
    let mut id = 1u64;
    for (stamp, owner, chunks) in spec {
        for _ in 0..*chunks {
            out.push((id, *stamp, *owner));
            id += 1;
        }
    }
    out
}

/// What ONE tick READS: the rows at or below the SHIPPED cutoff, in ascending
/// key order, capped at the read bound.
///
/// The cutoff comes from `crate::privacy::export_reap_cutoff_ms`, never from a
/// predicate re-spelled here: a model that re-derived the retention rule would
/// be comparing the slice's arithmetic against a copy of the slice's arithmetic.
fn rb86_window(table: &[(u64, i64, u8)], now: i64, ttl: i64, cap: usize) -> Vec<(u64, i64)> {
    let cutoff = crate::privacy::export_reap_cutoff_ms(now, ttl);
    let mut rows: Vec<(u64, i64)> = table
        .iter()
        .filter(|(_, stamp, _)| *stamp <= cutoff)
        .map(|(id, stamp, _)| (*id, *stamp))
        .collect();
    rows.sort_by_key(|(id, stamp)| (*stamp, *id));
    rows.truncate(cap);
    rows
}

/// ONE tick: read the window, plan the stamps, delete EVERY table row carrying a
/// planned stamp — window rows and the tail beyond the window alike. Returns the
/// surviving table.
///
/// `reverse_window` hands the seam the same rows in the opposite order. The
/// btree's ascending yield is an expectation rather than an SDK contract (rb-85
/// says so; rb-109 executes it against a MODEL of that order), so the design is
/// only honest if the plan does not depend on it.
fn rb86_tick(
    table: &[(u64, i64, u8)],
    now: i64,
    ttl: i64,
    cap: usize,
    max_stamps: usize,
    reverse_window: bool,
) -> Vec<(u64, i64, u8)> {
    let mut window = rb86_window(table, now, ttl, cap);
    if reverse_window {
        window.reverse();
    }
    let stamps = rb86_plan(&window, now, ttl, max_stamps);
    table
        .iter()
        .filter(|(_, stamp, _)| !stamps.contains(stamp))
        .copied()
        .collect()
}

/// The SUPERSEDED rule, kept as a non-vacuity control: delete exactly the chunk
/// ids `plan_export_reap` returns for the window, which is what the module did
/// between rb-48 and rb-85 inclusive.
///
/// Without this, `[rb86/atomic]` is satisfiable by any fixture whose bundles
/// never straddle the read cap — the assertion would hold and prove nothing.
fn rb86_split_tick(
    table: &[(u64, i64, u8)],
    now: i64,
    ttl: i64,
    cap: usize,
) -> Vec<(u64, i64, u8)> {
    let window = rb86_window(table, now, ttl, cap);
    let ids = crate::privacy::plan_export_reap(&window, now, ttl, cap);
    table
        .iter()
        .filter(|(id, _, _)| !ids.contains(id))
        .copied()
        .collect()
}

/// The population grouped into BUNDLES — one entry per `(stamp, owner)` pair
/// with its chunk count, sorted so two runs are comparable.
fn rb86_groups(table: &[(u64, i64, u8)]) -> Vec<((i64, u8), usize)> {
    let mut out: Vec<((i64, u8), usize)> = Vec::new();
    for (_, stamp, owner) in table {
        let key = (*stamp, *owner);
        // `position` rather than `iter_mut().find(..)`: the latter holds a
        // mutable borrow of `out` across the `None` arm's `push`, which the
        // borrow checker rejects.
        match out.iter().position(|(k, _)| *k == key) {
            Some(at) => out[at].1 += 1,
            None => out.push((key, 1)),
        }
    }
    out.sort_unstable();
    out
}

// ===========================================================================
// T1 / T2 — THE SEAM'S RETURN VALUE. The oracle is what the fn RETURNS, never
// source text: T6 and T7 own the source and say so.
// ===========================================================================

/// T1: the bundle-selection seam, by value.
///
/// Row order is deliberate — first-failure-wins, so the rows a registered mutant
/// is designated to die on come first and are not shadowed by a neighbour that
/// happens to red earlier for the same reason.
///
/// Kills, each named with the row it ACTUALLY first-fails on (first failure
/// wins, so a designation a neighbouring row shadows is worth nothing):
/// * M2 the `planned.contains` guard dropped, and M5 the same guard INVERTED →
///   `[rb86/only-expired]`.
/// * M17 a seam that returns only the first stamp → `[rb86/only-expired]` as
///   well: that row expects two stamps, so it fires a row earlier than the
///   three-bundle row does.
/// * M3 `truncate(max_stamps)` dropped → `[rb86/stamps-cap]`.
/// * M4 the seam handing `max_stamps` to `plan_export_reap` instead of
///   `rows.len()` → `[rb86/plan-over-whole-window]`, whose ids are GROUPED per
///   stamp on purpose: an interleaved fixture lets that mutant survive.
/// * M6 `sort_unstable` dropped → `[rb86/oldest-stamp-first]`, and ONLY there in
///   this test: the three rows above it all happen to present their planned
///   stamps in ascending window order. It is also why T2's distinctness clause
///   cannot be relied on for M6 — `dedup` collapses ADJACENT equals only, so an
///   unsorted plan reds T2 on ordering rather than on repetition.
/// * M1 the dedup dropped → `[rb86/plan-over-whole-window]` here (the plan grows
///   to `[s1, s1, s2]` under a budget of three). Its DESIGNATED kill is T2
///   `[rb86/stamps-distinct]`, which names the property directly;
///   `[rb86/same-ms-tie]` below is the same tooth in its smallest form.
///
/// HONEST LIMIT / PRECONDITION: the seam is total, but the post-condition `every
/// returned stamp is expired` holds only for a window whose ids are DISTINCT,
/// which the real one is by construction (`chunk_id` is the primary key). A
/// malformed window repeating one id across two rows would carry the unexpired
/// row's stamp along with the expired one. That is not a shape any caller can
/// produce, and it is stated rather than pinned.
#[test]
fn rb86_reap_bundle_plan_value_table() {
    let now: i64 = 1_000_000;
    let ttl: i64 = 1_000;
    // The cutoff for these rows is 999_000: a stamp at or below it is expired.
    let s1: i64 = 100_000;
    let s2: i64 = 200_000;
    let s3: i64 = 300_000;
    let fresh: i64 = 999_500;
    let future: i64 = 2_000_000;

    // Seventeen bundles for a cap of sixteen: the table needs one more bundle
    // than the cap before it can say anything about the cap at all.
    let mut seventeen: Vec<(u64, i64)> = Vec::new();
    let mut want_sixteen: Vec<i64> = Vec::new();
    let mut id = 1u64;
    let mut stamp = 10_000i64;
    while id <= 17 {
        seventeen.push((id, stamp));
        if id <= 16 {
            want_sixteen.push(stamp);
        }
        id += 1;
        stamp += 10_000;
    }

    // A nested fn rather than a closure: every row hands it an array literal or a
    // slice, and a plain fn is where argument coercion is least surprising. Its
    // name carries no `rb86_` prefix, so no roster census counts it.
    fn check(
        label: &str,
        why: &str,
        rows: &[(u64, i64)],
        now: i64,
        ttl: i64,
        max_stamps: usize,
        want: &[i64],
    ) {
        let got = rb86_plan(rows, now, ttl, max_stamps);
        assert_eq!(
            got.as_slice(),
            want,
            "{label}: {why} With now={now} ttl={ttl} max_stamps={max_stamps} the seam must return \
             {want:?}; it returned {got:?}. The window was {rows:?}."
        );
    }

    check(
        "[rb86/only-expired]",
        "A window row whose stamp is NOT expired contributes NO stamp: the seam derives expiry \
         solely from `plan_export_reap`, which is the module's SSOT retention predicate, and adds \
         no second rule of its own. Deleting a fresh stamp erases an export its owner may still \
         be assembling.",
        &[(1, s1), (2, fresh), (3, s2), (4, future)],
        now,
        ttl,
        8,
        &[s1, s2],
    );
    check(
        "[rb86/stamps-cap]",
        "Seventeen expired bundles with a cap of sixteen must yield the SIXTEEN OLDEST stamps and \
         no more. The cap is the tick's WRITE bound and the whole reason the new constant exists: \
         without it a tick deletes every stamp the window touched, and each of those takes its \
         tail beyond the window with it.",
        seventeen.as_slice(),
        now,
        ttl,
        16,
        want_sixteen.as_slice(),
    );
    check(
        "[rb86/plan-over-whole-window]",
        "Three bundles of two chunks each, ids GROUPED per stamp, with room for three stamps: the \
         expiry pass must run over the WHOLE window. A seam that handed its own `max_stamps` to \
         `plan_export_reap` would plan three IDS — the first bundle and half the second — and \
         return only two stamps, silently splitting the third bundle at the plan rather than at \
         the delete.",
        &[(1, s1), (2, s1), (3, s2), (4, s2), (5, s3), (6, s3)],
        now,
        ttl,
        3,
        &[s1, s2, s3],
    );
    check(
        "[rb86/oldest-stamp-first]",
        "The window arrives in an order the btree happens to yield; the plan must be OLDEST FIRST \
         whatever that order was. With room for one stamp only, an unsorted seam keeps whichever \
         stamp the window listed first, so under sustained load the oldest bundle can be skipped \
         past its expiry indefinitely.",
        &[(1, s3), (2, s1), (3, s2)],
        now,
        ttl,
        1,
        &[s1],
    );
    check(
        "[rb86/same-ms-tie]",
        "Two chunks committed in the same millisecond are ONE delete unit and must be named ONCE. \
         A repeated stamp spends the tick's write budget twice on one index point, so the cap \
         silently reaps fewer bundles than it is allowed to.",
        &[(1, s3), (2, s3)],
        now,
        ttl,
        8,
        &[s3],
    );
    check(
        "[rb86/plan-empty]",
        "Empty in, empty out. The seam is total and never panics on a window the range read \
         happened to return nothing for.",
        &[],
        now,
        ttl,
        8,
        &[],
    );
    check(
        "[rb86/nothing-expired]",
        "Nothing expired means nothing planned — including a stamp exactly AT the clock and one \
         in the FUTURE, which a subtraction that wrapped instead of saturating would report as \
         enormously old (the rb-48 [E2/noop] lesson).",
        &[(1, fresh), (2, now), (3, future)],
        now,
        ttl,
        8,
        &[],
    );
    check(
        "[rb86/max-stamps-zero]",
        "A write budget of zero reaps nothing at all, however much of the window is expired. This \
         is the row that makes a dropped `truncate` visible even when the cap is not otherwise \
         binding.",
        &[(1, s1), (2, s2)],
        now,
        ttl,
        0,
        &[],
    );
    check(
        "[rb86/two-bundles]",
        "Two bundles in one window yield two stamps, ascending, regardless of the order their \
         rows arrived in.",
        &[(1, s2), (2, s1), (3, s2)],
        now,
        ttl,
        8,
        &[s1, s2],
    );
    check(
        "[rb86/cap-straddle]",
        "THE DEFECT ROW. Bundle A holds three chunks and bundle B two; the read window cut B in \
         half, so only ONE of B's rows is here. B's stamp must still be planned — that is what \
         makes the delete take B's tail with it — and this is the exact shape that used to commit \
         a k-of-N bundle.",
        &[(1, s1), (2, s1), (3, s1), (4, s2)],
        now,
        ttl,
        8,
        &[s1, s2],
    );
}

/// T2: the seam's structural post-conditions over ONE pinned, ragged fixture
/// where window order, id order and stamp order are three different orders and
/// one stamp carries two rows.
///
/// The VACUITY clause runs first and the exact value last, deliberately: every
/// structural clause between them — distinct, ascending, subset, bounded,
/// idempotent — is satisfied by an empty result, so without those two ends a
/// seam that returned nothing would pass the whole test.
///
/// Kills: M1 the dedup dropped, by `[rb86/stamps-distinct]`; M6 the sort
/// dropped, by `[rb86/stamps-oldest-first]`; a seam that invented a stamp, by
/// `[rb86/stamps-subset]`; a seam that ignored its budget, by
/// `[rb86/stamps-bounded]`; a seam with interior state, by
/// `[rb86/stamps-idempotent]`.
#[test]
fn rb86_reap_bundle_plan_is_distinct_and_oldest_first() {
    let now: i64 = 1_000_000;
    let ttl: i64 = 1_000;
    let s1: i64 = 100_000;
    let s2: i64 = 200_000;
    let s3: i64 = 300_000;
    let max_stamps: usize = 8;
    let rows: [(u64, i64); 5] = [(9, s2), (3, s1), (5, s2), (1, s1), (4, s3)];

    let got = rb86_plan(&rows, now, ttl, max_stamps);

    assert!(
        !got.is_empty(),
        "[rb86/stamps-vacuity]: every expired row in this fixture is expired by a wide margin, so \
         the seam must return SOMETHING. An empty result satisfies each structural clause below \
         one by one, which is exactly how a seam that reaps nothing passes a structural test. \
         Window: {rows:?}"
    );

    let mut sorted = got.clone();
    sorted.sort_unstable();
    for pair in sorted.windows(2) {
        assert_ne!(
            pair[0], pair[1],
            "[rb86/stamps-distinct]: the plan names the stamp {} more than once. A stamp is one \
             index POINT and one delete syscall; naming it twice spends the tick's write budget \
             on a bundle that is already gone, so the cap reaps fewer bundles than it is allowed \
             to. Plan: {got:?}",
            pair[0]
        );
    }

    for pair in got.windows(2) {
        assert!(
            pair[0] < pair[1],
            "[rb86/stamps-oldest-first]: the plan must be STRICTLY ASCENDING by creation stamp — \
             oldest bundle first — and this one has {} before {}. Fairness is the whole reason: \
             the window arrives in whatever order the btree yields, and rb-85 records that the \
             order is an expectation rather than an SDK contract, so the seam is where oldest-first \
             is made true. Plan: {got:?}",
            pair[0], pair[1]
        );
    }

    for stamp in &got {
        assert!(
            rows.iter().any(|(_, s)| s == stamp),
            "[rb86/stamps-subset]: the plan names the stamp {stamp}, which appears in NO window \
             row. Every element must be a stamp the tick actually read: a fabricated or \
             arithmetic-derived stamp is a delete keyed on rows nobody weighed. Window: {rows:?}"
        );
    }

    assert!(
        got.len() <= max_stamps,
        "[rb86/stamps-bounded]: the plan holds {} stamp(s) for a budget of {max_stamps}. The \
         budget is the tick's WRITE bound and a bundle's size is not bounded by the read window, \
         so an over-long plan is an unbounded write set under the global write lock.",
        got.len()
    );

    assert_eq!(
        got,
        rb86_plan(&rows, now, ttl, max_stamps),
        "[rb86/stamps-idempotent]: two calls with the same arguments returned different plans. \
         The seam is pure by contract; interior state here would make the tick's behaviour depend \
         on how many ticks preceded it."
    );

    assert_eq!(
        got,
        vec![s1, s2, s3],
        "[rb86/stamps-value]: the plan for this pinned fixture is exactly the three distinct \
         stamps, ascending. This is the backstop under every structural clause above, each of \
         which an empty or truncated plan satisfies on its own."
    );
}

// ===========================================================================
// T3 — ONE TICK OVER A SIMULATED TABLE. The oracle is the post-tick table.
// ===========================================================================

/// T3: a tick leaves every bundle whole under an oversized population.
///
/// WHAT THIS PROVES AND WHAT IT DOES NOT, stated rather than implied. The model
/// here is the DESIGN: window, plan, delete-every-row-carrying-a-planned-stamp.
/// Per-bundle atomicity is structural in that model, which is why `[rb86/atomic]`
/// alone would be a tautology — the clauses that carry weight are
/// `[rb86/progress]` (a tick that plans nothing is caught), `[rb86/no-collateral]`
/// (a tick that reaches past the cutoff is caught), the shipped-cap arithmetic,
/// the three-owners-one-stamp row, and above all
/// `[rb86/fixture-splits-under-the-old-rule]`, which puts the SAME fixture
/// through the superseded id-keyed rule and requires it to tear. That the
/// SHIPPED helper is this tick is proven elsewhere and deliberately so: by the
/// revised `rb85_helper_body_exact` equality pin and by the structural census in
/// `rb86_reaper_deletes_whole_bundles_by_stamp_and_never_by_chunk_id`. Both must
/// ship, because a fixture-only tooth never covers the wiring.
///
/// Kills: M7, a seam that short-circuits to an empty plan once the window fills,
/// by `[rb86/progress]` on the SHIPPED-constant row whose window really does
/// reach 256 rows — the toy-cap rows cannot see that mutant at all.
#[test]
fn rb86_bundle_reap_is_all_or_nothing_under_an_oversized_population() {
    let toy_now: i64 = 1_000_000;
    let toy_ttl: i64 = 1_000;
    let big_now: i64 = 1_000_000_000_000;
    let big_ttl: i64 = crate::privacy::EXPORT_BUNDLE_TTL_MS;
    let read_cap: usize = crate::privacy::EXPORT_REAP_MAX_READ_PER_TICK;
    let write_cap: usize = crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK;

    // (1) two bundles whose chunks together exceed the read cap.
    let straddle = rb86_bundle_rows(&[(100_000, 1, 3), (200_000, 2, 2)]);
    // (2) the SHIPPED constants over a population whose window really fills.
    let mut oversized_spec: Vec<(i64, u8, usize)> = Vec::new();
    let mut owner = 1u8;
    while owner <= 20 {
        oversized_spec.push((i64::from(owner) * 1_000, owner, 20));
        owner += 1;
    }
    let oversized = rb86_bundle_rows(&oversized_spec);
    // (7) the SHIPPED constants where the WRITE cap is what binds.
    let mut capped_spec: Vec<(i64, u8, usize)> = Vec::new();
    let mut capped_owner = 1u8;
    while capped_owner <= 20 {
        capped_spec.push((i64::from(capped_owner) * 1_000, capped_owner, 10));
        capped_owner += 1;
    }
    let capped = rb86_bundle_rows(&capped_spec);
    // (3) one bundle larger than the read cap, on its own.
    let single = rb86_bundle_rows(&[(500_000, 1, 10)]);
    // (4) ragged sizes, a shared stamp, and one bundle that is not expired.
    let ragged = rb86_bundle_rows(&[
        (100_000, 1, 1),
        (200_000, 2, 17),
        (300_000, 3, 300),
        (400_000, 4, 2),
        (400_000, 5, 2),
        (999_500, 6, 5),
    ]);
    // (5) / (6) the expired population EXACTLY at the cap, and one past it.
    let exactly = rb86_bundle_rows(&[
        (110_000, 1, 2),
        (120_000, 2, 2),
        (130_000, 3, 2),
        (140_000, 4, 2),
    ]);
    let over_by_one = rb86_bundle_rows(&[
        (110_000, 1, 2),
        (120_000, 2, 2),
        (130_000, 3, 2),
        (140_000, 4, 2),
        (150_000, 5, 1),
    ]);
    // three OWNERS sharing one creation stamp, plus a fourth bundle that does not.
    let shared = rb86_bundle_rows(&[
        (500_000, 1, 2),
        (500_000, 2, 2),
        (500_000, 3, 2),
        (600_000, 4, 2),
    ]);

    // A nested fn rather than a closure, for the reason T1's records: plain fns
    // are where argument coercion and region inference are least surprising. The
    // name carries no `rb86_` prefix, so no roster census counts it.
    fn check(
        what: &str,
        table: &[(u64, i64, u8)],
        now: i64,
        ttl: i64,
        cap: usize,
        max_stamps: usize,
    ) {
        let cutoff = crate::privacy::export_reap_cutoff_ms(now, ttl);
        let pre = rb86_groups(table);
        let survivors = rb86_tick(table, now, ttl, cap, max_stamps, false);
        let post = rb86_groups(&survivors);
        let count_of = |groups: &[((i64, u8), usize)], key: (i64, u8)| -> usize {
            groups
                .iter()
                .find(|(k, _)| *k == key)
                .map_or(0, |(_, n)| *n)
        };

        for (key, before) in &pre {
            let after = count_of(post.as_slice(), *key);
            assert!(
                after == 0 || after == *before,
                "[rb86/atomic]: over {what} the bundle stamped {} and owned by {} held {before} \
                 chunk(s) before the tick and {after} after. A bundle is every chunk sharing one \
                 creation stamp, so the only sanctioned outcomes are ALL of it and NONE of it — \
                 anything between is the k-of-N state the client reports as incomplete.",
                key.0,
                key.1
            );
        }

        let window = rb86_window(table, now, ttl, cap);
        if !window.is_empty() {
            assert!(
                survivors.len() < table.len(),
                "[rb86/progress]: over {what} the window held {} expired row(s) and the tick \
                 deleted NOTHING ({} rows before, {} after). A retention control that makes no \
                 progress while expired data is in front of it is a statement about intent; this \
                 is the clause a plan that short-circuits once the window fills dies on.",
                window.len(),
                table.len(),
                survivors.len()
            );
            assert!(
                pre.iter()
                    .any(|(key, _)| count_of(post.as_slice(), *key) == 0),
                "[rb86/progress]: over {what} rows were deleted but NO bundle was emptied. \
                 Progress has to be measured in whole bundles, not in rows: deleting some rows of \
                 every bundle and none of any bundle completely is exactly the tear this slice \
                 exists to remove."
            );
        }

        for (key, before) in &pre {
            if key.0 > cutoff {
                assert_eq!(
                    count_of(post.as_slice(), *key),
                    *before,
                    "[rb86/no-collateral]: over {what} the bundle stamped {} (owner {}) is NOT \
                     expired — its stamp is above the cutoff {cutoff} — and the tick took {} of \
                     its {before} chunk(s). Every stamp the seam returns comes from the window, \
                     and every window row is at or below the cutoff, so a fresh bundle can only be \
                     touched by a tick that invented a stamp.",
                    key.0,
                    key.1,
                    *before - count_of(post.as_slice(), *key)
                );
            }
        }
    }

    check(
        "two bundles whose chunks exceed the read cap",
        straddle.as_slice(),
        toy_now,
        toy_ttl,
        4,
        4,
    );
    check(
        "the SHIPPED constants over 400 expired rows, so the window really fills",
        oversized.as_slice(),
        big_now,
        big_ttl,
        read_cap,
        write_cap,
    );
    check(
        "the SHIPPED constants where the WRITE cap is what binds",
        capped.as_slice(),
        big_now,
        big_ttl,
        read_cap,
        write_cap,
    );
    check(
        "one bundle larger than the read cap, on its own",
        single.as_slice(),
        toy_now,
        toy_ttl,
        4,
        16,
    );
    check(
        "a ragged population: 1, 17 and 300 chunks, two owners sharing a stamp, one fresh bundle",
        ragged.as_slice(),
        toy_now,
        toy_ttl,
        20,
        3,
    );
    check(
        "an expired population EXACTLY at the read cap",
        exactly.as_slice(),
        toy_now,
        toy_ttl,
        8,
        2,
    );
    check(
        "an expired population one row PAST the read cap",
        over_by_one.as_slice(),
        toy_now,
        toy_ttl,
        8,
        2,
    );
    check(
        "three owners sharing one creation stamp",
        shared.as_slice(),
        toy_now,
        toy_ttl,
        2,
        1,
    );

    // --- the WRITE cap binds at exactly sixteen, oldest first ----------------
    let capped_post = rb86_groups(&rb86_tick(
        &capped, big_now, big_ttl, read_cap, write_cap, false,
    ));
    let capped_pre = rb86_groups(&capped);
    let gone: Vec<i64> = capped_pre
        .iter()
        .filter(|(key, _)| !capped_post.iter().any(|(k, _)| k == key))
        .map(|(key, _)| key.0)
        .collect();
    assert_eq!(
        gone.len(),
        write_cap,
        "[rb86/stamps-cap-tick]: twenty whole bundles were expired and inside the read window, so \
         exactly {write_cap} of them must be reaped — the tick's WRITE bound. {} went. A tick that \
         reaps more has an unbounded write set; one that reaps fewer is throughput the constant's \
         own rationale promises. Reaped stamps: {gone:?}",
        gone.len()
    );
    let mut oldest: Vec<i64> = capped_pre.iter().map(|(key, _)| key.0).collect();
    oldest.sort_unstable();
    oldest.truncate(write_cap);
    assert_eq!(
        gone, oldest,
        "[rb86/stamps-cap-tick]: the {write_cap} bundles reaped must be the {write_cap} OLDEST. \
         Keeping an arbitrary subset leaves the oldest personal data in the table indefinitely \
         under sustained load, which is the fairness property the seam's sort exists for."
    );

    // --- three owners, one stamp, one delete unit ----------------------------
    let shared_post = rb86_groups(&rb86_tick(&shared, toy_now, toy_ttl, 2, 1, false));
    for owner_id in [1u8, 2u8, 3u8] {
        assert!(
            !shared_post.iter().any(|(k, _)| *k == (500_000, owner_id)),
            "[rb86/same-stamp-together]: the read window held only TWO rows and both belonged to \
             owner 1, yet the stamp 500000 is shared by owners 1, 2 and 3 — every chunk carrying \
             it is one delete unit and they must all go in the one transaction. Owner {owner_id} \
             still has rows. Surviving bundles: {shared_post:?}"
        );
    }
    assert_eq!(
        shared_post,
        vec![((600_000, 4u8), 2usize)],
        "[rb86/same-stamp-together]: the bundle stamped 600000 was never in the window and must \
         survive the tick whole. Anything else means the delete reached past the stamps the seam \
         actually planned."
    );

    // --- NON-VACUITY: the same fixture TEARS under the superseded rule -------
    let split_pre = rb86_groups(&straddle);
    let split_post = rb86_groups(&rb86_split_tick(&straddle, toy_now, toy_ttl, 4));
    let torn = split_pre.iter().any(|(key, before)| {
        let after = split_post
            .iter()
            .find(|(k, _)| k == key)
            .map_or(0, |(_, n)| *n);
        after > 0 && after < *before
    });
    assert!(
        torn,
        "[rb86/fixture-splits-under-the-old-rule]: the FIRST fixture above must leave some bundle \
         with more than zero and fewer than all of its chunks when it is put through the \
         superseded delete-the-planned-ids rule. If it does not, its bundles never straddle the \
         read cap, `[rb86/atomic]` above passes over a population that could not tear under ANY \
         rule, and this whole test is a tautology. Before: {split_pre:?} After: {split_post:?}"
    );
}

// ===========================================================================
// T4 / T5 — THE PROPERTIES. Random windows against the SHIPPED expiry seam, and
// random populations through the model tick.
// ===========================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// T4: the plan is exactly the distinct creation
    /// stamps of the rows the SHIPPED expiry seam marks expired, oldest first,
    /// truncated to the write budget.
    ///
    /// The oracle is built as an ORDERED SET over `plan_export_reap`'s verdict,
    /// which is a different construction from the seam's own filter-sort-dedup
    /// sequence rather than a transcription of it — and it routes through
    /// `crate::privacy::plan_export_reap` deliberately: the retention predicate
    /// is the module's SSOT, so a test that re-spelled it would be comparing the
    /// slice's arithmetic against a copy of the slice's arithmetic.
    ///
    /// The stamp strategy is a UNION rather than a uniform range, for the reason
    /// rb-85's range property records: sampled uniformly over i64 the boundary
    /// cases are never reached, so the union puts the exact cutoff, one either
    /// side of it, both saturation corners and zero beside the reachable band.
    /// Ids are unique by construction because the real window's are — `chunk_id`
    /// is the primary key.
    ///
    /// HONEST LIMIT: this is an arithmetic relationship between two pure fns. It
    /// does not prove the helper hands the seam its window (T7, and the revised
    /// helper body pin), nor that the datastore deletes what the plan names —
    /// the execution proof over seeded rows is the rb109_ block.
    #[test]
    fn rb86_reap_bundle_plan_agrees_with_the_shipped_expiry_seam(
        stamps in proptest::collection::vec(
            prop_oneof![
                Just(999_000i64),
                Just(999_001i64),
                Just(998_999i64),
                Just(0i64),
                Just(i64::MIN),
                Just(i64::MAX),
                0i64..2_000_000i64
            ],
            0..20,
        ),
        max_stamps in 0usize..=20,
    ) {
        let now: i64 = 1_000_000;
        let ttl: i64 = 1_000;

        // `zip` over an unbounded counter rather than a hand-rolled `id += 1`:
        // clippy's `explicit_counter_loop` fires on the latter under
        // `-D warnings`, which `just lint` applies to the test target too.
        let mut rows: Vec<(u64, i64)> = Vec::new();
        for (id, stamp) in (1u64..).zip(stamps.iter()) {
            rows.push((id, *stamp));
        }

        let planned = crate::privacy::plan_export_reap(&rows, now, ttl, rows.len());
        let mut ordered: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
        for (row_id, stamp) in &rows {
            if planned.contains(row_id) {
                ordered.insert(*stamp);
            }
        }
        let want: Vec<i64> = ordered.into_iter().take(max_stamps).collect();

        let got = rb86_plan(&rows, now, ttl, max_stamps);
        prop_assert_eq!(
            &got,
            &want,
            "[rb86/plan-agrees]: the plan must be the distinct creation stamps of the rows \
             `plan_export_reap` marks expired over the WHOLE window, ascending, truncated to the \
             write budget. Window: {:?} budget: {}",
            rows,
            max_stamps
        );

        for stamp in &got {
            prop_assert!(
                rb85_seam_says_expired(*stamp, now, ttl),
                "[rb86/only-expired-prop]: the plan names the stamp {}, which the SHIPPED expiry \
                 seam does NOT call expired. Every stamp the tick deletes must be one the \
                 retention ceiling already condemned — this is the clause that makes the whole \
                 design fail SAFE, because the delete takes rows the window never read",
                stamp
            );
        }

        prop_assert!(
            got.len() <= max_stamps,
            "[rb86/stamps-bounded-prop]: the plan holds {} stamp(s) for a budget of {}. A bundle's \
             size is not bounded by the read window, so an over-long plan is an unbounded write \
             set under the global write lock",
            got.len(),
            max_stamps
        );

        for pair in got.windows(2) {
            prop_assert!(
                pair[0] < pair[1],
                "[rb86/stamps-sorted-prop]: the plan must be strictly ascending; {} precedes {}. \
                 Ascending is both the distinctness claim and the oldest-first fairness claim in \
                 one",
                pair[0],
                pair[1]
            );
        }

        prop_assert_eq!(
            &got,
            &rb86_plan(&rows, now, ttl, max_stamps),
            "[rb86/plan-idempotent]: two calls with identical arguments returned different plans"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// T5: over random ragged populations, one tick leaves every bundle whole,
    /// makes progress, touches nothing fresh, and does not depend on the order
    /// the window arrived in.
    ///
    /// The stamp domain is bounded well inside the reachable clock band so the
    /// model's cutoff comparison and `plan_export_reap`'s saturating age test
    /// agree exactly — the corners where they can diverge are T4's business, and
    /// mixing them here would make the progress clause conditional rather than
    /// absolute.
    ///
    /// `[rb86/order-independent]` is the clause that says the design does not
    /// rest on the btree's ascending yield, which rb-85 records as an
    /// expectation and not an SDK contract: the same window reversed must
    /// produce the same post-tick table.
    ///
    /// THE SHIPPED-CAP ARM IS MADE TO BIND. A drawn population of at most eleven
    /// small bundles cannot reach either shipped constant, so an arm that simply
    /// re-ran the tick at 256/16 would be inert — green over a cap that never
    /// applied. A deterministic block of twenty single-chunk bundles is appended
    /// for that arm alone, which puts more than sixteen distinct expired stamps
    /// in front of the plan on every case while the table stays under the read
    /// cap, so `[rb86/stamps-cap-prop]` measures the write bound doing its job.
    #[test]
    fn rb86_tick_leaves_every_bundle_whole(
        bundles in proptest::collection::vec(
            (0i64..=1_500_000_000i64, 1usize..=6usize),
            2..12,
        ),
        cap in 1usize..=64,
        max_stamps in 1usize..=8,
    ) {
        let now: i64 = 1_000_000_000;
        let ttl: i64 = 604_800_000;
        let cutoff = crate::privacy::export_reap_cutoff_ms(now, ttl);

        let mut table: Vec<(u64, i64, u8)> = Vec::new();
        let mut next_id = 1u64;
        let mut owner = 0u8;
        for (stamp, chunks) in &bundles {
            for _ in 0..*chunks {
                table.push((next_id, *stamp, owner));
                next_id += 1;
            }
            owner = owner.saturating_add(1);
        }

        let pre = rb86_groups(&table);
        let survivors = rb86_tick(&table, now, ttl, cap, max_stamps, false);
        let post = rb86_groups(&survivors);

        for (key, before) in &pre {
            let after = post.iter().find(|(k, _)| k == key).map_or(0, |(_, n)| *n);
            prop_assert!(
                after == 0 || after == *before,
                "[rb86/atomic-prop]: the bundle stamped {} (owner {}) held {} chunk(s) and kept \
                 {} — a bundle is every chunk sharing one creation stamp and may only be reaped \
                 whole",
                key.0,
                key.1,
                before,
                after
            );
        }

        let window = rb86_window(&table, now, ttl, cap);
        if !window.is_empty() {
            prop_assert!(
                survivors.len() < table.len(),
                "[rb86/progress]: the window held {} expired row(s) and the tick deleted nothing",
                window.len()
            );
            prop_assert!(
                pre.iter().any(|(key, _)| !post.iter().any(|(k, _)| k == key)),
                "[rb86/progress]: rows went but no bundle was emptied, which is the tear itself"
            );
        }

        for (key, before) in &pre {
            if key.0 > cutoff {
                let after = post.iter().find(|(k, _)| k == key).map_or(0, |(_, n)| *n);
                prop_assert_eq!(
                    after,
                    *before,
                    "[rb86/no-collateral]: the bundle stamped {} is above the cutoff {} and must \
                     keep every one of its chunks",
                    key.0,
                    cutoff
                );
            }
        }

        let reversed = rb86_tick(&table, now, ttl, cap, max_stamps, true);
        prop_assert_eq!(
            &survivors,
            &reversed,
            "[rb86/order-independent]: handing the SAME window to the plan in the opposite order \
             produced a different post-tick table. The ascending yield of the btree range is an \
             expectation rather than a contract, so a plan that depends on it is a correctness \
             claim resting on undocumented behaviour"
        );

        // The SHIPPED-cap arm. The drawn population alone is at most eleven
        // bundles of at most six chunks, so NEITHER shipped cap could bind and
        // the arm would assert nothing at all about the numbers that actually
        // ship. A DETERMINISTIC block of twenty single-chunk bundles is appended
        // — deterministic so CI sees the same arm on every run — which makes the
        // WRITE cap bind on every case while the whole table stays far under the
        // READ cap (66 + 20 is well below 256). The window is therefore the whole
        // expired population and the plan is exactly the sixteen oldest distinct
        // stamps in it, which is what the two clauses below pin.
        let read_cap = crate::privacy::EXPORT_REAP_MAX_READ_PER_TICK;
        let write_cap = crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK;
        let mut shipped_table = table.clone();
        for (det_owner, det_stamp) in (100u8..120u8).zip(1i64..) {
            shipped_table.push((next_id, det_stamp, det_owner));
            next_id += 1;
        }
        let shipped = rb86_tick(&shipped_table, now, ttl, read_cap, write_cap, false);

        let shipped_pre = rb86_groups(&shipped_table);
        let shipped_groups = rb86_groups(&shipped);
        for (key, before) in &shipped_pre {
            let after = shipped_groups
                .iter()
                .find(|(k, _)| k == key)
                .map_or(0, |(_, n)| *n);
            prop_assert!(
                after == 0 || after == *before,
                "[rb86/atomic-shipped]: at the SHIPPED read and write caps the bundle stamped {} \
                 (owner {}) held {} chunk(s) and kept {}",
                key.0,
                key.1,
                before,
                after
            );
        }

        let before_stamps: std::collections::BTreeSet<i64> =
            shipped_table.iter().map(|(_, stamp, _)| *stamp).collect();
        let after_stamps: std::collections::BTreeSet<i64> =
            shipped.iter().map(|(_, stamp, _)| *stamp).collect();
        let gone: Vec<i64> = before_stamps.difference(&after_stamps).copied().collect();
        let oldest: Vec<i64> = before_stamps
            .iter()
            .copied()
            .filter(|stamp| *stamp <= cutoff)
            .take(write_cap)
            .collect();
        prop_assert_eq!(
            gone.len(),
            write_cap,
            "[rb86/stamps-cap-prop]: at the shipped caps the tick must reap EXACTLY {} distinct \
             creation stamps — the write bound — from a population that always holds more than \
             that many expired ones. Fewer is throughput the constant's own rationale promises; \
             more is an unbounded write set, and a bundle's size is not bounded by the read window",
            write_cap
        );
        prop_assert_eq!(
            &gone,
            &oldest,
            "[rb86/stamps-cap-prop]: the stamps reaped at the shipped caps must be the OLDEST \
             expired ones. Keeping an arbitrary subset leaves the oldest personal data in the \
             table indefinitely under sustained load, which is the fairness property the seam's \
             sort exists for and the one thing the btree's ascending yield is NOT allowed to be \
             responsible for"
        );
    }
}

/// A fixture tick. The record is PRIVATE with private fields and this module is a
/// CHILD of `privacy`, which is the whole reason a value oracle is possible here
/// at all.
///
/// Arguments in RECORD order, `(read, due, planned, reaped)` — the data-flow
/// order rb-115 inserted `due` into. `rb109_tick` returns the same
/// four counts APPEND-ONLY instead, `(read, planned, reaped, due)`, because its
/// callers read the first three by position; the two orders differ on purpose.
fn rb87_tick(read: usize, due: usize, planned: usize, reaped: usize) -> super::ExportReapTick {
    super::ExportReapTick {
        read,
        due,
        planned,
        reaped,
    }
}

/// X1 (behavioural, the payload): `reap_fields` renders EXACTLY the sanctioned
/// keys with BARE counts, in the order read, due, planned, reaped. The NAME keeps
/// its rb-87 `three` (the ADR-0238 amendment cites it); since rb-115
/// it pins FOUR counts.
///
/// The counts are PAIRWISE DISTINCT on the three middle rows (the quiet-hour zero
/// row and the all-MAX width row are deliberately uniform),
/// on purpose: all four are `usize`, so an honest transposition of two encoder
/// calls type-checks, is clippy-clean and satisfies every source-scan clause in
/// this slice. Equal fixture values would make this test green on it.
///
/// Kills: M3, a constant-returning builder (any row disagrees);
///        M2, two of the four values transposed with the key order intact;
///        M1, a key dropped or a value rendered twice;
///        M4, the separating comma lost (`first` re-set before every key);
///        M20, `planned` and `reaped` rendered through `json_u32_into(.. as u32)`
///        — byte-identical below 2^32, so ONLY the above-u32 row sees it;
///        a QUOTED count, which is what `json_u64_into` renders for the same
///        value and which no panel or alert can compare numerically;
///        a builder that omits a count when it is zero — the all-zero tick is the
///        ordinary quiet hour, and an absent key reads downstream as `unknown`
///        rather than as `none`;
///        a fifth key, or any of the four RESERVED envelope keys, which
///        last-key-wins parsing downstream would let forge the event type or a
///        breadcrumb.
#[test]
fn rb87_reap_fields_renders_three_bare_counts() {
    let q = rb22p_dq();

    // --- the value table, FIRST (clause order is load-bearing) ---------------
    let rows: [(super::ExportReapTick, String); 5] = [
        (
            rb87_tick(0, 0, 0, 0),
            format!("{q}read{q}:0,{q}due{q}:0,{q}planned{q}:0,{q}reaped{q}:0"),
        ),
        (
            rb87_tick(7, 5, 3, 11),
            format!("{q}read{q}:7,{q}due{q}:5,{q}planned{q}:3,{q}reaped{q}:11"),
        ),
        (
            rb87_tick(256, 20, 16, 4096),
            format!("{q}read{q}:256,{q}due{q}:20,{q}planned{q}:16,{q}reaped{q}:4096"),
        ),
        (
            rb87_tick(4_294_967_296, 4_294_967_297, 4_294_967_298, 4_294_967_299),
            format!(
                "{q}read{q}:4294967296,{q}due{q}:4294967297,{q}planned{q}:4294967298,\
                 {q}reaped{q}:4294967299"
            ),
        ),
        (
            rb87_tick(usize::MAX, usize::MAX, usize::MAX, usize::MAX),
            format!(
                "{q}read{q}:{m},{q}due{q}:{m},{q}planned{q}:{m},{q}reaped{q}:{m}",
                m = usize::MAX
            ),
        ),
    ];
    for (tick, expected) in rows {
        assert_eq!(
            super::reap_fields(tick),
            expected,
            "[rb87/fields-value]: the reaper fragment for {tick:?} must be EXACTLY four keys in \
             this order — `read`, the BARE count of chunk rows the bounded window decoded; `due`, \
             the BARE count of distinct expired creation stamps that window held BEFORE the stamp \
             cap (rb-115, ADR-0269); `planned`, the BARE count of creation stamps the bundle seam \
             selected; `reaped`, the BARE count of rows the datastore actually deleted. The middle \
             rows give all four counts DISTINCT values precisely so a transposition of two encoder \
             calls, which type-checks and is clippy-clean, reds by VALUE here. The all-zero row is \
             the ordinary quiet hour — the one case an operator must be able to tell from a tick \
             that never ran — so a zero renders as `:0` and is never omitted or suppressed. The \
             above-u32 row is the ONLY instrument that sees a `json_u32_into(.. as u32)` \
             narrowing, which is byte-identical for every value below 2^32. SCOPE, STATED \
             HONESTLY (the ADR-0243 D3 precedent): on wasm32 `usize` IS `u32`, so that row is \
             unreachable in the shipped module and what it pins is the ENCODER CONTRACT — each \
             count rendered at the width the helper reports it, with no cast between them."
        );
    }

    // --- the quote census and the reserved envelope keys ---------------------
    let fragment = super::reap_fields(rb87_tick(12, 23, 34, 56));
    assert_eq!(
        fragment.matches(q).count(),
        8,
        "[rb87/fields-no-quote]: the fragment must carry EXACTLY eight double quotes — four \
         quoted KEYS and nothing else; got {fragment:?}. TEN or more means a count was QUOTED, \
         which is the shape `json_u64_into` produces (ADR-0226 quotes 64-bit integers because the \
         client assembler loses precision above 2^53) and which no panel, rule or alert can \
         compare numerically. SIX means a key lost its quotes or went missing — the pre-rb-115 \
         three-key fragment is exactly six — and a key without quotes makes the envelope this \
         text splices into not JSON at all."
    );
    for key in ["evt", "cause", "sched", "phase"] {
        let reserved = format!("{q}{key}{q}:");
        assert!(
            !fragment.contains(reserved.as_str()),
            "[rb87/fields-no-quote]: the fragment carries the RESERVED envelope key `{reserved}`. \
             `build_log_line` splices this text VERBATIM after the evt and downstream JSON parsing \
             is LAST-KEY-WINS, so a reserved key here forges the event type or a breadcrumb on \
             every line the reaper writes. The AM6 debug assertion that would catch it fires only \
             under cfg(test) and compiles OUT of the release wasm, which is exactly why a \
             value-level clause is the production-side guarantee. Fragment: {fragment:?}"
        );
    }
}

/// X1 (behavioural, composition): the tick fragment composes into a well-formed
/// evt-first envelope through the SHIPPED builder, byte for byte.
///
/// The only test in this slice that exercises the REAL composition the reducer
/// performs. `observability_tests.rs` proves the native host runs
/// `build_log_line` with no logger installed, and the two items reached here are
/// `pub(crate)` while `privacy_tests` is a child of `privacy` — so this is an
/// ordinary Rust value assertion rather than a source scan.
///
/// Kills: a fragment that starts with a comma, which gives the envelope a double
///        separator no downstream parser recovers from;
///        an EMPTY fragment, which leaves a one-key line that observes nothing;
///        an envelope whose evt is not first (the relay reconstruction and the
///        Loki label set both key on that position being stable);
///        the evt renamed, which retires every operator query keyed on it;
///        a key beyond the four counts, or a quoted count, by byte equality
///        against a line this test builds key by key (four count keys since
///        rb-115 inserted `due`).
#[test]
fn rb87_reap_line_is_the_exact_json_envelope() {
    let q = rb22p_dq();
    let rows: [(super::ExportReapTick, String); 2] = [
        (
            rb87_tick(0, 0, 0, 0),
            format!("{q}read{q}:0,{q}due{q}:0,{q}planned{q}:0,{q}reaped{q}:0"),
        ),
        (
            rb87_tick(256, 20, 16, 4096),
            format!("{q}read{q}:256,{q}due{q}:20,{q}planned{q}:16,{q}reaped{q}:4096"),
        ),
    ];
    for (tick, fragment) in rows {
        let line = crate::observability::build_log_line(
            stringify!(export_bundle_reap),
            &super::reap_fields(tick),
            crate::observability::Breadcrumb::default(),
        );
        let expected = format!("{{{q}evt{q}:{q}export_bundle_reap{q},{fragment}}}");
        assert_eq!(
            line, expected,
            "[rb87/line-exact]: the composed line for {tick:?} must be the canonical envelope — \
             `evt` FIRST, then the reaper fragment verbatim, and nothing else. This is the string \
             an operator greps, a dashboard rule matches and the derived \
             `mr_log_events_total{{reducer,evt}}` series is labelled from, so it is pinned by \
             VALUE rather than by shape. The zero row is the ordinary quiet hour and must still \
             produce a full five-key line: the ABSENCE of this line at the hourly cadence is the \
             dead-man signal that the tick is aborting, and a line that renders empty or partial \
             on a quiet hour makes absence mean two different things at once."
        );
    }
}

/// The squashed `fn` needle for the tier-selection seam.
fn rb107_nd_tier_fn() -> String {
    "fnexport_live_row_cap(".to_string()
}

/// The frozen squashed SIGNATURE slice of the tier seam. It starts at the `fn`
/// needle, so the (absent) visibility keyword is not part of it and is pinned
/// separately by the twenty-four-byte window.
///
/// RE-FROZEN BY rb-132: two plain bools, account FIRST. Still
/// context-free, which is the purity property this pin exists for, and the
/// parameter order is now part of the frozen text as well.
fn rb107_tier_sig_pin() -> String {
    [
        rb107_nd_tier_fn(),
        "has_account:bool,has_wallet:bool)->u64".to_string(),
    ]
    .concat()
}

/// THE FROZEN SQUASHED BODY of the tier seam. Names all THREE ceilings, so a
/// tier collapse that returns one of them from two arms cannot satisfy it.
///
/// RE-FROZEN BY rb-132: the account arm is tested first and ignores
/// the wallet bit; the wallet bit only splits the callers without an account.
/// The newcomer name is assembled so that no literal in this file opens with
/// that constant's full prefix — the rb-110 live-roster rule, which would
/// otherwise red on the tree before the constant exists.
fn rb107_tier_body_pin() -> String {
    [
        "ifhas_account{",
        "EXPORT_LIVE_ROW_CAP}elseifhas_wallet{",
        "EXPORT_ANON_LIVE_ROW_CAP}else{",
        "EXPORT_NEWCOMER_LIVE_ROW_CAP}",
    ]
    .concat()
}

/// The tier seam's DECLARATION line as whitespace-bearing source text (rb-132's
/// two-bool form, 68 columns flat, so rustfmt keeps it on one line).
fn rb107_tier_decl_source() -> String {
    "fn export_live_row_cap(has_account: bool, has_wallet: bool) -> u64 ".to_string()
}

/// The tier seam's BODY as whitespace-bearing source text (rb-132's three arms,
/// in rustfmt's canonical else-if layout).
fn rb107_tier_body_source() -> String {
    [
        "\n    if has_account {\n        ",
        "EXPORT_LIVE_ROW_CAP\n",
        "    } else if has_wallet {\n        ",
        "EXPORT_ANON_LIVE_ROW_CAP\n",
        "    } else {\n        ",
        "EXPORT_NEWCOMER_LIVE_ROW_CAP\n",
        "    }\n",
    ]
    .concat()
}

// --- shared machinery --------------------------------------------------------

/// How many times the live strip pipeline still sees `needle` after it has been
/// placed ONLY inside a line comment and inside a string literal.
///
/// The answer must be ZERO for every equality pin in this block, or the pin
/// would be satisfiable by a doc comment naming the right sequence. The fixture
/// is asserted to CARRY the needle first, so a zero cannot come from a fixture
/// that never held it.
fn rb107_blind_count(needle: &str) -> usize {
    let mut prose = String::new();
    prose.push_str("fn rb107_blindness_decoy() ");
    prose.push('{');
    prose.push_str("\n    ");
    prose.push_str("// ");
    prose.push_str(needle);
    prose.push_str("\n    let s = ");
    prose.push(rb22p_dq());
    prose.push_str(needle);
    prose.push(rb22p_dq());
    prose.push_str(";\n");
    prose.push('}');
    prose.push('\n');
    assert!(
        prose.contains(needle),
        "[rb107/blind-vacuity]: the blindness fixture built for {needle:?} does not carry the \
         needle at all, so the ZERO it is about to report would prove nothing."
    );
    rb22p_count(&stripped_for_scan(&prose), needle)
}

/// The `RB85_VIS_WINDOW` squashed bytes immediately before `needle`.
///
/// A WINDOW rather than a list of spellings, for the reason rb-85 records: an
/// enumerated ban on the two obvious visibility keywords is silently satisfied
/// by `pub(super)` or `pub(in crate::x)`. HONEST LIMIT, inherited unchanged: an
/// identifier ENDING in those three bytes immediately before a declaration would
/// be a false red — loud, and trivially diagnosable, which is the safe
/// direction.
///
/// Returns an owned `String` rather than a borrow so the declaration carries no
/// lifetime parameter: the roster census in `rb107_test_roster_is_closed` spells
/// every helper needle as a name followed immediately by an opening paren, and a
/// generic parameter list between the two would make that needle unsatisfiable.
fn rb107_vis_window_text(squashed: &str, needle: &str) -> String {
    let at = squashed.find(needle).unwrap_or_else(|| {
        panic!(
            "[rb107/vis-window]: the declaration needle {needle:?} does not occur in privacy.rs, \
             so the visibility window would be read off an arbitrary span and pass VACUOUSLY."
        )
    });
    let prefix = &squashed[..at];
    let start = prefix
        .char_indices()
        .rev()
        .take(RB85_VIS_WINDOW)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(0);
    prefix[start..].to_string()
}

/// The admission value table: `(what, live_rows, requested, cap, expected)`.
///
/// The two caps are spelled as LITERALS here, not read from the constants, and
/// that is deliberate: this table is the predicate's value oracle and must stay
/// an independent statement of what admission MEANS. The caps test owns the
/// separate question of whether the shipped constants carry those values. If the
/// ceiling is ever legitimately re-sized, BOTH move, in the same diff, from the
/// spec — never one to match the other.
///
/// At least half the rows are OFF-boundary (fourteen of twenty-seven), both
/// expectations appear, both caps appear, and the four cross-tier rows are the
/// ones that kill a predicate which ignores its `cap` argument and reads a
/// constant instead — every other row is satisfied by the full cap alone.
fn rb107_admit_rows() -> [(&'static str, u64, u32, u64, bool); 27] {
    let full: u64 = 43_008;
    let anon: u64 = 21_504;
    [
        (
            "full tier: the floor — empty store, empty request",
            0,
            0,
            full,
            true,
        ),
        (
            "full tier: a minimum bundle into an empty store",
            0,
            17,
            full,
            true,
        ),
        ("full tier: an off-boundary admit", 41_000, 137, full, true),
        (
            "full tier: a small off-boundary admit",
            5_000,
            500,
            full,
            true,
        ),
        (
            "full tier: a large off-boundary admit",
            37_777,
            4_321,
            full,
            true,
        ),
        (
            "full tier: the mid-split EXACT fit",
            20_000,
            23_008,
            full,
            true,
        ),
        (
            "full tier: the EXACT fit at cap minus requested",
            42_871,
            137,
            full,
            true,
        ),
        (
            "full tier: one row under the exact fit",
            42_870,
            137,
            full,
            true,
        ),
        (
            "full tier: ONE ROW OVER the exact fit",
            42_872,
            137,
            full,
            false,
        ),
        ("full tier: the top pair, admitted", 43_007, 1, full, true),
        ("full tier: the top pair, rejected", 43_007, 2, full, false),
        (
            "full tier: exactly at the cap with an empty request",
            43_008,
            0,
            full,
            true,
        ),
        (
            "full tier: exactly at the cap with a minimum bundle",
            43_008,
            17,
            full,
            false,
        ),
        (
            "full tier: requested-dominant, admitted",
            1,
            43_007,
            full,
            true,
        ),
        (
            "full tier: requested-dominant, rejected",
            1,
            43_008,
            full,
            false,
        ),
        (
            "anon tier: the EXACT fit at cap minus a minimum bundle",
            21_487,
            17,
            anon,
            true,
        ),
        (
            "anon tier: ONE ROW OVER that exact fit",
            21_488,
            17,
            anon,
            false,
        ),
        (
            "anon tier: exactly at the cap with a one-row request",
            21_504,
            1,
            anon,
            false,
        ),
        (
            "anon tier: the mid-split EXACT fit",
            10_000,
            11_504,
            anon,
            true,
        ),
        ("anon tier: an off-boundary admit", 21_000, 137, anon, true),
        (
            "anon tier: an off-boundary reject",
            21_400,
            137,
            anon,
            false,
        ),
        (
            "anon tier: a second off-boundary admit",
            12_345,
            9_000,
            anon,
            true,
        ),
        (
            "anon tier: a second off-boundary reject",
            19_999,
            2_000,
            anon,
            false,
        ),
        (
            "cross-tier: a mid store an ACCOUNT HOLDER may still fill",
            30_000,
            17,
            full,
            true,
        ),
        (
            "cross-tier: the same store, an ANONYMOUS caller shed",
            30_000,
            17,
            anon,
            false,
        ),
        (
            "cross-tier: just past half, admitted for an account holder",
            21_500,
            17,
            full,
            true,
        ),
        (
            "cross-tier: just past half, refused for an anonymous caller",
            21_500,
            17,
            anon,
            false,
        ),
    ]
}

/// accounts.rs, for the `is_account_holder` SSOT body pin in
/// `rb107_cap_selection_is_tiered_by_account`.
///
/// `include_str!` is relative to the including file, and this file sits beside
/// accounts.rs in `server-module/src/`. WHOLE-FILE, and sound here for the
/// reason the rb-85 marshal.rs const records: every way the strip pipeline could
/// desynchronise over that file is fail-LOUD — a blanked span can only make the
/// declaration census read ZERO or shorten the extracted body, and both red
/// under a label that names the reason. A desync cannot FABRICATE the frozen
/// body, which is the only direction that would matter.
const RB107_ACCOUNTS_RS: &str = include_str!("accounts.rs");

/// The squashed `fn` needle for the crate's account-holder SSOT predicate.
fn rb107_nd_holder_fn() -> String {
    "fnis_account_holder(".to_string()
}

/// THE FROZEN SQUASHED BODY of that predicate (accounts.rs).
///
/// rb-107 pins a body it does not own, and the reason is MEASURED (round-2 red
/// team, M2): NOTHING in this crate pinned it, so patching it to `true` deletes
/// the anonymous tier for every caller — and opens the pvp guards that share it
/// — while the whole suite stays green. The tier is only as true as the question
/// it asks.
fn rb107_holder_body_pin() -> String {
    [
        "ctx.db.",
        "account()",
        ".identity().find(identity).is_some()",
    ]
    .concat()
}

/// That predicate's DECLARATION line as whitespace-bearing source text — the
/// positive control's input, spelled independently of the pin above.
fn rb107_holder_decl_source() -> String {
    [
        "pub(crate) fn is_account_holder(ctx: &ReducerContext, ",
        "identity: Identity) -> bool ",
    ]
    .concat()
}

/// That predicate's BODY as whitespace-bearing source text (control input).
fn rb107_holder_body_source() -> String {
    [
        "\n    ",
        "ctx.db.",
        "account()",
        ".identity().find(identity).is_some()\n",
    ]
    .concat()
}

/// X1 (ledger anchor; register rows M1-M5): the admission predicate is EXACT at
/// BOTH caps and SATURATES rather than wraps.
///
/// THE ONLY EXECUTABLE ORACLE THIS SLICE HAS for the decision itself. The shells
/// around this predicate reach a table, so they can never run in the native test
/// host; the predicate is scalar-in, bool-out, and therefore has an ordinary
/// value oracle. Everything else about the gate is a source pin, which is why
/// this test is first in the roster and why its table is as wide as it is.
///
/// Kills (first killer of each):
///   M1 `<` substituted for `<=` — the exact-fit rows at both caps;
///   M2 the `requested` argument dropped — the cap-exact rows with a non-empty
///      request, at both tiers;
///   M4 the predicate ignoring its `cap` parameter and reading the full
///      constant instead — the four cross-tier rows, which are the only rows
///      whose expectation depends on WHICH cap was passed;
///   M5 the body replaced by a constant — the anti-vacuity preamble names the
///      discriminating pair before the loop even starts;
///   M3 a wrapping addition — the saturation clause, where the mutant admits at
///      `u64::MAX + 1`, which is the one direction a capacity control may never
///      fail in.
#[test]
fn rb107_admission_is_exact_at_both_caps_and_saturates() {
    let rows = rb107_admit_rows();

    // --- anti-vacuity: the table itself, BEFORE anything is called -----------
    assert!(
        rows.len() >= 18,
        "[rb107/admit-value]: the value table carries only {} row(s); at least eighteen are \
         required. A table that shrank is a table that stopped discriminating, and every clause \
         below would still report green over whatever is left.",
        rows.len()
    );
    let admits = rows.iter().filter(|r| r.4).count();
    let refuses = rows.len() - admits;
    assert!(
        admits >= 6 && refuses >= 6,
        "[rb107/admit-value]: the table carries {admits} admit row(s) and {refuses} reject \
         row(s); at least six of each are required. A table with one expectation is satisfied by \
         a constant predicate, which is register row M5."
    );
    let full_rows = rows.iter().filter(|r| r.3 == 43_008).count();
    let anon_rows = rows.iter().filter(|r| r.3 == 21_504).count();
    assert!(
        full_rows >= 6 && anon_rows >= 6,
        "[rb107/admit-value]: the table carries {full_rows} row(s) at the full cap and \
         {anon_rows} at the anonymous cap; at least six of each are required. A table that \
         exercises one tier cannot see a predicate that ignores its cap argument (M4), because \
         every row would agree with the constant it read."
    );
    let expectation = |live: u64, requested: u32, cap: u64| {
        rows.iter()
            .find(|r| r.1 == live && r.2 == requested && r.3 == cap)
            .map(|r| r.4)
    };
    assert_eq!(
        (
            expectation(42_871, 137, 43_008),
            expectation(42_872, 137, 43_008),
            expectation(21_487, 17, 21_504),
            expectation(21_488, 17, 21_504),
        ),
        (Some(true), Some(false), Some(true), Some(false)),
        "[rb107/admit-value]: the four DISCRIMINATING rows are not in the table with the \
         expectations the spec gives them. They are the exact fit and the one-row overshoot at \
         each tier — (42_871 + 137) and (42_872 + 137) against 43_008, (21_487 + 17) and \
         (21_488 + 17) against 21_504 — and each PAIR disagrees, so a constant-true or \
         constant-false predicate dies on them whatever else the table says. Naming them here, \
         before the loop, is what stops a future edit from quietly deleting the only rows that \
         separate `fits` from `does not fit`."
    );

    // --- [rb107/admit-value]: every row, individually -------------------------
    for (what, live, requested, cap, expected) in rows {
        let got = crate::privacy::export_admission_open(live, requested, cap);
        assert_eq!(
            got, expected,
            "[rb107/admit-value]: {what} — the admission predicate reads live_rows = {live}, \
             requested = {requested}, cap = {cap} and returns {got}; the value oracle says \
             {expected}. The rule is EXACT, not approximate: a request is admitted only when \
             live_rows PLUS its own whole row count still fits, so `live_rows <= cap` alone \
             (M2) admits a bundle that overshoots, `<` for `<=` (M1) refuses a bundle that fits \
             exactly, and a predicate reading the full constant instead of this `cap` argument \
             (M4) hands every anonymous caller the account holders' ceiling — which is the one \
             property the tiering exists to provide."
        );
    }

    // --- [rb107/admit-saturating]: the overflow direction ---------------------
    for (what, live, requested) in [
        (
            "an already-saturated store with an empty request",
            u64::MAX,
            0u32,
        ),
        (
            "an already-saturated store with a ONE-ROW request",
            u64::MAX,
            1u32,
        ),
        (
            "five rows below saturation with a minimum bundle",
            u64::MAX - 5,
            17u32,
        ),
        (
            "saturation against the widest possible request",
            u64::MAX,
            u32::MAX,
        ),
    ] {
        for (tier, cap) in [
            ("the full cap", 43_008u64),
            ("the anonymous cap", 21_504u64),
        ] {
            let got = crate::privacy::export_admission_open(live, requested, cap);
            assert!(
                !got,
                "[rb107/admit-saturating]: {what}, against {tier} — the admission predicate \
                 reads live_rows = {live}, requested = {requested}, cap = {cap} and ADMITS. The \
                 addition must SATURATE: the release profile enables overflow checks, so an \
                 unchecked add ABORTS the reducer at the extremes, and a wrapping add (M3) is \
                 worse than an abort — it wraps past zero and returns true, admitting without \
                 limit exactly when the store is most full. Saturation fails in the refusing \
                 direction, which is the only direction a capacity control may fail in."
            );
        }
    }
}

/// X1 (ledger anchor; register rows M7, M8, M28): the cap a caller gets is
/// TIERED on whether they hold an account row — and, since rb-132,
/// on whether a caller without one holds a wallet row — and the seam that
/// decides it is declared once, private, with a frozen signature and a frozen
/// body.
///
/// WHY A NAMED SEAM AND NOT AN INLINE CONDITIONAL. `/simplify` flagged this
/// layer and it was KEPT as a named exception: inlined into the `let cap`
/// binding it would have exactly one caller and no value oracle, so the
/// swapped-arms and tier-collapse mutants would die on a TEXT pin. Named, they
/// die on what the function RETURNS, which is the project's own doctrine — the
/// oracle must be the return value, one hop, not the source that produces it.
///
/// THE SUBJECT TEST ITSELF IS NOT RE-DERIVED HERE. `is_account_holder` is the
/// crate SSOT for `does this identity hold a verified account row` (ADR-0189 D2;
/// ADR-0179 records why `has_jwt()` is not the predicate — the host mints its own
/// token, so it is true for every connection). Its own tests own its behaviour;
/// what rb-107 owns is that the reducer asks THAT question. Since rb-132 the
/// reducer asks a SECOND crate SSOT question as well, the economy module's
/// wallet-row test, and the seam maps the two answers onto THREE ceilings. That
/// second question's body pin, the newcomer ceiling and the four-row value
/// oracle over both bools live in the rb-132 block
/// (`rb132_reducer_asks_the_wallet_ssot_exactly_once` and
/// `rb132_tier_selection_is_exhaustive_over_account_and_wallet`); this test
/// keeps rb-107's two rows, the account row and the anonymous-with-wallet row.
/// The mapping is this seam, and BOTH asks are pinned by the pre-gate needle in
/// `rb107_reducer_admits_twice_before_the_first_write`.
///
/// Kills: M7 the full and anonymous arms swapped, which hands every anonymous
/// caller the account holders' ceiling and every account holder half a store;
/// M8 the body collapsed to the full cap, which deletes the tier while leaving
/// every constant declared and every value clause in the caps test green; M28
/// the seam widened to `pub(crate)`, which makes the tier decision reachable
/// from a module that never reviewed it; a literal ceiling inlined into any arm.
#[test]
fn rb107_cap_selection_is_tiered_by_account() {
    let full = crate::privacy::EXPORT_LIVE_ROW_CAP;
    let anon = crate::privacy::EXPORT_ANON_LIVE_ROW_CAP;

    // --- [rb107/tier-value]: the account row and the anonymous-with-wallet row -
    //
    // Two of the four inputs, the two rb-107 named. The pair also disagrees
    // under an argument swap, which is what makes it the ORDER discriminator:
    // the seam takes account first, and two bools compile either way round.
    // The union with the rb-132 four-row oracle is exhaustive over both bools.
    let holder = crate::privacy::export_live_row_cap(true, false);
    assert_eq!(
        (holder, holder),
        (full, 43_008),
        "[rb107/tier-value]: a caller HOLDING an account row and no wallet row is given a ceiling \
         of {holder}; it must be the full live-row cap, {full}, which is 43_008 — the account bit \
         is tested first and the wallet bit is irrelevant to it. Both the named constant AND its \
         literal value are asserted here on purpose: against swapped arms (M7) a name-only clause \
         is green whenever the two constants are compared to each other rather than to what the \
         seam returned, and against a tier collapse (M8) the literal is what says WHICH ceiling \
         came back. A seam whose two parameters were swapped reads this row as a wallet-only \
         caller and returns the anonymous cap."
    );
    let guest = crate::privacy::export_live_row_cap(false, true);
    assert_eq!(
        (guest, guest),
        (anon, 21_504),
        "[rb107/tier-value]: a caller with NO account row but a wallet row is given a ceiling of \
         {guest}; it must be the anonymous cap, {anon}, which is 21_504. This arm is rb-107's \
         security property: `join_game` needs no token, so unlimited anonymous identities exist \
         by design, and the only thing that stops them taking the entire store is that this arm \
         returns the SMALLER number. Returning the full cap here (M8) is the tier deleted, \
         silently, with every constant still declared and every clause in the caps test still \
         green. The newcomer arm, no account and no wallet, is rb-132's row and is asserted by \
         the rb-132 value oracle, not here."
    );

    // --- [rb107/tier-ordering]: the shed order, stated as an inequality -------
    assert!(
        guest < holder,
        "[rb107/tier-ordering]: the anonymous ceiling ({guest}) is not strictly below the account \
         holder's ({holder}), so anonymous requests are NOT shed first and the two tiers are the \
         same control wearing two names. This clause is the one that survives a future re-sizing \
         of either constant: whatever the numbers become, the JWT-less tier must be the smaller \
         one or the account holders' headroom is not structurally unreachable."
    );

    let squashed = stripped_for_scan(PRIVACY_RS);
    let needle = rb107_nd_tier_fn();

    // --- [rb107/tier-decl]: declared exactly once, and the pins are reachable --
    let sig_control = stripped_for_scan(&format!("{}{}{}", rb107_tier_decl_source(), '{', '}'));
    let control_sig = extract_squashed_fn_sig(&sig_control, &needle).unwrap_or_else(|| {
        panic!("[rb107/tier-decl]: the control fixture for the tier seam has no signature.")
    });
    assert_eq!(
        control_sig,
        rb107_tier_sig_pin(),
        "[rb107/tier-decl]: the frozen SIGNATURE pin for the tier seam is UNSATISFIABLE — the live \
         pipeline derives {control_sig:?} from the sanctioned declaration text. Fix the literal \
         from the spec, never the other way round."
    );
    let n = rb22p_count(&squashed, &needle);
    assert_eq!(
        n, 1,
        "[rb107/tier-decl]: privacy.rs must define `{needle}` exactly once; found {n}. ZERO is the \
         intended RED before the implementer lands rb-107; TWO makes every clause scoped to it \
         read whichever definition the extractor reaches first, so the other ships completely \
         ungated."
    );

    // --- [rb107/tier-vis]: PRIVATE, by window, and UNCONDITIONAL --------------
    let window = rb107_vis_window_text(&squashed, &needle);
    assert!(
        !window.contains("pub"),
        "[rb107/tier-vis]: `{needle}` is preceded by a visibility keyword — the \
         {RB85_VIS_WINDOW} squashed bytes before it read {window:?}. The seam is PRIVATE because \
         privacy is the one property a test cannot restore once the compiler stops enforcing it, \
         and because a private seam is what makes the call census in the reducer test a COMPLETE \
         account of who decides a caller's ceiling. The check is a window rather than a list of \
         spellings: an enumerated ban is satisfied by the restricted visibility forms."
    );
    assert!(
        !window.contains("#["),
        "[rb107/tier-vis]: `{needle}` is preceded by an ATTRIBUTE — the {RB85_VIS_WINDOW} squashed \
         bytes before it read {window:?}; ZERO is allowed. A conditional-compilation twin of this \
         seam would ship one tier decision to the test target and another to the wasm the database \
         runs, and every clause in this test reads the arm the test target compiles. The file-wide \
         owner is `rb48_privacy_has_exactly_one_cfg_attribute`; this is its local half."
    );

    // --- [rb107/tier-sig] -----------------------------------------------------
    assert_eq!(
        rb107_blind_count(&rb107_tier_sig_pin()),
        0,
        "[rb107/tier-sig]: the strip pipeline still sees the sanctioned tier signature after it \
         was placed ONLY inside a line comment and inside a string literal, so the pin below would \
         be satisfiable by a doc comment naming the right declaration."
    );
    let sig = extract_squashed_fn_sig(&squashed, &needle)
        .unwrap_or_else(|| panic!("[rb107/tier-sig]: `{needle}` has no opening brace."));
    assert_eq!(
        sig,
        rb107_tier_sig_pin(),
        "[rb107/tier-sig]: the tier seam's signature is not the frozen one. Since rb-132 it takes \
         the ANSWERS to two SSOT questions as plain bools, the account answer FIRST and the \
         wallet answer second, and reaches no context at all — that split is what keeps it \
         executable in the native test host, where the reducer that computes the bools can never \
         run. A `ctx` parameter here would make the value clauses above a LINK failure of the \
         whole lib-test binary rather than a red test, and the parameter ORDER is frozen because \
         two bools compile either way round."
    );

    // --- [rb107/tier-ssot]: the QUESTION the tier asks ------------------------
    //
    // The seam above maps two bools onto three ceilings. What the
    // ACCOUNT bool means lives in another module, and nothing in this crate
    // pinned it before rb-107 (the wallet bool's twin clause is rb-132's): patching
    // `is_account_holder` to `true` deletes the anonymous tier for every caller
    // — and opens the pvp guards that share the same predicate — while every
    // value clause here, both source pins, the whole reducer test and the full
    // suite stay green. A tier is only as true as its question.
    //
    // NARROW BY CONSTRUCTION. This clause pins that predicate's BODY and the
    // fact that privacy.rs asks it exactly once. WHY that predicate and not
    // `has_jwt()` is ADR-0189 D2 (the host mints its own token, so `has_jwt()`
    // is true for every connection; only a verified allowed-issuer/audience
    // token ever produces an `account` row), and it is CITED rather than
    // re-derived — accounts.rs owns that decision and its own tests own the rest
    // of that module.
    let accounts = stripped_for_scan(RB107_ACCOUNTS_RS);
    let holder_fn = rb107_nd_holder_fn();
    let n_holder = rb22p_count(&accounts, &holder_fn);
    assert_eq!(
        n_holder, 1,
        "[rb107/tier-ssot]: accounts.rs must define `{holder_fn}` exactly once; found {n_holder}. \
         ZERO means the crate SSOT for `does this identity hold a verified account row` is gone \
         and rb-107's pre-gate is asking something else; TWO makes the body pin below read \
         whichever definition the extractor reaches first."
    );
    let holder_control = stripped_for_scan(&format!(
        "{}{}{}{}",
        rb107_holder_decl_source(),
        '{',
        rb107_holder_body_source(),
        '}'
    ));
    let holder_control_body = extract_squashed_fn_body(&holder_control, &holder_fn)
        .expect("[rb107/tier-ssot]: the control fixture has no body");
    assert_eq!(
        holder_control_body,
        rb107_holder_body_pin(),
        "[rb107/tier-ssot]: the frozen BODY pin for the account-holder SSOT is UNSATISFIABLE — the \
         live pipeline derives {holder_control_body:?} from the sanctioned body text. Revise the \
         literal FROM ACCOUNTS.RS AND ADR-0189 D2, never to match whatever the code happens to say."
    );
    assert_eq!(
        rb107_blind_count(&rb107_holder_body_pin()),
        0,
        "[rb107/tier-ssot]: the strip pipeline still sees the sanctioned predicate body after it \
         was placed ONLY inside a line comment and inside a string literal."
    );
    let holder_body = extract_squashed_fn_body(&accounts, &holder_fn)
        .unwrap_or_else(|| panic!("[rb107/tier-ssot]: `{holder_fn}` has no brace-balanced body."));
    assert_eq!(
        holder_body,
        rb107_holder_body_pin(),
        "[rb107/tier-ssot]: the account-holder SSOT's body must be EXACTLY the unique-index point \
         read on the account table (ADR-0189 D2). MEASURED: with the body replaced by `true` the \
         anonymous tier is deleted for every caller — every JWT-less identity is handed the \
         account holders' ceiling — and the whole crate stays green, because NOTHING pinned this \
         body before rb-107 and every clause in this test reasons about the MAPPING rather than \
         the QUESTION. `has_jwt()` is not an acceptable substitute either: the host mints its own \
         token, so it is true for every connection, which is exactly why ADR-0189 makes the \
         account-row lookup the predicate. rb-107 pins a body it does not own because its tier \
         rests on it; accounts.rs owns the decision, and this clause only makes the decision \
         load-bearing visible."
    );
    let holder_named = "is_account_holder(";
    let n_asked = rb22p_count(&squashed, holder_named);
    assert_eq!(
        n_asked, 1,
        "[rb107/tier-ssot]: privacy.rs must ask `{holder_named}` EXACTLY once; found {n_asked}. \
         ONE, because there is ONE cap binding and both gates read it: a second ask is a second \
         place where a caller's tier is decided, and it is invisible to the cap-binding census if \
         it is spelled inline rather than bound. ZERO means the pre-gate stopped asking — which is \
         what an inlined `ctx.db.account()` lookup would look like, and that shape forks the SSOT \
         this crate's own doctrine forbids forking."
    );

    // --- [rb107/tier-body] LAST: the equality backstop ------------------------
    let body_control = stripped_for_scan(&format!(
        "{}{}{}{}",
        rb107_tier_decl_source(),
        '{',
        rb107_tier_body_source(),
        '}'
    ));
    let control_body = extract_squashed_fn_body(&body_control, &needle)
        .expect("[rb107/tier-body]: the control fixture has no body");
    assert_eq!(
        control_body,
        rb107_tier_body_pin(),
        "[rb107/tier-body]: the frozen BODY pin for the tier seam is UNSATISFIABLE — the live \
         pipeline derives {control_body:?} from the sanctioned body text. Revise the literal FROM \
         THE SPEC, never to match whatever the code happens to say."
    );
    assert_eq!(
        rb107_blind_count(&rb107_tier_body_pin()),
        0,
        "[rb107/tier-body]: the strip pipeline still sees the sanctioned tier body after it was \
         placed ONLY inside a line comment and inside a string literal, so this pin would be \
         satisfiable by a doc comment naming the right conditional."
    );
    let body = extract_squashed_fn_body(&squashed, &needle)
        .unwrap_or_else(|| panic!("[rb107/tier-body]: `{needle}` has no brace-balanced body."));
    assert_eq!(
        body,
        rb107_tier_body_pin(),
        "[rb107/tier-body]: the tier seam's body must be EXACTLY the three-armed selection rb-132 \
         froze — the account bit tested first, then the wallet bit — naming all THREE ceilings \
         and nothing else. Equality rather than containment, for the reason this module has \
         MEASURED three times on strictly simpler bodies: a correct body wrapped in a dead \
         conditional, a shadowed binding, or an appended statement are all clippy-clean and green \
         against every containment clause. This one literal closes a fourth arm that cannot \
         exist, a literal ceiling inlined in place of any constant, the two bits tested in the \
         other order, and any prefix statement at once."
    );
}

// ===========================================================================
// rb-109 (dated ADR-0238 + ADR-0222 amendments; closes residual R-rb-85-X9) —
// THE EXECUTION PROOF FOR THE BOUNDED TTL READ, RUN AGAINST THE NATIVE HOST.
//
// EARS E1 (gates/rb-109.gates.md), PARAPHRASED — the frozen spec text predates the
// rb-110 rename: WHEN an oversized synthetic export_bundle population (many owners x
// at least seventeen chunks x large payload_json) is seeded into the in-memory native
// host and one reaper tick executes THE SYSTEM SHALL complete without abort, materialise
// no more than EXPORT_REAP_MAX_READ_PER_TICK rows, and delete exactly the expired ones.
//
// WHAT CHANGED, AND WHY THIS BLOCK CAN EXIST AT ALL. Every rb-85, rb-86 and
// rb-87 clause about this helper is a SOURCE pin, because the range-scan syscall
// was undefined in native_host_tests.rs: a Rust test that called the helper did
// not red, it failed the LINK of the whole lib-test binary. rb-109 models that
// syscall and the index-point delete, so the SHIPPED helper now runs over REAL
// rows here. The eight tests below are VALUE oracles over that run — counts the
// tick reports and the exact (owner, stamp, chunk id) set the store is left
// holding — and they are the first behavioural evidence this reaper has ever
// had. The scheduled REDUCER around the helper is still unreachable
// (ctx.database_identity() is unstubbed, and the metadata row-count syscall the
// rb-107 gates reach is not modelled), so nothing here names it.
//
// THE HOST IS A MODEL, AND SAYS SO. Ascending yield in key order is an
// expectation about a btree-backed datastore, not an observation of one
// (residual R-rb-109-ORDERMODEL). What the tests below prove is that the
// MODULE's arithmetic — the read cap, the stamp cap, whole-bundle deletes and
// the tail beyond the window — is right against a host that keeps that
// contract, and that the module does not silently depend on anything else: test
// 6 pins the host model itself against every bound kind, negative keys and a
// same-stamp tie, so a host that quietly stopped sorting reds there as well as
// in the survivor sets.
//
// ONE CALL SITE. `rb109_tick` is the only place in this file that names the
// private helper, which is what lets the pre-authorised revision of
// `rb85_helper_is_never_named_outside_privacy_rs` pin the count at exactly one
// (paren-bearing and paren-less alike).
//
// THE HOST LOCK IS NOT REENTRANT. A `ctx.db` range iterator that is still alive
// holds no lock between syscalls, but the design rule
// is that no method that reads or moves the STORE — seed, remove, rows — may be
// called while one is in scope: the iterator was handed its rows when it opened.
// `open_iters` reads the iterator COUNT, not the store, and is the one fixture
// call a test may make while a scan is live — that is how the two-iterator test
// proves the fixture can see an OPEN iterator, not only an absent one. Every
// other test COLLECTS first and asserts afterwards. A range spelled with both
// bounds unbounded ABORTS the process by design (it is the banned full sweep
// wearing a range), so every host-side oracle here spells an explicit low..=high
// covering its own seeded stamps.
//
// DISCLOSED LIMITS, measured and not closed here. (a) A range-argued delete in
// place of the point delete (`delete(..=stamp)`, the cross-bundle wipe privacy.rs
// names) is INDISTINGUISHABLE to every value oracle below: the tick issues its
// deletes oldest-first and every stamp below a planned one is itself planned, so
// the argument pin in rb85_helper_body_exact is what owns that shape. (b) For the
// same reason a point delete whose relation is at-or-below rather than equal
// reaps the same rows here. (c) `read` is the module's OWN count of what it
// decoded; what makes it credible is the host-unbounded clause (the scan offers
// 340) beside the frozen body pin, not the count alone. (d) A cfg attribute above
// a test attribute disables the test while every text census stays green; only
// the ledger's filtered run count (E1) and the suite total (X2) see that.
// ===========================================================================

// The generated accessor TRAIT for the export chunk table, imported for the
// host-side oracles alone: the accessor is a trait method on the database
// handle, so without this import the direct reads in the criterion test, the
// zero-tick positive control and the two host-model tests do not resolve.
//
// WHY THIS IS NOT A RATCHET BREAK. The crate-wide accessor ownership ratchet
// walks every file under src/ and skips privacy_tests.rs by name, one clause
// before it counts accessor calls, paths and brace-list imports — so this import
// is outside what that census measures, and it is recorded here as the reviewed
// event rather than discovered later in a diff. The narrow reason it is safe:
// this file is cfg(test)-gated, so nothing here reaches production, and the
// table it names is the one the owning module already owns. A trait is all that
// is imported: the row type arrives through its own path and the generated table
// HANDLE type, which is a constructible ZST and therefore the real bypass, is
// never named in this file at all.
use crate::schema::export_bundle;

// --- the population fixtures and the ONE call site ---------------------------

/// THE ONLY PLACE this file names the private bounded-read helper, and the
/// reason the second clause of `rb85_helper_is_never_named_outside_privacy_rs`
/// counts ONE since rb-109 rather than zero.
///
/// Returns the tick record as a bare tuple, so the private record type is never
/// named here: `(read, planned, reaped, due)` — the rows the bounded window
/// decoded, the creation stamps the bundle seam planned, the datastore's own count
/// of the rows the point deletes removed, and (since rb-115) the
/// distinct expired stamps the window held BEFORE the stamp cap. The third can
/// EXCEED the first: a stamp selected from inside the window carries its tail
/// beyond the window's edge.
///
/// `due` is LAST, not in the record's data-flow order, and that is append-only
/// on purpose: the drain test reads `.0`, `.1` and `.2` by position, and a
/// mid-tuple insert would compile and silently re-point the third of them. The
/// rb-87 fixture constructor takes RECORD order instead, `(read, due, planned,
/// reaped)`; the two orders differ deliberately. The stamp-cap test below binds
/// the new count to `_` because this block's label roster is closed — rb-115's
/// native-host test asserts it on that identical population.
fn rb109_tick(ctx: &spacetimedb::ReducerContext, now: i64) -> (usize, usize, usize, usize) {
    let tick = crate::privacy::reap_expired_export_bundles(ctx, now);
    (tick.read, tick.planned, tick.reaped, tick.due)
}

/// A distinct owner identity per seeded bundle.
///
/// The byte is never zero: the all-zero identity is the dummy sender the native
/// host hands every context, so a fixture sharing it with the caller would make
/// an owner-scoped defect invisible. The reaper is owner-BLIND by design — it
/// selects on the creation stamp alone — which is exactly why the survivor
/// oracles below carry the owner in the triple.
fn rb109_owner(byte: u8) -> spacetimedb::Identity {
    spacetimedb::Identity::from_byte_array([byte; 32])
}

/// `len` bytes of chunk payload filler.
fn rb109_filler(len: usize) -> String {
    "p".repeat(len)
}

/// The chunk id of chunk `k` of the bundle seeded at index `i`.
///
/// Globally unique across a population, and NEVER zero: zero is the auto_inc
/// sentinel the real insert path writes, and this fixture seeds rows directly
/// into the store, below the write-back the host does not model.
fn rb109_chunk_id(i: usize, k: u32) -> u64 {
    1 + 1000 * (i as u64) + u64::from(k)
}

/// One export chunk row.
///
/// `table_name` is empty and `request_id` is a placeholder cast of the stamp
/// (the reducer writes a real table name and a positive request id; neither
/// field is read by anything under test). The payload SIZE is, because it is
/// what drives the host iterator to refill.
fn rb109_row(
    owner: u8,
    stamp: i64,
    chunk_id: u64,
    index: u32,
    total: u32,
    payload: usize,
) -> crate::schema::ExportBundle {
    crate::schema::ExportBundle {
        chunk_id,
        owner_identity: rb109_owner(owner),
        request_id: stamp as u64,
        table_name: String::new(),
        chunk_index: index,
        total_chunks: total,
        payload_json: rb109_filler(payload),
        created_at_ms: stamp,
    }
}

/// Register the export chunk table with the native host, keyed on the creation
/// stamp — the single-column btree index the reaper reads and deletes through.
///
/// The two names are the only strings this block hands the host. The index
/// name itself is DERIVED inside the fixture from these two, never passed in.
fn rb109_table(
    fx: &crate::native_host_tests::Fixture,
) -> crate::native_host_tests::Handle<'_, crate::schema::ExportBundle, i64> {
    fx.table_keyed("export_bundle", "created_at_ms", |r| r.created_at_ms)
}

/// Seed one whole population: every bundle in LIST order, `chunks` rows each, so
/// the host's store order IS the list order and nothing sorts it on the way in.
fn rb109_seed_population(
    t: &crate::native_host_tests::Handle<'_, crate::schema::ExportBundle, i64>,
    bundles: &[(u8, i64)],
    chunks: u32,
    payload: usize,
) {
    for (i, (owner, stamp)) in bundles.iter().enumerate() {
        for k in 0..chunks {
            let row = rb109_row(*owner, *stamp, rb109_chunk_id(i, k), k, chunks, payload);
            t.seed(&row);
        }
    }
}

/// The INTERLEAVED bundle population — one `(owner byte, creation stamp)` entry
/// per bundle, in the order it will be seeded.
///
/// THE INTERLEAVE IS LOAD-BEARING (rb-109 plan red team, F1). If the store order
/// were ascending, a host that never sorted would hand the module a correct
/// window by accident and every count below would pass over a broken read; if it
/// were descending, the same is true of a host that sorted backwards. So the
/// expired stamps alternate NEWEST/OLDEST and a live bundle is spliced in at
/// every fourth slot, which makes neither direction a prefix of the sorted
/// order. `rb109/seed-order` asserts that property from the LIVE store rather
/// than trusting this construction.
///
/// Expired stamps are `cutoff - step*i`, so entry zero sits EXACTLY ON the
/// cutoff (expired: the rule is at-or-below); live stamps are `cutoff + 1 +
/// step*j`, so entry zero is the closest possible survivor.
fn rb109_bundles(cutoff: i64, expired: usize, live: usize, step: i64) -> Vec<(u8, i64)> {
    let mut queue: Vec<i64> = Vec::new();
    let mut lo = 0usize;
    let mut hi = expired;
    while lo < hi {
        queue.push(cutoff - step * lo as i64);
        lo += 1;
        if lo < hi {
            hi -= 1;
            queue.push(cutoff - step * hi as i64);
        }
    }
    let live_stamps: Vec<i64> = (0..live).map(|j| cutoff + 1 + step * j as i64).collect();
    let mut out: Vec<(u8, i64)> = Vec::new();
    let mut ei = 0usize;
    let mut li = 0usize;
    for i in 0..(expired + live) {
        let stamp = if (i % 4 == 0 && li < live_stamps.len()) || ei >= queue.len() {
            li += 1;
            live_stamps[li - 1]
        } else {
            ei += 1;
            queue[ei - 1]
        };
        let owner = u8::try_from(i + 1).expect("rb109: a population fits in one owner byte");
        out.push((owner, stamp));
    }
    out
}

/// The `(owner, stamp, chunk id)` triples the population SHOULD still hold once
/// every bundle stamped strictly below `min_stamp` has been reaped WHOLE.
///
/// Sorted by `(stamp, chunk id)` — a total order here, because chunk ids are
/// unique across a population — so the comparison is over SETS and not over the
/// order the store happens to return. The owner rides along rather than being
/// dropped: chunk ids are unique per population today, so it adds no
/// discrimination now — it is what keeps a future id collision from hiding a
/// wrong-OWNER delete behind equal counts.
fn rb109_expected_triples(
    bundles: &[(u8, i64)],
    chunks: u32,
    min_stamp: i64,
) -> Vec<(spacetimedb::Identity, i64, u64)> {
    let mut out: Vec<(spacetimedb::Identity, i64, u64)> = Vec::new();
    for (i, (owner, stamp)) in bundles.iter().enumerate() {
        if *stamp < min_stamp {
            continue;
        }
        for k in 0..chunks {
            out.push((rb109_owner(*owner), *stamp, rb109_chunk_id(i, k)));
        }
    }
    out.sort_unstable_by_key(|(_, stamp, chunk)| (*stamp, *chunk));
    out
}

/// The same triples READ BACK from the live host store, in the same order.
fn rb109_observed_triples(
    t: &crate::native_host_tests::Handle<'_, crate::schema::ExportBundle, i64>,
) -> Vec<(spacetimedb::Identity, i64, u64)> {
    let mut out: Vec<(spacetimedb::Identity, i64, u64)> = t
        .rows()
        .into_iter()
        .map(|r| (r.owner_identity, r.created_at_ms, r.chunk_id))
        .collect();
    out.sort_unstable_by_key(|(_, stamp, chunk)| (*stamp, *chunk));
    out
}

/// Every creation stamp in the host's STORE order — the order the rows were
/// seeded in, never a sorted view.
fn rb109_store_stamps(
    t: &crate::native_host_tests::Handle<'_, crate::schema::ExportBundle, i64>,
) -> Vec<i64> {
    t.rows().into_iter().map(|r| r.created_at_ms).collect()
}

// ===========================================================================
// THE EXECUTION PROOF — eight value oracles over the SHIPPED helper.
// ===========================================================================

/// E1 (ledger gates/rb-109.gates.md), THE CRITERION ITSELF: one tick over an
/// oversized population completes without abort, READS at most the row cap,
/// PLANS at most the stamp cap, and deletes the OLDEST expired bundles WHOLE —
/// their tails beyond the read window included.
///
/// Twenty-six owners, seventeen chunks each (one per exportable table: the
/// smallest bundle the export reducer can write), 8 KiB of payload per chunk.
/// Twenty of the bundles are expired — entry zero sitting EXACTLY on the cutoff
/// — and six are live, the first of them one millisecond above it.
///
/// THE ARITHMETIC, derived from the spec and not from the code: 340 expired
/// rows are visible to the range, the read cap takes the 256 oldest of them
/// (fifteen whole bundles plus one row of the sixteenth), the bundle seam plans
/// the sixteen DISTINCT stamps that window touches, and each is deleted whole —
/// 16 x 17 = 272 rows, sixteen MORE than were read, because the sixteenth
/// stamp's tail lies past the window's edge. What is left is every live row and
/// the four NEWEST expired bundles.
///
/// WHY THE SURVIVOR SET IS COMPARED AND NOT COUNTED. A host that yielded rows in
/// seed order rather than ascending order leaves four DIFFERENT expired bundles
/// — with this interleave, the four stamped cutoff-8000 down to cutoff-11000 —
/// instead of the four newest: identical counts, disjoint sets, and every
/// numeric clause in this test still green. The triple carries the owner so a
/// future id collision could not hide a wrong-owner delete behind equal counts.
///
/// `read` is the MODULE's own count of what it decoded; what makes it credible is
/// the host-unbounded clause (the scan offers 340) beside the frozen body pin.
///
/// Kills: M1 the rb-48 full-table sweep restored (the host has no table scan and
/// aborts the process); M2 the read cap dropped (read 340); M4 the host's sort
/// removed (the survivor set, and the seed-order clause that proves the fixture
/// could see it); M10 a host that caps its own scan at 256 (the unbounded
/// clause below reads 340 through the same index); a point delete that stopped
/// at the window edge (reaped 256 rather than 272). Deliberately NOT killed
/// here: M8, the stamp truncation dropped — this window holds exactly sixteen
/// stamps, so planned is 16 either way; the stamp-cap test owns that mutant.
#[test]
fn rb109_oversized_tick_is_bounded_and_reaps_the_oldest_bundles_whole() {
    let now: i64 = 1_760_000_000_000;
    let cutoff = now - crate::privacy::EXPORT_BUNDLE_TTL_MS;
    let bundles = rb109_bundles(cutoff, 20, 6, 1_000);

    let fx = crate::native_host_tests::fixture();
    let t = rb109_table(&fx);
    let ctx = fx.ctx();
    rb109_seed_population(&t, &bundles, 17, 8_192);

    // --- rb109/seed-order: the store is NOT already in the sorted order ------
    let store = rb109_store_stamps(&t);
    assert_eq!(
        store.len(),
        442,
        "[rb109/seed-order]: the host holds {} row(s); twenty-six bundles of seventeen chunks is \
         442. Every clause below reads this population, so a fixture that seeded a different one \
         would make all of them true about nothing.",
        store.len()
    );
    let expired_in_store: Vec<i64> = store.iter().copied().filter(|s| *s <= cutoff).collect();
    let mut head: Vec<i64> = expired_in_store[..256].to_vec();
    head.sort_unstable();
    let mut smallest: Vec<i64> = expired_in_store.clone();
    smallest.sort_unstable();
    smallest.truncate(256);
    assert_ne!(
        head, smallest,
        "[rb109/seed-order]: the first 256 EXPIRED stamps in STORE order are the same multiset as \
         the 256 SMALLEST expired stamps, so this fixture cannot tell a host that sorts from one \
         that simply hands back the rows in the order they were seeded — and the whole point of \
         the survivor clause below is that it can. The live rows are filtered out first: they \
         never enter the window, so their position in the store proves nothing. Re-interleave."
    );

    // --- rb109/host-unbounded: the host does not cap its OWN scan ------------
    let oldest = *store
        .iter()
        .min()
        .expect("rb109: the population is not empty");
    let visible = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter(oldest..=cutoff)
        .count();
    assert_eq!(
        visible, 340,
        "[rb109/host-unbounded]: the same btree range the reaper reads yields {visible} row(s) \
         through the host; twenty expired bundles of seventeen chunks is 340. A host that \
         truncated its own scan at the module's read cap would DISARM the cap clause below — the \
         module could drop its own `take` and still report 256 — so the read bound has to be \
         proved to be the MODULE's, over a scan that hands back more than it."
    );

    // --- ONE tick ------------------------------------------------------------
    let (read, planned, reaped, _) = rb109_tick(&ctx, now);

    assert_eq!(
        read,
        crate::privacy::EXPORT_REAP_MAX_READ_PER_TICK,
        "[rb109/read-cap]: the tick decoded {read} row(s); the per-tick READ window is {}. With \
         340 rows expired and visible, a tick that reads them all has no bound on the payload \
         bytes it materialises under the global write lock, which is the cost this whole slice \
         family exists to bound.",
        crate::privacy::EXPORT_REAP_MAX_READ_PER_TICK
    );
    assert_eq!(
        read, 256,
        "[rb109/read-cap]: the shipped read cap is no longer 256 — this population was sized \
         against it (340 visible rows, so the cap BINDS and the window straddles a bundle). \
         Re-derive the numbers in this test from the spec before touching anything else."
    );
    assert_eq!(
        planned,
        crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK,
        "[rb109/planned-cap]: the tick planned {planned} creation stamp(s); the per-tick WRITE \
         bound is {}. The 256-row window in ascending stamp order holds fifteen whole bundles and \
         one straddler, so sixteen DISTINCT stamps is both what the window touches and what the \
         cap allows — a number ABOVE this is a write set nobody budgeted.",
        crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK
    );
    assert_eq!(
        planned, 16,
        "[rb109/planned-cap]: the shipped stamp cap is no longer 16, which is the number this \
         population was sized against. Re-derive from the spec."
    );
    assert_eq!(
        reaped, 272,
        "[rb109/reaped-whole]: the tick deleted {reaped} row(s); sixteen whole bundles of \
         seventeen chunks is 272. A stamp is deleted WHOLE — every chunk committed in that \
         millisecond, including the sixteen rows of the sixteenth bundle that the 256-row window \
         never read. A tick that deleted only what it read leaves those rows behind and commits a \
         bundle k-of-N, which is the partial-reap defect rb-86 closed."
    );
    assert!(
        reaped > read,
        "[rb109/reaped-whole]: the tick deleted {reaped} row(s) having read {read}. The two \
         numbers being DIFFERENT is the observable consequence of whole-stamp deletes: the tail of \
         the straddling bundle lies beyond the window's edge and goes with it. Equal counts mean \
         the delete stopped at the window, however correct the totals look."
    );

    // --- rb109/survivors: exactly the live rows and the four NEWEST expired --
    let observed = rb109_observed_triples(&t);
    let expected = rb109_expected_triples(&bundles, 17, cutoff - 3_000);
    assert_eq!(
        expected.len(),
        170,
        "[rb109/survivors]: the ORACLE itself describes {} row(s); it must describe 170 — the 102 live rows plus the 68 rows of the four newest expired bundles. A wrong \
         minimum-stamp literal turns this oracle into a different, still self-consistent claim.",
        expected.len()
    );
    let missing: Vec<&(spacetimedb::Identity, i64, u64)> = expected
        .iter()
        .filter(|e| !observed.contains(e))
        .take(3)
        .collect();
    let extra: Vec<&(spacetimedb::Identity, i64, u64)> = observed
        .iter()
        .filter(|o| !expected.contains(o))
        .take(3)
        .collect();
    assert_eq!(
        observed,
        expected,
        "[rb109/survivors]: the store holds {} row(s) and should hold {} — every one of the 102 \
         live rows plus the 68 rows of the four NEWEST expired bundles. First rows wrongly GONE: \
         {missing:?}. First rows wrongly STILL THERE: {extra:?}. A host that yielded rows in seed \
         order instead of ascending key order leaves four DIFFERENT expired bundles — with this \
         interleave, the four stamped cutoff-8000 down to cutoff-11000: the same 170 rows by \
         count, a disjoint set by identity, and every number above unmoved.",
        observed.len(),
        expected.len()
    );

    // --- rb109/iters-closed: the unfinished scan is handed back --------------
    let open = fx.open_iters();
    assert_eq!(
        open, 0,
        "[rb109/iters-closed]: {open} host iterator(s) are still open after the tick. The module \
         takes 256 rows from a scan of 340 and then DROPS it, so the iterator is abandoned \
         unfinished and the bindings must close it; a leak here is a real datastore resource the \
         hourly tick would strand once an hour, forever."
    );
}

/// E1 (the `delete exactly the expired ones` half): one tick over a population
/// that fits INSIDE both caps deletes every expired row and not one live row —
/// including the bundle stamped EXACTLY on the cutoff.
///
/// Five expired bundles of seventeen chunks (85 rows, entry zero sitting on the
/// cutoff itself) and three live ones (51 rows, the first one millisecond above
/// it). Both caps are slack here on purpose: this test is about the BOUNDARY,
/// not about the bounds, so every expired row is read, every stamp is planned
/// and every expired row is deleted — `(85, 5, 85, 5)`.
///
/// Kills: M3 the range narrowed to strictly-below the cutoff, which reports
/// `(68, 4, 68, 4)` and strands a bundle that the retention ceiling says must go —
/// the cutoff is the NEWEST stamp a chunk may carry and still be expired; M6 a
/// point delete that ignores its key (the live rows disappear); M5 a point
/// delete that reports zero (reaped 0 while the rows are gone, or the rows still
/// there); an off-by-one in the other direction, which takes the `cutoff + 1`
/// bundle with it.
#[test]
fn rb109_tick_deletes_exactly_the_expired_set_including_the_cutoff_stamp() {
    let now: i64 = 1_760_000_000_000;
    let cutoff = now - crate::privacy::EXPORT_BUNDLE_TTL_MS;
    let bundles = rb109_bundles(cutoff, 5, 3, 1_000);

    let fx = crate::native_host_tests::fixture();
    let t = rb109_table(&fx);
    let ctx = fx.ctx();
    rb109_seed_population(&t, &bundles, 17, 64);

    let seeded = rb109_store_stamps(&t).len();
    assert_eq!(
        seeded, 136,
        "[rb109/expired-exact]: the host holds {seeded} row(s); eight bundles of seventeen chunks \
         is 136. The tuple below is sized against that population."
    );
    let at_cutoff = bundles.iter().filter(|(_, s)| *s == cutoff).count();
    let just_above = bundles.iter().filter(|(_, s)| *s == cutoff + 1).count();
    assert_eq!(
        (at_cutoff, just_above),
        (1usize, 1usize),
        "[rb109/expired-exact]: the fixture must carry exactly one bundle ON the cutoff and one \
         exactly one millisecond above it; it carries {at_cutoff} and {just_above}. Those two are \
         the only bundles that separate an inclusive bound from an exclusive one, so without both \
         this test is about nothing in particular."
    );

    let tick = rb109_tick(&ctx, now);
    assert_eq!(
        tick,
        (85usize, 5, 85, 5),
        "[rb109/expired-exact]: the tick reported (read, planned, reaped, due) = {tick:?}; five \
         expired bundles of seventeen chunks is (85, 5, 85, 5) — five distinct stamps in the \
         window, all five under the cap. A range spelled strictly BELOW the cutoff reports \
         (68, 4, 68, 4) — it silently stops expiring the bundle that turned seven days old \
         exactly on this tick, and the next tick has the same argument about it."
    );

    let observed = rb109_observed_triples(&t);
    let expected = rb109_expected_triples(&bundles, 17, cutoff + 1);
    assert_eq!(
        expected.len(),
        51,
        "[rb109/cutoff-included]: the ORACLE itself describes {} row(s); it must describe 51 — the 51 rows of the three live bundles. A wrong \
         minimum-stamp literal turns this oracle into a different, still self-consistent claim.",
        expected.len()
    );
    let left_expired = observed.iter().filter(|(_, s, _)| *s <= cutoff).count();
    assert_eq!(
        left_expired, 0,
        "[rb109/cutoff-included]: {left_expired} row(s) at or below the cutoff survived the tick. \
         The cutoff is inclusive: a chunk whose age has REACHED the retention ceiling is expired, \
         and one left behind is personal data held past the seven days the spec promises."
    );
    let boundary = observed.iter().filter(|(_, s, _)| *s == cutoff + 1).count();
    assert_eq!(
        boundary, 17,
        "[rb109/cutoff-included]: the bundle stamped one millisecond ABOVE the cutoff has \
         {boundary} of its seventeen chunks left. Deleting it is the opposite failure and the \
         worse one: a live export destroyed under a caller who is still assembling it."
    );
    assert_eq!(
        observed,
        expected,
        "[rb109/cutoff-included]: the store holds {} row(s) and should hold the 51 rows of the \
         three live bundles, exactly. A point delete that ignored its key wipes the table; one \
         keyed on a different COLUMN removes nothing (an eight-byte stamp point equals no owner \
         or chunk-id key) and reds above. What no fixture here can separate is a delete whose \
         relation is at-or-below rather than equal: the plan is oldest-first by construction.",
        observed.len()
    );
}

/// E1 (`complete without abort`, across ticks): repeated ticks DRAIN an
/// oversized backlog down to the live set and then report a zero tick, every one
/// of them inside both caps and leaking no iterator.
///
/// The same 442-row population as the criterion test. The drain is the property
/// a per-tick bound has to buy: a cap that never finishes is a retention
/// ceiling that is never enforced. Three ticks — `(256, 16, 272, 16)`, then
/// `(68, 4, 68, 4)`, then `(0, 0, 0, 0)` — and the sequence is pinned as a whole,
/// because a tick that made NO progress would loop here forever and a tick that
/// suddenly made all of it would mean the caps stopped binding.
///
/// The loop has a hard cap of ten iterations with its own labelled failure: a
/// non-progressing tick must fail LOUDLY rather than hang a CI runner.
///
/// Kills: M5 a point delete that reports zero (the FIRST tuple, through the
/// sequence clause — the loop stops on the first zero); a delete that reports a
/// count it did not perform (the loop runs its ten iterations and the cap
/// clause says so by name); a tick whose delete set is
/// smaller than its plan (four ticks instead of three); any per-tick bound
/// removed (the first tuple); an iterator leaked once per tick, which a
/// single-tick test cannot distinguish from a fixture artefact.
#[test]
fn rb109_repeated_ticks_drain_to_the_live_set() {
    let now: i64 = 1_760_000_000_000;
    let cutoff = now - crate::privacy::EXPORT_BUNDLE_TTL_MS;
    let bundles = rb109_bundles(cutoff, 20, 6, 1_000);

    let fx = crate::native_host_tests::fixture();
    let t = rb109_table(&fx);
    let ctx = fx.ctx();
    rb109_seed_population(&t, &bundles, 17, 8_192);

    let mut ticks: Vec<(usize, usize, usize, usize)> = Vec::new();
    let mut drained = false;
    for _ in 0..10 {
        let tick = rb109_tick(&ctx, now);
        ticks.push(tick);
        let open = fx.open_iters();
        assert_eq!(
            open,
            0,
            "[rb109/drain-bounds]: tick {} left {open} host iterator(s) open. Once an hour, \
             forever, is what an hourly reaper does with a leak.",
            ticks.len()
        );
        assert!(
            tick.0 <= crate::privacy::EXPORT_REAP_MAX_READ_PER_TICK
                && tick.1 <= crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK,
            "[rb109/drain-bounds]: tick {} reported {tick:?}; every tick must stay inside the \
             read cap of {} rows and the write cap of {} stamps. The caps are per TICK, not per \
             drain: a tick that widens its window because a backlog exists is exactly the \
             unbounded transaction they exist to prevent.",
            ticks.len(),
            crate::privacy::EXPORT_REAP_MAX_READ_PER_TICK,
            crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK
        );
        if tick.2 == 0 {
            drained = true;
            break;
        }
    }
    assert!(
        drained,
        "[rb109/drain-cap]: ten consecutive ticks each still deleted rows from a 442-row \
         population that three ticks must clear. The tick is not making progress — a delete that \
         reports a count it did not perform, or a plan that keeps re-selecting rows it never \
         removes — and a scheduled reducer in that state burns a transaction an hour forever \
         while the store never shrinks. Ticks so far: {ticks:?}"
    );

    assert_eq!(
        ticks,
        [
            (256usize, 16usize, 272usize, 16usize),
            (68, 4, 68, 4),
            (0, 0, 0, 0),
        ],
        "[rb109/drain-sequence]: the drain reported {ticks:?} as (read, planned, reaped, due); \
         the spec's arithmetic gives (256, 16, 272, 16) then (68, 4, 68, 4) then (0, 0, 0, 0). \
         The first tick takes the sixteen oldest stamps whole — its window holds exactly those \
         sixteen, so the pre-cap count equals the plan — the second takes the four that are left \
         — under both caps, so it reads and reaps the same 68 — and the third finds nothing \
         expired. A sequence that is LONGER means a tick retired fewer rows than it read, which \
         is the drain-rate inequality rb-107 sized the write-side admission cap against."
    );

    let observed = rb109_observed_triples(&t);
    let expected = rb109_expected_triples(&bundles, 17, cutoff + 1);
    assert_eq!(
        expected.len(),
        102,
        "[rb109/drain-final]: the ORACLE itself describes {} row(s); it must describe 102 — the 102 rows of the six live bundles. A wrong \
         minimum-stamp literal turns this oracle into a different, still self-consistent claim.",
        expected.len()
    );
    assert_eq!(
        observed,
        expected,
        "[rb109/drain-final]: after the drain the store holds {} row(s); it must hold exactly the \
         102 rows of the six LIVE bundles. The reaper is allowed to be slow; it is never allowed \
         to be hungry.",
        observed.len()
    );
}

/// E1 (the no-op direction): a tick over an EMPTY table and a tick over an
/// all-live table both report `(0, 0, 0, 0)` and change nothing.
///
/// A zero tick is the reaper's normal state — 167 of every 168 of them — so the
/// interesting failure is a zero that means `read nothing` rather than `nothing
/// to read`. The POSITIVE CONTROL is what separates the two: the same index
/// range, read directly through the host, yields all 51 live rows, so `reaped 0`
/// is attributed to the retention rule and not to a scan that found an empty
/// table, an unregistered index or a mis-derived index name.
///
/// Kills: a host that resolves the index to no table at all (the control reads
/// zero and this test reds, where every count clause in the slice would
/// otherwise pass vacuously); a cutoff computed so far in the future that
/// everything is expired (the tuple); a tick that deletes rows it did not plan.
#[test]
fn rb109_zero_expired_and_empty_tables_report_a_zero_tick() {
    let now: i64 = 1_760_000_000_000;
    let cutoff = now - crate::privacy::EXPORT_BUNDLE_TTL_MS;

    let fx = crate::native_host_tests::fixture();
    let t = rb109_table(&fx);
    let ctx = fx.ctx();

    let empty = rb109_tick(&ctx, now);
    assert_eq!(
        empty,
        (0usize, 0, 0, 0),
        "[rb109/zero-tick]: a tick over an EMPTY table reported {empty:?}. Nothing read, nothing \
         planned, nothing reaped and nothing due is the only honest answer, and a non-zero \
         `reaped` here is a delete issued against a plan that was never made."
    );

    let bundles = rb109_bundles(cutoff, 0, 3, 1_000);
    rb109_seed_population(&t, &bundles, 17, 64);
    let before = rb109_observed_triples(&t);
    assert_eq!(
        before.len(),
        51,
        "[rb109/zero-tick]: the all-live fixture holds {} row(s); three bundles of seventeen \
         chunks is 51.",
        before.len()
    );

    let live = rb109_tick(&ctx, now);
    assert_eq!(
        live,
        (0usize, 0, 0, 0),
        "[rb109/zero-tick]: a tick over a table whose every row is LIVE reported {live:?}. The \
         oldest row here is one millisecond younger than the cutoff, so the range must select \
         nothing at all — a tick that reads rows it cannot act on pays the decode cost of the \
         whole live store every hour."
    );

    let after = rb109_observed_triples(&t);
    let expected = rb109_expected_triples(&bundles, 17, i64::MIN);
    assert_eq!(
        expected.len(),
        51,
        "[rb109/zero-survivors]: the ORACLE itself describes {} row(s); it must describe 51 — every one of the 51 all-live rows. A wrong \
         minimum-stamp literal turns this oracle into a different, still self-consistent claim.",
        expected.len()
    );
    assert_eq!(
        after, before,
        "[rb109/zero-survivors]: the zero tick CHANGED the store. A tick that reports no deletions \
         and performs some is the worst shape this record can take: the observation line the \
         reducer emits would say the reaper did nothing on the hour it destroyed a live export."
    );
    assert_eq!(
        after,
        expected,
        "[rb109/zero-survivors]: the store holds {} row(s) and must hold all 51 seeded rows, \
         unchanged and identical to the fixture. Compared against the FIXTURE rather than against \
         the pre-tick read, so a store that was already wrong before the tick cannot satisfy this \
         clause by staying wrong.",
        after.len()
    );

    let readable = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter((cutoff + 1)..=(cutoff + 2_001))
        .count();
    assert_eq!(
        readable, 51,
        "[rb109/zero-readable]: reading the live band straight through the host yields {readable} \
         row(s); all 51 are in it. THIS IS THE POSITIVE CONTROL for every zero above: without it, \
         a host that resolved this index to no table — a mis-derived index name, a registration \
         that never happened — would report `(0, 0, 0, 0)` for the most encouraging of wrong \
         reasons, and so would every other count clause in this slice."
    );
}

/// E1 has no write clause; this is the value oracle for the STAMP cap
/// (`EXPORT_REAP_MAX_STAMPS_PER_TICK`): when the read window holds MORE distinct
/// stamps than the stamp cap allows, the cap BINDS — sixteen stamps are planned
/// out of twenty available, and only those sixteen bundles are deleted.
///
/// THE CRITERION TEST CANNOT BE THIS ORACLE: there the window holds exactly
/// sixteen stamps, so dropping the truncation entirely leaves every number in
/// that test unmoved. Here the bundles are
/// THIRTEEN chunks each, so the 256-row window covers nineteen whole bundles and
/// nine rows of a twentieth — twenty distinct stamps — and the cap has to
/// discard four of them.
///
/// Sixteen stamps of thirteen rows is 208 reaped from 256 read, which is the
/// other side of the criterion test's inequality: `reaped` can exceed `read`
/// when the window straddles a bundle, and it falls SHORT of it when the window
/// holds more bundles than the write cap allows. Both are correct; only the
/// pair proves the two bounds are independent.
///
/// This test is BLIND to a host that does not sort: the window holds all twenty
/// stamps either way and the plan sorts them itself, so the survivor set here is
/// identical under a seed-order host. T1 and T6 own that mutant.
///
/// Kills: M8 the stamp truncation dropped (planned 20, reaped 260 — the whole
/// backlog retired in one transaction, which is the unbounded write the cap
/// exists to prevent); a truncation applied BEFORE the distinct-ing (the first
/// sixteen window rows are barely two bundles); a stamp cap read from the ROW
/// cap constant (planned 20 again, since only twenty stamps exist).
#[test]
fn rb109_stamp_cap_binds_when_the_window_holds_more_than_sixteen_stamps() {
    let now: i64 = 1_760_000_000_000;
    let cutoff = now - crate::privacy::EXPORT_BUNDLE_TTL_MS;
    let bundles = rb109_bundles(cutoff, 20, 2, 1_000);

    let fx = crate::native_host_tests::fixture();
    let t = rb109_table(&fx);
    let ctx = fx.ctx();
    rb109_seed_population(&t, &bundles, 13, 64);

    let seeded = rb109_store_stamps(&t).len();
    assert_eq!(
        seeded, 286,
        "[rb109/stamp-cap]: the host holds {seeded} row(s); twenty-two bundles of THIRTEEN chunks \
         is 286, of which 260 are expired. The chunk count is what makes the window straddle a \
         twentieth stamp, so a fixture with a different one proves something else."
    );

    // The fourth count, `due`, is discarded here on purpose: this block's label
    // roster is closed, and rb-115's own native-host test asserts it (twenty) on
    // this identical population as its capped tick.
    let (read, planned, reaped, _) = rb109_tick(&ctx, now);
    assert_eq!(
        (read, planned),
        (256usize, 16usize),
        "[rb109/stamp-cap]: the tick read {read} row(s) and planned {planned} stamp(s); the \
         256-row window over 260 expired rows covers nineteen whole thirteen-chunk bundles plus \
         nine rows of a twentieth — TWENTY distinct stamps — and the write cap allows sixteen. \
         `planned == 20` is the truncation dropped: every expired bundle in the store retired in \
         one transaction."
    );
    assert_eq!(
        reaped, 208,
        "[rb109/stamp-cap-reaped]: the tick deleted {reaped} row(s); sixteen whole bundles of \
         thirteen chunks is 208. Fewer rows reaped than READ is the correct shape here and the \
         mirror image of the criterion test: there the window straddled one bundle and the tail \
         pushed `reaped` above `read`; here the window holds more bundles than the write cap \
         allows and four of them are left for the next tick. 260 means the cap did not bind."
    );

    let observed = rb109_observed_triples(&t);
    let expected = rb109_expected_triples(&bundles, 13, cutoff - 3_000);
    assert_eq!(
        expected.len(),
        78,
        "[rb109/stamp-cap-survivors]: the ORACLE itself describes {} row(s); it must describe 78 — the 26 live rows plus the 52 rows of the four newest expired bundles. A wrong \
         minimum-stamp literal turns this oracle into a different, still self-consistent claim.",
        expected.len()
    );
    assert_eq!(
        observed,
        expected,
        "[rb109/stamp-cap-survivors]: the store holds {} row(s) and must hold 78 — the 26 live \
         rows plus the 52 rows of the four NEWEST expired bundles, whole. WHICH four survive is \
         the fairness claim: the cap discards the youngest stamps in the window, so the oldest \
         personal data always leaves first and no bundle is ever left part-deleted.",
        observed.len()
    );
}

/// THE HOST MODEL'S OWN CONTROL: the modelled range scan
/// honours every bound kind on each side, orders by DECODED value across
/// negative keys, and keeps equal keys in seed order.
///
/// Everything above this test reasons about what the MODULE does against a host
/// that keeps the btree contract. This test is about the host, and it is not
/// decoration: a model that quietly got any of this wrong would make the five
/// tests above agree with it, in the same wrong direction, in silence.
///
/// NEGATIVE KEYS ARE THE POINT. BSATN encodes an i64 little-endian two's
/// complement, so a host that compared key BYTES sorts -1 above every positive
/// stamp and -5000 between 0 and 1. Every stamp the reaper sees in production is
/// positive, which is exactly why this has to be tested HERE rather than
/// discovered later by the first caller with a clock skew.
///
/// THE EXCLUDED START is its own case: a bound parser that maps every tag onto
/// the inclusive variant is correct for three of the six spellings below and
/// wrong for the tuple form, which is the only way to spell an exclusive lower
/// bound at all.
///
/// THE SAME-STAMP PAIR pins the MODEL's tie order: the host sorts stably, so
/// two chunks of one bundle come back in the order they were seeded. Tie order
/// is NO datastore contract — a real btree may hand same-stamp rows back in any
/// order and no production code may depend on it — and at eight rows this pair
/// does not distinguish a stable sort from an unstable one (both are insertion
/// sorts at this size; measured as register row M4b). What it pins is that the
/// model is deterministic and that a reader can predict it.
///
/// Kills: M9 a comparator over raw BSATN bytes (every negative-key list);
/// M7 an end bound ignored (the two half-open lists); M11 an excluded start
/// parsed as included (the tuple list); a sort dropped entirely (the covering
/// list, which is also what the survivor
/// clauses above depend on).
#[test]
fn rb109_host_range_model_honours_every_bound_kind_negative_keys_and_ties() {
    let fx = crate::native_host_tests::fixture();
    let t = rb109_table(&fx);
    let ctx = fx.ctx();

    // Seeded DESCENDING by stamp, with the 2000 pair in a known order.
    let seeds: [(i64, u64); 8] = [
        (9_000, 106),
        (5_000, 105),
        (2_000, 141),
        (2_000, 142),
        (1, 104),
        (0, 103),
        (-1, 102),
        (-5_000, 101),
    ];
    for (stamp, chunk) in seeds {
        let row = rb109_row(9, stamp, chunk, 0, 1, 8);
        t.seed(&row);
    }

    let store = rb109_store_stamps(&t);
    assert_eq!(
        store,
        [9_000i64, 5_000, 2_000, 2_000, 1, 0, -1, -5_000],
        "[rb109/range-seeded]: the store order is {store:?}; it must be the DESCENDING seed order. \
         If the fixture handed the host its rows already ascending, every ordering clause below \
         would be satisfied by a host that does not order at all."
    );

    // Collect EVERY range first: no fixture or handle method may run while a
    // host iterator is alive.
    let to_incl: Vec<u64> = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter(..=0i64)
        .map(|r| r.chunk_id)
        .collect();
    let to_excl: Vec<u64> = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter(..0i64)
        .map(|r| r.chunk_id)
        .collect();
    let from: Vec<u64> = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter(0i64..)
        .map(|r| r.chunk_id)
        .collect();
    let closed: Vec<u64> = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter((-1i64)..=1i64)
        .map(|r| r.chunk_id)
        .collect();
    let excluded_start: Vec<u64> = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter((
            std::ops::Bound::Excluded(-1i64),
            std::ops::Bound::Included(1i64),
        ))
        .map(|r| r.chunk_id)
        .collect();
    let excluded_open: Vec<u64> = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter((
            std::ops::Bound::Excluded(-5_000i64),
            std::ops::Bound::Unbounded,
        ))
        .map(|r| r.chunk_id)
        .collect();
    let half_open: Vec<u64> = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter((-1i64)..1i64)
        .map(|r| r.chunk_id)
        .collect();
    let covering: Vec<u64> = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter((-5_000i64)..=9_000i64)
        .map(|r| r.chunk_id)
        .collect();

    let cases: [(&str, &Vec<u64>, &[u64]); 7] = [
        (
            "an INCLUSIVE end with no start: every stamp at or below zero, which is where a \
             byte-comparing host puts the two negatives on the wrong side",
            &to_incl,
            &[101, 102, 103],
        ),
        (
            "an EXCLUSIVE end with no start: the same range with the boundary row dropped, which \
             is the difference between the reaper expiring a bundle this tick and next tick",
            &to_excl,
            &[101, 102],
        ),
        (
            "an INCLUSIVE start with no end: everything from zero up, the pair included",
            &from,
            &[103, 104, 141, 142, 105, 106],
        ),
        ("both ends INCLUSIVE across zero", &closed, &[102, 103, 104]),
        (
            "an INCLUSIVE start with an EXCLUSIVE end — the plain a..b Range, the crate's most \
             common spelling elsewhere and the one two-sided combination the cases above miss",
            &half_open,
            &[102, 103],
        ),
        (
            "an EXCLUDED START with an included end — the one spelling no range literal can \
             express, and the case a parser that maps every bound tag onto the inclusive variant \
             gets wrong",
            &excluded_start,
            &[103, 104],
        ),
        (
            "an EXCLUDED START with an UNBOUNDED end: the lowest stamp dropped and everything \
             above it kept",
            &excluded_open,
            &[102, 103, 104, 141, 142, 105, 106],
        ),
    ];
    for (what, got, want) in cases {
        assert_eq!(
            got.as_slice(),
            want,
            "[rb109/bound-kinds]: over {what}, the host yielded chunk ids {got:?}; the model owes \
             {want:?}. The list is compared in ORDER, so this clause also sees a sort that only \
             happens to be right on non-negative keys."
        );
    }

    assert_eq!(
        covering,
        [101u64, 102, 103, 104, 141, 142, 105, 106],
        "[rb109/range-ascending]: the covering range yielded {covering:?}. It must be every \
         seeded row in ASCENDING stamp order — which is the contract the reaper's fairness rests \
         on — with the two chunks that share the stamp 2000 in the order they were SEEDED (141 \
         then 142). Rows in seed order mean the host does not sort at all; the pair reversed means \
         the model's tie order changed — no datastore contract, but a reader of this model must \
         be able to predict it, and nothing in production may depend on tie order at all."
    );
}

/// THE ITERATOR LIFECYCLE: two host iterators can be
/// live at once without aliasing, an abandoned one is CLOSED rather than
/// leaked, and a row larger than the pooled buffer is read back whole.
///
/// TWO ITERATORS, INTERLEAVED. The host mints iterator ids and the bindings hold
/// them across calls; if ids were reused or the row queue were shared, the two
/// sequences below would bleed into each other. They overlap on exactly one row
/// (the stamp-zero row is in both ranges), so a shared queue shows up as a
/// missing row rather than as a coincidence.
///
/// THE ABANDONED ITERATOR IS THE CLOSE PATH. Each row here carries 20 KB of
/// payload (a row is 72 bytes plus its payload; the pooled buffer is 65 536), so
/// only three of the four fit in one fill: the second iterator is carried out of
/// the block still open, SEEN open by the fixture (the one non-zero reading of
/// the iterator count in the slice, which is what makes every zero elsewhere
/// meaningful), then dropped with a row still pending host-side, and the only
/// thing that can remove it is the close syscall. The first iterator is drained
/// to exhaustion instead, which is the other destruction path. This is one of
/// the slice's two close-path proofs; the tick's own abandoned scan is the other.
///
/// THE OVERSIZED ROW drives the reserve-and-retry leg: at 70 KB the row does not
/// fit in the pooled buffer at all, so the host must report the size it needs
/// and the bindings must grow the buffer and ask again. A host that reported
/// zero there would spin forever, which is why this clause exists at all.
///
/// Kills: an iterator id handed out twice; a row queue shared between open
/// iterators; a fixture whose iterator count is a constant zero (the live
/// clause); a close that does not remove the iterator (the leak clause); a
/// buffer-too-small report that loses the row or truncates the payload.
#[test]
fn rb109_host_iterators_close_alias_free_and_refill_on_oversized_rows() {
    let fx = crate::native_host_tests::fixture();
    let t = rb109_table(&fx);
    let ctx = fx.ctx();

    for (stamp, chunk) in [
        (30i64, 307u64),
        (20, 306),
        (10, 305),
        (0, 304),
        (-10, 303),
        (-20, 302),
        (-30, 301),
    ] {
        let row = rb109_row(11, stamp, chunk, 0, 1, 20_000);
        t.seed(&row);
    }

    // Both iterators live at once. NOTHING that reads or moves the STORE may be
    // called inside this block; the second iterator is carried OUT of it, still
    // open, so the fixture can be asked to see it before it is dropped.
    let (low, high, b) = {
        let mut a = ctx.db.export_bundle().created_at_ms().filter(..=0i64);
        let mut b = ctx.db.export_bundle().created_at_ms().filter(0i64..);
        let mut low: Vec<Option<u64>> = Vec::new();
        let mut high: Vec<Option<u64>> = Vec::new();
        for step in 0..5 {
            low.push(a.next().map(|r| r.chunk_id));
            if step < 3 {
                high.push(b.next().map(|r| r.chunk_id));
            }
        }
        (low, high, b)
    };

    assert_eq!(
        low,
        [Some(301u64), Some(302), Some(303), Some(304), None],
        "[rb109/iters-alias]: the first iterator yielded {low:?} while a second one was open over \
         an overlapping range. It owes the four rows at or below zero, ascending, and then \
         exhaustion. A shared or reused iterator id shows up here as a row from the OTHER range."
    );
    assert_eq!(
        high,
        [Some(304u64), Some(305), Some(306)],
        "[rb109/iters-alias]: the second iterator yielded {high:?} while the first was open and \
         being advanced between its own calls. It owes the first three rows from zero upward. The \
         stamp-zero row belongs to BOTH ranges, so a host that handed the two iterators one queue \
         would drop it from one of them."
    );

    // --- rb109/iters-live: the fixture can SEE an open iterator -------------
    let live = fx.open_iters();
    assert_eq!(
        live, 1,
        "[rb109/iters-live]: {live} host iterator(s) are open while the second scan is still \
         alive. Exactly ONE must be: the first was drained to exhaustion (the host removed it on \
         its final advance), the second was handed three of its four 20 KB rows in one 64 KiB \
         buffer fill and has one pending. A fixture that cannot see an OPEN iterator cannot see \
         a leaked one either — every other iterator clause in this slice compares this number to \
         zero, so this is the clause that proves those zeros mean something. ZERO here means \
         either the host never registered the scan, or the buffer arithmetic changed and the \
         second scan drained in one fill, in which case the close path below is no longer \
         exercised by this test at all."
    );
    drop(b);

    let open = fx.open_iters();
    assert_eq!(
        open, 0,
        "[rb109/iters-drained]: {open} host iterator(s) survived the drop above. One was drained \
         to exhaustion and the other was DROPPED with a row still pending — one open before the \
         drop, none after, so this clause is one of the slice's two proofs of the close syscall \
         (the other is the tick's own abandoned 340-row scan). A row is 72 bytes plus its payload \
         and the pooled buffer is 65 536 bytes, so 20 KB payloads put three of four rows in one \
         fill; if that payload ever shrinks, the second scan drains in one fill and the clause \
         above reds first. A close that does not remove the iterator leaks one per abandoned \
         scan, and the reaper abandons one every hour by construction."
    );

    let big = rb109_row(12, 1_000, 308, 0, 1, 70_000);
    t.seed(&big);
    let refilled: Vec<(u64, usize)> = ctx
        .db
        .export_bundle()
        .created_at_ms()
        .filter(900i64..=1_100i64)
        .map(|r| (r.chunk_id, r.payload_json.len()))
        .collect();
    assert_eq!(
        refilled,
        [(308u64, 70_000usize)],
        "[rb109/iters-refill]: reading back a row whose payload is larger than the whole pooled \
         iterator buffer yielded {refilled:?}; it owes exactly one row of 70 000 payload bytes. \
         This is the buffer-too-small leg: the host must report the size the next row needs so \
         the bindings can grow the buffer and ask again. A host that reported ZERO there spins \
         forever, and one that reported a truncated size loses payload bytes out of an export \
         chunk a caller is about to assemble."
    );
    let open_after = fx.open_iters();
    assert_eq!(
        open_after, 0,
        "[rb109/iters-refill]: {open_after} host iterator(s) are open after the oversized read. \
         The retry path allocates a second buffer and must still hand the iterator back."
    );
}

// --- the behavioural seam, reached exactly ONCE from this file --------------

/// THE ONLY PLACE this file names the private creation-stamp mint.
///
/// The rb109_tick idiom, and for the same reason: the helper is PRIVATE, this
/// module is its only test-side reader, and a second spelling anywhere in the
/// file would make the naming census a statement about nothing. Every
/// behavioural clause below goes through this wrapper.
fn rb111_mint(ctx: &spacetimedb::ReducerContext, now: i64) -> Result<i64, String> {
    crate::privacy::mint_export_stamp(ctx, now)
}

/// Register the export chunk table with the native host, keyed on the creation
/// stamp — the single-column btree the mint probes and the reaper deletes
/// through.
///
/// Re-spelled rather than shared with the rb-109 fixture: that block's helper
/// roster is CLOSED and its tests are a different slice's evidence. The index
/// name itself is DERIVED inside the fixture from the two names, never passed in.
fn rb111_table(
    fx: &crate::native_host_tests::Fixture,
) -> crate::native_host_tests::Handle<'_, crate::schema::ExportBundle, i64> {
    fx.table_keyed("export_bundle", "created_at_ms", |r| r.created_at_ms)
}

/// A distinct owner identity per seeded bundle.
///
/// The byte is never zero: the all-zero identity is the dummy sender the native
/// host hands every context, so a fixture sharing it with the caller would make
/// an owner-scoped defect invisible.
fn rb111_owner(byte: u8) -> spacetimedb::Identity {
    spacetimedb::Identity::from_byte_array([byte; 32])
}

/// One export chunk row.
///
/// `table_name` is empty and `request_id` mirrors the stamp exactly as the
/// shipped write site does; neither field is read by anything under test. The
/// payload SIZE is, because it is what drives the host iterator to refill.
fn rb111_row(
    owner: u8,
    stamp: i64,
    chunk_id: u64,
    index: u32,
    total: u32,
    payload: usize,
) -> crate::schema::ExportBundle {
    crate::schema::ExportBundle {
        chunk_id,
        owner_identity: rb111_owner(owner),
        request_id: stamp as u64,
        table_name: String::new(),
        chunk_index: index,
        total_chunks: total,
        payload_json: "p".repeat(payload),
        created_at_ms: stamp,
    }
}

/// Seed ONE whole bundle: `chunks` rows at `stamp` under owner byte `owner`.
///
/// Chunk ids are derived from the bundle's position `i`, so they are globally
/// unique across a population and NEVER zero — zero is the auto_inc sentinel
/// the real insert path writes, and this fixture seeds rows straight into the
/// store, below the write-back the host does not model.
fn rb111_seed(
    t: &crate::native_host_tests::Handle<'_, crate::schema::ExportBundle, i64>,
    i: usize,
    owner: u8,
    stamp: i64,
    chunks: u32,
    payload: usize,
) {
    for k in 0..chunks {
        let chunk_id = 1 + 1000 * (i as u64) + u64::from(k);
        t.seed(&rb111_row(owner, stamp, chunk_id, k, chunks, payload));
    }
}

/// Every `(owner, stamp, chunk id)` triple in the live store, sorted.
///
/// Sorted by `(stamp, chunk id)` — a total order, because chunk ids are unique
/// across a population — so comparisons are over SETS and not over the order
/// the store happens to return. The owner rides along so a future id collision
/// could not hide a wrong-owner delete behind equal counts.
fn rb111_triples(
    t: &crate::native_host_tests::Handle<'_, crate::schema::ExportBundle, i64>,
) -> Vec<(spacetimedb::Identity, i64, u64)> {
    let mut out: Vec<(spacetimedb::Identity, i64, u64)> = t
        .rows()
        .into_iter()
        .map(|r| (r.owner_identity, r.created_at_ms, r.chunk_id))
        .collect();
    out.sort_unstable_by_key(|(_, stamp, chunk)| (*stamp, *chunk));
    out
}

/// THE ORACLE, written from the SPEC and never read off the production source:
/// the first millisecond at or after `now`, within a window of `width`, that no
/// stamp in `occupied` carries — or `None` when the whole window is taken.
///
/// The arithmetic is SATURATING because the spec says so: the release and test
/// profiles both enable overflow checks, so a plain `+` would PANIC at the
/// ceiling instead of clamping, and the clock-at-`i64::MAX` rows are what tell
/// the two apart behaviourally.
fn rb111_expected_free(occupied: &[i64], now: i64, width: i64) -> Option<i64> {
    for offset in 0..width {
        let candidate = now.saturating_add(offset);
        if !occupied.contains(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// T1, THE VALUE ORACLE: the creation-stamp mint returns the FIRST
/// FREE millisecond at or after the injected clock, and refuses when the whole
/// probe window is occupied — EXECUTED against the native host over real rows.
///
/// Nine cases, each over its own freshly wiped fixture. Five of them separate
/// shapes a narrower table cannot: the gap case kills a mint that resumes after
/// the last OCCUPIED stamp rather than at the clock; the only-now+1 case kills
/// a mint that always skips; the last-free-slot case kills a window read off
/// `W - 1`; and the two clock-at-the-ceiling rows are the only ones that tell
/// `saturating_add` from `+` BEHAVIOURALLY — under this workspace's overflow
/// checks a plain `+` panics there rather than clamping.
///
/// Each row's expectation is cross-checked against `rb111_expected_free`, the
/// rule written from the spec, before the shipped helper is called at all: the
/// table is a list of hand-picked cases and the oracle is the rule, so a
/// disagreement means one of the two was fitted to the code.
///
/// THE INDEX CLAUSE AND A PER-PROCESS CAVEAT. `Fixture::requested_indexes()`
/// reports the names the GENERATED code asked the host about since the fixture
/// was created, and `table_keyed` registers without asking — so the list is the
/// probe's own reach and nothing else. The generated accessor memoises the
/// index id per PROCESS, so only the first fixture in a process records the
/// lookup; the runner is `cargo nextest`, one process per test, which is why
/// the clause asserts `at least one` rather than `one per case` and pairs it
/// with a per-case POSITIVE CONTROL that reads the seeded stamp straight
/// through the same index. Without that control a host resolving this index to
/// no table at all would read as an empty store and hand back the clock every
/// time, and every value row above would agree with it.
///
/// Kills: the status-quo body `Ok(now_ms)` (rows 2, 3, 6, 7); a no-Err fallback
/// (row 7); a probe over `1..W` or `0..=W` (rows 1 and 7); a probe that scans
/// downward or stops at the first occupied slot (rows 4, 5); a `+` in place of
/// the saturating add (row 9, where the second candidate overflows and the
/// reducer PANICS instead of refusing); a probe on the owner index or on a
/// table nobody registered (the index clause and its control); a leaked scan,
/// which an hourly-scale caller would strand (the iterator clause); a mint that
/// DELETES the squatter rather than stepping over it (the read-only clause).
#[test]
fn rb111_mint_returns_the_first_free_stamp_at_or_after_the_clock() {
    let w = crate::privacy::EXPORT_STAMP_PROBE_WINDOW_MS;
    let now: i64 = 1_760_000_000_000;
    let reason = "export_reject_stamp_contention";
    let index = "export_bundle_created_at_ms_idx_btree";

    assert!(
        w >= 2,
        "[rb111/mint-table]: the shipped probe window is {w} millisecond(s). Below two there is \
         no gap case, no last-free-slot case and no difference between `refuse` and `the clock \
         was taken`, so every row below would be about nothing in particular."
    );
    let full: Vec<i64> = (0..w).map(|o| now + o).collect();
    let almost: Vec<i64> = (0..w - 1).map(|o| now + o).collect();
    let cases: [(&str, i64, Vec<i64>, Option<i64>); 9] = [
        (
            "an EMPTY store — the common case, which must not drift off the clock",
            now,
            Vec::new(),
            Some(now),
        ),
        ("the clock itself occupied", now, vec![now], Some(now + 1)),
        (
            "the clock and the next millisecond occupied",
            now,
            vec![now, now + 1],
            Some(now + 2),
        ),
        (
            "a GAP at now+1, with now and now+2 taken",
            now,
            vec![now, now + 2],
            Some(now + 1),
        ),
        (
            "only now+1 occupied — the clock itself is still free",
            now,
            vec![now + 1],
            Some(now),
        ),
        (
            "the first W-1 consecutive occupied — the window's LAST free slot",
            now,
            almost,
            Some(now + w - 1),
        ),
        ("the WHOLE window occupied", now, full, None),
        (
            "the clock at the i64 ceiling over an empty store",
            i64::MAX,
            Vec::new(),
            Some(i64::MAX),
        ),
        (
            "the clock at the i64 ceiling with that one stamp occupied",
            i64::MAX,
            vec![i64::MAX],
            None,
        ),
    ];
    let seeded_cases = cases
        .iter()
        .filter(|(_, _, occ, _)| !occ.is_empty())
        .count();

    let mut index_seen = 0usize;
    let mut foreign: Vec<String> = Vec::new();
    let mut controls = 0usize;
    for (what, clock, occupied, want) in cases {
        let fx = crate::native_host_tests::fixture();
        let t = rb111_table(&fx);
        let ctx = fx.ctx();
        for (i, stamp) in occupied.iter().enumerate() {
            let owner = u8::try_from(i + 1).expect("rb111: a probe fixture fits one owner byte");
            rb111_seed(&t, i, owner, *stamp, 1, 64);
        }
        let before = rb111_triples(&t);
        assert_eq!(
            before.len(),
            occupied.len(),
            "[rb111/mint-table]: over {what} the host holds {} row(s) for {} occupied stamp(s). \
             Every clause in this case reads that population, so a fixture that seeded a \
             different one would make all of them true about nothing.",
            before.len(),
            occupied.len()
        );

        let modelled = rb111_expected_free(&occupied, clock, w);
        assert_eq!(
            modelled, want,
            "[rb111/mint-table]: over {what} the table expects {want:?} while the spec oracle \
             derives {modelled:?}. The two are written INDEPENDENTLY — the table is a list of \
             hand-picked cases, the oracle is the rule T4 samples — so a disagreement means one \
             of them was fitted to the code. Revise the wrong one FROM THE SPEC."
        );

        let got = rb111_mint(&ctx, clock);
        match (&got, want) {
            (Ok(stamp), Some(expected)) => assert_eq!(
                *stamp, expected,
                "[rb111/mint-table]: over {what} the mint returned {stamp}; the spec's first free \
                 millisecond at or after {clock} is {expected}. Occupied: {occupied:?}."
            ),
            (Err(msg), None) => assert_eq!(
                msg.as_str(),
                reason,
                "[rb111/mint-value]: over {what} the mint refused with {msg:?}; the ONE static \
                 reason this family may carry is `{reason}`. Equality, never containment: the \
                 reject string is the wire value a caller sees and the ops vocabulary an alarm \
                 keys on, and a respelling renames it with every count in this module unmoved."
            ),
            _ => panic!(
                "[rb111/mint-table]: over {what} the mint returned {got:?} and the spec says \
                 {want:?} — success where a refusal is required, or a refusal where a free \
                 millisecond exists. Occupied: {occupied:?}; clock {clock}; window {w}."
            ),
        }

        for name in fx.requested_indexes() {
            if name.as_str() == index {
                index_seen += 1;
            } else {
                foreign.push(name);
            }
        }
        let open = fx.open_iters();
        assert_eq!(
            open, 0,
            "[rb111/mint-iters]: over {what} the probe left {open} host iterator(s) open. The \
             mint abandons each point scan after ONE `.next()`, so the bindings must close it; a \
             leak here is a real datastore resource that the module's one write path would \
             strand on every export request, forever."
        );
        let after = rb111_triples(&t);
        assert_eq!(
            after, before,
            "[rb111/mint-readonly]: over {what} the store CHANGED across the probe. The mint is \
             a reader: no insert, no delete, no update. A mint that removed the squatting row \
             instead of stepping over it would satisfy every value row above while destroying a \
             live export belonging to somebody else — and it is spellable, because the delete \
             the reaper uses is on this very index."
        );
        if let Some(stamp) = occupied.first() {
            let visible = ctx
                .db
                .export_bundle()
                .created_at_ms()
                .filter(*stamp)
                .count();
            if visible == 1 {
                controls += 1;
            }
        }
    }

    assert_eq!(
        controls, seeded_cases,
        "[rb111/mint-index]: reading the first seeded stamp straight back through the \
         creation-stamp index found the row in {controls} of the {seeded_cases} cases that seed \
         one. THIS IS THE POSITIVE CONTROL for every value row above: a host that resolved this \
         index to no table — a mis-derived index name, a registration that never happened — \
         reads as an EMPTY store, so the mint would hand back the clock every time and all nine \
         rows above would agree with it for the most encouraging of wrong reasons."
    );
    assert!(
        index_seen >= 1 && foreign.is_empty(),
        "[rb111/mint-index]: the generated code asked the host about the creation-stamp index \
         {index_seen} time(s) and about {} OTHER index name(s): {foreign:?}. At least one reach \
         of `{index}` and no reach of anything else is the contract — a probe on the owner index \
         is a different question with a different answer, and one on a table nobody registered \
         is an empty read. The floor is `at least one` rather than one per case because the \
         generated accessor memoises the index id per PROCESS and every case wipes the fixture; \
         under `cargo nextest` each test owns its process, so the first case records the lookup.",
        foreign.len()
    );
}

/// T2, THE RESIDUAL'S OWN SENTENCE: a burst of requests at ONE
/// millisecond takes W DISTINCT creation stamps, and the next one is refused
/// until the clock moves.
///
/// Sixteen cycles of `mint -> commit a whole minimum-size bundle at the minted
/// stamp under a distinct owner`, all at one fixed clock. That is the residual
/// verbatim — `request_data_export` is cheap for a low-state anonymous identity
/// and the host serialises reducers at millisecond granularity — with the write
/// half modelled by seeding exactly what the reducer's insert loop writes: one
/// chunk per exportable table, every chunk carrying the ONE minted stamp.
///
/// The bundle size is DERIVED from the live lifecycle manifest, never
/// transcribed: `plan_export_chunks` emits one chunk per exportable entry even
/// for an empty table, so that count IS the smallest bundle a request can
/// commit, and if export scope legitimately changes this test follows it in the
/// same diff instead of going quietly false.
///
/// The recovery clause is what makes residual R-rb-111-CONTENTION a LOW: the
/// refusal is retryable, not a latch. Under the status-quo shared stamp the
/// first clause reads ONE distinct stamp for sixteen requests, which is the
/// unbounded delete unit this slice removes.
///
/// Kills: the status-quo body (one distinct stamp, not sixteen); a fallback to
/// the clock when the window is full (the refusal clause, and the row count
/// beside it, which says nothing was written either); a mint that latches the
/// refusal or leaves the window permanently wedged (the recovery clause); a
/// respelled reject string (equality on the payload).
#[test]
fn rb111_a_same_millisecond_burst_takes_distinct_stamps_until_the_window_is_full() {
    let w = crate::privacy::EXPORT_STAMP_PROBE_WINDOW_MS;
    let reason = "export_reject_stamp_contention";
    let now: i64 = 1_760_000_000_000;
    let chunks =
        u32::try_from(m22s4_manifest_exportable().len()).expect("rb111: the manifest fits a u32");
    let burst = usize::try_from(w).expect("rb111: the probe window fits a usize");

    assert!(
        chunks >= 2 && burst >= 2,
        "[rb111/burst-distinct]: the lifecycle manifest reports {chunks} exportable table(s) and \
         the probe window is {burst} millisecond(s). A one-chunk bundle or a one-slot window \
         makes `distinct stamps` and `a whole bundle per stamp` the same statement, and every \
         clause below would pass over a population that cannot express the defect."
    );

    let fx = crate::native_host_tests::fixture();
    let t = rb111_table(&fx);
    let ctx = fx.ctx();

    let mut minted: Vec<i64> = Vec::new();
    for i in 0..burst {
        let owner = u8::try_from(i + 1).expect("rb111: a burst fits one owner byte");
        let stamp = rb111_mint(&ctx, now).unwrap_or_else(|e| {
            panic!(
                "[rb111/burst-distinct]: request {} of a {burst}-request same-millisecond burst \
                 was REFUSED with {e:?}. The window is exactly {burst} milliseconds wide, so the \
                 first {burst} requests at one clock must all be served.",
                i + 1
            )
        });
        rb111_seed(&t, i, owner, stamp, chunks, 64);
        minted.push(stamp);
    }

    let mut distinct = minted.clone();
    distinct.sort_unstable();
    distinct.dedup();
    let expected: Vec<i64> = (0..w).map(|o| now + o).collect();
    assert_eq!(
        minted,
        expected,
        "[rb111/burst-distinct]: {burst} requests at the SAME clock took the stamps {minted:?} \
         ({} of them distinct); they must take {burst} DISTINCT consecutive stamps starting at \
         the clock. ONE distinct stamp is the status quo this slice removes: every one of those \
         bundles then shares a creation stamp, the TTL reaper deletes that stamp WHOLE, and the \
         per-tick write bound of sixteen stamps is sixteen times however many bundles a burst \
         put under each — soft-bounded in the attacker's direction (residual R-rb-86-SAMEMS).",
        distinct.len()
    );

    let refused = rb111_mint(&ctx, now);
    match &refused {
        Err(msg) => assert_eq!(
            msg.as_str(),
            reason,
            "[rb111/burst-refused]: the request past the full window refused with {msg:?}; the \
             one static reason is `{reason}`."
        ),
        Ok(stamp) => panic!(
            "[rb111/burst-refused]: request {} at the same clock SUCCEEDED with stamp {stamp} \
             over a window that is already full. Falling back on an occupied stamp restores the \
             unbounded delete unit one request at a time, in exactly the burst case that matters.",
            burst + 1
        ),
    }
    let rows = rb111_triples(&t).len();
    assert_eq!(
        rows,
        burst * chunks as usize,
        "[rb111/burst-refused]: the store holds {rows} row(s); {burst} bundles of {chunks} \
         chunks is {}. The refusal must write NOTHING — a mint that committed a chunk before \
         deciding would leave a k-of-N bundle behind a reject.",
        burst * chunks as usize
    );

    let recovered = rb111_mint(&ctx, now + w);
    assert_eq!(
        recovered,
        Ok(now + w),
        "[rb111/burst-recovers]: once the clock advances past the occupied window the mint must \
         serve again, at the first millisecond of the new window; it returned {recovered:?}. \
         This is what makes the refusal RETRYABLE rather than a latch, and it is the whole \
         reason residual R-rb-111-CONTENTION is rated LOW: a caller who is told the window is \
         busy gets served on the next millisecond, having written nothing and paid no cooldown."
    );
}

/// T3, THE CRITERION END TO END: eighteen bundles committed through
/// the mint at one clock, then ONE reaper tick — sixteen WHOLE BUNDLES leave,
/// not one delete unit.
///
/// THE POPULATION IS MINTED, NEVER HAND-SEEDED, and that is the difference
/// between this test and `rb109_oversized_tick_...`. A hand-seeded population
/// of eighteen distinct stamps would make the tick's arithmetic true under the
/// status quo as well, so this test would be a re-run of rb-109's with a new
/// name. Every stamp here comes out of the shipped helper, through the RETRY
/// loop a real caller would run: eighteen bundles cannot fit one clock (the
/// window is sixteen wide), so the seventeenth request is refused, the clock
/// advances by a window, and two more are served. On the fixed tree that yields
/// eighteen CONSECUTIVE stamps; under the status-quo body no refusal ever
/// fires, the clock never advances, and all eighteen bundles land on ONE stamp
/// — which the population clause below reports BEFORE the tick runs at all.
///
/// THE ARITHMETIC, derived from the shipped constants and never transcribed:
/// eighteen minimum-size bundles are 306 rows, so the 256-row read window
/// BINDS; that window in ascending stamp order covers fifteen whole bundles and
/// one row of the sixteenth, so it touches sixteen DISTINCT stamps, which is
/// also the write cap; each is deleted whole, tail beyond the window included,
/// so 16 x 17 = 272 rows go and the two newest bundles survive intact. Under
/// the status-quo shared stamp the same tick plans ONE stamp and reaps all 306
/// rows in one transaction — the unbounded delete unit, and the abort-loop
/// hazard that silently retains expired personal data past the seven-day
/// ceiling.
///
/// The tick is driven through `rb109_tick`, the file's ONE naming of the
/// private reaper helper: a second spelling here would red
/// `rb85_helper_is_never_named_outside_privacy_rs`, which pins that count at
/// one, and that census is exactly what keeps the sanctioned trigger single.
///
/// Kills: the status-quo body (the population clause, before the tick); a mint
/// that reuses a live stamp under any spelling (same clause); a tick that
/// stopped at the window's edge (reaped 256 rather than 272); the stamp cap
/// dropped (planned 18, reaped 306); the read cap dropped (read 306); a
/// survivor set of the right SIZE but the wrong IDENTITY, which every count
/// clause here is blind to (the triple comparison); numbers moved to match the
/// code rather than re-derived (the constants pin).
#[test]
fn rb111_one_tick_reaps_sixteen_whole_bundles_from_a_same_millisecond_burst() {
    let w = crate::privacy::EXPORT_STAMP_PROBE_WINDOW_MS;
    let read_cap = crate::privacy::EXPORT_REAP_MAX_READ_PER_TICK;
    let stamp_cap = crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK;
    let chunks =
        u32::try_from(m22s4_manifest_exportable().len()).expect("rb111: the manifest fits a u32");
    let min_bundle = chunks as usize;
    let window = usize::try_from(w).expect("rb111: the probe window fits a usize");
    let bundles = window + 2;
    let now0: i64 = 1_760_000_000_000;

    // The shipped constants this population was SIZED against. A value that
    // moves makes every number below a different, still self-consistent claim,
    // so it is re-derived from the spec rather than quietly followed.
    assert_eq!(
        (read_cap, stamp_cap, min_bundle, window),
        (256usize, 16usize, 17usize, 16usize),
        "[rb111/bound-attribution]: the shipped read cap, stamp cap, minimum bundle and probe \
         window read ({read_cap}, {stamp_cap}, {min_bundle}, {window}); this population was \
         sized against (256, 16, 17, 16) — 18 bundles of 17 chunks is 306 rows, which makes the \
         256-row read window BIND and leaves the window touching exactly 16 distinct stamps. \
         Re-derive every number in this test from the spec before touching anything else."
    );

    let fx = crate::native_host_tests::fixture();
    let t = rb111_table(&fx);
    let ctx = fx.ctx();

    // The RETRY loop a real caller runs: 18 bundles cannot fit one 16 ms
    // window, so the refusal is part of the population's construction. The
    // attempt cap is a CI guard, not a tooth: a mint that refused everything
    // would otherwise advance the clock forever.
    let mut clock = now0;
    let mut stamps: Vec<i64> = Vec::new();
    for i in 0..bundles {
        let owner = u8::try_from(i + 1).expect("rb111: a population fits one owner byte");
        let mut tries = 0usize;
        let stamp = loop {
            tries += 1;
            assert!(
                tries <= bundles + 4,
                "[rb111/bound-population-minted]: bundle {i} was refused {tries} times in a row \
                 while the clock advanced {} ms past the start. A mint that refuses every window \
                 never terminates this loop, so it fails LOUD here instead of hanging a runner.",
                clock - now0
            );
            match rb111_mint(&ctx, clock) {
                Ok(stamp) => break stamp,
                Err(_) => clock = clock.saturating_add(w),
            }
        };
        rb111_seed(&t, i, owner, stamp, chunks, 1_024);
        stamps.push(stamp);
    }

    let mut sorted = stamps.clone();
    sorted.sort_unstable();
    let mut uniq = sorted.clone();
    uniq.dedup();
    let expected_stamps: Vec<i64> = (0..bundles as i64).map(|o| now0 + o).collect();
    let seeded = rb111_triples(&t).len();
    assert_eq!(
        sorted,
        expected_stamps,
        "[rb111/bound-population-minted]: {bundles} bundles minted at one clock (with the retry \
         the full window forces) carry the stamps {stamps:?}, sorted {sorted:?}, {} of them \
         DISTINCT; they must be the {bundles} consecutive milliseconds from the clock. THIS \
         CLAUSE RUNS BEFORE THE TICK ON PURPOSE: under the status-quo shared stamp every mint \
         returns the clock, no refusal ever advances it, and all {bundles} bundles land on ONE \
         stamp — so the tick below would be reaping one delete unit and this test would \
         otherwise report it as a tick arithmetic failure instead of as the residual itself. It \
         is also what stops a hand-seeded population turning this test into a re-run of the \
         rb-109 oversized-tick oracle, which is GREEN under the status quo.",
        uniq.len()
    );
    assert_eq!(
        seeded,
        bundles * min_bundle,
        "[rb111/bound-population-minted]: the host holds {seeded} row(s); {bundles} bundles of \
         {min_bundle} chunks is {}. Every clause below reads this population.",
        bundles * min_bundle
    );
    assert!(
        seeded > read_cap,
        "[rb111/bound-read]: the population is {seeded} row(s) and the per-tick read window is \
         {read_cap}; the population must EXCEED it or the cap never binds and the tick below \
         proves nothing about a bound."
    );

    let newest = *sorted.last().expect("rb111: the population is not empty");
    let tick_now = newest.saturating_add(crate::privacy::EXPORT_BUNDLE_TTL_MS);
    let (read, planned, reaped, _) = rb109_tick(&ctx, tick_now);

    assert_eq!(
        read, read_cap,
        "[rb111/bound-read]: the tick decoded {read} row(s); the per-tick READ window is \
         {read_cap}. With {seeded} rows expired and visible, a tick that reads them all has no \
         bound on the payload bytes it materialises under the global write lock."
    );
    assert_eq!(
        planned, stamp_cap,
        "[rb111/bound-planned]: the tick planned {planned} creation stamp(s); the per-tick WRITE \
         bound is {stamp_cap}. ONE is the status quo — a single shared stamp under every bundle \
         the burst committed — and it is the number that makes the write set unbounded."
    );
    assert_eq!(
        reaped,
        stamp_cap * min_bundle,
        "[rb111/bound-bundles]: THE RESIDUAL ITSELF. The tick deleted {reaped} row(s); sixteen \
         WHOLE BUNDLES of {min_bundle} chunks is {}. Since rb-111 a creation stamp is exactly \
         one live request, so the reaper's cap of {stamp_cap} stamps per tick is {stamp_cap} \
         BUNDLES; before it, every bundle a same-millisecond burst committed shared one stamp \
         and the same tick retired all {seeded} rows in one transaction — 16 x (bundles per \
         stamp), soft-bounded in the attacker's direction, and an abort loop there silently \
         retains expired personal data past the seven-day ceiling.",
        stamp_cap * min_bundle
    );
    assert!(
        reaped > read && reaped % min_bundle == 0 && reaped / min_bundle == stamp_cap,
        "[rb111/bound-attribution]: the tick read {read} row(s) and deleted {reaped}. The write \
         set must be a WHOLE NUMBER OF BUNDLES — {reaped} is {} bundles of {min_bundle} — and it \
         must EXCEED the read, because the sixteenth stamp's tail lies past the window's edge \
         and goes with it. Equal counts mean the delete stopped at the window; a remainder means \
         a bundle was cut. The product is read off the shipped constants, never transcribed.",
        reaped / min_bundle
    );

    let floor = sorted[stamp_cap];
    let mut expected_survivors: Vec<(spacetimedb::Identity, i64, u64)> = Vec::new();
    for (i, stamp) in stamps.iter().enumerate() {
        if *stamp < floor {
            continue;
        }
        let owner = u8::try_from(i + 1).expect("rb111: a population fits one owner byte");
        for k in 0..chunks {
            expected_survivors.push((
                rb111_owner(owner),
                *stamp,
                1 + 1000 * (i as u64) + u64::from(k),
            ));
        }
    }
    expected_survivors.sort_unstable_by_key(|(_, stamp, chunk)| (*stamp, *chunk));
    assert_eq!(
        expected_survivors.len(),
        (bundles - stamp_cap) * min_bundle,
        "[rb111/bound-survivors]: the ORACLE itself describes {} row(s); it must describe {} — \
         the {} newest bundles of {min_bundle} chunks each. A wrong floor turns this oracle into \
         a different, still self-consistent claim.",
        expected_survivors.len(),
        (bundles - stamp_cap) * min_bundle,
        bundles - stamp_cap
    );
    let observed = rb111_triples(&t);
    assert_eq!(
        observed,
        expected_survivors,
        "[rb111/bound-survivors]: the store holds {} row(s) and must hold the {} rows of the two \
         NEWEST bundles, whole. Compared as a sorted SET of (owner, stamp, chunk id) triples and \
         not as a count: a tick that retired the wrong sixteen bundles leaves the same number of \
         rows behind with a disjoint identity, and every numeric clause above stays green over \
         it. WHICH bundles survive is the fairness claim — the cap discards the youngest stamps \
         in the window, so the oldest personal data always leaves first.",
        observed.len(),
        expected_survivors.len()
    );
}

// ===========================================================================
// T4 IS DECLARED INSIDE A PROPERTY-TEST BLOCK, so its `fn` line is INDENTED and
// so is its test attribute. These two flush-left banners are load-bearing: a
// test span runs from a test's own `fn` line to the next FLUSH-LEFT test
// attribute or flush-left banner, so without the first the span of the test
// above would swallow this whole block and the label census would report a
// carrier list of two for every label in it; without the second, this test's
// span would run on into the next one. `rb111_test_span` finds the indented
// declaration and stops at an indented test attribute as well.
// ===========================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// T4, THE RULE rather than a list of cases: over random
    /// occupancy the minted stamp is the MINIMUM FREE millisecond at or after
    /// the clock, and the mint refuses exactly when the whole window is taken.
    ///
    /// The value table in T1 is nine hand-picked shapes; this samples the rule
    /// itself, which is what kills the off-by-one and first-gap-after-a-run
    /// variants a finite table misses. The oracle is `rb111_expected_free`,
    /// written from the spec and shared with T1's cross-check. HONEST LIMIT:
    /// that oracle is a loop of the same shape as the mint with a slice lookup
    /// in place of the index-point read, so what this property proves is the
    /// PROBE WIRING and the domain edges below; the arithmetic oracle that is
    /// independent of the implementation is T1's hand-picked value table.
    ///
    /// THE DOMAIN IS CHOSEN, not incidental. The four clock bases are zero, a
    /// NEGATIVE instant (clock skew is expressible in an i64 column and BSATN
    /// encodes it little-endian, so a host comparing raw key bytes sorts it
    /// above every positive stamp), a realistic epoch, and the i64 CEILING —
    /// where the saturating add makes several candidates collapse onto one
    /// value. The shift lets the clock sit BELOW every seeded stamp, which is
    /// the expired-but-unreaped case: such a row is still LIVE to the mint and
    /// must count as occupied, conservatively.
    ///
    /// A FRESH FIXTURE PER CASE, acquired INSIDE the case: the host's
    /// serialisation lock is not reentrant, and a fixture held across cases
    /// would carry the previous case's rows into this one.
    #[test]
    fn rb111_minted_stamp_is_the_minimum_free_stamp_over_random_occupancy(
        offsets in prop::collection::vec(0i64..48i64, 0..20usize),
        base in prop_oneof![
            Just(0i64),
            Just(-4_000_000_000i64),
            Just(1_760_000_000_000i64),
            Just(i64::MAX - 40)
        ],
        shift in -3i64..4i64,
    ) {
        let w = crate::privacy::EXPORT_STAMP_PROBE_WINDOW_MS;
        let reason = "export_reject_stamp_contention";
        let now = base.saturating_add(shift);
        let mut occupied: Vec<i64> = offsets.iter().map(|o| base.saturating_add(*o)).collect();
        occupied.sort_unstable();
        occupied.dedup();

        let fx = crate::native_host_tests::fixture();
        let t = rb111_table(&fx);
        let ctx = fx.ctx();
        for (i, stamp) in occupied.iter().enumerate() {
            let owner = u8::try_from(i + 1).expect("rb111: an occupancy row fits one owner byte");
            rb111_seed(&t, i, owner, *stamp, 1, 32);
        }

        let expected = rb111_expected_free(&occupied, now, w);
        let got = rb111_mint(&ctx, now);
        let minted = match &got {
            Ok(stamp) => Some(*stamp),
            Err(_) => None,
        };
        let reason_kept = match &got {
            Ok(_) => true,
            Err(msg) => msg.as_str() == reason,
        };

        if let Some(stamp) = minted {
            prop_assert!(
                !occupied.contains(&stamp),
                "[rb111/prop-free]: the mint returned {}, which a LIVE row already carries. \
                 Clock {}, occupancy {:?}. A stamp handed out twice is the shared delete unit \
                 this slice removes, reached one request at a time.",
                stamp,
                now,
                occupied
            );
        }
        prop_assert_eq!(
            minted,
            expected,
            "[rb111/prop-minimal]: the mint returned {:?}; the first FREE millisecond at or \
             after the clock, within a window of {}, is {:?}. Clock {}, occupancy {:?}. A mint \
             that skips a free slot drifts every bundle's TTL expiry and its owner's next \
             cooldown for no reason; one that resumes after the last OCCUPIED stamp rather than \
             at the clock walks past a gap the window was meant to use.",
            minted,
            w,
            expected,
            now,
            occupied
        );
        prop_assert!(
            minted.is_none() == expected.is_none() && reason_kept,
            "[rb111/prop-err-iff]: the mint {} and the spec says the window is {}. Clock {}, \
             occupancy {:?}, result {:?}. Refusing while a free millisecond exists denies a \
             legitimate export; succeeding over a full window means a fallback onto an occupied \
             stamp, which restores the unbounded delete unit — and the refusal must carry the \
             one static reason, because that string is the wire value and the ops vocabulary.",
            if minted.is_none() { "REFUSED" } else { "succeeded" },
            if expected.is_none() { "FULL" } else { "not full" },
            now,
            occupied,
            got
        );
    }
}

// --- the behavioural seams, each reached exactly ONCE from this file --------

/// THE ONLY PLACE this file names the pure pre-cap stamp count in code.
///
/// The rb86_plan / rb109_tick idiom: the fn is PRIVATE, this module is its only
/// test-side reader, and the naming clause pins this one spelling, paren-bearing
/// and paren-less, so a second call site cannot hide anywhere in the file.
fn rb115_count(rows: &[(u64, i64)], now: i64, ttl: i64) -> usize {
    crate::privacy::count_export_reap_stamps(rows, now, ttl)
}

/// A window of `(chunk_id, created_at_ms)` rows from `(stamp, rows)` pairs, ids
/// assigned in spec order from one, exactly as an auto-inc column would.
fn rb115_rows(spec: &[(i64, usize)]) -> Vec<(u64, i64)> {
    let mut out: Vec<(u64, i64)> = Vec::new();
    let mut id = 1u64;
    for (stamp, rows) in spec {
        for _ in 0..*rows {
            out.push((id, *stamp));
            id += 1;
        }
    }
    out
}

/// THE SPEC RULE, written from the criterion and never read off the seam: how
/// many DISTINCT creation stamps in `rows` the retention rule calls expired at
/// `now` — an age that has REACHED `ttl`, measured with a saturating
/// subtraction — with no cap of any kind.
///
/// A different construction from the seam's (a membership-checked push rather
/// than plan, project, sort and dedup), used ONLY to cross-check the hand-written
/// expectations in the value table: the table is a list of cases and this is
/// the rule, so a disagreement between the two means one was fitted to the code.
fn rb115_expected_due(rows: &[(u64, i64)], now: i64, ttl: i64) -> usize {
    let mut stamps: Vec<i64> = Vec::new();
    for (_, stamp) in rows {
        if now.saturating_sub(*stamp) >= ttl && !stamps.contains(stamp) {
            stamps.push(*stamp);
        }
    }
    stamps.len()
}

/// A uniform population in rb-109's INTERLEAVED seed order — `expired` bundles
/// at and below the cutoff and `live` bundles above it, `chunks` rows each — as
/// `(owner byte, creation stamp, chunks)` entries for the seeder below.
fn rb115_uniform(cutoff: i64, expired: usize, live: usize, chunks: u32) -> Vec<(u8, i64, u32)> {
    rb109_bundles(cutoff, expired, live, 1_000)
        .into_iter()
        .map(|(owner, stamp)| (owner, stamp, chunks))
        .collect()
}

/// Seed a RAGGED population: one `(owner byte, creation stamp, chunks)` entry per
/// bundle, in list order, every row shaped like `rb109_row`.
///
/// Chunk ids come from ONE monotone counter across the whole population, never
/// from the bundle's position: rb-109's position-derived scheme is unique only
/// within one uniform call, and a ragged population is several shapes in one
/// list. Ids start at one because zero is the auto-inc sentinel the real insert
/// path writes, and this fixture seeds straight into the store.
fn rb115_seed(
    t: &crate::native_host_tests::Handle<'_, crate::schema::ExportBundle, i64>,
    population: &[(u8, i64, u32)],
    payload: usize,
) {
    let mut chunk_id = 1u64;
    for (owner, stamp, chunks) in population {
        for k in 0..*chunks {
            t.seed(&rb109_row(*owner, *stamp, chunk_id, k, *chunks, payload));
            chunk_id += 1;
        }
    }
}

/// ONE tick through the SHIPPED helper over a freshly seeded native host: the
/// four counts in `rb109_tick`'s order — `(read, planned, reaped, due)`, `due`
/// LAST — and every creation stamp the store still holds afterwards, sorted.
///
/// The fixture is acquired INSIDE and dropped on return: the host's
/// serialisation lock is NOT reentrant, so two fixtures alive at once deadlock,
/// and a fixture carried between ticks would carry one population's rows into
/// the next. The population check fails loud here rather than letting every
/// count become a statement about a store nobody seeded.
fn rb115_tick_over(
    population: &[(u8, i64, u32)],
    now: i64,
) -> ((usize, usize, usize, usize), Vec<i64>) {
    let want: usize = population.iter().map(|(_, _, c)| *c as usize).sum();
    let fx = crate::native_host_tests::fixture();
    let t = rb109_table(&fx);
    let ctx = fx.ctx();
    rb115_seed(&t, population, 64);
    let seeded = rb109_store_stamps(&t).len();
    assert_eq!(
        seeded, want,
        "rb115 [population]: the host holds {seeded} row(s) for a population of {want}. Every \
         count the tick reports is read over this store, so a fixture that seeded a different one \
         would make each of them a statement about nothing."
    );
    let tick = rb109_tick(&ctx, now);
    let mut survivors = rb109_store_stamps(&t);
    survivors.sort_unstable();
    (tick, survivors)
}

/// T1, THE VALUE ORACLE: the pure count returns the number of
/// DISTINCT expired creation stamps in the window, with NO cap — past the stamp
/// cap, past the read cap, at both i64 extremes and at a TTL the module does
/// not ship.
///
/// Every expectation is written from the spec and cross-checked against
/// `rb115_expected_due`, the rule, BEFORE the shipped fn is called, so a
/// fixture mistake reds as a table disagreement rather than as a missing
/// implementation. The twenty-stamp row is the rb-109 stamp-cap window, 19 x 13
/// rows plus 9 of a twentieth, which the capped plan sizes at sixteen.
///
/// Kills: the status-quo information content, the seam run at the STAMP cap
/// (the twenty-stamp row reads 16); a count that ignores expiry (the all-live
/// row reads 3); `rows.len()` (the all-live row reads 51); a constant zero (the
/// one-bundle row); the READ cap as the count's cap (the 300-row row reads
/// 256); a body that ignores its `ttl_ms` parameter for the shipped constant
/// (the one-minute row reads 0) or for zero (the same row reads 4); a dedup
/// with no sort (the interleaved window reads 256); a plain subtraction in
/// place of the saturating one (the extreme rows PANIC under the workspace
/// overflow checks rather than returning).
#[test]
fn rb115_count_is_the_distinct_expired_stamps_before_the_cap() {
    let now: i64 = 1_760_000_000_000;
    let ttl = crate::privacy::EXPORT_BUNDLE_TTL_MS;
    let cutoff = now - ttl;
    let stamp_cap = crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK;
    let minute: i64 = 60_000;

    let sixteen_spec: Vec<(i64, usize)> = (0..16i64).map(|i| (cutoff - 1_000 * i, 16)).collect();
    let twenty_spec: Vec<(i64, usize)> = (0..20i64)
        .map(|i| (cutoff - 1_000 * i, if i == 0 { 9 } else { 13 }))
        .collect();
    let three_hundred_spec: Vec<(i64, usize)> = (0..300i64).map(|i| (cutoff - i, 1)).collect();
    let sixteen = rb115_rows(&sixteen_spec);
    let twenty = rb115_rows(&twenty_spec);

    // --- the value table, FIRST (clause order is load-bearing) ---------------
    type Case = (&'static str, Vec<(u64, i64)>, i64, i64, usize);
    let cases: [Case; 11] = [
        ("an EMPTY window", Vec::new(), now, ttl, 0),
        (
            "an ALL-LIVE window: three stamps one to three milliseconds above the cutoff, \
             seventeen rows each",
            rb115_rows(&[(cutoff + 1, 17), (cutoff + 2, 17), (cutoff + 3, 17)]),
            now,
            ttl,
            0,
        ),
        (
            "ONE expired bundle of seventeen rows",
            rb115_rows(&[(cutoff - 5_000, 17)]),
            now,
            ttl,
            1,
        ),
        (
            "sixteen expired stamps of sixteen rows — exactly the stamp cap",
            sixteen.clone(),
            now,
            ttl,
            16,
        ),
        (
            "twenty expired stamps, 19 x 13 rows plus 9 — the rb-109 stamp-cap window",
            twenty.clone(),
            now,
            ttl,
            20,
        ),
        (
            "three expired stamps interleaved with two live ones",
            rb115_rows(&[
                (cutoff - 3_000, 4),
                (cutoff + 500, 4),
                (cutoff - 2_000, 4),
                (cutoff + 1, 4),
                (cutoff - 1_000, 4),
            ]),
            now,
            ttl,
            3,
        ),
        (
            "the BOUNDARY: a stamp ON the cutoff counts, one a millisecond above it does not",
            rb115_rows(&[(cutoff, 3), (cutoff + 1, 3)]),
            now,
            ttl,
            1,
        ),
        (
            "three hundred single-row expired stamps — past the READ cap as well",
            rb115_rows(&three_hundred_spec),
            now,
            ttl,
            300,
        ),
        (
            "the clock at the i64 CEILING over a stamp at the i64 FLOOR",
            vec![(1u64, i64::MIN)],
            i64::MAX,
            ttl,
            1,
        ),
        (
            "the clock at the i64 FLOOR over a stamp at the i64 CEILING",
            vec![(1u64, i64::MAX)],
            i64::MIN,
            ttl,
            0,
        ),
        (
            "a NON-shipped TTL of one minute: two stamps at and past it, two short of it",
            rb115_rows(&[
                (now - minute, 2),
                (now - 2 * minute, 3),
                (now - minute + 1, 1),
                (now, 1),
            ]),
            now,
            minute,
            2,
        ),
    ];
    for (what, rows, clock, window_ttl, want) in &cases {
        let modelled = rb115_expected_due(rows, *clock, *window_ttl);
        assert_eq!(
            modelled, *want,
            "[rb115/count-value]: over {what} the table expects {want} while the spec rule \
             derives {modelled}. The two are written INDEPENDENTLY — the table is a list of \
             hand-picked cases, the rule is the criterion — so a disagreement means one of them \
             was fitted to the code. Revise the wrong one FROM THE SPEC."
        );
        let got = rb115_count(rows, *clock, *window_ttl);
        assert_eq!(
            got, *want,
            "[rb115/count-value]: over {what} the pure count returned {got}; the window holds \
             {want} DISTINCT creation stamps the retention rule calls expired at {clock} for a TTL \
             of {window_ttl}, and the count takes NO cap. 16 on the twenty-stamp row is the \
             status-quo information content — the seam run at the STAMP cap, which is `planned` \
             under another name; 256 on the three-hundred row is the READ cap; 0 on the \
             one-minute row is a body that ignores its TTL parameter for the shipped constant."
        );
    }

    // --- the count does not depend on the order the window arrives in --------
    // Row k of every bundle before row k + 1 of any, so no two adjacent rows
    // share a stamp: the shape a dedup that never sorts counts row by row.
    let mut interleaved: Vec<(u64, i64)> = Vec::new();
    for k in 0..13usize {
        for (stamp, rows) in &twenty_spec {
            if k < *rows {
                interleaved.push((0, *stamp));
            }
        }
    }
    for (id, row) in (1u64..).zip(interleaved.iter_mut()) {
        row.0 = id;
    }
    let mut reversed = twenty.clone();
    reversed.reverse();
    let adjacent_distinct = interleaved.windows(2).all(|pair| pair[0].1 != pair[1].1);
    assert!(
        interleaved.len() == twenty.len() && adjacent_distinct,
        "[rb115/count-order]: the interleaved fixture holds {} row(s) against the window's {}, \
         and adjacent rows never sharing a stamp is {adjacent_distinct}. Both must hold, or the \
         order clause below proves nothing about a dedup that never sorts.",
        interleaved.len(),
        twenty.len()
    );
    let n_reversed = rb115_count(&reversed, now, ttl);
    let n_interleaved = rb115_count(&interleaved, now, ttl);
    assert_eq!(
        (n_reversed, n_interleaved),
        (20usize, 20usize),
        "[rb115/count-order]: the twenty-stamp window REVERSED counts {n_reversed} and \
         INTERLEAVED counts {n_interleaved}; both must be 20. The range read arrives in whatever \
         order the host yields — rb-109 MODELS ascending, and the live btree is \
         R-rb-109-ORDERMODEL — so a count that depends on it is a claim about undocumented \
         behaviour. A dedup with no sort counts the interleaved window row by row, 256."
    );

    // --- the count separates what the capped plan cannot ----------------------
    let plans = (
        rb86_plan(&sixteen, now, ttl, stamp_cap).len(),
        rb86_plan(&twenty, now, ttl, stamp_cap).len(),
    );
    let counts = (
        rb115_count(&sixteen, now, ttl),
        rb115_count(&twenty, now, ttl),
    );
    assert_eq!(
        (plans, counts),
        ((16usize, 16usize), (16usize, 20usize)),
        "[rb115/count-vs-plan]: at the shipped stamp cap of {stamp_cap} the capped plan sizes \
         the exactly-sixteen window and the twenty-stamp window at {plans:?} — one number for two \
         different windows, which is the whole of the residual — while the pure count reads them \
         as {counts:?}. The count must tell the two apart: (16, 16) means it is the plan again."
    );
}

/// T2, THE EARS PROOF, EXECUTED: one tick through the SHIPPED
/// helper in the native host reports `due` beside `planned`, and `due` is a
/// number no function of the three old counts can recover.
///
/// FOUR POPULATIONS, each over its own fixture, sized against the shipped
/// constants (the first clause pins them) and derived by hand from the
/// ascending host model rb-109 executes:
///   - A, rb-109's stamp-cap population: twenty expired bundles of thirteen
///     rows and two live. The 256-row window is nineteen whole bundles and nine
///     rows of a twentieth, so it holds TWENTY stamps; the cap plans sixteen,
///     which reap 16 x 13 = 208.
///   - A-prime: sixteen expired bundles of thirteen rows below ONE newest
///     expired bundle of sixty, on the cutoff itself, and two live. The window
///     is 208 rows plus 48 of the sixty-row bundle: SEVENTEEN stamps, the same
///     sixteen planned, the same 208 reaped.
///   - B, rb-109's oversized population: twenty expired bundles of seventeen
///     rows and six live. The window is fifteen whole bundles and one row of a
///     sixteenth: SIXTEEN stamps, all planned, 16 x 17 = 272 reaped.
///   - C, the rb-87 residual's own case: twenty expired bundles of FIVE rows and
///     none live. The range runs out at 100 rows holding twenty stamps; sixteen
///     are planned and 80 rows reaped.
///
/// A and A-prime are the literal proof: byte-identical `(read, planned,
/// reaped)`, (256, 16, 208), with `due` 20 against 17. B is the honest
/// disclosure: a full window whose every stamp was planned still leaves four
/// expired bundles past its edge, and `due` cannot see them. C is why `read`
/// below the window is no drain proof without `due`.
///
/// Kills: `due` bound AFTER the truncation, taken from the plan, from the
/// window length or hard-coded (A reads 16, 16, 256 or 0); the count run at the
/// STAMP cap, the status-quo information content (A reads 16); the binding
/// handed the cutoff as its instant (A reads 0); and any tick arithmetic
/// regression the rb-109 oracles also own.
#[test]
fn rb115_one_tick_reports_due_beside_planned_on_capped_and_exact_windows() {
    let now: i64 = 1_760_000_000_000;
    let cutoff = now - crate::privacy::EXPORT_BUNDLE_TTL_MS;
    let read_cap = crate::privacy::EXPORT_REAP_MAX_READ_PER_TICK;
    let stamp_cap = crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK;
    let min_bundle = m22s4_manifest_exportable().len();

    assert_eq!(
        (read_cap, stamp_cap, min_bundle),
        (256usize, 16usize, 17usize),
        "[rb115/tick-sizing]: the shipped read cap, stamp cap and minimum bundle read \
         ({read_cap}, {stamp_cap}, {min_bundle}); the four populations below were sized against \
         (256, 16, 17) — thirteen- and five-row bundles are SHORT stamps against a seventeen-row \
         minimum, which is what lets the cap bind at all on an ascending read. A value that moves \
         makes every tuple below a different, still self-consistent claim: re-derive each one \
         from the spec before touching anything else."
    );

    let pop_a = rb115_uniform(cutoff, 20, 2, 13);
    let mut pop_a_prime: Vec<(u8, i64, u32)> = vec![(1, cutoff, 60)];
    for (owner, stamp) in rb109_bundles(cutoff - 1_000, 16, 0, 1_000) {
        pop_a_prime.push((owner + 1, stamp, 13));
    }
    pop_a_prime.push((18, cutoff + 1, 13));
    pop_a_prime.push((19, cutoff + 1_001, 13));
    let pop_b = rb115_uniform(cutoff, 20, 6, 17);
    let pop_c = rb115_uniform(cutoff, 20, 0, 5);

    let (a, _) = rb115_tick_over(&pop_a, now);
    let (a_prime, _) = rb115_tick_over(&pop_a_prime, now);
    let (b, b_left) = rb115_tick_over(&pop_b, now);
    let (c, c_left) = rb115_tick_over(&pop_c, now);

    assert_eq!(
        a,
        (256usize, 16usize, 208usize, 20usize),
        "[rb115/tick-capped]: tick A reported (read, planned, reaped, due) = {a:?}; the spec's \
         arithmetic is (256, 16, 208, 20) — twenty distinct expired stamps in a 256-row window, \
         sixteen of them planned. `due` is the count BEFORE the stamp cap: 16 here means it was \
         taken after the truncation or run at the cap (the status-quo information content, which \
         is `planned` again), 0 means it is hard-coded or handed the cutoff as its instant, and \
         256 means it counts rows rather than stamps."
    );

    assert_eq!(
        a_prime,
        (256usize, 16usize, 208usize, 17usize),
        "[rb115/three-count-twin]: tick A-prime reported {a_prime:?}; the spec's arithmetic is \
         (256, 16, 208, 17) — sixteen thirteen-row bundles (208 rows) and 48 of the 60 rows of \
         the newest expired bundle fill the window, so it holds SEVENTEEN stamps, the sixteen \
         oldest are planned and 208 rows are reaped. The sixty-row bundle is never planned, so \
         none of it is deleted."
    );
    assert!(
        (a.0, a.1, a.2) == (a_prime.0, a_prime.1, a_prime.2) && a.3 != a_prime.3,
        "[rb115/three-count-twin]: THE CRITERION. Ticks A {a:?} and A-prime {a_prime:?}, each \
         read as (read, planned, reaped, due), must agree byte for byte on the three rb-87 \
         counts and disagree on `due`. Equal triples with different `due` are the literal proof \
         that NO function of the three counts yields the pre-truncation stamp count: an operator \
         reading the rb-87 line sees one tick twice, and only the new field says one window held \
         twenty stamps and the other seventeen."
    );

    assert_eq!(
        b,
        (256usize, 16usize, 272usize, 16usize),
        "[rb115/tick-exact]: tick B reported {b:?}; the spec's arithmetic is (256, 16, 272, 16) \
         — fifteen whole seventeen-row bundles and one row of a sixteenth fill the window, so it \
         holds exactly SIXTEEN stamps, all of them planned, each deleted whole with its tail. \
         `due` equal to `planned` here is not a coincidence: it is what a well-formed tick over \
         bundles this module writes reports, which is why the new field is a tripwire and not a \
         backlog signal."
    );
    let b_expired_left = b_left.iter().filter(|stamp| **stamp <= cutoff).count();
    assert!(
        b.3 == b.1 && b_expired_left == 68,
        "[rb115/window-edge]: a DISCLOSURE, asserted as a value so it cannot drift into a claim. \
         Tick B planned every stamp its window held ({b:?}), yet {b_expired_left} expired row(s) \
         are still in the store; the spec says 68 — the four newest expired bundles of seventeen \
         rows, all past the full window's edge. `due` is taken OVER the window, so it inherits \
         that blindness: a full window whose every stamp was planned says nothing about rows past \
         its edge. That half of the rb-87 residual is R-rb-115-X8, and it stays open."
    );

    assert_eq!(
        c,
        (100usize, 16usize, 80usize, 20usize),
        "[rb115/tick-low-read]: tick C reported {c:?}; the spec's arithmetic is (100, 16, 80, 20) \
         — the rb-87 residual's own case, twenty expired stamps of five chunks: the range runs \
         out at 100 rows, far below the 256-row window, while twenty stamps compete for sixteen \
         plan slots."
    );
    let c_expired_left = c_left.iter().filter(|stamp| **stamp <= cutoff).count();
    assert_eq!(
        c_expired_left, 20,
        "[rb115/tick-low-read]: after tick C {c_expired_left} expired row(s) remain; the spec \
         says 20 — the four newest five-row bundles the cap left for the next tick. So `read` \
         below the window does NOT mean everything expired has drained: only `due` equal to \
         `planned` beside it says that, and only the new field can say it."
    );

    assert!(
        (a.0, a.1) == (b.0, b.1) && a.3 != b.3,
        "[rb115/twin]: ticks A {a:?} and B {b:?}, each read as (read, planned, reaped, due), \
         agree on `read` and `planned` — (256, 16) both — while `due` is 20 against 16: the \
         residual's own sentence, a stamp cap at its bound that is truncated in one tick and \
         exact in the other, told apart by the new field."
    );

    for (what, tick) in [("A", a), ("A-prime", a_prime), ("B", b), ("C", c)] {
        assert!(
            tick.1 == tick.3.min(stamp_cap) && tick.3 <= tick.0,
            "[rb115/tick-bounds]: tick {what} reported {tick:?} as (read, planned, reaped, due). \
             By construction `planned` is `due` capped at the stamp cap of {stamp_cap} — the SAME \
             seam over the SAME window, once uncapped — and `due` can never exceed `read`, \
             because a window of N rows holds at most N stamps. A tick that breaks either took \
             the two counts over different windows, instants or TTLs."
        );
    }

    assert!(
        a.2 < a.0 && a_prime.2 < a_prime.0 && c.2 < c.0 && b.2 >= b.0,
        "[rb115/tick-inference]: a DISCLOSURE of what the OLD record already carried on this \
         ascending host. The three truncated ticks — A {a:?}, A-prime {a_prime:?}, C {c:?} — \
         reap fewer rows than they read, and the untruncated B {b:?} reaps at least as many. \
         `reaped < read` proves truncation in ANY read order; the converse needs the ascending \
         yield the host models (R-rb-109-ORDERMODEL, open). What `due` adds is not WHETHER but \
         HOW MANY stamps the window held — which the twin clauses above show the three counts \
         cannot say."
    );
}

// --- the value table and the word-bounded census ----------------------------

/// The tier seam's value table: `(what, has_account, has_wallet, ceiling)`,
/// all four inputs, every ceiling a LITERAL.
///
/// Literals and never the constants, deliberately: this table is the seam's
/// value oracle and must stay an independent statement of what each caller
/// class is owed. The owning test pairs every literal with its named constant
/// inside its own body, so each row is checked against BOTH. If the drain is
/// ever re-sized, these move with the constants, in the same diff, from the
/// spec. A SLICE rather than a fixed-size array, so a deleted row still
/// compiles and is caught by the owning test's length clause instead of being
/// a build error that attributes to nothing.
fn rb132_tier_rows() -> &'static [(&'static str, bool, bool, u64)] {
    &[
        (
            "an account holder who also holds a wallet row",
            true,
            true,
            43_008,
        ),
        (
            "an account holder with NO wallet row, never credited currency",
            true,
            false,
            43_008,
        ),
        (
            "no account row but a wallet row, a guest credited at least once",
            false,
            true,
            21_504,
        ),
        (
            "neither row, an identity that has only joined: the newcomer",
            false,
            false,
            10_752,
        ),
    ]
}

/// T0, THE VALUE ORACLE: the newcomer ceiling is exactly half the
/// anonymous one, the three ceilings are strictly ordered, and the tier seam
/// maps all FOUR inputs onto them, each checked against the named constant AND
/// the literal.
///
/// The one test in this block that reads what the code RETURNS. The table is
/// checked for shape before anything is read or called: four distinct inputs,
/// exactly the three ceilings, and the account-only and wallet-only rows named
/// as the pair that trades answers under an argument swap. Two bools compile in
/// either order, and that pair is the only one that tells the orders apart.
///
/// Kills (register rows): R1 the newcomer ceiling set to the anonymous one,
/// and a value one off it, on the value clause; R6 the newcomer arm returning
/// the anonymous ceiling, which is rb-107's behaviour; R7 the wallet test
/// negated; R8 the wallet bit tested before the account bit, which sheds an
/// account holder who has a wallet; R9 the two parameters swapped with the body
/// unchanged; R10 the anonymous arm returning the newcomer ceiling. Those five
/// die on the row clause, each at the first row whose answer it changes. TF1,
/// a table row deleted, still COMPILES because the table is a slice, and dies
/// on the length clause that opens the test.
#[test]
fn rb132_tier_selection_is_exhaustive_over_account_and_wallet() {
    let rows = rb132_tier_rows();

    // --- the table itself, BEFORE anything is read or called -----------------
    assert_eq!(
        rows.len(),
        4,
        "[rb132/tier-value]: the value table carries {} row(s); the seam takes two bools, so it \
         has exactly FOUR inputs and the oracle must name every one. A table that shrank stops \
         reading the arm its missing row exercised (TF1), and every clause below would still \
         report green over what is left.",
        rows.len()
    );
    let mut inputs: Vec<(bool, bool)> = rows.iter().map(|r| (r.1, r.2)).collect();
    inputs.sort_unstable();
    inputs.dedup();
    assert_eq!(
        inputs.len(),
        4,
        "[rb132/tier-value]: the four rows name only {} DISTINCT (account, wallet) input(s). A \
         duplicated input is a missing one, and the arm it would have exercised ships unread.",
        inputs.len()
    );
    let mut ceilings: Vec<u64> = rows.iter().map(|r| r.3).collect();
    ceilings.sort_unstable();
    ceilings.dedup();
    assert_eq!(
        ceilings,
        [10_752u64, 21_504, 43_008],
        "[rb132/tier-value]: the table's distinct expected ceilings are {ceilings:?}; exactly the \
         three tiers are required. With two, a seam that collapsed a pair of tiers into one agrees \
         with every row."
    );
    let expectation = |account: bool, wallet: bool| {
        rows.iter()
            .find(|r| r.1 == account && r.2 == wallet)
            .map(|r| r.3)
    };
    let account_only = expectation(true, false);
    let wallet_only = expectation(false, true);
    assert!(
        account_only == Some(43_008) && wallet_only == Some(21_504),
        "[rb132/tier-value]: the ARGUMENT-ORDER discriminator is not in the table as the spec \
         gives it: the account-only row expects {account_only:?} (must be 43_008) and the \
         wallet-only row expects {wallet_only:?} (must be 21_504). They are the only two inputs \
         whose answers trade places when the seam's two bool parameters are swapped (R9), so \
         naming them here, before the loop, stops a future edit from quietly deleting the one \
         pair that separates the two orders."
    );

    // --- the new ceiling, by value and by derivation ---------------------------
    let full = crate::privacy::EXPORT_LIVE_ROW_CAP;
    let anon = crate::privacy::EXPORT_ANON_LIVE_ROW_CAP;
    let newcomer = crate::privacy::EXPORT_NEWCOMER_LIVE_ROW_CAP;
    assert_eq!(
        newcomer, 10_752,
        "[rb132/newcomer-value]: the newcomer ceiling must be exactly 10_752 live rows, a quarter \
         of the reaper's one-window drain and about 632 minimum-size bundles. It is the most the \
         residual's named pattern, a join and then an export per identity, can ever occupy; set \
         equal to the anonymous ceiling (R1) the tier is deleted, and a value one off it moves \
         the threshold every never-credited guest is shed at."
    );
    assert_eq!(
        newcomer,
        anon / 2,
        "[rb132/newcomer-value]: the newcomer ceiling ({newcomer}) is not half the anonymous \
         ceiling ({anon}). The three ceilings are ONE knob, the drain, halved twice, never three \
         numbers: a literal here drifts the moment the drain is re-sized, and the strict order the \
         tier exists to guarantee then means whatever the older number happens to say."
    );

    // --- every row, against the named constant AND the literal -----------------
    let named: [(u64, u64); 3] = [(43_008, full), (21_504, anon), (10_752, newcomer)];
    for &(what, account, wallet, literal) in rows {
        let constant = named.iter().find(|n| n.0 == literal).map(|n| n.1);
        let got = crate::privacy::export_live_row_cap(account, wallet);
        assert_eq!(
            (Some(got), got),
            (constant, literal),
            "[rb132/tier-value]: {what} (account {account}, wallet {wallet}) is given a ceiling \
             of {got}; it must be the named constant {constant:?} AND its literal value \
             {literal}. Both are asserted on purpose: a clause comparing constants to each other \
             is green on swapped arms, and only the literal says WHICH ceiling came back. The \
             account bit is tested FIRST and ignores the wallet bit, and the wallet bit splits \
             only the callers with no account, so a negated wallet test (R7), the wallet bit \
             tested first (R8), swapped parameters (R9), or either lower arm returning the other \
             lower ceiling (R6, R10) each answers at least one of these four rows wrongly."
        );
    }

    // --- the shed order, by value and by what the seam returns -----------------
    assert!(
        newcomer < anon && anon < full,
        "[rb132/tier-ordering]: the ceilings read newcomer {newcomer}, anonymous {anon}, full \
         {full}; they must be STRICTLY increasing in that order. This is the clause that survives \
         any future re-sizing of the drain: whatever the numbers become, the caller who has \
         invested less is shed first, or two tiers are one control wearing two names."
    );
    let neither = crate::privacy::export_live_row_cap(false, false);
    let wallet_only_cap = crate::privacy::export_live_row_cap(false, true);
    let account_only_cap = crate::privacy::export_live_row_cap(true, false);
    let both = crate::privacy::export_live_row_cap(true, true);
    assert!(
        neither < wallet_only_cap && wallet_only_cap < account_only_cap && account_only_cap == both,
        "[rb132/tier-ordering]: the seam returns {neither} for neither row, {wallet_only_cap} for \
         a wallet row only, {account_only_cap} for an account row only and {both} for both; the \
         shed order requires neither < wallet only < account only == both. An account holder's \
         ceiling ignores the wallet bit, so the last two must be EQUAL: an account holder who was \
         never credited currency is not a lesser account holder."
    );
}
