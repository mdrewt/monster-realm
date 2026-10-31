//! Battle maps — design §3.2. SKELETON (bt-1 red phase): types are final, bodies are not.

use serde::{Deserialize, Serialize};

use super::geometry::{Cell, Side};
use super::movement::Terrain;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TileDef {
    pub terrain: Terrain,
    #[serde(default)]
    pub elevation: u8,
    #[serde(default)]
    pub blocks_los: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BattleMapDef {
    pub width: u8,
    pub height: u8,
    pub tiles: Vec<TileDef>,
    pub spawn_a: Vec<Cell>,
    pub spawn_b: Vec<Cell>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MapError {
    Parse(String),
    Width(u8),
    Height(u8),
    TileCount { expected: usize, got: usize },
    SpawnCount { side: Side, got: usize },
    SpawnOutOfBounds(Cell),
    SpawnOverlap(Cell),
    SpawnNotWalkable(Cell),
    MinOpposingDistance { min: u16, got: u16 },
    MaxOpposingDistance { max: u16, got: u16 },
    Disconnected,
}

/// # Errors
/// The first violated rule, as a [`MapError`].
pub fn validate_battle_map(_def: &BattleMapDef) -> Result<(), MapError> {
    todo!("bt-1")
}

/// # Errors
/// [`MapError::Parse`] for malformed RON, else the first [`validate_battle_map`] violation.
pub fn parse_battle_map(_src: &str) -> Result<BattleMapDef, MapError> {
    todo!("bt-1")
}
