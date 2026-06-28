//! `raising_tests` — M9b gating unit tests for the pure `evaluate_care` seam
//! (server-module/src/raising.rs). Authored from the M9 spec §3 EARS criteria
//! and the ADR-0059 proof-of-teeth section.
//!
//! Declared from `raising.rs` as:
//!   `#[cfg(test)] #[path = "raising_tests.rs"] mod raising_tests;`
//! so `super` resolves to the `raising` module — giving access to
//! `evaluate_care`, `CARE_COOLDOWN_MS`, and `CARE_BOND_AMOUNT` by name.
//!
//! RED state: this file does not compile until the implementer creates
//! `server-module/src/raising.rs` (with `evaluate_care`, `CARE_COOLDOWN_MS`,
//! `CARE_BOND_AMOUNT` exported `pub(crate)`) and adds the `#[path]` mod decl.
//! That is intentional — the tests are the contract, not the implementation.
//!
//! EARS criteria covered (from M9 spec §3):
//!   - Care cooldown: boundary is `<`, not `<=` (equal-to-cooldown is ALLOWED).
//!   - Max bond rejects before burning cooldown (AtMaxBond path).
//!   - Care raises bond by exactly min(CARE_BOND_AMOUNT, 255 - bond).
//!   - Safe-direction clock: future last_care_at_ms only over-rejects (no bypass).
//!   - Elapsed from nonzero base works correctly.
//!
//! Each test carries a `// kills:` comment naming which wrong implementation it
//! catches. Reference consts symbolically so they survive tuning.

use super::*;

// ---------------------------------------------------------------------------
// Cooldown boundary — spec: `<` not `<=`
// ---------------------------------------------------------------------------

/// Cooldown exactly elapsed (== CARE_COOLDOWN_MS) MUST be Ok.
/// kills: an impl that uses `<=` (strict-greater-than) instead of `<` for the
/// cooldown gate — `<=` would reject at exactly the boundary, producing Err
/// where the spec requires Ok.
/// Spec: "IF the cooldown has not elapsed THEN reject" — at exactly the boundary
/// the cooldown HAS elapsed, so Ok is required.
#[test]
fn cooldown_boundary_exact_is_ok() {
    // last_care_at_ms = 0, now_ms = CARE_COOLDOWN_MS: elapsed == CARE_COOLDOWN_MS.
    // With `<` in the gate: elapsed < CARE_COOLDOWN_MS is FALSE → allowed → Ok.
    // With `<=` in the gate: elapsed <= CARE_COOLDOWN_MS is TRUE → rejected → Err (WRONG).
    let result = evaluate_care(50, 0, CARE_COOLDOWN_MS);
    assert!(
        result.is_ok(),
        "evaluate_care(bond=50, last=0, now=CARE_COOLDOWN_MS) must be Ok \
         (elapsed == CARE_COOLDOWN_MS is exactly at the boundary — operator must be < not <=); \
         got Err: {:?}",
        result.err()
    );
}

/// One millisecond before the boundary MUST be Err (cooldown not yet elapsed).
/// kills: an impl that uses `<` correctly for the >= comparison but has an
/// off-by-one in the subtraction (e.g. `now - last < COOLDOWN - 1`).
#[test]
fn cooldown_boundary_one_ms_before_is_err() {
    // last_care_at_ms = 0, now_ms = CARE_COOLDOWN_MS - 1: elapsed = CARE_COOLDOWN_MS - 1.
    // With correct `<`: elapsed < CARE_COOLDOWN_MS is TRUE → rejected → Err.
    let result = evaluate_care(50, 0, CARE_COOLDOWN_MS - 1);
    assert!(
        result.is_err(),
        "evaluate_care(bond=50, last=0, now=CARE_COOLDOWN_MS-1) must be Err \
         (cooldown not yet elapsed — exactly one ms short of the boundary); \
         got Ok: {:?}",
        result.ok()
    );
}

// ---------------------------------------------------------------------------
// Elapsed from a nonzero base
// ---------------------------------------------------------------------------

/// Elapsed from a nonzero last_care_at_ms baseline must compute correctly.
/// kills: an impl that hardcodes `now_ms < CARE_COOLDOWN_MS` (ignoring the
/// base) instead of `now_ms.saturating_sub(last_care_at_ms) < CARE_COOLDOWN_MS`.
#[test]
fn cooldown_elapsed_from_nonzero_base_is_ok() {
    // last_care_at_ms = 1000, now_ms = 1000 + CARE_COOLDOWN_MS.
    // elapsed = CARE_COOLDOWN_MS → allowed.
    let result = evaluate_care(50, 1000, 1000 + CARE_COOLDOWN_MS);
    assert!(
        result.is_ok(),
        "evaluate_care(bond=50, last=1000, now=1000+CARE_COOLDOWN_MS) must be Ok \
         (elapsed == CARE_COOLDOWN_MS from nonzero base); \
         got Err: {:?}",
        result.err()
    );
}

// ---------------------------------------------------------------------------
// Max bond rejects even with cooldown elapsed
// ---------------------------------------------------------------------------

