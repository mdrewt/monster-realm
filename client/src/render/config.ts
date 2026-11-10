// render/config.ts — render-only constants.
//
// SSOT for the renderer's pixels-per-tile and interpolation buffer. The logical
// grid stays `game-core`'s integer tiles (resolution-agnostic); ONLY the renderer
// knows a pixel size, and it lives here ONCE — never hard-coded at a call site
// (the spec rejects a tile/sprite pixel size literal anywhere else). `STEP_MS`
// and `MOVE_QUEUE_CAP` are NOT duplicated here: they are single-sourced from
// game-core via the wasm `step_ms()`/`move_queue_cap()` exports and injected.
//
// Three interpolation constants (INTERP_JITTER_ALPHA, INTERP_MAX_DEPTH, BURST_EPSILON_MS)
// are single-sourced from `shared/interpConfig.ts` to avoid a net↔render import cycle.
export { BURST_EPSILON_MS, INTERP_JITTER_ALPHA, INTERP_MAX_DEPTH } from '../shared/interpConfig';

/** Pixels per logical tile (the one configurable mapping; default ~32). */
export const TILE_PX = 32;

// ---------------------------------------------------------------------------
// Responsive viewport scaling — the framing window.
// These three are Drew-tunable FEEL numbers; the EARS criteria use them
// symbolically, so retuning them stays testable. They are consumed ONLY by
// `viewport.ts` (a pure core) — no Pixi type ever enters this module.
// (every constant is commented with WHAT it controls and WHY that value)
// ---------------------------------------------------------------------------

/** Shorter-axis tile count the chosen scale AIMS for.
 *  WHAT: deviceScale ≈ round(shorterAxisDevicePx / (TARGET × TILE_PX)).
 *  WHY 11: a 10×7 shipped zone is 320×224 source px, so ~11 tiles on the
 *  shorter axis frames the whole zone with a small margin on a 16:9 desktop
 *  while still leaving a monster sprite legible on a phone. */
export const TARGET_VISIBLE_TILES = 11;

/** Best-effort FLOOR on the shorter-axis visible-tile count.
 *  WHAT: lower bound of the admissible window — the scale is not allowed to
 *  zoom in past this while a larger integer scale is still admissible.
 *  WHY 7: fewer than 7 tiles on the shorter axis hides the full height of a
 *  10×7 zone and the player loses the sense of the room. BEST-EFFORT, not
 *  strict: `deviceScale >= 1` is a HARD floor (a sub-1 scale IS the blur bug
 *  this slice fixes), so below MIN × TILE_PX = 224 device px this yields. */
export const MIN_VISIBLE_TILES = 7;

/** STRICT CEILING on the shorter-axis visible-tile count.
 *  WHAT: upper bound of the admissible window — never show more than this.
 *  WHY 16: past ~16 tiles the 32-px placeholder sprites are too small to read
 *  on a laptop. Unlike MIN this is never violated: the ceiling is enforced by
 *  raising deviceScale, which the `>= 1` floor never opposes. */
export const MAX_VISIBLE_TILES = 16;

// ---------------------------------------------------------------------------
// Continuous UI scale — the chrome's half of the hybrid scale authority.
// Consumed ONLY by `viewport.ts`, which reduces them to `uiScale`. Tunable feel numbers.
// ---------------------------------------------------------------------------

/** Shorter CSS axis at which the chrome renders at its authored size (uiScale 1).
 *  WHAT: uiScale = shorterCssPx / UI_REFERENCE_CSS_PX, before the clamp.
 *  WHY 720: wf-1's token table and geometry are written at 1280x720. */
export const UI_REFERENCE_CSS_PX = 720;

/** Lower clamp on uiScale.
 *  WHAT: below a 630 CSS px shorter axis the chrome stops shrinking.
 *  WHY 0.875: body text (0.875rem) stays at 12.25 px, the smallest size the wf-1 table reads at. */
export const UI_SCALE_MIN = 0.875;

