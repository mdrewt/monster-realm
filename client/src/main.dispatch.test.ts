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
 * overlay each change that record. The same table drives the battle case (ctl-6c, CTL6C.3): at a
 * battle base every callback but the battle's own actions is refused with its reason.
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
import type { StoreBattle, StoreBattleMonster, StoreMonsterPub } from './net/store';
// Read ONLY by the battle case's closing anti-vacuity cross-check (that its literal refuse list
// covers every kind the policy refuses); the expected split itself is the test's own transcription.
import { COMMAND_BATTLE_POLICY } from './ui/contextStack';
// Read ONLY by the ctl-7c view-lending case's closing check that every frame id was driven.
import { OVERLAY_IDS } from './ui/overlayRegistry';

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
    /** The screen-adapter table main.ts's host reads: a mutable copy of the real one, re-made by
     *  the module mock below on every fresh import, so a ctl-7c case can swap one frame's adapter. */
    adapters: {} as Record<string, unknown>,
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

// The screen-adapter table: the real module with SCREEN_ADAPTERS replaced by a mutable copy of
// itself (every entry the same legacy adapter, so nothing changes until a case swaps one).
vi.mock('./ui/screens/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/screens/index')>();
  H.adapters = { ...actual.SCREEN_ADAPTERS };
  return { ...actual, SCREEN_ADAPTERS: H.adapters };
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
  // ctl-7a (named intentional change): the shipped <body> is now three children (#game-screen,
  // #build-stamp, #a11y-live), so the old `body children > 5` floor is retired. The vacuity
  // guard counts the id-bearing elements the parse yielded instead (the real shell has ~60).
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'index.html must yield a body to mount').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

const clock = { t: 0 };
let rafCallback: FrameRequestCallback | null = null;
let opts: ConnectionOptions;
/** The i18n resolver instance main.ts runs on (imported AFTER the module reset, so it is shared). */
let i18n: typeof import('./ui/i18n/resolver');

