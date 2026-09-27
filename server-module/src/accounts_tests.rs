//! `accounts_tests` — the accounts / guest-claim / deletion-lifecycle tests.
//!
//! Declared from `accounts.rs` as `#[path = "accounts_tests.rs"] mod accounts_tests;`
//! so `super::` resolves to the `accounts` module (pure decision seams,
//! constants, the schema aliases) via `use super::*`.
//!
//! Two layers:
//!   - pure-seam tests at top level: the account state machine, claim / expiry /
//!     deletion-grace arithmetic, the lifecycle manifest's partition and its tie
//!     to the tables' real derive metadata (`m22s6_*`), and the observation-line
//!     field fragments;
//!   - `acct_nh`: the shipped reducers and helpers EXECUTED against the
//!     in-memory host (`native_host_tests.rs`) — provisioning on connect, the
//!     guest-claim round trip, delete / cancel, the deletion cascade, the claim
//!     reaper, the `my_account` view and data export.

#![cfg(test)]

use super::*;

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

/// `issuer_allowed` is an EXACT-match allowlist — no prefix,
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

/// `audience_allowed` accepts iff at least one `aud` entry is
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

/// a freshly provisioned account is `Active`, unclaimed,
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

/// `touch_login` stamps ONLY `last_login_at_ms`; the other seven
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

/// `touch_login` on a NON-Active account stamps ONLY
/// `last_login_at_ms` and leaves every lifecycle + claim field byte-identical.
///
/// `provision_or_touch_account` calls `touch_login` on every existing row that
/// does NOT carry the M22 terminal marker a `PendingDeletion` account that has
/// already claimed a guest A regression that clobbered `status` /
/// `deletion_requested_at_ms` / `claimed_from` / `claimed_at_ms` on the
/// reconnect path would silently resurrect a deletion-pending account (or wipe
/// its claim provenance). The precondition `account_state_is_legal` check pins
/// that the fixture is a real legal PendingDeletion+claimed state, not an
/// accidentally-illegal straw man.
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

/// `is_valid_claim_code` accepts EXACTLY 64 lowercase-hex chars.
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

/// `claim_row` binds the fields as passed and derives
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

/// AUTH-16 / `claim_is_expired` is boundary-INCLUSIVE
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

/// `claimed_account` stamps provenance (`claimed_from`,
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

/// `needs_deletion_write` and `requested_deletion`. The second
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

/// `cancelled_deletion` returns a `PendingDeletion` account to
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

/// `needs_cancel_write` — a cancel on an already-`Active`
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

// ===========================================================================
// ACCOUNT LEGAL-STATE INVARIANT — `Account` permits illegal
// states by construction: `status: AccountStatus` plus an INDEPENDENT
// `deletion_requested_at_ms: Option<i64>`, and a half-settable
// `claimed_from`/`claimed_at_ms` pair. Folding those into the enum would change
// live column TYPES, so the invariant is expressed as ONE pure predicate that
// every Account-returning constructor `debug_assert!`s, plus an exact
// struct-shape tripwire.
//
// PROFILE INDEPENDENCE: the `debug_assert!`s compile out of release wasm,
// so the two tests below — a direct table-driven test of the
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

// ===========================================================================
// DATA-LIFECYCLE MANIFEST / export_bundle SHAPE / TERMINAL COLUMN.
//
// ===========================================================================

use crate::schema::{DataLifecycleEntry, DeletionPolicy, DATA_LIFECYCLE_MANIFEST};

// ---------------------------------------------------------------------------
// THE SPEC §3 PARTITION, PINNED BY VALUE.
// ---------------------------------------------------------------------------

/// the four spec §3 name-sets, transcribed from the spec text (NOT
/// derived from the census) and pinned by SET EQUALITY per policy, plus all five
/// `ViaJoin` PAYLOADS pinned by exact parent value.
///
/// The `Erase` list carries one table beyond the spec's twelve: `export_bundle`.
/// A snapshot of personal data is itself personal data, so the export bundle is
/// erased by the same cascade that produced it (spec §5's 7-day TTL reaper is a
/// SECOND, independent expiry, not a substitute for the cascade).
///
/// The `NotOwned` list carries two beyond the spec's seventeen, and they are
/// NotOwned for different reasons.
///
/// `account_deletion_reaper_schedule` is scheduler bookkeeping, not
/// player data: the row holds only an auto-inc id, the fire instant the RUNTIME
/// reads, and the account identity — and it is the row whose own reducer runs
/// the cascade, so cascading over it would be a table deleting the schedule that
/// is mid-flight. Its two real lifecycles are both explicit and both elsewhere:
/// the runtime deletes the fired one-shot row, and
/// `cancel_account_deletion` disarms a pending one.
/// `guest_claim_reaper_schedule` carries the same policy for the same class of
/// reason.
///
/// `export_bundle_reaper_schedule` is NotOwned more strongly
/// still: it is a GLOBAL interval singleton with NO Identity column at any
/// depth, so there is no per-player key a cascade step could scope itself with.
/// One row exists for the whole database, `ensure_export_bundle_reaper` keeps it
/// at one, and it carries the reaper's cadence and nothing else. Its exportable
/// flag is false for the same reason: a subject's export must not contain the
/// module's own scheduler state.
///
/// The five parents are pinned BY VALUE, not merely proven live: each was
/// verified against the real join column in source before being written here —
/// `character.entity_id` -> `player.entity_id` (schema.rs), `battle_wild.
/// battle_id` -> `battle.battle_id`, `pvp_deadline_schedule.battle_id` ->
/// `battle`, `battle_challenge_reaper_schedule.challenge_id` ->
/// `battle_challenge`, `trade_offer_reaper_schedule.trade_id`
/// -> `trade_offer`.
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

    // Spec §3 ERASE (12) + this slice's own `export_bundle`
    // + rb-73's `player_session`
    // + 20r-d's `pending_evolution_notice`.
    let expected_erase = [
        "battle_action",
        "battle_challenge",
        "export_bundle",
        "heal_cooldown",
        "inventory",
        "monster",
        "monster_pub",
        "pending_evolution_notice",
        "player_conversation",
        "player_dialogue_state",
        "player_quest",
        "player_session",
        "player_wallet",
        "playtest_event",
        "trade_offer",
    ];
    assert_eq!(
        erase, expected_erase,
        "T2 / spec §3 ERASE: the row-deleted set is wrong. Spec §3 names exactly twelve \
         (monster, monster_pub, inventory, player_dialogue_state, player_quest, \
         player_conversation, heal_cooldown, the wallet, playtest_event, trade_offer, \
         battle_challenge, battle_action), this slice adds `export_bundle` — a snapshot of \
         personal data is itself personal data — rb-73 adds `player_session` (ADR-0245 \
         D1) and 20r-d adds `pending_evolution_notice` (ADR-0254 D2). A table moved OUT of \
         this set survives the cascade; a table moved IN is deleted when the spec says it \
         must survive."
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
        "account_deletion_reaper_schedule",
        "config",
        "encounter",
        "evolution_path",
        "export_bundle_reaper_schedule",
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
        "T2 / spec §3 NOT-OWNED: exactly nineteen tables hold no per-player data — spec §3's \
         seventeen, rb-24's `account_deletion_reaper_schedule`, and rb-48's \
         `export_bundle_reaper_schedule` (ADR-0238). Both of the additions are scheduler \
         bookkeeping rather than player data, and neither is reachable by a per-owner cascade \
         step: the rb-24 row holds the identity whose own cascade it runs, and the rb-48 row is \
         a GLOBAL interval singleton with no Identity column at all, so there is nothing for a \
         cascade to key on. Every one is an EXPLICIT registry entry with a mandatory reason — \
         never a silent omission — because the two failure directions are symmetric: cascading \
         over `config` deletes global game config, and quietly dropping a genuinely-owned table \
         out of the cascade leaves an unerased copy of a deleted player's data."
    );
}

/// every `ViaJoin` parent is a table the manifest itself
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

/// the `exportable == true` set equals EXACTLY the seventeen tables
/// spec §5 admits — set equality, BOTH directions.
///
/// a negative-only spot check ("battle_wild is false, guest_claim is false") is
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
/// Kills: flipping `battle_wild` to true (leaks
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
        "player_wallet",
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
// T8 / X8 — THE LEGAL-STATE PREDICATE, EXTENDED FOR `terminal_at_ms`.
// ---------------------------------------------------------------------------

/// `terminal_at_ms.is_some()` implies `PendingDeletion` AND a deletion
/// request stamp — a terminal marker with no request behind it is illegal.
///
/// Spec §4.1 defines the terminal predicate as
/// `status == PendingDeletion && terminal_at_ms.is_some()`, and §4.4 step 5 sets
/// the marker ONLY after steps 1-4 complete, i.e. only inside a live deletion.
/// The existing invariant ties `status` to
/// `deletion_requested_at_ms`; without a matching clause for the new column,
/// `Active` + `terminal_at_ms: Some(..)` — an account that was erased and then
/// resurrected — reads as a perfectly legal state.
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

/// `account_state_is_legal` classifies an `Active` account carrying a
/// terminal marker as ILLEGAL.
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

/// the ONE legal terminal shape — `PendingDeletion` + a request stamp +
/// a terminal marker — is ACCEPTED, and the all-`None` fresh shape stays legal.
///
/// clause spelled `account.terminal_at_ms.is_none()` (or any
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
//
// ===========================================================================

/// A literal double quote.
fn rb22_dq() -> char {
    char::from(34u8)
}

// ===========================================================================
// THE DELETION REAPER SCHEDULE: ARMED ON REQUEST,
// DISARMED ON CANCEL.
//
// ===========================================================================

use game_core::{is_deletion_due, DELETION_GRACE_MS_DEFAULT};

// ---------------------------------------------------------------------------
// THE FIRE INSTANT, AS A PURE SEAM.
// ---------------------------------------------------------------------------

/// `deletion_fire_at_ms(t)` is the exact instant at
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

/// `deletion_fire_at_ms` clamps at `i64::MAX` rather
/// than overflowing, and the KNOWN divergence that clamping produces is
/// documented BY ASSERTION rather than in prose.
///
/// The saturating add is not defensive decoration: the workspace `Cargo.toml`
/// release profile sets `overflow-checks = true`, so a wrapping add would be a
/// panic that aborts the whole `delete_account` transaction in production.
///
/// At a saturating request stamp the fire instant clamps to `i64::MAX`, and the
/// elapsed window from the request to that clamped instant is then SHORTER than
/// the grace window — so the account reads as NOT due at its own fire time and
/// the one-shot reaper no-ops forever. That is a real edge of the design, it is
/// unreachable with any wall clock (the stamp is milliseconds since the Unix
/// epoch), It must not be read as a requirement that a saturating request never
/// completes.
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

/// across a spread of non-saturating request stamps,
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

/// The same account, plus a LEGAL claim-provenance pair and off-baseline
/// `auth_issuer` / `last_login_at_ms`.
///
/// `base_account(n)`, so all four of `claimed_from`, `claimed_at_ms`,
/// `auth_issuer` and `last_login_at_ms` carry the same value on every row — and
/// a predicate that ALSO reads one of them answers identically everywhere and is
/// invisible. Each table below therefore carries one TWIN of an expected-false
/// row and one TWIN of an expected-true row built through this helper: the false
/// twin kills a disjunct that ORs claim provenance IN, the true twin kills a
/// conjunct that ANDs it OUT. One twin alone closes only one of the two
/// polarities.
///
/// Legality is preserved by construction — the claim pair is set on BOTH halves
/// and no lifecycle field moves — so a twin is exactly its base row
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
// THE TERMINAL-MARKER PREDICATE.
// ---------------------------------------------------------------------------

/// `account_has_terminal_marker` answers `terminal_at_ms.is_some()` and NOTHING
/// else.
///
/// This predicate is deliberately the MARKER HALF alone, and
/// the fourth row is why. On the illegal `Active` + marker shape — a resurrected
/// tombstone, which `account_state_is_legal` rejects and which nothing in this
/// slice can write — the conjunction answers `false` and would wave the row
/// through both guards; the marker half answers `true` and refuses it. That is
/// FAIL-CLOSED, and it is the only behaviour difference between the two
/// spellings.
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
///        1 and 3 and must answer exactly what their twins answer.
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

// ---------------------------------------------------------------------------
// THE REAPER-SIDE RECHECK PREDICATE.
// ---------------------------------------------------------------------------

/// `reaper_should_run_cascade` is true for EXACTLY ONE of the twelve `(status,
/// terminal marker, request stamp)` combinations — `PendingDeletion`, no marker,
/// and a request past its grace window — and false for the other eleven.
///
/// The three conjuncts are decoupled on purpose: this
/// predicate is defined DIRECTLY, not as `should_reject_for_deletion` plus
/// extras, so a future widening of the gate predicate cannot silently widen
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

/// the grace window is boundary-INCLUSIVE, a future-dated request is never due,
/// and the arithmetic SATURATES.
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
// THE SHARED DELETION-GATE PREDICATE.
// ---------------------------------------------------------------------------

/// `should_reject_for_deletion` is the DISJUNCTION
/// `status == PendingDeletion || account_has_terminal_marker(&account)`.
///
/// LOCATION IS PART OF THE CONTRACT: this predicate lives in
/// `accounts.rs` and takes `&Account`. the SSOT that `is_pending_deletion`
/// delegates to.
///
/// THE DISJUNCTION MATTERS BOTH WAYS. Row 4 is the illegal Active-plus-marker
/// shape: the status half alone answers false and would let an erased account
/// keep playing, so the marker half is what makes the gate fail-closed. Row 2 is
/// the ordinary grace-window account: the marker half alone answers false and
/// the entire pending-deletion gate would evaporate, so the status half
/// carries the behaviour every existing pin depends on. Neither half is
/// redundant; a mutant that keeps only one is caught by exactly one row.
///
/// This is also the delegation proof for `is_pending_deletion`, which becomes
/// `.is_some_and(|a| should_reject_for_deletion(&a))`: on every LEGAL state a
/// terminal marker implies PendingDeletion, so behaviour is unchanged, and the
/// guard of `complete_guest_claim` becomes terminal-aware for free.
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
// THE CONSTRUCTOR-LEVEL HALF OF THE TERMINAL GUARD.
// ---------------------------------------------------------------------------

/// `cancelled_deletion` REFUSES a terminal input.
///
/// The input row is LEGAL by construction (`PendingDeletion` + request stamp +
/// marker, spec §4.1) and the OUTPUT is not:
/// `cancelled_deletion` clears the status and the stamp but cannot clear the
/// marker, so it would hand back `Active` + marker — the exact illegal shape
/// `account_state_is_legal` forbids and the exact row the fail-closed marker
/// predicate exists to refuse.
///
/// PROFILE DEPENDENCE, STATED RATHER THAN IMPLIED: `debug_assert!` compiles out
/// of a release build, so this tooth exists in the test profile only.
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
// THE TWO ACCOUNT CONSTRUCTORS (pure).
// ---------------------------------------------------------------------------

/// `anonymized_account` overwrites `auth_issuer` with the
/// game-core tombstone sentinel and changes NOTHING else.
///
/// Spec §3 is explicit that the sentinel is a String, never a widening to
/// `Option<String>`, and that `identity` / `created_at_ms` / `claimed_from` /
/// `claimed_at_ms` are RETAINED. So this constructor is a one-field rewrite and
/// every other field is asserted individually — a whole-struct compare would
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
///        the terminal write outside);
///        one that clears the claim provenance; one
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

/// `terminal_account` stamps `terminal_at_ms = Some(now)` and
/// changes NOTHING else.
///
/// The marker is the whole M22 terminal state: spec §4.1 defines terminal as
/// `status == PendingDeletion && terminal_at_ms.is_some()`,
/// and this constructor is the only writer.
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
// THE RE-ARM DECISION, AS A PURE SEAM.
// ---------------------------------------------------------------------------

/// `reaper_rearm_at_ms` returns `Some(requested)`
/// for EXACTLY the not-yet-due mid-grace row, and `None` for everything else.
///
/// DEFINED DIRECTLY, NEVER AS `!reaper_should_run_cascade`. That
/// negation is ALSO true for an `Active` row and for an already-terminal row, so
/// a re-arm keyed on it would re-arm a cancelled account forever and would
/// re-arm an ERASED one — a permanent scheduler loop over a row the cascade has
/// already finished with. Rows 1-6 and 10-12 are what make that distinction
/// observable.
///
/// `PendingDeletion` with no request stamp is an ILLEGAL intermediate
/// (`account_state_is_legal` forbids it) that a bug elsewhere could still
/// produce. The sanctioned implementation resolves the stamp FIRST — `let
/// requested = account.deletion_requested_at_ms?;` — and therefore answers
/// `None`: no re-arm, fail-closed. Every `.unwrap_or(..)` spelling is either a
/// disguised `now`-relative re-arm or an epoch-past hot loop, and both pass a
/// table that omits this row.
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
    // not-due IFF `deletion_fire_at_ms(requested) > now`, so every
    // re-arm this seam authorises schedules STRICTLY LATER than the fire that
    // produced it. That is what makes the one-shot chain terminate instead of
    // spinning. The saturation band (`requested > i64::MAX - GRACE`) clamps the
    // fire instant to i64::MAX — a permanent no-op.
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

/// `plan_deletion_rearms` emits ONE `(identity, fire instant)` pair per mid-grace
/// row that has NO schedule row yet, skipping Active rows, terminal rows,
/// stamp-less rows and rows already armed — in input order, deterministically.
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
/// and never a pre-shifted fire time. — `arm_deletion_reaper`, whose frozen body
/// applies `deletion_fire_at_ms` itself — and the sweep's call site is pinned as
/// `arm_deletion_reaper(ctx, identity, requested_at_ms)`. A plan that shifted the
/// stamp here would therefore have it shifted AGAIN downstream, giving the whole
/// overdue population `requested + 2 x GRACE`: a silent double grace window that
/// both pins would have forced while each read correctly alone. A past-due
/// instant is LEGAL, so there is nothing to clamp.
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
    // `arm_deletion_reaper` derives the fire instant
    // ITSELF — its frozen body is
    // `deletion_fire_at_ms(requested_at_ms).saturating_mul(1_000)`. So a plan that
    // emitted `deletion_fire_at_ms(requested)` would be handing an ALREADY-SHIFTED
    // instant to a helper that shifts it again: `requested + 2 x GRACE`, a silent
    // DOUBLE grace window.
    //
    // ONE place computes the fire instant, and that
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

    // --- MEMBERSHIP IS A SET TEST, NOT A POSITIONAL ONE -
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

    // --- AN EMPTY WORLD IS A NO-OP, NOT A PANIC --------
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

/// the reset carries NO pre-deletion value forward.
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
/// surviving `claimed_from` would keep AUTH-14's one-claim-per-account spent;
/// a surviving `created_at_ms` would misdate the new account.
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

