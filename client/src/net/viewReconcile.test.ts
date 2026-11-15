// sr-6a (SR6A.1): reconcileOwnerViews — rebuilds the thirteen owner-view store collections from a
// view cache, containing every throw to its try group. The converters in ./rowConvert are the
// ORACLE; the store is the real AuthoritativeStore with its thirteen reconcile methods spied (no
// call-through: only the arguments, the call order and the logged throws are under test).
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
import { type OwnerViewCache, reconcileOwnerViews } from './viewReconcile';

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

// --- the thirteen views, in call order ---------------------------------------------------------
interface View {
  readonly key: keyof OwnerViewCache;
  readonly method: string;
  readonly valid: () => unknown[];
  /** The oracle: what the store must be handed for these rows. */
  readonly expected: (rows: unknown[]) => unknown[];
}

// biome-ignore lint/suspicious/noExplicitAny: rows are SDK-shaped fixtures cast at the converter edge
const conv = (fn: (row: any) => unknown) => (rows: unknown[]) => rows.map((row) => fn(row));
const convPresent = (fn: (row: never) => unknown) => (rows: unknown[]) =>
  rows.map((row) => fn(row as never)).filter((row) => row !== null);

const VIEWS: readonly View[] = [
  {
    key: 'my_monster_pub',
    method: 'reconcileMonstersFromView',
    valid: () => [sdkMonster(5n), sdkMonster(6n)],
    expected: conv(monsterPubRowToStore),
  },
  {
    key: 'myBattle',
    method: 'reconcileBattlesFromView',
    valid: () => [sdkBattle(47n), sdkBattle(48n)],
    expected: conv(battleRowToStore),
  },
  {
    key: 'my_export_bundle',
    method: 'reconcileExportChunksFromView',
    valid: () => [sdkExportChunk(1n), sdkExportChunk(2n)],
    expected: conv(exportChunkRowToStore),
  },
  {
    key: 'myPendingEvolutionNotices',
    method: 'reconcileEvolutionNoticesFromView',
    valid: () => [sdkEvolutionNotice(5n, ID), sdkEvolutionNotice(6n, OTHER)],
    expected: conv(pendingEvolutionNoticeRowToStore),
  },
  {
    key: 'my_inventory',
    method: 'reconcileInventoryFromView',
    valid: () => [sdkInventory(1n), sdkInventory(2n)],
    expected: conv(inventoryRowToStore),
  },
  {
    key: 'myTacticalBattle',
    method: 'reconcileTacticalBattlesFromView',
    valid: () => [sdkTactical(BT, 7), sdkTactical(BT + 8n, 11)],
    expected: convPresent(tacticalBattleRowToStore),
  },
  {
    key: 'myBattleUnits',
    method: 'reconcileBattleUnitsFromView',
    valid: () => [sdkUnit(3), sdkUnit(5)],
    expected: conv(battleUnitRowToStore),
  },
  {
    key: 'myBattleQueue',
    method: 'reconcileBattleQueuesFromView',
    valid: () => [sdkQueue(3), sdkQueue(5)],
    expected: convPresent(battleQueueRowToStore),
  },
  {
    key: 'myBattleDeploy',
    method: 'reconcileBattleDeploysFromView',
    valid: () => [sdkDeploy(13n), sdkDeploy(14n)],
    expected: conv(battleDeployRowToStore),
  },
  {
    key: 'myBattleClock',
    method: 'reconcileBattleClocksFromView',
    valid: () => [sdkClock(19n), sdkClock(20n)],
    expected: conv(battleClockRowToStore),
  },
  {
    key: 'myBattleEvents',
    method: 'reconcileBattleEventsFromView',
    valid: () => [sdkEvent(29n, 1), sdkEvent(31n, 2)],
    expected: conv(battleEventRowToStore),
  },
  {
    key: 'myFormation',
    method: 'reconcileFormationFromView',
    valid: () => [sdkFormation([37n, 41n]), sdkFormation([43n])],
    expected: conv(formationRowToStore),
  },
  {
    key: 'myTradeSession',
    method: 'reconcileTradeSessionsFromView',
    valid: () => [sdkTrade(9n), sdkTrade(4n)],
    expected: conv(tradeSessionRowToStore),
  },
];

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

  it('SR6A.1 every one of the thirteen views is reconciled exactly once with the converted rows', () => {
    const rows = allValid();
    reconcileOwnerViews(store, makeCache(rows));
    expectAllBut(rows, []);
    for (const v of VIEWS) {
      expect(v.expected(rows[v.key] ?? []).length, `${v.key} fixture is non-empty`).toBeGreaterThan(
        0,
      );
    }
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
  });

  it('SR6A.1 the thirteen reconciles run in call order', () => {
    reconcileOwnerViews(store, makeCache(allValid()));
    const order = VIEWS.map((v) => spyOf(v.key).mock.invocationCallOrder[0]);
    expect(order.every((n) => typeof n === 'number')).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(13);
  });

  it('SR6A.1 empty caches reconcile every view once with an empty array', () => {
    reconcileOwnerViews(store, makeCache({}));
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
    reconcileOwnerViews(store, makeCache(rows));
    const sent = spyOf('myTacticalBattle').mock.calls[0]?.[0] as unknown[];
    expect(sent).toEqual([tacticalBattleRowToStore(good as never)]);
    expect(sent).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('SR6A.1 a battle queue row with an unknown action tag is dropped and its sibling delivered', () => {
    const good = sdkQueue(5);
    const rows: Rows = { myBattleQueue: [sdkQueue(3, 'NoSuchAction'), good] };
    reconcileOwnerViews(store, makeCache(rows));
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
    expect(() => reconcileOwnerViews(store, makeCache(rows))).not.toThrow();
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
    reconcileOwnerViews(store, makeCache(rows));
    expect(spyOf('myBattle')).not.toHaveBeenCalled();
    expectLogged([thrown]);
  });

  it('SR6A.1 a store reconcile that throws in a guarded view is contained and logged as the thrown object', () => {
    const thrown = new Error('store refused units');
    storeThrows('myBattleUnits', thrown);
    const rows = allValid();
    expect(() => reconcileOwnerViews(store, makeCache(rows))).not.toThrow();
    expectAllBut(rows, []);
    expectLogged([thrown]);
  });

  it('SR6A.1 a store throw in the monsters reconcile skips battles, export and evolution only', () => {
    const thrown = new Error('store refused monsters');
    storeThrows('my_monster_pub', thrown);
    const rows = allValid();
    expect(() => reconcileOwnerViews(store, makeCache(rows))).not.toThrow();
    expectAllBut(rows, ['myBattle', 'my_export_bundle', 'myPendingEvolutionNotices']);
    expectLogged([thrown]);
  });

  it('SR6A.1 a store throw in the battles reconcile skips export and evolution only', () => {
    const thrown = new Error('store refused battles');
    storeThrows('myBattle', thrown);
    const rows = allValid();
    expect(() => reconcileOwnerViews(store, makeCache(rows))).not.toThrow();
    expectAllBut(rows, ['my_export_bundle', 'myPendingEvolutionNotices']);
    expectLogged([thrown]);
  });

  it('SR6A.1 a store throw in the export reconcile skips evolution only', () => {
    const thrown = new Error('store refused export');
    storeThrows('my_export_bundle', thrown);
    const rows = allValid();
    expect(() => reconcileOwnerViews(store, makeCache(rows))).not.toThrow();
    expectAllBut(rows, ['myPendingEvolutionNotices']);
    expectLogged([thrown]);
  });

  it('SR6A.1 a store throw in the inventory reconcile leaves every other view reconciled', () => {
    const thrown = new Error('store refused inventory');
    storeThrows('my_inventory', thrown);
    const rows = allValid();
    expect(() => reconcileOwnerViews(store, makeCache(rows))).not.toThrow();
    expectAllBut(rows, []);
    expectLogged([thrown]);
  });

  it('SR6A.1 an iter() that throws in the shared group skips the later members of that group only', () => {
    const thrown = new Error('iter blew up');
    const rows = allValid();
    expect(() => reconcileOwnerViews(store, iterThrowing(rows, 'myBattle', thrown))).not.toThrow();
    expectAllBut(rows, ['myBattle', 'my_export_bundle', 'myPendingEvolutionNotices']);
    expectLogged([thrown]);
  });

  it('SR6A.1 an iter() that throws in a guarded view skips that view only', () => {
    const thrown = new Error('iter blew up');
    const rows = allValid();
    expect(() =>
      reconcileOwnerViews(store, iterThrowing(rows, 'myBattleClock', thrown)),
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
    expect(() => reconcileOwnerViews(store, makeCache(rows))).not.toThrow();
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
      reconcileOwnerViews(store, iterThrowing(rows, 'myTradeSession', 'boom')),
    ).not.toThrow();
    expectAllBut(rows, ['myTradeSession']);
    expectLogged(['boom']);
  });

  it('SR6A.1 a non-Error thrown in the shared group and in the inventory view is contained and logged as thrown', () => {
    const rows = allValid();
    rows.myBattle = [malformed('shared boom'), ...(rows.myBattle ?? [])];
    rows.my_inventory = [malformed(42), ...(rows.my_inventory ?? [])];
    expect(() => reconcileOwnerViews(store, makeCache(rows))).not.toThrow();
    expectAllBut(rows, [
      'myBattle',
      'my_export_bundle',
      'myPendingEvolutionNotices',
      'my_inventory',
    ]);
    expectLogged(['shared boom', 42]);
  });
});
