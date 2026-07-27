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

// nh3 (ADR-0152): the node builtins below serve ONE tooth — the predictor.ts SIGNATURE
// source-scan at the foot of this file (the required-param mutant is invisible to any
// runtime test, and main.ts is coverage-excluded). Same readFileSync idiom as
// main.wiring.test.ts / net/connection.test.ts. No `new RegExp` anywhere (Semgrep-banned).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // ─── ADR-0013.5 §residual: setMove/clearQueue bypass pendingCap ──────────────
  //
  // INVARIANT: setMove() and clearQueue() INTENTIONALLY bypass the pendingCap guard.
  // They are DESTRUCTIVE ops whose pending record SUPERSEDES prior pending in reconcile
  // replay, making them infrequent. A pendingCap gate on them would be semantically
  // wrong (they need to record to stay coherent with the server-side queue state).
  //
  // These tests BITE any future refactor that accidentally gates setMove/clearQueue by
  // pendingCap. The return type (IntentToSend, not IntentToSend | undefined) is also
  // load-bearing: if the gate were added, the type must change too — these tests
  // additionally protect against a silent undefined return.
  //
  // References: predictor.ts §#record comment, spec plan m13.5b-plan.md §2 anti-pattern 1.
  it('ADR-0013.5 §residual: setMove bypasses pendingCap (DESTRUCTIVE op intentionally unbound)', () => {
    const PENDING_CAP = 2;
    const p = mkPendingCapped(/*queueCap*/ 8, PENDING_CAP);
    p.reconcile(baseline(5, 5, 0), [], 0, 0);

    // Fill pending to cap with two enqueues.
    expect(p.enqueue(east())).toBeDefined();
    expect(p.enqueue(east())).toBeDefined();
    expect(p.pendingCount).toBe(PENDING_CAP); // at cap

    // setMove MUST still record (bypass the cap) and return a real IntentToSend.
    const setIntent = p.setMove(north());
    // Non-undefined return: the type is IntentToSend (not | undefined), proving no gate.
    expect(setIntent).toBeDefined();
    expect(typeof setIntent.seq).toBe('number');
    // pendingCount exceeds pendingCap — intentional bypass documented.
    expect(p.pendingCount).toBe(PENDING_CAP + 1);
  });

  it('ADR-0013.5 §residual: clearQueue bypasses pendingCap (DESTRUCTIVE op intentionally unbound)', () => {
    const PENDING_CAP = 2;
    const p = mkPendingCapped(/*queueCap*/ 8, PENDING_CAP);
    p.reconcile(baseline(5, 5, 0), [], 0, 0);

    // Fill pending to cap.
    expect(p.enqueue(east())).toBeDefined();
    expect(p.enqueue(east())).toBeDefined();
    expect(p.pendingCount).toBe(PENDING_CAP); // at cap

    // clearQueue MUST still record and return a real IntentToSend (not void, not undefined).
    const clearIntent = p.clearQueue();
    expect(clearIntent).toBeDefined();
    expect(typeof clearIntent.seq).toBe('number');
    // pendingCount exceeds pendingCap — intentional bypass documented.
    expect(p.pendingCount).toBe(PENDING_CAP + 1);
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
    held.press('East', 0);

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
    held.press('East', 0);

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
    held.press('East', 0);

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
// M13.5b ADR-0085 — Predictor.dropRejected(seq, epoch): evict a known-dead pending op
//
// HISTORY: authored RED against a Predictor with no `dropRejected` at all (M13.5b);
// GREEN since that shipped. nh3 (ADR-0152) added the REQUIRED second parameter, so
// every call below now passes an epoch read from an intent THAT SAME instance issued
// (never a literal — see the nh3 banner further down for why a literal would leave
// the `false`-oracle cases green-and-vacuous). This block is the SAME-EPOCH contract;
// the cross-epoch guard is pinned by the nh3-2 block and by N3/N4 below it.
//
// API CONTRACT (pinned):
//   dropRejected(seq: number, epoch: PredictorEpoch): boolean
//   - Removes EXACTLY the pending op with that seq (filter !==), and ONLY when
//     `epoch` is this instance's own epoch. Returns true iff one was removed.
//   - Does NOT touch #queue (queueDepth unchanged by the call itself).
//   - Does NOT touch #nextSeq.
//   - Unknown / already-dropped seq → returns false, no state change (idempotent).
//   - Foreign epoch → returns false and changes NOTHING (nh3-1; see N3).
// ================================================================================

describe('dropRejected (M13.5b ADR-0085)', () => {
  // ---- helpers reused across the block -----------------------------------------
  function mkP(): Predictor {
    return new Predictor(applyMove, STEP_MS, QUEUE_CAP);
  }

  // ---- exact-removal -----------------------------------------------------------
  it('removes exactly the targeted seq and returns true; survivors are n1 and n3', () => {
    // Kills: filter `>= seq` (drops n2+n3), filter `> seq` (drops n3 too),
    // drop-all (drops everything), or always-false return.
    const p = mkP();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);
    const i1 = p.enqueue(east())!; // seq n1
    const i2 = p.enqueue(east())!; // seq n2  ← the one we drop
    const i3 = p.enqueue(east())!; // seq n3

    const removed = p.dropRejected(i2.seq, i2.epoch);

    expect(removed).toBe(true);
    expect(p.pendingCount).toBe(2); // n1 and n3 survive

    // Confirm n1 and n3 still survive: reconcile at ack n1 → only n3 remains.
    p.reconcile(baseline(5, 5, 0), [], i1.seq, 0);
    expect(p.pendingCount).toBe(1); // n3 alone

    // Confirm n3 is also gone after reconcile at n3.
    p.reconcile(baseline(5, 5, 0), [], i3.seq, 0);
    expect(p.pendingCount).toBe(0);
  });

  // ---- unknown seq → idempotent no-op ------------------------------------------
  it('unknown seq returns false and leaves pendingCount unchanged', () => {
    // Kills: always-true return / non-idempotent drop that removes the wrong op.
    const p = mkP();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);
    const i1 = p.enqueue(east())!;

    const neverIssuedSeq = i1.seq + 9999;
    // The epoch argument is read from an intent THIS instance issued (nh3 plan A9:
    // never a literal — a plausible `0` can never match the real epoch, which would
    // make the `false` oracle below pass for the wrong reason).
    const removed = p.dropRejected(neverIssuedSeq, i1.epoch);

    expect(removed).toBe(false);
    expect(p.pendingCount).toBe(1); // i1 untouched

    // POSITIVE CONTROL (nh3 plan §3 step 3 / reviewer M2), ordered AFTER the
    // unknown-seq oracle so it cannot invalidate it: the SAME epoch value, paired
    // with a seq this instance really issued, MUST evict. That proves the epoch
    // passed above is live — so the `false` above is caused by the unknown seq
    // alone, not by a silently-mismatching epoch.
    expect(p.dropRejected(i1.seq, i1.epoch)).toBe(true);
    expect(p.pendingCount).toBe(0);
    void i1;
  });

  // ---- already-dropped → second call is a no-op --------------------------------
  it('idempotent: second dropRejected on the same seq returns false', () => {
    // Kills: an impl that mutates state (returns different values or double-drops).
    const p = mkP();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);
    const i1 = p.enqueue(east())!;

    expect(p.dropRejected(i1.seq, i1.epoch)).toBe(true);
    expect(p.dropRejected(i1.seq, i1.epoch)).toBe(false); // second call: already gone
    expect(p.pendingCount).toBe(0);
  });

  // ---- queueDepth is NOT touched by dropRejected alone -------------------------
  it('queueDepth unchanged by the call in isolation (enqueue 2, drop 1 → queueDepth still 2)', () => {
    // Kills: a #queue-splicing impl that maintains two sources of truth
    // (#queue and #pending) and splices both on dropRejected.
    const p = mkP();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);
    const i1 = p.enqueue(east())!;
    const i2 = p.enqueue(east())!;
    const depthBefore = p.queueDepth; // 2

    p.dropRejected(i1.seq, i1.epoch);

    // #queue must be UNCHANGED — only reconcile rebuilds it.
    expect(p.queueDepth).toBe(depthBefore);
    void i2;
  });

  // ---- #nextSeq not altered by dropRejected ------------------------------------
  it('does not alter seq numbering: post-drop enqueue gets a seq > all prior seqs', () => {
    // Kills: an impl that rolls back #nextSeq after eviction, causing seq reuse.
    const p = mkP();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);
    const i1 = p.enqueue(east())!;
    const i2 = p.enqueue(east())!;

    p.dropRejected(i2.seq, i2.epoch);
    // free up a queue slot by dropping then reconciling
    p.reconcile(baseline(5, 5, 0), [], i2.seq, 0); // ack up to i2 (nothing survives)

    const i3 = p.enqueue(north())!;
    expect(i3.seq).toBeGreaterThan(i2.seq); // never reuses i2's seq
    void i1;
  });

  // ---- fast-check property: pendingCount delta and no survivor has dropped seq --
  it('property: pendingCount delta == (seq present ? 1 : 0) and no survivor has the dropped seq', () => {
    // Kills: any mutation to wrong ops, over-drop, or under-drop.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }), // how many ops to enqueue
        fc.integer({ min: 0, max: 6 }), // index to attempt to drop (may be out of range)
        (count, dropIndex) => {
          const p = mkP();
          p.reconcile(baseline(5, 5, 0), [], 0, 0);

          const intents: IntentToSend[] = [];
          for (let i = 0; i < count; i++) {
            // drain before each enqueue to keep queue room available
            p.reconcile(baseline(5, 5, 0), [], 0, 0);
            const intent = p.enqueue(east());
            if (intent !== undefined) intents.push(intent);
          }

          const countBefore = p.pendingCount;

          const targetSeq = dropIndex < intents.length ? intents[dropIndex]!.seq : 999999; // guaranteed absent

          const wasPresent = intents.some((i) => i.seq === targetSeq);
          // Epoch read from an intent THIS instance issued (nh3 plan A9). Safe:
          // count >= 1, the loop reconciles BEFORE each enqueue and count <= 5 <
          // QUEUE_CAP (8), so no enqueue is declined → intents[0] always exists.
          const removed = p.dropRejected(targetSeq, intents[0]!.epoch);

          expect(removed).toBe(wasPresent);
          const expectedDelta = wasPresent ? 1 : 0;
          expect(p.pendingCount).toBe(countBefore - expectedDelta);
        },
      ),
    );
  });

  // ---- 13.5b-1 CORE REPRODUCTION (the phantom-intent desync class) -------------
  //
  // This is the load-bearing proof fixture. It documents and locks the exact bug:
  //   - Without dropRejected, a pending op with seq N (server never acked, server
  //     rolled back its seq bump on Err) survives every prune and replays onto the
  //     authoritative queue at every reconcile → persistent 1-tile offset, diverged=false.
  //   - With dropRejected(N) + one reconcile, the phantom op is gone and predicted
  //     converges to authority.
  //
  // Kills: any impl where the movement rejection does NOT evict the pending op,
  // leaving the client 1 tile off the server forever (diverged=false).
  it('13.5b-1 CORE: silent desync RED-LOCK + dropRejected convergence', () => {
    const t0 = 10_000;
    const p = mkP();

    // Seed at (5, 5), two steps ago so a queued East is immediately due.
    p.reconcile(baseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    // Enqueue East (seq N) and drain → predicted x moves to 6.
    const intent = p.enqueue(east())!;
    const seqN = intent.seq;
    p.drain(t0);
    expect(p.predicted!.pos.x).toBe(6); // client side-effect: client is at x=6

    // --- RED-LOCK: documents the bug class ---
    // Server REJECTED the move: last acked seq is still N-1 (= seqN - 1).
    // The server's authoritative baseline remains at (5, 5).
    // WITHOUT dropRejected, repeated reconciles at ackedSeq = seqN-1 leave
    // predicted permanently at x=6 (one tile off authority) with diverged=false.
    // This is the silent desync: reconcile "agrees" because the phantom op always
    // replays East onto the auth baseline, pushing predicted to 6 every time.
    const authBase = baseline(5, 5, t0 - 2 * STEP_MS);
    const ackedSeqBeforeReject = seqN - 1;

    const d1 = p.reconcile(authBase, [], ackedSeqBeforeReject, t0);
    expect(d1).toBe(false); // diverged=false: reconcile "agrees" (the BUG)
    expect(p.predicted!.pos.x).toBe(6); // still off: phantom East replayed

    const d2 = p.reconcile(authBase, [], ackedSeqBeforeReject, t0);
    expect(d2).toBe(false); // still false, still off
    expect(p.predicted!.pos.x).toBe(6); // permanently 1-tile off authority

    const d3 = p.reconcile(authBase, [], ackedSeqBeforeReject, t0);
    expect(d3).toBe(false);
    expect(p.predicted!.pos.x).toBe(6);
    // ^^^ This proves dropRejected is load-bearing: without it the loop never converges.

    // --- THE FIX ---
    // dropRejected(seqN) evicts the phantom op.
    const dropped = p.dropRejected(seqN, intent.epoch);
    expect(dropped).toBe(true);

    // One more reconcile at the same ackedSeq (server still at x=5, ack still N-1).
    const dFix = p.reconcile(authBase, [], ackedSeqBeforeReject, t0);

    // NOW predicted must equal the authoritative baseline position (5, 5).
    // The repair reconcile reports a genuine correction (tile moved back to authority)
    // — divergence flag true is CORRECT here; the silent-desync bug was the NO-DROP
    // path returning false while staying wrong (pre-reconcile predicted x=6, authority
    // x=5, phantom evicted → post-reconcile corrects to x=5 → tiles differ → true).
    expect(dFix).toBe(true);
    expect(p.predicted!.pos).toEqual({ x: 5, y: 5 }); // converged
    expect(p.pendingCount).toBe(0); // phantom op gone
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

// ================================================================================
// ptc5f → nh3-2: the cross-warp eviction pin — was "documented (not fixed)", NOW
// PINS THE FIX. (ADR-0142 D4 reachability bound → ADR-0085 amendment / ADR-0152.)
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-netcode-hardening.spec.md §nh3
// (nh3-2 quoted VERBATIM in the nh3 banner immediately below this block).
//
// WHAT ptc5f PINNED (history, unchanged premise): dropRejected is PRECISE within one
// predictor instance — it removes exactly the pending op with the given seq and never
// a neighbor (the single-epoch test below). But `#nextSeq` starts at 0 in every fresh
// Predictor and `seedSeq` only ever RAISES it (monotonic, never rewinds), so a
// rebuilt-and-re-seeded predictor whose seed is <= 0 REUSES the exact seq space of the
// discarded pre-warp predictor (own-zone warp → resetPredictionState()). A stale
// rejection arriving late then evicted the REBUILT predictor's brand-new legit op
// purely by seq-space collision — a swallowed first post-warp move. ptc5f asserted
// that collision was real and reachable, and accepted the risk.
//
// WHAT nh3 CHANGES HERE:
//   • Arm 1 — the collision premise is KEPT VERBATIM (`newOp.seq === preWarpOp.seq`).
//     It is what makes the guard's job non-trivial, and it pins that the fix is
//     EPOCH-based, not seq-disjointness. It deliberately models the UN-FLOORED pair
//     (`b.seedSeq(0)`) so it stays valid alongside the main.ts seq-floor, which is a
//     SECOND, independent mechanism (Case M2; pinned by N6 + W-NH3-FLOOR-*).
//   • Arm 2 — the eviction assertion is FLIPPED to `false`: the stale drop is a TOTAL
//     no-op and the legit op SURVIVES (proven BY CONTENT via a reconcile replay, not
//     by a pendingCount delta). This is the nh3-2 assertion.
//   • Arm 4 — a SAME-epoch post-warp rejection still evicts (the Case-M2 behavior
//     pin). Without it the whole test would pass against `dropRejected(){return false}`.
// (Arm 3, ptc5f's separate control predictor `c`, is FOLDED into arm 2's comment: it
// is redundant post-flip, because arm 4 already rules out a never-removes impl.)
// ================================================================================
describe('Predictor nh3-2 (was ptc5f): cross-warp stale rejection is epoch-guarded', () => {
  it('normal single-epoch: dropRejected targets EXACTLY the given seq, never a neighbor', () => {
    // Kills: an impl that drops a neighbor seq (off-by-one filter), drops everything,
    // or never actually removes (always-false return) — any of these flips one of
    // the later booleans below, since a, b, c occupy disjoint seq slots (1, 2, 3).
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0); // seed
    const a = p.enqueue(east())!;
    const b = p.enqueue(east())!;
    const c = p.enqueue(east())!;
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(p.pendingCount).toBe(3);

    expect(p.dropRejected(b.seq, b.epoch)).toBe(true);
    expect(p.pendingCount).toBe(2);
    expect(p.dropRejected(b.seq, b.epoch)).toBe(false); // idempotent — already gone

    // Vacuous-eviction is impossible here: if dropRejected(b.seq) had actually
    // removed a or c instead of b, one of these would report false (nothing left
    // to drop) or pendingCount would not reach exactly 0.
    expect(p.dropRejected(a.seq, a.epoch)).toBe(true);
    expect(p.dropRejected(c.seq, c.epoch)).toBe(true);
    expect(p.pendingCount).toBe(0);
  });

  it('cross-warp (nh3-2): the seq collision is REAL, yet the stale rejection no-ops and the NEW legit op SURVIVES', () => {
    // ---- ARM 1: the collision premise, KEPT VERBATIM from ptc5f -----------------
    // Pre-warp predictor A: issues one still-unacked in-flight op; A is then
    // discarded on warp (e.g. a zone transition rebuilds the predictor).
    const a = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    const preWarpOp = a.enqueue(east())!;
    expect(preWarpOp.seq).toBe(1);

    // Post-warp: a REBUILT predictor B is created while the server ack is still 0
    // (the warp landed before any ack advanced past the pre-warp op).
    const b = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    b.seedSeq(0);
    const newOp = b.enqueue(east())!;
    // THE COLLISION: B's brand-new op reuses A's exact seq — a deterministic
    // consequence of #nextSeq starting at 0 in both instances and seedSeq(0)
    // never rewinding (it's a no-op here since 0 is not > the current #nextSeq).
    // KEPT ON PURPOSE (plan §5 arm 1): this models the UN-FLOORED pair, so the arms
    // below prove the fix is the EPOCH GUARD and not seq-disjointness. The main.ts
    // seq-floor is a separate mechanism (see N6 / W-NH3-FLOOR-*).
    expect(newOp.seq).toBe(preWarpOp.seq);

    // ---- ARM 2 (THE nh3-2 ASSERTION, flipped from ptc5f's `true`) ---------------
    // A stale rejection of A's pre-warp op arrives late and fires against B (the
    // module-scope predictor is now B). It carries A's epoch — a FOREIGN epoch for
    // B — so the guard must make it a TOTAL no-op even though the seq collides.
    //
    // ARM 3 (ptc5f's separate control predictor `c`) IS FOLDED INTO THIS COMMENT:
    // post-flip it was redundant. The guard is a no-op on the STALE path only, not a
    // survive-all — and "b's op survived" cannot be explained by a dropRejected that
    // never removes anything, because arm 4 below makes the same-epoch call evict.
    expect(b.dropRejected(preWarpOp.seq, preWarpOp.epoch)).toBe(false);

    // Prove SURVIVAL BY CONTENT (a pendingCount delta alone is vacuous — it would
    // also read as 1 if dropRejected merely returned false without guarding). Force
    // a queue rebuild via reconcile: rebasedAt === now (the file's established
    // trick, see "no re-issue when held direction matches queue tail" above) means
    // reconcile's internal drain step consumes nothing, isolating the pending-replay.
    b.reconcile(baseline(5, 5, 0), [], 0, 0);
    expect(b.queueDepth).toBe(1); // the legit post-warp op replayed from pending
    expect(b.lastQueuedDir).toBe('East');

    // ---- ARM 4: the Case-M2 residual / behavior pin (re-labeled, plan §5) -------
    // A GENUINE post-warp rejection carries B's OWN epoch: the server rejects the
    // colliding seq as "stale seq" (guards.rs `seq <= last_input_seq`), and evicting
    // it IS contractually correct. The guard must NOT suppress this — the mechanism
    // that prevents that rejection from ever existing is the main.ts seq-FLOOR
    // (lastSentSeq → seedSeq), not this guard.
    // WITHOUT THIS ARM the whole test would pass against `dropRejected(){return false}`.
    expect(b.dropRejected(newOp.seq, newOp.epoch)).toBe(true);
    b.reconcile(baseline(5, 5, 0), [], 0, 0);
    expect(b.queueDepth).toBe(0); // nothing left to replay — the op's record is gone
    expect(b.lastQueuedDir).toBeUndefined();
  });
});

// ================================================================================
// nh3 / ADR-0152 — Predictor epoch/generation guard on the eviction seam (+ the
// main.ts send-seq FLOOR it ships with).
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-netcode-hardening.spec.md §nh3.
// The criteria, quoted VERBATIM (do not paraphrase — the nh2 banner post-mortem):
//
//   nh3-1  `Predictor` SHALL carry an epoch/generation identifier, bumped on every
//          `resetPredictionState()` rebuild. A rejection `.catch`'s captured epoch
//          SHALL be compared against the live predictor's current epoch before
//          calling `dropRejected(seq)`; a mismatch SHALL no-op instead of evicting.
//   nh3-2  (proof-of-teeth): extend the existing reachability-pinning tests in
//          `predictor.test.ts` (added at ptc5f) so the previously-accepted-risk
//          scenario (warp while holding a key → stale-seq rejection lands
//          post-rebuild) now asserts the legitimate new op survives, not just that
//          the gap is reachable. A mutation check: removing the epoch guard
//          re-fails this assertion.
//   nh3-3  (doc): amend ADR-0085 to record the guard is built — the accepted-risk
//          window closes.
//
// SPEC-CONFORMANCE NOTE (nh3-1's letter vs. this design): the epoch comparison lives
// INSIDE `dropRejected` (the CALLEE), not literally inside the `.catch`. Sanctioned by
// spec §3. The `.catch` captures the epoch (`const epoch = intent.epoch;`, ADR-0085 A2
// posture: capture primitives, never the predictor instance) and passes it in; the
// callee is where a compiler-REQUIRED parameter can force every present and future
// call site to supply one. Wiring pinned by W-NH3-* in main.wiring.test.ts; the
// required-param shape by the SIGNATURE scan at the foot of this file.
//
// TWO MECHANISMS SHIP UNDER nh3 — the seq collision has TWO arms (plan §1):
//   Case M1  the DEAD predictor's op was REJECTED (queue full → txn rollback, ack
//            unchanged); post-rebuild a fresh op takes the same seq and the server
//            ACCEPTS it; the stale rejection then evicts the NEW, accepted op.
//            ← THE EPOCH GUARD closes exactly this (N3, N4, the nh3-2 block above).
//   Case M2  the pre-warp op was ACCEPTED first (FIFO), so the post-rebuild colliding
//            op is itself rejected as "stale seq". That rejection carries the LIVE
//            epoch, the guard correctly passes, the eviction is CORRECT — and the
//            player's first post-warp move is swallowed anyway. No rejection-side
//            guard can fix it: the defect is upstream (a re-ISSUED seq).
//            ← THE main.ts SEND-SEQ FLOOR closes this (`lastSentSeq` → `seedSeq`):
//              modeled at predictor level by N6, wiring pinned by W-NH3-FLOOR-*.
//
// CRITERION -> TEST MAP (the auditable answer to "what covers nh3-N?"):
//   nh3-1  N1 (a distinct epoch per instance — the "bumped on every rebuild" clause,
//              since resetPredictionState() rebuilds = constructs)
//          N2 (the same-epoch path is UNCHANGED: evict, then idempotent false)
//          N3 (a foreign epoch no-ops TOTALLY under a REAL seq collision)
//          N4 (property: foreign epochs never mutate — both BELOW and ABOVE live)
//          N5 (ONE epoch per instance across enqueue/setMove/clearQueue, stable
//              across seedSeq/reconcile/drain: constructor-assigned, not per-record)
//          + W-NH3-SIG / W-NH3-BRAND / W-NH3-NO-GETTER (source scans, foot of file)
//          + W-NH3-EPOCH-CAPTURED (main.wiring.test.ts: the `.catch` capture)
//   nh3-2  the `Predictor nh3-2 (was ptc5f)` block ABOVE — arm 1 premise kept, arm 2
//          flipped to `false` + content survival, arm 4 same-epoch still evicts
//   nh3-3  docs only (ADR-0085 amendment + ADR-0152) — no test
//   supervisor-added FLOOR (not an EARS criterion): N6 + W-NH3-FLOOR-SEND /
//          W-NH3-FLOOR-SEED (main.wiring.test.ts)
//
// RED REASON (runtime, NOT tsc — `client/tsconfig.json` excludes `**/*.test.ts`, so
// these tests are never typechecked): pre-implementation `IntentToSend` has no
// `epoch` field, so every `intent.epoch` read is `undefined`. Distinctness (N1),
// stability-with-not-undefined (N5), the foreign-epoch oracles (N3, N4), N6's
// new-generation assertion and the nh3-2 arm-2 flip therefore fail on VALUES, not on
// a compile error. N2 and arm 4 (same-epoch paths) are GREEN before AND after — they
// are the anti-over-guard teeth that kill a `!==` → `===` flip. N6's seq-floor
// assertions are also green before and after (the floor uses only existing public
// API — `seedSeq`); its RED gating counterpart is W-NH3-FLOOR-SEED in
// main.wiring.test.ts, which pins that main.ts actually calls it.
//
// A6 (no absolute-epoch assertions): the static counter's values depend on how many
// Predictors the WHOLE FILE constructed first, so every assertion below is RELATIVE
// (distinct / equal / not-equal / ±1). A8 (no public epoch getter): the live epoch is
// readable ONLY from an issued intent — which is also why N-tests enqueue a probe op.
// ================================================================================

describe('Predictor nh3 (ADR-0152): epoch/generation guard on dropRejected', () => {
  it('N1 (nh3-1): every instance carries a DISTINCT epoch — all constructed FIRST, then probed', () => {
    // Kills: a constant epoch (`#epoch = 0`) — the Set collapses to size 1.
    // Kills: a `#record`-time read of the static counter (red-team F7). Constructing
    // ALL instances BEFORE any enqueue is the load-bearing ordering: with a per-record
    // read every probe below would report the SAME (final) counter value, so the
    // distinct-count would be 1 while a construct-then-probe-interleaved test would
    // still pass. N5 attacks the same mutant from the other side.
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), (n) => {
        const instances: Predictor[] = [];
        for (let i = 0; i < n; i++) instances.push(mkPredictor());
        // The epoch is only readable via an issued intent (A8: no public getter).
        const epochs = instances.map((p) => p.enqueue(east())!.epoch);
        // `undefined` = no epoch stamped at all (the pre-impl RED state): the Set below
        // would then collapse to size 1 anyway, but assert it directly for a clear message.
        for (const e of epochs) expect(e).not.toBeUndefined();
        // RELATIVE assertion only (A6): distinctness, never an absolute value.
        expect(new Set(epochs).size).toBe(n);
      }),
    );
  });

  it('N2 (nh3-1): the SAME-epoch path is unchanged — evicts, then idempotent false', () => {
    // Kills: `!==` → `===` in the guard (every legitimate rejection would then be
    // ignored and the phantom-op desync of M13.5b/ADR-0085 comes straight back).
    // GREEN before AND after the fix by design (pre-impl: undefined === undefined).
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);
    const i1 = p.enqueue(east())!;

    expect(p.dropRejected(i1.seq, i1.epoch)).toBe(true);
    expect(p.pendingCount).toBe(0);
    expect(p.dropRejected(i1.seq, i1.epoch)).toBe(false); // already gone
    expect(p.pendingCount).toBe(0);
  });

  it('N3 (nh3-1): a FOREIGN epoch no-ops TOTALLY — false, pendingCount AND queueDepth unchanged', () => {
    // Kills: deleting the epoch mismatch early-return (Case M1 — the whole slice).
    // NON-VACUITY (the load-bearing setup): the two instances are built so their
    // seqs COLLIDE, and that collision is asserted. Without it, `false` would be
    // explained by seq-absence and the test would pass against a guardless impl.
    const dead = mkPredictor(); // the pre-warp instance, about to be discarded
    const live = mkPredictor(); // the post-rebuild instance (resetPredictionState)
    dead.reconcile(baseline(5, 5, 0), [], 0, 0);
    live.reconcile(baseline(5, 5, 0), [], 0, 0);
    const deadOp = dead.enqueue(east())!;
    const liveOp = live.enqueue(east())!;
    expect(liveOp.seq).toBe(deadOp.seq); // the collision is REAL — no vacuous false

    const pendingBefore = live.pendingCount;
    const depthBefore = live.queueDepth;
    expect(pendingBefore).toBe(1);
    expect(depthBefore).toBe(1);

    // TOTALITY: the return value AND both state accessors.
    expect(live.dropRejected(deadOp.seq, deadOp.epoch)).toBe(false);
    expect(live.pendingCount).toBe(pendingBefore);
    expect(live.queueDepth).toBe(depthBefore);

    // POSITIVE CONTROL (reviewer M2): the same seq IS evictable with the live
    // instance's own epoch — so the `false` above was the GUARD, not an unrelated
    // failure to find the op, and the guard is not a blanket `return false`.
    expect(live.dropRejected(liveOp.seq, liveOp.epoch)).toBe(true);
    expect(live.pendingCount).toBe(0);
  });

  it('N4 (nh3-1): property — a foreign epoch NEVER mutates, for values both BELOW and ABOVE live', () => {
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);
    const i1 = p.enqueue(east())!;
    const i2 = p.enqueue(east())!;
    const liveEpoch = i1.epoch; // only readable via an issued intent (A8)

    // DETERMINISTIC CORE FIRST — this file pins no fast-check seed, so the relational
    // mutant kill must not depend on what fc happens to draw. One foreign epoch
    // strictly BELOW and one strictly ABOVE the live value, both against a seq that
    // IS pending: a guard written `epoch < this.#epoch` (or `>`) passes one and fails
    // the other; only `!==` passes both (red-team F4).
    expect(p.dropRejected(i1.seq, liveEpoch - 1)).toBe(false);
    expect(p.dropRejected(i1.seq, liveEpoch + 1)).toBe(false);
    expect(p.pendingCount).toBe(2); // nothing evicted by either

    const pendingBefore = p.pendingCount;
    const depthBefore = p.queueDepth;

    // BREADTH: arbitrary (seq, foreignEpoch) against the SAME live instance — the
    // guard must be idempotent, so no draw may ever mutate it. The seq arbitrary
    // includes the two REALLY pending seqs (otherwise every `false` is excused by
    // seq-absence); the epoch arbitrary EXCLUDES the live value by `.filter` (F7: an
    // unconstrained small-integer arbitrary WILL draw the real epoch, which would
    // red a CORRECT impl order-dependently).
    const seqArb = fc.oneof(fc.constantFrom(i1.seq, i2.seq), fc.integer({ min: -5, max: 50 }));
    const foreignBase = fc.oneof(
      fc.integer({ min: -1_000, max: 1_000 }),
      fc.constantFrom(liveEpoch - 1, liveEpoch + 1, liveEpoch - 250, liveEpoch + 250),
    );
    const foreignEpochArb = foreignBase.filter((e) => e !== liveEpoch);
    fc.assert(
      fc.property(seqArb, foreignEpochArb, (seq, foreignEpoch) => {
        expect(p.dropRejected(seq, foreignEpoch)).toBe(false);
        expect(p.pendingCount).toBe(pendingBefore);
        expect(p.queueDepth).toBe(depthBefore);
      }),
    );

    // POSITIVE CONTROL: after all that, the live epoch still evicts (not a blanket
    // false, and the property's no-mutation runs really did leave the op in place).
    expect(p.dropRejected(i2.seq, i2.epoch)).toBe(true);
    expect(p.pendingCount).toBe(1); // i1 still pending — only i2 was evicted
  });

  it('N5 (nh3-1): ONE epoch per instance across enqueue/setMove/clearQueue, stable across seedSeq/reconcile/drain', () => {
    // Kills: a per-record epoch (re-reading the static counter inside #record instead
    // of the CONSTRUCTOR-assigned instance field). The interleaved construction of
    // `other` below is what makes that mutant visible: a per-record read would hand
    // the post-`other` intent a DIFFERENT value from the pre-`other` ones.
    const p = mkPredictor();
    p.reconcile(baseline(5, 5, 0), [], 0, 0);

    const enq = p.enqueue(east())!;
    const set = p.setMove(north());
    const clr = p.clearQueue();
    expect(enq.epoch, 'an issued intent must carry an epoch at all').not.toBe(undefined);
    expect(set.epoch).toBe(enq.epoch); // setMove stamps the SAME instance epoch
    expect(clr.epoch).toBe(enq.epoch); // clearQueue too

    // A DIFFERENT instance is born (and records) in between — the static counter moves.
    const other = mkPredictor();
    const otherOp = other.enqueue(east())!;
    expect(otherOp.epoch).not.toBe(enq.epoch); // relative only (A6)

    // Every state transition the live predictor undergoes between rebuilds.
    p.seedSeq(500);
    p.reconcile(baseline(6, 6, 0), [], 0, 0);
    p.drain(1_000);
    const afterAll = p.enqueue(east())!;
    expect(afterAll.epoch).toBe(enq.epoch); // constructor-assigned, never re-read

    // And the guard still keys off THAT epoch after all of it.
    expect(p.dropRejected(afterAll.seq, afterAll.epoch)).toBe(true);
  });

  it('N6 (the Case-M2 seq FLOOR, mechanism pin): a floored rebuild never re-issues a sent seq', () => {
    // WHAT THIS MODELS (main.ts, coverage-excluded — wiring pinned by
    // W-NH3-FLOOR-SEND / W-NH3-FLOOR-SEED): `lastSentSeq` records the highest seq
    // ever SENT at the single send site; `resetPredictionState()` calls
    // `predictor.seedSeq(lastSentSeq)` on the fresh instance. The rebuilt predictor's
    // first seq is then strictly greater than anything the server has seen, so the
    // Case-M2 "stale seq" rejection never comes into existence (server accepts
    // `seq > last_input_seq`; gaps are legal — monotonic, not consecutive).
    const a = mkPredictor();
    a.reconcile(baseline(5, 5, 0), [], 0, 0);
    const sent1 = a.enqueue(east())!;
    const sent2 = a.enqueue(east())!;
    const lastSentSeq = sent2.seq; // what main.ts records beside the send

    // The warp rebuild: a FRESH instance (this is what resetPredictionState does),
    // floored to the last seq ever sent.
    const b = mkPredictor();
    b.seedSeq(lastSentSeq);
    b.reconcile(baseline(5, 5, 0), [], 0, 0);
    const first = b.enqueue(east())!;

    expect(first.seq).toBeGreaterThan(lastSentSeq); // NO collision — Case M2 gone
    expect(first.seq).toBeGreaterThan(sent1.seq);
    // nh3-1's "bumped on every resetPredictionState() rebuild": the rebuild is a NEW
    // generation, so the old instance's epoch can never match the new one.
    expect(first.epoch).not.toBe(sent2.epoch);

    // BELT AND SUSPENDERS (plan §1): even with the floor in place, a stale rejection
    // of A's op is a total no-op on B. HONEST TEETH ACCOUNTING — with the floor there
    // is no seq collision, so this particular `false` is ALSO explainable by
    // seq-absence; the guard's non-vacuous proof is N3 + nh3-2 arm 2, where the seqs
    // really do collide. This arm pins the COMPOSITION of the two mechanisms.
    const pendingBefore = b.pendingCount;
    const depthBefore = b.queueDepth;
    expect(b.dropRejected(sent2.seq, sent2.epoch)).toBe(false);
    expect(b.pendingCount).toBe(pendingBefore);
    expect(b.queueDepth).toBe(depthBefore);
  });
});

