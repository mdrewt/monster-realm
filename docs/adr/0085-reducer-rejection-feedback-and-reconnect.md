# ADR-0085 — Reducer-rejection feedback & app-level reconnect (M13.5b)

**Status:** Accepted
**Date:** 2026-07-05
**Slice:** m13.5b
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0142
**Subsystems:** movement-netcode, client-ui
**Decision:** Reducer rejections surface as UI feedback; enqueue_move drops rejected seq and forces reconcile; app-level reconnect uses exponential backoff capped at 30s.


**Date:** 2026-07-05 · **Status:** Accepted
**Deciders:** orchestrator (m13.5b build loop; ADR number supervisor-assigned)
**ADR-sequence:** follows 0084 (M13d shop client view)

## Context

The seventh weekly review verified a **silent phantom-intent desync**: when a
server-rejected `enqueue_move` is the last input of a burst, the client is left
one tile off authority forever, with `diverged=false`. Root causes, all
verified at `62ee457`:

1. `predictor.ts` prunes `#pending` only by `p.seq > ackedSeq`. A rejected
   intent's seq is **never acked** — the server's accept-time ack write is
   rolled back with the whole transaction on `Err` (`guards.rs` /
   `authorize_move`; ADR-0052) — so the phantom op survives every prune and is
   replayed onto the authoritative queue at every reconcile.
2. **Zero reducer-result handling existed anywhere in the client** — no
   rejection reached the prediction layer or the user (dead buttons).
3. `main.ts` sent `healParty({ locationId: 0 })` when no heal locations were
   loaded — a guaranteed invisible `Err`.
4. `connection.ts` discarded the SDK subscription-error payload.
5. The M5 open question — does the SDK auto-reconnect after a drop? — was
   still open; `onDisconnect` only did `store.reset()`, leaving a blank world
   with live local prediction.

## SDK evidence (spacetimedb npm ^2.6.0 — line-cited, verified 2026-07-05)

- **Reducer result mechanism:** every `conn.reducers.X(args)` returns
  `Promise<void>` — resolved on `Ok`/`OkEmpty`, rejected with
  `SenderError(errorString)` on reducer `Err`, `InternalError` otherwise
  (`src/sdk/db_connection_impl.ts:1109-1184`, `#reducerCallbacks` keyed by
  requestId). **There are no per-reducer `onX` callbacks in this SDK version**
  — the spec's "reducer-status callback" language maps to this promise
  rejection surface (m13d's buy/sell already used it; `main.ts` comment
  "conn.reducers.onBuy … doesn't exist in STDB 2.6").
- **No settle on drop:** `ws.onclose` only sets `isActive=false` and emits
  `disconnect` (`db_connection_impl.ts:331-334`); `#reducerCallbacks` entries
  are settled ONLY on message receipt (`:999-1000`). **In-flight reducer
  promises never settle after a drop.**
- **Silent queueing on a dead connection:** `#sendEncodedMessage`'s inactive
  branch pushes the encoded call onto `#outboundQueue` of the dead instance,
  which is never flushed (no reconnect on the raw path). A reducer call made
  while disconnected is a **silent black hole**: no error, no settle.
- **No auto-reconnect on the raw builder path** (`DbConnection.builder()…
  .build()`, what `connection.ts` uses). The SDK's `ConnectionManager`
  (`src/sdk/connection_manager.ts`) auto-rebuilds with exponential backoff
  `min(1000·2^attempt, 30_000)` — but it is the framework-integration layer
  (React-style retain/release refcounting) and is **not exported from the
  package root**, so it is not usable here without depending on private paths.
- **Server seq semantics:** `authorize_move` accepts any `seq >
  last_input_seq` (monotonic, not consecutive; `guards.rs`) — so locally
  dropping a rejected seq N and continuing with N+1 can never strand movement.
- **Server disconnect semantics:** `on_disconnect` deletes the player +
  character rows (`lib.rs`), so a reconnect MUST re-join; `join_game` errs
  `"already joined"` only when the server has not yet processed the old
  session's drop — benign (rows still live; the new subscription re-hydrates).

