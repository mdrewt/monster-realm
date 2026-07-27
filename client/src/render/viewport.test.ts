// render/viewport.test.ts — pure viewport-scale core unit tests (uxd1, ADR-0160).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-ux-design.spec.md §uxd1
// (lines 24-63) EARS acceptance criteria, as sliced by the uxd1 build plan §2.2
// (exact signatures/formulas) and §3 (criterion → test mapping).
//
// `viewport.ts` is a PURE functional core (ADR-0014 seam, like `camera.ts` /
// `resizeWiring.ts`): CSS pixels + devicePixelRatio in, a scale record and pixel
// transforms out. No DOM, no Pixi, no `window`, no clock. Every input is passed.
//
// RED REASON: `client/src/render/viewport.ts` does not exist yet, and
// `config.ts` does not yet export TARGET/MIN/MAX_VISIBLE_TILES. Every import
// below fails to resolve until the implementer creates them. Two composition
// teeth (A7b centered-axis) additionally stay RED until `camera.ts` grows the
// per-axis CENTER branch — but the primary RED is absence-of-module.
//
// Contract under test (plan §2.2):
//   viewportScale(cssW, cssH, dpr)
//     -> { dpr, cssW, cssH, deviceScale, stageScale, effectiveW, effectiveH }
//   appInitOptions(cssW, cssH, dpr, background)
//     -> { width, height, background, antialias: false, autoDensity: true, resolution }
//   worldToScreen(world: {x,y}, offset: {x,y}, stageScale) -> {x,y}   // SOURCE px -> CSS px
//   screenToWorld(screen: {x,y}, offset: {x,y}, stageScale) -> {x,y}  // CSS px -> SOURCE px
//
// NOT tested here, deliberately (plan §3):
//   - A8 (DOM overlay fixed positioning): uxd1 claims NO REGRESSION only; the
//     touches-set contains zero DOM/CSS files. 10-11 overlays are in-flow divs
//     on master today (pre-existing, owned by uxd3).
//   - A10 (`nearest` scaleMode): review + manual gate only. `expect(K).toBe('nearest')`
//     on a constant this file would also have to import is a tautology, not a tooth.
//   - A2/A12 (resize path threads a fire-time dpr): owned by `resizeWiring.test.ts`.
//   - A5/A5b/A6/A6b (camera branch math): owned by `camera.test.ts`.
//   - `stageScale * dpr === deviceScale` as an EXACT identity: mathematically
//     false for many doubles ((d/r)*r !== d, e.g. at dpr 1.7999999523162842,
//     which real Android Chrome reports). Asserted below only via toBeCloseTo.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FollowCamera } from './camera';
import { MAX_VISIBLE_TILES, MIN_VISIBLE_TILES, TARGET_VISIBLE_TILES, TILE_PX } from './config';
import { appInitOptions, screenToWorld, viewportScale, worldToScreen } from './viewport';

// ---------------------------------------------------------------------------
// Shared generators & helpers
// ---------------------------------------------------------------------------

/** Real devicePixelRatio values, incl. float32(1.8) as reported by a whole class
 *  of Android Chrome devices and 2.625 (Pixel-class). Never `fc.double` for dpr:
 *  arbitrary doubles are not a thing a browser produces and they park P-MAX/P-MIN
 *  on 1-ULP boundaries. */
const REALISTIC_DPRS = [1, 1.25, 1.5, 1.7999999523162842, 2, 2.625, 3] as const;

/** Real stageScale values (= deviceScale / dpr): 1/2, 1/1, 4/3, 3/2, 2/1, 3/1.25, 3/1, 4/1, 6/1. */
const REALISTIC_STAGE_SCALES = [0.5, 1, 4 / 3, 1.5, 2, 2.4, 3, 4, 6] as const;

const dprArb = fc.constantFrom(...REALISTIC_DPRS);

/** INTEGER CSS sizes only — `window.innerWidth/innerHeight` are integral. Fractional
 *  CSS generators put P-MAX/P-MIN on 1-ULP boundaries and produce false REDs on a
 *  CORRECT implementation. */
const cssArb = fc.integer({ min: 1, max: 4096 });

/** Shorter-axis visible tile count, derived ONLY from the returned record (no
 *  re-implementation of the production formula). */
function visibleTiles(vs: { effectiveW: number; effectiveH: number }): number {
  return Math.min(vs.effectiveW, vs.effectiveH) / TILE_PX;
}

// ===========================================================================
// Constants precondition — the algorithm's only structural requirement
// ===========================================================================

