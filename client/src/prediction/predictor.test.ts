// Predictor behaviour suite (M3b, ADR-0012/0013) — vitest + fast-check.
// SOURCE OF TRUTH: specs/monster-realm-v2/M3-client-prediction.spec.md §3.
// These tests are derived strictly from the acceptance criteria and are written
// to start RED: `./predictor` does not exist yet (the implementer builds it).
//
// The Predictor is exercised against a DETERMINISTIC, node-only `applyMove`
// stand-in injected as a constructor dependency — we never import wasm here (the
// movement rule itself is proven in Rust at M1; this suite proves the *queue +
// reconcile + drain* orchestration). The fake mirrors game-core movement over a
// tiny map: a west wall at x <= 0, everything else walkable. Screen coords:
// North = y-1, South = y+1, East = x+1, West = x-1.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WasmCharacterState, WasmDirection, WasmMoveInput } from '../convert/convert';
import { type ApplyMove, type IntentToSend, Predictor, type QueueOp } from './predictor';

const STEP_MS = 200;
const QUEUE_CAP = 8;

// --- the injected deterministic applyMove fake (game-core movement, tiny map) ---
// Walls at x <= 0 (west border): a West step from x=1 bumps (Idle, no move).
// Everything else is walkable. A Jump moves one tile in `facing` (hop in place if
// blocked). `move_started_at` is stamped to floor(now) on every call.
function step(dir: WasmDirection, x: number, y: number): { x: number; y: number } {
  switch (dir) {
    case 'North':
      return { x, y: y - 1 };
    case 'South':
      return { x, y: y + 1 };
    case 'East':
      return { x: x + 1, y };
    case 'West':
      return { x: x - 1, y };
  }
}
function walkable(p: { x: number; y: number }): boolean {
  return p.x > 0; // west wall at x <= 0
}

const applyMove: ApplyMove = (state, input, now): WasmCharacterState => {
  const stamp = Math.floor(now);
  if (input === 'Jump') {
    const target = step(state.facing, state.pos.x, state.pos.y);
    const pos = walkable(target) ? target : state.pos; // hop in place if blocked
    return { ...state, pos, action: 'Jumping', move_started_at: stamp };
  }
  // Step(dir): face the dir, move if walkable, else bump (Idle, stay put).
  const dir = input.Step;
  const target = step(dir, state.pos.x, state.pos.y);
  if (walkable(target)) {
    return { pos: target, facing: dir, action: 'Walking', move_started_at: stamp };
  }
  return { ...state, facing: dir, action: 'Idle', move_started_at: stamp };
};

// --- small helpers --------------------------------------------------------------
function mkPredictor(): Predictor {
  return new Predictor(applyMove, STEP_MS, QUEUE_CAP);
}
function east(): WasmMoveInput {
  return { Step: 'East' };
}
function west(): WasmMoveInput {
  return { Step: 'West' };
}
function north(): WasmMoveInput {
  return { Step: 'North' };
}
function jump(): WasmMoveInput {
  return 'Jump';
}

/** An authoritative baseline already rebased to a local-time stamp (what M4 feeds). */
function baseline(
  x: number,
  y: number,
  rebasedAt: number,
  facing: WasmDirection = 'East',
): WasmCharacterState {
  return { pos: { x, y }, facing, action: 'Idle', move_started_at: rebasedAt };
}

// fast-check arbitraries
const dirArb = fc.constantFrom<WasmDirection>('North', 'South', 'East', 'West');
const moveInputArb: fc.Arbitrary<WasmMoveInput> = fc.oneof(
  fc.constant<WasmMoveInput>('Jump'),
  dirArb.map((d): WasmMoveInput => ({ Step: d })),
);

