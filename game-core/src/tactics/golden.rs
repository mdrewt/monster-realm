//! Golden harness — design §11 T1. SKELETON (bt-1 red phase): types are final, bodies are not.

use serde::{Deserialize, Serialize};

use super::geometry::{BoardUnit, Cell, GeometryError, SkillGeometry};
use super::movement::{MoveClass, Path, PathError, Terrain};

/// A compact board: `rows[y]` chars `.` Plain, `r` Rough, `w` Water, `#` Blocked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoldenBoard {
    pub rows: Vec<String>,
    pub units: Vec<BoardUnit>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GoldenCase {
    Distance {
        a: Cell,
        b: Cell,
    },
    Adjacent {
        a: Cell,
        b: Cell,
    },
    TargetSet {
        board: GoldenBoard,
        caster: u32,
        aim: Cell,
        geometry: SkillGeometry,
    },
    Flank {
        units: Vec<BoardUnit>,
        attacker: u32,
        target: Cell,
    },
    Los {
        board: GoldenBoard,
        from: Cell,
        to: Cell,
    },
    Stride {
        base_speed: u16,
    },
    Weight {
        class: MoveClass,
        terrain: Terrain,
    },
    Path {
        board: GoldenBoard,
        mover: u32,
        start: Cell,
        dest: Cell,
    },
    Disengage {
        board: GoldenBoard,
        mover: u32,
        start: Cell,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GoldenResult {
    Distance(u16),
    Adjacent(bool),
    TargetSet(Result<Vec<u32>, GeometryError>),
    Flank(bool),
    Los(bool),
    Stride(u8),
    Weight(Option<u8>),
    Path(Result<Path, PathError>),
    Disengage(Result<bool, PathError>),
    BadCase(String),
}

#[must_use]
pub fn run_golden(_cases: &[GoldenCase]) -> Vec<GoldenResult> {
    todo!("bt-1")
}
