import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type DecodedPng, decodePng } from '../../test-util/pngDecode';
import {
  DECOR_FRAME,
  LANDMARK_FRAME,
  LANDMARKS_FILE,
  LANDMARKS_PACK,
  WARP_MARKER_FRAMES,
} from './art/packs/landmarks';
import { TERRAIN_KIT_FILE } from './art/packs/terrain';
import { validateArtRegistry } from './art/registry';
import { WATER_FRAME_MS } from './config';
import { type DecorSource, layoutDecor, WARP_PULSE_MS, warpFrameIndex } from './decorLayout';
import { type Landmark, type RawTileMap, TileMap } from './map';
import { zIndexForEntity } from './zorder';

// './zorder' is mocked for the whole file but delegates to a switchable impl that
// defaults to the real rule (identity); only the "goes through the shared function"
// tooth switches it to a non-identity.
const zState = vi.hoisted(() => ({ impl: (y: number): number => y }));
vi.mock('./zorder', () => ({
  zIndexForEntity: (y: number): number => zState.impl(y),
}));

const CLIENT_ROOT = join(import.meta.dirname, '..', '..');
const ASSETS = join(CLIENT_ROOT, 'public', 'assets');

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface SheetJson {
  frames: Record<string, { frame: Rect }>;
  animations?: Record<string, string[]>;
  meta: { scale: number; size: { w: number; h: number }; image: string };
}
interface Atlas {
  json: SheetJson;
  png: DecodedPng;
}

const cache = new Map<string, Atlas>();
/** Lazy: loaded inside tests so a missing file fails the test, not collection. */
function atlas(png: string): Atlas {
  let hit = cache.get(png);
  if (!hit) {
    const json = JSON.parse(readFileSync(join(ASSETS, png.replace('.png', '.json')), 'utf8'));
    hit = { json, png: decodePng(new Uint8Array(readFileSync(join(ASSETS, png)))) };
    cache.set(png, hit);
  }
  return hit;
}

/** RGBA bytes of a w x h sub-rect (relative to the frame) of one frame. */
function crop(a: Atlas, key: string, dy: number, h: number): Uint8Array {
  const entry = a.json.frames[key];
  if (!entry) throw new Error(`frame key missing from json: ${key}`);
  const { x, y, w } = entry.frame;
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + dy + row) * a.png.width + x) * 4;
    out.set(a.png.rgba.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

/** The alpha>0 mask of RGBA bytes as a 0/1 string. */
function mask(px: Uint8Array): string {
  let s = '';
  for (let i = 3; i < px.length; i += 4) s += px[i] > 0 ? '1' : '0';
  return s;
}

const heal = (x: number, y: number): Landmark => ({ kind: 'heal', x, y });

/** A structural DecorSource whose isWarp THROWS on any out-of-bounds probe. */
function source(
  width: number,
  height: number,
  landmarks: readonly Landmark[],
  warps: ReadonlyArray<readonly [number, number]>,
): DecorSource {
  const set = new Set(warps.map(([x, y]) => `${x},${y}`));
  return {
    width,
    height,
    landmarks,
    isWarp(x: number, y: number): boolean {
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height
      ) {
        throw new Error(`isWarp probed out of bounds: (${x},${y}) on ${width}x${height}`);
      }
      return set.has(`${x},${y}`);
    },
  };
}

function raw(
  width: number,
  height: number,
  extra: Pick<RawTileMap, 'warps' | 'landmarks'>,
): RawTileMap {
  return {
    zone_id: 1,
    width,
    height,
    walkable: new Array<boolean>(width * height).fill(true),
    grass: new Array<boolean>(width * height).fill(false),
    ...extra,
  };
}