## Considered alternatives

- **A — per-reducer `onX` callbacks:** do not exist in SDK 2.6 (evidence above).
- **B — adopt the SDK `ConnectionManager`:** not root-exported; brings React
  refcount lifecycle we don't need; rejected.
- **C — full page reload on disconnect:** trivially correct but unacceptable
  UX for a real-time game; rejected.
- **D — app-level `.catch` routing + app-level rebuild-with-backoff (CHOSEN).**

## Decision outcome

**D1 — rejection routing via promise `.catch`.**
- `enqueue_move`: the `.catch` drops the rejected pending op
  (`Predictor.dropRejected(seq)` — eviction of a known-dead op, categorically
  different from the ADR-0013.5 `#pendingCap` backpressure which never drops
  recorded ops) and, if an op was dropped, **forces a reconcile from current
  store state** (`reconcileFromStore()` in main.ts) — necessary because a
  rejected burst-tail produces NO further authoritative batch. Movement
  rejections stay **silent** to the user (M2 §3): prediction repair, no toast.
- Non-movement reducers: every send is wrapped (`sendGuarded`) with a `.catch`
  routing through `reduceErrorMessage(err, where)` to the status line;
  `SenderError` messages pass through, `InternalError` detail is **never
  leaked** (generic message). Classification uses `err.name` equality, not
  `instanceof` (cross-realm/bundling safety).
- `dropRejected` mutates **only `#pending`**; `#queue` has exactly one
  rebuilder (reconcile step 2). The forced reconcile's early-exit when the
  store lacks own/player rows (reset mid-gap) leaves a transient
  `#pending`-dropped/`#queue`-stale state that **self-heals on the next batch
  reconcile** — accepted and commented.

**D2 — forced reconcile from a `.catch` microtask does not violate reconcile
atomicity (ADR-0013):** a rejected reducer produces **no row events** (nothing
half-applied is in flight), and any prior transaction's row burst was already
coalesced and flushed by the batcher before this turn's microtasks run — the
store is a complete per-transaction snapshot at `.catch` time. Burst
rejections (N drops → N reconciles in one microtask turn) are harmless: the
microtask checkpoint drains before the next rAF, the renderer reads predictor
state only in rAF, and each reconcile is a total re-derivation from store
truth.

