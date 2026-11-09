// render/terrainLayout.ts — the terrain renderer's pure core (wap-4). RED-PHASE STUB:
// the signatures are the contract the gating tests are written against; every body
// throws until the implementation lands.
import type { ShoreSlot } from './art/packs/terrain';
import type { TerrainKind } from './map';

/** The slice of `TileMap` the planner reads (TileMap satisfies it structurally). */
export interface TerrainSource {
  readonly zoneId: number;
  readonly width: number;
  readonly height: number;
  terrainAt(x: number, y: number): TerrainKind | undefined;
}

/** One tile's draw decision: the kit frame key it shows, plus its animation frame
 *  keys when it is animated water (frame === animation[0]). */
export interface TilePlacement {
  readonly x: number;
  readonly y: number;
  readonly frame: string;
  readonly animation?: readonly string[];
}

export interface TerrainWarning {
  readonly code: 'no-kit' | 'no-terrain' | 'missing-frame';
  readonly detail: string;
}

export type TerrainPlan =
  | { readonly kind: 'kit'; readonly tiles: readonly TilePlacement[] }
  | { readonly kind: 'flat'; readonly warnings: readonly [TerrainWarning] };

/** Per-frame time + motion input that main.ts hands `WorldRenderer.render`. */
export interface TerrainFrameInput {
  readonly nowMs: number;
  readonly reduceMotion: boolean;
}

export interface Chunk {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly tiles: readonly TilePlacement[];
}

export interface ChunkPlan {
  readonly chunks: readonly Chunk[];
  readonly animated: readonly TilePlacement[];
}

export interface ChunkTextureOptions {
  readonly resolution: number;
  readonly scaleMode: 'nearest';
}

export interface AtlasAsset {
  readonly src: string;
  readonly data: { readonly textureOptions: { readonly scaleMode: 'nearest' } };
}

/** 8-neighbour bits of a shore mask (a set bit = that neighbour is land). */
export const SHORE_BIT = {
  n: 1,
  ne: 2,
  e: 4,
  se: 8,
  s: 16,
  sw: 32,
  w: 64,
  nw: 128,
} as const;

const notYet = (): never => {
  throw new Error('terrainLayout: not implemented (wap-4 red phase)');
};

export function variantIndex(_zoneId: number, _x: number, _y: number, _count: number): number {
  return notYet();
}

export function shoreMask(_map: TerrainSource, _x: number, _y: number): number {
  return notYet();
}

export function shoreSlotForMask(_mask: number): ShoreSlot | null {
  return notYet();
}

export function layoutTerrain(
  _map: TerrainSource,
  _kit: ReadonlySet<string> | undefined,
): TerrainPlan {
  return notYet();
}

export function waterFrameIndex(
  _nowMs: number,
  _reduceMotion: boolean,
  _frameCount: number,
  _periodMs?: number,
): number {
  return notYet();
}

export function planChunks(
  _width: number,
  _height: number,
  _tiles: readonly TilePlacement[],
  _chunkTiles?: number,
): ChunkPlan {
  return notYet();
}

export function kitAtlasAsset(_url: string): AtlasAsset {
  return notYet();
}

export class ChunkCache<T> {
  constructor(
    _create: (chunk: Chunk, options: ChunkTextureOptions) => T,
    _destroy: (texture: T) => void,
  ) {}
  build(_chunks: readonly Chunk[], _deviceScale: number): readonly T[] {
    return notYet();
  }
  clear(): void {
    notYet();
  }
  get size(): number {
    return notYet();
  }
}
