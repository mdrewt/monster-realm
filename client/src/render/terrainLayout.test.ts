/**
 * render/terrainLayout.test.ts — gating tests for the terrain renderer's pure core (wap-4,
 * WAP4.1–WAP4.6; WAP4.4's main.ts wiring half lives in main.reducedMotionWiring.test.ts).
 * Real `TileMap`s, the TS kit manifest for the frame key set, injected fake texture factory:
 * no Pixi, no wasm, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  type ShoreSlot,
  TERRAIN_KIT_CLASSES,
  TERRAIN_KIT_SHORE,
  type TerrainKitClass,
} from './art/packs/terrain';
import { TERRAIN_CHUNK_TILES, WATER_FRAME_MS } from './config';
import { TERRAIN_KINDS, type TerrainKind, TileMap } from './map';
import {
  type Chunk,
  ChunkCache,
  type ChunkTextureOptions,
  chunkTextureRequest,
  kitAtlasAsset,
  layoutTerrain,
  planChunks,
  SHORE_BIT,
  shoreMask,
  shoreSlotForMask,
  type TilePlacement,
  variantIndex,
  waterFrameIndex,
} from './terrainLayout';

// --- fixtures ---------------------------------------------------------------------------
const FULL_KIT: ReadonlySet<string> = new Set([
  ...Object.values(TERRAIN_KIT_CLASSES).flatMap((c) => [...c.variants, ...(c.animation ?? [])]),
  ...Object.values(TERRAIN_KIT_SHORE),
]);
const SHORE_FRAMES: ReadonlySet<string> = new Set(Object.values(TERRAIN_KIT_SHORE));
const WATER: ReadonlySet<TerrainKind> = new Set<TerrainKind>(['ShallowWater', 'DeepWater']);

function mapOf(
  zoneId: number,
  width: number,
  height: number,
  kindAt: (x: number, y: number) => TerrainKind,
  withTerrain = true,
): TileMap {
  const n = width * height;
  const terrain: string[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) terrain.push(kindAt(x, y));
  return TileMap.fromRaw({
    zone_id: zoneId,
    width,
    height,
    walkable: Array.from({ length: n }, () => true),
    grass: Array.from({ length: n }, () => false),
    ...(withTerrain ? { terrain } : {}),
  });
}

const uniform = (zone: number, w: number, h: number, k: TerrainKind): TileMap =>
  mapOf(zone, w, h, () => k);

/** A pond: ShallowWater everywhere, Floor at the centre of a 5x5. */
const pond = (): TileMap =>
  mapOf(1, 5, 5, (x, y) => (x === 2 && y === 2 ? 'Floor' : 'ShallowWater'));

function kitTiles(map: TileMap, kit: ReadonlySet<string> = FULL_KIT): readonly TilePlacement[] {
  const plan = layoutTerrain(map, kit);
  if (plan.kind !== 'kit') throw new Error(`expected a kit plan, got ${plan.kind}`);
  return plan.tiles;
}
const at = (tiles: readonly TilePlacement[], x: number, y: number): TilePlacement => {
  const t = tiles.find((p) => p.x === x && p.y === y);
  if (t === undefined) throw new Error(`no placement at ${x},${y}`);
  return t;
};
const without = (drop: readonly string[]): ReadonlySet<string> =>
  new Set([...FULL_KIT].filter((k) => !drop.includes(k)));

function hasLandNeighbour(map: TileMap, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const k = map.terrainAt(x + dx, y + dy);
      if ((dx !== 0 || dy !== 0) && k !== undefined && !WATER.has(k)) return true;
    }
  }
  return false;
}

