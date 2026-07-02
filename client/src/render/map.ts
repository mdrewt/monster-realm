// render/map.ts — the renderer's tile map (M4b, ADR-0004 visual-SSOT).
//
// PURE. Parses the SAME `TileMap` the rule evaluates — handed over ONCE from the
// wasm `zone_map()` export (game-core `zone_0()`), never a hard-coded TS grid
// (that would visually desync from authority). `zone_map()` serializes the Rust
// struct's fields as-is (snake_case, `walkable` a row-major `bool[]`), so the raw
// shape is `{ zone_id, width, height, walkable }`. Parse-don't-validate: a ragged
// `walkable` length is rejected LOUD here, the sole constructor, so every TileMap
// downstream holds its invariant (matches game-core's `from_rows`).

/** A warp portal definition in the serde wire shape from game-core `WarpDef`.
 *  `from` is the source tile in this zone; `to_zone` and `to_tile` are the
 *  destination zone id and landing tile. (M11c, ADR-0067) */
export interface RawWarpDef {
  readonly from: { readonly x: number; readonly y: number };
  readonly to_zone: number;
  readonly to_tile: { readonly x: number; readonly y: number };
}

/** The raw object `client-wasm.zone_map()` returns (serde field names, row-major).
 *  `grass` rides along additively (M8c): a row-major `bool[]` parallel to `walkable`.
 *  `warps` carries the warp overlay list (M11c, ADR-0067). Absent ⟹ no warps (backward compat). */
export interface RawTileMap {
  readonly zone_id: number;
  readonly width: number;
  readonly height: number;
  readonly walkable: readonly boolean[];
  readonly grass: readonly boolean[];
  readonly warps?: readonly RawWarpDef[];
}

export class TileMap {
  readonly zoneId: number;
  readonly width: number;
  readonly height: number;
  readonly #walkable: readonly boolean[];
  readonly #grass: readonly boolean[];
  /** "x,y" string keys for O(1) warp-source lookup. */
  readonly #warps: ReadonlySet<string>;

  private constructor(
    zoneId: number,
    width: number,
    height: number,
    walkable: readonly boolean[],
    grass: readonly boolean[],
    warps: ReadonlySet<string>,
  ) {
    this.zoneId = zoneId;
    this.width = width;
    this.height = height;
    this.#walkable = walkable;
    this.#grass = grass;
    this.#warps = warps;
  }

  /** Parse the wasm `zone_map()` value. Throws (parse-don't-validate) on a shape
   *  that violates the grid invariant — never a silent default. */
  static fromRaw(raw: RawTileMap): TileMap {
    const { zone_id, width, height, walkable, grass } = raw;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
      throw new Error(`render/map: invalid dimensions ${width}x${height}`);
    }
    if (walkable.length !== width * height) {
      throw new Error(
        `render/map: ragged grid — walkable.length ${walkable.length} != ${width}*${height}`,
      );
    }
    // Same ragged-length guard for the grass layer (M8c): the grass list must be
    // the SAME width*height grid as walkable, else the wire contract is broken.
    if (grass.length !== width * height) {
      throw new Error(
        `render/map: ragged grid — grass.length ${grass.length} != ${width}*${height}`,
      );
    }
    // Build a Set of "x,y" keys for O(1) isWarp lookup. `warps` absent ⟹ empty set
    // (backward compat: old wire format without the field is treated as no warps).
    const warpSet = new Set((raw.warps ?? []).map((w) => `${w.from.x},${w.from.y}`));
    return new TileMap(zone_id, width, height, walkable, grass, warpSet);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Out-of-range is a WALL, never an exception (mirrors game-core's bounds-safe get). */
  isWalkable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.#walkable[y * this.width + x] ?? false;
  }

  /** Out-of-range is NOT grass, never an exception (mirrors game-core's `is_grass`). */
  isGrass(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.#grass[y * this.width + x] ?? false;
  }

  /** True iff (x, y) is declared as a warp SOURCE tile in this zone.
   *  Out-of-range is false, never an exception (mirrors the bounds-safe pattern).
   *  Note: `to_tile` (the landing spot) is in a DIFFERENT zone and is never a
   *  warp source here. (M11c, ADR-0067) */
  isWarp(x: number, y: number): boolean {
    return this.#warps.has(`${x},${y}`);
  }
}
