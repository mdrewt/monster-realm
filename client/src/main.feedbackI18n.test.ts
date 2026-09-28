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
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOptions } from './net/connection';
import type { StoreItemRow, StoreShopItemRow, StoreShopRow, StoreWallet } from './net/store';
import { CATALOG_EN } from './ui/i18n/catalog.en';
import { CATALOG_FR } from './ui/i18n/catalog.fr';

const EN = CATALOG_EN as unknown as Record<string, string>;
const FR = CATALOG_FR as unknown as Record<string, string>;

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as unknown,
  /** Mutated per test AFTER boot, read live by the mocked Connection's `linkFrozen()`. */
  linkFrozen: false,
}));

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
    live: () => undefined,
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
  flushBatch(): void;
}

let opts!: ConnectionOptions;
let recorded: Recorded[] = [];
let restoreWindowAdd: (() => void) | undefined;
let restoreDocumentAdd: (() => void) | undefined;

function storeHandle(): StoreHandle {
  return (opts as unknown as { store: StoreHandle }).store;
}

/** Seed one shop with one for-sale item + a wallet row, then flip `#shop-overlay`'s own
 *  `style.display` (the header note explains why this — not a real dialogue round-trip — is
 *  the sane-cost open) and flush ONE batch so the REAL M13d listener renders the REAL Buy
 *  button. */
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

function shopFeedbackText(): string {
  return document.getElementById('shop-feedback')?.textContent ?? '';
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

describe('main.ts shop feedback routes through the i18n catalog (slice 21r-b, gate B1)', () => {
  beforeEach(() => {
    recorded = [];
    H.connectOpts = null;
    H.linkFrozen = false;
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
});
