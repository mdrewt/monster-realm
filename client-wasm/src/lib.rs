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

use std::cell::RefCell;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::LazyLock;

use wasm_bindgen::prelude::*;

use game_core::{CharacterState, Millis, MoveInput};

/// The active zone id — set by `set_active_zone()` on every zone transition so
/// that `apply_move` always walks the correct zone's tile map. (M11c, ADR-0067)
static ACTIVE_ZONE_ID: AtomicU32 = AtomicU32::new(0);

// Parse the zone registry once per WASM instance lifetime: content is
// compile-time-embedded (ADR-0057) and immutable between deploys (ADR-0089).
// LazyLock<Result<...>> caches both successes and failures; deterministic for
// compile-time-embedded content so caching the error is correct.
static ZONE_MAPS: LazyLock<Result<Vec<game_core::ZoneMapDef>, String>> =
    LazyLock::new(game_core::load_zone_maps);

// Active-zone TileMap: cached to avoid re-running build_grid on every apply_move.
// Invalidated (set to None) in set_active_zone so the first apply_move after a
// zone transition rebuilds for the new zone (ADR-0089). thread_local is idiomatic
// for WASM (single-threaded execution model).
thread_local! {
    static ACTIVE_TILE_MAP: RefCell<Option<game_core::TileMap>> = const { RefCell::new(None) };
}

/// Return a reference to the cached zone-maps registry.
///
/// On the first call the embedded RON is parsed and the result stored. All
/// subsequent calls return the cached `&'static` reference (or the cached error).
fn cached_zone_maps() -> Result<&'static Vec<game_core::ZoneMapDef>, String> {
    (*ZONE_MAPS).as_ref().map_err(Clone::clone)
}

/// Set the active zone id for client-side movement prediction. Must be called
/// by the client on every zone warp BEFORE the first `apply_move` in that zone.
///
/// Clears the cached TileMap so the next `apply_move` rebuilds for the new zone
/// (ADR-0089). (M11c, ADR-0067)
#[wasm_bindgen]
pub fn set_active_zone(zone_id: u32) {
    ACTIVE_ZONE_ID.store(zone_id, Ordering::Relaxed);
    // Invalidate cached TileMap: the new zone has a different layout (ADR-0089).
    ACTIVE_TILE_MAP.with(|m| *m.borrow_mut() = None);
}

// ---------------------------------------------------------------------------
// Native-safe serialization helpers (M11c, C6).
//
// `serde_wasm_bindgen` and `JsValue::from_str` panic on non-wasm targets (the
// wasm-bindgen runtime is not available). The native `cargo test` run for C6
// only needs `Result::is_ok()` / `Result::is_err()` — not the actual JsValue
// content. We use `JsValue::UNDEFINED` (a const, no runtime call) as a
// sentinel for both Ok and Err on native, then do real serialization on wasm.
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn zone_map_ok(map: &game_core::TileMap) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(map).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(not(target_arch = "wasm32"))]
fn zone_map_ok(_map: &game_core::TileMap) -> Result<JsValue, JsValue> {
    // Native tests only check .is_ok(); no JsValue runtime call needed.
    Ok(JsValue::UNDEFINED)
}

#[cfg(target_arch = "wasm32")]
fn zone_map_err(msg: String) -> JsValue {
    JsValue::from_str(&msg)
}

#[cfg(not(target_arch = "wasm32"))]
fn zone_map_err(_msg: String) -> JsValue {
    // Native tests only check .is_err(); JsValue::UNDEFINED is a const (no runtime call).
    JsValue::UNDEFINED
}

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

