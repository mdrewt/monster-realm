// The owner-view reconciler of viewReconcile.ts. SR6A.1: a new reconciler's reconcileOwnerViews
// rebuilds every owner-view store collection from a view cache, containing every throw to its try
// group. SR6B.n: a later reconcileOwnerViews runs only the views marked dirty since, and a throw
// leaves dirty the view that threw and the later dirty views of its group. The converters in
// ./rowConvert are the ORACLE; the store is the real AuthoritativeStore with its reconcile methods
// spied (no call-through: only the arguments, the call order and the logged throws are under test).
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  battleClockRowToStore,
  battleDeployRowToStore,
  battleEventRowToStore,
  battleQueueRowToStore,
  battleRowToStore,
  battleUnitRowToStore,
  exportChunkRowToStore,
  formationRowToStore,
  inventoryRowToStore,
  monsterPubRowToStore,
  pendingEvolutionNoticeRowToStore,
  tacticalBattleRowToStore,
  tradeSessionRowToStore,
} from './rowConvert';
import { AuthoritativeStore } from './store';
import {
  createOwnerViewReconciler,
  OWNER_VIEWS,
  type OwnerView,
  type OwnerViewCache,
  type OwnerViewReconciler,
} from './viewReconcile';

const ID = { toHexString: () => 'cd'.repeat(32) };
const OTHER = { toHexString: () => 'bb'.repeat(32) };
const LOG_MESSAGE = '[net] view reconcile threw; flushing anyway';

// --- SDK-shaped row fixtures (inline copies of the connection.runtime.test.ts shapes) -----------
const BT = 9_007_199_254_740_993n;

const sdkMonster = (monsterId: bigint) => ({
  monsterId,
  ownerIdentity: ID,
  speciesId: 1,
  nickname: 'Sprig',
  level: 5,
  xp: 10,
  currentHp: 20,
  statHp: 20,
  statAttack: 5,
  statDefense: 5,
  statSpeed: 5,
  statSpAttack: 5,
  statSpDefense: 5,
  partySlot: 0,
  tier: 1,
  essenceFire: 1,
  essenceWater: 2,
  essencePlant: 3,
  essenceElectric: 4,
  essenceEarth: 5,
  essenceWind: 6,
  essenceLight: 7,
  essenceDark: 8,
  trustTier: { tag: 'Neutral', value: {} },
  qualityTimeTier: 0,
  nutritionPct: 50,
  lastCareAtMs: 7n,
});
const sdkBattleMonster = {
  speciesId: 1,
  affinity: { tag: 'Plant' },
  level: 5,
  currentHp: 20,
  maxHp: 20,
  stats: { hp: 20, attack: 5, defense: 5, speed: 5, spAttack: 5, spDefense: 5 },
  knownSkillIds: [1],
  status: undefined,
};
const sdkBattle = (battleId: bigint) => ({
  battleId,
  playerIdentity: ID,
  opponentIdentity: OTHER,
  state: {
    sideA: { active: 0, team: [sdkBattleMonster] },
    sideB: { active: 0, team: [sdkBattleMonster] },
    outcome: { tag: 'Ongoing' },
    turnNumber: 1,
    weather: undefined,
  },
  partyMonsterIds: [5n],
  opponentMonsterIds: [],
  createdAtMs: 0n,
});
const sdkExportChunk = (chunkId: bigint) => ({
  chunkId,
  ownerIdentity: ID,
  requestId: 3n,
  tableName: 'monster',
  chunkIndex: 0,
  totalChunks: 1,
  payloadJson: '{"a":"1"}',
  createdAtMs: 5n,
});
const sdkEvolutionNotice = (monsterId: bigint, owner: { toHexString(): string }) => ({
  ownerIdentity: owner,
  entries: [{ monsterId, fromSpecies: 1, toSpecies: 2, evolvedAtMs: 9n }],
});
const sdkInventory = (invId: bigint) => ({ invId, ownerIdentity: ID, itemId: 5, count: 3 });
const sdkTactical = (battleId: bigint, mapId: number, turnStateTag = 'NotActive') => ({
  battleId,
  kind: { tag: 'Wild' },
  format: 1,
  mapId,
  contentVersion: 1,
  phase: { tag: 'Deploying' },
  round: 0,
  initiative: [],
  turnIdx: 0,
  turnState: { tag: turnStateTag },
  tiePrioritySide: { tag: 'A' },
  pendingPadMs: 0,
  attackDamageDealtA: 0,
  attackDamageDealtB: 0,
});
const sdkUnit = (unitId: number) => ({
  unitId,
  battleId: BT,
  side: { tag: 'A' },
  owner: ID,
  slot: 0,
  monsterId: 5n,
  wildIndex: undefined,
  speciesId: 1,
  level: 5,
  affinity: { tag: 'Plant' },
  x: 1,
  y: 1,
  curHp: 20,
  stats: { hp: 20, attack: 5, defense: 5, speed: 5, spAttack: 5, spDefense: 5 },
  skillIds: [],
  status: undefined,
  ap: 6,
  stridesUsed: 0,
  attacks: 0,
  budgetLast: undefined,
  guard: false,
  firstStand: false,
  movement: { tag: 'Walk' },
  stride: 3,
  stance: undefined,
  state: { tag: 'Active' },
});
const sdkQueue = (unitId: number, entryTag = 'EndTurn') => ({
  unitId,
  battleId: BT,
  owner: ID,
  entries: [{ tag: entryTag }],
  submittedAtMs: 1n,
});
const sdkDeploy = (deployId: bigint) => ({
  deployId,
  battleId: BT,
  owner: ID,
  side: { tag: 'A' },
  picks: [{ monsterId: 5n, slot: 0 }],
  locked: false,
});
const sdkClock = (clockId: bigint) => ({
  clockId,
  battleId: BT,
  side: { tag: 'A' },
  player: ID,
  windowSeq: 1,
  windowOpenMs: undefined,
  deadlineMs: undefined,
  windowsThisUnitTurn: 0,
  idleMsTotal: 0n,
  autopassCount: 0,
});
const sdkEvent = (eventId: bigint, seq: number) => ({
  eventId,
  battleId: BT,
  seq,
  round: 1,
  payload: { tag: 'BattleStarted', value: { round: 1 } },
});
const sdkFormation = (monsterIds: bigint[]) => ({ ownerIdentity: ID, monsterIds });
const sdkTrade = (sessionId: bigint) => ({
  sessionId,
  opener: ID,
  partner: OTHER,
  openerOffer: { monsterIds: [5n], items: [{ itemId: 3, qty: 1 }], currency: 2n, cards: [] },
  partnerOffer: { monsterIds: [], items: [], currency: 0n, cards: [] },
  openerConfirmed: false,
  partnerConfirmed: false,
  revision: 1n,
  createdAtMs: 1n,
});

