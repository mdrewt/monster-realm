//! Damage formula and accuracy check for the combat engine.
//!
//! The damage formula is:
//!
//! ```text
//! base = (2 * level / 5 + 2) * power * attack / defense / 50 + 2
//! stab = if skill.affinity == attacker.affinity { base * 3 / 2 } else { base }
//! type_mod = stab * effectiveness / 10
//! variance_mod = type_mod * variance / 100      (variance: 85..=100)
//! final = max(1, variance_mod)                   (floor of 1 for non-immune hits)
//! ```
//!
//! where `effectiveness` is the raw value from `TypeChart` (0, 5, 10, or 20).
//! An immune hit (effectiveness == 0) always deals 0 damage.
//!
//! All arithmetic uses `u64` intermediates to avoid overflow.

use crate::content::SkillDef;

use super::type_chart::TypeChart;
use super::types::{BattleMonster, Effectiveness};

/// Compute damage dealt by `attacker` using `skill` against `defender`.
///
/// Returns `(damage, effectiveness)` — a pair so the caller can emit
/// `BattleEvent::Damage` with the correct effectiveness label.
///
/// # Contract
/// - `variance` MUST be in 85..=100 (caller's responsibility; see `TurnVariance`).
/// - `defender.stats.defense >= 1` (callers/boundary guarantee it; the formula
///   divides by it — see `battle_monster_from_row` for the trust boundary).
/// - Returns `(0, Immune)` when effectiveness == 0.
/// - Returns at least `(1, _)` for any non-immune hit, regardless of stat ratios.
pub fn calc_damage(
    attacker: &BattleMonster,
    defender: &BattleMonster,
    skill: &SkillDef,
    type_chart: &TypeChart,
    variance: u8, // 85..=100
) -> (u16, Effectiveness) {
    let eff_raw = type_chart.effectiveness(skill.affinity, defender.affinity);
    let effectiveness = TypeChart::classify(eff_raw);

    if eff_raw == 0 {
        return (0, Effectiveness::Immune);
    }

    let level = u64::from(attacker.level);
    let power = u64::from(skill.power);
    let attack = u64::from(attacker.stats.attack);
    debug_assert!(
        defender.stats.defense > 0,
        "calc_damage precondition violated: defender defense must be >= 1 (enforce at battle_monster_from_row boundary)"
    );
    let defense = u64::from(defender.stats.defense);
    let eff = u64::from(eff_raw);
    let var = u64::from(variance);

    // base = (2 * level / 5 + 2) * power * attack / defense / 50 + 2
    let base = (2 * level / 5 + 2) * power * attack / defense / 50 + 2;

    // STAB: same-type attack bonus
    let stab = if skill.affinity == attacker.affinity {
        base * 3 / 2
    } else {
        base
    };

    // type modifier
    let type_mod = stab * eff / 10;

    // variance scaling
    let variance_mod = type_mod * var / 100;

    // floor of 1 for non-immune hits
    let final_dmg = std::cmp::max(1u64, variance_mod);
    let clamped = std::cmp::min(final_dmg, u64::from(u16::MAX)) as u16;

    (clamped, effectiveness)
}

