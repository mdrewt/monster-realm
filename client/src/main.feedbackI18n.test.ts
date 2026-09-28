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
 * proves a key is REQUESTED somewhere in main.ts, never WHICH call site claims it — a
 * accepted<->rejected or completed<->cancelled key swap across the four trade actions, or a
 * single non-shop site (trade frozen-link, rename success, trade-propose success) reverted to
 * its raw English literal, both survived mutation with every gated test green. The trade/rename/
 * trade-propose suites below open each overlay via its REAL keyboard shortcut (KeyU/KeyN/KeyO —
 * no NPC/dialogue needed, unlike shop) and drive its REAL submit path, asserting each action's
 * feedback against its OWN catalog key (never just "some key differs from en") plus the right
 * reducer spy + args.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOptions } from './net/connection';
import type {
  StoreInventory,
  StoreItemRow,
  StorePlayer,
  StoreShopItemRow,
  StoreShopRow,
  StoreTradeOffer,
  StoreWallet,
} from './net/store';
import { CATALOG_EN } from './ui/i18n/catalog.en';
import { CATALOG_FR } from './ui/i18n/catalog.fr';

const EN = CATALOG_EN as unknown as Record<string, string>;
const FR = CATALOG_FR as unknown as Record<string, string>;

/** A second identity (64 hex chars, `Identity`-constructible) for the trade/trade-propose
 *  counterparty. */
const OTHER = 'cd'.repeat(32);
const TRADE_ID = 10n;

const H = vi.hoisted(() => {
  const buy = vi.fn(() => Promise.resolve());
  const sell = vi.fn(() => Promise.resolve());
  const respondTrade = vi.fn(() => Promise.resolve());
  const confirmTrade = vi.fn(() => Promise.resolve());
  const cancelTrade = vi.fn(() => Promise.resolve());
  const setProfileName = vi.fn(() => Promise.resolve());
  const proposeTrade = vi.fn(() => Promise.resolve());
  return {
    identity: 'ab'.repeat(32),
    connectOpts: null as unknown,
    /** Mutated per test AFTER boot, read live by the mocked Connection's `linkFrozen()`. */
    linkFrozen: false,
    buy,
    sell,
    respondTrade,
    confirmTrade,
    cancelTrade,
    setProfileName,
    proposeTrade,
    /** `conn.live()`'s return — the census roster can't tell which reducer a call site
     *  targets, so the SUCCESS-line tests below spy on the real reducer names directly. */
    live: {
      reducers: {
        buy,
        sell,
        respondTrade,
        confirmTrade,
        cancelTrade,
        setProfileName,
        proposeTrade,
      },
    } as unknown,
  };
});

// Same wasm mock shape as main.partyFull.test.ts / main.i18nBoot.test.ts.
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

// `linkFrozen` reads H.linkFrozen LIVE (never a snapshot) so a test can flip it AFTER boot,
// once the shop overlay is already open — the site under test is main.ts's onBuy handler
// reading `conn.linkFrozen()` at CLICK time, not at connect() time.
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

