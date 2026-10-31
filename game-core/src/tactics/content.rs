//! Tactical content (bt-6) — the SIDECAR registries keyed by id, their join, and the content lints.
//!
//! The tactical data does not add fields to `SkillDef` / `Species` / `ItemDef` / `ZoneDef`: a new
//! field on those structs breaks ~100 hand-built struct literals and the `encounter` table round
//! trip (spec bt-6, measured layout deviation from design §8.2). Instead each registry lives in
//! its own directory (`tactics_skills/`, `tactics_species/`, `tactics_items/`, `tactics_zones/`,
//! `battle_maps/`, glob-loaded by `build.rs`) plus the `tactics_tuning.ron` singleton, and
//! [`build_kits`] is the parse-don't-validate boundary that joins them onto the carried rows.
//! The lints ([`lint_kits`], design §4.1) run over that join; [`validate_tactics_content`] is the
//! one entry point the server's `sync_content` validate phase calls before any write, so CI and
//! publish reject the same content.
//!
//! Every check returns the FIRST violation as a typed [`TacticsContentError`] naming the offending
//! id — reject, never clamp. Iteration follows the registry order (no hash maps).

use serde::{Deserialize, Serialize};

use super::ai::Stance;
use super::economy::Tier;
use super::encounter::PackWeights;
use super::geometry::{FfFilter, Origin, Shape, SkillGeometry};
use super::map::{validate_battle_map, BattleMapDef, MapError};
use super::movement::stride_for_base_speed;
use super::movement::MoveClass;
use super::queue::min_action_cost;
use super::resolve::SkillTactics;
use super::tuning::{TacticsTuning, TuningError};
use crate::combat::damage::calc_damage;
use crate::combat::type_chart::TypeChart;
use crate::combat::types::BattleMonster;
use crate::content::{
    parse_parts, ItemDef, SkillDef, Species, ZoneDef, BATTLE_MAPS_RON_PARTS,
    TACTICS_ITEMS_RON_PARTS, TACTICS_SKILLS_RON_PARTS, TACTICS_SPECIES_RON_PARTS,
    TACTICS_ZONES_RON_PARTS,
};
use crate::monster::types::{Affinity, StatBlock};

/// The embedded singleton (the `type_chart.ron` idiom: one file, not a glob registry).
const TACTICS_TUNING_RON: &str = include_str!("../../content/tactics_tuning.ron");

/// The level band the `dmg_ref` lint sweeps (design §2.1.1).
const LINT_LEVELS: std::ops::RangeInclusive<u8> = 5..=100;
/// `stride + heavy.range_max` ceiling (design §4.1).
const MAX_HEAVY_REACH: u16 = 6;
/// `stride + range_max` ceiling for any kit skill (design §4.1).
const MAX_REACH: u16 = 7;
/// A skill reaching this far must start at range 2 (design §4.1).
const LONG_RANGE: u8 = 3;
/// The range_min every long-range skill carries.
const LONG_RANGE_MIN: u8 = 2;

/// The role chip (design §4.1): a UI tag and stance default, never a rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    Striker,
    Guardian,
    Skirmisher,
    Support,
    Artillery,
}

/// Who a battle item may target. `Ally` includes the user itself. Append-only: a new variant
/// arrives with the first item content that needs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ItemTarget {
    Ally,
}

/// One `tactics_skills` row: the design §3.1 skill geometry plus the AP tier, keyed by `skill_id`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TacticsSkillDef {
    pub skill_id: u32,
    pub tier: Tier,
    pub range_min: u8,
    pub range_max: u8,
    pub origin: Origin,
    pub shape: Shape,
    pub radius: u8,
    pub ff_filter: FfFilter,
}

impl TacticsSkillDef {
    /// The geometry half of the row, as `tactics::geometry` consumes it.
    #[must_use]
    pub fn geometry(&self) -> SkillGeometry {
        SkillGeometry {
            range_min: self.range_min,
            range_max: self.range_max,
            origin: self.origin,
            shape: self.shape,
            radius: self.radius,
            ff_filter: self.ff_filter,
        }
    }
}

/// One `tactics_species` row (design §4.1 `battler:`): `kit` is `[light_skill_id, heavy_skill_id]`;
/// `signature` and `footprint` are dormant (always `None` / `1` in P1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TacticsSpeciesDef {
    pub species_id: u32,
    pub movement: MoveClass,
    pub role: Role,
    pub stance: Stance,
    pub kit: [u32; 2],
    pub signature: Option<u32>,
    pub footprint: u8,
}