describe('WAP6.1 landmark placement', () => {
  it('WAP6.1 places a heal landmark at each landmark tile of a non-square map and nowhere else', () => {
    const map = source(
      7,
      4,
      [heal(1, 2), heal(5, 0), heal(3, 3)],
      [
        [0, 0],
        [6, 3],
        [3, 1],
      ],
    );
    expect(layoutDecor(map).landmarks).toEqual([
      { x: 1, y: 2, frame: LANDMARK_FRAME.heal, zIndex: 2 },
      { x: 5, y: 0, frame: LANDMARK_FRAME.heal, zIndex: 0 },
      { x: 3, y: 3, frame: LANDMARK_FRAME.heal, zIndex: 3 },
    ]);
  });

  it('WAP6.1 a real TileMap payload with landmarks yields the same placements', () => {
    const map = TileMap.fromRaw(
      raw(5, 3, {
        landmarks: [
          { kind: 'heal', x: 4, y: 1 },
          { kind: 'heal', x: 0, y: 2 },
        ],
      }),
    );
    expect(layoutDecor(map).landmarks).toEqual([
      { x: 4, y: 1, frame: LANDMARK_FRAME.heal, zIndex: 1 },
      { x: 0, y: 2, frame: LANDMARK_FRAME.heal, zIndex: 2 },
    ]);
  });

  it('WAP6.1 a map without landmarks (field absent or empty list) has no landmark placements', () => {
    expect(layoutDecor(TileMap.fromRaw(raw(5, 3, {}))).landmarks).toEqual([]);
    expect(layoutDecor(TileMap.fromRaw(raw(5, 3, { landmarks: [] }))).landmarks).toEqual([]);
    expect(layoutDecor(source(7, 4, [], [[2, 2]])).landmarks).toEqual([]);
  });

  it('WAP6.1 an out-of-bounds landmark in a literal source is skipped, in-bounds ones kept', () => {
    const map = source(7, 4, [heal(9, 1), heal(2, 1), heal(-1, 0), heal(2, 4), heal(6, 3)], []);
    expect(layoutDecor(map).landmarks.map((p) => [p.x, p.y])).toEqual([
      [2, 1],
      [6, 3],
    ]);
  });

  it('WAP6.1 two landmarks on one tile give two placements', () => {
    const map = source(7, 4, [heal(3, 2), heal(3, 2)], []);
    expect(layoutDecor(map).landmarks).toHaveLength(2);
  });

  it('WAP6.1 landmarks never leak into warps and warps never into landmarks', () => {
    const map = source(7, 4, [heal(1, 1)], [[5, 2]]);
    const plan = layoutDecor(map);
    expect(plan.landmarks.map((p) => [p.x, p.y])).toEqual([[1, 1]]);
    expect(plan.warps.map((p) => [p.x, p.y])).toEqual([[5, 2]]);
  });

  it('WAP6.1 a landmark exactly at x === width or y === height is skipped, (width-1, height-1) kept', () => {
    const map = source(7, 4, [heal(7, 0), heal(0, 4), heal(7, 4), heal(6, 3)], []);
    expect(layoutDecor(map).landmarks.map((p) => [p.x, p.y])).toEqual([[6, 3]]);
  });

  it('WAP6.1 fractional landmark coordinates are never placed, only integer tiles', () => {
    const map = source(7, 4, [heal(1.5, 2), heal(1, 2.5), heal(1, 2)], []);
    expect(layoutDecor(map).landmarks.map((p) => [p.x, p.y])).toEqual([[1, 2]]);
  });
});

