//! `sim-harness` — a headless, deterministic, multi-client driver.
//!
//! It owns an injected clock + seed and replays a fixed rule sequence, asserting
//! replay-determinism (identical seed => identical final state). The seeded
//! netcode `Link` (latency / loss / reorder) makes netcode testable in CI without
//! a browser — every decision derives from a seed, never a wall clock or global
//! RNG (the determinism contract; enforced by clippy).

#![forbid(unsafe_code)]

/// Headless model of the M2 server movement loop (queue + per-zone tick).
pub mod world;

use game_core::tick_seed;

/// A deterministic clock the harness advances explicitly — never a wall clock.
#[derive(Debug, Clone)]
pub struct SimClock {
    now: u64,
    step: u64,
}

impl SimClock {
    #[must_use]
    pub fn new(start: u64, step: u64) -> Self {
        Self { now: start, step }
    }

    /// Advance one step and return the time *before* advancing.
    pub fn tick(&mut self) -> u64 {
        let t = self.now;
        self.now = self.now.wrapping_add(self.step);
        t
    }
}

/// Replay a fixed-length rule sequence from an injected seed, folding the rule
/// over a deterministic clock. Returns the final state.
#[must_use]
pub fn replay(steps: u32, seed: u64) -> u64 {
    let mut clock = SimClock::new(0, 16); // ~60Hz tick, injected (no wall clock)
    let mut state = 0u64;
    for i in 0..steps {
        let t = clock.tick();
        state = tick_seed(state, u64::from(i).wrapping_add(t), seed);
    }
    state
}

/// Reuse the pure rule as a seeded hash for netcode decisions (no global RNG).
#[must_use]
fn mix(a: u64, b: u64) -> u64 {
    tick_seed(a, b, 0x5DEE_CE66)
}

/// A message in flight, stamped with its send time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Msg {
    pub id: u64,
    pub send_ms: u64,
}

/// A delivered message with its (latency/jitter-adjusted) receive time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Delivered {
    pub id: u64,
    pub recv_ms: u64,
}

/// A deterministic, seeded netcode link: latency delays delivery, jitter perturbs
/// it (reorder emerges), loss drops a fraction. Used for headless netcode tests
/// from M1; the behaviour is a pure function of `(msgs, seed)`.
#[derive(Debug, Clone, Copy)]
pub struct Link {
    pub base_latency: u64,
    pub jitter: u64,
    pub loss_pct: u8,
}

impl Link {
    /// Transport messages over the link deterministically from a seed, returning
    /// the delivered messages sorted by receive time (then id).
    #[must_use]
    pub fn transport(&self, msgs: &[Msg], seed: u64) -> Vec<Delivered> {
        let mut out: Vec<Delivered> = Vec::with_capacity(msgs.len());
        for m in msgs {
            let r = mix(m.id, seed);
            if (r % 100) < u64::from(self.loss_pct) {
                continue; // dropped (deterministic for this seed)
            }
            let jit = if self.jitter == 0 {
                0
            } else {
                (r >> 8) % (self.jitter + 1)
            };
            out.push(Delivered {
                id: m.id,
                recv_ms: m.send_ms + self.base_latency + jit,
            });
        }
        out.sort_by_key(|d| (d.recv_ms, d.id));
        out
    }
}

// ===========================================================================
// Convergence driver (M8.8d) — feeds the lossy/reordering `Link` into the
// authoritative `ServerWorld`, proving the headline netcode property (ADR-0013):
// under latency/jitter/loss/reorder the authoritative final state is
// *delivery-order-invariant* (convergence — no desync). The naive arrival-order
// apply is order-DEPENDENT under reorder; that is the known-bad fixture the
// convergence assertion must reject (proof-of-teeth).
//
// Deferred to M16-PvP (ADR-0025), NOT claimed here: forfeit-on-disconnect and
// turn-deadline. This driver asserts convergence + reorder-occurs only.
// ===========================================================================

use std::collections::{BTreeMap, BTreeSet};

