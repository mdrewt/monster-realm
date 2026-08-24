//! M22 slice S1 — gating tests for `game-core/src/accounts/deletion.rs`
//! (spec `M22-privacy-compliance.spec.md` §4.3, §4.5, §4.7, §5, §8.1).
//!
//! Declared from `accounts/mod.rs` as `#[cfg(test)] pub mod deletion_tests;`
//! (the `combat/mod.rs` / `npc/mod.rs` idiom) — a sibling module of
//! `deletion`, so the file body is the module itself (no wrapping `mod {}`,
//! mirroring `combat/m14a_tests.rs`).
//!
//! RED-first: `deletion.rs` does not exist yet. This file will not compile
//! until the implementer adds `DELETION_GRACE_MS_DEFAULT`, `is_deletion_due`,
//! `TOMBSTONE_IDENTITY_BYTES`, `TOMBSTONE_AUTH_ISSUER`, `EXPORT_CHUNK_ROWS`,
//! and `STATE_TRANSITION_OWNERS` — that is intentional (m17.5e / m16.5f
//! precedent: a RED test module that references not-yet-existing symbols).
//!
//! Style precedent: `game-core/src/combat/pvp.rs:94-380`'s `CHALLENGE_TTL_MS`
//! / `is_challenge_stale` suite (`mod pvp_tests` / `mod challenge_ttl_tests`)
//! — doc-comment-per-test naming the criterion and the mutation KILLED,
//! boundaries expressed as `CONST +/- 1` never as bare numeric literals, and
//! an `assert_ne!` transition tooth that catches both constant-body mutants
//! in one assertion.
//!
//! Rules enforced across this whole file (not just individual tests):
//!   - No test spells a numeric grace literal; every boundary is
//!     `DELETION_GRACE_MS_DEFAULT +/- 1` (or a scaled offset of it), so an
//!     operator retune of the constant is a zero-churn edit to this suite.
//!   - At least half of the `Some(..)` cases below use a NON-ZERO
//!     `requested_at_ms`, so the epoch-relative mutant
//!     (`now_ms >= DELETION_GRACE_MS_DEFAULT`, ignoring `requested_at_ms`) is
//!     distinguishable — with `t = 0` it is byte-identical to the correct fn.
//!   - No `#[should_panic]` anywhere: it prints `... ok` identically to a
//!     pass in CI output and is invisible to a gate that scans for FAILED.

use crate::accounts::deletion::{
    is_deletion_due, DELETION_GRACE_MS_DEFAULT, EXPORT_CHUNK_ROWS, STATE_TRANSITION_OWNERS,
    TOMBSTONE_AUTH_ISSUER, TOMBSTONE_IDENTITY_BYTES,
};

// ===========================================================================
// is_deletion_due — Some(..) branch: grace-window boundary (spec §4.3)
// ===========================================================================

/// PRV1 §4.3 BOUNDARY: one ms before the grace window elapses -> not due.
///
/// kills: an off-by-one that uses `>` mirrored the wrong way (marking a
/// request due one ms early), or an impl that hardcodes a different literal
/// than the named constant.
#[test]
fn not_due_one_ms_before_grace() {
    assert!(
        !is_deletion_due(Some(0), DELETION_GRACE_MS_DEFAULT - 1),
        "elapsed = GRACE - 1 ms since the request: not yet due, must return false"
    );
}

/// PRV1 §4.3 BOUNDARY: exactly at the grace window -> due (`>=` semantics,
/// mirroring `is_challenge_stale`'s boundary rule).
///
/// kills: an impl that uses `>` instead of `>=` (would read exactly-at-grace
/// as still fresh).
#[test]
fn due_at_exact_grace() {
    assert!(
        is_deletion_due(Some(0), DELETION_GRACE_MS_DEFAULT),
        "elapsed = GRACE ms since the request: due at exactly the boundary (>=), must return true"
    );
}

/// PRV1 §4.3 BOUNDARY: one ms past the grace window -> due.
///
/// kills: an impl that uses `==` instead of `>=` (accepts only the exact
/// boundary and reads everything past it as not due).
#[test]
fn due_past_grace() {
    assert!(
        is_deletion_due(Some(0), DELETION_GRACE_MS_DEFAULT + 1),
        "elapsed = GRACE + 1 ms since the request: past the boundary, must return true"
    );
}

