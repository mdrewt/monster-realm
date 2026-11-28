// @vitest-environment happy-dom
// shell/battleFrame — the battle frame's views, memos and owner functions, reached through the
// module. Each test imports it afresh (vi.resetModules + dynamic imports), with ./session and
// ./commandPort in the same registry, so the store, the identity and the command port are the
// instances the module reads. The real client-wasm rules answer every rules call (map 1, species 1).
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ServerClock } from '../net/serverClock';
import type {
  StoreBattle,
  StoreBattleClock,
  StoreBattleEvent,
  StoreBattleMonster,
  StoreBattleUnit,
  StoreMonsterPub,
  StoreTacticalBattle,
  StoreTradeSession,
} from '../net/store';
import { popPlayerFramesOverBattle } from '../ui/battlePolicy';
import type { Stack } from '../ui/contextStack';
import type { Command } from '../ui/screens/types';
import type { BattlePort } from './battleFrame';

type BattleFrameModule = typeof import('./battleFrame');

interface Loaded {
  readonly bf: BattleFrameModule;
  readonly session: typeof import('./session');
  readonly cp: typeof import('./commandPort');
}

async function fresh(): Promise<Loaded> {
  vi.resetModules();
  const session = await import('./session');
  const cp = await import('./commandPort');
  const bf = await import('./battleFrame');
  return { bf, session, cp };
}

const EXPORTS = [
  'activeBattleView',
  'battleFrameShown',
  'battleHint',
  'battleSynced',
  'continueOutcome',
  'deployPanel',
  'dismissedBattleId',
  'feedServerClock',
  'hideAllBattleViews',
  'installBattlePort',
  'mountBattleFrame',
  'pumpClock',
  'pumpStillThere',
  'refreshBattle',
  'resetBattleFrame',
  'resultsAwaitDrain',
  'resultsPanel',
  'serverClock',
  'tacticalOwnsStart',
  'tacticsBattle',
  'tradedIds',
];

const NOT_INSTALLED = 'shell/battleFrame: the battle port is not installed';

const ME = 'a1'.repeat(32);
const PEER = 'b2'.repeat(32);
const OTHER = 'c3'.repeat(32);
const WILD = '0'.repeat(64);
/** The own monster every fixture battle stages. */
const P = 7n;

const BATTLE_MONSTER: StoreBattleMonster = {
  speciesId: 1,
  affinity: 'Plant',
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

/** The battle anchor with ME as side A and `opponent` as side B, staging P. */
function anchor(battleId: bigint, outcome: string, opponent: string = PEER): StoreBattle {
  return {
    battleId,
    playerIdentity: ME,
    opponentIdentity: opponent,
    outcome,
    turnNumber: 1,
    sideA: { active: 0, team: [BATTLE_MONSTER] },
    sideB: { active: 0, team: [BATTLE_MONSTER] },
    partyMonsterIds: [P],
    opponentMonsterIds: [],
    createdAtMs: 0n,
    weather: null,
  };
}

function ownMonster(monsterId: bigint): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: ME,
    speciesId: 1,
    nickname: `m${monsterId}`,
    level: 5,
    xp: 0,
    currentHp: 23,
    statHp: 29,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot: 0,
    tier: 0,
    essence: {} as StoreMonsterPub['essence'],
    trustTier: 'Unknown' as StoreMonsterPub['trustTier'],
    qualityTimeTier: 0,
    nutritionPct: 0,
    lastCareAtMs: 0n,
  };
}

/** The tactical row on content map 1; Active waits on the own unit 61. */
function tactical(
  battleId: bigint,
  kind: StoreTacticalBattle['kind'],
  phase: StoreTacticalBattle['phase'],
): StoreTacticalBattle {
  const active = phase === 'Active';
  return {
    battleId,
    kind,
    format: 1,
    mapId: 1,
    contentVersion: 1,
    phase,
    round: phase === 'Deploying' ? 0 : 1,
    initiative: active ? [62, 61] : [],
    turnIdx: active ? 1 : 0,
    turnState: active ? { kind: 'Waiting', unitId: 61 } : { kind: 'NotActive' },
    tiePrioritySide: 'A',
    pendingPadMs: 0,
    attackDamageDealtA: 0,
    attackDamageDealtB: 0,
  };
}

/** The own side-A clock row of `battleId`. */
function clock(
  battleId: bigint,
  windowOpenMs: bigint | null,
  deadlineMs: bigint | null = null,
): StoreBattleClock {
  return {
    clockId: battleId + 1n,
    battleId,
    side: 'A',
    player: ME,
    windowSeq: 1,
    windowOpenMs,
    deadlineMs,
    windowsThisUnitTurn: 1,
    idleMsTotal: 0n,
    autopassCount: 0,
  };
}

