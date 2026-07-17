//! Ranked-ladder rating rules (M17, ADR-0119). Implementation added by the m17a implementer.

// ===========================================================================
// Unit + property tests (m17a EARS criteria → one test per criterion)
// ===========================================================================
//
// This file is intentionally IMPLEMENTATION-FREE. The #[cfg(test)] block below
// encodes every acceptance criterion from ADR-0119 D2 / spec RL-3..RL-4/RL-11/RL-12.
// It is COMPILE-RED until `pub const INITIAL_RATING`, `pub fn apply_elo`, and
// `pub fn compute_rating_update` are added to this module by the implementer.

#[cfg(test)]
mod tests {
    use super::{apply_elo, compute_rating_update, INITIAL_RATING};
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // RL-4: INITIAL_RATING == 1000
    //
    // Kills: an impl that seeds with a different starting value (e.g. 1200 or 0).
    // SSOT pin: get_or_init_profile must read this constant, never the literal 1000.
    // -----------------------------------------------------------------------

    /// RL-4: INITIAL_RATING const must equal exactly 1000.
    ///
    /// Kills: any impl that changes the constant value, or that defines it as
    /// a different type (the spec requires i32 to match the `rating: i32` column).
    #[test]
    fn initial_rating_is_1000() {
        assert_eq!(
            INITIAL_RATING, 1000_i32,
            "INITIAL_RATING must be 1000 (ADR-0119 D2, RL-4 SSOT)"
        );
    }

    // -----------------------------------------------------------------------
    // RL-3: spot-value pins (kill arithmetic / boundary mutants)
    //
    // Equal ratings → K/2 = 16.
    // Upset (winner rated below loser by 100) → 20 (strictly more than mirror).
    // Mirror (winner rated above loser by 100) → 12.
    // div_euclid pin at diff = −13 / +13 (truncating `/` would give 16/16, not 17/16).
    // Clamp activation exact boundary: diff = +375 → 1, diff = −375 → 31.
    // Clamped beyond boundary: diff = +400 → 1, diff = −400 → 31.
    // -----------------------------------------------------------------------

    /// RL-3: equal ratings (1000 vs 1000) yield delta = K/2 = 16.
    ///
    /// Kills: an impl using integer division K/2 that rounds wrong, or that
    /// uses a different K value (e.g. K=30 would give 15).
    #[test]
    fn equal_ratings_yield_half_k() {
        assert_eq!(
            apply_elo(1000, 1000),
            16,
            "apply_elo(1000, 1000) must be 16 (K/2; equal ratings → exact midpoint)"
        );
    }

    /// RL-3: upset — winner (1000) below loser (1100) → delta = 20.
    ///
    /// Kills: an impl that gives the same delta for upset and mirror (broken
    /// symmetry), or one that uses truncating `/` instead of `div_euclid`
    /// (which would give 16 here rather than 20 at diff = −100 = −4×25).
    #[test]
    fn upset_winner_below_loser_by_100() {
        assert_eq!(
            apply_elo(1000, 1100),
            20,
            "apply_elo(1000, 1100) must be 20 (upset: winner rated 100 below loser; \
             raw = 16 − (−100)/25 = 16 − (−4) = 20)"
        );
    }

    /// RL-3: mirror of the upset — winner (1100) above loser (1000) → delta = 12.
    ///
    /// Kills: an impl where apply_elo(1100,1000) == apply_elo(1000,1100) = 20,
    /// meaning favoritism is absent (wrong symmetry-breaking).
    #[test]
    fn favored_winner_above_loser_by_100() {
        assert_eq!(
            apply_elo(1100, 1000),
            12,
            "apply_elo(1100, 1000) must be 12 (mirror of upset: winner 100 above loser; \
             raw = 16 − 100/25 = 16 − 4 = 12)"
        );
    }

    /// RL-3: div_euclid floor pin at diff = −13 (winner rated 13 below loser).
    ///
    /// With div_euclid: (winner − loser) = −13; (−13).div_euclid(25) = −1
    /// (floors toward −∞), so raw = 16 − (−1) = 17.
    ///
    /// With truncating `/`: (−13) / 25 = 0 (rounds toward 0), so raw = 16 − 0 = 16.
    ///
    /// Kills: any impl using truncating `/` rather than `div_euclid` (gives 16, not 17).
    #[test]
    fn div_euclid_pin_winner_below_loser_by_13() {
        assert_eq!(
            apply_elo(1000, 1013),
            17,
            "apply_elo(1000, 1013) must be 17 (div_euclid pin: diff = −13, \
             div_euclid(25) = −1 not 0; truncating `/` gives 16 — KILLS truncating impl)"
        );
    }

