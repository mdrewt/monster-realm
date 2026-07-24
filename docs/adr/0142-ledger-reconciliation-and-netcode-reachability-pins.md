# 0142 — ptc5f ledger reconciliation + deferred-netcode reachability pins

**Status:** Accepted
**Date:** 2026-07-24
**Slice:** ptc5f (M-playtest-c.5 pre-gate residuals — ledger reconciliation, closes M-playtest-c.5; EARS ptc5f-1/ptc5f-2 + Decision A/E pins)
**Supersedes:** —
**Amends:** ADR-0085, ADR-0090
**Amended-by:** —
**Subsystems:** tooling-docs, movement-netcode
**Decision:** Reconcile the playtest ledger (git-cliff CHANGELOG regen; PLAN §Status to the M-playtest-c.5 frontier) and pin two deferred netcode reachability bounds as gated facts: ADR-0090 burst-spread inertness and ADR-0085 warp epoch-eviction.

## Context

`M-playtest-c.5` (eleventh weekly review, `0421f2c`) is the pre-gate hardening
milestone inserted before the content pack + PLAYTEST GATE. Its final slice
`ptc5f` is a docs+test-pin reconciliation with **no behavior change** — it closes
the milestone by making the ledger honest and turning two deferred netcode
decisions into visible, gated facts rather than silent surprises.

Two drift residuals and two deferred decisions were verified at `0421f2c` and
re-confirmed against the current tip (`aee493a`, after ptc5a/b/c/d/e/g merged):

1. **Ledger drift (ptc5f-1/2, verified).** `CHANGELOG.md` stopped at ADR-0127 —
   the entire playtest block (F9 knowledge bundle, `playtest_event`,
   `set_profile_name`, rename/trade-propose UI, ptc5a–ptc5g) was missing.
   `PLAN.md` §Status still read "Next: close M17" though M17/M17.5,
   M-playtest-a/b/c, and six of the seven M-playtest-c.5 slices are delivered.

2. **Decision A — ADR-0090 burst-spread branch is production-unreachable
   (deferred-as-pin).** The synthetic-timestamp branch in
   `AuthoritativeStore.upsertCharacter` (`client/src/net/store.ts`) was known to
   be "almost always" inert at production tick rates (ADR-0090 §B-2 guard
   constraint). Decision A (Drew-delegated, 2026-07-20) resolved to *pin* the
   exact bound — not retune the smoothing path before the fun-hypothesis
   playtest (speculative tuning on a determinism-sensitive path, anti-YAGNI).

3. **Decision E — warp-path `Predictor` epoch-eviction gap (deferred fix,
   pinned).** On an own-zone warp, `resetPredictionState()` rebuilds the
   `Predictor` synchronously on a *live* socket and reconcile re-seeds `#nextSeq`
   to `ackedSeq` (so the next op reuses `ackedSeq+1`). A still-unacked pre-warp op
   occupies that same seq value, so a stale rejection's
   `.catch → dropRejected(seq)` can evict the *new* legitimate op. Decision E
   resolved to DEFER the fix (book it as `M-postgate-netcode-hardening`) but
   record the gap as an explicit accepted risk + pin its reachability — not a
   silent defer. **Review of this slice sharpened the reachability: the trigger
   does NOT require multiplayer contention** — see D4.

## Decision

### D1 — CHANGELOG regenerated from git history, never hand-edited (ptc5f-1)

`just changelog` (`git cliff -o CHANGELOG.md`) regenerates the flat,
type-grouped changelog from the Conventional Commit history reachable from the
current tip. Because `filter_unconventional = true`, the branch's `wip:`
checkpoints are excluded; only merged squash commits (proper Conventional
Commits) appear. Regenerating at `aee493a` folds in the full playtest block.
The changelog is a **generated artifact** — the fan-out doc-safety rule
(never hand-edit `CHANGELOG.md`) is upheld by writing good `feat:`/`fix:`/`docs:`
commit messages instead. A "regen-on-close" chore firing at each
playtest-milestone close is left as a follow-up (the SSOT mechanism — git-cliff
— already exists; only the trigger cadence is open).

### D2 — PLAN §Status advanced to the M-playtest-c.5 frontier (ptc5f-2)

