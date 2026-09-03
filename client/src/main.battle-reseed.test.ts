// @vitest-environment happy-dom
/**
 * main.battle-reseed.test.ts — RUNTIME gate over main.ts's pt-b1 battle-emit listener
 * (slice 16r-f, extended by slice 17r-b; ADR-0130 reseed latch + residuals (d)/(e)).
 *
 * SOURCE OF TRUTH:
 *   16r-f EARS-1 / EARS-2, plus the two plan-review additions (T3 sticky-forever
 *   cheat-kill, T9 double-reconnect guard) and the implementation-review addition
 *   (T10 two fully-RESOLVED reseed episodes).
 *     EARS-1: WHEN a reconnect completes and the first store flush carries no battle rows
 *             THE reseed latch SHALL survive until a flush that observes definite battle state.
 *     EARS-2: WHEN an Ongoing battle survives a reconnect THE event ring SHALL NOT receive a
 *             new battleStart.
 *   17r-b (M-postgate-seventeenth-review-residuals.spec.md#17r-b), ADR-0130 residuals (d)+(e):
 *     EARS-d: WHEN a reconnect's first non-empty flush contains only rows OTHER than the
 *             surviving battle THE reseed latch SHALL NOT resolve until hydration-complete is
 *             signalled AND the event ring SHALL NOT receive a spurious battleStart.
 *     EARS-e: WHEN a reconnect completes THE module-local identity in main.ts SHALL equal the
 *             SDK identity of the new connection.
 *
 * WHY A RUNTIME IMPORT HERE — main.wiring.test.ts:20-21 says "source-scan (NOT import)":
 * the 16r-f defect is a latch burned by an ORDERING OF STORE FLUSHES, which no text scan
 * can observe. The crash that docblock warns about is avoided by mocking the wasm pkg,
 * net/connection, render/world (Pixi) and the telemetry bootstrap, and by never putting an
 * `#app` element in the DOM (main() then constructs no view shells at all). This file is
 * the sanctioned, SCOPED exception. Do NOT copy the pattern without the listener-cleanup
 * harness below: main.ts registers window/document listeners at MODULE scope, so a second
 * import without cleanup leaves a stale live F9 handler and every ring assertion silently
 * reads a dead module instance's ring.
 *
 * SIMULATION CAVEAT: in production connection.ts resets the store as part of handling the
 * drop and THEN invokes opts.onReconnect(identity). These tests call `store.reset()` followed
 * by the captured `onReconnect(id)` directly. That is equivalent for the listener under test,
 * which observes only (a) an emptied store, (b) the onReconnect body having run, and (c) the
 * module-local identity it left behind.
 *
 * SIMULATION CAVEAT #2 (17r-b, the hydration signal): in production `opts.onHydrated()` is
 * fired from connection.ts's MicrotaskBatcher flush closure, AFTER the view reconcile and
 * BEFORE `store.flushBatch()` — so every listener that flush notifies already observes the
 * signal as delivered. Here `signalHydrated()` calls `opts.onHydrated()` as its own step,
 * immediately BEFORE the flush that must resolve the latch: the same observable order
 * (signal delivered, then the listener runs), expressed as two statements instead of one
 * closure. A flush placed BEFORE `signalHydrated()` therefore models a flush that lands
 * ahead of the applied snapshot's hydration edge — which is exactly residual (d).
 * RESIDUAL (f), stated here because it is a limit of THIS file: that connection.ts really
 * fires `onHydrated` once per applied snapshot, before flushBatch and outside the
 * `live !== undefined` guard, is proven by SOURCE SCAN only (connection.test.ts,
 * RSD17B-SIGNAL) — connection.ts cannot be imported under vitest.
 *
 * OBSERVATION CHANNEL: the F9 bug bundle. buildBugBundle is spied WITH call-through, so each
 * test reads the REAL EventRing snapshot main.ts hands it. Assertions project only stable
 * fields (kind / battleId / outcome / turnCount / isPvp / connect identity) — never tMs /
 * tSeq, which come from a real Date.now() clock.
 *
 * SECOND OBSERVATION CHANNEL (17r-b, plan §7 reviewer B1 / red-team F1): console.error.
 * The battle listener's body is wrapped in try/catch (main.ts:1828-1830), so a THROW inside
 * it is swallowed and surfaces ONLY as a `console.error('[obs] battle', err)`. A listener
 * that crashes on every flush can therefore leave a ring that still matches the expected
 * projection — the ORPHAN and NOBATTLE fixtures both exercise that exact shape. Every test
 * in this suite runs under a global control: `console.error` is spied in beforeEach and
 * asserted never-called in afterEach, with the logged arguments rendered into the failure
 * message. MEASURED BASELINE (orchestrator, at the 17r-b fork): this suite logs NOTHING, so
 * the control starts green and any red is the test's own doing.
 *
 * DELIBERATELY OMITTED: a zone-switch/reseed same-flush interleave test. Its realistic
 * rot-mode (nulling the captured prev id inside resetPredictionState) is already killed by
 * T2, and a zone switch mid-battle is server-rejected (movement.rs is_in_ongoing_battle).
 *
 * RED REASON (17r-b — rewritten; the 16r-f paragraph that stood here recorded the RED state
 * at 16r-f AUTHORING time and has been GREEN since that slice shipped. A stale "RED at fork"
 * claim in a gating file teaches the next reader to discount failure messages, which is how a
 * real red gets waved through).
 *   (1) HARNESS-LEVEL RED, 15 of the 17 tests: `signalHydrated()` calls `opts.onHydrated()`,
 *       and `ConnectionOptions` has no `onHydrated` at the fork, so every test that calls it
 *       throws `TypeError: opts.onHydrated is not a function` from the TEST BODY (not from
 *       inside the listener's try/catch). That is a missing-implementation red, not a typo.
 *       Only T4 and T5 — which never reconnect — are green at the fork.
 *   (2) BEHAVIOURAL RED, i.e. what each new tooth actually encodes once `onHydrated` merely
 *       EXISTS (wire it as a no-op and re-run to see these):
 *         RSD17B-STALEROW   — reds against 16r-f's `if (latest === undefined) return;`
 *                             stickiness: the stale B1 terminal row burns the latch and B2's
 *                             re-sighting emits a spurious battleStart.
 *         RSD17B-ONGOINGROW — same defect via an Ongoing NON-survivor row (a second
 *                             participant-scoped row is legal, store.ts:895-900).
 *         RSD17B-REARM      — reds unless `hydratedSinceReconnect = false` is reset
 *                             UNCONDITIONALLY on every reconnect (outside the capture guard).
 *         RSD17B-IDROT      — reds until `onReconnect` CARRIES the identity and main.ts
 *                             reassigns its module-local `identity` (residual (e)).
 *         RSD17B-ORPHAN     — same, via the silent-re-baseline failure mode: the stale
 *                             identity still matches the old row, so the NEW battle never
 *                             starts.
 *         RSD17B-NOBATTLE   — a REGRESSION PIN, green under both the fork's `latest ===
 *                             undefined` clause and the correct implementation. It exists for
 *                             mutant #12 (dropping the `latest?.` optional chain in the
 *                             resolved branch), which throws inside the listener's try/catch,
 *                             leaves the expected ring INTACT, and is caught by the
 *                             console.error control alone.
 *   (3) GREEN and staying green: T1-T3 and T6-T10 are regression pins for the 16r-f
 *       behaviour — this slice REPLACES the mechanism that makes them pass (the sticky
 *       `latest === undefined` read becomes an explicit hydration edge) while every expected
 *       ring stays byte-identical. That is the point of re-sequencing them rather than
 *       rewriting them.
 *
 * WRONG IMPL KILLED: recorded per test, above each `it`.
 *
 * NO `new RegExp(...)`, no eval / no new Function (Semgrep bans them).
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { Connection, ConnectionOptions } from './net/connection';
import type { AuthoritativeStore, StoreBattle, StoreBattleMonster, StorePlayer } from './net/store';
import type { BugBundle, BugBundleInput } from './ui/bugBundle';
import type { PlaytestEvent } from './ui/eventRing';

// --- hoisted state shared with the mock factories --------------------------------------
const H = vi.hoisted(() => ({
  /** 64-char hex — the shape connection.ts hands main.ts's onReady. */
  identity: 'ab'.repeat(32),
  /** The ConnectionOptions main() passed to connect(): our handle on the real store. */
  connectOpts: null as ConnectionOptions | null,
  /** The observation channel. Implementation is installed (call-through) by the factory. */
  buildBugBundle: vi.fn<(input: BugBundleInput) => BugBundle>(),
}));

