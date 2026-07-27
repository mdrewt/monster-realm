// render/camera.test.ts — FollowCamera unit tests (M11c + uxd1).
//
// SOURCE OF TRUTH: M11c EARS C1 (follow-camera math) AND
// specs/monster-realm-v2/M-postgate-ux-design.spec.md §uxd1 criteria A5 / A5b / A6 / A6b:
//   - A5  "WHERE the map ... is smaller than the viewport along an axis, THE FollowCamera
//          SHALL center the map on that axis (offset = -(effectiveViewport - mapPx)/2)
//          rather than pinning top-left."
//   - A5b  per-AXIS independence (the spec's named Residual, spec:63): one axis may scroll
//          while the other centers.
//   - A6  "WHERE the map ... is >= the viewport along an axis, THE FollowCamera SHALL
//          scroll-clamp that axis to [0, mapPx - effectiveViewport] centered on the
//          player's tile" (unchanged large-map behavior).
//   - A6b  the exactly-fits boundary is `>=`, not `>`.
//
// The FollowCamera is a PURE computation: tile coordinates + view dimensions in,
// pixel-space offset out. No DOM, no Pixi, no side effects. All inputs injected.
//
// RED REASON (uxd1): `camera.ts` has a SINGLE branch today —
// `Math.max(0, Math.min(raw, Math.max(0, mapPx - view)))` — which PINS a smaller-than-
// viewport map to the top-left at offset 0 (the literal playtest complaint: "tiny zones
// stranded top-left"). The new per-axis CENTER branch does not exist, so every centering
// assertion below (C1b, A5b, N3, N5) is RED by wrong-value, not by absence.
//
// UNIT CONTRACT CHANGE (uxd1): `viewW`/`viewH` now mean the EFFECTIVE viewport in SOURCE
// pixels (`cssPx / stageScale`), NOT CSS pixels. They are therefore NON-INTEGER in
// production by construction — see the fractional-viewport tooth at the bottom.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FollowCamera } from './camera';

// ---------------------------------------------------------------------------
// Constants
// The camera works in pixel space. tile_px = 32 (from config.ts TILE_PX).
// `offsetFor` converts tile coordinates to pixels internally.
// Signature (per spec naming; UNCHANGED at 6 args, only the UNIT of view* changed):
//   camera.offsetFor(
//     playerTileX: number,
//     playerTileY: number,
//     viewW: number,      // EFFECTIVE viewport width  in SOURCE px (cssW / stageScale)
//     viewH: number,      // EFFECTIVE viewport height in SOURCE px (cssH / stageScale)
//     mapWidthTiles: number,
//     mapHeightTiles: number,
//   ): { x: number; y: number }
//
// Per-axis rule (x shown; y is identical with mapHeightTiles / viewH):
//   mapPx = mapWidthTiles * TILE_PX
//   mapPx >= viewW  →  SCROLL-CLAMP: clamp((playerTileX + 0.5) * TILE_PX - viewW/2,
//                                          0, mapPx - viewW)
//   mapPx <  viewW  →  CENTER:       -(viewW - mapPx) / 2
// ---------------------------------------------------------------------------

const TILE_PX = 32;