use game_core::{zone_0, Direction, Millis, MoveInput, TilePos};

use crate::world::ServerWorld;

/// The single zone all simulated clients share (zone 0); the per-zone tick drains
/// every client each step (movement is per-character — there is no cross-character
/// collision, so a shared zone is the strongest convergence stress).
const CONVERGE_ZONE: u32 = 0;

/// Monotonic tick spacing for the driver. The authoritative final *tile* is
/// independent of `now` (apply_move stamps `move_started_at` but derives position
/// only from the move + map), so this value is cosmetic — it just keeps the
/// injected clock advancing (never a wall clock).
const TICK_MS: i64 = 16;

/// One client's single intent: a per-client monotonic `seq`, the move, and its
/// send time. Each `client` is an independent character in the same zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientIntent {
    pub client: u64,
    pub seq: u64,
    pub input: MoveInput,
    pub send_ms: u64,
}

/// How the server applies the (lossy, reordered) delivered stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOrder {
    /// Canonicalize each client's intents by `seq` before applying — the
    /// reorder-robust policy whose authoritative final state is delivery-order
    /// invariant (convergence).
    SeqCanonical,
    /// Apply in raw arrival (delivery) order — the naive, order-DEPENDENT policy
    /// (a reordered higher `seq` makes the server reject the later-arriving lower
    /// `seq` as stale); the known-bad fixture the convergence assertion rejects.
    Arrival,
}

/// Transport `intents` over `link` for `seed` (loss + reorder), returning the
/// surviving delivered intents in link delivery order (by recv time, then id).
///
/// Each intent is stamped with a stable msg id (its index) so the delivered
/// stream can be mapped back to the originating `ClientIntent`.
#[must_use]
pub fn deliver(intents: &[ClientIntent], link: &Link, seed: u64) -> Vec<ClientIntent> {
    let msgs: Vec<Msg> = intents
        .iter()
        .enumerate()
        .map(|(i, it)| Msg {
            id: i as u64,
            send_ms: it.send_ms,
        })
        .collect();
    link.transport(&msgs, seed)
        .into_iter()
        .map(|d| intents[d.id as usize]) // id is the index we stamped above
        .collect()
}

/// Apply a given ORDER of (delivered, surviving) intents to a fresh
/// `ServerWorld`, returning each client's final authoritative tile.
///
/// One character is joined per distinct client (in sorted client order, so char
/// ids are stable regardless of policy). Under [`ApplyOrder::SeqCanonical`] each
/// client's intents are re-sorted by `seq` before applying — so the authoritative
/// result is independent of the link's delivery order (convergence). Under
/// [`ApplyOrder::Arrival`] intents are applied in the given (delivery) order, so a
/// reordered higher `seq` makes the server reject the later-arriving lower `seq`
/// as stale (order-dependent — the known-bad fixture).
///
/// Each intent is enqueued (a stale/full `Err` is dropped, exactly as the
/// authoritative reducer rejects-not-clamps) then the zone is ticked once to drain
/// it — a 1:1 server model in which every accepted intent applies. The final tile
/// is therefore a pure function of the *accepted* intent subsequence.
#[must_use]
pub fn apply_stream(ordered: &[ClientIntent], policy: ApplyOrder) -> BTreeMap<u64, TilePos> {
    let map = zone_0();
    let mut world = ServerWorld::new();

    // Join one character per distinct client, in sorted client order → stable
    // char ids regardless of apply policy / delivery order.
    let clients: BTreeSet<u64> = ordered.iter().map(|it| it.client).collect();
    let char_of: BTreeMap<u64, u64> = clients
        .iter()
        .map(|&c| (c, world.join(CONVERGE_ZONE)))
        .collect();

    // The apply sequence: SeqCanonical canonicalizes per client by seq (reorder-
    // robust); Arrival keeps the given delivery order (order-dependent).
    let sequence: Vec<ClientIntent> = match policy {
        ApplyOrder::Arrival => ordered.to_vec(),
        ApplyOrder::SeqCanonical => {
            let mut v = ordered.to_vec();
            v.sort_by_key(|it| (it.client, it.seq));
            v
        }
    };

    let mut now: i64 = 0;
    for it in &sequence {
        now += TICK_MS;
        // Drop a stale/full Err (the server rejects, never clamps).
        let _ = world.enqueue(char_of[&it.client], it.input, it.seq);
        world.tick_zone(CONVERGE_ZONE, Millis(now), &map);
    }

    clients
        .iter()
        .map(|&c| {
            (
                c,
                world
                    .pos(char_of[&c])
                    .expect("a joined character always has a position"),
            )
        })
        .collect()
}

