# 0148 — nh2: held-key continuation is gated on outstanding server work, and the frame loop drains before it re-issues

**Status:** Accepted
**Date:** 2026-07-25
**Slice:** nh2 (M-postgate-netcode-hardening — movement input responsiveness; EARS nh2-1, nh2-2, nh2-3)
**Supersedes:** —
**Amends:** —
**Amended-by:** 0158
**Subsystems:** client-ui, movement-netcode
**Decision:** Both held-key continuation emitters gate on a new pure `Predictor.outstandingSteps === 0`, and the rAF frame body drains before it re-issues. A not-emit fix: nothing is cancelled and no reducer is called.

## Context

Drew's 2026-07-25 closed playtest reported movement as "slippery" — a quick tap overshoots by a tile,
and releasing a key causes "a stutter then one more tile". The spec (`M-postgate-netcode-hardening`
§nh2) grounded this in the keyup handler (`client/src/main.ts:1070-1073`), which only calls
`held.release(dir)`, while `predictor.clearQueue()`/`setMove()` are never called from `main.ts` — so
up to `MOVE_QUEUE_CAP` (=2) already-queued steps drain after release.

Two read-only lenses re-derived the pipeline independently before any code was written — a static
reading and an adversarial one that built a throwaway simulation of the real `Predictor`,
`RenderResolver`, `HeldDirections`, `reissueDir` and `characterToPredictedBaseline` against a
line-by-line model of `enqueue_move`/`authorize_move`/`movement_tick`. **The measured mechanism is not
the one the spec assumed**, and the difference changes the fix:

1. **`#queue` is empty almost all the time, so "cancel the queue" cancels nothing.**
   `characterToPredictedBaseline` (`client/src/convert/convert.ts:100`) rebases `move_started_at` to
   `max(0, floor(now) − 2·stepMs)`, and `#stepForward`'s due-test is `move_started_at + stepMs <= now`
   (`client/src/prediction/predictor.ts:265`) with `maxApply = #queueCap`
   (`:260`). Every reconcile therefore drains the whole local queue immediately and leaves it empty.
   The over-travel lives in `#predicted` (already advanced) and in the *server's* queue, not in `#queue`.

2. **The real defect is the continuation trigger, and it is frame-rate-bound.** The rAF loop re-issues
   the held direction whenever `reissueDir(held.active(), predictor.lastQueuedDir)` is defined
   (`main.ts:2085`), i.e. whenever the local queue is empty — which, per (1), is ~2–16 ms after every
   send, because an accepted `enqueue_move` writes the character row (`server-module/src/movement.rs:128`)
   under this client's own global subscription (`client/src/net/connection.ts:524`). Measured emission
   during a sustained hold: **63.8 sends/s at 60 Hz** (5 accepted, 58.4 rejected), 142.6 at 144 Hz.
   A positive feedback loop amplifies it: reject → `dropRejected` → `reconcileFromStore()`
   (`main.ts:466`) → reconcile empties `#queue` → next frame re-issues. Disabling just that reconcile
   drops the rate to 10.4 sends/s.

3. **A second, pre-existing defect shares the mechanism.** Pressing from idle at localhost latency
   produces a **2-tile single-frame `snapTo` render jump** in **88% of press phases** at 60 Hz/1 ms
   (94% at 30 Hz): the echo reconcile drains +1 with no frame in between, then the same frame's ungated
   continuation is instantly due and drains +2, so `chebyshev(tile, #ownClock.target) = 2 >
   SNAP_DIVERGENCE_TILES` fires the snap (`client/src/render/renderResolver.ts:90-91`). It vanishes at
   ≥10 ms latency — i.e. it manifests only on the localhost setup ADR-0129 prescribes for the playtest,
   which is exactly where Drew met it.

## Decision

**A pure not-emit gate, plus a one-statement reorder.** No cancellation, no reducer call, no new state
machine.

**(D)** `Predictor` gains one datum and both continuation sites gate on it:

```
outstandingSteps = #lastAuthQueueLen  (the server's undrained move_queue as of the last reconcile)
                 + #pending.length    (ops sent but not yet seen acked)

gate: predictor.outstandingSteps === 0
```

