//! M12a NPC gating tests — proof-of-teeth for `npc_decide`, authored from the
//! M12 spec §3 EARS criteria (ADR-0068 §"Proof-of-teeth"), extended by
//! ADR-0159 D2 (collision-/radius-aware wander, feel-polish slice).
//!
//! EARS criteria covered:
//!   Determinism — same (current, home, radius, facing, npc_id, tick, map) → same Option<Direction>
//!   Outside-radius — deterministic toward-home direction (L1 Manhattan, dominant axis),
//!                    answered EVERY tick, never None (ADR-0159 G3)
//!   Within-radius / at-boundary — seeded wander (varies over ticks, stays sometimes)
//!   Known-answer — exact splitmix64 output pinned for several (npc_id, tick, facing) vectors
//!   ADR-0159 D2 ("WHEN NPCs move, THE npc_decide/movement tick SHALL avoid abrupt
//!   stop/start bursts"):
//!     G1 — no legal-direction result is ever a wall or outside the radius (headline tooth)
//!     G2 — continue-facing: a still-legal facing is returned unchanged
//!     G3 — homing (outside-radius) answers every tick, never None
//!     G4 — known-answer vectors pin the hash/salt/legality interaction
//!     G4b — known-answer vectors pin the 1-in-K "continue" re-roll (fixes the
//!           absorbing-state metronome bug: unconditional continue-when-legal
//!           on the shipped elder_oak pocket never leaves the y=5 row)
//!     G5 — behavioural bound: zero bumps, bounded reversal rate over a long walk
//!     G6 — unchanged contracts (radius=0, determinism, toward_home axis/tiebreak) still hold
//!     G7 — full-coverage: driven from the real start state, the NPC must visit
//!          EVERY legal tile, not orbit a subset forever (the desync-guard-audit tooth)
//!
//! Each test carries a `/// kills:` comment naming which wrong implementation it
//! catches, so the verifier can match failing assertion → eliminated bug class.
//!
//! NEW SIGNATURE (ADR-0159 D2):
//!   npc_decide(current, home, wander_radius, facing, npc_id, tick, map) -> Option<Direction>
//!
//! Red state: `npc_decide` now compiles against this signature (the legality +
//! continue-facing half of ADR-0159 D2 is implemented), but it ships an
//! ABSORBING-STATE bug — "continue whenever facing is legal" with NO voluntary
//! re-roll — caught by an independent desync-guard-audit simulation: once
//! `facing` becomes East or West on elder_oak's shipped pocket (home (5,5),
//! radius 2, zone 0), every interior tile has E/W legal, so the NPC oscillates
//! forever along the y=5 row (5 of the 8 legal tiles) and NEVER visits
//! (4,4)/(5,4)/(6,4). G7 and G4b below are RED against this real, compiling,
//! but behaviourally-wrong implementation; they will go GREEN once the fix (a
//! `(h >> 33) % NPC_CONTINUE_REROLL` voluntary re-roll, K=6) lands.
//!
//! Run: cargo nextest run -p game-core npc::m12a_gating_tests -- --nocapture

use crate::npc::npc_decide;
use crate::types::{
    dir_from_code, ActionState, CharacterState, Direction, Millis, MoveInput, TilePos,
};
use crate::world::{apply_move, zone_0};

use proptest::prelude::*;
use std::collections::HashSet;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

fn pos(x: i32, y: i32) -> TilePos {
    TilePos { x, y }
}

// ---------------------------------------------------------------------------
// Test 1 — Determinism (example-based)
// kills: any impl that reads a clock, global RNG, or other non-injected entropy
//        source (e.g. std::time, OsRng, rand::thread_rng). Calling twice with
//        identical arguments would return different values if any mutable global
//        is consumed.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_deterministic() {
    // Within-radius scenario: distance=1 < radius=3
    let map = zone_0();
    let current = pos(5, 6);
    let home = pos(5, 5);
    let r1 = npc_decide(current, home, 3, Direction::North, 42, 7, &map);
    let r2 = npc_decide(current, home, 3, Direction::North, 42, 7, &map);
    assert_eq!(
        r1, r2,
        "npc_decide must return the same result for identical inputs"
    );
}

// ---------------------------------------------------------------------------
// Test 2 — Determinism (property-based)
// kills: any impl where calling twice gives different results — catches subtle
//        global state (thread-local RNG counters, lazy statics seeded from OS).
// ---------------------------------------------------------------------------

proptest! {
    #[test]
    fn npc_decide_deterministic_property(
        cx in any::<i32>(),
        cy in any::<i32>(),
        hx in any::<i32>(),
        hy in any::<i32>(),
        radius in 0u8..=30u8,
        facing_code in 0u8..4,
        npc_id in any::<u64>(),
        tick in any::<u64>(),
    ) {
        let current = TilePos { x: cx, y: cy };
        let home = TilePos { x: hx, y: hy };
        let facing = dir_from_code(facing_code).expect("facing_code in 0..4 is valid");
        let map = zone_0();
        let r1 = npc_decide(current, home, radius, facing, npc_id, tick, &map);
        let r2 = npc_decide(current, home, radius, facing, npc_id, tick, &map);
        prop_assert_eq!(
            r1, r2,
            "npc_decide must return the same result for identical inputs (no mutable global state)"
        );
    }
}

// ---------------------------------------------------------------------------
// Test 3 — Outside radius moves toward home on X axis (pure East)
// kills: an impl that uses a random direction even when outside the wander
//        radius (any seeded-random path applied here is a correctness bug).
//        ADR-0159 D2: the homing branch is UNCHANGED — no facing/map influence.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_outside_radius_moves_toward_home_x_axis() {
    // home=(5,5), current=(0,5): dx=5, dy=0, distance=5 > radius=3
    // dx > dy → dominant axis is X, home is to the East
    let map = zone_0();
    let result = npc_decide(pos(0, 5), pos(5, 5), 3, Direction::North, 1, 0, &map);
    assert_eq!(
        result,
        Some(Direction::East),
        "NPC at (0,5) with home (5,5) and radius 3 must move East (outside radius, dominant X)"
    );
}

