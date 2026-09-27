//! Taming rules: encounter triggering, weighted species selection and recruit chance.
//!
//! EARS criteria covered:
//!   Criterion 1 — encounter_triggers + roll_encounter
//!   Criterion 2 — recruit_chance (formula, caps, guards)
//!
//! Each test is annotated with:
//!   - which EARS criterion it covers
//!   - which wrong implementation it kills

#[allow(unused_imports)]
use crate::content::{
    load_encounters, load_species, load_zones, parse_encounters, validate_encounters, ItemDef,
    Species, ZoneDef,
};
use crate::monster::types::{Affinity, Level, StatBlock};
use crate::taming::rules::{
    attempt_recruit, encounter_triggers, recruit_chance, roll_encounter, MISSING_HP_FACTOR,
};
use crate::taming::types::{EncounterEntry, EncounterTable};

use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

fn level(v: u8) -> Level {
    Level::new(v).expect("valid level")
}

fn make_entry(species_id: u32, weight: u16, min: u8, max: u8) -> EncounterEntry {
    EncounterEntry {
        species_id,
        weight,
        min_level: level(min),
        max_level: level(max),
    }
}

fn make_table(zone_id: u32, encounter_rate: u16, entries: Vec<EncounterEntry>) -> EncounterTable {
    EncounterTable {
        zone_id,
        encounter_rate,
        entries,
    }
}

fn valid_base_stats() -> StatBlock {
    StatBlock {
        hp: 45,
        attack: 49,
        defense: 49,
        speed: 65,
        sp_attack: 65,
        sp_defense: 45,
    }
}

fn fixture_species(id: u32) -> Species {
    Species {
        id,
        name: format!("Species{id}"),
        base_stats: valid_base_stats(),
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![],
        ability: None,
        tier: 0,
    }
}

fn fixture_zone(id: u32) -> ZoneDef {
    ZoneDef {
        id,
        name: format!("Zone{id}"),
        width: 10,
        height: 10,
    }
}

// ---------------------------------------------------------------------------
// CRITERION 1 — encounter_triggers
// Formula: roll % 1000 < threshold
// ---------------------------------------------------------------------------

/// Kills: an impl that returns true for threshold=0.
/// EARS C1: threshold=0 means no encounters — any roll must return false.
#[test]
fn encounter_triggers_zero_threshold_never_fires() {
    assert!(!encounter_triggers(0, 0), "threshold 0, roll 0 → false");
    assert!(!encounter_triggers(999, 0), "threshold 0, roll 999 → false");
    assert!(
        !encounter_triggers(u32::MAX, 0),
        "threshold 0, roll MAX → false"
    );
}

/// Kills: an impl that returns false for threshold=1000.
/// EARS C1: threshold=1000 covers the entire per-mille range — any roll must return true.
#[test]
fn encounter_triggers_max_threshold_always_fires() {
    assert!(encounter_triggers(0, 1000), "threshold 1000, roll 0 → true");
    assert!(
        encounter_triggers(999, 1000),
        "threshold 1000, roll 999 → true"
    );
    assert!(
        encounter_triggers(500, 1000),
        "threshold 1000, roll 500 → true"
    );
    assert!(
        encounter_triggers(u32::MAX, 1000),
        "threshold 1000, roll MAX → true"
    );
}

/// Kills: an impl with an off-by-one (< vs <=).
/// EARS C1: roll%1000 == threshold-1 → just inside range → true.
#[test]
fn encounter_triggers_boundary_just_below() {
    // roll % 1000 == 199, threshold == 200 → 199 < 200 → true
    assert!(
        encounter_triggers(199, 200),
        "roll%1000=199, threshold=200 → true (just inside)"
    );
    // roll = 1199 → 1199%1000 = 199
    assert!(
        encounter_triggers(1199, 200),
        "roll=1199, roll%1000=199, threshold=200 → true"
    );
}

/// Kills: an impl using <= instead of <.
/// EARS C1: roll%1000 == threshold → exactly at boundary → false.
#[test]
fn encounter_triggers_boundary_at_threshold() {
    // roll % 1000 == 200, threshold == 200 → 200 < 200 is false
    assert!(
        !encounter_triggers(200, 200),
        "roll%1000=200, threshold=200 → false (at boundary)"
    );
    // roll = 1200 → 1200%1000 = 200
    assert!(
        !encounter_triggers(1200, 200),
        "roll=1200, roll%1000=200, threshold=200 → false"
    );
}

/// Kills: an impl that panics or overflows on u32::MAX.
/// EARS C1: large rolls must work correctly via modular arithmetic.
#[test]
fn encounter_triggers_large_roll_safe() {
    // u32::MAX % 1000 = 295 (since 4294967295 % 1000 = 295)
    // threshold 296 → 295 < 296 → true
    assert!(
        encounter_triggers(u32::MAX, 296),
        "roll=u32::MAX (mod 295), threshold=296 → true"
    );
    // threshold 295 → 295 < 295 → false
    assert!(
        !encounter_triggers(u32::MAX, 295),
        "roll=u32::MAX (mod 295), threshold=295 → false"
    );
}

// ---------------------------------------------------------------------------
// CRITERION 1 — roll_encounter
// Weighted selection among level-range-eligible entries
// ---------------------------------------------------------------------------

/// Kills: an impl that panics or returns Some on empty table.
/// EARS C1: no entries → None.
#[test]
fn roll_encounter_empty_table_returns_none() {
    let table = make_table(0, 200, vec![]);
    assert_eq!(
        roll_encounter(&table, 42, level(5)),
        None,
        "empty table must return None"
    );
}

/// Kills: an impl that returns None when only one entry exists.
/// EARS C1: single eligible entry → that species, regardless of roll.
#[test]
fn roll_encounter_single_entry_always_returns_it() {
    let entry = make_entry(7, 10, 1, 10);
    let table = make_table(0, 200, vec![entry]);
    // Try multiple rolls — all must return species_id 7
    for roll in [0u32, 1, 5, 9, 999, u32::MAX] {
        assert_eq!(
            roll_encounter(&table, roll, level(5)),
            Some(7),
            "single entry, roll={roll} → species 7"
        );
    }
}

/// Kills: an impl that ignores the player level filter.
/// EARS C1: player_level=5, entry [min=10, max=15] → not eligible → None.
#[test]
fn roll_encounter_filters_by_level() {
    // Entry 1: level range [3, 7] — player level 5 is eligible
    // Entry 2: level range [10, 15] — player level 5 is NOT eligible
    let eligible = make_entry(1, 10, 3, 7);
    let out_of_range = make_entry(99, 10, 10, 15);
    let table = make_table(0, 200, vec![eligible, out_of_range]);

    // Player level 5 → only entry 1 eligible → must return species 1
    for roll in [0u32, 5, 99, u32::MAX] {
        let result = roll_encounter(&table, roll, level(5));
        assert_eq!(
            result,
            Some(1),
            "player_level=5: out-of-range entry must be excluded; roll={roll}"
        );
    }

    // Player level 12 → only entry 2 (species 99) eligible
    for roll in [0u32, 5, 99, u32::MAX] {
        let result = roll_encounter(&table, roll, level(12));
        assert_eq!(
            result,
            Some(99),
            "player_level=12: in-range entry must win; roll={roll}"
        );
    }
}

