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

// =============================================================================
// M11c extension: TileMap warp field (C2 — warp field parse + isWarp)
// SOURCE OF TRUTH: M11c EARS C2 — TileMap warp field.
//
// RED REASON: `RawTileMap` has no `warps` field yet, `RawWarpDef` interface does
// not exist, and `TileMap` has no `isWarp(x, y)` method. All four test blocks
// below will fail to compile / fail assertions until the implementer adds:
//   - `RawWarpDef` interface exported from map.ts
//   - `warps?: readonly RawWarpDef[]` on `RawTileMap`
//   - `isWarp(x, y): boolean` on `TileMap` (out-of-bounds → false, never throw)
//   - `fromRaw` must accept a warps array and populate the warp set
// =============================================================================

import type { RawWarpDef } from './map';

// RawWarpDef mirrors the serde output of game-core's `WarpDef` struct:
//   { from: TilePos, to_zone: u32, to_tile: TilePos }
// where TilePos serializes as { x: i32, y: i32 }.
// The implementer must export `RawWarpDef` from map.ts with exactly this shape.
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
