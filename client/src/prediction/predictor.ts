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
// only IntentToSend out and a (seq, epoch) pair into dropRejected (simplify F2, m13.5b; nh3).
interface PendingOp {
  readonly seq: number;
  readonly op: QueueOp;
}

/**
 * nh3 (ADR-0152): the predictor's generation identifier — a BRANDED number, not a bare
 * alias. The brand makes it a compile error to pass a plain number (e.g. the seq itself)
 * where a generation is required, so the self-approving call `dropRejected(seq, seq)` is
 * unwriteable at every call site. Values are minted ONLY at `Predictor` construction (one
 * per instance, strictly increasing module-wide) and are readable ONLY from an issued
 * `IntentToSend` — deliberately no public accessor on the class (plan A8), so a caller
 * cannot read the LIVE value and vacuously self-approve a rejection.
 */
export type PredictorEpoch = number & { readonly __brand: unique symbol };

/** What `enqueue`/`setMove`/`clearQueue` surface for M4 to send to the M2 reducers. */
export interface IntentToSend {
  readonly seq: number;
  readonly op: QueueOp;
  /** The issuing instance's generation (nh3): captured as a primitive at send time and
   *  passed back to `dropRejected`, so a stale rejection addressed to a discarded
   *  predictor can be told apart from a live one. */
  readonly epoch: PredictorEpoch;
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
  // nh3 (ADR-0152): module-wide generation counter — class-scoped rather than loose
  // module state (same idiom as connection.ts's buildGen, different scope). Pre-
  // incremented at construction, so the first epoch is 1 and a plausible literal 0
  // can never match any instance.
  static #nextEpoch = 0;

  readonly #applyMove: ApplyMove;
  readonly #stepMs: number;
  readonly #queueCap: number;
  readonly #pendingCap: number; // ADR-0013.5: unacked-ops backpressure bound
  readonly #epoch: PredictorEpoch; // nh3: this instance's generation, constructor-assigned ONCE

  #predicted: WasmCharacterState | undefined; // undefined until the first own-row seeds it
  #queue: WasmMoveInput[] = []; //               the LOCAL intent queue
  #pending: PendingOp[] = []; //                  unacked ops, in send order
  #nextSeq = 0;
  // ADR-0052 §B / M12.5d-3: only the FRAME-LOOP drain() updates this — reconcile's
  // internal #stepForward() does NOT. This prevents a reconcile-drain (fired from the
  // batch listener between rAF frames) from masking a large inter-frame gap; a
  // backgrounded-tab wake correctly produces snapped=true on the next frame drain.
  #lastFrameDrainAt: number | undefined = undefined;
  // nh2 (ADR-0148): the server's undrained `move_queue` length AS OF the last reconcile.
  // Written ONLY by reconcile(), from the same coherent snapshot as #queue/#predicted.
  // Between reconciles it is deliberately stale — that staleness IS the closed loop the
  // held-key continuation gate rides on (see `outstandingSteps`).
  #lastAuthQueueLen = 0;

