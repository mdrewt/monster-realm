// render/map.ts behaviour suite (M4b) — vitest + fast-check.
// SOURCE OF TRUTH: M4-frontend.spec.md §3 "Rendering" — draw the tile map from
// zone_map() (read once from wasm), never a hard-coded TS grid. The parser holds
// the same grid invariant game-core's `from_rows` does (parse-don't-validate).

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadWasmPkg } from '../../test-util/wasmPkg';
import { type RawTileMap, TERRAIN_KINDS, TileMap } from './map';

// zone_0()'s art (game-core/src/world.rs) — the integration anchor. M8c adds an
// interior tall-grass (`~`) tile so the renderer's grass layer has something to
// draw. The exact grass tiles in the real zone_0 are the implementer's choice
// (R-I: NOT on the spawn (1,1) or the world-test-asserted tiles); this local copy
// only needs SOME interior grass to exercise the renderer's grass parsing, kept
// off every tile the walkability tests below assert.
const ZONE_0_ROWS = [
  '##########',
  '#........#',
  '#.~......#', // (2,2) is grass — walkable, not on spawn, not a wall-asserted tile
  '#...##...#',
  '#........#',
  '#........#',
  '##########',
];
function zone0Raw(): RawTileMap {
  const width = ZONE_0_ROWS[0].length;
  const height = ZONE_0_ROWS.length;
  const walkable = ZONE_0_ROWS.flatMap((row) => [...row].map((c) => c === '.' || c === '~'));
  const grass = ZONE_0_ROWS.flatMap((row) => [...row].map((c) => c === '~'));
  return { zone_id: 0, width, height, walkable, grass };
}

// A tiny grass fixture grid for the isGrass truth table (M8c). The renderer reads
// the grass layer the same way game-core's `is_grass` does (row-major, bounds-safe):
//   row 0: "###"
//   row 1: ".~#"  → (0,1) floor, (1,1) grass, (2,1) wall
//   row 2: "~.#"  → (0,2) grass, (1,2) floor, (2,2) wall
const GRASS_FIXTURE_ROWS = ['###', '.~#', '~.#'];
function grassFixtureRaw(): RawTileMap {
  const width = GRASS_FIXTURE_ROWS[0].length;
  const height = GRASS_FIXTURE_ROWS.length;
  const walkable = GRASS_FIXTURE_ROWS.flatMap((row) => [...row].map((c) => c === '.' || c === '~'));
  const grass = GRASS_FIXTURE_ROWS.flatMap((row) => [...row].map((c) => c === '~'));
  return { zone_id: 0, width, height, walkable, grass };
}

describe('TileMap.fromRaw: parse, not validate', () => {
  it('parses a coherent grid and exposes dimensions', () => {
    const m = TileMap.fromRaw(zone0Raw());
    expect(m.zoneId).toBe(0);
    expect(m.width).toBe(10);
    expect(m.height).toBe(7);
  });

  it('BITES: rejects a ragged walkable length (never a silent default)', () => {
    // grass is coherent (length 6 == 3*2) so ONLY the walkable raggedness can fire.
    expect(() =>
      TileMap.fromRaw({
        zone_id: 0,
        width: 3,
        height: 2,
        walkable: [true, true],
        grass: [false, false, false, false, false, false],
      }),
    ).toThrow(/ragged/);
  });

  it('BITES: rejects negative / non-integer dimensions', () => {
    expect(() =>
      TileMap.fromRaw({ zone_id: 0, width: -1, height: 2, walkable: [], grass: [] }),
    ).toThrow();
    expect(() =>
      TileMap.fromRaw({ zone_id: 0, width: 1.5, height: 2, walkable: [], grass: [] }),
    ).toThrow();
  });

  // `RawTileMap.grass` is additive on the wire; `fromRaw` holds the same
  // grid invariant for grass as for walkable (parse-don't-validate). Mirrors the
  // existing ragged-`walkable` test.
  it('BITES: rejects a ragged grass length (grass must be width*height too)', () => {
    // walkable is the right length (4 == 2*2) but grass is ragged (length 2) — the
    // grass guard must fire. Kills an impl that validates `walkable` but forgets `grass`.
    expect(() =>
      TileMap.fromRaw({
        zone_id: 0,
        width: 2,
        height: 2,
        walkable: [true, true, true, true],
        grass: [true, true],
      }),
    ).toThrow(/ragged/);
  });
});

