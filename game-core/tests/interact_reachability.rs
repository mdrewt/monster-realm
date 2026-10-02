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
