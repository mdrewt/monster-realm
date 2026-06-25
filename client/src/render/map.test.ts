// render/map.ts behaviour suite (M4b) — vitest + fast-check.
// SOURCE OF TRUTH: M4-frontend.spec.md §3 "Rendering" — draw the tile map from
// zone_map() (read once from wasm), never a hard-coded TS grid. The parser holds
// the same grid invariant game-core's `from_rows` does (parse-don't-validate).
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { type RawTileMap, TileMap } from './map';

// zone_0()'s actual art (game-core/src/world.rs) — the integration anchor.
const ZONE_0_ROWS = [
  '##########',
  '#........#',
  '#........#',
  '#...##...#',
  '#........#',
  '#........#',
  '##########',
];
function zone0Raw(): RawTileMap {
  const width = ZONE_0_ROWS[0].length;
  const height = ZONE_0_ROWS.length;
  const walkable = ZONE_0_ROWS.flatMap((row) => [...row].map((c) => c === '.'));
  return { zone_id: 0, width, height, walkable };
}

describe('TileMap.fromRaw: parse, not validate', () => {
  it('parses a coherent grid and exposes dimensions', () => {
    const m = TileMap.fromRaw(zone0Raw());
    expect(m.zoneId).toBe(0);
    expect(m.width).toBe(10);
    expect(m.height).toBe(7);
  });

  it('BITES: rejects a ragged walkable length (never a silent default)', () => {
    expect(() => TileMap.fromRaw({ zone_id: 0, width: 3, height: 2, walkable: [true, true] })).toThrow(
      /ragged/,
    );
  });

  it('BITES: rejects negative / non-integer dimensions', () => {
    expect(() => TileMap.fromRaw({ zone_id: 0, width: -1, height: 2, walkable: [] })).toThrow();
    expect(() => TileMap.fromRaw({ zone_id: 0, width: 1.5, height: 2, walkable: [] })).toThrow();
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
