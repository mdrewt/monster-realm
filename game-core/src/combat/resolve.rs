//! Turn resolution — converts (BattleState, choices, skills, variance) into
//! a list of `BattleEvent`s and mutates the state in place.
//!
//! Resolution rules (in order):
//! 1. If both sides chose `TurnChoice::Attack`, resolve attacks by speed order.
//!    - Faster side attacks first.
//!    - On a speed tie, `variance.speed_tie_breaker` determines who goes first.
//! 2. If the faster side's attack KOs the defender, the slower side does not act.
//! 3. After each faint, the fainted side auto-switches to its `next_conscious_index`.
//!    If no conscious members remain, the battle ends.
//! 4. A `TurnChoice::Swap` happens before the enemy's attack on that turn.
//! 5. `turn_number` increments by 1 each call to `resolve_turn`.

use crate::content::SkillDef;

use super::type_chart::TypeChart;
use super::types::{BattleEvent, BattleState, SideId, TurnChoice, TurnVariance};

/// Resolve a full turn: both sides act according to their choices.
///
/// Mutates `state` in place. Returns the ordered list of events that occurred.
///
/// # Panics
/// Panics if a skill id referenced by `TurnChoice::Attack` is not found in
/// `skills` — this is a content-integrity failure, not a player error.
pub fn resolve_turn(
    state: &mut BattleState,
    choice_a: TurnChoice,
    choice_b: TurnChoice,
    skills: &[SkillDef],
    type_chart: &TypeChart,
    variance: &TurnVariance,
) -> Vec<BattleEvent> {
    todo!()
}

/// Resolve a turn where only the enemy side acts (e.g. the player chose to Swap).
///
/// The enemy uses its best skill (via `pick_best_skill`) against the active
/// player monster.
pub fn resolve_enemy_turn(
    state: &mut BattleState,
    enemy_side: SideId,
    skills: &[SkillDef],
    type_chart: &TypeChart,
    variance: &TurnVariance,
) -> Vec<BattleEvent> {
    todo!()
}