// ================================================================================
// nh3 SIGNATURE SOURCE-SCAN (plan §3 step 4) — the declared-sibling tooth.
//
// WHY A SOURCE SCAN AT ALL (red-team F4 / reviewer B1): the "make the epoch param
// optional or defaulted" mutation (`epoch?: PredictorEpoch` or
// `epoch: PredictorEpoch = this.#epoch`) is INVISIBLE to every runtime test in this
// file — all of them pass an epoch — and invisible to the main.wiring tooth too,
// because main.ts would not need to change. It is also invisible to `tsc`, since a
// call that already supplies the argument still typechecks. The only thing that can
// kill it is reading the declaration. Same reason the BRAND is pinned here: with
// `export type PredictorEpoch = number` the compiler would happily accept
// `dropRejected(seq, seq)` at the call site — the brand IS the tooth for that
// mutation, so its shape must be asserted, not assumed.
//
// indexOf / includes only — `new RegExp` is Semgrep-banned repo-wide (A7).
// ================================================================================

const PREDICTOR_TS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'predictor.ts');

function readPredictorTs(): string {
  try {
    return readFileSync(PREDICTOR_TS_PATH, 'utf8');
  } catch (err) {
    // Fail loud — a missing file must never make a scan vacuously pass.
    throw new Error(
      'predictor.ts unreadable at expected path: ' + PREDICTOR_TS_PATH + ' — ' + String(err),
    );
  }
}