function buildAppShellFromRealIndexHtml(): void {
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const bodyChildren = Array.from(parsed.body.children).filter((e) => e.tagName !== 'SCRIPT');
  expect(
    bodyChildren.length,
    'parsed index.html yielded no usable <body> children',
  ).toBeGreaterThan(5);
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

function shopFeedbackText(): string {
  return document.getElementById('shop-feedback')?.textContent ?? '';
}

/** Waits for a non-empty `#shop-feedback` — the success arms await a reducer promise (a real
 *  microtask hop) before calling `showFeedback`, unlike the synchronous frozen-link arm. */
async function waitForFeedback(): Promise<void> {
  await vi.waitFor(
    () => {
      if (shopFeedbackText() === '') throw new Error('shop-feedback has not rendered yet');
    },
    { timeout: 2_000, interval: 5 },
  );
}

/** Generic sibling of `waitForFeedback` for the trade/rename/trade-propose overlays below —
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

/** Seeds ONE trade offer involving `H.identity` (initiator or counterparty per `opts`), then
 *  opens the REAL trade overlay via the REAL `KeyU` shortcut (`main.ts`'s `openTrade()` —
 *  `overlayVerdict('tradeView').kind === 'allow' && worldHasFocus()`), the same "real input,
 *  no NPC/dialogue" path `main.partyFull.test.ts`'s `openBoxAndFindToParty` uses for Box/KeyB. */
function openTradeWithOffer(opts: {
  readonly viewerIsInitiator: boolean;
  readonly status: 'Pending' | 'ConfirmedByCounterparty';
}): void {
  const store = storeHandle();
  const offer: StoreTradeOffer = {
    tradeId: TRADE_ID,
    initiator: opts.viewerIsInitiator ? H.identity : OTHER,
    counterparty: opts.viewerIsInitiator ? OTHER : H.identity,
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status: opts.status,
    createdAtMs: 0n,
  };
  store.upsertTradeOffer(offer);
  store.flushBatch();
  focusCanvasAndPressKey('KeyU');
}

function findTradeActionButton(
  action: 'accept' | 'reject' | 'confirm' | 'cancel',
): HTMLButtonElement {
  const btn = document.querySelector(`#trade-actions button[data-action="${action}"]`);
  expect(
    btn,
    `the trade overlay must render a "${action}" button for the seeded offer`,
  ).not.toBeNull();
  return btn as HTMLButtonElement;
}

function tradeFeedbackText(): string {
  return document.getElementById('trade-feedback')?.textContent ?? '';
}

function renameFeedbackText(): string {
  return document.getElementById('rename-feedback')?.textContent ?? '';
}

function proposeFeedbackText(): string {
  return document.getElementById('tradepropose-feedback')?.textContent ?? '';
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
  H.buy.mockClear();
  H.sell.mockClear();
  H.respondTrade.mockClear();
  H.confirmTrade.mockClear();
  H.cancelTrade.mockClear();
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
  it('★★ BITES: under fr (?locale=fr), a frozen link shows CATALOG_FR["chrome.feedback.disconnected"] on Buy, not the hardcoded English literal', async () => {
    await bootMain('/?locale=fr');
    openShopWithOneItem();
    H.linkFrozen = true;

    findBuyButton().click();
    await Promise.resolve();

    expect(shopFeedbackText()).toBe(FR['chrome.feedback.disconnected']);
    expect(shopFeedbackText()).not.toBe('disconnected — try again');
    expect(shopFeedbackText()).not.toBe(EN['chrome.feedback.disconnected']);
  });

  it('★ BITES: under en, a frozen link still shows the exact pre-migration English line on Buy', async () => {
    await bootMain('/');
    openShopWithOneItem();
    H.linkFrozen = true;

    findBuyButton().click();
    await Promise.resolve();

    expect(shopFeedbackText()).toBe('disconnected — try again');
    expect(shopFeedbackText()).toBe(EN['chrome.feedback.disconnected']);
  });

  // ---------------------------------------------------------------------------
  // SUCCESS lines — the §5.3 census roster proves EVERY literal key main.ts requests, but
  // cannot tell WHICH call site (buy vs. sell vs. trade) claims which key — a implementer could
  // satisfy the census with 'shop.feedback.purchased' wired to onSell and vice versa and every
  // roster/parity test would stay green. These tests click the REAL Buy/Sell buttons and assert
  // the rendered text against the SPECIFIC catalog key, catching exactly that swap.
  // ---------------------------------------------------------------------------

  it('★★ BITES: under fr, a successful Buy shows CATALOG_FR["shop.feedback.purchased"], not the hardcoded "Purchase complete!"', async () => {
    await bootMain('/?locale=fr');
    openShopWithOneItem();
    H.linkFrozen = false;

    findBuyButton().click();
    await waitForFeedback();

    expect(H.buy, 'the real buy reducer must have been called exactly once').toHaveBeenCalledOnce();
    expect(shopFeedbackText()).toBe(FR['shop.feedback.purchased']);
    expect(shopFeedbackText()).not.toBe('Purchase complete!');
    expect(shopFeedbackText()).not.toBe(EN['shop.feedback.purchased']);
  });

  it('★ BITES: under en, a successful Buy shows the exact pre-migration "Purchase complete!" line', async () => {
    await bootMain('/');
    openShopWithOneItem();
    H.linkFrozen = false;

    findBuyButton().click();
    await waitForFeedback();

    expect(H.buy).toHaveBeenCalledOnce();
    expect(shopFeedbackText()).toBe('Purchase complete!');
    expect(shopFeedbackText()).toBe(EN['shop.feedback.purchased']);
  });

  it('★★ BITES: under fr, a successful Sell shows CATALOG_FR["shop.feedback.sold"], not "Sale complete!" (kills a purchased/sold key swap)', async () => {
    await bootMain('/?locale=fr');
    openShopWithOneItem();
    H.linkFrozen = false;

    findSellButton().click();
    await waitForFeedback();

    expect(
      H.sell,
      'the real sell reducer must have been called exactly once',
    ).toHaveBeenCalledOnce();
    expect(shopFeedbackText()).toBe(FR['shop.feedback.sold']);
    expect(shopFeedbackText()).not.toBe('Sale complete!');
    expect(shopFeedbackText(), 'a purchased/sold key swap must not pass by accident').not.toBe(
      FR['shop.feedback.purchased'],
    );
  });
});

