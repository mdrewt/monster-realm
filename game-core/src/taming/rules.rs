//! Taming rule functions — encounter triggering, weighted species selection,
//! and recruit-chance arithmetic. All pure and deterministic (ADR-0003).
//!
//! STUBS: every function returns a wrong value or panics.
//! The test suite is RED until the implementer fills these in.

use crate::monster::types::Level;

use super::types::EncounterTable;

/// Returns `true` if a step triggers a wild encounter.
///
/// Formula: `roll % 1000 < threshold`.
///
/// STUB: always returns `false`.
#[must_use]
pub fn encounter_triggers(_roll: u32, _threshold: u16) -> bool {
    false // STUB — always false, tests will catch this
}

/// Select the `species_id` to spawn from `table` given a raw `roll` and the
/// player's current `player_level`.
///
/// Only entries whose `min_level <= player_level <= max_level` are eligible.
/// Among eligible entries the selection is weighted by `entry.weight`; the
/// roll selects within `sum(eligible weights)`.
///
/// Returns `None` if no eligible entries exist.
///
/// STUB: always returns `None`.
#[must_use]
pub fn roll_encounter(_table: &EncounterTable, _roll: u32, _player_level: Level) -> Option<u32> {
    None // STUB — always None, tests will catch this
}

/// The per-mille bonus applied per unit of missing-HP fraction.
///
/// Formula contribution: `(max_hp - current_hp) * MISSING_HP_FACTOR / max_hp`
pub const MISSING_HP_FACTOR: u32 = 500;

/// Compute the per-mille recruit chance.
///
/// Formula: `min(1000, base_rate + bait_bonus + (max_hp - current_hp) * MISSING_HP_FACTOR / max_hp)`
///
/// Guards:
/// - `max_hp == 0` → no missing-HP bonus (returns `min(1000, base_rate + bait_bonus)`)
/// - `current_hp > max_hp` → treat as full HP (same as `current_hp == max_hp`)
///
/// STUB: always returns `0`.
#[must_use]
pub fn recruit_chance(_max_hp: u16, _current_hp: u16, _base_rate: u16, _bait_bonus: u16) -> u16 {
    0 // STUB — always 0, tests will catch this
}

/// Returns `true` if the recruit attempt succeeds.
///
/// Formula: `roll % 1000 < chance`.
///
/// STUB: always returns `false`.
#[must_use]
pub fn attempt_recruit(_chance: u16, _roll: u32) -> bool {
    false // STUB — always false, tests will catch this
}
