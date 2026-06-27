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
use super::types::{
    BattleEvent, BattleOutcome, BattleState, Effectiveness, SideId, TurnChoice, TurnVariance,
};

fn opposite(side: SideId) -> SideId {
    match side {
        SideId::SideA => SideId::SideB,
        SideId::SideB => SideId::SideA,
    }
}

/// Resolve a single attack by `acting_side`, applying damage and faint/switch logic.
fn resolve_one_attack(
    state: &mut BattleState,
    acting_side: SideId,
    skill_id: u32,
    skills: &[SkillDef],
    type_chart: &TypeChart,
    variance: &TurnVariance,
    events: &mut Vec<BattleEvent>,
) {
    // Panic on a missing skill id is a deliberate content-integrity invariant
    // (ADR-0049): `validate_content` (game-core/src/content.rs) cross-checks at
    // content-load that every species.learnable_skill_ids resolves, and both
    // battler constructors (server `battle_monster_from_row` and `wild_battle_monster`)
    // populate known_skill_ids only from that validated set — so in steady state
    // this panic is unreachable. (Residual: a sync_content that removes a skill
    // mid-battle is not repaired retroactively; see ADR-0049.)
    let skill = skills
        .iter()
        .find(|s| s.id == skill_id)
        .unwrap_or_else(|| panic!("skill id {skill_id} not found in skills registry"));

    let (damage_roll, accuracy_roll) = match acting_side {
        SideId::SideA => (variance.damage_roll_a, variance.accuracy_roll_a),
        SideId::SideB => (variance.damage_roll_b, variance.accuracy_roll_b),
    };

    if !super::damage::accuracy_check(skill.accuracy, accuracy_roll) {
        events.push(BattleEvent::Miss { side: acting_side });
        return;
    }

    let defender_side = opposite(acting_side);

    let (attacker, defender) = match acting_side {
        SideId::SideA => (
            state.side_a.active_monster().clone(),
            state.side_b.active_monster().clone(),
        ),
        SideId::SideB => (
            state.side_b.active_monster().clone(),
            state.side_a.active_monster().clone(),
        ),
    };

    let (dmg, eff) =
        super::damage::calc_damage(&attacker, &defender, skill, type_chart, damage_roll);

    // Apply damage
    let target = match defender_side {
        SideId::SideA => state.side_a.active_monster_mut(),
        SideId::SideB => state.side_b.active_monster_mut(),
    };
    target.current_hp = target.current_hp.saturating_sub(dmg);

    events.push(BattleEvent::Damage {
        side: defender_side,
        amount: dmg,
        effectiveness: eff,
    });

    // Immune hits (0 damage) never faint
    if eff == Effectiveness::Immune {
        return;
    }

    let fainted = match defender_side {
        SideId::SideA => state.side_a.active_monster().is_fainted(),
        SideId::SideB => state.side_b.active_monster().is_fainted(),
    };

    if fainted {
        events.push(BattleEvent::Faint {
            side: defender_side,
        });

        let next = match defender_side {
            SideId::SideA => state.side_a.next_conscious_index(),
            SideId::SideB => state.side_b.next_conscious_index(),
        };

        if let Some(idx) = next {
            let set = match defender_side {
                SideId::SideA => state.side_a.set_active(idx),
                SideId::SideB => state.side_b.set_active(idx),
            };
            // idx from next_conscious_index() is always in-bounds, conscious, and != active → infallible.
            debug_assert!(
                set.is_ok(),
                "auto-switch index from next_conscious_index must be settable: {set:?}"
            );
            let _ = set; // consumed in release (debug_assert! strips), keeps clippy -D warnings clean
            events.push(BattleEvent::Switch {
                side: defender_side,
                new_active: idx,
            });
        } else {
            let winner = acting_side;
            state.outcome = match winner {
                SideId::SideA => BattleOutcome::SideAWins,
                SideId::SideB => BattleOutcome::SideBWins,
            };
            events.push(BattleEvent::BattleEnd { winner });
        }
    }
}

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
    let mut events = Vec::new();

    // Guard: reject calls on a terminal battle (server reducer should also
    // check, but defence-in-depth prevents silent corruption).
    if state.outcome != BattleOutcome::Ongoing {
        return events;
    }

    // Turn-limit terminal (ADR-0049): a u16 turn counter can never reach this in
    // valid play, but advancing past u16::MAX would panic(debug)/wrap(release).
    // Terminate at a defined no-winner terminal (reuse Fled: no XP, no win credit)
    // BEFORE the increment and any swap/attack resolution, so no partial turn is
    // applied (setting `outcome` here is the only mutation; the team state is
    // untouched). NOTE: this guards `resolve_turn` only; the `attempt_recruit`
    // reducer advances `turn_number` out-of-band (see ADR-0049 residual).
    if state.turn_number == u16::MAX {
        state.outcome = BattleOutcome::Fled;
        return events;
    }

    state.turn_number += 1;

    // Swaps always happen before attacks. An illegal swap (OOB/fainted) is a
    // no-op: no `active` mutation, no Switch event; the rest of the turn proceeds.
    if let TurnChoice::Swap { team_index } = &choice_a {
        if state.side_a.set_active(*team_index).is_ok() {
            events.push(BattleEvent::Switch {
                side: SideId::SideA,
                new_active: *team_index,
            });
        }
    }
    if let TurnChoice::Swap { team_index } = &choice_b {
        if state.side_b.set_active(*team_index).is_ok() {
            events.push(BattleEvent::Switch {
                side: SideId::SideB,
                new_active: *team_index,
            });
        }
    }

    let a_attacks = matches!(choice_a, TurnChoice::Attack { .. });
    let b_attacks = matches!(choice_b, TurnChoice::Attack { .. });

    if a_attacks && b_attacks {
        let speed_a = state.side_a.active_monster().stats.speed;
        let speed_b = state.side_b.active_monster().stats.speed;

        let a_goes_first = if speed_a > speed_b {
            true
        } else if speed_b > speed_a {
            false
        } else {
            variance.speed_tie_breaker
        };

        let (first, second) = if a_goes_first {
            (SideId::SideA, SideId::SideB)
        } else {
            (SideId::SideB, SideId::SideA)
        };
        let (first_skill, second_skill) = if a_goes_first {
            (skill_id_from(&choice_a), skill_id_from(&choice_b))
        } else {
            (skill_id_from(&choice_b), skill_id_from(&choice_a))
        };

        resolve_one_attack(
            state,
            first,
            first_skill,
            skills,
            type_chart,
            variance,
            &mut events,
        );

        if state.outcome != BattleOutcome::Ongoing {
            return events;
        }

        // KO by the faster side prevents the slower side from acting
        let second_had_faint = events
            .iter()
            .any(|e| matches!(e, BattleEvent::Faint { side } if *side == second));
        if !second_had_faint {
            resolve_one_attack(
                state,
                second,
                second_skill,
                skills,
                type_chart,
                variance,
                &mut events,
            );
        }
    } else if a_attacks {
        resolve_one_attack(
            state,
            SideId::SideA,
            skill_id_from(&choice_a),
            skills,
            type_chart,
            variance,
            &mut events,
        );
    } else if b_attacks {
        resolve_one_attack(
            state,
            SideId::SideB,
            skill_id_from(&choice_b),
            skills,
            type_chart,
            variance,
            &mut events,
        );
    }

    events
}

