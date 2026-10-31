//! bt-1 gating tests — BT1.8 (`tactics::map`): the battle-map schema and its validator.
//!
//! Maps are built as struct literals (`validate_battle_map`) and as inline RON text
//! (`parse_battle_map`). The layout workhorse is [`column_map`]: side A sits in column
//! x = 0 at y = 0,1,2 and side B in column x = k at y = 0,1,2, so the MINIMUM opposing
//! distance over the 9 cross pairs is exactly `k` (the same-row pairs) and the MAXIMUM is
//! `k + 2`. Plan A9: the opposing distance is taken over all 9 cross pairs; the minimum is
//! 5 when max(width, height) == 8 and 4 otherwise (spec names 7x7 -> 4 and 8x8 -> 5; the
//! 6xN / 7x8 sizes follow the larger side — a flagged judgement call).
//!
//! Validation order (first failure wins): width -> height -> tile count -> spawn_a count ->
//! spawn_b count -> in bounds -> overlap -> Walk-passable -> min distance -> max distance
//! -> connectivity.
//!
//! Names start `bt1_8_` — the acceptance ledger's CHECKs filter on that prefix.

use super::geometry::{Cell, Side};
use super::map::{parse_battle_map, validate_battle_map, BattleMapDef, MapError, TileDef};
use super::movement::Terrain;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

fn c(x: u8, y: u8) -> Cell {
    Cell { x, y }
}

fn tile(terrain: Terrain) -> TileDef {
    TileDef {
        terrain,
        elevation: 0,
        blocks_los: false,
    }
}

fn spawns(v: [(u8, u8); 3]) -> Vec<Cell> {
    v.iter().map(|&(x, y)| c(x, y)).collect()
}

fn map(w: u8, h: u8, a: [(u8, u8); 3], b: [(u8, u8); 3]) -> BattleMapDef {
    BattleMapDef {
        width: w,
        height: h,
        tiles: vec![tile(Terrain::Plain); usize::from(w) * usize::from(h)],
        spawn_a: spawns(a),
        spawn_b: spawns(b),
    }
}

/// A in column 0 (y 0..=2), B in column `k` (y 0..=2): min opposing = k, max = k + 2.
fn column_map(w: u8, h: u8, k: u8) -> BattleMapDef {
    map(w, h, [(0, 0), (0, 1), (0, 2)], [(k, 0), (k, 1), (k, 2)])
}

fn set(d: &mut BattleMapDef, x: u8, y: u8, terrain: Terrain) {
    let i = usize::from(y) * usize::from(d.width) + usize::from(x);
    d.tiles[i].terrain = terrain;
}

fn min_for(w: u8, h: u8) -> u16 {
    if w.max(h) == 8 {
        5
    } else {
        4
    }
}

/// RON text for a map. `explicit` writes elevation/blocks_los on every tile; otherwise the
/// compact `(terrain: X)` form relies on the serde defaults.
fn to_ron(d: &BattleMapDef, explicit: bool) -> String {
    let tiles: Vec<String> = d
        .tiles
        .iter()
        .map(|t| {
            if explicit {
                format!(
                    "(terrain: {:?}, elevation: {}, blocks_los: {})",
                    t.terrain, t.elevation, t.blocks_los
                )
            } else {
                format!("(terrain: {:?})", t.terrain)
            }
        })
        .collect();
    let cells = |v: &[Cell]| {
        v.iter()
            .map(|p| format!("(x: {}, y: {})", p.x, p.y))
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "(width: {}, height: {}, tiles: [{}], spawn_a: [{}], spawn_b: [{}])",
        d.width,
        d.height,
        tiles.join(", "),
        cells(&d.spawn_a),
        cells(&d.spawn_b)
    )
}

fn min_err(min: u16, got: u16) -> MapError {
    MapError::MinOpposingDistance { min, got }
}

