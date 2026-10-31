//! bt-1 gating tests — BT1.1 .. BT1.4 (`tactics::geometry`).
//!
//! BT1.1 Manhattan everywhere + ONE target-set symbol · BT1.2 the exact `target_set`
//! contract (plan A7 check order) · BT1.3 line of sight (no blockers => true) ·
//! BT1.4 flank.
//!
//! Every expected value is hand-derived from the contract on the fixed "S2" scenario
//! below (never read back from the implementation). Names start `bt1_<k>_` — the
//! acceptance ledger's CHECKs filter on that prefix.
//!
//! S2 (5x5 open board, `(x, y)`):
//!
//! ```text
//!   y0 . . 8 . .      1 A caster (2,2)   2 A ally  (1,2)   8 A ally (2,0)
//!   y1 . . . . .      3 B enemy  (3,2)   4 B enemy (4,2)   5 B enemy (3,3)
//!   y2 . 2 1 3 4      6 B DEAD   (2,3)   7 B enemy (2,4)
//!   y3 . . x 5 .
//!   y4 . . 7 . .
//! ```
//!
//! Sorted by `(y, x)` the living ids read 8,2,1,3,4,5,7; by `(x, y)` they read
//! 2,8,1,7,3,5,4; by id 1,2,3,4,5,7,8 — three distinct orders, so a wrong sort key
//! cannot hide.

use super::geometry::{
    is_adjacent, is_flanked, line_of_sight, manhattan, target_set, Board, BoardUnit, Cell,
    FfFilter, GeometryError, Origin, Shape, Side, SkillGeometry,
};
use super::movement::{MoveClass, Terrain};

const CA: Origin = Origin::Caster;
const TU: Origin = Origin::TargetUnit;
const EN: FfFilter = FfFilter::Enemies;
const ABS: FfFilter = FfFilter::AllButSelf;
const ALL: FfFilter = FfFilter::All;

fn c(x: u8, y: u8) -> Cell {
    Cell { x, y }
}

fn unit(id: u32, side: Side, x: u8, y: u8) -> BoardUnit {
    BoardUnit {
        id,
        side,
        pos: c(x, y),
        alive: true,
        class: MoveClass::Walk,
    }
}

fn corpse(id: u32, side: Side, x: u8, y: u8) -> BoardUnit {
    BoardUnit {
        alive: false,
        ..unit(id, side, x, y)
    }
}

fn open_board(width: u8, height: u8, units: Vec<BoardUnit>) -> Board {
    let n = usize::from(width) * usize::from(height);
    Board {
        width,
        height,
        terrain: vec![Terrain::Plain; n],
        blocks_los: vec![false; n],
        units,
    }
}

fn g(
    range_min: u8,
    range_max: u8,
    origin: Origin,
    shape: Shape,
    radius: u8,
    ff_filter: FfFilter,
) -> SkillGeometry {
    SkillGeometry {
        range_min,
        range_max,
        origin,
        shape,
        radius,
        ff_filter,
    }
}

fn s2_units() -> Vec<BoardUnit> {
    vec![
        unit(1, Side::A, 2, 2),
        unit(2, Side::A, 1, 2),
        unit(3, Side::B, 3, 2),
        unit(4, Side::B, 4, 2),
        unit(5, Side::B, 3, 3),
        corpse(6, Side::B, 2, 3),
        unit(7, Side::B, 2, 4),
        unit(8, Side::A, 2, 0),
    ]
}

fn s2() -> Board {
    open_board(5, 5, s2_units())
}

fn ts(geom: SkillGeometry, caster: u32, x: u8, y: u8) -> Result<Vec<u32>, GeometryError> {
    target_set(&geom, caster, c(x, y), &s2())
}

// ===========================================================================
// BT1.1 — Manhattan everywhere, ONE target-set function
// ===========================================================================

#[test]
fn bt1_1_manhattan_known_values() {
    assert_eq!(manhattan(c(0, 0), c(7, 7)), 14);
    assert_eq!(manhattan(c(3, 4), c(3, 4)), 0);
    assert_eq!(manhattan(c(5, 2), c(1, 6)), 8);
    assert_eq!(manhattan(c(0, 3), c(5, 3)), 5);
    assert_eq!(manhattan(c(4, 6), c(4, 0)), 6);
    // A diagonal step costs 2 (Manhattan), never 1 (Chebyshev) or 1.41 (Euclid).
    assert_eq!(manhattan(c(1, 1), c(2, 2)), 2);
    assert_eq!(manhattan(c(3, 3), c(6, 6)), 6);
}

