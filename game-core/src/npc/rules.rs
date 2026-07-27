//! NPC wander decision rules — pure & deterministic (ADR-0003, ADR-0068).
//!
//! `npc_decide` is the only public entry point. It mixes explicit `npc_id` and
//! `tick` with a non-commutative hash (RT-NPC-01 fix) so that two NPCs with the
//! same `npc_id + tick` sum produce different outputs. ADR-0159 amends ADR-0068:
//! the WANDER branch now chooses only LEGAL steps (walkable + inside the radius)
//! so it never picks a wall; HOMING is unfiltered, `apply_move` still no-ops bumps.

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

/// Seeded NPC wander decision — collision- and radius-aware (ADR-0159 D2,
/// amending ADR-0068).
///
/// Returns `None` (stay) or `Some(direction)` to move.
///
/// # Logic
/// 1. `dist = manhattan_distance(current, home)`.
/// 2. **Homing** — if `dist > wander_radius` → `Some(toward_home(current, home))`.
///    Unfiltered on purpose: every tick, no hash, no legality check, no stay
///    roll, so an NPC outside its radius can never stall. `apply_move` is still
///    the authority that no-ops the step if that direction is a wall.
/// 3. Else if `wander_radius == 0` → `None` (pinned to home).
/// 4. **Wander** — `h = npc_hash(npc_id, tick)` (raw `tick`, unchanged salt and
///    splitmix64 avalanche); `h % 5 == 0` → stay (`None`), the 1-in-5 rate.
/// 5. Build `L`, the LEGAL directions, iterating [`DIRECTION_ORDER`] (the
///    `Direction` declaration order): `d` is legal iff `current.step(d)` is
///    walkable on `map` AND stays within `wander_radius` of `home`.
///    `L` empty (boxed in) → `None`.
/// 6. If `facing` is in `L` → `Some(facing)`, continuing the current heading —
///    this is what lengthens runs and roughly halves immediate reversals.
/// 7. Otherwise → `Some(L[((h >> 1) as usize) % L.len()])`.
#[must_use]
pub fn npc_decide(
    current: TilePos,
    home: TilePos,
    wander_radius: u8,
    facing: Direction,
    npc_id: u64,
    tick: u64,
    map: &crate::world::TileMap,
) -> Option<Direction> {
    let dist = manhattan_distance(current, home);

    if dist > i64::from(wander_radius) {
        // Outside radius → deterministic toward-home (no hash, no stay, no filter)
        return Some(toward_home(current, home));
    }
    // Special case: radius=0 means "pinned to home" — always stay when AT home.
    if wander_radius == 0 {
        return None;
    }
    let h = npc_hash(npc_id, tick);
    if h.is_multiple_of(5) {
        // 1-in-5 stay probability
        return None;
    }
    // Legal set L: walkable AND still inside the wander radius. Fixed-size
    // buffer (at most 4 directions) — no allocation in a pure rule.
    let mut legal = [Direction::North; 4];
    let mut n = 0usize;
    for d in DIRECTION_ORDER {
        let next = current.step(d);
        if map.is_walkable(next) && manhattan_distance(next, home) <= i64::from(wander_radius) {
            legal[n] = d;
            n += 1;
        }
    }
    let legal = &legal[..n];
    if legal.is_empty() {
        // Boxed in: every neighbour is a wall or outside the radius.
        return None;
    }
    if legal.contains(&facing) {
        // Continue the current heading while it stays legal.
        return Some(facing);
    }
    Some(legal[((h >> 1) as usize) % legal.len()])
}

