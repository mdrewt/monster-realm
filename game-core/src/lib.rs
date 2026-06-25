//! monster-realm `game-core` — the single, pure, deterministic rule layer.
//!
//! Every game rule lives here exactly once (ADR-0003, SSOT). The server runs it
//! for truth; the client runs the *same compiled code* (via `client-wasm`) for
//! prediction. Re-implementing a rule elsewhere is the desync bug.
//!
//! Purity is mechanically enforced: `clippy.toml` (`disallowed-methods`) bans
//! wall-clock reads and unseeded RNG workspace-wide, so a rule that reaches for
//! `SystemTime::now()` or `thread_rng()` fails `just lint`. Time and randomness
//! are *injected*: the server passes `ctx.timestamp` as `Millis`, tests seed an
//! explicit RNG, and `sim-harness` drives a deterministic clock + seed.

#![forbid(unsafe_code)]

/// Wall-clock milliseconds, injected at the boundary. `game-core` never reads a
/// clock itself; callers pass time in (the M0 clock contract).
pub type Millis = i64;

/// The trivial M0 proof-rule: a pure, deterministic state transition over an
/// explicit seed (splitmix64-style mix). It exists only to prove the
/// determinism/parity gates have teeth before any real rule (M1 movement)
/// depends on them. Identical `(state, input, seed)` returns byte-identical
/// output on every target (native server path and the wasm client path).
#[must_use]
pub fn tick_seed(state: u64, input: u64, seed: u64) -> u64 {
    let mut z = state
        .wrapping_add(input)
        .wrapping_add(seed)
        .wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Pure movement helper (the one rule layer's home for it): clamp a coordinate
/// into `[-max, max]`. Integer-tile authority means server and client cannot
/// numerically diverge.
#[must_use]
pub fn clamp_position(v: i32, max: i32) -> i32 {
    v.clamp(-max, max)
}

#[cfg(test)]
mod tests {
    use super::{clamp_position, tick_seed};

    #[test]
    fn tick_seed_is_referentially_deterministic() {
        assert_eq!(tick_seed(1, 2, 3), tick_seed(1, 2, 3));
    }

    #[test]
    fn tick_seed_replay_is_byte_identical() {
        // Poor-man's property test (real `proptest` lands with the test-tooling
        // slice + its ADR): replaying the same sequence yields the identical trace.
        let trace_a: Vec<u64> = (0..1000)
            .map(|i| tick_seed(i, i.wrapping_mul(7), i ^ 0xDEAD))
            .collect();
        let trace_b: Vec<u64> = (0..1000)
            .map(|i| tick_seed(i, i.wrapping_mul(7), i ^ 0xDEAD))
            .collect();
        assert_eq!(trace_a, trace_b);
    }

    #[test]
    fn tick_seed_depends_on_seed() {
        // Else "determinism" would be vacuous.
        assert_ne!(tick_seed(1, 2, 3), tick_seed(1, 2, 4));
    }

    #[test]
    fn clamp_position_bounds() {
        assert_eq!(clamp_position(1500, 1000), 1000);
        assert_eq!(clamp_position(-1500, 1000), -1000);
        assert_eq!(clamp_position(42, 1000), 42);
    }
}
