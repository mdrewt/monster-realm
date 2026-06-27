//! Taming rule functions — encounter triggering, weighted species selection,
//! and recruit-chance arithmetic. All pure and deterministic (ADR-0003).
//!
//! Probabilities use **per-mille** (0–1000) integer arithmetic — no floats.
//! Roll values are injected parameters (the server passes `ctx.random()`);
//! nothing here touches a clock or RNG source.

use crate::monster::types::Level;

use super::types::{EncounterTable, WildSpawn};

/// Splitmix32-style mixing function (same algorithm as `monster::rolls::splitmix32`
/// and `lib::tick_seed`). Used to split ONE encounter seed into independent
/// sub-rolls so a hit/miss outcome never shifts a later draw.
fn splitmix32(state: &mut u32) -> u32 {
    *state = state.wrapping_add(0x9E37_79B9);
    let mut z = *state;
    z = (z ^ (z >> 16)).wrapping_mul(0x85EB_CA6B);
    z = (z ^ (z >> 13)).wrapping_mul(0xC2B2_AE35);
    z ^ (z >> 16)
}

/// Returns `true` if a step triggers a wild encounter.
///
/// `threshold` is per-mille: 0 = never, 1000 = always.
/// `roll` is a raw u32 from the injected RNG.
///
/// Formula: `roll % 1000 < threshold`.
/// Note: modulo 1000 introduces ~0.007% per-bucket bias on a u32 input —
/// acceptable for a game probability gate.
#[must_use]
pub fn encounter_triggers(roll: u32, threshold: u16) -> bool {
    roll % 1000 < u32::from(threshold)
}

/// Select the `species_id` to spawn from `table` given a raw `roll` and the
/// player's current `player_level`.
///
/// Only entries whose `min_level <= player_level <= max_level` are eligible.
/// Among eligible entries the selection is weighted by `entry.weight`; the
/// roll selects within `sum(eligible weights)`.
///
/// Returns `None` if no eligible entries exist (empty table or all filtered).
#[must_use]
pub fn roll_encounter(table: &EncounterTable, roll: u32, player_level: Level) -> Option<u32> {
    let pl = player_level.as_u8();

    // Collect eligible entries (level-range filter)
    let eligible: Vec<_> = table
        .entries
        .iter()
        .filter(|e| pl >= e.min_level.as_u8() && pl <= e.max_level.as_u8())
        .collect();

    let total_weight: u32 = eligible.iter().map(|e| u32::from(e.weight)).sum();
    if total_weight == 0 {
        return None;
    }

    let mut target = roll % total_weight;
    for entry in &eligible {
        let w = u32::from(entry.weight);
        if target < w {
            return Some(entry.species_id);
        }
        target -= w;
    }

    // Unreachable if weights are positive and total_weight > 0,
    // but return the last eligible entry as a safe fallback.
    eligible.last().map(|e| e.species_id)
}

/// Resolve a grass step into a wild spawn — the SINGLE place an encounter seed is
/// split. Pure, total, deterministic. Composes the existing `encounter_triggers`
/// (cheap-roll-first gate) + `roll_encounter` (weighted, level-ranged species
/// pick), then picks a level within the chosen entry's band.
///
/// The ONE `seed` is splitmix-derived into `(trigger_roll, species_roll,
/// level_roll, individuality_seed)`:
/// - `!encounter_triggers(trigger_roll, table.encounter_rate)` → `None` (rate-0 is
///   always `None`).
/// - `roll_encounter(table, species_roll, player_level)` → `None` if no eligible
///   species (e.g. player out of every band) propagates as `None`.
/// - The spawned `level` lies within the chosen entry's `[min_level, max_level]`.
/// - `individuality_seed` is a fixed sub-roll of the INPUT seed, independent of the
///   species/level outcome (M8d "rebuild THAT exact wild" contract).
#[must_use]
pub fn resolve_encounter(
    table: &EncounterTable,
    seed: u32,
    player_level: Level,
) -> Option<WildSpawn> {
    let mut state = seed;
    let trigger_roll = splitmix32(&mut state);
    let species_roll = splitmix32(&mut state);
    let level_roll = splitmix32(&mut state);
    let individuality_seed = splitmix32(&mut state);

    if !encounter_triggers(trigger_roll, table.encounter_rate) {
        return None;
    }

    let species_id = roll_encounter(table, species_roll, player_level)?;

    // Find the chosen entry for its level band (species_id is unique per zone,
    // ADR-0044 B1).
    let entry = table.entries.iter().find(|e| e.species_id == species_id)?;
    let lo = entry.min_level.as_u8();
    let hi = entry.max_level.as_u8();
    // Inclusive band pick. `hi >= lo` for any valid entry (Level::new ordering is
    // not enforced here, so guard the span to avoid a modulo-by-zero / underflow).
    let span = u32::from(hi.saturating_sub(lo)) + 1;
    let level_u8 = lo.saturating_add((level_roll % span) as u8);
    let level = Level::new(level_u8).ok()?;

    Some(WildSpawn {
        species_id,
        level,
        individuality_seed,
    })
}

/// The per-mille bonus applied per unit of missing-HP fraction.
///
/// At 0 HP the full factor (500 per-mille = 50 percentage points) is added
/// on top of the species' base recruit rate. This makes weakening — not luck
/// — the primary lever for recruiting.
pub const MISSING_HP_FACTOR: u32 = 500;

/// Compute the per-mille recruit chance.
///
/// Formula (all integer, u32 intermediates):
/// ```text
/// hp_bonus = (max_hp - current_hp) * MISSING_HP_FACTOR / max_hp
/// result   = min(1000, base_rate + bait_bonus + hp_bonus)
/// ```
///
/// Guards:
/// - `max_hp == 0` → skip the HP fraction (avoids divide-by-zero)
/// - `current_hp > max_hp` → treat as full HP (no missing-HP bonus)
/// - All arithmetic widened to `u32` before any operation to prevent overflow
/// - Result capped at 1000 (certainty)
#[must_use]
pub fn recruit_chance(max_hp: u16, current_hp: u16, base_rate: u16, bait_bonus: u16) -> u16 {
    let base = u32::from(base_rate);
    let bait = u32::from(bait_bonus);

    let hp_bonus = if max_hp == 0 || current_hp >= max_hp {
        0u32
    } else {
        let missing = u32::from(max_hp - current_hp);
        missing * MISSING_HP_FACTOR / u32::from(max_hp)
    };

    let total = base + bait + hp_bonus;
    total.min(1000) as u16
}

/// Returns `true` if the recruit attempt succeeds.
///
/// Formula: `roll % 1000 < chance`.
///
/// `chance` should be the output of [`recruit_chance`] (capped at 1000).
/// Values above 1000 always succeed (by arithmetic identity).
#[must_use]
pub fn attempt_recruit(chance: u16, roll: u32) -> bool {
    debug_assert!(chance <= 1000, "chance should be <= 1000; got {chance}");
    roll % 1000 < u32::from(chance)
}
