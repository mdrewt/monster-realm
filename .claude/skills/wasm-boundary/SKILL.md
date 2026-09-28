---
name: wasm-boundary
description: Working on client-wasm, wasm-bindgen exports, the WASM↔TypeScript prediction boundary, async WASM init, or batching state across the JS/Rust boundary in monster-realm (v2).
---

# WASM boundary (client-wasm ↔ TypeScript), monster-realm v2

> Check current wasm-bindgen docs through `gitmcp-wasm-bindgen` before touching
> generated `.d.ts` or export signatures. See [[netcode-smoothness]] for how the
> prediction loop uses these exports.

## client-wasm only wraps game-core

`client-wasm/src/lib.rs` is a thin shell with no rules of its own. An export converts
JS input, calls `game-core`, and converts the result back:

```rust
#[wasm_bindgen]
pub fn apply_move(state: JsValue, input: JsValue, now: f64) -> Result<JsValue, JsValue> {
    let state: CharacterState = serde_wasm_bindgen::from_value(state)?;
    let input: MoveInput = serde_wasm_bindgen::from_value(input)?;
    // ... look up the cached TileMap for the active zone, call game_core::apply_move,
    // and return serde_wasm_bindgen::to_value(&next)
}
```

The exports are `apply_move`, `predict_move`, `predict_tick`, `set_active_zone`,
`zone_map`, `evolution_eligibility`, and constant accessors (`step_ms`,
`move_queue_cap`, `party_size`, `party_slot_none`, `talk_range`,
`max_trade_monsters_per_side`, `deletion_grace_ms_default`). **A game-core constant
the client needs gets an accessor here; it is never copied into TypeScript.** An `i64`
constant returns as a JS `BigInt` (`deletion_grace_ms_default`), so TypeScript
arithmetic on it stays in `bigint`.

## Integers in, integers out

Marshal integer tiles. `TILE_PX` is a render-only constant: it never crosses into
`game-core` or onto the wire. `game-core` knows nothing about resolution.

## State the export keeps

Zone maps are parsed once per wasm instance (`LazyLock`), and the active zone's
`TileMap` is cached until `set_active_zone` changes it. Call `set_active_zone` on
every zone transition, before the next `apply_move`.

## Init

The package is built with `--target bundler`; Vite imports
`client-wasm/pkg/client_wasm.js` as an ES module (`client/src/main.ts`), and
`#[wasm_bindgen(start)]` installs `console_error_panic_hook` on load. `just wasm`
builds the package; the client build and tests fail without it.

```sh
just wasm    # wasm-pack build client-wasm --target bundler (wasm-pack 0.15.0)
```

## Minimize crossings

JS↔wasm calls have real overhead. Move state in batches, not per-entity calls or
per-frame JSON on the hot path.

## Panics

A Rust panic at the boundary is an uncatchable JS exception that kills the loop.
Fallible exports return `Result<_, JsValue>` and use `?`.

## After changing exports

1. `just wasm`, then check the generated `.d.ts` in `client-wasm/pkg/`.
2. Update the TypeScript callers; `just client-typecheck`.
3. `just eval`: `prediction-parity`, `movement-parity` and `js-path-parity` compare
   the wasm build with native output, and `feature-isolation` checks that
   `client-wasm` does not pull in `game-core`'s `spacetimedb` feature.

## Gotchas

- **Local wasm differs from CI** → wasm-pack is one global binary; CI pins `v0.15.0`.
  **Avoid:** install the same version (see [[toolchain-pin]]).
- **Client build fails with an unresolved import** → `client-wasm/pkg` was never
  built (it is gitignored). **Avoid:** `just wasm`.
- **The game loop dies with an uncatchable exception** → a panic crossed the boundary.
  **Avoid:** `Result<_, JsValue>` and `?`.
- **Floats sneak across** → sub-tile positions or a fractional `move_started_at`.
  **Avoid:** integer tiles only; sub-tile position is render-only.
- **`--target web`** → needs manual async plumbing in Vite. **Avoid:** `--target bundler`.
