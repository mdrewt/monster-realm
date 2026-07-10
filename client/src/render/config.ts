// render/config.ts — render-only constants (M4b, ADR-0004/0013/0090).
//
// SSOT for the renderer's pixels-per-tile and interpolation buffer. The logical
// grid stays `game-core`'s integer tiles (resolution-agnostic); ONLY the renderer
// knows a pixel size, and it lives here ONCE — never hard-coded at a call site
// (the spec rejects a tile/sprite pixel size literal anywhere else). `STEP_MS`
// and `MOVE_QUEUE_CAP` are NOT duplicated here: they are single-sourced from
// game-core via the wasm `step_ms()`/`move_queue_cap()` exports and injected.
//
// Three ADR-0090 constants (INTERP_JITTER_ALPHA, INTERP_MAX_DEPTH, BURST_EPSILON_MS)
// are single-sourced from `shared/interpConfig.ts` to avoid a net↔render import cycle.
export { BURST_EPSILON_MS, INTERP_JITTER_ALPHA, INTERP_MAX_DEPTH } from '../shared/interpConfig';

/** Pixels per logical tile (the one configurable mapping; default ~32). */
export const TILE_PX = 32;

/** Remote interpolation delay BASE, in STEP_MS multiples (ADR-0013/0075, M12.5d-1).
 *  This is the documentary base value — on smooth networks it equals the operative
 *  delay. The actual per-character delay is ADAPTIVE (ADR-0090): derived from the
 *  EWMA jitter estimate via adaptiveInterpDelayMs() and bounded by the constants below.
 *  Kept here so `interpDelayMs(stepMs)` still returns 1.0×stepMs for the
 *  legacy test suite (backward compatibility). */
export const INTERP_DELAY_STEPS = 1.0;

// ---------------------------------------------------------------------------
// ADR-0090: Adaptive interpolation delay — tuning constants
// (every constant is commented with WHAT it controls and WHY that value)
// ---------------------------------------------------------------------------

/** Multiplier applied to the jitter estimate to derive extra delay (ADR-0090).
 *  WHAT: delay = base + JITTER_COEFF × jitterMs.
 *  WHY 2.0: a 1-tick burst (jitter ≈ STEP_MS = 200 ms) → +400 ms extra → 600 ms
 *  total, which is above MAX_DELAY_STEPS×STEP_MS so the MAX clamp applies (500 ms).
 *  At moderate jitter (50 ms) → +100 ms → 300 ms — enough to bracket pre-burst. */
export const INTERP_JITTER_COEFF = 2.0;

/** Minimum adaptive delay in STEP_MS multiples (ADR-0090).
 *  WHAT: lower clamp on adaptiveInterpDelayMs output.
 *  WHY 0.5: prevents the delay from underflowing after a long smooth window
 *  immediately followed by a burst — the EWMA needs a few samples to react. */
export const INTERP_MIN_DELAY_STEPS = 0.5;

/** Maximum adaptive delay in STEP_MS multiples (ADR-0090).
 *  WHAT: upper clamp on adaptiveInterpDelayMs output.
 *  WHY 2.5: beyond 2.5×stepMs (500 ms at 200 ms cadence) the remote-entity lag
 *  is user-perceptible; a catastrophically jittery connection shows lag not pops. */
export const INTERP_MAX_DELAY_STEPS = 2.5;
