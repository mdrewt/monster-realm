// @vitest-environment happy-dom
/**
 * main.dispatch.test.ts: every view callback main.ts hands a view constructor reaches the right
 * reducer with exactly the arguments the view passed (ctl-6b, CTL6B.1: one exhaustive `dispatch`).
 *
 * main.controls.test.ts proves a handful of arms through real clicks. This file proves ALL of them,
 * by capturing the handler object each view constructor receives: the eleven views that own a
 * callback (box, battle, raising, evolution, shop, trade, pvp, claim, privacy, rename and
 * trade-propose) are replaced by a recording stand-in class, then each handler is invoked with
 * DISTINCT, non-zero, non-empty values per field and the stubbed connection must record exactly one
 * reducer call: its name and its argument object, verbatim. Two arms that were swapped, a field
 * forced to 0 or empty, a dropped argument, a party list that reads the wrong monsters, a promise
 * that is not handed back to the view's in-flight lock, and a feedback line routed to the wrong
 * overlay each change that record.
 *
 * Only the views are replaced. The booted main.ts, the router, the stack, the claim and privacy
 * models and the stubbed SDK connection are the real ones (main.controls.test.ts's harness, with
 * the connection's frozen flag and a reducer gate made controllable). The real client/index.html
 * shell is mounted first so the views that stay real (dialogue, quest log, menu...) construct.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Identity } from 'spacetimedb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import type { Connection, ConnectionOptions } from './net/connection';
import type { StoreMonsterPub } from './net/store';

const H = vi.hoisted(() => {
  interface StubView {
    visible: boolean;
    feedback: string[];
    renders: unknown[];
  }
  const h = {
    identity: 'ab'.repeat(32),
    connectOpts: null as ConnectionOptions | null,
    /** Every enqueueMove the client issued. */
    sends: [] as unknown[],
    /** Every other reducer call, oldest first, with the exact argument object it received. */
    calls: [] as Array<{ name: string; args: unknown }>,
    /** The handler object each recorded view constructor received, keyed by view class name. */
    handlers: {} as Record<string, Record<string, unknown>>,
    /** The recorded view instances, keyed by view class name. */
    views: {} as Record<string, StubView>,
    /** The stubbed connection's link state. */
    frozen: false,
    /** How many times the connection was asked to start a sign-in. */
    signIns: 0,
    /** When set, every non-movement reducer returns it instead of an already-settled promise. */
    gate: null as Promise<void> | null,
    /** A recording stand-in for a view class: it keeps its constructor's LAST argument (the handler
     *  object; the box, battle, raising and evolution views take a mount first) and exposes every
     *  method main.ts calls on a view. */
    makeStub: (name: string) =>
      class {
        visible = false;
        feedback: string[] = [];
        renders: unknown[] = [];
        constructor(...args: unknown[]) {
          h.handlers[name] = args[args.length - 1] as Record<string, unknown>;
          h.views[name] = this as unknown as StubView;
        }
        show(): void {
          this.visible = true;
        }
        hide(): void {
          this.visible = false;
        }
        toggle(): void {
          this.visible = !this.visible;
        }
        render(vm: unknown): void {
          this.renders.push(vm);
        }
        refresh(vm: unknown): void {
          this.renders.push(vm);
        }
        showFeedback(message: string): void {
          this.feedback.push(message);
        }
      },
  };
  return h;
});

vi.mock('./ui/boxView', () => ({ BoxView: H.makeStub('BoxView') }));
vi.mock('./ui/battleView', () => ({ BattleView: H.makeStub('BattleView') }));
vi.mock('./ui/raisingView', () => ({ RaisingView: H.makeStub('RaisingView') }));
vi.mock('./ui/evolutionView', () => ({ EvolutionView: H.makeStub('EvolutionView') }));
vi.mock('./ui/shopView', () => ({ ShopView: H.makeStub('ShopView') }));
vi.mock('./ui/tradeView', () => ({ TradeView: H.makeStub('TradeView') }));
vi.mock('./ui/pvpView', () => ({ PvpView: H.makeStub('PvpView') }));
vi.mock('./ui/claimView', () => ({ ClaimView: H.makeStub('ClaimView') }));
vi.mock('./ui/privacyView', () => ({ PrivacyView: H.makeStub('PrivacyView') }));
vi.mock('./ui/renameView', () => ({ RenameView: H.makeStub('RenameView') }));
vi.mock('./ui/tradeProposeView', () => ({ TradeProposeView: H.makeStub('TradeProposeView') }));