/// One `tactics_items` row: a battle-usable item's reach (Manhattan, 0 = self) and target filter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TacticsItemDef {
    pub item_id: u32,
    pub range: u8,
    pub target_filter: ItemTarget,
}

/// One `tactics_zones` row (design §3.4): the zone's pack-size weights and its battle-map pool
/// (ids into `battle_maps`; the map is `pool[encounter_seed % len]`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TacticsZoneDef {
    pub zone_id: u32,
    pub pack_weights: PackWeights,
    pub battle_map_pool: Vec<u32>,
}

/// One `battle_maps` row: a stable id, a display name, whether it is a PvP map, and the map.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BattleMapEntry {
    pub id: u32,
    pub name: String,
    pub pvp: bool,
    pub map: BattleMapDef,
}

/// The join of one species: its carried base speed, its battler levers, and its two-skill kit
/// as resolved [`SkillTactics`] (carried power / accuracy / affinity + sidecar geometry).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpeciesTactics {
    pub species_id: u32,
    pub base_speed: u16,
    pub movement: MoveClass,
    pub role: Role,
    pub stance: Stance,
    pub light: SkillTactics,
    pub heavy: SkillTactics,
}

/// Every reason tactical content is rejected. Each variant names the offending id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TacticsContentError {
    /// `tactics_tuning.ron` failed to parse.
    TuningParse(String),
    /// `TacticsTuning::validate` rejected the tuning.
    Tuning(TuningError),
    /// A tuning value no turn can run on (`max_windows_per_turn`, `autopass_forfeit`, a zero
    /// window or deploy clock, or `ap_turn` below the cheapest action): the field's name.
    TuningFloor(&'static str),
    /// Two `tactics_skills` rows for one skill id.
    DuplicateSkillEntry(u32),
    /// A `tactics_skills` row for a skill id that is not loaded.
    UnknownSkill(u32),
    /// A loaded skill with no `tactics_skills` row.
    MissingSkillEntry(u32),
    /// A skill whose geometry `target_set` cannot run (range_min > range_max, a radius the shape
    /// forbids, or a reserved shape).
    BadGeometry(u32),
    /// `range_max ≥ 3` but `range_min ≠ 2`.
    LongRangeMin(u32),
    /// `ff_filter = All` authored with `origin ≠ TargetUnit`.
    AllNeedsTargetOrigin(u32),
    /// Two `tactics_species` rows for one species id.
    DuplicateSpeciesEntry(u32),
    /// A `tactics_species` row for a species id that is not loaded.
    UnknownSpecies(u32),
    /// A loaded species with no `tactics_species` row.
    MissingSpeciesEntry(u32),
    /// `signature` is not `None` or `footprint` is not 1 (dormant in P1).
    DormantLever(u32),
    /// `kit[0]` is not a Light or `kit[1]` is not a Heavy.
    KitTier { species_id: u32, skill_id: u32 },
    /// A weather-setter skill in a kit (they re-enter with the weather wave).
    KitWeatherSetter { species_id: u32, skill_id: u32 },
    /// The Light and the Heavy share range band AND shape.
    KitSameGeometry(u32),
    /// Neither kit skill has `range_min = 1`.
    KitNoMelee(u32),
    /// `stride + heavy.range_max > 6`.
    HeavyReach { species_id: u32, skill_id: u32 },
    /// `stride + range_max > 7` for a kit skill.
    Reach { species_id: u32, skill_id: u32 },
    /// `dmg_ref(heavy) ≤ 2 · dmg_ref(light)` at `level`.
    HeavyNotStrong { species_id: u32, level: u8 },
    /// Two `tactics_items` rows for one item id.
    DuplicateItemEntry(u32),
    /// A `tactics_items` row for an item that is not loaded or not battle-usable.
    NotBattleUsable(u32),
    /// A battle-usable item (`cure_status` set) with no `tactics_items` row.
    MissingItemEntry(u32),
    /// Two `battle_maps` rows with one id.
    DuplicateMap(u32),
    /// A map bt-1's validator rejects.
    BadMap { map_id: u32, error: MapError },
    /// Two `tactics_zones` rows for one zone id.
    DuplicateZoneEntry(u32),
    /// A `tactics_zones` row for a zone that is not loaded.
    UnknownZone(u32),
    /// A loaded zone with no `tactics_zones` row.
    MissingZoneEntry(u32),
    /// `pack_weights` do not sum to 1000 ‰.
    PackWeights { zone_id: u32, sum: u32 },
    /// An empty `battle_map_pool`.
    EmptyMapPool(u32),
    /// A pool id that names no loaded map, or a PvP map.
    PoolMap { zone_id: u32, map_id: u32 },
}

