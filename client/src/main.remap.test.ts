// @vitest-environment happy-dom
/**
 * main.remap.test.ts: the booted binding table (ctl-12, CTL12.4, CTL12.5, CTL12.7).
 *
 * The pure pieces (`parseBindings`, `loadBindings`, `captureKey`, `glyph`) are proven in their own
 * suites. This file proves the SHELL: a freshly imported main.ts reads `mr.controls` once at boot
 * and decides every key through what it read: the keyboard source (a remapped A), the accelerators
 * (a cleared one is inert), F8 and F9 (a cleared F9 downloads nothing), and the keycap glyphs (the
 * character a keydown typed on a code is learned). A corrupt or unreadable store boots with the
 * defaults and never stops the page.
 *
 * Every case dispatches real, bubbling KeyboardEvents at the real window listeners and reads only
 * what a player can see: the shown roots, `defaultPrevented`, the main menu's own paint (its title
 * under the translated level name) and the read-only `__game()` hook (`stack`, `navActive`).
 *
 * The A keycap in the interaction chip needs a faced candidate (the stubbed wasm interaction rule
 * answers none), so BOOT-LEARNS-KEYCAP reads the keycap the chip is built from instead: `glyph()`
 * from a fresh `import('./input/glyphs')` in the SAME module graph as the booted main.ts, after a
 * real keydown. `interactKeycap` is `glyph(bindings.buttons.A[0])`, so a learned character shows
 * there; the test picks a key whose typed character differs from the code's derived name, so the
 * learned value cannot be mistaken for the fallback.
 *
 * Harness: main.accel.test.ts's pattern, copied and trimmed (vi.resetModules + a fresh import per
 * boot, recorded window / document listeners detached in teardown, one controllable clock, a
 * controllable rAF, a stubbed wasm pkg and SDK connection, the real client/index.html shell
 * mounted first). The one delta: `boot` seeds `localStorage` (or makes its read throw) BEFORE the
 * import. Every press is a keydown and its keyup 5 ms later.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import { DEFAULT_BINDINGS } from './input/bindings';
import type { Connection, ConnectionOptions } from './net/connection';
import { t as i18nT } from './ui/i18n/resolver';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. */
  sends: [] as unknown[],
  /** Every other reducer call, oldest first. */
  calls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 8;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  const DELTA: Record<string, [number, number]> = {
    North: [0, -1],
    South: [0, 1],
    East: [1, 0],
    West: [-1, 0],
  };
  return {
    apply_move: (
      state: { pos: { x: number; y: number } },
      input: 'Jump' | { Step: string },
      now: number,
    ) => {
      const stamp = Math.floor(now);
      if (input === 'Jump') return { ...state, action: 'Jumping', move_started_at: stamp };
      const [dx, dy] = DELTA[input.Step];
      return {
        ...state,
        facing: input.Step,
        action: 'Walking',
        pos: { x: state.pos.x + dx, y: state.pos.y + dy },
        move_started_at: stamp,
      };
    },
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 64,
    talk_range: () => 2,
    interact_candidates_coded: () => [],
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
          return Promise.resolve();
        };
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
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(idCount, 'index.html must yield a body to mount').toBeGreaterThan(5);
  document.body.replaceChildren(...children.map((el) => document.adoptNode(el)));
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
}

const clock = { t: 0 };
let rafCallback: FrameRequestCallback | null = null;
let opts: ConnectionOptions;
/** The clock of the next `press`: every press moves it on by 100 ms. */
let pressAt = 2000;

const STORAGE_KEY = 'mr.controls';

interface BootOptions {
  /** Written to `localStorage['mr.controls']` before main.ts is imported (absent: nothing is). */
  readonly stored?: string;
  /** Make a read of `mr.controls` throw, as a browser that denies storage does. */
  readonly readThrows?: boolean;
}

/** Detach everything a boot installed, so the next boot starts from a clean page. */
function teardown(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rafCallback = null;
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

async function boot(o: BootOptions = {}): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  pressAt = 2000;
  clock.t = 1000;
  localStorage.clear();
  if (o.stored !== undefined) localStorage.setItem(STORAGE_KEY, o.stored);
  if (o.readThrows === true) {
    const realGet = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string,
    ): string | null {
      if (key === STORAGE_KEY) throw new Error('SecurityError: storage is denied');
      return realGet.call(this, key);
    });
  }
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
  await import('./main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
}

