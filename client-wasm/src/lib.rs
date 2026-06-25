//! `client-wasm` — the thin client-side prediction shell.
//!
//! It wraps `game-core` (the SAME rule code the server runs) for client-side
//! prediction. CRITICALLY it depends on `game-core` WITHOUT the `spacetimedb`
//! feature — the client must never pull a server-only dependency (the
//! feature-isolation eval, next slice, makes this mechanical).
//!
//! The `wasm-bindgen` exports + `wasm-pack` build land with the
//! prediction-parity slice; for now this proves the dependency direction.

#![forbid(unsafe_code)]

/// The pure rule the client predicts with — identical code to the server path
/// (the anti-desync spine).
#[must_use]
pub fn predict_tick(state: u64, input: u64, seed: u64) -> u64 {
    game_core::tick_seed(state, input, seed)
}

#[cfg(test)]
mod tests {
    #[test]
    fn predicts_via_game_core() {
        assert_eq!(super::predict_tick(1, 2, 3), game_core::tick_seed(1, 2, 3));
    }
}