    /// RL-3: mirror of the div_euclid pin — diff = +13 → delta = 16.
    ///
    /// With div_euclid: 13.div_euclid(25) = 0, so raw = 16 − 0 = 16.
    /// Confirms asymmetry: apply_elo(1000,1013)=17 != apply_elo(1013,1000)=16.
    ///
    /// Kills: an impl that returns 17 for both directions (wrong; truncating gives
    /// 16/16, div_euclid gives 17/16 — the asymmetry is the spec).
    #[test]
    fn div_euclid_pin_winner_above_loser_by_13() {
        assert_eq!(
            apply_elo(1013, 1000),
            16,
            "apply_elo(1013, 1000) must be 16 (div_euclid pin mirror: diff = +13, \
             div_euclid(25) = 0; raw = 16 − 0 = 16)"
        );
    }

    /// RL-3: clamp activation — exactly diff = +375 → delta = 1 (lower bound activated).
    ///
    /// raw = 16 − 375/25 = 16 − 15 = 1; this is the last unclamped point at the
    /// lower bound (1 == K-1 clamp lower, but happens to equal the raw value).
    /// Verified: 376 → raw = 16 − 15 = 1 still; 375 is the activation threshold.
    ///
    /// Actually: raw = K/2 − diff.div_euclid(ELO_DIVISOR)
    ///           = 16 − (375).div_euclid(25) = 16 − 15 = 1
    /// Clamp [1, 31] → 1. This is the exact boundary.
    ///
    /// Kills: an impl with a different divisor or K that places the boundary elsewhere.
    #[test]
    fn clamp_activation_lower_bound_exact_boundary() {
        assert_eq!(
            apply_elo(1375, 1000),
            1,
            "apply_elo(1375, 1000) must be 1 (clamp lower-bound activation: \
             diff = +375, raw = 16 − 15 = 1 exactly, clamped to 1)"
        );
    }

    /// RL-3: clamp activation — exactly diff = −375 → delta = 31 (upper bound activated).
    ///
    /// raw = 16 − (−375).div_euclid(25) = 16 − (−15) = 31.
    /// Clamp [1, 31] → 31. Exact upper-bound activation threshold.
    ///
    /// Kills: an impl where the upper bound fires at a different diff magnitude.
    #[test]
    fn clamp_activation_upper_bound_exact_boundary() {
        assert_eq!(
            apply_elo(1000, 1375),
            31,
            "apply_elo(1000, 1375) must be 31 (clamp upper-bound activation: \
             diff = −375, raw = 16 − (−15) = 31 exactly, clamped to 31)"
        );
    }

    /// RL-3: beyond clamp — diff = +400 → delta still 1 (saturated at lower bound).
    ///
    /// raw = 16 − 400/25 = 16 − 16 = 0, clamped up to 1.
    /// Confirms the clamp fires for values beyond the activation threshold.
    ///
    /// Kills: an impl that returns 0 (no lower-clamp), or that panics/wraps on large diffs.
    #[test]
    fn clamp_lower_saturated_beyond_boundary() {
        assert_eq!(
            apply_elo(1400, 1000),
            1,
            "apply_elo(1400, 1000) must be 1 (clamped; diff = +400, raw = 0 before clamp)"
        );
    }

    /// RL-3: beyond clamp — diff = −400 → delta still 31 (saturated at upper bound).
    ///
    /// raw = 16 − (−400).div_euclid(25) = 16 − (−16) = 32, clamped down to 31.
    ///
    /// Kills: an impl that returns 32 (no upper-clamp), or 30 (wrong K−1 value).
    #[test]
    fn clamp_upper_saturated_beyond_boundary() {
        assert_eq!(
            apply_elo(1000, 1400),
            31,
            "apply_elo(1000, 1400) must be 31 (clamped; diff = −400, raw = 32 before clamp)"
        );
    }

    // -----------------------------------------------------------------------
    // RL-11: compute_rating_update spot pins
    //
    // compute_rating_update(1000, 1000) == (1016, 984).
    // Boundary saturation pins (ADR-0119 D2 documented tolerance):
    //   compute_rating_update(i32::MAX, 1000) == (i32::MAX, 999)
    //   compute_rating_update(1000, i32::MIN) == (1001, i32::MIN)
    //
    // Note: at the i32 extremes, conservation is intentionally violated
    // (winner's rating is pinned by saturating_add, loser still moves).
    // This is the documented tolerated boundary behavior (ADR-0119 D2).
    // -----------------------------------------------------------------------

