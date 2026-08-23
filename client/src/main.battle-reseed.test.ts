// @vitest-environment happy-dom
/**
 * main.battle-reseed.test.ts — RUNTIME gate over main.ts's pt-b1 battle-emit listener
 * (slice 16r-f; ADR-0130 reseed latch).
 *
 * SOURCE OF TRUTH: 16r-f EARS-1 / EARS-2, plus the two plan-review additions (T3
 * sticky-forever cheat-kill, T9 double-reconnect guard) and the implementation-review
 * addition (T10 two fully-RESOLVED reseed episodes).
 *   EARS-1: WHEN a reconnect completes and the first store flush carries no battle rows
 *           THE reseed latch SHALL survive until a flush that observes definite battle state.
 *   EARS-2: WHEN an Ongoing battle survives a reconnect THE event ring SHALL NOT receive a
 *           new battleStart.
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
 * drop and THEN invokes opts.onReconnect(). These tests call `store.reset()` followed by the
 * captured `onReconnect()` directly. That is equivalent for the listener under test, which
 * observes only (a) an emptied store and (b) the onReconnect body having run.
 *
 * OBSERVATION CHANNEL: the F9 bug bundle. buildBugBundle is spied WITH call-through, so each
 * test reads the REAL EventRing snapshot main.ts hands it. Assertions project only stable
 * fields (kind / battleId / outcome / turnCount / isPvp) — never tMs / tSeq, which come from
 * a real Date.now() clock.
 *
 * DELIBERATELY OMITTED: a zone-switch/reseed same-flush interleave test. Its realistic
 * rot-mode (nulling the captured prev id inside resetPredictionState) is already killed by
 * T2, and a zone switch mid-battle is server-rejected (movement.rs is_in_ongoing_battle).
 *
 * RED REASON: T1 and T8 fail against the current main.ts:1729-1735 reseed branch, which
 * (a) burns the latch even when latestPlayerBattle() returned undefined, and (b) silently
 * re-baselines ANY Ongoing battle instead of only the one that survived the drop.
 * T2 / T3 / T4 / T5 / T6 / T7 / T7b / T9 / T10 are GREEN at the fork — regression pins and
 * cheat-kills for the wrong implementations the fix could otherwise take.
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

// The wasm pkg: every name main.ts imports, plus the three other exports of the real module
// (a sibling importer of the same specifier must not get `undefined`).
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
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

// --- the suite ---------------------------------------------------------------------------
describe('main.ts pt-b1 battle emit listener — post-reconnect reseed latch (16r-f)', () => {
  let recorded: Recorded[] = [];
  let restoreWindowAdd: (() => void) | undefined;
  let restoreDocumentAdd: (() => void) | undefined;
  let opts!: ConnectionOptions;
  let store!: AuthoritativeStore;
  let latestSpy!: MockInstance<(identity: string) => StoreBattle | undefined>;

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
    opts.onReady(H.identity);
  });

  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    restoreDocumentAdd?.();
    restoreWindowAdd?.();
    restoreDocumentAdd = undefined;
    restoreWindowAdd = undefined;
    // Optional-chained on purpose: a failed beforeEach must not mask its own error here.
    latestSpy?.mockRestore();
    H.connectOpts = null;
    H.buildBugBundle.mockClear();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
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

  /** Mirrors production: the connection empties the store, then invokes onReconnect(). */
  function simulateReconnect(): void {
    store.reset();
    opts.onReconnect();
  }

  /** Press F9 and read the event ring out of the bundle main.ts assembled. */
  function pressF9AndReadRing(): readonly PlaytestEvent[] {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F9' }));
    // Harness self-check: exactly ONE live main.ts keydown listener. A stale listener from a
    // previous test's module instance would make this 2+ and corrupt every ring assertion.
    expect(H.buildBugBundle).toHaveBeenCalledTimes(1);
    return H.buildBugBundle.mock.calls[0][0].events;
  }

  // RED at fork — THE defect (EARS-1 + EARS-2).
  // WRONG IMPL KILLED: master's branch burns `battleReseedPending` on a flush where
  // latestPlayerBattle() returned undefined, so the battle rows that arrive on the NEXT flush
  // are treated as a brand-new battle and a second battleStart(B1) lands in the ring.
  it('T1 [EARS-1+EARS-2]: empty post-reconnect flush keeps the latch (no second start)', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1)]);
    H.buildBugBundle.mockClear();

    simulateReconnect();
    flushWithNoBattleRows(); // EARS-1: the latch must survive this flush
    flushBattles(makeBattle(B1, 'Ongoing')); // EARS-2: no second battleStart

    const events = pressF9AndReadRing();
    expect(battleEvents(events)).toEqual([startOf(B1)]);
    // Proof the reconnect edge really ran the real onReconnect body (not a no-op stub).
    expect(events.filter((e) => e.kind === 'connect')).toHaveLength(2);
  });

  // GREEN at fork — ordering pin.
  // WRONG IMPL KILLED: capturing the previous battle id AFTER resetPredictionState() (which
  // nulls activeBattleId) captures null, so B1 no longer matches the captured id, falls through
  // to the emit logic and re-emits battleStart(B1).
  it('T2: a battle surviving the drop, seen on the FIRST post-reconnect flush, is silent', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    flushBattles(makeBattle(B1, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1)]);
  });

  // GREEN at fork — kills the sticky-forever simplification.
  // WRONG IMPL KILLED: an implementation that keeps suppressing the re-baselined battle id
  // forever (never clearing the latch / the captured id after the match) swallows its
  // battleEnd, so the expected pair collapses to a lone battleStart.
  it('T3: after a silent re-baseline the same battle still emits its battleEnd later', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    flushBattles(makeBattle(B1, 'Ongoing')); // silent re-baseline
    flushBattles(makeBattle(B1, 'SideAWins', 7));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1), endOf(B1, 'SideAWins', 7)]);
  });

  // GREEN — fresh-login regression pin.
  // WRONG IMPL KILLED: a fix that arms the reseed latch at startup (rather than only on
  // reconnect) would swallow the very first battleStart of a session.
  it('T4: a fresh login emits battleStart for a new Ongoing wild battle (isPvp false)', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1)]);
  });

  // GREEN — end-pairing regression pin.
  // WRONG IMPL KILLED: a fix that clears activeBattleId while clearing the reseed state would
  // strand the terminal row with no witnessed start and drop the battleEnd.
  it('T5: start-to-finish with no reconnect emits battleStart then battleEnd', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    flushBattles(makeBattle(B1, 'SideAWins', 9));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1), endOf(B1, 'SideAWins', 9)]);
  });

  // GREEN at fork — kills the weaker "minimal" reading of EARS-1.
  // WRONG IMPL KILLED: an implementation that survives the empty flush but then silently
  // re-baselines WHATEVER Ongoing battle it first observes swallows B2's battleStart — B2 did
  // not exist before the drop, so it is a genuinely new battle.
  it('T6: with no pre-drop battle, a NEW Ongoing battle after the empty flush still starts', () => {
    simulateReconnect();
    flushWithNoBattleRows();
    flushBattles(makeBattle(B2, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B2)]);
  });

  // GREEN at fork — the latch must clear on ANY definite observation, not only a match.
  // Documented residual R2: the battle ended DURING the gap and activeBattleId was reset by
  // resetPredictionState, so no battleEnd is emitted for it — asserting that ABSENCE is the
  // current contract, not an oversight.
  // WRONG IMPL KILLED: an implementation that leaves the latch armed after observing a
  // terminal row stays armed into the next flush and silently baselines B2, swallowing its
  // battleStart.
  it('T7: a terminal row on the first post-reconnect flush clears the latch (no end)', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    flushBattles(makeBattle(B1, 'SideAWins', 4)); // ended during the gap — no battleEnd (R2)
    flushBattles(makeBattle(B2, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1), startOf(B2)]);
  });

  // GREEN at fork — the empty-then-terminal composition of EARS-1 and T7.
  // WRONG IMPL KILLED: an implementation that clears the latch on the empty flush AND one that
  // never clears it on the terminal observation both diverge from this exact list.
  it('T7b: empty flush then a terminal row for the same battle emits no battleEnd', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    flushWithNoBattleRows();
    flushBattles(makeBattle(B1, 'SideAWins', 4));
    flushBattles(makeBattle(B2, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1), startOf(B2)]);
  });

  // RED at fork — a battle that STARTED during the gap.
  // WRONG IMPL KILLED: master's reseed branch matches ANY Ongoing battle, so it adopts B2 as
  // the re-baselined battle and swallows the battleStart of a battle the player never saw begin.
  it('T8 [EARS-2 scope]: a DIFFERENT Ongoing battle after the drop emits its start', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    flushBattles(makeBattle(B2, 'Ongoing')); // B1 is gone; B2 began during the gap

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1), startOf(B2)]);
  });

  // GREEN at fork — the double-reconnect guard.
  // WRONG IMPL KILLED: capturing the previous battle id on EVERY onReconnect (unguarded by the
  // already-pending latch) overwrites it with the null left by the FIRST reconnect's
  // resetPredictionState, re-opening the defect — B1 then no longer matches and re-emits.
  it('T9: two reconnects with no flush between still re-baseline the survivor silently', () => {
    flushBattles(makeBattle(B1, 'Ongoing'));
    simulateReconnect();
    simulateReconnect();
    flushBattles(makeBattle(B1, 'Ongoing'));

    expect(battleEvents(pressF9AndReadRing())).toEqual([startOf(B1)]);
  });

  // GREEN at fork (traced): master's episode-2 reseed branch burns the latch and silently
  // baselines any Ongoing battle, which happens to produce this same list. The teeth here are
  // against the CAPTURE-STALENESS / NEVER-CLEAR cheat class, which T9 cannot reach because T9's
  // first episode is never RESOLVED (no flush between its two reconnects). This is the only
  // fixture with two fully-resolved episodes, so it is the only one where the second episode's
  // capture has to run again on a DIFFERENT battle id.
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
    flushBattles(makeBattle(B1, 'Ongoing')); // silent re-baseline — episode 1 RESOLVED
    flushBattles(makeBattle(B1, 'SideAWins', 5)); // end B1
    flushBattles(makeBattle(B2, 'Ongoing')); // start B2
    simulateReconnect(); // episode 2 must capture B2, not the stale B1
    flushBattles(makeBattle(B2, 'Ongoing')); // silent re-baseline — no duplicate start

    expect(battleEvents(pressF9AndReadRing())).toEqual([
      startOf(B1),
      endOf(B1, 'SideAWins', 5),
      startOf(B2),
    ]);
  });
});