describe('WAP6.2 warp markers', () => {
  it('WAP6.2 places one marker per warp source tile, row-major, with the pulse frames', () => {
    const map = source(
      7,
      4,
      [],
      [
        [6, 3],
        [3, 1],
        [0, 0],
        [5, 1],
      ],
    );
    expect(layoutDecor(map).warps).toEqual([
      { x: 0, y: 0, frames: WARP_MARKER_FRAMES },
      { x: 3, y: 1, frames: WARP_MARKER_FRAMES },
      { x: 5, y: 1, frames: WARP_MARKER_FRAMES },
      { x: 6, y: 3, frames: WARP_MARKER_FRAMES },
    ]);
  });

  it('WAP6.2 a real TileMap payload with a warps list yields markers on exactly its sources', () => {
    const map = TileMap.fromRaw(
      raw(5, 3, {
        warps: [
          { from: { x: 4, y: 2 }, to_zone: 2, to_tile: { x: 0, y: 0 } },
          { from: { x: 1, y: 0 }, to_zone: 3, to_tile: { x: 2, y: 2 } },
        ],
      }),
    );
    expect(layoutDecor(map).warps).toEqual([
      { x: 1, y: 0, frames: WARP_MARKER_FRAMES },
      { x: 4, y: 2, frames: WARP_MARKER_FRAMES },
    ]);
  });

  it('WAP6.2 no warps gives no markers, and landmarks never become markers', () => {
    expect(layoutDecor(source(7, 4, [heal(2, 2)], [])).warps).toEqual([]);
    expect(layoutDecor(TileMap.fromRaw(raw(5, 3, {}))).warps).toEqual([]);
  });

  it('WAP6.2 landmarks.json has 32x64 frames, a 160x64 sheet, the warp animation and every emitted key', () => {
    const { json, png } = atlas(LANDMARKS_FILE);
    expect(DECOR_FRAME).toEqual({ w: 32, h: 64 });
    expect(json.meta.size).toEqual({ w: 160, h: 64 });
    expect([png.width, png.height]).toEqual([160, 64]);
    expect(json.animations?.warp).toEqual([...WARP_MARKER_FRAMES]);
    for (const key of [...Object.values(LANDMARK_FRAME), ...WARP_MARKER_FRAMES]) {
      const entry = json.frames[key];
      expect(entry, `frame ${key} in json`).toBeDefined();
      expect([entry.frame.w, entry.frame.h], `${key} size`).toEqual([32, 64]);
    }
  });

  it('WAP6.2 LANDMARKS_PACK validates and sizes to the decoded sheet', () => {
    expect(validateArtRegistry(LANDMARKS_PACK)).toEqual([]);
    const { png } = atlas(LANDMARKS_FILE);
    expect(LANDMARKS_PACK[0].sheet).toEqual({ w: png.width, h: png.height });
  });

  it('WAP6.2 every warp frame is a ground ring: empty top half, open centre, shaped unlike any terrain or the landmark', () => {
    const lm = atlas(LANDMARKS_FILE);
    const terrain = atlas(TERRAIN_KIT_FILE);
    const terrainMasks = Object.keys(terrain.json.frames).map((k) => mask(crop(terrain, k, 0, 32)));
    expect(terrainMasks.length).toBeGreaterThan(0);
    const healMask = mask(crop(lm, LANDMARK_FRAME.heal, 32, 32));
    for (const key of WARP_MARKER_FRAMES) {
      const top = crop(lm, key, 0, 32);
      for (let i = 3; i < top.length; i += 4) {
        if (top[i] !== 0) expect(top[i], `${key} top-half pixel ${(i - 3) / 4} alpha`).toBe(0);
      }
      const bottom = crop(lm, key, 32, 32);
      const m = mask(bottom);
      expect(m.includes('0'), `${key} has transparent pixels`).toBe(true);
      expect(m.includes('1'), `${key} has opaque pixels`).toBe(true);
      let centreClear = false;
      for (let y = 12; y < 20; y++) {
        for (let x = 12; x < 20; x++) if (m[y * 32 + x] === '0') centreClear = true;
      }
      expect(centreClear, `${key} centre is open`).toBe(true);
      for (const tm of terrainMasks)
        expect(m === tm, `${key} mask equals a terrain frame`).toBe(false);
      expect(m === healMask, `${key} mask equals the heal landmark`).toBe(false);
    }
  });

  it('WAP6.2 the pulse period differs from the water period', () => {
    expect(WARP_PULSE_MS).not.toBe(WATER_FRAME_MS);
    expect(WARP_PULSE_MS).toBeGreaterThan(0);
  });

  it('WAP6.2 warpFrameIndex steps once per period and wraps, as a pure function of nowMs', () => {
    const count = WARP_MARKER_FRAMES.length;
    for (let k = 0; k <= 2 * count; k++) {
      const start = k * WARP_PULSE_MS;
      const end = k * WARP_PULSE_MS + WARP_PULSE_MS - 1;
      expect(warpFrameIndex(start, false, count), `t=${start}`).toBe(k % count);
      expect(warpFrameIndex(end, false, count), `t=${end}`).toBe(k % count);
      expect(warpFrameIndex(start, false, count)).toBe(warpFrameIndex(start, false, count));
    }
  });

  it('WAP6.2 warpFrameIndex is held at frame 0 for every clock value WHILE reduced motion', () => {
    const count = WARP_MARKER_FRAMES.length;
    for (let k = 0; k <= 2 * count; k++) {
      expect(warpFrameIndex(k * WARP_PULSE_MS, true, count), `t=${k}P`).toBe(0);
      expect(warpFrameIndex(k * WARP_PULSE_MS + WARP_PULSE_MS - 1, true, count), `t=${k}P+`).toBe(
        0,
      );
    }
    expect(warpFrameIndex(WARP_PULSE_MS * 1.5, true, count)).toBe(0);
  });

  it('WAP6.2 warpFrameIndex returns 0 for a non-finite clock and for a zero frame count', () => {
    const count = WARP_MARKER_FRAMES.length;
    expect(warpFrameIndex(Number.NaN, false, count)).toBe(0);
    expect(warpFrameIndex(Number.POSITIVE_INFINITY, false, count)).toBe(0);
    expect(warpFrameIndex(Number.NEGATIVE_INFINITY, false, count)).toBe(0);
    expect(warpFrameIndex(WARP_PULSE_MS * 3, false, 0)).toBe(0);
  });

  it('WAP6.2 reduced motion holds frame 0 at very large clocks too', () => {
    for (const t of [1e12, 1.7e12, 2 ** 53]) {
      expect(warpFrameIndex(t, true, 4), `t=${t}`).toBe(0);
    }
  });

  it('WAP6.2 a non-reduced large clock still pulses', () => {
    const t = 1.7e12;
    expect(warpFrameIndex(t, false, 4)).not.toBe(warpFrameIndex(t + WARP_PULSE_MS, false, 4));
  });

  it('WAP6.2 the shipped pulse period is 250 ms, pinned by literal samples', () => {
    expect(WARP_PULSE_MS).toBe(250);
    expect(warpFrameIndex(0, false, 4)).toBe(0);
    expect(warpFrameIndex(249, false, 4)).toBe(0);
    expect(warpFrameIndex(250, false, 4)).toBe(1);
    expect(warpFrameIndex(999, false, 4)).toBe(3);
    expect(warpFrameIndex(1000, false, 4)).toBe(0);
  });

  it('WAP6.2 a warp source tile that also holds a landmark keeps both', () => {
    const plan = layoutDecor(source(7, 4, [heal(3, 1)], [[3, 1]]));
    expect(plan.landmarks.map((p) => [p.x, p.y])).toEqual([[3, 1]]);
    expect(plan.warps.map((p) => [p.x, p.y])).toEqual([[3, 1]]);
  });

  it('WAP6.2 a negative clock wraps into range rather than going negative', () => {
    expect(warpFrameIndex(-WARP_PULSE_MS, false, 4)).toBe(3);
    expect(warpFrameIndex(-1, false, 4)).toBe(3);
  });
});

