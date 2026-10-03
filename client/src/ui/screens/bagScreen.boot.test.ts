// @vitest-environment happy-dom
/**
 * bagScreen.boot.test.ts: the Bag (ctl-8f) booted through main.ts over the REAL client/index.html
 * shell, the REAL RaisingView and the REAL screen-adapter table (`SCREEN_ADAPTERS.raisingView` is
 * whatever ui/screens/index.ts ships: no stand-in is swapped in).
 *
 * - CTL8F-4-BOOT-KEYI: the legacy KeyI shows the raising root. The frame is not seated at its open
 *   (only the Social frame is), so the Bag paints at its first batch or its first button:
 *   (a) with a store holding items of three pockets, a store batch ALONE (no key after KeyI) paints
 *       the pocket tabs Bait | Food | Medicine, Bait selected, its item listed, the legacy inventory
 *       grid hidden; before that batch the bag parts are hidden and the legacy grid shows;
 *   (b) in a separate boot and open, an RB press ALONE (PageDown, the routed key; no batch after
 *       KeyI) paints them and moves to the second pocket, Food, with its item; the next RB reaches
 *       Medicine and LB comes back.
 *
 * EVERY key is dispatched ON `document.activeElement`, bubbling, like a real browser (the router
 * ignores keys a focused form control owns); the deferred initial focus (one macrotask after KeyI,
 * from ui/overlayA11y.ts) is flushed before the first key.
 *
 * Harness: tradeProposeScreen.boot.test.ts's (the real shell mounted, main.ts imported fresh per
 * boot, only the wasm pkg, the connection, telemetry and the world renderer stubbed). The store is
 * written through `opts.store` (the adapter-only ingest the connection would call) and a batch is
 * delivered with `flushBatch()`. No frame is run: a press reaches the adapter, and the adapter's
 * paint reaches the view, on the keydown.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from '../../convert/convert';
import type { Connection, ConnectionOptions } from '../../net/connection';
import type { StoreItemRow } from '../../net/store';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
}));

// wasm pkg: every name main.ts imports.
vi.mock('../../../../client-wasm/pkg/client_wasm.js', () => {
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

// The connection: capture the options; enqueueMove never settles, every other reducer resolves at
// once. sessionState() must be 'hidden' or the session gate swallows every key.
vi.mock('../../net/connection', () => {
  const reducers = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'enqueueMove') return () => new Promise<void>(() => {});
        return () => Promise.resolve();
      },
    },
  );
  const live = { reducers };
  const stub = {
    conn: undefined,
    live: () => live,
    identity: () => H.identity,
    linkFrozen: () => false,
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
  } as unknown as Connection;
  return {
    connect: (opts: ConnectionOptions): Connection => {
      H.connectOpts = opts;
      return stub;
    },
  };
});

vi.mock('../../observability/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../observability/telemetry')>();
  return {
    ...actual,
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
});

// The renderer: init appends a focusable canvas to the mount, so main.ts finds its world region.
vi.mock('../../render/world', () => {
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

/** Record every listener added to `target`, so the teardown removes main.ts's module-scope ones
 *  (a fresh import per boot would otherwise stack them). */
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
  const htmlPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'index.html',
  );
  const parsed = new DOMParser().parseFromString(readFileSync(htmlPath, 'utf8'), 'text/html');
  const children = Array.from(parsed.body.children).filter((el) => el.tagName !== 'SCRIPT');
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'index.html must yield a body to mount').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

const clock = { t: 0 };
let opts: ConnectionOptions;

/** Boot a fresh main.ts over the real shell and wait for it to connect. No frame ever runs: the
 *  rAF stub never calls back. */
