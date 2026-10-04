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
 * ctl-7c and ctl-7d add cases that swap ONE frame's screen adapter for a stand-in and drive it
 * through the real router, stack and dispatch. ctl-7d (the screen-context seam) covers what such
 * an adapter can now read and send: the bound shop and heal-location ids and the reduced-motion
 * preference on `ScreenContext` (CTL7D.1, CTL7D.2); a `buy` / `sell` quantity that reaches its
 * reducer verbatim, or is refused before any send (CTL7D.3); the success line naming the
 * quantity, the item and the gold, read from the store when the command is sent (CTL7D.4); the
 * `pickShop` command, which the greet-then-shop click now shares and a battle base refuses
 * (CTL7D.5); and a store batch reaching an open frame's `observe` (CTL7D.6). Two older cases
 * changed with it (named intentional changes): the shop's success line is now the parameterized
 * count line for what that fixture sends, and the battle case's refuse list names `pickShop`.
 *
 * ctl-8s (the Social seam, CTL8S.1-3) adds the last describe block: a stand-in that opts in to
 * cross-open memory, the requested Social tab on `ScreenContext`, the ONE Social frame that U, P, L,
 * the three menu leaves and the challenge auto-show open over the trade, pvp and leaderboard roots,
 * the composite view its adapter is lent, and a pvp panel that a batch no longer hides under the
 * menu. Named intentional changes: CTL7C-2-BOOT-VIEWS (trade, pvp and leaderboard are no longer
 * frames of their own: the `social` frame lends the composite), and the stub view class (its
 * `refresh` now shows and hides the PvP stand-in by `forceVisible`, as the real PvpView does, and
 * every stub records `hostChrome`). Round 2 adds the legacy U / P / L keys after the adapter switched
 * the shown panel (CTL8S-3-BOOT-HOTKEY-AFTER-SWITCH) and an outgoing-only challenge to the
 * auto-show case.
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
import type {
  StoreBattle,
  StoreBattleChallenge,
  StoreBattleMonster,
  StoreItemRow,
  StoreMonsterPub,
  StoreNpcRow,
} from './net/store';
// Read ONLY by the battle case's closing anti-vacuity cross-check (that its literal refuse list
// covers every kind the policy refuses); the expected split itself is the test's own transcription.
import { COMMAND_BATTLE_POLICY } from './ui/contextStack';
// Read ONLY by the ctl-7c view-lending case's closing check that every frame id was driven.
import { OVERLAY_IDS } from './ui/overlayRegistry';
import type { SocialFrameView, SocialPanelId } from './ui/screens/types';

