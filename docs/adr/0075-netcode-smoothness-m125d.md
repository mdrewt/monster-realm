# ADR-0075 — Netcode smoothness residuals (M12.5d)

**Status:** Accepted
**Date:** 2026-07-03
**Slice:** m12.5d
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, movement-netcode
**Decision:** Fix five netcode feel bugs: reduce INTERP_DELAY_STEPS to 1.0, add tile-center camera, snap-on-teleport on zone warp, and isolate the rAF frame-drain timer.
**Amended-by:** ADR-0090


**Status:** Accepted  
**Date:** 2026-07-03  
**Milestone:** M12.5d

## Context

Five feel bugs in the ADR-0013 netcode landed with M11c/M12c code:

1. **Hold/jump cycle (12.5d-1):** `INTERP_DELAY_STEPS = 1.5` with a 2-snapshot store depth
   causes a recurring stutter. At steady 200 ms server cadence: after the T+200 snapshot
   arrives, `renderTime = now − 300ms = T − 100ms` — before `prev.receivedAt = T`. The
   renderer holds at prev for 100 ms, then ramps. At T+400, `renderTime = T+100`, which is
   less than the new `prev.receivedAt = T+200`, triggering a visible snap back to 50%.

2. **Zone-teleport smear (12.5d-2):** `upsertCharacter` always carried `prev = existing.latest`,
   even on zone changes or multi-tile jumps. The interpolation buffer then lerped across
   the warp, visually smearing remote characters through walls.

3. **Reconcile masking snap signal (12.5d-3):** `reconcile()` called `drain(now)` internally
   (step 4), which updated `#lastDrainAt`. The frame-loop's subsequent `drain()` then saw a
   small delta (reconcile-to-frame, not last-frame-to-frame), so backgrounded-tab wake-ups
   never produced `snapped = true`.

4. **Camera tile-corner bias (12.5d-4):** `FollowCamera.offsetFor` used `playerTileX * TILE_PX`
   (top-left corner of tile) as the camera anchor, giving a half-tile visual bias. Characters
   render at tile centre; the camera should centre there too.

5. **GPU memory leak on zone switch (12.5d-5):** `WorldRenderer.#drawMap` called
   `this.#bg.removeChildren()` without `.destroy()` on the removed `Graphics` objects, leaking
   GPU resources on every zone transition. `connection.ts` was also calling
   `characterRowToStore()` twice on `onUpdate` — once to compare `zoneId`, once to ingest —
   wasting a conversion.

## Decision

**12.5d-1 — Fix delay to 1.0 × STEP_MS:**  
Change `INTERP_DELAY_STEPS` from `1.5` to `1.0`. With a 2-snapshot store, `renderTime = now − 200ms`
exactly reaches `prev.receivedAt` when the next snapshot arrives — smooth monotone alpha, no
hold/jump cycle. Deepening to 3 snapshots to preserve 1.5× was rejected: it adds storage cost and
latency for a behaviour already visible as incorrect at 200 ms cadence.

**12.5d-2 — Snap on zone change or tile delta > 1:**  
In `upsertCharacter`, set `prev = undefined` when:
- the incoming `row.zoneId !== existing.row.zoneId`, or
- `max(|Δx|, |Δy|) > 1`.

Adjacent (1-tile) moves carry `prev` normally for smooth interpolation.

**Assumption:** server-authoritative movement (both player and NPC) never advances any entity
more than 1 tile per tick. This holds for the current NPC wander model (single-tile steps from
`movement_tick`) but should be revisited if NPC wander radius or teleport-on-aggro ever produces
server-side multi-tile jumps — those would trigger this snap path, producing one frame of
position-pop instead of a smear. For players this is the correct semantic (warp); for NPCs it
is a visible but brief artifact.

**12.5d-3 — Separate frame-drain timer from reconcile drain:**  
Rename `#lastDrainAt` to `#lastFrameDrainAt` and extract the step-apply loop into a private
`#stepForward(now)` method. `reconcile()` step 4 calls `#stepForward` (does NOT update
`#lastFrameDrainAt`). Only `drain()` — the frame-loop entry point — reads and writes
`#lastFrameDrainAt`. ADR-0052 §B first-drain semantics preserved: `#lastFrameDrainAt = undefined`
on construction, first `drain()` never snaps.

**12.5d-4 — Tile-centre camera anchor:**  
Change `offsetFor` to use `(playerTileX + 0.5) * TILE_PX`. Add module-scope `let lastCamX/Y`
in `main.ts` (initialised to 0, reset in `resetPredictionState()`). Frame loop updates them when
`ownEntity !== undefined`; always passes `lastCamX/Y` to `renderer.render`, so the camera holds
its last valid position rather than snapping to (0, 0) when the own entity is temporarily unresolved.

**12.5d-5 — Destroy removed Graphics; inline warp scalar comparison:**  
In `#drawMap`, replace `this.#bg.removeChildren()` with:
```ts
for (const child of this.#bg.removeChildren()) child.destroy();
```
In `connection.ts onUpdate`, compare `zoneId` directly on the raw SDK rows without calling
`characterRowToStore()`. Remove the `isOwnZoneChange` import from `connection.ts` (the function
remains in `warpDetect.ts` for tests and future callers).

## Considered alternatives

**12.5d-1:** Deepening to a 3-snapshot buffer to restore 1.5× jitter headroom was rejected: it
adds storage cost and per-update latency without fixing the root cause (2-snapshot depth is the
correct pairing for 1.0×). Jitter headroom trade-off documented: 1.0× is the minimum viable delay
for a reliable connection; a jittery network may see 1-frame holds when a packet is even 1 ms
late. The 200 ms step rate provides generous slack before this is user-visible.

**12.5d-2:** A per-entity snap-whitelist (never snap NPCs) was rejected: the NPC movement model
uses single-tile server steps, so the `> 1` threshold already never triggers for normal NPC
walks. A whitelist would add complexity for a case that does not occur in practice today.

**12.5d-3:** Resetting `#lastFrameDrainAt` on reconnect (instead of isolating `#stepForward`)
was considered but rejected: it only fixes the reconnect path, not the background-tab case where
reconcile fires mid-session without a matching frame drain.

**12.5d-4:** Encapsulating `lastCamX/Y` in the `WorldRenderer` was considered but rejected:
the camera hold must survive the frame loop outside the renderer's scope (before `ownEntity`
resolves from the store); module-scope state in `main.ts` is the natural home for per-session
render state that precedes renderer init.

## Consequences

- Remote interpolation delay reduced from 300 ms to 200 ms — latency improvement; no smoothness
  regression at 200 ms server cadence (property-tested: monotone positions across 2 movement segments).
- Zone-crossing smear eliminated — remote characters snap cleanly on warp.
- Backgrounded-tab reconnect correctly produces `snapped = true` on the first frame drain after
  a gap of ≥ 4 × STEP_MS, triggering the jump-render path instead of animating a stale backlog.
- Camera visually centred on characters (half-tile correction) with hold on entity gap.
- GPU memory leak on zone switch closed; one `characterRowToStore()` call eliminated per update.
- Tests: 571 unit tests green; `renderResolver.test.ts` `now` adjusted from 400→300 to match new
  200 ms delay; `store.test.ts` property test updated to allow `prev = undefined` on large-delta.
