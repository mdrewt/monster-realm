//! The movement world: a zone-tagged `TileMap` and the SOLE movement rule
//! `apply_move` — total, pure, deterministic, integer-tile. The server (M2) and
//! the client predictor (M3) both call THIS function, so prediction can never
//! numerically diverge from authority (ADR-0003 SSOT).

use crate::types::{
    action_code, action_from_code, dir_code, dir_from_code, ActionState, CharacterState, Millis,
    MoveInput, TileKind, TilePos,
};

/// Step duration / server tick cadence: one tile per `STEP_MS` ms. Defined ONCE
/// here; the M2 tick/queue consume it.
pub const STEP_MS: i64 = 200;

/// Bounded move-buffer cap (M2 anti-flood; the tick cadence is the real limit).
pub const MOVE_QUEUE_CAP: usize = 2;

/// Party size (slots 0..PARTY_SIZE) — single-sourced; the client + server consume it.
pub const PARTY_SIZE: u8 = 6;

/// The party-slot sentinel meaning "boxed" (not in the party).
pub const PARTY_SLOT_NONE: u8 = 255;

/// The single M1 zone's hand-authored art (`zone_id = 0`). A `const`-style source
/// until M11 swaps in the Tiled→RON pipeline (ADR-0008); the swap is localized to
/// `zone_0`.
// `~` = tall grass (walkable floor that can trigger a wild encounter, M8). Grass
// is placed only on interior `.` tiles NOT asserted plain by the world/zone_0
// tests: avoid spawn (1,1), (2,1), (3,3), (4,3), (1,0).
const ZONE_0_ROWS: &[&str] = &[
    "##########",
    "#........#",
    "#.~~....~#",
    "#...##..~#",
    "#..~~...~#",
    "#......~~#",
    "##########",
];

/// A zone-tagged, bounds-safe walkability grid (row-major).
///
/// `Serialize` is one-way only (no `Deserialize`): the M3 `client-wasm`
/// `zone_map()` export hands the renderer the SAME map the rule evaluates
/// (visual-SSOT — a hard-coded TS map would visually desync). It is **not**
/// deserialized back, so the `from_rows` parse-don't-validate constructor stays
/// the sole way to build an invariant-holding `TileMap`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TileMap {
    pub zone_id: u32,
    pub width: i32,
    pub height: i32,
    walkable: Vec<bool>,
    /// Parallel, row-major, SAME length as `walkable` — `true` where the tile is
    /// `TallGrass` (M8). Rides the one-way `Serialize` so the TS renderer's grass
    /// overlay reads the SAME layer the rule evaluates (visual-SSOT).
    grass: Vec<bool>,
}

impl TileMap {
    /// Build a map from string-art rows (`'.'` floor, `'#'` wall). Fails LOUD at
    /// the single offending site on ragged rows or an unknown tile char
    /// (parse-don't-validate, not a silent default).
    ///
    /// # Errors
    /// Returns `Err` if rows are ragged or contain an unknown tile glyph.
    pub fn from_rows(zone_id: u32, rows: &[&str]) -> Result<TileMap, String> {
        let height = i32::try_from(rows.len()).map_err(|_| "map too tall".to_string())?;
        let width = i32::try_from(rows.first().map_or(0, |r| r.chars().count()))
            .map_err(|_| "map too wide".to_string())?;
        let mut walkable = Vec::with_capacity((width * height).max(0) as usize);
        let mut grass = Vec::with_capacity((width * height).max(0) as usize);
        for (y, row) in rows.iter().enumerate() {
            let row_len = i32::try_from(row.chars().count()).unwrap_or(i32::MAX);
            if row_len != width {
                return Err(format!(
                    "ragged map: row {y} has width {row_len}, expected {width}"
                ));
            }
            for (x, c) in row.chars().enumerate() {
                let kind = TileKind::from_char(c).map_err(|e| format!("{e} at ({x},{y})"))?;
                walkable.push(kind.is_walkable());
                grass.push(matches!(kind, TileKind::TallGrass));
            }
        }
        Ok(TileMap {
            zone_id,
            width,
            height,
            walkable,
            grass,
        })
    }

    #[must_use]
    pub fn in_bounds(&self, p: TilePos) -> bool {
        p.x >= 0 && p.y >= 0 && p.x < self.width && p.y < self.height
    }

    /// An out-of-range tile is a WALL, never a panic (bounds-safe `get`).
    #[must_use]
    pub fn is_walkable(&self, p: TilePos) -> bool {
        if !self.in_bounds(p) {
            return false;
        }
        let idx = p.y as usize * self.width as usize + p.x as usize;
        self.walkable.get(idx).copied().unwrap_or(false)
    }

