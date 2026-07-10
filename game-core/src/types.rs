//! Shared movement value types — the cross-boundary contract (server table cols,
//! the wasm/TS wire). They derive `serde` always (the wire round-trip) and
//! `SpacetimeType` ONLY under the `spacetimedb` feature: `server-module` enables
//! it, `client-wasm` must not (feature-isolation, ADR-0003).
//!
//! Positions are **integer tiles** (`i32`) — no floats in the rule, so the native
//! server path and the wasm client path cannot numerically diverge.

use serde::{Deserialize, Serialize};

/// Milliseconds since the unix epoch, injected at the boundary (round-trips
/// SpacetimeDB `ctx.timestamp`). `Ord` so the server can order stamps. `game-core`
/// never reads a clock — callers pass `now` in (the determinism contract).
// NOTE: no `SpacetimeType` derive — `Millis` is stored as a flat `i64` column
// (M2 flattens), and the derive panics on a newtype tuple struct in crate 1.12.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Millis(pub i64);

/// A cardinal facing/step direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum Direction {
    North,
    South,
    East,
    West,
}

/// An integer tile coordinate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct TilePos {
    pub x: i32,
    pub y: i32,
}

impl TilePos {
    /// One tile in `d`. **Saturating, never wrapping**: an extreme coord stays at
    /// the `i32` bound (an out-of-range tile, which `is_walkable` treats as a wall
    /// → bump), so `apply_move` is TOTAL over arbitrary state. `wrapping_add` would
    /// be a bug (it could teleport to a valid in-bounds tile). Screen coords:
    /// North decreases `y`.
    #[must_use]
    pub fn step(self, d: Direction) -> TilePos {
        match d {
            Direction::North => TilePos {
                x: self.x,
                y: self.y.saturating_sub(1),
            },
            Direction::South => TilePos {
                x: self.x,
                y: self.y.saturating_add(1),
            },
            Direction::East => TilePos {
                x: self.x.saturating_add(1),
                y: self.y,
            },
            Direction::West => TilePos {
                x: self.x.saturating_sub(1),
                y: self.y,
            },
        }
    }
}

/// What a character is currently doing (drives the M4 renderer's animation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum ActionState {
    Idle,
    Walking,
    Jumping,
}

/// A movement INTENT — the only thing that crosses the wire. There is **no
/// position-bearing variant**, so a client physically cannot assert "I am at
/// (x,y)"; only intent crosses, authority resolves position (illegal states
/// unrepresentable).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum MoveInput {
    Step(Direction),
    Jump,
}

/// A tile's kind. Grows with its milestone (`TallGrass` @ M8); the exhaustive
/// `match` will then compiler-flag every site (OCP-inverted, per principles).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum TileKind {
    Floor,
    Wall,
    /// Walkable floor that can trigger a wild encounter when stepped onto (M8).
    TallGrass,
}

impl TileKind {
    /// Authoring char → tile kind (parse-don't-validate; unknown chars fail loud
    /// at the call site).
    ///
    /// # Errors
    /// Returns `Err` for any char that is not a known tile glyph.
    pub fn from_char(c: char) -> Result<TileKind, String> {
        match c {
            '.' => Ok(TileKind::Floor),
            '#' => Ok(TileKind::Wall),
            '~' => Ok(TileKind::TallGrass),
            other => Err(format!("unknown tile char {other:?}")),
        }
    }

    #[must_use]
    pub fn is_walkable(self) -> bool {
        match self {
            TileKind::Floor | TileKind::TallGrass => true,
            TileKind::Wall => false,
        }
    }
}

/// A character's authoritative movement state. Zone-agnostic — the entity's
/// `zone_id` lives on the table (M2); `apply_move` works within the one `TileMap`
/// it is handed.
// No `SpacetimeType` derive — M2 FLATTENS `CharacterState` into table columns
// (tile_x/tile_y/facing/action/move_started_at_ms) via a thin convert seam, so it
// is never stored as one opaque column (and it holds `Millis`, which has none).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CharacterState {
    pub pos: TilePos,
    pub facing: Direction,
    pub action: ActionState,
    /// Stamped from `now` on every `apply_move` (move, bump, or hop) — bookkeeping/
    /// ordering for the renderer, NOT an interpolation clock; M3's reconciler never
    /// diffs it.
    pub move_started_at: Millis,
}

// --- Flat codes (for the wasm-boundary parity helper; total mappings) ---------

#[must_use]
pub fn dir_code(d: Direction) -> u8 {
    match d {
        Direction::North => 0,
        Direction::South => 1,
        Direction::East => 2,
        Direction::West => 3,
    }
}

#[must_use]
pub fn dir_from_code(c: u8) -> Option<Direction> {
    match c {
        0 => Some(Direction::North),
        1 => Some(Direction::South),
        2 => Some(Direction::East),
        3 => Some(Direction::West),
        _ => None,
    }
}

#[must_use]
pub fn action_code(a: ActionState) -> u8 {
    match a {
        ActionState::Idle => 0,
        ActionState::Walking => 1,
        ActionState::Jumping => 2,
    }
}