const H = vi.hoisted(() => {
  interface StubView {
    visible: boolean;
    feedback: string[];
    renders: unknown[];
    /** ctl-8s: the `forceVisible` of every `refresh(vm, forceVisible)` (the PvP stand-in's). */
    forced: unknown[];
    /** ctl-8s: every element `hostChrome(el)` was handed. */
    hosted: unknown[];
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
    /** ctl-10a: what the stubbed wasm `interact_candidates_coded` answers (indices into the
     *  marshalled entity list). Reset to "no candidate" by every boot; a case that opens the heal
     *  frame through A installs a rule naming its healer. */
    interact: ((..._args: unknown[]) => []) as (...args: unknown[]) => unknown,
    /** A recording stand-in for a view class: it keeps its constructor's LAST argument (the handler
     *  object; the box, battle, raising and evolution views take a mount first) and exposes every
     *  method main.ts calls on a view. */
    makeStub: (name: string) =>
      class {
        visible = false;
        feedback: string[] = [];
        renders: unknown[] = [];
        forced: unknown[] = [];
        hosted: unknown[] = [];
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
        refresh(vm: unknown, forceVisible?: unknown): void {
          this.renders.push(vm);
          // ctl-8s (named intentional change): the PvP stand-in shows and hides on refresh as the
          // real PvpView does (its caller's `forceVisible` decides), so a pvp panel main.ts opens
          // or keeps is visible here, and one a batch would hide is hidden. The other views'
          // refresh carries no such flag (the box passes two view models), so it stays a record.
          if (name === 'PvpView') {
            this.forced.push(forceVisible);
            this.visible = forceVisible === true;
          }
        }
        /** ctl-8s: the Social frame moves its one chrome element into the shown panel. */
        hostChrome(el: unknown): void {
          this.hosted.push(el);
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
    // ctl-10a: named fixture change — the new interact export
    interact_candidates_coded: (...args: unknown[]) => H.interact(...args),
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

/** Boot a fresh main.ts. `beforeImport` runs right before the import, for a global main.ts reads
 *  at module scope (the ctl-7d reduced-motion case installs its `matchMedia` stub there). */
async function boot(beforeImport?: () => void): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.handlers = {};
  H.views = {};
  H.frozen = false;
  H.signIns = 0;
  H.gate = null;
  H.interact = () => [];
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
  beforeImport?.();
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

async function bootReady(beforeImport?: () => void): Promise<void> {
  await boot(beforeImport);
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

/** ctl-10a: install a stubbed wasm interact rule that names exactly the NPCs with these entity ids
 *  (the marshalled list carries `{ kind: 'npc', id: <decimal string> }` for an NPC), wherever they
 *  stand. Installed right after boot, before any batch, so every candidate list main.ts memoises
 *  in this case comes from it. */
function useNpcRule(...entityIds: bigint[]): void {
  const ids = entityIds.map((id) => id.toString());
  H.interact = (...args: unknown[]) => {
    const entities = args[4];
    if (!Array.isArray(entities)) return [];
    return ids.flatMap((id) => {
      const at = entities.findIndex(
        (e: { kind?: unknown; id?: unknown }) => e.kind === 'npc' && e.id === id,
      );
      return at === -1 ? [] : [at];
    });
  };
}

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
 *  and the party ids in store order are [51, 50]; two heal pads, 7 loaded first (ctl-10a: no
 *  command falls back to the first pad any more; the pads prove a location-less heal is refused
 *  even when a pad is loaded). */
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
    // ctl-10a (named intentional change, CTL10A.4): the 'box healParty targets the first loaded
    // pad' row is removed with the Box Heal Party control and its `onHealParty` callback. Healing
    // happens only at a bound healer: the heal frame's screen adapter issues `healParty {
    // locationId }` (CTL7C-3-PRESENT), the absent arm reports healUnavailable (CTL7C-3-ABSENT,
    // CTL10A-4-NO-BOX-HEAL-HANDLER), and the battle case below names healParty among the kinds
    // with no view callback.
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
    // ctl-10b (named intentional change, CTL10B.2): the 'pvp challenge' row is removed with the
    // PvpView `onChallenge` callback and its per-player Challenge buttons. A challenge is started
    // only face to face: the world action sheet's Yes dispatches the `challenge` Command (proved,
    // with its exact reducer arguments, by main.input.test.ts CTL10B-1-BOOT-CHALLENGE-YES), and
    // CTL10B-2-BOOT-PVP-NO-CALLBACK below proves PvpView is handed no such callback.
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

// The shop success lines (ctl-7d, CTL7D.4), as LITERAL bytes built here from code points: never
// read off the catalog under test. U+2713 is the success mark, U+2212 the minus sign (never the
// ASCII hyphen) and U+00D7 the multiplication sign. `gold` is the TOTAL moved, a plain decimal.
const CHECK = String.fromCharCode(0x2713);
const MINUS = String.fromCharCode(0x2212);
const TIMES = String.fromCharCode(0xd7);
const E_ACUTE = String.fromCharCode(0xe9);
const enBought = (qty: number, name: string, gold: bigint): string =>
  `${CHECK} Bought ${qty} ${name} (${MINUS}${gold}g)`;
const enSold = (qty: number, name: string, gold: bigint): string =>
  `${CHECK} Sold ${qty} ${name} (+${gold}g)`;
const enBoughtCount = (qty: number): string => `${CHECK} Bought ${TIMES}${qty}`;
const enSoldCount = (qty: number): string => `${CHECK} Sold ${TIMES}${qty}`;
const frBought = (qty: number, name: string, gold: bigint): string =>
  `${CHECK} Achet${E_ACUTE} ${qty} ${name} (${MINUS}${gold} or)`;
const frSold = (qty: number, name: string, gold: bigint): string =>
  `${CHECK} Vendu ${qty} ${name} (+${gold} or)`;
const frBoughtCount = (qty: number): string => `${CHECK} Achet${E_ACUTE} ${TIMES}${qty}`;
const frSoldCount = (qty: number): string => `${CHECK} Vendu ${TIMES}${qty}`;

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

  it('CTL10B-2-BOOT-PVP-NO-CALLBACK: the PvpView constructor is handed no onChallenge callback (a challenge starts only face to face), while its respond callbacks (Accept, Decline, Cancel) are all still wired', async () => {
    // WRONG IMPL KILLED: a main.ts that keeps wiring `onChallenge` into the PvpView handler object
    // (the retired per-player Challenge buttons, or any future caller, could start a challenge from
    // the PvP overlay), and a "removal" that also drops the respond callbacks (the control reads all
    // three, so the overlay would be unable to answer a challenge).
    await bootReady();
    server(1000);
    const handlers = H.handlers.PvpView;
    if (handlers === undefined) throw new Error('PvpView was never constructed by main.ts');
    expect(Object.hasOwn(handlers, 'onChallenge'), 'no onChallenge callback is wired').toBe(false);
    expect(handlers.onChallenge, 'and nothing answers to that name').toBeUndefined();
    for (const name of ['onAccept', 'onDecline', 'onCancel']) {
      expect(typeof handlers[name], `control: ${name} is still wired`).toBe('function');
    }
  });

  it('dispatch skips: a full party sends nothing for the box slot and says why, and an explicit slot still sends', async () => {
    // WRONG IMPL KILLED: a -1 that sends the box sentinel into a full party (an accepted server
    // no-op the player never sees), a full-party guard that also blocks an explicit slot, and a
    // skip that is silent.
    // ctl-10a (named intentional change, CTL10A.4): the heal half of this case (the Box's
    // `onHealParty` with no pad loaded, then with one) is removed with the Box Heal Party control.
    // Its survivors: CTL7C-3-ABSENT (a location-less healParty sends nothing and says why, with or
    // without pads) and CTL10A-4-NO-BOX-HEAL-HANDLER (the Box gets no heal callback at all).
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
      // ctl-10b (named intentional change): was ['PvpView', 'onChallenge', [OTHER_IDENTITY]]; the
      // PvpView callback is retired, so the pvp-action path is driven through its Accept instead.
      ['PvpView', 'onAccept', [91n]],
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
    //
    // ctl-7d (named intentional change, CTL7D.4): the shop's plain `shop.feedback.purchased` /
    // `.sold` ids are deleted. A buy or sell now shows a line naming the quantity, the item and the
    // gold; no item or shop-item row is loaded here, so each shop row expects the literal COUNT
    // line for the quantity 1 the legacy ShopView sends. Every other row is unchanged.
    await bootReady();
    server(1000);
    const line = (key: string): string => i18n.t(key as never);
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
    // The fourth field is the exact line the action must paint.
    const cases: ReadonlyArray<readonly [string, string, readonly unknown[], string]> = [
      ['TradeView', 'onAccept', [81n], line('trade.feedback.accepted')],
      ['TradeView', 'onReject', [82n], line('trade.feedback.rejected')],
      ['TradeView', 'onConfirm', [83n], line('trade.feedback.completed')],
      ['TradeView', 'onCancel', [84n], line('trade.feedback.cancelled')],
      ['ShopView', 'onBuy', [11, 22], enBoughtCount(1)],
      ['ShopView', 'onSell', [23], enSoldCount(1)],
      ['RenameView', 'onSubmit', ['Zed'], line('chrome.rename.updated')],
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
        line('tradePropose.feedback.sent'),
      ],
      ['RaisingView', 'onCare', [72n], line('raising.feedback.cared')],
    ];
    const feedbackOf = (name: string): string[] => H.views[name]?.feedback ?? [];

    for (const [target, name, args, expectedLine] of cases) {
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
          v === target ? [expectedLine] : [],
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
    // ctl-7d (named intentional change, CTL7D.5): the policy gains `pickShop: 'refuse'`.
    // ctl-10a (named intentional change, CTL10A.4): `healParty` lost its only view callback (the
    // Box's Heal Party), so it moves here; CTL7C-3-PRESENT refuses it at a battle base.
    // ctl-10b (named intentional change, CTL10B.2): `challenge` lost its only view callback (PvpView's
    // per-player Challenge buttons), so it moves here.
    const noViewCallback: Readonly<Record<string, string>> = {
      challenge:
        'no view constructor callback since ctl-10b: the world action sheet`s confirm Yes ' +
        'dispatches it, and main.input.test.ts CTL10B-1-BOOT-CHALLENGE-YES proves that path',
      healParty:
        'no view constructor callback since ctl-10a: the heal frame`s screen adapter dispatches ' +
        'it, and CTL7C-3-PRESENT in this file refuses every healParty shape at a battle base',
      advanceDialogue:
        'no view constructor callback: the document-level [data-choice-idx] click delegation ' +
        'dispatches it, and main.controls.test.ts refuses that click at a battle base',
      pickShop:
        'no view constructor callback: a dialogue screen adapter and the document-level ' +
        '[data-shop-id] click delegation dispatch it, and CTL7D-5-BOOT-BATTLE-REFUSED in this ' +
        'file refuses both at a battle base',
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

/** A dialogue NPC one tile east of the player and a healer on the player's own tile, in one batch
 *  at clock `t`. (ctl-10a: which of them A interacts with is the stubbed wasm rule's answer, see
 *  `useNpcRule`; T no longer interacts.) */
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

    // Control: in the same state the absent arm sends nothing and says why.
    // ctl-10a (named intentional change, CTL10A.4): this control expected the absent arm to send
    // the store's first pad (7), the retired Box behaviour; healing happens only at a bound healer
    // now, so a location-less heal is refused with the pads loaded.
    issue.command = { kind: 'healParty' };
    H.calls = [];
    status.textContent = '';
    await pageUp(1600);
    expect(H.calls, 'control: the absent arm sends nothing, pads or not').toEqual([]);
    expect(statusText(), 'control: and says why').toBe(i18n.t('chrome.status.healUnavailable'));

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

  it('CTL7C-3-ABSENT: a screen command healParty with no locationId sends nothing and tells the player, with no pad loaded and with pads loaded (the Box`s first-pad fallback is retired)', async () => {
    // WRONG IMPL KILLED: an absent arm that sends `undefined` or 0 when no pad is loaded (a
    // guaranteed invisible server Err), one that loses the report, one that still falls back to
    // the store's first pad (or the last, or a fixed one) once pads are loaded (B13: a heal at a
    // location the player never chose), and a screen command path that never reaches `dispatch`.
    // ctl-10a (named intentional change, CTL10A.4): the second half expected the store's first pad
    // (7) to be sent once pads arrive (the Box Heal Party behaviour CTL7C.3 kept "until ctl-10a");
    // it now expects nothing sent and the same report.
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
    expect(
      opts.store
        .healLocations()
        .map((l) => l.locationId)
        .sort(),
      'precondition: pads 7 and 9 are loaded',
    ).toEqual([7, 9]);
    H.calls = [];
    status.textContent = '';
    await pageUp(1300);
    expect(H.calls, 'with pads loaded nothing is sent either').toEqual([]);
    expect(statusText(), 'and the player is told').toBe(i18n.t('chrome.status.healUnavailable'));
  });

  it('CTL7C-2-BOOT-VIEWS: every frame id lends ITS OWN view instance to its adapter`s paint: each of the nine recorded stand-in views that back a frame, the real dialogue, quest log, heal, help and menu views, and the Social frame`s composite over the trade and pvp stand-ins and the real leaderboard, each shown alone and sent one routed button', async () => {
    // WRONG IMPL KILLED: a view-lending table with a copy-pasted sibling thunk (`raisingView:
    // () => boxView` type-checks, and the raising screen's state would be painted into the box),
    // one that lends every frame the same view, one that lends a view the shell did not build
    // (a fresh instance, never shown), and one that lends nothing (no paint at all).
    // INTENTIONAL CHANGE (ctl-8s, CTL8S.3): the trade, pvp and leaderboard overlays are no longer
    // frames of their own: they are the panels of the ONE Social frame (`social`), whose adapter is
    // lent a composite naming the three view instances. Was: the trade and pvp stand-ins and the
    // real leaderboard were each driven as their own frame. Every other frame id's case is as it
    // was, and the closing anti-vacuity check now lists `social` in place of the three panels.
    // ctl-10a: T retired — the heal frame opens through A (Enter) with the stubbed wasm interact
    // rule naming the healer; its opener below was KeyT. Nothing else in this case changes.
    await bootReady();
    useNpcRule(HEALER_ENTITY);
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
    /** The Social frame's three panels (ctl-8s): never frames of their own. HARD-CODED. */
    const PANELS: readonly string[] = ['tradeView', 'pvpView', 'leaderboardView'];
    for (const id of [...OVERLAY_IDS, 'social']) swapAdapter(id, paintingAdapter(id, paints));
    /** The paints one routed button (PageUp = LB) to the top frame produced. */
    const paintsOfOnePress = (t: number): Array<{ id: string; view: unknown }> => {
      paints.length = 0;
      press('PageUp', t);
      return [...paints];
    };
    const covered: string[] = [];
    let t = 1100;

    // The stand-ins that back a frame: each shown alone through its own flag, closed by its
    // adapter's Start. ctl-8s: the trade and pvp stand-ins are Social panels, driven below.
    for (const [id, cls] of Object.entries(STAND_IN_CLASS)) {
      if (PANELS.includes(id)) continue;
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

    // The five real views that back a frame, each opened by its own real path and closed again
    // (ctl-8s: the leaderboard is the Social frame's Rankings panel, driven below).
    // ctl-11a: the quest log is opened by J (Q is LB now), and J opens it over the main menu, so its
    // `beneath` names the frame under it; every other opener is alone over the world as before.
    const openers: ReadonlyArray<{
      readonly id: string;
      readonly beneath?: readonly string[];
      readonly open: (at: number) => void;
      readonly close: (at: number) => void;
    }> = [
      {
        id: 'questLogView',
        beneath: ['menuView'],
        open: (at) => void press('KeyJ', at),
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
        open: (at) => void press('Enter', at),
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
      expect(stackNow(), `${o.id}: precondition: opened over the world`).toEqual([
        { kind: 'world' },
        ...(o.beneath ?? []).map((id) => ({ kind: 'screen', id })),
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

    // ctl-8s: the Social frame, opened by its real path (U), lends its adapter the composite: the
    // trade and pvp stand-ins main.ts built, the real leaderboard view, and one chrome element.
    // ctl-11a: U opens Social over the main menu (Social > Trades), so `menuView` sits beneath it.
    press('KeyU', t);
    expect(stackNow(), 'social: precondition: opened over the main menu').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'menuView' },
      { kind: 'screen', id: 'social' },
    ]);
    const socialPainted = paintsOfOnePress(t + 10);
    expect(
      socialPainted.map((p) => p.id),
      'social: one paint, by the Social frame`s own adapter',
    ).toEqual(['social']);
    const composite = socialPainted[0]?.view as SocialFrameView | undefined;
    expect(composite?.trades, 'social: its trades panel is the TradeView main.ts built').toBe(
      H.views.TradeView,
    );
    expect(composite?.challenges, 'social: its challenges panel is the PvpView main.ts built').toBe(
      H.views.PvpView,
    );
    expect(
      composite?.rankings,
      'social: its rankings panel is a real LeaderboardView',
    ).toBeInstanceOf(real.leaderboardView as never);
    expect(composite?.chrome, 'social: one chrome element').toBeInstanceOf(HTMLElement);
    press('Escape', t + 50);
    expect(stackNow(), 'social: closed again').toEqual([{ kind: 'world' }]);
    covered.push('social');

    expect([...covered].sort(), 'ANTI-VACUITY: every frame id lent its view').toEqual(
      [...OVERLAY_IDS.filter((id) => !PANELS.includes(id)), 'social'].sort(),
    );
  });
});

// ==========================================================================================
// ctl-7c round 2: a store batch and a held D-pad key (red-team survivors M5, M5b)
// ==========================================================================================
//
// A batch whose reconcile DROPS a frame assigns the stack directly (no mirror edge), so the shell
// itself must stop a repeat armed in the dropped frame; a batch that drops nothing must leave a
// running repeat alone. Here the dropped frame is the box stand-in shown by its own flag above
// the menu over a battle (not battle-safe, so the next batch drops it), as the red-team PoC does.

/** A keydown at the window at clock `t` (no keyup: the key stays held). */
function keyDown(code: string, t: number): KeyboardEvent {
  clock.t = t;
  const down = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
  window.dispatchEvent(down);
  return down;
}

/** The keyup of a held key at clock `t`. */
function keyUp(code: string, t: number): void {
  clock.t = t;
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

/** The main menu's active entry while it is open, else null (the read-only `__game()` hook). */
const menuCursorNow = (): string | null =>
  (window as unknown as { __game: () => { navActive: string | null } }).__game().navActive;

describe('main.ts store batches and a held key (runtime, ctl-7c)', { sequential: true }, () => {
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

  it('CTL7C-1-BOOT-RECONCILE-RESET: a D-pad key held on a nav-capable frame that a store batch drops never repeats into the menu the drop uncovers; a batch that drops nothing leaves a running menu repeat alone', async () => {
    // WRONG IMPL KILLED (M5, M5b): a reconcile drop that does not reset the repeat (the drop raises
    // no mirror edge: the arrow held on the dropped screen walks the menu cursor under it at
    // 10 Hz with no key pressed in the menu), and the over-correction, a reset on EVERY batch (a
    // held arrow in a menu would stall on each store batch, which arrive several times a second
    // in play).
    await bootReady();
    server(1000);
    const seen: Pressed[] = [];
    swapAdapter('boxView', {
      nav: true,
      viewModel: () => undefined,
      init: () => undefined,
      onButton: (_vm: unknown, state: unknown, btn: Pressed) => {
        seen.push(btn);
        return { state, result: btn.button === 'B' && !btn.repeat ? { kind: 'pop' } : 'consumed' };
      },
    });

    // --- (a) a batch that drops nothing: Down held in the open main menu keeps repeating ------
    openMenuAtWorld(1010);
    expect(menuCursorNow(), 'a, precondition: the menu opens on its first entry').toBe('monsters');
    keyDown('ArrowDown', 1100);
    expect(menuCursorNow(), 'a, precondition: the press moved the cursor').toBe('bag');
    server(1200); // an unrelated store batch: nothing is dropped
    expect(stackNow(), 'a, precondition: the batch dropped nothing').toEqual([
      { kind: 'world' },
      { kind: 'screen', id: 'menuView' },
    ]);
    frame(1449);
    expect(menuCursorNow(), 'a: nothing before +350').toBe('bag');
    frame(1450);
    expect(menuCursorNow(), 'a: the repeat survived the batch').toBe('journal');
    keyUp('ArrowDown', 1460);
    press('Escape', 1500);
    expect(stackNow(), 'a: Start closed the menu').toEqual([{ kind: 'world' }]);

    // --- (b) a batch that drops the frame the key is held on ----------------------------------
    putBattle(BATTLE_ID, 1600);
    press('Escape', 1700);
    expect(stackNow(), 'b, precondition: Start opened the menu over the battle').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
    ]);
    const box = H.views.BoxView;
    if (box === undefined) throw new Error('BoxView was never constructed by main.ts');
    box.visible = true; // a nav screen that is not battle-safe, above the battle-safe menu
    const held = keyDown('ArrowDown', 1800);
    expect(stackNow(), 'b, precondition: the box is a frame above the menu').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
      { kind: 'screen', id: 'boxView', overBattle: '101' },
    ]);
    expect(seen, 'b, precondition: the press reached the box').toEqual([
      { button: 'Down', repeat: false },
    ]);
    expect(held.defaultPrevented).toBe(true);
    const cursor = menuCursorNow();
    expect(cursor, 'b, precondition: the covered menu is open').not.toBeNull();

    server(1900); // the batch's reconcile drops the box
    expect(stackNow(), 'b, precondition: the batch dropped the box').toEqual([
      { kind: 'battle', battleId: '101' },
      { kind: 'screen', id: 'menuView', overBattle: '101' },
    ]);
    expect(box.visible, 'b, precondition: through its own hide').toBe(false);
    for (const t of [2149, 2150, 2250, 2500, 3000]) frame(t);
    expect(menuCursorNow(), 'b: the arrow held on the dropped box never walks the menu').toBe(
      cursor,
    );
    expect(
      seen.filter((b) => b.repeat),
      'b: nor repeats into the dropped box',
    ).toEqual([]);
    keyUp('ArrowDown', 3100);

    // Control: the menu, on top again, moves for a fresh press.
    press('ArrowDown', 3200);
    expect(menuCursorNow(), 'b, control: a fresh press moves the menu').not.toBe(cursor);
  });
});

// ==========================================================================================
// ctl-7d: the screen-context seam (CTL7D.1-.6)
// ==========================================================================================
//
// Same harness and stand-in pattern as ctl-7c: one fresh main.ts per case, one frame's adapter
// swapped for a stand-in, real keys through the real router. A stand-in either reads what an
// adapter can read (`ScreenContext`) on a routed LB (PageUp) press, or issues the command under
// test on it. The shop and heal frames are opened by their REAL paths: the greet-then-shop pick
// over a conversation (the shop opens on the first batch with no conversation) and A at a healer
// the stubbed wasm interact rule names (ctl-10a: it was T beside a healer). The stand-in views'
// own flags show them where a case needs no open path.

/** The `ScreenContext` fields the ctl-7d stand-ins read. Loosely typed on purpose: the context
 *  the shell builds today has none of them, so a read shows `undefined` rather than failing to
 *  build. */
interface CtxRead {
  readonly shopId?: unknown;
  readonly healLocationId?: unknown;
  readonly reduceMotion?: unknown;
  /** ctl-8s (CTL8S.2): the requested Social tab. */
  readonly socialTab?: unknown;
}

/** A stand-in adapter whose view model is `pick(ctx)`, recorded on every routed LB (PageUp) press;
 *  B and Start close its frame as the legacy adapter does. It has no `observe`, so the host builds
 *  its view model only on a button step, and `reads` holds exactly one entry per LB press. */
function readingAdapter(reads: unknown[], pick: (ctx: CtxRead) => unknown): unknown {
  return {
    viewModel: (ctx: CtxRead) => pick(ctx),
    init: () => undefined,
    onButton: (vm: unknown, state: unknown, btn: Pressed) => {
      if (btn.repeat) return { state, result: 'consumed' };
      if (btn.button === 'LB') {
        reads.push(vm);
        return { state, result: 'consumed' };
      }
      if (btn.button === 'B') return { state, result: { kind: 'pop' } };
      if (btn.button === 'Start') return { state, result: { kind: 'popToBase' } };
      return { state, result: 'unhandled' };
    },
  };
}

/** Both bound ids as one read: `[shopId, healLocationId]`. */
const boundIds = (ctx: CtxRead): unknown => [ctx.shopId, ctx.healLocationId];

const WORLD_FRAME = { kind: 'world' } as const;
const screenFrame = (id: string): { kind: 'screen'; id: string } => ({ kind: 'screen', id });

/** ctl-11a: what U, P and L leave on the stack: the one Social frame over the main menu they were
 *  opened through (an accelerator pops to the base and opens its menu path). */
const SOCIAL_OVER_MENU = [WORLD_FRAME, screenFrame('menuView'), screenFrame('social')];

/** The one dismissDialogue call a greet-then-shop pick sends. */
const ONE_DISMISS = [{ name: 'dismissDialogue', args: {} }];

/** The query render/motionPreference.ts asks the browser (A11Y-28: the one matchMedia read). */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const HEALER_A = 21n;
const HEALER_B = 22n;

/** A recorded stand-in view, or a loud failure when main.ts never built it. */
function stubView(name: string): (typeof H.views)[string] {
  const view = H.views[name];
  if (view === undefined) throw new Error(`${name} was never constructed by main.ts`);
  return view;
}

/** One NPC row and its character at (`tileX`, 6), with no flush. */
function placeNpc(
  entityId: bigint,
  npcId: string,
  tileX: number,
  interaction: StoreNpcRow['interaction'],
  t: number,
): void {
  opts.store.upsertNpc({
    entityId,
    npcId,
    zoneId: 0,
    homeX: tileX,
    homeY: 6,
    wanderRadius: 0,
    dialogueTreeId: 'no-such-tree',
    interaction,
  });
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

/** An NPC row and its character leave, with no flush. */
function dropNpc(entityId: bigint): void {
  opts.store.removeNpc(entityId);
  opts.store.removeCharacter(entityId);
}

/** An item definition row; only the name and the sell price matter to the shop lines. */
function itemDef(id: number, name: string, sellPrice: bigint): StoreItemRow {
  return {
    id,
    name,
    description: '',
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice,
    cureStatus: null,
  };
}

/** The server opens a conversation with the guide, in one batch at clock `t`. */
function startConversation(t: number): void {
  opts.store.upsertConversation({
    ownerIdentity: H.identity,
    npcEntityId: GUIDE_ENTITY,
    currentNodeId: 'start',
  });
  server(t);
}

/** The server ends the conversation, in one batch at clock `t`. */
function endConversation(t: number): void {
  opts.store.removeConversation(H.identity);
  server(t);
}

/** Click a greet-then-shop button as the dialogue renders one (the document-level delegate). */
function clickShop(t: number, shopId: string): void {
  const button = document.createElement('button');
  button.dataset.shopId = shopId;
  document.body.appendChild(button);
  clock.t = t;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  button.remove();
}

/** Open the main menu at the world, send its stand-in one LB, and close it again with Start. */
async function readAtMenu(t: number): Promise<void> {
  openMenuAtWorld(t);
  await pageUp(t + 10);
  press('Escape', t + 20);
  expect(stackNow(), 'precondition: Start closed the menu').toEqual([WORLD_FRAME]);
}

/** A REAL greet-then-shop open of `shopId` (the conversation, the Shop click, the batch that ends
 *  the conversation), one LB to the shop frame's stand-in, then Start closes it. */
async function openShopAndRead(t: number, shopId: string): Promise<void> {
  const shop = stubView('ShopView');
  startConversation(t);
  expect(stackNow(), `shop ${shopId}: precondition: the conversation is the one frame`).toEqual([
    WORLD_FRAME,
    screenFrame('dialogueView'),
  ]);
  H.calls = [];
  clickShop(t + 10, shopId);
  expect(H.calls, `shop ${shopId}: precondition: the pick sent one dismiss`).toEqual(ONE_DISMISS);
  expect(shop.visible, `shop ${shopId}: precondition: no shop over the conversation`).toBe(false);
  endConversation(t + 20);
  expect(stackNow(), `shop ${shopId}: precondition: the shop frame is the one frame`).toEqual([
    WORLD_FRAME,
    screenFrame('shopView'),
  ]);
  await pageUp(t + 30);
  press('Escape', t + 40);
  expect(stackNow(), `shop ${shopId}: precondition: Start closed the shop`).toEqual([WORLD_FRAME]);
}

/** A at the healer the stubbed rule names opens the heal frame alone, one LB to its stand-in, then
 *  Start closes it. (ctl-10a: T retired — this opener was KeyT.) */
async function healAndRead(t: number, label: string): Promise<void> {
  press('Enter', t);
  expect(stackNow(), `${label}: precondition: A opened the heal frame alone`).toEqual([
    WORLD_FRAME,
    screenFrame('healView'),
  ]);
  await pageUp(t + 10);
  press('Escape', t + 20);
  expect(stackNow(), `${label}: precondition: Start closed the heal frame`).toEqual([WORLD_FRAME]);
}

/** A stand-in adapter that records `{ id, now }` on every observe and keeps its state unchanged
 *  (so it never paints), consumes every button but Start, and answers Start with popToBase. */
function observingAdapter(id: string, log: Array<{ id: string; now: unknown }>): unknown {
  return {
    viewModel: () => undefined,
    init: () => ({ id }),
    observe: (_vm: unknown, state: unknown, now: unknown) => {
      log.push({ id, now });
      return state;
    },
    onButton: (_vm: unknown, state: unknown, btn: Pressed) => ({
      state,
      result: btn.button === 'Start' && !btn.repeat ? { kind: 'popToBase' } : 'consumed',
    }),
  };
}

/** A `matchMedia` stand-in for a pre-boot stub: ONE MediaQueryList-like object whose `.matches`
 *  stays at `initial` (the preference moves by its change event only), the queries it was asked,
 *  and every change listener registered on it. */
function motionStub(initial: boolean) {
  const queries: string[] = [];
  const listeners: Array<(e: { readonly matches: boolean }) => void> = [];
  const mql = {
    get matches(): boolean {
      return initial;
    },
    addEventListener: (
      type: string,
      listener: (e: { readonly matches: boolean }) => void,
    ): void => {
      if (type === 'change') listeners.push(listener);
    },
  };
  const matchMedia = (query: string): typeof mql => {
    queries.push(query);
    return mql;
  };
  return { matchMedia, queries, listeners };
}

/** The ctl-7c blocks' afterEach as one function: the ctl-7d blocks run it after each case, and the
 *  multi-boot cases also between their boots. */
function teardownBoot(): void {
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
}

describe('main.ts screen context reads (runtime, ctl-7d)', { sequential: true }, () => {
  afterEach(teardownBoot);

  it('CTL7D-1-BOOT-SHOP-ID: ScreenContext.shopId reads null before any shop open, then the id a real greet-then-shop open bound (shop 0 as 0, then shop 4), keeps it after the shop closes, and rebinds on the next open', async () => {
    // WRONG IMPL KILLED: no `shopId` on the context (every read `undefined`), a truthiness guard
    // (`boundShopId || null`: shop 0 reads null), a value snapshotted into the context literal at
    // boot instead of a getter read live (null forever), a getter that answers the heal location
    // (nothing binds one in this case), a close that clears the binding (the menu would read null
    // after the shop closes), and an open that does not rebind (shop 4 would read 0).
    await bootReady();
    server(1000);
    seedNpcs(1010);
    const menuReads: unknown[] = [];
    const shopReads: unknown[] = [];
    swapAdapter('menuView', readingAdapter(menuReads, boundIds));
    swapAdapter('shopView', readingAdapter(shopReads, boundIds));

    await readAtMenu(1100);
    expect(menuReads, 'before any shop open: [shopId, healLocationId]').toEqual([[null, null]]);

    await openShopAndRead(1200, '0');
    expect(shopReads, 'the open bound shop 0, read as 0').toEqual([[0, null]]);
    await readAtMenu(1300);
    expect(menuReads, 'the close keeps shop 0').toEqual([
      [null, null],
      [0, null],
    ]);

    await openShopAndRead(1400, '4');
    expect(shopReads, 'the next open rebinds: shop 4').toEqual([
      [0, null],
      [4, null],
    ]);
    await readAtMenu(1500);
    expect(menuReads, 'and the close keeps shop 4').toEqual([
      [null, null],
      [0, null],
      [4, null],
    ]);
  });

  it('CTL7D-1-BOOT-HEAL-ID: ScreenContext.healLocationId reads null before A at a healer, then the location A bound there (location 0 as 0, then 6 at another healer), keeps it after a close, and the shop id and the heal id stay two independent values', async () => {
    // WRONG IMPL KILLED: no `healLocationId` on the context, a truthiness guard (location 0 reads
    // null), a boot-time snapshot instead of a live getter, a close that clears it, a T at another
    // healer that does not rebind (6 would read 0), and ONE variable behind both getters or a bind
    // that resets the other id: a heal getter answering the shop id ([null, null] where location 0
    // is bound), a shop open that clears the heal id ([4, null]), a heal bind that clears the shop
    // id ([null, 6]).
    // ctl-10a: T retired — `healAndRead` opens the heal frame with A, the stubbed wasm interact
    // rule naming the healer (A, then B); the binding contract read here is unchanged.
    await bootReady();
    useNpcRule(HEALER_A, HEALER_B);
    server(1000);
    placeNpc(GUIDE_ENTITY, 'guide', 3, { kind: 'dialogue' }, 1010);
    placeNpc(HEALER_A, 'healer-a', 2, { kind: 'heal', locationId: 0 }, 1010);
    server(1010);
    const menuReads: unknown[] = [];
    const healReads: unknown[] = [];
    const shopReads: unknown[] = [];
    swapAdapter('menuView', readingAdapter(menuReads, boundIds));
    swapAdapter('healView', readingAdapter(healReads, boundIds));
    swapAdapter('shopView', readingAdapter(shopReads, boundIds));

    await readAtMenu(1100);
    expect(menuReads, 'before T: [shopId, healLocationId]').toEqual([[null, null]]);

    await healAndRead(1200, 'the healer at location 0');
    expect(healReads, 'T bound location 0, read as 0; the shop id is untouched').toEqual([
      [null, 0],
    ]);
    await readAtMenu(1300);
    expect(menuReads, 'the close keeps location 0').toEqual([
      [null, null],
      [null, 0],
    ]);

    // A shop open binds the shop id and leaves the heal id bound.
    await openShopAndRead(1400, '4');
    expect(shopReads, 'a shop open binds shop 4 and keeps location 0').toEqual([[4, 0]]);

    // T at another healer rebinds the heal id and leaves the shop id bound.
    dropNpc(HEALER_A);
    placeNpc(HEALER_B, 'healer-b', 2, { kind: 'heal', locationId: 6 }, 1500);
    server(1500);
    await healAndRead(1600, 'the healer at location 6');
    expect(healReads, 'T at another healer rebinds to 6 and keeps shop 4').toEqual([
      [null, 0],
      [4, 6],
    ]);
    await readAtMenu(1700);
    expect(menuReads, 'and the close keeps both').toEqual([
      [null, null],
      [null, 0],
      [4, 6],
    ]);
  });

  it('CTL7D-1-BOOT-RECONNECT-NULL: with both ids bound (shop 0, heal location 6), the connection`s reconnect path clears both: the heal frame the reconnect leaves open reads [null, null], and so does the menu opened after it', async () => {
    // WRONG IMPL KILLED: a reconnect that clears neither id, or only one of them (an adapter would
    // keep acting on a shop or a heal location whose rows the store reset invalidated), and a
    // getter that caches its first read.
    // ctl-10a: T retired — the heal frame opens with A, the stubbed wasm interact rule naming the
    // healer; the press below was KeyT. The reconnect contract read here is unchanged.
    await bootReady();
    useNpcRule(HEALER_A);
    server(1000);
    placeNpc(GUIDE_ENTITY, 'guide', 3, { kind: 'dialogue' }, 1010);
    placeNpc(HEALER_A, 'healer', 2, { kind: 'heal', locationId: 6 }, 1010);
    server(1010);
    const menuReads: unknown[] = [];
    const healReads: unknown[] = [];
    const shopReads: unknown[] = [];
    swapAdapter('menuView', readingAdapter(menuReads, boundIds));
    swapAdapter('healView', readingAdapter(healReads, boundIds));
    swapAdapter('shopView', readingAdapter(shopReads, boundIds));

    await openShopAndRead(1100, '0');
    expect(shopReads, 'precondition: the open bound shop 0').toEqual([[0, null]]);
    press('Enter', 1200);
    expect(stackNow(), 'precondition: A opened the heal frame alone').toEqual([
      WORLD_FRAME,
      screenFrame('healView'),
    ]);
    await pageUp(1210);
    expect(healReads, 'precondition: both ids are bound').toEqual([[0, 6]]);

    opts.onReconnect(H.identity);
    await pageUp(1300);
    // Pinned as it is (pre-existing; its residual belongs to ctl-10a): the reconnect hides the
    // shop and the menu, never the heal view, so the heal frame is still open here.
    expect(stackNow(), 'precondition: the reconnect left the heal frame open').toEqual([
      WORLD_FRAME,
      screenFrame('healView'),
    ]);
    expect(healReads, 'the next read on the open heal frame: both null').toEqual([
      [0, 6],
      [null, null],
    ]);

    press('Escape', 1400);
    expect(stackNow(), 'precondition: Start closed the heal frame').toEqual([WORLD_FRAME]);
    await readAtMenu(1500);
    expect(menuReads, 'a frame opened after the reconnect reads both null too').toEqual([
      [null, null],
    ]);
  });

  it('CTL7D-2-BOOT-REDUCED-MOTION: ScreenContext.reduceMotion reads the one motion preference live: its initial value, then the value of each change event fired between two presses, from either initial value, with matchMedia asked exactly once for the reduced-motion query', async () => {
    // WRONG IMPL KILLED: no `reduceMotion` on the context (every read `undefined`), a hardcoded
    // false or true (one of the two initial values reads wrong), a value snapshotted at boot
    // instead of a live getter (the read after a change event is stale), a getter that re-queries
    // `matchMedia(q).matches` (this stub's `.matches` never moves, only its change event does,
    // and every extra query is counted), and a second motion preference of main.ts's own (a
    // second matchMedia call).
    for (const initial of [false, true]) {
      // The second boot needs the first boot's listeners, stubs and adapter swaps gone.
      if (initial) teardownBoot();
      const queries: string[] = [];
      const listeners: Array<(e: { readonly matches: boolean }) => void> = [];
      const mql = {
        // Fixed at the initial value: the preference moves by the change event only.
        get matches(): boolean {
          return initial;
        },
        addEventListener: (
          type: string,
          listener: (e: { readonly matches: boolean }) => void,
        ): void => {
          if (type === 'change') listeners.push(listener);
        },
      };
      const matchMediaStub = (query: string): typeof mql => {
        queries.push(query);
        return mql;
      };
      await bootReady(() => {
        vi.stubGlobal('matchMedia', matchMediaStub);
      });
      expect(window.matchMedia, `initial ${initial}: precondition: the stub is installed`).toBe(
        matchMediaStub,
      );
      server(1000);
      const reads: unknown[] = [];
      swapAdapter(
        'menuView',
        readingAdapter(reads, (ctx) => ctx.reduceMotion),
      );
      openMenuAtWorld(1010);

      await pageUp(1100);
      expect(
        listeners.length,
        `initial ${initial}: precondition: a change listener is registered`,
      ).toBeGreaterThan(0);
      for (const listener of listeners) listener({ matches: !initial });
      await pageUp(1200);
      for (const listener of listeners) listener({ matches: initial });
      await pageUp(1300);

      expect(
        reads,
        `initial ${initial}: the initial value, then each change event's value`,
      ).toEqual([initial, !initial, initial]);
      expect(
        queries,
        `initial ${initial}: one matchMedia call in total, for the reduced-motion query`,
      ).toEqual([REDUCED_MOTION_QUERY]);
    }
  });

  it('CTL7D-6-BOOT-LIVE-CTX: the context the shell hands an adapter is the live one on both entry points: a context retained from a batch observe and one retained from a button press each read the new reduced-motion value and the new bound shop after a change event and a shop open, with no further call', async () => {
    // WRONG IMPL KILLED: a context copied at the call (`{ ...screenCtx }` snapshots every getter)
    // on the batch path (`screenHost.observe`) or on the button path (`screenHost.button`): the
    // retained copy would keep reading reduced motion false and no bound shop.
    const motion = motionStub(false);
    await bootReady(() => {
      vi.stubGlobal('matchMedia', motion.matchMedia);
    });
    server(1000);
    seedNpcs(1010);
    // The menu's stand-in: its view model IS the context it was built from, so observe and
    // onButton each receive the very context object the shell handed it.
    const fromObserve: CtxRead[] = [];
    const fromButton: CtxRead[] = [];
    swapAdapter('menuView', {
      viewModel: (ctx: CtxRead) => ctx,
      init: () => undefined,
      observe: (vm: CtxRead, state: unknown) => {
        fromObserve.push(vm);
        return state;
      },
      onButton: (vm: CtxRead, state: unknown, btn: Pressed) => {
        if (btn.button === 'LB' && !btn.repeat) fromButton.push(vm);
        const closes = btn.button === 'Start' && !btn.repeat;
        return { state, result: closes ? { kind: 'popToBase' } : 'consumed' };
      },
    });

    openMenuAtWorld(1020);
    server(1030);
    await pageUp(1040);
    const viaObserve = fromObserve[0];
    const viaButton = fromButton[0];
    if (viaObserve === undefined) throw new Error('precondition: a batch observed the menu');
    if (viaButton === undefined) throw new Error('precondition: the LB press reached the menu');
    for (const [label, ctx] of [
      ['observe', viaObserve],
      ['button', viaButton],
    ] as const) {
      expect(
        [ctx.reduceMotion, ctx.shopId],
        `${label}: precondition: no reduced motion, no shop bound`,
      ).toEqual([false, null]);
    }
    press('Escape', 1050);
    expect(stackNow(), 'precondition: Start closed the menu').toEqual([WORLD_FRAME]);

    // The OS preference changes, and a real greet-then-shop open binds shop 4.
    expect(
      motion.listeners.length,
      'precondition: a change listener is registered',
    ).toBeGreaterThan(0);
    for (const listener of motion.listeners) listener({ matches: true });
    startConversation(1100);
    clickShop(1110, '4');
    endConversation(1120);
    expect(stackNow(), 'precondition: the open showed the shop').toEqual([
      WORLD_FRAME,
      screenFrame('shopView'),
    ]);

    // The retained contexts, read again: no adapter call in between.
    for (const [label, ctx] of [
      ['observe', viaObserve],
      ['button', viaButton],
    ] as const) {
      expect(
        [ctx.reduceMotion, ctx.shopId],
        `${label}: the retained context reads the new values live`,
      ).toEqual([true, 4]);
    }
  });
});

describe('main.ts shop quantity and line (runtime, ctl-7d)', { sequential: true }, () => {
  afterEach(teardownBoot);

  it('CTL7D-3-BOOT-QTY-SENT: a screen command buy or sell carrying a quantity sends exactly that quantity to its reducer, verbatim: 1, 3, 2147483648 and 4294967295, one reducer call per command', async () => {
    // WRONG IMPL KILLED: the old fixed `qty: 1` (or any constant) in place of the command's own, a
    // signed 32-bit coercion (`qty | 0`: 2147483648 and 4294967295 go negative), a clamp to a
    // smaller cap, a dropped or renamed field, buy's shopId and itemId swapped, and a second
    // reducer call per command. (An unsigned `qty >>> 0` is the identity on these values; it dies
    // with the invalid quantities: -1 and 2^32 + 1 would wrap into range and send.)
    await bootReady();
    server(1000);
    const issue: { command: unknown } = { command: { kind: 'pop' } };
    swapAdapter('menuView', commandAdapter(issue));
    openMenuAtWorld(1010);
    let t = 1100;
    for (const qty of [1, 3, 2147483648, 4294967295]) {
      const rows: ReadonlyArray<readonly [string, unknown, unknown]> = [
        [
          'buy',
          { kind: 'buy', shopId: 11, itemId: 22, qty },
          { name: 'buy', args: { shopId: 11, itemId: 22, qty } },
        ],
        ['sell', { kind: 'sell', itemId: 23, qty }, { name: 'sell', args: { itemId: 23, qty } }],
      ];
      for (const [kind, command, call] of rows) {
        issue.command = command;
        H.calls = [];
        const down = await pageUp(t);
        t += 100;
        expect(down.defaultPrevented, `${kind} ${qty}: the routed press is consumed`).toBe(true);
        expect(H.calls, `${kind} ${qty}: one call, with exactly that quantity`).toEqual([call]);
      }
    }
  });

  it('CTL7D-3-BOOT-QTY-REJECTED: a buy or sell quantity that is not an integer from 1 to 4294967295 sends nothing, paints no shop line and logs an error naming the command, without throwing; a valid quantity in the same setup sends and paints, before and after the rejected ones', async () => {
    // WRONG IMPL KILLED: no check at all (each row reaches its reducer), a clamp or a default in
    // place of a refusal (`Math.max(1, qty)`, `qty || 1`, `Math.trunc`, `qty | 0`, `qty >>> 0`:
    // 0, 1.5, -1 and 2^32 + 1 would each send an in-range quantity), a check that runs inside or
    // after performCare (a reducer call or a shop line before the refusal), a JS-coercing check
    // (`'3'`, `true`, `[3]` and `null` coerce to numbers a bare range compare accepts), an upper
    // bound of 2^32, MAX_SAFE_INTEGER or none, a check that throws on `3n` or `undefined` (the
    // press would throw), a silent refusal or one that names no command, a log that drops the
    // quantity or folds it into the message (it is its own argument: it may not be printable), a
    // refusal reported to the player (the status line, or an announcement in the live region:
    // an invalid quantity is an adapter bug, not player input), and a refusal that latches (the
    // valid control after the rows must still send).
    await bootReady();
    server(1000);
    const issue: { command: unknown } = { command: { kind: 'pop' } };
    swapAdapter('shopView', commandAdapter(issue));
    const shop = stubView('ShopView');
    // Shown, so the visibility-gated success sink WOULD paint a line for any send.
    shop.visible = true;
    const status = document.getElementById('status');
    if (status === null) throw new Error('#status must exist once booted');
    const live = document.getElementById('a11y-live');
    if (live === null) throw new Error('#a11y-live must be in the shell');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const commandOf = (kind: 'buy' | 'sell', qty: unknown): unknown =>
      kind === 'buy' ? { kind, shopId: 11, itemId: 22, qty } : { kind, itemId: 23, qty };
    const callOf = (kind: 'buy' | 'sell', qty: unknown): unknown =>
      kind === 'buy'
        ? { name: 'buy', args: { shopId: 11, itemId: 22, qty } }
        : { name: 'sell', args: { itemId: 23, qty } };
    let t = 1100;
    /** One routed LB on the shop frame issuing `kind` at `qty`, on a fresh call record, shop line
     *  and error log, then one frame past the live region's 500 ms window (the frame loop is what
     *  writes an announcement into it); returns the keydown. */
    const send = async (kind: 'buy' | 'sell', qty: unknown): Promise<KeyboardEvent> => {
      issue.command = commandOf(kind, qty);
      H.calls = [];
      shop.feedback.length = 0;
      errorSpy.mockClear();
      const down = await pageUp(t);
      frame(t + 600);
      t += 1000;
      return down;
    };
    const control = async (qty: number, when: string): Promise<void> => {
      for (const kind of ['buy', 'sell'] as const) {
        const label = `control ${when}, ${kind} ${qty}`;
        const down = await send(kind, qty);
        expect(down.defaultPrevented, `${label}: the press is consumed`).toBe(true);
        expect(H.calls, `${label}: sent`).toEqual([callOf(kind, qty)]);
        expect(shop.feedback.length, `${label}: one shop line painted`).toBe(1);
      }
    };

    await control(1, 'before the rows');
    expect(stackNow(), 'precondition: the shop frame takes the presses').toEqual([
      WORLD_FRAME,
      screenFrame('shopView'),
    ]);
    // Settle the live region (the shop frame's own announcement lands), then mark the status
    // line: a refusal must leave both exactly as they are.
    frame(t);
    frame(t + 600);
    t += 1000;
    const STATUS_SENTINEL = 'the status line before the rejected rows';
    status.textContent = STATUS_SENTINEL;
    const liveBefore = live.textContent;

    const invalid: ReadonlyArray<readonly [string, unknown]> = [
      ['0', 0],
      ['-0', -0],
      ['-1', -1],
      ['1.5', 1.5],
      ['0.9999999999999999', 0.9999999999999999],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['2^32', 2 ** 32],
      ['2^32 + 1', 2 ** 32 + 1],
      ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
      ['1e21', 1e21],
      // Untyped at this boundary: to the shell an adapter is plain JS.
      ['the string 3', '3'],
      ['the empty string', ''],
      ['true', true],
      ['null', null],
      ['undefined', undefined],
      ['the array [3]', [3]],
      ['the bigint 3n', 3n],
    ];
    for (const kind of ['buy', 'sell'] as const) {
      for (const [qtyLabel, qty] of invalid) {
        const label = `${kind} qty ${qtyLabel}`;
        const down = await send(kind, qty);
        expect(down.defaultPrevented, `${label}: the press did not throw (it was consumed)`).toBe(
          true,
        );
        expect(H.calls, `${label}: no reducer call`).toEqual([]);
        expect(shop.feedback, `${label}: no shop line`).toEqual([]);
        // `Object.is`, so NaN and -0 are compared exactly; the quantity is never stringified.
        expect(
          errorSpy.mock.calls.some(
            (call) =>
              call.length >= 2 &&
              typeof call[0] === 'string' &&
              call[0].includes(kind) &&
              Object.is(call[1], qty),
          ),
          `${label}: console.error names the command, with the quantity as its own argument`,
        ).toBe(true);
        expect(statusText(), `${label}: the status line tells the player nothing`).toBe(
          STATUS_SENTINEL,
        );
        expect(live.textContent, `${label}: nothing is announced`).toBe(liveBefore);
      }
    }

    await control(4294967295, 'after the rows');
  });

  it('CTL7D-4-BOOT-QTY-LINE: a successful screen buy or sell paints, on the shop only, the line naming the quantity, the item and the TOTAL gold, read from the store for the command`s own shop with bigint arithmetic, under en and fr, and the quantity-only line when a row it needs is missing', async () => {
    // WRONG IMPL KILLED: the unit price in place of the total (3 Bait at 13 is 39), `Number`
    // arithmetic (9007199254740993 x 3 is 27021597764222979; in doubles it ends in 976), the first
    // shop-item row for the item whatever its shop (shop 12's Bait row, at 17, is loaded FIRST),
    // the BOUND shop in place of the command's shopId (`boundShopId ?? shopId`: shop 12 is bound
    // by a real greet-then-shop open, so shop 11's Bait would be priced at 17 and its Gem would
    // lose its row), a fixed shop (shop 12's own buy is priced at 17), a quantity of 1 (or none)
    // in the line, the buy and sell wording or sign swapped, a sell priced at a buy price (Bait
    // sells at 7 and buys at 13), a sell that
    // wants a shop-item or an inventory row (Twig has neither), a partial or `Unknown` line when a
    // row is missing (item 25 has no definition; only shop 12 stocks Rope), an untranslated line
    // under fr, and a line painted on another view.
    await bootReady();
    server(1000);
    for (const def of [
      itemDef(22, 'Bait', 7n),
      itemDef(24, 'Gem', 9007199254740993n),
      itemDef(26, 'Rope', 2n),
      itemDef(27, 'Twig', 3n),
    ]) {
      opts.store.upsertItemDef(def);
    }
    opts.store.upsertShop({ shopId: 11, name: 'Eleven' });
    opts.store.upsertShop({ shopId: 12, name: 'Twelve' });
    for (const row of [
      { shopItemId: 1n, shopId: 12, itemId: 22, buyPrice: 17n },
      { shopItemId: 2n, shopId: 11, itemId: 22, buyPrice: 13n },
      { shopItemId: 3n, shopId: 11, itemId: 24, buyPrice: 9007199254740993n },
      { shopItemId: 4n, shopId: 11, itemId: 25, buyPrice: 5n },
      { shopItemId: 5n, shopId: 12, itemId: 26, buyPrice: 9n },
    ]) {
      opts.store.upsertShopItem(row);
    }
    server(1010);
    seedNpcs(1020);
    const issue: { command: unknown } = { command: { kind: 'pop' } };
    // The shop frame's stand-in issues `issue.command` on LB and records the shop id bound then.
    const boundReads: unknown[] = [];
    swapAdapter('shopView', {
      viewModel: (ctx: CtxRead) => ctx.shopId,
      init: () => undefined,
      onButton: (vm: unknown, state: unknown, btn: Pressed) => {
        if (btn.button !== 'LB' || btn.repeat) return { state, result: 'consumed' };
        boundReads.push(vm);
        return { state, result: issue.command };
      },
    });
    const shop = stubView('ShopView');
    // Shop 12 (Bait at 17) is BOUND by a real greet-then-shop open; the commands below name
    // shop 11 (Bait at 13) as often as shop 12, and each is priced from the shop it names.
    startConversation(1030);
    clickShop(1040, '12');
    endConversation(1050);
    expect(stackNow(), 'precondition: the greet-then-shop open showed the shop').toEqual([
      WORLD_FRAME,
      screenFrame('shopView'),
    ]);

    const buy = (shopId: number, itemId: number, qty: number) => ({
      command: { kind: 'buy', shopId, itemId, qty },
      call: { name: 'buy', args: { shopId, itemId, qty } },
    });
    const sell = (itemId: number, qty: number) => ({
      command: { kind: 'sell', itemId, qty },
      call: { name: 'sell', args: { itemId, qty } },
    });
    const BIG = 27021597764222979n;
    const rows = [
      {
        label: 'buy 3 Bait at shop 11',
        ...buy(11, 22, 3),
        en: enBought(3, 'Bait', 39n),
        fr: frBought(3, 'Bait', 39n),
      },
      {
        label: 'buy 4 Bait at shop 12',
        ...buy(12, 22, 4),
        en: enBought(4, 'Bait', 68n),
        fr: frBought(4, 'Bait', 68n),
      },
      {
        label: 'buy 3 Gem above 2^53',
        ...buy(11, 24, 3),
        en: enBought(3, 'Gem', BIG),
        fr: frBought(3, 'Gem', BIG),
      },
      {
        label: 'sell 3 Bait',
        ...sell(22, 3),
        en: enSold(3, 'Bait', 21n),
        fr: frSold(3, 'Bait', 21n),
      },
      {
        label: 'sell 3 Gem above 2^53',
        ...sell(24, 3),
        en: enSold(3, 'Gem', BIG),
        fr: frSold(3, 'Gem', BIG),
      },
      {
        label: 'sell 6 Twig, stocked nowhere',
        ...sell(27, 6),
        en: enSold(6, 'Twig', 18n),
        fr: frSold(6, 'Twig', 18n),
      },
      {
        label: 'buy 4 of item 25, no definition',
        ...buy(11, 25, 4),
        en: enBoughtCount(4),
        fr: frBoughtCount(4),
      },
      {
        label: 'sell 4 of item 25, no definition',
        ...sell(25, 4),
        en: enSoldCount(4),
        fr: frSoldCount(4),
      },
      {
        label: 'buy 5 Rope at shop 11, stocked only by shop 12',
        ...buy(11, 26, 5),
        en: enBoughtCount(5),
        fr: frBoughtCount(5),
      },
    ];
    let t = 1100;
    const run = async (locale: 'en' | 'fr'): Promise<void> => {
      for (const row of rows) {
        issue.command = row.command;
        H.calls = [];
        shop.feedback.length = 0;
        await pageUp(t);
        t += 100;
        expect(shop.feedback, `${locale}, ${row.label}: the line`).toEqual([row[locale]]);
        expect(H.calls, `${locale}, ${row.label}: one reducer call`).toEqual([row.call]);
      }
    };

    await run('en');
    i18n.setLocale('fr');
    try {
      await run('fr');
    } finally {
      i18n.setLocale('en');
    }
    expect(stackNow(), 'precondition: every press reached the shop frame').toEqual([
      WORLD_FRAME,
      screenFrame('shopView'),
    ]);
    expect(boundReads, 'precondition: shop 12 stayed bound for every command').toEqual(
      Array.from({ length: rows.length * 2 }, () => 12),
    );
    for (const [name, view] of Object.entries(H.views)) {
      if (name !== 'ShopView') expect(view.feedback, `no shop line on ${name}`).toEqual([]);
    }
  });

  it('CTL7D-4-BOOT-SEND-TIME: the success line comes from the store rows as they were when the command was sent: a buy and a sell-all held open while batches rename, reprice and remove their rows show the at-send line once they settle, and nothing while pending', async () => {
    // WRONG IMPL KILLED: a line resolved when the reducer settles (after these batches it would
    // read removed rows and print the quantity-only line, or the new name and price), a line
    // resolved on the next batch after the send (Lure / Husk), and a line painted before the
    // reducer settles (a rejection could then follow a success line).
    await bootReady();
    server(1000);
    opts.store.upsertItemDef(itemDef(22, 'Bait', 7n));
    opts.store.upsertItemDef(itemDef(23, 'Berry', 10n));
    opts.store.upsertShop({ shopId: 11, name: 'Eleven' });
    opts.store.upsertShopItem({ shopItemId: 1n, shopId: 11, itemId: 22, buyPrice: 13n });
    opts.store.reconcileInventoryFromView([
      { invId: 5n, ownerIdentity: H.identity, itemId: 23, count: 3 },
    ]);
    server(1010);
    const issue: { command: unknown } = { command: { kind: 'pop' } };
    swapAdapter('shopView', commandAdapter(issue));
    const shop = stubView('ShopView');
    shop.visible = true;
    /** Hold every reducer call open until the returned release runs. */
    const hold = (): (() => void) => {
      let release: () => void = () => {};
      H.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        H.gate = null;
      };
    };

    // --- buy 3 Bait at 13; renamed and repriced, then removed, while pending -------------------
    let release = hold();
    issue.command = { kind: 'buy', shopId: 11, itemId: 22, qty: 3 };
    H.calls = [];
    await pageUp(1100);
    // The exact arguments are the quantity cases' to pin; here only that one buy is in flight.
    expect(
      H.calls.map((c) => c.name),
      'buy: precondition: one buy is in flight',
    ).toEqual(['buy']);
    expect(shop.feedback, 'buy: nothing is painted while pending').toEqual([]);
    opts.store.upsertItemDef(itemDef(22, 'Lure', 70n));
    opts.store.upsertShopItem({ shopItemId: 1n, shopId: 11, itemId: 22, buyPrice: 130n });
    server(1200);
    opts.store.removeShopItem(1n);
    opts.store.removeItemDef(22);
    server(1300);
    await flush();
    expect(shop.feedback, 'buy: still nothing while pending').toEqual([]);
    release();
    await flush();
    expect(shop.feedback, 'buy: the line from the rows at send').toEqual([
      enBought(3, 'Bait', 39n),
    ]);

    // --- sell all 3 Berry at 10: the inventory row goes, the definition is renamed, then removed
    shop.feedback.length = 0;
    release = hold();
    issue.command = { kind: 'sell', itemId: 23, qty: 3 };
    H.calls = [];
    await pageUp(1400);
    expect(
      H.calls.map((c) => c.name),
      'sell: precondition: one sell is in flight',
    ).toEqual(['sell']);
    expect(shop.feedback, 'sell: nothing is painted while pending').toEqual([]);
    opts.store.reconcileInventoryFromView([]);
    opts.store.upsertItemDef(itemDef(23, 'Husk', 1n));
    server(1500);
    opts.store.removeItemDef(23);
    server(1600);
    await flush();
    expect(shop.feedback, 'sell: still nothing while pending').toEqual([]);
    release();
    await flush();
    expect(shop.feedback, 'sell: the line from the rows at send').toEqual([
      enSold(3, 'Berry', 30n),
    ]);
  });
});

describe('main.ts the shop pick command (runtime, ctl-7d)', { sequential: true }, () => {
  afterEach(teardownBoot);

  it('CTL7D-5-BOOT-PICKSHOP: a pickShop command from the dialogue frame sends one dismissDialogue and opens that shop (0, then 4) on the first batch with no conversation, never before; the last pick wins; the greet-then-shop click takes the same path; a non-numeric shop id sends nothing', async () => {
    // WRONG IMPL KILLED: no pickShop arm (nothing sent, no shop), a pick that opens the shop at
    // once over the conversation it ends, one dismiss per pick (the second pick double-sends), a
    // first-pick-wins open (shop 5 instead of 6), a hardcoded or truthiness-guarded id (shops 0
    // and 4 each open as themselves), a click that no longer reaches the open, and a click
    // delegate that lost its non-numeric guard (a NaN pick would send a dismiss and open a shop).
    await bootReady();
    server(1000);
    seedNpcs(1010);
    const dlg: { command: unknown } = { command: { kind: 'pop' } };
    swapAdapter('dialogueView', commandAdapter(dlg));
    const shopReads: unknown[] = [];
    swapAdapter(
      'shopView',
      readingAdapter(shopReads, (ctx) => ctx.shopId),
    );
    const shop = stubView('ShopView');
    let t = 1100;

    /** With the conversation open `pick` runs: one dismiss and no shop yet, not even after a batch
     *  that still has the conversation; the batch that ends it opens the shop, whose stand-in then
     *  reads the bound id; Start closes it. Returns that read. */
    const pickThenOpen = async (
      label: string,
      pick: (at: number) => Promise<void>,
    ): Promise<unknown[]> => {
      startConversation(t);
      expect(stackNow(), `${label}: precondition: the conversation is the top frame`).toEqual([
        WORLD_FRAME,
        screenFrame('dialogueView'),
      ]);
      H.calls = [];
      await pick(t + 10);
      expect(H.calls, `${label}: one dismissDialogue`).toEqual(ONE_DISMISS);
      expect(shop.visible, `${label}: no shop while the conversation is open`).toBe(false);
      server(t + 20);
      expect(shop.visible, `${label}: nor after a batch that still has it`).toBe(false);
      endConversation(t + 30);
      expect(shop.visible, `${label}: the first batch with no conversation opens it`).toBe(true);
      expect(stackNow(), `${label}: the shop frame is the one frame`).toEqual([
        WORLD_FRAME,
        screenFrame('shopView'),
      ]);
      const before = shopReads.length;
      await pageUp(t + 40);
      const read = shopReads.slice(before);
      press('Escape', t + 50);
      expect(stackNow(), `${label}: precondition: Start closed the shop`).toEqual([WORLD_FRAME]);
      t += 100;
      return read;
    };
    const pickShop =
      (shopId: number) =>
      async (at: number): Promise<void> => {
        dlg.command = { kind: 'pickShop', shopId };
        await pageUp(at);
      };

    expect(await pickThenOpen('pickShop 0', pickShop(0)), 'pickShop 0 opens shop 0').toEqual([0]);
    expect(await pickThenOpen('pickShop 4', pickShop(4)), 'pickShop 4 opens shop 4').toEqual([4]);
    expect(
      await pickThenOpen('pickShop 5 then pickShop 6', async (at) => {
        await pickShop(5)(at);
        await pickShop(6)(at + 5);
      }),
      'the last pick wins: shop 6',
    ).toEqual([6]);
    expect(
      await pickThenOpen('a click on data-shop-id 7', async (at) => {
        clickShop(at, '7');
        await flush();
      }),
      'the click takes the same path: shop 7',
    ).toEqual([7]);

    // A non-numeric data-shop-id sends nothing, and leaves no shop to open.
    startConversation(t);
    H.calls = [];
    clickShop(t + 10, 'abc');
    await flush();
    expect(H.calls, 'data-shop-id "abc": nothing is sent').toEqual([]);
    endConversation(t + 20);
    expect(shop.visible, 'data-shop-id "abc": no shop opens when the conversation ends').toBe(
      false,
    );
    expect(stackNow(), 'data-shop-id "abc": the bare world').toEqual([WORLD_FRAME]);
  });

  it('CTL7D-5-BOOT-BATTLE-REFUSED: over a conversation suspended by an Ongoing battle, a pickShop command and a Shop click each send no dismissDialogue, show the battle reason and leave no shop to open; back at the world the same command sends the dismiss', async () => {
    // WRONG IMPL KILLED (the spec's named intentional change): a click delegate that still steps
    // the shop open itself (it sends a dismiss at a battle base, past the policy), a pickShop
    // classified battle-safe, a refusal that reports nothing, one that still records the pick
    // (the shop would open when the conversation later ends), and one that also refuses at the
    // world.
    await bootReady();
    server(1000);
    seedNpcs(1010);
    const dlg: { command: unknown } = { command: { kind: 'pickShop', shopId: 9 } };
    swapAdapter('dialogueView', commandAdapter(dlg));
    const shop = stubView('ShopView');
    const status = document.getElementById('status');
    if (status === null) throw new Error('#status must exist once booted');
    const reason = i18n.t('menu.disabled.inBattle');
    expect(reason, 'fixture: the catalogued reason is real text').not.toBe('');

    startConversation(1100);
    putBattle(BATTLE_ID, 1200);
    expect(stackNow(), 'precondition: the conversation is suspended over the battle').toEqual([
      { kind: 'battle', battleId: '101' },
      screenFrame('dialogueView'),
    ]);

    H.calls = [];
    status.textContent = '';
    const down = await pageUp(1300);
    expect(down.defaultPrevented, 'the command: the routed press is consumed').toBe(true);
    expect(H.calls, 'the command: no dismissDialogue at a battle base').toEqual([]);
    expect(statusText(), 'the command: the battle reason').toBe(reason);

    H.calls = [];
    status.textContent = '';
    clickShop(1400, '9');
    await flush();
    expect(H.calls, 'the click: no dismissDialogue at a battle base').toEqual([]);
    expect(statusText(), 'the click: the battle reason').toBe(reason);

    // The battle ends with the conversation still open, then the conversation ends: nothing was
    // picked, so no shop opens.
    dropBattle(BATTLE_ID, 1500);
    expect(stackNow(), 'precondition: the world again, the conversation on top').toEqual([
      WORLD_FRAME,
      screenFrame('dialogueView'),
    ]);
    endConversation(1600);
    expect(shop.visible, 'the refused picks left no shop to open').toBe(false);
    expect(stackNow(), 'precondition: the conversation ended').toEqual([WORLD_FRAME]);

    // Control: at the world the same command sends the dismiss, and the shop opens.
    startConversation(1700);
    H.calls = [];
    await pageUp(1800);
    expect(H.calls, 'control: at the world the same command sends one dismiss').toEqual(
      ONE_DISMISS,
    );
    endConversation(1900);
    expect(shop.visible, 'control: and the shop opens once the conversation ends').toBe(true);
  });
});

describe('main.ts batches reach observe (runtime, ctl-7d)', { sequential: true }, () => {
  afterEach(teardownBoot);

  it('CTL7D-6-BOOT-OBSERVE: every store batch calls an open frame`s observe once, after the batch`s view renders, from init on the batch that pushed the frame and from the last returned state after it; a new state paints once into the frame`s own view, the same state paints nothing, the next button gets the kept state, and neither a frame without observe nor a closed frame is called', async () => {
    // WRONG IMPL KILLED: no batch observation (adapter code runs only on a button step, so a
    // dialogue adapter could never see its node replaced), an observe placed before the final
    // syncStack or in an earlier listener (the frame this batch pushed is not observed on it, or
    // is observed before its view rendered), an observe that skips init on a fresh frame or asks
    // it again, that drops the returned state (the next observe or the next button gets an older
    // one), that paints on every batch, or never, or into another view, or with another view
    // model, one that runs viewModel / init / paint for an adapter with no observe, and one that
    // keeps observing a closed frame.
    await bootReady();
    server(1000);
    seedNpcs(1010);
    const shop = stubView('ShopView');
    // The dialogue frame's stand-in has no observe: no batch may call any of its methods.
    const dialogueCalls: string[] = [];
    swapAdapter('dialogueView', {
      viewModel: () => {
        dialogueCalls.push('viewModel');
        return undefined;
      },
      init: () => {
        dialogueCalls.push('init');
        return undefined;
      },
      onButton: (_vm: unknown, state: unknown) => {
        dialogueCalls.push('onButton');
        return { state, result: 'consumed' };
      },
      paint: () => {
        dialogueCalls.push('paint');
      },
    });
    const S0 = { state: 'from init' };
    const S1 = { state: 'first' };
    const S2 = { state: 'second' };
    const vms: object[] = [];
    const inits: unknown[] = [];
    const observes: Array<{ vm: unknown; state: unknown; now: unknown; renders: number }> = [];
    const paints: Array<{ view: unknown; vm: unknown; state: unknown }> = [];
    const buttons: Array<{ state: unknown; button: string }> = [];
    let answer: (state: unknown) => unknown = (state) => state;
    swapAdapter('shopView', {
      viewModel: () => {
        const vm = { n: vms.length };
        vms.push(vm);
        return vm;
      },
      init: (vm: unknown) => {
        inits.push(vm);
        return S0;
      },
      observe: (vm: unknown, state: unknown, now: unknown) => {
        observes.push({ vm, state, now, renders: shop.renders.length });
        return answer(state);
      },
      onButton: (_vm: unknown, state: unknown, btn: Pressed) => {
        buttons.push({ state, button: btn.button });
        const closes = btn.button === 'Start' && !btn.repeat;
        return { state, result: closes ? { kind: 'popToBase' } : 'consumed' };
      },
      paint: (view: unknown, vm: unknown, state: unknown) => {
        paints.push({ view, vm, state });
      },
    });

    // The conversation: two batches with the dialogue frame open, and no shop frame yet.
    startConversation(1100);
    server(1150);
    expect(stackNow(), 'precondition: the conversation is the one frame').toEqual([
      WORLD_FRAME,
      screenFrame('dialogueView'),
    ]);
    H.calls = [];
    clickShop(1200, '3');
    expect(H.calls, 'precondition: the Shop click sent the dismiss').toEqual(ONE_DISMISS);
    expect(observes, 'no shop frame yet: nothing is observed').toEqual([]);

    // --- the batch that ends the conversation pushes the shop frame ---------------------------
    const rendersBefore = shop.renders.length;
    answer = () => S1;
    endConversation(1300);
    expect(stackNow(), 'precondition: this batch pushed the shop frame').toEqual([
      WORLD_FRAME,
      screenFrame('shopView'),
    ]);
    expect(observes.length, 'push batch: one observe for the frame').toBe(1);
    const pushed = observes[0];
    expect(inits.length, 'push batch: init ran once').toBe(1);
    expect(inits[0], 'push batch: init got the view model observe got').toBe(pushed?.vm);
    expect(pushed?.state, 'push batch: observe got the state init produced').toBe(S0);
    expect(pushed?.now, 'push batch: now is the clock').toBe(1300);
    expect(shop.renders.length, 'precondition: the batch rendered the shop view').toBeGreaterThan(
      rendersBefore,
    );
    // Observe is last: it saw every render this batch made (one run mid-batch, after the shop
    // open but before the shop listener's render, would see fewer).
    expect(pushed?.renders, 'push batch: observe ran after every view render of the batch').toBe(
      shop.renders.length,
    );
    expect(paints.length, 'push batch: a new state paints once').toBe(1);
    expect(paints[0]?.view, 'push batch: into the view of the frame').toBe(shop);
    expect(paints[0]?.vm, 'push batch: with the view model observe got').toBe(pushed?.vm);
    expect(paints[0]?.state, 'push batch: and the returned state').toBe(S1);

    // --- a batch whose observe returns the same state -----------------------------------------
    answer = (state) => state;
    server(1400);
    expect(observes.length, 'batch 2: one more observe').toBe(2);
    expect(observes[1]?.state, 'batch 2: the state the last observe returned').toBe(S1);
    expect(observes[1]?.now, 'batch 2: now is the clock').toBe(1400);
    expect(observes[1]?.renders, 'batch 2: after the render of the batch').toBe(
      shop.renders.length,
    );
    expect(paints.length, 'batch 2: the same state paints nothing').toBe(1);

    // --- a batch whose observe returns a new state --------------------------------------------
    answer = () => S2;
    server(1500);
    expect(observes.length, 'batch 3: one more observe').toBe(3);
    expect(observes[2]?.state, 'batch 3: still the kept state').toBe(S1);
    expect(paints.length, 'batch 3: a new state paints once').toBe(2);
    expect(paints[1]?.view, 'batch 3: into the view of the frame').toBe(shop);
    expect(paints[1]?.vm, 'batch 3: with the view model observe got').toBe(observes[2]?.vm);
    expect(paints[1]?.state, 'batch 3: and the returned state').toBe(S2);

    answer = (state) => state;
    server(1600);
    expect(observes.length, 'batch 4: one more observe').toBe(4);
    expect(observes[3]?.state, 'batch 4: the state batch 3 returned').toBe(S2);
    expect(paints.length, 'batch 4: no paint').toBe(2);

    // --- the next button gets the kept state, and init is not asked again ---------------------
    await pageUp(1700);
    expect(buttons.length, 'precondition: the press reached the shop frame').toBe(1);
    expect(buttons[0]?.state, 'the button gets the state the last observe returned').toBe(S2);
    expect(inits.length, 'init is not asked again').toBe(1);
    expect(dialogueCalls, 'the dialogue frame (no observe) saw no call from any batch').toEqual([]);

    // --- after the frame closes, a batch calls nothing for it ---------------------------------
    press('Escape', 1800);
    expect(stackNow(), 'precondition: Start closed the shop').toEqual([WORLD_FRAME]);
    const calls = (): unknown => ({
      viewModel: vms.length,
      init: inits.length,
      observe: observes.length,
      paint: paints.length,
    });
    const closed = calls();
    server(1900);
    expect(calls(), 'a batch after the close calls nothing for the closed frame').toEqual(closed);
  });

  it('CTL7D-6-BOOT-EVERY-FRAME: a store batch observes every open frame, not only the top one, bottom first; it still observes over a battle base, and before the player has joined', async () => {
    // WRONG IMPL KILLED (main.ts call-site mutants): a host handed only the top frame (the menu
    // covered by the box would never observe a batch), a walk from the top down (the box before
    // the menu), an observe skipped while the base is a battle (a dialogue the battle suspends
    // would miss the batches that replace its node), and an observe skipped before join
    // (identity '': a frame shown that early would miss every batch until the join).
    const log: Array<{ id: string; now: unknown }> = [];

    // --- before join: no onReady, a stand-in frame shown by its own flag -----------------------
    await boot();
    swapAdapter('boxView', observingAdapter('boxView', log));
    stubView('BoxView').visible = true;
    server(1010);
    expect(stackNow(), 'before join: precondition: the box frame is the one frame').toEqual([
      WORLD_FRAME,
      screenFrame('boxView'),
    ]);
    expect(log, 'before join: the batch observes the frame').toEqual([
      { id: 'boxView', now: 1010 },
    ]);

    // --- two frames at once: the box shown above the open menu ---------------------------------
    teardownBoot();
    await bootReady();
    server(1000);
    for (const id of ['menuView', 'boxView', 'dialogueView']) {
      swapAdapter(id, observingAdapter(id, log));
    }
    openMenuAtWorld(1100);
    stubView('BoxView').visible = true;
    log.length = 0;
    server(1200);
    expect(stackNow(), 'two frames: precondition: the box above the menu').toEqual([
      WORLD_FRAME,
      screenFrame('menuView'),
      screenFrame('boxView'),
    ]);
    expect(log, 'two frames: one batch observes both, bottom first').toEqual([
      { id: 'menuView', now: 1200 },
      { id: 'boxView', now: 1200 },
    ]);
    press('Escape', 1300);
    expect(stackNow(), 'precondition: Start closed both frames').toEqual([WORLD_FRAME]);

    // --- over a battle base: the conversation an Ongoing battle suspends ------------------------
    seedNpcs(1400);
    startConversation(1500);
    expect(stackNow(), 'battle: precondition: the conversation is the one frame').toEqual([
      WORLD_FRAME,
      screenFrame('dialogueView'),
    ]);
    log.length = 0;
    putBattle(BATTLE_ID, 1600);
    expect(stackNow(), 'battle: precondition: the conversation is suspended over it').toEqual([
      { kind: 'battle', battleId: '101' },
      screenFrame('dialogueView'),
    ]);
    expect(log, 'battle: the batch that brought the battle observes the dialogue').toEqual([
      { id: 'dialogueView', now: 1600 },
    ]);
    server(1700);
    expect(log, 'battle: and so does the next batch over the battle base').toEqual([
      { id: 'dialogueView', now: 1600 },
      { id: 'dialogueView', now: 1700 },
    ]);
  });
});

// ==========================================================================================
// ctl-8s: the Social seam (CTL8S.1-3)
// ==========================================================================================
//
// Same harness, one fresh main.ts per case. U, P and L and the menu leaves Social › Trades /
// Challenges / Rankings all go through ONE `openSocial(tab)`: the stack's frame is
// `{ kind: 'screen', id: 'social' }` for each of them (today they open `tradeView`, `pvpView` and
// `leaderboardView` frames: the Red), the tab's own root is the one shown, and `ScreenContext`
// reads the requested tab. The trade and pvp roots are the recording stand-ins (the PvP one shows
// and hides on `refresh(vm, forceVisible)` as the real view does); the leaderboard root is the REAL
// view over the shell's #leaderboard-overlay. A stand-in on the `social` frame records what the
// shell seats, lends and remembers.

/** The REAL leaderboard root, from the mounted shell. */
function boardRoot(): HTMLElement {
  const el = document.getElementById('leaderboard-overlay');
  if (el === null) throw new Error('#leaderboard-overlay must be in the shell');
  return el;
}

/** Which Social roots are shown: the trade and pvp stand-ins by their flags, the REAL leaderboard
 *  root by its display. */
function socialShown(): string[] {
  const shown: string[] = [];
  if (stubView('TradeView').visible) shown.push('trades');
  if (stubView('PvpView').visible) shown.push('challenges');
  if (boardRoot().style.display !== 'none') shown.push('rankings');
  return shown;
}

/** A Pending challenge from another player to the booted one. */
function incomingChallenge(challengeId: bigint): StoreBattleChallenge {
  return {
    challengeId,
    challenger: OTHER_IDENTITY,
    target: H.identity,
    challengerPartyIds: [],
    status: 'Pending',
    createdAtMs: 0n,
  };
}

/** A Pending challenge the booted player sent to another one (nothing incoming). */
function outgoingChallenge(challengeId: bigint): StoreBattleChallenge {
  return {
    challengeId,
    challenger: H.identity,
    target: OTHER_IDENTITY,
    challengerPartyIds: [],
    status: 'Pending',
    createdAtMs: 0n,
  };
}

/** Open the main menu at the world and pick Social › `leaf` with the real menu keys (Down and
 *  Enter). The menu remembers its cursor, so each level is walked with Down until the entry is
 *  active. Returns the clock after the last press. */
function openSocialLeaf(leaf: 'trades' | 'challenges' | 'rankings', t: number): number {
  openMenuAtWorld(t);
  let at = t + 10;
  for (let i = 0; i < 8 && menuCursorNow() !== 'social'; i += 1) {
    press('ArrowDown', at);
    at += 10;
  }
  expect(menuCursorNow(), `${leaf}: precondition: the menu cursor is on Social`).toBe('social');
  press('Enter', at);
  at += 10;
  for (let i = 0; i < 4 && menuCursorNow() !== leaf; i += 1) {
    press('ArrowDown', at);
    at += 10;
  }
  expect(menuCursorNow(), `${leaf}: precondition: the sub-list cursor is on ${leaf}`).toBe(leaf);
  press('Enter', at);
  return at + 10;
}

/** What a memory stand-in saw: each init and what it was handed, each LB step, each paint. */
interface MemoryLog {
  readonly inits: Array<{ readonly remembered: unknown; readonly state: object }>;
  readonly steps: Array<{ readonly state: unknown; readonly next: object }>;
  readonly paints: Array<{ readonly view: unknown; readonly state: unknown }>;
}
const newMemoryLog = (): MemoryLog => ({ inits: [], steps: [], paints: [] });

/** A stand-in adapter that records init's second argument (the remembered state), answers each LB
 *  with a NEW state and paints into the log; B and Start close its frame as the legacy adapter
 *  does. `remember` opts it in to cross-open memory. */
function memoryAdapter(log: MemoryLog, remember: boolean): unknown {
  return {
    ...(remember ? { remember: true } : {}),
    viewModel: () => ({}),
    init: (_vm: unknown, remembered?: unknown) => {
      const state = { n: 0, from: remembered };
      log.inits.push({ remembered, state });
      return state;
    },
    onButton: (_vm: unknown, state: unknown, btn: Pressed) => {
      if (btn.repeat) return { state, result: 'consumed' };
      if (btn.button === 'LB') {
        const prev = state as { readonly n?: number } | undefined;
        const next = { n: (prev?.n ?? -100) + 1 };
        log.steps.push({ state, next });
        return { state: next, result: 'consumed' };
      }
      if (btn.button === 'B') return { state, result: { kind: 'pop' } };
      if (btn.button === 'Start') return { state, result: { kind: 'popToBase' } };
      return { state, result: 'unhandled' };
    },
    paint: (view: unknown, _vm: unknown, state: unknown) => {
      log.paints.push({ view, state });
    },
  };
}

describe('main.ts the Social seam (runtime, ctl-8s)', { sequential: true }, () => {
  afterEach(teardownBoot);

  it('CTL8S-1-BOOT-MEMORY: a Social stand-in that opts in is seated and painted at open with no button or batch, from init(vm, undefined) after the first connect; reopened (through another tab) its init receives the state Social was closed with; a quest-log stand-in that did not opt in starts over on each open; and after the connection`s onReconnect, even with Social open across it, the next open remembers nothing', async () => {
    // WRONG IMPL KILLED: today's shell (opened() forgets every state: the reopen's init sees only
    // the view model); a Social open that does not seat the frame (nothing is painted until the
    // first button, so a remembered tab could not show at open); an open that seats with init(vm)
    // and drops the memory; a memory kept per panel instead of per frame (a reopen through P would
    // not see what U's visit left); a host that remembers for every adapter (the quest log would
    // reopen where it was closed); an onReady that does not forget (a pre-join U leaks into the
    // joined session); and an onReconnect that keeps the memory, or clears it but keeps the open
    // frame's state (the next open would remember the previous identity's screen).
    // --- before join: a pre-join U seeds a state; the first connect forgets it ----------------
    await boot();
    server(1000);
    const social = newMemoryLog();
    swapAdapter('social', memoryAdapter(social, true));
    // ctl-11a: an accelerator opens its path through the main menu, whose screens read store state
    // keyed by identity, so U does nothing before the join. The pre-join Social frame is therefore
    // shown through its own stand-in flag (the trade panel), as CTL7D-6-BOOT-EVERY-FRAME shows a
    // pre-join frame; a batch mirrors it as the one Social frame.
    stubView('TradeView').visible = true;
    server(1005);
    expect(stackNow(), 'pre-join: precondition: the Social frame is on the stack').toEqual([
      WORLD_FRAME,
      screenFrame('social'),
    ]);
    await pageUp(1020);
    expect(social.steps.length, 'pre-join: precondition: the LB press stepped it').toBe(1);
    press('Escape', 1030);
    expect(stackNow(), 'pre-join: precondition: Start closed it').toEqual([WORLD_FRAME]);
    opts.onReady(H.identity);

    // --- joined: the open seats the frame and paints it, with no button and no batch ----------
    const at = {
      inits: social.inits.length,
      steps: social.steps.length,
      paints: social.paints.length,
    };
    // ctl-11a: U opens Social over the main menu (Social > Trades).
    press('KeyU', 1100);
    expect(stackNow(), 'precondition: U opened the Social frame').toEqual(SOCIAL_OVER_MENU);
    expect(social.inits.length - at.inits, 'the open seats the frame: one init').toBe(1);
    const first = social.inits.at(-1);
    expect(first?.remembered, 'the first connect forgot the pre-join state').toBeUndefined();
    expect(social.steps.length, 'no button reached it').toBe(at.steps);
    expect(social.paints.length - at.paints, 'painted once at open').toBe(1);
    expect(social.paints.at(-1)?.state, 'with the state init returned').toBe(first?.state);

    // --- a step, a close, and a reopen through another tab: init receives that state ----------
    await pageUp(1200);
    const closedWith = social.steps.at(-1)?.next;
    expect(social.steps.at(-1)?.state, 'precondition: the LB press stepped the seated state').toBe(
      first?.state,
    );
    press('KeyU', 1300);
    expect(stackNow(), 'precondition: the same key (acting as Start) closed Social').toEqual([
      WORLD_FRAME,
    ]);
    press('KeyP', 1400);
    expect(stackNow(), 'precondition: P opened the same Social frame').toEqual(SOCIAL_OVER_MENU);
    const reopened = social.inits.at(-1);
    expect(social.inits.length - at.inits, 'one more init, for the reopen').toBe(2);
    expect(
      reopened?.remembered,
      'the reopen`s init receives the state Social was closed with',
    ).toBe(closedWith);
    expect(social.paints.at(-1)?.state, 'and paints what init returned').toBe(reopened?.state);
    await pageUp(1500);
    const beforeReconnect = social.steps.at(-1)?.next;
    press('KeyP', 1600);
    expect(stackNow(), 'precondition: the same key (acting as Start) closed Social').toEqual([
      WORLD_FRAME,
    ]);

    // --- a frame that did not opt in starts over on each open ---------------------------------
    const quest = newMemoryLog();
    swapAdapter('questLogView', memoryAdapter(quest, false));
    let opens = 0;
    // ctl-11a: the quest log is opened by J (Q is LB now), over the main menu, and J over its own
    // screen acts as Start (the stand-in answers Start with popToBase), closing both.
    for (const t of [1700, 1900]) {
      press('KeyJ', t);
      expect(stackNow(), `quest log ${opens}: precondition: opened`).toEqual([
        WORLD_FRAME,
        screenFrame('menuView'),
        screenFrame('questLogView'),
      ]);
      await pageUp(t + 10);
      press('KeyJ', t + 20);
      expect(stackNow(), `quest log ${opens}: precondition: closed`).toEqual([WORLD_FRAME]);
      opens += 1;
    }
    expect(
      quest.inits.map((i) => i.remembered),
      'the quest log (not opted in) starts each open from init(vm, undefined)',
    ).toEqual([undefined, undefined]);
    expect(quest.steps.length, 'ANTI-VACUITY: one LB per open').toBe(2);
    for (const [i, step] of quest.steps.entries()) {
      expect(step.state, `quest log open ${i}: the LB steps from that open's own init`).toBe(
        quest.inits[i]?.state,
      );
    }

    // --- a reconnect clears the memory, even with Social open and holding a state --------------
    press('KeyU', 2100);
    expect(stackNow()).toEqual(SOCIAL_OVER_MENU);
    expect(
      social.inits.at(-1)?.remembered,
      'precondition: this open remembered the last close',
    ).toBe(beforeReconnect);
    await pageUp(2110);
    expect(social.steps.at(-1)?.state, 'precondition: the open frame holds a state').toBe(
      social.inits.at(-1)?.state,
    );
    opts.onReconnect(H.identity);
    press('KeyU', 2200);
    expect(stackNow(), 'precondition: U opened Social after the reconnect').toEqual(
      SOCIAL_OVER_MENU,
    );
    expect(
      social.inits.at(-1)?.remembered,
      'after the reconnect the open remembers nothing',
    ).toBeUndefined();
  });

  it('CTL8S-2-BOOT-SOCIAL-TAB: ScreenContext.socialTab reads null before any open, then trades, challenges and rankings after U, P and L and after each of the three menu leaves, and challenges after the challenge auto-show, already in the open`s own init; it keeps its value after Social closes and reads null after a reconnect', async () => {
    // WRONG IMPL KILLED: no socialTab on the context (every read undefined); a value snapshotted
    // into the context at boot instead of a live getter (null forever); a tab bound AFTER the frame
    // is seated (the open's own init reads the previous tab); an open path that binds a fixed tab or
    // none (P, L, a menu leaf or the auto-show reading what the last U bound); a close that clears
    // the tab (the menu would read null after Social closes); and a reconnect that keeps it. Each
    // open below binds a tab different from the one bound before it.
    await bootReady();
    server(1000);
    const menuReads: unknown[] = [];
    swapAdapter(
      'menuView',
      readingAdapter(menuReads, (ctx) => ctx.socialTab),
    );
    const seatReads: unknown[] = [];
    const reads: unknown[] = [];
    swapAdapter('social', {
      viewModel: (ctx: CtxRead) => ctx.socialTab,
      init: (vm: unknown) => {
        seatReads.push(vm);
        return undefined;
      },
      onButton: (vm: unknown, state: unknown, btn: Pressed) => {
        if (btn.repeat) return { state, result: 'consumed' };
        if (btn.button === 'LB') {
          reads.push(vm);
          return { state, result: 'consumed' };
        }
        if (btn.button === 'B') return { state, result: { kind: 'pop' } };
        if (btn.button === 'Start') return { state, result: { kind: 'popToBase' } };
        return { state, result: 'unhandled' };
      },
    });

    await readAtMenu(1100);
    expect(menuReads, 'before any Social open: null').toEqual([null]);

    let t = 1200;
    /** Social is open on `tab`: its open's init and an LB read it; `close` shuts it; the menu reads
     *  it again afterwards. */
    const expectTab = async (
      label: string,
      tab: string,
      close: (at: number) => void,
    ): Promise<void> => {
      expect(stackNow(), `${label}: precondition: the Social frame is open`).toContainEqual(
        screenFrame('social'),
      );
      expect(seatReads.at(-1), `${label}: the open's own init already reads ${tab}`).toBe(tab);
      await pageUp(t + 10);
      expect(reads.at(-1), `${label}: a read on the open frame`).toBe(tab);
      close(t + 20);
      expect(stackNow(), `${label}: precondition: Social closed`).toEqual([WORLD_FRAME]);
      await readAtMenu(t + 30);
      expect(menuReads.at(-1), `${label}: it keeps its value after Social closes`).toBe(tab);
      t += 100;
    };

    const keys = [
      ['KeyU', 'trades'],
      ['KeyP', 'challenges'],
      ['KeyL', 'rankings'],
    ] as const;
    for (const [code, tab] of keys) {
      press(code, t);
      await expectTab(code, tab, (at) => void press(code, at));
    }
    for (const leaf of ['trades', 'challenges', 'rankings'] as const) {
      t = openSocialLeaf(leaf, t);
      await expectTab(`menu Social > ${leaf}`, leaf, (at) => void press('Escape', at));
    }

    // The challenge auto-show binds challenges (rankings was the last tab bound).
    opts.store.upsertChallenge(incomingChallenge(41n));
    server(t);
    expect(stackNow(), 'auto-show: precondition: the challenge opened Social').toEqual([
      WORLD_FRAME,
      screenFrame('social'),
    ]);
    expect(seatReads.at(-1), 'auto-show: the open`s own init reads challenges').toBe('challenges');
    await pageUp(t + 10);
    expect(reads.at(-1), 'auto-show: a read on the open frame').toBe('challenges');
    opts.store.removeChallenge(41n);
    server(t + 20);
    press('KeyP', t + 30);
    expect(stackNow(), 'auto-show: precondition: P closed Social').toEqual([WORLD_FRAME]);
    await readAtMenu(t + 40);
    expect(menuReads.at(-1), 'auto-show: it keeps its value after Social closes').toBe(
      'challenges',
    );

    // A reconnect clears it.
    opts.onReconnect(H.identity);
    await readAtMenu(t + 100);
    expect(menuReads.at(-1), 'after a reconnect: null').toBe(null);

    expect(menuReads, 'every menu read, in order').toEqual([
      null,
      'trades',
      'challenges',
      'rankings',
      'trades',
      'challenges',
      'rankings',
      'challenges',
      null,
    ]);
    expect(reads, 'every read on the open Social frame, in order').toEqual([
      'trades',
      'challenges',
      'rankings',
      'trades',
      'challenges',
      'rankings',
      'challenges',
    ]);
    expect(seatReads, 'ANTI-VACUITY: one seat per open, seven opens').toHaveLength(7);
  });

  it('CTL8S-3-BOOT-ONE-FRAME: U, P, L and the three menu leaves each put the ONE frame { kind: screen, id: social } on the stack (over the menu) with only that tab`s root shown; the same key closes it; a different social key while a panel shows closes it too (the Social frame is its own screen: the key acts as Start); and a battle arriving closes whichever panel shows and leaves the battle base', async () => {
    // ctl-11a (named intentional change): an accelerator opens its path over the main menu, so the
    // frame sits above `menuView`; and the Social keys are no longer refused over each other: with
    // Social on top any of U, P and L is "pressed with its own frame on top" and acts as Start.
    // Was: [world, social], and "a different social key while a panel shows changes nothing".
    // WRONG IMPL KILLED: today's three frames (`tradeView`, `pvpView` and `leaderboardView` on
    // `__game().stack`); an open that shows two roots (the previous panel left painted under the
    // new one); a social key that switches the panel or does nothing while another one shows (P over
    // the trade root must close the frame, as Start does); a same key that no longer closes; a menu
    // leaf that opens a frame of its own or closes the menu under it; and a battle drop that pops
    // the Social frame but leaves its panel painted under the battle.
    await bootReady();
    server(1000);
    const SOCIAL_STACK = SOCIAL_OVER_MENU;
    const keys = [
      ['KeyU', 'trades'],
      ['KeyP', 'challenges'],
      ['KeyL', 'rankings'],
    ] as const;
    let t = 1100;

    // Each key opens the one Social frame on its own root, and closes it again.
    for (const [code, tab] of keys) {
      press(code, t);
      expect(stackNow(), `${code}: the one Social frame`).toEqual(SOCIAL_STACK);
      expect(socialShown(), `${code}: only the ${tab} root is shown`).toEqual([tab]);
      press(code, t + 10);
      expect(stackNow(), `${code} again: Social closed`).toEqual([WORLD_FRAME]);
      expect(socialShown(), `${code} again: no root is shown`).toEqual([]);
      t += 100;
    }

    // A different social key while a panel shows closes the frame (ctl-11a: it is pressed with its
    // own frame on top, so it acts as Start; it does not switch panels and is not refused).
    let pairs = 0;
    for (const [openCode, openTab] of keys) {
      for (const [otherCode] of keys) {
        if (otherCode === openCode) continue;
        const label = `${otherCode} over ${openTab}`;
        press(openCode, t);
        expect(stackNow(), `${label}: precondition: the Social frame is open`).toEqual(
          SOCIAL_STACK,
        );
        expect(socialShown(), `${label}: precondition`).toEqual([openTab]);
        press(otherCode, t + 10);
        expect(stackNow(), `${label}: acts as Start: the bare world`).toEqual([WORLD_FRAME]);
        expect(socialShown(), `${label}: no root is left shown`).toEqual([]);
        pairs += 1;
        t += 100;
      }
    }
    expect(pairs, 'ANTI-VACUITY: six ordered pairs').toBe(6);

    // The three menu leaves open the same frame, above the menu.
    for (const [, tab] of keys) {
      t = openSocialLeaf(tab, t);
      expect(stackNow(), `menu Social > ${tab}: the one Social frame above the menu`).toEqual([
        WORLD_FRAME,
        screenFrame('menuView'),
        screenFrame('social'),
      ]);
      expect(socialShown(), `menu Social > ${tab}: only the ${tab} root`).toEqual([tab]);
      press('Escape', t);
      expect(stackNow(), `menu Social > ${tab}: Start closed both`).toEqual([WORLD_FRAME]);
      expect(socialShown()).toEqual([]);
      t += 100;
    }

    // A battle arriving closes whichever panel shows.
    let battleId = BATTLE_ID;
    for (const [code, tab] of keys) {
      press(code, t);
      expect(socialShown(), `${tab}: precondition: shown`).toEqual([tab]);
      putBattle(battleId, t + 10);
      expect(stackNow(), `${tab}: the battle leaves only its base`).toEqual([
        { kind: 'battle', battleId: battleId.toString() },
      ]);
      expect(socialShown(), `${tab}: and its root is hidden`).toEqual([]);
      dropBattle(battleId, t + 20);
      expect(stackNow(), `${tab}: precondition: the world again`).toEqual([WORLD_FRAME]);
      battleId += 1n;
      t += 100;
    }
  });

  it('CTL8S-3-BOOT-PANELS: the Social frame`s adapter is lent a composite whose trades, challenges and rankings are the three view instances and whose chrome is one element; show(pvpView), show(leaderboardView), show(tradeView) each leave exactly that root shown, the chrome hosted by it, the stack and the adapter`s state untouched; a show of the shown panel re-renders and re-hosts nothing; and a show while another frame covers Social, or with Social closed, does nothing', async () => {
    // WRONG IMPL KILLED: a composite naming the wrong instance (a copy-pasted thunk lending the pvp
    // view as trades); a show that leaves the previous root painted (two dialogs at once); one that
    // pops and re-pushes the Social frame (the next button inits the adapter again: a tab switch
    // would reset the screen); one that does not move the chrome (a tab strip stays on a hidden
    // panel); one that re-renders the shown panel (a cursor or focus inside it is lost on every
    // paint); one that switches panels under a frame that covers Social (a dialog opened beneath
    // the claim overlay inverts the a11y stack); and one that opens a panel when Social is closed.
    await bootReady();
    server(1000);
    const { LeaderboardView } = await import('./ui/leaderboardView');
    const trade = stubView('TradeView');
    const pvp = stubView('PvpView');
    const lent: unknown[] = [];
    const inits: object[] = [];
    const steps: Array<{ readonly state: unknown; readonly next: object }> = [];
    swapAdapter('social', {
      viewModel: () => ({}),
      init: () => {
        const state = { n: 0 };
        inits.push(state);
        return state;
      },
      onButton: (_vm: unknown, state: unknown, btn: Pressed) => {
        if (btn.button === 'LB' && !btn.repeat) {
          const next = { n: ((state as { n?: number } | undefined)?.n ?? -100) + 1 };
          steps.push({ state, next });
          return { state: next, result: 'consumed' };
        }
        const closes = btn.button === 'Start' && !btn.repeat;
        return { state, result: closes ? { kind: 'popToBase' } : 'consumed' };
      },
      paint: (view: unknown) => {
        lent.push(view);
      },
    });
    // ctl-11a: U opens Social over the main menu, so every stack below carries `menuView` beneath it
    // (was [world, social]); Start (the stand-in's popToBase) closes both.
    const SOCIAL_STACK = SOCIAL_OVER_MENU;

    press('KeyU', 1100);
    expect(stackNow(), 'precondition: U opened the Social frame').toEqual(SOCIAL_STACK);
    await pageUp(1110);
    const view = lent.at(-1) as SocialFrameView | undefined;
    if (view === undefined) throw new Error('precondition: the Social frame painted its view');
    const kept = steps.at(-1)?.next;
    expect(kept, 'precondition: the LB press stepped the adapter').toBeDefined();
    expect(inits.length, 'precondition: one init').toBe(1);
    expect(view.trades, 'trades is the TradeView main.ts built').toBe(trade);
    expect(view.challenges, 'challenges is the PvpView main.ts built').toBe(pvp);
    expect(view.rankings, 'rankings is a real LeaderboardView').toBeInstanceOf(LeaderboardView);
    expect(view.chrome, 'one chrome element').toBeInstanceOf(HTMLElement);
    expect(trade.hosted.at(-1), 'U hosted the chrome in the trade root').toBe(view.chrome);
    expect(socialShown(), 'precondition: the trade root shows').toEqual(['trades']);

    // Each switch: that root alone, the chrome hosted by it, no stack edge, the state untouched.
    const switches: ReadonlyArray<readonly [SocialPanelId, string]> = [
      ['pvpView', 'challenges'],
      ['leaderboardView', 'rankings'],
      ['tradeView', 'trades'],
    ];
    let switched = 0;
    for (const [panel, tab] of switches) {
      const stub = panel === 'pvpView' ? pvp : trade;
      const hostedBefore = stub.hosted.length;
      view.show(panel);
      expect(socialShown(), `show(${panel}): that root alone`).toEqual([tab]);
      expect(stackNow(), `show(${panel}): the stack is unchanged`).toEqual(SOCIAL_STACK);
      if (panel === 'leaderboardView') {
        expect(boardRoot().firstElementChild, 'the chrome is the board root`s first child').toBe(
          view.chrome,
        );
        expect(view.rankings?.visible, 'the lent board is the one on screen').toBe(true);
      } else {
        expect(stub.hosted.length, `show(${panel}): the panel hosted the chrome once`).toBe(
          hostedBefore + 1,
        );
        expect(stub.hosted.at(-1), `show(${panel}): the chrome hosted by it`).toBe(view.chrome);
      }
      switched += 1;
    }
    expect(switched, 'ANTI-VACUITY: three switches').toBe(3);
    await pageUp(1200);
    expect(
      steps.at(-1)?.state,
      'the next button steps from the state kept before the switches',
    ).toBe(kept);
    expect(inits.length, 'the adapter was never initialised again').toBe(1);

    // A show of the panel already shown re-renders and re-hosts nothing.
    const tradeRenders = trade.renders.length;
    const tradeHosted = trade.hosted.length;
    view.show('tradeView');
    expect(trade.renders.length, 'the shown trade panel is not rendered again').toBe(tradeRenders);
    expect(trade.hosted.length, 'nor re-hosted').toBe(tradeHosted);
    expect(socialShown()).toEqual(['trades']);
    view.show('pvpView');
    const pvpRenders = pvp.renders.length;
    const pvpHosted = pvp.hosted.length;
    view.show('pvpView');
    expect(pvp.renders.length, 'the shown pvp panel is not refreshed again').toBe(pvpRenders);
    expect(pvp.hosted.length, 'nor re-hosted').toBe(pvpHosted);
    view.show('leaderboardView');
    const boardRow = document.getElementById('leaderboard-list')?.firstElementChild;
    expect(boardRow, 'precondition: the board rendered a row').toBeInstanceOf(HTMLElement);
    view.show('leaderboardView');
    expect(
      document.getElementById('leaderboard-list')?.firstElementChild,
      'the shown board is not rendered again',
    ).toBe(boardRow);
    expect(boardRoot().firstElementChild, 'the chrome stays first').toBe(view.chrome);
    expect(socialShown()).toEqual(['rankings']);

    // Covered by another frame, Social does not switch.
    view.show('tradeView');
    expect(socialShown(), 'precondition: the trade root shows').toEqual(['trades']);
    stubView('ClaimView').visible = true;
    server(1300);
    expect(stackNow(), 'precondition: the claim frame covers Social').toEqual([
      ...SOCIAL_STACK,
      screenFrame('claimView'),
    ]);
    const forcedBefore = pvp.forced.length;
    view.show('pvpView');
    expect(socialShown(), 'covered: nothing switched').toEqual(['trades']);
    expect(pvp.forced.length, 'covered: the pvp panel was not refreshed').toBe(forcedBefore);
    expect(stackNow()).toEqual([...SOCIAL_STACK, screenFrame('claimView')]);
    stubView('ClaimView').visible = false;
    server(1400);
    expect(stackNow(), 'precondition: the claim frame closed').toEqual(SOCIAL_STACK);
    view.show('pvpView');
    expect(socialShown(), 'control: on top again, it switches').toEqual(['challenges']);

    // Social closed: a show opens nothing.
    press('Escape', 1500);
    expect(stackNow(), 'precondition: Start closed Social').toEqual([WORLD_FRAME]);
    expect(socialShown()).toEqual([]);
    view.show('leaderboardView');
    expect(socialShown(), 'closed: a show opens nothing').toEqual([]);
    expect(stackNow()).toEqual([WORLD_FRAME]);
  });

  it('CTL8S-3-BOOT-AUTO-SHOW: a pending challenge the player SENT (outgoing only, nothing incoming) never opens Social; an incoming challenge does not open Social while the quest log is open, nor over an Ongoing battle (also in the batch that brings it), and opens Social on Challenges (the pvp root alone, socialTab challenges) on the first batch with no overlay open and a world base', async () => {
    // WRONG IMPL KILLED: today's auto-show (it pushes a `pvpView` frame of its own); an auto-show
    // that fires over another overlay (two dialogs) or over an Ongoing battle (a challenge dialog
    // over the fight; today the only guard is whether the battle VIEW is visible, never the stack's
    // base, and this harness's battle stand-in never shows); one that opens Social on the trade or
    // leaderboard root; and one that does not bind the tab (Social would open on what U last
    // bound).
    // ctl-8s round 2, WRONG IMPL KILLED (a measured round-1 survivor, pinned here): the auto-show
    // condition widened from `vm.incoming !== null` to `vm.incoming !== null || vm.outgoing !==
    // null` (the player's OWN pending challenge would pop the Challenges dialog over the world on
    // the next batch, every batch until it is answered).
    await bootReady();
    server(1000);
    const seatReads: unknown[] = [];
    swapAdapter('social', {
      viewModel: (ctx: CtxRead) => ctx.socialTab,
      init: (vm: unknown) => {
        seatReads.push(vm);
        return undefined;
      },
      onButton: (_vm: unknown, state: unknown, btn: Pressed) => ({
        state,
        result: btn.button === 'Start' && !btn.repeat ? { kind: 'popToBase' } : 'consumed',
      }),
    });

    // Not for a challenge the player sent: nothing open, a world base, an outgoing one only.
    expect(stackNow(), 'outgoing: precondition: nothing open over the world').toEqual([
      WORLD_FRAME,
    ]);
    opts.store.upsertChallenge(outgoingChallenge(50n));
    server(1050);
    expect(
      opts.store.allChallenges().map((c) => [c.challengeId, c.challenger, c.target, c.status]),
      'outgoing: precondition: the batch carried the player`s own pending challenge, and no other',
    ).toEqual([[50n, H.identity, OTHER_IDENTITY, 'Pending']]);
    expect(stackNow(), 'outgoing: no Social frame').toEqual([WORLD_FRAME]);
    expect(socialShown(), 'outgoing: no Social root shown').toEqual([]);
    expect(seatReads, 'outgoing: nothing was seated').toEqual([]);
    server(1060);
    expect(stackNow(), 'outgoing: nor on the next batch').toEqual([WORLD_FRAME]);
    expect(socialShown()).toEqual([]);
    opts.store.removeChallenge(50n);

    // Not while the quest log is open. ctl-11a: it is opened by J (Q is LB now), over the main menu,
    // and J over its own screen acts as Start (closes both). The menu being open is one more reason
    // the auto-show holds back; the quest log is still the overlay the case is about.
    press('KeyJ', 1100);
    expect(stackNow(), 'quest log: precondition').toEqual([
      WORLD_FRAME,
      screenFrame('menuView'),
      screenFrame('questLogView'),
    ]);
    opts.store.upsertChallenge(incomingChallenge(51n));
    server(1200);
    expect(stackNow(), 'quest log: no Social over it').toEqual([
      WORLD_FRAME,
      screenFrame('menuView'),
      screenFrame('questLogView'),
    ]);
    expect(socialShown(), 'quest log: no Social root shown').toEqual([]);
    press('KeyJ', 1300);
    expect(stackNow(), 'quest log: precondition: closed').toEqual([WORLD_FRAME]);

    // The overlay guard on its own, with no menu open (ctl-11a: the quest log above now always has
    // the menu beneath it, which would hold the auto-show back by itself): a stand-in frame shown by
    // its flag, then closed with the challenge withdrawn so no batch opens Social under it.
    const boxStandIn = stubView('BoxView');
    boxStandIn.visible = true;
    server(1320);
    expect(stackNow(), 'overlay: precondition: the box frame is the only one').toEqual([
      WORLD_FRAME,
      screenFrame('boxView'),
    ]);
    expect(socialShown(), 'overlay: no Social root shown over it').toEqual([]);
    opts.store.removeChallenge(51n);
    boxStandIn.visible = false;
    server(1340);
    expect(stackNow(), 'overlay: precondition: closed, nothing pending').toEqual([WORLD_FRAME]);
    opts.store.upsertChallenge(incomingChallenge(51n)); // pending again, in the battle's own batch

    // Not over an Ongoing battle: the challenge is still pending in the batch that brings it.
    putBattle(BATTLE_ID, 1400);
    expect(stackNow(), 'battle: no Social over it').toEqual([{ kind: 'battle', battleId: '101' }]);
    expect(socialShown(), 'battle: no Social root shown').toEqual([]);
    server(1450);
    expect(stackNow(), 'battle: nor on the next batch').toEqual([
      { kind: 'battle', battleId: '101' },
    ]);
    expect(socialShown()).toEqual([]);

    // The battle ends: the first batch with no overlay and a world base opens Social on Challenges.
    dropBattle(BATTLE_ID, 1500);
    expect(stackNow(), 'world: the one Social frame').toEqual([WORLD_FRAME, screenFrame('social')]);
    expect(socialShown(), 'world: the pvp root alone').toEqual(['challenges']);
    expect(seatReads.at(-1), 'world: the requested tab is challenges').toBe('challenges');
  });

  it('CTL8S-3-BOOT-NESTED-RENDERS: Social > Challenges opened from the menu shows the pvp root above the menu, and a store batch keeps it shown, refreshed with forceVisible true', async () => {
    // WRONG IMPL KILLED: today's pvp listener (`forceVisible` is false whenever another overlay
    // shows, and the main menu beneath Social counts: the next batch hides the panel the player
    // just opened); a listener that keeps it shown but stops refreshing it (its rows go stale); and
    // one that refreshes it twice per batch.
    await bootReady();
    server(1000);
    const pvp = stubView('PvpView');
    const t = openSocialLeaf('challenges', 1100);
    expect(pvp.visible, 'precondition: Challenges opened above the menu').toBe(true);
    const forcedBefore = pvp.forced.length;
    server(t + 100);
    expect(pvp.visible, 'the batch keeps the nested Challenges panel shown').toBe(true);
    expect(
      pvp.forced.slice(forcedBefore),
      'refreshed once by the batch, with forceVisible true',
    ).toEqual([true]);
    expect(stackNow(), 'Social stays above the menu').toEqual([
      WORLD_FRAME,
      screenFrame('menuView'),
      screenFrame('social'),
    ]);
    expect(socialShown()).toEqual(['challenges']);
  });

  it('CTL8S-3-BOOT-HOTKEY-AFTER-SWITCH: after the Social adapter switched the shown panel through its lent view, every Social key closes the frame (the key of the panel now shown, the key whose tab the open bound, or the third one: the Social frame is on top, so the key acts as Start), with the shown root, socialTab and the adapter`s seat untouched until it closes; every such keydown is consumed; and while another frame covers Social a Social key replaces the covering frame and Social with its own tab`s path', async () => {
    // ctl-11a (named intentional change): an accelerator pressed with its own frame on top acts as
    // Start, and the Social frame is the own frame of U, P and L alike, so the "key of the shown
    // panel / key that opened it" rule and the "any other Social key changes nothing" arm are
    // retired: all three keys close it. And an accelerator replaces whatever screen is open, so
    // under the claim frame that covers Social a Social key no longer does nothing: it pops claim,
    // Social and menu to the base and opens its own tab. Every stack gains the menu beneath Social.
    // WRONG IMPL KILLED: today's rule, where only the key of the SHOWN panel may close (U opened
    // Trades, the adapter switched to Challenges, and U is now refused by the trade panel's own
    // verdict over the pvp root: the key that opened the frame no longer closes it, the Red; the
    // same for L after Rankings switched to Trades); the opposite rule, where only the bound key
    // closes (P on the switched-to pvp panel would do nothing); a "third key does nothing" rule
    // (L over a pvp panel U opened); a third key that switches the panel or rebinds the requested
    // tab (`openSocial` re-run for it, the socialTab check below); a replace under the covering
    // frame that leaves the claim frame up, opens the wrong tab or keeps the old binding; and a
    // branch that drops `preventDefault` on a key it handles.
    await bootReady();
    server(1000);
    const views: SocialFrameView[] = [];
    const ctxs: CtxRead[] = [];
    let inits = 0;
    swapAdapter('social', {
      viewModel: (ctx: CtxRead) => {
        ctxs.push(ctx);
        return undefined;
      },
      init: () => {
        inits += 1;
        return { n: inits };
      },
      onButton: (_vm: unknown, state: unknown, btn: Pressed) => ({
        state,
        result: btn.button === 'Start' && !btn.repeat ? { kind: 'popToBase' } : 'consumed',
      }),
      paint: (view: unknown) => {
        views.push(view as SocialFrameView);
      },
    });
    const SOCIAL_STACK = SOCIAL_OVER_MENU;
    const TAB_OF: Readonly<Record<SocialPanelId, string>> = {
      tradeView: 'trades',
      pvpView: 'challenges',
      leaderboardView: 'rankings',
    };
    /** The requested tab, read live through a context the stand-in was handed. */
    const socialTabNow = (): unknown => ctxs.at(-1)?.socialTab;
    const keydowns: KeyboardEvent[] = [];
    const key = (code: string, at: number): void => {
      keydowns.push(press(code, at));
    };
    /** Open Social with `code`, then switch to `panel` through the view the open painted. */
    const openThenSwitch = (code: string, tab: string, panel: SocialPanelId, at: number): void => {
      key(code, at);
      expect(stackNow(), `${code}: precondition: the Social frame opened`).toEqual(SOCIAL_STACK);
      expect(socialTabNow(), `${code}: precondition: the open bound ${tab}`).toBe(tab);
      const view = views.at(-1);
      if (view === undefined) throw new Error(`${code}: precondition: the open painted its view`);
      view.show(panel);
      expect(socialShown(), `${code}, show(${panel}): precondition: that root alone`).toEqual([
        TAB_OF[panel],
      ]);
      expect(stackNow(), `${code}, show(${panel}): precondition: the same frame`).toEqual(
        SOCIAL_STACK,
      );
    };
    let t = 1100;

    // (1) The key that opened it: U opened Trades, the adapter showed Challenges, U closes Social.
    openThenSwitch('KeyU', 'trades', 'pvpView', t);
    key('KeyU', t + 10);
    expect(stackNow(), 'U after the switch to Challenges: the opening key closes Social').toEqual([
      WORLD_FRAME,
    ]);
    expect(socialShown(), 'U after the switch: no root is left shown').toEqual([]);
    t += 100;

    // (2) The key of the panel now shown: P closes the Social frame U opened.
    openThenSwitch('KeyU', 'trades', 'pvpView', t);
    key('KeyP', t + 10);
    expect(stackNow(), 'P on the shown Challenges panel: closes Social').toEqual([WORLD_FRAME]);
    expect(socialShown(), 'P: no root is left shown').toEqual([]);
    t += 100;

    // (3) Neither: L over the Challenges panel U opened closes it too (was: changes nothing), and
    // it neither rebinds socialTab nor seats the frame again on the way.
    openThenSwitch('KeyU', 'trades', 'pvpView', t);
    const initsBefore = inits;
    key('KeyL', t + 10);
    expect(stackNow(), 'L (neither key): acts as Start').toEqual([WORLD_FRAME]);
    expect(socialShown(), 'L: no root is left shown').toEqual([]);
    expect(socialTabNow(), 'L: socialTab is not rebound').toBe('trades');
    expect(inits, 'L: the frame is not seated again').toBe(initsBefore);
    t += 100;

    // (4) L opened Rankings, the adapter showed Trades: P (neither key) closes it, and so does L.
    openThenSwitch('KeyL', 'rankings', 'tradeView', t);
    key('KeyP', t + 10);
    expect(stackNow(), 'P over Trades opened by L: acts as Start').toEqual([WORLD_FRAME]);
    expect(socialShown(), 'P: no root is left shown').toEqual([]);
    expect(socialTabNow(), 'P: socialTab is not rebound').toBe('rankings');
    t += 100;
    openThenSwitch('KeyL', 'rankings', 'tradeView', t);
    key('KeyL', t + 10);
    expect(stackNow(), 'L after the switch to Trades: the opening key closes Social').toEqual([
      WORLD_FRAME,
    ]);
    expect(socialShown(), 'L after the switch: no root is left shown').toEqual([]);
    t += 100;

    // (5) Control, no switch: P opens Challenges, and U over it closes it (it used to do nothing).
    key('KeyP', t);
    expect(stackNow(), 'control: P opened Social').toEqual(SOCIAL_STACK);
    expect(socialShown(), 'control: on Challenges').toEqual(['challenges']);
    key('KeyU', t + 10);
    expect(stackNow(), 'control: U over Challenges opened by P: acts as Start').toEqual([
      WORLD_FRAME,
    ]);
    expect(socialShown(), 'control: no root is left shown').toEqual([]);
    expect(socialTabNow(), 'control: U rebound nothing').toBe('challenges');
    t += 100;

    // (6) Covered: the claim frame above Social. An accelerator replaces whatever screen is open,
    // so each Social key pops claim, Social and the menu to the base and opens ITS OWN tab afresh
    // (it used to close nothing and switch nothing).
    const tabOfKey = [
      ['KeyU', 'trades'],
      ['KeyP', 'challenges'],
      ['KeyL', 'rankings'],
    ] as const;
    let replaced = 0;
    for (const [code, tab] of tabOfKey) {
      openThenSwitch('KeyU', 'trades', 'pvpView', t);
      stubView('ClaimView').visible = true;
      server(t + 10);
      const COVERED = [...SOCIAL_STACK, screenFrame('claimView')];
      expect(stackNow(), `covered ${code}: precondition: the claim frame covers Social`).toEqual(
        COVERED,
      );
      key(code, t + 20);
      expect(stackNow(), `covered: ${code} opens Social afresh over the menu`).toEqual(
        SOCIAL_STACK,
      );
      expect(stubView('ClaimView').visible, `covered: ${code} closed the claim frame`).toBe(false);
      expect(socialShown(), `covered: ${code} shows its own ${tab} root`).toEqual([tab]);
      expect(socialTabNow(), `covered: ${code} binds ${tab}`).toBe(tab);
      key(code, t + 30);
      expect(stackNow(), `covered: ${code} again acts as Start`).toEqual([WORLD_FRAME]);
      replaced += 1;
      t += 100;
    }
    expect(replaced, 'ANTI-VACUITY: three covered presses').toBe(3);

    // Every Social keydown above, closing or replacing, was consumed.
    expect(keydowns.length, 'ANTI-VACUITY: twenty-one Social keydowns').toBe(21);
    expect(
      keydowns.filter((e) => !e.defaultPrevented).map((e) => e.code),
      'every Social keydown is consumed',
    ).toEqual([]);
  });
});

// ==========================================================================================
// ctl-10a: healing happens only at a bound healer (CTL10A.4)
// ==========================================================================================

describe('main.ts no Box heal (runtime, ctl-10a)', { sequential: true }, () => {
  afterEach(teardownBoot);

  it('CTL10A-4-NO-BOX-HEAL-HANDLER: the BoxView main.ts constructs gets no onHealParty callback, and a healParty command with no locationId sends nothing and reports healUnavailable even with heal locations loaded; a present id in the same state is sent', async () => {
    // WRONG IMPL KILLED (B13): a Box still handed a heal callback (any control wired to it heals at
    // a location the player never chose), and a location-less healParty that falls back to the
    // store's first loaded location (7 here) instead of refusing visibly. The control (a present
    // id is sent) keeps the refusal from passing on a dead dispatch path.
    await bootReady();
    server(1000);
    const box = H.handlers.BoxView;
    if (box === undefined) throw new Error('BoxView was never constructed by main.ts');
    expect(
      Object.hasOwn(box, 'onHealParty') ? box.onHealParty : undefined,
      'the Box gets no Heal Party callback',
    ).toBeUndefined();
    expect(typeof box.onSetNickname, 'control: the Box`s other callbacks are wired').toBe(
      'function',
    );
    expect(typeof box.onSetPartySlot).toBe('function');

    seedDispatchFixture();
    server(1010);
    expect(
      opts.store
        .healLocations()
        .map((l) => l.locationId)
        .sort(),
      'precondition: heal locations 7 and 9 are loaded',
    ).toEqual([7, 9]);
    const status = document.getElementById('status');
    if (status === null) throw new Error('#status must exist once booted');
    const issue: { command: unknown } = { command: { kind: 'healParty' } };
    swapAdapter('menuView', commandAdapter(issue));
    openMenuAtWorld(1020);

    H.calls = [];
    status.textContent = '';
    const down = await pageUp(1100);
    expect(down.defaultPrevented, 'the routed press is consumed').toBe(true);
    expect(H.calls, 'no locationId: nothing is sent, pads loaded or not').toEqual([]);
    expect(statusText(), 'and the player is told').toBe(i18n.t('chrome.status.healUnavailable'));

    issue.command = { kind: 'healParty', locationId: 9 };
    H.calls = [];
    status.textContent = '';
    await pageUp(1200);
    expect(H.calls, 'control: a present id is sent').toEqual([
      { name: 'healParty', args: { locationId: 9 } },
    ]);
    expect(statusText(), 'control: and nothing is reported').toBe('');
  });
});