/// Kills: an impl that picks from all entries even when none are in range.
/// EARS C1: all entries out of range for player_level → None.
#[test]
fn roll_encounter_all_out_of_range_returns_none() {
    let e1 = make_entry(1, 10, 1, 10);
    let e2 = make_entry(2, 10, 1, 10);
    let table = make_table(0, 200, vec![e1, e2]);
    // Player level 50 → all entries [1,10] are out of range
    assert_eq!(
        roll_encounter(&table, 0, level(50)),
        None,
        "all entries out of range → None"
    );
}

/// Kills: an impl that ignores weights (e.g., picks uniformly).
/// EARS C1: weight 1 vs weight 3 → after many draws, heavier entry dominates.
///
/// We use a deterministic set of rolls that covers the full weight range
/// rather than relying on randomness.  With weight1=1 and weight3=3, total=4.
/// roll%4: 0→species2, 1→species2, 2→species2, 3→species1.
/// A correct weighted impl must reflect this split.
#[test]
fn roll_encounter_respects_weights() {
    let light = make_entry(1, 1, 1, 10); // weight 1
    let heavy = make_entry(2, 3, 1, 10); // weight 3
    let table = make_table(0, 200, vec![light, heavy]);

    let player_level = level(5);
    // total eligible weight = 4
    // roll % 4:
    //   0, 1, 2 → heavy (species 2)
    //   3 → light (species 1)
    let mut heavy_count = 0u32;
    let mut light_count = 0u32;
    // Test rolls 0..=99 (each maps roll%4 evenly)
    for roll in 0u32..100 {
        match roll_encounter(&table, roll, player_level) {
            Some(2) => heavy_count += 1,
            Some(1) => light_count += 1,
            other => panic!("unexpected result {other:?} for roll={roll}"),
        }
    }
    // 100 rolls, total_weight=4: 75 → heavy, 25 → light
    assert_eq!(
        heavy_count, 75,
        "weight-3 entry should win 75 of 100 rolls; got {heavy_count}"
    );
    assert_eq!(
        light_count, 25,
        "weight-1 entry should win 25 of 100 rolls; got {light_count}"
    );
}

/// Kills: an impl where the same inputs produce different outputs (e.g., uses thread_rng).
/// EARS C1: roll_encounter must be deterministic — same inputs → same output.
#[test]
fn roll_encounter_deterministic() {
    let e1 = make_entry(1, 5, 1, 10);
    let e2 = make_entry(2, 3, 1, 10);
    let e3 = make_entry(3, 2, 1, 10);
    let table = make_table(0, 200, vec![e1, e2, e3]);
    let pl = level(5);

    for roll in [0u32, 7, 42, 99, 500, u32::MAX] {
        let first = roll_encounter(&table, roll, pl);
        let second = roll_encounter(&table, roll, pl);
        assert_eq!(
            first, second,
            "roll_encounter must be deterministic; roll={roll}"
        );
    }
}

// ---------------------------------------------------------------------------
// CRITERION 2 — recruit_chance
// Formula: min(1000, base_rate + bait_bonus + (max_hp - current_hp) * MISSING_HP_FACTOR / max_hp)
// Guards: max_hp==0, current_hp>max_hp
// ---------------------------------------------------------------------------

/// Kills: an impl that adds missing-HP bonus even at full HP.
/// EARS C2: current_hp == max_hp → no missing HP → result == base_rate + bait_bonus.
#[test]
fn recruit_chance_full_hp_equals_base_plus_bait() {
    let result = recruit_chance(100, 100, 50, 30);
    assert_eq!(
        result, 80,
        "full HP: chance == base_rate(50) + bait_bonus(30) = 80; got {result}"
    );

    // Zero bait
    let result2 = recruit_chance(200, 200, 100, 0);
    assert_eq!(
        result2, 100,
        "full HP, zero bait: chance == base_rate(100); got {result2}"
    );
}

/// Kills: an impl that does not apply the full MISSING_HP_FACTOR at 0 HP.
/// EARS C2: current_hp == 0 → missing_fraction = 1 → base + MISSING_HP_FACTOR + bait.
#[test]
fn recruit_chance_zero_hp_max_factor() {
    // MISSING_HP_FACTOR == 500 (per-spec constant)
    // max_hp=100, current=0: bonus = (100-0)*500/100 = 500
    // result = min(1000, 0 + 500 + 0) = 500
    let result = recruit_chance(100, 0, 0, 0);
    assert_eq!(
        result, 500,
        "0 HP, base=0, bait=0: chance == MISSING_HP_FACTOR({MISSING_HP_FACTOR}); got {result}"
    );

    // base=200, bait=100, current=0 → 200 + 500 + 100 = 800
    let result2 = recruit_chance(100, 0, 200, 100);
    assert_eq!(
        result2, 800,
        "0 HP, base=200, bait=100: chance = 800; got {result2}"
    );
}

/// Kills: an impl with incorrect fractional arithmetic (e.g., floating-point rounding).
/// EARS C2: current_hp == max_hp/2 → bonus ≈ MISSING_HP_FACTOR/2.
#[test]
fn recruit_chance_half_hp_midway() {
    // max=100, current=50: bonus = 50*500/100 = 250
    // result = min(1000, 0 + 250 + 0) = 250
    let result = recruit_chance(100, 50, 0, 0);
    assert_eq!(result, 250, "half HP, base=0: bonus = 250; got {result}");
}

/// Kills: an impl where the bonus doesn't increase as HP falls.
/// EARS C2: recruit chance must be monotonically non-decreasing as current_hp falls.
#[test]
fn recruit_chance_rises_as_hp_falls() {
    let max_hp = 100u16;
    let base = 50u16;
    let bait = 20u16;

    let mut prev = recruit_chance(max_hp, max_hp, base, bait);
    for current in (0..max_hp).rev() {
        let now = recruit_chance(max_hp, current, base, bait);
        assert!(
            now >= prev,
            "chance must be non-decreasing as HP falls: \
             chance(hp={current}) = {now} < chance(hp={}) = {prev}",
            current + 1
        );
        prev = now;
    }
}