fn skill_id_from(choice: &TurnChoice) -> u32 {
    match choice {
        TurnChoice::Attack { skill_id } => *skill_id,
        TurnChoice::Swap { .. } => unreachable!("expected Attack, got Swap"),
    }
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
    let mut events = Vec::new();

    let (attacker, defender) = match enemy_side {
        SideId::SideA => (
            state.side_a.active_monster().clone(),
            state.side_b.active_monster().clone(),
        ),
        SideId::SideB => (
            state.side_b.active_monster().clone(),
            state.side_a.active_monster().clone(),
        ),
    };

    let skill_id = super::ai::pick_best_skill(&attacker, &defender, skills, type_chart);
    resolve_one_attack(
        state,
        enemy_side,
        skill_id,
        skills,
        type_chart,
        variance,
        &mut events,
    );

    events
}

/// Resolve a player swap: swap first, then the enemy side attacks the new active.
///
/// Emits a `Switch` event for the player side, followed by whatever the enemy
/// turn produces.
pub fn resolve_player_swap(
    state: &mut BattleState,
    swap_side: SideId,
    new_active: u32,
    skills: &[SkillDef],
    type_chart: &TypeChart,
    variance: &TurnVariance,
) -> Vec<BattleEvent> {
    let mut events = Vec::new();

    let set = match swap_side {
        SideId::SideA => state.side_a.set_active(new_active),
        SideId::SideB => state.side_b.set_active(new_active),
    };
    if set.is_err() {
        return events; // illegal swap rejected: no mutation, no Switch, no enemy turn (ADR-0053)
    }
    events.push(BattleEvent::Switch {
        side: swap_side,
        new_active,
    });

    let enemy_side = opposite(swap_side);
    let enemy_events = resolve_enemy_turn(state, enemy_side, skills, type_chart, variance);
    events.extend(enemy_events);

    events
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
    // M8.5b-B: turn_number terminal guard at u16::MAX
    // -----------------------------------------------------------------------

    /// Kills: an impl that does `turn_number += 1` unconditionally at u16::MAX,
    /// causing a panic in debug mode (overflow) or a silent wrap to 0 in release.
    ///
    /// RED state today: in the debug test profile, `+= 1` on `u16::MAX` panics via
    /// overflow check → the test function panics → #[should_panic] would pass, but
    /// the assertions after the call are the real teeth. We instead just call it
    /// normally and assert the post-conditions, which means:
    ///   - today (no guard): panics in debug → test FAILS with a panic (runtime-RED)
    ///   - after the fix: returns cleanly, assertions all pass (GREEN)
    ///
    /// Assertion (c) `turn_number == u16::MAX` is the mutation-killing assertion:
    /// a mutant that increments anyway wraps to 0 → assertion (c) fails.
    /// A mutant that sets a different outcome (e.g. SideAWins) → assertion (b) fails.
    #[test]
    fn resolve_turn_at_u16_max_terminates_without_wrap_or_panic() {
        let chart = make_type_chart();
        // Build two healthy monsters that will not KO each other in one turn
        // (high HP, moderate attack) so the battle stays Ongoing after this turn
        // IF the guard fires. We explicitly want Ongoing→Fled via the guard,
        // not Ongoing→SideAWins via combat.
        let monster_a = make_monster(Affinity::Fire, 500, 50);
        let monster_b = make_monster(Affinity::Water, 500, 40);
        let mut state = make_battle_state(monster_a, monster_b);

        // Set turn_number to the maximum possible value to trigger the guard.
        state.turn_number = u16::MAX;

        let variance = always_hit_variance(true);

        // (a) must return without panic
        let events = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
        );

        // (b) outcome must be Fled — the guard fires and sets this specific outcome
        assert_eq!(
            state.outcome,
            BattleOutcome::Fled,
            "TEETH(outcome): guard must set outcome=Fled at turn_number==u16::MAX; \
             a mutant setting SideAWins/SideBWins/Ongoing fails here"
        );

        // (c) turn_number must NOT have changed — the guard fires BEFORE the increment
        assert_eq!(
            state.turn_number,
            u16::MAX,
            "TEETH(no-increment): turn_number must remain u16::MAX (guard returned \
             before += 1); a mutant that still increments wraps to 0 and fails here"
        );

        // (d) no partial-turn events must have been emitted (no mutation occurred)
        assert!(
            events.is_empty(),
            "TEETH(no-events): guard must return before any attack resolution; \
             got {events:?}"
        );
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

    // -----------------------------------------------------------------------
    // M8.6a: pure-core swap legality — PROOF-OF-TEETH (ADR-0053)
    //
    // The resolver must route every `active = idx` write through the checked
    // `BattleSide::set_active`, so an out-of-bounds or fainted `team_index`
    // is REJECTED (no `active` mutation, no `Switch` event, no panic-index)
    // rather than written raw and later panic-indexed by `active_monster()`.
    //
    // Shared setup: side A = [conscious active @0, slot 1], side B = 1 conscious.
    // -----------------------------------------------------------------------

    /// A's slot 0 is the active conscious monster; `m1` fills slot 1 (its HP
    /// is set per-test). Side B is a single conscious monster.
    fn make_swap_legality_state(m1_hp: u16) -> BattleState {
        let a0 = make_monster(Affinity::Fire, 100, 50);
        let a1 = make_monster(Affinity::Water, m1_hp, 50);
        let b0 = make_monster(Affinity::Fire, 100, 30);
        BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![a0, a1],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![b0],
            },
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
        }
    }

    /// Kills: a `resolve_turn` Swap branch that writes `side_a.active = team_index`
    /// raw — an OOB index would either panic-index in `active_monster()` or leave
    /// `active` pointing past the team. The checked setter must reject it: no
    /// panic, `active` unchanged, no `Switch` for SideA.
    #[test]
    fn resolve_turn_swap_to_out_of_bounds_is_rejected() {
        let chart = make_type_chart();
        let mut state = make_swap_legality_state(100);
        let pre_active = state.side_a.active; // 0
        let variance = always_hit_variance(true);

        // &mut BattleState is not UnwindSafe; wrap so we can assert "no panic".
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            resolve_turn(
                &mut state,
                TurnChoice::Swap { team_index: 99 },
                TurnChoice::Attack { skill_id: 1 },
                &skills_vec(),
                &chart,
                &variance,
            )
        }));

        let events = result.expect("TEETH: an OOB swap must NOT panic-index");
        assert_eq!(
            state.side_a.active, pre_active,
            "TEETH: active must be unchanged after a rejected OOB swap (a raw \
             `active = team_index` setter fails this)"
        );
        let switched_a = events.iter().any(|e| {
            matches!(
                e,
                BattleEvent::Switch {
                    side: SideId::SideA,
                    ..
                }
            )
        });
        assert!(
            !switched_a,
            "no Switch for SideA must be emitted for a rejected OOB swap"
        );
    }

    /// Kills: a `resolve_turn` Swap branch reverted to a raw `active = team_index`
    /// assignment. A raw setter does NOT panic when pointing at a present-but-
    /// fainted slot, so "no panic" alone is vacuous here — the LOAD-BEARING
    /// assertions are `active == pre_active` (unchanged) and that the active
    /// monster is not fainted. Both fail against a raw-assignment setter.
    #[test]
    fn resolve_turn_swap_to_fainted_slot_is_rejected() {
        let chart = make_type_chart();
        let mut state = make_swap_legality_state(0); // slot 1 fainted (hp 0)
        let pre_active = state.side_a.active; // 0
        let variance = always_hit_variance(true);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            resolve_turn(
                &mut state,
                TurnChoice::Swap { team_index: 1 },
                TurnChoice::Attack { skill_id: 1 },
                &skills_vec(),
                &chart,
                &variance,
            )
        }));

        let events = result.expect("a fainted-slot swap must not panic");
        // LOAD-BEARING: this is the assertion that bites a reverted-to-raw setter
        // (which would silently set active = 1, the fainted slot).
        assert_eq!(
            state.side_a.active, pre_active,
            "TEETH: active must remain at the conscious slot after a rejected \
             fainted swap; a raw `active = team_index` setter sets it to 1 here"
        );
        assert!(
            !state.side_a.active_monster().is_fainted(),
            "TEETH: the active monster must still be conscious after a rejected \
             fainted swap"
        );
        let switched_a = events.iter().any(|e| {
            matches!(
                e,
                BattleEvent::Switch {
                    side: SideId::SideA,
                    ..
                }
            )
        });
        assert!(
            !switched_a,
            "no Switch for SideA must be emitted for a rejected fainted swap"
        );
    }

    /// Kills: a `resolve_player_swap` that writes `active = new_active` raw — an
    /// OOB index panic-indexes when the enemy turn reads `active_monster()`. The
    /// checked setter must reject the swap entirely: no panic, empty events (no
    /// Switch AND no enemy Damage → proving NO enemy turn ran), `active`
    /// unchanged, and the enemy's HP untouched.
    #[test]
    fn resolve_player_swap_to_out_of_bounds_is_rejected() {
        let chart = make_type_chart();
        let mut state = make_swap_legality_state(100);
        let pre_active = state.side_a.active; // 0
        let pre_enemy_hp = state.side_b.active_monster().current_hp;
        let variance = always_hit_variance(true);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            resolve_player_swap(
                &mut state,
                SideId::SideA,
                99, // out of bounds
                &skills_vec(),
                &chart,
                &variance,
            )
        }));

        let events = result.expect("TEETH: an OOB player swap must NOT panic-index");
        assert!(
            events.is_empty(),
            "rejected OOB swap must emit no events (no Switch, no enemy Damage → \
             proves no enemy turn ran); got {events:?}"
        );
        assert_eq!(
            state.side_a.active, pre_active,
            "TEETH: active must be unchanged after a rejected OOB player swap"
        );
        assert_eq!(
            state.side_b.active_monster().current_hp,
            pre_enemy_hp,
            "the enemy must not attack when the swap is rejected"
        );
    }

    /// Kills: a `resolve_player_swap` reverted to a raw `active = new_active`
    /// assignment. Targeting a present-but-fainted slot does NOT panic for a raw
    /// setter, so the LOAD-BEARING assertions are `active == pre_active` and the
    /// active monster being non-fainted — both fail against a raw setter that
    /// silently moves active onto the fainted slot.
    #[test]
    fn resolve_player_swap_to_fainted_slot_is_rejected() {
        let chart = make_type_chart();
        let mut state = make_swap_legality_state(0); // slot 1 fainted (hp 0)
        let pre_active = state.side_a.active; // 0
        let pre_enemy_hp = state.side_b.active_monster().current_hp;
        let variance = always_hit_variance(true);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            resolve_player_swap(
                &mut state,
                SideId::SideA,
                1, // present but fainted
                &skills_vec(),
                &chart,
                &variance,
            )
        }));

        let events = result.expect("a fainted-slot player swap must not panic");
        let switched_a = events.iter().any(|e| {
            matches!(
                e,
                BattleEvent::Switch {
                    side: SideId::SideA,
                    ..
                }
            )
        });
        assert!(
            !switched_a,
            "no Switch for SideA for a rejected fainted player swap"
        );
        assert!(
            events.is_empty(),
            "rejected fainted swap must emit no events (no enemy Damage); got {events:?}"
        );
        // LOAD-BEARING: bites a reverted-to-raw-assignment setter, which would
        // set active = 1 (the fainted slot) without panicking.
        assert_eq!(
            state.side_a.active, pre_active,
            "TEETH: active must remain at the conscious slot after a rejected \
             fainted player swap; a raw `active = new_active` setter sets it to 1"
        );
        assert!(
            !state.side_a.active_monster().is_fainted(),
            "TEETH: the active monster must still be conscious after a rejected \
             fainted player swap"
        );
        assert_eq!(
            state.side_b.active_monster().current_hp,
            pre_enemy_hp,
            "the enemy must not attack when the swap is rejected"
        );
    }
}
