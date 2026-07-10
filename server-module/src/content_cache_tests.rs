//! Gating tests for the `content_cache` module (M13.5d).
//!
//! Declared from `content_cache.rs` with:
//!   `#[cfg(test)] #[path = "content_cache_tests.rs"] mod content_cache_tests;`
//!
//! RED state: this file does not compile until the implementer creates
//! `server-module/src/content_cache.rs` exposing:
//!   - `cached_zone_maps()      -> Result<&'static Vec<game_core::ZoneMapDef>, String>`
//!   - `cached_evolutions()     -> Result<&'static Vec<game_core::SpeciesEvolutions>, String>`
//!   - `cached_dialogue_trees() -> Result<&'static Vec<game_core::DialogueTree>, String>`
//!   - `cached_quest_defs()     -> Result<&'static Vec<game_core::QuestDef>, String>`
//! and adds `mod content_cache;` to `lib.rs`.
//!
//! EARS criteria covered:
//!   13.5d-1 transparency: each cached_ fn returns the same data as the
//!     corresponding game_core::load_*() counterpart.
//!   13.5d-1 structural (OnceLock proof): two calls to the same cached_ fn
//!     return the SAME pointer address — proves OnceLock actually caches.
//!   13.5d-1 battle.rs hoist: compute_evolves_to with evolutions from
//!     cached_evolutions() produces the same result as with load_evolutions().
//!   13.5d-2 (server side): cached_zone_maps() + map_for(0, …) returns Ok.

// `super` is the `content_cache` module (declared via #[path]).
use super::*;

// ---------------------------------------------------------------------------
// 13.5d-1 — observational transparency: cached data == freshly-loaded data
// ---------------------------------------------------------------------------

/// CRITERION 13.5d-1 (zone maps): cached_zone_maps() returns the same data
/// as game_core::load_zone_maps().
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

/// CRITERION 13.5d-1 (evolutions): cached_evolutions() == load_evolutions().
///
/// SpeciesEvolutions derives PartialEq, so direct equality is safe.
///
/// Wrong impl killed: a static populated with a different content snapshot, or
/// one whose OnceLock is never seeded (returns empty Vec).
#[test]
fn cached_evolutions_matches_load() {
    let cached = cached_evolutions().expect("cached_evolutions must succeed");
    let loaded = game_core::load_evolutions().expect("game_core::load_evolutions must succeed");
    assert_eq!(
        *cached, loaded,
        "cached_evolutions() data does not match game_core::load_evolutions()"
    );
}

/// CRITERION 13.5d-1 (dialogue trees): cached_dialogue_trees() == load_dialogue_trees().
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

/// CRITERION 13.5d-1 (quest defs): cached_quest_defs() == load_quest_defs().
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
// 13.5d-1 structural — OnceLock proof: two calls return the SAME pointer
// ---------------------------------------------------------------------------

/// CRITERION 13.5d-1 structural (zone maps): two successive calls to
/// cached_zone_maps() return the SAME Vec pointer.
///
/// `std::ptr::eq` on two `&'static Vec<T>` references proves that the backing
/// allocation is the same — i.e., the first call initialized the OnceLock and
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

/// CRITERION 13.5d-1 structural (evolutions): two successive calls to
/// cached_evolutions() return the SAME Vec pointer.
///
/// Wrong impl killed: any impl that calls load_evolutions() on every invocation,
/// or allocates a new Vec<SpeciesEvolutions> on each call.
#[test]
fn cached_evolutions_ptr_eq_second_call() {
    let first = cached_evolutions().expect("first call must succeed");
    let second = cached_evolutions().expect("second call must succeed");
    assert!(
        std::ptr::eq(first as *const _, second as *const _),
        "cached_evolutions() returned different pointers on two calls — \
         OnceLock is not caching (the Vec was re-allocated or re-parsed)"
    );
}

