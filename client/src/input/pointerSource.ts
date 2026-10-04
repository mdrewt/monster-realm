// input/pointerSource.ts — the pointer and touch source: ONE dispatcher on #game-screen (ctl-15,
// CTL15.1 to CTL15.5). Like the keyboard source it only presses virtual buttons, so the router and
// every screen adapter decide what a click means; game logic never sees a coordinate. The two
// dialogue buttons the old document click delegate owned are the only commands it sends itself.
//
// A click on a row of the top frame is a SEEK: the D-pad presses that walk that container's cursor
// to the row, then A. The DOM cannot say which container the frame's adapter drives (a base list
// stays visible, with a stale cursor, under its sheet or picker), so the first press is a probe: if
// the clicked container's cursor did not move as planned, the press is undone with its inverse
// (fresh nav steps wrap, so one step is always invertible) and nothing is activated. A click on the
// row that is already active is proven the same way, or by elimination when it is the container's
// only row; a tie between single-row containers does nothing rather than activate the wrong one.
//
// Right-click and a touch long-press (500 ms within 10 px, with a fill ring) press B, or cancel a
// remap capture. A mouse moving to new coordinates over a row makes it active (never A) and shows
// the hover state until the next key press (`keyPressed`).
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

export interface PointerDeps {
  /** The bare world base (no sheet open), a screen or prompt frame on top, or anything else. */
  top(): PointerTop;
  /** One press (down, then up) of `button` through the router. */
  press(button: VButton): void;
  /** Whether Options › Controls waits for a key. */
  capturing(): boolean;
  cancelCapture(): void;
  /** A dialogue choice button (`data-choice-idx`). */
  choice(idx: number): void;
  /** The dialogue's greet-then-shop button (`data-shop-id`). */
  shop(shopId: number): void;
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
    gameScreen.addEventListener('click', (e) => this.#onClick(e));
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
  }

  #onClick(e: MouseEvent): void {
    if (this.#clock.now() < this.#swallowUntil) {
      this.#swallowUntil = -Infinity;
      return;
    }
    if (this.#deps.capturing() || !(e.target instanceof Element)) return;
    const target = e.target;
    const shopBtn = target.closest<HTMLElement>('[data-shop-id]');
    if (shopBtn !== null) {
      const id = Number(shopBtn.dataset.shopId);
      if (!Number.isNaN(id)) this.#deps.shop(id);
      return;
    }
    const choiceBtn = target.closest<HTMLElement>('[data-choice-idx]');
    if (choiceBtn !== null) {
      const idx = Number.parseInt(choiceBtn.dataset.choiceIdx ?? '', 10);
      if (!Number.isNaN(idx)) this.#deps.choice(idx);
      return;
    }
    const chip = target.closest<HTMLElement>('[data-button]');
    if (chip?.closest('#hint-bar') != null) {
      if (isVButton(chip.dataset.button)) this.#deps.press(chip.dataset.button);
      return;
    }
    if (target.closest(NATIVE) !== null || target.closest('[data-pointer-own]') !== null) return;
    switch (this.#deps.top()) {
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

  #onContextMenu(e: MouseEvent): void {
    if (e.target instanceof Element && e.target.closest(EDITABLE) !== null) return;
    e.preventDefault();
    // The browser's own menu gesture for a touch long-press: the timer already pressed (or will
    // press) the one B.
    if (this.#track !== null || this.#clock.now() - this.#lastTouch < TOUCH_GRACE_MS) return;
    this.#back();
  }

  #onPointerDown(e: PointerEvent): void {
    this.#swallowUntil = -Infinity;
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    if (e.target instanceof Element && e.target.closest(EDITABLE) !== null) return;
    e.preventDefault();
    this.#endTrack();
    const now = this.#clock.now();
    this.#lastTouch = now;
    this.#track = startPress(e.pointerId, e.clientX, e.clientY, now);
    this.#showRing(e.clientX, e.clientY);
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // A pointer the browser no longer knows: the release still arrives on the game screen.
    }
    this.#timer = this.#clock.setTimeout(() => this.#onLongPressDue(), LONG_PRESS_MS);
  }

  #onLongPressDue(): void {
    this.#timer = null;
    const now = this.#clock.now();
    const step = firePress(this.#track, now);
    this.#track = step.track;
    if (!step.fire) return;
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
    if (item !== null && !isActive(item)) this.#seekItem(item, false);
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

  /** Whether `el` is shown inside the TOP frame: an `aria-modal` root, nothing inert (a covered
   *  frame is), and no hidden, `display:none` or `visibility:hidden` ancestor. */
  #inTopFrame(el: HTMLElement): boolean {
    if (el.closest('[aria-modal="true"]') === null || el.closest('[inert]') !== null) return false;
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
   *  verified; true when the cursor arrived. */
  #walk(
    path: readonly VButton[],
    from: number,
    cols: number,
    els: () => readonly HTMLElement[],
  ): boolean {
    let at = from;
    for (const [i, button] of path.entries()) {
      at += STEP[button]?.(cols) ?? 0;
      if (this.#pressTo(button, els, at)) continue;
      const inverse = INVERSE[button];
      if (i === 0 && inverse !== undefined) this.#deps.press(inverse);
      return false;
    }
    return true;
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

  #seekItem(item: HTMLElement, activate: boolean): void {
    const container = containerOf(item);
    if (container === null || !this.#inTopFrame(item)) return;
    const els = (): HTMLElement[] => rowsOf(container);
    const rows = els();
    const from = rows.findIndex(isActive);
    const to = rows.indexOf(item);
    if (from < 0 || to < 0) return;
    const cols = colsOf(container, rows);
    if (from !== to) {
      if (this.#walk(navPath(rows.length, cols, from, to), from, cols ?? 1, els) && activate) {
        this.#deps.press('A');
      }
      return;
    }
    if (activate && this.#provenDriven(container, rows.length, cols, from)) this.#deps.press('A');
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
    // and none did.
    const root = container.closest<HTMLElement>('[aria-modal="true"]');
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