/// The ten registries [`validate_tactics_content`] joins: the carried rows and the sidecars.
#[derive(Clone, Copy, Debug)]
pub struct TacticsRegistries<'a> {
    pub species: &'a [Species],
    pub skills: &'a [SkillDef],
    pub items: &'a [ItemDef],
    pub zones: &'a [ZoneDef],
    pub tactics_skills: &'a [TacticsSkillDef],
    pub tactics_species: &'a [TacticsSpeciesDef],
    pub tactics_items: &'a [TacticsItemDef],
    pub tactics_zones: &'a [TacticsZoneDef],
    pub battle_maps: &'a [BattleMapEntry],
    pub tuning: &'a TacticsTuning,
}

/// Parse the embedded `tactics_skills/` registry.
///
/// # Errors
/// A malformed part (the message names the file).
pub fn load_tactics_skills() -> Result<Vec<TacticsSkillDef>, String> {
    parse_parts(TACTICS_SKILLS_RON_PARTS, "tactics_skills")
}

/// Parse the embedded `tactics_species/` registry.
///
/// # Errors
/// A malformed part (the message names the file).
pub fn load_tactics_species() -> Result<Vec<TacticsSpeciesDef>, String> {
    parse_parts(TACTICS_SPECIES_RON_PARTS, "tactics_species")
}

/// Parse the embedded `tactics_items/` registry.
///
/// # Errors
/// A malformed part (the message names the file).
pub fn load_tactics_items() -> Result<Vec<TacticsItemDef>, String> {
    parse_parts(TACTICS_ITEMS_RON_PARTS, "tactics_items")
}

/// Parse the embedded `tactics_zones/` registry.
///
/// # Errors
/// A malformed part (the message names the file).
pub fn load_tactics_zones() -> Result<Vec<TacticsZoneDef>, String> {
    parse_parts(TACTICS_ZONES_RON_PARTS, "tactics_zones")
}

/// Parse the embedded `battle_maps/` registry (parse only — [`validate_battle_maps`] validates).
///
/// # Errors
/// A malformed part (the message names the file).
pub fn load_battle_maps() -> Result<Vec<BattleMapEntry>, String> {
    parse_parts(BATTLE_MAPS_RON_PARTS, "battle_maps")
}

/// Parse a `tactics_tuning.ron` source and reject a tuning no rule can run on
/// ([`TacticsTuning::validate`], then the [`TacticsContentError::TuningFloor`] floors).
///
/// # Errors
/// [`TacticsContentError::TuningParse`], [`TacticsContentError::Tuning`] or
/// [`TacticsContentError::TuningFloor`].
pub fn parse_tactics_tuning(src: &str) -> Result<TacticsTuning, TacticsContentError> {
    let tuning: TacticsTuning =
        ron::from_str(src).map_err(|e| TacticsContentError::TuningParse(e.to_string()))?;
    check_tuning(&tuning)?;
    Ok(tuning)
}