    /// `true` iff `p` is a tall-grass tile. Out-of-range → `false`, never a panic
    /// (mirrors `is_walkable`).
    #[must_use]
    pub fn is_grass(&self, p: TilePos) -> bool {
        if !self.in_bounds(p) {
            return false;
        }
        let idx = p.y as usize * self.width as usize + p.x as usize;
        self.grass.get(idx).copied().unwrap_or(false)
    }
}

/// Pure trigger geometry: a character "stepped onto grass" iff its position
/// actually CHANGED and the new tile is grass. Fires on floor→grass, grass→grass
/// (entering a NEW grass tile), and a jump that MOVES onto grass; never on a bump,
/// standstill, or blocked move (all of which leave `prev == next`).
#[must_use]
pub fn stepped_onto_grass(prev: TilePos, next: TilePos, map: &TileMap) -> bool {
    prev != next && map.is_grass(next)
}

/// The single M1 zone (`zone_id = 0`). Its art is a compile-time invariant.
#[must_use]
pub fn zone_0() -> TileMap {
    TileMap::from_rows(0, ZONE_0_ROWS).expect("zone_0 art is valid")
}

/// The authoritative, guaranteed-walkable spawn for `zone_0` (one source of truth
/// for the server + tests; never hard-coded elsewhere).
#[must_use]
pub fn spawn() -> TilePos {
    TilePos { x: 1, y: 1 }
}

/// The SOLE movement rule — total, pure, deterministic. A bump (blocked step) or a
/// blocked jump is a legal no-op, never an `Err`. `move_started_at` is stamped on
/// EVERY call.
#[must_use]
pub fn apply_move(
    state: &CharacterState,
    input: MoveInput,
    map: &TileMap,
    now: Millis,
) -> CharacterState {
    let mut next = *state;
    next.move_started_at = now;
    match input {
        MoveInput::Step(dir) => {
            next.facing = dir; // you always turn to face, even into a wall
            let target = state.pos.step(dir);
            if map.is_walkable(target) {
                next.pos = target;
                next.action = ActionState::Walking;
            } else {
                next.action = ActionState::Idle; // bump: a legal no-op
            }
        }
        MoveInput::Jump => {
            next.action = ActionState::Jumping;
            let target = state.pos.step(state.facing); // facing unchanged
            if map.is_walkable(target) {
                next.pos = target;
            }
            // blocked jump = hop in place
        }
    }
    // Invariant: an in-bounds character stays in-bounds (vacuous for an already
    // out-of-bounds state — apply_move must remain total over arbitrary input).
    debug_assert!(
        !map.in_bounds(state.pos) || map.in_bounds(next.pos),
        "apply_move must keep an in-bounds character in-bounds"
    );
    next
}

/// Flat-code parity helper over `zone_0()`: shared by the native bin and the wasm
/// export so the movement-parity eval compares the SAME `apply_move` compiled for
/// two targets, not two encodings. Returns `[x, y, facing_code, action_code]`.
#[must_use]
#[allow(clippy::too_many_arguments)]
pub fn apply_move_coded(
    x: i32,
    y: i32,
    facing: u8,
    action: u8,
    started_ms: i64,
    input_kind: u8,
    step_dir: u8,
    now_ms: i64,
) -> [i32; 4] {
    let state = CharacterState {
        pos: TilePos { x, y },
        facing: dir_from_code(facing),
        action: action_from_code(action),
        move_started_at: Millis(started_ms),
    };
    let input = if input_kind == 0 {
        MoveInput::Step(dir_from_code(step_dir))
    } else {
        MoveInput::Jump
    };
    let out = apply_move(&state, input, &zone_0(), Millis(now_ms));
    [
        out.pos.x,
        out.pos.y,
        i32::from(dir_code(out.facing)),
        i32::from(action_code(out.action)),
    ]
}

#[cfg(test)]
mod tests {
    use super::{apply_move, spawn, zone_0, TileMap, MOVE_QUEUE_CAP, STEP_MS};
    use crate::types::{ActionState, CharacterState, Direction, Millis, MoveInput, TilePos};
    use proptest::prelude::*;

    fn at(x: i32, y: i32, facing: Direction) -> CharacterState {
        CharacterState {
            pos: TilePos { x, y },
            facing,
            action: ActionState::Idle,
            move_started_at: Millis(0),
        }
    }

    #[test]
    fn from_rows_rejects_ragged() {
        assert!(TileMap::from_rows(0, &["...", ".."]).is_err());
    }

    #[test]
    fn from_rows_rejects_unknown_char() {
        assert!(TileMap::from_rows(0, &["..X"]).is_err());
    }

    #[test]
    fn spawn_is_walkable_in_zone_0() {
        assert!(zone_0().is_walkable(spawn()));
    }

