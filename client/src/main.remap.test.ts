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
 *
 * ctl-12b (CTL12B.1, CTL12B.2) adds the Options > Controls screen over the same harness: the screen
 * opened by real key presses through the menu, a capture the shell takes from the next keydown,
 * the table saved to `mr.controls` and applied at once (no reload: the keyboard source, the
 * accelerators and the A keycap read the new table on the next key or frame), a re-boot with the
 * storage kept, and typing mode (Enter in a focused field commits as A whatever the table says; an
 * IME's Escape is never an accelerator). Two harness deltas, each keeping every older case's
 * default: `boot` and `teardown` can keep the storage a previous boot wrote (`keepStorage`), and
 * the stubbed wasm interaction rule is driven by `H.interact` (default: no candidate), so
 * CTL12B-2-KEYCAP faces an NPC and reads the chip itself.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import { parseBindings } from './input/bindingStore';
import { type Bindings, DEFAULT_BINDINGS } from './input/bindings';
import { ACCELS, type Accel, VBUTTONS, type VButton } from './input/buttons';
import { glyph } from './input/glyphs';
import type { Connection, ConnectionOptions } from './net/connection';
import {
  type ControlsRow,
  captureKey,
  capturePrompt,
  outcomeText,
  rowLabel,
} from './ui/controlsModel';
import { t as i18nT, tf } from './ui/i18n/resolver';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  /** Every enqueueMove the client issued. */
  sends: [] as unknown[],
  /** Every other reducer call, oldest first. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** ctl-12b: what the stubbed wasm `interact_candidates_coded` answers (indices into the
   *  marshalled entity list). Reset to "no candidate" by every boot. */
  interact: ((..._args: unknown[]) => []) as (...args: unknown[]) => unknown,
}));

// ctl-12b: named fixture change: the interact export is driven by `H.interact` (default `[]`, reset
// by every boot), so CTL12B-2-KEYCAP can stand the player in front of an NPC.
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
    interact_candidates_coded: (...args: unknown[]) => H.interact(...args),
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
  /** ctl-12b: keep `localStorage` exactly as the previous boot left it (a page reload): nothing is
   *  cleared and `stored` is not written. Absent: the storage is cleared first, as before. */
  readonly keepStorage?: boolean;
}

/** Detach everything a boot installed, so the next boot starts from a clean page. `keepStorage`
 *  (ctl-12b) leaves `localStorage` as the booted page wrote it, for a re-boot that reads it. */
function teardown(o: { readonly keepStorage?: boolean } = {}): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rafCallback = null;
  if (o.keepStorage !== true) localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
}

