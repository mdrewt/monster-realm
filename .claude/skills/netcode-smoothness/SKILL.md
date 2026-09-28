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
   delay, and holds at the newest snapshot instead of extrapolating.
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
  browser input and warps.

## Red flags in a diff (reject)

Reconciling outside the per-transaction flush · per-tick position snapping on the local
avatar · rendering remotes at the head · predicting battle outcomes · unbounded
prediction · reading a wall clock or unseeded RNG in a rule · letting key-repeat
enqueue moves.

## Gotchas

- **Rubberbanding** → reconcile ran on a half-applied batch. **Avoid:** reconcile only
  after the coalesced flush.
- **Local avatar stutters** → position snapped per server tick. **Avoid:** the slide
  clock.
- **Remote players teleport** → rendered at the head. **Avoid:** the interpolation
  buffer.
- **Desync accelerates** → unbounded prediction. **Avoid:** the queue and pending caps.
- **One tap moves two tiles** → continuation fired before the hold threshold.
  **Avoid:** keep continuation behind `HOLD_COMMIT_MS`.
- v1 felt bad despite correct code; the cause was feel, not logic. Treat smoothness as
  its own tested property.