applied as the leading conjunct of the existing overlay guards at the rAF frame loop
(`main.ts:2083`) **and** the reconcile-divergence re-issue (`main.ts:410`).

The two terms cannot double-count: `authorize_move` writes `player.last_input_seq` in the *same
transaction* as the queue push (`server-module/src/guards.rs:93-94`, `movement.rs:127-128`), and an
`Err` rolls the ack back (`guards.rs:87-92`), so anything in `authQueue` is already acked and is pruned
by reconcile's `seq > ackedSeq` filter (`predictor.ts:230`). Sampled every frame for 10 s at 1/25/100 ms
one-way latency, the gate **never** opened while the server still owed a step (846 samples, 0
under-counts). Over-counting is reachable via the `#queue`-clamp tail-drop (`predictor.ts:237`) and is
the safe direction — it keeps the gate shut.

**(R1)** In the rAF frame body, `predictor.drain(now)` moves **above** the re-issue block, so a
continuation emitted this frame cannot be drained in the same frame.

Measured, versus the unfixed baseline: sends/s **63.8 → 5.0**, `"queue full"` rejects **557 → 0** over
10 s, at unchanged **5.00 tiles/s** (nominal `1000/STEP_MS`); tap emissions collapse from a `{1..9}`
spread to `{1, 2}` over 200 press phases (never 0 — no swallowed tap, and every 2 is a hold that
genuinely spans a server tick); press-phase render teleports **88.0% → ~2.0%** at 60 Hz (6.0% at
30 Hz) from **the gate**, and that residual **→ 0.0%** from **R1** (0/2400 across 12 fps × latency
cells). The split matters: **R1 alone, without the gate, removes essentially none of the teleports** —
it closes the gate's remainder and the two must not be separated.

**Why a gate and not a cancel.** nh2-1 explicitly permits "cancel/**not-emit**". A not-emit mechanism
satisfies nh2-2 *by construction*: it never writes `#predicted`/`#queue`/`#pending`, so
`reconcileFromStore()` remains the single repair path and there is nothing to desync. Every
cancellation mechanism we could reach was measured to be worse (see Alternatives).

## Alternatives considered

- **Call `predictor.clearQueue()` + the existing `clear_queue` reducer on keyup** — the spec's own first
  Decision-hook option. **Rejected on measurement.** `clearQueue()` empties `#queue` but never touches
  `#predicted` (`predictor.ts:147-150`); the next reconcile resets `#predicted` to the authoritative
  baseline (`:239`) with an empty queue to drain, rolling prediction back up to 2 tiles, and
  `RenderResolver` then sees `chebyshev >= 2` and calls `snapTo`. Backward render jump by release phase:
  −0.08 / −1.00 / −1.17 / −1.42 / −1.75 tiles, `snapped = true` in **9 of 10** phases (control: 0.00 at
  every phase). With a second key held it is a 2-tile *diagonal* teleport. This is precisely the defect
  class ptc5g/ADR-0141 exists to suppress.
- **Clear locally only, without the reducer.** Worse, two ways. The `Clear` op is recorded in `#pending`
  with a seq the server will never ack, survives reconcile's prune forever, and `applyOp`
  (`predictor.ts:55-64`) replays it on every reconcile — permanently suppressing the authoritative queue
  until `#pending` reaches `#pendingCap` (16) and `enqueue` declines everything: a hard movement freeze.
  And the replay makes the backward snap fire at the first reconcile after keyup, **8 ms later**, before
  the server has even seen a clear.
- **"Cancel only the not-yet-sent queued entries"** — the spec's second Decision-hook option. **Vacuous:**
  there is no unsent bucket; `sendIntent` sends in the same statement sequence as `enqueue`
  (`main.ts:448-451`). Recorded here so the hook is closed with evidence rather than silence.
- **Gate on a lead time derived from `#predicted.move_started_at`.** Rejected: reconcile re-derives that
  field as `floor(now) − 2·stepMs + k·stepMs`, so it is ≤ 0 whenever fewer than 2 moves drained —
  exactly the idle→first-step case — and any lead ≥ 0 still permits the second tap emission. Measured, it
  collapses the flood but is frame-rate-fragile (a 16 ms lead leaks at 30/144/240 Hz) and leaves the
  press-teleport at 25/29 phases. `move_started_at` is not a phase clock.
