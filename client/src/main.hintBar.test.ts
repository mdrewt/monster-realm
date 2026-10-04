// @vitest-environment happy-dom
/**
 * main.hintBar.test.ts: the LIVE hint bar through a booted main.ts (ctl-13, CTL13.1). The bar is
 * driven every frame by the pure `hintBar(stack, bindings, notices, world)`: its chips show the
 * live keycaps of the binding table (a remap shows on the next frame), the verb of whatever is
 * faced, Y / B while a request waits and there is no target, and the Start badge.
 *
 * SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-13;
 * memory/projects/monster-realm-ctl-13-plan.md (REV 2: `.mr-chip-key` / `.mr-chip-verb` /
 * `.mr-chip-badge`; non-Start/Select chips are pointer-events:none spans).
 *
 * Harness: main.notices.test.ts's / main.remap.test.ts's pattern (vi.resetModules + a fresh import
 * per boot, the real client/index.html shell, one controllable clock and rAF, a stubbed wasm pkg
 * and SDK connection). The live remap goes through the REAL Options > Controls screen (the real
 * binding store path), and a stored table is the boot-time path (`mr.controls` in localStorage).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WasmMoveInput } from './convert/convert';
import { DEFAULT_BINDINGS } from './input/bindings';
import { VBUTTONS } from './input/buttons';
import type { Connection, ConnectionOptions } from './net/connection';
import type { StoreTradeOffer } from './net/store';
import { t as i18nT } from './ui/i18n/resolver';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
  interact: ((..._args: unknown[]) => []) as (...args: unknown[]) => unknown,
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
let T = 1000;
const next = (ms: number): number => {
  T += ms;
  return T;
};

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

const STORAGE_KEY = 'mr.controls';

/** Boot a fresh main.ts; `stored` is written to `mr.controls` BEFORE the import (a saved table). */
async function bootReady(stored?: string): Promise<void> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  H.interact = () => [];
  T = 1000;
  clock.t = T;
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(STORAGE_KEY, stored);
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
  opts.onReady(H.identity);
}

function frame(ms = 50): void {
  const cb = rafCallback;
  if (cb === null) throw new Error('no rAF callback armed');
  rafCallback = null;
  clock.t = next(ms);
  cb(clock.t);
  expect(rafCallback, 'frame did not re-arm requestAnimationFrame').not.toBeNull();
}

const EID = 7n;
const BOB = 'bb'.repeat(32);

function batch(): void {
  clock.t = next(50);
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
    clock.t,
  );
  opts.store.flushBatch();
}

function press(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  clock.t = next(50);
  const down = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(down);
  clock.t = next(5);
  window.dispatchEvent(
    new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true, ...init }),
  );
  return down;
}

const BACKSPACE_GLYPH = String.fromCharCode(0x232b);

interface ChipRead {
  readonly button: string;
  readonly key: string | null;
  readonly verb: string | null;
  readonly badge: string | null;
  readonly tag: string;
}
/** The hint bar's chips in DOM order, as a player reads them. */
const chipsNow = (): ChipRead[] =>
  [...document.querySelectorAll('#hint-bar [data-button]')].map((el) => ({
    button: el.getAttribute('data-button') ?? '',
    key: el.querySelector('.mr-chip-key')?.textContent ?? null,
    verb: el.querySelector('.mr-chip-verb')?.textContent ?? null,
    badge: el.querySelector('.mr-chip-badge')?.textContent ?? null,
    tag: el.tagName,
  }));
const chipOf = (button: string): ChipRead => {
  const found = chipsNow().find((c) => c.button === button);
  if (found === undefined) throw new Error(`no ${button} chip in the hint bar`);
  return found;
};
const buttonsNow = (): string[] => chipsNow().map((c) => c.button);

interface FrameJson {
  readonly kind: string;
  readonly id?: string;
}
interface GameHook {
  readonly stack: FrameJson[];
  readonly navActive: string | null;
}
const game = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();
const stackNames = (): string[] =>
  game().stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id as string) : f.kind));

const offerFrom = (from: string, tradeId: bigint, createdAtMs: bigint): StoreTradeOffer => ({
  tradeId,
  initiator: from,
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
  createdAtMs,
});