// ===========================================================================
// DELETION COMPLETENESS FROM DERIVE METADATA.
//
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
/// a real stack overflow that `SIGABRT`s the whole `cargo nextest` process rather
/// than failing one test. No live table in this crate has such a type today
/// (every nested `#[derive(SpacetimeType)]` struct here is a strict DAG), so the
/// cap below is forward defence, not a live requirement — but it is what turns a
/// future self-referential column into a named, loud test failure instead of a
/// crashed test runner that reports nothing at all.
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
/// `AlgebraicType::is_identity()` is a SHALLOW shape check.
/// to three completely natural column shapes: `Option<Identity>`
/// lowers to a `Sum` (the `some`/`none` tags, `some` holding the identity
/// product), `Vec<Identity>` lowers to an `Array`, and any
/// `#[derive(SpacetimeType)]` newtype wrapping an `Identity` lowers to a
/// DIFFERENTLY-NAMED `Product` (its own field name, not `__identity__`) — all
/// three are exactly what `is_identity()` was written to reject (it exists to
/// distinguish a REAL identity newtype from an arbitrary same-shaped struct).
/// `Option<Identity>` in particular is a completely ordinary column spelling
/// ("assigned_to", "banned_by", "co_owner"), so a shallow check would let a new
/// owner-keyed table be classified `NotOwned` with NO exception-list edit at all.
/// This walk therefore recurses through `Sum` variants, `Array` element types
/// and nested `Product` fields, testing `is_identity()` at every level before
/// descending further.
///
/// `depth` is a CALLER-SUPPLIED counter (start at 0), asserted against a small
/// cap and panicking BY NAME if exceeded — see `M22s6InlineTypespace`'s doc for
/// why an unbounded recursion here is not merely slow but SIGABRT
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
            "account_deletion_reaper_schedule",
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
            "export_bundle_reaper_schedule",
            <crate::privacy::ExportBundleReaperSchedule as SpacetimeType>::make_type(&mut ts),
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
            "pending_evolution_notice",
            <crate::schema::PendingEvolutionNotice as SpacetimeType>::make_type(&mut ts),
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
            "player_session",
            <crate::schema::PlayerSession as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "player_wallet",
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

/// the S6 row-type registry and `DATA_LIFECYCLE_MANIFEST`
/// name the SAME set of tables, with no duplicates on either side, the census
/// pinned at 41, and a non-vacuity floor on how many of the 41 are identity-bearing.
///
/// This is DISTINCT from `data_lifecycle_manifest_totality_bidirectional`,
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
             side defect, and it would break the set-equality clause below before this test could say anything \
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
        registry_len, 43,
        "[m22s6/registry-census] the S6 row-type registry has {registry_len} entries; the live \
         manifest carries exactly 43 (15 ERASE + 4 ANONYMIZE + 5 JOIN-ONLY + 19 NOT-OWNED, \
         schema.rs :989-993) — 40 before rb-48, plus `export_bundle_reaper_schedule` (ADR-0238), \
         plus rb-73's `player_session` (ADR-0245), plus 20r-d's `pending_evolution_notice` \
         (ADR-0254). \
         A registry that grew or shrank without a matching manifest change is a registry nobody \
         reviewed against the schema it claims to cover."
    );

    let mut identity_bearing = 0usize;
    for (_, ty) in &registry {
        if m22s6_identity_bearing(ty, 0) {
            identity_bearing += 1;
        }
    }
    assert_eq!(
        identity_bearing, 23,
        "[m22s6/registry-identity-floor] {identity_bearing} of the 43 registered row types \
         carry an Identity column at some depth; exactly 23 is the live count (the 19 \
         cascade-classified owner-keyed tables R1 below re-derives, plus the 4 frozen NotOwned \
         exceptions R3 below names). rb-73's `player_session` (ADR-0245) adds one: its \
         `identity` column is what its Erase classification rests on; 20r-d's \
         `pending_evolution_notice` (ADR-0254) adds another on the same reasoning — its \
         `owner_identity` primary key is what its Erase classification rests on. The count was \
         UNCHANGED by rb-48 on purpose: \
         `export_bundle_reaper_schedule` is a global interval singleton carrying only an auto-inc \
         id and the runtime's fire instant, so it adds a row type without adding an owner key — \
         which is the derive-metadata proof, stronger than any text scan, that its `NotOwned` \
         classification and its empty re-key obligation are both honest. A count that drifted \
         without a corresponding R1/R2/R3 edit means either a table's columns changed shape, or \
         this registry stopped seeing them — either way a human needs to look, not have the \
         number silently update itself."
    );
}

// ---------------------------------------------------------------------------
// T1 / X1 — R1: OWNER-KEYED (ERASE/ANONYMIZE) => AT LEAST ONE IDENTITY COLUMN.
// ---------------------------------------------------------------------------

/// every `DATA_LIFECYCLE_MANIFEST` entry classified `Erase` or
/// `Anonymize` proves, from its row struct's OWN SpacetimeDB derive metadata, that
/// it declares at least one direct `Identity` column at any depth.
///
/// The `match` on `entry.policy` is EXHAUSTIVE with no wildcard arm: a new
/// `DeletionPolicy` variant is a compile error here, forcing a conscious decision
/// about whether the new variant is owner-keyed, rather than a silent fall-through.
///
/// Kills: `schema.rs` reclassifying an owner-keyed table (say `monster`) to
///        `NotOwned` — R1's population count catches the reclassification directly,
///        and even before that, a table with
///        a real owner column classified `NotOwned` is exactly the hole
///        "with a direct Identity column" clause exists to close (R3 below closes
///        it from the OTHER direction: an owner-keyed table hiding inside
///        `NotOwned`);
///        a table classified `Erase`/`Anonymize` whose row struct is later edited
///        to drop its only Identity column (a table classified for owner-keyed
///        erasure with no owner key cannot be swept by ANY per-owner cascade step —
///        its rows would survive every account deletion silently, forever);
///        a population count that silently grows or shrinks without a matching
///        reclassification (the exact-17 pin below).
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
        population, 19,
        "[m22s6/x1-population] {population} manifest entries are classified Erase or Anonymize; \
         the live partition is exactly 19 (15 ERASE + 4 ANONYMIZE — schema.rs's own count at \
         :990, rb-73's `player_session` and 20r-d's `pending_evolution_notice` included). A \
         floor would let this population grow silently; an exact count forces a \
         conscious edit to this test alongside any reclassification."
    );
}

// ---------------------------------------------------------------------------
// T1 / X2 — R2: VIAJOIN => EXACTLY ZERO IDENTITY COLUMNS, NO EXCEPTIONS.
// ---------------------------------------------------------------------------

/// every `DATA_LIFECYCLE_MANIFEST` entry classified
/// `ViaJoin(parent)` proves, from the real derive metadata, that its row struct
/// declares EXACTLY ZERO `Identity` columns at any depth — the `DeletionPolicy::
/// ViaJoin` doc comment ("No Identity column; swept transitively via the named
/// parent table") stated as a checked fact, with NO exception list.
///
/// No exception list is deliberate, unlike R3: a `ViaJoin` table is invisible to
/// the per-owner cascade BY DESIGN (it is swept only through its parent's step), so
/// an Identity column here is never a defensible exception — it is always either a
/// misclassification (reclassify Erase/Anonymize) or a genuine, silent per-owner
/// leak across every account deletion.
///
/// Kills: `schema.rs` adding an `Option<Identity>` field to a `ViaJoin` table
///        — the SHALLOW
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

/// every `DATA_LIFECYCLE_MANIFEST` entry classified `NotOwned`
/// proves it declares zero direct `Identity` columns at any depth, EXCEPT a
/// census-pinned four-table exception set (`config`, `guest_claim`,
/// `guest_claim_reaper_schedule`, `account_deletion_reaper_schedule`) — each of
/// which already carries a deliberate `basis`. A FIFTH identity-bearing `NotOwned`
/// table fails this test outright and forces a human classification decision.
///
/// The frozen set is ITSELF a residual, named rather than papered over:
/// it is a declared fact living in this test file, so one
/// self-consistent commit CAN add a genuinely owner-keyed `NotOwned` table by
/// registering its row type, appending its accessor to the frozen array below, and
/// bumping BOTH the exception census and the `NotOwned` population count. That is
/// not closable in-test — it is why the last loop below re-checks every frozen name
/// against the LIVE manifest, so a stale exception (naming a removed or renamed
/// table) cannot linger unnoticed once nothing exercises it any more.
///
/// Kills: a new owner-keyed table added to `NotOwned` by accident (a `NotOwned`
///        table whose column set the author never checked against a
///        classification) — this is the single largest deletion-completeness hole:
///        it satisfies manifest totality (it has
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
        "account_deletion_reaper_schedule",
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
             never erased by the deletion cascade (a NotOwned table has no erase step), \
             so its rows survive every account deletion silently \
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
        population, 19,
        "[m22s6/x3-population] {population} manifest entries are classified NotOwned; the live \
         set is exactly 19 (spec §3's seventeen plus rb-24's account_deletion_reaper_schedule \
         and rb-48's export_bundle_reaper_schedule, ADR-0238; schema.rs :989-993)."
    );

    let observed_len = observed_exceptions.len();
    assert_eq!(
        observed_len, 4,
        "[m22s6/x3-exception-census] {observed_len} NotOwned table(s) were observed carrying an \
         Identity column; exactly 4 is the frozen count. FEWER than 4 means one of the frozen \
         four no longer needs its exception (its basis prose describing WHY it is exempt may \
         now be stale — a human should re-read it, not just shrink this number); MORE than 4 \
         means the FROZEN ARRAY ITSELF was widened, since an unfrozen fifth table would have \
         panicked in the loop above. Widening it is a privacy-classification decision, not a \
         test-maintenance edit: a reviewer must satisfy themselves that the new table's Identity \
         column genuinely cannot outlive an account deletion, exactly as the existing four do. \
         SCOPE, stated plainly so nobody over-reads this gate: it catches a NotOwned table with \
         an IDENTITY COLUMN. A future table holding personal data with NO Identity column (a \
         report row keyed only by auto_inc, carrying free text, an email or a device id) passes \
         this arm with zero friction, because the loop short-circuits on a zero column count \
         before the frozen check runs. That case is a REVIEW obligation on the `basis` prose, \
         and ADR-0229 records it as an accepted residual rather than pretending otherwise."
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
// S9 machinery. Every helper is `m22s9_`-prefixed so it can never collide with
// a same-named helper elsewhere in this file.
// ---------------------------------------------------------------------------

/// The NAMES of every top-level column of one registered row type, in
/// declaration order.
///
/// Same fail-loud discipline as `m22s6_identity_column_count` (:10694) and for
/// the same reason: `ty` MUST be a top-level `Product` (every SpacetimeDB table
/// row is a struct), so anything else means the S6 registry names the WRONG
/// Rust type for `accessor` and every clause built on the result would be
/// describing something that is not a row. An UNNAMED element is equally fatal:
/// a column with no name cannot be transcribed, cannot be queried by the e2e's
/// SQL pass, and returning it as an empty string would silently produce a
/// well-formed-looking transcription entry naming nothing.
fn m22s9_top_level_column_names(accessor: &str, ty: &AlgebraicType) -> Vec<String> {
    let AlgebraicType::Product(p) = ty else {
        panic!(
            "[m22s9/registry-shape] the row type registered for `{accessor}` is not a Product at \
             the top level ({ty:?}). Every SpacetimeDB table row is a struct, so a non-Product \
             top-level type means the S6 registry names the WRONG Rust type for `{accessor}` — \
             every S9 clause built on it would be reading the columns of something that is not a \
             row at all."
        )
    };
    let mut out: Vec<String> = Vec::with_capacity(p.elements.len());
    for e in p.elements.iter() {
        let Some(name) = e.name.as_ref() else {
            panic!(
                "[m22s9/unnamed-column] a top-level column of `{accessor}` carries NO name in its \
                 derive metadata. An unnamed column cannot be transcribed into the e2e's manifest \
                 constant and cannot be named in a SQL predicate; emitting an empty name instead \
                 would produce a well-formed-looking entry that identifies nothing."
            )
        };
        out.push(name.to_string());
    }
    out
}

// ---------------------------------------------------------------------------
// THE THREE CROSS-SLICE FUNCTION CONTRACTS, AT THE TYPE LEVEL.
// ---------------------------------------------------------------------------

/// the three functions that carry a contract ACROSS slice boundaries
/// still have the exact signatures their far-side callers assume, proven by
/// coercing each to an explicit `fn` pointer type.
///
/// A fn-pointer coercion is not decoration: it is the only check in this tree
/// that fails when a signature changes in a way the CALLERS still compile
/// through. Rust would happily let `resolve_all_live_interactions` grow a third
/// parameter, or take an owned `ReducerContext`, or start returning a `Result`
/// — every such change is caught here at compile time, at the seam, with the
/// contract written out in full rather than inferred from a call site.
///
/// THE THREE CONTRACTS:
///   - `crate::resolve_all_live_interactions`
///     the deletion cascade's §4.4 step 1 and
///     the disconnect hook share ONE dispatch list. Both callers
///     pass `(ctx, identity)`; the shape is what makes the sharing possible.
///   - `super::should_reject_for_deletion` — the §4.7 gate
///     gameplay fan-out delegates to through a `guards.rs` wrapper that must
///     never re-derive it. `&Account -> bool` is that contract.
///   - `crate::erase_character_rows` — §4.4 step 6d, the character erase that
///     must run BEFORE the player display-name tombstone. Same `(ctx, identity)`
///     shape as the disconnect bundle because the cascade calls both.
///
/// THE GATE IS ALSO EXERCISED THROUGH ITS POINTER, which is what makes this
/// more than a compile-time assertion: the pointer is CALLED on a live-Active
/// fixture and on a PendingDeletion fixture, so a gate rewritten to return a
/// constant fails here even though its signature is untouched. The two
/// ctx-bound pointers cannot be called (no `ReducerContext` is constructible
/// off-instance) — materializing them is the whole point, and it
/// is what drags the host-syscall link-time references in that the abort stubs
/// at the end of this section satisfy.
///
/// Kills: adding, removing or retyping a parameter of any of the three (the
///        callers on the far side of the seam would still compile against their
///        own local view of it, and a mismatch would only surface as a wasm
///        build break far from the edit);
///        changing a return type (a `resolve_all_live_interactions` that starts
///        returning `Result` and whose result the cascade drops is a silently
///        swallowed failure mid-deletion);
///        `should_reject_for_deletion` collapsed to a constant `false` (the
///        deletion gate stops rejecting anything and every §4.7 call site goes
///        quietly permissive) or to a constant `true` (nobody can play);
///        deleting `erase_character_rows` and inlining its body into the reaper
///        — the pin fails to compile, forcing the §4.4 step-6d ordering
///        question to be re-answered rather than assumed.
#[test]
fn m22s9_cross_slice_contract_signatures() {
    let _: fn(&spacetimedb::ReducerContext, spacetimedb::Identity) =
        crate::resolve_all_live_interactions;
    let _: fn(&spacetimedb::ReducerContext, spacetimedb::Identity) = crate::erase_character_rows;

    let gate: fn(&crate::schema::Account) -> bool = super::should_reject_for_deletion;

    let active = base_account(21);
    assert!(
        !gate(&active),
        "[m22s9/gate-rejects-active] the §4.7 deletion gate, called through its pinned fn \
         pointer, refuses an ordinary Active account. A gate stuck at `true` blocks every \
         gameplay write in the game for every player, and no signature check can see it."
    );

    let pending = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(5),
        ..base_account(21)
    };
    assert!(
        gate(&pending),
        "[m22s9/gate-admits-pending] the §4.7 deletion gate, called through its pinned fn \
         pointer, ADMITS an account inside its deletion grace window. That is the whole gate: S5 \
         delegates every gameplay-write refusal to this one predicate, so a gate stuck at `false` \
         reopens all of them at once while every signature and delegation census stays green."
    );

    let terminal = Account {
        status: AccountStatus::PendingDeletion,
        deletion_requested_at_ms: Some(5),
        terminal_at_ms: Some(9),
        ..base_account(21)
    };
    assert!(
        gate(&terminal),
        "[m22s9/gate-admits-terminal] the §4.7 deletion gate must also refuse an account whose \
         cascade already completed (the terminal marker arm). Dropping that disjunct is the \
         `looks redundant on legal states` simplification the SSOT's own doc comment forbids."
    );
}

// ---------------------------------------------------------------------------
// THE `export_bundle` ROW SHAPE, AT THE TYPE LEVEL.
// ---------------------------------------------------------------------------

/// `ExportBundle` is EXACTLY the eight-column chunk
/// contract, proven by constructing one and destructuring it exhaustively with
/// NO rest pattern, then coercing every field to its expected type.
///
/// This is a COMPILE-LEVEL twin of `export_bundle_struct_shape_and_privacy`,
/// not a duplicate of it, and the two fail on disjoint mutations. The
/// text pin reads schema.rs and would still pass if a column's type were
/// swapped for an alias that spells the same characters; this one would not.
/// This one would still pass if the table attribute gained `public`; that one
/// would not. A ninth field is a compile ERROR here (the destructure is
/// exhaustive) and a text diff there.
///
/// The declaration-ORDER clause is derived, not transcribed twice: the eight
/// names come out of the row type's own derive metadata,
/// so this test compares the compiler's view of the
/// struct with the host's view of the row.
///
/// Kills: appending a ninth column to `ExportBundle`
///        (the destructure stops compiling);
///        deleting a column (same);
///        widening `chunk_index` / `total_chunks` from `u32`, or narrowing
///        `created_at_ms` from `i64` — the per-field coercions reject it, and
///        both are silent BSATN layout changes on a live table;
///        swapping `owner_identity` for a wrapper type that still spells
///        `Identity` in source (invisible to a text pin, rejected here);
///        REORDERING two columns — the derive-metadata order clause catches it,
///        and a reorder is a live-table layout change, not a cosmetic edit.
#[test]
fn m22s9_export_bundle_struct_shape_tripwire() {
    let registry = m22s6_table_row_types();
    let (_, ty) = registry
        .iter()
        .find(|(name, _)| *name == "export_bundle")
        .unwrap_or_else(|| {
            panic!(
                "[m22s9/export-bundle-unregistered] the S6 row-type registry has no \
                 `export_bundle` entry, so this test cannot compare the compiler's view of the \
                 struct against the host's view of the row."
            )
        });
    let columns = m22s9_top_level_column_names("export_bundle", ty);
    let observed: Vec<&str> = columns.iter().map(String::as_str).collect();
    let expected = [
        "chunk_id",
        "owner_identity",
        "request_id",
        "table_name",
        "chunk_index",
        "total_chunks",
        "payload_json",
        "created_at_ms",
    ];
    assert_eq!(
        observed, expected,
        "[m22s9/export-bundle-columns] `export_bundle`'s column list, read from its own derive \
         metadata, is not the S2/S4/S8 chunk contract in its contract ORDER. S4's writer, S4's \
         TTL reaper and S8's client assembler all consume these names in this order, and a \
         reorder also changes the BSATN layout of a live table."
    );

    let row = crate::schema::ExportBundle {
        chunk_id: 7,
        owner_identity: ident(21),
        request_id: 11,
        table_name: "monster".to_string(),
        chunk_index: 1,
        total_chunks: 3,
        payload_json: "[]".to_string(),
        created_at_ms: 1_234,
    };

    // Exhaustive destructure — NO `..` rest pattern. A ninth field stops this
    // compiling, which is the tripwire: a new column on a personal-data table
    // must be a conscious S4/S8 decision, never an append nobody reviewed.
    let crate::schema::ExportBundle {
        chunk_id,
        owner_identity,
        request_id,
        table_name,
        chunk_index,
        total_chunks,
        payload_json,
        created_at_ms,
    } = row;

    assert_eq!(
        chunk_id, 7,
        "[m22s9/export-bundle-values] the destructured chunk_id is not the constructed one."
    );
    assert_eq!(
        owner_identity,
        ident(21),
        "[m22s9/export-bundle-values] the destructured owner_identity is not the constructed one."
    );
    assert_eq!(
        chunk_index, 1,
        "[m22s9/export-bundle-values] the destructured chunk_index is not the constructed one."
    );
    assert_eq!(
        total_chunks, 3,
        "[m22s9/export-bundle-values] the destructured total_chunks is not the constructed one."
    );
    assert_eq!(
        table_name, "monster",
        "[m22s9/export-bundle-values] the destructured table_name is not the constructed one."
    );
    assert_eq!(
        payload_json, "[]",
        "[m22s9/export-bundle-values] the destructured payload_json is not the constructed one."
    );
    assert_eq!(
        created_at_ms, 1_234,
        "[m22s9/export-bundle-values] the destructured created_at_ms is not the constructed one."
    );
    assert_eq!(
        request_id, 11,
        "[m22s9/export-bundle-values] the destructured request_id is not the constructed one."
    );

    // Per-field type pins. Taken by reference so nothing above is moved out
    // from under the value assertions; `&u32` is no more coercible from `&u64`
    // than `u32` is from `u64`, so the pin is exactly as tight.
    let _: &u64 = &chunk_id;
    let _: &spacetimedb::Identity = &owner_identity;
    let _: &u64 = &request_id;
    let _: &String = &table_name;
    let _: &u32 = &chunk_index;
    let _: &u32 = &total_chunks;
    let _: &String = &payload_json;
    let _: &i64 = &created_at_ms;
}