// ================================================================================
// 1. Seeding / lifecycle — "uninitialized until the first own-row seeds it" (§3)
// ================================================================================
describe('Predictor: seeding & lifecycle', () => {
  it('predicted is undefined before any reconcile', () => {
    const p = mkPredictor();
    expect(p.predicted).toBeUndefined();
  });

  it('enqueue/drain before seeding do not throw and leave predicted undefined', () => {
    const p = mkPredictor();
    expect(() => {
      p.enqueue(east());
      p.drain(10_000);
    }).not.toThrow();
    expect(p.predicted).toBeUndefined();
  });

  it('first reconcile seeds predicted to the rebased authBaseline and returns false', () => {
    const p = mkPredictor();
    // seed at x=5 with the baseline two steps ago; no queued moves => no drift.
    const diverged = p.reconcile(baseline(5, 5, 9_600), [], 0, 10_000);
    expect(diverged).toBe(false); // no divergence on the seeding reconcile
    expect(p.predicted).toBeDefined();
    expect(p.predicted!.pos).toEqual({ x: 5, y: 5 });
  });
});

// ================================================================================
// 2. Input mutates the QUEUE (and pending), not `predicted` (§3 Predictor)
// ================================================================================
describe('Predictor: input mutates the queue, not predicted', () => {
  it('enqueue appends; assigns strictly increasing seq; records an Enqueue op', () => {
    const p = mkPredictor();
    const a: IntentToSend = p.enqueue(east())!;
    const b: IntentToSend = p.enqueue(north())!;
    expect(p.queueDepth).toBe(2);
    expect(p.pendingCount).toBe(2);
    expect(b.seq).toBeGreaterThan(a.seq); // strictly increasing
    expect(a.op).toEqual<QueueOp>({ kind: 'Enqueue', input: east() });
    expect(b.op).toEqual<QueueOp>({ kind: 'Enqueue', input: north() });
  });

  it('setMove REPLACES the queue (depth -> 1) and records a SetMove op', () => {
    const p = mkPredictor();
    p.enqueue(east());
    p.enqueue(north());
    const m: IntentToSend = p.setMove(west());
    expect(p.queueDepth).toBe(1); // replaced, not appended
    expect(p.pendingCount).toBe(3); // op still recorded for replay/ack
    expect(m.op).toEqual<QueueOp>({ kind: 'SetMove', input: west() });
  });

  it('clearQueue EMPTIES the queue (depth -> 0), records a Clear op carrying a seq', () => {
    const p = mkPredictor();
    p.enqueue(east());
    p.enqueue(north());
    const c: IntentToSend = p.clearQueue();
    expect(p.queueDepth).toBe(0);
    expect(p.pendingCount).toBe(3);
    expect(c.op).toEqual<QueueOp>({ kind: 'Clear' });
    expect(typeof c.seq).toBe('number'); // Clear carries a seq
  });

  it('seq is strictly increasing across mixed input ops', () => {
    const p = mkPredictor();
    const seqs = [p.enqueue(east())!, p.setMove(north()), p.clearQueue(), p.enqueue(west())!].map(
      (i) => i.seq,
    );
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('input alone does NOT advance predicted — only drain does', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 9_600), [], 0, 10_000);
    const seeded = p.predicted!;
    p.enqueue(east());
    p.enqueue(east());
    expect(p.predicted).toEqual(seeded); // predicted unchanged by enqueue
    expect(p.queueDepth).toBe(2);
  });
});

// ================================================================================
// 8. Accessors — pendingCount / queueDepth / lastQueuedDir (§3)
// ================================================================================
describe('Predictor: accessors', () => {
  it('lastQueuedDir is the dir of the last queued Step', () => {
    const p = mkPredictor();
    p.enqueue(east());
    p.enqueue(north());
    expect(p.lastQueuedDir).toBe('North');
  });

  it('lastQueuedDir is undefined when the last queued move is a Jump', () => {
    const p = mkPredictor();
    p.enqueue(east());
    p.enqueue(jump());
    expect(p.lastQueuedDir).toBeUndefined();
  });

  it('lastQueuedDir is undefined when the queue is empty', () => {
    const p = mkPredictor();
    expect(p.lastQueuedDir).toBeUndefined();
    p.enqueue(east());
    p.clearQueue();
    expect(p.lastQueuedDir).toBeUndefined();
  });

  it('queueDepth and pendingCount reflect setMove replacing the queue', () => {
    const p = mkPredictor();
    p.enqueue(east());
    p.enqueue(east());
    p.enqueue(east());
    expect(p.queueDepth).toBe(3);
    p.setMove(west());
    expect(p.queueDepth).toBe(1); // replaced
    expect(p.lastQueuedDir).toBe('West');
    expect(p.pendingCount).toBe(4); // 3 enqueue + 1 setMove still pending
  });
});

