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
use super::map::{BattleMapDef, MapError};
use super::movement::MoveClass;
use super::resolve::SkillTactics;
use super::tuning::{TacticsTuning, TuningError};
use crate::content::{ItemDef, SkillDef, Species, ZoneDef};

/// The role chip (design §4.1): a UI tag and stance default, never a rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    Striker,
    Guardian,
    Skirmisher,
    Support,
    Artillery,
}

/// Who a battle item may target. `Ally` includes the user itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ItemTarget {
    SelfOnly,
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
        todo!("bt-6")
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
    todo!("bt-6")
}

/// Parse the embedded `tactics_species/` registry.
///
/// # Errors
/// A malformed part (the message names the file).
pub fn load_tactics_species() -> Result<Vec<TacticsSpeciesDef>, String> {
    todo!("bt-6")
}

/// Parse the embedded `tactics_items/` registry.
///
/// # Errors
/// A malformed part (the message names the file).
pub fn load_tactics_items() -> Result<Vec<TacticsItemDef>, String> {
    todo!("bt-6")
}

/// Parse the embedded `tactics_zones/` registry.
///
/// # Errors
/// A malformed part (the message names the file).
pub fn load_tactics_zones() -> Result<Vec<TacticsZoneDef>, String> {
    todo!("bt-6")
}

/// Parse the embedded `battle_maps/` registry (parse only — [`validate_battle_maps`] validates).
///
/// # Errors
/// A malformed part (the message names the file).
pub fn load_battle_maps() -> Result<Vec<BattleMapEntry>, String> {
    todo!("bt-6")
}

/// Parse a `tactics_tuning.ron` source and reject a tuning no rule can run on
/// ([`TacticsTuning::validate`], then the [`TacticsContentError::TuningFloor`] floors).
///
/// # Errors
/// [`TacticsContentError::TuningParse`], [`TacticsContentError::Tuning`] or
/// [`TacticsContentError::TuningFloor`].
pub fn parse_tactics_tuning(src: &str) -> Result<TacticsTuning, TacticsContentError> {
    let _ = src;
    todo!("bt-6")
}

/// [`parse_tactics_tuning`] over the embedded `tactics_tuning.ron`.
///
/// # Errors
/// See [`parse_tactics_tuning`].
pub fn load_tactics_tuning() -> Result<TacticsTuning, TacticsContentError> {
    todo!("bt-6")
}

/// The reference damage of the lints (design §2.1.1): the carried `calc_damage` for `skill` at
/// `level`, neutral type, no STAB, attack = defense, variance 100, no weather.
#[must_use]
pub fn dmg_ref(skill: &SkillTactics, level: u8) -> u16 {
    let _ = (skill, level);
    todo!("bt-6")
}

/// Join the sidecars onto the carried skill and species rows (the parse-don't-validate boundary).
/// Checks, first failure wins: the skill sidecar (duplicate → unknown → missing → per-row geometry,
/// `LongRangeMin`, `AllNeedsTargetOrigin`), then the species sidecar (duplicate → unknown → missing
/// → per-row dormant levers, kit tier, weather setter). Returns one [`SpeciesTactics`] per
/// `tactics_species` row, in that order.
///
/// # Errors
/// The first violation as a [`TacticsContentError`].
pub fn build_kits(
    species: &[Species],
    skills: &[SkillDef],
    tactics_skills: &[TacticsSkillDef],
    tactics_species: &[TacticsSpeciesDef],
) -> Result<Vec<SpeciesTactics>, TacticsContentError> {
    let _ = (species, skills, tactics_skills, tactics_species);
    todo!("bt-6")
}

/// The design §4.1 kit lints over a join, per kit in order: distinct geometry, a melee skill,
/// `stride + heavy.range_max ≤ 6`, `stride + any.range_max ≤ 7` (Light then Heavy), and
/// `dmg_ref(heavy) > 2 · dmg_ref(light)` at every level 5..=100 (ascending).
///
/// # Errors
/// The first violation as a [`TacticsContentError`].
pub fn lint_kits(kits: &[SpeciesTactics]) -> Result<(), TacticsContentError> {
    let _ = kits;
    todo!("bt-6")
}

/// Every map passes bt-1's validator and map ids are unique (registry order).
///
/// # Errors
/// [`TacticsContentError::DuplicateMap`] or [`TacticsContentError::BadMap`].
pub fn validate_battle_maps(maps: &[BattleMapEntry]) -> Result<(), TacticsContentError> {
    let _ = maps;
    todo!("bt-6")
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
    let _ = (items, tactics_items);
    todo!("bt-6")
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
    let _ = (zones, tactics_zones, maps);
    todo!("bt-6")
}

/// The whole tactical content gate, in order: tuning, maps, [`build_kits`], [`lint_kits`], items,
/// zones. The server's `sync_content` calls this in its validate phase, before any write.
///
/// # Errors
/// The first violation as a [`TacticsContentError`].
pub fn validate_tactics_content(
    reg: &TacticsRegistries<'_>,
) -> Result<Vec<SpeciesTactics>, TacticsContentError> {
    let _ = reg;
    todo!("bt-6")
}