/// The event name.
fn rb40_evt() -> String {
    "guest_claim_export_purge".to_string()
}

/// X1 (behavioural): `purge_fields` renders EXACTLY the sanctioned
/// two-key fragment — the guest identity QUOTED, the chunk count BARE.
///
/// The identity hex is asserted three ways on purpose: the WIDTH (64), the
/// alphabet (lowercase hex), and the exact value for the fixture identity. The
/// third is what kills a Debug rendering, which is a different string for the
/// same value and would put a type name and a `0x` prefix inside a JSON string
/// position; the first two say WHY 64 lowercase hex characters is the contract
/// (`guards.rs:54`: Identity Display is fixed-width lowercase hex, and that is
/// exactly what makes it structurally quote-free and safe to interpolate raw).
///
/// Kills: a constant-returning builder (any fixture disagrees);
///        a builder that renders the identity through `{guest:?}` (Debug), which
///        is not 64 lowercase hex characters;
///        a QUOTED count, which cannot be compared numerically by any alert or
///        panel and is the single most likely `it looks the same` mutation;
///        an UNQUOTED identity, which is invalid JSON the moment the hex begins
///        with a non-digit;
///        a builder that OMITS the count when it is zero — the zero-chunk claim
///        is the exact negative an erasure audit needs, and an absent key reads
///        downstream as `unknown`, not as `none`;
///        a `chunks as u32` (or any narrowing) truncation of a large count;
///        renamed or reordered keys.
#[test]
fn rb40_claim_purge_fields_is_exact() {
    let dq = rb22_dq();
    let hex = ident(7).to_string();

    assert_eq!(
        hex.len(),
        64,
        "rb40 [fields/hex-width]: the fixture identity renders as {} character(s); an Identity \
         is 32 bytes and its Display is fixed-width lowercase hex, so 64 is the only correct \
         width. A different width means the fragment is not rendering Display at all.",
        hex.len()
    );
    assert!(
        hex.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "rb40 [fields/hex-alphabet]: the fixture identity renders as {hex:?}, which is not pure \
         LOWERCASE hex. That alphabet is what makes an identity structurally quote-free and \
         therefore safe to interpolate into a JSON string position without escaping."
    );
    assert_eq!(
        hex,
        "07".repeat(32),
        "rb40 [fields/hex-value]: `ident(7)` is 32 bytes of 0x07, so its hex rendering is `07` \
         thirty-two times, whichever byte order the SDK uses. A different value here means the \
         fragment renders the identity through Debug (a type name plus a prefix) rather than \
         Display — the same value, a different string, and one that is not a bare hex token."
    );

    let expected = format!("{dq}guest{dq}:{dq}{hex}{dq},{dq}chunks{dq}:3");
    assert_eq!(
        super::purge_fields(ident(7), 3),
        expected,
        "rb40 [fields/exact]: the fragment must be exactly two keys in this order — `guest`, \
         the QUOTED hex of the retired guest identity (the SUBJECT an erasure audit is keyed \
         on), then `chunks`, the BARE count of rows the purge deleted. This is the whole \
         payload: no player-authored value, no provider, no claimer (AUTH-21 `claimed_from` \
         already persists the guest-to-claimer linkage on the row itself)."
    );

    let zero = super::purge_fields(ident(7), 0);
    assert_eq!(
        zero,
        format!("{dq}guest{dq}:{dq}{hex}{dq},{dq}chunks{dq}:0"),
        "rb40 [fields/zero]: a ZERO count must render as `:0`, never be omitted and never be \
         suppressed. The zero-chunk claim is the negative an erasure audit needs: it is the \
         only way to tell `this guest had nothing to purge` from `the purge never ran`, which \
         is precisely the ambiguity this slice exists to remove. An omitted key reads \
         downstream as unknown, not as none."
    );

    let big = super::purge_fields(ident(7), 4_294_967_296);
    assert!(
        big.ends_with(format!("{dq}chunks{dq}:4294967296").as_str()),
        "rb40 [fields/large]: a count beyond 32 bits must render as a bare decimal, unclamped \
         and untruncated; got {big:?}. A `chunks as u32` narrowing renders this exact input as \
         0 — a silent `nothing was deleted` for the largest erasures in the system, which are \
         the ones an audit most needs to be right about."
    );

    let f = super::purge_fields(ident(9), 12);
    assert!(
        f.starts_with(dq),
        "rb40 [fields/leading-quote]: the fragment must START at the opening quote of the first \
         key; got {f:?}. `build_log_line` splices it verbatim after a comma, so any leading \
         byte other than a quote produces malformed JSON in every emitted line."
    );
    assert!(
        f.ends_with('2'),
        "rb40 [fields/trailing-digit]: the fragment must END on the last digit of the count; \
         got {f:?}. A trailing comma, brace or quote would either break the envelope or hide a \
         third key that the AM6 reserved-key scan never sees."
    );
    assert_eq!(
        f.matches(dq).count(),
        6,
        "rb40 [fields/quote-census]: the fragment must carry EXACTLY six double quotes — two \
         for the `guest` key, two for its hex value, two for the `chunks` key — and none around \
         the count; got {f:?}. Eight means the count was quoted (numerically uncomparable \
         downstream); four means the identity was left bare (invalid JSON as soon as the hex \
         does not parse as a number)."
    );
}

/// the fragment composes into a well-formed evt-first envelope through the blessed
/// builder, with no dangling comma and exactly three top-level keys.
///
/// Kills: a fragment that starts with a comma (the builder already emits one, so
///        the line would carry `,,` and no JSON parser downstream recovers);
///        a fragment that smuggles a reserved key (the top-level key census
///        counts four instead of three, and last-key-wins would then let the
///        smuggled value forge the event type);
///        an envelope whose evt is not first (the relay reconstruction keys on
///        field order being stable);
///        an empty fragment, which would leave the envelope with one key and the
///        purge unobserved.
#[test]
fn rb40_claim_purge_line_composes_into_the_envelope() {
    let dq = rb22_dq();
    let evt = rb40_evt();
    let hex = ident(9).to_string();
    let line = crate::observability::build_log_line(
        &evt,
        &super::purge_fields(ident(9), 2),
        crate::observability::Breadcrumb::default(),
    );

    let expected =
        format!("{{{dq}evt{dq}:{dq}{evt}{dq},{dq}guest{dq}:{dq}{hex}{dq},{dq}chunks{dq}:2}}");
    assert_eq!(
        line, expected,
        "rb40 [line/exact]: the composed line must be the canonical envelope — `evt` first, \
         then the purge fragment verbatim, and nothing else. This is the string an operator \
         greps, an alert matches and an erasure audit reads, so it is pinned by value rather \
         than by shape."
    );

    assert!(
        line.starts_with('{') && line.ends_with('}'),
        "rb40 [line/braces]: the composed line must be a single JSON object; got {line:?}."
    );
    assert_eq!(
        line.matches('{').count(),
        1,
        "rb40 [line/one-object]: the line must carry exactly ONE opening brace — no nested \
         object. A `sched` breadcrumb is the only nested shape the builder can emit, and this \
         line takes the default (empty) breadcrumb. Got {line:?}."
    );
    assert!(
        !line.contains(",}"),
        "rb40 [line/no-dangling-comma]: the line ends in a dangling comma ({line:?}), which is \
         invalid JSON. The builder appends a comma before a NON-EMPTY fragment, so this fires \
         when the fragment renders empty — an empty fragment is also a line that observes \
         nothing."
    );
    assert_eq!(
        line.matches(dq).count(),
        10,
        "rb40 [line/quote-census]: the line must carry EXACTLY ten double quotes — three quoted \
         keys (6) plus two quoted values (4), with the count bare. Got {line:?}."
    );

    let inner = &line[1..line.len() - 1];
    let key_sep = format!("{dq}:");
    assert_eq!(
        inner.matches(key_sep.as_str()).count(),
        3,
        "rb40 [line/three-keys]: the line must carry EXACTLY three top-level keys (`evt`, \
         `guest`, `chunks`); the key-separator census counts \
         {}. A fourth key is either a reserved envelope key smuggled through the fragment \
         (AM6 — last-key-wins would let it forge the event type or a breadcrumb) or an \
         unreviewed field on a privacy-audit record. Got {line:?}",
        inner.matches(key_sep.as_str()).count()
    );
    let evt_prefix = format!("{dq}evt{dq}:");
    assert!(
        inner.starts_with(evt_prefix.as_str()),
        "rb40 [line/evt-first]: `evt` must be the FIRST key of the envelope; got {line:?}. \
         Every downstream consumer (the relay reconstruction, the Loki label set bounded to \
         reducer plus evt) keys on that position being stable."
    );
}

/// The cascade event name.
fn rb65_evt() -> String {
    "account_deletion_cascade".to_string()
}

/// X1 (behavioural): `cascade_fields` renders EXACTLY the sanctioned two-key
/// fragment — the erased identity QUOTED, the purged bundle count BARE.
///
/// The identity hex is asserted three ways on purpose: the WIDTH (64), the
/// alphabet (lowercase hex), and the exact value for the fixture identity. The
/// third is what kills a Debug rendering, which is a different string for the
/// same value and would put a type name and a `0x` prefix inside a JSON string
/// position (auditor C8); the first two say WHY 64 lowercase hex characters is
/// the contract (`guards.rs:54`: Identity Display is fixed-width lowercase hex,
/// which is exactly what makes it structurally quote-free and safe to
/// interpolate raw).
///
/// Kills: a constant-returning builder (any fixture disagrees);
///        a builder that renders the identity through `{subject:?}` (Debug),
///        which is not 64 lowercase hex characters;
///        a QUOTED count, which cannot be compared numerically by any alert or
///        panel and is the single most likely `it looks the same` mutation;
///        an UNQUOTED identity, which is invalid JSON the moment the hex begins
///        with a non-digit;
///        a builder that OMITS the count when it is zero — the zero-bundle
///        cascade is the exact negative an erasure audit needs, and an absent key
///        reads downstream as `unknown`, not as `none`;
///        an `export_chunks as u32` (or any narrowing) truncation of a large
///        count;
///        renamed or reordered keys.
#[test]
fn rb65_cascade_fields_is_exact() {
    let dq = rb22_dq();
    let hex = ident(7).to_string();

    assert_eq!(
        hex.len(),
        64,
        "rb65 [fields/hex-width]: the fixture identity renders as {} character(s); an Identity is \
         32 bytes and its Display is fixed-width lowercase hex, so 64 is the only correct width. \
         A different width means the fragment is not rendering Display at all.",
        hex.len()
    );
    assert!(
        hex.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "rb65 [fields/hex-alphabet]: the fixture identity renders as {hex:?}, which is not pure \
         LOWERCASE hex. That alphabet is what makes an identity structurally quote-free and \
         therefore safe to interpolate into a JSON string position without escaping."
    );
    assert_eq!(
        hex,
        "07".repeat(32),
        "rb65 [fields/hex-value]: `ident(7)` is 32 bytes of 0x07, so its hex rendering is `07` \
         thirty-two times, whichever byte order the SDK uses. A different value here means the \
         fragment renders the identity through Debug (a type name plus a prefix) rather than \
         Display — the same value, a different string, and one that is not a bare hex token."
    );

    let expected = format!("{dq}subject{dq}:{dq}{hex}{dq},{dq}export_bundle{dq}:3");
    assert_eq!(
        super::cascade_fields(ident(7), 3),
        expected,
        "rb65 [fields/exact]: the fragment must be exactly two keys in this order — `subject`, \
         the QUOTED hex of the erased account identity (the SUBJECT an erasure audit is keyed \
         on), then `export_bundle`, the BARE count of chunks the delegated purge deleted. This is \
         the whole payload: no player-authored value, no provider, no pre-tombstone field. The \
         subject key is `subject` and not `account` because ADR-0243 D4 reserves the \
         erase-helper nouns for the deferred per-step counts, and the account row's own terminal \
         stamp is one of them."
    );

    let zero = super::cascade_fields(ident(7), 0);
    assert_eq!(
        zero,
        format!("{dq}subject{dq}:{dq}{hex}{dq},{dq}export_bundle{dq}:0"),
        "rb65 [fields/zero]: a ZERO count must render as `:0`, never be omitted and never be \
         suppressed. The zero-bundle cascade is the negative an erasure audit needs: it is the \
         only way to tell `this account had no export bundle to purge` from `the cascade never \
         ran`, which is precisely the ambiguity this slice exists to remove. An omitted key reads \
         downstream as unknown, not as none."
    );

    let big = super::cascade_fields(ident(7), 4_294_967_296);
    assert!(
        big.ends_with(format!("{dq}export_bundle{dq}:4294967296").as_str()),
        "rb65 [fields/large]: a count beyond 32 bits must render as a bare decimal, unclamped and \
         untruncated; got {big:?}. An `export_chunks as u32` narrowing in the builder renders \
         this HOST-side input as 0. SCOPE, STATED HONESTLY (ADR-0243 D3): on wasm32 `usize` IS \
         `u32`, so this input is unreachable in the shipped module and the tooth is NOT evidence \
         about a production truncation. What it pins is the TYPE CONTRACT the builder's frozen \
         signature states — the count is rendered at the width \
         `purge_export_bundles` returns, with no cast between them — so that a future 64-bit \
         host target, or a `chunks as u32` added for tidiness, is a conscious change rather than \
         a silent one."
    );

    let f = super::cascade_fields(ident(9), 12);
    assert!(
        f.starts_with(dq),
        "rb65 [fields/leading-quote]: the fragment must START at the opening quote of the first \
         key; got {f:?}. `build_log_line` splices it verbatim after a comma, so any leading byte \
         other than a quote produces malformed JSON in every emitted line."
    );
    assert!(
        f.ends_with('2'),
        "rb65 [fields/trailing-digit]: the fragment must END on the last digit of the count; got \
         {f:?}. A trailing comma, brace or quote would either break the envelope or hide a third \
         key that the AM6 reserved-key scan never sees."
    );
    assert_eq!(
        f.matches(dq).count(),
        6,
        "rb65 [fields/quote-census]: the fragment must carry EXACTLY six double quotes — two for \
         the `subject` key, two for its hex value, two for the `export_bundle` key — and none \
         around the count; got {f:?}. Eight means the count was quoted (numerically uncomparable \
         downstream); four means the identity was left bare (invalid JSON as soon as the hex does \
         not parse as a number)."
    );
}

/// the cascade fragment composes into a well-formed evt-first envelope through
/// the blessed builder, with no dangling comma and exactly three top-level keys.
///
/// Kills: a fragment that starts with a comma (the builder already emits one, so
///        the line would carry `,,` and no JSON parser downstream recovers);
///        a fragment that smuggles a reserved key (the top-level key census
///        counts four instead of three, and last-key-wins would then let the
///        smuggled value forge the event type);
///        an envelope whose evt is not first (the relay reconstruction and the
///        Loki label set both key on that position being stable);
///        an empty fragment, which would leave the envelope with one key and the
///        cascade unobserved.
#[test]
fn rb65_cascade_line_composes_into_the_envelope() {
    let dq = rb22_dq();
    let evt = rb65_evt();
    let hex = ident(9).to_string();
    let line = crate::observability::build_log_line(
        &evt,
        &super::cascade_fields(ident(9), 2),
        crate::observability::Breadcrumb::default(),
    );

    let fragment = format!("{dq}subject{dq}:{dq}{hex}{dq},{dq}export_bundle{dq}:2");
    let expected = format!("{{{dq}evt{dq}:{dq}{evt}{dq},{fragment}}}");
    assert_eq!(
        line, expected,
        "rb65 [line/exact]: the composed line must be the canonical envelope — `evt` first, then \
         the cascade fragment verbatim, and nothing else. This is the string an operator greps, \
         an alert matches and an erasure audit reads, so it is pinned by value rather than by \
         shape."
    );

    assert!(
        line.starts_with('{') && line.ends_with('}'),
        "rb65 [line/braces]: the composed line must be a single JSON object; got {line:?}."
    );
    assert_eq!(
        line.matches('{').count(),
        1,
        "rb65 [line/one-object]: the line must carry exactly ONE opening brace — no nested \
         object. A `sched` breadcrumb is the only nested shape the builder can emit, and this \
         line takes the default (empty) breadcrumb. Got {line:?}."
    );
    assert!(
        !line.contains(",}"),
        "rb65 [line/no-dangling-comma]: the line ends in a dangling comma ({line:?}), which is \
         invalid JSON. The builder appends a comma before a NON-EMPTY fragment, so this fires \
         when the fragment renders empty — an empty fragment is also a line that observes nothing."
    );
    assert_eq!(
        line.matches(dq).count(),
        10,
        "rb65 [line/quote-census]: the line must carry EXACTLY ten double quotes — three quoted \
         keys (6) plus two quoted values (4), with the bundle count bare. Got {line:?}."
    );

    let inner = &line[1..line.len() - 1];
    let key_sep = format!("{dq}:");
    assert_eq!(
        inner.matches(key_sep.as_str()).count(),
        3,
        "rb65 [line/three-keys]: the line must carry EXACTLY three top-level keys (`evt`, \
         `subject`, `export_bundle`); the key-separator census counts {}. A fourth key is either \
         a reserved envelope key smuggled through the fragment (AM6 — last-key-wins would let it \
         forge the event type or a breadcrumb) or an unreviewed field on a privacy-audit record \
         that names an account which has just been erased. Got {line:?}",
        inner.matches(key_sep.as_str()).count()
    );
    let evt_prefix = format!("{dq}evt{dq}:");
    assert!(
        inner.starts_with(evt_prefix.as_str()),
        "rb65 [line/evt-first]: `evt` must be the FIRST key of the envelope; got {line:?}. Every \
         downstream consumer (the relay reconstruction, the Loki label set bounded to reducer \
         plus evt) keys on that position being stable."
    );
}