/// PRV1 §4.3: at the exact instant of the request (elapsed = 0), never due.
///
/// kills: a zero (or effectively zero) grace window — if the implementation
/// hardcodes or defaults the comparison so that elapsed = 0 already reads as
/// due, this fixture catches it directly, independent of what
/// `DELETION_GRACE_MS_DEFAULT` is tuned to.
#[test]
fn not_due_at_the_request_instant() {
    let t: i64 = 1_000_000;
    assert!(
        !is_deletion_due(Some(t), t),
        "elapsed = 0 at the request instant itself: must never be due"
    );
}

/// PRV1 §4.3: due-ness is relative to `requested_at_ms`, not to the raw
/// epoch value of `now_ms`.
///
/// kills: the plausible lazy impl `now_ms >= DELETION_GRACE_MS_DEFAULT` that
/// silently ignores `requested_at_ms` entirely. That mutant is
/// byte-identical to the correct fn on every `Some(0)` case (see the three
/// boundary tests above) — it only diverges when `requested_at_ms` is
/// non-zero AND `now_ms` alone would already clear the raw `GRACE` threshold
/// even though the *elapsed* time since the request has not.
///
/// Here `t = 1_000_000` (deliberately non-zero) and `now = GRACE` exactly:
///   - correct:  elapsed = GRACE - t < GRACE          -> false (not due)
///   - lazy mutant: now (== GRACE) >= GRACE            -> true  (WRONG)
#[test]
fn due_is_relative_to_the_request_not_the_epoch() {
    let t: i64 = 1_000_000;
    assert!(
        !is_deletion_due(Some(t), DELETION_GRACE_MS_DEFAULT),
        "elapsed since the request (GRACE - t) is less than GRACE, so this must be false even \
         though now_ms alone (== GRACE) would clear a raw, request-blind GRACE threshold — a \
         lazy `now_ms >= GRACE` impl that ignores requested_at_ms wrongly returns true here"
    );
}

/// PRV1 §4.3 CLOCK SKEW: a future-dated request (`requested_at_ms > now_ms`)
/// must never be due.
///
/// kills: an impl that measures elapsed via `(now_ms - requested_at_ms).abs()`
/// instead of a signed, direction-aware subtraction. `.abs()` misclassifies
/// clock skew as elapsed time (turning a future-dated request into an
/// apparently-overdue one) and additionally panics under
/// `[profile.release] overflow-checks = true` (workspace `Cargo.toml:65-66`)
/// when `requested_at_ms` is near `i64::MIN` — a panic here would abort the
/// deletion reaper's transaction in production.
#[test]
fn not_due_when_the_request_is_future_dated() {
    let now: i64 = 5_000;
    let requested_at_ms = now + DELETION_GRACE_MS_DEFAULT + 1;
    assert!(
        !is_deletion_due(Some(requested_at_ms), now),
        "requested_at_ms is in now's future: elapsed is negative, must never read as due"
    );
}

/// PRV1 §4.3 EXTREMES: a far-future request evaluated at `i64::MAX` must
/// still read as not due.
///
/// kills: the add-form `t.saturating_add(GRACE) <= now` (compute the
/// deadline by adding GRACE to the request, rather than subtracting the
/// request from now). Near `i64::MAX`, `t.saturating_add(GRACE)` SATURATES
/// DOWN to `i64::MAX` instead of overflowing past it, so a request that is
/// genuinely still far from due reads as `deadline == now` -> due. This is
/// the real bug shape observed at `server-module/src/accounts.rs:102-109`.
#[test]
fn not_due_near_i64_max_kills_the_add_form() {
    assert!(
        !is_deletion_due(Some(i64::MAX - 100), i64::MAX),
        "a request 100ms before i64::MAX, evaluated at i64::MAX: elapsed is only 100ms, far \
         short of GRACE, must be false; the add-form deadline calculation saturates down to \
         i64::MAX here and wrongly reads this as due"
    );
}

