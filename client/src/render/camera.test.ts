// render/camera.test.ts — FollowCamera unit tests (M11c).
//
// SOURCE OF TRUTH: M11c EARS C1 — follow-camera math.
// The FollowCamera is a PURE computation: tile coordinates + view dimensions in,
// pixel-space offset out. No DOM, no Pixi, no side effects. All inputs injected.
//
// RED REASON: `camera.ts` does not exist yet. Every import will fail to compile
// until the implementer creates `client/src/render/camera.ts` and exports
// `FollowCamera` with an `offsetFor(...)` method.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FollowCamera } from './camera';

// ---------------------------------------------------------------------------
// Constants
// The camera works in pixel space. tile_px = 32 (from config.ts TILE_PX).
// `offsetFor` converts tile coordinates to pixels internally.
// Signature (per spec naming):
//   camera.offsetFor(
//     playerTileX: number,
//     playerTileY: number,
//     viewW: number,      // viewport width  in pixels
//     viewH: number,      // viewport height in pixels
//     mapWidthTiles: number,
//     mapHeightTiles: number,
//   ): { x: number; y: number }
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
// ---------------------------------------------------------------------------

describe('FollowCamera C1a: follow formula (playerPx - viewW/2)', () => {
  it('BITES: player at (5,3) in 10×7 map, 160×112 viewport → tile-center formula result (M12.5d-4)', () => {
    // Map: 10×7, viewport: 160×112, player at (5,3) (center of map).
    // Tile-CENTER formula (M12.5d-4): rawX = (5+0.5)*32 - 80 = 176-80 = 96; clamped=96
    //                                  rawY = (3+0.5)*32 - 56 = 112-56 = 56; clamped=56
    // OLD tile-CORNER formula:          rawX = 5*32 - 80 = 80; rawY = 3*32 - 56 = 40
    // Kills: an impl still using tile-corner formula (returns {x:80, y:40} instead of {x:96, y:56}).
    // This test is RED until the camera formula changes to (tile + 0.5) * TILE_PX.
    const cam = new FollowCamera();
    const off = cam.offsetFor(5, 3, 160, 112, 10, 7);
    expect(off.x).toBe(96);
    expect(off.y).toBe(56);
  });

  it('BITES: player at (1,1) near top-left with small viewport → offset clamped to (0,0)', () => {
    // rawX = 1*32 - 80 = -48 → clamped to 0
    // rawY = 1*32 - 56 = -24 → clamped to 0
    // Kills: an impl that returns negative offsets (scrolling before the map edge).
    const cam = new FollowCamera();
    const off = cam.offsetFor(1, 1, 160, 112, 10, 7);
    expect(off.x).toBe(0);
    expect(off.y).toBe(0);
  });

  it('BITES: player at bottom-right (9,6) near map edge → offset clamped to max', () => {
    // rawX = 9*32 - 80 = 288-80 = 208; max = 320-160 = 160 → clamped to 160
    // rawY = 6*32 - 56 = 192-56 = 136; max = 224-112 = 112 → clamped to 112
    // Kills: an impl that shows pixels outside the map (scrolls past the edge).
    const cam = new FollowCamera();
    const off = cam.offsetFor(9, 6, 160, 112, 10, 7);
    expect(off.x).toBe(160);
    expect(off.y).toBe(112);
  });
});

// ---------------------------------------------------------------------------
// C1b — map fits entirely in viewport: offset SHALL be (0,0)
// ---------------------------------------------------------------------------