// ---------------------------------------------------------------------------
// resolve_all_live_interactions is presence- row-safe, both by execution (Leg
// A) and by a depth-1 source scan of its four callees (Leg B).
// ---------------------------------------------------------------------------

/// `resolve_all_live_interactions` (lib.rs) — the four-call
/// trade/PvP/wild-battle/challenge dispatcher shared by `on_disconnect` and the
/// deletion cascade — deletes NEITHER the `player` NOR the `character` presence
/// row for the identity it resolves; `on_disconnect`'s own body does, after the
/// dispatcher returns. Executed against the in-memory host with a seeded player +
/// character row; The dispatcher's non-empty branches (live trades, challenges,
/// battles) are executed by the accounts cascade test
/// (`acct_nh::acct_deletion_reaper_erases_every_owned_row_and_nothing_else`,
/// whose subject keeps its player row) and battle_tests.rs `rb129_*`.
#[test]
fn rb72_resolve_all_live_interactions_leaves_presence_rows() {
    use crate::schema::{character, Character, Player};
    use game_core::{ActionState, Direction};

    // --- S0: seed the subject's player + character rows ---------------------
    let fx = crate::native_host_tests::fixture();
    let player_t = fx.table::<Player>("player", "identity", |r| r.identity);
    let character_t = fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id);
    let ctx = fx.ctx();

    // NEVER [0u8; 32]: that is ctx.sender() under __dummy() and equals
    // crate::WILD_IDENTITY (lib.rs:89). NEVER entity_id 0: the #[auto_inc]
    // sentinel — moot for `Handle::seed` (it bypasses the real insert path
    // entirely), but a live tripwire for a future edit that switches this
    // test to `ctx.db.<t>().insert(`.
    let subject = Identity::from_byte_array([7u8; 32]);
    const ENTITY_ID: u64 = 77;

    player_t.seed(&Player {
        identity: subject,
        entity_id: ENTITY_ID,
        name: "rb72-subject".to_string(),
        online: true,
        last_input_seq: 0,
    });
    character_t.seed(&Character {
        entity_id: ENTITY_ID,
        zone_id: 0,
        tile_x: 0,
        tile_y: 0,
        facing: Direction::South,
        action: ActionState::Idle,
        move_started_at_ms: 0,
        sprite_id: 0,
        move_queue: Vec::new(),
    });

    // --- S1 PRE: both rows visible BEFORE the call ---------------------------
    assert!(
        ctx.db.player().identity().find(subject).is_some(),
        "[rb72/pre-player] the seeded player row must be visible through ctx.db BEFORE \
         resolve_all_live_interactions runs, or every assertion below is vacuous. Indexes \
         requested so far: {:?}",
        fx.requested_indexes()
    );
    assert!(
        ctx.db.character().entity_id().find(ENTITY_ID).is_some(),
        "[rb72/pre-character] the seeded character row must be visible through ctx.db BEFORE \
         resolve_all_live_interactions runs, or every assertion below is vacuous. Indexes \
         requested so far: {:?}",
        fx.requested_indexes()
    );

    // --- S2: execute the shipped dispatcher ----------------------------------
    // trade_offer / battle / battle_challenge are deliberately left
    // UNREGISTERED (see the host-wall paragraph above): every write syscall
    // on this host is unmodelled() and ABORTS THE PROCESS, so the four
    // callees' indexed .filter() scans must read empty here for the test to
    // run to completion at all.
    crate::resolve_all_live_interactions(&ctx, subject);

    // --- S3 POST: both rows still present AFTER the call ---------------------
    assert!(
        ctx.db.player().identity().find(subject).is_some(),
        "[rb72/post-player] resolve_all_live_interactions must not delete the player row — \
         ADR-0232 D2 is wrong that it does. It is on_disconnect's OWN body (lib.rs:275-278) \
         that deletes presence rows, strictly AFTER this dispatcher returns."
    );
    assert!(
        ctx.db.character().entity_id().find(ENTITY_ID).is_some(),
        "[rb72/post-character] resolve_all_live_interactions must not delete the character \
         row — same D2 correction as the player assertion above."
    );

    // --- S4 CONTROL: the read channel CAN observe an absence -----------------
    assert_eq!(
        player_t.remove(subject),
        1,
        "[rb72/control-remove-player] exactly one seeded player row must be removable, or the \
         S1/S3 presence assertions above are not falsifiable by anything"
    );
    assert_eq!(
        character_t.remove(ENTITY_ID),
        1,
        "[rb72/control-remove-character] exactly one seeded character row must be removable, \
         or the S1/S3 presence assertions above are not falsifiable by anything"
    );
    assert!(
        ctx.db.player().identity().find(subject).is_none(),
        "[rb72/control-absent-player] after removal the SAME read must report absent — \
         proving the S1/S3 `is_some()` reads are capable of failing, not vacuously true for \
         any row state"
    );
    assert!(
        ctx.db.character().entity_id().find(ENTITY_ID).is_none(),
        "[rb72/control-absent-character] same falsifiability proof for the character read"
    );
}

/// `plan_declines_at_cancel` returns, in INPUT ORDER, the ids of exactly the
/// offers refuses for the row it is handed.
///
/// The planner is the only place the sweep's decision is observable: the cancel
/// reducer cannot be executed to its write (every
/// write syscall aborts the process), so the behavioural half of this criterion
/// lives here and the wiring half lives in the source pins beside it.
///
/// FIVE ACCOUNT SHAPES, built from the shipped constructors wherever the module
/// can produce them, so this test can never assemble a state `accounts.rs` itself
/// cannot reach. The two ILLEGAL shapes are struct-update literals because
/// `account_state_is_legal` forbids them — but only under a `debug_assert`, so
/// the shipped wasm can hold them and every marker call site in `accounts.rs` is
/// deliberately fail-closed on them.
///
/// THE REQUEST STAMP IS NON-ZERO AND THE OFFER STAMPS STRADDLE IT, including two
/// negatives and both `i64` extremes: at a request stamp of zero an `unwrap_or(0)`
/// mis-spelling of the fail-closed arm is byte-invisible, because every wrong
/// implementation agrees with the right one.
///
/// THE IDS ARE DELIBERATELY OUT OF ASCENDING ORDER (`17, 9, 7, 13, 3, 11`), so
/// the expected output `[17, 7, 3]` is strictly DESCENDING. A planner that sorts,
/// dedups or collects into a set returns `[3, 7, 17]` and reds only
/// `[rb83/table-order]`.
///
/// WHAT EACH CLAUSE KILLS:
///
///   * `[rb83/table-multi]` — M6: a planner that returns the FIRST refused id
///     (`.find(..).into_iter()`, `.next()`, `.take(1)`) declines one offer and
///     leaves every other confederate's standing. The count is asserted before
///     the equality so a failure attributes.
///   * `[rb83/table-boundary]` — M4 and M5: the id stamped at EXACTLY the request
///     millisecond must be swept (ADR-0237 D1's boundary is inclusive; a
///     strict-greater-than flip drops it and nothing else), and the id stamped
///     one millisecond earlier must NOT be (that is PRV1-10, and a blanket sweep
///     that ignores the stamp is the break this slice exists to avoid).
///   * `[rb83/table-order]` — the full vector, in input order.
///   * `[rb83/table-empty]` — a planner handed no offers must return no ids; this
///     is also what makes `[rb83/decline-empty]` in `trading_tests.rs` a
///     reachable state rather than a hypothetical.
///   * `[rb83/table-fail-closed]` — the illegal stamp-less `PendingDeletion`
///     shape and the terminal shape refuse at EVERY stamp, `i64::MIN` included,
///     so every incoming offer is swept. `None => false` admits everything for
///     such a row; `unwrap_or(0)` admits exactly the negative stamps. Both
///     mis-spellings are byte-invisible to every source pin.
///   * `[rb83/table-active-admits]` — the ordinary player. An `Active` row is
///     outside the para-4.7 gate at every stamp including `i64::MAX`, so the
///     sweep can never fire on the AUTH-38 no-op path: an inverted polarity here
///     would delete every incoming offer of every player who ever cancels.
///   * `[rb83/table-laundering]` — the residual, as data. The SAME offers judged
///     against the pre-cancel row return ids and judged against
///     `cancelled_deletion(row)` return none. That pair is why the sweep must be
///     sequenced BEFORE the status write, and it is the behavioural twin of
///     `[rb83/sweep-before-write]` one test above.
#[test]
fn rb83_plan_declines_at_cancel_truth_table() {
    let req: i64 = 1_700_000_000_000;
    let me = ident(1);

    let active = crate::accounts::new_account_row(me, "rb83-caller".to_string(), 42_000);
    let pending = crate::accounts::requested_deletion(active.clone(), req);
    let terminal = crate::accounts::terminal_account(pending.clone(), req + 1_000);
    let cancelled = crate::accounts::cancelled_deletion(pending.clone());

    // Illegal shapes: unreachable through the constructors BY CONSTRUCTION (their
    // debug_asserts forbid them), so a struct-update literal is the only way to
    // observe the fail-closed arms the shipped wasm still has to answer for.
    let illegal_marker = crate::schema::Account {
        terminal_at_ms: Some(5),
        ..active.clone()
    };
    let illegal_no_stamp = crate::schema::Account {
        status: crate::schema::AccountStatus::PendingDeletion,
        ..active.clone()
    };

    // (trade_id, created_at_ms). Ids deliberately unsorted; stamps straddle the
    // request instant and reach both i64 extremes and two negatives.
    let offers: [(u64, i64); 6] = [
        (17, i64::MAX),
        (9, req - 1),
        (7, req + 1),
        (13, i64::MIN),
        (3, req),
        (11, -1),
    ];
    let every_id: Vec<u64> = vec![17, 9, 7, 13, 3, 11];

    // --- the mid-grace row: the criterion itself -----------------------------
    let swept = crate::accounts::plan_declines_at_cancel(&pending, &offers);

    assert_eq!(
        swept.len(),
        3,
        "[rb83/table-multi] the planner returned {swept:?} for a mid-grace row requested at \
         {req}; exactly THREE of the six offers are stamped at or after that instant, so it \
         must return three ids. ONE means the planner stops at the first refused offer \
         (`.find(..)`, `.next()`, `.take(1)` all compile and read correctly) — the cancel then \
         declines one confederate's offer and leaves every other one standing, which closes \
         nothing. SIX means the stamp is not consulted at all: a blanket sweep destroys the \
         PREDATING offers PRV1-10 protects."
    );
    assert!(
        swept.contains(&3) && !swept.contains(&9),
        "[rb83/table-boundary] the planner returned {swept:?} for a mid-grace row requested at \
         {req}. Offer 3 is stamped at EXACTLY the request millisecond and MUST be swept: both \
         stamps come from the same ms-floored transaction clock, so an offer created in the \
         request millisecond does not PREDATE the request, and the attack this closes is \
         `request deletion, then have a confederate propose immediately` (ADR-0237 D1, \
         inherited verbatim by ADR-0252 D1 — never re-derived). A strict-greater-than flip in \
         the SSOT drops offer 3 and nothing else in this suite. Offer 9 is stamped one \
         millisecond EARLIER and must NOT be swept: that is the predating commitment PRV1-10 \
         keeps completable, and sweeping it is the spec break this whole design avoids."
    );
    assert_eq!(
        swept,
        vec![17u64, 7, 3],
        "[rb83/table-order] the planner returned {swept:?} and must return the refused ids in \
         INPUT ORDER, which for this fixture is the strictly DESCENDING `[17, 7, 3]`. The \
         input ids are deliberately unsorted so this clause discriminates: a planner that \
         sorts, dedups, or collects through a set returns `[3, 7, 17]` and satisfies every \
         other clause in this test. Order is behaviour here, not tidiness — `decline_offers` \
         disarms and deletes in the order it is handed, and a planner free to reorder is a \
         planner free to drop."
    );

    // --- the empty input ------------------------------------------------------
    assert_eq!(
        crate::accounts::plan_declines_at_cancel(&pending, &[]),
        Vec::<u64>::new(),
        "[rb83/table-empty] the planner must return NO ids when handed no offers, whatever the \
         row's state. A planner that fabricates an id from the row (its own identity read as a \
         number, a sentinel, a default) hands `decline_offers` a trade_id nobody proposed, and \
         the delete that follows is a write nothing in this slice reviewed. This is also the \
         state `[rb83/decline-empty]` in trading_tests.rs executes against the live host."
    );

    // --- the fail-closed shapes ----------------------------------------------
    for (label, account, why) in [
        (
            "ILLEGAL PendingDeletion with no request stamp",
            &illegal_no_stamp,
            "the SSOT spells the missing-stamp case as an explicit match arm returning TRUE \
             precisely so the gated-but-stamp-less row refuses at every instant. `None => \
             false` admits every offer for such a row, and `unwrap_or(0)` admits exactly the \
             NEGATIVE stamps — which is why this fixture carries `i64::MIN` and minus one as \
             well as the boundary",
        ),
        (
            "legal terminal row (PendingDeletion plus the marker)",
            &terminal,
            "the terminal marker is tested FIRST and OUTSIDE the stamp comparison: an \
             already-erased account is refused every commitment however old, so every incoming \
             offer it still names is swept. Dropping that leading clause admits every offer \
             older than the row's own request stamp",
        ),
        (
            "ILLEGAL Active-plus-marker row (a resurrected tombstone)",
            &illegal_marker,
            "`account_state_is_legal` forbids this shape but only under a `debug_assert`, so \
             the shipped wasm can hold it; every marker call site in accounts.rs is fail-closed \
             on it deliberately, and this planner inherits that by delegating rather than \
             re-deriving",
        ),
    ] {
        let got = crate::accounts::plan_declines_at_cancel(account, &offers);
        assert_eq!(
            got, every_id,
            "[rb83/table-fail-closed] the planner returned {got:?} for the {label}; it must \
             sweep EVERY offer, in input order — {why}. This is the fail-closed direction by \
             DELEGATION: the planner never inspects the stamp itself, so widening or narrowing \
             the SSOT moves this row with it (ADR-0225), and any answer here other than the \
             whole list means the planner grew a decision of its own."
        );
    }

    // --- the ordinary player --------------------------------------------------
    let admitted = crate::accounts::plan_declines_at_cancel(&active, &offers);
    assert_eq!(
        admitted,
        Vec::<u64>::new(),
        "[rb83/table-active-admits] the planner returned {admitted:?} for an `Active` row that \
         never requested deletion; it must return NOTHING, even for the offer stamped at \
         `i64::MAX`. An Active account is outside the para-4.7 gate at every stamp, so this is \
         the SECOND reason (after the statement's placement behind the AUTH-38 gate) that the \
         sweep can never fire on the idempotent no-op path. An inverted polarity here deletes \
         every incoming trade offer of every player who cancels a deletion — a silent \
         data-destroying outage that every source pin in this slice reports as correctly \
         wired, because the call text is byte-identical whichever way the decision runs."
    );

    // --- the residual, as data ------------------------------------------------
    let before = crate::accounts::plan_declines_at_cancel(&pending, &offers);
    let after = crate::accounts::plan_declines_at_cancel(&cancelled, &offers);
    assert!(
        !before.is_empty(),
        "[rb83/table-laundering] the same offers judged against the PRE-cancel row returned \
         {before:?}; they must return the post-request ids. With nothing to sweep before the \
         write, the pair below is vacuous and proves nothing about sequencing."
    );
    assert_eq!(
        after,
        Vec::<u64>::new(),
        "[rb83/table-laundering] the SAME offers judged against `cancelled_deletion(row)` \
         returned {after:?} and must return NOTHING — this pair IS residual \
         R-rb-47-CANCELLAUNDER written as data. Before the write the row still carries \
         `PendingDeletion` and its request stamp, so the post-request offers are refused and \
         swept; after the write the row is `Active` with the stamp cleared (AUTH-29 / PRV1-3, \
         which this slice does NOT change), so every one of those offers reads as admitted and \
         a sweep placed there declines nothing at all. That is precisely why the read and the \
         plan must both precede the status write, and it is the behavioural twin of \
         `[rb83/sweep-before-write]`. Judged before: {before:?}. Judged after: {after:?}"
    );
}

// ===========================================================================
// THE ACCOUNTS NATIVE-HOST SUITE.
//
// Executes the SHIPPED reducers and helpers against real rows in the in-memory
// host (`native_host_tests`).
//
// What is NOT here, and where it lives:
// * The client-callable reducer surface — exact names and argument types, so
//   `start_guest_claim(code: String)` keeps the claim secret client-minted and
//   no reducer accepts an `Identity` — is the frozen roster
//   evals/baselines/client-callable-reducers.json (client-surface-privacy
//   clause D). Account columns (no email / subject) are frozen by the generated
//   bindings (client-surface-privacy + bindings-drift).
// * Rollback: this host models none (a reducer that errors after a write keeps
//   the write). Every refusal below is asserted to happen BEFORE any write;
//   transactional rollback is account-e2e's live flow.
// * The battle anonymize step of the cascade (forced terminal, tombstoned
//   party) is battle_tests.rs `rb129_*`; the deletion gate on every class-(iv)
//   reducer is guards_tests.rs `rb128_*`.
// ===========================================================================
mod acct_nh {
    use crate::accounts::{AccountDeletionReaperSchedule, GuestClaimReaperSchedule};
    use crate::native_host_tests::{
        fixture, Fixture, Handle, DEFAULT_DATABASE_IDENTITY, VIEW_MY_ACCOUNT,
    };
    use crate::playtest::PlaytestEvent;
    use crate::privacy::ExportBundleReaperSchedule;
    use crate::pvp::BattleChallengeReaperSchedule;
    use crate::schema::{
        Account, BattleAction, BattleChallenge, ChallengeStatus, Character, DeletionPolicy,
        EvolutionRevealRow, ExportBundle, GuestClaim, HealCooldown, Inventory, Monster, MonsterPub,
        PendingEvolutionNotice, Player, PlayerConversation, PlayerDialogueStateRow, PlayerQuestRow,
        PlayerSession, PlayerWallet, Profile, TradeOffer, DATA_LIFECYCLE_MANIFEST,
    };
    use crate::trading::TradeOfferReaperSchedule;
    use spacetimedb::sats::bsatn;
    use spacetimedb::{ConnectionId, Identity, ReducerContext, ScheduleAt, Serialize, Timestamp};