// ---------------------------------------------------------------------------
// Test 4 — Outside radius moves toward home on Y axis (pure North)
// kills: an impl that picks X axis even when dy > dx, or one that returns
//        South instead of North (screen-coord sign error: North = decreasing y).
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_outside_radius_moves_toward_home_y_axis() {
    // home=(5,5), current=(5,10): dx=0, dy=5, distance=5 > radius=3
    // dy > dx → dominant axis is Y, home is North (y decreases toward home)
    let map = zone_0();
    let result = npc_decide(pos(5, 10), pos(5, 5), 3, Direction::East, 1, 0, &map);
    assert_eq!(
        result,
        Some(Direction::North),
        "NPC at (5,10) with home (5,5) and radius 3 must move North (outside radius, dominant Y)"
    );
}

// ---------------------------------------------------------------------------
// Test 5 — Outside radius, dominant dx > dy picks East
// kills: an impl that picks Y axis when dx > dy, or that ties differently.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_outside_radius_moves_toward_home_northeast() {
    // home=(10,3), current=(3,3): dx=7, dy=0, distance=7 > radius=4
    // dx=7 > dy=0 → dominant axis is X → East
    let map = zone_0();
    let result = npc_decide(pos(3, 3), pos(10, 3), 4, Direction::South, 99, 0, &map);
    assert_eq!(
        result,
        Some(Direction::East),
        "NPC at (3,3) with home (10,3) and radius 4 must move East (dx=7 > dy=0)"
    );
}

// ---------------------------------------------------------------------------
// Test 6 — Within radius varies over ticks (wander is not always the same)
// kills: an impl that always returns the same direction for within-radius
//        (e.g. hardcoded Some(North) or constant modulo bias) — and, under
//        ADR-0159 D2, an impl that collapses the legal set incorrectly (e.g.
//        always L[0]).
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_within_radius_varies_over_ticks() {
    // home=(5,5), current=(5,5): distance=0 < radius=5
    // facing=South is ILLEGAL at (5,5) on the real zone-0 grid (wall directly
    // south of home), so every non-stay tick is forced through the hash-pick
    // branch (never continue-facing) — preserving the "must see >=2 distinct
    // outcomes" property under the new legality-aware algorithm.
    let map = zone_0();
    let home = pos(5, 5);
    let current = pos(5, 5); // at home, always within any positive radius
    let results: Vec<Option<Direction>> = (0u64..20)
        .map(|tick| npc_decide(current, home, 5, Direction::South, 1, tick, &map))
        .collect();

    let distinct_count = {
        let mut seen = std::collections::BTreeSet::new();
        for r in &results {
            seen.insert(format!("{:?}", r));
        }
        seen.len()
    };

    assert!(
        distinct_count >= 2,
        "within-radius wander must produce at least 2 distinct outcomes over 20 ticks, got: {:?}",
        results
    );
}

// ---------------------------------------------------------------------------
// Test 7 — At exact radius boundary treated as within (uses wander, not return)
// kills: an impl that uses strict `>` for the boundary check instead of `>=`,
//        causing an NPC at exactly `radius` distance to walk toward home when
//        it should wander freely (spec says "within wander radius" is distance ≤ radius).
//
// ADR-0159 D2 migration note: `current = (5,8)` is OUTSIDE the real zone-0
// grid's bounds (height 7, valid y is 0..6), so under the NEW legality-aware
// wander path every step target is off-map (`is_walkable` is bounds-safe and
// returns `false`), making the legal set L empty and the result ALWAYS `None`
// across all 20 ticks. This is a DIFFERENT constant than the old
// "varies over ticks" result, but the assertion below (`!all_north`) is still
// exactly the right tooth: an impl that wrongly treats distance==radius as
// "outside" would deterministically return `Some(Direction::North)` on EVERY
// tick (toward_home doesn't consult ticks), which the assertion below still
// catches. All-`None` correctly passes; all-`Some(North)` correctly fails.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_at_radius_boundary_treated_as_within() {
    // home=(5,5), current=(5,8): Manhattan distance = 3 = radius = 3
    // At exact boundary → must NOT always return the same toward-home value
    let map = zone_0();
    let home = pos(5, 5);
    let current = pos(5, 8); // distance = |5-5| + |8-5| = 3 = radius
    let radius = 3u8;

    // If this were "outside" logic, every call would return Some(North).
    // If this is "inside/boundary" logic, results are governed by legality
    // (here: always None, since (5,8) is off the real map).
    let results: Vec<Option<Direction>> = (0u64..20)
        .map(|tick| npc_decide(current, home, radius, Direction::South, 7, tick, &map))
        .collect();

    let all_north = results.iter().all(|r| *r == Some(Direction::North));
    assert!(
        !all_north,
        "distance==radius should use wander path (not return-to-home): all 20 ticks returned \
         Some(North), indicating outside-radius logic was applied to the boundary case"
    );
}

// ---------------------------------------------------------------------------
// Test 8 — Stay probability: within radius, None appears at least once in 100 ticks
// kills: an impl that never returns None (always moves), violating the
//        1-in-5 stay probability (hash mod 5 == 0 → stay per the plan).
//        ADR-0159 D2: the stay roll happens BEFORE the legality/continue-facing
//        check, so this remains unaffected by facing/map.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_stay_sometimes() {
    // home=(5,5), current=(5,5): within any positive radius
    let map = zone_0();
    let home = pos(5, 5);
    let current = pos(5, 5);

    let none_count = (0u64..100)
        .filter(|&tick| npc_decide(current, home, 10, Direction::North, 42, tick, &map).is_none())
        .count();

    assert!(
        none_count >= 1,
        "within-radius wander must return None (stay) at least once in 100 ticks; \
         got 0 Nones — stay probability is broken (should be ~20/100 for 1-in-5 rate)"
    );
}

// ---------------------------------------------------------------------------
// Test 9 — Known-answer vector: outside-radius with npc_id=1, tick=0
// kills: any impl that changes the toward-home axis-selection logic for the
//        outside-radius path — the result must be Some(East) for this exact
//        fixture regardless of the hash/salt (no RNG used outside radius), and
//        regardless of `facing`/`map` (ADR-0159 D2 leaves this branch UNCHANGED).
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_known_answer() {
    // npc_id=1, tick=0; home=(10,10), current=(0,10): dx=10, dy=0 → East (outside radius=3)
    let map = zone_0();
    let result = npc_decide(pos(0, 10), pos(10, 10), 3, Direction::West, 1, 0, &map);
    assert_eq!(
        result,
        Some(Direction::East),
        "npc_decide(pos(0,10), home=(10,10), radius=3, npc_id=1, tick=0) must be Some(East)"
    );
}