/// PRV1 §4.3 EXTREMES: both saturation directions must resolve without a
/// panic, and resolve to the CORRECT side of due-ness, not the same answer
/// in both directions.
///
/// kills: `wrapping_sub` (wraps instead of saturating; wrong-direction
/// overflow near `i64::MIN` produces a small value instead of a huge one,
/// misreading a genuinely-overdue request as fresh) and
/// `checked_sub(..).unwrap_or(i64::MAX)` (collapses BOTH overflow directions
/// to "always overdue" — `unwrap_or` fires identically whether the true
/// elapsed time is enormous or deeply negative, so a future-dated request at
/// the extreme would ALSO read as due).
#[test]
fn extremes_saturate_in_both_directions_without_panic() {
    assert!(
        is_deletion_due(Some(i64::MIN), i64::MAX),
        "requested at i64::MIN, evaluated at i64::MAX: elapsed saturates at i64::MAX, which is \
         far past GRACE, must be true"
    );
    assert!(
        !is_deletion_due(Some(i64::MAX), i64::MIN),
        "requested at i64::MAX (the far future), evaluated at i64::MIN: elapsed saturates at \
         i64::MIN (a huge negative), which is nowhere near due, must be false — \
         checked_sub(..).unwrap_or(i64::MAX) wrongly collapses this case to true"
    );
}

/// PRV1 §4.3 TEETH: crossing the grace boundary must flip the result. A
/// single `assert_ne!` kills both a constant-`true`-body mutant and a
/// constant-`false`-body mutant in one assertion (the `pvp.rs:364-372`
/// `teeth_boundary_is_a_real_transition` tooth, applied here).
///
/// `B` is deliberately non-zero so this also exercises the request-relative
/// (not epoch-relative) code path.
#[test]
fn crossing_the_boundary_flips_the_result() {
    let b: i64 = 1_000_000;
    assert_ne!(
        is_deletion_due(Some(b), b + DELETION_GRACE_MS_DEFAULT - 1),
        is_deletion_due(Some(b), b + DELETION_GRACE_MS_DEFAULT),
        "TEETH: crossing the GRACE boundary must flip the result (not due -> due); a \
         constant-body impl (always true or always false) returns the same value on both sides"
    );
}

// ===========================================================================
// is_deletion_due — None branch: a cancelled deletion is never due
// (spec §4.5 — cancel-account-deletion clears the request timestamp)
// ===========================================================================

/// PRV1 §4.5: `None` (no pending deletion request) is never due, at any
/// `now_ms`, including both `i64` extremes.
///
/// kills: an impl that treats `None` as "request happened at time 0" instead
/// of "no request exists" (would read `None` as due once `now_ms >= GRACE`).
#[test]
fn none_is_never_due_at_zero_and_both_extremes() {
    assert!(!is_deletion_due(None, 0), "None at now=0 must be false");
    assert!(
        !is_deletion_due(None, i64::MIN),
        "None at now=i64::MIN must be false"
    );
    assert!(
        !is_deletion_due(None, i64::MAX),
        "None at now=i64::MAX must be false"
    );
}

/// PRV1 §4.5/§8.1: `DELETION_GRACE_MS_DEFAULT` must be strictly positive, so
/// `None` cannot be silently aliased to "always due" by a disguised
/// `None => DELETION_GRACE_MS_DEFAULT == 0` arm.
///
/// This is not a tautology check on the constant's sign for its own sake —
/// it kills a specific hazard the red-team measured: an implementation that
/// special-cases `None => elapsed = DELETION_GRACE_MS_DEFAULT` (satisfying
/// the `>=` boundary trivially, always true) passes every OTHER test in this
/// file today, because none of them separately probe what `None` maps to
/// internally versus what it returns externally. If an operator ever
/// (mis)configures the grace constant to `0`, that disguised arm's output
/// would flip from "coincidentally false" to "always cascade every
/// cancelled account" with zero other observable change — this assertion
/// is what pins the constant away from that trap independent of the
/// operator's eventual §8.1 numeric choice.
#[test]
fn grace_default_is_positive_so_none_cannot_alias_true() {
    assert!(
        DELETION_GRACE_MS_DEFAULT > 0,
        "DELETION_GRACE_MS_DEFAULT must be a strictly positive placeholder (spec §8.1: an \
         honest, operator-tunable default, never zero) so a None->GRACE aliasing bug cannot \
         hide behind a future zero retune"
    );
}

// ===========================================================================
// TOMBSTONE_IDENTITY_BYTES — the battle-row anonymization sentinel
// (spec §3 "battle" ANONYMIZE entry, §4.5's TOMBSTONE_IDENTITY discussion)
// ===========================================================================

