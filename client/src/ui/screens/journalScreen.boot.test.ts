// @vitest-environment happy-dom
/**
 * journalScreen.boot.test.ts: the Journal (ctl-8f) booted through main.ts over the REAL
 * client/index.html shell, the REAL QuestLogView and the REAL screen-adapter table
 * (`SCREEN_ADAPTERS.questLogView` is whatever ui/screens/index.ts ships: no stand-in is swapped in).
 *
 * - CTL8F-4-BOOT-KEYQ: KeyJ shows #quest-log-overlay with the quest rows (the legacy row text,
 *   "quest_001 (step 0)", unchanged) and the first row marked as the cursor with no detail open;
 *   Enter (A) opens #quest-log-detail with that quest's name and step; Backspace (B) closes the
 *   detail and the overlay stays open (the frame stays on the stack); ArrowDown moves the cursor and
 *   Enter opens the second quest's detail; Backspace closes it and a second Backspace pops the
 *   frame. ctl-11a (named intentional changes): the key is KeyJ (KeyQ is the LB bumper now and opens
 *   nothing at the world); the accelerator opens its menu path, so the frame sits over the menu
 *   (the world, the menu, then the Journal) and the final Backspace pops ONE frame, leaving the menu
 *   on top (was: the world). The tag keeps its old spelling: it names the test, not the key.
 *
 * EVERY key is dispatched ON `document.activeElement`, bubbling, like a real browser (the router
 * ignores keys a focused form control owns); the deferred initial focus (one macrotask after KeyJ,
 * from ui/overlayA11y.ts) is flushed before the first key.
 *
 * Harness: tradeProposeScreen.boot.test.ts's (the real shell mounted, main.ts imported fresh per
 * boot, only the wasm pkg, the connection, telemetry and the world renderer stubbed). The quest rows
 * are written through `opts.store` and delivered with `flushBatch()`. No frame is run: a press
 * reaches the adapter, and the adapter's paint reaches the view, on the keydown.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from '../../convert/convert';
import type { Connection, ConnectionOptions } from '../../net/connection';

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
 *  put in the store since the last batch. */
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

/** Two active quests: quest_001 at step 0, quest_002 at step 2. */
function seedQuests(): void {
  opts.store.upsertQuest({
    pqId: 1n,
    ownerIdentity: H.identity,
    questId: 'quest_001',
    stepIndex: 0,
  });
  opts.store.upsertQuest({
    pqId: 2n,
    ownerIdentity: H.identity,
    questId: 'quest_002',
    stepIndex: 2,
  });
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

/** The journal overlay is on screen (its inline display is not none). */
const journalShown = (): boolean => el('quest-log-overlay').style.display !== 'none';
/** The main menu is on screen (its inline display is not none; covered is not closed). */
const menuShown = (): boolean => el('menu-overlay').style.display !== 'none';
const rows = (): HTMLElement[] => [...el('quest-log-list').querySelectorAll<HTMLElement>('li')];
const cursor = (): Array<string | undefined> =>
  rows()
    .filter((r) => r.classList.contains('is-active'))
    .map((r) => r.dataset.questId);
/** The detail is on screen: it exists and its inline display is not none. */
const detailShown = (): boolean => {
  const detail = document.getElementById('quest-log-detail');
  return detail !== null && detail.style.display !== 'none';
};
const detailText = (): string => document.getElementById('quest-log-detail')?.textContent ?? '';

/** The whole context stack through the read-only `__game()` DEV hook, as base-first frame names. */
const stackNames = (): string[] =>
  (
    window as unknown as {
      __game: () => { stack: Array<{ kind: string; id?: string }> };
    }
  )
    .__game()
    .stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));

