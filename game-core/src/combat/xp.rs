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

/// Apply the 0.1× practice-battle XP penalty (ADR-0078).
///
/// `is_practice=true` (opponent != WILD_IDENTITY): `floor(base / 10)`; may yield 0.
/// `is_practice=false` (wild battle): `base` unchanged.
#[must_use]
pub fn practice_xp_reward(base: Xp, is_practice: bool) -> Xp {
    if is_practice {
        Xp::new(base.value() / 10)
    } else {
        base
    }
}

/// Apply earned XP to a monster's current XP pool.
///
/// Returns `(new_xp, new_level, did_level_up)`.
///
/// - `gained = Xp::new(0)` is valid and produces no change (used when practice XP floors to 0).
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

/// Current HP after a level-up's max-HP growth.
///
/// On level-up a monster's maximum HP can increase; the engine heals it by
/// exactly that growth (`new_max_hp - old_max_hp`), so a full-HP monster stays
/// full and a damaged one preserves its HP deficit across the level boundary.
/// This is the SSOT for that rule (ADR-0003); the server shell calls it rather
/// than re-implementing the formula in the reducer.
///
/// Saturating in both directions: a (defensively impossible) max-HP *decrease*
/// yields no heal, and the heal cannot overflow `u16`.
#[must_use]
pub fn level_up_healed_hp(current_hp: u16, old_max_hp: u16, new_max_hp: u16) -> u16 {
    current_hp.saturating_add(new_max_hp.saturating_sub(old_max_hp))
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

    // -----------------------------------------------------------------------
    // M8.8b-B: level_up_healed_hp behavioral tests
    // -----------------------------------------------------------------------

    /// Damaged monster heals by the max-HP growth delta on level-up.
    ///
    /// current_hp=40, old_max_hp=100, new_max_hp=110:
    ///   delta = 110 - 100 = 10 (saturating_sub)
    ///   result = 40 + 10 = 50 (saturating_add)
    ///
    /// Mirrors the r14_hp_delta_on_level_up_is_correct_for_damaged_monster formula.
    /// Pin: must equal exactly 50.
    ///
    /// Kills: a mutant using wrapping_add (same result here but wrong contract);
    /// a mutant that doesn't add the delta at all (returns 40); a mutant that
    /// returns new_max_hp instead of healed current (returns 110).
    ///
    /// RED state: compile-RED because `level_up_healed_hp` does not exist yet.
    #[test]
    fn level_up_healed_hp_damaged_monster_heals_by_delta() {
        let result = level_up_healed_hp(40, 100, 110);
        assert_eq!(
            result, 50,
            "TEETH: level_up_healed_hp(40, 100, 110) must return 50 \
             (current 40 + delta 10 = 50); a mutant returning 40 (no heal) or \
             110 (new max) or 60 (wrong delta) fails here"
        );
    }

    /// No max-HP growth means no heal: current_hp is returned unchanged.
    ///
    /// current_hp=40, old_max_hp=100, new_max_hp=100:
    ///   delta = 100 - 100 = 0
    ///   result = 40 + 0 = 40
    ///
    /// Kills: a mutant that always adds 1 or uses the max_hp directly.
    ///
    /// RED state: compile-RED because `level_up_healed_hp` does not exist yet.
    #[test]
    fn level_up_healed_hp_no_growth_returns_unchanged() {
        let result = level_up_healed_hp(40, 100, 100);
        assert_eq!(
            result, 40,
            "TEETH: level_up_healed_hp(40, 100, 100) must return 40 \
             (no max-HP growth → no heal); a mutant that heals anyway fails here"
        );
    }

    /// Defensive max-HP DECREASE yields no heal and no underflow.
    ///
    /// current_hp=40, old_max_hp=100, new_max_hp=90:
    ///   saturating_sub: 90.saturating_sub(100) = 0 (no negative delta)
    ///   result = 40 + 0 = 40 (hp unchanged; never heals down)
    ///
    /// Kills: a mutant using wrapping_sub (100→90 wraps to 65526, healing massively);
    /// a mutant using signed subtraction (negative delta would subtract from HP).
    ///
    /// RED state: compile-RED because `level_up_healed_hp` does not exist yet.
    #[test]
    fn level_up_healed_hp_decrease_yields_no_heal_and_no_underflow() {
        let result = level_up_healed_hp(40, 100, 90);
        assert_eq!(
            result, 40,
            "TEETH: level_up_healed_hp(40, 100, 90) must return 40 \
             (max-HP decrease → saturating_sub gives 0 delta → no change); \
             a wrapping_sub mutant would return 40 + (90u16.wrapping_sub(100)) = \
             40 + 65526 = 65535 (saturating) or wrap entirely — fails here"
        );
    }

    /// Saturating add near the u16 ceiling: the result must not overflow.
    ///
    /// current_hp = u16::MAX - 5 = 65530
    /// old_max_hp = 0
    /// new_max_hp = u16::MAX = 65535
    ///   delta = 65535.saturating_sub(0) = 65535
    ///   result = 65530.saturating_add(65535) = u16::MAX (saturates, no wrap)
    ///
    /// Kills: a mutant using wrapping_add (65530 + 65535 = 131065, wraps to
    /// 131065 % 65536 = 65529 ≠ u16::MAX).
    ///
    /// RED state: compile-RED because `level_up_healed_hp` does not exist yet.
    #[test]
    fn level_up_healed_hp_saturates_at_u16_max() {
        let result = level_up_healed_hp(u16::MAX - 5, 0, u16::MAX);
        assert_eq!(
            result,
            u16::MAX,
            "TEETH: level_up_healed_hp(u16::MAX-5, 0, u16::MAX) must return u16::MAX \
             (saturating_add prevents wrap); a wrapping_add mutant returns \
             65529 ≠ u16::MAX — fails here"
        );
    }

    // -----------------------------------------------------------------------
    // M12.5e2: practice_xp_reward — gating tests
    // -----------------------------------------------------------------------

    /// Known-answer: floor(64/10) = 6 (not 6.4).
    /// Kills: wrong operator (multiply instead of divide), rounding up instead of floor.
    /// RED: compile-RED until `practice_xp_reward` is declared.
    #[test]
    fn practice_xp_known_answer_floor() {
        assert_eq!(
            practice_xp_reward(Xp::new(64), true).value(),
            6,
            "practice_xp_reward(64, true) must be 6 (floor(64/10)=6)"
        );
    }

    /// Floor truncates to zero for small base XP.
    /// Kills: a min-1 impl that returns Xp::new(1) instead of Xp::new(0).
    /// RED: compile-RED until `practice_xp_reward` is declared.
    #[test]
    fn practice_xp_floor_truncates_to_zero() {
        assert_eq!(
            practice_xp_reward(Xp::new(9), true).value(),
            0,
            "practice_xp_reward(9, true) must be 0 (floor(9/10)=0, min is 0 not 1)"
        );
    }

    /// is_practice=false returns base unchanged (wild-battle passthrough).
    /// Kills: an impl that always applies the multiplier regardless of the flag.
    /// RED: compile-RED until `practice_xp_reward` is declared.
    #[test]
    fn practice_xp_passthrough_when_not_practice() {
        assert_eq!(
            practice_xp_reward(Xp::new(64), false).value(),
            64,
            "practice_xp_reward(64, false) must return 64 unchanged (not a practice battle)"
        );
    }

    /// Zero base XP stays zero in both modes.
    /// Edge case: ensures no +1 floor in either code path.
    /// RED: compile-RED until `practice_xp_reward` is declared.
    #[test]
    fn practice_xp_zero_input() {
        assert_eq!(
            practice_xp_reward(Xp::new(0), true).value(),
            0,
            "practice_xp_reward(0, true) must be 0"
        );
        assert_eq!(
            practice_xp_reward(Xp::new(0), false).value(),
            0,
            "practice_xp_reward(0, false) must be 0"
        );
    }

    /// Composed: small base XP floored to 0 by practice penalty is a no-op in apply_xp_gain.
    /// Kills: a future apply_xp_gain mutation that treats zero gain as a level-up trigger.
    #[test]
    fn practice_xp_zero_floor_composes_with_apply_xp_gain() {
        // base=9, practice=true → practice_xp_reward yields 0 (floor(9/10)=0)
        let floored = practice_xp_reward(Xp::new(9), true);
        assert_eq!(floored.value(), 0);
        let start_xp = Xp::new(1); // level 1
        let (new_xp, _new_level, did_level_up) = apply_xp_gain(start_xp, floored);
        assert_eq!(new_xp.value(), 1, "zero XP gain must leave XP unchanged");
        assert!(
            !did_level_up,
            "TEETH: zero XP gain must not trigger a level-up"
        );
    }

    // -----------------------------------------------------------------------
    // M12.5e2 red-team: minimum pipeline and exact-divisor boundary
    // -----------------------------------------------------------------------

    /// RT-PX-01: Minimum battle_xp_reward output (1) fed into practice_xp_reward
    /// yields 0 — the floor truncates the +1 minimum to nothing for practice battles.
    ///
    /// Scenario: L100 winner defeats a L1 opponent with the minimum possible BST (1).
    ///   battle_xp_reward(L100, bst=1, L1) = 1*1/(5*100) + 1 = 0 + 1 = 1
    ///   practice_xp_reward(1, true)        = floor(1/10) = 0
    ///
    /// Kills: any impl that adds a +1 floor inside practice_xp_reward
    /// (which would return 1 instead of 0 here, violating the spec).
    /// Also kills: any "minimum-1" practice impl.
    ///
    /// This composition test is orthogonal to the component tests: it verifies
    /// the PIPELINE invariant that the +1 in battle_xp_reward does NOT perturb
    /// the 0-floor behavior of the practice rule (ADR-0078 §rationale).
    #[test]
    fn rt_px_01_min_battle_xp_through_practice_floors_to_zero() {
        let base = battle_xp_reward(level(100), 1, level(1));
        assert_eq!(
            base.value(),
            1,
            "RT-PX-01: battle_xp_reward(L100, bst=1, L1) must be 1 (the minimum)"
        );
        let practice = practice_xp_reward(base, true);
        assert_eq!(
            practice.value(),
            0,
            "RT-PX-01: practice_xp_reward(1, true) must be 0 — \
             floor(1/10)=0; a +1 floor inside practice_xp_reward would return 1 \
             and violate the spec (ADR-0078: minimum is 0, not 1)"
        );
    }

    /// RT-PX-02: Exact divisor boundary — base_xp=10 yields practice_xp=1.
    ///
    /// Scenario: L1 winner defeats a L45 opponent with BST=1.
    ///   battle_xp_reward(L1, bst=1, L45) = 1*45/(5*1) + 1 = 9 + 1 = 10
    ///   practice_xp_reward(10, true)      = floor(10/10) = 1
    ///
    /// Kills: an impl using ceiling instead of floor (ceil(10/10)=1 agrees here,
    /// but differs at base=11: floor=1 vs ceil=2); combined with practice_xp_floor_truncates_to_zero
    /// (which pins floor(9/10)=0 vs ceil(9/10)=1) these two tests fully pin the rounding direction.
    ///
    /// This is the first base_xp that yields non-zero practice XP. The crossing
    /// from 0 to 1 is the critical boundary for the "no XP from trivial self-battles"
    /// design intent (ADR-0078).
    #[test]
    fn rt_px_02_exact_divisor_yields_one_practice_xp() {
        let base = battle_xp_reward(level(1), 1, level(45));
        assert_eq!(
            base.value(),
            10,
            "RT-PX-02: battle_xp_reward(L1, bst=1, L45) must be 10 (exact divisor)"
        );
        let practice = practice_xp_reward(base, true);
        assert_eq!(
            practice.value(),
            1,
            "RT-PX-02: practice_xp_reward(10, true) must be 1 (floor(10/10)=1); \
             this is the first base_xp that yields non-zero practice XP (ADR-0078)"
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

        /// practice XP must never exceed the base reward (the multiplier is a penalty).
        /// Kills: any impl that inflates XP instead of reducing it.
        /// RED: compile-RED until `practice_xp_reward` is declared.
        #[test]
        fn prop_practice_xp_never_exceeds_base(
            base in 0u32..u32::MAX/2,
            is_practice in proptest::bool::ANY,
        ) {
            let result = practice_xp_reward(Xp::new(base), is_practice);
            prop_assert!(
                result.value() <= base,
                "practice_xp_reward must never exceed base ({base} → {result_val})",
                result_val = result.value()
            );
        }
    }
}