describe('viewport constants: the clamp window is well-formed', () => {
  it('BITES: 1 <= MIN_VISIBLE_TILES <= TARGET_VISIBLE_TILES <= MAX_VISIBLE_TILES', () => {
    // These three are Drew-tunable FEEL numbers (spec:58 — "EARS use them
    // symbolically so remain testable at any value"). This test exists so a bad
    // retune fails HERE with a readable message instead of deep inside a
    // property test whose counterexample says nothing about why.
    // Kills: a retune that inverts MIN/MAX (the admissible deviceScale window
    // becomes empty for every input and `min(Dhi, max(Dlo, D0))` returns the
    // MAX clamp unconditionally), or a MIN of 0 (division by zero in Dhi).
    expect(MIN_VISIBLE_TILES).toBeGreaterThanOrEqual(1);
    expect(TARGET_VISIBLE_TILES).toBeGreaterThanOrEqual(MIN_VISIBLE_TILES);
    expect(MAX_VISIBLE_TILES).toBeGreaterThanOrEqual(TARGET_VISIBLE_TILES);
  });
});

// ===========================================================================
// A1 — WHEN the WorldRenderer initializes on a display with dpr, THE renderer
// SHALL create the Pixi Application with resolution = dpr and autoDensity = true.
// ===========================================================================

describe('A1: appInitOptions — DPR-correct backing store', () => {
  it('BITES: appInitOptions sets resolution=dpr and autoDensity=true (dpr 1/2/3)', () => {
    // `toEqual` on the WHOLE returned object, not field-by-field: this is what
    // makes the tooth bite on omissions as well as wrong values.
    //
    // Kills, in order:
    //  - Pixi v8 DEFAULTS (`resolution: 1`, `autoDensity: false`) — literally the
    //    retina-blur root cause this slice exists to fix (spec:30). A missing
    //    `resolution` key fails toEqual; a hard-coded `resolution: 1` fails the
    //    dpr 2 and dpr 3 rows.
    //  - an OMITTED `autoDensity` — without it Pixi sizes the canvas CSS box to
    //    `cssW*dpr` device-independent px, so the world renders 2-3x too large
    //    and the canvas overflows the window.
    //  - `antialias: true` (or omitted) — the slice ships crisp integer-scaled
    //    texels; AA would resample them (plan §2.7).
    //  - width/height swapped, or the backing-store size (`cssW*dpr`) written
    //    into `width` instead of the CSS size.
    //  - `background` dropped or recolored.
    expect(appInitOptions(1920, 1080, 1, 0x1e2a3f)).toEqual({
      width: 1920,
      height: 1080,
      background: 0x1e2a3f,
      antialias: false,
      autoDensity: true,
      resolution: 1,
    });
    expect(appInitOptions(1920, 1080, 2, 0x1e2a3f)).toEqual({
      width: 1920,
      height: 1080,
      background: 0x1e2a3f,
      antialias: false,
      autoDensity: true,
      resolution: 2,
    });
    expect(appInitOptions(390, 844, 3, 0x000000)).toEqual({
      width: 390,
      height: 844,
      background: 0x000000,
      antialias: false,
      autoDensity: true,
      resolution: 3,
    });
  });
});

// ===========================================================================
// A1b + A2 (MERGED) — boundary normalization. The resize path runs adjacent to
// the frame loop, so degenerate browser-supplied input is NORMALIZED, never
// thrown on (plan §2.2), and the normalizer is BOUNDED, not merely finite.
// ===========================================================================

