// @vitest-environment happy-dom
/**
 * main.feedbackCore.test.ts — booted-app gate for slice pgcc-a (A4 + the A3 care line through the
 * real raising overlay).
 *
 * pgcc-a routes care and the eight inline feedback sites (shop buy/sell, trade x4, rename,
 * trade-propose) through ONE core (`performCare`, ui/careAction.ts). The core is visibility-agnostic
 * by design (careAction.test.ts proves it), so each main.ts call site's `showFeedback` closure owns
 * the "paint only while the overlay is visible" rule. That rule is invisible to the core's unit
 * tests; this file proves it end to end, one test per view, against the REAL main.ts.
 *
 * HARNESS — copied from main.feedbackI18n.test.ts (the REAL main.ts booted against the REAL
 * index.html shell; wasm pkg, './net/connection', telemetry and './render/world' mocked; module-scope
 * listeners recorded and detached per test). Reducer spies return promises the test HOLDS OPEN so the
 * overlay can be hidden while a call is in flight.
 *
 * HIDING: each view's `visible` getter reads its overlay's own `style.display !== 'none'`, so the
 * tests flip exactly that flag on the overlay element (the same one `hide()` writes) and leave
 * everything else alone. A feedback node that is still EMPTY after the call settles proves the
 * closure did not paint into a hidden overlay. Every hidden test first proves the action really ran
 * (the reducer spy was called once with the expected args), so none of them can pass vacuously.
 *
 * EXPECTED STATE AT THE RED PHASE: the four PGCCA-A4-HIDDEN-* tests are CHARACTERIZATION tests of a
 * behaviour-preserving refactor — today's inline `if (view?.visible)` guards already satisfy them,
 * so they are expected GREEN now and must STAY green after the refactor (they are the wiring guard
 * that a closure dropped from a routed call site would trip). PGCCA-A4-CARE-BOOT-FR is RED today:
 * main.ts's care adapter hands the core the hardcoded English "Cared!".
 *
 * `raising.feedback.cared` is not yet a `MessageId`, so it is read off CATALOG_FR through a widened
 * `Record<string, string>` cast: the file fails on a MISSING/WRONG catalog value (an assertion),
 * never on a TS/import error.
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
import { CATALOG_FR } from './ui/i18n/catalog.fr';

const FR = CATALOG_FR as unknown as Record<string, string>;

/** A second identity (64 hex chars, `Identity`-constructible) for the trade counterparty. */
const OTHER = 'cd'.repeat(32);
const TRADE_ID = 10n;

const H = vi.hoisted(() => {
  const buy = vi.fn((_args: unknown) => Promise.resolve());
  const respondTrade = vi.fn((_args: unknown) => Promise.resolve());
  const setProfileName = vi.fn((_args: unknown) => Promise.resolve());
  const proposeTrade = vi.fn((_args: unknown) => Promise.resolve());
  const care = vi.fn((_args: unknown) => Promise.resolve());
  return {
    identity: 'ab'.repeat(32),
    connectOpts: null as unknown,
    buy,
    respondTrade,
    setProfileName,
    proposeTrade,
    care,
    live: { reducers: { buy, respondTrade, setProfileName, proposeTrade, care } } as unknown,
  };
});

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
    linkFrozen: () => false,
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

