//! bt-1 gating tests — BT1.5 .. BT1.7 (`tactics::movement`).
//!
//! BT1.5 stride bands + the class x terrain weight table + the live roster split ·
//! BT1.6 Dijkstra with the explicit `(weight, y, x)` tie-break, ally pass-through,
//! enemy walls, the independent-reference property test and the no-HashMap/no-float
//! source scan · BT1.7 the disengage predicate.
//!
//! # How the path expectations were derived
//!
//! Every expected path is hand-derived from the closed-form `pred` rule (plan A4):
//! `dist` is the cheapest cost from `start` (each ENTERED tile costs its class x
//! terrain weight; enemies are walls; allies are passable), and
//! `pred(v)` = the neighbour `u` minimising `(dist[u], u.y, u.x)` among those with
//! `dist[u] + w(v) == dist[v]`. The path is read backwards from `dest`. Because every
//! candidate shares one `dist`, the tie-break is effectively "lowest y, then lowest x".
//!
//! Names start `bt1_<k>_` — the acceptance ledger's CHECKs filter on that prefix.

use proptest::prelude::*;

use super::geometry::{Board, BoardUnit, Cell, Side};
use super::movement::{
    disengage_taxed, find_path, stride_for_base_speed, terrain_weight, MoveClass, Path, PathError,
    Terrain,
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

fn c(x: u8, y: u8) -> Cell {
    Cell { x, y }
}

/// Rows of `.` Plain, `r` Rough, `w` Water, `#` Blocked; `rows[y][x]`.
fn board(rows: &[&str], units: Vec<BoardUnit>) -> Board {
    let height = rows.len();
    let width = rows[0].len();
    let mut terrain = Vec::with_capacity(width * height);
    for row in rows {
        assert_eq!(row.len(), width, "ragged fixture row");
        for ch in row.chars() {
            terrain.push(match ch {
                '.' => Terrain::Plain,
                'r' => Terrain::Rough,
                'w' => Terrain::Water,
                '#' => Terrain::Blocked,
                other => panic!("bad fixture glyph {other}"),
            });
        }
    }
    let n = terrain.len();
    Board {
        width: u8::try_from(width).expect("fixture width fits u8"),
        height: u8::try_from(height).expect("fixture height fits u8"),
        terrain,
        blocks_los: vec![false; n],
        units,
    }
}

fn who(id: u32, side: Side, class: MoveClass, x: u8, y: u8) -> BoardUnit {
    BoardUnit {
        id,
        side,
        pos: c(x, y),
        alive: true,
        class,
    }
}

/// The mover under test: id 1, side A.
fn me(class: MoveClass, x: u8, y: u8) -> BoardUnit {
    who(1, Side::A, class, x, y)
}

fn ally(id: u32, x: u8, y: u8) -> BoardUnit {
    who(id, Side::A, MoveClass::Walk, x, y)
}

fn foe(id: u32, x: u8, y: u8) -> BoardUnit {
    who(id, Side::B, MoveClass::Walk, x, y)
}

fn dead(mut unit: BoardUnit) -> BoardUnit {
    unit.alive = false;
    unit
}

fn cells(v: &[(u8, u8)]) -> Vec<Cell> {
    v.iter().map(|&(x, y)| c(x, y)).collect()
}

fn ok(v: &[(u8, u8)], cost: u16) -> Result<Path, PathError> {
    Ok(Path {
        steps: cells(v),
        cost,
    })
}

fn go(b: &Board, mover: u32, from: (u8, u8), to: (u8, u8)) -> Result<Path, PathError> {
    find_path(b, mover, c(from.0, from.1), c(to.0, to.1))
}

const PLAIN_3X3: [&str; 3] = ["...", "...", "..."];

// ===========================================================================
// BT1.5 — stride bands, weight table, live roster
// ===========================================================================

#[test]
fn bt1_5_stride_band_boundaries() {
    for (speed, want) in [
        (0u16, 2u8),
        (1, 2),
        (48, 2),
        (49, 2),
        (50, 3),
        (51, 3),
        (88, 3),
        (89, 3),
        (90, 4),
        (91, 4),
        (200, 4),
        (65_535, 4),
    ] {
        assert_eq!(stride_for_base_speed(speed), want, "base speed {speed}");
    }
}

#[test]
fn bt1_5_stride_matches_the_band_formula_for_every_u16() {
    for speed in 0..=u16::MAX {
        let want = if speed <= 49 {
            2
        } else if speed <= 89 {
            3
        } else {
            4
        };
        assert_eq!(stride_for_base_speed(speed), want, "base speed {speed}");
    }
}

#[test]
fn bt1_5_terrain_weight_is_the_design_table_for_every_class_and_terrain() {
    use MoveClass::{Fly, Nimble, Swim, Walk};
    use Terrain::{Blocked, Plain, Rough, Water};
    // (class, terrain, weight): None = impassable. Design §2.1 table.
    let table: [(MoveClass, Terrain, Option<u8>); 16] = [
        (Walk, Plain, Some(1)),
        (Walk, Rough, Some(2)),
        (Walk, Water, None),
        (Walk, Blocked, None),
        (Nimble, Plain, Some(1)),
        (Nimble, Rough, Some(1)),
        (Nimble, Water, None),
        (Nimble, Blocked, None),
        (Swim, Plain, Some(1)),
        (Swim, Rough, Some(2)),
        (Swim, Water, Some(1)),
        (Swim, Blocked, None),
        (Fly, Plain, Some(1)),
        (Fly, Rough, Some(1)),
        (Fly, Water, Some(1)),
        (Fly, Blocked, None),
    ];
    for (class, terrain, want) in table {
        assert_eq!(
            terrain_weight(class, terrain),
            want,
            "{class:?} on {terrain:?}"
        );
    }
}

#[test]
fn bt1_5_blocked_is_impassable_for_every_class() {
    for class in [
        MoveClass::Walk,
        MoveClass::Nimble,
        MoveClass::Swim,
        MoveClass::Fly,
    ] {
        assert_eq!(terrain_weight(class, Terrain::Blocked), None, "{class:?}");
    }
}

#[test]
fn bt1_5_live_roster_splits_six_nine_five_by_base_speed() {
    let species = crate::load_species().expect("embedded species registry loads");
    assert_eq!(
        species.len(),
        20,
        "the live roster size the 6/9/5 split is stated for"
    );
    // Independent banding straight from the spec thresholds (never the levelled stat).
    let mut by_band = [0usize; 3];
    for s in &species {
        let speed = s.base_stats.speed;
        if speed <= 49 {
            by_band[0] += 1;
        } else if speed <= 89 {
            by_band[1] += 1;
        } else {
            by_band[2] += 1;
        }
    }
    assert_eq!(
        by_band,
        [6, 9, 5],
        "spec ruling: strides 2 / 3 / 4 split the roster 6 / 9 / 5"
    );
    // The function under test must reproduce it, one species at a time.
    let mut by_stride = [0usize; 3];
    for s in &species {
        match stride_for_base_speed(s.base_stats.speed) {
            2 => by_stride[0] += 1,
            3 => by_stride[1] += 1,
            4 => by_stride[2] += 1,
            other => panic!("stride {other} outside 2..=4 for species {}", s.id),
        }
    }
    assert_eq!(by_stride, [6, 9, 5]);
}

// ===========================================================================
// BT1.6 — Dijkstra, tie-break, occupancy
// ===========================================================================

#[test]
fn bt1_6_equal_weight_fork_takes_lowest_y_then_x() {
    // (0,0) -> (1,1): via (1,0) [y0] or via (0,1) [y1]; the lower-y predecessor wins.
    let b = board(&PLAIN_3X3, vec![me(MoveClass::Walk, 0, 0)]);
    assert_eq!(go(&b, 1, (0, 0), (1, 1)), ok(&[(1, 0), (1, 1)], 2));
}

#[test]
fn bt1_6_fork_on_a_wide_board_hugs_the_top_row_then_descends() {
    // 5x3, (0,0)->(4,2): every shortest path costs 6. pred chain from (4,2):
    // (4,1) [y1<2] <- (4,0) [y0<1] <- (3,0) <- (2,0) <- (1,0) <- start.
    let b = board(
        &[".....", ".....", "....."],
        vec![me(MoveClass::Walk, 0, 0)],
    );
    assert_eq!(
        go(&b, 1, (0, 0), (4, 2)),
        ok(&[(1, 0), (2, 0), (3, 0), (4, 0), (4, 1), (4, 2)], 6)
    );
}

#[test]
fn bt1_6_fork_on_a_tall_board_orders_by_y_not_x() {
    // 3x5, (0,0)->(2,4). At (2,4) the candidates are (1,4) [x1,y4] and (2,3) [x2,y3]:
    // (y,x) picks (2,3); an (x,y) tie-break would pick (1,4) and walk a different path.
    let b = board(
        &["...", "...", "...", "...", "..."],
        vec![me(MoveClass::Walk, 0, 0)],
    );
    assert_eq!(
        go(&b, 1, (0, 0), (2, 4)),
        ok(&[(1, 0), (2, 0), (2, 1), (2, 2), (2, 3), (2, 4)], 6)
    );
}

#[test]
fn bt1_6_open_8x8_corner_to_corner_walks_the_top_row_then_the_right_column() {
    let rows = ["........"; 8];
    let b = board(&rows, vec![me(MoveClass::Walk, 0, 0)]);
    let mut want: Vec<(u8, u8)> = (1..=7).map(|x| (x, 0)).collect();
    want.extend((1..=7).map(|y| (7, y)));
    assert_eq!(go(&b, 1, (0, 0), (7, 7)), ok(&want, 14));
}

#[test]
fn bt1_6_pred_rule_differs_from_forward_lexicographic() {
    // 3x4, Walk mover at (1,0), dest (1,3). The rough column (1,1),(1,2) costs 2 each, so the
    // direct route costs 2+2+1 = 5 and ties with both plain detours (0,*) and (2,*).
    //   FORWARD-lexicographic (smallest first step) would take the left detour (0,0)...(0,3).
    //   The contract is the BACKWARD pred rule: at (1,3) the lowest-y predecessor is (1,2).
    let b = board(
        &["...", ".r.", ".r.", "..."],
        vec![me(MoveClass::Walk, 1, 0)],
    );
    assert_eq!(go(&b, 1, (1, 0), (1, 3)), ok(&[(1, 1), (1, 2), (1, 3)], 5));
}

#[test]
fn bt1_6_left_right_tie_breaks_by_lowest_x_when_y_is_equal() {
    // Ring around a blocked centre: (1,0) -> (1,2) via the left or right column, cost 4 each.
    // pred((1,2)) candidates (0,2) and (2,2) share y; the lower x wins.
    let b = board(&["...", ".#.", "..."], vec![me(MoveClass::Walk, 1, 0)]);
    assert_eq!(
        go(&b, 1, (1, 0), (1, 2)),
        ok(&[(0, 0), (0, 1), (0, 2), (1, 2)], 4)
    );
}

#[test]
fn bt1_6_rough_detour_depends_on_the_movement_class() {
    // Row 1 is a rough strip: Walk/Swim pay 2 per rough tile, Nimble/Fly pay 1.
    let rows = ["......", ".rrrr.", "......"];
    let detour = [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (5, 1)];
    let straight = [(1, 1), (2, 1), (3, 1), (4, 1), (5, 1)];
    // Walk direct = 2*4+1 = 9 > detour 7 (tie (5,0)/(5,2) -> y0).
    let walk = board(&rows, vec![me(MoveClass::Walk, 0, 1)]);
    assert_eq!(go(&walk, 1, (0, 1), (5, 1)), ok(&detour, 7));
    let swim = board(&rows, vec![me(MoveClass::Swim, 0, 1)]);
    assert_eq!(
        go(&swim, 1, (0, 1), (5, 1)),
        ok(&detour, 7),
        "Swim rough = 2, like Walk"
    );
    // Nimble/Fly direct = 5.
    let nimble = board(&rows, vec![me(MoveClass::Nimble, 0, 1)]);
    assert_eq!(go(&nimble, 1, (0, 1), (5, 1)), ok(&straight, 5));
    let fly = board(&rows, vec![me(MoveClass::Fly, 0, 1)]);
    assert_eq!(go(&fly, 1, (0, 1), (5, 1)), ok(&straight, 5));
}

#[test]
fn bt1_6_rough_destination_costs_its_weight() {
    let rows = ["..r"];
    let walk = board(&rows, vec![me(MoveClass::Walk, 0, 0)]);
    assert_eq!(go(&walk, 1, (0, 0), (2, 0)), ok(&[(1, 0), (2, 0)], 3));
    let nimble = board(&rows, vec![me(MoveClass::Nimble, 0, 0)]);
    assert_eq!(go(&nimble, 1, (0, 0), (2, 0)), ok(&[(1, 0), (2, 0)], 2));
}

#[test]
fn bt1_6_water_is_crossed_by_swim_and_fly_and_detoured_by_walk_and_nimble() {
    let rows = [".....", ".www.", "....."];
    let straight = [(1, 1), (2, 1), (3, 1), (4, 1)];
    let around = [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0), (4, 1)];
    for (class, want) in [
        (MoveClass::Swim, ok(&straight, 4)),
        (MoveClass::Fly, ok(&straight, 4)),
        (MoveClass::Walk, ok(&around, 6)),
        (MoveClass::Nimble, ok(&around, 6)),
    ] {
        let b = board(&rows, vec![me(class, 0, 1)]);
        assert_eq!(go(&b, 1, (0, 1), (4, 1)), want, "{class:?}");
    }
}

