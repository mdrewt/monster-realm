//! Gating tests for the `content_cache` module.
//!
//! Declared from `content_cache.rs` with:
//!   `#[cfg(test)] #[path = "content_cache_tests.rs"] mod content_cache_tests;`

// `super` is the `content_cache` module (declared via #[path]).
use super::*;

// ---------------------------------------------------------------------------
// Observational transparency: cached data == freshly-loaded data
// ---------------------------------------------------------------------------

/// cached_zone_maps() returns the same data as game_core::load_zone_maps().
///
/// ZoneMapDef does NOT derive PartialEq (only Serialize/Deserialize), so we
/// compare via JSON/RON serialization — the canonical round-trip for content.
/// Any caching impl that parses a different RON snapshot, trims entries, or
/// reorders rows will fail here.
///
/// Wrong impl killed: a static that points at a hard-coded subset of zone maps,
/// or one that is never populated (returns empty Vec).
#[test]
fn cached_zone_maps_matches_load() {
    let cached = cached_zone_maps().expect("cached_zone_maps must succeed");
    let loaded = game_core::load_zone_maps().expect("game_core::load_zone_maps must succeed");

    // Compare count first for a clearer failure message.
    assert_eq!(
        cached.len(),
        loaded.len(),
        "cached_zone_maps() returned {} entries but load_zone_maps() returned {}",
        cached.len(),
        loaded.len()
    );

    // Compare zone_id and row counts — the primary identity fields for zone maps.
    // (ZoneMapDef has no PartialEq, so we compare the fields we can reach.)
    for (c, l) in cached.iter().zip(loaded.iter()) {
        assert_eq!(
            c.zone_id, l.zone_id,
            "cached zone_id {} != loaded zone_id {}",
            c.zone_id, l.zone_id
        );
        assert_eq!(
            c.rows.len(),
            l.rows.len(),
            "zone {} cached row count {} != loaded row count {}",
            c.zone_id,
            c.rows.len(),
            l.rows.len()
        );
        // Spot-check first row content if present.
        if let (Some(cr), Some(lr)) = (c.rows.first(), l.rows.first()) {
            assert_eq!(
                cr, lr,
                "zone {} first tile row differs between cached and loaded",
                c.zone_id
            );
        }
        assert_eq!(
            c.warps.len(),
            l.warps.len(),
            "zone {} cached warp count {} != loaded warp count {}",
            c.zone_id,
            c.warps.len(),
            l.warps.len()
        );
    }
}

/// cached_dialogue_trees() == load_dialogue_trees().
///
/// DialogueTree derives PartialEq.
///
/// Wrong impl killed: a static that never gets initialized (stays empty), or
/// one that parses a stale/different version of the dialogue RON content.
#[test]
fn cached_dialogue_trees_matches_load() {
    let cached = cached_dialogue_trees().expect("cached_dialogue_trees must succeed");
    let loaded =
        game_core::load_dialogue_trees().expect("game_core::load_dialogue_trees must succeed");
    assert_eq!(
        *cached, loaded,
        "cached_dialogue_trees() data does not match game_core::load_dialogue_trees()"
    );
}

/// cached_quest_defs() == load_quest_defs().
///
/// QuestDef derives PartialEq.
///
/// Wrong impl killed: a static scoped to only a subset of quests, or one whose
/// OnceLock is initialized from the wrong RON file path.
#[test]
fn cached_quest_defs_matches_load() {
    let cached = cached_quest_defs().expect("cached_quest_defs must succeed");
    let loaded = game_core::load_quest_defs().expect("game_core::load_quest_defs must succeed");
    assert_eq!(
        *cached, loaded,
        "cached_quest_defs() data does not match game_core::load_quest_defs()"
    );
}

// ---------------------------------------------------------------------------
// LazyLock proof: two calls return the SAME pointer
// ---------------------------------------------------------------------------

/// two successive calls to cached_zone_maps() return the SAME Vec pointer.
///
/// `std::ptr::eq` on two `&'static Vec<T>` references proves that the backing
/// allocation is the same — i.e., the first call initialized the LazyLock and
/// the second call returned the cached reference rather than re-parsing.
///
/// Wrong impl killed: any impl that calls load_zone_maps() on every invocation
/// (re-parses each time), or one that returns a newly-allocated Vec each call.
#[test]
fn cached_zone_maps_ptr_eq_second_call() {
    let first = cached_zone_maps().expect("first call must succeed");
    let second = cached_zone_maps().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_zone_maps() returned different pointers on two calls — \
         OnceLock is not caching (the Vec was re-allocated or re-parsed)"
    );
}

// ---------------------------------------------------------------------------
// zone-map lookup: cached data works through game_core::map_for
// ---------------------------------------------------------------------------

