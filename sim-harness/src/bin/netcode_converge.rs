//! Convergence check for the `netcode-convergence` eval (M8.8d / M14.5f): feeds
//! the lossy/reordering `Link` into the authoritative `ServerWorld` and reports
//! (as JSON) that the authoritative final state is delivery-order-INVARIANT under
//! the seq-canonical apply (convergence — ADR-0013), that reorder + loss actually
//! occur on the jittered scenario, and that the naive arrival-order apply DIVERGES
//! on a known-bad reorder fixture (proof-of-teeth). M14.5f extends the gate with:
//!   - 128-seed randomized convergence check (random_scenario)
//!   - warp-scenario convergence under link (warp_scenario_under_link)
//!   - battle-lock mid-stream freeze check (apply_stream_with_battle_lock)
//! Pure function of seeds — no wall clock, no global RNG.

use std::collections::BTreeMap;

use game_core::{tick_seed, Direction, MoveInput, TilePos};
use sim_harness::{
    apply_stream, apply_stream_with_battle_lock, battle_lock_scenario, deliver, had_reorder,
    random_scenario, scenario, warp_scenario_under_link, ApplyOrder, ClientIntent, Link,
};

/// A fixed spread of seeds — convergence must hold for every one, and reorder +
/// loss must each occur for at least one.
const SEEDS: [u64; 16] = [
    0xDEAD_BEEF,
    0xC0FF_EE42,
    0x1234_5678,
    0xABCD_EF01,
    0x9999_0000,
    0xF00D_CAFE,
    0x0101_0101,
    0xBEEF_CAFE,
    0x5EED_0001,
    0x5EED_0002,
    0x5EED_0003,
    0x5EED_0004,
    0xA5A5_A5A5,
    0x3C3C_3C3C,
    0x7777_7777,
    0x2468_ACE0,
];

