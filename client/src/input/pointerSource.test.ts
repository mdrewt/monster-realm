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
import type { VButton } from './buttons';
import {
  navPath,
  type PointerClock,
  type PointerDeps,
  PointerSource,
  type PointerTop,
  tabPath,
} from './pointerSource';

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
  } as unknown as Fx;
  const press = vi.fn((button: VButton) => {
    presses.push(button);
    if (fx.budget !== null) {
      if (fx.budget <= 0) return;
      fx.budget -= 1;
    }
    if (fx.drive !== null) drive(fx.drive, button);
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