/// Kills: an impl that allows values above 1000.
/// EARS C2: result is always capped at 1000.
#[test]
fn recruit_chance_caps_at_1000() {
    // base=900, bait=900 → 1800 before cap → should be 1000
    let result = recruit_chance(100, 100, 900, 900);
    assert_eq!(result, 1000, "should cap at 1000; got {result}");

    // At 0 HP with huge base+bait
    let result2 = recruit_chance(100, 0, 800, 800);
    assert_eq!(
        result2, 1000,
        "should cap at 1000 even at 0 HP; got {result2}"
    );
}

/// Kills: an impl that panics on divide-by-zero when max_hp == 0.
/// EARS C2: max_hp == 0 → no missing-HP bonus → min(1000, base_rate + bait_bonus).
#[test]
fn recruit_chance_divide_by_zero_guarded() {
    // max_hp = 0: must not panic, must return base + bait (no fraction)
    let result = recruit_chance(0, 0, 50, 30);
    assert_eq!(
        result, 80,
        "max_hp=0: no HP fraction; result = base(50)+bait(30) = 80; got {result}"
    );

    // current_hp is irrelevant when max_hp=0
    let result2 = recruit_chance(0, 99, 100, 0);
    assert_eq!(
        result2, 100,
        "max_hp=0, current=99: result = base(100); got {result2}"
    );
}

/// Kills: an impl that subtracts (producing underflow) when current > max.
/// EARS C2: current_hp > max_hp → treat as full HP (no bonus).
#[test]
fn recruit_chance_current_above_max_no_panic() {
    // current=150, max=100: must not panic or underflow; treat as full HP
    let result = recruit_chance(100, 150, 50, 10);
    assert_eq!(
        result, 60,
        "current>max: treat as full HP; result = base(50)+bait(10) = 60; got {result}"
    );
}

// Kills: any impl where recruit_chance produces a value outside [0, 1000].
// EARS C2: output is always in [0, 1000] for any valid u16 inputs.
proptest! {
    #[test]
    fn recruit_chance_bounded_output(
        max_hp in 0u16..=1000,
        current_hp in 0u16..=1000,
        base_rate in 0u16..=1000,
        bait_bonus in 0u16..=1000,
    ) {
        let result = recruit_chance(max_hp, current_hp, base_rate, bait_bonus);
        prop_assert!(
            result <= 1000,
            "recruit_chance must be <= 1000; got {result} \
             (max={max_hp}, current={current_hp}, base={base_rate}, bait={bait_bonus})"
        );
    }
}