#[test]
fn bt1_1_manhattan_matches_axis_delta_sum_for_every_pair_on_8x8() {
    for ay in 0..8u8 {
        for ax in 0..8u8 {
            for by in 0..8u8 {
                for bx in 0..8u8 {
                    let want = u16::from(ax.abs_diff(bx)) + u16::from(ay.abs_diff(by));
                    assert_eq!(
                        manhattan(c(ax, ay), c(bx, by)),
                        want,
                        "({ax},{ay})-({bx},{by})"
                    );
                    assert_eq!(
                        manhattan(c(ax, ay), c(bx, by)),
                        manhattan(c(bx, by), c(ax, ay)),
                        "symmetry ({ax},{ay})-({bx},{by})"
                    );
                }
            }
        }
    }
}

#[test]
fn bt1_1_manhattan_widens_past_u8_without_overflow() {
    assert_eq!(manhattan(c(255, 255), c(0, 0)), 510);
    assert_eq!(manhattan(c(0, 0), c(255, 255)), 510);
    assert_eq!(manhattan(c(255, 0), c(0, 0)), 255);
    assert_eq!(manhattan(c(255, 0), c(0, 255)), 510);
}

#[test]
fn bt1_1_is_adjacent_is_exactly_manhattan_one_for_every_pair_on_8x8() {
    for ay in 0..8u8 {
        for ax in 0..8u8 {
            for by in 0..8u8 {
                for bx in 0..8u8 {
                    let want = ax.abs_diff(bx) + ay.abs_diff(by) == 1;
                    assert_eq!(
                        is_adjacent(c(ax, ay), c(bx, by)),
                        want,
                        "({ax},{ay})-({bx},{by})"
                    );
                }
            }
        }
    }
    assert!(!is_adjacent(c(3, 3), c(4, 4)), "diagonal is not adjacent");
    assert!(
        !is_adjacent(c(3, 3), c(3, 3)),
        "a tile is not adjacent to itself"
    );
    assert!(is_adjacent(c(255, 255), c(255, 254)));
}

#[test]
fn bt1_1_range_band_is_manhattan_not_chebyshev() {
    // Caster (2,2); aim (3,3) is Manhattan 2 but Chebyshev 1.
    let melee = g(1, 1, TU, Shape::Single, 0, ALL);
    assert_eq!(
        ts(melee, 1, 3, 3),
        Err(GeometryError::OutOfRange { distance: 2 })
    );
    let band2 = g(1, 2, TU, Shape::Single, 0, ALL);
    // Inside the widened band the empty diagonal tile is reached (then has no unit).
    assert_eq!(ts(band2, 1, 3, 3), Ok(vec![5]));
}

#[test]
fn bt1_1_diamond_area_is_a_manhattan_ball_not_a_square() {
    // Diamond r2 around enemy 3 (3,2): enemy 7 (2,4) and ally 8 (2,0) are Chebyshev 2
    // but Manhattan 3 => NOT in the area. Ally 2 (1,2) is Manhattan 2 => in.
    let r = ts(g(1, 1, TU, Shape::Diamond, 2, ALL), 1, 3, 2).expect("valid diamond");
    assert_eq!(r, vec![2, 1, 3, 4, 5]);
    assert!(!r.contains(&7));
    assert!(!r.contains(&8));
}

#[test]
fn bt1_1_target_set_is_one_symbol_reexported_at_every_surface() {
    // The server validator, client highlighter, forecast and wild AI all call this one
    // function: it must be reachable by the same path from the crate root, `tactics`
    // and `tactics::geometry` (the 4 call sites arrive in bt-3/7/10/6).
    let geom = g(1, 1, TU, Shape::Single, 0, EN);
    let board = s2();
    let via_geometry = super::geometry::target_set(&geom, 1, c(3, 2), &board);
    let via_tactics = crate::tactics::target_set(&geom, 1, c(3, 2), &board);
    let via_root = crate::target_set(&geom, 1, c(3, 2), &board);
    assert_eq!(via_geometry, Ok(vec![3]));
    assert_eq!(via_tactics, via_geometry);
    assert_eq!(via_root, via_geometry);
}

// ===========================================================================
// BT1.2 — the target-set contract
// ===========================================================================

#[test]
fn bt1_2_range_zero_is_self() {
    assert_eq!(ts(g(0, 0, CA, Shape::Single, 0, ALL), 1, 2, 2), Ok(vec![1]));
    // The filter is applied per unit: the caster is not its own enemy / is excluded by AllButSelf.
    assert_eq!(ts(g(0, 0, CA, Shape::Single, 0, EN), 1, 2, 2), Ok(vec![]));
    assert_eq!(ts(g(0, 0, CA, Shape::Single, 0, ABS), 1, 2, 2), Ok(vec![]));
    // A TargetUnit-origin range-0 skill also resolves on the caster's own tile.
    assert_eq!(ts(g(0, 0, TU, Shape::Single, 0, ALL), 1, 2, 2), Ok(vec![1]));
}

