//! `sim-harness` — a headless, deterministic, multi-client driver.
//!
//! It owns an injected clock + seed and replays a fixed rule sequence, asserting
//! replay-determinism (identical seed => identical final state). The seeded
//! netcode `Link` (latency / loss / reorder) makes netcode testable in CI without
//! a browser — every decision derives from a seed, never a wall clock or global
//! RNG (the determinism contract; enforced by clippy).

#![forbid(unsafe_code)]

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
            let jit = if self.jitter == 0 { 0 } else { (r >> 8) % (self.jitter + 1) };
            out.push(Delivered { id: m.id, recv_ms: m.send_ms + self.base_latency + jit });
        }
        out.sort_by_key(|d| (d.recv_ms, d.id));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::{Link, Msg, replay};

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
        let link = Link { base_latency: 50, jitter: 20, loss_pct: 10 };
        let msgs: Vec<Msg> = (0..200).map(|id| Msg { id, send_ms: id * 16 }).collect();
        assert_eq!(link.transport(&msgs, 0xC0FFEE), link.transport(&msgs, 0xC0FFEE));
    }

    #[test]
    fn transport_drops_some_but_not_all_under_loss() {
        let link = Link { base_latency: 0, jitter: 0, loss_pct: 50 };
        let msgs: Vec<Msg> = (0..1000).map(|id| Msg { id, send_ms: 0 }).collect();
        let delivered = link.transport(&msgs, 1);
        assert!(delivered.len() < msgs.len());
        assert!(!delivered.is_empty());
    }

    #[test]
    fn lossless_link_delivers_all() {
        let link = Link { base_latency: 10, jitter: 0, loss_pct: 0 };
        let msgs: Vec<Msg> = (0..50).map(|id| Msg { id, send_ms: id }).collect();
        assert_eq!(link.transport(&msgs, 7).len(), msgs.len());
    }
}
