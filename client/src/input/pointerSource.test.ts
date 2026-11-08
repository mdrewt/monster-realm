// @vitest-environment happy-dom
// input/pointerSource.test.ts — ctl-15 RED gating tests: the pointer source, ONE dispatcher on
// #game-screen (CTL15.1 to CTL15.5).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-15;
//   memory/projects/monster-realm-ctl-15-plan.md (REVISION 1 supersedes the earlier sections).
//
// RED REASON: client/src/input/pointerSource.ts does not exist yet (module-not-found).
//
// CONTRACT (imported exactly as the plan names it):
//   navPath(count, cols | null, from, to): VButton[]   tabPath(from, to): VButton[]
//   new PointerSource(gameScreen, () => canvas, deps, clock); keyPressed()
//   deps = { top(), press(button), capturing(), cancelCapture(), choice(idx), shop(shopId) }
// The pointer emits virtual-button presses ONLY (never coordinates), plus the two dialogue
// commands the old document delegate owned.
//
// THE FAKE ADAPTER. `press` records every button AND simulates the screen adapter the router would
// reach: the fixture's ONE driven container (a list, a grid or a tab strip) moves its `is-active` /
// `aria-selected` mark through the REAL nav core (`ui/nav.ts` navStep, fresh edges wrap). Every
// other container stays still, exactly like a stale base list under a sheet. The recorded press
// sequence is the oracle: a seek is the exact D-pad path, a miss is probe + undo, and A comes only
// once the target is proven driven.
import * as fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grid, list, type NavItem, type NavState, navStep, tabs } from '../ui/nav';
import { VBUTTONS, type VButton } from './buttons';
// uif-5: `wheelSteps` is reached through the namespace and resolved at CALL time, so a missing
// export reds only the tests that call it, not the whole file's import.
import * as ps from './pointerSource';
import {
  navPath,
  type PointerClock,
  type PointerDeps,
  PointerSource,
  type PointerTop,
  tabPath,
} from './pointerSource';

type WheelStepsFn = (
  acc: number,
  deltaY: number,
  deltaMode: number,
) => { steps: number; acc: number };
const wheelSteps: WheelStepsFn = (acc, deltaY, deltaMode) =>
  (ps as unknown as { wheelSteps: WheelStepsFn }).wheelSteps(acc, deltaY, deltaMode);

// ---------------------------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------------------------

/** A deterministic clock: timers fire only from `advance`, with `now()` set to their due time. */
class FakeClock implements PointerClock {
  t = 50_000;
  /** How far `now()` reads behind the timer clock (timer jitter: a timer that fires early). */
  lag = 0;
  #seq = 0;
  readonly timers = new Map<number, { readonly at: number; readonly fn: () => void }>();
  now = (): number => this.t - this.lag;
  setTimeout = (fn: () => void, ms: number): number => {
    this.#seq += 1;
    this.timers.set(this.#seq, { at: this.t + ms, fn });
    return this.#seq;
  };
  clearTimeout = (h: number): void => {
    this.timers.delete(h);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let due: [number, { readonly at: number; readonly fn: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at <= end && (due === null || entry[1].at < due[1].at)) due = entry;
      }
      if (due === null) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
    }
    this.t = end;
  }
}

type Drive =
  | { readonly kind: 'items'; readonly container: HTMLElement; readonly cols: number | null }
  | { readonly kind: 'tabs'; readonly strip: HTMLElement };

interface Fx {
  readonly gameScreen: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly app: HTMLElement;
  readonly layer: HTMLElement;
  readonly hintBar: HTMLElement;
  readonly outside: HTMLElement;
  readonly clock: FakeClock;
  /** Every pressed button, in order. */
  readonly presses: VButton[];
  readonly press: ReturnType<typeof vi.fn>;
  readonly choice: ReturnType<typeof vi.fn>;
  readonly shop: ReturnType<typeof vi.fn>;
  readonly cancelCapture: ReturnType<typeof vi.fn>;
  top: PointerTop;
  capturing: boolean;
  /** The one container the fake adapter moves; null = no frame is driven. */
  drive: Drive | null;
  /** Presses the fake adapter still answers (each later press is recorded, moves nothing). */
  budget: number | null;
  /** uif-5: runs after the driven container moved, for every press (a sheet's B closes it). */
  onPress: ((button: VButton) => void) | null;
  readonly source: PointerSource;
}

const navItems = (c: HTMLElement): HTMLElement[] =>
  Array.from(c.querySelectorAll<HTMLElement>('[data-nav-key]'));
const tabEls = (s: HTMLElement): HTMLElement[] =>
  Array.from(s.querySelectorAll<HTMLElement>('[role="tab"]'));
const activeIndex = (els: readonly HTMLElement[]): number =>
  els.findIndex((e) => e.classList.contains('is-active'));
function setActive(els: readonly HTMLElement[], idx: number): void {
  els.forEach((e, i) => {
    e.classList.toggle('is-active', i === idx);
    e.setAttribute('aria-selected', i === idx ? 'true' : 'false');
  });
}
const item = (c: HTMLElement, i: number): HTMLElement => {
  const el = navItems(c)[i];
  if (el === undefined) throw new Error(`fixture: no item ${i}`);
  return el;
};
const tabAt = (s: HTMLElement, i: number): HTMLElement => {
  const el = tabEls(s)[i];
  if (el === undefined) throw new Error(`fixture: no tab ${i}`);
  return el;
};
const items = (container: HTMLElement, cols: number | null = null): Drive => ({
  kind: 'items',
  container,
  cols,
});

/** One fresh D-pad / LB / RB edge on the driven container, through the real nav core. */
function drive(d: Drive, button: VButton): void {
  if (d.kind === 'tabs') {
    const els = tabEls(d.strip);
    const at = activeIndex(els);
    if (at < 0) return;
    const tabList = els.map((e) => ({ key: e.dataset.navTab as string, layout: list([]) }));
    const r = navStep(
      tabs(tabList),
      { tab: (tabList[at] as { key: string }).key, item: null, perTab: {} },
      { button, repeat: false },
    );
    if (r.state.tab !== null)
      setActive(
        els,
        tabList.findIndex((tb) => tb.key === r.state.tab),
      );
    return;
  }
  const els = navItems(d.container);
  const at = activeIndex(els);
  if (at < 0) return;
  const navs: NavItem[] = els.map((e) => ({ key: e.dataset.navKey as string, enabled: true }));
  const layout = d.cols === null ? list(navs) : grid(navs, d.cols);
  const r = navStep(
    layout,
    { tab: null, item: (navs[at] as NavItem).key, perTab: {} },
    { button, repeat: false },
  );
  setActive(
    els,
    navs.findIndex((n) => n.key === r.state.item),
  );
}

function chipSpan(button: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'mr-chip';
  el.dataset.button = button;
  el.setAttribute('aria-disabled', 'true');
  const keycap = document.createElement('span');
  keycap.className = 'mr-chip-key';
  keycap.textContent = button;
  const verb = document.createElement('span');
  verb.className = 'mr-chip-verb';
  verb.textContent = `verb ${button}`;
  el.append(keycap, verb);
  return el;
}

function chipButton(id: string, button: string): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.id = id;
  el.className = 'mr-chip';
  el.dataset.button = button;
  const verb = document.createElement('span');
  verb.className = 'mr-chip-verb';
  verb.textContent = button;
  el.appendChild(verb);
  return el;
}

/** The index.html shape: #game-screen > #app (the canvas mount), #frame-layer, #hint-bar. */
function mount(top: PointerTop): Fx {
  document.body.replaceChildren();
  const gameScreen = document.createElement('div');
  gameScreen.id = 'game-screen';
  gameScreen.className = 'mr-game-screen';
  const app = document.createElement('div');
  app.id = 'app';
  const canvas = document.createElement('canvas');
  app.appendChild(canvas);
  const layer = document.createElement('div');
  layer.id = 'frame-layer';
  const hintBar = document.createElement('div');
  hintBar.id = 'hint-bar';
  hintBar.append(
    chipSpan('A'),
    chipSpan('B'),
    chipSpan('Y'),
    chipButton('chip-start', 'Start'),
    chipButton('chip-select', 'Select'),
  );
  gameScreen.append(app, layer, hintBar);
  const outside = document.createElement('div');
  outside.id = 'outside';
  document.body.append(gameScreen, outside);

  const clock = new FakeClock();
  const presses: VButton[] = [];
  const fx = {
    gameScreen,
    canvas,
    app,
    layer,
    hintBar,
    outside,
    clock,
    presses,
    top,
    capturing: false,
    drive: null,
    budget: null,
    onPress: null,
  } as unknown as Fx;
  const press = vi.fn((button: VButton) => {
    presses.push(button);
    if (fx.budget !== null) {
      if (fx.budget <= 0) return;
      fx.budget -= 1;
    }
    if (fx.drive !== null) drive(fx.drive, button);
    fx.onPress?.(button);
  });
  const choice = vi.fn((_idx: number) => undefined);
  const shop = vi.fn((_shopId: number) => undefined);
  const cancelCapture = vi.fn(() => undefined);
  const deps: PointerDeps = {
    top: () => fx.top,
    press,
    capturing: () => fx.capturing,
    cancelCapture,
    choice,
    shop,
  };
  Object.assign(fx, { press, choice, shop, cancelCapture });
  Object.assign(fx, { source: new PointerSource(gameScreen, () => canvas, deps, clock) });
  return fx;
}

/** A frame root (`role=dialog`, `aria-modal=true`) in the frame layer; returns its body. */
function addFrame(fx: Fx, opts: { inert?: boolean; covered?: boolean } = {}): HTMLElement {
  const root = document.createElement('div');
  root.className = 'mr-frame mr-shell';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  if (opts.inert === true) root.setAttribute('inert', '');
  if (opts.covered === true) root.style.visibility = 'hidden';
  const body = document.createElement('div');
  body.className = 'mr-frame-body';
  root.appendChild(body);
  fx.layer.appendChild(root);
  return body;
}

function navItemEl(key: string, role: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mr-nav-item';
  el.setAttribute('role', role);
  el.dataset.navKey = key;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = key;
  el.appendChild(label);
  return el;
}

function addList(parent: HTMLElement, keys: readonly string[], active: number): HTMLElement {
  const c = document.createElement('div');
  c.setAttribute('role', 'listbox');
  c.setAttribute('tabindex', '0');
  for (const k of keys) c.appendChild(navItemEl(k, 'option'));
  parent.appendChild(c);
  setActive(navItems(c), active);
  return c;
}

/** A navRender-shaped grid: `role=grid` > `role=row` rows of `cols` gridcells (a short last row). */
function addGrid(
  parent: HTMLElement,
  keys: readonly string[],
  cols: number,
  active: number,
): HTMLElement {
  const c = document.createElement('div');
  c.setAttribute('role', 'grid');
  c.setAttribute('tabindex', '0');
  for (let r = 0; r * cols < keys.length; r++) {
    const row = document.createElement('div');
    row.setAttribute('role', 'row');
    row.className = 'mr-nav-row';
    for (const k of keys.slice(r * cols, (r + 1) * cols)) row.appendChild(navItemEl(k, 'gridcell'));
    c.appendChild(row);
  }
  parent.appendChild(c);
  setActive(navItems(c), active);
  return c;
}

/** A navRender-shaped tab strip: `role=tablist` > `role=tab` with `data-nav-tab`. */
function addTabs(parent: HTMLElement, keys: readonly string[], active: number): HTMLElement {
  const strip = document.createElement('div');
  strip.setAttribute('role', 'tablist');
  for (const k of keys) {
    const tab = document.createElement('div');
    tab.className = 'mr-nav-tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.navTab = k;
    tab.textContent = k;
    strip.appendChild(tab);
  }
  parent.appendChild(strip);
  setActive(tabEls(strip), active);
  return strip;
}

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 5,
    clientY: 5,
    ...init,
  });
  el.dispatchEvent(e);
  return e;
}

function contextMenu(el: Element): MouseEvent {
  const e = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 40,
    clientY: 40,
  });
  el.dispatchEvent(e);
  return e;
}

function pointer(type: string, el: Element, init: PointerEventInit = {}): PointerEvent {
  const e = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: 100,
    clientY: 100,
    ...init,
  });
  el.dispatchEvent(e);
  return e;
}

