//! sr-9b.1 gating tests for `load_test_zones.rs` (spec M-scale-readiness §sr-9b).
//!
//! Three groups, by build:
//! - EVERY build: the load band's constants and the spawn tile's geometry, and that no shipped
//!   zone id falls inside the band (the reducer that places a caller in a band zone must never
//!   reach a shipped zone).
//! - WITHOUT `load_test_zones` (`mod default_build`): the three live loaders return exactly the
//!   shipped (authored) rows — the guard that the generated zones never reach a shipped build,
//!   the e2e build or `client-wasm`. It cannot hold under the feature, so it is cfg'd out there
//!   (the `just test` feature line runs game-core WITH it).
//! - WITH `load_test_zones` (`mod load_build`): the live registries are the shipped rows followed
//!   by the generated rows, every generated map built through the REAL map builders is 16×16,
//!   all walkable, no grass, no warps, the spawn is walkable in each, and the zone-touching
//!   content gate `sync_content_inner` runs passes on the LIVE registries.
//!
//! "Shipped" is what parsing the embedded RON parts gives, never a hard-coded list or a length,
//! so a content edit to the shipped zones never breaks these tests.
//!
//! Run lines:
//!   `cargo nextest run -p game-core -E 'test(/sr9b_1/)'`
//!   `cargo nextest run -p game-core --features load_test_zones -E 'test(/sr9b_1/)'`

use super::{LOAD_ZONE_COUNT, LOAD_ZONE_FIRST_ID, LOAD_ZONE_IDS, LOAD_ZONE_SIDE, LOAD_ZONE_SPAWN};
use crate::content::{
    parse_parts, parse_zone_maps_parts, parse_zones_parts, WarpDef, ZoneDef, ZoneMapDef,
    TACTICS_ZONES_RON_PARTS, ZONES_RON_PARTS, ZONE_MAPS_RON_PARTS,
};
use crate::tactics::TacticsZoneDef;
use crate::types::TilePos;
use crate::world::{can_resume_at, TileMap};

/// The shipped zones: what parsing the embedded `zones/` parts gives.
fn shipped_zones() -> Vec<ZoneDef> {
    parse_zones_parts(ZONES_RON_PARTS).expect("zones parse")
}

/// The shipped zone maps: what parsing the embedded `zone_maps/` parts gives.
fn shipped_zone_maps() -> Vec<ZoneMapDef> {
    parse_zone_maps_parts(ZONE_MAPS_RON_PARTS).expect("maps")
}

/// The shipped tactics rows: what parsing the embedded `tactics_zones/` parts gives.
fn shipped_tactics_zones() -> Vec<TacticsZoneDef> {
    parse_parts::<TacticsZoneDef>(TACTICS_ZONES_RON_PARTS, "tactics_zones")
        .expect("the shipped tactics_zones parts parse")
}

/// `ZoneMapDef` has no `PartialEq`: every field, row by row.
fn fields(maps: &[ZoneMapDef]) -> Vec<(u32, Vec<String>, Vec<WarpDef>)> {
    maps.iter()
        .map(|m| (m.zone_id, m.rows.clone(), m.warps.clone()))
        .collect()
}

// ===========================================================================
// Every build
// ===========================================================================

/// The band is ids 10000..=10099 (100 zones), the side 16 and the spawn (1, 1).
///
/// WRONG IMPL KILLED: a band starting at 10001 or 9999, 99 or 101 zones, an inclusive range that
/// reaches 10100, a spawn on another tile, a side other than 16.
#[test]
fn the_load_zone_band_is_ids_10000_to_10099_sr9b_1() {
    assert_eq!(LOAD_ZONE_FIRST_ID, 10_000, "the first load zone id");
    assert_eq!(LOAD_ZONE_COUNT, 100, "one hundred load zones");
    assert_eq!(LOAD_ZONE_IDS, 10_000..10_100, "ids 10000..=10099");
    assert_eq!(LOAD_ZONE_IDS.count(), 100, "the band holds 100 ids");
    assert!(LOAD_ZONE_IDS.contains(&10_000), "10000 is in");
    assert!(LOAD_ZONE_IDS.contains(&10_099), "10099 is in");
    assert!(!LOAD_ZONE_IDS.contains(&9_999), "9999 is out");
    assert!(!LOAD_ZONE_IDS.contains(&10_100), "10100 is out");
    assert_eq!(LOAD_ZONE_SIDE, 16, "a load zone is 16 tiles on a side");
    assert_eq!(LOAD_ZONE_SPAWN, TilePos { x: 1, y: 1 }, "the spawn tile");
}

