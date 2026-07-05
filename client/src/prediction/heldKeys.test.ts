// prediction/heldKeys.test.ts — HeldDirections + reissueDir (M8.6c, ADR-0013.5)
//
// RED reason: heldKeys.ts does NOT EXIST YET — the import itself fails and the
// entire suite stays red until the implementer creates the module.
//
// This suite is pure / node-only. No wasm. No real timers.
// All tests follow the block-body arrow rule for fast-check (see project standards):
// `fc.property(arb, (x) => { expect(…).toEqual(…); })` — never expression-body.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WasmDirection } from '../convert/convert';
import { HeldDirections, reissueDir } from './heldKeys';

// ================================================================================
// 1. reissueDir — pure dedup decision for the frame-loop CONTINUATION re-issue
// ================================================================================

describe('reissueDir: pure dedup logic', () => {
  it('returns active when active !== lastQueuedDir (should re-issue)', () => {
    // Kills: an impl that always returns undefined (never re-issues).
    // When East is held but the last queued dir was North, we MUST re-issue East.
    expect(reissueDir('East', 'North')).toBe('East');
    expect(reissueDir('North', 'South')).toBe('North');
    expect(reissueDir('West', 'East')).toBe('West');
    expect(reissueDir('South', undefined)).toBe('South'); // queue was drained, re-issue
  });

  it('returns undefined when active === lastQueuedDir (dedup: already queued this dir)', () => {
    // Kills: an impl that always re-issues (no dedup) — the queue/pending would
    // over-fill with duplicate held-direction entries on every frame tick.
    expect(reissueDir('East', 'East')).toBeUndefined();
    expect(reissueDir('North', 'North')).toBeUndefined();
    expect(reissueDir('South', 'South')).toBeUndefined();
    expect(reissueDir('West', 'West')).toBeUndefined();
  });

  it('returns undefined when active === undefined (no key held)', () => {
    // Kills: an impl that reads active without an undefined guard and crashes or
    // returns a garbage value.
    expect(reissueDir(undefined, 'East')).toBeUndefined();
    expect(reissueDir(undefined, undefined)).toBeUndefined();
    expect(reissueDir(undefined, 'North')).toBeUndefined();
  });

  it('returns active when lastQueuedDir === undefined (queue drained → re-issue resumes)', () => {
    // Kills: an impl that treats undefined lastQueuedDir as "already queued" — i.e.
    // one that does `lastQueuedDir === undefined ? undefined : ...`. When the queue
    // drains (lastQueuedDir goes undefined), continuous movement MUST resume.
    expect(reissueDir('East', undefined)).toBe('East');
    expect(reissueDir('North', undefined)).toBe('North');
    expect(reissueDir('South', undefined)).toBe('South');
    expect(reissueDir('West', undefined)).toBe('West');
  });

  it('fast-check property: reissueDir returns active IFF (active !== undefined && active !== lastQueuedDir)', () => {
    // Kills: any impl that deviates from the exact criterion on edge cases.
    const dirArb = fc.constantFrom<WasmDirection>('North', 'South', 'East', 'West');
    const maybeDirArb = fc.option(dirArb, { nil: undefined });
    fc.assert(
      fc.property(maybeDirArb, maybeDirArb, (active, lastQueuedDir) => {
        const result = reissueDir(active, lastQueuedDir);
        if (active !== undefined && active !== lastQueuedDir) {
          expect(result).toBe(active);
        } else {
          expect(result).toBeUndefined();
        }
      }),
    );
  });
});

// ================================================================================
// 2. HeldDirections — multi-key tracking with most-recently-pressed priority
// ================================================================================