/// `true` iff `delivered` reorders any client's intents (a lower `seq` is
/// delivered *after* a higher `seq` of the same client) — so a `jitter: 0`
/// regression (which delivers each client strictly in send order) is caught by
/// the reorder-occurs assertion.
#[must_use]
pub fn had_reorder(delivered: &[ClientIntent]) -> bool {
    let mut max_seq_seen: BTreeMap<u64, u64> = BTreeMap::new();
    for it in delivered {
        let m = max_seq_seen.entry(it.client).or_insert(it.seq);
        if it.seq < *m {
            return true; // a lower seq arrived after a higher one for this client
        }
        *m = it.seq;
    }
    false
}

/// The canonical ≥2-client scenario: two characters each walking 6 east steps in
/// zone 0, send times spaced 16 ms (< the jitter window, so the link can reorder
/// adjacent steps) and the two clients offset by 8 ms (interleaved delivery).
/// Twelve intents total — enough that loss (`loss_pct`) drops some and jitter
/// reorders some across seeds. East is walkable from spawn `(1,1)` to `(7,1)`, so
/// every client visibly leaves spawn (the convergence claim is non-vacuous).
#[must_use]
pub fn scenario() -> Vec<ClientIntent> {
    let mut intents = Vec::with_capacity(12);
    for client in 0..2u64 {
        for seq in 1..=6u64 {
            intents.push(ClientIntent {
                client,
                seq,
                input: MoveInput::Step(Direction::East),
                send_ms: (seq - 1) * 16 + client * 8,
            });
        }
    }
    intents
}

// ===========================================================================
// M8.8d convergence gating tests (written by tester; stubs are todo!())
//
// EARS criteria covered:
//   C1 — convergence: apply_stream(SeqCanonical) is delivery-order-invariant
//   C2 — proof-of-teeth: Arrival policy diverges where SeqCanonical converges
//   C3 — reorder occurs for jittered config; does NOT occur under jitter:0
//   C4 — loss actually drops at least some intents under loss_pct > 0
//   C5 — determinism: same seed → byte-identical deliver + apply_stream
//   C6 — scenario sanity: ≥2 distinct clients; both move under lossless apply
//
// Every test in this module is RED until the implementer delivers
// deliver / apply_stream / had_reorder / scenario (no todo!() panic).
// ===========================================================================
#[cfg(test)]
mod convergence_tests {
    use std::collections::BTreeMap;

    use game_core::{Direction, MoveInput, TilePos};

    use super::{apply_stream, deliver, had_reorder, scenario, ApplyOrder, ClientIntent, Link};

    /// The jittery, lossy link used for multi-seed convergence tests.
    fn jittered_link() -> Link {
        Link {
            base_latency: 50,
            jitter: 40,
            loss_pct: 20,
        }
    }

    /// A lossless, zero-jitter link (in-order delivery, no drops).
    fn perfect_link() -> Link {
        Link {
            base_latency: 10,
            jitter: 0,
            loss_pct: 0,
        }
    }

    /// Build the deterministic two-East fixture (client 0 only).
    /// seq 1 → Step(East), seq 2 → Step(East).
    /// send_ms is spaced so that staggered delivery can reorder them.
    fn two_east_intents() -> [ClientIntent; 2] {
        [
            ClientIntent {
                client: 0,
                seq: 1,
                input: MoveInput::Step(Direction::East),
                send_ms: 100,
            },
            ClientIntent {
                client: 0,
                seq: 2,
                input: MoveInput::Step(Direction::East),
                send_ms: 300,
            },
        ]
    }

