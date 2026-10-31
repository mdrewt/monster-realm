//! bt-6 gating tests — BT6.1–BT6.6 (`tactics::content`). Written by the tester from the EARS
//! criteria, the frozen API in `content.rs` and the plan's geometry assignment.
//!
//! Two kinds of test live here:
//! - LIVE: the embedded RON registries (`tactics_skills/`, `tactics_species/`, `tactics_items/`,
//!   `tactics_zones/`, `battle_maps/`, `tactics_tuning.ron`) joined with the carried registries —
//!   exact values, not shapes;
//! - FIXTURE: tiny hand-built registries that isolate ONE rejection (each `TacticsContentError`
//!   variant with its offending id) and the documented check ORDER.
//!
//! `dmg_ref` oracle (hand-derived from `combat/damage.rs`, attack = defense, neutral, no STAB,
//! variance 100, no weather): `base = (2L/5 + 2) * P * A / D / 50 + 2` and every later step is the
//! identity, so `dmg_ref = (2L/5 + 2) * P / 50 + 2` in integer arithmetic:
//!   L5   (k = 4):  P20 -> 80/50 + 2 = 3     P65 -> 260/50 + 2 = 7
//!   L50  (k = 22): P20 -> 440/50 + 2 = 10   P65 -> 1430/50 + 2 = 30
//!   L100 (k = 42): P20 -> 840/50 + 2 = 18   P65 -> 2730/50 + 2 = 56
//!
//! Test names end in the criterion tag `_bt6_N`.

use std::collections::BTreeSet;

use super::ai::Stance;
use super::content::*;
use super::economy::Tier;
use super::encounter::PackWeights;
use super::geometry::{Cell, FfFilter, Origin, Shape, SkillGeometry};
use super::map::{validate_battle_map, BattleMapDef, MapError, TileDef};
use super::movement::{MoveClass, Terrain};
use super::resolve::SkillTactics;
use super::tuning::{TacticsTuning, TuningError};
use crate::combat::ability::StatusKind;
use crate::combat::weather::WeatherKind;
use crate::content::{
    load_items, load_skills, load_species, load_zones, ItemDef, SkillDef, Species, ZoneDef,
};
use crate::monster::types::{Affinity, StatBlock};

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

fn geom(min: u8, max: u8, shape: Shape, radius: u8) -> SkillGeometry {
    SkillGeometry {
        range_min: min,
        range_max: max,
        origin: Origin::TargetUnit,
        shape,
        radius,
        ff_filter: FfFilter::Enemies,
    }
}

/// A plain single-target band.
fn band(min: u8, max: u8) -> SkillGeometry {
    geom(min, max, Shape::Single, 0)
}

/// A `tactics_skills` row with a plain single-target band.
fn row(skill_id: u32, tier: Tier, min: u8, max: u8) -> TacticsSkillDef {
    row_geom(skill_id, tier, band(min, max))
}

fn row_geom(skill_id: u32, tier: Tier, g: SkillGeometry) -> TacticsSkillDef {
    TacticsSkillDef {
        skill_id,
        tier,
        range_min: g.range_min,
        range_max: g.range_max,
        origin: g.origin,
        shape: g.shape,
        radius: g.radius,
        ff_filter: g.ff_filter,
    }
}

fn sk(id: u32, power: u16, accuracy: u8, affinity: Affinity) -> SkillDef {
    SkillDef {
        id,
        name: format!("Skill{id}"),
        affinity,
        power,
        accuracy,
        pp: 20,
        sets_weather: None,
        applies_status: None,
    }
}

fn species(id: u32, speed: u16) -> Species {
    Species {
        id,
        name: format!("Species{id}"),
        base_stats: StatBlock {
            hp: 50,
            attack: 50,
            defense: 50,
            speed,
            sp_attack: 50,
            sp_defense: 50,
        },
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![1, 2],
        ability: None,
        tier: 0,
    }
}

fn srow(species_id: u32, kit: [u32; 2]) -> TacticsSpeciesDef {
    TacticsSpeciesDef {
        species_id,
        movement: MoveClass::Walk,
        role: Role::Striker,
        stance: Stance::Aggressive,
        kit,
        signature: None,
        footprint: 1,
    }
}

fn item(id: u32, cure: Option<StatusKind>) -> ItemDef {
    ItemDef {
        id,
        name: format!("Item{id}"),
        description: String::new(),
        recruit_bonus: 0,
        train_stat: None,
        train_amount: 0,
        sell_price: 10,
        cure_status: cure,
        essence_affinity: None,
        essence_amount: 0,
    }
}

fn irow(item_id: u32) -> TacticsItemDef {
    TacticsItemDef {
        item_id,
        range: 1,
        target_filter: ItemTarget::Ally,
    }
}

fn zone(id: u32) -> ZoneDef {
    ZoneDef {
        id,
        name: format!("Zone{id}"),
        width: 10,
        height: 10,
    }
}

fn weights(one: u16, two: u16, three: u16) -> PackWeights {
    PackWeights { one, two, three }
}

fn zrow(zone_id: u32, w: PackWeights, pool: Vec<u32>) -> TacticsZoneDef {
    TacticsZoneDef {
        zone_id,
        pack_weights: w,
        battle_map_pool: pool,
    }
}

fn plain_tiles(n: usize) -> Vec<TileDef> {
    vec![
        TileDef {
            terrain: Terrain::Plain,
            elevation: 0,
            blocks_los: false,
        };
        n
    ]
}

/// A valid 7x7 all-Plain map (opposing spawns 4..=8 apart, one Walk component).
fn map7() -> BattleMapDef {
    BattleMapDef {
        width: 7,
        height: 7,
        tiles: plain_tiles(49),
        spawn_a: vec![
            Cell { x: 1, y: 1 },
            Cell { x: 1, y: 3 },
            Cell { x: 1, y: 5 },
        ],
        spawn_b: vec![
            Cell { x: 5, y: 1 },
            Cell { x: 5, y: 3 },
            Cell { x: 5, y: 5 },
        ],
    }
}

/// A map bt-1's validator rejects with `Width(5)` (width is the first rule).
fn bad_map_width5() -> BattleMapDef {
    BattleMapDef { width: 5, ..map7() }
}

fn mentry(id: u32, pvp: bool, map: BattleMapDef) -> BattleMapEntry {
    BattleMapEntry {
        id,
        name: format!("Map{id}"),
        pvp,
        map,
    }
}

/// The skill-only registries for the BT6.1 fixtures (no species, so only the skill sidecar runs).
fn build_skills_only(
    skills: &[SkillDef],
    tskills: &[TacticsSkillDef],
) -> Result<Vec<SpeciesTactics>, TacticsContentError> {
    build_kits(&[], skills, tskills, &[])
}

/// Skills 1 (Light, Fire, power 20, acc 100, Poison) and 2 (Heavy, Water, power 65, acc 95).
fn base_skills() -> Vec<SkillDef> {
    let mut light = sk(1, 20, 100, Affinity::Fire);
    light.applies_status = Some(StatusKind::Poison);
    vec![light, sk(2, 65, 95, Affinity::Water)]
}

/// Light = r1..2 Single (lance), Heavy = r2..3 Single: distinct bands, a melee skill, and
/// `LongRangeMin`-clean (max 3 has min 2).
fn base_tskills() -> Vec<TacticsSkillDef> {
    vec![row(1, Tier::Light, 1, 2), row(2, Tier::Heavy, 2, 3)]
}

// ---------------------------------------------------------------------------
// Live-content bundle
// ---------------------------------------------------------------------------

struct Live {
    species: Vec<Species>,
    skills: Vec<SkillDef>,
    items: Vec<ItemDef>,
    zones: Vec<ZoneDef>,
    tskills: Vec<TacticsSkillDef>,
    tspecies: Vec<TacticsSpeciesDef>,
    titems: Vec<TacticsItemDef>,
    tzones: Vec<TacticsZoneDef>,
    maps: Vec<BattleMapEntry>,
    tuning: TacticsTuning,
}

fn live() -> Live {
    Live {
        species: load_species().expect("species RON"),
        skills: load_skills().expect("skills RON"),
        items: load_items().expect("items RON"),
        zones: load_zones().expect("zones RON"),
        tskills: load_tactics_skills().expect("tactics_skills RON"),
        tspecies: load_tactics_species().expect("tactics_species RON"),
        titems: load_tactics_items().expect("tactics_items RON"),
        tzones: load_tactics_zones().expect("tactics_zones RON"),
        maps: load_battle_maps().expect("battle_maps RON"),
        tuning: load_tactics_tuning().expect("tactics_tuning RON"),
    }
}

fn live_kits(l: &Live) -> Vec<SpeciesTactics> {
    build_kits(&l.species, &l.skills, &l.tskills, &l.tspecies).expect("live build_kits")
}

fn skill_by_id(l: &Live, id: u32) -> &SkillDef {
    l.skills
        .iter()
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("live skill {id}"))
}