async function boot(o: BootOptions = {}): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.interact = () => [];
  pressAt = 2000;
  clock.t = 1000;
  if (o.keepStorage !== true) {
    localStorage.clear();
    if (o.stored !== undefined) localStorage.setItem(STORAGE_KEY, o.stored);
  }
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
  target: EventTarget = window,
): KeyboardEvent {
  clock.t = t;
  const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** A tap on the running press clock: keydown, and its keyup 5 ms later. Returns the keydown. The
 *  event is dispatched at `target` (default: the window), so a focused field can be the target. */
function press(
  code: string,
  init: KeyboardEventInit = {},
  target: EventTarget = window,
): KeyboardEvent {
  const down = fire('keydown', code, pressAt, init, target);
  fire('keyup', code, pressAt + 5, init, target);
  pressAt += 100;
  return down;
}

const errorOverlay = (): HTMLElement => byId('mr-error-overlay');
const errorOverlayShown = (): boolean => isShown(errorOverlay());
/** Raise the error overlay the way a page error does: an uncaught `error` event on the window. */
function raiseErrorOverlay(): void {
  window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }));
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

  it('a synthetic keydown with no code or key does not throw out of the listener and raises no error', async () => {
    // WRONG IMPL KILLED: a learnKey (or table lookup) that dereferences `e.code` / `e.key` as a
    // string: a plain `new Event('keydown')` (an extension, a test driver) throws out of the
    // page's key listener, which reaches the window `error` event and the error overlay.
    await bootReady();
    server(1000);
    let pageErrors = 0;
    window.addEventListener('error', () => {
      pageErrors += 1;
    });
    expect(errorOverlayShown(), 'precondition: no error is showing').toBe(false);
    expect(() => window.dispatchEvent(new Event('keydown'))).not.toThrow();
    expect(() => window.dispatchEvent(new Event('keydown', { cancelable: true }))).not.toThrow();
    expect(pageErrors, 'the listener raised no page error').toBe(0);
    expect(errorOverlayShown(), 'and the error overlay stays hidden').toBe(false);
    expect(stackNames(), 'and nothing happened').toEqual(['world']);
    // Control: the harness does see a page error.
    raiseErrorOverlay();
    expect(pageErrors, 'control: a raised error is counted').toBe(1);
    expect(errorOverlayShown(), 'control: and shows the overlay').toBe(true);
  });

  it('F8 cleared does not dismiss the error overlay and is not consumed; with the default table F8 dismisses it', async () => {
    // WRONG IMPL KILLED: an F8 matched by its literal code ahead of the live table (a cleared F8
    // still dismisses and is prevented), and a table-routed F8 that never fires (the control).
    // Raising the overlay is practical here (an `error` event on the window shows it), so the real
    // dismissal is observed rather than only `defaultPrevented`.
    const cases: ReadonlyArray<readonly [string, BootOptions, boolean]> = [
      ['default table', {}, true],
      ['F8 cleared', { stored: storedTable((raw) => (raw.accels.F8 = [])) }, false],
    ];
    for (const [label, o, dismisses] of cases) {
      teardown();
      await bootReady(o);
      server(1000);
      raiseErrorOverlay();
      expect(errorOverlayShown(), `${label}: precondition: the overlay is visible`).toBe(true);
      const f8 = press('F8');
      expect(f8.defaultPrevented, `${label}: F8 consumed iff it dismissed`).toBe(dismisses);
      expect(errorOverlayShown(), `${label}: overlay visible after F8`).toBe(!dismisses);
    }
  });

  it('a remapped F8 dismisses the error overlay on its new key only while it is visible, and the old F8 key does nothing', async () => {
    // WRONG IMPL KILLED: F8 matched by literal code (the old key still dismisses, the new one is
    // dead), a remapped F8 that is prevented while the overlay is hidden (the key swallowed for
    // nothing), and one that never dismisses.
    await bootReady({ stored: storedTable((raw) => (raw.accels.F8 = ['KeyZ'])) });
    server(1000);
    const hidden = press('KeyZ');
    expect(hidden.defaultPrevented, 'KeyZ with no overlay is not consumed').toBe(false);
    raiseErrorOverlay();
    expect(errorOverlayShown()).toBe(true);
    const old = press('F8');
    expect(old.defaultPrevented, 'the old F8 key is free').toBe(false);
    expect(errorOverlayShown(), 'the old F8 key dismisses nothing').toBe(true);
    const z = press('KeyZ');
    expect(z.defaultPrevented, 'KeyZ dismisses and is consumed').toBe(true);
    expect(errorOverlayShown()).toBe(false);
  });

  it('a printable key bound to F9 is typed, not taken, in a text field inside the game screen; the default F9 key in that field is unchanged (left to the field)', async () => {
    // WRONG IMPL KILLED: an F9 branch placed ahead of the field-ownership test (a player typing the
    // letter they bound to F9 into the Name field downloads a bug bundle and loses the letter).
    await bootReady({ stored: storedTable((raw) => (raw.accels.F9 = ['KeyX'])) });
    const typed = recordDownloads();
    server(1000);
    press('KeyN');
    expect(stackNames(), 'precondition: the Name screen is open').toEqual([
      'world',
      'menuView',
      'renameView',
    ]);
    const input = byId('rename-input') as HTMLInputElement;
    input.focus();
    expect(document.activeElement, 'precondition: the Name field has focus').toBe(input);
    const x = press('KeyX', { key: 'x' }, input);
    expect(x.defaultPrevented, 'the typed letter is left to the field').toBe(false);
    expect(typed.urls, 'no bug bundle is downloaded for a typed letter').toHaveLength(0);
    expect(typed.clicks).toHaveLength(0);

    // The unchanged baseline: with the default table, F9 in the focused Name field is not
    // prevented and downloads nothing. That is the rename view's own shield (it stops the key in
    // the bubble phase, so it never reaches the window listener), unchanged by ctl-12. The default
    // F9 at the world is covered by the "F9 with the default table still downloads" test.
    teardown();
    await bootReady();
    const live = recordDownloads();
    server(1000);
    press('KeyN');
    const field = byId('rename-input') as HTMLInputElement;
    field.focus();
    expect(document.activeElement, 'precondition: the Name field has focus').toBe(field);
    const f9 = press('F9', { key: 'F9' }, field);
    expect(f9.defaultPrevented, 'F9 in the Name field is left to the field').toBe(false);
    expect(live.urls, 'and downloads nothing').toHaveLength(0);
    expect(live.clicks).toHaveLength(0);
  });

  it('a keydown with focus outside the game screen still teaches the glyph (learning runs before every early return)', async () => {
    // WRONG IMPL KILLED: a learnKey placed after the focus-outside-the-game-screen early return (a
    // player who clicked the page chrome and then pressed keys never teaches the keycaps), or after
    // the session gate or the chord return.
    await bootReady();
    server(1000);
    const glyphs = await import('./input/glyphs');
    expect(glyphs.glyph('KeyQ'), 'precondition: derived from the code').toBe('Q');
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement, 'precondition: focus is outside the game screen').toBe(outside);
    expect(byId('game-screen').contains(outside), 'precondition: the field is outside').toBe(false);
    const e = press('KeyQ', { key: 'a' }, outside);
    expect(e.defaultPrevented, 'the page left the key to the browser').toBe(false);
    expect(glyphs.glyph('KeyQ'), 'the key was still learned').toBe('A');
  });

  it('with Start and F8 traded, Escape in the focused Name field stops typing and does not dismiss the error overlay', async () => {
    // WRONG IMPL KILLED: an F8 decision made through the live table AHEAD of the typing-mode rule
    // (CTL6B.5), so that Escape, now the F8 key, dismisses the error overlay (and returns before
    // the field is released) instead of stopping typing: focus would stay in the field. Escape is
    // routed in the capture phase, so it reaches main.ts despite the rename field's shield.
    const stored = storedTable((raw) => {
      raw.buttons.Start = ['F8', 'KeyM'];
      raw.accels.F8 = ['Escape'];
    });
    await bootReady({ stored });
    server(1000);
    press('KeyN');
    expect(stackNames(), 'precondition: the Name screen is open').toEqual([
      'world',
      'menuView',
      'renameView',
    ]);
    const input = byId('rename-input') as HTMLInputElement;
    input.focus();
    expect(document.activeElement, 'precondition: the Name field has focus').toBe(input);
    raiseErrorOverlay();
    expect(errorOverlayShown(), 'precondition: F8 has an overlay to dismiss').toBe(true);

    press('Escape', { key: 'Escape' }, input);
    expect(document.activeElement, 'typing stopped: focus left the field').not.toBe(input);
    expect(stackNames().at(-1), 'the Name screen is still open').toBe('renameView');
    expect(errorOverlayShown(), 'the error overlay was not dismissed by that Escape').toBe(true);
  });
});

// ==========================================================================================
// ctl-12b: Options > Controls (CTL12B.1, CTL12B.2) over the booted shell
// ==========================================================================================
//
// DOM contract (plan ctl-12b, section 2): `#controls-overlay` is the frame root; `#controls-rows`
// the nav grid, its cells `[data-nav-key]` (`${VButton}_0` / `_1` per button row, then `reset`;
// on Shortcuts `${Accel}_0` / `_1` / `_clear`, then `reset`), the cursor cell `aria-selected` and
// named by `aria-activedescendant`; `#controls-capture` (the prompt) and `#controls-cancel-btn`
// only while capturing; `#controls-feedback` the last outcome line; `#controls-question` and a
// Yes / No listbox in `#controls-rows` while Reset all asks. Every expected string is built from
// the catalog (`i18nT` / `tf`) or the shipped controlsModel helpers, in this test's own module
// graph (both default to English, so the text equals what the booted shell paints).

/** U+2026, built from its code point (never a pasted character). */
const ELLIPSIS = String.fromCharCode(0x2026);

const buttonRow = (id: VButton): ControlsRow => ({ kind: 'button', id });
const ROW_A = buttonRow('A');

/** The Buttons tab's cell keys in display order: each button's Primary then Alt, then Reset all. */
const BUTTON_CELLS: readonly string[] = [...VBUTTONS.flatMap((b) => [`${b}_0`, `${b}_1`]), 'reset'];
/** The Shortcuts tab's cell keys: each accelerator's Primary, Alt and Clear, then Reset all. */
const SHORTCUT_CELLS: readonly string[] = [
  ...ACCELS.flatMap((a) => [`${a}_0`, `${a}_1`, `${a}_clear`]),
  'reset',
];
const CONTROLS_STACK: readonly string[] = ['world', 'menuView', 'controlsView'];

