# M11a Build Plan: Tiled→RON Importer + Multi-Zone Content

**Slice:** M11a (feat/m11a-tiled-importer)  
**ADR reserved:** 0065 (warps-in-TileMap data shape decision)  
**Touches:** game-core/src/**, game-core/content/**, game-core/build.rs, evals/zone-id-append-only.eval.mjs (new), evals/baselines/zone-map-ids.json (new), ARCHITECTURE.md  
**Do NOT touch:** server-module/**, client/**, client-wasm/**, evals/run.mjs, Cargo.lock (no new deps), module_bindings/**

## Sub-tasks (serial, single-crate game-core + evals)

### A. RON content types in `game-core/src/content.rs`
- Add `WarpDef { from: TilePos, to_zone: u32, to_tile: TilePos }` (Serialize + Deserialize)
- Add `ZoneMapDef { zone_id: u32, rows: Vec<String>, warps: Vec<WarpDef> }` (Deserialize; `#[serde(default)]` on warps)
- Add `parse_zone_maps(ron_str)`, `parse_zone_maps_parts(parts)`, `load_zone_maps()` — clones of the zones trio
- Add `validate_zone_maps(zone_maps, zones) -> Result<(),String>` (7 checks in deterministic order, see §D below)

### B. Warp support + `map_for` in `game-core/src/world.rs`
- Add `warps: Vec<crate::content::WarpDef>` field to `TileMap` struct
- Refactor `from_rows` body into private `build_grid` (warps set to empty); `from_rows` calls `build_grid`
- Add `warp_at(&self, p: TilePos) -> Option<&WarpDef>` — bounds-safe like `is_walkable`
- Add `pub fn map_for(zone_id: u32, zone_maps: &[ZoneMapDef]) -> Result<TileMap, String>`
- Keep `zone_0()` and `from_rows()` signatures exactly as-is (existing tests must pass)

### C. Content files
- `game-core/content/zone_maps/000-core.ron`: Vec<ZoneMapDef> for zone 0 (reuse ZONE_0_ROWS art) + zone 1 (small bordered room ≤40×28), with at least one warp 0→1 and 1→0

### D. `validate_zone_maps` checks (deterministic order)
1. Well-formedness: each ZoneMapDef.rows must build a valid TileMap (calls build_grid, propagates Err)
2. Unique zone_id across zone_maps
3. Every zone_id exists in zones registry
4. Map width/height ≤ matching ZoneDef dims
5. Warp source in-bounds + walkable in its own map
6. Warp to_zone exists in zones
7. Warp to_tile walkable in the target zone's TileMap

### E. Tiled→RON importer binary
- `game-core/src/bin/tiled_import.rs`
- Pure fn: `parse_tiled_json(json: &str, zone_id: u32) -> Result<ZoneMapDef, String>` (std-only)
- Minimal recursive-descent JSON parser (no serde_json dep)
- Tiled convention: GID 0=wall, 1=floor, 2=grass; object layer "Warps" with to_zone/to_x/to_y properties
- Thin main: args → file read → parse_tiled_json → ron output

### F. build.rs: add "zone_maps" to REGISTRIES constant

### G. Eval + baseline
- `evals/zone-id-append-only.eval.mjs`: scans `content/zone_maps/*.ron` for `\bzone_id\s*:\s*(\d+)/g` (NOT to_zone); baseline [0,1]
- `evals/baselines/zone-map-ids.json`: `{"zone_maps": [0, 1]}`

### H. lib.rs exports
- Re-export: ZoneMapDef, WarpDef, load_zone_maps, parse_zone_maps, validate_zone_maps, map_for

### I. ADR-0065
- `docs/adr/0065-zone-map-warp-data-shape.md`: decision = warps-in-TileMap as serialized list (not glyph, not side-table); validate_zone_maps separate validator; std-only importer

### J. ARCHITECTURE.md
- Minimal: add zone_maps row to content-layout table + 2-sentence importer note

## Cross-boundary contracts (seams M11b/M11c will consume)
- `map_for(zone_id, zone_maps) -> Result<TileMap, String>` — M11b tick + M11c wasm export
- `warp_at(pos) -> Option<&WarpDef>` — M11b tick
- **M11b obligation:** call `validate_zone_maps` inside `sync_content` (production gate)

## Anti-patterns to avoid
1. No new dependencies (no serde_json in game-core Cargo.toml)
2. No regex/substring JSON hacks — use small recursive-descent parser
3. No Deserialize on TileMap
4. No duplicate grid-parse loop (refactor to build_grid)
5. No warp glyph in TileKind::from_char — warps are overlay list
6. Eval must not count to_zone/coordinate fields as declared map ids
7. Proof-of-teeth for every validate_zone_maps check (ADR-0010)