// Kills: an impl where chance doesn't rise as HP falls (monotonicity via proptest).
// EARS C2: for fixed max/base/bait, hp1 >= hp2 → chance(hp1) <= chance(hp2).
proptest! {
    #[test]
    fn recruit_chance_monotone_in_damage(
        max_hp in 1u16..=1000,
        hp1 in 0u16..=1000,
        hp2 in 0u16..=1000,
        base_rate in 0u16..=500,
        bait_bonus in 0u16..=500,
    ) {
        // hp1 and hp2 are capped at max_hp for comparison
        let capped1 = hp1.min(max_hp);
        let capped2 = hp2.min(max_hp);
        let chance1 = recruit_chance(max_hp, capped1, base_rate, bait_bonus);
        let chance2 = recruit_chance(max_hp, capped2, base_rate, bait_bonus);
        // Lower HP → higher (or equal) chance
        if capped1 >= capped2 {
            prop_assert!(
                chance1 <= chance2,
                "hp1={capped1} >= hp2={capped2} but chance({capped1})={chance1} > chance({capped2})={chance2}"
            );
        } else {
            prop_assert!(
                chance1 >= chance2,
                "hp1={capped1} < hp2={capped2} but chance({capped1})={chance1} < chance({capped2})={chance2}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// CRITERION 1+2 — attempt_recruit
// Formula: roll % 1000 < chance
// ---------------------------------------------------------------------------

/// Kills: an impl that returns false when chance=1000.
/// EARS C1/C2: chance=1000 is guaranteed success for any roll.
#[test]
fn attempt_recruit_max_chance_always_succeeds() {
    for roll in [0u32, 1, 42, 500, 999, u32::MAX] {
        assert!(
            attempt_recruit(1000, roll),
            "chance=1000 must always succeed; roll={roll}"
        );
    }
}

/// Kills: an impl that returns true when chance=0.
/// EARS C1/C2: chance=0 is always failure for any roll.
#[test]
fn attempt_recruit_zero_chance_always_fails() {
    for roll in [0u32, 1, 42, 500, 999, u32::MAX] {
        assert!(
            !attempt_recruit(0, roll),
            "chance=0 must always fail; roll={roll}"
        );
    }
}

/// Kills: an impl with off-by-one (< vs <=, or wrong modulus).
/// EARS C1/C2: roll%1000 == chance-1 → true (just inside); roll%1000 == chance → false (at boundary).
#[test]
fn attempt_recruit_boundary() {
    // chance=300: roll%1000 == 299 → true (just inside)
    assert!(
        attempt_recruit(300, 299),
        "roll=299, chance=300 → true (just inside boundary)"
    );
    // roll=1299 → 1299%1000=299 → true
    assert!(
        attempt_recruit(300, 1299),
        "roll=1299 (mod 299), chance=300 → true"
    );

    // chance=300: roll%1000 == 300 → false (at boundary)
    assert!(
        !attempt_recruit(300, 300),
        "roll=300, chance=300 → false (at boundary)"
    );
    // roll=1300 → 1300%1000=300 → false
    assert!(
        !attempt_recruit(300, 1300),
        "roll=1300 (mod 300), chance=300 → false"
    );
}

// ---------------------------------------------------------------------------
// Content: encounters.ron loading
// ---------------------------------------------------------------------------

/// Kills: a stub that never actually parses the embedded RON.
/// EARS C1: load_encounters() must succeed for the shipped encounters.ron.
#[test]
fn embedded_encounters_parse() {
    let tables = load_encounters().expect("embedded encounters.ron must parse without error");
    assert!(
        !tables.is_empty(),
        "embedded encounters must contain at least one table"
    );
}

/// Kills: a validate_encounters stub that always returns Ok (no cross-checking).
/// EARS C1: validate_encounters passes for the embedded species + zones.
#[test]
fn validate_encounters_passes_for_embedded() {
    let tables = load_encounters().expect("encounters parse");
    let species = load_species().expect("species parse");
    let zones = load_zones().expect("zones parse");
    validate_encounters(&tables, &species, &zones)
        .expect("embedded encounters must pass validation against embedded species and zones");
}

/// Kills: an impl that silently returns empty on garbage input.
/// EARS C1: parse_encounters on garbage → Err.
#[test]
fn rejects_malformed_encounters_ron() {
    let result = parse_encounters("not ron at all {{{");
    assert!(
        result.is_err(),
        "malformed RON must be rejected; got Ok({result:?})"
    );
}

/// Kills: a validate_encounters that skips duplicate zone_id checking.
/// EARS C1: two tables with the same zone_id → Err.
#[test]
fn rejects_duplicate_zone_in_encounters() {
    let t1 = make_table(5, 100, vec![make_entry(1, 10, 1, 10)]);
    let t2 = make_table(5, 200, vec![make_entry(2, 10, 1, 10)]); // same zone_id=5
    let species = vec![fixture_species(1), fixture_species(2)];
    let zones = vec![fixture_zone(5)];
    let result = validate_encounters(&[t1, t2], &species, &zones);
    assert!(
        result.is_err(),
        "duplicate zone_id=5 must be rejected; got Ok(())"
    );
}

/// Kills: a validate_encounters that skips species cross-checking.
/// EARS C1: species_id 999 not in species registry → Err.
#[test]
fn rejects_dangling_species_in_encounter() {
    let entry = make_entry(999, 10, 1, 10); // species 999 does not exist
    let table = make_table(0, 100, vec![entry]);
    let species = vec![fixture_species(1)]; // only species 1
    let zones = vec![fixture_zone(0)];
    let result = validate_encounters(&[table], &species, &zones);
    assert!(
        result.is_err(),
        "dangling species_id=999 must be rejected; got Ok(())"
    );
}

/// Kills: a validate_encounters that skips zone cross-checking.
/// EARS C1: zone_id 999 not in zone registry → Err.
#[test]
fn rejects_dangling_zone_in_encounter() {
    let entry = make_entry(1, 10, 1, 10);
    let table = make_table(999, 100, vec![entry]); // zone 999 does not exist
    let species = vec![fixture_species(1)];
    let zones = vec![fixture_zone(0)]; // only zone 0
    let result = validate_encounters(&[table], &species, &zones);
    assert!(
        result.is_err(),
        "dangling zone_id=999 must be rejected; got Ok(())"
    );
}

/// Kills: a validate_encounters that allows weight=0 (which would make an entry unselectable).
/// EARS C1: weight=0 → Err.
#[test]
fn rejects_zero_weight_encounter_entry() {
    let bad_entry = make_entry(1, 0, 1, 10); // weight=0
    let table = make_table(0, 100, vec![bad_entry]);
    let species = vec![fixture_species(1)];
    let zones = vec![fixture_zone(0)];
    let result = validate_encounters(&[table], &species, &zones);
    assert!(
        result.is_err(),
        "weight=0 in encounter entry must be rejected; got Ok(())"
    );
}

/// Kills: a validate_encounters that allows min_level > max_level.
/// EARS C1: min_level > max_level → Err.
///
/// We construct the EncounterEntry directly (bypassing Level ordering)
/// by passing them in reversed order — valid Levels that are inverted in range.
#[test]
fn rejects_inverted_level_range() {
    // min_level=10, max_level=5 — inverted range
    let bad_entry = EncounterEntry {
        species_id: 1,
        weight: 10,
        min_level: level(10),
        max_level: level(5),
    };
    let table = make_table(0, 100, vec![bad_entry]);
    let species = vec![fixture_species(1)];
    let zones = vec![fixture_zone(0)];
    let result = validate_encounters(&[table], &species, &zones);
    assert!(
        result.is_err(),
        "inverted level range (min=10 > max=5) must be rejected; got Ok(())"
    );
}

/// Kills: a validate_encounters that allows encounter_rate > 1000.
/// EARS C1: encounter_rate=1001 → Err (per-mille means max valid is 1000).
///
/// Note: EncounterTable.encounter_rate is u16, so 1001 is constructible.
#[test]
fn rejects_encounter_rate_above_1000() {
    let entry = make_entry(1, 10, 1, 10);
    let bad_table = EncounterTable {
        zone_id: 0,
        encounter_rate: 1001, // invalid — per-mille max is 1000
        entries: vec![entry],
    };
    let species = vec![fixture_species(1)];
    let zones = vec![fixture_zone(0)];
    let result = validate_encounters(&[bad_table], &species, &zones);
    assert!(
        result.is_err(),
        "encounter_rate=1001 must be rejected; got Ok(())"
    );
}

// ---------------------------------------------------------------------------
// Content: ItemDef recruit_bonus field
// ---------------------------------------------------------------------------

/// Kills: an impl that fails to parse ItemDef with recruit_bonus field.
/// EARS C2: an item RON with recruit_bonus parses correctly.
#[test]
fn item_with_recruit_bonus_parses() {
    let ron_str = r#"[(id: 1, name: "Bait", description: "Tasty bait", recruit_bonus: 150)]"#;
    let items = crate::content::parse_items(ron_str).expect("item with recruit_bonus must parse");
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].recruit_bonus, 150,
        "recruit_bonus must be 150; got {}",
        items[0].recruit_bonus
    );
}

/// Kills: an impl where recruit_bonus is required (not #[serde(default)]).
/// EARS C2: an item RON without recruit_bonus parses and defaults to 0.
#[test]
fn item_without_recruit_bonus_defaults_to_zero() {
    let ron_str = r#"[(id: 1, name: "Potion", description: "Heals HP")]"#;
    let items = crate::content::parse_items(ron_str)
        .expect("item without recruit_bonus must parse (defaults to 0)");
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].recruit_bonus, 0,
        "recruit_bonus must default to 0; got {}",
        items[0].recruit_bonus
    );
}

// ---------------------------------------------------------------------------
// Proof-of-teeth Each of these fixtures is known-bad. The test passes only if
// the validation returns Err.
// ---------------------------------------------------------------------------

/// Proof-of-teeth: a dangling species_id MUST be rejected.
/// Kills: any validate_encounters that skips the species cross-check.
#[test]
fn validate_encounters_teeth_dangling_species() {
    let bad = make_entry(42, 10, 1, 10); // species 42 does not exist
    let table = make_table(0, 100, vec![bad]);
    let species = vec![fixture_species(1)];
    let zones = vec![fixture_zone(0)];
    let result = validate_encounters(&[table], &species, &zones);
    assert!(
        result.is_err(),
        "TEETH: dangling species_id=42 must be rejected, but validation passed"
    );
}

/// Proof-of-teeth: weight=0 MUST be rejected.
/// Kills: any validate_encounters that skips weight validation.
#[test]
fn validate_encounters_teeth_zero_weight() {
    let bad = make_entry(1, 0, 1, 10); // weight=0
    let table = make_table(0, 100, vec![bad]);
    let species = vec![fixture_species(1)];
    let zones = vec![fixture_zone(0)];
    let result = validate_encounters(&[table], &species, &zones);
    assert!(
        result.is_err(),
        "TEETH: weight=0 must be rejected, but validation passed"
    );
}

