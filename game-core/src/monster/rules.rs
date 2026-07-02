//! Stat derivation and XP/level rules — pure, deterministic, integer-only.
//!
//! The stat formula uses u32 intermediates and truncating integer division
//! (no floats, so the native and wasm paths cannot numerically diverge).
//!
//! HP formula:  ((2 * base_hp + iv_hp + ev_hp/4) * level / 100) + level + 10
//! Other stat:  (((2 * base + iv + ev/4) * level / 100) + 5) * nat_num / nat_den
//!
//! XP curve: `level^3` (medium-fast).

use super::types::{EVs, IVs, Level, Nature, StatBlock, StatKind, Xp};

/// Derive a monster's final stats from base stats, IVs, EVs, nature, and level.
///
/// Uses the standard integer formula (u32 intermediates, truncating division):
/// - HP  = ((2*base + iv + ev/4) * level / 100) + level + 10
/// - Stat = (((2*base + iv + ev/4) * level / 100) + 5) * nat_num / nat_den
///
/// Nature never modifies HP.
#[must_use]
pub fn derive_stats(
    base: &StatBlock,
    ivs: &IVs,
    evs: &EVs,
    nature: &Nature,
    level: Level,
) -> StatBlock {
    let lv = u32::from(level.as_u8());

    let hp = {
        let b = u32::from(base.get(StatKind::Hp));
        let iv = u32::from(ivs.get(StatKind::Hp));
        let ev = u32::from(evs.get(StatKind::Hp));
        let raw = (2 * b + iv + ev / 4) * lv / 100 + lv + 10;
        u16::try_from(raw).unwrap_or(u16::MAX)
    };

    let mut stats = StatBlock {
        hp,
        attack: 0,
        defense: 0,
        speed: 0,
        sp_attack: 0,
        sp_defense: 0,
    };

    let non_hp = [
        StatKind::Attack,
        StatKind::Defense,
        StatKind::Speed,
        StatKind::SpAttack,
        StatKind::SpDefense,
    ];
    for kind in non_hp {
        let b = u32::from(base.get(kind));
        let iv = u32::from(ivs.get(kind));
        let ev = u32::from(evs.get(kind));
        let (nat_num, nat_den) = nature.stat_modifier(kind);
        let raw = ((2 * b + iv + ev / 4) * lv / 100 + 5) * u32::from(nat_num) / u32::from(nat_den);
        stats.set(kind, u16::try_from(raw).unwrap_or(u16::MAX));
    }

    stats
}

/// XP required to reach `level` (medium-fast curve: level^3).
#[must_use]
pub fn xp_for_level(level: Level) -> Xp {
    let l = u32::from(level.as_u8());
    Xp::new(l * l * l)
}

