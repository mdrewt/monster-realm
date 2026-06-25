// render/config.ts — render-only constants (M4b, ADR-0004/0013).
//
// SSOT for the renderer's pixels-per-tile and interpolation buffer. The logical
// grid stays `game-core`'s integer tiles (resolution-agnostic); ONLY the renderer
// knows a pixel size, and it lives here ONCE — never hard-coded at a call site
// (the spec rejects a tile/sprite pixel size literal anywhere else). `STEP_MS`
// and `MOVE_QUEUE_CAP` are NOT duplicated here: they are single-sourced from
// game-core via the wasm `step_ms()`/`move_queue_cap()` exports and injected.

/** Pixels per logical tile (the one configurable mapping; default ~32). */
export const TILE_PX = 32;

/** Remote interpolation delay, in STEP_MS multiples (ADR-0013: ~1.5–2× STEP_MS).
 *  Render remote characters at `now - INTERP_DELAY_STEPS * STEP_MS` so the buffer
 *  absorbs sub-buffer jitter; tunable to measured jitter via the HUD (M4c). */
export const INTERP_DELAY_STEPS = 1.5;
