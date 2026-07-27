// [DIAG-mvinv] movementSim.diag.test.ts — DIAGNOSTIC harness for the r2 residual
// double-move report (M-postgate-movement-investigation, ledger 003/015/029/040-042).
//
// Drew's repro: walk to the (west) edge, pause, single tap right → sometimes the
// character moves 1 tile, sometimes 2, inconsistently.
//
// This file is a deterministic discrete-event simulation of the FULL client↔server
// movement pipeline. REAL units under test: Predictor (prediction core),
// HeldDirections + reissueDir (held-key policy), characterToPredictedBaseline
// (ADR-0012 rebase). MODELED line-by-line (with source citations): the main.ts
// wiring — keydown/keyup handlers (main.ts:1093-1110), sendIntent (main.ts:470-505),
// the reconcile batch listener + divergence re-issue (main.ts:366-465), the rAF
// frame body (main.ts:2101-2139) — and the server reducers: guards.rs
// authorize_move (:66-96), movement.rs enqueue_move (:120-130) and the
// movement_tick drain arm (:184-237). main.ts itself is not importable under
// vitest (module-scope DOM/PIXI/wasm side effects) and the server is Rust.
//
// Determinism: one virtual clock, an explicit event queue ordered by
// (time, insertion-seq). No wall clock, no RNG, no timers.
import { describe, expect, it } from 'vitest';
import type { WasmCharacterState, WasmDirection, WasmMoveInput } from '../convert/convert';
import { characterToPredictedBaseline, type SdkCharacterFields } from '../convert/convert';
import { HeldDirections, reissueDir } from './heldKeys';
import { type ApplyMove, Predictor, type PredictorEpoch } from './predictor';

const STEP_MS = 200; // game-core world.rs:13
const QUEUE_CAP = 2; // game-core world.rs:16 MOVE_QUEUE_CAP (main.ts:138 move_queue_cap())