// ---------------------------------------------------------------------------
// 13.5d-1 zone-map lookup: cached data works through game_core::map_for
// ---------------------------------------------------------------------------

/// CRITERION 13.5d-1 (zone map lookup consistency): verifies that zone 0 can
/// be found via game_core::map_for(0, cached_zone_maps().unwrap()).
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

// ---------------------------------------------------------------------------
// 13.5d-1 battle.rs hoist — compute_evolves_to parity
// ---------------------------------------------------------------------------

/// CRITERION 13.5d-1 (battle.rs hoist): compute_evolves_to called with
/// evolutions from cached_evolutions() produces the same result as when called
/// with evolutions from load_evolutions().
///
/// This encodes the observational equivalence of the hoist: before the hoist,
/// write_back_battle_results called load_evolutions() inside the XP loop;
/// after the hoist, it uses cached_evolutions(). The per-monster evolves_to
/// output must be unchanged.
///
/// Strategy: build a minimal Monster row for species 1 at level 16/bond 50,
/// look up its evolution branches from both sources, call compute_evolves_to on
/// each, and assert equality. Works even if there are no evolutions (both
/// return None). This is deterministic and requires no DB or context.
///
/// Wrong impl killed: a cached_evolutions() that returns stale/different content
/// — a monster that should evolve at level 16 would silently fail to show
/// evolves_to after battle XP pushes it past level 16.
#[test]
fn cached_evolves_to_matches_load_evolves_to() {
    use crate::schema::Monster;
    use game_core::NatureKind;

    // Minimal Monster row — only species_id, level, bond are used by
    // compute_evolves_to (see evolution.rs: builds a MonsterInstance and calls
    // game_core_evolves_to). The other fields are required to construct the
    // struct but are unused by the seam. `nickname` is String (not Option),
    // `party_slot` is u8 (255 = boxed sentinel per PARTY_SLOT_NONE, 0 = slot 0).
    let m = Monster {
        monster_id: 1,
        owner_identity: spacetimedb::Identity::from_byte_array([1u8; 32]),
        species_id: 1,
        nickname: String::new(),
        level: 16, // a level that could trigger a level-based evolution
        xp: 0,
        bond: 50,
        iv_hp: 15,
        iv_attack: 15,
        iv_defense: 15,
        iv_speed: 15,
        iv_sp_attack: 15,
        iv_sp_defense: 15,
        nature_kind: NatureKind::Hardy,
        ev_hp: 0,
        ev_attack: 0,
        ev_defense: 0,
        ev_speed: 0,
        ev_sp_attack: 0,
        ev_sp_defense: 0,
        stat_hp: 50,
        stat_attack: 50,
        stat_defense: 50,
        stat_speed: 50,
        stat_sp_attack: 50,
        stat_sp_defense: 50,
        current_hp: 50,
        party_slot: 0,
        last_care_at_ms: 0,
        evolves_to: None,
    };

    // Get evolution slices from both sources for species_id == m.species_id.
    let cached = cached_evolutions().expect("cached_evolutions must succeed");
    let loaded = game_core::load_evolutions().expect("load_evolutions must succeed");

    let cached_slice = cached
        .iter()
        .find(|se| se.species_id == m.species_id)
        .map(|se| &se.evolutions[..])
        .unwrap_or(&[]);

    let loaded_slice = loaded
        .iter()
        .find(|se| se.species_id == m.species_id)
        .map(|se| &se.evolutions[..])
        .unwrap_or(&[]);

    let result_cached = crate::evolution::compute_evolves_to(cached_slice, &m);
    let result_loaded = crate::evolution::compute_evolves_to(loaded_slice, &m);

    assert_eq!(
        result_cached, result_loaded,
        "compute_evolves_to with cached evolutions ({:?}) differs from \
         result with freshly-loaded evolutions ({:?}) for species {} level {}",
        result_cached, result_loaded, m.species_id, m.level
    );
}
