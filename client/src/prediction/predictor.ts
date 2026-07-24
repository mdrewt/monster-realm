// predictor.ts — the client-side prediction layer (ADR-0012/0013). M3b.
//
// Runs the SAME compiled movement rule locally (an injected `applyMove`, the
// client-wasm export) so the browser moves the player the instant a key is
// pressed, and reconciles against the authoritative SpacetimeDB stream so the
// server stays the final authority. This module is the headless core: it does NOT
// connect, subscribe, render, capture input, or run the per-frame loop (all M4).
//
// The rule itself lives once in game-core and is proven in Rust (M1) + at the wasm
// boundary (the parity evals); here `applyMove` is a dependency so this layer is
// unit/property-testable node-only against a faked authoritative stream.
import type { WasmCharacterState, WasmDirection, WasmMoveInput } from '../convert/convert';

/** The injected movement rule — identical signature to client-wasm `apply_move`. */
export type ApplyMove = (
  state: WasmCharacterState,
  input: WasmMoveInput,
  now: number,
) => WasmCharacterState;

/**
 * A QUEUE operation (not a raw move) recorded in `pending`. Recording ops — not
 * moves — is the load-bearing correctness choice: a mid-flight `SetMove` must
 * replay during reconcile as a *replace*, and a `Clear` as an *empty*, onto the
 * server's authoritative queue. Treating `pending` as raw moves silently
 * mispredicts during the paced drain (a proof-of-teeth fixture catches it).
 */
export type QueueOp =
  | { readonly kind: 'Enqueue'; readonly input: WasmMoveInput }
  | { readonly kind: 'SetMove'; readonly input: WasmMoveInput }
  | { readonly kind: 'Clear' };

// Internal bookkeeping shape of #pending — deliberately unexported: callers see
// only IntentToSend out and a bare seq into dropRejected (simplify F2, m13.5b).
interface PendingOp {
  readonly seq: number;
  readonly op: QueueOp;
}

/** What `enqueue`/`setMove`/`clearQueue` surface for M4 to send to the M2 reducers. */
export interface IntentToSend {
  readonly seq: number;
  readonly op: QueueOp;
}

export interface DrainResult {
  /** How many queued moves were applied this drain (bounded by the queue). */
  readonly applied: number;
  /** True when the gap since the last drain is large (backgrounded tab): M4 should
   *  JUMP the render to `predicted` rather than animate the backlog (ADR-0013). */
  readonly snapped: boolean;
}

/** Apply a queue op to a move-queue (the reconcile replay primitive). */
function applyOp(queue: readonly WasmMoveInput[], op: QueueOp): WasmMoveInput[] {
  switch (op.kind) {
    case 'Enqueue':
      return [...queue, op.input];
    case 'SetMove':
      return [op.input]; // replace, not append
    case 'Clear':
      return [];
  }
}

/** A local time gap (since the last drain) beyond this many steps trips a snap. */
const SNAP_GAP_STEPS = 4;

/**
 * Bound the server's authoritative `last_input_seq` (a u64 `bigint`) before it enters
 * the predictor's number-typed seq space (`reconcile`'s `ackedSeq` and `seedSeq`).
 *
 * The seq increments once per accepted intent; at the ADR-0052 step cadence reaching
 * 2^53 would take tens of thousands of years, so the narrowing is safe in practice —
 * but we ASSERT it rather than trust it. A u64 above `MAX_SAFE_INTEGER` cannot be
 * represented exactly as a JS number and would silently alias a LOWER value, which
 * could resurrect already-acked pending or false-drop in-flight ops; a negative input
 * means the caller is corrupt/hostile. Fail loud in either case (mirroring convert.ts's
 * bounded `moveStartedAtMs` downcast precedent) instead of silently wrapping.
 */
export function boundSeq(seq: bigint): number {
  if (seq < 0n || seq > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`last_input_seq ${seq} outside the safe-integer seq bound`);
  }
  return Number(seq);
}

