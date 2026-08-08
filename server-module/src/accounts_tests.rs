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
fn allowed_write_tables() -> [String; 3] {
    [
        "account".to_string(),
        concat!("guest", "_claim").to_string(),
        concat!("guest_claim_reaper", "_schedule").to_string(),
    ]
}

// ===========================================================================
// PURE-UNIT TESTS over the functional core (no ReducerContext required).
// ===========================================================================

fn ident(b: u8) -> Identity {
    Identity::from_byte_array([b; 32])
}

/// A distinguishable baseline `Account` (created != last_login so the
/// touch/transition seams can be proven field-precise).
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
    assert_eq!(row.identity, ident(7), "AUTH-4: identity is ctx.sender.");
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
    assert_eq!(row.guest_identity, ident(5), "AUTH-9: bound to ctx.sender.");
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
        body.contains(concat!("ctx.sender!=ctx.", "identity()")),
        "AUTH-27: the reaper must guard scheduler-only (ctx.sender != ctx.identity())."
    );
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

/// G2 (NO_CLIENT_IDENTITY): no client-callable reducer in accounts.rs takes an
/// `Identity` parameter — every identity is `ctx.sender`, never trusted from the
/// wire.
///
/// Kills: adding a `guest: Identity` parameter to any reducer (an attacker could
/// then claim/delete on behalf of another identity).
#[test]
fn g2_no_reducer_takes_identity_parameter() {
    let squashed = stripped_for_scan(ACCOUNTS_RS);
    let reducers = [
        nd_start(),
        nd_complete(),
        concat!("fndelete", "_account(").to_string(),
        concat!("fncancel_account", "_deletion(").to_string(),
        nd_reaper(),
    ];
    for needle in reducers {
        let sig = extract_squashed_fn_sig(&squashed, &needle)
            .unwrap_or_else(|| panic!("G2: reducer signature not found: {needle}"));
        assert!(
            !sig.contains(":Identity"),
            "G2: reducer `{needle}` must not take an Identity parameter (use ctx.sender). \
             Signature: {sig:?}"
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