// The wasm pkg: every name main.ts imports, plus the four other exports of the real module
// (a sibling importer of the same specifier must not get `undefined`).
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
    // rb-8 / ADR-0212: `-> i64` crosses as a BigInt, so the stub is `1n`, not `1`.
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    predict_move: () => ({}),
    predict_tick: () => ({}),
    set_active_zone: () => undefined,
    start: () => undefined,
    step_ms: () => 200,
    // A minimal but VALID RawTileMap (TileMap.fromRaw rejects a ragged grid). main.ts only
    // reads `.zone_id` on this path — no zone switch is triggered by these tests.
    zone_map: (zoneId: number) => ({
      zone_id: zoneId,
      width: SIDE,
      height: SIDE,
      walkable: grid(true),
      grass: grid(false),
      warps: [],
    }),
  };
});

// The connection: capture the options object, hand back a Connection-shaped stub.
// sessionState() MUST be 'hidden' or main.ts's sessionGateBlocks() swallows the F9 keydown.
vi.mock('./net/connection', () => {
  const stub: Connection = {
    conn: undefined,
    live: () => undefined,
    identity: () => H.identity,
    linkFrozen: () => false,
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
  };
  return {
    connect: (opts: ConnectionOptions): Connection => {
      H.connectOpts = opts;
      return stub;
    },
  };
});

// The bundle assembler: real exports, but buildBugBundle wrapped in a call-through spy.
vi.mock('./ui/bugBundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/bugBundle')>();
  H.buildBugBundle.mockImplementation(actual.buildBugBundle);
  return { ...actual, buildBugBundle: H.buildBugBundle };
});

// Telemetry: keep NOOP_TELEMETRY and the types, but never bootstrap the OTel SDK (no network).
vi.mock('./observability/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./observability/telemetry')>();
  return {
    ...actual,
    // Never reached: the stubbed startClientTelemetry below ignores its loader. Throws
    // SYNCHRONOUSLY if a future edit does reach it, so there is no floating rejection.
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
});

// The renderer: constructed UNCONDITIONALLY at main.ts:2174, before the #app guard. Pixi
// under happy-dom is out of scope for this gate, so it is stubbed rather than trusted.
vi.mock('./render/world', () => {
  class WorldRenderer {
    init(): Promise<void> {
      return Promise.resolve();
    }
    setMap(): void {
      // no-op stub
    }
    render(): void {
      // no-op stub
    }
    resize(): void {
      // no-op stub
    }
    screenFor(): { x: number; y: number } {
      return { x: 0, y: 0 };
    }
    clear(): void {
      // no-op stub
    }
    destroy(): void {
      // no-op stub
    }
    get viewCount(): number {
      return 0;
    }
  }
  return { WorldRenderer };
});

// --- listener-cleanup harness ------------------------------------------------------------
type AddListener = (
  type: string,
  handler: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
) => void;

interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}

/** Record every addEventListener on `target` (delegating to the real one) so afterEach can
 *  detach each pair from the SAME target. Restores the original own-descriptor, if any. */
function recordListeners(target: EventTarget, sink: Recorded[]): () => void {
  const hadOwn = Object.hasOwn(target, 'addEventListener');
  const ownDesc = Object.getOwnPropertyDescriptor(target, 'addEventListener');
  const original = target.addEventListener.bind(target) as unknown as AddListener;
  const patched: AddListener = (type, handler, options) => {
    sink.push({ target, type, handler, options });
    original(type, handler, options);
  };
  (target as unknown as { addEventListener: AddListener }).addEventListener = patched;
  return () => {
    if (hadOwn && ownDesc !== undefined) {
      Object.defineProperty(target, 'addEventListener', ownDesc);
    } else {
      delete (target as unknown as { addEventListener?: AddListener }).addEventListener;
    }
  };
}

// --- fixtures ----------------------------------------------------------------------------
/** The all-zero wild opponent: `!==` the player identity, but with NO owned opponent party,
 *  so battleModel.isPvpBattle (party-guarded rule) is deterministically FALSE. */