beforeEach(() => {
  recorded = [];
  H.connectOpts = null;
  H.buy.mockClear();
  H.respondTrade.mockClear();
  H.setProfileName.mockClear();
  H.proposeTrade.mockClear();
  H.care.mockClear();
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

/** A reducer promise the test controls: it stays pending until `release()`. */
function holdOpen(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Two macrotask turns: every microtask continuation (the core's await, the view's .finally) has
 *  run by the time this resolves. */
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

/** Seed one shop + one for-sale item, flip `#shop-overlay` open (the flag ShopView.show() writes
 *  and ShopView.visible reads) and flush ONE batch so the REAL listener renders the REAL Buy
 *  button — main.feedbackI18n.test.ts's documented short-circuit (a real open needs an NPC +
 *  dialogue round-trip, orthogonal to this slice). */
function openShopWithOneItem(): HTMLButtonElement {
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
  store.upsertWallet({ ownerIdentity: H.identity, balance: 100n });
  const overlay = document.getElementById('shop-overlay');
  expect(overlay, 'shop-overlay must exist in the real index.html shell').not.toBeNull();
  (overlay as HTMLElement).style.display = '';
  store.flushBatch();
  const btn = document.querySelector('#shop-for-sale button');
  expect(btn, 'the shop overlay must render a Buy button for the seeded item').not.toBeNull();
  return btn as HTMLButtonElement;
}

/** Seed ONE pending offer addressed to the viewer, then open the REAL trade overlay via the REAL
 *  KeyU shortcut and return its Accept button. */
function openTradeAndFindAccept(): HTMLButtonElement {
  const store = storeHandle();
  store.upsertTradeOffer({
    tradeId: TRADE_ID,
    initiator: OTHER,
    counterparty: H.identity,
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status: 'Pending',
    createdAtMs: 0n,
  });
  store.flushBatch();
  focusCanvasAndPressKey('KeyU');
  const btn = document.querySelector('#trade-actions button[data-action="accept"]');
  expect(
    btn,
    'the trade overlay must render an "accept" button for the seeded offer',
  ).not.toBeNull();
  return btn as HTMLButtonElement;
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

describe('main.ts feedback sites paint only while their overlay is visible (slice pgcc-a, A4)', () => {
  it('PGCCA-A4-HIDDEN-SHOP: a Buy that settles after #shop-overlay was hidden paints no success line', async () => {
    // WRONG IMPL KILLED: the shop closure routed through the core WITHOUT its visibility guard —
    // the success line would land in the hidden overlay and greet the next open.
    await bootMain('/');
    const buyBtn = openShopWithOneItem();
    const held = holdOpen();
    H.buy.mockImplementationOnce(() => held.promise);

    buyBtn.click();
    expect(H.buy, 'the Buy action must have reached the reducer').toHaveBeenCalledOnce();
    expect(H.buy).toHaveBeenCalledWith({ shopId: 1, itemId: 1, qty: 1 });
    expect(textOf('shop-feedback'), 'nothing may paint while the call is pending').toBe('');

    hideOverlay('shop-overlay');
    held.release();
    await settle();

    expect(textOf('shop-feedback'), 'a hidden shop overlay must not be painted into').toBe('');
  });

  it('PGCCA-A4-HIDDEN-TRADE: an Accept that settles after #trade-overlay was hidden paints no success line', async () => {
    // WRONG IMPL KILLED: the trade closure routed through the core WITHOUT its visibility guard.
    await bootMain('/');
    const acceptBtn = openTradeAndFindAccept();
    const held = holdOpen();
    H.respondTrade.mockImplementationOnce(() => held.promise);

    acceptBtn.click();
    expect(
      H.respondTrade,
      'the Accept action must have reached the reducer',
    ).toHaveBeenCalledOnce();
    expect(H.respondTrade).toHaveBeenCalledWith({ tradeId: TRADE_ID, accepted: true });
    expect(textOf('trade-feedback'), 'nothing may paint while the call is pending').toBe('');

    hideOverlay('trade-overlay');
    held.release();
    await settle();

    expect(textOf('trade-feedback'), 'a hidden trade overlay must not be painted into').toBe('');
  });

  it('PGCCA-A4-HIDDEN-RENAME: a rename that settles after #rename-overlay was hidden paints no success line', async () => {
    // WRONG IMPL KILLED: the rename closure routed through the core WITHOUT its visibility guard.
    await bootMain('/');
    focusCanvasAndPressKey('KeyN');
    const input = document.getElementById('rename-input') as HTMLInputElement;
    input.value = 'NewName';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const submit = document.getElementById('rename-submit') as HTMLButtonElement;
    expect(submit.disabled, 'submit must be enabled for a non-empty draft').toBe(false);
    const held = holdOpen();
    H.setProfileName.mockImplementationOnce(() => held.promise);

    submit.click();
    expect(H.setProfileName, 'the rename must have reached the reducer').toHaveBeenCalledOnce();
    expect(H.setProfileName).toHaveBeenCalledWith({ name: 'NewName' });
    expect(textOf('rename-feedback'), 'nothing may paint while the call is pending').toBe('');

    hideOverlay('rename-overlay');
    held.release();
    await settle();

    expect(textOf('rename-feedback'), 'a hidden rename overlay must not be painted into').toBe('');
  });

  it('PGCCA-A4-HIDDEN-PROPOSE: a trade proposal that settles after #tradepropose-overlay was hidden paints no success line', async () => {
    // WRONG IMPL KILLED: the trade-propose closure routed through the core WITHOUT its visibility
    // guard.
    await bootMain('/');
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
    expect(submit.disabled, 'submit must be enabled once a target + an asset are set').toBe(false);
    const held = holdOpen();
    H.proposeTrade.mockImplementationOnce(() => held.promise);

    submit.click();
    expect(H.proposeTrade, 'the proposal must have reached the reducer').toHaveBeenCalledOnce();
    expect(H.proposeTrade).toHaveBeenCalledWith(
      expect.objectContaining({ initiatorCurrency: 10n, counterpartyCurrency: 0n }),
    );
    expect(textOf('tradepropose-feedback'), 'nothing may paint while pending').toBe('');

    hideOverlay('tradepropose-overlay');
    held.release();
    await settle();

    expect(
      textOf('tradepropose-feedback'),
      'a hidden trade-propose overlay must not be painted into',
    ).toBe('');
  });
});

describe('main.ts care success line resolves through the catalog under fr (slice pgcc-a, A3 via the real overlay)', () => {
  it('PGCCA-A4-CARE-BOOT-FR: under ?locale=fr, clicking Care in the real raising overlay shows CATALOG_FR["raising.feedback.cared"], not "Cared!"', async () => {
    // WRONG IMPL KILLED: main.ts's care adapter handing the core the hardcoded English "Cared!"
    // (the pre-pgcc-a defect), or the key present in en only.
    await bootMain('/?locale=fr');
    storeHandle().reconcileMonstersFromView([monster(1n, 0)]);
    storeHandle().flushBatch();

    // The REAL KeyI shortcut: main.ts toggles the raising overlay and refreshes it from the store.
    focusCanvasAndPressKey('KeyI');
    const feedbackEl = document.getElementById('raising-feedback');
    expect(feedbackEl, 'the raising overlay must be constructed by main.ts').not.toBeNull();
    const careBtn = feedbackEl?.parentElement?.querySelector('button');
    expect(careBtn, 'a Care button must render for the seeded monster').toBeTruthy();

    (careBtn as HTMLButtonElement).click();
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