    #[test]
    fn out_of_bounds_is_a_wall_not_a_panic() {
        let m = zone_0();
        assert!(!m.is_walkable(TilePos { x: -1, y: 0 }));
        assert!(!m.is_walkable(TilePos {
            x: i32::MAX,
            y: i32::MAX
        }));
        assert!(!m.in_bounds(TilePos { x: 1000, y: 1000 }));
    }

    #[test]
    fn step_into_floor_moves_and_faces() {
        let m = zone_0();
        let s = at(1, 1, Direction::North);
        let r = apply_move(&s, MoveInput::Step(Direction::East), &m, Millis(STEP_MS));
        assert_eq!(r.pos, TilePos { x: 2, y: 1 });
        assert_eq!(r.facing, Direction::East);
        assert_eq!(r.action, ActionState::Walking);
        assert_eq!(r.move_started_at, Millis(STEP_MS));
    }

    #[test]
    fn step_into_wall_bumps_but_still_faces() {
        let m = zone_0();
        let s = at(1, 1, Direction::East);
        let r = apply_move(&s, MoveInput::Step(Direction::North), &m, Millis(7)); // (1,0) is border wall
        assert_eq!(r.pos, TilePos { x: 1, y: 1 }); // unchanged
        assert_eq!(r.facing, Direction::North); // still turned
        assert_eq!(r.action, ActionState::Idle);
        assert_eq!(r.move_started_at, Millis(7)); // stamped on a bump too
    }

    #[test]
    fn jump_into_floor_moves_keeps_facing() {
        let m = zone_0();
        let s = at(1, 1, Direction::East);
        let r = apply_move(&s, MoveInput::Jump, &m, Millis(5));
        assert_eq!(r.pos, TilePos { x: 2, y: 1 });
        assert_eq!(r.facing, Direction::East); // unchanged
        assert_eq!(r.action, ActionState::Jumping);
    }

    #[test]
    fn jump_into_wall_hops_in_place() {
        let m = zone_0();
        let s = at(3, 3, Direction::East); // (4,3) is the inner wall
        let r = apply_move(&s, MoveInput::Jump, &m, Millis(9));
        assert_eq!(r.pos, TilePos { x: 3, y: 3 }); // unchanged
        assert_eq!(r.action, ActionState::Jumping);
        assert_eq!(r.facing, Direction::East);
    }

    #[test]
    fn constants_are_the_single_source() {
        assert_eq!(STEP_MS, 200);
        assert_eq!(MOVE_QUEUE_CAP, 2);
    }

    proptest! {
        // Totality + determinism over arbitrary states (incl. extreme coords).
        #[test]
        fn apply_move_is_total_and_deterministic(
            x in any::<i32>(), y in any::<i32>(), f in 0u8..4, ik in 0u8..2, sd in 0u8..4, now in any::<i64>(),
        ) {
            let m = zone_0();
            let s = CharacterState {
                pos: TilePos { x, y },
                facing: crate::types::dir_from_code(f),
                action: ActionState::Idle,
                move_started_at: Millis(0),
            };
            let input = if ik == 0 { MoveInput::Step(crate::types::dir_from_code(sd)) } else { MoveInput::Jump };
            let a = apply_move(&s, input, &m, Millis(now));
            let b = apply_move(&s, input, &m, Millis(now));
            prop_assert_eq!(a, b); // determinism
            prop_assert_eq!(a.move_started_at, Millis(now)); // stamped every call
            // pos changes by at most one tile (Manhattan), saturation included
            prop_assert!((i64::from(a.pos.x) - i64::from(x)).abs() + (i64::from(a.pos.y) - i64::from(y)).abs() <= 1);
        }

        // In-bounds is preserved for a valid (in-bounds) starting character, and a
        // successful Step ends adjacent + walkable; a bump keeps pos.
        #[test]
        fn step_invariants_from_in_bounds(
            x in 0i32..10, y in 0i32..7, sd in 0u8..4, now in any::<i64>(),
        ) {
            let m = zone_0();
            let start = TilePos { x, y };
            prop_assume!(m.in_bounds(start));
            let s = CharacterState {
                pos: start, facing: Direction::South, action: ActionState::Idle, move_started_at: Millis(0),
            };
            let dir = crate::types::dir_from_code(sd);
            let r = apply_move(&s, MoveInput::Step(dir), &m, Millis(now));
            prop_assert_eq!(r.facing, dir); // always face the input dir
            if r.pos == start {
                prop_assert_eq!(r.action, ActionState::Idle); // bump
            } else {
                prop_assert_eq!(r.pos, start.step(dir)); // moved exactly one step
                prop_assert!(m.is_walkable(r.pos)); // onto a walkable tile
                prop_assert_eq!(r.action, ActionState::Walking);
            }
            prop_assert!(m.in_bounds(r.pos)); // in-bounds preserved
        }
    }
}