describe('TileMap.isGrass (M8c grass layer)', () => {
  it('parses a valid grid and exposes its grass truth table', () => {
    const m = TileMap.fromRaw(grassFixtureRaw());
    // grass tiles
    expect(m.isGrass(1, 1)).toBe(true);
    expect(m.isGrass(0, 2)).toBe(true);
    // floor is NOT grass
    expect(m.isGrass(0, 1)).toBe(false);
    expect(m.isGrass(1, 2)).toBe(false);
    // wall is NOT grass
    expect(m.isGrass(2, 1)).toBe(false);
    expect(m.isGrass(0, 0)).toBe(false);
  });

  it('out-of-range is NOT grass, never an exception', () => {
    const m = TileMap.fromRaw(grassFixtureRaw());
    expect(m.isGrass(-1, 0)).toBe(false);
    expect(m.isGrass(0, -1)).toBe(false);
    expect(m.isGrass(3, 1)).toBe(false); // just past width
    expect(m.isGrass(0, 3)).toBe(false); // just past height
    expect(m.isGrass(1000, 1000)).toBe(false);
  });

  it('zone_0 exposes its grass layer (at least one grass tile, none on spawn)', () => {
    const m = TileMap.fromRaw(zone0Raw());
    // spawn (1,1) must not be grass (matches game-core: keep the spawn plain).
    expect(m.isGrass(1, 1)).toBe(false);
    // some grass tile exists somewhere in the interior.
    let anyGrass = false;
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        if (m.isGrass(x, y)) anyGrass = true;
      }
    }
    expect(anyGrass).toBe(true);
  });

  it('property: isGrass is total and never throws over arbitrary coords', () => {
    const m = TileMap.fromRaw(grassFixtureRaw());
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 }), (x, y) => {
        expect(typeof m.isGrass(x, y)).toBe('boolean');
      }),
    );
  });
});

describe('TileMap walkability matches zone_0 (visual-SSOT)', () => {
  it('the border is wall, the interior floor, the inner block (4..5,3) wall', () => {
    const m = TileMap.fromRaw(zone0Raw());
    expect(m.isWalkable(0, 0)).toBe(false); // border
    expect(m.isWalkable(1, 1)).toBe(true); // spawn floor
    expect(m.isWalkable(4, 3)).toBe(false); // inner wall block (row "#...##...#")
    expect(m.isWalkable(5, 3)).toBe(false);
    expect(m.isWalkable(3, 3)).toBe(true); // floor either side of the block
    expect(m.isWalkable(6, 3)).toBe(true);
  });

  it('out-of-range is a WALL, never an exception', () => {
    const m = TileMap.fromRaw(zone0Raw());
    expect(m.isWalkable(-1, 0)).toBe(false);
    expect(m.isWalkable(0, -1)).toBe(false);
    expect(m.isWalkable(10, 0)).toBe(false);
    expect(m.isWalkable(0, 7)).toBe(false);
    expect(m.inBounds(1000, 1000)).toBe(false);
  });

  it('property: isWalkable is total and never throws over arbitrary coords', () => {
    const m = TileMap.fromRaw(zone0Raw());
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 }), (x, y) => {
        expect(typeof m.isWalkable(x, y)).toBe('boolean');
      }),
    );
  });
});

// =============================================================================
// M11c extension: TileMap warp field (C2 — warp field parse + isWarp)
//
// =============================================================================

import type { RawWarpDef } from './map';

// RawWarpDef mirrors the serde output of game-core's `WarpDef` struct:
//   { from: TilePos, to_zone: u32, to_tile: TilePos }
// where TilePos serializes as { x: i32, y: i32 }.
// Spec rationale: zone_map() hands the serialized TileMap (including warps) over
// the wasm boundary via serde; the TS interface must match the wire format.

/** Shorthand warp-def literal in the serde wire shape. */
function warpDef(
  fromX: number,
  fromY: number,
  toZone: number,
  toX: number,
  toY: number,
): RawWarpDef {
  return { from: { x: fromX, y: fromY }, to_zone: toZone, to_tile: { x: toX, y: toY } };
}

