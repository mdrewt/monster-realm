// render/decorLayout.ts — the landmark + warp-marker layer's pure core (wap-6).
//
// PURE. Every decor DECISION the world renderer makes lives here, so it is unit-
// tested without Pixi: which landmark sprite goes on which tile (from the map's
// `landmarks` content rows, never a hard-coded coordinate), which tiles carry a
// warp marker (every warp source tile), each landmark's row z-index (the SAME
// `zIndexForEntity` the character sprites sort by, so a two-tile-tall landmark
// draws in front of a character on the row above and behind one on the row
// below), and which pulse frame a warp marker shows at an injected `nowMs`
// (frame 0 under reduced motion). `world.ts` (the coverage-excluded imperative
// shell) only turns these decisions into Pixi calls. No `Math.random`, no
// wall-clock read: time arrives as `nowMs`.
import { LANDMARK_FRAME, WARP_MARKER_FRAMES } from './art/packs/landmarks';
import type { Landmark } from './map';
import { waterFrameIndex } from './terrainLayout';
import { zIndexForEntity } from './zorder';

/** The slice of `TileMap` the decor planner reads (TileMap satisfies it structurally). */
export interface DecorSource {
  readonly width: number;
  readonly height: number;
  readonly landmarks: readonly Landmark[];
  isWarp(x: number, y: number): boolean;
}

/** A landmark sprite: its tile, its frame key, and its row z-index (zorder.ts). */
export interface LandmarkPlacement {
  readonly x: number;
  readonly y: number;
  readonly frame: string;
  readonly zIndex: number;
}

/** A warp marker on a warp source tile: its pulse frame keys in play order. */
export interface WarpMarkerPlacement {
  readonly x: number;
  readonly y: number;
  readonly frames: readonly string[];
}

export interface DecorPlan {
  readonly landmarks: readonly LandmarkPlacement[];
  readonly warps: readonly WarpMarkerPlacement[];
}

/** Per-frame period of the warp-marker pulse, in ms.
 *  WHY 250 (not the water's 400): the four frames cycle in 1 s, a quicker beat than
 *  the swell around it, so the marker reads as a live portal rather than more water. */
export const WARP_PULSE_MS = 250;

const inBounds = (map: DecorSource, x: number, y: number): boolean =>
  Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.width && y < map.height;

/** Lay out the map's decor: one landmark sprite per in-bounds `landmarks` entry, in
 *  input order, and one warp marker per warp source tile, row-major. */
export function layoutDecor(map: DecorSource): DecorPlan {
  const landmarks: LandmarkPlacement[] = [];
  for (const mark of map.landmarks) {
    if (!inBounds(map, mark.x, mark.y)) continue;
    landmarks.push({
      x: mark.x,
      y: mark.y,
      frame: LANDMARK_FRAME[mark.kind],
      zIndex: zIndexForEntity(mark.y),
    });
  }
  const warps: WarpMarkerPlacement[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.isWarp(x, y)) warps.push({ x, y, frames: WARP_MARKER_FRAMES });
    }
  }
  return { landmarks, warps };
}

/** The warp-marker pulse frame at `nowMs`: floor(nowMs / WARP_PULSE_MS) mod frameCount,
 *  held at frame 0 WHILE reduced motion is set (and for a non-finite clock). */
export function warpFrameIndex(nowMs: number, reduceMotion: boolean, frameCount: number): number {
  return waterFrameIndex(nowMs, reduceMotion, frameCount, WARP_PULSE_MS);
}
