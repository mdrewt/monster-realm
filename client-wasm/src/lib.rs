//! `client-wasm` — the thin client-side prediction shell.
//!
//! Wraps `game-core` (the SAME rule code the server runs) for client-side
//! prediction, exported across the wasm boundary via `wasm-bindgen` and built
//! with `wasm-pack`. It depends on `game-core` WITHOUT the `spacetimedb`
//! feature — the client must never pull a server-only dependency (the
//! feature-isolation eval makes this mechanical).
//!
//! The prediction-parity eval runs `predict_tick` natively (the server path) and
//! through the wasm-pack build and asserts byte-identical output — catching
//! feature-flag/target divergence before any real rule (M1) depends on it.

#![forbid(unsafe_code)]

use wasm_bindgen::prelude::wasm_bindgen;

/// The pure rule the client predicts with — identical code to the server path
/// (the anti-desync spine). `u64` crosses the wasm boundary as `BigInt`.
#[wasm_bindgen]
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