#[test]
fn bt1_6_a_sealed_lake_is_unreachable_for_walk_and_nimble_only() {
    let lake = [".w.", ".w.", ".w."];
    for class in [MoveClass::Walk, MoveClass::Nimble] {
        let b = board(&lake, vec![me(class, 0, 0)]);
        assert_eq!(
            go(&b, 1, (0, 0), (2, 0)),
            Err(PathError::Unreachable),
            "{class:?}"
        );
    }
    let swim = board(&lake, vec![me(MoveClass::Swim, 0, 0)]);
    assert_eq!(go(&swim, 1, (0, 0), (2, 0)), ok(&[(1, 0), (2, 0)], 2));
    let fly = board(&lake, vec![me(MoveClass::Fly, 0, 0)]);
    assert_eq!(go(&fly, 1, (0, 0), (2, 0)), ok(&[(1, 0), (2, 0)], 2));
}

#[test]
fn bt1_6_blocked_tiles_stop_even_fly() {
    let wall = [".#.", ".#.", ".#."];
    let b = board(&wall, vec![me(MoveClass::Fly, 0, 0)]);
    assert_eq!(go(&b, 1, (0, 0), (2, 0)), Err(PathError::Unreachable));
    assert_eq!(go(&b, 1, (0, 0), (1, 1)), Err(PathError::DestImpassable));
    // Walk onto a water destination is impassable too.
    let lake = board(&[".w.", ".w.", ".w."], vec![me(MoveClass::Walk, 0, 0)]);
    assert_eq!(go(&lake, 1, (0, 0), (1, 1)), Err(PathError::DestImpassable));
}