#[test]
fn bt1_2_range_one_is_melee_both_sides_of_the_band() {
    let melee = g(1, 1, TU, Shape::Single, 0, EN);
    assert_eq!(
        ts(melee, 1, 3, 2),
        Ok(vec![3]),
        "adjacent enemy is in range"
    );
    assert_eq!(
        ts(melee, 1, 4, 2),
        Err(GeometryError::OutOfRange { distance: 2 }),
        "distance 2 is above range_max"
    );
    assert_eq!(
        ts(melee, 1, 2, 2),
        Err(GeometryError::OutOfRange { distance: 0 }),
        "distance 0 is below range_min 1"
    );
}

#[test]
fn bt1_2_ranged_band_edges_and_no_target_unit() {
    let band = g(2, 3, TU, Shape::Single, 0, EN);
    assert_eq!(ts(band, 1, 4, 2), Ok(vec![4]), "d2 is the inclusive floor");
    assert_eq!(ts(band, 1, 2, 4), Ok(vec![7]));
    assert_eq!(
        ts(band, 1, 3, 2),
        Err(GeometryError::OutOfRange { distance: 1 })
    );
    assert_eq!(
        ts(band, 1, 4, 4),
        Err(GeometryError::OutOfRange { distance: 4 })
    );
    // d3 is the inclusive ceiling: in range, but the tile holds no unit.
    assert_eq!(ts(band, 1, 4, 3), Err(GeometryError::NoTargetUnit));
    assert_eq!(ts(band, 1, 0, 2), Err(GeometryError::NoTargetUnit));
    assert_eq!(ts(g(2, 3, TU, Shape::Single, 0, ABS), 1, 2, 4), Ok(vec![7]));
}

#[test]
fn bt1_2_single_filters_the_aimed_unit_and_ally_aim_is_ok_empty() {
    let enemies = g(1, 1, TU, Shape::Single, 0, EN);
    // Single + Enemies aimed at an ally is Ok([]) — bt-3 checks the intended target.
    assert_eq!(ts(enemies, 1, 1, 2), Ok(vec![]));
    assert_eq!(ts(g(1, 1, TU, Shape::Single, 0, ALL), 1, 1, 2), Ok(vec![2]));
    assert_eq!(ts(g(1, 1, TU, Shape::Single, 0, ABS), 1, 1, 2), Ok(vec![2]));
}

#[test]
fn bt1_2_dead_units_are_never_targeted_or_counted() {
    // Dead unit 6 sits on (2,3), adjacent to the caster.
    assert_eq!(
        ts(g(1, 1, TU, Shape::Single, 0, ALL), 1, 2, 3),
        Err(GeometryError::NoTargetUnit)
    );
    // And it is skipped inside areas that cover its tile (Diamond r2 around (3,2) covers (2,3)).
    let r = ts(g(1, 1, TU, Shape::Diamond, 2, ALL), 1, 3, 2).expect("valid");
    assert!(!r.contains(&6));
    // A dead caster is not a caster.
    assert_eq!(
        ts(g(1, 1, TU, Shape::Single, 0, EN), 6, 3, 2),
        Err(GeometryError::UnknownCaster(6))
    );
}

#[test]
fn bt1_2_radius_zero_is_the_target_tile_only() {
    // Enemies 4 (4,2) and 5 (3,3) are adjacent to the aimed enemy 3 but NOT in a r0 area.
    assert_eq!(ts(g(1, 2, TU, Shape::Diamond, 0, EN), 1, 3, 2), Ok(vec![3]));
}

#[test]
fn bt1_2_diamond_radius_one_per_unit_filter() {
    // Area around (3,2): (3,2)=3, (2,2)=1, (4,2)=4, (3,3)=5.
    let aim = (3, 2);
    assert_eq!(
        ts(g(1, 1, TU, Shape::Diamond, 1, EN), 1, aim.0, aim.1),
        Ok(vec![3, 4, 5])
    );
    assert_eq!(
        ts(g(1, 1, TU, Shape::Diamond, 1, ALL), 1, aim.0, aim.1),
        Ok(vec![1, 3, 4, 5]),
        "All includes the caster standing in the area"
    );
    assert_eq!(
        ts(g(1, 1, TU, Shape::Diamond, 1, ABS), 1, aim.0, aim.1),
        Ok(vec![3, 4, 5])
    );
}

