// @vitest-environment happy-dom
// shell/session — the server link main.ts drives: the store, the identity, the connection handle,
// hydration, the ready promise, the guarded send and the two session-event latches. A real boot of
// main.ts on the real index.html shell opens the (mocked) connection and reports its lifecycle; the
// suite reads the module back through `./session` in the same module registry and checks it is
// the instance the shell drives: the link main() mounted, the store it handed to `connect`, and
// the latch steps main.ts registered on that store. A second block imports the module on its own
// (no boot) and checks its owner functions, steps, predicates and guarded send directly.
// Harness: feedback.test.ts's pattern (vi.resetModules + a fresh import per boot, one
// controllable clock and rAF, a stubbed wasm pkg, SDK connection, telemetry and renderer).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  connectionRecordingMock,
  frame,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../../test-util/mainBootHarness';
import type { WasmMoveInput } from '../convert/convert';
import type { Connection, ConnectionOptions } from '../net/connection';
import type { StoreBattle, StoreBattleMonster, StoreProfile } from '../net/store';
import type { OutcomeLine } from '../ui/boxView';
import type { PlaytestEvent } from '../ui/eventRing';
import type { SessionState } from '../ui/sessionModel';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
  /** The object the mocked `connect` returned to main(), the handle main() mounts. */
  link: null as Connection | null,
}));

// The 17 `tactics_*` exports the rules port binds (`bindTacticsRules` refuses a pkg missing any).
vi.mock('../../../client-wasm/pkg/client_wasm.js', () => ({
  ...wasmPkgWalkingMock(),
  tactics_map: () => ({
    width: 7,
    height: 5,
    tiles: [],
    spawn_a: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ],
    spawn_b: [],
  }),
  tactics_fresh_budget: () => ({ ap: 6, strides_used: 0, attacks: 0, last: null }),
  tactics_unit: (row: unknown) => row,
  tactics_targets: () => ({ Ok: [] }),
  tactics_path: () => ({ Err: 'Unreachable' }),
  tactics_disengage: () => ({ Ok: false }),
  tactics_flank: () => false,
  tactics_forecast: () => ({}),
  tactics_recruit_odds: () => ({ Err: { UnknownUnit: { id: 0 } } }),
  tactics_ai_plan: () => [],
  tactics_recruit_targets: () => [],
  tactics_is_exhausted: () => false,
  tactics_plan: () => ({ Err: 'ZeroStrides' }),
  tactics_overlays: () => ({
    reach1: [],
    reach2: [],
    range: [],
    aoe: [],
    danger: [],
    shield: [],
    intents: [],
  }),
  tactics_tuning: () => ({ surge_start_round: 9, wild_round_cap: 30, autopass_forfeit: 4 }),
  tactics_next_initiative: () => [],
  tactics_deploy_slots: () => 3,
}));

// The harness's recording connection, with the returned handle kept in `H.link` so a test can
// check it is the one main() mounted.
vi.mock('../net/connection', () => {
  const recording = connectionRecordingMock(H);
  return {
    connect: (o: ConnectionOptions): Connection => {
      const link = recording.connect(o);
      H.link = link;
      return link;
    },
  };
});

vi.mock('../observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('../observability/telemetry')>()),
);

vi.mock('../render/world', () => worldRendererMock());

type Session = typeof import('./session');
type Feedback = typeof import('./feedback');
type Link = Parameters<Session['adoptConnection']>[0];

// --- fixtures ----------------------------------------------------------------------------------
/** A second identity: the one a reconnect can mint. */
const IDENTITY_2 = 'cd'.repeat(32);
/** A PvP opponent: an owned party and an identity that is not the player's. */
const OPPONENT = 'ef'.repeat(32);
/** The wild opponent: no owned party, so the battle is not PvP. */
const WILD = '0'.repeat(64);
const B1 = 101n;
const PVP_DONE = 303n;
const PVP_LIVE = 404n;

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

/** A wild battle row of the own player. */
function wildBattle(battleId: bigint, outcome: string): StoreBattle {
  return {
    battleId,
    playerIdentity: H.identity,
    opponentIdentity: WILD,
    outcome,
    turnNumber: 1,
    sideA: { active: 0, team: [MONSTER] },
    sideB: { active: 0, team: [MONSTER] },
    partyMonsterIds: [1n],
    opponentMonsterIds: [],
    createdAtMs: 0n,
    weather: null,
  };
}

/** A PvP battle row of the own player. */
function pvpBattle(battleId: bigint, outcome: string): StoreBattle {
  return { ...wildBattle(battleId, outcome), opponentIdentity: OPPONENT, opponentMonsterIds: [9n] };
}

const profileOf = (identity: string, rating: number): StoreProfile => ({
  identity,
  name: 'P',
  rating,
  wins: 0,
  losses: 0,
});

/** The ring events the two latches push, projected to stable fields (no tMs / tSeq). */
type LatchEvent =
  | { readonly kind: 'battleStart'; readonly battleId: string; readonly isPvp: boolean }
  | {
      readonly kind: 'battleEnd';
      readonly battleId: string;
      readonly outcome: string;
      readonly turnCount: number;
    }
  | { readonly kind: 'rankedMatch'; readonly battleId: string; readonly ratingDelta: number };

function latchEvents(events: readonly PlaytestEvent[]): LatchEvent[] {
  const out: LatchEvent[] = [];
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
    } else if (e.kind === 'rankedMatch') {
      out.push({ kind: 'rankedMatch', battleId: e.battleId, ratingDelta: e.ratingDelta });
    }
  }
  return out;
}

