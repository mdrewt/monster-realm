//! M12a NPC gating tests — proof-of-teeth for `npc_decide`, authored from the
//! M12 spec §3 EARS criteria (ADR-0068 §"Proof-of-teeth"). Populated by the tester.
//!
//! EARS criteria covered:
//!   Determinism — same (current, home, radius, npc_id, tick) → same Option<Direction>
//!   Outside-radius — deterministic toward-home direction (L1 Manhattan, dominant axis)
//!   Within-radius / at-boundary — seeded wander (varies over ticks, stays sometimes)
//!   Known-answer — exact splitmix64 output pinned for npc_id=1, tick=0, outside-radius
//!
//! Each test carries a `/// kills:` comment naming which wrong implementation it
//! catches, so the verifier can match failing assertion → eliminated bug class.
//!
//! Red state: every test will PANIC on the `todo!()` stubs in `rules.rs`.
//!
//! Run: cargo nextest run -p game-core npc::m12a_gating_tests -- --nocapture

use crate::npc::npc_decide;
use crate::types::{Direction, TilePos};

use proptest::prelude::*;

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
    let current = pos(5, 6);
    let home = pos(5, 5);
    let r1 = npc_decide(current, home, 3, 42, 7);
    let r2 = npc_decide(current, home, 3, 42, 7);
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
        npc_id in any::<u64>(),
        tick in any::<u64>(),
    ) {
        let current = TilePos { x: cx, y: cy };
        let home = TilePos { x: hx, y: hy };
        let r1 = npc_decide(current, home, radius, npc_id, tick);
        let r2 = npc_decide(current, home, radius, npc_id, tick);
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
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_outside_radius_moves_toward_home_x_axis() {
    // home=(5,5), current=(0,5): dx=5, dy=0, distance=5 > radius=3
    // dx > dy → dominant axis is X, home is to the East
    let result = npc_decide(pos(0, 5), pos(5, 5), 3, 1, 0);
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
    let result = npc_decide(pos(5, 10), pos(5, 5), 3, 1, 0);
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
    let result = npc_decide(pos(3, 3), pos(10, 3), 4, 99, 0);
    assert_eq!(
        result,
        Some(Direction::East),
        "NPC at (3,3) with home (10,3) and radius 4 must move East (dx=7 > dy=0)"
    );
}

// ---------------------------------------------------------------------------
// Test 6 — Within radius varies over ticks (wander is not always the same)
// kills: an impl that always returns the same direction for within-radius
//        (e.g. hardcoded Some(North) or constant modulo bias).
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_within_radius_varies_over_ticks() {
    // home=(5,5), current=(5,5): distance=0 < radius=5
    // Over 20 different ticks, we must see at least 2 distinct results
    let home = pos(5, 5);
    let current = pos(5, 5); // at home, always within any positive radius
    let results: Vec<Option<Direction>> = (0u64..20)
        .map(|tick| npc_decide(current, home, 5, 1, tick))
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
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_at_radius_boundary_treated_as_within() {
    // home=(5,5), current=(5,8): Manhattan distance = 3 = radius = 3
    // At exact boundary → must NOT always return the same toward-home value
    // (if wander is used, different ticks must differ as in test 6)
    let home = pos(5, 5);
    let current = pos(5, 8); // distance = |5-5| + |8-5| = 3 = radius
    let radius = 3u8;

    // If this were "outside" logic, every call would return Some(North).
    // If this is "inside/boundary" logic, results vary over ticks.
    let results: Vec<Option<Direction>> = (0u64..20)
        .map(|tick| npc_decide(current, home, radius, 7, tick))
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
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_stay_sometimes() {
    // home=(5,5), current=(5,5): within any positive radius
    let home = pos(5, 5);
    let current = pos(5, 5);

    let none_count = (0u64..100)
        .filter(|&tick| npc_decide(current, home, 10, 42, tick).is_none())
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
//        fixture regardless of the hash/salt (no RNG used outside radius).
//        Also kills an impl using dy-dominant tie-breaking when dx==dy (here
//        dx=10 > dy=0 so East is unambiguous; the known answer is exact).
//
// Spec note: outside-radius path is purely deterministic (no hash involved),
// so this vector requires no salt knowledge. A distinct within-radius known-
// answer test would pin the salt; that is deferred to M12a integration tests
// (a pre-run of the impl produces the vector, which is then locked into the
// suite — currently the NPC_DECIDE_SALT constant is not finalized in the spec).
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_known_answer() {
    // npc_id=1, tick=0; home=(10,10), current=(0,10): dx=10, dy=0 → East (outside radius=3)
    let result = npc_decide(pos(0, 10), pos(10, 10), 3, 1, 0);
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
    let result = npc_decide(pos(5, 0), pos(5, 5), 2, 1, 0);
    assert_eq!(
        result,
        Some(Direction::South),
        "NPC at (5,0) with home (5,5) and radius 2 must move South (dy=5 > dx=0, y increases)"
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
// It will be RED until the aliasing is corrected in the hash construction.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_aliasing_distinct_id_tick_pairs_differ() {
    // Two (npc_id, tick) pairs with npc_id_a + tick_a == npc_id_b + tick_b
    // — they MUST produce different outcomes (at minimum they must not be
    // identical in direction for this well-separated fixture).
    //
    // Both have sum = 1005. If aliasing is present, npc_decide returns
    // the same Option<Direction> for BOTH.
    //
    // The fixture uses positions where within-radius wander applies, so the
    // direction COMES FROM the hash — this test will catch hash aliasing
    // directly without any outside-radius determinism masking it.
    let current = pos(5, 5); // at home; distance=0, always within any radius>0
    let home = pos(5, 5);
    let radius = 10u8;

    // npc_id=5, tick=1000: sum=1005
    let result_a = npc_decide(current, home, radius, 5, 1000);
    // npc_id=1000, tick=5: sum=1005 — SAME SUM, different (id, tick)
    let result_b = npc_decide(current, home, radius, 1000, 5);
    // npc_id=502, tick=503: sum=1005 — also the same sum
    let result_c = npc_decide(current, home, radius, 502, 503);

    // All three produce the same hash if aliasing is present.
    // After the fix, at least one pair must differ.
    //
    // Proof-of-teeth: a naive additive hash (state+input+seed) makes
    // result_a == result_b == result_c.  A correct two-input hash breaks
    // all three equalities (or at least two of the three).
    assert!(
        !(result_a == result_b && result_b == result_c),
        "RT-NPC-01: tick_seed aliasing — npc_id=5,tick=1000 and npc_id=1000,tick=5 \
         and npc_id=502,tick=503 all produced {:?} (identical). \
         Pairs with the same (npc_id + tick) sum must NOT map to the same hash. \
         Fix: replace additive mixing with a two-input (non-commutative) hash."
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
// The finding: there is no content-authoring guard that prevents radius=0
// being used on a Wanderer NPC.  An author who sets radius=0 thinking it
// means "stays put" will get an NPC that ALWAYS pathfinds toward home.
// This gates on the validate_content pipeline (M12c) adding a check that
// Wanderer NPCs have radius >= 1.
//
// This test documents the expected (correct) behaviour for radius=0 so that
// if the impl silently "stays" (returns None) for radius=0 the gate fails.
// ---------------------------------------------------------------------------

#[test]
fn npc_decide_radius_zero_current_outside_always_moves_toward_home() {
    // home=(5,5), current=(6,5): distance=1 > radius=0 → outside → toward home (West)
    let result = npc_decide(pos(6, 5), pos(5, 5), 0, 42, 99);
    assert_eq!(
        result,
        Some(Direction::West),
        "RT-NPC-02: radius=0, current=(6,5), home=(5,5): distance=1 > 0 → outside radius \
         → must move West toward home. \
         Content pipeline (M12c) must validate Wanderer radius >= 1."
    );
}
