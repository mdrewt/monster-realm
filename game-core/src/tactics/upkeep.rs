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

use crate::combat::types::StatusEffect;

use super::resolve::{TacticalEvent, TacticalState};
use super::tuning::TacticsTuning;

/// Carried M14 damage per tick: Poison `max_hp / 8`, Burn `max_hp / 16`, both min 1; every other
/// status (and no status) ticks nothing.
#[must_use]
pub fn status_tick_damage(status: &StatusEffect, max_hp: u16) -> Option<u16> {
    let _ = (status, max_hp);
    todo!("bt-2 upkeep: status_tick_damage")
}

/// Surge damage for a unit of `max_hp` at `round`: `None` below `surge_start_round`, else
/// `max(1, max_hp × surge_pct_per_round × (round + 1 − surge_start_round) / 100)` — at the
/// design's numbers `max_hp × 5 × (r − 8) / 100`, floor. u64 intermediates, saturating to
/// `u16::MAX`.
#[must_use]
pub fn surge_damage(max_hp: u16, round: u16, t: &TacticsTuning) -> Option<u16> {
    let _ = (max_hp, round, t);
    todo!("bt-2 upkeep: surge_damage")
}

/// Run the end-of-round upkeep in the fixed order above. A finished battle is a no-op (no
/// events). The KO sweep ending the battle, or the wild round cap, stops the upkeep there (no
/// expiry, no next round). Freeze thaw rolls come from the private stream (one draw per frozen
/// unit, initiative order).
pub fn run_upkeep(state: &mut TacticalState, t: &TacticsTuning) -> Vec<TacticalEvent> {
    let _ = (state, t);
    todo!("bt-2 upkeep: run_upkeep")
}