/** A row whose every property read throws: any converter that touches it throws a plain Error. */
const malformed = (thrown: unknown = new Error('malformed row')): unknown =>
  new Proxy(
    {},
    {
      get: () => {
        throw thrown;
      },
    },
  );

// --- the owner views, in reconcile order -------------------------------------------------------
/** The owner-view roster in reconcile order: the one literal of the membership, compared with
 *  OWNER_VIEWS by the roster test. */
const ROSTER: readonly OwnerView[] = [
  'my_monster_pub',
  'myBattle',
  'my_export_bundle',
  'myPendingEvolutionNotices',
  'my_inventory',
  'myTacticalBattle',
  'myBattleUnits',
  'myBattleQueue',
  'myBattleDeploy',
  'myBattleClock',
  'myBattleEvents',
  'myFormation',
  'myTradeSession',
];

interface ViewRow {
  readonly method: string;
  readonly valid: () => unknown[];
  /** The oracle: what the store must be handed for these rows. */
  readonly expected: (rows: unknown[]) => unknown[];
}
interface View extends ViewRow {
  readonly key: keyof OwnerViewCache;
}

// biome-ignore lint/suspicious/noExplicitAny: rows are SDK-shaped fixtures cast at the converter edge
const conv = (fn: (row: any) => unknown) => (rows: unknown[]) => rows.map((row) => fn(row));
const convPresent = (fn: (row: never) => unknown) => (rows: unknown[]) =>
  rows.map((row) => fn(row as never)).filter((row) => row !== null);

/** What each owner view's reconcile hands the store: a hand table, never built from OWNER_VIEWS. */
const VIEW_TABLE: Record<OwnerView, ViewRow> = {
  my_monster_pub: {
    method: 'reconcileMonstersFromView',
    valid: () => [sdkMonster(5n), sdkMonster(6n)],
    expected: conv(monsterPubRowToStore),
  },
  myBattle: {
    method: 'reconcileBattlesFromView',
    valid: () => [sdkBattle(47n), sdkBattle(48n)],
    expected: conv(battleRowToStore),
  },
  my_export_bundle: {
    method: 'reconcileExportChunksFromView',
    valid: () => [sdkExportChunk(1n), sdkExportChunk(2n)],
    expected: conv(exportChunkRowToStore),
  },
  myPendingEvolutionNotices: {
    method: 'reconcileEvolutionNoticesFromView',
    valid: () => [sdkEvolutionNotice(5n, ID), sdkEvolutionNotice(6n, OTHER)],
    expected: conv(pendingEvolutionNoticeRowToStore),
  },
  my_inventory: {
    method: 'reconcileInventoryFromView',
    valid: () => [sdkInventory(1n), sdkInventory(2n)],
    expected: conv(inventoryRowToStore),
  },
  myTacticalBattle: {
    method: 'reconcileTacticalBattlesFromView',
    valid: () => [sdkTactical(BT, 7), sdkTactical(BT + 8n, 11)],
    expected: convPresent(tacticalBattleRowToStore),
  },
  myBattleUnits: {
    method: 'reconcileBattleUnitsFromView',
    valid: () => [sdkUnit(3), sdkUnit(5)],
    expected: conv(battleUnitRowToStore),
  },
  myBattleQueue: {
    method: 'reconcileBattleQueuesFromView',
    valid: () => [sdkQueue(3), sdkQueue(5)],
    expected: convPresent(battleQueueRowToStore),
  },
  myBattleDeploy: {
    method: 'reconcileBattleDeploysFromView',
    valid: () => [sdkDeploy(13n), sdkDeploy(14n)],
    expected: conv(battleDeployRowToStore),
  },
  myBattleClock: {
    method: 'reconcileBattleClocksFromView',
    valid: () => [sdkClock(19n), sdkClock(20n)],
    expected: conv(battleClockRowToStore),
  },
  myBattleEvents: {
    method: 'reconcileBattleEventsFromView',
    valid: () => [sdkEvent(29n, 1), sdkEvent(31n, 2)],
    expected: conv(battleEventRowToStore),
  },
  myFormation: {
    method: 'reconcileFormationFromView',
    valid: () => [sdkFormation([37n, 41n]), sdkFormation([43n])],
    expected: conv(formationRowToStore),
  },
  myTradeSession: {
    method: 'reconcileTradeSessionsFromView',
    valid: () => [sdkTrade(9n), sdkTrade(4n)],
    expected: conv(tradeSessionRowToStore),
  },
};

