# nh2 build plan (v2 — post plan-review) — released movement keys must not leave uncommitted steps queued

**Slice:** nh2 (`M-postgate-netcode-hardening`), HIGH / playtest-blocking · **ADR:** 0148 (supervisor-assigned)
**Base:** `master` @ `ee8bd0d` · **Branch:** `feat/nh2-release-cancels-queued-steps`
**Touch-set (declared):** `client/src/main.ts`, `client/src/prediction/predictor.ts` (+ sibling tests
`client/src/main.wiring.test.ts`, `client/src/prediction/predictor.test.ts`) + doc outputs.

> **v2 supersedes v1.** Three independent plan-review lenses (reviewer, red-team-with-measurements,
> `/simplify`) found one plan-completeness BLOCKER, one CRITICAL measured regression, one false
> invariant, one un-killable mutant class, and ~half the test plan as ceremony. Every change below is
> attributed. Where the lenses disagreed, the adjudication is stated.

---

## 1. Validated runtime model

Derived independently twice — a `planner` (static reading) and a `red-team` that built a throwaway
simulation of the real `Predictor`/`RenderResolver`/`HeldDirections`/`reissueDir`/
`characterToPredictedBaseline` against a line-by-line model of `enqueue_move`/`authorize_move`/
`movement_tick` (`/tmp/mrprobe`, outside the repo). **[measured]** marks a simulated result.

1. **The reconcile baseline defeats drain pacing.** `characterToPredictedBaseline`
   (`client/src/convert/convert.ts:100`) rebases `move_started_at` to `max(0, floor(now) − 2·stepMs)`.
   The `#stepForward` due-test is `move_started_at + stepMs <= now` (`predictor.ts:265`), so on
   **every** reconcile up to `#queueCap`(=2) queued moves drain immediately (`:242,:260`), and
   **reconcile always leaves `#queue` empty**. After a depth-0/1 reconcile `move_started_at` is left
   a full step or two in the past, so the *next* move enqueued is instantly due and drains on the
   same frame. *(Independently verified by the reviewer: both due-tests reduce to `floor(now) − stepMs
   <= now` and `floor(now) <= now`, trivially true; the only exception is `now < 2·stepMs`, the first
   200 ms of `performance.now()`, unreachable in practice.)*
2. **The continuation trigger is `#queue.length === 0` — that is the bug.** `reissueDir(held.active(),
   predictor.lastQueuedDir)` (`main.ts:2085`, `heldKeys.ts:45-50`, `predictor.ts:313-317`) re-issues
   whenever the local queue tail is not the held direction, i.e. whenever the queue is empty. Since
   (1) empties it on every batch, and an accepted `enqueue_move` **writes the character row**
   (`server-module/src/movement.rs:128`) under this client's own global subscription
   (`net/connection.ts:524`), dwell time is ~2–16 ms, **not ~200 ms**. Emission is therefore
   **frame-rate-bound**: **[measured]** 63.8 sends/s @60 Hz (5 accepted, 58.4 rejected), 142.6 @144 Hz,
   35 @30 Hz.
3. **A positive feedback loop amplifies it.** reject → `dropRejected` → `reconcileFromStore()`
   (`main.ts:466`) → reconcile empties `#queue` → next frame re-issues → reject → …
   **[measured]** disabling the rejection-reconcile alone drops 63.8 → 10.4 sends/s. ADR-0085's repair
   path is fighting ADR-0052's cap.
4. **Render lags `#predicted`.** `RenderResolver` keys the own `SlideClock` to the predicted *tile*
   (`renderResolver.ts:79-93`); `setTarget` glides origin→target over one `stepMs` regardless of
   distance (`slideClock.ts:42-58`). **[measured]** steady-state `predicted − render`: min 0.083,
   max 1.000, mean 0.549 tiles (a sawtooth).
5. **Actual post-release overshoot is ~1.0–1.5 rendered tiles, not 2.** **[measured]** worst rendered
   travel after keyup: 1.08 (1 ms latency) / 1.25 (25) / 1.50 (50) / 1.42 (100). The spec's "up to 2
   already-enqueued steps always play out" overstates the visible symptom.
6. **`clear_queue`/`set_move` reducers already exist and are unused** (`server-module/src/movement.rs:132-150`).
   `clear_queue`'s docstring is literally "Empty the queue (key release)". **No reducer change is
   needed — and none is wanted** (§2 rejects them on measured evidence).
7. **A second, pre-existing defect lives in the same mechanism (finding "S2").** Pressing from idle at
   localhost latency produces a **2-tile single-frame `snapTo` render jump**: the echo reconcile
   drains +1 with no frame in between, then the same frame's ungated continuation is instantly due and
   drains +2, so `chebyshev(tile, #ownClock.target) = 2 > SNAP_DIVERGENCE_TILES` fires the snap
   (`renderResolver.ts:90-91`). **[measured]** 88.0% of press phases @60 Hz/1 ms; 94.0% @30 Hz. This is
   very likely Drew's "stutter"/"slippery" report, and it is **latency-dependent** — 0% at ≥10 ms, i.e.
   it only manifests on the localhost playtest setup that ADR-0129 prescribes.