describe('nh3 signature scan: dropRejected takes a REQUIRED branded epoch', () => {
  it('W-NH3-SIG BITES: predictor.ts declares `dropRejected(seq: number, epoch: PredictorEpoch): boolean`', () => {
    // RED pre-impl: the declaration is still the 1-arg `dropRejected(seq: number): boolean`.
    // WRONG IMPL KILLED: a plain-`number` second param (`epoch: number`) — that compiles
    // `dropRejected(seq, seq)` at main.ts and re-opens the eviction seam silently.
    const src = readPredictorTs();
    // Anti-vacuity: prove we are reading the real module before judging its shape.
    expect(
      src.indexOf('export class Predictor'),
      'the scanned file must be the real predictor module (export class Predictor)',
    ).toBeGreaterThanOrEqual(0);
    expect(
      src.indexOf('dropRejected(seq: number, epoch: PredictorEpoch): boolean'),
      'predictor.ts must declare the CONTIGUOUS signature ' +
        '`dropRejected(seq: number, epoch: PredictorEpoch): boolean` — a required, branded ' +
        'second parameter is what forces every present and future call site (main.ts and ' +
        'this suite) to supply the caller-captured epoch',
    ).toBeGreaterThanOrEqual(0);
  });

  it('W-NH3-SIG-REQUIRED BITES: the epoch param is neither optional (`epoch?:`) nor defaulted', () => {
    // WRONG IMPL KILLED (the mutation no runtime test and no wiring tooth can see):
    //   dropRejected(seq: number, epoch?: PredictorEpoch)                      → callers may omit
    //   dropRejected(seq: number, epoch: PredictorEpoch = this.#epoch)         → omitted == live
    // Either one lets a future call site (or a revert of main.ts:471 to 1-arg) drop the
    // epoch and silently restore the Case-M1 cross-generation eviction, with this whole
    // suite still green because every test here passes an epoch explicitly.
    //
    // NEEDLE PRECISION (a false-red this tester found while authoring, corrected FROM the
    // plan's intent, not weakened): the plan spells the second ban as `epoch: PredictorEpoch
    // =`, but a perfectly legal implementation may declare the FIELD as
    // `readonly #epoch: PredictorEpoch = ++Predictor.#nextEpoch as PredictorEpoch;` — which
    // contains that exact substring. The ban is therefore anchored to PARAMETER position
    // with a leading `, ` (a field declaration is never comma-prefixed). Same bite, no false
    // red: both banned forms remain unwriteable in the parameter list, and the positive
    // contiguous-signature needle in W-NH3-SIG independently rejects either mutation at the
    // declaration site.
    const src = readPredictorTs();
    expect(
      src.indexOf('epoch?:'),
      'predictor.ts must NOT declare an OPTIONAL epoch parameter (`epoch?:`) — an omitted ' +
        'epoch is exactly the pre-nh3 call shape the guard exists to make impossible (A1)',
    ).toBe(-1);
    expect(
      src.indexOf(', epoch: PredictorEpoch ='),
      'predictor.ts must NOT give the epoch PARAMETER a default (`, epoch: PredictorEpoch = ' +
        '...`) — a default that resolves to the live epoch makes an omitted argument ' +
        'silently self-approve, which is a no-op guard (A1)',
    ).toBe(-1);
  });

  it('W-NH3-BRAND BITES: PredictorEpoch is an exported BRANDED number, not a bare alias', () => {
    // WRONG IMPL KILLED: `export type PredictorEpoch = number`. The signature scan above
    // still passes, every runtime test still passes — but `dropRejected(seq, seq)` in
    // main.ts becomes legal, and that call is a permanent self-approving guard. The brand
    // is the ONLY mechanism that turns that mistake into a compile error (plan §2 R-b,
    // promoted to REQUIRED by reviewer M1). Tests are exempt from the cost: they are not
    // typechecked (`client/tsconfig.json` excludes `**/*.test.ts`), which is why no test
    // in this file imports or casts the branded type.
    const src = readPredictorTs();
    expect(
      src.indexOf('export type PredictorEpoch = number &'),
      'predictor.ts must export a BRANDED epoch type (`export type PredictorEpoch = number & ' +
        '{ readonly __brand: unique symbol }`) — a bare `= number` alias makes ' +
        '`dropRejected(seq, seq)` typecheck at main.ts and self-approve every rejection',
    ).toBeGreaterThanOrEqual(0);
  });

  it('W-NH3-NO-GETTER BITES: the live epoch has NO public getter (A8)', () => {
    // WRONG IMPL KILLED: `get epoch(): PredictorEpoch { return this.#epoch; }`. With a
    // public getter, main.ts could write `predictor.dropRejected(seq, predictor.epoch)` —
    // a call that ALWAYS matches, i.e. the guard deleted at the call site while every
    // tooth in this file stays green (plan A8 / R-a). The epoch must be readable only
    // from an issued intent, which is precisely how every test above obtains it.
    const src = readPredictorTs();
    expect(
      src.indexOf('get epoch('),
      'predictor.ts must NOT expose a public epoch getter — it would make the vacuous ' +
        'self-approving call `dropRejected(seq, predictor.epoch)` writable from main.ts (A8)',
    ).toBe(-1);
  });
});

