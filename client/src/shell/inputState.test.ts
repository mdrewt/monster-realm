// @vitest-environment happy-dom
// shell/inputState — the input devices and the binding table main.ts drives. A real boot of
// main.ts on the real index.html shell routes real key events through this module; the suite reads
// the devices back through `./inputState` in the same module registry and checks they are the
// instances the shell drives. A second block imports the module on its own (no boot) and checks
// its functions directly.
// Harness: views.test.ts's pattern (vi.resetModules + a fresh import per boot, one controllable
// clock and rAF, a stubbed wasm pkg, SDK connection, telemetry and renderer).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  connectionRecordingMock,
  frame,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../../test-util/mainBootHarness';
import type { WasmMoveInput } from '../convert/convert';
import { CONTROLS_STORAGE_KEY } from '../input/bindingStore';
import { type Bindings, DEFAULT_BINDINGS } from '../input/bindings';
import { VBUTTONS } from '../input/buttons';
import { glyph } from '../input/glyphs';
import { PAD_DEFAULT_BINDINGS } from '../input/padBindings';
import { padGlyph } from '../input/padGlyphs';
import type { ConnectionOptions } from '../net/connection';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
}));

// The 17 `tactics_*` exports the rules port binds (`bindTacticsRules` refuses a pkg missing any).
vi.mock('../../../client-wasm/pkg/client_wasm.js', () => ({
  ...wasmPkgWalkingMock(),
  tactics_map: () => ({
    width: 7,
    height: 5,
    tiles: [],
    spawn_a: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ],
    spawn_b: [],
  }),
  tactics_fresh_budget: () => ({ ap: 6, strides_used: 0, attacks: 0, last: null }),
  tactics_unit: (row: unknown) => row,
  tactics_targets: () => ({ Ok: [] }),
  tactics_path: () => ({ Err: 'Unreachable' }),
  tactics_disengage: () => ({ Ok: false }),
  tactics_flank: () => false,
  tactics_forecast: () => ({}),
  tactics_recruit_odds: () => ({ Err: { UnknownUnit: { id: 0 } } }),
  tactics_ai_plan: () => [],
  tactics_recruit_targets: () => [],
  tactics_is_exhausted: () => false,
  tactics_plan: () => ({ Err: 'ZeroStrides' }),
  tactics_overlays: () => ({
    reach1: [],
    reach2: [],
    range: [],
    aoe: [],
    danger: [],
    shield: [],
    intents: [],
  }),
  tactics_tuning: () => ({ surge_start_round: 9, wild_round_cap: 30, autopass_forfeit: 4 }),
  tactics_next_initiative: () => [],
  tactics_deploy_slots: () => 3,
}));

vi.mock('../net/connection', () => connectionRecordingMock(H));

vi.mock('../observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('../observability/telemetry')>()),
);

vi.mock('../render/world', () => worldRendererMock());

type InputState = typeof import('./inputState');

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

let opts: ConnectionOptions;
/** The clock of the next key event: every press moves it on by 100 ms. */
let pressAt = 2000;

function teardown(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  raf.cb = null;
  localStorage.clear();
  document.documentElement.style.removeProperty('--mr-text-step');
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
  vi.resetModules();
}

/** Boot a fresh main.ts on the real shell (with `stored` in `mr.controls` first, when given),
 *  report ready, deliver the own character, and answer the `./inputState` module main.ts drives. */
async function boot(stored?: string): Promise<InputState> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  pressAt = 2000;
  clock.t = 1000;
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(CONTROLS_STORAGE_KEY, stored);
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  stubRaf();
  vi.resetModules();
  await import('../main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
  opts.onReady(H.identity);
  server(1000);
  // Same registry, no reset: this is the module instance main.ts imported.
  return import('./inputState');
}

const EID = 7n;

/** One authoritative batch: the own player and character at (2, 6), every send acked. */
function server(t: number): void {
  clock.t = t;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    discriminator: 0,
    leadLevel: 0,
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
      ackedSeq: BigInt(H.sends.length),
    },
    t,
  );
  opts.store.flushBatch();
}

/** Dispatch one cancelable, bubbling key event on the running clock and return it. */
function fire(
  type: 'keydown' | 'keyup',
  code: string,
  init: KeyboardEventInit = {},
  target: EventTarget = window,
): KeyboardEvent {
  clock.t = pressAt;
  pressAt += 50;
  const event = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** A tap: keydown, then its keyup. Returns the keydown. */
function press(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const down = fire('keydown', code, init);
  fire('keyup', code, init);
  return down;
}

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return el;
};

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
  game().stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id ?? '') : f.kind));
const navActive = (): string | null => game().navActive;

/** Start opens the main menu; the D-pad walks its cursor onto `entry`. */
function openMenuOn(entry: string): void {
  press('Escape');
  expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
  for (let i = 0; i < 8 && navActive() !== entry; i += 1) press('ArrowDown');
  expect(navActive(), `precondition: the menu cursor is on ${entry}`).toBe(entry);
}

const CONTROLS_STACK: readonly string[] = ['world', 'menuView', 'controlsView'];
/** The Buttons tab's cell keys in display order: each button's Primary then Alt, then Reset all. */
const BUTTON_CELLS: readonly string[] = [...VBUTTONS.flatMap((b) => [`${b}_0`, `${b}_1`]), 'reset'];

const controlsActive = (): string | null =>
  document.querySelector('#controls-rows [aria-selected="true"]')?.getAttribute('data-nav-key') ??
  null;

const capturing = (): boolean => {
  const el = document.getElementById('controls-capture');
  if (el === null) return false;
  for (let n: Element | null = el; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none' || n.hidden) return false;
  }
  return true;
};

/** Open Controls from the menu and start the capture on the Confirm (A) Primary slot. */
function startCaptureOnA0(): void {
  openMenuOn('controls');
  press('Enter');
  expect(stackNames(), 'precondition: Controls opened above the menu').toEqual([...CONTROLS_STACK]);
  const place = (k: string | null): { row: number; col: number } => {
    const i = k === null ? -1 : BUTTON_CELLS.indexOf(k);
    if (i < 0) throw new Error(`Controls cursor: ${String(k)} is not a Buttons cell`);
    return { row: Math.floor(i / 2), col: i % 2 };
  };
  const from = place(controlsActive());
  const to = place('A_0');
  if (controlsActive() === 'reset') {
    for (let r = from.row; r > to.row; r -= 1) press('ArrowUp');
    for (let c = from.col; c < to.col; c += 1) press('ArrowRight');
  } else {
    for (let c = from.col; c < to.col; c += 1) press('ArrowRight');
    for (let c = from.col; c > to.col; c -= 1) press('ArrowLeft');
    for (let r = from.row; r < to.row; r += 1) press('ArrowDown');
    for (let r = from.row; r > to.row; r -= 1) press('ArrowUp');
  }
  expect(controlsActive(), 'precondition: the Controls cursor is on A_0').toBe('A_0');
  press('Enter');
  expect(capturing(), 'precondition: A on A_0 started a capture').toBe(true);
}