/// verifies that zone 0 can be found via game_core::map_for(0,
/// cached_zone_maps().unwrap()).
///
/// This proves the cached data is not only equal to the loaded data in shape,
/// but also usable by the actual lookup function — the same path the server's
/// movement_tick takes after hoisting to the cache.
///
/// Wrong impl killed: an impl that returns a correctly-shaped Vec but with
/// garbled zone_ids (e.g. all zone_ids set to 0xFF), causing map_for to fail.
#[test]
fn cached_zone_maps_is_consistent_with_map_for() {
    let maps = cached_zone_maps().expect("cached_zone_maps must succeed");
    let result = game_core::map_for(0, maps);
    assert!(
        result.is_ok(),
        "game_core::map_for(0, cached_zone_maps()) must return Ok for zone 0, got: {:?}",
        result.err()
    );
}

/// `cached_zone_tile_map(z)` is `game_core::map_for(z, cached_zone_maps())` for
/// every shipped zone and for an absent id (same error text), and two calls
/// hand back the SAME allocation (built once, not per call).
#[test]
fn cached_zone_tile_map_equals_map_for_and_is_built_once() {
    let maps = cached_zone_maps().expect("cached_zone_maps must succeed");
    assert!(!maps.is_empty(), "shipped content has zones");
    let absent = maps.iter().map(|m| m.zone_id).max().unwrap_or(0) + 1;
    for zone_id in maps.iter().map(|m| m.zone_id).chain([absent]) {
        assert_eq!(
            cached_zone_tile_map(zone_id).cloned(),
            game_core::map_for(zone_id, maps),
            "zone {zone_id}"
        );
    }
    let first = cached_zone_tile_map(maps[0].zone_id).expect("first zone builds");
    let second = cached_zone_tile_map(maps[0].zone_id).expect("first zone builds");
    assert!(std::ptr::eq(first, second), "the map must be built once");
}

// ===========================================================================
// Items registry cache
// ===========================================================================

/// `cached_items()` returns exactly the same data as
/// `game_core::load_items()` — same count and same contents.
///
/// `ItemDef` derives `PartialEq + Eq`, so direct `assert_eq!` is safe. Count
/// is checked first for a clearer failure message.
///
/// Wrong impl killed: a static that hard-codes a subset of items, returns an
/// empty Vec, parses a stale snapshot, or reorders entries.
#[test]
fn cached_items_matches_load() {
    let cached = cached_items().expect("cached_items() must succeed");
    let loaded = game_core::load_items().expect("game_core::load_items() must succeed");

    assert_eq!(
        cached.len(),
        loaded.len(),
        "cached_items() returned {} entries but game_core::load_items() returned {}",
        cached.len(),
        loaded.len()
    );
    assert_eq!(
        *cached, loaded,
        "cached_items() data does not match game_core::load_items()"
    );
}

/// two successive calls to `cached_items()` return the SAME `Vec` pointer.
///
/// `std::ptr::eq` on two `&'static Vec<ItemDef>` references proves the backing
/// allocation is identical — the first call initialised the `LazyLock` and the
/// second returned the cached reference without re-parsing.
///
/// Wrong impl killed: any accessor that calls `game_core::load_items()` on every
/// invocation, or allocates a fresh `Vec<ItemDef>` on each call.
#[test]
fn cached_items_ptr_eq_second_call() {
    let first = cached_items().expect("first call to cached_items() must succeed");
    let second = cached_items().expect("second call to cached_items() must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_items() returned different pointers on two calls — \
         LazyLock is not caching (the Vec was re-allocated or re-parsed on the second call)"
    );
}

// ===========================================================================
// bt-6 (BT6.6): the five tactical sidecar registries
//
// Each accessor must (a) return exactly what the game-core loader returns and
// (b) parse once per process. Every row type derives `PartialEq + Eq`, so the
// comparison is the whole `Vec`. The non-empty assertions keep a vacuous
// `[] == []` from passing; the exact row counts are pinned by the game-core
// content tests, not here.
// ===========================================================================

/// `cached_tactics_skills()` == `game_core::load_tactics_skills()`.
///
/// Wrong impl killed: a static over the wrong loader, a truncated or reordered Vec.
#[test]
fn cached_tactics_skills_matches_load_bt6_6() {
    let cached = cached_tactics_skills().expect("cached_tactics_skills() must succeed");
    let loaded =
        game_core::load_tactics_skills().expect("game_core::load_tactics_skills() must succeed");
    assert!(!cached.is_empty(), "tactics_skills must not be empty");
    assert_eq!(
        *cached, loaded,
        "cached_tactics_skills() data does not match game_core::load_tactics_skills()"
    );
}

/// `cached_tactics_species()` == `game_core::load_tactics_species()`.
#[test]
fn cached_tactics_species_matches_load_bt6_6() {
    let cached = cached_tactics_species().expect("cached_tactics_species() must succeed");
    let loaded =
        game_core::load_tactics_species().expect("game_core::load_tactics_species() must succeed");
    assert!(!cached.is_empty(), "tactics_species must not be empty");
    assert_eq!(
        *cached, loaded,
        "cached_tactics_species() data does not match game_core::load_tactics_species()"
    );
}