const wildStart = (battleId: bigint): LatchEvent => ({
  kind: 'battleStart',
  battleId: battleId.toString(),
  isPvp: false,
});

/** The identity of every `connect` edge on the ring, oldest first. */
function connectIdentities(events: readonly PlaytestEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) if (e.kind === 'connect') out.push(e.identity);
  return out;
}

/** Whether `p` has settled, after the reactions already due have run. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

/** A connection handle whose session state, freeze and live handle the test sets. */
interface LinkState {
  session: SessionState;
  frozen: boolean;
  live: boolean;
}
function fakeLink(state: LinkState, reducers: object): Link {
  const handle = { reducers };
  return {
    live: () => (state.live ? handle : undefined),
    linkFrozen: () => state.frozen,
    sessionState: () => state.session,
  } as unknown as Link;
}

// --- harness ------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

function recordListeners(target: EventTarget): void {
  const own = Object.getOwnPropertyDescriptor(target, 'addEventListener');
  const original = target.addEventListener.bind(target);
  (target as unknown as { addEventListener: typeof original }).addEventListener = (
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    recorded.push({ target, type, handler, options });
    original(type, handler, options);
  };
  restorers.push(() => {
    if (own !== undefined) Object.defineProperty(target, 'addEventListener', own);
    else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
  });
}

let opts: ConnectionOptions;
/** The frame clock: every frame this file runs is at `T`, which only moves forward. */
let T = 1000;

/** Run one shell frame `ms` after the last one. */
function advance(ms: number): void {
  T += ms;
  frame(T);
}

function teardown(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  raf.cb = null;
  localStorage.clear();
  document.documentElement.style.removeProperty('--mr-text-step');
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
  vi.resetModules();
}

interface Booted {
  readonly s: Session;
  readonly fb: Feedback;
}

/** Boot a fresh main.ts on the real shell up to the moment main() has opened the connection (no
 *  join yet), and answer the `./session` and `./feedback` modules main.ts imported. */
async function bootToConnect(): Promise<Booted> {
  H.connectOpts = null;
  H.link = null;
  H.sends = [];
  H.calls = [];
  T = 1000;
  clock.t = T;
  localStorage.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  stubRaf();
  vi.resetModules();
  await import('../main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
  // Same registry, no reset: these are the module instances main.ts imported.
  const s = await import('./session');
  const fb = await import('./feedback');
  // The shell drives this module and no copy of its own: the store it handed to `connect` and the
  // handle `connect` returned are the module's.
  expect(s.store, 'precondition: the store main() handed to connect is the module`s').toBe(
    opts.store,
  );
  expect(s.conn, 'precondition: main() mounted the handle connect returned').toBe(H.link);
  return { s, fb };
}

/** Boot, report ready, deliver the own character, and let the frame loop run until the boot is
 *  quiet. main() arms the frame loop in the same synchronous run that opens the connection, so it
 *  is armed once `bootToConnect` returns (a frame with none armed throws). */
async function boot(): Promise<Booted> {
  const booted = await bootToConnect();
  opts.onReady(H.identity);
  server(T);
  for (let i = 0; i < 9; i += 1) advance(600);
  return booted;
}

const EID = 7n;

/** One authoritative batch: the own player and character at (2, 6), every send acked. */
function server(t: number): void {
  clock.t = t;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    discriminator: 0,
    leadLevel: 0,
  });
  opts.store.upsertCharacter(
    {
      entityId: EID,
      zoneId: 0,
      tileX: 2,
      tileY: 6,
      facing: 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
      ackedSeq: BigInt(H.sends.length),
    },
    t,
  );
  opts.store.flushBatch();
}

/** One batch carrying the given battle rows and profile rows. */
function batch(battles: readonly StoreBattle[], profiles: readonly StoreProfile[] = []): void {
  for (const b of battles) opts.store.upsertBattle(b);
  for (const p of profiles) opts.store.upsertProfile(p);
  opts.store.flushBatch();
}

/** The connection drops and comes back: the store is emptied, then onReconnect reports `id`. */
function reconnect(id: string = H.identity): void {
  opts.store.reset();
  opts.onReconnect(id);
}

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return el;
};

/** The toast's visible text, '' while it is hidden. */
const toastText = (): string => {
  const el = byId('toast');
  return el.hidden ? '' : (el.textContent ?? '');
};

interface GameHook {
  readonly ready: Promise<void>;
}
const gameHook = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();