const VIEWS: readonly View[] = ROSTER.map((key) => ({ key, ...VIEW_TABLE[key] }));

const GUARDED = VIEWS.slice(5);
const KEYS = VIEWS.map((v) => v.key);

type Rows = Partial<Record<keyof OwnerViewCache, unknown[]>>;

function makeCache(rows: Rows): OwnerViewCache {
  const handle = (key: keyof OwnerViewCache) => ({ iter: () => rows[key] ?? [] });
  return {
    my_monster_pub: handle('my_monster_pub'),
    myBattle: handle('myBattle'),
    my_export_bundle: handle('my_export_bundle'),
    myPendingEvolutionNotices: handle('myPendingEvolutionNotices'),
    my_inventory: handle('my_inventory'),
    myTacticalBattle: handle('myTacticalBattle'),
    myBattleUnits: handle('myBattleUnits'),
    myBattleQueue: handle('myBattleQueue'),
    myBattleDeploy: handle('myBattleDeploy'),
    myBattleClock: handle('myBattleClock'),
    myBattleEvents: handle('myBattleEvents'),
    myFormation: handle('myFormation'),
    myTradeSession: handle('myTradeSession'),
  };
}

const allValid = (): Rows => Object.fromEntries(VIEWS.map((v) => [v.key, v.valid()])) as Rows;

/** A view cache over `rows` (read at iter() time) that records every iter() call. */
interface Probe {
  readonly cache: OwnerViewCache;
  /** The views whose iter() was called, in call order. */
  readonly reads: OwnerView[];
  /** A view in this map throws its value from iter(), after the call is recorded. */
  readonly iterThrows: Map<OwnerView, unknown>;
}

function probe(rows: Rows): Probe {
  const reads: OwnerView[] = [];
  const iterThrows = new Map<OwnerView, unknown>();
  const base = makeCache(rows);
  const handle = (view: OwnerView) => ({
    iter: (): Iterable<unknown> => {
      reads.push(view);
      if (iterThrows.has(view)) throw iterThrows.get(view);
      return base[view].iter();
    },
  });
  const cache = Object.fromEntries(KEYS.map((view) => [view, handle(view)]));
  return { cache: cache as unknown as OwnerViewCache, reads, iterThrows };
}

