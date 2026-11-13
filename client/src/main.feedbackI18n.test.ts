// @vitest-environment happy-dom
/**
 * main.feedbackI18n.test.ts — RUNTIME gate over main.ts's shop-feedback lines routing through
 * the i18n catalog (slice 21r-b, gate B1).
 *
 * SOURCE OF TRUTH — EARS criterion B1: ALL 15 messages the 21r-b plan names move into
 * catalog.en.ts + catalog.fr.ts; EVERY listed call site consumes t()/tf(); English output stays
 * byte-identical; "a red-first vitest shows one representative per group (a shop/trade feedback
 * line from main.ts, a session-overlay string) rendering its FRENCH catalog text under `fr`."
 * This file is that main.ts representative — sessionModel.test.ts/careAction.test.ts cover the
 * session-overlay + careAction sites.
 *
 * THE DEFECT (verified @4f36de2, re-verified against this worktree): main.ts's shop onBuy/onSell
 * frozen-link branches (main.ts:2638/2653) call `shopView.showFeedback('disconnected — try
 * again')` with a bare English string literal — never `i18nT('chrome.feedback.disconnected')`
 * (main.ts already imports `t as i18nT` from './ui/i18n/resolver', main.ts:132, for exactly this
 * migration) — so the line renders in English regardless of the active locale.
 *
 * HARNESS — main.partyFull.test.ts's pattern (16r-f precedent, see
 * ~/.claude/…/main-ts-runtime-import-test-harness.md): the REAL main.ts booted against the REAL
 * index.html shell (`buildAppShellFromRealIndexHtml`), wasm pkg / './net/connection' /
 * './observability/telemetry' / './render/world' mocked, module-scope window/document listeners
 * recorded and detached in afterEach (main.ts is re-imported per test via vi.resetModules()).
 * UNLIKE main.i18nBoot.test.ts, this file does NOT mock './ui/i18n/resolver' — it needs the REAL
 * resolver/catalogs so main.ts's boot-time `negotiateLocale`/`setLocale` (main.ts:227-233,
 * already shipped) actually switches what `i18nT`/`shopView.ts`'s `t()` render, driven by a real
 * `?locale=fr` URL param exactly like main.i18nBoot.test.ts's BOOT-03.
 *
 * REACHING THE SHOP OVERLAY AT A SANE COST: opening it for real requires an NPC + a
 * greet-then-shop dialogue round-trip (main.ts:2096-2107, deferred through a batch listener) —
 * orthogonal to this slice's i18n defect and expensive to stage. Instead this harness seeds ONE
 * shop/item/wallet row directly through the REAL `AuthoritativeStore` (the exact
 * `reconcileMonstersFromView` + `flushBatch` idiom main.partyFull.test.ts already uses) and
 * flips `#shop-overlay`'s `style.display` — the SAME flag `ShopView.show()`/`.hide()` write and
 * `ShopView.visible` reads — so the REAL M13d batch listener (main.ts) builds the REAL
 * `ShopScreenViewModel` and renders the REAL Buy button via the REAL `ShopView.render()`. Only
 * the OPEN mechanism is short-circuited; the render, the click, and the `onBuy` handler under
 * test are all the genuine, unmodified production code.
 *
 * `chrome.feedback.disconnected` is NOT YET a `MessageId` (this slice adds it), so it is read
 * off `CATALOG_EN`/`CATALOG_FR` through a widened `Record<string, string>` cast — this file must
 * fail on a MISSING/WRONG catalog VALUE (an assertion), never on a TS/import error.
 *
 * WRONG IMPL KILLED (one per test):
 *   fr test  -> main.ts's frozen-link branch left on the bare English literal (or on
 *               `i18nT('chrome.feedback.disconnected')` with the catalog itself missing the fr
 *               entry) — either way `shop-feedback`'s text stays the English bytes under `fr`.
 *   en test  -> the migration accidentally changing the English bytes (a reword, a missing
 *               trailing/leading character, a wrong key) — this pins byte-identity post-fix.
 *
 * RED-TEAM ROUND (post-implementation, gated set 67/67 green): the §5.3 census/parity gate
 * proves a key is REQUESTED somewhere in main.ts, never WHICH call site claims it — a single
 * non-shop site (a frozen-link line, the rename success) reverted to its raw English literal
 * survived mutation with every gated test green. The rename suite below opens its overlay through
 * its REAL input path (KeyN — no NPC/dialogue needed, unlike shop) and drives its REAL submit
 * path, asserting each line against its OWN catalog key (never just "some key differs from en")
 * plus the right reducer spy.
 *
 * ctl-7d (CTL7D.4, a named intentional change): the plain shop success ids
 * `shop.feedback.purchased` / `shop.feedback.sold` are deleted. A successful Buy or Sell now shows
 * a line naming the quantity, the item and the gold moved (`shop.feedback.buy.item` /
 * `shop.feedback.sell.item`, or the `.count` line when a row is missing). The three tests that
 * pinned the old ids were replaced by the two ctl-7d line tests in the shop suite, which pin the
 * literal en and fr bytes, built from code points, never read off the catalog under test. The
 * frozen-link tests are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAppShellFromRealIndexHtml,
  telemetryMock,
  wasmPkgStubMock,
  worldRendererMock,
} from '../test-util/mainBootHarness';
import type { ConnectionOptions } from './net/connection';
import type {
  StoreCharacter,
  StoreInventory,
  StoreItemRow,
  StorePlayer,
  StoreShopItemRow,
  StoreShopRow,
  StoreTradeSession,
  StoreWallet,
} from './net/store';
import { CATALOG_EN } from './ui/i18n/catalog.en';
import { CATALOG_FR } from './ui/i18n/catalog.fr';

const EN = CATALOG_EN as unknown as Record<string, string>;
const FR = CATALOG_FR as unknown as Record<string, string>;

// The ctl-7d shop success lines' glyphs, by code point (never pasted): U+2713 the success mark,
// U+2212 the minus sign (never the ASCII hyphen), U+00E9 the e-acute of the fr verb.
const CHECK = String.fromCharCode(0x2713);
const MINUS = String.fromCharCode(0x2212);
const E_ACUTE = String.fromCharCode(0xe9);

/** A second identity (64 hex chars, `Identity`-constructible) for the trade session partner. */
const OTHER = 'cd'.repeat(32);

