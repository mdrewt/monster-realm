# M11b Plan — Server Warp Runtime

## Scope
server-module/src/movement.rs, content.rs, lib.rs · evals · docs/adr/0066 · ARCHITECTURE.md

## Files changed (~60 Rust lines + 2 evals)

### movement.rs
- Delete stub `zone_map()` (always returned zone_0())
- In `movement_tick`: load zone_maps + build map via `map_for`
- After `apply_state`: check `map.warp_at(next.pos)`, if Some → copy scalars (to_zone, to_tile.x/y) BEFORE moving row, override row.zone_id/tile_x/tile_y, clear move_queue, set action=Idle, update, continue
- Failures (load_zone_maps/map_for) → log + return Ok(()) (logged no-op, matches existing doctrine)

### content.rs
- In `sync_content_inner`: load zone_maps + call validate_zone_maps BEFORE zone_def upserts
- Log and return on failure (bad content never partially seeds)

### lib.rs
- Add `fn ensure_zone_schedules(ctx)`: idempotent, inserts schedule rows for zones without one
- `init`: replace hardcoded ZONE_0 schedule insert with ensure_zone_schedules(ctx)
- `sync_content`: call ensure_zone_schedules(ctx) after sync_content_inner

### ADR-0066
- Documents warp-in-tick pattern, Ok-on-failure doctrine, ensure_zone_schedules SSOT

### Evals
- zone-warp-server-runtime.eval.mjs: checks map_for/warp_at/validate_zone_maps/ensure_zone_schedules with teeth
- migration-smoke-test.eval.mjs: checks idempotence, zone_def upsert-not-delete, additive schedules

## Anti-patterns to avoid
- NO public warp reducer (warp is scheduler-only, ADR-0020)
- Load zone_maps ONCE per tick (before character loop), not per-character
- Warp branch: copy WarpDef scalars before moving row into update()
- ensure_zone_schedules: never delete existing schedule rows
- One update per character on warp tile (not two)

## M11c contract (frozen)
- character table schema unchanged (zone_id already exists)
- TileMap.warps Serialize ABI frozen (M11a)
- No new public reducers
