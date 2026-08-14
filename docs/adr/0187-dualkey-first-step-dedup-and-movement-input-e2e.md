# 0187 — dualkey first-step dedup + movement-input runtime e2e (mvi-e2e)

**Status:** Accepted
**Date:** 2026-08-14
**Slice:** 14r-e (M-postgate-fourteenth-review-residuals — ADR-0158 residuals 3+4)
**Supersedes:** —
**Amends:** 0158
**Subsystems:** movement-netcode, client-ui
**Decision:** Keydown's ungated first step is skipped iff the direction is already physically held via the other key code (new HeldDirections.isHeld membership query, pure not-emit), and a keyboard-driven Playwright e2e now executes main.ts's real frame body at runtime.

## Context

`KEY_DIR` binds two key codes to each direction (`ArrowRight`+`KeyD` → East, etc.). The keydown
handler fired `step(dir)` unconditionally, so pressing the second code while the direction was
already held via the first fired a second ungated first step — a same-direction double-move.
ADR-0148 disclosed this as residual 1b; ADR-0158 (which closed every other double-move path via
the hold-commit continuation gate) named it the SOLE remaining path (its residual 3) and sketched
this exact fix. ADR-0158 residual 4 separately recorded that no automated test executed main.ts's
frame body — the discrete-event sim proves the design and the W-teeth pin the wiring as source
text, but a class of mutants (a `|| true` folded into a continuation guard; a second ungated
emitter outside the scanned region) survived the entire suite. Both residuals close here.

## Decision

**(a) Dedup, pure not-emit.** `HeldDirections` gains `isHeld(dir): boolean` — membership in the
held stack (`#stack.some(e => e.dir === dir)`), deliberately NOT a stack-top (`active()`) check:
with East held via ArrowRight and North pressed on top, a KeyD press must still be recognized as
"East already held" (a stack-top equality check would wrongly re-emit — pinned by U-DK2 and the
S11 sim scenario). `press()` shares the same predicate, so a mutation that breaks `isHeld` also
breaks press-idempotence and reds the existing U-H3. The keydown becomes
`if (!held.isHeld(dir)) step(dir);` with `held.press(...)` unchanged — brace-less, so the
W-MVI-KEYDOWN-UNGATED needle stays contiguous. Nothing is cancelled and no predictor state is
written (the ADR-0148 not-emit discipline). The ADR-0148 F3 freeze-escape is preserved BY
CONSTRUCTION: the escape is a physical release+re-press, and `release()` evicts the direction, so
the re-press sees `isHeld === false` and emits. Every `held.clear()` site (overlay opens, blur,
prediction reset) likewise leaves the next keydown emitting exactly as before this change.