/// The spawn tile is inside a 16×16 map (built through the real `TileMap::from_rows`) and is a
/// tile a returning character may stand on.
///
/// WRONG IMPL KILLED: a spawn on (16, y) / (x, 16) / a negative coordinate (out of bounds of a
/// 16-side map).
#[test]
fn the_load_zone_spawn_is_an_in_bounds_walkable_tile_of_a_16_square_map_sr9b_1() {
    let side = usize::try_from(LOAD_ZONE_SIDE).expect("fits");
    let rows: Vec<String> = (0..side).map(|_| ".".repeat(side)).collect();
    let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    let map = TileMap::from_rows(LOAD_ZONE_FIRST_ID, &refs);
    let map = map.expect("a 16x16 floor map builds");
    assert_eq!((map.width, map.height), (16, 16), "PRECONDITION: 16x16");
    assert!(map.in_bounds(LOAD_ZONE_SPAWN), "the spawn is in bounds");
    assert!(can_resume_at(&map, LOAD_ZONE_SPAWN), "spawn walkable");
}

/// No shipped zone, zone map or tactics row carries an id inside the load band, and the shipped
/// registries are not empty (the check is not vacuous).
///
/// WRONG IMPL KILLED: a band that overlaps the shipped ids (the placement reducer would become a
/// teleport into a shipped zone, and the appended rows would duplicate a shipped id).
#[test]
fn no_shipped_zone_id_is_in_the_load_band_sr9b_1() {
    let zones = shipped_zones();
    let maps = shipped_zone_maps();
    let tactics = shipped_tactics_zones();
    assert!(
        !zones.is_empty() && !maps.is_empty() && !tactics.is_empty(),
        "PRECONDITION: the shipped registries are non-empty"
    );
    let ids: Vec<u32> = zones
        .iter()
        .map(|z| z.id)
        .chain(maps.iter().map(|m| m.zone_id))
        .chain(tactics.iter().map(|t| t.zone_id))
        .collect();
    let mut in_band = ids;
    in_band.retain(|id| LOAD_ZONE_IDS.contains(id));
    assert_eq!(in_band, Vec::<u32>::new(), "shipped ids in the band");
}

// ===========================================================================
// Without the feature: the live registries are exactly the shipped rows
// ===========================================================================

#[cfg(not(feature = "load_test_zones"))]
mod default_build {
    use super::{fields, shipped_tactics_zones, shipped_zone_maps, shipped_zones, LOAD_ZONE_IDS};
    use crate::content::{load_zone_maps, load_zones};
    use crate::tactics::load_tactics_zones;

    /// WRONG IMPL KILLED: the generated zones appended unconditionally (the hook ignores the
    /// feature); any extra or missing row in the default registry.
    #[test]
    fn the_default_zone_registry_is_exactly_the_shipped_zones_sr9b_1() {
        let live = load_zones().expect("the default zone registry loads");
        assert_eq!(live, shipped_zones(), "the shipped zones only");
        assert!(
            live.iter().all(|z| !LOAD_ZONE_IDS.contains(&z.id)),
            "no load zone in the default registry"
        );
    }

    /// WRONG IMPL KILLED: the generated maps appended unconditionally; a shipped map altered.
    #[test]
    fn the_default_zone_map_registry_is_exactly_the_shipped_maps_sr9b_1() {
        let live = load_zone_maps().expect("the default zone maps load");
        assert_eq!(
            fields(&live),
            fields(&shipped_zone_maps()),
            "the shipped zone maps only"
        );
        assert!(
            live.iter().all(|m| !LOAD_ZONE_IDS.contains(&m.zone_id)),
            "no load zone map in the default registry"
        );
    }

    /// WRONG IMPL KILLED: the generated tactics rows appended unconditionally.
    #[test]
    fn the_default_tactics_zone_registry_is_exactly_the_shipped_rows_sr9b_1() {
        let live = load_tactics_zones().expect("the tactics zones load");
        assert_eq!(live, shipped_tactics_zones(), "the shipped rows only");
        assert!(
            live.iter().all(|t| !LOAD_ZONE_IDS.contains(&t.zone_id)),
            "no load zone tactics row in the default registry"
        );
    }
}

// ===========================================================================
// With the feature: the shipped rows, then the 100 generated rows
// ===========================================================================

