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
  opts.store.upsertPlayer({ identity: H.identity, entityId: EID, name: 'P', online: true });
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