fn tskill_by_id(l: &Live, id: u32) -> &TacticsSkillDef {
    l.tskills
        .iter()
        .find(|s| s.skill_id == id)
        .unwrap_or_else(|| panic!("live tactics_skills row {id}"))
}

// ---------------------------------------------------------------------------
// Fixture registries for validate_tactics_content (everything valid)
// ---------------------------------------------------------------------------

struct Fx {
    species: Vec<Species>,
    skills: Vec<SkillDef>,
    items: Vec<ItemDef>,
    zones: Vec<ZoneDef>,
    tskills: Vec<TacticsSkillDef>,
    tspecies: Vec<TacticsSpeciesDef>,
    titems: Vec<TacticsItemDef>,
    tzones: Vec<TacticsZoneDef>,
    maps: Vec<BattleMapEntry>,
    tuning: TacticsTuning,
}

impl Fx {
    fn good() -> Fx {
        Fx {
            species: vec![species(1, 40)],
            skills: base_skills(),
            items: vec![item(1, None), item(3, Some(StatusKind::Poison))],
            zones: vec![zone(0)],
            tskills: base_tskills(),
            tspecies: vec![srow(1, [1, 2])],
            titems: vec![irow(3)],
            tzones: vec![zrow(0, PackWeights::DEFAULT, vec![1])],
            maps: vec![mentry(1, false, map7())],
            tuning: TacticsTuning::DESIGN,
        }
    }

    fn reg(&self) -> TacticsRegistries<'_> {
        TacticsRegistries {
            species: &self.species,
            skills: &self.skills,
            items: &self.items,
            zones: &self.zones,
            tactics_skills: &self.tskills,
            tactics_species: &self.tspecies,
            tactics_items: &self.titems,
            tactics_zones: &self.tzones,
            battle_maps: &self.maps,
            tuning: &self.tuning,
        }
    }

    fn validate(&self) -> Result<Vec<SpeciesTactics>, TacticsContentError> {
        validate_tactics_content(&self.reg())
    }
}

// ---------------------------------------------------------------------------
// Lint fixtures (already-joined kits)
// ---------------------------------------------------------------------------

fn st(id: u32, tier: Tier, power: u16, geometry: SkillGeometry) -> SkillTactics {
    SkillTactics {
        skill_id: id,
        tier,
        affinity: Affinity::Fire,
        power,
        accuracy: 100,
        applies_status: None,
        geometry,
    }
}

fn kit(
    species_id: u32,
    base_speed: u16,
    light: SkillTactics,
    heavy: SkillTactics,
) -> SpeciesTactics {
    SpeciesTactics {
        species_id,
        base_speed,
        movement: MoveClass::Walk,
        role: Role::Striker,
        stance: Stance::Aggressive,
        light,
        heavy,
    }
}

/// Light (id 1, power 20, geometry `lg`), Heavy (id 2, power 65, geometry `hg`).
fn std_kit(
    species_id: u32,
    base_speed: u16,
    lg: SkillGeometry,
    hg: SkillGeometry,
) -> SpeciesTactics {
    kit(
        species_id,
        base_speed,
        st(1, Tier::Light, 20, lg),
        st(2, Tier::Heavy, 65, hg),
    )
}

// ===========================================================================
// BT6.1 — tactics_skills + the skill retune
// ===========================================================================

/// Every loaded skill id has exactly one `tactics_skills` row, and no row names an unknown id.
#[test]
fn tactics_skills_cover_loaded_skills_exactly_once_bt6_1() {
    let l = live();
    let mut loaded: Vec<u32> = l.skills.iter().map(|s| s.id).collect();
    let mut rows: Vec<u32> = l.tskills.iter().map(|r| r.skill_id).collect();
    loaded.sort_unstable();
    rows.sort_unstable();
    assert_eq!(
        loaded,
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 40, 41, 42, 43],
        "the loaded skill roster is the 15 shipped ids"
    );
    assert_eq!(
        rows, loaded,
        "tactics_skills must hold exactly one row per loaded skill id (sorted, so a duplicate or an unknown id shows)"
    );
}

/// The Lights (1 Ember, 3 Water Gun, 40 Spark, 42 Glimmer, 4 Aqua Jet, 5 Vine Whip) and 11 Toxic
/// Sting are power 20 and tier Light.
#[test]
fn lights_are_power_20_and_tier_light_bt6_1() {
    let l = live();
    for id in [1u32, 3, 40, 42, 4, 5, 11] {
        assert_eq!(skill_by_id(&l, id).power, 20, "skill {id} power");
        assert_eq!(tskill_by_id(&l, id).tier, Tier::Light, "skill {id} tier");
    }
}

/// The Heavies (2, 6, 41, 43) are tier Heavy with power in 65..=75; Razor Leaf (6) is exactly 65.
#[test]
fn heavies_are_tier_heavy_with_power_65_to_75_bt6_1() {
    let l = live();
    for id in [2u32, 6, 41, 43] {
        let power = skill_by_id(&l, id).power;
        assert!(
            (65..=75).contains(&power),
            "heavy skill {id} power {power} must be in 65..=75"
        );
        assert_eq!(tskill_by_id(&l, id).tier, Tier::Heavy, "skill {id} tier");
    }
    assert_eq!(skill_by_id(&l, 6).power, 65, "Razor Leaf is retuned to 65");
}

/// The weather setters (7..=10) have a tactics row but appear in no species kit.
#[test]
fn weather_setters_have_a_row_but_are_in_no_kit_bt6_1() {
    let l = live();
    for id in [7u32, 8, 9, 10] {
        assert!(
            skill_by_id(&l, id).sets_weather.is_some(),
            "skill {id} is a weather setter"
        );
        assert_eq!(
            l.tskills.iter().filter(|r| r.skill_id == id).count(),
            1,
            "weather setter {id} still needs exactly one tactics_skills row"
        );
        for sp in &l.tspecies {
            assert!(
                !sp.kit.contains(&id),
                "species {} kit {:?} must not carry weather setter {id}",
                sp.species_id,
                sp.kit
            );
        }
    }
}

/// The retune is values-only for accuracy: the full id -> accuracy table is the pre-retune one.
#[test]
fn skill_accuracy_is_unchanged_by_the_retune_bt6_1() {
    let l = live();
    let expected: [(u32, u8); 15] = [
        (1, 100),
        (2, 95),
        (3, 100),
        (4, 100),
        (5, 100),
        (6, 95),
        (7, 100),
        (8, 100),
        (9, 90),
        (10, 90),
        (11, 100),
        (40, 100),
        (41, 95),
        (42, 100),
        (43, 90),
    ];
    let got: Vec<(u32, u8)> = {
        let mut v: Vec<(u32, u8)> = l.skills.iter().map(|s| (s.id, s.accuracy)).collect();
        v.sort_unstable();
        v
    };
    assert_eq!(got, expected.to_vec());
}

/// `geometry()` copies every geometry field of the row (and only those).
#[test]
fn tactics_skill_geometry_copies_every_field_bt6_1() {
    let r = TacticsSkillDef {
        skill_id: 77,
        tier: Tier::Heavy,
        range_min: 2,
        range_max: 3,
        origin: Origin::Caster,
        shape: Shape::Diamond,
        radius: 1,
        ff_filter: FfFilter::AllButSelf,
    };
    assert_eq!(
        r.geometry(),
        SkillGeometry {
            range_min: 2,
            range_max: 3,
            origin: Origin::Caster,
            shape: Shape::Diamond,
            radius: 1,
            ff_filter: FfFilter::AllButSelf,
        }
    );
}

#[test]
fn build_kits_rejects_a_duplicate_skill_row_bt6_1() {
    let skills = vec![
        sk(1, 20, 100, Affinity::Fire),
        sk(2, 65, 95, Affinity::Water),
    ];
    let rows = vec![
        row(1, Tier::Light, 1, 1),
        row(2, Tier::Heavy, 1, 1),
        row(1, Tier::Light, 1, 1),
    ];
    assert_eq!(
        build_skills_only(&skills, &rows),
        Err(TacticsContentError::DuplicateSkillEntry(1))
    );
}

#[test]
fn build_kits_rejects_an_unknown_skill_row_bt6_1() {
    let skills = vec![sk(1, 20, 100, Affinity::Fire)];
    let rows = vec![row(1, Tier::Light, 1, 1), row(99, Tier::Light, 1, 1)];
    assert_eq!(
        build_skills_only(&skills, &rows),
        Err(TacticsContentError::UnknownSkill(99))
    );
}

#[test]
fn build_kits_rejects_a_loaded_skill_without_a_row_bt6_1() {
    let skills = vec![
        sk(1, 20, 100, Affinity::Fire),
        sk(2, 65, 95, Affinity::Water),
    ];
    let rows = vec![row(1, Tier::Light, 1, 1)];
    assert_eq!(
        build_skills_only(&skills, &rows),
        Err(TacticsContentError::MissingSkillEntry(2))
    );
}