const WILD_IDENTITY = '0'.repeat(64);
/** 17r-b / residual (e): a SECOND 64-char hex identity, distinct from both H.identity
 *  ('ab'…) and WILD_IDENTITY ('0'…). This is the identity a reconnect can MINT — a
 *  `continueAnonymously()` after a session-expired terminal, or the nh4 token-rejection
 *  suppression path, builds with a fresh anon identity while `hadSession` is already true. */
const IDENTITY_2 = 'cd'.repeat(32);
const B1 = 101n;
const B2 = 202n;

const MONSTER: StoreBattleMonster = {
  speciesId: 1,
  affinity: 'Neutral',
  level: 5,
  currentHp: 20,
  maxHp: 20,
  statHp: 20,
  statAttack: 5,
  statDefense: 5,
  statSpeed: 5,
  statSpAttack: 5,
  statSpDefense: 5,
  knownSkillIds: [1],
  status: null,
};

function makeBattle(battleId: bigint, outcome: string, turnNumber = 1): StoreBattle {
  return {
    battleId,
    playerIdentity: H.identity,
    opponentIdentity: WILD_IDENTITY,
    outcome,
    turnNumber,
    sideA: { active: 0, team: [MONSTER] },
    sideB: { active: 0, team: [MONSTER] },
    partyMonsterIds: [1n],
    // Empty by design: this is what makes isPvpBattle() false for a wild encounter.
    opponentMonsterIds: [],
    createdAtMs: 0n,
    weather: null,
  };
}

/** 17r-b: the same row, owned by an ARBITRARY identity. Built by spreading makeBattle() so
 *  `opponentMonsterIds: []` (the isPvpBattle=false guarantee) can never drift between the
 *  two constructors. Only `playerIdentity` moves — the opponent stays the wild sentinel, so
 *  the row is a participant row for exactly ONE identity. */
function makeBattleFor(
  identity: string,
  battleId: bigint,
  outcome: string,
  turnNumber = 1,
): StoreBattle {
  return { ...makeBattle(battleId, outcome, turnNumber), playerIdentity: identity };
}

function makePlayer(): StorePlayer {
  return { identity: H.identity, entityId: 1n, name: 'Player', online: true, lastInputSeq: 0n };
}

/** The ring events this gate reasons about, projected to STABLE fields only. */
type BattleProjection =
  | { readonly kind: 'battleStart'; readonly battleId: string; readonly isPvp: boolean }
  | {
      readonly kind: 'battleEnd';
      readonly battleId: string;
      readonly outcome: string;
      readonly turnCount: number;
    };

function battleEvents(events: readonly PlaytestEvent[]): BattleProjection[] {
  const out: BattleProjection[] = [];
  for (const e of events) {
    if (e.kind === 'battleStart') {
      out.push({ kind: 'battleStart', battleId: e.battleId, isPvp: e.isPvp });
    } else if (e.kind === 'battleEnd') {
      out.push({
        kind: 'battleEnd',
        battleId: e.battleId,
        outcome: e.outcome,
        turnCount: e.turnCount,
      });
    }
  }
  return out;
}

type ConnectEvent = Extract<PlaytestEvent, { readonly kind: 'connect' }>;

/** 17r-b / residual (e): the identity-hex of every `connect` event, oldest→newest.
 *  eventRing.ts:19,53 — `connect` is the ONE payload carrying an identity (U-3 allows it). */
function connectIdentities(events: readonly PlaytestEvent[]): string[] {
  return events.filter((e): e is ConnectEvent => e.kind === 'connect').map((e) => e.identity);
}

const startOf = (battleId: bigint): BattleProjection => ({
  kind: 'battleStart',
  battleId: battleId.toString(),
  isPvp: false,
});

const endOf = (battleId: bigint, outcome: string, turnCount: number): BattleProjection => ({
  kind: 'battleEnd',
  battleId: battleId.toString(),
  outcome,
  turnCount,
});

/** Render console.error arguments into a failure message WITHOUT JSON.stringify: the battle
 *  listener logs an Error (which JSON renders as `{}`) and store rows carry bigint fields
 *  (which JSON.stringify THROWS on — turning a useful red into an unrelated crash). */
function describeConsoleCalls(calls: readonly (readonly unknown[])[]): string {
  if (calls.length === 0) return '(nothing)';
  return calls
    .map((args) =>
      args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '),
    )
    .join(' | ');
}