/** Build a minimal 3×3 raw map with an optional warp list. */
function warpFixtureRaw(warps?: readonly RawWarpDef[]): RawTileMap {
  // 3×3 all-floor map; warp tiles are separate from walkability.
  const walkable = Array<boolean>(9).fill(true);
  const grass = Array<boolean>(9).fill(false);
  const base: RawTileMap = { zone_id: 1, width: 3, height: 3, walkable, grass };
  return warps !== undefined ? { ...base, warps } : base;
}

describe('TileMap M11c C2: fromRaw parses warps array without error', () => {
  it('BITES: fromRaw with a non-empty warps array parses successfully', () => {
    // Kills: an impl that throws or crashes when warps is present (no-field guard).
    const raw = warpFixtureRaw([warpDef(1, 0, 1, 5, 5)]);
    expect(() => TileMap.fromRaw(raw)).not.toThrow();
  });

  it('BITES: fromRaw with an empty warps array parses successfully', () => {
    // Kills: an impl that requires at least one warp or errors on empty array.
    const raw = warpFixtureRaw([]);
    expect(() => TileMap.fromRaw(raw)).not.toThrow();
  });

  it('BITES: fromRaw with warps absent (backward compat) accepts it as empty', () => {
    // Kills: an impl that throws when warps is undefined/absent (breaks old wire format).
    const raw = warpFixtureRaw(/* no warps arg */);
    expect(() => TileMap.fromRaw(raw)).not.toThrow();
    const m = TileMap.fromRaw(raw);
    // No warp tiles exist — isWarp must return false for all coords.
    expect(m.isWarp(1, 0)).toBe(false);
    expect(m.isWarp(0, 0)).toBe(false);
  });
});

describe('TileMap M11c C2: isWarp returns true only for warp source tiles', () => {
  it('BITES: isWarp(1,0) is true when (1,0) is declared as a warp source', () => {
    // Kills: an impl that always returns false (isWarp is a stub).
    const raw = warpFixtureRaw([warpDef(1, 0, 2, 3, 3)]);
    const m = TileMap.fromRaw(raw);
    expect(m.isWarp(1, 0)).toBe(true);
  });

  it('BITES: isWarp returns false for a tile NOT in the warps array', () => {
    // Kills: an impl that returns true for all tiles once any warp exists.
    const raw = warpFixtureRaw([warpDef(1, 0, 2, 3, 3)]);
    const m = TileMap.fromRaw(raw);
    expect(m.isWarp(0, 0)).toBe(false);
    expect(m.isWarp(2, 2)).toBe(false);
    expect(m.isWarp(0, 2)).toBe(false);
  });

  it('BITES: multiple warps — each source tile returns true, non-warp tiles false', () => {
    // Kills: an impl that only stores the first warp entry.
    const raw = warpFixtureRaw([warpDef(0, 0, 1, 5, 5), warpDef(2, 2, 2, 1, 1)]);
    const m = TileMap.fromRaw(raw);
    expect(m.isWarp(0, 0)).toBe(true);
    expect(m.isWarp(2, 2)).toBe(true);
    expect(m.isWarp(1, 1)).toBe(false); // center tile — not a warp
  });

  it('BITES: warp destination (to_tile) is NOT treated as a warp source', () => {
    // The warp source is `from` only. `to_tile` is the landing spot in another zone
    // and must never be marked as a warp source in this zone.
    // Kills: an impl that marks both `from` and `to_tile` as warp tiles.
    // Spec rationale (log): `from` = source tile; `to_tile` = destination in to_zone —
    // two different zones, so to_tile cannot be a source in this map.
    const raw = warpFixtureRaw([warpDef(0, 0, 1, 2, 2)]);
    const m = TileMap.fromRaw(raw);
    expect(m.isWarp(0, 0)).toBe(true); // source tile
    expect(m.isWarp(2, 2)).toBe(false); // destination tile — NOT a warp source here
  });
});