export class Predictor {
  readonly #applyMove: ApplyMove;
  readonly #stepMs: number;
  readonly #queueCap: number;
  readonly #pendingCap: number; // ADR-0013.5: unacked-ops backpressure bound

  #predicted: WasmCharacterState | undefined; // undefined until the first own-row seeds it
  #queue: WasmMoveInput[] = []; //               the LOCAL intent queue
  #pending: PendingOp[] = []; //                  unacked ops, in send order
  #nextSeq = 0;
  // ADR-0052 §B / M12.5d-3: only the FRAME-LOOP drain() updates this — reconcile's
  // internal #stepForward() does NOT. This prevents a reconcile-drain (fired from the
  // batch listener between rAF frames) from masking a large inter-frame gap; a
  // backgrounded-tab wake correctly produces snapped=true on the next frame drain.
  #lastFrameDrainAt: number | undefined = undefined;

  // ADR-0013.5: `pendingCap` is OPTIONAL; default 16 ≈ 16·STEP_MS of un-acked
  // prediction — a generous degenerate-no-ack backstop (normal ack cadence keeps
  // `#pending` near 0), comfortably ≥ `queueCap` (=2) so it never inverts the
  // queue cap. Existing 3-arg construction is unaffected by the new bound.
  constructor(applyMove: ApplyMove, stepMs: number, queueCap: number, pendingCap = 16) {
    this.#applyMove = applyMove;
    this.#stepMs = stepMs;
    this.#queueCap = queueCap;
    this.#pendingCap = pendingCap;
  }

  // --- input: mutate the QUEUE (+ record the op in pending), never `predicted` ---

  /**
   * Enqueue a move, bounded to the move-queue cap (reject-not-clamp, ADR-0052) AND
   * to the unacked-ops pending cap (backpressure, ADR-0013.5). When the local
   * `#queue` is already at `#queueCap`, OR `#pending` is already at `#pendingCap`,
   * the move is *declined*: no push, no pending op recorded (no `seq` consumed),
   * returns `undefined` — exactly as the server declines an over-cap enqueue. The
   * pending cap is BACKPRESSURE, not eviction: ops already in `#pending` are NEVER
   * dropped (that would desync the reconcile replay). Callers must treat `undefined`
   * as "declined, do not send". Otherwise records an Enqueue op and returns the intent.
   *
   * The pending cap is enforced HERE — `enqueue` is the only un-acked-burst growth
   * path (the integrated client's held-key frame-loop routes through it). `setMove`/
   * `clearQueue` intentionally always record: they are infrequent DESTRUCTIVE ops
   * whose pending op SUPERSEDES prior pending in reconcile replay (see the M3 replay
   * tests), so gating them would be semantically wrong, and the client has no
   * high-frequency caller of them — a future such caller under sustained no-ack would
   * need its own bound (documented residual, M8.6c).
   */
  enqueue(input: WasmMoveInput): IntentToSend | undefined {
    if (this.#queue.length >= this.#queueCap || this.#pending.length >= this.#pendingCap)
      return undefined; // ADR-0052: queue full / ADR-0013.5: pending full
    this.#queue.push(input);
    return this.#record({ kind: 'Enqueue', input });
  }

  setMove(input: WasmMoveInput): IntentToSend {
    this.#queue = [input]; // replace the whole queue with this single move
    return this.#record({ kind: 'SetMove', input });
  }

  clearQueue(): IntentToSend {
    this.#queue = [];
    return this.#record({ kind: 'Clear' });
  }

  #record(op: QueueOp): IntentToSend {
    const seq = ++this.#nextSeq; // strictly increasing
    this.#pending.push({ seq, op });
    return { seq, op };
  }