/// Duplicate beats unknown beats missing (the documented skill-sidecar order).
#[test]
fn skill_sidecar_check_order_is_duplicate_unknown_missing_bt6_1() {
    let skills = vec![
        sk(1, 20, 100, Affinity::Fire),
        sk(2, 65, 95, Affinity::Water),
    ];
    // Row 2 is missing AND row 1 is duplicated: Duplicate wins.
    let dup_and_missing = vec![row(1, Tier::Light, 1, 1), row(1, Tier::Light, 1, 1)];
    assert_eq!(
        build_skills_only(&skills, &dup_and_missing),
        Err(TacticsContentError::DuplicateSkillEntry(1))
    );
    // Row 2 is missing AND row 99 is unknown: Unknown wins.
    let unknown_and_missing = vec![row(1, Tier::Light, 1, 1), row(99, Tier::Light, 1, 1)];
    assert_eq!(
        build_skills_only(&skills, &unknown_and_missing),
        Err(TacticsContentError::UnknownSkill(99))
    );
    // Duplicate of an UNKNOWN id: Duplicate still wins.
    let dup_unknown = vec![
        row(1, Tier::Light, 1, 1),
        row(2, Tier::Heavy, 1, 1),
        row(99, Tier::Light, 1, 1),
        row(99, Tier::Light, 1, 1),
    ];
    assert_eq!(
        build_skills_only(&skills, &dup_unknown),
        Err(TacticsContentError::DuplicateSkillEntry(99))
    );
}

/// A geometry `target_set` cannot run is `BadGeometry(skill_id)`: inverted range, a radius the
/// shape forbids, and the reserved Line shape.
#[test]
fn build_kits_rejects_unrunnable_geometry_bt6_1() {
    let skills = vec![sk(7, 20, 100, Affinity::Fire)];
    let cases: [(&str, SkillGeometry); 5] = [
        ("range_min > range_max", band(3, 2)),
        ("Single with radius 1", geom(1, 1, Shape::Single, 1)),
        ("Line (reserved)", geom(1, 1, Shape::Line, 0)),
        ("Cone (reserved)", geom(1, 1, Shape::Cone, 0)),
        ("Burst with radius 0", geom(0, 0, Shape::Burst, 0)),
    ];
    for (label, g) in cases {
        let rows = vec![row_geom(7, Tier::Light, g)];
        assert_eq!(
            build_skills_only(&skills, &rows),
            Err(TacticsContentError::BadGeometry(7)),
            "{label}"
        );
    }
}

/// `range_max >= 3` needs `range_min == 2`: r2..3 is accepted, r1..3 and r3..3 are not.
#[test]
fn build_kits_enforces_long_range_min_of_two_bt6_1() {
    let skills = vec![sk(7, 20, 100, Affinity::Fire)];
    assert_eq!(
        build_skills_only(&skills, &[row(7, Tier::Light, 2, 3)]),
        Ok(vec![]),
        "r2..3 is the legal long band"
    );
    assert_eq!(
        build_skills_only(&skills, &[row(7, Tier::Light, 1, 3)]),
        Err(TacticsContentError::LongRangeMin(7)),
        "r1..3"
    );
    assert_eq!(
        build_skills_only(&skills, &[row(7, Tier::Light, 3, 3)]),
        Err(TacticsContentError::LongRangeMin(7)),
        "r3..3"
    );
    // max 2 has no min constraint beyond the geometry's own.
    assert_eq!(
        build_skills_only(&skills, &[row(7, Tier::Light, 1, 2)]),
        Ok(vec![]),
        "r1..2 is a lance, not a long band"
    );
}

/// `ff_filter = All` with `origin != TargetUnit` is `AllNeedsTargetOrigin(skill_id)`.
#[test]
fn build_kits_rejects_all_filter_without_target_origin_bt6_1() {
    let skills = vec![sk(9, 20, 100, Affinity::Fire)];
    let caster_all = SkillGeometry {
        range_min: 0,
        range_max: 0,
        origin: Origin::Caster,
        shape: Shape::Burst,
        radius: 1,
        ff_filter: FfFilter::All,
    };
    assert_eq!(
        build_skills_only(&skills, &[row_geom(9, Tier::Light, caster_all)]),
        Err(TacticsContentError::AllNeedsTargetOrigin(9))
    );
    // Control: the same filter from a TargetUnit origin is legal.
    let target_all = SkillGeometry {
        origin: Origin::TargetUnit,
        range_min: 1,
        range_max: 1,
        ..caster_all
    };
    assert_eq!(
        build_skills_only(&skills, &[row_geom(9, Tier::Light, target_all)]),
        Ok(vec![])
    );
}

/// Within one row: BadGeometry before LongRangeMin before AllNeedsTargetOrigin.
#[test]
fn per_row_skill_checks_run_geometry_then_long_range_then_all_bt6_1() {
    let skills = vec![sk(5, 20, 100, Affinity::Fire)];
    // r1..3 (LongRangeMin) AND Single radius 1 (BadGeometry): geometry first.
    let both = geom(1, 3, Shape::Single, 1);
    assert_eq!(
        build_skills_only(&skills, &[row_geom(5, Tier::Light, both)]),
        Err(TacticsContentError::BadGeometry(5))
    );
    // r1..3 (LongRangeMin) AND All+Caster (AllNeedsTargetOrigin): long-range first.
    let long_all = SkillGeometry {
        range_min: 1,
        range_max: 3,
        origin: Origin::Caster,
        shape: Shape::Single,
        radius: 0,
        ff_filter: FfFilter::All,
    };
    assert_eq!(
        build_skills_only(&skills, &[row_geom(5, Tier::Light, long_all)]),
        Err(TacticsContentError::LongRangeMin(5))
    );
}

// ===========================================================================
// BT6.2 — tactics_species + the kit join
// ===========================================================================

#[test]
fn tactics_species_cover_loaded_species_exactly_once_bt6_2() {
    let l = live();
    let mut loaded: Vec<u32> = l.species.iter().map(|s| s.id).collect();
    let mut rows: Vec<u32> = l.tspecies.iter().map(|r| r.species_id).collect();
    loaded.sort_unstable();
    rows.sort_unstable();
    assert!(!loaded.is_empty(), "the species registry is not empty");
    assert_eq!(
        rows, loaded,
        "tactics_species must hold exactly one row per loaded species id"
    );
}

#[test]
fn live_species_levers_are_dormant_bt6_2() {
    let l = live();
    for r in &l.tspecies {
        assert_eq!(r.signature, None, "species {} signature", r.species_id);
        assert_eq!(r.footprint, 1, "species {} footprint", r.species_id);
    }
}

/// The live join: one `SpeciesTactics` per row (in row order), light is a Light and heavy a Heavy,
/// both carry the carried skill's power / accuracy / affinity / status and the sidecar geometry.
#[test]
fn live_build_kits_joins_carried_and_sidecar_fields_bt6_2() {
    let l = live();
    let kits = live_kits(&l);
    assert_eq!(
        kits.len(),
        l.tspecies.len(),
        "one kit per tactics_species row"
    );
    for (k, r) in kits.iter().zip(&l.tspecies) {
        assert_eq!(k.species_id, r.species_id, "kit order follows row order");
        let sp = l
            .species
            .iter()
            .find(|s| s.id == k.species_id)
            .expect("species");
        assert_eq!(
            k.base_speed, sp.base_stats.speed,
            "species {} base_speed",
            k.species_id
        );
        assert_eq!(k.movement, r.movement, "species {} movement", k.species_id);
        assert_eq!(k.role, r.role, "species {} role", k.species_id);
        assert_eq!(k.stance, r.stance, "species {} stance", k.species_id);
        assert_eq!(
            k.light.skill_id, r.kit[0],
            "species {} light id",
            k.species_id
        );
        assert_eq!(
            k.heavy.skill_id, r.kit[1],
            "species {} heavy id",
            k.species_id
        );
        assert_eq!(
            k.light.tier,
            Tier::Light,
            "species {} light tier",
            k.species_id
        );
        assert_eq!(
            k.heavy.tier,
            Tier::Heavy,
            "species {} heavy tier",
            k.species_id
        );
        for s in [&k.light, &k.heavy] {
            let carried = skill_by_id(&l, s.skill_id);
            assert_eq!(s.power, carried.power, "skill {} power", s.skill_id);
            assert_eq!(
                s.accuracy, carried.accuracy,
                "skill {} accuracy",
                s.skill_id
            );
            assert_eq!(
                s.affinity, carried.affinity,
                "skill {} affinity",
                s.skill_id
            );
            assert_eq!(
                s.applies_status, carried.applies_status,
                "skill {} applies_status",
                s.skill_id
            );
            assert_eq!(
                s.geometry,
                tskill_by_id(&l, s.skill_id).geometry(),
                "skill {} sidecar geometry",
                s.skill_id
            );
        }
        let (lg, hg) = (&k.light.geometry, &k.heavy.geometry);
        assert!(
            (lg.range_min, lg.range_max, lg.shape) != (hg.range_min, hg.range_max, hg.shape),
            "species {} light and heavy must not share range band AND shape",
            k.species_id
        );
    }
    assert!(
        kits.iter()
            .any(|k| k.light.geometry.range_min == 1 || k.heavy.geometry.range_min == 1),
        "at least one live kit has a melee (range_min 1) skill"
    );
}

