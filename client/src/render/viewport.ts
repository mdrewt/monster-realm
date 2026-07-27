// render/viewport.ts — responsive, device-integer viewport scaling (uxd1, ADR-0160).
//
// PURE. No DOM, no Pixi, no `window`, no clock — a sibling of `camera.ts`: CSS
// pixels + devicePixelRatio in, a scale record and pixel transforms out. It lives
// here rather than in `world.ts`/`main.ts` because those are coverage-excluded
// imperative shells, so any math placed there is untested by construction.
//
// THE UNIT CONTRACT (three spaces, never mix them):
//   SOURCE px  — the space the world is authored in: tileCoord * TILE_PX. What
//                `FollowCamera.offsetFor` takes and returns.
//   CSS px     — `window.innerWidth/innerHeight`; what the user's layout sees.
//   DEVICE px  — CSS px * devicePixelRatio; the actual backing-store pixels.
// `deviceScale` (INTEGER) is source→device, so one source texel always covers a
// WHOLE number of device pixels — that integer is what makes the art crisp.
// `stageScale = deviceScale / dpr` is source→CSS, and it is FRACTIONAL: Pixi's
// `resolution: dpr` re-applies the dpr factor, so the stage must be scaled in CSS
// space. The CSS box still fills the window exactly at any dpr.
import { MAX_VISIBLE_TILES, MIN_VISIBLE_TILES, TARGET_VISIBLE_TILES, TILE_PX } from './config';

/** The resolved scale for one (cssW, cssH, dpr) triple. Every field is derived. */
export interface ViewportScale {
  readonly dpr: number; // normalized, finite, in [0.25, 8]
  readonly cssW: number; // normalized CSS px, finite, in [1, 1e6]
  readonly cssH: number;
  readonly deviceScale: number; // INTEGER >= 1 (source px -> device px)
  readonly stageScale: number; // deviceScale / dpr, finite, > 0 (source px -> CSS px)
  readonly effectiveW: number; // SOURCE px = cssW / stageScale
  readonly effectiveH: number; // SOURCE px = cssH / stageScale
}

/**
 * Normalize one browser-supplied number: accept it only inside `[lo, hi]`, else
 * fall back. NORMALIZES, never throws — this runs from a `resize` handler right
 * next to the frame loop, and a throw on a hostile `devicePixelRatio` would kill
 * rendering outright. BOUNDED rather than merely finite: `Number.isFinite` alone
 * accepts `Number.MAX_VALUE`, and `shorterCss * dpr` then overflows to Infinity,
 * making `deviceScale` non-integer and falsifying the postconditions above. With
 * bounds every documented postcondition holds BY PARSING.
 */
function norm(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
}

const DPR_LO = 0.25;
const DPR_HI = 8;
const CSS_LO = 1;
const CSS_HI = 1e6;

/**
 * Choose the integer device scale for a viewport, and derive everything from it.
 *
 * The shorter axis drives the choice (it is the one that runs out first). `S` is
 * the shorter axis measured in tiles at deviceScale 1, so `S / deviceScale` is
 * the shorter-axis visible-tile count. Aim for TARGET, then clamp into
 * [MIN, MAX] tiles by clamping the INTEGER `deviceScale` — never the float scale,
 * which would round back out of the window.
 *
 * MAX is STRICT and MIN is BEST-EFFORT: the ceiling is enforced by RAISING
 * deviceScale, which never fights the hard `>= 1` floor, whereas the floor would
 * need a sub-1 scale (the blurry upscale this slice exists to remove) once the
 * shorter axis drops below MIN_VISIBLE_TILES * TILE_PX = 224 device px. So `Dhi`
 * (MIN) yields to `Dlo` (MAX) and both yield to 1.
 */
export function viewportScale(cssW: number, cssH: number, dpr: number): ViewportScale {
  const dprN = norm(dpr, DPR_LO, DPR_HI, 1);
  const cssWN = norm(cssW, CSS_LO, CSS_HI, 1);
  const cssHN = norm(cssH, CSS_LO, CSS_HI, 1);
  // Divide BEFORE multiplying by dpr: the other operand order overflows on a
  // large-but-in-bounds viewport.
  const s = (Math.min(cssWN, cssHN) / TILE_PX) * dprN;
  const dLo = Math.max(1, Math.ceil(s / MAX_VISIBLE_TILES)); // strict ceiling
  const dHi = Math.max(dLo, Math.floor(s / MIN_VISIBLE_TILES)); // best-effort floor
  const d0 = Math.max(1, Math.round(s / TARGET_VISIBLE_TILES)); // the aim
  const deviceScale = Math.min(dHi, Math.max(dLo, d0));
  const stageScale = deviceScale / dprN;
  return {
    dpr: dprN,
    cssW: cssWN,
    cssH: cssHN,
    deviceScale,
    stageScale,
    effectiveW: cssWN / stageScale,
    effectiveH: cssHN / stageScale,
  };
}

/**
 * Pixi `Application.init` options for a DPR-correct backing store. `resolution:
 * dpr` + `autoDensity: true` is the pair that fixes retina blur: Pixi allocates
 * `cssW*dpr` device pixels and writes back a `cssW`-CSS-px canvas box. Pixi's
 * defaults (`resolution: 1`, `autoDensity: false`) are the root cause, and
 * `antialias: false` keeps the integer-scaled texels crisp instead of resampled.
 * Return type is INFERRED — the name is never written anywhere.
 */
export function appInitOptions(cssW: number, cssH: number, dpr: number, background: number) {
  return {
    width: norm(cssW, CSS_LO, CSS_HI, 1),
    height: norm(cssH, CSS_LO, CSS_HI, 1),
    background,
    antialias: false,
    autoDensity: true,
    resolution: norm(dpr, DPR_LO, DPR_HI, 1),
  };
}

/**
 * SOURCE px -> CSS px under a camera offset. `offset` is a `FollowCamera.offsetFor`
 * result (SOURCE px); the result's origin is the canvas top-left. This is the ONE
 * expression of the stage transform — `world.ts` positions the stage with it, so
 * a sign error or a dropped `* stageScale` cannot hide in the shell. Deliberately
 * NOT rounded to a pixel grid: quantizing here would judder the sub-tile slide
 * (ADR-0013).
 */
export function worldToScreen(
  world: { x: number; y: number },
  offset: { x: number; y: number },
  stageScale: number,
): { x: number; y: number } {
  return {
    x: (world.x - offset.x) * stageScale,
    y: (world.y - offset.y) * stageScale,
  };
}

/**
 * CSS px -> SOURCE px: the exact inverse of `worldToScreen`. Ships UNWIRED for a
 * future tap-to-move milestone (spec §uxd1 "Out of scope"). CAVEAT for that
 * caller: `screen` is relative to the CANVAS top-left, so a `PointerEvent`'s
 * `clientX/clientY` must have the canvas origin subtracted first — this function
 * does not do it.
 */
export function screenToWorld(
  screen: { x: number; y: number },
  offset: { x: number; y: number },
  stageScale: number,
): { x: number; y: number } {
  return {
    x: screen.x / stageScale + offset.x,
    y: screen.y / stageScale + offset.y,
  };
}
