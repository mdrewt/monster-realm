# 0065. Zone map + warp data shape (M11a)
- Status: accepted
- Date: 2026-07-02

## Context and problem statement

M11 introduces multi-zone content: tile maps loaded from RON files and warps that
teleport the player between zones. Three decisions needed to be pinned before
implementation:
1. Where does a warp live in the data model — as a tile glyph, a side-table, or
   an overlay list on `TileMap`?
2. Which module owns the types (`WarpDef`, `ZoneMapDef`) vs. the rules
   (`validate_zone_maps`, `map_for`)?
3. Should the Tiled→RON importer pull in `serde_json` or stay std-only?
4. Should `validate_zone_maps` be called from `validate_content` (server
   module) or left as a standalone gate?

## Considered alternatives

**Warp placement:**
- Option A — warp glyph (e.g. `'W'`) in the tile art; `TileKind` gains a `Warp`
  variant. Con: a single tile can only carry one destination; can't encode the
  target zone + coordinate in a char. Con: bleeds routing logic into the grid.
- Option B — side-table (separate `HashMap<TilePos, WarpDef>`) stored outside
  `TileMap`. Con: two structures must stay in sync; `zone_map()` wasm export
  would need to serialize them separately.
- **Option C (chosen)** — `pub warps: Vec<WarpDef>` on `TileMap`; no new glyph.
  Warp lookup is a linear scan over a small list (typical count ≤ 10). Serializes
  automatically through the existing `zone_map()` wasm export, giving M11c
  clients the warp list without extra work.

**Module ownership:**
- Option A — both types and rules in `content.rs`. Con: `content.rs` would need
  to import `world.rs` to build a `TileMap` for validation — circular dependency.
- **Option B (chosen)** — types (`WarpDef`, `ZoneMapDef`) in `content.rs` (data
  layer); rules (`validate_zone_maps`, `map_for`, private `build_grid`) in
  `world.rs` (rule layer). One-directional import: `world.rs → content.rs`.

**Tiled importer dependencies:**
- Option A — add `serde_json` to `game-core/Cargo.toml`. Con: violates the
  zero-new-deps constraint for game-core; serde_json is non-trivial.
- **Option B (chosen)** — std-only recursive-descent JSON parser (~250 lines)
  covering the bounded Tiled subset. No new Cargo.toml entries.

**validate_zone_maps call site:**
- Option A — called from `validate_content` (which has a fixed external
  signature). Con: `validate_content` would need `zone_maps: &[ZoneMapDef]`
  added, breaking all callers in server-module.
- **Option B (chosen)** — `validate_zone_maps` is a standalone public function;
  M11b's obligation is to call it inside `sync_content` when loading zone maps.

## Decision outcome

- Chosen: Option C for warps (overlay list on `TileMap`), Option B for module
  ownership (content.rs data / world.rs rules), Option B for importer (std-only),
  Option B for validate call site (standalone, called by M11b from `sync_content`).
- Consequences:
  - `WarpDef` derives `Serialize` — it flows through the `zone_map()` wasm export
    (M11c intentional ABI). M11c clients always receive the `warps` field.
  - `TileMap` gains `pub warps: Vec<WarpDef>` — the ABI gate test
    `tilemap_serialize_shape_has_warps_field` enforces the field survives
    serialization.
  - M11b obligation: call `validate_zone_maps(&zone_maps, &zones)` inside
    `sync_content` after loading both registries, making the gate production-live.
  - The std-only JSON parser covers only the Tiled subset needed; it is not a
    general-purpose JSON library and must not be extracted as one.