#[test]
fn bt1_2_diamond_radius_two_per_unit_filter_with_friendly_fire() {
    // Alive units within Manhattan 2 of (3,2): 1,2,3,4,5 (dead 6 skipped; 7 and 8 are 3 away).
    let aim = (3, 2);
    assert_eq!(
        ts(g(1, 1, TU, Shape::Diamond, 2, EN), 1, aim.0, aim.1),
        Ok(vec![3, 4, 5])
    );
    assert_eq!(
        ts(g(1, 1, TU, Shape::Diamond, 2, ABS), 1, aim.0, aim.1),
        Ok(vec![2, 3, 4, 5]),
        "AllButSelf hits the ally but not the caster"
    );
    assert_eq!(
        ts(g(1, 1, TU, Shape::Diamond, 2, ALL), 1, aim.0, aim.1),
        Ok(vec![2, 1, 3, 4, 5]),
        "All hits everyone alive in the area, sorted (y,x)"
    );
}

#[test]
fn bt1_2_burst_around_the_caster_excludes_its_origin() {
    // Caster (2,2): neighbours are (1,2)=2, (3,2)=3, (2,3)=dead 6, (2,1)=empty.
    assert_eq!(
        ts(g(0, 0, CA, Shape::Burst, 1, ALL), 1, 2, 2),
        Ok(vec![2, 3])
    );
    assert_eq!(ts(g(0, 0, CA, Shape::Burst, 1, EN), 1, 2, 2), Ok(vec![3]));
    assert_eq!(
        ts(g(0, 0, CA, Shape::Burst, 1, ABS), 1, 2, 2),
        Ok(vec![2, 3])
    );
}

#[test]
fn bt1_2_burst_around_an_aimed_unit_excludes_that_unit() {
    // Aim enemy 3 at (3,2): neighbours (2,2)=1, (4,2)=4, (3,3)=5, (3,1)=empty; 3 itself excluded.
    assert_eq!(
        ts(g(1, 1, TU, Shape::Burst, 1, ALL), 1, 3, 2),
        Ok(vec![1, 4, 5])
    );
    assert_eq!(
        ts(g(1, 1, TU, Shape::Burst, 1, EN), 1, 3, 2),
        Ok(vec![4, 5])
    );
}

#[test]
fn bt1_2_radius_rules_per_shape_both_sides() {
    // Diamond: 0,1,2 ok; 3 and beyond rejected.
    for r in 0..=2u8 {
        assert!(
            ts(g(1, 1, TU, Shape::Diamond, r, EN), 1, 3, 2).is_ok(),
            "diamond r{r}"
        );
    }
    for r in [3u8, 4, 255] {
        assert_eq!(
            ts(g(1, 1, TU, Shape::Diamond, r, EN), 1, 3, 2),
            Err(GeometryError::BadRadius {
                shape: Shape::Diamond,
                radius: r
            })
        );
    }
    // Single: only 0.
    assert!(ts(g(1, 1, TU, Shape::Single, 0, EN), 1, 3, 2).is_ok());
    assert_eq!(
        ts(g(1, 1, TU, Shape::Single, 1, EN), 1, 3, 2),
        Err(GeometryError::BadRadius {
            shape: Shape::Single,
            radius: 1
        })
    );
    // Burst: only 1.
    assert!(ts(g(0, 0, CA, Shape::Burst, 1, ALL), 1, 2, 2).is_ok());
    assert_eq!(
        ts(g(0, 0, CA, Shape::Burst, 0, ALL), 1, 2, 2),
        Err(GeometryError::BadRadius {
            shape: Shape::Burst,
            radius: 0
        })
    );
    assert_eq!(
        ts(g(0, 0, CA, Shape::Burst, 2, ALL), 1, 2, 2),
        Err(GeometryError::BadRadius {
            shape: Shape::Burst,
            radius: 2
        })
    );
}

#[test]
fn bt1_2_reserved_shapes_are_typed_unsupported_never_an_empty_set() {
    // Otherwise-valid geometries: an impl that returned Ok(vec![]) would fail here.
    assert_eq!(
        ts(g(1, 1, TU, Shape::Line, 1, EN), 1, 3, 2),
        Err(GeometryError::Unsupported(Shape::Line))
    );
    assert_eq!(
        ts(g(1, 1, TU, Shape::Cone, 1, EN), 1, 3, 2),
        Err(GeometryError::Unsupported(Shape::Cone))
    );
    // Unsupported is the FIRST check: it beats an unknown caster, a bad range, an OOB aim.
    assert_eq!(
        ts(g(3, 1, TU, Shape::Line, 1, EN), 99, 3, 2),
        Err(GeometryError::Unsupported(Shape::Line))
    );
    assert_eq!(
        ts(g(1, 1, TU, Shape::Cone, 9, EN), 99, 200, 200),
        Err(GeometryError::Unsupported(Shape::Cone))
    );
}