// ================================================================================
// nh2 / ADR-0148 — held-key continuation gating on `outstandingSteps`
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-netcode-hardening.spec.md.
// The three criteria, quoted VERBATIM (do not paraphrase these — an earlier
// revision of this banner restated nh2-2 as "sustains the full walk rate", which
// is actually the nh2-3 COMPANION, and mis-answered "which test covers nh2-2?"):
//
//   nh2-1  WHEN a held movement key is released (or the player switches to a
//          different held direction) AND no further input in that direction has
//          been queued by player intent, THE client SHALL cancel/not-emit steps
//          beyond what the key-hold duration implies.
//   nh2-2  the fix SHALL NOT desync client prediction from server authoritative
//          state; whatever mechanism is used must reconcile cleanly, reusing the
//          existing `reconcileFromStore()` repair path rather than inventing a
//          second one.
//   nh2-3  proof-of-teeth: press -> hold long enough to queue 2 steps -> release
//          -> assert no further step beyond what was already committed/in-flight
//          is emitted. COMPANION: a genuinely-held key for the queue-cap duration
//          still moves the expected number of tiles (no regression on sustained
//          movement).
//
// CRITERION -> TEST MAP (the auditable answer to "what covers nh2-N?"):
//   nh2-1  U2 (tap emits once; the gate is not queueDepth)
//          U6 (emission rate pinned to the STEP cadence at 30/60/144Hz)
//          U8 (direction switch: <=1 further stale step, later emissions all North)
//          U3 (a) zero emissions after release
//   nh2-2  U5  (predicted advances <=1 tile per frame under an unaligned clock —
//               prediction tracks authority instead of running away)
//          U3 (c) predicted does not drift from where it was at release
//          U4 (predictedTilesMoved in [K, K+1] WHILE serverTilesMoved === K —
//              prediction leads authority by at most the one in-flight step)
//          U1b (an acked op moves from pending to auth WITHOUT double-counting —
//               the accounting that keeps reconcile's repair convergent)
//          [also, outside this file: the W-NH2-NO-CANCEL wiring tooth pins
//           `reconcileFromStore()` as the SOLE repair path — no second mechanism]
//   nh2-3  U3 (b) <=1 further SERVER commit after release (the literal scenario)
//          U4 (the COMPANION: a sustained hold still walks K tiles)
//   ADR-0148 ACCEPTED TRADE (not an EARS criterion, a documented-cost guard):
//          U7 / U7-XP / U7-DEG (latency + frame-rate budget)
//   ADR-0148 R1 residual (not an EARS criterion): U5b
//   accessor contract itself: U1a / U1b / U9
//
// RED AT AUTHORING TIME (pre-ADR-0148): `Predictor.outstandingSteps` did not
// exist, so the whole file failed to typecheck — this file's established RED
// convention (see the M3b banner at the top), red on a MISSING IMPLEMENTATION
// rather than a typo. They are GREEN now against the shipped ADR-0148 accessor;
// the `RED-TODAY PROOF` cases below re-create the pre-fix behaviour explicitly
// (`gateEnabled: false` / `drainFirst: false`) so the teeth stay demonstrably
// non-vacuous after the fix landed.
//
// The contract under test (the ONLY new public surface):
//     get outstandingSteps(): number   //  = #lastAuthQueueLen + #pending.length
// where `#lastAuthQueueLen` is assigned `authQueue.length` inside `reconcile()`.
//
// WHY A NEW ACCESSOR AT ALL — the load-bearing mechanic: the real client rebases
// every reconcile baseline to `now - 2*STEP_MS`, so `reconcile()`'s internal
// step-forward drains the whole (cap-bounded) queue IMMEDIATELY and leaves
// `queueDepth === 0`. `queueDepth` therefore reads 0 while the SERVER still owes
// one or more steps — it cannot serve as the gate. `outstandingSteps` counts what
// the server still owes: its undrained move_queue as of the last reconcile plus
// every op sent but not yet seen acked. U2 pins exactly that (`queueDepth === 0`
// AND `outstandingSteps === 1` at the same instant).
//
// Everything below runs on an INJECTED clock (no Date.now / performance.now /
// Math.random) against the file's deterministic `applyMove` fake and a tiny
// in-file server model. Cap 2 everywhere — the real MOVE_QUEUE_CAP is 2 and the
// file's QUEUE_CAP=8 predictor would not model reality: the pure-unit teeth
// (U1/U9) use `mkCapped(2)`, and `runLoop` constructs
// `new Predictor(applyMove, stepMs, cap)` directly with `cap` defaulting to 2.
//
// WHAT THE HARNESS DELIBERATELY DOES NOT MODEL (do not over-trust it):
//   (a) `authorize_move`'s `seq <= last_input_seq` -> Err("stale seq") rejection.
//       Unreachable through this harness today (arrivals are FIFO and `#nextSeq`
//       is strictly increasing), but it IS the mechanism a warp-epoch scenario
//       hits — see the ptc5f / ADR-0142 D4 pin above for that reachability bound.
//   (b) `movement_tick`'s empty-queue `action -> Idle` row write and the batch it
//       publishes. An idle tick here is silent, so the harness UNDER-COUNTS
//       reconciles relative to reality. Benign for every assertion below: the
//       missing reconciles only ever re-write `#lastAuthQueueLen = 0`, which is
//       the value the gate already sees.
//   (c) `emit()` counts sendIntent INVOCATIONS, not accepted reducer calls (the
//       emission is recorded before `predictor.enqueue`, and a server REJECT
//       still counts). That is conservative for every `<=` bound below, and it is
//       faithful to main.ts, which also calls `enqueue` unconditionally.
//   (d) RESIDUAL (noted, NOT fixed — a cross-language pin is out of this slice's
//       touch-set): the harness HARDCODES the server queue cap
//       (`const cap = opts.cap ?? 2`) instead of deriving it from the Rust SSOT
//       `game-core/src/world.rs` `MOVE_QUEUE_CAP = 2`, so a server-side cap change
//       would silently drift this simulation with nothing to catch it. Same
//       pre-existing pattern as this file's `STEP_MS = 200`.
// ================================================================================