// ---------------------------------------------------------------------------
// TRADE — table-driven over the four actions (red-team S1: accepted<->rejected and
// completed<->cancelled key swaps survived with every gated test green). Each row opens the
// REAL trade overlay via the REAL KeyU shortcut (openTradeWithOffer — no NPC/dialogue needed,
// unlike shop) with a seeded offer shaped so exactly the action under test is available, clicks
// the REAL button, and asserts the feedback against its OWN fr key — and explicitly against
// every SIBLING trade key, so a swap cannot pass by accident — plus the right reducer spy+args.
// ---------------------------------------------------------------------------

interface TradeCase {
  readonly action: 'accept' | 'reject' | 'confirm' | 'cancel';
  readonly viewerIsInitiator: boolean;
  readonly status: 'Pending' | 'ConfirmedByCounterparty';
  readonly frKey: string;
  readonly enLiteral: string;
}

const TRADE_CASES: readonly TradeCase[] = [
  {
    action: 'accept',
    viewerIsInitiator: false,
    status: 'Pending',
    frKey: 'trade.feedback.accepted',
    enLiteral: 'Trade accepted!',
  },
  {
    action: 'reject',
    viewerIsInitiator: false,
    status: 'Pending',
    frKey: 'trade.feedback.rejected',
    enLiteral: 'Trade rejected.',
  },
  {
    action: 'confirm',
    viewerIsInitiator: true,
    status: 'ConfirmedByCounterparty',
    frKey: 'trade.feedback.completed',
    enLiteral: 'Trade complete!',
  },
  {
    action: 'cancel',
    viewerIsInitiator: true,
    status: 'Pending',
    frKey: 'trade.feedback.cancelled',
    enLiteral: 'Trade cancelled.',
  },
];
const TRADE_FR_KEYS = TRADE_CASES.map((c) => c.frKey);