/** Shown: present, and neither it nor an ancestor is `display:none` or `hidden`. */
const visibleNow = (id: string): boolean => {
  const el = document.getElementById(id);
  if (el === null) return false;
  for (let n: Element | null = el; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none' || n.hidden) return false;
  }
  return true;
};
/** The Controls cursor: the `data-nav-key` of the one `aria-selected` cell in `#controls-rows`. */
const controlsActive = (): string | null => {
  const cell = document.querySelector('#controls-rows [aria-selected="true"]');
  return cell?.getAttribute('data-nav-key') ?? null;
};
const controlsCell = (key: string): HTMLElement => {
  const el = document.querySelector(`#controls-rows [data-nav-key="${key}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`#controls-rows has no cell ${key}`);
  return el;
};
const cellText = (key: string): string => controlsCell(key).textContent ?? '';
const cellKeys = (): string[] =>
  Array.from(document.querySelectorAll('#controls-rows [data-nav-key]')).map(
    (el) => el.getAttribute('data-nav-key') ?? '',
  );
const controlsFeedback = (): string => byId('controls-feedback').textContent ?? '';
/** Whether a capture is waiting: the prompt line is shown. */
const capturing = (): boolean => visibleNow('controls-capture');
const captureText = (): string => byId('controls-capture').textContent ?? '';
/** A slot's keycap as the screen names it: its code's glyph, or the empty-slot word. */
const keycapOf = (code: string | undefined): string =>
  code === undefined ? i18nT('controls.slot.none') : glyph(code);
const primaryText = (row: ControlsRow, key: string): string =>
  tf('controls.slot.primary', { label: rowLabel(row), key });
const altText = (row: ControlsRow, key: string): string =>
  tf('controls.slot.alt', { label: rowLabel(row), key });
/** The raw `mr.controls` string, or null when nothing was saved. */
const savedRaw = (): string | null => localStorage.getItem(STORAGE_KEY);
/** The saved table as a boot reads it: `parseBindings` over the raw JSON. */
const savedTable = (): Bindings => {
  const raw = savedRaw();
  if (raw === null) throw new Error('nothing is saved in mr.controls');
  return parseBindings(JSON.parse(raw));
};
/** The default table with some rows replaced, as plain data for a `toEqual`. */
const tableWith = (
  buttons: Partial<Record<VButton, readonly string[]>>,
  accels: Partial<Record<Accel, readonly string[]>> = {},
): unknown => ({
  buttons: { ...DEFAULT_BINDINGS.buttons, ...buttons },
  accels: { ...DEFAULT_BINDINGS.accels, ...accels },
});
/** The main menu's rows as painted (each entry's title), in order. */
const menuOptionTexts = (): string[] =>
  Array.from(document.querySelectorAll('#menu-rows [role="option"]')).map(
    (o) => o.textContent ?? '',
  );

/** Start, the cursor to Options, A, the cursor to Controls, A (`a` is the key A is bound to): the
 *  Controls frame opens above the menu. Works on a reopen too: the menu reopens on the last entry
 *  used and Options on its last child. */
function openControls(a = 'Enter'): void {
  press('Escape');
  expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
  for (let i = 0; i < 8 && navActive() !== 'options'; i += 1) press('ArrowDown');
  expect(navActive(), 'precondition: the cursor is on Options').toBe('options');
  press(a);
  for (let i = 0; i < 2 && navActive() !== 'controls'; i += 1) press('ArrowDown');
  expect(navActive(), 'precondition: the cursor is on Options > Controls').toBe('controls');
  press(a);
  expect(stackNames(), 'precondition: Controls opened above the menu').toEqual([...CONTROLS_STACK]);
}

/** Walk the Controls cursor to `key` with the D-pad over the active tab's known grid (Buttons: two
 *  columns; Shortcuts: three), never across an edge (so wrapping never matters). Reset all sits
 *  alone in column 0 of the last row, so the column changes only outside that row. */
function controlsMoveTo(key: string): void {
  const onButtons = byId('controls-tab-buttons').getAttribute('aria-selected') === 'true';
  const cells = onButtons ? BUTTON_CELLS : SHORTCUT_CELLS;
  const cols = onButtons ? 2 : 3;
  const place = (k: string | null): { row: number; col: number } => {
    const i = k === null ? -1 : cells.indexOf(k);
    if (i < 0) throw new Error(`Controls cursor: ${String(k)} is not a cell of this tab`);
    return { row: Math.floor(i / cols), col: i % cols };
  };
  const from = place(controlsActive());
  const to = place(key);
  const across = (): void => {
    for (let c = from.col; c < to.col; c += 1) press('ArrowRight');
    for (let c = from.col; c > to.col; c -= 1) press('ArrowLeft');
  };
  const down = (): void => {
    for (let r = from.row; r < to.row; r += 1) press('ArrowDown');
    for (let r = from.row; r > to.row; r -= 1) press('ArrowUp');
  };
  if (controlsActive() === 'reset') {
    down();
    across();
  } else {
    across();
    down();
  }
  expect(controlsActive(), `precondition: the Controls cursor is on ${key}`).toBe(key);
}

/** Move to the slot `cell` and press A there (`a`): its capture starts. */
function startCapture(cell: string, a = 'Enter'): void {
  controlsMoveTo(cell);
  press(a);
  expect(capturing(), `precondition: A on ${cell} started a capture`).toBe(true);
}

const NPC_ENTITY = 11n;
const NPC_NAME = 'guide';

/** A dialogue NPC on (3, 6), the tile the player (on (2, 6), facing East) faces, in one batch. */
function seedNpc(t: number): void {
  opts.store.upsertNpc({
    entityId: NPC_ENTITY,
    npcId: NPC_NAME,
    zoneId: 0,
    homeX: 3,
    homeY: 6,
    wanderRadius: 0,
    dialogueTreeId: 'no-such-tree',
    interaction: { kind: 'dialogue' },
  });
  opts.store.upsertCharacter(
    {
      entityId: NPC_ENTITY,
      zoneId: 0,
      tileX: 3,
      tileY: 6,
      facing: 'West',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
    },
    t,
  );
  server(t);
}

/** The stubbed wasm interaction rule names the seeded NPC: it is the faced candidate. */
function faceNpcRule(): void {
  H.interact = (...args: unknown[]) => {
    const entities = args[4];
    if (!Array.isArray(entities)) return [];
    const at = entities.findIndex(
      (e: { kind?: unknown; id?: unknown }) => e.kind === 'npc' && e.id === NPC_ENTITY.toString(),
    );
    return at === -1 ? [] : [at];
  };
}

/** A server conversation with the NPC arrives (or ends), in one batch at clock `t`. */
function startConversation(t: number): void {
  opts.store.upsertConversation({
    ownerIdentity: H.identity,
    npcEntityId: NPC_ENTITY,
    currentNodeId: 'start',
  });
  server(t);
}
function endConversation(t: number): void {
  opts.store.removeConversation(H.identity);
  server(t);
}

const promptText = (): string => byId('interact-prompt').textContent ?? '';

describe('main.ts Options > Controls: capture and live rebinding over the real shell (runtime, ctl-12b)', {
  sequential: true,
}, () => {
  afterEach(() => {
    teardown();
  });

  it('CTL12B-1-BOOT-OPENS: Start, Options (its children How to play then Controls), A on Controls opens the Controls frame above the menu, with tabs Buttons (active) and Shortcuts, twelve button rows each with a Primary and an Alt slot showing the live keys and no Clear, and A on the Confirm (A) row`s Primary slot shows "Press a key for Confirm (A)..."', async () => {
    // LEGACY REPLACED (the Red): no Controls screen exists; Options holds How to play alone, so the
    // cursor cannot reach a Controls entry.
    // WRONG IMPL KILLED: a Controls leaf missing from Options or put before How to play (shipped
    // e2e specs expect How to play first), a leaf that opens nothing or opens the frame in place
    // of the menu (the menu must stay beneath it), a frame painted from the DEFAULT table instead
    // of the live one (a row showing the wrong key), a tab strip with the wrong tabs or the wrong
    // one active, a button row with a Clear cell (protected buttons can never be emptied), a
    // cursor that `aria-activedescendant` does not name, an A on a slot that starts no capture or
    // shows another row's prompt, a prompt shown before any A, and a capture start that saves.
    await bootReady();
    server(1000);

    press('Escape');
    expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
    for (let i = 0; i < 8 && navActive() !== 'options'; i += 1) press('ArrowDown');
    expect(navActive(), 'precondition: the cursor is on Options').toBe('options');
    press('Enter');
    expect(navActive(), 'A entered Options on its first child, How to play').toBe('help');
    press('ArrowDown');
    expect(navActive(), 'Down moves onto Options > Controls').toBe('controls');
    expect(menuOptionTexts(), 'Options lists How to play, then Controls').toEqual([
      i18nT('menu.options.help.title'),
      i18nT('menu.options.controls.title'),
    ]);
    const open = press('Enter');
    expect(open.defaultPrevented, 'the A that opened Controls is consumed').toBe(true);
    expect(stackNames(), 'Controls opened ABOVE the menu').toEqual([...CONTROLS_STACK]);
    expect(visibleNow('controls-overlay'), 'the Controls frame is shown').toBe(true);
    expect(menuShown(), 'the menu stays open beneath it').toBe(true);
    expect(navActive(), 'with its cursor still on Controls').toBe('controls');
    expect(byId('controls-title').textContent).toBe(i18nT('controls.title'));

    const tabs = Array.from(document.querySelectorAll('#controls-tabs [role="tab"]'));
    expect(
      tabs.map((tab) => tab.id),
      'two tabs, Buttons then Shortcuts',
    ).toEqual(['controls-tab-buttons', 'controls-tab-shortcuts']);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      i18nT('controls.tab.buttons'),
      i18nT('controls.tab.shortcuts'),
    ]);
    expect(
      tabs.map((tab) => tab.getAttribute('aria-selected')),
      'Buttons is the active tab',
    ).toEqual(['true', 'false']);

    const grid = byId('controls-rows');
    expect(grid.getAttribute('role'), 'the slots are a grid').toBe('grid');
    expect(cellKeys(), 'twelve button rows (Primary, Alt), then Reset all; no Clear').toEqual([
      ...BUTTON_CELLS,
    ]);
    expect(
      grid.querySelectorAll('[role="row"]'),
      'twelve slot rows and the Reset all row',
    ).toHaveLength(13);
    for (const b of VBUTTONS) {
      const row = buttonRow(b);
      const [primary, alt] = DEFAULT_BINDINGS.buttons[b];
      expect(controlsCell(`${b}_0`).dataset.slot, `${b}: the Primary slot`).toBe('primary');
      expect(controlsCell(`${b}_1`).dataset.slot, `${b}: the Alt slot`).toBe('alt');
      expect(cellText(`${b}_0`), `${b}: Primary names the row and its key`).toBe(
        primaryText(row, keycapOf(primary)),
      );
      expect(cellText(`${b}_1`), `${b}: Alt names the row and its key (or none)`).toBe(
        altText(row, keycapOf(alt)),
      );
    }
    const selected = grid.querySelectorAll('[aria-selected="true"]');
    expect(selected, 'exactly one cell holds the cursor').toHaveLength(1);
    expect(grid.getAttribute('aria-activedescendant'), 'the grid names the cursor cell').toBe(
      (selected[0] as HTMLElement | undefined)?.id,
    );
    expect(capturing(), 'no prompt while browsing').toBe(false);
    expect(visibleNow('controls-cancel-btn'), 'no Cancel chip while browsing').toBe(false);

    controlsMoveTo('A_0');
    expect(grid.getAttribute('aria-activedescendant'), 'the moved cursor is named').toBe(
      controlsCell('A_0').id,
    );
    const a = press('Enter');
    expect(a.defaultPrevented, 'A on the slot is consumed').toBe(true);
    expect(capturing(), 'A on a slot starts capture: the prompt shows').toBe(true);
    expect(captureText(), 'the prompt names the row').toBe(capturePrompt(ROW_A));
    expect(captureText(), 'the criterion`s English prompt').toBe(
      `Press a key for Confirm (A)${ELLIPSIS}`,
    );
    expect(visibleNow('controls-cancel-btn'), 'the Cancel chip shows while capturing').toBe(true);
    expect(stackNames(), 'a capture pushes no frame').toEqual([...CONTROLS_STACK]);
    expect(savedRaw(), 'starting a capture saves nothing').toBeNull();
  });

  it('CTL12B-2-LIVE-REMAP: from the Confirm (A) Primary capture, K binds: the cell shows K, the feedback is the bound line, mr.controls holds the new table, and with NO reload K acts as A (it starts a capture on the slot; in the menu it picks the entry under the cursor) while Enter is not consumed and picks nothing', async () => {
    // LEGACY REPLACED (the Red): no Controls screen; a saved table applied only after a reload
    // (`KeyboardSource` took its table at construction).
    // WRONG IMPL KILLED: a capture that saves but never swaps the live table (Enter still picks, K
    // is dead until a reload), one that swaps the router's table but leaves a stale keyboard source
    // or a stale accelerator / screen-context table, a merge that keeps Enter AND adds K, a save
    // that writes the wrong shape (`parseBindings` would fall back to the defaults), a binding at
    // the wrong slot (the Alt Numpad Enter is lost), a captured key that is not prevented, a
    // capture that never ends, and a captured K that is ALSO routed as A (it would start the next
    // capture at once).
    await bootReady();
    server(1000);
    openControls();
    startCapture('A_0');

    const k = press('KeyK', { key: 'k' });
    expect(k.defaultPrevented, 'the captured key is consumed').toBe(true);
    expect(capturing(), 'binding ends the capture').toBe(false);
    expect(stackNames(), 'the frame stays open').toEqual([...CONTROLS_STACK]);
    expect(cellText('A_0'), 'the Primary slot shows K').toBe(primaryText(ROW_A, 'K'));
    expect(cellText('A_1'), 'the Alt slot keeps Numpad Enter').toBe(
      altText(ROW_A, glyph('NumpadEnter')),
    );
    expect(controlsFeedback(), 'the feedback is the bound line').toBe(i18nT('controls.bound'));
    const raw = savedRaw();
    expect(raw, 'the table was saved at once').not.toBeNull();
    expect((JSON.parse(raw ?? 'null') as { v?: unknown }).v, 'as version 1').toBe(1);
    expect(savedTable().buttons.A[0], 'A`s first key is K in storage').toBe('KeyK');
    expect(savedTable(), 'and nothing else changed').toEqual(
      tableWith({ A: ['KeyK', 'NumpadEnter'] }),
    );

    // No reload: in the Controls frame Enter is dead and K is A.
    const enter = press('Enter');
    expect(enter.defaultPrevented, 'Enter is no longer A: it is not consumed').toBe(false);
    expect(capturing(), 'and starts no capture').toBe(false);
    const kA = press('KeyK');
    expect(kA.defaultPrevented, 'K is A now').toBe(true);
    expect(capturing(), 'K on the slot starts a capture').toBe(true);
    press('KeyK'); // the slot's own key: cancel
    expect(capturing(), 'the slot`s own key cancels').toBe(false);
    expect(controlsFeedback()).toBe(i18nT('controls.cancelled'));

    // No reload: in the main menu K picks the entry under the cursor and Enter does not.
    press('Escape');
    expect(stackNames(), 'Start closed everything').toEqual(['world']);
    openMenuOnSocial();
    const menuEnter = press('Enter');
    expect(menuEnter.defaultPrevented, 'Enter is not consumed in the menu').toBe(false);
    expect(menuTitle(), 'Enter picks nothing: the menu stays on its root').toBe(
      i18nT('menu.title'),
    );
    const menuK = press('KeyK');
    expect(menuK.defaultPrevented, 'K is consumed as A').toBe(true);
    expect(menuTitle(), 'K picked Social').toBe(i18nT('menu.social.title'));
    expect(H.sends, 'nothing walked').toHaveLength(0);
  });

  it('CTL12B-2-RELOAD: after remapping A to K through the screen, a fresh boot over the storage that page wrote confirms with K and not with Enter', async () => {
    // LEGACY REPLACED (the Red): no Controls screen to remap from.
    // WRONG IMPL KILLED: a screen that writes a shape boot cannot read (a missing `v: 1`, the
    // buttons under another key: the reload falls back to the defaults and Enter picks again), a
    // save to another storage key, a save that only happens on close (never reached here: the page
    // is torn down with the frame open), and a boot that ignores the saved table.
    await bootReady();
    server(1000);
    openControls();
    startCapture('A_0');
    press('KeyK', { key: 'k' });
    expect(savedTable().buttons.A, 'precondition: the screen saved A := K').toEqual([
      'KeyK',
      'NumpadEnter',
    ]);

    teardown({ keepStorage: true }); // the page goes away; its storage stays
    await bootReady({ keepStorage: true });
    expect(savedRaw(), 'precondition: the reload kept the saved table').not.toBeNull();
    server(1000);
    openMenuOnSocial();
    const enter = press('Enter');
    expect(enter.defaultPrevented, 'after the reload Enter is not A').toBe(false);
    expect(menuTitle(), 'Enter picks nothing').toBe(i18nT('menu.title'));
    const k = press('KeyK');
    expect(k.defaultPrevented, 'K is A').toBe(true);
    expect(menuTitle(), 'K picks Social').toBe(i18nT('menu.social.title'));
  });

  it('CTL12B-2-KEYCAP: after the live remap the A keycap shown is K: the Controls Primary cell reads K, and on the next frame the world chip in front of an NPC reads the interact.chip text with keycap K (it read Enter before), and K is the key that talks', async () => {
    // LEGACY REPLACED (the Red): no Controls screen; the keycap followed the table read at boot.
    // WRONG IMPL KILLED: a chip whose keycap is read from a table captured at boot (it keeps
    // showing Enter after the remap until a reload), a chip memoised past the table change (the
    // text key never changes), a keycap read from the DEFAULT table, a chip that shows K while A
    // is still Enter (the talk below would come from Enter), and a remap that repaints the cell but
    // not the hint.
    await bootReady();
    faceNpcRule();
    server(1000);
    seedNpc(1010);
    frame(1020);
    const talk = i18nT('interact.verb.talk');
    expect(visibleNow('interact-prompt'), 'precondition: the chip shows in front of the NPC').toBe(
      true,
    );
    expect(promptText(), 'precondition: the chip names the default A keycap').toBe(
      tf('interact.chip', { key: glyph('Enter'), verb: talk, name: NPC_NAME }),
    );

    openControls();
    startCapture('A_0');
    press('KeyK', { key: 'k' });
    expect(cellText('A_0'), 'the Controls row`s Primary cell reads K').toBe(
      primaryText(ROW_A, 'K'),
    );
    press('Escape');
    expect(stackNames(), 'Start closed everything').toEqual(['world']);
    frame(pressAt);
    expect(visibleNow('interact-prompt'), 'the chip is back at the world').toBe(true);
    expect(promptText(), 'the next frame`s chip shows the new keycap').toBe(
      tf('interact.chip', { key: 'K', verb: talk, name: NPC_NAME }),
    );

    // The keycap is the key that acts: Enter talks to nobody, K talks to the NPC.
    const enter = press('Enter');
    expect(enter.defaultPrevented, 'Enter is not A at the world').toBe(false);
    expect(
      H.calls.filter((c) => c.name === 'talk'),
      'Enter sent no talk',
    ).toEqual([]);
    press('KeyK');
    expect(
      H.calls.filter((c) => c.name === 'talk'),
      'K talks to the faced NPC',
    ).toEqual([{ name: 'talk', args: { npcEntityId: NPC_ENTITY } }]);
  });

  it('CTL12B-2-CAPTURE-ESCAPE: while the A row`s Alt slot captures, Escape is CAPTURED, not Start: prevented, nothing closes, A`s Alt becomes Escape and Start`s Primary the displaced Numpad Enter, live; Start`s remaining key M then closes everything', async () => {
    // LEGACY REPLACED (the Red): no Controls screen; Escape was always Start (routed in the capture
    // phase before every view), so it could never be bound.
    // WRONG IMPL KILLED: a capture intercept placed after the Escape-as-Start / typing branches
    // (Escape closes the frame and the menu mid-capture), a capture-phase Escape listener that
    // bypasses the intercept, a swap that drops the displaced key (Start keeps only M) or puts it
    // on the wrong slot, a swap that is saved but not applied (Numpad Enter does not open the
    // menu), a swap line that names the wrong rows, and an Escape that is captured but not
    // prevented.
    await bootReady();
    server(1000);
    openControls();
    startCapture('A_1');
    expect(captureText(), 'precondition: the A row is capturing').toBe(capturePrompt(ROW_A));

    const esc = press('Escape', { key: 'Escape' });
    expect(esc.defaultPrevented, 'the captured Escape is consumed').toBe(true);
    expect(stackNames(), 'Escape was captured, not Start: nothing closed').toEqual([
      ...CONTROLS_STACK,
    ]);
    expect(visibleNow('controls-overlay'), 'the Controls frame is still shown').toBe(true);
    expect(menuShown(), 'and the menu beneath it').toBe(true);
    expect(capturing(), 'the swap ended the capture').toBe(false);
    expect(
      savedTable(),
      'A`s Alt is Escape, Start`s Primary is the displaced Numpad Enter',
    ).toEqual(tableWith({ A: ['Enter', 'Escape'], Start: ['NumpadEnter', 'KeyM'] }));
    expect(cellText('A_1')).toBe(altText(ROW_A, glyph('Escape')));
    expect(cellText('Start_0')).toBe(primaryText(buttonRow('Start'), glyph('NumpadEnter')));
    expect(controlsFeedback(), 'the swap line names both rows').toBe(
      outcomeText(
        captureKey(DEFAULT_BINDINGS, { row: ROW_A, slot: 1 }, { code: 'Escape', key: 'Escape' }),
      ),
    );

    const m = press('KeyM');
    expect(m.defaultPrevented, 'M is still Start').toBe(true);
    expect(stackNames(), 'Start`s remaining key closes everything').toEqual(['world']);
    press('NumpadEnter');
    expect(stackNames(), 'live: Start`s new Primary, Numpad Enter, opens the menu').toEqual([
      'world',
      'menuView',
    ]);
    press('KeyM');
    expect(stackNames()).toEqual(['world']);
  });

  it('pressing the capturing slot`s own key cancels: the cancelled line, the table and the storage untouched, and A still on Enter', async () => {
    // WRONG IMPL KILLED: a capture that binds the slot's own key again (a save of an unchanged
    // table), one that ignores it and keeps waiting, a cancel that is also routed as A (it would
    // start the next capture at once), a cancel line that is the bound line, and a cancel that is
    // not prevented.
    await bootReady();
    server(1000);
    openControls();
    startCapture('A_0');
    const again = press('Enter');
    expect(again.defaultPrevented, 'the captured key is consumed').toBe(true);
    expect(capturing(), 'the slot`s own key ends the capture').toBe(false);
    expect(controlsFeedback(), 'with the cancelled line').toBe(i18nT('controls.cancelled'));
    expect(savedRaw(), 'nothing is saved').toBeNull();
    expect(cellText('A_0'), 'the slot still shows Enter').toBe(primaryText(ROW_A, glyph('Enter')));
    expect(stackNames()).toEqual([...CONTROLS_STACK]);
    press('Enter');
    expect(capturing(), 'Enter is still A: it starts the capture again').toBe(true);
  });

  it('Tab while capturing is refused with the reserved reason, is NOT prevented, and the capture keeps waiting: the next K binds', async () => {
    // WRONG IMPL KILLED: a reserved key that ends the capture, one that is bound (Tab would be a
    // game key and keyboard users lose focus movement), one that is prevented (the browser's focus
    // move is swallowed), a refusal without its reason, and a capture that stops listening after
    // a refusal.
    await bootReady();
    server(1000);
    openControls();
    startCapture('A_0');
    const tab = press('Tab', { key: 'Tab' });
    expect(tab.defaultPrevented, 'a reserved key stays the browser`s').toBe(false);
    expect(controlsFeedback(), 'the reserved reason').toBe(i18nT('controls.refused.reserved'));
    expect(capturing(), 'the capture keeps waiting').toBe(true);
    expect(captureText(), 'for the same row').toBe(capturePrompt(ROW_A));
    expect(savedRaw(), 'nothing is saved').toBeNull();

    const k = press('KeyK', { key: 'k' });
    expect(k.defaultPrevented).toBe(true);
    expect(capturing(), 'the next key binds').toBe(false);
    expect(controlsFeedback()).toBe(i18nT('controls.bound'));
    expect(savedTable().buttons.A[0]).toBe('KeyK');
  });

  it('a capture that would empty a protected button is refused with its reason, changes nothing, keeps capturing (Backspace is not B there), and the row`s own key then cancels', async () => {
    // WRONG IMPL KILLED: a protected refusal that still saves or applies the half-swap (B would be
    // left with no key), one that ends the capture, one whose Backspace is routed as B (the frame
    // pops mid-capture), and a refusal shown with the reserved reason.
    await bootReady();
    server(1000);
    const rowX = buttonRow('X');
    // Fixture: X's Alt slot is empty and Backspace is B's only key, so the swap would empty B.
    expect(
      captureKey(DEFAULT_BINDINGS, { row: rowX, slot: 1 }, { code: 'Backspace', key: '' }),
      'fixture: this press is a protected refusal',
    ).toEqual({ kind: 'refused', reason: 'protected' });
    openControls();
    startCapture('X_1');
    expect(captureText(), 'precondition: the X row is capturing').toBe(capturePrompt(rowX));

    const back = press('Backspace');
    expect(back.defaultPrevented, 'a refused (not reserved) key is still consumed').toBe(true);
    expect(controlsFeedback(), 'the protected reason').toBe(i18nT('controls.refused.protected'));
    expect(capturing(), 'the capture keeps waiting').toBe(true);
    expect(stackNames(), 'Backspace was captured, not B: nothing closed').toEqual([
      ...CONTROLS_STACK,
    ]);
    expect(savedRaw(), 'nothing is saved').toBeNull();
    expect(cellText('B_0'), 'B keeps Backspace').toBe(
      primaryText(buttonRow('B'), glyph('Backspace')),
    );

    press('Space'); // X's own key: cancel
    expect(capturing(), 'the row`s own key cancels').toBe(false);
    expect(controlsFeedback()).toBe(i18nT('controls.cancelled'));
    press('Backspace');
    expect(stackNames(), 'B still pops Controls back to the menu').toEqual(['world', 'menuView']);
  });

  it('an OS key-repeat of the Enter that started the capture neither cancels nor binds; the capture keeps waiting for a fresh press', async () => {
    // WRONG IMPL KILLED: a capture intercept placed ahead of the OS-repeat branch (the held Enter's
    // first repeat, 30 ms after the press, is "the slot's own key" and cancels the capture before
    // the player can let go), and one that binds a repeat.
    await bootReady();
    server(1000);
    openControls();
    controlsMoveTo('A_0');
    fire('keydown', 'Enter', pressAt); // held: no keyup yet
    expect(capturing(), 'precondition: the press started the capture').toBe(true);
    fire('keydown', 'Enter', pressAt + 30, { repeat: true });
    fire('keydown', 'Enter', pressAt + 60, { repeat: true });
    expect(capturing(), 'the OS repeats did not end the capture').toBe(true);
    expect(controlsFeedback(), 'and wrote no outcome line').toBe('');
    expect(savedRaw(), 'and saved nothing').toBeNull();
    fire('keyup', 'Enter', pressAt + 90);
    pressAt += 200;

    press('KeyK', { key: 'k' });
    expect(capturing()).toBe(false);
    expect(savedTable().buttons.A[0], 'the fresh press binds').toBe('KeyK');
  });

  it('Clear on an accelerator row (Shortcuts, reached by RB) unbinds it at once: the cleared line, an empty slot, [] in storage, and back at the world its key opens nothing while J still does', async () => {
    // WRONG IMPL KILLED: a Clear that is saved but not applied (I still opens the Bag), one that is
    // applied but not saved, one that clears the wrong row or every row (J is the control), a Clear
    // that starts a capture instead, a cleared line naming the wrong row, and an RB that does not
    // switch to Shortcuts.
    await bootReady();
    server(1000);
    openControls();
    const rb = press('KeyE');
    expect(rb.defaultPrevented, 'RB is consumed by the frame').toBe(true);
    expect(byId('controls-tab-shortcuts').getAttribute('aria-selected'), 'RB: Shortcuts').toBe(
      'true',
    );
    expect(cellKeys(), 'every accelerator row has Primary, Alt and Clear').toEqual([
      ...SHORTCUT_CELLS,
    ]);
    controlsMoveTo('I_clear');
    const clear = press('Enter');
    expect(clear.defaultPrevented, 'A on Clear is consumed').toBe(true);
    expect(capturing(), 'Clear starts no capture').toBe(false);
    const rowI: ControlsRow = { kind: 'accel', id: 'I' };
    expect(controlsFeedback(), 'the cleared line names the row').toBe(
      tf('controls.cleared', { label: rowLabel(rowI) }),
    );
    expect(cellText('I_0'), 'the Primary slot is empty now').toBe(
      primaryText(rowI, keycapOf(undefined)),
    );
    expect(
      (JSON.parse(savedRaw() ?? 'null') as { accels?: { I?: unknown } }).accels?.I,
      'storage holds [] for the row',
    ).toEqual([]);
    expect(savedTable(), 'and nothing else changed').toEqual(tableWith({}, { I: [] }));

    press('Escape');
    expect(stackNames(), 'Start closed everything').toEqual(['world']);
    const i = press('KeyI');
    expect(i.defaultPrevented, 'the cleared key is not consumed').toBe(false);
    expect(stackNames(), 'and opens no Bag').toEqual(['world']);
    const j = press('KeyJ');
    expect(j.defaultPrevented, 'control: J is still an accelerator').toBe(true);
    expect(stackNames(), 'control: J opens the Journal').toEqual([
      'world',
      'menuView',
      'questLogView',
    ]);
  });

  it('Reset all asks Yes / No with the cursor on No: No changes nothing; Yes restores the defaults live and in storage', async () => {
    // WRONG IMPL KILLED: a confirm that defaults to Yes (one stray A wipes a custom table), a No
    // that resets anyway, a Yes that saves the defaults but leaves the live table (K still A,
    // Enter dead), one that applies but does not save, a reset that leaves the question up, and a
    // Reset all that resets with no question at all.
    await bootReady();
    server(1000);
    openControls();
    startCapture('A_0');
    press('KeyK', { key: 'k' });
    expect(savedTable().buttons.A[0], 'precondition: A := K').toBe('KeyK');

    controlsMoveTo('reset');
    expect(cellText('reset')).toBe(i18nT('controls.resetAll'));
    press('KeyK'); // A
    expect(visibleNow('controls-question'), 'Reset all asks').toBe(true);
    expect(byId('controls-question').textContent).toBe(i18nT('controls.reset.question'));
    expect(cellKeys(), 'the answers are Yes and No').toEqual(['yes', 'no']);
    expect(controlsActive(), 'the cursor starts on No').toBe('no');
    expect(savedTable().buttons.A[0], 'asking changes nothing').toBe('KeyK');

    press('KeyK'); // A on No
    expect(visibleNow('controls-question'), 'No closes the question').toBe(false);
    expect(savedTable(), 'No changes nothing').toEqual(tableWith({ A: ['KeyK', 'NumpadEnter'] }));
    expect(cellText('A_0'), 'the slots are back, A still on K').toBe(primaryText(ROW_A, 'K'));
    expect(controlsActive(), 'the cursor is back on Reset all').toBe('reset');

    press('KeyK'); // ask again
    expect(controlsActive(), 'again on No').toBe('no');
    press('ArrowUp');
    expect(controlsActive(), 'Up moves to Yes').toBe('yes');
    press('KeyK'); // A on Yes
    expect(visibleNow('controls-question'), 'Yes closes the question').toBe(false);
    expect(controlsFeedback(), 'the reset line').toBe(i18nT('controls.reset.done'));
    expect(savedTable(), 'storage holds the defaults').toEqual(tableWith({}));
    expect(cellText('A_0'), 'A shows Enter again').toBe(primaryText(ROW_A, glyph('Enter')));

    const k = press('KeyK');
    expect(k.defaultPrevented, 'live: K is no longer A').toBe(false);
    expect(visibleNow('controls-question'), 'K asks nothing').toBe(false);
    const enter = press('Enter');
    expect(enter.defaultPrevented, 'live: Enter is A again').toBe(true);
    expect(visibleNow('controls-question'), 'Enter on Reset all asks again').toBe(true);
  });

  it('a Controls frame closed mid-capture by a server conversation leaves no capture behind: no key is bound meanwhile, and reopened it is browsing and keys route normally', async () => {
    // WRONG IMPL KILLED: a capture flag kept by the view or the adapter across a close (the next
    // key, at the dialogue or in the reopened frame, is silently bound and saved), a capture
    // intercept that does not check the Controls frame is on top, a reopened frame that shows the
    // stale prompt or feedback, and a close that leaves the frame on the stack.
    await bootReady();
    server(1000);
    seedNpc(1010);
    openControls();
    startCapture('A_0');

    startConversation(pressAt);
    expect(stackNames(), 'the conversation closed Controls and the menu').toEqual([
      'world',
      'dialogueView',
    ]);
    expect(visibleNow('controls-overlay'), 'the Controls frame is hidden').toBe(false);
    const kAtDialogue = press('KeyK', { key: 'k' });
    expect(kAtDialogue.defaultPrevented, 'K at the dialogue is not taken').toBe(false);
    expect(savedRaw(), 'and binds nothing').toBeNull();
    endConversation(pressAt);
    expect(stackNames(), 'precondition: the conversation is over').toEqual(['world']);

    openControls();
    expect(capturing(), 'reopened, Controls is browsing').toBe(false);
    expect(visibleNow('controls-cancel-btn'), 'with no Cancel chip').toBe(false);
    expect(controlsFeedback(), 'and no stale line').toBe('');
    const before = controlsActive();
    const downKey = press('ArrowDown');
    expect(downKey.defaultPrevented, 'the D-pad is routed').toBe(true);
    expect(controlsActive(), 'and moves the cursor').not.toBe(before);
    expect(capturing()).toBe(false);
    const k = press('KeyK', { key: 'k' });
    expect(k.defaultPrevented, 'an unbound K is not taken').toBe(false);
    expect(savedRaw(), 'nothing was bound').toBeNull();
    press('Enter');
    expect(capturing(), 'A on a slot starts a fresh capture').toBe(true);
  });

  it('a save that throws still applies the table live, and the feedback line carries the save failure', async () => {
    // WRONG IMPL KILLED: a remap applied only when the save succeeds (a full or denied storage
    // makes remapping impossible), a save exception that escapes the key listener (the capture
    // never ends), and a failure that is silent (the player believes it was saved).
    await bootReady();
    server(1000);
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (key === STORAGE_KEY) throw new Error('QuotaExceededError: storage is full');
      realSet.call(this, key, value);
    });
    openControls();
    startCapture('A_0');
    const k = press('KeyK', { key: 'k' });
    expect(k.defaultPrevented).toBe(true);
    expect(capturing(), 'the capture ended').toBe(false);
    expect(controlsFeedback(), 'the outcome line').toContain(i18nT('controls.bound'));
    expect(controlsFeedback(), 'carries the save failure').toContain(i18nT('controls.saveFailed'));
    expect(savedRaw(), 'nothing reached storage').toBeNull();
    expect(cellText('A_0'), 'the slot shows K').toBe(primaryText(ROW_A, 'K'));

    press('Escape');
    openMenuOnSocial();
    const enter = press('Enter');
    expect(enter.defaultPrevented, 'applied live: Enter is not A').toBe(false);
    expect(menuTitle()).toBe(i18nT('menu.title'));
    press('KeyK');
    expect(menuTitle(), 'applied live: K picks Social').toBe(i18nT('menu.social.title'));
  });

  it('typing mode is literal: with A bound to K, Enter in a focused text field inside the menu is prevented and commits as A (it picks Social), while K in that field is typed: neither prevented nor routed', async () => {
    // WRONG IMPL KILLED: a typing mode that routes Enter through the table (with A := K a nickname
    // or name could never be committed by Enter), one that lets the field's own letter K reach the
    // router as A (typing "k" picks a menu entry), and a commit that is not prevented.
    await bootReady({ stored: storedTable((raw) => (raw.buttons.A = ['KeyK'])) });
    server(1000);
    openMenuOnSocial();
    const field = document.createElement('input');
    field.type = 'text';
    byId('menu-overlay').appendChild(field);
    field.focus();
    expect(document.activeElement, 'precondition: the field has focus').toBe(field);

    const k = press('KeyK', { key: 'k' }, field);
    expect(k.defaultPrevented, 'K is typed: the field owns it').toBe(false);
    expect(menuTitle(), 'and picks nothing').toBe(i18nT('menu.title'));
    expect(navActive(), 'nor moves the cursor').toBe('social');

    const enter = press('Enter', { key: 'Enter' }, field);
    expect(enter.defaultPrevented, 'Enter in a field commits').toBe(true);
    expect(menuTitle(), 'commit = A: it picked Social').toBe(i18nT('menu.social.title'));
  });

  it('the IME guard runs before F8 / F9: with Start on M and F9 on Escape, an Escape that cancels a composition in the focused Name field downloads nothing and is not prevented; the same Escape outside a field still downloads', async () => {
    // WRONG IMPL KILLED: an F8 / F9 accelerator branch placed ahead of the IME guard (cancelling a
    // composition downloads a bug bundle and drops the draft), an IME Escape that is prevented, and
    // one that stops typing or closes the frame.
    const stored = storedTable((raw) => {
      raw.buttons.Start = ['KeyM'];
      raw.accels.F9 = ['Escape'];
    });
    await bootReady({ stored });
    const downloads = recordDownloads();
    server(1000);
    press('KeyN');
    expect(stackNames(), 'precondition: the Name screen is open').toEqual([
      'world',
      'menuView',
      'renameView',
    ]);
    const input = byId('rename-input') as HTMLInputElement;
    input.focus();
    expect(document.activeElement, 'precondition: the Name field has focus').toBe(input);

    const ime = press('Escape', { key: 'Escape', isComposing: true, keyCode: 229 }, input);
    expect(ime.defaultPrevented, 'the IME`s Escape is left to the IME').toBe(false);
    expect(downloads.urls, 'no bug bundle is built').toHaveLength(0);
    expect(downloads.clicks, 'and none downloaded').toHaveLength(0);
    expect(stackNames(), 'nothing closed').toEqual(['world', 'menuView', 'renameView']);
    expect(document.activeElement, 'typing goes on').toBe(input);

    // Control: Escape IS the F9 key here once it is neither an IME's nor a field's.
    press('Escape', { key: 'Escape' }, input); // stops typing: focus leaves the field
    expect(document.activeElement, 'precondition: typing stopped').not.toBe(input);
    const f9 = press('Escape', { key: 'Escape' });
    expect(f9.defaultPrevented, 'control: the F9 key is consumed').toBe(true);
    expect(downloads.urls, 'control: and downloads one bundle').toHaveLength(1);
  });
});
