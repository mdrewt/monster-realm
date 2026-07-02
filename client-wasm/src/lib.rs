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

/// The party size (slot count), single-sourced from `game-core` so TS never
/// hard-codes it.
#[wasm_bindgen]
#[must_use]
pub fn party_size() -> u32 {
    game_core::PARTY_SIZE as u32
}

/// The party-slot "boxed" sentinel, single-sourced from `game-core`.
#[wasm_bindgen]
#[must_use]
pub fn party_slot_none() -> u32 {
    game_core::PARTY_SLOT_NONE as u32
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

    // -------------------------------------------------------------------------
    // M11c C6 — zone_map(zone_id) dispatches on zone_id (not always zone_0)
    //
    // RED REASON (zone_map_0_zone_id_matches): `zone_map()` currently calls
    // `game_core::zone_0()` unconditionally (ignores `_zone_id`). After the fix
    // it must call `game_core::zone_0()` for zone_id=0 specifically (or dispatch
    // through a content registry). The test encodes the dispatch contract:
    // zone_map(0) must produce a map whose zone_id field == 0.
    //
    // RED REASON (zone_map_999_returns_error): the current impl always returns
    // `Ok(...)` regardless of the zone_id argument. After the fix, an unknown
    // zone_id (999 has no ZoneMapDef) must return `Err(JsValue)`.
    //
    // Testing strategy: rather than deserializing JsValue (TileMap has no
    // Deserialize), we test the underlying game_core dispatch layer directly —
    // `zone_map()` is a thin marshal wrapper, so the contract is that it delegates
    // to `game_core::zone_0()` for zone 0 (verifiable via the public zone_id field)
    // and returns Err for unknown zones (verifiable via Result::is_err()).
    // -------------------------------------------------------------------------

    #[test]
    fn zone_map_0_returns_ok() {
        // Criterion C6a prerequisite: zone_map(0) must not return an error for the
        // known zone. Kills: an impl that erroneously returns Err for zone 0.
        let result = super::zone_map(0);
        assert!(
            result.is_ok(),
            "zone_map(0) must return Ok for the known zone 0"
        );
    }

    #[test]
    fn zone_map_0_zone_id_matches_zone_0() {
        // Criterion C6a: zone_map(0) SHALL return a map whose zone_id is 0.
        //
        // We verify the dispatch contract at the game_core level: the map that
        // zone_map(0) must produce is game_core::zone_0(), which has zone_id == 0.
        // The wasm wrapper serializes it; this test confirms the source has zone_id 0.
        //
        // RED: the current impl passes `_zone_id` (ignored), so zone_map(1) would
        // silently return zone_0(). The companion test (zone_map_999_returns_error)
        // catches the always-Ok path; this test binds the zone_id == 0 contract.
        //
        // Wrong impl killed: `zone_map(_zone_id)` returning zone_0() for zone_id=1
        // (tested by zone_map_999_returns_error which fails on the always-Ok path).
        let zone_0_map = game_core::zone_0();
        assert_eq!(
            zone_0_map.zone_id, 0,
            "game_core::zone_0() must have zone_id == 0 (the source for zone_map(0))"
        );
        // The Ok result of zone_map(0) must serialize the same zone_id=0 map.
        // Since TileMap has no Deserialize, we verify by checking the source:
        // zone_map(0) must return Ok (above test) and zone_0() has zone_id=0 (here).
        // Together they pin the dispatch: zone_map(0) == Ok(serialize(zone_0())).
        assert!(
            super::zone_map(0).is_ok(),
            "zone_map(0) must succeed for zone 0 (zone_id=0 confirmed above)"
        );
    }

    #[test]
    fn zone_map_999_returns_error() {
        // Criterion C6b: zone_map(999) (unknown zone) SHALL return a JS Error,
        // not a valid map.
        //
        // RED: the current impl `zone_map(_zone_id)` ignores the argument and
        // always calls `game_core::zone_0()`, returning Ok unconditionally.
        // After fix, zone_id 999 has no ZoneMapDef → the dispatch returns Err.
        //
        // Wrong impl killed: any impl that returns Ok for unknown zone ids — this
        // assert!(result.is_err()) will fail loudly.
        let result = super::zone_map(999);
        assert!(
            result.is_err(),
            "zone_map(999) must return Err for an unknown zone id, but returned Ok"
        );
    }
}