    // -----------------------------------------------------------------------
    // C1 — SeqCanonical is delivery-order-invariant across multiple seeds
    // -----------------------------------------------------------------------
    // Kill target: an apply_stream(_, SeqCanonical) that re-sorts by recv_ms
    // (arrival order) instead of seq, so different delivery orders → different
    // final tiles. This test catches it by permuting the survivor set and
    // asserting identical BTreeMap output.
    #[test]
    fn convergence_seq_canonical_is_delivery_order_invariant_across_seeds() {
        let link = jittered_link();
        let intents = scenario();

        // Run across several seeds, building two orderings of the same survivors
        // and asserting SeqCanonical gives the same result for both.
        let seeds: [u64; 6] = [
            0xDEAD_BEEF,
            0xC0FF_EE42,
            0x1234_5678,
            0xABCD_EF01,
            0x9999_0000,
            0xF00D_CAFE,
        ];

        for seed in seeds {
            let survivors = deliver(&intents, &link, seed);

            // Build a second ordering by reversing the survivor list.
            let mut reversed = survivors.clone();
            reversed.reverse();

            let result_forward = apply_stream(&survivors, ApplyOrder::SeqCanonical);
            let result_reversed = apply_stream(&reversed, ApplyOrder::SeqCanonical);

            // C1 assertion: same survivors, different delivery order → same final tiles.
            assert_eq!(
                result_forward, result_reversed,
                "seed {seed:#x}: SeqCanonical must be delivery-order-invariant \
                 (a SeqCanonical that applies in arrival order instead of seq \
                 would diverge here — this assertion kills it)"
            );
        }
    }

    // -----------------------------------------------------------------------
    // C2a — SeqCanonical: both orderings reach (3,1) for the two-East fixture
    // -----------------------------------------------------------------------
    // Ground-truth geometry: spawn=(1,1), East→(2,1), East→(3,1).
    // Kill target: an apply_stream that applies only the first-arriving intent
    // and drops the second (would land at (2,1), not (3,1)).
    #[test]
    fn proof_of_teeth_seq_canonical_both_orders_reach_3_1() {
        let [seq1, seq2] = two_east_intents();
        let expected = {
            let mut m = BTreeMap::new();
            m.insert(0u64, TilePos { x: 3, y: 1 });
            m
        };

        // Forward order (seq1 then seq2): both Easts applied in seq order.
        let forward = apply_stream(&[seq1, seq2], ApplyOrder::SeqCanonical);
        assert_eq!(
            forward, expected,
            "SeqCanonical [seq1, seq2]: expected (3,1) — \
             kill target: an impl that applies only seq2 (arriving first) \
             and discards seq1 as 'already processed' would land at (2,1)"
        );

        // Reversed order (seq2 arrives first, seq1 second): SeqCanonical re-sorts
        // by seq, so both Easts still apply → (3,1).
        let reversed = apply_stream(&[seq2, seq1], ApplyOrder::SeqCanonical);
        assert_eq!(
            reversed, expected,
            "SeqCanonical [seq2, seq1]: expected (3,1) — \
             kill target: an impl that applies seq2 (seq=2, East) first, then \
             rejects seq1 as stale (seq < last_seq), landing at (2,1) instead"
        );
    }