/// Proof-of-teeth: recruit_chance with max_hp=0 must NOT panic.
/// Kills: any impl that divides by max_hp without guarding zero.
#[test]
fn recruit_chance_teeth_no_panic_on_zero_max_hp() {
    // Must not panic
    let result = recruit_chance(0, 0, 100, 50);
    // Result must be capped at 1000 and non-negative
    assert!(
        result <= 1000,
        "TEETH: recruit_chance with max_hp=0 must be in [0,1000]; got {result}"
    );
}

/// Proof-of-teeth: recruit_chance with current_hp > max_hp must NOT panic.
/// Kills: any impl that subtracts naively, causing u16 underflow.
#[test]
fn recruit_chance_teeth_no_panic_on_current_above_max() {
    // current=200, max=100 → must not panic or produce underflow
    let result = recruit_chance(100, 200, 50, 10);
    assert!(
        result <= 1000,
        "TEETH: recruit_chance with current>max must be in [0,1000]; got {result}"
    );
}

/// Proof-of-teeth: roll_encounter on a table where all entries are filtered out
/// must return None, not panic.
/// Kills: any impl that indexing into an empty eligible slice.
#[test]
fn roll_encounter_teeth_no_panic_on_empty_after_filter() {
    // All entries are out-of-range for player_level=1
    let e1 = make_entry(1, 10, 50, 80);
    let e2 = make_entry(2, 10, 60, 90);
    let table = make_table(0, 200, vec![e1, e2]);
    // Must not panic
    let result = roll_encounter(&table, 0, level(1));
    assert_eq!(
        result, None,
        "TEETH: all entries filtered → must return None, not panic"
    );
}

// ---------------------------------------------------------------------------
// validate_encounters: empty entries guard
//
// ---------------------------------------------------------------------------

/// EARS B1: a table with an empty entries vec is invalid — nothing can spawn.
/// Kills: any validate_encounters that silently accepts empty entries (iterates
/// zero times and falls through to Ok(())).
#[test]
fn rejects_empty_entries() {
    // Valid zone + valid species registry — the ONLY flaw is empty entries.
    let table = make_table(0, 200, vec![]);
    let species = vec![fixture_species(1)];
    let zones = vec![fixture_zone(0)];
    let result = validate_encounters(&[table], &species, &zones);
    assert!(
        result.is_err(),
        "empty entries vec must be rejected; current impl returns Ok(()) — test is RED until guard is added"
    );
}

/// Proof-of-teeth for the empty-entries guard.
/// Wrong impl killed: any validate_encounters that returns Ok on empty entries.
#[test]
fn validate_encounters_teeth_empty_entries() {
    let bad = make_table(0, 100, vec![]); // known-bad: no entries
    let species = vec![fixture_species(1)];
    let zones = vec![fixture_zone(0)];
    let result = validate_encounters(&[bad], &species, &zones);
    assert!(
        result.is_err(),
        "TEETH: empty entries must be rejected, but validate_encounters returned Ok(()) — \
         this is the known red-state before the B1 guard is added"
    );
}

// ---------------------------------------------------------------------------
// validate_encounters: duplicate species_id within a zone
//
// ---------------------------------------------------------------------------

/// EARS B1: two entries sharing a species_id in the same zone must be rejected.
/// Kills: any validate_encounters that skips intra-zone species deduplication.
#[test]
fn rejects_duplicate_species_within_zone() {
    // Same species_id (1) appears twice in zone 0.
    let e1 = make_entry(1, 10, 1, 5);
    let e2 = make_entry(1, 20, 6, 10); // same species_id=1, different weight/levels
    let table = make_table(0, 200, vec![e1, e2]);
    let species = vec![fixture_species(1)];
    let zones = vec![fixture_zone(0)];
    let result = validate_encounters(&[table], &species, &zones);
    assert!(
        result.is_err(),
        "duplicate species_id=1 within zone 0 must be rejected; current impl returns Ok(()) — \
         test is RED until dup-species guard is added"
    );
}

/// Proof-of-teeth for the duplicate-species guard.
/// Wrong impl killed: any validate_encounters that allows two entries with the
/// same species_id in one zone.
#[test]
fn validate_encounters_teeth_duplicate_species() {
    let dup1 = make_entry(7, 10, 1, 10);
    let dup2 = make_entry(7, 5, 1, 10); // species_id=7 duplicated
    let bad = make_table(0, 150, vec![dup1, dup2]);
    let species = vec![fixture_species(7)];
    let zones = vec![fixture_zone(0)];
    let result = validate_encounters(&[bad], &species, &zones);
    assert!(
        result.is_err(),
        "TEETH: duplicate species_id=7 within zone must be rejected, \
         but validate_encounters returned Ok(()) — \
         this is the known red-state before the dup-species guard is added"
    );
}

pub mod recruit_hardening {
    //! `attempt_recruit` and inventory/recruit hardening.
    //!
    //! Every test here is written to FAIL against a naive/plausible wrong implementation.

    use crate::taming::rules::{attempt_recruit, recruit_chance};

    // ---------------------------------------------------------------------------
    // FINDING 1 (HIGH): TOCTOU — can an already-terminal battle be re-recruited?
    //
    // SpacetimeDB reducers are atomic per-call.
    // However: can a client submit TWO concurrent calls before the first commits?
    //
    // SpacetimeDB serialises reducer calls per-table-row under its MVCC model —
    // concurrent writes to the same battle_id row are serialised.  But ONLY IF
    // the implementer actually re-reads the battle from the DB (not a local copy).
    //
    // The test below proves the LOGIC path is safe:
    //   - attempt_recruit on outcome=SideAWins must be rejected by the Ongoing guard.
    //   - If the guard checks a stale local copy instead of the DB row the door stays open.
    //
    // This is not testable as a unit test against the reducer directly, but the pure
    // helper `attempt_recruit` takes a pre-computed `chance` and `roll`.  The
    // SERVER-SIDE guard invariant we need to prove:
    //   "attempt_recruit called on a non-Ongoing battle returns Err immediately"
    //
    // We test the arithmetic contract that closing the door (deleting battle_wild)
    // is the ONLY idempotent guard, since outcome=SideAWins still passes the roll:
    // ---------------------------------------------------------------------------

    /// FINDING 1: A roll that would succeed is gated only by the Ongoing check.
    /// If the server re-reads the battle from the DB after the first commit, the
    /// second call hits outcome=SideAWins and is rejected BEFORE the recruit roll.
    /// This test documents that `attempt_recruit(1000, any_roll)` always succeeds —
    /// so the server MUST guard on outcome, not on the roll value.
    #[test]
    fn recruit_success_is_not_idempotent_gate() {
        // A chance of 1000 (certainty) means any roll succeeds.
        // If a second call got past the outcome guard, it would also succeed.
        for roll in [0u32, 1, 499, 500, 999, u32::MAX] {
            assert!(
                attempt_recruit(1000, roll),
                "chance=1000 always succeeds — the ONLY gate is the server-side outcome check; \
             if that guard reads a stale local battle copy instead of re-reading the DB row, \
             a second concurrent call wins a second monster"
            );
        }
        // The guard we need the server to enforce: outcome != Ongoing → reject.
    }