// ================================================================================
// 3. drain cadence — step_ms-paced, never a teleport (§3 + ADR-0013 snap)
// ================================================================================
describe('Predictor: drain is step_ms-paced (not teleport)', () => {
  it('applies due moves one tile each, advancing move_started_at by step_ms per move', () => {
    const p = mkPredictor();
    // Baseline two steps ago => the first queued move is immediately due.
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000);
    p.enqueue(east());
    p.enqueue(east());
    p.enqueue(east());
    const r = p.drain(10_000);
    // From a two-steps-ago baseline, draining at `now` lets exactly 2 moves become
    // due (2*step then 1*step elapsed); the 3rd is one step in the future.
    expect(r.applied).toBe(2);
    expect(p.predicted!.pos).toEqual({ x: 7, y: 5 }); // 5 -> 6 -> 7, one tile each
    // last applied move's move_started_at ends within step_ms of now (here == now).
    expect(Math.abs(p.predicted!.move_started_at - 10_000)).toBeLessThanOrEqual(STEP_MS);
  });

  it('a large time gap catches up as discrete steps, bounded by queue length (no teleport)', () => {
    const p = mkPredictor();
    p.reconcile(baseline(1, 1, 0), [], 0, 0);
    // Queue 3 eastward steps but jump the clock far forward (backgrounded tab).
    p.enqueue(east());
    p.enqueue(east());
    p.enqueue(east());
    const r = p.drain(100_000); // huge gap
    // Catch-up is bounded by what is queued — at most 3 applied, never a teleport
    // straight to an x derived from the raw time gap.
    expect(r.applied).toBeLessThanOrEqual(3);
    expect(r.applied).toBe(3); // all three were due given the gap
    expect(p.predicted!.pos).toEqual({ x: 4, y: 1 }); // 1 -> 2 -> 3 -> 4 (3 tiles), NOT a teleport
    expect(p.queueDepth).toBe(0); // queue drained
  });

  it('DrainResult.snapped is false for a small (single-step) gap', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000);
    p.enqueue(east());
    const r = p.drain(10_000); // normal cadence
    expect(r.snapped).toBe(false);
  });

  it('DrainResult.snapped becomes true on a large local time gap (backgrounded tab)', () => {
    const p = mkPredictor();
    p.reconcile(baseline(1, 1, 0), [], 0, 0);
    for (let i = 0; i < 6; i++) p.enqueue(east());
    const r = p.drain(100_000); // gap >> several steps => M4 should jump, not animate
    expect(r.snapped).toBe(true);
  });

  it('drain with an empty queue applies nothing and does not move predicted', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000);
    const before = p.predicted!;
    const r = p.drain(20_000);
    expect(r.applied).toBe(0);
    expect(p.predicted!.pos).toEqual(before.pos);
  });
});