    // -----------------------------------------------------------------------
    // C2b — Arrival policy: the two orderings DIFFER (proof-of-teeth)
    // -----------------------------------------------------------------------
    // Kill target: an apply_stream(_, Arrival) that secretly re-sorts by seq
    // (which would make it order-invariant and wrongly identical to SeqCanonical).
    // This test asserts the two Arrival results DIFFER, and asserts the concrete
    // expected values from the spec:
    //   - Arrival [seq1, seq2] → both applied in arrival order → (3,1)
    //   - Arrival [seq2, seq1] → seq2 (seq=2) accepted, seq1 (seq=1 < last_seq=2)
    //     rejected as stale → only one East applied → (2,1)
    // The assert_ne! kills any Arrival impl that is secretly order-independent.
    #[test]
    fn proof_of_teeth_arrival_diverges_on_reordered_delivery() {
        let [seq1, seq2] = two_east_intents();

        // Forward order: seq1 accepted (last_seq 0→1), seq2 accepted (1→2) → (3,1)
        let arrival_forward = apply_stream(&[seq1, seq2], ApplyOrder::Arrival);
        assert_eq!(
            arrival_forward.get(&0),
            Some(&TilePos { x: 3, y: 1 }),
            "Arrival [seq1, seq2]: expected (3,1) — both Easts accepted in order. \
             Kill target: an Arrival impl that applies only the first intent \
             (would give (2,1) and also make the two results equal, hiding the divergence)"
        );

        // Reordered: seq2 (seq=2) arrives first → accepted, last_seq=2.
        // seq1 (seq=1) arrives second → rejected as stale (1 ≤ 2) → only one East → (2,1)
        let arrival_reordered = apply_stream(&[seq2, seq1], ApplyOrder::Arrival);
        assert_eq!(
            arrival_reordered.get(&0),
            Some(&TilePos { x: 2, y: 1 }),
            "Arrival [seq2, seq1]: expected (2,1) — seq2 accepted first, seq1 stale-rejected. \
             Spec ground-truth: spawn=(1,1)+East=(2,1). \
             Kill target: an Arrival impl that secretly re-sorts by seq \
             (would give (3,1) here and wrongly make the two results equal)"
        );

        // The key divergence: Arrival gives DIFFERENT tiles for the two orderings.
        // Kill target: any impl that makes Arrival order-independent.
        assert_ne!(
            arrival_forward, arrival_reordered,
            "Arrival policy must diverge under reorder — an impl that makes Arrival \
             order-independent (secretly SeqCanonical behaviour) kills this assertion. \
             This is the proof-of-teeth: the convergence property is only meaningful \
             if the naive policy provably fails here."
        );
    }

    // -----------------------------------------------------------------------
    // C3a — reorder actually occurs under jittered config
    // -----------------------------------------------------------------------
    // Kill target: a had_reorder that always returns false, or a deliver that
    // never reorders (e.g., sorts by send_ms ignoring jitter). At least one
    // seed from the batch must produce a reordered delivery for this to pass.
    #[test]
    fn reorder_occurs_for_at_least_one_seed_under_jitter() {
        let link = jittered_link();
        let intents = scenario();
        let seeds: [u64; 8] = [
            0xDEAD_BEEF,
            0xC0FF_EE42,
            0x1234_5678,
            0xABCD_EF01,
            0x9999_0000,
            0xF00D_CAFE,
            0x0101_0101,
            0xBEEF_CAFE,
        ];

        let any_reordered = seeds
            .iter()
            .any(|&seed| had_reorder(&deliver(&intents, &link, seed)));

        assert!(
            any_reordered,
            "had_reorder must return true for at least one seed under jitter=40 — \
             a jitter:0 regression (or a had_reorder that always returns false) \
             would never produce reorder and kill this assertion"
        );
    }

    // -----------------------------------------------------------------------
    // C3b — reorder does NOT occur under jitter:0, lossless link
    // -----------------------------------------------------------------------
    // Kill target: a had_reorder that always returns true regardless of the
    // actual delivery order. This catches trivially-true implementations.
    #[test]
    fn reorder_does_not_occur_under_perfect_link() {
        let link = perfect_link();
        let intents = scenario();
        let seeds: [u64; 4] = [0xDEAD_BEEF, 0xC0FF_EE42, 0x1234_5678, 0xABCD_EF01];

        for seed in seeds {
            let survivors = deliver(&intents, &link, seed);
            assert!(
                !had_reorder(&survivors),
                "seed {seed:#x}: had_reorder must be false under jitter=0, lossless link — \
                 a had_reorder that always returns true (trivially vacuous) kills this assertion; \
                 jitter:0 regression is caught here"
            );
        }
    }

