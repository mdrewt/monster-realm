// input/pointerSource.ts — the pointer and touch source: ONE dispatcher on #game-screen (ctl-15,
// CTL15.1 to CTL15.5). Like the keyboard source it only presses virtual buttons, so the router and
// every screen adapter decide what a click means; game logic never sees a coordinate. It sends no
// command of its own: a dialogue choice or Shop button is a nav row like any other.
//
// A click on a row of the top frame (once any open sheet is closed, below) is a SEEK: the D-pad
// presses that walk that container's cursor to the row, then A. The DOM cannot say which container
// the frame's adapter drives (a base list stays visible, with a stale cursor, under its sheet or
// picker), so the first press is a probe: if the clicked container's cursor did not move as
// planned, the press is undone with its inverse (fresh nav steps wrap, so one step is always
// invertible) and nothing is activated. A click on the row that is already active is proven the
// same way, or by elimination when it is the container's only row; a tie between single-row
// containers does nothing rather than activate the wrong one.
//
// Right-click and a touch long-press (500 ms within 10 px, with a fill ring) press B, or cancel a
// remap capture. A mouse moving to new coordinates over a row makes it active (never A) and shows
// the hover state until the next key press (`keyPressed`).
//
// An open context sheet (uif-5, UIF5.1-UIF5.3) never blocks a click elsewhere: in the CAPTURE
// phase, before a native control's own handler, B is pressed until no sheet shows, then the same
// event routes as if no sheet had been open. A world sheet's close is close-only: routing the click
// would press A at the bare world and reopen the same sheet. A click inside the sheet routes to its
// row. A wheel over the top frame's nav rows (only the sheet's, while one is open) presses Up or
// Down once per notch (UIF5.4); anywhere else, and for a zoom or horizontal wheel, the browser
// keeps its own.
import type { VButton } from './buttons';
import { VBUTTONS } from './buttons';
import {
  endPress,
  firePress,
  LONG_PRESS_MS,
  movePress,
  type PressTrack,
  startPress,
} from './longPress';

export type PointerTop = 'world' | 'frame' | 'other';

/** How a seek's walk ended. */
type Walk = 'arrived' | 'undone' | 'stopped';

export interface PointerDeps {
  /** The bare world base (no sheet open), a screen or prompt frame on top, or anything else. */
  top(): PointerTop;
  /** One press (down, then up) of `button` through the router. */
  press(button: VButton): void;
  /** Whether Options › Controls waits for a key. */
  capturing(): boolean;
  cancelCapture(): void;
}

export interface PointerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(h: number): void;
}

const BROWSER_CLOCK: PointerClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h),
};

/** How long after a touch a `contextmenu` is the touch's own, and a long-press's click may lag. */
const TOUCH_GRACE_MS = 1_000;
const HOVER_CLASS = 'mr-pointer-hover';
const NATIVE = 'button, input, select, textarea, a, label, [contenteditable]';
const EDITABLE = 'input, textarea, select, [contenteditable]';
const SHEET = '[data-context-sheet]';
/** How many Bs a click may press closing a sheet: a sub-list in the one sheet root needs two. */
const MAX_CLOSE_DEPTH = 3;

/** One wheel notch in accumulator units: 100 px, 3 lines or 1 page (exact for integer deltas). */
const NOTCH = 300;
const UNITS_PER: Readonly<Record<number, number>> = { 0: 3, 1: 100, 2: 300 };
/** A pathological delta presses at most this many times, its remainder dropped. */
const MAX_WHEEL_STEPS = 5;
/** A wheel remainder older than this is dropped: a stale part-notch never fires a later press. */
const WHEEL_IDLE_MS = 500;

/** The Up (negative) or Down presses one wheel event is worth, given the carried remainder `acc`:
 *  a notch is 100 px (deltaMode 0), 3 lines (1) or 1 page (2). A direction reversal drops the
 *  remainder first; a capped or non-finite event resets it. */
