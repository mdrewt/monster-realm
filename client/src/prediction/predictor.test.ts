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
import { HeldDirections, reissueDir } from './heldKeys';
import { type ApplyMove, boundSeq, type IntentToSend, Predictor, type QueueOp } from './predictor';

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
    // M12.5d-3 semantics: gap is measured from the last FRAME drain.
    // Establish a prior frame drain before checking the small-gap case.
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 10_000 - 2 * STEP_MS), [], 0, 10_000 - 2 * STEP_MS);
    p.drain(10_000 - 2 * STEP_MS); // establish #lastFrameDrainAt
    p.enqueue(east());
    const r = p.drain(10_000); // small gap since last frame drain
    expect(r.snapped).toBe(false);
  });

  it('DrainResult.snapped becomes true on a large local time gap (backgrounded tab)', () => {
    // M12.5d-3 semantics: gap is measured from the last FRAME drain.
    // Setup: seed predictor, do a frame drain at T=0, simulate 100s gap, then frame drain.
    const p = mkPredictor();
    p.reconcile(baseline(1, 1, 0), [], 0, 0);
    p.drain(0); // first FRAME drain — establishes #lastFrameDrainAt = 0
    for (let i = 0; i < 6; i++) p.enqueue(east());
    // Simulate being foregrounded after 100 seconds (reconcile fires on batch, then frame loop fires)
    p.reconcile(baseline(1, 1, 0), [], 0, 100_000); // reconcile drain at T=100_000
    const r = p.drain(100_000); // frame drain: gap = 100_000 - 0 = 100_000 >> SNAP_GAP_STEPS*200
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
// M8.6c ADR-0013.5 — #pending BOUND / backpressure (pendingCap)
//
// The Predictor gains an OPTIONAL 4th constructor param:
//   new Predictor(applyMove, stepMs, queueCap, pendingCap?)
// enqueue() ALSO declines (returns undefined, no push, no #record, no seq consumed)
// when #pending.length >= pendingCap — mirroring the existing #queue cap decline.
// This is DISTINCT from the M8.5f #queue-cap tests (NET-1 ADR-0052, above):
//   - Those tests assert queueDepth <= queueCap (the local intent queue bound).
//   - These tests assert pendingCount <= pendingCap (the unacked-ops bound).
//
// RED reason (before impl): Predictor constructor has no 4th param; enqueue()
// only checks #queue.length, not #pending.length. A 20-iteration no-ack burst
// accumulates pendingCount=20, far exceeding pendingCap=3 → assertions fail.
// ================================================================================

/** Small-pendingCap predictor for M8.6c backpressure tests. */
function mkPendingCapped(queueCap: number, pendingCap: number): Predictor {
  return new Predictor(applyMove, STEP_MS, queueCap, pendingCap);
}

describe('M8.6c ADR-0013.5: #pending bound / backpressure (pendingCap)', () => {
  it('BITES unbounded #pending: enqueue declines when #pending.length >= pendingCap', () => {
    // RED reason: current enqueue only checks #queue.length → pendingCount reaches
    // many past pendingCap without returning undefined. After fix: once pendingCount
    // reaches pendingCap, further enqueues return undefined (no push, no seq consumed).
    // Wrong impl killed: enqueue that only gate-checks #queue, ignoring #pending.
    //
    // We use queueCap=8 (large, not the bottleneck) so the #queue cap is NOT hit first,
    // isolating the #pending cap check cleanly.
    const PENDING_CAP = 3;
    const p = mkPendingCapped(/*queueCap*/ 8, PENDING_CAP);
    p.reconcile(baseline(5, 5, 0), [], 0, 0); // seed

    // First PENDING_CAP enqueues must succeed (pendingCount goes 1, 2, 3).
    const r1 = p.enqueue(east());
    const r2 = p.enqueue(east());
    const r3 = p.enqueue(east());
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r3).toBeDefined();
    expect(p.pendingCount).toBe(PENDING_CAP);

    // Further enqueues must be declined: #pending is at cap.
    const r4 = p.enqueue(east());
    const r5 = p.enqueue(east());
    expect(r4).toBeUndefined(); // declined — no push, no seq consumed
    expect(r5).toBeUndefined();
    // pendingCount must NOT exceed pendingCap.
    expect(p.pendingCount).toBe(PENDING_CAP);
    // queueDepth is NOT at its own cap (8), so the decline came from #pending.
    expect(p.queueDepth).toBe(PENDING_CAP); // 3 accepted into queue too
  });

  it('BITES unbounded #pending: burst + no-ack loop keeps pendingCount <= pendingCap', () => {
    // RED reason: a 20-iteration held-style burst (enqueue + drain to free queue slot)
    // without any reconcile/ack would reach pendingCount≈20 without the fix.
    // After fix: pendingCount never exceeds pendingCap=3.
    // Wrong impl killed: any enqueue that only gates on #queue.length.
    const QUEUE_CAP = 2;
    const PENDING_CAP = 3;
    const p = mkPendingCapped(QUEUE_CAP, PENDING_CAP);
    const t0 = 10_000;
    // Seed two steps ago so the first drain immediately applies due moves.
    p.reconcile(baseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    let now = t0;
    for (let i = 0; i < 20; i++) {
      // try to enqueue East — may be declined by either queue-cap or pending-cap
      p.enqueue(east());
      // advance time by one full step so a slot in the queue drains (freeing queueDepth),
      // but WITHOUT any reconcile — so pendingCount only grows (pending is never acked).
      now += STEP_MS;
      p.drain(now);

      // The critical assertion: pendingCount must never exceed pendingCap,
      // even though the queue keeps draining and accepting new entries.
      expect(p.pendingCount).toBeLessThanOrEqual(PENDING_CAP);
    }
  });

  it('BITES: declined enqueue (pending-full) does NOT push to #pending or consume seq', () => {
    // Wrong impl killed: an impl that records a pending op THEN checks the cap
    // (pushing before the guard fires), or one that increments #nextSeq on decline.
    const PENDING_CAP = 2;
    const p = mkPendingCapped(/*queueCap*/ 8, PENDING_CAP);
    p.reconcile(baseline(5, 5, 0), [], 0, 0);

    const r1 = p.enqueue(east()); // seq=1, pendingCount=1
    const r2 = p.enqueue(east()); // seq=2, pendingCount=2
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(p.pendingCount).toBe(2);

    const r3 = p.enqueue(east()); // should be declined
    expect(r3).toBeUndefined(); // declined
    expect(p.pendingCount).toBe(2); // unchanged — no push

    // After a reconcile that acks both, a new enqueue should get seq=3 (not seq=4),
    // proving the declined enqueue did NOT consume a seq number.
    p.reconcile(baseline(7, 5, 0), [], r2!.seq, 0); // ack both
    expect(p.pendingCount).toBe(0);
    const r4 = p.enqueue(north());
    expect(r4).toBeDefined();
    // seq must be strictly greater than r2.seq (=2) — not r2.seq+2 (which would mean
    // the declined enqueue consumed seq=3).
    expect(r4!.seq).toBe(r2!.seq + 1); // next after last successful seq
  });

  it('post-reconcile convergence: backpressure does NOT corrupt prediction (desync-safe)', () => {
    // BITES: an impl where declined enqueues silently corrupt the #pending replay log,
    // causing reconcile to compute the wrong predicted position.
    // After bounding #pending and reconciling against the authoritative truth that
    // reflects moves the server actually accepted, predicted == authoritative.
    const QUEUE_CAP = 2;
    const PENDING_CAP = 3;
    const p = mkPendingCapped(QUEUE_CAP, PENDING_CAP);
    const t0 = 10_000;
    p.reconcile(baseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    // Burst of East enqueues — only PENDING_CAP (3) land in pending.
    // With QUEUE_CAP=2, the queue fills at 2; the 3rd enqueue lands in pending
    // (via setMove or a subsequent drain). Here we use a drain loop:
    let now = t0;
    const accepted: ReturnType<typeof p.enqueue>[] = [];
    for (let i = 0; i < 8; i++) {
      const r = p.enqueue(east());
      if (r !== undefined) accepted.push(r);
      now += STEP_MS;
      p.drain(now);
    }

    // Server accepted 2 East steps (queue cap = 2), authority at x=7.
    // The 3rd pending op (if accepted.length=3) remains UNACKED and is replayed.
    const ackedSeq = accepted.length >= 2 ? accepted[1]!.seq : (accepted[0]?.seq ?? 0);
    const authX = 5 + Math.min(accepted.length, 2); // authoritative baseline: x=7 (2 acked East steps)
    const diverged = p.reconcile(baseline(authX, 5, now - 2 * STEP_MS), [], ackedSeq, now);

    // No divergence: pre-reconcile predicted == post-reconcile predicted.
    // predicted = authBaseline (x=7, the acked truth) + 1 unacked pending East replayed = x=8.
    // This BITES a backpressure impl that DROPS/garbles unacked pending ops: such an impl
    // would leave predicted.x < 5+accepted.length (falling behind, desync-unsafe).
    expect(diverged).toBe(false);
    expect(p.predicted!.pos.x).toBe(5 + accepted.length); // authX(7) + unacked replay = 8
    expect(p.predicted!.pos.y).toBe(5);
    // pendingCount drops because acked ops are pruned.
    expect(p.pendingCount).toBeLessThanOrEqual(PENDING_CAP);
  });

  it('3-arg construction is UNAFFECTED: default pendingCap large enough that existing tests pass', () => {
    // RED reason if wrong: if the 4th param defaults to something tiny (e.g. 0 or 1),
    // the existing M8.5f burst tests would break because a handful of enqueues would
    // be prematurely declined by the pending cap. The default must be >= 16 or similar.
    // Wrong impl killed: a default pendingCap that is too small (< QUEUE_CAP tests use).
    //
    // This test uses the existing 3-arg mkPredictor() and enqueues QUEUE_CAP (8) moves
    // without triggering the pending cap — proving the default is permissive.
    const p = mkPredictor(); // 3-arg: new Predictor(applyMove, STEP_MS, QUEUE_CAP=8)
    p.reconcile(baseline(5, 5, 0), [], 0, 0);

    // Enqueue up to queueCap=8 moves — NONE should be declined by the pending cap.
    const results: ReturnType<typeof p.enqueue>[] = [];
    for (let i = 0; i < QUEUE_CAP; i++) {
      results.push(p.enqueue(east()));
    }
    // All 8 should succeed (not declined).
    for (const r of results) {
      expect(r).toBeDefined();
    }
    expect(p.pendingCount).toBe(QUEUE_CAP);
    expect(p.queueDepth).toBe(QUEUE_CAP);
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

// ================================================================================
// M8.8e §A — Reconnect re-seed (`seedSeq`)
// EARS: "WHEN the client reconnects THE SYSTEM SHALL seed the new predictor's next
// sequence from the authoritative last_input_seq so the first post-reconnect intent's
// seq is strictly greater than the server's last ack and survives reconcile."
// (spec/monster-realm-v2/M8.8-fourth-review-residuals.spec.md §3)
//
// RED REASON: `Predictor.seedSeq` does not exist yet — TS compile error on every
// `p.seedSeq(...)` call.  After the implementer adds it all three tests below must
// turn green; removing / no-op-ing seedSeq makes them go red again.
// ================================================================================
describe('M8.8e §A: reconnect re-seed (seedSeq)', () => {
  it('first post-reconnect enqueue seq is > server acked seq and survives reconcile', () => {
    // Scenario: fresh predictor, reconnect where server's last_input_seq = 500.
    // seedSeq(500) raises #nextSeq to 500 so the next #record yields seq 501.
    // reconcile(ackedSeq=500) drops pending with seq <= 500; seq=501 > 500 → survives.
    //
    // PROOF-OF-TEETH: this is the load-bearing bite.  A seedSeq that is a no-op (or
    // absent) leaves #nextSeq=0 → enqueue records seq=1 → reconcile(ackedSeq=500)
    // drops it (1 <= 500) → pendingCount=0.  The assertion pendingCount >= 1 below
    // then FAILS, exposing the freeze bug.
    const p = mkPredictor();
    // Initial seed reconcile (server baseline, empty queue, nothing acked yet).
    p.reconcile(baseline(5, 5, 0), [], 0, 0);

    // Simulate reconnect: server reports last_input_seq = 500.
    p.seedSeq(500);

    // Enqueue one move post-reconnect.
    const intent = p.enqueue(east());
    expect(intent).toBeDefined(); // not dropped by queue/pending cap
    expect(intent!.seq).toBeGreaterThan(500); // strictly greater than the server's ack

    // Server acks up to 500: this reconcile must NOT drop the post-reconnect intent
    // because its seq (501+) > ackedSeq (500).
    p.reconcile(baseline(5, 5, 0), [], 500, 0);
    // The enqueued East intent survives the ackedSeq filter — pendingCount stays >= 1.
    expect(p.pendingCount).toBeGreaterThanOrEqual(1);
    // The queue also retains the East move (not dropped).
    expect(p.queueDepth).toBeGreaterThanOrEqual(1);
  });

  it('PROOF-OF-TEETH: WITHOUT seedSeq the same flow drops the intent (documents the freeze bug)', () => {
    // This is the "wrong impl" fixture — it MUST PASS (green) because seedSeq is
    // absent in THIS path: it documents what happens without the fix so the suite
    // remains a meaningful regression anchor.  If seedSeq were accidentally applied
    // here the assertion would flip and a reviewer would notice the fixture was
    // mis-authored.
    //
    // Wrong impl killed by the §A main test above: any impl where seedSeq is a
    // no-op or not called leaves #nextSeq=0, the fresh predictor records seq=1,
    // and reconcile(ackedSeq=500) drops it (1 <= 500) → pendingCount=0.
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);

    // NO seedSeq call — this is the bug path.
    const intent = p.enqueue(east()); // records seq=1 (#nextSeq was 0)
    expect(intent).toBeDefined();
    // seq=1 is well below 500 — reconcile(ackedSeq=500) will drop it.
    expect(intent!.seq).toBeLessThanOrEqual(500);

    p.reconcile(baseline(5, 5, 0), [], 500, 0);
    // The intent IS dropped: pendingCount=0, queueDepth=0 (the freeze bug).
    expect(p.pendingCount).toBe(0);
    // This test is GREEN because it asserts the BUG behaviour (no seedSeq → drop).
    // The §A test above asserts the FIX behaviour (seedSeq → survive).
  });

  it('seedSeq is monotonically increasing (never rewinds #nextSeq)', () => {
    // seedSeq(500) then seedSeq(100): the lower value must be ignored because the
    // server's ack can only move forward, and rewinding would alias previously-sent
    // seqs and cause false ack-drops on pending ops already in flight.
    //
    // Wrong impl killed: any impl that unconditionally assigns #nextSeq = seq (rather
    // than #nextSeq = Math.max(#nextSeq, seq)) would rewind to 100, making the next
    // enqueue record seq=101, which reconcile(ackedSeq=500) would then drop.
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);

    p.seedSeq(500);
    p.seedSeq(100); // must be a no-op: 100 < current #nextSeq (=500)

    const intent = p.enqueue(east());
    expect(intent).toBeDefined();
    // seq must be 501 (raised by the first seedSeq, not rewound by the second).
    expect(intent!.seq).toBe(501);

    // Confirm it survives reconcile(ackedSeq=500) — proof it was not rewound to 101.
    p.reconcile(baseline(5, 5, 0), [], 500, 0);
    expect(p.pendingCount).toBeGreaterThanOrEqual(1);
  });

  it('seedSeq is a no-op when #nextSeq is already ahead (steady-state after enqueues)', () => {
    // In steady state the predictor has already issued several ops and #nextSeq > the
    // seed value. seedSeq must not rewind in this case either.
    //
    // Wrong impl killed: unconditional assignment (#nextSeq = N) rewinds a live
    // predictor that has already issued ops, breaking seq monotonicity and allowing
    // aliasing with already-sent intents.
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);

    // Advance #nextSeq to 3 via three enqueues.
    const i1 = p.enqueue(east())!; // seq=1
    const i2 = p.enqueue(east())!; // seq=2
    const i3 = p.enqueue(east())!; // seq=3
    expect(i3.seq).toBe(3);

    // seedSeq(0) with #nextSeq already at 3: must be a no-op.
    p.seedSeq(0);

    // The predictor is at queue cap now; drain one slot via reconcile, then enqueue.
    // Ack all three so pending is cleared and queueDepth drops to 0.
    p.reconcile(baseline(8, 5, 0), [], i3.seq, 0);
    const i4 = p.enqueue(north())!;
    // seq must be 4 (strictly next after 3), NOT 1 (which a rewind to 0 would give).
    expect(i4.seq).toBe(4);
    void i1;
    void i2;
  });
});

// ================================================================================
// M8.8e §B — seq downcast bound (`boundSeq`)
// EARS: "THE last_input_seq u64→number conversion SHALL be documented/bounded ...
// (comment + assertion ...)."
// (spec/monster-realm-v2/M8.8-fourth-review-residuals.spec.md §3)
//
// RED REASON: `boundSeq` is not yet exported from `./predictor` — the import at the
// top of this file causes a TS compile error until the implementer adds the export.
// ================================================================================
describe('M8.8e §B: boundSeq — fail-loud u64→number downcast', () => {
  it('boundSeq returns the correct number for values in the safe integer range', () => {
    // These are the happy-path identity cases: the downcast must be exact (no rounding,
    // no aliasing) for any seq the server could realistically produce in a session.
    expect(boundSeq(0n)).toBe(0);
    expect(boundSeq(9n)).toBe(9);
    expect(boundSeq(500n)).toBe(500);
    expect(boundSeq(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('boundSeq throws RangeError for a seq above Number.MAX_SAFE_INTEGER (hostile/corrupt)', () => {
    // A u64 above MAX_SAFE_INTEGER cannot be represented exactly as a JS number and
    // would silently alias a lower value, potentially matching an already-sent seq and
    // causing a false ack-drop or replay corruption.  The bound must be fail-loud.
    //
    // Wrong impl killed: `return Number(seq)` without a range check would silently
    // return a wrong value (aliasing) for the over-range input.
    expect(() => {
      boundSeq(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    }).toThrow(RangeError);
  });

  it('boundSeq throws RangeError for a negative seq (corrupt/hostile)', () => {
    // A u64 is inherently unsigned; a negative BigInt means the caller passed a
    // corrupt / adversarially-crafted value.  Fail loud rather than producing a
    // negative seq that could underflow comparisons or satisfy `seq > ackedSeq`
    // spuriously.
    //
    // Wrong impl killed: `return Number(seq)` with no negativity check silently
    // returns a negative number, breaking the `seq > ackedSeq` filter direction.
    expect(() => {
      boundSeq(-1n);
    }).toThrow(RangeError);
  });

  it('boundSeq never silently wraps: values just outside the boundary both throw', () => {
    // Belt-and-suspenders: verify the boundary is exactly at MAX_SAFE_INTEGER, not
    // one off in either direction.  An off-by-one in the guard would pass the
    // individual boundary tests above but fail here.
    //
    // Wrong impl killed: a guard of `seq > BigInt(Number.MAX_SAFE_INTEGER) + 1n`
    // (strictly less-than-strict) would accept MAX_SAFE_INTEGER+1n without throwing.
    expect(() => {
      boundSeq(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    }).toThrow();
    expect(() => {
      boundSeq(-1n);
    }).toThrow();
    // And the values AT the boundary are still fine (not off-by-one the other way).
    expect(() => {
      boundSeq(0n);
    }).not.toThrow();
    expect(() => {
      boundSeq(BigInt(Number.MAX_SAFE_INTEGER));
    }).not.toThrow();
  });
});

// ================================================================================
// M8.8e §C — Divergence re-issue + keyup-not-stuck
// EARS: "WHEN reconcile returns a genuine divergence THE SYSTEM SHALL re-issue the
// currently-held movement direction (tracking held keys via a keyup handler), so
// motion does not stall."
// (spec/monster-realm-v2/M8.8-fourth-review-residuals.spec.md §3)
//
// This is a COMPOSITION test over the real Predictor + HeldDirections + reissueDir
// that pins the exact contract main.ts relies on.  main.ts is the thin e2e-only
// wiring; this test proves the three pieces fit together correctly.
//
// RED REASON (until M8.8e is implemented):
//   - `p.seedSeq` call fails TS compilation (no such method yet).
//   - Additionally `boundSeq` import at the top fails until that export exists.
// Both errors propagate to this describe block even though §C only calls seedSeq
// indirectly via the broader module failing to compile.
// ================================================================================
describe('M8.8e §C: divergence re-issue + keyup-not-stuck (composition)', () => {
  it('held key resumes motion after a genuine server pullback (divergence re-issue)', () => {
    // Scenario:
    //   1. Predictor seeded at x=5; East is held; one East move enqueued + drained.
    //      predicted → x=6.
    //   2. Server pulls the player back to x=3 (divergence): reconcile returns true.
    //   3. reissueDir(held.active(), predictor.lastQueuedDir) === 'East' (still held,
    //      queue now empty so lastQueuedDir is undefined → not a dup → re-issue).
    //   4. enqueue({Step:'East'}) is accepted (returns a defined intent with seq > ackedSeq)
    //      → motion resumes from the corrected tile.
    //
    // Wrong impl killed (§C main bite): if the divergence return is discarded (as in
    // main.ts:85 before the fix), the re-issue branch is never entered — held motion
    // stalls until the user re-presses.  This test asserts the reissueDir call would
    // produce 'East' given the post-divergence state, proving main.ts MUST use it.

    const p = mkPredictor();
    const now = 10_000;

    // Seed at x=5, two step_ms ago so the first drain applies immediately.
    p.reconcile(baseline(5, 5, now - 2 * STEP_MS), [], 0, now);

    // User presses East.
    const held = new HeldDirections();
    held.press('East');

    // Enqueue + drain: predicted advances to x=6.
    const intent1 = p.enqueue(east());
    expect(intent1).toBeDefined();
    const ackedSeq = intent1!.seq; // seq of the East intent (=1 here)
    p.drain(now);
    expect(p.predicted!.pos).toEqual({ x: 6, y: 5 });
    expect(p.queueDepth).toBe(0); // drained

    // Server pulls back to x=3 and acks the East intent (ackedSeq covers it).
    // This is a genuine divergence: pre-reconcile predicted x=6, post-reconcile x=3.
    const diverged = p.reconcile(baseline(3, 5, now - 2 * STEP_MS), [], ackedSeq, now);
    expect(diverged).toBe(true); // server disagreed — genuine pullback
    expect(p.predicted!.pos).toEqual({ x: 3, y: 5 }); // reset to server truth
    expect(p.queueDepth).toBe(0); // queue empty after reconcile
    // lastQueuedDir undefined because queue is empty (no move in queue to tail-check).
    expect(p.lastQueuedDir).toBeUndefined();

    // The divergence-driven re-issue decision: key still held, queue tail is different
    // (undefined ≠ 'East') → reissueDir returns 'East'.
    const d = reissueDir(held.active(), p.lastQueuedDir);
    expect(d).toBe('East');

    // Re-issue: enqueue({Step: 'East'}) from the corrected tile.
    const intent2 = p.enqueue({ Step: d! });
    expect(intent2).toBeDefined(); // accepted — not dropped by cap
    // The re-issued seq must be strictly greater than the ackedSeq so it will NOT be
    // dropped by a subsequent reconcile(ackedSeq, ...).
    expect(intent2!.seq).toBeGreaterThan(ackedSeq);
    // Motion resumes from x=3 → intent accepted into queue.
    expect(p.queueDepth).toBeGreaterThanOrEqual(1);
  });

  it('keyup-not-stuck: a released key is NOT re-issued after a divergence', () => {
    // Scenario: same pullback, but the user released East before the divergence
    // reconcile fires (held.active() === undefined).
    //
    // Wrong impl killed: an impl that always re-issues the lastQueuedDir (ignoring
    // the held-key state) would re-issue East even after keyup, causing ghost motion.
    // reissueDir(undefined, anything) must return undefined — the released key must
    // neither be re-committed nor left stuck walking.

    const p = mkPredictor();
    const now = 10_000;
    p.reconcile(baseline(5, 5, now - 2 * STEP_MS), [], 0, now);

    const held = new HeldDirections();
    held.press('East');

    const intent1 = p.enqueue(east());
    expect(intent1).toBeDefined();
    const ackedSeq = intent1!.seq;
    p.drain(now);
    expect(p.predicted!.pos).toEqual({ x: 6, y: 5 });

    // Key released BEFORE the server divergence arrives.
    held.release('East');
    expect(held.active()).toBeUndefined(); // no dirs held

    // Server pulls back (divergence).
    const diverged = p.reconcile(baseline(3, 5, now - 2 * STEP_MS), [], ackedSeq, now);
    expect(diverged).toBe(true);
    expect(p.predicted!.pos).toEqual({ x: 3, y: 5 });

    // Re-issue decision: no key held → reissueDir returns undefined.
    const d = reissueDir(held.active(), p.lastQueuedDir);
    expect(d).toBeUndefined(); // released key must NOT be re-issued
    // Enqueue is not called — queue remains empty (not stuck walking).
    expect(p.queueDepth).toBe(0);
  });

  it('no re-issue when held direction matches queue tail (dedup still applies post-divergence)', () => {
    // Scenario: a divergence reconcile whose authoritative queue still carries East
    // → the rebuilt queue tail is East → held('East') == lastQueuedDir('East')
    // → reissueDir returns undefined (dedup suppresses a double-issue).
    //
    // Wrong impl killed: an impl that always re-issues `held.active()` regardless of
    // `lastQueuedDir` would enqueue a duplicate East on top of the already-queued East
    // that came from the server's authQueue, producing a double-move.
    //
    // Rationale for the corrected shape (spec-vs-code): the original test enqueued two
    // East moves and assumed only one drained (leaving one in queue as the tail).
    // But baseline(now - 2*STEP_MS) gives a 2-step catch-up budget, so drain(now)
    // applies BOTH enqueued East moves — the queue empties, lastQueuedDir is undefined,
    // and the assertion `lastQueuedDir === 'East'` fails (wrong fixture, not wrong impl).
    // The corrected shape uses a divergence reconcile with a non-empty authQueue to
    // reliably populate the queue tail, which is the real post-divergence scenario.

    const p = mkPredictor();
    const now = 10_000;
    p.reconcile(baseline(5, 5, now - 2 * STEP_MS), [], 0, now);

    const held = new HeldDirections();
    held.press('East');

    // Enqueue + drain: one East move applied, predicted → x=6, queue empty.
    const intent1 = p.enqueue(east());
    expect(intent1).toBeDefined();
    const ackedSeq = intent1!.seq;
    p.drain(now);
    expect(p.predicted!.pos).toEqual({ x: 6, y: 5 });
    expect(p.queueDepth).toBe(0);

    // Divergence reconcile: server pulls back to x=3 BUT its authQueue still holds
    // [East] (the server has East queued for this player).  Use move_started_at=now
    // so the internal drain condition (`move_started_at + stepMs <= now` → `now+200
    // <= now`) is false — zero moves drain, and the East from authQueue stays in
    // #queue as the tail.
    // Rebuilds: #queue = applyOps([east()], []) = [east()] (no unacked pending after
    // ackedSeq drop), clamp to queueCap (still [east()]), drain 0 → queue intact.
    const diverged = p.reconcile(baseline(3, 5, now), [east()], ackedSeq, now);
    expect(diverged).toBe(true); // genuine divergence: pre x=6, post x=3 (no drain)
    // East from authQueue remains in #queue (not yet due), so lastQueuedDir is 'East'.
    expect(p.lastQueuedDir).toBe('East');

    // reissueDir: held dir ('East') == queue tail ('East') → dedup → undefined.
    const d = reissueDir(held.active(), p.lastQueuedDir);
    expect(d).toBeUndefined();
  });
});

// ================================================================================
// M12.5d-3: snapped signal uses last FRAME drain time (not reconcile drain time)
// SOURCE OF TRUTH: M12.5d spec §3 "Predictor: snap gap timer tracks frame-loop drain"
//
// THE BUG: predictor.reconcile() calls an internal drain step (#stepForward) that
// previously updated the same #lastDrainAt field as the public drain() call. This
// caused the snap gap timer to reset on every server batch — masking large gaps when
// the tab was backgrounded (reconcile fires on batch arrival, so #lastDrainAt = now,
// then the frame drain computes gap = 0 → snapped=false even after 100s gap).
//
// THE FIX: separate the timer into:
//   #lastFrameDrainAt — set ONLY by the public drain() call (frame-loop driven)
//   reconcile's internal step-forward uses a different private path
//
// RED REASON (before fix): all three new tests below will see the wrong behaviour:
//   - "reconcile resets the timer" test: reconcile at T=100_000, then frame drain
//     computes gap = 0 (from the reconcile's timer update) → snapped=false (BUG)
//   - "multiple reconciles" test: last reconcile at T=4000, frame drain at T=1100
//     computes gap = 1100-4000 < 0 or gap relative to T=4000 → wrong snap verdict
//   - "first frame drain never snaps" test: this relies on the ADR-0052 §B contract
//     which must be PRESERVED by the fix (first drain with no prior frame = no snap)
// ================================================================================

describe('Predictor M12.5d-3: snapped signal uses last FRAME drain time (not reconcile drain time)', () => {
  it('BITES: reconcile drain between frame drains does NOT reset the snap gap timer', () => {
    // This is the M12.5d-3 bug: predictor.reconcile() calls an internal step-forward,
    // which used to set #lastDrainAt = now, masking the gap from the last FRAME drain.
    // After fix: reconcile uses a private path; only frame-loop drain() sets #lastFrameDrainAt.
    //
    // Wrong impl killed (the bug): reconcile at T=100_000 resets the timer to 100_000,
    // so frame drain at T=100_000 sees gap=0 → snapped=false (incorrectly hides the 100s gap).
    // Correct impl (fix): #lastFrameDrainAt = 0 still after reconcile, so frame drain
    // sees gap=100_000 → snapped=true (correctly signals a large time gap).
    const p = mkPredictor();
    p.reconcile(baseline(1, 1, 0), [], 0, 0);
    // Establish last FRAME drain at T=0
    p.drain(0);
    // Simulate tab going background for 100 seconds.
    // A batch arrives and triggers reconcile at T=100_000.
    p.reconcile(baseline(1, 1, 0), [], 0, 100_000);
    // Frame loop fires: gap since last FRAME drain = 100_000ms >> SNAP_GAP_STEPS * 200ms
    // Before fix: reconcile sets timer to 100_000, so frame drain sees gap=0 → snapped=false (BUG)
    // After fix: #lastFrameDrainAt = 0 still, so frame drain sees gap=100_000 → snapped=true
    const r = p.drain(100_000);
    expect(r.snapped).toBe(true);
  });

  it('BITES: multiple reconcile drains between frame drains still detect the large gap on next frame drain', () => {
    // Variant of the main M12.5d-3 bug: three reconciles fire between two frame drains.
    // Last frame drain at T=0; reconciles at T=50_000, T=60_000, T=90_000; then frame
    // drain at T=90_100 (100ms after the last reconcile).
    //
    // Bug (current code): last reconcile sets #lastDrainAt=90_000; frame drain at
    // T=90_100 computes gap = 90_100 - 90_000 = 100ms → snapped=false (misses 90s gap).
    // Fix: #lastFrameDrainAt = 0 still; frame drain at T=90_100 computes gap = 90_100ms
    // → snapped=true (correctly surfaces the large background gap).
    //
    // Wrong impl killed: any impl where reconcile's internal step-forward updates the
    // same timer as the public frame drain (causing the gap to appear small).
    const p = mkPredictor();
    p.reconcile(baseline(1, 1, 0), [], 0, 0);
    // Establish last FRAME drain at T=0
    p.drain(0);
    // Three server batches arrive while tab is backgrounded
    p.reconcile(baseline(1, 1, 0), [], 0, 50_000);
    p.reconcile(baseline(1, 1, 0), [], 0, 60_000);
    p.reconcile(baseline(1, 1, 0), [], 0, 90_000);
    // Frame loop resumes 100ms after the last reconcile (90_100ms total from last frame drain)
    // Bug: gap = 90_100 - 90_000 = 100ms → snapped=false (WRONG — hides the 90s gap)
    // Fix: gap = 90_100 - 0 = 90_100ms >> threshold → snapped=true (CORRECT)
    const r = p.drain(90_100);
    expect(r.snapped).toBe(true);
  });

  it('BITES: first frame drain (never drained before) does not snap even on large time', () => {
    // The existing ADR-0052 §B rule: first drain never snaps (no prior drain to measure gap against).
    // This must hold even after M12.5d fix — the fix must not change the first-drain contract.
    //
    // Wrong impl killed (regression): if the fix accidentally initializes #lastFrameDrainAt=0
    // instead of undefined, the first drain at T=1_000_000 would compute gap=1_000_000 > threshold
    // → snapped=true (false positive). After fix: first drain with no prior = no snap (undefined guard).
    const p = mkPredictor();
    p.reconcile(baseline(1, 1, 0), [], 0, 0);
    // No prior frame drain — first call to drain() (even at T=1_000_000) should NOT snap
    const r = p.drain(1_000_000);
    expect(r.snapped).toBe(false);
  });
});