/** Chebyshev (king-move) tile distance — the metric the renderer's snap uses. */
function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// --- the simulated client+server loop -------------------------------------------
// One well-named helper so the teeth stay short. It mirrors the REAL shapes:
//   server: move_queue capped at 2, reject-not-clamp, one drain per STEP_MS tick;
//   client: seedSeq + reconcile per delivered batch, and a rAF frame body that
//           drains FIRST (the nh2 R1 ordering) and only then runs the gated
//           held-key continuation emit.
// `gateEnabled: false` models TODAY'S UNFIXED behaviour so each tooth can prove it
// is genuinely red-today rather than vacuously green.

interface ScriptedInput {
  readonly at: number;
  readonly kind: 'press' | 'release';
  readonly dir: WasmDirection;
}

interface RunLoopOptions {
  readonly durationMs: number;
  readonly script: readonly ScriptedInput[];
  readonly frameMs?: number;
  /** Deliberate frame-grid misalignment (U5). */
  readonly frameOffsetMs?: number;
  readonly oneWayLatencyMs?: number;
  readonly stepMs?: number;
  readonly cap?: number;
  readonly gateEnabled?: boolean;
  /**
   * R1 loop ordering. `true` (default) = the shipped ADR-0148 frame body: drain
   * FIRST, then gate, then emit. `false` = the pre-R1 body (gate + emit, then
   * drain), so U5b can prove the ordering is observable rather than cosmetic.
   */
  readonly drainFirst?: boolean;
  readonly start?: { readonly x: number; readonly y: number };
}

interface Emission {
  readonly at: number;
  readonly dir: WasmDirection;
}

interface FrameSample {
  readonly at: number;
  readonly x: number;
  readonly y: number;
  /** `outstandingSteps` sampled at the GATE-CHECK moment: after drain(), before emit. */
  readonly outstanding: number;
  readonly queueDepth: number;
  readonly emitted: boolean;
  readonly snapped: boolean;
  /** Moves this frame's OWN drain() applied — the R1-ordering observable (U5b). */
  readonly applied: number;
  /** How many reconciles landed since the previous frame (inter-frame gap density). */
  readonly reconcilesInGap: number;
}

/** A move the SERVER actually drained off its queue (the authoritative walk). */
interface ServerCommit {
  readonly at: number;
  readonly dir: WasmDirection;
}

interface InputSnapshot {
  readonly at: number;
  readonly kind: 'press' | 'release';
  readonly dir: WasmDirection;
  readonly predicted: { readonly x: number; readonly y: number };
  readonly serverTile: { readonly x: number; readonly y: number };
  readonly emissionCount: number;
  readonly commitCount: number;
}

interface RunLoopResult {
  readonly emissions: readonly Emission[];
  readonly frames: readonly FrameSample[];
  /** chebyshev(predicted[i], predicted[i-1]) — length = frames.length - 1. */
  readonly frameDeltas: readonly number[];
  readonly commits: readonly ServerCommit[];
  readonly inputs: readonly InputSnapshot[];
  readonly tickTimes: readonly number[];
  readonly startTile: { readonly x: number; readonly y: number };
  readonly serverTile: { readonly x: number; readonly y: number };
  readonly predictedFinal: { readonly x: number; readonly y: number };
  readonly serverTilesMoved: number;
  readonly predictedTilesMoved: number;
  readonly maxOutstanding: number;
  readonly maxFrameDelta: number;
  readonly reconciles: number;
}

/** Event priority at an identical timestamp (deterministic tie-break). */
const PRIO_INPUT = 0;
const PRIO_ARRIVAL = 1;
const PRIO_TICK = 2;
const PRIO_DELIVERY = 3;
const PRIO_FRAME = 4;

interface SimEvent {
  readonly t: number;
  readonly prio: number;
  readonly seq: number;
  readonly run: (now: number) => void;
}

