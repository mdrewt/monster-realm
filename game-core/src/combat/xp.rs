//! XP reward and level-up for the combat engine.
//!
//! After a battle victory, the winning side's active monster earns XP via
//! `battle_xp_reward`. The level-up logic in `apply_xp_gain` is a thin
//! wrapper over the already-existing `level_for_xp` and `xp_for_level` from
//! `monster::rules`.
//!
//! # XP reward formula
//! ```text
//! reward = loser_base_stat_total * loser_level / (5 * winner_level) + 1
//! ```
//! clamped to a minimum of 1 (the `+1` guarantees it). All arithmetic uses
//! `u32` intermediates.
//!
//! # apply_xp_gain return contract
//! Returns `(new_xp, new_level, did_level_up)`.
//!
//! If the resulting XP would bring the monster past level 100, XP is clamped
//! to `xp_for_level(Level::new(100).unwrap())` and the level is capped at 100.

use crate::monster::rules::{level_for_xp, xp_for_level};
use crate::monster::types::StatBlock;
use crate::monster::types::{Level, Xp};

/// Sum of a species' six base stats (the base-stat-total used by the XP reward
/// rule). The rule layer owns this definition (SSOT); the server shell only
/// marshals rows into it. Saturating so an out-of-range StatBlock cannot wrap.
#[must_use]
pub fn base_stat_total(base: &StatBlock) -> u16 {
    base.hp
        .saturating_add(base.attack)
        .saturating_add(base.defense)
        .saturating_add(base.speed)
        .saturating_add(base.sp_attack)
        .saturating_add(base.sp_defense)
}

/// Compute the XP reward for defeating the loser.
///
/// `winner_level`: the level of the winning monster.
/// `loser_base_stat_total`: the sum of all six base stats of the loser's species.
/// `loser_level`: the level of the losing monster.
///
/// Returns at least `Xp::new(1)`.
pub fn battle_xp_reward(winner_level: Level, loser_base_stat_total: u16, loser_level: Level) -> Xp {
    let bst = u32::from(loser_base_stat_total);
    let l_loser = u32::from(loser_level.as_u8());
    let l_winner = u32::from(winner_level.as_u8());
    // Multiply before dividing to reduce integer-truncation precision loss.
    // E.g. winner_level=10, loser_level=5: old order gave 5/10=0; new order gives bst*5/(5*10).
    let reward = bst * l_loser / (5 * l_winner) + 1;
    Xp::new(reward)
}

/// Apply earned XP to a monster's current XP pool.
///
/// Returns `(new_xp, new_level, did_level_up)`.
///
/// - If the new XP exceeds what is needed for level 100, clamp to `xp_for_level(100)`.
/// - `did_level_up` is `true` if and only if `new_level > old_level`.
pub fn apply_xp_gain(current_xp: Xp, gained: Xp) -> (Xp, Level, bool) {
    let max_xp = xp_for_level(Level::new(100).unwrap());
    let old_level = level_for_xp(current_xp);
    let total = current_xp.value().saturating_add(gained.value());
    let clamped = std::cmp::min(total, max_xp.value());
    let new_xp = Xp::new(clamped);
    let new_level = level_for_xp(new_xp);
    let did_level_up = new_level.as_u8() > old_level.as_u8();
    (new_xp, new_level, did_level_up)
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

    // -----------------------------------------------------------------------
    // M8.5b-D: base_stat_total — new pure function (BST)
    // -----------------------------------------------------------------------

    /// Kills: an impl that sums with wrapping add instead of saturating add,
    /// or gets the field order wrong, or drops a field.
    ///
    /// Classic Bulbasaur: 45+49+49+65+65+45 = 318.
    /// This is the same BST used by the xp reward formula's known-answer test,
    /// so any deviation from 318 would also break that test — the two pin each other.
    ///
    /// RED state: compile-RED until `base_stat_total` is declared in `xp.rs`
    /// and re-exported via `combat/mod.rs` + `game-core/src/lib.rs`.
    #[test]
    fn base_stat_total_known_answer() {
        use crate::monster::types::StatBlock;
        let bulbasaur = StatBlock {
            hp: 45,
            attack: 49,
            defense: 49,
            speed: 65,
            sp_attack: 65,
            sp_defense: 45,
        };
        let bst = base_stat_total(&bulbasaur);
        assert_eq!(
            bst, 318,
            "Bulbasaur BST must be 318 (45+49+49+65+65+45); \
             got {bst} — wrong field ordering or dropped field"
        );
    }

    /// Kills: an impl that uses wrapping addition (overflows past u16::MAX back to 0)
    /// instead of saturating addition (clamps at u16::MAX).
    ///
    /// All six fields == u16::MAX (65535). Saturating sum:
    ///   65535 + 65535 = 65535 (sat) → +65535 = 65535 → ... = 65535 after all six.
    ///
    /// Wrapping sum: 65535*6 = 393210. u16 wraps: 393210 % 65536 = 393210 - 6*65536 = 393210 - 393216 = -6
    /// Actually: 393210 mod 65536 = 393210 - 5*65536 = 393210 - 327680 = 65530 (≠ 65535).
    /// So wrapping gives 65530, NOT 65535 — the assertion `== u16::MAX` bites.
    ///
    /// RED state: compile-RED until `base_stat_total` exists.
    #[test]
    fn base_stat_total_saturates() {
        use crate::monster::types::StatBlock;
        let max_block = StatBlock {
            hp: u16::MAX,
            attack: u16::MAX,
            defense: u16::MAX,
            speed: u16::MAX,
            sp_attack: u16::MAX,
            sp_defense: u16::MAX,
        };
        let bst = base_stat_total(&max_block);
        assert_eq!(
            bst,
            u16::MAX,
            "BST of all-u16::MAX stats must saturate to u16::MAX (65535), \
             not wrap to 65530 — TEETH: wrapping sum gives 65530 ≠ u16::MAX"
        );
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