describe('A1b+A2: degenerate input is normalized to documented fallbacks (never thrown, never non-finite)', () => {
  it('BITES: norm — dpr 0/NaN/-1/Infinity/1e308/5e-324 and cssW/H 0/NaN/-1/1e308 fall back to the documented value; resolution is never non-finite', () => {
    // --- dpr: outside [0.25, 8] or non-finite => fallback 1 ------------------
    const BAD_DPRS = [
      0,
      Number.NaN,
      -1,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1e308,
      5e-324,
      0.2499,
      8.0001,
    ];
    for (const bad of BAD_DPRS) {
      // Kills: passing `devicePixelRatio` STRAIGHT THROUGH. A dpr of 0 becomes
      // `resolution: 0` -> a 0x0 backing store -> a blank canvas; NaN/Infinity
      // poison every downstream multiplication.
      // Kills: a CLAMPING normalizer (`clamp(dpr, 0.25, 8)`) instead of the
      // documented fall-back-to-1 — clamp yields 8 for 1e308 and 0.25 for
      // 5e-324, both wrong-but-plausible world scales; `toBe(1)` rejects both.
      expect(viewportScale(1920, 1080, bad).dpr).toBe(1);
      expect(appInitOptions(1920, 1080, bad, 0).resolution).toBe(1);
    }

    // --- dpr: the accepted bounds are INCLUSIVE ------------------------------
    // Kills: an off-by-one-sided bound (`> lo` / `< hi`) that would reject a
    // legitimate 0.25 zoomed-out or 8x display and silently reset it to 1.
    expect(viewportScale(1920, 1080, 0.25).dpr).toBe(0.25);
    expect(viewportScale(1920, 1080, 8).dpr).toBe(8);
    // Kills: a normalizer that also mangles ordinary values.
    expect(viewportScale(1920, 1080, 2.625).dpr).toBe(2.625);

    // --- cssW / cssH: outside (0, 1e6] or non-finite => fallback 1 -----------
    const BAD_CSS = [0, Number.NaN, -1, Number.POSITIVE_INFINITY, 1e308, 1e6 + 1, 0.5];
    for (const bad of BAD_CSS) {
      // Kills: a `Math.max(1, cssW)` style guard that lets 1e308 through, and a
      // bare `Number.isFinite` guard (which ACCEPTS 1e308) — see the deviceScale
      // postcondition immediately below.
      expect(viewportScale(bad, 1080, 1).cssW).toBe(1);
      expect(viewportScale(1920, bad, 1).cssH).toBe(1);
      expect(appInitOptions(bad, 1080, 1, 0).width).toBe(1);
      expect(appInitOptions(1920, bad, 1, 0).height).toBe(1);
    }

    // --- cssW / cssH: the accepted bounds are INCLUSIVE ----------------------
    // Kills: an exclusive upper/lower bound that resets a legitimate viewport.
    expect(viewportScale(1, 1, 1).cssW).toBe(1);
    expect(viewportScale(1e6, 1e6, 1).cssW).toBe(1e6);
    // Kills: an echo that normalizes only in `appInitOptions` and not in
    // `viewportScale` (or vice versa) — the plan mandates ONE shared helper.
    expect(viewportScale(1600, 900, 2).cssW).toBe(1600);
    expect(viewportScale(1600, 900, 2).cssH).toBe(900);

    // --- every documented postcondition holds BY PARSING ---------------------
    // Kills: the UNBOUNDED finite-only normalizer. `Number.isFinite(1e308)` is
    // true, `shorterCss * dpr` then overflows to Infinity, and deviceScale comes
    // back Infinity — falsifying the declared `Number.isInteger(deviceScale)`.
    for (const bad of [...BAD_DPRS, 1, 2, 3]) {
      const vs = viewportScale(1e308, 1e308, bad);
      expect(Number.isInteger(vs.deviceScale)).toBe(true);
      expect(vs.deviceScale).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(vs.stageScale)).toBe(true);
      expect(vs.stageScale).toBeGreaterThan(0);
      expect(Number.isFinite(vs.effectiveW)).toBe(true);
      expect(Number.isFinite(vs.effectiveH)).toBe(true);
    }
    // Kills: a denormal dpr slipping through -> stageScale = deviceScale/5e-324
    // = Infinity -> `stage.scale.set(Infinity)` blanks the renderer.
    expect(Number.isFinite(viewportScale(1920, 1080, 5e-324).stageScale)).toBe(true);
  });
});

// ===========================================================================
// A3 — WHERE the shorter viewport axis at the chosen scale would show fewer
// than MIN_VISIBLE_TILES or more than MAX_VISIBLE_TILES, THE viewportScale core
// SHALL clamp so the shorter-axis visible-tile count lies within [MIN, MAX].
//
// Restated per plan §2.2 / ADR-0160: MAX is STRICT, MIN is BEST-EFFORT, because
// `deviceScale >= 1` is a hard floor. The admissible window can only be empty
// below MIN_VISIBLE_TILES * TILE_PX = 224 device px on the shorter axis.
// ===========================================================================