#[test]
fn bt1_6_allies_are_passed_through_but_never_ended_on() {
    let corridor = ["#####", ".....", "#####"];
    let b = board(&corridor, vec![me(MoveClass::Walk, 0, 1), ally(2, 2, 1)]);
    // Straight through the ally in the corridor: it is passable.
    assert_eq!(
        go(&b, 1, (0, 1), (4, 1)),
        ok(&[(1, 1), (2, 1), (3, 1), (4, 1)], 4)
    );
    // ...but the ally's own tile is not a legal destination.
    assert_eq!(go(&b, 1, (0, 1), (2, 1)), Err(PathError::DestOccupied));
}

#[test]
fn bt1_6_enemies_are_walls_that_seal_a_corridor() {
    let corridor = ["#####", ".....", "#####"];
    let b = board(&corridor, vec![me(MoveClass::Walk, 0, 1), foe(2, 2, 1)]);
    assert_eq!(go(&b, 1, (0, 1), (4, 1)), Err(PathError::Unreachable));
    assert_eq!(go(&b, 1, (0, 1), (2, 1)), Err(PathError::DestOccupied));
}

#[test]
fn bt1_6_enemies_force_a_detour_in_the_open() {
    let b = board(
        &["...", "..."],
        vec![me(MoveClass::Walk, 0, 0), foe(2, 1, 0)],
    );
    assert_eq!(
        go(&b, 1, (0, 0), (2, 0)),
        ok(&[(0, 1), (1, 1), (2, 1), (2, 0)], 4)
    );
    // A dead enemy is not a wall.
    let corpse = board(
        &["...", "..."],
        vec![me(MoveClass::Walk, 0, 0), dead(foe(2, 1, 0))],
    );
    assert_eq!(go(&corpse, 1, (0, 0), (2, 0)), ok(&[(1, 0), (2, 0)], 2));
}

