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
    todo!()
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
    #[should_panic]
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
    #[should_panic]
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
    #[should_panic]
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
    #[should_panic]
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
}