/// `TacticsTuning::validate`, then the floors (in [`TacticsContentError::TuningFloor`] order).
fn check_tuning(t: &TacticsTuning) -> Result<(), TacticsContentError> {
    t.validate().map_err(TacticsContentError::Tuning)?;
    let floors: [(&'static str, bool); 7] = [
        ("max_windows_per_turn", t.max_windows_per_turn >= 1),
        ("autopass_forfeit", t.autopass_forfeit >= 1),
        ("pvp_window_ms", t.pvp_window_ms > 0),
        ("pve_window_ms", t.pve_window_ms > 0),
        ("pvp_deploy_ms", t.pvp_deploy_ms > 0),
        ("pve_deploy_ms", t.pve_deploy_ms > 0),
        ("ap_turn", t.ap_turn >= min_action_cost(t)),
    ];
    match floors.iter().find(|(_, ok)| !ok) {
        Some(&(field, _)) => Err(TacticsContentError::TuningFloor(field)),
        None => Ok(()),
    }
}

/// [`parse_tactics_tuning`] over the embedded `tactics_tuning.ron`.
///
/// # Errors
/// See [`parse_tactics_tuning`].
pub fn load_tactics_tuning() -> Result<TacticsTuning, TacticsContentError> {
    parse_tactics_tuning(TACTICS_TUNING_RON)
}

/// The reference damage of the lints (design §2.1.1): the carried `calc_damage` for `skill` at
/// `level`, neutral type, no STAB, attack = defense, variance 100, no weather.
#[must_use]
pub fn dmg_ref(skill: &SkillTactics, level: u8) -> u16 {
    // Any affinity other than the skill's own: no STAB. The empty chart is neutral (×1).
    let affinity = if skill.affinity == Affinity::Fire {
        Affinity::Water
    } else {
        Affinity::Fire
    };
    let stats = StatBlock {
        hp: 100,
        attack: 100,
        defense: 100,
        speed: 100,
        sp_attack: 100,
        sp_defense: 100,
    };
    let monster = BattleMonster {
        species_id: 0,
        affinity,
        level,
        current_hp: 100,
        max_hp: 100,
        stats,
        known_skill_ids: Vec::new(),
        status: None,
    };
    let def = SkillDef {
        id: skill.skill_id,
        name: String::new(),
        affinity: skill.affinity,
        power: skill.power,
        accuracy: skill.accuracy,
        pp: 1,
        sets_weather: None,
        applies_status: None,
    };
    calc_damage(&monster, &monster, &def, &TypeChart::new(&[]), 100, None).0
}

/// Join the sidecars onto the carried skill and species rows (the parse-don't-validate boundary).
/// Checks, first failure wins: the skill sidecar (duplicate → unknown → missing → per-row geometry,
/// `LongRangeMin`, `AllNeedsTargetOrigin`), then the species sidecar (duplicate → unknown → missing
/// → per-row dormant levers, kit tier, weather setter). Returns one [`SpeciesTactics`] per
/// `tactics_species` row, in that order.
///
/// An unknown kit skill id is a [`TacticsContentError::KitTier`] (it is neither a Light nor a
/// Heavy). NOT checked yet: kit ⊆ the species' `learnable_skill_ids` (spec BT6.2) — deferred
/// until the species registry gains Water / Dark / Earth / Wind Heavies; the provisional kits are
/// listed in `tactics_species/000-core.ron` and pinned by `kit_outside_learnable_set_is_pinned_bt6_2`.
///
/// # Errors
/// The first violation as a [`TacticsContentError`].
pub fn build_kits(
    species: &[Species],
    skills: &[SkillDef],
    tactics_skills: &[TacticsSkillDef],
    tactics_species: &[TacticsSpeciesDef],
) -> Result<Vec<SpeciesTactics>, TacticsContentError> {
    let skill_ids: Vec<u32> = skills.iter().map(|s| s.id).collect();
    cover(
        tactics_skills.iter().map(|r| r.skill_id),
        &skill_ids,
        TacticsContentError::DuplicateSkillEntry,
        TacticsContentError::UnknownSkill,
        TacticsContentError::MissingSkillEntry,
    )?;
    for r in tactics_skills {
        check_skill_row(r)?;
    }
    let species_ids: Vec<u32> = species.iter().map(|s| s.id).collect();
    cover(
        tactics_species.iter().map(|r| r.species_id),
        &species_ids,
        TacticsContentError::DuplicateSpeciesEntry,
        TacticsContentError::UnknownSpecies,
        TacticsContentError::MissingSpeciesEntry,
    )?;
    tactics_species
        .iter()
        .map(|r| {
            if r.signature.is_some() || r.footprint != 1 {
                return Err(TacticsContentError::DormantLever(r.species_id));
            }
            let [light_id, heavy_id] = r.kit;
            let light = kit_skill(r.species_id, light_id, Tier::Light, skills, tactics_skills)?;
            let heavy = kit_skill(r.species_id, heavy_id, Tier::Heavy, skills, tactics_skills)?;
            for (id, def) in [(light_id, light.1), (heavy_id, heavy.1)] {
                if def.sets_weather.is_some() {
                    return Err(TacticsContentError::KitWeatherSetter {
                        species_id: r.species_id,
                        skill_id: id,
                    });
                }
            }
            let base_speed = species
                .iter()
                .find(|s| s.id == r.species_id)
                .map(|s| s.base_stats.speed)
                .ok_or(TacticsContentError::UnknownSpecies(r.species_id))?;
            Ok(SpeciesTactics {
                species_id: r.species_id,
                base_speed,
                movement: r.movement,
                role: r.role,
                stance: r.stance,
                light: light.0,
                heavy: heavy.0,
            })
        })
        .collect()
}

/// A sidecar keyed by id covers the loaded ids exactly once: no duplicate row, then no row for an
/// unloaded id, then no loaded id without a row (each pass in registry order).
fn cover(
    rows: impl Iterator<Item = u32> + Clone,
    loaded: &[u32],
    duplicate: fn(u32) -> TacticsContentError,
    unknown: fn(u32) -> TacticsContentError,
    missing: fn(u32) -> TacticsContentError,
) -> Result<(), TacticsContentError> {
    let mut seen = std::collections::BTreeSet::new();
    if let Some(id) = rows.clone().find(|&id| !seen.insert(id)) {
        return Err(duplicate(id));
    }
    if let Some(id) = rows.clone().find(|id| !loaded.contains(id)) {
        return Err(unknown(id));
    }
    match loaded.iter().find(|id| !seen.contains(id)) {
        Some(&id) => Err(missing(id)),
        None => Ok(()),
    }
}

/// One skill row, first failure wins: runnable geometry, the long-range floor, the `All` origin.
fn check_skill_row(r: &TacticsSkillDef) -> Result<(), TacticsContentError> {
    let radius_ok = match r.shape {
        Shape::Line | Shape::Cone => false,
        Shape::Single => r.radius == 0,
        Shape::Diamond => r.radius <= 2,
        Shape::Burst => r.radius == 1,
    };
    if !radius_ok || r.range_min > r.range_max {
        return Err(TacticsContentError::BadGeometry(r.skill_id));
    }
    if r.range_max >= LONG_RANGE && r.range_min != LONG_RANGE_MIN {
        return Err(TacticsContentError::LongRangeMin(r.skill_id));
    }
    if r.ff_filter == FfFilter::All && r.origin != Origin::TargetUnit {
        return Err(TacticsContentError::AllNeedsTargetOrigin(r.skill_id));
    }
    Ok(())
}

/// Resolve one kit slot to its joined [`SkillTactics`] (and the carried row), requiring `tier`.
fn kit_skill<'a>(
    species_id: u32,
    skill_id: u32,
    tier: Tier,
    skills: &'a [SkillDef],
    tactics_skills: &[TacticsSkillDef],
) -> Result<(SkillTactics, &'a SkillDef), TacticsContentError> {
    let wrong_tier = TacticsContentError::KitTier {
        species_id,
        skill_id,
    };
    let row = tactics_skills
        .iter()
        .find(|r| r.skill_id == skill_id)
        .ok_or_else(|| wrong_tier.clone())?;
    let def = skills
        .iter()
        .find(|s| s.id == skill_id)
        .ok_or_else(|| wrong_tier.clone())?;
    if row.tier != tier {
        return Err(wrong_tier);
    }
    let joined = SkillTactics {
        skill_id,
        tier,
        affinity: def.affinity,
        power: def.power,
        accuracy: def.accuracy,
        applies_status: def.applies_status,
        geometry: row.geometry(),
    };
    Ok((joined, def))
}