#[test]
fn bt1_2_bad_range_is_checked_before_radius_and_caster() {
    assert_eq!(
        ts(g(3, 2, TU, Shape::Single, 0, EN), 1, 3, 2),
        Err(GeometryError::BadRange)
    );
    assert_eq!(
        ts(g(3, 2, TU, Shape::Single, 0, EN), 99, 3, 2),
        Err(GeometryError::BadRange),
        "BadRange beats UnknownCaster"
    );
    assert_eq!(
        ts(g(3, 2, TU, Shape::Single, 1, EN), 1, 3, 2),
        Err(GeometryError::BadRange),
        "BadRange beats BadRadius"
    );
    // range_min == range_max is a legal band.
    assert!(ts(g(1, 1, TU, Shape::Single, 0, EN), 1, 3, 2).is_ok());
}

#[test]
fn bt1_2_bad_radius_is_checked_before_the_caster() {
    assert_eq!(
        ts(g(1, 1, TU, Shape::Diamond, 3, EN), 99, 3, 2),
        Err(GeometryError::BadRadius {
            shape: Shape::Diamond,
            radius: 3
        })
    );
}

#[test]
fn bt1_2_unknown_or_dead_caster_beats_out_of_bounds() {
    assert_eq!(
        ts(g(1, 1, TU, Shape::Single, 0, EN), 99, 3, 2),
        Err(GeometryError::UnknownCaster(99))
    );
    assert_eq!(
        ts(g(1, 1, TU, Shape::Single, 0, EN), 99, 9, 9),
        Err(GeometryError::UnknownCaster(99))
    );
}

#[test]
fn bt1_2_out_of_bounds_aim_both_sides_of_each_edge() {
    let wide = g(1, 10, TU, Shape::Single, 0, ALL);
    assert_eq!(ts(wide, 1, 5, 2), Err(GeometryError::OutOfBounds));
    assert_eq!(ts(wide, 1, 2, 5), Err(GeometryError::OutOfBounds));
    assert_eq!(ts(wide, 1, 255, 255), Err(GeometryError::OutOfBounds));
    // The last in-bounds tile is NOT out of bounds (empty => NoTargetUnit).
    assert_eq!(ts(wide, 1, 4, 4), Err(GeometryError::NoTargetUnit));
    // OOB beats AimNotCaster and OutOfRange.
    assert_eq!(
        ts(g(0, 0, CA, Shape::Burst, 1, ALL), 1, 5, 5),
        Err(GeometryError::OutOfBounds)
    );
    assert_eq!(
        ts(g(1, 1, TU, Shape::Single, 0, ALL), 1, 5, 2),
        Err(GeometryError::OutOfBounds)
    );
}

#[test]
fn bt1_2_non_square_boards_bound_x_by_width_and_y_by_height() {
    // 5 wide x 3 tall.
    let wide = open_board(5, 3, vec![unit(1, Side::A, 0, 0), unit(2, Side::B, 4, 2)]);
    let geom = g(1, 10, TU, Shape::Single, 0, EN);
    assert_eq!(target_set(&geom, 1, c(4, 2), &wide), Ok(vec![2]));
    assert_eq!(
        target_set(&geom, 1, c(2, 4), &wide),
        Err(GeometryError::OutOfBounds)
    );
    assert_eq!(
        target_set(&geom, 1, c(5, 0), &wide),
        Err(GeometryError::OutOfBounds)
    );
    // 3 wide x 5 tall.
    let tall = open_board(3, 5, vec![unit(1, Side::A, 0, 0), unit(2, Side::B, 2, 4)]);
    assert_eq!(target_set(&geom, 1, c(2, 4), &tall), Ok(vec![2]));
    assert_eq!(
        target_set(&geom, 1, c(4, 2), &tall),
        Err(GeometryError::OutOfBounds)
    );
}

#[test]
fn bt1_2_units_standing_off_the_board_are_never_in_a_target_set() {
    // 6x6 board; unit 2 stands at (6,5) and unit 3 at (5,6) — both OFF the board, yet within
    // Manhattan 1 of the caster at (5,5). The area is clipped to the board, so neither counts.
    let board = open_board(
        6,
        6,
        vec![
            unit(1, Side::A, 5, 5),
            unit(2, Side::B, 6, 5),
            unit(3, Side::B, 5, 6),
        ],
    );
    assert_eq!(
        target_set(&g(0, 5, CA, Shape::Diamond, 2, ALL), 1, c(5, 5), &board),
        Ok(vec![1])
    );
    assert_eq!(
        target_set(&g(0, 5, CA, Shape::Diamond, 2, EN), 1, c(5, 5), &board),
        Ok(vec![])
    );
    assert_eq!(
        target_set(&g(0, 0, CA, Shape::Burst, 1, ALL), 1, c(5, 5), &board),
        Ok(vec![])
    );
}