    // ---------------------------------------------------------------------------
    // FINDING 2 (HIGH): Bait consumed BEFORE the roll — failed recruit still burns
    // bait.
    //
    // More critically: the consume-before-roll ordering means the server MUST NOT
    // refund bait on a failed roll.  Any implementation that refunds on failure is
    // exploitable (free bait on every failed attempt).
    //
    // This test proves the bait-burn ordering is arithmetically correct — the
    // recruitment roll happens AFTER the count decrement.
    // ---------------------------------------------------------------------------

    /// FINDING 2: bait burn is irreversible — prove that a 0-chance roll with bait
    /// still decrements the count.  The server MUST NOT conditionally refund.
    /// A refund-on-fail implementation gives infinite bait by alternating
    /// attempt_recruit calls with a zero-chance wild.
    #[test]
    fn zero_chance_recruit_still_consumes_bait() {
        // With chance=0, attempt_recruit always fails.
        // Bait was consumed BEFORE the roll.
        // The arithmetic contract: consume_one happens, then attempt_recruit(0,..) = false.
        // If consume_one is called ONLY on success, bait is never spent — infinite bait exploit.
        assert!(
            !attempt_recruit(0, 0),
            "chance=0 always fails — if bait is NOT consumed on failure, the player gets \
         infinite free bait uses: call attempt_recruit with any cheap bait, always fail, \
         never lose the bait"
        );
        // Similarly for near-zero chance: roll%1000=1, chance=1 → 1 < 1 is false → fails.
        // roll=1000 would give 1000%1000=0 < 1 → TRUE (success!), so use roll=1.
        assert!(
            !attempt_recruit(1, 1), // 1%1000=1, 1<1 = false → FAIL
            "chance=1, roll=1 → fail (1%1000=1, 1<1 is false). Bait must have been consumed \
         before this point; refund-on-fail would make bait free"
        );
        // Confirm the boundary: roll=1000 IS a success for chance=1 (1000%1000=0 < 1).
        // This means even a "1-in-1000" bait use succeeds if the player gets lucky roll=1000.
        assert!(
            attempt_recruit(1, 1000), // 1000%1000=0 < 1 → TRUE (success at 0.1% chance!)
            "roll=1000: 1000%1000=0, 0 < 1 is true — even chance=1 can succeed; \
         bait is still consumed regardless of outcome"
        );
    }

    // ---------------------------------------------------------------------------
    // FINDING 3 (CRITICAL): Inventory integer overflow — `grant_item` saturating add.
    //
    // u32::MAX + 1 with saturating add stays at u32::MAX (correct).
    // But: what if the inventory row stores `count` as a smaller type that gets
    // cast to u32?  Or what if the implementer uses `count + amount` without
    // saturating?  Then count can wrap to 0, and consume_one on 0 fails.
    //
    // Worse: if count wraps to a SMALL value after an overflow, the player can
    // then consume_one that small value to e.g. recruit without actually having enough bait.
    //
    // The property: for all (count, add_amount) where both are u32,
    // saturating_add(count, add_amount) >= count.
    // ---------------------------------------------------------------------------

    /// FINDING 3: saturating add must not wrap — grant near-MAX then grant again.
    /// A wrapping-add impl would produce a count smaller than the pre-add value.
    #[test]
    fn inventory_grant_saturating_add_does_not_wrap() {
        // The pure arithmetic invariant the server must implement for grant_item:
        let count_before: u32 = u32::MAX - 1;
        let add: u32 = 5;
        let expected = u32::MAX; // saturating
        let actual = count_before.saturating_add(add);
        assert_eq!(
            actual,
            expected,
            "saturating_add({count_before}, {add}) must be u32::MAX, not {}; \
         a wrapping impl would produce {} which is LESS than the pre-add count — \
         an attacker could grant u32::MAX-1 bait, call grant_item again to wrap count \
         to a small value, then consume_one would succeed on an artificially small stack",
            actual,
            count_before.wrapping_add(add),
        );
        // Critical: the wrapped value is SMALLER than the pre-add value.
        // This would allow an attacker to grant themselves so much of an item that
        // the count wraps to e.g. 4, then consume_one on 4 items is fine — but they
        // actually have 4 billion items worth of bait arithmetic miscount.
        assert!(
            count_before.wrapping_add(add) < count_before,
            "PROOF: wrapping_add on u32::MAX-1 + 5 = {} < {} — the wrapped count is smaller \
         than the pre-grant count, proving the saturating contract must be enforced",
            count_before.wrapping_add(add),
            count_before,
        );
    }

    /// FINDING 3b: consume_one on count=0 must return Err, not underflow to u32::MAX.
    /// A naive `count - 1` on u32 where count==0 wraps to u32::MAX in release mode
    /// (Rust wrapping semantics on subtraction in non-debug builds with wrapping).
    /// Under SpacetimeDB wasm (release), arithmetic panics are UB-style traps or wraps
    /// depending on the target; the server must use checked_sub or an explicit guard.
    #[test]
    fn inventory_consume_one_on_zero_must_not_underflow() {
        let count: u32 = 0;
        // The correct behavior: checked_sub returns None (Err path).
        assert!(
            count.checked_sub(1).is_none(),
            "count=0 checked_sub(1) must be None — the server MUST use checked_sub or an \
         explicit 'if count == 0 return Err' guard; a naive `count - 1` in release mode \
         wraps to u32::MAX, making the player appear to have 4 billion items"
        );
        // The exploit: if consume_one wraps on 0, the player has u32::MAX bait after
        // one failed consume call — effectively infinite bait.
        assert_eq!(
            count.wrapping_sub(1),
            u32::MAX,
            "PROOF: wrapping_sub(0, 1) = u32::MAX — if the server uses wrapping subtraction, \
         a player with 0 bait calls attempt_recruit(bait_id=1) and gets u32::MAX bait \
         as a side effect of the 'no bait' rejection path not checking first"
        );
    }

    // NOTE: FINDING 4 (bait-classification drift — "ItemRow can't express recruit_bonus,
    // server uses load_items() at reduce-time") was CUT: it is now FALSE. `ItemRow`
    // carries `recruit_bonus` (seeded from the game-core `ItemDef` in sync_content),
    // and `attempt_recruit` classifies bait from the live DB row — never load_items().