/// At the minimum distance the map is valid (struct AND RON); one tile closer it is rejected
/// naming the rule, with the REAL measured distance (never clamped, never "fixed").
fn check_size(w: u8, h: u8) {
    let min = min_for(w, h);
    let k = u8::try_from(min).expect("min fits u8");
    let at_min = column_map(w, h, k);
    assert_eq!(validate_battle_map(&at_min), Ok(()), "{w}x{h} at min {min}");
    assert_eq!(
        parse_battle_map(&to_ron(&at_min, true)),
        Ok(at_min.clone()),
        "{w}x{h} RON at min"
    );
    let too_close = column_map(w, h, k - 1);
    assert_eq!(
        validate_battle_map(&too_close),
        Err(min_err(min, min - 1)),
        "{w}x{h} at min-1"
    );
    assert_eq!(
        parse_battle_map(&to_ron(&too_close, false)),
        Err(min_err(min, min - 1)),
        "{w}x{h} RON at min-1"
    );
    // One further apart than the minimum is still fine where the column exists.
    if k < w - 1 {
        assert_eq!(
            validate_battle_map(&column_map(w, h, k + 1)),
            Ok(()),
            "{w}x{h} above min"
        );
    }
}

// ===========================================================================
// BT1.8 — sizes and the per-size minimum opposing distance
// ===========================================================================

#[test]
fn bt1_8_size_6x6_min_opposing_is_4() {
    check_size(6, 6);
}

#[test]
fn bt1_8_size_6x8_min_opposing_is_5() {
    check_size(6, 8);
}

#[test]
fn bt1_8_size_7x8_min_opposing_is_5() {
    check_size(7, 8);
}

#[test]
fn bt1_8_size_8x7_min_opposing_is_5() {
    check_size(8, 7);
}

#[test]
fn bt1_8_size_7x7_min_opposing_is_4() {
    check_size(7, 7);
}

#[test]
fn bt1_8_size_8x8_min_opposing_is_5() {
    check_size(8, 8);
}

#[test]
fn bt1_8_remaining_in_range_sizes_follow_the_larger_side() {
    check_size(8, 6);
    check_size(6, 7);
    check_size(7, 6);
}

#[test]
fn bt1_8_seven_by_seven_accepts_distance_four_but_eight_by_eight_does_not() {
    // The pair the spec names: 4 on 7x7, 5 on 8x8.
    assert_eq!(validate_battle_map(&column_map(7, 7, 4)), Ok(()));
    assert_eq!(
        validate_battle_map(&column_map(8, 8, 4)),
        Err(min_err(5, 4))
    );
}

#[test]
fn bt1_8_min_distance_is_measured_over_all_nine_cross_pairs() {
    // One near slot B(4,0): A(0,0)-B(4,0) = 4 is the closest of the 9 pairs, and 4 < 5 on 8x8
    // even though the other eight pairs are all >= 5.
    let d = map(8, 8, [(0, 0), (0, 1), (0, 2)], [(4, 0), (6, 3), (6, 4)]);
    assert_eq!(validate_battle_map(&d), Err(min_err(5, 4)));
    // Move the near slot out by one: the closest pair becomes exactly 5 and the map passes.
    let ok = map(8, 8, [(0, 0), (0, 1), (0, 2)], [(5, 0), (6, 3), (6, 4)]);
    assert_eq!(validate_battle_map(&ok), Ok(()));
}

// ===========================================================================
// BT1.8 — maximum opposing distance
// ===========================================================================

#[test]
fn bt1_8_max_opposing_distance_boundary_eleven_on_8x8() {
    // A column 0 (y0..2), B column 7 (y2..4): max pair A(0,0)-B(7,4) = 11.
    let at_max = map(8, 8, [(0, 0), (0, 1), (0, 2)], [(7, 2), (7, 3), (7, 4)]);
    assert_eq!(validate_battle_map(&at_max), Ok(()));
    // One further: A(0,0)-B(7,5) = 12.
    let over = map(8, 8, [(0, 0), (0, 1), (0, 2)], [(7, 2), (7, 3), (7, 5)]);
    assert_eq!(
        validate_battle_map(&over),
        Err(MapError::MaxOpposingDistance { max: 11, got: 12 })
    );
}

#[test]
fn bt1_8_max_opposing_distance_boundary_eleven_on_7x7() {
    let at_max = map(7, 7, [(0, 0), (0, 1), (0, 2)], [(6, 2), (6, 3), (6, 5)]);
    assert_eq!(validate_battle_map(&at_max), Ok(()), "A(0,0)-B(6,5) = 11");
    let over = map(7, 7, [(0, 0), (0, 1), (0, 2)], [(6, 2), (6, 3), (6, 6)]);
    assert_eq!(
        validate_battle_map(&over),
        Err(MapError::MaxOpposingDistance { max: 11, got: 12 }),
        "A(0,0)-B(6,6) = 12"
    );
}

