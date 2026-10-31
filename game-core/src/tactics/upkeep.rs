//! End-of-round upkeep — design §2.2 "End-of-round upkeep", in the fixed order
//! [`UPKEEP_ORDER`]: status damage ticks (in this round's initiative order) → PvP Surge
//! (`round ≥ surge_start_round`) → the reserved depth-wave slot (weather/field, hazards: a no-op
//! until D2) → KO sweep + battle-end check + adjudication → status duration decrement/expiry →
//! round caps (wild `round == wild_round_cap` → auto-flee) → `round += 1` and rebuild initiative.
//!
//! Surge is TRUE damage: it bypasses Guard and First-Stand (never touches the attack pipeline),
//! which is what makes every PvP match terminate by round 14 (105 % cumulative, §6.4). Wild
//! battles never Surge. Status values are the carried M14 numbers (Poison max_hp/8, Burn
//! max_hp/16, both min 1; Sleep 3 turns counting down; Freeze thaws on a roll ≥ 80) — the carried
//! functions in `combat::status` are private, so they are re-stated here and pinned equal to the
//! carried PUBLIC `apply_post_turn_effects` by an executing test; bt-17 retires the 1v1 copy.

use serde::{Deserialize, Serialize};

use crate::combat::types::StatusEffect;

use super::resolve::{BattleKind, TacticalEvent, TacticalState};
use super::tuning::TacticsTuning;

/// The upkeep steps. `run_upkeep` iterates [`UPKEEP_ORDER`] with an exhaustive match.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UpkeepStep {
    StatusTicks,
    Surge,
    DepthWave,
    KoSweep,
    StatusExpiry,
    RoundCaps,
    NextRound,
}

/// Design §2.2's fixed order.
pub const UPKEEP_ORDER: [UpkeepStep; 7] = [
    UpkeepStep::StatusTicks,
    UpkeepStep::Surge,
    UpkeepStep::DepthWave,
    UpkeepStep::KoSweep,
    UpkeepStep::StatusExpiry,
    UpkeepStep::RoundCaps,
    UpkeepStep::NextRound,
];

/// The Freeze thaw threshold (carried M14: thaws when the roll ≥ 80 of 100).
pub const FREEZE_THAW_ROLL: u8 = 80;

/// Carried M14 damage per tick: Poison `max_hp / 8`, Burn `max_hp / 16`, both min 1; every other
/// status (and no status) ticks nothing.
#[must_use]
pub fn status_tick_damage(status: &StatusEffect, max_hp: u16) -> Option<u16> {
    let _ = (status, max_hp);
    todo!("bt-2 upkeep: status_tick_damage")
}

/// Which battle kinds Surge: the PvP ruleset (Pvp, Practice). Wild never.
#[must_use]
pub fn surges(kind: BattleKind) -> bool {
    let _ = kind;
    todo!("bt-2 upkeep: surges")
}

/// Surge damage for a unit of `max_hp` at `round`: `None` below `surge_start_round`, else
/// `max(1, max_hp × surge_pct_per_round × (round + 1 − surge_start_round) / 100)` — at the
/// design's numbers `max_hp × 5 × (r − 8) / 100`.
#[must_use]
pub fn surge_damage(max_hp: u16, round: u16, t: &TacticsTuning) -> Option<u16> {
    let _ = (max_hp, round, t);
    todo!("bt-2 upkeep: surge_damage")
}

/// Run the end-of-round upkeep in [`UPKEEP_ORDER`]. A finished battle is a no-op (no events).
/// The KO sweep ending the battle, or the wild round cap, stops the upkeep there (no expiry, no
/// next round).
pub fn run_upkeep(state: &mut TacticalState, t: &TacticsTuning) -> Vec<TacticalEvent> {
    let _ = (state, t);
    todo!("bt-2 upkeep: run_upkeep")
}