describe('TileMap M11c C2: isWarp out-of-bounds safety', () => {
  it('BITES: isWarp(-1, 0) returns false (never throws)', () => {
    // Kills: an impl that throws on negative coordinates.
    const raw = warpFixtureRaw([warpDef(0, 0, 1, 5, 5)]);
    const m = TileMap.fromRaw(raw);
    expect(m.isWarp(-1, 0)).toBe(false);
  });

  it('BITES: isWarp past width/height returns false (never throws)', () => {
    // Kills: an impl that does array access without bounds checking.
    const raw = warpFixtureRaw([warpDef(1, 1, 3, 0, 0)]);
    const m = TileMap.fromRaw(raw);
    expect(m.isWarp(3, 0)).toBe(false); // just past width=3
    expect(m.isWarp(0, 3)).toBe(false); // just past height=3
    expect(m.isWarp(1000, 1000)).toBe(false);
  });

  it('property: isWarp is total and never throws over arbitrary coords', () => {
    // Kills: any exception path in the bounds-check.
    const raw = warpFixtureRaw([warpDef(1, 1, 1, 0, 0)]);
    const m = TileMap.fromRaw(raw);
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 }), (x, y) => {
        expect(typeof m.isWarp(x, y)).toBe('boolean');
      }),
    );
  });
});

// =============================================================================
// wap-1 — terrain grammar: the richer zone payload (WAP1.4 real pkg, WAP1.5 parse)
//
// Fixtures write the serde WIRE NAMES directly (game-core `TileKind` variant
// names), never glyphs — the client holds no glyph table. Every expected value is
// hand-typed from the spec class table.
// =============================================================================

/** The ten wire names in class-table / declaration order, hand-typed. */
const WIRE_NAMES = [
  'Floor',
  'Wall',
  'TallGrass',
  'Path',
  'Sand',
  'ShallowWater',
  'DeepWater',
  'Rock',
  'Tree',
  'Bush',
];

/** A width×height payload with flat walkable/grass layers plus the given optional
 *  `terrain` / `landmarks`, cast through `unknown` so tests can feed malformed
 *  entries the wire type forbids. */
function terrainRaw(
  width: number,
  height: number,
  extra: { terrain?: readonly unknown[]; landmarks?: readonly unknown[] },
): RawTileMap {
  const n = width * height;
  return {
    zone_id: 5,
    width,
    height,
    walkable: Array<boolean>(n).fill(true),
    grass: Array<boolean>(n).fill(false),
    ...extra,
  } as unknown as RawTileMap;
}

/** 3×2 (non-square), six distinct classes in row-major order. */
const SIX = ['Floor', 'Wall', 'TallGrass', 'Path', 'Sand', 'ShallowWater'];

describe('wap-1 zone_map payload from the BUILT wasm pkg (WAP1.4)', () => {
  it('zone_map(0) is a plain object with terrain + landmarks, and terrain_kinds() is TERRAIN_KINDS wap1_4', async () => {
    // Kills: a payload that `#[serde(flatten)]`s (serde_wasm_bindgen then emits a JS
    // Map, so raw.walkable is undefined), a renamed/missing field, a terrain list not
    // parallel to walkable, a heal landmark serialized under another kind name, and a
    // TS roster that drifts from game-core's TileKind (names or order).
    const pkg = await loadWasmPkg();
    const raw = (pkg.zone_map as (zoneId: number) => RawTileMap)(0);
    expect(raw instanceof Map).toBe(false);
    expect(Object.keys(raw).sort()).toEqual([
      'grass',
      'height',
      'landmarks',
      'terrain',
      'walkable',
      'warps',
      'width',
      'zone_id',
    ]);
    expect(Array.isArray(raw.terrain)).toBe(true);
    expect(raw.terrain?.length).toBe(raw.walkable.length);

    const m = TileMap.fromRaw(raw);
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        expect(m.terrainAt(x, y), `terrain at (${x},${y})`).toBeDefined();
      }
    }
    expect(m.landmarks.length).toBeGreaterThan(0);
    const first = m.landmarks[0];
    expect(first.kind).toBe('heal');
    expect(Number.isInteger(first.x)).toBe(true);
    expect(Number.isInteger(first.y)).toBe(true);
    expect(m.inBounds(first.x, first.y)).toBe(true);

    expect([...(pkg.terrain_kinds as () => string[])()]).toEqual([...TERRAIN_KINDS]);
  });
});