export function wheelSteps(
  acc: number,
  deltaY: number,
  deltaMode: number,
): { steps: number; acc: number } {
  const units = deltaY * (UNITS_PER[deltaMode] ?? UNITS_PER[0]);
  if (!Number.isFinite(units) || !Number.isFinite(acc)) return { steps: 0, acc: 0 };
  const total = (Math.sign(units) * Math.sign(acc) < 0 ? 0 : acc) + units;
  const steps = Math.trunc(total / NOTCH);
  if (Math.abs(steps) > MAX_WHEEL_STEPS)
    return { steps: Math.sign(steps) * MAX_WHEEL_STEPS, acc: 0 };
  return { steps: steps + 0, acc: total - steps * NOTCH };
}

const INVERSE: Readonly<Partial<Record<VButton, VButton>>> = {
  Up: 'Down',
  Down: 'Up',
  Left: 'Right',
  Right: 'Left',
  LB: 'RB',
  RB: 'LB',
};

const STEP: Readonly<Partial<Record<VButton, (cols: number) => number>>> = {
  Up: (cols) => -cols,
  Down: (cols) => cols,
  Left: () => -1,
  Right: () => 1,
  LB: () => -1,
  RB: () => 1,
};

const repeat = (button: VButton, n: number): VButton[] =>
  Array<VButton>(Math.max(0, n)).fill(button);

/** The D-pad presses moving a nav cursor from `from` to `to` without wrapping (ui/nav.ts): a list
 *  is Up/Down; a grid is row-major, horizontal first out of a full row and vertical first out of
 *  the short last row (whose missing columns a vertical move from a full row could not reach). */
export function navPath(count: number, cols: number | null, from: number, to: number): VButton[] {
  if (cols === null) return from <= to ? repeat('Down', to - from) : repeat('Up', from - to);
  const dr = Math.floor(to / cols) - Math.floor(from / cols);
  const dc = (to % cols) - (from % cols);
  const vertical = dr >= 0 ? repeat('Down', dr) : repeat('Up', -dr);
  const horizontal = dc >= 0 ? repeat('Right', dc) : repeat('Left', -dc);
  const fullRow = Math.floor(from / cols) * cols + cols <= count;
  return fullRow ? [...horizontal, ...vertical] : [...vertical, ...horizontal];
}

/** The LB/RB presses switching from tab `from` to tab `to`. */
export const tabPath = (from: number, to: number): VButton[] =>
  from <= to ? repeat('RB', to - from) : repeat('LB', from - to);

const isVButton = (s: string | undefined): s is VButton =>
  s !== undefined && (VBUTTONS as readonly string[]).includes(s);

/** The hint-bar chip under `el`, if any. */
const chipAt = (el: Element): HTMLElement | null => {
  const chip = el.closest<HTMLElement>('[data-button]');
  return chip?.closest('#hint-bar') != null ? chip : null;
};

const isActive = (el: Element): boolean =>
  el.classList.contains('is-active') || el.getAttribute('aria-selected') === 'true';

/** A nav row's container: its parent, or the grid holding its `role="row"` parent. */
function containerOf(item: HTMLElement): HTMLElement | null {
  const parent = item.parentElement;
  if (parent?.getAttribute('role') === 'row') return parent.parentElement;
  return parent;
}

/** The container's rows in DOM order (a nested container's rows are not its own). */
const rowsOf = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-nav-key]')).filter(
    (el) => containerOf(el) === container,
  );

/** One of `container`'s own rows (a direct child, or a cell of a direct `role="row"` child), by a
 *  child walk rather than a subtree query: the wheel asks this of every ancestor, per event. */
function ownRow(container: HTMLElement): HTMLElement | null {
  for (const child of container.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.hasAttribute('data-nav-key')) return child;
    if (child.getAttribute('role') !== 'row') continue;
    for (const cell of child.children) {
      if (cell instanceof HTMLElement && cell.hasAttribute('data-nav-key')) return cell;
    }
  }
  return null;
}