  /**
   * Evict the pending op with exactly this `seq` (M13.5b, ADR-0085). Returns true
   * iff an op was removed; unknown/already-dropped seq is an idempotent no-op
   * (false, no state change).
   *
   * WHY: this is eviction of a KNOWN-DEAD op — the server rejected the reducer call
   * (its accept-time ack write rolled back with the transaction on `Err`), so the
   * seq will NEVER be acked and the op would otherwise survive reconcile's
   * `seq > ackedSeq` prune forever, replaying a phantom move onto the authoritative
   * queue at every reconcile (the silent 1-tile desync with diverged=false). That is
   * categorically different from the `#pendingCap` backpressure (ADR-0013.5), which
   * NEVER drops recorded ops — it only declines new ones.
   *
   * Mutates ONLY `#pending`; never touches `#queue` (reconcile step 2 is the ONLY
   * `#queue` rebuilder — a single source of truth) and never touches `#nextSeq`
   * (a rejected seq is consumed, not recycled). Because `#queue` still reflects the
   * phantom until the next reconcile, on a `true` return the caller MUST immediately
   * force a reconcile from current store state (main.ts `reconcileFromStore()`);
   * a `false` return needs no forced reconcile — nothing was removed.
   *
   * ptc5f epoch-eviction pin (ADR-0085 amendment / ADR-0142 D4): within ONE
   * predictor `#nextSeq` is strictly increasing and never reused, so this evicts
   * exactly the intended dead op. ACROSS an own-zone warp, though,
   * `resetPredictionState()` rebuilds the predictor on a LIVE socket and reconcile
   * re-seeds `#nextSeq` at `ackedSeq`, so a still-in-flight pre-warp op and the
   * fresh predictor's next op share a seq — a stale rejection's `.catch` can then
   * `dropRejected` the NEW legit op (a swallowed first-post-warp move, reachable in
   * SOLO play by warping while holding a key). Accepted risk for the closed
   * playtest; the epoch/generation guard is DEFERRED to
   * `M-postgate-netcode-hardening`. predictor.test.ts pins this reachability bound.
   */
  dropRejected(seq: number): boolean {
    const before = this.#pending.length;
    this.#pending = this.#pending.filter((p) => p.seq !== seq);
    return this.#pending.length !== before;
  }

