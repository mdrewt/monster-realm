// render/map.ts — the renderer's tile map (M4b, ADR-0004 visual-SSOT).
//
// PURE. Parses the SAME `TileMap` the rule evaluates — handed over ONCE from the
// wasm `zone_map()` export (game-core `zone_0()`), never a hard-coded TS grid
// (that would visually desync from authority). `zone_map()` serializes the Rust
// struct's fields as-is (snake_case, `walkable` a row-major `bool[]`), so the raw
// shape is `{ zone_id, width, height, walkable }`. Parse-don't-validate: a ragged
// `walkable` length is rejected LOUD here, the sole constructor, so every TileMap
// downstream holds its invariant (matches game-core's `from_rows`).

/** The raw object `client-wasm.zone_map()` returns (serde field names, row-major). */
export interface RawTileMap {
  readonly zone_id: number;
  readonly width: number;
  readonly height: number;
  readonly walkable: readonly boolean[];
}

export class TileMap {
  readonly zoneId: number;
  readonly width: number;
  readonly height: number;
  readonly #walkable: readonly boolean[];

  private constructor(zoneId: number, width: number, height: number, walkable: readonly boolean[]) {
    this.zoneId = zoneId;
    this.width = width;
    this.height = height;
    this.#walkable = walkable;
  }

  /** Parse the wasm `zone_map()` value. Throws (parse-don't-validate) on a shape
   *  that violates the grid invariant — never a silent default. */
  static fromRaw(raw: RawTileMap): TileMap {
    const { zone_id, width, height, walkable } = raw;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
      throw new Error(`render/map: invalid dimensions ${width}x${height}`);
    }
    if (walkable.length !== width * height) {
      throw new Error(
        `render/map: ragged grid — walkable.length ${walkable.length} != ${width}*${height}`,
      );
    }
    return new TileMap(zone_id, width, height, walkable);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Out-of-range is a WALL, never an exception (mirrors game-core's bounds-safe get). */
  isWalkable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.#walkable[y * this.width + x] ?? false;
  }
}
