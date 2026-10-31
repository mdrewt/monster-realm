//! Movement — design §2.1: stride bands, terrain × class weights, pathing, disengage.
//!
//! Pathing is Dijkstra over the 4-neighbourhood with a binary heap keyed on the
//! explicit tuple `(cost, y, x)` and strict-`<` relaxation — no hash-map iteration,
//! so native and wasm produce the same path. Closed form of the tie-break: the
//! predecessor of a tile `v` is the neighbour `u` minimising `(dist[u], u.y, u.x)`
//! among those with `dist[u] + weight(v) == dist[v]`. This is a backward rule (each
//! tile picks its lowest predecessor), not a forward-lexicographic path order.
//!
//! Occupancy: a unit may pass through living allies but never end on one, and never
//! enters a living enemy's tile.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use serde::{Deserialize, Serialize};

use super::geometry::{is_adjacent, Board, BoardUnit, Cell};

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

/// Stride (stride points per Move stride) from the species BASE speed — never the
/// levelled stat: ≤ 49 → 2, 50–89 → 3, ≥ 90 → 4.
#[must_use]
pub fn stride_for_base_speed(base_speed: u16) -> u8 {
    match base_speed {
        0..=49 => 2,
        50..=89 => 3,
        _ => 4,
    }
}

/// Stride points to enter a tile of `terrain`; `None` = impassable (design §2.1).
#[must_use]
pub fn terrain_weight(class: MoveClass, terrain: Terrain) -> Option<u8> {
    match (class, terrain) {
        (_, Terrain::Blocked) | (MoveClass::Walk | MoveClass::Nimble, Terrain::Water) => None,
        (MoveClass::Walk | MoveClass::Swim, Terrain::Rough) => Some(2),
        (_, Terrain::Plain | Terrain::Rough | Terrain::Water) => Some(1),
    }
}

fn index(board: &Board, c: Cell) -> usize {
    usize::from(c.y) * usize::from(board.width) + usize::from(c.x)
}

/// The weight for `mover` to enter `c`, or `None` when it may not stand on or
/// pass through it (off-board, impassable terrain, a living enemy).
fn enter_weight(board: &Board, mover: &BoardUnit, c: Cell) -> Option<u16> {
    if !board.contains(c) {
        return None;
    }
    let enemy_there = board
        .units
        .iter()
        .any(|u| u.alive && u.id != mover.id && u.side != mover.side && u.pos == c);
    if enemy_there {
        return None;
    }
    let terrain = *board.terrain.get(index(board, c))?;
    terrain_weight(mover.class, terrain).map(u16::from)
}

fn neighbours(c: Cell) -> impl Iterator<Item = Cell> {
    let up = c.y.checked_sub(1).map(|y| Cell { x: c.x, y });
    let left = c.x.checked_sub(1).map(|x| Cell { x, y: c.y });
    let right = c.x.checked_add(1).map(|x| Cell { x, y: c.y });
    let down = c.y.checked_add(1).map(|y| Cell { x: c.x, y });
    [up, left, right, down].into_iter().flatten()
}

/// Single-source Dijkstra: per-tile `(dist, pred)` in row-major order.
fn dijkstra(board: &Board, mover: &BoardUnit, start: Cell) -> Vec<Option<(u16, Option<Cell>)>> {
    let mut best: Vec<Option<(u16, Option<Cell>)>> =
        vec![None; usize::from(board.width) * usize::from(board.height)];
    let mut heap = BinaryHeap::new();
    best[index(board, start)] = Some((0, None));
    heap.push(Reverse((0u16, start.y, start.x)));
    while let Some(Reverse((cost, y, x))) = heap.pop() {
        let here = Cell { x, y };
        if best[index(board, here)].is_some_and(|(d, _)| d < cost) {
            continue;
        }
        for next in neighbours(here) {
            let Some(w) = enter_weight(board, mover, next) else {
                continue;
            };
            let candidate = cost + w;
            let slot = &mut best[index(board, next)];
            if slot.is_none_or(|(d, _)| candidate < d) {
                *slot = Some((candidate, Some(here)));
                heap.push(Reverse((candidate, next.y, next.x)));
            }
        }
    }
    best
}

/// The cheapest path for `mover_id` from `start` to `dest` (tie-break: module doc).
/// `steps` exclude `start` and end at `dest`; `cost` is the summed entry weight.
/// No stride budget is applied here — the caller checks `cost` against it.
///
/// # Errors
/// In order: `UnknownMover` (no living unit with the id), `OutOfBounds` (start or
/// dest), `SameTile`, `DestImpassable`, `DestOccupied` (any other living unit on
/// dest), `Unreachable`.
pub fn find_path(board: &Board, mover_id: u32, start: Cell, dest: Cell) -> Result<Path, PathError> {
    let mover = board
        .living(mover_id)
        .ok_or(PathError::UnknownMover(mover_id))?;
    if !board.contains(start) || !board.contains(dest) {
        return Err(PathError::OutOfBounds);
    }
    if start == dest {
        return Err(PathError::SameTile);
    }
    let passable = board
        .terrain
        .get(index(board, dest))
        .and_then(|t| terrain_weight(mover.class, *t));
    if passable.is_none() {
        return Err(PathError::DestImpassable);
    }
    if board
        .units
        .iter()
        .any(|u| u.alive && u.id != mover_id && u.pos == dest)
    {
        return Err(PathError::DestOccupied);
    }
    let best = dijkstra(board, mover, start);
    let Some((cost, _)) = best[index(board, dest)] else {
        return Err(PathError::Unreachable);
    };
    let mut steps = vec![dest];
    let mut at = dest;
    while let Some((_, Some(prev))) = best[index(board, at)] {
        if prev == start {
            break;
        }
        steps.push(prev);
        at = prev;
    }
    steps.reverse();
    Ok(Path { steps, cost })
}

/// Whether a Move entry starting at `start` pays the disengage tax (+1, once per
/// entry): a living enemy is Manhattan-adjacent to `start` and the mover is not
/// `Fly`-class.
///
/// # Errors
/// [`PathError::UnknownMover`] when no living unit has `mover_id` — an unknown mover
/// is refused, never silently waived.
pub fn disengage_taxed(board: &Board, mover_id: u32, start: Cell) -> Result<bool, PathError> {
    let mover = board
        .living(mover_id)
        .ok_or(PathError::UnknownMover(mover_id))?;
    if mover.class == MoveClass::Fly {
        return Ok(false);
    }
    Ok(board
        .units
        .iter()
        .any(|u| u.alive && u.side != mover.side && is_adjacent(u.pos, start)))
}
