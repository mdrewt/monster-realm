# 0052. Bounded client prediction to the move-queue cap (no over-prediction rubberband)

**Status:** Accepted
**Date:** 2026-06-27
**Slice:** m8.5f
**Supersedes:** —
**Amends:** —
**Subsystems:** movement-netcode, client-ui
**Decision:** Bound client-side move prediction to the server MOVE_QUEUE_CAP; reject over-cap enqueues rather than allowing over-prediction rubber-band.


- Status: accepted
- Date: 2026-06-27
- Milestone: M8.5f (netcode & client robustness / SSOT)

> **ADR numbering note.** The M8.5 spec proposes stale ADR numbers throughout (it
> predates M8d/M8.5a–e). The next free number at the time of this slice is **0052**
> (0044–0051 are filed). Allocated here; this ADR is the SSOT for the decision.

## Context and problem statement

The client predicts player movement locally (ADR-0012/0013): `Predictor.enqueue`
buffers a move in a local `#queue`, records an unacked op in `#pending`, and sends an
`enqueue_move` intent to the server; `drain` applies due moves paced by `STEP_MS`;
`reconcile` rebuilds `#queue = authQueue + replay(unacked pending ops)`, resets the
predicted position to authoritative truth, and re-drains. The server bounds its
authoritative `move_queue` at `MOVE_QUEUE_CAP` (= 2, `game-core/src/world.rs`):
`enqueue_move` **rejects** (returns `Err`) when the queue is full (reject-not-clamp).

**The desync (NET-1).** The client `enqueue` did **not** bound to the cap. A burst of
N > cap move inputs:

1. The client predicts all N over time (`drain` applies them, paced).
2. The server accepts only `cap` and rejects the rest.
3. The rejected moves' pending ops keep `seq > ackedSeq` (the server's `last_input_seq`
   never advanced past the accepted moves), so `reconcile` **replays** them onto the
   rebuilt `#queue` → the client stays `N - cap` tiles **ahead of authority,
   permanently**, until a later accepted move flushes the stale pending. That is a
   persistent forward mis-prediction — a rubberband the player sees as their character
   running ahead and snapping back.

A read-only multi-lens review of the *fix design* found that the obvious one-line fix —
bound `enqueue` on `#queue.length` — is **necessary but not sufficient**: when the
server holds a move the client did not yet know about, `reconcile` rebuilds
`#queue = authQueue + replay(unacked)` which can itself exceed the cap (e.g.
`authQueue = [Z]`, replay `[A, B]` → `[Z, A, B]`, length 3 > cap 2), re-introducing the
over-prediction through the reconcile path. The cap must be enforced wherever `#queue`
is mutated, not only on append.

## Decision

**Enforce the move-queue-cap invariant on the client `#queue` at both mutation points,
single-sourced from the same `MOVE_QUEUE_CAP` the server enforces** (already injected
into the `Predictor` as `#queueCap` via the `move_queue_cap()` wasm export, ADR-0003
SSOT). Mirror the server's reject-when-full / keep-head semantics:

1. **`enqueue` is bounded (reject-not-clamp).** When `#queue.length >= #queueCap`,
   `enqueue` does **not** push, does **not** record a pending op (no `seq` is consumed),
   and returns `undefined` — the move is *declined*, exactly as the server declines an
   over-cap enqueue. `main.ts`'s `sendIntent` skips the reducer call on `undefined`, so
   the client never predicts (or sends) a move the server will reject. `setMove`/
   `clearQueue` are unchanged: they replace/empty the queue (length ≤ 1), so they are
   cap-safe by construction — adding a cap check there would wrongly block a legal
   direction change.
2. **`reconcile` clamps the rebuilt queue to the cap (head).** After replaying unacked
   ops, `#queue = q.slice(0, #queueCap)`. The server, when full, keeps the head and
   rejects later moves (FIFO + reject-when-full); the client's projection of the server
   queue must obey the same bound. This makes the over-prediction unrepresentable even
   when the authoritative queue surprises the client.

Together these make the mispredicted tile **unrepresentable by construction**: the
client never predicts more than `cap` moves ahead of authority, the exact bound the
server enforces. `drain`'s existing `maxApply` becomes naturally cap-bounded because
`#queue.length <= #queueCap` at all times.