#[cfg(feature = "load_test_zones")]
mod load_build {
    use super::{
        fields, shipped_tactics_zones, shipped_zone_maps, shipped_zones, LOAD_ZONE_IDS,
        LOAD_ZONE_SPAWN,
    };
    use crate::content::{
        load_dialogue_trees, load_encounters, load_heal_locations, load_items, load_npc_defs,
        load_quest_defs, load_skills, load_species, load_type_chart, load_zone_maps, load_zones,
        validate_content, validate_encounters, validate_npc_content, validate_zones,
    };
    use crate::load_test_zones::{generated_tactics_zones, generated_zone_maps, generated_zones};
    use crate::tactics::{
        load_battle_maps, load_tactics_items, load_tactics_skills, load_tactics_species,
        load_tactics_tuning, load_tactics_zones, validate_tactics_content, TacticsRegistries,
        TacticsZoneDef,
    };
    use crate::types::TilePos;
    use crate::world::{can_resume_at, map_for, validate_zone_maps, ZoneTileMaps};

    /// The band's ids in order, as the generated rows must carry them.
    fn band() -> Vec<u32> {
        (10_000..10_100).collect()
    }

    /// The shipped zone 0 tactics row.
    fn zone_0_row(rows: &[TacticsZoneDef]) -> TacticsZoneDef {
        rows.iter()
            .find(|t| t.zone_id == 0)
            .cloned()
            .expect("PRECONDITION: a zone 0 tactics row")
    }

    /// `row` once per band id, with only `zone_id` replaced.
    fn copied_over_the_band(row: &TacticsZoneDef) -> Vec<TacticsZoneDef> {
        band()
            .into_iter()
            .map(|zone_id| TacticsZoneDef {
                zone_id,
                ..row.clone()
            })
            .collect()
    }

    /// Exactly ids 10000..=10099 in order, each `ZoneDef` 16×16.
    ///
    /// WRONG IMPL KILLED: an off-by-one band (10001..=10100, 10000..=10100), a shuffled or
    /// duplicated id, another size declared on a def.
    #[test]
    fn generated_zones_are_ids_10000_to_10099_in_order_each_16_by_16_sr9b_1() {
        let zones = generated_zones();
        let ids: Vec<u32> = zones.iter().map(|z| z.id).collect();
        assert_eq!(ids, band(), "ids 10000..=10099, in order");
        let other_sizes: Vec<(u32, u32, u32)> = zones
            .iter()
            .filter(|z| (z.width, z.height) != (16, 16))
            .map(|z| (z.id, z.width, z.height))
            .collect();
        assert_eq!(other_sizes, vec![], "every generated zone is 16x16");
    }

    /// The live zone registry is the shipped zones followed by the 100 generated ones.
    ///
    /// WRONG IMPL KILLED: the hook not wired (no generated zone loads); the generated zones
    /// prepended or interleaved; a shipped zone dropped or replaced; the rows appended twice.
    #[test]
    fn the_load_build_zone_registry_is_the_shipped_zones_then_the_generated_ones_sr9b_1() {
        let shipped = shipped_zones();
        let live = load_zones().expect("the load build's zones load");
        let mut want = shipped.clone();
        want.extend(generated_zones());
        assert_eq!(live, want, "shipped zones, then the generated ones");
        let mut ids: Vec<u32> = shipped.iter().map(|z| z.id).collect();
        ids.extend(band());
        let live_ids: Vec<u32> = live.iter().map(|z| z.id).collect();
        assert_eq!(live_ids, ids, "the shipped ids, then 10000..=10099");
    }

    /// Every generated map is 16 rows of 16 tiles with no warps, one per band id, in order.
    ///
    /// WRONG IMPL KILLED: 15 or 17 rows / columns; a warp left in a load map (a warp would carry
    /// a bot into a shipped zone); a map missing for some band id; maps out of order.
    #[test]
    fn generated_zone_maps_are_16_rows_of_16_with_no_warps_sr9b_1() {
        let maps = generated_zone_maps();
        let ids: Vec<u32> = maps.iter().map(|m| m.zone_id).collect();
        assert_eq!(ids, band(), "one map per id 10000..=10099, in order");
        for m in &maps {
            let id = m.zone_id;
            let widths: Vec<usize> = m.rows.iter().map(|r| r.chars().count()).collect();
            assert_eq!(widths, vec![16; 16], "zone {id}: 16 rows of 16 tiles");
            assert!(m.warps.is_empty(), "zone {id}: no warps");
        }
    }