/** Upper clamp on uiScale.
 *  WHAT: above a 2160 CSS px shorter axis the chrome stops growing.
 *  WHY 3: a 4K window's body text is already 42 px; past it the frames only lose content. */
export const UI_SCALE_MAX = 3;

/** Remote interpolation delay BASE, in STEP_MS multiples.
 *  This is the documentary base value — on smooth networks it equals the operative
 *  delay. The actual per-character delay is ADAPTIVE: derived from the
 *  EWMA jitter estimate via adaptiveInterpDelayMs() and bounded by the constants below.
 *  Kept here so `interpDelayMs(stepMs)` still returns 1.0×stepMs for the
 *  legacy test suite (backward compatibility). */
export const INTERP_DELAY_STEPS = 1.0;

// ---------------------------------------------------------------------------
// Adaptive interpolation delay — tuning constants
// (every constant is commented with WHAT it controls and WHY that value)
// ---------------------------------------------------------------------------

/** Multiplier applied to the jitter estimate to derive extra delay.
 *  WHAT: delay = base + JITTER_COEFF × jitterMs.
 *  WHY 2.0: a 1-tick burst (jitter ≈ STEP_MS = 200 ms) → +400 ms extra → 600 ms
 *  total, which is above MAX_DELAY_STEPS×STEP_MS so the MAX clamp applies (500 ms).
 *  At moderate jitter (50 ms) → +100 ms → 300 ms — enough to bracket pre-burst. */
export const INTERP_JITTER_COEFF = 2.0;

/** Minimum adaptive delay in STEP_MS multiples.
 *  WHAT: lower clamp on adaptiveInterpDelayMs output.
 *  WHY 0.5: prevents the delay from underflowing after a long smooth window
 *  immediately followed by a burst — the EWMA needs a few samples to react. */
export const INTERP_MIN_DELAY_STEPS = 0.5;

/** Maximum adaptive delay in STEP_MS multiples.
 *  WHAT: upper clamp on adaptiveInterpDelayMs output.
 *  WHY 2.5: beyond 2.5×stepMs (500 ms at 200 ms cadence) the remote-entity lag
 *  is user-perceptible; a catastrophically jittery connection shows lag not pops. */
export const INTERP_MAX_DELAY_STEPS = 2.5;

// ---------------------------------------------------------------------------
// Terrain renderer (wap-4) — consumed by `terrainLayout.ts` (pure) and `world.ts`.
// ---------------------------------------------------------------------------

/** Milliseconds each water animation frame is held.
 *  WHAT: frame index = floor(nowMs / WATER_FRAME_MS) mod frameCount (frame 0 under reduced motion).
 *  WHY 400: the kit's four water frames cycle in 1.6 s — a slow swell that reads as motion
 *  without flicker, and only one texture swap per 400 ms on the animated tiles. */
export const WATER_FRAME_MS = 400;

/** Edge length, in tiles, of one cached terrain chunk.
 *  WHAT: the static terrain is baked into one texture per CHUNK×CHUNK tile block (edge chunks clipped).
 *  WHY 16: a 16-tile chunk is 512 source px, so even at device scale 4 a chunk texture is
 *  2048 px — inside every WebGL2 max-texture size — while a 40×28 zone needs only 6 chunks. */
export const TERRAIN_CHUNK_TILES = 16;

/** Most textures the sprite batcher may sample in one draw call.
 *  WHAT: caps Pixi's `renderer.limits.maxBatchableTextures`; a batch that needs more textures
 *  is split into another draw call.
 *  WHY 4: Pixi's batch fragment shader picks its texture with an if/else chain as long as this
 *  limit, evaluated for every covered pixel. A hardware GPU does not notice, but a software
 *  rasteriser (SwiftShader: headless CI, or a player whose browser has no usable GPU) pays for
 *  the whole chain per pixel, and reports a limit of 32. Measured on a full-canvas zone under
 *  SwiftShader on 2 cores: limit 32 holds 30 to 39 fps, limit 4 holds 60 fps, with identical pixels.
 *  The world draws from about seven textures, so 4 costs at most two extra draw calls. */
export const MAX_BATCH_TEXTURES = 4;
