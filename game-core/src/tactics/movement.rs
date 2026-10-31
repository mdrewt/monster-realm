//! Movement — design §2.1. SKELETON (bt-1 red phase): types are final, bodies are not.

use serde::{Deserialize, Serialize};

use super::geometry::{Board, Cell};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MoveClass {
    Walk,
    Nimble,
    Swim,
    Fly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Terrain {
    Plain,
    Rough,
    Water,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Path {
    pub steps: Vec<Cell>,
    pub cost: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PathError {
    UnknownMover(u32),
    OutOfBounds,
    SameTile,
    DestImpassable,
    DestOccupied,
    Unreachable,
}

#[must_use]
pub fn stride_for_base_speed(_base_speed: u16) -> u8 {
    todo!("bt-1")
}

#[must_use]
pub fn terrain_weight(_class: MoveClass, _terrain: Terrain) -> Option<u8> {
    todo!("bt-1")
}

/// # Errors
/// See [`PathError`].
pub fn find_path(
    _board: &Board,
    _mover_id: u32,
    _start: Cell,
    _dest: Cell,
) -> Result<Path, PathError> {
    todo!("bt-1")
}

/// # Errors
/// [`PathError::UnknownMover`] when no living unit has `mover_id`.
pub fn disengage_taxed(_board: &Board, _mover_id: u32, _start: Cell) -> Result<bool, PathError> {
    todo!("bt-1")
}
