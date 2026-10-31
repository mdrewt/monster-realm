//! Outcome — design §6.4 adjudication, §2.2 battle-end check and the KO sweep (the one site for
//! every KO cause), plus the standing r2 double-KO ruling for wild battles.
//!
//! [`settle`] is the single "KO sweep + battle-end check + adjudication" site: `resolve_attack`
//! calls it after every attack, upkeep calls it at step 4, and bt-3's executor calls it after
//! every other resolved entry. When both sides empty in the same step, the PvP ruleset
//! adjudicates by the exact tuple (higher Σ cur_hp×100/max_hp at step START, more conscious units
//! at step START, more cumulative attack damage dealt, `splitmix64(seed ^ round) & 1`); a wild
//! battle follows ADR-0156 R5 as carried — fixed `[A, B]` evaluation, the first side found empty
//! loses — so the player side (A) loses a wild mutual wipe. `BattleOutcome` gains NO variant:
//! outcomes stay `SideAWins | SideBWins | Fled`.

use serde::{Deserialize, Serialize};

use crate::combat::types::BattleOutcome;

use super::geometry::Side;
use super::resolve::{side_index, splitmix64, TacticalEvent, TacticalState, UnitState};

/// The adjudication inputs frozen at the START of a resolution or upkeep step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepSnapshot {
    /// Per side (A = 0, B = 1): Σ over deployed (state Active) units of floor(cur_hp × 100 / max_hp).
    pub hp_pct: [u32; 2],
    /// Per side: conscious units.
    pub conscious: [u8; 2],
}

impl StepSnapshot {
    /// Capture the tuple inputs from `state` as it stands now.
    #[must_use]
    pub fn capture(state: &TacticalState) -> Self {
        let mut snap = StepSnapshot {
            hp_pct: [0, 0],
            conscious: [0, 0],
        };
        for unit in state.units.iter().filter(|u| u.state == UnitState::Active) {
            let idx = side_index(unit.side);
            let pct = (u32::from(unit.cur_hp) * 100)
                .checked_div(u32::from(unit.max_hp()))
                .unwrap_or(0);
            snap.hp_pct[idx] = snap.hp_pct[idx].saturating_add(pct);
            if unit.is_conscious() {
                snap.conscious[idx] = snap.conscious[idx].saturating_add(1);
            }
        }
        snap
    }
}

/// Which element of the adjudication tuple decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Adjudication {
    HpPercent,
    Conscious,
    DamageDealt,
    Coin,
}

/// How a battle ended (carried in `TacticalEvent::BattleEnd`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BattleEndHow {
    /// Exactly one side is empty.
    SideEmpty,
    /// Both sides emptied in one step under the PvP ruleset.
    Adjudicated(Adjudication),
    /// Both sides emptied in one step in a wild battle: the r2 fixed-order ruling.
    FixedOrder,
    /// The wild round cap auto-fled the battle.
    RoundCap,
}

/// Design §6.4: the exact tuple over the step-start `snap`, the match's cumulative attack damage
/// per side and the coin `splitmix64(seed ^ round) & 1` (0 → A, 1 → B). Never anything but a side.
#[must_use]
pub fn adjudicate(
    snap: &StepSnapshot,
    attack_damage_dealt: [u32; 2],
    seed: u64,
    round: u16,
) -> (Side, Adjudication) {
    let higher = |a: u32, b: u32| if a > b { Side::A } else { Side::B };
    if snap.hp_pct[0] != snap.hp_pct[1] {
        return (
            higher(snap.hp_pct[0], snap.hp_pct[1]),
            Adjudication::HpPercent,
        );
    }
    if snap.conscious[0] != snap.conscious[1] {
        return (
            higher(u32::from(snap.conscious[0]), u32::from(snap.conscious[1])),
            Adjudication::Conscious,
        );
    }
    if attack_damage_dealt[0] != attack_damage_dealt[1] {
        return (
            higher(attack_damage_dealt[0], attack_damage_dealt[1]),
            Adjudication::DamageDealt,
        );
    }
    let coin = if splitmix64(seed ^ u64::from(round)) & 1 == 0 {
        Side::A
    } else {
        Side::B
    };
    (coin, Adjudication::Coin)
}

/// The KO sweep, once for every cause: each unit with `state == Active` and `cur_hp == 0` (in the
/// canonical `units` order) becomes `Fainted`, leaves the initiative (and the queued ids), and
/// emits `Ko` then `QueueVoided` iff it held a READY plan.
pub fn sweep_kos(state: &mut TacticalState) -> Vec<TacticalEvent> {
    let fallen: Vec<u32> = state
        .units
        .iter()
        .filter(|u| u.state == UnitState::Active && u.cur_hp == 0)
        .map(|u| u.id)
        .collect();
    let mut events = Vec::new();
    for id in fallen {
        if let Some(unit) = state.unit_mut(id) {
            unit.state = UnitState::Fainted;
        }
        let was_queued = state.queued.contains(&id);
        state.remove_from_initiative(id);
        events.push(TacticalEvent::Ko { unit: id });
        if was_queued {
            events.push(TacticalEvent::QueueVoided { unit: id });
        }
    }
    events
}

/// The battle-end check. `None` while both sides have a conscious unit; one side empty → the
/// other wins (`SideEmpty`); both empty → PvP ruleset: `adjudicate` (`Adjudicated`), wild: the
/// r2 ruling (`SideBWins`, `FixedOrder`). Pure.
#[must_use]
pub fn check_battle_end(
    state: &TacticalState,
    snap: &StepSnapshot,
) -> Option<(BattleOutcome, BattleEndHow)> {
    let alive = |side: Side| {
        state
            .units
            .iter()
            .any(|u| u.side == side && u.is_conscious())
    };
    match (alive(Side::A), alive(Side::B)) {
        (true, true) => None,
        (true, false) => Some((BattleOutcome::SideAWins, BattleEndHow::SideEmpty)),
        (false, true) => Some((BattleOutcome::SideBWins, BattleEndHow::SideEmpty)),
        (false, false) => {
            if state.kind.uses_pvp_rules() {
                let (winner, why) =
                    adjudicate(snap, state.attack_damage_dealt, state.seed, state.round);
                Some((winner_outcome(winner), BattleEndHow::Adjudicated(why)))
            } else {
                Some((BattleOutcome::SideBWins, BattleEndHow::FixedOrder))
            }
        }
    }
}

/// Record a decided outcome (a decided battle is never overwritten) and return the event.
pub fn end_battle(
    state: &mut TacticalState,
    outcome: BattleOutcome,
    how: BattleEndHow,
) -> TacticalEvent {
    if state.outcome == BattleOutcome::Ongoing {
        state.outcome = outcome;
    }
    TacticalEvent::BattleEnd {
        outcome: state.outcome,
        how,
    }
}

/// The ONE terminal-sweep site: [`sweep_kos`], then [`check_battle_end`] against `snap`, then
/// [`end_battle`] when it decides. Returns the events in that order.
pub fn settle(state: &mut TacticalState, snap: &StepSnapshot) -> Vec<TacticalEvent> {
    let mut events = sweep_kos(state);
    if state.outcome == BattleOutcome::Ongoing {
        if let Some((outcome, how)) = check_battle_end(state, snap) {
            events.push(end_battle(state, outcome, how));
        }
    }
    events
}

/// `Side::A → SideAWins`, `Side::B → SideBWins`.
fn winner_outcome(side: Side) -> BattleOutcome {
    match side {
        Side::A => BattleOutcome::SideAWins,
        Side::B => BattleOutcome::SideBWins,
    }
}