    // --- fixture vocabulary -------------------------------------------------

    const T0: i64 = 1_700_000_000_000;

    fn at(ms: i64) -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(ms * 1000)
    }

    /// Never `[0; 32]` (the dummy sender == WILD_IDENTITY) and never the module
    /// identity `[0xDB; 32]`.
    fn id(b: u8) -> Identity {
        Identity::from_byte_array([b; 32])
    }

    fn scheduler() -> Identity {
        Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY)
    }

    /// A well-formed claim code: 64 lowercase hex characters.
    fn code(c: char) -> String {
        std::iter::repeat_n(c, crate::accounts::CLAIM_CODE_LEN).collect()
    }

    fn claims(iss: &str, aud_json: &str) -> String {
        format!(r#"{{"iss":"{iss}","aud":{aud_json},"sub":"subject-{iss}"}}"#)
    }

    /// The token a legitimate player's connection carries.
    fn good_jwt() -> String {
        claims(
            crate::accounts::ALLOWED_ISSUERS[0],
            &format!("\"{}\"", crate::accounts::ALLOWED_AUDIENCE[0]),
        )
    }

    fn conn_of(who: Identity) -> u128 {
        0x5E55_0000 + u128::from(who.to_byte_array()[0])
    }

    /// Call as `who` over a client connection carrying `jwt` (`None` = anonymous).
    fn as_conn<T>(
        fx: &Fixture,
        who: Identity,
        jwt: Option<&str>,
        ms: i64,
        f: impl FnOnce(&ReducerContext) -> T,
    ) -> T {
        fx.run_as_conn_at(who, conn_of(who), jwt, at(ms), f)
    }

    fn signed_in<T>(
        fx: &Fixture,
        who: Identity,
        ms: i64,
        f: impl FnOnce(&ReducerContext) -> T,
    ) -> T {
        let jwt = good_jwt();
        as_conn(fx, who, Some(&jwt), ms, f)
    }

    /// Canonical bytes of a row: every row type here compares by value this way
    /// (BSATN is canonical), whether or not it derives `PartialEq`.
    fn enc<T: Serialize>(row: &T) -> Vec<u8> {
        bsatn::to_vec(row).expect("a row always BSATN-encodes")
    }

    fn encs<T: Serialize>(rows: &[T]) -> Vec<Vec<u8>> {
        let mut out: Vec<Vec<u8>> = rows.iter().map(enc).collect();
        out.sort();
        out
    }

    fn fire_at(schedule: &ScheduleAt) -> Timestamp {
        match schedule {
            ScheduleAt::Time(t) => *t,
            ScheduleAt::Interval(_) => panic!("expected a one-shot schedule, got an interval"),
        }
    }

    // --- the world: every table the accounts paths touch ---------------------

    struct W<'a> {
        account: Handle<'a, Account>,
        claim: Handle<'a, GuestClaim>,
        claim_reaper: Handle<'a, GuestClaimReaperSchedule>,
        del_reaper: Handle<'a, AccountDeletionReaperSchedule>,
        player: Handle<'a, Player>,
        session: Handle<'a, PlayerSession>,
        monster: Handle<'a, Monster>,
        monster_pub: Handle<'a, MonsterPub, u64>,
        notice: Handle<'a, PendingEvolutionNotice>,
        inventory: Handle<'a, Inventory>,
        quest: Handle<'a, PlayerQuestRow>,
        dialogue: Handle<'a, PlayerDialogueStateRow>,
        conversation: Handle<'a, PlayerConversation>,
        heal: Handle<'a, HealCooldown>,
        wallet: Handle<'a, PlayerWallet>,
        profile: Handle<'a, Profile>,
        character: Handle<'a, Character, u64>,
        trade: Handle<'a, TradeOffer>,
        trade_reaper: Handle<'a, TradeOfferReaperSchedule, u64>,
        challenge: Handle<'a, BattleChallenge>,
        challenge_reaper: Handle<'a, BattleChallengeReaperSchedule, u64>,
        action: Handle<'a, BattleAction, u64>,
        playtest: Handle<'a, PlaytestEvent, u64>,
        export: Handle<'a, ExportBundle>,
        export_reaper: Handle<'a, ExportBundleReaperSchedule, u64>,
        battle: Handle<'a, crate::schema::Battle>,
    }

    /// Registers every index the shipped accounts / claim / cascade / export
    /// paths read or write through, opens writes on each table (post-state
    /// assertions, not the write wall, are this suite's oracle) and opens full
    /// scans ONLY where the shipped code scans (`playtest_event`,
    /// `battle_action`, the `export_bundle` count, the export reaper singleton).
    /// `battle` stays unregistered: its reads answer empty.
    fn world(fx: &Fixture) -> W<'_> {
        // Secondary indexes first (registration is per fixture, not per handle).
        let _ = fx
            .table_keyed::<GuestClaim, String>("guest_claim", "code", |r| r.code.clone())
            .unique();
        let _ = fx.table_keyed::<GuestClaimReaperSchedule, u64>(
            "guest_claim_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        );
        let _ = fx.table_keyed::<AccountDeletionReaperSchedule, u64>(
            "account_deletion_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        );
        let _ =
            fx.table_keyed::<PlayerSession, ConnectionId>("player_session", "connection_id", |r| {
                r.connection_id
            });
        let _ = fx.table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id);
        let _ = fx.table::<MonsterPub>("monster_pub", "owner_identity", |r| r.owner_identity);
        let _ = fx.table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id);
        let _ = fx.table_keyed::<PlayerQuestRow, u64>("player_quest", "pq_id", |r| r.pq_id);
        let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
        let _ = fx.table_keyed::<TradeOffer, u64>("trade_offer", "trade_id", |r| r.trade_id);
        let _ = fx.table_keyed::<TradeOfferReaperSchedule, u64>(
            "trade_offer_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        );
        let _ = fx.table::<BattleChallenge>("battle_challenge", "target", |r| r.target);
        let _ = fx.table_keyed::<BattleChallenge, u64>("battle_challenge", "challenge_id", |r| {
            r.challenge_id
        });
        let _ = fx.table_keyed::<BattleChallengeReaperSchedule, u64>(
            "battle_challenge_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        );
        let _ = fx.table_keyed::<ExportBundle, u64>("export_bundle", "chunk_id", |r| r.chunk_id);
        let _ = fx
            .table::<crate::schema::Battle>("battle", "opponent_identity", |r| r.opponent_identity);
        let _ = fx.table_keyed::<ExportBundle, i64>("export_bundle", "created_at_ms", |r| {
            r.created_at_ms
        });
        W {
            account: fx
                .table::<Account>("account", "identity", |r| r.identity)
                .unique()
                .writable()
                .scannable(),
            claim: fx
                .table::<GuestClaim>("guest_claim", "guest_identity", |r| r.guest_identity)
                .unique()
                .writable(),
            claim_reaper: fx
                .table::<GuestClaimReaperSchedule>(
                    "guest_claim_reaper_schedule",
                    "guest_identity",
                    |r| r.guest_identity,
                )
                .writable()
                .auto_inc(|r| r.scheduled_id, |r, v| r.scheduled_id = v),
            del_reaper: fx
                .table::<AccountDeletionReaperSchedule>(
                    "account_deletion_reaper_schedule",
                    "account_identity",
                    |r| r.account_identity,
                )
                .writable()
                .scannable()
                .auto_inc(|r| r.scheduled_id, |r, v| r.scheduled_id = v),
            player: fx
                .table::<Player>("player", "identity", |r| r.identity)
                .writable(),
            session: fx
                .table::<PlayerSession>("player_session", "identity", |r| r.identity)
                .writable(),
            monster: fx
                .table::<Monster>("monster", "owner_identity", |r| r.owner_identity)
                .writable(),
            monster_pub: fx
                .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
                .writable(),
            notice: fx
                .table::<PendingEvolutionNotice>(
                    "pending_evolution_notice",
                    "owner_identity",
                    |r| r.owner_identity,
                )
                .writable(),
            inventory: fx
                .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
                .writable(),
            quest: fx
                .table::<PlayerQuestRow>("player_quest", "owner_identity", |r| r.owner_identity)
                .writable(),
            dialogue: fx
                .table::<PlayerDialogueStateRow>("player_dialogue_state", "owner_identity", |r| {
                    r.owner_identity
                })
                .writable(),
            conversation: fx
                .table::<PlayerConversation>("player_conversation", "owner_identity", |r| {
                    r.owner_identity
                })
                .writable(),
            heal: fx
                .table::<HealCooldown>("heal_cooldown", "owner_identity", |r| r.owner_identity)
                .writable(),
            wallet: fx
                .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
                .writable(),
            profile: fx
                .table::<Profile>("profile", "identity", |r| r.identity)
                .writable(),
            character: fx
                .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
                .writable(),
            trade: fx
                .table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator)
                .writable(),
            trade_reaper: fx
                .table_keyed::<TradeOfferReaperSchedule, u64>(
                    "trade_offer_reaper_schedule",
                    "trade_id",
                    |r| r.trade_id,
                )
                .writable(),
            challenge: fx
                .table::<BattleChallenge>("battle_challenge", "challenger", |r| r.challenger)
                .writable(),
            challenge_reaper: fx
                .table_keyed::<BattleChallengeReaperSchedule, u64>(
                    "battle_challenge_reaper_schedule",
                    "challenge_id",
                    |r| r.challenge_id,
                )
                .writable(),
            action: fx
                .table_keyed::<BattleAction, u64>("battle_action", "action_id", |r| r.action_id)
                .writable()
                .scannable(),
            playtest: fx
                .table_keyed::<PlaytestEvent, u64>("playtest_event", "event_id", |r| r.event_id)
                .writable()
                .scannable(),
            export: fx
                .table::<ExportBundle>("export_bundle", "owner_identity", |r| r.owner_identity)
                .writable()
                .scannable()
                .auto_inc(|r| r.chunk_id, |r, v| r.chunk_id = v),
            export_reaper: fx
                .table_keyed::<ExportBundleReaperSchedule, u64>(
                    "export_bundle_reaper_schedule",
                    "id",
                    |r| r.id,
                )
                .writable()
                .scannable()
                .auto_inc(|r| r.id, |r, v| r.id = v),
            battle: fx
                .table::<crate::schema::Battle>("battle", "player_identity", |r| r.player_identity)
                .writable(),
        }
    }

    // --- rows ----------------------------------------------------------------

    fn monster_row(monster_id: u64, owner: Identity) -> Monster {
        Monster {
            monster_id,
            owner_identity: owner,
            species_id: 1,
            nickname: format!("mon-{monster_id}"),
            level: 12,
            xp: 900,
            iv_hp: 11,
            iv_attack: 12,
            iv_defense: 13,
            iv_speed: 14,
            iv_sp_attack: 15,
            iv_sp_defense: 16,
            nature_kind: game_core::NatureKind::Hardy,
            ev_hp: 1,
            ev_attack: 2,
            ev_defense: 3,
            ev_speed: 4,
            ev_sp_attack: 5,
            ev_sp_defense: 6,
            stat_hp: 40,
            stat_attack: 41,
            stat_defense: 42,
            stat_speed: 43,
            stat_sp_attack: 44,
            stat_sp_defense: 45,
            current_hp: 39,
            party_slot: 0,
            last_care_at_ms: 7,
            essence_fire: 1,
            essence_water: 0,
            essence_plant: 0,
            essence_electric: 0,
            essence_earth: 0,
            essence_wind: 0,
            essence_light: 0,
            essence_dark: 0,
            trust_favorable_count: 3,
            trust_unfavorable_count: 1,
            trust_favorable_battle_day_epoch: 0,
            quality_time_ticks_total: 5,
            quality_time_accum_ms: 0,
            quality_time_window_ms: 0,
            quality_time_window_start_ms: 0,
            last_essence_train_at_ms: 0,
        }
    }

    fn player_row(who: Identity, entity_id: u64, name: &str) -> Player {
        Player {
            identity: who,
            entity_id,
            name: name.to_string(),
            online: true,
            last_input_seq: 0,
        }
    }

    fn character_row(entity_id: u64) -> Character {
        Character {
            entity_id,
            zone_id: 0,
            tile_x: 1,
            tile_y: 2,
            facing: game_core::Direction::South,
            action: game_core::ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: Vec::new(),
        }
    }

    fn trade_row(trade_id: u64, initiator: Identity, counterparty: Identity) -> TradeOffer {
        TradeOffer {
            trade_id,
            initiator,
            counterparty,
            initiator_monster_ids: vec![],
            initiator_items: vec![],
            initiator_currency: 5,
            counterparty_monster_ids: vec![],
            counterparty_items: vec![],
            counterparty_currency: 0,
            initiator_cards: vec![],
            counterparty_cards: vec![],
            status: game_core::TradeStatus::Pending,
            created_at_ms: 1,
        }
    }

    fn challenge_row(
        challenge_id: u64,
        challenger: Identity,
        target: Identity,
        status: ChallengeStatus,
    ) -> BattleChallenge {
        BattleChallenge {
            challenge_id,
            challenger,
            target,
            challenger_party_ids: vec![],
            status,
            created_at_ms: 1,
        }
    }

    fn export_row(chunk_id: u64, owner: Identity, stamp: i64) -> ExportBundle {
        ExportBundle {
            chunk_id,
            owner_identity: owner,
            request_id: stamp as u64,
            table_name: "monster".to_string(),
            chunk_index: 0,
            total_chunks: 1,
            payload_json: "{}".to_string(),
            created_at_ms: stamp,
        }
    }

    /// An ONGOING PvP battle between `player` and `opponent`.
    fn battle_row(player: Identity, opponent: Identity) -> crate::schema::Battle {
        let lead = game_core::BattleMonster {
            species_id: 1,
            affinity: game_core::Affinity::Fire,
            level: 7,
            current_hp: 30,
            max_hp: 30,
            stats: game_core::StatBlock {
                hp: 30,
                attack: 20,
                defense: 20,
                speed: 20,
                sp_attack: 20,
                sp_defense: 20,
            },
            known_skill_ids: vec![1],
            status: None,
        };
        crate::schema::Battle {
            battle_id: 900,
            player_identity: player,
            opponent_identity: opponent,
            state: game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![lead.clone()],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![lead],
                },
                outcome: game_core::BattleOutcome::Ongoing,
                turn_number: 1,
                weather: None,
            },
            party_monster_ids: vec![],
            opponent_monster_ids: vec![],
            created_at_ms: 1,
        }
    }

    /// One row in each of the NINE re-key tables (monster + its projection,
    /// notice, inventory, quest, dialogue, heal cooldown, wallet, profile).
    /// `k` keeps auto-inc keys and values distinct per owner.
    fn seed_rekey_rows(w: &W<'_>, who: Identity, k: u64) {
        let m = monster_row(100 + k, who);
        w.monster_pub.seed(&crate::marshal::pub_from_monster(&m, 0));
        w.monster.seed(&m);
        w.notice.seed(&PendingEvolutionNotice {
            owner_identity: who,
            entries: vec![EvolutionRevealRow {
                monster_id: 100 + k,
                from_species: 1,
                to_species: 2,
                evolved_at_ms: 3,
            }],
        });
        w.inventory.seed(&Inventory {
            inv_id: 200 + k,
            owner_identity: who,
            item_id: 4,
            count: 5 + k as u32,
        });
        w.quest.seed(&PlayerQuestRow {
            pq_id: 300 + k,
            owner_identity: who,
            quest_id: format!("q{k}"),
            step_index: 1,
        });
        w.dialogue.seed(&PlayerDialogueStateRow {
            owner_identity: who,
            flags: vec![format!("flag{k}")],
            done_quests: vec![],
        });
        w.heal.seed(&HealCooldown {
            owner_identity: who,
            last_heal_at_ms: 40 + k as i64,
        });
        w.wallet.seed(&PlayerWallet {
            owner_identity: who,
            balance: 1000 + k,
        });
        w.profile.seed(&Profile {
            identity: who,
            name: format!("p{k}"),
            rating: 1500 + k as i32,
            wins: 7,
            losses: 2,
        });
    }

    /// Every row that names `who` in an owner / participant column, per table,
    /// as sorted canonical bytes — the unit a bystander must survive unchanged
    /// and an erased identity must leave only in its Anonymize tables.
    fn owned_by(w: &W<'_>, who: Identity) -> Vec<(&'static str, Vec<Vec<u8>>)> {
        vec![
            (
                "account",
                encs(
                    &w.account
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "player",
                encs(
                    &w.player
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "profile",
                encs(
                    &w.profile
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "monster",
                encs(
                    &w.monster
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "monster_pub",
                encs(
                    &w.monster_pub
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "pending_evolution_notice",
                encs(
                    &w.notice
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "inventory",
                encs(
                    &w.inventory
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "player_quest",
                encs(
                    &w.quest
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "player_dialogue_state",
                encs(
                    &w.dialogue
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "player_conversation",
                encs(
                    &w.conversation
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "heal_cooldown",
                encs(
                    &w.heal
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "player_wallet",
                encs(
                    &w.wallet
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "playtest_event",
                encs(
                    &w.playtest
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "trade_offer",
                encs(
                    &w.trade
                        .rows()
                        .into_iter()
                        .filter(|r| r.initiator == who || r.counterparty == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "battle_challenge",
                encs(
                    &w.challenge
                        .rows()
                        .into_iter()
                        .filter(|r| r.challenger == who || r.target == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "battle_action",
                encs(
                    &w.action
                        .rows()
                        .into_iter()
                        .filter(|r| r.player_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "export_bundle",
                encs(
                    &w.export
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "player_session",
                encs(
                    &w.session
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
        ]
    }

    fn owned_tables(snapshot: &[(&'static str, Vec<Vec<u8>>)]) -> Vec<&'static str> {
        snapshot
            .iter()
            .filter(|(_, rows)| !rows.is_empty())
            .map(|(t, _)| *t)
            .collect()
    }

    // --- #auth: provisioning on connect ---------------------------------------

    /// `on_connect` (lib.rs) over REAL client connections. An anonymous
    /// connection plays (Ok, no account row) and records its session; a token
    /// from an unrecognised ISSUER falls back to anonymous (Ok, no row — the
    /// host's own token path must never disconnect); an allowed issuer with an
    /// unrecognised AUDIENCE is a confused-deputy token and is refused (Err, no
    /// row); only both allowed provisions a fresh Active row. A reconnect only
    /// touches `last_login_at_ms`; a TERMINAL account re-registers fresh. A
    /// bystander's row is never touched.
    ///
    /// kills: issuer or audience check dropped / inverted / swapped in order;
    /// the Err on a bad audience turned into Ok; provisioning on the anonymous
    /// path; `touch_login` replaced by a fresh row (or the reverse); the
    /// terminal branch carrying pre-deletion state forward; a session write
    /// skipped for anonymous connections.
    #[test]
    fn acct_on_connect_provisions_only_an_allowed_issuer_and_audience() {
        let fx = fixture();
        let w = world(&fx);
        let me = id(0x11);
        let bystander = id(0x12);
        let bystander_row = crate::accounts::new_account_row(bystander, "b".to_string(), 5);
        w.account.seed(&bystander_row);
        let iss = crate::accounts::ALLOWED_ISSUERS[0];
        let aud = crate::accounts::ALLOWED_AUDIENCE[0];
        let mine = |w: &W<'_>| {
            w.account
                .rows()
                .into_iter()
                .filter(|r| r.identity == me)
                .collect::<Vec<_>>()
        };

        // Anonymous: plays, records its session, no account row.
        let got = as_conn(&fx, me, None, T0, crate::on_connect);
        assert_eq!(got, Ok(()), "an anonymous connection must be accepted");
        assert!(
            mine(&w).is_empty(),
            "an anonymous connection must not provision"
        );
        let sessions = w.session.rows();
        assert_eq!(
            sessions.len(),
            1,
            "the anonymous connection's session is recorded"
        );
        assert_eq!(sessions[0].identity, me);
        assert_eq!(sessions[0].connection_id.to_u128(), conn_of(me));

        // Unrecognised issuer: fail SAFE to anonymous.
        let foreign = claims("issuer.elsewhere.example", &format!("\"{aud}\""));
        let got = as_conn(&fx, me, Some(&foreign), T0 + 1, crate::on_connect);
        assert_eq!(
            got,
            Ok(()),
            "a foreign issuer must fall back to anonymous, never disconnect"
        );
        assert!(
            mine(&w).is_empty(),
            "a foreign issuer must not provision an account"
        );

        // Allowed issuer, unrecognised audience: refused.
        let deputy = claims(iss, "\"some-other-app\"");
        let got = as_conn(&fx, me, Some(&deputy), T0 + 2, crate::on_connect);
        assert_eq!(
            got,
            Err(crate::accounts::REJECT_UNRECOGNIZED_AUDIENCE.to_string()),
            "an allowed issuer with a foreign audience must be refused"
        );
        assert!(
            mine(&w).is_empty(),
            "a refused token must not provision an account"
        );

        // Both allowed (audience as an array containing ours): provisioned fresh.
        let ok = claims(iss, &format!("[\"x\",\"{aud}\"]"));
        let got = as_conn(&fx, me, Some(&ok), T0 + 3, crate::on_connect);
        assert_eq!(got, Ok(()));
        let created = crate::accounts::new_account_row(me, iss.to_string(), T0 + 3);
        assert_eq!(
            encs(&mine(&w)),
            encs(std::slice::from_ref(&created)),
            "exactly one fresh Active row"
        );

        // Reconnect: last_login only.
        let got = as_conn(&fx, me, Some(&ok), T0 + 100, crate::on_connect);
        assert_eq!(got, Ok(()));
        let touched = crate::accounts::touch_login(created.clone(), T0 + 100);
        assert_eq!(
            encs(&mine(&w)),
            encs(std::slice::from_ref(&touched)),
            "a reconnect touches last_login only"
        );

        // Terminal account: re-registers fresh (nothing carried forward).
        let terminal = crate::accounts::terminal_account(
            crate::accounts::anonymized_account(crate::accounts::requested_deletion(
                crate::accounts::claimed_account(touched, id(0x13), T0 + 101),
                T0 + 102,
            )),
            T0 + 103,
        );
        assert_eq!(w.account.remove(me), 1);
        w.account.seed(&terminal);
        let got = as_conn(&fx, me, Some(&ok), T0 + 200, crate::on_connect);
        assert_eq!(got, Ok(()));
        assert_eq!(
            encs(&mine(&w)),
            encs(&[crate::accounts::new_account_row(
                me,
                iss.to_string(),
                T0 + 200
            )]),
            "a terminal account re-registers with every field at its fresh default"
        );

        assert_eq!(
            encs(
                &w.account
                    .rows()
                    .into_iter()
                    .filter(|r| r.identity == bystander)
                    .collect::<Vec<_>>()
            ),
            encs(&[bystander_row]),
            "a bystander's account row is never touched"
        );
        assert_eq!(
            w.session.rows().len(),
            1,
            "one connection id, one session row"
        );
    }

    /// `on_disconnect` (lib.rs) over REAL connections: a disconnect deletes only
    /// its OWN session row; while another of the identity's connections is
    /// live it does nothing else; the LAST disconnect removes the presence rows
    /// (player, its character, the conversation). A stranger is untouched.
    ///
    /// kills: the own-row delete dropped or keyed on the identity (a sibling
    /// tab's row goes too); the live-session guard dropped (a second tab's
    /// close wipes the first tab's presence) or inverted (presence never
    /// cleaned); presence deletes keyed on the wrong identity.
    #[test]
    fn acct_on_disconnect_closes_its_own_session_and_waits_for_the_last() {
        let fx = fixture();
        let w = world(&fx);
        let me = id(0x15);
        let stranger = id(0x16);
        let sibling_conn: u128 = 0x5E55_9999;
        for (who, entity) in [(me, 5u64), (stranger, 6)] {
            w.player.seed(&player_row(who, entity, "p"));
            w.character.seed(&character_row(entity));
            w.conversation.seed(&PlayerConversation {
                owner_identity: who,
                npc_entity_id: 1,
                current_node_id: "n".to_string(),
            });
            w.session.seed(&PlayerSession {
                connection_id: ConnectionId::from_u128(conn_of(who)),
                identity: who,
            });
        }
        w.session.seed(&PlayerSession {
            connection_id: ConnectionId::from_u128(sibling_conn),
            identity: me,
        });
        let stranger_before = owned_by(&w, stranger);
        let conns = |w: &W<'_>| {
            let mut c: Vec<u128> = w
                .session
                .rows()
                .into_iter()
                .filter(|r| r.identity == me)
                .map(|r| r.connection_id.to_u128())
                .collect();
            c.sort_unstable();
            c
        };

        as_conn(&fx, me, None, T0, crate::on_disconnect);
        assert_eq!(
            conns(&w),
            vec![sibling_conn],
            "only the closing connection's row goes"
        );
        assert_eq!(
            owned_tables(&owned_by(&w, me)),
            vec!["player", "player_conversation", "player_session"],
            "a live sibling connection keeps every presence row"
        );
        assert!(w.character.rows().iter().any(|r| r.entity_id == 5));

        fx.run_as_conn_at(me, sibling_conn, None, at(T0 + 1), crate::on_disconnect);
        assert!(conns(&w).is_empty());
        assert!(
            owned_tables(&owned_by(&w, me)).is_empty(),
            "the last disconnect removes the presence rows"
        );
        assert!(w.character.rows().iter().all(|r| r.entity_id != 5));
        assert_eq!(
            owned_by(&w, stranger),
            stranger_before,
            "a stranger is untouched"
        );
        assert!(w.character.rows().iter().any(|r| r.entity_id == 6));
    }

    // --- guest claim ----------------------------------------------------------

    /// Seed a LIVE claim for `guest` (as `start_guest_claim` would write it at
    /// `T0`) plus its armed reaper row.
    fn seed_live_claim(w: &W<'_>, guest: Identity, c: &str, scheduled_id: u64) -> GuestClaim {
        let row = crate::accounts::claim_row(guest, c.to_string(), "guest".to_string(), T0);
        w.claim.seed(&row);
        w.claim_reaper.seed(&GuestClaimReaperSchedule {
            scheduled_id,
            scheduled_at: ScheduleAt::Time(at(row.expires_at_ms)),
            guest_identity: guest,
        });
        row
    }

    /// `start_guest_claim` binds a CLIENT-minted code to the anonymous caller:
    /// one claim row (`claim_row` at the injected clock, name snapshotted from
    /// the caller's `player` row) and exactly one reaper armed at the row's own
    /// expiry. Starting again REPLACES both (still one of each). An account
    /// holder, a malformed code and a caller with no player row are refused
    /// before any write; another guest's claim is never touched.
    ///
    /// kills: the holder / charset / joined guards dropped; insert-before-delete
    /// on replace (two claims or two reapers); the reaper armed at a second
    /// clock read or not at all; a replace that disarms another guest's reaper.
    #[test]
    fn acct_start_guest_claim_binds_one_code_and_one_reaper() {
        let fx = fixture();
        let w = world(&fx);
        let g = id(0x21);
        let other = id(0x22);
        let other_claim = seed_live_claim(&w, other, &code('e'), 900);
        w.player.seed(&player_row(g, 1, "Guesty"));

        assert_eq!(
            fx.run_as_at(g, at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                "0123".to_string()
            )),
            Err("invalid claim code".to_string())
        );
        assert_eq!(
            fx.run_as_at(id(0x23), at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                code('a')
            )),
            Err("not joined".to_string())
        );
        let holder = id(0x24);
        w.account.seed(&crate::accounts::new_account_row(
            holder,
            "i".to_string(),
            1,
        ));
        w.player.seed(&player_row(holder, 2, "Holder"));
        assert_eq!(
            fx.run_as_at(holder, at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                code('a')
            )),
            Err("already signed in".to_string())
        );
        assert_eq!(w.claim.rows().len(), 1, "a refused start writes no claim");
        assert_eq!(
            w.claim_reaper.rows().len(),
            1,
            "a refused start arms no reaper"
        );

        for (n, (c, ms)) in [(code('a'), T0), (code('b'), T0 + 500)]
            .into_iter()
            .enumerate()
        {
            let got = fx.run_as_at(g, at(ms), |ctx| {
                crate::accounts::start_guest_claim(ctx, c.clone())
            });
            assert_eq!(got, Ok(()), "start #{n} must succeed");
            let mine: Vec<GuestClaim> = w
                .claim
                .rows()
                .into_iter()
                .filter(|r| r.guest_identity == g)
                .collect();
            let want = crate::accounts::claim_row(g, c.clone(), "Guesty".to_string(), ms);
            assert_eq!(
                encs(&mine),
                encs(std::slice::from_ref(&want)),
                "start #{n}: exactly one claim, the latest"
            );
            let reapers: Vec<GuestClaimReaperSchedule> = w
                .claim_reaper
                .rows()
                .into_iter()
                .filter(|r| r.guest_identity == g)
                .collect();
            assert_eq!(reapers.len(), 1, "start #{n}: exactly one armed reaper");
            assert_eq!(fire_at(&reapers[0].scheduled_at), at(want.expires_at_ms));
        }
        let others: Vec<GuestClaim> = w
            .claim
            .rows()
            .into_iter()
            .filter(|r| r.guest_identity == other)
            .collect();
        assert_eq!(
            encs(&others),
            encs(&[other_claim]),
            "another guest's claim survives"
        );
        assert_eq!(
            w.claim_reaper
                .rows()
                .into_iter()
                .filter(|r| r.guest_identity == other)
                .count(),
            1,
            "another guest's reaper survives"
        );
    }

    /// Every CALLER-state guard of `complete_guest_claim` answers the same
    /// reason for a live code, an unknown well-formed code and a malformed one
    /// — so an unauthorised caller can never use the reducer as a claim-code
    /// oracle — and none of them writes. Then the code-resolution guards, each
    /// with the caller otherwise admissible: unknown / malformed code, expiry
    /// (the claim row is LEFT for the reaper), own session, guest still online,
    /// destination already has game data. Nothing moves in any of them.
    ///
    /// kills: any caller guard moved below code resolution (the live-code and
    /// unknown-code answers diverge); a guard dropped (the next guard's reason
    /// appears); expiry cleanup inside the reducer; the liveness / own-session /
    /// has-data guards dropped (the claim would complete and rows would move).
    #[test]
    fn acct_complete_guest_claim_refuses_before_resolving_the_code() {
        let fx = fixture();
        let w = world(&fx);
        let g = id(0x31);
        let c = id(0x32);
        let live = code('c');
        let claim = seed_live_claim(&w, g, &live, 1);
        w.monster.seed(&monster_row(77, g));
        w.monster_pub
            .seed(&crate::marshal::pub_from_monster(&monster_row(77, g), 0));
        let before_g = owned_by(&w, g);
        let active = crate::accounts::new_account_row(c, "i".to_string(), 1);
        let pending = crate::accounts::requested_deletion(active.clone(), 2);
        let terminal = crate::accounts::terminal_account(pending.clone(), 3);
        let claimed = crate::accounts::claimed_account(active.clone(), id(0x33), 4);
        let codes = [live.clone(), code('d'), "not-a-code".to_string()];

        let states: [(&str, Option<Account>, bool, String); 5] = [
            (
                "no JWT",
                Some(active.clone()),
                false,
                "sign in required".to_string(),
            ),
            ("no account", None, true, "no account".to_string()),
            (
                "terminal",
                Some(terminal),
                true,
                crate::accounts::REJECT_ALREADY_DELETED.to_string(),
            ),
            (
                "mid-grace",
                Some(pending),
                true,
                "account pending deletion".to_string(),
            ),
            (
                "already claimed",
                Some(claimed),
                true,
                "account already claimed".to_string(),
            ),
        ];
        for (label, row, jwt, reason) in states {
            w.account.remove(c);
            if let Some(row) = row {
                w.account.seed(&row);
            }
            for k in &codes {
                let token = good_jwt();
                let got = as_conn(&fx, c, jwt.then_some(token.as_str()), T0 + 10, |ctx| {
                    crate::accounts::complete_guest_claim(ctx, k.clone())
                });
                assert_eq!(
                    got,
                    Err(reason.clone()),
                    "caller state `{label}` must answer `{reason}` for code {k:?} — the same \
                     answer for a live and an unknown code, or the reducer is a code oracle"
                );
            }
        }
        w.account.remove(c);
        w.account.seed(&active);

        let resolve = |k: &str, ms: i64| {
            signed_in(&fx, c, ms, |ctx| {
                crate::accounts::complete_guest_claim(ctx, k.to_string())
            })
        };
        let invalid = Err(crate::accounts::ERR_INVALID_CODE.to_string());
        assert_eq!(resolve("not-a-code", T0 + 10), invalid);
        assert_eq!(
            resolve(&code('d'), T0 + 10),
            invalid,
            "an unknown code has the same answer"
        );
        assert_eq!(
            resolve(&live, claim.expires_at_ms),
            Err("code expired".to_string()),
            "expiry is inclusive at expires_at_ms"
        );
        assert_eq!(
            w.claim.rows().len(),
            1,
            "an expired claim is left for the reaper"
        );

        // Own session: the guest itself, signed in.
        w.account
            .seed(&crate::accounts::new_account_row(g, "i".to_string(), 1));
        assert_eq!(
            signed_in(
                &fx,
                g,
                T0 + 10,
                |ctx| crate::accounts::complete_guest_claim(ctx, live.clone())
            ),
            Err("cannot claim your own session".to_string())
        );
        assert_eq!(w.account.remove(g), 1);

        // Guest still online.
        w.player.seed(&player_row(g, 5, "guest"));
        assert_eq!(
            resolve(&live, T0 + 10),
            Err("close your other tab, then retry".to_string())
        );
        assert_eq!(w.player.remove(g), 1);

        // Either party mid-battle (guard 10): a live PvP battle naming the GUEST
        // as player, then one naming the CLAIMER as opponent.
        for (player, opponent) in [(g, id(0x3A)), (id(0x3A), c)] {
            w.battle.seed(&battle_row(player, opponent));
            assert_eq!(
                resolve(&live, T0 + 10),
                Err("already in an ongoing battle".to_string()),
                "a claim must wait while EITHER party is in an ongoing battle"
            );
            assert_eq!(w.battle.remove(player), 1);
        }

        // Destination already owns game data.
        w.inventory.seed(&Inventory {
            inv_id: 9,
            owner_identity: c,
            item_id: 1,
            count: 1,
        });
        assert_eq!(
            resolve(&live, T0 + 10),
            Err("already has game data".to_string())
        );
        assert_eq!(w.inventory.remove(c), 1);

        assert_eq!(owned_by(&w, g), before_g, "no refusal moved any guest row");
        assert_eq!(
            encs(&w.claim.rows()),
            encs(&[claim]),
            "no refusal consumed the claim"
        );
        assert_eq!(
            w.claim_reaper.rows().len(),
            1,
            "no refusal disarmed the reaper"
        );
        assert_eq!(
            owned_tables(&owned_by(&w, c)),
            vec!["account"],
            "the caller gained nothing"
        );
    }

    /// The whole guest→account claim, through the shipped reducers: the guest
    /// starts a claim, disconnects, and a signed-in fresh account completes it.
    /// Every re-key table moves onto the claimer (moves leave NOTHING under the
    /// guest; the two copy-forward re-keys leave the guest's wallet at zero and
    /// its profile tombstoned), the guest's export chunks are purged, the code
    /// and its reaper are consumed, provenance is stamped. A second account
    /// replaying the SAME code gets the no-oracle invalid-code answer and gains
    /// nothing; the claimer can never claim a second guest. A bystander's rows
    /// never move.
    ///
    /// kills: single-use broken (claim row or reaper left behind, or a replay
    /// that re-keys again); any `rekey_*` dropped from `rekey_all`; a
    /// copy-forward re-key that does not zero the guest (currency / rating
    /// minted per replay); the claim-time export purge dropped; provenance not
    /// stamped (AUTH-14 one-claim-per-account then fails open).
    #[test]
    fn acct_guest_claim_round_trip_moves_every_row_and_spends_the_code() {
        let fx = fixture();
        let w = world(&fx);
        let g = id(0x41);
        let c = id(0x42);
        let c2 = id(0x43);
        let b = id(0x44);
        let secret = code('7');

        w.player.seed(&player_row(g, 1, "Guesty"));
        assert_eq!(
            fx.run_as_at(g, at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                secret.clone()
            )),
            Ok(())
        );
        assert_eq!(
            w.player.remove(g),
            1,
            "the guest disconnects (presence row gone)"
        );

        seed_rekey_rows(&w, g, 1);
        seed_rekey_rows(&w, b, 2);
        w.export.seed(&export_row(1, g, T0 - 5));
        w.export.seed(&export_row(2, b, T0 - 5));
        let guest_before = owned_by(&w, g);
        let bystander_before = owned_by(&w, b);
        let row_of = |t: &str, snap: &[(&'static str, Vec<Vec<u8>>)]| {
            snap.iter()
                .find(|(n, _)| *n == t)
                .map(|(_, r)| r.clone())
                .unwrap()
        };

        let active = crate::accounts::new_account_row(c, "i".to_string(), 1);
        w.account.seed(&active);
        let done = T0 + 1_000;
        assert_eq!(
            signed_in(&fx, c, done, |ctx| crate::accounts::complete_guest_claim(
                ctx,
                secret.clone()
            )),
            Ok(())
        );

        // Moves: the guest keeps nothing; the claimer holds the same rows re-owned.
        let m = monster_row(101, c);
        assert_eq!(
            row_of("monster", &owned_by(&w, c)),
            encs(std::slice::from_ref(&m)),
            "the guest's monster is re-owned, nothing else about it changed"
        );
        assert_eq!(
            row_of("monster_pub", &owned_by(&w, c)),
            encs(&[crate::marshal::pub_from_monster(&m, 0)]),
            "the public projection follows its monster"
        );
        for t in [
            "monster",
            "monster_pub",
            "pending_evolution_notice",
            "inventory",
            "player_quest",
            "player_dialogue_state",
            "heal_cooldown",
            "export_bundle",
        ] {
            assert!(
                row_of(t, &owned_by(&w, g)).is_empty(),
                "`{t}`: no row may stay under the retired guest identity"
            );
            if t != "export_bundle" {
                assert_eq!(
                    row_of(t, &owned_by(&w, c)).len(),
                    row_of(t, &guest_before).len(),
                    "`{t}`: every guest row must arrive under the claimer"
                );
            }
        }
        // Copy-forward re-keys: the guest row is RETAINED but emptied.
        let wallet = |who: Identity| {
            w.wallet
                .rows()
                .into_iter()
                .find(|r| r.owner_identity == who)
                .map(|r| r.balance)
        };
        assert_eq!(
            wallet(c),
            Some(1001),
            "the claimer is credited the guest's balance"
        );
        assert_eq!(
            wallet(g),
            Some(0),
            "the guest's wallet is zeroed in place, never deleted"
        );
        let profile = |who: Identity| {
            w.profile
                .rows()
                .into_iter()
                .find(|r| r.identity == who)
                .unwrap()
        };
        let (pc, pg) = (profile(c), profile(g));
        assert_eq!(
            (pc.rating, pc.wins, pc.losses),
            (1501, 7, 2),
            "stats carry to the claimer"
        );
        assert_eq!(
            (pg.rating, pg.wins, pg.losses),
            (0, 0, 0),
            "the guest's profile is tombstoned"
        );

        // Single use.
        assert!(w.claim.rows().is_empty(), "the claim row is consumed");
        assert!(w.claim_reaper.rows().is_empty(), "its reaper is disarmed");
        assert_eq!(
            encs(
                &w.account
                    .rows()
                    .into_iter()
                    .filter(|r| r.identity == c)
                    .collect::<Vec<_>>()
            ),
            encs(&[crate::accounts::claimed_account(active, g, done)]),
            "provenance is stamped on the claimer's account"
        );
        let claimer_after = owned_by(&w, c);

        w.account
            .seed(&crate::accounts::new_account_row(c2, "i".to_string(), 1));
        assert_eq!(
            signed_in(&fx, c2, done + 1, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Err(crate::accounts::ERR_INVALID_CODE.to_string()),
            "a spent code answers exactly like a code that never existed"
        );
        assert_eq!(
            owned_tables(&owned_by(&w, c2)),
            vec!["account"],
            "the replayer gains nothing"
        );
        assert_eq!(owned_by(&w, c), claimer_after, "a replay moves nothing");

        let g2 = id(0x45);
        seed_live_claim(&w, g2, &code('8'), 50);
        assert_eq!(
            signed_in(&fx, c, done + 2, |ctx| {
                crate::accounts::complete_guest_claim(ctx, code('8'))
            }),
            Err("account already claimed".to_string()),
            "one claim per account, ever"
        );
        assert_eq!(
            owned_by(&w, b),
            bystander_before,
            "a bystander's rows never move"
        );
    }

    /// The re-key roster against the lifecycle manifest: every owner-keyed
    /// (Erase / Anonymize) table is classified exactly once as either RE-KEYED
    /// by `rekey_all` or deliberately left behind, so a new owner-keyed table
    /// cannot ship without a claim-flow decision. (The manifest itself is tied
    /// to the tables' real derive metadata, wrappers included, by
    /// `m22s6_owner_keyed_tables_are_erase_or_anonymize`.) Then the exists-half:
    /// a row in ANY re-keyed table makes `account_has_game_data` true, so a
    /// claim can never overwrite a destination that already plays.
    ///
    /// kills: a `has_*` delegate dropped from `account_has_game_data`; a new
    /// owner-keyed table added to the manifest without a re-key decision.
    #[test]
    fn acct_rekey_roster_is_total_and_game_data_sees_every_rekeyed_table() {
        const REKEYED: [&str; 9] = [
            "monster",
            "monster_pub",
            "pending_evolution_notice",
            "inventory",
            "player_quest",
            "player_dialogue_state",
            "heal_cooldown",
            "player_wallet",
            "profile",
        ];
        // Left under the guest on purpose: presence / session rows die with the
        // connection (guard 9), live interactions block the claim (guard 10),
        // telemetry and the export store are not game data, and the account is
        // the claimer's own.
        const NOT_REKEYED: [&str; 10] = [
            "player",
            "player_conversation",
            "player_session",
            "battle",
            "battle_action",
            "trade_offer",
            "battle_challenge",
            "playtest_event",
            "export_bundle",
            "account",
        ];
        let mut owner_keyed: Vec<&str> = DATA_LIFECYCLE_MANIFEST
            .iter()
            .filter(|e| matches!(e.policy, DeletionPolicy::Erase | DeletionPolicy::Anonymize))
            .map(|e| e.table)
            .collect();
        owner_keyed.sort_unstable();
        let mut classified: Vec<&str> = REKEYED.iter().chain(NOT_REKEYED.iter()).copied().collect();
        classified.sort_unstable();
        assert_eq!(
            classified, owner_keyed,
            "every Erase/Anonymize table needs exactly one claim-flow classification"
        );

        let fx = fixture();
        let w = world(&fx);
        let g = id(0x51);
        let no_data = fx.run_as(g, |ctx| crate::accounts::account_has_game_data(ctx, g));
        assert!(!no_data, "an identity with no rows has no game data");
        seed_rekey_rows(&w, g, 3);
        let wipe = |w: &W<'_>| {
            w.monster.remove(g);
            w.monster_pub.remove(103);
            w.notice.remove(g);
            w.inventory.remove(g);
            w.quest.remove(g);
            w.dialogue.remove(g);
            w.heal.remove(g);
            w.wallet.remove(g);
            w.profile.remove(g);
        };
        wipe(&w);
        assert!(owned_tables(&owned_by(&w, g)).is_empty());
        let singles: [(&str, &dyn Fn()); 8] = [
            ("monster", &|| w.monster.seed(&monster_row(103, g))),
            ("pending_evolution_notice", &|| {
                w.notice.seed(&PendingEvolutionNotice {
                    owner_identity: g,
                    entries: vec![],
                })
            }),
            ("inventory", &|| {
                w.inventory.seed(&Inventory {
                    inv_id: 1,
                    owner_identity: g,
                    item_id: 1,
                    count: 1,
                })
            }),
            ("player_quest", &|| {
                w.quest.seed(&PlayerQuestRow {
                    pq_id: 1,
                    owner_identity: g,
                    quest_id: "q".to_string(),
                    step_index: 0,
                })
            }),
            ("player_dialogue_state", &|| {
                w.dialogue.seed(&PlayerDialogueStateRow {
                    owner_identity: g,
                    flags: vec![],
                    done_quests: vec![],
                })
            }),
            ("heal_cooldown", &|| {
                w.heal.seed(&HealCooldown {
                    owner_identity: g,
                    last_heal_at_ms: 1,
                })
            }),
            ("player_wallet", &|| {
                w.wallet.seed(&PlayerWallet {
                    owner_identity: g,
                    balance: 0,
                })
            }),
            ("profile", &|| {
                w.profile.seed(&Profile {
                    identity: g,
                    name: String::new(),
                    rating: 0,
                    wins: 0,
                    losses: 0,
                })
            }),
        ];
        for (table, seed) in singles {
            seed();
            let has = fx.run_as(g, |ctx| crate::accounts::account_has_game_data(ctx, g));
            assert!(has, "a lone `{table}` row must count as game data");
            wipe(&w);
        }
    }

    // --- deletion lifecycle ----------------------------------------------------

    fn del_reapers_of(w: &W<'_>, who: Identity) -> Vec<AccountDeletionReaperSchedule> {
        w.del_reaper
            .rows()
            .into_iter()
            .filter(|r| r.account_identity == who)
            .collect()
    }

    /// `delete_account` / `cancel_account_deletion` through a signed-in client:
    /// delete stamps `PendingDeletion` at the injected clock and arms EXACTLY
    /// one grace reaper at `deletion_fire_at_ms` of that same stamp; a second
    /// delete re-stamps nothing and arms nothing; cancel restores `Active` and
    /// disarms only the caller's reaper; a second cancel is a no-op. JWT-less
    /// and account-less callers are refused before any write; a TERMINAL account
    /// cannot be re-armed (delete is an Ok no-op) or resurrected (cancel refuses).
    ///
    /// kills: a second arm on a repeated delete; a re-stamp that restarts the
    /// grace window; the fire instant from a second clock read; a cancel that
    /// leaves the reaper armed (the account is erased anyway) or disarms a
    /// stranger's; the terminal branches dropped.
    #[test]
    fn acct_delete_and_cancel_arm_and_disarm_exactly_once() {
        let fx = fixture();
        let w = world(&fx);
        let me = id(0x61);
        let other = id(0x62);
        let other_row = crate::accounts::requested_deletion(
            crate::accounts::new_account_row(other, "i".to_string(), 1),
            T0 - 10,
        );
        w.account.seed(&other_row);
        w.del_reaper.seed(&AccountDeletionReaperSchedule {
            scheduled_id: 500,
            scheduled_at: ScheduleAt::Time(at(crate::accounts::deletion_fire_at_ms(T0 - 10))),
            account_identity: other,
        });
        let delete = |ms: i64| signed_in(&fx, me, ms, crate::accounts::delete_account);
        let cancel = |ms: i64| signed_in(&fx, me, ms, crate::accounts::cancel_account_deletion);
        let mine = |w: &W<'_>| {
            w.account
                .rows()
                .into_iter()
                .filter(|r| r.identity == me)
                .collect::<Vec<_>>()
        };

        assert_eq!(delete(T0), Err("no account".to_string()));
        assert_eq!(cancel(T0), Err("no account".to_string()));
        let active = crate::accounts::new_account_row(me, "i".to_string(), 1);
        w.account.seed(&active);
        type Reducer = fn(&ReducerContext) -> Result<(), String>;
        let guarded: [Reducer; 2] = [
            crate::accounts::delete_account,
            crate::accounts::cancel_account_deletion,
        ];
        for f in guarded {
            assert_eq!(
                as_conn(&fx, me, None, T0, f),
                Err("sign in required".to_string())
            );
        }
        assert!(
            del_reapers_of(&w, me).is_empty(),
            "no refusal arms a reaper"
        );

        assert_eq!(delete(T0), Ok(()));
        let pending = crate::accounts::requested_deletion(active.clone(), T0);
        assert_eq!(encs(&mine(&w)), encs(std::slice::from_ref(&pending)));
        let armed = del_reapers_of(&w, me);
        assert_eq!(armed.len(), 1, "delete arms exactly one grace reaper");
        assert_eq!(
            fire_at(&armed[0].scheduled_at),
            at(crate::accounts::deletion_fire_at_ms(T0)),
            "the reaper fires at the grace end of the SAME stamp the row carries"
        );

        assert_eq!(delete(T0 + 5), Ok(()));
        assert_eq!(
            encs(&mine(&w)),
            encs(&[pending]),
            "a repeated delete never re-stamps"
        );
        assert_eq!(
            del_reapers_of(&w, me).len(),
            1,
            "a repeated delete never re-arms"
        );

        assert_eq!(cancel(T0 + 10), Ok(()));
        assert_eq!(
            encs(&mine(&w)),
            encs(std::slice::from_ref(&active)),
            "cancel restores Active"
        );
        assert!(
            del_reapers_of(&w, me).is_empty(),
            "cancel disarms the caller's reaper"
        );
        assert_eq!(cancel(T0 + 11), Ok(()), "a second cancel is a no-op");
        assert_eq!(encs(&mine(&w)), encs(std::slice::from_ref(&active)));

        let terminal = crate::accounts::terminal_account(
            crate::accounts::requested_deletion(active, T0 + 20),
            T0 + 30,
        );
        assert_eq!(w.account.remove(me), 1);
        w.account.seed(&terminal);
        assert_eq!(
            delete(T0 + 40),
            Ok(()),
            "delete on an erased account is an Ok no-op"
        );
        assert!(
            del_reapers_of(&w, me).is_empty(),
            "an erased account is never re-armed"
        );
        assert_eq!(
            cancel(T0 + 41),
            Err(crate::accounts::REJECT_ALREADY_DELETED.to_string()),
            "a completed erasure is not reversible"
        );
        assert_eq!(encs(&mine(&w)), encs(&[terminal]));

        assert_eq!(
            del_reapers_of(&w, other).len(),
            1,
            "a stranger's reaper survives"
        );
        assert_eq!(
            encs(
                &w.account
                    .rows()
                    .into_iter()
                    .filter(|r| r.identity == other)
                    .collect::<Vec<_>>()
            ),
            encs(&[other_row]),
            "a stranger's account survives"
        );
    }

    /// Seed one row for `who` in every Erase table, plus its Anonymize rows
    /// (player + character join, profile) — the cascade population.
    /// `k` keeps keys distinct; `peer` is the other party of the two-party rows.
    fn seed_cascade_population(w: &W<'_>, who: Identity, peer: Identity, k: u64) {
        seed_rekey_rows(w, who, k);
        w.player
            .seed(&player_row(who, 600 + k, &format!("name{k}")));
        w.character.seed(&character_row(600 + k));
        w.conversation.seed(&PlayerConversation {
            owner_identity: who,
            npc_entity_id: 3,
            current_node_id: "n".to_string(),
        });
        w.playtest.seed(&PlaytestEvent {
            event_id: 700 + k,
            identity: who,
            kind: 1,
            created_at_ms: 1,
            battle_id: 0,
            species_id: 1,
            hp_permille: 500,
            bait_item_id: 0,
            success: true,
        });
        w.action.seed(&BattleAction {
            action_id: 800 + k,
            battle_id: 99,
            player_identity: who,
            action: game_core::PvpAction::Attack { skill_id: 3 },
            turn_number: 1,
            submitted_at_ms: 1,
        });
        // An offer the subject made (with its armed reaper) and a challenge in
        // each role, one of them no longer pending.
        w.trade.seed(&trade_row(900 + k, who, peer));
        w.trade_reaper.seed(&TradeOfferReaperSchedule {
            scheduled_id: 900 + k,
            scheduled_at: ScheduleAt::Time(at(T0)),
            trade_id: 900 + k,
        });
        w.challenge.seed(&challenge_row(
            1000 + k,
            who,
            peer,
            ChallengeStatus::Pending,
        ));
        w.challenge_reaper.seed(&BattleChallengeReaperSchedule {
            scheduled_id: 1000 + k,
            scheduled_at: ScheduleAt::Time(at(T0)),
            challenge_id: 1000 + k,
        });
        w.challenge.seed(&challenge_row(
            1100 + k,
            peer,
            who,
            ChallengeStatus::Accepted,
        ));
        w.export.seed(&export_row(1200 + k, who, T0 - 7));
        w.session.seed(&PlayerSession {
            connection_id: ConnectionId::from_u128(1300 + u128::from(k)),
            identity: who,
        });
    }

    /// `account_deletion_reaper` over a subject holding a
    /// row in EVERY Erase table and a bystander holding the same population
    /// (plus a trade and challenges that do not involve the subject). A
    /// non-scheduler caller is refused with nothing touched; a tick before the
    /// grace end erases nothing and re-arms from the row's own stamp; the due
    /// tick leaves the subject ONLY its Anonymize rows — player and profile
    /// display names tombstoned, the account anonymized and stamped terminal —
    /// erases every Erase row, the character via the player join, and every
    /// reaper row keyed on an erased trade / challenge. The bystander's rows are
    /// byte-identical throughout.
    ///
    /// kills: any erase delegate dropped from the cascade; an erase keyed on the
    /// wrong identity (the bystander loses rows); the terminal stamp written
    /// before / without the erasure; the not-yet-due branch erasing or failing
    /// to re-arm; the scheduler guard dropped; a disarm that leaves a reaper
    /// firing on a deleted trade / challenge.
    #[test]
    fn acct_deletion_reaper_erases_every_owned_row_and_nothing_else() {
        let fx = fixture();
        let w = world(&fx);
        let v = id(0x71);
        let b = id(0x72);
        let x = id(0x73);
        let requested = T0;
        let pending = crate::accounts::requested_deletion(
            crate::accounts::new_account_row(v, "iss".to_string(), 1),
            requested,
        );
        w.account.seed(&pending);
        w.account
            .seed(&crate::accounts::new_account_row(b, "iss".to_string(), 1));
        seed_cascade_population(&w, v, b, 1);
        seed_cascade_population(&w, b, x, 2);
        let victim_before = owned_by(&w, v);
        let bystander_now = |w: &W<'_>| -> Vec<(&'static str, Vec<Vec<u8>>)> {
            owned_by(w, b)
                .into_iter()
                .map(|(t, rows)| {
                    let own = match t {
                        "trade_offer" => encs(
                            &w.trade
                                .rows()
                                .into_iter()
                                .filter(|r| r.initiator == b)
                                .collect::<Vec<_>>(),
                        ),
                        "battle_challenge" => encs(
                            &w.challenge
                                .rows()
                                .into_iter()
                                .filter(|r| {
                                    (r.challenger == b || r.target == b)
                                        && r.challenger != v
                                        && r.target != v
                                })
                                .collect::<Vec<_>>(),
                        ),
                        _ => rows,
                    };
                    (t, own)
                })
                .collect()
        };
        let bystander_before = bystander_now(&w);
        let sched = || AccountDeletionReaperSchedule {
            scheduled_id: 1,
            scheduled_at: ScheduleAt::Time(at(crate::accounts::deletion_fire_at_ms(requested))),
            account_identity: v,
        };
        let grace_end = crate::accounts::deletion_fire_at_ms(requested);

        // Non-scheduler: refused, nothing touched.
        let got = fx.run_as_at(v, at(grace_end), |ctx| {
            crate::accounts::account_deletion_reaper(ctx, sched())
        });
        assert_eq!(
            got,
            Err("account_deletion_reaper is scheduler-only".to_string())
        );
        assert_eq!(
            owned_by(&w, v),
            victim_before,
            "a refused tick touches nothing"
        );

        // Not yet due: nothing erased, re-armed from the row's own stamp.
        let got = fx.run_as_at(scheduler(), at(grace_end - 1), |ctx| {
            crate::accounts::account_deletion_reaper(ctx, sched())
        });
        assert_eq!(got, Ok(()));
        assert_eq!(
            owned_by(&w, v),
            victim_before,
            "an early tick erases nothing"
        );
        let rearmed = del_reapers_of(&w, v);
        assert_eq!(rearmed.len(), 1, "an early tick re-arms exactly once");
        assert_eq!(fire_at(&rearmed[0].scheduled_at), at(grace_end));
        w.del_reaper.remove(v);

        // Due: the cascade.
        let got = fx.run_as_at(scheduler(), at(grace_end), |ctx| {
            crate::accounts::account_deletion_reaper(ctx, sched())
        });
        assert_eq!(got, Ok(()));
        let after = owned_by(&w, v);
        assert_eq!(
            owned_tables(&after),
            vec!["account", "player", "profile"],
            "only the Anonymize rows may still name the erased identity"
        );
        let one = |t: &str| after.iter().find(|(n, _)| *n == t).unwrap().1.clone();
        assert_eq!(
            one("account"),
            encs(&[crate::accounts::terminal_account(
                crate::accounts::anonymized_account(pending),
                grace_end
            )])
        );
        let p = w
            .player
            .rows()
            .into_iter()
            .find(|r| r.identity == v)
            .unwrap();
        assert_eq!(
            p.name,
            game_core::TOMBSTONE_DISPLAY_NAME,
            "the display name is tombstoned"
        );
        let pr = w
            .profile
            .rows()
            .into_iter()
            .find(|r| r.identity == v)
            .unwrap();
        assert_eq!(pr.name, game_core::TOMBSTONE_DISPLAY_NAME);
        assert!(
            w.character.rows().iter().all(|r| r.entity_id != 601),
            "the character reachable through the player join is erased"
        );
        assert!(w.trade_reaper.rows().iter().all(|r| r.trade_id != 901));
        assert!(w
            .challenge_reaper
            .rows()
            .iter()
            .all(|r| r.challenge_id != 1001));
        assert!(del_reapers_of(&w, v).is_empty(), "the cascade arms nothing");

        assert_eq!(
            bystander_now(&w),
            bystander_before,
            "the bystander's rows are untouched"
        );
        assert!(w.character.rows().iter().any(|r| r.entity_id == 602));
        assert!(w.trade_reaper.rows().iter().any(|r| r.trade_id == 902));
        assert!(w
            .challenge_reaper
            .rows()
            .iter()
            .any(|r| r.challenge_id == 1002));
    }

    /// `ensure_deletion_reapers_armed` (the init / sync_content sweep): arms the
    /// grace reaper for every mid-grace account that has none, at the grace end
    /// of the row's own stamp — and ONLY for those: an already-armed, an Active
    /// and a terminal account gain nothing. A second sweep adds nothing.
    ///
    /// kills: the sweep body dropped (an account whose one-shot fired before
    /// the cascade existed, or that a crash left unarmed, is never erased); a
    /// re-arm of an already-armed account; a fire instant not derived from the
    /// row's own stamp.
    #[test]
    fn acct_ensure_deletion_reapers_armed_rearms_only_unarmed_mid_grace_accounts() {
        let fx = fixture();
        let w = world(&fx);
        let (unarmed, armed, active, erased) = (id(0x7A), id(0x7B), id(0x7C), id(0x7D));
        let new = |who| crate::accounts::new_account_row(who, "i".to_string(), 1);
        w.account
            .seed(&crate::accounts::requested_deletion(new(unarmed), T0));
        w.account
            .seed(&crate::accounts::requested_deletion(new(armed), T0 + 1));
        w.account.seed(&new(active));
        w.account.seed(&crate::accounts::terminal_account(
            crate::accounts::requested_deletion(new(erased), T0 + 2),
            T0 + 3,
        ));
        w.del_reaper.seed(&AccountDeletionReaperSchedule {
            scheduled_id: 40,
            scheduled_at: ScheduleAt::Time(at(crate::accounts::deletion_fire_at_ms(T0 + 1))),
            account_identity: armed,
        });
        for sweep in 0..2 {
            fx.run_as_at(
                scheduler(),
                at(T0 + 10),
                crate::accounts::ensure_deletion_reapers_armed,
            );
            let rows = w.del_reaper.rows();
            assert_eq!(
                rows.len(),
                2,
                "sweep #{sweep}: exactly the missing reaper is added"
            );
            let mine = del_reapers_of(&w, unarmed);
            assert_eq!(
                mine.len(),
                1,
                "sweep #{sweep}: the unarmed account is armed once"
            );
            assert_eq!(
                fire_at(&mine[0].scheduled_at),
                at(crate::accounts::deletion_fire_at_ms(T0)),
                "the fire instant is the grace end of the row's own stamp"
            );
            assert_eq!(
                del_reapers_of(&w, armed).len(),
                1,
                "an armed account is not re-armed"
            );
        }
    }

    /// `guest_claim_reaper`: scheduler-only; a tick before expiry leaves the
    /// claim (staleness re-check), the due tick deletes exactly that guest's
    /// claim, and a claim already consumed is an Ok no-op.
    ///
    /// kills: the scheduler guard dropped; the staleness re-check dropped (a
    /// fresh replacement claim reaped after clock skew); a reap keyed on
    /// anything but the scheduled guest.
    #[test]
    fn acct_guest_claim_reaper_reaps_only_the_expired_scheduled_claim() {
        let fx = fixture();
        let w = world(&fx);
        let g = id(0x81);
        let other = id(0x82);
        let claim = seed_live_claim(&w, g, &code('1'), 1);
        let other_claim = seed_live_claim(&w, other, &code('2'), 2);
        let sched = |guest: Identity| GuestClaimReaperSchedule {
            scheduled_id: 1,
            scheduled_at: ScheduleAt::Time(at(claim.expires_at_ms)),
            guest_identity: guest,
        };
        let tick = |who: Identity, ms: i64, guest: Identity| {
            fx.run_as_at(who, at(ms), |ctx| {
                crate::accounts::guest_claim_reaper(ctx, sched(guest))
            })
        };
        assert_eq!(
            tick(g, claim.expires_at_ms, g),
            Err("guest_claim_reaper is scheduler-only".to_string())
        );
        assert_eq!(tick(scheduler(), claim.expires_at_ms - 1, g), Ok(()));
        assert_eq!(
            w.claim.rows().len(),
            2,
            "a claim is never reaped before it expires"
        );
        assert_eq!(tick(scheduler(), claim.expires_at_ms, g), Ok(()));
        assert_eq!(
            encs(&w.claim.rows()),
            encs(&[other_claim]),
            "only the scheduled guest's claim goes"
        );
        assert_eq!(
            tick(scheduler(), claim.expires_at_ms + 1, g),
            Ok(()),
            "consumed: no-op"
        );
    }

    /// EV-account-privacy#tables-view: the only client read path to `account`
    /// is the `my_account` view, run here through the runtime's own view entry
    /// point: each caller sees exactly its own row, a stranger sees none.
    /// (`account` / `guest_claim` absence from the client surface is the
    /// client-surface-privacy allowlist.)
    ///
    /// kills: a view body keyed on anything but `ctx.sender()`; a decoy lookup
    /// that returns another identity's row.
    #[test]
    fn acct_my_account_view_returns_only_the_callers_row() {
        let fx = fixture();
        let w = world(&fx);
        let a = crate::accounts::new_account_row(id(0x91), "ia".to_string(), 1);
        let b = crate::accounts::claimed_account(
            crate::accounts::new_account_row(id(0x92), "ib".to_string(), 2),
            id(0x93),
            3,
        );
        w.account.seed(&a);
        w.account.seed(&b);
        let seen = |who: Identity| encs(&fx.call_view::<Account>(VIEW_MY_ACCOUNT, who));
        assert_eq!(seen(id(0x91)), encs(&[a]));
        assert_eq!(seen(id(0x92)), encs(&[b]));
        assert!(
            seen(id(0x94)).is_empty(),
            "a caller with no account sees nothing"
        );
    }

    // --- data export (ST-privacy_tests#export-owner-scope / #export-admission)

    fn exportable_tables() -> Vec<&'static str> {
        let mut t: Vec<&str> = DATA_LIFECYCLE_MANIFEST
            .iter()
            .filter(|e| e.exportable)
            .map(|e| e.table)
            .collect();
        t.sort_unstable();
        t
    }

    fn chunks_of(w: &W<'_>, who: Identity) -> Vec<ExportBundle> {
        let mut c: Vec<ExportBundle> = w
            .export
            .rows()
            .into_iter()
            .filter(|r| r.owner_identity == who)
            .collect();
        c.sort_by_key(|r| r.chunk_index);
        c
    }

    fn export_as(fx: &Fixture, who: Identity, ms: i64) -> Result<(), String> {
        fx.run_as_at(who, at(ms), crate::privacy::request_data_export)
    }

    /// Seed an export subject: a player row plus rows in several exportable
    /// tables, every string carrying `tag` so a foreign row is visible in a
    /// payload even where no identity column is exported.
    fn seed_export_subject(w: &W<'_>, who: Identity, k: u64, tag: &str) {
        w.player.seed(&player_row(who, 1400 + k, tag));
        let mut m = monster_row(1500 + k, who);
        m.nickname = tag.to_string();
        w.monster_pub.seed(&crate::marshal::pub_from_monster(&m, 0));
        w.monster.seed(&m);
        w.quest.seed(&PlayerQuestRow {
            pq_id: 1600 + k,
            owner_identity: who,
            quest_id: tag.to_string(),
            step_index: 0,
        });
        w.playtest.seed(&PlaytestEvent {
            event_id: 1700 + k,
            identity: who,
            kind: 1,
            created_at_ms: 1,
            battle_id: 0,
            species_id: 1,
            hp_permille: 1,
            bait_item_id: 0,
            success: false,
        });
    }

    /// Two subjects export in the SAME millisecond through the shipped reducer.
    /// Each bundle is owner-scoped (every chunk owned by the caller, one chunk
    /// per exportable table, contiguous `chunk_index` with the request-wide
    /// `total_chunks`, and no payload naming the other subject or carrying its
    /// tagged rows); each carries ONE creation stamp that no other live bundle
    /// shares (the clock, then the first free millisecond), with
    /// `request_id` mirroring it. One reaper singleton is armed. A repeat inside
    /// the cooldown is refused with nothing written; after it, the caller's old
    /// bundle is purged and replaced while the other bundle is untouched. A
    /// caller with no subject rows and a mid-grace account are refused.
    ///
    /// kills: a shared stamp for two live requests (the reaper's per-stamp
    /// delete unit would span bundles); chunks stamped from anything but the
    /// minted stamp; an exporter that reads beyond the caller's rows; the
    /// purge-before-write or cooldown dropped; the purge keyed on anything but
    /// the caller.
    #[test]
    fn acct_export_is_owner_scoped_and_stamps_each_live_bundle_uniquely() {
        let fx = fixture();
        let w = world(&fx);
        let a = id(0xA1);
        let b = id(0xA2);
        seed_export_subject(&w, a, 1, "TAG-ALPHA");
        seed_export_subject(&w, b, 2, "TAG-BRAVO");

        assert_eq!(export_as(&fx, a, T0), Ok(()));
        assert_eq!(
            export_as(&fx, b, T0),
            Ok(()),
            "a same-millisecond second subject is served"
        );

        let tables = exportable_tables();
        for (who, other, stamp, tag) in [(a, b, T0, "TAG-BRAVO"), (b, a, T0 + 1, "TAG-ALPHA")] {
            let chunks = chunks_of(&w, who);
            assert_eq!(
                chunks.len(),
                tables.len(),
                "one chunk per exportable table (small data)"
            );
            let mut names: Vec<&str> = chunks.iter().map(|c| c.table_name.as_str()).collect();
            names.sort_unstable();
            assert_eq!(names, tables, "every exportable table, exactly once");
            for (i, c) in chunks.iter().enumerate() {
                assert_eq!(c.chunk_index, i as u32, "chunk_index is contiguous from 0");
                assert_eq!(c.total_chunks, chunks.len() as u32);
                assert_eq!(
                    c.created_at_ms, stamp,
                    "every chunk carries the request's ONE stamp"
                );
                assert_eq!(c.request_id, stamp as u64, "request_id mirrors the stamp");
                assert!(
                    !c.payload_json.contains(&other.to_string()) && !c.payload_json.contains(tag),
                    "a `{}` chunk leaks the other subject's rows: {}",
                    c.table_name,
                    c.payload_json
                );
            }
        }
        assert_eq!(
            w.export_reaper.rows().len(),
            1,
            "the TTL reaper is a singleton"
        );

        let b_before = encs(&chunks_of(&w, b));
        let a_before = encs(&chunks_of(&w, a));
        assert_eq!(
            export_as(&fx, a, T0 + 30_000),
            Err("export_reject_cooldown".to_string())
        );
        assert_eq!(
            encs(&chunks_of(&w, a)),
            a_before,
            "a refused repeat writes nothing"
        );
        assert_eq!(export_as(&fx, a, T0 + 60_000), Ok(()));
        let fresh = chunks_of(&w, a);
        assert_eq!(
            fresh.len(),
            tables.len(),
            "the old bundle is purged, not appended to"
        );
        assert!(fresh.iter().all(|c| c.created_at_ms == T0 + 60_000));
        assert_eq!(
            encs(&chunks_of(&w, b)),
            b_before,
            "another subject's bundle is untouched"
        );
        assert_eq!(w.export_reaper.rows().len(), 1, "still one reaper");

        assert_eq!(
            export_as(&fx, id(0xA3), T0),
            Err("export_reject_no_subject".to_string())
        );
        w.account.seed(&crate::accounts::requested_deletion(
            crate::accounts::new_account_row(b, "i".to_string(), 1),
            T0,
        ));
        assert_eq!(
            export_as(&fx, b, T0 + 120_000),
            Err("export_reject_pending_deletion".to_string())
        );
        assert_eq!(encs(&chunks_of(&w, b)), b_before);
    }

    /// with every millisecond of the probe window already carrying a live
    /// bundle, a request is refused — it never falls back to sharing a stamp —
    /// and writes nothing.
    /// The first millisecond past the window is free, so the SAME request one
    /// window later is served there.
    ///
    /// kills: a fallback onto an occupied stamp; a window wider or narrower
    /// than the one the reaper's bundle cap is sized for.
    #[test]
    fn acct_export_refuses_a_full_stamp_window_and_writes_nothing() {
        let fx = fixture();
        let w = world(&fx);
        let a = id(0xB1);
        seed_export_subject(&w, a, 1, "TAG-A");
        let window = crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK as i64;
        for k in 0..window {
            w.export
                .seed(&export_row(5000 + k as u64, id(0xB2), T0 + k));
        }
        let before = encs(&w.export.rows());
        assert_eq!(
            export_as(&fx, a, T0),
            Err("export_reject_stamp_contention".to_string())
        );
        assert_eq!(
            encs(&w.export.rows()),
            before,
            "a contended request writes nothing"
        );
        assert_eq!(
            export_as(&fx, a, T0 - window),
            Ok(()),
            "a free window is served"
        );
        assert!(chunks_of(&w, a)
            .iter()
            .all(|c| c.created_at_ms == T0 - window));
    }

    /// The TTL reaper deletes WHOLE bundles only. Two bundles minted in the same
    /// millisecond sit one stamp apart; the tick at the first bundle's TTL
    /// removes every chunk of it and none of the second, whose own TTL tick
    /// then removes it. A non-scheduler tick is refused and deletes nothing.
    ///
    /// kills: a reap unit wider than one stamp (a partial or foreign bundle
    /// deleted), a TTL comparison off by one, the scheduler guard dropped.
    #[test]
    fn acct_export_reaper_deletes_whole_bundles_only() {
        let fx = fixture();
        let w = world(&fx);
        let a = id(0xC1);
        let b = id(0xC2);
        seed_export_subject(&w, a, 1, "TAG-A");
        seed_export_subject(&w, b, 2, "TAG-B");
        assert_eq!(export_as(&fx, a, T0), Ok(()));
        assert_eq!(export_as(&fx, b, T0), Ok(()));
        let ttl = crate::privacy::EXPORT_BUNDLE_TTL_MS;
        let tick = |who: Identity, ms: i64| {
            fx.run_as_at(who, at(ms), |ctx| {
                crate::privacy::export_bundle_reaper(
                    ctx,
                    ExportBundleReaperSchedule {
                        id: 1,
                        scheduled_at: ScheduleAt::Time(at(ms)),
                    },
                )
            })
        };
        let n = exportable_tables().len();
        assert_eq!(
            tick(a, T0 + ttl),
            Err("export_reaper_scheduler_only".to_string())
        );
        assert_eq!(
            w.export.rows().len(),
            2 * n,
            "a refused tick deletes nothing"
        );
        assert_eq!(tick(scheduler(), T0 + ttl - 1), Ok(()));
        assert_eq!(
            w.export.rows().len(),
            2 * n,
            "nothing is reaped before its TTL"
        );
        assert_eq!(tick(scheduler(), T0 + ttl), Ok(()));
        assert!(chunks_of(&w, a).is_empty(), "the expired bundle goes whole");
        assert_eq!(
            chunks_of(&w, b).len(),
            n,
            "the unexpired bundle stays whole"
        );
        assert_eq!(tick(scheduler(), T0 + 1 + ttl), Ok(()));
        assert!(w.export.rows().is_empty());
    }

    /// Admission control through the shipped reducer, at the exact edge. The
    /// global live-row cap is tiered by caller: an account holder gets the whole
    /// cap, a wallet-holding anonymous caller half, a join-only newcomer a
    /// quarter. With the store `newcomer_cap - min_bundle` rows full a newcomer
    /// is still served; one row fuller the newcomer is refused with nothing
    /// written, while a caller holding a wallet is served.
    ///
    /// kills: the tier order inverted or collapsed; the cap compared with `<`
    /// instead of `<=`; admission checked after the write.
    #[test]
    fn acct_export_admission_sheds_newcomers_first_at_the_exact_edge() {
        let cap = crate::privacy::EXPORT_REAP_MAX_READ_PER_TICK as u64
            * (crate::privacy::EXPORT_BUNDLE_TTL_MS as u64
                / crate::privacy::EXPORT_REAP_INTERVAL.as_millis() as u64);
        let newcomer_cap = cap / 4;
        let min_bundle = exportable_tables().len() as u64;
        for (extra, newcomer_served) in [(0u64, true), (1, false)] {
            let fx = fixture();
            let w = world(&fx);
            let filler = newcomer_cap - min_bundle + extra;
            for k in 0..filler {
                w.export.seed(&export_row(10_000 + k, id(0xD9), 1));
            }
            let newcomer = id(0xD1);
            seed_export_subject(&w, newcomer, 1, "TAG-N");
            let got = export_as(&fx, newcomer, T0);
            if newcomer_served {
                assert_eq!(got, Ok(()), "{filler} live rows: a newcomer still fits");
            } else {
                assert_eq!(got, Err("export_reject_admission".to_string()));
                assert!(
                    chunks_of(&w, newcomer).is_empty(),
                    "a refused request writes nothing"
                );
                let earner = id(0xD2);
                seed_export_subject(&w, earner, 2, "TAG-E");
                w.wallet.seed(&PlayerWallet {
                    owner_identity: earner,
                    balance: 1,
                });
                assert_eq!(
                    export_as(&fx, earner, T0),
                    Ok(()),
                    "a wallet holder is admitted"
                );
            }
        }
    }
}
