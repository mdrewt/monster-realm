# nh3 plan v2 — Predictor warp-path epoch/generation guard (+ seq-floor) — ADR-0152 reserved

**Slice:** nh3 (`M-postgate-netcode-hardening.spec.md` §nh3, EARS nh3-1/2/3) · **Tier:** HARD
**Status:** PLANNED, plan REVIEWED (planner → reviewer + red-team, 2026-07-25) — slice **PARKED at
the plan checkpoint on a touch-set blocker** (§0). This document is the build contract for the
re-serialized resume. v2 incorporates all reviewer/red-team findings (§10 ledger).

---

## 0. Scope blocker (why this slice parked)

Declared touches: `client/src/prediction/predictor.ts` (+ sibling `predictor.test.ts`),
`docs/adr/0085-*.md` (+ reserved ADR-0152 + standard doc companions).

**Honest form of the blocker (restated after red-team F1):** it is not that NO in-touches fix
exists — it is that the only in-touches design (D5: move `#nextSeq` to module scope so instances
never share seq space) was evaluated and REJECTED with lens concurrence: it puts mutable
module-global state into the headless, deterministic prediction core; it makes every
absolute-seq assertion in the 2,600-line pinned suite order-dependent forever (a permanent
maintainability regression); and it does not implement the spec's own named mechanism (nh3-1:
"Predictor SHALL carry an epoch/generation identifier"). Every design that meets the codebase's
standards AND the spec's mechanism requires `client/src/main.ts` — the discriminating datum
(which instance issued a rejected op) exists only at send time, inside `sendIntent`'s closure
(`main.ts:453-472`); at `.catch`-fire time `predictor.dropRejected(seq: number)` is call-site
identical for a legit and a stale rejection (red-team probed 5 predictor-internal escapes; all
fail). The launch order is also internally contradictory: its own slice description mandates
"a rejection .catch compares its captured epoch" — that `.catch` IS main.ts:456-472.

**Supervisor: re-serialize with:**

```
touches += client/src/main.ts                       (the capture + floor; ~6 lines + comment)
           client/src/main.wiring.test.ts           (tooth for coverage-excluded main.ts wiring)
           client/src/prediction/heldKeys.test.ts   (2 mechanical call-site updates — runtime,
                                                     not tsc: tests are excluded from typecheck)
```

Sibling ux3 (justfile / docs/playtest-ops.md / evals/playtest-verify.eval.mjs) — no collision.

## 1. THE KEY REVIEW FINDING (red-team F2, reviewer B2 — concurring): the epoch guard alone
##    closes only HALF the accepted-risk window

The seq collision after a rebuild has TWO failure arms (server: `guards.rs:77`
`seq <= last_input_seq → Err("stale seq")`; rows FIFO on one socket):

- **Case M1 — stale rejection of the DEAD predictor's op.** Pre-warp op (seq 5) is REJECTED
  (e.g. queue full → txn rollback → `last_input_seq` stays 4). Post-rebuild, reconcile seeds
  `#nextSeq=4`; a fresh keydown issues colliding seq 5 (server ACCEPTS: 5>4). The old op's
  rejection then settles → `dropRejected(5)` evicts the NEW, server-accepted op → under-count →
  nh2 gate opens → extra emission → overshoot/rubber-band. **The epoch guard fixes exactly this.**
  Post-nh2 this arm is RARE (ADR-0148 drove queue-full rejects 557→0 per 10s).
- **Case M2 — the NEW op's OWN "stale seq" rejection.** Pre-warp op (seq 5) is ACCEPTED first
  (FIFO) → `last_input_seq=5`; the post-rebuild colliding op (seq 5) is REJECTED as stale. That
  rejection carries the NEW epoch — the guard correctly passes, the eviction is contractually
  correct, and the player's first post-warp move is swallowed anyway. **This is the exact solo
  trigger sentence in ADR-0085's ptc5f amendment, it is the DOMINANT remaining arm post-nh2, and
  no rejection-side guard can fix it — the defect is upstream: the fresh predictor re-ISSUED a
  seq the server must reject.**

**Therefore the build is TWO mechanisms, both required for nh3-3's "the accepted-risk window
closes" to be a true statement:**

1. **Epoch guard (spec nh3-1 letter):** protects the eviction seam against Case M1 and against
   any future collision path — mechanical, predictor-core, compiler-enforced.
