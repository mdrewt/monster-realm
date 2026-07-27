// movementSim.test.ts — [mvi] the GATING deterministic simulation of the full client↔server
// movement pipeline. Promoted from movementSim.diag.test.ts (the committed diagnostic that
// reproduced Drew's r2 defect deterministically); every console.log probe in that file is now
// an assertion.
//
// THE DEFECT (r2, ledger 003/015/029/040-042): a single tap sometimes moves TWO tiles. Root
// cause is CLIENT-side: the held-key continuation re-issue (rAF frame body + the reconcile
// divergence site) fires on the first frame after the server's movement_tick drain is observed
// while the key is still down. The tick phase is uniform in [0, 200)ms, so inside a 50-150ms
// tap it is a coin flip. THE FIX is a hold-commit threshold: a held dir only becomes eligible
// for CONTINUATION after it has been held for HOLD_COMMIT_MS; the keydown FIRST step stays
// ungated.
//
// REAL units under test (imported, never re-implemented): Predictor (prediction core),
// HeldDirections + committedActive + reissueDir (held-key policy), characterToPredictedBaseline
// (ADR-0012 rebase).
//
// MODELED line-by-line — citations are the POST-FIX main.ts wiring this slice lands:
//   keydown movement branch (main.ts:1093-1099):
//       step(dir);                          // immediate first step — UNGATED
//       held.press(dir, performance.now()); // the press carries its own timestamp
//   keyup (main.ts:1107-1110): held.release(dir);
//   sendIntent (main.ts:470-505) — conn always live here, no overlays;
//   reconcile batch listener + divergence re-issue (main.ts:366-455), whose emitter is
//       if (diverged && predictor.outstandingSteps === 0 && !(…overlays…)) {
//         const heldDir = reissueDir(held.committedActive(now), predictor.lastQueuedDir);
//   rAF frame body (main.ts:2101-2139): drain FIRST (nh2 R1, ADR-0148), then the SAME emitter
//       if (predictor.outstandingSteps === 0 && !(…overlays…)) { … committedActive(now) … }
// Server reducers: guards.rs authorize_move (:66-96), movement.rs enqueue_move (:120-130) and
// the movement_tick drain arm (:184-237).
//
// WHY a model and not the real thing: main.ts is not importable under vitest (module-scope
// DOM/PIXI/wasm side effects) and the server is Rust. The SOURCE-LEVEL proof that main.ts
// really carries the shape above is main.wiring.test.ts (the W-MVI-* teeth); THIS file proves
// the shape is behaviourally correct.
//
// RED REASON at authoring time: heldKeys.ts exports no `HOLD_COMMIT_MS` and HeldDirections has
// no `committedActive` / no timestamped `press` — the import and the construction below fail.
//
// Determinism: one virtual clock, one event queue ordered by (time, insertion-seq). No wall
// clock, no RNG, no timers, no `new RegExp` (Semgrep ban).
import { describe, expect, it } from 'vitest';
import type { WasmCharacterState, WasmDirection, WasmMoveInput } from '../convert/convert';
import { characterToPredictedBaseline, type SdkCharacterFields } from '../convert/convert';
import { HeldDirections, HOLD_COMMIT_MS, reissueDir } from './heldKeys';
import { type ApplyMove, Predictor, type PredictorEpoch } from './predictor';

const STEP_MS = 200; // game-core world.rs:13
const QUEUE_CAP = 2; // game-core world.rs:16 MOVE_QUEUE_CAP (main.ts:138 move_queue_cap())

/** Floating-point slop for a comparison of two exact tick-grid timestamps. */
const EPS = 1e-6;

/** Per-test budget for the parameter grids (they measure in the low hundreds of ms locally).
 *  Headroom for a loaded CI box so a slow machine cannot turn a passing gate into a spurious
 *  red — NOT a licence to grow the grids past the sweep the spec measured. */