- **`setMove` as a "responsive turn" on direction switch** (the unused `set_move` reducer,
  `movement.rs:134-141`). Discards a step already drained into `#predicted` → a 1-tile swerve: the same
  rollback family, smaller. Unnecessary — under the gate, hold-E+N then release-E goes from 106 rejects
  to 0 with `maxΔpredicted = 1` and no snaps. Parked.
- **`set_move` as the continuation op** (cap-safe, so zero rejects): all ~64 tx/s would then write and
  broadcast the character row to every subscriber, strictly worse for every other client than today's
  rejections, which write nothing.
- **A cadence/rate-limiter class in `main.ts`.** Open-loop, so it inherits the drift above; needs a second
  reset site; rAF quantization accumulates ~8 ms/step, losing a tick slot every ~2.5 s.
- **Fold the gate into `reissueDir(active, lastQueuedDir, outstandingSteps)`** so `tsc` enforces the
  wiring at both call sites. Attractive, and recommended as a follow-up — but a third required parameter
  enforces *presence*, not *correctness* (`reissueDir(a, b, 0)` compiles and reverts the fix), so a
  source-scan tooth of identical strength is required either way. It also touches
  `client/src/prediction/heldKeys.ts`, outside this slice's declared touch-set. Deferred to nh3, which
  already owns `predictor.ts`.

## Consequences

**Positive.** The `"queue full"` reject storm — 7,961 rejections in Drew's single session — goes to ~0.
The pre-existing press-from-idle teleport (88% of press phases at localhost latency) goes to 0. `#pending`
now sits near 1, deepening the ADR-0013.5 backpressure backstop. Per-reconcile predicted advance drops
from 2 to 1 on the continuation path, so ADR-0141's `snapTo` branch fires less, not more.

**⚠ Accepted trade — sustained walk speed is now bounded by `2·oneWayLatency + framePeriod < STEP_MS`.**
The gate reopens only when the client *observes* the server's drain, and the emit then waits for the
next animation frame — so **display refresh rate is a term in the budget, not just RTT**. Measured
cliff `(STEP_MS − framePeriod)/2`: ≈96 ms one-way at 144 Hz, ≈90 ms at 60 Hz, ≈83 ms at 30 Hz, ≈76 ms
at 24 Hz. Past it the rate degrades toward half (30 Hz / 90 ms → 3.5 tiles/s; 60 Hz / 100 ms → 2.5),
and because `movement_tick` sets `action = Idle` on an empty queue, a missed slot is a visible pause —
the own-avatar stutter ADR-0013 exists to prevent. Pre-nh2 this coupling did not exist: the flood kept
the server queue non-empty regardless of RTT or frame rate.

This is acceptable **only for the ADR-0129 local, single-tester, isolated-DB playtest model**
(latency ≈ 0–1 ms, where the budget holds down to ~5 FPS). It is pinned by a 3×3 frame-rate × latency
cross-product test, plus one test that deliberately pins the *degraded* 30 Hz/90 ms case so a future
improvement reds it and forces a decision. An earlier draft of this ADR claimed the safe bound was
"≤90 ms, independent of frame rate" — that was wrong, and wrong in the unsafe direction; it was
measured off a 60 Hz-only sweep at a phase-lucky frame offset. Allowing one outstanding step restores
full speed at 100–150 ms but costs the tap fix (tap travel 1 → 2 tiles), i.e. it un-fixes nh2-1 — so it
is the wrong default, not a free knob. **Any remote/hosted deployment needs a real lookahead or
adaptive bound first.** Flagged for Drew.