describe('reconcileOwnerViews (sr-6a)', () => {
  let store: AuthoritativeStore;
  let spies: Map<keyof OwnerViewCache, MockInstance>;
  let errors: MockInstance;
  let warns: MockInstance;

  beforeEach(() => {
    store = new AuthoritativeStore(200);
    spies = new Map();
    for (const v of VIEWS) {
      spies.set(
        v.key,
        vi
          .spyOn(store as unknown as Record<string, (...args: unknown[]) => void>, v.method)
          .mockImplementation(() => {}),
      );
    }
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
    warns.mockRestore();
    for (const spy of spies.values()) spy.mockRestore();
  });

  const spyOf = (key: keyof OwnerViewCache): MockInstance => {
    const spy = spies.get(key);
    if (spy === undefined) throw new Error(`no spy for ${key}`);
    return spy;
  };

  /** Every view in `skipped` was never reconciled; every other view got exactly its oracle rows. */
  function expectAllBut(rows: Rows, skipped: readonly (keyof OwnerViewCache)[]): void {
    for (const v of VIEWS) {
      const spy = spyOf(v.key);
      if (skipped.includes(v.key)) {
        expect(spy, `${v.method} must not be called`).not.toHaveBeenCalled();
      } else {
        expect(spy, `${v.method} called once`).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0], `${v.method} rows`).toEqual([v.expected(rows[v.key] ?? [])]);
      }
    }
  }

  it('SR6A.1 every owner view is reconciled exactly once with the converted rows', () => {
    const rows = allValid();
    createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows));
    expectAllBut(rows, []);
    for (const v of VIEWS) {
      expect(v.expected(rows[v.key] ?? []).length, `${v.key} fixture is non-empty`).toBeGreaterThan(
        0,
      );
    }
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
  });

  it('SR6A.1 the reconciles run in call order', () => {
    createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(allValid()));
    const order = VIEWS.map((v) => spyOf(v.key).mock.invocationCallOrder[0]);
    expect(order.every((n) => typeof n === 'number')).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(OWNER_VIEWS.length);
  });

  it('SR6A.1 empty caches reconcile every view once with an empty array', () => {
    createOwnerViewReconciler().reconcileOwnerViews(store, makeCache({}));
    for (const key of KEYS) {
      const spy = spyOf(key);
      expect(spy, key).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0], key).toEqual([[]]);
    }
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
  });

  it('SR6A.1 a tactical battle row with an unknown turn-state tag is dropped and its sibling delivered', () => {
    const good = sdkTactical(BT, 7);
    const rows: Rows = { myTacticalBattle: [sdkTactical(BT + 8n, 11, 'NoSuchTurnState'), good] };
    createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows));
    const sent = spyOf('myTacticalBattle').mock.calls[0]?.[0] as unknown[];
    expect(sent).toEqual([tacticalBattleRowToStore(good as never)]);
    expect(sent).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('SR6A.1 a battle queue row with an unknown action tag is dropped and its sibling delivered', () => {
    const good = sdkQueue(5);
    const rows: Rows = { myBattleQueue: [sdkQueue(3, 'NoSuchAction'), good] };
    createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows));
    const sent = spyOf('myBattleQueue').mock.calls[0]?.[0] as unknown[];
    expect(sent).toEqual([battleQueueRowToStore(good as never)]);
    expect(sent).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  type Key = keyof OwnerViewCache;

  function throwingRows(key: Key, thrown: unknown): Rows {
    const rows = allValid();
    rows[key] = [malformed(thrown), ...(rows[key] ?? [])];
    return rows;
  }

  /** The logged throws, in order, must be exactly `thrown` (same objects, never re-wrapped). */
  function expectLogged(thrown: readonly unknown[]): void {
    expect(errors, 'one logged throw per fault').toHaveBeenCalledTimes(thrown.length);
    thrown.forEach((value, i) => {
      expect(errors.mock.calls[i]?.[0]).toBe(LOG_MESSAGE);
      expect(errors.mock.calls[i]?.[1], `logged throw ${i} is the thrown value`).toBe(value);
    });
  }

  function runContained(key: Key, skipped: readonly Key[], thrown: unknown = new Error('bad row')) {
    const rows = throwingRows(key, thrown);
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows)),
    ).not.toThrow();
    expectAllBut(rows, skipped);
    expectLogged([thrown]);
    expect(warns).not.toHaveBeenCalled();
  }

  /** A cache whose `key` view throws `thrown` from iter() itself. */
  function iterThrowing(rows: Rows, key: Key, thrown: unknown): OwnerViewCache {
    const cache = makeCache(rows);
    const throwing = {
      iter: (): never => {
        throw thrown;
      },
    };
    return { ...cache, [key]: throwing } as OwnerViewCache;
  }

  /** The store reconcile of `key` throws `thrown` once (after being recorded as called). */
  function storeThrows(key: Key, thrown: unknown): void {
    spyOf(key).mockImplementationOnce(() => {
      throw thrown;
    });
  }

  it('SR6A.1 a throwing monster row skips the rest of the shared group only; inventory, tactical and trade still land', () => {
    runContained('my_monster_pub', [
      'my_monster_pub',
      'myBattle',
      'my_export_bundle',
      'myPendingEvolutionNotices',
    ]);
  });

  it('SR6A.1 a throwing battle row keeps the monsters reconcile and skips battles, export and evolution', () => {
    runContained('myBattle', ['myBattle', 'my_export_bundle', 'myPendingEvolutionNotices']);
  });

  it('SR6A.1 a throwing export chunk row keeps monsters and battles and skips export and evolution', () => {
    runContained('my_export_bundle', ['my_export_bundle', 'myPendingEvolutionNotices']);
  });

  it('SR6A.1 a throwing evolution notice row keeps the first three of the shared group', () => {
    runContained('myPendingEvolutionNotices', ['myPendingEvolutionNotices']);
  });

  it('SR6A.1 a throwing inventory row leaves every other view reconciled', () => {
    runContained('my_inventory', ['my_inventory']);
  });

  it.each(
    GUARDED.map((v) => [v.key] as const),
  )('SR6A.1 a throwing %s row is contained to that view, every other view reconciles', (key) => {
    runContained(key, [key]);
  });

  it('SR6A.1 a throwing battle row is logged as the very object thrown and its reconcile never reaches the store', () => {
    const thrown = new Error('battle row bad');
    const rows = throwingRows('myBattle', thrown);
    createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows));
    expect(spyOf('myBattle')).not.toHaveBeenCalled();
    expectLogged([thrown]);
  });

  it('SR6A.1 a store reconcile that throws in a guarded view is contained and logged as the thrown object', () => {
    const thrown = new Error('store refused units');
    storeThrows('myBattleUnits', thrown);
    const rows = allValid();
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows)),
    ).not.toThrow();
    expectAllBut(rows, []);
    expectLogged([thrown]);
  });

  it('SR6A.1 a store throw in the monsters reconcile skips battles, export and evolution only', () => {
    const thrown = new Error('store refused monsters');
    storeThrows('my_monster_pub', thrown);
    const rows = allValid();
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows)),
    ).not.toThrow();
    expectAllBut(rows, ['myBattle', 'my_export_bundle', 'myPendingEvolutionNotices']);
    expectLogged([thrown]);
  });

  it('SR6A.1 a store throw in the battles reconcile skips export and evolution only', () => {
    const thrown = new Error('store refused battles');
    storeThrows('myBattle', thrown);
    const rows = allValid();
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows)),
    ).not.toThrow();
    expectAllBut(rows, ['my_export_bundle', 'myPendingEvolutionNotices']);
    expectLogged([thrown]);
  });

  it('SR6A.1 a store throw in the export reconcile skips evolution only', () => {
    const thrown = new Error('store refused export');
    storeThrows('my_export_bundle', thrown);
    const rows = allValid();
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows)),
    ).not.toThrow();
    expectAllBut(rows, ['myPendingEvolutionNotices']);
    expectLogged([thrown]);
  });

  it('SR6A.1 a store throw in the inventory reconcile leaves every other view reconciled', () => {
    const thrown = new Error('store refused inventory');
    storeThrows('my_inventory', thrown);
    const rows = allValid();
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows)),
    ).not.toThrow();
    expectAllBut(rows, []);
    expectLogged([thrown]);
  });

  it('SR6A.1 an iter() that throws in the shared group skips the later members of that group only', () => {
    const thrown = new Error('iter blew up');
    const rows = allValid();
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(
        store,
        iterThrowing(rows, 'myBattle', thrown),
      ),
    ).not.toThrow();
    expectAllBut(rows, ['myBattle', 'my_export_bundle', 'myPendingEvolutionNotices']);
    expectLogged([thrown]);
  });

  it('SR6A.1 an iter() that throws in a guarded view skips that view only', () => {
    const thrown = new Error('iter blew up');
    const rows = allValid();
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(
        store,
        iterThrowing(rows, 'myBattleClock', thrown),
      ),
    ).not.toThrow();
    expectAllBut(rows, ['myBattleClock']);
    expectLogged([thrown]);
  });

  it('SR6A.1 one throw in the shared group and one in a guarded view are each logged, everything else lands', () => {
    const first = new Error('battle row bad');
    const second = new Error('formation row bad');
    const rows = allValid();
    rows.myBattle = [malformed(first), ...(rows.myBattle ?? [])];
    rows.myFormation = [malformed(second), ...(rows.myFormation ?? [])];
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows)),
    ).not.toThrow();
    expectAllBut(rows, [
      'myBattle',
      'my_export_bundle',
      'myPendingEvolutionNotices',
      'myFormation',
    ]);
    expectLogged([first, second]);
  });

  it('SR6A.1 a non-Error thrown by a guarded view converter is contained and logged as thrown', () => {
    runContained('myBattleDeploy', ['myBattleDeploy'], 'boom');
  });

  it('SR6A.1 a non-Error thrown by a guarded view iter() is contained and logged as thrown', () => {
    const rows = allValid();
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(
        store,
        iterThrowing(rows, 'myTradeSession', 'boom'),
      ),
    ).not.toThrow();
    expectAllBut(rows, ['myTradeSession']);
    expectLogged(['boom']);
  });

  it('SR6A.1 a non-Error thrown in the shared group and in the inventory view is contained and logged as thrown', () => {
    const rows = allValid();
    rows.myBattle = [malformed('shared boom'), ...(rows.myBattle ?? [])];
    rows.my_inventory = [malformed(42), ...(rows.my_inventory ?? [])];
    expect(() =>
      createOwnerViewReconciler().reconcileOwnerViews(store, makeCache(rows)),
    ).not.toThrow();
    expectAllBut(rows, [
      'myBattle',
      'my_export_bundle',
      'myPendingEvolutionNotices',
      'my_inventory',
    ]);
    expectLogged(['shared boom', 42]);
  });
});