/** The default table with some entries changed, as the stored JSON string. */
type Raw = { buttons: Record<string, string[]>; accels: Record<string, string[]> };
const storedTable = (change: (raw: Raw) => void): string => {
  const raw: Raw = JSON.parse(
    JSON.stringify({ buttons: DEFAULT_BINDINGS.buttons, accels: DEFAULT_BINDINGS.accels }),
  );
  change(raw);
  return JSON.stringify({ v: 1, ...raw });
};

/** The JSON a save of `b` writes, parsed. */
const savedShape = (b: Bindings): unknown =>
  JSON.parse(JSON.stringify({ v: 1, buttons: b.buttons, accels: b.accels }));

const savedRaw = (): string | null => localStorage.getItem(CONTROLS_STORAGE_KEY);

/** Make `document.visibilityState` answer `state` until teardown. */
function setVisibility(state: DocumentVisibilityState): void {
  const own = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  restorers.push(() => {
    if (own !== undefined) Object.defineProperty(document, 'visibilityState', own);
    else delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  });
  expect(document.visibilityState, `precondition: the page reads ${state}`).toBe(state);
}

const RIGHT_DOWN = { button: 'Right', down: true } as const;
const RIGHT_UP = { button: 'Right', down: false } as const;

// --- the booted shell --------------------------------------------------------------------------
describe('the booted shell drives the input devices of shell/inputState', {
  sequential: true,
}, () => {
  afterEach(teardown);

  it('a D-pad key at the world goes through the module`s keyboard source and router into its held directions, and its keyup lets go', async () => {
    const ns = await boot();
    const keydown = vi.spyOn(ns.keyboard, 'keydown');
    const keyup = vi.spyOn(ns.keyboard, 'keyup');
    const route = vi.spyOn(ns.inputRouter, 'route');
    expect(ns.held.isHeld('East'), 'precondition: nothing is held').toBe(false);

    fire('keydown', 'KeyD');
    expect(
      keydown.mock.results.map((r) => r.value),
      'the module`s keyboard source mapped the key',
    ).toEqual([[RIGHT_DOWN]]);
    expect(route, 'the module`s router routed the press').toHaveBeenCalledWith(
      RIGHT_DOWN,
      expect.anything(),
    );
    expect(ns.held.isHeld('East'), 'the module`s held directions hold East').toBe(true);
    expect(H.sends, 'and the press walked').toHaveLength(1);

    fire('keyup', 'KeyD');
    expect(
      keyup.mock.results.map((r) => r.value),
      'the module`s keyboard source released the key',
    ).toEqual([[RIGHT_UP]]);
    expect(route, 'the module`s router routed the release').toHaveBeenCalledWith(
      RIGHT_UP,
      expect.anything(),
    );
    expect(ns.held.isHeld('East'), 'the keyup let East go').toBe(false);
  }, 60_000);

  it('a press the open main menu consumed is held by its code in navHeldCodes until that code`s keyup, whatever key the keyup reports', async () => {
    const ns = await boot();
    press('Escape');
    expect(stackNames(), 'precondition: the menu is open').toEqual(['world', 'menuView']);
    expect(ns.navHeldCodes.size, 'precondition: the menu`s opening keyup let go').toBe(0);

    const down = fire('keydown', 'ArrowDown');
    expect(down.defaultPrevented, 'precondition: the menu consumed it').toBe(true);
    expect(ns.navHeldCodes.has('ArrowDown'), 'the consumed code is held').toBe(true);
    const up = fire('keydown', 'KeyW');
    expect(up.defaultPrevented, 'precondition: the menu consumed the second key').toBe(true);
    expect([...ns.navHeldCodes].sort(), 'both codes are held').toEqual(['ArrowDown', 'KeyW']);

    fire('keyup', 'ArrowDown', { key: 'x' });
    expect(ns.navHeldCodes.has('ArrowDown'), 'its keyup let that code go').toBe(false);
    expect([...ns.navHeldCodes], 'and only that code').toEqual(['KeyW']);
    fire('keyup', 'KeyW', { key: 'ArrowDown' });
    expect(ns.navHeldCodes.size, 'the second keyup let the last code go').toBe(0);
  }, 60_000);

  it('a press the world consumed is held by its code in navHeldCodes', async () => {
    const ns = await boot();
    expect(stackNames(), 'precondition: the bare world').toEqual(['world']);
    expect(ns.navHeldCodes.has('KeyD'), 'precondition: not held').toBe(false);
    const down = fire('keydown', 'KeyD');
    expect(down.defaultPrevented, 'precondition: the world consumed it').toBe(true);
    expect(ns.navHeldCodes.has('KeyD'), 'the consumed code is held').toBe(true);
    fire('keyup', 'KeyD', { key: 'q' });
    expect(ns.navHeldCodes.has('KeyD'), 'its keyup let it go').toBe(false);
  }, 60_000);

  it('Enter committing in a focused text field is held by its code in navHeldCodes', async () => {
    const ns = await boot();
    openMenuOn('help');
    const field = document.createElement('input');
    field.type = 'text';
    byId('menu-overlay').appendChild(field);
    field.focus();
    expect(document.activeElement, 'precondition: the field has focus').toBe(field);
    expect(ns.navHeldCodes.has('Enter'), 'precondition: Enter is not held').toBe(false);

    const enter = fire('keydown', 'Enter', { key: 'Enter' }, field);
    expect(enter.defaultPrevented, 'precondition: Enter committed').toBe(true);
    expect(stackNames(), 'precondition: the commit picked Help').toEqual([
      'world',
      'menuView',
      'helpView',
    ]);
    expect(ns.navHeldCodes.has('Enter'), 'the committing code is held').toBe(true);
    fire('keyup', 'Enter', { key: 'q' }, field);
    expect(ns.navHeldCodes.has('Enter'), 'its keyup let it go').toBe(false);
  }, 60_000);

  it('Enter committing in a focused text field while no button is bound to Enter is still let go by its keyup', async () => {
    const ns = await boot(storedTable((raw) => (raw.buttons.A = ['KeyK'])));
    expect(ns.keyboard.buttonFor('Enter'), 'precondition: no button is bound to Enter').toBe(
      undefined,
    );
    expect(ns.keyboard.buttonFor('NumpadEnter'), 'precondition: nor to its alias').toBe(undefined);
    openMenuOn('help');
    const field = document.createElement('input');
    field.type = 'text';
    byId('menu-overlay').appendChild(field);
    field.focus();
    expect(document.activeElement, 'precondition: the field has focus').toBe(field);
    expect(ns.navHeldCodes.has('Enter'), 'precondition: Enter is not held').toBe(false);

    const enter = fire('keydown', 'Enter', { key: 'Enter' }, field);
    expect(enter.defaultPrevented, 'precondition: Enter committed as A').toBe(true);
    expect(stackNames(), 'precondition: the commit picked Help').toEqual([
      'world',
      'menuView',
      'helpView',
    ]);
    expect(ns.navHeldCodes.has('Enter'), 'the unbound committing code is held').toBe(true);
    fire('keyup', 'Enter', { key: 'q' }, field);
    expect(ns.navHeldCodes.has('Enter'), 'its keyup let the unbound code go').toBe(false);
    expect(ns.navHeldCodes.size, 'nothing is left held').toBe(0);
  }, 60_000);

  it('a keyup whose routing throws still lets its held code go', async () => {
    const ns = await boot();
    const down = fire('keydown', 'KeyD');
    expect(down.defaultPrevented, 'precondition: the world consumed it').toBe(true);
    expect(ns.navHeldCodes.has('KeyD'), 'precondition: the consumed code is held').toBe(true);
    const keyup = vi.spyOn(ns.keyboard, 'keyup').mockImplementation(() => {
      throw new Error('keyup routing failed');
    });

    // happy-dom may rethrow a listener's exception or report it to window `error`: either way the
    // test only reads what the listener did before the throw.
    // The error may also reach main.ts's window `error` path; that path is not under test here.
    try {
      fire('keyup', 'KeyD', { key: 'q' });
    } catch {
      // the routing failure itself is not under test
    }
    expect(keyup, 'precondition: the keyup routing really threw on this path').toHaveBeenCalled();
    expect(keyup.mock.results[0]?.type, 'precondition: and it threw').toBe('throw');
    expect(ns.navHeldCodes.has('KeyD'), 'the held code was let go despite the throw').toBe(false);
  }, 60_000);

  it('a key taken by the Controls capture is held by its code in navHeldCodes, added after the remap released everything held before it', async () => {
    const ns = await boot();
    startCaptureOnA0();
    ns.noteNavHeld('KeyZ');
    expect(ns.navHeldCodes.has('KeyZ'), 'precondition: a code held before the capture').toBe(true);

    const k = fire('keydown', 'KeyK', { key: 'k' });
    expect(k.defaultPrevented, 'precondition: the capture took K').toBe(true);
    expect(capturing(), 'precondition: K bound and ended the capture').toBe(false);
    expect(ns.navHeldCodes.has('KeyK'), 'the captured code is held').toBe(true);
    expect(ns.navHeldCodes.has('KeyZ'), 'the remap released the code held before it').toBe(false);
    expect(ns.navHeldCodes.size, 'only the captured code is held').toBe(1);
    fire('keyup', 'KeyK', { key: 'x' });
    expect(ns.navHeldCodes.size, 'its keyup let it go').toBe(0);
  }, 60_000);

  it('window blur releases the held direction, every held code, the keyboard source and the router, once each', async () => {
    const ns = await boot();
    fire('keydown', 'KeyD');
    expect(ns.held.isHeld('East'), 'precondition: East is held').toBe(true);
    expect(ns.navHeldCodes.has('KeyD'), 'precondition: the consumed code is held').toBe(true);
    const keyboardRelease = vi.spyOn(ns.keyboard, 'releaseAll');
    const routerRelease = vi.spyOn(ns.inputRouter, 'releaseAll');

    window.dispatchEvent(new Event('blur'));
    expect(ns.held.isHeld('East'), 'East is let go').toBe(false);
    expect(ns.held.active(), 'nothing is held').toBeUndefined();
    expect(ns.navHeldCodes.size, 'no code is held').toBe(0);
    expect(keyboardRelease, 'the keyboard source was released once').toHaveBeenCalledTimes(1);
    expect(routerRelease, 'the router was released once').toHaveBeenCalledTimes(1);
    // State, not just the call: the keyboard source forgot KeyD (a fresh press is a lone press, not
    // a lost-keyup release first) and the router holds no direction any more.
    expect(ns.keyboard.keydown({ code: 'KeyD' }), 'KeyD was forgotten').toEqual([RIGHT_DOWN]);
    expect(ns.inputRouter.releaseAll(), 'the router holds nothing').toEqual([]);
  }, 60_000);

  it('a visibilitychange to hidden releases everything held once each, and one to visible releases nothing', async () => {
    const ns = await boot();
    fire('keydown', 'KeyD');
    expect(ns.held.isHeld('East'), 'precondition: East is held').toBe(true);
    expect(ns.navHeldCodes.has('KeyD'), 'precondition: the consumed code is held').toBe(true);
    const keyboardRelease = vi.spyOn(ns.keyboard, 'releaseAll');
    const routerRelease = vi.spyOn(ns.inputRouter, 'releaseAll');

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ns.held.isHeld('East'), 'visible: East stays held').toBe(true);
    expect(ns.navHeldCodes.has('KeyD'), 'visible: the code stays held').toBe(true);
    expect(keyboardRelease, 'visible: the keyboard source is not released').not.toHaveBeenCalled();
    expect(routerRelease, 'visible: the router is not released').not.toHaveBeenCalled();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ns.held.isHeld('East'), 'hidden: East is let go').toBe(false);
    expect(ns.navHeldCodes.size, 'hidden: no code is held').toBe(0);
    expect(keyboardRelease, 'hidden: the keyboard source released once').toHaveBeenCalledTimes(1);
    expect(routerRelease, 'hidden: the router released once').toHaveBeenCalledTimes(1);
    expect(ns.keyboard.keydown({ code: 'KeyD' }), 'KeyD was forgotten').toEqual([RIGHT_DOWN]);
    expect(ns.inputRouter.releaseAll(), 'the router holds nothing').toEqual([]);
  }, 60_000);

  it('a remap through the Controls screen replaces the module`s table and keyboard source with ones that answer the new key, and saves the table to mr.controls', async () => {
    const ns = await boot();
    startCaptureOnA0();
    const oldBindings = ns.bindings;
    const oldKeyboard = ns.keyboard;
    expect(oldBindings.buttons.A, 'precondition: A is on Enter').toEqual(['Enter', 'NumpadEnter']);
    expect(oldKeyboard.buttonFor('KeyK'), 'precondition: K is unbound').toBeUndefined();
    expect(savedRaw(), 'precondition: nothing is saved').toBeNull();

    press('KeyK', { key: 'k' });
    expect(capturing(), 'precondition: K bound and ended the capture').toBe(false);
    expect(ns.bindings, 'the table was replaced').not.toBe(oldBindings);
    expect(ns.bindings.buttons.A, 'A`s Primary slot holds K').toEqual(['KeyK', 'NumpadEnter']);
    expect(ns.keyboard, 'the keyboard source was replaced').not.toBe(oldKeyboard);
    expect(ns.keyboard.buttonFor('KeyK'), 'the new source answers K as A').toBe('A');
    expect(ns.keyboard.buttonFor('Enter'), 'and Enter as nothing').toBeUndefined();
    expect(oldKeyboard.buttonFor('KeyK'), 'the old source kept the old table').toBeUndefined();
    const raw = savedRaw();
    expect(raw, 'the table was saved').not.toBeNull();
    expect(JSON.parse(raw ?? 'null'), 'exactly the module`s new table').toEqual(
      savedShape(ns.bindings),
    );
  }, 60_000);

  it('a direction held while the remap applies is let go, and the old keyboard source and the router are released once each', async () => {
    const ns = await boot();
    fire('keydown', 'KeyD'); // held at the world; its keyup never comes
    expect(ns.held.isHeld('East'), 'precondition: East is held').toBe(true);
    startCaptureOnA0();
    // Opening a frame clears the held directions on its own, so hold one again right before the
    // remap: only the remap's release can let it go.
    ns.held.press('North', clock.t);
    expect(ns.held.isHeld('North'), 'precondition: North is held at the remap').toBe(true);
    const oldKeyboard = ns.keyboard;
    const keyboardRelease = vi.spyOn(oldKeyboard, 'releaseAll');
    const routerRelease = vi.spyOn(ns.inputRouter, 'releaseAll');

    fire('keydown', 'KeyK', { key: 'k' });
    expect(capturing(), 'precondition: K bound and ended the capture').toBe(false);
    expect(ns.keyboard, 'precondition: the source was replaced').not.toBe(oldKeyboard);
    expect(ns.held.isHeld('North'), 'the remap let North go').toBe(false);
    expect(ns.held.active(), 'nothing is held').toBeUndefined();
    expect(keyboardRelease, 'the OLD keyboard source was released once').toHaveBeenCalledTimes(1);
    expect(routerRelease, 'the router was released once').toHaveBeenCalledTimes(1);
    expect(ns.inputRouter.releaseAll(), 'the router no longer holds Right').toEqual([]);
  }, 60_000);

  it('a table saved in mr.controls before the boot is the module`s table, and a later write to the storage changes nothing', async () => {
    const ns = await boot(storedTable((raw) => (raw.buttons.A = ['KeyK'])));
    expect(ns.bindings.buttons.A, 'the saved A row was read').toEqual(['KeyK']);
    expect(ns.keyboard.buttonFor('KeyK'), 'the keyboard source follows it').toBe('A');
    expect(ns.keyboard.buttonFor('Enter'), 'Enter is not A').toBeUndefined();
    const read = ns.bindings;
    const source = ns.keyboard;

    localStorage.setItem(
      CONTROLS_STORAGE_KEY,
      storedTable((raw) => (raw.buttons.A = ['KeyG'])),
    );
    press('KeyD'); // a real key routed after the write
    expect(H.sends, 'precondition: the key walked').toHaveLength(1);
    expect(ns.bindings, 'the table is the one read at boot').toBe(read);
    expect(ns.bindings.buttons.A, 'A is still on K').toEqual(['KeyK']);
    expect(ns.keyboard, 'the keyboard source is the boot one').toBe(source);
    expect(ns.keyboard.buttonFor('KeyG'), 'G is not A').toBeUndefined();
  }, 60_000);
});