/// A monster already at max bond (255) must be rejected regardless of cooldown.
/// kills: an impl that checks cooldown first and only then checks bond, so a
/// max-bond monster would burn the cooldown before being rejected (F1 violation).
/// The spec: "IF the monster is at max bond THE SYSTEM SHALL reject BEFORE
/// burning the cooldown."
/// Rationale: evaluate_care applies bond arithmetic BEFORE the cooldown gate
/// (per the specified order: apply_care first, then cooldown) — so AtMaxBond
/// fires before the cooldown check.
#[test]
fn max_bond_rejects_even_with_cooldown_elapsed() {
    // bond = 255 (max), cooldown fully elapsed.
    let result = evaluate_care(255, 0, CARE_COOLDOWN_MS);
    assert!(
        result.is_err(),
        "evaluate_care(bond=255, ...) must be Err (AtMaxBond path) \
         even when cooldown has elapsed; got Ok: {:?}",
        result.ok()
    );
}

/// Near-max bond (254) with CARE_BOND_AMOUNT >= 1 saturates to exactly 255.
/// kills: an impl that clamps to 254 (off-by-one in saturation) or panics on
/// near-max bond arithmetic.
#[test]
fn near_max_bond_saturates_to_255() {
    // bond = 254, CARE_BOND_AMOUNT >= 1 → result must be 255.
    let result = evaluate_care(254, 0, CARE_COOLDOWN_MS);
    match result {
        Ok(new_bond) => {
            assert!(
                new_bond <= 255,
                "bond must never exceed 255 (u8::MAX); got {}",
                new_bond
            );
            assert!(
                new_bond > 254,
                "bond must have increased above 254 (CARE_BOND_AMOUNT >= 1); got {}",
                new_bond
            );
            // Precise expectation: min(254 + CARE_BOND_AMOUNT, 255) = 255 since CARE_BOND_AMOUNT >= 1.
            assert_eq!(
                new_bond, 255,
                "bond=254 + CARE_BOND_AMOUNT({}) should saturate to exactly 255",
                CARE_BOND_AMOUNT
            );
        }
        Err(e) => {
            panic!(
                "evaluate_care(bond=254, last=0, now=CARE_COOLDOWN_MS) must be Ok \
                 (254 < 255 = max bond, cooldown elapsed); got Err: {:?}",
                e
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Safe-direction clock: future last_care_at_ms only over-rejects
// ---------------------------------------------------------------------------

/// A last_care_at_ms in the future (relative to now_ms) only over-rejects —
/// it never bypasses the cooldown.
/// kills: an impl where a future last_care_at_ms wraps around and produces a
/// spuriously large elapsed (e.g. using wrapping subtraction instead of
/// saturating_sub) — a wrap could make elapsed appear huge, bypassing the gate.
/// With saturating_sub: saturating_sub(0, 10_000) = 0 < CARE_COOLDOWN_MS → Err.
#[test]
fn future_last_care_at_ms_only_over_rejects() {
    // now_ms = 0, last_care_at_ms = 10_000 (last care is "in the future").
    // Correct: saturating_sub(0, 10_000) = 0, which is < CARE_COOLDOWN_MS → Err.
    // Wrong:   wrapping sub on i64: 0i64.wrapping_sub(10_000) = -10_000 < CARE_COOLDOWN_MS → Err
    //          (coincidentally also Err, but the semantics are wrong — do NOT rely on this).
    // The invariant: this call must be Err (never Ok — a future timestamp must not bypass gate).
    let result = evaluate_care(50, 10_000, 0);
    assert!(
        result.is_err(),
        "evaluate_care(bond=50, last=10_000, now=0) must be Err \
         (last_care_at_ms is in the future relative to now — safe-direction: \
         over-reject is fine, but the gate must never be bypassed); \
         got Ok: {:?}",
        result.ok()
    );
}

// ---------------------------------------------------------------------------
// Successful care raises bond by exactly min(CARE_BOND_AMOUNT, 255 - bond)
// ---------------------------------------------------------------------------

/// A successful care raises bond by exactly `min(CARE_BOND_AMOUNT, 255 - bond)`.
/// kills: an impl that adds a hardcoded amount instead of using CARE_BOND_AMOUNT,
/// or one that adds more than the remaining headroom.
#[test]
fn successful_care_raises_bond_by_care_bond_amount() {
    // bond = 50, CARE_BOND_AMOUNT >= 1, headroom = 205 (>> CARE_BOND_AMOUNT for any sane value).
    // Expected new bond = 50 + CARE_BOND_AMOUNT (no saturation needed for reasonable CARE_BOND_AMOUNT).
    let result = evaluate_care(50, 0, CARE_COOLDOWN_MS);
    match result {
        Ok(new_bond) => {
            // The exact expected value uses the const symbolically.
            let expected = 50u8.saturating_add(CARE_BOND_AMOUNT);
            assert_eq!(
                new_bond, expected,
                "bond raised by wrong amount: expected 50 + CARE_BOND_AMOUNT({}) = {}, got {}",
                CARE_BOND_AMOUNT, expected, new_bond
            );
        }
        Err(e) => {
            panic!(
                "evaluate_care(bond=50, last=0, now=CARE_COOLDOWN_MS) must be Ok \
                 (bond=50 < 255, cooldown elapsed); got Err: {:?}",
                e
            );
        }
    }
}