**D3 — app-level reconnect: rebuild-with-backoff + event-driven input freeze.**
- Backoff mirrors the SDK's own constants: `reconnectDelayMs(attempt) =
  min(1000 · 2**attempt, 30_000)` (`2 ** attempt`, not bitshift; the
  `Infinity` overflow at large attempts is capped by `min`; a negative
  `attempt` is defensively clamped to 0 — the function is total even though
  the state machine never produces one). **Attempts are unbounded** (a game
  client keeps trying; delay cap prevents a storm) — no terminal give-up
  state (YAGNI). `attempt` counts **consecutive failed builds**: a
  drop-triggered rebuild (no failed build yet) schedules at the 1 s rung,
  while a failed *cold-start* build's first retry sits on the 2 s rung — the
  instant initial attempt was rung one. Same formula both ways; the asymmetry
  is intended (review H2/M2).
- Pure policy (`client/src/prediction/reconnectPolicy.ts`): flat state
  `{ link: 'connected'|'disconnected'|'reconnecting'; attempt: number }`;
  freeze is **derived**, never stored: `linkFrozen(s) ≡ s.link !==
  'connected'`. Transitions are idempotent (`onDisconnected` on an already
  down link is a no-op) so the SDK's onerror-then-onclose double event cannot
  double-schedule.
- The freeze is **event-driven** (disconnect), never promise-driven —
  in-flight promises never settle on drop (evidence above). While frozen:
  movement `sendIntent` and the held-key re-issue are gated off, and
  `sendGuarded` **short-circuits** with "disconnected — try again" instead of
  calling a reducer (whose call would be silently queued on the dead instance
  and whose promise would hang forever — the dead-button black hole).
- Freezing only the SEND side is sufficient: during the gap the old predictor
  may drain, but `store.reset()` cleared all rows → `ownEntityId` is
  undefined → the RenderResolver emits no own entity (a blank world during the
  gap is expected and correct); `resetPredictionState()` on reconnect rebuilds
  prediction and `seedSeq` (M8.8e) re-seeds the counter.
- `connection.ts` shell: one `scheduleRebuild()` guarded by a single timer
  handle; `onDisconnect` and `onConnectError` both route through it;
  `pagehide` clears the timer and suppresses scheduling (teardown guard), and
  `pageshow` with `persisted=true` (a bfcache restore — the browser killed the
  socket while the page was frozen) is the inverse: reset the teardown guard
  and force the shared drop path, or Back-navigation leaves the client
  permanently frozen (RT-PH-01). The
  `MicrotaskBatcher` and `hadSession` live in the OUTER `connect()` scope
  (one batcher across rebuilds — a per-build batcher could flush stale state
  after `store.reset()`); `wireTables(conn)` re-registers all row handlers on
  each rebuilt connection. `Connection.conn` becomes a getter for the CURRENT
  `DbConnection` (name kept for call-site compatibility; callers must not
  cache `conn.conn` across await points — commented on the getter).
  `joinGame` stays unconditional in `onApplied` with a `.catch` treating
  `"already joined"` as benign (server-side rows survived a fast reconnect).

**Consequences**
- + The verified 1-tile phantom-intent desync class is closed at the
  prediction layer and proof-of-teeth-tested at the Predictor level (the class
  the Rust-only sim-harness cannot reach).
- + Every reducer rejection is either repaired (movement) or user-visible
  (status line); no dead buttons — including while disconnected.
- + Reconnect behavior is confirmed and mechanical: rebuild with bounded
  backoff, frozen input, clean re-join.
- − The status line is a minimal dynamically-created element (no toast
  system); richer UX deferred.
- − Transport-failure feedback for an in-flight call at drop time is
  inherently unavailable (promise never settles) — accepted; the freeze +
  status line covers the user-visible gap. The shop's double-spend lock is
  the one piece of state such a never-settling call can strand — released on
  reconnect via `shopView.hide()` in main.ts (RT-PL-01; Escape/KeyG recover
  it manually during the gap).
- Follow-up: a reconnect e2e (two-window drop/rejoin) is out of this slice's
  touch-set (e2e specs are sibling-owned this cycle).

## Amendment (pre-merge review pass, 2026-07-05)

Three hardenings from the paid review pass on PR #119 (reviewer / red-team /
desync-guard / security / tester lenses):

1. **Rebuild-timer throw containment (RT-01).** `build()` can throw
   synchronously (malformed URI, SDK bindings version check). The rebuild
   timer now wraps `current = build()` in try/catch and routes a throw
   through the failed-attempt path (surface → `onAttemptFailed` →
   `scheduleRebuild`) — previously a throw stranded the link at
   `'reconnecting'` forever with no retry and no feedback.
2. **Stale-build generation guard (RT-02/RT-04/RT-07 class).** Every
   `build()` captures a `buildGen` token; `onConnect` / `onApplied` /
   `onConnectError` / `onDisconnect` no-op when a newer build exists. Closes
   the bfcache-buffered stale `onDisconnect` wiping freshly delivered rows,
   the late stale `onConnectError` dirtying the status line after a
   successful reconnect, and stale `identity` clobber.
3. **A2 invariant corrected (RT-03).** The original claim — "a post-reconnect
   fresh predictor lacks the stale seq, so `dropRejected` is a safe no-op" —
   is wrong at the boundary: `seedSeq(N-1)` hands the fresh predictor seq
   `N`, colliding with a stale rejection of `N`. The actual cross-session
   safety invariant is ORDERING: rejections settle only on message receipt
   from the live socket (no settle after a drop), so a stale `.catch` always
   drains as a microtask against the OLD predictor, ≥1 s before the reconnect
   timer creates the new one. Comment fixed at the `sendIntent` `.catch`.

Also from review: `reduceErrorMessage` / `subscriptionErrorMessage` gained
try/catch totality against hostile accessors (RT-05), and the gating tests
gained exact-name-equality teeth (an `includes()` classifier survived the
original suite), a real assertion replacing the vacuous `tailStillPending`
helper, and an immediate-convergence assertion in the 13.5b-4 GREEN test.

## Amendment (ptc5f, 2026-07-24 — Decision E accepted risk, ADR-0142)

The M-playtest-c.5 eleventh review (Decision E, Drew-delegated 2026-07-20) found
that the A2 "ordering" safety argument above (amendment §3, RT-03) covers the
**reconnect** path only, and recorded the uncovered **own-zone warp** case as an
explicit accepted risk for the closed-playtest window. The epoch/generation-guard
**fix is deferred** to the booked post-gate slice `M-postgate-netcode-hardening`
(PLAN §9 post-gate block, owner Drew); this amendment + a reachability pin are the
pre-gate deliverable (no behavior change).

**The gap.** A2's ordering invariant — "a stale `.catch` always drains against
the OLD predictor ≥1 s before the reconnect timer builds the new one" — depends
on the socket being **dropped** (in-flight reducer promises never settle after a
drop; SDK evidence above). An **own-zone warp** takes a different path:
`switchZone → resetPredictionState()` (main.ts) rebuilds the `Predictor`
**synchronously on a live socket** — no drop, no ≥1 s reconnect delay. So a
still-unacked pre-warp `enqueue_move` rejection CAN still settle *after* the
rebuild, and reconcile re-seeds the fresh predictor's `#nextSeq` at `ackedSeq`,
handing the next new op the SAME seq the pre-warp op held. The stale
`.catch → predictor.dropRejected(seq)` (main.ts `sendIntent`) then evicts the
**new, legitimate** op instead of the (already-gone) pre-warp one.