// [mvi] SCOPE NOTE — this runLoop model is DELIBERATELY PRE-mvi and stays that way.
// It gates the nh2/ADR-0148 `outstandingSteps` invariants (bounded in-flight work,
// drain-first ordering, no press-teleport), so its frame body keeps reading the UNGATED
// `held.active()` — introducing the hold-commit threshold here would change what these
// teeth measure without adding a single new guarantee. The `press(dir, now)` argument
// below is the mechanical migration of the new required parameter and nothing more.
// The AUTHORITATIVE post-mvi model of the frame body + the reconcile divergence site
// (with `held.committedActive(now)` at both emitters) is
// `client/src/prediction/movementSim.test.ts`.
function runLoop(opts: RunLoopOptions): RunLoopResult {
  const stepMs = opts.stepMs ?? STEP_MS;
  const cap = opts.cap ?? 2;
  const frameMs = opts.frameMs ?? 1000 / 60;
  const frameOffsetMs = opts.frameOffsetMs ?? 0;
  const lat = opts.oneWayLatencyMs ?? 0;
  const gateEnabled = opts.gateEnabled ?? true;
  const drainFirst = opts.drainFirst ?? true;
  const startTile = opts.start ?? { x: 5, y: 5 };

  const predictor = new Predictor(applyMove, stepMs, cap);
  const held = new HeldDirections();

  // --- server model: tile + capped move_queue + last_input_seq -------------------
  const server = {
    x: startTile.x,
    y: startTile.y,
    queue: [] as WasmMoveInput[],
    ackedSeq: 0,
  };

  interface Batch {
    readonly x: number;
    readonly y: number;
    readonly queue: readonly WasmMoveInput[];
    readonly ackedSeq: number;
  }
  // What the client's local store currently believes (last delivered batch) — the
  // source a forced reconcile reads from, exactly like main.ts reconcileFromStore().
  let store: Batch = { x: startTile.x, y: startTile.y, queue: [], ackedSeq: 0 };

  const emissions: Emission[] = [];
  const frames: FrameSample[] = [];
  const commits: ServerCommit[] = [];
  const inputs: InputSnapshot[] = [];
  const tickTimes: number[] = [];
  let serverTilesMoved = 0;
  let reconciles = 0;
  let reconcilesSinceFrame = 0;

  // --- deterministic ordered event queue (time, prio, insertion) -----------------
  const pq: SimEvent[] = [];
  let insertSeq = 0;
  let curT = 0;
  let curPrio = PRIO_INPUT;

  function at(t: number, prio: number, run: (now: number) => void): void {
    // Never schedule strictly BEFORE the event currently being processed: clamp to
    // "immediately after me" so same-timestamp cascades stay causal + deterministic.
    let tt = t;
    let pp = prio;
    if (tt < curT || (tt === curT && pp < curPrio)) {
      tt = curT;
      pp = curPrio;
    }
    pq.push({ t: tt, prio: pp, seq: insertSeq++, run });
  }

  function popNext(): SimEvent | undefined {
    if (pq.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < pq.length; i++) {
      const a = pq[i] as SimEvent;
      const b = pq[best] as SimEvent;
      const better =
        a.t < b.t || (a.t === b.t && (a.prio < b.prio || (a.prio === b.prio && a.seq < b.seq)));
      if (better) best = i;
    }
    return pq.splice(best, 1)[0] as SimEvent;
  }

  // --- client side --------------------------------------------------------------
  function doReconcile(b: Batch, t: number): void {
    predictor.seedSeq(b.ackedSeq);
    // The real client rebases to now - 2*stepMs (see the banner): this is WHY
    // queueDepth collapses to 0 and cannot be the gate.
    predictor.reconcile(baseline(b.x, b.y, t - 2 * stepMs), b.queue, b.ackedSeq, t);
    reconciles += 1;
    reconcilesSinceFrame += 1;
  }

  function publish(now: number): void {
    const snap: Batch = {
      x: server.x,
      y: server.y,
      queue: [...server.queue],
      ackedSeq: server.ackedSeq,
    };
    at(now + lat, PRIO_DELIVERY, (t) => {
      store = snap;
      doReconcile(snap, t);
    });
  }

  function emit(dir: WasmDirection, now: number): void {
    emissions.push({ at: now, dir });
    const intent = predictor.enqueue({ Step: dir });
    if (intent === undefined) return; // predictor declined locally (cap/backpressure)
    const seq = intent.seq;
    // Primitives hoisted at send time — TRUE parity with main.ts's ADR-0085 A2 posture
    // (`const epoch = intent.epoch;` beside `const seq`): the callbacks below close over
    // primitives only, never the intent object (nh3 plan A9; reviewer nit fixed).
    const epoch = intent.epoch;
    const input: WasmMoveInput = { Step: dir };
    at(now + lat, PRIO_ARRIVAL, (tArr) => {
      if (server.queue.length >= cap) {
        // REJECT: no ack write, no push (the reducer Err rolls the whole txn back).
        // The client only learns one more one-way hop later — mirroring main.ts:466,
        // dropRejected() then a FORCED reconcile from the local store.
        at(tArr + lat, PRIO_DELIVERY, (tResp) => {
          if (predictor.dropRejected(seq, epoch)) doReconcile(store, tResp);
        });
        return;
      }
      server.queue.push(input);
      server.ackedSeq = seq;
      publish(tArr);
    });
  }

  // --- seed the predictor (the first own-row snapshot) ---------------------------
  doReconcile(store, 0);
  reconcilesSinceFrame = 0;

  // --- pre-schedule frames, server ticks and scripted input ----------------------
  for (let n = 0; ; n++) {
    const t = frameOffsetMs + n * frameMs;
    if (t > opts.durationMs) break;
    at(t, PRIO_FRAME, (now) => {
      let applied = 0;
      let snapped = false;
      // R1 (shipped): DRAIN FIRST — catch prediction up to what the server already
      // owes — and only then gate + emit. `drainFirst: false` is the pre-R1 body.
      if (drainFirst) ({ applied, snapped } = predictor.drain(now));
      const outstanding = predictor.outstandingSteps;
      const queueDepth = predictor.queueDepth;
      let emitted = false;
      if (!gateEnabled || outstanding === 0) {
        const d = reissueDir(held.active(), predictor.lastQueuedDir);
        if (d !== undefined) {
          emit(d, now);
          emitted = true;
        }
      }
      // Pre-R1: the drain runs AFTER the emit, so it consumes the intent this very
      // frame just enqueued instead of only catching up to authority.
      if (!drainFirst) ({ applied, snapped } = predictor.drain(now));
      const pos = predictor.predicted!.pos;
      frames.push({
        at: now,
        x: pos.x,
        y: pos.y,
        outstanding,
        queueDepth,
        emitted,
        snapped,
        applied,
        reconcilesInGap: reconcilesSinceFrame,
      });
      reconcilesSinceFrame = 0;
    });
  }

  for (let n = 1; ; n++) {
    const t = n * stepMs;
    if (t > opts.durationMs) break;
    tickTimes.push(t);
    at(t, PRIO_TICK, (now) => {
      const mv = server.queue.shift();
      if (mv === undefined) return; // idle tick: nothing changed, nothing published
      if (mv === 'Jump') {
        publish(now);
        return;
      }
      const dir = mv.Step;
      const target = step(dir, server.x, server.y);
      if (walkable(target)) {
        server.x = target.x;
        server.y = target.y;
        serverTilesMoved += 1;
      }
      commits.push({ at: now, dir });
      publish(now);
    });
  }

  for (const inp of opts.script) {
    at(inp.at, PRIO_INPUT, (now) => {
      if (inp.kind === 'press') {
        held.press(inp.dir, now);
        emit(inp.dir, now); // keydown emits ONCE, UNGATED (it never consults the gate)
      } else {
        held.release(inp.dir);
      }
      const pos = predictor.predicted!.pos;
      inputs.push({
        at: now,
        kind: inp.kind,
        dir: inp.dir,
        predicted: { x: pos.x, y: pos.y },
        serverTile: { x: server.x, y: server.y },
        emissionCount: emissions.length,
        commitCount: commits.length,
      });
    });
  }

  // --- run ----------------------------------------------------------------------
  for (;;) {
    const ev = popNext();
    if (ev === undefined) break;
    if (ev.t > opts.durationMs) break;
    curT = ev.t;
    curPrio = ev.prio;
    ev.run(ev.t);
  }

  const frameDeltas: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i] as FrameSample;
    const b = frames[i - 1] as FrameSample;
    frameDeltas.push(chebyshev(a, b));
  }
  let maxFrameDelta = 0;
  for (const d of frameDeltas) if (d > maxFrameDelta) maxFrameDelta = d;
  let maxOutstanding = 0;
  for (const f of frames) if (f.outstanding > maxOutstanding) maxOutstanding = f.outstanding;

  const finalPos = predictor.predicted!.pos;
  return {
    emissions,
    frames,
    frameDeltas,
    commits,
    inputs,
    tickTimes,
    startTile,
    serverTile: { x: server.x, y: server.y },
    predictedFinal: { x: finalPos.x, y: finalPos.y },
    serverTilesMoved,
    predictedTilesMoved: chebyshev(finalPos, startTile),
    maxOutstanding,
    maxFrameDelta,
    reconciles,
  };
}

// --------------------------------------------------------------------------------
// U1 + U9 — the accessor contract itself (pure unit, no loop). U1b additionally
// covers nh2-2: the pending/auth hand-off accounting is what keeps reconcile's
// repair convergent instead of double-counting a step into a desync.
// --------------------------------------------------------------------------------
describe('ADR-0148 U1/U9: outstandingSteps accessor contract (U1b also covers nh2-2 accounting)', () => {
  it('U9: a freshly-constructed Predictor (no reconcile yet) reports 0', () => {
    // KILLS: leaving #lastAuthQueueLen uninitialized (undefined/NaN — `NaN + 0` is
    // NaN, not 0, and `NaN === 0` is false so the gate would NEVER open → the
    // player freezes on first connect); also kills seeding it to the queue cap.
    const p = mkCapped(2);
    expect(p.outstandingSteps).toBe(0);
  });

  it('U1a BITES: outstandingSteps is a SUM (auth 2 + pending 2 = 4), never a max/min/queueDepth', () => {
    // rebasedAt === now, so reconcile's internal step-forward is not due and drains
    // nothing — isolating the accounting from the drain (the file's established trick).
    const p = mkCapped(2);
    p.reconcile(baseline(5, 5, 0), [], 0, 0); // seed
    expect(p.outstandingSteps).toBe(0);

    const a = p.enqueue(east());
    const b = p.enqueue(east());
    expect(a?.seq).toBe(1);
    expect(b?.seq).toBe(2);
    expect(p.pendingCount).toBe(2);

    // ackedSeq 0 keeps BOTH pending ops unacked while the server reports a 2-deep queue.
    p.reconcile(baseline(5, 5, 0), [east(), east()], 0, 0);
    expect(p.pendingCount).toBe(2);
    // queueDepth is clamped to the cap and is DELIBERATELY the wrong answer here (2).
    expect(p.queueDepth).toBe(2);

    // 2 (server's undrained move_queue) + 2 (sent-but-unacked) = 4.
    // KILLS, each of which lands on 2 or 3 instead of 4:
    //   Math.max(auth, pending) -> 2 | Math.min(...) -> 2 | Math.min(len,1)+... -> 3
    //   return #pending.length   -> 2 | return #lastAuthQueueLen -> 2
    //   return this.queueDepth   -> 2 | any ±1 off-by-one       -> 3 or 5
    expect(p.outstandingSteps).toBe(4);
  });

  it('U1b BITES (nh2-2): no double-counting — an acked op moves from pending to auth, total stays 1', () => {
    const p = mkCapped(2);
    p.reconcile(baseline(5, 5, 0), [], 0, 0); // seed
    const i = p.enqueue(east());
    expect(i).toBeDefined();

    // nh2-2 (NO DESYNC): the same physical step must be counted exactly once as it
    // migrates pending -> authoritative. Double-counting it would make the gate
    // over-estimate what the server owes and stall; under-counting would let a
    // second step in flight and put prediction ahead of a queue reconcile can
    // rebuild — either way the repair path stops converging.
    // In flight, not yet seen by the server: 0 auth + 1 pending.
    expect(p.outstandingSteps).toBe(1);

    // The echo: the server ACKED it and now carries it in its own queue. The very
    // same step must be counted ONCE, not twice.
    // KILLS: an impl that sums a *stale* pending (forgetting reconcile's
    // `seq > ackedSeq` prune) or that adds queueDepth on top -> 2.
    p.reconcile(baseline(5, 5, 0), [east()], i!.seq, 0);
    expect(p.pendingCount).toBe(0);
    expect(p.outstandingSteps).toBe(1);

    // The server drained it: nothing outstanding, the gate must open.
    // KILLS: an impl that never re-reads authQueue.length on later reconciles
    // (a write-once #lastAuthQueueLen) -> stuck at 1 -> the player freezes.
    p.reconcile(baseline(6, 5, 0), [], i!.seq, 0);
    expect(p.outstandingSteps).toBe(0);
  });
});

// --------------------------------------------------------------------------------
// U2 / U3 / U4 — the EARS criteria end-to-end through the simulated loop:
//   U2 -> nh2-1        U3 -> nh2-3 (+ nh2-1 emissions, + nh2-2 no-drift)
//   U4 -> nh2-3 COMPANION ("a genuinely-held key still moves the expected tiles")
// --------------------------------------------------------------------------------
describe('nh2-1 ADR-0148 U2: a TAP emits exactly one move', () => {
  const tapScript: readonly ScriptedInput[] = [
    { at: 0, kind: 'press', dir: 'East' },
    { at: 30, kind: 'release', dir: 'East' }, // after exactly 2 frames (0, 16.67)
  ];

  it('U2 BITES: press+release inside one step window emits ONCE, and the gate is NOT queueDepth', () => {
    const r = runLoop({ durationMs: 150, script: tapScript }); // 150 < first tick (200)

    // nh2-1: one key press, one move. No continuation backlog.
    expect(r.emissions.length).toBe(1);
    expect(r.emissions[0]?.dir).toBe('East');

    // THE LOAD-BEARING PIN: at every gate check before the release, the local queue
    // reads EMPTY (the -2*STEP_MS rebase already drained it) while the server still
    // owes exactly one step. Anything derived from queueDepth reads 0 here and lets
    // the continuation fire.
    // KILLS: `if (predictor.queueDepth === 0)` (the pre-nh2 trigger) and any gate
    // that is hard-wired true.
    const beforeRelease = r.frames.filter((f) => f.at < 30);
    expect(beforeRelease.length).toBe(2); // anti-vacuity: the filter is not empty
    for (const f of beforeRelease) {
      expect(f.queueDepth).toBe(0);
      expect(f.outstanding).toBe(1);
    }
    expect(r.serverTilesMoved).toBe(0); // no tick yet — the emission is still in flight
  });

  it('U2 RED-TODAY PROOF: the same tap WITHOUT the gate emits 2+ moves', () => {
    // Today's unfixed loop re-issues the held direction on every frame whose local
    // queue happens to be empty — which, thanks to the rebase-drain, is every frame.
    const r = runLoop({ durationMs: 150, script: tapScript, gateEnabled: false });
    expect(r.emissions.length).toBeGreaterThanOrEqual(2);
  });
});