/// The design §4.1 kit lints over a join, per kit in order: distinct geometry, a melee skill,
/// `stride + heavy.range_max ≤ 6`, `stride + any.range_max ≤ 7` (Light then Heavy), and
/// `dmg_ref(heavy) > 2 · dmg_ref(light)` at every level 5..=100 (ascending).
///
/// # Errors
/// The first violation as a [`TacticsContentError`].
pub fn lint_kits(kits: &[SpeciesTactics]) -> Result<(), TacticsContentError> {
    for k in kits {
        let (l, h) = (&k.light.geometry, &k.heavy.geometry);
        if (l.range_min, l.range_max, l.shape) == (h.range_min, h.range_max, h.shape) {
            return Err(TacticsContentError::KitSameGeometry(k.species_id));
        }
        if l.range_min != 1 && h.range_min != 1 {
            return Err(TacticsContentError::KitNoMelee(k.species_id));
        }
        let stride = u16::from(stride_for_base_speed(k.base_speed));
        if stride + u16::from(h.range_max) > MAX_HEAVY_REACH {
            return Err(TacticsContentError::HeavyReach {
                species_id: k.species_id,
                skill_id: k.heavy.skill_id,
            });
        }
        for s in [&k.light, &k.heavy] {
            if stride + u16::from(s.geometry.range_max) > MAX_REACH {
                return Err(TacticsContentError::Reach {
                    species_id: k.species_id,
                    skill_id: s.skill_id,
                });
            }
        }
        if let Some(level) = LINT_LEVELS
            .clone()
            .find(|&lv| u32::from(dmg_ref(&k.heavy, lv)) <= 2 * u32::from(dmg_ref(&k.light, lv)))
        {
            return Err(TacticsContentError::HeavyNotStrong {
                species_id: k.species_id,
                level,
            });
        }
    }
    Ok(())
}