describe('main.ts trade feedback routes through the i18n catalog, per-action (slice 21r-b red-team S1)', () => {
  it.each(
    TRADE_CASES,
  )('★★ BITES: under fr, trade $action shows CATALOG_FR[$frKey] — never a sibling trade key — and fires the right reducer with the right args', async ({
    action,
    viewerIsInitiator,
    status,
    frKey,
    enLiteral,
  }) => {
    await bootMain('/?locale=fr');
    openTradeWithOffer({ viewerIsInitiator, status });
    H.linkFrozen = false;

    findTradeActionButton(action).click();
    await waitForNonEmpty(tradeFeedbackText);

    expect(tradeFeedbackText(), `${action} must show its OWN fr key`).toBe(FR[frKey]);
    expect(tradeFeedbackText()).not.toBe(enLiteral);
    for (const otherKey of TRADE_FR_KEYS) {
      if (otherKey === frKey) continue;
      expect(
        tradeFeedbackText(),
        `${action} must not show a SIBLING trade key's fr value (${otherKey}) — kills an ` +
          'accepted<->rejected / completed<->cancelled key swap',
      ).not.toBe(FR[otherKey]);
    }

    switch (action) {
      case 'accept':
        expect(H.respondTrade).toHaveBeenCalledOnce();
        expect(H.respondTrade).toHaveBeenCalledWith({ tradeId: TRADE_ID, accepted: true });
        break;
      case 'reject':
        expect(H.respondTrade).toHaveBeenCalledOnce();
        expect(H.respondTrade).toHaveBeenCalledWith({ tradeId: TRADE_ID, accepted: false });
        break;
      case 'confirm':
        expect(H.confirmTrade).toHaveBeenCalledOnce();
        expect(H.confirmTrade).toHaveBeenCalledWith({ tradeId: TRADE_ID });
        break;
      case 'cancel':
        expect(H.cancelTrade).toHaveBeenCalledOnce();
        expect(H.cancelTrade).toHaveBeenCalledWith({ tradeId: TRADE_ID });
        break;
    }
  });

  it('★ BITES: under fr, a frozen link on trade Accept shows CATALOG_FR["chrome.feedback.disconnected"], not the hardcoded English literal (kills a non-shop raw-literal revert)', async () => {
    await bootMain('/?locale=fr');
    openTradeWithOffer({ viewerIsInitiator: false, status: 'Pending' });
    H.linkFrozen = true;

    findTradeActionButton('accept').click();
    await waitForNonEmpty(tradeFeedbackText);

    expect(tradeFeedbackText()).toBe(FR['chrome.feedback.disconnected']);
    expect(tradeFeedbackText()).not.toBe('disconnected — try again');
    expect(tradeFeedbackText()).not.toBe(EN['chrome.feedback.disconnected']);
    expect(H.respondTrade, 'a frozen link must never reach the reducer').not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RENAME + TRADE-PROPOSE — both reachable at modest cost via their real KeyN/KeyO shortcuts
// (no NPC/dialogue, same as trade). Red-team S2: a single non-shop success-line site reverted
// to its raw English literal survived with every gated test green.
// ---------------------------------------------------------------------------

describe('main.ts rename + trade-propose feedback routes through the i18n catalog (slice 21r-b red-team S2)', () => {
  it('★★ BITES: under fr, a successful rename shows CATALOG_FR["chrome.rename.updated"], not the hardcoded "Name updated!"', async () => {
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

  it('★★ BITES: under fr, a successful trade-propose submit shows CATALOG_FR["tradePropose.feedback.sent"], not the hardcoded "Offer sent!"', async () => {
    await bootMain('/?locale=fr');
    const store = storeHandle();
    store.upsertPlayer({
      identity: OTHER,
      entityId: 1n,
      name: 'Bob',
      online: true,
      lastInputSeq: 0n,
    });
    store.flushBatch();

    focusCanvasAndPressKey('KeyO');

    const target = document.getElementById('tradepropose-target') as HTMLSelectElement;
    target.value = OTHER;
    target.dispatchEvent(new Event('change', { bubbles: true }));
    const offerCurrency = document.getElementById(
      'tradepropose-offer-currency',
    ) as HTMLInputElement;
    offerCurrency.value = '10';
    offerCurrency.dispatchEvent(new Event('input', { bubbles: true }));

    const submit = document.getElementById('tradepropose-submit') as HTMLButtonElement;
    expect(
      submit.disabled,
      'the submit button must be enabled once a target + an asset are set',
    ).toBe(false);
    submit.click();
    await waitForNonEmpty(proposeFeedbackText);

    expect(
      H.proposeTrade,
      'the real reducer must have been called exactly once',
    ).toHaveBeenCalledOnce();
    expect(proposeFeedbackText()).toBe(FR['tradePropose.feedback.sent']);
    expect(proposeFeedbackText()).not.toBe('Offer sent!');
    expect(proposeFeedbackText()).not.toBe(EN['tradePropose.feedback.sent']);
  });
});
