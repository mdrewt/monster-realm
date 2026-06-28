//! Convergence check for the `netcode-convergence` eval (M8.8d): feeds the lossy/
//! reordering `Link` into the authoritative `ServerWorld` and reports (as JSON)
//! that the authoritative final state is delivery-order-INVARIANT under the
//! seq-canonical apply (convergence — ADR-0013), that reorder + loss actually
//! occur on the jittered scenario, and that the naive arrival-order apply DIVERGES
//! on a known-bad reorder fixture (proof-of-teeth — the convergence property is
//! only meaningful if the naive policy provably fails). Pure function of seeds —
//! no wall clock, no global RNG.

use game_core::{Direction, MoveInput};
use sim_harness::{apply_stream, deliver, had_reorder, scenario, ApplyOrder, ClientIntent, Link};

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

        let a = apply_stream(&survivors, ApplyOrder::SeqCanonical);
        let b = apply_stream(&reversed, ApplyOrder::SeqCanonical);
        let c = apply_stream(&inverted, ApplyOrder::SeqCanonical);
        if a != b || a != c {
            seq_canonical_converges = false;
        }

        if had_reorder(&survivors) {
            reorder_occurred = true;
        }
        if survivors.len() < total {
            loss_occurred = true;
        }
    }

    // Proof-of-teeth: the naive arrival-order apply DIVERGES on a reordered
    // delivery. Two East steps from spawn (1,1): in send order both apply → (3,1);
    // delivered seq-2-first, the server rejects the later seq-1 as stale → (2,1).
    // A reorder-robust (or accidentally order-independent) Arrival impl would make
    // these equal and collapse the teeth — so the eval requires them to DIFFER.
    let east = |seq, send_ms| ClientIntent {
        client: 0,
        seq,
        input: MoveInput::Step(Direction::East),
        send_ms,
    };
    let seq1 = east(1, 100);
    let seq2 = east(2, 300);
    let arrival_in_order = apply_stream(&[seq1, seq2], ApplyOrder::Arrival);
    let arrival_reordered = apply_stream(&[seq2, seq1], ApplyOrder::Arrival);
    let naive_diverges_on_teeth = arrival_in_order != arrival_reordered;

    println!(
        "{{\"seeds_tested\":{},\"seq_canonical_converges\":{seq_canonical_converges},\"reorder_occurred\":{reorder_occurred},\"loss_occurred\":{loss_occurred},\"naive_diverges_on_teeth\":{naive_diverges_on_teeth}}}",
        SEEDS.len()
    );
}