/// KNOWN GAP (plan "KNOWN GAP -> DEFER BT6.2"): ten species ship a provisional kit that is not a
/// subset of their `learnable_skill_ids` (no Water/Dark/Earth/Wind Heavy exists yet). This pins the
/// exact set so the follow-up that fixes the species RON flips it to the empty set; it must NOT
/// silently grow.
#[test]
fn kit_outside_learnable_set_is_pinned_bt6_2() {
    let l = live();
    let outside: BTreeSet<u32> = live_kits(&l)
        .iter()
        .filter(|k| {
            let sp = l
                .species
                .iter()
                .find(|s| s.id == k.species_id)
                .expect("species");
            !(sp.learnable_skill_ids.contains(&k.light.skill_id)
                && sp.learnable_skill_ids.contains(&k.heavy.skill_id))
        })
        .map(|k| k.species_id)
        .collect();
    let expected: BTreeSet<u32> = [2u32, 6, 7, 8, 9, 20, 21, 22, 23, 30].into_iter().collect();
    assert_eq!(outside, expected);
}

/// Fixture join: every output field comes from the right source.
#[test]
fn build_kits_fixture_join_is_exact_bt6_2() {
    let skills = base_skills();
    let mut sp = species(1, 73);
    sp.learnable_skill_ids = vec![1, 2];
    let mut srow1 = srow(1, [1, 2]);
    srow1.movement = MoveClass::Swim;
    srow1.role = Role::Support;
    srow1.stance = Stance::Skittish;
    let got = build_kits(&[sp], &skills, &base_tskills(), &[srow1]);
    assert_eq!(
        got,
        Ok(vec![SpeciesTactics {
            species_id: 1,
            base_speed: 73,
            movement: MoveClass::Swim,
            role: Role::Support,
            stance: Stance::Skittish,
            light: SkillTactics {
                skill_id: 1,
                tier: Tier::Light,
                affinity: Affinity::Fire,
                power: 20,
                accuracy: 100,
                applies_status: Some(StatusKind::Poison),
                geometry: band(1, 2),
            },
            heavy: SkillTactics {
                skill_id: 2,
                tier: Tier::Heavy,
                affinity: Affinity::Water,
                power: 65,
                accuracy: 95,
                applies_status: None,
                geometry: band(2, 3),
            },
        }])
    );
}

#[test]
fn build_kits_rejects_a_duplicate_species_row_bt6_2() {
    let rows = vec![srow(1, [1, 2]), srow(1, [1, 2])];
    assert_eq!(
        build_kits(&[species(1, 40)], &base_skills(), &base_tskills(), &rows),
        Err(TacticsContentError::DuplicateSpeciesEntry(1))
    );
}

#[test]
fn build_kits_rejects_an_unknown_species_row_bt6_2() {
    let rows = vec![srow(1, [1, 2]), srow(99, [1, 2])];
    assert_eq!(
        build_kits(&[species(1, 40)], &base_skills(), &base_tskills(), &rows),
        Err(TacticsContentError::UnknownSpecies(99))
    );
}

#[test]
fn build_kits_rejects_a_loaded_species_without_a_row_bt6_2() {
    let rows = vec![srow(1, [1, 2])];
    assert_eq!(
        build_kits(
            &[species(1, 40), species(2, 40)],
            &base_skills(),
            &base_tskills(),
            &rows
        ),
        Err(TacticsContentError::MissingSpeciesEntry(2))
    );
}

/// Duplicate beats unknown beats missing for the species sidecar too.
#[test]
fn species_sidecar_check_order_is_duplicate_unknown_missing_bt6_2() {
    let sp = [species(1, 40), species(2, 40)];
    let dup_unknown = vec![srow(99, [1, 2]), srow(99, [1, 2])];
    assert_eq!(
        build_kits(&sp, &base_skills(), &base_tskills(), &dup_unknown),
        Err(TacticsContentError::DuplicateSpeciesEntry(99))
    );
    let unknown_missing = vec![srow(1, [1, 2]), srow(99, [1, 2])];
    assert_eq!(
        build_kits(&sp, &base_skills(), &base_tskills(), &unknown_missing),
        Err(TacticsContentError::UnknownSpecies(99))
    );
}

/// The skill sidecar is checked before the species sidecar.
#[test]
fn skill_sidecar_errors_come_before_species_errors_bt6_2() {
    let mut tskills = base_tskills();
    tskills.push(row(1, Tier::Light, 1, 1)); // duplicate skill row
    let rows = vec![srow(1, [1, 2]), srow(1, [1, 2])]; // AND a duplicate species row
    assert_eq!(
        build_kits(&[species(1, 40)], &base_skills(), &tskills, &rows),
        Err(TacticsContentError::DuplicateSkillEntry(1))
    );
}

#[test]
fn build_kits_rejects_a_dormant_signature_bt6_2() {
    let mut r = srow(1, [1, 2]);
    r.signature = Some(2);
    assert_eq!(
        build_kits(&[species(1, 40)], &base_skills(), &base_tskills(), &[r]),
        Err(TacticsContentError::DormantLever(1))
    );
}

#[test]
fn build_kits_rejects_a_dormant_footprint_bt6_2() {
    let mut r = srow(1, [1, 2]);
    r.footprint = 2;
    assert_eq!(
        build_kits(&[species(1, 40)], &base_skills(), &base_tskills(), &[r]),
        Err(TacticsContentError::DormantLever(1))
    );
    let mut zero = srow(1, [1, 2]);
    zero.footprint = 0;
    assert_eq!(
        build_kits(&[species(1, 40)], &base_skills(), &base_tskills(), &[zero]),
        Err(TacticsContentError::DormantLever(1)),
        "footprint 0 is also not the dormant 1"
    );
}

/// `kit[0]` must be a Light: a Heavy there is `KitTier` naming that skill.
#[test]
fn build_kits_rejects_a_heavy_in_the_light_slot_bt6_2() {
    assert_eq!(
        build_kits(
            &[species(4, 40)],
            &base_skills(),
            &base_tskills(),
            &[srow(4, [2, 2])]
        ),
        Err(TacticsContentError::KitTier {
            species_id: 4,
            skill_id: 2
        })
    );
}

/// `kit[1]` must be a Heavy: a Light there is `KitTier` naming that skill.
#[test]
fn build_kits_rejects_a_light_in_the_heavy_slot_bt6_2() {
    assert_eq!(
        build_kits(
            &[species(4, 40)],
            &base_skills(),
            &base_tskills(),
            &[srow(4, [1, 1])]
        ),
        Err(TacticsContentError::KitTier {
            species_id: 4,
            skill_id: 1
        })
    );
}

/// A weather setter in either slot is `KitWeatherSetter` (tier-correct, so KitTier cannot fire).
#[test]
fn build_kits_rejects_a_weather_setter_in_a_kit_bt6_2() {
    let mut skills = base_skills();
    let mut rain_light = sk(3, 20, 100, Affinity::Water);
    rain_light.sets_weather = Some(WeatherKind::Rain);
    let mut sun_heavy = sk(4, 65, 95, Affinity::Fire);
    sun_heavy.sets_weather = Some(WeatherKind::Sun);
    skills.push(rain_light);
    skills.push(sun_heavy);
    let mut tskills = base_tskills();
    tskills.push(row(3, Tier::Light, 1, 1));
    tskills.push(row(4, Tier::Heavy, 2, 3));

    assert_eq!(
        build_kits(&[species(6, 40)], &skills, &tskills, &[srow(6, [3, 2])]),
        Err(TacticsContentError::KitWeatherSetter {
            species_id: 6,
            skill_id: 3
        }),
        "weather setter in the Light slot"
    );
    assert_eq!(
        build_kits(&[species(6, 40)], &skills, &tskills, &[srow(6, [1, 4])]),
        Err(TacticsContentError::KitWeatherSetter {
            species_id: 6,
            skill_id: 4
        }),
        "weather setter in the Heavy slot"
    );
}

/// Per row: DormantLever, then KitTier, then KitWeatherSetter.
#[test]
fn per_row_species_checks_run_dormant_then_tier_then_weather_bt6_2() {
    let mut skills = base_skills();
    let mut rain_heavy = sk(3, 65, 95, Affinity::Water);
    rain_heavy.sets_weather = Some(WeatherKind::Rain);
    skills.push(rain_heavy);
    let mut tskills = base_tskills();
    tskills.push(row(3, Tier::Heavy, 2, 3));

    // Dormant signature AND a Heavy in the Light slot: DormantLever first.
    let mut both = srow(1, [2, 2]);
    both.signature = Some(1);
    assert_eq!(
        build_kits(&[species(1, 40)], &skills, &tskills, &[both]),
        Err(TacticsContentError::DormantLever(1))
    );
    // A weather-setting Heavy in the Light slot is a tier violation AND a weather violation:
    // KitTier first.
    assert_eq!(
        build_kits(&[species(1, 40)], &skills, &tskills, &[srow(1, [3, 2])]),
        Err(TacticsContentError::KitTier {
            species_id: 1,
            skill_id: 3
        })
    );
}

