//! `currency` — pure, deterministic balance arithmetic (M13a, ADR-0081).
//!
//! Every balance mutation routes through `apply_grant` or `apply_spend`.
//! Since 20r-b (ADR-0175 amendment) the essence reward formula and the per-pool
//! essence soft cap live here too, beside their currency sibling, so the content
//! validator and the server read ONE definition. No side-effects, no context,
//! no SpacetimeDB types.

/// Maximum balance a single wallet may hold (9-digit UI cap, ADR-0081).
pub const MAX_BALANCE: u64 = 999_999_999;

/// Divisor for the battle currency reward formula (ADR-0083, tunable).
/// A BST-300 opponent yields 30 gold; u16::MAX yields 6553 gold (well below MAX_BALANCE).
pub const BATTLE_CURRENCY_BST_DIVISOR: u64 = 10;

/// Grant `amount` to `balance`. Saturating add, capped at [`MAX_BALANCE`].
/// Returns `balance` unchanged when `amount` is 0.
#[must_use]
pub fn apply_grant(balance: u64, amount: u64) -> u64 {
    balance.saturating_add(amount).min(MAX_BALANCE)
}

/// Spend `amount` from `balance`. Returns `Ok(new_balance)` on success or
/// `Err("insufficient funds")` when `amount > balance`.
pub fn apply_spend(balance: u64, amount: u64) -> Result<u64, &'static str> {
    balance.checked_sub(amount).ok_or("insufficient funds")
}

/// Currency reward for winning a battle, derived from the loser's base stat total.
/// Formula: `loser_bst / BATTLE_CURRENCY_BST_DIVISOR` (integer division).
/// Result is always in range [0, 6553] for valid BST inputs — well below MAX_BALANCE.
#[must_use]
pub fn battle_currency_reward(loser_bst: u16) -> u64 {
    u64::from(loser_bst) / BATTLE_CURRENCY_BST_DIVISOR
}

/// Divisor for the essence reward formula (EG2-7, ADR-0175 D5) — deliberately
/// 3x steeper than [`BATTLE_CURRENCY_BST_DIVISOR`]: at currency's `/ 10` rate a
/// handful of wins would clear every authored essence threshold. Promoted
/// from `server-module/src/battle.rs` by 20r-b (ADR-0175 amendment) so the
/// server, the content validator and any future client preview share it.
pub const ESSENCE_BST_DIVISOR: u16 = 30;

/// Essence granted to each winning participant of a WILD battle, typed by the
/// defeated species' affinity at the call site: `max(1, loser_bst / 30)`.
/// Floored so a low-BST win is never essence-inert; NOT clamped at
/// [`ESSENCE_SOFT_CAP`] — clamping is the grant's job (EG1-1), and a
/// `u16::MAX` BST legitimately yields 2184.
#[must_use]
pub fn essence_battle_reward(bst: u16) -> u32 {
    u32::from((bst / ESSENCE_BST_DIVISOR).max(1))
}