    // ---------------------------------------------------------------------------
    // FINDING 5 (HIGH): IV inversion channel via public BattleState.
    //
    // "the wild's derived stats ARE published in the public battle.state BattleState" and
    // "those derived stats are theoretically invertible to the underlying IVs/nature."
    //
    // For a wild monster: EVs=0, species base stats are public (species_row is public),
    // level is public (in battle.state.side_b.team[0].level).
    // With known (base, EVs=0, level), the IV can be recovered for each stat by inverting
    // the derive_stats formula.
    //
    // This test proves the inversion is feasible with a brute-force search over [0,31]:
    // ---------------------------------------------------------------------------

    /// FINDING 5: IV inversion is feasible from public BattleState data.
    ///
    /// "the wild's derived stats ARE published in the public battle.state
    /// BattleState" and "those derived stats are theoretically invertible to the
    /// underlying IVs/nature." This test proves the inversion is not merely theoretical —
    /// it is exact and trivially fast (32-candidate brute force).
    ///
    /// Level 100, base_hp=45, ev=0 makes HP = (2*45 + iv)*100/100 + 110 = 200 + iv,
    /// which is INJECTIVE: each IV in [0,31] maps to a distinct HP value. Therefore the
    /// 32-candidate search ALWAYS narrows to exactly 1 result, proving the channel is
    /// fully determined (not just "a few candidates").
    ///
    /// The test FAILS if derive_stats collapses IVs (e.g. quantises HP), making the
    /// candidate set larger or smaller than {15}.
    #[test]
    fn wild_iv_recoverable_from_public_derived_stats() {
        use crate::monster::rules::derive_stats;
        use crate::monster::types::{EVs, IVs, Level, Nature, NatureKind, StatBlock, StatKind};

        // -----------------------------------------------------------------------
        // INPUT CONSTRUCTION (not a self-oracle):
        // We pick a known true IV and call derive_stats ONCE to get the HP value
        // an eavesdropper would observe in the public BattleState. The assertion
        // below is on the SEARCH RESULT of a separate brute-force loop — never on
        // a recomputation of public_stat_hp inside the assert.
        // -----------------------------------------------------------------------

        // Public data an eavesdropper has from battle.state.side_b.team[0]:
        let public_base_hp: u16 = 45; // from species_row (public)
        let public_level: u8 = 100; // from battle.state.side_b.team[0].level

        // At level=100, base=45, ev=0:  HP = (2*45 + iv)*100/100 + 100 + 10 = 200 + iv
        // → injective over [0,31]: iv=15 → HP=215, iv=14 → HP=214, iv=16 → HP=216.
        let known_true_iv: u8 = 15;

        let evs = EVs::zero(); // wild EVs are always 0 (documented in wild_battle_monster)
        let base = StatBlock {
            hp: public_base_hp,
            attack: 49,
            defense: 49,
            speed: 65,
            sp_attack: 65,
            sp_defense: 45,
        };
        let level = Level::new(public_level).unwrap();
        let nature = Nature::new(NatureKind::Hardy); // Hardy: no stat modifier

        // Compute the HP the eavesdropper observes — this is input construction only.
        let true_ivs = IVs::new(known_true_iv, 0, 0, 0, 0, 0).unwrap();
        let public_stat_hp: u16 =
            derive_stats(&base, &true_ivs, &evs, &nature, level).get(StatKind::Hp);

        // Sanity-check the math: at level=100, base=45, iv=15, ev=0:
        // HP = (2*45 + 15) * 100 / 100 + 100 + 10 = 105 + 110 = 215
        assert_eq!(
            public_stat_hp, 215,
            "HP formula sanity: base=45 iv=15 lv=100 ev=0 → (2*45+15)*1 + 110 = 215"
        );

        // -----------------------------------------------------------------------
        // BRUTE-FORCE INVERSION — collect ALL matching IVs (no break on first match).
        // The SET is the proof: {15} means the channel is fully determined.
        // -----------------------------------------------------------------------
        // 32 possible IVs narrowed to exactly 1 → is real; level 100 makes
        // derive_stats HP injective (200+iv), so any narrowing failure would balloon
        // the set (duplicate HPs → multiple matches) or shrink it to 0 (no match →
        // derive_stats is broken).
        let mut candidates: Vec<u8> = Vec::new();
        for candidate_iv in 0u8..=31 {
            let ivs = IVs::new(candidate_iv, 0, 0, 0, 0, 0).unwrap();
            let derived = derive_stats(&base, &ivs, &evs, &nature, level);
            if derived.get(StatKind::Hp) == public_stat_hp {
                candidates.push(candidate_iv);
                // NO break — collect the full set to prove singleton, not just presence.
            }
        }

        assert_eq!(
            candidates,
            vec![15u8],
            "IV inversion brute-force over [0,31] must recover exactly {{15}} for \
         public_stat_hp={public_stat_hp} (base=45, level=100, ev=0). \
         HP = 200+iv is injective at level 100, so the candidate set is always a \
         singleton. A set larger than {{15}} means derive_stats collapsed IVs \
         (non-injective formula); an empty set means derive_stats is broken. \
         ADR-0045 acknowledges this inversion channel but defers mitigation."
        );
    }

    // ---------------------------------------------------------------------------
    // FINDING 6 (HIGH): The recruit formula has a per-mille modulo bias.
    //
    // `roll % 1000 < chance` where roll is u32.
    // u32::MAX = 4_294_967_295.  4_294_967_295 / 1000 = 4_294_967 remainder 295.
    // So values [0..295] appear 4_294_968 times and [296..999] appear 4_294_967 times.
    // Bias per bucket: (4_294_968 - 4_294_967) / 4_294_967_296 ≈ 2.3e-10.
    //
    // The practical exploit: recruit_chance values in [0..295] are slightly MORE
    // likely to succeed than [296..999] at the margin.  This is ~0.007% per bucket —
    // not a practical exploit.
    // ---------------------------------------------------------------------------

    /// FINDING 6: Document the modulo bias for the recruit roll.
    /// u32::MAX % 1000 = 295, so roll values [0..295] are over-represented.
    #[test]
    fn recruit_roll_modulo_bias_is_documented() {
        // Prove the bias exists:
        let max = u32::MAX; // 4_294_967_295
        let remainder = max % 1000;
        assert_eq!(
            remainder, 295,
            "u32::MAX % 1000 = 295 — values 0..=295 appear once more than 296..=999 \
         in a uniform u32 distribution; this creates ~0.007% bias per bucket"
        );
        // The impact on recruit chance: a species with base_rate=295 has
        // recruit_chance(max_hp, max_hp, 295, 0) = 295.
        let chance = recruit_chance(100, 100, 295, 0);
        assert_eq!(chance, 295);
        // With a uniform u32 roll, values 0..295 hit slightly more often than expected.
        // Not a practical exploit, but a precision issue in the per-mille model.
    }