#[test]
fn bt1_2_units_sharing_a_tile_are_ordered_by_id_within_the_tile() {
    // Ids 9 and 4 stack on (2,2); id 7 stands at (1,2). Sort key is (y, x, id): the (1,2) unit
    // first, then the stacked pair by ascending id — whatever order they were listed in.
    let geom = g(1, 4, TU, Shape::Diamond, 1, EN);
    for stacked in [
        [unit(9, Side::B, 2, 2), unit(4, Side::B, 2, 2)],
        [unit(4, Side::B, 2, 2), unit(9, Side::B, 2, 2)],
    ] {
        let mut units = vec![unit(1, Side::A, 0, 0), unit(7, Side::B, 1, 2)];
        units.extend(stacked);
        let board = open_board(5, 5, units);
        assert_eq!(target_set(&geom, 1, c(2, 2), &board), Ok(vec![7, 4, 9]));
    }
}

#[test]
fn bt1_2_all_but_self_excludes_only_the_caster_id() {
    // Caster id 5 (side A) shares tile (2,2) with a different-id ally 2; ally 3 (side A) is
    // adjacent; enemy 4 is adjacent. Sorted (y,x,id): (2,2)->2,5  (3,2)->3  (2,3)->4.
    let units = vec![
        unit(5, Side::A, 2, 2),
        unit(2, Side::A, 2, 2),
        unit(3, Side::A, 3, 2),
        unit(4, Side::B, 2, 3),
    ];
    let board = open_board(5, 5, units);
    let at = |f: FfFilter| target_set(&g(0, 0, CA, Shape::Diamond, 1, f), 5, c(2, 2), &board);
    assert_eq!(at(ABS), Ok(vec![2, 3, 4]), "only id 5 is dropped");
    assert_eq!(at(ALL), Ok(vec![2, 5, 3, 4]));
    assert_eq!(at(EN), Ok(vec![4]));
}

#[test]
fn bt1_2_caster_origin_requires_the_aim_to_be_the_caster_tile() {
    assert_eq!(
        ts(g(0, 0, CA, Shape::Burst, 1, ALL), 1, 4, 2),
        Err(GeometryError::AimNotCaster),
        "AimNotCaster beats OutOfRange"
    );
    assert_eq!(
        ts(g(0, 1, CA, Shape::Single, 0, ALL), 1, 3, 2),
        Err(GeometryError::AimNotCaster),
        "an in-band adjacent aim is still not the caster tile"
    );
}

#[test]
fn bt1_2_out_of_range_beats_no_target_unit() {
    // Empty tile beyond the band => OutOfRange, not NoTargetUnit.
    assert_eq!(
        ts(g(1, 1, TU, Shape::Single, 0, ALL), 1, 0, 0),
        Err(GeometryError::OutOfRange { distance: 4 })
    );
}

#[test]
fn bt1_2_filters_are_relative_to_the_casters_side() {
    // Caster 3 is side B at (3,2).
    assert_eq!(
        ts(g(1, 1, TU, Shape::Single, 0, EN), 3, 2, 2),
        Ok(vec![1]),
        "A unit is B's enemy"
    );
    assert_eq!(
        ts(g(1, 1, TU, Shape::Single, 0, EN), 3, 4, 2),
        Ok(vec![]),
        "B unit 4 is B's ally"
    );
    assert_eq!(ts(g(0, 0, CA, Shape::Burst, 1, EN), 3, 3, 2), Ok(vec![1]));
    assert_eq!(
        ts(g(0, 0, CA, Shape::Burst, 1, ABS), 3, 3, 2),
        Ok(vec![1, 4, 5])
    );
}

#[test]
fn bt1_2_result_is_sorted_by_y_then_x_not_by_id_or_x_then_y() {
    let units = vec![
        unit(50, Side::A, 2, 4),
        unit(30, Side::B, 2, 1),
        unit(20, Side::B, 3, 1),
        unit(5, Side::B, 0, 2),
        unit(10, Side::B, 1, 2),
        unit(40, Side::B, 2, 2),
    ];
    let board = open_board(5, 5, units);
    let geom = g(2, 2, TU, Shape::Diamond, 2, EN);
    // (y,x): (2,1)=30 (3,1)=20 (0,2)=5 (1,2)=10 (2,2)=40.   (x,y) would give 5,10,30,40,20.
    assert_eq!(
        target_set(&geom, 50, c(2, 2), &board),
        Ok(vec![30, 20, 5, 10, 40])
    );
}