/// Per-pool essence soft cap (EG1-1). Two consumers, two shapes: every essence
/// GRANT saturates and clamps at this value (never rejects); the content
/// validator REJECTS any `EvolutionPath` essence requirement above it (rule
/// R14) because such a gate could never be satisfied. Consequence: lowering
/// the cap below a shipped `amount:` reds `sync_content` — retune content
/// first, then the cap. Promoted from `server-module/src/raising.rs` by 20r-b
/// (ADR-0175 amendment).
pub const ESSENCE_SOFT_CAP: u32 = 999;

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

    // -----------------------------------------------------------------------
    // M13c: battle_currency_reward — example-based + property tests
    //
    // The function under test (NOT YET IMPLEMENTED — tests are RED):
    //   pub fn battle_currency_reward(loser_bst: u16) -> u64
    //
    // Formula: loser_bst / BATTLE_CURRENCY_BST_DIVISOR (integer division).
    // Constant: BATTLE_CURRENCY_BST_DIVISOR: u64 = 10.
    //
    // These tests start RED because `battle_currency_reward` does not exist yet
    // in currency.rs. They turn green only once the implementer adds the function
    // and the named constant (both in this module, so `super::` resolves them).
    // -----------------------------------------------------------------------

    /// M13c EARS: BST=0 returns 0 (zero-BST never panics, result is 0).
    ///
    /// kills: an impl that panics on division-by-zero (wrong — the DIVISOR is
    ///        the denominator, not loser_bst; loser_bst=0 is simply 0/10=0),
    ///        or one that returns a non-zero sentinel for BST=0.
    #[test]
    fn battle_currency_reward_zero_bst() {
        assert_eq!(
            super::battle_currency_reward(0),
            0,
            "battle_currency_reward(0) must return 0 — BST=0 is 0/10=0, never panics"
        );
    }

    /// M13c EARS: BST=300 returns 30 (verifies the integer-division formula).
    ///
    /// kills: an impl that uses floating-point division + rounding (would also
    ///        return 30, but proves the formula is exact integer division), or
    ///        one that multiplies instead of divides (would return 3000), or
    ///        one that uses a different divisor (e.g. 100 → returns 3).
    #[test]
    fn battle_currency_reward_typical() {
        assert_eq!(
            super::battle_currency_reward(300),
            30,
            "battle_currency_reward(300) must return 30 — formula is bst / 10"
        );
    }

    /// M13c EARS: BST=u16::MAX (65535) returns a sensible value (no panic, no overflow).
    ///
    /// kills: an impl that widens incorrectly and overflows a u32 intermediate,
    ///        or one that panics at u16::MAX input.
    ///
    /// Note: the expected result is 6553 (65535 / 10 = 6553, truncated).
    #[test]
    fn battle_currency_reward_max_bst() {
        let result = super::battle_currency_reward(u16::MAX);
        assert_eq!(
            result, 6553,
            "battle_currency_reward(u16::MAX=65535) must return 6553 (65535/10 truncated) \
             without panic or overflow"
        );
    }

    /// M13c EARS: reward never exceeds MAX_BALANCE for any valid BST input.
    ///
    /// Since u16::MAX / 10 = 6553 which is far below MAX_BALANCE=999_999_999,
    /// this is a static assertion — but we test it explicitly to kill any impl
    /// that accidentally scales the result by an extra factor (e.g. returns
    /// bst * some_factor instead of bst / DIVISOR).
    ///
    /// kills: an impl that multiplies bst (producing 65535 * 10 = 655350) or
    ///        one that forgets the divisor and returns bst directly as u64
    ///        (65535 << MAX_BALANCE, but semantically wrong).
    #[test]
    fn battle_currency_reward_capped() {
        // For every possible BST (all 65536 values), the reward must fit in MAX_BALANCE.
        // u16::MAX / 10 = 6553 << 999_999_999 = MAX_BALANCE.
        let max_possible = super::battle_currency_reward(u16::MAX);
        assert!(
            max_possible <= MAX_BALANCE,
            "battle_currency_reward(u16::MAX) = {max_possible} exceeds MAX_BALANCE={MAX_BALANCE}; \
             the reward formula must produce values well within the wallet cap for all BST inputs"
        );
        // Also spot-check the zero and a mid-range value.
        assert!(super::battle_currency_reward(0) <= MAX_BALANCE);
        assert!(super::battle_currency_reward(300) <= MAX_BALANCE);
    }

    // -----------------------------------------------------------------------
    // 20r-b (spec B1): essence_battle_reward + the two essence SSOT constants
    //
    // The items under test (NOT YET IMPLEMENTED — these tests are RED):
    //   pub const ESSENCE_BST_DIVISOR: u16 = 30;
    //   pub fn essence_battle_reward(bst: u16) -> u32
    //   pub const ESSENCE_SOFT_CAP: u32 = 999;
    //
    // Formula: max(1, bst / ESSENCE_BST_DIVISOR) — a divisor 3x steeper than
    // the currency reward's 10 (EG2-7), floored at 1 so a low-BST win is never
    // essence-inert. All three values are UNCHANGED from the server-module
    // definitions this slice promotes into game-core: the promotion is a MOVE,
    // never a retune, and server-module then consumes these definitions.
    //
    // These tests start RED because none of the three items exists in this
    // module yet. They turn green only once the implementer adds all three
    // HERE, beside battle_currency_reward (so `super::` resolves them).
    //
    // Every expectation below is a HARDCODED literal, never derived from the
    // constant under test: a test that reads the constant to compute its own
    // oracle stays green for whatever value the constant takes, which is
    // precisely the silent retune an SSOT promotion must not smuggle in.
    // -----------------------------------------------------------------------

    /// B1 EARS: the essence reward FLOORS at 1 — every BST from 0 up to and
    /// including one full divisor step pays exactly one essence.
    ///
    /// kills: a bare `bst / 30` (0, 20 and 29 would all pay 0, making a wild win
    ///        against a low-BST opponent essence-inert); `max` swapped for `min`
    ///        (same three zeros); and a `+ 1` fudge on the quotient (30 pays 2).
    #[test]
    fn essence_battle_reward_floors_at_one_for_low_bst() {
        for bst in [0u16, 20, 29, 30] {
            assert_eq!(
                super::essence_battle_reward(bst),
                1,
                "essence_battle_reward({bst}) must be exactly 1 — the formula is \
                 max(1, bst / 30), so every BST through the first full divisor step pays one"
            );
        }
    }

    /// B1 EARS: above the floor the reward scales at the STEEPER essence divisor
    /// (30), not at the currency rate (10), and the division truncates.
    ///
    /// kills: reusing `BATTLE_CURRENCY_BST_DIVISOR` (300 would pay 30 — EG2-7
    ///        records that rate clears every authored essence threshold in a
    ///        handful of wins); a ceiling or rounding division (318 would pay
    ///        11); and `*` or `%` in place of `/` (450 would pay 13500 or 1).
    #[test]
    fn essence_battle_reward_scales_at_the_steeper_divisor() {
        assert_eq!(
            super::essence_battle_reward(300),
            10,
            "essence_battle_reward(300) must be 10 — bst / 30, NOT the currency rate bst / 10"
        );
        assert_eq!(
            super::essence_battle_reward(318),
            10,
            "essence_battle_reward(318) must be 10 — integer division TRUNCATES (318 / 30 is \
             10.6), a ceiling or rounding formula would pay 11"
        );
        assert_eq!(
            super::essence_battle_reward(450),
            15,
            "essence_battle_reward(450) must be 15 — bst / 30"
        );
    }

    /// B1 EARS: `ESSENCE_BST_DIVISOR` is 30 — the SSOT value pin.
    ///
    /// RETUNE: this literal is the divisor's single source of truth now that
    /// server-module consumes the game-core definition instead of declaring its
    /// own. Changing the divisor is a deliberate balance change: edit the
    /// constant AND this pin in one commit, and re-derive the three example
    /// rewards above (300 -> 10, 318 -> 10, 450 -> 15) BY HAND rather than from
    /// the new constant.
    ///
    /// kills: a promotion that retunes the divisor while moving it. The example
    ///        tests pin three (input, output) pairs; this pins the constant
    ///        itself, so a changed divisor cannot hide behind a compensating
    ///        formula that happens to reproduce those three pairs.
    #[test]
    fn essence_bst_divisor_is_thirty() {
        assert_eq!(
            super::ESSENCE_BST_DIVISOR,
            30,
            "ESSENCE_BST_DIVISOR must be exactly 30 — the value promoted verbatim out of \
             server-module (EG2-7: 3x steeper than the currency divisor 10)"
        );
    }

    /// B1 EARS: the top of the input domain does not overflow the u32 return.
    /// u16::MAX is 65535 and 65535 / 30 is 2184.5, truncated to 2184.
    ///
    /// kills: an impl that panics or wraps at the top of the domain
    ///        (`overflow-checks = true` is on for release and bench, so a
    ///        widening mistake is a hard failure, not a silent wrap), and any
    ///        undersized intermediate — a u8 would truncate 2184 to 136.
    #[test]
    fn essence_battle_reward_at_u16_max_does_not_overflow() {
        assert_eq!(
            super::essence_battle_reward(u16::MAX),
            2184,
            "essence_battle_reward(u16::MAX = 65535) must be 2184 (65535 / 30 truncated), \
             without panic or wrap"
        );
    }

    /// B1 EARS: the reward MAY exceed `ESSENCE_SOFT_CAP`. The cap belongs to the
    /// pool WRITE — `grant_essence` clamps there (EG1-1) — never to the reward
    /// formula, so folding the clamp in here would be a behaviour change and the
    /// promotion must not change behaviour.
    ///
    /// RETUNE: the 999 below is `ESSENCE_SOFT_CAP` written out as a literal, and
    /// 2184 is the reward at the top of the domain. Both move together only if
    /// the DIVISOR moves; a cap retune moves the 999 alone — and a cap retuned
    /// above 2184 makes this criterion unwitnessable at any BST, which is itself
    /// a finding to raise rather than a fixture to soften.
    ///
    /// kills: on its own, nothing that
    ///        `essence_battle_reward_at_u16_max_does_not_overflow` does not kill
    ///        first — that test pins 2184 exactly, so a `.min(999)` /
    ///        `.min(ESSENCE_SOFT_CAP)` clamp reds it before reaching here. This
    ///        fixture is CONTRACT DOCUMENTATION: it states, at the point a
    ///        reader goes looking, that a reward above the cap is CORRECT and is
    ///        not to be "fixed" — the clamp belongs to the pool write.
    #[test]
    fn essence_battle_reward_may_exceed_the_soft_cap() {
        let reward = super::essence_battle_reward(u16::MAX);
        assert!(
            reward > 999,
            "essence_battle_reward(u16::MAX) = {reward} must be ABOVE the soft cap 999 — the \
             cap is applied by the pool write, not by the reward formula"
        );
        assert_eq!(
            reward, 2184,
            "essence_battle_reward(u16::MAX) must be exactly 2184, not a clamped 999"
        );
    }

    /// B1 EARS: `ESSENCE_SOFT_CAP` is 999 — the SSOT value pin.
    ///
    /// RETUNE: the cap stops being a free tunable with this slice. It is now
    /// BOTH the runtime clamp for every essence pool (EG1-1) AND the
    /// content-validation ceiling for an authored `EssenceRequirement.amount`
    /// (content.rs rule R14), so LOWERING it below a shipped `amount:` reds
    /// content validation and panics a fresh-DB init. Retune order: content
    /// first, then this constant, then this pin and the R14 boundary fixtures in
    /// content.rs.
    ///
    /// kills: a promotion that changes the cap while moving it, and the
    ///        two-declarations-two-values desync this slice exists to remove.
    #[test]
    fn essence_soft_cap_is_999() {
        assert_eq!(
            super::ESSENCE_SOFT_CAP,
            999,
            "ESSENCE_SOFT_CAP must be exactly 999 — the value promoted verbatim out of \
             server-module's raising.rs"
        );
    }

    /// This file's own source, for the formula-wiring proof below. Declared next
    /// to its ONE consumer: nothing else in `currency.rs` reads its own source.
    const CURRENCY_SELF_SOURCE: &str = include_str!("currency.rs");

    /// B1 EARS: the reward FORMULA reads `ESSENCE_BST_DIVISOR` — a source scan.
    ///
    /// `ESSENCE_BST_DIVISOR` declared beside a formula that hardcodes the number
    /// is behaviourally indistinguishable from the real wiring TODAY: every
    /// example and property test above passes it, and so does
    /// `essence_bst_divisor_is_thirty`, because the constant exists and holds
    /// the right value — it is simply not the thing the formula divides by. It
    /// stops being indistinguishable at the next retune, when the constant moves
    /// and the reward does not. No behavioural fixture can reach that, so this
    /// test reads the function's own source.
    ///
    /// ANCHORING: the signature occurs TWICE in this file — once for real, once
    /// in the block header above, which reproduces it as documentation. The
    /// anchor is therefore COLUMN-0 (a newline immediately followed by
    /// `pub fn ...(`), which the indented `//` copy cannot match, and it is
    /// asserted to occur exactly once. `#[must_use]` sits on the line ABOVE
    /// `pub fn`, so anchoring on the `pub fn` line steps over it. Both needles
    /// are assembled from fragments, so this test's own text can never satisfy
    /// them.
    ///
    /// LIMITS, deliberate and documented: the scan is whitespace-squashed but
    /// NOT comment-stripped and NOT string-literal aware, so a future literal —
    /// or a comment — containing the divisor's digits inside this ONE function's
    /// body would false-RED it. The body is a single expression; keep it one.
    ///
    /// kills: `u32::from((bst / 30).max(1))` — the constant declared, exported
    ///        and value-pinned, but never actually consumed by the formula.
    #[test]
    fn essence_reward_formula_reads_the_divisor_constant() {
        let anchor = format!("\npub fn {}(", "essence_battle_reward");
        let occurrences = CURRENCY_SELF_SOURCE.matches(anchor.as_str()).count();
        assert_eq!(
            occurrences, 1,
            "formula probe: the COLUMN-0 essence_battle_reward signature must occur EXACTLY once \
             in currency.rs (found {occurrences}); the block header above reproduces the \
             signature in an indented comment, which is why the anchor is column-0."
        );
        let start = CURRENCY_SELF_SOURCE
            .find(anchor.as_str())
            .expect("the signature was just counted, so it must be findable");
        let rest = &CURRENCY_SELF_SOURCE[start..];
        let end = rest.find("\n}\n").expect(
            "essence_battle_reward must be terminated by a column-0 closing brace; if this fails \
             the region extraction is broken, not the formula",
        );
        let squashed: String = rest[..end].chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            squashed.contains("->u32{"),
            "extraction sanity: the region read out of the source does not carry \
             essence_battle_reward's signature and opening brace, so the two assertions below \
             would be meaningless"
        );

        let divisor_name = ["ESSENCE_", "BST_DIVISOR"].concat();
        assert!(
            squashed.contains(divisor_name.as_str()),
            "B1 TEETH: essence_battle_reward's body never names {divisor_name:?}. A constant that \
             is declared, exported and value-pinned but never DIVIDED BY is a decoy: every \
             behavioural test in this module passes it, and the next retune moves the constant \
             while the reward stays exactly where it was."
        );

        let hardcoded = ["3", "0"].concat();
        assert!(
            !squashed.contains(hardcoded.as_str()),
            "B1 TEETH: essence_battle_reward's body carries the literal {hardcoded:?}. The \
             divisor must be READ from ESSENCE_BST_DIVISOR, never written out beside it."
        );
    }

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

        /// B1 EARS (property): the floor holds for EVERY representable BST —
        /// `essence_battle_reward` never returns 0.
        ///
        /// The example test pins four points near the floor; this pins the whole
        /// u16 domain, so no input at all makes a wild win essence-inert.
        ///
        /// kills: any impl that drops the `.max(1)` — the example test only
        ///        covers 0, 20, 29 and 30, while this covers 1..=29 too.
        #[test]
        fn prop_essence_reward_floor_holds_for_every_bst(bst in any::<u16>()) {
            let reward = super::essence_battle_reward(bst);
            prop_assert!(
                reward >= 1,
                "essence_battle_reward({bst}) = {reward}; the reward is floored at 1 for every \
                 representable BST, so 0 is never a valid answer"
            );
        }

        /// B1 EARS (property): the reward is monotone non-decreasing in BST —
        /// a stronger opponent never pays LESS essence.
        ///
        /// kills: a bucketed or modular formula (`bst % 30`, a lookup table with
        ///        a wrong edge, a saturating step that folds back) — each is
        ///        consistent with the four example points and still lets some
        ///        higher BST pay less than a lower one.
        #[test]
        fn prop_essence_reward_is_monotone_non_decreasing(a in any::<u16>(), b in any::<u16>()) {
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            let lo_reward = super::essence_battle_reward(lo);
            let hi_reward = super::essence_battle_reward(hi);
            prop_assert!(
                lo_reward <= hi_reward,
                "essence_battle_reward({lo}) = {lo_reward} but essence_battle_reward({hi}) = \
                 {hi_reward}; a higher BST must never pay less essence than a lower one"
            );
        }
    }
}