// --- WAP4.1 -----------------------------------------------------------------------------
describe('terrain kit plan (WAP4.1)', () => {
  const all = mapOf(3, 10, 3, (x, y) => TERRAIN_KINDS[(x + y * 4) % 10] as TerrainKind);

  it('WAP4.1 kit plan has exactly one placement per in-bounds tile', () => {
    const tiles = kitTiles(all);
    expect(tiles).toHaveLength(30);
    const seen = new Set<string>();
    for (const t of tiles) {
      expect(t.x >= 0 && t.x < 10 && t.y >= 0 && t.y < 3).toBe(true);
      seen.add(`${t.x},${t.y}`);
    }
    expect(seen.size).toBe(30);
  });

  it('WAP4.1 every placement frame belongs to its tile class (static, animated, shore)', () => {
    const classesSeen = new Set<string>();
    for (const t of kitTiles(all)) {
      const kind = all.terrainAt(t.x, t.y) as TerrainKind;
      classesSeen.add(kind);
      const cls = TERRAIN_KIT_CLASSES[kind as TerrainKitClass];
      if (kind === 'DeepWater' || (kind === 'ShallowWater' && !hasLandNeighbour(all, t.x, t.y))) {
        expect(t.frame).toBe(cls.animation?.[0]);
        expect(t.animation).toEqual(cls.animation);
      } else if (kind === 'ShallowWater') {
        expect(SHORE_FRAMES.has(t.frame)).toBe(true);
        expect(t.animation).toBeUndefined();
      } else {
        expect(cls.variants).toContain(t.frame);
        expect(t.animation).toBeUndefined();
      }
    }
    expect(classesSeen.size).toBe(10);
  });

  it('WAP4.1 no kit falls back to flat with exactly one no-kit warning', () => {
    const plan = layoutTerrain(uniform(1, 4, 4, 'Floor'), undefined);
    expect(plan.kind).toBe('flat');
    if (plan.kind !== 'flat') return;
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].code).toBe('no-kit');
  });

  it('WAP4.1 a payload without a terrain layer falls back to flat with one no-terrain warning', () => {
    const plan = layoutTerrain(
      mapOf(1, 4, 4, () => 'Floor', false),
      FULL_KIT,
    );
    expect(plan.kind).toBe('flat');
    if (plan.kind !== 'flat') return;
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].code).toBe('no-terrain');
  });

  it('WAP4.1 a kit missing a needed static frame falls back to flat with one missing-frame warning', () => {
    const plan = layoutTerrain(
      uniform(1, 4, 4, 'Floor'),
      without(TERRAIN_KIT_CLASSES.Floor.variants),
    );
    expect(plan.kind).toBe('flat');
    if (plan.kind !== 'flat') return;
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].code).toBe('missing-frame');
  });

  it('WAP4.1 a kit missing a needed water animation frame falls back to flat (missing-frame)', () => {
    const kit = without([TERRAIN_KIT_CLASSES.DeepWater.animation?.[2] ?? 'x']);
    const plan = layoutTerrain(uniform(1, 3, 3, 'DeepWater'), kit);
    expect(plan.kind).toBe('flat');
    if (plan.kind !== 'flat') return;
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].code).toBe('missing-frame');
  });

  it('WAP4.1 a kit missing a needed shore frame falls back to flat (missing-frame)', () => {
    const plan = layoutTerrain(pond(), without([TERRAIN_KIT_SHORE.s]));
    expect(plan.kind).toBe('flat');
    if (plan.kind !== 'flat') return;
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].code).toBe('missing-frame');
  });
});

// --- WAP4.2 -----------------------------------------------------------------------------
describe('deterministic variant pick (WAP4.2)', () => {
  it('WAP4.2 variantIndex is an integer in [0,count) and repeatable', () => {
    for (const count of [1, 2, 3, 5]) {
      for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 12; x++) {
          const v = variantIndex(7, x, y, count);
          expect(Number.isInteger(v) && v >= 0 && v < count).toBe(true);
          expect(variantIndex(7, x, y, count)).toBe(v);
        }
      }
    }
  });

  it('WAP4.2 two independently built plans of the same map are identical', () => {
    const build = () => mapOf(5, 10, 10, (x, y) => TERRAIN_KINDS[(x * 7 + y) % 10] as TerrainKind);
    expect(kitTiles(build())).toEqual(kitTiles(build()));
  });

  it('WAP4.2 a 10x10 Floor field uses at least two distinct variant frames', () => {
    const frames = new Set(kitTiles(uniform(1, 10, 10, 'Floor')).map((t) => t.frame));
    expect(frames.size).toBeGreaterThanOrEqual(2);
    for (const f of frames) expect(TERRAIN_KIT_CLASSES.Floor.variants).toContain(f);
  });

  it('WAP4.2 a 10x10 Rock field uses at least two distinct variant frames', () => {
    const frames = new Set(kitTiles(uniform(1, 10, 10, 'Rock')).map((t) => t.frame));
    expect(frames.size).toBeGreaterThanOrEqual(2);
  });

  it('WAP4.2 varying only y (zone and x fixed) changes the variant', () => {
    for (const zone of [0, 1, 9]) {
      const seen = new Set<number>();
      for (let y = 0; y < 64; y++) seen.add(variantIndex(zone, 5, y, 3));
      expect(seen.size, `zone ${zone}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('WAP4.2 varying only x (zone and y fixed) changes the variant', () => {
    for (const zone of [0, 1, 9]) {
      const seen = new Set<number>();
      for (let x = 0; x < 64; x++) seen.add(variantIndex(zone, x, 5, 3));
      expect(seen.size, `zone ${zone}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('WAP4.2 every variant covers at least 20% of a 32x32 field (zones 0 and 1)', () => {
    for (const zone of [0, 1]) {
      const counts = [0, 0, 0];
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) counts[variantIndex(zone, x, y, 3)]++;
      }
      for (const [v, n] of counts.entries())
        expect(n, `zone ${zone} variant ${v}`).toBeGreaterThanOrEqual(205);
    }
  });

  it('WAP4.2 different zone ids lay the same field out differently', () => {
    const layout = (zone: number) => kitTiles(uniform(zone, 10, 10, 'Floor')).map((t) => t.frame);
    expect(layout(1)).not.toEqual(layout(2));
    expect(layout(2)).not.toEqual(layout(7));
  });
});