const H = vi.hoisted(() => {
  const buy = vi.fn(() => Promise.resolve());
  const sell = vi.fn(() => Promise.resolve());
  const setProfileName = vi.fn(() => Promise.resolve());
  const proposeTrade = vi.fn(() => Promise.resolve());
  return {
    identity: 'ab'.repeat(32),
    connectOpts: null as unknown,
    /** Mutated per test AFTER boot, read live by the mocked Connection's `linkFrozen()`. */
    linkFrozen: false,
    /** ctl-10b: what the stubbed wasm `interact_candidates_coded` answers. Reset per test. */
    interact: ((..._args: unknown[]) => []) as (...args: unknown[]) => unknown,
    buy,
    sell,
    setProfileName,
    proposeTrade,
    /** `conn.live()`'s return — the census roster can't tell which reducer a call site
     *  targets, so the SUCCESS-line tests below spy on the real reducer names directly. */
    live: {
      reducers: {
        buy,
        sell,
        setProfileName,
        proposeTrade,
      },
    } as unknown,
  };
});

// Same wasm mock shape as main.partyFull.test.ts / main.i18nBoot.test.ts.
vi.mock('../../client-wasm/pkg/client_wasm.js', () =>
  wasmPkgStubMock({ interact: (...args: unknown[]) => H.interact(...args) }),
);