describe('A3: shorter-axis visible tiles are clamped into [MIN, MAX]', () => {
  it('BITES: MAX clamp binds — viewportScale(1024,512,1).deviceScale === 1 AND viewportScale(1024,513,1).deviceScale === 2', () => {
    // At the shipped constants (11/7/16) the MAX clamp `Dlo` binds ONLY for a
    // shorter axis of 513-527 device px — a 15-px-wide band. A fast-check
    // property over realistic viewports lands inside it on roughly 11% of seeds,
    // i.e. it is a coin flip, not a gate. This deterministic pair is the gate.
    //
    // 512 device px: S = 16.0 exactly -> deviceScale 1 -> exactly MAX (16) tiles.
    // 513 device px: S = 16.03125    -> an UNCLAMPED round(S/11) = 1 would show
    //                16.03 tiles, breaking the STRICT ceiling; ceil(S/16) = 2 wins.
    //
    // Kills: the clamp-the-FLOAT-then-round implementation
    // (`round(clamp(idealCssScale, …) * dpr)`), which keeps Number.isInteger
    // green, reproduces the whole 1920x1080 table, and violates P-MAX exactly
    // here. Kills an unclamped `max(1, round(S/TARGET))`. Kills a MIN clamp
    // applied with the wrong precedence (`max(Dlo, min(Dhi, D0))` order swapped).
    expect(viewportScale(1024, 512, 1).deviceScale).toBe(1);
    expect(viewportScale(1024, 513, 1).deviceScale).toBe(2);

    // The SAME pair pins the accepted integer-deviceScale SAWTOOTH boundary
    // (plan §2.2 honest-ledger item / ADR-0160 decision 9): a 1-CSS-pixel resize
    // across 512->513 doubles every sprite, 16.000 -> 8.016 visible tiles. That
    // is a deliberate, recorded trade of "device-integer crisp"; hysteresis is a
    // named deferral. Asserting it here means a future implementer who "smooths"
    // the step (fractional deviceScale, or a hidden hysteresis band) fails a test
    // that names the decision instead of silently changing it.
    expect(visibleTiles(viewportScale(1024, 512, 1))).toBeCloseTo(16, 9);
    expect(visibleTiles(viewportScale(1024, 513, 1))).toBeCloseTo(8.015625, 9);
  });

  it('BITES: property — visibleTiles <= MAX for every integer viewport/dpr (P-MAX)', () => {
    // P-MAX is UNCONDITIONAL (plan §2.2). Formula-independent: the tile count is
    // derived only from the returned effectiveW/effectiveH.
    // Kills: any implementation that drops the `Dlo = max(1, ceil(S/MAX))` line,
    // and any that clamps the float scale instead of the integer deviceScale.
    // (Probabilistic on its own — see the deterministic 513 tooth above.)
    fc.assert(
      fc.property(cssArb, cssArb, dprArb, (cssW, cssH, dpr) => {
        const vs = viewportScale(cssW, cssH, dpr);
        expect(visibleTiles(vs)).toBeLessThanOrEqual(MAX_VISIBLE_TILES);
      }),
    );
  });

  it('BITES: property — >= MIN whenever shorterDevicePx >= 224 (P-MIN)', () => {
    // P-MIN is CONDITIONAL: it holds only where the shorter axis carries at least
    // MIN_VISIBLE_TILES * TILE_PX = 224 device px. Below that, satisfying MIN
    // would require a sub-1 deviceScale — which IS the blur bug being fixed.
    //
    // HONEST SCOPE (plan residual 4): at the shipped constants the MIN clamp
    // `Dhi` never binds, so this property does NOT kill a one-sided-clamp
    // implementation. It is a FUTURE-CONSTANT GUARD: it fails loudly if Drew
    // retunes TARGET/MIN into a region where `round(S/TARGET)` overshoots MIN.
    // Kills today: a `round`->`ceil` swap on D0 at small viewports, and any
    // implementation that lets deviceScale exceed floor(S/MIN).
    fc.assert(
      fc.property(
        fc.integer({ min: 120, max: 4096 }),
        fc.integer({ min: 120, max: 4096 }),
        dprArb,
        (cssW, cssH, dpr) => {
          fc.pre(Math.min(cssW, cssH) * dpr >= MIN_VISIBLE_TILES * TILE_PX);
          const vs = viewportScale(cssW, cssH, dpr);
          expect(visibleTiles(vs)).toBeGreaterThanOrEqual(MIN_VISIBLE_TILES);
        },
      ),
    );
  });

  it('BITES: a 224-device-px shorter axis returns deviceScale 1 (hard floor, accepts < MIN)', () => {
    // EXACTLY at the empty-window boundary: 224 device px = MIN * TILE_PX.
    // deviceScale 1, and the shorter axis shows exactly MIN tiles.
    // Kills: an implementation that lets the MIN clamp push deviceScale to 0
    // (blank stage) or below 1 (a fractional stage upscale = the blur bug).
    const atFloorDpr1 = viewportScale(400, 224, 1);
    expect(atFloorDpr1.deviceScale).toBe(1);
    expect(visibleTiles(atFloorDpr1)).toBeCloseTo(MIN_VISIBLE_TILES, 9);

    // Same 224 DEVICE px expressed as 112 CSS px at dpr 2 — the device-px
    // quantity, not the CSS quantity, is what the rule is written against.
    // Kills: a normalizer/algorithm that reasons in CSS px and forgets the dpr
    // factor (it would compute S = 3.5 here and pick a different scale).
    const atFloorDpr2 = viewportScale(400, 112, 2);
    expect(atFloorDpr2.deviceScale).toBe(1);
    expect(visibleTiles(atFloorDpr2)).toBeCloseTo(MIN_VISIBLE_TILES, 9);

    // BELOW the boundary the admissible window is EMPTY: MIN is best-effort and
    // is knowingly violated rather than going sub-1. 200 device px -> 6.25 tiles.
    // Kills: THROWING on the empty window (this runs from a resize handler next
    // to the frame loop — a throw kills rendering); kills returning NaN/0;
    // kills a fractional deviceScale "fix".
    const belowFloor = viewportScale(400, 200, 1);
    expect(belowFloor.deviceScale).toBe(1);
    expect(visibleTiles(belowFloor)).toBeCloseTo(6.25, 9);
    expect(Number.isNaN(belowFloor.stageScale)).toBe(false);
  });
});

// ===========================================================================
// A4 — WHEN computing scale for dpr, THE viewportScale core SHALL return
// deviceScale = max(1, round(idealCssScale*dpr)) (INTEGER) and
// stageScale = deviceScale/dpr.
// ===========================================================================