`PLAN.md` line-3 `> **Status:**` is advanced: M17/M17.5 CLOSED, M-playtest-a/b/c
CLOSED, M-playtest-c.5 six-of-seven merged (ptc5a/b/c/d/e/g) with ptc5f closing
it, next = M-playtest-d then the PLAYTEST GATE. The post-gate block already
books `M-postgate-netcode-hardening` (Decision E's fix) and
`M-postgate-client-coverage` (Decision D) — this slice only advances their
status text, it does not add a booking. **`PLAN.md` is a harness file** (under
`specs/monster-realm-v2/`), not part of the project-repo PR; it is written by
the build-loop session and committed to the harness by the supervisor.

### D3 — ADR-0090 Decision-A: pin the burst-spread reachability bound (no behavior change)

The synthetic assignment `receivedAt = synthetic` (`store.ts`, the B-2 guard
branch) executes only when, letting `d = now − existing.latest.receivedAt` (the
outer guard forces only `d < BURST_EPSILON_MS` — there is **no** `d ≥ 0` check in
the code):

```
synthetic ≤ now + BURST_EPSILON_MS
⟺ existing.latest.receivedAt + stepMs ≤ now + BURST_EPSILON_MS
⟺ (now − d) + stepMs ≤ now + BURST_EPSILON_MS
⟺ stepMs ≤ BURST_EPSILON_MS + d < 2·BURST_EPSILON_MS
```

So the branch is **reachable only when `stepMs < 2·BURST_EPSILON_MS`** (= 40 ms
at `BURST_EPSILON_MS = 20`). At the production `STEP_MS = 200` the branch is
**unreachable** — the ring-buffer depth-4 history carries burst smoothness
instead (ADR-0090 §depth-4 + the `span ≤ 0` graceful path). A negative `d`
(a chained future synthetic, permitted since there is no lower-bound guard) only
shrinks the RHS, so it cannot widen reachability; the bound is the ceiling. The
bound is *tight*: at `stepMs = 39`, `d = 19` fires the branch; at `stepMs = 40`
no admissible `d < 20` can.

Actions (this slice): (a) a code comment at the branch site pins the
`stepMs < 2·BURST_EPSILON_MS` reachability bound; (b) a proof-of-teeth test in
`store.test.ts` that asserts the branch is unreachable across the entire
burst-gap domain at the production step, BITES at the exact threshold (reachable
at `stepMs = 39`, unreachable at `stepMs = 40`), and — importing the real
`BURST_EPSILON_MS` — asserts `PRODUCTION_STEP_MS ≥ 2·BURST_EPSILON_MS`, so
raising `BURST_EPSILON_MS` past 100 fails loud; (c) ADR-0090 gains an amendment
sharpening its "almost always false" language into this exact bound.
**Drift caveat (honest scope):** the client's operative step is the wasm
`step_ms()` export (`game-core::STEP_MS = 200`), not importable into the
node-only vitest suite, so `store.test.ts` carries `PRODUCTION_STEP_MS = 200` as
a *synced literal* (comment-pinned to `game-core/src/world.rs`). The test
therefore bites on a `store.ts` branch-logic change or a `BURST_EPSILON_MS`
change, but a change to `game-core::STEP_MS` alone would leave the literal stale
— a client↔core constant-parity gap that is a **separate, pre-existing drift
vector** (no eval pins `step_ms()`'s value today), recorded here as a residual
for the post-gate netcode/coverage work, not closed by this slice. **No behavior
change** — the smoothing path is untouched (option (a) tuning is kept as a named
YAGNI exception, revisited only if playtest smoothness testing shows burst pops).

### D4 — ADR-0085 Decision-E: accept the warp epoch-eviction risk + pin reachability (no fix)

ADR-0085's A2 amendment (RT-03) argued cross-session safety by **ordering**:
rejections settle only on message receipt from a live socket (no settle after a
drop), so a stale `.catch` always drains against the OLD predictor ≥1 s before
the reconnect timer builds the new one. **That argument holds for the reconnect
path only** — the socket is dropped, so the pre-warp rejection never settles.
An **own-zone warp** rebuilds the predictor synchronously on a *live* socket
(`switchZone → resetPredictionState`), with no ≥1 s gap and no drop, so a
pre-warp rejection CAN still settle after the rebuild and its
`.catch → dropRejected(seq)` targets a seq the re-seeded predictor reused.

Within a single predictor `#nextSeq` is strictly increasing and never reused, so
`dropRejected` only ever evicts the intended dead op (safe). The
eviction-of-a-legit-op is therefore **reachable only across a predictor rebuild
that re-seeds a colliding seq** — a movement rejection (or seq reuse) landing
exactly across a warp.

**Reachability — corrected by this slice's red-team pass (does NOT require
contention).** The original Decision-E rationale framed the trigger as needing
multiplayer contention ("no other players → no queue-full → unreachable"). That
is wrong on two counts, both grounded in code: (1) `MOVE_QUEUE_CAP = 2`
(`game-core/src/world.rs`) is **per-character**, so a single player holding a
movement key through a warp can hit "queue full" alone; (2) more directly, the
seq *reuse itself* produces a rejection — after `seedSeq(ackedSeq)` the fresh
predictor re-issues `ackedSeq+1`, colliding with the still-in-flight pre-warp op
of the same seq; on the single FIFO socket the older op is acked first
(`last_input_seq → ackedSeq+1`), so the new op's identical `seq` then hits
`seq <= last_input_seq` and is rejected **`"stale seq"`** (`guards.rs`) — whose
`.catch` fires `dropRejected(ackedSeq+1)` and drops the player's first
post-warp move. Net effect: **walking through a doorway while holding a
direction key** — the single most ordinary movement test — can silently swallow
the first post-warp input or briefly rubber-band it, entirely in **solo** play.
The likelihood is therefore materially higher than "effectively unreachable";
the fix stays deferred (Drew-delegated, and the guard is behavior-sensitive
prediction code out of this docs slice's scope), but the risk is recorded
**accurately** and surfaced to Drew (PR body + handoff) with a recommendation to
weigh pulling `M-postgate-netcode-hardening` forward of / into the playtest.

Actions (this slice): (a) amend ADR-0085 to record the epoch-eviction gap as an
explicit **accepted risk** for the closed-playtest window; (b) a comment at
`Predictor.dropRejected` pins the gap + points at the accepted-risk amend and
the booked fix; (c) a proof-of-teeth test in `predictor.test.ts` pins the
reachability bound — `dropRejected` is precise within one epoch (normal case,
no false eviction) and evicts a legit op ONLY when a rebuilt+re-seeded predictor
reuses the seq (cross-warp case). **No behavior change, no fix** — the
epoch/generation guard itself lands post-gate as `M-postgate-netcode-hardening`
(owner Drew).

## Consequences

- + The ledger is honest: `CHANGELOG.md` covers the playtest block and `PLAN.md`
  §Status reflects the real frontier; M-playtest-c.5 is CLOSED and the milestone
  advances to M-playtest-d (content pack).
- + Two previously-silent deferred decisions are now gated facts: raising
  `BURST_EPSILON_MS` past 100 (past which `STEP_MS = 200` enters the reachable
  regime), or a change to the `store.ts` branch logic / the seq-reuse-on-rebuild
  behavior, trips a test — the inertness/gap can no longer rot unnoticed (with
  the client↔core `STEP_MS`-parity caveat noted in D3).
- + Zero behavior risk: comment-only source pins, additive tests, generated docs.
  Nothing on the determinism-sensitive smoothing/prediction paths changed.
- − The epoch-eviction gap remains open until `M-postgate-netcode-hardening`.
  This slice's red-team pass showed it is reachable in **solo** play (warp while
  holding a key), not just under contention — a swallowed first-post-warp move /
  brief rubber-band. Deferral is upheld (Drew-delegated; fix is out-of-scope
  here) but flagged to Drew with a recommendation to weigh pulling the post-gate
  fix forward before the playtest.
- − The "regen-on-close" changelog trigger is a documented follow-up, not
  implemented here (YAGNI — the SSOT generator already exists).

## Considered alternatives

- **Decision A option (a): retune STEP_MS / BURST_EPSILON_MS so burst-spread
  runs in production.** Rejected pre-gate — speculative tuning of a
  determinism-sensitive smoothing path with no evidence a pop exists; kept as a
  named YAGNI exception (revisit only on observed playtest burst pops).
- **Decision E: ship the epoch/generation guard now.** Deferred pre-gate
  (Drew-delegated) — the guard touches sensitive ADR-0085-lineage prediction
  code and is out of this docs slice's declared scope. Note the trigger is
  **not** as rare as first stated (this slice's red-team pass showed solo
  reachability via per-character queue-full / stale-seq reuse across a warp), so
  the recorded residual recommends Drew weigh pulling the fix forward rather than
  treating it as negligible. This slice ships the accepted-risk record + the
  reachability pin only.
- **Hand-edit `CHANGELOG.md` to append the missing block.** Rejected — the
  changelog is git-cliff-generated; hand-editing would drift again and collide
  with concurrent sibling slices. Regen from Conventional Commits is the SSOT.