// --- the booted shell --------------------------------------------------------------------------
describe('the booted shell drives the server link of shell/session', { sequential: true }, () => {
  afterEach(teardown);

  it('main() mounts the connection it opened and the store it handed to connect into the module, the join`s identity is the module`s, and window.__game().ready is the module`s ready promise', async () => {
    // bootToConnect checks the mounted handle and the store against the ones connect saw.
    const { s } = await boot();
    expect(s.identity, 'the join`s identity is the module`s').toBe(H.identity);
    expect(gameHook().ready, 'the DEV hook hands out the module`s ready promise').toBe(s.ready);
    expect(await settled(s.ready), 'and the join resolved it').toBe(true);
  }, 60_000);

  it('ready stays pending while the connection is open but not joined, the join resolves it and sets the module`s identity before the connect edge is recorded', async () => {
    const { s, fb } = await bootToConnect();
    expect(s.identity, 'no join yet: no identity').toBe('');
    expect(await settled(s.ready), 'no join yet: ready is pending').toBe(false);

    opts.onReady(H.identity);
    expect(s.identity, 'the join set the module`s identity').toBe(H.identity);
    expect(await settled(s.ready), 'the join resolved the module`s ready promise').toBe(true);
    expect(
      connectIdentities(fb.eventRing.snapshot()),
      'the connect edge carries the joined identity',
    ).toEqual([H.identity]);
  }, 60_000);

  it('onHydrated sets the module`s hydration flag; a reconnect clears it, adopts the identity it reports and arms the battle reseed; a zone switch leaves the flag and the identity as they are', async () => {
    const { s, fb } = await boot();
    expect(s.hydratedSinceReconnect, 'a boot with no hydration edge: not hydrated').toBe(false);
    opts.onHydrated();
    expect(s.hydratedSinceReconnect, 'the hydration edge set the flag').toBe(true);

    reconnect(IDENTITY_2);
    expect(s.hydratedSinceReconnect, 'the reconnect cleared the flag').toBe(false);
    expect(s.identity, 'the reconnect`s identity is the module`s').toBe(IDENTITY_2);
    expect(s.battleEmit.reseedPending, 'the reconnect armed the battle reseed').toBe(true);
    expect(
      connectIdentities(fb.eventRing.snapshot()),
      'the reconnect`s connect edge carries the new identity',
    ).toEqual([H.identity, IDENTITY_2]);

    opts.onHydrated();
    expect(s.hydratedSinceReconnect, 'the next hydration edge sets it again').toBe(true);

    // A live warp switches the zone, which resets the emit latches with the prediction state.
    const warp = opts.onOwnWarp;
    if (warp === undefined) throw new Error('main() passes connect an onOwnWarp');
    warp(1);
    const zoneChanges = fb.eventRing.snapshot().filter((e) => e.kind === 'zoneChange');
    expect(zoneChanges, 'precondition: the warp switched the zone').toMatchObject([
      { fromZone: 0, toZone: 1 },
    ]);
    expect(s.hydratedSinceReconnect, 'the zone switch leaves the flag set').toBe(true);
    expect(s.identity, 'and the identity').toBe(IDENTITY_2);
  }, 60_000);

  it('a batch with the own Ongoing battle pushes one battleStart through the module`s latch; after a reconnect the surviving battle stays silent until the hydration edge, then re-baselines', async () => {
    const { s, fb } = await boot();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { BATTLE_EMIT_INITIAL } = await import('../ui/battleEmitModel');
    expect(s.battleEmit, 'precondition: no battle seen').toBe(BATTLE_EMIT_INITIAL);
    expect(latchEvents(fb.eventRing.snapshot()), 'precondition: no latch event').toEqual([]);

    batch([wildBattle(B1, 'Ongoing')]);
    expect(latchEvents(fb.eventRing.snapshot()), 'one battleStart on the ring').toEqual([
      wildStart(B1),
    ]);
    expect(s.battleEmit, 'the module`s latch holds the battle').toEqual({
      activeBattleId: B1,
      reseedPending: false,
      reseedPrevBattleId: null,
    });

    reconnect();
    expect(
      s.battleEmit,
      'the reconnect captured the battle, then the reset dropped the active one',
    ).toEqual({ activeBattleId: null, reseedPending: true, reseedPrevBattleId: B1 });

    const armed = s.battleEmit;
    batch([wildBattle(B1, 'Ongoing')]);
    expect(s.battleEmit, 'a flush before the hydration edge leaves the latch armed').toBe(armed);

    opts.onHydrated();
    batch([wildBattle(B1, 'Ongoing')]);
    expect(s.battleEmit, 'the flush after it re-baselined the surviving battle').toEqual({
      activeBattleId: B1,
      reseedPending: false,
      reseedPrevBattleId: null,
    });
    expect(latchEvents(fb.eventRing.snapshot()), 'and no second battleStart').toEqual([
      wildStart(B1),
    ]);
    expect(
      logged.mock.calls.filter((c) => c[0] === '[obs] battle'),
      'the battle step never threw',
    ).toEqual([]);
  }, 60_000);

  it('the first batch with the own profile baselines the module`s lastOwnRating with no event, a rating change beside a finished PvP battle pushes one rankedMatch with that battle and the delta, and an unchanged rating pushes nothing', async () => {
    const { s, fb } = await boot();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(s.lastOwnRating, 'precondition: no profile seen').toBeNull();

    batch([], [profileOf(H.identity, 1000)]);
    expect(s.lastOwnRating, 'the first sight is the baseline').toBe(1000);
    expect(latchEvents(fb.eventRing.snapshot()), 'a baseline is not a match').toEqual([]);

    batch([pvpBattle(PVP_DONE, 'SideAWins')], [profileOf(H.identity, 1016)]);
    expect(latchEvents(fb.eventRing.snapshot()), 'one rankedMatch for the rating change').toEqual([
      { kind: 'rankedMatch', battleId: PVP_DONE.toString(), ratingDelta: 16 },
    ]);
    expect(s.lastOwnRating, 'the module`s baseline moved to the new rating').toBe(1016);

    batch([], [profileOf(H.identity, 1016)]);
    expect(
      latchEvents(fb.eventRing.snapshot()).length,
      'a batch with the same rating pushes nothing',
    ).toBe(1);
    expect(
      logged.mock.calls.filter((c) => c[0] === '[obs] ranked'),
      'the ranked step never threw',
    ).toEqual([]);
  }, 60_000);

  it('in one batch where both latches emit, the battle event lands on the ring before the ranked event', async () => {
    const { s, fb } = await boot();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    batch([], [profileOf(H.identity, 1000)]);
    expect(s.lastOwnRating, 'precondition: the rating is baselined').toBe(1000);

    batch([pvpBattle(PVP_LIVE, 'Ongoing')], [profileOf(H.identity, 1010)]);
    expect(latchEvents(fb.eventRing.snapshot()), 'battle first, then ranked').toEqual([
      { kind: 'battleStart', battleId: PVP_LIVE.toString(), isPvp: true },
      { kind: 'rankedMatch', battleId: PVP_LIVE.toString(), ratingDelta: 10 },
    ]);
    expect(s.battleEmit.activeBattleId, 'the module`s battle latch moved').toBe(PVP_LIVE);
    expect(s.lastOwnRating, 'the module`s rating latch moved').toBe(1010);
  }, 60_000);

  it('a reconnect resets the module`s latches: the first batch after it re-baselines the rating with no rankedMatch, and the battle latch holds no active battle', async () => {
    const { s, fb } = await boot();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    batch([wildBattle(B1, 'Ongoing')], [profileOf(H.identity, 1000)]);
    expect(s.lastOwnRating, 'precondition: the rating is baselined').toBe(1000);
    expect(s.battleEmit.activeBattleId, 'precondition: the battle is active').toBe(B1);

    reconnect();
    expect(s.lastOwnRating, 'the reconnect dropped the rating baseline').toBeNull();
    expect(s.battleEmit.activeBattleId, 'and the active battle').toBeNull();

    batch([], [profileOf(H.identity, 1050)]);
    expect(s.lastOwnRating, 'the first batch after it is the new baseline').toBe(1050);
    expect(
      latchEvents(fb.eventRing.snapshot()).filter((e) => e.kind === 'rankedMatch'),
      'no delta is carried across the reconnect',
    ).toEqual([]);
  }, 60_000);

  it('a store read that throws inside a latch step is caught by the step and logged as [obs] battle and [obs] ranked, and the latches keep working on the next batch', async () => {
    const { s, fb } = await boot();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    batch([], [profileOf(H.identity, 1000)]);
    expect(s.lastOwnRating, 'precondition: the rating is baselined').toBe(1000);

    const boom = new Error('read-boom');
    const read = vi.spyOn(opts.store, 'latestPlayerBattle').mockImplementation(() => {
      throw boom;
    });
    const before = s.battleEmit;
    batch([wildBattle(B1, 'Ongoing')], [profileOf(H.identity, 1020)]);
    expect(
      logged.mock.calls.filter((c) => c[0] === '[obs] battle'),
      'the battle step caught the throw and logged it once',
    ).toEqual([['[obs] battle', boom]]);
    expect(
      logged.mock.calls.filter((c) => c[0] === '[obs] ranked'),
      'the ranked step caught the throw and logged it once',
    ).toEqual([['[obs] ranked', boom]]);
    expect(s.battleEmit, 'the battle latch did not move').toBe(before);
    expect(s.lastOwnRating, 'the rating latch did not move').toBe(1000);
    expect(latchEvents(fb.eventRing.snapshot()), 'nothing was pushed').toEqual([]);

    read.mockRestore();
    batch([wildBattle(B1, 'Ongoing')], [profileOf(H.identity, 1020)]);
    expect(latchEvents(fb.eventRing.snapshot()), 'the next batch steps both latches').toEqual([
      wildStart(B1),
      { kind: 'rankedMatch', battleId: '', ratingDelta: 20 },
    ]);
  }, 60_000);

  it('a send through the module on the mounted link: a rejection paints its site`s line on the shell`s toast, calls onRejected once and resolves; a fulfilled send reports nothing', async () => {
    const { s, fb } = await boot();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(fb.worldHints, 'precondition: no hint stands after the boot').toEqual([]);
    expect(toastText(), 'precondition: no toast after the boot').toBe('');

    const onRejected = vi.fn();
    const rejected = vi.fn(() => Promise.reject(new Error('send-boom')));
    await expect(
      s.sendGuarded('ackEvolutionNotices', rejected, onRejected),
      'a rejected send still resolves',
    ).resolves.toBeUndefined();
    expect(rejected, 'the live link ran the call').toHaveBeenCalledTimes(1);
    expect(toastText(), 'the rejection is on the toast').toBe(
      'ackEvolutionNotices: unexpected error',
    );
    expect(fb.worldHints, 'and not on the world hint line').toEqual([]);
    expect(onRejected, 'onRejected ran once').toHaveBeenCalledTimes(1);

    const okRejected = vi.fn();
    const fulfilled = vi.fn(() => Promise.resolve());
    const rows = fb.errorRing.snapshot().length;
    await expect(s.sendGuarded('talk', fulfilled, okRejected)).resolves.toBeUndefined();
    expect(fulfilled, 'the call ran').toHaveBeenCalledTimes(1);
    expect(okRejected, 'a fulfilled send calls no onRejected').not.toHaveBeenCalled();
    expect(fb.errorRing.snapshot().length, 'and reports nothing').toBe(rows);
  }, 60_000);
});