    /// The live zone-map registry is the shipped maps followed by the generated ones.
    ///
    /// WRONG IMPL KILLED: the `load_zone_maps` hook not wired, prepended, or appended twice; a
    /// shipped map altered.
    #[test]
    fn the_load_build_zone_map_registry_is_the_shipped_maps_then_the_generated_ones_sr9b_1() {
        let live = load_zone_maps().expect("the load build's zone maps load");
        let mut want = fields(&shipped_zone_maps());
        want.extend(fields(&generated_zone_maps()));
        assert_eq!(fields(&live), want, "shipped maps, then the generated");
    }

    /// Through the REAL map builders over the LIVE registry (`map_for`, and `ZoneTileMaps`,
    /// which the server's map cache uses), every band zone builds a 16×16 map with no warps in
    /// which every tile is walkable and none is tall grass.
    ///
    /// WRONG IMPL KILLED: a wall, water or tree glyph anywhere (an unwalkable tile); a `~` tile
    /// (a grass step would start a wild battle under load); a border of walls; rows that do not
    /// build; a band zone the server's map cache cannot find.
    #[test]
    fn every_tile_of_every_generated_map_is_walkable_and_none_is_grass_sr9b_1() {
        let live = load_zone_maps().expect("the load build's zone maps load");
        let cache = ZoneTileMaps::build(&live);
        for id in LOAD_ZONE_IDS {
            let map = map_for(id, &live).expect("the zone builds");
            assert_eq!(
                cache.get(id).cloned(),
                Ok(map.clone()),
                "zone {id}: the server's map cache builds the same map"
            );
            assert_eq!(map.zone_id, id, "zone {id}: the map's zone id");
            assert_eq!((map.width, map.height), (16, 16), "zone {id}: 16x16");
            assert!(map.warps.is_empty(), "zone {id}: no warps");
            let mut blocked = Vec::new();
            let mut grass = Vec::new();
            for y in 0..16 {
                for x in 0..16 {
                    let p = TilePos { x, y };
                    if !map.is_walkable(p) {
                        blocked.push((x, y));
                    }
                    if map.is_grass(p) {
                        grass.push((x, y));
                    }
                }
            }
            assert_eq!(blocked, vec![], "zone {id}: every tile is walkable");
            assert_eq!(grass, vec![], "zone {id}: no tile is tall grass");
        }
    }

    /// `LOAD_ZONE_SPAWN` is in bounds and a tile a character may stand on in every band zone's
    /// LIVE map.
    ///
    /// WRONG IMPL KILLED: a spawn outside the generated maps; a band zone whose spawn tile is
    /// blocked.
    #[test]
    fn the_load_zone_spawn_is_walkable_in_every_generated_map_sr9b_1() {
        let live = load_zone_maps().expect("the load build's zone maps load");
        for id in LOAD_ZONE_IDS {
            let map = map_for(id, &live).expect("the zone builds");
            assert!(map.in_bounds(LOAD_ZONE_SPAWN), "zone {id}: in bounds");
            assert!(can_resume_at(&map, LOAD_ZONE_SPAWN), "zone {id}: walkable");
        }
    }

    /// Each generated tactics row is the shipped zone 0 row with only `zone_id` replaced, one
    /// per band id, in order.
    ///
    /// WRONG IMPL KILLED: zone 1's row copied (another battle-map pool); default pack weights or
    /// an empty pool; the authored zone id left in place (duplicate zone 0 rows); a missing id.
    #[test]
    fn every_generated_tactics_row_is_zone_0s_shipped_row_with_its_own_id_sr9b_1() {
        let shipped = shipped_tactics_zones();
        let want = copied_over_the_band(&zone_0_row(&shipped));
        assert_eq!(generated_tactics_zones(&shipped), want);
    }