async function bootReady(o: BootOptions = {}): Promise<void> {
  await boot(o);
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

/** Deliver one authoritative batch: the own player + character at (2, 6), every send acked. */
function server(t: number): void {
  clock.t = t;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    lastInputSeq: BigInt(H.sends.length),
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

/** Dispatch one cancelable, bubbling key event at clock `t` on window and return it. */
function fire(
  type: 'keydown' | 'keyup',
  code: string,
  t: number,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  clock.t = t;
  const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

/** A tap on the running press clock: keydown, and its keyup 5 ms later. Returns the keydown. */
function press(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const down = fire('keydown', code, pressAt, init);
  fire('keyup', code, pressAt + 5, init);
  pressAt += 100;
  return down;
}

const isShown = (el: Element): boolean => {
  for (let n: Element | null = el; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
};
const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return el;
};
const shownById = (id: string): boolean => isShown(byId(id));
const menuShown = (): boolean => shownById('menu-overlay');

interface FrameJson {
  readonly kind: string;
  readonly id?: string;
  readonly [key: string]: unknown;
}
interface GameHook {
  readonly stack: FrameJson[];
  readonly navActive: string | null;
}
const game = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();
/** The stack as base-first names: the base kind, then each upper frame's id. */
const stackNames = (): string[] =>
  game().stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));
const navActive = (): string | null => game().navActive;
const menuTitle = (): string =>
  document.querySelector('#menu-overlay .mr-frame-title')?.textContent ?? '';

/** Open the main menu by Start (Escape) and walk the cursor onto Social: A on it enters the Social
 *  level, the one visible effect of "the menu entry under the cursor was picked". */
function openMenuOnSocial(): void {
  press('Escape');
  expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
  for (let i = 0; i < 8 && navActive() !== 'social'; i += 1) press('ArrowDown');
  expect(navActive(), 'precondition: the cursor is on Social').toBe('social');
  expect(menuTitle(), 'precondition: the menu is on its root level').toBe(i18nT('menu.title'));
}

/** The default table as plain data, for a stored table that changes a few entries. */
type Raw = { buttons: Record<string, string[]>; accels: Record<string, string[]> };
const storedTable = (change: (raw: Raw) => void): string => {
  const raw: Raw = JSON.parse(
    JSON.stringify({ buttons: DEFAULT_BINDINGS.buttons, accels: DEFAULT_BINDINGS.accels }),
  );
  change(raw);
  return JSON.stringify({ v: 1, ...raw });
};

/** Stub the two object-URL calls and the anchor click the F9 download makes, recording them. */
function recordDownloads(): { readonly urls: unknown[]; readonly clicks: HTMLAnchorElement[] } {
  const urls: unknown[] = [];
  const clicks: HTMLAnchorElement[] = [];
  const url = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  const prevCreate = url.createObjectURL;
  const prevRevoke = url.revokeObjectURL;
  url.createObjectURL = (blob: unknown): string => {
    urls.push(blob);
    return 'blob:mock';
  };
  url.revokeObjectURL = (): void => undefined;
  const anchor = HTMLAnchorElement.prototype as unknown as { click: () => void };
  const prevClick = anchor.click;
  anchor.click = function (this: HTMLAnchorElement): void {
    clicks.push(this);
  };
  restorers.push(() => {
    if (prevCreate === undefined) delete url.createObjectURL;
    else url.createObjectURL = prevCreate;
    if (prevRevoke === undefined) delete url.revokeObjectURL;
    else url.revokeObjectURL = prevRevoke;
    anchor.click = prevClick;
  });
  return { urls, clicks };
}

describe('main.ts booted binding table over the real shell (runtime, ctl-12)', {
  sequential: true,
}, () => {
  afterEach(() => {
    teardown();
  });

  it('CTL12-4-BOOT-LOADS: with a stored table that moves A to K, K picks the menu entry under the cursor and Enter no longer does', async () => {
    // WRONG IMPL KILLED: a boot that never reads the store (K is dead, Enter still picks), one
    // that reads it but feeds the router the DEFAULT table (Enter still picks), one that merges
    // the stored A with the default (both K and Enter pick), a pick keyed to the wrong key, and an
    // unbound Enter that is still prevented as if the router had consumed it.
    await bootReady({ stored: storedTable((raw) => (raw.buttons.A = ['KeyK'])) });
    server(1000);
    openMenuOnSocial();

    const enter = press('Enter');
    expect(enter.defaultPrevented, 'an unbound Enter is not an A press').toBe(false);
    expect(menuTitle(), 'Enter picks nothing: the menu stays on its root level').toBe(
      i18nT('menu.title'),
    );
    expect(navActive()).toBe('social');
    expect(stackNames()).toEqual(['world', 'menuView']);
    const numpadEnter = press('NumpadEnter');
    expect(numpadEnter.defaultPrevented, 'the old alias is gone with it').toBe(false);
    expect(menuTitle()).toBe(i18nT('menu.title'));

    const k = press('KeyK');
    expect(k.defaultPrevented, 'K is consumed as A').toBe(true);
    expect(menuTitle(), 'K picked Social: the menu is on the Social level').toBe(
      i18nT('menu.social.title'),
    );
    expect(H.calls, 'picking a menu entry sends nothing').toEqual([]);
    expect(H.sends, 'and walks nothing').toHaveLength(0);
  });

  it('CTL12-4-BOOT-CORRUPT-DEFAULTS: a corrupt stored string, and a store whose read throws, both boot with the defaults: Enter acts as A', async () => {
    // WRONG IMPL KILLED: a boot that lets JSON.parse's SyntaxError out of module scope (the page
    // never starts), one that lets a SecurityError from reading storage do the same, one that boots
    // with an empty table (Enter dead), and one that boots with the K binding of another test (the
    // module graph is rebuilt per boot, so a leaked module cell would show here).
    const scenarios: ReadonlyArray<readonly [string, BootOptions]> = [
      ['corrupt JSON', { stored: '{not json' }],
      ['a wrong-version table', { stored: JSON.stringify({ v: 9, buttons: { A: ['KeyK'] } }) }],
      ['a throwing storage read', { readThrows: true }],
    ];
    for (const [label, o] of scenarios) {
      teardown();
      await bootReady(o);
      server(1000);
      openMenuOnSocial();
      const enter = press('Enter');
      expect(enter.defaultPrevented, `${label}: Enter is consumed as A`).toBe(true);
      expect(menuTitle(), `${label}: Enter picked Social`).toBe(i18nT('menu.social.title'));
      press('Escape'); // Start pops everything to the world
      expect(stackNames(), `${label}: Start closes the menu`).toEqual(['world']);
      const k = press('KeyK');
      expect(k.defaultPrevented, `${label}: K is not bound`).toBe(false);
    }
  });

  it('CTL12-7-BOOT-CLEARED-ACCEL-INERT: a stored table with accelerator I cleared makes KeyI do nothing (no Bag, not prevented) while J still opens the Journal, and a cleared F9 downloads no bug bundle', async () => {
    // WRONG IMPL KILLED: an accelerator decided from the DEFAULT table (a cleared key still fires),
    // a cleared entry re-defaulted at boot (the store's `[]` read as missing), a clear that
    // unbinds I but leaves it prevented (the key swallowed for nothing), a clear that kills every
    // accelerator (J is the control), and an F9 handled by a hard-coded `e.code === 'F9'` ahead of
    // the table (the bug-bundle download fires for a key the player unbound).
    const stored = storedTable((raw) => {
      raw.accels.I = [];
      raw.accels.F9 = [];
    });
    await bootReady({ stored });
    const downloads = recordDownloads();
    server(1000);

    const i = press('KeyI');
    expect(i.defaultPrevented, 'a cleared accelerator is not consumed').toBe(false);
    expect(stackNames(), 'no menu, no Bag').toEqual(['world']);
    expect(menuShown()).toBe(false);

    const f9 = press('F9');
    expect(f9.defaultPrevented, 'a cleared F9 is not consumed').toBe(false);
    expect(downloads.urls, 'a cleared F9 downloads nothing').toHaveLength(0);
    expect(downloads.clicks).toHaveLength(0);

    const j = press('KeyJ');
    expect(j.defaultPrevented, 'control: J is still an accelerator').toBe(true);
    expect(stackNames(), 'control: J opens the Journal under the menu').toEqual([
      'world',
      'menuView',
      'questLogView',
    ]);
    expect(shownById('quest-log-overlay')).toBe(true);
    press('Escape');
    expect(stackNames()).toEqual(['world']);
    server(pressAt);
    frame(pressAt + 10);
  });

  it('F9 with the default table still downloads the bug bundle, so the cleared-F9 case above is not a dead recorder', async () => {
    // WRONG IMPL KILLED: a table-routed F9 that never fires (the control for CLEARED-ACCEL-INERT),
    // and an F9 that is not consumed.
    await bootReady();
    const downloads = recordDownloads();
    server(1000);
    const f9 = press('F9');
    expect(f9.defaultPrevented, 'F9 is consumed').toBe(true);
    expect(downloads.urls, 'F9 builds one bundle').toHaveLength(1);
    expect(downloads.clicks, 'and clicks one download anchor').toHaveLength(1);
  });

  it('a remapped F9 downloads on its new key and not on the old one', async () => {
    // WRONG IMPL KILLED: F9 matched by its literal code ahead of the table (the old key still
    // downloads and the new one is dead).
    await bootReady({ stored: storedTable((raw) => (raw.accels.F9 = ['KeyG'])) });
    const downloads = recordDownloads();
    server(1000);
    const old = press('F9');
    expect(old.defaultPrevented, 'the old F9 key is free again').toBe(false);
    expect(downloads.urls).toHaveLength(0);
    const g = press('KeyG');
    expect(g.defaultPrevented, 'the new key is consumed').toBe(true);
    expect(downloads.urls, 'and downloads').toHaveLength(1);
  });

  it('CTL12-5-BOOT-LEARNS-KEYCAP: a keydown teaches the glyph the character it typed on that code, so the keycap of A bound to KeyK reads that character; a Shift-held character is not learned', async () => {
    // WRONG IMPL KILLED: a main.ts that never calls learnKey (the keycap stays the derived K for a
    // layout that types T there), one that learns the Shifted character, one that learns on keyup
    // only after the table is built (a stale module graph), and a keycap read from the code instead
    // of through glyph. The typed character 't' differs from the derived name 'K', so a learned
    // value cannot be the fallback. Chosen route: glyph() from the same module graph (see the
    // header), since the chip needs a faced candidate the harness cannot provide.
    await bootReady({ stored: storedTable((raw) => (raw.buttons.A = ['KeyK'])) });
    server(1000);
    const glyphs = await import('./input/glyphs');
    expect(glyphs.glyph('KeyK'), 'before any key: derived from the code').toBe('K');
    expect(glyphs.glyph('KeyW')).toBe('W');
    expect(glyphs.glyph('Digit1')).toBe('1');

    fire('keydown', 'KeyK', pressAt, { key: 't' });
    fire('keyup', 'KeyK', pressAt + 5, { key: 't' });
    pressAt += 100;
    expect(glyphs.glyph('KeyK'), 'the keycap of A reads what the layout typed').toBe('T');
    expect(glyphs.glyph('KeyW'), 'another code is untouched').toBe('W');

    // A different layout: the key on KeyW types z; learned at the world like any other key.
    fire('keydown', 'KeyW', pressAt, { key: 'z' });
    fire('keyup', 'KeyW', pressAt + 5, { key: 'z' });
    pressAt += 100;
    expect(glyphs.glyph('KeyW')).toBe('Z');

    // Shift held: the shifted character is not the key's own, and is not learned.
    fire('keydown', 'Digit1', pressAt, { key: '!', shiftKey: true });
    fire('keyup', 'Digit1', pressAt + 5, { key: '!', shiftKey: true });
    pressAt += 100;
    expect(glyphs.glyph('Digit1'), 'a Shift-held character is ignored').toBe('1');
  });
});