// --- WAP4.3 -----------------------------------------------------------------------------
const B = SHORE_BIT;
describe('shore mask and slot (WAP4.3)', () => {
  it('WAP4.3 shoreMask sets exactly the bits of in-bounds land neighbours', () => {
    const p = pond();
    expect(shoreMask(p, 2, 1)).toBe(B.s);
    expect(shoreMask(p, 1, 2)).toBe(B.e);
    expect(shoreMask(p, 3, 3)).toBe(B.nw);
    expect(shoreMask(p, 0, 0)).toBe(0);
  });

  it('WAP4.3 out-of-bounds neighbours are not land', () => {
    const floor = uniform(1, 3, 3, 'Floor');
    expect(shoreMask(floor, 0, 0)).toBe(B.e | B.se | B.s);
    expect(shoreMask(floor, 1, 1)).toBe(255);
  });

  it('WAP4.3 deep and shallow water neighbours are not land; every other class is', () => {
    const m = mapOf(1, 3, 3, (x, y) => (x === 1 && y === 1 ? 'Floor' : 'DeepWater'));
    expect(shoreMask(m, 1, 1)).toBe(0);
    for (const k of TERRAIN_KINDS.filter((n) => !WATER.has(n))) {
      const around = mapOf(1, 3, 3, (x, y) => (x === 1 && y === 1 ? 'ShallowWater' : k));
      expect(shoreMask(around, 1, 1), k).toBe(255);
    }
  });

  it('WAP4.3 shoreSlotForMask is null only for mask 0 and otherwise a kit-backed slot', () => {
    expect(shoreSlotForMask(0)).toBeNull();
    for (let mask = 1; mask < 256; mask++) {
      const slot = shoreSlotForMask(mask);
      expect(slot, `mask ${mask}`).not.toBeNull();
      expect(Object.keys(TERRAIN_KIT_SHORE), `mask ${mask}`).toContain(slot);
      expect(FULL_KIT.has(TERRAIN_KIT_SHORE[slot as ShoreSlot])).toBe(true);
    }
  });

  it('WAP4.3 the chosen slot is consistent with the mask bits for all 255 nonzero masks', () => {
    const outer: Record<string, number> = {
      ne: B.n | B.e,
      nw: B.n | B.w,
      se: B.s | B.e,
      sw: B.s | B.w,
    };
    const edge: Record<string, number> = { n: B.n, e: B.e, s: B.s, w: B.w };
    const cardinals = B.n | B.e | B.s | B.w;
    for (let mask = 1; mask < 256; mask++) {
      const slot = shoreSlotForMask(mask) as ShoreSlot;
      if (slot in outer)
        expect(mask & (outer[slot] as number), `${mask} ${slot}`).toBe(outer[slot]);
      else if (slot in edge) expect(mask & (edge[slot] as number), `${mask} ${slot}`).not.toBe(0);
      else {
        const diag = B[slot.slice('inner_'.length) as 'ne' | 'nw' | 'se' | 'sw'];
        expect(mask & diag, `${mask} ${slot}`).not.toBe(0);
        expect(mask & cardinals, `${mask} ${slot}`).toBe(0);
      }
    }
  });

  it('WAP4.3 canonical masks map to their named slots', () => {
    expect(shoreSlotForMask(B.n)).toBe('n');
    expect(shoreSlotForMask(B.e)).toBe('e');
    expect(shoreSlotForMask(B.s)).toBe('s');
    expect(shoreSlotForMask(B.w)).toBe('w');
    expect(shoreSlotForMask(B.n | B.e | B.ne)).toBe('ne');
    expect(shoreSlotForMask(B.s | B.w | B.sw)).toBe('sw');
    expect(shoreSlotForMask(B.ne)).toBe('inner_ne');
    expect(shoreSlotForMask(B.sw)).toBe('inner_sw');
  });

  it('WAP4.3 a pond tile ring gets the shore frame its mask selects; distance-2 tiles animate', () => {
    const tiles = kitTiles(pond());
    const want: Array<[number, number, ShoreSlot]> = [
      [2, 1, 's'],
      [2, 3, 'n'],
      [1, 2, 'e'],
      [3, 2, 'w'],
      [3, 1, 'inner_sw'],
      [1, 1, 'inner_se'],
      [1, 3, 'inner_ne'],
      [3, 3, 'inner_nw'],
    ];
    for (const [x, y, slot] of want) {
      expect(at(tiles, x, y).frame, `${x},${y}`).toBe(TERRAIN_KIT_SHORE[slot]);
      expect(at(tiles, x, y).animation).toBeUndefined();
    }
    for (const [x, y] of [
      [0, 0],
      [4, 0],
      [0, 4],
      [4, 4],
      [2, 0],
      [0, 2],
    ] as const) {
      expect(at(tiles, x, y).animation, `${x},${y}`).toEqual(
        TERRAIN_KIT_CLASSES.ShallowWater.animation,
      );
    }
  });

  it('WAP4.3 edge-of-map shallow water without a land neighbour is not a shore tile', () => {
    for (const t of kitTiles(uniform(1, 3, 3, 'ShallowWater'))) {
      expect(t.animation).toEqual(TERRAIN_KIT_CLASSES.ShallowWater.animation);
      expect(SHORE_FRAMES.has(t.frame)).toBe(false);
    }
  });

  it('WAP4.3 deep water bordering land stays animated (shore is shallow-only)', () => {
    const m = mapOf(1, 3, 3, (x, y) => (x === 1 && y === 1 ? 'Floor' : 'DeepWater'));
    for (const t of kitTiles(m).filter((p) => !(p.x === 1 && p.y === 1))) {
      expect(t.animation).toEqual(TERRAIN_KIT_CLASSES.DeepWater.animation);
      expect(SHORE_FRAMES.has(t.frame)).toBe(false);
    }
  });
});