#[test]
fn bt1_8_max_reports_the_largest_pair_not_the_first() {
    // Pairs reach 12 only at A(0,0)-B(7,5); a first-pair check would see 7.
    let over = map(8, 8, [(0, 0), (0, 1), (0, 2)], [(7, 0), (7, 1), (7, 5)]);
    assert_eq!(
        validate_battle_map(&over),
        Err(MapError::MaxOpposingDistance { max: 11, got: 12 })
    );
}

#[test]
fn bt1_8_min_distance_is_checked_before_max() {
    // Both violated: A(0,0)-B(2,0) = 2 < 5 AND A(0,0)-B(7,7) = 14 > 11 => the MIN rule is named.
    let d = map(8, 8, [(0, 0), (0, 1), (0, 2)], [(2, 0), (7, 7), (7, 6)]);
    assert_eq!(validate_battle_map(&d), Err(min_err(5, 2)));
}

// ===========================================================================
// BT1.8 — bounds, counts, spawn rules
// ===========================================================================

#[test]
fn bt1_8_width_outside_six_to_eight_is_rejected_with_the_value() {
    for w in [0u8, 1, 5, 9, 10, 255] {
        let d = BattleMapDef {
            width: w,
            ..column_map(7, 7, 4)
        };
        assert_eq!(
            validate_battle_map(&d),
            Err(MapError::Width(w)),
            "width {w}"
        );
    }
}

#[test]
fn bt1_8_height_outside_six_to_eight_is_rejected_with_the_value() {
    for h in [0u8, 1, 5, 9, 10, 255] {
        let d = BattleMapDef {
            height: h,
            ..column_map(7, 7, 4)
        };
        assert_eq!(
            validate_battle_map(&d),
            Err(MapError::Height(h)),
            "height {h}"
        );
    }
}

#[test]
fn bt1_8_every_width_and_height_in_range_is_accepted() {
    for w in 6..=8u8 {
        for h in 6..=8u8 {
            let k = u8::try_from(min_for(w, h)).expect("k");
            assert_eq!(validate_battle_map(&column_map(w, h, k)), Ok(()), "{w}x{h}");
        }
    }
}

#[test]
fn bt1_8_width_is_checked_before_height_and_both_before_tile_count() {
    let both = BattleMapDef {
        width: 9,
        height: 5,
        ..column_map(7, 7, 4)
    };
    assert_eq!(validate_battle_map(&both), Err(MapError::Width(9)));
    let height_only = BattleMapDef {
        height: 5,
        ..column_map(7, 7, 4)
    };
    assert_eq!(validate_battle_map(&height_only), Err(MapError::Height(5)));
}

#[test]
fn bt1_8_tile_count_must_equal_width_times_height() {
    let mut short = column_map(7, 7, 4);
    short.tiles.pop();
    assert_eq!(
        validate_battle_map(&short),
        Err(MapError::TileCount {
            expected: 49,
            got: 48
        })
    );
    let mut long = column_map(7, 7, 4);
    long.tiles.push(tile(Terrain::Plain));
    assert_eq!(
        validate_battle_map(&long),
        Err(MapError::TileCount {
            expected: 49,
            got: 50
        })
    );
    let mut empty = column_map(6, 8, 5);
    empty.tiles.clear();
    assert_eq!(
        validate_battle_map(&empty),
        Err(MapError::TileCount {
            expected: 48,
            got: 0
        })
    );
    // TileCount beats SpawnCount.
    let mut both = column_map(7, 7, 4);
    both.tiles.pop();
    both.spawn_a.pop();
    assert_eq!(
        validate_battle_map(&both),
        Err(MapError::TileCount {
            expected: 49,
            got: 48
        })
    );
}

