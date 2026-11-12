// owedInputs.test.ts — the owed-input set (owedInputs.ts) on its own, and against the one
// event it exists for: a predictor rebuild while an input is still on the wire.
import { describe, expect, it } from 'vitest';
import type { WasmCharacterState } from '../convert/convert';
import { OwedInputs } from './owedInputs';
import { type ApplyMove, Predictor } from './predictor';

const STEP_MS = 200;
const QUEUE_CAP = 2;

describe('OwedInputs: sent inputs the server has neither rejected nor acked', () => {
  it('starts empty and counts each sent seq once', () => {
    const owed = new OwedInputs();
    expect(owed.count).toBe(0);
    owed.sent(4);
    owed.sent(5);
    expect(owed.count).toBe(2);
    owed.sent(5); // WRONG IMPL KILLED: a counter instead of a set double-counts a repeat
    expect(owed.count).toBe(2);
  });

  it('rejected removes exactly that seq, and an unknown seq is a no-op', () => {
    const owed = new OwedInputs();
    owed.sent(4);
    owed.sent(5);
    owed.sent(6);
    owed.rejected(5);
    expect(owed.count).toBe(2);
    owed.rejected(5); // already settled
    owed.rejected(99); // never sent
    expect(owed.count).toBe(2);
    // The survivors are 4 and 6, not "the first two": an ack of 4 leaves exactly one.
    owed.acked(4);
    expect(owed.count).toBe(1);
    owed.acked(6);
    expect(owed.count).toBe(0);
  });

  it('acked drops every seq at or below the ack and keeps every seq above it', () => {
    const owed = new OwedInputs();
    for (const seq of [3, 4, 5, 9]) owed.sent(seq);
    owed.acked(2); // below everything: nothing settles
    expect(owed.count).toBe(4);
    owed.acked(4); // WRONG IMPL KILLED: `<` instead of `<=` leaves seq 4 owed
    expect(owed.count).toBe(2);
    owed.acked(8); // a gap in the ack sequence covers 5 and leaves 9
    expect(owed.count).toBe(1);
    owed.acked(3); // an older ack arriving later settles nothing and resurrects nothing
    expect(owed.count).toBe(1);
    owed.acked(9);
    expect(owed.count).toBe(0);
  });

  it('clear empties the set, and the set is usable afterwards', () => {
    const owed = new OwedInputs();
    owed.sent(1);
    owed.sent(2);
    owed.clear();
    expect(owed.count).toBe(0);
    owed.sent(3);
    expect(owed.count).toBe(1);
  });

  it('survives a predictor rebuild: the in-flight input the fresh predictor cannot see stays owed', () => {
    // The warp shape (main.ts `resetPredictionState`): an input is sent, then the predictor
    // is replaced before the row that acks it arrives.
    const applyMove: ApplyMove = (state, _input, now): WasmCharacterState => ({
      ...state,
      move_started_at: now,
    });
    const baseline: WasmCharacterState = {
      pos: { x: 5, y: 5 },
      facing: 'East',
      action: 'Idle',
      move_started_at: 0,
    };
    const owed = new OwedInputs();
    let predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    predictor.reconcile(baseline, [], 0, 1000);

    const intent = predictor.enqueue({ Step: 'East' });
    expect(intent).toBeDefined();
    const seq = (intent as { seq: number }).seq;
    owed.sent(seq);
    expect(predictor.outstandingSteps).toBe(1);
    expect(owed.count).toBe(1);

    // Rebuild + the warp row's reconcile: that row was written before the input arrived, so
    // its queue is empty and its ack does not cover the input.
    predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    predictor.seedSeq(seq);
    predictor.reconcile(baseline, [], seq - 1, 1010);
    owed.acked(seq - 1);
    expect(
      predictor.outstandingSteps,
      'PRECONDITION: the fresh predictor reads 0 while the input is still on the wire',
    ).toBe(0);
    expect(owed.count, 'the owed set still counts it, so the emitters stay shut').toBe(1);

    // The row that acks the input arrives: only now is nothing owed.
    predictor.reconcile(baseline, [{ Step: 'East' }], seq, 1020);
    owed.acked(seq);
    expect(owed.count).toBe(0);
    expect(predictor.outstandingSteps, 'and the predictor counts the queued step itself').toBe(1);
  });
});
