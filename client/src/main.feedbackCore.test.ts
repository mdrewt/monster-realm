// @vitest-environment happy-dom
/**
 * main.feedbackCore.test.ts — booted-app gate for slice pgcc-a: the nine main.ts feedback sites
 * (care, shop buy/sell, trade accept/reject/confirm/cancel, rename, trade-propose) all route through
 * ONE core (`performCare`, ui/careAction.ts). The core is unit-tested over injected fakes
 * (careAction.test.ts); what that suite cannot see is each main.ts ADAPTER: the `where` tag it
 * passes, the success key it resolves, the visibility guard its `showFeedback` closure owns, the
 * frozen-link path, and whether it RETURNS the core's promise so the view's in-flight lock holds.
 * This file proves those, per site, against the REAL main.ts.
 *
 * HARNESS — copied from main.feedbackI18n.test.ts (the REAL main.ts booted against the REAL
 * index.html shell; wasm pkg, './net/connection', telemetry and './render/world' mocked; module-scope
 * listeners recorded and detached per test). Reducer spies return promises the test controls.
 * Table-driven tests boot a fresh app per site (`resetApp()` between rows) inside ONE `it`.
 *
 * OPENING: trade (KeyU), rename (KeyN), trade-propose (KeyO) and raising (KeyI) open through their
 * real shortcuts. Shop is the one documented short-circuit (a real open needs an NPC + dialogue
 * round-trip): flip `#shop-overlay`'s display — the flag `ShopView.visible` reads — and flush a
 * store batch so the real listener renders the real Buy/Sell buttons.
 *
 * HIDING: each view's `visible` getter reads its overlay's own `style.display !== 'none'` (raising
 * is not hidden here), so the hidden tests flip exactly that flag. A feedback node still EMPTY
 * after the call settles proves the closure did not paint into a hidden overlay.
 *
 * Every test asserts the reducer spy's call count, so none can pass with the action never firing.
 *
 * TESTS (each tag appears in exactly one title):
 *   PGCCA-A4-HIDDEN-SHOP / -TRADE / -RENAME / -PROPOSE  paint only while the overlay is visible,
 *                                                        with the reducer's exact args asserted
 *   PGCCA-A4-WHERE-PER-SITE    a SenderError rejection paints reduceErrorMessage(err, <site tag>)
 *   PGCCA-A1-FROZEN-PER-SITE   a frozen link paints the disconnected line and calls no reducer
 *   PGCCA-A1-LOCK-HELD         the view's in-flight lock holds until the core's promise settles
 *   PGCCA-A4-CARE-BOOT-FR      care's success line is the fr catalog value under `?locale=fr`
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOptions } from './net/connection';
import type {
  StoreInventory,
  StoreItemRow,
  StoreMonsterPub,
  StorePlayer,
  StoreShopItemRow,
  StoreShopRow,
  StoreTradeOffer,
  StoreWallet,
} from './net/store';
import { CATALOG_EN } from './ui/i18n/catalog.en';
import { CATALOG_FR } from './ui/i18n/catalog.fr';
import { reduceErrorMessage } from './ui/statusModel';

const EN = CATALOG_EN as unknown as Record<string, string>;
const FR = CATALOG_FR as unknown as Record<string, string>;

/** A second identity (64 hex chars, `Identity`-constructible) for the trade counterparty. */
const OTHER = 'cd'.repeat(32);
const TRADE_ID = 10n;

const H = vi.hoisted(() => {
  const spy = () => vi.fn((_args: unknown) => Promise.resolve());
  const buy = spy();
  const sell = spy();
  const respondTrade = spy();
  const confirmTrade = spy();
  const cancelTrade = spy();
  const setProfileName = spy();
  const proposeTrade = spy();
  const care = spy();
  return {
    identity: 'ab'.repeat(32),
    connectOpts: null as unknown,
    /** Read LIVE by the mocked Connection's `linkFrozen()`; a test flips it AFTER opening a view. */
    linkFrozen: false,
    buy,
    sell,
    respondTrade,
    confirmTrade,
    cancelTrade,
    setProfileName,
    proposeTrade,
    care,
    live: {
      reducers: {
        buy,
        sell,
        respondTrade,
        confirmTrade,
        cancelTrade,
        setProfileName,
        proposeTrade,
        care,
      },
    } as unknown,
  };
});

