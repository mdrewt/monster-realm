//! Geometry — design §3.1, the ONE shared set of grid rules.
//!
//! Manhattan everywhere: movement, adjacency, range and area. [`target_set`] is the
//! single target function the server validator, the client highlighter, the forecast
//! and the wild AI all call. Results are ordered explicitly by `(y, x, id)`; [`Cell`]
//! is deliberately not `Ord`, so no ordering can be borrowed by accident.

use serde::{Deserialize, Serialize};

use super::movement::{MoveClass, Terrain};

/// A board tile. Deliberately NOT `Ord`: every ordering is spelled out as `(y, x)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Cell {
    pub x: u8,
    pub y: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    A,
    B,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardUnit {
    pub id: u32,
    pub side: Side,
    pub pos: Cell,
    pub alive: bool,
    pub class: MoveClass,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Board {
    pub width: u8,
    pub height: u8,
    pub terrain: Vec<Terrain>,
    pub blocks_los: Vec<bool>,
    pub units: Vec<BoardUnit>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Origin {
    Caster,
    TargetUnit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Shape {
    Single,
    Diamond,
    Burst,
    Line,
    Cone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FfFilter {
    Enemies,
    AllButSelf,
    All,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillGeometry {
    pub range_min: u8,
    pub range_max: u8,
    pub origin: Origin,
    pub shape: Shape,
    pub radius: u8,
    pub ff_filter: FfFilter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GeometryError {
    Unsupported(Shape),
    BadRange,
    BadRadius { shape: Shape, radius: u8 },
    UnknownCaster(u32),
    OutOfBounds,
    AimNotCaster,
    OutOfRange { distance: u16 },
    NoLineOfSight,
    NoTargetUnit,
}

/// Manhattan distance `|dx| + |dy|`.
#[must_use]
pub fn manhattan(a: Cell, b: Cell) -> u16 {
    u16::from(a.x.abs_diff(b.x)) + u16::from(a.y.abs_diff(b.y))
}

/// Orthogonal neighbours (Manhattan distance exactly 1).
#[must_use]
pub fn is_adjacent(a: Cell, b: Cell) -> bool {
    manhattan(a, b) == 1
}

/// Line of sight over a row-major blocker grid.
///
/// P1 maps carry no blockers (`blocks_los` is defaulted and unread), so every pair
/// sees every other. The grid is in the signature from day one so P3 obstacles are
/// content plus a new body here, with no signature change.
#[must_use]
pub fn line_of_sight(_blocks_los: &[bool], _width: u8, _from: Cell, _to: Cell) -> bool {
    true
}

impl Board {
    pub(crate) fn contains(&self, c: Cell) -> bool {
        c.x < self.width && c.y < self.height
    }

    /// The living unit with `id`, if any.
    pub(crate) fn living(&self, id: u32) -> Option<&BoardUnit> {
        self.units.iter().find(|u| u.alive && u.id == id)
    }
}

/// The units a skill with geometry `geom`, cast by `caster_id` at `aim`, affects.
///
/// Checks run in a fixed order and the first failure wins (see [`GeometryError`]).
/// Area: `Single` is the centre tile; `Diamond` every tile within `radius` (≤ 2);
/// `Burst` the ring `1..=radius` (radius 1) around its origin, excluding it. The
/// centre is the caster for `Origin::Caster` (aim must be the caster tile) and the
/// aimed unit's tile for `Origin::TargetUnit`. The friendly-fire filter is applied
/// per unit; dead units are never affected. Ordered by `(y, x, id)`.
///
/// # Errors
/// `Unsupported` for the reserved `Line`/`Cone` shapes (never an empty set),
/// `BadRange`, `BadRadius`, `UnknownCaster`, `OutOfBounds`, `AimNotCaster`,
/// `OutOfRange`, `NoLineOfSight`, `NoTargetUnit` — in that order.
pub fn target_set(
    geom: &SkillGeometry,
    caster_id: u32,
    aim: Cell,
    board: &Board,
) -> Result<Vec<u32>, GeometryError> {
    let radius_ok = match geom.shape {
        Shape::Line | Shape::Cone => return Err(GeometryError::Unsupported(geom.shape)),
        Shape::Single => geom.radius == 0,
        Shape::Diamond => geom.radius <= 2,
        Shape::Burst => geom.radius == 1,
    };
    if geom.range_min > geom.range_max {
        return Err(GeometryError::BadRange);
    }
    if !radius_ok {
        return Err(GeometryError::BadRadius {
            shape: geom.shape,
            radius: geom.radius,
        });
    }
    let caster = board
        .living(caster_id)
        .ok_or(GeometryError::UnknownCaster(caster_id))?;
    if !board.contains(aim) {
        return Err(GeometryError::OutOfBounds);
    }
    if geom.origin == Origin::Caster && aim != caster.pos {
        return Err(GeometryError::AimNotCaster);
    }
    let distance = manhattan(caster.pos, aim);
    if distance < u16::from(geom.range_min) || distance > u16::from(geom.range_max) {
        return Err(GeometryError::OutOfRange { distance });
    }
    if !line_of_sight(&board.blocks_los, board.width, caster.pos, aim) {
        return Err(GeometryError::NoLineOfSight);
    }
    if geom.origin == Origin::TargetUnit && !board.units.iter().any(|u| u.alive && u.pos == aim) {
        return Err(GeometryError::NoTargetUnit);
    }
    let radius = u16::from(geom.radius);
    let in_area = |c: Cell| {
        let d = manhattan(aim, c);
        match geom.shape {
            Shape::Burst => d >= 1 && d <= radius,
            _ => d <= radius,
        }
    };
    let mut hit: Vec<&BoardUnit> = board
        .units
        .iter()
        .filter(|u| u.alive && board.contains(u.pos) && in_area(u.pos))
        .filter(|u| match geom.ff_filter {
            FfFilter::Enemies => u.side != caster.side,
            FfFilter::AllButSelf => u.id != caster_id,
            FfFilter::All => true,
        })
        .collect();
    hit.sort_by_key(|u| (u.pos.y, u.pos.x, u.id));
    Ok(hit.into_iter().map(|u| u.id).collect())
}

/// Flank: `target` is Manhattan-adjacent to at least 2 living units of the
/// attacker's side. The attacker counts only when it is itself adjacent, so a
/// ranged attacker flanks when two allies pin the target. An unknown or dead
/// attacker never flanks.
#[must_use]
pub fn is_flanked(attacker_id: u32, target: Cell, units: &[BoardUnit]) -> bool {
    let Some(attacker) = units.iter().find(|u| u.alive && u.id == attacker_id) else {
        return false;
    };
    units
        .iter()
        .filter(|u| u.alive && u.side == attacker.side && is_adjacent(u.pos, target))
        .count()
        >= 2
}