// ===========================================================================
// BT6.3 — tactics_items + tactics_zones
// ===========================================================================

#[test]
fn tactics_items_are_exactly_the_battle_usable_items_bt6_3() {
    let l = live();
    let usable: Vec<u32> = l
        .items
        .iter()
        .filter(|i| i.cure_status.is_some())
        .map(|i| i.id)
        .collect();
    let mut rows: Vec<u32> = l.titems.iter().map(|r| r.item_id).collect();
    rows.sort_unstable();
    assert_eq!(usable, vec![3], "today only Antidote cures a status");
    assert_eq!(
        rows, usable,
        "one tactics_items row per battle-usable item, no extras"
    );
}

#[test]
fn tactics_zones_cover_loaded_zones_with_valid_packs_and_pools_bt6_3() {
    let l = live();
    assert!(!l.zones.is_empty(), "zones are loaded");
    let mut loaded: Vec<u32> = l.zones.iter().map(|z| z.id).collect();
    let mut rows: Vec<u32> = l.tzones.iter().map(|r| r.zone_id).collect();
    loaded.sort_unstable();
    rows.sort_unstable();
    assert_eq!(
        rows, loaded,
        "exactly one tactics_zones row per loaded zone"
    );
    for z in &l.tzones {
        let w = &z.pack_weights;
        let sum = u32::from(w.one) + u32::from(w.two) + u32::from(w.three);
        assert_eq!(sum, 1000, "zone {} pack weights sum", z.zone_id);
        assert!(!z.battle_map_pool.is_empty(), "zone {} pool", z.zone_id);
        for m in &z.battle_map_pool {
            let entry =
                l.maps.iter().find(|e| e.id == *m).unwrap_or_else(|| {
                    panic!("zone {} pool map {m} must be a loaded map", z.zone_id)
                });
            assert!(
                !entry.pvp,
                "zone {} pool map {m} must not be PvP",
                z.zone_id
            );
        }
    }
}

#[test]
fn validate_tactics_items_accepts_the_live_and_a_fixture_registry_bt6_3() {
    let l = live();
    assert_eq!(validate_tactics_items(&l.items, &l.titems), Ok(()));
    let items = vec![item(1, None), item(3, Some(StatusKind::Poison))];
    assert_eq!(validate_tactics_items(&items, &[irow(3)]), Ok(()));
}

#[test]
fn validate_tactics_items_rejects_a_duplicate_row_bt6_3() {
    let items = vec![item(3, Some(StatusKind::Poison))];
    assert_eq!(
        validate_tactics_items(&items, &[irow(3), irow(3)]),
        Err(TacticsContentError::DuplicateItemEntry(3))
    );
}

/// A row for a loaded item that is not battle-usable (Lure Berry, id 1) and a row for an unloaded
/// id (999) are both `NotBattleUsable`.
#[test]
fn validate_tactics_items_rejects_a_non_battle_usable_row_bt6_3() {
    let items = vec![item(1, None), item(3, Some(StatusKind::Poison))];
    assert_eq!(
        validate_tactics_items(&items, &[irow(3), irow(1)]),
        Err(TacticsContentError::NotBattleUsable(1)),
        "item 1 is loaded but has no cure_status"
    );
    assert_eq!(
        validate_tactics_items(&items, &[irow(3), irow(999)]),
        Err(TacticsContentError::NotBattleUsable(999)),
        "item 999 is not loaded"
    );
}

#[test]
fn validate_tactics_items_rejects_an_uncovered_battle_usable_item_bt6_3() {
    let items = vec![
        item(3, Some(StatusKind::Poison)),
        item(8, Some(StatusKind::Burn)),
    ];
    assert_eq!(
        validate_tactics_items(&items, &[irow(3)]),
        Err(TacticsContentError::MissingItemEntry(8))
    );
}

/// Duplicate, then NotBattleUsable, then Missing.
#[test]
fn item_sidecar_check_order_is_duplicate_usable_missing_bt6_3() {
    let items = vec![item(3, Some(StatusKind::Poison))];
    assert_eq!(
        validate_tactics_items(&items, &[irow(999), irow(999)]),
        Err(TacticsContentError::DuplicateItemEntry(999)),
        "a duplicated unusable row is reported as a duplicate"
    );
    assert_eq!(
        validate_tactics_items(&items, &[irow(999)]),
        Err(TacticsContentError::NotBattleUsable(999)),
        "an unusable row is reported before the uncovered item 3"
    );
}

fn zone_maps() -> Vec<BattleMapEntry> {
    vec![mentry(1, false, map7()), mentry(2, true, map7())]
}

#[test]
fn validate_tactics_zones_accepts_the_live_and_a_fixture_registry_bt6_3() {
    let l = live();
    assert_eq!(validate_tactics_zones(&l.zones, &l.tzones, &l.maps), Ok(()));
    assert_eq!(
        validate_tactics_zones(
            &[zone(0)],
            &[zrow(0, PackWeights::DEFAULT, vec![1])],
            &zone_maps()
        ),
        Ok(())
    );
}

#[test]
fn validate_tactics_zones_rejects_a_duplicate_row_bt6_3() {
    let rows = vec![
        zrow(0, PackWeights::DEFAULT, vec![1]),
        zrow(0, PackWeights::DEFAULT, vec![1]),
    ];
    assert_eq!(
        validate_tactics_zones(&[zone(0)], &rows, &zone_maps()),
        Err(TacticsContentError::DuplicateZoneEntry(0))
    );
}

#[test]
fn validate_tactics_zones_rejects_an_unknown_zone_bt6_3() {
    let rows = vec![
        zrow(0, PackWeights::DEFAULT, vec![1]),
        zrow(42, PackWeights::DEFAULT, vec![1]),
    ];
    assert_eq!(
        validate_tactics_zones(&[zone(0)], &rows, &zone_maps()),
        Err(TacticsContentError::UnknownZone(42))
    );
}

#[test]
fn validate_tactics_zones_rejects_an_uncovered_zone_bt6_3() {
    let rows = vec![zrow(0, PackWeights::DEFAULT, vec![1])];
    assert_eq!(
        validate_tactics_zones(&[zone(0), zone(5)], &rows, &zone_maps()),
        Err(TacticsContentError::MissingZoneEntry(5))
    );
}

/// 600/300/99 sums to 999, not 1000.
#[test]
fn validate_tactics_zones_rejects_weights_not_summing_to_1000_bt6_3() {
    let rows = vec![zrow(0, weights(600, 300, 99), vec![1])];
    assert_eq!(
        validate_tactics_zones(&[zone(0)], &rows, &zone_maps()),
        Err(TacticsContentError::PackWeights {
            zone_id: 0,
            sum: 999
        })
    );
    let over = vec![zrow(0, weights(600, 300, 101), vec![1])];
    assert_eq!(
        validate_tactics_zones(&[zone(0)], &over, &zone_maps()),
        Err(TacticsContentError::PackWeights {
            zone_id: 0,
            sum: 1001
        })
    );
}

/// 30000 + 30000 + 6536 wraps a u16 sum to 1000; the reported (and checked) sum is the true u32.
#[test]
fn zone_weight_sum_does_not_wrap_a_u16_bt6_3() {
    let rows = vec![zrow(0, weights(30_000, 30_000, 6_536), vec![1])];
    assert_eq!(
        validate_tactics_zones(&[zone(0)], &rows, &zone_maps()),
        Err(TacticsContentError::PackWeights {
            zone_id: 0,
            sum: 66_536
        })
    );
}

#[test]
fn validate_tactics_zones_rejects_an_empty_pool_bt6_3() {
    let rows = vec![zrow(0, PackWeights::DEFAULT, vec![])];
    assert_eq!(
        validate_tactics_zones(&[zone(0)], &rows, &zone_maps()),
        Err(TacticsContentError::EmptyMapPool(0))
    );
}

/// A pool id naming no loaded map, and one naming a PvP map, are both `PoolMap`.
#[test]
fn validate_tactics_zones_rejects_a_bad_pool_map_bt6_3() {
    let unknown = vec![zrow(0, PackWeights::DEFAULT, vec![1, 77])];
    assert_eq!(
        validate_tactics_zones(&[zone(0)], &unknown, &zone_maps()),
        Err(TacticsContentError::PoolMap {
            zone_id: 0,
            map_id: 77
        })
    );
    let pvp = vec![zrow(0, PackWeights::DEFAULT, vec![1, 2])];
    assert_eq!(
        validate_tactics_zones(&[zone(0)], &pvp, &zone_maps()),
        Err(TacticsContentError::PoolMap {
            zone_id: 0,
            map_id: 2
        })
    );
}