**Reachability bound (pinned).** Within a single predictor `#nextSeq` is strictly
increasing and never reused, so `dropRejected` only ever evicts the intended dead
op — the normal case is safe. Eviction of a *legit* op is reachable **only across
a predictor rebuild that re-seeds a colliding seq**, i.e. a movement rejection
landing exactly across a warp. `predictor.test.ts` pins this: `dropRejected` is
precise within one epoch, and evicts a live op only in the rebuilt+re-seeded
cross-warp scenario. A comment at `Predictor.dropRejected` records the gap and
points here + at the booked fix.

**Accepted-risk rationale (reachability corrected — ptc5f red-team pass).** The
original Decision-E framing called the trigger "effectively unreachable for a
single tester (no contention → no queue-full rejections)". A red-team pass on
this slice showed that is **understated**: `MOVE_QUEUE_CAP = 2` is per-character,
so a lone player holding a key through a warp can hit "queue full" alone; and the
seq reuse itself produces a rejection — the fresh predictor re-issues
`ackedSeq+1`, the older in-flight op of the same seq is acked first on the FIFO
socket (`last_input_seq → ackedSeq+1`), so the new op's identical seq then hits
`seq <= last_input_seq` → **`"stale seq"`** (`guards.rs`), whose `.catch`
`dropRejected`s the player's first post-warp move. So the real trigger is
"**walk through a doorway while holding a direction key**", reachable in **solo**
play — a swallowed first-post-warp input / brief rubber-band. The fix stays
deferred (Drew-delegated; retuning ADR-0085-lineage prediction code pre-gate is
behavior-sensitive and out of the ptc5f docs-slice scope), but the risk is
recorded accurately, not minimized. The guard (Predictor captures a `buildGen`
epoch; the `.catch` no-ops when its captured epoch ≠ the current predictor's)
lands in `M-postgate-netcode-hardening` — and ptc5f's handoff/PR recommends Drew
weigh pulling it forward of / into the playtest rather than treating it as
negligible.