// ---------------------------------------------------------------------------
// Test 10 — Outside radius, larger dy chooses Y axis (South)
// kills: an impl that always picks the X axis regardless of which delta is
//        larger, or one that returns North (wrong sign: current.y=0 < home.y=5
//        means home is South in screen coords).
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_outside_radius_larger_dy_chooses_y_axis() {
    // home=(5,5), current=(5,0): dx=0, dy=5, distance=5 > radius=2
    // home.y=5 > current.y=0 → home is South (y increases toward home)
    let map = zone_0();
    let result = npc_decide(pos(5, 0), pos(5, 5), 2, Direction::West, 1, 0, &map);
    assert_eq!(
        result,
        Some(Direction::South),
        "NPC at (5,0) with home (5,5) and radius 2 must move South (dy=5 > dx=0, y increases)"
    );
}

// ---------------------------------------------------------------------------
// Test 11 — Known-answer within-radius: pins NPC_DECIDE_SALT and splitmix64 constants
// kills: any change to NPC_DECIDE_SALT or the splitmix64 avalanche constants that
//        silently alters the wander distribution — property tests won't catch this
//        because they only check determinism/direction-class invariants, not exact values.
//
// ADR-0159 D2 re-derivation (the old fixture's expected value genuinely changed:
// old code had no legality filter, so `home==current, radius=5, npc_id=1, tick=0`
// used to hash-pick among ALL FOUR compass directions and landed on West.
// The new algorithm restricts the pick to the LEGAL set. `facing=South` is used
// below (rather than the arbitrary facing the old signature didn't have) so the
// wander STILL exercises the hash-pick branch (not continue-facing) — South is
// illegal at home (5,5) on the real zone-0 grid, so this vector still pins
// NPC_DECIDE_SALT/splitmix64.):
//
//   Independent oracle (Python model of npc_hash + the real shipped zone-0 grid):
//   npc_hash(1, 0) % 5 == 4 (not a stay); legal set at (5,5), radius=5, is
//   [North, East, West] (South is walled — the row directly south of home is
//   "##########" in content/zone_maps/000-core.ron); (h >> 1) % 3 selects
//   index 1 = East.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_known_answer_within_radius() {
    // home=(5,5), current=(5,5): distance=0 <= radius=5 → wander path applies
    let map = zone_0();
    let result = npc_decide(pos(5, 5), pos(5, 5), 5, Direction::South, 1, 0, &map);
    assert_eq!(
        result,
        Some(Direction::East),
        "npc_decide at home (npc_id=1, tick=0, radius=5, facing=South-illegal) must return \
         Some(East) — change indicates NPC_DECIDE_SALT, splitmix64 constants, or the legal-set \
         construction were altered"
    );
}

// ---------------------------------------------------------------------------
// RED-TEAM FINDING RT-NPC-01 (HIGH): tick_seed aliasing — NPC A at tick T
// produces the same hash as NPC (A+k) at tick (T-k) for any k.
//
// Root cause: tick_seed(npc_id, tick, SALT) uses ADDITIVE mixing as its
// first step: (npc_id + tick + SALT + GOLDEN) & MASK.  Since addition is
// commutative and associative mod 2^64, two distinct (npc_id, tick) pairs
// that share the same sum produce byte-identical outputs from the downstream
// splitmix64 avalanche.
//
// Concrete proof:
//   tick_seed(5, 1000, S) == tick_seed(1000, 5, S) == tick_seed(502, 503, S)
//   — every pair where npc_id + tick == 1005 maps to the same hash.
//
// Gameplay impact:
//   • An NPC that wandered as "NPC 5 at tick 1000" will move in the exact
//     same direction as "NPC 1000 at tick 5".  If tick counts monotonically
//     from server start, NPC 0 at tick T will ALWAYS have its direction
//     pre-determined by the current tick value alone (tick_seed(T, 0, S) ==
//     tick_seed(0, T, S)).  An observer watching NPC-0's history can predict
//     the exact direction every NPC with id=T will take at tick=0.
//   • Content authors who rely on different NPCs behaving independently at
//     "the same moment" (same tick) will get correlated movement whenever
//     npc_id_a + tick == npc_id_b + tick (impossible — different tick means
//     different sum; but at the SAME tick, sequential npc_ids DO give
//     independent outputs because only npc_id changes, not the sum).
//   • The pathological case is cross-time aliasing: NPC behaviour seen at
//     tick T reveals the wander outcome for NPC at id=T+k at tick=tick-k.
//     A player who logs NPC positions can extrapolate future NPC positions
//     for NPCs they have never observed.
//
// Fix: use a mixing function where npc_id and tick are NOT additively
// combined before the avalanche — e.g. xor them, or use a two-input hash
// (Cantor pairing, bit-interleaving, or feeding them as separate rounds).
// Example fix:  tick_seed(npc_id ^ (tick.wrapping_mul(0x517CC1B727220A95)), 0, SALT)
//
// This test encodes the INVARIANT that must hold after the fix is applied:
// two distinct (npc_id, tick) pairs that sum to the same value must produce
// DIFFERENT hashes (and therefore potentially different move decisions).
//
// ADR-0159 D2 MIGRATION NOTE: `npc_decide` now filters the raw hash pick
// through a per-position LEGAL direction set and a continue-facing branch, so
// its OWN output alphabet is narrower and position-dependent (e.g. South is
// never a reachable `npc_decide` output at home (5,5) on the real grid — it is
// walled). The original direct-comparison fixture (npc_id=1,tick=100 →
// Some(North) vs npc_id=100,tick=1 → Some(South)) can therefore no longer be
// expressed as a fixed, position-independent `npc_decide`-level pair. Per the
// migration plan, the PRECISE proof of non-commutativity is moved to the raw,
// legality-filter-independent `npc_hash` itself (which ADR-0159 D2 leaves
// UNCHANGED) — see `npc_hash_non_commutative_known_pair` and
// `npc_hash_sum_aliasing_pairs_do_not_all_collide` in
// `game-core/src/npc/rules.rs`'s `mod tests` (the only seam that can reach the
// module-private `npc_hash`). Both reuse the EXACT SAME (npc_id, tick) pairs
// as this test did pre-migration; see their doc-comments for the full
// derivation (in short: the pre-migration version of THIS test, which passed,
// already proved those hashes differ — reusing the same pairs at the hash
// level is strictly more precise, not weaker).
//
// This test is KEPT (not deleted) and still carries a black-box, public-API
// proof: a DIFFERENT id/tick pair, backed by the independently-derived oracle
// (see the module doc for the full known-answer table), that shows two
// distinct npc_ids at the SAME tick and SAME position/facing produce
// different `npc_decide` outputs — the observable, end-to-end symptom
// RT-NPC-01 worried about ("two NPCs behaving identically").
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_aliasing_distinct_id_tick_pairs_differ() {
    // Public-API (npc_decide-level) witness that distinct npc_ids diverge at
    // the SAME tick: home=(5,5), current=(5,5), radius=2, facing=South
    // (illegal at home -> forces the hash-pick branch). Oracle-backed
    // (independently derived, NOT read off any Rust impl):
    //   npc_id=1, tick=0 -> Some(East)
    //   npc_id=7, tick=0 -> Some(West)
    // If a commutative/degenerate hash aliased these two npc_ids together at
    // the same tick, both would produce the SAME direction.
    let map = zone_0();
    let current = pos(5, 5);
    let home = pos(5, 5);
    let radius = 2u8;

    let result_id1 = npc_decide(current, home, radius, Direction::South, 1, 0, &map);
    let result_id7 = npc_decide(current, home, radius, Direction::South, 7, 0, &map);
    assert_eq!(
        result_id1,
        Some(Direction::East),
        "oracle: npc_id=1,tick=0 -> Some(East)"
    );
    assert_eq!(
        result_id7,
        Some(Direction::West),
        "oracle: npc_id=7,tick=0 -> Some(West)"
    );
    assert_ne!(
        result_id1, result_id7,
        "RT-NPC-01: npc_id=1 and npc_id=7 at the SAME tick=0 (same position/facing) must \
         diverge; an aliasing hash would make two different NPCs move identically at the \
         same tick. Full hash-level non-commutativity proofs (reusing the original \
         (npc_id=1,tick=100)/(npc_id=100,tick=1) and sum-aliased (5,1000)/(1000,5)/(502,503) \
         fixtures) live in game-core/src/npc/rules.rs's `mod tests` — see \
         npc_hash_non_commutative_known_pair and npc_hash_sum_aliasing_pairs_do_not_all_collide."
    );
}