// ================================================================================
// 4. reconcile — the ADR-0012 four-step (drop acked / rebuild+replay ops /
//    reset to truth / drain forward)  (§3 + §4 sketch)
// ================================================================================
describe('Predictor: reconcile four-step (ADR-0012)', () => {
  it('step 1 — drops pending with seq <= ackedSeq', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0); // seed
    const i1 = p.enqueue(east())!; // seq s1
    const i2 = p.enqueue(east())!; // seq s2
    const i3 = p.enqueue(east())!; // seq s3
    expect(p.pendingCount).toBe(3);
    // Ack up to i2: i1 and i2 are dropped, only i3 remains pending.
    p.reconcile(baseline(6, 5, 0), [], i2.seq, 0);
    expect(p.pendingCount).toBe(1);
    void i1;
    void i3;
  });

  it('step 2 — rebuilds the local queue from authQueue, then replays unacked pending OPS', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0); // seed
    // One unacked enqueue still in flight (not yet acked).
    p.enqueue(north()); // pending Enqueue(North)
    // Server reports it already has [East] queued and has acked nothing.
    p.reconcile(baseline(5, 5, 0), [east()], 0, 0);
    // Queue must be authQueue [East] with the unacked Enqueue(North) replayed on top.
    expect(p.queueDepth).toBe(2); // [East, North]
    expect(p.lastQueuedDir).toBe('North'); // appended last
  });

  it('step 3 + 4 — resets predicted to authBaseline then drains forward', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0); // seed at x=5
    p.enqueue(east()); // one unacked move
    // Authoritative truth says we are actually at x=2 with that move still queued.
    p.reconcile(baseline(2, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000);
    // predicted was reset to x=2 (truth) then drained one due East step -> x=3.
    expect(p.predicted!.pos.x).toBeGreaterThanOrEqual(3);
    expect(p.predicted!.pos.y).toBe(5);
  });
});

// ================================================================================
// 5. Divergence return — true iff corrected tile differs from pre-reconcile tile
// ================================================================================
describe('Predictor: divergence return value', () => {
  it('returns false when the corrected tile matches the predicted tile (agreement)', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000);
    p.enqueue(east());
    p.drain(10_000); // predicted advances to x=6
    expect(p.predicted!.pos.x).toBe(6);
    // Server confirms x=6 with no queued moves and acks the move: no disagreement.
    const diverged = p.reconcile(baseline(6, 5, 10_000 - 2 * STEP_MS), [], 999, 10_000);
    expect(diverged).toBe(false);
    expect(p.predicted!.pos).toEqual({ x: 6, y: 5 });
  });

  it('returns true when the corrected tile differs from the predicted tile (server disagreement)', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000);
    p.enqueue(east());
    p.drain(10_000); // predicted thinks x=6
    expect(p.predicted!.pos.x).toBe(6);
    // Server says the player is actually at x=9 (a warp/loss the client didn't model),
    // queue empty and move acked => corrected tile (9) != predicted tile (6).
    const diverged = p.reconcile(baseline(9, 5, 10_000 - 2 * STEP_MS), [], 999, 10_000);
    expect(diverged).toBe(true);
    expect(p.predicted!.pos).toEqual({ x: 9, y: 5 });
  });
});

// ================================================================================
// 6. fast-check properties — convergence + idempotence (§3 Predictor properties)
// NOTE: block-body arrows that call expect() as STATEMENTS (never expression-body,
// which fast-check would misread as a `false` return).
// ================================================================================
describe('Predictor: fast-check properties', () => {
  it('convergence — if authority already equals the prediction, reconcile returns false', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 50 }), // start x (>0 so no wall involved)
        fc.integer({ min: 0, max: 50 }), // start y
        fc.array(moveInputArb, { maxLength: QUEUE_CAP }),
        (x, y, moves) => {
          const p = mkPredictor();
          // Seed and drain to establish the prediction.
          p.reconcile(baseline(x, y, 10_000 - 2 * STEP_MS), [], 0, 10_000);
          for (const m of moves) p.enqueue(m);
          p.drain(10_000);
          const truth = p.predicted!;
          // Reconcile against EXACTLY the current prediction (no loss), queue empty,
          // everything acked => agreement must never report divergence.
          const diverged = p.reconcile(
            { ...truth, move_started_at: 10_000 - 2 * STEP_MS },
            [],
            Number.MAX_SAFE_INTEGER,
            10_000,
          );
          expect(diverged).toBe(false);
        },
      ),
    );
  });

  it('idempotence — applying the same reconcile twice changes nothing and returns false', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        fc.array(moveInputArb, { minLength: 0, maxLength: 6 }),
        (x, y, authMoves) => {
          const p = mkPredictor();
          p.reconcile(baseline(x, y, 10_000 - 2 * STEP_MS), [], 0, 10_000); // seed
          // First reconcile against a coherent snapshot (no unacked pending).
          p.reconcile(
            baseline(x, y, 10_000 - 2 * STEP_MS),
            authMoves,
            Number.MAX_SAFE_INTEGER,
            10_000,
          );
          const first = p.predicted!;
          // Second identical reconcile must change nothing and report no divergence.
          const diverged = p.reconcile(
            baseline(x, y, 10_000 - 2 * STEP_MS),
            authMoves,
            Number.MAX_SAFE_INTEGER,
            10_000,
          );
          expect(diverged).toBe(false);
          expect(p.predicted!.pos).toEqual(first.pos);
        },
      ),
    );
  });
});

