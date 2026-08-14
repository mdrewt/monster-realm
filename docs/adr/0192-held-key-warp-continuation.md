# 0192 — Held-key warp continuation: the held stack survives the WARP arm's prediction rebuild (nh5)

**Status:** Accepted
**Date:** 2026-08-14
**Slice:** 13r-f (M-postgate thirteenth-review residuals §13r-f — the nh5 candidate named by ADR-0152 residual #4 and nh3-plan R6)
**Supersedes:** —
**Amends:** ADR-0152
**Subsystems:** movement-netcode, client-ui
**Decision:** `switchZone` captures the held stack (original press stamps) before `resetPredictionState()` and restores it after — warp arm ONLY; the reconnect arm and shared reset body stay byte-identical, keeping ADR-0152's guarantee.

## Context

ADR-0152 residual #4 recorded a deterministic feel defect: `resetPredictionState()` calls
`held.clear()`, so walking through a zone boundary while physically HOLDING a movement key
stops the player dead until release+re-press. The keydown handler ignores `e.repeat` and
`held.press` runs only on non-repeat keydown, so the OS never re-registers the still-down
key — the halt is unconditional at every boundary crossed mid-hold. Both ADR-0152 and
`docs/specs/nh3-plan.md` R6 disclosed it as the "nh5 candidate"; it was queued nowhere until
13r-f.

The constraint set comes from ADR-0152's **Per-path invariant** section, which this ADR
amends:

- **Warp path:** the prediction rebuild is followed in the SAME microtask flush by a
  reconcile — on the `onOwnWarp` entry the warp's row burst → MicrotaskBatcher →
  `reconcileFromStore` lands before any rAF frame; on the state-based entry
  `reconcileFromStore` itself calls `switchZone` and falls through to reconcile in the same
  call stack. The fresh predictor's `#lastAuthQueueLen` is rewritten from the authoritative
  queue before the next frame can emit a continuation (residual #1 closed by flush ordering).
- **Reconnect path:** the reconcile is DEFERRED (the server's `on_disconnect` deleted the
  player/character rows; `reconcileFromStore` early-returns until `joinGame` round-trips).
  In that gap, held-key continuation is prevented by `held.clear()` ALONE — it is
  load-bearing and MUST NOT change.

## Decision

1. **Pure seam in `heldKeys.ts`:** `HeldDirections` gains `snapshot(): HeldSnapshot` and
   `restore(snap: HeldSnapshot): void`, where `HeldSnapshot` is a readonly array of
   unexported `{dir, pressedAtMs}` entries. `snapshot()` copies entry objects out (aliasing
   the live stack is unwriteable by construction); `restore()` REPLACES the stack with
   copies of the snapshot entries, preserving original press stamps and stack order, and
   never re-stamps.
2. **Wiring in `switchZone` only**, bracketing the existing `resetPredictionState()` call
   (after the throwing map validation/commit calls):
   `const heldSnapshot = held.snapshot();` → `resetPredictionState();` →
   `held.restore(heldSnapshot);`. `resetPredictionState()`'s body and `onReconnect` remain
   byte-identical. `main.ts` never names the snapshot type (type inference), so the sealed
   single-import of `./prediction/heldKeys` is preserved.
3. **Original stamps are preserved deliberately** (ADR-0158): a hold already past
   `HOLD_COMMIT_MS` resumes continuation on the first post-warp frame with zero re-commit
   delay; a mid-tap hold (< threshold at warp time) stays uncommitted until the ORIGINAL
   press ages past the threshold — a warp is neither a free re-commit nor a fresh 150 ms
   halt.

## Amended ADR-0152 invariants (the named assumption this changes)

ADR-0152 stated "both M1/M2 require a fresh post-warp keydown" and (residual #1, warp arm)
"the under-count is corrected before the next frame can emit a continuation" — the latter
implicitly resting on BOTH flush ordering AND the held stack being empty post-rebuild. After
this change a continuation MAY emit on the first post-warp frame with no keydown. The
warp-arm closure of residual #1 now rests on flush ordering ALONE, which still holds:

- Both warp entry points produce a same-turn reconcile (same call stack on the state-based
  path; same microtask flush on the `onOwnWarp` path), and rAF frames are a separate task —
  no frame can interleave inside the flush. The reconcile-divergence re-issue emitter also
  runs after `predictor.reconcile` rewrote `#lastAuthQueueLen` in the same invocation.
- Even in the hypothetical pre-reconcile window, a preserved-hold continuation would be a
  LEGAL monotonic intent: `predictor.enqueue` is total and baseline-free, and the
  `seedSeq(lastSentSeq)` floor (ADR-0152 Case M2) guarantees the seq is fresh — the server
  applies it to the true post-warp position. No desync class is introduced.

**The reconnect arm is deliberately untouched** (ADR-0152: "held.clear() ALONE" guards the
deferred-reconcile gap), and a wiring tooth mechanically rejects any held-key capture,
restore, or other touch appearing in the `onReconnect` region.

## Accepted external dependency (recorded, unpinned)

The warp-path argument depends on `onOwnWarp` firing synchronously inside
`character.onUpdate` BEFORE `ingestChar` schedules the batcher (`client/src/net/connection.ts`
~:249-268). No test pins that ordering and `connection.ts` is outside this slice's touch
set. Follow-up flagged: a `connection.test.ts` ordering pin.

## Considered alternatives (rejected)

- **`preserveHeld` flag parameter on `resetPredictionState()`** — one flipped call site at
  the reconnect arm re-opens ADR-0152's unguarded gap; the wiring teeth pin the argless
  signature and call arity instead.
- **A `resetPredictionStatePreservingHold()` helper in main.ts** — same failure mode with a
  more attractive reuse surface for a future agent editing `onReconnect`.
- **A branded/opaque `HeldSnapshot` (à la `PredictorEpoch`)** — YAGNI: the fresh-stamp and
  wrong-argument mutants are already double-killed by the contiguous wiring needle and the
  seam-count tooth, and the sealed-import tooth prevents main.ts from importing a
  constructor/type anyway.
- **Merge semantics in `restore()`** — admits duplicate-dir entries (breaks the
  `isHeld`/order invariants) and makes restore non-idempotent. Replace is safe because
  capture and restore run in one synchronous block with no `await` — no keydown/keyup/blur
  can interleave (JS single-threading), so replace cannot resurrect a released key.

## Residuals / follow-ups

1. **Pre-existing, named-not-fixed:** `held.clear()` is the 4th statement in
   `resetPredictionState()`; a throw in `new Predictor`/`seedSeq`/`resolver.reset()` would
   skip it on the reconnect arm (no local try/catch at the `opts.onReconnect()` call site).
   Not introduced or worsened by this slice; fixing it means touching the shared body this
   slice is directed not to touch. Follow-up flagged.
2. **`predictor.ts` residual-note comment** (~:377-393) still says an nh5-style change
   "must revisit this residual" — the revisit is this ADR; the comment is now a stale
   pointer but `predictor.ts` is outside the touch set. Follow-up flagged.
3. **Parked e2e (now non-vacuous):** nh3 R7 declared a hold-through-warp e2e vacuous-green;
   with this fix it becomes meaningful. Sketch for a follow-up slice in
   `client/e2e/zoneSync.spec.ts`: focus the page, `keyboard.down('KeyD')`, walk east across
   the boundary, assert the own tile continues advancing in the destination zone with NO
   `keyboard.up`/re-press, then `keyboard.up`. Deterministic sim coverage (S12) plus the
   ADR-0187 movement-input e2e cover the mechanism today; e2e files are outside this
   slice's touch set.

## Proof of teeth

Gating tests: `heldKeys.test.ts` `[13r-f]` U-W1–U-W8 (unit/property),
`movementSim.test.ts` S12a–S12e (behavioral, both-policies modeling with a source
self-check binding 'preserve' to the production seam), `main.wiring.test.ts` W-NH5-* (4
wiring teeth incl. same-nesting-depth anti-dead-branch assertion). RED-first evidence and
the live mutation table (mutants (a)–(h), each killed by a named tooth) are recorded below.

<!-- TEETH-TABLE: filled at doc-close after the live mutation run (T6). -->
