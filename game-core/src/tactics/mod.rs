//! Tactical battles (M-battle-tactics) — the grid rules, written once.
//!
//! The server validator, the client highlighter and forecast (via `client-wasm`) and
//! the wild AI all call these same functions; re-implementing one elsewhere is the
//! desync bug. Every rule is integer-only and iterates in an explicit order (no
//! hash-map iteration), so native and wasm agree byte-for-byte — `golden` holds the
//! shared fixture harness that proves it.
//!
//! - `geometry` — Manhattan metric, line of sight, the skill target set, flank.
//! - `movement` — stride bands, terrain × class weights, Dijkstra pathing, disengage.
//! - `map`      — the battle-map RON schema and its validator.
//! - `golden`   — the native = wasm golden-fixture runner.

pub mod geometry;
#[cfg(test)]
mod geometry_tests;
pub mod golden;
#[cfg(test)]
mod golden_tests;
pub mod map;
#[cfg(test)]
mod map_tests;
pub mod movement;
#[cfg(test)]
mod movement_tests;

pub use geometry::{
    is_adjacent, is_flanked, line_of_sight, manhattan, target_set, Board, BoardUnit, Cell,
    FfFilter, GeometryError, Origin, Shape, Side, SkillGeometry,
};
pub use golden::{run_golden, GoldenBoard, GoldenCase, GoldenResult};
pub use map::{parse_battle_map, validate_battle_map, BattleMapDef, MapError, TileDef};
pub use movement::{
    disengage_taxed, find_path, stride_for_base_speed, terrain_weight, MoveClass, Path, PathError,
    Terrain,
};