    /// The copy is of the row whose `zone_id` is 0, wherever it sits in the authored list; with
    /// no zone 0 row there is nothing to copy and no row is generated.
    ///
    /// WRONG IMPL KILLED: copying `authored[0]` (the shipped list happens to start with zone 0);
    /// copying the last row; a panic on an authored list without zone 0.
    #[test]
    fn generated_tactics_rows_copy_the_zone_0_row_wherever_it_sits_sr9b_1() {
        let shipped = shipped_tactics_zones();
        let other = shipped
            .iter()
            .find(|t| t.zone_id != 0)
            .cloned()
            .expect("PRECONDITION: a shipped tactics row other than zone 0");
        // A zone 0 row unlike any shipped row, listed second.
        let z0 = TacticsZoneDef {
            battle_map_pool: vec![6],
            ..zone_0_row(&shipped)
        };
        assert_ne!(
            z0.battle_map_pool, other.battle_map_pool,
            "PRECONDITION: the two rows differ"
        );
        let got = generated_tactics_zones(&[other.clone(), z0.clone()]);
        let want = copied_over_the_band(&z0);
        assert_eq!(got, want, "zone 0's row is copied, not the first row");
        let none = generated_tactics_zones(&[other]);
        assert_eq!(none, vec![], "no zone 0 row: nothing generated");
    }

    /// The live tactics registry is the shipped rows followed by the generated ones.
    ///
    /// WRONG IMPL KILLED: the `load_tactics_zones` hook not wired (the tactics gate then refuses
    /// every band zone: `MissingZoneEntry(10000)`), prepended, or appended twice.
    #[test]
    fn the_load_build_tactics_zone_registry_is_the_shipped_rows_then_the_generated_ones_sr9b_1() {
        let shipped = shipped_tactics_zones();
        let live = load_tactics_zones().expect("tactics zones load");
        let mut want = shipped.clone();
        want.extend(copied_over_the_band(&zone_0_row(&shipped)));
        assert_eq!(live, want, "shipped rows, then the generated ones");
    }

    /// The content gate `sync_content_inner` runs before any write (server-module
    /// `content.rs`) — every zone-touching validator plus `validate_content` — passes on the
    /// LIVE load-build registries: publishing the load build would otherwise fail its `init`.
    ///
    /// WRONG IMPL KILLED: a generated zone without a map or a map without a zone; a map larger
    /// than its zone; a duplicate id; a band zone with no tactics row; a tactics row naming a
    /// battle map that does not exist.
    #[test]
    fn the_load_build_passes_the_content_gate_sync_content_runs_sr9b_1() {
        let zones = load_zones().expect("zones");
        let zone_maps = load_zone_maps().expect("zone maps");
        let ids: Vec<u32> = zones.iter().map(|z| z.id).collect();
        assert!(
            band().iter().all(|id| ids.contains(id)),
            "PRECONDITION: the gate runs over the generated zones too"
        );
        let species = load_species().expect("species");
        let skills = load_skills().expect("skills");
        let type_chart = load_type_chart().expect("type chart");
        let items = load_items().expect("items");
        let encounters = load_encounters().expect("encounters");
        let npc_defs = load_npc_defs().expect("npcs");
        let dialogue_trees = load_dialogue_trees().expect("dialogue trees");
        let quest_defs = load_quest_defs().expect("quests");
        let heal_defs = load_heal_locations().expect("heal locations");
        let tactics_skills = load_tactics_skills().expect("tactics skills");
        let tactics_species = load_tactics_species().expect("tactics species");
        let tactics_items = load_tactics_items().expect("tactics items");
        let tactics_zones = load_tactics_zones().expect("tactics zones");
        let battle_maps = load_battle_maps().expect("battle maps");
        let tuning = load_tactics_tuning().expect("tactics tuning");

        assert_eq!(validate_zones(&zones), Ok(()), "validate_zones");
        let maps_ok = validate_zone_maps(&zone_maps, &zones);
        assert_eq!(maps_ok, Ok(()), "validate_zone_maps");
        let content_ok = validate_content(&species, &skills, &type_chart, &items);
        assert_eq!(content_ok, Ok(()), "validate_content");
        let encounters_ok = validate_encounters(&encounters, &species, &zones);
        assert_eq!(encounters_ok, Ok(()), "validate_encounters");
        let npc_ok = validate_npc_content(
            &npc_defs,
            &dialogue_trees,
            &quest_defs,
            &zones,
            &items,
            &heal_defs,
        );
        assert_eq!(npc_ok, Ok(()), "validate_npc_content");
        let tactics = validate_tactics_content(&TacticsRegistries {
            species: &species,
            skills: &skills,
            items: &items,
            zones: &zones,
            tactics_skills: &tactics_skills,
            tactics_species: &tactics_species,
            tactics_items: &tactics_items,
            tactics_zones: &tactics_zones,
            battle_maps: &battle_maps,
            tuning: &tuning,
        });
        assert_eq!(tactics.map(|_| ()), Ok(()), "validate_tactics_content");
    }
}