2. **Send-seq floor (Case M2 killer, reviewer B2-2):** `main.ts` keeps
   `let lastSentSeq = 0;` updated at the single send site (`lastSentSeq = seq;` beside
   `main.ts:455`), and `resetPredictionState()` adds `predictor.seedSeq(lastSentSeq);` after
   construction (`main.ts:285`). The rebuilt predictor's first seq is then `> ` every seq ever
   sent → the collision never exists → M2's stale-seq rejection never happens (server accepts
   seq 6 > 5) AND M1's stale rejection targets a seq the new instance never issued. Uses only
   existing public API (`seedSeq` is monotonic-raise, `predictor.ts:213-215`); server-safe
   (`seq > last_input_seq` is monotonic-not-consecutive, ADR-0085 SDK-evidence; gaps legal);
   zero unit-test churn (tests construct predictors directly, never through main.ts).
   With the floor in place the epoch guard becomes defense-in-depth at the seam (belt-and-
   suspenders precedent: ptc5b) — the ADR says exactly that, no more.

If the supervisor prefers the spec-letter-only scope (guard, no floor), ADR-0152 and the
ADR-0085 amendment MUST then say "window half-closed; Case M2 named residual" — NOT "closed".
Recommended: ship both (the floor is ~3 lines in a file the guard already touches).

## 2. Design — D1: explicit epoch, compiler-forced (refinements FINAL after review)

- `static #nextEpoch = 0` on the `Predictor` class (class-scoped, not loose module state —
  reviewer MINOR; note: `connection.ts`'s `buildGen` is closure-scoped, cite the *idiom* not the
  scope); constructor: `this.#epoch = ++Predictor.#nextEpoch as PredictorEpoch`.
- **R-b PROMOTED TO REQUIRED (reviewer M1, red-team F5):** `export type PredictorEpoch = number &
  { readonly __brand: unique symbol }`. Test files are NOT typechecked (`client/tsconfig.json`
  excludes `**/*.test.ts`; `tsc --noEmit` only covers src) so the brand costs zero test casts —
  and it is the ONLY mechanism that makes `dropRejected(seq, seq)` a compile error. One cast at
  the increment site.
- **R-a KEPT: no public epoch getter.** The live epoch is readable only via an issued intent →
  the vacuous call `dropRejected(seq, <live epoch>)` is unwriteable from main.ts. (Record in the
  ADR: the natural future tooth "empty predictor returns false for any epoch" requires enqueueing
  a probe first — accepted.)
- `IntentToSend` gains `readonly epoch: PredictorEpoch`; `#record` stamps `this.#epoch`
  (CONSTRUCTOR-assigned — see N5, which pins that it is NOT re-read from the static counter).
- `dropRejected(seq: number, epoch: PredictorEpoch): boolean` — REQUIRED param, no default; the
  mismatch no-op (`if (epoch !== this.#epoch) return false;`) is the FIRST statement.
- **main.ts (~6 lines + comment):** `const epoch = intent.epoch;` beside `const seq`;
  `predictor.dropRejected(seq, epoch)` at `:471`; `lastSentSeq = seq;` (floor); module
  `let lastSentSeq = 0;`; `predictor.seedSeq(lastSentSeq);` in `resetPredictionState()`; rewrite
  the A2 comment block (`main.ts:457-470`, `//`-style) — ordering invariant demoted to
  defense-in-depth, not retracted (it rests on observed SDK 2.6.0 behavior, not a contract).
- **ADR-0152 records the single-module-instance assumption** (red-team F9): the epoch counter is
  per-module-instance; duplicate chunks / workers / HMR re-eval would reset it. Not reachable
  today (single entry, no worker imports predictor.ts, no import.meta.hot accept in main.ts →
  HMR full-reloads). Record, don't engineer around.

**Alternatives for the ADR:** D2 send-time instance capture (rejected: correctness in a
coverage-excluded shell, no compiler enforcement, dead-predictor retention on never-settling
promises, contradicts A2's letter) · D3 `Symbol()` brand (structurally immune to F9 but
non-loggable; the branded number + recorded assumption chosen instead) · D4 self-rejecting
intent handle (behavior on a marshaled value type; retention) · D5 module-scope seq space
(rejected §0) · D6 `dropRejected(intent: IntentToSend)` single-param (viable, compiler-forced,
footgun-free — not chosen: (seq, epoch) matches the spec's own language and keeps the eviction
API primitive-in; record it) · floor-only without the guard (rejected: leaves the eviction seam
discipline-guarded only — a future send site that forgets the floor re-opens M1 silently with
zero mechanical backstop).