describe('createOwnerViewReconciler: only the dirty views reconcile (sr-6b)', () => {
  let store: AuthoritativeStore;
  let spies: Map<OwnerView, MockInstance>;
  let errors: MockInstance;
  let warns: MockInstance;

  beforeEach(() => {
    store = new AuthoritativeStore(200);
    spies = new Map();
    for (const v of VIEWS) {
      spies.set(
        v.key,
        vi
          .spyOn(store as unknown as Record<string, (...args: unknown[]) => void>, v.method)
          .mockImplementation(() => {}),
      );
    }
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
    warns.mockRestore();
    for (const spy of spies.values()) spy.mockRestore();
  });

  const spyOf = (view: OwnerView): MockInstance => {
    const spy = spies.get(view);
    if (spy === undefined) throw new Error(`no spy for ${view}`);
    return spy;
  };

  /** The views whose store reconcile ran since the last clear, in call order. */
  function reconciled(): OwnerView[] {
    const calls = VIEWS.flatMap((v) =>
      spyOf(v.key).mock.invocationCallOrder.map((at) => ({ at, view: v.key })),
    );
    return calls.sort((a, b) => a.at - b.at).map(({ view }) => view);
  }

  /** Exactly `views` were reconciled since the last clear, once each and in this order, each
   *  handed its oracle rows of `rows`. */
  function expectReconciled(rows: Rows, views: readonly OwnerView[]): void {
    expect(reconciled(), 'the store reconciles that ran, in order').toEqual(views);
    for (const view of views) {
      expect(spyOf(view).mock.calls[0], `${view} rows`).toEqual([
        VIEW_TABLE[view].expected(rows[view] ?? []),
      ]);
    }
  }

  /** The throws logged since the last clear, in order, are exactly `thrown` (the same objects). */
  function expectLogged(thrown: readonly unknown[]): void {
    expect(errors, 'one logged throw per fault').toHaveBeenCalledTimes(thrown.length);
    thrown.forEach((value, i) => {
      expect(errors.mock.calls[i]?.[0]).toBe(LOG_MESSAGE);
      expect(errors.mock.calls[i]?.[1], `logged throw ${i} is the thrown value`).toBe(value);
    });
    expect(warns).not.toHaveBeenCalled();
  }

  /** Forget the store calls, the cache reads and the log. */
  function clear(p: Probe): void {
    for (const spy of spies.values()) spy.mockClear();
    p.reads.length = 0;
    errors.mockClear();
  }

  /** One reconcile of `r` over `p`, which never throws. */
  function run(r: OwnerViewReconciler, p: Probe): void {
    expect(() => r.reconcileOwnerViews(store, p.cache)).not.toThrow();
  }

  /** A reconciler whose first, full reconcile over `p` has run, then cleared. */
  function drained(p: Probe): OwnerViewReconciler {
    const r = createOwnerViewReconciler();
    run(r, p);
    clear(p);
    return r;
  }

  /** Put a row that throws `thrown` ahead of `view`'s rows; the returned function removes it. */
  function breakView(rows: Rows, view: OwnerView, thrown: unknown): () => void {
    const good = rows[view];
    rows[view] = [malformed(thrown), ...(good ?? [])];
    return () => {
      rows[view] = good;
    };
  }

  /** With the fault already removed and nothing marked: the next reconcile runs exactly
   *  `retried`, in order, with their rows and no throw; the one after runs nothing. */
  function expectRetriedNext(
    r: OwnerViewReconciler,
    p: Probe,
    rows: Rows,
    retried: readonly OwnerView[],
  ): void {
    clear(p);
    run(r, p);
    expectReconciled(rows, retried);
    expect(p.reads, 'only the retried views are read').toEqual(retried);
    expectLogged([]);
    clear(p);
    run(r, p);
    expectReconciled(rows, []);
    expect(p.reads, 'once landed, the retried views are clean').toEqual([]);
  }

  const allBut = (skipped: readonly OwnerView[]): OwnerView[] =>
    KEYS.filter((key) => !skipped.includes(key));

  it('OWNER_VIEWS is the owner-view roster in reconcile order [SR6B.2]', () => {
    // WRONG IMPL KILLED: a view in no try group (it is never reconciled); a view in two groups (it
    // is reconciled twice); two groups swapped (the shared group no longer runs first).
    expect(OWNER_VIEWS).toEqual(ROSTER);
  });

  it('after a full reconcile, a reconcile with nothing marked calls no store method, reads no view, converts no row and logs nothing [SR6B.1]', () => {
    // WRONG IMPL KILLED: every view reconciled on every call (the pre-dirty-set behaviour); a clean
    // view's cache iterated, or its rows converted, with only the store call skipped.
    const rows = allValid();
    const p = probe(rows);
    const r = createOwnerViewReconciler();
    run(r, p);
    expectReconciled(rows, KEYS);
    expect(p.reads, 'a new reconciler reads every view once, in order').toEqual(KEYS);
    expectLogged([]);
    clear(p);
    // Rows no converter accepts, in every view, and no view marked.
    for (const key of KEYS) rows[key] = [malformed()];
    run(r, p);
    run(r, p);
    expectReconciled(rows, []);
    expect(p.reads, 'no view is read').toEqual([]);
    expectLogged([]);
  });

  it.each(
    KEYS.map((key) => [key] as const),
  )('marking only %s reconciles that view alone from its current rows, then clears it [SR6B.2]', (key) => {
    // WRONG IMPL KILLED: dirtiness kept per try group (a shared-group mark re-runs its clean
    // siblings); a mark that is ignored; a view still dirty after its reconcile returned (it runs
    // again on the next call); rows taken from anywhere but the cache at reconcile time.
    const rows = allValid();
    const p = probe(rows);
    const r = drained(p);
    rows[key] = VIEW_TABLE[key].valid().slice(1);
    r.markDirty(key);
    run(r, p);
    expectReconciled(rows, [key]);
    expect(p.reads, 'only the marked view is read').toEqual([key]);
    clear(p);
    run(r, p);
    expectReconciled(rows, []);
    expect(p.reads).toEqual([]);
    expectLogged([]);
  });

  it('a view marked twice before a reconcile is reconciled once [SR6B.2]', () => {
    // WRONG IMPL KILLED: a queue of marks instead of a set (the view is rebuilt once per mark).
    const rows = allValid();
    const p = probe(rows);
    const r = drained(p);
    r.markDirty('myBattleQueue');
    r.markDirty('myBattleQueue');
    run(r, p);
    expectReconciled(rows, ['myBattleQueue']);
    expect(p.reads).toEqual(['myBattleQueue']);
  });

  it('a guarded view and a shared-group view, marked in that order, reconcile exactly those two, in reconcile order [SR6B.2]', () => {
    // WRONG IMPL KILLED: the views run in mark order; a mark in one group that dirties another.
    const rows = allValid();
    const p = probe(rows);
    const r = drained(p);
    r.markDirty('myFormation');
    r.markDirty('my_export_bundle');
    run(r, p);
    expectReconciled(rows, ['my_export_bundle', 'myFormation']);
    expect(p.reads).toEqual(['my_export_bundle', 'myFormation']);
    expectLogged([]);
  });

  it('markAllDirty after a full reconcile reconciles every view once, in order, then clears them [SR6B.2]', () => {
    // WRONG IMPL KILLED: markAllDirty that misses a view or a group; a view left dirty afterwards.
    const rows = allValid();
    const p = probe(rows);
    const r = drained(p);
    rows.myTradeSession = VIEW_TABLE.myTradeSession.valid().slice(1);
    r.markAllDirty();
    run(r, p);
    expectReconciled(rows, KEYS);
    expect(p.reads).toEqual(KEYS);
    clear(p);
    run(r, p);
    expectReconciled(rows, []);
    expect(p.reads).toEqual([]);
  });

  it('two reconcilers keep their own dirty views: a new one rebuilds every view after another drained, and a mark on one is reconciled by that one only [SR6B.2]', () => {
    // WRONG IMPL KILLED: one dirty set for the module (a second connection's reconciler starts
    // clean, and a view marked for one connection is rebuilt by the other's batch).
    const rows = allValid();
    const p = probe(rows);
    const first = drained(p);
    const second = createOwnerViewReconciler();
    run(second, p);
    expectReconciled(rows, KEYS);
    clear(p);
    first.markDirty('my_inventory');
    run(second, p);
    expectReconciled(rows, []);
    expect(p.reads, 'the other reconciler reads nothing').toEqual([]);
    run(first, p);
    expectReconciled(rows, ['my_inventory']);
    expect(p.reads).toEqual(['my_inventory']);
  });

  it('a monster row that throws with every view dirty leaves the whole shared group dirty: the next reconcile runs exactly those four, in order, and the one after runs nothing [SR6B.4]', () => {
    // WRONG IMPL KILLED: the dirty set cleared all at once after the loop (the shared group stays
    // stale until each view next changes); a view cleared before its reconcile runs (the throwing
    // view is lost); the views the throw skipped cleared with it.
    const thrown = new Error('bad monster row');
    const rows = allValid();
    const fix = breakView(rows, 'my_monster_pub', thrown);
    const p = probe(rows);
    const r = createOwnerViewReconciler();
    run(r, p);
    const shared: OwnerView[] = [
      'my_monster_pub',
      'myBattle',
      'my_export_bundle',
      'myPendingEvolutionNotices',
    ];
    expectReconciled(rows, allBut(shared));
    expectLogged([thrown]);
    fix();
    expectRetriedNext(r, p, rows, shared);
  });

  it('a battle row that throws with every view dirty clears the monsters reconcile that ran before it and leaves battle, export and evolution dirty [SR6B.4]', () => {
    // WRONG IMPL KILLED: a group's views cleared only when the whole group returns (the monsters
    // reconcile runs again); dirtiness kept per group.
    const thrown = new Error('bad battle row');
    const rows = allValid();
    const fix = breakView(rows, 'myBattle', thrown);
    const p = probe(rows);
    const r = createOwnerViewReconciler();
    run(r, p);
    expectReconciled(rows, allBut(['myBattle', 'my_export_bundle', 'myPendingEvolutionNotices']));
    expectLogged([thrown]);
    fix();
    expectRetriedNext(r, p, rows, ['myBattle', 'my_export_bundle', 'myPendingEvolutionNotices']);
  });

  it('an evolution notice row that throws, last of the shared group, leaves only that view dirty [SR6B.4]', () => {
    // WRONG IMPL KILLED: the whole group left dirty by a throw in its last member.
    const thrown = new Error('bad notice row');
    const rows = allValid();
    const fix = breakView(rows, 'myPendingEvolutionNotices', thrown);
    const p = probe(rows);
    const r = createOwnerViewReconciler();
    run(r, p);
    expectReconciled(rows, allBut(['myPendingEvolutionNotices']));
    expectLogged([thrown]);
    fix();
    expectRetriedNext(r, p, rows, ['myPendingEvolutionNotices']);
  });

  it('a throw in the shared group leaves dirty only the dirty members it stopped: a clean member stays clean [SR6B.4]', () => {
    // WRONG IMPL KILLED: dirtiness kept per group, or a throw that dirties its whole group (the
    // clean battle and export reconciles re-run).
    const thrown = new Error('bad monster row');
    const rows = allValid();
    const p = probe(rows);
    const r = drained(p);
    const fix = breakView(rows, 'my_monster_pub', thrown);
    r.markDirty('myPendingEvolutionNotices');
    r.markDirty('my_monster_pub');
    run(r, p);
    expectReconciled(rows, []);
    expect(p.reads, 'the monsters view is read and throws; evolution never runs').toEqual([
      'my_monster_pub',
    ]);
    expectLogged([thrown]);
    fix();
    expectRetriedNext(r, p, rows, ['my_monster_pub', 'myPendingEvolutionNotices']);
  });

  it('a store reconcile that throws leaves its view dirty: with the later members in the shared group, alone in a guarded view [SR6B.4]', () => {
    // WRONG IMPL KILLED: a view cleared once its rows are converted, before the store call returns
    // (a store refusal is lost).
    const battleThrow = new Error('store refused battles');
    const clockThrow = new Error('store refused clocks');
    spyOf('myBattle').mockImplementationOnce(() => {
      throw battleThrow;
    });
    spyOf('myBattleClock').mockImplementationOnce(() => {
      throw clockThrow;
    });
    const rows = allValid();
    const p = probe(rows);
    const r = createOwnerViewReconciler();
    run(r, p);
    expectReconciled(rows, allBut(['my_export_bundle', 'myPendingEvolutionNotices']));
    expectLogged([battleThrow, clockThrow]);
    expectRetriedNext(r, p, rows, [
      'myBattle',
      'my_export_bundle',
      'myPendingEvolutionNotices',
      'myBattleClock',
    ]);
  });

  it('an iter() that throws leaves its view dirty: with the later members in the shared group, alone in a guarded view [SR6B.4]', () => {
    // WRONG IMPL KILLED: a view cleared before its cache is read (an iter() throw loses it).
    const exportThrow = new Error('export iter blew up');
    const unitsThrow = new Error('units iter blew up');
    const rows = allValid();
    const p = probe(rows);
    p.iterThrows.set('my_export_bundle', exportThrow);
    p.iterThrows.set('myBattleUnits', unitsThrow);
    const r = createOwnerViewReconciler();
    run(r, p);
    expectReconciled(
      rows,
      allBut(['my_export_bundle', 'myPendingEvolutionNotices', 'myBattleUnits']),
    );
    expectLogged([exportThrow, unitsThrow]);
    p.iterThrows.clear();
    expectRetriedNext(r, p, rows, [
      'my_export_bundle',
      'myPendingEvolutionNotices',
      'myBattleUnits',
    ]);
  });

  it('an inventory row that throws leaves only the inventory dirty; every other group ran in that reconcile [SR6B.4]', () => {
    // WRONG IMPL KILLED: the inventory group's throw clearing the inventory (lost) or dirtying the
    // shared group.
    const thrown = new Error('bad inventory row');
    const rows = allValid();
    const fix = breakView(rows, 'my_inventory', thrown);
    const p = probe(rows);
    const r = createOwnerViewReconciler();
    run(r, p);
    expectReconciled(rows, allBut(['my_inventory']));
    expectLogged([thrown]);
    fix();
    expectRetriedNext(r, p, rows, ['my_inventory']);
  });

  it.each(
    GUARDED.map((v) => [v.key] as const),
  )('a throwing %s row leaves only that view dirty; every other view ran in that reconcile [SR6B.4]', (key) => {
    // WRONG IMPL KILLED: a guarded view's throw clearing it (lost) or leaving another view dirty.
    const thrown = new Error(`bad ${key} row`);
    const rows = allValid();
    const fix = breakView(rows, key, thrown);
    const p = probe(rows);
    const r = createOwnerViewReconciler();
    run(r, p);
    expectReconciled(rows, allBut([key]));
    expectLogged([thrown]);
    fix();
    expectRetriedNext(r, p, rows, [key]);
  });

  it('a view that keeps throwing is retried and logged on every reconcile until it stops, then cleared [SR6B.4]', () => {
    // WRONG IMPL KILLED: a retry budget (a view that throws twice is dropped and stays stale); a
    // throwing view cleared on a later failure.
    const thrown = new Error('bad trade row');
    const rows = allValid();
    const fix = breakView(rows, 'myTradeSession', thrown);
    const p = probe(rows);
    const r = createOwnerViewReconciler();
    run(r, p);
    expectReconciled(rows, allBut(['myTradeSession']));
    expectLogged([thrown]);
    for (const attempt of ['second', 'third', 'fourth']) {
      clear(p);
      run(r, p);
      expectReconciled(rows, []);
      expect(p.reads, `the ${attempt} reconcile reads the throwing view alone`).toEqual([
        'myTradeSession',
      ]);
      expectLogged([thrown]);
    }
    fix();
    expectRetriedNext(r, p, rows, ['myTradeSession']);
  });
});