/** Helper: clamp n into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

describe('FollowCamera.offsetFor: class exists and is callable', () => {
  it('constructs without arguments and exposes offsetFor()', () => {
    // Kills: an impl where FollowCamera requires constructor args, or where
    // `offsetFor` is not a method (e.g., a plain function export instead of class).
    const cam = new FollowCamera();
    expect(typeof cam.offsetFor).toBe('function');
  });

  it('returns an object with numeric x and y properties', () => {
    // Kills: an impl that returns a tuple, an array, or omits one axis.
    const cam = new FollowCamera();
    const off = cam.offsetFor(5, 3, 320, 224, 10, 7);
    expect(typeof off.x).toBe('number');
    expect(typeof off.y).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// C1a — centered player: offset = playerPx - viewW/2, clamped to [0, mapPx - viewPx]
// (uxd1: the SCROLL branch — kept verbatim as the large-map regression guard, A6.)
// ---------------------------------------------------------------------------

describe('FollowCamera C1a: follow formula (playerPx - viewW/2)', () => {
  it('BITES: player at (5,3) in 10×7 map, 160×112 viewport → tile-center formula result (M12.5d-4)', () => {
    // Map: 10×7, viewport: 160×112, player at (5,3) (center of map).
    // Tile-CENTER formula (M12.5d-4): rawX = (5+0.5)*32 - 80 = 176-80 = 96; clamped=96
    //                                  rawY = (3+0.5)*32 - 56 = 112-56 = 56; clamped=56
    // OLD tile-CORNER formula:          rawX = 5*32 - 80 = 80; rawY = 3*32 - 56 = 40
    // Kills: an impl still using tile-corner formula (returns {x:80, y:40} instead of {x:96, y:56}).
    const cam = new FollowCamera();
    const off = cam.offsetFor(5, 3, 160, 112, 10, 7);
    expect(off.x).toBe(96);
    expect(off.y).toBe(56);
  });

  it('BITES: player at (1,1) near top-left with small viewport → offset clamped to (0,0)', () => {
    // tile-center: rawX = (1+0.5)*32 - 80 = -32 → clamped to 0
    // tile-center: rawY = (1+0.5)*32 - 56 = -8  → clamped to 0
    // Kills: an impl that returns negative offsets (scrolling before the map edge).
    const cam = new FollowCamera();
    const off = cam.offsetFor(1, 1, 160, 112, 10, 7);
    expect(off.x).toBe(0);
    expect(off.y).toBe(0);
  });

  it('BITES: player at bottom-right (9,6) near map edge → offset clamped to max', () => {
    // tile-center: rawX = (9+0.5)*32 - 80 = 224; max = 320-160 = 160 → clamped to 160
    // tile-center: rawY = (6+0.5)*32 - 56 = 152; max = 224-112 = 112 → clamped to 112
    // Kills: an impl that shows pixels outside the map (scrolls past the edge).
    const cam = new FollowCamera();
    const off = cam.offsetFor(9, 6, 160, 112, 10, 7);
    expect(off.x).toBe(160);
    expect(off.y).toBe(112);
  });
});

// ---------------------------------------------------------------------------
// C1b — map SMALLER than the effective viewport: offset SHALL CENTER, per axis
// (uxd1 A5 — this block replaces the old "→ (0,0)" top-left pin.)
// ---------------------------------------------------------------------------

describe('FollowCamera C1b: map smaller than viewport → per-axis CENTER', () => {
  it('BITES: 10×7 tile map exactly fits a 320×224 viewport → (0, 0) regardless of player pos', () => {
    // mapPx = 320×224 = exactly the viewport. Any raw offset clamps to [0, max=0] → (0,0).
    // Kills: an impl that returns negative offsets (scrolling backward) when the map fits.
    //
    // uxd1 A6b — THIS TEST IS THE `>` vs `>=` BOUNDARY GUARD (no separate tooth needed):
    // mapPx === view on BOTH axes here, so the correct `mapPx >= view` takes the SCROLL
    // branch, whose clamp to [0, 0] yields `+0`. A `>` impl falls into the CENTER branch
    // and computes `-(320 - 320)/2` === `-0`. vitest routes numeric `toEqual`/`toBe`
    // through `Object.is`, and `Object.is(-0, 0)` is false — so a `>` impl fails HERE.
    const cam = new FollowCamera();
    expect(cam.offsetFor(5, 3, 320, 224, 10, 7)).toEqual({ x: 0, y: 0 });
    expect(cam.offsetFor(0, 0, 320, 224, 10, 7)).toEqual({ x: 0, y: 0 });
    expect(cam.offsetFor(9, 6, 320, 224, 10, 7)).toEqual({ x: 0, y: 0 });
  });

  it('BITES (N1): 3×3 map in a 320×224 viewport → CENTERED at (-112,-64) for EVERY player position', () => {
    // 3×3 map = 96×96 source px; effective viewport 320×224 — smaller on BOTH axes.
    //   x: 96 < 320 → center: -(320 - 96)/2 = -224/2 = -112
    //   y: 96 < 224 → center: -(224 - 96)/2 = -128/2 =  -64
    // Kills (1): the CURRENT master impl `Math.max(0, ...)` — it pins the map top-left at
    //   (0,0) (the playtest complaint "tiny zones stranded top-left"). Returns 0, not -112.
    // Kills (2): an impl that still TRACKS the player on a centered axis — the three player
    //   positions below span the whole map, and a tracking impl returns a DIFFERENT x for
    //   each (raw = 16-160 = -144 at tile 0 vs 80-160 = -80 at tile 2).
    // Kills (3): an off-by-half-tile center (-112 ± 16).
    const cam = new FollowCamera();
    expect(cam.offsetFor(0, 0, 320, 224, 3, 3)).toEqual({ x: -112, y: -64 });
    expect(cam.offsetFor(2, 2, 320, 224, 3, 3)).toEqual({ x: -112, y: -64 });
    expect(cam.offsetFor(1, 1, 320, 224, 3, 3)).toEqual({ x: -112, y: -64 });
  });

  it('BITES: 1×1 map in a 640×480 viewport → centered at (-304,-224) (degenerate case, no crash)', () => {
    // 1×1 map = 32×32 source px.
    //   x: 32 < 640 → -(640 - 32)/2 = -608/2 = -304
    //   y: 32 < 480 → -(480 - 32)/2 = -448/2 = -224
    // Kills: an impl that throws / returns NaN on the extreme mapPx << view case, and the
    // top-left pin (which returns (0,0) here).
    const cam = new FollowCamera();
    expect(cam.offsetFor(0, 0, 640, 480, 1, 1)).toEqual({ x: -304, y: -224 });
  });
});

// ---------------------------------------------------------------------------
// A5b — PER-AXIS independence: one axis scrolls while the other centers.
// Highest-value new tooth; discharges the spec's named Residual (spec:63).
// ---------------------------------------------------------------------------

describe('FollowCamera A5b: per-axis independence (one axis scrolls, the other centers)', () => {
  it('BITES (N2): 20×3 map in a 320×224 viewport — x SCROLL-clamps while y CENTERS at -64', () => {
    // mapPxW = 20*32 = 640 >= 320 → SCROLL x, clamped to [0, 640-320] = [0, 320]
    // mapPxH =  3*32 =  96 <  224 → CENTER y = -(224 - 96)/2 = -128/2 = -64
    //   player (0,1):  rawX = (0+0.5)*32 - 160 =  16-160 = -144 → clamp → 0
    //   player (10,1): rawX = (10+0.5)*32 - 160 = 336-160 =  176 → clamp → 176
    //   player (19,1): rawX = (19+0.5)*32 - 160 = 624-160 =  464 → clamp → 320
    // Kills BOTH plausible single-combined-condition impls:
    //   `mapFitsW && mapFitsH` → false → both axes scroll → y = clamp(rawY, 0, 0) = 0, not -64.
    //   `mapFitsW || mapFitsH` → true  → both axes center → x = -(320-640)/2 = +160, which
    //      differs from the correct 0 / 176 / 320 at all three player positions.
    const cam = new FollowCamera();
    expect(cam.offsetFor(0, 1, 320, 224, 20, 3)).toEqual({ x: 0, y: -64 });
    expect(cam.offsetFor(10, 1, 320, 224, 20, 3)).toEqual({ x: 176, y: -64 });
    expect(cam.offsetFor(19, 1, 320, 224, 20, 3)).toEqual({ x: 320, y: -64 });
  });

  it('BITES (N2, transposed): 3×20 map in a 320×224 viewport — x CENTERS at -112 while y SCROLLS', () => {
    // mapPxW =  3*32 =  96 <  320 → CENTER x = -(320 - 96)/2 = -224/2 = -112
    // mapPxH = 20*32 = 640 >= 224 → SCROLL y, clamped to [0, 640-224] = [0, 416]
    //   player (1,10): rawY = (10+0.5)*32 - 112 = 336-112 = 224 → clamp → 224
    //   player (1,19): rawY = (19+0.5)*32 - 112 = 624-112 = 512 → clamp → 416
    // Kills: the copy-paste axis bug — a y-branch that tests the WIDTH condition
    // (`mapPxW >= viewH`: 96 < 224 → would CENTER y at -(224-640)/2 = +208, not 224/416),
    // and symmetrically an x-branch driven by the height. Neither dies on N2 alone.
    const cam = new FollowCamera();
    expect(cam.offsetFor(1, 10, 320, 224, 3, 20)).toEqual({ x: -112, y: 224 });
    expect(cam.offsetFor(1, 19, 320, 224, 3, 20)).toEqual({ x: -112, y: 416 });
  });
});

// ---------------------------------------------------------------------------
// A6 — fractional EFFECTIVE viewport (SOURCE px = cssPx / stageScale).
// After uxd1 the viewport args are non-integer BY CONSTRUCTION; nothing on
// master covered that.
// ---------------------------------------------------------------------------

describe('FollowCamera A6: fractional effective viewport (cssPx / stageScale)', () => {
  it('BITES (N5): 10×7 map, 1366×768 CSS at stageScale 1.5 → x centers at exactly -295.3333333333333', () => {
    // A 1366×768 laptop at deviceScale 3 / dpr 2 (stageScale = 1.5) gives an EFFECTIVE
    // viewport of 1366/1.5 = 910.6666666666666 × 768/1.5 = 512 SOURCE px.
    //   x: mapPxW = 10*32 = 320 < 910.666… → center: -(910.6666666666666 - 320)/2
    //                                              = -(590.6666666666666)/2
    //                                              = -295.3333333333333
    //   y: mapPxH =  7*32 = 224 < 512      → center: -(512 - 224)/2 = -288/2 = -144
    // The x arithmetic is EXACT in IEEE-754 doubles (hand-verified): 1366/1.5 rounds to
    // m·2^-43 with m = 8010308712224085; 320 is a multiple of 2^-43, so the subtraction is
    // exact and the halving is a pure exponent shift. The shortest round-tripping decimal
    // of the result is -295.3333333333333, so `toBe` is safe here (no epsilon needed).
    // Kills: any impl that FLOORS/ROUNDS the viewport or the offset to an integer or a
    // device grid — floor(910.666…) → -295 exactly, and Math.round(-295.333…) → -295.
    // Both differ from -295.3333333333333 under Object.is. (Anti-pattern §6.4; such an
    // impl also breaks ADR-0013 sub-tile slide smoothness.)
    const cam = new FollowCamera();
    const off = cam.offsetFor(5, 3, 1366 / 1.5, 768 / 1.5, 10, 7);
    expect(off.x).toBe(-295.3333333333333);
    expect(off.y).toBe(-144);

    // Fractional viewport on the SCROLL branch: the CLAMP BOUND must stay fractional too.
    // Both axes above land on the CENTER branch, and every other scroll-branch test in this
    // file passes an INTEGER view (160/112, 320/224, 256/64, integer fast-check generators),
    // so without this line `mapPx - view` is never once evaluated with a fractional view.
    // Widen the map to 40 tiles so x scrolls against the same 910.666… viewport:
    //   mapPxW = 40*32 = 1280 >= 910.6666666666666 → SCROLL branch
    //   raw = (39+0.5)*32 - 910.6666666666666/2 = 1264 - 455.3333333333333 = 808.6666666666667
    //   max = 1280 - 910.6666666666666 = 369.33333333333337  (exact in doubles: both operands
    //         are multiples of 2^-43 and the difference fits in 53 bits; the shortest
    //         round-tripping decimal is 369.33333333333337 — note 369.3333333333334 is a
    //         DIFFERENT double, just past the half-ulp, so this literal is load-bearing)
    //   raw > max → clamped to max.
    // Kills: `mapPx - Math.floor(view)` (or any round/ceil of the view) in the clamp bound —
    // it yields 370, letting up to frac(effW) source px (~6 CSS px at stageScale 6) of
    // FLOOR_COLOR show past the map edge. That is a direct violation of spec A6 "no pixels
    // outside the map edge are shown" and anti-pattern §6.4, and it survives every other
    // test in this file.
    expect(cam.offsetFor(39, 3, 1366 / 1.5, 768 / 1.5, 40, 7).x).toBe(369.33333333333337);
  });
});

// ---------------------------------------------------------------------------
// C1c — map boundary clamping (player at edge → no outside-map pixels shown)
// (uxd1: all five are SCROLL-branch cases — kept verbatim as the A6 guard.)
// ---------------------------------------------------------------------------

describe('FollowCamera C1c: clamping at map boundaries', () => {
  it('BITES: player at left edge (x=0) → x-offset is 0 (never negative)', () => {
    // tile-center: rawX = (0+0.5)*32 - 80 = -64 → clamped to 0
    // Kills: an impl returning negative x (shows world before map origin).
    const cam = new FollowCamera();
    const off = cam.offsetFor(0, 3, 160, 112, 10, 7);
    expect(off.x).toBe(0);
  });

  it('BITES: player at right boundary (x = mapWidth-1) → x-offset clamped to mapPxW - viewW', () => {
    // tile-center: rawX = (9+0.5)*32 - 80 = 224; maxX = 320-160 = 160 → clamped to 160
    // Kills: an impl that returns 224, showing pixels outside the right map edge.
    const cam = new FollowCamera();
    const off = cam.offsetFor(9, 3, 160, 112, 10, 7);
    expect(off.x).toBe(160);
  });

  it('BITES: player at top edge (y=0) → y-offset is 0 (never negative)', () => {
    // tile-center: rawY = (0+0.5)*32 - 56 = -40 → clamped to 0
    // Kills: an impl returning negative y (shows world above map origin).
    const cam = new FollowCamera();
    const off = cam.offsetFor(5, 0, 160, 112, 10, 7);
    expect(off.y).toBe(0);
  });

  it('BITES: player at bottom boundary (y = mapHeight-1) → y-offset clamped to mapPxH - viewH', () => {
    // tile-center: rawY = (6+0.5)*32 - 56 = 152; maxY = 224-112 = 112 → clamped to 112
    // Kills: an impl that returns 152, showing pixels below the bottom map edge.
    const cam = new FollowCamera();
    const off = cam.offsetFor(5, 6, 160, 112, 10, 7);
    expect(off.y).toBe(112);
  });

  it('BITES: asymmetric viewport (wide screen) clamps x and y independently', () => {
    // Wide viewport 256×64, 8×8 map = 256×256 px.
    // mapW=256 fits in viewW=256, so maxX=0, all x-offsets clamp to 0.
    // mapH=256 > viewH=64, so maxY=256-64=192.
    // tile-center: rawX = (3+0.5)*32-128=-16 → 0; rawY = (7+0.5)*32-32=208; max=192 → 192
    // Kills: an impl that couples x/y clamping or uses wrong axis for each.
    //
    // uxd1: this is ALREADY a per-axis + `+0` guard and stays verbatim. x hits the
    // `mapPx === viewW` boundary (256 === 256) so the correct `>=` takes the SCROLL branch
    // and yields `+0`; a `>` impl centers and yields `-0`, which `toBe(0)` rejects via
    // Object.is. y (256 >= 64) scrolls and clamps 208 → 192 on the SAME call, so an impl
    // with one combined fits-condition dies here too.
    const cam = new FollowCamera();
    const off = cam.offsetFor(3, 7, 256, 64, 8, 8);
    expect(off.x).toBe(0);
    expect(off.y).toBe(192);
  });
});

// ---------------------------------------------------------------------------
// C1d — purity: no side effects, deterministic for same inputs
// ---------------------------------------------------------------------------

describe('FollowCamera C1d: pure computation (no side effects)', () => {
  it('BITES: same inputs always produce same output (referential transparency)', () => {
    // Kills: an impl that maintains mutable internal state that drifts between calls.
    const cam = new FollowCamera();
    const a = cam.offsetFor(5, 3, 160, 112, 10, 7);
    const b = cam.offsetFor(5, 3, 160, 112, 10, 7);
    expect(a).toEqual(b);
  });

  it('BITES: interleaved calls with different args do not corrupt each other', () => {
    // Kills: an impl that accumulates state from prior calls.
    // Values updated for tile-center formula (M12.5d-4):
    // player (5,3) with 160×112 viewport in 10×7 map → x=96, y=56
    // ((5+0.5)*32 - 80 = 96; (3+0.5)*32 - 56 = 56)
    const cam = new FollowCamera();
    const _irrelevant = cam.offsetFor(9, 6, 160, 112, 10, 7); // far corner
    const center = cam.offsetFor(5, 3, 160, 112, 10, 7);
    expect(center.x).toBe(96);
    expect(center.y).toBe(56);
  });

  it('BITES: two independent FollowCamera instances return the same result', () => {
    // Kills: an impl that has singleton / global state shared across instances.
    const cam1 = new FollowCamera();
    const cam2 = new FollowCamera();
    const off1 = cam1.offsetFor(4, 2, 160, 112, 10, 7);
    const off2 = cam2.offsetFor(4, 2, 160, 112, 10, 7);
    expect(off1).toEqual(off2);
  });
});

// ---------------------------------------------------------------------------
// Property-based, PER AXIS (uxd1 A5 + A6).
//
// These two properties are deliberately FORMULA-INDEPENDENT: they assert range
// membership on a scrolled axis and gap symmetry on a centered axis. They do NOT
// re-derive `offsetFor`'s two-branch expression — a property written from the same
// formula as the implementation passes by construction and has no teeth.
//
// The generators (mapPx ∈ [32, 640] vs view ∈ [32, 800]) straddle the branch point, so
// both branches are exercised many times across the default 100 runs, on both axes.
// ---------------------------------------------------------------------------

describe('FollowCamera properties: per-axis scroll range and centering symmetry', () => {
  it('BITES: property — a SCROLLED axis (mapPx >= view) stays inside [0, mapPx - view]', () => {
    // Kills: an impl that centers UNCONDITIONALLY (a centered offset is strictly negative
    // whenever view > mapPx, and on a scrolled axis centering would leave the range),
    // and any impl that returns negative offsets OR overshoots the map edge (spec A6:
    // "no pixels outside the map edge are shown").
    // fast-check block-body arrow (per framework gotcha — vitest-fast-check).
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // mapW
        fc.integer({ min: 1, max: 20 }), // mapH
        fc.integer({ min: 32, max: 800 }), // viewW (EFFECTIVE, source px)
        fc.integer({ min: 32, max: 600 }), // viewH (EFFECTIVE, source px)
        (mapW, mapH, viewW, viewH) => {
          const cam = new FollowCamera();
          const playerX = Math.floor(mapW / 2);
          const playerY = Math.floor(mapH / 2);
          const off = cam.offsetFor(playerX, playerY, viewW, viewH, mapW, mapH);
          const mapPxW = mapW * TILE_PX;
          const mapPxH = mapH * TILE_PX;
          if (mapPxW >= viewW) {
            expect(off.x).toBeGreaterThanOrEqual(0);
            expect(off.x).toBeLessThanOrEqual(mapPxW - viewW);
          }
          if (mapPxH >= viewH) {
            expect(off.y).toBeGreaterThanOrEqual(0);
            expect(off.y).toBeLessThanOrEqual(mapPxH - viewH);
          }
        },
      ),
    );
  });

  it('BITES (N3): property — a CENTERED axis (mapPx < view) has leftGap === rightGap', () => {
    // A world point w lands at screen coordinate (w - offset), so the map occupies
    // [-offset, mapPx - offset] inside the viewport [0, view]:
    //   leftGap  = -offset                     (viewport left edge → map left edge)
    //   rightGap = view - (mapPx - offset)     (map right edge → viewport right edge)
    // "Centered" IS leftGap === rightGap. This is the spec statement (A5), not a copy of
    // the implementation's expression — it constrains the offset without naming it.
    // Kills:
    //   - the CURRENT top-left pin (offset 0 → leftGap 0, rightGap view-mapPx > 0);
    //   - a sign-flipped center (+D/2 → leftGap -D/2 vs rightGap 1.5·D);
    //   - an off-by-half-tile center (gaps differ by 32);
    //   - any residual player-tracking on the centered axis (asymmetric gaps).
    // Exactness: view and mapPx are integers here, so -(view-mapPx)/2 and both gaps are
    // exact multiples of 0.5 — `toBe` needs no epsilon. The branch is strict (`<`), so
    // both gaps are > 0 and the -0/+0 Object.is trap cannot fire.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // mapW
        fc.integer({ min: 1, max: 20 }), // mapH
        fc.integer({ min: 32, max: 800 }), // viewW (EFFECTIVE, source px)
        fc.integer({ min: 32, max: 600 }), // viewH (EFFECTIVE, source px)
        (mapW, mapH, viewW, viewH) => {
          const cam = new FollowCamera();
          const playerX = Math.floor(mapW / 2);
          const playerY = Math.floor(mapH / 2);
          const off = cam.offsetFor(playerX, playerY, viewW, viewH, mapW, mapH);
          const mapPxW = mapW * TILE_PX;
          const mapPxH = mapH * TILE_PX;
          if (mapPxW < viewW) {
            expect(-off.x).toBe(viewW - mapPxW + off.x);
          }
          if (mapPxH < viewH) {
            expect(-off.y).toBe(viewH - mapPxH + off.y);
          }
        },
      ),
    );
  });
});

// =============================================================================
// M12.5d-4: FollowCamera centers on tile CENTER (+0.5 tile offset)
// SOURCE OF TRUTH: M12.5d spec §4 "Camera: center on tile center not tile corner"
//
// The concrete difference: player at tile 5, TILE_PX=32:
//   OLD (corner): rawX = 5*32 - viewW/2 = 160 - 80 = 80
//   NEW (center): rawX = 5.5*32 - viewW/2 = 176 - 80 = 96
//
// uxd1 note: tile-center ANCHORING is a property of the SCROLL branch only — a centered
// axis ignores the player entirely — so the property below constrains its generators to
// the scroll branch. The centered branch is covered by C1b / A5b / N3 above.
// =============================================================================

describe('FollowCamera M12.5d-4: centers on tile CENTER (+0.5 tile offset)', () => {
  it('BITES (M12.5d-4): player at integer tile uses tile CENTER, not tile corner', () => {
    // With tile-corner: rawX = 5 * 32 - 80 = 80. With tile-center: rawX = 5.5 * 32 - 80 = 96.
    // Wrong impl killed: playerTileX * TILE_PX (corner) returns {x:80, y:40} not {x:96, y:56}.
    const cam = new FollowCamera();
    const off = cam.offsetFor(5, 3, 160, 112, 10, 7);
    // tile center: rawX = (5 + 0.5) * 32 - 80 = 176 - 80 = 96; clamped: min(96, 160) = 96
    // tile center: rawY = (3 + 0.5) * 32 - 56 = 112 - 56 = 56; clamped: min(56, 112) = 56
    expect(off.x).toBe(96);
    expect(off.y).toBe(56);
  });

  it('BITES (M12.5d-4): player at (0,0) with tile center still clamps to (0,0)', () => {
    // rawX = 0.5 * 32 - 80 = 16 - 80 = -64 → clamped to 0
    // rawY = 0.5 * 32 - 56 = 16 - 56 = -40 → clamped to 0
    // (same result as tile-corner for map origin — clamping produces (0,0) in both)
    // It is a stability check that +0.5 doesn't break the origin — and, post-uxd1, that
    // the 10×7 map in a 160×112 viewport still takes the SCROLL branch on both axes.
    const cam = new FollowCamera();
    const off = cam.offsetFor(0, 0, 160, 112, 10, 7);
    expect(off.x).toBe(0);
    expect(off.y).toBe(0);
  });

  it('BITES (M12.5d-4): property — a SCROLLED axis uses (tile + 0.5) * TILE_PX - viewSize/2', () => {
    // Kills: any impl using the tile-corner formula (playerX * TILE_PX - viewW/2) — it is
    // off by exactly half a tile (16 px) on every unclamped draw.
    //
    // GENERATOR CONSTRAINT (uxd1, load-bearing): mapW >= 20 ⟹ mapPxW >= 640 >= viewW, and
    // mapH >= 15 ⟹ mapPxH >= 480 >= viewH, so EVERY draw is on the scroll branch on BOTH
    // axes. Without this, viewW > mapPxW draws would reach the CENTER branch, where this
    // clamp expression is simply the wrong law — it would false-RED a CORRECT impl, which
    // no implementer could fix without editing a gating test. The mirrored expression is
    // legitimate here only because it is the ONE-branch law on this restricted domain.
    //
    // ⚠ NOT THE PRIMARY SCROLL-BRANCH TOOTH. This property is a formula MIRROR of the
    // production expression: an implementer who copies the expected-value lines below into
    // camera.ts passes it BY CONSTRUCTION. It does bite in practice (it kills the missing
    // lower clamp, the missing upper clamp, the tile-corner anchor and the axis copy-paste),
    // but the load-bearing scroll-branch teeth are the hand-computed deterministic cases
    // (C1a, C1c, N2, N5) and the formula-independent range property above — judge the scroll
    // branch by THOSE, not by this one.
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 40 }), // mapW  → mapPxW ∈ [640, 1280]
        fc.integer({ min: 15, max: 40 }), // mapH  → mapPxH ∈ [480, 1280]
        fc.integer({ min: 1, max: 640 }), // viewW ≤ 640 ≤ mapPxW
        fc.integer({ min: 1, max: 480 }), // viewH ≤ 480 ≤ mapPxH
        fc.integer({ min: 0, max: 39 }), // playerTileX (will be min'd with mapW-1)
        fc.integer({ min: 0, max: 39 }), // playerTileY (will be min'd with mapH-1)
        (mapW, mapH, viewW, viewH, rawPX, rawPY) => {
          const cam = new FollowCamera();
          const playerX = Math.min(rawPX, mapW - 1);
          const playerY = Math.min(rawPY, mapH - 1);
          const off = cam.offsetFor(playerX, playerY, viewW, viewH, mapW, mapH);
          // Tile-center formula (M12.5d-4), scroll branch only:
          const expectedX = clamp((playerX + 0.5) * TILE_PX - viewW / 2, 0, mapW * TILE_PX - viewW);
          const expectedY = clamp((playerY + 0.5) * TILE_PX - viewH / 2, 0, mapH * TILE_PX - viewH);
          expect(off.x).toBeCloseTo(expectedX, 5);
          expect(off.y).toBeCloseTo(expectedY, 5);
        },
      ),
    );
  });
});
