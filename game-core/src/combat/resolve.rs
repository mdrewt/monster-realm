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

    let (dmg, eff) = super::damage::calc_damage(
        &attacker,
        &defender,
        skill,
        type_chart,
        damage_roll,
        state.weather.as_ref(),
    );

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

    // Set weather AFTER damage + faint resolve — weather-setting move does not boost
    // its own hit (ADR-0095 D4). Fires even if the move KOs (the weather still changes).
    if let Some(kind) = skill.sets_weather {
        use super::weather::{WeatherEffect, WEATHER_DEFAULT_TURNS};
        state.weather = Some(WeatherEffect::from_kind(kind, WEATHER_DEFAULT_TURNS));
        events.push(BattleEvent::WeatherSet {
            weather: *state.weather.as_ref().expect("just set above"),
        });
    }

    // Apply status condition from the skill (m14e, ADR-0096). Only when ALL hold:
    //   1. Not immune (Immune hits return above; eff checked there).
    //   2. Target did NOT faint from this attack (status on a fainted monster is
    //      pointless; a switch-in is a new battle state for the next turn).
    //   3. Defender had NO status before this attack (no stacking; `defender` is
    //      the pre-attack clone so this reflects the state entering the attack).
    //
    // We emit StatusApplied here (event only — no direct store write). `resolve_full_turn`
    // applies the event to BattleStatusStore AFTER DoT so newly-applied status
    // takes effect the FOLLOWING turn (ADR-0096 §D1, correct game semantics).
    if let Some(kind) = skill.applies_status {
        use super::ability::StatusKind;
        use super::types::StatusEffect;
        if !fainted && defender.status.is_none() {
            let new_status = match kind {
                StatusKind::Poison => StatusEffect::Poison,
                StatusKind::Burn => StatusEffect::Burn,
                StatusKind::Paralysis => StatusEffect::Paralysis,
                StatusKind::Sleep => StatusEffect::Sleep { turns_remaining: 3 },
                StatusKind::Freeze => StatusEffect::Freeze,
            };
            events.push(BattleEvent::StatusApplied {
                side: defender_side,
                // Capture slot at emission time. The defender did not faint from this
                // attack (!fainted guard above), so active has not changed for the
                // defender side yet (ADR-0099 D1).
                slot: match defender_side {
                    SideId::SideA => state.side_a.active,
                    SideId::SideB => state.side_b.active,
                },
                status: new_status,
            });
        }
    }
}

/// Advance the battle's turn counter by one, honoring the turn-limit terminal.
///
/// This is the SINGLE owner (ADR-0003 SSOT) of the `turn_number` advance and its
/// `u16::MAX -> Fled` terminal. Every turn-advancing path routes its increment
/// through here — `resolve_turn` (the normal full turn) and the server's
/// `attempt_recruit` reducer (via `resolve_recruit_failure`) — so the terminal
/// can never drift between call sites. The player-swap path (`swap_active` ->
/// `resolve_player_swap`) deliberately does NOT advance the counter: a swap is
/// not a numbered turn, so it is correctly excluded from this owner.
///
/// Returns `true` when the turn advanced — the caller should resolve the turn.
/// Returns `false` *without advancing* in two cases, so the caller must NOT
/// resolve a turn:
/// - the battle is already decided (`outcome != Ongoing`): a no-op that preserves
///   the existing outcome (total-safety — a stray call can never overwrite a win);
/// - the turn-limit terminal fires (`turn_number == u16::MAX`): `outcome` is set
///   to `BattleOutcome::Fled` (a no-winner terminal — no XP, no win credit) and
///   `turn_number` is left unchanged (no wrap, no panic).
///
/// A `u16` turn counter cannot reach `u16::MAX` in valid play; the terminal is a
/// fail-safe so an unbounded battle (e.g. a skill-less wild that never faints,
/// driven via the recruit path) terminates deterministically instead of
/// overflowing.
#[must_use]
pub fn advance_turn(state: &mut BattleState) -> bool {
    // Total-safety: never advance or overwrite a battle that is already decided.
    if state.outcome != BattleOutcome::Ongoing {
        return false;
    }
    if state.turn_number == u16::MAX {
        state.outcome = BattleOutcome::Fled;
        return false;
    }
    state.turn_number += 1;
    true
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

    // Advance the turn through the single SSOT owner of the turn-limit terminal
    // (ADR-0003). `advance_turn` increments `turn_number` and terminates at
    // `u16::MAX -> Fled` BEFORE any swap/attack resolution, so no partial turn is
    // applied when the terminal fires. The recruit path (`attempt_recruit`) routes
    // its increment through the same helper, so the terminal cannot drift here.
    if !advance_turn(state) {
        return events;
    }

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
        TurnChoice::Pass => unreachable!("expected Attack, got Pass"),
    }
}