// `linkFrozen` reads H.linkFrozen LIVE (never a snapshot) so a test can flip it AFTER boot,
// once the shop overlay is already open — the site under test is main.ts's onBuy handler
// reading `conn.linkFrozen()` at CLICK time, not at connect() time.
vi.mock('./net/connection', () => {
  const stub = {
    conn: undefined,
    live: () => H.live,
    identity: () => H.identity,
    linkFrozen: () => H.linkFrozen,
    worldScope: () => ({ own: null, zones: [], settled: false }),
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

/** Record module-scope listeners so afterEach can detach them (main.ts is re-imported per test). */
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
  /** ts-3: the PK-less `my_trade_session` view, reconciled as a whole set. */
  reconcileTradeSessionsFromView(rows: readonly StoreTradeSession[]): void;
  upsertPlayer(row: StorePlayer): void;
  upsertCharacter(row: StoreCharacter, nowMs: number): void;
  reconcileInventoryFromView(rows: readonly StoreInventory[]): void;
  flushBatch(): void;
}

let opts!: ConnectionOptions;
let recorded: Recorded[] = [];
let restoreWindowAdd: (() => void) | undefined;
let restoreDocumentAdd: (() => void) | undefined;

function storeHandle(): StoreHandle {
  return (opts as unknown as { store: StoreHandle }).store;
}

/** Seed one shop with one for-sale item, one sellable inventory item + a wallet row, then
 *  flip `#shop-overlay`'s own `style.display` (the header note explains why this — not a real
 *  dialogue round-trip — is the sane-cost open) and flush ONE batch so the REAL M13d listener
 *  renders the REAL Buy/Sell buttons. The sellable item is seeded unconditionally (trivial
 *  cost) so the Sell success test below reuses this same setup. */
function openShopWithOneItem(): void {
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
  // A second item def, sellable (sellPrice > 0n) and carried in inventory — makes shopModel's
  // `forSaleByPlayer` render a Sell button (buildShopViewModel: canSell = sellPrice > 0n).
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
}

function findBuyButton(): HTMLButtonElement {
  const btn = document.querySelector('#shop-for-sale button');
  expect(btn, 'the shop overlay must render a Buy button for the seeded item').not.toBeNull();
  return btn as HTMLButtonElement;
}

function findSellButton(): HTMLButtonElement {
  const btn = document.querySelector('#shop-inventory button');
  expect(
    btn,
    'the shop overlay must render a Sell button for the seeded inventory item',
  ).not.toBeNull();
  return btn as HTMLButtonElement;
}

// Every message of the shop, rename and trade-session sites goes through the one seam, so it is
// read off `#toast` (visible text, '' while hidden); the per-site reader names below all read it.
function toastText(): string {
  const el = document.getElementById('toast');
  expect(el, '#toast must exist in the real index.html shell').not.toBeNull();
  return (el as HTMLElement).hidden ? '' : ((el as HTMLElement).textContent ?? '');
}

function shopFeedbackText(): string {
  return toastText();
}

/** Waits for a non-empty toast — the success arms await a reducer promise (a real microtask hop)
 *  before reporting, unlike the synchronous frozen-link arm. */
async function waitForFeedback(): Promise<void> {
  await vi.waitFor(
    () => {
      if (shopFeedbackText() === '') throw new Error('the toast has not shown yet');
    },
    { timeout: 2_000, interval: 5 },
  );
}

/** Empties the toast (nothing ticks its clock here) and lets one macrotask pass, so the view's
 *  in-flight lock (released once the previous click's promise settles) is free and the next click
 *  paints a fresh line. */
async function freshShopFeedback(): Promise<void> {
  const el = document.getElementById('toast');
  expect(el, '#toast must exist in the real index.html shell').not.toBeNull();
  (el as HTMLElement).textContent = '';
  (el as HTMLElement).hidden = true;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Generic sibling of `waitForFeedback` for the rename and trade-session lines below —
 *  same "await a reducer promise" reason, parameterised over which feedback node to poll. */
async function waitForNonEmpty(getText: () => string): Promise<void> {
  await vi.waitFor(
    () => {
      if (getText() === '') throw new Error('feedback has not rendered yet');
    },
    { timeout: 2_000, interval: 5 },
  );
}

function focusCanvasAndPressKey(code: string): void {
  document.querySelector('canvas')?.focus();
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
}

function renameFeedbackText(): string {
  return toastText();
}

function proposeFeedbackText(): string {
  return toastText();
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

// Hooks live at FILE scope (not nested in one describe) so the identical boot/cleanup applies
// uniformly to every describe below (shop, trade, rename + trade-propose) — one setup, never
// four hand-copied ones that could silently drift.
beforeEach(() => {
  recorded = [];
  H.connectOpts = null;
  H.linkFrozen = false;
  H.interact = () => [];
  H.buy.mockClear();
  H.sell.mockClear();
  H.setProfileName.mockClear();
  H.proposeTrade.mockClear();
  buildAppShellFromRealIndexHtml();
  vi.stubGlobal('requestAnimationFrame', (): number => 0);
  restoreWindowAdd = recordListeners(window, recorded);
  restoreDocumentAdd = recordListeners(document, recorded);
});

afterEach(() => {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  restoreDocumentAdd?.();
  restoreWindowAdd?.();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

describe('main.ts shop feedback routes through the i18n catalog (slice 21r-b, gate B1)', () => {
  it('UIF4B.1 ★★ BITES: under fr (?locale=fr), a frozen link toasts CATALOG_FR["chrome.feedback.disconnected"] on Buy, not the hardcoded English literal', async () => {
    await bootMain('/?locale=fr');
    openShopWithOneItem();
    H.linkFrozen = true;

    findBuyButton().click();
    await Promise.resolve();

    expect(shopFeedbackText()).toBe(FR['chrome.feedback.disconnected']);
    expect(shopFeedbackText()).not.toBe('disconnected — try again');
    expect(shopFeedbackText()).not.toBe(EN['chrome.feedback.disconnected']);
  });

  it('UIF4B.1 ★ BITES: under en, a frozen link still toasts the exact pre-migration English line on Buy', async () => {
    await bootMain('/');
    openShopWithOneItem();
    H.linkFrozen = true;

    findBuyButton().click();
    await Promise.resolve();

    expect(shopFeedbackText()).toBe('disconnected — try again');
    expect(shopFeedbackText()).toBe(EN['chrome.feedback.disconnected']);
  });

  // ---------------------------------------------------------------------------
  // SUCCESS lines (ctl-7d, CTL7D.4; a named intentional change: the plain
  // `shop.feedback.purchased` / `.sold` ids the earlier tests here pinned are deleted). A
  // successful Buy or Sell shows a line naming the quantity, the item and the gold moved, read from
  // the store rows when the command is sent. These tests click the REAL Buy/Sell buttons and pin
  // the rendered `#shop-feedback` text against LITERAL bytes built from code points here, never
  // read off the catalog under test, so a buy/sell id swap, an untranslated copy-through and a
  // wrong price all change what is pinned. The quantity is 1 here (the legacy ShopView sends 1);
  // main.dispatch.test.ts drives larger quantities through a screen adapter.
  // ---------------------------------------------------------------------------

  it('UIF4B.1 CTL7D-4-BOOT-LINE-EN: under en a real Buy click and then a real Sell click each show the line naming the quantity, the item and the gold moved (1 Potion for 10g, then 1 Herb for 5g), and each sends its reducer with quantity 1', async () => {
    // WRONG IMPL KILLED: the old fixed "Purchase complete!" / "Sale complete!" lines, the buy
    // line on a sell (or the reverse), a price read from the wrong row (Potion buys at 10 and
    // sells at 0; Herb sells at 5), an ASCII hyphen for the minus sign, a missing quantity or
    // item name, and a Buy or Sell that no longer sends quantity 1.
    await bootMain('/');
    openShopWithOneItem();
    H.linkFrozen = false;

    findBuyButton().click();
    await waitForFeedback();
    expect(H.buy, 'the real buy reducer is called exactly once').toHaveBeenCalledOnce();
    expect(H.buy).toHaveBeenCalledWith({ shopId: 1, itemId: 1, qty: 1 });
    expect(shopFeedbackText(), 'the en buy line').toBe(`${CHECK} Bought 1 Potion (${MINUS}10g)`);

    await freshShopFeedback();
    findSellButton().click();
    await waitForFeedback();
    expect(H.sell, 'the real sell reducer is called exactly once').toHaveBeenCalledOnce();
    expect(H.sell).toHaveBeenCalledWith({ itemId: 2, qty: 1 });
    expect(shopFeedbackText(), 'the en sell line').toBe(`${CHECK} Sold 1 Herb (+5g)`);
  });

  it('UIF4B.1 CTL7D-4-BOOT-LINE-FR: under fr (?locale=fr) a real Buy click and then a real Sell click each show the fr line naming the quantity, the item and the gold moved, which differs from the en line and from each other', async () => {
    // WRONG IMPL KILLED: an untranslated line (the en bytes under fr), a buy/sell id swap (the
    // sell line on a buy), the en "g" unit in a fr line, and the old fixed lines.
    await bootMain('/?locale=fr');
    openShopWithOneItem();
    H.linkFrozen = false;

    findBuyButton().click();
    await waitForFeedback();
    expect(H.buy, 'the real buy reducer is called exactly once').toHaveBeenCalledOnce();
    expect(H.buy).toHaveBeenCalledWith({ shopId: 1, itemId: 1, qty: 1 });
    const bought = shopFeedbackText();
    expect(bought, 'the fr buy line').toBe(`${CHECK} Achet${E_ACUTE} 1 Potion (${MINUS}10 or)`);
    expect(bought, 'not the en buy line').not.toBe(`${CHECK} Bought 1 Potion (${MINUS}10g)`);

    await freshShopFeedback();
    findSellButton().click();
    await waitForFeedback();
    expect(H.sell, 'the real sell reducer is called exactly once').toHaveBeenCalledOnce();
    expect(H.sell).toHaveBeenCalledWith({ itemId: 2, qty: 1 });
    const sold = shopFeedbackText();
    expect(sold, 'the fr sell line').toBe(`${CHECK} Vendu 1 Herb (+5 or)`);
    expect(sold, 'not the en sell line').not.toBe(`${CHECK} Sold 1 Herb (+5g)`);
    expect(sold, 'the sell line is not the buy line').not.toBe(bought);
  });
});

// ---------------------------------------------------------------------------
// RENAME + TRADE SESSION — rename via its real KeyN shortcut, the session-closed notice by a
// session row leaving the store. Red-team S2: a single non-shop success-line site reverted to its
// raw English literal survived with every gated test green; the rename frozen-link row pins the
// non-shop frozen line under fr.
// ---------------------------------------------------------------------------

describe('main.ts rename + trade-propose feedback routes through the i18n catalog (slice 21r-b red-team S2)', () => {
  it('UIF4B.1 ★ BITES: under fr, a frozen link on rename submit toasts CATALOG_FR["chrome.feedback.disconnected"], not the hardcoded English literal (kills a non-shop raw-literal revert)', async () => {
    // WRONG IMPL KILLED: the rename adapter's frozen-link arm left on the bare English literal (or
    // the en catalog's text) under fr; a frozen rename that reaches the reducer.
    await bootMain('/?locale=fr');
    focusCanvasAndPressKey('KeyN');
    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = 'NewName';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const submit = document.getElementById('rename-submit') as HTMLButtonElement;
    expect(submit.disabled, 'the submit button must be enabled for a non-empty draft').toBe(false);
    H.linkFrozen = true;

    submit.click();
    await waitForNonEmpty(renameFeedbackText);

    expect(renameFeedbackText()).toBe(FR['chrome.feedback.disconnected']);
    expect(renameFeedbackText()).not.toBe('disconnected — try again');
    expect(renameFeedbackText()).not.toBe(EN['chrome.feedback.disconnected']);
    expect(H.setProfileName, 'a frozen link must never reach the reducer').not.toHaveBeenCalled();
  });

  it('UIF4B.1 ★★ BITES: under fr, a successful rename toasts CATALOG_FR["chrome.rename.updated"], not the hardcoded "Name updated!"', async () => {
    await bootMain('/?locale=fr');
    focusCanvasAndPressKey('KeyN');

    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = 'NewName';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const submit = document.getElementById('rename-submit') as HTMLButtonElement;
    expect(submit.disabled, 'the submit button must be enabled for a non-empty draft').toBe(false);
    submit.click();
    await waitForNonEmpty(renameFeedbackText);

    expect(
      H.setProfileName,
      'the real reducer must have been called exactly once',
    ).toHaveBeenCalledOnce();
    expect(renameFeedbackText()).toBe(FR['chrome.rename.updated']);
    expect(renameFeedbackText()).not.toBe('Name updated!');
    expect(renameFeedbackText()).not.toBe(EN['chrome.rename.updated']);
  });

  // ts-3 (named intentional change, the Strangler): 'UIF4B.1 ★★ BITES: under fr, a successful
  // trade-propose submit toasts CATALOG_FR["tradePropose.feedback.sent"]' is replaced: the wizard,
  // its submit and its `tradePropose.*` keys are deleted (spec §ts-3 Strangler) and the session arms
  // have no success line. The trade site this suite now pins under fr is the session-closed notice.
  it('UIF4B.1 ts-3.6 ★★ BITES: under fr, a trade session leaving my_trade_session toasts CATALOG_FR["tradeSession.notice.closed"], not the hardcoded "Trade closed."', async () => {
    // WRONG IMPL KILLED: the closed notice toasted as an English literal (or the en catalog's text)
    // under fr; no closed notice at all.
    await bootMain('/?locale=fr');
    const store = storeHandle();
    const empty = { monsterIds: [], items: [], currency: 0n, cards: [] };
    store.reconcileTradeSessionsFromView([
      {
        sessionId: 61n,
        opener: H.identity,
        partner: OTHER,
        openerOffer: empty,
        partnerOffer: empty,
        openerConfirmed: false,
        partnerConfirmed: false,
        revision: 1n,
        createdAtMs: 900n,
      },
    ]);
    store.flushBatch();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(proposeFeedbackText(), 'precondition: the session arriving toasts nothing').toBe('');

    store.reconcileTradeSessionsFromView([]);
    store.flushBatch();
    await waitForNonEmpty(proposeFeedbackText);
    expect(proposeFeedbackText()).toBe(FR['tradeSession.notice.closed']);
    expect(proposeFeedbackText()).not.toBe('Trade closed.');
    expect(proposeFeedbackText()).not.toBe(EN['tradeSession.notice.closed']);
  });
});