/// PRV1 §3/§4.5: the tombstone identity must NOT be the all-zero sentinel.
///
/// The zero array is written INLINE as a literal here (never lifted into a
/// named `WILD_IDENTITY_BYTES` const in game-core) — a second, game-core-side
/// copy of server-module's `WILD_IDENTITY` value would itself be a second
/// source of truth for that constant, and would make this assertion a
/// same-file tautology instead of a real comparison.
///
/// Cites `server-module/src/lib.rs:84`:
///   `pub(crate) const WILD_IDENTITY: Identity = Identity::from_byte_array([0u8; 32]);`
///
/// The CROSS-CRATE half of this invariant (that game-core's tombstone value
/// really does differ from server-module's live `WILD_IDENTITY` constant, not
/// just from a literal written here) is proven by acceptance gate `[X4]`
/// (or its slice-S2/S6 equivalent), which reads that declaration out of
/// `server-module/src/lib.rs` with an anchored regex. **This test must not
/// be pruned as "tautological"** — it is the game-core-side anchor that
/// gate pins against; removing it does not remove redundancy, it removes
/// one side of the pin.
#[test]
fn tombstone_identity_bytes_is_not_the_wild_zero_sentinel() {
    assert_ne!(
        TOMBSTONE_IDENTITY_BYTES,
        [0u8; 32],
        "TOMBSTONE_IDENTITY_BYTES must not equal the all-zero WILD_IDENTITY sentinel \
         (server-module/src/lib.rs:84) — a zero-valued tombstone would reclassify every \
         anonymized PvP battle as a wild battle to guards.rs's opponent_identity != \
         WILD_IDENTITY checks"
    );
}

/// PRV1 §3/§4.5: the tombstone identity is pinned to the exact all-`0xFF`
/// byte vector the spec names (§3's `battle` ANONYMIZE entry: "e.g.
/// `[0xFFu8; 32]`").
///
/// kills: any other non-zero-but-arbitrary sentinel value that would pass
/// `tombstone_identity_bytes_is_not_the_wild_zero_sentinel` but silently
/// drift from the value S2/S3 are built against.
#[test]
fn tombstone_identity_bytes_is_pinned_to_the_all_ff_vector() {
    assert_eq!(
        TOMBSTONE_IDENTITY_BYTES,
        [0xFFu8; 32],
        "TOMBSTONE_IDENTITY_BYTES must be pinned to the all-0xFF 32-byte vector"
    );
}

// ===========================================================================
// TOMBSTONE_AUTH_ISSUER — the account.auth_issuer sentinel (spec §3 "account")
// ===========================================================================

/// PRV1 §3: the tombstone auth-issuer sentinel must be non-empty and not
/// whitespace-only.
///
/// kills: an impl that defaults the constant to `""` (or all-whitespace),
/// which would make `account.auth_issuer` indistinguishable from an
/// unset/blank field after anonymization.
#[test]
fn tombstone_auth_issuer_is_non_empty() {
    assert!(
        !TOMBSTONE_AUTH_ISSUER.is_empty(),
        "TOMBSTONE_AUTH_ISSUER must not be the empty string"
    );
    assert!(
        !TOMBSTONE_AUTH_ISSUER.trim().is_empty(),
        "TOMBSTONE_AUTH_ISSUER must not be whitespace-only"
    );
}

/// PRV1 §3: the tombstone auth-issuer sentinel must not resemble a URL.
///
/// `auth_issuer` is otherwise populated with real OAuth issuer values (a
/// scheme + host, e.g. an issuer URL); a sentinel that ALSO looks like a URL
/// risks being read downstream as a live, resolvable issuer. Checked via
/// `char` literals only — the colon-slash-slash sequence itself is never
/// spelled anywhere in this file, including comments, because remote-only
/// Semgrep/gitleaks match raw text (including comment text) and `just ci`
/// cannot catch that locally.
#[test]
fn tombstone_auth_issuer_has_no_url_punctuation() {
    assert!(
        !TOMBSTONE_AUTH_ISSUER.contains('/'),
        "TOMBSTONE_AUTH_ISSUER must not contain a forward slash"
    );
    assert!(
        !TOMBSTONE_AUTH_ISSUER.contains(':'),
        "TOMBSTONE_AUTH_ISSUER must not contain a colon"
    );
}

// ===========================================================================
// EXPORT_CHUNK_ROWS — export sub-chunking boundary (spec §5)
// ===========================================================================