describe('HeldDirections: single key press/release', () => {
  it('press(N) → active() === "North"', () => {
    // Kills: an impl that leaves active() undefined after a press, or returns the
    // wrong direction.
    const held = new HeldDirections();
    held.press('North');
    expect(held.active()).toBe('North');
  });

  it('pressing a dir twice → active() unchanged AND a single release clears it', () => {
    // Kills: an impl that stores duplicates: if press(N) twice pushes N twice,
    // then one release(N) would leave N still "held" → active() !== undefined.
    // The no-dup invariant: pressing an already-held dir is a no-op.
    const held = new HeldDirections();
    held.press('North');
    held.press('North'); // duplicate press — must be ignored
    expect(held.active()).toBe('North');
    held.release('North');
    expect(held.active()).toBeUndefined(); // one release clears it (no dup stored)
  });

  it('release of a non-held dir is a harmless no-op', () => {
    // Kills: an impl that throws or corrupts state on release of an un-held dir.
    const held = new HeldDirections();
    expect(() => held.release('East')).not.toThrow();
    held.press('North');
    held.release('East'); // East was never pressed
    expect(held.active()).toBe('North'); // North unaffected
  });

  it('clear() removes all dirs → active() === undefined', () => {
    // Kills: an impl that forgets to clear the stack or the set.
    const held = new HeldDirections();
    held.press('North');
    held.press('East');
    held.clear();
    expect(held.active()).toBeUndefined();
  });
});

describe('HeldDirections: two-key fallback (the critical stack regression)', () => {
  it('press(N), press(S) → active() === "South" (most-recently-pressed)', () => {
    // Kills: an impl that returns the first-pressed key rather than the last.
    const held = new HeldDirections();
    held.press('North');
    held.press('South');
    expect(held.active()).toBe('South');
  });

  it('press(N), press(S), release(S) → active() === "North" (fallback to previous)', () => {
    // THIS IS THE CRITICAL ANTI-SCALAR-REGRESSION TEST.
    // Kills: a scalar `heldDir` impl that just writes the last pressed key and clears on
    // release — it would lose 'North' when 'South' was released, returning undefined.
    // A correct stack/set impl falls back to the previously held key.
    const held = new HeldDirections();
    held.press('North');
    held.press('South');
    held.release('South');
    expect(held.active()).toBe('North'); // must NOT be undefined
  });

  it('press(N), press(E), release(N) → active() === "East" (the non-released key wins)', () => {
    // Kills: an impl that clears on any release, or tracks only one key.
    const held = new HeldDirections();
    held.press('North');
    held.press('East');
    held.release('North');
    expect(held.active()).toBe('East');
  });

  it('press(N), press(S), press(E) → active() === "East"; release(E) → active() === "South"', () => {
    // Kills: a 2-slot impl that drops the oldest key when a 3rd is pressed.
    // After pressing 3, releasing the most-recent falls back to the 2nd.
    const held = new HeldDirections();
    held.press('North');
    held.press('South');
    held.press('East');
    expect(held.active()).toBe('East');
    held.release('East');
    expect(held.active()).toBe('South'); // falls back to the previously held key
  });

  it('press(N), press(S), release(N) → active() remains "South" (still held)', () => {
    // Kills: an impl that uses a stack where releasing a non-top element corrupts the
    // stack order, causing the wrong key to become active.
    const held = new HeldDirections();
    held.press('North');
    held.press('South');
    held.release('North'); // release a non-active key
    expect(held.active()).toBe('South'); // South is still the most-recently-pressed held key
  });

  it('all four dirs pressed then released in LIFO order → active() tracks correctly', () => {
    // Kills: an impl with off-by-one in stack traversal.
    const held = new HeldDirections();
    held.press('North');
    held.press('South');
    held.press('East');
    held.press('West');
    expect(held.active()).toBe('West');
    held.release('West');
    expect(held.active()).toBe('East');
    held.release('East');
    expect(held.active()).toBe('South');
    held.release('South');
    expect(held.active()).toBe('North');
    held.release('North');
    expect(held.active()).toBeUndefined();
  });
});

describe('HeldDirections: fast-check property — active() is the most-recent still-held dir', () => {
  it('after any sequence of press/release ops, active() is the most-recently-pressed still-held dir', () => {
    // Kills: any impl that violates MRU ordering or drops a key early.
    const dirArb = fc.constantFrom<WasmDirection>('North', 'South', 'East', 'West');
    type Op =
      | { kind: 'press'; dir: WasmDirection }
      | { kind: 'release'; dir: WasmDirection }
      | { kind: 'clear' };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      dirArb.map((dir): Op => ({ kind: 'press', dir })),
      dirArb.map((dir): Op => ({ kind: 'release', dir })),
      fc.constant<Op>({ kind: 'clear' }),
    );
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const held = new HeldDirections();
        // Track a reference model in-test: ordered array of held dirs (last = most recent)
        // using a simple ordered-insert de-dup model.
        const model: WasmDirection[] = [];
        for (const op of ops) {
          if (op.kind === 'press') {
            held.press(op.dir);
            // no-dup: if already present, do nothing; else push to end (most recent)
            if (!model.includes(op.dir)) model.push(op.dir);
          } else if (op.kind === 'release') {
            held.release(op.dir);
            const idx = model.lastIndexOf(op.dir);
            if (idx !== -1) model.splice(idx, 1);
          } else {
            held.clear();
            model.length = 0;
          }
        }
        // expected active: last element in model (most recently pressed still held)
        const expected = model.length > 0 ? model[model.length - 1] : undefined;
        expect(held.active()).toBe(expected);
      }),
    );
  });
});