type ReducerSpy = typeof H.buy;
const ALL_SPIES: readonly ReducerSpy[] = [
  H.buy,
  H.sell,
  H.respondTrade,
  H.confirmTrade,
  H.cancelTrade,
  H.setProfileName,
  H.proposeTrade,
  H.care,
];

// Same wasm mock shape as main.feedbackI18n.test.ts / main.partyFull.test.ts.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 64,
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

vi.mock('./net/connection', () => {
  const stub = {
    conn: undefined,
    live: () => H.live,
    identity: () => H.identity,
    linkFrozen: () => H.linkFrozen,
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
  };
  return {
    connect: (opts: unknown) => {
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

/** Record module-scope listeners so teardown can detach them (main.ts is re-imported per boot). */
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

function buildAppShellFromRealIndexHtml(): void {
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const bodyChildren = Array.from(parsed.body.children).filter((e) => e.tagName !== 'SCRIPT');
  // ctl-7a (named intentional change): the shipped <body> is now three children (#game-screen,
  // #build-stamp, #a11y-live), so the old `body children > 5` floor is retired. The vacuity
  // guard counts the id-bearing elements the parse yielded instead (the real shell has ~60).
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'parsed index.html yielded almost no id-bearing elements').toBeGreaterThan(5);
  document.body.replaceChildren(...bodyChildren.map((e) => document.adoptNode(e)));
}

interface StoreHandle {
  upsertShop(row: StoreShopRow): void;
  upsertShopItem(row: StoreShopItemRow): void;
  upsertItemDef(row: StoreItemRow): void;
  upsertWallet(row: StoreWallet): void;
  upsertTradeOffer(row: StoreTradeOffer): void;
  upsertPlayer(row: StorePlayer): void;
  reconcileInventoryFromView(rows: readonly StoreInventory[]): void;
  reconcileMonstersFromView(rows: readonly StoreMonsterPub[]): void;
  flushBatch(): void;
}

let opts!: ConnectionOptions;
let recorded: Recorded[] = [];
let restoreWindowAdd: (() => void) | undefined;
let restoreDocumentAdd: (() => void) | undefined;

function storeHandle(): StoreHandle {
  return (opts as unknown as { store: StoreHandle }).store;
}

async function bootMain(url: string): Promise<void> {
  window.history.replaceState(null, '', url);
  vi.resetModules();
  await import('./main');
  opts = (await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() has not been called by main() yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  )) as ConnectionOptions;
  opts.onReady(H.identity);
}

function setupApp(): void {
  recorded = [];
  H.connectOpts = null;
  H.linkFrozen = false;
  // mockReset + a fresh default: a queued `...Once` impl from a failed row can never leak forward.
  for (const s of ALL_SPIES) {
    s.mockReset();
    s.mockImplementation(() => Promise.resolve());
  }
  buildAppShellFromRealIndexHtml();
  vi.stubGlobal('requestAnimationFrame', (): number => 0);
  restoreWindowAdd = recordListeners(window, recorded);
  restoreDocumentAdd = recordListeners(document, recorded);
}

function teardownApp(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  restoreDocumentAdd?.();
  restoreWindowAdd?.();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
}

/** Tear the booted app down and stand a clean shell back up — the between-rows reset of the
 *  table-driven tests, identical to what afterEach + beforeEach do between tests. */
function resetApp(): void {
  teardownApp();
  setupApp();
}

beforeEach(setupApp);
afterEach(teardownApp);

/** A reducer promise the test controls: it stays pending until `release()`. */
function holdOpen(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Two macrotask turns: every microtask continuation (the core's await, the view's .finally) has
 *  run by the time this resolves — including a lock that a broken adapter released EARLY. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Hide an overlay by writing the very flag its view's `visible` getter reads. */
function hideOverlay(id: string): void {
  const overlay = document.getElementById(id);
  expect(overlay, `${id} must exist in the real index.html shell`).not.toBeNull();
  (overlay as HTMLElement).style.display = 'none';
}

function textOf(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

function focusCanvasAndPressKey(code: string): void {
  document.querySelector('canvas')?.focus();
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
}

/** Re-query and click a control: a view may rebuild its nodes, so never hold one across calls. */
function clickFirst(selector: string, what: string, root: ParentNode = document): void {
  const el = root.querySelector(selector);
  expect(el, `the ${what} control must be rendered`).not.toBeNull();
  (el as HTMLElement).click();
}

function monster(monsterId: bigint, partySlot: number): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: H.identity,
    speciesId: 1,
    nickname: `m${monsterId}`,
    level: 5,
    xp: 0,
    currentHp: 10,
    statHp: 10,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
    partySlot,
    tier: 0,
    essence: { Fire: 0, Water: 0, Plant: 0, Electric: 0, Earth: 0, Wind: 0, Light: 0, Dark: 0 },
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
  };
}

// ---------------------------------------------------------------------------
// The nine sites. `open()` stands the site's view up and returns an `activate()` that triggers the
// action once (re-querying its control each time).
// ---------------------------------------------------------------------------

type Activate = () => void;

function openCare(): Activate {
  storeHandle().reconcileMonstersFromView([monster(1n, 0)]);
  storeHandle().flushBatch();
  // The REAL KeyI shortcut: main.ts toggles the raising overlay and refreshes it from the store.
  focusCanvasAndPressKey('KeyI');
  const root = document.getElementById('raising-feedback')?.parentElement;
  expect(root, 'the raising overlay must be constructed by main.ts').toBeTruthy();
  return () => clickFirst('button', 'Care', root as HTMLElement);
}

function openShop(kind: 'buy' | 'sell'): Activate {
  const store = storeHandle();
  store.upsertShop({ shopId: 1, name: 'Test Shop' });
  store.upsertItemDef({
    id: 1,
    name: 'Potion',
    description: '',
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 0n,
    cureStatus: null,
  });
  store.upsertShopItem({ shopItemId: 1n, shopId: 1, itemId: 1, buyPrice: 10n });
  // A second, sellable item carried in inventory renders the Sell button.
  store.upsertItemDef({
    id: 2,
    name: 'Herb',
    description: '',
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 5n,
    cureStatus: null,
  });
  store.reconcileInventoryFromView([{ invId: 1n, ownerIdentity: H.identity, itemId: 2, count: 3 }]);
  store.upsertWallet({ ownerIdentity: H.identity, balance: 100n });
  const overlay = document.getElementById('shop-overlay');
  expect(overlay, 'shop-overlay must exist in the real index.html shell').not.toBeNull();
  (overlay as HTMLElement).style.display = '';
  store.flushBatch();
  const selector = kind === 'buy' ? '#shop-for-sale button' : '#shop-inventory button';
  return () => clickFirst(selector, kind === 'buy' ? 'Buy' : 'Sell');
}

type TradeAction = 'accept' | 'reject' | 'confirm' | 'cancel';

function openTrade(action: TradeAction): Activate {
  // Seed an offer shaped so exactly the action under test is available (feedbackI18n's table).
  const viewerIsInitiator = action === 'confirm' || action === 'cancel';
  seedOffer({
    viewerIsInitiator,
    status: action === 'confirm' ? 'ConfirmedByCounterparty' : 'Pending',
  });
  focusCanvasAndPressKey('KeyU');
  return () => clickFirst(`#trade-actions button[data-action="${action}"]`, `trade ${action}`);
}

function seedOffer(o: {
  readonly viewerIsInitiator: boolean;
  readonly status: 'Pending' | 'ConfirmedByCounterparty';
}): void {
  const store = storeHandle();
  store.upsertTradeOffer({
    tradeId: TRADE_ID,
    initiator: o.viewerIsInitiator ? H.identity : OTHER,
    counterparty: o.viewerIsInitiator ? OTHER : H.identity,
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status: o.status,
    createdAtMs: 0n,
  });
  store.flushBatch();
}

function openRename(): Activate {
  focusCanvasAndPressKey('KeyN');
  const input = document.getElementById('rename-input') as HTMLInputElement;
  input.value = 'NewName';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return () => clickFirst('#rename-submit', 'rename submit');
}

function openPropose(): Activate {
  const store = storeHandle();
  store.upsertPlayer({
    identity: OTHER,
    entityId: 1n,
    name: 'Bob',
    online: true,
    lastInputSeq: 0n,
  });
  store.reconcileMonstersFromView([monster(5n, 255)]);
  store.flushBatch();
  focusCanvasAndPressKey('KeyO');
  const target = document.getElementById('tradepropose-target') as HTMLSelectElement;
  target.value = OTHER;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  const monsterBox = document.querySelector('#tradepropose-monsters input[type="checkbox"]');
  expect(monsterBox, 'the seeded monster must render as an offerable checkbox').not.toBeNull();
  (monsterBox as HTMLInputElement).checked = true;
  monsterBox?.dispatchEvent(new Event('change', { bubbles: true }));
  const offer = document.getElementById('tradepropose-offer-currency') as HTMLInputElement;
  offer.value = '10';
  offer.dispatchEvent(new Event('input', { bubbles: true }));
  const request = document.getElementById('tradepropose-request-currency') as HTMLInputElement;
  request.value = '3';
  request.dispatchEvent(new Event('input', { bubbles: true }));
  const submit = document.getElementById('tradepropose-submit') as HTMLButtonElement;
  expect(submit.disabled, 'submit must be enabled once a target + assets are set').toBe(false);
  return () => clickFirst('#tradepropose-submit', 'trade-propose submit');
}

interface Site {
  readonly name: string;
  /** The `reduceErrorMessage` tag the site keeps from before the refactor. */
  readonly tag: string;
  readonly feedbackId: string;
  readonly overlayId: string | undefined;
  readonly reducer: ReducerSpy;
  /** The exact reducer argument (an asymmetric matcher where an SDK object is involved). */
  readonly args: unknown;
  readonly open: () => Activate;
}

const SITES: readonly Site[] = [
  {
    name: 'care',
    tag: 'care',
    feedbackId: 'raising-feedback',
    overlayId: undefined,
    reducer: H.care,
    args: { monsterId: 1n },
    open: openCare,
  },
  {
    name: 'buy',
    tag: 'buy',
    feedbackId: 'shop-feedback',
    overlayId: 'shop-overlay',
    reducer: H.buy,
    args: { shopId: 1, itemId: 1, qty: 1 },
    open: () => openShop('buy'),
  },
  {
    name: 'sell',
    tag: 'sell',
    feedbackId: 'shop-feedback',
    overlayId: 'shop-overlay',
    reducer: H.sell,
    args: { itemId: 2, qty: 1 },
    open: () => openShop('sell'),
  },
  {
    name: 'accept',
    tag: 'respond-trade',
    feedbackId: 'trade-feedback',
    overlayId: 'trade-overlay',
    reducer: H.respondTrade,
    args: { tradeId: TRADE_ID, accepted: true },
    open: () => openTrade('accept'),
  },
  {
    name: 'reject',
    tag: 'respond-trade',
    feedbackId: 'trade-feedback',
    overlayId: 'trade-overlay',
    reducer: H.respondTrade,
    args: { tradeId: TRADE_ID, accepted: false },
    open: () => openTrade('reject'),
  },
  {
    name: 'confirm',
    tag: 'confirm-trade',
    feedbackId: 'trade-feedback',
    overlayId: 'trade-overlay',
    reducer: H.confirmTrade,
    args: { tradeId: TRADE_ID },
    open: () => openTrade('confirm'),
  },
  {
    name: 'cancel',
    tag: 'cancel-trade',
    feedbackId: 'trade-feedback',
    overlayId: 'trade-overlay',
    reducer: H.cancelTrade,
    args: { tradeId: TRADE_ID },
    open: () => openTrade('cancel'),
  },
  {
    name: 'rename',
    tag: 'set-profile-name',
    feedbackId: 'rename-feedback',
    overlayId: 'rename-overlay',
    reducer: H.setProfileName,
    args: { name: 'NewName' },
    open: openRename,
  },
  {
    name: 'propose',
    tag: 'propose-trade',
    feedbackId: 'tradepropose-feedback',
    overlayId: 'tradepropose-overlay',
    reducer: H.proposeTrade,
    // Every field but `counterparty` (an SDK Identity, checked by its hex in the HIDDEN test).
    args: expect.objectContaining({
      initiatorMonsterIds: [5n],
      initiatorItems: [],
      initiatorCurrency: 10n,
      counterpartyMonsterIds: [],
      counterpartyItems: [],
      counterpartyCurrency: 3n,
    }),
    open: openPropose,
  },
];

function siteNamed(name: string): Site {
  const site = SITES.find((s) => s.name === name);
  if (site === undefined) throw new Error(`no site named ${name}`);
  return site;
}

/** Open `name`'s view, hold its reducer open, hide the overlay, then settle: nothing may paint. */
async function expectNoPaintWhenHidden(name: string): Promise<readonly unknown[]> {
  await bootMain('/');
  const site = siteNamed(name);
  const activate = site.open();
  const held = holdOpen();
  site.reducer.mockImplementationOnce(() => held.promise);

  activate();
  expect(site.reducer, `${name}: the action must have reached the reducer`).toHaveBeenCalledOnce();
  expect(site.reducer).toHaveBeenCalledWith(site.args);
  expect(textOf(site.feedbackId), `${name}: nothing may paint while pending`).toBe('');
  const calledWith = site.reducer.mock.calls[0] as readonly unknown[];

  hideOverlay(site.overlayId as string);
  held.release();
  await settle();

  expect(textOf(site.feedbackId), `${name}: a hidden overlay must not be painted into`).toBe('');
  return calledWith;
}

describe('main.ts feedback sites paint only while their overlay is visible (slice pgcc-a, A4)', () => {
  it('PGCCA-A4-HIDDEN-SHOP: a Buy that settles after #shop-overlay was hidden paints no success line', async () => {
    // WRONG IMPL KILLED: the shop closure routed through the core WITHOUT its visibility guard —
    // the success line would land in the hidden overlay and greet the next open.
    await expectNoPaintWhenHidden('buy');
  });

  it('PGCCA-A4-HIDDEN-TRADE: an Accept that settles after #trade-overlay was hidden paints no success line', async () => {
    // WRONG IMPL KILLED: the trade closure routed through the core WITHOUT its visibility guard.
    await expectNoPaintWhenHidden('accept');
  });

  it('PGCCA-A4-HIDDEN-RENAME: a rename that settles after #rename-overlay was hidden paints no success line', async () => {
    // WRONG IMPL KILLED: the rename closure routed through the core WITHOUT its visibility guard.
    await expectNoPaintWhenHidden('rename');
  });

  it('PGCCA-A4-HIDDEN-PROPOSE: a trade proposal that settles after #tradepropose-overlay was hidden paints no success line', async () => {
    // WRONG IMPL KILLED: the trade-propose closure routed through the core WITHOUT its visibility
    // guard; or an args thunk that drops a field (monster ids, either currency, the counterparty).
    const [args] = (await expectNoPaintWhenHidden('propose')) as [Record<string, unknown>];
    const { counterparty, ...rest } = args;
    expect(rest).toEqual({
      initiatorMonsterIds: [5n],
      initiatorItems: [],
      initiatorCurrency: 10n,
      counterpartyMonsterIds: [],
      counterpartyItems: [],
      counterpartyCurrency: 3n,
    });
    expect((counterparty as { toHexString(): string }).toHexString()).toBe(OTHER);
  });
});

describe('main.ts feedback sites keep their behaviour per site (slice pgcc-a, A1/A4)', () => {
  it('PGCCA-A4-WHERE-PER-SITE: a SenderError rejection paints reduceErrorMessage(err, <the site tag>) at all 9 sites', async () => {
    // WRONG IMPL KILLED: a site passing the wrong `where` (a copy-pasted care/buy tag), or reverted
    // to an inline pattern that drops the error arm.
    expect(SITES.length, 'ANTI-VACUITY: all nine sites').toBe(9);
    for (const [i, site] of SITES.entries()) {
      if (i > 0) resetApp();
      await bootMain('/');
      const activate = site.open();
      const err = Object.assign(new Error('nope'), { name: 'SenderError' });
      site.reducer.mockRejectedValueOnce(err);

      activate();
      await settle();

      expect(site.reducer, `${site.name}: reducer calls`).toHaveBeenCalledOnce();
      expect(site.reducer, `${site.name}: reducer args`).toHaveBeenCalledWith(site.args);
      expect(textOf(site.feedbackId), `${site.name}: the error line`).toBe(
        reduceErrorMessage(err, site.tag),
      );
      expect(textOf(site.feedbackId), `${site.name}: the error line, spelled out`).toBe(
        `${site.tag}: nope`,
      );
    }
  }, 60_000);

  it('PGCCA-A1-FROZEN-PER-SITE: a frozen link paints the disconnected line and calls no reducer at the 7 sites feedbackI18n does not cover', async () => {
    // WRONG IMPL KILLED: a site that lost the frozen gate (it would call a dead connection and hang
    // or paint a false success), or one that paints something other than the disconnected line.
    const sites = SITES.filter((s) => s.name !== 'buy' && s.name !== 'accept');
    expect(sites.map((s) => s.name)).toEqual([
      'care',
      'sell',
      'reject',
      'confirm',
      'cancel',
      'rename',
      'propose',
    ]);
    for (const [i, site] of sites.entries()) {
      if (i > 0) resetApp();
      await bootMain('/');
      const activate = site.open();
      H.linkFrozen = true;

      activate();
      await settle();

      expect(
        site.reducer,
        `${site.name}: a frozen link must never reach the reducer`,
      ).not.toHaveBeenCalled();
      expect(textOf(site.feedbackId), `${site.name}: the disconnected line`).toBe(
        EN['chrome.feedback.disconnected'],
      );
      expect(textOf(site.feedbackId)).toBe('disconnected — try again');
    }
  }, 60_000);

  it('PGCCA-A1-LOCK-HELD: while a reducer promise is pending a second activation does not fire again; after it settles a third does, at all 9 sites', async () => {
    // WRONG IMPL KILLED: an adapter that does not RETURN the core's promise (`void performCare(...)`
    // or a pre-resolved stand-in) — the view's in-flight lock would release at once and a second
    // click would double-spend. Every view here locks on the handler's returned promise.
    for (const [i, site] of SITES.entries()) {
      if (i > 0) resetApp();
      await bootMain('/');
      const activate = site.open();
      const held = holdOpen();
      site.reducer.mockImplementationOnce(() => held.promise);

      activate();
      expect(site.reducer, `${site.name}: first activation`).toHaveBeenCalledTimes(1);
      // A macrotask turn lets a lock released EARLY (a non-returned promise) show itself.
      await settle();
      activate();
      expect(site.reducer, `${site.name}: second activation while pending`).toHaveBeenCalledTimes(
        1,
      );

      held.release();
      await settle();
      activate();
      expect(site.reducer, `${site.name}: third activation after settle`).toHaveBeenCalledTimes(2);
      expect(site.reducer).toHaveBeenLastCalledWith(site.args);
    }
  }, 60_000);
});

describe('main.ts care success line resolves through the catalog under fr (slice pgcc-a, A3 via the real overlay)', () => {
  it('PGCCA-A4-CARE-BOOT-FR: under ?locale=fr, clicking Care in the real raising overlay shows CATALOG_FR["raising.feedback.cared"], not "Cared!"', async () => {
    // WRONG IMPL KILLED: main.ts's care adapter handing the core the hardcoded English "Cared!"
    // (the pre-pgcc-a defect), or the key present in en only.
    await bootMain('/?locale=fr');
    const activate = siteNamed('care').open();

    activate();
    await vi.waitFor(
      () => {
        if (textOf('raising-feedback') === '') throw new Error('raising-feedback not painted yet');
      },
      { timeout: 2_000, interval: 5 },
    );

    expect(H.care, 'the real care reducer must have been called once').toHaveBeenCalledOnce();
    expect(H.care).toHaveBeenCalledWith({ monsterId: 1n });
    expect(
      typeof FR['raising.feedback.cared'],
      'CATALOG_FR must define raising.feedback.cared as a plain string',
    ).toBe('string');
    expect(FR['raising.feedback.cared']).not.toBe('Cared!');
    expect(textOf('raising-feedback')).toBe(FR['raising.feedback.cared']);
    expect(textOf('raising-feedback')).not.toBe('Cared!');
  });
});