    // -----------------------------------------------------------------------
    // C4 — loss actually drops some intents under loss_pct > 0
    // -----------------------------------------------------------------------
    // Kill target: a deliver that ignores loss_pct and always delivers all intents.
    // At least one seed must result in fewer survivors than intents sent.
    #[test]
    fn loss_drops_some_intents_for_at_least_one_seed() {
        let link = jittered_link(); // loss_pct = 20
        let intents = scenario();
        let total = intents.len();
        let seeds: [u64; 6] = [
            0xDEAD_BEEF,
            0xC0FF_EE42,
            0x1234_5678,
            0xABCD_EF01,
            0x9999_0000,
            0xF00D_CAFE,
        ];

        let any_dropped = seeds
            .iter()
            .any(|&seed| deliver(&intents, &link, seed).len() < total);

        assert!(
            any_dropped,
            "deliver must drop at least some intents under loss_pct=20 — \
             a deliver that ignores loss_pct (delivers everything) kills this assertion"
        );
    }

    // -----------------------------------------------------------------------
    // C5 — determinism: same seed → byte-identical deliver + apply_stream
    // -----------------------------------------------------------------------
    // Kill target: a deliver or apply_stream that reads a wall clock or global RNG.
    // Both calls use the same seed — any non-determinism is caught.
    #[test]
    fn deliver_and_apply_stream_are_deterministic_across_identical_seeds() {
        let link = jittered_link();
        let intents = scenario();
        let seeds: [u64; 4] = [0xDEAD_BEEF, 0xC0FF_EE42, 0x1234_5678, 0xABCD_EF01];

        for seed in seeds {
            let run_a = deliver(&intents, &link, seed);
            let run_b = deliver(&intents, &link, seed);

            // C5a: deliver is byte-identical for same seed.
            assert_eq!(
                run_a, run_b,
                "seed {seed:#x}: deliver must be byte-identical for the same seed — \
                 a deliver that uses a global RNG or wall clock kills this assertion"
            );

            // C5b: apply_stream is byte-identical for the same input.
            let map_a = apply_stream(&run_a, ApplyOrder::SeqCanonical);
            let map_b = apply_stream(&run_b, ApplyOrder::SeqCanonical);
            assert_eq!(
                map_a,
                map_b,
                "seed {seed:#x}: apply_stream must be byte-identical for the same input — \
                 a non-deterministic apply_stream kills this assertion (replay-determinism contract)"
            );
        }
    }

    // -----------------------------------------------------------------------
    // C6a — scenario has ≥2 distinct client ids
    // -----------------------------------------------------------------------
    // Kill target: a scenario() that returns only one client (a single character
    // walking alone cannot prove multi-client convergence).
    #[test]
    fn scenario_has_at_least_two_distinct_client_ids() {
        let intents = scenario();
        let clients: std::collections::BTreeSet<u64> = intents.iter().map(|i| i.client).collect();
        assert!(
            clients.len() >= 2,
            "scenario() must have ≥2 distinct client ids (got {}), \
             needed to prove multi-client convergence — \
             a single-client scenario cannot trigger cross-client interaction",
            clients.len()
        );
    }