describe('nh2-3 + nh2-1 ADR-0148 U3: releasing a held key stops the character within one tile', () => {
  const holdScript: readonly ScriptedInput[] = [
    { at: 0, kind: 'press', dir: 'East' },
    { at: 510, kind: 'release', dir: 'East' }, // after the ticks at 200 and 400
  ];

  it('U3 BITES: zero emissions after release, <=1 further server commit, predicted drift <=1', () => {
    const r = runLoop({ durationMs: 1000, script: holdScript });

    const release = r.inputs.find((i) => i.kind === 'release');
    expect(release).toBeDefined();
    const rel = release!;
    expect(rel.commitCount).toBeGreaterThanOrEqual(2); // anti-vacuity: it really walked

    // (a) nh2-1: nothing is emitted once the key is up — no step beyond what the
    // key-hold duration implies.
    // KILLS: a continuation emitter driven by a latched "committed direction"
    // instead of HeldDirections.active() — it keeps re-issuing East forever.
    expect(r.emissions.filter((e) => e.at > rel.at).length).toBe(0);

    // (b) nh2-3, THE LITERAL SCENARIO: press -> hold long enough to queue 2 steps
    // -> release -> no further step beyond what was already committed/in-flight.
    // The AUTHORITATIVE walk stops within one tile ("the character keeps walking
    // after I let go") and this is the tooth that is RED TODAY: an ungated loop
    // leaves a full cap-2 backlog on the server, which keeps draining for two more
    // ticks after the release.
    const commitsAfter = r.commits.filter((c) => c.at > rel.at);
    expect(commitsAfter.length).toBeLessThanOrEqual(1);

    // (c) nh2-2 (NO DESYNC): prediction does not drift away from where it was at
    // the release — it settles onto the authoritative tile via the ordinary
    // reconcile path rather than needing a separate cancel/repair mechanism.
    expect(chebyshev(r.predictedFinal, rel.predicted)).toBeLessThanOrEqual(1);
  });

  it('U3 RED-TODAY PROOF: without the gate the server drains 2+ more tiles after release', () => {
    const r = runLoop({ durationMs: 1000, script: holdScript, gateEnabled: false });
    const rel = r.inputs.find((i) => i.kind === 'release')!;
    expect(r.commits.filter((c) => c.at > rel.at).length).toBeGreaterThanOrEqual(2);
  });
});

describe('nh2-3 COMPANION ADR-0148 U4: a sustained hold keeps walking at full rate', () => {
  it('U4 BITES: hold across K=4 ticks -> >=K emissions, K server tiles, outstanding <=1 every frame', () => {
    // THE nh2-3 COMPANION, verbatim: "a genuinely-held key for the queue-cap
    // duration still moves the expected number of tiles (no regression on
    // sustained movement)". Mandatory anti-vacuity partner to U2/U3: those two
    // prove the gate CLOSES; this one proves it OPENS again — otherwise "emit at
    // most once" is trivially satisfiable by never emitting at all.
    const K = 4;
    const r = runLoop({
      durationMs: K * STEP_MS + 100, // 900ms: ticks at 200/400/600/800
      script: [{ at: 0, kind: 'press', dir: 'East' }],
    });

    expect(r.tickTimes.length).toBe(K);

    // KILLS: a gate that is always false (`outstandingSteps` never returning 0 —
    // e.g. a write-once #lastAuthQueueLen, or NaN arithmetic). The walk would freeze
    // after the single ungated keydown emission: 1 emission, 1 tile.
    expect(r.emissions.length).toBeGreaterThanOrEqual(K);
    // ...and it must NOT overshoot: at most one continuation per owed step, plus the
    // ungated keydown. (Deliberately a RANGE, not `=== K + 1`: whether the final
    // tick's echo lands before the last frame is phase-dependent and would flake.)
    expect(r.emissions.length).toBeLessThanOrEqual(K + 1);

    // nh2-3 COMPANION: the server actually walked one tile per step, no stall.
    expect(r.serverTilesMoved).toBe(K);
    // nh2-2 (NO DESYNC): prediction leads authority by at most the single
    // in-flight step, for the whole sustained hold. `predictedTilesMoved` bounded
    // to [K, K+1] WHILE `serverTilesMoved === K` is the no-runaway statement — a
    // predictor that drifts free of authority breaks the upper bound here.
    expect(r.predictedTilesMoved).toBeGreaterThanOrEqual(K);
    expect(r.predictedTilesMoved).toBeLessThanOrEqual(K + 1);

    // nh2-1 as an INVARIANT rather than a count: never more than one owed step.
    // KILLS: any gate that permits a second in-flight move (`>= 0`, `<= 1`,
    // `!== 1`, or a truthiness test on a number).
    expect(r.frames.length).toBeGreaterThan(40); // anti-vacuity: frames really ran
    expect(r.maxOutstanding).toBeLessThanOrEqual(1);
  });
});

// --------------------------------------------------------------------------------
// U5 — nh2-2 (NO DESYNC): per-frame smoothness under a DELIBERATELY UNALIGNED
// frame clock. This is THE headline nh2-2 tooth: prediction tracks authority
// one tile at a time through the ordinary reconcile path, never running away
// from it and never needing a second repair mechanism to be hauled back.
// --------------------------------------------------------------------------------
describe('nh2-2 ADR-0148 U5: predicted advances at most one tile per frame (unaligned clock)', () => {
  it('U5 (nh2-2): frameOffsetMs=1.5 misaligns the grid so reconciles land BETWEEN frames; delta stays <=1', () => {
    // WITHOUT THE DELIBERATE MISALIGNMENT THIS TOOTH IS VACUOUS: on an aligned grid
    // (offset 0, 60Hz) every server tick coincides with a frame, so the tick echo's
    // reconcile-drain and the frame's own drain are the same instant and can never
    // be observed as two separate advances between two samples. With offset 1.5 no
    // frame ever coincides with a tick, so both the echo reconcile and the tick
    // reconcile land strictly inside inter-frame gaps — the only arrangement in
    // which a second drain can sneak in between two rendered samples.
    //
    // KILLS: dropping reconcile's `slice(0, queueCap)` clamp (a surprise deep
    // authoritative queue then replays as a multi-tile jump between two samples);
    // a `while` (rather than `if`) continuation emitter; and any gate that lets a
    // second step be in flight, which is what puts two drainable moves in the
    // local queue at once. Each of those produces a delta of 2, which re-arms the
    // renderer's `chebyshev > 1` snap and shows up as a visible teleport.
    //
    // WHAT THIS TOOTH DOES *NOT* KILL: reverting the R1 drain-before-emit ordering.
    // Under a correct gate `outstandingSteps === 0` implies the local queue is
    // empty, so both orderings make the identical emit decision and both keep the
    // delta at 1 — R1's residual is not observable as a per-frame delta here. U5b
    // below pins R1 on the observable that DOES separate the two orderings.
    const r = runLoop({
      durationMs: 1200,
      script: [{ at: 0, kind: 'press', dir: 'East' }],
      frameMs: 1000 / 60,
      frameOffsetMs: 1.5,
      oneWayLatencyMs: 25,
    });

    // Proof the grid really is misaligned: no frame shares a timestamp with a tick.
    for (const f of r.frames) {
      for (const tt of r.tickTimes) expect(f.at).not.toBe(tt);
    }
    // Proof reconciles really landed inside gaps (not all at frame boundaries).
    expect(r.frames.filter((f) => f.reconcilesInGap > 0).length).toBeGreaterThanOrEqual(4);

    // Anti-vacuity: the character MOVED across frames — `<= 1` is not being
    // satisfied by a frozen predictor.
    expect(r.frameDeltas.filter((d) => d > 0).length).toBeGreaterThanOrEqual(4);

    expect(r.maxFrameDelta).toBeLessThanOrEqual(1);
    expect(r.maxOutstanding).toBeLessThanOrEqual(1);
  });
});

// --------------------------------------------------------------------------------
// U5b — ADR-0148 R1 (a DESIGN DECISION, not an EARS criterion): the frame drain
// runs BEFORE the gated continuation emit. R1 closes the gate's residual; the
// EARS criteria themselves are carried by U2/U3/U4/U5/U6/U8.
// --------------------------------------------------------------------------------
describe('ADR-0148 R1 (not an EARS criterion) U5b: drain() precedes the continuation emit', () => {
  const R1_OPTS = {
    durationMs: 1200,
    script: [{ at: 0, kind: 'press', dir: 'East' }] as readonly ScriptedInput[],
    frameMs: 1000 / 60,
    frameOffsetMs: 1.5,
    oneWayLatencyMs: 25,
  };

  it('U5b BITES: an emitting frame never applies a move in its own drain (applied === 0)', () => {
    // R1 IN ONE SENTENCE: `drain()` is a pure CATCH-UP to what the server already
    // owes; it must never consume the intent the same frame is about to issue.
    // Under R1, a frame only emits when `outstandingSteps === 0`, which implies the
    // local queue is empty, which implies its own drain applied nothing — so
    // `applied === 0` on every emitting frame is exactly the ordering, observed
    // behaviourally rather than by reading main.ts source text.
    //
    // KILLS: reverting the loop to emit-then-drain (the control below flips every
    // one of these to 1 — deterministically, not statistically).
    //
    // PROPORTION, measured independently — do not oversell this tooth: the GATE
    // takes press-phase render teleports from 88.0% to ~2.0% @60Hz (6.0% @30Hz);
    // R1 takes that residual to 0.0%. R1 ALONE, WITHOUT THE GATE, REMOVES
    // ESSENTIALLY NONE OF THEM. R1 closes the gate's residual; it is not the
    // primary fix, and this tooth is scoped accordingly.
    const r = runLoop(R1_OPTS);

    const emitting = r.frames.filter((f) => f.emitted);
    expect(emitting.length).toBeGreaterThanOrEqual(4); // anti-vacuity: it really emitted
    for (const f of emitting) {
      expect(f.applied).toBe(0);
      expect(f.queueDepth).toBe(0); // the gate implies an empty local queue
    }
  });

  it('U5b RED-TODAY PROOF: the pre-R1 body drains its OWN just-issued intent (applied === 1)', () => {
    // Same clock, same gate, only the ordering flipped. Every emitting frame now
    // consumes the move it enqueued microseconds earlier: prediction and input are
    // coupled inside one frame, which is the residual press-phase teleport R1
    // removes. If this control ever reports 0 the tooth above has gone vacuous.
    const r = runLoop({ ...R1_OPTS, drainFirst: false });

    const emitting = r.frames.filter((f) => f.emitted);
    expect(emitting.length).toBeGreaterThanOrEqual(4);
    for (const f of emitting) expect(f.applied).toBe(1);

    // The gate itself is ordering-independent (that is WHY R1 is only a residual
    // fix): the emission cadence and the smoothness bound are unchanged.
    expect(r.maxFrameDelta).toBeLessThanOrEqual(1);
    expect(r.maxOutstanding).toBeLessThanOrEqual(1);
  });
});