// ================================================================================
// 7. Wall-bump golden case — "the single most valuable assertion" (ADR-0013)
// ================================================================================
describe('Predictor: wall-bump golden case', () => {
  it('after a Step into a wall, reconcile leaves predicted position == authoritative', () => {
    const p = mkPredictor();
    // Start at the west edge x=1; a West step bumps the wall at x<=0.
    p.reconcile(baseline(1, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000);
    p.enqueue(west()); // predicted: bump => stays at x=1 (Idle)
    p.drain(10_000);
    expect(p.predicted!.pos).toEqual({ x: 1, y: 5 }); // client predicted the bump correctly
    // Authoritative row confirms the bump: still at x=1. predicted == authoritative.
    const authoritative = baseline(1, 5, 10_000 - 2 * STEP_MS);
    const diverged = p.reconcile(authoritative, [], Number.MAX_SAFE_INTEGER, 10_000);
    expect(diverged).toBe(false); // correct prediction => no divergence
    expect(p.predicted!.pos).toEqual({ x: 1, y: 5 }); // predicted == authoritative position
  });
});

// ================================================================================
// 9. PROOF-OF-TEETH (ADR-0010) — fixtures that BITE: each FAILS if the impl does
//    the wrong thing. These are the load-bearing mutation-killers.
// ================================================================================
describe('Predictor: proof-of-teeth', () => {
  it('BITES: a mid-flight SetMove replays as a REPLACE op, not a raw append', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0); // seed at x=5,y=5
    // A SetMove(North) is issued mid-flight and is NOT yet acked.
    p.setMove(north()); // pending: SetMove(North)
    // Server snapshot: it still has [East] queued, acked nothing, truth at (5,5).
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [east()], 0, 10_000);
    // CORRECT (op replay): SetMove REPLACES => queue becomes [North]; one due step
    // North => (5,4). The East from authQueue was thrown away by the replace.
    // WRONG (raw append): queue would be [East, North] => two due steps => (6,4),
    // so x=6 — this assertion fails under the wrong impl.
    expect(p.predicted!.pos).toEqual({ x: 5, y: 4 });
    expect(p.queueDepth).toBe(0); // single [North] fully drained (2 steps were due)
  });

  it('BITES: reconcile honors authQueue (does not ignore it in favor of only pending)', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0); // seed
    // No unacked pending: everything the client did is acked away.
    p.enqueue(east());
    // Server snapshot: ack everything, but its authQueue still holds [East].
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [east()], Number.MAX_SAFE_INTEGER, 10_000);
    // CORRECT: rebuild from authQueue=[East] => one due step => x advances to 6.
    // WRONG (ignores authQueue, uses only pending=[]) => no move drained => x stays 5.
    expect(p.predicted!.pos.x).toBe(6);
    expect(p.predicted!.pos.y).toBe(5);
  });

  it('BITES: a Clear op replayed mid-flight empties the rebuilt queue (not appended)', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000); // seed
    // A Clear is issued mid-flight and is NOT yet acked.
    p.clearQueue(); // pending: Clear
    // Server still reports [East, East] queued, acked nothing.
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [east(), east()], 0, 10_000);
    // CORRECT (op replay): Clear EMPTIES the rebuilt queue => nothing drains => x=5.
    // WRONG (Clear ignored / treated as raw): the two East moves would drain => x>5.
    expect(p.predicted!.pos).toEqual({ x: 5, y: 5 });
    expect(p.queueDepth).toBe(0);
  });
});

