// @vitest-environment happy-dom
/**
 * bagScreen.boot.test.ts: the Bag (ctl-8f) booted through main.ts over the REAL client/index.html
 * shell, the REAL RaisingView and the REAL screen-adapter table (`SCREEN_ADAPTERS.raisingView` is
 * whatever ui/screens/index.ts ships: no stand-in is swapped in).
 *
 * - CTL8F-4-BOOT-KEYI: KeyI opens the Bag. ctl-11a (named intentional changes): an accelerator pops
 *   to the base and opens its menu path, so the stack is the world, the menu, then the raising frame
 *   (was: the world, then the raising frame), and the Bag is painted AT THE OPEN (residual
 *   R-ctl-8f-CTL8F.1; was: the frame was not seated, so the Bag painted only at its first batch or
 *   its first button, and until then the bag parts were hidden and the legacy grid showed):
 *   (a) with a store holding items of three pockets, KeyI ALONE (no batch, no further key) paints
 *       the pocket tabs Bait | Food | Medicine, Bait selected, its item listed with the cursor, the
 *       legacy inventory grid hidden; a batch that adds a bait item repaints the pocket;
 *   (b) in a separate boot and open, an RB press (PageDown; no batch after KeyI) moves to the second
 *       pocket, Food, with its item; the next RB reaches Medicine and LB comes back.
 * - A second case (ctl-11a, same residual): the same at-the-open paint when the Bag is opened by
 *   picking it in the main menu (Start, move to Bag, A), which is the path KeyI takes.
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

/** The main menu's cursor entry key through the same hook (null while the menu is closed). */
const navActive = (): string | null =>
  (window as unknown as { __game: () => { navActive: string | null } }).__game().navActive;

const tabEls = (): HTMLElement[] => [
  ...el('bag-tabs').querySelectorAll<HTMLElement>('.mr-nav-tab'),
];
const tabs = (): Array<[string | undefined, string | null, string | null]> =>
  tabEls().map((t) => [t.dataset.navTab, t.textContent, t.getAttribute('aria-selected')]);
const rows = (): HTMLElement[] => [...el('bag-list').querySelectorAll<HTMLElement>('.mr-nav-item')];
const rowTexts = (): Array<[string | undefined, string | null]> =>
  rows().map((r) => [r.dataset.navKey, r.textContent]);

/** The Bag as the seeded store paints it at an open: the pocket tabs Bait | Food | Medicine shown
 *  with Bait selected, Bait's one item listed with the cursor on it, the legacy inventory grid
 *  hidden and no sheet. Read from the DOM, whenever the caller chooses (the open itself: nothing
 *  has run since the keys that opened the frame). */
function expectBaitPainted(label: string): void {
  expect(tabs(), `${label}: the pocket tabs, Bait selected`).toEqual([
    ['bait', 'Bait', 'true'],
    ['food', 'Food', 'false'],
    ['medicine', 'Medicine', 'false'],
  ]);
  expect(el('bag-tabs').style.display, `${label}: the tabs are shown`).not.toBe('none');
  expect(el('bag-list').style.display, `${label}: the list is shown`).not.toBe('none');
  expect(rowTexts(), `${label}: Bait's one item`).toEqual([['1', 'Lure Berry (x4)']]);
  expect(
    rows().map((r) => r.classList.contains('is-active')),
    `${label}: with the cursor on it`,
  ).toEqual([true]);
  expect(el('raising-inventory').style.display, `${label}: the legacy grid is hidden`).toBe('none');
  expect(el('bag-sheet').style.display, `${label}: no sheet on open`).toBe('none');
}