// --- the module on its own (no boot) --------------------------------------------------------
describe('shell/inputState functions', { sequential: true }, () => {
  afterEach(() => {
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  async function fresh(stored?: string): Promise<InputState> {
    localStorage.clear();
    if (stored !== undefined) localStorage.setItem(CONTROLS_STORAGE_KEY, stored);
    vi.resetModules();
    return import('./inputState');
  }

  /** Hold East in every device the module owns, and one code in navHeldCodes. */
  function holdEverything(ns: InputState): void {
    expect(ns.keyboard.keydown({ code: 'KeyD' }), 'precondition: KeyD pressed').toEqual([
      RIGHT_DOWN,
    ]);
    expect(
      ns.inputRouter.route(RIGHT_DOWN, { worldActive: true }),
      'precondition: the router holds Right',
    ).toEqual({ consumed: true, effects: [{ kind: 'dirDown', dir: 'East' }] });
    ns.held.press('East', 0);
    ns.noteNavHeld('KeyD');
    expect(ns.held.isHeld('East'), 'precondition: East is held').toBe(true);
    expect(ns.navHeldCodes.has('KeyD'), 'precondition: KeyD is held').toBe(true);
  }

  /** Assert every device the module owns holds nothing (the router check releases it). */
  function expectNothingHeld(ns: InputState, label: string): void {
    expect(ns.held.isHeld('East'), `${label}: East is let go`).toBe(false);
    expect(ns.held.active(), `${label}: nothing is held`).toBeUndefined();
    expect(ns.navHeldCodes.size, `${label}: no code is held`).toBe(0);
    expect(ns.keyboard.keydown({ code: 'KeyD' }), `${label}: KeyD was forgotten`).toEqual([
      RIGHT_DOWN,
    ]);
    expect(ns.inputRouter.releaseAll(), `${label}: the router holds nothing`).toEqual([]);
  }

  it('importing the module registers no window or document listener and writes nothing to storage or the document', async () => {
    // Storage is observed by state only: happy-dom's localStorage does not reliably route
    // setItem through Storage.prototype (see main.remap.test.ts), so a prototype spy could miss
    // a write.
    const scenarios: ReadonlyArray<readonly [string, string | undefined]> = [
      ['nothing saved', undefined],
      ['a table saved', storedTable((raw) => (raw.buttons.A = ['KeyK']))],
    ];
    let visited = 0;
    for (const [label, stored] of scenarios) {
      localStorage.clear();
      if (stored !== undefined) localStorage.setItem(CONTROLS_STORAGE_KEY, stored);
      const lengthBefore = localStorage.length;
      expect(lengthBefore, `${label}: precondition: the storage holds what was saved`).toBe(
        stored === undefined ? 0 : 1,
      );
      // Document writes are watched as writes, not as state: an earlier import in this file may
      // already have made an idempotent write, which a before/after count cannot see. Records the
      // observer delivers during the awaited import land in `mutations` through its callback.
      const mutations: MutationRecord[] = [];
      const observer = new MutationObserver((records) => {
        mutations.push(...records);
      });
      observer.observe(document, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });

      // An observer of this test's own, undone by ASSIGNING the previous function back: on the
      // global `window`, addEventListener is an own accessor, so redefining the old descriptor
      // would leave a wrapper in place (and wrappers left by earlier boots stack under it).
      const seen: Recorded[] = [];
      type Adder = { addEventListener: EventTarget['addEventListener'] };
      const undo: Array<() => void> = [];
      const targets: readonly EventTarget[] = [window, document];
      for (const target of targets) {
        const hadOwn = Object.getOwnPropertyDescriptor(target, 'addEventListener') !== undefined;
        const previous = target.addEventListener;
        (target as Adder).addEventListener = (
          type: string,
          handler: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ): void => {
          seen.push({ target, type, handler, options });
          previous.call(target, type, handler, options);
        };
        undo.push(() => {
          if (hadOwn) (target as Adder).addEventListener = previous;
          else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
        });
      }
      try {
        // The observer works: one probe listener of the test's own is seen once on each target.
        const probe = (): void => undefined;
        window.addEventListener('mr-probe', probe);
        document.addEventListener('mr-probe', probe);
        expect(
          seen.map((r) => [r.target === window, r.target === document, r.type]),
          `${label}: precondition: the observer sees each target's probe exactly once`,
        ).toEqual([
          [true, false, 'mr-probe'],
          [false, true, 'mr-probe'],
        ]);
        window.removeEventListener('mr-probe', probe);
        document.removeEventListener('mr-probe', probe);
        seen.length = 0;

        // The observer works: a probe write of the test's own is reported.
        document.documentElement.setAttribute('data-mr-probe', '1');
        document.documentElement.removeAttribute('data-mr-probe');
        mutations.push(...observer.takeRecords());
        expect(
          mutations.map((m) => `${m.type}:${m.attributeName ?? ''}`),
          `${label}: precondition: the observer reports the probe's set and remove`,
        ).toEqual(['attributes:data-mr-probe', 'attributes:data-mr-probe']);
        mutations.length = 0;

        vi.resetModules();
        const ns = await import('./inputState');
        expect(ns.navHeldCodes.size, `${label}: precondition: the module loaded`).toBe(0);

        expect(
          seen.map((r) => [r.target === window, r.type]),
          `${label}: the import registered no listener on window or document`,
        ).toEqual([]);
        expect(localStorage.length, `${label}: the import added no storage key`).toBe(lengthBefore);
        expect(
          localStorage.getItem(CONTROLS_STORAGE_KEY),
          `${label}: the saved table is byte-identical`,
        ).toBe(stored ?? null);
        mutations.push(...observer.takeRecords());
        expect(
          mutations.map((m) => `${m.type}:${m.attributeName ?? ''}`),
          `${label}: the import wrote nothing to the document`,
        ).toEqual([]);
      } finally {
        observer.disconnect();
        for (const r of seen) r.target.removeEventListener(r.type, r.handler, r.options);
        while (undo.length > 0) undo.pop()?.();
      }
      visited += 1;
    }
    expect(visited, 'both storage states were checked').toBe(2);
  });

  it('noteNavHeld adds exactly its code and releaseNavHeld deletes exactly its code', async () => {
    const ns = await fresh();
    expect(ns.navHeldCodes.size, 'the set starts empty').toBe(0);
    ns.noteNavHeld('KeyA');
    ns.noteNavHeld('KeyB');
    expect([...ns.navHeldCodes].sort(), 'both codes are held').toEqual(['KeyA', 'KeyB']);
    ns.noteNavHeld('KeyA');
    expect(ns.navHeldCodes.size, 'a code is held once').toBe(2);
    ns.releaseNavHeld('KeyA');
    expect([...ns.navHeldCodes], 'only KeyA was deleted').toEqual(['KeyB']);
    ns.releaseNavHeld('KeyC');
    expect([...ns.navHeldCodes], 'an unheld code deletes nothing').toEqual(['KeyB']);
    ns.releaseNavHeld('KeyB');
    expect(ns.navHeldCodes.size, 'the last code was deleted').toBe(0);
  });

  it('releaseAllInput empties the held codes and directions and releases the keyboard source and the router, once each', async () => {
    const ns = await fresh();
    holdEverything(ns);
    const keyboardRelease = vi.spyOn(ns.keyboard, 'releaseAll');
    const routerRelease = vi.spyOn(ns.inputRouter, 'releaseAll');
    ns.releaseAllInput();
    expect(keyboardRelease, 'the keyboard source was released once').toHaveBeenCalledTimes(1);
    expect(routerRelease, 'the router was released once').toHaveBeenCalledTimes(1);
    expectNothingHeld(ns, 'after releaseAllInput');
  });

  it('the module reads the table saved in mr.controls when it is imported, and only then', async () => {
    const ns = await fresh(storedTable((raw) => (raw.buttons.A = ['KeyK'])));
    expect(ns.bindings.buttons.A, 'the saved A row was read at import').toEqual(['KeyK']);
    expect(ns.keyboard.buttonFor('KeyK'), 'the keyboard source follows it').toBe('A');
    const read = ns.bindings;
    localStorage.setItem(
      CONTROLS_STORAGE_KEY,
      storedTable((raw) => (raw.buttons.A = ['KeyG'])),
    );
    ns.releaseAllInput();
    expect(ns.bindings, 'a later write is not read').toBe(read);
    expect(ns.keyboard.buttonFor('KeyG'), 'G is not A').toBeUndefined();

    const plain = await fresh();
    expect(plain.bindings, 'with nothing saved: the defaults').toEqual(DEFAULT_BINDINGS);
    expect(plain.keyboard.buttonFor('Enter'), 'Enter is A').toBe('A');
  });

  it('applyBindings saves the table, releases everything on the OLD keyboard source, then swaps in the table and a new source, and answers true', async () => {
    const ns = await fresh();
    const { KeyboardSource } = await import('../input/keyboardSource');
    const oldKeyboard = ns.keyboard;
    expect(oldKeyboard, 'precondition: the same registry`s class').toBeInstanceOf(KeyboardSource);
    holdEverything(ns);
    const releases = vi.spyOn(KeyboardSource.prototype, 'releaseAll');
    const routerRelease = vi.spyOn(ns.inputRouter, 'releaseAll');
    const next = JSON.parse(storedTable((raw) => (raw.buttons.A = ['KeyK']))) as Bindings;

    expect(ns.applyBindings(next), 'the save succeeded').toBe(true);
    expect(releases, 'one keyboard source was released').toHaveBeenCalledTimes(1);
    expect(releases.mock.contexts[0], 'and it was the OLD one').toBe(oldKeyboard);
    expect(routerRelease, 'the router was released once').toHaveBeenCalledTimes(1);
    expect(ns.bindings, 'the table is the one applied').toBe(next);
    expect(ns.keyboard, 'the keyboard source was replaced').not.toBe(oldKeyboard);
    expect(ns.keyboard, 'by a KeyboardSource').toBeInstanceOf(KeyboardSource);
    expect(ns.keyboard.buttonFor('KeyK'), 'that answers K as A').toBe('A');
    expect(ns.keyboard.buttonFor('Enter'), 'and Enter as nothing').toBeUndefined();
    const raw = savedRaw();
    expect(raw, 'the table was saved').not.toBeNull();
    expect(JSON.parse(raw ?? 'null'), 'exactly the applied table').toEqual(savedShape(next));
    expectNothingHeld(ns, 'after applyBindings');
  });

  it('applyBindings answers false when the storage refuses the save, and still applies the table and a new keyboard source', async () => {
    const ns = await fresh();
    const real = window.localStorage;
    let refused = 0;
    const wrapper: Storage = {
      get length(): number {
        return real.length;
      },
      key: (i: number): string | null => real.key(i),
      getItem: (key: string): string | null => real.getItem(key),
      setItem: (key: string, value: string): void => {
        if (key === CONTROLS_STORAGE_KEY) {
          refused += 1;
          throw new Error('QuotaExceededError: storage is full');
        }
        real.setItem(key, value);
      },
      removeItem: (key: string): void => real.removeItem(key),
      clear: (): void => real.clear(),
    };
    const ownStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => wrapper });
    restorers.push(() => {
      if (ownStorage !== undefined) Object.defineProperty(window, 'localStorage', ownStorage);
      else delete (window as unknown as { localStorage?: unknown }).localStorage;
    });
    expect(window.localStorage, 'precondition: window.localStorage is the wrapper').toBe(wrapper);
    holdEverything(ns);
    const oldKeyboard = ns.keyboard;
    const next = JSON.parse(storedTable((raw) => (raw.buttons.A = ['KeyK']))) as Bindings;

    expect(ns.applyBindings(next), 'the refused save answers false').toBe(false);
    expect(refused, 'the save was attempted once').toBe(1);
    expect(real.getItem(CONTROLS_STORAGE_KEY), 'nothing reached storage').toBeNull();
    expect(ns.bindings, 'the table still applied').toBe(next);
    expect(ns.keyboard, 'the keyboard source was still replaced').not.toBe(oldKeyboard);
    expect(ns.keyboard.buttonFor('KeyK'), 'and answers K as A').toBe('A');
    expectNothingHeld(ns, 'after a refused save');
  });
});