#[test]
fn bt1_8_each_side_needs_exactly_three_spawn_slots() {
    let mut two_a = column_map(7, 7, 4);
    two_a.spawn_a.pop();
    assert_eq!(
        validate_battle_map(&two_a),
        Err(MapError::SpawnCount {
            side: Side::A,
            got: 2
        })
    );
    let mut four_a = column_map(7, 7, 4);
    four_a.spawn_a.push(c(0, 3));
    assert_eq!(
        validate_battle_map(&four_a),
        Err(MapError::SpawnCount {
            side: Side::A,
            got: 4
        })
    );
    let mut none_b = column_map(7, 7, 4);
    none_b.spawn_b.clear();
    assert_eq!(
        validate_battle_map(&none_b),
        Err(MapError::SpawnCount {
            side: Side::B,
            got: 0
        })
    );
    // Side A is reported first when both are wrong.
    let mut both = column_map(7, 7, 4);
    both.spawn_a.pop();
    both.spawn_b.pop();
    assert_eq!(
        validate_battle_map(&both),
        Err(MapError::SpawnCount {
            side: Side::A,
            got: 2
        })
    );
}

#[test]
fn bt1_8_spawn_must_be_inside_the_board_both_sides_of_each_edge() {
    let mut x_out = column_map(7, 7, 4);
    x_out.spawn_a[1] = c(7, 0);
    assert_eq!(
        validate_battle_map(&x_out),
        Err(MapError::SpawnOutOfBounds(c(7, 0)))
    );
    let mut y_out = column_map(7, 7, 4);
    y_out.spawn_b[2] = c(4, 7);
    assert_eq!(
        validate_battle_map(&y_out),
        Err(MapError::SpawnOutOfBounds(c(4, 7)))
    );
    // The last row / column are legal.
    let mut x_edge = column_map(7, 7, 4);
    x_edge.spawn_b[2] = c(6, 3);
    assert_eq!(validate_battle_map(&x_edge), Ok(()));
    let mut y_edge = column_map(7, 7, 4);
    y_edge.spawn_b[2] = c(4, 6);
    assert_eq!(validate_battle_map(&y_edge), Ok(()));
    // Non-square: x is bounded by width, y by height.
    let mut wide = column_map(8, 6, 5);
    wide.spawn_b[2] = c(5, 6);
    assert_eq!(
        validate_battle_map(&wide),
        Err(MapError::SpawnOutOfBounds(c(5, 6)))
    );
    let mut tall = column_map(6, 8, 5);
    tall.spawn_b[2] = c(6, 2);
    assert_eq!(
        validate_battle_map(&tall),
        Err(MapError::SpawnOutOfBounds(c(6, 2)))
    );
    // Side A is scanned before side B.
    let mut both = column_map(7, 7, 4);
    both.spawn_a[0] = c(9, 9);
    both.spawn_b[0] = c(9, 8);
    assert_eq!(
        validate_battle_map(&both),
        Err(MapError::SpawnOutOfBounds(c(9, 9)))
    );
}

#[test]
fn bt1_8_out_of_bounds_beats_overlap() {
    let mut d = column_map(7, 7, 4);
    d.spawn_a = vec![c(9, 9), c(1, 1), c(1, 1)];
    assert_eq!(
        validate_battle_map(&d),
        Err(MapError::SpawnOutOfBounds(c(9, 9)))
    );
}

#[test]
fn bt1_8_spawn_slots_may_not_share_a_tile() {
    let mut within = column_map(7, 7, 4);
    within.spawn_a[2] = within.spawn_a[0];
    assert_eq!(
        validate_battle_map(&within),
        Err(MapError::SpawnOverlap(c(0, 0)))
    );
    let mut across = column_map(7, 7, 4);
    across.spawn_b[1] = across.spawn_a[1];
    assert_eq!(
        validate_battle_map(&across),
        Err(MapError::SpawnOverlap(c(0, 1)))
    );
}

#[test]
fn bt1_8_every_spawn_tile_must_be_walk_passable() {
    let mut water = column_map(7, 7, 4);
    set(&mut water, 4, 1, Terrain::Water);
    assert_eq!(
        validate_battle_map(&water),
        Err(MapError::SpawnNotWalkable(c(4, 1)))
    );
    let mut blocked = column_map(7, 7, 4);
    set(&mut blocked, 0, 2, Terrain::Blocked);
    assert_eq!(
        validate_battle_map(&blocked),
        Err(MapError::SpawnNotWalkable(c(0, 2)))
    );
    // Rough is Walk-passable (weight 2): a spawn on it is legal.
    let mut rough = column_map(7, 7, 4);
    set(&mut rough, 4, 1, Terrain::Rough);
    set(&mut rough, 0, 0, Terrain::Rough);
    assert_eq!(validate_battle_map(&rough), Ok(()));
}