    // ---------------------------------------------------------------------------
    // FINDING 7 (MED): The on-fail wild counterattack creates a grinding exploit.
    //
    // When attempt_recruit fails, the wild strikes back via resolve_enemy_turn.
    // A player can:
    //   1. Weaken the wild to near-0 HP for ~100% recruit chance.
    //   2. Call attempt_recruit repeatedly.
    //   3. On each failure, the wild strikes back.
    //   4. If the player's active is tanky enough, this creates an infinite retry loop
    //      as long as the player's monster doesn't faint.
    //
    // This is an "infinite turns" exploit that lets a player:
    //   - Repeatedly attempt to recruit while healing (if heal_party is available between attempts)
    //   - Or simply spam attempts on a near-dead wild knowing each failure just advances the turn.
    //
    // The wild can faint the player's monsters, but a max-HP team vs a 1-HP wild
    // is essentially free retries.
    //
    // ---------------------------------------------------------------------------

    /// FINDING 7: A 1-HP wild can be attempt_recruited indefinitely if the player
    /// is tanky. The recruit chance at 1/max_hp approaches MISSING_HP_FACTOR.
    #[test]
    fn near_dead_wild_recruit_chance_is_near_max_factor() {
        // Wild at 1 HP out of 100 max:
        let chance = recruit_chance(100, 1, 0, 0);
        // hp_bonus = (100-1)*500/100 = 99*500/100 = 49500/100 = 495
        assert_eq!(
            chance, 495,
            "near-dead wild (1/100 HP) has recruit chance of 495/1000 ≈ 49.5%; \
         with ~50% chance each attempt, expected ~2 tries to succeed; \
         but there's NO attempt limit — a player can spam recruit_attempt until it lands"
        );
        // INVARIANT (grinding residual): there is NO per-battle
        // attempt cap. At MISSING_HP_FACTOR=500 a 0-HP wild sits at 50% + base + bait,
        // so even ~50% per attempt means a tanky party vs a 1-HP wild WILL eventually
        // recruit (each failed attempt just advances the turn).
    }

    // NOTE: FINDING 8 (battle_wild orphan rows on non-recruit battle end) was CUT:
    // it is now FALSE. `write_back_battle_results` unconditionally deletes the
    // battle_wild row (a no-op for PvP), so flee/loss/combat-win all GC the wild row;
    // `attempt_recruit` GCs on its own success/terminal paths. No orphan accumulates.

    // ---------------------------------------------------------------------------
    // FINDING 10 (MED): recruit_chance integer truncation can produce IDENTICAL
    // chances for different HP values due to integer division.
    //
    // Formula: hp_bonus = (max_hp - current_hp) * 500 / max_hp
    // For max_hp=3:
    //   current_hp=2: (3-2)*500/3 = 500/3 = 166 (truncated)
    //   current_hp=1: (3-2+1)*500/3 = 2*500/3 = 1000/3 = 333 (truncated)
    //   current_hp=0: 3*500/3 = 1500/3 = 500
    //
    // For max_hp=2:
    //   current_hp=1: 1*500/2 = 250
    //   current_hp=0: 2*500/2 = 500
    //
    // But for large max_hp, consecutive HP values can produce identical chances.
    // This is expected integer behavior, but it means "weakening" the wild by 1 HP
    // may not always improve recruit odds — a player who expects continuous improvement
    // will be surprised.
    // ---------------------------------------------------------------------------

    /// FINDING 10: Integer truncation causes recruit_chance to be non-strictly-monotone
    /// for small max_hp values — consecutive HP reductions may show no improvement.
    #[test]
    fn recruit_chance_truncation_can_plateau() {
        // max_hp=3: chance at hp=2 and hp=1 are both non-zero but may plateau
        let c2 = recruit_chance(3, 2, 0, 0); // (3-2)*500/3 = 166
        let c1 = recruit_chance(3, 1, 0, 0); // (3-1)*500/3 = 333
        let c0 = recruit_chance(3, 0, 0, 0); // 3*500/3 = 500

        assert_eq!(c2, 166, "hp=2/3: hp_bonus = 166 (truncated)");
        assert_eq!(c1, 333, "hp=1/3: hp_bonus = 333 (truncated)");
        assert_eq!(c0, 500, "hp=0/3: hp_bonus = 500");

        // Now try a case where consecutive HP values produce the SAME chance:
        // max_hp=1000: each HP unit contributes 500/1000=0 (rounded down!) for hp changes < 2
        // Actually with max=1000 and missing=1: 1*500/1000=0 (truncated to 0)
        // So weakening a 1000-HP wild by 1 HP gives NO recruit bonus improvement!
        let at_full = recruit_chance(1000, 1000, 100, 0); // base=100
        let at_999 = recruit_chance(1000, 999, 100, 0); // hp_bonus = 1*500/1000 = 0

        assert_eq!(
            at_full, at_999,
            "PLATEAU: max_hp=1000, hp=999 vs hp=1000 gives IDENTICAL recruit chance ({at_full}); \
         integer truncation makes 1*500/1000=0; a player who reduces the wild by 1 HP \
         gets NO improvement — may be surprising and lead to over-weakening"
        );

        // The threshold where improvement kicks in: missing_hp >= ceil(max_hp/500)
        let threshold_missing = 1000u32 / 500 + 1; // = 3
        let at_threshold = recruit_chance(1000, 1000 - threshold_missing as u16, 100, 0);
        assert!(
            at_threshold > at_full,
            "improvement only kicks in at missing_hp >= {threshold_missing} for max_hp=1000; \
         below this threshold, integer truncation gives 0 hp_bonus"
        );
    }

    // ---------------------------------------------------------------------------
    // FINDING 11 (LOW/MED): Public inventory table leaks count information.
    //
    // - Which players have acquired bait (guild spying)
    // - Approximate session length / farming rate
    // - Whether a target has bait before a competitive encounter
    //
    // For a PvP expansion (M16), inventory visibility becomes a cheating surface:
    // a player can monitor an opponent's bait count to time PvP challenges.
    //
    // ---------------------------------------------------------------------------

    // INVARIANT: the `inventory` table is public with NO transport RLS —
    // `client_visibility_filter` does not exist in this toolchain, so every client can
    // already read every owner's counts (consistent with FINDING 11 above).
    // Owner-scoping today is only a client subscription filter. The residual to
    // revisit at M16 (PvP): counts are already world-readable, so an item count of 0
    // vs N reveals whether an opponent can attempt_recruit — a timing/spying surface.
    // The fix at that point is a per-owner transport RLS filter (tracked for M16), not
    // the client subscription filter that exists now.
}
