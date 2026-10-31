//! End-of-round upkeep — design §2.2 "End-of-round upkeep", in the fixed order: status damage
//! ticks (in this round's initiative order) → PvP Surge (`round ≥ surge_start_round`) → the
//! reserved depth-wave slot (weather/field, hazards: a no-op until D2) → KO sweep + battle-end
//! check + adjudication (`outcome::settle`) → status duration decrement/expiry → round caps (wild
//! `round ≥ wild_round_cap` → auto-flee) → `round += 1` and rebuild initiative.
//!
//! Surge is TRUE damage: it bypasses Guard and First-Stand (never touches the attack pipeline).
//! Wild battles never Surge. Status values are carried M14: Poison max_hp/8 and Burn max_hp/16
//! (both min 1) are re-stated in [`status_tick_damage`] because the carried functions in
//! `combat::status` are private — an executing test pins them equal to the carried public
//! `apply_post_turn_effects` over every max_hp — while duration expiry (Sleep counting down,
//! Freeze thawing on a roll ≥ 80) CALLS the carried public `tick_status` through a scratch
//! one-slot store, by value, so no second copy of that rule exists. bt-17 retires the 1v1 copies.

use crate::combat::status::{tick_status, BattleStatusStore, StatusVariance};
use crate::combat::types::{BattleOutcome, StatusEffect};

use super::outcome::{end_battle, settle, BattleEndHow, StepSnapshot};
use super::resolve::{splitmix64, TacticalEvent, TacticalState};
use super::tuning::{BattleKind, TacticsTuning};

/// Carried M14 damage per tick: Poison `max_hp / 8`, Burn `max_hp / 16`, both min 1; every other
/// status (and no status) ticks nothing.
#[must_use]
pub fn status_tick_damage(status: &StatusEffect, max_hp: u16) -> Option<u16> {
    match status {
        StatusEffect::Poison => Some((max_hp / 8).max(1)),
        StatusEffect::Burn => Some((max_hp / 16).max(1)),
        StatusEffect::Paralysis | StatusEffect::Sleep { .. } | StatusEffect::Freeze => None,
    }
}

/// Surge damage for a unit of `max_hp` at `round`: `None` below `surge_start_round`, else
/// `max(1, max_hp × surge_pct_per_round × (round + 1 − surge_start_round) / 100)` — at the
/// design's numbers `max_hp × 5 × (r − 8) / 100`, floor. u64 intermediates, saturating to
/// `u16::MAX`.
#[must_use]
pub fn surge_damage(max_hp: u16, round: u16, t: &TacticsTuning) -> Option<u16> {
    if round < t.surge_start_round {
        return None;
    }
    let rounds_in = u64::from(round) + 1 - u64::from(t.surge_start_round);
    let scaled = u64::from(max_hp) * u64::from(t.surge_pct_per_round) * rounds_in / 100;
    Some(u16::try_from(scaled.max(1)).unwrap_or(u16::MAX))
}

/// Run the end-of-round upkeep in the fixed order above. A finished battle is a no-op (no
/// events). The KO sweep ending the battle, or the wild round cap, stops the upkeep there (no
/// expiry, no next round). Freeze thaw rolls come from the private stream (one draw per frozen
/// unit, initiative order).
pub fn run_upkeep(state: &mut TacticalState, t: &TacticsTuning) -> Vec<TacticalEvent> {
    if state.outcome != BattleOutcome::Ongoing {
        return Vec::new();
    }
    let snap = StepSnapshot::capture(state);
    let order = state.initiative.clone();
    let mut events = Vec::new();

    // 1. Status damage ticks, in this round's initiative order.
    for &id in &order {
        let Some(unit) = state.unit_mut(id) else {
            continue;
        };
        if !unit.is_conscious() {
            continue;
        }
        let Some(status) = unit.status else { continue };
        if let Some(amount) = status_tick_damage(&status, unit.max_hp()) {
            unit.cur_hp = unit.cur_hp.saturating_sub(amount);
            events.push(TacticalEvent::StatusTick {
                unit: id,
                status,
                amount,
            });
        }
    }

    // 2. Surge (PvP ruleset, round ≥ start): true damage to every living unit.
    if state.kind.uses_pvp_rules() {
        let round = state.round;
        for &id in &order {
            let Some(unit) = state.unit_mut(id) else {
                continue;
            };
            if !unit.is_conscious() {
                continue;
            }
            if let Some(amount) = surge_damage(unit.max_hp(), round, t) {
                unit.cur_hp = unit.cur_hp.saturating_sub(amount);
                events.push(TacticalEvent::Surge {
                    round,
                    unit: id,
                    amount,
                });
            }
        }
    }

    // 3. Reserved depth-wave slot (weather/field, terrain hazards): nothing in P1.

    // 4. KO sweep + battle-end check + adjudication — the one terminal-sweep site.
    events.extend(settle(state, &snap));
    if state.outcome != BattleOutcome::Ongoing {
        return events;
    }

    // 5. Status duration decrement / expiry through the carried `tick_status` (by value).
    for &id in &order {
        let Some(status) = state
            .unit(id)
            .filter(|u| u.is_conscious())
            .and_then(|u| u.status)
        else {
            continue;
        };
        let thaw_roll = match status {
            StatusEffect::Freeze => {
                let roll = (splitmix64(state.seed ^ state.action_seq) % 100) as u8;
                state.action_seq = state.action_seq.wrapping_add(1);
                roll
            }
            StatusEffect::Poison
            | StatusEffect::Burn
            | StatusEffect::Paralysis
            | StatusEffect::Sleep { .. } => 0,
        };
        let mut store = BattleStatusStore::new(1, 0);
        store.side_a[0] = Some(status);
        let variance = StatusVariance {
            action_skip_roll_a: 0,
            action_skip_roll_b: 0,
            freeze_thaw_roll_a: thaw_roll,
            freeze_thaw_roll_b: 0,
            sleep_wake_roll_a: 0,
            sleep_wake_roll_b: 0,
        };
        let _ = tick_status(&mut store, &variance);
        let after = store.side_a[0];
        if after != Some(status) {
            if let Some(unit) = state.unit_mut(id) {
                unit.status = after;
            }
            if after.is_none() {
                events.push(TacticalEvent::StatusCured { unit: id, status });
            }
        }
    }

    // 6. Round caps: a wild battle auto-flees at the cap.
    if state.kind == BattleKind::Wild && state.round >= t.wild_round_cap {
        events.push(end_battle(
            state,
            BattleOutcome::Fled,
            BattleEndHow::RoundCap,
        ));
        return events;
    }

    // 7. Next round: advance and rebuild the initiative.
    state.round = state.round.saturating_add(1);
    state.rebuild_initiative();
    events
}
