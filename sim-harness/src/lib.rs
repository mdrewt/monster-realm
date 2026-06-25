//! `sim-harness` — a headless, deterministic, multi-client driver.
//!
//! It owns an injected clock + seed and replays a fixed rule sequence, asserting
//! replay-determinism (identical seed => identical final state). The
//! latency/loss/reorder injection used from M1 is a skeleton here.

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

#[cfg(test)]
mod tests {
    use super::replay;

    #[test]
    fn replay_is_deterministic() {
        assert_eq!(replay(500, 0xABCD), replay(500, 0xABCD));
    }

    #[test]
    fn replay_depends_on_seed() {
        assert_ne!(replay(500, 0xABCD), replay(500, 0x1234));
    }
}