#[test]
fn bt1_6_a_lone_enemy_in_a_wide_field_is_stepped_around_not_through() {
    // 5x3, enemy at (2,0): shortest cost to (4,0) is 6 via the row below.
    let b = board(
        &[".....", ".....", "....."],
        vec![me(MoveClass::Walk, 0, 0), foe(2, 2, 0)],
    );
    assert_eq!(
        go(&b, 1, (0, 0), (4, 0)),
        ok(&[(1, 0), (1, 1), (2, 1), (3, 1), (3, 0), (4, 0)], 6)
    );
}

#[test]
fn bt1_6_dead_units_neither_block_nor_occupy() {
    let b = board(
        &["...", "..."],
        vec![me(MoveClass::Walk, 0, 0), dead(ally(2, 2, 0))],
    );
    assert_eq!(go(&b, 1, (0, 0), (2, 0)), ok(&[(1, 0), (2, 0)], 2));
}

#[test]
fn bt1_6_an_ally_standing_on_water_does_not_open_it_for_walk() {
    let lake = [".w.", ".w.", ".w."];
    let swim_ally = who(2, Side::A, MoveClass::Swim, 1, 1);
    let b = board(&lake, vec![me(MoveClass::Walk, 0, 0), swim_ally]);
    assert_eq!(go(&b, 1, (0, 0), (2, 0)), Err(PathError::Unreachable));
}

#[test]
fn bt1_6_path_errors_unknown_or_dead_mover() {
    let b = board(&PLAIN_3X3, vec![me(MoveClass::Walk, 0, 0)]);
    assert_eq!(go(&b, 99, (0, 0), (1, 1)), Err(PathError::UnknownMover(99)));
    let d = board(&PLAIN_3X3, vec![dead(me(MoveClass::Walk, 0, 0))]);
    assert_eq!(go(&d, 1, (0, 0), (1, 1)), Err(PathError::UnknownMover(1)));
}

#[test]
fn bt1_6_path_errors_bounds_and_same_tile() {
    let b = board(&PLAIN_3X3, vec![me(MoveClass::Walk, 0, 0)]);
    assert_eq!(
        go(&b, 1, (0, 0), (3, 0)),
        Err(PathError::OutOfBounds),
        "x == width"
    );
    assert_eq!(
        go(&b, 1, (0, 0), (0, 3)),
        Err(PathError::OutOfBounds),
        "y == height"
    );
    assert_eq!(
        go(&b, 1, (9, 9), (1, 1)),
        Err(PathError::OutOfBounds),
        "start out of bounds"
    );
    assert_eq!(
        go(&b, 1, (0, 0), (2, 2)).map(|p| p.cost),
        Ok(4),
        "last tile is in bounds"
    );
    assert_eq!(go(&b, 1, (0, 0), (0, 0)), Err(PathError::SameTile));
}

#[test]
fn bt1_6_path_error_order_is_pairwise_fixed() {
    let b = board(&PLAIN_3X3, vec![me(MoveClass::Walk, 0, 0)]);
    // UnknownMover beats OutOfBounds.
    assert_eq!(go(&b, 99, (0, 0), (9, 9)), Err(PathError::UnknownMover(99)));
    // OutOfBounds beats SameTile.
    assert_eq!(go(&b, 1, (9, 9), (9, 9)), Err(PathError::OutOfBounds));

    // SameTile beats DestImpassable (the mover stands on water and "moves" to it).
    let on_water = board(&["...", ".w.", "..."], vec![me(MoveClass::Walk, 1, 1)]);
    assert_eq!(go(&on_water, 1, (1, 1), (1, 1)), Err(PathError::SameTile));

    // DestImpassable beats DestOccupied (a Swim ally sits on the water tile).
    let lake = [".w.", ".w.", ".w."];
    let swimmer = who(2, Side::A, MoveClass::Swim, 1, 1);
    let occupied_water = board(&lake, vec![me(MoveClass::Walk, 0, 0), swimmer]);
    assert_eq!(
        go(&occupied_water, 1, (0, 0), (1, 1)),
        Err(PathError::DestImpassable)
    );

    // DestOccupied beats Unreachable (an enemy holds a tile across the lake).
    let far_foe = board(&lake, vec![me(MoveClass::Walk, 0, 0), foe(2, 2, 0)]);
    assert_eq!(
        go(&far_foe, 1, (0, 0), (2, 0)),
        Err(PathError::DestOccupied)
    );
}