// --- the pad source the module builds (no boot) -----------------------------------------------
// The module's `pad` reads `navigator.getGamepads` at each poll. happy-dom ships no Gamepad API, so
// each case installs its own as an own property of `navigator` (removed after the case): one fake
// standard-mapping pad whose buttons and axes the case mutates in place between polls, as a browser
// may hand back one snapshot object. A fresh import per case gives a fresh `pad`, so the source's
// once-per-lifetime fault report starts unspent in every case.

interface FakePad {
  index: number;
  id: string;
  connected: boolean;
  mapping: string;
  buttons: Array<{ pressed: boolean }>;
  axes: number[];
}
const makeFakePad = (): FakePad => ({
  index: 0,
  id: 'fake standard pad',
  connected: true,
  mapping: 'standard',
  buttons: Array.from({ length: 17 }, () => ({ pressed: false })),
  axes: [0, 0, 0, 0],
});

const NO_POLL = { edges: [], accels: [] };

describe('shell/inputState pad source', { sequential: true }, () => {
  let fakePad: FakePad = makeFakePad();

  /** Install `get` as `navigator.getGamepads` until the case ends. */
  function installPadApi(get: () => unknown): void {
    Object.defineProperty(navigator, 'getGamepads', {
      value: get,
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    delete (navigator as unknown as { getGamepads?: unknown }).getGamepads;
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  async function freshModule(): Promise<InputState> {
    localStorage.clear();
    vi.resetModules();
    return import('./inputState');
  }

  it('importing the module calls navigator.getGamepads zero times, and the first poll reads the stub installed before the import [gp-2.6]', async () => {
    // WRONG IMPL KILLED: a pad source that reads the pads (or calls the API to probe it) at module
    // scope; the poll count after the import proves the stub is live, so the 0 is not vacuous.
    expect(
      'getGamepads' in navigator,
      'precondition: happy-dom ships no Gamepad API of its own',
    ).toBe(false);
    fakePad = makeFakePad();
    let calls = 0;
    installPadApi(() => {
      calls += 1;
      return [fakePad, null, null, null];
    });
    const ns = await freshModule();
    expect(calls, 'the import read no pad').toBe(0);
    const pad = ns.pad;
    expect(calls, 'reading the export reads no pad either').toBe(0);
    expect(pad.poll(), 'nothing is pressed').toEqual(NO_POLL);
    expect(calls, 'one poll, one read of the stub').toBe(1);
    fakePad.buttons[12].pressed = true;
    expect(pad.poll(), 'the stub`s pad is the one read').toEqual({
      edges: [{ button: 'Up', down: true }],
      accels: [],
    });
    expect(calls).toBe(2);
  });

  it('a navigator.getGamepads installed after the import, and then replaced, is the one each poll reads [gp-2.6]', async () => {
    // WRONG IMPL KILLED: `navigator.getGamepads` captured at import (`.bind` at module scope, or a
    // const holding the function): the absent API would stick, or the first stub would.
    const ns = await freshModule();
    const pad = ns.pad;
    expect(pad.poll(), 'no API: no pads').toEqual(NO_POLL);
    fakePad = makeFakePad();
    fakePad.buttons[13].pressed = true;
    installPadApi(() => [fakePad, null, null, null]);
    expect(pad.poll(), 'the late stub is read').toEqual({
      edges: [{ button: 'Down', down: true }],
      accels: [],
    });
    const second = makeFakePad();
    second.buttons[13].pressed = true;
    second.buttons[15].pressed = true;
    installPadApi(() => [second, null, null, null]);
    expect(pad.poll(), 'the replacement is read (same id: Down still held, Right new)').toEqual({
      edges: [{ button: 'Right', down: true }],
      accels: [],
    });
  });

  it('with navigator.getGamepads absent, or answering no pads, a poll returns no edges and no accelerators and reports no fault [gp-2.6]', async () => {
    // WRONG IMPL KILLED: `navigator.getGamepads()` called without the optional call (a missing API
    // throws a TypeError every poll and is reported as a fault), and a source that reads a null
    // slot as a pad.
    const ns = await freshModule();
    const sink = vi.fn();
    ns.installPadFaultSink(sink);
    const pad = ns.pad;
    for (let i = 0; i < 3; i += 1) {
      expect(pad.poll(), `absent API, poll ${i}`).toEqual(NO_POLL);
    }
    installPadApi(() => []);
    for (let i = 0; i < 3; i += 1) expect(pad.poll(), `[], poll ${i}`).toEqual(NO_POLL);
    installPadApi(() => [null, null, null, null]);
    for (let i = 0; i < 3; i += 1) expect(pad.poll(), `four nulls, poll ${i}`).toEqual(NO_POLL);
    expect(sink, 'no fault was reported for an absent or empty API').not.toHaveBeenCalled();
  });

  it('a throwing navigator.getGamepads reaches the fault sink current at the fault exactly once over several polls, with the thrown error [gp-2.6]', async () => {
    // WRONG IMPL KILLED: a sink read once when the pad is built (the console default would take the
    // fault, not `current`), an installer that keeps the first sink it is given (`first` would), a
    // report per poll, and a fault that escapes the poll.
    const ns = await freshModule();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = vi.fn();
    const current = vi.fn();
    ns.installPadFaultSink(first);
    ns.installPadFaultSink(current);
    const boom = new Error('gp2-pad-boom');
    installPadApi(() => {
      throw boom;
    });
    const pad = ns.pad;
    for (let i = 0; i < 4; i += 1) expect(pad.poll(), `poll ${i} reads no pads`).toEqual(NO_POLL);
    expect(current, 'the sink installed last took the fault once').toHaveBeenCalledTimes(1);
    expect(current.mock.calls[0]?.[0], 'with the thrown error').toBe(boom);
    expect(first, 'the replaced sink took nothing').not.toHaveBeenCalled();
    expect(
      logged.mock.calls.filter((args) => args.includes(boom)),
      'nor did the console default',
    ).toEqual([]);
  });

  it('with no sink installed a throwing navigator.getGamepads goes to console.error once over several polls [gp-2.6]', async () => {
    // WRONG IMPL KILLED: a fault dropped when nothing is installed, and one logged per poll.
    const ns = await freshModule();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('gp2-pad-boom');
    installPadApi(() => {
      throw boom;
    });
    const pad = ns.pad;
    for (let i = 0; i < 4; i += 1) expect(pad.poll(), `poll ${i} reads no pads`).toEqual(NO_POLL);
    const carrying = logged.mock.calls.filter((args) => args.includes(boom));
    expect(carrying, 'one console.error carried the thrown error').toHaveLength(1);
  });

  it('releaseAllInput latches every held pad button and stick direction: a following poll emits nothing, their releases emit nothing, a re-press emits one down each [gp-2.3]', async () => {
    // WRONG IMPL KILLED: a releaseAllInput that leaves the pad source alone (the releases would emit
    // their owed up edges, which end another holder's walk), and a latch that also swallows the
    // re-press.
    fakePad = makeFakePad();
    installPadApi(() => [fakePad, null, null, null]);
    const ns = await freshModule();
    const pad = ns.pad;
    fakePad.buttons[12].pressed = true;
    fakePad.axes[0] = 0.9;
    expect(pad.poll(), 'precondition: D-pad Up and the stick Right go down').toEqual({
      edges: [
        { button: 'Up', down: true },
        { button: 'Right', down: true },
      ],
      accels: [],
    });

    ns.releaseAllInput();
    expect(pad.poll(), 'held through the release: nothing').toEqual(NO_POLL);
    fakePad.buttons[12].pressed = false;
    fakePad.axes[0] = 0;
    expect(pad.poll(), 'their releases emit nothing').toEqual(NO_POLL);
    fakePad.buttons[12].pressed = true;
    fakePad.axes[0] = 0.9;
    expect(pad.poll(), 'a fresh press emits one down each').toEqual({
      edges: [
        { button: 'Up', down: true },
        { button: 'Right', down: true },
      ],
      accels: [],
    });
  });

  it('releaseAllInput latches a pad button pressed after the last poll and still held at the release [gp-2.3]', async () => {
    // WRONG IMPL KILLED: a release that latches only what the last poll saw (the press made between
    // that poll and a blur would reach the next poll as a fresh down and walk).
    fakePad = makeFakePad();
    installPadApi(() => [fakePad, null, null, null]);
    const ns = await freshModule();
    const pad = ns.pad;
    expect(pad.poll(), 'precondition: nothing is pressed at the last poll').toEqual(NO_POLL);
    fakePad.buttons[13].pressed = true; // after that poll, before the release
    ns.releaseAllInput();
    expect(pad.poll(), 'the press made before the release emits nothing').toEqual(NO_POLL);
    fakePad.buttons[13].pressed = false;
    expect(pad.poll(), 'nor does its release').toEqual(NO_POLL);
    fakePad.buttons[13].pressed = true;
    expect(pad.poll(), 'a fresh press emits one down').toEqual({
      edges: [{ button: 'Down', down: true }],
      accels: [],
    });
  });
});

// --- the input source and the keycap (no boot) -----------------------------------------------
describe('shell/inputState input source', { sequential: true }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.resetModules();
  });

  async function freshModule(): Promise<InputState> {
    localStorage.clear();
    vi.resetModules();
    return import('./inputState');
  }

  it('starts on the keyboard source, so the first keycaps are keyboard keycaps [gp-4.3]', async () => {
    // WRONG IMPL KILLED: a module that starts on the pad source (a keyboard player sees pad
    // glyphs until the first key), and a keycap that ignores the source.
    const ns = await freshModule();
    expect(ns.lastSource, 'the source at import').toBe('keys');
    expect(ns.keycap('Start'), 'Start reads the Escape key').toBe('Esc');
    expect(ns.keycap('A'), 'A reads the Enter key').toBe('Enter');
  });

  it('noteInputSource sets lastSource to the source it is given, and the last note wins [gp-4.2]', async () => {
    // WRONG IMPL KILLED: a note that is ignored, one that only ever sets pad (a keyboard note never
    // switches back), and a lastSource binding that is not live for importers.
    const ns = await freshModule();
    ns.noteInputSource('pad');
    expect(ns.lastSource, 'a pad note').toBe('pad');
    ns.noteInputSource('pad');
    expect(ns.lastSource, 'a repeated pad note').toBe('pad');
    ns.noteInputSource('keys');
    expect(ns.lastSource, 'a keys note').toBe('keys');
  });

  it('keycap shows the pad glyph of the button`s default pad index once the pad was the last source, for every button [gp-4.2]', async () => {
    // WRONG IMPL KILLED: a keycap that never reads lastSource, one that reads a pad table other
    // than the one the pad source polls, and one fixed at the source current at import.
    const ns = await freshModule();
    const keycap = ns.keycap;
    expect(keycap('Start'), 'precondition: the keyboard keycap').toBe('Esc');
    ns.noteInputSource('pad');
    for (const button of VBUTTONS) {
      const index = PAD_DEFAULT_BINDINGS.buttons[button][0] as number;
      expect(keycap(button), `pad keycap of ${button}, through the earlier reference`).toBe(
        padGlyph(index),
      );
    }
    expect(keycap('Start'), 'Start reads the pad Menu').toBe('Menu');
    expect(keycap('Select'), 'Select reads the pad View').toBe('View');
    expect(keycap('A'), 'A reads the pad A').toBe('A');
  });

  it('keycap shows keyboard keycaps again as soon as the keyboard is the last source [gp-4.3]', async () => {
    // WRONG IMPL KILLED: a source that sticks on pad once set, and a keycap cached at the flip.
    const ns = await freshModule();
    ns.noteInputSource('pad');
    expect(ns.keycap('Start'), 'precondition: pad glyph').toBe('Menu');
    ns.noteInputSource('keys');
    expect(ns.keycap('Start'), 'Start is the Escape key again').toBe('Esc');
    expect(ns.keycap('Select'), 'Select is the R key again').toBe('R');
    for (const button of VBUTTONS) {
      const code = ns.bindings.buttons[button][0] as string;
      expect(ns.keycap(button), `keyboard keycap of ${button}`).toBe(glyph(code));
    }
  });

  it('keycap reads the live keyboard table: after applyBindings the keyboard keycap is the new key and the pad keycap is unchanged [gp-4.3]', async () => {
    // WRONG IMPL KILLED: a keyboard table captured at import (a remap lies on the bar), and a
    // remap that leaks into the pad keycap.
    const ns = await freshModule();
    expect(ns.keycap('A'), 'precondition: Enter').toBe('Enter');
    const next = JSON.parse(storedTable((raw) => (raw.buttons.A = ['KeyK']))) as Bindings;
    expect(ns.applyBindings(next), 'the remap saved').toBe(true);
    expect(ns.keycap('A'), 'the keyboard keycap is the remapped key').toBe(glyph('KeyK'));
    expect(ns.keycap('A'), 'and not the old default').not.toBe('Enter');
    ns.noteInputSource('pad');
    expect(ns.keycap('A'), 'the pad keycap ignores the keyboard remap').toBe('A');
  });
});

