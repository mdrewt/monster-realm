//! XP reward and level-up for the combat engine.
//!
//! After a battle victory, the winning side's active monster earns XP via
//! `battle_xp_reward`. The level-up logic in `apply_xp_gain` is a thin
//! wrapper over the already-existing `level_for_xp` and `xp_for_level` from
//! `monster::rules`.
//!
//! # XP reward formula
//! ```text
//! reward = (loser_base_stat_total / 5) * (loser_level / winner_level) + 1
//! ```
//! clamped to a minimum of 1 (the `+1` guarantees it). All arithmetic uses
//! `u32` intermediates.
//!
//! # apply_xp_gain return contract
//! Returns `(new_xp, new_level, did_level_up)`.
//!
//! If the resulting XP would bring the monster past level 100, XP is clamped
//! to `xp_for_level(Level::new(100).unwrap())` and the level is capped at 100.

use crate::monster::types::{Level, Xp};

/// Compute the XP reward for defeating the loser.
///
/// `winner_level`: the level of the winning monster.
/// `loser_base_stat_total`: the sum of all six base stats of the loser's species.
/// `loser_level`: the level of the losing monster.
///
/// Returns at least `Xp::new(1)`.
pub fn battle_xp_reward(winner_level: Level, loser_base_stat_total: u16, loser_level: Level) -> Xp {
    todo!()
}

/// Apply earned XP to a monster's current XP pool.
///
/// Returns `(new_xp, new_level, did_level_up)`.
///
/// - If the new XP exceeds what is needed for level 100, clamp to `xp_for_level(100)`.
/// - `did_level_up` is `true` if and only if `new_level > old_level`.
pub fn apply_xp_gain(current_xp: Xp, gained: Xp) -> (Xp, Level, bool) {
    todo!()
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monster::rules::xp_for_level;
    use crate::monster::types::{Level, Xp};
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Helper
    // -----------------------------------------------------------------------

    fn level(v: u8) -> Level {
        Level::new(v).unwrap()
    }

    // -----------------------------------------------------------------------
    // Known-answer XP reward
    //
    // winner_level = 5, loser_base_stat_total = 318 (classic Bulbasaur total:
    //   45+49+49+65+65+45), loser_level = 5
    //
    // reward = (318 / 5) * (5 / 5) + 1
    //        = 63 * 1 + 1 = 64
    // -----------------------------------------------------------------------

    /// Kills: an impl with the wrong formula, wrong truncation, or wrong floor.
    /// Starts red because `battle_xp_reward` is `todo!()`.
    #[test]
    #[should_panic]
    fn known_answer_xp_reward_equal_levels() {
        let xp = battle_xp_reward(level(5), 318, level(5));
        assert_eq!(xp.value(), 64, "expected XP reward of 64");
    }

    // -----------------------------------------------------------------------
    // apply_xp_gain causing level-up
    // -----------------------------------------------------------------------

    /// Kills: an impl that never sets did_level_up = true, or uses wrong level curve.
    ///
    /// Level 1 requires 1 XP, level 2 requires 8 XP.
    /// Start at XP=1 (level 1), gain 7 → total 8 = xp_for_level(2) → level up to 2.
    ///
    /// Starts red because `apply_xp_gain` is `todo!()`.
    #[test]
    #[should_panic]
    fn apply_xp_gain_causes_level_up() {
        // Level 1: xp_for_level(1) = 1; level 2: xp_for_level(2) = 8
        let (new_xp, new_level, did_level_up) = apply_xp_gain(Xp::new(1), Xp::new(7));
        assert_eq!(new_xp.value(), 8, "XP must be 8 after gaining 7 from 1");
        assert_eq!(new_level.as_u8(), 2, "must be level 2 at 8 XP");
        assert!(
            did_level_up,
            "did_level_up must be true when level increases"
        );
    }

    // -----------------------------------------------------------------------
    // apply_xp_gain NOT causing level-up
    // -----------------------------------------------------------------------

    /// Kills: an impl that always returns did_level_up=true.
    ///
    /// Level 1 requires 1 XP, level 2 requires 8 XP.
    /// Start at XP=1 (level 1), gain 3 → total 4, still level 1.
    ///
    /// Starts red because `apply_xp_gain` is `todo!()`.
    #[test]
    #[should_panic]
    fn apply_xp_gain_without_level_up() {
        let (new_xp, new_level, did_level_up) = apply_xp_gain(Xp::new(1), Xp::new(3));
        assert_eq!(new_xp.value(), 4, "XP must be 4 after gaining 3 from 1");
        assert_eq!(new_level.as_u8(), 1, "must remain level 1 at 4 XP");
        assert!(
            !did_level_up,
            "did_level_up must be false when level does not change"
        );
    }

    // -----------------------------------------------------------------------
    // Level 100 XP cap
    // -----------------------------------------------------------------------

    /// Kills: an impl that overflows or allows XP above level-100 threshold.
    ///
    /// xp_for_level(100) = 1_000_000. Gaining more when already at that XP
    /// must clamp to 1_000_000 and remain level 100.
    ///
    /// Starts red because `apply_xp_gain` is `todo!()`.
    #[test]
    #[should_panic]
    fn apply_xp_gain_capped_at_level_100() {
        // Already at level-100 XP threshold
        let xp_cap = xp_for_level(level(100));
        let (new_xp, new_level, did_level_up) = apply_xp_gain(xp_cap, Xp::new(1_000));
        assert_eq!(
            new_xp.value(),
            xp_cap.value(),
            "XP must be clamped to {}",
            xp_cap.value()
        );
        assert_eq!(new_level.as_u8(), 100, "level must remain 100 after cap");
        assert!(
            !did_level_up,
            "did_level_up must be false when already at max level"
        );
    }

    // -----------------------------------------------------------------------
    // Property: battle_xp_reward always >= 1
    // -----------------------------------------------------------------------

    fn arb_level() -> impl Strategy<Value = Level> {
        (1u8..=100).prop_map(|v| Level::new(v).unwrap())
    }

    proptest! {
        /// Kills: an impl where the formula can produce 0 (missing the +1 floor).
        /// Starts red because `battle_xp_reward` is `todo!()`.
        #[test]
        fn prop_battle_xp_reward_always_at_least_1(
            winner_level in arb_level(),
            loser_level in arb_level(),
            loser_bst in 1u16..=1530, // 255 * 6
        ) {
            let xp = battle_xp_reward(winner_level, loser_bst, loser_level);
            prop_assert!(xp.value() >= 1, "XP reward must be at least 1");
        }

        /// Kills: an impl where more XP causes level to decrease.
        /// Compares two calls: gaining less XP must yield a level <= gaining more XP.
        /// Starts red because `apply_xp_gain` is `todo!()`.
        #[test]
        fn prop_apply_xp_gain_level_is_non_decreasing(
            base_xp in 0u32..500_000,
            gain_small in 0u32..500_000,
            extra in 0u32..500_000,
        ) {
            let gain_large = gain_small.saturating_add(extra);
            let (_, level_small, _) = apply_xp_gain(Xp::new(base_xp), Xp::new(gain_small));
            let (_, level_large, _) = apply_xp_gain(Xp::new(base_xp), Xp::new(gain_large));
            prop_assert!(
                level_small.as_u8() <= level_large.as_u8(),
                "gaining more XP ({gain_large}) must never yield a lower level than gaining less ({gain_small})"
            );
        }
    }
}
