// ackOnRow.property.test.ts — random interleavings of the movement pipeline's events against
// a server model, over the REAL Predictor and OwedInputs.
//
// The model is the wire, not main.ts: two FIFO links (client→server calls, server→client
// row snapshots and rejections) and a server that keeps a queue and a seq guard and
// publishes `(position, queue, ackedSeq)` as ONE row. `ackDelivery` picks when an accepted
// input reaches that row: 'accept' publishes it with the reducer call, 'tick' publishes it
// with the next tick's write. Every property holds under both.
//
// Properties:
//   P1 (within a predictor generation) after every reconcile the local queue is
//      clamp(row queue ++ replay(in-flight ops)) and `outstandingSteps` is the row's queue
//      length plus the in-flight count.
//   P2 (across rebuilds) `outstandingSteps + owed.count` is never 0 while the server owes a
//      step — the continuation gate cannot open onto work the server has not finished.
//   P3 (liveness) once both links are drained and the server has ticked its queue empty,
//      nothing is owed and the client stands where the server does.
//
// Deterministic: a counter clock, no wall clock, no timers; fast-check supplies the order.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WasmCharacterState, WasmDirection, WasmMoveInput } from '../convert/convert';
import { OwedInputs } from './owedInputs';
import { type ApplyMove, Predictor, type PredictorEpoch, type QueueOp } from './predictor';

const STEP_MS = 200;
const QUEUE_CAP = 2;

type AckDelivery = 'accept' | 'tick';

const DELTA: Record<WasmDirection, { dx: number; dy: number }> = {
  North: { dx: 0, dy: -1 },
  South: { dx: 0, dy: 1 },
  East: { dx: 1, dy: 0 },
  West: { dx: -1, dy: 0 },
};
/** An open plane: every step moves, a jump moves along the facing. */
function moved(state: WasmCharacterState, input: WasmMoveInput, now: number): WasmCharacterState {
  const facing = input === 'Jump' ? state.facing : input.Step;
  const d = DELTA[facing];
  return {
    pos: { x: state.pos.x + d.dx, y: state.pos.y + d.dy },
    facing,
    action: input === 'Jump' ? 'Jumping' : 'Walking',
    move_started_at: now,
  };
}

/** The row every client sees: position, queue and ack, written together. */
interface Row {
  readonly zone: number;
  readonly x: number;
  readonly y: number;
  readonly facing: WasmDirection;
  readonly queue: readonly WasmMoveInput[];
  readonly ackedSeq: number;
}

type Downlink =
  | { readonly kind: 'row'; readonly row: Row }
  | { readonly kind: 'reject'; readonly seq: number; readonly epoch: PredictorEpoch };

interface Call {
  readonly seq: number;
  readonly op: QueueOp;
  readonly epoch: PredictorEpoch;
}

/** The reconcile replay rule, restated independently of predictor.ts. */
function replay(queue: readonly WasmMoveInput[], ops: readonly QueueOp[]): WasmMoveInput[] {
  let q = [...queue];
  for (const op of ops) {
    if (op.kind === 'Enqueue') q.push(op.input);
    else if (op.kind === 'SetMove') q = [op.input];
    else q = [];
  }
  return q.slice(0, QUEUE_CAP);
}