describe('wap-1 TileMap.terrainAt (WAP1.5)', () => {
  it('reads each tile class back row-major on a non-square payload wap1_5', () => {
    // Kills: a column-major index (y*height+x / x*height+y) — 3×2 makes them differ.
    const m = TileMap.fromRaw(terrainRaw(3, 2, { terrain: SIX }));
    expect(m.terrainAt(0, 0)).toBe('Floor');
    expect(m.terrainAt(1, 0)).toBe('Wall');
    expect(m.terrainAt(2, 0)).toBe('TallGrass');
    expect(m.terrainAt(0, 1)).toBe('Path');
    expect(m.terrainAt(1, 1)).toBe('Sand');
    expect(m.terrainAt(2, 1)).toBe('ShallowWater');
  });

  it('is undefined off-map and for non-integer coords wap1_5', () => {
    // Kills: a missing bounds check — (3,0) would read row 1's 'Path', (-1,1) row 0's
    // 'TallGrass' — and a floor/round of fractional coords.
    const m = TileMap.fromRaw(terrainRaw(3, 2, { terrain: SIX }));
    expect(m.terrainAt(-1, 0)).toBeUndefined();
    expect(m.terrainAt(-1, 1)).toBeUndefined();
    expect(m.terrainAt(3, 0)).toBeUndefined();
    expect(m.terrainAt(0, 2)).toBeUndefined();
    expect(m.terrainAt(0, -1)).toBeUndefined();
    expect(m.terrainAt(1.5, 0)).toBeUndefined();
    expect(m.terrainAt(0, 0.5)).toBeUndefined();
  });

  it('a payload without terrain reports no terrain anywhere; walkable/grass unchanged wap1_5', () => {
    // Kills: client-side terrain derivation from walkable/grass (the spec forbids it:
    // the renderer takes its flat fallback), and a no-terrain path that breaks the
    // existing layers.
    const m = TileMap.fromRaw(grassFixtureRaw());
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        expect(m.terrainAt(x, y), `(${x},${y})`).toBeUndefined();
      }
    }
    expect(m.isWalkable(0, 1)).toBe(true);
    expect(m.isWalkable(0, 0)).toBe(false);
    expect(m.isGrass(1, 1)).toBe(true);
    expect(m.isGrass(0, 1)).toBe(false);
  });

  it('accepts all ten wire names and reads each back; TERRAIN_KINDS is the roster wap1_5', () => {
    // Kills: a roster missing a class (that name would throw), a misspelled name, and a
    // reordered TERRAIN_KINDS.
    expect([...TERRAIN_KINDS]).toEqual(WIRE_NAMES);
    const m = TileMap.fromRaw(terrainRaw(10, 1, { terrain: WIRE_NAMES }));
    WIRE_NAMES.forEach((name, x) => {
      expect(m.terrainAt(x, 0), `x=${x}`).toBe(name);
    });
  });

  it('is undefined for a fractional coord that lands on an integer row-major index wap1_5', () => {
    // Kills: a bounds-only guard with no integer check — on a WIDTH-2 map
    // (0, 0.5) computes 0.5*2+0 = 1 and reads 'Wall', (1, 0.5) computes 2 and
    // reads 'Path'. (A width-3 map hides this: 0.5*3 = 1.5 is no array index.)
    const m = TileMap.fromRaw(terrainRaw(2, 2, { terrain: ['Floor', 'Wall', 'Path', 'Sand'] }));
    expect(m.terrainAt(0, 0.5)).toBeUndefined();
    expect(m.terrainAt(1, 0.5)).toBeUndefined();
    expect(m.terrainAt(0, 1.5)).toBeUndefined();
    // Sanity: the integer neighbours still read back (the guard is not "always undefined").
    expect(m.terrainAt(1, 0)).toBe('Wall');
    expect(m.terrainAt(0, 1)).toBe('Path');
    // A width-1 map: (0.5, 0) must also be undefined.
    const narrow = TileMap.fromRaw(terrainRaw(1, 2, { terrain: ['Floor', 'Wall'] }));
    expect(narrow.terrainAt(0.5, 0)).toBeUndefined();
    expect(narrow.terrainAt(0, 1)).toBe('Wall');
  });
});