// wasm pkg: every name main.ts imports. The party size (3), the box sentinel (255) and the
// per-side trade cap (37) are distinct so a handler argument or a constant read from the wrong
// export shows.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 8;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: (state: unknown) => state,
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 37,
    talk_range: () => 2,
    predict_move: () => ({}),
    predict_tick: () => ({}),
    set_active_zone: () => undefined,
    start: () => undefined,
    step_ms: () => 200,
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

// The connection: capture the options; enqueueMove never settles, every other reducer records its
// name and arguments and resolves at once (or when the test's gate opens).
vi.mock('./net/connection', () => {
  const reducers = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'enqueueMove') {
          return (args: unknown) =>
            new Promise<void>(() => {
              H.sends.push(args);
            });
        }
        return (args: unknown) => {
          H.calls.push({ name: String(name), args });
          return H.gate ?? Promise.resolve();
        };
      },
    },
  );
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => live,
    identity: () => H.identity,
    linkFrozen: () => H.frozen,
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => {
      H.signIns += 1;
    },
    reconnectNow: () => undefined,
  } as unknown as Connection;
  return {
    connect: (opts: ConnectionOptions): Connection => {
      H.connectOpts = opts;
      return stub;
    },
  };
});

vi.mock('./observability/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./observability/telemetry')>();
  return {
    ...actual,
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
});

vi.mock('./render/world', () => {
  class WorldRenderer {
    init(mount: HTMLElement): Promise<void> {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('tabindex', '0');
      canvas.setAttribute('role', 'application');
      mount.appendChild(canvas);
      return Promise.resolve();
    }
    setMap(): void {}
    render(): void {}
    resize(): void {}
    screenFor(): { x: number; y: number } {
      return { x: 0, y: 0 };
    }
    clear(): void {}
    destroy(): void {}
    get viewCount(): number {
      return 0;
    }
  }
  return { WorldRenderer };
});

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

/** Mount the REAL client/index.html shell (minus its module script) into the live document. */
function mountIndexHtmlShell(): void {
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  const parsed = new DOMParser().parseFromString(readFileSync(htmlPath, 'utf8'), 'text/html');
  const children = Array.from(parsed.body.children).filter((el) => el.tagName !== 'SCRIPT');
  expect(children.length, 'index.html must yield a body to mount').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

const clock = { t: 0 };
let rafCallback: FrameRequestCallback | null = null;
let opts: ConnectionOptions;
/** The i18n resolver instance main.ts runs on (imported AFTER the module reset, so it is shared). */
let i18n: typeof import('./ui/i18n/resolver');

async function boot(): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.handlers = {};
  H.views = {};
  H.frozen = false;
  H.signIns = 0;
  H.gate = null;
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  rafCallback = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallback = cb;
    return 0;
  });
  vi.resetModules();
  await import('./main');
  i18n = await import('./ui/i18n/resolver');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
}

async function bootReady(): Promise<void> {
  await boot();
  opts.onReady(H.identity);
}

/** Run one frame at clock `t`. Throws if the frame did not re-arm (it re-arms in `finally`). */
function frame(t: number): void {
  const cb = rafCallback;
  if (cb === null) throw new Error('no rAF callback armed');
  rafCallback = null;
  clock.t = t;
  cb(t);
  expect(rafCallback, 'frame did not re-arm requestAnimationFrame').not.toBeNull();
}

const EID = 7n;
const OTHER_IDENTITY = 'cd'.repeat(32);

/** Deliver one authoritative batch: the own player + character at (2, 6). */
function server(t: number): void {
  clock.t = t;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    lastInputSeq: 0n,
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
    },
    t,
  );
  opts.store.flushBatch();
}