const UNIT_STATS = { hp: 31, attack: 7, defense: 7, speed: 7, sp_attack: 7, sp_defense: 7 };

/** An Active species-1 unit: the own P on side A, or a wild on side B. */
function unit(
  battleId: bigint,
  unitId: number,
  own: boolean,
  x: number,
  y: number,
): StoreBattleUnit {
  return {
    unitId,
    battleId,
    owner: own ? ME : null,
    monsterId: own ? P : null,
    affinity: 'Plant',
    row: {
      id: unitId,
      side: own ? 'A' : 'B',
      slot: 0,
      species_id: 1,
      level: 5,
      stats: UNIT_STATS,
      pos: { x, y },
      cur_hp: 31,
      status: null,
      budget: { ap: 6, strides_used: 0, attacks: 0, last: null },
      guard: false,
      first_stand: false,
      state: 'Active',
      stance: own ? null : 'Aggressive',
      wild_index: own ? null : 0,
    },
  };
}

/** A RoundEnded transcript row: one ticker line each. */
function roundEvent(battleId: bigint, seq: number): StoreBattleEvent {
  return {
    eventId: battleId * 100n + BigInt(seq),
    battleId,
    seq,
    round: 1,
    payload: { tag: 'RoundEnded', value: { round: seq + 1 } },
  };
}

interface Recorded {
  readonly dispatched: Command[];
  readonly applied: (readonly [Stack, Stack])[];
}

/** A recording command port, installed. */
function recordCommands(m: Loaded): Recorded {
  const dispatched: Command[] = [];
  const applied: (readonly [Stack, Stack])[] = [];
  m.cp.installCommandPort({
    dispatch: (command) => {
      dispatched.push(command);
      return Promise.resolve();
    },
    applyStack: (prev, next) => {
      applied.push([prev, next]);
    },
  });
  return { dispatched, applied };
}

/** A spy battle port answering `stack`. */
function spyPort(stack: Stack) {
  return {
    stack: vi.fn<() => Stack>(() => stack),
    clearOutcomeEdge: vi.fn<() => void>(() => undefined),
  };
}

function mount(m: Loaded): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  m.bf.mountBattleFrame(el);
  return el;
}

/** A fresh module with a recording command port, ME adopted and the frame mounted. */
async function booted(): Promise<{ m: Loaded; el: HTMLElement; rec: Recorded }> {
  const m = await fresh();
  const rec = recordCommands(m);
  m.session.adoptIdentity(ME);
  const el = mount(m);
  return { m, el, rec };
}

/** A Deploying PvP battle against PEER: the deploy panel's battle, no rules call. */
function seedPvpDeploying(m: Loaded, battleId: bigint): void {
  m.session.store.upsertMonster(ownMonster(P));
  m.session.store.upsertBattle(anchor(battleId, 'Ongoing'));
  m.session.store.reconcileTacticalBattlesFromView([tactical(battleId, 'Pvp', 'Deploying')]);
}

/** The PvP battle ends, won by side A. */
function finishPvp(m: Loaded, battleId: bigint): void {
  m.session.store.upsertBattle(anchor(battleId, 'SideAWins'));
  m.session.store.reconcileTacticalBattlesFromView([tactical(battleId, 'Pvp', 'Finished')]);
}

/** The deploy panel shows, then the results panel takes the frame (the port must be installed). */
function showResults(m: Loaded, battleId: bigint): void {
  seedPvpDeploying(m, battleId);
  m.bf.refreshBattle();
  finishPvp(m, battleId);
  m.bf.refreshBattle();
}

/** The clock window of `battleId` opens at `windowOpenMs`, and the module feeds at device `nowMs`. */
function feedAt(m: Loaded, battleId: bigint, windowOpenMs: bigint, nowMs: number): void {
  m.session.store.reconcileBattleClocksFromView([clock(battleId, windowOpenMs)]);
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
  m.bf.feedServerClock();
}

/** A sample of 50 000 server ms at device 2 000 ms puts the estimate 48 000 ms ahead. */
const SAMPLED_OFFSET = 48_000;

const WORLD_OUTCOME: Stack = [{ kind: 'world' }, { kind: 'screen', id: 'battleView' }];
const BATTLE_UNDER_FRAMES: Stack = [
  { kind: 'battle', battleId: '31' },
  { kind: 'screen', id: 'helpView' },
  { kind: 'screen', id: 'dialogueView' },
];

const byBigint = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

