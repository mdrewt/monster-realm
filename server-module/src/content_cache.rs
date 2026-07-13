//! Content parse caches — `LazyLock` statics for compile-time-embedded registries.
//!
//! All six registries are `include_str!`-embedded at build time (ADR-0057) and
//! immutable at runtime: content is data, not code, and only changes on a fresh
//! binary deploy. These helpers parse once per server process and return a
//! `&'static` reference on every subsequent call. Game-core stays pure (no caches
//! there, per the functional-core/imperative-shell invariant, ADR-0089).
//!
//! `LazyLock<Result<Vec<T>, String>>` caches both successes and failures. For
//! compile-time-embedded content, a parse failure is always deterministic, so
//! caching the error is correct: no retry path exists that could produce a
//! different result from the same binary.

use std::sync::LazyLock;

static ZONE_MAPS: LazyLock<Result<Vec<game_core::ZoneMapDef>, String>> =
    LazyLock::new(game_core::load_zone_maps);

static EVOLUTIONS: LazyLock<Result<Vec<game_core::SpeciesEvolutions>, String>> =
    LazyLock::new(game_core::load_evolutions);

static DIALOGUE_TREES: LazyLock<Result<Vec<game_core::DialogueTree>, String>> =
    LazyLock::new(game_core::load_dialogue_trees);

static QUEST_DEFS: LazyLock<Result<Vec<game_core::QuestDef>, String>> =
    LazyLock::new(game_core::load_quest_defs);

static SKILLS: LazyLock<Result<Vec<game_core::SkillDef>, String>> =
    LazyLock::new(game_core::load_skills);

static ITEMS: LazyLock<Result<Vec<game_core::ItemDef>, String>> =
    LazyLock::new(game_core::load_items);

/// Zone-maps registry: parsed once, returned as `&'static` on every subsequent call.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_zone_maps() -> Result<&'static Vec<game_core::ZoneMapDef>, String> {
    (*ZONE_MAPS).as_ref().map_err(Clone::clone)
}

/// Evolution registry: parsed once per process.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_evolutions() -> Result<&'static Vec<game_core::SpeciesEvolutions>, String> {
    (*EVOLUTIONS).as_ref().map_err(Clone::clone)
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

/// Skills registry: parsed once per process.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_skills() -> Result<&'static Vec<game_core::SkillDef>, String> {
    (*SKILLS).as_ref().map_err(Clone::clone)
}

/// Items registry: parsed once per process.
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_items() -> Result<&'static Vec<game_core::ItemDef>, String> {
    (*ITEMS).as_ref().map_err(Clone::clone)
}

#[cfg(test)]
#[path = "content_cache_tests.rs"]
mod content_cache_tests;