describe('A4: deviceScale is an integer >= 1; stageScale = deviceScale/dpr', () => {
  it('BITES: property — Number.isInteger(deviceScale) && >= 1', () => {
    // This postcondition is the whole point of "device-integer crisp": one source
    // texel must map to a WHOLE number of device pixels.
    // Kills: clamping/rounding the FLOAT stageScale and never producing an
    // integer at all; kills a missing `max(1, …)` (deviceScale 0 -> stageScale 0
    // -> a blank stage, and a division by zero in effectiveW).
    fc.assert(
      fc.property(cssArb, cssArb, dprArb, (cssW, cssH, dpr) => {
        const vs = viewportScale(cssW, cssH, dpr);
        expect(Number.isInteger(vs.deviceScale)).toBe(true);
        expect(vs.deviceScale).toBeGreaterThanOrEqual(1);
        expect(vs.stageScale).toBeGreaterThan(0);
        expect(Number.isFinite(vs.stageScale)).toBe(true);
        // NOTE: `stageScale * dpr === deviceScale` EXACTLY is mathematically
        // FALSE for many doubles — (d/r)*r !== d on ~11% of draws, including
        // dpr 1.7999999523162842. `toBeCloseTo(…, 9)` is the only honest form.
        // Kills: a stageScale that is NOT deviceScale/dpr — e.g. the clamped
        // float `idealCssScale`, which differs from deviceScale/dpr by up to 0.5.
        expect(vs.stageScale * vs.dpr).toBeCloseTo(vs.deviceScale, 9);
        // Kills: effectiveW/H returned in CSS px instead of SOURCE px (the
        // mixed-unit bug R1). effective = css / stageScale, so at any stageScale
        // > 1 the effective viewport is strictly SMALLER than the CSS one.
        expect(vs.effectiveW * vs.stageScale).toBeCloseTo(vs.cssW, 6);
        expect(vs.effectiveH * vs.stageScale).toBeCloseTo(vs.cssH, 6);
      }),
    );
  });

  it('BITES: table — 1920x1080 @dpr 1/2/3 → deviceScale 3/6/9, AND 1600x900 @1 → deviceScale 3', () => {
    // 1920x1080 is readable documentation of the shipped desktop behaviour...
    expect(viewportScale(1920, 1080, 1).deviceScale).toBe(3);
    expect(viewportScale(1920, 1080, 2).deviceScale).toBe(6);
    expect(viewportScale(1920, 1080, 3).deviceScale).toBe(9);

    // ...but it kills NOTHING about round-vs-floor: 1080 is a FIXED POINT of
    // Math.floor at all three dprs (S/TARGET = 3.068 / 6.136 / 9.205, and floor
    // and round agree on every one), and floor satisfies P-MAX and P-MIN
    // identically. 1600x900 @dpr 1 is the DISCRIMINATING case:
    //   S = 900/32 = 28.125 ; S/TARGET = 2.5568 ; round -> 3, floor -> 2.
    // Kills: `Math.floor`/`Math.trunc`/`Math.ceil` instead of `Math.round` for
    // D0 — floor is wrong on 44.6% of real window sizes and makes every sprite
    // a third smaller than designed.
    expect(viewportScale(1600, 900, 1).deviceScale).toBe(3);

    // stageScale = deviceScale/dpr is what actually reaches `stage.scale.set`.
    // Kills: returning deviceScale where stageScale is expected (at dpr 2 the
    // world would render exactly 2x too large and overflow the canvas).
    expect(viewportScale(1920, 1080, 1).stageScale).toBe(3);
    expect(viewportScale(1920, 1080, 2).stageScale).toBe(3);
    expect(viewportScale(1920, 1080, 3).stageScale).toBe(3);

    // The EFFECTIVE viewport in SOURCE px is what `offsetFor` must receive.
    // Kills: `effectiveW = cssW * stageScale` (sign/direction inversion of the
    // unit conversion) — that would give 5760, not 640.
    expect(viewportScale(1920, 1080, 1).effectiveW).toBe(640);
    expect(viewportScale(1920, 1080, 1).effectiveH).toBe(360);
  });
});

// ===========================================================================
// A7 — WHEN the renderer applies the camera each frame, worldToScreen(own tile
// center) SHALL equal the viewport center within ONE DEVICE PIXEL.
//
// RESTATED (ADR-0160 decision 4): A5 (center small maps) and A7 (player at the
// viewport center) genuinely contradict, and A6's scroll-clamp already violates
// A7's literal text on master today. A7 is therefore scoped to the UNCLAMPED
// axis; A7b below covers the clamped and centered axes.
//
// world.ts §2.6 routes `stage.position` through this same `worldToScreen`, so
// this tooth now sits on the SHIPPED formula, not a parallel one.
// ===========================================================================