## 3. Ordered build steps (test-first; implementer edits ZERO test files)

1. **Tester — nh3 banner + core teeth in `predictor.test.ts`** (nh2 banner conventions: verbatim
   EARS, criterion→test map, injected clock). Redness comes from RUNTIME assertion failures, not
   tsc (tests aren't typechecked) — plus `intent.epoch === undefined` before impl.
2. **Tester — extend the ptc5f pin in place** (arms per §5; rewrite its banner `:1591-1605` —
   currently says "documented (not fixed)").
3. **Tester — mechanical call-site updates**, every existing `dropRejected` site
   (`predictor.test.ts:1327,1349,1363,1364,1378,1393,1426,1485,1619,1621,1626,1627,1650,1979`;
   `heldKeys.test.ts:495,539`). **Invariant: every site passes an epoch read from an intent
   issued by THAT instance — never a literal** (a plausible `0` never matches — `++` starts at 1
   — and would leave `false`-oracle sites green-and-vacuous, reviewer M2). Where no intent
   variable is in scope: hoist one (`heldKeys.test.ts` tail sites: hoist
   `const tail = sentIntents[sentIntents.length-1]!`); in the fast-check property (`:1426`) use
   `intents[0]!.epoch` (safe: `count >= 1`, reconcile-first). At `:1349` (unknown-seq `false`
   oracle) add a positive control in the same test (`dropRejected(i1.seq, i1.epoch) === true`)
   so the epoch is proven live. Separate commit.
4. **Tester — `predictor.ts` SIGNATURE source-scan in `predictor.test.ts`** (declared sibling —
   this, not the wiring tooth, kills the optional-param mutation, red-team F4/reviewer B1):
   read `predictor.ts`, assert it contains the contiguous needle
   `dropRejected(seq: number, epoch: PredictorEpoch): boolean` and contains NEITHER `epoch?:`
   NOR `epoch: PredictorEpoch =` (no `new RegExp`; indexOf only).
5. **Tester — wiring teeth in `main.wiring.test.ts`** (§6).
6. **Implementer — `predictor.ts`:** §2 mechanics; rewrite the stale `dropRejected` comment
   (`:183-192`); correct the `outstandingSteps` doc (`:337-341`) PRECISELY — nh3 closes the
   eviction hazard and (with the floor) the collision; it does NOT fix the fresh-instance
   `#lastAuthQueueLen = 0` under-count (keep as a named open residual; its window is near-zero:
   the rebuild is immediately followed by a reconcile, and `held.clear()` empties the held stack
   — over-claiming here is the likeliest review finding).
7. **Implementer — `main.ts`:** §2's ~6 lines + A2 comment rewrite. Nothing else.
8. **Docs:** ADR-0152; ADR-0085 append-only amendment (case-split honestly: M1 closed by guard,
   M2 closed by floor; §3's A2 ordering invariant demoted to defense-in-depth AND note the guard
   also closes §3's own `seedSeq(N-1)` reconnect boundary case; never rewrite prior sections) +
   header `Amended-by: ADR-0142, ADR-0152`; spec-conformance note: the epoch comparison lives
   INSIDE `dropRejected` (callee), not literally in the `.catch` — sanctioned by spec §3;
   `just adr-digest`; `just changelog` (tip full SHA); minimal ARCHITECTURE.md note; memory card.
9. **Gates:** fast targeted (vitest prediction/ + main.wiring + client tsc) red→green; full
   `just ci` once pre-PR; hand-run every §7 mutation.

## 4. EARS → test map (nh3-1)

- **N1** epoch distinctness (fast-check, 2..20 instances): **construct ALL instances first, then
  enqueue on each** (kills a `#record`-time static-counter read, red-team F7); assert pairwise
  distinct. **Relative assertions only — never absolute epoch values** (static counter =
  file-order-dependent).
- **N2** same-epoch eviction unchanged: `true`, then idempotent `false`.
- **N3** cross-epoch no-op is TOTAL: `false` AND `pendingCount` AND `queueDepth` unchanged.
- **N4** guard idempotence property — arbitrary `(seq, foreignEpoch)` never mutates: **obtain the
  live epoch via an issued intent and `.filter(e => e !== live)` on the foreign-epoch arbitrary**
  (an unconstrained integer arbitrary WILL hit the real epoch value → order-dependent false
  fails, red-team F7); ALSO include foreign epochs BOTH above and below the live value (kills the
  relational `<` mutant, red-team F4).
- **N5 (NEW — reviewer M4):** one instance: `enqueue`/`setMove`/`clearQueue` intents all carry
  the SAME epoch, unchanged after `seedSeq`/`reconcile`/`drain` (pins constructor-assigned, not
  per-record).
- **N6 (floor, if in scope):** predictor-level pin of the mechanism: A issues+sends seqs; B is
  built and `seedSeq(<A's last sent seq>)`-seeded; B's first intent seq is strictly greater;
  `B.dropRejected(<A's seq>, <A's epoch>)` is `false` and total.

## 5. nh3-2 — the ptc5f pin, extended in place (NOT a legacy-eviction copy)

- **Arm 1 — premise KEPT verbatim:** `expect(newOp.seq).toBe(preWarpOp.seq)` — pins that the
  GUARD fix is epoch-based, not seq-disjointness. (This arm models the un-floored predictor pair
  directly — `b.seedSeq(0)` — so it remains valid alongside the floor, which lives in main.ts.)
- **Arm 2 — FLIPPED (the nh3-2 assertion):** `b.dropRejected(preWarpOp.seq, preWarpOp.epoch)` →
  `false`; rebased-`now` reconcile trick; `b.queueDepth === 1`, `b.lastQueuedDir === 'East'` —
  the legit op SURVIVES.
- **Arm 3 — control FOLDED into arm 2's comment** (reviewer: redundant post-flip; keep only the
  comment explaining the guard is a no-op on the legit path, not a survive-all).
- **Arm 4 — same-epoch eviction still works on `b`, RE-LABELED as the Case-M2 residual/behavior
  pin** (red-team): `b.dropRejected(newOp.seq, newOp.epoch)` → `true`; reconcile →
  `queueDepth === 0`. Comment: this IS what a genuine post-warp "stale seq" rejection does; the
  guard must not suppress it; the FLOOR (main.ts) is what prevents that rejection from existing.
  Without this arm the whole test passes against `dropRejected(){return false;}`.

## 6. Wiring teeth (`main.wiring.test.ts`) — corrected per red-team F3 / reviewer M3

`W-NH3-EPOCH-CAPTURED`: anchors `const intent = predictor.enqueue(input);` (`main.ts:453`,
verified unique) … `const step = (dir` (`:474`); slice region; **`stripLineComments` (blocks
THEN lines — the A2 comment is `//`-style; `stripBlockComments` alone leaves it in and the
rewritten comment WILL contain the needles)**; ADR-0116 bail-guards (region non-empty, still
contains `dropRejected(`). Assertions:
- (a) the EXACT statement `const epoch = intent.epoch;` present (whole-statement needle, not
  bare-token presence — and assert no OTHER `epoch =` assignment in the region);
- (b) stripped region contains `predictor.dropRejected(seq, epoch)` with **count ≥ 1** AND no
  other `predictor.` occurrence in the `.catch` body (positive count — a zero-match "only
  reference" assertion is vacuous);
- (c) floor wiring (if in scope): `lastSentSeq = seq;` present in the region, and a second
  anchored scan pins `predictor.seedSeq(lastSentSeq);` inside `resetPredictionState()`'s body
  (anchor `function resetPredictionState`).
Justify (a) in-file as the ADR-0085 A2 posture (capture primitives, never hold the object) —
it is a style pin; the correctness pins are (b)/(c) + the brand + the signature scan.

## 7. Proof-of-teeth (hand-verify each pre-merge; record in ADR-0152)

| Mutation | Killed by |
|---|---|
| Delete the epoch mismatch early-return | §5 arm 2, N3, N4 |
| Flip `!==` → `===` | §5 arm 4, N2, single-epoch precision test, heldKeys GREEN path |
| Relational `<` instead of `!==` | N4 (above-AND-below foreign epochs) |
| Optional/defaulted param in predictor.ts | SIGNATURE scan (§3 step 4) — the wiring tooth CANNOT catch this (main.ts unchanged) |
| `dropRejected(seq, seq)` in main.ts | `PredictorEpoch` brand → tsc |
| Constant epoch (`#epoch = 0`) | N1 |
| Per-record epoch (re-read static counter in `#record`) | N5, N1-ordering |
| Ignore `seq`, drop head of `#pending` | `:1342` region tests + `:1403` property (add explicit row — reviewer M2) |
| Revert `main.ts:471` to 1-arg | tsc (required param) |
| Remove `lastSentSeq = seq;` or the `seedSeq` floor call | wiring tooth (c) |

## 8. Anti-patterns (prohibitions)

A1 no optional/defaulted epoch param · A2 never weaken/delete the ptc5f pin (arm 1 stays) ·
A3 no server code; the epoch never crosses the wire (the FLOOR changes seq VALUES — legal,
monotonic-not-consecutive — never seq SEMANTICS) · A4 no Date.now/performance.now/Math.random
in predictor (a timestamp epoch also collides within 1ms) · A5 implementer edits zero test
files · A6 no absolute-epoch assertions · A7 no `new RegExp` in teeth · A8 no public epoch
getter · A9 every mechanical call-site update passes an intent-derived epoch, never a literal.

## 9. Risks / residuals / follow-ups

- **R2 (verified by both lenses):** post-guard the legit op correctly stays pending → nh2's
  `outstandingSteps` gate shut ≤ ack-latency longer post-warp — same `2·oneWayLatency` term
  ADR-0148 already accepts; no new stutter class (prediction already drained the step). nh2
  U-tests mechanically unaffected (runLoop never rebuilds its predictor) — verify, don't assume.
- **R4:** guarded no-op returns `false` → no forced reconcile — correct (nothing removed; the
  live instance was seeded from store truth by the post-warp reconcile; both warp paths
  guarantee that reconcile in the same flush). State in ADR. Adjacent PRE-EXISTING residual
  (red-team): if `switchZone` FAILS (bad content), `reconcileFromStore` early-returns forever →
  nh2 gate frozen until reload — not nh3-caused; name it in the ADR residuals.
- **R6 (NEW — surface to supervisor, out of nh3 scope):** `resetPredictionState()` calls
  `held.clear()` (`main.ts:287`) → **walking through a doorway while holding a key stops the
  player dead until release+re-press.** Deterministic, unrecorded, first-class "game fights me"
  feel defect — candidate slice `nh5`. ALSO means: the spec's/ADR's "warp while holding a key"
  trigger phrasing is not literal — both M1/M2 need a fresh post-warp keydown through the
  ungated `step(dir)` path; reachability stands (re-press within RTT window), e2e naming below.
- **R7:** parked `nh3-e2e` MUST be scripted as `warp → release → re-press` (+ induced pre-warp
  rejection) — a literal "hold through warp" script is vacuous-green (F6). Natural home:
  `client/e2e/zoneSync.spec.ts` extension. Parked beside nh2-e2e/nh4-e2e.
- **U1:** re-verify ADR-152 reservation at resume (ux3 holds 153).

## 10. Review ledger (what changed v1→v2)

Reviewer: B1 (§5-row-3 false → signature scan + brand) · B2 (Case M2 → floor) · M1 (R-b
required; tooth re-justified) · M2 (runtime-not-tsc; literal-epoch vacuity; positive controls;
drop-head mutation) · M3 (stripLineComments) · M4 (N5) · MINORs (static counter, buildGen
citation, arm 3 fold, arm 4 relabel, A2 span :457-470, e2e path, ADR-0085 §3 demotion, spec-
conformance note) · ADVISORY D6 recorded. Red-team: F1 (blocker restated honestly; D5 rejection
justified) · F2 (M1/M2 case split — the load-bearing finding) · F3 (tooth vacuity fixes) · F4
(teeth table corrections + relational mutant) · F5 (typecheck reality; brand promotion) · F6
(held.clear → R6/R7) · F7 (N1/N4 constraints) · F8 (mechanical-edit reality) · F9 (module-
instance assumption recorded). Both lenses' honest-negative sections (no legit-rejection
false-no-op; R2/R4 confirmed) noted for the resume's reviewers.