// ---------------------------------------------------------------------------
// RED-TEAM FINDING RT-NPC-02 (MEDIUM): radius=0 produces undefined/arbitrary
// "outside" behaviour rather than a defined "stationary NPC" contract.
//
// The plan defines:
//   "within radius → random direction"
//   "outside radius → toward home"
//
// With radius=0 and current==home, Manhattan distance==0 which equals the
// radius (0==0). Per the spec: "at exact radius → random (not return-to-home)".
// So current==home with radius=0 should use the within/wander path.
//
// But with radius=0 and current != home (distance >= 1 > 0 == radius):
// the NPC is ALWAYS outside radius → always moves toward home.
// A stationary NPC is modelled by NpcKind::Stationary (deferred) not radius=0.
//
// ADR-0159 D2: the outside-radius (homing) branch is UNCHANGED — no
// facing/map influence — so this fixture's expected value is unaffected by
// the migration; only the call site gains the two new params.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_radius_zero_current_outside_always_moves_toward_home() {
    // home=(5,5), current=(6,5): distance=1 > radius=0 → outside → toward home (West)
    let map = zone_0();
    let result = npc_decide(pos(6, 5), pos(5, 5), 0, Direction::North, 42, 99, &map);
    assert_eq!(
        result,
        Some(Direction::West),
        "RT-NPC-02: radius=0, current=(6,5), home=(5,5): distance=1 > 0 → outside radius \
         → must move West toward home. \
         Content pipeline (M12c) must validate Wanderer radius >= 1."
    );
}

// ===========================================================================
// ADR-0159 D2 gates (feel-polish slice) — EARS: "WHEN NPCs move, THE
// npc_decide/movement tick SHALL avoid abrupt stop/start bursts."
// ===========================================================================