    /// RL-11: compute_rating_update(1000, 1000) == (1016, 984).
    ///
    /// apply_elo(1000, 1000) = 16; winner gains 16, loser loses 16.
    /// Sum = 1016 + 984 = 2000 = 1000 + 1000 (zero-sum in the practical domain).
    ///
    /// Kills: an impl where winner and loser both gain delta (wrong sign on loser),
    /// or where the tuple fields are swapped.
    #[test]
    fn compute_rating_update_equal_ratings() {
        assert_eq!(
            compute_rating_update(1000, 1000),
            (1016_i32, 984_i32),
            "compute_rating_update(1000, 1000) must be (1016, 984): \
             winner +16, loser −16 (ADR-0119 D2, RL-11)"
        );
    }

    /// RL-11 boundary: compute_rating_update(i32::MAX, 1000) saturates winner.
    ///
    /// apply_elo(i32::MAX, 1000) ∈ [1,31]; winner.saturating_add(delta) = i32::MAX
    /// (already maxed). Loser goes to 1000 − delta ∈ [969, 999]; delta = 1 for
    /// extreme diff, so loser = 999.
    ///
    /// This is the DOCUMENTED TOLERATED BOUNDARY where conservation is violated:
    /// winner is pinned at i32::MAX while loser still moves. (ADR-0119 D2).
    /// Asserted here to make the saturating semantics deliberate, not accidental.
    #[test]
    fn compute_rating_update_winner_at_i32_max_saturates() {
        let (new_w, new_l) = compute_rating_update(i32::MAX, 1000);
        // Winner: saturating_add — cannot exceed i32::MAX.
        assert_eq!(
            new_w,
            i32::MAX,
            "compute_rating_update(i32::MAX, 1000): winner must saturate at i32::MAX \
             (documented tolerated boundary, ADR-0119 D2 — conservation intentionally violated)"
        );
        // Loser: i32::MAX vs 1000 → huge diff → apply_elo clamps to 1 → loser loses 1 → 999.
        assert_eq!(
            new_l, 999_i32,
            "compute_rating_update(i32::MAX, 1000): loser must be 999 \
             (apply_elo clamps to 1 at extreme diff; 1000 − 1 = 999)"
        );
    }

    /// RL-11 boundary: compute_rating_update(1000, i32::MIN) saturates loser.
    ///
    /// apply_elo(1000, i32::MIN) → winner above loser by i32::MAX−999 (huge diff)
    /// → apply_elo clamps to 1 → winner = 1001, loser.saturating_sub(1) = i32::MIN
    /// (already at floor).
    ///
    /// Documented tolerated boundary (ADR-0119 D2): loser pinned at i32::MIN,
    /// conservation intentionally violated.
    #[test]
    fn compute_rating_update_loser_at_i32_min_saturates() {
        let (new_w, new_l) = compute_rating_update(1000, i32::MIN);
        // Winner: 1000 + 1 (clamped delta at extreme diff).
        assert_eq!(
            new_w, 1001_i32,
            "compute_rating_update(1000, i32::MIN): winner must be 1001 \
             (delta clamped to 1 at extreme diff; 1000 + 1 = 1001)"
        );
        // Loser: saturating_sub — cannot go below i32::MIN.
        assert_eq!(
            new_l,
            i32::MIN,
            "compute_rating_update(1000, i32::MIN): loser must saturate at i32::MIN \
             (documented tolerated boundary, ADR-0119 D2 — conservation intentionally violated)"
        );
    }

    // -----------------------------------------------------------------------
    // RL-3/RL-12: property tests
    // -----------------------------------------------------------------------

