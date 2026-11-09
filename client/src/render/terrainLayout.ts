// render/terrainLayout.ts — the terrain renderer's pure core (wap-4).
//
// PURE. Every terrain DECISION the world renderer makes lives here, so it is unit-
// tested without Pixi: which kit frame each tile shows (by its `TileKind` class, a
// stable variant hash, and the shore band where shallow water meets land), the
// flat fallback when the kit or the terrain layer is missing, which water frame
// shows at an injected `nowMs` (frame 0 under reduced motion), how the static
// tiles split into cached chunks (animated water excluded), and the lifetime of
// the chunk textures, created and destroyed through injected functions. `world.ts`
// (the coverage-excluded imperative shell) only turns these decisions into Pixi
// calls. No `Math.random`, no wall-clock read: time arrives as `nowMs`.
import { type ShoreSlot, TERRAIN_KIT_CLASSES, TERRAIN_KIT_SHORE } from './art/packs/terrain';
import { TERRAIN_CHUNK_TILES, WATER_FRAME_MS } from './config';
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

/** `kit`: one placement per in-bounds tile, row-major. `flat`: draw the legacy
 *  wall/grass rects, with exactly one warning saying why. */
export type TerrainPlan =
  | { readonly kind: 'kit'; readonly tiles: readonly TilePlacement[] }
  | { readonly kind: 'flat'; readonly warnings: readonly [TerrainWarning] };

/** Per-frame time + motion input that main.ts hands `WorldRenderer.render`. */
export interface TerrainFrameInput {
  readonly nowMs: number;
  readonly reduceMotion: boolean;
}

/** A tile rectangle [x, x+w) × [y, y+h) and the static placements baked into it. */
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

/** What a chunk texture is created with: the device scale and nearest sampling
 *  (Constraint 7a — a 32 px tile edge stays a hard step at every integer scale). */
export interface ChunkTextureOptions {
  readonly resolution: number;
  readonly scaleMode: 'nearest';
}

/** The `Assets.load` descriptor for a spritesheet atlas: Pixi's spritesheet parser
 *  forwards `data.textureOptions` to the atlas image's texture source. */
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

const NEIGHBOURS: readonly (readonly [dx: number, dy: number, bit: number])[] = [
  [0, -1, SHORE_BIT.n],
  [1, -1, SHORE_BIT.ne],
  [1, 0, SHORE_BIT.e],
  [1, 1, SHORE_BIT.se],
  [0, 1, SHORE_BIT.s],
  [-1, 1, SHORE_BIT.sw],
  [-1, 0, SHORE_BIT.w],
  [-1, -1, SHORE_BIT.nw],
];

/** Integer avalanche mix (murmur3 fmix32) of a 32-bit value. */
function fmix32(v: number): number {
  let h = v | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The variant a tile shows: a pure integer hash of (zone, x, y) reduced to
 *  [0, count). The same tile picks the same variant on every redraw and session. */
export function variantIndex(zoneId: number, x: number, y: number, count: number): number {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`terrainLayout: variant count must be a positive integer, got ${count}`);
  }
  const h = fmix32(fmix32(fmix32(zoneId) ^ x) ^ Math.imul(y, 0x9e3779b1));
  return h % count;
}

function isWater(kind: TerrainKind | undefined): boolean {
  return kind === 'ShallowWater' || kind === 'DeepWater';
}

/** Which of (x, y)'s 8 neighbours are land: in bounds and neither water class.
 *  Out of bounds is not land, so open water at the map edge draws no shore. */
export function shoreMask(map: TerrainSource, x: number, y: number): number {
  let mask = 0;
  for (const [dx, dy, bit] of NEIGHBOURS) {
    const kind = map.terrainAt(x + dx, y + dy);
    if (kind !== undefined && !isWater(kind)) mask |= bit;
  }
  return mask;
}

/** The shore slot an 8-neighbour land mask selects, total over all 256 masks:
 *  `null` only for mask 0 (open water). Two adjacent land edges pick the outer
 *  corner (precedence ne, nw, se, sw); otherwise one land edge picks that edge
 *  (precedence n, e, s, w — a one-tile channel shows its first bank); with no
 *  land edge, diagonal-only land picks the inner corner (precedence ne, nw, se, sw). */
export function shoreSlotForMask(mask: number): ShoreSlot | null {
  const has = (bit: number): boolean => (mask & bit) !== 0;
  const n = has(SHORE_BIT.n);
  const e = has(SHORE_BIT.e);
  const s = has(SHORE_BIT.s);
  const w = has(SHORE_BIT.w);
  if (n && e) return 'ne';
  if (n && w) return 'nw';
  if (s && e) return 'se';
  if (s && w) return 'sw';
  if (n) return 'n';
  if (e) return 'e';
  if (s) return 's';
  if (w) return 'w';
  if (has(SHORE_BIT.ne)) return 'inner_ne';
  if (has(SHORE_BIT.nw)) return 'inner_nw';
  if (has(SHORE_BIT.se)) return 'inner_se';
  if (has(SHORE_BIT.sw)) return 'inner_sw';
  return null;
}