/** Let queued microtasks and zero-delay timers run (a settled reducer promise). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** An own monster row; only the identity, id, slot and a nickname matter to the dispatch arms. */
function monster(monsterId: bigint, partySlot: number): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: H.identity,
    speciesId: 1,
    nickname: `m${monsterId}`,
    level: 5,
    xp: 0,
    currentHp: 20,
    statHp: 20,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot,
    tier: 0,
    essence: {} as StoreMonsterPub['essence'],
    trustTier: 'Unknown' as StoreMonsterPub['trustTier'],
    qualityTimeTier: 0,
    nutritionPct: 0,
  };
}

const handlerOf = (view: string, name: string): ((...a: unknown[]) => unknown) => {
  const handlers = H.handlers[view];
  if (handlers === undefined) throw new Error(`${view} was never constructed by main.ts`);
  const fn = handlers[name];
  if (typeof fn !== 'function') throw new Error(`${view} received no ${name} handler`);
  return (fn as (...a: unknown[]) => unknown).bind(handlers);
};

const isThenable = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';

interface Row {
  readonly label: string;
  readonly view: string;
  readonly handler: string;
  readonly args: readonly unknown[];
  readonly expected: ReadonlyArray<{ name: string; args: unknown }>;
}

const statusText = (): string => document.getElementById('status')?.textContent ?? '';

