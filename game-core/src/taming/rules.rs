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

    // Checked sum: a zone with enough max-weight entries could overflow u32.
    // On overflow, treat the table as unselectable (None) rather than panic
    // (debug) or silently wrap (release) into a wrong species pick.
    let total_weight: u32 = eligible
        .iter()
        .try_fold(0u32, |acc, e| acc.checked_add(u32::from(e.weight)))?;
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

/// The species-agnostic baseline recruit rate (per-mille), applied before any
/// bait or missing-HP bonus. At full HP with no bait this is the only term, so
/// weakening — not luck — remains the primary lever (`MISSING_HP_FACTOR`
/// dominates). Tunable; per-species base rates are an M9 follow-up.
pub const RECRUIT_BASE_RATE: u16 = 80;

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
    debug_assert!(
        base_rate <= 1000 && bait_bonus <= 1000,
        "recruit_chance: base_rate ({base_rate}) and bait_bonus ({bait_bonus}) must each be <= 1000 (per-mille)"
    );
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

#[cfg(test)]
mod m8_7c_tests {
    use super::*;
    use crate::taming::types::{EncounterEntry, EncounterTable};

    /// Helper: construct a Level(1) without repeating the expect string.
    fn lvl1() -> Level {
        Level::new(1).expect("level 1 valid")
    }

    // -----------------------------------------------------------------------
    // T1 — EARS criterion: "WHEN roll_encounter sums entry weights THE SYSTEM
    //      SHALL NOT overflow u32 (checked/saturating fold returning None)."
    //
    // Kills: an impl that calls `.sum::<u32>()` (or equivalent unchecked fold)
    // on the eligible weights. In debug mode the unchecked sum panics (test
    // fails for wrong reason — panic, not assertion); in release mode the sum
    // wraps to a value < 4,295,032,830, `total_weight` ends up small, and
    // `roll % total_weight` selects a garbage entry → `Some(wrong_id)`.
    // Both failure modes are caught: panic collapses the test; a wrapped Some
    // is != None and the assert fires.
    //
    // Arithmetic: 65538 × 65535 = 4,295,032,830 > u32::MAX (4,294,967,295)
    // → the u32 sum overflows.
    // -----------------------------------------------------------------------

    /// EARS C (M8.7c): total_weight overflow → None, not a wrapped/garbage species.
    /// Kills: any roll_encounter that uses `.sum::<u32>()` without overflow checking.
    #[test]
    fn roll_encounter_overflow_weight_sum_returns_none() {
        // 65538 eligible entries, each weight = u16::MAX (65535), same level band.
        // 65538 × 65535 = 4,295,032,830 which exceeds u32::MAX (4,294,967,295).
        let entries: Vec<EncounterEntry> = (0u32..65538)
            .map(|i| EncounterEntry {
                species_id: i,
                weight: u16::MAX,
                min_level: lvl1(),
                max_level: lvl1(),
            })
            .collect();

        let table = EncounterTable {
            zone_id: 99,
            encounter_rate: 1000,
            entries,
        };

        // roll=0 is deterministic; any roll works since all weights are u16::MAX.
        // A correct checked fold detects the overflow and returns None.
        // An unchecked .sum() panics in debug or wraps+selects a wrong species in
        // release — the assert below catches the release-mode wrong-Some case.
        assert_eq!(
            roll_encounter(&table, 0, lvl1()),
            None,
            "TEETH: weight sum overflowing u32 must yield None, not a wrapped/garbage species"
        );
    }

    // -----------------------------------------------------------------------
    // T4 — EARS criterion: same as T1, but the boundary case where the sum is
    //      EXACTLY u32::MAX (no overflow). The correct checked fold MUST still
    //      proceed and select a species (non-regression: the fix must not be
    //      over-aggressive and return None for every large table).
    //
    // Arithmetic: 65537 × 65535 = 4,294,967,295 = u32::MAX (exact, no overflow).
    // A correct checked_add-based fold yields Some(u32::MAX) as total_weight
    // and continues normally.
    // -----------------------------------------------------------------------

    /// EARS C (M8.7c): exact-max weight sum (u32::MAX) must still select a species.
    /// Kills: an over-aggressive fix that returns None whenever total_weight is
    /// "large" rather than only when it genuinely overflows.
    #[test]
    fn roll_encounter_exact_max_weight_sum_returns_some() {
        // 65537 entries × 65535 weight = 4,294,967,295 = u32::MAX exactly.
        // A correct checked fold returns Some(u32::MAX) for the total and proceeds.
        let entries: Vec<EncounterEntry> = (0u32..65537)
            .map(|i| EncounterEntry {
                species_id: i,
                weight: u16::MAX,
                min_level: lvl1(),
                max_level: lvl1(),
            })
            .collect();

        let table = EncounterTable {
            zone_id: 98,
            encounter_rate: 1000,
            entries,
        };

        // roll=0 is deterministic; total_weight = u32::MAX, target = 0 % u32::MAX = 0,
        // so the first entry (species_id=0) is selected. Assert the exact species
        // (stronger than is_some): kills both a false-None and a wrong-Some mutant.
        assert_eq!(
            roll_encounter(&table, 0, lvl1()),
            Some(0),
            "weight sum == u32::MAX (no overflow) must still select the first species"
        );
    }

    // -----------------------------------------------------------------------
    // T2 — EARS criterion: "THE recruit_chance pure fn SHALL debug_assert!(
    //      base_rate <= 1000 && bait_bonus <= 1000, …)"
    //
    // Kills: any recruit_chance that silently clamps or ignores out-of-range
    // base_rate (e.g. just passes 1001 through the min(1000, …) cap without
    // asserting). The assert must fire specifically on base_rate=1001.
    //
    // This test is debug-only (`#[cfg(debug_assertions)]`) because debug_assert!
    // compiles out in release — the contract is a dev-time fail-loud, not a
    // release panic. This mirrors attempt_recruit's existing debug_assert style.
    // -----------------------------------------------------------------------

    /// EARS C (M8.7c): recruit_chance must debug_assert base_rate <= 1000.
    /// Kills: any impl that accepts base_rate=1001 without a panic in debug mode.
    #[cfg(debug_assertions)]
    #[test]
    #[should_panic(expected = "recruit_chance")]
    fn recruit_chance_panics_on_out_of_range_base_rate() {
        // base_rate=1001 exceeds per-mille range; the impl must assert and panic.
        // The expected string "recruit_chance" must appear in the panic message.
        let _ = recruit_chance(100, 100, 1001, 0);
    }

    // -----------------------------------------------------------------------
    // T3 — EARS criterion: same as T2, but independently for bait_bonus=1001.
    //      Forces the impl to assert BOTH conditions independently, not just
    //      short-circuit on base_rate alone.
    //
    // Kills: an impl that only asserts base_rate (or uses a combined assert
    // where base_rate=0 passes and bait_bonus=1001 slips through).
    // -----------------------------------------------------------------------

    /// EARS C (M8.7c): recruit_chance must debug_assert bait_bonus <= 1000.
    /// Kills: any impl that only asserts base_rate and ignores bait_bonus.
    #[cfg(debug_assertions)]
    #[test]
    #[should_panic(expected = "recruit_chance")]
    fn recruit_chance_panics_on_out_of_range_bait_bonus() {
        // bait_bonus=1001 exceeds per-mille range; base_rate=0 is valid.
        // The impl must still assert and panic — this arm is independent of T2.
        let _ = recruit_chance(100, 100, 0, 1001);
    }
}