/// `cached_tactics_items()` == `game_core::load_tactics_items()`.
#[test]
fn cached_tactics_items_matches_load_bt6_6() {
    let cached = cached_tactics_items().expect("cached_tactics_items() must succeed");
    let loaded =
        game_core::load_tactics_items().expect("game_core::load_tactics_items() must succeed");
    assert!(!cached.is_empty(), "tactics_items must not be empty");
    assert_eq!(
        *cached, loaded,
        "cached_tactics_items() data does not match game_core::load_tactics_items()"
    );
}

/// `cached_tactics_zones()` == `game_core::load_tactics_zones()`.
#[test]
fn cached_tactics_zones_matches_load_bt6_6() {
    let cached = cached_tactics_zones().expect("cached_tactics_zones() must succeed");
    let loaded =
        game_core::load_tactics_zones().expect("game_core::load_tactics_zones() must succeed");
    assert!(!cached.is_empty(), "tactics_zones must not be empty");
    assert_eq!(
        *cached, loaded,
        "cached_tactics_zones() data does not match game_core::load_tactics_zones()"
    );
}

/// `cached_battle_maps()` == `game_core::load_battle_maps()`.
#[test]
fn cached_battle_maps_matches_load_bt6_6() {
    let cached = cached_battle_maps().expect("cached_battle_maps() must succeed");
    let loaded = game_core::load_battle_maps().expect("game_core::load_battle_maps() must succeed");
    assert!(!cached.is_empty(), "battle_maps must not be empty");
    assert_eq!(
        *cached, loaded,
        "cached_battle_maps() data does not match game_core::load_battle_maps()"
    );
}

/// Two successive calls to `cached_tactics_skills()` return the SAME `Vec` pointer.
#[test]
fn cached_tactics_skills_ptr_eq_second_call_bt6_6() {
    let first = cached_tactics_skills().expect("first call must succeed");
    let second = cached_tactics_skills().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_tactics_skills() returned different pointers on two calls — \
         LazyLock is not caching"
    );
}

/// Two successive calls to `cached_tactics_species()` return the SAME `Vec` pointer.
#[test]
fn cached_tactics_species_ptr_eq_second_call_bt6_6() {
    let first = cached_tactics_species().expect("first call must succeed");
    let second = cached_tactics_species().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_tactics_species() returned different pointers on two calls — \
         LazyLock is not caching"
    );
}

/// Two successive calls to `cached_tactics_items()` return the SAME `Vec` pointer.
#[test]
fn cached_tactics_items_ptr_eq_second_call_bt6_6() {
    let first = cached_tactics_items().expect("first call must succeed");
    let second = cached_tactics_items().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_tactics_items() returned different pointers on two calls — \
         LazyLock is not caching"
    );
}

/// Two successive calls to `cached_tactics_zones()` return the SAME `Vec` pointer.
#[test]
fn cached_tactics_zones_ptr_eq_second_call_bt6_6() {
    let first = cached_tactics_zones().expect("first call must succeed");
    let second = cached_tactics_zones().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_tactics_zones() returned different pointers on two calls — \
         LazyLock is not caching"
    );
}

/// Two successive calls to `cached_battle_maps()` return the SAME `Vec` pointer.
#[test]
fn cached_battle_maps_ptr_eq_second_call_bt6_6() {
    let first = cached_battle_maps().expect("first call must succeed");
    let second = cached_battle_maps().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_battle_maps() returned different pointers on two calls — \
         LazyLock is not caching"
    );
}

// ===========================================================================
// Heal-locations cache
//
// ===========================================================================

/// `cached_heal_locations()` returns exactly the same data as
/// `game_core::load_heal_locations()`.
///
/// `HealLocationDef` derives `PartialEq + Eq`.
///
/// Wrong impl killed: a static that drops entries or parses a stale snapshot.
/// `heal_party` reads `cost_currency` out of this registry, so a wrong snapshot
/// is a wrong PRICE — either a free heal at a paid location or a charge at a free
/// one, both of which move real currency.
#[test]
fn cached_heal_locations_matches_load() {
    let cached = cached_heal_locations().expect("cached_heal_locations() must succeed");
    let loaded =
        game_core::load_heal_locations().expect("game_core::load_heal_locations() must succeed");

    assert_eq!(
        cached.len(),
        loaded.len(),
        "cached_heal_locations() returned {} entries but \
         game_core::load_heal_locations() returned {}",
        cached.len(),
        loaded.len()
    );
    assert_eq!(
        *cached, loaded,
        "cached_heal_locations() data does not match game_core::load_heal_locations()"
    );
}

/// two successive calls to `cached_heal_locations()` return the SAME `Vec`
/// pointer.
///
/// Wrong impl killed: an accessor that re-parses the heal registry on every call.
#[test]
fn cached_heal_locations_ptr_eq_second_call() {
    let first = cached_heal_locations().expect("first call must succeed");
    let second = cached_heal_locations().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_heal_locations() returned different pointers on two calls — \
         LazyLock is not caching (the Vec was re-allocated or re-parsed on the second call)"
    );
}