/// Resolve a full turn with status-effect and weather phases layered additively on
/// [`resolve_turn`]'s existing event pipeline (ADR-0017/0023 — signature unchanged).
///
/// Pipeline order:
/// 1. Pre-turn: action-block checks (Paralysis/Sleep/Freeze) via [`apply_pre_turn_effects`].
///    A blocked side's choice is replaced with [`TurnChoice::Pass`].
/// 2. Speed-ordered attacks via [`resolve_turn`] (unmodified plain-attack path).
///    Weather is read from `state.weather` inside `resolve_one_attack`; `sets_weather`
///    fires after each attack's damage resolves (ADR-0095 D4).
/// 3. Post-turn: DoT (Poison/Burn) via [`apply_post_turn_effects`].
/// 4. Status tick: Sleep decrement, Freeze thaw via [`tick_status`].
/// 5. Weather tick: turn decrement + expiry via [`tick_weather`].
///
/// Phase 3.5 (weather chip damage via [`apply_weather_damage`]) runs between phases 3 and 4.
///
/// With an empty [`BattleStatusStore`], no blocking variance, and `state.weather = None`
/// this is byte-identical to calling [`resolve_turn`] directly — the M7 regression
/// proof-of-teeth (EARS-1).
#[allow(clippy::too_many_arguments)]
pub fn resolve_full_turn(
    state: &mut BattleState,
    choice_a: TurnChoice,
    choice_b: TurnChoice,
    skills: &[SkillDef],
    type_chart: &TypeChart,
    variance: &TurnVariance,
    status: &mut super::status::BattleStatusStore,
    sv: &super::status::StatusVariance,
) -> Vec<BattleEvent> {
    use super::status::apply_pre_turn_effects;

    let mut events = Vec::new();

    // Phase 1: pre-turn action-block.
    let (a_can_act, b_can_act, pre_events) = apply_pre_turn_effects(status, state, sv);
    events.extend(pre_events);

    let effective_a = if a_can_act {
        choice_a
    } else {
        TurnChoice::Pass
    };
    let effective_b = if b_can_act {
        choice_b
    } else {
        TurnChoice::Pass
    };

    // Phase 1.5: sync BattleMonster.status FROM BattleStatusStore.
    sync_status_to_monsters(state, status);

    // Phase 2: resolve the turn (turn-number advance + speed-ordered attacks).
    // Weather modifier is read from state.weather inside resolve_one_attack;
    // sets_weather fires after each hit (ADR-0095 D4 — does not boost own damage).
    let turn_events = resolve_turn(
        state,
        effective_a,
        effective_b,
        skills,
        type_chart,
        variance,
    );
    events.extend(turn_events.iter().cloned());

    // Phases 3–5: post-turn pipeline, shared with swap/recruit paths (ADR-0098 D1, SSOT ADR-0003).
    run_post_turn_phases(state, status, sv, &turn_events, &mut events);

    events
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

/// Apply a FAILED recruit attempt to the battle state (the recruit roll already
/// missed; the caller owns the roll and the no-XP rebuild on success).
///
/// SSOT for the failed-recruit battle transition (ADR-0003) so the server's
/// `attempt_recruit` reducer cannot drift from this rule:
/// 1. Advance the turn through `advance_turn` (the single owner of the
///    `u16::MAX -> Fled` terminal). If it returns `false` — the terminal fired or
///    the battle was already decided — return with NO strike-back.
/// 2. Otherwise the wild (side B) strikes back, BUT only if it has at least one
///    skill: a skill-less wild cannot retaliate, yet the turn it consumed (step 1)
///    still counts toward the terminal.
/// 3. After the wild's strike-back, run the same post-turn phases as
///    `resolve_full_turn` (DoT, weather chip, status tick, StatusApplied write-back,
///    weather tick) so status/weather clocks tick every turn, not only on
///    `submit_attack` turns (ADR-0098 D1, closes R1/R3).
///
/// Returns all events produced (strike-back + post-turn). Empty when the terminal
/// fired or the wild is skill-less (post-turn phases still run when the wild is
/// skill-less, since the turn advanced). Only side B (the wild) ever strikes here.
pub fn resolve_recruit_failure(
    state: &mut BattleState,
    skills: &[SkillDef],
    type_chart: &TypeChart,
    variance: &TurnVariance,
    status: &mut super::status::BattleStatusStore,
    sv: &super::status::StatusVariance,
) -> Vec<BattleEvent> {
    if !advance_turn(state) {
        // Turn-limit terminal fired (outcome now Fled) or battle already decided:
        // no strike-back, no post-turn phases.
        return Vec::new();
    }

    // Phase 1.5: sync BattleMonster.status FROM BattleStatusStore.
    sync_status_to_monsters(state, status);

    let mut events = Vec::new();

    // A skill-less wild cannot retaliate; the turn still advanced above.
    // Keep strike_events separate so run_post_turn_phases receives only the
    // action slice (not the accumulator), matching the resolve_player_swap pattern.
    let mut strike_events = Vec::new();
    if !state.side_b.active_monster().known_skill_ids.is_empty() {
        strike_events = resolve_enemy_turn(state, SideId::SideB, skills, type_chart, variance);
        events.extend(strike_events.iter().cloned());
    }

    // Phases 3–5: post-turn pipeline (same as resolve_full_turn; ADR-0098 D1).
    // Runs even when the wild is skill-less — the turn advanced, so clocks tick.
    run_post_turn_phases(state, status, sv, &strike_events, &mut events);

    events
}

/// Resolve a player swap: swap first, then the enemy side attacks the new active,
/// then run the post-turn status/weather phases (ADR-0098 D1, closes R1).
///
/// Emits a `Switch` event for the player side, followed by enemy-turn and
/// post-turn events.
///
/// Swapping is always permitted regardless of the player's active monster status
/// condition (ADR-0098 D3, D-14.5-1 decision b): this path does not call
/// `apply_pre_turn_effects`. The swap-on-status-block conversion described in the
/// original ADR-0092 §D3 is dead code and hereby de-scoped.
///
/// This function does NOT call `advance_turn`; player swaps are not counted as
/// numbered turns toward the `u16::MAX` terminal.
#[allow(clippy::too_many_arguments)]
pub fn resolve_player_swap(
    state: &mut BattleState,
    swap_side: SideId,
    new_active: u32,
    skills: &[SkillDef],
    type_chart: &TypeChart,
    variance: &TurnVariance,
    status: &mut super::status::BattleStatusStore,
    sv: &super::status::StatusVariance,
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

    // Phase 1.5: sync BattleMonster.status FROM BattleStatusStore.
    sync_status_to_monsters(state, status);

    let enemy_side = opposite(swap_side);
    let enemy_events = resolve_enemy_turn(state, enemy_side, skills, type_chart, variance);
    events.extend(enemy_events.iter().cloned());

    // Phases 3–5: post-turn pipeline (same as resolve_full_turn; ADR-0098 D1).
    run_post_turn_phases(state, status, sv, &enemy_events, &mut events);

    events
}

/// Sync `BattleMonster.status` from `BattleStatusStore` for all team slots.
///
/// The store is authoritative; `BattleMonster.status` is the persisted-to-DB field.
/// `resolve_one_attack` reads the field for the "no stacking" guard, so the field
/// must mirror the store before any attack resolves. In normal server flow the two
/// are already in sync (the server builds the store from the field before calling any
/// resolver), so this is a no-op in steady state.
fn sync_status_to_monsters(state: &mut BattleState, status: &super::status::BattleStatusStore) {
    for (i, s) in status.side_a.iter().enumerate() {
        if let Some(m) = state.side_a.team.get_mut(i) {
            m.status = *s;
        }
    }
    for (i, s) in status.side_b.iter().enumerate() {
        if let Some(m) = state.side_b.team.get_mut(i) {
            m.status = *s;
        }
    }
}

/// Run post-turn phases 3–5 after the combat action for a turn.
///
/// Shared by `resolve_full_turn`, `resolve_player_swap`, and `resolve_recruit_failure`
/// (ADR-0003 SSOT, ADR-0098 D1).
///
/// `action_events`: the events from the combat action; `StatusApplied` events are
///   extracted for phase 4.5 write-back.
/// `out_events`: the Vec to append post-turn events into.
fn run_post_turn_phases(
    state: &mut BattleState,
    status: &mut super::status::BattleStatusStore,
    sv: &super::status::StatusVariance,
    action_events: &[BattleEvent],
    out_events: &mut Vec<BattleEvent>,
) {
    use super::status::{apply_post_turn_effects, tick_status};
    use super::weather::{apply_weather_damage, tick_weather};

    // Collect StatusApplied triples (side, slot, status) from the combat action for
    // phase 4.5. The slot is encoded in the event at emission time (ADR-0099 D1),
    // so no active-slot capture is needed here — the event carries the correct target
    // even if DoT/weather-chip auto-switches fire in phases 3/3.5.
    let status_applied: Vec<(SideId, u32, super::types::StatusEffect)> = action_events
        .iter()
        .filter_map(|e| {
            if let BattleEvent::StatusApplied {
                side,
                slot,
                status: new_status,
            } = e
            {
                Some((*side, *slot, *new_status))
            } else {
                None
            }
        })
        .collect();

    // Phase 3: post-turn DoT.
    if state.outcome == BattleOutcome::Ongoing {
        let post_events = apply_post_turn_effects(state, status);
        out_events.extend(post_events);
    }

    // Phase 3.5: weather chip damage (Sandstorm/Hail end-of-turn DoT).
    if state.outcome == BattleOutcome::Ongoing {
        apply_weather_damage(state, out_events);
    }

    // Phase 4: status tick (Sleep/Freeze expire).
    if state.outcome == BattleOutcome::Ongoing {
        let tick_events = tick_status(status, sv);
        out_events.extend(tick_events);
    }

    // Phase 4.5: write StatusApplied effects into BattleStatusStore (ADR-0096 §D1).
    // MUST be after phases 3/4 so newly-inflicted status does NOT cause same-turn
    // DoT or Sleep/Freeze tick — it takes effect the FOLLOWING turn.
    //
    // Slot comes from the event (ADR-0099 D1), not from state.side_X.active — so a
    // weather-chip KO + auto-switch in phase 3.5 cannot redirect the write.
    // Drop the write if the targeted monster fainted in phase 3/3.5 (ADR-0099 D2).
    if state.outcome == BattleOutcome::Ongoing {
        for (side, slot, new_status) in status_applied {
            let idx = slot as usize;
            let is_conscious = match side {
                SideId::SideA => state.side_a.team.get(idx).map(|m| !m.is_fainted()),
                SideId::SideB => state.side_b.team.get(idx).map(|m| !m.is_fainted()),
            }
            .unwrap_or(false);
            if !is_conscious {
                // Drop: monster fainted between emission and Phase 4.5 (ADR-0099 D2).
                continue;
            }
            let store_vec = match side {
                SideId::SideA => &mut status.side_a,
                SideId::SideB => &mut status.side_b,
            };
            if let Some(cell) = store_vec.get_mut(idx) {
                *cell = Some(new_status);
            }
        }
    }

    // Phase 5: weather tick (decrement turns_remaining; emit WeatherExpired at 0).
    if state.outcome == BattleOutcome::Ongoing {
        tick_weather(state, out_events);
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::combat::status::{BattleStatusStore, StatusVariance};
    use crate::combat::type_chart::tests::make_type_chart;
    use crate::combat::types::{
        BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, TurnChoice,
        TurnVariance,
    };
    use crate::content::SkillDef;
    use crate::monster::types::{Affinity, StatBlock};
    use proptest::prelude::*;

    /// Empty status store for tests that don't exercise status effects.
    fn empty_store(a_size: usize, b_size: usize) -> BattleStatusStore {
        BattleStatusStore::new(a_size, b_size)
    }

    /// StatusVariance that never blocks (all action_skip_rolls >= 25, never thaw).
    fn no_block_sv() -> StatusVariance {
        StatusVariance {
            action_skip_roll_a: 99,
            action_skip_roll_b: 99,
            freeze_thaw_roll_a: 0,
            freeze_thaw_roll_b: 0,
            sleep_wake_roll_a: 0,
            sleep_wake_roll_b: 0,
        }
    }

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
            status: None,
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
            weather: None,
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
            sets_weather: None,
            applies_status: None,
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
            status: None,
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
            status: None,
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
            status: None,
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
            weather: None,
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
            status: None,
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
            weather: None,
        };
        let variance = always_hit_variance(true);
        let mut status = empty_store(2, 1);
        let sv = no_block_sv();
        let events = resolve_player_swap(
            &mut state,
            SideId::SideA,
            1, // swap to index 1
            &skills_vec(),
            &chart,
            &variance,
            &mut status,
            &sv,
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

    // -----------------------------------------------------------------------
    // M8.8b-A: advance_turn behavioral tests
    // -----------------------------------------------------------------------

    /// Kills: a mutant that doesn't increment turn_number, or that returns false
    /// on a normal (non-MAX) turn, or that changes the outcome away from Ongoing.
    ///
    /// `advance_turn` from a mid-range turn_number on an Ongoing battle must:
    ///   - return true
    ///   - increment turn_number by exactly 1
    ///   - leave outcome == BattleOutcome::Ongoing
    ///
    /// RED state: compile-RED because `advance_turn` does not exist yet.
    #[test]
    fn advance_turn_mid_range_returns_true_and_increments() {
        let monster_a = make_monster(Affinity::Fire, 200, 50);
        let monster_b = make_monster(Affinity::Water, 200, 40);
        let mut state = make_battle_state(monster_a, monster_b);
        state.turn_number = 5;

        let result = advance_turn(&mut state);

        assert!(
            result,
            "TEETH: advance_turn must return true on a non-MAX turn_number; \
             a mutant returning false fails here"
        );
        assert_eq!(
            state.turn_number, 6,
            "TEETH: advance_turn must increment turn_number by exactly 1 (5 → 6); \
             a mutant that doesn't increment or increments by 2 fails here"
        );
        assert_eq!(
            state.outcome,
            BattleOutcome::Ongoing,
            "TEETH: advance_turn must not change outcome on a non-MAX turn; \
             a mutant that sets Fled on every call fails here"
        );
    }

    /// Kills THREE mutant classes simultaneously:
    ///   - Mutant A: still increments at MAX → wraps to 0 → assertion (c) fails
    ///   - Mutant B: sets a wrong outcome (e.g. SideAWins) → assertion (b) fails
    ///   - Mutant C: returns true at MAX → assertion (a) fails
    ///
    /// This is THE proof-of-teeth for the recruit-path terminal: when turn_number
    /// is already u16::MAX, advance_turn must terminate the battle without
    /// overflowing (no panic, no wrap-to-0) and must set the Fled outcome.
    ///
    /// RED state: compile-RED because `advance_turn` does not exist yet.
    #[test]
    fn advance_turn_at_u16_max_is_terminal_without_wrap_or_panic() {
        let monster_a = make_monster(Affinity::Fire, 500, 50);
        let monster_b = make_monster(Affinity::Water, 500, 40);
        let mut state = make_battle_state(monster_a, monster_b);
        state.turn_number = u16::MAX;

        // (a) must NOT panic — if this panics, the test fails with a panic message
        let result = advance_turn(&mut state);

        // (a) return value: must be false at the terminal
        assert!(
            !result,
            "TEETH(return): advance_turn must return false at turn_number==u16::MAX; \
             a mutant returning true fails here (ADR-0003: terminal signals caller to stop)"
        );

        // (b) outcome: must be Fled specifically — not SideAWins, SideBWins, or Ongoing
        assert_eq!(
            state.outcome,
            BattleOutcome::Fled,
            "TEETH(outcome): advance_turn must set outcome=Fled at u16::MAX; \
             a mutant setting SideAWins/SideBWins/Ongoing fails here"
        );

        // (c) turn_number: must be UNCHANGED — the guard fires WITHOUT incrementing
        assert_eq!(
            state.turn_number,
            u16::MAX,
            "TEETH(no-wrap): turn_number must remain u16::MAX after terminal guard; \
             a mutant that still increments wraps to 0 in release and fails here"
        );
    }

    // -----------------------------------------------------------------------
    // M8.8b-A2: advance_turn total-safety guard (runtime-RED today)
    //
    // advance_turn gains a new early-return: if state.outcome != Ongoing it
    // must return false WITHOUT touching outcome or turn_number.  Today it
    // does NOT have this guard, so on a SideAWins battle at u16::MAX it
    // overwrites outcome to Fled — this test is therefore RUNTIME-RED now.
    // -----------------------------------------------------------------------

    /// Kills: an impl that overwrites a decided outcome with Fled when
    /// turn_number == u16::MAX.
    ///
    /// Setup: outcome already SideAWins, turn_number u16::MAX.
    /// After the total-safety guard: advance_turn must return false and leave
    /// outcome == SideAWins (not Fled), turn_number == u16::MAX.
    ///
    /// RED today: current advance_turn hits the u16::MAX branch first, sets
    /// Fled, and returns false — so the outcome assertion (SideAWins) fails.
    #[test]
    fn advance_turn_on_decided_battle_preserves_outcome() {
        let monster_a = make_monster(Affinity::Fire, 200, 50);
        let monster_b = make_monster(Affinity::Water, 200, 40);
        let mut state = make_battle_state(monster_a, monster_b);
        state.turn_number = u16::MAX;
        state.outcome = BattleOutcome::SideAWins; // already decided

        let result = advance_turn(&mut state);

        assert!(
            !result,
            "TEETH: advance_turn must return false on a decided (non-Ongoing) battle"
        );
        assert_eq!(
            state.outcome,
            BattleOutcome::SideAWins,
            "TEETH: advance_turn must NOT overwrite an already-decided outcome; \
             a missing total-safety guard sets outcome=Fled here, failing this assertion"
        );
        assert_eq!(
            state.turn_number,
            u16::MAX,
            "TEETH: turn_number must remain u16::MAX when the total-safety guard fires"
        );
    }

    // -----------------------------------------------------------------------
    // M8.8b-A3 (optional strengthener): idempotency at the terminal
    // -----------------------------------------------------------------------

    /// Idempotency at the terminal: calling advance_turn TWICE at u16::MAX keeps
    /// outcome Fled and turn_number u16::MAX on both calls.
    ///
    /// Kills: an impl that only guards the first call but allows wrapping on
    /// subsequent calls (e.g. by checking outcome rather than turn_number).
    ///
    /// RED state: compile-RED because `advance_turn` does not exist yet.
    #[test]
    fn advance_turn_at_u16_max_is_idempotent() {
        let monster_a = make_monster(Affinity::Fire, 200, 50);
        let monster_b = make_monster(Affinity::Water, 200, 40);
        let mut state = make_battle_state(monster_a, monster_b);
        state.turn_number = u16::MAX;

        let r1 = advance_turn(&mut state);
        // Note: the second call sees outcome==Fled, but the contract is on turn_number==MAX
        let r2 = advance_turn(&mut state);

        assert!(!r1, "first advance_turn at u16::MAX must return false");
        assert!(
            !r2,
            "second advance_turn at u16::MAX must also return false (idempotent)"
        );
        assert_eq!(
            state.turn_number,
            u16::MAX,
            "TEETH: turn_number must remain u16::MAX after two calls at the terminal; \
             a guard that only fires once would wrap to 0 on the second call"
        );
        assert_eq!(
            state.outcome,
            BattleOutcome::Fled,
            "outcome must remain Fled after both calls at the terminal"
        );
    }

    // -----------------------------------------------------------------------
    // M8.8b-D: resolve_recruit_failure behavioral teeth
    //
    // Tests compile-RED today because resolve_recruit_failure does not exist.
    //
    // Contract:
    //   1. Call advance_turn(state).
    //   2. If advance_turn returned false (terminal fired OR battle already
    //      decided) → return empty events with NO strike-back.
    //   3. Otherwise if wild (side_b active) has NO skills → return empty
    //      events (can't retaliate) but turn STILL advanced (step 1 happened).
    //   4. Otherwise → call resolve_enemy_turn(SideB) and return its events.
    // -----------------------------------------------------------------------

    /// Proof-of-teeth for the turn-limit terminal inside resolve_recruit_failure.
    ///
    /// Setup: side_b wild HAS skills (so in the normal path it would strike);
    /// turn_number == u16::MAX. Call with damaging always-hit variance.
    ///
    /// Must:
    ///   - return empty events (terminal fired BEFORE the strike-back)
    ///   - outcome == BattleOutcome::Fled
    ///   - turn_number == u16::MAX (no wrap)
    ///   - side_a active current_hp UNCHANGED (no free strike at terminal)
    ///
    /// Kills:
    ///   - An inverted check (`if advance_turn(...) { /* no-op */ } else { strike }`)
    ///     would let the wild hit side_a at the terminal → HP decreases → fails.
    ///   - A missing terminal fires the strike-back → events non-empty → fails.
    ///   - A wrapping impl → turn_number == 0 → fails.
    ///
    /// RED state: compile-RED (resolve_recruit_failure absent).
    #[test]
    fn resolve_recruit_failure_at_u16_max_terminates_without_strikeback() {
        let chart = make_type_chart();
        // Side A: healthy, survives any hit — we need to detect if it was hit at all
        let monster_a = make_monster(Affinity::Fire, 500, 50);
        // Side B wild: HAS skills, so in the normal path it would strike
        let monster_b = make_monster(Affinity::Water, 200, 40);
        let mut state = make_battle_state(monster_a, monster_b);
        state.turn_number = u16::MAX;

        let pre_hp_a = state.side_a.active_monster().current_hp;
        // Damaging, always-hit variance — any strike-back would reduce side_a HP
        let variance = always_hit_variance(false); // false → B faster, B hits first if it acts
        let mut status = empty_store(1, 1);
        let sv = no_block_sv();

        let events = resolve_recruit_failure(
            &mut state,
            &skills_vec(),
            &chart,
            &variance,
            &mut status,
            &sv,
        );

        assert!(
            events.is_empty(),
            "TEETH: resolve_recruit_failure at u16::MAX must return empty events \
             (terminal fires before strike-back); \
             an inverted advance_turn check or missing terminal lets the wild act — \
             events: {events:?}"
        );
        assert_eq!(
            state.outcome,
            BattleOutcome::Fled,
            "TEETH: outcome must be Fled after u16::MAX terminal; \
             a mutant skipping the terminal leaves outcome Ongoing"
        );
        assert_eq!(
            state.turn_number,
            u16::MAX,
            "TEETH: turn_number must remain u16::MAX (no wrap); \
             a mutant that still increments produces 0"
        );
        assert_eq!(
            state.side_a.active_monster().current_hp,
            pre_hp_a,
            "TEETH: side_a HP must be unchanged — no strike-back occurs at the terminal; \
             an inverted advance_turn check allows the wild to hit side_a here"
        );
    }

    /// Skilled wild advances the turn AND strikes back on a normal (non-MAX) turn.
    ///
    /// Setup: turn_number = 5; side_b active has skills; side_a has high HP
    /// so it survives the hit. Always-hit damaging variance.
    ///
    /// Must:
    ///   - turn_number == 6 (incremented)
    ///   - events NON-empty (wild acted)
    ///   - side_a active current_hp < pre_hp_a (wild actually dealt damage)
    ///
    /// Kills: a mutant that skips the resolve_enemy_turn call (events empty /
    /// HP unchanged). Also kills a mutant that doesn't advance the turn.
    ///
    /// RED state: compile-RED (resolve_recruit_failure absent).
    #[test]
    fn resolve_recruit_failure_skilled_wild_advances_and_strikes() {
        let chart = make_type_chart();
        // Side A: very high HP, survives any hit from a level-5 Water monster
        let monster_a = make_monster(Affinity::Fire, 1000, 50);
        // Side B: skilled Water wild — Fire is weak to Water so damage is guaranteed
        let monster_b = make_monster(Affinity::Water, 200, 40);
        let mut state = make_battle_state(monster_a, monster_b);
        state.turn_number = 5;

        let pre_hp_a = state.side_a.active_monster().current_hp;
        // B faster (false tie-breaker), always hits
        let variance = always_hit_variance(false);
        let mut status = empty_store(1, 1);
        let sv = no_block_sv();

        let events = resolve_recruit_failure(
            &mut state,
            &skills_vec(),
            &chart,
            &variance,
            &mut status,
            &sv,
        );

        assert_eq!(
            state.turn_number, 6,
            "TEETH: turn_number must increment from 5 to 6 on a normal recruit failure; \
             a mutant that skips advance_turn leaves turn_number at 5"
        );
        assert!(
            !events.is_empty(),
            "TEETH: a skilled wild must produce events (at minimum a Damage event); \
             a mutant that skips resolve_enemy_turn returns empty events"
        );
        assert!(
            state.side_a.active_monster().current_hp < pre_hp_a,
            "TEETH: side_a HP must decrease after the wild's strike-back \
             (always-hit damaging variance, Fire vs Water); \
             a mutant skipping the enemy turn leaves HP unchanged"
        );
    }

    /// Skill-less wild STILL advances the turn but does NOT strike back.
    ///
    /// This is the key mutation-killing test for operand-order bugs:
    /// a body like `if wild_has_skills && advance_turn(state) { strike }` would
    /// short-circuit — advance_turn never called for a skill-less wild — leaving
    /// turn_number at 5 and outcome Ongoing. This test catches that.
    ///
    /// Setup: side_b active has NO known skills; turn_number = 5.
    ///
    /// Must:
    ///   - turn_number == 6 (STILL advances — skill-less wilds still burn turns
    ///     toward the u16::MAX terminal)
    ///   - outcome == Ongoing
    ///   - events EMPTY (can't retaliate without skills)
    ///   - side_a current_hp UNCHANGED
    ///
    /// Kills: `wild_has_skills && advance_turn(...)` short-circuit mutant —
    /// turn_number stays 5 → assertion fails.
    ///
    /// RED state: compile-RED (resolve_recruit_failure absent).
    #[test]
    fn resolve_recruit_failure_skillless_wild_advances_no_strike() {
        let chart = make_type_chart();
        let monster_a = make_monster(Affinity::Fire, 200, 50);
        // Build a skill-less wild: BattleMonster with empty known_skill_ids
        let monster_b = BattleMonster {
            species_id: 2,
            affinity: Affinity::Water,
            level: 5,
            current_hp: 100,
            max_hp: 100,
            stats: make_stat_block_with_speed(40, 40, 40),
            known_skill_ids: vec![], // NO skills
            status: None,
        };
        let mut state = make_battle_state(monster_a, monster_b);
        state.turn_number = 5;

        let pre_hp_a = state.side_a.active_monster().current_hp;
        let variance = always_hit_variance(true);
        let mut status = empty_store(1, 1);
        let sv = no_block_sv();

        let events = resolve_recruit_failure(
            &mut state,
            &skills_vec(),
            &chart,
            &variance,
            &mut status,
            &sv,
        );

        assert_eq!(
            state.turn_number, 6,
            "TEETH: turn_number must STILL increment for a skill-less wild (5 → 6); \
             a `wild_has_skills && advance_turn(...)` short-circuit mutant never \
             calls advance_turn, leaving turn_number at 5 — this assertion fails it"
        );
        assert_eq!(
            state.outcome,
            BattleOutcome::Ongoing,
            "outcome must remain Ongoing after a skill-less wild fails to retaliate"
        );
        assert!(
            events.is_empty(),
            "TEETH: a skill-less wild cannot retaliate — events must be empty; \
             got {events:?}"
        );
        assert_eq!(
            state.side_a.active_monster().current_hp,
            pre_hp_a,
            "side_a HP must be unchanged when the wild has no skills"
        );
    }

    /// Documents that referencing an unknown skill_id panics with a content-integrity message.
    ///
    /// Kills: an impl that silently ignores or returns an empty event list for an unknown
    /// skill_id (which violates the ADR-0049 content-integrity invariant). The bare
    /// `#[should_panic]` was tautological because a trailing `panic!` satisfied it regardless
    /// of whether `resolve_turn` actually panicked — `expected=` narrows the gate so only
    /// the real content-lookup panic passes (12.5f-4).
    #[test]
    #[should_panic(expected = "skill id 9999 not found in skills registry")]
    fn unknown_skill_id_panics() {
        let chart = make_type_chart();
        let monster_a = make_monster(Affinity::Fire, 200, 50);
        let monster_b = make_monster(Affinity::Water, 200, 40);
        let mut state = make_battle_state(monster_a, monster_b);
        let variance = always_hit_variance(true);
        // skill_id 9999 does not exist in skills_vec() — must panic with the message above.
        let _ = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 9999 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
        );
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
            weather: None,
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
            let mut status = empty_store(2, 1);
            let sv = no_block_sv();
            resolve_player_swap(
                &mut state,
                SideId::SideA,
                99, // out of bounds
                &skills_vec(),
                &chart,
                &variance,
                &mut status,
                &sv,
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
            let mut status = empty_store(2, 1);
            let sv = no_block_sv();
            resolve_player_swap(
                &mut state,
                SideId::SideA,
                1, // present but fainted
                &skills_vec(),
                &chart,
                &variance,
                &mut status,
                &sv,
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

    // -----------------------------------------------------------------------
    // Nightly mutation hardening (4 survivors in `resolve_turn`).
    // -----------------------------------------------------------------------

    /// Power-65 STAB fire skill under a non-1 id, so a `skill_id_from -> 1`
    /// mutant is observable as a damage difference.
    fn fire_skill_65_id7() -> SkillDef {
        SkillDef {
            id: 7,
            name: "Fire Fang".to_string(),
            affinity: Affinity::Fire,
            power: 65,
            accuracy: 100,
            pp: 15,
            sets_weather: None,
            applies_status: None,
        }
    }

    /// Kills three survivors at once:
    /// - 259 `outcome != Ongoing` -> `==` (early-returns after the first
    ///   attack; only ONE damage event would remain),
    /// - 267 `delete !` on `!second_had_faint` (second attack skipped),
    /// - 304 `skill_id_from -> 1` (A's damage becomes 14, not 20).
    ///
    /// Exact amounts: A (Fire, skill 7, STAB, SE vs Plant) deals
    /// (2*5/5+2)*65*40/40/50+2 = 7 -> STAB 10 -> eff 20; B (Plant, skill 1,
    /// non-STAB Fire, NVE vs Fire) deals 5 -> eff 5/10 -> 2.
    #[test]
    fn both_sides_deal_exact_damage_when_no_faint() {
        let mut a = make_monster(Affinity::Fire, 100, 10);
        a.known_skill_ids = vec![7];
        let b = make_monster(Affinity::Plant, 100, 5);
        let mut state = make_battle_state(a, b);
        let skills = vec![fire_skill(), fire_skill_65_id7()];
        let events = resolve_turn(
            &mut state,
            TurnChoice::Attack { skill_id: 7 },
            TurnChoice::Attack { skill_id: 1 },
            &skills,
            &make_type_chart(),
            &always_hit_variance(true),
        );
        let damage: Vec<(SideId, u16)> = events
            .iter()
            .filter_map(|e| match e {
                BattleEvent::Damage { side, amount, .. } => Some((*side, *amount)),
                _ => None,
            })
            .collect();
        assert_eq!(
            damage,
            vec![(SideId::SideB, 20), (SideId::SideA, 2)],
            "faster A hits B for exactly 20 with skill 7, then B replies for 2"
        );
        assert_eq!(state.outcome, BattleOutcome::Ongoing);
    }

    /// Kills: `speed_b > speed_a` -> `>=` (232:27). On an exact speed tie the
    /// breaker must decide BOTH directions; the mutant hardwires B-first.
    #[test]
    fn speed_tie_breaker_decides_both_directions() {
        for a_first in [true, false] {
            let a = make_monster(Affinity::Fire, 100, 7);
            let b = make_monster(Affinity::Fire, 100, 7);
            let mut state = make_battle_state(a, b);
            let events = resolve_turn(
                &mut state,
                TurnChoice::Attack { skill_id: 1 },
                TurnChoice::Attack { skill_id: 1 },
                &skills_vec(),
                &make_type_chart(),
                &always_hit_variance(a_first),
            );
            let first_damage_side = events.iter().find_map(|e| match e {
                BattleEvent::Damage { side, .. } => Some(*side),
                _ => None,
            });
            let expected = if a_first {
                SideId::SideB
            } else {
                SideId::SideA
            };
            assert_eq!(
                first_damage_side,
                Some(expected),
                "tie with breaker a_first={a_first}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // M14.5a gating tests — post-turn phase coverage for the two new paths
    // (EARS 14.5a-2 and EARS 14.5a-4)
    // -----------------------------------------------------------------------

    use crate::combat::types::StatusEffect;
    use crate::combat::weather::WeatherEffect;

    fn make_monster_no_skills(affinity: Affinity, hp: u16, speed: u16) -> BattleMonster {
        BattleMonster {
            species_id: 1,
            affinity,
            level: 5,
            current_hp: hp,
            max_hp: hp,
            stats: make_stat_block_with_speed(40, 40, speed),
            known_skill_ids: vec![],
            status: None,
        }
    }

    // EARS 14.5a-2a: weather clock ticks during resolve_recruit_failure
    //
    // Kills: an impl that runs the turn advance + enemy strike but omits the
    // post-turn phase call (run_post_turn_phases), leaving turns_remaining at 3.
    //
    // Wild has no skills → no retaliation panic; the turn advance still happens
    // and post-turn phases (including weather tick) still run.
    #[test]
    fn sandstorm_ticks_during_resolve_recruit_failure() {
        let chart = make_type_chart();
        let player = make_monster(Affinity::Fire, 200, 50);
        let wild = make_monster_no_skills(Affinity::Water, 200, 50);
        let mut state = make_battle_state(player, wild);
        state.weather = Some(WeatherEffect::Sandstorm { turns_remaining: 3 });
        let mut status = BattleStatusStore::new(1, 1);
        let sv = StatusVariance::from_ctx_random(0);
        let variance = always_hit_variance(true);
        // Skill-less wild: resolve_recruit_failure guards the enemy turn with
        // `if !known_skill_ids.is_empty()` so &[] is safe here.
        resolve_recruit_failure(&mut state, &[], &chart, &variance, &mut status, &sv);
        assert_eq!(
            state.weather,
            Some(WeatherEffect::Sandstorm { turns_remaining: 2 }),
            "TEETH: turns_remaining must tick 3→2; a missing post-turn phase call \
             leaves it at 3 — this assertion catches that"
        );
    }

    // EARS 14.5a-2b: Poison DoT fires on the swapped-in monster during resolve_player_swap
    //
    // Kills: an impl that performs the swap + enemy attack but omits
    // run_post_turn_phases, leaving the new active's HP unchanged at 400
    // (minus whatever the enemy deals — but 400 - enemy_dmg > 400 - enemy_dmg - 50,
    // so the strict < check bites).
    //
    // Enemy has skill id=1 and is given skills_vec() so pick_best_skill does not panic.
    // Player team has 400 HP to survive both enemy attack and Poison DoT.
    #[test]
    fn poison_dot_fires_during_resolve_player_swap() {
        let chart = make_type_chart();
        // Player slot 0: active, healthy Fire, 400 HP — survives enemy Fire hit + DoT.
        let active = make_monster(Affinity::Fire, 400, 50);
        // Player slot 1: bench (to be swapped in), poisoned, 400 HP Fire.
        // known_skill_ids=[1] so `make_monster` is fine; we override it:
        let mut bench = make_monster(Affinity::Fire, 400, 50);
        bench.known_skill_ids = vec![]; // bench doesn't need to fight
                                        // Enemy: Fire, skill id=1, 400 HP — can attack but won't KO the player.
        let enemy = make_monster(Affinity::Fire, 400, 30);
        let mut state = BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![active, bench],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![enemy],
            },
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
            weather: None,
        };
        let mut status = BattleStatusStore::new(2, 1);
        // slot 1 (the bench monster being swapped IN) is poisoned in the store
        status.side_a[1] = Some(StatusEffect::Poison);
        let sv = no_block_sv();
        let variance = always_hit_variance(true);
        // skills_vec() contains skill id=1 — needed for the enemy's pick_best_skill.
        resolve_player_swap(
            &mut state,
            SideId::SideA,
            1,
            &skills_vec(),
            &chart,
            &variance,
            &mut status,
            &sv,
        );
        // After the swap state.side_a.active == 1 (the poisoned monster).
        // Phase 1.5 syncs team[1].status = Poison from the store.
        // Phase 3 DoT: Poison deals max_hp/8 = 400/8 = 50.
        // The enemy also dealt some damage, so current_hp < 400 regardless;
        // but the key test is that current_hp < (400 - enemy_damage) — i.e. DoT fired.
        // We verify by checking the DoT specifically: current_hp must be < 400 - 0
        // (any reduction proves either DoT or enemy hit fired, both require post-turn
        // phases). We additionally assert outcome is Ongoing (no KO), which proves
        // phases ran without exploding the battle.
        assert_eq!(
            state.side_a.active, 1,
            "swap must have moved active to slot 1"
        );
        assert!(
            state.side_a.team[1].current_hp < 400,
            "TEETH: Poison DoT (and/or enemy damage) must fire after the swap (hp {}/400); \
             a missing post-turn phase call leaves hp at 400 minus only enemy damage",
            state.side_a.team[1].current_hp
        );
        // The Poison DoT is 50 (400/8). The enemy (Fire vs Fire, neutral) at level 5
        // deals a modest amount. Both together leave the 400-hp monster well above 0.
        assert_eq!(
            state.outcome,
            BattleOutcome::Ongoing,
            "battle must remain Ongoing — 400-hp monster survives enemy hit + 50 DoT"
        );
        // Confirm DoT actually fired: the status store slot 1 still has Poison
        // (it's not cured by DoT, only Sleep/Freeze tick away) and the HP loss
        // exceeds what the enemy alone could deal at this level/power.
        // DoT = max_hp/8 = 400/8 = 50. If DoT fired, hp <= 400 - 50 = 350 regardless
        // of enemy damage. Without DoT, enemy alone deals <10, leaving hp >= 390.
        assert!(
            state.side_a.team[1].current_hp <= 350,
            "TEETH: DoT of 50 must have fired — hp {}/400 is too high if DoT was skipped \
             (enemy alone deals ≤10, so without DoT hp would be ≥390)",
            state.side_a.team[1].current_hp
        );
    }

    // EARS 14.5a-4: swap is always permitted regardless of the active monster's status
    //
    // Kills: any impl that routes resolve_player_swap through apply_pre_turn_effects
    // and converts a Sleep/Freeze/Paralysis block into a TurnChoice::Pass, which
    // would skip the set_active call and leave state.side_a.active == 0.
    //
    // Enemy has skill id=1 + skills_vec() so pick_best_skill does not panic.
    // Player has 400 HP to survive the enemy attack after the swap.

    #[test]
    fn swap_allowed_when_player_active_has_sleep() {
        let chart = make_type_chart();
        let active = make_monster(Affinity::Fire, 400, 50);
        let mut bench = make_monster(Affinity::Fire, 400, 50);
        bench.known_skill_ids = vec![];
        let enemy = make_monster(Affinity::Fire, 400, 30);
        let mut state = BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![active, bench],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![enemy],
            },
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
            weather: None,
        };
        let mut status = BattleStatusStore::new(2, 1);
        status.side_a[0] = Some(StatusEffect::Sleep { turns_remaining: 3 });
        // Sleep always blocks attacks; swap must not consult this at all.
        let sv = no_block_sv();
        let variance = always_hit_variance(true);
        resolve_player_swap(
            &mut state,
            SideId::SideA,
            1,
            &skills_vec(),
            &chart,
            &variance,
            &mut status,
            &sv,
        );
        assert_eq!(
            state.side_a.active, 1,
            "TEETH: swap must succeed despite Sleep on the active monster; \
             an impl that routes through apply_pre_turn_effects would block the \
             swap and leave active == 0"
        );
        assert_eq!(state.outcome, BattleOutcome::Ongoing);
    }

    #[test]
    fn swap_allowed_when_player_active_has_freeze() {
        let chart = make_type_chart();
        let active = make_monster(Affinity::Fire, 400, 50);
        let mut bench = make_monster(Affinity::Fire, 400, 50);
        bench.known_skill_ids = vec![];
        let enemy = make_monster(Affinity::Fire, 400, 30);
        let mut state = BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![active, bench],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![enemy],
            },
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
            weather: None,
        };
        let mut status = BattleStatusStore::new(2, 1);
        status.side_a[0] = Some(StatusEffect::Freeze);
        // freeze_thaw_roll_a: 0 — does NOT thaw (thaw needs >= 80), so Freeze
        // persists through the turn; swap must still succeed regardless.
        let sv = no_block_sv();
        let variance = always_hit_variance(true);
        resolve_player_swap(
            &mut state,
            SideId::SideA,
            1,
            &skills_vec(),
            &chart,
            &variance,
            &mut status,
            &sv,
        );
        assert_eq!(
            state.side_a.active, 1,
            "TEETH: swap must succeed despite Freeze on the active monster; \
             an impl routing through apply_pre_turn_effects blocks the swap"
        );
        assert_eq!(state.outcome, BattleOutcome::Ongoing);
    }

    #[test]
    fn swap_allowed_when_player_active_has_paralysis() {
        let chart = make_type_chart();
        let active = make_monster(Affinity::Fire, 400, 50);
        let mut bench = make_monster(Affinity::Fire, 400, 50);
        bench.known_skill_ids = vec![];
        let enemy = make_monster(Affinity::Fire, 400, 30);
        let mut state = BattleState {
            side_a: BattleSide {
                active: 0,
                team: vec![active, bench],
            },
            side_b: BattleSide {
                active: 0,
                team: vec![enemy],
            },
            outcome: BattleOutcome::Ongoing,
            turn_number: 0,
            weather: None,
        };
        let mut status = BattleStatusStore::new(2, 1);
        status.side_a[0] = Some(StatusEffect::Paralysis);
        // action_skip_roll_a: 0 — would block an attack (0 < 25 = paralysis
        // threshold); swap must not consult this roll at all.
        let sv = StatusVariance {
            action_skip_roll_a: 0,
            action_skip_roll_b: 99,
            freeze_thaw_roll_a: 0,
            freeze_thaw_roll_b: 0,
            sleep_wake_roll_a: 99,
            sleep_wake_roll_b: 99,
        };
        let variance = always_hit_variance(true);
        resolve_player_swap(
            &mut state,
            SideId::SideA,
            1,
            &skills_vec(),
            &chart,
            &variance,
            &mut status,
            &sv,
        );
        assert_eq!(
            state.side_a.active, 1,
            "TEETH: swap must succeed despite Paralysis with blocking roll (0 < 25); \
             an impl routing through apply_pre_turn_effects would block the swap and \
             leave active == 0"
        );
        assert_eq!(state.outcome, BattleOutcome::Ongoing);
    }
}