// --- WAP4.4 (pure half) -----------------------------------------------------------------
describe('water frame clock (WAP4.4)', () => {
  const P = WATER_FRAME_MS;

  it('WAP4.4 frame k is held across [k*P, (k+1)*P) and advances at the boundary', () => {
    for (const k of [0, 1, 2, 3]) {
      expect(waterFrameIndex(k * P, false, 4)).toBe(k);
      expect(waterFrameIndex((k + 1) * P - 1, false, 4)).toBe(k);
    }
  });

  it('WAP4.4 the frame index wraps after frameCount frames', () => {
    expect(waterFrameIndex(4 * P, false, 4)).toBe(0);
    expect(waterFrameIndex(5 * P + 1, false, 4)).toBe(1);
    expect(waterFrameIndex(1000 * P + 2 * P, false, 4)).toBe(2);
    expect(waterFrameIndex(7 * P, false, 3)).toBe(1);
  });

  it('WAP4.4 reduced motion holds frame 0 for every time', () => {
    for (let t = 0; t < 20 * P; t += 37) expect(waterFrameIndex(t, true, 4)).toBe(0);
    expect(waterFrameIndex(P * 3, true, 4)).toBe(0);
  });

  it('WAP4.4 an explicit period moves the boundary away from WATER_FRAME_MS', () => {
    expect(waterFrameIndex(P, false, 4, 2 * P)).toBe(0);
    expect(waterFrameIndex(2 * P, false, 4, 2 * P)).toBe(1);
    expect(waterFrameIndex(P, false, 4, P / 2)).toBe(2);
  });

  it('WAP4.4 a negative clock floors into a non-negative frame', () => {
    expect(waterFrameIndex(-1, false, 4, 100)).toBe(3);
    expect(waterFrameIndex(-100, false, 4, 100)).toBe(3);
    expect(waterFrameIndex(-401, false, 4, 100)).toBe(3);
  });

  it('WAP4.4 a non-finite or non-positive frameCount or period yields frame 0', () => {
    expect(waterFrameIndex(500, false, Number.POSITIVE_INFINITY, 100)).toBe(0);
    expect(waterFrameIndex(500, false, 0, 100)).toBe(0);
    expect(waterFrameIndex(500, false, 4, 0)).toBe(0);
  });

  it('WAP4.4 non-finite time reads frame 0', () => {
    for (const t of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(waterFrameIndex(t, false, 4)).toBe(0);
    }
  });
});

