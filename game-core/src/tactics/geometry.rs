//! Geometry — design §3.1. SKELETON (bt-1 red phase): types are final, bodies are not.

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

#[must_use]
pub fn manhattan(_a: Cell, _b: Cell) -> u16 {
    todo!("bt-1")
}

#[must_use]
pub fn is_adjacent(_a: Cell, _b: Cell) -> bool {
    todo!("bt-1")
}

#[must_use]
pub fn line_of_sight(_blocks_los: &[bool], _width: u8, _from: Cell, _to: Cell) -> bool {
    todo!("bt-1")
}

/// # Errors
/// See [`GeometryError`].
pub fn target_set(
    _geom: &SkillGeometry,
    _caster_id: u32,
    _aim: Cell,
    _board: &Board,
) -> Result<Vec<u32>, GeometryError> {
    todo!("bt-1")
}

#[must_use]
pub fn is_flanked(_attacker_id: u32, _target: Cell, _units: &[BoardUnit]) -> bool {
    todo!("bt-1")
}