### 1a. Spec corrections this model forces (record in ADR-0148, hand to the supervisor)

- **`M-postgate-netcode-hardening.spec.md` §4 is wrong** where it says the 7,961 `"queue full"` rejects
  "are a byproduct of nh2" (of key *release*). They occur during **sustained holds**, are frame-rate-
  bound, and a keyup-only fix would not reduce them at all. The chosen design drives them to ~0
  (**[measured]** 557 → 0 over 10 s @60 Hz) — a larger payoff than the spec anticipated, and the
  model's falsifiable prediction for the next playtest.
- **The Decision-hook premise that ADR-0090's EWMA "consumes the same predictor/queue state" is false.**
  `adaptiveInterpDelayMs` is strictly in the non-own `else` branch of `RenderResolver.resolve`
  (`renderResolver.ts:101-113`) and reads `StoredCharacter`; the own character takes the `SlideClock`
  branch exclusively (`:74-93`). ADR-0141 *is* in the blast radius; ADR-0090 is not.
- **Two in-repo assertions encode the same false premise** ("the predictor is bounded to
  `MOVE_QUEUE_CAP` … so legitimate play never floods the queue"): `sim-harness/src/lib.rs:222-226` and
  the test `client/src/prediction/heldKeys.test.ts:556-589` (*"reissueDir dedup prevents queue/pending
  overload"*). The local *queue* is bounded; the *send rate* is not. Both are out of touch-set — note
  only, do not edit.

---

## 2. Decision — an authoritative outstanding-work gate, plus a drain/emit reorder

Two changes, both pure not-emit / pure ordering. **Nothing is cancelled and no reducer is called.**

**(D) The gate.** `Predictor` exposes one new datum; both held-key continuation sites gate on it:

```
outstandingSteps = #authQueueLen (server's undrained move_queue at the last reconcile)
                 + #pending.length (ops sent but not yet seen acked)
gate:  predictor.outstandingSteps === 0
```

The two terms **cannot double-count**: `authorize_move` writes the ack in the *same transaction* as the
queue push (`server-module/src/guards.rs:93-94`, `movement.rs:127-128`) and an `Err` rolls the ack back
(`guards.rs:87-92`), so anything in `authQueue` satisfies `seq <= ackedSeq` and is pruned by reconcile's
`seq > ackedSeq` filter (`predictor.ts:230`). **[measured]** over 846 frame samples at 1/25/100 ms:
`under-count = 0`, i.e. the gate never opens while the server still owes a step. Over-counting *is*
reachable (the `#queue`-clamp tail-drop at `predictor.ts:237` can yield 4 vs a real debt of 2) and is
the safe direction — it keeps the gate shut.

**(R1) Drain before continuation.** In the rAF frame body, `predictor.drain(now)` moves **above** the
held-key re-issue block, so a freshly-emitted continuation cannot be drained in the frame that emitted
it. *(Adopted from the red-team's measured repair — see §2a F2.)*

### Why (adjudicated against the review)

- **nh2-2 holds by construction.** The gate never writes `#predicted`/`#queue`/`#pending` and never
  calls a reducer; `reconcileFromStore()` remains the only repair path. A not-emit mechanism cannot
  desync — there is nothing to reconcile. (nh2-1 explicitly permits "cancel/**not-emit**".)
- **Closed loop, not open loop.** Emission is slaved to the server's own batch cadence, so it cannot
  drift. **[measured]** steady state: sends/s **63.8 → 5.1**, `"queue full"` rejects **557 → 0**, at
  unchanged **5.00 tiles/s** (nominal `1000/STEP_MS`).
- **Fixes the tap.** **[measured]** 200 press phases × 4 hold lengths: emission histogram `{1: 172,
  2: 28}` (baseline `{1:6, 2:12, 3:17, 4:41, 5:40, 6:35, 7:15, 8:21, 9:13}`); every 2-emission case is
  a hold that genuinely spans a server tick. **Never 0** — no swallowed tap at any phase or latency.
- **Fixes S2 completely, but only with R1.** **[measured]** 2-D sweep (press phase × rAF phase, 800
  samples/config): baseline 88.0% snaps @60 Hz/1 ms → gate alone **3.5%** → **gate + R1 0.0%**, at
  30/60/120/144 Hz. R1's measured cost is **zero** (5.00 tiles/s, 5.10 sends/s, 0 stalls, tap travel
  unchanged).
- **Zero new reset wiring.** State lives on `Predictor`, and `resetPredictionState()` already rebuilds
  it (`main.ts:284-285`), so warp/reconnect zeroes the gate for free. **[measured]** no post-warp
  emission burst (1 send in the 60 ms after warp vs 2 for the baseline).

### 2a. Findings adopted from the plan review

| # | Finding | Disposition |
|---|---|---|
| **F1** | **CRITICAL, measured:** the gate **halves walk speed above ~95 ms one-way latency** (5.00 → 2.52 tiles/s @100 ms, 400 ms stalls; cliff measured between 90 and 95 ms, predicted at `2L + frame ≥ STEP_MS`). The baseline's flood is *why* it holds 5.00 tiles/s at any RTT. | **ACCEPTED AS A TRADE, NOT FIXED.** The deployment model is ADR-0129's local isolated-DB single-tester playtest (L ≈ 0–1 ms), and full speed is measured at **1–90 ms**. Allowing 1 outstanding step restores 5.00 tiles/s at 100–150 ms but **loses the tap fix** (tap travel 1 → 2 tiles), i.e. it un-fixes nh2-1 — so it is the wrong default. Recorded in ADR-0148 Consequences with the measured cliff as a falsifiable prediction, pinned by **U7** (full speed at L ≤ 90 ms), and flagged to Drew in the PR. v1's claim "cannot drift / full walk speed" was **wrong** and is retracted. |
| **F2** | The gate alone leaves 3.5–7% of press phases snapping, because two drains can straddle a frame boundary with no frame between. **v1's T5 invariant (`Δpredicted ≤ 1 per frame`) was therefore FALSE**, and a hand-built T5 would have passed or failed on where the author happened to put frame boundaries. | **FIXED by R1** (§2). With R1 the invariant is true — **[measured]** 0/800 snaps and `maxΔpredicted = 1` at every fps × latency tested. U5 now mandates a deliberately **unaligned** frame clock; without that it is vacuous. |
| **F3** | **A new freeze mode.** One leaked reducer-rejection promise on a still-`connected` socket wedges `outstandingSteps ≥ 1` forever, stopping held-key movement dead (**[measured]** 6 tiles vs 44 baseline). v1's §5 asserted no new freeze mode — wrong. | **ACCEPTED + DOCUMENTED, not hidden.** Escape is measured and natural: **keydown is ungated**, so release + re-press emits, is accepted, raises `ackedSeq`, and prunes the leaked op via `predictor.ts:230`; `linkFrozen()` (`main.ts:447`) and the reconnect rebuild (`:284-285`) also clear it. Framing corrected per the reviewer: this is the *same* freeze mode with onset moved from ~16 steps (`#pendingCap`) to 1 step. Note the counterweight — **today** a leaked promise causes a *silent persistent desync* (the phantom op replays at every reconcile); under the gate it causes a *visible stop*, which is the safer failure. Recorded in ADR-0148 Consequences. |
| **F4** | Surviving mutants: **M-D** — `predictor.mayContinueHeld();` as a bare expression statement + unguarded emit — survived every source scan, `tsc`, and `biome recommended`, silently reverting the whole fix. Also M-A (`max` for the sum) and M-B (`min(len,1)`), both unobservable at the chosen threshold. | **M-D KILLED** by the shape change: the gate is now the property comparison `predictor.outstandingSteps === 0 &&`, pinned **contiguously** (whitespace-squashed, comment-stripped) by `W-NH2-GATE-WIRED` — a bare expression statement has no `&&` and reds. (A comparison as a bare statement is also not a plausible refactor artifact, unlike a discarded method call.) **M-A/M-B killed** by U1's `2 + 2 === 4` case. `if (true || …)` remains un-killable in-set — parked with the e2e tooth (§6). |
| **B1** | **Plan-completeness BLOCKER:** the edit reds two existing teeth. `W-RN-FANOUT-RAF` (`main.wiring.test.ts:753-769`) uses a **fixed 400-char backward window** before `predictor.drain(`, with only ~114 chars of headroom; `W-HELP-FANOUT-RAF` (`:1363-1379`) slices *forward* from `'Re-issue the held dir'` to the next `predictor.drain(`. **R1 flips that order, so both red regardless of size.** | **RE-ANCHOR, DO NOT WIDEN.** Both are re-anchored onto needle-bounded regions with the **same assertions** (`renameView?.visible` / `helpView?.visible` present in the rAF re-issue block). Widening `400 → 800` is explicitly forbidden — it would silently weaken two ADR-0133/ADR-0135 fan-out teeth, the exact fixed-window failure nh1's post-mortem records (`ARCHITECTURE.md:1143`). This is a **strict re-anchor, not a weakening**, and must be called out in the PR body for the verifier. |
| **M1** | Reviewer: fold the gate into `reissueDir(active, lastQueuedDir, outstandingSteps)` so `tsc` enforces the wiring at both call sites. | **REJECTED — smaller benefit than claimed, real cost.** A third required parameter enforces *presence*, not *correctness*: the mutant `reissueDir(a, b, 0)` compiles and reverts the fix, so a source-scan tooth of identical strength is still required either way. Cost is real: `client/src/prediction/heldKeys.ts` is a **production file outside the declared touch-set** and a sibling slice **is** inflight (`mr-state.json` `inflight: [nh2, B]`). *(Checked: B touches `game-core/content/*.ron` only, so there is no actual collision — the rejection rests on the benefit analysis, not on the rule.)* `/simplify` also opposed it. **Recorded in ADR-0148 as a recommended follow-up** for nh3, which already owns `predictor.ts`. |
| **S-1** | `/simplify`: at threshold 1, `sum < 1` **is** `both terms zero`, so `CONTINUATION_MAX_OUTSTANDING` is a knob whose only other setting is the bug, and the no-double-count proof is load-bearing for nothing. | **ADOPTED.** Constant deleted; the gate is the literal `predictor.outstandingSteps === 0`. `mayContinueHeld()` deleted — `Predictor` exposes only the **datum** `outstandingSteps`, matching its siblings `queueDepth`/`pendingCount`/`lastQueuedDir` and honoring the class's own contract ("does NOT … capture input", `predictor.ts:1-11`). v1's T2 (threshold pin) deleted with it. |
| **S-2** | `/simplify`: the `nh2-CONTINUATION-BEGIN/END` sentinels are test scaffolding in production source; **no existing tooth in the file uses a dedicated sentinel**, and all needed anchors are already unique. | **ADOPTED.** All 4 sentinel comments and `W-NH2-SENTINELS` deleted. Teeth anchor on real code/real explanatory comments, with an inline uniqueness assertion per anchor (which subsumes v1's separate `W-NH2-NOVACUITY`). |
| **S-3** | `/simplify`: do **not** extract a shared helper for the two sites — each block contains one `helpView?.visible`, and `main.wiring.test.ts:1281,1288-1296` pin live counts (19 / 20) that extraction would red. | **ADOPTED** — keep both sites inline. |
| **S-4 / M4 / F4** | v1's 10 unit + 7 source-scan teeth were ~2× right-sized (T6 fast-check purity is tautological, T7/T8 duplicates, T10 defends a design not being built, `W-NH2-GATE-COUNT`'s stated kill is logically impossible, `W-NH2-KEYUP-UNTOUCHED` subsumed) — while **three EARS obligations had no tooth at all**, T4's `=== K+1` bound is wrong (**[measured]** phase-dependent `K..K+1`), and `W-NH2-RECONCILE-GATE`'s ordering assertion would have **red-ed a correct implementation**. | **ADOPTED WHOLESALE** — see §4. Net: 9 unit + 3 new source-scan teeth + 2 re-anchors, with every previously-uncovered EARS obligation now covered. |
| **M2** | "≤1 frame cost" for gating the divergence site is wrong; when `outstanding ≥ 1` the rAF path is blocked too, so the bound is the next authoritative batch. | **CORRECTED** in §3. Independently, gating that site is **not optional**: **[measured]** gating only the rAF loop leaves S2 at 25/29 press phases — byte-identical to baseline — and gating both costs nothing user-visible (identical first-step-after-pullback distributions at 1/25/100 ms). |
| **m5** | v1's accessor doc ("how many more tiles would I travel?") is backwards — reconcile step 4 has already drained the auth entries into `#predicted`. | **CORRECTED**: `outstandingSteps` is *how far prediction is allowed to run ahead of authority* — how many steps **the server still owes**. |
| **m6, m4, S-5, m8, m7, n2** | Constant/cap relation; `#authQueueLen` naming + the "coherent snapshot" overclaim; unenforceable anti-pattern 11; the third false-premise site; measurement reproducibility; a fresh-predictor pin. | Constant deleted (m6 moot). Field named **`#lastAuthQueueLen`**, documented as "the value at the last reconcile", not as instantaneously coherent (m4). Anti-pattern 11 **dropped** — `authQueue` is a `readonly` parameter reconcile never reassigns, so placement provably cannot matter (S-5). m8 noted in §1a. m7: ADR-0148 records that the measurements come from an uncommitted harness at `ee8bd0d`; U6/U7 commit the load-bearing ones. n2 → **U9**. |

### Rejected alternatives (→ ADR-0148 §Alternatives)

- **A — `predictor.clearQueue()` + `conn.reducers.clearQueue(seq)` on keyup** (the spec's own first
  Decision-hook option). **Refuted with measurements.** `clearQueue()` empties `#queue` but never touches
  `#predicted` (`predictor.ts:147-150`); the next reconcile sets `#predicted = authBaseline` (`:239`)
  with an empty queue to drain, rolling predicted back up to 2 tiles; `RenderResolver` then sees
  `chebyshev ≥ 2` and calls `snapTo` (`renderResolver.ts:90-91`). **[measured]** backward render jump by
  release phase: −0.08 / −1.00 / −1.17 / −1.42 / −1.75 tiles, `snapped = true` in **9 of 10** phases;
  control (no clear) 0.00 at every phase. With a second key held it becomes a 2-tile **diagonal**
  teleport. Exactly the defect class ptc5g/ADR-0141 exists to suppress.
- **A′ — local-only `predictor.clearQueue()` (no reducer send).** Two independent failures. (i) The
  `Clear` op is recorded in `#pending` with a seq the server will never ack, survives reconcile's
  `seq > ackedSeq` prune forever, and `applyOp` (`:55-64`) replays it on every reconcile — permanently
  suppressing the authoritative queue until `#pending` hits `#pendingCap`(16) and `enqueue` declines
  everything: a **hard movement freeze**. (ii) **[measured]** the replay makes the backward snap fire at
  the first reconcile after keyup, **8 ms later, before the server has even seen a clear** — so "clear
  locally, it's safer" is strictly worse.
- **"Cancel only the not-yet-sent queued entries"** (the spec's second option) — **vacuous**: there is no
  unsent bucket; `sendIntent` sends in the same statement sequence as `enqueue` (`main.ts:448-451`).
  Recorded so the Decision hook is closed with evidence rather than silence.
- **B — an ε-lead gate on `#predicted.move_started_at + stepMs − now`.** Refuted twice. Analytically the
  quantity is ≤ 0 whenever fewer than 2 moves drained — precisely the idle→first-step case — so any
  `ε ≥ 0` still permits the second tap emission. **[measured]** it does collapse the flood (5.2 sends/s,
  0 rejects) but is frame-rate-fragile (ε=16 ms leaks at 30/144/240 Hz) and leaves S2 at 25/29.
  `move_started_at` is not a phase clock.
- **C — `setMove` "responsive turn" on direction switch.** Replaces `#queue` and records a `SetMove`
  op (`:142-145`), so the next reconcile discards a step already drained into `#predicted` → a 1-tile
  swerve. Same rollback family as A, smaller. Unnecessary: **[measured]** under the gate, hold-E+N then
  release-E goes from 106 rejects → **0**, `maxΔpredicted = 1`, 0 snaps. **Parked** (§6).
- **`set_move` as the continuation op** (cap-safe → zero rejects): all ~64 tx/s would then *write and
  broadcast* the character row to every subscriber (`connection.ts:524` is a global
  `SELECT * FROM character`) — strictly worse for every other client than today's rejections, which
  write nothing.
- **A `StepCadence` rate-limiter in `main.ts`** — open-loop (inherits B's drift), needs a second reset
  site, and rAF quantization accumulates ~8 ms/step → a lost tick slot every ~2.5 s.

---

## 3. Exact planned edits (touch-set only)

### `client/src/prediction/predictor.ts` — additive only, 3 small edits

`heldKeys.test.ts` is **out of the touch-set** and calls `enqueue(input)` / `drain` / `reconcile` /
`dropRejected` / `lastQueuedDir`. **Any change to an existing signature is a BLOCKER** — additive only,
and no optional `now?` parameter (an optional clock leaves a stale-stamp state representable).

1. Private field after `#lastFrameDrainAt` (~`:102`):
   `#lastAuthQueueLen = 0;` — the server's undrained `move_queue` length **as of the last reconcile**.
2. One assignment in `reconcile`, immediately after `const before = this.#predicted?.pos;` (`:228`) —
   before ADR-0012 step 1, reading only the `authQueue` parameter.
3. One accessor in the read-accessor block after `queueDepth` (~`:309`), side-effect-free:
   ```ts
   /** nh2 (ADR-0148): how far prediction is allowed to run AHEAD of authority — the steps the
    *  SERVER still owes: its undrained move_queue as of the last reconcile, plus every op sent but
    *  not yet seen acked. NOT "tiles I will still travel": reconcile step 4 has already drained the
    *  auth entries into #predicted. `queueDepth` cannot serve this role — the ADR-0012
    *  `now - 2*stepMs` rebase drains #queue to empty on every reconcile (see ADR-0148). The two
    *  terms never double-count: authorize_move acks in the same transaction as the queue push. */
   get outstandingSteps(): number
   ```

No new constant, no `mayContinueHeld()` (S-1). `predictor.ts` is **not** coverage-excluded
(`evals/dom-shell-coverage-exclusion.eval.mjs`), so every new line needs coverage.

### `client/src/main.ts` — one reorder + two gate conjuncts, nothing else

1. **R1 (rAF frame body):** move `const { snapped } = predictor.drain(now);` (`:2088`) to **immediately
   after** `const now = performance.now();` (`:2062`), i.e. above the `Re-issue the held dir` block.
   Behaviour: a continuation emitted this frame is no longer drainable in the same frame — the second
   half of the S2 mechanism. Add a one-line comment citing ADR-0148 so the ordering is not "tidied" back.
2. **rAF gate:** `predictor.outstandingSteps === 0 &&` as the leading conjunct of the existing
   14-overlay guard (`:2067-2084`).
3. **Reconcile-divergence gate:** same conjunct in the existing `if (diverged && !(…overlays…))`
   (`:404-425`). This is a deliberate, documented change to M8.8e §C's latency optimisation. Correct
   cost statement (M2): **bounded by the next authoritative batch (≤ ~`STEP_MS` + RTT)** — *not* "≤1
   frame". It is safe because every server-side queue mutation writes the character row
   (`movement.rs:128,191,237`) under a global subscription, and the reject path force-reconciles
   (`main.ts:466`), so a held key is delayed, never stuck. It is **not optional**: **[measured]** raf-only
   gating leaves S2 at 25/29, and gating both costs nothing user-visible.

**Untouched, deliberately:** `sendIntent` (`:442-468`), keydown (`:1056-1062`), keyup (`:1070-1073`),
`step`/`jump` (`:469-470`). Gating any of those would gate the DEV `__game().step()` hook (`:1433`) —
the **only** movement driver in the e2e suite (verified: zero `keyboard.down|up` / `Arrow*` hits across
`client/e2e/**`). Leaving keydown ungated is also F3's escape hatch.

### Docs

`docs/adr/0148-*.md` (new, supervisor-assigned number) · `just adr-digest` regen of `docs/adr/DIGEST.md`
+ `design-corpus.json` (**required even for a client-only slice** — ptc5c trap) · one targeted line in
`ARCHITECTURE.md`'s netcode section. **Not** `CHANGELOG.md` (git-cliff), **not** `docs/adr/README.md`
(supervisor owns the index). `just knowledge` is a no-op (no `.rs` change).

---

## 4. Test plan — 1:1 against nh2-1 / nh2-2 / nh2-3

### (a) Behavioural unit teeth — `client/src/prediction/predictor.test.ts`

Use a **cap-2** predictor (the file's `mkCapped(2)` helper, `:500-502`) — the default `mkPredictor()`
uses `QUEUE_CAP = 8` and would not model reality. U2–U8 drive the **real loop shape** (drain → gate →
`reissueDir` → `enqueue`) against a simulated server that drains 1 move per `STEP_MS` and feeds
`(authTile, authQueue, ackedSeq)` back through `reconcile`. The whole file starts RED (TS error:
`outstandingSteps` does not exist) — the file's established RED convention.
**Reference harness:** the red-team's `/tmp/mrprobe` (uncommitted, `ee8bd0d`) already implements exactly
this shape, including latency and rAF-phase parameters.

| # | EARS | Asserts | Mutation it MUST kill |
|---|---|---|---|
| **U1** | nh2-1 | `outstandingSteps` is a **SUM**: `(authQueue.length = 2, pending = 2) ⇒ 4`; and no double-count — `enqueue` → 1, `reconcile(auth=[e], acked=thatSeq)` → still 1, `reconcile(auth=[], acked)` → 0 | `Math.max(a,b)` (M-A), `min(len,1)` (M-B), `return #pending.length`, `return #lastAuthQueueLen`, `±1` |
| **U2** | nh2-1, nh2-3 | **TAP:** press, release after 2 frames, no reconcile ⇒ **exactly 1** emission; and `queueDepth === 0 && outstandingSteps === 1` at the gate check (the salvaged root-cause pin — the gate is *not* derived from `queueDepth`) | gate `=== true` → 2 emissions; any revert to the `#queue.length === 0` trigger |
| **U3** | **nh2-3 literal** | **HOLD → RELEASE:** hold across ≥2 server ticks, release, then drive ≥2 further step-periods of frames+reconciles ⇒ **zero** further emissions and `chebyshev(predictedFinal, predictedAtRelease) <= 1` | the unfixed code; any gate that reopens on a stale term. *(v1 had NO tooth for the literal nh2-3 scenario — U2 is a tap, U4 never releases.)* |
| **U4** | nh2-3 companion | **SUSTAINED HOLD (anti-vacuity pair for U2/U3):** hold K=4 ticks ⇒ emissions **`>= K && <= K+1`** (**[measured]** phase-dependent — `=== K+1` would be flaky), predicted advanced K tiles, `outstandingSteps <= 1` on **every** frame | gate `=== false` → 1 emission, walk frozen |
| **U5** | nh2-2, ADR-0141 | **Δpredicted ≤ 1 per frame under a deliberately UNALIGNED frame clock** (period not dividing `STEP_MS`, e.g. 1000/60 with a +1.5 ms offset, echo- and tick-reconcile landing in the same inter-frame gap): `chebyshev(predictedNow, predictedPrevFrame) <= 1` | **R1 reverted** (drain moved back below the emit) → Δ=2 → `snapTo` re-arms. **Without the misalignment this tooth is vacuous** (F2). |
| **U6** | nh2-1 | **EMISSION-RATE BOUND** under the real echo/reject cadence (reconcile after *every* send): `sends <= ceil(durationMs / STEP_MS) + 1`. Run at 30 / 60 / 144 Hz. Keep `<=` — **[measured]** the bound is exactly tight (51 vs 51 at 10 s); `<` would flake | today's per-frame flood (**[measured]** 63.8/s). **The tooth that protects the 7,961-reject payoff** |
| **U7** | F1 guard | **LATENCY:** full walk speed (1 tile per `STEP_MS`) at one-way L ∈ {0, 25, 50, 90} ms | a threshold/design regression that narrows the latency budget below the measured 90 ms cliff. *(v1 varied frame rate but never latency — the regime F1 broke in.)* |
| **U8** | **nh2-1 2nd trigger** | **DIRECTION SWITCH:** hold East 2 ticks, switch to North ⇒ at most **1** further East step committed and the next emission is North | the unfixed code (up to 2 stale-direction steps). *(v1 discussed the switch case only in prose.)* |
| **U9** | §2 claim | a freshly-constructed `Predictor` reports `outstandingSteps === 0` **before any reconcile** | pins the "zero new reset wiring" claim, which relies on `resetPredictionState()` rather than an explicit reset |

**Declared proxy limit (state it in the test file):** every tooth measures emissions or `Δpredicted`;
nh2-1's user-visible metric is *rendered* travel after release. These are sound proxies (U5 pins the
`SNAP_DIVERGENCE_TILES` precondition directly), but the end-to-end measurement belongs to the parked
e2e tooth (§6) and must not be implied to be under test.

**Deleted from v1 as ceremony:** T2 (pins a deleted constant) · T6 (fast-check purity — a tautological
oracle over `a === 0 && b === 0`; the file's existing fast-check uses at `:364-425`, `:1403` have real
oracles) · T7 (duplicate of U4 + the existing `dropRejected` suite `:1311-1446`) · T8 (salvaged into
U2; the "immediately due" behaviour is already pinned at `:220` and `:547`) · T10 (three copies of one
assertion defending Design B, which is not being built — 144 Hz folded into U6).

### (b) Source-scan wiring teeth — `client/src/main.wiring.test.ts`

Reuse `regionOrThrow(src, start, end, fromIdx)` (`:1880-1895`) and `stripLineComments` (`:1861-1870`).
**No fixed-width `slice(i, i+N)` windows** (nh1's post-mortem defect) and **no `new RegExp`** (Semgrep
ReDoS). Assert **anchor uniqueness inline** (`src.split(anchor).length - 1 === 1`) in each tooth — this
subsumes v1's separate `W-NH2-NOVACUITY`. Slice regions from **raw** source, then strip comments.

| Tooth | Asserts | Kills | Today |
|---|---|---|---|
| **W-NH2-GATE-WIRED** | in **both** anchor-bounded regions (reconcile-divergence, rAF), the comment-stripped + whitespace-squashed text contains `predictor.outstandingSteps === 0 &&` **contiguously** | the unfixed code; gating only one site; **M-D** (a bare expression statement has no `&&`); dropping the conjunct. Deliberately does **NOT** assert gate-before-`reissueDir` — v1's ordering assertion would have red-ed the equally-correct `const d = reissueDir(...); if (d !== undefined && gate)` form | **RED** |
| **W-NH2-DRAIN-FIRST** | inside the rAF frame body region, `indexOf('predictor.drain(') < indexOf('Re-issue the held dir')` | **R1 reverted** by a future "tidy-up" — the mutant that silently restores 3.5–7% of press-teleports | **RED** |
| **W-NH2-NO-CANCEL** | comment-stripped `main.ts` contains **none** of `predictor.clearQueue`, `predictor.setMove`, `reducers.clearQueue`, `reducers.setMove` | **Designs A and A′ verbatim** — the backward-snap teleport and the `#pending` hard freeze | **GREEN — regression guard; must be labelled as such**, not claimed RED |

**Re-anchors (B1) — strict, not weakening; call out in the PR body:**

| Tooth | Was | Becomes | Invariant preserved |
|---|---|---|---|
| `W-RN-FANOUT-RAF` (`:753-769`) | `src.slice(drainIdx - 400, drainIdx)` — fixed backward window | needle-bounded region over the rAF re-issue block (unique start `'Re-issue the held dir'`, unique end after the block) | `renameView?.visible` present in the rAF re-issue block (ADR-0133 D3) — **unchanged** |
| `W-HELP-FANOUT-RAF` (`:1363-1379`) | `'Re-issue the held dir'` → next `predictor.drain(` (order-dependent) | same needle-bounded region | `helpView?.visible` present in the rAF re-issue block (PTC2B-6) — **unchanged** |

**Forbidden fix:** widening `400 → 800` / `600 → 1000`. That silently weakens two fan-out teeth and is
the exact failure mode `ARCHITECTURE.md:1143` records.

**Deleted from v1:** `W-NH2-SENTINELS` + the 4 production sentinel comments (S-2) · `W-NH2-GATE-COUNT`
(a `>= 2` floor is implied by the two region teeth and its stated kill — "a third ungated path" — is
logically impossible, since a third *ungated* path leaves the count at 2) · `W-NH2-KEYUP-UNTOUCHED`
(subsumed by `W-NH2-NO-CANCEL`, which forbids all four symbols file-wide) · `W-NH2-NOVACUITY` (inlined
as per-anchor uniqueness assertions) · `W-NH2-RAF-GATE`'s `addEventListener('keyup'` check (tautological
— the region can only widen forward, and keyup is 1000 lines earlier).

**Un-killable inside the touch-set, parked not hidden:** `if (true || predictor.outstandingSteps === 0)`.
No source scan can catch it. Identical to nh1's documented residual; closing it needs
`page.keyboard.down/up` in a Playwright spec → out of touch-set (§6).

---

## 5. Regression risks and how each is proven absent

| Risk | Verdict | Proof |
|---|---|---|
| **ptc5g `SNAP_DIVERGENCE_TILES` (ADR-0141)** | **Improved to 0** | `renderResolver.ts:35,90-91` untouched. **[measured]** press-phase snaps 88.0% → 0.0% with gate + R1. Pinned by **U5** |
| **ADR-0090 adaptive EWMA** | **No interaction** — spec premise corrected | own char takes the `SlideClock` branch exclusively (`renderResolver.ts:74-93`); EWMA is in the `else` (`:101-113`) |
| **ADR-0052 cap semantics** | Untouched | `enqueue` cap check (`:136-137`) and reconcile clamp (`:237`) unchanged; the gate is caller-side policy *on top*. NET-1 suite (`predictor.test.ts:504-634`) stays green |
| **ADR-0013.5 pendingCap** | Read-only | `#pending` only read. Suite `:688-894` green |
| **ADR-0085 dropRejected / repair** | Untouched; **F3 accepted** | see §2a F3 — same freeze mode, onset 16 steps → 1 step, escapable by re-press / reconnect, and strictly safer than today's silent phantom-replay desync |
| **ADR-0012 four-step** | One assignment, outside the four steps | reads only the parameter. Suite `:290-331` green |
| **Divergence re-issue `main.ts:404-425`** | **Deliberate change**, correctly bounded | ≤ next authoritative batch (M2). **[measured]** identical first-step-after-pullback distributions vs raf-only at 1/25/100 ms |
| **Monotonic-prediction suite** | Green | `:895-940` — the gate touches neither `#predicted` nor `#stepForward` |
| **R1 frame-order change** | **[measured]** zero cost | 5.00 tiles/s at 30/60/144 Hz × 1/25/50/90 ms; 5.10 sends/s; 0 stalls; tap travel unchanged. `snapped` still flows to `resolve()` from the same `drain()` |
| **`heldKeys.test.ts` (out of touch-set)** | Green **iff** the API stays additive | it calls `enqueue(input)` with one arg — a required-parameter change is a **BLOCKER** |
| **e2e (`golden`/`recruit`/`zoneSync`)** | Unaffected | zero `keyboard.down|up` hits in `client/e2e/**`; all movement via `__game().step()` (`main.ts:1433`) |
| **Existing wiring teeth** | **B1 — 2 re-anchored, 0 weakened** | see §4b; strict re-anchor with identical assertions |
| **Coverage** | Satisfied by U1–U9 | `predictor.ts` is not excluded |
| **Concurrency** | Safe | sibling `B` inflight touches `game-core/content/*.ron` only — disjoint |

---

## 6. Right-sizing — ONE mergeable slice

~6 lines of new `predictor.ts` (1 field, 1 assignment, 1 accessor), 1 statement move + 2 conjuncts in
`main.ts`, 9 unit teeth, 3 new source-scan teeth, 2 strict re-anchors, 1 ADR.

**Parked, with reasons (surface in the PR + handoff):**
1. **`nh2-e2e`** — a keyboard-driven Playwright tooth (`page.keyboard.down/up` → hold → release →
   assert tile delta). The only thing that can kill `if (true || gate)` and the only end-to-end proof of
   rendered overshoot. Requires `client/e2e/**` → out of touch-set.
2. **F1 — the >95 ms latency cliff.** Accepted for the ADR-0129 local playtest; needs a real design
   (lookahead or an adaptive bound) before any remote deployment. **Flag to Drew.**
3. **The `now − 2·stepMs` rebase itself** (`convert.ts:93-102`, property-pinned by
   `convert.test.ts:106-132`) — the deeper root cause of §1.1. Out of touch-set.
4. **Reviewer M1** — fold the gate into `reissueDir` for compiler-enforced wiring; natural for **nh3**,
   which already owns `predictor.ts`.
5. **`set_move` direction-switch turn** (turn latency ~117 ms today) — rejected on rollback evidence here.
6. **Server-side `enqueue_move` flood/log amplification** — one `log::warn!` per reject
   (`guards.rs:16-18`), no rate limit, attacker-controlled tx volume. **Report to the supervisor as a
   new candidate slice** (the gate reduces the honest-client volume but does not bound a hostile one).
7. **nh3** epoch guard — its own slice, SERIAL after nh2 per spec §5.

**Falsifiable prediction:** if nh2 does not visibly collapse the `"queue full"` reject volume in the next
playtest, the §1 model is wrong and the plan must be re-derived.

---

## 7. Named anti-patterns (implementation must avoid)

1. Do **not** call `predictor.clearQueue()` / `conn.reducers.clearQueue(...)` on keyup — measured
   backward teleport. `W-NH2-NO-CANCEL` catches it.
2. Do **not** clear "locally only" — permanent freeze, *and* the snap fires 8 ms after keyup anyway.
3. Do **not** derive the gate from `#predicted.move_started_at` — it is not a phase clock.
4. Do **not** change any existing `Predictor` signature (out-of-touch-set blocker); no optional `now?`.
5. Do **not** gate `sendIntent`, keydown, or `step`/`jump` — that gates `__game().step()` and the whole
   e2e suite, and removes F3's escape hatch.
6. No `performance.now()` in `predictor.ts`.
7. No fixed-width scan windows; anchor-bounded regions only, with inline anchor-uniqueness assertions.
8. No `new RegExp(...)` anywhere (Semgrep).
9. Do **not** land U2/U3 without U4 — they pass against a permanently-false gate.
10. Do **not** label `W-NH2-NO-CANCEL` as RED-today.
11. Do **not** "fix" B1 by widening the existing fixed windows — re-anchor them.
12. Do **not** write U5 with a frame clock aligned to `STEP_MS` — it is vacuous unless deliberately
    unaligned.
13. Do **not** skip `just adr-digest` because the slice is client-only (ptc5c trap).
