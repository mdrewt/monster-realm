//! `currency` — pure, deterministic balance arithmetic (M13a, ADR-0081).
//!
//! Every balance mutation routes through `apply_grant` or `apply_spend`.
//! No side-effects, no context, no SpacetimeDB types.

/// Maximum balance a single wallet may hold (9-digit UI cap, ADR-0081).
pub const MAX_BALANCE: u64 = 999_999_999;

/// Grant `amount` to `balance`. Saturating add, capped at [`MAX_BALANCE`].
/// Returns `balance` unchanged when `amount` is 0.
pub fn apply_grant(balance: u64, amount: u64) -> u64 {
    balance.saturating_add(amount).min(MAX_BALANCE)
}

/// Spend `amount` from `balance`. Returns `Ok(new_balance)` on success or
/// `Err("insufficient funds")` when `amount > balance`.
pub fn apply_spend(balance: u64, amount: u64) -> Result<u64, &'static str> {
    balance.checked_sub(amount).ok_or("insufficient funds")
}

// ---------------------------------------------------------------------------
// Unit + property tests (M13a EARS criteria → one test per criterion)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // apply_grant — example-based tests
    // -----------------------------------------------------------------------

    /// EARS: 0-grant no-op — apply_grant(100, 0) must return 100 unchanged.
    /// kills: an impl that always adds (would return 100 and silently ignore zero,
    ///        but an impl that inserts a row on 0-amount grant is caught at the
    ///        server layer; the pure function still must return balance unchanged).
    #[test]
    fn apply_grant_zero_amount_returns_balance() {
        assert_eq!(
            apply_grant(100, 0),
            100,
            "apply_grant(100, 0) must return 100 — 0-grant is a no-op"
        );
    }

    /// EARS: basic addition — apply_grant(100, 50) == 150.
    /// kills: an impl that returns max(balance, amount) or min(balance, amount)
    ///        instead of summing.
    #[test]
    fn apply_grant_basic() {
        assert_eq!(
            apply_grant(100, 50),
            150,
            "apply_grant(100, 50) must return 150"
        );
    }

    /// EARS: saturating cap on grant — apply_grant(MAX_BALANCE, 1) == MAX_BALANCE.
    /// kills: an impl that uses saturating_add without the .min(MAX_BALANCE) clamp
    ///        (saturating_add(999_999_999, 1) overflows u64 cap at u64::MAX, not MAX_BALANCE).
    /// Note: u64::MAX != MAX_BALANCE, so saturating u64 add alone is insufficient.
    #[test]
    fn apply_grant_saturates_at_cap() {
        assert_eq!(
            apply_grant(MAX_BALANCE, 1),
            MAX_BALANCE,
            "apply_grant(MAX_BALANCE, 1) must return MAX_BALANCE (capped, not MAX_BALANCE+1)"
        );
    }

    /// EARS: saturating cap on grant (large delta) — apply_grant(MAX_BALANCE - 1, large) == MAX_BALANCE.
    /// kills: an impl that saturates to u64::MAX instead of MAX_BALANCE.
    #[test]
    fn apply_grant_never_exceeds_cap() {
        assert_eq!(
            apply_grant(MAX_BALANCE - 1, 999_999_999),
            MAX_BALANCE,
            "apply_grant(MAX_BALANCE-1, large) must be capped at MAX_BALANCE"
        );
    }

    /// EARS: overflow safety — apply_grant(u64::MAX, u64::MAX) == MAX_BALANCE (no panic).
    /// kills: an impl that does `balance + amount` (unchecked overflow → panic in debug,
    ///        wrap in release), or `balance.saturating_add(amount)` without the .min() cap
    ///        (returns u64::MAX, not MAX_BALANCE).
    #[test]
    fn apply_grant_overflow_safe() {
        assert_eq!(
            apply_grant(u64::MAX, u64::MAX),
            MAX_BALANCE,
            "apply_grant(u64::MAX, u64::MAX) must return MAX_BALANCE without panic or wrap"
        );
    }

    /// EARS: grant fills from 0 to MAX_BALANCE exactly.
    /// kills: an impl that has an off-by-one in the cap (caps at MAX_BALANCE - 1 or
    ///        MAX_BALANCE + 1 instead of MAX_BALANCE).
    #[test]
    fn apply_grant_from_zero() {
        assert_eq!(
            apply_grant(0, MAX_BALANCE),
            MAX_BALANCE,
            "apply_grant(0, MAX_BALANCE) must return MAX_BALANCE"
        );
    }

    // -----------------------------------------------------------------------
    // apply_spend — example-based tests
    // -----------------------------------------------------------------------

    /// EARS: basic subtraction — apply_spend(100, 50) == Ok(50).
    /// kills: an impl that returns Err for any non-zero amount, or returns Ok(100)
    ///        (forgot to subtract), or returns Ok(150) (added instead of subtracted).
    #[test]
    fn apply_spend_basic() {
        assert_eq!(
            apply_spend(100, 50),
            Ok(50),
            "apply_spend(100, 50) must return Ok(50)"
        );
    }

    /// EARS: spend drains to zero — apply_spend(100, 100) == Ok(0).
    /// kills: an impl that only allows spending strictly less than balance
    ///        (checked_sub is fine; a bare `> 0` guard before subtracting is not).
    #[test]
    fn apply_spend_exact() {
        assert_eq!(
            apply_spend(100, 100),
            Ok(0),
            "apply_spend(100, 100) must return Ok(0) — spending exact balance drains to zero"
        );
    }

    /// EARS: never negative (empty wallet) — apply_spend(0, 1) == Err("insufficient funds").
    /// kills: an impl that uses unchecked subtraction (would underflow to u64::MAX),
    ///        or returns Ok(0) instead of Err.
    #[test]
    fn apply_spend_insufficient_empty() {
        assert_eq!(
            apply_spend(0, 1),
            Err("insufficient funds"),
            "apply_spend(0, 1) must return Err(\"insufficient funds\") — cannot spend from empty wallet"
        );
    }

    /// EARS: reject on insufficient funds — apply_spend(50, 100) == Err("insufficient funds").
    /// kills: an impl that saturates to 0 (returns Ok(0)) instead of rejecting,
    ///        or uses unchecked subtraction (underflows).
    #[test]
    fn apply_spend_insufficient_partial() {
        assert_eq!(
            apply_spend(50, 100),
            Err("insufficient funds"),
            "apply_spend(50, 100) must return Err(\"insufficient funds\") — amount exceeds balance"
        );
    }

    /// EARS: 0-spend no-op — apply_spend(100, 0) == Ok(100).
    /// kills: an impl that rejects zero-amount spends (a common over-guard), or
    ///        returns Ok(0) (forgot zero-branch).
    #[test]
    fn apply_spend_zero_amount() {
        assert_eq!(
            apply_spend(100, 0),
            Ok(100),
            "apply_spend(100, 0) must return Ok(100) — spending 0 is a no-op"
        );
    }

    // -----------------------------------------------------------------------
    // Property tests
    // -----------------------------------------------------------------------

    proptest! {
        /// EARS (property): monotone grant — for any (balance <= MAX_BALANCE, amount),
        /// apply_grant(balance, amount) >= balance.
        ///
        /// Restricted to balance <= MAX_BALANCE: a balance already above the cap
        /// (impossible in a correct system but representable as u64) would violate
        /// monotonicity trivially because apply_grant must clamp to MAX_BALANCE.
        /// The invariant only has to hold for balances in the valid domain.
        ///
        /// kills: an impl that can return a value LESS than balance in the valid range
        ///        (e.g. a min() that acts on balance instead of the sum, or a
        ///        saturating_sub instead of saturating_add).
        #[test]
        fn prop_grant_monotone(balance in 0u64..=MAX_BALANCE, amount in 0u64..=u64::MAX) {
            let result = apply_grant(balance, amount);
            prop_assert!(
                result >= balance,
                "apply_grant({balance}, {amount}) = {result} < {balance} — grant must be monotone \
                 for any balance in the valid domain [0, MAX_BALANCE]"
            );
        }

        /// EARS (property): grant never exceeds cap — for any (balance, amount),
        /// apply_grant(balance, amount) <= MAX_BALANCE.
        /// kills: an impl that uses .saturating_add() without .min(MAX_BALANCE),
        ///        or one that omits the cap entirely (balance + amount could exceed MAX_BALANCE).
        #[test]
        fn prop_grant_capped(balance in 0u64..=MAX_BALANCE, amount in 0u64..=u64::MAX) {
            let result = apply_grant(balance, amount);
            prop_assert!(
                result <= MAX_BALANCE,
                "apply_grant({balance}, {amount}) = {result} > MAX_BALANCE ({MAX_BALANCE})"
            );
        }

        /// EARS (property): spend is bounded — if apply_spend(b, a) returns Ok(r),
        /// then r <= b AND r == b - a exactly.
        /// kills: an impl that saturates (returns Ok(0) when a > b), or one that
        ///        adds instead of subtracts, or one that applies a fee on top.
        #[test]
        fn prop_spend_reduces_or_errs(balance in 0u64..=MAX_BALANCE, amount in 0u64..=MAX_BALANCE) {
            match apply_spend(balance, amount) {
                Ok(r) => {
                    let expected = balance - amount;
                    prop_assert_eq!(
                        r,
                        expected,
                        "apply_spend({}, {}) = Ok({}) but expected Ok({})",
                        balance, amount, r, expected
                    );
                }
                Err(e) => {
                    prop_assert_eq!(
                        e,
                        "insufficient funds",
                        "apply_spend Err must be \"insufficient funds\"; got: {:?}", e
                    );
                    // Err is only valid when amount > balance.
                    prop_assert!(
                        amount > balance,
                        "apply_spend({balance}, {amount}) returned Err but amount <= balance — \
                         should have been Ok"
                    );
                }
            }
        }
    }
}
