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

/// Exhaustive truth table of `account_state_is_legal` over EVERY combination of
/// status x deletion stamp x terminal marker x claim pair (2*2*2*2*2 = 32 rows),
/// against an oracle written here straight from the documented invariant (the
/// predicate's doc comment) rather than by calling any production helper:
///   - `Active` <=> no deletion stamp (so `PendingDeletion` <=> a stamp);
///   - a terminal marker requires `PendingDeletion` AND a deletion stamp;
///   - `claimed_from` and `claimed_at_ms` are set together or not at all.
#[test]
fn auth_account_state_invariant_exhaustive_truth_table() {
    let mut legal_rows = 0;
    for pending in [false, true] {
        for stamped in [false, true] {
            for terminal in [false, true] {
                for from_set in [false, true] {
                    for at_set in [false, true] {
                        let account = Account {
                            status: if pending {
                                AccountStatus::PendingDeletion
                            } else {
                                AccountStatus::Active
                            },
                            deletion_requested_at_ms: stamped.then_some(50),
                            terminal_at_ms: terminal.then_some(90),
                            claimed_from: from_set.then(|| ident(2)),
                            claimed_at_ms: at_set.then_some(30),
                            ..base_account(1)
                        };
                        let status_ok = pending == stamped;
                        let terminal_ok = !terminal || (pending && stamped);
                        let claim_ok = from_set == at_set;
                        let expected = status_ok && terminal_ok && claim_ok;
                        legal_rows += usize::from(expected);
                        assert_eq!(
                            account_state_is_legal(&account),
                            expected,
                            "pending={pending} stamped={stamped} terminal={terminal} \
                             claimed_from={from_set} claimed_at={at_set}"
                        );
                    }
                }
            }
        }
    }
    // Independent count: legal = (pending==stamped: 2 of 4 status/stamp combos)
    // with terminal allowed only when pending&&stamped (1 combo x 2 terminal
    // values + 1 combo x terminal=false) = 3, times 2 legal claim combos = 6.
    assert_eq!(legal_rows, 6);
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
/// still: it is ONE row for the whole table with NO Identity column at any
/// depth, so there is no per-player key a cascade step could scope itself with.
/// At most one row exists for the whole database, `ensure_export_bundle_reaper`
/// keeps it at one, and it carries the reaper's next run and nothing else. Its exportable
/// flag is false for the same reason: a subject's export must not contain the
/// module's own scheduler state.
///
/// The parents are pinned BY VALUE, not merely proven live: each was
/// verified against the real join column in source before being written here —
/// `character.entity_id` -> `player.entity_id` (schema.rs),
/// `battle_challenge_reaper_schedule.challenge_id` ->
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
///        `battle_wild_unit` at `battle_challenge` type-checks, names a live table
///        that is not itself ViaJoin, and orphans every wild-battle unit row;
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
    // + 20r-d's `pending_evolution_notice`
    // + the five identity-bearing tactical tables
    // + `trade_session` (an open session names both participants)
    // + `player_handle` (the identity's minted discriminator)
    // + the host's admission records, an identity's world binding and its bind nonce
    // + an identity's checked account and its armed re-check
    // + the record that a character was moved away from an identity.
    let expected_erase = [
        "battle_challenge",
        "battle_clock",
        "battle_deploy",
        "battle_queue",
        "battle_unit",
        "export_bundle",
        "heal_cooldown",
        "inventory",
        "last_position",
        "monster",
        "monster_pub",
        "pending_evolution_notice",
        "player_conversation",
        "player_dialogue_state",
        "player_formation",
        "player_handle",
        "player_quest",
        "player_session",
        "player_wallet",
        "playtest_event",
        "recheck_schedule",
        "trade_offer",
        "trade_session",
        "world_account",
        "world_admission",
        "world_admission_attempt",
        "world_bind_nonce",
        "world_binding",
        "world_move",
    ];
    assert_eq!(
        erase, expected_erase,
        "T2 / spec §3 ERASE: the row-deleted set is wrong. Spec §3 names \
         monster, monster_pub, inventory, player_dialogue_state, player_quest, \
         player_conversation, heal_cooldown, the wallet, playtest_event, trade_offer and \
         battle_challenge, this slice adds `export_bundle` — a snapshot of \
         personal data is itself personal data — rb-73 adds `player_session` (ADR-0245 \
         D1), 20r-d adds `pending_evolution_notice` (ADR-0254 D2) and bt-7 adds the five \
         tactical tables that carry the identity themselves (battle_unit, battle_queue, \
         battle_deploy, battle_clock, player_formation), `trade_session` names both \
         participants of an open trade session, `last_position` is the owner's saved \
         zone and tile and `player_handle` is the owner's minted discriminator (erased so a \
         deleted player's tag cannot be linked back), and lpw-9 adds `world_admission` and \
         `world_admission_attempt` (the host's record of who was let in, and of the wrong \
         passwords given for an identity), and `world_binding` and `world_bind_nonce` \
         (the account an identity of this world is bound to, and its outstanding bind \
         nonce), and `world_account` and `recheck_schedule` (the account a world checked \
         for an identity, and its armed re-check), and `world_move` (the identity a \
         character was moved away from, and when): twenty-nine in all. A table moved OUT of \
         this set survives the cascade; a table moved IN is deleted when the spec says it \
         must survive."
    );

    let expected_anonymize = [
        "account",
        "battle",
        "battle_summary",
        "leaderboard_top",
        "player",
        "profile",
    ];
    assert_eq!(
        anonymize, expected_anonymize,
        "T2 / spec §3 ANONYMIZE: exactly six tables survive the cascade with their identity/PII \
         fields overwritten or re-derived — `player` (the anchor `character` and every \
         still-live multi-user row point at), `profile` (ADR-0119's explicit never-delete \
         invariant), `account` (auth_issuer becomes the tombstone SENTINEL, keeping the column \
         non-nullable), `battle` (terminal PvP rows demonstrably persist, so a surviving \
         opponent's my_battle view must still resolve them months later), bt-7's \
         `battle_summary` (per-battle telemetry: the deleting side is tombstoned, the row \
         survives) and sr-4b's `leaderboard_top` (the derived top-100 membership: the cascade \
         re-derives it after tombstoning the profile name, so the row survives exactly while \
         that anonymized profile still ranks)."
    );

    let expected_join_only = [
        ("battle_challenge_reaper_schedule", "battle_challenge"),
        ("battle_event", "battle"),
        ("battle_gc_sched", "battle"),
        ("battle_secret", "battle"),
        ("battle_tactical", "battle"),
        ("battle_wild_unit", "battle"),
        ("character", "player"),
        ("move_intent", "player"),
        ("tactical_advance_sched", "battle"),
        ("tactical_deadline_sched", "battle"),
        ("trade_offer_reaper_schedule", "trade_offer"),
        ("trade_session_reaper_schedule", "trade_session"),
        ("trade_session_snapshot", "trade_session"),
    ];
    assert_eq!(
        join_only, expected_join_only,
        "T2 / spec §3 JOIN-ONLY: the thirteen structurally-invisible tables and their OWNING \
         PARENTS are pinned by value. These tables carry no Identity column, so \
         findIdentityColumns cannot see them and nothing else in the repo can re-derive the \
         parent. Each parent here was checked against the real join column: \
         character.entity_id -> player.entity_id, move_intent.entity_id -> \
         player.entity_id, \
         battle_challenge_reaper_schedule.challenge_id -> battle_challenge, \
         trade_offer_reaper_schedule.trade_id -> trade_offer, and bt-7's four tactical \
         join tables (battle_tactical, battle_secret, battle_wild_unit, battle_event), each \
         keyed by battle_id -> battle, bt-8's three tactical schedule tables, keyed by \
         battle_id -> battle, and the two trade-session children, \
         trade_session_snapshot.session_id -> trade_session and \
         trade_session_reaper_schedule.session_id -> trade_session."
    );

    let expected_not_owned = [
        "account_deletion_reaper_schedule",
        "battle_summary_reaper_schedule",
        "config",
        "encounter",
        "evolution_path",
        "export_bundle_reaper_schedule",
        "guest_claim",
        "guest_claim_reaper_schedule",
        "heal_location_row",
        "host_check_schedule",
        "item_row",
        "module_info",
        "movement_tick_schedule",
        "mr_heartbeat_schedule",
        "npc",
        "playtest_reaper_schedule",
        "shop_item_row",
        "shop_row",
        "skill_row",
        "species_row",
        "type_relation_row",
        "world_access",
        "world_allowlist",
        "world_check_budget",
        "world_egress",
        "world_name",
        "zone_def",
    ];
    assert_eq!(
        not_owned, expected_not_owned,
        "T2 / spec §3 NOT-OWNED: exactly twenty-seven tables hold no per-player data — spec §3's \
         seventeen, rb-24's `account_deletion_reaper_schedule`, rb-48's \
         `export_bundle_reaper_schedule` (ADR-0238), sr-7's `battle_summary_reaper_schedule`, \
         lpw-3's `module_info`, lpw-9's `world_access` (the one global access-rule row), \
         `world_name` and `world_allowlist` (the world's own names and the host's list of \
         handles, neither with an Identity column; the deletion cascade removes a deleted \
         identity's own handle from the list), `world_check_budget` (one row counting \
         the redeems sent this minute), `world_egress` (the address the account service last \
         saw the world's requests leave from, one row per family) and `host_check_schedule` \
         (the tick of the host account's own check and when it last succeeded), neither of \
         the last two with an Identity column. The additions are bookkeeping rather than player data, and \
         none is keyed by an identity a per-owner cascade step looks up: the rb-24 row holds the identity whose \
         own cascade it runs, and the rb-48 and sr-7 schedule rows and lpw-3's protocol-number \
         row are each ONE GLOBAL row with no Identity column at all, so there is nothing for a \
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
///        `character` -> `battle_wild_unit` (both join-only: a chain whose head never
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
        13,
        "T3 non-vacuity: `character` and `move_intent` are swept via `player`, the battle \
         challenge and trade offer reaper schedules via their parents, bt-7's four tactical \
         join tables and bt-8's three tactical schedule tables via `battle`, and the two \
         trade-session children (snapshot and reaper schedule) via `trade_session`, so \
         this scan must have thirteen parents to check. Zero ViaJoin \
         entries would make every clause below vacuously true."
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

/// The runtime twin of schema.rs's compile-time `manifest_is_wellformed`: the
/// manifest is non-empty, and every entry names a table and carries non-empty
/// basis prose. (That const fn is private to schema.rs and only const-evaluated,
/// so its own mutants are unreachable from any test; this pins the invariant.)
#[test]
fn data_lifecycle_manifest_entries_name_a_table_and_a_basis() {
    let manifest: &[DataLifecycleEntry] = DATA_LIFECYCLE_MANIFEST;
    assert!(!manifest.is_empty(), "the manifest classifies tables");
    for entry in manifest {
        assert!(!entry.table.is_empty(), "an entry with no table name");
        assert!(
            !entry.basis.trim().is_empty(),
            "`{}` carries no basis prose",
            entry.table
        );
    }
}

// ---------------------------------------------------------------------------
// T4 / X6 — EXPORT SCOPE, AS A POSITIVE BIJECTION.
// ---------------------------------------------------------------------------

/// the `exportable == true` set equals EXACTLY the twenty-one tables the export
/// scope admits — set equality, BOTH directions.
///
/// a negative-only spot check ("guest_claim is false, export_bundle is false") is
/// satisfied by an ALL-FALSE manifest, which ships a dead export feature — spec
/// §5's walk filters on `exportable: true`, so an all-false manifest produces an
/// empty bundle for every subject-access request while every gate stays green.
/// Set equality in both directions is the only shape that rejects an over-broad
/// AND an empty export scope.
///
/// The twenty-one are fifteen ERASE tables (`player_handle`, `player_formation`,
/// `world_account` and `world_move` among them) + five ANONYMIZE tables (`battle_summary`
/// among them) + `character`: 15 + 5 + 1 = 21. The `false` side includes two the spec
/// calls out by name:
/// `guest_claim` (a live secret code) and `export_bundle` itself (the export's
/// own output — including it makes the walk self-feeding).
///
/// Kills: flipping `guest_claim` to true;
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
        "battle_challenge",
        "battle_summary",
        "character",
        "heal_cooldown",
        "inventory",
        "monster",
        "monster_pub",
        "player",
        "player_conversation",
        "player_dialogue_state",
        "player_formation",
        "player_handle",
        "player_quest",
        "player_wallet",
        "playtest_event",
        "profile",
        "trade_offer",
        "world_account",
        "world_move",
    ];
    assert_eq!(
        exportable, expected_exportable,
        "T4 / spec §5: the exportable set is wrong. It must be EXACTLY the eleven spec §3 \
         ERASE tables + the four ANONYMIZE tables + `character` + `player_handle` (the owner's \
         own discriminator) + `battle_summary` (the caller's side of each battle summary) \
         + `player_formation` (the caller's saved deploy order) + `world_account` (what \
         the world holds about the caller's account) + `world_move` (when a character was \
         moved away from the caller): twenty-one. Both \
         directions matter: an \
         all-false manifest passes every negative spot check and ships an export feature \
         that returns an empty bundle for every request (§5's walk filters on \
         `exportable: true`), while a manifest that exports one table too many leaks either \
         a must-never-leak seed or global content the requester does not own."
    );

    for banned in ["guest_claim", "export_bundle"] {
        assert!(
            !exportable.contains(&banned),
            "T4 / spec §5: `{banned}` must carry `exportable: false`. Export scope is a \
             THIRD, orthogonal axis and must be structurally NARROWER than deletion scope: \
             guest_claim carries a live secret, and export_bundle is the export's own output."
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
            "battle_challenge",
            <crate::schema::BattleChallenge as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_challenge_reaper_schedule",
            <crate::pvp::BattleChallengeReaperSchedule as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_clock",
            <crate::schema::BattleClock as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_deploy",
            <crate::schema::BattleDeploy as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_event",
            <crate::schema::BattleEvent as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_gc_sched",
            <crate::tactics::BattleGcSched as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_queue",
            <crate::schema::BattleQueue as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_secret",
            <crate::schema::BattleSecret as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_summary",
            <crate::schema::BattleSummary as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_summary_reaper_schedule",
            <crate::summary_reaper::BattleSummaryReaperSchedule as SpacetimeType>::make_type(
                &mut ts,
            ),
        ),
        (
            "battle_tactical",
            <crate::schema::BattleTactical as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_unit",
            <crate::schema::BattleUnit as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "battle_wild_unit",
            <crate::schema::BattleWildUnit as SpacetimeType>::make_type(&mut ts),
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
            "last_position",
            <crate::schema::LastPosition as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "leaderboard_top",
            <crate::schema::LeaderboardTop as SpacetimeType>::make_type(&mut ts),
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
            "module_info",
            <crate::schema::ModuleInfo as SpacetimeType>::make_type(&mut ts),
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
            "move_intent",
            <crate::schema::MoveIntent as SpacetimeType>::make_type(&mut ts),
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
            "player_formation",
            <crate::schema::PlayerFormation as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "player_handle",
            <crate::schema::PlayerHandle as SpacetimeType>::make_type(&mut ts),
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
            "tactical_advance_sched",
            <crate::tactics::TacticalAdvanceSched as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "tactical_deadline_sched",
            <crate::tactics::TacticalDeadlineSched as SpacetimeType>::make_type(&mut ts),
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
            "trade_session",
            <crate::schema::TradeSession as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "trade_session_reaper_schedule",
            <crate::trading_session::TradeSessionReaperSchedule as SpacetimeType>::make_type(
                &mut ts,
            ),
        ),
        (
            "trade_session_snapshot",
            <crate::schema::TradeSessionSnapshot as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "type_relation_row",
            <crate::schema::TypeRelationRow as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_access",
            <crate::schema::WorldAccess as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_admission",
            <crate::schema::WorldAdmission as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_admission_attempt",
            <crate::schema::WorldAdmissionAttempt as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_allowlist",
            <crate::schema::WorldAllowlist as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_bind_nonce",
            <crate::schema::WorldBindNonce as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_binding",
            <crate::schema::WorldBinding as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_name",
            <crate::schema::WorldName as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_account",
            <crate::account_checks::WorldAccount as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_check_budget",
            <crate::account_checks::WorldCheckBudget as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "recheck_schedule",
            <crate::account_checks::RecheckSchedule as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_move",
            <crate::account_checks::WorldMove as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "world_egress",
            <crate::account_checks::WorldEgress as SpacetimeType>::make_type(&mut ts),
        ),
        (
            "host_check_schedule",
            <crate::account_checks::HostCheckSchedule as SpacetimeType>::make_type(&mut ts),
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
/// pinned at 75, and a non-vacuity floor on how many of the 75 are identity-bearing.
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
        registry_len, 75,
        "[m22s6/registry-census] the S6 row-type registry has {registry_len} entries; the live \
         manifest carries exactly 75 (29 ERASE + 6 ANONYMIZE + 13 JOIN-ONLY + 27 NOT-OWNED) — \
         37 base tables, plus `export_bundle_reaper_schedule` (ADR-0238), plus rb-73's \
         `player_session` (ADR-0245), plus 20r-d's `pending_evolution_notice` (ADR-0254), plus \
         bt-7's ten tactical tables, plus bt-8's three tactical schedule tables, plus the three \
         trade-session tables (`trade_session`, `trade_session_snapshot`, \
         `trade_session_reaper_schedule`), plus `move_intent`, plus `last_position`, plus \
         `player_handle`, plus sr-7's `battle_summary_reaper_schedule`, plus sr-4b's \
         `leaderboard_top`, plus lpw-3's `module_info`, plus lpw-9's three access tables \
         (`world_access`, `world_admission`, `world_admission_attempt`), plus the four world \
         binding tables (`world_binding`, `world_bind_nonce`, `world_name`, \
         `world_allowlist`), plus the three account-check tables (`world_account`, each \
         identity's checked account; `recheck_schedule`, each identity's armed re-check; \
         `world_check_budget`, the current minute's ticket-redeem count), plus `world_move` \
         (each identity a character was moved away from), plus the host-check tables \
         (`world_egress`, the address the account service last saw the world's requests \
         leave from, per family; `host_check_schedule`, the tick of the host account's own \
         check and when it last succeeded). A registry that grew \
         or shrank without a matching manifest change is \
         a registry nobody reviewed against the schema it claims to cover."
    );

    let mut identity_bearing = 0usize;
    for (_, ty) in &registry {
        if m22s6_identity_bearing(ty, 0) {
            identity_bearing += 1;
        }
    }
    assert_eq!(
        identity_bearing, 39,
        "[m22s6/registry-identity-floor] {identity_bearing} of the 75 registered row types \
         carry an Identity column at some depth; exactly 39 is the live count (the 35 \
         cascade-classified owner-keyed tables R1 below re-derives, plus the 4 frozen NotOwned \
         exceptions R3 below names). `world_egress` and `host_check_schedule` add none (a \
         family, an address text and a time; a schedule id, its tick and the last success). \
         `world_move` adds one (its `identity` key). \
         `world_account` and `recheck_schedule` add one each \
         (their `identity` columns, the keys their Erase classification rests on); \
         `world_check_budget` adds none (a row id, a minute and a count). `world_binding` and `world_bind_nonce` add one each \
         (their `identity` keys); `world_name` and `world_allowlist` add none (a name and an \
         account subject, each a string key). \
         lpw-9's `world_admission` and `world_admission_attempt` \
         add one each (their `identity` keys); `world_access` adds none (one global row of a \
         rule). sr-4b's `leaderboard_top` adds one (its `identity` key). \
         `player_handle` adds one (its `owner_identity` key). \
         `last_position` adds one (its `owner_identity` key). \
         `trade_session` adds one (its `opener` and `partner` \
         columns), while its snapshot and schedule tables, both ViaJoin, add none. bt-7 adds six — battle_unit (its `Option<Identity>` \
         owner, visible only to this deep walk), battle_queue and battle_deploy (`owner`), \
         battle_clock (`player`), battle_summary (both sides) and player_formation (its key) — \
         and its four ViaJoin tables add none. rb-73's `player_session` (ADR-0245) adds one: its \
         `identity` column is what its Erase classification rests on; 20r-d's \
         `pending_evolution_notice` (ADR-0254) adds another on the same reasoning — its \
         `owner_identity` primary key is what its Erase classification rests on. The count was \
         UNCHANGED by rb-48 on purpose: \
         `export_bundle_reaper_schedule` is one global schedule row carrying only an auto-inc \
         id and the runtime's fire instant, so it adds a row type without adding an owner key — \
         which is the derive-metadata proof, stronger than any text scan, that its `NotOwned` \
         classification and its empty re-key obligation are both honest. A count that drifted \
         without a corresponding R1/R2/R3 edit means either a table's columns changed shape, or \
         this registry stopped seeing them — either way a human needs to look, not have the \
         number silently update itself. sr-7's `battle_summary_reaper_schedule` and lpw-3's \
         `module_info` (one global row of two protocol numbers) leave it unchanged for the same \
         reason as rb-48's schedule row."
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
        population, 35,
        "[m22s6/x1-population] {population} manifest entries are classified Erase or Anonymize; \
         the live partition is exactly 35 (29 ERASE + 6 ANONYMIZE — the Erase `world_move` \
         (each identity a character was moved away from), the Erase `world_account` \
         (each identity's checked account) and `recheck_schedule` (each identity's armed \
         re-check), the Erase `world_binding` and `world_bind_nonce`, lpw-9's Erase \
         `world_admission` and `world_admission_attempt`, rb-73's `player_session`, \
         20r-d's `pending_evolution_notice`, bt-7's five Erase tactical tables plus its \
         Anonymize `battle_summary`, the Erase `trade_session`, the Erase `last_position`, \
         the Erase `player_handle` and sr-4b's Anonymize `leaderboard_top` included). A floor \
         would let this population grow silently; an exact count forces a conscious edit to \
         this test alongside any reclassification."
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
        population, 13,
        "[m22s6/x2-population] {population} manifest entries are classified ViaJoin; the live \
         set is exactly 13 (character, move_intent, \
         battle_challenge_reaper_schedule, trade_offer_reaper_schedule, bt-7's \
         battle_tactical, battle_secret, battle_wild_unit, battle_event, bt-8's \
         tactical_deadline_sched, tactical_advance_sched, battle_gc_sched, and the two \
         trade-session children trade_session_snapshot and trade_session_reaper_schedule)."
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
             never erased by the deletion cascade (no erase step keys a NotOwned table on an \
             identity), \
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
        population, 27,
        "[m22s6/x3-population] {population} manifest entries are classified NotOwned; the live \
         set is exactly 27 (spec §3's seventeen plus rb-24's account_deletion_reaper_schedule, \
         rb-48's export_bundle_reaper_schedule, ADR-0238, sr-7's \
         battle_summary_reaper_schedule, lpw-3's module_info, lpw-9's world_access, \
         world_name and world_allowlist, the world's names and the host's account list, \
         world_check_budget, one row counting the current minute's ticket redeems, \
         world_egress, the address the account service last saw the world's requests leave \
         from, per family, and host_check_schedule, the tick of the host account's own check \
         and when it last succeeded, the last three with no Identity column)."
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
    use crate::schema::{character, move_intent, Character, MoveIntent, Player};
    use game_core::{ActionState, Direction};

    // --- S0: seed the subject's player + character rows ---------------------
    let fx = crate::native_host_tests::fixture();
    let player_t = fx.table::<Player>("player", "identity", |r| r.identity);
    let character_t = fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id);
    let intent_t = fx.table_keyed::<MoveIntent, u64>("move_intent", "entity_id", |r| r.entity_id);
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
        discriminator: 0,
        lead_level: 0,
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
        acked_seq: 0,
    });
    intent_t.seed(&MoveIntent {
        entity_id: ENTITY_ID,
        queue: Vec::new(),
        last_input_seq: 0,
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
    assert!(
        ctx.db.move_intent().entity_id().find(ENTITY_ID).is_some(),
        "[rb72/post-intent] resolve_all_live_interactions must not delete the move_intent row: \
         it goes with the character, in on_disconnect's own body."
    );
    assert_eq!(
        intent_t.remove(ENTITY_ID),
        1,
        "[rb72/control-remove-intent] exactly one seeded move_intent row must be removable, or \
         the presence assertion above is not falsifiable"
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
// bt-7 — THE TACTICAL TABLES (M-battle-tactics): row shapes, view-row secrecy,
// manifest classification. The executed halves (the generated module def, the
// seven views, the deletion cascade, the claim-flow re-key) live in `acct_nh`.
// The column lists below are the plan table (design §8.1 plus the bt-3
// persistence columns and the plan-review API delta), shared by the derive-
// metadata test here and the generated-module-def test in `acct_nh`.
// ===========================================================================

const BT7_COLUMNS_BATTLE_TACTICAL: &[&str] = &[
    "battle_id",
    "kind",
    "format",
    "map_id",
    "content_version",
    "phase",
    "round",
    "initiative",
    "turn_idx",
    "turn_state",
    "tie_priority_side",
    "pending_pad_ms",
    "attack_damage_dealt_a",
    "attack_damage_dealt_b",
];

const BT7_COLUMNS_BATTLE_UNIT: &[&str] = &[
    "unit_id",
    "battle_id",
    "side",
    "owner",
    "slot",
    "monster_id",
    "wild_index",
    "species_id",
    "level",
    "affinity",
    "x",
    "y",
    "cur_hp",
    "stats",
    "skill_ids",
    "status",
    "ap",
    "strides_used",
    "attacks",
    "budget_last",
    "guard",
    "first_stand",
    "movement",
    "stride",
    "stance",
    "state",
];

const BT7_COLUMNS_BATTLE_QUEUE: &[&str] = &[
    "unit_id",
    "battle_id",
    "owner",
    "entries",
    "submitted_at_ms",
];

const BT7_COLUMNS_BATTLE_DEPLOY: &[&str] =
    &["deploy_id", "battle_id", "owner", "side", "picks", "locked"];

const BT7_COLUMNS_BATTLE_CLOCK: &[&str] = &[
    "clock_id",
    "battle_id",
    "side",
    "player",
    "window_seq",
    "window_open_ms",
    "deadline_ms",
    "windows_this_unit_turn",
    "idle_ms_total",
    "autopass_count",
];

const BT7_COLUMNS_BATTLE_SECRET: &[&str] = &["battle_id", "seed", "action_seq"];

const BT7_COLUMNS_BATTLE_WILD_UNIT: &[&str] = &[
    "wild_unit_id",
    "battle_id",
    "wild_index",
    "species_id",
    "level",
    "individuality_seed",
];

const BT7_COLUMNS_BATTLE_EVENT: &[&str] = &["event_id", "battle_id", "seq", "round", "payload"];

const BT7_COLUMNS_BATTLE_SUMMARY: &[&str] = &[
    "battle_id",
    "player_identity",
    "opponent_identity",
    "kind",
    "outcome",
    "rounds",
    "wall_ms",
    "idle_ms_a",
    "idle_ms_b",
    "windows_histogram",
    "autopasses",
    "recruit_attempts",
    "recruit_successes",
    "weaken_first",
    "items_used",
    "damage_dealt_a",
    "damage_dealt_b",
    "hits",
    "misses",
    "unit_turns_prequeued",
    "unit_turns_live",
    "halted_plans",
    "se_kos_after_r1",
    "kos_after_r1",
    "end_how",
];

const BT7_COLUMNS_PLAYER_FORMATION: &[&str] = &["owner_identity", "monster_ids"];

/// `battle` as committed before bt-7 (BT7.1: unchanged by this slice).
const BT7_COLUMNS_BATTLE: &[&str] = &[
    "battle_id",
    "player_identity",
    "opponent_identity",
    "state",
    "party_monster_ids",
    "opponent_monster_ids",
    "created_at_ms",
];

/// `battle_challenge` as committed before bt-7 (BT7.1: unchanged by this slice).
const BT7_COLUMNS_BATTLE_CHALLENGE: &[&str] = &[
    "challenge_id",
    "challenger",
    "target",
    "challenger_party_ids",
    "status",
    "created_at_ms",
    "format",
];

/// BT7.1 — every tactical row type declares EXACTLY the plan's columns in the
/// plan's order, read from its own `SpacetimeType` derive metadata (the column
/// list the host stores and the bindings generate), and `battle_unit` carries
/// no column that could say whether a READY plan exists.
///
/// The order is part of the contract, not cosmetics: BSATN is positional, the
/// tables ship once and the automigration accepts only tail-appended columns,
/// so a reorder after this slice is a destructive republish.
///
/// Kills: a reordered, renamed, dropped or added column on any of the ten
///        tables (one entry each); a `ready` / `queued` / `has_plan` flag added
///        to `BattleUnit` (design §6.3: whether a READY row exists is secret,
///        and `my_battle_units` hands every unit to BOTH participants); a
///        `max_hp` column re-added beside `stats` (two sources of max HP that
///        can disagree); the bt-3 persistence columns (`slot`, `budget_last`,
///        `pending_pad_ms`, `attack_damage_dealt_a/_b`) or the summary's four
///        BT9.5 inputs dropped; `side` and `owner` folded into one column
///        (§8.1 stores them separately so a two-ally side is just rows);
///        `battle_deploy` losing its `side` (a Practice owner stages both).
#[test]
fn tactical_row_types_declare_the_pinned_columns_in_order_bt7_1() {
    let mut ts = M22s6InlineTypespace;
    let rows: [(&str, AlgebraicType, &[&str]); 10] = [
        (
            "battle_tactical",
            <crate::schema::BattleTactical as SpacetimeType>::make_type(&mut ts),
            BT7_COLUMNS_BATTLE_TACTICAL,
        ),
        (
            "battle_unit",
            <crate::schema::BattleUnit as SpacetimeType>::make_type(&mut ts),
            BT7_COLUMNS_BATTLE_UNIT,
        ),
        (
            "battle_queue",
            <crate::schema::BattleQueue as SpacetimeType>::make_type(&mut ts),
            BT7_COLUMNS_BATTLE_QUEUE,
        ),
        (
            "battle_deploy",
            <crate::schema::BattleDeploy as SpacetimeType>::make_type(&mut ts),
            BT7_COLUMNS_BATTLE_DEPLOY,
        ),
        (
            "battle_clock",
            <crate::schema::BattleClock as SpacetimeType>::make_type(&mut ts),
            BT7_COLUMNS_BATTLE_CLOCK,
        ),
        (
            "battle_secret",
            <crate::schema::BattleSecret as SpacetimeType>::make_type(&mut ts),
            BT7_COLUMNS_BATTLE_SECRET,
        ),
        (
            "battle_wild_unit",
            <crate::schema::BattleWildUnit as SpacetimeType>::make_type(&mut ts),
            BT7_COLUMNS_BATTLE_WILD_UNIT,
        ),
        (
            "battle_event",
            <crate::schema::BattleEvent as SpacetimeType>::make_type(&mut ts),
            BT7_COLUMNS_BATTLE_EVENT,
        ),
        (
            "battle_summary",
            <crate::schema::BattleSummary as SpacetimeType>::make_type(&mut ts),
            BT7_COLUMNS_BATTLE_SUMMARY,
        ),
        (
            "player_formation",
            <crate::schema::PlayerFormation as SpacetimeType>::make_type(&mut ts),
            BT7_COLUMNS_PLAYER_FORMATION,
        ),
    ];
    for (accessor, ty, want) in &rows {
        let got = m22s9_top_level_column_names(accessor, ty);
        assert_eq!(
            got, *want,
            "[bt7/columns] `{accessor}` declares {got:?}; the plan pins {want:?}, in that order. \
             BSATN is positional and the automigration only appends, so the column list and \
             its order are frozen the day this slice ships."
        );
    }

    let unit_columns = m22s9_top_level_column_names(
        "battle_unit",
        &<crate::schema::BattleUnit as SpacetimeType>::make_type(&mut ts),
    );
    let tells: Vec<&String> = unit_columns
        .iter()
        .filter(|c| c.contains("ready") || c.contains("queue") || c.contains("plan"))
        .collect();
    assert!(
        tells.is_empty(),
        "[bt7/unit-no-ready-flag] `battle_unit` carries {tells:?}. Both participants read \
         every unit row through `my_battle_units`, so any column saying whether a unit has a \
         READY plan is exactly the design §6.3 leak (the opponent learns a plan exists)."
    );
}

/// Every product-field and sum-variant name reachable from `ty`, depth-first,
/// under the same 12-level cap as `m22s6_identity_bearing` (the inline builder
/// never interns, so there is no `Ref` to stop on).
fn bt7_names_at_any_depth(ty: &AlgebraicType, depth: usize, out: &mut Vec<String>) {
    assert!(
        depth <= 12,
        "[bt7/name-depth-cap] a view row type nests more than 12 levels deep; this walk \
         refuses to recurse further (see `M22s6InlineTypespace`)."
    );
    match ty {
        AlgebraicType::Product(p) => {
            for e in p.elements.iter() {
                if let Some(name) = e.name.as_ref() {
                    out.push(name.to_string());
                }
                bt7_names_at_any_depth(&e.algebraic_type, depth + 1, out);
            }
        }
        AlgebraicType::Sum(s) => {
            for v in s.variants.iter() {
                if let Some(name) = v.name.as_ref() {
                    out.push(name.to_string());
                }
                bt7_names_at_any_depth(&v.algebraic_type, depth + 1, out);
            }
        }
        AlgebraicType::Array(a) => bt7_names_at_any_depth(&a.elem_ty, depth + 1, out),
        _ => {}
    }
}

/// Does `name` name a secret or an owner-staging field (design §6.3)? The two
/// staging nouns `entries` / `picks` exactly; anything spelling a seed, the roll
/// counter, a READY flag or a queue, as a case-insensitive substring.
fn bt7_is_secret_or_staging_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "entries"
        || lower == "picks"
        || ["seed", "action_seq", "ready", "queue"]
            .iter()
            .any(|needle| lower.contains(*needle))
}

/// BT7.3 — no view row type reaches a secret: walking each of the seven new
/// views' row types to ANY depth (fields, enum variants, nested payloads), the
/// names that spell a seed, the roll counter, a READY flag, a queue or an
/// owner-staging list are EXACTLY this allowlist — `entries` on
/// `my_battle_queue` and `picks` on `my_battle_deploy` (the two OWNER-ONLY
/// views; their owner boundary is executed in `acct_nh`), and the
/// `QueueVoided` event variant on `my_battle_events` (BT3.7: a voided READY
/// plan is deleted WITH a visible event, at execution — design §6.3's
/// "inferable only after the fact"). Everything else is empty.
///
/// The predicate is first shown to fire on the two secret tables' own row
/// types, so an empty answer below is a real absence, not a blind matcher.
///
/// Kills: `my_battle_units` / `my_tactical_battle` / `my_battle_clock` /
///        `my_battle_events` / `my_formation` re-typed to (or extended with) a
///        row carrying `seed`, `action_seq` or `individuality_seed` (the
///        `battle_secret` / `battle_wild_unit` doctrine: a client that could
///        read the seed replays every roll); a `ready` / `queued` field or a
///        nested plan anywhere in a participant view's row; the queue's
///        `entries` or the deploy `picks` reachable through a PARTICIPANT view
///        (an extra hit on any of the four); a new event variant spelling a
///        queue or a READY state (the allowlist is exact, so it reds until a
///        human re-reads §6.3).
#[test]
fn tactical_view_row_types_reach_no_secret_or_staging_field_bt7_3() {
    let hits_of = |ty: &AlgebraicType| -> Vec<String> {
        let mut names = Vec::new();
        bt7_names_at_any_depth(ty, 0, &mut names);
        let mut hits: Vec<String> = names
            .into_iter()
            .filter(|n| bt7_is_secret_or_staging_name(n))
            .collect();
        hits.sort();
        hits.dedup();
        hits
    };
    let mut ts = M22s6InlineTypespace;

    let secret = hits_of(&<crate::schema::BattleSecret as SpacetimeType>::make_type(
        &mut ts,
    ));
    assert_eq!(
        secret,
        ["action_seq", "seed"],
        "[bt7/secret-names-fixture] the matcher must fire on `battle_secret`'s own row, or every \
         empty answer below is a blind matcher rather than an absence"
    );
    let wild = hits_of(&<crate::schema::BattleWildUnit as SpacetimeType>::make_type(&mut ts));
    assert_eq!(
        wild,
        ["individuality_seed"],
        "[bt7/secret-names-fixture] the matcher must fire on `battle_wild_unit`'s own row"
    );

    let views: [(&str, AlgebraicType, &[&str]); 7] = [
        (
            "my_tactical_battle",
            <crate::schema::BattleTactical as SpacetimeType>::make_type(&mut ts),
            &[],
        ),
        (
            "my_battle_units",
            <crate::schema::BattleUnit as SpacetimeType>::make_type(&mut ts),
            &[],
        ),
        (
            "my_battle_events",
            <crate::schema::BattleEvent as SpacetimeType>::make_type(&mut ts),
            &["QueueVoided"],
        ),
        (
            "my_battle_clock",
            <crate::schema::BattleClock as SpacetimeType>::make_type(&mut ts),
            &[],
        ),
        (
            "my_battle_queue",
            <crate::schema::BattleQueue as SpacetimeType>::make_type(&mut ts),
            &["entries"],
        ),
        (
            "my_battle_deploy",
            <crate::schema::BattleDeploy as SpacetimeType>::make_type(&mut ts),
            &["picks"],
        ),
        (
            "my_formation",
            <crate::schema::PlayerFormation as SpacetimeType>::make_type(&mut ts),
            &[],
        ),
    ];
    for (view, ty, allowed) in &views {
        let hits = hits_of(ty);
        assert_eq!(
            hits, *allowed,
            "[bt7/view-row-secrecy] the row type `{view}` serves reaches {hits:?} at some depth; \
             exactly {allowed:?} is allowed. Design §6.3: the seed, the roll counter and the \
             wild individuality never leave the server, whether a READY plan exists is never \
             participant-visible, and queue entries / deploy picks reach their OWNER only."
        );
    }
}

/// BT7.4 (manifest half) — each of the ten tactical tables is classified
/// exactly once with the plan's policy (five Erase, `battle_summary`
/// Anonymize, four `ViaJoin("battle")`); exactly two of them are exportable,
/// `battle_summary` (the caller's side of each battle summary, redacted like
/// `battle`) and `player_formation` (the caller's saved deploy order), while the
/// other eight are `exportable: false` — the transcripts are GC-bound and the
/// staging rows are secrets. The export bundle's table set is EXACTLY the
/// nineteen non-tactical exportable tables plus those two: 19 + 2 = 21.
///
/// Kills: one of the eight other tactical tables flipped to `exportable: true`
///        (the export ships seeds, plans or staging rows to the subject's
///        download); `battle_summary` or `player_formation` left non-exportable
///        (the subject-access response silently omits them); `battle_summary`
///        classified Erase (telemetry the H1/H2 tuning reads is destroyed by
///        every deletion) or `battle_unit` ViaJoin (its `Option<Identity>` owner
///        would be invisible to every per-owner rule); a ViaJoin parent other
///        than `battle`; a duplicate entry; any existing table's export flag
///        changed in passing.
#[test]
fn tactical_manifest_entries_are_classified_and_only_summary_and_formation_exported_bt7_4() {
    let label = |p: &DeletionPolicy| -> String {
        match p {
            DeletionPolicy::Erase => "Erase".to_string(),
            DeletionPolicy::Anonymize => "Anonymize".to_string(),
            DeletionPolicy::ViaJoin(parent) => format!("ViaJoin({parent})"),
            DeletionPolicy::NotOwned => "NotOwned".to_string(),
        }
    };
    // (table, deletion policy, exportable)
    let expected: [(&str, &str, bool); 10] = [
        ("battle_clock", "Erase", false),
        ("battle_deploy", "Erase", false),
        ("battle_event", "ViaJoin(battle)", false),
        ("battle_queue", "Erase", false),
        ("battle_secret", "ViaJoin(battle)", false),
        ("battle_summary", "Anonymize", true),
        ("battle_tactical", "ViaJoin(battle)", false),
        ("battle_unit", "Erase", false),
        ("battle_wild_unit", "ViaJoin(battle)", false),
        ("player_formation", "Erase", true),
    ];
    for (table, policy, exported) in expected {
        let entries: Vec<&DataLifecycleEntry> = DATA_LIFECYCLE_MANIFEST
            .iter()
            .filter(|e| e.table == table)
            .collect();
        assert_eq!(
            entries.len(),
            1,
            "[bt7/manifest-entry] `{table}` must be classified exactly once"
        );
        assert_eq!(
            label(&entries[0].policy),
            policy,
            "[bt7/manifest-policy] `{table}` carries the wrong deletion policy"
        );
        assert_eq!(
            entries[0].exportable, exported,
            "[bt7/manifest-export-flag] `{table}` must carry `exportable: {exported}` — the \
             export carries the battle summary and the saved formation; every other tactical \
             table stays out of it, because the transcript is GC-bound telemetry and the \
             staging rows are secrets"
        );
    }

    let mut exportable: Vec<&str> = DATA_LIFECYCLE_MANIFEST
        .iter()
        .filter(|e| e.exportable)
        .map(|e| e.table)
        .collect();
    exportable.sort_unstable();
    assert_eq!(
        exportable,
        [
            "account",
            "battle",
            "battle_challenge",
            "battle_summary",
            "character",
            "heal_cooldown",
            "inventory",
            "monster",
            "monster_pub",
            "player",
            "player_conversation",
            "player_dialogue_state",
            "player_formation",
            "player_handle",
            "player_quest",
            "player_wallet",
            "playtest_event",
            "profile",
            "trade_offer",
            "world_account",
            "world_move",
        ],
        "[bt7/export-set] the exportable set must be EXACTLY the nineteen non-tactical \
         exportable tables (`world_account` and `world_move` among them) plus `battle_summary` \
         and `player_formation`: 19 + 2 = 21"
    );
    assert_eq!(
        DATA_LIFECYCLE_MANIFEST.len(),
        75,
        "[bt7/manifest-census] 40 pre-bt-7 entries plus the ten tactical tables plus bt-8's three \
         schedule tables plus the three trade-session tables plus move_intent plus last_position \
         plus player_handle plus battle_summary_reaper_schedule plus leaderboard_top plus \
         module_info plus lpw-9's world_access, world_admission and world_admission_attempt \
         plus the four world binding tables (world_binding, world_bind_nonce, world_name, \
         world_allowlist) plus the three account-check tables (world_account, \
         world_check_budget, recheck_schedule) plus world_move plus the two host-check \
         tables (world_egress, the address the account service last saw the world's requests \
         leave from, per family; host_check_schedule, the tick of the host account's own \
         check and when it last succeeded)"
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
        fixture, ladder_oracle, sorted_hexes, Fixture, Handle, DEFAULT_DATABASE_IDENTITY,
        VIEW_MY_ACCOUNT,
    };
    use crate::playtest::PlaytestEvent;
    use crate::privacy::ExportBundleReaperSchedule;
    use crate::pvp::BattleChallengeReaperSchedule;
    use crate::schema::{
        Account, BattleChallenge, BattleClock, BattleDeploy, BattleEvent, BattleQueue,
        BattleSecret, BattleSummary, BattleTactical, BattleUnit, BattleWildUnit, ChallengeStatus,
        Character, DeletionPolicy, DeployPick, EvolutionRevealRow, ExportBundle, GuestClaim,
        HealCooldown, Inventory, LastPosition, Monster, MonsterPub, MoveClassRow,
        PendingEvolutionNotice, Player, PlayerConversation, PlayerDialogueStateRow,
        PlayerFormation, PlayerHandle, PlayerQuestRow, PlayerSession, PlayerWallet, Profile,
        SideRow, StanceRow, TradeOffer, TradeSession, TradeSessionSnapshot, WorldAdmission,
        WorldAdmissionAttempt, WorldBindNonce, WorldBinding, DATA_LIFECYCLE_MANIFEST,
    };
    use crate::trading::TradeOfferReaperSchedule;
    use crate::trading_session::TradeSessionReaperSchedule;
    use game_core::tactics::tuning::BattleKind;
    use game_core::tactics::types::{MoveAction, QueuedAction};
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
        last_position: Handle<'a, LastPosition>,
        wallet: Handle<'a, PlayerWallet>,
        profile: Handle<'a, Profile>,
        // sr-4b: the leaderboard membership every `profile` writer ends by rescanning (the
        // claim's `rekey_profile`, the cascade's `anonymize_display_names`).
        ladder: Handle<'a, crate::schema::LeaderboardTop>,
        character: Handle<'a, Character, u64>,
        intent: Handle<'a, crate::schema::MoveIntent, u64>,
        trade: Handle<'a, TradeOffer>,
        trade_reaper: Handle<'a, TradeOfferReaperSchedule, u64>,
        challenge: Handle<'a, BattleChallenge>,
        challenge_reaper: Handle<'a, BattleChallengeReaperSchedule, u64>,
        playtest: Handle<'a, PlaytestEvent, u64>,
        export: Handle<'a, ExportBundle>,
        export_reaper: Handle<'a, ExportBundleReaperSchedule, u64>,
        battle: Handle<'a, crate::schema::Battle>,
        // bt-7 tactical tables: per-battle tables keyed on `battle_id`, the
        // formation on its owner key.
        tactical: Handle<'a, BattleTactical, u64>,
        unit: Handle<'a, BattleUnit, u64>,
        queue: Handle<'a, BattleQueue, u64>,
        deploy: Handle<'a, BattleDeploy, u64>,
        clock: Handle<'a, BattleClock, u64>,
        secret: Handle<'a, BattleSecret, u64>,
        wild_unit: Handle<'a, BattleWildUnit, u64>,
        event: Handle<'a, BattleEvent, u64>,
        summary: Handle<'a, BattleSummary, u64>,
        formation: Handle<'a, PlayerFormation>,
        // The identity's minted discriminator, on its `owner_identity` key.
        handle: Handle<'a, PlayerHandle>,
        // Trade sessions: the session row on its primary key, its snapshot and
        // reaper-schedule children on their `session_id` btree.
        trade_session: Handle<'a, TradeSession, u64>,
        trade_snapshot: Handle<'a, TradeSessionSnapshot, u64>,
        trade_session_reaper: Handle<'a, TradeSessionReaperSchedule, u64>,
        // The world's admission record and its wrong-password record, both on their
        // `identity` key (the cascade's `access::erase_admission` deletes through them).
        admission: Handle<'a, WorldAdmission>,
        admission_attempt: Handle<'a, WorldAdmissionAttempt>,
        // The identity's world binding and its bind nonce, both on their `identity` key
        // (the cascade's `world_binding::erase_world_binding` deletes through them; the
        // export test seeds the binding through it to prove the export leaves it out).
        binding: Handle<'a, WorldBinding>,
        bind_nonce: Handle<'a, WorldBindNonce>,
        // The identity's checked account and its armed re-check, both on their `identity`
        // key (the cascade's and the claim's `account_checks::erase_world_account` deletes
        // through them; the export reads the account row through it).
        world_account: Handle<'a, crate::account_checks::WorldAccount>,
        recheck: Handle<'a, crate::account_checks::RecheckSchedule>,
        // The identity's move record on its `identity` key (`erase_world_account` deletes
        // through it; the export reads it through `move_of`).
        world_move: Handle<'a, crate::account_checks::WorldMove>,
    }

    /// Registers every index the shipped accounts / claim / cascade / export
    /// paths read or write through, opens writes on each table (post-state
    /// assertions, not the write wall, are this suite's oracle) and opens full
    /// scans ONLY where the shipped code scans (`playtest_event`,
    /// the `export_bundle` count, the export reaper singleton, `battle_unit`
    /// for the tactical cascade's `owner == Some(..)` scan — a sum type carries
    /// no index — and, through `Fixture::ladder`, `profile` and `leaderboard_top`
    /// for the membership rescan that ends every `profile` write).
    ///
    /// bt-7: EVERY index of the ten tactical tables is registered here,
    /// unconditionally — the participant / owner views read through them, and
    /// the tactical cascade step deletes / updates through them (an
    /// index-point delete or an update through an index no fixture registered
    /// ABORTS the whole test process, D5). `battle.battle_id` is registered too,
    /// because `battle::anonymize_battles` updates through it for every battle row
    /// the cascade subject is a side of.
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
        // `erase_playtest_events` drops the playtest reaper's schedule row when it
        // empties the table.
        let _ = fx
            .table_keyed::<crate::playtest::PlaytestReaperSchedule, u64>(
                "playtest_reaper_schedule",
                "id",
                |r| r.id,
            )
            .writable()
            .scannable()
            .unique();
        // bt-7: the anchor's key (`battle::anonymize_battles` reaches it per battle row).
        let _ =
            fx.table_keyed::<crate::schema::Battle, u64>("battle", "battle_id", |r| r.battle_id);
        // bt-7: every secondary index of the tactical tables (the `battle_id`
        // btree / key of each is the W handle below).
        let _ = fx.table_keyed::<BattleTactical, u32>("battle_tactical", "map_id", |r| r.map_id);
        let _ = fx.table_keyed::<BattleUnit, u32>("battle_unit", "unit_id", |r| r.unit_id);
        let _ = fx.table_keyed::<BattleQueue, u32>("battle_queue", "unit_id", |r| r.unit_id);
        let _ = fx.table::<BattleQueue>("battle_queue", "owner", |r| r.owner);
        let _ = fx.table_keyed::<BattleDeploy, u64>("battle_deploy", "deploy_id", |r| r.deploy_id);
        let _ = fx.table::<BattleDeploy>("battle_deploy", "owner", |r| r.owner);
        let _ = fx.table_keyed::<BattleClock, u64>("battle_clock", "clock_id", |r| r.clock_id);
        let _ = fx.table::<BattleClock>("battle_clock", "player", |r| r.player);
        let _ = fx.table_keyed::<BattleWildUnit, u64>("battle_wild_unit", "wild_unit_id", |r| {
            r.wild_unit_id
        });
        let _ = fx.table_keyed::<BattleEvent, u64>("battle_event", "event_id", |r| r.event_id);
        // bt-8: the schedule rows the cascade disarms by battle_id (W handles so the
        // deletes reach the host; the erase step aborts on an unregistered index).
        let _ = fx
            .table_keyed::<crate::tactics::TacticalDeadlineSched, u64>(
                "tactical_deadline_sched",
                "battle_id",
                |r| r.battle_id,
            )
            .writable();
        let _ = fx
            .table_keyed::<crate::tactics::TacticalAdvanceSched, u64>(
                "tactical_advance_sched",
                "battle_id",
                |r| r.battle_id,
            )
            .writable();
        let _ = fx
            .table_keyed::<crate::tactics::BattleGcSched, u64>(
                "battle_gc_sched",
                "battle_id",
                |r| r.battle_id,
            )
            .writable();
        let _ =
            fx.table::<BattleSummary>("battle_summary", "player_identity", |r| r.player_identity);
        let _ = fx.table::<BattleSummary>("battle_summary", "opponent_identity", |r| {
            r.opponent_identity
        });
        // Trade sessions: both participant indexes (the deletion, claim and view
        // paths read through them) and every key a session delete reaches.
        let _ = fx.table::<TradeSession>("trade_session", "opener", |r| r.opener);
        let _ = fx.table::<TradeSession>("trade_session", "partner", |r| r.partner);
        let _ = fx.table_keyed::<TradeSessionSnapshot, u64>(
            "trade_session_snapshot",
            "snapshot_id",
            |r| r.snapshot_id,
        );
        let _ = fx.table_keyed::<TradeSessionSnapshot, u64>(
            "trade_session_snapshot",
            "monster_id",
            |r| r.monster_id,
        );
        let _ = fx.table_keyed::<TradeSessionReaperSchedule, u64>(
            "trade_session_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        );
        // `player_handle`: the owner key draws `discriminator` from the table's
        // sequence (the host models one u64 sequence per table; the u32 column
        // goes through the cast closures), and the `discriminator` index is
        // unique so an insert collision is an error, as on the real host.
        let handles = fx
            .table::<PlayerHandle>("player_handle", "owner_identity", |r| r.owner_identity)
            .writable()
            .unique()
            .auto_inc(
                |r| u64::from(r.discriminator),
                |r, v| {
                    r.discriminator = u32::try_from(v).expect("a test sequence value fits a u32")
                },
            );
        let _ = fx
            .table_keyed::<PlayerHandle, u32>("player_handle", "discriminator", |r| r.discriminator)
            .unique();
        let _ = fx.table_composite::<Monster, Identity, u8>(
            "monster",
            ["owner_identity", "party_slot"],
            |r| (r.owner_identity, r.party_slot),
        );
        W {
            handle: handles,
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
            last_position: fx
                .table::<LastPosition>("last_position", "owner_identity", |r| r.owner_identity)
                .unique()
                .writable(),
            wallet: fx
                .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
                .writable(),
            profile: fx
                .table::<Profile>("profile", "identity", |r| r.identity)
                .writable(),
            ladder: fx.ladder(),
            character: fx
                .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
                .writable(),
            intent: fx
                .table_keyed::<crate::schema::MoveIntent, u64>("move_intent", "entity_id", |r| {
                    r.entity_id
                })
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
            tactical: fx
                .table_keyed::<BattleTactical, u64>("battle_tactical", "battle_id", |r| r.battle_id)
                .writable(),
            unit: fx
                .table_keyed::<BattleUnit, u64>("battle_unit", "battle_id", |r| r.battle_id)
                .writable()
                .scannable(),
            queue: fx
                .table_keyed::<BattleQueue, u64>("battle_queue", "battle_id", |r| r.battle_id)
                .writable(),
            deploy: fx
                .table_keyed::<BattleDeploy, u64>("battle_deploy", "battle_id", |r| r.battle_id)
                .writable(),
            clock: fx
                .table_keyed::<BattleClock, u64>("battle_clock", "battle_id", |r| r.battle_id)
                .writable(),
            secret: fx
                .table_keyed::<BattleSecret, u64>("battle_secret", "battle_id", |r| r.battle_id)
                .writable(),
            wild_unit: fx
                .table_keyed::<BattleWildUnit, u64>("battle_wild_unit", "battle_id", |r| {
                    r.battle_id
                })
                .writable(),
            event: fx
                .table_keyed::<BattleEvent, u64>("battle_event", "battle_id", |r| r.battle_id)
                .writable(),
            summary: fx
                .table_keyed::<BattleSummary, u64>("battle_summary", "battle_id", |r| r.battle_id)
                .writable(),
            formation: fx
                .table::<PlayerFormation>("player_formation", "owner_identity", |r| {
                    r.owner_identity
                })
                .unique()
                .writable(),
            trade_session: fx
                .table_keyed::<TradeSession, u64>("trade_session", "session_id", |r| r.session_id)
                .unique()
                .writable()
                .auto_inc(|r| r.session_id, |r, v| r.session_id = v),
            trade_snapshot: fx
                .table_keyed::<TradeSessionSnapshot, u64>(
                    "trade_session_snapshot",
                    "session_id",
                    |r| r.session_id,
                )
                .writable()
                .auto_inc(|r| r.snapshot_id, |r, v| r.snapshot_id = v),
            trade_session_reaper: fx
                .table_keyed::<TradeSessionReaperSchedule, u64>(
                    "trade_session_reaper_schedule",
                    "session_id",
                    |r| r.session_id,
                )
                .writable()
                .auto_inc(|r| r.scheduled_id, |r, v| r.scheduled_id = v),
            admission: fx
                .table::<WorldAdmission>("world_admission", "identity", |r| r.identity)
                .unique()
                .writable(),
            admission_attempt: fx
                .table::<WorldAdmissionAttempt>("world_admission_attempt", "identity", |r| {
                    r.identity
                })
                .unique()
                .writable(),
            binding: fx
                .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
                .unique()
                .writable(),
            bind_nonce: fx
                .table::<WorldBindNonce>("world_bind_nonce", "identity", |r| r.identity)
                .unique()
                .writable(),
            world_account: {
                let _ = fx
                    .table_keyed::<crate::account_checks::WorldAccount, String>(
                        "world_account",
                        "handle",
                        |r| r.handle.clone(),
                    )
                    .unique();
                fx.table::<crate::account_checks::WorldAccount>("world_account", "identity", |r| {
                    r.identity
                })
                .unique()
                .writable()
                .scannable()
            },
            recheck: {
                let _ = fx
                    .table_keyed::<crate::account_checks::RecheckSchedule, u64>(
                        "recheck_schedule",
                        "scheduled_id",
                        |r| r.scheduled_id,
                    )
                    .unique();
                fx.table::<crate::account_checks::RecheckSchedule>(
                    "recheck_schedule",
                    "identity",
                    |r| r.identity,
                )
                .unique()
                .writable()
            },
            world_move: fx
                .table::<crate::account_checks::WorldMove>("world_move", "identity", |r| r.identity)
                .unique()
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
            discriminator: 0,
            lead_level: 0,
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
            acked_seq: 0,
        }
    }

    fn intent_row(entity_id: u64) -> crate::schema::MoveIntent {
        crate::schema::MoveIntent {
            entity_id,
            queue: vec![game_core::MoveInput::Jump],
            last_input_seq: 4,
        }
    }

    fn intent_ids(w: &W<'_>) -> Vec<u64> {
        let mut ids: Vec<u64> = w.intent.rows().into_iter().map(|r| r.entity_id).collect();
        ids.sort_unstable();
        ids
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
            format: 0,
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

    // --- bt-7 tactical rows --------------------------------------------------
    //
    // Fixture ids derive from the battle id so every key is distinct across
    // battles: unit `n` of battle `b` is `10·b + n` (n = 1, 2 side A; 3, 4 side
    // B), and the per-side clock / deploy ids are `10·b + 1` (A) / `10·b + 2` (B).

    fn unit_id_of(battle_id: u64, n: u64) -> u32 {
        u32::try_from(battle_id * 10 + n).expect("a fixture unit id fits a u32")
    }

    fn side_key(side: SideRow) -> u64 {
        match side {
            SideRow::A => 1,
            SideRow::B => 2,
        }
    }

    fn tactical_row(battle_id: u64, kind: BattleKind) -> BattleTactical {
        BattleTactical {
            battle_id,
            kind,
            format: 1,
            map_id: 3,
            content_version: crate::CONTENT_VERSION,
            phase: game_core::tactics::types::Phase::Active,
            round: 2,
            initiative: vec![unit_id_of(battle_id, 1), unit_id_of(battle_id, 3)],
            turn_idx: 0,
            turn_state: game_core::tactics::types::TurnState::Waiting(unit_id_of(battle_id, 1)),
            tie_priority_side: SideRow::A,
            pending_pad_ms: 400,
            attack_damage_dealt_a: 12,
            attack_damage_dealt_b: 9,
        }
    }

    /// Unit `n` of `battle_id` on `side`; `owner: None` is a wild unit (it then
    /// carries a `wild_index` and a stance, no `monster_id`).
    fn unit_row(battle_id: u64, n: u64, side: SideRow, owner: Option<Identity>) -> BattleUnit {
        let slot: u8 = if n % 2 == 1 { 0 } else { 1 };
        BattleUnit {
            unit_id: unit_id_of(battle_id, n),
            battle_id,
            side,
            owner,
            slot,
            monster_id: owner.map(|_| battle_id * 10 + n),
            wild_index: owner.is_none().then_some(slot),
            species_id: 1,
            level: 7,
            affinity: game_core::Affinity::Fire,
            x: slot,
            y: match side {
                SideRow::A => 0,
                SideRow::B => 6,
            },
            cur_hp: 30,
            stats: game_core::StatBlock {
                hp: 30,
                attack: 20,
                defense: 20,
                speed: 20,
                sp_attack: 20,
                sp_defense: 20,
            },
            skill_ids: vec![1, 2],
            status: None,
            ap: 6,
            strides_used: 0,
            attacks: 0,
            budget_last: None,
            guard: false,
            first_stand: true,
            movement: MoveClassRow::Walk,
            stride: 2,
            stance: owner.is_none().then_some(StanceRow::Aggressive),
            state: game_core::tactics::resolve::UnitState::Active,
        }
    }

    fn clock_row(battle_id: u64, side: SideRow, player: Identity) -> BattleClock {
        BattleClock {
            clock_id: battle_id * 10 + side_key(side),
            battle_id,
            side,
            player,
            window_seq: 3,
            window_open_ms: Some(T0),
            deadline_ms: Some(T0 + 30_000),
            windows_this_unit_turn: 1,
            idle_ms_total: 1_500,
            autopass_count: 0,
        }
    }

    /// A READY plan for unit `n` of `battle_id`.
    fn queue_row(battle_id: u64, n: u64, owner: Identity) -> BattleQueue {
        BattleQueue {
            unit_id: unit_id_of(battle_id, n),
            battle_id,
            owner,
            entries: vec![
                QueuedAction::Move(MoveAction {
                    x: 2,
                    y: 3,
                    strides: 1,
                }),
                QueuedAction::EndTurn,
            ],
            submitted_at_ms: T0,
        }
    }

    fn deploy_row(battle_id: u64, side: SideRow, owner: Identity) -> BattleDeploy {
        BattleDeploy {
            deploy_id: battle_id * 10 + side_key(side),
            battle_id,
            owner,
            side,
            picks: vec![DeployPick {
                monster_id: battle_id * 100 + side_key(side),
                slot: 0,
            }],
            locked: false,
        }
    }

    fn secret_row(battle_id: u64) -> BattleSecret {
        BattleSecret {
            battle_id,
            seed: battle_id ^ 0x5EED_5EED,
            action_seq: 7,
        }
    }

    fn wild_unit_row(battle_id: u64, wild_index: u8) -> BattleWildUnit {
        BattleWildUnit {
            wild_unit_id: battle_id * 10 + u64::from(wild_index) + 1,
            battle_id,
            wild_index,
            species_id: 2,
            level: 6,
            individuality_seed: 0x00C0_FFEE + u32::from(wild_index),
        }
    }

    fn event_row(battle_id: u64, n: u64) -> BattleEvent {
        BattleEvent {
            event_id: battle_id * 10 + n,
            battle_id,
            seq: u32::try_from(n).expect("a fixture event seq fits a u32"),
            round: 1,
            payload: game_core::tactics::events::EventPayload::RoundEnded(
                game_core::tactics::events::RoundEndedEvent { round: 1 },
            ),
        }
    }

    fn summary_row(
        battle_id: u64,
        player: Identity,
        opponent: Identity,
        kind: BattleKind,
    ) -> BattleSummary {
        BattleSummary {
            battle_id,
            player_identity: player,
            opponent_identity: opponent,
            kind,
            outcome: game_core::BattleOutcome::SideAWins,
            rounds: 5,
            wall_ms: 90_000,
            idle_ms_a: 1_000,
            idle_ms_b: 2_000,
            windows_histogram: vec![0, 3, 1],
            autopasses: 0,
            recruit_attempts: 0,
            recruit_successes: 0,
            weaken_first: false,
            items_used: 1,
            damage_dealt_a: 40,
            damage_dealt_b: 30,
            hits: 6,
            misses: 2,
            unit_turns_prequeued: 3,
            unit_turns_live: 4,
            halted_plans: 1,
            se_kos_after_r1: 0,
            kos_after_r1: 0,
            end_how: None,
        }
    }

    fn formation_row(owner: Identity, k: u64) -> PlayerFormation {
        PlayerFormation {
            owner_identity: owner,
            monster_ids: vec![100 + k, 200 + k],
        }
    }

    /// One tactical battle's PUBLIC-to-participants row set plus its secrets:
    /// the anchor `battle` row (settled — `SideAWins`, or `Fled` for a wild
    /// battle — so the cascade's 6a resolver leaves it alone), its tactical
    /// row, its secret, `1 + id % 3` events, two side-A units and `1 + id % 2`
    /// side-B units (row counts differ per battle on purpose, so a reader that
    /// serves only one battle's rows cannot match a multiset), one clock per
    /// side that has a player, and its summary. `side_b: None` is a WILD battle
    /// (opponent = the zero wild sentinel, side-B units `owner: None`, plus two
    /// `battle_wild_unit` rows); `Some(side_a)` is a practice battle.
    fn seed_tactical_battle(w: &W<'_>, battle_id: u64, side_a: Identity, side_b: Option<Identity>) {
        let kind = match side_b {
            None => BattleKind::Wild,
            Some(b) if b == side_a => BattleKind::Practice,
            Some(_) => BattleKind::Pvp,
        };
        let opponent = side_b.unwrap_or(crate::WILD_IDENTITY);
        let mut anchor = battle_row(side_a, opponent);
        anchor.battle_id = battle_id;
        anchor.state.outcome = if side_b.is_some() {
            game_core::BattleOutcome::SideAWins
        } else {
            game_core::BattleOutcome::Fled
        };
        w.battle.seed(&anchor);
        w.tactical.seed(&tactical_row(battle_id, kind));
        w.secret.seed(&secret_row(battle_id));
        for n in 1..=(1 + battle_id % 3) {
            w.event.seed(&event_row(battle_id, n));
        }
        for n in [1, 2] {
            w.unit
                .seed(&unit_row(battle_id, n, SideRow::A, Some(side_a)));
        }
        for n in 3..=(3 + battle_id % 2) {
            w.unit.seed(&unit_row(battle_id, n, SideRow::B, side_b));
        }
        w.clock.seed(&clock_row(battle_id, SideRow::A, side_a));
        match side_b {
            Some(b) => w.clock.seed(&clock_row(battle_id, SideRow::B, b)),
            None => {
                for i in 0..2u8 {
                    w.wild_unit.seed(&wild_unit_row(battle_id, i));
                }
            }
        }
        w.summary
            .seed(&summary_row(battle_id, side_a, opponent, kind));
    }

    /// The OWNER-ONLY staging of a battle: a READY plan on unit 1 (side A) and
    /// a deploy row for side A, plus the same for side B (unit 3) when side B
    /// has a player.
    fn seed_staging(w: &W<'_>, battle_id: u64, side_a: Identity, side_b: Option<Identity>) {
        w.queue.seed(&queue_row(battle_id, 1, side_a));
        w.deploy.seed(&deploy_row(battle_id, SideRow::A, side_a));
        if let Some(b) = side_b {
            w.queue.seed(&queue_row(battle_id, 3, b));
            w.deploy.seed(&deploy_row(battle_id, SideRow::B, b));
        }
    }

    /// The tactical population of `who`: four battles `2000 + 10·k + n` — n=1
    /// `who` as side A vs `peer`, n=2 `peer` as side A vs `who` (the other
    /// battle role), n=3 a wild battle (`owner: None` units + wild-unit rows),
    /// n=4 a practice battle (`who` on both sides) — each with its staging, plus
    /// `who`'s formation.
    fn seed_tactical_population(w: &W<'_>, who: Identity, peer: Identity, k: u64) {
        let base = 2000 + 10 * k;
        for (n, side_a, side_b) in [
            (1, who, Some(peer)),
            (2, peer, Some(who)),
            (3, who, None),
            (4, who, Some(who)),
        ] {
            seed_tactical_battle(w, base + n, side_a, side_b);
            seed_staging(w, base + n, side_a, side_b);
        }
        w.formation.seed(&formation_row(who, k));
    }

    /// Every row of `rows` as `(battle_id, canonical bytes)`, sorted.
    fn rows_by_battle<R: Serialize>(rows: Vec<R>, battle_of: fn(&R) -> u64) -> Vec<(u64, Vec<u8>)> {
        let mut out: Vec<(u64, Vec<u8>)> = rows.iter().map(|r| (battle_of(r), enc(r))).collect();
        out.sort();
        out
    }

    /// `(table, [(battle_id, row bytes)])` per tactical table (clippy type_complexity alias).
    type PerBattleRows = Vec<(&'static str, Vec<(u64, Vec<u8>)>)>;

    /// The eight tactical tables the cascade erases BY BATTLE ID, each as
    /// `(battle_id, canonical bytes)` rows.
    fn per_battle_rows(w: &W<'_>) -> PerBattleRows {
        vec![
            (
                "battle_tactical",
                rows_by_battle(w.tactical.rows(), |r| r.battle_id),
            ),
            (
                "battle_secret",
                rows_by_battle(w.secret.rows(), |r| r.battle_id),
            ),
            (
                "battle_wild_unit",
                rows_by_battle(w.wild_unit.rows(), |r| r.battle_id),
            ),
            (
                "battle_event",
                rows_by_battle(w.event.rows(), |r| r.battle_id),
            ),
            (
                "battle_unit",
                rows_by_battle(w.unit.rows(), |r| r.battle_id),
            ),
            (
                "battle_queue",
                rows_by_battle(w.queue.rows(), |r| r.battle_id),
            ),
            (
                "battle_deploy",
                rows_by_battle(w.deploy.rows(), |r| r.battle_id),
            ),
            (
                "battle_clock",
                rows_by_battle(w.clock.rows(), |r| r.battle_id),
            ),
        ]
    }

    /// One row in each of these re-key tables: monster + its projection,
    /// notice, inventory, quest, dialogue, heal cooldown, saved position,
    /// wallet, profile and the identity's handle.
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
        w.last_position.seed(&last_position_row(who, k));
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
        w.handle.seed(&handle_row(who, k));
    }

    /// `who`'s handle row for [`seed_rekey_rows`]: a value far above anything the
    /// host's sequence draws in a test (a seed does not advance the sequence, so a
    /// small value would collide with a later mint), distinct per `k`.
    fn handle_row(who: Identity, k: u64) -> PlayerHandle {
        PlayerHandle {
            owner_identity: who,
            discriminator: 9_100_000 + k as u32,
        }
    }

    /// A saved position distinct per `k`, in zone 1 so no default reproduces it.
    fn last_position_row(who: Identity, k: u64) -> LastPosition {
        LastPosition {
            owner_identity: who,
            zone_id: 1,
            tile_x: 2 + k as i32,
            tile_y: 3,
            facing: game_core::Direction::West,
        }
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
                "last_position",
                encs(
                    &w.last_position
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
            // bt-7: the six owner-keyed tactical tables (`battle_unit` through its
            // `Option<Identity>` owner; `battle_summary` on either side).
            (
                "battle_unit",
                encs(
                    &w.unit
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner == Some(who))
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "battle_queue",
                encs(
                    &w.queue
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "battle_deploy",
                encs(
                    &w.deploy
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "battle_clock",
                encs(
                    &w.clock
                        .rows()
                        .into_iter()
                        .filter(|r| r.player == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "battle_summary",
                encs(
                    &w.summary
                        .rows()
                        .into_iter()
                        .filter(|r| r.player_identity == who || r.opponent_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "player_formation",
                encs(
                    &w.formation
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "player_handle",
                encs(
                    &w.handle
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner_identity == who)
                        .collect::<Vec<_>>(),
                ),
            ),
        ]
    }

    /// `who`'s handle rows (zero or one on a well-formed table).
    fn handles_of(w: &W<'_>, who: Identity) -> Vec<PlayerHandle> {
        w.handle
            .rows()
            .into_iter()
            .filter(|r| r.owner_identity == who)
            .collect()
    }

    /// `who`'s minted discriminator: exactly one handle row, its value.
    fn minted(w: &W<'_>, who: Identity) -> u32 {
        let rows = handles_of(w, who);
        assert_eq!(
            rows.len(),
            1,
            "fixture: `{who}` holds exactly one handle row, got {}",
            rows.len()
        );
        rows[0].discriminator
    }

    /// `who`'s `player` row.
    fn player_of(w: &W<'_>, who: Identity) -> Player {
        w.player
            .rows()
            .into_iter()
            .find(|p| p.identity == who)
            .expect("a player row")
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
    /// live it does nothing else, so nothing is saved mid-session; the LAST
    /// disconnect removes the presence rows (player, its character, the
    /// conversation) and saves where that character stood. A stranger is untouched.
    ///
    /// kills: the own-row delete dropped or keyed on the identity (a sibling
    /// tab's row goes too); the live-session guard dropped (a second tab's
    /// close wipes the first tab's presence) or inverted (presence never
    /// cleaned); presence deletes keyed on the wrong identity; the position save
    /// dropped, taken after the character delete, keyed on another identity or
    /// built from anything but the character row.
    #[test]
    fn acct_on_disconnect_closes_its_own_session_and_waits_for_the_last() {
        let fx = fixture();
        let w = world(&fx);
        let me = id(0x15);
        let stranger = id(0x16);
        let sibling_conn: u128 = 0x5E55_9999;
        for (who, entity) in [(me, 5u64), (stranger, 6)] {
            w.player.seed(&player_row(who, entity, "p"));
            // Each stands somewhere no default reproduces, in a different place.
            w.character.seed(&Character {
                zone_id: 1,
                tile_x: 2 + entity as i32,
                tile_y: 4,
                facing: game_core::Direction::East,
                ..character_row(entity)
            });
            w.intent.seed(&intent_row(entity));
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
        assert_eq!(
            intent_ids(&w),
            vec![5, 6],
            "a live sibling connection keeps the move_intent row"
        );

        fx.run_as_conn_at(me, sibling_conn, None, at(T0 + 1), crate::on_disconnect);
        assert!(conns(&w).is_empty());
        assert_eq!(
            owned_tables(&owned_by(&w, me)),
            vec!["last_position"],
            "the last disconnect removes the presence rows and leaves the saved position"
        );
        assert_eq!(
            encs(&w.last_position.rows()),
            encs(&[LastPosition {
                owner_identity: me,
                zone_id: 1,
                tile_x: 7,
                tile_y: 4,
                facing: game_core::Direction::East,
            }]),
            "the saved position is the leaver's character's zone, tile and facing, and the \
             stranger still in the game has none"
        );
        assert!(w.character.rows().iter().all(|r| r.entity_id != 5));
        assert_eq!(
            intent_ids(&w),
            vec![6],
            "the last disconnect deletes the move_intent row with the character, and only it"
        );
        assert_eq!(
            owned_by(&w, stranger),
            stranger_before,
            "a stranger is untouched"
        );
        assert!(w.character.rows().iter().any(|r| r.entity_id == 6));
    }

    /// SR10 with the QF5.1 pin: the only player in a zone is mid-conversation,
    /// so the NPC is pinned where it wandered to. The player's last connection
    /// closes: `on_disconnect` deletes the conversation and the character, and
    /// the zone's next tick — the one code path for every way of leaving —
    /// finds the zone empty, puts the NPC back on its home tile and removes the
    /// zone's schedule row.
    ///
    /// kills: a disconnect that leaves the zone armed forever (the row survives
    /// the next tick), an empty tick that honours a pin and leaves the NPC where
    /// it stood, a pin that no longer holds while the player is present.
    #[test]
    fn sr10_last_player_disconnecting_mid_conversation_homes_the_npc_and_disarms_the_zone() {
        use crate::movement::{movement_tick, MovementTickSchedule};
        use crate::schema::Npc;
        use game_core::npc::rules::npc_step_due;
        use game_core::TilePos;
        const NPC: u64 = 1;
        const ROW: u64 = 3;
        let fx = fixture();
        let w = world(&fx);
        let _ = fx.table_keyed::<Character, u32>("character", "zone_id", |r| r.zone_id);
        let _ = fx.table_keyed::<Player, u64>("player", "entity_id", |r| r.entity_id);
        let _ = fx.table_keyed::<Npc, u32>("npc", "zone_id", |r| r.zone_id);
        let npcs = fx.table_keyed::<Npc, u64>("npc", "entity_id", |r| r.entity_id);
        // The tick's conversation pin scans the whole table.
        let _ = fx
            .table::<PlayerConversation>("player_conversation", "owner_identity", |r| {
                r.owner_identity
            })
            .scannable();
        let ticks = fx
            .table_keyed::<MovementTickSchedule, u64>("movement_tick_schedule", "id", |r| r.id)
            .writable()
            .scannable()
            .unique();
        let me = id(0x15);
        // The player stands on `character_row`'s tile (1,2); the NPC stands one
        // tile south of it, two tiles west of its home.
        let stood = TilePos { x: 1, y: 3 };
        let home = TilePos { x: 3, y: 3 };
        w.player.seed(&player_row(me, 5, "p"));
        w.character.seed(&character_row(5));
        w.intent.seed(&intent_row(5));
        w.session.seed(&PlayerSession {
            connection_id: ConnectionId::from_u128(conn_of(me)),
            identity: me,
        });
        w.conversation.seed(&PlayerConversation {
            owner_identity: me,
            npc_entity_id: NPC,
            current_node_id: "n".to_string(),
        });
        npcs.seed(&Npc {
            entity_id: NPC,
            npc_id: "elder".to_string(),
            zone_id: 0,
            home_x: home.x,
            home_y: home.y,
            wander_radius: 2,
            dialogue_tree_id: String::new(),
            interaction: game_core::NpcInteraction::Dialogue,
        });
        w.character.seed(&Character {
            tile_x: stood.x,
            tile_y: stood.y,
            ..character_row(NPC)
        });
        ticks.seed(&MovementTickSchedule {
            id: ROW,
            zone_id: 0,
            scheduled_at: ScheduleAt::Interval(std::time::Duration::from_millis(200).into()),
        });
        let map = crate::content_cache::cached_zone_tile_map(0).expect("zone 0 map");
        let counter = |now: i64| now.unsigned_abs() / game_core::STEP_MS.unsigned_abs();
        // A due tick on which the unpinned NPC would step off `stood`.
        let now = (0..200)
            .map(|k| T0 + k * 200)
            .find(|&n| {
                npc_step_due(NPC, counter(n))
                    && game_core::npc_decide(
                        stood,
                        home,
                        2,
                        game_core::Direction::South,
                        NPC,
                        counter(n),
                        map,
                    )
                    .is_some()
            })
            .expect("a due tick on which the NPC would step");
        let tick = |now: i64| {
            fx.run_as_at(scheduler(), at(now), |ctx| {
                movement_tick(
                    ctx,
                    MovementTickSchedule {
                        id: ROW,
                        zone_id: 0,
                        scheduled_at: ScheduleAt::Time(at(now)),
                    },
                )
            })
        };
        let npc_tile = |w: &W<'_>| {
            let c = w
                .character
                .rows()
                .into_iter()
                .find(|c| c.entity_id == NPC)
                .expect("the NPC's character");
            (c.tile_x, c.tile_y)
        };

        assert_eq!(tick(now), Ok(()));
        assert_eq!(
            npc_tile(&w),
            (stood.x, stood.y),
            "the conversation pins the NPC"
        );
        assert_eq!(ticks.rows().len(), 1, "the occupied zone stays armed");

        as_conn(&fx, me, None, now + 1, crate::on_disconnect);
        assert!(w.conversation.rows().is_empty(), "the conversation is gone");
        assert!(w.character.rows().iter().all(|c| c.entity_id != 5));
        assert_eq!(
            ticks.rows().len(),
            1,
            "the disconnect itself leaves the schedule to the next tick"
        );

        assert_eq!(tick(now + 200), Ok(()));
        assert_eq!(
            npc_tile(&w),
            (home.x, home.y),
            "the emptied zone's NPC is back on its home tile"
        );
        assert!(
            ticks.rows().is_empty(),
            "no schedule row is left: nothing fires in the empty world"
        );
    }

    // --- SR11: a session resumes where it left off -----------------------------

    /// What `join_game` needs beyond [`world`]: an auto-inc `character` key, an
    /// auto-inc `inventory` key (the starter kit's stacks are inserted with
    /// `inv_id: 0`) and the zone schedule table `arm_zone_tick` scans and inserts into.
    fn sr11_join_tables(fx: &Fixture) -> Handle<'_, crate::movement::MovementTickSchedule, u64> {
        let _ = fx
            .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
            .auto_inc(|r| r.entity_id, |r, v| r.entity_id = v);
        let _ = fx
            .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
            .auto_inc(|r| r.inv_id, |r, v| r.inv_id = v);
        fx.table_keyed::<crate::movement::MovementTickSchedule, u64>(
            "movement_tick_schedule",
            "id",
            |r| r.id,
        )
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.id, |r, v| r.id = v)
    }

    fn sr11_join(fx: &Fixture, who: Identity, ms: i64) -> Result<(), String> {
        as_conn(fx, who, None, ms, |ctx| {
            crate::movement::join_game(ctx, "Ada".to_string())
        })
    }

    /// `who`'s character, through its `player` row.
    fn sr11_character(w: &W<'_>, who: Identity) -> Character {
        let p = w
            .player
            .rows()
            .into_iter()
            .find(|p| p.identity == who)
            .expect("a player row");
        w.character
            .rows()
            .into_iter()
            .find(|c| c.entity_id == p.entity_id)
            .expect("its character")
    }

    /// The whole loop through the shipped reducers: a player standing in zone 1
    /// closes their last connection and joins again. The new character is a new
    /// entity on the tile, zone and facing the old one had, its zone is the one
    /// armed, and no saved row is left while the character exists. A second
    /// disconnect and join, after the character has been moved, resumes at the
    /// new place: the save is taken at each last disconnect, not once.
    ///
    /// kills: the save or the restore dropped; a restore that leaves the row (a
    /// later disconnect with no character would resurrect a stale position);
    /// zone 0 armed for a character that resumed elsewhere.
    #[test]
    fn sr11_a_disconnect_then_join_resumes_on_the_tile_left() {
        let fx = fixture();
        let w = world(&fx);
        let ticks = sr11_join_tables(&fx);
        let me = id(0x15);
        w.monster.seed(&monster_row(101, me));
        let stand = |entity: u64, x: i32, facing: game_core::Direction| {
            w.player.seed(&player_row(me, entity, "p"));
            w.character.seed(&Character {
                zone_id: 1,
                tile_x: x,
                tile_y: 4,
                facing,
                ..character_row(entity)
            });
            w.intent.seed(&intent_row(entity));
            w.session.seed(&PlayerSession {
                connection_id: ConnectionId::from_u128(conn_of(me)),
                identity: me,
            });
        };
        stand(5, 2, game_core::Direction::West);

        as_conn(&fx, me, None, T0, crate::on_disconnect);
        assert!(w.character.rows().is_empty() && w.player.rows().is_empty());
        assert_eq!(sr11_join(&fx, me, T0 + 1), Ok(()));
        let c = sr11_character(&w, me);
        assert_eq!(
            (c.zone_id, c.tile_x, c.tile_y, c.facing),
            (1, 2, 4, game_core::Direction::West),
            "the returning character stands where the last one stood"
        );
        assert_ne!(c.entity_id, 5, "it is a new character row");
        assert!(
            w.last_position.rows().is_empty(),
            "the saved row is consumed by the join"
        );
        let zones: Vec<u32> = ticks.rows().iter().map(|t| t.zone_id).collect();
        assert_eq!(zones, vec![1], "the zone resumed in is the zone armed");

        // The session walks on, then leaves and returns again.
        assert_eq!(w.player.remove(me), 1);
        assert_eq!(w.character.remove(c.entity_id), 1);
        w.intent.remove(c.entity_id);
        stand(c.entity_id, 5, game_core::Direction::North);
        as_conn(&fx, me, None, T0 + 2, crate::on_disconnect);
        assert_eq!(sr11_join(&fx, me, T0 + 3), Ok(()));
        let c = sr11_character(&w, me);
        assert_eq!(
            (c.zone_id, c.tile_x, c.tile_y, c.facing),
            (1, 5, 4, game_core::Direction::North)
        );
    }

    /// An account in its deletion grace period cannot join, and the refusal
    /// leaves its saved position in place; once the deletion is cancelled it
    /// resumes like any returning account.
    ///
    /// kills: the saved row consumed ahead of the deletion gate.
    #[test]
    fn sr11_a_deletion_grace_account_keeps_its_saved_position_until_it_returns() {
        let fx = fixture();
        let w = world(&fx);
        let _ticks = sr11_join_tables(&fx);
        let me = id(0x15);
        w.monster.seed(&monster_row(101, me));
        let active = crate::accounts::new_account_row(me, "i".to_string(), 1);
        w.account
            .seed(&crate::accounts::requested_deletion(active.clone(), T0));
        let saved = last_position_row(me, 0);
        w.last_position.seed(&saved);

        assert_eq!(
            sr11_join(&fx, me, T0 + 1),
            Err(crate::guards::REJECT_DELETION_GATED.to_string())
        );
        assert_eq!(
            encs(&w.last_position.rows()),
            encs(std::slice::from_ref(&saved)),
            "a refused join consumes nothing"
        );
        assert!(w.character.rows().is_empty());

        assert_eq!(w.account.remove(me), 1);
        w.account.seed(&active);
        assert_eq!(sr11_join(&fx, me, T0 + 2), Ok(()));
        let c = sr11_character(&w, me);
        assert_eq!(
            (c.zone_id, c.tile_x, c.tile_y, c.facing),
            (saved.zone_id, saved.tile_x, saved.tile_y, saved.facing)
        );
        assert!(w.last_position.rows().is_empty());
    }

    /// The last disconnect of an identity whose character row is already gone
    /// (an erased account's socket closing after the cascade) saves nothing.
    ///
    /// kills: a save built from the `player` row or from defaults when there is
    /// no character.
    #[test]
    fn sr11_a_disconnect_with_no_character_saves_nothing() {
        let fx = fixture();
        let w = world(&fx);
        let me = id(0x15);
        w.player.seed(&player_row(me, 5, "p"));
        w.session.seed(&PlayerSession {
            connection_id: ConnectionId::from_u128(conn_of(me)),
            identity: me,
        });
        as_conn(&fx, me, None, T0, crate::on_disconnect);
        assert!(w.player.rows().is_empty(), "the presence row still goes");
        assert!(w.last_position.rows().is_empty());
    }

    // --- the starter marker across the guest claim and the deletion cascade ------

    const EO1_MARKER: &str = "sys:starter_claimed";
    /// The elder's entity id (quest_001's NPC, dialogue tree `elder_oak_talk`).
    const EO1_ELDER: u64 = 70;

    fn eo1_strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// [`world`] plus what a fresh identity's `join_game` and the elder's dialogue
    /// reach beyond it: [`sr11_join_tables`] (the `character` and `inventory`
    /// auto-inc keys), auto-inc keys for the rows the starter monster and a started
    /// quest insert (`monster`, `player_quest`), and the starter species.
    fn eo1_world(fx: &Fixture) -> W<'_> {
        let w = world(fx);
        let _ = sr11_join_tables(fx);
        let _ = fx
            .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
            .auto_inc(|r| r.monster_id, |r, v| r.monster_id = v);
        let _ = fx
            .table::<PlayerQuestRow>("player_quest", "owner_identity", |r| r.owner_identity)
            .auto_inc(|r| r.pq_id, |r, v| r.pq_id = v);
        fx.table_keyed::<crate::schema::SpeciesRow, u32>("species_row", "id", |r| r.id)
            .seed(&crate::schema::SpeciesRow {
                id: crate::STARTER_SPECIES_ID,
                name: "s1".to_string(),
                base_hp: 30,
                base_attack: 31,
                base_defense: 32,
                base_speed: 33,
                base_sp_attack: 34,
                base_sp_defense: 35,
                affinity: game_core::Affinity::Fire,
                learnable_skill_ids: vec![1],
                ability: None,
                tier: 0,
            });
        w
    }

    /// `who`'s dialogue rows as `(sorted flags, done_quests)`.
    fn eo1_dialogue(w: &W<'_>, who: Identity) -> Vec<(Vec<String>, Vec<String>)> {
        w.dialogue
            .rows()
            .into_iter()
            .filter(|r| r.owner_identity == who)
            .map(|r| {
                let mut flags = r.flags;
                flags.sort();
                (flags, r.done_quests)
            })
            .collect()
    }

    fn eo1_marked(w: &W<'_>, who: Identity) -> bool {
        eo1_dialogue(w, who)
            .iter()
            .any(|(flags, _)| flags.iter().any(|f| f == EO1_MARKER))
    }

    /// `who`'s stacks as `(item_id, count)`, by item id.
    fn eo1_stacks(w: &W<'_>, who: Identity) -> Vec<(u32, u32)> {
        let mut v: Vec<(u32, u32)> = w
            .inventory
            .rows()
            .into_iter()
            .filter(|r| r.owner_identity == who)
            .map(|r| (r.item_id, r.count))
            .collect();
        v.sort_unstable();
        v
    }

    /// `who`'s wallet balances (one per wallet row).
    fn eo1_balances(w: &W<'_>, who: Identity) -> Vec<u64> {
        w.wallet
            .rows()
            .into_iter()
            .filter(|r| r.owner_identity == who)
            .map(|r| r.balance)
            .collect()
    }

    fn eo1_monster_count(w: &W<'_>, who: Identity) -> usize {
        w.monster
            .rows()
            .iter()
            .filter(|m| m.owner_identity == who)
            .count()
    }

    /// Guest `g` joins (its join sets the marker), finishes quest_001, starts a
    /// claim and leaves; account `c` completes the claim. quest_001's completion is
    /// staged on the guest's dialogue row (the greeting's `met_elder_oak` flag and
    /// `done_quests: ["quest_001"]`), keeping every flag the join wrote.
    fn eo1_claimed_guest(fx: &Fixture, w: &W<'_>, g: Identity, c: Identity) {
        let secret = code('9');
        assert_eq!(sr11_join(fx, g, T0), Ok(()), "the guest joins");
        assert_eq!(
            eo1_dialogue(w, g),
            vec![(eo1_strings(&[EO1_MARKER]), eo1_strings(&[]))],
            "the guest's join sets the marker"
        );
        let mut row = w
            .dialogue
            .rows()
            .into_iter()
            .find(|r| r.owner_identity == g)
            .expect("the guest's dialogue row");
        row.flags.push("met_elder_oak".to_string());
        row.done_quests.push("quest_001".to_string());
        assert_eq!(w.dialogue.remove(g), 1);
        w.dialogue.seed(&row);
        assert_eq!(
            fx.run_as_at(g, at(T0 + 1), |ctx| {
                crate::accounts::start_guest_claim(ctx, secret.clone())
            }),
            Ok(()),
            "the guest starts a claim"
        );
        assert_eq!(w.player.remove(g), 1, "the guest leaves");
        w.account
            .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));
        assert_eq!(
            signed_in(fx, c, T0 + 2, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Ok(()),
            "the account completes the claim"
        );
    }

    /// A guest that joined (the marker arrives with its join) and finished quest_001
    /// is claimed into an account: the account's dialogue row holds the marker, the
    /// guest's other flag and `done_quests: ["quest_001"]`; the account then joins
    /// through `join_game` and nothing more is granted — the wallet is still the
    /// kit's 200, the two kit stacks are unchanged and it owns exactly one monster.
    ///
    /// kills: a claim that drops the marker or the quest history; an account join
    /// that grants a second kit or a second starter because it holds no marker.
    #[test]
    fn a_claimed_account_holds_the_guests_marker_and_quests_and_its_join_grants_nothing_eo1_5() {
        let fx = fixture();
        let w = eo1_world(&fx);
        let (g, c) = (id(0x81), id(0x82));
        eo1_claimed_guest(&fx, &w, g, c);

        assert_eq!(
            eo1_dialogue(&w, c),
            vec![(
                eo1_strings(&["met_elder_oak", EO1_MARKER]),
                eo1_strings(&["quest_001"])
            )],
            "the account holds the guest's whole dialogue row"
        );
        let holdings = |w: &W<'_>| {
            (
                eo1_balances(w, c),
                eo1_stacks(w, c),
                eo1_monster_count(w, c),
            )
        };
        assert_eq!(
            holdings(&w),
            (vec![200], vec![(1, 2), (3, 1)], 1),
            "the account holds the guest's kit and starter"
        );

        assert_eq!(sr11_join(&fx, c, T0 + 3), Ok(()), "the account joins");
        assert_eq!(
            holdings(&w),
            (vec![200], vec![(1, 2), (3, 1)], 1),
            "the account's join grants nothing more"
        );
    }

    /// After the same claim the retired guest keeps a tombstone dialogue row holding
    /// exactly the marker and `done_quests: ["quest_001"]`. It joins again through
    /// `join_game`: the join succeeds and grants no monster, no stack and no gold
    /// (its wallet stays the zeroed row the claim's copy-forward left). Then the
    /// quest loop at quest_001's NPC — `talk`, `advance_dialogue(0)` ("I seek a
    /// quest." → `StartQuest("quest_001")`), `talk` — starts no quest and pays it
    /// nothing.
    ///
    /// kills: a claim that leaves the guest no row (a second kit and starter); a
    /// tombstone without the done quests (quest_001 restarts and pays again); a
    /// tombstone that keeps an ordinary flag.
    #[test]
    fn a_retired_guest_rejoins_with_no_kit_no_starter_and_no_quest_reward_eo1_6() {
        let fx = fixture();
        let w = eo1_world(&fx);
        let (g, c) = (id(0x83), id(0x84));
        eo1_claimed_guest(&fx, &w, g, c);

        assert_eq!(
            eo1_dialogue(&w, g),
            vec![(eo1_strings(&[EO1_MARKER]), eo1_strings(&["quest_001"]))],
            "the guest keeps only the marker and its done quests"
        );
        assert_eq!(
            eo1_balances(&w, g),
            vec![0],
            "the claim zeroed the guest's wallet"
        );

        assert_eq!(sr11_join(&fx, g, T0 + 3), Ok(()), "the retired guest joins");
        assert_eq!(eo1_monster_count(&w, g), 0, "no starter monster");
        assert!(eo1_stacks(&w, g).is_empty(), "no inventory row");
        assert_eq!(eo1_balances(&w, g), vec![0], "no gold");

        // The elder stands beside the guest's new character, in its zone.
        let me = sr11_character(&w, g);
        fx.table_keyed::<crate::schema::Npc, u64>("npc", "entity_id", |r| r.entity_id)
            .seed(&crate::schema::Npc {
                entity_id: EO1_ELDER,
                npc_id: "elder_oak".to_string(),
                zone_id: me.zone_id,
                home_x: me.tile_x + 1,
                home_y: me.tile_y,
                wander_radius: 0,
                dialogue_tree_id: "elder_oak_talk".to_string(),
                interaction: game_core::NpcInteraction::Dialogue,
            });
        w.character.seed(&Character {
            zone_id: me.zone_id,
            tile_x: me.tile_x + 1,
            tile_y: me.tile_y,
            ..character_row(EO1_ELDER)
        });
        let talk = |ms: i64| as_conn(&fx, g, None, ms, |ctx| crate::npc::talk(ctx, EO1_ELDER));
        assert_eq!(talk(T0 + 4), Ok(()), "talk");
        assert_eq!(
            as_conn(&fx, g, None, T0 + 5, |ctx| crate::npc::advance_dialogue(
                ctx, 0
            )),
            Ok(()),
            "advance_dialogue(0)"
        );
        assert_eq!(talk(T0 + 6), Ok(()), "talk again");
        assert!(
            w.quest.rows().iter().all(|q| q.owner_identity != g),
            "quest_001 is not started again"
        );
        assert_eq!(eo1_balances(&w, g), vec![0], "the quest pays nothing");
        assert_eq!(
            eo1_dialogue(&w, g)
                .into_iter()
                .map(|(_, done)| done)
                .collect::<Vec<_>>(),
            vec![eo1_strings(&["quest_001"])],
            "quest_001 is still done once"
        );
    }

    /// A guest WITHOUT the marker (it joined before the marker existed: it owns a
    /// monster and a dialogue row of ordinary flags and a done quest) is claimed.
    /// The retired guest then joins through `join_game`: the join succeeds and
    /// grants no monster, no stack and no gold, and its dialogue row is exactly the
    /// marker plus its done quests. The account, which holds the guest's monster and
    /// no marker, joins: it gets the kit (200 gold, 2 Lure Berries, 1 Antidote) and
    /// the marker, and no second monster.
    ///
    /// kills: a tombstone written only for a guest that held a `sys:` flag (the
    /// marker-less retired guest re-joins monster-less and is granted a second
    /// starter and kit); a claim that hands the account a marker it never earned
    /// (the legacy account never gets its kit).
    #[test]
    fn a_retired_marker_less_guest_rejoins_with_no_kit_and_no_starter_eo1_6() {
        let fx = fixture();
        let w = eo1_world(&fx);
        let (g, c) = (id(0x86), id(0x87));
        let secret = code('8');
        let m = monster_row(101, g);
        w.monster_pub.seed(&crate::marshal::pub_from_monster(&m, 0));
        w.monster.seed(&m);
        w.dialogue.seed(&PlayerDialogueStateRow {
            owner_identity: g,
            flags: eo1_strings(&["met_elder_oak"]),
            done_quests: eo1_strings(&["quest_001"]),
        });
        w.player.seed(&player_row(g, 1, "Guesty"));
        assert!(!eo1_marked(&w, g), "fixture: the guest holds no marker");
        assert_eq!(
            fx.run_as_at(g, at(T0), |ctx| {
                crate::accounts::start_guest_claim(ctx, secret.clone())
            }),
            Ok(()),
            "the guest starts a claim"
        );
        assert_eq!(w.player.remove(g), 1, "the guest leaves");
        w.account
            .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));
        assert_eq!(
            signed_in(&fx, c, T0 + 1, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Ok(()),
            "the account completes the claim"
        );

        assert_eq!(sr11_join(&fx, g, T0 + 2), Ok(()), "the retired guest joins");
        assert_eq!(eo1_monster_count(&w, g), 0, "no starter monster");
        assert!(eo1_stacks(&w, g).is_empty(), "no inventory row");
        assert!(
            eo1_balances(&w, g).is_empty(),
            "no gold: the guest held no wallet and the join creates none"
        );
        assert_eq!(
            eo1_dialogue(&w, g),
            vec![(eo1_strings(&[EO1_MARKER]), eo1_strings(&["quest_001"]))],
            "the guest's row is the marker and its done quests"
        );

        assert!(!eo1_marked(&w, c), "the claim gives the account no marker");
        assert_eq!(sr11_join(&fx, c, T0 + 3), Ok(()), "the account joins");
        assert_eq!(
            (
                eo1_balances(&w, c),
                eo1_stacks(&w, c),
                eo1_monster_count(&w, c)
            ),
            (vec![200], vec![(1, 2), (3, 1)], 1),
            "the account gets the kit and no second monster"
        );
        assert_eq!(
            eo1_dialogue(&w, c),
            vec![(
                eo1_strings(&["met_elder_oak", EO1_MARKER]),
                eo1_strings(&["quest_001"])
            )],
            "the account's join sets the marker beside the guest's moved state"
        );
    }

    /// An account joins through `join_game` (the join sets the marker), requests its
    /// deletion, and the reaper completes the cascade at the grace end: no
    /// `player_dialogue_state` row remains for it, and its next `join_game` is
    /// refused with the deletion refusal, writing no marker.
    ///
    /// kills: a cascade that leaves the dialogue row (the marker outlives the
    /// erasure); a terminal account admitted to join.
    #[test]
    fn a_completed_deletion_erases_the_marker_and_refuses_the_next_join_eo1_7() {
        let fx = fixture();
        let w = eo1_world(&fx);
        let v = id(0x85);
        w.account
            .seed(&crate::accounts::new_account_row(v, "iss".to_string(), 1));
        assert_eq!(sr11_join(&fx, v, T0), Ok(()), "the account joins");
        assert!(eo1_marked(&w, v), "the join sets the marker");

        let requested = T0 + 10;
        assert_eq!(
            signed_in(&fx, v, requested, crate::accounts::delete_account),
            Ok(()),
            "deletion requested"
        );
        let grace_end = crate::accounts::deletion_fire_at_ms(requested);
        let sched = AccountDeletionReaperSchedule {
            scheduled_id: 1,
            scheduled_at: ScheduleAt::Time(at(grace_end)),
            account_identity: v,
        };
        assert_eq!(
            fx.run_as_at(scheduler(), at(grace_end), |ctx| {
                crate::accounts::account_deletion_reaper(ctx, sched)
            }),
            Ok(()),
            "the cascade runs"
        );
        assert!(
            eo1_dialogue(&w, v).is_empty(),
            "no dialogue row, marker included, remains"
        );

        assert_eq!(
            sr11_join(&fx, v, grace_end + 1),
            Err(crate::guards::REJECT_DELETION_GATED.to_string()),
            "the erased account's join is refused"
        );
        assert!(
            eo1_dialogue(&w, v).is_empty(),
            "the refused join writes no marker"
        );
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
    /// guest, except the dialogue row's starter-marker tombstone: exactly
    /// `sys:starter_claimed` and a copy of the done quests; the two copy-forward
    /// re-keys leave the guest's wallet at zero and its profile tombstoned; the
    /// guest's handle arrives under the claimer with the same discriminator, and
    /// the guest's own handle does not count as the claimer's game data), the
    /// guest's export chunks are purged, the code
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
        // sr-4b: the board holds the true ladder before the claim (the guest and the bystander).
        for identity in ladder_oracle(&w.profile.rows(), 100) {
            w.ladder.seed(&crate::schema::LeaderboardTop { identity });
        }
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
            "last_position",
            "export_bundle",
            "player_handle",
        ] {
            if t == "player_dialogue_state" {
                // The one row the retired guest keeps: the starter-marker tombstone,
                // holding exactly the marker and a copy of the seeded row's (empty)
                // done quests; its ordinary flag `flag1` moved to the claimer.
                assert_eq!(
                    row_of(t, &owned_by(&w, g)),
                    encs(&[PlayerDialogueStateRow {
                        owner_identity: g,
                        flags: vec!["sys:starter_claimed".to_string()],
                        done_quests: vec![],
                    }]),
                    "`{t}`: the retired guest keeps only the tombstone"
                );
            } else {
                assert!(
                    row_of(t, &owned_by(&w, g)).is_empty(),
                    "`{t}`: no row may stay under the retired guest identity"
                );
            }
            if t != "export_bundle" {
                assert_eq!(
                    row_of(t, &owned_by(&w, c)).len(),
                    row_of(t, &guest_before).len(),
                    "`{t}`: every guest row must arrive under the claimer"
                );
            }
        }
        assert_eq!(
            encs(
                &w.last_position
                    .rows()
                    .into_iter()
                    .filter(|r| r.owner_identity != b)
                    .collect::<Vec<_>>()
            ),
            encs(&[last_position_row(c, 1)]),
            "the guest's saved position arrives under the claimer unchanged, so the claimed \
             account's first join resumes where the guest stood"
        );
        assert!(
            handles_of(&w, g).is_empty(),
            "the retired guest identity holds no handle row"
        );
        assert_eq!(
            encs(&w.handle.rows()),
            encs(&[handle_row(c, 1), handle_row(b, 2)]),
            "the claimer holds the guest's discriminator unchanged, and the bystander's handle \
             is the only other row, unchanged"
        );
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
        // sr-4b.2: the claim's re-key ends with the membership rescan. Three profiles rank here
        // (the claimer, the guest's tombstone, the bystander), fewer than 100, so every one is
        // a member: the claimer by the carried stats, the zero-rated tombstone like any row.
        let members = sorted_hexes(w.ladder.rows().into_iter().map(|r| r.identity));
        assert_eq!(
            members,
            sorted_hexes(ladder_oracle(&w.profile.rows(), 100)),
            "sr-4b.2: after the claim the board is the true ladder over every profile row"
        );
        assert!(
            members.contains(&c.to_hex().to_string()),
            "sr-4b.2: the claimer is a member after the claim"
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
        // `leaderboard_top` is re-keyed as a derived projection, like `monster_pub`: the
        // rescan that ends `rekey_profile` puts the claimer in the guest's place.
        // `account_has_game_data` reads neither projection, so neither has a `singles` row
        // below.
        const REKEYED: [&str; 13] = [
            "monster",
            "monster_pub",
            "pending_evolution_notice",
            "inventory",
            "player_quest",
            "player_dialogue_state",
            "heal_cooldown",
            "player_wallet",
            "profile",
            "player_formation",
            "last_position",
            "player_handle",
            "leaderboard_top",
        ];
        // Never moved onto the claimer: presence / session rows die with the
        // connection (guard 9), live interactions block the claim (guard 10),
        // telemetry and the export store are not game data, and the account is
        // the claimer's own. A live tactical battle's anchor row blocks the
        // claim (guard 10). A finished battle is not moved either: the claim
        // erases its per-battle rows and writes the tombstone identity over the
        // guest's side of its `battle` and `battle_summary` rows, as the
        // deletion cascade does. A trade session is a live interaction like a
        // trade offer: the claim deletes the claimer's sessions instead of
        // moving any onto it. A world admission and the wrong-password record
        // are not re-keyed either: a signed-in identity is a different
        // identity and passes the door itself, so a claim never moves an
        // admission onto the claimer. A world binding and a bind nonce belong
        // to the identity that presented the attestation, for the same reason:
        // a claim never moves a binding or a nonce. The claim erases the
        // retired guest's rows of all four tables and leaves the claimer's. A
        // checked account and its armed re-check belong to the identity the
        // world checked: the claim erases the retired guest's and moves none. A move
        // record belongs to the identity a character was moved away from: the claim
        // erases the retired guest's and moves none.
        const NOT_REKEYED: [&str; 22] = [
            "player",
            "player_conversation",
            "player_session",
            "battle",
            "trade_offer",
            "battle_challenge",
            "playtest_event",
            "export_bundle",
            "account",
            "battle_unit",
            "battle_queue",
            "battle_deploy",
            "battle_clock",
            "battle_summary",
            "trade_session",
            "world_admission",
            "world_admission_attempt",
            "world_binding",
            "world_bind_nonce",
            "world_account",
            "recheck_schedule",
            "world_move",
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
            w.formation.remove(g);
            w.last_position.remove(g);
            w.handle.remove(g);
        };
        wipe(&w);
        assert!(owned_tables(&owned_by(&w, g)).is_empty());
        let singles: [(&str, &dyn Fn()); 11] = [
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
            ("player_formation", &|| {
                w.formation.seed(&PlayerFormation {
                    owner_identity: g,
                    monster_ids: vec![103],
                })
            }),
            ("last_position", &|| {
                w.last_position.seed(&last_position_row(g, 3))
            }),
            ("player_handle", &|| w.handle.seed(&handle_row(g, 3))),
        ];
        for (table, seed) in singles {
            seed();
            let has = fx.run_as(g, |ctx| crate::accounts::account_has_game_data(ctx, g));
            assert!(has, "a lone `{table}` row must count as game data");
            wipe(&w);
        }
    }

    // --- the character move (`accounts::move_character`) ---------------------

    /// The tables whose rows `move_character` carries from the source to the destination,
    /// as `owned_by` names them.
    const LPW42_MOVED: [&str; 12] = [
        "monster",
        "monster_pub",
        "pending_evolution_notice",
        "inventory",
        "player_quest",
        "player_dialogue_state",
        "heal_cooldown",
        "last_position",
        "player_wallet",
        "profile",
        "player_formation",
        "player_handle",
    ];

    /// The source, the destination, a bystander with its own character, and a peer the
    /// source has challenges and a finished battle with.
    fn lpw42_ids() -> (Identity, Identity, Identity, Identity) {
        (id(0x91), id(0x92), id(0x93), id(0x94))
    }

    /// One character: two monsters, a notice, two stacks, two quests, a dialogue row, a heal
    /// cooldown, a saved position, a non-zero wallet, a ranked profile, a formation and a
    /// handle. Every value is fixed but the owner, so the same call for another identity is
    /// that character moved there.
    struct Lpw42Character {
        monsters: Vec<Monster>,
        notice: PendingEvolutionNotice,
        stacks: Vec<Inventory>,
        quests: Vec<PlayerQuestRow>,
        dialogue: PlayerDialogueStateRow,
        heal: HealCooldown,
        position: LastPosition,
        wallet: PlayerWallet,
        profile: Profile,
        formation: PlayerFormation,
        handle: PlayerHandle,
    }

    fn lpw42_character(who: Identity) -> Lpw42Character {
        Lpw42Character {
            monsters: vec![
                monster_row(4101, who),
                Monster {
                    party_slot: 1,
                    level: 9,
                    ..monster_row(4102, who)
                },
            ],
            notice: PendingEvolutionNotice {
                owner_identity: who,
                entries: vec![EvolutionRevealRow {
                    monster_id: 4101,
                    from_species: 1,
                    to_species: 2,
                    evolved_at_ms: 3,
                }],
            },
            stacks: vec![
                Inventory {
                    inv_id: 4201,
                    owner_identity: who,
                    item_id: 4,
                    count: 5,
                },
                Inventory {
                    inv_id: 4202,
                    owner_identity: who,
                    item_id: 7,
                    count: 2,
                },
            ],
            quests: vec![
                PlayerQuestRow {
                    pq_id: 4301,
                    owner_identity: who,
                    quest_id: "quest_a".to_string(),
                    step_index: 1,
                },
                PlayerQuestRow {
                    pq_id: 4302,
                    owner_identity: who,
                    quest_id: "quest_b".to_string(),
                    step_index: 3,
                },
            ],
            dialogue: PlayerDialogueStateRow {
                owner_identity: who,
                flags: vec!["met_elder_oak".to_string(), EO1_MARKER.to_string()],
                done_quests: vec!["quest_001".to_string()],
            },
            heal: HealCooldown {
                owner_identity: who,
                last_heal_at_ms: 4400,
            },
            position: LastPosition {
                owner_identity: who,
                zone_id: 1,
                tile_x: 7,
                tile_y: 8,
                facing: game_core::Direction::West,
            },
            wallet: PlayerWallet {
                owner_identity: who,
                balance: 4500,
            },
            profile: Profile {
                identity: who,
                name: "Wanderer".to_string(),
                rating: 1612,
                wins: 9,
                losses: 4,
            },
            formation: PlayerFormation {
                owner_identity: who,
                monster_ids: vec![4101, 4102],
            },
            handle: PlayerHandle {
                owner_identity: who,
                discriminator: 9_200_001,
            },
        }
    }

    fn lpw42_seed(w: &W<'_>, c: &Lpw42Character) {
        for m in &c.monsters {
            w.monster_pub.seed(&crate::marshal::pub_from_monster(m, 0));
            w.monster.seed(m);
        }
        w.notice.seed(&c.notice);
        for s in &c.stacks {
            w.inventory.seed(s);
        }
        for q in &c.quests {
            w.quest.seed(q);
        }
        w.dialogue.seed(&c.dialogue);
        w.heal.seed(&c.heal);
        w.last_position.seed(&c.position);
        w.wallet.seed(&c.wallet);
        w.profile.seed(&c.profile);
        w.formation.seed(&c.formation);
        w.handle.seed(&c.handle);
    }

    /// `c`'s rows per moved table, as sorted canonical bytes.
    fn lpw42_expected(
        c: &Lpw42Character,
    ) -> std::collections::BTreeMap<&'static str, Vec<Vec<u8>>> {
        let pubs: Vec<MonsterPub> = c
            .monsters
            .iter()
            .map(|m| crate::marshal::pub_from_monster(m, 0))
            .collect();
        std::collections::BTreeMap::from([
            ("monster", encs(&c.monsters)),
            ("monster_pub", encs(&pubs)),
            (
                "pending_evolution_notice",
                encs(std::slice::from_ref(&c.notice)),
            ),
            ("inventory", encs(&c.stacks)),
            ("player_quest", encs(&c.quests)),
            (
                "player_dialogue_state",
                encs(std::slice::from_ref(&c.dialogue)),
            ),
            ("heal_cooldown", encs(std::slice::from_ref(&c.heal))),
            ("last_position", encs(std::slice::from_ref(&c.position))),
            ("player_wallet", encs(std::slice::from_ref(&c.wallet))),
            ("profile", encs(std::slice::from_ref(&c.profile))),
            ("player_formation", encs(std::slice::from_ref(&c.formation))),
            ("player_handle", encs(std::slice::from_ref(&c.handle))),
        ])
    }

    /// The rows `who` holds in the moved tables.
    fn lpw42_held(
        w: &W<'_>,
        who: Identity,
    ) -> std::collections::BTreeMap<&'static str, Vec<Vec<u8>>> {
        owned_by(w, who)
            .into_iter()
            .filter(|(t, _)| LPW42_MOVED.contains(t))
            .collect()
    }

    /// What stays under the source as history or as its own connection and admission: the
    /// finished battle's anchor and summary, the source's playtest event, admission, session,
    /// account, checked account and armed re-check.
    fn lpw42_history(w: &W<'_>) -> Vec<(&'static str, Vec<Vec<u8>>)> {
        vec![
            ("battle", encs(&w.battle.rows())),
            ("battle_summary", encs(&w.summary.rows())),
            ("playtest_event", encs(&w.playtest.rows())),
            ("world_admission", encs(&w.admission.rows())),
            ("player_session", encs(&w.session.rows())),
            ("account", encs(&w.account.rows())),
            ("world_account", encs(&w.world_account.rows())),
            ("recheck_schedule", encs(&w.recheck.rows())),
        ]
    }

    /// The source holds one character (offline: a saved position, no `player` row), a
    /// conversation row, two challenges with the peer (one in each role, each with its reaper),
    /// an export chunk, a finished battle with the peer, a playtest event, an admission, a
    /// session, an account, a checked account and an armed re-check. The bystander holds its
    /// own character, a challenge from the peer and an export chunk. The board holds the true
    /// ladder.
    fn lpw42_seed_world(w: &W<'_>) {
        let (from, _, b, p) = lpw42_ids();
        lpw42_seed(w, &lpw42_character(from));
        seed_rekey_rows(w, b, 2);
        for identity in ladder_oracle(&w.profile.rows(), 100) {
            w.ladder.seed(&crate::schema::LeaderboardTop { identity });
        }
        w.conversation.seed(&PlayerConversation {
            owner_identity: from,
            npc_entity_id: 3,
            current_node_id: "n".to_string(),
        });
        for (challenge_id, challenger, target, status) in [
            (4601u64, from, p, ChallengeStatus::Pending),
            (4602, p, from, ChallengeStatus::Accepted),
            (4603, p, b, ChallengeStatus::Pending),
        ] {
            w.challenge
                .seed(&challenge_row(challenge_id, challenger, target, status));
            w.challenge_reaper.seed(&BattleChallengeReaperSchedule {
                scheduled_id: challenge_id,
                scheduled_at: ScheduleAt::Time(at(T0)),
                challenge_id,
            });
        }
        w.export.seed(&export_row(4701, from, T0 - 5));
        w.export.seed(&export_row(4702, b, T0 - 5));
        seed_tactical_battle(w, 4801, from, Some(p));
        w.playtest.seed(&PlaytestEvent {
            event_id: 4901,
            identity: from,
            kind: 1,
            created_at_ms: 1,
            battle_id: 4801,
            species_id: 1,
            hp_permille: 500,
            bait_item_id: 0,
            success: true,
        });
        w.admission.seed(&WorldAdmission {
            identity: from,
            admitted_at_ms: T0 - 100,
        });
        w.session.seed(&PlayerSession {
            connection_id: ConnectionId::from_u128(0x4242),
            identity: from,
        });
        w.account.seed(&crate::accounts::new_account_row(
            from,
            "iss".to_string(),
            1,
        ));
        w.world_account.seed(&crate::account_checks::WorldAccount {
            handle: "k1.lpw42-source".to_string(),
            identity: from,
            entitled: true,
            checked_at_ms: T0 - 50,
            is_host: false,
        });
        w.recheck.seed(&crate::account_checks::RecheckSchedule {
            scheduled_id: 1,
            scheduled_at: ScheduleAt::Time(at(T0 + 5)),
            identity: from,
        });
    }

    fn lpw42_move(fx: &Fixture, from: Identity, to: Identity, ms: i64) -> Result<(), String> {
        fx.run_as_at(to, at(ms), |ctx| {
            crate::accounts::move_character(ctx, from, to)
        })
    }

    /// `move_character(from, to)` over a source seeded in every table the move reaches: the
    /// destination holds each moved row with only the owner changed, the source holds none of
    /// them, nor a conversation, a challenge or an export chunk; the challenges' reapers go;
    /// the board ranks the destination in the source's place; the finished battle and every
    /// row about the source's connection and admission stay byte-equal; the move writes no
    /// `world_account`, `world_move` or `recheck_schedule` row; the bystander is untouched.
    ///
    /// kills: any moved table left behind (a re-key helper dropped from the move); a wallet
    /// zeroed in place instead of removed, or a dialogue marker row left at the source; a
    /// profile re-keyed through the claim's tombstoning (the source keeps a zeroed row, the
    /// destination a fresh name); the challenge or export purge dropped; a challenge reaper
    /// left armed; the board not rescanned; a move that erases a finished battle, the session,
    /// the admission or the account; a move that writes the redeem's tables itself; a helper
    /// keyed on the wrong identity (the bystander loses rows).
    #[test]
    fn move_character_carries_every_row_and_leaves_the_source_only_its_history_lpw42_1() {
        let fx = fixture();
        let w = world(&fx);
        let (from, to, b, _) = lpw42_ids();
        lpw42_seed_world(&w);
        let history_before = lpw42_history(&w);
        let tactical_before = per_battle_rows(&w);
        let bystander_before = owned_by(&w, b);
        fx.reset_writes();

        assert_eq!(lpw42_move(&fx, from, to, T0 + 100), Ok(()), "the move runs");

        assert_eq!(
            lpw42_held(&w, to),
            lpw42_expected(&lpw42_character(to)),
            "every moved row is at the destination, owner re-keyed, nothing else changed"
        );
        assert_eq!(
            owned_tables(&owned_by(&w, from)),
            vec![
                "account",
                "playtest_event",
                "player_session",
                "battle_unit",
                "battle_clock",
                "battle_summary"
            ],
            "the source keeps only its account, telemetry, session and finished battle"
        );
        assert_eq!(
            owned_tables(&owned_by(&w, to)),
            vec![
                "profile",
                "monster",
                "monster_pub",
                "pending_evolution_notice",
                "inventory",
                "player_quest",
                "player_dialogue_state",
                "heal_cooldown",
                "last_position",
                "player_wallet",
                "player_formation",
                "player_handle"
            ],
            "the destination holds rows in the moved tables only: no conversation, challenge, \
             export chunk, session, account or battle row"
        );
        assert_eq!(
            lpw42_history(&w),
            history_before,
            "the finished battle, telemetry, admission, session, account, checked account \
             and re-check are byte-equal"
        );
        assert_eq!(
            per_battle_rows(&w),
            tactical_before,
            "the finished battle's per-battle rows are byte-equal"
        );
        let challenges: Vec<u64> = w.challenge.rows().iter().map(|c| c.challenge_id).collect();
        assert_eq!(
            challenges,
            vec![4603],
            "both challenges naming the source go; the peer's challenge to the bystander stays"
        );
        let reapers: Vec<u64> = w
            .challenge_reaper
            .rows()
            .iter()
            .map(|r| r.challenge_id)
            .collect();
        assert_eq!(
            reapers,
            vec![4603],
            "a deleted challenge's reaper goes with it"
        );
        assert!(
            chunks_of(&w, from).is_empty() && chunks_of(&w, to).is_empty(),
            "the source's export chunk is purged and none is written for the destination"
        );
        let members = sorted_hexes(w.ladder.rows().into_iter().map(|r| r.identity));
        assert_eq!(
            members,
            sorted_hexes(ladder_oracle(&w.profile.rows(), 100)),
            "the board is the true ladder after the move"
        );
        assert!(
            members.contains(&to.to_hex().to_string())
                && !members.contains(&from.to_hex().to_string()),
            "the destination ranks in the source's place: {members:?}"
        );
        for table in ["world_account", "world_move", "recheck_schedule"] {
            assert_eq!(
                fx.writes_to(table),
                0,
                "move_character writes no `{table}` row (the redeem does)"
            );
        }
        assert!(
            w.world_move.rows().is_empty(),
            "no world_move row is written"
        );
        assert_eq!(
            owned_by(&w, b),
            bystander_before,
            "the bystander's rows are untouched"
        );
    }

    /// A character moved to `to` and back to `from` arrives under `from` byte-equal to the seed
    /// (the wallet holds a non-zero balance, so it is carried both ways), and `to` is left
    /// nothing: the source of a move can receive the character again.
    ///
    /// kills: a move that leaves a row at the source that blocks or collides with the move
    /// back (a zeroed wallet, a dialogue marker, a tombstoned profile); a move that leaves the
    /// destination a copy of anything; a value changed in transit (a monster tier, a stack
    /// count, a discriminator).
    #[test]
    fn a_character_moved_back_is_byte_equal_to_the_seed_and_the_destination_holds_nothing_lpw42_1()
    {
        let fx = fixture();
        let w = world(&fx);
        let (from, to, _, _) = lpw42_ids();
        lpw42_seed_world(&w);
        assert_eq!(
            lpw42_move(&fx, from, to, T0 + 100),
            Ok(()),
            "the first move runs"
        );
        assert_eq!(
            lpw42_held(&w, to),
            lpw42_expected(&lpw42_character(to)),
            "precondition: the first move carries the character to the destination"
        );

        assert_eq!(
            lpw42_move(&fx, to, from, T0 + 200),
            Ok(()),
            "the move back runs"
        );

        assert_eq!(
            lpw42_held(&w, from),
            lpw42_expected(&lpw42_character(from)),
            "the character is back under the source, byte-equal to the seed"
        );
        assert!(
            owned_tables(&owned_by(&w, to)).is_empty(),
            "the destination holds nothing after the move back"
        );
        let members = sorted_hexes(w.ladder.rows().into_iter().map(|r| r.identity));
        assert!(
            members.contains(&from.to_hex().to_string())
                && !members.contains(&to.to_hex().to_string()),
            "the source ranks again and the destination does not: {members:?}"
        );
    }

    /// `owns_character`: no row is no character; a lone row in each table the contract counts
    /// (a `player` row included) is one; a lone row in a table it does not count is none; the
    /// source of a move owns none afterwards and the destination owns one.
    ///
    /// kills: the `player` arm dropped; a delegate of `account_has_game_data` not reached; a
    /// predicate counting the account, the session, the admission or a world_move row; a
    /// predicate keyed on the caller instead of its argument.
    #[test]
    fn owns_character_is_a_player_row_or_game_data_lpw42_1() {
        let fx = fixture();
        let w = world(&fx);
        let x = id(0x95);
        let owns =
            |who: Identity| fx.run_as(id(0x96), |ctx| crate::accounts::owns_character(ctx, who));
        assert!(!owns(x), "an identity with no row owns no character");

        let c = lpw42_character(x);
        let wipe = |w: &W<'_>| {
            w.player.remove(x);
            w.monster.remove(x);
            w.notice.remove(x);
            w.inventory.remove(x);
            w.quest.remove(x);
            w.dialogue.remove(x);
            w.heal.remove(x);
            w.wallet.remove(x);
            w.profile.remove(x);
            w.formation.remove(x);
            w.last_position.remove(x);
            w.handle.remove(x);
            w.account.remove(x);
            w.session.remove(x);
            w.admission.remove(x);
            w.world_move.remove(x);
        };
        let counted: [(&str, &dyn Fn()); 12] = [
            ("player", &|| w.player.seed(&player_row(x, 4950, "Solo"))),
            ("monster", &|| w.monster.seed(&c.monsters[0])),
            ("pending_evolution_notice", &|| w.notice.seed(&c.notice)),
            ("inventory", &|| w.inventory.seed(&c.stacks[0])),
            ("player_quest", &|| w.quest.seed(&c.quests[0])),
            ("player_dialogue_state", &|| w.dialogue.seed(&c.dialogue)),
            ("heal_cooldown", &|| w.heal.seed(&c.heal)),
            ("player_wallet", &|| w.wallet.seed(&c.wallet)),
            ("profile", &|| w.profile.seed(&c.profile)),
            ("player_formation", &|| w.formation.seed(&c.formation)),
            ("last_position", &|| w.last_position.seed(&c.position)),
            ("player_handle", &|| w.handle.seed(&c.handle)),
        ];
        for (table, seed) in counted {
            seed();
            assert!(owns(x), "a lone `{table}` row is a character");
            wipe(&w);
        }
        let uncounted: [(&str, &dyn Fn()); 4] = [
            ("account", &|| {
                w.account
                    .seed(&crate::accounts::new_account_row(x, "iss".to_string(), 1))
            }),
            ("player_session", &|| {
                w.session.seed(&PlayerSession {
                    connection_id: ConnectionId::from_u128(0x4950),
                    identity: x,
                })
            }),
            ("world_admission", &|| {
                w.admission.seed(&WorldAdmission {
                    identity: x,
                    admitted_at_ms: T0,
                })
            }),
            ("world_move", &|| {
                w.world_move.seed(&crate::account_checks::WorldMove {
                    identity: x,
                    moved_at_ms: T0,
                })
            }),
        ];
        for (table, seed) in uncounted {
            seed();
            assert!(!owns(x), "a lone `{table}` row is no character");
            wipe(&w);
        }

        let (from, to) = (id(0x97), id(0x98));
        lpw42_seed(&w, &lpw42_character(from));
        assert!(owns(from), "precondition: the source owns its character");
        assert_eq!(lpw42_move(&fx, from, to, T0), Ok(()), "the move runs");
        assert!(!owns(from), "the source owns no character after the move");
        assert!(
            owns(to),
            "the destination owns the character after the move"
        );
    }

    /// `in_battle_or_trade`, one identity per case: an `Ongoing` battle as player and as a
    /// non-wild opponent count; the wild sentinel opponent does not count for
    /// `WILD_IDENTITY` while that battle's player does; a finished battle in either role does
    /// not count; a trade offer as initiator and as counterparty count; a trade session as
    /// opener and as partner count; no row is not in one.
    ///
    /// kills: either battle arm dropped; the wild-sentinel exclusion dropped; a finished battle
    /// counted; either offer arm or either session arm dropped; a predicate true for everyone.
    #[test]
    fn in_battle_or_trade_truth_table_lpw42_3() {
        let fx = fixture();
        let w = world(&fx);
        let busy = |who: Identity| {
            fx.run_as(id(0x9F), |ctx| {
                crate::accounts::in_battle_or_trade(ctx, who)
            })
        };
        let battle = |battle_id: u64, player: Identity, opponent: Identity, ongoing: bool| {
            let mut row = battle_row(player, opponent);
            row.battle_id = battle_id;
            if !ongoing {
                row.state.outcome = game_core::BattleOutcome::SideAWins;
            }
            w.battle.seed(&row);
        };
        let (as_player, as_opponent, wild_player) = (id(0xA1), id(0xA3), id(0xA5));
        let (done_player, done_opponent) = (id(0xA6), id(0xA8));
        let (initiator, counterparty, opener, partner) = (id(0xAA), id(0xAC), id(0xAE), id(0xB0));
        let nobody = id(0xB2);
        battle(5001, as_player, id(0xA2), true);
        battle(5002, id(0xA4), as_opponent, true);
        battle(5003, wild_player, crate::WILD_IDENTITY, true);
        battle(5004, done_player, done_opponent, false);
        w.trade.seed(&trade_row(5101, initiator, id(0xAB)));
        w.trade.seed(&trade_row(5102, id(0xAD), counterparty));
        w.trade_session
            .seed(&session_row(5201, opener, id(0xAF), T0));
        w.trade_session
            .seed(&session_row(5202, id(0xB1), partner, T0));

        for (label, who, want) in [
            ("an Ongoing battle as player", as_player, true),
            (
                "an Ongoing battle as a non-wild opponent",
                as_opponent,
                true,
            ),
            ("the player of a wild battle", wild_player, true),
            ("the wild sentinel opponent", crate::WILD_IDENTITY, false),
            ("a finished battle as player", done_player, false),
            ("a finished battle as opponent", done_opponent, false),
            ("a trade offer as initiator", initiator, true),
            ("a trade offer as counterparty", counterparty, true),
            ("a trade session as opener", opener, true),
            ("a trade session as partner", partner, true),
            ("no battle and no trade", nobody, false),
        ] {
            assert_eq!(busy(who), want, "in_battle_or_trade for {label}");
        }
    }

    /// The deletion cascade erases the subject's own `world_move` row and leaves another
    /// identity's.
    ///
    /// kills: a cascade (or an `erase_world_account`) that leaves the row; one that erases
    /// every row or the wrong identity's.
    #[test]
    fn the_deletion_cascade_erases_the_subjects_world_move_row_only_lpw42_6() {
        let fx = fixture();
        let w = world(&fx);
        let (v, other) = (id(0x99), id(0x9A));
        let requested = T0;
        w.account.seed(&crate::accounts::requested_deletion(
            crate::accounts::new_account_row(v, "iss".to_string(), 1),
            requested,
        ));
        let other_row = crate::account_checks::WorldMove {
            identity: other,
            moved_at_ms: T0 - 7_000,
        };
        w.world_move.seed(&crate::account_checks::WorldMove {
            identity: v,
            moved_at_ms: T0 - 3_000,
        });
        w.world_move.seed(&other_row);
        let grace_end = crate::accounts::deletion_fire_at_ms(requested);
        let sched = AccountDeletionReaperSchedule {
            scheduled_id: 1,
            scheduled_at: ScheduleAt::Time(at(grace_end)),
            account_identity: v,
        };
        assert_eq!(
            fx.run_as_at(scheduler(), at(grace_end), |ctx| {
                crate::accounts::account_deletion_reaper(ctx, sched)
            }),
            Ok(()),
            "the cascade runs"
        );
        assert_eq!(
            encs(&w.world_move.rows()),
            encs(&[other_row]),
            "the subject's world_move row is erased and the other identity's stays"
        );
    }

    /// The guest claim erases the retired guest's `world_move` row and leaves another
    /// identity's.
    ///
    /// kills: a claim that leaves the guest's row (the retired guest would still be told its
    /// character moved), or that moves it onto the claimer, or erases another identity's.
    #[test]
    fn the_guest_claim_erases_the_retired_guests_world_move_row_only_lpw42_6() {
        let fx = fixture();
        let w = world(&fx);
        let (g, c, other) = (id(0x9B), id(0x9C), id(0x9D));
        let secret = code('6');
        w.player.seed(&player_row(g, 1, "Guesty"));
        assert_eq!(
            fx.run_as_at(g, at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                secret.clone()
            )),
            Ok(()),
            "the guest starts a claim"
        );
        assert_eq!(w.player.remove(g), 1, "the guest leaves");
        seed_rekey_rows(&w, g, 5);
        let other_row = crate::account_checks::WorldMove {
            identity: other,
            moved_at_ms: T0 - 9_000,
        };
        w.world_move.seed(&crate::account_checks::WorldMove {
            identity: g,
            moved_at_ms: T0 - 4_000,
        });
        w.world_move.seed(&other_row);
        w.account
            .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));
        assert_eq!(
            signed_in(&fx, c, T0 + 1_000, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Ok(()),
            "the account completes the claim"
        );
        assert_eq!(
            encs(&w.world_move.rows()),
            encs(&[other_row]),
            "the retired guest's world_move row is erased, none is moved onto the claimer, \
             and the other identity's stays"
        );
    }

    /// A signed-in account whose character plays under another identity (it holds a
    /// `world_move` row) is refused `complete_guest_claim` with the moved-character reason, for
    /// a live code, an unknown code and a malformed code alike, and nothing changes; without
    /// the `world_move` row the same claim succeeds.
    ///
    /// kills: the guard missing (the caller takes the guest's character and can then neither
    /// join nor check in); the guard placed after the code checks (a malformed or unknown code
    /// answers differently from a live one: a code oracle); a guard keyed on anything but the
    /// caller's own row; a refusal that writes.
    #[test]
    fn a_guest_claim_by_a_caller_whose_character_moved_is_refused_before_the_code_lpw42_3() {
        let fx = fixture();
        let w = world(&fx);
        let (g, c) = (id(0xBA), id(0xBB));
        let live = code('5');
        w.player.seed(&player_row(g, 1, "Guesty"));
        assert_eq!(
            fx.run_as_at(g, at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                live.clone()
            )),
            Ok(()),
            "the guest starts a claim"
        );
        assert_eq!(w.player.remove(g), 1, "the guest leaves");
        seed_rekey_rows(&w, g, 6);
        w.account
            .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));
        w.world_move.seed(&crate::account_checks::WorldMove {
            identity: c,
            moved_at_ms: T0 - 2_000,
        });
        let snapshot = |w: &W<'_>| {
            (
                encs(&w.claim.rows()),
                encs(&w.claim_reaper.rows()),
                owned_by(w, g),
                owned_by(w, c),
                encs(&w.world_move.rows()),
            )
        };
        let before = snapshot(&w);
        let claim = |k: &str, ms: i64| {
            signed_in(&fx, c, ms, |ctx| {
                crate::accounts::complete_guest_claim(ctx, k.to_string())
            })
        };
        fx.reset_writes();

        for (label, k) in [
            ("a live code", live.clone()),
            ("an unknown code", code('d')),
            ("a malformed code", "not-a-code".to_string()),
        ] {
            assert_eq!(
                claim(&k, T0 + 10),
                Err(crate::account_checks::REJECT_CHARACTER_MOVED.to_string()),
                "{label}: the moved-character refusal, before the code is read"
            );
        }
        assert_eq!(
            crate::account_checks::REJECT_CHARACTER_MOVED,
            "this character is playing on another client; sign in again to play here"
        );
        assert_eq!(snapshot(&w), before, "a refused claim changes nothing");
        for table in [
            "account",
            "guest_claim",
            "guest_claim_reaper_schedule",
            "player",
            "monster",
            "monster_pub",
            "pending_evolution_notice",
            "inventory",
            "player_quest",
            "player_dialogue_state",
            "heal_cooldown",
            "last_position",
            "player_wallet",
            "profile",
            "leaderboard_top",
            "player_formation",
            "player_handle",
            "export_bundle",
            "world_account",
            "recheck_schedule",
            "world_move",
        ] {
            assert_eq!(
                fx.writes_to(table),
                0,
                "a refused claim writes no `{table}` row"
            );
        }

        assert_eq!(w.world_move.remove(c), 1, "the caller checks in again");
        assert_eq!(
            claim(&live, T0 + 20),
            Ok(()),
            "without the world_move row the same claim succeeds"
        );
        assert!(
            w.claim.rows().is_empty(),
            "the successful claim consumes the code"
        );
    }

    /// `erase_world_account` deletes the identity's account row and answers whether one went
    /// (`false` for an identity holding a `world_move` row and no account row, `true` for one
    /// holding both), and leaves every `world_move` row byte-equal: an unbind or the owner's drop,
    /// which reach only this helper, never clear the record that a character moved away. A third
    /// identity's account row stays.
    ///
    /// kills: a `world_move` delete folded into `erase_world_account` (an unbind would let a
    /// moved-away identity join again and be granted a second starter); the answer taken from
    /// anything but the account row; an account delete keyed on another identity.
    #[test]
    fn erase_world_account_leaves_every_world_move_row_and_answers_for_the_account_row_lpw42_6() {
        let fx = fixture();
        let w = world(&fx);
        let (moved_only, both, other) = (id(0x9E), id(0xB3), id(0xB4));
        let move_of = |who: Identity, ms: i64| crate::account_checks::WorldMove {
            identity: who,
            moved_at_ms: ms,
        };
        let account_of = |who: Identity, handle: &str| crate::account_checks::WorldAccount {
            handle: handle.to_string(),
            identity: who,
            entitled: true,
            checked_at_ms: T0,
            is_host: false,
        };
        w.world_move.seed(&move_of(moved_only, T0 - 1));
        w.world_move.seed(&move_of(both, T0 - 2));
        w.world_move.seed(&move_of(other, T0 - 3));
        w.world_account.seed(&account_of(both, "k1.lpw42-both"));
        w.world_account.seed(&account_of(other, "k1.lpw42-other"));
        let erase = |who: Identity| {
            fx.run_as(id(0xB5), |ctx| {
                crate::account_checks::erase_world_account(ctx, who)
            })
        };

        let moves_before = encs(&w.world_move.rows());
        fx.reset_writes();

        assert!(
            !erase(moved_only),
            "no world_account row went, so the answer is false"
        );
        assert!(
            erase(both),
            "a world_account row went, so the answer is true"
        );
        assert_eq!(
            encs(&w.world_account.rows()),
            encs(&[account_of(other, "k1.lpw42-other")]),
            "the erased identity's account row goes and the third identity's stays"
        );
        assert_eq!(
            encs(&w.world_move.rows()),
            moves_before,
            "every world_move row is byte-equal"
        );
        assert_eq!(
            fx.writes_to("world_move"),
            0,
            "erase_world_account writes no world_move row"
        );
    }

    /// `erase_world_move` deletes the identity's `world_move` row and no other identity's, and
    /// writes nothing for an identity holding none.
    ///
    /// kills: an empty body; a delete keyed on another identity or clearing every row; a
    /// delete issued for an identity with no row.
    #[test]
    fn erase_world_move_deletes_only_that_identitys_row_lpw42_6() {
        let fx = fixture();
        let w = world(&fx);
        let (moved, other, unmoved) = (id(0xB6), id(0xB7), id(0xB8));
        let move_of = |who: Identity, ms: i64| crate::account_checks::WorldMove {
            identity: who,
            moved_at_ms: ms,
        };
        w.world_move.seed(&move_of(moved, T0 - 11));
        w.world_move.seed(&move_of(other, T0 - 12));
        let erase = |who: Identity| {
            fx.run_as(id(0xB9), |ctx| {
                crate::account_checks::erase_world_move(ctx, who)
            })
        };

        fx.reset_writes();
        erase(unmoved);
        assert_eq!(
            fx.writes_to("world_move"),
            0,
            "an identity holding no world_move row costs no write"
        );
        assert_eq!(
            encs(&w.world_move.rows()),
            encs(&[move_of(moved, T0 - 11), move_of(other, T0 - 12)]),
            "no row goes for an identity holding none"
        );

        erase(moved);
        assert_eq!(
            encs(&w.world_move.rows()),
            encs(&[move_of(other, T0 - 12)]),
            "the identity's row goes and the other identity's stays"
        );
    }

    // --- the minted discriminator across the claim, the cascade and the gate ----

    /// `who` requests its deletion at `requested` and the real
    /// `account_deletion_reaper` runs at the grace end. Returns the grace end.
    fn deletion_completed_for(fx: &Fixture, who: Identity, requested: i64) -> i64 {
        assert_eq!(
            signed_in(fx, who, requested, crate::accounts::delete_account),
            Ok(()),
            "deletion requested"
        );
        let grace_end = crate::accounts::deletion_fire_at_ms(requested);
        let sched = AccountDeletionReaperSchedule {
            scheduled_id: 1,
            scheduled_at: ScheduleAt::Time(at(grace_end)),
            account_identity: who,
        };
        assert_eq!(
            fx.run_as_at(scheduler(), at(grace_end), |ctx| {
                crate::accounts::account_deletion_reaper(ctx, sched)
            }),
            Ok(()),
            "the cascade runs"
        );
        grace_end
    }

    /// A guest joins through `join_game` (minted `d`), starts a claim and leaves;
    /// an account completes the claim and holds `d`, and the guest identity holds
    /// no handle. The retired guest then joins again through `join_game`: its new
    /// handle row and its new `player` row carry one value, non-zero and not `d`,
    /// while the account still holds exactly `d`.
    ///
    /// kills: a tag derived from the identity (the rejoin would be handed `d`
    /// again, or the account a value of its own); a re-key that copies instead of
    /// moving (the guest keeps `d`, so its rejoin mints nothing new); a rejoin
    /// whose `player` row is left at 0.
    #[test]
    fn a_retired_guest_that_rejoins_is_minted_a_fresh_discriminator_ih1_5() {
        let fx = fixture();
        let w = eo1_world(&fx);
        let (g, c) = (id(0x88), id(0x89));
        let secret = code('6');
        assert_eq!(sr11_join(&fx, g, T0), Ok(()), "the guest joins");
        let d = minted(&w, g);
        assert_ne!(d, 0, "the guest's join mints a non-zero discriminator");
        assert_eq!(
            player_of(&w, g).discriminator,
            d,
            "the guest's player row mirrors its handle"
        );
        assert_eq!(
            fx.run_as_at(g, at(T0 + 1), |ctx| {
                crate::accounts::start_guest_claim(ctx, secret.clone())
            }),
            Ok(()),
            "the guest starts a claim"
        );
        assert_eq!(w.player.remove(g), 1, "the guest leaves");
        w.account
            .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));
        assert_eq!(
            signed_in(&fx, c, T0 + 2, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Ok(()),
            "the account completes the claim"
        );
        let account_holds_d = || {
            encs(&[PlayerHandle {
                owner_identity: c,
                discriminator: d,
            }])
        };
        assert!(
            handles_of(&w, g).is_empty(),
            "the claim leaves the retired guest identity no handle row"
        );
        assert_eq!(
            encs(&handles_of(&w, c)),
            account_holds_d(),
            "the account holds the guest's discriminator"
        );

        assert_eq!(
            sr11_join(&fx, g, T0 + 3),
            Ok(()),
            "the retired guest joins again"
        );
        let fresh = minted(&w, g);
        assert_ne!(fresh, 0, "the retired guest is minted a non-zero value");
        assert_ne!(
            fresh, d,
            "the retired guest is minted a value other than the one the account now holds"
        );
        assert_eq!(
            player_of(&w, g).discriminator,
            fresh,
            "the retired guest's new player row mirrors its new handle"
        );
        assert_eq!(
            encs(&handles_of(&w, c)),
            account_holds_d(),
            "the account still holds exactly the guest's original discriminator"
        );
    }

    /// An account identity that holds a `player_handle` row and nothing else (a
    /// seeded fixture: a real join mints the handle and grants the starter
    /// together) tries to complete a live claim on a guest that has game data and
    /// its own handle. The claim is refused with `already has game data`, and
    /// nothing moves: the guest's rows, both handle rows and the claim are
    /// byte-identical, and the account gains nothing.
    ///
    /// kills: `has_handle` missing from `account_has_game_data` (the claim is
    /// not refused, it reaches the handle re-key, whose insert collides on the
    /// account's own handle row and panics); a game-data predicate that ignores its argument (paired with the round trip,
    /// where the GUEST's handle must not block the claim).
    #[test]
    fn an_account_holding_only_a_handle_cannot_claim_a_guest_ih1_6() {
        let fx = fixture();
        let w = world(&fx);
        let (g, c) = (id(0x8A), id(0x8B));
        let secret = code('5');
        let claim = seed_live_claim(&w, g, &secret, 1);
        seed_rekey_rows(&w, g, 1);
        w.account
            .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));
        let account_handle = PlayerHandle {
            owner_identity: c,
            discriminator: 9_000_001,
        };
        w.handle.seed(&account_handle);
        assert_eq!(
            owned_tables(&owned_by(&w, c)),
            vec!["account", "player_handle"],
            "fixture: the account holds a handle and no other game data"
        );
        let guest_before = owned_by(&w, g);
        let handles_before = encs(&w.handle.rows());

        assert_eq!(
            signed_in(&fx, c, T0 + 10, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Err("already has game data".to_string()),
            "an account holding a handle already has game data"
        );
        assert_eq!(owned_by(&w, g), guest_before, "no guest row moved");
        assert_eq!(
            encs(&w.handle.rows()),
            handles_before,
            "both handle rows are byte-identical"
        );
        assert_eq!(
            encs(&handles_of(&w, c)),
            encs(&[account_handle]),
            "the account keeps exactly its own handle"
        );
        assert_eq!(
            encs(&w.claim.rows()),
            encs(&[claim]),
            "the refusal consumed no claim"
        );
        assert_eq!(
            w.claim_reaper.rows().len(),
            1,
            "the refusal disarmed no reaper"
        );
        assert_eq!(
            owned_tables(&owned_by(&w, c)),
            vec!["account", "player_handle"],
            "the account gained nothing"
        );
    }

    /// A bystander joins through `join_game`, then an account joins (minted `d`,
    /// the latest mint) and stays connected, so its `player` row survives the
    /// cascade; that row is given a non-zero `lead_level` before the cascade.
    /// Deletion is requested and the real `account_deletion_reaper` runs at the
    /// grace end. The subject holds no handle row; its surviving `player` row has
    /// `discriminator` 0, `lead_level` 0 and the tombstone name, with `identity`
    /// and `entity_id` untouched; the bystander's handle and `player` row are
    /// byte-identical. A third identity's first join is then minted a value that
    /// is non-zero, not `d` and not the bystander's.
    ///
    /// kills: the handle erase not wired into the cascade; an erase that takes
    /// every handle row or keys on the wrong identity; the tombstone leaving
    /// either column set; a zeroing applied to every `player` row; a mint of
    /// `max + 1` or `count + 1` (with `d` the latest mint, both hand `d` out
    /// again).
    #[test]
    fn a_completed_deletion_erases_the_handle_zeroes_the_player_mirror_and_never_reissues_the_tag_ih1_7(
    ) {
        let fx = fixture();
        let w = eo1_world(&fx);
        let (b, v, n) = (id(0x8C), id(0x8D), id(0x8E));
        w.account
            .seed(&crate::accounts::new_account_row(v, "iss".to_string(), 1));
        assert_eq!(sr11_join(&fx, b, T0), Ok(()), "the bystander joins");
        assert_eq!(sr11_join(&fx, v, T0 + 1), Ok(()), "the account joins");
        let (db, d) = (minted(&w, b), minted(&w, v));
        assert!(
            db != 0 && d != 0 && db != d,
            "two joins mint two distinct non-zero values, got {db} and {d}"
        );
        let joined = player_of(&w, v);
        assert_eq!(
            joined.discriminator, d,
            "the account's player row mirrors its handle"
        );
        let entity = joined.entity_id;
        assert_eq!(w.player.remove(v), 1);
        w.player.seed(&Player {
            lead_level: 7,
            ..joined
        });
        let bystander = |w: &W<'_>| (encs(&handles_of(w, b)), enc(&player_of(w, b)));
        let bystander_before = bystander(&w);

        let grace_end = deletion_completed_for(&fx, v, T0 + 10);
        assert!(
            handles_of(&w, v).is_empty(),
            "the cascade erases the subject's handle row"
        );
        let p = player_of(&w, v);
        assert_eq!(
            (p.discriminator, p.lead_level),
            (0, 0),
            "the surviving player row carries neither the tag nor the lead level"
        );
        assert_eq!(
            p.name,
            game_core::TOMBSTONE_DISPLAY_NAME,
            "the surviving player row is tombstoned"
        );
        assert_eq!(
            (p.identity, p.entity_id),
            (v, entity),
            "the tombstone keeps the row's identity and entity id"
        );
        assert_eq!(
            bystander(&w),
            bystander_before,
            "the bystander's handle and player row are byte-identical"
        );

        assert_eq!(
            sr11_join(&fx, n, grace_end + 1),
            Ok(()),
            "a third identity's first join"
        );
        let dn = minted(&w, n);
        assert!(
            dn != 0 && dn != d && dn != db,
            "a later mint is non-zero and is neither the erased value {d} nor the bystander's \
             {db}, got {dn}"
        );
        assert_eq!(
            player_of(&w, n).discriminator,
            dn,
            "the third identity's player row mirrors its handle"
        );
    }

    /// Two accounts request deletion: one that has never joined, and one that
    /// joined (minted `d`, its `player` row present). Each one's `join_game` is
    /// refused with the deletion refusal and makes zero writes to
    /// `player_handle`; the never-joined identity holds no handle, and the joined
    /// one's `player` row and handle are byte-identical (still `d`). Control on
    /// the same fixture: a non-deleting identity's first join makes exactly one
    /// `player_handle` write, so the counter is live.
    ///
    /// kills: the mint placed ahead of the deletion gate (the never-joined
    /// identity would be minted a handle by a refused join); a refused join that
    /// rewrites the `player` row's discriminator.
    #[test]
    fn a_join_during_pending_deletion_is_refused_and_mints_no_handle_ih1_9() {
        let fx = fixture();
        let w = eo1_world(&fx);
        let (j, n, k) = (id(0x8F), id(0x90), id(0x91));
        for who in [j, n] {
            w.account
                .seed(&crate::accounts::new_account_row(who, "iss".to_string(), 1));
        }
        assert_eq!(sr11_join(&fx, j, T0), Ok(()), "the connected account joins");
        let d = minted(&w, j);
        let joined = enc(&player_of(&w, j));
        for who in [j, n] {
            assert_eq!(
                signed_in(&fx, who, T0 + 10, crate::accounts::delete_account),
                Ok(()),
                "deletion requested"
            );
        }
        let refused: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

        fx.reset_writes();
        assert_eq!(
            sr11_join(&fx, n, T0 + 11),
            refused,
            "a never-joined account pending deletion cannot join"
        );
        assert_eq!(
            fx.writes_to("player_handle"),
            0,
            "the refused join mints nothing"
        );
        assert!(
            handles_of(&w, n).is_empty(),
            "the never-joined account holds no handle"
        );

        fx.reset_writes();
        assert_eq!(
            sr11_join(&fx, j, T0 + 12),
            refused,
            "a joined account pending deletion cannot join again"
        );
        assert_eq!(
            fx.writes_to("player_handle"),
            0,
            "the refused join writes no handle"
        );
        assert_eq!(
            enc(&player_of(&w, j)),
            joined,
            "the player row is byte-identical, its discriminator still the minted value"
        );
        assert_eq!(
            encs(&handles_of(&w, j)),
            encs(&[PlayerHandle {
                owner_identity: j,
                discriminator: d,
            }]),
            "the joined account's handle is unchanged"
        );

        fx.reset_writes();
        assert_eq!(
            sr11_join(&fx, k, T0 + 13),
            Ok(()),
            "control: a non-deleting identity joins"
        );
        assert_eq!(
            fx.writes_to("player_handle"),
            1,
            "control: a first join writes exactly one handle row"
        );
        assert_ne!(minted(&w, k), d, "control: a fresh value");
    }

    /// An account joins (its handle minted), requests deletion, and the real
    /// cascade completes at the grace end, leaving its `player` row tombstoned
    /// with `discriminator` 0. Its next `join_game` is refused with the deletion
    /// refusal, makes zero writes to `player_handle`, leaves it holding no handle,
    /// and leaves the surviving `player` row byte-identical to what the cascade
    /// left. Control on the same fixture: a non-deleting identity's first join
    /// makes exactly one `player_handle` write.
    ///
    /// kills: the mint placed ahead of the deletion gate (the erased identity
    /// would be handed a fresh tag by a refused join); a refused join that
    /// rewrites the surviving row's discriminator.
    #[test]
    fn a_join_after_completed_deletion_is_refused_and_mints_no_handle_ih1_9() {
        let fx = fixture();
        let w = eo1_world(&fx);
        let (v, k) = (id(0x92), id(0x93));
        w.account
            .seed(&crate::accounts::new_account_row(v, "iss".to_string(), 1));
        assert_eq!(sr11_join(&fx, v, T0), Ok(()), "the account joins");
        assert_ne!(minted(&w, v), 0, "fixture: the join minted the handle");
        let grace_end = deletion_completed_for(&fx, v, T0 + 10);
        assert!(
            handles_of(&w, v).is_empty(),
            "fixture: the cascade erased the handle"
        );
        let left = player_of(&w, v);
        assert_eq!(
            left.discriminator, 0,
            "fixture: the cascade left the mirror at 0"
        );
        let left = enc(&left);

        fx.reset_writes();
        assert_eq!(
            sr11_join(&fx, v, grace_end + 1),
            Err(crate::guards::REJECT_DELETION_GATED.to_string()),
            "the erased account's join is refused"
        );
        assert_eq!(
            fx.writes_to("player_handle"),
            0,
            "the refused join mints nothing"
        );
        assert!(
            handles_of(&w, v).is_empty(),
            "the erased account still holds no handle"
        );
        assert_eq!(
            enc(&player_of(&w, v)),
            left,
            "the surviving player row is what the cascade left"
        );

        fx.reset_writes();
        assert_eq!(
            sr11_join(&fx, k, grace_end + 2),
            Ok(()),
            "control: a non-deleting identity joins"
        );
        assert_eq!(
            fx.writes_to("player_handle"),
            1,
            "control: a first join writes exactly one handle row"
        );
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
    /// bt-7: plus `who`'s tactical population (`seed_tactical_population`:
    /// both battle roles against `peer`, a wild and a practice battle, every
    /// tactical table, the formation).
    fn seed_cascade_population(w: &W<'_>, who: Identity, peer: Identity, k: u64) {
        seed_rekey_rows(w, who, k);
        seed_tactical_population(w, who, peer, k);
        w.player
            .seed(&player_row(who, 600 + k, &format!("name{k}")));
        w.character.seed(&character_row(600 + k));
        w.intent.seed(&intent_row(600 + k));
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
    /// byte-identical throughout. bt-7: the population includes the subject's
    /// tactical battles, so the subject may name no tactical row afterwards
    /// (its summaries survive tombstoned, so they no longer name it either),
    /// while the bystander's tactical rows outside those battles are untouched;
    /// the exact per-table proof is
    /// `deletion_cascade_erases_tactical_rows_by_battle_and_tombstones_summaries_bt7_4`.
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
        // Both identities hold a world admission and a wrong-password record.
        for (who, k) in [(v, 1i64), (b, 2)] {
            w.admission.seed(&WorldAdmission {
                identity: who,
                admitted_at_ms: T0 - 100 + k,
            });
            w.admission_attempt.seed(&WorldAdmissionAttempt {
                identity: who,
                wrong_at_ms: vec![T0 - 50 + k, T0 - 40 + k],
                last_wrong_at_ms: T0 - 40 + k,
            });
        }
        // Both identities hold a world binding and an outstanding bind nonce.
        for (who, k) in [(v, 1i64), (b, 2)] {
            w.binding.seed(&WorldBinding {
                identity: who,
                account_subject: format!("dev:cascade-{k}"),
                bound_at_ms: T0 - 30 + k,
                entitled: true,
                key_id: format!("kid-{k}"),
            });
            w.bind_nonce.seed(&WorldBindNonce {
                identity: who,
                nonce: format!("{k:032x}"),
                expires_at_ms: T0 + 300_000 + k,
            });
        }
        let binding_of = |w: &W<'_>, who: Identity| -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
            (
                encs(
                    &w.binding
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
                encs(
                    &w.bind_nonce
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
            )
        };
        let victim_binding_before = binding_of(&w, v);
        let bystander_binding_before = binding_of(&w, b);
        let admission_of = |w: &W<'_>, who: Identity| -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
            (
                encs(
                    &w.admission
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
                encs(
                    &w.admission_attempt
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
            )
        };
        let victim_admission_before = admission_of(&w, v);
        let bystander_admission_before = admission_of(&w, b);
        let victim_before = owned_by(&w, v);
        // bt-7: every per-battle row of a battle the subject is a side of goes
        // (the bystander's own units / staging / clock in a SHARED battle
        // included), and the shared battles' summaries are tombstoned on the
        // subject's side; the bystander keeps, byte-identical, everything in
        // the battles WITHOUT the subject.
        let subject_battles: Vec<u64> = w
            .battle
            .rows()
            .into_iter()
            .filter(|r| r.player_identity == v || r.opponent_identity == v)
            .map(|r| r.battle_id)
            .collect();
        assert_eq!(
            subject_battles.len(),
            4,
            "fixture: the subject is a side of four tactical battles (both roles, wild, practice)"
        );
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
                        "battle_unit" => encs(
                            &w.unit
                                .rows()
                                .into_iter()
                                .filter(|r| {
                                    r.owner == Some(b) && !subject_battles.contains(&r.battle_id)
                                })
                                .collect::<Vec<_>>(),
                        ),
                        "battle_queue" => encs(
                            &w.queue
                                .rows()
                                .into_iter()
                                .filter(|r| r.owner == b && !subject_battles.contains(&r.battle_id))
                                .collect::<Vec<_>>(),
                        ),
                        "battle_deploy" => encs(
                            &w.deploy
                                .rows()
                                .into_iter()
                                .filter(|r| r.owner == b && !subject_battles.contains(&r.battle_id))
                                .collect::<Vec<_>>(),
                        ),
                        "battle_clock" => encs(
                            &w.clock
                                .rows()
                                .into_iter()
                                .filter(|r| {
                                    r.player == b && !subject_battles.contains(&r.battle_id)
                                })
                                .collect::<Vec<_>>(),
                        ),
                        "battle_summary" => encs(
                            &w.summary
                                .rows()
                                .into_iter()
                                .filter(|r| {
                                    (r.player_identity == b || r.opponent_identity == b)
                                        && !subject_battles.contains(&r.battle_id)
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
        assert_eq!(
            admission_of(&w, v),
            victim_admission_before,
            "an early tick keeps the subject's world admission and attempt rows"
        );
        assert_eq!(
            binding_of(&w, v),
            victim_binding_before,
            "an early tick keeps the subject's world binding and bind nonce"
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
        assert_eq!(
            intent_ids(&w),
            vec![602],
            "the move_intent row reachable through the same join is erased, the bystander's kept"
        );
        assert!(w.trade_reaper.rows().iter().all(|r| r.trade_id != 901));
        assert!(w
            .challenge_reaper
            .rows()
            .iter()
            .all(|r| r.challenge_id != 1001));
        assert!(del_reapers_of(&w, v).is_empty(), "the cascade arms nothing");
        assert_eq!(
            admission_of(&w, v),
            (Vec::new(), Vec::new()),
            "the cascade erases the subject's world admission and its wrong-password record"
        );
        assert_eq!(
            admission_of(&w, b),
            bystander_admission_before,
            "the bystander's world admission and wrong-password record are untouched"
        );
        assert_eq!(
            w.admission.rows().len() + w.admission_attempt.rows().len(),
            2,
            "only the bystander's two access rows remain"
        );
        assert_eq!(
            binding_of(&w, v),
            (Vec::new(), Vec::new()),
            "the cascade erases the subject's world binding and its bind nonce"
        );
        assert_eq!(
            binding_of(&w, b),
            bystander_binding_before,
            "the bystander's world binding and bind nonce are untouched"
        );
        assert_eq!(
            w.binding.rows().len() + w.bind_nonce.rows().len(),
            2,
            "only the bystander's binding and nonce remain"
        );

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

    /// Every exportable table's chunk carries EXACTLY the caller's rows: one
    /// seeded own row per single-owner table (`player_formation` among them,
    /// with a second owner's formation beside it), and for the four dual-column
    /// tables (trade_offer, battle_challenge, battle, battle_summary) the row
    /// the caller initiated, the row naming the caller only in the second
    /// column, and the caller's self-row — each exactly once — while a row
    /// between two strangers never appears. Rows are counted by their
    /// row-opening key, so an empty, blank or placeholder exporter and a doubled
    /// or dropped row all fail. (The admission/stamp contract is the
    /// acct_export_* tests above; this is the `rows_*` projection and
    /// owner-filter surface.)
    ///
    /// kills: any `rows_*` exporter replaced by an empty / blank / placeholder
    /// row list; the trailing dedup filter in rows_trade_offer,
    /// rows_battle_challenge, rows_battle or rows_battle_summary inverted (drops
    /// the second-column row and doubles the self-row); a rows_player_formation
    /// that returns the other owner's formation. The world binding is seeded for
    /// the caller and for a stranger and stays out of the export: no
    /// `world_binding` chunk, and no chunk carries either account subject or
    /// either key id — so an exporter added for the binding, or a binding column
    /// copied into another table's rows, fails.
    #[test]
    fn acct_export_chunks_carry_exactly_the_callers_rows_per_table() {
        let fx = fixture();
        let w = world(&fx);
        let (a, b, c) = (id(0xC1), id(0xC2), id(0xC3));
        for (who, k) in [(a, 1u64), (b, 2)] {
            seed_rekey_rows(&w, who, k);
            w.player.seed(&player_row(who, 1400 + k, "p"));
            w.character.seed(&character_row(1400 + k));
            w.account
                .seed(&crate::accounts::new_account_row(who, format!("iss{k}"), 1));
            w.conversation.seed(&PlayerConversation {
                owner_identity: who,
                npc_entity_id: 60 + k,
                current_node_id: format!("n{k}"),
            });
            w.playtest.seed(&PlaytestEvent {
                event_id: 700 + k,
                identity: who,
                kind: 1,
                created_at_ms: 1,
                battle_id: 0,
                species_id: 1,
                hp_permille: 1,
                bait_item_id: 0,
                success: false,
            });
            w.formation.seed(&formation_row(who, k));
            w.binding.seed(&WorldBinding {
                identity: who,
                account_subject: format!("dev:export-subject-{k}"),
                bound_at_ms: 1_800_000_000_000 + k as i64,
                entitled: k == 1,
                key_id: format!("export-kid-{k}"),
            });
            w.world_account.seed(&crate::account_checks::WorldAccount {
                handle: format!("k1.export-handle-{k}"),
                identity: who,
                entitled: k == 1,
                checked_at_ms: 1_800_000_000_000 + k as i64,
                is_host: false,
            });
            w.world_move.seed(&crate::account_checks::WorldMove {
                identity: who,
                moved_at_ms: 1_800_000_100_000 + k as i64,
            });
        }
        // Dual-column tables: a->b, b->a, a->a, b->c.
        for (n, x, y) in [(1u64, a, b), (2, b, a), (3, a, a), (4, b, c)] {
            w.trade.seed(&trade_row(7300 + n, x, y));
            w.challenge
                .seed(&challenge_row(7500 + n, x, y, ChallengeStatus::Pending));
            let mut bt = battle_row(x, y);
            bt.battle_id = 7700 + n;
            w.battle.seed(&bt);
            let kind = if x == y {
                BattleKind::Practice
            } else {
                BattleKind::Pvp
            };
            w.summary.seed(&summary_row(7900 + n, x, y, kind));
        }
        assert_eq!(export_as(&fx, a, T0), Ok(()));

        let chunks = chunks_of(&w, a);
        let payload = |table: &str| -> String {
            let got: Vec<&ExportBundle> = chunks.iter().filter(|c| c.table_name == table).collect();
            assert_eq!(got.len(), 1, "one `{table}` chunk");
            got[0].payload_json.clone()
        };
        let q = |s: String| format!("\"{s}\"");
        let me = q(a.to_string());
        // (table, row-opening key, the values the caller's rows open with).
        let cases: Vec<(&str, &str, Vec<String>)> = vec![
            ("monster", "monster_id", vec![q("101".into())]),
            ("monster_pub", "monster_id", vec![q("101".into())]),
            ("inventory", "inv_id", vec![q("201".into())]),
            ("player_quest", "pq_id", vec![q("301".into())]),
            ("player_dialogue_state", "owner_identity", vec![me.clone()]),
            ("player_conversation", "owner_identity", vec![me.clone()]),
            ("heal_cooldown", "owner_identity", vec![me.clone()]),
            ("player_wallet", "owner_identity", vec![me.clone()]),
            ("playtest_event", "event_id", vec![q("701".into())]),
            (
                "trade_offer",
                "trade_id",
                vec![q("7301".into()), q("7302".into()), q("7303".into())],
            ),
            (
                "battle_challenge",
                "challenge_id",
                vec![q("7501".into()), q("7502".into()), q("7503".into())],
            ),
            ("player_formation", "owner_identity", vec![me.clone()]),
            ("player", "identity", vec![me.clone()]),
            ("profile", "identity", vec![me.clone()]),
            ("account", "identity", vec![me.clone()]),
            (
                "battle",
                "battle_id",
                vec![q("7701".into()), q("7702".into()), q("7703".into())],
            ),
            (
                "battle_summary",
                "battle_id",
                vec![q("7901".into()), q("7902".into()), q("7903".into())],
            ),
            ("character", "entity_id", vec![q("1401".into())]),
            ("player_handle", "owner_identity", vec![me.clone()]),
            (
                "world_account",
                "handle",
                vec![q("k1.export-handle-1".into())],
            ),
            ("world_move", "identity", vec![me.clone()]),
        ];
        for (table, key, want) in &cases {
            let p = payload(table);
            let opener = format!("{{\"{key}\":");
            assert_eq!(
                p.matches(&opener).count(),
                want.len(),
                "`{table}` carries exactly the caller's {} row(s): {p}",
                want.len()
            );
            for v in want {
                assert_eq!(
                    p.matches(&format!("{opener}{v}")).count(),
                    1,
                    "`{table}` carries the caller's row {v} exactly once: {p}"
                );
            }
        }
        let handle = payload("player_handle");
        assert_eq!(
            (
                handle.matches("\"discriminator\":9100001").count(),
                handle.matches("9100002").count()
            ),
            (1, 0),
            "the `player_handle` chunk carries the caller's discriminator and never the \
             stranger's: {handle}"
        );
        let mut seeded: Vec<(String, String)> = w
            .binding
            .rows()
            .into_iter()
            .map(|r| (r.account_subject, r.key_id))
            .collect();
        seeded.sort_unstable();
        assert_eq!(
            seeded,
            [
                (
                    "dev:export-subject-1".to_string(),
                    "export-kid-1".to_string()
                ),
                (
                    "dev:export-subject-2".to_string(),
                    "export-kid-2".to_string()
                ),
            ],
            "both bindings are seeded, so their absence from the export is not vacuous"
        );
        assert_eq!(
            chunks
                .iter()
                .filter(|c| c.table_name == "world_binding")
                .count(),
            0,
            "the export produces no `world_binding` chunk"
        );
        for needle in [
            "dev:export-subject-1",
            "dev:export-subject-2",
            "export-kid-1",
            "export-kid-2",
        ] {
            let carriers: Vec<&str> = chunks
                .iter()
                .filter(|c| c.payload_json.contains(needle))
                .map(|c| c.table_name.as_str())
                .collect();
            assert!(
                carriers.is_empty(),
                "no chunk carries the world binding value `{needle}`; found in {carriers:?}"
            );
        }
        let mut covered: Vec<&str> = cases.iter().map(|(t, _, _)| *t).collect();
        covered.sort_unstable();
        assert_eq!(
            covered,
            exportable_tables(),
            "every exportable table is checked here"
        );
    }

    /// The shared disconnect/cascade dispatcher actually resolves: the
    /// subject's live trade (as counterparty) is cancelled and its outgoing
    /// pending challenge withdrawn, while a trade and a challenge between two
    /// strangers are untouched. (The deletion cascade later erases these same
    /// rows by owner, which is why the cascade test cannot see the dispatcher.)
    ///
    /// kills: resolve_all_live_interactions replaced by a no-op.
    #[test]
    fn acct_resolve_all_live_interactions_cancels_trades_and_challenges() {
        let fx = fixture();
        let w = world(&fx);
        let (a, b, c) = (id(0xE1), id(0xE2), id(0xE3));
        w.trade.seed(&trade_row(1, b, a));
        w.trade.seed(&trade_row(2, b, c));
        w.challenge
            .seed(&challenge_row(3, a, b, ChallengeStatus::Pending));
        w.challenge
            .seed(&challenge_row(4, b, c, ChallengeStatus::Pending));
        crate::resolve_all_live_interactions(&fx.ctx(), a);
        let trades: Vec<u64> = w.trade.rows().iter().map(|t| t.trade_id).collect();
        assert_eq!(trades, vec![2], "a's trade cancelled, the strangers' kept");
        let challenges: Vec<u64> = w.challenge.rows().iter().map(|c| c.challenge_id).collect();
        assert_eq!(
            challenges,
            vec![4],
            "a's challenge withdrawn, the strangers' kept"
        );
    }

    /// The three owner-scoped read views, run through the runtime's view entry
    /// point: `my_monster_pub` returns exactly the caller's projections,
    /// `my_battle` returns every battle the caller is in exactly once (the
    /// self-battle included, a strangers' battle excluded), and
    /// `my_pending_evolution_notices` returns the caller's notice or nothing.
    ///
    /// kills: each view replaced by an empty result; my_battle's trailing
    /// dedup filter inverted.
    #[test]
    fn acct_owner_scoped_views_return_exactly_the_callers_rows() {
        use crate::native_host_tests::{
            VIEW_MY_BATTLE, VIEW_MY_MONSTER_PUB, VIEW_MY_PENDING_EVOLUTION_NOTICES,
        };
        let fx = fixture();
        let w = world(&fx);
        let _ = fx.table::<MonsterPub>("monster_pub", "owner_identity", |r| r.owner_identity);
        let (a, b, c) = (id(0xD1), id(0xD2), id(0xD3));
        seed_rekey_rows(&w, a, 1);
        seed_rekey_rows(&w, b, 2);
        let extra = crate::marshal::pub_from_monster(&monster_row(111, a), 0);
        w.monster_pub.seed(&extra);
        let mut battles = Vec::new();
        for (n, x, y) in [(1u64, a, b), (2, b, a), (3, a, a), (4, b, c)] {
            let mut bt = battle_row(x, y);
            bt.battle_id = 7700 + n;
            w.battle.seed(&bt);
            battles.push(bt);
        }

        let pubs_of = |who: Identity| -> Vec<Vec<u8>> {
            encs(
                &w.monster_pub
                    .rows()
                    .into_iter()
                    .filter(|p| p.owner_identity == who)
                    .collect::<Vec<_>>(),
            )
        };
        let seen_pubs = |who: Identity| encs(&fx.call_view::<MonsterPub>(VIEW_MY_MONSTER_PUB, who));
        assert_eq!(pubs_of(a).len(), 2);
        assert_eq!(seen_pubs(a), pubs_of(a));
        assert_eq!(seen_pubs(b), pubs_of(b));
        assert!(seen_pubs(c).is_empty(), "a stranger sees no projections");

        let seen_battles =
            |who: Identity| encs(&fx.call_view::<crate::schema::Battle>(VIEW_MY_BATTLE, who));
        assert_eq!(
            seen_battles(a),
            encs(&battles[..3]),
            "a's battles: initiated, second-column and self — each exactly once"
        );
        assert_eq!(seen_battles(c), encs(&battles[3..]));

        let notices = |who: Identity| {
            encs(&fx.call_view::<PendingEvolutionNotice>(VIEW_MY_PENDING_EVOLUTION_NOTICES, who))
        };
        let own = |who: Identity| {
            encs(
                &w.notice
                    .rows()
                    .into_iter()
                    .filter(|n| n.owner_identity == who)
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(own(a).len(), 1);
        assert_eq!(notices(a), own(a));
        assert_eq!(notices(b), own(b));
        assert!(notices(c).is_empty(), "no notice row, no result");
    }

    /// `my_export_bundle` returns exactly the caller's export chunks (the
    /// client's only read path to its own bundle), never another subject's.
    ///
    /// kills: the view replaced by an empty result.
    #[test]
    fn acct_my_export_bundle_view_returns_only_the_callers_chunks() {
        use crate::native_host_tests::VIEW_MY_EXPORT_BUNDLE;
        let fx = fixture();
        let w = world(&fx);
        let (a, b, c) = (id(0xF1), id(0xF2), id(0xF3));
        w.export.seed(&export_row(1, a, 10));
        w.export.seed(&export_row(2, a, 10));
        w.export.seed(&export_row(3, b, 11));
        let chunks_of = |who: Identity| {
            encs(
                &w.export
                    .rows()
                    .into_iter()
                    .filter(|r| r.owner_identity == who)
                    .collect::<Vec<_>>(),
            )
        };
        let seen = |who: Identity| encs(&fx.call_view::<ExportBundle>(VIEW_MY_EXPORT_BUNDLE, who));
        assert_eq!(chunks_of(a).len(), 2);
        assert_eq!(seen(a), chunks_of(a));
        assert_eq!(seen(b), chunks_of(b));
        assert!(seen(c).is_empty(), "no bundle, no chunks");
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

    /// Every export reaper schedule row as (id, one-shot fire ms; `None` = an
    /// interval row), by id.
    fn export_wakes(w: &W<'_>) -> Vec<(u64, Option<i64>)> {
        let mut v: Vec<(u64, Option<i64>)> = w
            .export_reaper
            .rows()
            .iter()
            .map(|s| (s.id, crate::playtest::one_shot_ms(&s.scheduled_at)))
            .collect();
        v.sort_unstable();
        v
    }

    fn export_tick(fx: &Fixture, sched: ExportBundleReaperSchedule, ms: i64) -> Result<(), String> {
        fx.run_as_at(scheduler(), at(ms), |ctx| {
            crate::privacy::export_bundle_reaper(ctx, sched)
        })
    }

    /// The export reaper runs only when something is owed. An empty table has no
    /// schedule row; the first export arms exactly one one-shot at that bundle's
    /// expiry and a later export leaves it alone; the run at that instant reaps
    /// the expired bundle and arms a NEW row at the oldest remaining bundle's
    /// expiry (never counting the row it was fired with, which the runtime
    /// deletes); the run that empties the table arms nothing.
    ///
    /// kills: the arm dropped from the export or from the reaper, a row per
    /// export, an interval row, a run armed at the newest bundle's expiry or at
    /// a fixed delay, the fired row taken for the next run, a row left for an
    /// empty table.
    #[test]
    fn acct_export_reaper_is_armed_on_demand_at_the_oldest_expiry() {
        let fx = fixture();
        let w = world(&fx);
        let a = id(0xC3);
        let b = id(0xC4);
        seed_export_subject(&w, a, 1, "TAG-A");
        seed_export_subject(&w, b, 2, "TAG-B");
        let ttl = crate::privacy::EXPORT_BUNDLE_TTL_MS;
        assert_eq!(ttl, 604_800_000, "seven days");
        assert_eq!(
            export_wakes(&w),
            vec![],
            "an empty table has no schedule row"
        );

        assert_eq!(export_as(&fx, a, T0), Ok(()));
        let armed = export_wakes(&w);
        assert_eq!(armed.len(), 1, "exactly one schedule row: {armed:?}");
        assert_eq!(armed[0].1, Some(T0 + ttl), "at the bundle's expiry");
        fx.reset_writes();
        assert_eq!(export_as(&fx, b, T0 + 5_000), Ok(()));
        assert_eq!(export_wakes(&w), armed, "a later export keeps the row");
        assert_eq!(fx.writes_to("export_bundle_reaper_schedule"), 0);

        let firing = w.export_reaper.rows().remove(0);
        let fired_id = firing.id;
        assert_eq!(export_tick(&fx, firing, T0 + ttl), Ok(()));
        assert!(chunks_of(&w, a).is_empty(), "the expired bundle is reaped");
        assert!(!chunks_of(&w, b).is_empty());
        let after = export_wakes(&w);
        assert_eq!(after.len(), 2, "the fired row and one new row: {after:?}");
        let next: Vec<(u64, Option<i64>)> = after.into_iter().filter(|r| r.0 != fired_id).collect();
        assert_eq!(next.len(), 1, "exactly one re-arm: {next:?}");
        assert_eq!(
            next[0].1,
            Some(T0 + ttl + 3_600_000),
            "the next bundle expires 5 s later: one interval from the tick, not 5 s"
        );

        // The runtime removes the fired row; the next run is the row armed above.
        assert_eq!(w.export_reaper.remove(fired_id), 1);
        let firing = w.export_reaper.rows().remove(0);
        assert_eq!(export_tick(&fx, firing, T0 + ttl + 3_600_000), Ok(()));
        assert!(w.export.rows().is_empty());
        assert_eq!(
            export_wakes(&w),
            next,
            "an empty table is left no row but the one that fired"
        );
    }

    /// Bundles that expire 1 ms apart are one tick per interval, not one tick
    /// (and one `export_bundle_reap` line) per bundle: the tick at the first
    /// expiry arms exactly one next tick an hour out. A bundle expiring further
    /// out than an hour is armed at its own expiry, and so is every arm that is
    /// not the reaper's (`ensure_export_bundle_reaper` here), whatever the gap.
    ///
    /// kills: the reaper re-arming at the exact next expiry, the floor applied
    /// to the arms that are not the reaper's, the floor replacing a later
    /// expiry.
    #[test]
    fn acct_export_bundles_expiring_1ms_apart_rearm_once_an_hour_out() {
        let fx = fixture();
        let w = world(&fx);
        let ttl = crate::privacy::EXPORT_BUNDLE_TTL_MS;
        let hour = 3_600_000;
        let now = T0 + ttl;
        w.export.seed(&export_row(9001, id(0xC8), T0));
        w.export.seed(&export_row(9002, id(0xC8), T0 + 1));
        w.export.seed(&export_row(9003, id(0xC8), T0 + 2));
        w.export.seed(&export_row(9004, id(0xC8), T0 + 2 * hour));
        let fired = ExportBundleReaperSchedule {
            id: 50,
            scheduled_at: ScheduleAt::Time(at(now)),
        };
        w.export_reaper.seed(&fired);
        assert_eq!(export_tick(&fx, fired, now), Ok(()));
        assert_eq!(w.export.rows().len(), 3, "only the expired bundle went");
        let next: Vec<(u64, Option<i64>)> =
            export_wakes(&w).into_iter().filter(|r| r.0 != 50).collect();
        assert_eq!(next.len(), 1, "exactly one re-arm: {next:?}");
        assert_eq!(
            next[0].1,
            Some(now + hour),
            "an hour from the tick, not 1 ms"
        );

        assert_eq!(w.export_reaper.remove(50), 1);
        let firing = w.export_reaper.rows().remove(0);
        let fired_id = firing.id;
        assert_eq!(export_tick(&fx, firing, now + hour), Ok(()));
        assert_eq!(w.export.rows().len(), 1, "one tick reaped both");
        let next: Vec<(u64, Option<i64>)> = export_wakes(&w)
            .into_iter()
            .filter(|r| r.0 != fired_id)
            .collect();
        assert_eq!(next.len(), 1);
        assert_eq!(
            next[0].1,
            Some(now + 2 * hour),
            "further out than an hour: at the bundle's own expiry"
        );

        // An arm that is not the reaper's has no floor: with no row armed and a
        // bundle expiring in 1 ms, it arms at that expiry.
        for s in w.export_reaper.rows() {
            w.export_reaper.remove(s.id);
        }
        fx.run_as_at(scheduler(), at(now + 2 * hour - 1), |ctx| {
            crate::privacy::ensure_export_bundle_reaper(ctx)
        });
        let armed = export_wakes(&w);
        assert_eq!(armed.len(), 1);
        assert_eq!(armed[0].1, Some(now + 2 * hour), "at the expiry itself");
    }

    /// A tick that leaves expired bundles behind (its stamp cap bound) runs again
    /// one backlog interval later — an hour — never at once and never at the TTL.
    /// A tick fired by an interval row left by an earlier version of the module
    /// removes that row, so the world converges without a publish step.
    ///
    /// kills: a backlog re-armed at once or left to the next expiry, an interval
    /// row kept (the reaper would run hourly for ever) or kept beside the
    /// one-shot.
    #[test]
    fn acct_export_reaper_backlog_reruns_in_an_hour_and_a_legacy_interval_row_goes() {
        let fx = fixture();
        let w = world(&fx);
        let ttl = crate::privacy::EXPORT_BUNDLE_TTL_MS;
        let hourly = || ExportBundleReaperSchedule {
            id: 77,
            scheduled_at: ScheduleAt::Interval(std::time::Duration::from_secs(3600).into()),
        };
        w.export_reaper.seed(&hourly());
        assert_eq!(export_tick(&fx, hourly(), T0), Ok(()));
        assert_eq!(
            export_wakes(&w),
            vec![],
            "empty table: the interval row goes"
        );

        let stamps = crate::privacy::EXPORT_REAP_MAX_STAMPS_PER_TICK as i64;
        for k in 0..stamps + 1 {
            w.export
                .seed(&export_row(9000 + k as u64, id(0xC5), T0 - ttl - 100 + k));
        }
        w.export.seed(&export_row(9999, id(0xC5), T0 - 1));
        w.export_reaper.seed(&hourly());
        assert_eq!(export_tick(&fx, hourly(), T0), Ok(()));
        assert_eq!(w.export.rows().len(), 2, "one stamp cap's worth went");
        let after = export_wakes(&w);
        assert_eq!(after.len(), 1, "the interval row is replaced: {after:?}");
        assert_eq!(after[0].1, Some(T0 + 3_600_000), "an hour from the tick");
    }

    /// A purge that removes the last bundle removes the schedule row with it; a
    /// purge that leaves another identity's bundle leaves the row.
    ///
    /// kills: the disarm dropped from the purge, a purge that disarms while
    /// bundles remain.
    #[test]
    fn acct_purge_that_empties_the_export_table_removes_the_schedule_row() {
        let fx = fixture();
        let w = world(&fx);
        let a = id(0xC6);
        let b = id(0xC7);
        seed_export_subject(&w, a, 1, "TAG-A");
        seed_export_subject(&w, b, 2, "TAG-B");
        assert_eq!(export_as(&fx, a, T0), Ok(()));
        assert_eq!(export_as(&fx, b, T0 + 9), Ok(()));
        let armed = export_wakes(&w);
        assert_eq!(armed.len(), 1);
        let purge = |who: Identity| {
            fx.run_as_at(who, at(T0 + 20), |ctx| {
                crate::privacy::purge_export_bundles(ctx, who)
            })
        };
        assert!(purge(b) > 0);
        assert_eq!(export_wakes(&w), armed, "a bundle remains: the row stays");
        assert!(purge(a) > 0);
        assert!(w.export.rows().is_empty());
        assert_eq!(
            export_wakes(&w),
            vec![],
            "the table is empty: no schedule row"
        );
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

    // =======================================================================
    // bt-7 — THE TACTICAL TABLES, EXECUTED: the generated module definition
    // (BT7.1), the seven views through the runtime's own view entry point
    // (BT7.2 / BT7.3), the deletion cascade and the claim-flow re-key (BT7.4).
    // =======================================================================

    /// The column names of the row a view serves, read from its GENERATED
    /// return type: `Vec<T>` (an array) or `Option<T>` (the `some` arm of a
    /// sum), `T` resolved through the module typespace to its product type.
    fn bt7_view_row_columns(
        ts: &spacetimedb::sats::Typespace,
        ret: &spacetimedb::sats::AlgebraicType,
        view: &str,
    ) -> Vec<String> {
        use spacetimedb::sats::AlgebraicType;
        let resolve = |ty: &AlgebraicType| -> AlgebraicType {
            match ty {
                AlgebraicType::Ref(r) => ts[*r].clone(),
                other => other.clone(),
            }
        };
        let row = match resolve(ret) {
            AlgebraicType::Array(a) => {
                let elem: &AlgebraicType = &a.elem_ty;
                resolve(elem)
            }
            AlgebraicType::Sum(s) => {
                let Some(some) = s
                    .variants
                    .iter()
                    .find(|v| v.name.as_deref() == Some("some"))
                else {
                    panic!("[bt7/view-return-shape] `{view}` returns a sum with no `some` arm")
                };
                resolve(&some.algebraic_type)
            }
            other => panic!(
                "[bt7/view-return-shape] `{view}` returns {other:?}: neither Vec<T> nor Option<T>"
            ),
        };
        let AlgebraicType::Product(p) = row else {
            panic!("[bt7/view-return-shape] `{view}`'s row type is not a product")
        };
        p.elements
            .iter()
            .map(|e| e.name.as_deref().unwrap_or("").to_string())
            .collect()
    }

    /// BT7.1 / manifest totality — the GENERATED module definition's table set
    /// (every `#[spacetimedb::table]` the module describes to its host) equals
    /// the `DATA_LIFECYCLE_MANIFEST` table set EXACTLY, in both directions, and
    /// the ten bt-7 tables are in it. This is the manifest-totality gate, read
    /// from the artifact the host consumes rather than from source text.
    ///
    /// Kills: a table added to the schema (any slice, any module) with no
    ///        lifecycle classification — its rows would survive every account
    ///        deletion with every other gate green; a manifest entry naming a
    ///        table that no longer exists or is misspelt (a classification that
    ///        governs nothing); a duplicate manifest entry; one of the ten
    ///        tactical tables not declared as a table at all.
    #[test]
    fn generated_table_set_equals_the_lifecycle_manifest_bt7_1() {
        let fx = fixture();
        let def = fx.module_def();
        let tables = def.tables().unwrap_or_else(|| {
            panic!("[bt7/describe-tables] the generated module def carries no Tables section")
        });
        let mut generated: Vec<String> = tables.iter().map(|t| t.source_name.to_string()).collect();
        generated.sort();
        let mut manifest: Vec<&str> = DATA_LIFECYCLE_MANIFEST.iter().map(|e| e.table).collect();
        manifest.sort_unstable();

        let unclassified: Vec<&String> = generated
            .iter()
            .filter(|g| !manifest.contains(&g.as_str()))
            .collect();
        assert!(
            unclassified.is_empty(),
            "[bt7/manifest-totality-unclassified] the module declares {unclassified:?} with no \
             DATA_LIFECYCLE_MANIFEST entry. An unclassified table is invisible to the deletion \
             cascade, the export scope and every partition rule: classify it in schema.rs."
        );
        let stale: Vec<&&str> = manifest
            .iter()
            .filter(|m| !generated.iter().any(|g| g == **m))
            .collect();
        assert!(
            stale.is_empty(),
            "[bt7/manifest-totality-stale] DATA_LIFECYCLE_MANIFEST classifies {stale:?}, which the \
             module does not declare (removed, renamed or misspelt)."
        );
        assert_eq!(
            generated, manifest,
            "[bt7/manifest-totality-multiset] the generated table list and the manifest must be the \
             same multiset (a duplicate on either side is a classification that shadows another)"
        );
        assert_eq!(
            generated.len(),
            75,
            "[bt7/manifest-totality-census] 40 pre-bt-7 tables plus the ten tactical tables plus \
             bt-8's three schedule tables plus the three trade-session tables plus move_intent \
             plus last_position plus player_handle plus battle_summary_reaper_schedule plus \
             leaderboard_top plus module_info plus lpw-9's world_access, world_admission and \
             world_admission_attempt plus the four world binding tables (world_binding, \
             world_bind_nonce, world_name, world_allowlist) plus the three account-check tables \
             (world_account, world_check_budget, recheck_schedule) plus world_move plus the two \
             host-check tables (world_egress, the address the account service last saw the \
             world's requests leave from, per family; host_check_schedule, the tick of the host \
             account's own check and when it last succeeded)"
        );
        for table in [
            "battle_tactical",
            "battle_unit",
            "battle_queue",
            "battle_deploy",
            "battle_clock",
            "battle_secret",
            "battle_wild_unit",
            "battle_event",
            "battle_summary",
            "player_formation",
        ] {
            assert!(
                generated.iter().any(|g| g == table),
                "[bt7/manifest-totality-tactical] `{table}` is not a generated table"
            );
        }
    }

    /// BT7.1 — read from the GENERATED module definition: each of the ten
    /// tactical tables is PRIVATE, declares the plan's columns in order, and
    /// carries exactly the plan's primary key, auto-inc set, unique-constraint
    /// set and btree index set (`battle_tactical.map_id`; `battle_id` on the
    /// seven per-battle child tables; `owner` on queue + deploy; `player` on
    /// clock; both identity columns on the summary; the PK index of each) — and
    /// NO index on `battle_unit.owner`. `battle` and `battle_challenge` keep
    /// their committed columns, access, keys and indexes (BT7.1: unchanged).
    ///
    /// Every key decision is frozen here because the automigration refuses a
    /// primary-key, uniqueness or `auto_inc` change on a live table.
    ///
    /// Kills: `public` on any tactical table (every client would receive every
    ///        battle's seeds, plans and staging — the view boundary bypassed);
    ///        a PK on the wrong column (`battle_queue` keyed by `battle_id`
    ///        allows one READY row per battle; `player_formation` keyed by a
    ///        synthetic id allows two formations per owner); a dropped or extra
    ///        `auto_inc` (`battle_queue.unit_id` auto-inc would mint ids that are
    ///        not the unit's); a missing btree (`battle_unit.battle_id` — the
    ///        cascade's only path to a unit; `battle_queue.owner` — the owner
    ///        view's key; `battle_tactical.map_id` — the zoning rule); an index
    ///        on the sum-typed `battle_unit.owner`; a hash index where the plan
    ///        says btree; `battle` or `battle_challenge` altered in passing.
    #[test]
    fn tactical_tables_are_private_with_pinned_keys_and_indexes_bt7_1() {
        use spacetimedb::sats::AlgebraicType;
        use spacetimedb::spacetimedb_lib::db::raw_def::v9::{
            RawConstraintDataV9, RawIndexAlgorithm, TableAccess,
        };

        struct Want {
            table: &'static str,
            access: TableAccess,
            columns: &'static [&'static str],
            pk: &'static str,
            auto_inc: &'static [&'static str],
            btree: &'static [&'static str],
        }
        let wants = [
            Want {
                table: "battle_tactical",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_BATTLE_TACTICAL,
                pk: "battle_id",
                auto_inc: &[],
                btree: &["battle_id", "map_id"],
            },
            Want {
                table: "battle_unit",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_BATTLE_UNIT,
                pk: "unit_id",
                auto_inc: &["unit_id"],
                btree: &["battle_id", "unit_id"],
            },
            Want {
                table: "battle_queue",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_BATTLE_QUEUE,
                pk: "unit_id",
                auto_inc: &[],
                btree: &["battle_id", "owner", "unit_id"],
            },
            Want {
                table: "battle_deploy",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_BATTLE_DEPLOY,
                pk: "deploy_id",
                auto_inc: &["deploy_id"],
                btree: &["battle_id", "deploy_id", "owner"],
            },
            Want {
                table: "battle_clock",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_BATTLE_CLOCK,
                pk: "clock_id",
                auto_inc: &["clock_id"],
                btree: &["battle_id", "clock_id", "player"],
            },
            Want {
                table: "battle_secret",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_BATTLE_SECRET,
                pk: "battle_id",
                auto_inc: &[],
                btree: &["battle_id"],
            },
            Want {
                table: "battle_wild_unit",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_BATTLE_WILD_UNIT,
                pk: "wild_unit_id",
                auto_inc: &["wild_unit_id"],
                btree: &["battle_id", "wild_unit_id"],
            },
            Want {
                table: "battle_event",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_BATTLE_EVENT,
                pk: "event_id",
                auto_inc: &["event_id"],
                btree: &["battle_id", "event_id"],
            },
            Want {
                table: "battle_summary",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_BATTLE_SUMMARY,
                pk: "battle_id",
                auto_inc: &[],
                btree: &["battle_id", "opponent_identity", "player_identity"],
            },
            Want {
                table: "player_formation",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_PLAYER_FORMATION,
                pk: "owner_identity",
                auto_inc: &[],
                btree: &["owner_identity"],
            },
            Want {
                table: "battle",
                access: TableAccess::Private,
                columns: super::BT7_COLUMNS_BATTLE,
                pk: "battle_id",
                auto_inc: &["battle_id"],
                btree: &["battle_id", "opponent_identity", "player_identity"],
            },
            Want {
                table: "battle_challenge",
                access: TableAccess::Public,
                columns: super::BT7_COLUMNS_BATTLE_CHALLENGE,
                pk: "challenge_id",
                auto_inc: &["challenge_id"],
                btree: &["challenge_id", "challenger", "target"],
            },
        ];

        let fx = fixture();
        let def = fx.module_def();
        let ts = def.typespace().unwrap_or_else(|| {
            panic!("[bt7/describe-typespace] the generated module def carries no typespace")
        });
        let tables = def.tables().unwrap_or_else(|| {
            panic!("[bt7/describe-tables] the generated module def carries no Tables section")
        });
        for want in &wants {
            let name = want.table;
            let Some(t) = tables.iter().find(|t| &*t.source_name == name) else {
                panic!("[bt7/table-missing] `{name}` is not in the generated module def")
            };
            let AlgebraicType::Product(row) = &ts[t.product_type_ref] else {
                panic!("[bt7/table-row-shape] `{name}`'s row type is not a product")
            };
            let columns: Vec<String> = row
                .elements
                .iter()
                .map(|e| e.name.as_deref().unwrap_or("").to_string())
                .collect();
            assert_eq!(
                columns, want.columns,
                "[bt7/table-columns] `{name}`'s generated columns, in order"
            );
            let name_of = |col: u16| columns[usize::from(col)].clone();

            assert_eq!(
                t.table_access, want.access,
                "[bt7/table-access] `{name}`: every tactical table is PRIVATE — the client reads \
                 only through the seven views, and three tables have no read path at all"
            );
            assert!(
                !t.is_event,
                "[bt7/table-not-event] `{name}` is a stored table"
            );

            let pk: Vec<String> = t
                .primary_key
                .to_u16_vec()
                .iter()
                .map(|&col| name_of(col))
                .collect();
            assert_eq!(pk, [want.pk], "[bt7/table-pk] `{name}`'s primary key");

            let mut unique: Vec<String> = t
                .constraints
                .iter()
                .map(|c| match &c.data {
                    RawConstraintDataV9::Unique(u) => u
                        .columns
                        .to_u16_vec()
                        .iter()
                        .map(|&col| name_of(col))
                        .collect::<Vec<_>>()
                        .join("+"),
                    other => panic!("[bt7/table-constraint] `{name}` carries {other:?}"),
                })
                .collect();
            unique.sort();
            assert_eq!(
                unique,
                [want.pk],
                "[bt7/table-unique] `{name}`: the primary key is the ONLY uniqueness (a later \
                 unique constraint is automigration-forbidden, so none ships by accident)"
            );

            let mut auto_inc: Vec<String> = t
                .sequences
                .iter()
                .map(|s| name_of(u16::from(s.column)))
                .collect();
            auto_inc.sort();
            assert_eq!(
                auto_inc, want.auto_inc,
                "[bt7/table-auto-inc] `{name}`'s auto_inc columns"
            );

            let mut btree: Vec<String> = t
                .indexes
                .iter()
                .map(|ix| match &ix.algorithm {
                    RawIndexAlgorithm::BTree { columns } => columns
                        .to_u16_vec()
                        .iter()
                        .map(|&col| name_of(col))
                        .collect::<Vec<_>>()
                        .join("+"),
                    other => {
                        panic!("[bt7/table-index-kind] `{name}` carries a non-btree {other:?}")
                    }
                })
                .collect();
            btree.sort();
            assert_eq!(
                btree, want.btree,
                "[bt7/table-indexes] `{name}`'s btree index set (each entry one index, columns \
                 joined by +). `battle_unit.owner` is a sum type and must carry none."
            );
        }
    }

    /// BT7.1 — the GENERATED view roster is exactly the twenty-one views (the
    /// eight pre-bt-7, the seven tactical ones, `my_trade_session`,
    /// `my_player_quest`, `my_world_binding`, `my_bind_nonce`,
    /// `my_world_account` and `my_world_move`), each at the position its id names,
    /// every one public, caller-scoped (not anonymous) and parameterless; no view is
    /// named for a secret table; and each tactical view, `my_trade_session`,
    /// `my_world_binding`, `my_bind_nonce`, `my_world_account` and `my_world_move`
    /// serves exactly its own table's row (its generated return type resolved
    /// through the typespace).
    ///
    /// Kills: a view for `battle_secret`, `battle_wild_unit` or
    ///        `battle_summary` (BT7.2: none, ever); a view taking an argument
    ///        (an `owner: Identity` parameter is a caller-chosen-owner leak); an
    ///        anonymous view (it cannot know its caller, so it cannot scope);
    ///        a tactical view re-typed to serve another table's row (say
    ///        `my_battle_events -> Vec<BattleSecret>`); `my_formation` widened to
    ///        a `Vec`; a dropped or renamed view; a `VIEW_MY_*` id pointing at the
    ///        wrong view (every `call_view` test below would then read a
    ///        different boundary than it names); `my_player_quest` registered
    ///        non-public (it would pass every native-host call and be invisible
    ///        to clients).
    #[test]
    fn generated_view_roster_is_exactly_twenty_one_caller_scoped_views_bt7_1() {
        use crate::native_host_tests::{
            VIEW_MY_BATTLE, VIEW_MY_BATTLE_CLOCK, VIEW_MY_BATTLE_DEPLOY, VIEW_MY_BATTLE_EVENTS,
            VIEW_MY_BATTLE_QUEUE, VIEW_MY_BATTLE_UNITS, VIEW_MY_CONVERSATION,
            VIEW_MY_EXPORT_BUNDLE, VIEW_MY_FORMATION, VIEW_MY_INVENTORY, VIEW_MY_MONSTER_PUB,
            VIEW_MY_PENDING_EVOLUTION_NOTICES, VIEW_MY_PLAYER_QUEST, VIEW_MY_TACTICAL_BATTLE,
            VIEW_MY_WALLET, VIEW_MY_WORLD_ACCOUNT, VIEW_MY_WORLD_MOVE,
        };
        let fx = fixture();
        let def = fx.module_def();
        let views = def.views().unwrap_or_else(|| {
            panic!("[bt7/describe-views] the generated module def carries no Views section")
        });

        let mut names: Vec<String> = views.iter().map(|v| v.source_name.to_string()).collect();
        names.sort();
        assert_eq!(
            names,
            [
                "my_account",
                "my_battle",
                "my_battle_clock",
                "my_battle_deploy",
                "my_battle_events",
                "my_battle_queue",
                "my_battle_units",
                "my_bind_nonce",
                "my_conversation",
                "my_export_bundle",
                "my_formation",
                "my_inventory",
                "my_monster_pub",
                "my_pending_evolution_notices",
                "my_player_quest",
                "my_tactical_battle",
                "my_trade_session",
                "my_wallet",
                "my_world_account",
                "my_world_binding",
                "my_world_move",
            ],
            "[bt7/view-roster] the generated view set (twenty-one views)"
        );

        for (id, name) in [
            (VIEW_MY_WALLET, "my_wallet"),
            (VIEW_MY_ACCOUNT, "my_account"),
            (VIEW_MY_CONVERSATION, "my_conversation"),
            (VIEW_MY_MONSTER_PUB, "my_monster_pub"),
            (VIEW_MY_BATTLE, "my_battle"),
            (
                VIEW_MY_PENDING_EVOLUTION_NOTICES,
                "my_pending_evolution_notices",
            ),
            (VIEW_MY_EXPORT_BUNDLE, "my_export_bundle"),
            (VIEW_MY_INVENTORY, "my_inventory"),
            (VIEW_MY_TACTICAL_BATTLE, "my_tactical_battle"),
            (VIEW_MY_BATTLE_UNITS, "my_battle_units"),
            (VIEW_MY_BATTLE_EVENTS, "my_battle_events"),
            (VIEW_MY_BATTLE_CLOCK, "my_battle_clock"),
            (VIEW_MY_BATTLE_QUEUE, "my_battle_queue"),
            (VIEW_MY_BATTLE_DEPLOY, "my_battle_deploy"),
            (VIEW_MY_FORMATION, "my_formation"),
            // `my_trade_session` is registered after `my_formation`.
            (VIEW_MY_FORMATION + 1, "my_trade_session"),
            // sr-3: `my_player_quest` is registered after `my_trade_session`.
            (VIEW_MY_PLAYER_QUEST, "my_player_quest"),
            // `my_world_binding`, then `my_bind_nonce`, then `my_world_account`.
            (VIEW_MY_PLAYER_QUEST + 1, "my_world_binding"),
            (VIEW_MY_PLAYER_QUEST + 2, "my_bind_nonce"),
            (VIEW_MY_WORLD_ACCOUNT, "my_world_account"),
            // `my_world_move` is registered after `my_world_account`.
            (VIEW_MY_WORLD_MOVE, "my_world_move"),
        ] {
            let v = &views[id];
            assert_eq!(
                &*v.source_name, name,
                "[bt7/view-id] view id {id} must name `{name}` — the ids are positional, and \
                 every call_view test reads the boundary its id points at"
            );
            assert_eq!(
                u32::try_from(id).ok(),
                Some(v.index),
                "[bt7/view-id] `{name}`'s generated index"
            );
        }

        for v in views {
            let name = v.source_name.to_string();
            assert!(
                v.is_public,
                "[bt7/view-public] `{name}` must be a public view"
            );
            assert!(
                !v.is_anonymous,
                "[bt7/view-caller-scoped] `{name}` must know its caller (ViewContext, not anonymous)"
            );
            assert!(
                v.params.elements.is_empty(),
                "[bt7/view-no-params] `{name}` takes parameters — a caller-chosen key is a leak"
            );
            for banned in ["secret", "wild_unit", "summary"] {
                assert!(
                    !name.contains(banned),
                    "[bt7/view-no-secret-table] `{name}` names `{banned}`: battle_secret, \
                     battle_wild_unit and battle_summary have NO view (BT7.2)"
                );
            }
        }

        let ts = def.typespace().unwrap_or_else(|| {
            panic!("[bt7/describe-typespace] the generated module def carries no typespace")
        });
        // The `trade_session` row, in declaration order.
        const TRADE_SESSION_COLUMNS: &[&str] = &[
            "session_id",
            "opener",
            "partner",
            "opener_offer",
            "partner_offer",
            "opener_confirmed",
            "partner_confirmed",
            "revision",
            "created_at_ms",
        ];
        // The `world_binding` and `world_bind_nonce` rows, in declaration order.
        const WORLD_BINDING_COLUMNS: &[&str] = &[
            "identity",
            "account_subject",
            "bound_at_ms",
            "entitled",
            "key_id",
        ];
        const WORLD_BIND_NONCE_COLUMNS: &[&str] = &["identity", "nonce", "expires_at_ms"];
        // The `world_account` row, in declaration order.
        const WORLD_ACCOUNT_COLUMNS: &[&str] =
            &["handle", "identity", "entitled", "checked_at_ms", "is_host"];
        // The `world_move` row, in declaration order.
        const WORLD_MOVE_COLUMNS: &[&str] = &["identity", "moved_at_ms"];
        for (view, columns) in [
            ("my_tactical_battle", super::BT7_COLUMNS_BATTLE_TACTICAL),
            ("my_battle_units", super::BT7_COLUMNS_BATTLE_UNIT),
            ("my_battle_events", super::BT7_COLUMNS_BATTLE_EVENT),
            ("my_battle_clock", super::BT7_COLUMNS_BATTLE_CLOCK),
            ("my_battle_queue", super::BT7_COLUMNS_BATTLE_QUEUE),
            ("my_battle_deploy", super::BT7_COLUMNS_BATTLE_DEPLOY),
            ("my_formation", super::BT7_COLUMNS_PLAYER_FORMATION),
            ("my_trade_session", TRADE_SESSION_COLUMNS),
            ("my_world_binding", WORLD_BINDING_COLUMNS),
            ("my_bind_nonce", WORLD_BIND_NONCE_COLUMNS),
            ("my_world_account", WORLD_ACCOUNT_COLUMNS),
            ("my_world_move", WORLD_MOVE_COLUMNS),
        ] {
            let Some(v) = views.iter().find(|v| &*v.source_name == view) else {
                panic!("[bt7/view-missing] `{view}`")
            };
            assert_eq!(
                bt7_view_row_columns(ts, &v.return_type, view),
                columns,
                "[bt7/view-row] `{view}` must serve exactly its own table's row"
            );
        }
    }

    /// BT7.2 — the four PARTICIPANT views, through the runtime's own view entry
    /// point, return to each caller exactly the rows of every battle it is a
    /// side of — BOTH sides' units and clocks — each battle once (the practice
    /// battle included once), and nothing to a stranger, to the zero identity
    /// (a wild battle's opponent column) or to the deletion tombstone (an
    /// anonymised battle's side). Battles: 8101 A-B, 8102 B-A, 8103 A-A
    /// (practice), 8104 B-C, 8105 A-wild, 8106 tombstone-B; row counts differ
    /// per battle.
    ///
    /// Kills: any participant view serving every battle (the red-phase stub)
    ///        or keyed on one identity column only (8102 vanishes for A, 8101
    ///        for B); the practice dedup dropped (8103 twice for A) or inverted
    ///        to `player != opponent` (8103 gone); a view serving only the
    ///        caller's own side's units / clock (the opponent's units of 8101
    ///        missing); only the first battle's rows; the zero identity served
    ///        every wild battle, or the tombstone every anonymised one.
    #[test]
    fn participant_views_return_each_battle_to_both_sides_exactly_once_bt7_2() {
        use crate::native_host_tests::{
            VIEW_MY_BATTLE_CLOCK, VIEW_MY_BATTLE_EVENTS, VIEW_MY_BATTLE_UNITS,
            VIEW_MY_TACTICAL_BATTLE,
        };
        let fx = fixture();
        let w = world(&fx);
        let (a, b, c, d) = (id(0x4A), id(0x4B), id(0x4C), id(0x4D));
        let tomb = crate::TOMBSTONE_IDENTITY;
        seed_tactical_battle(&w, 8101, a, Some(b));
        seed_tactical_battle(&w, 8102, b, Some(a));
        seed_tactical_battle(&w, 8103, a, Some(a));
        seed_tactical_battle(&w, 8104, b, Some(c));
        seed_tactical_battle(&w, 8105, a, None);
        seed_tactical_battle(&w, 8106, tomb, Some(b));

        // (caller, its battles, tactical rows, units, events, clocks)
        type ViewCase<'a> = (Identity, &'a [u64], usize, usize, usize, usize);
        let cases: [ViewCase<'_>; 6] = [
            (a, &[8101, 8102, 8103, 8105], 4, 15, 9, 7),
            (b, &[8101, 8102, 8104, 8106], 4, 13, 8, 8),
            (c, &[8104], 1, 3, 2, 2),
            (d, &[], 0, 0, 0, 0),
            (Identity::ZERO, &[], 0, 0, 0, 0),
            (tomb, &[], 0, 0, 0, 0),
        ];
        for (who, ids, n_tactical, n_units, n_events, n_clocks) in cases {
            let tactical = encs(
                &w.tactical
                    .rows()
                    .into_iter()
                    .filter(|r| ids.contains(&r.battle_id))
                    .collect::<Vec<_>>(),
            );
            let units = encs(
                &w.unit
                    .rows()
                    .into_iter()
                    .filter(|r| ids.contains(&r.battle_id))
                    .collect::<Vec<_>>(),
            );
            let events = encs(
                &w.event
                    .rows()
                    .into_iter()
                    .filter(|r| ids.contains(&r.battle_id))
                    .collect::<Vec<_>>(),
            );
            let clocks = encs(
                &w.clock
                    .rows()
                    .into_iter()
                    .filter(|r| ids.contains(&r.battle_id))
                    .collect::<Vec<_>>(),
            );
            assert_eq!(
                (tactical.len(), units.len(), events.len(), clocks.len()),
                (n_tactical, n_units, n_events, n_clocks),
                "fixture: {who:?}'s expected row counts"
            );
            assert_eq!(
                encs(&fx.call_view::<BattleTactical>(VIEW_MY_TACTICAL_BATTLE, who)),
                tactical,
                "[bt7/participant-tactical] {who:?} must receive the tactical row of exactly \
                 battles {ids:?}, each once"
            );
            assert_eq!(
                encs(&fx.call_view::<BattleUnit>(VIEW_MY_BATTLE_UNITS, who)),
                units,
                "[bt7/participant-units] {who:?} must receive BOTH sides' units of exactly \
                 battles {ids:?}"
            );
            assert_eq!(
                encs(&fx.call_view::<BattleEvent>(VIEW_MY_BATTLE_EVENTS, who)),
                events,
                "[bt7/participant-events] {who:?} must receive the events of exactly {ids:?}"
            );
            assert_eq!(
                encs(&fx.call_view::<BattleClock>(VIEW_MY_BATTLE_CLOCK, who)),
                clocks,
                "[bt7/participant-clock] {who:?} must receive BOTH sides' clocks of exactly \
                 battles {ids:?}"
            );
        }

        // The shared battle, explicitly: each side sees the OTHER side's units
        // and clock (design §6.3 — positions, HP and the opponent's clock are
        // public to participants).
        for (viewer, other) in [(a, b), (b, a)] {
            let units = fx.call_view::<BattleUnit>(VIEW_MY_BATTLE_UNITS, viewer);
            assert_eq!(
                units
                    .iter()
                    .filter(|u| u.battle_id == 8101 && u.owner == Some(other))
                    .count(),
                2,
                "[bt7/participant-both-sides] {viewer:?} must see {other:?}'s two units of 8101"
            );
            let clocks = fx.call_view::<BattleClock>(VIEW_MY_BATTLE_CLOCK, viewer);
            assert_eq!(
                clocks
                    .iter()
                    .filter(|k| k.battle_id == 8101 && k.player == other)
                    .count(),
                1,
                "[bt7/participant-both-sides] {viewer:?} must see {other:?}'s clock of 8101"
            );
        }
    }

    /// BT7.2 — the three OWNER views return the caller's own rows and nothing
    /// else, across battles the owners SHARE: `my_battle_queue` /
    /// `my_battle_deploy` exactly the caller's READY / staging rows (in the
    /// shared battle 8101, the practice battle 8103 where one owner stages
    /// both sides, and 8104), `my_formation` the caller's row or nothing; a
    /// stranger gets nothing from any of them.
    ///
    /// Kills: an owner view scoped by battle instead of by owner (the
    ///        red-phase stub: A receives B's READY row of 8101 — the §6.3 leak);
    ///        `my_formation` returning nothing (the stub) or another owner's
    ///        row; an owner view dropping the practice battle's second-side
    ///        rows; a view serving every row.
    #[test]
    fn owner_views_return_only_the_callers_own_rows_bt7_2() {
        use crate::native_host_tests::{
            VIEW_MY_BATTLE_DEPLOY, VIEW_MY_BATTLE_QUEUE, VIEW_MY_FORMATION,
        };
        let fx = fixture();
        let w = world(&fx);
        let (a, b, c, d) = (id(0x4A), id(0x4B), id(0x4C), id(0x4D));
        seed_tactical_battle(&w, 8101, a, Some(b));
        seed_tactical_battle(&w, 8102, b, Some(a));
        seed_tactical_battle(&w, 8103, a, Some(a));
        seed_tactical_battle(&w, 8104, b, Some(c));
        seed_staging(&w, 8101, a, Some(b));
        seed_staging(&w, 8103, a, Some(a));
        seed_staging(&w, 8104, b, Some(c));
        w.formation.seed(&formation_row(a, 1));
        w.formation.seed(&formation_row(b, 2));

        for (who, n_staging) in [(a, 3usize), (b, 2), (c, 1), (d, 0)] {
            let own_queue = encs(
                &w.queue
                    .rows()
                    .into_iter()
                    .filter(|r| r.owner == who)
                    .collect::<Vec<_>>(),
            );
            let own_deploy = encs(
                &w.deploy
                    .rows()
                    .into_iter()
                    .filter(|r| r.owner == who)
                    .collect::<Vec<_>>(),
            );
            assert_eq!(
                (own_queue.len(), own_deploy.len()),
                (n_staging, n_staging),
                "fixture: {who:?}'s own staging rows"
            );
            assert_eq!(
                encs(&fx.call_view::<BattleQueue>(VIEW_MY_BATTLE_QUEUE, who)),
                own_queue,
                "[bt7/owner-queue] {who:?} must receive exactly its own READY rows"
            );
            assert_eq!(
                encs(&fx.call_view::<BattleDeploy>(VIEW_MY_BATTLE_DEPLOY, who)),
                own_deploy,
                "[bt7/owner-deploy] {who:?} must receive exactly its own deploy staging"
            );
        }

        let formation =
            |who: Identity| encs(&fx.call_view::<PlayerFormation>(VIEW_MY_FORMATION, who));
        assert_eq!(
            formation(a),
            encs(&[formation_row(a, 1)]),
            "[bt7/owner-formation] A must receive its own formation"
        );
        assert_eq!(
            formation(b),
            encs(&[formation_row(b, 2)]),
            "[bt7/owner-formation] B must receive its own formation"
        );
        assert!(
            formation(c).is_empty() && formation(d).is_empty(),
            "[bt7/owner-formation] a caller with no formation row receives nothing"
        );
    }

    /// BT7.3 — the design §6.3 proof. In ONE shared battle where BOTH sides
    /// hold READY rows on every unit and deploy staging, neither participant's
    /// `my_battle_queue` / `my_battle_deploy` carries a single row of the
    /// opponent's (by owner, by unit id, by bytes), while each still receives
    /// its own exactly. A strangers' battle with staging is present too.
    ///
    /// Kills: the red-phase stub (owner views scoped by participation: each
    ///        side reads the other's plans — whether a READY row exists and its
    ///        entries are the competitively decisive secret); an owner filter
    ///        on the wrong column; an owner view that de-duplicates by unit so
    ///        an opponent row can stand in for a missing own row.
    #[test]
    fn opponent_never_receives_a_queue_or_deploy_row_bt7_3() {
        use crate::native_host_tests::{VIEW_MY_BATTLE_DEPLOY, VIEW_MY_BATTLE_QUEUE};
        let fx = fixture();
        let w = world(&fx);
        let (a, b, c, d) = (id(0x5A), id(0x5B), id(0x5C), id(0x5D));
        seed_tactical_battle(&w, 8301, a, Some(b));
        for (n, owner) in [(1, a), (2, a), (3, b), (4, b)] {
            w.queue.seed(&queue_row(8301, n, owner));
        }
        w.deploy.seed(&deploy_row(8301, SideRow::A, a));
        w.deploy.seed(&deploy_row(8301, SideRow::B, b));
        seed_tactical_battle(&w, 8302, c, Some(d));
        seed_staging(&w, 8302, c, Some(d));

        for (viewer, opponent) in [(a, b), (b, a)] {
            let opponent_units: Vec<u32> = w
                .unit
                .rows()
                .into_iter()
                .filter(|u| u.battle_id == 8301 && u.owner == Some(opponent))
                .map(|u| u.unit_id)
                .collect();
            let opponent_queue = encs(
                &w.queue
                    .rows()
                    .into_iter()
                    .filter(|r| r.owner == opponent)
                    .collect::<Vec<_>>(),
            );
            let opponent_deploy = encs(
                &w.deploy
                    .rows()
                    .into_iter()
                    .filter(|r| r.owner == opponent)
                    .collect::<Vec<_>>(),
            );
            assert_eq!(
                (
                    opponent_units.len(),
                    opponent_queue.len(),
                    opponent_deploy.len()
                ),
                (2, 2, 1),
                "fixture: the opponent HAS two units, two READY rows and a deploy row in 8301"
            );

            let queue = fx.call_view::<BattleQueue>(VIEW_MY_BATTLE_QUEUE, viewer);
            let leaked: Vec<u32> = queue
                .iter()
                .filter(|r| r.owner != viewer || opponent_units.contains(&r.unit_id))
                .map(|r| r.unit_id)
                .collect();
            assert!(
                leaked.is_empty(),
                "[bt7/no-opponent-queue] {viewer:?} received the opponent's READY rows for units \
                 {leaked:?} — design §6.3: whether a READY row exists at all is secret"
            );
            assert!(
                encs(&queue).iter().all(|e| !opponent_queue.contains(e)),
                "[bt7/no-opponent-queue] {viewer:?} received a row byte-equal to the opponent's"
            );
            let deploy = fx.call_view::<BattleDeploy>(VIEW_MY_BATTLE_DEPLOY, viewer);
            let leaked: Vec<u64> = deploy
                .iter()
                .filter(|r| r.owner != viewer)
                .map(|r| r.deploy_id)
                .collect();
            assert!(
                leaked.is_empty(),
                "[bt7/no-opponent-deploy] {viewer:?} received the opponent's staging {leaked:?}"
            );
            assert!(
                encs(&deploy).iter().all(|e| !opponent_deploy.contains(e)),
                "[bt7/no-opponent-deploy] {viewer:?} received a row byte-equal to the opponent's"
            );

            assert_eq!(
                encs(&queue),
                encs(
                    &w.queue
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner == viewer)
                        .collect::<Vec<_>>()
                ),
                "[bt7/own-queue] {viewer:?} still receives exactly its own two READY rows"
            );
            assert_eq!(
                encs(&deploy),
                encs(
                    &w.deploy
                        .rows()
                        .into_iter()
                        .filter(|r| r.owner == viewer)
                        .collect::<Vec<_>>()
                ),
                "[bt7/own-deploy] {viewer:?} still receives exactly its own staging"
            );
        }
    }

    /// BT7.3 — `battle_unit` exposes no queue or ready signal: both
    /// participants' `my_battle_units` results are byte-identical to the shared
    /// battle's unit rows BEFORE and AFTER a READY row is stored for one of A's
    /// units (whose existence its owner can confirm through `my_battle_queue`),
    /// and A's and B's results are the same set. A strangers' battle is present.
    ///
    /// Kills: a units view that serves every battle (the red-phase stub: the
    ///        strangers' units arrive); a units view that hides, flags, reorders
    ///        or re-stamps a unit with a pending plan (the opponent would learn
    ///        a READY row exists — design §6.3); per-viewer unit projections
    ///        that differ between the two sides.
    #[test]
    fn unit_rows_do_not_reveal_whether_a_plan_is_ready_bt7_3() {
        use crate::native_host_tests::{VIEW_MY_BATTLE_QUEUE, VIEW_MY_BATTLE_UNITS};
        let fx = fixture();
        let w = world(&fx);
        let (a, b, c, d) = (id(0x5E), id(0x5F), id(0x60), id(0x61));
        seed_tactical_battle(&w, 8401, a, Some(b));
        seed_tactical_battle(&w, 8402, c, Some(d));
        let units = |who: Identity| encs(&fx.call_view::<BattleUnit>(VIEW_MY_BATTLE_UNITS, who));
        let shared = encs(
            &w.unit
                .rows()
                .into_iter()
                .filter(|u| u.battle_id == 8401)
                .collect::<Vec<_>>(),
        );
        assert_eq!(shared.len(), 4, "fixture: battle 8401 has four units");

        let (a_before, b_before) = (units(a), units(b));
        assert_eq!(
            a_before, shared,
            "[bt7/units-before] A must receive exactly the shared battle's four units"
        );
        assert_eq!(
            b_before, shared,
            "[bt7/units-before] B must receive exactly the shared battle's four units"
        );

        let plan = queue_row(8401, 1, a);
        w.queue.seed(&plan);
        assert_eq!(
            encs(&fx.call_view::<BattleQueue>(VIEW_MY_BATTLE_QUEUE, a)),
            encs(std::slice::from_ref(&plan)),
            "fixture: the READY row exists and its owner can see it"
        );

        let (a_after, b_after) = (units(a), units(b));
        assert_eq!(
            a_after, a_before,
            "[bt7/units-no-ready-signal] A's unit rows changed when a READY row was stored"
        );
        assert_eq!(
            b_after, b_before,
            "[bt7/units-no-ready-signal] B's unit rows changed when A stored a READY row — \
             the opponent can now tell a plan exists"
        );
        assert_eq!(
            a_after, b_after,
            "[bt7/units-same-for-both] both participants must receive the same unit rows"
        );
    }

    /// BT7.4 — the due `account_deletion_reaper` tick erases EVERY tactical row
    /// of every battle the subject is a side of, by `battle_id` presence (not by
    /// owner): both battle roles (2011 subject-B, 2012 B-subject), its wild
    /// battle (units with `owner: None`, wild-unit rows) and its practice
    /// battle, the bystander's own rows in those SHARED battles included — and
    /// every battle the anchor chain can no longer reach but some row still
    /// names the subject through (the UNION of schema.rs `erase_tactical_rows`
    /// (1)): 2015 (anchor gone, the subject's CLOCK is the only route), 996 (its
    /// READY row), 997 (its deploy row), 998 (a summary naming it), 999 (a lone
    /// unit it owns — only the `battle_unit` owner scan finds it), each with
    /// sibling rows only the per-battle sweep can reach — and every battle
    /// ONLY the anchor chain reaches: 2016 (the subject is
    /// `battle.player_identity` and nothing else names it) and 2017 (the
    /// mirror: only `battle.opponent_identity`), each a settled anchor against
    /// the bystander with its tactical row, its secret and the BYSTANDER's
    /// deploy + clock rows, so only the anchor's two index lookups find it, and
    /// only while the anchor still names the subject. Every `battle_summary`
    /// row naming the subject SURVIVES with exactly that side swapped to
    /// `crate::TOMBSTONE_IDENTITY` (subject-B, B-subject, subject-subject,
    /// subject-wild) and the other side intact; the subject's formation goes.
    /// The bystander's rows in battles WITHOUT the subject — its own battles and
    /// orphan controls under other dead ids — are byte-identical, its formation
    /// survives. A non-scheduler caller and a not-yet-due tick touch nothing.
    ///
    /// Kills: `erase_tactical_rows` a no-op (the red-phase stub) or dropped
    ///        from the reaper; sequenced AFTER `battle::anonymize_battles`
    ///        (the swap leaves neither anchor naming the subject: 2016 and 2017
    ///        survive, `[bt7/cascade-anchor-only]`); battle ids from the
    ///        `opponent_identity` anchor index only (2016 survives) or from the
    ///        `player_identity` one only (2017 survives); ids from the anchor
    ///        chain only (2015, 996-999 siblings survive); the clock / queue /
    ///        deploy / summary / unit-scan route dropped (one of 2015, 996, 997,
    ///        998, 999 survives); erasing by owner instead of by battle (the
    ///        `owner: None` wild units, the tactical / secret / event / wild-unit
    ///        rows and the bystander's units of 2011 survive); one per-battle
    ///        table forgotten; a summary deleted, tombstoned on the wrong side,
    ///        on both sides of a two-player row, or on one side of a practice
    ///        row; a bystander's unshared row touched; the formation kept or the
    ///        bystander's taken; the scheduler guard or due-ness check moved
    ///        below the tactical step.
    #[test]
    fn deletion_cascade_erases_tactical_rows_by_battle_and_tombstones_summaries_bt7_4() {
        let fx = fixture();
        let w = world(&fx);
        let v = id(0x6A);
        let b = id(0x6B);
        let x = id(0x6C);
        let tomb = crate::TOMBSTONE_IDENTITY;
        let wild = crate::WILD_IDENTITY;
        let requested = T0;
        let pending = crate::accounts::requested_deletion(
            crate::accounts::new_account_row(v, "iss".to_string(), 1),
            requested,
        );
        w.account.seed(&pending);
        w.account
            .seed(&crate::accounts::new_account_row(b, "iss".to_string(), 1));
        seed_tactical_population(&w, v, b, 1);
        seed_tactical_population(&w, b, x, 2);

        // Union routes: battles the anchor chain cannot reach, each named by
        // exactly ONE owner-keyed row, each with siblings only a per-battle
        // sweep reaches.
        w.tactical.seed(&tactical_row(2015, BattleKind::Wild));
        w.secret.seed(&secret_row(2015));
        w.event.seed(&event_row(2015, 1));
        w.unit.seed(&unit_row(2015, 3, SideRow::B, None));
        w.wild_unit.seed(&wild_unit_row(2015, 0));
        w.clock.seed(&clock_row(2015, SideRow::A, v));
        w.queue.seed(&queue_row(996, 1, v));
        w.tactical.seed(&tactical_row(996, BattleKind::Pvp));
        w.deploy.seed(&deploy_row(997, SideRow::A, v));
        w.secret.seed(&secret_row(997));
        w.summary.seed(&summary_row(998, v, b, BattleKind::Pvp));
        w.wild_unit.seed(&wild_unit_row(998, 0));
        w.unit.seed(&unit_row(999, 1, SideRow::A, Some(v)));
        w.event.seed(&event_row(999, 1));
        // Bystander orphan controls under OTHER dead battle ids: all survive.
        w.queue.seed(&queue_row(986, 1, b));
        w.tactical.seed(&tactical_row(986, BattleKind::Pvp));
        w.deploy.seed(&deploy_row(987, SideRow::A, b));
        w.secret.seed(&secret_row(987));
        w.clock.seed(&clock_row(988, SideRow::A, b));
        w.event.seed(&event_row(988, 1));
        w.unit.seed(&unit_row(989, 1, SideRow::A, Some(b)));
        w.wild_unit.seed(&wild_unit_row(989, 0));
        w.summary.seed(&summary_row(990, b, x, BattleKind::Pvp));
        w.clock.seed(&clock_row(990, SideRow::B, x));
        // Anchor-only battles: the subject is named by the settled `battle`
        // anchor and by NOTHING else (no clock, queue, deploy, summary or unit
        // row), so only `erase_tactical_rows`'s two anchor-index lookups reach
        // them. 2016: the subject is `player_identity` only; 2017: the mirror,
        // `opponent_identity` only. Each holds its tactical row, its secret
        // and the bystander's (the PEER's) deploy + clock rows.
        let anchor_only = [(2016, v, b, SideRow::B), (2017, b, v, SideRow::A)];
        let anchor_of = |battle_id: u64, player: Identity, opponent: Identity| {
            let mut anchor = battle_row(player, opponent);
            anchor.battle_id = battle_id;
            anchor.state.outcome = game_core::BattleOutcome::SideAWins;
            anchor
        };
        for (battle_id, player, opponent, peer_side) in anchor_only {
            w.battle.seed(&anchor_of(battle_id, player, opponent));
            w.tactical.seed(&tactical_row(battle_id, BattleKind::Pvp));
            w.secret.seed(&secret_row(battle_id));
            w.deploy.seed(&deploy_row(battle_id, peer_side, b));
            w.clock.seed(&clock_row(battle_id, peer_side, b));
        }
        // Every row of one battle in the eight per-battle tables and
        // `battle_summary`, as `(table, canonical bytes)` in table order.
        let rows_of = |battle_id: u64| -> Vec<(&'static str, Vec<u8>)> {
            let mut out: Vec<(&'static str, Vec<u8>)> = Vec::new();
            for (table, rows) in per_battle_rows(&w) {
                for (bid, bytes) in rows {
                    if bid == battle_id {
                        out.push((table, bytes));
                    }
                }
            }
            for s in w.summary.rows() {
                if s.battle_id == battle_id {
                    out.push(("battle_summary", enc(&s)));
                }
            }
            out
        };
        for (battle_id, player, opponent, peer_side) in anchor_only {
            let anchors: Vec<crate::schema::Battle> = w
                .battle
                .rows()
                .into_iter()
                .filter(|r| r.battle_id == battle_id)
                .collect();
            assert_eq!(
                encs(&anchors),
                encs(&[anchor_of(battle_id, player, opponent)]),
                "fixture: anchor-only battle {battle_id} has exactly one settled anchor, naming \
                 the subject on exactly one column"
            );
            assert_eq!(
                rows_of(battle_id),
                vec![
                    (
                        "battle_tactical",
                        enc(&tactical_row(battle_id, BattleKind::Pvp)),
                    ),
                    ("battle_secret", enc(&secret_row(battle_id))),
                    ("battle_deploy", enc(&deploy_row(battle_id, peer_side, b))),
                    ("battle_clock", enc(&clock_row(battle_id, peer_side, b))),
                ],
                "fixture: anchor-only battle {battle_id} must hold exactly its tactical row, its \
                 secret and the PEER's deploy + clock rows — any row naming the subject outside \
                 the anchor is a second route, and the anchor-only erase check below goes vacuous"
            );
        }

        let mut subject_battles = vec![2011, 2012, 2013, 2014, 2015, 996, 997, 998, 999];
        subject_battles.extend(anchor_only.map(|(battle_id, ..)| battle_id));
        let before = per_battle_rows(&w);
        for (table, rows) in &before {
            assert!(
                rows.iter().any(|(bid, _)| subject_battles.contains(bid))
                    && rows.iter().any(|(bid, _)| !subject_battles.contains(bid)),
                "fixture: `{table}` must hold rows of the subject's battles AND of battles \
                 without it, or the erase and keep halves below are vacuous"
            );
        }
        assert_eq!(
            w.unit
                .rows()
                .iter()
                .filter(|u| u.battle_id == 2013 && u.owner.is_none())
                .count(),
            2,
            "fixture: the subject's wild battle has two `owner: None` units"
        );
        let summaries_before = w.summary.rows();
        let untouched = |w: &W<'_>| {
            (
                per_battle_rows(w),
                encs(&w.summary.rows()),
                encs(&w.formation.rows()),
            )
        };
        let snapshot = untouched(&w);

        let sched = || AccountDeletionReaperSchedule {
            scheduled_id: 1,
            scheduled_at: ScheduleAt::Time(at(crate::accounts::deletion_fire_at_ms(requested))),
            account_identity: v,
        };
        let grace_end = crate::accounts::deletion_fire_at_ms(requested);

        let got = fx.run_as_at(v, at(grace_end), |ctx| {
            crate::accounts::account_deletion_reaper(ctx, sched())
        });
        assert_eq!(
            got,
            Err("account_deletion_reaper is scheduler-only".to_string())
        );
        assert!(
            untouched(&w) == snapshot,
            "[bt7/cascade-refused] a non-scheduler tick touched a tactical row"
        );
        let got = fx.run_as_at(scheduler(), at(grace_end - 1), |ctx| {
            crate::accounts::account_deletion_reaper(ctx, sched())
        });
        assert_eq!(got, Ok(()));
        assert!(
            untouched(&w) == snapshot,
            "[bt7/cascade-early] a not-yet-due tick touched a tactical row"
        );
        w.del_reaper.remove(v);

        let got = fx.run_as_at(scheduler(), at(grace_end), |ctx| {
            crate::accounts::account_deletion_reaper(ctx, sched())
        });
        assert_eq!(got, Ok(()));

        // The anchor-only battles go whole. Nothing but one anchor column names
        // the subject in each, so a survivor names the lookup that did not run.
        for (battle_id, player, _, _) in anchor_only {
            let column = if player == v {
                "player_identity"
            } else {
                "opponent_identity"
            };
            let left: Vec<&str> = rows_of(battle_id)
                .into_iter()
                .map(|(table, _)| table)
                .collect();
            assert!(
                left.is_empty(),
                "[bt7/cascade-anchor-only] battle {battle_id} still holds rows in {left:?} — \
                 the subject is named ONLY by `battle.{column}`, so `erase_tactical_rows` \
                 must collect battle ids through that anchor index, while the anchor still \
                 names the subject (BEFORE `battle::anonymize_battles` swaps in the tombstone)"
            );
        }

        let after = per_battle_rows(&w);
        for ((table, was), (_, now)) in before.iter().zip(after.iter()) {
            let survivors: Vec<u64> = now
                .iter()
                .map(|(bid, _)| *bid)
                .filter(|bid| subject_battles.contains(bid))
                .collect();
            assert!(
                survivors.is_empty(),
                "[bt7/cascade-erase] `{table}` still holds rows of the subject's battles \
                 {survivors:?} — every tactical row of a battle the subject is (or was) a side \
                 of goes, found through the anchor chain AND every row still naming the subject"
            );
            let kept: Vec<&(u64, Vec<u8>)> = was
                .iter()
                .filter(|(bid, _)| !subject_battles.contains(bid))
                .collect();
            let now_refs: Vec<&(u64, Vec<u8>)> = now.iter().collect();
            assert_eq!(
                now_refs, kept,
                "[bt7/cascade-keep] `{table}`: every row of a battle WITHOUT the subject must be \
                 byte-identical after the cascade"
            );
        }

        assert_eq!(
            encs(&w.formation.rows()),
            encs(&[formation_row(b, 2)]),
            "[bt7/cascade-formation] the subject's formation goes, the bystander's survives"
        );

        let sides = |battle_id: u64| -> (Identity, Identity) {
            let rows: Vec<BattleSummary> = w
                .summary
                .rows()
                .into_iter()
                .filter(|s| s.battle_id == battle_id)
                .collect();
            assert_eq!(
                rows.len(),
                1,
                "[bt7/cascade-summary-survives] battle {battle_id}'s summary must survive, once"
            );
            (rows[0].player_identity, rows[0].opponent_identity)
        };
        for (battle_id, want) in [
            (2011, (tomb, b)),
            (2012, (b, tomb)),
            (2013, (tomb, wild)),
            (2014, (tomb, tomb)),
            (998, (tomb, b)),
            (2021, (b, x)),
            (2022, (x, b)),
            (2023, (b, wild)),
            (2024, (b, b)),
            (990, (b, x)),
        ] {
            assert_eq!(
                sides(battle_id),
                want,
                "[bt7/cascade-summary-sides] battle {battle_id}: exactly the subject's side(s) \
                 become the tombstone, every other side is untouched"
            );
        }
        let expected: Vec<BattleSummary> = summaries_before
            .into_iter()
            .map(|mut s| {
                if s.player_identity == v {
                    s.player_identity = tomb;
                }
                if s.opponent_identity == v {
                    s.opponent_identity = tomb;
                }
                s
            })
            .collect();
        assert_eq!(
            encs(&w.summary.rows()),
            encs(&expected),
            "[bt7/cascade-summary-rows] the summary rows survive with only the subject's \
             identity columns rewritten; every telemetry column is byte-identical and none is \
             deleted"
        );
    }

    /// BT7.4 — `complete_guest_claim` moves the guest's formation onto the
    /// claimer through `rekey_all`: afterwards exactly one row, under the
    /// claimer, with the guest's monster ids; none under the guest; a
    /// bystander's formation byte-identical.
    ///
    /// Kills: `rekey_formation` a no-op (the red-phase stub) or dropped from
    ///        `rekey_all`; a re-key that copies instead of moving (the guest
    ///        keeps a row); one that loses or rewrites the monster ids; one that
    ///        re-keys every formation (the bystander's moves).
    #[test]
    fn guest_claim_moves_the_formation_onto_the_claimer_bt7_4() {
        let fx = fixture();
        let w = world(&fx);
        let g = id(0x7E);
        let c = id(0x7F);
        let bystander = id(0x80);
        let secret = code('5');
        w.player.seed(&player_row(g, 1, "Guesty"));
        assert_eq!(
            fx.run_as_at(g, at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                secret.clone()
            )),
            Ok(())
        );
        assert_eq!(w.player.remove(g), 1, "the guest disconnects");
        let guest_formation = formation_row(g, 7);
        let bystander_formation = formation_row(bystander, 8);
        w.formation.seed(&guest_formation);
        w.formation.seed(&bystander_formation);
        w.account
            .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));

        assert_eq!(
            signed_in(&fx, c, T0 + 1_000, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Ok(()),
            "a destination with no game data completes the claim"
        );
        let of = |who: Identity| {
            encs(
                &w.formation
                    .rows()
                    .into_iter()
                    .filter(|r| r.owner_identity == who)
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(
            of(c),
            encs(&[PlayerFormation {
                owner_identity: c,
                monster_ids: guest_formation.monster_ids.clone(),
            }]),
            "[bt7/rekey-formation] the guest's formation arrives under the claimer, its monster \
             ids unchanged"
        );
        assert!(
            of(g).is_empty(),
            "[bt7/rekey-formation] no formation may stay under the retired guest identity"
        );
        assert_eq!(
            of(bystander),
            encs(&[bystander_formation]),
            "[bt7/rekey-formation] a bystander's formation never moves"
        );
        assert_eq!(w.formation.rows().len(), 2, "a move, not a copy");
    }

    /// The battles a guest leaves behind at claim time, all finished: `g`'s four battles
    /// against `p` (`seed_tactical_population`: `g` as side A, as side B, a wild battle and a
    /// practice battle, each with staging, plus `g`'s formation), `p`'s four against `x` (battles
    /// without `g`, plus `p`'s formation), battle 2031 that the CLAIMER `c` played against `g`,
    /// and two anchor-only battles in which nothing but the settled anchor names `g` (2035: `g`
    /// is `player_identity`; 2036: `opponent_identity`), each holding its tactical row, its
    /// secret and `p`'s deploy + clock rows. Returns the ids of every battle `g` was a side of.
    fn seed_guest_battles(
        w: &W<'_>,
        g: Identity,
        c: Identity,
        p: Identity,
        x: Identity,
    ) -> Vec<u64> {
        seed_tactical_population(w, g, p, 1);
        seed_tactical_population(w, p, x, 2);
        seed_tactical_battle(w, 2031, c, Some(g));
        seed_staging(w, 2031, c, Some(g));
        let anchor_only = [(2035, g, p, SideRow::B), (2036, p, g, SideRow::A)];
        for (battle_id, player, opponent, peer_side) in anchor_only {
            let mut anchor = battle_row(player, opponent);
            anchor.battle_id = battle_id;
            anchor.state.outcome = game_core::BattleOutcome::SideAWins;
            w.battle.seed(&anchor);
            w.tactical.seed(&tactical_row(battle_id, BattleKind::Pvp));
            w.secret.seed(&secret_row(battle_id));
            w.deploy.seed(&deploy_row(battle_id, peer_side, p));
            w.clock.seed(&clock_row(battle_id, peer_side, p));
        }
        vec![2011, 2012, 2013, 2014, 2031, 2035, 2036]
    }

    /// A completed guest claim leaves no `battle` or `battle_summary` row naming the retired
    /// guest: each row survives with the guest's column(s) holding the tombstone identity and
    /// the other side untouched (the claimer's side included), every summary telemetry column
    /// byte-identical; every per-battle tactical row of a battle the guest was a side of is
    /// gone, the other participant's rows included; every row of a battle without the guest is
    /// byte-identical. The claim's own effects still hold: the guest's formation arrives under
    /// the claimer and the code is spent.
    ///
    /// Kills: the claim writing nothing to the guest's battles; only the tactical erase run
    /// (the anchors still name the guest); only the anchor tombstone run (the
    /// tactical rows survive, the summaries name the guest); the tombstone run BEFORE the
    /// erase (the anchor-only battles 2035 / 2036 are then unreachable and keep their rows);
    /// either helper run BEFORE the re-key (the erase deletes the guest's formation, so none
    /// arrives under the claimer); the helpers run for the claimer instead of the guest (battle
    /// 2031's claimer side becomes the tombstone); the guest's battles re-keyed onto the claimer
    /// instead of tombstoned; a summary deleted or a telemetry column rewritten; a battle
    /// without the guest touched.
    #[test]
    fn guest_claim_tombstones_the_guests_terminal_battle_and_summary_rows() {
        let fx = fixture();
        let w = world(&fx);
        let g = id(0x91);
        let c = id(0x92);
        let p = id(0x93);
        let x = id(0x94);
        let tomb = crate::TOMBSTONE_IDENTITY;
        let wild = crate::WILD_IDENTITY;
        let secret = code('7');
        w.player.seed(&player_row(g, 1, "Guesty"));
        assert_eq!(
            fx.run_as_at(g, at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                secret.clone()
            )),
            Ok(())
        );
        assert_eq!(w.player.remove(g), 1, "the guest disconnects");
        w.account
            .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));
        let guest_battles = seed_guest_battles(&w, g, c, p, x);

        let before = per_battle_rows(&w);
        for (table, rows) in &before {
            assert!(
                rows.iter().any(|(bid, _)| guest_battles.contains(bid))
                    && rows.iter().any(|(bid, _)| !guest_battles.contains(bid)),
                "fixture: `{table}` must hold rows of the guest's battles AND of battles without \
                 it, or the erase and keep halves below are vacuous"
            );
        }
        let swap = |who: Identity| if who == g { tomb } else { who };
        let battles_want: Vec<crate::schema::Battle> = w
            .battle
            .rows()
            .into_iter()
            .map(|mut b| {
                b.player_identity = swap(b.player_identity);
                b.opponent_identity = swap(b.opponent_identity);
                b
            })
            .collect();
        let summaries_want: Vec<BattleSummary> = w
            .summary
            .rows()
            .into_iter()
            .map(|mut s| {
                s.player_identity = swap(s.player_identity);
                s.opponent_identity = swap(s.opponent_identity);
                s
            })
            .collect();
        let guest_formation = formation_row(g, 1);

        assert_eq!(
            signed_in(&fx, c, T0 + 1_000, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Ok(()),
            "a destination with no game data completes the claim of a guest whose battles are \
             all finished"
        );

        let after = per_battle_rows(&w);
        for ((table, was), (_, now)) in before.iter().zip(after.iter()) {
            let survivors: Vec<u64> = now
                .iter()
                .map(|(bid, _)| *bid)
                .filter(|bid| guest_battles.contains(bid))
                .collect();
            assert!(
                survivors.is_empty(),
                "[claim-erase] `{table}` still holds rows of the retired guest's battles \
                 {survivors:?}: every tactical row of a battle the guest was a side of goes, the \
                 other participant's included"
            );
            let kept: Vec<&(u64, Vec<u8>)> = was
                .iter()
                .filter(|(bid, _)| !guest_battles.contains(bid))
                .collect();
            let now_refs: Vec<&(u64, Vec<u8>)> = now.iter().collect();
            assert_eq!(
                now_refs, kept,
                "[claim-keep] `{table}`: every row of a battle without the guest must be \
                 byte-identical after the claim"
            );
        }

        let battle_sides = |battle_id: u64| -> Vec<(Identity, Identity)> {
            w.battle
                .rows()
                .into_iter()
                .filter(|b| b.battle_id == battle_id)
                .map(|b| (b.player_identity, b.opponent_identity))
                .collect()
        };
        let summary_sides = |battle_id: u64| -> Vec<(Identity, Identity)> {
            w.summary
                .rows()
                .into_iter()
                .filter(|s| s.battle_id == battle_id)
                .map(|s| (s.player_identity, s.opponent_identity))
                .collect()
        };
        for (battle_id, want, has_summary) in [
            (2011, (tomb, p), true),
            (2012, (p, tomb), true),
            (2013, (tomb, wild), true),
            (2014, (tomb, tomb), true),
            (2031, (c, tomb), true),
            (2035, (tomb, p), false),
            (2036, (p, tomb), false),
            (2021, (p, x), true),
            (2022, (x, p), true),
            (2023, (p, wild), true),
            (2024, (p, p), true),
        ] {
            assert_eq!(
                battle_sides(battle_id),
                vec![want],
                "[claim-battle-sides] battle {battle_id}'s anchor survives once, with exactly the \
                 retired guest's side(s) holding the tombstone and every other side untouched"
            );
            let summary_want = if has_summary { vec![want] } else { vec![] };
            assert_eq!(
                summary_sides(battle_id),
                summary_want,
                "[claim-summary-sides] battle {battle_id}'s summary survives once, with exactly \
                 the retired guest's side(s) holding the tombstone and every other side untouched"
            );
        }
        assert_eq!(
            encs(&w.battle.rows()),
            encs(&battles_want),
            "[claim-battle-rows] the battle rows survive with only the guest's identity columns \
             rewritten; nothing else in any row changes and none is deleted"
        );
        assert_eq!(
            encs(&w.summary.rows()),
            encs(&summaries_want),
            "[claim-summary-rows] the summary rows survive with only the guest's identity columns \
             rewritten; every telemetry column is byte-identical and none is deleted"
        );

        let formations_of = |who: Identity| {
            encs(
                &w.formation
                    .rows()
                    .into_iter()
                    .filter(|r| r.owner_identity == who)
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(
            formations_of(c),
            encs(&[PlayerFormation {
                owner_identity: c,
                monster_ids: guest_formation.monster_ids.clone(),
            }]),
            "[claim-formation] the guest's formation still arrives under the claimer"
        );
        assert!(
            formations_of(g).is_empty(),
            "[claim-formation] no formation stays under the retired guest"
        );
        assert_eq!(
            formations_of(p),
            encs(&[formation_row(p, 2)]),
            "[claim-formation] a bystander's formation never moves"
        );
        assert!(
            w.claim.rows().is_empty(),
            "[claim-spent] the claim code is consumed"
        );
        let claimed_from = w
            .account
            .rows()
            .into_iter()
            .find(|a| a.identity == c)
            .and_then(|a| a.claimed_from);
        assert_eq!(
            claimed_from,
            Some(g),
            "[claim-spent] the claimer's account records the claimed guest"
        );
    }

    /// A refused guest claim writes nothing to the guest's battles: with the same finished
    /// battles seeded, a claim refused because the destination already plays (guard 11, the
    /// last guard) leaves every `battle`, `battle_summary`, per-battle tactical and formation
    /// row byte-identical and the code unspent.
    ///
    /// Kills: the erase or the tombstone run above the claim's guards (this host keeps a
    /// refused reducer's writes, so a write before the refusal stays visible).
    #[test]
    fn a_refused_guest_claim_leaves_the_guests_battle_rows_untouched() {
        let fx = fixture();
        let w = world(&fx);
        let g = id(0x95);
        let c = id(0x96);
        let p = id(0x97);
        let x = id(0x98);
        let secret = code('8');
        w.player.seed(&player_row(g, 1, "Guesty"));
        assert_eq!(
            fx.run_as_at(g, at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                secret.clone()
            )),
            Ok(())
        );
        assert_eq!(w.player.remove(g), 1, "the guest disconnects");
        w.account
            .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));
        w.formation.seed(&formation_row(c, 9));
        seed_guest_battles(&w, g, c, p, x);
        let snapshot = |w: &W<'_>| {
            (
                per_battle_rows(w),
                encs(&w.battle.rows()),
                encs(&w.summary.rows()),
                encs(&w.formation.rows()),
                encs(&w.claim.rows()),
            )
        };
        let before = snapshot(&w);

        assert_eq!(
            signed_in(&fx, c, T0 + 1_000, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Err("already has game data".to_string()),
            "a destination that already plays is refused"
        );
        assert!(
            snapshot(&w) == before,
            "[claim-refused] a refused claim wrote to the guest's battle, summary, tactical, \
             formation or claim rows"
        );
    }

    /// A guest who only ever accepted challenges — `opponent_identity` in every `battle` and
    /// `battle_summary` row that names it, `player_identity` in none — and who holds an export
    /// chunk at claim time: a completed claim leaves no `battle` or `battle_summary` row naming
    /// it (each survives with the guest's side holding the tombstone identity, the other side
    /// untouched, the claimer's included), erases every per-battle tactical row of those
    /// battles (the guest's own unit, queue, deploy and clock rows among them), keeps every row
    /// of a bystander's battles byte-identical and purges the guest's export chunks.
    ///
    /// Kills: the erase and the tombstone run only when some battle names the guest as
    /// `player_identity` (no row here does, so every row keeps naming the guest); the erase
    /// and the tombstone run only when the export purge deleted nothing (the guest's chunk
    /// makes that count non-zero).
    #[test]
    fn guest_claim_tombstones_an_opponent_only_guest_who_holds_an_export() {
        let fx = fixture();
        let w = world(&fx);
        let g = id(0x99);
        let c = id(0x9A);
        let p = id(0x9B);
        let x = id(0x9C);
        let tomb = crate::TOMBSTONE_IDENTITY;
        let secret = code('9');
        w.player.seed(&player_row(g, 1, "Guesty"));
        assert_eq!(
            fx.run_as_at(g, at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                secret.clone()
            )),
            Ok(())
        );
        assert_eq!(w.player.remove(g), 1, "the guest disconnects");
        w.account
            .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));

        // The guest's battles: side B of two PvP battles `p` opened and of one the claimer
        // opened, each with its staging (the guest's side-B units, plan, deploy and clock),
        // plus an anchor-only battle in which the guest is the opponent.
        for (battle_id, side_a) in [(2051, p), (2052, p), (2053, c)] {
            seed_tactical_battle(&w, battle_id, side_a, Some(g));
            seed_staging(&w, battle_id, side_a, Some(g));
        }
        let mut anchor = battle_row(p, g);
        anchor.battle_id = 2056;
        anchor.state.outcome = game_core::BattleOutcome::SideAWins;
        w.battle.seed(&anchor);
        w.tactical.seed(&tactical_row(2056, BattleKind::Pvp));
        w.secret.seed(&secret_row(2056));
        w.deploy.seed(&deploy_row(2056, SideRow::A, p));
        w.clock.seed(&clock_row(2056, SideRow::A, p));
        let guest_battles: [u64; 4] = [2051, 2052, 2053, 2056];
        // A bystander's battles: a PvP battle without the guest and a wild one.
        seed_tactical_battle(&w, 2061, p, Some(x));
        seed_staging(&w, 2061, p, Some(x));
        seed_tactical_battle(&w, 2063, x, None);
        seed_staging(&w, 2063, x, None);
        let bystander_battles: [u64; 2] = [2061, 2063];
        w.export.seed(&export_row(1, g, T0 - 5));
        w.export.seed(&export_row(2, x, T0 - 5));

        assert!(
            w.battle.rows().iter().all(|b| b.player_identity != g)
                && w.summary.rows().iter().all(|s| s.player_identity != g),
            "fixture: the guest must be `player_identity` in no battle or summary row"
        );
        let mut battles_naming_guest: Vec<u64> = w
            .battle
            .rows()
            .iter()
            .filter(|b| b.opponent_identity == g)
            .map(|b| b.battle_id)
            .collect();
        battles_naming_guest.sort_unstable();
        assert_eq!(
            battles_naming_guest, guest_battles,
            "fixture: the guest is the opponent in exactly its four battles"
        );
        assert_eq!(
            w.summary
                .rows()
                .iter()
                .filter(|s| s.opponent_identity == g)
                .count(),
            3,
            "fixture: the guest is the opponent in its three summarised battles"
        );
        assert!(
            w.unit.rows().iter().any(|u| u.owner == Some(g))
                && w.queue.rows().iter().any(|q| q.owner == g)
                && w.deploy.rows().iter().any(|d| d.owner == g)
                && w.clock.rows().iter().any(|k| k.player == g),
            "fixture: the guest must own unit, queue, deploy and clock rows, or the erase \
             half below is vacuous"
        );
        assert!(
            w.export.rows().iter().any(|e| e.owner_identity == g),
            "fixture: the guest must hold an export chunk at claim time"
        );
        let before = per_battle_rows(&w);
        for (table, rows) in &before {
            if *table != "battle_wild_unit" {
                assert!(
                    rows.iter().any(|(bid, _)| guest_battles.contains(bid)),
                    "fixture: `{table}` must hold rows of the guest's battles"
                );
            }
            assert!(
                rows.iter().any(|(bid, _)| bystander_battles.contains(bid)),
                "fixture: `{table}` must hold rows of a bystander's battle"
            );
        }
        let swap = |who: Identity| if who == g { tomb } else { who };
        let battles_want: Vec<crate::schema::Battle> = w
            .battle
            .rows()
            .into_iter()
            .map(|mut b| {
                b.player_identity = swap(b.player_identity);
                b.opponent_identity = swap(b.opponent_identity);
                b
            })
            .collect();
        let summaries_want: Vec<BattleSummary> = w
            .summary
            .rows()
            .into_iter()
            .map(|mut s| {
                s.player_identity = swap(s.player_identity);
                s.opponent_identity = swap(s.opponent_identity);
                s
            })
            .collect();
        let bystander_battle_rows = |w: &W<'_>| {
            encs(
                &w.battle
                    .rows()
                    .into_iter()
                    .filter(|b| bystander_battles.contains(&b.battle_id))
                    .collect::<Vec<_>>(),
            )
        };
        let bystander_before = bystander_battle_rows(&w);
        let bystander_export = encs(
            &w.export
                .rows()
                .into_iter()
                .filter(|e| e.owner_identity == x)
                .collect::<Vec<_>>(),
        );

        assert_eq!(
            signed_in(&fx, c, T0 + 1_000, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Ok(()),
            "a destination with no game data completes the claim of an opponent-only guest"
        );

        let battles_naming: Vec<u64> = w
            .battle
            .rows()
            .iter()
            .filter(|b| b.player_identity == g || b.opponent_identity == g)
            .map(|b| b.battle_id)
            .collect();
        assert!(
            battles_naming.is_empty(),
            "[claim-opponent-only] battles {battles_naming:?} still name the retired guest, who \
             was only ever their opponent and held an export chunk at claim time"
        );
        let summaries_naming: Vec<u64> = w
            .summary
            .rows()
            .iter()
            .filter(|s| s.player_identity == g || s.opponent_identity == g)
            .map(|s| s.battle_id)
            .collect();
        assert!(
            summaries_naming.is_empty(),
            "[claim-opponent-only] summaries {summaries_naming:?} still name the retired guest"
        );
        for (battle_id, side_a) in [(2051, p), (2052, p), (2053, c), (2056, p)] {
            let sides: Vec<(Identity, Identity)> = w
                .battle
                .rows()
                .into_iter()
                .filter(|b| b.battle_id == battle_id)
                .map(|b| (b.player_identity, b.opponent_identity))
                .collect();
            assert_eq!(
                sides,
                vec![(side_a, tomb)],
                "[claim-opponent-only] battle {battle_id}'s anchor survives once, the guest's \
                 side holding the tombstone and side A untouched"
            );
        }
        assert_eq!(
            encs(&w.battle.rows()),
            encs(&battles_want),
            "[claim-opponent-only] the battle rows survive with only the guest's column \
             rewritten to the tombstone"
        );
        assert_eq!(
            encs(&w.summary.rows()),
            encs(&summaries_want),
            "[claim-opponent-only] the summary rows survive with only the guest's column \
             rewritten to the tombstone"
        );

        let after = per_battle_rows(&w);
        for ((table, was), (_, now)) in before.iter().zip(after.iter()) {
            let survivors: Vec<u64> = now
                .iter()
                .map(|(bid, _)| *bid)
                .filter(|bid| guest_battles.contains(bid))
                .collect();
            assert!(
                survivors.is_empty(),
                "[claim-opponent-only] `{table}` still holds rows of the retired guest's battles \
                 {survivors:?}"
            );
            let kept: Vec<&(u64, Vec<u8>)> = was
                .iter()
                .filter(|(bid, _)| !guest_battles.contains(bid))
                .collect();
            let now_refs: Vec<&(u64, Vec<u8>)> = now.iter().collect();
            assert_eq!(
                now_refs, kept,
                "[claim-opponent-only] `{table}`: every row of a bystander's battle must be \
                 byte-identical after the claim"
            );
        }
        assert_eq!(
            bystander_battle_rows(&w),
            bystander_before,
            "[claim-opponent-only] a bystander's battle rows are byte-identical"
        );

        assert!(
            w.export.rows().iter().all(|e| e.owner_identity != g),
            "[claim-opponent-only] the guest's export chunks are purged"
        );
        assert_eq!(
            encs(&w.export.rows()),
            bystander_export,
            "[claim-opponent-only] a bystander's export chunk is untouched"
        );
        assert!(
            w.claim.rows().is_empty(),
            "[claim-opponent-only] the claim code is consumed"
        );
    }

    /// BT7.4 — a `player_formation` row is game data: `account_has_game_data`
    /// is true for an identity whose ONLY row is a formation and false again
    /// once it is gone; a stranger's formation is not the caller's data; and
    /// through the claim guard (AUTH-20) a destination whose only row is a
    /// formation is refused with nothing moved and the code unspent.
    ///
    /// Kills: `has_formation` constant false (the red-phase stub) or dropped
    ///        from `account_has_game_data` (a claim would overwrite a
    ///        destination that already plays); `has_formation` answering for
    ///        ANY row (the stranger case) or keyed on the wrong column.
    #[test]
    fn a_lone_formation_row_counts_as_game_data_bt7_4() {
        let fx = fixture();
        let w = world(&fx);
        let g = id(0x81);
        let stranger = id(0x82);
        let has =
            |who: Identity| fx.run_as(who, |ctx| crate::accounts::account_has_game_data(ctx, who));
        assert!(!has(g), "an identity with no rows has no game data");
        w.formation.seed(&formation_row(stranger, 1));
        assert!(
            has(stranger),
            "[bt7/formation-game-data] a lone formation row is game data"
        );
        assert!(
            !has(g),
            "[bt7/formation-game-data] a stranger's formation is not g's game data"
        );
        w.formation.seed(&formation_row(g, 2));
        assert!(
            has(g),
            "[bt7/formation-game-data] g's lone formation row is game data"
        );
        assert_eq!(w.formation.remove(g), 1);
        assert!(!has(g), "no formation, no game data");

        let guest = id(0x83);
        let claimer = id(0x84);
        let secret = code('6');
        w.player.seed(&player_row(guest, 1, "Guesty"));
        assert_eq!(
            fx.run_as_at(guest, at(T0), |ctx| crate::accounts::start_guest_claim(
                ctx,
                secret.clone()
            )),
            Ok(())
        );
        assert_eq!(w.player.remove(guest), 1, "the guest disconnects");
        w.account.seed(&crate::accounts::new_account_row(
            claimer,
            "i".to_string(),
            1,
        ));
        w.formation.seed(&formation_row(claimer, 9));
        let formations_before = encs(&w.formation.rows());
        assert_eq!(
            signed_in(&fx, claimer, T0 + 10, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            }),
            Err("already has game data".to_string()),
            "[bt7/formation-claim-guard] a destination whose only row is a formation already \
             plays: the claim must be refused"
        );
        assert_eq!(
            encs(&w.formation.rows()),
            formations_before,
            "a refused claim moves no formation"
        );
        assert_eq!(
            w.claim.rows().len(),
            1,
            "a refused claim does not spend the code"
        );
    }

    // =======================================================================
    // TRADE SESSIONS UNDER ACCOUNT DELETION AND THE GUEST CLAIM:
    // the cancel declines post-request incoming sessions, the deletion reaper
    // erases sessions in both roles, the confirm stamp gate, and the claim
    // deletes the claimer's sessions. Every session delete takes the
    // session's snapshot rows and reaper-schedule row with it.
    // =======================================================================

    /// An open session `session_id` from `opener` to `partner`, stamped
    /// `created_at_ms`, both offers blank and neither side confirmed.
    fn session_row(
        session_id: u64,
        opener: Identity,
        partner: Identity,
        created_at_ms: i64,
    ) -> TradeSession {
        TradeSession {
            session_id,
            opener,
            partner,
            opener_offer: game_core::trading::TradeSessionOffer::default(),
            partner_offer: game_core::trading::TradeSessionOffer::default(),
            opener_confirmed: false,
            partner_confirmed: false,
            revision: 3,
            created_at_ms,
        }
    }

    /// The snapshot row `snapshot_id` of `m` in session `session_id`, every
    /// column copied from the live row. The drift rule compares the MASKED
    /// forms of both sides, so this row matches its live monster exactly as a
    /// stored masked snapshot does.
    fn snapshot_row(snapshot_id: u64, session_id: u64, m: &Monster) -> TradeSessionSnapshot {
        TradeSessionSnapshot {
            snapshot_id,
            session_id,
            monster_id: m.monster_id,
            species_id: m.species_id,
            nickname: m.nickname.clone(),
            level: m.level,
            xp: m.xp,
            iv_hp: m.iv_hp,
            iv_attack: m.iv_attack,
            iv_defense: m.iv_defense,
            iv_speed: m.iv_speed,
            iv_sp_attack: m.iv_sp_attack,
            iv_sp_defense: m.iv_sp_defense,
            nature_kind: m.nature_kind,
            ev_hp: m.ev_hp,
            ev_attack: m.ev_attack,
            ev_defense: m.ev_defense,
            ev_speed: m.ev_speed,
            ev_sp_attack: m.ev_sp_attack,
            ev_sp_defense: m.ev_sp_defense,
            stat_hp: m.stat_hp,
            stat_attack: m.stat_attack,
            stat_defense: m.stat_defense,
            stat_speed: m.stat_speed,
            stat_sp_attack: m.stat_sp_attack,
            stat_sp_defense: m.stat_sp_defense,
            current_hp: m.current_hp,
            party_slot: m.party_slot,
            last_care_at_ms: m.last_care_at_ms,
            essence_fire: m.essence_fire,
            essence_water: m.essence_water,
            essence_plant: m.essence_plant,
            essence_electric: m.essence_electric,
            essence_earth: m.essence_earth,
            essence_wind: m.essence_wind,
            essence_light: m.essence_light,
            essence_dark: m.essence_dark,
            trust_favorable_count: m.trust_favorable_count,
            trust_unfavorable_count: m.trust_unfavorable_count,
            trust_favorable_battle_day_epoch: m.trust_favorable_battle_day_epoch,
            quality_time_ticks_total: m.quality_time_ticks_total,
            quality_time_accum_ms: m.quality_time_accum_ms,
            quality_time_window_ms: m.quality_time_window_ms,
            quality_time_window_start_ms: m.quality_time_window_start_ms,
            last_essence_train_at_ms: m.last_essence_train_at_ms,
        }
    }

    /// The standard snapshot child of a fixture session: one row for a
    /// monster of the opener's, keyed off the session id.
    fn session_snapshot(s: &TradeSession) -> TradeSessionSnapshot {
        let m = monster_row(s.session_id * 10 + 1, s.opener);
        snapshot_row(s.session_id * 10 + 1, s.session_id, &m)
    }

    /// The reaper-schedule child of a fixture session, armed at its TTL.
    fn session_schedule(s: &TradeSession) -> TradeSessionReaperSchedule {
        TradeSessionReaperSchedule {
            scheduled_id: s.session_id * 10 + 2,
            scheduled_at: ScheduleAt::Time(at(
                s.created_at_ms + game_core::trading::TRADE_SESSION_TTL_MS
            )),
            session_id: s.session_id,
        }
    }

    /// Seed a session together with its snapshot row and its schedule row.
    fn seed_session(w: &W<'_>, s: &TradeSession) {
        w.trade_session.seed(s);
        w.trade_snapshot.seed(&session_snapshot(s));
        w.trade_session_reaper.seed(&session_schedule(s));
    }

    fn sorted_ids(mut ids: Vec<u64>) -> Vec<u64> {
        ids.sort_unstable();
        ids
    }

    /// The three session tables hold EXACTLY `want` (fixture sessions seeded
    /// with `seed_session`) and their children, byte-identical: a session not
    /// in `want` is gone together with its snapshot and schedule rows, and
    /// every session in `want` is untouched.
    fn assert_sessions_exactly(w: &W<'_>, want: &[&TradeSession], label: &str) {
        let want_ids = sorted_ids(want.iter().map(|s| s.session_id).collect());
        assert_eq!(
            sorted_ids(
                w.trade_session
                    .rows()
                    .iter()
                    .map(|r| r.session_id)
                    .collect()
            ),
            want_ids,
            "[{label}] the live trade sessions"
        );
        assert_eq!(
            sorted_ids(
                w.trade_snapshot
                    .rows()
                    .iter()
                    .map(|r| r.session_id)
                    .collect()
            ),
            want_ids,
            "[{label}] snapshot rows: a deleted session's snapshot goes with it and a surviving \
             session keeps its own"
        );
        assert_eq!(
            sorted_ids(
                w.trade_session_reaper
                    .rows()
                    .iter()
                    .map(|r| r.session_id)
                    .collect()
            ),
            want_ids,
            "[{label}] reaper-schedule rows: a deleted session is disarmed and a surviving \
             session stays armed"
        );
        let sessions: Vec<TradeSession> = want.iter().copied().cloned().collect();
        assert_eq!(
            encs(&w.trade_session.rows()),
            encs(&sessions),
            "[{label}] every surviving session row is byte-identical"
        );
        let snapshots: Vec<TradeSessionSnapshot> =
            want.iter().copied().map(session_snapshot).collect();
        assert_eq!(
            encs(&w.trade_snapshot.rows()),
            encs(&snapshots),
            "[{label}] every surviving snapshot row is byte-identical"
        );
        let schedules: Vec<TradeSessionReaperSchedule> =
            want.iter().copied().map(session_schedule).collect();
        assert_eq!(
            encs(&w.trade_session_reaper.rows()),
            encs(&schedules),
            "[{label}] every surviving schedule row is byte-identical"
        );
    }

    /// `cancel_account_deletion` declines exactly the canceller's
    /// incoming sessions that the deletion stamp gate refuses: sessions where
    /// the canceller is the PARTNER and that were created at or after the
    /// deletion request (the boundary is inclusive — a session stamped in the
    /// request millisecond does not predate it). Each declined session goes
    /// with its snapshot and schedule rows. A pre-request incoming session, a
    /// session the canceller opened and two strangers' session survive
    /// byte-identical, and the account ends `Active`. The read half composes
    /// with the policy: `open_sessions_addressed_to` returns exactly the
    /// `(session_id, created_at_ms)` pairs of the sessions addressed to the
    /// canceller, and `plan_declines_at_cancel` over them names the two
    /// post-request ones.
    ///
    /// Kills: the decline call missing from the cancel (every session
    /// survives); a decline made after the status write (an `Active` row
    /// refuses nothing); an exclusive boundary (the request-millisecond
    /// session survives); declining every incoming session regardless of
    /// stamp (the pre-request one goes); declining by the opener column too or
    /// by both roles (the canceller's own session goes); a decline that skips
    /// the snapshot or schedule rows; a reader that also returns the sessions
    /// the canceller opened or strangers' sessions.
    #[test]
    fn ts2_deletion_cancel_declines_post_request_incoming_sessions() {
        let fx = fixture();
        let w = world(&fx);
        let a = id(0xA1);
        let (b, c, d, e) = (id(0xA2), id(0xA3), id(0xA4), id(0xA5));
        let requested = T0;
        let active = crate::accounts::new_account_row(a, "i".to_string(), 1);
        let pending = crate::accounts::requested_deletion(active.clone(), requested);
        w.account.seed(&pending);

        let post_incoming = session_row(7101, b, a, requested + 1);
        let at_request = session_row(7102, c, a, requested);
        let pre_incoming = session_row(7103, d, a, requested - 1);
        let opened_by_a = session_row(7104, a, e, requested - 1);
        let strangers = session_row(7105, d, e, requested + 5);
        for s in [
            &post_incoming,
            &at_request,
            &pre_incoming,
            &opened_by_a,
            &strangers,
        ] {
            seed_session(&w, s);
        }

        let addressed = fx.run_as(a, |ctx| {
            crate::trading_session::open_sessions_addressed_to(ctx, a)
        });
        let mut addressed_sorted = addressed.clone();
        addressed_sorted.sort_unstable();
        assert_eq!(
            addressed_sorted,
            vec![
                (7101, requested + 1),
                (7102, requested),
                (7103, requested - 1)
            ],
            "[ts2/addressed-to] exactly the sessions where the canceller is the partner, as \
             (session_id, created_at_ms) — never one it opened, never a stranger's"
        );
        let mut planned = crate::accounts::plan_declines_at_cancel(&pending, &addressed);
        planned.sort_unstable();
        assert_eq!(
            planned,
            vec![7101, 7102],
            "[ts2/plan-declines] the stamp policy refuses the post-request and the \
             request-millisecond sessions, and keeps the pre-request one"
        );

        assert_eq!(
            signed_in(
                &fx,
                a,
                requested + 100,
                crate::accounts::cancel_account_deletion
            ),
            Ok(())
        );
        let live: Vec<u64> = w
            .trade_session
            .rows()
            .iter()
            .map(|r| r.session_id)
            .collect();
        assert!(
            !live.contains(&7101) && !live.contains(&7102),
            "[ts2/cancel-declines] the post-request incoming sessions are declined; live: {live:?}"
        );
        assert_sessions_exactly(
            &w,
            &[&pre_incoming, &opened_by_a, &strangers],
            "ts2/cancel-declines",
        );
        assert_eq!(
            encs(
                &w.account
                    .rows()
                    .into_iter()
                    .filter(|r| r.identity == a)
                    .collect::<Vec<_>>()
            ),
            encs(&[active]),
            "the cancel restores Active"
        );
    }

    /// The deletion reaper's cascade erases every session naming the
    /// subject, as opener and as partner, each with its snapshot and schedule
    /// rows; a strangers' session and the subject's peer's session with a
    /// third player survive byte-identical, and the account ends terminal.
    /// Driven through the shipped `account_deletion_reaper` at the grace end.
    ///
    /// Kills: no session sweep in the cascade (both of the subject's
    /// sessions survive); a sweep over one role only (the other survives); a
    /// sweep keyed on the peer or deleting every session (the survivors go); a
    /// sweep that leaves the snapshot or schedule rows behind.
    #[test]
    fn ts2_deletion_reaper_erases_sessions_in_both_roles() {
        let fx = fixture();
        let w = world(&fx);
        let v = id(0xB1);
        let (peer, x, y) = (id(0xB2), id(0xB3), id(0xB4));
        let requested = T0;
        let pending = crate::accounts::requested_deletion(
            crate::accounts::new_account_row(v, "iss".to_string(), 1),
            requested,
        );
        w.account.seed(&pending);
        let as_opener = session_row(7201, v, peer, requested - 50);
        let as_partner = session_row(7202, peer, v, requested + 50);
        let strangers = session_row(7203, x, y, requested);
        let peer_elsewhere = session_row(7204, peer, x, requested + 60);
        for s in [&as_opener, &as_partner, &strangers, &peer_elsewhere] {
            seed_session(&w, s);
        }
        let grace_end = crate::accounts::deletion_fire_at_ms(requested);

        let got = fx.run_as_at(scheduler(), at(grace_end), |ctx| {
            crate::accounts::account_deletion_reaper(
                ctx,
                AccountDeletionReaperSchedule {
                    scheduled_id: 1,
                    scheduled_at: ScheduleAt::Time(at(grace_end)),
                    account_identity: v,
                },
            )
        });
        assert_eq!(got, Ok(()));
        assert_eq!(
            encs(
                &w.account
                    .rows()
                    .into_iter()
                    .filter(|r| r.identity == v)
                    .collect::<Vec<_>>()
            ),
            encs(&[crate::accounts::terminal_account(
                crate::accounts::anonymized_account(pending),
                grace_end
            )]),
            "the due tick ran the cascade"
        );
        let names_v: Vec<u64> = w
            .trade_session
            .rows()
            .iter()
            .filter(|r| r.opener == v || r.partner == v)
            .map(|r| r.session_id)
            .collect();
        assert!(
            names_v.is_empty(),
            "[ts2/reaper-erases] no session may name the erased identity in either role; \
             still live: {names_v:?}"
        );
        assert_sessions_exactly(&w, &[&strangers, &peer_elsewhere], "ts2/reaper-erases");
    }

    /// The confirm stamp gate and the other session reducers for a
    /// deletion-gated caller (request stamp T). `confirm_trade_session` on a
    /// session created after T is refused with the deletion-gate reason and
    /// writes nothing; `set_trade_offer` and `open_trade_session` are refused
    /// with the same reason and write nothing. On a session created before T
    /// the gate does not fire: the fixture makes that confirm otherwise valid
    /// (the caller offers a party monster at full HP with a matching snapshot
    /// row and keeps a second monster; the partner offers currency backed by
    /// a wallet), so it is RECORDED — the caller's flag is set, the revision
    /// and every other column unchanged. `cancel_trade_session` is not gated:
    /// the gated caller cancels the post-request session, which goes with its
    /// snapshot and schedule rows. No partner account is seeded: no reducer
    /// may read the partner's deletion state.
    ///
    /// Kills: the stamp gate missing from the confirm (the post-request
    /// confirm is recorded); a blanket `require_not_deleting` on the confirm
    /// (the pre-request confirm is refused); the gate on set or open missing;
    /// a gate on cancel (the gated caller cannot leave the session); a cancel
    /// that leaves the snapshot or schedule row behind.
    #[test]
    fn ts2_deletion_gated_caller_cannot_confirm_post_request_session() {
        let fx = fixture();
        let w = world(&fx);
        let a = id(0xC1);
        let (b, c, d) = (id(0xC2), id(0xC3), id(0xC4));
        let requested = T0;
        w.account.seed(&crate::accounts::requested_deletion(
            crate::accounts::new_account_row(a, "i".to_string(), 1),
            requested,
        ));
        w.player.seed(&player_row(a, 901, "A"));
        let offered = monster_row(7311, a);
        let mut kept = monster_row(7312, a);
        kept.party_slot = 1;
        w.monster.seed(&offered);
        w.monster.seed(&kept);
        w.wallet.seed(&PlayerWallet {
            owner_identity: a,
            balance: 10,
        });
        w.wallet.seed(&PlayerWallet {
            owner_identity: b,
            balance: 500,
        });

        let mut pre = session_row(7301, a, b, requested - 1);
        pre.opener_offer.monster_ids = vec![7311];
        pre.partner_offer.currency = 100;
        pre.revision = 4;
        let pre_snapshot = snapshot_row(73_011, 7301, &offered);
        let pre_schedule = session_schedule(&pre);
        w.trade_session.seed(&pre);
        w.trade_snapshot.seed(&pre_snapshot);
        w.trade_session_reaper.seed(&pre_schedule);

        let mut post = session_row(7302, a, c, requested + 1);
        post.partner_offer.currency = 50;
        seed_session(&w, &post);

        let gated = Err(crate::guards::REJECT_DELETION_GATED.to_string());
        let session_tables = [
            "trade_session",
            "trade_session_snapshot",
            "trade_session_reaper_schedule",
        ];
        let rows_now = |w: &W<'_>| {
            (
                encs(&w.trade_session.rows()),
                encs(&w.trade_snapshot.rows()),
                encs(&w.trade_session_reaper.rows()),
            )
        };
        let before = rows_now(&w);
        fx.reset_writes();

        assert_eq!(
            fx.run_as_at(a, at(requested + 10), |ctx| {
                crate::trading_session::confirm_trade_session(ctx, 7302, post.revision)
            }),
            gated,
            "[ts2/confirm-gated] a deletion-gated caller may not confirm a session created \
             after their request"
        );
        assert_eq!(
            fx.run_as_at(a, at(requested + 10), |ctx| {
                crate::trading_session::set_trade_offer(ctx, 7301, vec![7312], vec![], 0)
            }),
            gated,
            "[ts2/edit-gated] an edit is a new commitment"
        );
        assert_eq!(
            fx.run_as_at(a, at(requested + 10), |ctx| {
                crate::trading_session::open_trade_session(ctx, d)
            }),
            gated,
            "[ts2/open-gated] opening is a new commitment"
        );
        for table in session_tables {
            assert_eq!(
                fx.writes_to(table),
                0,
                "[ts2/gated-writes-nothing] a refused call writes no `{table}` row"
            );
        }
        assert_eq!(
            rows_now(&w),
            before,
            "[ts2/gated-writes-nothing] the session tables are unchanged"
        );

        assert_eq!(
            fx.run_as_at(a, at(requested + 10), |ctx| {
                crate::trading_session::confirm_trade_session(ctx, 7301, 4)
            }),
            Ok(()),
            "[ts2/confirm-pre-request] a session that predates the request stays completable"
        );
        let mut recorded = pre.clone();
        recorded.opener_confirmed = true;
        let live_pre: Vec<TradeSession> = w
            .trade_session
            .rows()
            .into_iter()
            .filter(|r| r.session_id == 7301)
            .collect();
        assert_eq!(
            encs(&live_pre),
            encs(std::slice::from_ref(&recorded)),
            "[ts2/confirm-pre-request] the caller's confirm is recorded: its flag set, the \
             partner's flag, the revision and both offers unchanged"
        );

        assert_eq!(
            fx.run_as_at(a, at(requested + 20), |ctx| {
                crate::trading_session::cancel_trade_session(ctx, 7302)
            }),
            Ok(()),
            "[ts2/cancel-ungated] a deletion-gated participant can always cancel"
        );
        assert_eq!(
            encs(&w.trade_session.rows()),
            encs(&[recorded]),
            "[ts2/cancel-ungated] the cancelled session is gone; the other one is untouched"
        );
        assert_eq!(
            encs(&w.trade_snapshot.rows()),
            encs(&[pre_snapshot]),
            "[ts2/cancel-ungated] the cancelled session's snapshot row goes with it"
        );
        assert_eq!(
            encs(&w.trade_session_reaper.rows()),
            encs(&[pre_schedule]),
            "[ts2/cancel-ungated] the cancelled session's schedule row goes with it"
        );
    }

    /// The guest claim's `rekey_all` deletes every session naming
    /// the guest (`from`) or the claimer (`to`), in either role, with
    /// its snapshot and schedule rows; a strangers' session survives
    /// byte-identical. The guest's sessions list none of the guest's
    /// monsters, so the monster re-key hook cannot be what removes them.
    /// Sessions are never re-keyed (`NOT_REKEYED`).
    ///
    /// Kills: no session delete in `rekey_all`; a delete for only one of the
    /// two identities (the guest's currency-only sessions would survive under
    /// a dead identity and block that pair until the TTL); a delete over one
    /// role only; a delete keyed on every session (the strangers' goes); a
    /// delete that leaves the snapshot or schedule rows behind.
    #[test]
    fn ts2_deletion_claim_deletes_claimer_sessions() {
        let fx = fixture();
        let w = world(&fx);
        let guest = id(0xD1);
        let claimer = id(0xD2);
        let (x, y) = (id(0xD3), id(0xD4));
        let claimer_opened = session_row(7401, claimer, x, T0);
        let claimer_partner = session_row(7402, y, claimer, T0 + 1);
        let strangers = session_row(7403, x, y, T0 + 2);
        // The guest's sessions offer currency only on the guest's side, so no
        // monster re-key can be what removes them.
        let mut guest_opened = session_row(7404, guest, x, T0 + 3);
        guest_opened.opener_offer.currency = 25;
        let mut guest_partner = session_row(7405, y, guest, T0 + 4);
        guest_partner.partner_offer.currency = 40;
        for s in [
            &claimer_opened,
            &claimer_partner,
            &strangers,
            &guest_opened,
            &guest_partner,
        ] {
            seed_session(&w, s);
        }

        assert_eq!(
            fx.run_as(claimer, |ctx| crate::accounts::rekey_all(
                ctx, guest, claimer
            )),
            Ok(())
        );
        let names_guest: Vec<u64> = w
            .trade_session
            .rows()
            .iter()
            .filter(|r| r.opener == guest || r.partner == guest)
            .map(|r| r.session_id)
            .collect();
        assert!(
            names_guest.is_empty(),
            "[ts2/claim-deletes] the claim deletes every session naming the retired guest, \
             including ones listing no monster; still live: {names_guest:?}"
        );
        let names_claimer: Vec<u64> = w
            .trade_session
            .rows()
            .iter()
            .filter(|r| r.opener == claimer || r.partner == claimer)
            .map(|r| r.session_id)
            .collect();
        assert!(
            names_claimer.is_empty(),
            "[ts2/claim-deletes] the claim deletes every session naming the claimer; still \
             live: {names_claimer:?}"
        );
        assert_sessions_exactly(&w, &[&strangers], "ts2/claim-deletes");
    }

    // --- the world's admission and binding rows across the claim and the cascade ----

    mod world_rows {
        use super::*;
        use crate::schema::{Config, WorldAccess, WorldAccessRule, WorldAllowlist};

        /// A `kid` no build holds: a binding made under it counts for nothing.
        const RETIRED_KID: &str = "kid-the-build-does-not-hold";
        const GUEST_SUB: &str = "dev:claim-guest";
        const CLAIMER_SUB: &str = "dev:claim-claimer";
        const BYSTANDER_SUB: &str = "dev:claim-bystander";
        const OWN_SUB: &str = "dev:cascade-own";
        const OTHER_SUB: &str = "dev:cascade-other";
        const KEPT_SUB: &str = "dev:cascade-kept";

        /// The `kid` of a key the default test build holds: a binding under it counts.
        fn dev_kid() -> &'static str {
            crate::accounts::DEV_ATTESTATION_KEYS[0].kid
        }

        /// The world owner the access-rule tests name in `config`.
        fn world_owner() -> Identity {
            id(0xD9)
        }

        /// Registers `world_allowlist` on its key (read, scanned and written) and makes
        /// `world_binding` scannable, beside what [`world`] registers.
        fn listing(fx: &Fixture) -> Handle<'_, WorldAllowlist, String> {
            let _ = fx
                .table::<WorldBinding>("world_binding", "identity", |r| r.identity)
                .unique()
                .writable()
                .scannable();
            fx.table_keyed::<WorldAllowlist, String>("world_allowlist", "account_subject", |r| {
                r.account_subject.clone()
            })
            .unique()
            .writable()
            .scannable()
        }

        /// [`listing`] plus what the owner's `set_world_access` reads and writes: `config`
        /// naming [`world_owner`], `world_access` (no row: `Open`) and `player_session`
        /// scannable for the carry-over.
        fn switchable(fx: &Fixture) -> Handle<'_, WorldAllowlist, String> {
            let list = listing(fx);
            fx.table_keyed::<Config, u32>("config", "id", |r| r.id)
                .unique()
                .seed(&Config {
                    id: 0,
                    content_version: 0,
                    owner_identity: world_owner(),
                });
            let _ = fx
                .table_keyed::<WorldAccess, u32>("world_access", "id", |r| r.id)
                .unique()
                .writable();
            let _ = fx
                .table::<PlayerSession>("player_session", "identity", |r| r.identity)
                .writable()
                .scannable();
            list
        }

        fn enlist(list: &Handle<'_, WorldAllowlist, String>, subjects: &[&str]) {
            for subject in subjects {
                list.seed(&WorldAllowlist {
                    account_subject: (*subject).to_string(),
                });
            }
        }

        /// The listed subjects, sorted.
        fn listed(list: &Handle<'_, WorldAllowlist, String>) -> Vec<String> {
            let mut out: Vec<String> = list.rows().into_iter().map(|r| r.account_subject).collect();
            out.sort();
            out
        }

        /// `xs` as owned strings, sorted.
        fn subjects(xs: &[&str]) -> Vec<String> {
            let mut out: Vec<String> = xs.iter().map(|x| (*x).to_string()).collect();
            out.sort();
            out
        }

        fn bind(w: &W<'_>, who: Identity, subject: &str, kid: &str) {
            w.binding.seed(&WorldBinding {
                identity: who,
                account_subject: subject.to_string(),
                bound_at_ms: T0 - 30,
                entitled: true,
                key_id: kid.to_string(),
            });
        }

        fn bind_nonce(w: &W<'_>, who: Identity, k: i64) {
            w.bind_nonce.seed(&WorldBindNonce {
                identity: who,
                nonce: format!("{k:032x}"),
                expires_at_ms: T0 + 300_000 + k,
            });
        }

        /// `who` holds a row of each of the four world tables: an admission, a
        /// wrong-password record, a binding to `subject` under `kid` and a bind nonce.
        fn seed_world_rows(w: &W<'_>, who: Identity, subject: &str, kid: &str, k: i64) {
            w.admission.seed(&WorldAdmission {
                identity: who,
                admitted_at_ms: T0 - 100 + k,
            });
            w.admission_attempt.seed(&WorldAdmissionAttempt {
                identity: who,
                wrong_at_ms: vec![T0 - 50 + k, T0 - 40 + k],
                last_wrong_at_ms: T0 - 40 + k,
            });
            bind(w, who, subject, kid);
            bind_nonce(w, who, k);
        }

        /// `who`'s rows of the four world tables, per table, as sorted canonical bytes.
        fn world_rows_of(w: &W<'_>, who: Identity) -> Vec<(&'static str, Vec<Vec<u8>>)> {
            vec![
                (
                    "world_admission",
                    encs(
                        &w.admission
                            .rows()
                            .into_iter()
                            .filter(|r| r.identity == who)
                            .collect::<Vec<_>>(),
                    ),
                ),
                (
                    "world_admission_attempt",
                    encs(
                        &w.admission_attempt
                            .rows()
                            .into_iter()
                            .filter(|r| r.identity == who)
                            .collect::<Vec<_>>(),
                    ),
                ),
                (
                    "world_binding",
                    encs(
                        &w.binding
                            .rows()
                            .into_iter()
                            .filter(|r| r.identity == who)
                            .collect::<Vec<_>>(),
                    ),
                ),
                (
                    "world_bind_nonce",
                    encs(
                        &w.bind_nonce
                            .rows()
                            .into_iter()
                            .filter(|r| r.identity == who)
                            .collect::<Vec<_>>(),
                    ),
                ),
            ]
        }

        /// What [`world_rows_of`] reports for an identity holding none of the four.
        fn no_world_rows() -> Vec<(&'static str, Vec<Vec<u8>>)> {
            [
                "world_admission",
                "world_admission_attempt",
                "world_binding",
                "world_bind_nonce",
            ]
            .into_iter()
            .map(|table| (table, Vec::new()))
            .collect()
        }

        /// Guest `g` is in the world with game data (monster 101 among it), starts a claim
        /// and leaves; account `c` (no game data) completes the claim through the shipped
        /// `complete_guest_claim`. Returns the claim's answer.
        fn claim_guest(fx: &Fixture, w: &W<'_>, g: Identity, c: Identity) -> Result<(), String> {
            let secret = code('4');
            w.player.seed(&player_row(g, 1, "Guesty"));
            assert_eq!(
                fx.run_as_at(g, at(T0), |ctx| {
                    crate::accounts::start_guest_claim(ctx, secret.clone())
                }),
                Ok(()),
                "the guest starts a claim"
            );
            assert_eq!(w.player.remove(g), 1, "the guest leaves");
            seed_rekey_rows(w, g, 1);
            for identity in ladder_oracle(&w.profile.rows(), 100) {
                w.ladder.seed(&crate::schema::LeaderboardTop { identity });
            }
            w.account
                .seed(&crate::accounts::new_account_row(c, "i".to_string(), 1));
            signed_in(fx, c, T0 + 1_000, |ctx| {
                crate::accounts::complete_guest_claim(ctx, secret.clone())
            })
        }

        fn owns_monster_101(w: &W<'_>, who: Identity) -> bool {
            w.monster
                .rows()
                .iter()
                .any(|m| m.monster_id == 101 && m.owner_identity == who)
        }

        /// `v`, holding an active account, requests its deletion and the shipped
        /// `account_deletion_reaper` completes the cascade.
        fn cascade(fx: &Fixture, w: &W<'_>, v: Identity) {
            w.account
                .seed(&crate::accounts::new_account_row(v, "iss".to_string(), 1));
            let _ = deletion_completed_for(fx, v, T0 + 10);
        }

        // --- the claim ---------------------------------------------------------------

        /// The retired guest holds an admission, a wrong-password record, a dev-key binding
        /// and a nonce; so do the claimer and a bystander. The claim answers `Ok`, moves the
        /// guest's monster to the claimer, and leaves the guest no row of any of the four
        /// tables, while the claimer's and the bystander's rows stay byte for byte.
        ///
        /// kills: a claim with no erase; the claimer's or the bystander's rows erased in
        /// place of the guest's; only some of the four tables erased; an erase that breaks
        /// the claim itself.
        #[test]
        fn a_completed_claim_erases_the_retired_guests_world_rows_and_no_one_elses_wr261127a_1() {
            let fx = fixture();
            let w = world(&fx);
            let _list = listing(&fx);
            let (g, c, b) = (id(0xD1), id(0xD2), id(0xD3));
            seed_world_rows(&w, g, GUEST_SUB, dev_kid(), 1);
            seed_world_rows(&w, c, CLAIMER_SUB, dev_kid(), 2);
            seed_world_rows(&w, b, BYSTANDER_SUB, dev_kid(), 3);
            assert!(
                world_rows_of(&w, g).iter().all(|(_, rows)| rows.len() == 1),
                "fixture: the guest holds one row of each world table"
            );
            let claimer_before = world_rows_of(&w, c);
            let bystander_before = world_rows_of(&w, b);

            assert_eq!(claim_guest(&fx, &w, g, c), Ok(()), "the claim completes");
            assert!(
                owns_monster_101(&w, c),
                "the claim still moves the guest's monster to the claimer"
            );
            assert_eq!(
                world_rows_of(&w, g),
                no_world_rows(),
                "the retired guest holds no admission, attempt, binding or nonce row"
            );
            assert_eq!(
                world_rows_of(&w, c),
                claimer_before,
                "the claimer's own rows stay"
            );
            assert_eq!(
                world_rows_of(&w, b),
                bystander_before,
                "the bystander's rows stay"
            );
        }

        /// A retired guest whose binding is under a key the build does not hold, with a
        /// nonce and no admission row: the claim erases the binding and the nonce too.
        ///
        /// kills: a claim that erases only a binding the build counts.
        #[test]
        fn the_claim_erases_a_guest_binding_the_build_does_not_count_wr261127a_1() {
            let fx = fixture();
            let w = world(&fx);
            let _list = listing(&fx);
            let (g, c) = (id(0xD4), id(0xD5));
            bind(&w, g, GUEST_SUB, RETIRED_KID);
            bind_nonce(&w, g, 4);
            assert_eq!(claim_guest(&fx, &w, g, c), Ok(()), "the claim completes");
            assert_eq!(
                world_rows_of(&w, g),
                no_world_rows(),
                "the uncounted binding and the nonce are gone"
            );
        }

        /// The retired guest's subject, and another, are on the host's list: the claim
        /// leaves the list unchanged, with no write call on it.
        ///
        /// kills (a control): a claim that writes `world_allowlist`.
        #[test]
        fn the_claim_leaves_the_allowlist_as_it_was_wr261127a_1() {
            let fx = fixture();
            let w = world(&fx);
            let list = listing(&fx);
            let (g, c) = (id(0xD6), id(0xD7));
            seed_world_rows(&w, g, GUEST_SUB, dev_kid(), 6);
            enlist(&list, &[GUEST_SUB, BYSTANDER_SUB]);
            assert_eq!(claim_guest(&fx, &w, g, c), Ok(()), "the claim completes");
            assert_eq!(
                listed(&list),
                subjects(&[GUEST_SUB, BYSTANDER_SUB]),
                "every list row stays"
            );
            assert_eq!(
                fx.writes_to("world_allowlist"),
                0,
                "the claim makes no write call on the list"
            );
        }

        /// Beside the retired guest, bound to [`GUEST_SUB`] under the dev key, another
        /// identity holds an admission, a wrong-password record, a dev-key binding to the
        /// same [`GUEST_SUB`] and a nonce. The claim answers `Ok`, leaves the guest none of
        /// the four rows, and leaves the other identity's four rows byte for byte.
        ///
        /// kills: a claim that erases every binding carrying the guest's subject.
        #[test]
        fn the_claim_leaves_another_identity_bound_to_the_guests_subject_wr261127a_1() {
            let fx = fixture();
            let w = world(&fx);
            let _list = listing(&fx);
            let (g, c, s) = (id(0xC1), id(0xC2), id(0xC3));
            seed_world_rows(&w, g, GUEST_SUB, dev_kid(), 8);
            seed_world_rows(&w, s, GUEST_SUB, dev_kid(), 9);
            let other_before = world_rows_of(&w, s);
            assert!(
                other_before.iter().all(|(_, rows)| rows.len() == 1),
                "fixture: the other identity holds one row of each world table"
            );

            assert_eq!(claim_guest(&fx, &w, g, c), Ok(()), "the claim completes");
            assert_eq!(
                world_rows_of(&w, g),
                no_world_rows(),
                "the retired guest holds no admission, attempt, binding or nonce row"
            );
            assert_eq!(
                world_rows_of(&w, s),
                other_before,
                "the other identity bound to the guest's subject keeps all four rows"
            );
        }

        // --- the claim, then the owner's switch to `Allowlist` ------------------------

        /// The owner switches the world from `Open` to `Allowlist`.
        fn to_allowlist(fx: &Fixture, ms: i64) -> Result<(), String> {
            as_conn(fx, world_owner(), None, ms, |ctx| {
                crate::access::set_world_access(ctx, WorldAccessRule::Allowlist, Vec::new())
            })
        }

        /// On an `Open` world, the guest, the claimer and a bystander each hold a checked
        /// account under a handle of their own. After the claim, the owner's switch to
        /// `Allowlist` lists the claimer's and the bystander's handles and not the guest's.
        ///
        /// kills: a claim that leaves the guest's account row (its handle is seeded); a claim
        /// that erases the claimer's row in place of the guest's.
        #[test]
        fn after_the_claim_the_switch_to_allowlist_does_not_list_the_guests_subject_wr261127a_2() {
            let fx = fixture();
            let w = world(&fx);
            let list = switchable(&fx);
            let (g, c, b) = (id(0xE1), id(0xE2), id(0xE3));
            checked(&w, g, GUEST_SUB, 11);
            checked(&w, c, CLAIMER_SUB, 12);
            checked(&w, b, BYSTANDER_SUB, 13);
            assert_eq!(claim_guest(&fx, &w, g, c), Ok(()), "the claim completes");
            assert_eq!(to_allowlist(&fx, T0 + 2_000), Ok(()), "the switch");
            assert_eq!(
                listed(&list),
                subjects(&[BYSTANDER_SUB, CLAIMER_SUB]),
                "the checked handles are listed, the retired guest's is not"
            );
        }

        /// The same world with no claim: the switch lists the guest's handle beside the
        /// others, so the test above cannot pass on a seed that lists nothing of the guest's
        /// for another reason.
        ///
        /// kills (a control): a seed that skips the guest's row whatever the claim did.
        #[test]
        fn without_the_claim_the_switch_to_allowlist_lists_the_guests_subject_wr261127a_2() {
            let fx = fixture();
            let w = world(&fx);
            let list = switchable(&fx);
            let (g, c, b) = (id(0xE4), id(0xE5), id(0xE6));
            checked(&w, g, GUEST_SUB, 14);
            checked(&w, c, CLAIMER_SUB, 15);
            checked(&w, b, BYSTANDER_SUB, 16);
            assert_eq!(to_allowlist(&fx, T0 + 2_000), Ok(()), "the switch");
            assert_eq!(
                listed(&list),
                subjects(&[BYSTANDER_SUB, CLAIMER_SUB, GUEST_SUB]),
                "every checked handle is listed"
            );
        }

        // --- the cascade -------------------------------------------------------------

        /// The deleted identity holds a checked account under a listed handle and a binding.
        /// The cascade removes exactly that list row: a spelling of it in other letter case, a
        /// longer one, a shorter one, a bystander's listed handle and an unrelated row all
        /// stay. The deleted identity's account row and binding are erased; the bystander's
        /// account row stays.
        ///
        /// kills: a cascade with no delist; the delist run after the account row is erased
        /// (the handle is gone by then); more than the one row removed, or the whole list
        /// cleared; the handle compared without case or by prefix.
        #[test]
        fn the_cascade_removes_the_deleted_identitys_own_listed_subject_wr261127a_3() {
            let fx = fixture();
            let w = world(&fx);
            let list = listing(&fx);
            let (v, b) = (id(0xF1), id(0xF2));
            checked(&w, v, OWN_SUB, 21);
            bind(&w, v, OWN_SUB, dev_kid());
            checked(&w, b, OTHER_SUB, 22);
            let near = ["DEV:CASCADE-OWN", "dev:cascade-own1", "dev:cascade-ow"];
            enlist(&list, &[OWN_SUB, OTHER_SUB, KEPT_SUB]);
            enlist(&list, &near);
            cascade(&fx, &w, v);
            let mut want = subjects(&[OTHER_SUB, KEPT_SUB]);
            want.extend(subjects(&near));
            want.sort();
            assert_eq!(listed(&list), want, "only the own handle's row is gone");
            assert_eq!(
                world_rows_of(&w, v)[2],
                ("world_binding", Vec::new()),
                "the deleted identity's binding is erased"
            );
            assert!(
                account_rows_of(&w, v).0.is_empty(),
                "its account row is erased"
            );
            assert_eq!(
                account_rows_of(&w, b).0.len(),
                1,
                "the bystander's account row stays"
            );
        }

        /// Another identity holds an attestation binding to the same subject under the dev
        /// key: the cascade of the deleted identity leaves that other binding in place.
        ///
        /// kills: a binding erase keyed on the subject rather than the identity.
        #[test]
        fn the_cascade_leaves_another_identitys_binding_to_the_same_subject_wr261127a_4() {
            let fx = fixture();
            let w = world(&fx);
            let _list = listing(&fx);
            let (v, twin) = (id(0xF7), id(0xF8));
            bind(&w, v, OWN_SUB, dev_kid());
            bind(&w, twin, OWN_SUB, dev_kid());
            cascade(&fx, &w, v);
            assert_eq!(
                world_rows_of(&w, twin)[2].1.len(),
                1,
                "the other binding stays"
            );
        }

        /// The deleted identity holds no binding: the list, a bound bystander's subject on it
        /// included, is left unchanged, with no write call.
        ///
        /// kills: a list row removed, or the list cleared, for an identity with no binding.
        #[test]
        fn an_identity_with_no_binding_leaves_the_list_untouched_wr261127a_4() {
            let fx = fixture();
            let w = world(&fx);
            let list = listing(&fx);
            let (v, b) = (id(0xF9), id(0xFA));
            bind(&w, b, OTHER_SUB, dev_kid());
            enlist(&list, &[OTHER_SUB, KEPT_SUB]);
            cascade(&fx, &w, v);
            assert_eq!(listed(&list), subjects(&[OTHER_SUB, KEPT_SUB]));
            assert_eq!(
                fx.writes_to("world_allowlist"),
                0,
                "no write call on the list"
            );
        }

        /// The deleted identity holds a checked account, and a binding, under a handle the
        /// list does not hold: the list is left unchanged, with no write call.
        ///
        /// kills: a delete call on the list for a handle that is not listed.
        #[test]
        fn a_subject_that_is_not_listed_makes_no_write_on_the_list_wr261127a_4() {
            let fx = fixture();
            let w = world(&fx);
            let list = listing(&fx);
            let v = id(0xFB);
            checked(&w, v, OWN_SUB, 31);
            bind(&w, v, OWN_SUB, dev_kid());
            enlist(&list, &[KEPT_SUB]);
            cascade(&fx, &w, v);
            assert_eq!(listed(&list), subjects(&[KEPT_SUB]));
            assert_eq!(
                fx.writes_to("world_allowlist"),
                0,
                "no write call on the list"
            );
        }

        /// The deleted identity's handle is spelled with upper-case letters. The list holds it,
        /// its all-lower-case twin, a longer spelling another identity's handle is, and an
        /// unrelated row. The cascade removes exactly the deleted identity's spelling; every
        /// other row stays, and so does the other identity's account row.
        ///
        /// kills: the handle lower-cased before the list lookup or delete; a handle matched by
        /// prefix rather than by equality.
        #[test]
        fn a_mixed_case_subject_is_removed_exactly_not_kept_by_a_longer_one_wr261127a_3() {
            let fx = fixture();
            let w = world(&fx);
            let list = listing(&fx);
            let (v, longer) = (id(0xFC), id(0xFD));
            let mixed = "Dev:Cascade-Mixed";
            let lower = "dev:cascade-mixed";
            let extended = "Dev:Cascade-Mixed1";
            checked(&w, v, mixed, 23);
            checked(&w, longer, extended, 24);
            enlist(&list, &[mixed, lower, extended, KEPT_SUB]);
            cascade(&fx, &w, v);
            assert_eq!(
                listed(&list),
                subjects(&[lower, extended, KEPT_SUB]),
                "only the deleted identity's exact spelling is gone"
            );
            assert_eq!(
                account_rows_of(&w, longer).0.len(),
                1,
                "the longer spelling's account row stays"
            );
        }

        // --- the checked account ------------------------------------------------------

        const HANDLE_OWN: &str = "k1.OwnOwnOwn0123456789-_";
        const HANDLE_OTHER: &str = "k1.OthOthOth0123456789_-";
        const HANDLE_THIRD: &str = "k1.ThiThiThi0123456789ab";

        /// `who` holds a checked account under `handle` and an armed re-check numbered `k`.
        fn checked(w: &W<'_>, who: Identity, handle: &str, k: u64) {
            let k_ms = i64::try_from(k).expect("a small test number fits an i64");
            w.world_account.seed(&crate::account_checks::WorldAccount {
                handle: handle.to_string(),
                identity: who,
                entitled: true,
                checked_at_ms: T0 - 1_000 + k_ms,
                is_host: false,
            });
            w.recheck.seed(&crate::account_checks::RecheckSchedule {
                scheduled_id: k,
                scheduled_at: ScheduleAt::Time(at(T0 + k_ms)),
                identity: who,
            });
        }

        /// `who`'s `world_account` and `recheck_schedule` rows, as sorted canonical bytes.
        fn account_rows_of(w: &W<'_>, who: Identity) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
            (
                encs(
                    &w.world_account
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
                encs(
                    &w.recheck
                        .rows()
                        .into_iter()
                        .filter(|r| r.identity == who)
                        .collect::<Vec<_>>(),
                ),
            )
        }

        /// The deleted identity and a bystander each hold a checked account, an armed
        /// re-check and a listed handle. The cascade erases the deleted identity's account
        /// row and its re-check and takes its handle off the list; the bystander's rows and
        /// listed handle, and an unrelated list row, stay byte for byte.
        ///
        /// kills: a cascade with no `world_account` step; the re-check left armed; the
        /// bystander's rows erased; the delist still keyed on a binding (no binding is
        /// seeded, so the handle would stay); the delist run after the row is erased.
        #[test]
        fn the_cascade_erases_the_deleted_identitys_checked_account_and_no_others_lpw23_10() {
            let fx = fixture();
            let w = world(&fx);
            let list = listing(&fx);
            let (v, b) = (id(0xE7), id(0xE8));
            checked(&w, v, HANDLE_OWN, 1);
            checked(&w, b, HANDLE_OTHER, 2);
            enlist(&list, &[HANDLE_OWN, HANDLE_OTHER, KEPT_SUB]);
            let bystander_before = account_rows_of(&w, b);
            assert_eq!(
                bystander_before.0.len(),
                1,
                "fixture: the bystander's account row"
            );
            assert_eq!(
                bystander_before.1.len(),
                1,
                "fixture: the bystander's re-check"
            );
            cascade(&fx, &w, v);
            assert_eq!(
                account_rows_of(&w, v),
                (Vec::new(), Vec::new()),
                "the deleted identity's account row and re-check are gone"
            );
            assert_eq!(
                account_rows_of(&w, b),
                bystander_before,
                "the bystander's account row and re-check stay"
            );
            assert_eq!(
                listed(&list),
                subjects(&[HANDLE_OTHER, KEPT_SUB]),
                "only the deleted identity's handle leaves the list"
            );
        }

        /// The retired guest, the claimer and a bystander each hold a checked account and an
        /// armed re-check. The claim completes and erases the guest's two rows; the
        /// claimer's and the bystander's stay byte for byte.
        ///
        /// kills: a claim with no `world_account` erase; the claimer's rows erased in place
        /// of the guest's; the guest's re-check left armed.
        #[test]
        fn the_claim_erases_the_retired_guests_checked_account_and_no_others_lpw23_10() {
            let fx = fixture();
            let w = world(&fx);
            let _list = listing(&fx);
            let (g, c, b) = (id(0xE9), id(0xEA), id(0xEB));
            checked(&w, g, HANDLE_OWN, 3);
            checked(&w, c, HANDLE_OTHER, 4);
            checked(&w, b, HANDLE_THIRD, 5);
            let claimer_before = account_rows_of(&w, c);
            let bystander_before = account_rows_of(&w, b);
            assert_eq!(claim_guest(&fx, &w, g, c), Ok(()), "the claim completes");
            assert!(owns_monster_101(&w, c), "the claim still moves the monster");
            assert_eq!(
                account_rows_of(&w, g),
                (Vec::new(), Vec::new()),
                "the retired guest holds no account row and no re-check"
            );
            assert_eq!(
                account_rows_of(&w, c),
                claimer_before,
                "the claimer's rows stay"
            );
            assert_eq!(
                account_rows_of(&w, b),
                bystander_before,
                "the bystander's rows stay"
            );
        }
    }
}

// ===========================================================================
// Ownership: the build profile computed from the cargo features, the reader of
// the `mr_ent` claim, the door `join_game` asks, and the profile section the
// release artefact carries. Every function here takes the profile as an
// argument, so these tests run in every build, the default one included.
// ===========================================================================

/// `build_profile` over all 64 feature sets against an oracle written here, the
/// rows of the design table one by one, the invariants no feature set may break,
/// and the per-build constants.
mod acs6_profile {
    use crate::accounts::{
        build_profile, AttestationKey, BuildFeatures, BuildProfile, ALLOWED_ISSUERS,
        BUILD_FEATURES, BUILD_PROFILE, DEV_ATTESTATION_KEYS, DEV_LOGIN_ISSUERS,
        PRODUCTION_ATTESTATION_KEYS, PRODUCTION_LOGIN_ISSUERS,
    };

    pub(super) const PRODUCTION: &str = "https://auth.monster-realm.invalid/";
    pub(super) const LOCAL_DEV: &str = "http://localhost:4455";
    pub(super) const HOSTED_DEV: &str = "https://auth.monster-realm.spookyowltech.com";

    /// The feature set that names nothing.
    pub(super) const NONE: BuildFeatures = BuildFeatures {
        official: false,
        world: false,
        dev_issuers: false,
        open_join: false,
        dev_reducers: false,
        load_test_zones: false,
    };

    pub(super) const FEATURE_NAMES: [&str; 6] = [
        "official",
        "world",
        "dev_issuers",
        "open_join",
        "dev_reducers",
        "load_test_zones",
    ];

    fn names(f: BuildFeatures, name: &str) -> bool {
        match name {
            "official" => f.official,
            "world" => f.world,
            "dev_issuers" => f.dev_issuers,
            "open_join" => f.open_join,
            "dev_reducers" => f.dev_reducers,
            "load_test_zones" => f.load_test_zones,
            other => panic!("not a feature of the module: {other}"),
        }
    }

    /// The feature set naming exactly `named`.
    pub(super) fn feats(named: &[&str]) -> BuildFeatures {
        let mut f = NONE;
        for n in named {
            match *n {
                "official" => f.official = true,
                "world" => f.world = true,
                "dev_issuers" => f.dev_issuers = true,
                "open_join" => f.open_join = true,
                "dev_reducers" => f.dev_reducers = true,
                "load_test_zones" => f.load_test_zones = true,
                other => panic!("not a feature of the module: {other}"),
            }
        }
        f
    }

    /// Every one of the 64 feature sets: bit `i` names `FEATURE_NAMES[i]`.
    pub(super) fn all_feature_sets() -> Vec<BuildFeatures> {
        (0u8..64)
            .map(|bits| {
                let named: Vec<&str> = FEATURE_NAMES
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| bits & (1u8 << i) != 0)
                    .map(|(_, n)| *n)
                    .collect();
                feats(&named)
            })
            .collect()
    }

    /// The oracle, built differently from the function under test: cargo's
    /// implications are edges closed to a fixed point, the build is named from
    /// the closed set, and enforcement, the trusted issuers and the attestation
    /// keys are read off the name.
    pub(super) fn expected(f: BuildFeatures) -> BuildProfile {
        const IMPLIES: [(&str, &str); 3] = [
            ("load_test_zones", "dev_reducers"),
            ("dev_reducers", "open_join"),
            ("open_join", "dev_issuers"),
        ];
        let mut on: Vec<&str> = FEATURE_NAMES
            .iter()
            .copied()
            .filter(|n| names(f, n))
            .collect();
        loop {
            let before = on.len();
            for (from, to) in IMPLIES {
                if on.contains(&from) && !on.contains(&to) {
                    on.push(to);
                }
            }
            if on.len() == before {
                break;
            }
        }
        let has = |n: &'static str| on.contains(&n);
        let name = match (has("official"), has("world")) {
            (true, false) => "official",
            (false, true) => "world",
            (true, true) => "conflict",
            (false, false) if has("open_join") => "test",
            (false, false) if has("dev_issuers") => "dev-enforcing",
            (false, false) => "default",
        };
        let login_issuers: &'static [&'static str] = match name {
            "official" => &[PRODUCTION],
            "test" | "dev-enforcing" => &[LOCAL_DEV, HOSTED_DEV],
            _ => &[],
        };
        let attestation_keys: &'static [AttestationKey] = match name {
            "world" => PRODUCTION_ATTESTATION_KEYS,
            "test" | "dev-enforcing" => DEV_ATTESTATION_KEYS,
            _ => &[],
        };
        BuildProfile {
            name,
            enforces_ownership: name != "test",
            login_issuers,
            dev_reducers: has("dev_reducers"),
            attestation_keys,
            world_check_url: world_check_url_of(name),
        }
    }

    /// The account service a world of the build `name` asks: the production placeholder for
    /// `world`, hosted-dev for the two dev builds, none for the rest.
    pub(super) fn world_check_url_of(name: &str) -> Option<&'static str> {
        match name {
            "world" => Some("https://auth.monster-realm.invalid/world/check"),
            "test" | "dev-enforcing" => {
                Some("https://auth.monster-realm.spookyowltech.com/world/check")
            }
            _ => None,
        }
    }

    fn profile(
        name: &'static str,
        enforces_ownership: bool,
        login_issuers: &'static [&'static str],
        dev_reducers: bool,
        attestation_keys: &'static [AttestationKey],
    ) -> BuildProfile {
        BuildProfile {
            name,
            enforces_ownership,
            login_issuers,
            dev_reducers,
            attestation_keys,
            world_check_url: world_check_url_of(name),
        }
    }

    /// The two attestation key lists, by value: no production key, and the
    /// one `local-dev` key as the account service publishes it (its `kid`, and
    /// its 32 public bytes as the JWK's unpadded base64url `x`).
    ///
    /// kills: a dev key listed as production; a second or a missing dev key;
    /// a wrong `kid`; a byte of the public key changed.
    #[test]
    fn acs6_profile_the_attestation_key_lists_hold_these_values() {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine as _;
        let none: &[AttestationKey] = &[];
        assert_eq!(PRODUCTION_ATTESTATION_KEYS, none);
        assert_eq!(DEV_ATTESTATION_KEYS.len(), 1, "exactly one dev key");
        let key = DEV_ATTESTATION_KEYS[0];
        let published_kid = "ZwdbDVawj1m0Ot-iNvOUMykc1_hgr1dD5wRMph3rgWE";
        assert_eq!(key.kid, published_kid);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(key.public_key),
            "BWXfIXbop1k6-Ch0VTug3klcgULo4NNzTBCTjH2AFF4"
        );
    }

    /// The three issuers, by value: the production placeholder alone, and the
    /// local then the hosted dev issuer.
    #[test]
    fn acs6_profile_the_issuer_lists_hold_these_values() {
        assert_eq!(
            PRODUCTION_LOGIN_ISSUERS,
            &["https://auth.monster-realm.invalid/"][..]
        );
        assert_eq!(
            DEV_LOGIN_ISSUERS,
            &[
                "http://localhost:4455",
                "https://auth.monster-realm.spookyowltech.com"
            ][..]
        );
    }

    /// Every feature set yields the oracle's profile, whole.
    ///
    /// kills: any flipped implication, a dev feature beating a release feature,
    /// a wrong name, the wrong issuer list on any row, `dev_reducers` not
    /// carried through.
    #[test]
    fn acs6_profile_every_feature_set_matches_the_table() {
        let sets = all_feature_sets();
        assert_eq!(sets.len(), 64, "fixture: every feature set");
        let mut seen: Vec<&str> = Vec::new();
        for f in sets {
            let want = expected(f);
            assert_eq!(build_profile(f), want, "feature set {f:?}");
            if !seen.contains(&want.name) {
                seen.push(want.name);
            }
        }
        seen.sort_unstable();
        assert_eq!(
            seen,
            vec![
                "conflict",
                "default",
                "dev-enforcing",
                "official",
                "test",
                "world"
            ],
            "fixture: the 64 sets reach every name"
        );
    }

    /// The rows of the design table, spelled out.
    #[test]
    fn acs6_profile_the_design_table_rows() {
        const DEV: &[&str] = &[LOCAL_DEV, HOSTED_DEV];
        const PROD: &[&str] = &[PRODUCTION];
        const NO_ISSUER: &[&str] = &[];
        const DEV_KEYS: &[AttestationKey] = DEV_ATTESTATION_KEYS;
        const PROD_KEYS: &[AttestationKey] = PRODUCTION_ATTESTATION_KEYS;
        const NO_KEY: &[AttestationKey] = &[];
        let rows: Vec<(&[&str], BuildProfile)> = vec![
            (&[][..], profile("default", true, NO_ISSUER, false, NO_KEY)),
            (
                &["dev_issuers"][..],
                profile("dev-enforcing", true, DEV, false, DEV_KEYS),
            ),
            (
                &["open_join"][..],
                profile("test", false, DEV, false, DEV_KEYS),
            ),
            (
                &["dev_reducers"][..],
                profile("test", false, DEV, true, DEV_KEYS),
            ),
            (
                &["load_test_zones"][..],
                profile("test", false, DEV, true, DEV_KEYS),
            ),
            (
                &["official"][..],
                profile("official", true, PROD, false, NO_KEY),
            ),
            (
                &["world"][..],
                profile("world", true, NO_ISSUER, false, PROD_KEYS),
            ),
            (
                &["official", "world"][..],
                profile("conflict", true, NO_ISSUER, false, NO_KEY),
            ),
            (
                &["official", "open_join"][..],
                profile("official", true, PROD, false, NO_KEY),
            ),
            (
                &["official", "dev_issuers"][..],
                profile("official", true, PROD, false, NO_KEY),
            ),
            (
                &["world", "dev_issuers"][..],
                profile("world", true, NO_ISSUER, false, PROD_KEYS),
            ),
            (
                &["world", "open_join"][..],
                profile("world", true, NO_ISSUER, false, PROD_KEYS),
            ),
            (
                &["official", "world", "dev_issuers", "open_join"][..],
                profile("conflict", true, NO_ISSUER, false, NO_KEY),
            ),
            (
                &["official", "dev_reducers"][..],
                profile("official", true, PROD, true, NO_KEY),
            ),
            (
                &["world", "load_test_zones"][..],
                profile("world", true, NO_ISSUER, true, PROD_KEYS),
            ),
            (
                &["dev_issuers", "open_join"][..],
                profile("test", false, DEV, false, DEV_KEYS),
            ),
        ];
        for (named, want) in rows {
            assert_eq!(build_profile(feats(named)), want, "features {named:?}");
        }
    }

    /// No feature set trusts the production issuer without enforcing, none
    /// trusts the production and a dev issuer together, and a release build
    /// (`official` or `world` named) enforces and trusts no dev issuer. No
    /// feature set holds a production and a dev attestation key together, a
    /// profile that trusts a production login issuer holds no attestation key,
    /// a profile holding a production attestation key trusts no login issuer,
    /// and a release build holds no dev attestation key.
    #[test]
    fn acs6_profile_no_feature_set_breaks_the_invariants() {
        for f in all_feature_sets() {
            let p = build_profile(f);
            let prod = p
                .login_issuers
                .iter()
                .any(|i| PRODUCTION_LOGIN_ISSUERS.contains(i));
            let dev = p
                .login_issuers
                .iter()
                .any(|i| DEV_LOGIN_ISSUERS.contains(i));
            let prod_key = p
                .attestation_keys
                .iter()
                .any(|k| PRODUCTION_ATTESTATION_KEYS.contains(k));
            let dev_key = p
                .attestation_keys
                .iter()
                .any(|k| DEV_ATTESTATION_KEYS.contains(k));
            assert!(
                !prod || p.enforces_ownership,
                "{f:?}: production trust without enforcement"
            );
            assert!(!(prod && dev), "{f:?}: production and dev trust together");
            assert!(
                !(prod_key && dev_key),
                "{f:?}: production and dev attestation keys together"
            );
            assert!(
                !prod || p.attestation_keys.is_empty(),
                "{f:?}: a profile that trusts a production login issuer holds an attestation key"
            );
            assert!(
                !prod_key || p.login_issuers.is_empty(),
                "{f:?}: a profile holding a production attestation key trusts a login issuer"
            );
            if f.official || f.world {
                assert!(
                    p.enforces_ownership,
                    "{f:?}: a release that does not enforce"
                );
                assert!(!dev, "{f:?}: a release that trusts a dev issuer");
                assert!(
                    !dev_key,
                    "{f:?}: a release that holds a dev attestation key"
                );
            }
        }
    }

    /// The constants of this build are the table's row for this build's
    /// features, and each feature field is that feature's `cfg!`.
    #[test]
    fn acs6_profile_this_build_is_the_row_of_its_own_features() {
        assert_eq!(
            BUILD_FEATURES,
            BuildFeatures {
                official: cfg!(feature = "official"),
                world: cfg!(feature = "world"),
                dev_issuers: cfg!(feature = "dev_issuers"),
                open_join: cfg!(feature = "open_join"),
                dev_reducers: cfg!(feature = "dev_reducers"),
                load_test_zones: cfg!(feature = "load_test_zones"),
            }
        );
        assert_eq!(BUILD_PROFILE, build_profile(BUILD_FEATURES));
        assert_eq!(BUILD_PROFILE, expected(BUILD_FEATURES));
        assert_eq!(ALLOWED_ISSUERS, BUILD_PROFILE.login_issuers);
    }

    /// A build naming `open_join` is the test build: it does not enforce and
    /// trusts the two dev issuers, in order.
    #[cfg(feature = "open_join")]
    #[test]
    fn acs6_profile_an_open_join_build_is_the_test_build() {
        assert_eq!(BUILD_PROFILE.name, "test");
        let profile = std::hint::black_box(BUILD_PROFILE);
        assert!(
            !profile.enforces_ownership,
            "an open_join build must not enforce ownership"
        );
        assert_eq!(BUILD_PROFILE.login_issuers, &[LOCAL_DEV, HOSTED_DEV][..]);
        assert_eq!(ALLOWED_ISSUERS, &[LOCAL_DEV, HOSTED_DEV][..]);
    }

    /// A build naming `dev_issuers` and not `open_join` enforces and trusts the
    /// two dev issuers, in order.
    #[cfg(all(feature = "dev_issuers", not(feature = "open_join")))]
    #[test]
    fn acs6_profile_a_dev_issuers_build_is_dev_enforcing() {
        assert_eq!(BUILD_PROFILE.name, "dev-enforcing");
        assert!(BUILD_PROFILE.enforces_ownership);
        assert_eq!(BUILD_PROFILE.login_issuers, &[LOCAL_DEV, HOSTED_DEV][..]);
        assert_eq!(ALLOWED_ISSUERS, &[LOCAL_DEV, HOSTED_DEV][..]);
    }
}

/// `token_names_entitlement`: a table of payloads, then properties whose JSON
/// text is rendered from a generated model (the model is the oracle).
mod acs6_claim {
    use crate::accounts::token_names_entitlement;
    use proptest::prelude::*;

    const BG: &str = "base-game";
    const REAL: &str = r#"{"iss":"http://localhost:4455","sub":"dev:1f0e","aud":"monster-realm","mr_ent":["base-game"],"iat":1,"exp":2}"#;

    fn ch(cp: u32) -> char {
        char::from_u32(cp).expect("a Unicode scalar value")
    }

    /// `(payload, entitlement asked, expected, label)`.
    type Row = (String, &'static str, bool, &'static str);

    fn row(payload: &str, ask: &'static str, want: bool, label: &'static str) -> Row {
        (payload.to_string(), ask, want, label)
    }

    fn check(rows: &[Row]) {
        for (payload, ask, want, label) in rows {
            assert_eq!(
                token_names_entitlement(payload, ask),
                *want,
                "{label}: asked {ask:?} of {payload:?}"
            );
        }
    }

    /// The payloads that name the entitlement.
    #[test]
    fn acs6_claim_payloads_that_name_base_game() {
        let spaced = " {\n\t\"iss\" :\t\"http://localhost:4455\" ,\r\n \"sub\"\t: \"dev:1f0e\" , \
                      \"aud\" : \"monster-realm\" ,\n\"mr_ent\"\n:\n[\n \"base-game\" \t]\t, \
                      \"iat\" : 1 , \"exp\":2\n}\n ";
        let zoe = format!("Zo{}", ch(0xEB));
        let nihon = format!("{}{}", ch(0x65E5), ch(0x672C));
        let owl = ch(0x1F989);
        let multibyte = format!(
            r#"{{"sub":"{zoe} {nihon} {owl}","mr_ent":["{nihon}","base-game"],"n":"{owl}"}}"#
        );
        let deep_array = format!(
            r#"{{"a":{}1{},"mr_ent":["base-game"]}}"#,
            "[".repeat(10_000),
            "]".repeat(10_000)
        );
        let deep_object = format!(
            r#"{{"a":{}1{},"mr_ent":["base-game"]}}"#,
            r#"{"a":"#.repeat(10_000),
            "}".repeat(10_000)
        );
        check(&[
            row(REAL, BG, true, "the real payload, compact"),
            row(spaced, BG, true, "whitespace around every token"),
            row(r#"{"mr_ent":["base-game"]}"#, BG, true, "the claim alone"),
            row(
                r#"{"mr_ent":["a","base-game"]}"#,
                BG,
                true,
                "second element",
            ),
            row(r#"{"mr_ent":["base-game","a"]}"#, BG, true, "first element"),
            row(&multibyte, BG, true, "multi-byte UTF-8 in other values"),
            row(
                r#"{"mr_ent":["base-game"],"iss":"x","aud":"monster-realm"}"#,
                BG,
                true,
                "claim first",
            ),
            row(
                r#"{"iss":"x","mr_ent":["base-game"],"aud":"monster-realm"}"#,
                BG,
                true,
                "claim in the middle",
            ),
            row(
                r#"{"iss":"x","aud":"monster-realm","mr_ent":["base-game"]}"#,
                BG,
                true,
                "claim last",
            ),
            row(
                r#"{"sub":"a\\","mr_ent":["base-game"]}"#,
                BG,
                true,
                "an escaped backslash ends the string before the real key",
            ),
            row(
                r#"{"sub":"\\\\","mr_ent":["base-game"]}"#,
                BG,
                true,
                "two escaped backslashes",
            ),
            row(
                r#"{"sub":"\"mr_ent\":[]","mr_ent":["base-game"]}"#,
                BG,
                true,
                "escaped key text inside a value is not a second key",
            ),
            row(
                r#"{"mr_ent":[["x"],"base-game"]}"#,
                BG,
                true,
                "a nested array is skipped and the next element read",
            ),
            row(
                r#"{"mr_ent":[{"a":"]"},"base-game"]}"#,
                BG,
                true,
                "a bracket inside a string inside a skipped object",
            ),
            row(
                r#"{"mr_ent":["a\"b","base-game"]}"#,
                BG,
                true,
                "an element with an escape is skipped, the next one matches",
            ),
            row(
                r#"{"mr_ent":["base-game"],"p":{"mr_ent":[]}}"#,
                BG,
                true,
                "a nested mr_ent is not a second top-level key",
            ),
            row(
                r#"{"p":{"mr_ent":[]},"mr_ent":["base-game"]}"#,
                BG,
                true,
                "a nested mr_ent before the real one",
            ),
            row(
                r#"{"p":["mr_ent",{"mr_ent":1}],"mr_ent":["base-game"]}"#,
                BG,
                true,
                "mr_ent as a nested string and key",
            ),
            row(
                r#"{"a":null,"b":true,"c":false,"d":-1.5e3,"e":[],"f":{},"g":"}","mr_ent":["base-game"]}"#,
                BG,
                true,
                "every value type before the claim",
            ),
            row(
                "\n {\"mr_ent\":[\"base-game\"]}\t\n",
                BG,
                true,
                "whitespace around the object",
            ),
            row(
                &deep_array,
                BG,
                true,
                "10,000 nested arrays before the claim",
            ),
            row(
                &deep_object,
                BG,
                true,
                "10,000 nested objects before the claim",
            ),
        ]);
    }

    /// Text that only looks like the claim: escaped, nested, of the wrong type,
    /// or near-miss keys and elements.
    #[test]
    fn acs6_claim_lookalikes_do_not_name_it() {
        let bs = '\\';
        let escaped_key = format!(r#"{{"mr{bs}u005fent":["base-game"]}}"#);
        let escaped_element = format!(r#"{{"mr_ent":["base{bs}u002dgame"]}}"#);
        check(&[
            row(
                r#"{"iss":"x","sub":"x\",\"mr_ent\":[\"base-game\"]","aud":"monster-realm"}"#,
                BG,
                false,
                "the claim's text escaped inside sub",
            ),
            row(
                r#"{"sub":"a\\\",\"mr_ent\":[\"base-game\"]"}"#,
                BG,
                false,
                "an odd run of backslashes keeps the string open",
            ),
            row(
                r#"{"p":{"mr_ent":["base-game"]}}"#,
                BG,
                false,
                "nested object",
            ),
            row(
                r#"{"p":["mr_ent",["base-game"]]}"#,
                BG,
                false,
                "nested array",
            ),
            row(
                r#"{"mr_ent":[["base-game"]]}"#,
                BG,
                false,
                "array in the array",
            ),
            row(
                r#"{"mr_ent":[{"a":"base-game"}]}"#,
                BG,
                false,
                "object in the array",
            ),
            row(
                r#"{"mr_ent":[{"base-game":1}]}"#,
                BG,
                false,
                "a key in the array",
            ),
            row(
                r#"{"mr_ent":"base-game"}"#,
                BG,
                false,
                "a string, not an array",
            ),
            row(
                r#"{"mr_ent":{"base-game":1}}"#,
                BG,
                false,
                "an object, not an array",
            ),
            row(r#"{"mr_ent":["base-game-x"]}"#, BG, false, "suffix"),
            row(r#"{"mr_ent":["xbase-game"]}"#, BG, false, "prefix"),
            row(r#"{"mr_ent":["base-game "]}"#, BG, false, "trailing space"),
            row(r#"{"mr_ent":[" base-game"]}"#, BG, false, "leading space"),
            row(r#"{"mr_ent":["Base-Game"]}"#, BG, false, "case"),
            row(r#"{"mr_ent":["base-gam"]}"#, BG, false, "truncated element"),
            row(
                r#"{"mr_ent":["\"base-game\""]}"#,
                BG,
                false,
                "quotes inside the element",
            ),
            row(&escaped_element, BG, false, "an escape in the element"),
            row(r#"{"xmr_ent":["base-game"]}"#, BG, false, "key prefix"),
            row(r#"{"mr_entx":["base-game"]}"#, BG, false, "key suffix"),
            row(
                r#"{"mr_ent ":["base-game"]}"#,
                BG,
                false,
                "key trailing space",
            ),
            row(
                r#"{" mr_ent":["base-game"]}"#,
                BG,
                false,
                "key leading space",
            ),
            row(r#"{"MR_ENT":["base-game"]}"#, BG, false, "key case"),
            row(r#"{"mr_en":["base-game"]}"#, BG, false, "truncated key"),
            row(
                r#"{"\"mr_ent\"":["base-game"]}"#,
                BG,
                false,
                "quotes inside the key",
            ),
            row(&escaped_key, BG, false, "an escape in the key"),
            row(
                r#"{"p":"mr_ent","q":["base-game"]}"#,
                BG,
                false,
                "mr_ent as a value",
            ),
        ]);
    }

    /// One top-level `mr_ent`, no backslash in any top-level key, or false.
    #[test]
    fn acs6_claim_duplicates_and_escaped_keys_fail_closed() {
        let bs = '\\';
        let escaped_duplicate = format!(r#"{{"mr_ent":[],"mr{bs}u005fent":["base-game"]}}"#);
        let escaped_duplicate_rev = format!(r#"{{"mr{bs}u005fent":[],"mr_ent":["base-game"]}}"#);
        check(&[
            row(
                r#"{"mr_ent":[],"mr_ent":["base-game"]}"#,
                BG,
                false,
                "empty then claim",
            ),
            row(
                r#"{"mr_ent":["base-game"],"mr_ent":[]}"#,
                BG,
                false,
                "claim then empty",
            ),
            row(
                r#"{"mr_ent":["base-game"],"mr_ent":["base-game"]}"#,
                BG,
                false,
                "the claim twice",
            ),
            row(
                r#"{"mr_ent":["base-game"],"a":1,"mr_ent":"x"}"#,
                BG,
                false,
                "a later duplicate of another type",
            ),
            row(
                &escaped_duplicate,
                BG,
                false,
                "empty then the claim under an escaped key",
            ),
            row(
                &escaped_duplicate_rev,
                BG,
                false,
                "the claim after an escaped spelling of the key",
            ),
            row(
                r#"{"a\\b":1,"mr_ent":["base-game"]}"#,
                BG,
                false,
                "a backslash in an earlier top-level key",
            ),
            row(
                r#"{"mr_ent":["base-game"],"x\"y":1}"#,
                BG,
                false,
                "a backslash in a later top-level key",
            ),
        ]);
    }

    /// Values of `mr_ent` that hold no such string.
    #[test]
    fn acs6_claim_other_values_of_mr_ent() {
        check(&[
            row(r#"{"mr_ent":null}"#, BG, false, "null"),
            row(r#"{"mr_ent":true}"#, BG, false, "true"),
            row(r#"{"mr_ent":false}"#, BG, false, "false"),
            row(r#"{"mr_ent":1}"#, BG, false, "a number"),
            row(r#"{"mr_ent":""}"#, BG, false, "an empty string"),
            row(r#"{"mr_ent":[]}"#, BG, false, "an empty array"),
            row(
                r#"{"mr_ent":[1,null,true]}"#,
                BG,
                false,
                "non-string elements",
            ),
            row(r#"{"iss":"x","aud":"y"}"#, BG, false, "no claim at all"),
            row("{}", BG, false, "an empty object"),
        ]);
    }

    /// Anything that is not one well-formed JSON object is false, and nothing
    /// panics.
    #[test]
    fn acs6_claim_malformed_or_truncated_input_is_false() {
        let deep = "[".repeat(10_000);
        let deep_in_claim = format!(r#"{{"mr_ent":{deep}"#);
        let deep_closed = format!(
            r#"{{"mr_ent":[{}"base-game"{}]}}"#,
            "[".repeat(10_000),
            "]".repeat(10_000)
        );
        let deep_open_objects = r#"{"a":"#.repeat(10_000);
        check(&[
            row(
                r#"[{"mr_ent":["base-game"]}]"#,
                BG,
                false,
                "a top-level array",
            ),
            row(r#"["base-game"]"#, BG, false, "a bare array"),
            row(r#""mr_ent""#, BG, false, "a top-level string"),
            row("null", BG, false, "null"),
            row("", BG, false, "empty input"),
            row("   ", BG, false, "only whitespace"),
            row("{", BG, false, "an open brace"),
            row("}", BG, false, "a close brace"),
            // The opening brace is required: members closed by a brace alone are not an object.
            row(
                r#""mr_ent":["base-game"]}"#,
                BG,
                false,
                "members with no opening brace",
            ),
            row(
                r#" "mr_ent":["base-game"]}"#,
                BG,
                false,
                "whitespace, then members with no opening brace",
            ),
            row(r#""mr_ent":["base-game"]"#, BG, false, "no braces at all"),
            row(
                r#""iss":"x","mr_ent":["base-game"]}"#,
                BG,
                false,
                "two members with no opening brace",
            ),
            row(r#"{"mr_ent":["base-game""#, BG, false, "the array unclosed"),
            row(
                r#"{"mr_ent":["base-game"]"#,
                BG,
                false,
                "the object unclosed",
            ),
            row(
                r#"{"mr_ent":["base-game"#,
                BG,
                false,
                "an unterminated string",
            ),
            row(
                r#"{"mr_ent":["base-game"]}x"#,
                BG,
                false,
                "trailing garbage",
            ),
            row(
                r#"{"mr_ent":["base-game"]}{}"#,
                BG,
                false,
                "a second object",
            ),
            row(
                r#"{"mr_ent":["base-game"]},"#,
                BG,
                false,
                "a trailing comma",
            ),
            row(r#"{"mr_ent" ["base-game"]}"#, BG, false, "no colon"),
            row(r#"{"a":1 "mr_ent":["base-game"]}"#, BG, false, "no comma"),
            row(
                r#"{"mr_ent":["base-game",]}"#,
                BG,
                false,
                "a comma closing the array",
            ),
            row(
                r#"{"mr_ent":["base-game"],}"#,
                BG,
                false,
                "a comma closing the object",
            ),
            row(
                r#"{,"mr_ent":["base-game"]}"#,
                BG,
                false,
                "a comma opening the object",
            ),
            row(
                r#"{"mr_ent":["base-game" "x"]}"#,
                BG,
                false,
                "no comma between elements",
            ),
            row(r#"{mr_ent:["base-game"]}"#, BG, false, "an unquoted key"),
            row(r#"{'mr_ent':['base-game']}"#, BG, false, "single quotes"),
            row(r#"{"mr_ent"}"#, BG, false, "a key with no value"),
            row(
                r#"{"a":nope,"mr_ent":["base-game"]}"#,
                BG,
                false,
                "a bare word before",
            ),
            row(
                r#"{"mr_ent":["base-game"],"a":nope}"#,
                BG,
                false,
                "a bare word after",
            ),
            row(
                r#"{"mr_ent":["base-game"],"a":"x}"#,
                BG,
                false,
                "a later string unterminated",
            ),
            row(
                r#"{"mr_ent":["base-game"],"a":[1,2}"#,
                BG,
                false,
                "a later array closed by a brace",
            ),
            row(
                r#"{"mr_ent":["base-game"],"a":{"b":1]}"#,
                BG,
                false,
                "a later object closed by a bracket",
            ),
            row(&deep, BG, false, "10,000 open brackets"),
            row(
                &deep_in_claim,
                BG,
                false,
                "10,000 open brackets as the claim",
            ),
            row(&deep_closed, BG, false, "the element 10,000 arrays deep"),
            row(&deep_open_objects, BG, false, "10,000 open objects"),
        ]);
    }

    /// The second argument is the entitlement asked about, compared whole.
    #[test]
    fn acs6_claim_the_entitlement_asked_is_honoured() {
        check(&[
            row(
                r#"{"mr_ent":["soundtrack"]}"#,
                BG,
                false,
                "another entitlement named",
            ),
            row(
                r#"{"mr_ent":["soundtrack"]}"#,
                "soundtrack",
                true,
                "the one named",
            ),
            row(
                r#"{"mr_ent":["base-game"]}"#,
                "soundtrack",
                false,
                "base-game named",
            ),
            row(
                r#"{"mr_ent":["base-game","soundtrack"]}"#,
                "soundtrack",
                true,
                "second of two",
            ),
            row(
                r#"{"mr_ent":["base-game"]}"#,
                "base",
                false,
                "a prefix asked",
            ),
            row(
                r#"{"mr_ent":["base-game"]}"#,
                "game",
                false,
                "a suffix asked",
            ),
            row(r#"{"mr_ent":["base-game"]}"#, "", false, "nothing asked"),
            row(
                r#"{"mr_ent":["base-game"]}"#,
                "base-game ",
                false,
                "a longer string asked",
            ),
            row(
                r#"{"mr_ent":[""]}"#,
                "",
                true,
                "the empty entitlement named and asked",
            ),
            row(
                r#"{"mr_ent":[""]}"#,
                BG,
                false,
                "the empty entitlement named",
            ),
        ]);
    }

    // --- the generated model ------------------------------------------------

    /// Top-level keys; index 0 is the claim's key.
    const KEYS: [&str; 6] = ["mr_ent", "iss", "aud", "mr_entx", "xmr_ent", "sub"];
    /// Array elements, as JSON text; index 0 is the entitlement itself.
    const ELEMS: [&str; 10] = [
        r#""base-game""#,
        r#""soundtrack""#,
        r#""base-game ""#,
        r#""xbase-game""#,
        r#""""#,
        r#""a\"b""#,
        "7",
        "null",
        r#"["base-game"]"#,
        r#"{"k":"]","base-game":["base-game"]}"#,
    ];
    /// String values, as JSON text; none is the claim.
    const STRS: [&str; 5] = [
        r#""x""#,
        r#""mr_ent""#,
        r#""\"mr_ent\":[\"base-game\"]""#,
        r#""a\\""#,
        r#""}]""#,
    ];
    const WS: [&str; 5] = ["", " ", "\n", "\t ", "\r\n"];

    /// One value of the model: `kind` 0 string, 1 number, 2 true, 3 null,
    /// 4 array of `elems`, 5 an object holding `mr_ent` with that array.
    #[derive(Clone, Debug)]
    struct JsonVal {
        kind: usize,
        string: usize,
        elems: Vec<usize>,
    }

    impl JsonVal {
        fn render(&self, ws: &str) -> String {
            let array = || {
                let parts: Vec<String> = self
                    .elems
                    .iter()
                    .map(|e| format!("{ws}{}{ws}", ELEMS[*e]))
                    .collect();
                format!("[{}]", parts.join(","))
            };
            match self.kind {
                0 => STRS[self.string].to_string(),
                1 => "12".to_string(),
                2 => "true".to_string(),
                3 => "null".to_string(),
                4 => array(),
                _ => format!(r#"{{{ws}"mr_ent"{ws}:{ws}{}{ws}}}"#, array()),
            }
        }

        fn names_the_claim(&self) -> bool {
            self.kind == 4 && self.elems.contains(&0)
        }
    }

    fn value() -> impl Strategy<Value = JsonVal> {
        (
            0usize..6,
            0..STRS.len(),
            proptest::collection::vec(0..ELEMS.len(), 0..4),
        )
            .prop_map(|(kind, string, elems)| JsonVal {
                kind,
                string,
                elems,
            })
    }

    /// Renders `{ "key": value, ... }` with `ws` around every token.
    fn render(members: &[(usize, JsonVal, usize)]) -> String {
        let parts: Vec<String> = members
            .iter()
            .map(|(k, v, w)| {
                let ws = WS[*w];
                format!(r#"{ws}"{}"{ws}:{ws}{}{ws}"#, KEYS[*k], v.render(ws))
            })
            .collect();
        format!("{}{{{}}}{}", WS[1], parts.join(","), WS[2])
    }

    fn member() -> impl Strategy<Value = (usize, JsonVal, usize)> {
        (0..KEYS.len(), value(), 0..WS.len())
    }

    /// A member whose key is never `mr_ent`.
    fn other_member() -> impl Strategy<Value = (usize, JsonVal, usize)> {
        (1..KEYS.len(), value(), 0..WS.len())
    }

    /// The claim's own member: an array holding the entitlement among others.
    fn claim_member() -> impl Strategy<Value = (usize, JsonVal, usize)> {
        (
            proptest::collection::vec(0..ELEMS.len(), 0..4),
            0usize..4,
            0..WS.len(),
        )
            .prop_map(|(mut elems, at, w)| {
                let at = at.min(elems.len());
                elems.insert(at, 0);
                (
                    0,
                    JsonVal {
                        kind: 4,
                        string: 0,
                        elems,
                    },
                    w,
                )
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        /// Any model: true exactly when one top-level member has the key
        /// `mr_ent` and its value is an array holding the entitlement.
        #[test]
        fn acs6_claim_agrees_with_the_model(
            members in proptest::collection::vec(member(), 0..6),
        ) {
            let text = render(&members);
            let claims: Vec<&JsonVal> = members
                .iter()
                .filter(|(k, _, _)| *k == 0)
                .map(|(_, v, _)| v)
                .collect();
            let want = claims.len() == 1 && claims[0].names_the_claim();
            prop_assert_eq!(token_names_entitlement(&text, BG), want, "{}", text);
        }

        /// The claim among other members, anywhere: true; and every strict
        /// prefix that stops before the closing brace: false.
        #[test]
        fn acs6_claim_found_anywhere_and_no_prefix_is_enough(
            others in proptest::collection::vec(other_member(), 0..5),
            claim in claim_member(),
            at in 0usize..6,
        ) {
            let mut members = others;
            let at = at.min(members.len());
            members.insert(at, claim);
            let text = render(&members);
            prop_assert!(token_names_entitlement(&text, BG), "{}", text);
            prop_assert!(!token_names_entitlement(&text, "soundtrack ") , "{}", text);
            let close = text.rfind('}').expect("the rendered object closes");
            for cut in 0..=close {
                prop_assert!(
                    !token_names_entitlement(&text[..cut], BG),
                    "a prefix of {} bytes of {}",
                    cut,
                    text
                );
            }
        }

        /// The claim plus a second top-level `mr_ent` of any value: false.
        #[test]
        fn acs6_claim_a_second_top_level_key_is_false(
            others in proptest::collection::vec(other_member(), 0..4),
            claim in claim_member(),
            second in value(),
            w in 0..WS.len(),
            order in any::<bool>(),
        ) {
            let mut members = others;
            let dup = (0usize, second, w);
            if order {
                members.push(claim);
                members.push(dup);
            } else {
                members.insert(0, dup);
                members.push(claim);
            }
            let text = render(&members);
            prop_assert!(!token_names_entitlement(&text, BG), "{}", text);
        }

        /// A payload naming the claim is true, and the same text with its
        /// first `{` (the outer object's) removed is false.
        #[test]
        fn acs6_claim_without_its_opening_brace_is_false(
            others in proptest::collection::vec(other_member(), 0..5),
            claim in claim_member(),
            at in 0usize..6,
        ) {
            let mut members = others;
            let at = at.min(members.len());
            members.insert(at, claim);
            let text = render(&members);
            prop_assert!(token_names_entitlement(&text, BG), "{}", text);
            let open = text.find('{').expect("the rendered object opens");
            let stripped = format!("{}{}", &text[..open], &text[open + 1..]);
            prop_assert!(!token_names_entitlement(&stripped, BG), "{}", stripped);
        }

        /// Arbitrary text never panics, and a true answer needs both quoted
        /// names in the text.
        #[test]
        fn acs6_claim_arbitrary_text_never_panics(
            text in r#"[\[\]{}":, a-z_\\-]{0,48}"#,
            any_text in any::<String>(),
        ) {
            for t in [&text, &any_text] {
                if token_names_entitlement(t, BG) {
                    prop_assert!(t.contains("\"mr_ent\"") && t.contains("\"base-game\""), "{}", t);
                }
            }
        }
    }
}

/// `entitled` and `require_entitled` over a real `ReducerContext` on the
/// in-memory host, with the profile an argument.
mod acs6_door {
    use super::acs6_profile::{feats, HOSTED_DEV, LOCAL_DEV, PRODUCTION};
    use crate::accounts::{
        build_profile, entitled, require_entitled, BuildProfile, ENTITLEMENT_BASE_GAME,
        ERR_OWNERSHIP_REQUIRED,
    };
    use crate::native_host_tests::{fixture, Fixture};
    use crate::schema::{
        Config, Player, PlayerHandle, PlayerSession, WorldAccess, WorldAccessRule, WorldAdmission,
    };
    use spacetimedb::{ConnectionId, Identity, Timestamp};

    const T0: i64 = 1_700_000_000_000;
    const CONN: u128 = 0xAC56_0001;
    const AUD: &str = r#""monster-realm""#;
    const CLAIM: &str = r#"["base-game"]"#;

    fn at(ms: i64) -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(ms * 1000)
    }

    /// Never `[0; 32]` (the dummy sender) and never the module identity.
    fn who() -> Identity {
        Identity::from_byte_array([0x6A; 32])
    }

    /// A JWT payload: `aud` and the `mr_ent` value are raw JSON.
    fn payload(iss: &str, aud: &str, ent: Option<&str>) -> String {
        let claim = ent.map(|e| format!(r#","mr_ent":{e}"#)).unwrap_or_default();
        format!(r#"{{"iss":"{iss}","sub":"sub-door","aud":{aud}{claim},"iat":1,"exp":2}}"#)
    }

    /// The token the host mints for a connection that brought none.
    fn host_minted() -> String {
        r#"{"iss":"localhost","sub":"host-sub","aud":["spacetimedb"],"iat":1}"#.to_string()
    }

    fn dev_enforcing() -> BuildProfile {
        build_profile(feats(&["dev_issuers"]))
    }

    /// `(entitled, require_entitled)` for `who()` over a client connection
    /// carrying `jwt` (`None`: no token at all).
    fn ask(fx: &Fixture, p: &BuildProfile, jwt: Option<&str>) -> (bool, Result<(), String>) {
        let e = fx.run_as_conn_at(who(), CONN, jwt, at(T0), |ctx| entitled(ctx, p));
        let r = fx.run_as_conn_at(who(), CONN, jwt, at(T0), |ctx| {
            require_entitled(ctx, p, "join_game")
        });
        (e, r)
    }

    /// The same over the internal context, which has no connection.
    fn ask_internal(fx: &Fixture, p: &BuildProfile) -> (bool, Result<(), String>) {
        let e = fx.run_as_at(who(), at(T0), |ctx| entitled(ctx, p));
        let r = fx.run_as_at(who(), at(T0), |ctx| require_entitled(ctx, p, "join_game"));
        (e, r)
    }

    fn refused() -> (bool, Result<(), String>) {
        (false, Err(ERR_OWNERSHIP_REQUIRED.to_string()))
    }

    fn admitted() -> (bool, Result<(), String>) {
        (true, Ok(()))
    }

    #[test]
    fn acs6_door_the_constants_hold_these_values() {
        assert_eq!(ERR_OWNERSHIP_REQUIRED, "ownership required");
        assert_eq!(ENTITLEMENT_BASE_GAME, "base-game");
    }

    /// A profile that does not enforce admits every caller and never reads the
    /// token: a payload that is not JSON at all, and one whose `aud` is a
    /// number (both panic in the SDK when read), are admitted.
    #[test]
    fn acs6_door_a_non_enforcing_profile_admits_everyone_without_reading_the_token() {
        let fx = fixture();
        for named in [
            &["open_join"][..],
            &["dev_reducers"][..],
            &["load_test_zones"][..],
        ] {
            let p = build_profile(feats(named));
            assert!(!p.enforces_ownership, "fixture: {named:?} does not enforce");
            assert_eq!(ask(&fx, &p, None), admitted(), "{named:?}: no token");
            assert_eq!(
                ask_internal(&fx, &p),
                admitted(),
                "{named:?}: no connection"
            );
            let host = host_minted();
            assert_eq!(
                ask(&fx, &p, Some(&host)),
                admitted(),
                "{named:?}: host token"
            );
            assert_eq!(
                ask(&fx, &p, Some("not json at all")),
                admitted(),
                "{named:?}: an unreadable payload"
            );
            let numeric = payload("localhost", "7", None);
            assert_eq!(
                ask(&fx, &p, Some(&numeric)),
                admitted(),
                "{named:?}: a numeric aud"
            );
        }
    }

    /// Under the dev-enforcing profile every caller without a dev-issuer token
    /// for this audience naming `base-game` is refused with the one error.
    ///
    /// kills: an always-true door; the issuer, audience or claim check dropped;
    /// a prefix, suffix or case-folded issuer match; a substring claim search.
    #[test]
    fn acs6_door_dev_enforcing_refuses_every_unentitled_caller() {
        let p = dev_enforcing();
        let cases: Vec<(&str, Option<String>)> = vec![
            ("no token", None),
            ("the host-minted token", Some(host_minted())),
            (
                "an unlisted issuer with the audience and the claim",
                Some(payload("localhost", AUD, Some(CLAIM))),
            ),
            (
                "the production issuer with the claim",
                Some(payload(PRODUCTION, AUD, Some(CLAIM))),
            ),
            (
                "a dev token without mr_ent",
                Some(payload(LOCAL_DEV, AUD, None)),
            ),
            (
                "a dev token naming another entitlement",
                Some(payload(LOCAL_DEV, AUD, Some(r#"["soundtrack"]"#))),
            ),
            (
                "a dev token with an empty mr_ent",
                Some(payload(HOSTED_DEV, AUD, Some("[]"))),
            ),
            (
                "a dev token with mr_ent a string",
                Some(payload(LOCAL_DEV, AUD, Some(r#""base-game""#))),
            ),
            (
                "a dev token with the claim nested",
                Some(payload(LOCAL_DEV, AUD, Some(r#"[["base-game"]]"#))),
            ),
            (
                "a dev token with the claim's text inside another value",
                Some(format!(
                    r#"{{"iss":"{LOCAL_DEV}","sub":"x\",\"mr_ent\":[\"base-game\"]","aud":{AUD}}}"#
                )),
            ),
            (
                "a dev token with the claim but another audience",
                Some(payload(LOCAL_DEV, r#"["other-app"]"#, Some(CLAIM))),
            ),
            (
                "a dev token with the claim and no audience",
                Some(payload(HOSTED_DEV, "[]", Some(CLAIM))),
            ),
            (
                "a dev issuer with a trailing slash",
                Some(payload(&format!("{LOCAL_DEV}/"), AUD, Some(CLAIM))),
            ),
            (
                "a dev issuer with a longer port",
                Some(payload(&format!("{LOCAL_DEV}5"), AUD, Some(CLAIM))),
            ),
            (
                "a dev issuer upper-cased",
                Some(payload(&LOCAL_DEV.to_uppercase(), AUD, Some(CLAIM))),
            ),
            (
                "a dev issuer's prefix",
                Some(payload("https://auth.monster-realm", AUD, Some(CLAIM))),
            ),
        ];
        for (label, jwt) in cases {
            let fx = fixture();
            assert_eq!(ask(&fx, &p, jwt.as_deref()), refused(), "{label}");
        }
        let fx = fixture();
        assert_eq!(ask_internal(&fx, &p), refused(), "no connection");
    }

    /// Under the dev-enforcing profile a token from either dev issuer, for this
    /// audience, naming `base-game` is admitted.
    #[test]
    fn acs6_door_dev_enforcing_admits_an_entitled_token_from_either_dev_issuer() {
        let p = dev_enforcing();
        let cases: Vec<(&str, String)> = vec![
            ("the local dev issuer", payload(LOCAL_DEV, AUD, Some(CLAIM))),
            (
                "the hosted dev issuer, aud a list",
                payload(HOSTED_DEV, r#"["other-app","monster-realm"]"#, Some(CLAIM)),
            ),
            (
                "the claim among others",
                payload(LOCAL_DEV, AUD, Some(r#"["soundtrack","base-game"]"#)),
            ),
        ];
        for (label, jwt) in cases {
            let fx = fixture();
            assert_eq!(ask(&fx, &p, Some(&jwt)), admitted(), "{label}");
        }
    }

    /// The official profile admits the production issuer's entitled token and
    /// no dev issuer's.
    #[test]
    fn acs6_door_official_admits_only_the_production_issuer() {
        let p = build_profile(feats(&["official"]));
        let fx = fixture();
        let prod = payload(PRODUCTION, AUD, Some(CLAIM));
        assert_eq!(
            ask(&fx, &p, Some(&prod)),
            admitted(),
            "production, entitled"
        );
        for (label, jwt) in [
            ("no token", None),
            (
                "local dev, entitled",
                Some(payload(LOCAL_DEV, AUD, Some(CLAIM))),
            ),
            (
                "hosted dev, entitled",
                Some(payload(HOSTED_DEV, AUD, Some(CLAIM))),
            ),
            ("production, no claim", Some(payload(PRODUCTION, AUD, None))),
            (
                "production, another audience",
                Some(payload(PRODUCTION, r#"["other-app"]"#, Some(CLAIM))),
            ),
        ] {
            assert_eq!(ask(&fx, &p, jwt.as_deref()), refused(), "official: {label}");
        }
        assert_eq!(ask_internal(&fx, &p), refused(), "official: no connection");
    }

    /// The world, default and conflict profiles trust no login issuer, so
    /// nobody is admitted.
    #[test]
    fn acs6_door_world_default_and_conflict_admit_nobody() {
        for named in [&["world"][..], &[][..], &["official", "world"][..]] {
            let p = build_profile(feats(named));
            let fx = fixture();
            for (label, jwt) in [
                ("no token", None),
                (
                    "production, entitled",
                    Some(payload(PRODUCTION, AUD, Some(CLAIM))),
                ),
                (
                    "local dev, entitled",
                    Some(payload(LOCAL_DEV, AUD, Some(CLAIM))),
                ),
                (
                    "hosted dev, entitled",
                    Some(payload(HOSTED_DEV, AUD, Some(CLAIM))),
                ),
                ("host-minted", Some(host_minted())),
            ] {
                assert_eq!(
                    ask(&fx, &p, jwt.as_deref()),
                    refused(),
                    "{named:?}: {label}"
                );
            }
            assert_eq!(ask_internal(&fx, &p), refused(), "{named:?}: no connection");
        }
    }

    /// The issuer is judged before the audience: a token from an issuer the
    /// profile does not list, whose `aud` is a number (the SDK panics reading
    /// it), is refused without a panic.
    #[test]
    fn acs6_door_an_untrusted_issuers_audience_is_never_read() {
        for (named, iss) in [
            (&["dev_issuers"][..], "localhost"),
            (&["official"][..], LOCAL_DEV),
            (&["world"][..], PRODUCTION),
        ] {
            let p = build_profile(feats(named));
            let fx = fixture();
            let jwt = payload(iss, "7", Some(CLAIM));
            assert_eq!(ask(&fx, &p, Some(&jwt)), refused(), "{named:?}: {iss}");
        }
    }

    /// The door writes nothing and reads only the caller's `world_account` row,
    /// and that only when the profile enforces ownership, the token does not
    /// entitle the caller and the profile names an account service. Every
    /// table it could consult holds a row for the caller, all writable. The
    /// account row says not entitled, so it never admits; the binding row is
    /// entitled under the dev key and is never read. Each `ask` runs the door
    /// twice (`entitled`, then `require_entitled`), and a read is one point
    /// find of the caller's one row, so a reading case reads exactly two rows.
    ///
    /// kills: a door that reads the account row before or regardless of the
    /// token, under a non-enforcing profile, or under a profile that names no
    /// service; a door that still reads `world_binding`; a door that writes any
    /// table; a door that consults any other table.
    #[test]
    fn acs6_door_writes_nothing_and_reads_the_callers_world_account_only_when_a_checking_profile_lacks_an_entitling_token_lpw23_7(
    ) {
        let fx = fixture();
        fx.table::<crate::schema::WorldBinding>("world_binding", "identity", |r| r.identity)
            .unique()
            .writable()
            .seed(&crate::schema::WorldBinding {
                identity: who(),
                account_subject: "sub-door".to_string(),
                bound_at_ms: T0,
                entitled: true,
                key_id: crate::accounts::DEV_ATTESTATION_KEYS[0].kid.to_string(),
            });
        fx.table::<crate::account_checks::WorldAccount>("world_account", "identity", |r| {
            r.identity
        })
        .unique()
        .writable()
        .seed(&crate::account_checks::WorldAccount {
            handle: "k1.DoorDoorDoor0123456789".to_string(),
            identity: who(),
            entitled: false,
            checked_at_ms: T0 - 1_000,
            is_host: false,
        });
        fx.table::<crate::schema::Account>("account", "identity", |r| r.identity)
            .writable()
            .seed(&super::base_account(0x6A));
        fx.table::<Player>("player", "identity", |r| r.identity)
            .writable()
            .seed(&Player {
                identity: who(),
                entity_id: 1,
                name: "Ada".to_string(),
                online: true,
                discriminator: 3,
                lead_level: 0,
            });
        fx.table::<WorldAdmission>("world_admission", "identity", |r| r.identity)
            .writable()
            .seed(&WorldAdmission {
                identity: who(),
                admitted_at_ms: T0,
            });
        fx.table_keyed::<Config, u32>("config", "id", |r| r.id)
            .writable()
            .seed(&Config {
                id: 0,
                content_version: 1,
                owner_identity: who(),
            });
        fx.table_keyed::<WorldAccess, u32>("world_access", "id", |r| r.id)
            .writable()
            .seed(&WorldAccess {
                id: 0,
                rule: WorldAccessRule::Open,
            });
        fx.table::<PlayerHandle>("player_handle", "owner_identity", |r| r.owner_identity)
            .writable()
            .seed(&PlayerHandle {
                owner_identity: who(),
                discriminator: 3,
            });
        fx.table::<PlayerSession>("player_session", "identity", |r| r.identity)
            .writable()
            .seed(&PlayerSession {
                connection_id: ConnectionId::from_u128(CONN),
                identity: who(),
            });
        const TABLES: [&str; 8] = [
            "account",
            "player",
            "world_admission",
            "config",
            "world_access",
            "player_handle",
            "player_session",
            "world_binding",
        ];
        let dev = dev_enforcing();
        let open = build_profile(feats(&["open_join"]));
        let official = build_profile(feats(&["official"]));
        let world = build_profile(feats(&["world"]));
        assert!(
            !open.enforces_ownership,
            "fixture: open_join does not enforce"
        );
        for (label, p) in [("dev", &dev), ("official", &official), ("world", &world)] {
            assert!(p.enforces_ownership, "fixture: {label} enforces");
        }
        assert!(
            dev.world_check_url.is_some(),
            "fixture: dev-enforcing names a service"
        );
        assert!(
            official.world_check_url.is_none(),
            "fixture: official names no service"
        );
        assert!(
            world.world_check_url.is_some(),
            "fixture: world names a service"
        );
        let entitled_jwt = payload(LOCAL_DEV, AUD, Some(CLAIM));
        let prod_jwt = payload(PRODUCTION, AUD, Some(CLAIM));
        // (label, profile, over the internal context, token, outcome, account rows read)
        let cases = vec![
            ("admitted, not enforcing", &open, false, None, admitted(), 0),
            (
                "admitted, not enforcing, no connection",
                &open,
                true,
                None,
                admitted(),
                0,
            ),
            (
                "admitted, enforcing, an entitling token",
                &dev,
                false,
                Some(entitled_jwt.as_str()),
                admitted(),
                0,
            ),
            (
                "refused, enforcing, no token, a service named",
                &dev,
                false,
                None,
                refused(),
                2,
            ),
            (
                "refused, enforcing, no connection, a service named",
                &dev,
                true,
                None,
                refused(),
                2,
            ),
            (
                "admitted, enforcing, an entitling token, no service",
                &official,
                false,
                Some(prod_jwt.as_str()),
                admitted(),
                0,
            ),
            (
                "refused, enforcing, no token, no service (official)",
                &official,
                false,
                None,
                refused(),
                0,
            ),
            (
                "refused, enforcing, no token, a service named (world)",
                &world,
                false,
                None,
                refused(),
                2,
            ),
            (
                "refused, enforcing, no connection, a service named (world)",
                &world,
                true,
                None,
                refused(),
                2,
            ),
        ];
        for (label, p, internal, jwt, want, account_reads) in cases {
            fx.reset_reads();
            fx.reset_writes();
            let got = if internal {
                ask_internal(&fx, p)
            } else {
                ask(&fx, p, jwt)
            };
            assert_eq!(got, want, "{label}");
            assert_eq!(
                fx.rows_read("world_account"),
                account_reads,
                "{label}: rows the door read from world_account"
            );
            assert_eq!(
                fx.writes_to("world_account"),
                0,
                "{label}: the door wrote world_account"
            );
            for t in TABLES {
                assert_eq!(fx.rows_read(t), 0, "{label}: the door read {t}");
                assert_eq!(fx.writes_to(t), 0, "{label}: the door wrote {t}");
            }
        }
    }

    /// `who()`'s checked account, as the account service last answered.
    fn account_row(
        who: Identity,
        entitled: bool,
        checked_at_ms: i64,
    ) -> crate::account_checks::WorldAccount {
        crate::account_checks::WorldAccount {
            handle: format!("k1.Door{}0123456789-_", who.to_byte_array()[0]),
            identity: who,
            entitled,
            checked_at_ms,
            is_host: false,
        }
    }

    /// On the enforcing dev build, a caller with no entitling token is admitted by its
    /// `world_account` row that says entitled, however old the row (checked at the epoch, or
    /// ten years before the call), and refused by one that says not entitled. A neighbour's
    /// entitled row admits only the neighbour.
    ///
    /// kills: `entitled` blind to `world_account`; a freshness bound on the stored row; the
    /// row's `entitled` ignored; a row read for another identity.
    #[test]
    fn an_entitled_world_account_row_admits_however_old_and_any_other_is_refused_lpw23_7() {
        let p = dev_enforcing();
        for (label, row, want) in [
            (
                "entitled, checked at the epoch",
                Some(account_row(who(), true, 0)),
                admitted(),
            ),
            (
                "entitled, checked ten years ago",
                Some(account_row(
                    who(),
                    true,
                    T0 - 10 * 365 * 24 * 60 * 60 * 1000,
                )),
                admitted(),
            ),
            (
                "entitled, checked now",
                Some(account_row(who(), true, T0)),
                admitted(),
            ),
            (
                "not entitled, checked now",
                Some(account_row(who(), false, T0)),
                refused(),
            ),
            ("no row", None, refused()),
        ] {
            let fx = fixture();
            let accounts = fx
                .table::<crate::account_checks::WorldAccount>("world_account", "identity", |r| {
                    r.identity
                })
                .unique();
            accounts.seed(&account_row(
                Identity::from_byte_array([0x6B; 32]),
                true,
                T0,
            ));
            if let Some(row) = row {
                accounts.seed(&row);
            }
            assert_eq!(ask(&fx, &p, None), want, "{label}");
            assert_eq!(ask_internal(&fx, &p), want, "{label}, no connection");
        }
    }

    /// On every enforcing build that names no account service (`official`, `default`,
    /// `conflict`), an entitled `world_account` row admits nobody.
    ///
    /// kills: `account_entitled` that ignores the profile.
    #[test]
    fn an_entitled_world_account_row_admits_nobody_on_a_build_that_names_no_service_lpw23_7() {
        for named in [&["official"][..], &[][..], &["official", "world"][..]] {
            let p = build_profile(feats(named));
            assert!(p.enforces_ownership, "fixture: {named:?} enforces");
            assert!(
                p.world_check_url.is_none(),
                "fixture: {named:?} names no service"
            );
            let fx = fixture();
            fx.table::<crate::account_checks::WorldAccount>("world_account", "identity", |r| {
                r.identity
            })
            .unique()
            .seed(&account_row(who(), true, T0));
            assert_eq!(ask(&fx, &p, None), refused(), "{named:?}");
        }
    }
}

/// The `mr_build_profile` section text, byte for byte, for the profiles that
/// matter, and its length for every feature set.
mod acs6_section {
    use super::acs6_profile::{all_feature_sets, NONE};
    use crate::accounts::{
        build_profile, profile_section, profile_section_len, BuildFeatures, BuildProfile,
    };

    /// `(section length, section bytes)` of a profile built at compile time.
    macro_rules! section_of {
        ($profile:expr) => {{
            const P: BuildProfile = $profile;
            const N: usize = profile_section_len(&P);
            (N, profile_section::<N>(&P).to_vec())
        }};
    }

    fn assert_section(got: (usize, Vec<u8>), want: &str, label: &str) {
        assert_eq!(
            String::from_utf8_lossy(&got.1),
            want,
            "{label}: the section text"
        );
        assert_eq!(got.1, want.as_bytes(), "{label}: the section bytes");
        assert_eq!(got.0, want.len(), "{label}: the section length");
    }

    #[test]
    fn acs6_section_official() {
        assert_section(
            section_of!(build_profile(BuildFeatures {
                official: true,
                ..NONE
            })),
            "profile=official\nenforces_ownership=true\ndev_reducers=false\n\
             login_issuer=https://auth.monster-realm.invalid/\n",
            "official",
        );
    }

    #[test]
    fn acs6_section_world() {
        assert_section(
            section_of!(build_profile(BuildFeatures {
                world: true,
                ..NONE
            })),
            "profile=world\nenforces_ownership=true\ndev_reducers=false\n",
            "world",
        );
    }

    #[test]
    fn acs6_section_dev_enforcing() {
        assert_section(
            section_of!(build_profile(BuildFeatures {
                dev_issuers: true,
                ..NONE
            })),
            "profile=dev-enforcing\nenforces_ownership=true\ndev_reducers=false\n\
             login_issuer=http://localhost:4455\n\
             login_issuer=https://auth.monster-realm.spookyowltech.com\n",
            "dev-enforcing",
        );
    }

    #[test]
    fn acs6_section_test() {
        assert_section(
            section_of!(build_profile(BuildFeatures {
                open_join: true,
                ..NONE
            })),
            "profile=test\nenforces_ownership=false\ndev_reducers=false\n\
             login_issuer=http://localhost:4455\n\
             login_issuer=https://auth.monster-realm.spookyowltech.com\n",
            "test",
        );
        assert_section(
            section_of!(build_profile(BuildFeatures {
                dev_reducers: true,
                ..NONE
            })),
            "profile=test\nenforces_ownership=false\ndev_reducers=true\n\
             login_issuer=http://localhost:4455\n\
             login_issuer=https://auth.monster-realm.spookyowltech.com\n",
            "test with the dev reducers",
        );
    }

    #[test]
    fn acs6_section_default_and_conflict() {
        assert_section(
            section_of!(build_profile(NONE)),
            "profile=default\nenforces_ownership=true\ndev_reducers=false\n",
            "default",
        );
        assert_section(
            section_of!(build_profile(BuildFeatures {
                official: true,
                world: true,
                ..NONE
            })),
            "profile=conflict\nenforces_ownership=true\ndev_reducers=false\n",
            "conflict",
        );
    }

    /// For every feature set the section length is the length of the text
    /// rendered here from that profile's fields.
    #[test]
    fn acs6_section_length_for_every_feature_set() {
        for f in all_feature_sets() {
            let p = build_profile(f);
            let mut text = format!(
                "profile={}\nenforces_ownership={}\ndev_reducers={}\n",
                p.name, p.enforces_ownership, p.dev_reducers
            );
            for issuer in p.login_issuers {
                text.push_str(&format!("login_issuer={issuer}\n"));
            }
            assert_eq!(profile_section_len(&p), text.len(), "{f:?}");
        }
    }
}