**The server is left unchanged except for a clarifying comment.** SpacetimeDB rolls the
whole transaction back when `enqueue_move` returns `Err("queue full")`, so the
accept-time ack (`player.last_input_seq = seq`, written in `authorize_move`) is rolled
back on rejection — i.e. the server *already* "acks only on a successful enqueue", by
transaction semantics. The client cap-invariant additionally makes an over-cap enqueue
unreachable from the real client. A comment at the ack site records this guarantee so a
future refactor does not silently break it.

### Considered and rejected

- **Server ack restructuring (split `authorize_move` so the ack lands only after the
  cap check).** Rejected as unnecessary complexity (YAGNI): the rollback already
  guarantees ack-only-on-success, and the client cap-invariant makes the over-cap path
  unreachable from the real client. The split is a multi-caller refactor
  (`enqueue_move`/`set_move`/`clear_queue` all share `authorize_move`) that risks a
  missed ack (→ unbounded `#pending` growth) for zero behavioural benefit on the happy
  path. A clarifying comment captures the invariant instead.
- **Client routes the reducer rejection into an async pending-op rollback** (spec
  option b). Rejected as racy and higher-surface: correctness would depend on the SDK
  rejection round-trip landing before `drain` paces out the mispredicted tile, and it
  requires net-new reducer-rejection routing in `connection.ts`/`main.ts` (a seam
  `connection.ts` explicitly deferred and never built). Bounded prediction closes the
  same gap by construction, with no SDK coupling in the prediction core.
- **Silently clamping the queue / position.** Rejected — violates reject-not-clamp; the
  client declines the over-cap move (as the server does), it does not truncate or warp.

## Consequences

- **Positive.** No persistent over-prediction rubberband; the predictor never runs more
  than `cap` tiles ahead of authority. The cap stays single-sourced (no new client
  literal). The predictor remains SDK-free and node-unit-testable. Wasted reducer
  round-trips for doomed over-cap moves are eliminated.
- **Accepted residual — small forward correction under drain lag.** The client bounds on
  its local `#queue.length`, which tracks the server's `move_queue.len()` to within
  ~one step (both drain on the `STEP_MS` cadence). Under network jitter the client may
  occasionally decline a move the server would have accepted, under-predicting by one
  tile; the next `reconcile` snaps the predicted tile *forward* toward truth. A forward
  correction toward authority is self-healing and ADR-0013-acceptable (the slide clock
  smooths it) — strictly better than the unbounded backward rubberband this ADR removes.
- **Accepted residual — held-key cliff at high latency.** With `MOVE_QUEUE_CAP = 2` and
  `STEP_MS = 200 ms`, a held key buffers ≤ 400 ms of movement; if round-trip latency
  exceeds `STEP_MS`, the player can skip a server tick (movement rate halves on a poor
  connection). This is inherent to the small cap, not introduced here; tuning the cap
  (server + client move together via the SSOT) is a future game-feel decision.
- **Pre-existing residual — unbounded `#pending` under sustained no-ack (flagged, not
  fixed).** `setMove`/`clearQueue` record a pending op unconditionally (unchanged by
  this slice), so under a long ack outage (packet loss) with rapid input, `#pending`
  grows without bound and `reconcile`'s O(n) replay degrades. This slice does not
  worsen it (the `enqueue` path is now *bounded* — a declined enqueue records nothing),
  and a reconnect re-seeds a fresh predictor (clearing `#pending`); on a healthy
  connection acks arrive every batch so `#pending` stays small. A proper bound needs a
  resync strategy (you cannot simply truncate unacked ops) — deferred to a future
  netcode-hardening pass. A red-team "double-count" scenario (`setMove` then a
  follow-up `enqueue`, reconciled before the server processes the enqueue) was triaged
  as a **false positive**: the follow-up enqueue is a legitimately-unacked in-flight
  move the server (queue not full) will accept, so predicting both moves is correct
  prediction-ahead, not an over-prediction — parity is restored when the server
  processes the enqueue.
- **Pre-existing residual — reconnect seq race (flagged, not fixed).** On a disconnect
  the server deletes the `player` row and `join_game` re-creates it with
  `last_input_seq = 0`, so the post-reconnect fresh predictor (`#nextSeq = 0`) is in
  step in steady state. A narrow race exists if an in-flight pre-disconnect message is
  processed after reconnect but before `on_disconnect` (seq would briefly look stale);
  the window is ~one RTT and out of scope for this slice. Recorded for a future netcode
  hardening pass.
- **`enqueue` contract widened** to `IntentToSend | undefined`; callers must treat
  `undefined` as "declined, do not send". Documented on the method.
