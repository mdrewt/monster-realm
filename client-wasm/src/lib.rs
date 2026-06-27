//! `client-wasm` — the thin client-side prediction shell.
//!
//! Wraps `game-core` (the SAME rule code the server runs) for client-side
//! prediction, exported across the wasm boundary via `wasm-bindgen` and built
//! with `wasm-pack`. It depends on `game-core` WITHOUT the `spacetimedb` feature —
//! the client must never pull a server-only dependency (the feature-isolation
//! eval makes this mechanical).
//!
//! The prediction-parity evals run these exports natively (the server path) and
//! through the wasm-pack build and assert byte-identical output — the anti-desync
//! spine — before any real rule depends on it.

#![forbid(unsafe_code)]

use wasm_bindgen::prelude::*;

use game_core::{CharacterState, Millis, MoveInput};

/// The M0 trivial proof-rule across the wasm boundary (`u64` <-> `BigInt`).
#[wasm_bindgen]
pub fn predict_tick(state: u64, input: u64, seed: u64) -> u64 {
    game_core::tick_seed(state, input, seed)
}

/// Predict movement over `zone_0` — the SAME `apply_move` the server runs, across
/// the wasm boundary, for the movement-parity eval. Flat codes (see game-core):
/// facing/dir 0=N,1=S,2=E,3=W; action 0=Idle,1=Walk,2=Jump; input_kind 0=Step,
/// 1=Jump. Returns `[x, y, facing_code, action_code]` (an `Int32Array` in JS).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn predict_move(
    x: i32,
    y: i32,
    facing: u8,
    action: u8,
    started_ms: i64,
    input_kind: u8,
    step_dir: u8,
    now_ms: i64,
) -> Vec<i32> {
    game_core::apply_move_coded(
        x, y, facing, action, started_ms, input_kind, step_dir, now_ms,
    )
    .to_vec()
}

// --- M3: the JS-consumable marshaling boundary (NO game rules live here) ------
// Each export marshals JS -> game-core serde types, delegates to game-core, and
// marshals the result back. The no-logic-in-wrapper eval proves no rule (a `match`
// on `Direction`, a walkability check, a `.step`) ever lives in this file.

/// Predict one move across `zone_0` from JS: deserialize `state`/`input`, call the
/// SAME `game_core::apply_move` the server runs, and serialize the next state back.
/// `now` is a JS `performance.now()`-style float; it is floored and clamped to a
/// sane `>= 0` baseline before becoming the integer `Millis` the rule consumes.
///
/// # Errors
/// Returns a JS error if `state` or `input` is not a valid serde shape (e.g. a
/// fractional `move_started_at`, which the integer `Millis` rejects at the boundary).
#[wasm_bindgen]
pub fn apply_move(state: JsValue, input: JsValue, now: f64) -> Result<JsValue, JsValue> {
    let state: CharacterState = serde_wasm_bindgen::from_value(state)?;
    let input: MoveInput = serde_wasm_bindgen::from_value(input)?;
    let next = game_core::apply_move(
        &state,
        input,
        &game_core::zone_0(),
        Millis(now.floor().max(0.0) as i64),
    );
    Ok(serde_wasm_bindgen::to_value(&next)?)
}

/// The step cadence (ms per tile), single-sourced from `game-core` so TS never
/// hard-codes it.
#[wasm_bindgen]
#[must_use]
pub fn step_ms() -> u32 {
    game_core::STEP_MS as u32
}

/// The bounded move-queue cap, single-sourced from `game-core`.
#[wasm_bindgen]
#[must_use]
pub fn move_queue_cap() -> u32 {
    game_core::MOVE_QUEUE_CAP as u32
}

/// The renderer's map source: the SAME `TileMap` the rule evaluates, read ONCE on
/// init (the map is static at M3 — never per frame, never hard-coded in TS).
/// `zone_id` is reserved for M11 multi-zone; only `zone_0` exists today.
///
/// M8c: the `TileMap`'s new `grass` layer (row-major `bool[]`) serializes along
/// here automatically (additive serde field) — the TS `RawTileMap.grass` reads it
/// for the renderer's grass overlay, no extra wiring.
///
/// # Errors
/// Returns a JS error only if serialization fails (it cannot for the static map).
#[wasm_bindgen]
pub fn zone_map(_zone_id: u32) -> Result<JsValue, JsValue> {
    Ok(serde_wasm_bindgen::to_value(&game_core::zone_0())?)
}

/// Install a browser panic hook so a Rust panic surfaces as a readable
/// `console.error` instead of an opaque `unreachable`. Runs once on module init.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[cfg(test)]
mod tests {
    #[test]
    fn tick_matches_game_core() {
        assert_eq!(super::predict_tick(1, 2, 3), game_core::tick_seed(1, 2, 3));
    }

    #[test]
    fn move_matches_game_core() {
        assert_eq!(
            super::predict_move(1, 1, 0, 0, 0, 0, 2, 1000),
            game_core::apply_move_coded(1, 1, 0, 0, 0, 0, 2, 1000).to_vec()
        );
    }

    // M8.5f / ADR-0052 Criterion C — PARTY SSOT parity
    //
    // RED-by-non-compilation: `super::party_size()` and `super::party_slot_none()`
    // do not exist yet; `game_core::PARTY_SIZE` and `game_core::PARTY_SLOT_NONE`
    // are not exported yet. The implementer adds:
    //   - `pub const PARTY_SIZE: u8 = 6;` in game-core/src/world.rs + pub use
    //   - `pub const PARTY_SLOT_NONE: u8 = 255;` in game-core/src/world.rs + pub use
    //   - `pub fn party_size() -> u32 { game_core::PARTY_SIZE as u32 }` in lib.rs
    //   - `pub fn party_slot_none() -> u32 { game_core::PARTY_SLOT_NONE as u32 }` in lib.rs
    //
    // Wrong impls killed:
    //   party_size() returning a literal `6u32` not sourced from game_core::PARTY_SIZE
    //   → changing game_core::PARTY_SIZE would not propagate (assert_eq fails if they drift)
    //   party_slot_none() returning a literal `255u32` not sourced from game_core::PARTY_SLOT_NONE
    //   → same drift risk
    #[test]
    fn party_size_matches_game_core_const() {
        // Fails to compile until `party_size()` export and `game_core::PARTY_SIZE` exist.
        assert_eq!(super::party_size(), game_core::PARTY_SIZE as u32);
    }

    #[test]
    fn party_slot_none_matches_game_core_const() {
        // Fails to compile until `party_slot_none()` export and `game_core::PARTY_SLOT_NONE` exist.
        assert_eq!(super::party_slot_none(), game_core::PARTY_SLOT_NONE as u32);
    }
}