#[test]
fn bt1_8_overlap_is_checked_before_walkability_and_walkability_before_distance() {
    let mut overlap_on_water = column_map(7, 7, 4);
    overlap_on_water.spawn_a[2] = overlap_on_water.spawn_a[0];
    set(&mut overlap_on_water, 0, 0, Terrain::Water);
    assert_eq!(
        validate_battle_map(&overlap_on_water),
        Err(MapError::SpawnOverlap(c(0, 0)))
    );
    // k = 3 violates the 7x7 minimum, but the water spawn is named first.
    let mut close_on_water = column_map(7, 7, 3);
    set(&mut close_on_water, 0, 0, Terrain::Water);
    assert_eq!(
        validate_battle_map(&close_on_water),
        Err(MapError::SpawnNotWalkable(c(0, 0)))
    );
}

// ===========================================================================
// BT1.8 — a Walk path connects the sides
// ===========================================================================

#[test]
fn bt1_8_a_full_wall_or_lake_between_the_sides_is_disconnected() {
    for wall in [Terrain::Blocked, Terrain::Water] {
        let mut d = column_map(7, 7, 4);
        for y in 0..7 {
            set(&mut d, 2, y, wall);
        }
        assert_eq!(
            validate_battle_map(&d),
            Err(MapError::Disconnected),
            "{wall:?} column"
        );
    }
}

#[test]
fn bt1_8_a_rough_band_or_a_gap_in_the_wall_stays_connected() {
    let mut rough_band = column_map(7, 7, 4);
    for y in 0..7 {
        set(&mut rough_band, 2, y, Terrain::Rough);
    }
    assert_eq!(
        validate_battle_map(&rough_band),
        Ok(()),
        "Rough is Walk-passable"
    );
    let mut gap = column_map(7, 7, 4);
    for y in 0..7 {
        set(&mut gap, 2, y, Terrain::Blocked);
    }
    set(&mut gap, 2, 3, Terrain::Plain);
    assert_eq!(
        validate_battle_map(&gap),
        Ok(()),
        "one open tile connects the halves"
    );
}

#[test]
fn bt1_8_every_spawn_must_share_one_walk_component() {
    // B's third slot (4,6) is walled in by Blocked tiles; the other five spawns connect.
    // Distances stay legal (min 4, max 10), so only connectivity can reject it.
    let walled_in = |enclose: bool| {
        let mut d = map(7, 7, [(0, 0), (0, 1), (0, 2)], [(4, 0), (4, 1), (4, 6)]);
        if enclose {
            set(&mut d, 3, 6, Terrain::Blocked);
            set(&mut d, 5, 6, Terrain::Blocked);
            set(&mut d, 4, 5, Terrain::Blocked);
        }
        d
    };
    assert_eq!(
        validate_battle_map(&walled_in(false)),
        Ok(()),
        "control: no enclosure"
    );
    assert_eq!(
        validate_battle_map(&walled_in(true)),
        Err(MapError::Disconnected)
    );
}

// ===========================================================================
// BT1.8 — tile schema: elevation / blocks_los are defaulted and unread
// ===========================================================================

#[test]
fn bt1_8_elevation_and_blocks_los_are_accepted_and_do_not_affect_validity() {
    let mut d = column_map(7, 7, 4);
    for t in &mut d.tiles {
        t.elevation = 255;
        t.blocks_los = true;
    }
    assert_eq!(validate_battle_map(&d), Ok(()), "P1 never reads them");
    assert_eq!(parse_battle_map(&to_ron(&d, true)), Ok(d));
}

#[test]
fn bt1_8_parse_defaults_elevation_to_zero_and_blocks_los_to_false() {
    let d = column_map(7, 7, 4);
    let parsed = parse_battle_map(&to_ron(&d, false)).expect("compact RON parses");
    assert_eq!(parsed, d);
    assert!(parsed
        .tiles
        .iter()
        .all(|t| t.elevation == 0 && !t.blocks_los));
    // A partially specified tile fills only the missing field.
    let src = to_ron(&d, false).replacen("(terrain: Plain)", "(terrain: Rough, elevation: 3)", 1);
    let partial = parse_battle_map(&src).expect("partial tile parses");
    assert_eq!(
        partial.tiles[0],
        TileDef {
            terrain: Terrain::Rough,
            elevation: 3,
            blocks_los: false
        }
    );
    // Tile (0,0) is a spawn, so it must stay Walk-passable (Plain) for the validator to accept.
    let src =
        to_ron(&d, false).replacen("(terrain: Plain)", "(terrain: Plain, blocks_los: true)", 1);
    let partial = parse_battle_map(&src).expect("partial tile parses");
    assert_eq!(
        partial.tiles[0],
        TileDef {
            terrain: Terrain::Plain,
            elevation: 0,
            blocks_los: true
        }
    );
}