/// Duplicate, unknown, missing run before any per-row check; per row, weights before the pool.
#[test]
fn zone_sidecar_check_order_bt6_3() {
    let maps = zone_maps();
    // Zone 5 is uncovered; zone 0's weights are bad: the coverage error wins.
    let bad_weights = vec![zrow(0, weights(1, 1, 1), vec![1])];
    assert_eq!(
        validate_tactics_zones(&[zone(0), zone(5)], &bad_weights, &maps),
        Err(TacticsContentError::MissingZoneEntry(5))
    );
    // Bad weights AND an empty pool: PackWeights first.
    let weights_and_pool = vec![zrow(0, weights(1, 1, 1), vec![])];
    assert_eq!(
        validate_tactics_zones(&[zone(0)], &weights_and_pool, &maps),
        Err(TacticsContentError::PackWeights { zone_id: 0, sum: 3 })
    );
    // Duplicate of an unknown zone: Duplicate wins.
    let dup_unknown = vec![
        zrow(0, PackWeights::DEFAULT, vec![1]),
        zrow(9, PackWeights::DEFAULT, vec![1]),
        zrow(9, PackWeights::DEFAULT, vec![1]),
    ];
    assert_eq!(
        validate_tactics_zones(&[zone(0)], &dup_unknown, &maps),
        Err(TacticsContentError::DuplicateZoneEntry(9))
    );
}

// ===========================================================================
// BT6.4 — battle maps + tactics_tuning.ron
// ===========================================================================

fn has_terrain(m: &BattleMapDef, t: Terrain) -> bool {
    m.tiles.iter().any(|tile| tile.terrain == t)
}

#[test]
fn live_battle_maps_have_the_pinned_shape_bt6_4() {
    let l = live();
    assert_eq!(l.maps.len(), 8, "exactly 8 maps");
    let ids: BTreeSet<u32> = l.maps.iter().map(|m| m.id).collect();
    assert_eq!(ids.len(), 8, "map ids are unique");
    let pve: Vec<&BattleMapEntry> = l.maps.iter().filter(|m| !m.pvp).collect();
    let pvp: Vec<&BattleMapEntry> = l.maps.iter().filter(|m| m.pvp).collect();
    assert_eq!(pve.len(), 6, "six PvE maps");
    assert_eq!(pvp.len(), 2, "two PvP maps");
    assert_eq!(
        pve.iter()
            .filter(|m| m.map.width == 7 && m.map.height == 7)
            .count(),
        3,
        "three 7x7 PvE maps"
    );
    assert_eq!(
        pve.iter()
            .filter(|m| m.map.width == 8 && m.map.height == 8)
            .count(),
        3,
        "three 8x8 PvE maps"
    );
    for m in &pvp {
        assert_eq!(
            (m.map.width, m.map.height),
            (8, 8),
            "PvP map {} is 8x8",
            m.id
        );
    }
}

#[test]
fn live_battle_maps_each_pass_the_map_validator_bt6_4() {
    let l = live();
    for m in &l.maps {
        assert_eq!(
            validate_battle_map(&m.map),
            Ok(()),
            "map {} ({})",
            m.id,
            m.name
        );
    }
    assert_eq!(validate_battle_maps(&l.maps), Ok(()));
}

/// Each PvP map is 180-degree point-symmetric: tile i mirrors tile n-1-i, and every B spawn is the
/// mirror of the matching A spawn.
#[test]
fn pvp_maps_are_point_symmetric_bt6_4() {
    let l = live();
    let pvp: Vec<&BattleMapEntry> = l.maps.iter().filter(|m| m.pvp).collect();
    assert_eq!(pvp.len(), 2, "two PvP maps to check");
    for e in pvp {
        let m = &e.map;
        let n = m.tiles.len();
        for i in 0..n {
            assert_eq!(
                m.tiles[i],
                m.tiles[n - 1 - i],
                "PvP map {}: tile {i} must equal tile {}",
                e.id,
                n - 1 - i
            );
        }
        assert_eq!(m.spawn_a.len(), 3, "PvP map {} spawn_a", e.id);
        assert_eq!(m.spawn_b.len(), 3, "PvP map {} spawn_b", e.id);
        for (k, a) in m.spawn_a.iter().enumerate() {
            assert_eq!(
                m.spawn_b[k],
                Cell {
                    x: m.width - 1 - a.x,
                    y: m.height - 1 - a.y
                },
                "PvP map {}: spawn_b[{k}] mirrors spawn_a[{k}]",
                e.id
            );
        }
    }
}

/// Per size the three PvE maps are the three themes: open field (no Water, no Rough), water channel
/// (some Water), rough choke (some Rough, no Water).
#[test]
fn pve_maps_cover_the_three_themes_per_size_bt6_4() {
    let l = live();
    for size in [7u8, 8u8] {
        let mut themes: Vec<&str> = l
            .maps
            .iter()
            .filter(|m| !m.pvp && m.map.width == size && m.map.height == size)
            .map(|m| {
                let water = has_terrain(&m.map, Terrain::Water);
                let rough = has_terrain(&m.map, Terrain::Rough);
                if water {
                    "water"
                } else if rough {
                    "rough"
                } else {
                    "open"
                }
            })
            .collect();
        themes.sort_unstable();
        assert_eq!(
            themes,
            vec!["open", "rough", "water"],
            "{size}x{size} PvE themes"
        );
    }
}

#[test]
fn tuning_ron_equals_design_bt6_4() {
    assert_eq!(load_tactics_tuning(), Ok(TacticsTuning::DESIGN));
}

/// Each named constant, against a literal (the RON and `DESIGN` could drift together).
#[test]
fn tuning_constants_are_pinned_bt6_4() {
    let t = load_tactics_tuning().expect("tuning");
    assert_eq!(t.ap_turn, 6, "ap_turn");
    assert_eq!(t.move_stride_cost, 2, "move_stride_cost");
    assert_eq!(t.max_strides_per_turn, 2, "max_strides_per_turn");
    assert_eq!(t.disengage_tax, 1, "disengage_tax");
    assert_eq!(t.light_cost, 2, "light_cost");
    assert_eq!(t.heavy_cost, 4, "heavy_cost");
    assert_eq!(t.exert_surcharge, 2, "exert_surcharge");
    assert_eq!(t.item_cost, 3, "item_cost");
    assert_eq!(t.recruit_cost, 6, "recruit_cost");
    assert_eq!(t.flee_cost, 6, "flee_cost");
    assert_eq!(t.end_turn_cost, 0, "end_turn_cost");
    assert_eq!(t.guard_min_ap, 2, "guard_min_ap");
    assert_eq!(t.guard_num, 3, "guard_num");
    assert_eq!(t.guard_den, 4, "guard_den");
    assert_eq!(t.flank_num, 5, "flank_num");
    assert_eq!(t.flank_den, 4, "flank_den");
    assert_eq!(t.surge_start_round, 9, "surge_start_round");
    assert_eq!(t.surge_pct_per_round, 5, "surge_pct_per_round");
    assert_eq!(t.wild_round_cap, 30, "wild_round_cap");
    assert_eq!(t.pvp_window_ms, 30_000, "pvp_window_ms");
    assert_eq!(t.pve_window_ms, 300_000, "pve_window_ms");
    assert_eq!(t.pvp_deploy_ms, 45_000, "pvp_deploy_ms");
    assert_eq!(t.pve_deploy_ms, 300_000, "pve_deploy_ms");
    assert_eq!(t.max_windows_per_turn, 3, "max_windows_per_turn");
    assert_eq!(t.autopass_forfeit, 4, "autopass_forfeit");
    assert_eq!(t.pad_cap_ms, 5_000, "pad_cap_ms");
}

fn tuning_src(t: &TacticsTuning) -> String {
    ron::to_string(t).expect("serialize tuning")
}

#[test]
fn parse_tactics_tuning_accepts_the_design_source_bt6_4() {
    assert_eq!(
        parse_tactics_tuning(&tuning_src(&TacticsTuning::DESIGN)),
        Ok(TacticsTuning::DESIGN)
    );
}

#[test]
fn parse_tactics_tuning_rejects_an_unknown_field_bt6_4() {
    let src = tuning_src(&TacticsTuning::DESIGN);
    let body = src
        .strip_suffix(')')
        .expect("a RON struct ends with a paren");
    let with_extra = format!("{body},bogus_field:1)");
    assert!(
        matches!(
            parse_tactics_tuning(&with_extra),
            Err(TacticsContentError::TuningParse(_))
        ),
        "an unknown field must be TuningParse, got {:?}",
        parse_tactics_tuning(&with_extra)
    );
    assert!(
        matches!(
            parse_tactics_tuning("not ron at all"),
            Err(TacticsContentError::TuningParse(_))
        ),
        "garbage must be TuningParse"
    );
}