// --- WAP4.5 -----------------------------------------------------------------------------
function waterMap(w: number, h: number): TileMap {
  const kinds: TerrainKind[] = [
    'Floor',
    'ShallowWater',
    'DeepWater',
    'Rock',
    'Path',
    'ShallowWater',
  ];
  return mapOf(2, w, h, (x, y) => kinds[(x * 3 + y * 5) % kinds.length] as TerrainKind);
}

describe('chunk planning (WAP4.5)', () => {
  const cases: Array<[number, number, number | undefined]> = [
    [40, 28, 16],
    [10, 7, 4],
    [1, 1, 16],
    [17, 17, 16],
    [40, 28, undefined],
  ];

  it('WAP4.5 chunks partition the map exactly, each within the chunk edge', () => {
    for (const [w, h, size] of cases) {
      const edge = size ?? TERRAIN_CHUNK_TILES;
      const plan = planChunks(w, h, kitTiles(waterMap(w, h)), size);
      const cover = new Array<number>(w * h).fill(0);
      for (const c of plan.chunks) {
        expect(c.w > 0 && c.h > 0 && c.w <= edge && c.h <= edge, `${w}x${h}`).toBe(true);
        expect(c.x >= 0 && c.y >= 0 && c.x + c.w <= w && c.y + c.h <= h, `${w}x${h}`).toBe(true);
        for (let y = c.y; y < c.y + c.h; y++)
          for (let x = c.x; x < c.x + c.w; x++) cover[y * w + x]++;
      }
      expect(
        cover.every((n) => n === 1),
        `${w}x${h}`,
      ).toBe(true);
    }
  });

  it('WAP4.5 each static placement is in exactly one chunk, inside its rect', () => {
    for (const [w, h, size] of cases) {
      const tiles = kitTiles(waterMap(w, h));
      const plan = planChunks(w, h, tiles, size);
      const statics = tiles.filter((t) => t.animation === undefined);
      const hits = new Map<string, number>();
      for (const c of plan.chunks) {
        for (const t of c.tiles) {
          expect(t.x >= c.x && t.x < c.x + c.w && t.y >= c.y && t.y < c.y + c.h).toBe(true);
          hits.set(`${t.x},${t.y}`, (hits.get(`${t.x},${t.y}`) ?? 0) + 1);
        }
      }
      expect(hits.size, `${w}x${h}`).toBe(statics.length);
      expect([...hits.values()].every((n) => n === 1)).toBe(true);
      for (const t of statics) expect(hits.get(`${t.x},${t.y}`)).toBe(1);
    }
  });

  it('WAP4.5 animated placements are excluded from every chunk and listed in animated', () => {
    const tiles = kitTiles(waterMap(40, 28));
    const plan = planChunks(40, 28, tiles);
    const animated = tiles.filter((t) => t.animation !== undefined);
    expect(animated.length).toBeGreaterThan(0);
    expect(plan.animated).toHaveLength(animated.length);
    for (const t of animated) expect(plan.animated).toContainEqual(t);
    for (const c of plan.chunks) {
      for (const t of c.tiles) expect(t.animation).toBeUndefined();
    }
  });
});