/** Grid columns: the first `role="row"`'s cells, else a CSS grid's column tracks; null = a list. */
function colsOf(container: HTMLElement, rows: readonly HTMLElement[]): number | null {
  const firstRow = rows[0]?.parentElement;
  if (firstRow?.getAttribute('role') === 'row')
    return rowsOf(container).filter((r) => r.parentElement === firstRow).length;
  const style = container.ownerDocument.defaultView?.getComputedStyle(container);
  if (style?.display !== 'grid' && container.style.display !== 'grid') return null;
  const tracks = (style?.gridTemplateColumns || container.style.gridTemplateColumns).trim();
  const rep = /^repeat\(\s*(\d+)\s*,/.exec(tracks);
  if (rep !== null) return Number(rep[1]);
  const n = tracks === '' || tracks === 'none' ? 0 : tracks.split(/\s+/).length;
  return n > 0 ? n : null;
}

export class PointerSource {
  readonly #screen: HTMLElement;
  readonly #canvas: () => HTMLElement | null;
  readonly #deps: PointerDeps;
  readonly #clock: PointerClock;
  #track: PressTrack | null = null;
  #timer: number | null = null;
  #ring: HTMLElement | null = null;
  /** The trailing click of a fired long-press is swallowed until this time. */
  #swallowUntil = -Infinity;
  /** The last touch down, lift or long-press: a `contextmenu` soon after is the touch's. */
  #lastTouch = -Infinity;
  #lastMove: { x: number; y: number } | null = null;
  #lastHover: Element | null = null;
  /** A container a hover probe found undriven: no further hover probes it until a key or click. */
  #staleHover: HTMLElement | null = null;
  /** The click whose capture step closed a world sheet: its bubble routes nothing. */
  #closeOnly: Event | null = null;
  /** The wheel remainder and the nav container it was gathered over. */
  #wheelAcc = 0;
  #wheelOver: HTMLElement | null = null;
  #wheelAt = -Infinity;

  constructor(
    gameScreen: HTMLElement,
    canvas: () => HTMLElement | null,
    deps: PointerDeps,
    clock: PointerClock = BROWSER_CLOCK,
  ) {
    this.#screen = gameScreen;
    this.#canvas = canvas;
    this.#deps = deps;
    this.#clock = clock;
    // The swallow and the sheet close run in the CAPTURE phase: a native button or a view's own row
    // listener inside the game screen would otherwise take the click before the bubble.
    gameScreen.addEventListener('click', (e) => this.#onCaptureClick(e), true);
    gameScreen.addEventListener('click', (e) => this.#onClick(e));
    // Not passive: the wheel's preventDefault must hold over nav rows.
    gameScreen.addEventListener('wheel', (e) => this.#onWheel(e), { passive: false });
    gameScreen.addEventListener('contextmenu', (e) => this.#onContextMenu(e));
    gameScreen.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
    gameScreen.addEventListener('pointermove', (e) => this.#onPointerMove(e));
    gameScreen.addEventListener('pointerup', (e) => this.#onPointerEnd(e));
    gameScreen.addEventListener('pointercancel', (e) => this.#onPointerEnd(e));
  }

  /** A key was pressed: hide the hover state, and let the next mouse move re-seek its row. */
  keyPressed(): void {
    this.#screen.classList.remove(HOVER_CLASS);
    this.#lastHover = null;
    this.#staleHover = null;
    this.#wheelAcc = 0;
  }

  #onCaptureClick(e: MouseEvent): void {
    if (this.#clock.now() < this.#swallowUntil) {
      this.#swallowUntil = -Infinity;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    this.#closeSheet(e);
  }

  /** The open sheet a click can close or route into: one shown in the top frame, or a world sheet
   *  (top `other`); none at the bare world. */
  #openSheet(top: PointerTop): HTMLElement | null {
    if (top === 'world') return null;
    // A world sheet sits under no frame; covered layers are inert (ui/overlayA11y.ts).
    for (const sheet of this.#screen.querySelectorAll<HTMLElement>(SHEET)) {
      const shown =
        top === 'frame'
          ? this.#inTopFrame(sheet)
          : sheet.closest('[aria-modal="true"]') === null && this.#shown(sheet);
      if (shown) return sheet;
    }
    return null;
  }

  /** UIF5.1/UIF5.3: a click outside the open sheet (a hint chip aside) first presses B until no
   *  sheet shows or the top changes (a world sheet's DOM may repaint a frame late). The event is
   *  never stopped, so it then routes as if no sheet had been open. */
  #closeSheet(e: MouseEvent): void {
    if (this.#deps.capturing() || !(e.target instanceof Element)) return;
    const target = e.target;
    if (chipAt(target)) return;
    const top = this.#deps.top();
    const sheet = this.#openSheet(top);
    if (sheet === null || sheet.contains(target)) return;
    for (
      let i = 0;
      i < MAX_CLOSE_DEPTH && this.#deps.top() === top && this.#openSheet(top) !== null;
      i += 1
    ) {
      this.#deps.press('B');
    }
    if (top === 'other') this.#closeOnly = e;
  }

  #onClick(e: MouseEvent): void {
    this.#staleHover = null;
    const closeOnly = this.#closeOnly === e;
    this.#closeOnly = null;
    if (closeOnly || this.#deps.capturing() || !(e.target instanceof Element)) return;
    const target = e.target;
    const chip = chipAt(target);
    if (chip !== null) {
      if (isVButton(chip.dataset.button)) this.#deps.press(chip.dataset.button);
      return;
    }
    // A native control keeps its own click, unless it is itself a nav row (the dialogue's
    // choice and Shop buttons): that row routes like any other.
    const native = target.closest(NATIVE);
    if (native !== null && !native.hasAttribute('data-nav-key')) return;
    if (target.closest('[data-pointer-own]') !== null) return;
    const top = this.#deps.top();
    // A row of the open sheet seeks before the top switch: a world sheet's top is `other`.
    const sheet = this.#openSheet(top);
    if (sheet?.contains(target)) {
      const row = target.closest<HTMLElement>('[data-nav-key]');
      if (row !== null) this.#seekItem(row, true);
      return;
    }
    switch (top) {
      case 'world': {
        const canvas = this.#canvas();
        if (canvas?.contains(target)) this.#deps.press('A');
        return;
      }
      case 'frame': {
        const tab = target.closest<HTMLElement>('[role="tab"][data-nav-tab]');
        if (tab !== null) {
          this.#seekTab(tab);
          return;
        }
        const item = target.closest<HTMLElement>('[data-nav-key]');
        if (item !== null) this.#seekItem(item, true);
        return;
      }
      case 'other':
        return;
    }
  }

  /** UIF5.4: over the top frame's nav rows, Up or Down per notch instead of the native scroll. A
   *  zoom (ctrl or meta, a trackpad pinch) or a horizontal-only wheel stays the browser's. */
  #onWheel(e: WheelEvent): void {
    if (e.ctrlKey || e.metaKey || e.deltaY === 0 || !Number.isFinite(e.deltaY)) return;
    if (this.#deps.capturing() || !(e.target instanceof Element)) return;
    const active = this.#screen.ownerDocument.activeElement;
    if (e.target.closest(EDITABLE) !== null || active?.closest(EDITABLE) != null) return;
    if (this.#deps.top() !== 'frame') return;
    const container = this.#navContainerAt(e.target);
    if (container === null) return;
    e.preventDefault();
    const now = this.#clock.now();
    if (container !== this.#wheelOver || now - this.#wheelAt > WHEEL_IDLE_MS) this.#wheelAcc = 0;
    this.#wheelOver = container;
    this.#wheelAt = now;
    const { steps, acc } = wheelSteps(this.#wheelAcc, e.deltaY, e.deltaMode);
    this.#wheelAcc = acc;
    for (let i = 0; i < Math.abs(steps); i += 1) this.#deps.press(steps > 0 ? 'Down' : 'Up');
  }

  /** The top frame's nav container under `el` (a row's container, or an element holding rows),
   *  and only the open sheet's rows while a sheet shows: the base list under it is stale. */
  #navContainerAt(el: Element): HTMLElement | null {
    let row = el.closest<HTMLElement>('[data-nav-key]');
    for (let n: Element | null = el; row === null && n !== null && n !== this.#screen; ) {
      row = n instanceof HTMLElement ? ownRow(n) : null;
      n = n.parentElement;
    }
    const container = row === null ? null : containerOf(row);
    if (row === null || container === null || !this.#inTopFrame(row)) return null;
    const sheet = this.#openSheet('frame');
    return sheet === null || sheet.contains(container) ? container : null;
  }

  #onContextMenu(e: MouseEvent): void {
    if (e.target instanceof Element && e.target.closest(EDITABLE) !== null) return;
    // The browser's own menu gesture for a touch long-press: the timer already pressed (or will
    // press) the one B.
    if (this.#track !== null || this.#clock.now() - this.#lastTouch < TOUCH_GRACE_MS) {
      e.preventDefault();
      return;
    }
    // Only the mouse's right button is B: the keyboard's menu key keeps the browser menu (the
    // remappable binding table decides what keys press).
    if (e.button !== 2) return;
    e.preventDefault();
    this.#back();
  }

  #onPointerDown(e: PointerEvent): void {
    this.#swallowUntil = -Infinity;
    if (e.pointerType !== 'touch') {
      this.#endTrack(); // a touch whose release was never seen
      return;
    }
    if (!e.isPrimary) return;
    if (e.target instanceof Element && e.target.closest(EDITABLE) !== null) return;
    e.preventDefault();
    this.#endTrack();
    const now = this.#clock.now();
    this.#lastTouch = now;
    this.#track = startPress(e.pointerId, e.clientX, e.clientY, now);
    this.#showRing(e.clientX, e.clientY);
    this.#timer = this.#clock.setTimeout(() => this.#onLongPressDue(), LONG_PRESS_MS);
  }

  #onLongPressDue(): void {
    this.#timer = null;
    const now = this.#clock.now();
    const step = firePress(this.#track, now);
    this.#track = step.track;
    if (!step.fire) {
      // A coarse clock can read the timer's moment as a little early: wait out the rest.
      const track = step.track;
      if (track !== null && !track.fired) {
        const rest = Math.max(1, LONG_PRESS_MS - (now - track.t0));
        this.#timer = this.#clock.setTimeout(() => this.#onLongPressDue(), rest);
      }
      return;
    }
    this.#removeRing();
    this.#lastTouch = now;
    this.#back();
  }

  #onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      if (this.#track === null) return;
      this.#track = movePress(this.#track, e.pointerId, e.clientX, e.clientY);
      if (this.#track === null) this.#endTrack();
      return;
    }
    if (e.pointerType !== 'mouse') return;
    if (this.#lastMove?.x === e.clientX && this.#lastMove.y === e.clientY) return;
    this.#lastMove = { x: e.clientX, y: e.clientY };
    this.#screen.classList.add(HOVER_CLASS);
    if (this.#deps.capturing() || this.#deps.top() !== 'frame') return;
    const item =
      e.target instanceof Element ? e.target.closest<HTMLElement>('[data-nav-key]') : null;
    if (item === this.#lastHover) return;
    this.#lastHover = item;
    if (item === null || isActive(item) || containerOf(item) === this.#staleHover) return;
    // A press a hover sends is a real press (a screen may clear its feedback on any button), so a
    // container the probe found undriven is not probed again by this hover.
    if (this.#seekItem(item, false) === 'undone') this.#staleHover = containerOf(item);
  }

  #onPointerEnd(e: PointerEvent): void {
    if (this.#track === null) return;
    const step = endPress(this.#track, e.pointerId);
    if (step.track !== null) return; // another pointer's release
    const now = this.#clock.now();
    if (step.swallowClick) this.#swallowUntil = now + TOUCH_GRACE_MS;
    this.#lastTouch = now;
    this.#endTrack();
  }

  /** B, or the end of a remap capture (B would be captured as the key). */
  #back(): void {
    if (this.#deps.capturing()) this.#deps.cancelCapture();
    else this.#deps.press('B');
  }

  #endTrack(): void {
    this.#track = null;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#removeRing();
  }

  #showRing(x: number, y: number): void {
    const ring = this.#screen.ownerDocument.createElement('div');
    ring.className = 'mr-longpress-ring';
    ring.setAttribute('aria-hidden', 'true');
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    this.#screen.appendChild(ring);
    this.#ring = ring;
  }

  #removeRing(): void {
    this.#ring?.remove();
    this.#ring = null;
  }

  /** Whether `el` is shown inside the TOP frame: an `aria-modal` root and `#shown`; or, while a
   *  world sheet is open, inside that sheet. */
  #inTopFrame(el: HTMLElement): boolean {
    if (el.closest('[aria-modal="true"]') !== null) return this.#shown(el);
    const sheet = el.closest<HTMLElement>(SHEET);
    return sheet !== null && this.#deps.top() === 'other' && this.#shown(el);
  }

  /** Nothing inert (a covered frame is), and no hidden, `display:none` or `visibility:hidden`
   *  ancestor. */
  #shown(el: HTMLElement): boolean {
    if (el.closest('[inert]') !== null) return false;
    for (let n: HTMLElement | null = el; n !== null && n !== this.#screen; n = n.parentElement) {
      if (n.hidden || n.style.display === 'none' || n.style.visibility === 'hidden') return false;
    }
    return true;
  }

  /** Press `button`; true when the cursor of `els` then sits on `want`. */
  #pressTo(button: VButton, els: () => readonly HTMLElement[], want: number): boolean {
    this.#deps.press(button);
    return els().findIndex(isActive) === want;
  }

  /** Walk `path` from `from`, the first press a probe (undone on a miss), each later press
   *  verified: the cursor arrived, the first press missed and was undone, or a later one stopped. */
  #walk(
    path: readonly VButton[],
    from: number,
    cols: number,
    els: () => readonly HTMLElement[],
  ): Walk {
    let at = from;
    for (const [i, button] of path.entries()) {
      at += STEP[button]?.(cols) ?? 0;
      if (this.#pressTo(button, els, at)) continue;
      const inverse = INVERSE[button];
      if (i > 0 || inverse === undefined) return 'stopped';
      this.#deps.press(inverse);
      return 'undone';
    }
    return 'arrived';
  }

  #seekTab(tab: HTMLElement): void {
    const strip = tab.closest<HTMLElement>('[role="tablist"]');
    if (strip === null || !this.#inTopFrame(tab)) return;
    const tabs = (): HTMLElement[] =>
      Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]'));
    const from = tabs().findIndex(isActive);
    const to = tabs().indexOf(tab);
    if (from < 0 || to < 0 || from === to) return;
    this.#walk(tabPath(from, to), from, 1, tabs);
  }

  #seekItem(item: HTMLElement, activate: boolean): Walk | null {
    const container = containerOf(item);
    if (container === null || !this.#inTopFrame(item)) return null;
    const els = (): HTMLElement[] => rowsOf(container);
    const rows = els();
    const from = rows.findIndex(isActive);
    const to = rows.indexOf(item);
    if (from < 0 || to < 0) return null;
    const cols = colsOf(container, rows);
    if (from !== to) {
      const walk = this.#walk(navPath(rows.length, cols, from, to), from, cols ?? 1, els);
      if (walk === 'arrived' && activate) this.#deps.press('A');
      return walk;
    }
    if (activate && this.#provenDriven(container, rows.length, cols, from)) this.#deps.press('A');
    return null;
  }

  /** Whether the container whose active row is at `at` is the one the frame drives: a probe move
   *  and its undo when it has a second row, else elimination over the other shown containers. */
  #provenDriven(container: HTMLElement, count: number, cols: number | null, at: number): boolean {
    const els = (): HTMLElement[] => rowsOf(container);
    let probe: VButton | null = null;
    if (cols === null) probe = count > 1 ? 'Down' : null;
    else if (Math.min(cols, count - Math.floor(at / cols) * cols) > 1) probe = 'Right';
    else if (Math.floor((count - 1 - (at % cols)) / cols) > 0) probe = 'Down';
    if (probe !== null) {
      this.#deps.press(probe);
      const moved = els().findIndex(isActive) !== at;
      this.#deps.press(INVERSE[probe] as VButton);
      return moved;
    }
    // One row: driven only if every other shown container is a list a Down probe would move,
    // and none did. Inside an open context sheet only the sheet's other containers compete: the
    // shown sheet is what its frame drives, so a base list under it is never a rival.
    const root =
      container.closest<HTMLElement>(SHEET) ??
      container.closest<HTMLElement>('[aria-modal="true"]');
    if (root === null) return false;
    const others = new Set<HTMLElement>();
    for (const row of root.querySelectorAll<HTMLElement>('[data-nav-key]')) {
      const c = containerOf(row);
      if (c !== null && c !== container && this.#inTopFrame(row) && isActive(row)) others.add(c);
    }
    if (others.size === 0) return true;
    const lists = [...others].map((c) => ({ c, rows: rowsOf(c) }));
    if (lists.some(({ c, rows }) => rows.length < 2 || colsOf(c, rows) !== null)) return false;
    const before = lists.map(({ c }) => rowsOf(c).findIndex(isActive));
    this.#deps.press('Down');
    if (lists.every(({ c }, i) => rowsOf(c).findIndex(isActive) === before[i])) return true;
    this.#deps.press('Up');
    return false;
  }
}