const NPC_ENTITY = 11n;
/** A dialogue NPC on (3, 6) (the tile the player on (2, 6) facing East faces), which the stubbed
 *  wasm rule names as the faced candidate, in one batch. */
function seedFacedNpc(): void {
  opts.store.upsertNpc({
    entityId: NPC_ENTITY,
    npcId: 'guide',
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
    clock.t,
  );
  H.interact = (...args: unknown[]) => {
    const entities = args[4];
    if (!Array.isArray(entities)) return [];
    const at = entities.findIndex(
      (e: { kind?: unknown; id?: unknown }) => e.kind === 'npc' && e.id === NPC_ENTITY.toString(),
    );
    return at === -1 ? [] : [at];
  };
  batch();
}
function removeFacedNpc(): void {
  opts.store.removeNpc(NPC_ENTITY);
  opts.store.removeCharacter(NPC_ENTITY);
  batch();
}

/** A stored `mr.controls` table: the defaults with `change` applied. */
const storedTable = (
  change: (raw: { buttons: Record<string, string[]>; accels: Record<string, string[]> }) => void,
): string => {
  const raw = JSON.parse(
    JSON.stringify({ buttons: DEFAULT_BINDINGS.buttons, accels: DEFAULT_BINDINGS.accels }),
  );
  change(raw);
  return JSON.stringify({ v: 1, ...raw });
};

/** The Buttons tab's cell keys in display order (two columns per button row, then Reset all). */
const BUTTON_CELLS: readonly string[] = [...VBUTTONS.flatMap((b) => [`${b}_0`, `${b}_1`]), 'reset'];
const controlsActive = (): string | null =>
  document.querySelector('#controls-rows [aria-selected="true"]')?.getAttribute('data-nav-key') ??
  null;

describe('main.ts live hint bar over the real shell (runtime, ctl-13)', {
  sequential: true,
}, () => {
  afterEach(teardown);

  it('CTL13-1-BOOT-LIVE: the bar shows the live keycaps and verbs of the world (Start and Select as the shipped buttons, A with the faced target, Y and B while a request waits with no target, a sheet, a menu frame), the Start badge follows the waiting request, a remap made in Options > Controls or stored in mr.controls shows on the next frame, and the new chips are clickable, non-focusable spans', async () => {
    // LEGACY REPLACED (the Red): the two chips were written ONCE at boot (their text and nothing
    // else), so a remap changed no keycap, no verb followed the faced target or the open frame,
    // and no chip existed for A, B or Y.
    // WRONG IMPL KILLED: a bar painted once at boot (static); keycaps from the default table
    // instead of the live one (a remap lies until a reload); a bar painted only on a batch or a
    // key (a remap shows a frame late or never); the A chip beside no target or without the
    // target's verb; Y / B missing while a request waits, shown beside a target, or B kept after
    // its banner was dismissed; Y dropped after the banner was dismissed; the badge missing, kept
    // after the request goes, or put on another chip; the frame chips (ok / back / close) not
    // following the top of the stack; a new chip that is a <button> (a tab stop) or keeps an inline
    // pointer-events:none (ctl-15: chips are clicked, CTL15.5); and a stored
    // table that the bar does not read.
    const ESC = i18nT('key.escape');
    const menuVerb = i18nT('chrome.chip.menu');
    const helpVerb = i18nT('chrome.chip.help');
    const badgeText = i18nT('chrome.badge.request');

    // --- the bare world: Start and Select, as the shipped buttons -----------------------------
    await bootReady();
    batch();
    frame();
    expect(chipsNow(), 'at the bare world: Start and Select only').toEqual([
      { button: 'Start', key: ESC, verb: menuVerb, badge: null, tag: 'BUTTON' },
      { button: 'Select', key: 'R', verb: helpVerb, badge: null, tag: 'BUTTON' },
    ]);
    expect(ESC, 'fixture: the Start keycap is the catalog name').toBe('Esc');
    expect(document.getElementById('chip-start'), 'Start is the shipped button').toBe(
      document.querySelector('#hint-bar [data-button="Start"]'),
    );
    expect(document.getElementById('chip-select')).toBe(
      document.querySelector('#hint-bar [data-button="Select"]'),
    );

    // --- a faced target: A names its verb ------------------------------------------------------
    seedFacedNpc();
    frame();
    expect(buttonsNow(), 'A joins the bar beside a faced target').toEqual(['A', 'Start', 'Select']);
    expect(chipOf('A'), 'A reads its live keycap and the target`s verb').toEqual({
      button: 'A',
      key: 'Enter',
      verb: i18nT('interact.verb.talk'),
      badge: null,
      tag: 'SPAN',
    });
    const aSpan = document.querySelector('#hint-bar [data-button="A"]') as HTMLElement;
    // ctl-15 (named intentional change, CTL15.5): was `toBe('none')`; the chip now takes the click
    // the #game-screen pointer dispatcher turns into a press of A.
    expect(aSpan.style.pointerEvents, 'a new chip has no inline pointer-events').toBe('');
    expect(aSpan.hasAttribute('tabindex')).toBe(false);
    removeFacedNpc();
    frame();
    expect(buttonsNow(), 'the target goes, so does the A chip').toEqual(['Start', 'Select']);

    // --- a request waits, no target: Y, B and the Start badge ---------------------------------
    opts.store.upsertPlayer({
      identity: BOB,
      entityId: 8n,
      name: 'Bob',
      online: true,
      lastInputSeq: 0n,
    });
    opts.store.upsertTradeOffer(offerFrom(BOB, 11n, 1_000n));
    batch();
    frame();
    expect(chipsNow(), 'Y (view), B (dismiss), Start badged, Select').toEqual([
      { button: 'Y', key: 'F', verb: i18nT('chrome.chip.view'), badge: null, tag: 'SPAN' },
      {
        button: 'B',
        key: BACKSPACE_GLYPH,
        verb: i18nT('chrome.chip.dismiss'),
        badge: null,
        tag: 'SPAN',
      },
      { button: 'Start', key: ESC, verb: menuVerb, badge: badgeText, tag: 'BUTTON' },
      { button: 'Select', key: 'R', verb: helpVerb, badge: null, tag: 'BUTTON' },
    ]);
    expect(badgeText, 'fixture: the badge is real text').not.toBe('');

    // A faced target takes Y and B away (A answers it); the badge stays.
    seedFacedNpc();
    frame();
    expect(buttonsNow(), 'a target replaces Y and B').toEqual(['A', 'Start', 'Select']);
    expect(chipOf('Start').badge, 'the badge stays while the request waits').toBe(badgeText);
    removeFacedNpc();
    frame();

    // Y opens the request sheet: the bar reads A ok / B back / Start / Select.
    press('KeyF');
    frame();
    expect(
      chipsNow().map((c) => [c.button, c.key, c.verb, c.badge]),
      'with the request sheet open',
    ).toEqual([
      ['A', 'Enter', i18nT('chrome.chip.ok'), null],
      ['B', BACKSPACE_GLYPH, i18nT('chrome.chip.back'), null],
      ['Start', ESC, menuVerb, badgeText],
      ['Select', 'R', helpVerb, null],
    ]);
    press('Backspace'); // B closes the sheet
    frame();
    expect(buttonsNow(), 'back to the request bar').toEqual(['Y', 'B', 'Start', 'Select']);
    press('Backspace'); // B dismisses the banner
    frame();
    expect(
      buttonsNow(),
      'a dismissed banner drops B; Y and the badge stay while the request waits',
    ).toEqual(['Y', 'Start', 'Select']);
    expect(chipOf('Start').badge).toBe(badgeText);

    // A screen frame over the world: A ok / B back / Start close / Select help.
    press('Escape');
    frame();
    expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
    expect(
      chipsNow().map((c) => [c.button, c.key, c.verb]),
      'over the menu',
    ).toEqual([
      ['A', 'Enter', i18nT('chrome.chip.ok')],
      ['B', BACKSPACE_GLYPH, i18nT('chrome.chip.back')],
      ['Start', ESC, i18nT('chrome.chip.close')],
      ['Select', 'R', helpVerb],
    ]);
    press('Escape');
    frame();
    expect(stackNames()).toEqual(['world']);

    // The request is withdrawn: Y and the badge go.
    opts.store.removeTradeOffer(11n);
    batch();
    frame();
    expect(chipsNow(), 'nothing waits: Start and Select, no badge').toEqual([
      { button: 'Start', key: ESC, verb: menuVerb, badge: null, tag: 'BUTTON' },
      { button: 'Select', key: 'R', verb: helpVerb, badge: null, tag: 'BUTTON' },
    ]);

    // --- a live remap made in Options > Controls shows on the next frame ----------------------
    teardown();
    await bootReady();
    batch();
    frame();
    expect(chipOf('Select').key, 'precondition: Select is on R').toBe('R');
    press('Escape');
    for (let i = 0; i < 8 && game().navActive !== 'options'; i += 1) press('ArrowDown');
    expect(game().navActive, 'precondition: the menu cursor is on Options').toBe('options');
    press('Enter');
    for (let i = 0; i < 2 && game().navActive !== 'controls'; i += 1) press('ArrowDown');
    expect(game().navActive, 'precondition: the cursor is on Options > Controls').toBe('controls');
    press('Enter');
    expect(stackNames(), 'precondition: Controls opened above the menu').toEqual([
      'world',
      'menuView',
      'controlsView',
    ]);
    // Walk the cursor down to the Select row's Primary slot (two columns per row).
    const here = BUTTON_CELLS.indexOf(controlsActive() ?? '');
    const there = BUTTON_CELLS.indexOf('Select_0');
    expect(here, 'precondition: the Controls cursor is on a Buttons cell').toBeGreaterThanOrEqual(
      0,
    );
    for (let r = Math.floor(here / 2); r < Math.floor(there / 2); r += 1) press('ArrowDown');
    expect(controlsActive(), 'precondition: the cursor is on the Select Primary slot').toBe(
      'Select_0',
    );
    press('Enter'); // A starts the capture
    press('KeyZ', { key: 'z' }); // the next key is bound
    frame();
    expect(chipOf('Select').key, 'the Select chip shows the remapped key on the next frame').toBe(
      'Z',
    );
    expect(chipOf('Select').key, 'not the old default').not.toBe('R');
    expect(chipOf('Start').key, 'an untouched chip keeps its keycap').toBe(ESC);
    press('Escape');
    frame();
    expect(stackNames(), 'precondition: Start closed Controls and the menu').toEqual(['world']);
    expect(chipOf('Select').key, 'and at the bare world too').toBe('Z');

    // --- a saved table is read at boot --------------------------------------------------------
    teardown();
    await bootReady(
      storedTable((raw) => {
        raw.buttons.Start = ['KeyG', 'KeyM'];
        raw.buttons.Select = ['Slash'];
      }),
    );
    batch();
    frame();
    expect(chipOf('Start').key, 'the saved Start key').toBe('G');
    expect(chipOf('Select').key, 'the saved Select key (a named key reads its catalog name)').toBe(
      i18nT('key.slash'),
    );
    expect(chipOf('Start').verb, 'verbs are unaffected by a remap').toBe(menuVerb);
  }, 120_000);
});

// ==========================================================================================
// ctl-15: the pointer dispatcher wired into the booted main.ts (CTL15.1, CTL15.3, CTL15.4)
// ==========================================================================================

const gameScreenEl = (): HTMLElement => document.getElementById('game-screen') as HTMLElement;
/** The canvas the (stubbed) renderer mounts inside #game-screen. */
const worldCanvas = (): Promise<HTMLElement> =>
  vi.waitFor(
    () => {
      const c = document.querySelector<HTMLElement>('#game-screen canvas');
      if (c === null) throw new Error('the world canvas is not mounted yet');
      return c;
    },
    { timeout: 5_000, interval: 5 },
  );
const leftClick = (el: Element): void => {
  clock.t = next(50);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
};
const mouseMove = (el: Element, x: number, y: number): void => {
  clock.t = next(20);
  el.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      pointerType: 'mouse',
      clientX: x,
      clientY: y,
    }),
  );
};
const talks = (): number => H.calls.filter((c) => c.name === 'talk').length;

