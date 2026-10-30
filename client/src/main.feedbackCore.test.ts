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
 * OPENING: trade (KeyU) and rename (KeyN) open through their real shortcuts; care opens on the
 * Monsters sheet (V opens Monsters, A on the monster opens its sheet, ArrowDown moves to Care, A
 * presses it); trade-propose opens face to face (A at the world on a faced player, then A on Trade;
 * ctl-10b). Shop is the one documented short-circuit (a real open needs an NPC + dialogue
 * round-trip): flip `#shop-overlay`'s display — the flag `ShopView.visible` reads — and flush a
 * store batch so the real listener renders the real Buy/Sell buttons.
 *
 * qf-8 (named intentional change, QF8.1): the trade panel's action buttons are deleted. Each trade
 * site's activation is the player's key sequence over the Social sheet U opened on the trade row
 * (`TRADE_SHEET_KEYS`: Accept; Decline then Yes for the trade `reject`; Confirm then Yes; Cancel);
 * the oracles (the reducer, its args, the `#trade-feedback` line) are unchanged. The sheet holds no
 * in-flight lock by design, so the four trade rows leave PGCCA-A1-LOCK-HELD (named there).
 *
 * qf-9 (named intentional change, QF9.3): the care site used to open the Raising card (KeyI, the
 * card`s Care button, `#raising-feedback`). The card and its line are deleted (QF9.2), so the site
 * is rewritten against the Monsters sheet and qf-2`s invoking-surface sink: the answer lands on the
 * Monsters frame`s own `.mr-frame-feedback` line. Every site now carries a `feedback()` reader (the
 * other eight read their overlay`s feedback node by id, exactly as before). The Raising card held
 * the ONLY in-flight lock, so PGCCA-A1-LOCK-HELD on the sheet path needs main.ts`s per-monster care
 * guard (QF9.3). Intent preserved, not deleted: titles keep their ids and the nine sites.
 *
 * HIDING: each view's `visible` getter reads its overlay's own `style.display !== 'none'`, so the
 * hidden tests flip exactly that flag (care has no hidden test: the Monsters frame`s own sink
 * guards the hidden case, pinned by main.controls.test.ts QF2-1-BOOT-SINK-FIXED-AT-SEND). A
 * feedback node still EMPTY after the call settles proves the closure did not paint into a hidden
 * overlay.
 *
 * Every test asserts the reducer spy's call count, so none can pass with the action never firing.
 *
 * TESTS (each tag appears in exactly one title):
 *   PGCCA-A4-HIDDEN-SHOP / -TRADE / -RENAME / -PROPOSE  paint only while the overlay is visible,
 *                                                        with the reducer's exact args asserted
 *   PGCCA-A4-WHERE-PER-SITE    a SenderError rejection paints reduceErrorMessage(err, <site tag>)
 *   PGCCA-A1-FROZEN-PER-SITE   a frozen link paints the disconnected line and calls no reducer
 *   PGCCA-A1-LOCK-HELD         the view's in-flight lock holds until the core's promise settles
 *   PGCCA-A4-CARE-BOOT-FR      care's success line is the fr catalog value under `?locale=fr`, on the
 *                              Monsters sheet's own line (qf-9)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAppShellFromRealIndexHtml,
  telemetryMock,
  wasmPkgStubMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { WasmMoveInput } from './convert/convert';
import type { ConnectionOptions } from './net/connection';
import type {
  StoreCharacter,
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
    /** ctl-10b: what the stubbed wasm `interact_candidates_coded` answers (the interaction RULE is
     *  the stub; `openPropose` installs one naming the faced player). Reset by `setupApp`. */
    interact: ((..._args: unknown[]) => []) as (...args: unknown[]) => unknown,
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
vi.mock('../../client-wasm/pkg/client_wasm.js', () =>
  wasmPkgStubMock({ interact: (...args: unknown[]) => H.interact(...args) }),
);

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

vi.mock('./observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('./observability/telemetry')>()),
);

vi.mock('./render/world', () => worldRendererMock());

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

interface StoreHandle {
  upsertShop(row: StoreShopRow): void;
  upsertShopItem(row: StoreShopItemRow): void;
  upsertItemDef(row: StoreItemRow): void;
  upsertWallet(row: StoreWallet): void;
  upsertTradeOffer(row: StoreTradeOffer): void;
  upsertPlayer(row: StorePlayer): void;
  upsertCharacter(row: StoreCharacter, nowMs: number): void;
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
  H.interact = () => [];
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
    lastCareAtMs: 0n,
  };
}

// ---------------------------------------------------------------------------
// The nine sites. `open()` stands the site's view up and returns an `activate()` that triggers the
// action once (re-querying its control each time).
// ---------------------------------------------------------------------------

type Activate = () => void;

/** The Monsters frame's own feedback line (qf-2's invoking-surface sink), resolved the way boxView
 *  builds its root (title -> header -> root); '' while the view is not built. */
function monstersLineText(): string {
  const root = document.querySelector('[data-testid="box-title"]')?.parentElement?.parentElement;
  return root?.querySelector('.mr-frame-feedback')?.textContent ?? '';
}

function openCare(): Activate {
  storeHandle().reconcileMonstersFromView([monster(1n, 0)]);
  storeHandle().flushBatch();
  // qf-9 (named intentional change, QF9.3): the Monsters sheet path, with the REAL keys. V opens
  // Monsters over the menu, A on the monster opens its sheet (the cursor on Summary), ArrowDown
  // moves to Care; the activation is A on Care. Was: KeyI opened the raising overlay and the
  // activation clicked its Care button.
  tapWorldKey('KeyV');
  tapWorldKey('Enter');
  tapWorldKey('ArrowDown');
  expect(
    document.getElementById('monstersSheet-root-care')?.getAttribute('aria-selected'),
    'the Monsters sheet`s cursor must be on Care',
  ).toBe('true');
  return () => tapWorldKey('Enter');
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

/** qf-8 (named intentional change, QF8.1): the trade panel's buttons are deleted, so each trade
 *  action is the key sequence over the Social sheet that U opened on the trade row (tradeModel.ts's
 *  action table: an offer TO the player reads Accept / Decline, one the player sent reads Cancel,
 *  one awaiting the player's final Confirm reads Confirm / Cancel; the trade `reject` is the
 *  sheet's Decline). Decline and Confirm ask Yes / No on No first, so their sequence moves to Yes. */
const TRADE_SHEET_KEYS: Readonly<Record<TradeAction, readonly string[]>> = {
  accept: ['Enter', 'Enter'], // the sheet (on Accept), A on Accept
  reject: ['Enter', 'ArrowDown', 'Enter', 'ArrowUp', 'Enter'], // Decline, its prompt, Yes
  confirm: ['Enter', 'Enter', 'ArrowUp', 'Enter'], // the sheet (on Confirm), its prompt, Yes
  cancel: ['Enter', 'Enter'], // the one-row sheet (on Cancel), A on Cancel
};

function openTrade(action: TradeAction): Activate {
  // Seed an offer shaped so exactly the action under test is available (feedbackI18n's table).
  const viewerIsInitiator = action === 'confirm' || action === 'cancel';
  seedOffer({
    viewerIsInitiator,
    status: action === 'confirm' ? 'ConfirmedByCounterparty' : 'Pending',
  });
  focusCanvasAndPressKey('KeyU');
  expect(
    document.getElementById('trade-status')?.getAttribute('aria-current'),
    `trade ${action}: the Social cursor must be on the trade row`,
  ).toBe('true');
  return () => {
    for (const code of TRADE_SHEET_KEYS[action]) tapWorldKey(code);
  };
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

/** A keydown and its keyup at the world (the canvas focused), as a player's tap. */
function tapWorldKey(code: string): void {
  document.querySelector('canvas')?.focus();
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

function placeCharacter(entityId: bigint, tileX: number, tileY: number): StoreCharacter {
  return {
    entityId,
    zoneId: 0,
    tileX,
    tileY,
    facing: 'East',
    action: 'Idle',
    moveStartedAtMs: 0n,
    moveQueue: [] as WasmMoveInput[],
  };
}

function openPropose(): Activate {
  // ctl-10b (named intentional change): O is retired. The wizard opens face to face: the own player
  // at (1, 1) facing East, Bob online on the faced tile (2, 1), the stubbed wasm rule naming him; A
  // opens the picker (Trade, Challenge) and A on Trade opens the wizard on Offer with Bob
  // pre-selected (the select is locked), so the old `target.value = OTHER` + change step is gone.
  const store = storeHandle();
  H.interact = (...args: unknown[]) => {
    const entities = args[4] as ReadonlyArray<{ kind: string; id: string }>;
    const at = entities.findIndex((e) => e.kind === 'player' && e.id === '1');
    return at === -1 ? [] : [at];
  };
  store.upsertPlayer({
    identity: H.identity,
    entityId: 7n,
    name: 'P',
    online: true,
    lastInputSeq: 0n,
  });
  store.upsertCharacter(placeCharacter(7n, 1, 1), 1000);
  store.upsertPlayer({
    identity: OTHER,
    entityId: 1n,
    name: 'Bob',
    online: true,
    lastInputSeq: 0n,
  });
  store.upsertCharacter(placeCharacter(1n, 2, 1), 1000);
  store.reconcileMonstersFromView([monster(5n, 255)]);
  store.flushBatch();
  tapWorldKey('Enter');
  tapWorldKey('Enter');
  const target = document.getElementById('tradepropose-target') as HTMLSelectElement;
  expect(target.value, 'the faced player is pre-selected').toBe(OTHER);
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
  /** What the site's feedback line currently reads: its overlay's feedback node by id (every site
   *  but care), or the Monsters frame's own line (care, qf-9). */
  readonly feedback: () => string;
  readonly overlayId: string | undefined;
  readonly reducer: ReducerSpy;
  /** The exact reducer argument (an asymmetric matcher where an SDK object is involved). */
  readonly args: unknown;
  readonly open: () => Activate;
}

/** The reader of a feedback node by id (the eight sites whose line is a node of their own overlay). */
const feedbackById =
  (id: string): (() => string) =>
  () =>
    textOf(id);

const SITES: readonly Site[] = [
  {
    name: 'care',
    tag: 'care',
    feedback: monstersLineText,
    overlayId: undefined,
    reducer: H.care,
    args: { monsterId: 1n },
    open: openCare,
  },
  {
    name: 'buy',
    tag: 'buy',
    feedback: feedbackById('shop-feedback'),
    overlayId: 'shop-overlay',
    reducer: H.buy,
    args: { shopId: 1, itemId: 1, qty: 1 },
    open: () => openShop('buy'),
  },
  {
    name: 'sell',
    tag: 'sell',
    feedback: feedbackById('shop-feedback'),
    overlayId: 'shop-overlay',
    reducer: H.sell,
    args: { itemId: 2, qty: 1 },
    open: () => openShop('sell'),
  },
  {
    name: 'accept',
    tag: 'respond-trade',
    feedback: feedbackById('trade-feedback'),
    overlayId: 'trade-overlay',
    reducer: H.respondTrade,
    args: { tradeId: TRADE_ID, accepted: true },
    open: () => openTrade('accept'),
  },
  {
    name: 'reject',
    tag: 'respond-trade',
    feedback: feedbackById('trade-feedback'),
    overlayId: 'trade-overlay',
    reducer: H.respondTrade,
    args: { tradeId: TRADE_ID, accepted: false },
    open: () => openTrade('reject'),
  },
  {
    name: 'confirm',
    tag: 'confirm-trade',
    feedback: feedbackById('trade-feedback'),
    overlayId: 'trade-overlay',
    reducer: H.confirmTrade,
    args: { tradeId: TRADE_ID },
    open: () => openTrade('confirm'),
  },
  {
    name: 'cancel',
    tag: 'cancel-trade',
    feedback: feedbackById('trade-feedback'),
    overlayId: 'trade-overlay',
    reducer: H.cancelTrade,
    args: { tradeId: TRADE_ID },
    open: () => openTrade('cancel'),
  },
  {
    name: 'rename',
    tag: 'set-profile-name',
    feedback: feedbackById('rename-feedback'),
    overlayId: 'rename-overlay',
    reducer: H.setProfileName,
    args: { name: 'NewName' },
    open: openRename,
  },
  {
    name: 'propose',
    tag: 'propose-trade',
    feedback: feedbackById('tradepropose-feedback'),
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
  expect(site.feedback(), `${name}: nothing may paint while pending`).toBe('');
  const calledWith = site.reducer.mock.calls[0] as readonly unknown[];

  hideOverlay(site.overlayId as string);
  held.release();
  await settle();

  expect(site.feedback(), `${name}: a hidden overlay must not be painted into`).toBe('');
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
  it('PGCCA-A4-WHERE-PER-SITE: a SenderError rejection paints reduceErrorMessage(err, <the site tag>) at all 9 sites, care on the Monsters sheet`s own line [QF9-3-WHERE-CARE-SHEET]', async () => {
    // WRONG IMPL KILLED: a site passing the wrong `where` (a copy-pasted care/buy tag), or reverted
    // to an inline pattern that drops the error arm. qf-9: the care site is the Monsters sheet, its
    // line the Monsters frame's own `.mr-frame-feedback` (a care rejection painted on the status
    // line or nowhere reads '' there).
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
      expect(site.feedback(), `${site.name}: the error line`).toBe(
        reduceErrorMessage(err, site.tag),
      );
      expect(site.feedback(), `${site.name}: the error line, spelled out`).toBe(
        `${site.tag}: nope`,
      );
    }
  }, 60_000);

  it('PGCCA-A1-FROZEN-PER-SITE: a frozen link paints the disconnected line and calls no reducer at the 7 sites feedbackI18n does not cover, care on the Monsters sheet`s own line [QF9-3-FROZEN-CARE-SHEET]', async () => {
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
      expect(site.feedback(), `${site.name}: the disconnected line`).toBe(
        EN['chrome.feedback.disconnected'],
      );
      expect(site.feedback()).toBe('disconnected — try again');
    }
  }, 60_000);

  it('PGCCA-A1-LOCK-HELD: while a reducer promise is pending a second activation does not fire again; after it settles a third does, at the 5 sites that keep an in-flight lock (the four trade sites answer on the Social sheet since qf-8), care on the Monsters sheet [QF9-3-LOCK-CARE-SHEET]', async () => {
    // WRONG IMPL KILLED: an adapter that does not RETURN the core's promise (`void performCare(...)`
    // or a pre-resolved stand-in) — the view's in-flight lock would release at once and a second
    // click would double-spend. Every view here locks on the handler's returned promise.
    // qf-9 (named intentional change): the care site's lock used to be the Raising card's per-monster
    // lock, deleted with the card. On the Monsters sheet path NOTHING in the view holds one (A on
    // Care is a keyed screen command), so this row reds until main.ts keeps a per-monster care
    // guard that releases when the care settles: a second A while pending sends no reducer call.
    // qf-8 (NAMED REMOVAL of the four trade rows, protected category: a reviewer adjudicates): the
    // trade sites' lock was the trade panel's own `#pending` over its Accept / Reject / Confirm /
    // Cancel buttons, deleted with them (QF8.1). The Social sheet sends one command per A and holds
    // no in-flight lock by design (socialScreen.ts's header: the reducers are the authority and
    // refuse a duplicate), and main.ts's trade arms keep none, so a second key sequence while the
    // first answer is pending sends again: there is no lock left to pin. Survivors: one A, one
    // command, socialScreen.test.ts CTL8D-2-COMMANDS; the trade arms still RETURN the core's promise
    // and route its outcome, PGCCA-A4-WHERE-PER-SITE (all four trade rows), PGCCA-A1-FROZEN-PER-SITE
    // (reject, confirm, cancel; accept's frozen line is main.feedbackI18n.test.ts's) and
    // PGCCA-A4-HIDDEN-TRADE above.
    const lockSites = SITES.filter(
      (s) => !['accept', 'reject', 'confirm', 'cancel'].includes(s.name),
    );
    expect(
      lockSites.map((s) => s.name),
      'the sites whose view (or main.ts) keeps an in-flight lock',
    ).toEqual(['care', 'buy', 'sell', 'rename', 'propose']);
    for (const [i, site] of lockSites.entries()) {
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
  it('PGCCA-A4-CARE-BOOT-FR: under ?locale=fr, pressing Care on the real Monsters sheet shows CATALOG_FR["raising.feedback.cared"] on the Monsters frame`s own line, not "Cared!" [QF9-3-CARE-BOOT-FR]', async () => {
    // WRONG IMPL KILLED: main.ts's care adapter handing the core the hardcoded English "Cared!"
    // (the pre-pgcc-a defect), or the key present in en only. qf-9 (named intentional change): the
    // press is A on the Monsters sheet's Care row (V, A on the monster, ArrowDown, A) and the line
    // is the Monsters frame's `.mr-frame-feedback`; the real raising overlay (and its
    // `#raising-feedback`) no longer has a Care button.
    await bootMain('/?locale=fr');
    const activate = siteNamed('care').open();

    activate();
    await vi.waitFor(
      () => {
        if (monstersLineText() === '') throw new Error('the Monsters line is not painted yet');
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
    expect(monstersLineText()).toBe(FR['raising.feedback.cared']);
    expect(monstersLineText()).not.toBe('Cared!');
    expect(document.getElementById('raising-feedback'), 'qf-9: raising has no line').toBeNull();
  });
});