class World {
  // --- server -------------------------------------------------------------------
  #pos = { zone: 0, x: 0, y: 0, facing: 'South' as WasmDirection };
  #queue: WasmMoveInput[] = [];
  #seq = 0;
  /** What the public row currently carries of the queue and the seq. */
  #published: { queue: readonly WasmMoveInput[]; ackedSeq: number } = { queue: [], ackedSeq: 0 };
  #battleLocked = false;
  // --- links --------------------------------------------------------------------
  readonly #uplink: Call[] = [];
  readonly #downlink: Downlink[] = [];
  // --- client -------------------------------------------------------------------
  readonly #owed = new OwedInputs();
  /** OBSERVATION ONLY: rebuilds (commanded or warp-driven) that ran with a call still on the
   *  uplink — the case P2 exists for. */
  rebuildsWithInputOnTheWire = 0;
  #predictor: Predictor;
  #row: Row | undefined;
  #lastSentSeq = 0;
  /** Ops sent by the CURRENT predictor whose rejection has not been received. */
  #sentThisGeneration: Call[] = [];
  #now = 10_000;
  /** Inputs the predictor's injected rule applied since the last reset of this log. */
  #applied: WasmMoveInput[] = [];
  readonly #applyMove: ApplyMove = (state, input, now) => {
    this.#applied.push(input);
    return moved(state, input, now);
  };

  constructor(readonly ackDelivery: AckDelivery) {
    this.#predictor = new Predictor(this.#applyMove, STEP_MS, QUEUE_CAP);
    this.#publish(); // the login snapshot
  }

  #publish(): void {
    this.#published = { queue: [...this.#queue], ackedSeq: this.#seq };
    this.#pushRow();
  }
  /** Send the row as it is published: the position is always current, the queue and the
   *  ack are whatever the last publish wrote. */
  #pushRow(): void {
    this.#downlink.push({
      kind: 'row',
      row: { ...this.#pos, queue: this.#published.queue, ackedSeq: this.#published.ackedSeq },
    });
  }
  get #unpublished(): boolean {
    return (
      this.#published.ackedSeq !== this.#seq ||
      this.#published.queue.length !== this.#queue.length ||
      this.#published.queue.some((m, i) => m !== this.#queue[i])
    );
  }

  // --- client commands ------------------------------------------------------------
  send(kind: QueueOp['kind'], input: WasmMoveInput): void {
    let intent: Call | undefined;
    if (kind === 'Enqueue') intent = this.#predictor.enqueue(input);
    else if (kind === 'SetMove') intent = this.#predictor.setMove(input);
    else intent = this.#predictor.clearQueue();
    if (intent === undefined) return; // declined: nothing predicted, nothing sent
    this.#lastSentSeq = intent.seq;
    this.#owed.sent(intent.seq);
    this.#sentThisGeneration.push(intent);
    this.#uplink.push(intent);
  }
  /** The rAF drain: frees the local queue so later sends are not all declined. */
  frame(): void {
    this.#now += STEP_MS;
    this.#predictor.drain(this.#now);
  }
  /** `resetPredictionState` + the reconcile that follows it in the same call stack. */
  rebuild(): void {
    if (this.#uplink.length > 0) this.rebuildsWithInputOnTheWire += 1;
    this.#predictor = new Predictor(this.#applyMove, STEP_MS, QUEUE_CAP);
    this.#predictor.seedSeq(this.#lastSentSeq);
    this.#sentThisGeneration = [];
    this.#reconcile();
  }
  /** Take the next message off the server→client link. */
  receive(): void {
    const msg = this.#downlink.shift();
    if (msg === undefined) return;
    if (msg.kind === 'reject') {
      this.#owed.rejected(msg.seq);
      this.#sentThisGeneration = this.#sentThisGeneration.filter((c) => c.seq !== msg.seq);
      if (this.#predictor.dropRejected(msg.seq, msg.epoch)) this.#reconcile();
      return;
    }
    const warped = this.#row !== undefined && this.#row.zone !== msg.row.zone;
    this.#row = msg.row;
    if (warped) this.rebuild();
    else this.#reconcile();
  }
  #reconcile(): void {
    const row = this.#row;
    if (row === undefined) return;
    this.#now += 1;
    // Rebased two steps back, as convert.ts does, so step 4 drains the whole rebuilt queue
    // through the recording rule: what it applied IS the queue the reconcile rebuilt.
    const baseline: WasmCharacterState = {
      pos: { x: row.x, y: row.y },
      facing: row.facing,
      action: 'Idle',
      move_started_at: this.#now - QUEUE_CAP * STEP_MS,
    };
    this.#owed.acked(row.ackedSeq);
    this.#predictor.seedSeq(row.ackedSeq);
    this.#applied = [];
    this.#predictor.reconcile(baseline, row.queue, row.ackedSeq, this.#now);

    // P1.
    const inFlight = this.#sentThisGeneration.filter((c) => c.seq > row.ackedSeq);
    expect(this.#applied, 'P1: queue after reconcile').toEqual(
      replay(
        row.queue,
        inFlight.map((c) => c.op),
      ),
    );
    expect(this.#predictor.outstandingSteps, 'P1: outstandingSteps').toBe(
      row.queue.length + inFlight.length,
    );
    expect(this.#predictor.pendingCount, 'P1: pending is exactly the in-flight ops').toBe(
      inFlight.length,
    );
  }

  // --- server commands ------------------------------------------------------------
  /** Process the next call on the client→server link (guards.rs + movement.rs). */
  deliver(): void {
    const call = this.#uplink.shift();
    if (call === undefined) return;
    const { op } = call;
    const refused =
      call.seq <= this.#seq ||
      (this.#battleLocked && op.kind !== 'Clear') ||
      (op.kind === 'Enqueue' && this.#queue.length >= QUEUE_CAP);
    if (refused) {
      this.#downlink.push({ kind: 'reject', seq: call.seq, epoch: call.epoch });
      return;
    }
    this.#seq = call.seq;
    if (op.kind === 'Enqueue') this.#queue.push(op.input);
    else if (op.kind === 'SetMove') this.#queue = [op.input];
    else this.#queue = [];
    if (this.ackDelivery === 'accept') this.#publish();
  }
  /** movement_tick for this character. `warpTo` is the zone a drained step lands in. */
  tick(warpTo?: number): void {
    if (this.#queue.length === 0 || this.#battleLocked) {
      if (this.#unpublished) this.#publish();
      return;
    }
    const input = this.#queue.shift() as WasmMoveInput;
    const next = moved(
      {
        pos: { x: this.#pos.x, y: this.#pos.y },
        facing: this.#pos.facing,
        action: 'Idle',
        move_started_at: 0,
      },
      input,
      0,
    );
    this.#pos = { zone: this.#pos.zone, x: next.pos.x, y: next.pos.y, facing: next.facing };
    if (warpTo !== undefined && warpTo !== this.#pos.zone) {
      this.#pos = { zone: warpTo, x: 100 * warpTo, y: 0, facing: next.facing };
      this.#queue = [];
    }
    this.#publish();
  }
  setBattleLocked(locked: boolean): void {
    this.#battleLocked = locked;
  }

  // --- invariants -----------------------------------------------------------------
  /** P2. A call still on the uplink counts: the client cannot know it will be refused. */
  checkGate(): void {
    const serverOwes = this.#queue.length > 0 || this.#uplink.length > 0;
    if (!serverOwes) return;
    expect(
      this.#predictor.outstandingSteps + this.#owed.count,
      'P2: the continuation gate is open while the server still owes a step',
    ).toBeGreaterThan(0);
  }
  /** P3. */
  settleAndCheck(): void {
    this.#battleLocked = false;
    while (this.#uplink.length > 0) this.deliver();
    for (let i = 0; i <= QUEUE_CAP; i++) this.tick();
    while (this.#downlink.length > 0) this.receive();
    expect(this.#queue, 'the server queue drains').toEqual([]);
    expect(this.#owed.count, 'P3: nothing is owed once everything is delivered').toBe(0);
    expect(this.#predictor.outstandingSteps, 'P3: outstandingSteps').toBe(0);
    expect(this.#predictor.pendingCount, 'P3: pending').toBe(0);
    const predicted = this.#predictor.predicted;
    expect(predicted?.pos, 'P3: the client stands where the server does').toEqual({
      x: this.#pos.x,
      y: this.#pos.y,
    });
  }
}

type Command =
  | { readonly c: 'send'; readonly kind: QueueOp['kind']; readonly input: WasmMoveInput }
  | { readonly c: 'deliver' }
  | { readonly c: 'receive' }
  | { readonly c: 'tick' }
  | { readonly c: 'warp'; readonly zone: number }
  | { readonly c: 'rebuild' }
  | { readonly c: 'frame' }
  | { readonly c: 'lock'; readonly locked: boolean };

const inputArb: fc.Arbitrary<WasmMoveInput> = fc.oneof(
  fc.constantFrom<WasmDirection>('North', 'South', 'East', 'West').map((d) => ({ Step: d })),
  fc.constant<WasmMoveInput>('Jump'),
);
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 6,
    arbitrary: inputArb.map((input) => ({ c: 'send', kind: 'Enqueue', input }) as const),
  },
  {
    weight: 1,
    arbitrary: inputArb.map((input) => ({ c: 'send', kind: 'SetMove', input }) as const),
  },
  { weight: 1, arbitrary: inputArb.map((input) => ({ c: 'send', kind: 'Clear', input }) as const) },
  { weight: 6, arbitrary: fc.constant({ c: 'deliver' } as const) },
  { weight: 6, arbitrary: fc.constant({ c: 'receive' } as const) },
  { weight: 4, arbitrary: fc.constant({ c: 'tick' } as const) },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 0, max: 2 }).map((zone) => ({ c: 'warp', zone }) as const),
  },
  { weight: 2, arbitrary: fc.constant({ c: 'rebuild' } as const) },
  { weight: 3, arbitrary: fc.constant({ c: 'frame' } as const) },
  { weight: 1, arbitrary: fc.boolean().map((locked) => ({ c: 'lock', locked }) as const) },
);

function run(world: World, commands: readonly Command[]): void {
  for (const cmd of commands) {
    switch (cmd.c) {
      case 'send':
        world.send(cmd.kind, cmd.input);
        break;
      case 'deliver':
        world.deliver();
        break;
      case 'receive':
        world.receive();
        break;
      case 'tick':
        world.tick();
        break;
      case 'warp':
        world.tick(cmd.zone);
        break;
      case 'rebuild':
        world.rebuild();
        break;
      case 'frame':
        world.frame();
        break;
      case 'lock':
        world.setBattleLocked(cmd.locked);
        break;
    }
    world.checkGate();
  }
  world.settleAndCheck();
}

describe.each<AckDelivery>([
  'accept',
  'tick',
])('ack on the character row, delivered at %s: random interleavings', (ackDelivery) => {
  it('P1 queue and outstandingSteps within a generation, P2 the gate across rebuilds, P3 liveness', () => {
    fc.assert(
      fc.property(fc.array(commandArb, { maxLength: 80 }), (commands) => {
        run(new World(ackDelivery), commands);
      }),
      { numRuns: 1500, seed: 0x5e11ce1 },
    );
  });

  it('ANTI-VACUITY: the generated runs reach a rebuild with an input still on the wire', () => {
    // P2 is only interesting when a predictor is rebuilt while an input is in flight.
    let reached = 0;
    fc.assert(
      fc.property(fc.array(commandArb, { maxLength: 80 }), (commands) => {
        const world = new World(ackDelivery);
        run(world, commands);
        if (world.rebuildsWithInputOnTheWire > 0) reached += 1;
      }),
      { numRuns: 300, seed: 0x5e11ce1 },
    );
    expect(reached, 'runs (of 300) with at least one such rebuild').toBeGreaterThanOrEqual(20);
  });
});

describe('ack on the character row: the property has teeth', () => {
  it('a rebuild with an input on the wire reads outstandingSteps 0, and only the owed set keeps the gate shut', () => {
    // The shrunk shape P2 exists for, pinned as an example: without OwedInputs the sum
    // below would be 0 while the server is about to accept a step.
    for (const ackDelivery of ['accept', 'tick'] as const) {
      const world = new World(ackDelivery);
      world.receive(); // login snapshot
      world.send('Enqueue', { Step: 'East' });
      world.rebuild();
      world.checkGate();
      world.deliver();
      world.checkGate();
      world.settleAndCheck();
    }
  });
});