  /**
   * Re-seed the sequence counter to at least `seq` so the next `#record` yields a
   * seq strictly greater than `seq`. MONOTONIC — only ever raises `#nextSeq`, never
   * lowers it.
   *
   * WHY (ADR-0012 reconnect): a reconnect builds a FRESH `Predictor` whose `#nextSeq`
   * restarts at 0, while the server has persisted a far-higher `player.last_input_seq`.
   * Without re-seeding, every post-reconnect intent records a seq ≤ the server's ack,
   * so `reconcile`'s `seq > ackedSeq` filter drops it on the next snapshot — the player
   * appears frozen. Seeding `#nextSeq` to the server ack fixes that: the next intent's
   * seq clears the ack and survives. It is MONOTONIC (`>` guard) so a stale/duplicate
   * snapshot can never rewind the counter and alias/replay an already-sent seq.
   */
  seedSeq(seq: number): void {
    if (seq > this.#nextSeq) this.#nextSeq = seq;
  }

  // --- reconcile: the ADR-0012 four-step against ONE coherent snapshot -----------

  /**
   * Reconcile against an authoritative own-row update. `authBaseline` is the row's
   * CharacterState already rebased to local time (see convert.characterToPredictedBaseline);
   * `authQueue` is the server's move_queue; `ackedSeq` is the server's last_input_seq.
   * Returns `true` iff the corrected tile differs from the pre-reconcile predicted
   * tile (a genuine server disagreement), so M4 can clear a committed direction and
   * re-issue a held key. Returns `false` on agreement and on the seeding reconcile.
   */
  reconcile(
    authBaseline: WasmCharacterState,
    authQueue: readonly WasmMoveInput[],
    ackedSeq: number,
    now: number,
  ): boolean {
    const before = this.#predicted?.pos;
    // 1. drop acked pending.
    this.#pending = this.#pending.filter((p) => p.seq > ackedSeq);
    // 2. rebuild the local queue from the server's queue, then replay unacked OPS.
    let q: WasmMoveInput[] = [...authQueue];
    for (const p of this.#pending) q = applyOp(q, p.op);
    // Clamp the rebuilt queue to the cap (keep-head), mirroring the server's
    // reject-when-full semantics — the over-prediction stays unrepresentable even
    // when the authoritative queue surprises the client (ADR-0052).
    this.#queue = q.slice(0, this.#queueCap);
    // 3. reset prediction to the authoritative (rebased) truth.
    this.#predicted = authBaseline;
    // 4. re-drain forward from truth (private: does NOT update #lastFrameDrainAt so
    //    the frame loop's subsequent drain() still sees the real inter-frame gap).
    this.#stepForward(now);

    if (before === undefined) return false; // seeding reconcile is never a divergence
    const after = this.#predicted.pos;
    return after.x !== before.x || after.y !== before.y;
  }

  // --- drain: step_ms-paced catch-up (discrete tiles, never a teleport) ----------

  /**
   * Apply queued moves that are now due: advance logical time by `stepMs` per move
   * (never snap to `now`) so a large gap catches up as discrete one-tile steps.
   * Private — called ONLY by drain() and reconcile() step 4. Does NOT touch
   * `#lastFrameDrainAt` so reconcile drains cannot mask inter-frame gaps.
   */
  #stepForward(now: number): number {
    if (this.#predicted === undefined) return 0;
    // `#queue.length <= #queueCap` is invariant (ADR-0052).
    const maxApply = this.#queueCap;
    let applied = 0;
    while (
      applied < maxApply &&
      this.#queue.length > 0 &&
      this.#predicted.move_started_at + this.#stepMs <= now
    ) {
      const logicalT = this.#predicted.move_started_at + this.#stepMs;
      const move = this.#queue.shift() as WasmMoveInput;
      this.#predicted = this.#applyMove(this.#predicted, move, logicalT);
      applied += 1;
    }
    return applied;
  }

  /**
   * Frame-loop drain: detect inter-frame gaps, advance prediction by due moves, and
   * update `#lastFrameDrainAt`. Called ONLY from the rAF frame loop (M4c).
   *
   * Bounded prediction (ADR-0013/0052): a single drain applies at most `#queueCap`
   * moves (the queue invariant holds by construction), so the predictor never runs
   * more than the cap ahead of authority. `snapped` is true when the gap since the
   * last FRAME drain (not since the last reconcile drain) exceeds SNAP_GAP_STEPS —
   * the M4 loop should jump the renderer rather than animate a backlog.
   */
  drain(now: number): DrainResult {
    if (this.#predicted === undefined) return { applied: 0, snapped: false };
    // ADR-0052 §B / M12.5d-3: gap is measured from the last FRAME drain only.
    // First frame drain (#lastFrameDrainAt undefined) never snaps — no prior frame.
    const snapped =
      this.#lastFrameDrainAt !== undefined &&
      now - this.#lastFrameDrainAt > SNAP_GAP_STEPS * this.#stepMs;
    this.#lastFrameDrainAt = now;
    const applied = this.#stepForward(now);
    return { applied, snapped };
  }

  // --- read accessors (M4 flow-controls + dedups against these) -------------------

  get predicted(): WasmCharacterState | undefined {
    return this.#predicted;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  get queueDepth(): number {
    return this.#queue.length;
  }

  /** The direction of the last queued move if it is a Step, else undefined (a Jump
   *  or an empty queue) — M4 uses it to avoid issuing a duplicate held direction. */
  get lastQueuedDir(): WasmDirection | undefined {
    const last = this.#queue[this.#queue.length - 1];
    if (last === undefined || last === 'Jump') return undefined;
    return last.Step;
  }
}