/// Every map passes bt-1's validator and map ids are unique (registry order).
///
/// # Errors
/// [`TacticsContentError::DuplicateMap`] or [`TacticsContentError::BadMap`].
pub fn validate_battle_maps(maps: &[BattleMapEntry]) -> Result<(), TacticsContentError> {
    let mut seen = std::collections::BTreeSet::new();
    for m in maps {
        if !seen.insert(m.id) {
            return Err(TacticsContentError::DuplicateMap(m.id));
        }
        validate_battle_map(&m.map).map_err(|error| TacticsContentError::BadMap {
            map_id: m.id,
            error,
        })?;
    }
    Ok(())
}

/// The item sidecar: unique rows, each naming a loaded battle-usable item (`cure_status` set),
/// and every battle-usable item covered.
///
/// # Errors
/// The first violation as a [`TacticsContentError`].
pub fn validate_tactics_items(
    items: &[ItemDef],
    tactics_items: &[TacticsItemDef],
) -> Result<(), TacticsContentError> {
    let usable: Vec<u32> = items
        .iter()
        .filter(|i| i.cure_status.is_some())
        .map(|i| i.id)
        .collect();
    cover(
        tactics_items.iter().map(|r| r.item_id),
        &usable,
        TacticsContentError::DuplicateItemEntry,
        TacticsContentError::NotBattleUsable,
        TacticsContentError::MissingItemEntry,
    )
}

/// The zone sidecar: unique rows naming loaded zones, every zone covered, then per row the pack
/// weights (sum 1000 ‰), a non-empty pool, and every pool id a loaded non-PvP map.
///
/// # Errors
/// The first violation as a [`TacticsContentError`].
pub fn validate_tactics_zones(
    zones: &[ZoneDef],
    tactics_zones: &[TacticsZoneDef],
    maps: &[BattleMapEntry],
) -> Result<(), TacticsContentError> {
    let zone_ids: Vec<u32> = zones.iter().map(|z| z.id).collect();
    cover(
        tactics_zones.iter().map(|r| r.zone_id),
        &zone_ids,
        TacticsContentError::DuplicateZoneEntry,
        TacticsContentError::UnknownZone,
        TacticsContentError::MissingZoneEntry,
    )?;
    for r in tactics_zones {
        let w = &r.pack_weights;
        if w.validate().is_err() {
            return Err(TacticsContentError::PackWeights {
                zone_id: r.zone_id,
                sum: u32::from(w.one) + u32::from(w.two) + u32::from(w.three),
            });
        }
        if r.battle_map_pool.is_empty() {
            return Err(TacticsContentError::EmptyMapPool(r.zone_id));
        }
        if let Some(&map_id) = r
            .battle_map_pool
            .iter()
            .find(|&&id| !maps.iter().any(|m| m.id == id && !m.pvp))
        {
            return Err(TacticsContentError::PoolMap {
                zone_id: r.zone_id,
                map_id,
            });
        }
    }
    Ok(())
}

/// The whole tactical content gate, in order: tuning, maps, [`build_kits`], [`lint_kits`], items,
/// zones. The server's `sync_content` calls this in its validate phase, before any write.
///
/// # Errors
/// The first violation as a [`TacticsContentError`].
pub fn validate_tactics_content(
    reg: &TacticsRegistries<'_>,
) -> Result<Vec<SpeciesTactics>, TacticsContentError> {
    check_tuning(reg.tuning)?;
    validate_battle_maps(reg.battle_maps)?;
    let kits = build_kits(
        reg.species,
        reg.skills,
        reg.tactics_skills,
        reg.tactics_species,
    )?;
    lint_kits(&kits)?;
    validate_tactics_items(reg.items, reg.tactics_items)?;
    validate_tactics_zones(reg.zones, reg.tactics_zones, reg.battle_maps)?;
    Ok(kits)
}