/// PRV1 §5: `EXPORT_CHUNK_ROWS` must be non-zero.
///
/// A zero chunk size makes S4's row-count sub-chunking (`slice::chunks(0)`
/// or equivalent) PANIC — `chunks(0)` is documented to panic unconditionally
/// on a zero chunk size, regardless of slice length, so this would take down
/// `request_data_export` for every account, not just large ones.
#[test]
fn export_chunk_rows_is_non_zero() {
    assert!(
        EXPORT_CHUNK_ROWS > 0,
        "EXPORT_CHUNK_ROWS must be non-zero: a zero chunk size panics S4's row-count \
         sub-chunking (slice::chunks(0) panics unconditionally)"
    );
}

/// PRV1 §5: `EXPORT_CHUNK_ROWS` is pinned at the spec's proposed value, 500.
#[test]
fn export_chunk_rows_is_pinned_at_five_hundred() {
    assert_eq!(
        EXPORT_CHUNK_ROWS, 500,
        "EXPORT_CHUNK_ROWS must be pinned at 500 per spec §5"
    );
}

// ===========================================================================
// STATE_TRANSITION_OWNERS — the §4.7 gate-exemption allowlist
// ===========================================================================

/// PRV1 §4.7: `STATE_TRANSITION_OWNERS` is EXACTLY the three spec-named
/// reducers — no more, no fewer — checked against an INDEPENDENTLY written
/// literal array (never a re-reference to the const itself, which would make
/// this a tautology).
#[test]
fn state_transition_owners_is_exactly_the_three_spec_reducers() {
    let expected: [&str; 3] = [
        "delete_account",
        "cancel_account_deletion",
        "account_deletion_reaper",
    ];
    assert_eq!(
        STATE_TRANSITION_OWNERS.len(),
        3,
        "STATE_TRANSITION_OWNERS must contain exactly 3 entries"
    );
    for name in expected {
        assert!(
            STATE_TRANSITION_OWNERS.contains(&name),
            "STATE_TRANSITION_OWNERS is missing spec-required entry {name:?}"
        );
    }
    for actual in STATE_TRANSITION_OWNERS {
        assert!(
            expected.contains(actual),
            "STATE_TRANSITION_OWNERS contains an entry not in the spec's exact 3-reducer set: \
             {actual:?}"
        );
    }
}

/// PRV1 §4.7 TEETH: the exemption list admits no empty string, no `"*"`
/// wildcard, no duplicate entries, and no ordinary gameplay reducer.
///
/// Under S6's `[DEL-06]` prefix-matching CI scan, an empty or `"*"` entry
/// would exempt EVERY reducer that writes a manifest-classified table from
/// the deletion gate — silently turning a targeted 3-reducer allowlist into
/// a blanket bypass. `propose_trade`/`start_battle` are chosen as negative
/// membership probes because both write manifest-classified tables
/// (`trade_offer` is ERASE-policy; battle-start writes classified tables via
/// the PvP/battle path) and MUST go through the `should_reject_for_deletion`
/// gate rather than being exempt.
#[test]
fn state_transition_owners_admits_no_empty_wildcard_or_gameplay_entry() {
    assert!(
        !STATE_TRANSITION_OWNERS.iter().any(|s| s.is_empty()),
        "STATE_TRANSITION_OWNERS must not contain an empty-string entry"
    );
    assert!(
        !STATE_TRANSITION_OWNERS.contains(&"*"),
        "STATE_TRANSITION_OWNERS must not contain a \"*\" wildcard entry"
    );

    let mut seen = std::collections::HashSet::new();
    for name in STATE_TRANSITION_OWNERS {
        assert!(
            seen.insert(name),
            "STATE_TRANSITION_OWNERS contains a duplicate entry: {name:?}"
        );
    }

    assert!(
        !STATE_TRANSITION_OWNERS.contains(&"propose_trade"),
        "STATE_TRANSITION_OWNERS must not exempt propose_trade — it writes an ERASE-policy \
         table (trade_offer) and must go through the deletion gate, not around it"
    );
    assert!(
        !STATE_TRANSITION_OWNERS.contains(&"start_battle"),
        "STATE_TRANSITION_OWNERS must not exempt start_battle — it writes manifest-classified \
         tables and must go through the deletion gate, not around it"
    );
}
