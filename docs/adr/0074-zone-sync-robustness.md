# ADR-0074: Client zone-sync robustness (M12.5c)

**Status:** accepted  
**Date:** 2026-07-03  
**Deciders:** Drew Teter  
**Milestone:** M12.5c  

## Context

The M11c warp implementation used an edge-triggered zone-switch: `connection.ts` detected own-character `onUpdate` events where `zoneId` changed and called the `onOwnWarp` callback in `main.ts`. This had four verified bugs:

1. **Reconnect-strand:** Server `on_disconnect` deletes the character; `joinGame` recreates it at zone 0. The client fires an `onInsert` (not `onUpdate`), so `onOwnWarp` never triggers. The client's `rawMap` stays at the old zone → own character invisible, camera at origin, prediction on the wrong map.

2. **Idle-remote strand:** The warp handler called `store.resetCharacters()`, clearing ALL characters from the store. The global subscription never re-inserts idle remotes (no `movement_tick` update for stationary entities) → permanently invisible until they move.

3. **Mutation-before-parse:** `renderer.setMap(rawMap)` called `TileMap.fromRaw()` (can throw) AFTER `set_active_zone()` and `rawMap =` mutations, leaving split-brain state on a bad zone map.

4. **rAF loop mortality:** `requestAnimationFrame(frame)` was the last line in `frame()` — a wasm/predictor throw killed the loop permanently. `predictor.reconcile()` was also outside the listener's try block, risking sibling listener starvation.

## Decision

### State-based zone sync (fixes 1 and subsumes 2, 3)

Replace the edge-triggered `onOwnWarp` path with a **state-based check** in the `onBatchApplied` reconcile listener:

```ts
if (own.row.zoneId !== rawMap.zone_id) {
  switchZone(own.row.zoneId);
}
// falls through — seeds the fresh predictor on the same batch so ownPredictedTile
// is non-null immediately after the zone switch (commit 8c18860). switchZone()
// calls resetPredictionState() internally, leaving #predicted undefined; the
// subsequent predictor.reconcile() call then performs a seeding reconcile which
// returns false (before === undefined → no divergence), so no spurious held-key
// re-issue fires on the zone-switch batch.
```

Every coherent server snapshot is now compared against the client's current zone. A character INSERTED at zone 0 after reconnect is caught on the first post-reconnect batch.

### Idempotent `switchZone` with renderer-first ordering (prevents double-switch and split-brain)

Extract the zone-switch body into a module-level `switchZone(newZoneId)` function:
- Guards `if (newZoneId === rawMap.zone_id) return` — idempotent, safe to call from both `onOwnWarp` and the reconcile listener.
- Mutation order (RT-SZ-01): `zone_map()` → `TileMap.fromRaw()` (parse-validate) → `renderer?.setMap()` (draw FIRST) → `set_active_zone()` → `rawMap = newRawMap` → `resetPredictionState()`. Drawing happens before committing zone state so a Pixi/GPU throw inside `setMap` leaves `rawMap.zone_id` and the WASM zone unchanged — the catch block's "keeping current zone" claim is true.
- Does **not** call `store.resetCharacters()` — the render filter (`currentZoneId` in `RenderResolver.resolve`) already excludes stale-zone characters. Idle remotes in the destination zone remain in the store and visible immediately.

Keep `onOwnWarp` as a lower-latency live-warp path (fires in the SDK `onUpdate` callback, before the batch). Since `switchZone` is idempotent, the reconcile listener's follow-up check is a no-op.

### rAF containment (fixes 4)

```ts
const frame = (): void => {
  try {
    // ... frame body
    renderer?.render(entities, ownX, ownY);
  } catch (err) {
    console.error('[frame] uncaught error', err);
  } finally {
    requestAnimationFrame(frame); // always re-arm
  }
};
```

`predictor.reconcile()` is now inside the outer try-catch in the reconcile listener, preventing listener starvation.

### `setRawMapZoneForTest` proof-of-teeth hook

Added to `window.__game()` for the e2e test (12.5c-5). Forces `rawMap = zone_map(zoneId)` without the zone-switch protocol, simulating "client stuck at zone 1 after disconnect". The reconcile listener then corrects it. Never used in production paths.

## Consequences

- **Reconnect-strand fixed:** Any disconnect scenario now resolves correctly on the first post-reconnect batch, regardless of which zone the player was in.
- **Idle remote visibility:** Idle remotes are always visible after a zone switch (no `resetCharacters()` call on zone transition).
- **rAF loop is resilient:** A single wasm throw no longer permanently halts rendering.
- **Zone-switch atomicity (RT-SZ-01):** `renderer?.setMap` is the first real side-effect; if it throws, `rawMap.zone_id` and the WASM zone remain unchanged. Gated by `client/src/net/switchZoneAtomicity.test.ts`.
- **Double-parse:** `TileMap.fromRaw` is called twice on a valid zone switch (once for pre-validation, once inside `renderer.setMap`). Performance impact is negligible for the small zone maps (10×7 tiles).
- **`renderer` at module scope:** Required for `switchZone` to call `renderer?.setMap()` without being inside `main()`. Assigned once during async init; `?.` guard is safe before init completes.
