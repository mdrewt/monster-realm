// render/decorLayout.ts — RED-PHASE STUB (wap-6). The contract only; the tester's
// tests must fail against it. Replaced by the implementation after the red proof.
import type { Landmark } from './map';

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

/** Per-frame period of the warp-marker pulse, in ms. */
export const WARP_PULSE_MS = 250;

export function layoutDecor(_map: DecorSource): DecorPlan {
  return { landmarks: [], warps: [] };
}

export function warpFrameIndex(
  _nowMs: number,
  _reduceMotion: boolean,
  _frameCount: number,
): number {
  return 0;
}