// --------------------------------------------------------------------------------
// U6 — nh2-1: emission-rate bound at 30 / 60 / 144 Hz. "Steps beyond what the
// key-hold duration implies" is exactly what a frame-rate-scaled emitter produces,
// so pinning the rate to the STEP cadence is the general form of the criterion.
// --------------------------------------------------------------------------------
describe('nh2-1 ADR-0148 U6: emissions are bounded by the STEP cadence, not the frame rate', () => {
  const HOLD_MS = 2000;
  const bound = Math.ceil(HOLD_MS / STEP_MS) + 1; // ceil(2000/200) + 1 = 11

  for (const hz of [30, 60, 144]) {
    it(`U6 BITES @${hz}Hz: a ${HOLD_MS}ms hold emits at most ${bound} moves`, () => {
      // THE headline nh2-1 tooth: the emission rate must be pinned to the SERVER's
      // step cadence (one owed step at a time) and must NOT scale with the display
      // refresh rate. `<=` is kept because the bound is exactly tight (ungated
      // keydown + one continuation per owed step); `<` would flake.
      // KILLS: any per-frame re-issue (today's behaviour), and any gate whose value
      // depends on frame timing rather than on what the server owes.
      const r = runLoop({
        durationMs: HOLD_MS,
        script: [{ at: 0, kind: 'press', dir: 'East' }],
        frameMs: 1000 / hz,
      });
      expect(r.frames.length).toBeGreaterThan(hz); // anti-vacuity: >1s of frames ran
      expect(r.emissions.length).toBeLessThanOrEqual(bound);
      // ...and the walk still happened at full rate — the nh2-3 companion reused
      // here as anti-vacuity, so the nh2-1 bound cannot be met by stalling.
      expect(r.serverTilesMoved).toBeGreaterThanOrEqual(r.tickTimes.length - 1);
    });
  }

  it('U6 RED-TODAY PROOF: without the gate the same hold blows the bound by a wide margin', () => {
    const r = runLoop({
      durationMs: HOLD_MS,
      script: [{ at: 0, kind: 'press', dir: 'East' }],
      frameMs: 1000 / 60,
      gateEnabled: false,
    });
    expect(r.emissions.length).toBeGreaterThanOrEqual(bound * 3);
  });
});

// --------------------------------------------------------------------------------
// U7 — the ADR-0148 ACCEPTED-TRADE GUARD, *not* an EARS criterion. It pins the
// documented COST of the gate (a round trip of reopen latency per step) so the
// numbers in the ADR have a machine-checked source of truth. Sustained-movement
// as an EARS obligation is the nh2-3 companion and lives in U4.
// --------------------------------------------------------------------------------
describe('ADR-0148 ACCEPTED-TRADE GUARD U7: full walk rate across the accepted latency budget', () => {
  const HOLD_MS = 2000;
  const NOMINAL = HOLD_MS / STEP_MS; // 10 tiles at one tile per STEP_MS

  for (const oneWayLatencyMs of [0, 25, 50, 90]) {
    it(`U7 BITES @${oneWayLatencyMs}ms one-way: hold still walks ~${NOMINAL} tiles`, () => {
      // ADR-0148 ACCEPTED TRADE, PINNED HERE. Gating on `outstandingSteps` costs a
      // full round trip of gate-reopen latency per step, so the budget is
      //
      //     2 * oneWayLatencyMs + framePeriodMs < STEP_MS
      //
      // FRAME PERIOD IS A TERM — the cliff is (200 - framePeriod)/2, i.e. ~91ms at
      // 60Hz but only ~83ms at 30Hz and ~76ms at 24Hz. THIS `it` IS 60Hz-ONLY, so
      // its 90ms case is inside the budget by ~3ms and says NOTHING about other
      // frame rates; the U7-XP block below sweeps the cross-product, and the U7-DEG
      // pin covers 30Hz/90ms, which is OUTSIDE the budget and genuinely degrades.
      // DO NOT EXTEND THIS TOOTH TO 100ms+ at 60Hz — documented degradation.
      // KILLS: a gate that re-opens only on the NEXT reconcile after the tick echo
      // (one extra round trip), or one that waits for pendingCount AND queueDepth —
      // either halves the rate at any non-zero latency.
      const r = runLoop({
        durationMs: HOLD_MS,
        script: [{ at: 0, kind: 'press', dir: 'East' }],
        frameMs: 1000 / 60, // the budget above is derived for a 60Hz frame grid
        oneWayLatencyMs,
      });
      expect(r.tickTimes.length).toBe(NOMINAL);
      // +-1 tile of edge tolerance (first/last step straddle the window boundary).
      expect(r.serverTilesMoved).toBeGreaterThanOrEqual(NOMINAL - 1);
      expect(r.serverTilesMoved).toBeLessThanOrEqual(NOMINAL + 1);
      // ...and it stayed gated the whole time (full rate must not come from a backlog).
      expect(r.maxOutstanding).toBeLessThanOrEqual(1);
    });
  }
});

// --------------------------------------------------------------------------------
// U7-XP / U7-DEG — the frame-rate x latency CROSS-PRODUCT (the term U6 and U7
// each missed). Like U7 these are ADR-0148 ACCEPTED-TRADE GUARDS, not EARS
// criteria: they bound the documented cost, they do not state an obligation.
// --------------------------------------------------------------------------------
describe('ADR-0148 ACCEPTED-TRADE GUARD U7-XP: full rate across frame rate x latency inside the budget', () => {
  const HOLD_MS = 2000;
  const NOMINAL = HOLD_MS / STEP_MS; // 10 tiles
  // THE BUDGET, stated once and asserted below:
  //     2 * oneWayLatencyMs + framePeriodMs < STEP_MS      (STEP_MS = 200)
  // Worst-case phase: the tick echo lands just AFTER a frame, so the client waits a
  // full frame period before it can emit, then the intent needs one more one-way
  // hop to reach the server before the next tick. Frame period is a first-class
  // term — U6 swept frame rate at latency 0 and U7 swept latency at 60Hz, so
  // neither could see it. Cliff = (STEP_MS - framePeriod) / 2:
  //     144Hz -> ~96.5ms | 60Hz -> ~91.7ms | 30Hz -> ~83.3ms | 24Hz -> ~76.4ms
  //
  // frameOffsetMs is DELIBERATELY 15 (non-grid-aligned at all three rates: 15 %
  // 33.33 = 15, 15 % 16.67 = 15, 15 % 6.94 = 1.11). offset 0 is a PHASE-LUCKY
  // alignment at 30Hz that hides the frame-period term — never use it here.
  const UNALIGNED_OFFSET_MS = 15;

  for (const hz of [30, 60, 144]) {
    for (const oneWayLatencyMs of [0, 25, 50]) {
      const framePeriod = 1000 / hz;
      it(`U7-XP BITES @${hz}Hz x ${oneWayLatencyMs}ms (budget ${(2 * oneWayLatencyMs + framePeriod).toFixed(1)} < 200): full rate`, () => {
        // Every cell here satisfies the budget, so every cell MUST walk at the full
        // nominal rate. KILLS: any gate whose reopen costs more than one round trip
        // (it would fail the high-latency/low-refresh corners first), and any
        // implementation that reintroduces a frame-rate dependence into the cadence.
        expect(2 * oneWayLatencyMs + framePeriod).toBeLessThan(STEP_MS);
        const r = runLoop({
          durationMs: HOLD_MS,
          script: [{ at: 0, kind: 'press', dir: 'East' }],
          frameMs: framePeriod,
          frameOffsetMs: UNALIGNED_OFFSET_MS,
          oneWayLatencyMs,
        });
        expect(r.tickTimes.length).toBe(NOMINAL);
        expect(r.serverTilesMoved).toBeGreaterThanOrEqual(NOMINAL - 1);
        expect(r.serverTilesMoved).toBeLessThanOrEqual(NOMINAL + 1);
        expect(r.maxOutstanding).toBeLessThanOrEqual(1);
      });
    }
  }

  it('U7-DEG: 30Hz x 90ms is OUTSIDE the budget and degrades to ~half rate (accepted trade, NOT desired)', () => {
    // THIS TOOTH PINS AN ACCEPTED TRADE, NOT A DESIRED BEHAVIOUR. 2*90 + 33.33 =
    // 213.3 > 200, so the continuation reaches the server just after the tick that
    // wanted it and waits a whole extra step: ~1 tile per 400ms instead of per
    // 200ms. It is asserted so that (a) the ADR's numbers have a machine-checked
    // source of truth, and (b) a FUTURE IMPROVEMENT that restores full rate here
    // turns this RED and forces a deliberate decision rather than silently drifting.
    expect(2 * 90 + 1000 / 30).toBeGreaterThan(STEP_MS);
    const r = runLoop({
      durationMs: HOLD_MS,
      script: [{ at: 0, kind: 'press', dir: 'East' }],
      frameMs: 1000 / 30,
      frameOffsetMs: UNALIGNED_OFFSET_MS,
      oneWayLatencyMs: 90,
    });
    expect(r.tickTimes.length).toBe(NOMINAL);
    // Genuinely degraded (this is the assertion a future fix must break).
    expect(r.serverTilesMoved).toBeLessThan(NOMINAL - 1);
    // ...and degraded to ~half, not to a stall: the walk still makes progress and
    // the gate still holds at most one owed step.
    expect(r.serverTilesMoved).toBeGreaterThanOrEqual(4);
    expect(r.serverTilesMoved).toBeLessThanOrEqual(6);
    expect(r.maxOutstanding).toBeLessThanOrEqual(1);
  });
});

// --------------------------------------------------------------------------------
// U8 — nh2-1, the "(or the player switches to a different held direction)" limb
// of the criterion, which U2/U3 do not exercise.
// --------------------------------------------------------------------------------
describe('nh2-1 ADR-0148 U8: switching direction mid-hold commits at most one more old step', () => {
  const SWITCH_AT = 510;
  const switchScript: readonly ScriptedInput[] = [
    { at: 0, kind: 'press', dir: 'East' }, // hold East across the ticks at 200 and 400
    { at: SWITCH_AT, kind: 'press', dir: 'North' }, // North pressed while East still held
    { at: 520, kind: 'release', dir: 'East' },
  ];

  it('U8 BITES: <=1 further East commit after the North press, and every later emission is North', () => {
    const r = runLoop({ durationMs: 1200, script: switchScript });

    // Anti-vacuity: East really was walking before the switch.
    expect(r.commits.filter((c) => c.at < SWITCH_AT && c.dir === 'East').length).toBe(2);

    // THE INPUT-LAG TOOTH. With a backlog on the server, the stale East moves must
    // drain before North is even looked at — the "I turned but he kept going" feel
    // complaint. The gate keeps at most one owed step, so at most one stale commit.
    // KILLS: an always-open gate (server queue saturates at cap 2 -> two more East
    // commits AND the North keydown is outright REJECTED and lost).
    expect(
      r.commits.filter((c) => c.at > SWITCH_AT && c.dir === 'East').length,
    ).toBeLessThanOrEqual(1);

    // The switch actually took effect on the server.
    expect(r.commits.filter((c) => c.dir === 'North').length).toBeGreaterThanOrEqual(1);

    // Every emission from the North keydown onward is North — no stale re-issue of
    // the released direction. KILLS: a continuation emitter reading a latched dir
    // rather than HeldDirections.active().
    const after = r.emissions.filter((e) => e.at >= SWITCH_AT);
    expect(after.length).toBeGreaterThanOrEqual(1);
    for (const e of after) expect(e.dir).toBe('North');
    expect(after[0]?.at).toBe(SWITCH_AT); // the ungated keydown emission
  });

  it('U8 RED-TODAY PROOF: without the gate 2+ stale East steps commit after the switch', () => {
    const r = runLoop({ durationMs: 1200, script: switchScript, gateEnabled: false });
    expect(
      r.commits.filter((c) => c.at > SWITCH_AT && c.dir === 'East').length,
    ).toBeGreaterThanOrEqual(2);
  });
});
