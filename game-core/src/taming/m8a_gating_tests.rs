//! M8a gating tests — acceptance criteria for the taming module.
//!
//! These tests are intentionally RED until the implementer makes the functions
//! in `taming::rules` and the content pipeline in `content` correct.
//!
//! EARS criteria covered:
//!   Criterion 1 — encounter_triggers + roll_encounter
//!   Criterion 2 — recruit_chance (formula, caps, guards)
//!
//! Each test is annotated with:
//!   - which EARS criterion it covers
//!   - which wrong implementation it kills
//!
//! Run: cargo test m8a_gating -- --nocapture

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

/// Kills: any impl where recruit_chance produces a value outside [0, 1000].
/// EARS C2: output is always in [0, 1000] for any valid u16 inputs.
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

/// Kills: an impl where chance doesn't rise as HP falls (monotonicity via proptest).
/// EARS C2: for fixed max/base/bait, hp1 >= hp2 → chance(hp1) <= chance(hp2).
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
// Proof-of-teeth (ADR-0010)
// Each of these fixtures is known-bad. The test passes only if the validation
// returns Err. If a stub blindly returns Ok(()), these tests are RED.
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