#[test]
fn bt1_6_start_is_explicit_and_the_movers_own_unit_never_blocks_itself() {
    // A second Move entry starts where the first ended: the unit still records (0,0).
    let b = board(
        &[".....", ".....", "....."],
        vec![me(MoveClass::Walk, 0, 0)],
    );
    assert_eq!(go(&b, 1, (2, 0), (4, 0)), ok(&[(3, 0), (4, 0)], 2));
    // Walking back onto the tile the unit's record still names is not "occupied".
    assert_eq!(go(&b, 1, (2, 0), (0, 0)), ok(&[(1, 0), (0, 0)], 2));
}

#[test]
fn bt1_6_a_board_with_short_vectors_errors_instead_of_panicking() {
    // Caller bug: terrain shorter than width*height. Out-of-range reads are impassable.
    let b = Board {
        width: 3,
        height: 3,
        terrain: vec![],
        blocks_los: vec![],
        units: vec![me(MoveClass::Walk, 0, 0)],
    };
    assert_eq!(go(&b, 1, (0, 0), (1, 0)), Err(PathError::DestImpassable));
}

#[test]
fn bt1_6_identical_calls_return_identical_paths() {
    let rows = ["......", ".rrrr.", "......"];
    let b = board(
        &rows,
        vec![me(MoveClass::Walk, 0, 1), ally(2, 3, 0), foe(3, 2, 2)],
    );
    let first = go(&b, 1, (0, 1), (5, 1));
    for _ in 0..16 {
        assert_eq!(go(&b, 1, (0, 1), (5, 1)), first);
    }
    assert!(first.is_ok());
}

// ---------------------------------------------------------------------------
// Property: find_path == an independent no-heap relaxation + the pred rule (plan A5)
// ---------------------------------------------------------------------------

fn class_from(n: u8) -> MoveClass {
    match n % 4 {
        0 => MoveClass::Walk,
        1 => MoveClass::Nimble,
        2 => MoveClass::Swim,
        _ => MoveClass::Fly,
    }
}

fn terrain_from(n: u8) -> Terrain {
    match n % 10 {
        0..=4 => Terrain::Plain,
        5 | 6 => Terrain::Rough,
        7 | 8 => Terrain::Water,
        _ => Terrain::Blocked,
    }
}

/// The design §2.1 table, re-stated independently of `terrain_weight`.
fn ref_weight(class: MoveClass, t: Terrain) -> Option<u32> {
    match (class, t) {
        (_, Terrain::Blocked) => None,
        (_, Terrain::Plain) => Some(1),
        (MoveClass::Walk | MoveClass::Swim, Terrain::Rough) => Some(2),
        (MoveClass::Nimble | MoveClass::Fly, Terrain::Rough) => Some(1),
        (MoveClass::Swim | MoveClass::Fly, Terrain::Water) => Some(1),
        (MoveClass::Walk | MoveClass::Nimble, Terrain::Water) => None,
    }
}

fn neighbours(b: &Board, p: Cell) -> Vec<Cell> {
    let mut v = Vec::new();
    if p.y > 0 {
        v.push(c(p.x, p.y - 1));
    }
    if p.x > 0 {
        v.push(c(p.x - 1, p.y));
    }
    if p.x + 1 < b.width {
        v.push(c(p.x + 1, p.y));
    }
    if p.y + 1 < b.height {
        v.push(c(p.x, p.y + 1));
    }
    v
}