describe('wap-1 TileMap.fromRaw terrain validation (WAP1.5)', () => {
  it('rejects a ragged terrain list, one short and one long wap1_5', () => {
    // walkable/grass are coherent, so ONLY the terrain length can fire.
    // Kills: an impl that validates walkable/grass but not terrain.
    expect(() => TileMap.fromRaw(terrainRaw(3, 2, { terrain: SIX.slice(0, 5) }))).toThrow(/ragged/);
    expect(() => TileMap.fromRaw(terrainRaw(3, 2, { terrain: [...SIX, 'Floor'] }))).toThrow(
      /ragged/,
    );
  });

  it('rejects any name outside the ten wire names wap1_5', () => {
    // Kills: a case-insensitive match ('floor'), a prefix/includes match, an object
    // lookup roster (`name in table` accepts 'constructor' / '__proto__'), and a
    // silent default for non-strings.
    for (const bad of ['Water', 'floor', '', 'constructor', '__proto__', 'toString', null, 5]) {
      const terrain = ['Floor', bad, 'Wall', 'Floor', 'Floor', 'Floor'];
      expect(() => TileMap.fromRaw(terrainRaw(3, 2, { terrain })), String(bad)).toThrow(
        /unknown terrain/,
      );
    }
  });

  it('rejects a non-array terrain field with a render/map error naming terrain wap1_5', () => {
    // Kills: an `!== undefined` guard that then calls `.length`/`.map` on whatever
    // arrived — null is a bare TypeError, and a STRING of exactly width*height chars
    // ('Floor' on 5×1) passes the length check and dies in `.map` (a TypeError, not
    // a render/map error). The array-like `{ length: 5 }` kills a `typeof !== 'string'`
    // patch that still trusts `.length`.
    for (const bad of [null, 'Floor', { length: 5 }, 5]) {
      const extra = { terrain: bad } as unknown as Parameters<typeof terrainRaw>[2];
      expect(() => TileMap.fromRaw(terrainRaw(5, 1, extra)), String(bad)).toThrow(
        /^render\/map:.*terrain/,
      );
    }
  });

  it('rejects a sparse terrain array of the right length wap1_5', () => {
    // Kills: an `Array.prototype.map` validation — map SKIPS holes, so a hole never
    // reaches the name check and the map holds a silent undefined tile.
    const allHoles: unknown[] = new Array(6);
    expect(allHoles.length).toBe(6);
    expect(() => TileMap.fromRaw(terrainRaw(3, 2, { terrain: allHoles }))).toThrow(
      /^render\/map:.*unknown terrain/,
    );
    // One hole, at index 1, every other slot a valid name.
    const oneHole: unknown[] = new Array(6);
    for (const i of [0, 2, 3, 4, 5]) oneHole[i] = SIX[i];
    expect(1 in oneHole).toBe(false);
    expect(() => TileMap.fromRaw(terrainRaw(3, 2, { terrain: oneHole }))).toThrow(
      /^render\/map:.*unknown terrain/,
    );
  });
});