describe('FollowCamera C1b: map fits in viewport → offset (0, 0)', () => {
  it('BITES: 10×7 tile map exactly fits a 320×224 viewport → (0, 0) regardless of player pos', () => {
    // mapPx = 320×224 = exactly the viewport. Any raw offset clamps to [0, max=0] → (0,0).
    // Kills: an impl that returns negative offsets (scrolling backward) when the map fits.
    const cam = new FollowCamera();
    expect(cam.offsetFor(5, 3, 320, 224, 10, 7)).toEqual({ x: 0, y: 0 });
    expect(cam.offsetFor(0, 0, 320, 224, 10, 7)).toEqual({ x: 0, y: 0 });
    expect(cam.offsetFor(9, 6, 320, 224, 10, 7)).toEqual({ x: 0, y: 0 });
  });

  it('BITES: map smaller than viewport → offset (0, 0) for any player position', () => {
    // 3×3 map = 96×96 px; viewport 320×224 — map is always fully visible.
    // Kills: an impl that computes a negative max-clamp (mapPx < viewPx) and allows negative offsets.
    const cam = new FollowCamera();
    expect(cam.offsetFor(0, 0, 320, 224, 3, 3)).toEqual({ x: 0, y: 0 });
    expect(cam.offsetFor(2, 2, 320, 224, 3, 3)).toEqual({ x: 0, y: 0 });
    expect(cam.offsetFor(1, 1, 320, 224, 3, 3)).toEqual({ x: 0, y: 0 });
  });

  it('BITES: 1×1 map in large viewport → (0, 0) (degenerate case, no crash)', () => {
    // Kills: an impl that throws on edge-case zero/negative map-minus-view values.
    const cam = new FollowCamera();
    expect(cam.offsetFor(0, 0, 640, 480, 1, 1)).toEqual({ x: 0, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// C1c — map boundary clamping (player at edge → no outside-map pixels shown)
// ---------------------------------------------------------------------------

describe('FollowCamera C1c: clamping at map boundaries', () => {
  it('BITES: player at left edge (x=0) → x-offset is 0 (never negative)', () => {
    // rawX = 0*32 - 80 = -80 → clamped to 0
    // Kills: an impl returning negative x (shows world before map origin).
    const cam = new FollowCamera();
    const off = cam.offsetFor(0, 3, 160, 112, 10, 7);
    expect(off.x).toBe(0);
  });

  it('BITES: player at right boundary (x = mapWidth-1) → x-offset clamped to mapPxW - viewW', () => {
    // rawX = 9*32 - 80 = 208; maxX = 320-160 = 160 → clamped to 160
    // Kills: an impl that returns 208, showing 48px outside the right map edge.
    const cam = new FollowCamera();
    const off = cam.offsetFor(9, 3, 160, 112, 10, 7);
    expect(off.x).toBe(160);
  });

  it('BITES: player at top edge (y=0) → y-offset is 0 (never negative)', () => {
    // rawY = 0*32 - 56 = -56 → clamped to 0
    // Kills: an impl returning negative y (shows world above map origin).
    const cam = new FollowCamera();
    const off = cam.offsetFor(5, 0, 160, 112, 10, 7);
    expect(off.y).toBe(0);
  });

  it('BITES: player at bottom boundary (y = mapHeight-1) → y-offset clamped to mapPxH - viewH', () => {
    // rawY = 6*32 - 56 = 136; maxY = 224-112 = 112 → clamped to 112
    // Kills: an impl that returns 136, showing 24px below the bottom map edge.
    const cam = new FollowCamera();
    const off = cam.offsetFor(5, 6, 160, 112, 10, 7);
    expect(off.y).toBe(112);
  });

  it('BITES: asymmetric viewport (wide screen) clamps x and y independently', () => {
    // Wide viewport 256×64, 8×8 map = 256×256 px.
    // mapW=256 fits in viewW=256, so maxX=0, all x-offsets clamp to 0.
    // mapH=256 > viewH=64, so maxY=256-64=192.
    // Player at (3, 7): rawX = 3*32-128=-32 → 0; rawY = 7*32-32=192 → min(192,192)=192
    // Kills: an impl that couples x/y clamping or uses wrong axis for each.
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
// Property-based: for any in-bounds player the offset is always in [0, mapPx-viewPx]
// ---------------------------------------------------------------------------

describe('FollowCamera property: offset always in valid clamp range', () => {
  it('BITES: for any player tile in [0, mapW/H), offset x in [0, mapPxW-viewW] and y in [0, mapPxH-viewH]', () => {
    // Kills: any impl that returns negative offsets OR overshoots the map edge.
    // fast-check block-body arrow (per framework gotcha — vitest-fast-check).
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // mapW
        fc.integer({ min: 1, max: 20 }), // mapH
        fc.integer({ min: 32, max: 800 }), // viewW
        fc.integer({ min: 32, max: 600 }), // viewH
        (mapW, mapH, viewW, viewH) => {
          const cam = new FollowCamera();
          const playerX = Math.floor(mapW / 2);
          const playerY = Math.floor(mapH / 2);
          const off = cam.offsetFor(playerX, playerY, viewW, viewH, mapW, mapH);
          const maxX = Math.max(0, mapW * TILE_PX - viewW);
          const maxY = Math.max(0, mapH * TILE_PX - viewH);
          expect(off.x).toBeGreaterThanOrEqual(0);
          expect(off.x).toBeLessThanOrEqual(maxX);
          expect(off.y).toBeGreaterThanOrEqual(0);
          expect(off.y).toBeLessThanOrEqual(maxY);
        },
      ),
    );
  });

  it('BITES: property — offset matches clamp((tile+0.5)*TILE_PX - viewSize/2, 0, max) formula (M12.5d-4)', () => {
    // Kills: an impl still using tile-corner formula (playerX * TILE_PX - viewW/2).
    // The tile-center formula (M12.5d-4) uses (playerX + 0.5) * TILE_PX - viewW/2 so
    // the camera centers on the middle of the player's tile, not its top-left corner.
    // This test is RED until the camera.ts implementation changes to tile-center math.
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 20 }), // mapW
        fc.integer({ min: 5, max: 20 }), // mapH
        fc.integer({ min: 1, max: 640 }), // viewW
        fc.integer({ min: 1, max: 480 }), // viewH
        fc.integer({ min: 0, max: 19 }), // playerTileX (will be min'd with mapW-1)
        fc.integer({ min: 0, max: 19 }), // playerTileY (will be min'd with mapH-1)
        (mapW, mapH, viewW, viewH, rawPX, rawPY) => {
          const cam = new FollowCamera();
          const playerX = Math.min(rawPX, mapW - 1);
          const playerY = Math.min(rawPY, mapH - 1);
          const off = cam.offsetFor(playerX, playerY, viewW, viewH, mapW, mapH);
          // Tile-center formula (M12.5d-4):
          const expectedX = clamp(
            (playerX + 0.5) * TILE_PX - viewW / 2,
            0,
            Math.max(0, mapW * TILE_PX - viewW),
          );
          const expectedY = clamp(
            (playerY + 0.5) * TILE_PX - viewH / 2,
            0,
            Math.max(0, mapH * TILE_PX - viewH),
          );
          expect(off.x).toBeCloseTo(expectedX, 5);
          expect(off.y).toBeCloseTo(expectedY, 5);
        },
      ),
    );
  });
});

// =============================================================================
// M12.5d-4: FollowCamera centers on tile CENTER (+0.5 tile offset)
// SOURCE OF TRUTH: M12.5d spec §4 "Camera: center on tile center not tile corner"
//
// RED REASON (before impl): camera.ts currently uses playerTileX * TILE_PX to
// convert the player tile to pixels (tile corner). After fix: (playerTileX + 0.5)
// * TILE_PX centers on the tile's midpoint.
//
// The concrete difference: player at tile 5, TILE_PX=32:
//   OLD (corner): rawX = 5*32 - viewW/2 = 160 - 80 = 80
//   NEW (center): rawX = 5.5*32 - viewW/2 = 176 - 80 = 96
// Tests below are RED until camera.ts uses the +0.5 formula.
// =============================================================================

describe('FollowCamera M12.5d-4: centers on tile CENTER (+0.5 tile offset)', () => {
  it('BITES (M12.5d-4): player at integer tile uses tile CENTER, not tile corner', () => {
    // With tile-corner: rawX = 5 * 32 - 80 = 80. With tile-center: rawX = 5.5 * 32 - 80 = 96.
    // This test is RED until camera.ts uses (playerTileX + 0.5) * TILE_PX.
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
    // This test passes for BOTH old and new formula (clamped to 0 in both cases),
    // so it is GREEN for both — it's a stability check that +0.5 doesn't break origin.
    const cam = new FollowCamera();
    const off = cam.offsetFor(0, 0, 160, 112, 10, 7);
    expect(off.x).toBe(0);
    expect(off.y).toBe(0);
  });

  it('BITES (M12.5d-4): property — formula uses (tile + 0.5) * TILE_PX - viewSize/2', () => {
    // Kills: any impl using tile-corner formula (playerX * TILE_PX - viewW/2).
    // For any player/map/view combination the tile-center formula must match exactly.
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 20 }),
        fc.integer({ min: 5, max: 20 }),
        fc.integer({ min: 1, max: 640 }),
        fc.integer({ min: 1, max: 480 }),
        fc.integer({ min: 0, max: 19 }),
        fc.integer({ min: 0, max: 19 }),
        (mapW, mapH, viewW, viewH, rawPX, rawPY) => {
          const cam = new FollowCamera();
          const playerX = Math.min(rawPX, mapW - 1);
          const playerY = Math.min(rawPY, mapH - 1);
          const off = cam.offsetFor(playerX, playerY, viewW, viewH, mapW, mapH);
          // Tile-center formula (M12.5d-4):
          const expectedX = clamp(
            (playerX + 0.5) * TILE_PX - viewW / 2,
            0,
            Math.max(0, mapW * TILE_PX - viewW),
          );
          const expectedY = clamp(
            (playerY + 0.5) * TILE_PX - viewH / 2,
            0,
            Math.max(0, mapH * TILE_PX - viewH),
          );
          expect(off.x).toBeCloseTo(expectedX, 5);
          expect(off.y).toBeCloseTo(expectedY, 5);
        },
      ),
    );
  });
});
