//! Enemy AI skill picker — pure, deterministic, no randomness.
//!
//! The AI evaluates each skill the active monster knows and picks the one that
//! would deal the most damage against the defender. STAB and type-effectiveness
//! are both considered; power is the tiebreaker.
//!
//! If the attacker's `known_skill_ids` is empty or none of its ids resolve to a
//! `SkillDef` in the `skills` slice, the function panics (content integrity).

use crate::content::SkillDef;

use super::type_chart::TypeChart;
use super::types::BattleMonster;

/// Pick the skill id that maximises damage output against `defender`.
///
/// Evaluates each skill in the attacker's `known_skill_ids` that exists in
/// `skills`, then returns the `id` of the skill with the best damage score:
///   score = power * effectiveness * stab_factor
///
/// where:
/// - `stab_factor` is 3/2 if `skill.affinity == attacker.affinity`, else 1
/// - `effectiveness` is the raw value from `TypeChart`
///
/// # Panics
/// Panics if `attacker.known_skill_ids` is empty or none of the ids appear in
/// `skills` — this is a content-integrity failure.
pub fn pick_best_skill(
    attacker: &BattleMonster,
    defender: &BattleMonster,
    skills: &[SkillDef],
    type_chart: &TypeChart,
) -> u32 {
    let mut best_id: Option<u32> = None;
    let mut best_score: u32 = 0;

    for &skill_id in &attacker.known_skill_ids {
        if let Some(skill) = skills.iter().find(|s| s.id == skill_id) {
            let eff = u32::from(type_chart.effectiveness(skill.affinity, defender.affinity));
            let power = u32::from(skill.power);
            // Multiply by 3 for STAB, 2 for non-STAB (avoids fractions)
            let stab = if skill.affinity == attacker.affinity {
                3
            } else {
                2
            };
            let score = power * eff * stab;
            if best_id.is_none() || score > best_score {
                best_score = score;
                best_id = Some(skill_id);
            }
        }
    }

    best_id.expect("attacker must have at least one known skill in the skill registry")
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::combat::type_chart::tests::make_type_chart;
    use crate::combat::types::BattleMonster;
    use crate::content::SkillDef;
    use crate::monster::types::{Affinity, StatBlock};

    // -----------------------------------------------------------------------
    // Fixture builders
    // -----------------------------------------------------------------------

    fn make_monster(affinity: Affinity, known_skill_ids: Vec<u32>) -> BattleMonster {
        BattleMonster {
            species_id: 1,
            affinity,
            level: 5,
            current_hp: 100,
            max_hp: 100,
            stats: StatBlock {
                hp: 100,
                attack: 50,
                defense: 50,
                speed: 50,
                sp_attack: 50,
                sp_defense: 50,
            },
            known_skill_ids,
            status: None,
        }
    }

    fn fire_skill_40() -> SkillDef {
        SkillDef {
            id: 1,
            name: "Ember".to_string(),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 25,
            sets_weather: None,
            applies_status: None,
        }
    }

    fn fire_skill_65() -> SkillDef {
        SkillDef {
            id: 2,
            name: "Fire Fang".to_string(),
            affinity: Affinity::Fire,
            power: 65,
            accuracy: 95,
            pp: 15,
            sets_weather: None,
            applies_status: None,
        }
    }

    fn water_skill_40() -> SkillDef {
        SkillDef {
            id: 3,
            name: "Water Gun".to_string(),
            affinity: Affinity::Water,
            power: 40,
            accuracy: 100,
            pp: 25,
            sets_weather: None,
            applies_status: None,
        }
    }

    // -----------------------------------------------------------------------
    // Picks super-effective skill over neutral when SE deals more
    // -----------------------------------------------------------------------

    /// Kills: an impl that picks by power alone and ignores type-effectiveness.
    ///
    /// Attacker: Fire type, knows both Fire (SE vs Plant) and Water (NVE vs Plant).
    /// The Fire skill has the same power as Water skill, but it's SE vs Plant
    /// while Water is NVE. AI must pick Fire.
    ///
    /// Starts red because `pick_best_skill` is `todo!()`.
    #[test]

    fn picks_super_effective_over_not_very_effective() {
        let chart = make_type_chart();
        // Attacker is Fire, knows Fire skill (id=1, power=40) and Water skill (id=3, power=40)
        let attacker = make_monster(Affinity::Fire, vec![1, 3]);
        // Defender is Plant: Fire SE (20), Water NVE (5)
        let defender = make_monster(Affinity::Plant, vec![]);
        let skills = vec![fire_skill_40(), water_skill_40()];
        let chosen = pick_best_skill(&attacker, &defender, &skills, &chart);
        assert_eq!(
            chosen, 1,
            "must pick Fire skill (SE vs Plant) over Water skill (NVE vs Plant)"
        );
    }

    // -----------------------------------------------------------------------
    // Picks higher-power skill when same affinity (same type effectiveness)
    // -----------------------------------------------------------------------

    /// Kills: an impl that always returns the first skill in the list.
    ///
    /// Attacker: Fire type, knows Fire 40 (id=1) and Fire 65 (id=2).
    /// Against an Electric defender (Fire is neutral to Electric), power decides.
    ///
    /// Starts red because `pick_best_skill` is `todo!()`.
    #[test]

    fn picks_higher_power_skill_when_same_effectiveness() {
        let chart = make_type_chart();
        // Both skills are Fire affinity → same STAB, same type effectiveness vs Electric
        let attacker = make_monster(Affinity::Fire, vec![1, 2]);
        let defender = make_monster(Affinity::Electric, vec![]);
        let skills = vec![fire_skill_40(), fire_skill_65()];
        let chosen = pick_best_skill(&attacker, &defender, &skills, &chart);
        assert_eq!(
            chosen, 2,
            "must pick Fire Fang (power 65) over Ember (power 40) when type is same"
        );
    }

    // -----------------------------------------------------------------------
    // Single skill: returns that skill
    // -----------------------------------------------------------------------

    /// Kills: an impl that panics on a single-skill team, or returns the wrong id.
    ///
    /// Starts red because `pick_best_skill` is `todo!()`.
    #[test]

    fn single_skill_returns_that_skill() {
        let chart = make_type_chart();
        let attacker = make_monster(Affinity::Water, vec![3]);
        let defender = make_monster(Affinity::Fire, vec![]);
        let skills = vec![water_skill_40()];
        let chosen = pick_best_skill(&attacker, &defender, &skills, &chart);
        assert_eq!(
            chosen, 3,
            "with a single skill, must return that skill's id"
        );
    }

    // -----------------------------------------------------------------------
    // Deterministic
    // -----------------------------------------------------------------------

    /// Kills: any non-deterministic impl (e.g. relying on HashMap iteration order).
    ///
    /// Starts red because `pick_best_skill` is `todo!()`.
    #[test]

    fn pick_best_skill_is_deterministic() {
        let chart = make_type_chart();
        let attacker = make_monster(Affinity::Fire, vec![1, 2, 3]);
        let defender = make_monster(Affinity::Plant, vec![]);
        let skills = vec![fire_skill_40(), fire_skill_65(), water_skill_40()];
        let result_a = pick_best_skill(&attacker, &defender, &skills, &chart);
        let result_b = pick_best_skill(&attacker, &defender, &skills, &chart);
        assert_eq!(
            result_a, result_b,
            "pick_best_skill must be deterministic: {result_a} != {result_b}"
        );
    }

    // -----------------------------------------------------------------------
    // Nightly mutation hardening: fixtures + scenarios chosen so each
    // arithmetic/comparison mutant in `pick_best_skill`'s scoring flips a
    // winner (5 survivors: STAB `==`, both `*`s, and the `>` tie rule).
    // Score = power * eff * stab, stab = 3 (STAB) / 2 (non-STAB).
    // -----------------------------------------------------------------------

    /// Twin of `fire_skill_40` under a different id — for exact-tie ordering.
    fn fire_skill_40_twin() -> SkillDef {
        SkillDef {
            id: 9,
            name: "Ember Twin".to_string(),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 25,
            sets_weather: None,
            applies_status: None,
        }
    }

    fn electric_skill_65() -> SkillDef {
        SkillDef {
            id: 4,
            name: "Spark Fang".to_string(),
            affinity: Affinity::Electric,
            power: 65,
            accuracy: 95,
            pp: 15,
            sets_weather: None,
            applies_status: None,
        }
    }

    fn wind_skill_40() -> SkillDef {
        SkillDef {
            id: 5,
            name: "Gust".to_string(),
            affinity: Affinity::Wind,
            power: 40,
            accuracy: 100,
            pp: 25,
            sets_weather: None,
            applies_status: None,
        }
    }

    /// Kills: `score > best_score` -> `>=` (48:43). Exact tie must keep the
    /// FIRST known skill; the mutant keeps the last.
    #[test]
    fn exact_score_tie_keeps_first_known_skill() {
        let attacker = make_monster(Affinity::Fire, vec![1, 9]);
        let defender = make_monster(Affinity::Water, vec![1]);
        let skills = vec![fire_skill_40(), fire_skill_40_twin()];
        // Both: 40 * 5 * 3 = 600.
        assert_eq!(
            pick_best_skill(&attacker, &defender, &skills, &make_type_chart()),
            1
        );
    }

    /// Kills: STAB check `==` -> `!=` (42:42). vs Water both skills are
    /// eff 5; only STAB separates Fire 40*5*3=600 from Water 40*5*2=400.
    /// The mutant inverts STAB and picks the Water skill.
    #[test]
    fn stab_decides_between_equal_effectiveness_skills() {
        let attacker = make_monster(Affinity::Fire, vec![1, 3]);
        let defender = make_monster(Affinity::Water, vec![1]);
        let skills = vec![fire_skill_40(), water_skill_40()];
        assert_eq!(
            pick_best_skill(&attacker, &defender, &skills, &make_type_chart()),
            1
        );
    }

    /// Kills: second `*` -> `/` (47:37). Fire 40*20*3=2400 beats neutral
    /// Electric 65*10*2=1300; under `(power*eff)/stab` 266 < 325 flips it.
    #[test]
    fn stab_multiplies_rather_than_divides() {
        let attacker = make_monster(Affinity::Fire, vec![1, 4]);
        let defender = make_monster(Affinity::Plant, vec![1]);
        let skills = vec![fire_skill_40(), electric_skill_65()];
        assert_eq!(
            pick_best_skill(&attacker, &defender, &skills, &make_type_chart()),
            1
        );
    }

    /// Kills: second `*` -> `+` (47:37). STAB NVE Fire 65*5*3=975 beats
    /// neutral Wind 40*10*2=800; under `(power*eff)+stab` 328 < 402 flips it.
    #[test]
    fn stab_multiplies_rather_than_adds() {
        let attacker = make_monster(Affinity::Fire, vec![2, 5]);
        let defender = make_monster(Affinity::Water, vec![1]);
        let skills = vec![fire_skill_65(), wind_skill_40()];
        assert_eq!(
            pick_best_skill(&attacker, &defender, &skills, &make_type_chart()),
            2
        );
    }

    /// Kills: first `*` -> `+` (47:31). Non-STAB attacker: SE Fire
    /// 40*20*2=1600 beats neutral Electric 65*10*2=1300; under
    /// `(power+eff)*stab` 120 < 150 flips it.
    #[test]
    fn power_multiplies_effectiveness_rather_than_adds() {
        let attacker = make_monster(Affinity::Water, vec![1, 4]);
        let defender = make_monster(Affinity::Plant, vec![1]);
        let skills = vec![fire_skill_40(), electric_skill_65()];
        assert_eq!(
            pick_best_skill(&attacker, &defender, &skills, &make_type_chart()),
            1
        );
    }
}