#[test]
fn bt1_2_area_is_clipped_to_the_board_corner() {
    let units = vec![
        unit(1, Side::A, 2, 2),
        unit(2, Side::B, 0, 0),
        unit(3, Side::B, 1, 0),
        unit(4, Side::B, 0, 2),
        unit(5, Side::B, 1, 1),
        unit(6, Side::B, 2, 0),
        unit(7, Side::B, 3, 0),
    ];
    let board = open_board(5, 5, units);
    let geom = g(1, 4, TU, Shape::Diamond, 2, EN);
    // Within Manhattan 2 of (0,0): ids 2,3,6,5,4 in (y,x) order; id 7 (3,0) is 3 away.
    assert_eq!(
        target_set(&geom, 1, c(0, 0), &board),
        Ok(vec![2, 3, 6, 5, 4])
    );
}

#[test]
fn bt1_2_empty_area_of_an_implemented_shape_is_ok_empty() {
    // Burst around the aimed far enemy 7 (2,4): neighbours (1,4),(3,4),(2,3)=dead 6 -> none alive.
    assert_eq!(ts(g(2, 2, TU, Shape::Burst, 1, EN), 1, 2, 4), Ok(vec![]));
}

// ===========================================================================
// BT1.3 — line of sight
// ===========================================================================

#[test]
fn bt1_3_no_blockers_every_pair_on_7x7_has_line_of_sight() {
    let blockers = vec![false; 49];
    for fy in 0..7u8 {
        for fx in 0..7u8 {
            for ty in 0..7u8 {
                for tx in 0..7u8 {
                    assert!(
                        line_of_sight(&blockers, 7, c(fx, fy), c(tx, ty)),
                        "({fx},{fy})->({tx},{ty})"
                    );
                }
            }
        }
    }
}

#[test]
fn bt1_3_corners_self_pair_and_non_square_widths() {
    let b8x6 = vec![false; 48];
    assert!(line_of_sight(&b8x6, 8, c(0, 0), c(7, 5)));
    assert!(line_of_sight(&b8x6, 8, c(7, 5), c(0, 0)));
    assert!(line_of_sight(&b8x6, 8, c(7, 0), c(0, 5)));
    assert!(line_of_sight(&b8x6, 8, c(3, 3), c(3, 3)), "from == to");
    let b6x8 = vec![false; 48];
    assert!(line_of_sight(&b6x8, 6, c(0, 7), c(5, 0)));
}

#[test]
fn bt1_3_signature_takes_the_blocker_grid_from_day_one() {
    // Compile-shape: a blocker grid + width + two cells => bool. P3 obstacles are then a
    // body change, not a signature change.
    let f: fn(&[bool], u8, Cell, Cell) -> bool = line_of_sight;
    assert!(f(&[false; 9], 3, c(0, 0), c(2, 2)));
}

#[test]
fn bt1_3_target_set_succeeds_across_the_whole_board_in_p1() {
    // The LoS step of target_set never rejects on a no-blocker board: the far-corner aim
    // of a long-range skill reaches the (empty) tile and fails only on NoTargetUnit.
    let board = open_board(5, 5, vec![unit(1, Side::A, 0, 0), unit(2, Side::B, 4, 4)]);
    let geom = g(1, 10, TU, Shape::Single, 0, EN);
    assert_eq!(target_set(&geom, 1, c(4, 4), &board), Ok(vec![2]));
    assert_eq!(
        target_set(&geom, 1, c(4, 0), &board),
        Err(GeometryError::NoTargetUnit)
    );
}

// ===========================================================================
// BT1.4 — flank
// ===========================================================================

const T: Cell = Cell { x: 3, y: 3 };

#[test]
fn bt1_4_adjacent_attacker_plus_one_adjacent_ally_flanks() {
    let units = [unit(1, Side::A, 3, 2), unit(2, Side::A, 4, 3)];
    assert!(is_flanked(1, T, &units));
}

#[test]
fn bt1_4_ranged_attacker_flanks_when_two_allies_pin_the_target() {
    let units = [
        unit(1, Side::A, 3, 6),
        unit(2, Side::A, 2, 3),
        unit(3, Side::A, 3, 4),
    ];
    assert!(
        is_flanked(1, T, &units),
        "attacker at distance 3 is not counted but 2 allies are"
    );
}

#[test]
fn bt1_4_ranged_attacker_with_only_one_adjacent_ally_does_not_flank() {
    let units = [unit(1, Side::A, 3, 6), unit(2, Side::A, 2, 3)];
    assert!(!is_flanked(1, T, &units));
}