// ---------------------------------------------------------------------------
// G1 — NO ILLEGAL MOVE (the headline tooth).
//
// For EVERY reachable position within elder_oak's real wander radius (home
// (5,5), wander_radius 2, real zone-0 grid) and every facing, over many ticks:
// whenever npc_decide returns Some(d) on the wander path, the target tile MUST
// be walkable AND still within wander_radius.
//
// kills: the STATUS-QUO implementation, which ignores `map` entirely and
// uniformly hash-picks among all FOUR compass directions with no legality or
// radius filter. At current=(5,5), facing=South, npc_id=1, tick=0 the status
// quo returns Some(South) — stepping into (5,6), which is a WALL (row y=6 of
// content/zone_maps/000-core.ron is "##########"). This exhaustive sweep
// catches that exact bug (and any regression to unrestricted 4-way choice)
// without hardcoding a single example.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_never_returns_illegal_move_on_real_zone_0_wander_positions() {
    let map = zone_0();
    let home = pos(5, 5);
    let radius: u8 = 2;
    let directions = [
        Direction::North,
        Direction::South,
        Direction::East,
        Direction::West,
    ];

    for dx in -2i32..=2 {
        for dy in -2i32..=2 {
            if dx.abs() + dy.abs() > 2 {
                continue; // outside the diamond radius -- not a wander-path position
            }
            let current = pos(home.x + dx, home.y + dy);
            for &facing in &directions {
                for npc_id in 1u64..=5 {
                    for tick in 0u64..100 {
                        if let Some(d) =
                            npc_decide(current, home, radius, facing, npc_id, tick, &map)
                        {
                            let target = current.step(d);
                            assert!(
                                map.is_walkable(target),
                                "npc_decide returned Some({d:?}) from current={current:?} \
                                 home={home:?} facing={facing:?} npc_id={npc_id} tick={tick}, \
                                 but the target tile {target:?} is NOT walkable (wall bump) — \
                                 the wander path must never choose an illegal direction"
                            );
                            let dist = (i64::from(target.x) - i64::from(home.x)).abs()
                                + (i64::from(target.y) - i64::from(home.y)).abs();
                            assert!(
                                dist <= i64::from(radius),
                                "npc_decide returned Some({d:?}) from current={current:?} \
                                 home={home:?} facing={facing:?} npc_id={npc_id} tick={tick}, \
                                 but the target tile {target:?} is OUTSIDE wander_radius={radius} \
                                 (distance {dist})"
                            );
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// G2 — CONTINUE-FACING.
//
// When the current facing is legal (walkable + within radius), npc_decide
// must return Some(facing) unchanged (continue heading) rather than
// re-rolling — the persistence half of ADR-0159 D2 that halves reversals.
//
// kills: an impl that drops the continue-facing check entirely and always
// hash-picks from L (ignoring `facing`), even when the current facing is
// still legal.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_continues_current_facing_when_legal() {
    let map = zone_0();
    let home = pos(5, 5);
    let radius = 2u8;

    // North and East are legal at (5,5); tick=0 (h%5=4, not a stay).
    for facing in [Direction::North, Direction::East] {
        let result = npc_decide(home, home, radius, facing, 1, 0, &map);
        assert_eq!(
            result,
            Some(facing),
            "facing={facing:?} is legal at (5,5) (h%5=4, not a stay) — npc_decide must \
             continue the same heading, got {result:?}"
        );
    }
    // West is legal at (5,5); tick=1 (h%5=1, not a stay).
    let result = npc_decide(home, home, radius, Direction::West, 1, 1, &map);
    assert_eq!(
        result,
        Some(Direction::West),
        "facing=West is legal at (5,5) at tick=1 (h%5=1, not a stay) — npc_decide must \
         continue the same heading, got {result:?}"
    );
}

// ---------------------------------------------------------------------------
// G3 — HOMING IS PER-TICK.
//
// Outside the wander radius, npc_decide must return Some(toward_home) on
// EVERY tick and never None — the homing branch has no hash, no legality
// filter, no stay roll (unchanged, ADR-0159 D2).
//
// kills: any impl that mistakenly applies the legality filter (L-empty check)
// or the 1-in-5 stay roll to the `dist > wander_radius` branch, which could
// freeze a returning NPC forever outside its radius.
//
// Red-team finding (MAJOR, fixed here): the ORIGINAL fixture — current=(1,1),
// home=(5,5), r=2 — has toward_home = East, and (2,1) (the East step from
// (1,1)) is walkable, so a mutant that adds a legality filter to the homing
// branch produces the IDENTICAL answer (filtering never removes a legal
// choice when the only candidate is already legal). That mutant PASSED
// against this fixture. Fixed by adding a SECOND fixture below where
// toward_home's step target is a genuine on-map WALL, so a legality-filtered
// mutant is forced to diverge (either to `None`, because the empty legal set
// L has no fallback, or to some other direction chosen via the hash) from the
// correct, unconditional `Some(toward_home(...))`.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_homing_answers_every_tick_never_stalls() {
    let map = zone_0();
    let home = pos(5, 5);
    let radius = 2u8;

    // Fixture A (kept): current=(1,1), home=(5,5), r=2 -> dist=8>2, outside.
    // toward_home dx=4,dy=4 (tied -> X wins) -> East. (2,1) is walkable floor,
    // so this fixture alone does NOT distinguish "unconditional homing" from
    // "homing filtered through legality" (see red-team finding above) — kept
    // as a baseline "answers every tick" regression check.
    let current_a = pos(1, 1);
    for tick in 0u64..4 {
        let result = npc_decide(current_a, home, radius, Direction::North, 1, tick, &map);
        assert_eq!(
            result,
            Some(Direction::East),
            "outside-radius homing must answer Some(East) every tick (tick={tick}), got {result:?}"
        );
    }

    // Fixture B (NEW, the actual tooth): current=(5,2), home=(5,5), r=2.
    // Derivation from the real zone-0 grid (content/zone_maps/000-core.ron):
    //   dist((5,2),(5,5)) = |5-5| + |2-5| = 3 > radius(2) -> outside/homing.
    //   toward_home: dx=5-5=0, dy=5-2=3; |dx| < |dy| -> Y-axis dominant;
    //   dy=3>0 -> South (South = increasing y in screen coords).
    //   Step target = (5,2).step(South) = (5,3). Row y=3 of the grid is
    //   "#...##..~#" -> index 5 (0-based) is '#' -- a genuine WALL, not an
    //   off-map coordinate.
    // The homing branch is UNCHANGED by ADR-0159 D2 (no hash, no legality
    // filter, no stay roll), so npc_decide MUST still return Some(South)
    // here, on every tick, even though that exact tile is a wall (apply_move,
    // not npc_decide, is responsible for ever rejecting the step). A mutant
    // that legality-filters the homing branch has NO legal candidate at all
    // from (5,2) toward home along this axis and must diverge (to `None` or
    // to a hash-picked alternative) -- this fixture forces that divergence.
    let current_b = pos(5, 2);
    for tick in 0u64..4 {
        let result = npc_decide(current_b, home, radius, Direction::North, 1, tick, &map);
        assert_eq!(
            result,
            Some(Direction::South),
            "outside-radius homing from (5,2) toward home (5,5) must answer Some(South) \
             every tick (tick={tick}), even though the target tile (5,3) is a wall — the \
             homing branch must be unconditional (no legality filter); got {result:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// G4 — KNOWN-ANSWER VECTORS.
//
// Pins several exact oracle rows (home (5,5), radius 2, real zone-0 grid)
// derived independently from the spec + a Python model of npc_hash and the
// real shipped grid (NOT read off any Rust implementation).
//
// kills: any change to NPC_DECIDE_SALT, the splitmix64 avalanche constants, or
// the 1-in-5 stay threshold that silently alters the wander distribution —
// property tests alone would not catch this.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_known_answer_vectors_pin_hash_and_legality() {
    let map = zone_0();
    let home = pos(5, 5);
    let radius = 2u8;

    // South is illegal at (5,5) -> hash-picks among [North, East, West];
    // npc_id=1, tick=0 picks East.
    assert_eq!(
        npc_decide(home, home, radius, Direction::South, 1, 0, &map),
        Some(Direction::East),
        "oracle: (5,5) facing=South npc_id=1 tick=0 -> Some(East)"
    );
    // Same current/tick, DIFFERENT npc_id=7 -> different hash pick: West.
    // Proves NPC_DECIDE_SALT / splitmix64 constants are untouched (a changed
    // salt would shift this pick).
    assert_eq!(
        npc_decide(home, home, radius, Direction::South, 7, 0, &map),
        Some(Direction::West),
        "oracle: (5,5) facing=South npc_id=7 tick=0 -> Some(West)"
    );
    // Three independent 1-in-5 "stay" rows (h % 5 == 0) -> None. Proves the
    // stay rate/threshold is untouched.
    assert_eq!(
        npc_decide(home, home, radius, Direction::North, 1, 2, &map),
        None,
        "oracle: (5,5) facing=North npc_id=1 tick=2 -> None (stay)"
    );
    assert_eq!(
        npc_decide(home, home, radius, Direction::South, 1, 5, &map),
        None,
        "oracle: (5,5) facing=South npc_id=1 tick=5 -> None (stay)"
    );
    assert_eq!(
        npc_decide(home, home, radius, Direction::North, 1, 9, &map),
        None,
        "oracle: (5,5) facing=North npc_id=1 tick=9 -> None (stay)"
    );
    // (4,5) with facing East (legal there) at tick=3 continues East.
    assert_eq!(
        npc_decide(pos(4, 5), home, radius, Direction::East, 1, 3, &map),
        Some(Direction::East),
        "oracle: (4,5) facing=East npc_id=1 tick=3 -> Some(East) (continue-facing)"
    );
    // (5,4) with facing South at tick=4 -> stay (h % 5 == 0), even though
    // South IS legal from (5,4) (it steps to home (5,5), not the wall) —
    // proves the stay roll is checked BEFORE facing/legality.
    assert_eq!(
        npc_decide(pos(5, 4), home, radius, Direction::South, 1, 4, &map),
        None,
        "oracle: (5,4) facing=South npc_id=1 tick=4 -> None (stay, checked before legality)"
    );
}

// ---------------------------------------------------------------------------
// G4b — RE-ROLL KNOWN-ANSWER VECTORS.
//
// Desync-guard-audit finding: the shipped implementation has an ABSORBING
// STATE. "Continue whenever `facing` is legal" with NO voluntary re-roll means
// that once `facing` becomes East or West on elder_oak's real pocket (home
// (5,5), radius 2, zone 0), it can never change: every interior tile has E/W
// legal (continue always fires), and the two end tiles (3,5)/(7,5) force the
// exact reverse. Measured: the NPC oscillates along the y=5 row (5 of the 8
// legal tiles) and NEVER visits (4,4), (5,4), (6,4) — a metronome, not a
// wanderer (see G7 below for the full-coverage proof).
//
// The fix adds a THIRD, independent bit-slice: even when `facing` is legal,
// `(h >> 33) % NPC_CONTINUE_REROLL == 0` (K = 6) forces a re-roll via the
// existing `L[(h >> 1) % L.len()]` pick instead of continuing. `(h >> 33)` is
// deliberately disjoint from the stay-roll bits (`h % 5`) and the pick bits
// (`h >> 1`).
//
// These vectors are independently derived (home (5,5), radius 2, zone-0 grid;
// L = [North, East, West] there, South is walled) and PIN cases where
// `facing` IS legal but the correct output is still a re-roll — the exact
// scenario an unconditional-continue implementation can never produce.
//
// kills: the shipped "continue whenever legal, no re-roll" bug — these
// vectors are RED against it (it returns `Some(facing)` unconditionally,
// never `Some(East)` when facing is the illegal-to-continue North/West here).
// Also kills an impl that ALWAYS re-rolls (ignores `facing` entirely): the
// trailing "control" pair proves continuation still happens when
// `(h >> 33) % 6 != 0`.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_known_answer_vectors_pin_the_continue_reroll() {
    let map = zone_0();
    let home = pos(5, 5);
    let radius = 2u8;

    // facing legal (North, West both in L) but (h>>33)%6==0 -> REROLLED to
    // the hash-pick (East), NOT continued.
    assert_eq!(
        npc_decide(home, home, radius, Direction::North, 7, 5, &map),
        Some(Direction::East),
        "oracle: (5,5) facing=North(legal) npc_id=7 tick=5: h%5=3 (not stay), \
         (h>>33)%6=0 -> REROLLED away from North to East, not continued"
    );
    assert_eq!(
        npc_decide(home, home, radius, Direction::West, 7, 5, &map),
        Some(Direction::East),
        "oracle: (5,5) facing=West(legal) npc_id=7 tick=5: same (npc_id, tick) hash draw \
         as above (the hash does not depend on `facing`) -> REROLLED away from West to \
         East, not continued"
    );
    assert_eq!(
        npc_decide(home, home, radius, Direction::North, 7, 7, &map),
        Some(Direction::East),
        "oracle: (5,5) facing=North(legal) npc_id=7 tick=7: h%5=4 (not stay), \
         (h>>33)%6=0 -> REROLLED away from North to East, not continued"
    );

    // Control pair, SAME position, discriminating the branch the other way:
    // facing IS continued when the (h>>33)%6 draw is non-zero, so the fix is
    // not "always reroll" either.
    assert_eq!(
        npc_decide(home, home, radius, Direction::East, 1, 6, &map),
        Some(Direction::East),
        "oracle: (5,5) facing=East(legal) npc_id=1 tick=6: h%5=4 (not stay), \
         (h>>33)%6=5 (!=0) -> CONTINUED (paired with the North/West vectors above at \
         the SAME position to prove the branch genuinely discriminates)"
    );
    assert_eq!(
        npc_decide(home, home, radius, Direction::East, 1, 7, &map),
        Some(Direction::East),
        "oracle: (5,5) facing=East(legal) npc_id=1 tick=7: (h>>33)%6=3 (!=0) -> CONTINUED"
    );
}

// ---------------------------------------------------------------------------
// G5 — BEHAVIOURAL BOUND (encodes the playtest complaint).
//
// Simulate a long walk (60 000 ticks — the ADR's own measurement window) on
// the REAL zone-0 grid starting at elder_oak's home, driving the NPC's actual
// position/facing tick-by-tick (mirroring how movement.rs drives npc_decide +
// apply_move in production). Assert:
//   - bump count == 0 (exact).
//   - IMMEDIATE reversal rate < 28% of moves.
//   - the NPC never leaves its wander_radius.
//
// THRESHOLD RE-DERIVATION (2nd red-team pass): the FIRST fix considered
// ("always continue when legal", no re-roll) measured 19.97% immediate
// reversals — but that fix has an ABSORBING STATE (G4b/G7): it never visits
// 3 of the 8 legal tiles. The desync-guard-audit's actual fix adds a 1-in-6
// voluntary re-roll (`(h >> 33) % NPC_CONTINUE_REROLL`, K=6), which reaches
// all 8 tiles but costs a somewhat higher reversal rate:
//
//   rule                     tiles  rev%   bump%  meanRun   (60k ticks, real grid)
//   status quo (pre-slice)    13*   32.26  14.33  1.14      (*incl. out-of-radius)
//   always-continue (bug)      5    19.97   0.00  2.48
//   K=4                        8    25.88   0.00  1.68
//   K=6  <-- CHOSEN             8    24.05   0.00  1.84
//   K=8                        8    23.23   0.00  1.96
//   K=16                       8    21.75   0.00  2.16
//
// `< 0.25` (the prior threshold, derived against the absorbing-state 19.97%
// figure) would leave K=6's honest 24.05% only ~1pp of margin — the SAME
// knife-edge problem red-team already flagged once (see the METRIC note
// below for that history). Threshold moved to `< 0.28`: status quo 32.26%
// fails by 4.3pp; the K=6 fix's 24.05% passes by 4.0pp — comparable margin on
// both sides, at the ADR's actual measurement window (N=60000).
//
// METRIC (precise, do not re-introduce ambiguity here): a reversal is an
// IMMEDIATE reversal — a MOVE tick whose direction is the exact opposite of
// the PREVIOUS MOVE tick's direction, with NO intervening stay (`None`) tick
// between them. `last_move_dir` is therefore reset to `None` on every stay
// tick below: "move East, stay, stay, move West" is NOT a reversal. A prior
// version of this test tracked `last_move_dir` across stay ticks (an
// "any-gap" metric); red-team showed that metric converges to EXACTLY 25.00%
// regardless of implementation correctness (measured 24.9937% at N=5000,
// 25.0005% at N=60000, 25.0002% at N=200000) — i.e. that `< 0.25` assertion
// was a coin-flip on sample-size noise, not a tooth. Both historical issues
// (wrong metric, then a too-tight threshold against the RIGHT metric) are
// folded into the `< 0.28` / N=60000 combination above.
//
// kills: any impl that ignores the map (status quo: 14.33% of ticks were
// bumps), or that is collision-aware but drops continue-facing entirely
// (measured 35.44% immediate-reversal rate in the ADR's alternative (B) —
// still over this bound), or the shipped absorbing-state bug's sibling
// failure mode were its reversal rate ever to regress upward past 28%.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_behavioural_bound_zero_bumps_bounded_reversals_over_long_walk() {
    let map = zone_0();
    let home = pos(5, 5);
    let radius = 2u8;
    let npc_id = 1u64;

    fn opposite(d: Direction) -> Direction {
        match d {
            Direction::North => Direction::South,
            Direction::South => Direction::North,
            Direction::East => Direction::West,
            Direction::West => Direction::East,
        }
    }

    let mut current = home;
    let mut facing = Direction::South; // matches the ADR's measured starting facing
    let mut bumps: u64 = 0;
    let mut moves: u64 = 0;
    let mut reversals: u64 = 0;
    // Reset to `None` on every stay tick (see METRIC note above) -- only a
    // MOVE immediately following another MOVE is eligible to count as a
    // reversal; a stay tick breaks the chain.
    let mut last_move_dir: Option<Direction> = None;

    for tick in 0u64..60_000 {
        if let Some(d) = npc_decide(current, home, radius, facing, npc_id, tick, &map) {
            let target = current.step(d);
            if map.is_walkable(target) {
                moves += 1;
                if let Some(prev) = last_move_dir {
                    if d == opposite(prev) {
                        reversals += 1;
                    }
                }
                last_move_dir = Some(d);
                current = target;
            } else {
                bumps += 1;
                // A bump is neither a move nor a stay for reversal-eligibility
                // purposes on the real grid this test targets bumps==0, so
                // this branch is exercised only by a still-buggy impl; reset
                // defensively so a bump can never be misread as "the previous
                // move" for the next tick's reversal check.
                last_move_dir = None;
            }
            facing = d; // apply_move always turns to face the input, even on a bump
        } else {
            // None (stay): position and facing are both unchanged, matching
            // movement.rs, which never calls apply_move when npc_decide
            // returns None. Breaks the reversal-eligibility chain (METRIC note).
            last_move_dir = None;
        }

        let dist = (i64::from(current.x) - i64::from(home.x)).abs()
            + (i64::from(current.y) - i64::from(home.y)).abs();
        assert!(
            dist <= i64::from(radius),
            "NPC left its wander_radius at tick {tick}: current={current:?} home={home:?} \
             dist={dist}"
        );
    }

    assert_eq!(
        bumps, 0,
        "expected ZERO wall-bumps over 60000 ticks on the real zone-0 grid \
         (status quo measured 14.33% of ticks as bumps); got {bumps} bumps"
    );
    assert!(
        moves > 0,
        "sanity: the simulation must have moved at least once"
    );
    #[allow(clippy::cast_precision_loss)] // bounded by MAX_TICKS (60_000); no precision concern
    let reversal_rate = reversals as f64 / moves as f64;
    assert!(
        reversal_rate < 0.28,
        "IMMEDIATE reversal rate must be < 28% of moves (status quo measured 32.26%, \
         the K=6 voluntary-reroll fix measured 24.05%, both at N=60000); got {:.4}% \
         ({reversals} reversals / {moves} moves)",
        reversal_rate * 100.0
    );
}

// ---------------------------------------------------------------------------
// G6 — UNCHANGED CONTRACTS still pass.
//
// wander_radius == 0 with current == home must still return None (the
// "pinned to home" special case, ADR-0068, UNCHANGED by ADR-0159 D2).
//
// kills: an impl that, while adding legality-awareness, accidentally routes
// the radius==0 pinned-stay special case through the new legal-set logic
// (e.g. an empty L at radius=0 producing None for the WRONG reason, which
// would coincidentally still pass a weaker test — this test also confirms the
// SAME behaviour holds regardless of which facing is passed, proving the
// special case is checked before any facing/map consultation).
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_radius_zero_pinned_to_home_never_moves_regardless_of_facing() {
    let map = zone_0();
    let home = pos(5, 5);
    for facing in [
        Direction::North,
        Direction::South,
        Direction::East,
        Direction::West,
    ] {
        let result = npc_decide(home, home, 0, facing, 42, 7, &map);
        assert_eq!(
            result, None,
            "wander_radius=0 with current==home must always return None (pinned to home), \
             regardless of facing={facing:?}; got {result:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// G7 — FULL COVERAGE, NOT AN ABSORBING STATE (desync-guard-audit finding,
// HIGHEST PRIORITY: this is the tooth that would have caught the shipped bug).
//
// G1 sweeps every diamond position and asserts "IF Some(d) is returned, it's
// legal" — that is necessary but NOT sufficient: it never drives the NPC from
// its real start state, so it cannot see that a legality-correct decision
// function can still be a de-facto metronome if it always continues a legal
// facing. The shipped implementation does exactly that: "continue whenever
// facing is legal", no voluntary re-roll. On elder_oak's real pocket (home
// (5,5), radius 2, zone 0) every interior tile has East/West legal, so once
// `facing` becomes East or West it NEVER changes again (the two end tiles,
// (3,5) and (7,5), force the exact reverse, which is still East/West). The
// independent desync-guard-audit simulation confirmed the NPC visits only 5
// of the 8 legal tiles — the whole y=5 row — and never reaches
// (4,4), (5,4), (6,4), for 7 of 8 sampled npc_ids.
//
// This test drives `npc_decide` + the REAL `apply_move` (not a hand-rolled
// step) from the REAL production start state — home (5,5), facing South,
// `action: Idle` — for 20 000 ticks (matching movement.rs's own tick-by-tick
// loop: `Some(dir)` -> `apply_move(...)`, `None` -> `continue` with state
// untouched, exactly as encoded here). It collects the SET of tiles visited
// and asserts it equals the full set of legal tiles, computed PROGRAMMATICALLY
// from the map + radius (not hardcoded), so the test stays honest if content
// ever changes. It repeats for 8 different npc_ids, since the bug reproduced
// for 7 of the 8 ids the audit sampled.
//
// kills: the shipped "continue whenever legal, no re-roll" absorbing-state
// bug. RED against it: the visited set is a strict subset (size 5, the y=5
// row only) of the expected set (size 8) for the affected npc_ids.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_visits_every_legal_tile_from_real_start_state_not_an_absorbing_state() {
    let map = zone_0();
    let home = pos(5, 5);
    let radius: u8 = 2;

    // Expected set: computed PROGRAMMATICALLY from the map + radius (not
    // hardcoded), so this test stays honest if zone-0 content ever changes.
    let mut expected: HashSet<TilePos> = HashSet::new();
    let r = i32::from(radius);
    for dx in -r..=r {
        for dy in -r..=r {
            if dx.abs() + dy.abs() > r {
                continue; // outside the diamond radius
            }
            let candidate = pos(home.x + dx, home.y + dy);
            if map.is_walkable(candidate) {
                expected.insert(candidate);
            }
        }
    }
    // Sanity pin on elder_oak's real shipped config (documents the premise;
    // if content drifts this fails loud rather than silently passing a
    // smaller/larger coverage requirement).
    assert_eq!(
        expected.len(),
        8,
        "sanity: elder_oak's real wander pocket (home (5,5), radius 2, zone 0) must have \
         exactly 8 legal tiles per the desync-guard audit; got {} -- if zone-0 content \
         changed, re-derive this test's premise from the new grid",
        expected.len()
    );

    // Several npc_ids, not just one -- the audit measured coverage
    // [5,5,5,7,5,5,5,5] across these 8 ids: EVERY one of them falls short of
    // the full 8-tile set under the shipped bug (one outlier reaches 7, via
    // whichever end tile it happens to bounce off first, before settling into
    // the same y=5-row oscillation as the rest) -- a single-id test could
    // still catch this, but sampling all 8 matches the audit's own evidence
    // and guards against a fix that only breaks the absorbing state for some
    // ids (e.g. an off-by-one in the re-roll bit-slice for certain hashes).
    for npc_id in 1u64..=8 {
        let mut state = CharacterState {
            pos: home,
            facing: Direction::South,
            action: ActionState::Idle,
            move_started_at: Millis(0),
        };
        let mut visited: HashSet<TilePos> = HashSet::new();
        visited.insert(state.pos);

        for tick in 0u64..20_000 {
            match npc_decide(state.pos, home, radius, state.facing, npc_id, tick, &map) {
                Some(d) => {
                    state = apply_move(&state, MoveInput::Step(d), &map, Millis(0));
                    visited.insert(state.pos);
                }
                None => {
                    // Stay: movement.rs `continue`s without calling apply_move,
                    // so state (position AND facing) is left untouched here too.
                }
            }
        }

        assert_eq!(
            visited,
            expected,
            "npc_id={npc_id}: driven from the REAL start state (5,5) facing South for \
             20000 ticks on the real zone-0 grid, npc_decide must visit ALL {} legal tiles; \
             visited only {} -- an absorbing \"continue whenever legal, no re-roll\" bug \
             oscillates along the y=5 row and never reaches (4,4)/(5,4)/(6,4)",
            expected.len(),
            visited.len()
        );
    }
}