**⚠ Accepted risk — freeze onset moves from ~16 steps to 1 step.** If a reducer-rejection promise is
lost on a still-`connected` socket, the leaked `#pending` entry holds the gate shut and held-key walking
stops (measured: 0 tiles over 5 s while held, still wedged at 60 s). It is the *same* freeze mode
ADR-0085 already documents, with an earlier onset, and it is escapable: keydown is deliberately left
ungated, so a **physical release + re-press** emits, is accepted, raises `ackedSeq`, and reconcile's
`seq > ackedSeq` filter then prunes *every* stuck pending op at once (measured: full rate restored).
Note the escape requires a real release — OS auto-repeat does not provide it, because the keydown
handler early-returns on `e.repeat`. `linkFrozen()` and the reconnect rebuild also clear it, and
reachability is near-nil since a `.catch` normally fails to settle only on a socket drop, which triggers
reconnect → `resetPredictionState()` → fresh predictor. Counterweight: **today** the same leak causes a
silent persistent desync (the phantom op replays at every reconcile); under the gate it causes a visible
stop, which is the safer failure.

**The gate subsumes `reissueDir`'s duplicate-direction dedup at both call sites.** `outstandingSteps === 0`
implies `#pending` is empty, and every `#queue` growth path also records into `#pending`, so `#queue` is
provably empty whenever the gate is open and `lastQueuedDir` is always `undefined` there. This is why no
continuation can be silently swallowed by the dedup — but it also means the M8.6c dedup no longer
contributes defence-in-depth at these two sites, and the gate is the sole guard. That raises the value of
the parked `nh2-e2e` keyboard tooth from nice-to-have to the only thing that can catch a `main.ts`-level
revert (see Residuals).

**Spec corrections this work forces.** (a) `M-postgate-netcode-hardening.spec.md` §4 attributes the 7,961
rejects to key *release*; they occur during sustained holds and a keyup-only fix would not have reduced
them at all. (b) The Decision hook's premise that ADR-0090's EWMA "consumes the same predictor/queue
state" is false — `adaptiveInterpDelayMs` is strictly in the non-own branch of `RenderResolver.resolve`
(`renderResolver.ts:101-113`); the own character takes the `SlideClock` branch exclusively (`:74-93`).
ADR-0141 *is* in the blast radius; ADR-0090 is not. (c) The measured post-release overshoot is ~1.0–1.5
rendered tiles, not the "up to 2" the spec states.

**Two in-repo assertions encode a now-refuted premise** — that "the predictor is bounded to
`MOVE_QUEUE_CAP` … so legitimate play never floods the queue" (`sim-harness/src/lib.rs:222-226` and the
test `client/src/prediction/heldKeys.test.ts:556-589`). The local *queue* is bounded; the *send rate* was
not. Both are outside this slice's touch-set and are left for a follow-up.

**Residuals.** (1) **No automated test executes `main.ts`'s frame body** — the wiring is held by source
scans only, so a class of mutants survives the full suite plus `tsc` and `biome`: `if (true || gate …)`,
a trailing `|| <pred>` appended to the guard, a *second* ungated emitter added below the scanned region,
and a second `store.onBatchApplied` listener that re-issues ungated. One such mutant (hoisting the gate
into a `const` and OR-ing it with a "still held" term) was found by the red-team pass to keep all 1365
tests green while fully reverting the fix; the `W-NH2-GATE-WIRED` tooth was tightened to pin the gate as
the guard's leading conjunct, which kills that one — but the class is only closed by a keyboard-driven
Playwright tooth (`page.keyboard.down/up`), parked as `nh2-e2e`. (1b) A same-direction 2-tile teleport is
still reachable through the deliberately-ungated keydown path, because `KEY_DIR` maps two codes to each
direction (`ArrowRight` + `KeyD`) and `step(dir)` is not deduped against `held` — pre-existing, outside
this slice's touch-set, and filed with `nh2-e2e`. (2) The `now − 2·stepMs` rebase (`convert.ts:93-102`) is
the deeper root cause of §Context (1) and remains. (3) `predictor.setMove`/`clearQueue` stay as
deliberately-dead API, now forbidden at the call site by a regression-guard tooth — dead by decision, not
by oversight. (4) Server-side, `enqueue_move` has no rate limit and logs one `log::warn!` per rejection
(`guards.rs:16-18`); the gate reduces honest-client volume but does not bound a hostile one — reported
separately. (5) The measurements cited here come from an uncommitted simulation harness at `ee8bd0d`;
the load-bearing ones (emission-rate bound, latency budget) are committed as tests.