/// Resolve a player swap: swap first, then the enemy side attacks the new active.
///
/// Emits a `Switch` event for the player side, followed by whatever the enemy
/// turn produces.
pub fn resolve_player_swap(
    state: &mut BattleState,
    swap_side: SideId,
    new_active: usize,
    skills: &[SkillDef],
    type_chart: &TypeChart,
    variance: &TurnVariance,
) -> Vec<BattleEvent> {
    todo!()
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::combat::type_chart::tests::make_type_chart;
    use crate::combat::types::{
        BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, TurnChoice,
        TurnVariance,
    };
    use crate::content::SkillDef;
    use crate::monster::types::{Affinity, StatBlock};
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Fixture builders
    // -----------------------------------------------------------------------

    fn make_stat_block_with_speed(attack: u16, defense: u16, speed: u16) -> StatBlock {
        StatBlock {
            hp: 100,
            attack,
            defense,
            speed,
            sp_attack: 50,
            sp_defense: 50,
        }
    }

    fn make_monster(affinity: Affinity, hp: u16, speed: u16) -> BattleMonster {
        BattleMonster {
            species_id: 1,
            affinity,
            level: 5,
            current_hp: hp,
            max_hp: hp,
            stats: make_stat_block_with_speed(40, 40, speed),
            known_skill_ids: vec![1],
        }
    }

    fn make_battle_state(monster_a: BattleMonster, monster_b: BattleMonster) -> BattleState {
        BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![monster_a],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![monster_b],
            },
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
        }
    }

    fn fire_skill() -> SkillDef {
        SkillDef {
            id: 1,
            name: "Ember".to_string(),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 25,
        }
    }

    fn always_hit_variance(a_faster: bool) -> TurnVariance {
        TurnVariance {
            damage_roll_a: 100,
            damage_roll_b: 100,
            accuracy_roll_a: 0, // always hits (0 < 100)
            accuracy_roll_b: 0,
            speed_tie_breaker: a_faster,
        }
    }

    fn skills_vec() -> Vec<SkillDef> {
        vec![fire_skill()]
    }

    // -----------------------------------------------------------------------
    // Speed ordering: faster monster attacks first
    // -----------------------------------------------------------------------

    /// Kills: an impl that resolves in fixed order (A always first) or reverses speed.
    ///
    /// We use a side A monster with LOW speed and side B with HIGH speed, then
    /// verify that the first Damage event targets Side A (B struck first).
    /// Starts red because `resolve_turn` is `todo!()`.
    #[test]
    #[should_panic]
    fn faster_side_attacks_first() {
        let chart = make_type_chart();
        // Side A: slow; Side B: fast
        let monster_a = make_monster(Affinity::Fire, 200, 10); // speed 10
        let monster_b = make_monster(Affinity::Water, 200, 80); // speed 80
        let mut state = make_battle_state(monster_a, monster_b);
        let variance = always_hit_variance(true);
        let events = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
        );
        // First Damage event must target SideA (B attacked first because B is faster)
        let first_damage = events
            .iter()
            .find(|e| matches!(e, BattleEvent::Damage { .. }));
        match first_damage {
            Some(BattleEvent::Damage { side, .. }) => {
                assert_eq!(
                    *side,
                    SideId::SideA,
                    "faster side B must attack first, damaging SideA"
                );
            }
            _ => panic!("expected a Damage event, got none"),
        }
    }

    // -----------------------------------------------------------------------
    // Speed tie: tie_breaker determines order
    // -----------------------------------------------------------------------

    /// Kills: an impl that ignores the tie_breaker on equal speed.
    /// Starts red because `resolve_turn` is `todo!()`.
    #[test]
    #[should_panic]
    fn speed_tie_uses_tie_breaker() {
        let chart = make_type_chart();
        // Both monsters have the same speed
        let monster_a = make_monster(Affinity::Fire, 200, 50);
        let monster_b = make_monster(Affinity::Water, 200, 50);
        let mut state = make_battle_state(monster_a, monster_b);

        // tie_breaker = false means B goes first
        let variance_b_first = TurnVariance {
            damage_roll_a: 100,
            damage_roll_b: 100,
            accuracy_roll_a: 0,
            accuracy_roll_b: 0,
            speed_tie_breaker: false, // false = B first
        };
        let events = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance_b_first,
        );
        let first_damage = events
            .iter()
            .find(|e| matches!(e, BattleEvent::Damage { .. }));
        match first_damage {
            Some(BattleEvent::Damage { side, .. }) => {
                // With speed_tie_breaker=false, B goes first → damages SideA
                assert_eq!(*side, SideId::SideA, "tie_breaker=false means B goes first");
            }
            _ => panic!("expected Damage event"),
        }
    }

    // -----------------------------------------------------------------------
    // Proof-of-teeth (ADR-0010): KO by faster side prevents slower side acting
    //
    // This is the critical "incorrect speed ordering would change the battle
    // outcome" fixture. If the resolver incorrectly lets the SLOWER side act
    // even after being KO'd, the outcome differs.
    // -----------------------------------------------------------------------

    /// Proof-of-teeth: a fast side one-shots the slow side, which must NOT act.
    ///
    /// Setup:
    /// - Side A: very fast (speed=100), very strong (attack=200), vs
    /// - Side B: very slow (speed=1), 1 HP (will be KO'd by A's first hit)
    ///
    /// If the resolver lets B act after being KO'd (wrong order), B would
    /// emit a Damage event. If the resolver is correct, B emits no Damage
    /// because B acts after A and A KO'd B first.
    ///
    /// Kills: an impl that resolves both attacks regardless of KO, or that
    /// has incorrect speed ordering (B acting before A when A is faster).
    /// Starts red because `resolve_turn` is `todo!()`.
    #[test]
    #[should_panic]
    fn ko_by_faster_side_prevents_slower_side_from_acting() {
        let chart = make_type_chart();
        // Side A: much faster (100) and very high attack
        let mut monster_a = make_monster(Affinity::Fire, 500, 100);
        monster_a.stats.attack = 255; // max attack for guaranteed KO

        // Side B: very slow, 1 HP (guaranteed to be KO'd)
        let monster_b = BattleMonster {
            species_id: 2,
            affinity: Affinity::Plant, // Fire is SE vs Plant
            level: 1,
            current_hp: 1, // only 1 HP
            max_hp: 1,
            stats: StatBlock {
                hp: 1,
                attack: 200, // even if B acts, this would be damaging
                defense: 1,  // lowest defense so A's hit definitely KOs
                speed: 1,    // very slow
                sp_attack: 50,
                sp_defense: 1,
            },
            known_skill_ids: vec![1],
        };
        let mut state = make_battle_state(monster_a, monster_b);
        let variance = always_hit_variance(true);
        let events = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
        );

        // A (faster) should KO B. After that, B must not emit a Damage event.
        // We look for a Faint event for SideB, then verify no Damage targeting SideA
        // occurs after that Faint.
        let faint_pos = events
            .iter()
            .position(|e| matches!(e, BattleEvent::Faint { side } if *side == SideId::SideB));
        assert!(faint_pos.is_some(), "SideB must faint from A's first hit");
        let faint_idx = faint_pos.unwrap();

        // After the faint, no Damage targeting SideA should appear
        let damage_after_faint = events[faint_idx..]
            .iter()
            .any(|e| matches!(e, BattleEvent::Damage { side, .. } if *side == SideId::SideA));
        assert!(
            !damage_after_faint,
            "TEETH: slower side B must not deal damage after being KO'd; \
             a wrong impl would still resolve B's attack"
        );
    }

    // -----------------------------------------------------------------------
    // Auto-switch on faint
    // -----------------------------------------------------------------------

    /// Kills: an impl that does not auto-switch when the active monster faints.
    /// Starts red because `resolve_turn` is `todo!()`.
    #[test]
    #[should_panic]
    fn auto_switch_on_faint_when_backup_exists() {
        let chart = make_type_chart();
        // Side A: one strong monster
        let monster_a = make_monster(Affinity::Fire, 500, 100);
        // Side B: one weak active (1 HP) + one backup
        let weak_active = BattleMonster {
            species_id: 2,
            affinity: Affinity::Plant,
            level: 1,
            current_hp: 1,
            max_hp: 10,
            stats: StatBlock {
                hp: 1,
                attack: 10,
                defense: 1,
                speed: 1,
                sp_attack: 10,
                sp_defense: 1,
            },
            known_skill_ids: vec![1],
        };
        let backup = BattleMonster {
            species_id: 3,
            affinity: Affinity::Water,
            level: 5,
            current_hp: 100,
            max_hp: 100,
            stats: StatBlock {
                hp: 100,
                attack: 30,
                defense: 30,
                speed: 30,
                sp_attack: 30,
                sp_defense: 30,
            },
            known_skill_ids: vec![1],
        };
        let mut state = BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![monster_a],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![weak_active, backup],
            },
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
        };
        let variance = always_hit_variance(true);
        let events = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
        );

        // Must see a Faint for SideB then a Switch for SideB
        let faint = events
            .iter()
            .any(|e| matches!(e, BattleEvent::Faint { side } if *side == SideId::SideB));
        assert!(faint, "SideB's active must faint");
        let switch = events
            .iter()
            .any(|e| matches!(e, BattleEvent::Switch { side, .. } if *side == SideId::SideB));
        assert!(switch, "SideB must auto-switch to its backup");
        assert_eq!(
            state.side_b.active, 1,
            "SideB's active slot must be 1 (the backup) after auto-switch"
        );
    }

    // -----------------------------------------------------------------------
    // Battle end when all team members fainted
    // -----------------------------------------------------------------------

    /// Kills: an impl that doesn't emit BattleEnd or set the outcome.
    /// Starts red because `resolve_turn` is `todo!()`.
    #[test]
    #[should_panic]
    fn battle_ends_when_all_members_fainted() {
        let chart = make_type_chart();
        // Side A: strong
        let monster_a = make_monster(Affinity::Fire, 500, 100);
        // Side B: single weak monster (will be KO'd, no backup)
        let monster_b = BattleMonster {
            species_id: 2,
            affinity: Affinity::Plant,
            level: 1,
            current_hp: 1,
            max_hp: 1,
            stats: StatBlock {
                hp: 1,
                attack: 10,
                defense: 1,
                speed: 1,
                sp_attack: 10,
                sp_defense: 1,
            },
            known_skill_ids: vec![1],
        };
        let mut state = make_battle_state(monster_a, monster_b);
        let variance = always_hit_variance(true);
        let events = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
        );
        let battle_end = events
            .iter()
            .any(|e| matches!(e, BattleEvent::BattleEnd { .. }));
        assert!(
            battle_end,
            "BattleEnd must be emitted when all team members faint"
        );
        assert_ne!(
            state.outcome,
            BattleOutcome::Ongoing,
            "outcome must not remain Ongoing after battle ends"
        );
        assert_eq!(
            state.outcome,
            BattleOutcome::SideAWins,
            "SideA must win when SideB's entire team faints"
        );
    }

    // -----------------------------------------------------------------------
    // resolve_player_swap: swap happens, then enemy attacks the swapped-in monster
    // -----------------------------------------------------------------------

    /// Kills: an impl where the enemy attacks the OLD active instead of the new one.
    /// Starts red because `resolve_player_swap` is `todo!()`.
    #[test]
    #[should_panic]
    fn player_swap_then_enemy_attacks_new_active() {
        let chart = make_type_chart();
        let player_m0 = make_monster(Affinity::Fire, 100, 50);
        let player_m1 = make_monster(Affinity::Water, 100, 50);
        let enemy = make_monster(Affinity::Fire, 100, 30);
        let mut state = BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![player_m0, player_m1],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![enemy],
            },
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
        };
        let variance = always_hit_variance(true);
        let events = resolve_player_swap(
            &mut state,
            SideId::SideA,
            1, // swap to index 1
            &skills_vec(),
            &chart,
            &variance,
        );
        // Switch event must appear first
        let first_event = events.first().expect("events must not be empty");
        assert!(
            matches!(
                first_event,
                BattleEvent::Switch {
                    side: SideId::SideA,
                    new_active: 1
                }
            ),
            "first event must be Switch for SideA to slot 1"
        );
        // State must reflect the swap
        assert_eq!(state.side_a.active, 1, "swap must change active slot to 1");
        // Enemy must have attacked after the swap
        let damage_to_a = events.iter().any(|e| {
            matches!(
                e,
                BattleEvent::Damage {
                    side: SideId::SideA,
                    ..
                }
            )
        });
        assert!(damage_to_a, "enemy must attack SideA after the swap");
    }

    // -----------------------------------------------------------------------
    // resolve_enemy_turn: only the enemy side acts
    // -----------------------------------------------------------------------

    /// Kills: an impl where both sides act during resolve_enemy_turn.
    /// Starts red because `resolve_enemy_turn` is `todo!()`.
    #[test]
    #[should_panic]
    fn resolve_enemy_turn_only_enemy_acts() {
        let chart = make_type_chart();
        let player = make_monster(Affinity::Fire, 200, 50);
        let enemy = make_monster(Affinity::Water, 200, 30);
        let mut state = make_battle_state(player, enemy);
        let variance = always_hit_variance(true);
        let events = resolve_enemy_turn(
            &mut state,
            SideId::SideB, // enemy is side B
            &skills_vec(),
            &chart,
            &variance,
        );
        // There must be at most one Damage event — the enemy attacking the player
        let damage_events: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, BattleEvent::Damage { .. }))
            .collect();
        // All damage events must target SideA (the player)
        for ev in &damage_events {
            if let BattleEvent::Damage { side, .. } = ev {
                assert_eq!(
                    *side,
                    SideId::SideA,
                    "resolve_enemy_turn must only damage the player's side"
                );
            }
        }
        // There must be no damage event targeting the enemy (SideA never attacks)
        let player_attacked_enemy = events.iter().any(|e| {
            matches!(
                e,
                BattleEvent::Damage {
                    side: SideId::SideB,
                    ..
                }
            )
        });
        assert!(
            !player_attacked_enemy,
            "player must not act during resolve_enemy_turn"
        );
    }

    // -----------------------------------------------------------------------
    // Turn number increments by 1
    // -----------------------------------------------------------------------

    /// Kills: an impl that doesn't increment turn_number or increments by != 1.
    /// Starts red because `resolve_turn` is `todo!()`.
    #[test]
    #[should_panic]
    fn turn_number_increments_by_one() {
        let chart = make_type_chart();
        let monster_a = make_monster(Affinity::Fire, 200, 50);
        let monster_b = make_monster(Affinity::Water, 200, 40);
        let mut state = make_battle_state(monster_a, monster_b);
        assert_eq!(state.turn_number, 0);
        let variance = always_hit_variance(true);
        let _ = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
        );
        assert_eq!(
            state.turn_number, 1,
            "turn_number must increment by exactly 1"
        );
    }

    // -----------------------------------------------------------------------
    // Property: determinism — same (state, choices, variance) produces same events
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

    proptest! {
        /// Kills: any non-deterministic impl (e.g. using thread_rng inside resolve_turn).
        /// Starts red because `resolve_turn` is `todo!()`.
        #[test]
        fn prop_resolve_turn_is_deterministic(
            aff_a in arb_affinity(),
            aff_b in arb_affinity(),
            spd_a in 1u16..100,
            spd_b in 1u16..100,
            damage_roll_a in 85u8..=100,
            damage_roll_b in 85u8..=100,
            accuracy_roll_a in 0u8..100,
            accuracy_roll_b in 0u8..100,
            tie_breaker in any::<bool>(),
        ) {
            let chart = make_type_chart();
            let monster_a = make_monster(aff_a, 200, spd_a);
            let monster_b = make_monster(aff_b, 200, spd_b);

            let make_state = || make_battle_state(monster_a.clone(), monster_b.clone());
            let variance = TurnVariance {
                damage_roll_a,
                damage_roll_b,
                accuracy_roll_a,
                accuracy_roll_b,
                speed_tie_breaker: tie_breaker,
            };
            let mut state_1 = make_state();
            let mut state_2 = make_state();
            let events_1 = resolve_turn(
                &mut state_1,
                TurnChoice::Attack { skill_id: 1 },
                TurnChoice::Attack { skill_id: 1 },
                &skills_vec(),
                &chart,
                &variance,
            );
            let events_2 = resolve_turn(
                &mut state_2,
                TurnChoice::Attack { skill_id: 1 },
                TurnChoice::Attack { skill_id: 1 },
                &skills_vec(),
                &chart,
                &variance,
            );
            prop_assert_eq!(events_1, events_2, "resolve_turn must be deterministic");
            prop_assert_eq!(state_1, state_2, "resulting state must also be identical");
        }
    }

    // -----------------------------------------------------------------------
    // Unknown skill id: documented panic behavior (content integrity)
    // -----------------------------------------------------------------------

    /// Documents that referencing an unknown skill_id panics (content integrity).
    /// Kills: an impl that silently ignores or returns an empty event list instead.
    /// Starts red because `resolve_turn` is `todo!()` (any panic satisfies should_panic).
    #[test]
    #[should_panic]
    fn unknown_skill_id_panics() {
        let chart = make_type_chart();
        let monster_a = make_monster(Affinity::Fire, 200, 50);
        let monster_b = make_monster(Affinity::Water, 200, 40);
        let mut state = make_battle_state(monster_a, monster_b);
        let variance = always_hit_variance(true);
        // skill_id 9999 does not exist in skills_vec() — must panic
        let _ = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 9999 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
        );
        // If we reach here without panic, the test fails because the impl
        // silently swallowed a content-integrity error.
        panic!("should have panicked on unknown skill_id 9999");
    }
}