describe('the Journal booted through main.ts over the real view and adapter table (ctl-8f)', {
  sequential: true,
}, () => {
  afterEach(teardownBoot);

  it('CTL8F-4-BOOT-KEYQ: KeyJ shows the journal over the menu with the legacy row text and the first quest as the cursor; Enter (A) opens that quest`s detail with its name and step; Backspace (B) closes the detail and the journal stays open; ArrowDown then Enter opens the second quest`s detail; Backspace closes it and the next Backspace pops ONE frame, leaving the menu on top', async () => {
    // ctl-11a (named intentional changes), tag kept: (1) RETIRED: KeyQ opens the Journal (Q is LB
    // now; KeyJ is the Journal's accelerator); REPLACED by KeyJ. (2) RETIRED: the stacks
    // `['world', 'questLogView']` and the final `['world']`; REPLACED by
    // `['world', 'menuView', 'questLogView']` and, after the last Backspace, `['world', 'menuView']`
    // with the menu shown (B pops one frame; Start is what pops to the base). Everything else (the
    // rows, the cursor at the open with no batch, the detail, B closing it first) is unchanged: the
    // Journal's own paint at its open already needs no batch (the view paints the opening cursor in
    // `render`), so there is no first-paint lag here to pin.
    // WRONG IMPL KILLED: the legacy adapter on the quest log frame (Enter is unhandled and nothing
    // opens: the Journal is a bare list forever); rows whose text changed (the e2e dialogue.spec
    // pins "quest_001 (step 0)"); an opening with no marked row (a screen reader announces no
    // selection); a detail that opens for the first quest whichever is under the cursor, that shows
    // the wrong step, or that never opens; a B that pops the whole frame from a detail (the journal
    // would vanish and the detail with it, instead of stepping back); a detail left on screen after
    // B; a D-pad press that does not reach the adapter; and a second B that does not pop the frame.
    await bootReady();
    seedQuests();
    expect(journalShown(), 'precondition: the journal starts closed').toBe(false);

    press('KeyJ', 1010);
    expect(journalShown(), 'KeyJ shows the journal').toBe(true);
    expect(stackNames(), 'over the menu').toEqual(['world', 'menuView', 'questLogView']);
    await flush();
    expect(
      rows().map((r) => r.textContent),
      'the legacy row text, unchanged',
    ).toEqual(['quest_001 (step 0)', 'quest_002 (step 2)']);
    expect(cursor(), 'the first quest is the cursor on open').toEqual(['quest_001']);
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(detailShown(), 'no detail on open').toBe(false);

    press('Enter', 1100);
    expect(detailShown(), 'A opens the detail').toBe(true);
    expect(detailText(), 'the quest`s name').toContain('quest_001');
    expect(detailText(), 'its step').toContain('Step 0');
    expect(journalShown(), 'the journal stays open under its detail').toBe(true);
    expect(rows(), 'the rows are still the quests').toHaveLength(2);

    press('Backspace', 1200);
    expect(detailShown(), 'B closes the detail').toBe(false);
    expect(journalShown(), 'and the journal stays open').toBe(true);
    expect(stackNames(), 'the frame is still on the stack, over the menu').toEqual([
      'world',
      'menuView',
      'questLogView',
    ]);
    expect(cursor(), 'the cursor stays on that quest').toEqual(['quest_001']);

    press('ArrowDown', 1300);
    expect(cursor(), 'Down moves the cursor to the second quest').toEqual(['quest_002']);
    press('Enter', 1400);
    expect(detailShown()).toBe(true);
    expect(detailText(), 'the second quest`s name').toContain('quest_002');
    expect(detailText(), 'and its own step').toContain('Step 2');
    expect(detailText(), 'not the first quest`s').not.toContain('quest_001');

    press('Backspace', 1500);
    expect(detailShown(), 'B closes the second detail').toBe(false);
    expect(journalShown()).toBe(true);
    press('Backspace', 1600);
    expect(journalShown(), 'B in the list pops the frame').toBe(false);
    expect(stackNames(), 'one frame: the menu is the top frame, not the world').toEqual([
      'world',
      'menuView',
    ]);
    expect(menuShown(), 'and the menu is on screen').toBe(true);
  });
});
