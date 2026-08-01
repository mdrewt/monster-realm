//! Content parse caches — `LazyLock` statics for compile-time-embedded registries.
//!
//! All eight registries are `include_str!`-embedded at build time (ADR-0057) and
//! immutable at runtime: content is data, not code, and only changes on a fresh
//! binary deploy. These helpers parse once per server process and return a
//! `&'static` reference on every subsequent call. Game-core stays pure (no caches
//! there, per the functional-core/imperative-shell invariant, ADR-0089).
//!
//! `LazyLock<Result<Vec<T>, String>>` caches both successes and failures. For
//! compile-time-embedded content, a parse failure is always deterministic, so
//! caching the error is correct: no retry path exists that could produce a
//! different result from the same binary.
//!
//! The version-keyed type-chart cache at the bottom (ADR-0170 D1) is the one
//! exception to both rules above: it caches DB-derived data (keyed on the
//! `config` row's `content_version`, so a reseed invalidates it) and it NEVER
//! caches a failed rebuild — a later transaction can fix DB rows, unlike an
//! embedded registry.

use spacetimedb::{ReducerContext, Table};
use std::sync::{Arc, LazyLock, Mutex};

use crate::schema::{config, type_relation_row};

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

static ABILITIES: LazyLock<Result<Vec<game_core::AbilityDef>, String>> =
    LazyLock::new(game_core::load_abilities);

static HEAL_LOCATIONS: LazyLock<Result<Vec<game_core::HealLocationDef>, String>> =
    LazyLock::new(game_core::load_heal_locations);

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

/// Abilities registry: parsed once per process (ADR-0170 D2, completing the
/// ADR-0089 M14.5e park).
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_abilities() -> Result<&'static Vec<game_core::AbilityDef>, String> {
    (*ABILITIES).as_ref().map_err(Clone::clone)
}

/// Heal-locations registry: parsed once per process (the eighth LazyLock,
/// ADR-0170 D3).
///
/// # Errors
/// Returns a clone of the cached parse error if the embedded RON was malformed.
pub(crate) fn cached_heal_locations() -> Result<&'static Vec<game_core::HealLocationDef>, String> {
    (*HEAL_LOCATIONS).as_ref().map_err(Clone::clone)
}

// --- Version-keyed type-chart cache (11r-g, ADR-0170 D1) ----------------------

/// The type-chart cache cell: `None` until first build, then the
/// `(content_version, chart)` pair the last successful rebuild produced.
/// A plain type alias so tests can construct and poison cells directly.
pub(crate) type TypeChartCell = Mutex<Option<(u32, Arc<game_core::TypeChart>)>>;

/// Pure cache core (ADR-0170 D1): serve the cached `Arc` on a version hit,
/// otherwise run `rebuild` and store the result — cell, version and rebuild
/// closure all injected so every decision is unit-testable without a
/// `ReducerContext` (ADR-0156 P7).
///
/// Policy, in order:
/// - version HIT → `Arc::clone` of the cached chart; `rebuild` is NOT called.
/// - version MISS → call `rebuild`; on `Ok` store `(version, chart)` and
///   return a clone.
/// - `rebuild` Err → return the error UNCHANGED and leave the cell UNTOUCHED:
///   any older-version entry survives (callers still on that version keep
///   their fast path), but stale data is never served at the wrong version.
/// - a POISONED lock is recovered via `PoisonError::into_inner`
///   (defence-in-depth: one unrelated panic must not brick every battle for
///   the process lifetime).
///
/// # Errors
/// Propagates `rebuild`'s error verbatim; never caches it (DB-derived data can
/// be fixed by a later transaction, unlike the embedded registries above).
pub(crate) fn type_chart_cache_lookup(
    cell: &TypeChartCell,
    version: u32,
    rebuild: impl FnOnce() -> Result<game_core::TypeChart, String>,
) -> Result<Arc<game_core::TypeChart>, String> {
    let mut state = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((v, chart)) = state.as_ref() {
        if *v == version {
            return Ok(Arc::clone(chart));
        }
    }
    let chart = Arc::new(rebuild()?);
    *state = Some((version, Arc::clone(&chart)));
    Ok(chart)
}

/// Version-keyed type-chart accessor (ADR-0170 D1): serves the cached chart
/// while the singleton `config` row's `content_version` matches, rebuilding
/// from `type_relation_row` on a miss. A missing `config` row keys the cache
/// at version 0 — the pre-seed sentinel, so a spurious hit merely forces a
/// rebuild on the next real call.
///
/// CONTRACT (ADR-0170 D1 invariant): never call this from any code path that
/// writes `type_relation_row` in the same transaction. `content.rs`
/// (`sync_content_inner`) and everything transitively reachable from it
/// (`marshal.rs`, `evolution.rs`) are FORBIDDEN callers: between the row
/// rewrite and the `content_version` stamp, a call here would cache the pair
/// (old version, new chart); a later panic rolls the DATABASE back but not
/// this process static, leaving a permanent version-match hit on a chart
/// built from rows that no longer exist. Pinned by the
/// `sync_content_reachable_modules_never_call_cached_type_chart` scan.
///
/// NOTE (ADR-0170 D1 trade-off): the cell lock is HELD across the rebuild
/// closure (racing rebuilds cannot clobber each other; safe because reducers
/// are serial). The re-entrancy footgun: any future rebuild path that
/// reacquires this cache would DEADLOCK — keep the rebuild closure cache-free.
///
/// # Errors
/// Propagates the rebuild's error (`marshal::type_chart_from_rows`) without
/// caching it.
pub(crate) fn cached_type_chart(ctx: &ReducerContext) -> Result<Arc<game_core::TypeChart>, String> {
    static TYPE_CHART: TypeChartCell = Mutex::new(None);
    let version = ctx
        .db
        .config()
        .id()
        .find(0)
        .map(|c| c.content_version)
        .unwrap_or(0);
    type_chart_cache_lookup(&TYPE_CHART, version, || {
        crate::marshal::type_chart_from_rows(ctx.db.type_relation_row().iter())
    })
}

#[cfg(test)]
#[path = "content_cache_tests.rs"]
mod content_cache_tests;