// --- deterministic applyMove (same tiny map as predictor.test.ts: west wall x<=0) ---
function stepPos(dir: WasmDirection, x: number, y: number): { x: number; y: number } {
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
// Mirrors game-core world.rs apply_move (:364-399): move_started_at stamped on EVERY
// call; Step turns to face, moves if walkable else bumps Idle; Jump moves along facing.
const applyMove: ApplyMove = (state, input, now): WasmCharacterState => {
  const stamp = Math.floor(now);
  if (input === 'Jump') {
    const target = stepPos(state.facing, state.pos.x, state.pos.y);
    const pos = walkable(target) ? target : state.pos;
    return { ...state, pos, action: 'Jumping', move_started_at: stamp };
  }
  const dir = input.Step;
  const target = stepPos(dir, state.pos.x, state.pos.y);
  if (walkable(target)) {
    return { pos: target, facing: dir, action: 'Walking', move_started_at: stamp };
  }
  return { ...state, facing: dir, action: 'Idle', move_started_at: stamp };
};

// --- discrete-event engine -------------------------------------------------------
interface SimEvent {
  at: number;
  seq: number;
  fn: (at: number) => void;
}
class EventQueue {
  #events: SimEvent[] = [];
  #insertSeq = 0;
  push(at: number, fn: (at: number) => void): void {
    this.#events.push({ at, seq: this.#insertSeq++, fn });
  }
  /** Run all events with at <= untilMs in (at, insertion-seq) order. */
  run(untilMs: number): void {
    for (;;) {
      let bestIdx = -1;
      for (let i = 0; i < this.#events.length; i++) {
        const e = this.#events[i];
        if (e.at > untilMs) continue;
        if (
          bestIdx === -1 ||
          e.at < this.#events[bestIdx].at ||
          (e.at === this.#events[bestIdx].at && e.seq < this.#events[bestIdx].seq)
        ) {
          bestIdx = i;
        }
      }
      if (bestIdx === -1) return;
      const [ev] = this.#events.splice(bestIdx, 1);
      ev.fn(ev.at);
    }
  }
}

// --- server model (guards.rs + movement.rs) --------------------------------------
interface ServerRow {
  x: number;
  y: number;
  facing: WasmDirection;
  action: 'Idle' | 'Walking' | 'Jumping';
  moveStartedAt: number;
  moveQueue: WasmMoveInput[];
  lastInputSeq: number;
}
class ServerModel {
  row: ServerRow;
  readonly acceptedDrains: { dir: string; atMs: number; moved: boolean }[] = [];
  constructor(x: number, y: number) {
    this.row = {
      x,
      y,
      facing: 'South',
      action: 'Idle',
      moveStartedAt: 0,
      moveQueue: [],
      lastInputSeq: 0,
    };
  }
  /** guards.rs authorize_move (:77-81, :93) + movement.rs enqueue_move (:120-130). */
  enqueueMove(input: WasmMoveInput, seq: number): 'ok' | 'stale seq' | 'queue full' {
    if (seq <= this.row.lastInputSeq) return 'stale seq';
    if (this.row.moveQueue.length >= QUEUE_CAP) return 'queue full'; // txn rollback: no ack
    this.row.lastInputSeq = seq;
    this.row.moveQueue.push(input);
    return 'ok';
  }
  /** movement.rs movement_tick drain arm (:184-237). Returns true iff the row changed. */
  tick(now: number): boolean {
    if (this.row.moveQueue.length === 0) {
      if (this.row.action !== 'Idle') {
        this.row.action = 'Idle';
        return true;
      }
      return false;
    }
    const input = this.row.moveQueue.shift() as WasmMoveInput;
    const before: WasmCharacterState = {
      pos: { x: this.row.x, y: this.row.y },
      facing: this.row.facing,
      action: this.row.action,
      move_started_at: this.row.moveStartedAt,
    };
    const next = applyMove(before, input, now);
    const moved = next.pos.x !== before.pos.x || next.pos.y !== before.pos.y;
    this.acceptedDrains.push({
      dir: input === 'Jump' ? 'Jump' : input.Step,
      atMs: now,
      moved,
    });
    this.row.x = next.pos.x;
    this.row.y = next.pos.y;
    this.row.facing = next.facing;
    this.row.action = next.action;
    this.row.moveStartedAt = next.move_started_at;
    return true;
  }
  snapshot(): ServerRow {
    return { ...this.row, moveQueue: [...this.row.moveQueue] };
  }
}

// --- client model (main.ts wiring over the REAL prediction units) ----------------
interface Emission {
  seq: number;
  dir: string;
  atMs: number;
  source: 'keydown' | 'frame' | 'divergence';
}
class ClientModel {
  readonly predictor: Predictor;
  readonly held = new HeldDirections();
  lastSentSeq = 0; // main.ts:469
  lastRow: ServerRow | undefined;
  readonly emissions: Emission[] = [];
  readonly rejections: { seq: number; reason: string; atMs: number }[] = [];
  #send: (input: WasmMoveInput, seq: number, epoch: PredictorEpoch, at: number) => void;
  #source: Emission['source'] = 'keydown';
  constructor(
    send: (input: WasmMoveInput, seq: number, epoch: PredictorEpoch, at: number) => void,
  ) {
    this.predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    this.#send = send;
  }
  /** main.ts sendIntent (:470-505), conn always live, no overlays. */
  sendIntent(input: WasmMoveInput, at: number): void {
    const intent = this.predictor.enqueue(input);
    if (intent === undefined) return; // declined: predict & send nothing
    this.lastSentSeq = intent.seq;
    this.emissions.push({
      seq: intent.seq,
      dir: input === 'Jump' ? 'Jump' : input.Step,
      atMs: at,
      source: this.#source,
    });
    this.#send(input, intent.seq, intent.epoch, at);
  }
  /** main.ts keydown movement branch (:1093-1098). */
  keydown(dir: WasmDirection, at: number): void {
    this.#source = 'keydown';
    this.sendIntent({ Step: dir }, at); // immediate first step
    this.held.press(dir);
  }
  /** main.ts keyup (:1107-1110). */
  keyup(dir: WasmDirection): void {
    this.held.release(dir);
  }
  /** store batch listener → reconcileFromStore (main.ts:366-465), no overlays. */
  onRowUpdate(row: ServerRow, at: number): void {
    this.lastRow = row;
    this.reconcileFromStore(at);
  }
  reconcileFromStore(at: number): void {
    if (this.lastRow === undefined) return;
    const sdkFields: SdkCharacterFields = {
      tileX: this.lastRow.x,
      tileY: this.lastRow.y,
      facing: { tag: this.lastRow.facing },
      action: { tag: this.lastRow.action },
      moveStartedAtMs: BigInt(Math.floor(this.lastRow.moveStartedAt)),
    };
    const baseline = characterToPredictedBaseline(sdkFields, at, STEP_MS);
    const ackedSeq = this.lastRow.lastInputSeq;
    this.predictor.seedSeq(ackedSeq); // main.ts:418
    const diverged = this.predictor.reconcile(baseline, this.lastRow.moveQueue, ackedSeq, at);
    // main.ts:429-451 divergence re-issue, nh2-gated.
    if (diverged && this.predictor.outstandingSteps === 0) {
      const heldDir = reissueDir(this.held.active(), this.predictor.lastQueuedDir);
      if (heldDir !== undefined) {
        this.#source = 'divergence';
        this.sendIntent({ Step: heldDir }, at);
      }
    }
  }
  /** rAF frame body (main.ts:2101-2139): drain FIRST (nh2 R1), then gated re-issue. */
  frame(at: number): void {
    this.predictor.drain(at);
    if (this.predictor.outstandingSteps === 0) {
      const heldDir = reissueDir(this.held.active(), this.predictor.lastQueuedDir);
      if (heldDir !== undefined) {
        this.#source = 'frame';
        this.sendIntent({ Step: heldDir }, at);
      }
    }
  }
}

// --- scenario driver -------------------------------------------------------------
interface SimConfig {
  fps: number;
  tickPhaseMs: number; // server movement_tick offset in [0, STEP_MS)
  latencyMs: number; // one-way, each direction
  framePhaseMs?: number;
  startX: number;
  startY: number;
}
interface KeyScript {
  dir: WasmDirection;
  downAtMs: number;
  upAtMs: number;
}
interface SimResult {
  server: ServerModel;
  client: ClientModel;
}
function runSim(cfg: SimConfig, keys: KeyScript[], untilMs: number): SimResult {
  const q = new EventQueue();
  const server = new ServerModel(cfg.startX, cfg.startY);
  const latency = cfg.latencyMs;
  const client: ClientModel = new ClientModel((input, seq, epoch, sentAt) => {
    // client → server transport
    q.push(sentAt + latency, (at) => {
      const res = server.enqueueMove(input, seq);
      if (res === 'ok') {
        // enqueue txn writes character+player in one batch (movement.rs:127-129,
        // guards.rs:93-94) → one client reconcile on arrival.
        const snap = server.snapshot();
        q.push(at + latency, (a2) => client.onRowUpdate(snap, a2));
      } else {
        // Err rolls the txn back; the promise rejects → main.ts:481-504 .catch.
        q.push(at + latency, (a2) => {
          client.rejections.push({ seq, reason: res, atMs: a2 });
          if (client.predictor.dropRejected(seq, epoch)) client.reconcileFromStore(a2);
        });
      }
    });
  });
  // bootstrap: initial row snapshot arrives at t=0 (login) → seeding reconcile
  const initialSnap = server.snapshot();
  q.push(0, (at) => client.onRowUpdate(initialSnap, at));
  // rAF frames
  const framePeriod = 1000 / cfg.fps;
  for (let t = cfg.framePhaseMs ?? 0; t <= untilMs; t += framePeriod) {
    q.push(t, (at) => client.frame(at));
  }
  // server ticks: every STEP_MS from tickPhase
  for (let t = cfg.tickPhaseMs; t <= untilMs; t += STEP_MS) {
    q.push(t, (at) => {
      if (server.tick(at)) {
        const snap = server.snapshot();
        q.push(at + latency, (a2) => client.onRowUpdate(snap, a2));
      }
    });
  }
  // scripted keys
  for (const k of keys) {
    q.push(k.downAtMs, (at) => client.keydown(k.dir, at));
    q.push(k.upAtMs, () => client.keyup(k.dir));
  }
  q.run(untilMs);
  return { server, client };
}

// --- Drew's exact repro: walk-to-west-edge, pause, single EAST tap ---------------
// Start at x=3. Hold West long enough to reach x=1 (the edge; further West bumps).
// Release, pause well past all settling. Then a single East tap of duration tapMs.
function drewRepro(
  fps: number,
  tickPhaseMs: number,
  latencyMs: number,
  tapMs: number,
): { tilesMoved: number; eastEmissions: number; r: SimResult } {
  const tapDown = 2000; // long after the walk phase fully settles
  const r = runSim(
    { fps, tickPhaseMs, latencyMs, startX: 3, startY: 5 },
    [
      { dir: 'West', downAtMs: 100, upAtMs: 900 }, // walk to the edge (incl. bumps)
      { dir: 'East', downAtMs: tapDown, upAtMs: tapDown + tapMs }, // the single tap
    ],
    tapDown + 1500, // run long enough for everything after the tap to settle
  );
  const tilesMoved = r.server.row.x - 1; // edge is x=1; expected: exactly +1 → x=2
  const eastEmissions = r.client.emissions.filter((e) => e.dir === 'East').length;
  return { tilesMoved, eastEmissions, r };
}

describe('[DIAG-mvinv] Drew repro: walk-to-edge, pause, single East tap', () => {
  it('sanity: the walk phase reaches the west edge and settles', () => {
    const { r } = drewRepro(60, 0, 1, 80);
    expect(r.server.row.x).toBeGreaterThanOrEqual(2); // moved east off the edge after tap
    // the West walk reached x=1 before the tap: every West drain after reaching edge bumps
    const westDrains = r.server.acceptedDrains.filter((d) => d.dir === 'West');
    expect(westDrains.length).toBeGreaterThanOrEqual(2);
  });

  it('MATRIX: tiles moved by (fps × tickPhase × tapMs) at 1ms latency', () => {
    const rows: string[] = [];
    const twoCells: { fps: number; phase: number; tap: number }[] = [];
    for (const fps of [30, 60, 144]) {
      for (const tap of [40, 60, 80, 100, 120, 150, 180]) {
        let line = `fps=${String(fps).padStart(3)} tap=${String(tap).padStart(3)}: `;
        for (let phase = 0; phase < STEP_MS; phase += 20) {
          const { tilesMoved } = drewRepro(fps, phase, 1, tap);
          line += String(tilesMoved);
          if (tilesMoved >= 2) twoCells.push({ fps, phase, tap });
        }
        rows.push(line);
      }
    }
    console.log(`[DIAG-mvinv] tiles moved per cell (phase 0..180 step 20):\n${rows.join('\n')}`);
    console.log(`[DIAG-mvinv] cells with >=2 tiles: ${twoCells.length}`);
    // THE SYMPTOM (red-capable): a single tap must move exactly ONE tile in every cell.
    expect(twoCells.length).toBe(0);
  });

  it('PROBE: attribution in a red cell vs a green cell (emission sources + server drains)', () => {
    for (const phase of [60, 160]) {
      const { tilesMoved, r } = drewRepro(60, phase, 1, 100);
      const east = r.client.emissions.filter((e) => e.dir === 'East');
      const eastDrains = r.server.acceptedDrains.filter((d) => d.dir === 'East');
      console.log(
        `[DIAG-mvinv] phase=${phase} tiles=${tilesMoved} ` +
          `emissions=${JSON.stringify(east)} ` +
          `drains=${JSON.stringify(eastDrains)} rejects=${JSON.stringify(r.client.rejections)}`,
      );
      // server never double-drains one op: drains == emissions accepted
      expect(eastDrains.length).toBe(east.length);
    }
  });

  it('control: same tap NOT at an edge (mid-map, no prior walk) — is the edge load-bearing?', () => {
    let twoCount = 0;
    for (const tap of [60, 100, 150]) {
      for (let phase = 0; phase < STEP_MS; phase += 20) {
        const r = runSim(
          { fps: 60, tickPhaseMs: phase, latencyMs: 1, startX: 5, startY: 5 },
          [{ dir: 'East', downAtMs: 500, upAtMs: 500 + tap }],
          2000,
        );
        if (r.server.row.x - 5 >= 2) twoCount++;
      }
    }
    console.log(`[DIAG-mvinv] mid-map control: ${twoCount} cells with >=2 tiles (of 30)`);
    // If this also reds, the edge is NOT load-bearing — the defect is pause-then-tap.
    expect(twoCount).toBe(0);
  });
});