function placementFor(map: TerrainSource, x: number, y: number, kind: TerrainKind): TilePlacement {
  const frames = TERRAIN_KIT_CLASSES[kind];
  if (kind === 'ShallowWater') {
    const slot = shoreSlotForMask(shoreMask(map, x, y));
    if (slot !== null) return { x, y, frame: TERRAIN_KIT_SHORE[slot] };
  }
  const animation = frames.animation;
  if (animation !== undefined && animation.length > 0) {
    return { x, y, frame: animation[0] as string, animation };
  }
  const variant = frames.variants[variantIndex(map.zoneId, x, y, frames.variants.length)];
  return { x, y, frame: variant as string };
}

const flat = (code: TerrainWarning['code'], detail: string): TerrainPlan => ({
  kind: 'flat',
  warnings: [{ code, detail }],
});

/** Lay out the map's terrain from the kit. `kit` is the set of frame keys the
 *  loaded atlas holds, or `undefined` when it failed to load. Without a kit, a
 *  terrain layer, or every frame the map needs, the plan is the flat fallback
 *  with exactly one warning record. */
export function layoutTerrain(
  map: TerrainSource,
  kit: ReadonlySet<string> | undefined,
): TerrainPlan {
  if (kit === undefined) return flat('no-kit', 'terrain kit atlas is not loaded');
  const tiles: TilePlacement[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const kind = map.terrainAt(x, y);
      if (kind === undefined) {
        return flat('no-terrain', `zone ${map.zoneId} payload has no terrain layer`);
      }
      const placement = placementFor(map, x, y, kind);
      for (const key of placement.animation ?? [placement.frame]) {
        if (!kit.has(key)) {
          return flat('missing-frame', `terrain kit has no frame "${key}" (${kind} at ${x},${y})`);
        }
      }
      tiles.push(placement);
    }
  }
  return { kind: 'kit', tiles };
}

/** The water animation frame at `nowMs`: floor(nowMs / periodMs) mod frameCount,
 *  held at frame 0 WHILE reduced motion is set (and for a non-finite clock). */
export function waterFrameIndex(
  nowMs: number,
  reduceMotion: boolean,
  frameCount: number,
  periodMs: number = WATER_FRAME_MS,
): number {
  if (reduceMotion || !Number.isFinite(nowMs) || !(periodMs > 0) || !(frameCount >= 1)) return 0;
  const count = Math.floor(frameCount);
  const k = Math.floor(nowMs / periodMs) % count;
  return k < 0 ? k + count : k;
}

/** Partition a width×height map into chunkTiles-square chunks (edge chunks
 *  clipped), row-major. Each static placement goes into the chunk that contains
 *  it; animated placements are returned separately and baked into no chunk. */
export function planChunks(
  width: number,
  height: number,
  tiles: readonly TilePlacement[],
  chunkTiles: number = TERRAIN_CHUNK_TILES,
): ChunkPlan {
  if (!Number.isInteger(chunkTiles) || chunkTiles < 1) {
    throw new Error(`terrainLayout: chunk size must be a positive integer, got ${chunkTiles}`);
  }
  const cols = Math.ceil(width / chunkTiles);
  const rows = Math.ceil(height / chunkTiles);
  const buckets: TilePlacement[][] = Array.from({ length: cols * rows }, () => []);
  const animated: TilePlacement[] = [];
  for (const t of tiles) {
    if (
      !Number.isInteger(t.x) ||
      !Number.isInteger(t.y) ||
      t.x < 0 ||
      t.y < 0 ||
      t.x >= width ||
      t.y >= height
    ) {
      throw new Error(`terrainLayout: placement (${t.x},${t.y}) is outside ${width}x${height}`);
    }
    if (t.animation !== undefined) animated.push(t);
    else buckets[Math.floor(t.y / chunkTiles) * cols + Math.floor(t.x / chunkTiles)]?.push(t);
  }
  const chunks: Chunk[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = cx * chunkTiles;
      const y = cy * chunkTiles;
      chunks.push({
        x,
        y,
        w: Math.min(chunkTiles, width - x),
        h: Math.min(chunkTiles, height - y),
        tiles: buckets[cy * cols + cx] ?? [],
      });
    }
  }
  return { chunks, animated };
}

/** The `Assets.load` descriptor for a terrain atlas, sampled `nearest`. */
export function kitAtlasAsset(url: string): AtlasAsset {
  return { src: url, data: { textureOptions: { scaleMode: 'nearest' } } };
}

/** Owns every chunk texture it creates. `build` (the setMap / rescale path)
 *  destroys the previous set before creating the next; `clear` (the destroy
 *  path) destroys whatever is live. Each created texture is destroyed exactly once. */
export class ChunkCache<T> {
  readonly #create: (chunk: Chunk, options: ChunkTextureOptions) => T;
  readonly #destroy: (texture: T) => void;
  #live: T[] = [];

  constructor(
    create: (chunk: Chunk, options: ChunkTextureOptions) => T,
    destroy: (texture: T) => void,
  ) {
    this.#create = create;
    this.#destroy = destroy;
  }

  build(chunks: readonly Chunk[], deviceScale: number): readonly T[] {
    this.clear();
    const options: ChunkTextureOptions = { resolution: deviceScale, scaleMode: 'nearest' };
    for (const chunk of chunks) this.#live.push(this.#create(chunk, options));
    return [...this.#live];
  }

  clear(): void {
    const live = this.#live;
    this.#live = [];
    for (const texture of live) this.#destroy(texture);
  }

  get size(): number {
    return this.#live.length;
  }
}
