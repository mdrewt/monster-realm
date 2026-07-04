# 0067. Client zone warp — follow-camera, zone subscription, warp reconcile
- Status: accepted
- Date: 2026-07-02

## Context and problem statement

M11b landed server-authoritative zone warps: the movement tick atomically moves a character
from zone A to zone B when they step on a warp tile. The client must react to this event by
(1) detecting the zone change, (2) updating the active zone, (3) resetting the predictor to
the new authoritative position (ADR-0020), and (4) rendering the new zone's map via
`zone_map(zone_id)`. Additionally, authored zones can be larger than the initial constant map,
so the renderer needs a follow-camera centering on the player with off-screen culling.

Five problems to solve:
1. Client hardcodes `ZONE_ID = 0` — subscribed zone never changes after login.
2. `zone_map()` wasm export ignores `zone_id` and always returns `zone_0()`.
3. `apply_move()` wasm export hardcodes `zone_0()` — prediction uses wrong walkability after warp.
4. The renderer fits the entire map in the viewport (no scrolling) — breaks for large zones.
5. Warp event delivery: how does the client reliably detect the server's atomic zone_id change?

## Considered alternatives

**A. Full disconnect + reconnect on warp** — Close the TCP connection; SDK auto-reconnects,
re-running `onConnect` with the new `zone_id`. Pros: reuses 100% of the existing reconnect
path. Cons: TCP teardown adds ~1–2 s of blank screen; "reconnect-lite" framing in ADR-0020
implies something lighter.

**B. Filtered subscription + onDelete warp detection** — Subscribe to `character WHERE zone_id = N`;
detect warp when own entity appears in `onDelete`. Assumed: the deleted row carries the NEW
`zoneId` (N+1). Investigation shows SpacetimeDB 2.6 delivers the deleted row with the values
**as of the subscription view** — i.e., the OLD `zone_id` (N) since that is what matched the
filter. The detection predicate `deletedRow.zoneId !== N` would therefore always be false,
silently dropping all warp events. This option is **rejected** as architecturally unsound
given SpacetimeDB 2.6's filtered-subscription delete semantics.

**C (chosen). Global character subscription + onUpdate warp detection** — Subscribe to
`SELECT * FROM character` (no zone filter). Detect warp via the `character.onUpdate` callback
when `newRow.entityId === ownEntityId && newRow.zoneId !== oldRow.zoneId`. Client-side, the
renderer filters by `currentZoneId` so only the current zone's characters are visible. Pros:
detection is reliable (onUpdate always delivers both old and new values); no re-subscription
needed for warp events; no dual-subscription ghost problem. Cons: delivers all zones'
characters (all-zone fan-out), violating the spirit of ADR-0007's per-zone subscription goal.
For the 2-zone development world this is acceptable. A future milestone introduces proper
subscription-group cancellation once SpacetimeDB exposes it, at which point a
zone-filtered subscription + reliable update semantics can replace this approach.

## Decision outcome
- Chosen: Option C — global character subscription with `onUpdate`-based warp detection and
  client-side zone filtering in the renderer.

### Details

1. **Character subscription (global)**: Changed from `SELECT * FROM character WHERE zone_id = ${zoneId}`
   to `SELECT * FROM character`. The store holds all characters from all zones; the renderer
   skips characters whose `zoneId !== currentZoneId` (render-side filter). This satisfies the
   functional requirement (players see only their zone's characters) while avoiding filtered-
   subscription delta semantics entirely.

2. **Warp detection via `onUpdate`**: A new pure helper `isOwnZoneChange(oldRow, newRow, ownEntityId)`
   in `client/src/net/warpDetect.ts` returns `true` when the update is for the own entity and
   the zone_id changed. This is called from `character.onUpdate` in `connection.ts` and fires
   `opts.onOwnWarp(newRow.zoneId)`. The helper is unit-testable outside the SDK shell.

3. **Predictor + resolver reset** (ADR-0020 reconnect-lite path): Warp fires an `onOwnWarp`
   callback in `main.ts` that replicates the `onReconnect` reset body exactly. Both paths
   call a shared `resetPredictionState()` to prevent drift. The predictor re-seeds from the
   first `onBatchApplied` after the warp update delivers the own character's new position.

4. **Map reload**: `zone_map(newZoneId)` (updated wasm export) returns the zone's tile map.
   The warp handler is wrapped in try/catch; on error, it logs and keeps the current zone
   (no crash). `rawMap` is `let` (reassigned on warp); `renderer.setMap(newMap)` redraws
   the background without destroying the Pixi application.

5. **`zone_map()` wasm fix**: Now calls `game_core::map_for(zone_id, &load_zone_maps()?)`.
   An unknown `zone_id` surfaces as a JS Error (caught by the warp handler's try/catch).

6. **`apply_move()` wasm fix**: A module-level atomic `ACTIVE_ZONE_ID: u32` (default 0) is
   exposed via a new `set_active_zone(zone_id: u32)` wasm export. `apply_move` reads from it
   to call `map_for(ACTIVE_ZONE_ID, ...)`. This keeps the `ApplyMove` TypeScript signature
   unchanged (avoiding cascade changes to `Predictor`). `set_active_zone(newZoneId)` is called
   in the warp handler before creating the new `Predictor`.

7. **Follow-camera** (`render/camera.ts`): Pure class. `offsetFor(centerTileX, centerTileY,
   viewTilesW, viewTilesH, mapW, mapH)` returns the top-left camera offset in tile space,
   clamped to `[0, max(0, mapW - viewTilesW)]`. When the map is smaller than the viewport
   the offset is `(0, 0)` (top-left anchored; centering a small map is a deferred UX
   improvement). `WorldRenderer.render()` accepts the own entity's fractional position and
   applies the camera offset to `app.stage.position`. `resize()` now calls
   `app.renderer.resize(viewW, viewH)` (no stage scaling); the canvas tracks the viewport.

- Consequences:
  - The full character table is delivered to every client (2-zone world: negligible overhead).
  - Warp is detected reliably via `onUpdate`, not inferred from `onDelete` semantics.
  - A production future can add zone-filtered subscriptions with per-subscription cancellation.
  - `RawTileMap.warps` is added to the TS interface (the field is already serialized by the
    Rust TileMap per ADR-0065) so the type accurately reflects the wire contract.

## Cross-references
- ADR-0007 — per-zone subscription model (goal; deferred for character table in M11c)
- ADR-0012 — reconcile/snap on authoritative position change
- ADR-0013 — netcode smoothness (reconcile-snap, not rubberband)
- ADR-0014 — one-way data flow; renderer reads only resolved entities
- ADR-0020 — warp = server-authoritative teleport; reconnect-lite client path
- ADR-0065 — zone-map data shape (`WarpDef`, `ZoneMapDef`)
- ADR-0066 — server warp runtime (M11b)