// --- the suite ---------------------------------------------------------------------------
// NOTE (gate census): no `describe` title in this file may contain an `RSD17B-*` id — the
// 17r-b gate censuses vitest's `fullName` (describe + test title) by SUBSTRING and requires
// each id EXACTLY once. Ids live in `it` titles only.
describe('main.ts pt-b1 battle emit listener — post-reconnect reseed latch (16r-f + 17r-b)', () => {
  let recorded: Recorded[] = [];
  let restoreWindowAdd: (() => void) | undefined;
  let restoreDocumentAdd: (() => void) | undefined;
  let opts!: ConnectionOptions;
  let store!: AuthoritativeStore;
  let latestSpy!: MockInstance<(identity: string) => StoreBattle | undefined>;
  let errorSpy: MockInstance<(...args: unknown[]) => void> | undefined;

  beforeEach(async () => {
    recorded = [];
    H.connectOpts = null;
    H.buildBugBundle.mockClear();
    // Before the import: main() arms the frame loop with one rAF call at its very end.
    vi.stubGlobal('requestAnimationFrame', () => 0);
    restoreWindowAdd = recordListeners(window, recorded);
    restoreDocumentAdd = recordListeners(document, recorded);

    vi.resetModules();
    await import('./main');
    // main() awaits 17 dynamic view imports before connect() — poll, never a fixed delay.
    opts = await vi.waitFor(
      () => {
        const captured = H.connectOpts;
        if (captured === null) throw new Error('connect() has not been called by main() yet');
        return captured;
      },
      { timeout: 5_000, interval: 5 },
    );
    store = opts.store;
    latestSpy = vi.spyOn(store, 'latestPlayerBattle');
    // 17r-b: installed BEFORE onReady so the connect edge is inside the control's window.
    // vi.spyOn keeps the original implementation (call-through), so a real failure still
    // prints — the control OBSERVES console.error, it does not silence it.
    errorSpy = vi.spyOn(console, 'error') as unknown as MockInstance<(...args: unknown[]) => void>;
    opts.onReady(H.identity);
  });

  afterEach(() => {
    // THE CONSOLE CONTROL (17r-b, plan §7 reviewer B1 / red-team F1). main.ts:1828-1830
    // catches EVERY throw out of the battle-emit listener and reports it only here, so a
    // listener crashing on every flush can still leave a ring that matches the expected
    // projection (mutant #12 does exactly that). Asserted FIRST — before teardown — so it
    // judges the state the test body produced, and inside try/finally so a red here can
    // never skip the listener cleanup: a leaked module-scope keydown handler makes EVERY
    // later test fail pressF9AndReadRing's single-listener self-check, and that cascade
    // destroys the per-tooth attribution the mutation bite-proofs depend on.
    try {
      const calls = errorSpy?.mock.calls ?? [];
      expect(
        calls.length,
        'console.error must not be called during this test. The battle-emit listener wraps ' +
          'its whole body in try/catch (main.ts:1828), so a throw inside it is SWALLOWED and ' +
          'surfaces only as a console.error — every toEqual assertion in this file can pass ' +
          'while the listener is crashing on each flush. Do not delete this control to make a ' +
          `tooth green; fix the throw. logged: ${describeConsoleCalls(calls)}`,
      ).toBe(0);
    } finally {
      for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
      recorded = [];
      restoreDocumentAdd?.();
      restoreWindowAdd?.();
      restoreDocumentAdd = undefined;
      restoreWindowAdd = undefined;
      // Optional-chained on purpose: a failed beforeEach must not mask its own error here.
      latestSpy?.mockRestore();
      errorSpy?.mockRestore();
      errorSpy = undefined;
      H.connectOpts = null;
      H.buildBugBundle.mockClear();
      vi.unstubAllGlobals();
      document.body.innerHTML = '';
    }
  });

  /** Upsert the given battle rows and flush ONE batch. */
  function flushBattles(...battles: readonly StoreBattle[]): void {
    for (const b of battles) store.upsertBattle(b);
    store.flushBatch();
  }

  /** A flush that carries NO battle rows. store.reset() clears the dirty flag and flushBatch()
   *  no-ops while clean, so the player upsert is what makes this a REAL batch. The
   *  latestPlayerBattle assertions are the anti-vacuity control: they prove the listener body
   *  ran and genuinely observed `undefined` (not that the batch was skipped). */
  function flushWithNoBattleRows(): void {
    latestSpy.mockClear();
    store.upsertPlayer(makePlayer());
    store.flushBatch();
    expect(latestSpy).toHaveBeenCalled();
    const observed = latestSpy.mock.results.map((r) => r.value as StoreBattle | undefined);
    expect(observed.filter((b) => b !== undefined)).toEqual([]);
  }

  /** 17r-b: flush ONE battle row and PROVE the listener observed exactly it. The anti-vacuity
   *  twin of flushWithNoBattleRows, for the PRE-HYDRATION flushes of STALEROW / ONGOINGROW /
   *  REARM: without it, "the latch survived this flush" is indistinguishable from "this flush
   *  never reached the listener at all" (a clean store no-ops flushBatch), and the whole
   *  fixture would be vacuous. The id set — not the call count — is asserted, because the
   *  number of listeners that happen to read latestPlayerBattle in one batch is not this
   *  gate's business (main.ts:1852's ranked listener also can, when a profile row exists). */
  function flushObservingBattleId(battle: StoreBattle, expectedId: bigint): void {
    latestSpy.mockClear();
    store.upsertBattle(battle);
    store.flushBatch();
    expect(latestSpy).toHaveBeenCalled();
    const observed = latestSpy.mock.results.map((r) => r.value as StoreBattle | undefined);
    const defined = observed.filter((b): b is StoreBattle => b !== undefined);
    expect(
      [...new Set(defined.map((b) => b.battleId.toString()))],
      'ANTI-VACUITY: this pre-hydration flush must have REACHED the battle listener and made ' +
        'it read a DEFINED battle row — otherwise "the latch survived" proves nothing (a ' +
        'flush over a clean store no-ops, and the listener never runs)',
    ).toEqual([expectedId.toString()]);
  }

  /** Mirrors production: the connection empties the store, then invokes onReconnect() with
   *  THIS connection's identity — which a reconnect may have MINTED fresh (residual (e)). */
  function simulateReconnect(id: string = H.identity): void {
    store.reset();
    opts.onReconnect(id);
  }

  /** 17r-b: the hydration-complete edge. In production this fires from the batcher flush
   *  closure between the view reconcile and store.flushBatch(); here it is its own step. */
  function signalHydrated(): void {
    opts.onHydrated();
  }

  /** Press F9 and read the event ring out of the bundle main.ts assembled. */
  function pressF9AndReadRing(): readonly PlaytestEvent[] {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F9' }));
    // Harness self-check: exactly ONE live main.ts keydown listener. A stale listener from a
    // previous test's module instance would make this 2+ and corrupt every ring assertion.
    expect(H.buildBugBundle).toHaveBeenCalledTimes(1);
    return H.buildBugBundle.mock.calls[0][0].events;
  }

  // GREEN since 16r-f — the original EARS-1 + EARS-2 defect, now a REGRESSION PIN. (The
  // 16r-f-era "RED at fork" note that stood here described master BEFORE 16r-f shipped.)
  // RED at the 17r-b fork only for the harness reason: opts.onHydrated does not exist yet.
  // 17r-b RE-SEQUENCE: the empty flush stays BEFORE the signal on purpose — it now models a
  // flush landing ahead of the hydration edge, which is the strongest form of EARS-1.
  // WRONG IMPL KILLED: a branch that burns `battleReseedPending` on a flush where
  // latestPlayerBattle() returned undefined, so the battle rows that arrive on the NEXT flush
  // are treated as a brand-new battle and a second battleStart(B1) lands in the ring. Also
  // kills 17r-b mutant #2 (delete the hydration check and resolve on ANY post-reconnect
  // flush): the empty flush would resolve the latch and B1 would re-emit.
  it('T1 [EARS-1+EARS-2]: empty post-reconnect flush keeps the latch (no second start)', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1)]);
    H.buildBugBundle.mockClear();

    simulateReconnect();
    flushWithNoBattleRows(); // EARS-1: the latch must survive this pre-hydration flush
    signalHydrated();
    flushBattles(makeBattle(B1, 'Ongoing')); // EARS-2: no second battleStart

    const events = pressF9AndReadRing();
    expect(battleEvents(events)).toEqual([startOf(B1)]);
    // Proof the reconnect edge really ran the real onReconnect body (not a no-op stub).
    expect(events.filter((e) => e.kind === 'connect')).toHaveLength(2);
  });

  // GREEN (behaviourally) — ordering pin.
  // WRONG IMPL KILLED: capturing the previous battle id AFTER resetPredictionState() (which
  // nulls activeBattleId) captures null, so B1 no longer matches the captured id, falls through
  // to the emit logic and re-emits battleStart(B1).
  it('T2: a battle surviving the drop, seen on the FIRST post-reconnect flush, is silent', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    signalHydrated();
    flushBattles(makeBattle(B1, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1)]);
  });

  // GREEN (behaviourally) — kills the sticky-forever simplification, AND (17r-b, red-team F3)
  // it is one of only two pre-existing tests that prove the latch RESOLVES at all: under
  // mutant #3 (`onHydrated: () => {}` — the signal ignored) the latch never resolves, the
  // re-baseline never happens, activeBattleId stays null and the battleEnd is dropped.
  // WRONG IMPL KILLED: an implementation that keeps suppressing the re-baselined battle id
  // forever (never clearing the latch / the captured id after the match) swallows its
  // battleEnd, so the expected pair collapses to a lone battleStart.
  it('T3: after a silent re-baseline the same battle still emits its battleEnd later', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    signalHydrated();
    flushBattles(makeBattle(B1, 'Ongoing')); // silent re-baseline
    flushBattles(makeBattle(B1, 'SideAWins', 7));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1), endOf(B1, 'SideAWins', 7)]);
  });

  // GREEN — fresh-login regression pin. No reconnect, no hydration signal: green at the
  // 17r-b fork too, and the control that a latch armed at STARTUP would red.
  // WRONG IMPL KILLED: a fix that arms the reseed latch at startup (rather than only on
  // reconnect) would swallow the very first battleStart of a session. 17r-b restates it:
  // initialising `hydratedSinceReconnect = true` would NOT save such an implementation.
  it('T4: a fresh login emits battleStart for a new Ongoing wild battle (isPvp false)', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1)]);
  });

  // GREEN — end-pairing regression pin. No reconnect: green at the 17r-b fork too.
  // WRONG IMPL KILLED: a fix that clears activeBattleId while clearing the reseed state would
  // strand the terminal row with no witnessed start and drop the battleEnd.
  it('T5: start-to-finish with no reconnect emits battleStart then battleEnd', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    flushBattles(makeBattle(B1, 'SideAWins', 9));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1), endOf(B1, 'SideAWins', 9)]);
  });

  // GREEN (behaviourally) — kills the weaker "minimal" reading of EARS-1, and (17r-b,
  // red-team F3) the second of the two pre-existing tests that prove the latch RESOLVES:
  // under mutant #3 the latch stays armed and B2's battleStart is swallowed entirely.
  // WRONG IMPL KILLED: an implementation that survives the empty flush but then silently
  // re-baselines WHATEVER Ongoing battle it first observes swallows B2's battleStart — B2 did
  // not exist before the drop, so it is a genuinely new battle.
  it('T6: with no pre-drop battle, a NEW Ongoing battle after the empty flush still starts', () => {
    simulateReconnect();
    flushWithNoBattleRows();
    signalHydrated();
    flushBattles(makeBattle(B2, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B2)]);
  });

  // GREEN (behaviourally) — the latch must clear on ANY post-hydration observation, not only
  // a match. (16r-f wording: "on any DEFINITE observation" — 17r-b replaces the definition of
  // the resolving edge, not the outcome.)
  // Documented residual R2: the battle ended DURING the gap and activeBattleId was reset by
  // resetPredictionState, so no battleEnd is emitted for it — asserting that ABSENCE is the
  // current contract, not an oversight.
  // WRONG IMPL KILLED: an implementation that leaves the latch armed after a post-hydration
  // terminal observation stays armed into the next flush and silently baselines B2,
  // swallowing its battleStart.
  it('T7: a terminal row on the first post-reconnect flush clears the latch (no end)', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    signalHydrated();
    flushBattles(makeBattle(B1, 'SideAWins', 4)); // ended during the gap — no battleEnd (R2)
    flushBattles(makeBattle(B2, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1), startOf(B2)]);
  });

  // GREEN (behaviourally) — the empty-then-terminal composition of EARS-1 and T7.
  // WRONG IMPL KILLED: an implementation that clears the latch on the pre-hydration empty
  // flush AND one that never clears it on the post-hydration terminal observation both
  // diverge from this exact list.
  it('T7b: empty flush then a terminal row for the same battle emits no battleEnd', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    flushWithNoBattleRows();
    signalHydrated();
    flushBattles(makeBattle(B1, 'SideAWins', 4));
    flushBattles(makeBattle(B2, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1), startOf(B2)]);
  });

  // GREEN since 16r-f — a battle that STARTED during the gap. (The 16r-f-era "RED at fork"
  // note here described master BEFORE 16r-f shipped; it has been a regression pin since.)
  // WRONG IMPL KILLED: a reseed branch that matches ANY Ongoing battle adopts B2 as the
  // re-baselined battle and swallows the battleStart of a battle the player never saw begin.
  it('T8 [EARS-2 scope]: a DIFFERENT Ongoing battle after the drop emits its start', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    signalHydrated();
    flushBattles(makeBattle(B2, 'Ongoing')); // B1 is gone; B2 began during the gap

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1), startOf(B2)]);
  });

  // GREEN (behaviourally) — the double-reconnect guard. NO hydration signal between the two
  // reconnects, on purpose: that is what makes this fixture blind to the 17r-b re-arm defect
  // and RSD17B-REARM necessary (both reconnects here arm against the SAME un-hydrated
  // episode, so a reset moved inside the capture guard is unobservable).
  // WRONG IMPL KILLED: capturing the previous battle id on EVERY onReconnect (unguarded by the
  // already-pending latch) overwrites it with the null left by the FIRST reconnect's
  // resetPredictionState, re-opening the defect — B1 then no longer matches and re-emits.
  it('T9: two reconnects with no flush between still re-baseline the survivor silently', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    simulateReconnect();
    signalHydrated();
    flushBattles(makeBattle(B1, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1)]);
  });

  // GREEN (behaviourally) — two fully-RESOLVED reseed episodes. The teeth here are against
  // the CAPTURE-STALENESS / NEVER-CLEAR cheat class, which T9 cannot reach because T9's first
  // episode is never RESOLVED. This is the only pre-existing fixture with two fully-resolved
  // episodes, so it is the only one where the second episode's capture has to run again on a
  // DIFFERENT battle id.
  // WRONG IMPL KILLED:
  //   (a) "capture the drop-time battle id only on the first reconnect ever, never update it":
  //       the captured id stays B1, so episode 2's re-sight of B2 does not match, falls through
  //       to the emit logic and duplicates startOf(B2).
  //   (b) "resolution never clears battleReseedPending (and/or the captured id)": the latch is
  //       still pending at step 6, so the `if (!battleReseedPending)` guard SKIPS episode 2's
  //       capture, the captured id is stale/null, and step 7 duplicates startOf(B2) the same way.
  it('T10: two fully-resolved reseed episodes re-capture per episode (no duplicate start)', () => {
    flushBattles(makeBattle(B1, 'Ongoing')); // start B1
    simulateReconnect(); // episode 1 captures B1
    signalHydrated();
    flushBattles(makeBattle(B1, 'Ongoing')); // silent re-baseline — episode 1 RESOLVED
    flushBattles(makeBattle(B1, 'SideAWins', 5)); // end B1
    flushBattles(makeBattle(B2, 'Ongoing')); // start B2
    simulateReconnect(); // episode 2 must capture B2, not the stale B1
    signalHydrated();
    flushBattles(makeBattle(B2, 'Ongoing')); // silent re-baseline — no duplicate start

    expect(battleEvents(pressF9AndReadRing())).toEqual([
      startOf(B1),
      endOf(B1, 'SideAWins', 5),
      startOf(B2),
    ]);
  });

  // ==========================================================================================
  // 17r-b — ADR-0130 residual (d): the latch resolves on the HYDRATION EDGE, not on the first
  // defined read. `my_battle` is a Vec<Battle> of Anonymize-policy rows (schema.rs:428-441),
  // so >= 2 participant rows can hydrate ACROSS flushes and the row observed first need not be
  // the survivor.
  //
  // ⚠ FIXTURE DIRECTION IS LOAD-BEARING (orchestrator trace). store.latestPlayerBattle()
  // returns the HIGHEST battleId among the caller's participant rows (store.ts:928-938) and
  // upsertBattle never removes other rows (store.ts:602-605). So the SURVIVOR must be the
  // HIGHER id (B2 = 202n) and the wrong-row-first row the LOWER (B1 = 101n). The mirror-image
  // fixture (survivor low, stale row high) is NON-DISCRIMINATING: the high stale row would
  // still be `latest` on every later flush and the correct implementation would fail it.
  // ==========================================================================================

  // RED at fork (both reasons): opts.onHydrated does not exist, AND — once it does — 16r-f's
  // `if (latest === undefined) return;` resolves the latch on the pre-hydration B1 row.
  //
  // SEQUENCE: B2 Ongoing (start B2) -> reconnect (captures B2) -> flush B1 SideAWins,4 ONLY
  //   (PRE-hydration; anti-vacuity: the listener ran and read a DEFINED row whose id is B1)
  //   -> hydrated -> flush(B1 terminal + B2 Ongoing) -> flush B2 SideBWins,6.
  //
  // CORRECT IMPL ring:            [start B2, end B2 SideBWins 6]
  //   pre-hydration flush returns with the latch ARMED; the post-hydration flush reads
  //   latest = B2 (highest id) == the survivor, so it re-baselines SILENTLY; the terminal
  //   flush then pairs the end against the re-baselined activeBattleId.
  // WRONG IMPL KILLED (a) — 16r-f `latest === undefined` stickiness / mutant #1 / mutant #1b
  //   (`!hydratedSinceReconnect && latest === undefined`) / mutant #2 (no hydration check):
  //   the pre-hydration flush sees a DEFINED B1, burns the latch (B1 !== survivor B2, and B1
  //   is terminal with activeBattleId null, so it emits nothing), and the next flush treats
  //   the surviving B2 as brand new  ->  [start B2, START B2, end B2].
  //   FAILS AT INDEX 1: expected endOf(B2,'SideBWins',6), got startOf(B2).
  // WRONG IMPL KILLED (b) — mutant #3, the signal ignored (`onHydrated: () => {}`), or a latch
  //   that never resolves at all: every later flush returns early  ->  [start B2].
  //   FAILS AT INDEX 1: expected endOf(B2,…), got undefined (length 1 vs 2). The TRAILING END
  //   is what proves the RESOLVING half — without it this fixture would accept a latch that
  //   is armed forever.
  it('RSD17B-STALEROW [EARS-d]: a stale terminal row hydrating before the survivor must not resolve the latch', () => {
    flushBattles(makeBattle(B2, 'Ongoing'));
    simulateReconnect();
    flushObservingBattleId(makeBattle(B1, 'SideAWins', 4), B1); // pre-hydration, WRONG row
    signalHydrated();
    flushBattles(makeBattle(B1, 'SideAWins', 4), makeBattle(B2, 'Ongoing'));
    flushBattles(makeBattle(B2, 'SideBWins', 6));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B2), endOf(B2, 'SideBWins', 6)]);
  });

  // RED at fork (both reasons), same as STALEROW.
  //
  // WHY A SECOND FIXTURE: STALEROW's wrong-first row is TERMINAL, so under the 16r-f clause it
  // burns the latch SILENTLY (a terminal row with activeBattleId === null emits nothing) and
  // the spurious start only appears one flush later. Here the wrong-first row is ONGOING — a
  // legal shape (store.ts:895-900: participants match in EITHER role, so a player can hold two
  // simultaneous Ongoing rows) — and the 16r-f clause emits a battleStart for a battle the
  // player is not in, IMMEDIATELY. Different emission site, different mutant signature.
  //
  // SEQUENCE: B2 Ongoing (start B2) -> reconnect (captures B2) -> flush B1 Ongoing ONLY
  //   (PRE-hydration, lower id, anti-vacuity defined-B1) -> hydrated -> flush(B1 + B2 Ongoing)
  //   -> flush B2 SideAWins,3.
  //
  // CORRECT IMPL ring:            [start B2, end B2 SideAWins 3]
  // WRONG IMPL KILLED (a) — mutants #1 / #1b / #2: the pre-hydration flush resolves on B1,
  //   B1 !== survivor B2 so it falls through to the emit logic and starts B1; the next flush
  //   reads B2 (highest id) with an un-armed latch and starts it too
  //   ->  [start B2, START B1, start B2, end B2].  FAILS AT INDEX 1 (startOf(B1)).
  // WRONG IMPL KILLED (b) — mutant #3 / never-resolve:  ->  [start B2].  FAILS AT INDEX 1
  //   (length 1 vs 2).
  it('RSD17B-ONGOINGROW [EARS-d]: an Ongoing NON-survivor row observed pre-hydration keeps the latch', () => {
    flushBattles(makeBattle(B2, 'Ongoing'));
    simulateReconnect();
    flushObservingBattleId(makeBattle(B1, 'Ongoing'), B1); // pre-hydration, WRONG row
    signalHydrated();
    flushBattles(makeBattle(B1, 'Ongoing'), makeBattle(B2, 'Ongoing'));
    flushBattles(makeBattle(B2, 'SideAWins', 3));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B2), endOf(B2, 'SideAWins', 3)]);
  });

  // RED at fork (harness reason: two signalHydrated calls). Behaviourally this is the tooth
  // for plan §7 mutant #11: `hydratedSinceReconnect = false` must be reset UNCONDITIONALLY in
  // onReconnect, OUTSIDE the `if (!battleReseedPending)` guard that (per 16r-f / T9) still
  // protects only the `reseedPrevBattleId` capture.
  //
  // SEQUENCE: B2 Ongoing (start B2) -> reconnect#1 (captures B2, arms) -> hydrated (episode 1
  //   hydrates, NO flush) -> reconnect#2 (latch still pending: the capture is correctly
  //   SKIPPED so the survivor stays B2; the hydration flag must nevertheless go back to false)
  //   -> flush B1 SideAWins,4 ONLY (pre-hydration for EPISODE 2, anti-vacuity defined-B1)
  //   -> hydrated -> flush(B1 terminal + B2 Ongoing).
  //
  // CORRECT IMPL ring:            [start B2]
  //   Episode 2's pre-hydration flush returns; the post-hydration flush reads B2 == survivor
  //   and re-baselines silently.
  // WRONG IMPL KILLED — mutant #11 / #4 (the reset moved inside the capture guard): reconnect
  //   #2 skips the guard body, so hydratedSinceReconnect is STILL true from episode 1. The B1
  //   pre-hydration flush then resolves the latch (B1 is terminal and does not match the
  //   survivor, so it emits nothing — the burn is silent), and the final flush sees an
  //   un-armed latch with a brand-new-looking B2  ->  [start B2, START B2].
  //   FAILS AT LENGTH: expected 1 event, got 2.
  // WHY T9 CANNOT SEE THIS: T9 has no hydration signal between its two reconnects, so the flag
  // is false in both the correct and the mutated implementation.
  it('RSD17B-REARM: a second reconnect re-arms the latch against the CURRENT hydration episode', () => {
    flushBattles(makeBattle(B2, 'Ongoing'));
    simulateReconnect(); // episode 1
    signalHydrated(); // episode 1 hydrates — but no flush observes it
    simulateReconnect(); // episode 2 — capture skipped, hydration flag must RESET
    flushObservingBattleId(makeBattle(B1, 'SideAWins', 4), B1); // pre-hydration for episode 2
    signalHydrated();
    flushBattles(makeBattle(B1, 'SideAWins', 4), makeBattle(B2, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B2)]);
  });

  // RED at fork for the harness reason ONLY (opts.onHydrated is missing). Behaviourally this
  // is a REGRESSION PIN, green under both 16r-f's `latest === undefined` clause and the
  // correct 17r-b implementation — and that is exactly why it exists: the 17r-b rewrite
  // REMOVES the clause that made an `undefined` read unreachable in the resolved branch, so
  // the resolved branch must handle `latest === undefined` explicitly. A player with NO battle
  // rows is the COMMON reconnect, not an edge case.
  //
  // SEQUENCE: (no pre-drop battle) reconnect -> hydrated -> flushWithNoBattleRows()
  //   -> flush B2 Ongoing.
  //
  // CORRECT IMPL ring:            [start B2]   and console.error NOT called.
  //   The no-rows flush resolves the latch (hydration has happened), reads `latest ===
  //   undefined`, matches nothing, and returns via the existing `if (!latest) return;`.
  // WRONG IMPL KILLED — mutant #12, dropping the optional chain:
  //   `if (latest.outcome === 'Ongoing' && latest.battleId === survivedId)` throws
  //   `TypeError: Cannot read properties of undefined (reading 'outcome')` on the no-rows
  //   flush. main.ts:1828 SWALLOWS it into console.error, the latch is left resolved-ish, and
  //   the next flush still starts B2 — so the RING IS UNCHANGED and the toEqual below passes.
  //   The console assertion is the ONLY thing that catches it. Asserted in-test (not only in
  //   the global afterEach control) so the mutation bite-proof can pin this mutant to THIS
  //   tooth label rather than to a hook failure.
  it('RSD17B-NOBATTLE: a post-hydration flush with NO battle rows resolves the latch without throwing', () => {
    simulateReconnect();
    signalHydrated();
    flushWithNoBattleRows();
    flushBattles(makeBattle(B2, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B2)]);
    expect(
      describeConsoleCalls(errorSpy?.mock.calls ?? []),
      'the battle listener must not THROW on a post-hydration flush that observes no battle ' +
        'rows at all — the resolved reseed branch reads `latest?.outcome`, and a player with ' +
        'no battle rows is the COMMON reconnect. main.ts:1828 catches the throw, so the ring ' +
        'above stays correct and this assertion is the only witness',
    ).toBe('(nothing)');
  });

  // ==========================================================================================
  // 17r-b — ADR-0130 residual (e): a reconnect can MINT a new anon identity
  // (continueAnonymously() after a session-expired terminal, or the nh4 token-rejection
  // suppression path) while `hadSession` is already true. connection.ts:659 reassigns its own
  // module-local identity on EVERY connect; before this slice `opts.onReconnect()` carried no
  // identity and main.ts kept the stale one, deafening every identity-gated listener —
  // INCLUDING this reseed listener.
  // ==========================================================================================

  // RED at fork (both reasons): opts.onHydrated is missing, and `onReconnect` takes no
  // identity, so main.ts's module-local `identity` stays H.identity.
  //
  // SEQUENCE: onReady(H.identity) [beforeEach] -> reconnect(IDENTITY_2) -> hydrated
  //   -> flush a battle owned by IDENTITY_2.
  //
  // CORRECT IMPL:  battleEvents === [start B2]
  //                connect identities === [H.identity, IDENTITY_2]
  //   The latch resolves against a null survivor (no pre-drop battle), falls through, and the
  //   listener reads latestPlayerBattle(IDENTITY_2) — which only matches because main.ts
  //   reassigned `identity` from the callback argument.
  // WRONG IMPL KILLED (a) — mutant #5, `identity = id;` deleted: the listener keeps querying
  //   latestPlayerBattle(H.identity), which is NOT a participant of the new row, so it reads
  //   undefined on every flush and NOTHING is ever emitted  ->  battleEvents === [].
  //   FAILS ON THE FIRST assertion (length 0 vs 1).
  // WRONG IMPL KILLED (b) — mutant #6, `identity = id;` moved AFTER
  //   `eventRing.push(makeConnect(identity))`: by flush time `identity` IS IDENTITY_2, so the
  //   battle assertion PASSES; the connect event recorded the stale hex instead
  //   ->  [H.identity, H.identity].  FAILS ON THE SECOND assertion. The two clauses are
  //   ordered deliberately (expect throws on the first failure): (a) is a behaviour break,
  //   (b) is a telemetry break, and each has its own witness.
  it('RSD17B-IDROT [EARS-e]: a reconnect that mints a NEW identity re-targets the listener and the connect event', () => {
    simulateReconnect(IDENTITY_2);
    signalHydrated();
    flushBattles(makeBattleFor(IDENTITY_2, B2, 'Ongoing'));

    const events = pressF9AndReadRing();
    expect(
      battleEvents(events),
      'after a reconnect that minted a new identity, the battle-emit listener must query the ' +
        'store with the NEW identity — main.ts must assign `identity = id` from the ' +
        'onReconnect argument (ADR-0130 residual (e)). With the stale identity the new ' +
        'battle is not a participant row and nothing is ever emitted',
    ).toEqual([startOf(B2)]);
    expect(
      connectIdentities(events),
      'the reconnect`s `connect` ring event must carry the NEW identity hex (eventRing.ts:53). ' +
        'main.ts pushes makeConnect(identity) at the TAIL of the onReconnect body, so the ' +
        'reassignment must happen BEFORE it — otherwise the F9 bundle records the session as ' +
        'still belonging to the old identity and the H3 correlation silently points at a ' +
        'connection that no longer exists',
    ).toEqual([H.identity, IDENTITY_2]);
  });

  // RED at fork twice over: `opts.onHydrated` does not exist (the TypeError you see first,
  // thrown from signalHydrated() in the test body — not from inside the listener`s try/catch),
  // and — once it does — `onReconnect` carries no identity.
  //
  // WHY A SECOND (e) FIXTURE: IDROT`s not-reassigned mutant fails LOUDLY (nothing is emitted).
  // This one fails SILENTLY and is the shape that actually ships: the OLD identity still has a
  // live participant row (an "orphan" row for a battle the previous session was in, which the
  // server has not GC'd), so the stale-identity listener finds it, decides it is the survivor,
  // re-baselines against it, and the NEW identity`s battle never starts.
  //
  // SEQUENCE: flush B1 Ongoing for H.identity (start B1) -> reconnect(IDENTITY_2) -> hydrated
  //   -> flush B1 Ongoing again (H.identity`s orphan row) -> flush B2 Ongoing for IDENTITY_2.
  //
  // CORRECT IMPL ring:            [start B1, start B2]
  //   The orphan flush reads latestPlayerBattle(IDENTITY_2) === undefined (IDENTITY_2 is not a
  //   participant of B1), resolves the latch against survivor B1, matches nothing, and returns
  //   through the `latest?.` null guard (see RSD17B-NOBATTLE — this fixture is the second
  //   place mutant #12 throws). The B2 flush then starts B2.
  // WRONG IMPL KILLED — mutant #5, `identity = id;` deleted: the orphan flush reads
  //   latestPlayerBattle(H.identity) === B1 Ongoing, which MATCHES the captured survivor, so
  //   it re-baselines silently (activeBattleId = B1). The final flush reads B1 again (B2 is
  //   not H.identity`s row, so `latest` is still B1, unchanged and Ongoing) and emits nothing
  //   ->  [start B1].  FAILS AT INDEX 1 (length 1 vs 2).
  it('RSD17B-ORPHAN [EARS-e]: after an identity rotation the previous identity row no longer re-baselines the latch', () => {
    flushBattles(makeBattle(B1, 'Ongoing')); // owned by H.identity — start B1
    simulateReconnect(IDENTITY_2);
    signalHydrated();

    latestSpy.mockClear();
    flushBattles(makeBattle(B1, 'Ongoing')); // the OLD identity`s orphan row
    // ANTI-VACUITY, and the most direct witness of residual (e) there is: the orphan flush
    // must have REACHED the battle listener (a flush nobody handles proves nothing), and the
    // listener must have queried the store with the NEW identity. Under mutant #5 this reds
    // FIRST, naming the identity rather than the ring — which is the diagnosis you want.
    expect(
      latestSpy,
      'the battle listener must query store.latestPlayerBattle(<NEW identity>) after a ' +
        'reconnect that minted one. If this reds with the old hex, main.ts never reassigned ' +
        'its module-local `identity` from the onReconnect argument (ADR-0130 residual (e)); ' +
        'if it reds with no calls at all, this flush never reached the listener and the ' +
        'assertion below would be vacuous',
    ).toHaveBeenCalledWith(IDENTITY_2);

    flushBattles(makeBattleFor(IDENTITY_2, B2, 'Ongoing'));

    expect(
      battleEvents(pressF9AndReadRing()),
      'the orphan row of the PREVIOUS identity must not satisfy the reseed re-baseline for ' +
        'the NEW one: main.ts must query the store with the reassigned identity, so the ' +
        'orphan is invisible (undefined) and the new session`s battle still starts',
    ).toEqual([startOf(B1), startOf(B2)]);
  });
});