/** From the bare world: Start, the menu to Options > Controls, A. */
function openControls(): void {
  press('Escape');
  for (let i = 0; i < 8 && game().navActive !== 'options'; i += 1) press('ArrowDown');
  press('Enter');
  for (let i = 0; i < 2 && game().navActive !== 'controls'; i += 1) press('ArrowDown');
  press('Enter');
  expect(stackNames(), 'precondition: Controls opened above the menu').toEqual([
    'world',
    'menuView',
    'controlsView',
  ]);
}

describe('main.ts pointer wiring over the real shell (runtime, ctl-15)', {
  sequential: true,
}, () => {
  afterEach(teardown);

  it('ctl-15 boot: the world canvas carries mr-world-canvas; a left click on it at the bare world presses A (talks to the faced NPC); with a frame on top the same click does nothing', async () => {
    // WRONG IMPL KILLED: a dispatcher never attached at boot (or attached before the canvas and
    // holding a stale null), the canvas class missing (styles.css's touch-action rule would then
    // style nothing), and a canvas click that acts under the menu.
    await bootReady();
    batch();
    seedFacedNpc();
    frame();
    const canvas = await worldCanvas();
    expect(canvas.classList.contains('mr-world-canvas'), 'the canvas class').toBe(true);
    leftClick(canvas);
    expect(talks(), 'the click pressed A: one talk to the faced NPC').toBe(1);
    press('Escape');
    frame();
    expect(stackNames(), 'precondition: the menu is on top').toEqual(['world', 'menuView']);
    leftClick(canvas);
    expect(talks(), 'a canvas click under a frame presses nothing').toBe(1);
    expect(stackNames()).toEqual(['world', 'menuView']);
  }, 120_000);

  it('ctl-15 boot: a keydown hides the hover state a mouse move over #game-screen set', async () => {
    // WRONG IMPL KILLED: handleKeyDown never calling the source's keyPressed (the hover mark stays
    // on while the player drives with the keyboard).
    await bootReady();
    batch();
    frame();
    const canvas = await worldCanvas();
    mouseMove(canvas, 40, 50);
    expect(gameScreenEl().classList.contains('mr-pointer-hover'), 'the mouse shows it').toBe(true);
    press('ArrowUp');
    expect(gameScreenEl().classList.contains('mr-pointer-hover'), 'a key hides it').toBe(false);
  }, 120_000);

  it('ctl-15 boot: in Options > Controls a hover seek leaves no repeat armed; a click on the active cell starts the capture, and a right-click on #game-screen ends it without pressing B', async () => {
    // WRONG IMPL KILLED: a pointer press that sends the down edge only (the router's auto-repeat
    // stays armed and walks the cursor on at +350 ms with no key held); a right-click during the
    // capture that presses B (Controls would close) or does not cancel (the next key is bound).
    await bootReady();
    batch();
    frame();
    openControls();
    const here = BUTTON_CELLS.indexOf(controlsActive() ?? '');
    expect(here, 'precondition: the cursor is on a Buttons cell').toBeGreaterThanOrEqual(0);
    const target = BUTTON_CELLS[here + 4] as string;
    const cell = (): HTMLElement => {
      const el = document.querySelector<HTMLElement>(`#controls-rows [data-nav-key="${target}"]`);
      if (el === null) throw new Error(`no Controls cell ${target}`);
      return el;
    };

    mouseMove(cell(), 31, 77);
    expect(controlsActive(), 'the hover walked the cursor two rows down').toBe(target);
    frame(400);
    frame(200);
    frame(300);
    expect(controlsActive(), 'no repeat left armed: the cursor stays').toBe(target);
    expect(stackNames()).toEqual(['world', 'menuView', 'controlsView']);

    expect(localStorage.getItem(STORAGE_KEY), 'precondition: nothing saved').toBeNull();
    leftClick(cell());
    clock.t = next(50);
    const back = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    cell().dispatchEvent(back);
    expect(back.defaultPrevented, 'the right-click is taken').toBe(true);
    expect(stackNames(), 'cancelling the capture is not a B: Controls stays').toEqual([
      'world',
      'menuView',
      'controlsView',
    ]);
    press('KeyZ', { key: 'z' });
    expect(localStorage.getItem(STORAGE_KEY), 'the capture had ended: Z bound nothing').toBeNull();

    // Control: a click starts a live capture that does bind the next key.
    leftClick(cell());
    press('KeyZ', { key: 'z' });
    expect(localStorage.getItem(STORAGE_KEY) ?? '', 'control: a live capture binds Z').toContain(
      'KeyZ',
    );
  }, 120_000);
});
