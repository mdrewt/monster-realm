// render/map.ts — the renderer's tile map (visual SSOT).
//
// PURE. Parses the SAME `TileMap` the rule evaluates — handed over ONCE from the
// wasm `zone_map()` export, never a hard-coded TS grid (that would visually desync
// from authority). `zone_map()` returns client-wasm's `ZoneMapPayload`: the Rust
// map's fields as-is (snake_case, `walkable`/`grass` row-major `bool[]`, `warps`)
// plus, since wap-1, `terrain` (row-major `TileKind` wire names, parallel to
// `walkable`) and `landmarks` (content-driven markers). Parse-don't-validate: a
// ragged layer or an unknown name is rejected LOUD here, the sole constructor, so
// every TileMap downstream holds its invariant (matches game-core's `from_rows`).
// The client never derives terrain from `walkable`/`grass` (spec constraint 1):
// a payload without `terrain` reports no terrain and the renderer takes its flat
// fallback.

/** A warp portal definition in the serde wire shape from game-core `WarpDef`.
 *  `from` is the source tile in this zone; `to_zone` and `to_tile` are the
 *  destination zone id and landing tile. */
export interface RawWarpDef {
  readonly from: { readonly x: number; readonly y: number };
  readonly to_zone: number;
  readonly to_tile: { readonly x: number; readonly y: number };
}

/** The ten `TileKind` wire names (serde variant names) in game-core declaration
 *  order. A wire-shape mirror like `RawWarpDef`, not a copy of a game rule: no
 *  glyph, GID, walkability or encounter flag lives here. `map.test.ts` pins this
 *  list to the wasm `terrain_kinds()` export so the two cannot drift. */
export const TERRAIN_KINDS = [
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
] as const;
export type TerrainKind = (typeof TERRAIN_KINDS)[number];
const TERRAIN_SET: ReadonlySet<string> = new Set<string>(TERRAIN_KINDS);

function isTerrainKind(name: unknown): name is TerrainKind {
  return typeof name === 'string' && TERRAIN_SET.has(name);
}

/** Integer tile inside a width×height grid (the one bounds rule, shared by the
 *  instance `inBounds` and the landmark check in `fromRaw`). */
function inGrid(x: number, y: number, width: number, height: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;
}

/** A landmark in the wire shape of client-wasm's `Landmark` (`kind` is checked here). */
export interface RawLandmark {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
}

/** A parsed, frozen landmark. `heal` is the only kind today (one per compiled
 *  heal_locations row of the zone); warp markers come from `isWarp`, not from here. */
export interface Landmark {
  readonly kind: 'heal';
  readonly x: number;
  readonly y: number;
}

/** The raw object `client-wasm.zone_map()` returns (serde field names, row-major).
 *  `grass` rides along additively (M8c): a row-major `bool[]` parallel to `walkable`.
 *  `warps` carries the warp overlay list. `terrain` and `landmarks` (wap-1) are
 *  optional on the type because older payload literals (the main-boot test
 *  fixtures) omit them; absent ⟹ no terrain / no landmarks (backward compat). */
export interface RawTileMap {
  readonly zone_id: number;
  readonly width: number;
  readonly height: number;
  readonly walkable: readonly boolean[];
  readonly grass: readonly boolean[];
  readonly warps?: readonly RawWarpDef[];
  readonly terrain?: readonly string[];
  readonly landmarks?: readonly RawLandmark[];
}

export class TileMap {
  readonly zoneId: number;
  readonly width: number;
  readonly height: number;
  /** Content-driven markers, in registry order; frozen (a defensive copy of the raw list). */
  readonly landmarks: readonly Landmark[];
  readonly #walkable: readonly boolean[];
  readonly #grass: readonly boolean[];
  /** Row-major terrain classes, or undefined when the payload carried no terrain layer. */
  readonly #terrain: readonly TerrainKind[] | undefined;
  /** "x,y" string keys for O(1) warp-source lookup. */
  readonly #warps: ReadonlySet<string>;