describe('chunk texture cache (WAP4.5/WAP4.6)', () => {
  interface Token {
    readonly id: number;
    readonly options: ChunkTextureOptions;
  }
  /** `failOn`: the 1-based create call (across the whole harness) that throws. */
  function harness(failOn?: number) {
    const created: Token[] = [];
    const destroyed: Token[] = [];
    let calls = 0;
    const cache = new ChunkCache<Token>(
      (_chunk: Chunk, options) => {
        calls++;
        if (calls === failOn) throw new Error('create failed');
        const tok = { id: created.length, options };
        created.push(tok);
        return tok;
      },
      (tok) => {
        destroyed.push(tok);
      },
    );
    return { cache, created, destroyed };
  }
  const mkChunks = () => planChunks(40, 28, []).chunks;

  it('WAP4.5 build creates one texture per chunk and returns them', () => {
    const { cache, created } = harness();
    const chunks = mkChunks();
    const out = cache.build(chunks, 1);
    expect(chunks.length).toBe(6);
    expect(created).toHaveLength(6);
    expect(out).toEqual(created);
    expect(cache.size).toBe(6);
  });

  it('WAP4.5 a second build destroys every texture of the first exactly once', () => {
    const { cache, created, destroyed } = harness();
    const chunks = mkChunks();
    const first = [...cache.build(chunks, 1)];
    cache.build(chunks, 1);
    expect(destroyed).toHaveLength(6);
    for (const tok of first) expect(destroyed.filter((d) => d === tok)).toHaveLength(1);
    expect(created).toHaveLength(12);
    expect(cache.size).toBe(6);
  });

  it('WAP4.5 clear destroys every live texture exactly once; a second clear is a no-op', () => {
    const { cache, created, destroyed } = harness();
    const chunks = mkChunks();
    cache.build(chunks, 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(destroyed).toHaveLength(6);
    for (const tok of created) expect(destroyed.filter((d) => d === tok)).toHaveLength(1);
    cache.clear();
    expect(destroyed).toHaveLength(6);
  });

  it('WAP4.5 across build, build, clear every created texture is destroyed exactly once', () => {
    const { cache, created, destroyed } = harness();
    const chunks = mkChunks();
    cache.build(chunks, 1);
    cache.build(chunks.slice(0, 3), 2);
    cache.clear();
    expect(created).toHaveLength(9);
    expect(destroyed).toHaveLength(9);
    for (const tok of created) expect(destroyed.filter((d) => d === tok)).toHaveLength(1);
  });

  it('WAP4.5 building an empty chunk list after a build destroys both and leaves size 0', () => {
    const { cache, created, destroyed } = harness();
    cache.build(mkChunks().slice(0, 2), 1);
    expect(cache.build([], 1)).toEqual([]);
    expect(cache.size).toBe(0);
    expect(destroyed).toHaveLength(2);
    for (const tok of created) expect(destroyed.filter((d) => d === tok)).toHaveLength(1);
  });

  it('WAP4.5 a failed rebuild is atomic: new textures destroyed, previous set stays live', () => {
    const { cache, created, destroyed } = harness(4);
    const chunks = mkChunks().slice(0, 2);
    cache.build(chunks, 1);
    expect(() => cache.build(chunks, 1)).toThrow('create failed');
    expect(created).toHaveLength(3);
    expect(destroyed).toEqual([created[2]]);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(destroyed).toHaveLength(3);
    for (const tok of created) expect(destroyed.filter((d) => d === tok)).toHaveLength(1);
  });

  it('WAP4.5 a failed first build leaves size 0 and destroys what it created', () => {
    const { cache, created, destroyed } = harness(2);
    expect(() => cache.build(mkChunks().slice(0, 3), 1)).toThrow('create failed');
    expect(created).toHaveLength(1);
    expect(destroyed).toEqual([created[0]]);
    expect(cache.size).toBe(0);
  });

  it('WAP4.6 chunkTextureRequest maps the cache options to Pixi generateTexture options', () => {
    for (const scale of [1, 2, 3]) {
      const { cache, created } = harness();
      cache.build(mkChunks().slice(0, 1), scale);
      const opts = (created[0] as Token).options;
      expect(chunkTextureRequest(opts)).toEqual({
        resolution: scale,
        textureSourceOptions: { scaleMode: 'nearest' },
      });
    }
  });

  it('WAP4.6 every create call receives the deviceScale with nearest scaling', () => {
    for (const scale of [1, 2, 3]) {
      const { cache, created } = harness();
      const chunks = mkChunks();
      cache.build(chunks, scale);
      expect(created).toHaveLength(6);
      for (const tok of created)
        expect(tok.options).toEqual({ resolution: scale, scaleMode: 'nearest' });
    }
  });

  it('WAP4.6 a rebuild at a new deviceScale uses the new scale for the second batch', () => {
    const { cache, created } = harness();
    const chunks = mkChunks();
    cache.build(chunks, 2);
    cache.build(chunks, 3);
    expect(created.slice(0, 6).every((t) => t.options.resolution === 2)).toBe(true);
    expect(created.slice(6).every((t) => t.options.resolution === 3)).toBe(true);
    expect(created.every((t) => t.options.scaleMode === 'nearest')).toBe(true);
  });

  it('WAP4.6 kitAtlasAsset asks Pixi for nearest-scaled atlas textures', () => {
    expect(kitAtlasAsset('/art/terrain-kit.json')).toEqual({
      src: '/art/terrain-kit.json',
      data: { textureOptions: { scaleMode: 'nearest' } },
    });
  });
});