// ===========================================================================
// BT1.8 — parsing
// ===========================================================================

#[test]
fn bt1_8_parse_accepts_a_valid_ron_map_and_keeps_every_field_in_order() {
    let mut d = column_map(8, 8, 5);
    set(&mut d, 3, 3, Terrain::Rough);
    set(&mut d, 4, 3, Terrain::Water);
    set(&mut d, 3, 4, Terrain::Blocked);
    let parsed = parse_battle_map(&to_ron(&d, true)).expect("valid RON parses");
    assert_eq!(parsed, d);
    assert_eq!(
        parsed.spawn_a,
        spawns([(0, 0), (0, 1), (0, 2)]),
        "slot order is kept"
    );
    assert_eq!(parsed.spawn_b, spawns([(5, 0), (5, 1), (5, 2)]));
    assert_eq!(
        parsed.tiles[3 * 8 + 3].terrain,
        Terrain::Rough,
        "row-major y*width+x"
    );
    assert_eq!(parsed.tiles[3 * 8 + 4].terrain, Terrain::Water);
    assert_eq!(parsed.tiles[4 * 8 + 3].terrain, Terrain::Blocked);
}

#[test]
fn bt1_8_parse_runs_the_validator_after_deserializing() {
    // Syntactically perfect RON, semantically invalid: the validator's typed error surfaces.
    let too_wide = BattleMapDef {
        width: 5,
        height: 5,
        tiles: vec![tile(Terrain::Plain); 25],
        spawn_a: spawns([(0, 0), (0, 1), (0, 2)]),
        spawn_b: spawns([(4, 0), (4, 1), (4, 2)]),
    };
    assert_eq!(
        parse_battle_map(&to_ron(&too_wide, false)),
        Err(MapError::Width(5))
    );
    let mut walled = column_map(7, 7, 4);
    for y in 0..7 {
        set(&mut walled, 2, y, Terrain::Water);
    }
    assert_eq!(
        parse_battle_map(&to_ron(&walled, false)),
        Err(MapError::Disconnected)
    );
}

#[test]
fn bt1_8_parse_rejects_unknown_fields_everywhere() {
    let base = to_ron(&column_map(7, 7, 4), false);
    let bad_tile = base.replacen("(terrain: Plain)", "(terrain: Plain, foo: 1)", 1);
    assert!(matches!(parse_battle_map(&bad_tile), Err(MapError::Parse(m)) if !m.is_empty()));
    let bad_top = base.replacen("(width: 7", "(zone: 3, width: 7", 1);
    assert!(matches!(parse_battle_map(&bad_top), Err(MapError::Parse(m)) if !m.is_empty()));
    // A misspelled defaulted key is an unknown field, not silently ignored.
    let bad_elevation_key = base.replacen("(terrain: Plain)", "(terrain: Plain, elevaton: 1)", 1);
    assert!(matches!(
        parse_battle_map(&bad_elevation_key),
        Err(MapError::Parse(_))
    ));
}

#[test]
fn bt1_8_parse_rejects_wrong_shapes_with_a_parse_error() {
    let base = to_ron(&column_map(7, 7, 4), false);
    let cases = [
        base.replacen("Plain", "Lava", 1),
        base.replacen("(terrain: Plain)", "()", 1),
        base.replacen("height: 7, ", "", 1),
        base.replacen("width: 7", "width: 300", 1),
        base.replacen("width: 7", "width: -1", 1),
        base.replacen("spawn_a: [", "spawn_a: [(x: 300, y: 0), ", 1),
        String::from("("),
        String::new(),
        String::from("not ron at all"),
    ];
    for (i, src) in cases.iter().enumerate() {
        assert!(
            matches!(parse_battle_map(src), Err(MapError::Parse(m)) if !m.is_empty()),
            "case {i} should be a Parse error: {:?}",
            parse_battle_map(src)
        );
    }
}

