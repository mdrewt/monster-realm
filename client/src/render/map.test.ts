// render/map.ts behaviour suite (M4b) — vitest + fast-check.
// SOURCE OF TRUTH: M4-frontend.spec.md §3 "Rendering" — draw the tile map from
// zone_map() (read once from wasm), never a hard-coded TS grid. The parser holds
// the same grid invariant game-core's `from_rows` does (parse-don't-validate).

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type RawTileMap, TileMap } from './map';

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

  // M8c — SOURCE OF TRUTH: M8-encounters-recruit.spec §3, PLAN-v2 cross-boundary
  // contract: `RawTileMap.grass` is additive on the wire; `fromRaw` holds the same
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