/// The highest level `l` in [1, 100] such that `l^3 <= xp`.
#[must_use]
pub fn level_for_xp(xp: Xp) -> Level {
    let x = xp.value();
    // Binary search for the largest l in [1, 100] such that l³ ≤ x.
    // Bounded `for` (7 iterations always converge: 2^7 = 128 > 100) instead of
    // `while lo < hi`: an arithmetic mutation of the search then terminates
    // with a wrong answer (caught by the exhaustive roundtrip test) instead of
    // hanging — pre-refactor this function produced 5 nightly cargo-mutants
    // TIMEOUTs. `saturating_sub` keeps `mid` stable if `hi` dips below `lo`
    // (only reachable for xp=0, which floors to level 1 as before).
    let mut lo: u8 = 1;
    let mut hi: u8 = 100;
    for _ in 0..7 {
        let mid = lo + hi.saturating_sub(lo).div_ceil(2);
        let m = u32::from(mid);
        if m * m * m <= x {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Level::new(lo).unwrap()
}

/// The XP bounds for `level`: (xp_for_level(l), xp_for_level(min(l+1, 100))).
#[must_use]
pub fn level_bounds(level: Level) -> (Xp, Xp) {
    let lo = xp_for_level(level);
    let hi_level = if level.as_u8() >= 100 {
        level
    } else {
        Level::new(level.as_u8() + 1).unwrap()
    };
    let hi = xp_for_level(hi_level);
    (lo, hi)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monster::types::NatureKind;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Helpers for constructing test inputs
    // -----------------------------------------------------------------------

    fn base_bulba() -> StatBlock {
        StatBlock {
            hp: 45,
            attack: 49,
            defense: 49,
            speed: 65,
            sp_attack: 65,
            sp_defense: 45,
        }
    }

    fn ivs_all_15() -> IVs {
        IVs::new(15, 15, 15, 15, 15, 15).unwrap()
    }

    fn neutral() -> Nature {
        Nature::new(NatureKind::Hardy)
    }

    // -----------------------------------------------------------------------
    // Proptest strategies
    // -----------------------------------------------------------------------

    fn arb_level() -> impl Strategy<Value = Level> {
        (1u8..=100).prop_map(|v| Level::new(v).unwrap())
    }

    fn arb_ivs() -> impl Strategy<Value = IVs> {
        (0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31).prop_map(
            |(hp, atk, def, spd, spa, spd2)| IVs::new(hp, atk, def, spd, spa, spd2).unwrap(),
        )
    }

    fn arb_evs() -> impl Strategy<Value = EVs> {
        (
            0u16..=252,
            0u16..=252,
            0u16..=252,
            0u16..=252,
            0u16..=252,
            0u16..=252,
        )
            .prop_filter("total must be <= 510", |(a, b, c, d, e, f)| {
                a + b + c + d + e + f <= 510
            })
            .prop_map(|(hp, atk, def, spd, spa, spd2)| {
                EVs::new(hp, atk, def, spd, spa, spd2).unwrap()
            })
    }

    fn arb_nature() -> impl Strategy<Value = Nature> {
        (0u8..25).prop_map(Nature::from_index)
    }

    fn arb_base_stats() -> impl Strategy<Value = StatBlock> {
        // Realistic base stat range [1, 255]
        (
            1u16..=255,
            1u16..=255,
            1u16..=255,
            1u16..=255,
            1u16..=255,
            1u16..=255,
        )
            .prop_map(|(hp, atk, def, spd, spa, spd2)| StatBlock {
                hp,
                attack: atk,
                defense: def,
                speed: spd,
                sp_attack: spa,
                sp_defense: spd2,
            })
    }

    // =======================================================================
    // Example-based tests — derive_stats
    // =======================================================================

    /// #28: Known-answer test for derive_stats.
    /// Hand-computed with truncating integer division:
    ///
    /// base: (45, 49, 49, 65, 65, 45), iv: all 15, ev: all 0, neutral, level 5
    ///
    /// HP  = ((2*45 + 15 + 0) * 5 / 100) + 5 + 10
    ///     = (105 * 5 / 100) + 15
    ///     = (525 / 100) + 15
    ///     = 5 + 15 = 20
    ///
    /// Attack = (((2*49 + 15 + 0) * 5 / 100) + 5) * 10 / 10
    ///        = ((113 * 5 / 100) + 5) * 1
    ///        = (565 / 100 + 5) = 5 + 5 = 10
    ///
    /// Defense = same as Attack (base 49) = 10
    ///
    /// Speed = (((2*65 + 15 + 0) * 5 / 100) + 5) * 10 / 10
    ///       = ((145 * 5 / 100) + 5)
    ///       = (725 / 100 + 5) = 7 + 5 = 12
    ///
    /// SpAttack = same as Speed (base 65) = 12
    ///
    /// SpDefense = same as Attack (base 45):
    ///   (((2*45 + 15 + 0) * 5 / 100) + 5) = ((105 * 5 / 100) + 5) = (525/100 + 5) = 5 + 5 = 10
    ///
    /// Kills: an impl that uses floating-point, rounds instead of truncates,
    /// or has the formula wrong.
    #[test]
    fn derive_stats_known_answer() {
        let stats = derive_stats(
            &base_bulba(),
            &ivs_all_15(),
            &EVs::zero(),
            &neutral(),
            Level::new(5).unwrap(),
        );
        assert_eq!(stats.get(StatKind::Hp), 20, "HP mismatch");
        assert_eq!(stats.get(StatKind::Attack), 10, "Attack mismatch");
        assert_eq!(stats.get(StatKind::Defense), 10, "Defense mismatch");
        assert_eq!(stats.get(StatKind::Speed), 12, "Speed mismatch");
        assert_eq!(stats.get(StatKind::SpAttack), 12, "SpAttack mismatch");
        assert_eq!(stats.get(StatKind::SpDefense), 10, "SpDefense mismatch");
    }

    /// #29: HP ignores nature modifier — a nature that raises Attack should
    /// not change the HP result vs a neutral nature.
    /// Kills: an impl that applies nature modifier to HP.
    #[test]
    fn derive_stats_hp_ignores_nature() {
        let base = base_bulba();
        let ivs = ivs_all_15();
        let evs = EVs::zero();
        let level = Level::new(50).unwrap();

        let neutral_stats = derive_stats(&base, &ivs, &evs, &neutral(), level);
        let adamant_stats =
            derive_stats(&base, &ivs, &evs, &Nature::new(NatureKind::Adamant), level);

        assert_eq!(
            neutral_stats.get(StatKind::Hp),
            adamant_stats.get(StatKind::Hp),
            "HP must be nature-independent"
        );
    }

    /// #30: Nature modifies the correct stats — Adamant (+Atk, -SpAtk).
    /// Kills: an impl that maps nature effects to the wrong stats.
    #[test]
    fn derive_stats_nature_modifies_correct_stat() {
        let base = base_bulba();
        let ivs = ivs_all_15();
        let evs = EVs::zero();
        let level = Level::new(50).unwrap();

        let neutral_stats = derive_stats(&base, &ivs, &evs, &neutral(), level);
        let adamant_stats =
            derive_stats(&base, &ivs, &evs, &Nature::new(NatureKind::Adamant), level);

        assert!(
            adamant_stats.get(StatKind::Attack) > neutral_stats.get(StatKind::Attack),
            "Adamant should raise Attack"
        );
        assert!(
            adamant_stats.get(StatKind::SpAttack) < neutral_stats.get(StatKind::SpAttack),
            "Adamant should lower SpAttack"
        );
        // Unaffected stats remain the same
        assert_eq!(
            neutral_stats.get(StatKind::Defense),
            adamant_stats.get(StatKind::Defense),
            "Defense should be unaffected by Adamant"
        );
        assert_eq!(
            neutral_stats.get(StatKind::Speed),
            adamant_stats.get(StatKind::Speed),
            "Speed should be unaffected by Adamant"
        );
    }

    /// #31: Level 100 max inputs should not overflow and produce reasonable values.
    /// base=255, iv=31, ev=252, level=100.
    ///
    /// HP = ((2*255 + 31 + 252/4) * 100/100) + 100 + 10
    ///    = (2*255 + 31 + 63) + 110
    ///    = (510 + 31 + 63) + 110
    ///    = 604 + 110 = 714
    ///
    /// Other (neutral) = (((2*255 + 31 + 63) * 100/100) + 5) * 10/10
    ///                  = 604 + 5 = 609
    ///
    /// Kills: an impl that overflows u16 or u32 intermediates.
    #[test]
    #[allow(clippy::absurd_extreme_comparisons)]
    fn derive_stats_at_level_100_max_inputs() {
        let base = StatBlock {
            hp: 255,
            attack: 255,
            defense: 255,
            speed: 255,
            sp_attack: 255,
            sp_defense: 255,
        };
        let ivs = IVs::new(31, 31, 31, 31, 31, 31).unwrap();
        let evs = EVs::new(252, 252, 6, 0, 0, 0).unwrap();
        let level = Level::new(100).unwrap();

        let stats = derive_stats(&base, &ivs, &evs, &neutral(), level);

        // HP = ((2*255 + 31 + 252/4) * 100/100) + 100 + 10
        //    = (510 + 31 + 63) * 1 + 110 = 604 + 110 = 714
        assert_eq!(stats.get(StatKind::Hp), 714, "HP at max inputs");

        // Attack = ((2*255 + 31 + 252/4) * 100/100 + 5) * 10/10
        //        = (604 + 5) = 609
        assert_eq!(stats.get(StatKind::Attack), 609, "Attack at max inputs");

        // Defense with ev=6: ((2*255 + 31 + 6/4) * 100/100 + 5) * 10/10
        //  = (510 + 31 + 1) + 5 = 547
        assert_eq!(stats.get(StatKind::Defense), 547, "Defense at max inputs");

        // All values should fit in u16
        for kind in [
            StatKind::Hp,
            StatKind::Attack,
            StatKind::Defense,
            StatKind::Speed,
            StatKind::SpAttack,
            StatKind::SpDefense,
        ] {
            assert!(stats.get(kind) <= u16::MAX, "{kind:?} overflowed");
        }
    }

    /// #32: Level 1 starter stats — the minimum-level case.
    /// HP = ((2*45 + 15 + 0) * 1/100) + 1 + 10 = (105/100) + 11 = 1 + 11 = 12
    /// Attack = ((2*49 + 15) * 1/100 + 5) * 10/10 = (113/100 + 5) = (1+5) = 6
    ///
    /// Kills: an impl with a special-case bug at level 1.
    #[test]
    fn derive_stats_at_level_1() {
        let stats = derive_stats(
            &base_bulba(),
            &ivs_all_15(),
            &EVs::zero(),
            &neutral(),
            Level::new(1).unwrap(),
        );
        assert_eq!(stats.get(StatKind::Hp), 12, "HP at level 1");
        assert_eq!(stats.get(StatKind::Attack), 6, "Attack at level 1");
        assert_eq!(stats.get(StatKind::Defense), 6, "Defense at level 1");
        // Speed: ((2*65+15)*1/100 + 5) = (145/100 + 5) = (1+5) = 6
        assert_eq!(stats.get(StatKind::Speed), 6, "Speed at level 1");
        assert_eq!(stats.get(StatKind::SpAttack), 6, "SpAttack at level 1");
        // SpDefense: ((2*45+15)*1/100 + 5) = (105/100 + 5) = (1+5) = 6
        assert_eq!(stats.get(StatKind::SpDefense), 6, "SpDefense at level 1");
    }

    // =======================================================================
    // M8.5b-C: derive_stats saturation at u16::MAX (not wrap)
    // =======================================================================

    /// Kills: an impl that uses `raw as u16` (wrapping cast) instead of
    /// `u16::try_from(raw).unwrap_or(u16::MAX)` (saturating cast).
    ///
    /// With base stats of 65535 (which u16 allows — StatBlock fields are u16
    /// and there is no validation capping them at 255), at level 100 with
    /// IVs=31 and EVs=0, the HP raw value is:
    ///
    ///   raw = (2*65535 + 31 + 0) * 100 / 100 + 100 + 10
    ///       = (131070 + 31) * 1 + 110
    ///       = 131101 + 110 = 131211
    ///
    /// 131211 > 65535 (u16::MAX) → wraps to 131211 - 65536 = 65675 with `as u16`.
    /// But 65675 > 65535, so it wraps again: 65675 - 65536 = 139. So `as u16` gives 139.
    ///
    /// With saturation: u16::try_from(131211).unwrap_or(u16::MAX) == u16::MAX == 65535.
    ///
    /// For non-HP stats (neutral nature), at level 100 with base=60000, IV=31, EV=0:
    ///   raw_pre_nature = (2*60000 + 31 + 0) * 100 / 100 + 5 = 120031 + 5 = 120036
    ///   raw = 120036 * 10 / 10 = 120036 (neutral)
    ///   120036 > 65535 → wraps to 120036 - 65536 = 54500 with `as u16`.
    ///   With saturation: u16::MAX.
    ///
    /// CRITICAL NON-VACUITY PROOF: 139 != u16::MAX and 54500 != u16::MAX,
    /// so the test cannot pass with the current wrapping `as u16` cast.
    /// The wrapped values are completely different from u16::MAX, so no range
    /// assertion (e.g. >= X) could accidentally pass both the wrapping and saturating
    /// impls — only `== u16::MAX` pins the correct behaviour.
    #[test]
    fn derive_stats_saturates_at_u16_max_not_wrap() {
        // StatBlock fields are u16; 65535 is a legal value (no range validation).
        let base = StatBlock {
            hp: 65535,
            attack: 60000,
            defense: 60000,
            speed: 60000,
            sp_attack: 60000,
            sp_defense: 60000,
        };
        // IVs all 31 (max) — maximises the intermediate value
        let ivs = IVs::new(31, 31, 31, 31, 31, 31).unwrap();
        // EVs all 0 (keep it simple; the overflow is already guaranteed by the base)
        let evs = EVs::zero();
        let level = Level::new(100).unwrap();

        let stats = derive_stats(&base, &ivs, &evs, &neutral(), level);

        // HP raw = (2*65535 + 31 + 0) * 100 / 100 + 100 + 10 = 131211 → overflows u16
        // Saturating: u16::MAX. Wrapping `as u16`: 131211 % 65536 = 139 (≠ u16::MAX).
        assert_eq!(
            stats.get(StatKind::Hp),
            u16::MAX,
            "HP with base=65535 at level 100 must saturate to u16::MAX (65535), \
             not wrap to the truncated value 139 — TEETH: wrapping `as u16` gives 139"
        );

        // Attack raw = (2*60000 + 31 + 0) * 100 / 100 + 5 = 120036 → overflows u16
        // Saturating: u16::MAX. Wrapping `as u16`: 120036 % 65536 = 54500 (≠ u16::MAX).
        assert_eq!(
            stats.get(StatKind::Attack),
            u16::MAX,
            "Attack with base=60000 at level 100 must saturate to u16::MAX (65535), \
             not wrap to 54500 — TEETH: wrapping `as u16` gives 54500"
        );
    }

    // =======================================================================
    // Example-based tests — XP / Level
    // =======================================================================

    /// #33: Known XP values for the level^3 curve.
    /// Kills: an impl that uses the wrong curve formula.
    #[test]
    fn xp_for_level_known_values() {
        assert_eq!(xp_for_level(Level::new(1).unwrap()).value(), 1);
        assert_eq!(xp_for_level(Level::new(10).unwrap()).value(), 1_000);
        assert_eq!(xp_for_level(Level::new(100).unwrap()).value(), 1_000_000);
    }

    /// #34: level_for_xp is the inverse of xp_for_level for exact boundaries.
    /// Kills: an impl with off-by-one in the inverse search.
    #[test]
    fn level_for_xp_inverse() {
        for l in 1u8..=100 {
            let level = Level::new(l).unwrap();
            let xp = xp_for_level(level);
            let recovered = level_for_xp(xp);
            assert_eq!(
                recovered.as_u8(),
                l,
                "level_for_xp(xp_for_level({l})) should be {l}"
            );
        }
    }

    /// #35: XP well above level 100 clamps to level 100.
    /// Kills: an impl that panics or returns > 100.
    #[test]
    fn level_for_xp_clamps_above_max() {
        assert_eq!(level_for_xp(Xp::new(2_000_000)).as_u8(), 100);
    }

    /// #36: XP = 0 returns level 1 (the minimum).
    /// Kills: an impl that panics on zero XP or returns level 0.
    #[test]
    fn level_for_xp_at_zero() {
        assert_eq!(level_for_xp(Xp::new(0)).as_u8(), 1);
    }

    /// #37: XP = 7 is just below level 2 (2^3 = 8), so should return level 1.
    /// Kills: an impl with an off-by-one in the cube root lookup.
    #[test]
    fn level_for_xp_just_below_next() {
        assert_eq!(level_for_xp(Xp::new(7)).as_u8(), 1);
        // Exactly at 8 should be level 2
        assert_eq!(level_for_xp(Xp::new(8)).as_u8(), 2);
    }

    /// #38: Level bounds at 100 — no next level, so both bounds are 1_000_000.
    /// Kills: an impl that tries to compute level 101.
    #[test]
    fn level_bounds_at_100() {
        let (lo, hi) = level_bounds(Level::new(100).unwrap());
        assert_eq!(lo.value(), 1_000_000);
        assert_eq!(hi.value(), 1_000_000);
    }

    /// #39: Level bounds at 1 — (1, 8).
    /// Kills: an impl with wrong boundary calculation.
    #[test]
    fn level_bounds_at_1() {
        let (lo, hi) = level_bounds(Level::new(1).unwrap());
        assert_eq!(lo.value(), 1);
        assert_eq!(hi.value(), 8);
    }

    // =======================================================================
    // Property-based tests
    // =======================================================================

    proptest! {
        /// #40: derive_stats never panics for any valid inputs.
        /// Kills: an impl that overflows or divides by zero.
        #[test]
        fn derive_stats_is_total(
            base in arb_base_stats(),
            ivs in arb_ivs(),
            evs in arb_evs(),
            nature in arb_nature(),
            level in arb_level(),
        ) {
            // Just call it — should not panic
            let _ = derive_stats(&base, &ivs, &evs, &nature, level);
        }

        /// #41: derive_stats is deterministic — same inputs produce same output.
        /// Kills: an impl that uses unseeded randomness or mutable global state.
        #[test]
        fn derive_stats_is_deterministic(
            base in arb_base_stats(),
            ivs in arb_ivs(),
            evs in arb_evs(),
            nature in arb_nature(),
            level in arb_level(),
        ) {
            let a = derive_stats(&base, &ivs, &evs, &nature, level);
            let b = derive_stats(&base, &ivs, &evs, &nature, level);
            prop_assert_eq!(a, b);
        }

        /// #42: HP is always at least level + 10 (the formula's constant terms).
        /// Kills: an impl that forgets the +level+10 in the HP formula.
        #[test]
        fn derive_stats_hp_at_least_level_plus_10(
            base in arb_base_stats(),
            ivs in arb_ivs(),
            evs in arb_evs(),
            nature in arb_nature(),
            level in arb_level(),
        ) {
            let stats = derive_stats(&base, &ivs, &evs, &nature, level);
            let min_hp = u16::from(level.as_u8()) + 10;
            prop_assert!(
                stats.get(StatKind::Hp) >= min_hp,
                "HP {} < level+10 = {}", stats.get(StatKind::Hp), min_hp
            );
        }

        /// #43: XP is strictly monotonically increasing with level.
        /// Kills: an impl where xp_for_level is flat or decreasing.
        #[test]
        fn xp_monotonic(a in 1u8..100, b in 1u8..100) {
            prop_assume!(a != b);
            let la = Level::new(a.min(100)).unwrap();
            let lb = Level::new(b.min(100)).unwrap();
            if a < b {
                prop_assert!(xp_for_level(la).value() < xp_for_level(lb).value());
            } else {
                prop_assert!(xp_for_level(la).value() > xp_for_level(lb).value());
            }
        }

        /// #44: level_for_xp is monotonically non-decreasing.
        /// Kills: an impl where more XP yields a lower level.
        #[test]
        fn level_for_xp_monotonic(xa in any::<u32>(), xb in any::<u32>()) {
            let la = level_for_xp(Xp::new(xa));
            let lb = level_for_xp(Xp::new(xb));
            if xa <= xb {
                prop_assert!(la.as_u8() <= lb.as_u8());
            } else {
                prop_assert!(la.as_u8() >= lb.as_u8());
            }
        }

        /// #45: XP/level round-trip — for all levels 1..=100,
        /// level_for_xp(xp_for_level(l)) == l.
        /// Kills: an impl where the inverse doesn't match the forward function.
        #[test]
        fn xp_level_round_trip(l in 1u8..=100) {
            let level = Level::new(l).unwrap();
            let xp = xp_for_level(level);
            let recovered = level_for_xp(xp);
            prop_assert_eq!(level.as_u8(), recovered.as_u8());
        }
    }

    // -----------------------------------------------------------------------
    // Nightly mutation hardening.
    // -----------------------------------------------------------------------

    /// Kills: every arithmetic/comparison mutant in `level_for_xp`'s bounded
    /// binary search (1 missed + 5 timeout survivors pre-refactor). Exhaustive
    /// over all 100 levels plus both cube boundaries and the u32 cap.
    #[test]
    fn level_for_xp_roundtrips_all_levels_and_boundaries() {
        for l in 1..=100u8 {
            let level = Level::new(l).expect("1..=100 valid");
            let xp = xp_for_level(level);
            assert_eq!(level_for_xp(xp), level, "exact cube for level {l}");
            if l > 1 {
                let below = Xp::new(xp.value() - 1);
                assert_eq!(
                    level_for_xp(below),
                    Level::new(l - 1).expect("valid"),
                    "cube-1 belongs to level {}",
                    l - 1
                );
            }
        }
        assert_eq!(
            level_for_xp(Xp::new(0)),
            Level::new(1).expect("valid"),
            "xp 0 floors to level 1"
        );
        assert_eq!(
            level_for_xp(Xp::new(u32::MAX)),
            Level::new(100).expect("valid"),
            "beyond the cap clamps to 100"
        );
    }
}