describe('wap-1 TileMap.landmarks (WAP1.5)', () => {
  it('parses heal landmarks in order; absent landmarks are none wap1_5', () => {
    // Kills: dropping / reordering entries, an x/y swap, and an absent list that is
    // undefined (or throws) instead of [].
    const m = TileMap.fromRaw(
      terrainRaw(3, 2, {
        landmarks: [
          { kind: 'heal', x: 2, y: 1 },
          { kind: 'heal', x: 0, y: 0 },
        ],
      }),
    );
    expect(m.landmarks).toEqual([
      { kind: 'heal', x: 2, y: 1 },
      { kind: 'heal', x: 0, y: 0 },
    ]);
    expect(TileMap.fromRaw(grassFixtureRaw()).landmarks).toEqual([]);
  });

  it('landmarks are frozen wap1_5', () => {
    // Kills: exposing a mutable list (a consumer could rewrite the map's landmarks).
    const m = TileMap.fromRaw(terrainRaw(3, 2, { landmarks: [{ kind: 'heal', x: 1, y: 1 }] }));
    expect(Object.isFrozen(m.landmarks)).toBe(true);
    expect(Object.isFrozen(m.landmarks[0])).toBe(true);
  });

  it('rejects an unknown landmark kind, even as the second entry wap1_5', () => {
    // Kills: validating only the first entry, a case-insensitive kind match, and a
    // silent drop of unknown kinds.
    for (const kind of ['shop', 'Heal']) {
      const landmarks = [
        { kind: 'heal', x: 0, y: 0 },
        { kind, x: 1, y: 1 },
      ];
      expect(() => TileMap.fromRaw(terrainRaw(3, 2, { landmarks })), kind).toThrow(
        /unknown landmark/,
      );
    }
  });

  it('is a defensive copy: mutating the raw arrays afterwards changes nothing wap1_5', () => {
    // Kills: storing the caller's terrain / landmarks arrays by reference.
    const terrain = [...SIX];
    const landmarks = [{ kind: 'heal', x: 2, y: 1 }];
    const m = TileMap.fromRaw(terrainRaw(3, 2, { terrain, landmarks }));
    terrain[0] = 'Wall';
    terrain[5] = 'Bush';
    landmarks[0] = { kind: 'heal', x: 0, y: 0 };
    landmarks.push({ kind: 'heal', x: 1, y: 1 });
    expect(m.terrainAt(0, 0)).toBe('Floor');
    expect(m.terrainAt(2, 1)).toBe('ShallowWater');
    expect(m.landmarks).toEqual([{ kind: 'heal', x: 2, y: 1 }]);
  });

  it('rejects a landmark with a non-integer coordinate, even as the second entry wap1_5', () => {
    // Kills: copying x/y through unchecked (NaN, 1.5, the string '0', a missing
    // coordinate all reach the renderer as a marker position), a `typeof === 'number'`
    // check that admits NaN/1.5, a truthiness check, and validating only entry 0.
    const bads: unknown[] = [
      { kind: 'heal', x: Number.NaN, y: 0 },
      { kind: 'heal', x: 1.5, y: 0 },
      { kind: 'heal', x: '0', y: 0 },
      { kind: 'heal', y: 0 },
      { kind: 'heal', x: 0, y: Number.NaN },
      { kind: 'heal', x: 0, y: 0.5 },
      { kind: 'heal', x: 0, y: '1' },
      { kind: 'heal', x: 0 },
      { kind: 'heal' },
    ];
    for (const bad of bads) {
      const landmarks = [{ kind: 'heal', x: 0, y: 0 }, bad];
      expect(() => TileMap.fromRaw(terrainRaw(3, 2, { landmarks })), JSON.stringify(bad)).toThrow(
        /^render\/map:.*invalid landmark/,
      );
    }
  });

  it('rejects a landmark outside the grid, including x === width and y === height wap1_5', () => {
    // Kills: no bounds check, an off-by-one `<=` bound (x === width / y === height),
    // a missing negative check, and an x/y-swapped bound (on 3×2, (2,1) is in-grid but
    // (1,2) is not — a swapped check accepts (0,2) and rejects (2,0)).
    for (const [x, y] of [
      [99, 0],
      [-1, 0],
      [0, -1],
      [3, 0],
      [0, 2],
      [3, 2],
    ]) {
      const landmarks = [
        { kind: 'heal', x: 0, y: 0 },
        { kind: 'heal', x, y },
      ];
      expect(() => TileMap.fromRaw(terrainRaw(3, 2, { landmarks })), `(${x},${y})`).toThrow(
        /^render\/map:.*invalid landmark/,
      );
    }
    // The far corners are IN the grid and must still parse.
    const ok = TileMap.fromRaw(
      terrainRaw(3, 2, {
        landmarks: [
          { kind: 'heal', x: 2, y: 0 },
          { kind: 'heal', x: 0, y: 1 },
          { kind: 'heal', x: 2, y: 1 },
        ],
      }),
    );
    expect(ok.landmarks.length).toBe(3);
  });

  it('rejects a null or non-object landmark entry with a render/map error wap1_5', () => {
    // Kills: reading `l.kind` straight off the entry — null is a bare TypeError
    // ("Cannot read properties of null"), and 5 / 'heal' read `.kind` as undefined
    // and surface as an "unknown landmark kind" instead of an invalid entry.
    for (const bad of [null, 5, 'heal', undefined]) {
      for (const landmarks of [[bad], [{ kind: 'heal', x: 0, y: 0 }, bad]]) {
        expect(
          () => TileMap.fromRaw(terrainRaw(3, 2, { landmarks })),
          `${String(bad)} at ${landmarks.length - 1}`,
        ).toThrow(/^render\/map:.*invalid landmark/);
      }
    }
  });

  it('rejects a non-array landmarks field with a render/map error naming landmarks wap1_5', () => {
    // Kills: `raw.landmarks ?? []`, which turns null into "no landmarks" (a silent
    // default), and a bare `.map` call that TypeErrors on a string or object.
    for (const bad of [null, 'heal', { length: 1 }, 5]) {
      const extra = { landmarks: bad } as unknown as Parameters<typeof terrainRaw>[2];
      expect(() => TileMap.fromRaw(terrainRaw(3, 2, extra)), String(bad)).toThrow(
        /^render\/map:.*landmarks/,
      );
    }
  });
});