/// Bellman-Ford style relaxation to a fixed point (no heap, no ordering subtleties), then
/// the closed-form `pred` rule read backwards from `dest`. Assumes `start` and `dest` are
/// in bounds and the mover exists.
fn reference_path(
    b: &Board,
    mover: &BoardUnit,
    start: Cell,
    dest: Cell,
) -> Result<Path, PathError> {
    let idx = |p: Cell| usize::from(p.y) * usize::from(b.width) + usize::from(p.x);
    let n = usize::from(b.width) * usize::from(b.height);
    let weight: Vec<Option<u32>> = b
        .terrain
        .iter()
        .map(|&t| ref_weight(mover.class, t))
        .collect();
    let mut enemy = vec![false; n];
    for u in &b.units {
        if u.alive && u.id != mover.id && u.side != mover.side {
            enemy[idx(u.pos)] = true;
        }
    }
    if start == dest {
        return Err(PathError::SameTile);
    }
    if weight[idx(dest)].is_none() {
        return Err(PathError::DestImpassable);
    }
    if b.units
        .iter()
        .any(|u| u.alive && u.id != mover.id && u.pos == dest)
    {
        return Err(PathError::DestOccupied);
    }
    let mut dist = vec![u32::MAX; n];
    dist[idx(start)] = 0;
    loop {
        let mut changed = false;
        for y in 0..b.height {
            for x in 0..b.width {
                let v = c(x, y);
                let vi = idx(v);
                if vi == idx(start) || enemy[vi] {
                    continue;
                }
                let Some(w) = weight[vi] else { continue };
                for u in neighbours(b, v) {
                    let du = dist[idx(u)];
                    if du != u32::MAX && du + w < dist[vi] {
                        dist[vi] = du + w;
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
    if dist[idx(dest)] == u32::MAX {
        return Err(PathError::Unreachable);
    }
    let mut steps = Vec::new();
    let mut cur = dest;
    while cur != start {
        steps.push(cur);
        let w = weight[idx(cur)].expect("an entered tile has a weight");
        let mut best: Option<(u32, u8, u8)> = None;
        for u in neighbours(b, cur) {
            let du = dist[idx(u)];
            if du != u32::MAX && du + w == dist[idx(cur)] {
                let key = (du, u.y, u.x);
                if best.is_none_or(|k| key < k) {
                    best = Some(key);
                }
            }
        }
        let (_, py, px) = best.expect("a reachable tile has a predecessor");
        cur = c(px, py);
    }
    steps.reverse();
    Ok(Path {
        steps,
        cost: u16::try_from(dist[idx(dest)]).expect("cost fits u16"),
    })
}

type UnitRaw = (u16, bool, bool, u8);

fn random_board(
    w: u8,
    h: u8,
    terrain_raw: &[u8],
    units_raw: &[UnitRaw],
    mover_class: u8,
    mover_cell: u16,
) -> (Board, Cell) {
    let n = usize::from(w) * usize::from(h);
    let terrain: Vec<Terrain> = terrain_raw
        .iter()
        .take(n)
        .map(|&t| terrain_from(t))
        .collect();
    let cell_of = |raw: u16| {
        let i = usize::from(raw) % n;
        c(
            u8::try_from(i % usize::from(w)).expect("x"),
            u8::try_from(i / usize::from(w)).expect("y"),
        )
    };
    let start = cell_of(mover_cell);
    let mut units = vec![BoardUnit {
        id: 1,
        side: Side::A,
        pos: start,
        alive: true,
        class: class_from(mover_class),
    }];
    let mut next_id = 2u32;
    for &(raw, is_a, alive, cls) in units_raw {
        let pos = cell_of(raw);
        if units.iter().any(|u| u.pos == pos) {
            continue;
        }
        units.push(BoardUnit {
            id: next_id,
            side: if is_a { Side::A } else { Side::B },
            pos,
            alive,
            class: class_from(cls),
        });
        next_id += 1;
    }
    (
        Board {
            width: w,
            height: h,
            terrain,
            blocks_los: vec![false; n],
            units,
        },
        start,
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn bt1_6_find_path_equals_an_independent_relaxation_with_the_pred_rule(
        w in 2u8..=8,
        h in 2u8..=8,
        terrain_raw in prop::collection::vec(any::<u8>(), 64),
        units_raw in prop::collection::vec(
            (any::<u16>(), any::<bool>(), prop::bool::weighted(0.85), any::<u8>()),
            0..=7,
        ),
        mover_class in any::<u8>(),
        mover_cell in any::<u16>(),
    ) {
        let (b, start) = random_board(w, h, &terrain_raw, &units_raw, mover_class, mover_cell);
        let mover = b.units[0];
        for y in 0..h {
            for x in 0..w {
                let dest = c(x, y);
                let want = reference_path(&b, &mover, start, dest);
                let got = find_path(&b, 1, start, dest);
                prop_assert_eq!(&got, &want, "start {:?} dest {:?}", start, dest);

                if let Ok(p) = &got {
                    // Structural invariants, independent of the reference.
                    prop_assert_eq!(p.steps.last().copied(), Some(dest));
                    let mut prev = start;
                    let mut sum = 0u32;
                    for s in &p.steps {
                        let adj = u16::from(prev.x.abs_diff(s.x)) + u16::from(prev.y.abs_diff(s.y));
                        prop_assert_eq!(adj, 1, "step {:?}->{:?} not adjacent", prev, s);
                        let t = b.terrain[usize::from(s.y) * usize::from(w) + usize::from(s.x)];
                        let wt = ref_weight(mover.class, t);
                        prop_assert!(wt.is_some(), "stepped on impassable {:?}", t);
                        sum += wt.unwrap_or(0);
                        let on_enemy = b.units.iter().any(|u| {
                            u.alive && u.side != mover.side && u.pos == *s
                        });
                        prop_assert!(!on_enemy, "path crosses an enemy at {:?}", s);
                        prev = *s;
                    }
                    prop_assert_eq!(u32::from(p.cost), sum);
                    let ends_on_unit = b.units.iter().any(|u| {
                        u.alive && u.id != 1 && u.pos == dest
                    });
                    prop_assert!(!ends_on_unit, "path ends on a unit at {:?}", dest);
                }
            }
        }
        // Out-of-bounds destinations are typed, not clamped.
        prop_assert_eq!(find_path(&b, 1, start, c(w, 0)), Err(PathError::OutOfBounds));
        prop_assert_eq!(find_path(&b, 1, start, c(0, h)), Err(PathError::OutOfBounds));
    }
}

#[test]
fn bt1_6_the_reference_relaxation_reproduces_the_hand_derived_paths() {
    // Guards the property test against a wrong reference: it must agree with the
    // hand-derived pred-rule answers above before it is trusted to judge find_path.
    let fork = board(&PLAIN_3X3, vec![me(MoveClass::Walk, 0, 0)]);
    let m = fork.units[0];
    assert_eq!(
        reference_path(&fork, &m, c(0, 0), c(1, 1)),
        ok(&[(1, 0), (1, 1)], 2)
    );
    let pred = board(
        &["...", ".r.", ".r.", "..."],
        vec![me(MoveClass::Walk, 1, 0)],
    );
    let m = pred.units[0];
    assert_eq!(
        reference_path(&pred, &m, c(1, 0), c(1, 3)),
        ok(&[(1, 1), (1, 2), (1, 3)], 5)
    );
    let rough = board(
        &["......", ".rrrr.", "......"],
        vec![me(MoveClass::Walk, 0, 1)],
    );
    let m = rough.units[0];
    assert_eq!(
        reference_path(&rough, &m, c(0, 1), c(5, 1)),
        ok(&[(0, 0), (1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (5, 1)], 7)
    );
}

// ---------------------------------------------------------------------------
// Source scan (plan A6): non-test tactics/*.rs has no hash collections, RandomState, floats
// ---------------------------------------------------------------------------

/// Drop `//` line comments and (nested) `/* */` block comments, keeping string and char
/// literals verbatim so a `//` inside a string does not swallow the rest of the line.
fn strip_comments(src: &str) -> String {
    let b: Vec<char> = src.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut depth = 0usize;
    while i < b.len() {
        let ch = b[i];
        let next = b.get(i + 1).copied();
        if depth > 0 {
            if ch == '/' && next == Some('*') {
                depth += 1;
                i += 2;
            } else if ch == '*' && next == Some('/') {
                depth -= 1;
                i += 2;
            } else {
                if ch == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            continue;
        }
        if ch == '/' && next == Some('/') {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if ch == '/' && next == Some('*') {
            depth = 1;
            i += 2;
            continue;
        }
        if ch == '"' {
            out.push(ch);
            i += 1;
            while i < b.len() {
                let s = b[i];
                out.push(s);
                i += 1;
                if s == '\\' && i < b.len() {
                    out.push(b[i]);
                    i += 1;
                } else if s == '"' {
                    break;
                }
            }
            continue;
        }
        if ch == '\'' {
            if next == Some('\\') {
                out.push(ch);
                i += 1;
                while i < b.len() {
                    let s = b[i];
                    out.push(s);
                    i += 1;
                    if s == '\\' && i < b.len() {
                        out.push(b[i]);
                        i += 1;
                    } else if s == '\'' {
                        break;
                    }
                }
                continue;
            }
            if b.get(i + 2).copied() == Some('\'') {
                out.push(b[i]);
                out.push(b[i + 1]);
                out.push(b[i + 2]);
                i += 3;
                continue;
            }
        }
        out.push(ch);
        i += 1;
    }
    out
}

fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

/// Whole-token match; `f32`/`f64` additionally match as a numeric-literal suffix (`1f32`).
fn contains_token(code: &str, needle: &str) -> bool {
    let hay: Vec<char> = code.chars().collect();
    let pat: Vec<char> = needle.chars().collect();
    if pat.is_empty() || hay.len() < pat.len() {
        return false;
    }
    let numeric = needle == "f32" || needle == "f64";
    for i in 0..=hay.len() - pat.len() {
        if hay[i..i + pat.len()] != pat[..] {
            continue;
        }
        let right_ok = hay.get(i + pat.len()).is_none_or(|&ch| !is_ident_char(ch));
        let left_ok = i == 0 || {
            let p = hay[i - 1];
            !is_ident_char(p) || (numeric && p.is_ascii_digit())
        };
        if left_ok && right_ok {
            return true;
        }
    }
    false
}

const FORBIDDEN: [&str; 6] = [
    "HashMap",
    "HashSet",
    "hash_map",
    "RandomState",
    "f32",
    "f64",
];

fn tactics_sources() -> Vec<(String, String)> {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("tactics");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("read src/tactics") {
        let path = entry.expect("dir entry").path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("utf-8 file name")
            .to_string();
        if name.ends_with(".rs") && !name.ends_with("_tests.rs") {
            out.push((name, std::fs::read_to_string(&path).expect("read source")));
        }
    }
    out.sort();
    out
}

#[test]
fn bt1_6_tactics_sources_use_no_hash_collections_or_floats() {
    let sources = tactics_sources();
    let names: Vec<&str> = sources.iter().map(|(n, _)| n.as_str()).collect();
    for want in [
        "geometry.rs",
        "golden.rs",
        "map.rs",
        "mod.rs",
        "movement.rs",
    ] {
        assert!(names.contains(&want), "scan missed {want}: {names:?}");
    }
    for (name, src) in &sources {
        let code = strip_comments(src);
        for needle in FORBIDDEN {
            assert!(
                !contains_token(&code, needle),
                "{name}: non-test tactics code uses `{needle}` (iteration order / determinism)"
            );
        }
    }
    // The stripper must not have swallowed the real code it is scanning.
    let movement = sources
        .iter()
        .find(|(n, _)| n == "movement.rs")
        .expect("movement.rs");
    assert!(strip_comments(&movement.1).contains("fn find_path"));
    let geometry = sources
        .iter()
        .find(|(n, _)| n == "geometry.rs")
        .expect("geometry.rs");
    assert!(strip_comments(&geometry.1).contains("fn target_set"));
}

#[test]
fn bt1_6_scan_sees_code_tokens_and_ignores_comments() {
    let src = "// HashMap in a comment\nlet a = 1; /* f64 /* nested */ HashSet */ let s = \"// kept\"; let m: HashMap<u8, u8>; let x = 1.5f32;";
    let code = strip_comments(src);
    assert!(contains_token(&code, "HashMap"), "real code token is found");
    assert!(
        contains_token(&code, "f32"),
        "numeric-literal suffix is found"
    );
    assert!(
        !contains_token(&code, "HashSet"),
        "nested block comment is skipped"
    );
    assert!(!contains_token(&code, "f64"), "block comment is skipped");
    assert!(!contains_token(
        "let buf320 = u32::MAX; let my_hash_mapper = 1;",
        "hash_map"
    ));
}

// ===========================================================================
// BT1.7 — disengage
// ===========================================================================

fn open5(units: Vec<BoardUnit>) -> Board {
    board(&["....."; 5], units)
}

#[test]
fn bt1_7_adjacent_living_enemy_flags_the_tax() {
    let b = open5(vec![me(MoveClass::Walk, 2, 2), foe(2, 3, 2)]);
    assert_eq!(disengage_taxed(&b, 1, c(2, 2)), Ok(true));
}

#[test]
fn bt1_7_every_orthogonal_side_counts_and_diagonals_do_not() {
    for (ex, ey) in [(3, 2), (1, 2), (2, 1), (2, 3)] {
        let b = open5(vec![me(MoveClass::Walk, 2, 2), foe(2, ex, ey)]);
        assert_eq!(
            disengage_taxed(&b, 1, c(2, 2)),
            Ok(true),
            "enemy at ({ex},{ey})"
        );
    }
    for (ex, ey) in [(3, 3), (1, 1), (3, 1), (1, 3)] {
        let b = open5(vec![me(MoveClass::Walk, 2, 2), foe(2, ex, ey)]);
        assert_eq!(
            disengage_taxed(&b, 1, c(2, 2)),
            Ok(false),
            "diagonal ({ex},{ey})"
        );
    }
    let far = open5(vec![me(MoveClass::Walk, 2, 2), foe(2, 4, 2)]);
    assert_eq!(disengage_taxed(&far, 1, c(2, 2)), Ok(false), "distance 2");
}

#[test]
fn bt1_7_an_adjacent_ally_or_a_dead_enemy_does_not_flag() {
    let with_ally = open5(vec![me(MoveClass::Walk, 2, 2), ally(2, 3, 2)]);
    assert_eq!(disengage_taxed(&with_ally, 1, c(2, 2)), Ok(false));
    let with_corpse = open5(vec![me(MoveClass::Walk, 2, 2), dead(foe(2, 3, 2))]);
    assert_eq!(disengage_taxed(&with_corpse, 1, c(2, 2)), Ok(false));
    let alone = open5(vec![me(MoveClass::Walk, 2, 2)]);
    assert_eq!(disengage_taxed(&alone, 1, c(2, 2)), Ok(false));
}

#[test]
fn bt1_7_fly_class_is_exempt_every_other_class_is_taxed() {
    for (class, want) in [
        (MoveClass::Walk, true),
        (MoveClass::Nimble, true),
        (MoveClass::Swim, true),
        (MoveClass::Fly, false),
    ] {
        let b = open5(vec![me(class, 2, 2), foe(2, 2, 3)]);
        assert_eq!(disengage_taxed(&b, 1, c(2, 2)), Ok(want), "{class:?}");
    }
}

#[test]
fn bt1_7_flag_is_a_single_bool_however_many_enemies_are_adjacent() {
    // The "+1 once per Move entry" is the caller adding one per entry; the predicate is a
    // bool, so two adjacent enemies are still just `true`.
    let b = open5(vec![
        me(MoveClass::Walk, 2, 2),
        foe(2, 3, 2),
        foe(3, 1, 2),
        foe(4, 2, 1),
    ]);
    assert_eq!(disengage_taxed(&b, 1, c(2, 2)), Ok(true));
}

#[test]
fn bt1_7_uses_the_given_start_tile_not_the_units_recorded_position() {
    // The unit's record says (0,0); a 2nd Move entry starts at (4,4) next to the enemy (4,3).
    let b = open5(vec![me(MoveClass::Walk, 0, 0), foe(2, 4, 3)]);
    assert_eq!(disengage_taxed(&b, 1, c(4, 4)), Ok(true));
    assert_eq!(disengage_taxed(&b, 1, c(0, 0)), Ok(false));
}

#[test]
fn bt1_7_side_b_mover_is_taxed_by_a_side_a_enemy() {
    let b = open5(vec![
        who(5, Side::B, MoveClass::Walk, 2, 2),
        who(1, Side::A, MoveClass::Walk, 3, 2),
    ]);
    assert_eq!(disengage_taxed(&b, 5, c(2, 2)), Ok(true));
}

#[test]
fn bt1_7_unknown_or_dead_mover_is_an_error_never_a_silent_waiver() {
    let b = open5(vec![me(MoveClass::Walk, 2, 2), foe(2, 3, 2)]);
    assert_eq!(
        disengage_taxed(&b, 9, c(2, 2)),
        Err(PathError::UnknownMover(9))
    );
    let d = open5(vec![dead(me(MoveClass::Walk, 2, 2)), foe(2, 3, 2)]);
    assert_eq!(
        disengage_taxed(&d, 1, c(2, 2)),
        Err(PathError::UnknownMover(1))
    );
}
