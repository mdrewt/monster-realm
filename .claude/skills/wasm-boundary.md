---
name: wasm-boundary
description: Working on client-wasm, wasm-bindgen exports, the WASM↔TypeScript prediction boundary, async WASM init, or batching state across the JS/Rust boundary in monster-realm (v2). The prediction WASM lands at M3.
---

# WASM Boundary (client-wasm ↔ TypeScript) — monster-realm v2

> Fetch current wasm-bindgen docs from `gitmcp-wasm-bindgen` before touching generated `.d.ts` or export signatures. Honor ADR-0003 (shared core) + ADR-0013 (netcode smoothness — see [[netcode-smoothness]]).

## Key constraint: client-wasm wraps game-core

`client-wasm` is a thin shell; all prediction logic lives in `game-core`. The boundary only marshals: JS input → call `game-core` → marshal result back. **No rules duplicated here.**

```rust
#[wasm_bindgen]
pub fn predict_move(state_json: &str, dir: u8) -> Result<String, JsValue> {
    let state: TileState = serde_json::from_str(state_json).map_err(js)?;
    let next = game_core::apply_move(&state, MoveIntent::from_u8(dir).ok_or_else(|| js("bad dir"))?);
    serde_json::to_string(&next).map_err(js)
}
```

## Integer in, integer out (v2)

Marshal **integer tiles**, not floats. `TILE_PX` (pixels-per-tile) is a **render-only** constant — never cross it into `game-core` or onto the wire. `game-core` is resolution-agnostic, so the HD-2D resolution bump (32 → 48/64) never touches this boundary.

## Async init — gate the loop

```typescript
import init, { predict_move } from '../client-wasm/pkg/client_wasm';
let wasmReady = false;
async function start() { await init(); wasmReady = true; loop(); }
function loop() { if (!wasmReady) return; requestAnimationFrame(tick); }
```

Calling an export before `await init()` resolves throws.

## Build target

```
wasm-pack build client-wasm --target bundler   # wasm-pack 0.15.0
```

Use `bundler` (not `web`): Vite imports `client-wasm/pkg/` as a normal ES module and tree-shakes it — no manual async plumbing.

## Minimize crossings

JS↔WASM overhead is real — transfer state in **batches**, packed flat arrays (`&[i32]`, `Vec<u8>`), not per-entity calls or per-frame JSON on the hot path.

## Panics

A Rust panic at the boundary is an uncatchable JS exception that kills the loop. Return `Result<_, JsValue>` for all fallible exports; propagate with `?`. Dev panic hook:

```rust
#[wasm_bindgen(start)]
pub fn main() { #[cfg(debug_assertions)] console_error_panic_hook::set_once(); }
```

## After changing exports

1. Rebuild `wasm-pack build client-wasm --target bundler`.
2. Check generated `.d.ts` in `client-wasm/pkg/`.
3. Update calling TS; run `tsc --noEmit`.
4. Re-run the **prediction-parity** + **netcode-smoothness** evals.

## Gotchas

_Living log — symptom/quirk → cause → **avoid:** action. Append as you hit them._

- **Local WASM build differs from CI** → wasm-pack is one global binary (0.15.0); pin CI's install action separately to `v0.15.0`. **Avoid:** see [[toolchain-pin]].
- **Exports throw "not a function" / undefined** → called before `await init()` resolved. **Avoid:** gate the loop on `wasmReady`.
- **Game loop dies with an uncatchable JS exception** → a Rust panic crossed the boundary. **Avoid:** `Result<_, JsValue>` + `?`; `console_error_panic_hook` in dev.
- **Floats sneak across the boundary / stutter returns** → passing sub-tile floats or `move_started_at` into prediction. **Avoid:** integer tiles only; sub-tile position is render-only (ADR-0013).
- **`--target web` chosen** → manual Vite async plumbing. **Avoid:** `--target bundler`.