// --- the module on its own (no boot) --------------------------------------------------------
describe('shell/session owner functions', { sequential: true }, () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    document.body.replaceChildren();
    vi.resetModules();
  });

  async function fresh(): Promise<Session> {
    vi.resetModules();
    return import('./session');
  }

  it('importing the module registers no window, document or store listener, writes nothing to the document, resolves no catalog string, and leaves both latch steps to whoever registers them', async () => {
    vi.resetModules();
    // Everything the module imports loads first, so the import below evaluates the module alone.
    const resolver = await import('../ui/i18n/resolver');
    const copy = await import('../ui/a11yCopy');
    const fb = await import('./feedback');
    await import('./config');
    await import('../ui/statusModel');
    const { AuthoritativeStore } = await import('../net/store');
    const { BATTLE_EMIT_INITIAL } = await import('../ui/battleEmitModel');
    const catalogs: readonly object[] = Object.values(resolver.CATALOGS);
    expect(catalogs.length, 'precondition: both catalogs are registered').toBe(2);

    // Every catalog lookup either resolver makes goes through Object.hasOwn on a catalog.
    const lookups: PropertyKey[] = [];
    const hasOwn = Object.hasOwn;
    const lookup = vi
      .spyOn(Object, 'hasOwn')
      .mockImplementation((o: object, key: PropertyKey): boolean => {
        if (catalogs.includes(o)) lookups.push(key);
        return hasOwn(o, key);
      });
    const storeListeners = vi.spyOn(AuthoritativeStore.prototype, 'onBatchApplied');

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => {
      mutations.push(...records);
    });
    observer.observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });

    // An observer of this test's own, undone by ASSIGNING the saved function back: on the global
    // `window`, addEventListener is an own accessor, so restoring a property descriptor would
    // leave this wrapper in place.
    const seen: Recorded[] = [];
    type Adder = { addEventListener: EventTarget['addEventListener'] };
    const undo: Array<() => void> = [];
    const targets: readonly EventTarget[] = [window, document];
    for (const target of targets) {
      const hadOwn = Object.getOwnPropertyDescriptor(target, 'addEventListener') !== undefined;
      const previous = target.addEventListener;
      (target as Adder).addEventListener = (
        type: string,
        handler: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void => {
        seen.push({ target, type, handler, options });
        previous.call(target, type, handler, options);
      };
      undo.push(() => {
        if (hadOwn) (target as Adder).addEventListener = previous;
        else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
      });
    }
    try {
      // The observers work: a probe listener, a probe write and a probe lookup are each seen.
      const probe = (): void => undefined;
      window.addEventListener('mr-probe', probe);
      document.addEventListener('mr-probe', probe);
      expect(
        seen.map((r) => [r.target === window, r.target === document, r.type]),
        'precondition: the listener observer sees each target`s probe exactly once',
      ).toEqual([
        [true, false, 'mr-probe'],
        [false, true, 'mr-probe'],
      ]);
      window.removeEventListener('mr-probe', probe);
      document.removeEventListener('mr-probe', probe);
      seen.length = 0;

      document.documentElement.setAttribute('data-mr-probe', '1');
      document.documentElement.removeAttribute('data-mr-probe');
      mutations.push(...observer.takeRecords());
      expect(
        mutations.map((m) => `${m.type}:${m.attributeName ?? ''}`),
        'precondition: the mutation observer reports the probe`s set and remove',
      ).toEqual(['attributes:data-mr-probe', 'attributes:data-mr-probe']);
      mutations.length = 0;

      expect(copy.t('a11y.world.region'), 'precondition: the a11y probe resolves').not.toBe('');
      expect(lookups, 'precondition: an a11yCopy lookup is seen').toContain('a11y.world.region');
      lookups.length = 0;
      expect(
        resolver.tf('chrome.status.disconnected', { where: 'probe' }),
        'precondition: the i18n probe resolves',
      ).not.toBe('');
      expect(lookups, 'precondition: a resolver lookup is seen').toContain(
        'chrome.status.disconnected',
      );
      lookups.length = 0;

      const s = await import('./session');
      expect(s.store, 'precondition: the module loaded and built its store').toBeInstanceOf(
        AuthoritativeStore,
      );

      expect(
        seen.map((r) => [r.target === window, r.type]),
        'the import registered no listener on window or document',
      ).toEqual([]);
      mutations.push(...observer.takeRecords());
      expect(
        mutations.map((m) => `${m.type}:${m.attributeName ?? ''}`),
        'the import wrote nothing to the document',
      ).toEqual([]);
      expect(lookups, 'the import resolved no catalog string').toEqual([]);
      expect(storeListeners, 'the import registered no batch listener').not.toHaveBeenCalled();

      // The steps run only when called: a batch on the module's own store with an identity, a
      // battle and a profile in it moves neither latch.
      s.adoptIdentity(H.identity);
      s.store.upsertBattle(wildBattle(B1, 'Ongoing'));
      s.store.upsertProfile(profileOf(H.identity, 1000));
      s.store.flushBatch();
      expect(s.battleEmit, 'no step ran on the batch').toBe(BATTLE_EMIT_INITIAL);
      expect(s.lastOwnRating, 'no ranked step ran on the batch').toBeNull();
      expect(fb.eventRing.snapshot(), 'nothing was pushed').toEqual([]);
      s.stepBattleEmit();
      s.stepRankedEmit();
      expect(latchEvents(fb.eventRing.snapshot()), 'called, the battle step emits').toEqual([
        wildStart(B1),
      ]);
      expect(s.lastOwnRating, 'called, the ranked step baselines').toBe(1000);
    } finally {
      lookup.mockRestore();
      observer.disconnect();
      for (const r of seen) r.target.removeEventListener(r.type, r.handler, r.options);
      while (undo.length > 0) undo.pop()?.();
    }
  });

  it('ready stays pending until markReady, resolves on it, and a second markReady leaves it resolved', async () => {
    const s = await fresh();
    expect(await settled(s.ready), 'pending at import').toBe(false);
    s.markReady();
    expect(await settled(s.ready), 'markReady resolved it').toBe(true);
    expect(() => s.markReady(), 'a second markReady does not throw').not.toThrow();
    await expect(s.ready, 'and it stays resolved').resolves.toBeUndefined();
  });

  it('stepBattleEmit reads nothing before an identity is adopted, then starts the own battle; armEmitReseed captures it, resetEmitLatches drops only the active battle and leaves hydration, identity and connection as they are, and the reseed resolves only once the module is hydrated', async () => {
    const s = await fresh();
    const fb = await import('./feedback');
    const { BATTLE_EMIT_INITIAL } = await import('../ui/battleEmitModel');
    const latest = vi.spyOn(s.store, 'latestPlayerBattle');
    s.store.upsertBattle(wildBattle(B1, 'Ongoing'));

    s.stepBattleEmit();
    expect(latest, 'no identity: the store is not read').not.toHaveBeenCalled();
    expect(s.battleEmit).toBe(BATTLE_EMIT_INITIAL);

    s.adoptIdentity(H.identity);
    s.stepBattleEmit();
    expect(latest, 'the step reads the adopted identity`s battle').toHaveBeenCalledWith(H.identity);
    expect(latchEvents(fb.eventRing.snapshot())).toEqual([wildStart(B1)]);
    expect(s.battleEmit).toEqual({
      activeBattleId: B1,
      reseedPending: false,
      reseedPrevBattleId: null,
    });

    s.armEmitReseed();
    expect(s.battleEmit, 'the reseed captures the active battle').toEqual({
      activeBattleId: B1,
      reseedPending: true,
      reseedPrevBattleId: B1,
    });
    s.resetEmitLatches();
    expect(s.battleEmit, 'the reset drops the active battle and keeps the reseed').toEqual({
      activeBattleId: null,
      reseedPending: true,
      reseedPrevBattleId: B1,
    });
    s.armEmitReseed();
    expect(s.battleEmit.reseedPrevBattleId, 'a second arm keeps the first capture').toBe(B1);

    const armed = s.battleEmit;
    s.stepBattleEmit();
    expect(s.battleEmit, 'not hydrated: the reseed waits').toBe(armed);
    s.noteHydrated();
    s.stepBattleEmit();
    expect(s.battleEmit, 'hydrated: the survivor is re-baselined').toEqual({
      activeBattleId: B1,
      reseedPending: false,
      reseedPrevBattleId: null,
    });
    expect(latchEvents(fb.eventRing.snapshot()), 'silently').toEqual([wildStart(B1)]);

    // A zone switch resets the latches on a hydrated, connected module.
    const link = fakeLink({ session: 'hidden', frozen: false, live: true }, {});
    s.adoptConnection(link);
    s.resetEmitLatches();
    expect(s.battleEmit.activeBattleId, 'precondition: the reset ran').toBeNull();
    expect(s.hydratedSinceReconnect, 'the reset leaves hydration set').toBe(true);
    expect(s.identity, 'and the identity').toBe(H.identity);
    expect(s.conn, 'and the connection').toBe(link);
  });

  it('stepRankedEmit reads nothing before an identity is adopted, does nothing without the own profile, baselines on first sight, pushes the delta on a change, re-baselines after resetEmitLatches, and keeps its baseline while the own profile is absent', async () => {
    const s = await fresh();
    const fb = await import('./feedback');
    const profile = vi.spyOn(s.store, 'profile');
    const latest = vi.spyOn(s.store, 'latestPlayerBattle');
    // A profile keyed by the empty identity: a step without its identity guard would take it.
    s.store.upsertProfile(profileOf('', 1500));

    s.stepRankedEmit();
    expect(profile, 'no identity: no profile read').not.toHaveBeenCalled();
    expect(latest, 'no identity: no battle read').not.toHaveBeenCalled();
    expect(s.lastOwnRating, 'no identity: no baseline').toBeNull();

    s.adoptIdentity(H.identity);
    s.stepRankedEmit();
    expect(profile, 'the step reads the adopted identity`s profile').toHaveBeenCalledWith(
      H.identity,
    );
    expect(latest, 'no own profile: no battle read').not.toHaveBeenCalled();
    expect(s.lastOwnRating, 'no own profile: no baseline').toBeNull();

    s.store.upsertProfile(profileOf(H.identity, 1000));
    s.stepRankedEmit();
    expect(s.lastOwnRating, 'first sight: the baseline').toBe(1000);
    expect(latchEvents(fb.eventRing.snapshot()), 'a baseline is not a match').toEqual([]);

    s.store.upsertBattle(pvpBattle(PVP_DONE, 'SideBWins'));
    s.store.upsertProfile(profileOf(H.identity, 990));
    s.stepRankedEmit();
    expect(latchEvents(fb.eventRing.snapshot()), 'a change: one match with the delta').toEqual([
      { kind: 'rankedMatch', battleId: PVP_DONE.toString(), ratingDelta: -10 },
    ]);
    expect(s.lastOwnRating).toBe(990);

    s.resetEmitLatches();
    expect(s.lastOwnRating, 'the reset drops the baseline').toBeNull();
    s.store.upsertProfile(profileOf(H.identity, 1040));
    s.stepRankedEmit();
    expect(s.lastOwnRating, 'the next step is a new baseline').toBe(1040);
    expect(
      latchEvents(fb.eventRing.snapshot()).length,
      'and no delta is carried across the reset',
    ).toBe(1);

    s.store.removeProfile(H.identity);
    s.stepRankedEmit();
    expect(s.lastOwnRating, 'the own profile gone: the baseline stays').toBe(1040);
    s.store.upsertProfile(profileOf(H.identity, 1055));
    s.stepRankedEmit();
    expect(
      latchEvents(fb.eventRing.snapshot()),
      'the profile back with a new rating: one match with the delta from the kept baseline',
    ).toEqual([
      { kind: 'rankedMatch', battleId: PVP_DONE.toString(), ratingDelta: -10 },
      { kind: 'rankedMatch', battleId: PVP_DONE.toString(), ratingDelta: 15 },
    ]);
    expect(s.lastOwnRating).toBe(1055);
  });

  it('a latch step whose store read throws returns normally, logs [obs] battle or [obs] ranked with the error, and moves nothing', async () => {
    const s = await fresh();
    const fb = await import('./feedback');
    const { BATTLE_EMIT_INITIAL } = await import('../ui/battleEmitModel');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    s.adoptIdentity(H.identity);
    s.store.upsertBattle(wildBattle(B1, 'Ongoing'));
    s.store.upsertProfile(profileOf(H.identity, 1000));

    const battleBoom = new Error('battle-read-boom');
    vi.spyOn(s.store, 'latestPlayerBattle').mockImplementation(() => {
      throw battleBoom;
    });
    expect(() => s.stepBattleEmit(), 'the battle step lets nothing out').not.toThrow();
    expect(logged.mock.calls, 'logged once, with the error').toEqual([
      ['[obs] battle', battleBoom],
    ]);
    expect(s.battleEmit).toBe(BATTLE_EMIT_INITIAL);

    logged.mockClear();
    const rankedBoom = new Error('ranked-read-boom');
    vi.spyOn(s.store, 'profile').mockImplementation(() => {
      throw rankedBoom;
    });
    expect(() => s.stepRankedEmit(), 'the ranked step lets nothing out').not.toThrow();
    expect(logged.mock.calls, 'logged once, with the error').toEqual([
      ['[obs] ranked', rankedBoom],
    ]);
    expect(s.lastOwnRating).toBeNull();
    expect(fb.eventRing.snapshot(), 'nothing was pushed').toEqual([]);
  });

  it('sendGuarded with no connection, or a frozen one, never runs the call or onRejected, reports the disconnected line for its site on the given line or else the toast, and resolves', async () => {
    const s = await fresh();
    const fb = await import('./feedback');
    const resolver = await import('../ui/i18n/resolver');
    const { TOAST_MS } = await import('../ui/toast');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const reported = (): string[] =>
      fb.errorRing
        .snapshot()
        .filter((r) => r.source === 'reducer')
        .map((r) => r.message);
    const call = vi.fn(() => Promise.resolve());
    const onRejected = vi.fn();

    const talkDown = resolver.tf('chrome.status.disconnected', { where: 'talk' });
    await expect(s.sendGuarded('talk', call, onRejected)).resolves.toBeUndefined();
    expect(call, 'no connection: the call never runs').not.toHaveBeenCalled();
    expect(onRejected, 'and nothing settled').not.toHaveBeenCalled();
    expect(fb.toastState, 'no line: on the toast').toEqual({
      kind: 'shown',
      text: talkDown,
      untilMs: 1000 + TOAST_MS,
    });
    expect(reported(), 'and in the error ring').toEqual([talkDown]);

    const shown = fb.toastState;
    const painted = vi.fn<OutcomeLine>(() => true);
    const healDown = resolver.tf('chrome.status.disconnected', { where: 'heal' });
    await expect(s.sendGuarded('heal', call, onRejected, painted)).resolves.toBeUndefined();
    expect(painted.mock.calls, 'a line that paints carries it').toEqual([[healDown, 'error']]);
    expect(fb.toastState, 'and the toast is left alone').toBe(shown);
    expect(reported(), 'the error ring records it either way').toEqual([talkDown, healDown]);

    const state: LinkState = { session: 'hidden', frozen: true, live: true };
    s.adoptConnection(fakeLink(state, {}));
    const unpainted = vi.fn<OutcomeLine>(() => false);
    const tradeDown = resolver.tf('chrome.status.disconnected', { where: 'trade-open' });
    await expect(s.sendGuarded('trade-open', call, onRejected, unpainted)).resolves.toBeUndefined();
    expect(call, 'a frozen link: the call never runs').not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
    expect(unpainted.mock.calls, 'the line was offered it').toEqual([[tradeDown, 'error']]);
    expect(fb.toastState, 'a line that does not paint falls back to the toast').toEqual({
      kind: 'shown',
      text: tradeDown,
      untilMs: 1000 + TOAST_MS,
    });

    // The line is resolved when the send is refused, in the locale current then.
    resolver.setLocale('fr');
    const frDown = resolver.tf('chrome.status.disconnected', { where: 'talk' });
    expect(frDown, 'precondition: the locales differ').not.toBe(talkDown);
    await expect(s.sendGuarded('talk', call)).resolves.toBeUndefined();
    expect(fb.toastState, 'the refusal speaks the current locale').toEqual({
      kind: 'shown',
      text: frDown,
      untilMs: 1000 + TOAST_MS,
    });
  });

  it('sendGuarded on a live connection: a call answering undefined resolves with no report, a rejection reports its site`s line and calls onRejected once, a fulfilled call reports nothing, and a link that is not frozen but has no live handle still runs the call', async () => {
    const s = await fresh();
    const fb = await import('./feedback');
    const { NO_TOAST, TOAST_MS } = await import('../ui/toast');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const reported = (): string[] =>
      fb.errorRing
        .snapshot()
        .filter((r) => r.source === 'reducer')
        .map((r) => r.message);
    const state: LinkState = { session: 'hidden', frozen: false, live: true };
    s.adoptConnection(fakeLink(state, {}));

    const onRejected = vi.fn();
    const none = vi.fn((): Promise<void> | undefined => undefined);
    await expect(s.sendGuarded('talk', none, onRejected)).resolves.toBeUndefined();
    expect(none, 'the call ran').toHaveBeenCalledTimes(1);
    expect(fb.toastState, 'an undefined answer reports nothing').toBe(NO_TOAST);
    expect(reported()).toEqual([]);
    expect(onRejected).not.toHaveBeenCalled();

    const rejected = vi.fn(() => Promise.reject(new Error('send-boom')));
    await expect(
      s.sendGuarded('train', rejected, onRejected),
      'a rejected call still resolves',
    ).resolves.toBeUndefined();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(fb.toastState, 'the rejection is on its kind`s channel, the toast').toEqual({
      kind: 'shown',
      text: 'train: unexpected error',
      untilMs: 1000 + TOAST_MS,
    });
    expect(fb.worldHints, 'not on the hint line').toEqual([]);
    expect(reported()).toEqual(['train: unexpected error']);
    expect(onRejected, 'onRejected ran once').toHaveBeenCalledTimes(1);

    const shown = fb.toastState;
    const painted = vi.fn<OutcomeLine>(() => true);
    const lineRejected = vi.fn();
    await expect(
      s.sendGuarded('evolve', () => Promise.reject(new Error('send-boom')), lineRejected, painted),
    ).resolves.toBeUndefined();
    expect(painted.mock.calls, 'a line that paints carries the rejection').toEqual([
      ['evolve: unexpected error', 'error'],
    ]);
    expect(fb.toastState, 'and the toast is left alone').toBe(shown);
    expect(lineRejected).toHaveBeenCalledTimes(1);

    const okRejected = vi.fn();
    const fulfilled = vi.fn(() => Promise.resolve());
    await expect(s.sendGuarded('heal', fulfilled, okRejected, painted)).resolves.toBeUndefined();
    expect(fulfilled).toHaveBeenCalledTimes(1);
    expect(okRejected, 'a fulfilled call calls no onRejected').not.toHaveBeenCalled();
    expect(painted, 'and paints no line').toHaveBeenCalledTimes(1);
    expect(reported(), 'and reports nothing').toEqual([
      'train: unexpected error',
      'evolve: unexpected error',
    ]);

    // Not frozen, no live handle: the guard lets the call through and it answers undefined.
    state.live = false;
    const handleless = vi.fn((): Promise<void> | undefined => undefined);
    const handlelessLine = vi.fn<OutcomeLine>(() => true);
    const handlelessRejected = vi.fn();
    await expect(
      s.sendGuarded('talk', handleless, handlelessRejected, handlelessLine),
    ).resolves.toBeUndefined();
    expect(handleless, 'no live handle: the call still runs').toHaveBeenCalledTimes(1);
    expect(handlelessLine, 'no line is offered anything').not.toHaveBeenCalled();
    expect(fb.toastState, 'the toast is left alone').toBe(shown);
    expect(reported(), 'nothing reaches the error ring').toEqual([
      'train: unexpected error',
      'evolve: unexpected error',
    ]);
    expect(handlelessRejected).not.toHaveBeenCalled();
  });

  it('sessionGateBlocks, privacyLinkLive and liveReducers follow the adopted connection: unset, hidden, expired, unreachable, frozen, and without a live handle', async () => {
    const s = await fresh();
    expect(s.sessionGateBlocks(), 'unset: the gate is open').toBe(false);
    expect(s.privacyLinkLive(), 'unset: no live link').toBe(false);
    expect(s.liveReducers(), 'unset: no reducers').toBeUndefined();

    const reducers = { probe: true };
    const state: LinkState = { session: 'hidden', frozen: false, live: true };
    s.adoptConnection(fakeLink(state, reducers));
    expect(s.sessionGateBlocks(), 'hidden: the gate is open').toBe(false);
    expect(s.privacyLinkLive(), 'live').toBe(true);
    expect(s.liveReducers(), 'the live handle`s reducers').toBe(reducers);

    state.session = 'expired';
    expect(s.sessionGateBlocks(), 'expired: the gate blocks').toBe(true);
    state.session = 'unreachable';
    expect(s.sessionGateBlocks(), 'unreachable: the gate blocks').toBe(true);
    state.session = 'hidden';
    expect(s.sessionGateBlocks(), 'hidden again: open').toBe(false);

    state.frozen = true;
    expect(s.privacyLinkLive(), 'frozen: not live').toBe(false);
    expect(s.liveReducers(), 'frozen: no reducers').toBeUndefined();
    expect(s.sessionGateBlocks(), 'a frozen link does not close the gate').toBe(false);

    state.frozen = false;
    state.live = false;
    expect(s.privacyLinkLive(), 'no live handle: not live').toBe(false);
    expect(s.liveReducers(), 'no live handle: no reducers').toBeUndefined();

    state.live = true;
    expect(s.privacyLinkLive(), 'the handle is back').toBe(true);
    expect(s.liveReducers()).toBe(reducers);
  });
});