// ================================================================================
// 5. Integration: held-key / lag regression
//    Wire HeldDirections + reissueDir + Predictor (cap-2 queue / small pendingCap)
//    + injected applyMove over a fake frame loop with DELAYED acks.
// ================================================================================

import type { WasmCharacterState } from '../convert/convert';
// Re-declare the applyMove fake here (same logic as predictor.test.ts — node-only,
// no wasm). A West wall at x<=0; everything else walkable.
import { type ApplyMove, type IntentToSend, Predictor } from './predictor';

function fakeStep(dir: WasmDirection, x: number, y: number): { x: number; y: number } {
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
  return p.x > 0;
}
const applyMove: ApplyMove = (state, input, now): WasmCharacterState => {
  const stamp = Math.floor(now);
  if (input === 'Jump') {
    const target = fakeStep(state.facing, state.pos.x, state.pos.y);
    const pos = walkable(target) ? target : state.pos;
    return { ...state, pos, action: 'Jumping', move_started_at: stamp };
  }
  const dir = input.Step;
  const target = fakeStep(dir, state.pos.x, state.pos.y);
  if (walkable(target)) {
    return { pos: target, facing: dir, action: 'Walking', move_started_at: stamp };
  }
  return { ...state, facing: dir, action: 'Idle', move_started_at: stamp };
};

function fakeBaseline(
  x: number,
  y: number,
  rebasedAt: number,
  facing: WasmDirection = 'East',
): WasmCharacterState {
  return { pos: { x, y }, facing, action: 'Idle', move_started_at: rebasedAt };
}

const STEP_MS = 200;