fn main() {
    // The standard jittered, lossy link the netcode tests build on.
    let link = Link {
        base_latency: 50,
        jitter: 40,
        loss_pct: 20,
    };
    let intents = scenario();
    let total = intents.len();

    let mut seq_canonical_converges = true;
    let mut reorder_occurred = false;
    let mut loss_occurred = false;
    // Non-vacuity: on the REAL scenario, at least one reordered seed where the
    // contract genuinely changes the outcome (Arrival != SeqCanonical). Without
    // this, "convergence" could be a sort tautology over a stream reorder never
    // touched. With it, we prove reorder WOULD break the world absent the contract.
    let mut contract_bites_on_scenario = false;

    for &seed in &SEEDS {
        let survivors = deliver(&intents, &link, seed);

        // Convergence: the seq-canonical apply must yield the SAME authoritative
        // final tiles for ANY delivery-order permutation of the same surviving
        // set. Check the link order, its reverse, and a (client,seq)-descending
        // scramble — the hardest case for a naive re-sort.
        let mut reversed = survivors.clone();
        reversed.reverse();
        let mut inverted = survivors.clone();
        inverted.sort_by_key(|i| (std::cmp::Reverse(i.client), std::cmp::Reverse(i.seq)));

        let canonical = apply_stream(&survivors, ApplyOrder::SeqCanonical);
        let b = apply_stream(&reversed, ApplyOrder::SeqCanonical);
        let c = apply_stream(&inverted, ApplyOrder::SeqCanonical);
        if canonical != b || canonical != c {
            seq_canonical_converges = false;
        }

        let reordered = had_reorder(&survivors);
        if reordered {
            reorder_occurred = true;
            // The contract bites iff applying the SAME survivors in raw arrival
            // order (no seq contract) diverges from the seq-ordered result.
            if apply_stream(&survivors, ApplyOrder::Arrival) != canonical {
                contract_bites_on_scenario = true;
            }
        }
        if survivors.len() < total {
            loss_occurred = true;
        }
    }

    // Proof-of-teeth (deterministic fixture): the naive arrival-order apply
    // DIVERGES on a reordered delivery, with the EXACT positions the geometry
    // dictates. Two East steps from spawn (1,1): in send order both apply → (3,1);
    // delivered seq-2-first, the server rejects the later seq-1 as stale → (2,1).
    // Requiring the exact tiles (not mere inequality) rejects an Arrival that
    // diverges for the wrong reason (e.g. time-based instead of seq-based staleness).
    let east = |seq, send_ms| ClientIntent {
        client: 0,
        seq,
        input: MoveInput::Step(Direction::East),
        send_ms,
    };
    let seq1 = east(1, 100);
    let seq2 = east(2, 300);
    let tile = |x, y| {
        let mut m: BTreeMap<u64, TilePos> = BTreeMap::new();
        m.insert(0, TilePos { x, y });
        m
    };
    let arrival_in_order = apply_stream(&[seq1, seq2], ApplyOrder::Arrival);
    let arrival_reordered = apply_stream(&[seq2, seq1], ApplyOrder::Arrival);
    let fixture_bites = arrival_in_order == tile(3, 1) && arrival_reordered == tile(2, 1);

    // The teeth require BOTH the exact deterministic fixture AND the scenario-level
    // contract effect — so the convergence gate is never a vacuous sort tautology.
    let naive_diverges_on_teeth = fixture_bites && contract_bites_on_scenario;

    // =========================================================================
    // 128-seed randomized convergence (M14.5f): random_scenario with varied
    // seeds exercises the anti-flood burst path and Jump inputs.
    // =========================================================================
    const RANDOM_SEED_COUNT: usize = 128;
    let random_seeds: Vec<u64> = {
        let mut s = 0x14_5F_0000_CAFEu64;
        (0..RANDOM_SEED_COUNT as u64)
            .map(|i| {
                s = tick_seed(s, i, 0x14_5F_0000_CAFE);
                s
            })
            .collect()
    };
    const RANDOM_N_INTENTS: usize = 32;
    let mut randomized_converges = true;
    for &seed in &random_seeds {
        let intents = random_scenario(seed, RANDOM_N_INTENTS);
        let survivors = deliver(&intents, &link, seed);
        let mut reversed = survivors.clone();
        reversed.reverse();
        let mut inverted = survivors.clone();
        inverted.sort_by_key(|i| (std::cmp::Reverse(i.client), std::cmp::Reverse(i.seq)));
        let canonical = apply_stream(&survivors, ApplyOrder::SeqCanonical);
        let b = apply_stream(&reversed, ApplyOrder::SeqCanonical);
        let c = apply_stream(&inverted, ApplyOrder::SeqCanonical);
        if canonical != b || canonical != c {
            randomized_converges = false;
        }
    }

    // =========================================================================
    // Warp-scenario convergence under link (M14.5f / 12.5f-1):
    // SeqCanonical is delivery-order-invariant even when the warp step is
    // reordered. Non-vacuity: at least one seed must produce a reorder
    // (jitter=40 guarantees this across 8 seeds).
    // =========================================================================
    const WARP_SEEDS: [u64; 8] = [
        0xDEAD_BEEF,
        0xC0FF_EE42,
        0x1234_5678,
        0xABCD_EF01,
        0x9999_0000,
        0xF00D_CAFE,
        0x0101_0101,
        0xBEEF_CAFE,
    ];
    let mut warp_convergence = true;
    let mut warp_reorder_occurred = false;
    for &seed in &WARP_SEEDS {
        let (conv, reordered) = warp_scenario_under_link(&link, seed);
        if !conv {
            warp_convergence = false;
        }
        if reordered {
            warp_reorder_occurred = true;
        }
    }
    // Non-vacuity: at least one warp seed must produce a reorder.
    if !warp_reorder_occurred {
        warp_convergence = false;
    }

    // =========================================================================
    // Battle-lock mid-stream freeze (M14.5f):
    // Client 0 is locked after 4 ticks (4 East steps from spawn = (5,1)).
    // Client 1 is never locked; walks 8 East from spawn, hitting wall at (7,1).
    // =========================================================================
    let battle_lock_final = apply_stream_with_battle_lock(&battle_lock_scenario(), 0, 4);
    let locked_pos = battle_lock_final
        .get(&0)
        .copied()
        .unwrap_or(TilePos { x: 0, y: 0 });
    let unlocked_pos = battle_lock_final
        .get(&1)
        .copied()
        .unwrap_or(TilePos { x: 0, y: 0 });
    // Client 0: spawn (1,1) + 4 East = (5,1), then frozen.
    let locked_frozen = locked_pos == TilePos { x: 5, y: 1 };
    // Client 1: must have advanced further east than the locked client.
    let other_progressed = unlocked_pos.x > locked_pos.x;
    let battle_lock_convergence = locked_frozen && other_progressed;

    println!(
        "{{\"seeds_tested\":{},\"seq_canonical_converges\":{seq_canonical_converges},\
\"reorder_occurred\":{reorder_occurred},\"loss_occurred\":{loss_occurred},\
\"naive_diverges_on_teeth\":{naive_diverges_on_teeth},\
\"randomized_seeds_tested\":{RANDOM_SEED_COUNT},\
\"randomized_converges\":{randomized_converges},\
\"warp_convergence\":{warp_convergence},\
\"battle_lock_convergence\":{battle_lock_convergence}}}",
        SEEDS.len()
    );
}