#[must_use]
pub fn action_from_code(c: u8) -> Option<ActionState> {
    match c {
        0 => Some(ActionState::Idle),
        1 => Some(ActionState::Walking),
        2 => Some(ActionState::Jumping),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{Direction, TileKind, TilePos};
    use proptest::prelude::*;

    #[test]
    fn step_moves_one_tile_each_direction() {
        let p = TilePos { x: 5, y: 5 };
        assert_eq!(p.step(Direction::North), TilePos { x: 5, y: 4 });
        assert_eq!(p.step(Direction::South), TilePos { x: 5, y: 6 });
        assert_eq!(p.step(Direction::East), TilePos { x: 6, y: 5 });
        assert_eq!(p.step(Direction::West), TilePos { x: 4, y: 5 });
    }

    #[test]
    fn step_saturates_at_i32_bounds_never_wraps() {
        let hi = TilePos {
            x: i32::MAX,
            y: i32::MAX,
        };
        assert_eq!(hi.step(Direction::East), hi); // saturates, no wrap/panic
        assert_eq!(hi.step(Direction::South), hi);
        let lo = TilePos {
            x: i32::MIN,
            y: i32::MIN,
        };
        assert_eq!(lo.step(Direction::West), lo);
        assert_eq!(lo.step(Direction::North), lo);
    }

    #[test]
    fn tile_kind_from_char_rejects_unknown() {
        assert!(TileKind::from_char('X').is_err());
        assert_eq!(TileKind::from_char('.'), Ok(TileKind::Floor));
        assert!(!TileKind::from_char('#').unwrap().is_walkable());
    }

    proptest! {
        // Serde round-trip identity — the wire contract the WASM/TS + STDB
        // boundaries depend on (using RON as a serde format proxy).
        #[test]
        fn tilepos_serde_round_trips(x in any::<i32>(), y in any::<i32>()) {
            let p = TilePos { x, y };
            let s = ron::to_string(&p).unwrap();
            let back: TilePos = ron::from_str(&s).unwrap();
            prop_assert_eq!(p, back);
        }

        // step never changes a coordinate by more than one (saturation included).
        #[test]
        fn step_distance_at_most_one(x in any::<i32>(), y in any::<i32>(), d in 0u8..4) {
            let dir = super::dir_from_code(d).expect("d in 0..4 is a valid dir code");
            let p = TilePos { x, y };
            let q = p.step(dir);
            prop_assert!((i64::from(q.x) - i64::from(p.x)).abs() <= 1);
            prop_assert!((i64::from(q.y) - i64::from(p.y)).abs() <= 1);
        }
    }

    // -----------------------------------------------------------------------
    // Nightly mutation hardening: the flat codes are a total, exact mapping.
    // -----------------------------------------------------------------------

    /// Kills: `dir_code`/`action_code` constant-replacement mutants and every
    /// deleted `dir_from_code`/`action_from_code` match arm (9 survivors).
    #[test]
    fn flat_codes_are_exact_and_roundtrip() {
        use super::{
            action_code, action_from_code, dir_code, dir_from_code, ActionState, Direction,
        };
        assert_eq!(dir_code(Direction::North), 0);
        assert_eq!(dir_code(Direction::South), 1);
        assert_eq!(dir_code(Direction::East), 2);
        assert_eq!(dir_code(Direction::West), 3);
        for d in [
            Direction::North,
            Direction::South,
            Direction::East,
            Direction::West,
        ] {
            assert_eq!(
                dir_from_code(dir_code(d)).expect("dir_code output is a valid code"),
                d
            );
        }
        assert_eq!(action_code(ActionState::Idle), 0);
        assert_eq!(action_code(ActionState::Walking), 1);
        assert_eq!(action_code(ActionState::Jumping), 2);
        for a in [
            ActionState::Idle,
            ActionState::Walking,
            ActionState::Jumping,
        ] {
            assert_eq!(
                action_from_code(action_code(a)).expect("action_code output is a valid code"),
                a
            );
        }
    }

    /// Proof-of-teeth: invalid codes return None (kills any impl that keeps the
    /// silent default coercion).
    #[test]
    fn dir_from_code_rejects_invalid_codes() {
        use super::{dir_from_code, Direction};
        assert_eq!(dir_from_code(4), None, "code 4 is out of range");
        assert_eq!(dir_from_code(255), None, "code 255 is out of range");
        // Valid boundary
        assert_eq!(dir_from_code(0), Some(Direction::North));
        assert_eq!(dir_from_code(3), Some(Direction::West));
    }

    #[test]
    fn action_from_code_rejects_invalid_codes() {
        use super::{action_from_code, ActionState};
        assert_eq!(action_from_code(3), None, "code 3 is out of range");
        assert_eq!(action_from_code(255), None, "code 255 is out of range");
        // Valid boundary
        assert_eq!(action_from_code(0), Some(ActionState::Idle));
        assert_eq!(action_from_code(2), Some(ActionState::Jumping));
    }
}