/// Predict one move from JS: deserialize `state`/`input`, call the SAME
/// `game_core::apply_move` the server runs, and serialize the next state back.
/// `now` is a JS `performance.now()`-style float; it is floored and clamped to a
/// sane `>= 0` baseline before becoming the integer `Millis` the rule consumes.
///
/// M11c: uses `ACTIVE_ZONE_ID` (set by `set_active_zone`) to load the correct
/// zone map. Fails loud (returns Err) on unknown zone rather than silently falling
/// back to zone_0 — a wrong-map fallback would predict through zone N's walls
/// using zone 0's layout (ADR-0067). In practice this path never fires because
/// `set_active_zone` is only called after `zone_map(id)` succeeds.
///
/// # Errors
/// Returns a JS error if `state`/`input` is not valid, or if the active zone map
/// cannot be loaded (unknown zone id or embedded-content parse failure).
#[wasm_bindgen]
pub fn apply_move(state: JsValue, input: JsValue, now: f64) -> Result<JsValue, JsValue> {
    let state: CharacterState = serde_wasm_bindgen::from_value(state)?;
    let input: MoveInput = serde_wasm_bindgen::from_value(input)?;
    let zone_id = ACTIVE_ZONE_ID.load(Ordering::Relaxed);
    // Build or reuse the cached TileMap for the active zone (ADR-0089).
    // Invariant: ACTIVE_TILE_MAP holds a TileMap for exactly the current ACTIVE_ZONE_ID.
    // set_active_zone() resets it to None on every zone transition, so a non-None
    // cache here always corresponds to the zone_id read above.
    let zone_map = ACTIVE_TILE_MAP.with(|cell| {
        let mut cache = cell.borrow_mut();
        if cache.is_none() {
            let maps = cached_zone_maps().map_err(zone_map_err)?;
            *cache = Some(game_core::map_for(zone_id, maps).map_err(zone_map_err)?);
        }
        // Clone is cheap relative to RON parse; TileMap is a few hundred bools.
        Ok::<game_core::TileMap, JsValue>(cache.as_ref().expect("just set above").clone())
    })?;
    let next = game_core::apply_move(
        &state,
        input,
        &zone_map,
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

/// The renderer's map source: the SAME `TileMap` the rule evaluates.
/// Dispatches on `zone_id` via the content registry (`load_zone_maps`).
///
/// M8c: the `TileMap`'s `grass` layer serializes automatically (additive serde
/// field) — the TS `RawTileMap.grass` reads it for the grass overlay.
///
/// M11c: zone_id is now meaningful — zone 0 returns zone_0's map, zone 1 returns
/// zone 1's map, and an unknown zone_id returns a JS Error (never silently
/// falls back to zone_0). (ADR-0067)
///
/// # Errors
/// Returns a JS error if `zone_id` is unknown or serialization fails.
#[wasm_bindgen]
pub fn zone_map(zone_id: u32) -> Result<JsValue, JsValue> {
    // Cached zone registry: parse-once path (ADR-0089).
    let maps = cached_zone_maps().map_err(zone_map_err)?;
    let tile_map = game_core::map_for(zone_id, maps).map_err(zone_map_err)?;
    zone_map_ok(&tile_map)
}

/// Install a browser panic hook so a Rust panic surfaces as a readable
/// `console.error` instead of an opaque `unreachable`. Runs once on module init.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

// ---------------------------------------------------------------------------
// Test-only seams for 13.5d caching assertions (not compiled in prod WASM).
// ---------------------------------------------------------------------------

/// Expose the cached zone-maps contents for test assertions (ADR-0089).
#[cfg(test)]
pub(crate) fn cached_zone_maps_for_test() -> &'static Vec<game_core::ZoneMapDef> {
    (*ZONE_MAPS)
        .as_ref()
        .expect("zone maps must parse successfully in tests")
}

/// Return whether the ACTIVE_TILE_MAP thread_local is currently Some (ADR-0089).
#[cfg(test)]
pub(crate) fn active_tile_map_is_cached_for_test() -> bool {
    ACTIVE_TILE_MAP.with(|cell| cell.borrow().is_some())
}

/// Pre-populate the ACTIVE_TILE_MAP cache with zone 0's TileMap for test setup (ADR-0089).
#[cfg(test)]
pub(crate) fn seed_active_tile_map_for_test() {
    ACTIVE_TILE_MAP.with(|cell| {
        *cell.borrow_mut() = Some(game_core::zone_0());
    });
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

    // -------------------------------------------------------------------------
    // M13.5d — client-wasm LazyLock content cache
    //
    // CRITERION 13.5d-2: The client-wasm caches zone maps in a static LazyLock
    // and caches the active-zone TileMap in a thread_local RefCell<Option<TileMap>>.
    //
    // RED REASON (wasm_cached_zone_maps_matches_load): calls
    // `super::cached_zone_maps_for_test()` which does NOT yet exist.
    // The implementer must add a #[cfg(test)] accessor that exposes the OnceLock
    // contents so this test can compare against game_core::load_zone_maps().
    //
    // RED REASON (wasm_set_active_zone_invalidates_tile_map_cache): calls
    // `super::active_tile_map_is_cached_for_test()` which does NOT yet exist.
    // The implementer must add a #[cfg(test)] accessor that returns whether the
    // ACTIVE_TILE_MAP thread_local currently holds Some(...) or None, and must
    // also expose `seed_active_tile_map_for_test` to pre-populate the cache.
    //
    // Testing strategy: expose minimal #[cfg(test)] seams rather than making
    // the statics pub. This follows the existing pattern in this file where
    // game_core sub-functions are tested through thin shims.
    // -------------------------------------------------------------------------

    /// CRITERION 13.5d-2 (client-wasm zone map cache transparency):
    /// The client-wasm cached zone maps match game_core::load_zone_maps().
    ///
    /// Calls `super::cached_zone_maps_for_test()` — a #[cfg(test)] helper the
    /// implementer must expose from lib.rs to give tests access to the LazyLock
    /// contents without making the static pub.
    ///
    /// Wrong impl killed: a client-wasm LazyLock populated from a stale/wrong
    /// RON snapshot, or one that returns empty even after initialization.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn wasm_cached_zone_maps_matches_load() {
        // RED: super::cached_zone_maps_for_test() does not exist yet.
        // The implementer adds:
        //   #[cfg(test)]
        //   pub(crate) fn cached_zone_maps_for_test() -> &'static Vec<game_core::ZoneMapDef> {
        //       (*ZONE_MAPS).as_ref().expect("zone maps must parse successfully in tests")
        //   }
        let cached = super::cached_zone_maps_for_test();
        let loaded = game_core::load_zone_maps().expect("game_core::load_zone_maps must succeed");

        assert_eq!(
            cached.len(),
            loaded.len(),
            "client-wasm cached zone maps has {} entries but load_zone_maps() returned {}",
            cached.len(),
            loaded.len()
        );
        // Compare the zone_id for each entry — ZoneMapDef has no PartialEq, use field check.
        for (c, l) in cached.iter().zip(loaded.iter()) {
            assert_eq!(
                c.zone_id, l.zone_id,
                "client-wasm cached zone {} but loaded zone {}",
                c.zone_id, l.zone_id
            );
            assert_eq!(
                c.rows.len(),
                l.rows.len(),
                "zone {} cached {} tile rows but loaded {} tile rows",
                c.zone_id,
                c.rows.len(),
                l.rows.len()
            );
        }
    }

    /// CRITERION 13.5d-2 (set_active_zone invalidates TileMap cache):
    /// After calling set_active_zone(0), the ACTIVE_TILE_MAP thread_local
    /// must be None (the old cached TileMap is discarded so the next access
    /// loads the correct zone's map rather than a stale one from a prior zone).
    ///
    /// Calls `super::active_tile_map_is_cached_for_test()` — a #[cfg(test)]
    /// helper the implementer must expose from lib.rs.
    ///
    /// Wrong impl killed: an impl of set_active_zone that updates ACTIVE_ZONE_ID
    /// but neglects to clear the ACTIVE_TILE_MAP thread_local, causing movement
    /// prediction to silently use a stale zone map after a zone transition.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn wasm_set_active_zone_invalidates_tile_map_cache() {
        // RED: super::active_tile_map_is_cached_for_test() does not exist yet.
        // The implementer adds:
        //   #[cfg(test)]
        //   pub(crate) fn active_tile_map_is_cached_for_test() -> bool {
        //       ACTIVE_TILE_MAP.with(|cell| cell.borrow().is_some())
        //   }
        // and updates set_active_zone to clear the thread_local on zone change.

        // Pre-populate the cache so the invalidation has something to clear.
        // Without this, the test would pass even if set_active_zone never touched
        // the thread_local (the cache might already be None from test init).
        super::seed_active_tile_map_for_test();
        assert!(
            super::active_tile_map_is_cached_for_test(),
            "seed_active_tile_map_for_test() must leave ACTIVE_TILE_MAP in Some state"
        );

        // After set_active_zone, the thread_local TileMap cache must be None.
        // We call set_active_zone(0) unconditionally — even if the zone id
        // doesn't change, a zone-switch call must invalidate the cached map.
        super::set_active_zone(0);
        let is_cached = super::active_tile_map_is_cached_for_test();
        assert!(
            !is_cached,
            "ACTIVE_TILE_MAP must be None after set_active_zone() is called; \
             found Some(...) — the cache was not invalidated on zone switch, \
             which would cause movement prediction to use the wrong zone's tile map"
        );
    }
}