// ================================================================================
// M8.5f NET-1 / ADR-0052 — Bounded prediction queue (cap enforcement)
// Uses a cap=2 predictor (mkCapped). The file's mkPredictor() uses cap=8.
//
// RED EVIDENCE (before fix):
//   enqueue always pushes → queueDepth=5, returns object on calls 3-5 (not undefined)
//   reconcile does not clamp → queueDepth can exceed cap after rebuild
// ================================================================================

/** Small-cap predictor for NET-1 / ADR-0052 tests (cap=2). */
function mkCapped(cap: number): Predictor {
  return new Predictor(applyMove, STEP_MS, cap);
}

describe('NET-1 ADR-0052: enqueue bounded by cap (cap=2)', () => {
  it('BITES: enqueue drops moves past the cap; only calls 1-2 return a defined intent', () => {
    // RED reason: current enqueue always pushes → calls 3-5 return an IntentToSend (not
    // undefined) and queueDepth reaches 5. After fix: drops at cap, returns undefined.
    // Wrong impl killed: unbounded enqueue (never returns undefined, never gates push).
    const p = mkCapped(2);
    // Seed so the predictor is live (the cap check is on #queue.length, not pending).
    p.reconcile(baseline(5, 5, 0), [], 0, 0);

    const r1 = p.enqueue(east());
    const r2 = p.enqueue(east());
    const r3 = p.enqueue(east());
    const r4 = p.enqueue(east());
    const r5 = p.enqueue(east());

    // Calls 1 and 2 succeed (queue was empty / had 1 → length < cap=2).
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    // Calls 3-5: queue at cap → must drop (no push, no seq consumed) → undefined.
    expect(r3).toBeUndefined();
    expect(r4).toBeUndefined();
    expect(r5).toBeUndefined();
    // Queue depth must not exceed cap.
    expect(p.queueDepth).toBe(2);
    // Only 2 pending ops recorded (seq not consumed for dropped enqueues).
    expect(p.pendingCount).toBe(2);
  });

  it('BITES: dropped enqueues do NOT advance predicted (predicted unchanged by drops)', () => {
    // Wrong impl killed: an impl that pushes silently and advances predicted on drain
    // would move the predicted tile beyond cap, creating over-prediction.
    const p = mkCapped(2);
    p.reconcile(baseline(5, 5, 0), [], 0, 0);
    const seededPos = p.predicted!.pos;

    // Enqueue 5 East moves; only 2 accepted, 3 dropped.
    for (let i = 0; i < 5; i++) p.enqueue(east());

    // No drain yet — predicted is still at the seeded position.
    expect(p.predicted!.pos).toEqual(seededPos);
    expect(p.queueDepth).toBe(2); // cap obeyed
  });

  it('BITES: burst > cap → after drain+reconcile predicted == authoritative (no over-prediction)', () => {
    // This is the headline NET-1 regression.
    // RED reason: without the fix, 5 enqueues are accepted → drain moves predicted to
    // x=10 (5 steps), but server only accepted 2 (x=7). reconcile cannot close the gap
    // because the stale pending ops keep replaying → persistent over-prediction.
    // After fix: only 2 enqueues land; drain moves predicted to x=7 max; reconcile
    // against the fully-drained server truth (7,5) → predicted == authoritative.
    const CAP = 2;
    const p = mkCapped(CAP);
    // Seed two step_ms ago so the first drain immediately applies both queued moves.
    const t0 = 10_000;
    p.reconcile(baseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    // Burst: 5 East enqueues — only 2 should be accepted.
    for (let i = 0; i < 5; i++) p.enqueue(east());
    expect(p.queueDepth).toBe(CAP); // cap obeyed pre-drain

    // Drain forward: with a baseline two steps ago both accepted moves become due.
    p.drain(t0);
    // predicted should now be at x=7 (5 + 2 accepted steps), not x=10.
    expect(p.predicted!.pos).toEqual({ x: 7, y: 5 });
    expect(p.queueDepth).toBe(0); // both drained

    // Server accepted+drained the same 2 moves → authoritative truth is (7,5).
    // ackedSeq covers both accepted intents (pendingCount was 2, seqs 1 and 2).
    const ackedSeq = 2; // seq of the 2nd (last accepted) enqueue
    const diverged = p.reconcile(baseline(7, 5, t0 - 2 * STEP_MS), [], ackedSeq, t0);

    // No divergence: predicted was already at (7,5) and reconcile confirms it.
    expect(diverged).toBe(false);
    expect(p.predicted!.pos).toEqual({ x: 7, y: 5 }); // exact parity with authority
    expect(p.pendingCount).toBe(0); // all pending ops acked
  });

  it('BITES: reconcile clamps the rebuilt queue to the cap (authQueue surprise)', () => {
    // RED reason: without the clamp in reconcile, the rebuilt queue is
    // [West, East, East] (length 3 > cap=2). drain inside reconcile applies W→(4,5)
    // and E→(5,5) (2 due), leaving 1 move in queue → queueDepth=1 after reconcile.
    // After fix: #queue = q.slice(0, cap=2) → [West, East]; drain applies both (2 due)
    // → queueDepth=0.  The assertion on queueDepth==0 BITES the missing clamp.
    //
    // Wrong impl killed: reconcile without the q.slice(0, cap) clamp → queueDepth=1.
    const CAP = 2;
    const p = mkCapped(CAP);
    const t0 = 10_000;
    // Seed at (5,5) with move_started_at two steps ago → internal drain has 2 due slots.
    p.reconcile(baseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    // Fill #queue to cap with two unacked East enqueues (both fit: queue was empty).
    p.enqueue(east());
    p.enqueue(east());
    expect(p.queueDepth).toBe(CAP); // pre-condition: queue at cap

    // Server surprises us: it has [West] queued and acks nothing (ackedSeq=0).
    // Unclamped rebuild: [West] + replay(Enqueue(East), Enqueue(East)) = [West, East, East], length 3.
    // Clamped rebuild:   slice to cap=2 → [West, East], length 2.
    // With move_started_at two steps ago, reconcile's internal drain applies BOTH due
    // moves from the cap-2 queue → queue fully emptied → queueDepth=0.
    p.reconcile(baseline(5, 5, t0 - 2 * STEP_MS), [west()], 0, t0);

    // With fix: 2-move clamped queue, both drained → 0.
    // Without fix: 3-move unclamped queue, 2 drained → 1 remains. Assertion FAILS.
    expect(p.queueDepth).toBe(0);

    // Additionally: predicted must not have advanced more than cap=2 tiles.
    // [W, E] from (5,5) → (4,5) → (5,5): net pos stays (5,5) (wall cancels E→W).
    // [W, E, E] from (5,5) → (4,5) → (5,5); 3rd E not drained (not due). Also (5,5).
    // The pos check is the same here, so the queueDepth assertion is the load-bearing bite.
    expect(p.predicted!.pos).toEqual({ x: 5, y: 5 });
  });
});

// ================================================================================
// M8.5f / ADR-0052 §B — lazy #lastDrainAt regression-guard
//
// The spurious first-drain snap (was: #lastDrainAt initialized to 0, so the very
// first drain would compute now-0 > SNAP_GAP_STEPS*stepMs and set snapped=true)
// is masked publicly: reconcile's internal drain call runs AFTER seeding
// #predicted=authBaseline, and drain early-returns while #predicted===undefined.
// The fix (#lastDrainAt: number | undefined = undefined; guarded by !== undefined)
// is a correctness-by-construction improvement that makes reconcile's internal
// first-drain honest and guards future refactors.
//
// Because the observable spurious-snap is already masked, a PUBLIC-API test CANNOT
// go RED for the literal first-drain case. This test is therefore a REGRESSION-GUARD
// that locks the existing masked semantics (early-return + no snapped on first drain
// called externally) and DOCUMENTS the invariant. See ADR-0052 §B.
// ================================================================================
describe('NET-1 ADR-0052 §B: lazy #lastDrainAt — regression-guard (invariant lock)', () => {
  it('REGRESSION-GUARD: a fresh predictor with undefined predicted → drain returns {applied:0, snapped:false}', () => {
    // Invariant: drain early-returns while #predicted===undefined (no snap, no apply).
    // This guards the existing early-return contract and documents that the
    // "spurious first-drain snap" is already masked by this early-return.
    // (ADR-0052 §B: the fix is correctness-by-construction, not a live observable bite.)
    //
    // If a future refactor removes the early-return (breaking the invariant), this
    // test would go RED because drain with a very large `now` would compute
    // now - 0 > SNAP_GAP_STEPS * stepMs → snapped=true.
    const p = mkPredictor(); // #predicted still undefined
    const r = p.drain(999_999); // large `now` that WOULD trigger snapped if lastDrainAt=0
    expect(r.applied).toBe(0);
    expect(r.snapped).toBe(false);
  });

  it('REGRESSION-GUARD: after seeding, a moderate gap from the seeded timestamp does not spuriously snap', () => {
    // Invariant: the first public drain after reconcile should not snap if the gap
    // since seed is within normal play (< SNAP_GAP_STEPS * STEP_MS).
    // This guards that #lastDrainAt is snapped to the seeding reconcile time, not 0.
    // ADR-0052 §B: the fix initialises #lastDrainAt=undefined so the first internal
    // drain (inside reconcile) doesn't compute a spurious huge gap from 0.
    const p = mkPredictor();
    const seedTime = 10_000;
    p.reconcile(baseline(5, 5, seedTime - 2 * STEP_MS), [], 0, seedTime);
    p.enqueue(east());
    // Drain at seedTime + 1 step (well within snap threshold).
    const r = p.drain(seedTime + STEP_MS);
    expect(r.snapped).toBe(false); // must NOT snap on a normal cadence drain
  });
});

// ================================================================================
// ADR-0013 smoothness — MONOTONIC predicted tile (no backward step except a genuine
// divergence). Closes the M3 smoothness-eval gap at the predictor level.
// ================================================================================
describe('Predictor: monotonic prediction (ADR-0013 smoothness)', () => {
  it('the predicted East tile never moves backward across interleaved drains', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 30 }),
        (gaps) => {
          const p = mkPredictor();
          let t = 10_000;
          p.reconcile(baseline(1, 5, t - 2 * STEP_MS), [], 0, t);
          let lastX = p.predicted!.pos.x;
          for (const g of gaps) {
            p.enqueue(east());
            t += g;
            p.drain(t);
            const x = p.predicted!.pos.x;
            expect(x).toBeGreaterThanOrEqual(lastX); // never backward along the input path
            lastX = x;
          }
        },
      ),
    );
  });

  it('a no-divergence reconcile does NOT move the predicted tile backward (no stutter)', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000);
    p.enqueue(east());
    p.drain(10_000); // predicted x -> 6
    const before = p.predicted!.pos.x;
    const diverged = p.reconcile(baseline(6, 5, 10_000 - 2 * STEP_MS), [], 999, 10_000); // agreement
    expect(diverged).toBe(false);
    expect(p.predicted!.pos.x).toBe(before); // unchanged — no backward jump on agreement
  });

  it('BITES: monotonicity yields ONLY to a genuine divergence (a real pullback is reported)', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000);
    p.enqueue(east());
    p.drain(10_000); // predicted thinks x=6
    // server truth pulls back to x=4 (loss/warp): must report divergence and reset to truth,
    // NOT silently smooth it away — a no-op-on-disagreement impl fails this.
    const diverged = p.reconcile(baseline(4, 5, 10_000 - 2 * STEP_MS), [], 999, 10_000);
    expect(diverged).toBe(true);
    expect(p.predicted!.pos.x).toBe(4);
  });
});