// --- the booted shell: which source the last input came from ------------------------------------
describe('the booted shell records the source of the last input', { sequential: true }, () => {
  afterEach(teardown);

  let fake = makeFakePad();
  /** Install a fresh fake standard pad answering `navigator.getGamepads` until teardown. */
  function usePad(): void {
    fake = makeFakePad();
    Object.defineProperty(navigator, 'getGamepads', {
      value: () => [fake, null, null, null],
      configurable: true,
      writable: true,
    });
    restorers.push(() => {
      delete (navigator as unknown as { getGamepads?: unknown }).getGamepads;
    });
  }
  /** One frame, 50 ms after the last clock reading. */
  const tick = (): void => frame(clock.t + 50);
  const keyDown = (code: string): void => {
    pressAt = clock.t + 50;
    fire('keydown', code);
  };
  const keyUp = (code: string): void => {
    pressAt = clock.t + 50;
    fire('keyup', code);
  };
  /** Press the pad button `i` and let the frame loop poll it. */
  const padDown = (i: number): void => {
    fake.buttons[i].pressed = true;
    tick();
  };
  const padUp = (i: number): void => {
    fake.buttons[i].pressed = false;
    tick();
  };
  const D_PAD_UP = 12;
  const LT = 6;

  it('a pad button press polled at the world makes the pad the last source [gp-4.2]', async () => {
    // WRONG IMPL KILLED: a frame loop that never notes the pad, and a lastSource that is flipped
    // at module scope rather than by the poll.
    const ns = await boot();
    usePad();
    tick();
    expect(ns.lastSource, 'precondition: no input yet, the keyboard').toBe('keys');
    padDown(D_PAD_UP);
    expect(ns.lastSource, 'a D-pad press made the pad the last source').toBe('pad');
  });

  it('a pad accelerator press with no button edge makes the pad the last source [gp-4.2]', async () => {
    // WRONG IMPL KILLED: a source flip that tests the edges only (LT is the Party accelerator and
    // raises no button edge).
    const ns = await boot();
    usePad();
    tick();
    expect(ns.lastSource, 'precondition: the keyboard').toBe('keys');
    padDown(LT);
    expect(ns.lastSource, 'an accelerator press made the pad the last source').toBe('pad');
  });

  it('a pad press after a keydown makes the pad the last source again [gp-4.2]', async () => {
    // WRONG IMPL KILLED: a one-way flip (pad to keys only), and a flip guarded by "never had pad
    // input".
    const ns = await boot();
    usePad();
    tick();
    keyDown('KeyD');
    keyUp('KeyD');
    expect(ns.lastSource, 'precondition: a key press made it keys').toBe('keys');
    padDown(D_PAD_UP);
    expect(ns.lastSource, 'the pad press took it back').toBe('pad');
  });

  it('a keydown after pad input makes the keyboard the last source at once [gp-4.3]', async () => {
    // WRONG IMPL KILLED: a keydown path that does not note the source (the bar keeps pad glyphs
    // while the player types), and a note made on keyup instead of keydown.
    const ns = await boot();
    usePad();
    tick();
    padDown(D_PAD_UP);
    expect(ns.lastSource, 'precondition: the pad press').toBe('pad');
    keyDown('KeyD');
    expect(ns.lastSource, 'the keydown, before any keyup or frame').toBe('keys');
  });

  it('a pad release edge after a keydown leaves the keyboard the last source [gp-4.3]', async () => {
    // WRONG IMPL KILLED: a flip on any pad edge (a button let go after a key press would turn the
    // bar back to pad glyphs with no new pad input).
    const ns = await boot();
    usePad();
    tick();
    padDown(D_PAD_UP);
    keyDown('KeyD');
    expect(ns.lastSource, 'precondition: keys').toBe('keys');
    padUp(D_PAD_UP);
    tick();
    expect(ns.lastSource, 'the release edge changed nothing').toBe('keys');
  });

  it('a pad press ignored because focus is outside the game screen still makes the pad the last source [gp-4.2]', async () => {
    // WRONG IMPL KILLED: the source note placed below the focus guard (an ignored press would
    // leave the keyboard keycaps up while the player is on the pad).
    const ns = await boot();
    usePad();
    tick();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement, 'precondition: focus is outside #game-screen').toBe(outside);
    expect(byId('game-screen').contains(outside), 'precondition: outside the screen').toBe(false);
    expect(ns.lastSource, 'precondition: the keyboard').toBe('keys');
    padDown(D_PAD_UP);
    expect(ns.lastSource, 'the ignored press still made the pad the last source').toBe('pad');
  });

  it('a frame with no pad input and no key leaves the last source unchanged, whichever it is [gp-4.2]', async () => {
    // WRONG IMPL KILLED: a frame loop that notes a source on every poll (pad on each idle frame).
    const ns = await boot();
    usePad();
    tick();
    tick();
    expect(ns.lastSource, 'idle frames at the start').toBe('keys');
    padDown(D_PAD_UP);
    padUp(D_PAD_UP);
    tick();
    tick();
    expect(ns.lastSource, 'idle frames after a pad press and its release').toBe('pad');
  });

  it('a click on the world canvas and a click on a hint chip leave the pad as the last source [gp-4.2]', async () => {
    // WRONG IMPL KILLED: a pointer press that notes the keyboard (or the pad) source.
    const ns = await boot();
    usePad();
    tick();
    padDown(D_PAD_UP);
    padUp(D_PAD_UP);
    expect(ns.lastSource, 'precondition: pad').toBe('pad');
    const canvas = await vi.waitFor(
      () => {
        const c = document.querySelector('#game-screen canvas');
        if (c === null) throw new Error('the world canvas is not mounted yet');
        return c;
      },
      { timeout: 5_000, interval: 5 },
    );
    clock.t += 50;
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(ns.lastSource, 'a canvas click').toBe('pad');
    const chip = document.querySelector('#hint-bar [data-button="Select"]');
    if (chip === null) throw new Error('the Select chip is not on the bar');
    clock.t += 50;
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(ns.lastSource, 'a hint chip click').toBe('pad');
  });

  it('a click on the world canvas and a click on a hint chip leave the keyboard as the last source [gp-4.3]', async () => {
    // WRONG IMPL KILLED: a pointer press that notes the pad source.
    const ns = await boot();
    usePad();
    tick();
    padDown(D_PAD_UP);
    keyDown('KeyD');
    keyUp('KeyD');
    padUp(D_PAD_UP);
    expect(ns.lastSource, 'precondition: keys').toBe('keys');
    const canvas = await vi.waitFor(
      () => {
        const c = document.querySelector('#game-screen canvas');
        if (c === null) throw new Error('the world canvas is not mounted yet');
        return c;
      },
      { timeout: 5_000, interval: 5 },
    );
    clock.t += 50;
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(ns.lastSource, 'a canvas click').toBe('keys');
    const chip = document.querySelector('#hint-bar [data-button="Select"]');
    if (chip === null) throw new Error('the Select chip is not on the bar');
    clock.t += 50;
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(ns.lastSource, 'a hint chip click').toBe('keys');
  });
});