describe('main.ts view callbacks reach dispatch (ctl-6b)', { sequential: true }, () => {
  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rafCallback = null;
    H.gate = null;
    H.frozen = false;
    window.history.replaceState(null, '', '/');
    document.body.replaceChildren();
  });

  it('every reducer-backed view callback sends exactly its reducer with exactly its arguments, and hands the view the promise', async () => {
    // WRONG IMPL KILLED: a callback wired to a sibling's arm (setNickname vs setPartySlot,
    // acceptChallenge vs declineChallenge vs cancelChallenge, onAccept vs onReject: one reducer,
    // opposite `accepted`, flee vs swap vs recruit: same battleId, different second field, pvp Attack
    // vs Swap: one reducer, a different tag), a field forced to 0 or empty or dropped (every row uses
    // distinct non-zero values), a swapped field pair (buy's shopId and itemId, train's monsterId and
    // foodItemId), a constant sent in place of a value (qty, the heal location, the free slot), a
    // party list read from the wrong monsters (the boxed one is excluded and the order is the
    // store's), an Identity built from the wrong string, and a callback that no longer returns its
    // promise (the view's in-flight lock would release at once).
    await bootReady();
    server(1000);
    // Party: 51 in slot 2, 50 in slot 0, 52 boxed (255). Free slot: 1. Party ids, store order.
    opts.store.upsertMonster(monster(51n, 2));
    opts.store.upsertMonster(monster(50n, 0));
    opts.store.upsertMonster(monster(52n, 255));
    // Two heal pads: the first one in the store is the target.
    for (const locationId of [7, 9]) {
      opts.store.upsertHealLocation({
        locationId,
        zoneId: 0,
        tileX: 1,
        tileY: 1,
        costQty: 0,
        cooldownMs: 0,
        costCurrency: 0n,
      });
    }
    const party = [51n, 50n];
    const other = new Identity(OTHER_IDENTITY);

    const rows: readonly Row[] = [
      {
        label: 'box setNickname',
        view: 'BoxView',
        handler: 'onSetNickname',
        args: [61n, 'Zorp'],
        expected: [{ name: 'setNickname', args: { monsterId: 61n, nickname: 'Zorp' } }],
      },
      {
        label: 'box setPartySlot explicit',
        view: 'BoxView',
        handler: 'onSetPartySlot',
        args: [62n, 2],
        expected: [{ name: 'setPartySlot', args: { monsterId: 62n, slot: 2 } }],
      },
      {
        label: 'box setPartySlot -1 takes the free slot',
        view: 'BoxView',
        handler: 'onSetPartySlot',
        args: [63n, -1],
        expected: [{ name: 'setPartySlot', args: { monsterId: 63n, slot: 1 } }],
      },
      {
        label: 'box healParty targets the first loaded pad',
        view: 'BoxView',
        handler: 'onHealParty',
        args: [],
        expected: [{ name: 'healParty', args: { locationId: 7 } }],
      },
      {
        label: 'battle attack',
        view: 'BattleView',
        handler: 'onAttack',
        args: [901n, 33],
        expected: [{ name: 'submitAttack', args: { battleId: 901n, skillId: 33 } }],
      },
      {
        label: 'battle flee',
        view: 'BattleView',
        handler: 'onFlee',
        args: [902n],
        expected: [{ name: 'flee', args: { battleId: 902n } }],
      },
      {
        label: 'battle swap',
        view: 'BattleView',
        handler: 'onSwap',
        args: [903n, 4],
        expected: [{ name: 'swapActive', args: { battleId: 903n, teamIndex: 4 } }],
      },
      {
        label: 'battle recruit',
        view: 'BattleView',
        handler: 'onRecruit',
        args: [904n, 55],
        expected: [{ name: 'attemptRecruit', args: { battleId: 904n, baitItemId: 55 } }],
      },
      {
        label: 'battle useItem',
        view: 'BattleView',
        handler: 'onUseItem',
        args: [905n, 66],
        expected: [{ name: 'useBattleItem', args: { battleId: 905n, itemId: 66 } }],
      },
      {
        label: 'battle pvp attack',
        view: 'BattleView',
        handler: 'onPvpAttack',
        args: [906n, 37],
        expected: [
          {
            name: 'submitPvpAction',
            args: { battleId: 906n, action: { tag: 'Attack', value: 37 } },
          },
        ],
      },
      {
        label: 'battle pvp swap',
        view: 'BattleView',
        handler: 'onPvpSwap',
        args: [907n, 5],
        expected: [
          { name: 'submitPvpAction', args: { battleId: 907n, action: { tag: 'Swap', value: 5 } } },
        ],
      },
      {
        label: 'raising train',
        view: 'RaisingView',
        handler: 'onTrain',
        args: [71n, 44],
        expected: [{ name: 'train', args: { monsterId: 71n, foodItemId: 44 } }],
      },
      {
        label: 'raising care',
        view: 'RaisingView',
        handler: 'onCare',
        args: [72n],
        expected: [{ name: 'care', args: { monsterId: 72n } }],
      },
      {
        label: 'evolution evolve',
        view: 'EvolutionView',
        handler: 'onEvolve',
        args: [73n, 88],
        expected: [{ name: 'evolve', args: { monsterId: 73n, toSpecies: 88 } }],
      },
      {
        label: 'shop buy',
        view: 'ShopView',
        handler: 'onBuy',
        args: [11, 22],
        expected: [{ name: 'buy', args: { shopId: 11, itemId: 22, qty: 1 } }],
      },
      {
        label: 'shop sell',
        view: 'ShopView',
        handler: 'onSell',
        args: [23],
        expected: [{ name: 'sell', args: { itemId: 23, qty: 1 } }],
      },
      {
        label: 'trade accept',
        view: 'TradeView',
        handler: 'onAccept',
        args: [81n],
        expected: [{ name: 'respondTrade', args: { tradeId: 81n, accepted: true } }],
      },
      {
        label: 'trade reject',
        view: 'TradeView',
        handler: 'onReject',
        args: [82n],
        expected: [{ name: 'respondTrade', args: { tradeId: 82n, accepted: false } }],
      },
      {
        label: 'trade confirm',
        view: 'TradeView',
        handler: 'onConfirm',
        args: [83n],
        expected: [{ name: 'confirmTrade', args: { tradeId: 83n } }],
      },
      {
        label: 'trade cancel',
        view: 'TradeView',
        handler: 'onCancel',
        args: [84n],
        expected: [{ name: 'cancelTrade', args: { tradeId: 84n } }],
      },
      {
        label: 'pvp challenge',
        view: 'PvpView',
        handler: 'onChallenge',
        args: [OTHER_IDENTITY],
        expected: [{ name: 'challengePvp', args: { target: other, partyIds: party } }],
      },
      {
        label: 'pvp accept',
        view: 'PvpView',
        handler: 'onAccept',
        args: [91n],
        expected: [{ name: 'acceptChallenge', args: { challengeId: 91n, partyIds: party } }],
      },
      {
        label: 'pvp decline',
        view: 'PvpView',
        handler: 'onDecline',
        args: [92n],
        expected: [{ name: 'declineChallenge', args: { challengeId: 92n } }],
      },
      {
        label: 'pvp cancel',
        view: 'PvpView',
        handler: 'onCancel',
        args: [93n],
        expected: [{ name: 'cancelChallenge', args: { challengeId: 93n } }],
      },
      {
        label: 'rename submit',
        view: 'RenameView',
        handler: 'onSubmit',
        args: ['Zed'],
        expected: [{ name: 'setProfileName', args: { name: 'Zed' } }],
      },
      {
        label: 'trade-propose submit',
        view: 'TradeProposeView',
        handler: 'onSubmit',
        args: [
          {
            targetIdentity: OTHER_IDENTITY,
            initiatorMonsterIds: [51n, 52n],
            initiatorCurrency: 300n,
            counterpartyCurrency: 700n,
          },
        ],
        expected: [
          {
            name: 'proposeTrade',
            args: {
              counterparty: other,
              initiatorMonsterIds: [51n, 52n],
              initiatorItems: [],
              initiatorCurrency: 300n,
              counterpartyMonsterIds: [],
              counterpartyItems: [],
              counterpartyCurrency: 700n,
            },
          },
        ],
      },
    ];

    for (const row of rows) {
      H.calls = [];
      const returned = handlerOf(row.view, row.handler)(...row.args);
      await flush();
      expect(H.calls, `${row.label}: the reducer calls`).toEqual(row.expected);
      expect(isThenable(returned), `${row.label}: the callback hands the view a promise`).toBe(
        true,
      );
    }

    // The constants main.ts hands to its views at construction come from the wasm exports.
    expect(
      H.handlers.BoxView?.partySlotNone,
      'the box sentinel is the party_slot_none export',
    ).toBe(255);
    expect(
      H.handlers.TradeProposeView?.maxMonstersPerSide,
      'the per-side cap is the max_trade_monsters_per_side export',
    ).toBe(37);
  });

  it('dispatch skips: a full party sends nothing for the box slot and says why, an explicit slot still sends, and a heal with no loaded pad sends nothing and says why', async () => {
    // WRONG IMPL KILLED: a -1 that sends the box sentinel into a full party (an accepted server
    // no-op the player never sees), a full-party guard that also blocks an explicit slot, a heal
    // that sends locationId 0 when no pad is loaded (a guaranteed invisible Err), a skip that is
    // silent, and a skip that stays on after a pad IS loaded.
    await bootReady();
    server(1000);
    for (const [id, slot] of [
      [41n, 0],
      [42n, 1],
      [43n, 2],
      [44n, 255],
    ] as const) {
      opts.store.upsertMonster(monster(id, slot));
    }
    const status = document.getElementById('status');
    if (status === null) throw new Error('#status must exist once booted');

    status.textContent = '';
    handlerOf('BoxView', 'onSetPartySlot')(44n, -1);
    await flush();
    expect(H.calls, 'a full party has no slot to move into').toEqual([]);
    expect(statusText(), 'and the player is told').toBe(i18n.t('chrome.status.partyFull'));

    handlerOf('BoxView', 'onSetPartySlot')(44n, 1);
    await flush();
    expect(H.calls, 'an explicit slot is not blocked by the guard').toEqual([
      { name: 'setPartySlot', args: { monsterId: 44n, slot: 1 } },
    ]);

    H.calls = [];
    status.textContent = '';
    handlerOf('BoxView', 'onHealParty')();
    await flush();
    expect(H.calls, 'no heal pad loaded: nothing is sent').toEqual([]);
    expect(statusText(), 'and the player is told').toBe(i18n.t('chrome.status.healUnavailable'));

    opts.store.upsertHealLocation({
      locationId: 5,
      zoneId: 0,
      tileX: 1,
      tileY: 1,
      costQty: 0,
      cooldownMs: 0,
      costCurrency: 0n,
    });
    handlerOf('BoxView', 'onHealParty')();
    await flush();
    expect(H.calls, 'with a pad loaded the heal is sent to it').toEqual([
      { name: 'healParty', args: { locationId: 5 } },
    ]);
  });

  it('the promise a callback returns stays pending until the reducer settles, for the sendGuarded, performCare and pvp-action paths', async () => {
    // WRONG IMPL KILLED: a callback that fires dispatch and returns an already-settled promise (the
    // view's in-flight lock, a dead-click guard against a double spend, would release at once), and
    // an arm that awaits nothing.
    await bootReady();
    server(1000);
    const cases: ReadonlyArray<readonly [string, string, readonly unknown[]]> = [
      ['BattleView', 'onAttack', [901n, 33]],
      ['BattleView', 'onPvpAttack', [906n, 37]],
      ['RaisingView', 'onCare', [72n]],
      ['TradeView', 'onAccept', [81n]],
      ['PvpView', 'onChallenge', [OTHER_IDENTITY]],
      ['RenameView', 'onSubmit', ['Zed']],
      ['BoxView', 'onSetPartySlot', [62n, 2]],
    ];
    for (const [view, name, args] of cases) {
      let release: () => void = () => {};
      H.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let settled = false;
      const returned = handlerOf(view, name)(...args) as Promise<void>;
      void returned.then(() => {
        settled = true;
      });
      await flush();
      expect(settled, `${view}.${name}: pending while the reducer is unsettled`).toBe(false);
      release();
      await flush();
      expect(settled, `${view}.${name}: settles once the reducer does`).toBe(true);
      H.gate = null;
    }
  });

  it('each feedback action paints its own success line on its own overlay only while that overlay is shown', async () => {
    // WRONG IMPL KILLED: a success line routed to the wrong overlay's sink (shop to trade), a swapped
    // accepted/rejected line (the player is told the opposite of what they chose), the wrong message
    // for confirm vs cancel, a sink that paints into a hidden overlay (a stale line on the next
    // open), and a feedback that never reaches its view.
    await bootReady();
    server(1000);
    const all = [
      'BoxView',
      'BattleView',
      'RaisingView',
      'EvolutionView',
      'ShopView',
      'TradeView',
      'PvpView',
      'RenameView',
      'TradeProposeView',
    ];
    const cases: ReadonlyArray<readonly [string, string, readonly unknown[], string]> = [
      ['TradeView', 'onAccept', [81n], 'trade.feedback.accepted'],
      ['TradeView', 'onReject', [82n], 'trade.feedback.rejected'],
      ['TradeView', 'onConfirm', [83n], 'trade.feedback.completed'],
      ['TradeView', 'onCancel', [84n], 'trade.feedback.cancelled'],
      ['ShopView', 'onBuy', [11, 22], 'shop.feedback.purchased'],
      ['ShopView', 'onSell', [23], 'shop.feedback.sold'],
      ['RenameView', 'onSubmit', ['Zed'], 'chrome.rename.updated'],
      [
        'TradeProposeView',
        'onSubmit',
        [
          {
            targetIdentity: OTHER_IDENTITY,
            initiatorMonsterIds: [51n],
            initiatorCurrency: 3n,
            counterpartyCurrency: 4n,
          },
        ],
        'tradePropose.feedback.sent',
      ],
      ['RaisingView', 'onCare', [72n], 'raising.feedback.cared'],
    ];
    const feedbackOf = (name: string): string[] => H.views[name]?.feedback ?? [];

    for (const [target, name, args, key] of cases) {
      for (const v of all) {
        const view = H.views[v];
        if (view !== undefined) {
          view.feedback.length = 0;
          view.visible = false;
        }
      }
      // Hidden first: a late settle must not write into a closed overlay (care paints regardless).
      if (target !== 'RaisingView') {
        handlerOf(target, name)(...args);
        await flush();
        expect(feedbackOf(target), `${target}.${name}: nothing paints while hidden`).toEqual([]);
        const hiddenView = H.views[target];
        if (hiddenView !== undefined) hiddenView.visible = true;
      }
      handlerOf(target, name)(...args);
      await flush();
      for (const v of all) {
        expect(feedbackOf(v), `${target}.${name}: the feedback of ${v}`).toEqual(
          v === target ? [i18n.t(key as never)] : [],
        );
      }
    }
  });

  it('claim: onJoin and onDeclineConfirmed are different arms, onSignIn starts the sign-in, and neither claim action trusts a frozen link', async () => {
    // WRONG IMPL KILLED: onJoin wired to decline-confirmed (or the reverse: with the veto up a join
    // is refused with the veto line, a decline lifts it), a join that sends joinGame past the veto,
    // a decline that joins, a sign-in that never reaches the connection, and a hasLiveConnection
    // forced true (a frozen link would send joinGame into the void, or delete the claim code).
    await bootReady();
    server(1000);
    const claim = H.handlers.ClaimView;
    if (claim === undefined) throw new Error('ClaimView was never constructed');
    const vmOf = (): {
      feedback: string | undefined;
      actions: { join: boolean; declineConfirm: boolean };
    } => H.views.ClaimView?.renders.at(-1) as never;
    const call = (name: string): void => {
      (claim[name] as () => void)();
    };

    // A permitted join: joining sends joinGame, declining with nothing armed sends nothing.
    opts.onClaimResult({ ok: true } as never);
    H.calls = [];
    call('onDeclineConfirmed');
    expect(H.calls, 'decline-confirmed with nothing armed sends nothing').toEqual([]);
    call('onJoin');
    expect(H.calls, 'onJoin sends joinGame').toEqual([
      { name: 'joinGame', args: { name: 'Player' } },
    ]);
    call('onSignIn');
    expect(H.signIns, 'onSignIn starts the sign-in once').toBe(1);

    // The veto up, a decline armed: a join is refused, the decline then lifts the veto.
    opts.onClaimPending('CODE-1');
    call('onDeclineRequested');
    expect(vmOf().actions.declineConfirm, 'precondition: the decline is armed').toBe(true);
    H.calls = [];
    call('onJoin');
    expect(H.calls, 'a join under the veto sends nothing').toEqual([]);
    expect(vmOf().feedback, 'and says why').toBe(i18n.t('claim.feedback.veto'));
    expect(vmOf().actions.declineConfirm, 'the armed decline survives the refused join').toBe(true);
    call('onDeclineConfirmed');
    expect(H.calls, 'a confirmed decline sends no joinGame').toEqual([]);
    expect(vmOf().actions.join, 'it lifts the veto: join is offered').toBe(true);
    expect(vmOf().actions.declineConfirm, 'and the confirmation is spent').toBe(false);

    // A frozen link refuses both, visibly, and keeps the decline armed.
    opts.onClaimResult({ ok: true } as never);
    H.frozen = true;
    H.calls = [];
    call('onJoin');
    expect(H.calls, 'a frozen link sends no joinGame').toEqual([]);
    expect(vmOf().feedback, 'and says it is disconnected').toBe(
      i18n.t('chrome.feedback.disconnected'),
    );
    H.frozen = false;
    call('onJoin');
    expect(H.calls, 'the same click on a live link joins').toEqual([
      { name: 'joinGame', args: { name: 'Player' } },
    ]);

    opts.onClaimPending('CODE-2');
    call('onDeclineRequested');
    H.frozen = true;
    call('onDeclineConfirmed');
    expect(vmOf().feedback, 'a frozen link refuses the decline').toBe(
      i18n.t('chrome.feedback.disconnected'),
    );
    expect(vmOf().actions.declineConfirm, 'and the confirmation stays armed').toBe(true);
    H.frozen = false;
    call('onDeclineConfirmed');
    expect(vmOf().actions.join, 'the retry on a live link lifts the veto').toBe(true);
  });

  /** Seed the own account row at `status`, deliver it and run one frame so the privacy model sees it. */
  function seedAccount(status: 'Active' | 'PendingDeletion'): void {
    opts.store.upsertAccount({
      identity: H.identity,
      authIssuer: '',
      createdAtMs: 0n,
      lastLoginAtMs: 0n,
      status,
      deletionRequestedAtMs: status === 'PendingDeletion' ? 1n : undefined,
      claimedFrom: undefined,
      claimedAtMs: undefined,
      terminalAtMs: undefined,
    });
    server(1050);
    frame(1100);
  }

  const privacy = (name: string): (() => void) => {
    const handlers = H.handlers.PrivacyView;
    if (handlers === undefined) throw new Error('PrivacyView was never constructed');
    return handlers[name] as () => void;
  };

  it('privacy: on an active account delete needs its armed confirmation, and export sends its own reducer', async () => {
    // WRONG IMPL KILLED: a confirm wired to the export arm (it would send requestDataExport with
    // nothing armed), a delete that sends before the confirmation is armed, an arm that sends
    // before the confirm, a cancel handler wired to delete or export (cancel is refused on an
    // active account), and an export that sends the wrong reducer.
    await bootReady();
    server(1000);
    seedAccount('Active');
    H.calls = [];

    privacy('onDeleteConfirmed')();
    expect(H.calls, 'a confirm with nothing armed sends nothing').toEqual([]);
    privacy('onDeleteRequested')();
    expect(H.calls, 'arming sends nothing').toEqual([]);
    privacy('onDeleteConfirmed')();
    expect(H.calls, 'the armed confirm sends deleteAccount').toEqual([
      { name: 'deleteAccount', args: {} },
    ]);
    await flush();

    H.calls = [];
    privacy('onCancelDeletion')();
    expect(H.calls, 'cancel is refused on an active account').toEqual([]);
    privacy('onExportRequested')();
    expect(H.calls, 'export sends requestDataExport').toEqual([
      { name: 'requestDataExport', args: {} },
    ]);
  });

  it('privacy: on an account pending deletion cancel sends its own reducer and delete and export are refused', async () => {
    // WRONG IMPL KILLED: a cancel handler wired to the export or delete arm (both are refused while
    // a deletion is pending, so the cancel would send nothing) and a delete or export handler wired
    // to cancel (it would send cancelAccountDeletion).
    await bootReady();
    server(1000);
    seedAccount('PendingDeletion');
    H.calls = [];

    privacy('onExportRequested')();
    privacy('onDeleteRequested')();
    privacy('onDeleteConfirmed')();
    expect(H.calls, 'export and delete are refused while a deletion is pending').toEqual([]);
    privacy('onCancelDeletion')();
    expect(H.calls, 'cancel sends cancelAccountDeletion').toEqual([
      { name: 'cancelAccountDeletion', args: {} },
    ]);
  });

  it('privacy: a frozen link sends no privacy reducer and keeps the delete armed, and the same click on a live link sends it', async () => {
    // WRONG IMPL KILLED: a hasLiveConnection forced true (a frozen link would call a dead reducer
    // handle and strand the model's in-flight flag), and a refused click that spends the armed
    // confirmation (the player's retry would need both clicks again).
    await bootReady();
    server(1000);
    seedAccount('Active');
    H.calls = [];

    privacy('onDeleteRequested')();
    H.frozen = true;
    privacy('onDeleteConfirmed')();
    expect(H.calls, 'a frozen link sends no deleteAccount').toEqual([]);
    privacy('onExportRequested')();
    expect(H.calls, 'nor requestDataExport').toEqual([]);

    H.frozen = false;
    privacy('onDeleteConfirmed')();
    expect(
      H.calls,
      'the retry on a live link sends deleteAccount: the confirmation stayed armed',
    ).toEqual([{ name: 'deleteAccount', args: {} }]);
    await flush();
    H.calls = [];
    privacy('onExportRequested')();
    expect(H.calls, 'and export now sends').toEqual([{ name: 'requestDataExport', args: {} }]);
  });
});