/** uif-5: a wheel event the way a browser sends it (deltaMode 0 pixel, 1 line, 2 page). */
function wheel(el: Element, deltaY: number, deltaMode = 0): WheelEvent {
  const e = new WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

/** uif-5: a `[data-context-sheet]` root holding one nav list (never `hidden` unless a test closes it). */
interface SheetHandle {
  readonly root: HTMLElement;
  readonly rows: HTMLElement;
}
function addSheet(parent: HTMLElement, keys: readonly string[], active = 0): SheetHandle {
  const root = document.createElement('div');
  root.className = 'mr-sheet';
  root.setAttribute('data-context-sheet', '');
  const rows = addList(root, keys, active);
  parent.appendChild(root);
  return { root, rows };
}

/**
 * uif-5: the fake adapter for a sheet. While the sheet shows, the driven container is its rows. Each
 * B counts down `levels` (a sub-list in the one sheet root needs 2); at zero the root is hidden and
 * the driven container becomes `after` (the base list or tab strip). `stuck` = B is ignored forever.
 */
function sheetAdapter(
  fx: Fx,
  sheet: SheetHandle,
  opts: { levels?: number; stuck?: boolean; after: Drive | null; onClosed?: () => void },
): void {
  let left = opts.levels ?? 1;
  fx.drive = items(sheet.rows);
  fx.onPress = (b) => {
    if (b !== 'B' || opts.stuck === true || sheet.root.hidden) return;
    left -= 1;
    if (left > 0) return;
    sheet.root.hidden = true;
    fx.drive = opts.after;
    opts.onClosed?.();
  };
}

/** A top frame holding a 5-row base list (cursor 0) and an open sheet of 3 rows (cursor 0). */
function frameWithSheet(
  fx: Fx,
  adapter: { levels?: number; stuck?: boolean } = {},
): { body: HTMLElement; base: HTMLElement; sheet: SheetHandle } {
  const body = addFrame(fx);
  const base = addList(body, ['a', 'b', 'c', 'd', 'e'], 0);
  const sheet = addSheet(body, ['s1', 's2', 's3'], 0);
  sheetAdapter(fx, sheet, { ...adapter, after: items(base) });
  return { body, base, sheet };
}

/** A world sheet (top 'other'): no aria-modal root above it. */
function worldSheet(
  fx: Fx,
  keys: readonly string[],
  opts: { stuck?: boolean; flipToWorld?: boolean } = {},
): SheetHandle {
  const sheet = addSheet(fx.layer, keys, 0);
  sheetAdapter(fx, sheet, {
    ...(opts.stuck === undefined ? {} : { stuck: opts.stuck }),
    after: null,
    onClosed: () => {
      if (opts.flipToWorld === true) fx.top = 'world';
    },
  });
  return sheet;
}

const rings = (fx: Fx): number => fx.gameScreen.querySelectorAll('.mr-longpress-ring').length;
const pressCalls = (fx: Fx): unknown[][] => fx.press.mock.calls as unknown[][];

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------------------------

/** Walk `path` from `from` through the real nav core (fresh edges); returns the landing index. */
function walk(count: number, cols: number | null, from: number, path: readonly VButton[]): number {
  const navs: NavItem[] = Array.from({ length: count }, (_, i) => ({
    key: `k${i}`,
    enabled: true,
  }));
  const layout = cols === null ? list(navs) : grid(navs, cols);
  let state: NavState = { tab: null, item: `k${from}`, perTab: {} };
  for (const button of path) state = navStep(layout, state, { button, repeat: false }).state;
  return navs.findIndex((n) => n.key === state.item);
}

describe('navPath / tabPath (pure)', () => {
  it('a list path is Up or Down only, never wrapping; equal indices give no presses', () => {
    // WRONG IMPL KILLED: a path that wraps the short way round (0 -> 4 as one Up: a miss on a
    // non-driven container would then be undone in the wrong direction), Left/Right in a list, and
    // a path for from === to.
    expect(navPath(5, null, 0, 3)).toEqual(['Down', 'Down', 'Down']);
    expect(navPath(5, null, 4, 1)).toEqual(['Up', 'Up', 'Up']);
    expect(navPath(5, null, 0, 4)).toEqual(['Down', 'Down', 'Down', 'Down']);
    expect(navPath(5, null, 2, 2)).toEqual([]);
    expect(navPath(1, null, 0, 0)).toEqual([]);
  });

  it('a grid path is row-major: from a full row horizontal first, from the short last row vertical first', () => {
    // 7 items, 3 columns: rows [0 1 2] [3 4 5] [6].
    expect(navPath(7, 3, 0, 5)).toEqual(['Right', 'Right', 'Down']);
    expect(navPath(7, 3, 5, 6)).toEqual(['Left', 'Left', 'Down']);
    expect(navPath(7, 3, 6, 2)).toEqual(['Up', 'Up', 'Right', 'Right']);
    expect(navPath(7, 3, 4, 4)).toEqual([]);
    expect(navPath(7, 3, 2, 0)).toEqual(['Left', 'Left']);
  });

  it('every navPath lands on its target through the real nav core, with the minimal button counts and the plan`s axis order (property)', () => {
    // WRONG IMPL KILLED: a vertical-first path out of a full row into a column the short row
    // lacks, a horizontal-first path inside the short row, a detour or a wrap.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
        fc.nat(),
        fc.nat(),
        (count, cols, a, b) => {
          const from = a % count;
          const to = b % count;
          const path = navPath(count, cols, from, to);
          expect(walk(count, cols, from, path)).toBe(to);
          const n = (btn: VButton): number => path.filter((p) => p === btn).length;
          if (cols === null) {
            expect(n('Down')).toBe(Math.max(0, to - from));
            expect(n('Up')).toBe(Math.max(0, from - to));
            expect(path.length).toBe(Math.abs(to - from));
            return;
          }
          const dr = Math.floor(to / cols) - Math.floor(from / cols);
          const dc = (to % cols) - (from % cols);
          expect(n('Down')).toBe(Math.max(0, dr));
          expect(n('Up')).toBe(Math.max(0, -dr));
          expect(n('Right')).toBe(Math.max(0, dc));
          expect(n('Left')).toBe(Math.max(0, -dc));
          expect(path.length).toBe(Math.abs(dr) + Math.abs(dc));
          const isH = (btn: VButton): boolean => btn === 'Left' || btn === 'Right';
          const fullRow = Math.floor(from / cols) * cols + cols <= count;
          const firstOther = path.findIndex((p) => (fullRow ? !isH(p) : isH(p)));
          if (firstOther >= 0) {
            const rest = path.slice(firstOther);
            expect(
              rest.every((p) => (fullRow ? !isH(p) : isH(p))),
              'one axis, then the other',
            ).toBe(true);
          }
        },
      ),
    );
  });

  it('tabPath is LB x (from - to) or RB x (to - from); equal indices give no presses', () => {
    expect(tabPath(0, 2)).toEqual(['RB', 'RB']);
    expect(tabPath(3, 1)).toEqual(['LB', 'LB']);
    expect(tabPath(1, 1)).toEqual([]);
    fc.assert(
      fc.property(fc.nat({ max: 12 }), fc.nat({ max: 12 }), (from, to) => {
        const want: VButton[] =
          to >= from ? Array(to - from).fill('RB') : Array(from - to).fill('LB');
        expect(tabPath(from, to)).toEqual(want);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// CTL15.1 — the canvas at the world base
// ---------------------------------------------------------------------------------------------

describe('PointerSource — CTL15.1 the world canvas', () => {
  it('CTL15-1-CANVAS-A: a left click (or a tap) on the canvas at the world base presses A once, passing no coordinates', () => {
    // WRONG IMPL KILLED: a canvas with no click handler (today); a press carrying the click's
    // coordinates or the event (game logic must never see a pointer position); a double press
    // (pointerdown AND click both pressing); a tap that the long-press machinery eats; a click
    // routed through the dialogue commands.
    const fx = mount('world');
    click(fx.canvas, { clientX: 123, clientY: 45 });
    expect(pressCalls(fx), 'one press, one argument: A').toEqual([['A']]);

    // A tap: touch down, up 120 ms later, then the browser's click.
    const down = pointer('pointerdown', fx.canvas, { clientX: 300, clientY: 200 });
    expect(down.defaultPrevented, 'a touch pointerdown is prevented (no emulated gestures)').toBe(
      true,
    );
    fx.clock.advance(120);
    pointer('pointerup', fx.canvas, { clientX: 300, clientY: 200 });
    expect(pressCalls(fx), 'the pointer down/up of a tap presses nothing by itself').toEqual([
      ['A'],
    ]);
    click(fx.canvas, { clientX: 300, clientY: 200 });
    expect(pressCalls(fx), 'the tap`s click presses A, again with no coordinates').toEqual([
      ['A'],
      ['A'],
    ]);
    fx.clock.advance(5_000);
    expect(pressCalls(fx), 'no late timer presses anything').toEqual([['A'], ['A']]);
    expect(fx.choice).not.toHaveBeenCalled();
    expect(fx.shop).not.toHaveBeenCalled();
    expect(fx.cancelCapture).not.toHaveBeenCalled();
  });

  it('CTL15-1-ELSEWHERE-NOTHING: at the world base a click anywhere but the canvas or a chip does nothing, and a canvas click does nothing unless the top is the world base', () => {
    // WRONG IMPL KILLED: A on any click in the game screen (a click on the frame layer or the bare
    // hint bar would talk to the faced NPC); a document-level listener (a click outside the game
    // screen); a canvas click that presses A with a frame or a world sheet on top (it would accept
    // a request, or act in the frame).
    const fx = mount('world');
    const span = document.createElement('span');
    fx.layer.appendChild(span);
    for (const el of [fx.gameScreen, fx.app, fx.layer, span, fx.hintBar, fx.outside]) click(el);
    expect(pressCalls(fx), 'nothing but the canvas acts at the world').toEqual([]);

    fx.top = 'other';
    click(fx.canvas);
    expect(pressCalls(fx), 'top "other" (a battle, a text entry, a world sheet)').toEqual([]);
    fx.top = 'frame';
    click(fx.canvas);
    expect(pressCalls(fx), 'a frame on top: the canvas is not a target').toEqual([]);

    fx.top = 'world';
    click(fx.canvas);
    expect(pressCalls(fx), 'control: the same canvas click at the world presses A').toEqual([
      ['A'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// CTL15.2 — items and tabs in the top frame
//
// uif-5 CHANGED CTL15.2 (feedback 046): a click on a [data-nav-key] in the top frame used to seek
// the clicked row even when an open context sheet owned the cursor (the sheet blocked other rows,
// so the probe was undone and nothing happened). It now FIRST closes the open sheet with B, then
// seeks and presses A: see the "UIF5.1 CTL15-2-SHEET-CLOSE-THEN-ROUTE" test below. Every other
// CTL15.2 test here is unchanged (none of them has a sheet root in the DOM).
// ---------------------------------------------------------------------------------------------

describe('PointerSource — CTL15.2 the top frame', () => {
  it('CTL15-2-LIST-SEEK: a click on a list item in the top frame walks the cursor there with D-pad presses, then presses A', () => {
    // WRONG IMPL KILLED: a click that presses A on the CURRENT cursor (the wrong row activates); a
    // seek that writes the DOM or calls a screen API instead of pressing (the adapter never hears
    // it); a wrapped path; an A before the cursor arrives; a click on a node inside the row lost.
    const fx = mount('frame');
    const body = addFrame(fx);
    const l = addList(body, ['a', 'b', 'c', 'd', 'e'], 0);
    fx.drive = items(l);

    click(item(l, 3));
    expect(fx.presses).toEqual(['Down', 'Down', 'Down', 'A']);
    expect(activeIndex(navItems(l)), 'the cursor is on the clicked row').toBe(3);

    fx.presses.length = 0;
    click(item(l, 1).querySelector('.label') as HTMLElement);
    expect(fx.presses, 'a click inside the row, upward').toEqual(['Up', 'Up', 'A']);
    expect(activeIndex(navItems(l))).toBe(1);
    for (const call of pressCalls(fx)) expect(call, 'one argument per press').toHaveLength(1);
    expect(fx.choice).not.toHaveBeenCalled();
    expect(fx.shop).not.toHaveBeenCalled();
  });

  it('CTL15-2-GRID-SEEK: a click on a grid cell walks the row-major D-pad path (short last row included), then presses A', () => {
    // WRONG IMPL KILLED: a grid treated as a list (Down x5 lands on the wrong cell), a path that
    // goes vertical first out of a full row into the column the short row lacks, and one that goes
    // horizontal first inside the short row.
    const fx = mount('frame');
    const body = addFrame(fx);
    const g = addGrid(body, ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6'], 3, 0);
    fx.drive = items(g, 3);

    click(item(g, 5));
    expect(fx.presses).toEqual(['Right', 'Right', 'Down', 'A']);
    expect(activeIndex(navItems(g))).toBe(5);

    fx.presses.length = 0;
    click(item(g, 6));
    expect(fx.presses, 'into the short last row').toEqual(['Left', 'Left', 'Down', 'A']);
    expect(activeIndex(navItems(g))).toBe(6);

    fx.presses.length = 0;
    click(item(g, 2));
    expect(fx.presses, 'out of the short last row').toEqual(['Up', 'Up', 'Right', 'Right', 'A']);
    expect(activeIndex(navItems(g))).toBe(2);
  });

  it('CTL15-2-TAB: a click on a tab switches to it with LB / RB presses and never presses A', () => {
    // WRONG IMPL KILLED: a tab click that does nothing (today), one that presses A (it would
    // activate the item under the cursor of the new tab), and LB / RB swapped.
    const fx = mount('frame');
    const body = addFrame(fx);
    const strip = addTabs(body, ['bait', 'food', 'medicine'], 0);
    addList(body, ['x', 'y'], 0);
    fx.drive = { kind: 'tabs', strip };

    click(tabAt(strip, 2));
    expect(fx.presses).toEqual(['RB', 'RB']);
    expect(activeIndex(tabEls(strip))).toBe(2);

    fx.presses.length = 0;
    click(tabAt(strip, 0));
    expect(fx.presses).toEqual(['LB', 'LB']);
    expect(activeIndex(tabEls(strip))).toBe(0);

    fx.presses.length = 0;
    click(tabAt(strip, 0));
    expect(fx.presses, 'the active tab: no A').not.toContain('A');
    expect(activeIndex(tabEls(strip)), 'and it stays active').toBe(0);
  });

  it('CTL15-2-LOWER-IGNORED: a click in a lower (inert or covered) frame, on the canvas, on frame padding, or with no frame on top presses nothing', () => {
    // WRONG IMPL KILLED: a dispatcher that seeks in any frame (a click on the stale menu under a
    // child frame would drive the child's cursor); a covered (visibility:hidden) menu treated as
    // live; a canvas click under a frame; a click on padding that presses A on the cursor.
    const fx = mount('frame');
    const lower = addList(addFrame(fx, { inert: true }), ['a', 'b', 'c'], 0);
    const covered = addList(addFrame(fx, { covered: true }), ['m', 'n', 'o'], 0);
    const topBody = addFrame(fx);
    const live = addList(topBody, ['x', 'y', 'z'], 0);
    fx.drive = items(live);

    click(item(lower, 2));
    click(item(covered, 1));
    click(fx.canvas);
    click(topBody);
    click(live);
    expect(fx.presses, 'nothing in a lower frame, the canvas or the padding').toEqual([]);

    fx.top = 'other';
    click(item(live, 2));
    fx.top = 'world';
    click(item(live, 2));
    expect(fx.presses, 'no seek unless a frame is on top').toEqual([]);
    expect(activeIndex(navItems(live))).toBe(0);

    fx.top = 'frame';
    click(item(live, 2));
    expect(fx.presses, 'control: the top frame`s row does seek').toEqual(['Down', 'Down', 'A']);
  });

  it('CTL15-2-MISS-UNDO: when the clicked container is not the driven one, the first press is undone and nothing is activated; a miss mid-path stops at once', () => {
    // WRONG IMPL KILLED: a seek that trusts the DOM (it presses the whole path, moving the REAL
    // driven list three rows and then activating its item); a probe with no undo (the driven
    // cursor is left moved); an undo in the wrong direction; a path that keeps pressing after the
    // cursor stopped answering (no verification after each press).
    const fx = mount('frame');
    const body = addFrame(fx);
    const target = addList(body, ['t0', 't1', 't2', 't3'], 0);
    const driven = addList(body, ['d0', 'd1', 'd2', 'd3'], 1);
    fx.drive = items(driven);

    click(item(target, 2));
    expect(fx.presses, 'the first step, then its inverse; no A').toEqual(['Down', 'Up']);
    expect(activeIndex(navItems(target)), 'the stale list did not move').toBe(0);
    expect(activeIndex(navItems(driven)), 'the driven list is back where it was').toBe(1);

    fx.presses.length = 0;
    setActive(navItems(target), 3);
    click(item(target, 0));
    expect(fx.presses, 'upward: Up, then Down').toEqual(['Up', 'Down']);
    expect(activeIndex(navItems(driven))).toBe(1);

    // The target IS driven, but the adapter answers only the first press.
    fx.presses.length = 0;
    setActive(navItems(target), 0);
    fx.drive = items(target);
    fx.budget = 1;
    click(item(target, 3));
    expect(fx.presses, 'a miss after the first step stops: no more presses, no A').toEqual([
      'Down',
      'Down',
    ]);

    // No active item in the clicked container: nothing to seek from.
    fx.presses.length = 0;
    fx.budget = null;
    for (const el of navItems(target)) {
      el.classList.remove('is-active');
      el.setAttribute('aria-selected', 'false');
    }
    click(item(target, 2));
    expect(fx.presses, 'no cursor in the container: abort').toEqual([]);
  });

  it('CTL15-2-ACTIVE-PROBE: a click on the already-active item presses A only once the container is proven driven (probe and undo, or elimination); a tie of single-item containers is refused', () => {
    // WRONG IMPL KILLED: an A on any click of an active-looking row (the stale base list under a
    // sheet shows an active row too: its A would go to the sheet's cursor); a probe without the
    // undo; a single-item container trusted without elimination; elimination that counts hidden
    // containers, or that picks "the last container" in a tie.
    // (a) a driven list: probe Down, undo Up, then A (also on the last row, where Down wraps).
    {
      const fx = mount('frame');
      const l = addList(addFrame(fx), ['a', 'b', 'c'], 1);
      fx.drive = items(l);
      click(item(l, 1));
      expect(fx.presses, 'probe, undo, A').toEqual(['Down', 'Up', 'A']);
      expect(activeIndex(navItems(l))).toBe(1);
      fx.presses.length = 0;
      setActive(navItems(l), 2);
      click(item(l, 2));
      expect(fx.presses, 'the last row: Down wraps, still a move').toEqual(['Down', 'Up', 'A']);
      expect(activeIndex(navItems(l))).toBe(2);
    }
    // (b) the clicked list is stale, another list is driven: probe moved the wrong one -> undo, no A.
    {
      const fx = mount('frame');
      const body = addFrame(fx);
      const stale = addList(body, ['a', 'b', 'c'], 1);
      const driven = addList(body, ['p', 'q', 'r'], 0);
      fx.drive = items(driven);
      click(item(stale, 1));
      expect(fx.presses, 'probe, undo, no A').toEqual(['Down', 'Up']);
      expect(activeIndex(navItems(driven))).toBe(0);
    }
    // (c) a tie of two visible single-item containers: never A, whichever is clicked.
    {
      const fx = mount('frame');
      const body = addFrame(fx);
      const one = addList(body, ['s1'], 0);
      const two = addList(body, ['s2'], 0);
      fx.drive = items(two);
      click(item(one, 0));
      click(item(two, 0));
      expect(fx.presses, 'a tie is refused').not.toContain('A');
      expect(activeIndex(navItems(one))).toBe(0);
      expect(activeIndex(navItems(two))).toBe(0);
    }
    // (d) the only visible container, one item: elimination, A at once.
    {
      const fx = mount('frame');
      const only = addList(addFrame(fx), ['solo'], 0);
      fx.drive = items(only);
      click(item(only, 0));
      expect(fx.presses).toEqual(['A']);
    }
    // (e) one item beside a >= 2-item list a Down probe does not move: driven by elimination.
    {
      const fx = mount('frame');
      const body = addFrame(fx);
      const base = addList(body, ['f1', 'f2'], 0);
      const picker = addList(body, ['mon'], 0);
      fx.drive = items(picker);
      click(item(picker, 0));
      expect(fx.presses, 'the probe moved nothing: A, no undo').toEqual(['Down', 'A']);
      expect(activeIndex(navItems(base))).toBe(0);
    }
    // (e') the same layout, but the >= 2-item list IS driven: the probe moved it -> undo, no A.
    {
      const fx = mount('frame');
      const body = addFrame(fx);
      const base = addList(body, ['f1', 'f2'], 0);
      const picker = addList(body, ['mon'], 0);
      fx.drive = items(base);
      click(item(picker, 0));
      expect(fx.presses).toEqual(['Down', 'Up']);
      expect(activeIndex(navItems(base)), 'the driven list is restored').toBe(0);
    }
    // (f) hidden containers (hidden, display:none, visibility:hidden) do not count.
    {
      const fx = mount('frame');
      const body = addFrame(fx);
      const wrap = (how: 'hidden' | 'display' | 'visibility'): HTMLElement => {
        const w = document.createElement('div');
        if (how === 'hidden') w.hidden = true;
        if (how === 'display') w.style.display = 'none';
        if (how === 'visibility') w.style.visibility = 'hidden';
        body.appendChild(w);
        return w;
      };
      addList(wrap('hidden'), ['h1'], 0);
      addList(wrap('display'), ['h2'], 0);
      addList(wrap('visibility'), ['h3'], 0);
      const shown = addList(body, ['solo'], 0);
      fx.drive = items(shown);
      click(item(shown, 0));
      expect(fx.presses, 'the only VISIBLE container').toEqual(['A']);
    }
  });

  it('CTL15-2-DIALOGUE: a dialogue choice button sends choice(idx) and a greet-then-shop button sends shop(id), once each, with no press; outside #game-screen nothing', () => {
    // WRONG IMPL KILLED: the absorbed document delegate dropped (dialogue clicks dead); index 0
    // treated as missing; the string attribute passed through un-parsed; a choice that also
    // presses A (double dispatch); a document-level listener kept (a choice outside the game
    // screen still sent).
    const fx = mount('frame');
    const body = addFrame(fx);
    const pick = document.createElement('button');
    pick.dataset.choiceIdx = '2';
    const inner = document.createElement('span');
    inner.textContent = 'Tell me more';
    pick.appendChild(inner);
    const shopBtn = document.createElement('button');
    shopBtn.dataset.shopId = '7';
    body.append(pick, shopBtn);

    click(inner);
    expect(fx.choice.mock.calls).toEqual([[2]]);
    click(shopBtn);
    expect(fx.shop.mock.calls).toEqual([[7]]);

    fx.top = 'world';
    const zero = document.createElement('button');
    zero.dataset.choiceIdx = '0';
    body.appendChild(zero);
    click(zero);
    expect(fx.choice.mock.calls, 'index 0, whatever the top').toEqual([[2], [0]]);

    const stray = document.createElement('button');
    stray.dataset.choiceIdx = '1';
    fx.outside.appendChild(stray);
    click(stray);
    expect(fx.choice.mock.calls, 'no listener outside the game screen').toEqual([[2], [0]]);
    expect(fx.presses, 'no press for a dialogue command').toEqual([]);
  });

  it('CTL15-2-NATIVE-IGNORED: a native control inside a row, or a row inside [data-pointer-own], presses nothing; the row itself still seeks', () => {
    // WRONG IMPL KILLED: a dispatcher that seeks + A on a Buy / To Box button's row (the button
    // already acts: double dispatch); a text field click that activates its row; the menu's own
    // row click dispatched twice (the view owns it via data-pointer-own).
    const fx = mount('frame');
    const body = addFrame(fx);
    const l = addList(body, ['a', 'b', 'c'], 0);
    fx.drive = items(l);
    const btn = document.createElement('button');
    btn.textContent = 'Buy';
    item(l, 2).appendChild(btn);
    const field = document.createElement('input');
    item(l, 1).appendChild(field);
    const link = document.createElement('a');
    link.href = '#x';
    link.textContent = 'more';
    item(l, 2).appendChild(link);
    const ownWrap = document.createElement('div');
    ownWrap.setAttribute('data-pointer-own', '');
    body.appendChild(ownWrap);
    const owned = addList(ownWrap, ['o1', 'o2', 'o3'], 0);

    click(btn);
    click(field);
    click(link);
    click(item(owned, 2));
    expect(fx.presses, 'native controls and owned rows answer their own clicks').toEqual([]);

    click(item(l, 2));
    expect(fx.presses, 'control: the row itself seeks').toEqual(['Down', 'Down', 'A']);
  });

  it('UIF5.1 CTL15-2-SHEET-CLOSE-THEN-ROUTE: a click on a [data-nav-key] in the top frame first closes an open context sheet with B (uif-5, feedback 046 — changed from: the sheet blocked other rows) then makes that item active and presses A', () => {
    // WRONG IMPL KILLED: the old CTL15.2 behavior (the sheet's cursor drives, the seek is probed
    // and undone, no A: the click is dead); a seek with no close (B never pressed); a close that
    // comes AFTER the seek or the A (the A would hit the sheet's row); a close that swallows the
    // click (no routing after it).
    const fx = mount('frame');
    const body = addFrame(fx);
    const base = addList(body, ['m0', 'm1', 'm2', 'm3'], 1);
    const sheet = addSheet(body, ['feed', 'evolve', 'close'], 0);
    sheetAdapter(fx, sheet, { after: items(base) });

    click(item(base, 3));
    expect(fx.presses, 'B closes the sheet, then the walk, then A').toEqual([
      'B',
      'Down',
      'Down',
      'A',
    ]);
    expect(sheet.root.hidden, 'the sheet is closed').toBe(true);
    expect(activeIndex(navItems(base)), 'the clicked row is active').toBe(3);

    // The clicked row is the one the stale cursor already marked: probe, undo, then A.
    const again = mount('frame');
    const body2 = addFrame(again);
    const base2 = addList(body2, ['m0', 'm1', 'm2'], 1);
    const sheet2 = addSheet(body2, ['feed', 'close'], 0);
    sheetAdapter(again, sheet2, { after: items(base2) });
    click(item(base2, 1));
    expect(again.presses).toEqual(['B', 'Down', 'Up', 'A']);
  });
});

// ---------------------------------------------------------------------------------------------
// CTL15.3 — right-click and the touch long-press
// ---------------------------------------------------------------------------------------------

describe('PointerSource — CTL15.3 back (B)', () => {
  it('CTL15-3-RIGHTCLICK-B: a right-click inside #game-screen is prevented and presses B exactly once; outside it, or on a text field, the browser menu is untouched', () => {
    // WRONG IMPL KILLED: no contextmenu listener (today: the browser menu opens over the game); a
    // document-level suppression (the page-wide menu is lost); B pressed twice; a right-click
    // treated as A; a text field whose copy/paste menu is suppressed.
    const fx = mount('world');
    const onCanvas = contextMenu(fx.canvas);
    expect(onCanvas.defaultPrevented).toBe(true);
    expect(pressCalls(fx)).toEqual([['B']]);

    fx.top = 'frame';
    const body = addFrame(fx);
    const l = addList(body, ['a', 'b'], 0);
    fx.drive = items(l);
    const inFrame = contextMenu(item(l, 1));
    expect(inFrame.defaultPrevented).toBe(true);
    expect(pressCalls(fx), 'B, not a seek').toEqual([['B'], ['B']]);
    expect(activeIndex(navItems(l))).toBe(0);

    fx.top = 'other';
    contextMenu(fx.hintBar);
    expect(pressCalls(fx), 'B whatever the top').toEqual([['B'], ['B'], ['B']]);

    const outsideMenu = contextMenu(fx.outside);
    expect(outsideMenu.defaultPrevented, 'outside #game-screen: untouched').toBe(false);
    const field = document.createElement('input');
    body.appendChild(field);
    const onField = contextMenu(field);
    expect(onField.defaultPrevented, 'a text field keeps its menu').toBe(false);
    expect(pressCalls(fx), 'no press for either').toEqual([['B'], ['B'], ['B']]);
  });

  it('CTL15-3-CAPTURE-CANCEL: while remap capture waits, a right-click (or a completed long-press) cancels it instead of pressing B, and left clicks do nothing', () => {
    // WRONG IMPL KILLED: a right-click that presses B into the capture (B would be bound as the
    // captured key); left clicks that seek, press A, fire a chip or a dialogue command under the
    // capture; a long-press that presses B there.
    const fx = mount('frame');
    const body = addFrame(fx);
    const l = addList(body, ['a', 'b', 'c'], 0);
    fx.drive = items(l);
    const pick = document.createElement('button');
    pick.dataset.choiceIdx = '1';
    body.appendChild(pick);
    fx.capturing = true;

    const e = contextMenu(item(l, 0));
    expect(e.defaultPrevented).toBe(true);
    expect(fx.cancelCapture).toHaveBeenCalledTimes(1);
    expect(fx.press, 'no B into the capture').not.toHaveBeenCalled();

    click(item(l, 2));
    click(fx.hintBar.querySelector('[data-button="A"]') as HTMLElement);
    click(document.getElementById('chip-start') as HTMLElement);
    click(pick);
    fx.top = 'world';
    click(fx.canvas);
    expect(fx.press, 'left clicks do nothing under the capture').not.toHaveBeenCalled();
    expect(fx.choice).not.toHaveBeenCalled();
    expect(fx.cancelCapture, 'and do not cancel it').toHaveBeenCalledTimes(1);

    pointer('pointerdown', fx.canvas);
    fx.clock.advance(500);
    pointer('pointerup', fx.canvas);
    expect(fx.cancelCapture, 'a long-press cancels the capture').toHaveBeenCalledTimes(2);
    expect(fx.press).not.toHaveBeenCalled();

    fx.capturing = false;
    fx.clock.advance(1_500);
    contextMenu(fx.canvas);
    expect(pressCalls(fx), 'control: no capture, a right-click presses B').toEqual([['B']]);
    expect(fx.cancelCapture).toHaveBeenCalledTimes(2);
  });

  it('CTL15-3-LONGPRESS-B: a primary touch held 500 ms within 10 px shows a fill ring and presses B exactly once; moving more than 10 px, lifting early or cancelling presses nothing', () => {
    // WRONG IMPL KILLED: no touch listeners (today); B at 499 ms; B twice (timer and pointerup);
    // a ring left on screen; a slop measured from the last move instead of the start, or with a
    // strict 10 px bound; a mouse press or a second finger treated as a long-press; a text field's
    // touch prevented.
    const fx = mount('world');
    const down = pointer('pointerdown', fx.canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(down.defaultPrevented, 'touch pointerdown is prevented').toBe(true);
    expect(rings(fx), 'the fill ring shows').toBe(1);
    fx.clock.advance(499);
    expect(fx.press, 'not yet at 499 ms').not.toHaveBeenCalled();
    expect(rings(fx)).toBe(1);
    fx.clock.advance(1);
    expect(pressCalls(fx), 'B at 500 ms').toEqual([['B']]);
    expect(rings(fx), 'the ring goes').toBe(0);
    pointer('pointerup', fx.canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    fx.clock.advance(2_000);
    expect(pressCalls(fx), 'exactly once').toEqual([['B']]);

    // Moved 11 px: cancelled.
    pointer('pointerdown', fx.canvas, { pointerId: 2, clientX: 200, clientY: 200 });
    pointer('pointermove', fx.canvas, { pointerId: 2, clientX: 211, clientY: 200 });
    expect(rings(fx), 'a cancelled press drops its ring').toBe(0);
    fx.clock.advance(1_000);
    pointer('pointerup', fx.canvas, { pointerId: 2, clientX: 211, clientY: 200 });
    expect(pressCalls(fx), 'more than 10 px: no B').toEqual([['B']]);

    // Exactly 10 px (6, 8), via a 5 px stop: still a long-press.
    pointer('pointerdown', fx.canvas, { pointerId: 3, clientX: 300, clientY: 300 });
    pointer('pointermove', fx.canvas, { pointerId: 3, clientX: 303, clientY: 304 });
    pointer('pointermove', fx.canvas, { pointerId: 3, clientX: 306, clientY: 308 });
    expect(rings(fx)).toBe(1);
    fx.clock.advance(500);
    pointer('pointerup', fx.canvas, { pointerId: 3, clientX: 306, clientY: 308 });
    expect(pressCalls(fx), 'exactly 10 px still counts').toEqual([['B'], ['B']]);

    // 8 px then 16 px from the start (8 from the last point): cancelled.
    pointer('pointerdown', fx.canvas, { pointerId: 4, clientX: 50, clientY: 50 });
    pointer('pointermove', fx.canvas, { pointerId: 4, clientX: 58, clientY: 50 });
    pointer('pointermove', fx.canvas, { pointerId: 4, clientX: 66, clientY: 50 });
    fx.clock.advance(1_000);
    pointer('pointerup', fx.canvas, { pointerId: 4, clientX: 66, clientY: 50 });
    expect(pressCalls(fx), 'the slop is measured from the start').toEqual([['B'], ['B']]);

    // Another pointer's move does not cancel the primary's press.
    pointer('pointerdown', fx.canvas, { pointerId: 5, clientX: 10, clientY: 10 });
    pointer('pointermove', fx.canvas, {
      pointerId: 6,
      isPrimary: false,
      clientX: 400,
      clientY: 400,
    });
    fx.clock.advance(500);
    pointer('pointerup', fx.canvas, { pointerId: 5, clientX: 10, clientY: 10 });
    expect(pressCalls(fx), 'a second finger`s move is not this press`s').toEqual([
      ['B'],
      ['B'],
      ['B'],
    ]);

    // Lifted at 300 ms; cancelled at 200 ms.
    pointer('pointerdown', fx.canvas, { pointerId: 7 });
    fx.clock.advance(300);
    pointer('pointerup', fx.canvas, { pointerId: 7 });
    expect(rings(fx)).toBe(0);
    fx.clock.advance(1_000);
    pointer('pointerdown', fx.canvas, { pointerId: 8 });
    fx.clock.advance(200);
    pointer('pointercancel', fx.canvas, { pointerId: 8 });
    expect(rings(fx)).toBe(0);
    fx.clock.advance(1_000);
    expect(pressCalls(fx), 'an early lift or a cancel: no B').toEqual([['B'], ['B'], ['B']]);

    // A mouse press, a non-primary touch, a touch on a text field: no long-press.
    const mouse = pointer('pointerdown', fx.canvas, { pointerId: 9, pointerType: 'mouse' });
    expect(mouse.defaultPrevented, 'a mouse pointerdown is left alone').toBe(false);
    expect(rings(fx)).toBe(0);
    fx.clock.advance(1_000);
    pointer('pointerup', fx.canvas, { pointerId: 9, pointerType: 'mouse' });
    pointer('pointerdown', fx.canvas, { pointerId: 10, isPrimary: false });
    expect(rings(fx), 'no ring for a second finger').toBe(0);
    fx.clock.advance(1_000);
    pointer('pointerup', fx.canvas, { pointerId: 10, isPrimary: false });
    const field = document.createElement('input');
    fx.layer.appendChild(field);
    const onField = pointer('pointerdown', field, { pointerId: 11 });
    expect(onField.defaultPrevented, 'a text field`s touch is not prevented').toBe(false);
    expect(rings(fx)).toBe(0);
    fx.clock.advance(1_000);
    pointer('pointerup', field, { pointerId: 11 });
    expect(pressCalls(fx), 'none of them presses B').toEqual([['B'], ['B'], ['B']]);
  });

  it('CTL15-3-LONGPRESS-SWALLOW: the click that follows a completed long-press is swallowed, but a later tap (a new pointerdown) or a click a second later is not', () => {
    // WRONG IMPL KILLED: a long-press on the canvas that ALSO presses A through the browser's
    // trailing click (back, then talk); a swallow that never clears (the next tap is dead); a
    // swallow kept forever when the browser sends no click.
    const fx = mount('world');
    pointer('pointerdown', fx.canvas);
    fx.clock.advance(500);
    pointer('pointerup', fx.canvas);
    click(fx.canvas);
    expect(fx.presses, 'B only: the trailing click is swallowed').toEqual(['B']);

    pointer('pointerdown', fx.canvas, { pointerId: 2 });
    fx.clock.advance(100);
    pointer('pointerup', fx.canvas, { pointerId: 2 });
    click(fx.canvas);
    expect(fx.presses, 'a new tap is not eaten').toEqual(['B', 'A']);

    pointer('pointerdown', fx.canvas, { pointerId: 3 });
    fx.clock.advance(500);
    pointer('pointerup', fx.canvas, { pointerId: 3 });
    fx.clock.advance(1_001);
    click(fx.canvas);
    expect(fx.presses, 'the swallow expires after a second').toEqual(['B', 'A', 'B', 'A']);
  });

  it('CTL15-3-TOUCH-CONTEXTMENU-ONCE: a contextmenu during or just after a touch long-press is prevented but presses no second B', () => {
    // WRONG IMPL KILLED: a touch long-press that presses B twice (the timer AND the browser's
    // touch contextmenu), or that lets the browser's touch menu open; a suppression that never
    // ends (a real right-click later must still press B).
    const fx = mount('frame');
    const body = addFrame(fx);
    const target = addList(body, ['a', 'b'], 0);
    fx.drive = items(target);
    const el = item(target, 1);

    pointer('pointerdown', el);
    fx.clock.advance(300);
    const early = contextMenu(el);
    expect(early.defaultPrevented, 'the touch contextmenu before 500 ms is prevented').toBe(true);
    expect(fx.press).not.toHaveBeenCalled();
    fx.clock.advance(200);
    expect(pressCalls(fx), 'the long-press still presses its one B').toEqual([['B']]);
    const during = contextMenu(el);
    expect(during.defaultPrevented).toBe(true);
    pointer('pointerup', el);
    fx.clock.advance(500);
    const after = contextMenu(el);
    expect(after.defaultPrevented, 'and just after it').toBe(true);
    expect(pressCalls(fx), 'still one B').toEqual([['B']]);

    fx.clock.advance(1_500);
    contextMenu(el);
    expect(pressCalls(fx), 'control: a right-click later presses B').toEqual([['B'], ['B']]);
  });
});

// ---------------------------------------------------------------------------------------------
// CTL15.4 — hover
// ---------------------------------------------------------------------------------------------

const hover = (el: Element, x: number, y: number, pointerType = 'mouse'): PointerEvent =>
  pointer('pointermove', el, { pointerType, pointerId: 1, clientX: x, clientY: y });

describe('PointerSource — CTL15.4 hover', () => {
  it('CTL15-4-HOVER-SEEK: a mouse moving over a top-frame item makes it active with D-pad presses (never A) and marks the hover state', () => {
    // WRONG IMPL KILLED: no hover at all; a hover that presses A (a mouse sweep would open every
    // row it crosses); a hover in a lower frame; touch moves treated as hover.
    const fx = mount('frame');
    const lower = addList(addFrame(fx, { inert: true }), ['p', 'q', 'r'], 0);
    const l = addList(addFrame(fx), ['a', 'b', 'c', 'd'], 0);
    fx.drive = items(l);

    hover(item(l, 2), 50, 60);
    expect(fx.presses).toEqual(['Down', 'Down']);
    expect(activeIndex(navItems(l))).toBe(2);
    expect(fx.gameScreen.classList.contains('mr-pointer-hover'), 'the hover state shows').toBe(
      true,
    );

    hover(item(l, 3), 52, 80);
    expect(fx.presses).toEqual(['Down', 'Down', 'Down']);
    hover(item(l, 3), 53, 81);
    expect(fx.presses, 'the active item hovered again: nothing').toEqual(['Down', 'Down', 'Down']);
    hover(item(lower, 2), 10, 10);
    expect(fx.presses, 'a lower frame: nothing').toEqual(['Down', 'Down', 'Down']);
    expect(fx.presses, 'never A').not.toContain('A');

    const touchOnly = mount('frame');
    const tl = addList(addFrame(touchOnly), ['a', 'b', 'c'], 0);
    touchOnly.drive = items(tl);
    hover(item(tl, 2), 70, 70, 'touch');
    expect(touchOnly.presses, 'a touch move is not a hover').toEqual([]);
    expect(touchOnly.gameScreen.classList.contains('mr-pointer-hover')).toBe(false);
  });

  it('CTL15-4-STATIONARY: a pointermove at unchanged coordinates (a re-render under a still pointer) changes nothing', () => {
    // WRONG IMPL KILLED: a hover that seeks on every pointermove over a non-active row: after the
    // keyboard moved the cursor (or the frame re-rendered its rows), a browser's synthetic move at
    // the SAME position would snap the cursor back under the mouse.
    const fx = mount('frame');
    const body = addFrame(fx);
    const l = addList(body, ['a', 'b', 'c', 'd'], 0);
    fx.drive = items(l);
    hover(item(l, 2), 50, 60);
    expect(fx.presses, 'precondition: the first move seeks').toEqual(['Down', 'Down']);

    // The cursor moves away by another source, and the rows are re-rendered as new nodes.
    l.remove();
    const again = addList(body, ['a', 'b', 'c', 'd'], 0);
    fx.drive = items(again);
    hover(item(again, 2), 50, 60);
    hover(item(again, 1), 50, 60);
    expect(fx.presses, 'same coordinates: no presses').toEqual(['Down', 'Down']);
    expect(activeIndex(navItems(again))).toBe(0);
  });

  it('CTL15-4-KEY-HIDES: keyPressed() hides the hover state, and the next move to new coordinates shows it again and makes the hovered item active', () => {
    // WRONG IMPL KILLED: a hover mark that never clears (two cursors on screen while the player
    // drives with the keyboard); a keyPressed that also forgets nothing (the next real mouse
    // move over the same row would not bring the cursor back to it).
    const fx = mount('frame');
    const l = addList(addFrame(fx), ['a', 'b', 'c', 'd'], 0);
    fx.drive = items(l);
    fx.source.keyPressed();
    expect(fx.gameScreen.classList.contains('mr-pointer-hover'), 'no hover yet').toBe(false);

    hover(item(l, 2), 50, 60);
    expect(fx.gameScreen.classList.contains('mr-pointer-hover')).toBe(true);
    fx.source.keyPressed();
    expect(fx.gameScreen.classList.contains('mr-pointer-hover'), 'a key hides it').toBe(false);

    // The keyboard moved the cursor back to the top; the mouse then moves (new coordinates) on the
    // same row.
    setActive(navItems(l), 0);
    fx.presses.length = 0;
    hover(item(l, 2), 51, 61);
    expect(fx.gameScreen.classList.contains('mr-pointer-hover'), 'shown again').toBe(true);
    expect(fx.presses, 'and the hovered row is made active').toEqual(['Down', 'Down']);
    expect(activeIndex(navItems(l))).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// CTL15.5 — hint-bar chips
// ---------------------------------------------------------------------------------------------

describe('PointerSource — CTL15.5 chips', () => {
  it('CTL15-5-CHIP-PRESS: clicking a hint-bar chip (A, B, Y, Start, Select) presses that button once, at the world, in a frame and elsewhere', () => {
    // WRONG IMPL KILLED: span chips that take no click (B12: a frame could not be left without a
    // hold); Start / Select kept on their old launcher delegates (open-only, no parity with the
    // key); a chip click that ALSO seeks or presses A on the canvas; a data-button outside the bar
    // or an unknown button name treated as a chip.
    for (const top of ['world', 'frame', 'other'] as const) {
      const fx = mount(top);
      const l = addList(addFrame(fx), ['a', 'b', 'c'], 1);
      fx.drive = items(l);
      for (const b of ['A', 'B', 'Y']) {
        click(fx.hintBar.querySelector(`[data-button="${b}"] .mr-chip-verb`) as HTMLElement);
      }
      click(document.getElementById('chip-start') as HTMLElement);
      click(document.getElementById('chip-select') as HTMLElement);
      expect(pressCalls(fx), `${top}: one press per chip, in order`).toEqual([
        ['A'],
        ['B'],
        ['Y'],
        ['Start'],
        ['Select'],
      ]);
      expect(activeIndex(navItems(l)), `${top}: a chip moves no cursor`).toBe(1);

      const bogus = chipSpan('Q');
      fx.hintBar.appendChild(bogus);
      click(bogus);
      const stray = chipSpan('A');
      fx.app.appendChild(stray);
      click(stray);
      expect(pressCalls(fx), `${top}: not a VButton, or not in the hint bar`).toHaveLength(5);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// lens round (red-team RD1/RD2 and kill tests, plan review): untagged gating cases
// ---------------------------------------------------------------------------------------------

/** A touch long-press on `el` that fires (600 ms), then the browser's trailing click. */
function longPressThenClick(fx: Fx, el: Element): MouseEvent {
  pointer('pointerdown', el);
  fx.clock.advance(600);
  pointer('pointerup', el);
  return click(el);
}

describe('PointerSource — lens round', () => {
  it('RD1: the click trailing a fired long-press is swallowed in the capture phase, so a native button`s own click listener inside #game-screen never runs', () => {
    // WRONG IMPL KILLED: a swallow done in the bubble-phase dispatcher only (the button's own
    // listener has already run: Move / To Box / Buy fire AND B is pressed).
    const fx = mount('frame');
    const btn = document.createElement('button');
    const own = vi.fn();
    btn.addEventListener('click', own);
    addFrame(fx).appendChild(btn);
    const trailing = longPressThenClick(fx, btn);
    expect(fx.presses).toEqual(['B']);
    expect(own, 'the button does not also activate').not.toHaveBeenCalled();
    expect(trailing.defaultPrevented, 'the swallowed click is prevented').toBe(true);
  });

  it('RD2: the click trailing a fired long-press on a [data-pointer-own] row never reaches the owner`s listener', () => {
    // WRONG IMPL KILLED: the menu picks the row the long-press went back from.
    const fx = mount('frame');
    const owner = document.createElement('div');
    owner.setAttribute('data-pointer-own', '');
    const pick = vi.fn();
    owner.addEventListener('click', pick);
    addFrame(fx).appendChild(owner);
    const rows = addList(owner, ['bag', 'monsters'], 0);
    longPressThenClick(fx, item(rows, 0));
    expect(fx.presses).toEqual(['B']);
    expect(pick, 'the owner never hears the swallowed click').not.toHaveBeenCalled();
  });

  it('K-P15: a long-press whose trailing click never arrives does not eat the next tap', () => {
    const fx = mount('world');
    pointer('pointerdown', fx.canvas);
    fx.clock.advance(600);
    pointer('pointerup', fx.canvas);
    fx.clock.advance(200);
    pointer('pointerdown', fx.canvas, { pointerId: 2 });
    fx.clock.advance(50);
    pointer('pointerup', fx.canvas, { pointerId: 2 });
    click(fx.canvas);
    expect(fx.presses).toEqual(['B', 'A']);
  });

  it('K-P28/P18/P19: with top "other", or while capturing, a row click or a hover presses nothing', () => {
    const fx = mount('other');
    const l = addList(addFrame(fx), ['a', 'b', 'c'], 0);
    fx.drive = items(l);
    click(item(l, 2));
    hover(item(l, 1), 7, 7);
    expect(fx.presses, 'top "other"').toEqual([]);
    fx.top = 'frame';
    fx.capturing = true;
    hover(item(l, 2), 9, 9);
    expect(fx.presses, 'capturing').toEqual([]);
  });

  it('K-P11: a nav row outside any aria-modal frame is not seeked', () => {
    const fx = mount('frame');
    const loose = addList(fx.layer, ['a', 'b'], 0);
    fx.drive = items(loose);
    click(item(loose, 1));
    expect(fx.presses).toEqual([]);
  });

  it('K-P39/P40: a tab in an inert frame is ignored; a tab in an undriven strip is probed once and undone', () => {
    const fx = mount('frame');
    click(tabAt(addTabs(addFrame(fx, { inert: true }), ['x', 'y', 'z'], 0), 2));
    expect(fx.presses, 'inert frame').toEqual([]);
    const strip = addTabs(addFrame(fx), ['x', 'y', 'z'], 0);
    click(tabAt(strip, 2));
    expect(fx.presses, 'undriven strip: RB probe, LB undo, no second RB').toEqual(['RB', 'LB']);
  });

  it('K-P42/P30: a second finger`s lift does not cancel the long-press, and a re-down leaves one ring', () => {
    const fx = mount('world');
    pointer('pointerdown', fx.canvas);
    pointer('pointerdown', fx.canvas, { pointerId: 9, isPrimary: false });
    pointer('pointerup', fx.canvas, { pointerId: 9, isPrimary: false });
    fx.clock.advance(600);
    expect(fx.presses).toEqual(['B']);
    pointer('pointerup', fx.canvas);
    pointer('pointerdown', fx.canvas, { pointerId: 3 });
    pointer('pointerdown', fx.canvas, { pointerId: 4 });
    expect(rings(fx)).toBe(1);
  });

  it('a long-press timer that fires while now() reads 1 ms early is rescheduled, never lost: exactly one B, and the trailing click is still swallowed', () => {
    // WRONG IMPL KILLED: a timer callback that calls firePress once and gives up when it says
    // "not yet" (real timers fire a little early or the clock reads a little late: the long-press
    // would silently do nothing).
    const fx = mount('world');
    pointer('pointerdown', fx.canvas);
    fx.clock.lag = 1;
    fx.clock.advance(500);
    fx.clock.advance(20);
    expect(fx.presses, 'B once the remaining time has passed').toEqual(['B']);
    expect(rings(fx)).toBe(0);
    pointer('pointerup', fx.canvas);
    click(fx.canvas);
    fx.clock.advance(3_000);
    expect(fx.presses, 'exactly one B; the trailing click swallowed').toEqual(['B']);
  });

  it('a keyboard contextmenu (button 0: the ContextMenu key, Shift+F10) is not prevented and presses nothing', () => {
    // WRONG IMPL KILLED: the keyboard menu key hijacked as a mouse back (B) inside #game-screen.
    const fx = mount('world');
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 });
    fx.canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(fx.presses).toEqual([]);
    contextMenu(fx.canvas);
    expect(fx.presses, 'control: button 2 presses B').toEqual(['B']);
  });

  it('a CSS grid with no rows (inline display:grid, 3 columns, items as direct children) seeks row-major', () => {
    // WRONG IMPL KILLED: a container without [role=row] treated as a list (Down x4 lands elsewhere)
    // or as an unknown grid (the click refused), as boxView's Storage grid is built.
    const fx = mount('frame');
    const g = document.createElement('div');
    g.style.display = 'grid';
    g.style.gridTemplateColumns = 'repeat(3, 1fr)';
    for (const k of ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']) {
      const cell = navItemEl(k, 'x');
      cell.removeAttribute('role');
      g.appendChild(cell);
    }
    addFrame(fx).appendChild(g);
    setActive(navItems(g), 0);
    fx.drive = items(g, 3);
    click(item(g, 4));
    expect(fx.presses).toEqual(['Right', 'Down', 'A']);
    expect(activeIndex(navItems(g))).toBe(4);
  });

  it('a hover miss on a stale container is probed once, not again on every row, until a key is pressed', () => {
    // WRONG IMPL KILLED: a hover that probes and undoes on every row the mouse crosses over a stale
    // base list (the driven cursor flickers Down / Up on each move).
    const fx = mount('frame');
    const body = addFrame(fx);
    const stale = addList(body, ['s0', 's1', 's2', 's3'], 0);
    const driven = addList(body, ['d0', 'd1', 'd2'], 0);
    fx.drive = items(driven);
    hover(item(stale, 2), 10, 10);
    expect(fx.presses, 'one probe and its undo').toEqual(['Down', 'Up']);
    hover(item(stale, 1), 11, 11);
    hover(item(stale, 3), 12, 12);
    expect(fx.presses, 'not repeated across the stale list').toEqual(['Down', 'Up']);
    expect(activeIndex(navItems(driven))).toBe(0);
    fx.source.keyPressed();
    hover(item(stale, 2), 13, 13);
    expect(fx.presses, 'after a key, a new hover may probe again').toEqual([
      'Down',
      'Up',
      'Down',
      'Up',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// uif-5 — UIF5.1 close-then-route (a frame's sheet)
// Every test name below carries its criterion token (`UIF5.N ` with the trailing space) so a gate
// CHECK can filter with `-t "UIF5.N "`.
// ---------------------------------------------------------------------------------------------

describe('PointerSource — uif-5 close-then-route in a frame', () => {
  it('UIF5.1 CLOSE-THEN-SEEK: a click on a base-list row outside an open sheet presses B, then the seek path, then A', () => {
    // WRONG IMPL KILLED: no close (the click is probed against the sheet and undone); the close
    // after the seek; a close that stops the click (no seek); a close that presses B twice.
    const fx = mount('frame');
    const { base, sheet } = frameWithSheet(fx);
    click(item(base, 2));
    expect(fx.presses).toEqual(['B', 'Down', 'Down', 'A']);
    expect(sheet.root.hidden).toBe(true);
    expect(activeIndex(navItems(base))).toBe(2);
  });

  it('UIF5.1 CLOSE-THEN-TAB: a click on a tab outside an open sheet presses B, then LB or RB, never A', () => {
    // WRONG IMPL KILLED: a close step that skips tabs (the tab click is eaten by the sheet's
    // cursor); an A after the tab switch.
    const fx = mount('frame');
    const body = addFrame(fx);
    const strip = addTabs(body, ['bait', 'food', 'medicine'], 0);
    const sheet = addSheet(body, ['x', 'y'], 0);
    sheetAdapter(fx, sheet, { after: { kind: 'tabs', strip } });
    click(tabAt(strip, 2));
    expect(fx.presses).toEqual(['B', 'RB', 'RB']);
    expect(activeIndex(tabEls(strip))).toBe(2);
  });

  it('UIF5.1 TWO-LEVEL: a sheet whose sub-list needs two Bs (and one needing three) is closed fully before the route', () => {
    // WRONG IMPL KILLED: a single B (the sub-list stays open, the seek is probed against it); a
    // depth bound below 3.
    for (const levels of [2, 3]) {
      const fx = mount('frame');
      const { base } = frameWithSheet(fx, { levels });
      click(item(base, 1));
      expect(fx.presses, `${levels} levels`).toEqual([...Array(levels).fill('B'), 'Down', 'A']);
    }
  });

  it('UIF5.1 BOUND: a sheet that never closes gets exactly 3 Bs, then at most the ordinary probe and never an A', () => {
    // WRONG IMPL KILLED: an unbounded `while (sheetShows) press('B')` (never returns); a bound of
    // 2 or 4 or more; an A pressed into the still-open sheet.
    const fx = mount('frame');
    const { base, sheet } = frameWithSheet(fx, { stuck: true });
    click(item(base, 2));
    expect(fx.presses.slice(0, 3)).toEqual(['B', 'B', 'B']);
    expect(fx.presses.filter((b) => b === 'B')).toHaveLength(3);
    expect(fx.presses).not.toContain('A');
    expect([[], ['Down', 'Up']]).toContainEqual(fx.presses.slice(3));
    expect(sheet.root.hidden).toBe(false);
  });

  it('UIF5.1 PADDING-ONLY-B: a click on frame padding or a list container outside the sheet presses only B', () => {
    // WRONG IMPL KILLED: a close that needs a row target; a padding click that routes to an A.
    const fx = mount('frame');
    const { body } = frameWithSheet(fx);
    click(body);
    expect(fx.presses).toEqual(['B']);

    const fx2 = mount('frame');
    const { base } = frameWithSheet(fx2);
    click(base);
    expect(fx2.presses).toEqual(['B']);
  });

  it('UIF5.1 NATIVE-BUTTON-CAPTURE: a native button outside the sheet sees B already pressed when its own click listener runs, and keeps its native click', () => {
    // WRONG IMPL KILLED: a close step in the BUBBLE phase (the button's listener runs first and
    // sees no B); a stopPropagation in the close (the button's own click or a body listener is
    // lost); a preventDefault in the close; a second B or any routing for a native control.
    const fx = mount('frame');
    const { body } = frameWithSheet(fx);
    const btn = document.createElement('button');
    body.appendChild(btn);
    const seen: VButton[][] = [];
    btn.addEventListener('click', () => {
      seen.push([...fx.presses]);
    });
    const above = vi.fn();
    document.body.addEventListener('click', above);
    const e = click(btn);
    expect(seen, 'the button`s own listener ran once, after B').toEqual([['B']]);
    expect(above, 'the event still bubbles past #game-screen').toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
    expect(fx.presses).toEqual(['B']);
  });

  it('UIF5.1 LOWER-OR-COVERED-NOT-CLOSED: a sheet in a lower inert frame, a covered frame or a hidden sheet is not closed; a shown sheet in the top frame is', () => {
    // WRONG IMPL KILLED: a close keyed on any `[data-context-sheet]` in the document (a stale
    // lower frame's sheet eats a B and pops the wrong layer); a close on a sheet already hidden.
    const fx = mount('frame');
    addSheet(addFrame(fx, { inert: true }), ['x', 'y'], 0);
    addSheet(addFrame(fx, { covered: true }), ['x', 'y'], 0);
    const topBody = addFrame(fx);
    const live = addList(topBody, ['a', 'b', 'c'], 0);
    const mine = addSheet(topBody, ['p', 'q'], 0);
    mine.root.hidden = true;
    fx.drive = items(live);
    click(item(live, 2));
    expect(fx.presses, 'no B: the only sheets are lower or hidden').toEqual(['Down', 'Down', 'A']);

    fx.presses.length = 0;
    setActive(navItems(live), 0);
    mine.root.hidden = false;
    sheetAdapter(fx, mine, { after: items(live) });
    click(item(live, 2));
    expect(fx.presses, 'control: the shown top-frame sheet closes first').toEqual([
      'B',
      'Down',
      'Down',
      'A',
    ]);
  });

  it('UIF5.1 CAPTURING-NO-CLOSE: while a remap capture waits, a click outside an open sheet presses nothing and cancels nothing', () => {
    // WRONG IMPL KILLED: a close step that ignores capture (B would be captured as the bound key).
    const fx = mount('frame');
    const { base, body } = frameWithSheet(fx);
    fx.capturing = true;
    click(item(base, 2));
    click(body);
    expect(fx.press).not.toHaveBeenCalled();
    expect(fx.cancelCapture).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// uif-5 — UIF5.2 routing inside a sheet (frame and world)
// ---------------------------------------------------------------------------------------------

describe('PointerSource — uif-5 routing inside a sheet', () => {
  it('UIF5.2 INSIDE-FRAME-SHEET: a click on a row inside an open frame sheet seeks within the sheet with no B; sheet chrome and its native controls do nothing', () => {
    // WRONG IMPL KILLED: a close on any click while a sheet shows (the sheet row click closes the
    // sheet instead of picking); a seek that walks the base list; an active-row click with no
    // probe proof.
    const fx = mount('frame');
    const { sheet } = frameWithSheet(fx);
    click(item(sheet.rows, 2));
    expect(fx.presses).toEqual(['Down', 'Down', 'A']);

    fx.presses.length = 0;
    setActive(navItems(sheet.rows), 0);
    click(item(sheet.rows, 0));
    expect(fx.presses, 'the active row: probe, undo, A').toEqual(['Down', 'Up', 'A']);

    fx.presses.length = 0;
    const btn = document.createElement('button');
    sheet.root.appendChild(btn);
    click(btn);
    click(sheet.root);
    expect(fx.presses, 'no B, no A for the chrome or a native control inside').toEqual([]);
  });

  it('UIF5.2 WORLD-SHEET-SEEK: a click on a row of a world sheet (top "other", no aria-modal root) seeks within it and presses A', () => {
    // WRONG IMPL KILLED: the `other` branch that ignores clicks (today); a world-sheet seek
    // that demands an aria-modal root; an A with no seek.
    const fx = mount('other');
    const sheet = worldSheet(fx, ['s1', 's2', 's3']);
    click(item(sheet.rows, 2));
    expect(fx.presses).toEqual(['Down', 'Down', 'A']);
    expect(activeIndex(navItems(sheet.rows))).toBe(2);
  });

  it('UIF5.2 WORLD-SHEET-SINGLE-ROW: the only row of a world sheet is proven driven by elimination scoped to the sheet, so A comes with no probe', () => {
    // WRONG IMPL KILLED: a one-row world sheet refused for want of an aria-modal root; an
    // elimination that scans the whole screen (a stale list in a frame elsewhere is probed).
    const fx = mount('other');
    addList(addFrame(fx), ['x', 'y'], 0);
    const sheet = worldSheet(fx, ['only']);
    click(item(sheet.rows, 0));
    expect(fx.presses).toEqual(['A']);
  });

  it('UIF5.2 WORLD-SHEET-UNDER-FRAME: a row of a world sheet never seeks while a frame is on top', () => {
    // WRONG IMPL KILLED: a sheet seek that runs before the top() switch for any sheet in the
    // document (a stale world sheet is driven by a click while a frame owns the cursor).
    const fx = mount('frame');
    const live = addList(addFrame(fx), ['a', 'b'], 0);
    const sheet = addSheet(fx.layer, ['s1', 's2', 's3'], 0);
    fx.drive = items(sheet.rows);
    click(item(sheet.rows, 2));
    expect(fx.presses).toEqual([]);
    expect(activeIndex(navItems(live))).toBe(0);
  });

  it('UIF5.2 CHIP-NO-CLOSE: a hint chip clicked while a frame or a world sheet is open presses exactly that chip`s button and no B', () => {
    // WRONG IMPL KILLED: a close step that triggers on a chip (B, then the chip: the chip's own
    // verb is applied to the wrong layer); a chip that is swallowed by the close.
    const fx = mount('frame');
    frameWithSheet(fx);
    click(document.getElementById('chip-start') as HTMLElement);
    click(fx.hintBar.querySelector('[data-button="A"] .mr-chip-verb') as HTMLElement);
    expect(fx.presses).toEqual(['Start', 'A']);

    const world = mount('other');
    worldSheet(world, ['s1', 's2']);
    click(document.getElementById('chip-select') as HTMLElement);
    expect(world.presses).toEqual(['Select']);
  });
});

// ---------------------------------------------------------------------------------------------
// uif-5 — UIF5.3 a world sheet closes only
// ---------------------------------------------------------------------------------------------

describe('PointerSource — uif-5 world sheet closes only', () => {
  it('UIF5.3 CANVAS-CLOSES-ONLY: a canvas click with a world sheet open presses exactly B and no A, even when the top reads "world" after the close', () => {
    // WRONG IMPL KILLED: a close then the canvas's own A (the same sheet reopens); a bubble
    // handler that re-reads top() after the close and presses A at the world base.
    const fx = mount('other');
    const sheet = worldSheet(fx, ['s1', 's2'], { flipToWorld: true });
    click(fx.canvas);
    expect(fx.presses).toEqual(['B']);
    expect(sheet.root.hidden).toBe(true);
    expect(fx.top).toBe('world');

    const still = mount('other');
    worldSheet(still, ['s1', 's2']);
    click(still.canvas);
    expect(still.presses, 'the top staying "other" changes nothing').toEqual(['B']);
  });

  it('UIF5.3 ELSEWHERE-CLOSES-ONLY: a click anywhere else on the screen with a world sheet open presses only B', () => {
    // WRONG IMPL KILLED: a close that needs the canvas as the target; a click on the frame layer
    // or the bare hint bar that routes anything after the close.
    const fx = mount('other');
    const sheet = worldSheet(fx, ['s1', 's2'], { flipToWorld: true });
    for (const el of [fx.app, fx.layer, fx.hintBar, fx.gameScreen]) {
      sheet.root.hidden = false;
      fx.top = 'other';
      sheetAdapter(fx, sheet, {
        after: null,
        onClosed: () => {
          fx.top = 'world';
        },
      });
      fx.presses.length = 0;
      click(el);
      expect(fx.presses, el.id || 'game-screen').toEqual(['B']);
    }
  });

  it('UIF5.3 CHIP-AND-INSIDE: a chip presses only its button and a click inside the sheet routes, both with the world sheet left open', () => {
    // WRONG IMPL KILLED: a world close that triggers on a chip or on the sheet's own rows.
    const fx = mount('other');
    const sheet = worldSheet(fx, ['s1', 's2', 's3']);
    click(document.getElementById('chip-start') as HTMLElement);
    expect(fx.presses).toEqual(['Start']);
    fx.presses.length = 0;
    click(item(sheet.rows, 1));
    expect(fx.presses).toEqual(['Down', 'A']);
    expect(sheet.root.hidden).toBe(false);
  });

  it('UIF5.3 STUCK-WORLD-SHEET: a world sheet that never closes gets exactly 3 Bs from a canvas click, and no A', () => {
    // WRONG IMPL KILLED: an unbounded B loop on a world sheet; a canvas A once the bound is hit.
    const fx = mount('other');
    worldSheet(fx, ['s1', 's2'], { stuck: true });
    click(fx.canvas);
    expect(fx.presses).toEqual(['B', 'B', 'B']);
  });
});

// ---------------------------------------------------------------------------------------------
// uif-5 — UIF5.4 the wheel
// ---------------------------------------------------------------------------------------------

function wheelFrame(top: PointerTop = 'frame'): { fx: Fx; l: HTMLElement; body: HTMLElement } {
  const fx = mount(top);
  const body = addFrame(fx);
  const l = addList(body, ['a', 'b', 'c', 'd', 'e'], 0);
  fx.drive = items(l);
  return { fx, l, body };
}

describe('PointerSource — uif-5 wheel', () => {
  it('UIF5.4 WHEEL-PIXEL-NOTCHES: a wheel over a top-frame row is prevented and presses Down per 100 px notch, Up for a negative delta', () => {
    // WRONG IMPL KILLED: no wheel listener (today); a listener that presses without preventing
    // (the page scrolls too); a press per event instead of per notch; Up and Down swapped.
    const { fx, l } = wheelFrame();
    const e1 = wheel(item(l, 2), 100);
    expect(e1.defaultPrevented).toBe(true);
    expect(fx.presses).toEqual(['Down']);
    const e3 = wheel(item(l, 2), 300);
    expect(e3.defaultPrevented).toBe(true);
    expect(fx.presses).toEqual(['Down', 'Down', 'Down', 'Down']);
    wheel(item(l, 2), -100);
    expect(fx.presses).toEqual(['Down', 'Down', 'Down', 'Down', 'Up']);
    const onList = wheel(l, 100);
    expect(onList.defaultPrevented, 'the container itself counts as nav rows').toBe(true);
    expect(fx.presses).toHaveLength(6);
  });

  it('UIF5.4 WHEEL-LINE-PAGE-MODES: deltaMode 1 is 3 lines per notch and deltaMode 2 is 1 page per notch', () => {
    // WRONG IMPL KILLED: a line delta read as pixels (3 lines = 0 notches); a page delta read as
    // pixels or as lines; the sign lost in either mode.
    const { fx, l } = wheelFrame();
    const row = item(l, 1);
    wheel(row, 3, 1);
    expect(fx.presses, '3 lines').toEqual(['Down']);
    wheel(row, 9, 1);
    expect(fx.presses, '9 lines = 3 notches').toEqual(['Down', 'Down', 'Down', 'Down']);
    wheel(row, -3, 1);
    expect(fx.presses.slice(4)).toEqual(['Up']);
    fx.presses.length = 0;
    wheel(row, 1, 2);
    wheel(row, 2, 2);
    wheel(row, -1, 2);
    expect(fx.presses, 'pages').toEqual(['Down', 'Down', 'Down', 'Up']);
  });

  it('UIF5.4 WHEEL-ACCUMULATE: sub-notch pixel deltas accumulate across events, a direction reversal drops the remainder, a key press or another container resets it', () => {
    // WRONG IMPL KILLED: no accumulator (every 40 px event is a Down, or none ever is); an
    // accumulator that nets a reversal (60 - 60 - 60 never presses); one that survives a key
    // press or a move to another list.
    const a = wheelFrame();
    const rowA = item(a.l, 1);
    for (const dy of [40, 40]) expect(wheel(rowA, dy).defaultPrevented).toBe(true);
    expect(a.fx.presses, 'two 40 px events: no notch yet').toEqual([]);
    wheel(rowA, 40);
    expect(a.fx.presses, 'the third crosses 100').toEqual(['Down']);
    wheel(rowA, 80);
    expect(a.fx.presses, 'the carried 20 + 80 is another notch').toEqual(['Down', 'Down']);

    const r = wheelFrame();
    const rowR = item(r.l, 1);
    wheel(rowR, 60);
    wheel(rowR, -60);
    wheel(rowR, -60);
    expect(r.fx.presses, 'the reversal dropped the +60').toEqual(['Up']);

    const k = wheelFrame();
    wheel(item(k.l, 1), 60);
    k.fx.source.keyPressed();
    wheel(item(k.l, 1), 60);
    expect(k.fx.presses, 'a key press reset the remainder').toEqual([]);
    wheel(item(k.l, 1), 60);
    expect(k.fx.presses, 'control: 60 + 60 without a reset').toEqual(['Down']);

    const c = wheelFrame();
    const other = addList(c.body, ['x', 'y', 'z'], 0);
    wheel(item(c.l, 1), 60);
    wheel(item(other, 1), 60);
    expect(c.fx.presses, 'a different container started a fresh remainder').toEqual([]);
  });

  it('UIF5.4 WHEEL-PROSE-NATIVE: a wheel over a frame region with no nav rows is not prevented and presses nothing', () => {
    // WRONG IMPL KILLED: a wheel hijacked over Help's prose or a Journal page (it could not be
    // scrolled any more); a listener that presses for any wheel in the top frame.
    const { fx, body } = wheelFrame();
    const prose = document.createElement('p');
    prose.textContent = 'How to play';
    body.appendChild(prose);
    const e = wheel(prose, 300);
    expect(e.defaultPrevented).toBe(false);
    expect(fx.presses).toEqual([]);
  });

  it('UIF5.4 WHEEL-NOT-HANDLED: at the bare world, with top "other", while capturing, or while typing, a wheel is not prevented and presses nothing', () => {
    // WRONG IMPL KILLED: a wheel on the canvas or a stale frame list at the world base; a wheel
    // that steals the page scroll from a text field; a wheel pressing under a remap capture.
    const { fx, l, body } = wheelFrame();
    const row = item(l, 1);
    fx.top = 'world';
    expect(wheel(row, 100).defaultPrevented, 'world').toBe(false);
    expect(wheel(fx.canvas, 100).defaultPrevented, 'canvas at the world').toBe(false);
    fx.top = 'other';
    expect(wheel(row, 100).defaultPrevented, 'other').toBe(false);
    fx.top = 'frame';
    fx.capturing = true;
    expect(wheel(row, 100).defaultPrevented, 'capturing').toBe(false);
    fx.capturing = false;
    expect(fx.presses).toEqual([]);

    const field = document.createElement('input');
    body.appendChild(field);
    expect(wheel(field, 100).defaultPrevented, 'the field itself').toBe(false);
    field.focus();
    expect(document.activeElement).toBe(field);
    expect(wheel(row, 100).defaultPrevented, 'focus in a field').toBe(false);
    const area = document.createElement('textarea');
    item(l, 2).appendChild(area);
    field.blur();
    expect(wheel(area, 100).defaultPrevented, 'a textarea inside a row').toBe(false);
    expect(fx.presses).toEqual([]);

    field.blur();
    expect(
      wheel(row, 100).defaultPrevented,
      'control: the same row wheels once nothing types',
    ).toBe(true);
    expect(fx.presses).toEqual(['Down']);
  });

  it('UIF5.4 WHEEL-NON-PASSIVE: the wheel listener is registered with { passive: false } and its preventDefault takes effect', () => {
    // WRONG IMPL KILLED: a wheel listener left passive (a browser ignores preventDefault and
    // scrolls the page while the cursor also moves); a default-options registration.
    const spy = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const { fx, l } = wheelFrame();
    const regs = (spy.mock.calls as unknown[][]).filter((c) => c[0] === 'wheel');
    expect(regs, 'one wheel registration').toHaveLength(1);
    expect(regs[0]?.[2]).toEqual(expect.objectContaining({ passive: false }));
    expect(wheel(item(l, 1), 100).defaultPrevented).toBe(true);
    expect(fx.presses).toEqual(['Down']);
  });
});

describe('wheelSteps (pure)', () => {
  const norm = (r: { steps: number; acc: number }): { steps: number; acc: number } => ({
    steps: r.steps + 0,
    acc: r.acc + 0,
  });

  it('UIF5.4 WHEELSTEPS-MODES: a notch is 100 px, 3 lines or 1 page; the sign is the direction; sub-notch deltas carry', () => {
    // WRONG IMPL KILLED: a notch of 120 or 53 px; lines read as pixels; a page read as lines; a
    // truncation that loses the carried remainder (40 + 40 + 40 never steps).
    expect(norm(wheelSteps(0, 100, 0)).steps).toBe(1);
    expect(norm(wheelSteps(0, -100, 0)).steps).toBe(-1);
    expect(norm(wheelSteps(0, 300, 0)).steps).toBe(3);
    expect(norm(wheelSteps(0, 99, 0)).steps).toBe(0);
    expect(norm(wheelSteps(0, 3, 1)).steps).toBe(1);
    expect(norm(wheelSteps(0, 6, 1)).steps).toBe(2);
    expect(norm(wheelSteps(0, -3, 1)).steps).toBe(-1);
    expect(norm(wheelSteps(0, 1, 2)).steps).toBe(1);
    expect(norm(wheelSteps(0, 2, 2)).steps).toBe(2);
    expect(norm(wheelSteps(0, -1, 2)).steps).toBe(-1);
    expect(norm(wheelSteps(0, 0, 0)).steps).toBe(0);

    const one = wheelSteps(0, 40, 0);
    const two = wheelSteps(one.acc, 40, 0);
    const three = wheelSteps(two.acc, 40, 0);
    expect([one.steps, two.steps, three.steps].map((n) => n + 0)).toEqual([0, 0, 1]);
    expect(wheelSteps(three.acc, 80, 0).steps, 'the carried 20 + 80').toBe(1);
  });

  it('UIF5.4 WHEELSTEPS-REVERSAL-CAP-NONFINITE: a reversal drops the remainder; a huge delta is capped at 5 and its remainder dropped; a non-finite delta steps 0 and resets', () => {
    // WRONG IMPL KILLED: a reversal that nets (60 - 60 - 60 = 0 steps); an uncapped steps value
    // (thousands of presses from one event); a capped call that keeps its remainder; a NaN or
    // Infinity that poisons the accumulator or steps.
    const a = wheelSteps(0, 60, 0);
    const b = wheelSteps(a.acc, -60, 0);
    const c = wheelSteps(b.acc, -60, 0);
    expect([a.steps, b.steps, c.steps].map((n) => n + 0)).toEqual([0, 0, -1]);

    const big = wheelSteps(0, 100_000, 0);
    expect(big.steps).toBe(5);
    expect(wheelSteps(big.acc, 100, 0).steps, 'the capped remainder is gone').toBe(1);
    expect(wheelSteps(0, -100_000, 0).steps).toBe(-5);
    expect(wheelSteps(0, 1_000_000, 2).steps).toBe(5);

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = wheelSteps(60, bad, 0);
      expect(r.steps + 0, String(bad)).toBe(0);
      expect(wheelSteps(r.acc, 40, 0).steps + 0, 'reset: 40 alone is no notch').toBe(0);
    }
  });

  it('UIF5.4 WHEELSTEPS-PROPERTY-TOTAL: over same-sign pixel deltas the steps sum to trunc(total / 100) while uncapped, and no call exceeds 5', () => {
    // WRONG IMPL KILLED: rounding instead of truncation; an accumulator that drops or doubles a
    // remainder; per-call steps above the cap.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 99 }), { maxLength: 40 }),
        fc.constantFrom(1, -1),
        (deltas, sign) => {
          let acc = 0;
          let total = 0;
          let sum = 0;
          for (const d of deltas) {
            const r = wheelSteps(acc, sign * d, 0);
            expect(Math.abs(r.steps)).toBeLessThanOrEqual(5);
            expect(Number.isInteger(r.steps)).toBe(true);
            acc = r.acc;
            total += r.steps;
            sum += d;
          }
          expect(total + 0).toBe(sign * Math.floor(sum / 100) + 0);
        },
      ),
    );
  });

  it('UIF5.4 WHEELSTEPS-PROPERTY-BOUND: for any finite delta in any mode a call steps an integer within +-5', () => {
    // WRONG IMPL KILLED: a missing cap; fractional steps; a mode outside 0..2 crashing.
    fc.assert(
      fc.property(
        fc.double({ min: -1e7, max: 1e7, noNaN: true }),
        fc.constantFrom(0, 1, 2),
        fc.double({ min: -500, max: 500, noNaN: true }),
        (dy, mode, acc) => {
          const r = wheelSteps(acc, dy, mode);
          expect(Number.isInteger(r.steps)).toBe(true);
          expect(Math.abs(r.steps)).toBeLessThanOrEqual(5);
          expect(Number.isFinite(r.acc)).toBe(true);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// uif-5 — UIF5.5 only deps.press; existing right-click and long-press stay
// ---------------------------------------------------------------------------------------------

describe('PointerSource — uif-5 side effects', () => {
  it('UIF5.5 ONLY-PRESS: the close and wheel paths call deps.press alone, with one argument, and dispatch no keyboard event', () => {
    // WRONG IMPL KILLED: a close that synthesizes an Escape keydown instead of pressing B; a
    // wheel that dispatches ArrowDown events; a close or wheel that calls choice, shop or
    // cancelCapture; a press carrying the event or coordinates.
    const keydown = vi.fn();
    window.addEventListener('keydown', keydown);
    document.addEventListener('keydown', keydown);
    try {
      const fx = mount('frame');
      const { base } = frameWithSheet(fx);
      click(item(base, 2));
      wheel(item(base, 1), 200);

      const world = mount('other');
      worldSheet(world, ['s1', 's2'], { flipToWorld: true });
      click(world.canvas);

      expect(fx.presses).toEqual(['B', 'Down', 'Down', 'A', 'Down', 'Down']);
      expect(world.presses).toEqual(['B']);
      for (const f of [fx, world]) {
        for (const call of pressCalls(f)) expect(call).toHaveLength(1);
        for (const b of f.presses) expect(VBUTTONS).toContain(b);
        expect(f.choice).not.toHaveBeenCalled();
        expect(f.shop).not.toHaveBeenCalled();
        expect(f.cancelCapture).not.toHaveBeenCalled();
      }
      expect(keydown, 'no synthetic keyboard event').not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', keydown);
      document.removeEventListener('keydown', keydown);
    }
  });

  it('UIF5.5 RIGHTCLICK-LONGPRESS-ONE-B: with an open sheet a right-click presses exactly one B and a completed long-press exactly one B (its trailing click is swallowed, no close)', () => {
    // WRONG IMPL KILLED: a contextmenu path that also runs the click close (two Bs); a close
    // step that runs before the long-press swallow (the trailing click presses more Bs into a
    // sheet that is still open).
    const fx = mount('frame');
    const { base } = frameWithSheet(fx);
    contextMenu(item(base, 1));
    expect(fx.presses).toEqual(['B']);

    const lp = mount('frame');
    const { base: lpBase } = frameWithSheet(lp, { stuck: true });
    pointer('pointerdown', item(lpBase, 1));
    lp.clock.advance(500);
    pointer('pointerup', item(lpBase, 1));
    expect(lp.presses).toEqual(['B']);
    click(item(lpBase, 1));
    expect(lp.presses, 'the trailing click is swallowed before any close').toEqual(['B']);
  });
});

// ---------------------------------------------------------------------------------------------
// uif-5 round 2 — review / red-team gaps (decisions D1 to D5, gaps G1 to G7)
// ---------------------------------------------------------------------------------------------

/** A wheel event with a full init (modifier keys, horizontal delta). */
function wheelWith(el: Element, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  // happy-dom gap: its WheelEvent extends UIEvent, not MouseEvent, so the init drops the modifier keys.
  for (const k of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) {
    if (typeof (e as unknown as Record<string, unknown>)[k] !== 'boolean') {
      Object.defineProperty(e, k, { value: init[k] ?? false });
    }
  }
  el.dispatchEvent(e);
  return e;
}

describe('PointerSource — uif-5 round 2 close and routing', () => {
  it('UIF5.1 CHOICE-OUTSIDE-SHEET: with a frame sheet open, a dialogue choice button outside it presses B and then sends choice(idx) once', () => {
    // WRONG IMPL KILLED: a close step that skips dialogue buttons (the sheet stays over the
    // dialogue); a close that eats the click (choice never sent); a choice sent twice.
    const fx = mount('frame');
    const { body } = frameWithSheet(fx);
    const pick = document.createElement('button');
    pick.dataset.choiceIdx = '2';
    body.appendChild(pick);
    click(pick);
    expect(fx.presses).toEqual(['B']);
    expect(fx.choice.mock.calls).toEqual([[2]]);
    expect(fx.shop).not.toHaveBeenCalled();
  });

  it('UIF5.1 POINTER-OWN-OUTSIDE-SHEET: with a frame sheet open, a click on a [data-pointer-own] row outside it presses B and nothing else', () => {
    // WRONG IMPL KILLED: a close step that skips owned rows; a close followed by a seek or an A
    // for a row the view owns (double dispatch with the owner's own listener).
    const fx = mount('frame');
    const { body } = frameWithSheet(fx);
    const own = document.createElement('div');
    own.setAttribute('data-pointer-own', '');
    body.appendChild(own);
    const owned = addList(own, ['o1', 'o2', 'o3'], 0);
    click(item(owned, 2));
    expect(fx.presses).toEqual(['B']);
    expect(fx.choice).not.toHaveBeenCalled();
    expect(fx.shop).not.toHaveBeenCalled();
  });

  it('UIF5.1 SHEET-OUTSIDE-MODAL-NOT-CLOSED: a shown sheet not under any aria-modal root while top is "frame" is not closed by a click in the frame', () => {
    // WRONG IMPL KILLED: a frame-top close keyed on any shown sheet in the screen (a stale world
    // sheet node would eat a B and pop the frame's own state).
    const fx = mount('frame');
    const base = addList(addFrame(fx), ['a', 'b', 'c'], 0);
    const stray = addSheet(fx.layer, ['s1', 's2'], 0);
    fx.drive = items(base);
    fx.onPress = (b) => {
      if (b === 'B') stray.root.hidden = true;
    };
    click(item(base, 2));
    expect(fx.presses).toEqual(['Down', 'Down', 'A']);
  });
});

describe('PointerSource — uif-5 round 2 world sheet', () => {
  it('UIF5.3 TOP-FLIPS-ONE-B: when top() changes on the first B but the sheet stays painted, the close presses exactly one B and no A', () => {
    // WRONG IMPL KILLED: a B loop that watches only the DOM (repaint lags: it presses up to 3
    // Bs into whatever the new top is); an A after the close at the new world top.
    const fx = mount('other');
    const sheet = addSheet(fx.layer, ['s1', 's2'], 0);
    fx.drive = items(sheet.rows);
    fx.onPress = (b) => {
      if (b === 'B') fx.top = 'world';
    };
    click(fx.canvas);
    expect(fx.presses).toEqual(['B']);
    expect(sheet.root.hidden, 'the DOM never repainted').toBe(false);
  });

  it('UIF5.3 SHEET-UNDER-MODAL-NOT-WORLD: with top "other", a sheet under an aria-modal root is not a world sheet, so a click outside it presses nothing', () => {
    // WRONG IMPL KILLED: a world-sheet detector that accepts any shown sheet (a frame's sheet
    // while a battle or text entry is on top gets a B pressed into the wrong layer).
    const fx = mount('other');
    addSheet(addFrame(fx), ['s1', 's2'], 0);
    click(fx.canvas);
    click(fx.layer);
    click(fx.app);
    expect(fx.presses).toEqual([]);
  });

  it('UIF5.3 NATIVE-OUTSIDE-WORLD-SHEET: a native button or link outside an open world sheet keeps its own click and the bubble, and only B is pressed', () => {
    // WRONG IMPL KILLED: a world close done by stopPropagation or preventDefault (the button's
    // own listener or a listener above #game-screen never hears the click); an A after the close.
    for (const tag of ['button', 'a'] as const) {
      const fx = mount('other');
      worldSheet(fx, ['s1', 's2']);
      const native = document.createElement(tag);
      if (native instanceof HTMLAnchorElement) native.href = '#x';
      fx.layer.appendChild(native);
      const own = vi.fn();
      const above = vi.fn();
      native.addEventListener('click', own);
      document.body.addEventListener('click', above);
      const e = click(native);
      expect(own, `${tag} own listener`).toHaveBeenCalledTimes(1);
      expect(above, `${tag} bubble`).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented, tag).toBe(false);
      expect(fx.presses, tag).toEqual(['B']);
      document.body.removeEventListener('click', above);
    }
  });
});

describe('PointerSource — uif-5 round 2 wheel', () => {
  it('UIF5.4 WHEEL-MODIFIER-NOT-HANDLED: a wheel with ctrlKey or metaKey (zoom, pinch) over a row is not prevented and presses nothing', () => {
    // WRONG IMPL KILLED: a wheel handler that hijacks browser zoom (ctrl+wheel moves the cursor and
    // blocks the zoom); one that checks only ctrl, not meta; control: the plain wheel presses.
    const { fx, l } = wheelFrame();
    const row = item(l, 1);
    expect(wheelWith(row, { deltaY: 100, ctrlKey: true }).defaultPrevented, 'ctrl').toBe(false);
    expect(wheelWith(row, { deltaY: 100, metaKey: true }).defaultPrevented, 'meta').toBe(false);
    expect(fx.presses).toEqual([]);
    expect(wheelWith(row, { deltaY: 100 }).defaultPrevented, 'control').toBe(true);
    expect(fx.presses).toEqual(['Down']);
  });

  it('UIF5.4 WHEEL-NO-VERTICAL-NOT-HANDLED: a horizontal-only (deltaY 0) or non-finite deltaY wheel over a row is not prevented and presses nothing', () => {
    // WRONG IMPL KILLED: a horizontal trackpad swipe that is prevented (sideways scroll lost, no
    // press); a NaN or Infinity delta that is prevented or presses.
    const { fx, l } = wheelFrame();
    const row = item(l, 1);
    expect(wheelWith(row, { deltaX: 100, deltaY: 0 }).defaultPrevented, 'horizontal').toBe(false);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(wheelWith(row, { deltaY: bad }).defaultPrevented, String(bad)).toBe(false);
    }
    expect(fx.presses).toEqual([]);
  });

  it('UIF5.4 WHEEL-SHEET-OWNS: while a sheet is open in the top frame, a wheel over the stale base list is not prevented and presses nothing; once the sheet is closed the base list wheels again', () => {
    // WRONG IMPL KILLED: a wheel over the stale base list that presses into the sheet's cursor
    // (the list under the sheet scrolls the sheet); a wheel that ignores the sheet.
    const fx = mount('frame');
    const { base, sheet } = frameWithSheet(fx);
    expect(wheel(item(base, 2), 100).defaultPrevented, 'base row').toBe(false);
    expect(wheel(base, 100).defaultPrevented, 'base container').toBe(false);
    expect(fx.presses).toEqual([]);
    sheet.root.hidden = true;
    fx.drive = items(base);
    expect(wheel(item(base, 2), 100).defaultPrevented, 'control: sheet closed').toBe(true);
    expect(fx.presses).toEqual(['Down']);
  });

  it('UIF5.4 WHEEL-INSIDE-SHEET: a wheel over a row (or the rows container) inside an open frame sheet is prevented and presses Down', () => {
    // WRONG IMPL KILLED: a sheet excluded from the wheel (the sheet's own list cannot be wheeled);
    // a wheel that is pressed but not prevented.
    const fx = mount('frame');
    const { sheet } = frameWithSheet(fx);
    const e = wheel(item(sheet.rows, 1), 100);
    expect(e.defaultPrevented).toBe(true);
    expect(fx.presses).toEqual(['Down']);
    expect(wheel(sheet.rows, 100).defaultPrevented).toBe(true);
    expect(fx.presses).toEqual(['Down', 'Down']);
  });

  it('UIF5.4 WHEEL-LOWER-FRAMES: a wheel over rows (or the container) of a lower inert frame or a covered frame is not prevented and presses nothing', () => {
    // WRONG IMPL KILLED: a wheel that finds the nav container without the top-frame test (a wheel
    // over a stale lower menu moves the top frame's cursor and blocks the page).
    const fx = mount('frame');
    const lower = addList(addFrame(fx, { inert: true }), ['a', 'b', 'c'], 0);
    const covered = addList(addFrame(fx, { covered: true }), ['m', 'n', 'o'], 0);
    const live = addList(addFrame(fx), ['x', 'y', 'z'], 0);
    fx.drive = items(live);
    for (const [name, list] of [
      ['inert', lower],
      ['covered', covered],
    ] as const) {
      expect(wheel(item(list, 1), 100).defaultPrevented, `${name} row`).toBe(false);
      expect(wheel(list, 100).defaultPrevented, `${name} container`).toBe(false);
    }
    expect(fx.presses).toEqual([]);
    expect(wheel(item(live, 1), 100).defaultPrevented, 'control: the top frame').toBe(true);
    expect(fx.presses).toEqual(['Down']);
  });

  it('UIF5.4 WHEEL-FOCUS-SELECT-EDITABLE: focus on a <select> or a [contenteditable] element makes a wheel over a row not prevented, with no press', () => {
    // WRONG IMPL KILLED: a typing guard that knows only input and textarea (a focused select or
    // rich-text field has its wheel stolen).
    const { fx, l, body } = wheelFrame();
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.tabIndex = 0;
    body.append(select, editable);
    for (const el of [select, editable]) {
      el.focus();
      expect(document.activeElement, 'precondition: focused').toBe(el);
      expect(wheel(item(l, 1), 100).defaultPrevented, el.tagName).toBe(false);
    }
    expect(fx.presses).toEqual([]);
  });

  it('UIF5.4 WHEEL-REGISTRATION-BUBBLE: the wheel listener has no capture and does not stop the event, so a listener above #game-screen still sees it', () => {
    // WRONG IMPL KILLED: a capture-phase wheel listener (it runs before the views' own); a
    // stopPropagation in the handler (an outer scroll or analytics listener goes deaf).
    const spy = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const { l } = wheelFrame();
    const regs = (spy.mock.calls as unknown[][]).filter((c) => c[0] === 'wheel');
    expect(regs).toHaveLength(1);
    const opts = regs[0]?.[2] as { passive?: unknown; capture?: unknown };
    expect(opts.passive).toBe(false);
    expect(opts.capture ?? false).toBe(false);
    const above = vi.fn();
    document.body.addEventListener('wheel', above);
    wheel(item(l, 1), 100);
    expect(above).toHaveBeenCalledTimes(1);
  });

  it('UIF5.4 WHEEL-REMAINDER-EXPIRES: a carried remainder expires after 500 ms without a wheel event; within 100 ms it still carries', () => {
    // WRONG IMPL KILLED: an accumulator that never expires (a stale 60 px from a minute ago turns
    // the next small flick into a press); one that expires too eagerly (kills smooth scrolling).
    const stale = wheelFrame();
    wheel(item(stale.l, 1), 60);
    stale.fx.clock.advance(600);
    wheel(item(stale.l, 1), 60);
    expect(stale.fx.presses, 'expired: 60 alone is no notch').toEqual([]);

    const live = wheelFrame();
    wheel(item(live.l, 1), 60);
    live.fx.clock.advance(100);
    wheel(item(live.l, 1), 60);
    expect(live.fx.presses, 'control: 60 + 60 within 100 ms').toEqual(['Down']);
  });
});

describe('wheelSteps (pure) round 2', () => {
  it('UIF5.4 WHEELSTEPS-UNKNOWN-MODE: a deltaMode other than 0, 1 or 2 is read as pixels', () => {
    // WRONG IMPL KILLED: an unknown mode read as pages or lines (100 would be 100 or 33 notches,
    // capped to 5) or as 0 steps.
    for (const mode of [3, -1, 99]) {
      expect(wheelSteps(0, 100, mode).steps, `mode ${mode}`).toBe(1);
      expect(wheelSteps(0, 40, mode).steps, `mode ${mode} sub-notch`).toBe(0);
    }
  });

  it('UIF5.4 WHEELSTEPS-NEVER-NEGATIVE-ZERO: steps is never -0', () => {
    // WRONG IMPL KILLED: Math.trunc(-0.4) leaking -0 as steps (Object.is distinguishes it).
    expect(Object.is(wheelSteps(0, -40, 0).steps, -0)).toBe(false);
    expect(Object.is(wheelSteps(0, 0, 0).steps, -0)).toBe(false);
    expect(Object.is(wheelSteps(-30, 10, 0).steps, -0)).toBe(false);
    expect(Object.is(wheelSteps(0, -1, 1).steps, -0)).toBe(false);
  });

  it('UIF5.4 WHEELSTEPS-NONFINITE-RESETS: a non-finite delta steps 0 and resets the accumulator to 0', () => {
    // WRONG IMPL KILLED: a NaN that is ignored but keeps the old remainder (250 px leaves 50, and
    // a following 60 would cross a notch only with it).
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const first = wheelSteps(0, 250, 0);
      const mid = wheelSteps(first.acc, bad, 0);
      expect(mid.steps + 0, String(bad)).toBe(0);
      expect(wheelSteps(mid.acc, 60, 0).steps, `${bad} then 60`).toBe(0);
    }
  });

  it('UIF5.4 WHEELSTEPS-CAP-DROPS-ALL: after a capped call no remainder survives, so a following 99 px steps 0', () => {
    // WRONG IMPL KILLED: a cap that keeps a partial remainder (e.g. acc mod 100 of a huge delta)
    // so a small flick right after a big one presses again.
    for (const dy of [1050, 100_000, 123_457]) {
      const big = wheelSteps(0, dy, 0);
      expect(big.steps, `${dy}`).toBe(5);
      expect(wheelSteps(big.acc, 99, 0).steps, `${dy} then 99`).toBe(0);
    }
  });
});
