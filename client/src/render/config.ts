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

/** Remote interpolation delay, in STEP_MS multiples (ADR-0013, M12.5d-1).
 *  1.0 × STEP_MS aligns the render window exactly with the 2-snapshot store depth:
 *  renderTime = now - STEP_MS renders remotes at the leading edge of the previous
 *  segment, eliminating the hold/jump cycle that 1.5 caused with only 2 snapshots
 *  (renderTime fell before prev.receivedAt for ~100ms → ramp to 50% → jump on update). */
export const INTERP_DELAY_STEPS = 1.0;
