//! Content parse caches — `LazyLock` statics for compile-time-embedded registries.
//!
//! All registries are `include_str!`-embedded at build time and
//! immutable at runtime: content is data, not code, and only changes on a fresh
//! binary deploy. These helpers parse once per server process and return a
//! `&'static` reference on every subsequent call. Game-core stays pure (no caches
//! there, per the functional-core/imperative-shell invariant).
//!
//! `LazyLock<Result<Vec<T>, String>>` caches both successes and failures. For
//! compile-time-embedded content, a parse failure is always deterministic, so
//! caching the error is correct: no retry path exists that could produce a
//! different result from the same binary.

use std::sync::LazyLock;

static ZONE_MAPS: LazyLock<Result<Vec<game_core::ZoneMapDef>, String>> =
    LazyLock::new(game_core::load_zone_maps);

/// Every zone's `TileMap`, built once from `ZONE_MAPS` (the movement tick used
/// to rebuild its zone's grid from the registry on every tick).
static ZONE_TILE_MAPS: LazyLock<Result<game_core::ZoneTileMaps, String>> =
    LazyLock::new(|| cached_zone_maps().map(|maps| game_core::ZoneTileMaps::build(maps)));

static DIALOGUE_TREES: LazyLock<Result<Vec<game_core::DialogueTree>, String>> =
    LazyLock::new(game_core::load_dialogue_trees);

static QUEST_DEFS: LazyLock<Result<Vec<game_core::QuestDef>, String>> =
    LazyLock::new(game_core::load_quest_defs);

static ITEMS: LazyLock<Result<Vec<game_core::ItemDef>, String>> =
    LazyLock::new(game_core::load_items);

static HEAL_LOCATIONS: LazyLock<Result<Vec<game_core::HealLocationDef>, String>> =
    LazyLock::new(game_core::load_heal_locations);

// bt-6: the five tactical sidecar registries (`game_core::tactics::content`).
static TACTICS_SKILLS: LazyLock<Result<Vec<game_core::TacticsSkillDef>, String>> =
    LazyLock::new(game_core::load_tactics_skills);

static TACTICS_SPECIES: LazyLock<Result<Vec<game_core::TacticsSpeciesDef>, String>> =
    LazyLock::new(game_core::load_tactics_species);

static TACTICS_ITEMS: LazyLock<Result<Vec<game_core::TacticsItemDef>, String>> =
    LazyLock::new(game_core::load_tactics_items);

static TACTICS_ZONES: LazyLock<Result<Vec<game_core::TacticsZoneDef>, String>> =
    LazyLock::new(game_core::load_tactics_zones);

static BATTLE_MAPS: LazyLock<Result<Vec<game_core::BattleMapEntry>, String>> =
    LazyLock::new(game_core::load_battle_maps);

/// Zone-maps registry: parsed once, returned as `&'static` on every subsequent call.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_zone_maps() -> Result<&'static Vec<game_core::ZoneMapDef>, String> {
    (*ZONE_MAPS).as_ref().map_err(Clone::clone)
}

/// One zone's `TileMap`, built once per process: `game_core::map_for(zone_id,
/// cached_zone_maps()?)` by `&'static` reference.
///
/// # Errors
/// The cached registry parse error, or `map_for`'s own error for this zone
/// (unknown `zone_id`, malformed rows) — per zone, never for its neighbours.
pub(crate) fn cached_zone_tile_map(zone_id: u32) -> Result<&'static game_core::TileMap, String> {
    (*ZONE_TILE_MAPS)
        .as_ref()
        .map_err(Clone::clone)?
        .get(zone_id)
}

/// Dialogue-trees registry: parsed once per process.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_dialogue_trees() -> Result<&'static Vec<game_core::DialogueTree>, String> {
    (*DIALOGUE_TREES).as_ref().map_err(Clone::clone)
}

/// Quest-defs registry: parsed once per process.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_quest_defs() -> Result<&'static Vec<game_core::QuestDef>, String> {
    (*QUEST_DEFS).as_ref().map_err(Clone::clone)
}

/// Items registry: parsed once per process.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_items() -> Result<&'static Vec<game_core::ItemDef>, String> {
    (*ITEMS).as_ref().map_err(Clone::clone)
}

/// Heal-locations registry: parsed once per process (the eighth LazyLock).
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_heal_locations() -> Result<&'static Vec<game_core::HealLocationDef>, String> {
    (*HEAL_LOCATIONS).as_ref().map_err(Clone::clone)
}

/// `tactics_skills` sidecar registry: parsed once per process.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_tactics_skills() -> Result<&'static Vec<game_core::TacticsSkillDef>, String> {
    (*TACTICS_SKILLS).as_ref().map_err(Clone::clone)
}

/// `tactics_species` sidecar registry: parsed once per process.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_tactics_species() -> Result<&'static Vec<game_core::TacticsSpeciesDef>, String>
{
    (*TACTICS_SPECIES).as_ref().map_err(Clone::clone)
}

/// `tactics_items` sidecar registry: parsed once per process.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_tactics_items() -> Result<&'static Vec<game_core::TacticsItemDef>, String> {
    (*TACTICS_ITEMS).as_ref().map_err(Clone::clone)
}

/// `tactics_zones` sidecar registry: parsed once per process.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_tactics_zones() -> Result<&'static Vec<game_core::TacticsZoneDef>, String> {
    (*TACTICS_ZONES).as_ref().map_err(Clone::clone)
}

/// `battle_maps` registry: parsed once per process (validated by `sync_content`).
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_battle_maps() -> Result<&'static Vec<game_core::BattleMapEntry>, String> {
    (*BATTLE_MAPS).as_ref().map_err(Clone::clone)
}

#[cfg(test)]
#[path = "content_cache_tests.rs"]
mod content_cache_tests;