describe('A7: viewportScale + offsetFor(effective) + worldToScreen composition', () => {
  it('BITES: composition — viewportScale + offsetFor(effectiveW/H) + worldToScreen lands the own tile center within 1 device px of the CSS viewport center WHEN the axis is unclamped', () => {
    const cam = new FollowCamera();

    // --- Deterministic case: 1920x1080 @dpr 1, 40x30 map, player at (20,15) ---
    // vs: deviceScale 3, stageScale 3, effective 640x360 SOURCE px.
    // mapPx 1280x960 >= effective on both axes, and the raw follow offsets
    // (336, 316) sit strictly inside [0, 640] / [0, 600] => BOTH axes unclamped.
    // worldToScreen(tileCenter) must be exactly (960, 540) = the CSS center.
    //
    // Kills: THE MIXED-UNIT BUG (R1) — feeding CSS px (1920x1080) into
    // `offsetFor` instead of the effective SOURCE viewport misses the center by
    // cssW/2 * (stageScale - 1) = 1280 CSS px here, i.e. the player is shoved
    // off-screen. Kills a missing `* stageScale` in worldToScreen (would land at
    // 320, 180). Kills a sign error `(off - world)` (would land at -960).
    const vs = viewportScale(1920, 1080, 1);
    const off = cam.offsetFor(20, 15, vs.effectiveW, vs.effectiveH, 40, 30);
    const center = worldToScreen({ x: 20.5 * TILE_PX, y: 15.5 * TILE_PX }, off, vs.stageScale);
    expect(center.x).toBeCloseTo(960, 9);
    expect(center.y).toBeCloseTo(540, 9);

    // --- Property: holds across every supported scale and dpr -----------------
    // A 500x500-tile map (16000 SOURCE px) is far larger than any effective
    // viewport these generators can produce (<= ~4300 px), and the player sits
    // at tile 250, so BOTH axes are on the scroll branch and strictly unclamped
    // for every draw — the precondition A7 is scoped to.
    // Kills: an implementation that is correct only at dpr 1, or only at integer
    // stageScale — the fractional-CSS half of "device-integer crisp + fractional
    // CSS fill" (spec:31) is exactly what this sweeps.
    fc.assert(
      fc.property(
        fc.integer({ min: 320, max: 3840 }),
        fc.integer({ min: 320, max: 3840 }),
        dprArb,
        (cssW, cssH, dpr) => {
          const v = viewportScale(cssW, cssH, dpr);
          const o = cam.offsetFor(250, 250, v.effectiveW, v.effectiveH, 500, 500);
          const p = worldToScreen({ x: 250.5 * TILE_PX, y: 250.5 * TILE_PX }, o, v.stageScale);
          // "within one device pixel": the screen coords are CSS px, so the
          // error in DEVICE px is |Δ CSS px| * dpr.
          expect(Math.abs(p.x - v.cssW / 2) * v.dpr).toBeLessThanOrEqual(1);
          expect(Math.abs(p.y - v.cssH / 2) * v.dpr).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

// ===========================================================================
// A7b — the universal companion to A7: what happens on the axes A7 excludes.
// (spec A5 "center when smaller" and A6 "no pixels outside the map edge".)
// ===========================================================================

describe('A7b: clamped and centered axes frame the map exactly', () => {
  it('BITES: on a CLAMPED axis the EXACT identity holds — offset 0 ⟹ worldToScreen(0).x === 0; offset mapPx−effW ⟹ worldToScreen(mapPx).x === cssW', () => {
    // 1920x1080 @dpr 1 -> stageScale 3, effective 640x360 (all EXACT doubles:
    // 1920/3 = 640, 1080/3 = 360, 640*3 = 1920 — so `===` is honest here and no
    // toBeCloseTo slack is needed or wanted).
    // Map 40x30 tiles = 1280x960 SOURCE px, larger than the effective viewport
    // on both axes, so both axes are on the scroll-clamp branch.
    const vs = viewportScale(1920, 1080, 1);
    const cam = new FollowCamera();

    // --- Player pinned at the map origin: offset clamps to 0 -----------------
    const topLeft = cam.offsetFor(0, 0, vs.effectiveW, vs.effectiveH, 40, 30);
    // Documents that this axis really IS clamped (otherwise the identity below
    // would be vacuously true for any offset).
    expect(topLeft).toEqual({ x: 0, y: 0 });
    const originOnScreen = worldToScreen({ x: 0, y: 0 }, topLeft, vs.stageScale);
    // Kills: any implementation that shows world LEFT OF / ABOVE the map origin
    // (a negative screen coordinate for world 0) — spec A6's "no pixels outside
    // the map edge". Kills a `+ off` sign flip in worldToScreen.
    expect(originOnScreen.x).toBe(0);
    expect(originOnScreen.y).toBe(0);

    // --- Player pinned at the far corner: offset clamps to mapPx - effective --
    const bottomRight = cam.offsetFor(39, 29, vs.effectiveW, vs.effectiveH, 40, 30);
    expect(bottomRight).toEqual({ x: 1280 - 640, y: 960 - 360 });
    const farEdge = worldToScreen({ x: 40 * TILE_PX, y: 30 * TILE_PX }, bottomRight, vs.stageScale);
    // The map's far edge must land EXACTLY on the far edge of the CSS viewport:
    // effectiveW * stageScale === cssW. This is the direct expression of "no
    // pixels outside the map edge" on the clamped branch.
    // Kills: THE MIXED-UNIT BUG on the clamped branch too — feeding CSS px into
    // offsetFor makes `mapPx - viewW` negative, the clamp collapses to 0, and
    // the far edge lands at 3840 (a 1920-px miss), showing a screen-wide band of
    // FLOOR_COLOR past the right edge of the map.
    // Kills: a `Math.round`/`Math.floor` applied to effectiveW or to the offset
    // (the identity stops being exact).
    expect(farEdge.x).toBe(1920);
    expect(farEdge.y).toBe(1080);
  });

  it('BITES: on a CENTERED axis worldToScreen(mapCenter) is the viewport center within 1 device px', () => {
    // The centered branch is the DEFAULT, not an edge case (plan R5): at
    // 1920x1080 @dpr 1 the effective viewport is 640x360 SOURCE px while every
    // shipped map is 10x7 = 320x224 SOURCE px, so BOTH axes center.
    // Expected offsets: x = -(640-320)/2 = -160 ; y = -(360-224)/2 = -68.
    // Map center in SOURCE px = (160, 112) -> screen ((160+160)*3, (112+68)*3)
    //                                       = (960, 540) = the CSS center.
    const vs = viewportScale(1920, 1080, 1);
    const cam = new FollowCamera();
    const off = cam.offsetFor(5, 3, vs.effectiveW, vs.effectiveH, 10, 7);
    const mapCenter = worldToScreen(
      { x: (10 * TILE_PX) / 2, y: (7 * TILE_PX) / 2 },
      off,
      vs.stageScale,
    );
    // Kills: the CURRENT `Math.max(0, …)` top-left pin (offset 0 -> the map
    // center lands at 480,336 and the whole zone is stranded in the top-left
    // corner — the literal playtest complaint, spec:10/spec:29).
    // Kills: an implementation that "fixes" A7 by force-centering the PLAYER on
    // a small map (the player is at tile (5,3), whose center is (176,112), not
    // (160,112) — force-centering the player would land x at 960 only by
    // scrolling the map off its own edge, which the A7b clamped test forbids).
    // Kills: an off-by-half-tile center (a 48-px miss at stageScale 3).
    expect(mapCenter.x).toBeCloseTo(960, 9);
    expect(mapCenter.y).toBeCloseTo(540, 9);

    // The player is NOT at the viewport center on a centered axis — asserting
    // this makes the A5-vs-A7 restatement executable rather than a comment.
    // Kills: a regression that re-centers on the player when the map fits.
    const playerOnScreen = worldToScreen(
      { x: 5.5 * TILE_PX, y: 3.5 * TILE_PX },
      off,
      vs.stageScale,
    );
    expect(playerOnScreen.x).toBeCloseTo(1008, 9);
  });
});

// ===========================================================================
// A11 — WHEN the own entity slides sub-tile across a full STEP_MS, THE resulting
// on-screen world position SHALL advance monotonically without per-frame
// reversal (device-scaling introduces no judder the tile-value e2e latch sees).
// ===========================================================================

describe('A11: sub-tile slide advances smoothly through worldToScreen', () => {
  it('BITES: worldToScreen at a fractional stageScale is NOT snapped to an integer pixel grid', () => {
    // NOTE / DELIBERATE PLAN DEVIATION, stated openly: the plan §3 A11 row's
    // literal one-liner `worldToScreen({x: 0.5*TILE_PX, y:0}, {x:0,y:0}, 1.5).x`
    // evaluates to 16 * 1.5 = 24 — an INTEGER. Asserting "not an integer" on it
    // would false-RED a CORRECT implementation, and a `Math.round` impl returns
    // 24 there too, so the sample cannot detect the very bug it targets. A
    // genuinely sub-pixel sample is used instead: a 30%-through sub-tile slide.
    //
    // stageScale 1.5 is real (deviceScale 3 at dpr 2, e.g. a 1024x600 @2 window).
    // 0.3 * 32 = 9.6 SOURCE px -> 14.4 CSS px.
    //
    // Kills: a device/CSS-grid `Math.round` inside worldToScreen (returns 14 —
    // and, since world.ts §2.6 routes `stage.position` through this function,
    // that rounding would quantize the LIVE sub-tile slide to whole pixels and
    // reintroduce exactly the judder ADR-0013 forbids). Kills `Math.round` on
    // the world coordinate first (round(9.6)*1.5 = 15). Kills `Math.floor` (14).
    const a = worldToScreen({ x: 0.3 * TILE_PX, y: 0 }, { x: 0, y: 0 }, 1.5).x;
    expect(a).toBeCloseTo(14.4, 9);
    expect(Number.isInteger(a)).toBe(false);

    // Kills: an x-only slide leaking into y (a copy-paste `world.x` in the y
    // branch would return 14.4 here, not 0) — the axes are independent.
    const b = worldToScreen({ x: 0.7 * TILE_PX, y: 0 }, { x: 0, y: 0 }, 1.5).y;
    expect(b).toBe(0);

    // A second, differently-phased sample ON THE Y AXIS, so a "round to the
    // nearest 0.5"/"nearest 0.2" variant cannot slip past the first sample and
    // so the y branch is proven non-snapping too.
    const c = worldToScreen({ x: 0, y: 0.7 * TILE_PX }, { x: 0, y: 0 }, 1.5).y;
    expect(c).toBeCloseTo(33.6, 9);
    expect(Number.isInteger(c)).toBe(false);
  });

  it('BITES: property — worldToScreen is NON-DECREASING in world.x over a sampled slide', () => {
    // NON-decreasing, deliberately NOT strictly increasing: with unbounded
    // generators a STRICT form false-REDs on a CORRECT implementation (~14% of
    // adjacent normal double pairs in [1,1e4] collide under `x * 1.5`).
    // Generators are bounded to |world| ~ [1, 1e4] with per-step deltas >= 1e-3
    // (a real sub-tile slide advances ~0.16 SOURCE px per frame at worst, but
    // 1e-3 is far above the ULP at 1e4 so a correct impl never ties).
    //
    // Kills: a per-frame `Math.round`/`Math.floor` (a rounding step is still
    // monotone, so this property alone is NOT the rounding tooth — the
    // deterministic test above is; this one kills a SIGN error, an `abs()`, a
    // modulo wrap, and any per-frame reversal introduced by device-grid snapping
    // that overshoots and backs up).
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e4, noNaN: true }),
        fc.array(fc.double({ min: 1e-3, max: 4, noNaN: true }), {
          minLength: 2,
          maxLength: 8,
        }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.constantFrom(...REALISTIC_STAGE_SCALES),
        (startX, deltas, offX, stageScale) => {
          const offset = { x: offX, y: 0 };
          let worldX = startX;
          let prev = worldToScreen({ x: worldX, y: 0 }, offset, stageScale).x;
          for (const d of deltas) {
            worldX += d;
            const next = worldToScreen({ x: worldX, y: 0 }, offset, stageScale).x;
            expect(next).toBeGreaterThanOrEqual(prev);
            prev = next;
          }
        },
      ),
    );
  });
});

// ===========================================================================
// screenToWorld — the inverse seam. Ships unwired per the slice brief
// (spec:34, spec:55: "the screenToWorld seam ships for a future milestone to
// consume, no listeners wired"), so its contract is proven here or nowhere.
// ===========================================================================

describe('screenToWorld: the inverse of worldToScreen', () => {
  it('BITES: screenToWorld applies +offset (not −offset) — the CSS viewport center maps back to the map center', () => {
    // A round-trip test ALONE cannot catch a consistently-mirrored pair: if BOTH
    // functions flip the offset sign, `screenToWorld(worldToScreen(w))` still
    // returns w. This absolute-direction case is what pins the sign.
    //
    // Reuses the A7b centered framing: 1920x1080 @dpr 1, stageScale 3, offset
    // (-160, -68). CSS (960, 540) must map back to SOURCE (160, 112) — the
    // center of a 10x7 map.
    // Kills: `p.x / s - off.x` (returns 480) and `(p.x - off.x) / s` (returns
    // 373.33) — both of which round-trip perfectly with a matching worldToScreen
    // bug and would ship a future tap-to-move that targets the wrong tile.
    const back = screenToWorld({ x: 960, y: 540 }, { x: -160, y: -68 }, 3);
    expect(back.x).toBeCloseTo(160, 9);
    expect(back.y).toBeCloseTo(112, 9);

    // Kills: a screenToWorld that MULTIPLIES by stageScale instead of dividing
    // (the CSS->SOURCE direction shrinks; 48 CSS px at stageScale 3 is 16 SOURCE
    // px, i.e. half a tile — not 144).
    expect(screenToWorld({ x: 48, y: 0 }, { x: 0, y: 0 }, 3).x).toBeCloseTo(16, 9);
  });

  it('BITES: property — screenToWorld ∘ worldToScreen round-trips within 1e-6 for bounded world/offset', () => {
    // |world| and |offset| are BOTH bounded to 1e4: real offsets are at most
    // mapPx (~640 SOURCE px today) and an unbounded offset generator pushes the
    // accumulated round-trip error to ~1.8e-4 at |offset| = 1e12, past a
    // toBeCloseTo(…, 6) budget — a false RED on a CORRECT implementation.
    // Kills: an asymmetric pair (e.g. worldToScreen subtracts the offset BEFORE
    // scaling while screenToWorld subtracts it AFTER); kills a dropped `+ off`
    // in one direction only; kills a y-axis that copies the x formula's offset.
    fc.assert(
      fc.property(
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.constantFrom(...REALISTIC_STAGE_SCALES),
        (worldX, worldY, offX, offY, stageScale) => {
          const offset = { x: offX, y: offY };
          const screen = worldToScreen({ x: worldX, y: worldY }, offset, stageScale);
          const back = screenToWorld(screen, offset, stageScale);
          expect(back.x).toBeCloseTo(worldX, 6);
          expect(back.y).toBeCloseTo(worldY, 6);
        },
      ),
    );
  });
});