const GRID_TIMEOUT_MS = 20_000;

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
// SORTED-INSERT queue (binary search on `at`, shift() pop). The diag file used an O(n)
// best-of scan per pop, which is far too slow for the grids below (~2500 sims).
// Correctness of the binary insert: `seq` is minted monotonically, so a NEW event always
// sorts AFTER every already-queued event with the same `at` — inserting it past the last
// entry with `at <= newAt` reproduces the (time, insertion-seq) total order exactly.
interface SimEvent {
  at: number;
  seq: number;
  fn: (at: number) => void;
}
class EventQueue {
  #events: SimEvent[] = [];
  #insertSeq = 0;
  push(at: number, fn: (at: number) => void): void {
    const ev: SimEvent = { at, seq: this.#insertSeq++, fn };
    let lo = 0;
    let hi = this.#events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.#events[mid] as SimEvent).at <= at) lo = mid + 1;
      else hi = mid;
    }
    if (lo === this.#events.length) this.#events.push(ev);
    else this.#events.splice(lo, 0, ev);
  }
  /** Run all events with at <= untilMs in (at, insertion-seq) order. */
  run(untilMs: number): void {
    for (;;) {
      const head = this.#events[0];
      if (head === undefined || head.at > untilMs) return;
      this.#events.shift();
      head.fn(head.at);
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
  /** Every intent the server ACCEPTED, stamped with its SERVER-ARRIVAL time. The step-2
   *  cadence slack metric (S4/S5) is measured against this: it is the moment the second
   *  move became eligible for the next movement_tick. */
  readonly acceptedEnqueues: { seq: number; atMs: number }[] = [];
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
  enqueueMove(input: WasmMoveInput, seq: number, atMs: number): 'ok' | 'stale seq' | 'queue full' {
    if (seq <= this.row.lastInputSeq) return 'stale seq';
    if (this.row.moveQueue.length >= QUEUE_CAP) return 'queue full'; // txn rollback: no ack
    this.row.lastInputSeq = seq;
    this.row.moveQueue.push(input);
    this.acceptedEnqueues.push({ seq, atMs });
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
type Send = (input: WasmMoveInput, seq: number, epoch: PredictorEpoch, at: number) => void;

class ClientModel {
  readonly predictor: Predictor;
  readonly held: HeldDirections;
  lastRow: ServerRow | undefined;
  readonly emissions: Emission[] = [];
  readonly rejections: { seq: number; reason: string; atMs: number }[] = [];
  /** OBSERVATION ONLY (no behaviour): every reconcile's (diverged, outstandingSteps) pair, so
   *  the S9 divergence teeth can prove their PRECONDITION was actually reached instead of
   *  passing because the divergence site is simply unreachable. */
  readonly reconciles: { atMs: number; diverged: boolean; outstanding: number }[] = [];
  #send: Send;
  #source: Emission['source'] = 'keydown';
  constructor(holdCommitMs: number | undefined, send: Send) {
    this.predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    this.held = new HeldDirections(holdCommitMs);
    this.#send = send;
  }
  /** main.ts sendIntent (:470-505), conn always live, no overlays. */
  sendIntent(input: WasmMoveInput, at: number): void {
    const intent = this.predictor.enqueue(input);
    if (intent === undefined) return; // declined: predict & send nothing
    this.emissions.push({
      seq: intent.seq,
      dir: input === 'Jump' ? 'Jump' : input.Step,
      atMs: at,
      source: this.#source,
    });
    this.#send(input, intent.seq, intent.epoch, at);
  }
  /** main.ts keydown movement branch (:1093-1099) — POST-FIX: the first step is UNGATED and
   *  the press carries its own timestamp (`held.press(dir, performance.now())`). */
  keydown(dir: WasmDirection, at: number): void {
    this.#source = 'keydown';
    this.sendIntent({ Step: dir }, at); // immediate first step
    this.held.press(dir, at);
  }
  /** main.ts keyup (:1107-1110). */
  keyup(dir: WasmDirection): void {
    this.held.release(dir);
  }
  /** store batch listener → reconcileFromStore (main.ts:366-455), no overlays. */
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
    this.reconciles.push({ atMs: at, diverged, outstanding: this.predictor.outstandingSteps });
    // main.ts:429-451 divergence re-issue — nh2 gate + the mvi hold-commit gate.
    if (diverged && this.predictor.outstandingSteps === 0) {
      const heldDir = reissueDir(this.held.committedActive(at), this.predictor.lastQueuedDir);
      if (heldDir !== undefined) {
        this.#source = 'divergence';
        this.sendIntent({ Step: heldDir }, at);
      }
    }
  }
  /** rAF frame body (main.ts:2101-2139): drain FIRST (nh2 R1), then the gated re-issue. */
  frame(at: number): void {
    this.predictor.drain(at);
    if (this.predictor.outstandingSteps === 0) {
      const heldDir = reissueDir(this.held.committedActive(at), this.predictor.lastQueuedDir);
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
  /** undefined ⇒ construct HeldDirections ARGLESS, i.e. exercise the shipped default. */
  holdCommitMs?: number;
}

/** Scripted stimuli. `serverNudge` models an AUTHORITATIVE REPOSITION (a server-side write the
 *  client did not predict — warp nudge, admin move, a physics correction): it mutates the
 *  server row directly and publishes a snapshot, which is the only way to make reconcile
 *  return diverged=true while the server owes nothing (see the S9 teeth). */
type ScriptEvent =
  | { kind: 'keydown'; atMs: number; dir: WasmDirection }
  | { kind: 'keyup'; atMs: number; dir: WasmDirection }
  | { kind: 'serverNudge'; atMs: number; dx: number }
  | { kind: 'probeServerX'; atMs: number };

function hold(dir: WasmDirection, downAtMs: number, upAtMs: number): ScriptEvent[] {
  return [
    { kind: 'keydown', atMs: downAtMs, dir },
    { kind: 'keyup', atMs: upAtMs, dir },
  ];
}

interface SimResult {
  server: ServerModel;
  client: ClientModel;
  probes: { atMs: number; x: number }[];
}

function runSim(cfg: SimConfig, script: readonly ScriptEvent[], untilMs: number): SimResult {
  const q = new EventQueue();
  const server = new ServerModel(cfg.startX, cfg.startY);
  const probes: { atMs: number; x: number }[] = [];
  const latency = cfg.latencyMs;
  const client = new ClientModel(cfg.holdCommitMs, (input, seq, epoch, sentAt) => {
    // client → server transport
    q.push(sentAt + latency, (at) => {
      const res = server.enqueueMove(input, seq, at);
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
  // rAF frames — computed by MULTIPLICATION (never `t += period`) so the grid is exact.
  const framePeriod = 1000 / cfg.fps;
  const framePhase = cfg.framePhaseMs ?? 0;
  for (let n = 0; ; n++) {
    const t = framePhase + n * framePeriod;
    if (t > untilMs) break;
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
  // scripted stimuli
  for (const ev of script) {
    switch (ev.kind) {
      case 'keydown':
        q.push(ev.atMs, (at) => client.keydown(ev.dir, at));
        break;
      case 'keyup':
        q.push(ev.atMs, () => client.keyup(ev.dir));
        break;
      case 'serverNudge':
        q.push(ev.atMs, (at) => {
          server.row.x += ev.dx;
          const snap = server.snapshot();
          q.push(at + latency, (a2) => client.onRowUpdate(snap, a2));
        });
        break;
      case 'probeServerX':
        q.push(ev.atMs, (at) => probes.push({ atMs: at, x: server.row.x }));
        break;
    }
  }
  q.run(untilMs);
  return { server, client, probes };
}

// --- metrics ---------------------------------------------------------------------
/** Times of the drains where the character ACTUALLY changed tile (a wall bump drains the
 *  queue slot but moves nobody, so it must not count as a walked tile). */
function movedDrainTimes(r: SimResult, dir?: string): number[] {
  return r.server.acceptedDrains
    .filter((d) => d.moved && (dir === undefined || d.dir === dir))
    .map((d) => d.atMs);
}

interface Cadence {
  /** Count of consecutive moved-drain gaps that are NOT exactly one STEP_MS slot. */
  missedSlots: number;
  maxGap: number;
  /** drain1 + STEP_MS − (server-arrival of the SECOND accepted enqueue). Positive = the
   *  continuation reached the server with room to spare before the tick that owes it;
   *  negative = the walk visibly stutters for a whole 200ms slot. undefined = not enough
   *  traffic to measure (the caller must treat that as a hard failure, not a pass). */
  step2SlackMs: number | undefined;
}
function cadenceOf(r: SimResult): Cadence {
  const drains = movedDrainTimes(r);
  let missedSlots = 0;
  let maxGap = 0;
  for (let i = 1; i < drains.length; i++) {
    const gap = (drains[i] as number) - (drains[i - 1] as number);
    if (gap > maxGap) maxGap = gap;
    if (Math.abs(gap - STEP_MS) > EPS) missedSlots += 1;
  }
  const enq = r.server.acceptedEnqueues;
  const step2SlackMs =
    drains.length >= 1 && enq.length >= 2
      ? (drains[0] as number) + STEP_MS - (enq[1] as { atMs: number }).atMs
      : undefined;
  return { missedSlots, maxGap, step2SlackMs };
}

// ================================================================================
// S0 — sanity (inherited from the diagnostic): the west-edge walk actually happens
// ================================================================================

describe('[mvi] S0 sanity: the modeled pipeline really walks and really hits the wall', () => {
  it('sanity: the West walk reaches the west edge (x=1) and the following East tap moves off it', () => {
    // Anti-vacuity for EVERY tooth below that starts from Drew's literal repro: if the walk
    // phase silently did nothing (e.g. the model never enqueued), the tap matrix would be
    // measuring an idle character and would pass for the wrong reason.
    const r = runSim(
      { fps: 60, tickPhaseMs: 0, latencyMs: 1, startX: 3, startY: 5 },
      [
        ...hold('West', 100, 900),
        { kind: 'probeServerX', atMs: 1900 },
        ...hold('East', 2000, 2080),
      ],
      3500,
    );
    expect(r.probes[0]?.x, 'the West walk must come to rest ON the west edge (x=1)').toBe(1);
    expect(r.server.row.x, 'the East tap must move exactly one tile off the edge').toBe(2);
    // Reaching the edge means at least two West drains bumped (moved=false) against the wall.
    const westBumps = r.server.acceptedDrains.filter((d) => d.dir === 'West' && !d.moved);
    expect(
      westBumps.length,
      'the walk must have pressed into the wall (bumped drains)',
    ).toBeGreaterThanOrEqual(1);
  });
});

// ================================================================================
// S1 — THE REGRESSION for Drew's r2 defect: a tap moves exactly ONE tile
// ================================================================================

interface TapScenario {
  readonly label: string;
  readonly startX: number;
  readonly prior: readonly ScriptEvent[];
  readonly tapDownMs: number;
  readonly untilMs: number;
}

/** The three shapes Drew's report and the sweep cover. (a) is his literal sequence; (b) is the
 *  edge-free control that proves the wall is not load-bearing; (c) is the same-dir RE-TAP,
 *  which is the shape a stale-press-timestamp implementation gets wrong (a red-team PoC of a
 *  parallel `Map<dir, pressedAt>` that forgets to evict on release doubles HERE and nowhere
 *  else, because only here is the same dir pressed twice in one session). */
const TAP_SCENARIOS: readonly TapScenario[] = [
  {
    label: 'a: Drew literal — walk to the west edge, pause, single East tap',
    startX: 3,
    prior: hold('West', 100, 900),
    tapDownMs: 2000,
    untilMs: 3500,
  },
  {
    label: 'b: mid-map fresh dir — idle at x=5, single East tap (no wall, no prior walk)',
    startX: 5,
    prior: [],
    tapDownMs: 500,
    untilMs: 2000,
  },
  {
    label: 'c: same-dir re-tap — walk East 1.5s, release, pause 1s, single East tap',
    startX: 5,
    prior: hold('East', 500, 2000),
    tapDownMs: 3000,
    untilMs: 4500,
  },
];

interface TapOutcome {
  tilesMovedByTap: number;
  postTapEmissions: number;
  postTapMovedDrains: number;
  postTapRejections: number;
}
function runTap(
  sc: TapScenario,
  fps: number,
  tickPhaseMs: number,
  tapMs: number,
  holdCommitMs?: number,
): TapOutcome {
  const t = sc.tapDownMs;
  const r = runSim(
    { fps, tickPhaseMs, latencyMs: 1, startX: sc.startX, startY: 5, holdCommitMs },
    [
      ...sc.prior,
      { kind: 'probeServerX', atMs: t - 100 }, // fully settled: every scenario pauses >= 1s
      ...hold('East', t, t + tapMs),
    ],
    sc.untilMs,
  );
  const preTapX = r.probes[0]?.x ?? Number.NaN;
  return {
    tilesMovedByTap: r.server.row.x - preTapX,
    postTapEmissions: r.client.emissions.filter((e) => e.atMs >= t).length,
    postTapMovedDrains: r.server.acceptedDrains.filter((d) => d.atMs >= t && d.moved).length,
    postTapRejections: r.client.rejections.filter((x) => x.atMs >= t).length,
  };
}

describe('[mvi] S1 tap matrix: one tap == one tile, in EVERY (scenario × fps × tickPhase × tap) cell', () => {
  it(
    'S1 BITES: taps <= 140ms move exactly ONE tile and emit exactly ONE accepted intent',
    () => {
      // THE tooth for Drew's defect. RED on the pre-fix wiring (`reissueDir(held.active(), …)`):
      // the diagnostic measured >=2 tiles in a large fraction of the (fps × tickPhase) cells,
      // because the continuation re-issue fires on the first frame after the drain snapshot
      // lands — which, for a tick phase uniform in [0,200), happens INSIDE a 50-150ms tap about
      // half the time.
      //
      // WRONG IMPL KILLED (1): no hold-commit gate at all (today's code) — the double-move.
      // WRONG IMPL KILLED (2): a threshold set too LOW (anything < ~140ms) — the 140ms column
      //   here is the tap-coverage floor and reds first.
      // WRONG IMPL KILLED (3): a stale press timestamp (scenario c) — see TAP_SCENARIOS.
      // WRONG IMPL KILLED (4): "fixing" this server-side. `postTapMovedDrains ===
      //   postTapEmissions` and `postTapRejections === 0` pin the server INNOCENT: it drains
      //   exactly what the client sent, no more, and it never had to reject anything. Any
      //   future attempt to de-duplicate in the reducer would break this equality, not satisfy
      //   it. (EARS E1: the server SHALL move exactly one tile per accepted intent.)
      //
      // Latency is the diagnostic's 1ms: the defect is a CLIENT phase race, and adding latency
      // only shifts which tick phase is guilty — the tickPhase sweep already covers all of them.
      const bad: string[] = [];
      for (const sc of TAP_SCENARIOS) {
        for (const fps of [30, 60, 144]) {
          for (const tapMs of [40, 80, 120, 140]) {
            for (let phase = 0; phase < STEP_MS; phase += 20) {
              const o = runTap(sc, fps, phase, tapMs);
              if (
                o.tilesMovedByTap !== 1 ||
                o.postTapEmissions !== 1 ||
                o.postTapMovedDrains !== o.postTapEmissions ||
                o.postTapRejections !== 0
              ) {
                bad.push(
                  `${sc.label} | fps=${fps} phase=${phase} tap=${tapMs} → ` +
                    `tiles=${o.tilesMovedByTap} emissions=${o.postTapEmissions} ` +
                    `movedDrains=${o.postTapMovedDrains} rejections=${o.postTapRejections}`,
                );
              }
            }
          }
        }
      }
      expect(
        bad.length,
        `a single tap (<= 140ms) MUST move exactly one tile, emit exactly one accepted intent, ` +
          `drain exactly that one intent server-side, and cause no rejection — in every cell. ` +
          `Offending cells (first 8 of ${bad.length}):\n${bad.slice(0, 8).join('\n')}`,
      ).toBe(0);
    },
    GRID_TIMEOUT_MS,
  );

  it(
    'S1-twin ANTI-VACUITY: the SAME matrix with holdCommitMs=0 does detect double-moves',
    () => {
      // Proves the matrix above is capable of going red. holdCommitMs=0 is exactly the pre-fix
      // behaviour (`committedActive` degenerates to `active`), so this reproduces the defect and
      // asserts the harness SEES it. Without this twin, a matrix that (say) mis-measured
      // `tilesMovedByTap` as always 1 would look like a passing gate.
      let doubles = 0;
      const sc = TAP_SCENARIOS[1] as TapScenario; // (b) mid-map: the cleanest signal
      for (const fps of [30, 60, 144]) {
        for (const tapMs of [40, 80, 120, 140]) {
          for (let phase = 0; phase < STEP_MS; phase += 20) {
            if (runTap(sc, fps, phase, tapMs, 0).tilesMovedByTap >= 2) doubles += 1;
          }
        }
      }
      expect(
        doubles,
        'with the hold-commit threshold disabled the tap matrix MUST observe double-moves — if ' +
          'it observes none, the matrix cannot detect the defect it is supposed to gate and ' +
          'S1 above is vacuous',
      ).toBeGreaterThan(0);
    },
    GRID_TIMEOUT_MS,
  );
});

// ================================================================================
// S4/S5 — sustained-walk cadence: the threshold must not cost a walk slot
// ================================================================================

/** One sustained-hold cell: idle at x=5, hold East 500 → 2500ms. */
function runHoldCell(opts: {
  fps: number;
  framePhaseFrac: number;
  tickPhaseMs: number;
  latencyMs: number;
  holdCommitMs?: number;
  holdFromMs?: number;
  holdToMs?: number;
  untilMs?: number;
}): SimResult {
  const from = opts.holdFromMs ?? 500;
  const to = opts.holdToMs ?? 2500;
  return runSim(
    {
      fps: opts.fps,
      tickPhaseMs: opts.tickPhaseMs,
      latencyMs: opts.latencyMs,
      framePhaseMs: opts.framePhaseFrac * (1000 / opts.fps),
      startX: 5,
      startY: 5,
      holdCommitMs: opts.holdCommitMs,
    },
    hold('East', from, to),
    opts.untilMs ?? to + 500,
  );
}

describe('[mvi] S4 sustained-walk cadence: HOLD_COMMIT_MS never costs a movement_tick slot', () => {
  it(
    'S4 BITES: zero missed slots AND step-2 slack >= 10ms over the fps × framePhase × tickPhase × latency grid',
    () => {
      // The OTHER side of the tap fix: a threshold large enough to cover a tap must still be
      // small enough that a DELIBERATE walk starts on cadence. The budget is
      //   HOLD_COMMIT_MS + one frame at the worst supported fps + one-way jitter
      //   = 150 + 1000/30 + 1 = 184.3 < STEP_MS(200)
      // and the empirical margin is the `step2SlackMs` metric: how much room the SECOND move
      // had before the tick that owes it. Measured minimum over this grid at 150: 22.9ms
      // (cell: fps=24, framePhase=0.37, tickPhase=130, latency=25).
      //
      // WRONG IMPL KILLED (1): a threshold pushed up "to be safe" (>= ~165ms at 24fps) —
      // the walk visibly stutters one 200ms slot on start. S5 below is the positive control
      // that proves this metric really reds when that happens.
      // WRONG IMPL KILLED (2): a gate that also blocks the CONTINUATION of an already-committed
      // hold (e.g. re-arming the window on every re-issue) — missedSlots goes non-zero
      // immediately, because every second step would wait another full threshold.
      // WRONG IMPL KILLED (3): a threshold applied to the KEYDOWN first step — the first drain
      // slips and the whole train shifts; caught here and by W-MVI-KEYDOWN-UNGATED.
      let worstSlack = Number.POSITIVE_INFINITY;
      let worstCell = '';
      let measured = 0;
      const missed: string[] = [];
      for (const fps of [24, 30, 60, 144]) {
        for (const frac of [0, 0.37, 0.61, 0.83]) {
          for (let phase = 0; phase < STEP_MS; phase += 10) {
            for (const latencyMs of [0, 1, 25]) {
              const cell = `fps=${fps} frac=${frac} tickPhase=${phase} L=${latencyMs}`;
              const c = cadenceOf(
                runHoldCell({ fps, framePhaseFrac: frac, tickPhaseMs: phase, latencyMs }),
              );
              if (c.missedSlots !== 0) missed.push(`${cell} → maxGap=${c.maxGap}`);
              if (c.step2SlackMs === undefined) {
                missed.push(`${cell} → the hold produced fewer than 2 accepted enqueues`);
                continue;
              }
              measured += 1;
              if (c.step2SlackMs < worstSlack) {
                worstSlack = c.step2SlackMs;
                worstCell = cell;
              }
            }
          }
        }
      }
      expect(measured, 'the cadence grid must have measured at least one cell').toBeGreaterThan(0);
      expect(
        missed.length,
        'a sustained hold must drain on EVERY movement_tick slot (all consecutive moved-drain ' +
          `gaps exactly ${STEP_MS}ms). Offending cells (first 8 of ${missed.length}):\n` +
          missed.slice(0, 8).join('\n'),
      ).toBe(0);
      expect(
        worstSlack,
        `the second step of a held walk must reach the server at least 10ms before the tick ` +
          `that owes it, in every cell (measured minimum at HOLD_COMMIT_MS=${HOLD_COMMIT_MS}: ` +
          `22.9ms). Worst cell: ${worstCell} → ${worstSlack}ms`,
      ).toBeGreaterThanOrEqual(10);
    },
    GRID_TIMEOUT_MS,
  );

  it(
    'S5 POSITIVE CONTROL: the SAME slack metric goes negative at holdCommitMs=175 (proof the S4 tooth has teeth)',
    () => {
      // Without this, S4's `>= 10` could be an assertion nothing can ever violate. Raising the
      // threshold by 25ms on a targeted grid (fps=30, framePhase k/12 of the frame period,
      // tickPhase step 5, latency 25) drives the slack NEGATIVE — measured -0.6ms with a
      // realized missed slot at frac=2/12, tickPhase=130 (the second move arrives 0.6ms after
      // the tick that would have drained it, so the walk stutters one whole 200ms slot).
      let worstSlack = Number.POSITIVE_INFINITY;
      let cellsWithMissedSlot = 0;
      let measured = 0;
      for (let k = 0; k < 12; k++) {
        for (let phase = 0; phase < STEP_MS; phase += 5) {
          const c = cadenceOf(
            runHoldCell({
              fps: 30,
              framePhaseFrac: k / 12,
              tickPhaseMs: phase,
              latencyMs: 25,
              holdCommitMs: 175,
            }),
          );
          if (c.missedSlots > 0) cellsWithMissedSlot += 1;
          if (c.step2SlackMs !== undefined) {
            measured += 1;
            worstSlack = Math.min(worstSlack, c.step2SlackMs);
          }
        }
      }
      expect(
        measured,
        'the positive-control grid must have measured at least one cell',
      ).toBeGreaterThan(0);
      expect(
        worstSlack,
        'holdCommitMs=175 MUST produce a step-2 slack below the 10ms floor S4 asserts — if it ' +
          'does not, S4 is not measuring what it claims and its `>= 10` cannot fail',
      ).toBeLessThan(10);
      expect(
        cellsWithMissedSlot,
        'holdCommitMs=175 MUST realize at least one actually-missed movement_tick slot on this ' +
          "grid — the slack metric and the missed-slot metric must agree about what 'too late' " +
          'means',
      ).toBeGreaterThan(0);
    },
    GRID_TIMEOUT_MS,
  );
});

// ================================================================================
// S6 — a DELIBERATE hold still walks (the threshold is a tap filter, not a mute)
// ================================================================================

describe('[mvi] S6 deliberate holds still walk: a 260ms press moves >= 2 tiles in every cell', () => {
  it('S6 BITES: press-and-hold for 260ms walks at least two tiles at every fps and tick phase', () => {
    // The opposite failure of S1: an over-eager fix that never continues at all. 260ms is the
    // measured "definitely a walk" boundary (>= 240ms always walks; 260 leaves margin).
    //
    // WRONG IMPL KILLED (1): `committedActive` that always returns undefined (the trivial way
    // to make S1 green) — continuous movement would be dead and only S6/S4 catch it.
    // WRONG IMPL KILLED (2): a threshold raised into the 200ms+ range to "be safe" — a
    // 260ms press would then produce at most one continuation late or none at all.
    // WRONG IMPL KILLED (3): a `>` instead of `>=` comparison combined with an exactly-aligned
    // frame — bounded by U-H1's boundary table in heldKeys.test.ts, cross-checked here.
    const bad: string[] = [];
    for (const fps of [30, 60, 144]) {
      for (let phase = 0; phase < STEP_MS; phase += 20) {
        const r = runSim(
          { fps, tickPhaseMs: phase, latencyMs: 1, startX: 5, startY: 5 },
          hold('East', 500, 760),
          2000,
        );
        const tiles = r.server.row.x - 5;
        if (tiles < 2) bad.push(`fps=${fps} phase=${phase} → tiles=${tiles}`);
      }
    }
    expect(
      bad.length,
      'a 260ms press is a DELIBERATE walk and must move at least 2 tiles in every cell — ' +
        `offending cells:\n${bad.slice(0, 8).join('\n')}`,
    ).toBe(0);
  });
});

// ================================================================================
// S7 — nh2 (ADR-0148) no-regress: long holds keep their cadence and their throughput
// ================================================================================

describe('[mvi] S7 nh2 no-regress: a 3s hold keeps perfect cadence and the same tile throughput', () => {
  it('S7 BITES: 3000ms hold at (60fps, L=25) and (30fps, L=90) — all gaps == 200 and the drain count matches a threshold-free run', () => {
    // ADR-0148 bought a bounded, one-step-in-flight pipeline. The mvi threshold must not
    // spend that budget: over a long hold the character must still drain on every slot AND
    // cover the same number of tiles as it would with the threshold disabled (± the single
    // slot the very first continuation may cost).
    //
    // WRONG IMPL KILLED (1): a threshold re-armed per continuation (see S4 note) — the drain
    // count roughly halves against the holdCommitMs=0 reference and the ±1 window reds.
    // WRONG IMPL KILLED (2): a gate that leaks and emits TWICE per slot — the reference
    // comparison catches a count that runs AHEAD as well as behind.
    const cells = [
      { fps: 60, latencyMs: 25 },
      { fps: 30, latencyMs: 90 },
    ];
    for (const cell of cells) {
      const shipped = runHoldCell({
        fps: cell.fps,
        framePhaseFrac: 0,
        tickPhaseMs: 0,
        latencyMs: cell.latencyMs,
        holdFromMs: 500,
        holdToMs: 3500,
        untilMs: 4200,
      });
      const reference = runHoldCell({
        fps: cell.fps,
        framePhaseFrac: 0,
        tickPhaseMs: 0,
        latencyMs: cell.latencyMs,
        holdCommitMs: 0,
        holdFromMs: 500,
        holdToMs: 3500,
        untilMs: 4200,
      });
      const c = cadenceOf(shipped);
      const label = `fps=${cell.fps} L=${cell.latencyMs}`;
      expect(
        movedDrainTimes(shipped).length,
        `${label}: a 3s hold must produce a long walk (anti-vacuity)`,
      ).toBeGreaterThanOrEqual(10);
      expect(
        c.missedSlots,
        `${label}: every consecutive moved-drain gap over a 3s hold must be exactly ${STEP_MS}ms ` +
          `(observed maxGap ${c.maxGap}ms)`,
      ).toBe(0);
      const shippedTiles = movedDrainTimes(shipped).length;
      const referenceTiles = movedDrainTimes(reference).length;
      expect(
        Math.abs(shippedTiles - referenceTiles),
        `${label}: throughput over a 3s hold must match a holdCommitMs=0 run within one slot ` +
          `(shipped ${shippedTiles} tiles vs reference ${referenceTiles})`,
      ).toBeLessThanOrEqual(1);
    }
  });
});

// ================================================================================
// S8 / S8b — two-key semantics: fallback keeps the ORIGINAL stamp; switch re-arms
// ================================================================================

describe('[mvi] S8 two-key fallback: releasing the newer key resumes the older one on its ORIGINAL stamp', () => {
  it('S8 BITES: hold East, tap North mid-walk, release North — the walk never loses a slot', () => {
    // The stamp lives IN the stack entry, so falling back to a still-held key must NOT open a
    // fresh commit window: East has been held since 500ms and is already committed; when
    // North is released the very next open frame must re-issue East.
    //
    // WRONG IMPL KILLED: any `activeSince`-style scalar (or a map re-stamped when the stack
    // top changes) that restarts the 150ms window at the moment of the FALLBACK. In the
    // (30fps, L=90) cell the post-drain slack is only ~10ms, so a fresh 150ms window pushes
    // the re-issue past the next tick and the gap becomes 400ms. That cell is the biting one;
    // (60fps, L=25) has ~150ms of spare slack and is included as a low-latency SANITY cell
    // that this mutant survives — it is NOT claimed as a kill.
    // The precise, parameter-free kill for the same mutant is U-H4 in heldKeys.test.ts.
    const cells = [
      { fps: 30, latencyMs: 90 }, // THE BITING CELL (post-drain slack ~10ms)
      { fps: 60, latencyMs: 25 }, // sanity cell only — the mutant survives here
    ];
    for (const cell of cells) {
      const r = runSim(
        {
          fps: cell.fps,
          tickPhaseMs: 0,
          latencyMs: cell.latencyMs,
          framePhaseMs: 0,
          startX: 5,
          startY: 8,
        },
        [...hold('East', 500, 2000), ...hold('North', 1200, 1400)],
        2600,
      );
      const label = `fps=${cell.fps} L=${cell.latencyMs}`;
      const all = movedDrainTimes(r);
      const north = movedDrainTimes(r, 'North');
      const east = movedDrainTimes(r, 'East');
      expect(
        all.length,
        `${label}: the two-key sequence must actually walk`,
      ).toBeGreaterThanOrEqual(5);
      expect(north.length, `${label}: the North tap must reach the server`).toBeGreaterThanOrEqual(
        1,
      );
      const lastNorth = north[north.length - 1] as number;
      const eastAfter = east.filter((t) => t > lastNorth);
      expect(
        eastAfter.length,
        `${label}: after North is released the still-held East must resume walking`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        (eastAfter[0] as number) - lastNorth,
        `${label}: East must resume on the VERY NEXT movement_tick slot after the last North ` +
          `drain — a fresh commit window on fallback delays it by a whole slot`,
      ).toBeLessThanOrEqual(STEP_MS + EPS);
      let maxGap = 0;
      for (let i = 1; i < all.length; i++) {
        maxGap = Math.max(maxGap, (all[i] as number) - (all[i - 1] as number));
      }
      expect(
        maxGap,
        `${label}: no gap between consecutive moved drains may exceed one ${STEP_MS}ms slot ` +
          'across the whole two-key window',
      ).toBeLessThanOrEqual(STEP_MS + EPS);
    }
  });

  it('S8b BITES: switch-while-held (North held, East pressed on top) — East takes over with no stutter and North stops', () => {
    // Pre-existing stack semantics (M8.6c, ADR-0013): continuation follows the STACK TOP only.
    // The mvi change must preserve both halves of that:
    //   - North stops being re-issued the moment East is pressed (even though North is still
    //     physically held and still committed) — this is exactly the U-H5 composition;
    //   - East, once ITS OWN window elapses, drains on a perfect 200ms cadence (measured at
    //     every tick phase).
    //
    // WRONG IMPL KILLED (1): "return any held dir that has been held >= X" — North (held far
    // longer) would keep winning and the character would keep walking North after the player
    // switched direction. Caught by the "no North drain after the first East drain" assertion.
    // WRONG IMPL KILLED (2): a switch that costs a slot (the East gap check).
    const bad: string[] = [];
    for (let phase = 0; phase < STEP_MS; phase += 20) {
      const r = runSim(
        { fps: 60, tickPhaseMs: phase, latencyMs: 1, startX: 5, startY: 12 },
        [...hold('North', 500, 2800), ...hold('East', 1300, 2800)],
        3200,
      );
      const east = movedDrainTimes(r, 'East');
      const north = movedDrainTimes(r, 'North');
      if (east.length < 2) {
        bad.push(`phase=${phase} → East took over but produced only ${east.length} drains`);
        continue;
      }
      const firstEast = east[0] as number;
      const northAfter = north.filter((t) => t > firstEast);
      if (northAfter.length !== 0) {
        bad.push(`phase=${phase} → North kept draining after East took over: ${northAfter}`);
      }
      for (let i = 1; i < east.length; i++) {
        const gap = (east[i] as number) - (east[i - 1] as number);
        if (Math.abs(gap - STEP_MS) > EPS) {
          bad.push(`phase=${phase} → East drain gap ${gap}ms (expected ${STEP_MS})`);
        }
      }
    }
    expect(
      bad.length,
      'pressing a new direction while the old one is still held must hand the walk over to the ' +
        `new one cleanly at every tick phase. Offending cells:\n${bad.slice(0, 8).join('\n')}`,
    ).toBe(0);
  });
});

// ================================================================================
// S9 — the SECOND emitter: the reconcile divergence site obeys the same gate
// ================================================================================
//
// REACHABILITY NOTE (declared, per the spec's instruction to disclose): in STEADY STATE the
// pair (diverged === true, outstandingSteps === 0) never co-occurs. Every ack snapshot makes
// reconcile report diverged=true (the authoritative row still holds the pre-drain tile while
// the rebuilt queue replays the queued step) but leaves outstandingSteps at 1, and every drain
// snapshot leaves outstandingSteps at 0 but reports diverged=false. The site is therefore only
// reachable via an AUTHORITATIVE REPOSITION the client did not predict — modelled here by the
// scripted `serverNudge`. Both teeth below assert the precondition was genuinely reached
// (`reconciles` records every pair), so neither can pass because the site was never visited.
//
// CELL CHOICE (60fps / L=1 / tickPhase=175, East pressed at t=500). The gate is open only
// between a drain snapshot landing and the next frame that emits a continuation, so the nudge
// has to be delivered INSIDE one of those windows — and, for the anti-vacuity twin, inside a
// window that is still open when the threshold is DISABLED (holdCommitMs=0 emits on the very
// first frame after the gate opens, which closes the window again). With tickPhase=175 the
// first drain is at t=575 and its snapshot lands at t=576, while the next frame is at
// t=583.33 — so a nudge arriving at t=580 is inside the open window under BOTH thresholds and
// is exactly 80ms after the press. The later window used by S9a ([976, 983.33)) is 480ms
// after the press, i.e. comfortably committed.

const S9_TICK_PHASE = 175;
function runNudge(nudgeAtMs: number, holdCommitMs?: number): SimResult {
  return runSim(
    {
      fps: 60,
      tickPhaseMs: S9_TICK_PHASE,
      latencyMs: 1,
      framePhaseMs: 0,
      startX: 5,
      startY: 5,
      holdCommitMs,
    },
    [...hold('East', 500, 1600), { kind: 'serverNudge', atMs: nudgeAtMs, dx: 2 }],
    2200,
  );
}
function reachedDivergenceSite(r: SimResult): boolean {
  return r.client.reconciles.some((x) => x.diverged && x.outstanding === 0);
}
function divergenceEmissions(r: SimResult): number {
  return r.client.emissions.filter((e) => e.source === 'divergence').length;
}

describe('[mvi] S9 divergence site: the reconcile re-issue uses the same hold-commit gate as the frame loop', () => {
  it('S9a BITES: a COMMITTED hold DOES re-issue from the divergence site (the emitter is not dead)', () => {
    // WRONG IMPL KILLED: wiring `committedActive` into the rAF loop only and leaving
    // `held.active()` (or nothing at all) at the reconcile site — half a fix. The other half
    // of that mutant is killed by S9b; together they pin BOTH emitters, and
    // W-MVI-COMMITTED-WIRED pins that main.ts really has exactly two of them.
    const r = runNudge(979); // arrives t=980: 480ms into the hold, inside an open gate window
    expect(
      reachedDivergenceSite(r),
      'PRECONDITION: the nudge must produce a reconcile with diverged=true AND ' +
        'outstandingSteps===0 — otherwise this tooth says nothing about the emitter',
    ).toBe(true);
    expect(
      divergenceEmissions(r),
      'a server reposition during a COMMITTED hold must re-commit the held direction from the ' +
        'corrected baseline (ADR-0013) — the hold-commit gate must not silence this emitter',
    ).toBeGreaterThanOrEqual(1);
  });

  it('S9b BITES: an UNCOMMITTED hold (80ms) does NOT re-issue from the divergence site', () => {
    // The divergence site is the second half of the r2 defect: a server pullback landing
    // during a tap would re-commit the tapped direction and produce the extra tile even with
    // the frame loop fixed.
    //
    // WRONG IMPL KILLED: the reconcile site still reading `held.active()` while the rAF loop
    // reads `held.committedActive(now)`.
    const r = runNudge(579);
    expect(
      reachedDivergenceSite(r),
      'PRECONDITION: the nudge must produce a reconcile with diverged=true AND ' +
        'outstandingSteps===0 — otherwise "no re-issue" is true for the wrong reason',
    ).toBe(true);
    expect(
      divergenceEmissions(r),
      'the key has been held for only 80ms when the reposition lands: the divergence site must ' +
        "NOT re-issue it (that extra step is the second source of Drew's double-move)",
    ).toBe(0);
  });

  it('S9b-twin ANTI-VACUITY: the SAME 80ms cell DOES re-issue when holdCommitMs=0', () => {
    // Proves S9b's zero is produced by the THRESHOLD and not by the site being unreachable,
    // by the nudge being inert, or by `source` never being tagged 'divergence'.
    const r = runNudge(579, 0);
    expect(reachedDivergenceSite(r), 'PRECONDITION: the divergence site must be reached').toBe(
      true,
    );
    expect(
      divergenceEmissions(r),
      'with the threshold disabled the exact same 80ms cell MUST re-issue from the divergence ' +
        'site — if it does not, S9b is vacuous',
    ).toBeGreaterThanOrEqual(1);
  });
});
