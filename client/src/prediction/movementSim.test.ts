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
// RED REASON (14r-e, ADR-0187): ClientModel.keydown now mirrors the deduped keydown
// (`if (!held.isHeld(dir)) step(dir);`), so until `HeldDirections.isHeld` exists EVERY
// scenario that presses a key throws — see the S10/S11 block at the end of this file for
// the full statement and for the one deliberate exception (S10-twin).
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
  /** [13r-f, AM4] NOT `readonly`: `rebuildPrediction` below replaces the instance, exactly as
   *  main.ts's `resetPredictionState()` does (`predictor = new Predictor(...)`). */
  predictor: Predictor;
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
  /** [14r-e, ADR-0187] Mirrors the shipped keydown `if (!held.isHeld(dir)) step(dir);`.
   *  DEFAULTS TRUE — the model tracks main.ts, and the flag exists ONLY so S10-twin can
   *  run the dedup off and prove the S10 scenario is capable of seeing the double-move. */
  readonly #dedupFirstStep: boolean;
  constructor(holdCommitMs: number | undefined, send: Send, dedupFirstStep = true) {
    this.predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    this.held = new HeldDirections(holdCommitMs);
    this.#send = send;
    this.#dedupFirstStep = dedupFirstStep;
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
  /** main.ts keydown movement branch (:1093-1099) — POST-FIX: the first step is UNGATED by
   *  hold DURATION and the press carries its own timestamp
   *  (`held.press(dir, performance.now())`), but it is DEDUPED by held STATE (ADR-0187):
   *      if (!held.isHeld(dir)) step(dir);
   *      held.press(dir, performance.now());
   *  KEY_DIR maps BOTH key codes of a direction to the same `dir` before any held logic
   *  runs, so the model's per-DIRECTION dedup is the faithful shape: a second keydown of
   *  the SAME dir (the other code) is exactly what must not emit. A pure not-emit — the
   *  press below still runs, and `press` is idempotent, so the FIRST stamp governs. */
  keydown(dir: WasmDirection, at: number): void {
    this.#source = 'keydown';
    if (!this.#dedupFirstStep || !this.held.isHeld(dir)) {
      this.sendIntent({ Step: dir }, at); // immediate first step
    }
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

  /** [13r-f, ADR-0192] The WARP arm's prediction rebuild, in BOTH policies.
   *
   *  'clear' is today's shipped shape — `resetPredictionState()` (fresh Predictor, seq floor,
   *  `held.clear()`). 'preserve' is the ADR-0192 bracket that switchZone gains, in the
   *  PRODUCTION ORDER: capture BEFORE the reset, restore AFTER it.
   *
   *  AM2: this MUST call `this.held.snapshot()` / `this.held.restore(...)` for real — a
   *  shadow-log of presses replayed through `press()` would make S12b/c/d self-fulfilling
   *  (they would pass without the production seam ever existing). S12-SELF below pins it.
   *  AM3: the rebuild ends by reconciling from the last authoritative row IN THE SAME CALL
   *  STACK — the state-based warp path (main.ts:848-855), where `reconcileFromStore` calls
   *  `switchZone` and then falls through to its own reconcile. */
  rebuildPrediction(mode: 'clear' | 'preserve', atMs: number): void {
    const heldSnapshot = mode === 'preserve' ? this.held.snapshot() : undefined;
    this.predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    this.predictor.seedSeq(this.lastRow?.lastInputSeq ?? 0); // nh3 Case M2 send-seq floor
    this.held.clear();
    if (heldSnapshot !== undefined) this.held.restore(heldSnapshot);
    this.reconcileFromStore(atMs);
  }

  /** [13r-f] The RECONNECT shape (ADR-0152 per-path invariant): the same rebuild with NO
   *  reconcile — the server's `on_disconnect` deleted the rows, so `reconcileFromStore`
   *  early-returns until `joinGame` round-trips. 'clear' is the shipped body; 'leak' is the
   *  anti-vacuity control that models `held.clear()` being removed from the shared body. */
  rebuildPredictionDeferredReconcile(mode: 'clear' | 'leak'): void {
    this.predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    this.predictor.seedSeq(this.lastRow?.lastInputSeq ?? 0);
    if (mode === 'clear') this.held.clear();
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
  /** [14r-e, ADR-0187] undefined ⇒ the SHIPPED deduped keydown. `false` is the S10-twin
   *  anti-vacuity control only (the pre-fix "every keydown emits" wiring). */
  dedupFirstStep?: boolean;
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
  const client = new ClientModel(
    cfg.holdCommitMs,
    (input, seq, epoch, sentAt) => {
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
    },
    cfg.dedupFirstStep,
  );
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
      // EVERY scenario must independently prove it can see doubles — a per-scenario harness
      // defect (e.g. scenario (a)'s wall phase mis-measuring tilesMovedByTap) must not hide
      // behind another scenario's signal.
      for (const sc of TAP_SCENARIOS) {
        let doubles = 0;
        for (const fps of [30, 60, 144]) {
          for (const tapMs of [40, 80, 120, 140]) {
            for (let phase = 0; phase < STEP_MS; phase += 20) {
              if (runTap(sc, fps, phase, tapMs, 0).tilesMovedByTap >= 2) doubles += 1;
            }
          }
        }
        expect(
          doubles,
          `scenario (${sc.label}): with the hold-commit threshold disabled the tap matrix MUST ` +
            'observe double-moves — if it observes none, the matrix cannot detect the defect ' +
            'it is supposed to gate and S1 above is vacuous for this scenario',
        ).toBeGreaterThan(0);
      }
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
// t=583.33 — so a nudge arriving at t=579 is inside the open window under BOTH thresholds and
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
      'the key has been held for only 79ms when the reposition lands: the divergence site must ' +
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

// ================================================================================
// S10 / S11 — [14r-e, ADR-0187] the DUAL-CODE first step (EARS-1)
//
// KEY_DIR binds TWO key codes to each direction (ArrowRight AND KeyD → East). Pre-fix,
// main.ts's keydown fired `step(dir)` unconditionally, so the second code fired a SECOND
// ungated first step while the direction was already held — a same-direction double-move
// that NO hold-commit threshold can see (both steps are keydown-immediate, not
// continuations). ADR-0148 disclosed it as residual 1b, ADR-0158 named it the sole
// remaining path (its residual 3), and ADR-0187 closes it with
// `if (!held.isHeld(dir)) step(dir);` — modelled in ClientModel.keydown above.
//
// RED REASON at authoring time, STATED PRECISELY: `HeldDirections.isHeld` does not exist,
// and ClientModel.keydown now calls it on EVERY press, so every scenario in this file that
// presses a key throws `this.held.isHeld is not a function` until the implementation lands
// — not just S10/S11. That is the same (correct, loud) signal this file's own header
// records for the mvi slice, when the missing `HOLD_COMMIT_MS` export reddened the whole
// module at link time. The ONE exception is S10-twin: `dedupFirstStep=false` short-circuits
// before `isHeld` is ever reached, so it is GREEN both before and after the fix — which is
// exactly what an anti-vacuity control has to be.
//
// NOTE on the model's fidelity: main.ts maps BOTH codes to one `dir` via KEY_DIR BEFORE
// any held logic runs, so "the second key code" and "a second keydown of the same
// direction" are the same event by the time `held` sees it. The model therefore scripts a
// second same-direction keydown, which is the faithful stimulus.
// ================================================================================

/** The dual-code tap: first code down at t, second code down at t+60, both released at
 *  t+120 — a 120ms total press, inside the <= 140ms tap-coverage contract (ADR-0158), so
 *  the hold-commit gate emits NO continuation and every tile observed here comes from a
 *  keydown. */
const DUAL_TAP_T0 = 500;
const DUAL_TAP_SECOND_CODE_AT = DUAL_TAP_T0 + 60;
const DUAL_TAP_UP_AT = DUAL_TAP_T0 + 120;

interface DualTapOutcome {
  tilesMovedByTap: number;
  keydownEmissions: number;
  postTapEmissions: number;
  postTapMovedDrains: number;
  postTapRejections: number;
}
function runDualTap(fps: number, tickPhaseMs: number, dedupFirstStep?: boolean): DualTapOutcome {
  const t = DUAL_TAP_T0;
  const r = runSim(
    { fps, tickPhaseMs, latencyMs: 1, startX: 5, startY: 5, dedupFirstStep },
    [
      { kind: 'probeServerX', atMs: t - 100 },
      { kind: 'keydown', atMs: t, dir: 'East' }, // ArrowRight
      { kind: 'keydown', atMs: DUAL_TAP_SECOND_CODE_AT, dir: 'East' }, // KeyD, same dir
      { kind: 'keyup', atMs: DUAL_TAP_UP_AT, dir: 'East' },
    ],
    2000,
  );
  const preTapX = r.probes[0]?.x ?? Number.NaN;
  return {
    tilesMovedByTap: r.server.row.x - preTapX,
    keydownEmissions: r.client.emissions.filter((e) => e.atMs >= t && e.source === 'keydown')
      .length,
    postTapEmissions: r.client.emissions.filter((e) => e.atMs >= t).length,
    postTapMovedDrains: r.server.acceptedDrains.filter((d) => d.atMs >= t && d.moved).length,
    postTapRejections: r.client.rejections.filter((x) => x.atMs >= t).length,
  };
}

describe('[14r-e] S10 dual-code tap: both key codes of ONE direction move exactly ONE tile', () => {
  it(
    'S10 BITES: the second key code emits NOTHING — one tile, one accepted intent, in every cell',
    () => {
      // ★ THE SLICE DEFECT (EARS-1). WRONG IMPL KILLED (1): today's wiring — `step(dir)`
      //   fires on EVERY keydown, so two codes produce two ungated first steps and the
      //   server drains both: 2 tiles from one physical tap.
      // WRONG IMPL KILLED (2): a dedup that also suppresses the FIRST press (e.g. an
      //   inverted predicate) — `keydownEmissions` would be 0 and `tilesMovedByTap` 0.
      // WRONG IMPL KILLED (3): "fixing" it by cancelling/clearing state on the second
      //   press. `postTapMovedDrains === postTapEmissions` and `postTapRejections === 0`
      //   pin the server innocent and pin the fix as a pure NOT-EMIT: it drains exactly
      //   what the client sent, and nothing was ever rejected or rolled back.
      // WRONG IMPL KILLED (4): dedup implemented on the hold-commit threshold instead of
      //   held membership (`committedActive(...) === dir`) — the second code lands 60ms in,
      //   below HOLD_COMMIT_MS, so the gate is still shut and it emits. (U-DK3 is the
      //   parameter-free version of this kill.)
      //
      // The tickPhase sweep is what makes this exhaustive rather than anecdotal: the
      // pre-fix double is not phase-dependent (unlike S1's), but sweeping proves the FIX
      // is not phase-dependent either.
      const bad: string[] = [];
      for (const fps of [30, 60, 144]) {
        for (let phase = 0; phase < STEP_MS; phase += 20) {
          const o = runDualTap(fps, phase);
          if (
            o.tilesMovedByTap !== 1 ||
            o.keydownEmissions !== 1 ||
            o.postTapEmissions !== 1 ||
            o.postTapMovedDrains !== o.postTapEmissions ||
            o.postTapRejections !== 0
          ) {
            bad.push(
              `fps=${fps} phase=${phase} → tiles=${o.tilesMovedByTap} ` +
                `keydownEmissions=${o.keydownEmissions} emissions=${o.postTapEmissions} ` +
                `movedDrains=${o.postTapMovedDrains} rejections=${o.postTapRejections}`,
            );
          }
        }
      }
      expect(
        bad.length,
        'pressing BOTH key codes bound to one direction inside a single 120ms tap MUST move ' +
          'exactly one tile and emit exactly one accepted intent, in every cell (ADR-0187 ' +
          `EARS-1). Offending cells (first 8 of ${bad.length}):\n${bad.slice(0, 8).join('\n')}`,
      ).toBe(0);
    },
    GRID_TIMEOUT_MS,
  );

  it(
    'S10-twin ANTI-VACUITY: the SAME script with dedupFirstStep=false DOES observe 2 tiles',
    () => {
      // Proves S10 above is capable of going red. `dedupFirstStep=false` is exactly the
      // pre-ADR-0187 keydown ("every keydown emits"), so this reproduces the defect and
      // asserts the harness SEES it. Without this twin, a runDualTap that (say) mis-read
      // `tilesMovedByTap` as always 1 — or a script whose second keydown never reached the
      // model — would look like a passing gate.
      let doubles = 0;
      let maxTiles = 0;
      for (const fps of [30, 60, 144]) {
        for (let phase = 0; phase < STEP_MS; phase += 20) {
          const o = runDualTap(fps, phase, false);
          if (o.tilesMovedByTap >= 2) doubles += 1;
          maxTiles = Math.max(maxTiles, o.tilesMovedByTap);
        }
      }
      expect(
        doubles,
        'with the first-step dedup disabled the dual-code tap matrix MUST observe double-moves ' +
          `(max tiles observed: ${maxTiles}) — if it observes none, the matrix cannot detect ` +
          'the defect it is supposed to gate and S10 is vacuous',
      ).toBeGreaterThan(0);
    },
    GRID_TIMEOUT_MS,
  );
});

describe('[14r-e] S11 interleave: the dedup is MEMBERSHIP in the held set, not the stack top', () => {
  it('S11 BITES: East held, North pressed ON TOP, then the second East code — no extra step', () => {
    // ★ THE MUTANT THIS SCENARIO EXISTS FOR: `isHeld(dir) => held.active() === dir`.
    // The player holds ArrowRight, then presses ArrowUp (North becomes the stack TOP),
    // then presses KeyD — the other East code. A stack-top check answers "East is not
    // held", the keydown emits, and the double-move is back for anyone playing with two
    // hands. Membership answers "East IS held" and the step is not emitted.
    // (U-DK2 in heldKeys.test.ts is the parameter-free unit version of this kill; the
    // wiring-text version is W-DK-KEYDOWN-DEDUPED in main.wiring.test.ts.)
    //
    // All presses are short (East 120ms, North 70ms) so the hold-commit gate emits no
    // CONTINUATION at all: every emission in this run is a keydown first step, which is
    // what makes the ledger assertions below exact rather than approximate.
    const t0 = 500;
    const script: readonly ScriptEvent[] = [
      { kind: 'keydown', atMs: t0, dir: 'East' }, // ArrowRight
      { kind: 'keydown', atMs: t0 + 50, dir: 'North' }, // ArrowUp — North goes on top
      { kind: 'keydown', atMs: t0 + 100, dir: 'East' }, // KeyD — East is held, NOT active
      { kind: 'keyup', atMs: t0 + 120, dir: 'North' },
      { kind: 'keyup', atMs: t0 + 120, dir: 'East' },
    ];
    const cfg = { fps: 60, tickPhaseMs: 0, latencyMs: 1, startX: 5, startY: 5 };
    const r = runSim(cfg, script, 2000);

    const keydowns = r.client.emissions.filter((e) => e.source === 'keydown');
    expect(
      keydowns.map((e) => `${e.dir}@${e.atMs}`),
      'exactly TWO keydown first steps must be emitted — East at the first code and North ' +
        'on top of it. The third keydown (the OTHER East code, at t0+100) must emit nothing: ' +
        'East is already in the held set even though North is the stack top',
    ).toEqual([`East@${t0}`, `North@${t0 + 50}`]);
    expect(
      keydowns.some((e) => e.atMs === t0 + 100),
      'the second East key code must produce NO emission at all (pure not-emit — nothing is ' +
        'cancelled and no predictor state is written)',
    ).toBe(false);

    // The behavioural half: one tile East, one tile North, and nothing else.
    expect(
      { x: r.server.row.x, y: r.server.row.y },
      'the interleave must walk exactly one tile East and one tile North from (5,5). An ' +
        '`active() === dir` dedup re-emits East at t0+100 and lands the character at x=7',
    ).toEqual({ x: 6, y: 4 });

    // ANTI-VACUITY CONTROL: the SAME script with the dedup disabled must show the extra
    // East step — otherwise the assertions above could be passing because the third
    // keydown never reached the model in the first place.
    const control = runSim({ ...cfg, dedupFirstStep: false }, script, 2000);
    expect(
      control.client.emissions.filter((e) => e.source === 'keydown').length,
      'CONTROL: with the dedup disabled the third keydown MUST emit, giving 3 keydown first ' +
        'steps — if it does not, S11 proves nothing about the dedup',
    ).toBe(3);
    expect(
      control.server.row.x,
      'CONTROL: the un-deduped run must land one tile FURTHER east (x=7) — this is the ' +
        'double-move S11 gates',
    ).toBe(7);
  });
});

// ================================================================================
// S12 — [13r-f, ADR-0192] the HELD KEY survives the WARP arm's prediction rebuild (nh5)
//
// THE DEFECT: `resetPredictionState()` calls `held.clear()` and `switchZone` calls it on
// every zone change. The keydown handler ignores `e.repeat`, so a key that is PHYSICALLY
// still down is never re-registered — the player walking through a zone boundary stops
// dead until release + re-press. ADR-0152 residual #4 / nh3-plan R6 named it "nh5".
//
// WHAT IS MODELLED: `ClientModel.rebuildPrediction(mode, at)` above — the rebuild in both
// policies. 'clear' is today's shipped shape; 'preserve' is the ADR-0192 bracket
// (`held.snapshot()` → `resetPredictionState()` → `held.restore(...)`), which reaches into
// the REAL `HeldDirections` seam (AM2 — S12-SELF pins that it is not a shadow-log replay).
// AM3: the rebuild reconciles from the last authoritative row in the SAME call stack, which
// is the state-based warp path; S12b/c/d assert that reconcile genuinely ran.
//
// AM8: every S12 script triggers its rebuild in the steady-state window where the pipeline
// is fully acked (`pendingCount === 0`, server queue drained) — asserted as a PRECONDITION —
// so the fresh predictor's `seedSeq` floor is exact and nothing in flight can confuse the
// measurement. Cell: 60fps / tickPhase 0 / L=1, rebuild at t=2005, i.e. 4ms after the
// t=2001 drain-snapshot reconcile and 11.67ms before the t=2016.67 frame.
//
// RED REASON at authoring time: `HeldDirections.snapshot` / `.restore` do not exist, so
// every 'preserve' scenario throws `this.held.snapshot is not a function` — S12b/c/d are
// RED on a MISSING IMPLEMENTATION. S12a (the defect repro under 'clear'), S12e (the
// reconnect gap) and S12-SELF never touch the seam and are GREEN today by design.
// ================================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type WarpMode = 'clear' | 'preserve' | 'deferred-clear' | 'deferred-leak';

interface WarpSimConfig {
  fps: number;
  tickPhaseMs: number;
  latencyMs: number;
  startX: number;
  startY: number;
  holdCommitMs?: number;
  rebuildAtMs: number;
  rebuildMode: WarpMode;
  untilMs: number;
}

/** State captured AT the rebuild instant — the preconditions every S12 tooth asserts before
 *  it is allowed to judge anything (a tooth whose stimulus never ran proves nothing). */
interface WarpProbe {
  ran: boolean;
  xAtRebuild: number;
  emissionsBefore: number;
  pendingAtRebuild: number;
  outstandingAtRebuild: number;
  reconcilesBefore: number;
  reconcilesAfter: number;
}

interface WarpSimResult extends SimResult {
  readonly probe: WarpProbe;
  readonly framePeriodMs: number;
  readonly rebuildAtMs: number;
}

/** The S12 driver. Deliberately a SEPARATE function from `runSim` (whose ScriptEvent union
 *  and switch are untouched by this slice): identical transport/tick/frame wiring, plus one
 *  scheduled rebuild event that records the pipeline state around itself. */
function runWarpSim(cfg: WarpSimConfig, script: readonly ScriptEvent[]): WarpSimResult {
  const q = new EventQueue();
  const server = new ServerModel(cfg.startX, cfg.startY);
  const latency = cfg.latencyMs;
  const client = new ClientModel(cfg.holdCommitMs, (input, seq, epoch, sentAt) => {
    q.push(sentAt + latency, (at) => {
      const res = server.enqueueMove(input, seq, at);
      if (res === 'ok') {
        const snap = server.snapshot();
        q.push(at + latency, (a2) => client.onRowUpdate(snap, a2));
      } else {
        q.push(at + latency, (a2) => {
          client.rejections.push({ seq, reason: res, atMs: a2 });
          if (client.predictor.dropRejected(seq, epoch)) client.reconcileFromStore(a2);
        });
      }
    });
  });
  const initialSnap = server.snapshot();
  q.push(0, (at) => client.onRowUpdate(initialSnap, at));
  const framePeriod = 1000 / cfg.fps;
  for (let n = 0; ; n++) {
    const t = n * framePeriod;
    if (t > cfg.untilMs) break;
    q.push(t, (at) => client.frame(at));
  }
  for (let t = cfg.tickPhaseMs; t <= cfg.untilMs; t += STEP_MS) {
    q.push(t, (at) => {
      if (server.tick(at)) {
        const snap = server.snapshot();
        q.push(at + latency, (a2) => client.onRowUpdate(snap, a2));
      }
    });
  }
  for (const ev of script) {
    if (ev.kind === 'keydown') {
      q.push(ev.atMs, (at) => client.keydown(ev.dir, at));
    } else if (ev.kind === 'keyup') {
      q.push(ev.atMs, () => client.keyup(ev.dir));
    } else {
      // Fail loud rather than silently ignoring a stimulus the driver cannot deliver.
      throw new Error(`runWarpSim: unsupported script event kind "${ev.kind}"`);
    }
  }
  const probe: WarpProbe = {
    ran: false,
    xAtRebuild: Number.NaN,
    emissionsBefore: -1,
    pendingAtRebuild: -1,
    outstandingAtRebuild: -1,
    reconcilesBefore: -1,
    reconcilesAfter: -1,
  };
  // Pushed LAST so a rebuild scheduled on a frame/tick boundary runs after them.
  q.push(cfg.rebuildAtMs, (at) => {
    probe.ran = true;
    probe.xAtRebuild = server.row.x;
    probe.emissionsBefore = client.emissions.length;
    probe.pendingAtRebuild = client.predictor.pendingCount;
    probe.outstandingAtRebuild = client.predictor.outstandingSteps;
    probe.reconcilesBefore = client.reconciles.length;
    if (cfg.rebuildMode === 'deferred-clear') client.rebuildPredictionDeferredReconcile('clear');
    else if (cfg.rebuildMode === 'deferred-leak') client.rebuildPredictionDeferredReconcile('leak');
    else client.rebuildPrediction(cfg.rebuildMode, at);
    probe.reconcilesAfter = client.reconciles.length;
  });
  q.run(cfg.untilMs);
  return {
    server,
    client,
    probes: [],
    probe,
    framePeriodMs: framePeriod,
    rebuildAtMs: cfg.rebuildAtMs,
  };
}

/** Every emission recorded AFTER the rebuild ran — sliced by LEDGER INDEX, not by timestamp,
 *  so an emission that shares the rebuild's instant cannot be mis-attributed either way. */
function afterRebuild(r: WarpSimResult): Emission[] {
  return r.client.emissions.slice(r.probe.emissionsBefore);
}

/** The steady-state cell every S12 scenario uses (see the AM8 note above). */
const S12_REBUILD_AT = 2005;
const S12_CELL = {
  fps: 60,
  tickPhaseMs: 0,
  latencyMs: 1,
  startX: 5,
  startY: 5,
  rebuildAtMs: S12_REBUILD_AT,
} as const;

/** The AM8 precondition + "the stimulus really ran", asserted by every tooth below. */
function expectWarpPreconditions(r: WarpSimResult): void {
  expect(r.probe.ran, 'PRECONDITION: the scheduled rebuild event must have run').toBe(true);
  expect(
    r.probe.pendingAtRebuild,
    'PRECONDITION (AM8): the rebuild must happen with the pipeline FULLY ACKED ' +
      '(pendingCount === 0) — otherwise the fresh predictor seq floor, not the held stack, ' +
      'would be what this tooth is measuring',
  ).toBe(0);
}

describe('[13r-f] S12 held-key warp continuation (ADR-0192): the WARP rebuild keeps the hold', () => {
  it('S12-SELF (AM2): rebuildPrediction really calls this.held.snapshot()/restore() — not a shadow-log replay', () => {
    // ★ THE SELF-FULFILLING-SIM KILL. S12b/c/d could be made green WITHOUT the production
    // seam ever existing: model 'preserve' as "remember which dirs were down and re-press
    // them at their old timestamps" (a shadow log replayed through `press()`), and the sim
    // would walk beautifully across the rebuild while `HeldDirections` still had no
    // snapshot/restore at all — the behavioural gate would be proving a property of the TEST
    // FILE. This tooth reads this file's own source and requires the method body to route
    // through the REAL seam, so S12b/c/d are RED until heldKeys.ts grows it.
    const selfPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'movementSim.test.ts');
    let src: string;
    try {
      src = readFileSync(selfPath, 'utf8');
    } catch (err) {
      // Fail loud — a missing file must never make a scan vacuously pass.
      throw new Error(`movementSim.test.ts unreadable at ${selfPath} — ${String(err)}`);
    }
    // Assembled from two fragments ON PURPOSE: written as one literal, THIS line would itself
    // be a second match for the needle and the uniqueness check below would always read 2.
    const sigHead = 'rebuildPrediction(mode:';
    const sigTail = "'clear' | 'preserve', atMs: number): void {";
    const sig = `${sigHead} ${sigTail}`;
    expect(
      src.split(sig).length - 1,
      `this file must declare EXACTLY ONE \`${sig}\` — a second (or missing) declaration means ` +
        'the slice below is reading the wrong method body',
    ).toBe(1);
    const start = src.indexOf(sig);
    const end = src.indexOf('\n  }', start);
    expect(
      end,
      'the rebuildPrediction method body must be delimited by its closing brace',
    ).toBeGreaterThan(start);
    const body = src.slice(start + sig.length, end);

    expect(
      body.includes('this.held.snapshot('),
      "rebuildPrediction('preserve') MUST capture through the REAL seam `this.held.snapshot()`. " +
        'A shadow log of pressed dirs replayed through `press()` makes S12b/c/d pass while ' +
        'heldKeys.ts has no snapshot/restore — the sim would be proving itself (AM2)',
    ).toBe(true);
    expect(
      body.includes('this.held.restore('),
      "rebuildPrediction('preserve') MUST restore through the REAL seam `this.held.restore(...)` " +
        '— same self-fulfilling-sim failure as above (AM2)',
    ).toBe(true);
    expect(
      body.includes('this.held.restore(heldSnapshot)'),
      'the restore must be fed the CAPTURE taken before the reset — the contiguous needle ' +
        '`this.held.restore(heldSnapshot)` pins the ARGUMENT (mirroring the wiring tooth`s ' +
        'NH5_RESTORE_STMT). Calling both methods proves nothing on its own: a body that ' +
        'restores a FRESH `this.held.snapshot()` taken after `this.held.clear()` routes through ' +
        'the real seam, satisfies both presence checks above, and restores an EMPTY stack',
    ).toBe(true);
    expect(
      body.includes('.press('),
      'rebuildPrediction must NOT re-press anything: a re-press is the shadow-log cheat, and ' +
        'in production it is also anti-pattern #1 (fresh stamps → a 150ms halt at every warp)',
    ).toBe(false);
  });

  it("S12a (GREEN today — the DEFECT, reproduced): under 'clear' a still-held key stops the walk dead", () => {
    // ★ THE nh5 DEFECT AS A BEHAVIOURAL FACT. East is held from t=500 and NEVER released;
    // the rebuild happens mid-walk with no keydown after it. Today's shipped `held.clear()`
    // empties the stack, `committedActive` answers undefined forever, and the character
    // freezes on the far side of the boundary until the player releases and re-presses.
    // This is GREEN today and MUST STAY GREEN as the 'clear' policy's specification — it is
    // what makes S12b's ≥2 tiles a genuine change of behaviour rather than an artefact.
    const r = runWarpSim({ ...S12_CELL, rebuildMode: 'clear', untilMs: 3000 }, [
      { kind: 'keydown', atMs: 500, dir: 'East' },
    ]);
    expectWarpPreconditions(r);
    expect(
      r.probe.xAtRebuild - S12_CELL.startX,
      'ANTI-VACUITY: the pre-rebuild hold must actually have walked several tiles — if it did ' +
        'not, "the walk stopped" is true for the wrong reason',
    ).toBeGreaterThanOrEqual(3);
    expect(
      afterRebuild(r).filter((e) => e.source === 'keydown').length,
      'the script must contain NO keydown after the rebuild — the whole question is whether a ' +
        'key that is ALREADY down keeps working',
    ).toBe(0);
    expect(
      afterRebuild(r).length,
      "under the 'clear' policy the cleared stack can re-issue nothing at all",
    ).toBe(0);
    expect(
      r.server.row.x,
      'THE DEFECT: with the held stack cleared by the rebuild, the character stops advancing ' +
        'at the boundary even though the key is still physically down (ADR-0152 residual #4)',
    ).toBe(r.probe.xAtRebuild);
  });

  it("S12b (RED today): under 'preserve' the walk continues ≥2 further tiles with NO keydown after the rebuild", () => {
    // ★ THE SLICE'S BEHAVIOURAL GATE (AC-1 + AC-2). Identical script and identical instant to
    // S12a — only the policy differs — so the ≥2 tiles can come from nothing but the
    // preserved held stack.
    // WRONG IMPL KILLED (1): no seam at all (today) — S12a's freeze, here a hard red.
    // WRONG IMPL KILLED (2): `restore` that drops entries / restores an empty capture.
    // WRONG IMPL KILLED (3), NARROWLY: a rebuild that floors the fresh predictor's seq at
    //   NOTHING — every continuation would carry an already-acked seq, the server would reject
    //   it as stale and no tile would move. The floor's FIDELITY is NOT claimed here: this sim
    //   floors from the server ack (`lastRow.lastInputSeq`), which coincides with production's
    //   `lastSentSeq` only under the AM8 all-acked precondition asserted above. The ack-vs-sent
    //   distinction (nh3 Case M2) is owned by predictor.test.ts's nh3-2 block.
    // WRONG IMPL KILLED (4): a preserved hold that DOUBLE-advances (a merge that leaves two
    //   entries, or an emitter that fires twice per slot) — the cadence assertion below pins
    //   one tile per 200ms movement_tick slot across the whole run (ADR-0013/0141, R3).
    const r = runWarpSim({ ...S12_CELL, rebuildMode: 'preserve', untilMs: 3000 }, [
      { kind: 'keydown', atMs: 500, dir: 'East' },
    ]);
    expectWarpPreconditions(r);
    expect(
      r.probe.reconcilesAfter - r.probe.reconcilesBefore,
      'PRECONDITION (AM3): the rebuild must reconcile from server truth in the SAME call ' +
        'stack exactly once — an omitted chain would make this tooth measure a different ' +
        'pipeline than the one main.ts runs',
    ).toBe(1);
    expect(
      afterRebuild(r).filter((e) => e.source === 'keydown').length,
      'no keydown may be scripted after the rebuild — a re-press would make this vacuous',
    ).toBe(0);
    expect(
      r.server.row.x - r.probe.xAtRebuild,
      'AC-2: a key held past the commit threshold when the warp rebuild happens must keep ' +
        'walking on the far side with NO fresh keydown — the continuation emitters read the ' +
        'restored stack and its ORIGINAL press stamp',
    ).toBeGreaterThanOrEqual(2);
    expect(
      cadenceOf(r).missedSlots,
      'R3 smoothness: every consecutive moved-drain gap across the warp must be exactly one ' +
        `${STEP_MS}ms movement_tick slot — the preserved hold must neither skip a slot nor ` +
        'double-advance',
    ).toBe(0);
  });

  it('S12c (RED today): the first post-rebuild continuation lands within ONE FRAME, not one commit window later', () => {
    // ★ THE RE-STAMP KILL, behaviourally (AC-2, ADR-0192 Decision 3). A `restore` that
    // re-stamps entries to "now" satisfies S12b — the walk resumes, just 150ms late — and the
    // player feels a hitch at every boundary, which is the defect in a smaller size. With the
    // ORIGINAL stamp the hold is ALREADY committed, so the very next frame after the rebuild
    // (11.67ms later at 60fps) emits the continuation.
    const r = runWarpSim({ ...S12_CELL, rebuildMode: 'preserve', untilMs: 3000 }, [
      { kind: 'keydown', atMs: 500, dir: 'East' },
    ]);
    expectWarpPreconditions(r);
    expect(
      r.probe.reconcilesAfter - r.probe.reconcilesBefore,
      'PRECONDITION (AM3): the rebuild must reconcile from server truth in the same call stack',
    ).toBe(1);
    const first = afterRebuild(r)[0];
    expect(
      first,
      'the preserved hold must produce a continuation at all after the rebuild',
    ).toBeDefined();
    const delay = (first as Emission).atMs - r.rebuildAtMs;
    expect(
      delay,
      `the first post-warp continuation must arrive within one frame period ` +
        `(${r.framePeriodMs}ms) of the rebuild — a re-stamping restore delays it by a whole ` +
        `commit window (${HOLD_COMMIT_MS}ms), which is a visible hitch at every boundary`,
    ).toBeLessThanOrEqual(r.framePeriodMs + EPS);
    expect(
      delay,
      'the post-warp continuation must NOT wait out a fresh commit window — that is ' +
        'anti-pattern #1 (re-press with fresh stamps) surviving as a restore that re-stamps',
    ).toBeLessThan(HOLD_COMMIT_MS);
  });

  it('S12d (RED today): a 50ms-old hold stays uncommitted until the ORIGINAL press ages the commit window', () => {
    // ★ AC-3. The mirror image of S12c: a warp taken 50ms into a press is NOT a free
    // re-commit. The key goes down at t=1955 and the rebuild is at t=2005, so at rebuild time
    // the hold is 50ms old.
    // WRONG IMPL KILLED (1): `restore` writing `pressedAtMs: 0` (or any sentinel) — the hold
    //   would read as committed immediately and the warp would hand the player a free extra
    //   tile, re-opening the ADR-0158 double-move at every boundary. Caught by the lower bound.
    // WRONG IMPL KILLED (2): `restore` re-stamping to the rebuild instant — the continuation
    //   would appear at 2005+150 instead of 1955+150. Caught by the upper bound.
    const pressAt = 1955;
    const r = runWarpSim({ ...S12_CELL, rebuildMode: 'preserve', untilMs: 2400 }, [
      { kind: 'keydown', atMs: pressAt, dir: 'East' },
    ]);
    expectWarpPreconditions(r);
    expect(
      r.probe.reconcilesAfter - r.probe.reconcilesBefore,
      'PRECONDITION (AM3): the rebuild must reconcile from server truth in the same call stack',
    ).toBe(1);
    const post = afterRebuild(r);
    expect(
      post.filter((e) => e.atMs <= r.rebuildAtMs + r.framePeriodMs + EPS).length,
      'AC-3: the first frame after the rebuild must emit NOTHING — the hold is only 50ms old ' +
        'and has not earned a continuation from its ORIGINAL press yet',
    ).toBe(0);
    const first = post[0];
    expect(first, 'the hold must eventually commit and continue on its own').toBeDefined();
    expect(
      (first as Emission).atMs,
      `AC-3: the continuation may not appear before the ORIGINAL press (t=${pressAt}) has aged ` +
        'a full commit window — a restored stamp of 0 would emit immediately (a free tile)',
    ).toBeGreaterThanOrEqual(pressAt + HOLD_COMMIT_MS);
    expect(
      (first as Emission).atMs,
      `…and it must appear on the FIRST frame after t=${pressAt + HOLD_COMMIT_MS}: a restore ` +
        'that re-stamps to the rebuild instant would push it a further 50ms out',
    ).toBeLessThanOrEqual(pressAt + HOLD_COMMIT_MS + r.framePeriodMs + EPS);

    // CONTROL (green today): the SAME script under 'clear' emits nothing at all, so the
    // emission measured above is produced by the PRESERVED stack and by nothing else.
    const control = runWarpSim({ ...S12_CELL, rebuildMode: 'clear', untilMs: 2400 }, [
      { kind: 'keydown', atMs: pressAt, dir: 'East' },
    ]);
    expect(
      afterRebuild(control).length,
      "CONTROL: under 'clear' the same 50ms hold produces NO continuation ever — if it does, " +
        'S12d is not measuring the restored stack',
    ).toBe(0);
  });

  it('S12e (GREEN today): on the RECONNECT shape (rebuild with DEFERRED reconcile) held.clear() alone guards the gap', () => {
    // ★ THE ADR-0152 PER-PATH INVARIANT, behaviourally (AC-4). On reconnect the reconcile is
    // DEFERRED (the server's on_disconnect deleted the rows, so reconcileFromStore
    // early-returns until joinGame round-trips). In that gap the fresh predictor's
    // `#lastAuthQueueLen` is 0 while the server may still owe a queued step, so the
    // outstanding-steps gate is WIDE OPEN — and the only thing standing between a held key
    // and a continuation emitted against unknown authority is `held.clear()`.
    // THIS IS WHY 13r-f DOES NOT TOUCH THE RECONNECT ARM. The wiring tooth
    // W-NH5-RECONNECT-CLEARS is the source-level half of the same statement.
    const gapUntil = 2200; // the next server tick; its snapshot would end the deferral
    const script: readonly ScriptEvent[] = [{ kind: 'keydown', atMs: 500, dir: 'East' }];
    const r = runWarpSim({ ...S12_CELL, rebuildMode: 'deferred-clear', untilMs: gapUntil }, script);
    expect(r.probe.ran, 'PRECONDITION: the scheduled rebuild event must have run').toBe(true);
    expect(
      r.probe.reconcilesAfter - r.probe.reconcilesBefore,
      'PRECONDITION: the reconnect-shaped rebuild must NOT reconcile — that deferral is the ' +
        'whole point of this scenario',
    ).toBe(0);
    expect(
      r.client.reconciles.length,
      'PRECONDITION: no reconcile may land anywhere in the observed gap either',
    ).toBe(r.probe.reconcilesBefore);
    expect(
      afterRebuild(r).length,
      'AC-4: with the held stack cleared, ZERO intents are emitted into the deferred-reconcile ' +
        'gap — this is the guarantee ADR-0152 rests on and the reason the reconnect arm keeps ' +
        'a bare held.clear() with no capture/restore around it',
    ).toBe(0);

    // ANTI-VACUITY CONTROL: the SAME gap with the clear REMOVED does emit — so the zero above
    // is produced by held.clear() and not by the gap being inert (the frames are running, the
    // gate is open, the key is committed).
    const leak = runWarpSim(
      { ...S12_CELL, rebuildMode: 'deferred-leak', untilMs: gapUntil },
      script,
    );
    expect(
      afterRebuild(leak).length,
      'CONTROL: a rebuild that does NOT clear the held stack emits into the deferred gap — if ' +
        'it does not, S12e proves nothing about held.clear() being load-bearing',
    ).toBeGreaterThanOrEqual(1);
  });
});