/// Compass directions in `Direction` declaration order — the stable iteration
/// order the legal set `L` is built in, so `L`'s indices are deterministic.
///
/// Declared strictly BELOW `npc_decide` on purpose: `.cargo/mutants.toml`
/// line-pins `npc/rules.rs:61:15` (the `if dy > 0 {` inside `toward_home`), so
/// nothing may be inserted above that line.
const DIRECTION_ORDER: [Direction; 4] = [
    Direction::North,
    Direction::South,
    Direction::East,
    Direction::West,
];

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
    /// toward-home. wander_radius != 0 → not pinned-stay → we reach the hash+pick.
    ///
    /// ADR-0159 D2 migration note: `npc_decide` gained `facing: Direction` and
    /// `map: &TileMap` params and now indexes into the *legal* direction set `L`
    /// (`L[(h >> 1) % L.len()]`) instead of a hardcoded 4-arm match on
    /// `(h >> 1) % 4`. `facing = Direction::South` is used below because South is
    /// the one direction that is ILLEGAL at home (5,5) on the real zone-0 grid
    /// (the row immediately south of home is a wall) — this forces every
    /// non-stay tick through the hash-pick branch (never the continue-facing
    /// branch), reproducing the same "many (npc_id, tick) draws must reach more
    /// than one legal direction" property the pre-migration test pinned.
    /// kills: an impl that always returns `L[0]` regardless of the hash (or one
    /// that indexes with `(h >> 1) % 4` against the real, shorter `L`, which can
    /// panic or silently alias two legal directions to the same output).
    #[test]
    fn npc_decide_arms_north_and_east_are_reachable() {
        let map = crate::world::zone_0();
        let home = TilePos { x: 5, y: 5 };
        let wander_radius = 10u8;
        let facing = Direction::South; // illegal at home -> forces the hash-pick branch
        let mut saw_north = false;
        let mut saw_east = false;
        'outer: for npc_id in 1u64..=100 {
            for tick in 0u64..=100 {
                match npc_decide(home, home, wander_radius, facing, npc_id, tick, &map) {
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
             an impl that always returns the first legal direction (or a fixed default) \
             would never produce North here"
        );
        assert!(
            saw_east,
            "npc_decide must produce East from some (npc_id, tick) within wander range; \
             an impl that always returns the first legal direction (or a fixed default) \
             would never produce East here"
        );
    }

    // -----------------------------------------------------------------------
    // ADR-0159 D2: RT-NPC-01 non-commutativity proofs, moved to the raw
    // `npc_hash` level (see `m12a_gating_tests.rs`'s
    // `npc_decide_aliasing_distinct_id_tick_pairs_differ` for the full
    // migration rationale). `npc_hash` is UNCHANGED by ADR-0159 D2 — only
    // `npc_decide`'s legality filter and continue-facing branch are new — so
    // these hash-level proofs are the precise, legality-filter-independent home
    // for the RT-NPC-01 regression net going forward.
    // -----------------------------------------------------------------------

    /// kills: RT-NPC-01 regression — additive/commutative mixing of
    /// `(npc_id, tick)`.
    ///
    /// Derivation: pre-ADR-0159, the `m12a_gating_tests.rs` aliasing test
    /// asserted `npc_decide(current=home, radius=10, npc_id=1, tick=100) ==
    /// Some(North)` and `npc_decide(current=home, radius=10, npc_id=100,
    /// tick=1) == Some(South)` — i.e. `(h1 >> 1) % 4 == 0` (North) and
    /// `(h2 >> 1) % 4 == 1` (South) for `h1 = npc_hash(1, 100)`,
    /// `h2 = npc_hash(100, 1)`. Since that test passed against the SAME
    /// (unchanged) `npc_hash`, `h1` and `h2` land in different mod-4 residue
    /// classes and therefore cannot be equal — `h1 != h2` is a direct
    /// consequence, reproduced here as its own hash-level assertion so it no
    /// longer depends on `npc_decide`'s (now position-dependent) output
    /// alphabet.
    #[test]
    fn npc_hash_non_commutative_known_pair() {
        assert_ne!(
            npc_hash(1, 100),
            npc_hash(100, 1),
            "npc_hash(1, 100) must differ from npc_hash(100, 1); an additive/commutative \
             mixing function would make these equal (RT-NPC-01)"
        );
    }

    /// kills: RT-NPC-01 regression — `tick_seed`-style additive aliasing across
    /// `(npc_id, tick)` pairs that share the same sum (`5 + 1000 == 1000 + 5 ==
    /// 502 + 503 == 1005`).
    ///
    /// Derivation: pre-ADR-0159, the aliasing test asserted
    /// `!(npc_decide(..., 5, 1000) == npc_decide(..., 1000, 5) &&
    /// npc_decide(..., 1000, 5) == npc_decide(..., 502, 503))` at a fixed
    /// (current=home, radius=10) fixture. If the three raw hashes below were
    /// all equal, `npc_decide` would necessarily have produced identical
    /// results for all three (same hash -> same deterministic mapping) — which
    /// would have contradicted that (passing, unchanged-`npc_hash`) test. So
    /// the three hashes are not all identical; pinned directly here so the
    /// proof no longer depends on `npc_decide`'s legality-narrowed alphabet.
    #[test]
    fn npc_hash_sum_aliasing_pairs_do_not_all_collide() {
        let h_a = npc_hash(5, 1000); // sum = 1005
        let h_b = npc_hash(1000, 5); // sum = 1005 -- same sum, different pair
        let h_c = npc_hash(502, 503); // sum = 1005 -- same sum, different pair
        assert!(
            !(h_a == h_b && h_b == h_c),
            "npc_hash(5,1000)={h_a:#x}, npc_hash(1000,5)={h_b:#x}, npc_hash(502,503)={h_c:#x}: \
             pairs with the same (npc_id + tick) sum must NOT all collide to the same hash; \
             an additive mixing function would make all three identical (RT-NPC-01)"
        );
    }
}