#[test]
fn bt1_4_adjacent_attacker_alone_does_not_flank() {
    let units = [unit(1, Side::A, 3, 2), unit(2, Side::A, 5, 3)];
    assert!(!is_flanked(1, T, &units), "the second ally is 2 away");
}

#[test]
fn bt1_4_dead_allies_do_not_count() {
    let one_dead = [unit(1, Side::A, 3, 2), corpse(2, Side::A, 4, 3)];
    assert!(!is_flanked(1, T, &one_dead));
    let ranged_with_dead = [
        unit(1, Side::A, 3, 6),
        unit(2, Side::A, 2, 3),
        corpse(3, Side::A, 3, 4),
    ];
    assert!(!is_flanked(1, T, &ranged_with_dead));
    // Exactly two LIVING adjacent allies still flank even with a corpse alongside.
    let two_live_one_dead = [
        unit(1, Side::A, 3, 6),
        unit(2, Side::A, 2, 3),
        unit(3, Side::A, 3, 4),
        corpse(4, Side::A, 4, 3),
    ];
    assert!(is_flanked(1, T, &two_live_one_dead));
}

#[test]
fn bt1_4_enemy_side_units_do_not_count() {
    let units = [
        unit(1, Side::A, 3, 2),
        unit(2, Side::B, 4, 3),
        unit(3, Side::B, 2, 3),
    ];
    assert!(!is_flanked(1, T, &units));
}

#[test]
fn bt1_4_diagonal_allies_are_not_adjacent() {
    let units = [unit(1, Side::A, 3, 2), unit(2, Side::A, 4, 4)];
    assert!(!is_flanked(1, T, &units));
}

#[test]
fn bt1_4_three_or_more_adjacent_allies_flank() {
    let three = [
        unit(1, Side::A, 3, 2),
        unit(2, Side::A, 4, 3),
        unit(3, Side::A, 2, 3),
    ];
    assert!(is_flanked(1, T, &three));
    let four = [
        unit(1, Side::A, 3, 2),
        unit(2, Side::A, 4, 3),
        unit(3, Side::A, 2, 3),
        unit(4, Side::A, 3, 4),
    ];
    assert!(is_flanked(1, T, &four));
}

#[test]
fn bt1_4_unknown_or_dead_attacker_never_flanks() {
    let two_allies = [unit(1, Side::A, 3, 2), unit(2, Side::A, 4, 3)];
    assert!(!is_flanked(77, T, &two_allies), "unknown attacker");
    let dead_attacker = [
        corpse(1, Side::A, 3, 2),
        unit(2, Side::A, 4, 3),
        unit(3, Side::A, 2, 3),
    ];
    assert!(
        !is_flanked(1, T, &dead_attacker),
        "dead attacker with two living allies"
    );
}

#[test]
fn bt1_4_the_target_tile_itself_is_never_counted_as_adjacent() {
    // The target is on the attacker's own side: distance 0 is not adjacency.
    let own_target = [unit(1, Side::A, 3, 4), unit(2, Side::A, 3, 3)];
    assert!(!is_flanked(1, T, &own_target));
    let own_target_plus_ally = [
        unit(1, Side::A, 3, 4),
        unit(2, Side::A, 3, 3),
        unit(3, Side::A, 2, 3),
    ];
    assert!(is_flanked(1, T, &own_target_plus_ally));
}

#[test]
fn bt1_4_side_b_attacker_counts_side_b_units_only() {
    let units = [
        unit(5, Side::B, 2, 3),
        unit(6, Side::B, 3, 4),
        unit(1, Side::A, 3, 2),
    ];
    assert!(is_flanked(5, T, &units));
    let only_one_b = [
        unit(5, Side::B, 2, 3),
        unit(1, Side::A, 3, 2),
        unit(2, Side::A, 4, 3),
    ];
    assert!(!is_flanked(5, T, &only_one_b));
}

#[test]
fn bt1_4_edge_targets_do_not_underflow() {
    let corner = [unit(1, Side::A, 1, 0), unit(2, Side::A, 0, 1)];
    assert!(is_flanked(1, c(0, 0), &corner));
    let far = [unit(1, Side::A, 254, 255), unit(2, Side::A, 255, 254)];
    assert!(is_flanked(1, c(255, 255), &far));
}

#[test]
fn bt1_4_result_does_not_depend_on_unit_order() {
    let a = [
        unit(1, Side::A, 3, 6),
        unit(2, Side::A, 2, 3),
        unit(3, Side::A, 3, 4),
        unit(9, Side::B, 4, 3),
    ];
    let b = [a[3], a[2], a[1], a[0]];
    assert_eq!(is_flanked(1, T, &a), is_flanked(1, T, &b));
    assert!(is_flanked(1, T, &b));
}