/** Narrow an optional connection-option callback; a missing one fails loudly rather than skipping the call. */
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} was not wired by main.ts`);
  return v;
}

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
  /** The `Command` kind the callback dispatches. */
  readonly kind: string;
  /** What a battle base does with it (CTL6C.3): the battle's own actions are allowed (`safe`),
   *  every other reducer-backed callback is refused. Transcribed per row, never read from the
   *  production policy table. */
  readonly atBattle: 'refuse' | 'safe';
}

/** The dispatch fixture: party 51 in slot 2 and 50 in slot 0, 52 boxed (255), so the free slot is 1
 *  and the party ids in store order are [51, 50]; two heal pads, of which the first one in the
 *  store (7) is the target. */
function seedDispatchFixture(): void {
  opts.store.upsertMonster(monster(51n, 2));
  opts.store.upsertMonster(monster(50n, 0));
  opts.store.upsertMonster(monster(52n, 255));
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
}

/** One invocation per reducer-backed view callback, with distinct non-zero values per field, and the
 *  exact reducer call it records against `seedDispatchFixture`. Shared by the world case and the
 *  battle case, so both drive the same callbacks with the same arguments. */
function dispatchRows(): readonly Row[] {
  const party = [51n, 50n];
  const other = new Identity(OTHER_IDENTITY);
  return [
    {
      label: 'box setNickname',
      view: 'BoxView',
      handler: 'onSetNickname',
      args: [61n, 'Zorp'],
      expected: [{ name: 'setNickname', args: { monsterId: 61n, nickname: 'Zorp' } }],
      kind: 'setNickname',
      atBattle: 'refuse',
    },
    {
      label: 'box setPartySlot explicit (Move)',
      view: 'BoxView',
      handler: 'onSetPartySlot',
      args: [62n, 2],
      expected: [{ name: 'setPartySlot', args: { monsterId: 62n, slot: 2 } }],
      kind: 'setPartySlot',
      atBattle: 'refuse',
    },
    {
      label: 'box setPartySlot -1 takes the free slot (Move)',
      view: 'BoxView',
      handler: 'onSetPartySlot',
      args: [63n, -1],
      expected: [{ name: 'setPartySlot', args: { monsterId: 63n, slot: 1 } }],
      kind: 'setPartySlot',
      atBattle: 'refuse',
    },
    {
      label: 'box healParty targets the first loaded pad',
      view: 'BoxView',
      handler: 'onHealParty',
      args: [],
      expected: [{ name: 'healParty', args: { locationId: 7 } }],
      kind: 'healParty',
      atBattle: 'refuse',
    },
    {
      label: 'battle attack',
      view: 'BattleView',
      handler: 'onAttack',
      args: [901n, 33],
      expected: [{ name: 'submitAttack', args: { battleId: 901n, skillId: 33 } }],
      kind: 'attack',
      atBattle: 'safe',
    },
    {
      label: 'battle flee',
      view: 'BattleView',
      handler: 'onFlee',
      args: [902n],
      expected: [{ name: 'flee', args: { battleId: 902n } }],
      kind: 'flee',
      atBattle: 'safe',
    },
    {
      label: 'battle swap',
      view: 'BattleView',
      handler: 'onSwap',
      args: [903n, 4],
      expected: [{ name: 'swapActive', args: { battleId: 903n, teamIndex: 4 } }],
      kind: 'swap',
      atBattle: 'safe',
    },
    {
      label: 'battle recruit',
      view: 'BattleView',
      handler: 'onRecruit',
      args: [904n, 55],
      expected: [{ name: 'attemptRecruit', args: { battleId: 904n, baitItemId: 55 } }],
      kind: 'recruit',
      atBattle: 'safe',
    },
    {
      label: 'battle useItem',
      view: 'BattleView',
      handler: 'onUseItem',
      args: [905n, 66],
      expected: [{ name: 'useBattleItem', args: { battleId: 905n, itemId: 66 } }],
      kind: 'useItem',
      atBattle: 'safe',
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
      kind: 'pvpAttack',
      atBattle: 'safe',
    },
    {
      label: 'battle pvp swap',
      view: 'BattleView',
      handler: 'onPvpSwap',
      args: [907n, 5],
      expected: [
        { name: 'submitPvpAction', args: { battleId: 907n, action: { tag: 'Swap', value: 5 } } },
      ],
      kind: 'pvpSwap',
      atBattle: 'safe',
    },
    {
      label: 'raising train (Feed)',
      view: 'RaisingView',
      handler: 'onTrain',
      args: [71n, 44],
      expected: [{ name: 'train', args: { monsterId: 71n, foodItemId: 44 } }],
      kind: 'train',
      atBattle: 'refuse',
    },
    {
      label: 'raising care (Care)',
      view: 'RaisingView',
      handler: 'onCare',
      args: [72n],
      expected: [{ name: 'care', args: { monsterId: 72n } }],
      kind: 'care',
      atBattle: 'refuse',
    },
    {
      label: 'evolution evolve (Evolve)',
      view: 'EvolutionView',
      handler: 'onEvolve',
      args: [73n, 88],
      expected: [{ name: 'evolve', args: { monsterId: 73n, toSpecies: 88 } }],
      kind: 'evolve',
      atBattle: 'refuse',
    },
    {
      label: 'shop buy',
      view: 'ShopView',
      handler: 'onBuy',
      args: [11, 22],
      expected: [{ name: 'buy', args: { shopId: 11, itemId: 22, qty: 1 } }],
      kind: 'buy',
      atBattle: 'refuse',
    },
    {
      label: 'shop sell',
      view: 'ShopView',
      handler: 'onSell',
      args: [23],
      expected: [{ name: 'sell', args: { itemId: 23, qty: 1 } }],
      kind: 'sell',
      atBattle: 'refuse',
    },
    {
      label: 'trade accept',
      view: 'TradeView',
      handler: 'onAccept',
      args: [81n],
      expected: [{ name: 'respondTrade', args: { tradeId: 81n, accepted: true } }],
      kind: 'respondTrade',
      atBattle: 'refuse',
    },
    {
      label: 'trade reject',
      view: 'TradeView',
      handler: 'onReject',
      args: [82n],
      expected: [{ name: 'respondTrade', args: { tradeId: 82n, accepted: false } }],
      kind: 'respondTrade',
      atBattle: 'refuse',
    },
    {
      label: 'trade confirm',
      view: 'TradeView',
      handler: 'onConfirm',
      args: [83n],
      expected: [{ name: 'confirmTrade', args: { tradeId: 83n } }],
      kind: 'confirmTrade',
      atBattle: 'refuse',
    },
    {
      label: 'trade cancel',
      view: 'TradeView',
      handler: 'onCancel',
      args: [84n],
      expected: [{ name: 'cancelTrade', args: { tradeId: 84n } }],
      kind: 'cancelTrade',
      atBattle: 'refuse',
    },
    {
      label: 'pvp challenge',
      view: 'PvpView',
      handler: 'onChallenge',
      args: [OTHER_IDENTITY],
      expected: [{ name: 'challengePvp', args: { target: other, partyIds: party } }],
      kind: 'challenge',
      atBattle: 'refuse',
    },
    {
      label: 'pvp accept (challenge Accept)',
      view: 'PvpView',
      handler: 'onAccept',
      args: [91n],
      expected: [{ name: 'acceptChallenge', args: { challengeId: 91n, partyIds: party } }],
      kind: 'acceptChallenge',
      atBattle: 'refuse',
    },
    {
      label: 'pvp decline',
      view: 'PvpView',
      handler: 'onDecline',
      args: [92n],
      expected: [{ name: 'declineChallenge', args: { challengeId: 92n } }],
      kind: 'declineChallenge',
      atBattle: 'refuse',
    },
    {
      label: 'pvp cancel',
      view: 'PvpView',
      handler: 'onCancel',
      args: [93n],
      expected: [{ name: 'cancelChallenge', args: { challengeId: 93n } }],
      kind: 'cancelChallenge',
      atBattle: 'refuse',
    },
    {
      label: 'rename submit',
      view: 'RenameView',
      handler: 'onSubmit',
      args: ['Zed'],
      expected: [{ name: 'setProfileName', args: { name: 'Zed' } }],
      kind: 'setProfileName',
      atBattle: 'refuse',
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
      kind: 'proposeTrade',
      atBattle: 'refuse',
    },
  ];
}

const WILD_IDENTITY = '0'.repeat(64);
const BATTLE_ID = 101n;

const BATTLE_MONSTER: StoreBattleMonster = {
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

/** A wild battle row for the booted player (main.controls.test.ts's fixture). */
function battleRow(battleId: bigint, outcome: string): StoreBattle {
  return {
    battleId,
    playerIdentity: H.identity,
    opponentIdentity: WILD_IDENTITY,
    outcome,
    turnNumber: 1,
    sideA: { active: 0, team: [BATTLE_MONSTER] },
    sideB: { active: 0, team: [BATTLE_MONSTER] },
    partyMonsterIds: [1n],
    opponentMonsterIds: [],
    createdAtMs: 0n,
    weather: null,
  };
}

/** An Ongoing battle row arrives in one batch at clock `t`, which mirrors the battle base. */
function putBattle(battleId: bigint, t: number): void {
  opts.store.upsertBattle(battleRow(battleId, 'Ongoing'));
  server(t);
}

/** The battle row vanishes in one batch at clock `t`: the base returns to the world. */
function dropBattle(battleId: bigint, t: number): void {
  opts.store.removeBattle(battleId);
  server(t);
}

/** The base frame of the context stack, through the read-only `__game()` DEV hook. */
const stackBase = (): unknown =>
  (window as unknown as { __game: () => { stack: unknown[] } }).__game().stack[0];

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
    seedDispatchFixture();

    for (const row of dispatchRows()) {
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
    must(opts.onClaimResult, 'onClaimResult')({ ok: true } as never);
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
    must(opts.onClaimPending, 'onClaimPending')('CODE-1');
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
    must(opts.onClaimResult, 'onClaimResult')({ ok: true } as never);
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

    must(opts.onClaimPending, 'onClaimPending')('CODE-2');
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

  /** Seed the own account row at `status`, deliver it at clock `at` and run one frame 50 ms later so
   *  the privacy model sees it. */
  function seedAccount(status: 'Active' | 'PendingDeletion', at = 1050): void {
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
    server(at);
    frame(at + 50);
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

  it('at a battle base every view callback of a command the battle refuses reaches no reducer and shows the reason (Care, Feed, Move, Evolve, challenge Accept, buy and sell among them), the battle actions still reach their reducers, and back at the world each refused callback sends again', async () => {
    // WRONG IMPL KILLED (red-team F2, measured): a refusal that exempts one command (the spec's
    // acceptChallenge, or buy, sell, setPartySlot, healParty, deleteAccount ...: that row reaches
    // its reducer at the battle base); a refusal narrowed to the two kinds the booted suite drives
    // (advanceDialogue and care: every other refused row sends); a refusal that sends and then
    // reports, or reports nothing (the status line); one that refuses everything at a battle base
    // (attack, flee, swap, recruit, use item and both PvP actions must still reach their reducers
    // there); one that also refuses at the world, or spends what the player armed (the world
    // phase re-runs every refused callback in the same boot and each one sends); and a claim or
    // privacy arm that bypasses the policy (each is armed first, so an unrefused call would act).
    await bootReady();
    server(1000);
    seedDispatchFixture();
    const rows = dispatchRows();
    const reason = i18n.t('menu.disabled.inBattle');
    expect(reason, 'fixture: the catalogued reason is real text').not.toBe('');
    const status = document.getElementById('status');
    if (status === null) throw new Error('#status must exist once booted');
    // The literal split (CTL6C.3): of the reducer-backed view callbacks, only the battle's own
    // actions still run at a battle base.
    expect(
      rows.filter((r) => r.atBattle === 'safe').map((r) => r.kind),
      'fixture: the allowed rows are exactly the battle actions',
    ).toEqual(['attack', 'flee', 'swap', 'recruit', 'useItem', 'pvpAttack', 'pvpSwap']);
    for (const row of rows) {
      expect(row.expected.length, `fixture: ${row.label} records a reducer call`).toBe(1);
    }
    const claimVm = (): { actions: { join: boolean; declineConfirm: boolean } } =>
      H.views.ClaimView?.renders.at(-1) as never;
    /** Run one argument-less claim / privacy callback on a fresh status line and call record. */
    const act = async (view: string, handler: string): Promise<void> => {
      H.calls = [];
      status.textContent = '';
      handlerOf(view, handler)();
      await flush();
    };
    /** Each refused kind this test drove through a view callback, pushed after its assertions. */
    const refused: string[] = [];

    // Armed at the world, so each claim / privacy arm below would act if it were not refused.
    seedAccount('Active', 1050);
    handlerOf('PrivacyView', 'onDeleteRequested')();
    must(opts.onClaimResult, 'onClaimResult')({ ok: true } as never);

    // --- battle 101: the table ------------------------------------------------------------
    putBattle(BATTLE_ID, 1200);
    expect(stackBase(), 'precondition: the base is the battle').toEqual({
      kind: 'battle',
      battleId: '101',
    });
    for (const row of rows) {
      H.calls = [];
      status.textContent = '';
      const returned = handlerOf(row.view, row.handler)(...row.args);
      await flush();
      if (row.atBattle === 'refuse') {
        expect(H.calls, `${row.label}: at a battle base it reaches no reducer`).toEqual([]);
        expect(statusText(), `${row.label}: and the status line shows the reason`).toBe(reason);
        refused.push(row.kind);
      } else {
        expect(H.calls, `${row.label}: a battle action still reaches its reducer`).toEqual(
          row.expected,
        );
        expect(statusText(), `${row.label}: and is not reported as refused`).toBe('');
      }
      expect(isThenable(returned), `${row.label}: the view still gets a promise`).toBe(true);
    }
    for (const [name, kind] of [
      ['Care', 'care'],
      ['Feed', 'train'],
      ['Move', 'setPartySlot'],
      ['Evolve', 'evolve'],
      ['challenge Accept', 'acceptChallenge'],
      ['buy', 'buy'],
      ['sell', 'sell'],
    ] as const) {
      expect(refused.includes(kind), `the spec row ${name} (${kind}) was refused`).toBe(true);
    }

    // --- battle 101: the claim and privacy arms (claim-succeeded, delete armed) --------------
    await act('ClaimView', 'onSignIn');
    expect(H.signIns, 'claim sign-in: no sign-in starts at a battle base').toBe(0);
    expect(statusText(), 'claim sign-in: the reason').toBe(reason);
    refused.push('claimSignIn');
    await act('ClaimView', 'onJoin');
    expect(H.calls, 'claim join: no joinGame at a battle base').toEqual([]);
    expect(statusText(), 'claim join: the reason').toBe(reason);
    refused.push('claimJoin');
    await act('PrivacyView', 'onDeleteConfirmed');
    expect(H.calls, 'privacy delete: no deleteAccount at a battle base').toEqual([]);
    expect(statusText(), 'privacy delete: the reason').toBe(reason);
    refused.push('deleteAccount');
    await act('PrivacyView', 'onExportRequested');
    expect(H.calls, 'privacy export: no requestDataExport at a battle base').toEqual([]);
    expect(statusText(), 'privacy export: the reason').toBe(reason);
    refused.push('requestDataExport');

    // --- the world: every refused callback sends again in this boot --------------------------
    dropBattle(BATTLE_ID, 1300);
    expect(stackBase(), 'precondition: the base is the world again').toEqual({ kind: 'world' });
    for (const row of rows) {
      H.calls = [];
      handlerOf(row.view, row.handler)(...row.args);
      await flush();
      expect(H.calls, `${row.label}: at the world it reaches its reducer`).toEqual(row.expected);
    }
    await act('ClaimView', 'onSignIn');
    expect(H.signIns, 'control: at the world sign-in starts once').toBe(1);
    await act('ClaimView', 'onJoin');
    expect(H.calls, 'control: at the world the join is sent').toEqual([
      { name: 'joinGame', args: { name: 'Player' } },
    ]);
    await act('PrivacyView', 'onDeleteConfirmed');
    expect(H.calls, 'control: the delete armed before the battle is still armed').toEqual([
      { name: 'deleteAccount', args: {} },
    ]);
    await act('PrivacyView', 'onExportRequested');
    expect(H.calls, 'control: at the world export is sent').toEqual([
      { name: 'requestDataExport', args: {} },
    ]);

    // --- battle 102: the arms that need another state (a pending deletion, an armed decline) ----
    seedAccount('PendingDeletion', 1400);
    must(opts.onClaimPending, 'onClaimPending')('CODE-1');
    handlerOf('ClaimView', 'onDeclineRequested')();
    expect(claimVm().actions.declineConfirm, 'precondition: the decline is armed').toBe(true);
    expect(claimVm().actions.join, 'precondition: join is not offered while armed').toBe(false);
    putBattle(102n, 1500);
    expect(stackBase(), 'precondition: the base is the second battle').toEqual({
      kind: 'battle',
      battleId: '102',
    });
    await act('ClaimView', 'onDeclineConfirmed');
    const refusedDecline = claimVm();
    expect(refusedDecline.actions.declineConfirm, 'claim decline: still armed').toBe(true);
    expect(refusedDecline.actions.join, 'claim decline: join is still not offered').toBe(false);
    expect(statusText(), 'claim decline: the reason').toBe(reason);
    refused.push('claimDecline');
    await act('PrivacyView', 'onCancelDeletion');
    expect(H.calls, 'privacy cancel: no cancelAccountDeletion at a battle base').toEqual([]);
    expect(statusText(), 'privacy cancel: the reason').toBe(reason);
    refused.push('cancelAccountDeletion');

    dropBattle(102n, 1600);
    expect(stackBase(), 'precondition: the base is the world again').toEqual({ kind: 'world' });
    await act('ClaimView', 'onDeclineConfirmed');
    expect(claimVm().actions.join, 'control: at the world the decline lifts the veto').toBe(true);
    expect(claimVm().actions.declineConfirm, 'control: and spends the confirmation').toBe(false);
    await act('PrivacyView', 'onCancelDeletion');
    expect(H.calls, 'control: at the world the cancel is sent').toEqual([
      { name: 'cancelAccountDeletion', args: {} },
    ]);

    // Anti-vacuity cross-check against the production policy: every kind it refuses was refused
    // above through a captured view callback, or is named here with the reason it has none.
    const noViewCallback: Readonly<Record<string, string>> = {
      advanceDialogue:
        'no view constructor callback: the document-level [data-choice-idx] click delegation ' +
        'dispatches it, and main.controls.test.ts refuses that click at a battle base',
    };
    const policyRefused = Object.entries(COMMAND_BATTLE_POLICY)
      .filter(([, verdict]) => verdict === 'refuse')
      .map(([kind]) => kind)
      .sort();
    expect(
      [...new Set([...refused, ...Object.keys(noViewCallback)])].sort(),
      'every refused kind is driven here or named as having no view callback',
    ).toEqual(policyRefused);
  });
});

// ==========================================================================================
// ctl-7c: a screen adapter's heal command (CTL7C.3) and the views the shell lends (CTL7C.2)
// ==========================================================================================
//
// Same harness, one fresh main.ts per case. The adapter table main.ts hands its screen host is the
// module mock's mutable copy (`H.adapters`), so a case swaps a frame's adapter for a stand-in. The
// command cases drive a REAL key (PageUp, which the router hands the top frame as LB) through the
// router into a stand-in on the main menu and read the reducer call its command reached: the main
// menu is the one frame the player can open at the world AND over an Ongoing battle. The view
// case reads which view instance each frame's paint was lent.

/** Swap one frame's adapter for this boot; afterEach (the `restorers` drain) puts it back. */
function swapAdapter(id: string, adapter: unknown): void {
  const previous = H.adapters[id];
  H.adapters[id] = adapter;
  restorers.push(() => {
    H.adapters[id] = previous;
  });
}

/** A keydown at `t` at the window and its keyup 5 ms later; returns the keydown. */
function press(code: string, t: number): KeyboardEvent {
  clock.t = t;
  const down = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
  window.dispatchEvent(down);
  clock.t = t + 5;
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
  return down;
}

/** The whole context stack, base first, through the read-only `__game()` DEV hook. */
const stackNow = (): unknown[] =>
  (window as unknown as { __game: () => { stack: unknown[] } }).__game().stack;

interface Pressed {
  readonly button: string;
  readonly repeat: boolean;
}

/** A stand-in adapter that answers LB (PageUp) with whatever `issue.command` holds now, and B /
 *  Start as the legacy adapter does (so its frame still closes). */
function commandAdapter(issue: { command: unknown }): unknown {
  return {
    viewModel: () => undefined,
    init: () => undefined,
    onButton: (_vm: unknown, state: unknown, btn: Pressed) => {
      if (btn.repeat) return { state, result: 'consumed' };
      if (btn.button === 'LB') return { state, result: issue.command };
      if (btn.button === 'B') return { state, result: { kind: 'pop' } };
      if (btn.button === 'Start') return { state, result: { kind: 'popToBase' } };
      return { state, result: 'unhandled' };
    },
  };
}

/** Open the main menu over the world with M and assert it is the one frame. */
function openMenuAtWorld(t: number): void {
  press('KeyM', t);
  expect(stackNow(), 'precondition: the menu is the one frame over the world').toEqual([
    { kind: 'world' },
    { kind: 'screen', id: 'menuView' },
  ]);
}

/** Send the menu's stand-in one PageUp and let the reducer promise settle; returns the keydown. */
async function pageUp(t: number): Promise<KeyboardEvent> {
  const down = press('PageUp', t);
  await flush();
  return down;
}

/** The recording stand-in view classes main.ts constructs, by the frame id each one backs. */
const STAND_IN_CLASS: Readonly<Record<string, string>> = {
  boxView: 'BoxView',
  battleView: 'BattleView',
  raisingView: 'RaisingView',
  evolutionView: 'EvolutionView',
  shopView: 'ShopView',
  tradeView: 'TradeView',
  pvpView: 'PvpView',
  claimView: 'ClaimView',
  privacyView: 'PrivacyView',
  renameView: 'RenameView',
  tradeProposeView: 'TradeProposeView',
};

/** A stand-in adapter for `id` that records the view each paint is lent, consumes every button
 *  but Start, and answers Start with popToBase (so its frame closes). */
function paintingAdapter(id: string, paints: Array<{ id: string; view: unknown }>): unknown {
  return {
    viewModel: () => undefined,
    init: () => undefined,
    onButton: (_vm: unknown, state: unknown, btn: Pressed) => ({
      state,
      result: btn.button === 'Start' && !btn.repeat ? { kind: 'popToBase' } : 'consumed',
    }),
    paint: (view: unknown) => {
      paints.push({ id, view });
    },
  };
}

const GUIDE_ENTITY = 11n;
const HEALER_ENTITY = 12n;

/** A dialogue NPC one tile east of the player and a healer on the player's own tile (the healer
 *  is nearer, so T interacts with it), in one batch at clock `t`. */
function seedNpcs(t: number): void {
  for (const [entityId, npcId, tileX, interaction] of [
    [GUIDE_ENTITY, 'guide', 3, { kind: 'dialogue' }],
    [HEALER_ENTITY, 'healer', 2, { kind: 'heal', locationId: 1 }],
  ] as const) {
    opts.store.upsertNpc({
      entityId,
      npcId,
      zoneId: 0,
      homeX: tileX,
      homeY: 6,
      wanderRadius: 0,
      dialogueTreeId: 'no-such-tree',
      interaction,
    } as never);
    opts.store.upsertCharacter(
      {
        entityId,
        zoneId: 0,
        tileX,
        tileY: 6,
        facing: 'South',
        action: 'Idle',
        moveStartedAtMs: 0n,
        moveQueue: [] as WasmMoveInput[],
      },
      t,
    );
  }
  server(t);
}

describe('main.ts screen-host commands and views (runtime, ctl-7c)', { sequential: true }, () => {
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

  it('CTL7C-3-PRESENT: a screen command healParty with a locationId sends exactly that id: 9 while the store`s first pad is 7, 0 as 0, and 9 with no pad loaded at all (with no "unavailable" report); at a battle base it is refused like the absent arm', async () => {
    // WRONG IMPL KILLED: a healParty arm that ignores a present locationId and sends the store's
    // first pad (B13: a heal screen bound to one location would heal at another), a `||` fallback
    // (0 is a present id: it would be replaced by the first pad, or skipped when none is loaded),
    // a present arm still gated on a loaded pad (nothing sent and "heal unavailable" reported for a
    // location the screen knows), a present arm that rewrites the argument shape, and one that
    // skips the battle policy (a heal sent at a battle base).
    await bootReady();
    server(1000);
    const status = document.getElementById('status');
    if (status === null) throw new Error('#status must exist once booted');
    const issue: { command: unknown } = { command: { kind: 'healParty' } };
    swapAdapter('menuView', commandAdapter(issue));
    openMenuAtWorld(1010);

    // Control: with no pad loaded the ABSENT arm sends nothing and says why, so none is loaded.
    H.calls = [];
    status.textContent = '';
    await pageUp(1100);
    expect(H.calls, 'control: no pad is loaded, the absent arm sends nothing').toEqual([]);
    expect(statusText(), 'control: and says why').toBe(i18n.t('chrome.status.healUnavailable'));

    // A present id with no pad loaded is still sent, and nothing is reported.
    issue.command = { kind: 'healParty', locationId: 9 };
    H.calls = [];
    status.textContent = '';
    const sent = await pageUp(1200);
    expect(sent.defaultPrevented, 'the routed press is consumed').toBe(true);
    expect(H.calls, 'the present id is sent with no pad loaded').toEqual([
      { name: 'healParty', args: { locationId: 9 } },
    ]);
    expect(statusText(), 'and nothing is reported').toBe('');

    // Pads 7 and 9 loaded, 7 first: the present id wins over the store's first pad.
    seedDispatchFixture();
    server(1300);
    expect(stackNow(), 'precondition: the menu survived the batch').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'menuView' },
    ]);
    H.calls = [];
    await pageUp(1400);
    expect(H.calls, 'the present id, not the first pad').toEqual([
      { name: 'healParty', args: { locationId: 9 } },
    ]);

    // 0 is a present id.
    issue.command = { kind: 'healParty', locationId: 0 };
    H.calls = [];
    await pageUp(1500);
    expect(H.calls, 'locationId 0 is sent as 0').toEqual([
      { name: 'healParty', args: { locationId: 0 } },
    ]);

    // Control: in the same state the absent arm resolves the store's first pad.
    issue.command = { kind: 'healParty' };
    H.calls = [];
    await pageUp(1600);
    expect(H.calls, 'control: the absent arm sends the first pad').toEqual([
      { name: 'healParty', args: { locationId: 7 } },
    ]);

    // At a battle base the present arm is refused exactly like the absent one.
    press('Escape', 1700);
    expect(stackNow(), 'precondition: Start closed the menu').toEqual([{ kind: 'world' }]);
    putBattle(BATTLE_ID, 1800);
    expect(stackBase(), 'precondition: the base is the battle').toEqual({
      kind: 'battle',
      battleId: '101',
    });
    press('Escape', 1900);
    expect(stackNow(), 'precondition: Start opened the menu over the battle').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
    ]);
    const reason = i18n.t('menu.disabled.inBattle');
    let t = 2000;
    for (const command of [
      { kind: 'healParty', locationId: 9 },
      { kind: 'healParty', locationId: 0 },
      { kind: 'healParty' },
    ]) {
      const label = JSON.stringify(command);
      issue.command = command;
      H.calls = [];
      status.textContent = '';
      await pageUp(t);
      t += 100;
      expect(H.calls, `${label}: at a battle base it reaches no reducer`).toEqual([]);
      expect(statusText(), `${label}: and shows the battle's reason`).toBe(reason);
    }
  });

  it('CTL7C-3-ABSENT: a screen command healParty with no locationId keeps the Box behaviour: with no pad loaded nothing is sent and the player is told, and once pads arrive the store`s first one (7) is sent', async () => {
    // WRONG IMPL KILLED: an absent arm that sends `undefined` or 0 when no pad is loaded (a
    // guaranteed invisible server Err), one that loses the report, one that sends the last or a
    // fixed pad instead of the store's first, and a screen command path that never reaches
    // `dispatch` at all.
    await bootReady();
    server(1000);
    const status = document.getElementById('status');
    if (status === null) throw new Error('#status must exist once booted');
    swapAdapter('menuView', commandAdapter({ command: { kind: 'healParty' } }));
    openMenuAtWorld(1010);

    H.calls = [];
    status.textContent = '';
    const unloaded = await pageUp(1100);
    expect(unloaded.defaultPrevented, 'the routed press is consumed').toBe(true);
    expect(H.calls, 'no pad loaded: nothing is sent').toEqual([]);
    expect(statusText(), 'and the player is told').toBe(i18n.t('chrome.status.healUnavailable'));

    seedDispatchFixture();
    server(1200);
    H.calls = [];
    await pageUp(1300);
    expect(H.calls, 'with pads loaded the first one is sent').toEqual([
      { name: 'healParty', args: { locationId: 7 } },
    ]);
  });

  it('CTL7C-2-BOOT-VIEWS: every frame id lends ITS OWN view instance to its adapter`s paint: each of the eleven recorded stand-in views, and the real dialogue, quest log, heal, leaderboard, help and menu views, each shown alone and sent one routed button', async () => {
    // WRONG IMPL KILLED: a view-lending table with a copy-pasted sibling thunk (`raisingView:
    // () => boxView` type-checks, and the raising screen's state would be painted into the box),
    // one that lends every frame the same view, one that lends a view the shell did not build
    // (a fresh instance, never shown), and one that lends nothing (no paint at all).
    await bootReady();
    server(1000);
    seedNpcs(1010);
    // Imported AFTER the boot: the very classes main.ts constructed its views from.
    const real: Readonly<Record<string, unknown>> = {
      dialogueView: (await import('./ui/dialogueView')).DialogueView,
      questLogView: (await import('./ui/questLogView')).QuestLogView,
      healView: (await import('./ui/healView')).HealView,
      leaderboardView: (await import('./ui/leaderboardView')).LeaderboardView,
      helpView: (await import('./ui/helpView')).HelpView,
      menuView: (await import('./ui/menuView')).MenuView,
    };
    const paints: Array<{ id: string; view: unknown }> = [];
    for (const id of OVERLAY_IDS) swapAdapter(id, paintingAdapter(id, paints));
    /** The paints one routed button (PageUp = LB) to the top frame produced. */
    const paintsOfOnePress = (t: number): Array<{ id: string; view: unknown }> => {
      paints.length = 0;
      press('PageUp', t);
      return [...paints];
    };
    const covered: string[] = [];
    let t = 1100;

    // The eleven stand-ins: each shown alone through its own flag, closed by its adapter's Start.
    for (const [id, cls] of Object.entries(STAND_IN_CLASS)) {
      const view = H.views[cls];
      if (view === undefined) throw new Error(`${cls} was never constructed by main.ts`);
      expect(stackNow(), `${id}: precondition: the bare world`).toEqual([{ kind: 'world' }]);
      view.visible = true;
      const painted = paintsOfOnePress(t);
      expect(stackNow(), `${id}: precondition: the one frame over the world`).toEqual([
        { kind: 'world' },
        { kind: 'screen', id },
      ]);
      expect(
        painted.map((p) => p.id),
        `${id}: one paint, by ${id}'s own adapter`,
      ).toEqual([id]);
      expect(painted[0]?.view, `${id}: into ${cls}, the view main.ts built for ${id}`).toBe(view);
      press('Escape', t + 50);
      expect(view.visible, `${id}: Start closed it`).toBe(false);
      expect(stackNow(), `${id}: the bare world again`).toEqual([{ kind: 'world' }]);
      covered.push(id);
      t += 100;
    }

    // The six real views, each opened by its own real path and closed again.
    const openers: ReadonlyArray<{
      readonly id: string;
      readonly open: (at: number) => void;
      readonly close: (at: number) => void;
    }> = [
      {
        id: 'questLogView',
        open: (at) => void press('KeyQ', at),
        close: (at) => void press('Escape', at),
      },
      {
        id: 'leaderboardView',
        open: (at) => void press('KeyL', at),
        close: (at) => void press('Escape', at),
      },
      {
        id: 'helpView',
        open: (at) => void press('KeyR', at),
        close: (at) => void press('Escape', at),
      },
      {
        id: 'menuView',
        open: (at) => void press('KeyM', at),
        close: (at) => void press('Escape', at),
      },
      {
        id: 'healView',
        open: (at) => void press('KeyT', at),
        close: (at) => void press('Escape', at),
      },
      {
        id: 'dialogueView',
        open: (at) => {
          opts.store.upsertConversation({
            ownerIdentity: H.identity,
            npcEntityId: GUIDE_ENTITY,
            currentNodeId: 'start',
          });
          server(at);
        },
        close: (at) => {
          opts.store.removeConversation(H.identity);
          server(at);
        },
      },
    ];
    for (const o of openers) {
      expect(stackNow(), `${o.id}: precondition: the bare world`).toEqual([{ kind: 'world' }]);
      o.open(t);
      expect(stackNow(), `${o.id}: precondition: opened alone over the world`).toEqual([
        { kind: 'world' },
        { kind: 'screen', id: o.id },
      ]);
      const painted = paintsOfOnePress(t + 10);
      expect(
        painted.map((p) => p.id),
        `${o.id}: one paint, by ${o.id}'s own adapter`,
      ).toEqual([o.id]);
      const view = painted[0]?.view;
      expect(view, `${o.id}: into the real view of its own class`).toBeInstanceOf(
        real[o.id] as never,
      );
      expect((view as { visible?: unknown }).visible, `${o.id}: the instance on screen`).toBe(true);
      o.close(t + 50);
      expect(stackNow(), `${o.id}: closed again`).toEqual([{ kind: 'world' }]);
      covered.push(o.id);
      t += 100;
    }

    expect([...covered].sort(), 'ANTI-VACUITY: every frame id lent its view').toEqual(
      [...OVERLAY_IDS].sort(),
    );
  });
});
