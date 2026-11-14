---
name: netcode-smoothness
description: Working on client prediction, reconciliation, movement, or rendering in the SpacetimeDB game — anything that could reintroduce v1's desync, stutter, skipping-ahead, or rubberbanding. Encodes the netcode decisions in docs/DECISIONS.md.
---

# Netcode smoothness (anti desync / stutter / skip / rubberband)

> The reasons live in `docs/DECISIONS.md` (bounded prediction, held keys, remote
> interpolation) and the mechanics in `ARCHITECTURE.md` ("Prediction and
> reconciliation", "Rendering"). This skill is the working summary; read those before
> changing the reconcile path.

## Spine (do not violate)

- **Rules live once in `game-core`; the server is authoritative.** The client
  predicts **movement only**, using the wasm `apply_move`. Battles are resolved by the
  server. There is no second rule implementation on the client.
- **Integer tiles and determinism.** Clocks and RNG are injected (`clippy.toml`
  enforces this in Rust). `apply_move` is total: an illegal move is a no-op bump,
  never an error or a desync.

## The four root-cause fixes (each maps to a v1 symptom)

1. **Rubberband ← reconciling a half-applied batch.** The SDK fires per-row callbacks
   only. `net/batch.ts` coalesces a transaction's rows in a microtask, the store
   flushes once, and `Predictor.reconcile` runs once on that consistent snapshot: drop
   acknowledged ops, rebuild from the server `move_queue` and replay pending queue
   ops, reset to authority, drain.
2. **Stutter ← snapping the own character to every tick.** The own character animates
   on `render/slideClock.ts`, keyed to target-tile changes and ignoring
   `move_started_at` (the server re-stamps it every tick).
3. **Remote skipping ← rendering at the head.** `render/interpolation.ts` renders
   remotes in the past between buffered snapshots, with an adaptive per-character
   delay, and holds at the newest snapshot. The one exception is a remote on a straight
   walk (its last two position changes are the same step, at most three steps apart,
   and it has not turned in place since): `render/renderResolver.ts` draws it on at
   most half a tile past its newest tile, toward a walkable tile, for at most three
   steps after its newest step, and then walks it back. The store adds a snapshot only
   when the tile changes, so the `Idle` row the server writes on an empty tick between
   steps is not drawn as a stop. A remote's drawn position moves toward its target at
   no more than one tile per step.
4. **Divergence blowups ← unbounded prediction.** The predictor refuses enqueues past
   `MOVE_QUEUE_CAP` and backs off at 16 unacknowledged ops. A long frame gap reports
   `snapped`, and a correction of more than one tile snaps instead of gliding
   (`render/renderResolver.ts`). No clock sync.

Also load-bearing: OS key-repeat never drives movement; continuation waits for
`HOLD_COMMIT_MS` (150 ms) and no outstanding steps (`prediction/heldKeys.ts`); a
predictor epoch makes stale rejections no-ops after a warp or reconnect; a warp keeps
the held-key stack.

## Checks

- `prediction-parity`, `movement-parity`, `js-path-parity` (evals): the native rule
  and the wasm build agree on the same integer inputs.
- `netcode-determinism`, `netcode-convergence` (evals over `sim-harness`): replay is
  a pure function of the seed, and clients converge under simulated latency, loss and
  reorder.
- Unit tests in `client/src/prediction/*.test.ts` and `client/src/render/*.test.ts`,
  including half-applied and out-of-order batch cases. A test for a reconcile change
  must fail if someone reconciles mid-batch.
- `just e2e` (`client/e2e/movement-input.spec.ts`, `zoneSync.spec.ts`) for real
  browser input and warps, and `client/e2e/remote-walk.spec.ts` for a remote walk as a
  second browser draws it, with the walker's connection delayed so that every step
  misses a tick.

## Red flags in a diff (reject)

Reconciling outside the per-transaction flush · per-tick position snapping on the local
avatar · rendering remotes at the head · drawing a remote past its newest tile without
the half-tile, window and walkability bounds · appending same-tile rows to the snapshot
ring ·
predicting battle outcomes · unbounded prediction · reading a wall clock or unseeded
RNG in a rule · letting key-repeat enqueue moves.

## Gotchas

- **Rubberbanding** → reconcile ran on a half-applied batch. **Avoid:** reconcile only
  after the coalesced flush.
- **Local avatar stutters** → position snapped per server tick. **Avoid:** the slide
  clock.
- **Remote players teleport** → rendered at the head. **Avoid:** the interpolation
  buffer.
- **Remote players pause on every tile** → same-tile `Idle` rows entered the snapshot
  ring, or the resolver was not given the zone's walkability. **Avoid:** keep the
  store's same-tile rule and pass `walkable` to `resolve`.
- **Desync accelerates** → unbounded prediction. **Avoid:** the queue and pending caps.
- **One tap moves two tiles** → continuation fired before the hold threshold.
  **Avoid:** keep continuation behind `HOLD_COMMIT_MS`.
- v1 felt bad despite correct code; the cause was feel, not logic. Treat smoothness as
  its own tested property.