    proptest! {
        /// RL-3 property: apply_elo is always in [1, 31] for any i32 × i32 input.
        ///
        /// No panic, no out-of-range result. Covers all i32 combinations (fast-check
        /// style via proptest arbitrary i32 × i32 range).
        ///
        /// Kills: an impl that can return 0, 32, or panic on extreme inputs (e.g.
        /// integer overflow when computing winner − loser as i32 without widening).
        #[test]
        fn prop_apply_elo_always_in_range(
            winner in i32::MIN..=i32::MAX,
            loser in i32::MIN..=i32::MAX,
        ) {
            let delta = apply_elo(winner, loser);
            prop_assert!(
                delta >= 1 && delta <= 31,
                "apply_elo({}, {}) = {} is outside [1, 31] — \
                 must always be clamped to [1, K-1]",
                winner, loser, delta
            );
        }

        /// RL-12: determinism — apply_elo is referentially transparent.
        ///
        /// Identical inputs must yield identical outputs across repeated calls.
        /// Kills: any impl that draws from ambient entropy or wall-clock (ADR-0055).
        #[test]
        fn prop_apply_elo_is_deterministic(
            winner in i32::MIN..=i32::MAX,
            loser in i32::MIN..=i32::MAX,
        ) {
            let a = apply_elo(winner, loser);
            let b = apply_elo(winner, loser);
            prop_assert_eq!(
                a,
                b,
                "apply_elo({}, {}) returned different values on repeated calls: \
                 {} vs {} — must be deterministic (no ambient entropy, ADR-0055)",
                winner, loser, a, b
            );
        }

        /// RL-11 conservation on the practical domain: sum of ratings is invariant.
        ///
        /// For |rating| ≤ 1_000_000, compute_rating_update must be zero-sum:
        ///   (new_winner as i64) + (new_loser as i64) == (winner as i64) + (loser as i64).
        ///
        /// Computed in i64 to avoid overflow when summing two i32-range values.
        /// The practical domain bound (10^6) is far from i32::MAX (~2.1×10^9), so
        /// saturating_add/sub never activates and conservation holds exactly.
        ///
        /// Kills: an impl where winner and loser both gain delta (wrong sign),
        /// or where deltas differ (one side uses apply_elo(w,l), other uses apply_elo(l,w)).
        #[test]
        fn prop_conservation_on_practical_domain(
            winner in -1_000_000_i32..=1_000_000_i32,
            loser in -1_000_000_i32..=1_000_000_i32,
        ) {
            let (new_w, new_l) = compute_rating_update(winner, loser);
            let sum_before = (winner as i64) + (loser as i64);
            let sum_after = (new_w as i64) + (new_l as i64);
            prop_assert_eq!(
                sum_before,
                sum_after,
                "compute_rating_update({}, {}) is not zero-sum: \
                 before={}, after={} (new_w={}, new_l={}). \
                 Must be: winner gains exactly delta, loser loses exactly delta (RL-11)",
                winner, loser, sum_before, sum_after, new_w, new_l
            );
        }

        /// RL-3 monotonicity: as winner rating rises (loser fixed at 1000), delta is
        /// non-increasing; strictly decreasing across each 25-multiple boundary.
        ///
        /// Tests the unclamped region: winner in 626..=1374 (diff in −374..=+374, within
        /// clamp bounds), loser fixed at 1000. Incrementing winner by 1 never increases
        /// delta; incrementing by 25 (one full ELO_DIVISOR step) strictly decreases it.
        ///
        /// Kills: an impl using a wrong sign or addition instead of subtraction in the
        /// formula (would make delta increase as winner rises — backwards monotonicity).
        #[test]
        fn prop_monotone_delta_as_winner_rises(
            winner in 627_i32..=1373_i32,
        ) {
            let loser = 1000_i32;
            let delta_at = apply_elo(winner, loser);
            let delta_minus_one = apply_elo(winner - 1, loser);
            // Delta must be non-increasing as winner rises: delta_at <= delta at winner-1.
            prop_assert!(
                delta_at <= delta_minus_one,
                "apply_elo({}, {}) = {} > apply_elo({}, {}) = {} — \
                 delta must be non-increasing as winner rating rises (RL-3 monotonicity). \
                 Kills: sign-flip or addition-instead-of-subtraction in the formula.",
                winner, loser, delta_at, winner - 1, loser, delta_minus_one
            );
            // Across an ELO_DIVISOR boundary (25 steps), delta must strictly decrease.
            // Only check if winner-25 is also in the unclamped range.
            if winner >= 651 {
                let delta_minus_25 = apply_elo(winner - 25, loser);
                prop_assert!(
                    delta_at < delta_minus_25,
                    "apply_elo({}, {}) = {} is not strictly less than \
                     apply_elo({}, {}) = {} — across one ELO_DIVISOR step (25 units), \
                     delta must strictly decrease (RL-3 div_euclid floor monotonicity). \
                     Kills: off-by-one in the divisor or wrong rounding direction.",
                    winner, loser, delta_at, winner - 25, loser, delta_minus_25
                );
            }
        }
    }
}
