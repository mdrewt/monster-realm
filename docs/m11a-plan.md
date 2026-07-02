# M11a Build Plan: Tiled→RON Importer + Multi-Zone Content (v2 — post-review)

**Slice:** M11a (feat/m11a-tiled-importer)  
**ADR reserved:** 0065 (warps-in-TileMap data shape decision)  
**Touches:** game-core/src/**, game-core/content/**, game-core/build.rs, evals/zone-id-append-only.eval.mjs (new), evals/baselines/zone-map-ids.json (new), ARCHITECTURE.md  
**Do NOT touch:** server-module/**, client/**, client-wasm/**, evals/run.mjs, Cargo.lock (no new deps), module_bindings/**

## Architecture decisions (post-review corrections)

**Module dependency direction (CRITICAL):** `world.rs → content.rs` (one-directional, clean). 
- `content.rs` defines `WarpDef`, `ZoneMapDef` + loaders only. No world.rs import.
- `world.rs` imports `WarpDef`, `ZoneMapDef`, `ZoneDef` from `content.rs`. Contains `validate_zone_maps`, `map_for`, `warp_at`, `build_grid` (private).
- `build_grid` stays private — no `pub(crate)` exposure needed.

## Sub-tasks (serial, single-crate game-core + evals)

### A. RON content types in `game-core/src/content.rs`
- Add `WarpDef { from: TilePos, to_zone: u32, to_tile: TilePos }` (Serialize + Deserialize; `from` is a valid Rust field name — serde/RON handle it correctly)
- Add `ZoneMapDef { zone_id: u32, rows: Vec<String>, warps: Vec<WarpDef> }` (Deserialize only; `#[serde(default)]` on warps)
- Add `parse_zone_maps(ron_str) -> Result<Vec<ZoneMapDef>, String>`, `parse_zone_maps_parts(parts) -> Result<Vec<ZoneMapDef>, String>`, `load_zone_maps() -> Result<Vec<ZoneMapDef>, String>` — exact clones of the zones trio (delegates to `parse_parts`)
- `validate_zone_maps` and `map_for` live in `world.rs` (see §B below)

### B. World module additions in `game-core/src/world.rs`
```
use crate::content::{WarpDef, ZoneMapDef, ZoneDef};
```
- Add `warps: Vec<WarpDef>` field to `TileMap` struct (WarpDef derives Serialize = warps flows through zone_map() wasm export intentionally for M11c; doc-comment this)
- Refactor `from_rows` body into `fn build_grid(zone_id: u32, rows: &[&str]) -> Result<TileMap, String>` (private; `warps: vec![]`). `from_rows` calls `build_grid` — existing signature unchanged.
- Add `TileMap::warp_at(&self, p: TilePos) -> Option<&WarpDef>` — bounds-safe (None for out-of-bounds; mirrors `is_walkable`)
- Add `pub fn map_for(zone_id: u32, zone_maps: &[ZoneMapDef]) -> Result<TileMap, String>`:
  - Convert rows: `zone_def.rows.iter().map(String::as_str).collect::<Vec<_>>()`
  - Error message MUST name the zone_id: `format!("no zone map for zone_id {zone_id}")`
  - Set `warps = zone_def.warps.clone()` after build_grid
- Add `pub fn validate_zone_maps(zone_maps: &[ZoneMapDef], zones: &[ZoneDef]) -> Result<(), String>`

### C. Content files
- Create `game-core/content/zone_maps/` directory (BEFORE editing build.rs, or build.rs panics)
- `game-core/content/zone_maps/000-core.ron`: Vec<ZoneMapDef> for zone 0 (EXACT `ZONE_0_ROWS` art — SSOT: zone_0() and map_for(0) must produce identical grids) + zone 1 (small bordered room ≤40×28), with warp 0→1 and return 1→0

### D. `validate_zone_maps` checks (deterministic order, one violation per fixture)
1. **Well-formedness:** rows build valid TileMap (calls build_grid, propagates Err with zone_id in msg)
2. **Unique zone_id** in zone_maps
3. **Every zone_id exists in zones registry**
4. **Dims ≤ ZoneDef bounds** (width/height ≤ zone registry dims)
5. **Warp source in-bounds + walkable** in its own map
6. **Warp to_zone in zones registry** (to_zone ∈ zone_ids)
6.5. **Warp to_zone has a ZoneMapDef entry** — Err if to_zone is valid zone but has no zone_map (names the missing zone_id)
7. **Warp to_tile walkable in target TileMap** (build target TileMap via build_grid)

### E. Tiled→RON importer binary
- `game-core/src/bin/tiled_import.rs`
- Pure fn: `pub fn parse_tiled_json(json: &str, zone_id: u32) -> Result<ZoneMapDef, String>` (std-only)
- **Std-only JSON parser scope (bounded):** minimal recursive-descent over `JsonValue { Null, Bool, Num(f64), Str(String), Arr(Vec<JsonValue>), Obj(Vec<(String,JsonValue)>) }`. Target subset: `{width, height, layers: [{type, name, data: [GID...]} | {type, name, objects: [{x, y, properties: [{name, value}...]}]}]}`. ~200-250 lines max.
- GID convention: 0=wall(#), 1=floor(.), 2=grass(~)
- Object layer "Warps": objects with `to_zone`, `to_x`, `to_y` int properties → WarpDef
- Fail loud: missing tile layer, data.len() != width*height, unknown GID, malformed JSON, empty layers
- Thin main: arg parsing + file I/O + `parse_tiled_json` call + RON output (no logic in main)

### F. build.rs: add "zone_maps" to REGISTRIES
- Must do AFTER step C creates the directory (or do in order C then F)
- `const REGISTRIES: &[&str] = &["zones", "species", "skills", "items", "encounters", "zone_maps"];`

### G. Eval + baseline
- `evals/zone-id-append-only.eval.mjs`:
  - Comment-strip before scanning (same transform as append-only-ids.eval.mjs)
  - Regex: `/\bzone_id\s*:\s*(\d+)/g` — matches `zone_id:` only, NOT `to_zone:`
  - Proof-of-teeth: (a) dropped id is flagged; (b) a string with `to_zone: 7` is NOT counted as an id
  - Baseline `[0, 1]`
- `evals/baselines/zone-map-ids.json`: `{"_comment": "...", "zone_maps": [0, 1]}`

### H. lib.rs exports
- `content`: add `ZoneMapDef, WarpDef, load_zone_maps, parse_zone_maps, validate_zone_maps` (NOTE: `validate_zone_maps` and `map_for` are in world.rs, not content.rs)
- `world`: add `map_for, validate_zone_maps`; `warp_at` is a method on `TileMap` (auto-exported)

### I. ADR-0065
- `docs/adr/0065-zone-map-warp-data-shape.md`: 
  - Decision: warps-in-TileMap as serialized list (not tile glyph, not side-table); `ZoneMapDef`/`WarpDef` in content.rs (data layer), `validate_zone_maps`/`map_for` in world.rs (rule layer); std-only Tiled importer; `validate_zone_maps` separate from `validate_content` (whose signature is externally fixed)
  - Consequences: WarpDef.warps serializes through zone_map() wasm export (M11c intentional ABI); M11b obligation = call `validate_zone_maps` in `sync_content`

### J. ARCHITECTURE.md
- Add `| zone_maps | \`content/zone_maps/*.ron\` | directory | (string-art tile rows + warp list; keyed by zone_id) |` row after zones
- 2-sentence note: Tiled→RON importer + validate_zone_maps

## Cross-boundary contracts (seams M11b/M11c will consume)
- `map_for(zone_id, zone_maps) -> Result<TileMap, String>` — M11b tick + M11c wasm export
- `warp_at(pos) -> Option<&WarpDef>` — M11b server tick warp detection
- `WarpDef { from, to_zone, to_tile }` — the data shape both slices consume
- **M11b obligation:** call `validate_zone_maps` inside `sync_content` (makes the gate production-live)

## Test coverage plan

**world.rs tests:**
- `map_for_zone_0_matches_zone_0_art` — grid walkable/grass parity
- `map_for_unknown_zone_errors` — Err contains "99" (zone id)
- `map_for_error_names_missing_zone_id` — `map_for(0, &[]).unwrap_err()` contains "0"
- `from_rows_still_produces_empty_warps` — backward compat guard
- `warp_at_returns_warp_on_source_tile` / `warp_at_none_on_plain_tile` / `warp_at_none_off_map`
- `map_for_zone_1_has_expected_warp` — embedded warp is detectable
- `tilemap_serialize_shape_has_warps_field` — serialized JSON contains "warps" key (ABI gate for M11c)
- proptest: `warp_at_is_bounds_safe` (never panics over arbitrary TilePos)

**content.rs tests:**
- `embedded_zone_maps_parse_and_validate` — smoke test (load_zone_maps + validate_zone_maps)
- `rejects_malformed_zone_map_ron`
- TEETH #1: ragged rows → validate_zone_maps Err
- TEETH #2: duplicate zone_id → Err
- TEETH #3: zone_id not in zones registry → Err
- TEETH #4: warp to_zone not in zones registry → Err
- TEETH #5: warp to_zone in zones but no ZoneMapDef → Err (check 6.5)
- TEETH #6: warp to_tile not walkable in target → Err
- TEETH #7: warp source not walkable → Err
- TEETH #8: map oversize vs registry dims → Err

**bin/tiled_import.rs tests:**
- `parse_tiled_minimal_tile_layer` — small Tiled JSON → correct rows
- `parse_tiled_reads_warp_object` — object layer → WarpDef
- `parse_tiled_rejects_ragged_data` / `_rejects_unknown_gid` / `_rejects_malformed_json` / `_rejects_missing_tile_layer`
- `parse_tiled_output_validates` — round-trip: parse_tiled_json → validate_zone_maps Ok

**eval:**
- zone-id-append-only.eval.mjs with proof-of-teeth as above

## Anti-patterns to avoid
1. No new dependencies (no serde_json in game-core Cargo.toml)
2. No regex/substring JSON hacks — use minimal recursive-descent parser (bounded ~200-250 lines)
3. No Deserialize on TileMap; no `pub(crate) build_grid`
4. No warp glyph in TileKind::from_char — warps are overlay list
5. Zone-0 RON rows must EXACTLY match ZONE_0_ROWS in world.rs (no dual SSOT)
6. Eval must comment-strip before scanning; proof-of-teeth for to_zone exclusion
7. validate_zone_maps in world.rs NOT content.rs (one-directional module dependency)
8. check 6.5: to_zone in zones but missing ZoneMapDef → explicit Err (not a silent pass)