// ===========================================================================
// BT1.8 — never clamp; every rule has a typed error
// ===========================================================================

#[test]
fn bt1_8_invalid_maps_are_rejected_with_their_original_values_never_clamped() {
    // A clamping validator would turn each of these into Ok or into a "corrected" value.
    assert_eq!(
        validate_battle_map(&BattleMapDef {
            width: 9,
            ..column_map(7, 7, 4)
        }),
        Err(MapError::Width(9)),
        "9 is not clamped to 8"
    );
    assert_eq!(
        validate_battle_map(&BattleMapDef {
            height: 5,
            ..column_map(7, 7, 4)
        }),
        Err(MapError::Height(5)),
        "5 is not clamped to 6"
    );
    assert_eq!(
        validate_battle_map(&column_map(7, 7, 3)),
        Err(min_err(4, 3)),
        "the spawns are not pushed apart"
    );
    let mut off = column_map(7, 7, 4);
    off.spawn_a[0] = c(200, 200);
    assert_eq!(
        validate_battle_map(&off),
        Err(MapError::SpawnOutOfBounds(c(200, 200))),
        "an off-board spawn is not pulled in"
    );
}

/// Exhaustive on purpose: adding a `MapError` variant breaks this match until a test reaches it.
fn variant_name(e: &MapError) -> &'static str {
    match e {
        MapError::Parse(_) => "Parse",
        MapError::Width(_) => "Width",
        MapError::Height(_) => "Height",
        MapError::TileCount { .. } => "TileCount",
        MapError::SpawnCount { .. } => "SpawnCount",
        MapError::SpawnOutOfBounds(_) => "SpawnOutOfBounds",
        MapError::SpawnOverlap(_) => "SpawnOverlap",
        MapError::SpawnNotWalkable(_) => "SpawnNotWalkable",
        MapError::MinOpposingDistance { .. } => "MinOpposingDistance",
        MapError::MaxOpposingDistance { .. } => "MaxOpposingDistance",
        MapError::Disconnected => "Disconnected",
    }
}

#[test]
fn bt1_8_every_map_error_variant_is_reached_by_some_input() {
    let mut wall = column_map(7, 7, 4);
    for y in 0..7 {
        set(&mut wall, 2, y, Terrain::Blocked);
    }
    let mut short_tiles = column_map(7, 7, 4);
    short_tiles.tiles.pop();
    let mut one_spawn = column_map(7, 7, 4);
    one_spawn.spawn_b.pop();
    let mut off_board = column_map(7, 7, 4);
    off_board.spawn_a[1] = c(7, 7);
    let mut overlap = column_map(7, 7, 4);
    overlap.spawn_a[2] = overlap.spawn_a[0];
    let mut water_spawn = column_map(7, 7, 4);
    set(&mut water_spawn, 4, 0, Terrain::Water);
    let errors = [
        parse_battle_map("(").expect_err("malformed RON"),
        validate_battle_map(&BattleMapDef {
            width: 9,
            ..column_map(7, 7, 4)
        })
        .expect_err("width"),
        validate_battle_map(&BattleMapDef {
            height: 9,
            ..column_map(7, 7, 4)
        })
        .expect_err("height"),
        validate_battle_map(&short_tiles).expect_err("tile count"),
        validate_battle_map(&one_spawn).expect_err("spawn count"),
        validate_battle_map(&off_board).expect_err("spawn out of bounds"),
        validate_battle_map(&overlap).expect_err("spawn overlap"),
        validate_battle_map(&water_spawn).expect_err("spawn not walkable"),
        validate_battle_map(&column_map(7, 7, 3)).expect_err("min distance"),
        validate_battle_map(&map(
            7,
            7,
            [(0, 0), (0, 1), (0, 2)],
            [(6, 2), (6, 3), (6, 6)],
        ))
        .expect_err("max distance"),
        validate_battle_map(&wall).expect_err("disconnected"),
    ];
    let mut names: Vec<&str> = errors.iter().map(variant_name).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "Disconnected",
            "Height",
            "MaxOpposingDistance",
            "MinOpposingDistance",
            "Parse",
            "SpawnCount",
            "SpawnNotWalkable",
            "SpawnOutOfBounds",
            "SpawnOverlap",
            "TileCount",
            "Width",
        ]
    );
}