    // -----------------------------------------------------------------------
    // C6b — both scenario clients change tile under lossless apply
    // -----------------------------------------------------------------------
    // Kill target: a scenario() where one client stays at spawn (e.g., only
    // submits blocked moves or no moves), making the convergence property vacuous
    // for that client.
    #[test]
    fn scenario_both_clients_change_tile_under_lossless_lossless_apply() {
        let link = perfect_link();
        let intents = scenario();

        // Deliver all intents (lossless) and apply with SeqCanonical.
        let survivors = deliver(&intents, &link, 0xDEAD_BEEF);
        let final_tiles = apply_stream(&survivors, ApplyOrder::SeqCanonical);

        // Every client in the scenario must end up somewhere other than spawn.
        let spawn = game_core::spawn(); // TilePos { x: 1, y: 1 }
        let clients: std::collections::BTreeSet<u64> = intents.iter().map(|i| i.client).collect();

        for client_id in clients {
            let pos = final_tiles.get(&client_id).copied().unwrap_or(spawn);
            assert_ne!(
                pos, spawn,
                "client {client_id}: scenario() must have client {client_id} move \
                 away from spawn under a lossless apply — a scenario where a client \
                 only issues blocked moves makes the convergence claim vacuous for it"
            );
        }
    }

    // -----------------------------------------------------------------------
    // C1-extra — convergence also holds when one permutation is sorted ascending
    // by seq vs. descending (covers a rotate permutation, not just reversal)
    // -----------------------------------------------------------------------
    // Kill target: an apply_stream(_, SeqCanonical) that applies intents in
    // the order given and only skips stale seqs (equivalent to Arrival with
    // pre-sort) rather than a full re-sort by seq per client.
    #[test]
    fn convergence_seq_canonical_holds_for_sorted_and_inverted_orderings() {
        let link = jittered_link();
        let intents = scenario();
        let seed = 0xF00D_CAFE_u64;

        let survivors = deliver(&intents, &link, seed);
        if survivors.is_empty() {
            // Degenerate: all dropped. No convergence claim to make. Skip.
            return;
        }

        // Build a "sorted by (client, seq)" ordering (which is what SeqCanonical
        // itself produces internally) and an "inverted" ordering (client desc,
        // seq desc within client — hardest scramble for a simple re-sort impl).
        let mut by_seq = survivors.clone();
        by_seq.sort_by_key(|i| (i.client, i.seq));

        let mut inverted = survivors.clone();
        inverted.sort_by_key(|i| (std::cmp::Reverse(i.client), std::cmp::Reverse(i.seq)));

        let r1 = apply_stream(&by_seq, ApplyOrder::SeqCanonical);
        let r2 = apply_stream(&inverted, ApplyOrder::SeqCanonical);
        assert_eq!(
            r1, r2,
            "SeqCanonical must give the same result whether intents arrive \
             sorted (client,seq) asc or (client,seq) desc — an impl that applies \
             in arrival order and only skips stale seqs (rather than full per-client \
             re-sort) would diverge on these two orderings"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{replay, Link, Msg};

    #[test]
    fn replay_is_deterministic() {
        assert_eq!(replay(500, 0xABCD), replay(500, 0xABCD));
    }

    #[test]
    fn replay_depends_on_seed() {
        assert_ne!(replay(500, 0xABCD), replay(500, 0x1234));
    }

    #[test]
    fn transport_is_deterministic() {
        let link = Link {
            base_latency: 50,
            jitter: 20,
            loss_pct: 10,
        };
        let msgs: Vec<Msg> = (0..200)
            .map(|id| Msg {
                id,
                send_ms: id * 16,
            })
            .collect();
        assert_eq!(
            link.transport(&msgs, 0xC0FFEE),
            link.transport(&msgs, 0xC0FFEE)
        );
    }

    #[test]
    fn transport_drops_some_but_not_all_under_loss() {
        let link = Link {
            base_latency: 0,
            jitter: 0,
            loss_pct: 50,
        };
        let msgs: Vec<Msg> = (0..1000).map(|id| Msg { id, send_ms: 0 }).collect();
        let delivered = link.transport(&msgs, 1);
        assert!(delivered.len() < msgs.len());
        assert!(!delivered.is_empty());
    }

    #[test]
    fn lossless_link_delivers_all() {
        let link = Link {
            base_latency: 10,
            jitter: 0,
            loss_pct: 0,
        };
        let msgs: Vec<Msg> = (0..50).map(|id| Msg { id, send_ms: id }).collect();
        assert_eq!(link.transport(&msgs, 7).len(), msgs.len());
    }
}