describe('shell/battleFrame', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    vi.resetModules();
  });

  it('exports exactly the twenty-one runtime names, with the port and owner functions typed as contracted', async () => {
    // expectTypeOf is checked by tsc over the test files and does nothing at run time.
    expectTypeOf<keyof BattleFrameModule>().toEqualTypeOf<
      | 'activeBattleView'
      | 'battleFrameShown'
      | 'battleHint'
      | 'battleSynced'
      | 'continueOutcome'
      | 'deployPanel'
      | 'dismissedBattleId'
      | 'feedServerClock'
      | 'hideAllBattleViews'
      | 'installBattlePort'
      | 'mountBattleFrame'
      | 'pumpClock'
      | 'pumpStillThere'
      | 'refreshBattle'
      | 'resetBattleFrame'
      | 'resultsAwaitDrain'
      | 'resultsPanel'
      | 'serverClock'
      | 'tacticalOwnsStart'
      | 'tacticsBattle'
      | 'tradedIds'
    >();
    expectTypeOf<BattlePort>().toEqualTypeOf<{
      readonly stack: () => Stack;
      readonly clearOutcomeEdge: () => void;
    }>();
    expectTypeOf<BattleFrameModule['installBattlePort']>().toEqualTypeOf<
      (port: BattlePort) => void
    >();
    expectTypeOf<BattleFrameModule['mountBattleFrame']>().toEqualTypeOf<
      (mount: HTMLElement) => void
    >();
    expectTypeOf<BattleFrameModule['resetBattleFrame']>().toEqualTypeOf<() => void>();
    expectTypeOf<BattleFrameModule['continueOutcome']>().toEqualTypeOf<() => void>();
    expectTypeOf<BattleFrameModule['feedServerClock']>().toEqualTypeOf<() => void>();
    expectTypeOf<BattleFrameModule['serverClock']>().toEqualTypeOf<ServerClock>();
    expectTypeOf<BattleFrameModule['resultsAwaitDrain']>().toEqualTypeOf<bigint | null>();
    expectTypeOf<BattleFrameModule['dismissedBattleId']>().toEqualTypeOf<bigint | null>();
    expectTypeOf<BattleFrameModule['battleSynced']>().toEqualTypeOf<boolean>();
    const m = await fresh();
    expect(Object.keys(m.bf).sort()).toEqual(EXPORTS);
  });

  it('importing the module registers no store, window or document listener and writes nothing to the document', async () => {
    vi.resetModules();
    // Its shell neighbours load first, so the import below evaluates the module's own scope.
    const session = await import('./session');
    await import('./commandPort');
    await import('./feedback');
    await import('./inputState');
    await import('./screenContext');
    const onBatch = vi.spyOn(session.store, 'onBatchApplied');
    document.body.innerHTML = '<p id="sentinel">x</p>';
    const head = document.head.innerHTML;

    // Undone by assigning the saved function back: on the global `window`, addEventListener is an
    // own accessor, so restoring a property descriptor would leave this wrapper in place.
    const seen: string[] = [];
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
        seen.push(type);
        previous.call(target, type, handler, options);
      };
      undo.push(() => {
        if (hadOwn) (target as Adder).addEventListener = previous;
        else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
      });
    }
    try {
      const probe = (): void => undefined;
      window.addEventListener('mr-probe', probe);
      window.removeEventListener('mr-probe', probe);
      expect(seen, 'precondition: the listener observer sees a probe').toEqual(['mr-probe']);
      seen.length = 0;

      await import('./battleFrame');
      expect(seen).toEqual([]);
      expect(onBatch).not.toHaveBeenCalled();
      expect(document.body.innerHTML).toBe('<p id="sentinel">x</p>');
      expect(document.head.innerHTML).toBe(head);
    } finally {
      for (const u of undo) u();
    }
  });

  it('a fresh module holds no view, no wait, no dismissed battle and no sighting, and shows nothing', async () => {
    const m = await fresh();
    expect(m.bf.deployPanel).toBeUndefined();
    expect(m.bf.resultsPanel).toBeUndefined();
    expect(m.bf.tacticsBattle).toBeUndefined();
    expect(m.bf.resultsAwaitDrain).toBeNull();
    expect(m.bf.dismissedBattleId).toBeNull();
    expect(m.bf.battleSynced).toBe(false);
    expect(m.bf.battleFrameShown()).toBe(false);
    expect(m.bf.activeBattleView()).toBeUndefined();
    expect(m.bf.battleHint()).toBeUndefined();
    expect(m.bf.tacticalOwnsStart()).toBe(false);
  });

  it('before mountBattleFrame a renderable battle builds no view and adds no DOM, and mounting builds none by itself', async () => {
    const m = await fresh();
    recordCommands(m);
    m.session.adoptIdentity(ME);
    seedPvpDeploying(m, 31n);
    const before = document.body.innerHTML;
    m.bf.refreshBattle();
    expect(m.bf.deployPanel).toBeUndefined();
    expect(m.bf.battleFrameShown()).toBe(false);
    expect(m.bf.battleSynced, 'an unmounted refresh decides nothing').toBe(false);
    expect(document.body.innerHTML).toBe(before);

    const el = document.createElement('div');
    document.body.append(el);
    m.bf.mountBattleFrame(el);
    expect(m.bf.deployPanel).toBeUndefined();
    expect(el.childElementCount).toBe(0);
  });

  it('after mountBattleFrame the next refresh builds the deploy panel inside the mount and shows it', async () => {
    const { m, el } = await booted();
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    const root = el.querySelector('.tactics-deploy');
    expect(root).not.toBeNull();
    expect(root?.parentElement).toBe(el);
    expect(m.bf.deployPanel?.visible).toBe(true);
    expect(m.bf.battleFrameShown()).toBe(true);
  });

  it('a shown deploy panel is the active battle view and tells the hint its confirm screen; Start stays the menu`s', async () => {
    const { m } = await booted();
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    expect(m.bf.activeBattleView()).toBe(m.bf.deployPanel);
    expect(m.bf.battleHint()).toEqual({ deploy: 'confirm' });
    expect(m.bf.tacticalOwnsStart()).toBe(false);
  });

  it('before installBattlePort a renderer switch throws the battle port`s own error and applies no stack', async () => {
    const { m, rec } = await booted();
    seedPvpDeploying(m, 31n);
    // A first show reads no port.
    m.bf.refreshBattle();
    expect(m.bf.deployPanel?.visible).toBe(true);
    finishPvp(m, 31n);
    let thrown: unknown;
    try {
      m.bf.refreshBattle();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(NOT_INSTALLED);
    expect(rec.applied).toEqual([]);
  });

  it('a battle`s first show applies no stack; a renderer switch applies the port`s stack and its player frames popped, once', async () => {
    const { m, rec } = await booted();
    const port = spyPort(BATTLE_UNDER_FRAMES);
    m.bf.installBattlePort(port);
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    expect(rec.applied).toEqual([]);
    finishPvp(m, 31n);
    m.bf.refreshBattle();
    expect(rec.applied).toHaveLength(1);
    const [prev, next] = rec.applied[0] ?? [];
    expect(prev).toBe(BATTLE_UNDER_FRAMES);
    expect(next).toEqual(popPlayerFramesOverBattle(BATTLE_UNDER_FRAMES));
    expect(m.bf.resultsPanel?.visible).toBe(true);
    expect(m.bf.deployPanel?.visible).toBe(false);
  });

  it('the battle port is read at the call: a stack changed after install is the one applied', async () => {
    const { m, rec } = await booted();
    let current: Stack = WORLD_OUTCOME;
    m.bf.installBattlePort({ stack: () => current, clearOutcomeEdge: () => undefined });
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    current = BATTLE_UNDER_FRAMES;
    finishPvp(m, 31n);
    m.bf.refreshBattle();
    expect(rec.applied).toHaveLength(1);
    expect(rec.applied[0]?.[0]).toBe(BATTLE_UNDER_FRAMES);
  });

  it('a second installBattlePort replaces the first at the next call', async () => {
    const { m, rec } = await booted();
    const first = spyPort(WORLD_OUTCOME);
    const second = spyPort(BATTLE_UNDER_FRAMES);
    m.bf.installBattlePort(first);
    m.bf.installBattlePort(second);
    showResults(m, 31n);
    expect(first.stack).not.toHaveBeenCalled();
    expect(second.stack).toHaveBeenCalled();
    expect(rec.applied[0]?.[0]).toBe(BATTLE_UNDER_FRAMES);
  });

  it('Continue on the results panel dispatches one pop while the port`s stack has the outcome on top', async () => {
    const { m, el, rec } = await booted();
    m.bf.installBattlePort(spyPort(WORLD_OUTCOME));
    showResults(m, 31n);
    const button = el.querySelector<HTMLButtonElement>('.tactics-results-continue');
    if (button === null) throw new Error('fixture: the results panel has no Continue button');
    button.click();
    expect(rec.dispatched).toEqual([{ kind: 'pop' }]);
  });

  it('Continue on the results panel dispatches nothing while the port`s stack has no outcome on top', async () => {
    const { m, el, rec } = await booted();
    m.bf.installBattlePort(spyPort([{ kind: 'battle', battleId: '31' }]));
    showResults(m, 31n);
    const button = el.querySelector<HTMLButtonElement>('.tactics-results-continue');
    if (button === null) throw new Error('fixture: the results panel has no Continue button');
    button.click();
    expect(rec.dispatched).toEqual([]);
  });

  it('Continue reads the port`s stack at the click: off top at the build, on top at the click dispatches one pop', async () => {
    const { m, el, rec } = await booted();
    let current: Stack = [{ kind: 'battle', battleId: '31' }];
    m.bf.installBattlePort({ stack: () => current, clearOutcomeEdge: () => undefined });
    showResults(m, 31n);
    current = WORLD_OUTCOME;
    const button = el.querySelector<HTMLButtonElement>('.tactics-results-continue');
    if (button === null) throw new Error('fixture: the results panel has no Continue button');
    button.click();
    expect(rec.dispatched).toEqual([{ kind: 'pop' }]);
  });

  it('Continue reads the port`s stack at the click: on top at the build, off top at the click dispatches nothing', async () => {
    const { m, el, rec } = await booted();
    let current: Stack = WORLD_OUTCOME;
    m.bf.installBattlePort({ stack: () => current, clearOutcomeEdge: () => undefined });
    showResults(m, 31n);
    current = [{ kind: 'battle', battleId: '31' }];
    const button = el.querySelector<HTMLButtonElement>('.tactics-results-continue');
    if (button === null) throw new Error('fixture: the results panel has no Continue button');
    button.click();
    expect(rec.dispatched).toEqual([]);
  });

  it('a second mountBattleFrame is the element a later build goes into', async () => {
    const { m, el } = await booted();
    const second = document.createElement('div');
    document.body.append(second);
    m.bf.mountBattleFrame(second);
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    expect(second.querySelector('.tactics-deploy')?.parentElement).toBe(second);
    expect(el.childElementCount).toBe(0);
  });

  it('feedServerClock feeds the shown deploy panel`s battle clocks at Date.now', async () => {
    const { m } = await booted();
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    feedAt(m, 31n, 10_000n, 1_000);
    expect(m.bf.serverClock.now(0), 'a first sighting is only remembered').toBe(0);
    feedAt(m, 31n, 50_000n, 2_000);
    expect(m.bf.serverClock.now(0)).toBe(SAMPLED_OFFSET);
  });

  it('feedServerClock feeds nothing while no tactical view has shown', async () => {
    const { m } = await booted();
    seedPvpDeploying(m, 31n);
    feedAt(m, 31n, 10_000n, 1_000);
    feedAt(m, 31n, 50_000n, 2_000);
    expect(m.bf.serverClock.now(0)).toBe(0);
  });

  it('feedServerClock feeds nothing once the results panel takes the frame', async () => {
    const { m } = await booted();
    m.bf.installBattlePort(spyPort(WORLD_OUTCOME));
    showResults(m, 31n);
    expect(m.bf.resultsPanel?.visible).toBe(true);
    feedAt(m, 31n, 10_000n, 1_000);
    feedAt(m, 31n, 50_000n, 2_000);
    expect(m.bf.serverClock.now(0)).toBe(0);
  });

  it('continueOutcome keeps the dismissed battle while the latest battle is Ongoing', async () => {
    const { m } = await booted();
    m.session.store.upsertBattle(anchor(41n, 'SideAWins'));
    m.bf.refreshBattle();
    expect(m.bf.dismissedBattleId, 'fixture: a terminal first sighting is pre-dismissed').toBe(41n);
    m.session.store.upsertBattle(anchor(42n, 'Ongoing'));
    m.bf.continueOutcome();
    expect(m.bf.dismissedBattleId).toBe(41n);
  });

  it('continueOutcome keeps the dismissed battle while the player has no battle', async () => {
    const { m } = await booted();
    m.session.store.upsertBattle(anchor(41n, 'SideAWins'));
    m.bf.refreshBattle();
    expect(m.bf.dismissedBattleId, 'fixture: a terminal first sighting is pre-dismissed').toBe(41n);
    m.session.store.removeBattle(41n);
    m.bf.continueOutcome();
    expect(m.bf.dismissedBattleId).toBe(41n);
  });

  it('continueOutcome latches a terminal latest battle in place of the dismissed one', async () => {
    const { m } = await booted();
    m.session.store.upsertBattle(anchor(41n, 'SideAWins'));
    m.bf.refreshBattle();
    expect(m.bf.dismissedBattleId, 'fixture: a terminal first sighting is pre-dismissed').toBe(41n);
    m.session.store.upsertBattle(anchor(43n, 'SideBWins'));
    m.bf.continueOutcome();
    expect(m.bf.dismissedBattleId).toBe(43n);
  });

  it('continueOutcome hides every battle view, after which feedServerClock feeds nothing', async () => {
    const { m } = await booted();
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    feedAt(m, 31n, 10_000n, 1_000);
    m.bf.continueOutcome();
    expect(m.bf.deployPanel?.visible).toBe(false);
    expect(m.bf.battleFrameShown()).toBe(false);
    feedAt(m, 31n, 50_000n, 2_000);
    expect(m.bf.serverClock.now(0)).toBe(0);
  });

  it('resetBattleFrame clears the dismissed battle', async () => {
    const { m } = await booted();
    m.session.store.upsertBattle(anchor(41n, 'SideAWins'));
    m.bf.refreshBattle();
    expect(m.bf.dismissedBattleId, 'fixture: a terminal first sighting is pre-dismissed').toBe(41n);
    m.bf.resetBattleFrame();
    expect(m.bf.dismissedBattleId).toBeNull();
  });

  it('resetBattleFrame clears the sighting latch', async () => {
    const { m } = await booted();
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    expect(m.bf.battleSynced, 'fixture: a refresh sighted the battle').toBe(true);
    m.bf.resetBattleFrame();
    expect(m.bf.battleSynced).toBe(false);
  });

  it('after resetBattleFrame a terminal battle is a first sighting again: pre-dismissed, not shown', async () => {
    const { m } = await booted();
    m.bf.installBattlePort(spyPort(BATTLE_UNDER_FRAMES));
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    m.bf.resetBattleFrame();
    m.session.store.upsertBattle(anchor(51n, 'SideAWins'));
    m.session.store.reconcileTacticalBattlesFromView([
      tactical(31n, 'Pvp', 'Deploying'),
      tactical(51n, 'Pvp', 'Finished'),
    ]);
    m.bf.refreshBattle();
    expect(m.bf.dismissedBattleId).toBe(51n);
    expect(m.bf.resultsPanel).toBeUndefined();
  });

  it('resetBattleFrame forgets the shown tactical battle, so feedServerClock feeds nothing, and leaves a shown deploy panel shown', async () => {
    const { m } = await booted();
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    m.bf.resetBattleFrame();
    expect(m.bf.deployPanel?.visible).toBe(true);
    expect(m.bf.battleFrameShown()).toBe(true);
    feedAt(m, 31n, 10_000n, 1_000);
    feedAt(m, 31n, 50_000n, 2_000);
    expect(m.bf.serverClock.now(0)).toBe(0);
  });

  it('resetBattleFrame forgets the clock windows: the next window after it is a first sighting', async () => {
    const { m } = await booted();
    seedPvpDeploying(m, 31n);
    m.bf.refreshBattle();
    feedAt(m, 31n, 10_000n, 1_000);
    m.bf.resetBattleFrame();
    m.bf.refreshBattle();
    expect(m.bf.deployPanel?.visible, 'fixture: the battle shows again').toBe(true);
    feedAt(m, 31n, 50_000n, 2_000);
    expect(m.bf.serverClock.now(0)).toBe(0);
  });

  it('resetBattleFrame leaves a shown results panel shown', async () => {
    const { m } = await booted();
    m.bf.installBattlePort(spyPort(WORLD_OUTCOME));
    showResults(m, 31n);
    m.bf.resetBattleFrame();
    expect(m.bf.resultsPanel?.visible).toBe(true);
    expect(m.bf.battleFrameShown()).toBe(true);
  });

  it('after resetBattleFrame pumpStillThere announces the same Wild deadline again', async () => {
    const { m } = await booted();
    m.session.store.upsertMonster(ownMonster(P));
    m.session.store.upsertBattle(anchor(81n, 'Ongoing', WILD));
    m.session.store.reconcileTacticalBattlesFromView([tactical(81n, 'Wild', 'Deploying')]);
    m.session.store.reconcileBattleClocksFromView([clock(81n, null, 100_000n)]);
    m.bf.refreshBattle();
    expect(m.bf.deployPanel?.visible, 'fixture: the Wild deploy panel shows').toBe(true);
    const first = m.bf.pumpStillThere(70_000);
    expect(typeof first).toBe('string');
    expect(m.bf.pumpStillThere(70_000), 'a window is announced once').toBeNull();
    m.bf.resetBattleFrame();
    m.bf.refreshBattle();
    expect(m.bf.pumpStillThere(70_000)).toBe(first);
  });

  it('tradedIds is the own confirmed sides` monsters of the player`s trade sessions, read from the store at the call', async () => {
    const m = await fresh();
    m.session.adoptIdentity(ME);
    const offer = (monsterIds: bigint[]) => ({
      monsterIds,
      items: [],
      currency: 0n,
      cards: [],
    });
    const session = (
      sessionId: bigint,
      opener: string,
      partner: string,
      openerIds: bigint[],
      openerConfirmed: boolean,
      partnerIds: bigint[],
      partnerConfirmed: boolean,
    ): StoreTradeSession => ({
      sessionId,
      opener,
      partner,
      openerOffer: offer(openerIds),
      partnerOffer: offer(partnerIds),
      openerConfirmed,
      partnerConfirmed,
      revision: 1n,
      createdAtMs: 0n,
    });
    const rows = (mineConfirmed: boolean): StoreTradeSession[] => [
      session(1n, ME, PEER, [5n, 6n], true, [7n], true),
      session(2n, PEER, ME, [9n], true, [8n], mineConfirmed),
      session(3n, OTHER, PEER, [10n], true, [11n], true),
    ];
    m.session.store.reconcileTradeSessionsFromView(rows(false));
    expect([...m.bf.tradedIds()].sort(byBigint)).toEqual([5n, 6n]);
    m.session.store.reconcileTradeSessionsFromView(rows(true));
    expect([...m.bf.tradedIds()].sort(byBigint)).toEqual([5n, 6n, 8n]);
  });

  describe('the tactical shell, on the real rules', () => {
    const ticker = (el: HTMLElement): string[] =>
      [...el.querySelectorAll('.tactics-battle .tactics-ticker > *')].map(
        (n) => n.textContent ?? '',
      );

    /** An Active wild battle on map 1: the own unit 61 at (1,1), the wild 62 at (1,5). */
    function seedWildActive(
      m: Loaded,
      battleId: bigint,
      events: readonly StoreBattleEvent[],
    ): void {
      m.session.store.upsertMonster(ownMonster(P));
      m.session.store.upsertBattle(anchor(battleId, 'Ongoing', WILD));
      m.session.store.reconcileBattleUnitsFromView([
        unit(battleId, 61, true, 1, 1),
        unit(battleId, 62, false, 1, 5),
      ]);
      m.session.store.reconcileTacticalBattlesFromView([tactical(battleId, 'Wild', 'Active')]);
      m.session.store.reconcileBattleEventsFromView([...events]);
    }

    /** The wild battle ends, won by side A, its transcript `events`. */
    function finishWild(m: Loaded, battleId: bigint, events: readonly StoreBattleEvent[]): void {
      m.session.store.upsertBattle(anchor(battleId, 'SideAWins', WILD));
      m.session.store.reconcileTacticalBattlesFromView([tactical(battleId, 'Wild', 'Finished')]);
      m.session.store.reconcileBattleEventsFromView([...events]);
    }

    it('an Active battle builds the shell inside the mount, feeds its history and shows it', async () => {
      const { m, el } = await booted();
      seedWildActive(m, 71n, [roundEvent(71n, 0), roundEvent(71n, 1)]);
      m.bf.refreshBattle();
      expect(m.bf.tacticsBattle?.visible).toBe(true);
      expect(el.querySelector('.tactics-battle')?.parentElement).toBe(el);
      expect(m.bf.battleFrameShown()).toBe(true);
      expect(m.bf.activeBattleView()).toBe(m.bf.tacticsBattle);
      expect(m.bf.tacticalOwnsStart()).toBe(true);
      expect(ticker(el)).toHaveLength(2);
    });

    it('resetBattleFrame resets and hides the shell', async () => {
      const { m, el } = await booted();
      seedWildActive(m, 71n, [roundEvent(71n, 0), roundEvent(71n, 1)]);
      m.bf.refreshBattle();
      expect(ticker(el), 'fixture: the history is in the ticker').toHaveLength(2);
      m.bf.resetBattleFrame();
      expect(m.bf.tacticsBattle?.visible).toBe(false);
      expect(m.bf.battleFrameShown()).toBe(false);
      expect(ticker(el), 'the reset shell holds no log').toEqual([]);
    });

    it('after resetBattleFrame the next sighting feeds the transcript from its first event again', async () => {
      const { m, el } = await booted();
      seedWildActive(m, 71n, [roundEvent(71n, 0), roundEvent(71n, 1)]);
      m.bf.refreshBattle();
      m.bf.resetBattleFrame();
      m.bf.refreshBattle();
      expect(m.bf.tacticsBattle?.visible, 'fixture: the shell shows again').toBe(true);
      expect(ticker(el)).toHaveLength(2);
    });

    it('a Finished batch for the battle the visible shell fed, while it plays, holds the results and clears the outcome edge once', async () => {
      const { m } = await booted();
      const port = spyPort(BATTLE_UNDER_FRAMES);
      m.bf.installBattlePort(port);
      seedWildActive(m, 71n, [roundEvent(71n, 0)]);
      m.bf.refreshBattle();
      finishWild(m, 71n, [roundEvent(71n, 0), roundEvent(71n, 1), roundEvent(71n, 2)]);
      m.bf.refreshBattle();
      expect(m.bf.tacticsBattle?.playing, 'fixture: the fresh events play').toBe(true);
      expect(port.clearOutcomeEdge).toHaveBeenCalledTimes(1);
      expect(m.bf.resultsAwaitDrain).toBe(71n);
      expect(m.bf.resultsPanel).toBeUndefined();
      expect(m.bf.tacticsBattle?.visible).toBe(true);
    });

    it('resetBattleFrame ends a results wait', async () => {
      const { m } = await booted();
      m.bf.installBattlePort(spyPort(BATTLE_UNDER_FRAMES));
      seedWildActive(m, 71n, [roundEvent(71n, 0)]);
      m.bf.refreshBattle();
      finishWild(m, 71n, [roundEvent(71n, 0), roundEvent(71n, 1)]);
      m.bf.refreshBattle();
      expect(m.bf.resultsAwaitDrain, 'fixture: the results wait').toBe(71n);
      m.bf.resetBattleFrame();
      expect(m.bf.resultsAwaitDrain).toBeNull();
    });

    /** The visible shell plays battle 71's last events while its results wait. */
    async function resultsWaiting(): Promise<{ m: Loaded; el: HTMLElement }> {
      const { m, el } = await booted();
      m.bf.installBattlePort(spyPort(BATTLE_UNDER_FRAMES));
      seedWildActive(m, 71n, [roundEvent(71n, 0)]);
      m.bf.refreshBattle();
      finishWild(m, 71n, [roundEvent(71n, 0), roundEvent(71n, 1)]);
      m.bf.refreshBattle();
      expect(m.bf.resultsAwaitDrain, 'fixture: the results wait').toBe(71n);
      return { m, el };
    }

    /** The shell's root is hidden, the frame shows nothing, and the clock is fed nothing. */
    function expectShellDropped(m: Loaded, el: HTMLElement): void {
      expect(m.bf.resultsAwaitDrain).toBeNull();
      expect(m.bf.tacticsBattle?.visible).toBe(false);
      expect(el.querySelector<HTMLElement>('.tactics-battle')?.style.display).toBe('none');
      expect(m.bf.battleFrameShown()).toBe(false);
      feedAt(m, 71n, 10_000n, 1_000);
      feedAt(m, 71n, 50_000n, 2_000);
      expect(m.bf.serverClock.now(0)).toBe(0);
    }

    it('continueOutcome during a results wait ends the wait, hides the shell and stops the clock feed', async () => {
      const { m, el } = await resultsWaiting();
      m.bf.continueOutcome();
      expectShellDropped(m, el);
    });

    it('hideAllBattleViews during a results wait ends the wait, hides the shell and stops the clock feed', async () => {
      const { m, el } = await resultsWaiting();
      m.bf.hideAllBattleViews();
      expectShellDropped(m, el);
    });

    it('a Finished batch with nothing to play shows the results at once and leaves the outcome edge alone', async () => {
      const { m } = await booted();
      const port = spyPort(BATTLE_UNDER_FRAMES);
      m.bf.installBattlePort(port);
      seedWildActive(m, 71n, [roundEvent(71n, 0)]);
      m.bf.refreshBattle();
      finishWild(m, 71n, [roundEvent(71n, 0)]);
      m.bf.refreshBattle();
      expect(port.clearOutcomeEdge).not.toHaveBeenCalled();
      expect(m.bf.resultsAwaitDrain).toBeNull();
      expect(m.bf.resultsPanel?.visible).toBe(true);
      expect(m.bf.tacticsBattle?.visible).toBe(false);
    });

    it('a Finished battle the visible shell never fed shows its results at once and leaves the outcome edge alone', async () => {
      const { m } = await booted();
      const port = spyPort(BATTLE_UNDER_FRAMES);
      m.bf.installBattlePort(port);
      seedWildActive(m, 71n, [roundEvent(71n, 0)]);
      m.bf.refreshBattle();
      expect(m.bf.tacticsBattle?.visible, 'fixture: the shell shows battle 71').toBe(true);
      m.session.store.upsertBattle(anchor(72n, 'SideAWins', WILD));
      m.session.store.reconcileTacticalBattlesFromView([
        tactical(71n, 'Wild', 'Active'),
        tactical(72n, 'Wild', 'Finished'),
      ]);
      m.session.store.reconcileBattleEventsFromView([
        roundEvent(71n, 0),
        roundEvent(72n, 0),
        roundEvent(72n, 1),
      ]);
      m.bf.refreshBattle();
      expect(port.clearOutcomeEdge).not.toHaveBeenCalled();
      expect(m.bf.resultsAwaitDrain).toBeNull();
      expect(m.bf.resultsPanel?.visible).toBe(true);
      expect(m.bf.tacticsBattle?.visible).toBe(false);
    });
  });
});