  private constructor(
    zoneId: number,
    width: number,
    height: number,
    walkable: readonly boolean[],
    grass: readonly boolean[],
    warps: ReadonlySet<string>,
    terrain: readonly TerrainKind[] | undefined,
    landmarks: readonly Landmark[],
  ) {
    this.zoneId = zoneId;
    this.width = width;
    this.height = height;
    this.#walkable = walkable;
    this.#grass = grass;
    this.#warps = warps;
    this.#terrain = terrain;
    this.landmarks = landmarks;
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
    // The terrain layer (wap-1): absent ⟹ no terrain (the renderer's flat fallback;
    // never re-derived from walkable/grass). Present ⟹ the same width*height grid
    // and every name one of the ten wire names, copied so the caller's array
    // cannot change the map afterwards.
    let terrain: readonly TerrainKind[] | undefined;
    if (raw.terrain !== undefined) {
      if (!Array.isArray(raw.terrain)) {
        throw new Error('render/map: terrain must be an array of wire names');
      }
      if (raw.terrain.length !== width * height) {
        throw new Error(
          `render/map: ragged grid — terrain.length ${raw.terrain.length} != ${width}*${height}`,
        );
      }
      // An index loop, not `.map`: a sparse array's holes must fail the name check.
      const names: TerrainKind[] = [];
      for (let i = 0; i < raw.terrain.length; i++) {
        const name: unknown = raw.terrain[i];
        if (!isTerrainKind(name)) {
          throw new Error(`render/map: unknown terrain ${JSON.stringify(name)} at index ${i}`);
        }
        names.push(name);
      }
      terrain = names;
    }
    // Landmarks (wap-1): absent ⟹ none; a malformed entry, an unknown kind or an
    // off-grid / non-integer tile is rejected, never dropped or clamped.
    let landmarks: readonly Landmark[] = Object.freeze([]);
    if (raw.landmarks !== undefined) {
      if (!Array.isArray(raw.landmarks)) {
        throw new Error('render/map: landmarks must be an array');
      }
      landmarks = Object.freeze(
        raw.landmarks.map((l: unknown, i) => {
          if (typeof l !== 'object' || l === null) {
            throw new Error(`render/map: invalid landmark at index ${i} — not an object`);
          }
          const { kind, x, y } = l as { kind?: unknown; x?: unknown; y?: unknown };
          if (kind !== 'heal') {
            throw new Error(
              `render/map: unknown landmark kind ${JSON.stringify(kind)} at index ${i}`,
            );
          }
          if (typeof x !== 'number' || typeof y !== 'number' || !inGrid(x, y, width, height)) {
            throw new Error(
              `render/map: invalid landmark at index ${i} — (${String(x)},${String(y)}) is not an integer tile inside ${width}x${height}`,
            );
          }
          return Object.freeze({ kind: 'heal' as const, x, y });
        }),
      );
    }
    return new TileMap(zone_id, width, height, walkable, grass, warpSet, terrain, landmarks);
  }

  /** Integer tile inside the grid (a fractional coordinate is never a tile). */
  inBounds(x: number, y: number): boolean {
    return inGrid(x, y, this.width, this.height);
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

  /** The tile's terrain class (game-core `TileMap::terrain_at`), or undefined when
   *  (x, y) is out of range, not an integer tile, or the payload carried no
   *  terrain layer. Never derived from `isWalkable`/`isGrass`. */
  terrainAt(x: number, y: number): TerrainKind | undefined {
    if (this.#terrain === undefined || !this.inBounds(x, y)) return undefined;
    return this.#terrain[y * this.width + x];
  }

  /** True iff (x, y) is declared as a warp SOURCE tile in this zone.
   *  Out-of-range is false, never an exception (mirrors the bounds-safe pattern).
   *  Note: `to_tile` (the landing spot) is in a DIFFERENT zone and is never a
   *  warp source here. */
  isWarp(x: number, y: number): boolean {
    return this.#warps.has(`${x},${y}`);
  }
}
