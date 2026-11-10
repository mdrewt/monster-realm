//! CTL9.4 — every interactable the world rule can offer is physically reachable.
//!
//! The interaction rule only ever offers an entity on the tile in front of, or
//! under, the character. A heal location or NPC home walled in on all four sides
//! could therefore never be interacted with. This asserts, through the product's
//! own content loader, that every heal location and every NPC home has at least
//! one walkable 4-neighbour in its zone map.

use game_core::{
    load_heal_locations, load_npc_defs, load_zone_maps, map_for, Direction, TileMap, TilePos,
};

const ALL_DIRECTIONS: [Direction; 4] = [
    Direction::North,
    Direction::South,
    Direction::East,
    Direction::West,
];

/// `true` iff at least one of `p`'s four orthogonal neighbours is walkable.
fn has_walkable_neighbour(map: &TileMap, p: TilePos) -> bool {
    ALL_DIRECTIONS.iter().any(|&d| map.is_walkable(p.step(d)))
}

#[test]
fn ctl9_4_every_heal_location_has_a_walkable_neighbour() {
    let zone_maps = load_zone_maps().expect("zone maps load");
    let heals = load_heal_locations().expect("heal locations load");
    assert!(!heals.is_empty(), "no heal locations loaded: vacuous check");
    for hl in &heals {
        let map = map_for(hl.zone_id, &zone_maps)
            .unwrap_or_else(|e| panic!("heal location {}: {e}", hl.location_id));
        let tile = TilePos {
            x: hl.tile_x,
            y: hl.tile_y,
        };
        assert!(
            has_walkable_neighbour(&map, tile),
            "heal location {} at {tile:?} in zone {} has no walkable 4-neighbour: \
             the interact rule could never offer it",
            hl.location_id,
            hl.zone_id
        );
    }
}

#[test]
fn ctl9_4_every_npc_home_has_a_walkable_neighbour() {
    let zone_maps = load_zone_maps().expect("zone maps load");
    let npcs = load_npc_defs().expect("npc defs load");
    assert!(!npcs.is_empty(), "no NPCs loaded: vacuous check");
    for npc in &npcs {
        let map = map_for(npc.zone_id, &zone_maps)
            .unwrap_or_else(|e| panic!("NPC '{}': {e}", npc.npc_id));
        let tile = TilePos {
            x: npc.home_x,
            y: npc.home_y,
        };
        assert!(
            has_walkable_neighbour(&map, tile),
            "NPC '{}' home {tile:?} in zone {} has no walkable 4-neighbour: \
             the interact rule could never offer it",
            npc.npc_id,
            npc.zone_id
        );
    }
}

// --- wap-8: the healer must not stand on (or be approached only over) grass --

/// Criterion WAP8.2: every heal tile is walkable and not tall grass, and has a
/// walkable, grass-free 4-neighbour to approach from.
/// Kills: a healer left on tall grass; a healer whose only approach is grass.
#[test]
fn wap8_2_every_heal_location_is_walkable_and_not_tall_grass() {
    let zone_maps = load_zone_maps().expect("zone maps load");
    let heals = load_heal_locations().expect("heal locations load");
    assert!(!heals.is_empty(), "no heal locations loaded: vacuous check");
    for hl in &heals {
        let map = map_for(hl.zone_id, &zone_maps)
            .unwrap_or_else(|e| panic!("heal location {}: {e}", hl.location_id));
        let tile = TilePos {
            x: hl.tile_x,
            y: hl.tile_y,
        };
        assert!(
            map.is_walkable(tile),
            "heal location {} at {tile:?} must be walkable",
            hl.location_id
        );
        assert!(
            !map.is_grass(tile),
            "heal location {} at {tile:?} must not be tall grass",
            hl.location_id
        );
        assert!(
            ALL_DIRECTIONS.iter().any(|&d| {
                let n = tile.step(d);
                map.is_walkable(n) && !map.is_grass(n)
            }),
            "heal location {} at {tile:?} has no walkable grass-free approach",
            hl.location_id
        );
    }
}

/// Criterion WAP8.2: the zone-0 healer is at (8,3) and keeps its (7,3) approach.
/// Kills: moving the healer without the map; grass on the (7,3) approach.
#[test]
fn wap8_2_zone_0_healer_at_8_3_keeps_its_7_3_approach() {
    let zone_maps = load_zone_maps().expect("zone maps load");
    let heals = load_heal_locations().expect("heal locations load");
    let hl = heals
        .iter()
        .find(|h| h.zone_id == 0)
        .expect("zone 0 has a heal location");
    assert_eq!(
        (hl.tile_x, hl.tile_y),
        (8, 3),
        "zone-0 healer stays at (8,3)"
    );
    let map = map_for(0, &zone_maps).expect("zone 0 map");
    let approach = TilePos { x: 7, y: 3 };
    assert!(map.is_walkable(approach), "(7,3) must be walkable");
    assert!(!map.is_grass(approach), "(7,3) must not be grass");
}

// --- the predicate itself must be able to say "no" -------------------------

#[test]
fn ctl9_4_predicate_rejects_a_tile_walled_in_on_all_four_sides() {
    let map = TileMap::from_rows(0, &["###", "#.#", "###"]).expect("valid rows");
    let centre = TilePos { x: 1, y: 1 };
    assert!(
        map.is_walkable(centre),
        "fixture: the centre tile is itself floor"
    );
    assert!(
        !has_walkable_neighbour(&map, centre),
        "a tile with four wall neighbours has no walkable neighbour"
    );
}

#[test]
fn ctl9_4_predicate_treats_off_map_neighbours_as_not_walkable() {
    // A 1x1 floor map: all four neighbours are out of bounds.
    let map = TileMap::from_rows(0, &["."]).expect("valid rows");
    assert!(!has_walkable_neighbour(&map, TilePos { x: 0, y: 0 }));
}

#[test]
fn ctl9_4_predicate_accepts_a_single_open_side_in_each_direction() {
    // Centre (1,1); exactly one of its four neighbours is floor each time.
    let cases = [
        ("north", ["#.#", "#.#", "###"]),
        ("south", ["###", "#.#", "#.#"]),
        ("east", ["###", "#..", "###"]),
        ("west", ["###", "..#", "###"]),
    ];
    let centre = TilePos { x: 1, y: 1 };
    for (side, rows) in cases {
        let map = TileMap::from_rows(0, &rows).expect("valid rows");
        assert!(
            has_walkable_neighbour(&map, centre),
            "an open {side} side alone must count as reachable"
        );
    }
}