/// `TacticsTuning::validate` runs first: its three errors are wrapped as `Tuning(..)`.
#[test]
fn parse_tactics_tuning_wraps_the_validate_errors_bt6_4() {
    let src = |t: TacticsTuning| tuning_src(&t);
    assert_eq!(
        parse_tactics_tuning(&src(TacticsTuning {
            guard_den: 0,
            ..TacticsTuning::DESIGN
        })),
        Err(TacticsContentError::Tuning(TuningError::ZeroGuardDen))
    );
    assert_eq!(
        parse_tactics_tuning(&src(TacticsTuning {
            flank_den: 0,
            ..TacticsTuning::DESIGN
        })),
        Err(TacticsContentError::Tuning(TuningError::ZeroFlankDen))
    );
    // ap_turn 0 is also below the cheapest action, but validate runs before the floors.
    assert_eq!(
        parse_tactics_tuning(&src(TacticsTuning {
            ap_turn: 0,
            ..TacticsTuning::DESIGN
        })),
        Err(TacticsContentError::Tuning(TuningError::ZeroApTurn))
    );
}

/// Every floor names its field.
#[test]
fn parse_tactics_tuning_enforces_each_floor_bt6_4() {
    let d = TacticsTuning::DESIGN;
    let cases: [(&'static str, TacticsTuning); 7] = [
        (
            "max_windows_per_turn",
            TacticsTuning {
                max_windows_per_turn: 0,
                ..d.clone()
            },
        ),
        (
            "autopass_forfeit",
            TacticsTuning {
                autopass_forfeit: 0,
                ..d.clone()
            },
        ),
        (
            "pvp_window_ms",
            TacticsTuning {
                pvp_window_ms: 0,
                ..d.clone()
            },
        ),
        (
            "pve_window_ms",
            TacticsTuning {
                pve_window_ms: 0,
                ..d.clone()
            },
        ),
        (
            "pvp_deploy_ms",
            TacticsTuning {
                pvp_deploy_ms: 0,
                ..d.clone()
            },
        ),
        (
            "pve_deploy_ms",
            TacticsTuning {
                pve_deploy_ms: 0,
                ..d.clone()
            },
        ),
        (
            "ap_turn",
            TacticsTuning {
                ap_turn: 1,
                ..d.clone()
            },
        ),
    ];
    for (field, t) in cases {
        assert_eq!(
            parse_tactics_tuning(&tuning_src(&t)),
            Err(TacticsContentError::TuningFloor(field)),
            "{field} below its floor"
        );
    }
}

/// The floors are floors, not off-by-ones: the smallest legal values parse.
#[test]
fn parse_tactics_tuning_accepts_the_floor_values_bt6_4() {
    let t = TacticsTuning {
        max_windows_per_turn: 1,
        autopass_forfeit: 1,
        pvp_window_ms: 1,
        pve_window_ms: 1,
        pvp_deploy_ms: 1,
        pve_deploy_ms: 1,
        ap_turn: 2,
        ..TacticsTuning::DESIGN
    };
    assert_eq!(parse_tactics_tuning(&tuning_src(&t)), Ok(t));
}

#[test]
fn validate_battle_maps_rejects_a_duplicate_id_bt6_4() {
    let maps = vec![
        mentry(1, false, map7()),
        mentry(2, false, map7()),
        mentry(1, true, map7()),
    ];
    assert_eq!(
        validate_battle_maps(&maps),
        Err(TacticsContentError::DuplicateMap(1))
    );
}

#[test]
fn validate_battle_maps_wraps_the_map_error_bt6_4() {
    let maps = vec![mentry(1, false, map7()), mentry(2, false, bad_map_width5())];
    assert_eq!(
        validate_battle_maps(&maps),
        Err(TacticsContentError::BadMap {
            map_id: 2,
            error: MapError::Width(5)
        })
    );
}

/// The first bad map in registry order is the one reported.
#[test]
fn validate_battle_maps_reports_the_first_bad_map_bt6_4() {
    let tall = BattleMapDef {
        height: 9,
        ..map7()
    };
    let maps = vec![mentry(3, false, tall), mentry(4, false, bad_map_width5())];
    assert_eq!(
        validate_battle_maps(&maps),
        Err(TacticsContentError::BadMap {
            map_id: 3,
            error: MapError::Height(9)
        })
    );
}

// ===========================================================================
// BT6.5 — kit lints, dmg_ref, validate_tactics_content
// ===========================================================================

#[test]
fn dmg_ref_exact_values_bt6_5() {
    let light = st(1, Tier::Light, 20, band(1, 1));
    let heavy = st(2, Tier::Heavy, 65, band(1, 1));
    assert_eq!(dmg_ref(&light, 5), 3, "L5 P20");
    assert_eq!(dmg_ref(&heavy, 5), 7, "L5 P65");
    assert_eq!(dmg_ref(&light, 50), 10, "L50 P20");
    assert_eq!(dmg_ref(&heavy, 50), 30, "L50 P65");
    assert_eq!(dmg_ref(&light, 100), 18, "L100 P20");
    assert_eq!(dmg_ref(&heavy, 100), 56, "L100 P65");
}

/// Neutral, no STAB: the skill's own affinity must not change the reference damage.
#[test]
fn dmg_ref_ignores_the_skill_affinity_and_accuracy_bt6_5() {
    for aff in Affinity::ALL {
        let mut s = st(1, Tier::Light, 20, band(1, 1));
        s.affinity = aff;
        s.accuracy = 50;
        assert_eq!(
            dmg_ref(&s, 5),
            3,
            "{aff:?} at L5 (a STAB or chart effect would change it)"
        );
        assert_eq!(dmg_ref(&s, 100), 18, "{aff:?} at L100");
    }
}

#[test]
fn live_lint_kits_is_ok_bt6_5() {
    let l = live();
    assert_eq!(lint_kits(&live_kits(&l)), Ok(()));
}

/// Heavy beats twice the Light's reference damage at every level 5..=100, for every live kit.
#[test]
fn live_kits_heavy_exceeds_double_light_at_every_level_bt6_5() {
    let l = live();
    let kits = live_kits(&l);
    assert!(!kits.is_empty());
    for k in &kits {
        for level in 5u8..=100 {
            let light = u32::from(dmg_ref(&k.light, level));
            let heavy = u32::from(dmg_ref(&k.heavy, level));
            assert!(
                heavy > 2 * light,
                "species {} level {level}: heavy {heavy} must exceed 2 x light {light}",
                k.species_id
            );
        }
    }
}

#[test]
fn lint_kits_accepts_a_good_kit_and_the_empty_list_bt6_5() {
    assert_eq!(lint_kits(&[]), Ok(()));
    assert_eq!(lint_kits(&[std_kit(1, 40, band(1, 2), band(2, 3))]), Ok(()));
}

#[test]
fn lint_kits_rejects_the_same_geometry_bt6_5() {
    let k = std_kit(3, 40, band(1, 2), band(1, 2));
    assert_eq!(
        lint_kits(&[k]),
        Err(TacticsContentError::KitSameGeometry(3))
    );
}

/// "Same range band AND shape": the same band with a different shape is distinct geometry.
#[test]
fn same_band_with_a_different_shape_is_distinct_geometry_bt6_5() {
    let diamond = geom(1, 1, Shape::Diamond, 1);
    let k = std_kit(3, 40, band(1, 1), diamond);
    assert_eq!(lint_kits(&[k]), Ok(()));
}

#[test]
fn lint_kits_rejects_a_kit_with_no_melee_skill_bt6_5() {
    let k = std_kit(4, 40, band(2, 2), band(2, 3));
    assert_eq!(lint_kits(&[k]), Err(TacticsContentError::KitNoMelee(4)));
}

/// Stride 4 (base speed >= 90) + heavy range_max 3 = 7 > 6.
#[test]
fn lint_kits_rejects_a_heavy_reach_over_six_bt6_5() {
    let k = std_kit(5, 100, band(1, 1), band(1, 3));
    assert_eq!(
        lint_kits(&[k]),
        Err(TacticsContentError::HeavyReach {
            species_id: 5,
            skill_id: 2
        })
    );
    // Boundary: 4 + 2 = 6 is allowed.
    assert_eq!(
        lint_kits(&[std_kit(5, 100, band(1, 1), band(1, 2))]),
        Ok(())
    );
}

/// The stride comes from the BASE speed band: 89 -> stride 3 (3 + 3 = 6 ok), 90 -> stride 4 (7 > 6).
#[test]
fn lint_kits_derives_the_stride_from_base_speed_bands_bt6_5() {
    assert_eq!(lint_kits(&[std_kit(5, 89, band(1, 1), band(1, 3))]), Ok(()));
    assert_eq!(
        lint_kits(&[std_kit(5, 90, band(1, 1), band(1, 3))]),
        Err(TacticsContentError::HeavyReach {
            species_id: 5,
            skill_id: 2
        })
    );
}

/// Stride 4 + a Light of range_max 4 = 8 > 7 (range_min 2, so the long-range rule is not the cause).
#[test]
fn lint_kits_rejects_a_skill_reach_over_seven_bt6_5() {
    let k = std_kit(6, 100, band(2, 4), band(1, 1));
    assert_eq!(
        lint_kits(&[k]),
        Err(TacticsContentError::Reach {
            species_id: 6,
            skill_id: 1
        })
    );
    // Boundary: 4 + 3 = 7 is allowed.
    assert_eq!(
        lint_kits(&[std_kit(6, 100, band(2, 3), band(1, 1))]),
        Ok(())
    );
}

/// A Heavy whose reach breaks both rules reports HeavyReach (checked before Reach).
#[test]
fn heavy_reach_is_checked_before_reach_bt6_5() {
    let k = std_kit(6, 100, band(1, 1), band(2, 4));
    assert_eq!(
        lint_kits(&[k]),
        Err(TacticsContentError::HeavyReach {
            species_id: 6,
            skill_id: 2
        })
    );
}

/// Light 20 vs Heavy 63: dmg 7 > 6 at L5..L7, then at L8 (k = 5) it is 8 vs 2 x 4 = 8 -> not
/// strictly greater. The error names the FIRST failing level (ascending), and the equality case
/// fails (`<=`).
#[test]
fn lint_kits_reports_the_first_failing_level_bt6_5() {
    let k = kit(
        7,
        40,
        st(1, Tier::Light, 20, band(1, 2)),
        st(2, Tier::Heavy, 63, band(2, 3)),
    );
    assert_eq!(
        lint_kits(&[k]),
        Err(TacticsContentError::HeavyNotStrong {
            species_id: 7,
            level: 8
        })
    );
}

/// A Heavy of power 40 already fails at the first level (5 vs 2 x 3 = 6 -> 5 is not > 6).
#[test]
fn lint_kits_rejects_a_weak_heavy_at_level_five_bt6_5() {
    let k = kit(
        8,
        40,
        st(1, Tier::Light, 20, band(1, 2)),
        st(2, Tier::Heavy, 40, band(2, 3)),
    );
    assert_eq!(
        lint_kits(&[k]),
        Err(TacticsContentError::HeavyNotStrong {
            species_id: 8,
            level: 5
        })
    );
}

/// The checks run per kit, in kit order: an early kit's damage failure is reported before a later
/// kit's geometry failure; within a kit SameGeometry precedes NoMelee precedes HeavyReach.
#[test]
fn lint_kits_order_is_per_kit_then_per_check_bt6_5() {
    let weak = kit(
        2,
        40,
        st(1, Tier::Light, 20, band(1, 2)),
        st(2, Tier::Heavy, 40, band(2, 3)),
    );
    let no_melee = std_kit(3, 40, band(2, 2), band(2, 3));
    assert_eq!(
        lint_kits(&[std_kit(1, 40, band(1, 2), band(2, 3)), weak, no_melee]),
        Err(TacticsContentError::HeavyNotStrong {
            species_id: 2,
            level: 5
        })
    );
    // Same geometry AND no melee: SameGeometry first.
    assert_eq!(
        lint_kits(&[std_kit(9, 40, band(2, 2), band(2, 2))]),
        Err(TacticsContentError::KitSameGeometry(9))
    );
    // No melee AND a heavy reach over six: NoMelee first.
    assert_eq!(
        lint_kits(&[std_kit(9, 100, band(2, 2), band(2, 4))]),
        Err(TacticsContentError::KitNoMelee(9))
    );
}

#[test]
fn validate_tactics_content_on_live_registries_is_the_build_kits_join_bt6_5() {
    let l = live();
    let reg = TacticsRegistries {
        species: &l.species,
        skills: &l.skills,
        items: &l.items,
        zones: &l.zones,
        tactics_skills: &l.tskills,
        tactics_species: &l.tspecies,
        tactics_items: &l.titems,
        tactics_zones: &l.tzones,
        battle_maps: &l.maps,
        tuning: &l.tuning,
    };
    let got = validate_tactics_content(&reg);
    assert_eq!(got, Ok(live_kits(&l)));
    assert!(!got.expect("ok").is_empty());
}

#[test]
fn validate_tactics_content_on_a_good_fixture_returns_the_join_bt6_5() {
    let fx = Fx::good();
    let expected =
        build_kits(&fx.species, &fx.skills, &fx.tskills, &fx.tspecies).expect("fixture join");
    assert_eq!(expected.len(), 1);
    assert_eq!(fx.validate(), Ok(expected));
}

/// Order pin 1: tuning is checked before maps (both are bad here).
#[test]
fn validate_tactics_content_checks_tuning_before_maps_bt6_5() {
    let mut fx = Fx::good();
    fx.tuning = TacticsTuning {
        guard_den: 0,
        ..TacticsTuning::DESIGN
    };
    fx.maps.push(mentry(2, false, bad_map_width5()));
    assert_eq!(
        fx.validate(),
        Err(TacticsContentError::Tuning(TuningError::ZeroGuardDen))
    );
}

/// Order pin 2: maps are checked before the kit join.
#[test]
fn validate_tactics_content_checks_maps_before_kits_bt6_5() {
    let mut fx = Fx::good();
    fx.maps.push(mentry(2, false, bad_map_width5()));
    fx.tskills.push(row(1, Tier::Light, 1, 1)); // duplicate skill row
    assert_eq!(
        fx.validate(),
        Err(TacticsContentError::BadMap {
            map_id: 2,
            error: MapError::Width(5)
        })
    );
}

/// Order pin 3: the kit join is checked before items.
#[test]
fn validate_tactics_content_checks_the_join_before_items_bt6_5() {
    let mut fx = Fx::good();
    fx.tskills.push(row(1, Tier::Light, 1, 1)); // duplicate skill row
    fx.titems.push(irow(3)); // duplicate item row
    assert_eq!(
        fx.validate(),
        Err(TacticsContentError::DuplicateSkillEntry(1))
    );
}

/// Order pin 4: the kit lints run before items (stride 4 + heavy r2..3 = 7 > 6).
#[test]
fn validate_tactics_content_checks_lints_before_items_bt6_5() {
    let mut fx = Fx::good();
    fx.species[0].base_stats.speed = 100;
    fx.titems.push(irow(3)); // duplicate item row
    assert_eq!(
        fx.validate(),
        Err(TacticsContentError::HeavyReach {
            species_id: 1,
            skill_id: 2
        })
    );
}

/// Order pin 5: items are checked before zones.
#[test]
fn validate_tactics_content_checks_items_before_zones_bt6_5() {
    let mut fx = Fx::good();
    fx.titems.push(irow(3)); // duplicate item row
    fx.tzones.push(zrow(0, PackWeights::DEFAULT, vec![1])); // duplicate zone row
    assert_eq!(
        fx.validate(),
        Err(TacticsContentError::DuplicateItemEntry(3))
    );
}

/// Zones are the last gate: with everything else valid, a bad zone row is what surfaces.
#[test]
fn validate_tactics_content_reaches_the_zone_gate_bt6_5() {
    let mut fx = Fx::good();
    fx.tzones[0].battle_map_pool = vec![9];
    assert_eq!(
        fx.validate(),
        Err(TacticsContentError::PoolMap {
            zone_id: 0,
            map_id: 9
        })
    );
}

// ===========================================================================
// BT6.6 — registries wired through the glob loader
// ===========================================================================

/// The five new `*_RON_PARTS` consts are non-empty, filename-sorted, and each registry loads a
/// non-empty row set (mirrors the M8.9e sorted-static tests).
#[test]
fn tactics_ron_parts_are_non_empty_sorted_and_load_rows_bt6_6() {
    let registries: [(&str, &[(&str, &str)]); 5] = [
        ("tactics_skills", crate::content::TACTICS_SKILLS_RON_PARTS),
        ("tactics_species", crate::content::TACTICS_SPECIES_RON_PARTS),
        ("tactics_items", crate::content::TACTICS_ITEMS_RON_PARTS),
        ("tactics_zones", crate::content::TACTICS_ZONES_RON_PARTS),
        ("battle_maps", crate::content::BATTLE_MAPS_RON_PARTS),
    ];
    for (name, parts) in registries {
        assert!(!parts.is_empty(), "{name}: RON parts must be non-empty");
        let names: Vec<&str> = parts.iter().map(|(n, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(
            names, sorted,
            "{name}: filenames must be sorted, got {names:?}"
        );
    }
    assert!(
        !load_tactics_skills().expect("skills").is_empty(),
        "tactics_skills rows"
    );
    assert!(
        !load_tactics_species().expect("species").is_empty(),
        "tactics_species rows"
    );
    assert!(
        !load_tactics_items().expect("items").is_empty(),
        "tactics_items rows"
    );
    assert!(
        !load_tactics_zones().expect("zones").is_empty(),
        "tactics_zones rows"
    );
    assert!(
        !load_battle_maps().expect("maps").is_empty(),
        "battle_maps rows"
    );
}
