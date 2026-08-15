# 0152 — Predictor epoch guard & send-seq floor (nh3: M-postgate-netcode-hardening)

**Status:** Accepted
**Date:** 2026-07-25
**Slice:** nh3 (M-postgate-netcode-hardening — predictor generation guard + send-seq floor to close the ptc5f/ADR-0142 accepted-risk window; EARS nh3-1/2/3)
**Supersedes:** —
**Amends:** 0085
**Amended-by:** ADR-0192
**Subsystems:** movement-netcode, client-ui
**Decision:** Ship BOTH: branded-epoch guard on dropRejected (closes M1, cross-generation eviction) and the lastSentSeq→seedSeq floor on rebuild (closes M2, the re-issued "stale seq" rejection). The ADR-0085 window closes only with both.

## Context

The 2026-07-24 ptc5f review (Decision E, ADR-0142) recorded an accepted risk across an own-zone warp: a pre-warp `enqueue_move` rejection can settle AFTER the rebuild (synchronously on a live socket, unlike reconnect's ≥1 s gap), colliding with a fresh op's seq and evicting it. Root cause analysis revealed TWO failure arms, not one:

- **Case M1 — stale rejection of the DEAD predictor's op.** Pre-warp `seq=5` is REJECTED (e.g., queue-full → txn rollback). Post-rebuild, reconcile seeds `#nextSeq=4`; a fresh keydown issues colliding `seq=5` (server ACCEPTS: 5>4). The old rejection then settles → `dropRejected(5)` evicts the NEW, server-accepted op → under-count → outstandingSteps gate opens early → extra emission → overshoot. The epoch guard makes this a no-op: the captured generation never matches the fresh instance.

- **Case M2 — the NEW op's OWN "stale seq" rejection.** Pre-warp op (`seq=5`) is ACCEPTED first (FIFO) → `last_input_seq=5`. Post-rebuild colliding op (`seq=5`) is REJECTED as stale. The rejection carries the NEW epoch — the guard correctly passes (mechanical, not a false negative), eviction is contractually correct, and the player's first post-warp move is swallowed anyway. **This is the exact solo-trigger sentence quoted in ADR-0085's ptc5f amendment.** No rejection-side guard can fix it — the defect is upstream: the fresh predictor re-ISSUED a seq the server must reject. The send-seq floor removes the collision: `lastSentSeq` is captured at every send, and `resetPredictionState()` calls `seedSeq(lastSentSeq)`, so the rebuilt predictor's first seq is always `> ` every seq ever sent.

**The accepted-risk window closes only with BOTH shipped.** Epoch guard alone leaves M2 open (player loses first post-warp move, deterministic). Send-seq floor alone leaves M1 open (pre-existing dead-predictor retention on never-settling promises, rare post-nh2 but unguarded). The specification (nh3-1: "SHALL carry an epoch/generation identifier") names only the guard; the floor is the red-team finding that reshapes the slice (reviewer B2-2, planner-concurring).

## Design

### D1 — Explicit epoch, branded for compiler enforcement

- **PredictorEpoch type.** `export type PredictorEpoch = number & { readonly __brand: unique symbol }` — a nominal type (branded number). Passing a bare number where an epoch is required is a compile error; the self-approving call `dropRejected(seq, seq)` is unwriteable at any call site without an explicit cast. Tests are excluded from typecheck (`client/tsconfig.json` excludes `**/*.test.ts`), so the brand costs zero test casts; it is the ONLY mechanism that makes the signature requirement enforceable.

- **Class-static counter & constructor mint.** `static #nextEpoch = 0` on `Predictor`, pre-incremented at construction (`this.#epoch = ++Predictor.#nextEpoch as PredictorEpoch`). The first epoch is 1 (a literal 0 never matches any instance), and the single `as PredictorEpoch` cast in the codebase lives at this site. Constructor-assigned ONCE — `#record` never re-reads the static counter (an N5 pin: per-record reads would stamp intents with drifting generations if another instance is constructed mid-sequence).

- **IntentToSend.epoch & dropRejected signature.** `IntentToSend` gains `readonly epoch: PredictorEpoch`; `#record` stamps `this.#epoch` onto every issued intent. `dropRejected(seq: number, epoch: PredictorEpoch): boolean` — the `epoch` parameter is REQUIRED (no default), and the mismatch guard is the FIRST statement: `if (epoch !== this.#epoch) return false;`. A foreign epoch is a total no-op (returns `false`, mutates nothing), because the rejection was addressed to a dead instance's op, and touching `#pending` would evict a live op purely by seq collision.

- **No public epoch getter.** The live epoch is readable only from an issued intent. A future tooth ("empty predictor returns false for any epoch") requires enqueueing a probe first to obtain an intent. This prevents a vacuous self-approve pattern and makes the mechanism's intent-based discipline structural (accepted caveat recorded in the ADR).

- **Send-seq floor in main.ts.** Module-scope `let lastSentSeq = 0;` (initialized to 0, which is never a valid seq — they start at 1). At the single send site (`main.ts:455-489`), after `enqueue` succeeds: `lastSentSeq = seq;`. In `resetPredictionState()` (line ~285), after constructing the fresh predictor: `predictor.seedSeq(lastSentSeq);`. Captures only primitives (the `seq` const), never the intent or predictor objects, to avoid retention on never-settling promises. The `seedSeq` API is existing (ADR-0012), monotonic-raise only, and server-safe (stale-seq guard is monotonic-not-consecutive, ADR-0085 SDK evidence; gaps are legal).

### Alternatives considered

- **D2 — send-time instance capture.** Capture the predictor itself in the `.catch` closure. Rejected: correctness in a coverage-excluded shell (main.ts is excluded); no compiler enforcement; dead-predictor object retention across socket drops (the promise never settles); contradicts A2's letter (the comment says "capture only primitives").

- **D3 — Symbol() brand instead of branded number.** `type PredictorEpoch = symbol` or a `Predictor` UUID. Rejected: structurally immune to module-instance assumptions (D1's F9 caveat) but non-loggable (symbols don't stringify for debugging). Branded number + recorded assumption chosen instead.

- **D4 — self-rejecting intent handle.** Make `IntentToSend` an opaque handle whose type prevents re-issue from a different predictor. Rejected: behavior on a marshaled value type; retention of the intent object across drops.

- **D5 — module-scope seq space.** Move `#nextSeq` to module scope so instances never share seq space. Rejected: mutable module-global state in the headless, deterministic prediction core; makes every absolute-seq assertion in the 2,600-line pinned suite order-dependent forever (permanent maintainability regression); does not implement the spec's named mechanism (nh3-1 says "epoch/generation identifier", not "dedicated seq space").

- **D6 — `dropRejected(intent: IntentToSend)` single param.** Viable and compiler-forced (no epoch mismatch possible). Not chosen: `(seq, epoch)` matches the spec's own language ("the comparison lives inside dropRejected") and keeps the eviction API primitive-in, so call sites are simple and the epoch is a captured variable, not an object.

- **Floor-only without the guard.** Rejected: leaves the eviction seam discipline-guarded only by a comment at `#record`. A future send site that forgets the floor re-opens M1 silently, with zero mechanical backstop. Belt-and-suspenders precedent (ptc5b): both gates ship.

- **Guard-only without the floor.** Rejected per the case split: leaves M2 open (player's first post-warp move is swallowed, deterministic and observable).

## Consequences

**Positive.**

- The two failure arms (M1 and M2) are closed by distinct mechanical mechanisms: the guard handles the cross-generation eviction hazard (now a structural type error to misapply); the floor removes the post-rebuild seq collision itself. Both are deterministic and have no false-positive rate (a legit op behind a mismatched epoch returns `false` — no forced reconcile owed, nothing was removed).

- The ADR-0085 accepted-risk window closes in full, and the ptc5f reachability bound is satisfied.

- Smoothness: the legit op correctly stays pending (the guard doesn't suppress same-epoch rejections). The nh2 `outstandingSteps` gate stays shut for the standard one-round-trip window (≤ ack-latency), matching the `2·oneWayLatency` term ADR-0148 already accepts. This corrects a premature-open bug (the wrongful eviction under-counted), it does not add a new stutter class.

- Compiler enforcement: `PredictorEpoch` is a brand, so the optional-param and self-approve mutants are killed at typecheck, and the 1-arg call-site revert is caught by the type signature.

**Negative / residual.**

1. **⚠ outstandingSteps fresh-instance under-count (OPEN, NOT fixed by nh3).** A fresh `Predictor` starts with `#lastAuthQueueLen = 0` while the server may still owe a queued step, so exactly one extra continuation can slip through per rebuild (predictors built post-warp or post-reconnect). nh3 closed the other two rebuild hazards (cross-generation eviction and seq collision), but not this under-count. Its window is near-zero for a DIFFERENT reason per rebuild path:
   - **On a zone warp:** the rebuild is followed in the SAME microtask flush by a reconcile (the warp's own row burst → MicrotaskBatcher → `reconcileFromStore`), which rewrites `#lastAuthQueueLen` from the authoritative queue — so the under-count is corrected before the next frame can emit a continuation.
   - **On a reconnect:** the reconcile is deferred (the server's `on_disconnect` deleted the player/character rows, so `reconcileFromStore` early-returns until `joinGame` round-trips). The guarantee rests on `held.clear()` ALONE — no held continuation survives the rebuild, so nothing emits into the gap. This makes `held.clear()` load-bearing: a future nh5 change to held-key retention across rebuilds must revisit this residual.

2. **Pre-existing:** if `switchZone` fails (bad content), `reconcileFromStore` early-returns forever until reload — nh2 gate frozen. Not nh3-caused; named for completeness.

3. **Pre-existing first-connection window:** before any `resetPredictionState()` (the server hasn't sent the first batch yet), a keypress sends a low seq that the server stale-rejects. Same-epoch, self-heals on the next reconcile — at most one swallowed keypress, M8.8e latency class, orthogonal to nh3.

4. **Held-key stop on warp (DETERMINISTIC FEEL DEFECT).** `resetPredictionState()` calls `held.clear()` (main.ts:287), so walking through a doorway while HOLDING a key stops the player dead until release+re-press. Deterministic, unrecorded, first-class "game fights me" feel defect — nh5 candidate. Also means the spec's/ADR's "warp while holding" trigger is not literal: both M1/M2 require a fresh post-warp keydown; reachability stands (re-press within RTT window), but e2e must not test a bare hold-through-warp.

5. **Parked nh3-e2e.** The e2e for this slice (script the two-arm case split with pre-warp rejection induction) must be written as `warp → release → re-press (+ induced pre-warp rejection)`. A literal "hold through warp" script is vacuous-green (the guard returns `false`, nothing happens, green). Natural home: `client/e2e/zoneSync.spec.ts`.

## Recorded assumptions

**Module-instance assumption (red-team F9).** The epoch counter is per-module-instance — a single incremented static in the predictor.ts module. Duplicate chunks, workers, or HMR re-evaluation would reset it. Not reachable today:
- Single entry point (`index.html`).
- No worker imports `predictor.ts` (workers would need their own predictor anyway).
- No `import.meta.hot.accept(...)` in `main.ts` → HMR does a full page reload, re-running the module.

If any of these change, the assumption breaks and the epoch counter's scope must be re-examined. Record, don't engineer around: a future agent evaluating HMR or worker patterns must see this caveat.

## Per-path invariant (desync-guard review finding)

A guarded no-op (`epoch !== this.#epoch`, returns `false`) means no forced reconcile is owed — nothing was removed, so the caller's contract is coherent. The live instance's own freshness guarantee DIFFERS per rebuild path:

**Zone warp path:** The rebuild IS followed in the same microtask flush by a reconcile. Evidence: `switchZone` updates `rawMap` → `Store` subscription fires → batch listener → `reconcileFromStore` (main.ts `onOwnWarp` listener before ingestChar's `batcher.schedule`; MicrotaskBatcher coalesces to one `flushBatch` per turn; `reconcileFromStore` then seeds and reconciles the fresh predictor). The fresh instance's `#lastAuthQueueLen` is rewritten from the authoritative queue in this same flush, closing residual #1.

**Reconnect path:** The rebuild is DEFERRED. Evidence: `onDisconnect` calls `store.reset()` (deletes player/character rows), then `scheduleRebuild()`. When the timer fires and builds the fresh connection, `joinGame` re-hydrates the player/character rows. The reconcile listener then fires (on the received row batch), but this is AFTER the rebuild — a different microtask turn. In the gap, held-key continuation is prevented ONLY by `held.clear()` (called in `resetPredictionState`, line 293). That makes `held.clear()` load-bearing for the reconnect arm. If a future change retains held-keys across rebuilds (to avoid the feel defect in residual #4), this invariant must be revisited — the gap is then unguarded.

**Spec-conformance note.** The specification (nh3-1) says "Predictor SHALL carry an epoch/generation identifier" and "a rejection .catch compares its captured epoch". The comparison lives inside `dropRejected` (the callee), not literally in the `.catch` — this is sanctioned by the spec's own §3 wording and follows the delegation pattern established by D1 (the epoch is a captured primitive passed to the guard method, not examined at the call site).

## Proof of teeth

Twelve mutations were hand-run live by the red-team; each is killed by a distinct tooth:

| Mutation | Killed by | Remarks |
|---|---|---|
| Delete the epoch guard (`if (epoch !== ...)`) | nh3-2 arm 2 (N3, N4) | Legit op survives with guard; fails without |
| Flip `!==` → `===` | nh3-2 arm 4 (N2), single-epoch precision test | Same-epoch eviction still works; cross-epoch no-op fails |
| Relational `<` instead of `!==` | N4 (above-and-below foreign epochs) | Kills asymmetric guards |
| Optional/defaulted epoch param in predictor.ts | SIGNATURE source-scan (`predictor.test.ts`, declared separately) | Tests excluded from tsc; only source-scan finds this |
| `dropRejected(seq, seq)` call site in main.ts | `PredictorEpoch` brand → tsc error | Brand makes self-approve literally unwriteable |
| Constant epoch (`#epoch = 0`) | N1 (epoch distinctness property) | All instances get same epoch; test fails |
| Per-record epoch (re-read static counter in `#record`) | N5 (same-instance intent epoch consistency), N1 ordering | Intents from one instance drift; fast-check detects |
| Ignore `seq`, drop head of `#pending` | Precision tests at `:1342` region, fast-check property at `:1426` (explicit row) | Evicts wrong op; precision fails |
| Revert `main.ts:471` to 1-arg `dropRejected(seq)` | tsc (required param + type mismatch) | Brand enforcement |
| Remove `lastSentSeq = seq;` | Wiring tooth `W-NH3-FLOOR-SEND` | Floor mechanism breaks |
| Remove `seedSeq(lastSentSeq)` or misorder it | Wiring tooth `W-NH3-FLOOR-SEED` | Rebuilt predictor re-issues sent seq; N6 fails |
| Invent getter + self-approve mutant | tsc (dead variable), wiring tooth count identity, `W-NH3-DROP-GUARDED` count identity | Triple-killed: type system + usage pin + wiring |

All thirteen hand-mutations (including variants) were killed; no survivor.

## Considered alternatives (decision narrative)

The two-arm case split (red-team F2, reviewer B2 concurring) reshaped the slice from guard-only to guard+floor. The original plan proposed D5 (module-scope seq space) and was rejected in §0 of the spec with lens concurrence — it violates the deterministic-core discipline. Every other escape was probed: D2 (instance capture) fails on coverage-excluded main.ts; D3 (Symbol brand) is non-loggable; D4 (handle type) has retention hazards; D6 (single-param) is viable but less aligned with the spec's own language. The floor, uniquely, is a 3-line addition in a file the guard already touches (main.ts:454-465, 285-291), uses only existing public API, and requires zero test-file churn (tests construct predictors directly, never via main.ts).

## Amendment to ADR-0085

See the separate amendment section appended to ADR-0085 (`Amended-by` header updated to include ADR-0152).