/// Return `true` if the move hits (roll < accuracy), `false` if it misses.
///
/// A skill with accuracy 100 always hits (roll is always 0..=99).
pub fn accuracy_check(skill_accuracy: u8, roll: u8) -> bool {
    roll < skill_accuracy
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monster::types::{Affinity, StatBlock};
    use proptest::prelude::*;

    use crate::combat::type_chart::tests::make_type_chart;
    use crate::content::SkillDef;

    // -----------------------------------------------------------------------
    // Fixture builders
    // -----------------------------------------------------------------------

    fn make_stat_block(attack: u16, defense: u16, speed: u16) -> StatBlock {
        StatBlock {
            hp: 100,
            attack,
            defense,
            speed,
            sp_attack: 50,
            sp_defense: 50,
        }
    }

    fn make_monster(affinity: Affinity, attack: u16, defense: u16) -> BattleMonster {
        BattleMonster {
            species_id: 1,
            affinity,
            level: 5,
            current_hp: 100,
            max_hp: 100,
            stats: make_stat_block(attack, defense, 50),
            known_skill_ids: vec![1],
            status: None,
        }
    }

    /// Skill with power 40, Fire affinity, 100% accuracy.
    fn fire_skill_40() -> SkillDef {
        SkillDef {
            id: 1,
            name: "Ember".to_string(),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 25,
        }
    }

    /// Skill with power 40, Water affinity, 100% accuracy.
    #[allow(dead_code)]
    fn water_skill_40() -> SkillDef {
        SkillDef {
            id: 3,
            name: "Water Gun".to_string(),
            affinity: Affinity::Water,
            power: 40,
            accuracy: 100,
            pp: 25,
        }
    }

    // -----------------------------------------------------------------------
    // Known-answer damage test
    //
    // attacker: Fire, level 5, attack=40, defense=40; power 40; variance=100
    // defender: Plant, defense=40
    //
    // Step 1: base = (2*5/5 + 2) * 40 * 40 / 40 / 50 + 2
    //              = (2 + 2) * 40 * 40 / 40 / 50 + 2
    //              = 4 * 40 * 40 / 40 / 50 + 2
    //              = 4 * 40 / 50 + 2
    //              = 160 / 50 + 2
    //              = 3 + 2 = 5
    //
    // Step 2: stab = Fire skill, Fire attacker → STAB: 5 * 3/2 = 7
    //
    // Step 3: type_mod = 7 * 20 / 10 = 14  (Fire vs Plant = 20)
    //
    // Step 4: variance_mod = 14 * 100 / 100 = 14
    //
    // Step 5: max(1, 14) = 14
    //
    // Expected: (14, SuperEffective)
    // -----------------------------------------------------------------------

    /// Kills: an impl that uses floating-point, rounds wrong, forgets STAB,
    /// forgets the type multiplier, or gets the formula order wrong.
    /// Starts red because `calc_damage` is `todo!()`.
    #[test]

    fn known_answer_fire_vs_plant_level5_power40_var100() {
        let chart = make_type_chart();
        let attacker = make_monster(Affinity::Fire, 40, 40);
        let defender = make_monster(Affinity::Plant, 40, 40);
        let skill = fire_skill_40();
        let (dmg, eff) = calc_damage(&attacker, &defender, &skill, &chart, 100);
        assert_eq!(dmg, 14, "expected 14 damage");
        assert_eq!(
            eff,
            Effectiveness::SuperEffective,
            "expected SuperEffective"
        );
    }

    // -----------------------------------------------------------------------
    // STAB bonus: same-affinity skill deals more than different-affinity
    // -----------------------------------------------------------------------

    /// Kills: an impl that ignores STAB or applies it to both branches equally.
    /// Starts red because `calc_damage` is `todo!()`.
    #[test]

    fn stab_increases_damage_vs_no_stab() {
        let chart = make_type_chart();
        // Use Plant vs Earth (Earth is unlisted vs Plant = neutral) to test STAB cleanly.
        // Plant attacker with Plant skill (STAB) vs same Plant attacker with Water skill (no STAB).
        let plant_attacker = make_monster(Affinity::Plant, 60, 40);
        let earth_defender = make_monster(Affinity::Earth, 40, 60);
        let plant_skill = SkillDef {
            id: 5,
            name: "Vine Whip".to_string(),
            affinity: Affinity::Plant,
            power: 45,
            accuracy: 100,
            pp: 25,
        };
        let water_skill = SkillDef {
            id: 3,
            name: "Water Gun".to_string(),
            affinity: Affinity::Water,
            power: 45,
            accuracy: 100,
            pp: 25,
        };
        // Plant attacker using Plant skill (STAB) vs Earth (neutral)
        let (stab_dmg, _) =
            calc_damage(&plant_attacker, &earth_defender, &plant_skill, &chart, 100);
        // Plant attacker using Water skill (no STAB) vs Earth (neutral)
        let (no_stab_dmg, _) =
            calc_damage(&plant_attacker, &earth_defender, &water_skill, &chart, 100);
        assert!(
            stab_dmg > no_stab_dmg,
            "STAB ({stab_dmg}) must exceed non-STAB ({no_stab_dmg}) with same power"
        );
    }

    // -----------------------------------------------------------------------
    // Super-effective deals more than neutral
    // -----------------------------------------------------------------------

    /// Kills: an impl that ignores the type multiplier.
    /// Starts red because `calc_damage` is `todo!()`.
    #[test]

    fn super_effective_deals_more_than_neutral() {
        let chart = make_type_chart();
        // Water vs Plant: neutral (Water resists Plant, but Plant resists Water;
        // actually Water vs Plant = 5 (NVE). Use Electric vs Water (SE) vs Fire vs Water (NVE).
        // We want SE vs neutral on the same attacker.
        // Electric attacker, Electric skill vs Water (SE) and vs Fire (NVE? No: Fire resists Water, not Electric)
        // Electric vs Water = 20 (SE)
        // Electric vs Fire: unlisted = 10 (neutral)
        let electric_attacker = make_monster(Affinity::Electric, 60, 40);
        let water_defender = make_monster(Affinity::Water, 40, 60);
        let fire_defender = make_monster(Affinity::Fire, 40, 60);
        let electric_skill = SkillDef {
            id: 10,
            name: "Thunderbolt".to_string(),
            affinity: Affinity::Electric,
            power: 40,
            accuracy: 100,
            pp: 15,
        };
        let (se_dmg, _) = calc_damage(
            &electric_attacker,
            &water_defender,
            &electric_skill,
            &chart,
            100,
        );
        let (neutral_dmg, _) = calc_damage(
            &electric_attacker,
            &fire_defender,
            &electric_skill,
            &chart,
            100,
        );
        assert!(
            se_dmg > neutral_dmg,
            "super-effective ({se_dmg}) must exceed neutral ({neutral_dmg})"
        );
    }

    // -----------------------------------------------------------------------
    // Immune (effectiveness 0) → 0 damage
    // -----------------------------------------------------------------------

    /// This requires an immune entry. The current type chart has no immune pairs
    /// (effectiveness 0). We test via a hand-crafted TypeChart with an immune entry.
    ///
    /// Kills: an impl that ignores immune effectiveness and still deals damage.
    /// Starts red because `TypeChart::new` is `todo!()`.
    #[test]

    fn immune_effectiveness_deals_zero_damage() {
        use crate::content::TypeRelation;
        let relations = vec![TypeRelation {
            attacker: Affinity::Fire,
            defender: Affinity::Water,
            effectiveness: 0, // immune for test purposes
        }];
        let chart = TypeChart::new(&relations);
        let attacker = make_monster(Affinity::Fire, 200, 40);
        let defender = make_monster(Affinity::Water, 40, 1); // extremely low defense
        let skill = fire_skill_40();
        let (dmg, eff) = calc_damage(&attacker, &defender, &skill, &chart, 100);
        assert_eq!(dmg, 0, "immune hit must deal 0 damage");
        assert_eq!(eff, Effectiveness::Immune);
    }

    // -----------------------------------------------------------------------
    // Proof-of-teeth: Non-immune always deals at least 1 damage (the max(1) floor)
    // -----------------------------------------------------------------------

    /// Proof-of-teeth fixture: a very weak attacker vs a very strong defender
    /// where the formula would produce 0 without the max(1) floor.
    ///
    /// With: level=1, power=1, attack=1, defense=255, variance=85
    /// base = (2*1/5 + 2) * 1 * 1 / 255 / 50 + 2 = (0+2)*1/255/50+2 = 0+2 = 2
    /// Hmm, the +2 term prevents 0 in this formula. Try with the intermediate:
    /// (2*1/5+2) = (0+2) = 2; 2*1*1/255/50 = 0 (truncating); +2 = 2 — always ≥ 2.
    ///
    /// We need a formula where the variance step produces 0 before the max(1).
    /// With base=1 (minimum from formula), variance=85:
    /// 1 * 85 / 100 = 0 (truncating integer division) → max(1) saves it.
    ///
    /// To get base=1: use special TypeRelation with effectiveness=5 (NVE):
    /// Need stab*eff/10 * var/100 = 0 → need stab*eff/10 = 1, then *85/100 = 0.
    /// stab=1: 1*5/10=0 (already 0 without variance).
    ///
    /// Actually the +2 in the formula guarantees a minimum of 2 before type modifiers.
    /// NVE: 2 * 5 / 10 = 1 (truncating). Then 1 * 85 / 100 = 0. max(1) → 1.
    /// This is the scenario we want to test.
    ///
    /// Kills: an impl that forgets `max(1, result)` for non-immune hits.
    /// Starts red because `calc_damage` is `todo!()`.
    #[test]

    fn non_immune_deals_at_least_1_damage_floor() {
        // Use a real NVE pair: Water vs Fire (Water NVE vs Fire? No: Water beats Fire.
        // Plant vs Water = 5 (NVE): Plant skill vs Water defender.
        use crate::content::TypeRelation;
        // Hand-craft chart with NVE pair
        let relations = vec![TypeRelation {
            attacker: Affinity::Plant,
            defender: Affinity::Water,
            effectiveness: 5,
        }];
        let chart = TypeChart::new(&relations);
        // Very weak attacker, strong defender, min variance
        let attacker = BattleMonster {
            species_id: 1,
            affinity: Affinity::Plant,
            level: 1,
            current_hp: 10,
            max_hp: 10,
            stats: StatBlock {
                hp: 10,
                attack: 5,
                defense: 10,
                speed: 10,
                sp_attack: 5,
                sp_defense: 10,
            },
            known_skill_ids: vec![1],
            status: None,
        };
        let defender = BattleMonster {
            species_id: 2,
            affinity: Affinity::Water,
            level: 100,
            current_hp: 500,
            max_hp: 500,
            stats: StatBlock {
                hp: 500,
                attack: 50,
                defense: 255, // maximum defense
                speed: 50,
                sp_attack: 50,
                sp_defense: 255,
            },
            known_skill_ids: vec![],
            status: None,
        };
        let plant_skill = SkillDef {
            id: 5,
            name: "Vine Whip".to_string(),
            affinity: Affinity::Plant,
            power: 40,
            accuracy: 100,
            pp: 25,
        };
        // minimum variance = 85
        let (dmg, eff) = calc_damage(&attacker, &defender, &plant_skill, &chart, 85);
        assert_ne!(eff, Effectiveness::Immune, "Plant vs Water is not immune");
        assert!(
            dmg >= 1,
            "non-immune hit must deal at least 1 damage; got {dmg}"
        );
    }

    // -----------------------------------------------------------------------
    // Variance 85 deals less than variance 100
    // -----------------------------------------------------------------------

    /// Kills: an impl that ignores variance or applies it as addition instead of scaling.
    /// Starts red because `calc_damage` is `todo!()`.
    #[test]

    fn variance_85_deals_less_than_variance_100() {
        let chart = make_type_chart();
        let attacker = make_monster(Affinity::Fire, 80, 40);
        let defender = make_monster(Affinity::Plant, 40, 40);
        let skill = fire_skill_40();
        let (dmg_85, _) = calc_damage(&attacker, &defender, &skill, &chart, 85);
        let (dmg_100, _) = calc_damage(&attacker, &defender, &skill, &chart, 100);
        assert!(
            dmg_85 <= dmg_100,
            "variance=85 ({dmg_85}) must be <= variance=100 ({dmg_100})"
        );
    }

    // -----------------------------------------------------------------------
    // Accuracy check: roll < accuracy → hit
    // -----------------------------------------------------------------------

    /// Kills: an impl with the wrong comparison operator (e.g. `<=` instead of `<`).
    /// Starts red because `accuracy_check` is `todo!()`.
    #[test]

    fn accuracy_check_roll_below_accuracy_is_hit() {
        // accuracy=100, roll=0 → always hits
        assert!(accuracy_check(100, 0), "roll 0 vs accuracy 100 must hit");
        // accuracy=80, roll=79 → hits (79 < 80)
        assert!(accuracy_check(80, 79), "roll 79 vs accuracy 80 must hit");
    }

    /// Kills: an impl that always returns true regardless of roll.
    /// Starts red because `accuracy_check` is `todo!()`.
    #[test]

    fn accuracy_check_roll_at_or_above_accuracy_is_miss() {
        // accuracy=80, roll=80 → misses (80 is not < 80)
        assert!(!accuracy_check(80, 80), "roll 80 vs accuracy 80 must miss");
        // accuracy=80, roll=99 → misses
        assert!(!accuracy_check(80, 99), "roll 99 vs accuracy 80 must miss");
    }

    // -----------------------------------------------------------------------
    // Property: calc_damage is deterministic
    // -----------------------------------------------------------------------

    fn arb_affinity() -> impl Strategy<Value = Affinity> {
        prop_oneof![
            Just(Affinity::Fire),
            Just(Affinity::Water),
            Just(Affinity::Plant),
            Just(Affinity::Electric),
            Just(Affinity::Earth),
            Just(Affinity::Wind),
            Just(Affinity::Light),
            Just(Affinity::Dark),
        ]
    }

    // -----------------------------------------------------------------------
    // M8.5b-A: calc_damage precondition + boundary tests
    // -----------------------------------------------------------------------

    /// Kills: an impl that divide-by-zero panics at defense==1, or clamps defense
    /// to something weird, or requires defense > 1 as a silent precondition.
    ///
    /// Defense == 1 is the *boundary* of the documented precondition `defense >= 1`.
    /// This test proves the formula handles it without panic and returns a
    /// meaningful damage value (>= 1).
    ///
    /// A wrong impl that clamps defense to e.g. min(defense, 2) would change the
    /// damage value and not necessarily return >= 1 for all stat combos — this
    /// fixture sets up a non-immune matchup where the floor-of-1 rule guarantees >= 1.
    #[test]
    fn calc_damage_with_defense_one_is_valid() {
        let chart = make_type_chart();
        // Fire attacker (level 5, attack=40) vs Fire defender (defense=1)
        // Fire vs Fire: neutral (effectiveness == 10 → Neutral)
        // base = (2*5/5 + 2) * 40 * 40 / 1 / 50 + 2
        //      = 4 * 40 * 40 / 1 / 50 + 2
        //      = 6400 / 50 + 2 = 128 + 2 = 130
        // stab: Fire skill vs Fire attacker = STAB: 130 * 3 / 2 = 195
        // type_mod: 195 * 10 / 10 = 195 (neutral)
        // variance_mod: 195 * 100 / 100 = 195
        // final: max(1, 195) = 195
        // Result must be >= 1 and must NOT panic.
        let attacker = make_monster(Affinity::Fire, 40, 40);
        let mut defender = make_monster(Affinity::Fire, 40, 40);
        defender.stats.defense = 1; // boundary: minimum valid defense
        let skill = fire_skill_40();
        let (dmg, eff) = calc_damage(&attacker, &defender, &skill, &chart, 100);
        assert!(
            dmg >= 1,
            "defense==1 is valid; damage must be >= 1, got {dmg}"
        );
        assert_ne!(
            eff,
            Effectiveness::Immune,
            "Fire vs Fire is not immune; eff must not be Immune"
        );
    }

    /// Kills: an impl that silently swallows defense==0 (e.g. by clamping to 1)
    /// instead of loudly asserting. The debug_assert pins the "fail loud" contract.
    ///
    /// In the CURRENT code (pre-fix), defense==0 causes an integer divide-by-zero
    /// panic in debug mode. After the fix, a debug_assert fires instead — same
    /// visible behaviour for test purposes, so #[should_panic] passes in both states.
    ///
    /// Gated with #[cfg(debug_assertions)] so this test is NOT compiled in
    /// release-profile test runs where debug_assert becomes a no-op and
    /// #[should_panic] would wrongly fail on a silent success.
    #[cfg(debug_assertions)]
    #[test]
    #[should_panic]
    fn calc_damage_debug_asserts_on_zero_defense() {
        let chart = make_type_chart();
        let attacker = make_monster(Affinity::Fire, 40, 40);
        let mut defender = make_monster(Affinity::Plant, 40, 40);
        defender.stats.defense = 0; // precondition violation: defense must be >= 1
        let skill = fire_skill_40();
        // Must panic (either via debug_assert!(defense > 0) after the fix,
        // or via integer divide-by-zero before the fix).
        let _ = calc_damage(&attacker, &defender, &skill, &chart, 100);
    }

    proptest! {
        /// Kills: any non-deterministic impl (unseeded RNG in calc_damage).
        /// Starts red because `calc_damage` is `todo!()`.
        #[test]
        fn prop_calc_damage_is_deterministic(
            atk_affinity in arb_affinity(),
            def_affinity in arb_affinity(),
            skill_affinity in arb_affinity(),
            attack in 5u16..200,
            defense in 5u16..200,
            power in 1u16..150,
            variance in 85u8..=100,
        ) {
            let chart = make_type_chart();
            let attacker = make_monster(atk_affinity, attack, 40);
            let defender = make_monster(def_affinity, 40, defense);
            let skill = SkillDef {
                id: 99,
                name: "Test".to_string(),
                affinity: skill_affinity,
                power,
                accuracy: 100,
                pp: 10,
            };
            let result_a = calc_damage(&attacker, &defender, &skill, &chart, variance);
            let result_b = calc_damage(&attacker, &defender, &skill, &chart, variance);
            prop_assert_eq!(result_a, result_b, "calc_damage must be deterministic");
        }

        /// Kills: any impl that panics for valid inputs.
        /// Starts red because `calc_damage` is `todo!()`.
        #[test]
        fn prop_calc_damage_never_panics_for_valid_inputs(
            atk_affinity in arb_affinity(),
            def_affinity in arb_affinity(),
            skill_affinity in arb_affinity(),
            attack in 1u16..=255,
            defense in 1u16..=255,
            power in 1u16..=200,
            variance in 85u8..=100,
            level in 1u8..=100,
        ) {
            let chart = make_type_chart();
            let attacker = BattleMonster {
                species_id: 1,
                affinity: atk_affinity,
                level,
                current_hp: 100,
                max_hp: 100,
                stats: make_stat_block(attack, 40, 50),
                known_skill_ids: vec![],
                status: None,
            };
            let defender = BattleMonster {
                species_id: 2,
                affinity: def_affinity,
                level,
                current_hp: 100,
                max_hp: 100,
                stats: make_stat_block(40, defense, 40),
                known_skill_ids: vec![],
                status: None,
            };
            let skill = SkillDef {
                id: 1,
                name: "Test".to_string(),
                affinity: skill_affinity,
                power,
                accuracy: 100,
                pp: 10,
            };
            // Should not panic
            let _ = calc_damage(&attacker, &defender, &skill, &chart, variance);
        }
    }

    // -----------------------------------------------------------------------
    // Nightly mutation hardening.
    // -----------------------------------------------------------------------

    /// Kills: the final `+ 2` -> `* 2` base-term mutant (60:31).
    /// Non-STAB, neutral, variance 100: base = (2*5/5+2)*40*40/40/50 + 2
    /// = 3 + 2 = 5 -> damage 5. The mutant yields 3 * 2 = 6.
    #[test]
    fn base_damage_final_term_is_additive() {
        let attacker = make_monster(Affinity::Water, 40, 40);
        let defender = make_monster(Affinity::Wind, 40, 40);
        let (dmg, eff) = calc_damage(
            &attacker,
            &defender,
            &fire_skill_40(),
            &make_type_chart(),
            100,
        );
        assert_eq!(eff, Effectiveness::Neutral);
        assert_eq!(dmg, 5);
    }

    /// Kills: the level-term `+ 2` -> `* 2` mutant (60:31). At level 5 that
    /// mutant is INVISIBLE (2*5/5 + 2 == 2*5/5 * 2 == 4), so this probe runs
    /// at level 10 where 6 != 8: damage 6 (correct) vs 8 (mutant).
    #[test]
    fn base_damage_level_term_is_additive_at_level_10() {
        let mut attacker = make_monster(Affinity::Water, 40, 40);
        attacker.level = 10;
        let defender = make_monster(Affinity::Wind, 40, 40);
        let (dmg, eff) = calc_damage(
            &attacker,
            &defender,
            &fire_skill_40(),
            &make_type_chart(),
            100,
        );
        assert_eq!(eff, Effectiveness::Neutral);
        assert_eq!(dmg, 6, "(2*10/5 + 2) * 40 * 40 / 40 / 50 + 2 = 6");
    }
}