async function bootReady(): Promise<void> {
  H.connectOpts = null;
  clock.t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  vi.stubGlobal('requestAnimationFrame', (): number => 0);
  vi.resetModules();
  await import('../../main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
  opts.onReady(H.identity);
}

function teardownBoot(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

/** Let queued microtasks and zero-delay timers run (the deferred focus). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const EID = 7n;

/** Deliver one authoritative batch at clock `at`: the own player + character, plus whatever the case
 *  put in the store since the last batch. The player upsert marks the store dirty, so every call is
 *  a batch. */
function server(at: number): void {
  clock.t = at;
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
    at,
  );
  opts.store.flushBatch();
}

function itemDef(id: number, name: string, over: Partial<StoreItemRow>): StoreItemRow {
  return {
    id,
    name,
    description: `About ${name}.`,
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 0n,
    cureStatus: null,
    ...over,
  };
}

/** Three pockets: bait (item 1), food (item 2), medicine (item 3); one stack of each. Delivered in
 *  one batch (the raising frame is closed, so no adapter hears it). */
function seedBag(): void {
  opts.store.upsertItemDef(itemDef(1, 'Lure Berry', { recruitBonus: 10 }));
  opts.store.upsertItemDef(itemDef(2, 'Power Root', { trainStat: 'attack', trainAmount: 2 }));
  opts.store.upsertItemDef(itemDef(3, 'Antidote', { cureStatus: 'Poison' }));
  opts.store.reconcileInventoryFromView([
    { invId: 101n, ownerIdentity: H.identity, itemId: 1, count: 4 },
    { invId: 102n, ownerIdentity: H.identity, itemId: 2, count: 3 },
    { invId: 103n, ownerIdentity: H.identity, itemId: 3, count: 1 },
  ]);
  server(1000);
}

/** A keydown at `at` on the ELEMENT THAT HAS FOCUS (the body when nothing does) and its keyup 5 ms
 *  later on whatever has focus then. Both bubble to the window listeners, as in a browser. */
function press(code: string, at: number): void {
  clock.t = at;
  const down = (document.activeElement ?? document.body) as HTMLElement;
  down.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  clock.t = at + 5;
  const up = (document.activeElement ?? document.body) as HTMLElement;
  up.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} must be in the document`);
  return found;
}
function testEl(testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`[data-testid="${testId}"] must be in the document`);
  return found;
}

/** The raising root is on screen: the title's parent is the root and its inline display is not none. */
const raisingShown = (): boolean =>
  (testEl('raising-title').parentElement as HTMLElement).style.display !== 'none';

/** The whole context stack through the read-only `__game()` DEV hook, as base-first frame names. */
const stackNames = (): string[] =>
  (
    window as unknown as {
      __game: () => { stack: Array<{ kind: string; id?: string }> };
    }
  )
    .__game()
    .stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));

const tabEls = (): HTMLElement[] => [
  ...el('bag-tabs').querySelectorAll<HTMLElement>('.mr-nav-tab'),
];
const tabs = (): Array<[string | undefined, string | null, string | null]> =>
  tabEls().map((t) => [t.dataset.navTab, t.textContent, t.getAttribute('aria-selected')]);
const rows = (): HTMLElement[] => [...el('bag-list').querySelectorAll<HTMLElement>('.mr-nav-item')];
const rowTexts = (): Array<[string | undefined, string | null]> =>
  rows().map((r) => [r.dataset.navKey, r.textContent]);

describe('the Bag booted through main.ts over the real view and adapter table (ctl-8f)', {
  sequential: true,
}, () => {
  afterEach(teardownBoot);

  it('CTL8F-4-BOOT-KEYI: KeyI shows the raising root with the bag parts hidden and the legacy grid showing; (a) one store batch alone paints the pocket tabs Bait | Food | Medicine (Bait selected), its item with the cursor, and hides the legacy grid; (b) in a separate boot, a PageDown (RB) alone, with no batch after the open, paints them and moves to Food, its item listed, the next RB to Medicine and LB back', async () => {
    // WRONG IMPL KILLED: the legacy adapter on the raising frame (RB is unhandled and nothing is
    // painted: the Bag is the legacy grid forever); an adapter that paints only at a button, so a
    // batch alone leaves the grid (the first observe after an open must answer a new state); one
    // that paints only on a batch, so a first RB press does nothing visible; a view that shows the
    // bag parts before any paint; a tab strip that is not built from the store's item definitions
    // and rows (the fixture holds three pockets and no `other`); an RB that does not reach the
    // adapter through the routed PageDown; and a paint that does not hide the legacy grid.
    // (a) a batch alone.
    await bootReady();
    seedBag();
    expect(raisingShown(), 'precondition: the raising root starts closed').toBe(false);

    press('KeyI', 1010);
    expect(raisingShown(), 'KeyI shows the raising root').toBe(true);
    expect(stackNames()).toEqual(['world', 'raisingView']);
    await flush();
    for (const id of ['bag-tabs', 'bag-list', 'bag-sheet', 'bag-info', 'bag-picker']) {
      expect(el(id).style.display, `#${id} is hidden before the first paint`).toBe('none');
    }
    expect(el('raising-inventory').style.display, 'the legacy grid shows until then').not.toBe(
      'none',
    );

    server(1100);
    expect(tabs(), 'a batch alone painted the tabs, Bait selected').toEqual([
      ['bait', 'Bait', 'true'],
      ['food', 'Food', 'false'],
      ['medicine', 'Medicine', 'false'],
    ]);
    expect(el('bag-tabs').style.display, 'and shows them').not.toBe('none');
    expect(el('bag-list').style.display).not.toBe('none');
    expect(rowTexts(), 'Bait`s one item').toEqual([['1', 'Lure Berry (x4)']]);
    expect(
      rows().map((r) => r.classList.contains('is-active')),
      'with the cursor on it',
    ).toEqual([true]);
    expect(el('raising-inventory').style.display, 'the legacy grid is hidden').toBe('none');
    expect(el('bag-sheet').style.display, 'no sheet on open').toBe('none');

    // (b) an RB press alone, in a separate boot and a separate open.
    teardownBoot();
    await bootReady();
    seedBag();
    press('KeyI', 1010);
    expect(raisingShown(), 'KeyI shows the raising root again').toBe(true);
    await flush();
    expect(el('bag-tabs').style.display, 'nothing painted yet: no batch since the open').toBe(
      'none',
    );

    press('PageDown', 1100);
    expect(tabs(), 'RB alone painted the tabs and moved to Food').toEqual([
      ['bait', 'Bait', 'false'],
      ['food', 'Food', 'true'],
      ['medicine', 'Medicine', 'false'],
    ]);
    expect(rowTexts(), 'Food`s item').toEqual([['2', 'Power Root (x3)']]);
    expect(el('raising-inventory').style.display, 'the legacy grid is hidden').toBe('none');
    expect(raisingShown(), 'RB does not close the raising root').toBe(true);

    press('PageDown', 1200);
    expect(tabs().map((t) => t[2])).toEqual(['false', 'false', 'true']);
    expect(rowTexts()).toEqual([['3', 'Antidote (x1)']]);
    press('PageUp', 1300);
    expect(
      tabs().map((t) => t[2]),
      'LB comes back to Food',
    ).toEqual(['false', 'true', 'false']);
    expect(rowTexts()).toEqual([['2', 'Power Root (x3)']]);
  });
});
