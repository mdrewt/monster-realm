# 0066. Server warp runtime — in-tick warp detection, per-zone scheduling, zone-map validation
- Status: accepted
- Date: 2026-07-02

## Context and problem statement

M11a shipped `WarpDef`, `ZoneMapDef`, `load_zone_maps()`, `map_for()`, `warp_at()`, and
`validate_zone_maps()` in `game-core`. M11b wires these into the server's movement tick and
content-sync lifecycle so characters are authoritatively teleported when they step onto a warp
tile, multiple zones each get their own scheduler row, and malformed zone-map content is
rejected before any DB write.

Three problems to solve:
1. `movement_tick` used a M2 stub (`zone_map()` / `zone_0()`) instead of the real authored map.
2. The `init` lifecycle hard-coded a single schedule row for `ZONE_0`; new zones required manual intervention.
3. `sync_content_inner` did not validate zone-map content before writing zone rows to the DB.

## Considered alternatives
- Option A — Keep stub until M11c (client): defers warp resolution but leaves the hard-coded
  schedule and missing zone-map validation longer than necessary; publish/republish safety gap.
- Option B — Add a public `warp` reducer that clients call: violates ADR-0020 (warp must be
  server-authoritative, initiated by the movement scheduler, not by client RPC); creates a C1
  security surface where a client can request an unauthorized teleport.
- Option C (chosen) — Wire everything inside the existing scheduler path: `movement_tick` loads
  the zone map and resolves warps transparently; `ensure_zone_schedules` is a private idempotent
  helper called from `init` and `sync_content`; `validate_zone_maps` gates `sync_content_inner`.

## Decision outcome
- Chosen: Option C, because it satisfies all three problems without new public reducers and
  keeps the security surface unchanged.

### Details

1. **In-tick warp detection**: `movement_tick` loads zone maps via `load_zone_maps()` (embedded
   RON, bounded cost — one parse per tick per zone) and builds the zone's `TileMap` via
   `map_for`. After `apply_move`, `warp_at(next.pos)` detects warp tiles. Fires only on actual
   movement (`prev != next.pos`) — a character standing idle on a warp tile is not re-warped
   every tick (the `move_queue.is_empty()` early-exit handles that, but the guard makes the
   intent explicit). Players in active battles are NOT warped (battle guard, C1 security
   finding). Warp resets `move_queue` and sets `action = Idle`. One atomic DB write per
   character (no re-fetch). Content-load failures return `Ok(())` (logged no-op — a failing
   tick must not abort the scheduler).

2. **`validate_zone_maps` in `sync_content`**: `sync_content_inner` loads zone maps and
   validates them via `validate_zone_maps` BEFORE any `zone_def` upsert. Malformed warp
   targets (dangling zone reference, out-of-bounds tile) are caught at seed time, not at
   runtime. This extends the existing fail-fast validate-before-write pattern already used for
   species, skills, and encounters.

3. **Per-zone schedule management**: `ensure_zone_schedules(ctx)` is a private, non-reducer
   helper. On every call it (a) removes `MovementTickSchedule` rows for zones no longer in
   `zone_def` — orphaned rows would fire a `map_for` error on every tick, causing an unbounded
   log-flood — and (b) inserts rows for zones that do not yet have one. Idempotent; called from
   both `init` (initial boot) and `sync_content` (on republish). This replaces the hard-coded
   `ZONE_0` insert in `init`.

4. **Warp-tile departure semantics**: `warp_at(next.pos)` checks the **arrival** tile, not the
   character's current tile. A character already standing at a warp tile and moving away has
   `next.pos ≠ warp_source`, so no warp fires on departure. The `prev != next.pos` guard
   prevents triggering on bumps (where `apply_move` returns the same position). The combination
   means: warp fires on arrival at a warp tile from an adjacent tile, never on bumps or
   departures.

- Consequences:
  - M11c (client) receives `character.zone_id` changes as authoritative teleports and
    re-subscribes to the new zone's data.
  - No new public reducers — warp is scheduler-only (ADR-0020).
  - Content-load cost in `movement_tick` is bounded: `load_zone_maps()` parses embedded bytes
    (compile-time `include_str!`); this is acceptable per-tick overhead and may be cached in a
    future milestone if profiling shows it is hot.

## Cross-references
- ADR-0007 — per-zone tick scheduler
- ADR-0011 — server-paced movement
- ADR-0013 — atomic single DB write per character per tick
- ADR-0020 — warp = server-authoritative teleport, no client reducer
- ADR-0065 — zone-map data shape (`WarpDef`, `ZoneMapDef`, `TileMap`)
