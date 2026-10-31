//! Battle maps — design §3.2: the RON schema and its validator.
//!
//! A map is `width × height` (each 6..=8) row-major tiles plus three ordered spawn
//! slots per side. The validator rejects every violation with a typed error naming
//! the rule — it never clamps. `elevation` and `blocks_los` are defaulted and unread
//! in P1, so P3 terrain is additive.

use serde::{Deserialize, Serialize};

use super::geometry::{manhattan, Cell, Side};
use super::movement::{neighbours, terrain_weight, MoveClass, Terrain};

/// Map side bounds (both width and height).
const SIDE_RANGE: std::ops::RangeInclusive<u8> = 6..=8;
/// Spawn slots per side.
const SPAWN_SLOTS: usize = 3;
/// Max opposing spawn distance: 2 strides × max stride 4 + 3, so contact by round 2.
const MAX_OPPOSING: u16 = 11;

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

/// Minimum opposing-slot distance: 4 on 7×7, 5 on 8×8 (contact pacing). Sizes the
/// design does not name follow their larger side.
fn min_opposing(def: &BattleMapDef) -> u16 {
    if def.width.max(def.height) >= 8 {
        5
    } else {
        4
    }
}

/// Row-major tile index of `c`.
fn at(def: &BattleMapDef, c: Cell) -> usize {
    usize::from(c.y) * usize::from(def.width) + usize::from(c.x)
}

fn walkable(def: &BattleMapDef, c: Cell) -> bool {
    def.tiles
        .get(at(def, c))
        .is_some_and(|t| terrain_weight(MoveClass::Walk, t.terrain).is_some())
}

/// Every tile Walk-reachable from `from` (units ignored), row-major.
fn walk_component(def: &BattleMapDef, from: Cell) -> Vec<bool> {
    let mut seen = vec![false; def.tiles.len()];
    let mut stack = vec![from];
    seen[at(def, from)] = true;
    while let Some(c) = stack.pop() {
        for n in neighbours(c).filter(|n| n.x < def.width && n.y < def.height) {
            let i = at(def, n);
            if !seen[i] && walkable(def, n) {
                seen[i] = true;
                stack.push(n);
            }
        }
    }
    seen
}

/// Validate a parsed map. Rules, in order (the first violation is returned): width,
/// height, tile count, spawn count (side A then B), spawn in bounds, no shared spawn
/// tile, spawn Walk-passable, minimum then maximum distance over all 9 opposing
/// pairs, and all six spawns in one Walk-connected component.
///
/// # Errors
/// The first violated rule, as a [`MapError`].
pub fn validate_battle_map(def: &BattleMapDef) -> Result<(), MapError> {
    if !SIDE_RANGE.contains(&def.width) {
        return Err(MapError::Width(def.width));
    }
    if !SIDE_RANGE.contains(&def.height) {
        return Err(MapError::Height(def.height));
    }
    let expected = usize::from(def.width) * usize::from(def.height);
    if def.tiles.len() != expected {
        return Err(MapError::TileCount {
            expected,
            got: def.tiles.len(),
        });
    }
    for (side, slots) in [(Side::A, &def.spawn_a), (Side::B, &def.spawn_b)] {
        if slots.len() != SPAWN_SLOTS {
            return Err(MapError::SpawnCount {
                side,
                got: slots.len(),
            });
        }
    }
    let spawns: Vec<Cell> = def.spawn_a.iter().chain(&def.spawn_b).copied().collect();
    if let Some(&c) = spawns
        .iter()
        .find(|c| c.x >= def.width || c.y >= def.height)
    {
        return Err(MapError::SpawnOutOfBounds(c));
    }
    for (i, &c) in spawns.iter().enumerate() {
        if spawns[..i].contains(&c) {
            return Err(MapError::SpawnOverlap(c));
        }
    }
    if let Some(&c) = spawns.iter().find(|&&c| !walkable(def, c)) {
        return Err(MapError::SpawnNotWalkable(c));
    }
    let pairs: Vec<u16> = def
        .spawn_a
        .iter()
        .flat_map(|&a| def.spawn_b.iter().map(move |&b| manhattan(a, b)))
        .collect();
    let (nearest, farthest) = (
        pairs.iter().copied().min().unwrap_or(0),
        pairs.iter().copied().max().unwrap_or(0),
    );
    let min = min_opposing(def);
    if nearest < min {
        return Err(MapError::MinOpposingDistance { min, got: nearest });
    }
    if farthest > MAX_OPPOSING {
        return Err(MapError::MaxOpposingDistance {
            max: MAX_OPPOSING,
            got: farthest,
        });
    }
    let reach = walk_component(def, spawns[0]);
    if spawns.iter().any(|&c| !reach[at(def, c)]) {
        return Err(MapError::Disconnected);
    }
    Ok(())
}

/// Parse a battle map from RON and validate it.
///
/// # Errors
/// [`MapError::Parse`] for malformed RON (including an unknown field or an
/// out-of-`u8` size), else the first [`validate_battle_map`] violation.
pub fn parse_battle_map(src: &str) -> Result<BattleMapDef, MapError> {
    let def: BattleMapDef = ron::from_str(src).map_err(|e| MapError::Parse(e.to_string()))?;
    validate_battle_map(&def)?;
    Ok(def)
}
