//! NPC wander decision rules — pure & deterministic (ADR-0003, ADR-0068).
//!
//! `npc_decide` is the only public entry point. It takes explicit `npc_id` and
//! `tick` inputs and mixes them with a non-commutative hash (RT-NPC-01 fix) so
//! that two NPCs with the same `npc_id + tick` sum produce different outputs.
//!
//! Wall-collision is NOT handled here; `apply_move` handles bumps.

use crate::types::{Direction, TilePos};

/// Non-commutative salt for NPC wander decisions.
const NPC_DECIDE_SALT: u64 = 0xDEAD_BEEF_CAFE_1234;

/// Two-input, non-commutative hash for NPC wander.
///
/// RT-NPC-01 fix: `npc_id` is multiplied by a large odd constant *before*
/// adding `tick`, so `npc_hash(a, b) != npc_hash(b, a)` for a != b.
/// Downstream splitmix64 avalanche ensures high-quality output bits.
fn npc_hash(npc_id: u64, tick: u64) -> u64 {
    // Non-commutative: npc_id is multiplied first, then tick is added.
    // npc_id.wrapping_mul(K) + tick  !=  tick.wrapping_mul(K) + npc_id  (K != 1)
    let z = npc_id
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(tick)
        .wrapping_add(NPC_DECIDE_SALT);
    // splitmix64 finalization avalanche
    let z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    let z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Manhattan (L1) distance between two tile positions.
///
/// Uses `i64` arithmetic to avoid overflow when coordinates span the full
/// `i32` range (proptest generates extreme values; `i32::MAX - i32::MIN`
/// overflows `i32` but fits `i64`).
fn manhattan_distance(a: TilePos, b: TilePos) -> i64 {
    let dx = (i64::from(a.x) - i64::from(b.x)).abs();
    let dy = (i64::from(a.y) - i64::from(b.y)).abs();
    dx + dy
}

/// Deterministic toward-home direction using dominant axis, X-axis tiebreak.
///
/// If `|dx| >= |dy|`, move along X (X wins on tie); otherwise move along Y.
/// Uses `i64` arithmetic to avoid overflow on extreme coordinates.
fn toward_home(current: TilePos, home: TilePos) -> Direction {
    let dx = i64::from(home.x) - i64::from(current.x);
    let dy = i64::from(home.y) - i64::from(current.y);

    if dx.abs() >= dy.abs() {
        // X-axis dominant (or tied — X wins)
        if dx > 0 {
            Direction::East
        } else {
            Direction::West
        }
    } else {
        // Y-axis dominant
        // Screen coords: North = decreasing y, South = increasing y
        if dy > 0 {
            Direction::South
        } else {
            Direction::North
        }
    }
}

/// Seeded NPC wander decision.
///
/// Returns `None` (stay) or `Some(direction)` to move.
///
/// # Logic
/// 1. Compute `h = npc_hash(npc_id, tick)`.
/// 2. If `manhattan_distance(current, home) <= wander_radius` → wander path:
///    - If `h % 5 == 0` → stay (`None`), 1-in-5 probability.
///    - Otherwise → random direction from `h`.
/// 3. Otherwise (outside radius) → `toward_home(current, home)` (deterministic,
///    no hash, no stay chance — an NPC outside its radius always moves home).
#[must_use]
pub fn npc_decide(
    current: TilePos,
    home: TilePos,
    wander_radius: u8,
    npc_id: u64,
    tick: u64,
) -> Option<Direction> {
    let dist = manhattan_distance(current, home);

    if dist <= i64::from(wander_radius) {
        // Within (or at) radius → wander path
        // Special case: radius=0 means "pinned to home" — always stay when AT home.
        if wander_radius == 0 {
            return None;
        }
        let h = npc_hash(npc_id, tick);
        if h.is_multiple_of(5) {
            // 1-in-5 stay probability
            return None;
        }
        // Random direction from hash
        let dir = match (h >> 1) % 4 {
            0 => Direction::North,
            1 => Direction::South,
            2 => Direction::East,
            _ => Direction::West,
        };
        Some(dir)
    } else {
        // Outside radius → deterministic toward-home (no hash, no stay)
        Some(toward_home(current, home))
    }
}

// ===========================================================================
// fix-nightly (ADR-0088): in-file tests for the PRIVATE `toward_home` fn.
//
// `toward_home` is module-private, so the sibling `m12a_gating_tests` module
// cannot call it directly. `npc_decide` never routes `current == home` to
// `toward_home` (distance 0 <= any radius → wander path), so an npc_decide-shaped
// test CANNOT reach the `dx == 0` case that discriminates census 53:15. This
// in-file `mod tests { use super::*; }` is the only seam that kills it.
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;

    /// kills: game-core/src/npc/rules.rs:53:15: replace > with >= in toward_home
    ///
    /// `toward_home(home, home)` has dx == 0 and dy == 0. `|dx| >= |dy|` (0 >= 0)
    /// takes the X branch; the real `dx > 0` is false → West. The `>`→`>=` flip
    /// makes `0 >= 0` true → East. Pinning West kills the flip.
    ///
    /// (Sibling 61:15 on the Y branch is provably equivalent — the Y branch
    /// requires |dx| < |dy| → dy != 0, so `dy > 0` and `dy >= 0` are
    /// indistinguishable — and is excluded via .cargo/mutants.toml, not tested.)
    #[test]
    fn toward_home_at_home_returns_west() {
        let home = TilePos { x: 5, y: 5 };
        assert_eq!(
            toward_home(home, home),
            Direction::West,
            "toward_home(home, home): dx==0 takes the X branch, `dx > 0` is false → \
             West. A `>`→`>=` flip (0 >= 0 true) would wrongly return East."
        );
    }

    /// kills: game-core/src/npc/rules.rs:103:13: delete match arm 0 in npc_decide
    /// kills: game-core/src/npc/rules.rs:105:13: delete match arm 2 in npc_decide
    ///
    /// Scans (npc_id, tick) within-radius inputs to verify that both North (arm 0,
    /// `(h >> 1) % 4 == 0`) and East (arm 2, `(h >> 1) % 4 == 2`) are reachable
    /// npc_decide outputs.
    ///
    /// If arm 0 is deleted, hash%4==0 falls to `_` → West; North never appears in
    /// the scan and `assert!(saw_north)` fails. If arm 2 is deleted, East falls to
    /// `_` → West; `assert!(saw_east)` fails.
    ///
    /// Setup: home == current (dist=0 ≤ wander_radius=10) → wander path, not
    /// toward-home. wander_radius != 0 → not pinned-stay → we reach the hash+match.
    #[test]
    fn npc_decide_arms_north_and_east_are_reachable() {
        let home = TilePos { x: 5, y: 5 };
        let wander_radius = 10u8;
        let mut saw_north = false;
        let mut saw_east = false;
        'outer: for npc_id in 1u64..=100 {
            for tick in 0u64..=100 {
                match npc_decide(home, home, wander_radius, npc_id, tick) {
                    Some(Direction::North) => saw_north = true,
                    Some(Direction::East) => saw_east = true,
                    _ => {}
                }
                if saw_north && saw_east {
                    break 'outer;
                }
            }
        }
        assert!(
            saw_north,
            "npc_decide must produce North from some (npc_id, tick) within wander range; \
             deleting match arm 0 routes hash%4==0 inputs to West instead"
        );
        assert!(
            saw_east,
            "npc_decide must produce East from some (npc_id, tick) within wander range; \
             deleting match arm 2 routes hash%4==2 inputs to West instead"
        );
    }
}