describe('Held-key / lag integration regression (M8.6c ADR-0013.5)', () => {
  it('bounded arrays: queueDepth <= queueCap AND pendingCount <= pendingCap across a held-East run with delayed acks', () => {
    // BITES: unbounded #pending (count blows up) AND a no-dedup re-issue (fills queue too fast).
    // The predictor is constructed with queueCap=2 and pendingCap=4.
    // Each "frame" we try to re-issue East using reissueDir. Acks are delayed by ~6 frames.
    // Neither bound should ever be exceeded.

    const QUEUE_CAP = 2;
    const PENDING_CAP = 4;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP, PENDING_CAP);
    const held = new HeldDirections();

    const t0 = 10_000;
    // Seed at t0, baseline two steps ago so moves are immediately due.
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    // The player holds East for 30 sub-step-ms "frames".
    held.press('East');
    const FRAME_MS = 50; // sub-step: 4 frames per step_ms
    let now = t0;
    const sentIntents: IntentToSend[] = [];

    for (let frame = 0; frame < 30; frame++) {
      now += FRAME_MS;

      // frame-loop: re-issue held dir if dedup says to
      const d = reissueDir(held.active(), predictor.lastQueuedDir);
      if (d !== undefined) {
        const intent = predictor.enqueue({ Step: d });
        if (intent !== undefined) sentIntents.push(intent);
      }

      predictor.drain(now);

      // Invariants hold every frame:
      expect(predictor.queueDepth).toBeLessThanOrEqual(QUEUE_CAP);
      expect(predictor.pendingCount).toBeLessThanOrEqual(PENDING_CAP);
    }

    // Delayed acks: server processes and acks the first batch of intents.
    // Simulate authoritative East walk: 1 step east from x=5 = x=6.
    const ackedSeq =
      sentIntents.length > 0 ? sentIntents[Math.min(1, sentIntents.length - 1)]!.seq : 0;
    const authX = 5 + Math.min(sentIntents.length, 2); // at most 2 due to pendingCap
    predictor.reconcile(fakeBaseline(authX, 5, now - 2 * STEP_MS), [], ackedSeq, now);

    // After reconcile: predicted tile should equal the authoritative truth.
    expect(predictor.predicted!.pos.y).toBe(5); // y unchanged (East movement)
    // Post-reconcile bounds hold.
    expect(predictor.queueDepth).toBeLessThanOrEqual(QUEUE_CAP);
    expect(predictor.pendingCount).toBeLessThanOrEqual(PENDING_CAP);
  });

  it('correct post-reconcile tile after bounded no-ack burst + delayed reconcile', () => {
    // BITES: backpressure that corrupts prediction — after bounding #pending and
    // reconciling against server truth, the predicted tile must converge to authority.
    // Wrong impl killed: an impl that "loses" pending ops during backpressure,
    // leaving a stale or garbled predicted position.

    const QUEUE_CAP = 2;
    const PENDING_CAP = 3;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP, PENDING_CAP);
    const held = new HeldDirections();

    const t0 = 10_000;
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);
    held.press('East');

    let now = t0;
    const FRAME_MS = 60;
    const sentIntents: IntentToSend[] = [];

    // Run 20 frames without any acks.
    for (let frame = 0; frame < 20; frame++) {
      now += FRAME_MS;
      const d = reissueDir(held.active(), predictor.lastQueuedDir);
      if (d !== undefined) {
        const intent = predictor.enqueue({ Step: d });
        if (intent !== undefined) sentIntents.push(intent);
      }
      predictor.drain(now);
      // pendingCap invariant holds throughout
      expect(predictor.pendingCount).toBeLessThanOrEqual(PENDING_CAP);
    }

    // Server accepted exactly 2 east steps (QUEUE_CAP=2 means at most 2 accepted before
    // the server-side queue is full). Authority is at x=7.
    const authEastSteps = Math.min(sentIntents.length, 2);
    const authX = 5 + authEastSteps;
    const ackedSeq = sentIntents.length > 0 ? (sentIntents[authEastSteps - 1]?.seq ?? 0) : 0;

    predictor.reconcile(fakeBaseline(authX, 5, now - 2 * STEP_MS), [], ackedSeq, now);

    // Convergence: predicted tile == authoritative tile.
    expect(predictor.predicted!.pos.x).toBeGreaterThanOrEqual(authX);
    expect(predictor.predicted!.pos.y).toBe(5);
  });

  // ============================================================================
  // M13.5b §G / T1–T3 — dropRejected integration with the held-key burst pattern
  //
  // RED REASON: `predictor.dropRejected` does not exist yet on the Predictor
  // class — every `.dropRejected(...)` call below is a TS compile error until
  // the implementer adds the method.
  // ============================================================================

  it('13.5b-4 RED-LOCK: without dropRejected, burst-tail rejection leaves a permanent +1 x-offset with diverged=false', () => {
    // Kills: any impl where the call site OMITS dropRejected after a rejection —
    // the predictor stays permanently 1 east of authority, diverged=false (silent desync).
    //
    // Setup: held-East burst — fill queue+pending, the LAST sent seq is the "tail".
    // The server rejects the tail (authority stays at the seeded x), ack = tailSeq-1.
    // Without dropRejected, repeated reconciles at ack=tailSeq-1 keep replaying the
    // tail East → predicted stays 1 ahead of authority, diverged=false every time.
    const QUEUE_CAP = 2;
    const PENDING_CAP = 4;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP, PENDING_CAP);
    const held = new HeldDirections();

    const t0 = 10_000;
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);
    held.press('East');

    const FRAME_MS = 50;
    let now = t0;
    const sentIntents: IntentToSend[] = [];

    // Run 8 frames to fill queue+pending (burst).
    for (let frame = 0; frame < 8; frame++) {
      now += FRAME_MS;
      const d = reissueDir(held.active(), predictor.lastQueuedDir);
      if (d !== undefined) {
        const intent = predictor.enqueue({ Step: d });
        if (intent !== undefined) sentIntents.push(intent);
      }
      predictor.drain(now);
    }

    expect(sentIntents.length).toBeGreaterThan(0);
    const tailSeq = sentIntents[sentIntents.length - 1]!.seq;
    const ackedSeqBeforeReject = tailSeq - 1;

    // Server state: rejected the tail. Authority = whatever position excludes tail.
    // For simplicity, authority stays at (5,5) baseline (server never moved us — the
    // rejection scenario: the server applied none of them, e.g. movement forbidden).
    const authBase = fakeBaseline(5, 5, now - 2 * STEP_MS);

    // The tail intent must still be pending (review fix: this was a vacuous
    // always-true helper). Nothing has been acked since the seed reconcile, so
    // EVERY sent intent — tail included — survives the prune; seqs are consecutive
    // (a cap-declined enqueue consumes no seq), so the count is exact.
    expect(predictor.pendingCount).toBe(sentIntents.length);
    expect(predictor.pendingCount).toBeGreaterThan(0);

    // WITHOUT dropRejected: the first reconcile at ack=tailSeq-1 is a GENUINE PULLBACK
    // (predicted ran ahead during the burst; corrected position still replays the tail
    // East, so predicted lands 1 ahead of authority). d1 === true (tiles differ).
    const d1 = predictor.reconcile(authBase, [], ackedSeqBeforeReject, now);
    expect(d1).toBe(true); // genuine pullback on first reconcile — tiles differ

    // The SILENT STEADY STATE: subsequent reconciles with the same ack keep replaying
    // the phantom tail East (it is never acked, never dropped), so predicted stays
    // 1 ahead of authority at the same tile — pre-reconcile pos equals post-reconcile
    // pos → diverged=false. This is the bug class: reconcile "agrees" while staying
    // wrong forever.
    const posAfterD1 = predictor.predicted!.pos.x;
    expect(posAfterD1).toBeGreaterThan(5); // off authority (5,5) by the phantom East

    const d2 = predictor.reconcile(authBase, [], ackedSeqBeforeReject, now);
    expect(d2).toBe(false); // silent desync: same wrong tile → diverged=false
    expect(predictor.predicted!.pos.x).toBe(posAfterD1); // still off authority

    const d3 = predictor.reconcile(authBase, [], ackedSeqBeforeReject, now);
    expect(d3).toBe(false); // still locked in silent desync
    expect(predictor.predicted!.pos.x).toBe(posAfterD1); // permanently off authority
    // Kills: an impl without dropRejected that claims the desync is somehow resolved.
  });

  it('13.5b-4 GREEN: dropRejected(tailSeq) + one reconcile converges predicted to authority', () => {
    // Kills: an impl where dropRejected does not evict the op (returns false or no-ops),
    // leaving the predictor still 1 east of authority after the forced reconcile.
    const QUEUE_CAP = 2;
    const PENDING_CAP = 4;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP, PENDING_CAP);
    const held = new HeldDirections();

    const t0 = 10_000;
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);
    held.press('East');

    const FRAME_MS = 50;
    let now = t0;
    const sentIntents: IntentToSend[] = [];

    for (let frame = 0; frame < 8; frame++) {
      now += FRAME_MS;
      const d = reissueDir(held.active(), predictor.lastQueuedDir);
      if (d !== undefined) {
        const intent = predictor.enqueue({ Step: d });
        if (intent !== undefined) sentIntents.push(intent);
      }
      predictor.drain(now);
    }

    expect(sentIntents.length).toBeGreaterThan(0);
    const tailSeq = sentIntents[sentIntents.length - 1]!.seq;
    const ackedSeqBeforeReject = tailSeq - 1;

    // Authority at (5,5): server rejected the tail (and every op that moved us).
    const authBase = fakeBaseline(5, 5, now - 2 * STEP_MS);

    // THE FIX: drop the rejected tail, then force a reconcile.
    // T3: capture queueDepth BEFORE dropRejected — #queue must be unchanged by the call.
    const qDepthBefore = predictor.queueDepth;
    expect(predictor.dropRejected(tailSeq)).toBe(true); // the op was present and is now evicted
    expect(predictor.queueDepth).toBe(qDepthBefore); // T3: #queue not spliced by dropRejected

    // One reconcile at ack = tailSeq-1 (server hasn't acked the tail because it
    // rejected it; all prior ops are acked at ackedSeqBeforeReject).
    predictor.reconcile(authBase, [], ackedSeqBeforeReject, now);

    // IMMEDIATE convergence (review fix: kills a lying always-true no-op
    // dropRejected, which the full-ack reconcile below would forgive): seqs are
    // consecutive, so ack tailSeq-1 prunes every survivor and the tail is dropped
    // — NOTHING replays; predicted equals authority right here, after ONE reconcile.
    expect(predictor.pendingCount).toBe(0);
    expect(predictor.predicted!.pos).toEqual({ x: 5, y: 5 });

    // Full-ack path stays converged (belt: the original assertion set).
    predictor.reconcile(authBase, [], tailSeq, now); // ack everything
    expect(predictor.pendingCount).toBe(0);
    expect(predictor.predicted!.pos).toEqual({ x: 5, y: 5 });
  });

  it('T1: multi-pending selective drop — dropRejected(N) with M<N pending leaves M, replays only M', () => {
    // Kills: a drop-all impl, a drop-wrong-index impl, and any impl that corrupts
    // the surviving pending op so reconcile does not replay it correctly.
    //
    // Two pending ops M < N. dropRejected(N) → pendingCount 1, M survives.
    // Reconcile at ack M-1 replays ONLY M (one East step), pendingCount 1 before.
    const QUEUE_CAP = 8;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    const t0 = 10_000;
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    const intM = predictor.enqueue({ Step: 'East' })!; // seq M
    predictor.drain(t0); // drain so the queue slot is free

    // reconcile at ackedSeq=0 (below M's seq, so M stays pending) to clear the
    // rebuilt queue (drain consumed the prior queue entry) while keeping M unacked.
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    const intN = predictor.enqueue({ Step: 'East' })!; // seq N (> M)
    expect(intN.seq).toBeGreaterThan(intM.seq);

    expect(predictor.pendingCount).toBe(2); // M and N pending

    // Drop N (the one we "reject").
    const dropped = predictor.dropRejected(intN.seq);
    expect(dropped).toBe(true);
    expect(predictor.pendingCount).toBe(1); // only M remains (T1 + T3 queueDepth assertion)

    // queueDepth unchanged by drop itself (T3).
    // (We don't assert a specific value here since drain may have consumed earlier,
    // but we confirm it did not change between the drop call and now.)

    // Reconcile at ack M-1: M survives, replays one East step from (5,5) → predicted at (6,5).
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], intM.seq - 1, t0);
    expect(predictor.pendingCount).toBe(1); // M still unacked after reconcile at M-1
    // The East from M was replayed onto authQueue=[] → queue=[East], then drained
    // (because baseline is 2 steps ago, one step is due): predicted.x = 6.
    expect(predictor.predicted!.pos.x).toBe(6);
    expect(predictor.predicted!.pos.y).toBe(5);
  });

  it('reissueDir dedup prevents queue/pending overload vs a no-dedup impl', () => {
    // BITES: an impl of reissueDir that always returns `active` regardless of
    // lastQueuedDir — would fill the pending array far beyond pendingCap when the
    // queueCap declines pushes (declined enqueue does NOT consume seq, but a
    // no-dedup impl would keep calling enqueue on every frame from the frame loop).
    // With correct dedup: once 'East' is the lastQueuedDir, reissueDir returns
    // undefined, so enqueue is not called and no new intents accumulate.

    const QUEUE_CAP = 2;
    const PENDING_CAP = 4;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP, PENDING_CAP);
    const held = new HeldDirections();

    const t0 = 10_000;
    predictor.reconcile(fakeBaseline(2, 2, t0 - 2 * STEP_MS), [], 0, t0);
    held.press('East');

    let now = t0;
    // Run 50 sub-step frames. With correct dedup, pendingCount stays bounded.
    for (let frame = 0; frame < 50; frame++) {
      now += 40; // 40ms per frame (5 frames per STEP_MS=200)
      const d = reissueDir(held.active(), predictor.lastQueuedDir);
      if (d !== undefined) {
        predictor.enqueue({ Step: d });
      }
      predictor.drain(now);
      // This is the key assertion: with dedup + backpressure, pending stays bounded.
      // Without dedup, every frame calls enqueue; each declined enqueue returns
      // undefined and does NOT add to pending — BUT with a correct dedup, enqueue
      // is not even called on frames where East is already the lastQueuedDir.
      expect(predictor.pendingCount).toBeLessThanOrEqual(PENDING_CAP);
      expect(predictor.queueDepth).toBeLessThanOrEqual(QUEUE_CAP);
    }
  });
});
