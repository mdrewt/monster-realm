//! Pure account-deletion and data-export contract surface (M22, ADR-0031).
//!
//! Everything here is deterministic, I/O-free and framework-free — no database
//! crate types, no reducer context, no tables. The imperative shell
//! that actually flips `account` rows, anonymizes `battle`, erases
//! ERASE-policy tables and streams export chunks lives in
//! `server-module/src/accounts.rs` and calls into these helpers, so the
//! grace-window rule, the anonymization sentinels, the export chunk size and
//! the state-transition exemption list are each written exactly once.
//!
//! Spec `M22-privacy-compliance.spec.md` §4.3 (deletion grace window and its
//! reaper), §4.5 (cancellation clears the request), §4.7 (the deletion gate
//! and its declared exemptions), §5 (data export sub-chunking) and §8.1
//! (unresolved escalations — see the note on `DELETION_GRACE_MS_DEFAULT`).

// ===========================================================================
// Deletion grace window (spec §4.3, §4.5, §8.1)
// ===========================================================================

/// Grace window between a deletion request and irreversible erasure, in ms
/// (spec §4.3, §4.5, §8.1; ADR-0031).
//
// HONESTY NOTE — 7 days (604_800_000 ms) is an arbitrary placeholder. It was
// picked only because it is a legible, operationally sane duration that gives
// a player a real chance to change their mind; there is no sourced basis for
// it in this repo or in either research library, and the M22 ceremony
// explicitly refused to borrow a figure from an incomparable consumer service
// reported at second hand. Spec §8.1 escalation #1 is UNRESOLVED — the
// operator picks the real number. `_DEFAULT` here means "the literal an
// operator replaces", NOT that a runtime override column exists; S2 must not
// invent one.
pub const DELETION_GRACE_MS_DEFAULT: i64 = 604_800_000;

/// Is a pending deletion request past its grace window at `now_ms`?
///
/// Elapsed time is measured RELATIVE to the request
/// (`now_ms - requested_at_ms`), never as an absolute instant — a request-blind
/// `now_ms >= DELETION_GRACE_MS_DEFAULT` test would mark every account due once
/// the epoch clock passed the raw threshold. The boundary is `>=`, matching
/// `is_challenge_stale`: at exactly `DELETION_GRACE_MS_DEFAULT` elapsed the
/// request is due.
///
/// `None => false` is load-bearing, not a defensive default. PRV1-3 CLEARS
/// `deletion_requested_at_ms` when a player cancels, so `None` IS the
/// cancelled (and the never-requested) state. A `None => true` arm would make
/// the reaper cascade over every cancelled and every ordinary account.
///
/// The subtraction saturates in both directions. A future-dated request
/// (clock skew) yields a negative elapsed value and reads as not due; the
/// `i64` extremes clamp instead of overflowing, which matters because
/// `[profile.release] overflow-checks = true` (workspace `Cargo.toml:65-66`)
/// turns a wrapping subtraction into a panic that would abort the reaper's
/// whole transaction in production.
#[must_use]
pub fn is_deletion_due(requested_at_ms: Option<i64>, now_ms: i64) -> bool {
    match requested_at_ms {
        None => false,
        Some(requested) => now_ms.saturating_sub(requested) >= DELETION_GRACE_MS_DEFAULT,
    }
}

// ===========================================================================
// Anonymization sentinels (spec §3, §4.5)
// ===========================================================================

/// Sentinel identity bytes stamped onto anonymized rows (spec §3, §4.5).
//
// SSOT: server-module must derive its `Identity` const as
// `Identity::from_byte_array(game_core::TOMBSTONE_IDENTITY_BYTES)`, never a
// second hand-typed `[0xFFu8; 32]` literal — the `MAX_PARTY_SIZE` /
// `PARTY_SLOT_NONE` precedent at `server-module/src/lib.rs:77,80`.
// PLACEMENT: that const belongs beside `WILD_IDENTITY`
// (`server-module/src/lib.rs:84`), NOT in `accounts.rs`, whose
// `[R/identity-ctor]` clause in `evals/guest-claim-integrity.eval.mjs` flatly
// bans `Identity::from_byte_array(` in that file. Distinct by construction
// from `WILD_IDENTITY`'s all-zero value, so an anonymized PvP battle is never
// reclassified as a wild battle.
pub const TOMBSTONE_IDENTITY_BYTES: [u8; 32] = [0xFF; 32];

/// Sentinel written to `account.auth_issuer` on anonymization (spec §3).
//
// Deliberately not shaped like a live OAuth issuer value: no scheme
// punctuation, no host separator, so nothing downstream can mistake it for a
// resolvable issuer. Non-empty so the field stays distinguishable from an
// unset one.
pub const TOMBSTONE_AUTH_ISSUER: &str = "account-deleted-tombstone";

// ===========================================================================
// Data export (spec §5)
// ===========================================================================

/// Rows per data-export sub-chunk (spec §5).
//
// Non-zero is load-bearing: S4 sub-chunks with `slice::chunks(..)`, which
// panics unconditionally on a zero chunk size. `u32` matches this repo's
// schema convention for every count field — `server-module/src/schema.rs`
// declares zero `usize` columns — so S4 casts to `usize` only at the
// `.chunks()` call site rather than storing a platform-width count.
pub const EXPORT_CHUNK_ROWS: u32 = 500;

// ===========================================================================
// Deletion-gate exemptions (spec §4.7)
// ===========================================================================

/// Reducers exempt from the §4.7 deletion gate (spec §4.7).
//
// A DECLARED, gate-checked exemption list — not an ad-hoc allowlist. S6's
// `[DEL-06]` CI scan consumes it verbatim, so adding an entry here EXEMPTS
// that reducer from `should_reject_for_deletion` and is a security-relevant
// change. These three are the only reducers that legitimately act on an
// account while its deletion is pending, because they are the ones that own
// the state transition itself.
pub const STATE_TRANSITION_OWNERS: &[&str] = &[
    "delete_account",
    "cancel_account_deletion",
    "account_deletion_reaper",
];