describe('WAP6.3 landmark row z-order', () => {
  const MAP = source(7, 6, [heal(1, 2), heal(5, 0), heal(3, 5), heal(6, 3)], []);

  it('WAP6.3 each landmark zIndex equals zIndexForEntity of its row', () => {
    for (const p of layoutDecor(MAP).landmarks) {
      expect(p.zIndex, `landmark at y=${p.y}`).toBe(zIndexForEntity(p.y));
    }
  });

  it('WAP6.3 a landmark draws in front of a character on the row above and behind one on the row below', () => {
    const placements = layoutDecor(MAP).landmarks;
    expect(placements).toHaveLength(4);
    for (const p of placements) {
      expect(zIndexForEntity(p.y - 1), `above y=${p.y}`).toBeLessThan(p.zIndex);
      expect(p.zIndex, `below y=${p.y}`).toBeLessThan(zIndexForEntity(p.y + 1));
    }
  });

  it('WAP6.3 the order holds for a character mid-slide on a fractional row', () => {
    for (const p of layoutDecor(MAP).landmarks) {
      expect(zIndexForEntity(p.y - 0.5)).toBeLessThan(p.zIndex);
      expect(zIndexForEntity(p.y - 1e-3)).toBeLessThan(p.zIndex);
      expect(p.zIndex).toBeLessThan(zIndexForEntity(p.y + 1e-3));
      expect(p.zIndex).toBeLessThan(zIndexForEntity(p.y + 0.5));
    }
  });

  it('WAP6.3 the zIndex comes through the shared zorder function, not a copy of its rule', () => {
    zState.impl = (y) => y * 10 + 1;
    try {
      expect(layoutDecor(MAP).landmarks.map((p) => p.zIndex)).toEqual([21, 1, 51, 31]);
    } finally {
      zState.impl = (y) => y;
    }
  });
});