  // ADR-0013.5: `pendingCap` is OPTIONAL; default 16 ≈ 16·STEP_MS of un-acked
  // prediction — a generous degenerate-no-ack backstop (normal ack cadence keeps
  // `#pending` near 0), comfortably ≥ `queueCap` (=2) so it never inverts the
  // queue cap. Existing 3-arg construction is unaffected by the new bound.
  constructor(applyMove: ApplyMove, stepMs: number, queueCap: number, pendingCap = 16) {
    this.#applyMove = applyMove;
    this.#stepMs = stepMs;
    this.#queueCap = queueCap;
    this.#pendingCap = pendingCap;
    // nh3: assigned ONCE here — #record must never re-read the static counter (a
    // per-record read would stamp intents from ONE instance with drifting generations
    // whenever another instance is constructed in between; N5 pins this). The single
    // `as PredictorEpoch` cast in the codebase lives at this mint site.
    this.#epoch = ++Predictor.#nextEpoch as PredictorEpoch;
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
    return { seq, op, epoch: this.#epoch }; // nh3: stamp the constructor-assigned generation
  }

  /**
   * Evict the pending op with exactly this `seq` (M13.5b, ADR-0085) — PROVIDED the
   * rejection belongs to THIS predictor generation (nh3, ADR-0152). `epoch` is the
   * generation the caller captured from the issued intent at send time; when it is
   * not this instance's own, the call is a TOTAL no-op — returns `false`, mutates
   * nothing — because the rejection was addressed to a discarded (pre-warp /
   * pre-reconnect) instance's op, not to anything this instance owns. Otherwise
   * returns true iff an op was removed; an unknown/already-dropped seq is an
   * idempotent no-op (false, no state change).
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
   * nh3 epoch guard (ADR-0152, closing the ptc5f/ADR-0142 D4 accepted risk): within
   * ONE predictor `#nextSeq` is strictly increasing and never reused, so this evicts
   * exactly the intended dead op. ACROSS an own-zone warp, `resetPredictionState()`
   * rebuilds the predictor on a LIVE socket, so a still-in-flight pre-warp rejection
   * can land after the rebuild while its seq collides with a fresh op's. The guard
   * makes that cross-instance stale rejection a no-op (Case M1: the captured
   * generation can never match the fresh instance — the counter only goes up), and
   * main.ts's send-seq floor (`lastSentSeq` → `seedSeq` on rebuild) prevents the
   * rebuilt predictor from ever re-issuing an already-sent seq, so the post-rebuild
   * "stale seq" rejection of the player's first post-warp move never comes into
   * existence (Case M2). The nh3-2 block in predictor.test.ts pins both.
   */
  dropRejected(seq: number, epoch: PredictorEpoch): boolean {
    // nh3: the generation guard comes FIRST and is TOTAL — a foreign epoch means the
    // rejection targets a dead instance's op, and touching #pending here would evict
    // a live op purely by seq collision. `false` also keeps the caller's contract
    // coherent: nothing was removed, so no forced reconcile is owed.
    if (epoch !== this.#epoch) return false;
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
    // nh2 (ADR-0148): record the authoritative queue depth BEFORE the ADR-0012 four-step,
    // so it is visibly outside it. Reads only the `authQueue` parameter.
    this.#lastAuthQueueLen = authQueue.length;
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

  /**
   * nh2 (ADR-0148): how far prediction is allowed to run AHEAD of authority — the steps the
   * SERVER still owes: its undrained `move_queue` as of the last reconcile, plus every op
   * sent but not yet seen acked. M4 gates the HELD-KEY continuation re-issue on this being
   * 0, which bounds the pipeline to one in-flight step instead of one per animation frame.
   *
   * NOT "tiles I will still travel": reconcile step 4 has already drained the authoritative
   * entries into `#predicted`.
   *
   * `queueDepth` CANNOT serve this role. The ADR-0012 baseline is rebased to
   * `now - 2*stepMs` (convert.ts `characterToPredictedBaseline`), so every reconcile drains
   * `#queue` to empty — it reads 0 while the server still owes work, which is exactly the
   * over-emission this gate exists to stop.
   *
   * The two terms never double-count: `authorize_move` writes the ack in the SAME
   * transaction as the queue push (server guards.rs), so anything in `authQueue` is already
   * acked and has been pruned from `#pending` by reconcile's `seq > ackedSeq` filter. The
   * reconcile cap-clamp can make this OVER-count, which is the safe direction (it keeps the
   * gate shut). It never UNDER-counts *within one predictor generation*.
   *
   * OPEN RESIDUAL (named, deliberately NOT fixed by nh3): a fresh `Predictor` (zone warp /
   * reconnect, main.ts `resetPredictionState`) starts with `#lastAuthQueueLen = 0` while the
   * server may still owe a queued step, so exactly one extra continuation can slip through
   * per rebuild. nh3 (ADR-0152) closed the OTHER two rebuild hazards in this family — the
   * cross-generation EVICTION (the `dropRejected` epoch guard) and, with the main.ts
   * send-seq floor, the seq COLLISION itself — but neither touches this under-count. Its
   * window is near-zero in practice, for a DIFFERENT reason per rebuild path (desync-guard
   * review, nh3): on a zone warp the rebuild is followed in the SAME microtask flush by a
   * reconcile (the warp's own row burst → MicrotaskBatcher → reconcileFromStore), which
   * rewrites `#lastAuthQueueLen` from the authoritative queue; on a RECONNECT that reconcile
   * is deferred (the server's on_disconnect deleted the player/character rows, so
   * reconcileFromStore early-returns until joinGame round-trips), and the guarantee rests on
   * `held.clear()` ALONE — no held continuation survives the rebuild, so nothing emits into
   * the gap. That makes `held.clear()` load-bearing for the reconnect arm: an nh5-style
   * change to held-key retention across rebuilds must revisit this residual. Bounded and
   * self-correcting on the next reconcile either way.
   */
  get outstandingSteps(): number {
    return this.#lastAuthQueueLen + this.#pending.length;
  }

  /** The direction of the last queued move if it is a Step, else undefined (a Jump
   *  or an empty queue) — M4 uses it to avoid issuing a duplicate held direction. */
  get lastQueuedDir(): WasmDirection | undefined {
    const last = this.#queue[this.#queue.length - 1];
    if (last === undefined || last === 'Jump') return undefined;
    return last.Step;
  }
}