**(b) Runtime e2e + DEV observability counters.** `client/e2e/movement-input.spec.ts` drives
`page.keyboard.down/up` against the real rAF frame body (workers:1, real SpacetimeDB, DEV build).
Two module-scope counters are added to main.ts and exposed on the DEV-gated `__game()` snapshot:
`moveSendCount` (incremented beside `lastSentSeq = seq` — every intent actually issued to the
reducer) and `moveRejectCount` (first statement inside `noteMoveRejection`'s try — every rejection
callback, dropped or not). They exist because tile-position assertions alone cannot distinguish a
gated from an ungated continuation loop: ADR-0148 measured the reject storm at unchanged 5.00
tiles/s (the server's STEP_MS cadence paces acceptance, not client send rate), so only a
send-budget observable separates the two worlds at runtime.

Scenarios and the mutant class each kills at runtime:
- **A — single-code taps** (90 ms, retry ONLY on in-page-measured duration >140 ms; a
  within-budget tap with a wrong tile count fails immediately, never retries): exactly 1 tile per
  tap ⇒ kills `committedActive` → `active` reverts and `HOLD_COMMIT_MS` → 0.
- **B — dual-code overlap tap** (down code1, +55 ms down code2, up both ≤140 ms total): exactly
  1 tile ⇒ THE slice defect. Proof-of-teeth: RED against the pre-fix tree (2 tiles).
- **C — hold through overlay** (KeyB box toggle, which does not `held.clear()`): frozen while the
  overlay DOM is visible (T3 === T2), resumes after close (T4 > T3, proving `held` survived — the
  anti-vacuity arm) ⇒ kills the whole-gate `|| true` fold.
- **D — sustained 1 s hold**: ≥3 tiles travelled (anti-vacuity), `ΔmoveSendCount ≤ 12` (gated
  cadence ≈ 6; the narrow `outstandingSteps === 0 && true || !anyOverlayVisible()` mutant — which
  survives the source scans and scenarios A–C — floods to ~60+), `ΔmoveRejectCount === 0` (the
  healthy contract: a client that only sends when the server owes nothing is never queue-full
  rejected).

## Alternatives considered

- **Stack-top equality (`held.active() === dir`) instead of membership** — wrong for the
  second-direction-on-top interleave (above) and reds the ADR-0158 whole-file `held.active(` === 0
  tooth. Rejected.
- **Dedup inside `step()`/`sendIntent`** — gates the `__game().step()` e2e hook and the F3 escape
  by construction (ADR-0148 alternative F's failure mode). Rejected.
- **Hold-commit-gate the keydown itself** — 150 ms of added latency on every tap; ADR-0158
  alternative D's failure mode. Rejected.
- **Track held state per key CODE rather than per direction** — would also fix the keyup-by-dir
  asymmetry (see residuals) but is a redesign of `HeldDirections`' contract and every consumer;
  out of slice scope, recorded as the known shape if the asymmetry is ever promoted to a defect.
- **`tiles/s` overshoot as the scenario-D observable** — not viable; throughput is identical in
  both worlds (measured, ADR-0148). The send-budget counter is the minimal sufficient instrument.

## Consequences / residuals

1. Same-direction double-move paths are now closed end-to-end: continuation via ADR-0148/0158
   gates, first-step via this dedup, each with a runtime tooth.
2. **Runtime closure is proven for the rAF frame-body emitter only.** The reconcile-listener
   emitter (`diverged &&` branch) is exercised rarely in a smooth hold, so a mutant confined to
   that site is killed by the W-NH2/W-MVI source scans, not by this e2e — the un-killable-class
   closure claim is scoped accordingly. Forcing mid-hold divergence deterministically was judged
   not worth the flake budget.
3. **Keyup-by-dir asymmetry (pre-existing, unchanged):** holding ArrowRight+KeyD and releasing
   ONE code evicts East entirely (held state is per-direction), stopping continuation until
   re-press. Unchanged by this fix; recorded so it is not rediscovered as a regression.
4. movementSim's hand-maintained ClientModel now mirrors the deduped keydown (dedup behind a
   `dedupFirstStep` flag; the S10-twin runs it off to prove the scenario still bites). The model
   drift risk ADR-0158 residual 5 names is INCREASED by any wiring change; W-DK-KEYDOWN-DEDUPED
   is the binding between model and main.ts.
5. The counters are DEV-observability only (never read by production logic); `moveRejectCount`
   counts every rejection callback, deliberately broader than the `dropped`-only telemetry
   counter beside it.
6. The (150, 240) ms indeterminate tap band and every ADR-0158 budget are untouched.
7. ADR-0152 residual 1 (fresh-Predictor `outstandingSteps` under-count) — pinned by a tripwire
   unit test if the droppable last task landed; see the test file by that name, else still open.

## Proof of teeth

RED-first: scenario B fails (2 tiles ≠ 1) and scenario D fails (snapshot counters absent) against
the pre-fix tree; U-DK1..3 and the W-DK teeth fail before the implementation lands. Post-fix
bite-proofs (hand-applied single-file mutants, each must red its named tooth): whole-gate
`|| true` ⇒ C; narrow `&& true ||` ⇒ D (empirically executed against the real stack — the
sim-derived storm numbers were not trusted on their own); second ungated emitter below the
scanned region ⇒ D; dedup revert ⇒ B; `active()===` shape ⇒ U-DK2 + S11 + W-DK-KEYDOWN-DEDUPED.
Executed results are recorded in the PR.