describe('the Bag booted through main.ts over the real view and adapter table (ctl-8f)', {
  sequential: true,
}, () => {
  afterEach(teardownBoot);

  it('CTL8F-4-BOOT-KEYI: KeyI shows the raising root over the menu (the world, the menu, then the raising frame) with the Bag painted AT THE OPEN, before any batch or button: (a) the pocket tabs Bait | Food | Medicine (Bait selected), its item with the cursor, the legacy grid hidden, and a batch that adds a bait item repaints the pocket; (b) in a separate boot, a PageDown (RB) after the open moves to Food, its item listed, the next RB to Medicine and LB back', async () => {
    // ctl-11a (named intentional changes), tag kept (KeyI still opens the Bag): (1) RETIRED: the
    // stack `['world', 'raisingView']`; REPLACED by `['world', 'menuView', 'raisingView']`, because an
    // accelerator now opens its menu path and the menu stays beneath the leaf (CTL11A.1). (2)
    // RETIRED: "the bag parts are hidden and the legacy grid shows until the first batch or button"
    // and "nothing painted yet: no batch since the open" (the defect of residual R-ctl-8f-CTL8F.1,
    // which the previous version of this test pinned); REPLACED by the Bag painted at the open, read
    // synchronously after the KeyI press with no batch and no further button. The batch repaint and
    // the RB / LB walk are kept.
    // WRONG IMPL KILLED: the legacy adapter on the raising frame (RB is unhandled and nothing is
    // painted: the Bag is the legacy grid forever); a frame that is not seated at its open (KeyI
    // leaves the bag parts hidden and the legacy grid showing until a batch or a button: the
    // residual); one that paints at the open and never again (a batch that adds an item leaves the
    // old pocket); a paint that waits for the deferred focus (the synchronous read right after the
    // press finds the parts hidden); a view that shows the bag parts but no paint; a tab strip that
    // is not built from the store's item definitions and rows (the fixture holds three pockets and
    // no `other`); an RB that does not reach the adapter through PageDown; a paint that does not
    // hide the legacy grid; and a stack that lacks the menu beneath the leaf.
    // (a) the open alone.
    await bootReady();
    seedBag();
    expect(raisingShown(), 'precondition: the raising root starts closed').toBe(false);

    press('KeyI', 1010);
    expect(raisingShown(), 'KeyI shows the raising root').toBe(true);
    expect(stackNames(), 'over the menu').toEqual(['world', 'menuView', 'raisingView']);
    expectBaitPainted('at the open, no batch and no button yet');
    await flush();
    expectBaitPainted('after the deferred focus');

    // A batch that adds a second bait item to the store repaints the open Bag.
    opts.store.upsertItemDef(itemDef(4, 'Sweet Bait', { recruitBonus: 20 }));
    opts.store.reconcileInventoryFromView([
      { invId: 101n, ownerIdentity: H.identity, itemId: 1, count: 4 },
      { invId: 102n, ownerIdentity: H.identity, itemId: 2, count: 3 },
      { invId: 103n, ownerIdentity: H.identity, itemId: 3, count: 1 },
      { invId: 104n, ownerIdentity: H.identity, itemId: 4, count: 2 },
    ]);
    server(1100);
    expect(rowTexts(), 'a batch that added a bait item repainted the pocket').toHaveLength(2);
    expect(rowTexts(), 'with the new item listed').toContainEqual(['4', 'Sweet Bait (x2)']);
    expect(
      rows()
        .filter((r) => r.classList.contains('is-active'))
        .map((r) => r.dataset.navKey),
      'and the cursor still on the item it was on',
    ).toEqual(['1']);
    expect(el('raising-inventory').style.display, 'the legacy grid stays hidden').toBe('none');

    // (b) an RB press after the open, in a separate boot and a separate open.
    teardownBoot();
    await bootReady();
    seedBag();
    press('KeyI', 1010);
    expect(raisingShown(), 'KeyI shows the raising root again').toBe(true);
    expectBaitPainted('at the open of the second boot');
    await flush();

    press('PageDown', 1100);
    expect(tabs(), 'RB moved to Food with no batch since the open').toEqual([
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

  it('CTL11A-BAG-PAINT-AT-OPEN: the Bag opened by picking it in the main menu (Start, move to Bag, A) is painted at that open, with no batch and no further button: the pocket tabs Bait | Food | Medicine with Bait selected, its item with the cursor, the legacy grid hidden, the menu cursor on Bag beneath it', async () => {
    // WRONG IMPL KILLED (residual R-ctl-8f-CTL8F.1, the menu half): a frame seated only on the
    // accelerator path (KeyI paints, the menu's own Bag entry does not: the open is the shared
    // `openMenuTarget`, and a seat parked in `runAccel` never runs for a pick); a first paint that
    // waits for the next batch or the first button (the tabs are hidden and the legacy grid shows
    // until then); a paint at a timer after the open (read synchronously here, right after A); a
    // Bag that is painted but not on its first pocket; and a pick that opens the frame with the menu
    // gone from beneath it.
    await bootReady();
    seedBag();
    expect(raisingShown(), 'precondition: the raising root starts closed').toBe(false);

    press('KeyM', 1010); // Start opens the main menu
    expect(stackNames(), 'precondition: the menu is open').toEqual(['world', 'menuView']);
    for (let i = 0; i < 8 && navActive() !== 'bag'; i += 1) press('ArrowDown', 1100 + i * 100);
    expect(navActive(), 'precondition: the cursor is on Bag').toBe('bag');

    press('Enter', 2000);
    expect(raisingShown(), 'A on Bag shows the raising root').toBe(true);
    expect(stackNames(), 'over the menu').toEqual(['world', 'menuView', 'raisingView']);
    expect(navActive(), 'the menu cursor stays on Bag beneath it').toBe('bag');
    expectBaitPainted('at the pick, no batch and no button yet');
    await flush();
    expectBaitPainted('after the deferred focus');
  });
});
