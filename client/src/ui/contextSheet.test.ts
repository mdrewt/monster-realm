// @vitest-environment happy-dom
/**
 * contextSheet.test.ts: the ContextSheet kit primitive (uif-3, UIF3.3 and UIF3.4).
 *
 * Three layers:
 *  - `anchorSheet({ area, slot, sheet, inset, reserve?, minHeight? })`: the PURE corner rule
 *    (reference: specs/monster-realm-v2/wireframes/lib.mjs anchorSheet, with three deliberate
 *    fixes: a capped sheet never exceeds its natural height, `scrolls` is exactly rect.h < sheet.h,
 *    and the function is total on tiny bodies). UIF3.4, property tests plus worked examples.
 *  - `createContextSheet` / `renderContextSheet` / `closeContextSheet`: ONE `[data-context-sheet]`
 *    root per frame, reused across the list, confirm and detail variants, rows through the real
 *    `renderNav`, caller text through `textContent` only. UIF3.3.
 *  - `placeContextSheet(sheet, body, slot)`: the thin DOM shell over `anchorSheet`; it owns the
 *    inset (0.75rem) and the feedback-strip reserve (1.75rem), both times the root font size, and
 *    measures through getBoundingClientRect (stubbed here, with a known root font size).
 *
 * Assumption (flagged to the orchestrator): `slot` is an Element whose getBoundingClientRect is read.
 */
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anchorSheet,
  closeContextSheet,
  createContextSheet,
  placeContextSheet,
  renderContextSheet,
} from './contextSheet';
import type { NavItem, NavLayout, NavState } from './nav';

// --- builders ------------------------------------------------------------------------------
type Content = Parameters<typeof renderContextSheet>[1];
type AnchorInput = Parameters<typeof anchorSheet>[0];

interface R {
  x: number;
  y: number;
  w: number;
  h: number;
}

const itm = (key: string) => ({ key, enabled: true });
const listL = (...keys: string[]): NavLayout => ({ kind: 'list', items: keys.map(itm) });
const state = (item: string | null): NavState => ({ tab: null, item, perTab: {} });
const fill = (el: HTMLElement, item: NavItem): void => {
  el.textContent = `Row ${item.key}`;
};

const listC = (title: string | undefined, keys: string[], active: string | null): Content => ({
  variant: 'list' as const,
  ...(title === undefined ? {} : { title }),
  layout: listL(...keys),
  state: state(active),
  fill,
});
const confirmC = (question: string, keys: string[], active: string | null): Content => ({
  variant: 'confirm' as const,
  question,
  layout: listL(...keys),
  state: state(active),
  fill,
});
const detailC = (
  title: string | undefined,
  prose: string,
  keys: string[],
  active: string | null,
): Content => ({
  variant: 'detail' as const,
  ...(title === undefined ? {} : { title }),
  prose,
  layout: listL(...keys),
  state: state(active),
  fill,
});

const hiddenEl = (el: HTMLElement): boolean => el.hidden && el.hasAttribute('hidden');

beforeEach(() => {
  document.body.replaceChildren();
});

// --- UIF3.3: the DOM sheet ------------------------------------------------------------------
describe('createContextSheet and renderContextSheet', () => {
  it('UIF3.3 creates one hidden .mr-sheet[data-context-sheet] root with a title, a prose and a rows part, and validates the frame id', () => {
    // WRONG IMPLS KILLED: a visible sheet at creation (an empty bordered box over the screen); no
    // data-context-sheet marker (uif-5 pointer dismissal and the e2e keys on it); the rows part
    // missing the nav-list / scroll classes the CSS keys on; a heading id that is not frame-scoped
    // (two frames would collide); no frame-id check (a dangling or duplicated IDREF).
    const sheet = createContextSheet(document, { frame: 'bag' });
    expect(sheet.root.matches('.mr-sheet[data-context-sheet]')).toBe(true);
    expect(sheet.root.hidden).toBe(true);
    expect(sheet.root.hasAttribute('hidden')).toBe(true);
    expect(sheet.heading.classList.contains('mr-sheet-title')).toBe(true);
    expect(sheet.heading.id).toBe('bag-sheet-title');
    expect(sheet.prose.classList.contains('mr-sheet-prose')).toBe(true);
    for (const cls of ['mr-sheet-rows', 'mr-nav-list', 'mr-scroll']) {
      expect(sheet.rows.classList.contains(cls), cls).toBe(true);
    }
    for (const part of [sheet.heading, sheet.prose, sheet.rows]) {
      expect(sheet.root.contains(part)).toBe(true);
      expect(part.parentElement).toBe(sheet.root);
    }
    document.body.appendChild(sheet.root);
    expect(document.querySelectorAll('[data-context-sheet]').length).toBe(1);
    for (const bad of ['', ' ', 'a-b', 'a b']) {
      expect(() => createContextSheet(document, { frame: bad }), JSON.stringify(bad)).toThrow();
    }
    const other = createContextSheet(document, { frame: 'shop' });
    expect(other.heading.id).toBe('shop-sheet-title');
    expect(other.root).not.toBe(sheet.root);
  });

  it('UIF3.3 the list variant shows its rows, un-hides the sheet and records the variant; prose stays hidden and empty', () => {
    // WRONG IMPLS KILLED: render that forgets to un-hide the root; no data-sheet-variant; the
    // detail class present on a list; the prose part visible outside the detail variant.
    const sheet = createContextSheet(document, { frame: 'bag' });
    document.body.appendChild(sheet.root);
    renderContextSheet(sheet, listC('Actions', ['feed', 'move', 'back'], 'move'));
    expect(sheet.root.hidden).toBe(false);
    expect(sheet.root.hasAttribute('hidden')).toBe(false);
    expect(sheet.root.getAttribute('data-sheet-variant')).toBe('list');
    expect(sheet.root.classList.contains('mr-sheet--detail')).toBe(false);
    expect(hiddenEl(sheet.prose)).toBe(true);
    expect(sheet.prose.textContent).toBe('');
    expect(sheet.heading.hidden).toBe(false);
    expect(sheet.heading.textContent).toBe('Actions');
    expect(Array.from(sheet.rows.children).map((r) => r.textContent)).toEqual([
      'Row feed',
      'Row move',
      'Row back',
    ]);
  });

  it('UIF3.3 rows are rendered by the real renderNav: a listbox of options, the cursor named by aria-activedescendant, one tab stop', () => {
    // WRONG IMPLS KILLED: hand-built rows (no role, no pointer, no is-active); a pointer naming a
    // node outside the list; a second tab stop on a row; the cursor not following the state.
    const sheet = createContextSheet(document, { frame: 'bag' });
    document.body.appendChild(sheet.root);
    renderContextSheet(sheet, listC('Actions', ['feed', 'move', 'back'], 'move'));
    expect(sheet.rows.getAttribute('role')).toBe('listbox');
    expect(sheet.rows.getAttribute('tabindex')).toBe('0');
    const options = Array.from(sheet.rows.children) as HTMLElement[];
    expect(options.map((o) => o.getAttribute('role'))).toEqual(['option', 'option', 'option']);
    expect(options.map((o) => o.id)).toEqual(['bag-root-feed', 'bag-root-move', 'bag-root-back']);
    expect(sheet.rows.getAttribute('aria-activedescendant')).toBe('bag-root-move');
    expect(options[1]?.classList.contains('is-active')).toBe(true);
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    for (const o of options) expect(o.hasAttribute('tabindex')).toBe(false);
    renderContextSheet(sheet, listC('Actions', ['feed', 'move', 'back'], 'back'));
    expect(sheet.rows.getAttribute('aria-activedescendant')).toBe('bag-root-back');
    expect(document.querySelectorAll('[role="listbox"]').length).toBe(1);
  });

  it('UIF3.3 the title is optional: absent means a hidden empty heading and no aria-labelledby; present means a visible heading the rows resolve to', () => {
    // WRONG IMPLS KILLED: an always-visible empty heading (a blank band); aria-labelledby pointing
    // at a hidden empty heading (an unnamed listbox that looks named); a title that does not name
    // the rows; a stale labelledby surviving a re-render without a title.
    const sheet = createContextSheet(document, { frame: 'bag' });
    document.body.appendChild(sheet.root);
    renderContextSheet(sheet, listC(undefined, ['a', 'b'], 'a'));
    expect(hiddenEl(sheet.heading)).toBe(true);
    expect(sheet.heading.textContent).toBe('');
    expect(sheet.rows.hasAttribute('aria-labelledby')).toBe(false);

    renderContextSheet(sheet, listC('Feed', ['a', 'b'], 'a'));
    expect(sheet.heading.hidden).toBe(false);
    expect(sheet.heading.hasAttribute('hidden')).toBe(false);
    const ref = sheet.rows.getAttribute('aria-labelledby');
    expect(ref).toBe(sheet.heading.id);
    const target = document.getElementById(ref ?? '');
    expect(target).toBe(sheet.heading);
    expect(target?.textContent).toBe('Feed');

    renderContextSheet(sheet, listC(undefined, ['a', 'b'], 'a'));
    expect(hiddenEl(sheet.heading)).toBe(true);
    expect(sheet.heading.textContent).toBe('');
    expect(sheet.rows.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('UIF3.3 the confirm variant shows the question as the visible, row-naming heading, with the choices as rows, and hides the prose', () => {
    // WRONG IMPLS KILLED: the question dropped or written only into the prose (hidden outside
    // detail); a confirm whose choices are not rows; a listbox not named by the question (the
    // question is announced on open: it must be the accessible name); a detail class on confirm.
    const sheet = createContextSheet(document, { frame: 'bag' });
    document.body.appendChild(sheet.root);
    renderContextSheet(sheet, confirmC('Evolve Sparky?', ['yes', 'no'], 'no'));
    expect(sheet.root.getAttribute('data-sheet-variant')).toBe('confirm');
    expect(sheet.root.hidden).toBe(false);
    expect(sheet.heading.hidden).toBe(false);
    expect(sheet.heading.textContent).toBe('Evolve Sparky?');
    expect(sheet.rows.getAttribute('aria-labelledby')).toBe(sheet.heading.id);
    expect(Array.from(sheet.rows.children).map((r) => r.textContent)).toEqual([
      'Row yes',
      'Row no',
    ]);
    expect(sheet.rows.getAttribute('aria-activedescendant')).toBe('bag-root-no');
    expect(hiddenEl(sheet.prose)).toBe(true);
    expect(sheet.prose.textContent).toBe('');
    expect(sheet.root.classList.contains('mr-sheet--detail')).toBe(false);
  });

  it('UIF3.3 the detail variant shows its prose and optional title over the list behind it, with the detail class', () => {
    // WRONG IMPLS KILLED: prose never shown; the detail modifier missing (CSS would not centre
    // it); the detail modifier toggled on but never off (checked in the reuse case below).
    const sheet = createContextSheet(document, { frame: 'bag' });
    document.body.appendChild(sheet.root);
    renderContextSheet(sheet, detailC('Sparky', 'A small spark of a monster.', ['close'], 'close'));
    expect(sheet.root.getAttribute('data-sheet-variant')).toBe('detail');
    expect(sheet.root.classList.contains('mr-sheet--detail')).toBe(true);
    expect(sheet.prose.hidden).toBe(false);
    expect(sheet.prose.hasAttribute('hidden')).toBe(false);
    expect(sheet.prose.textContent).toBe('A small spark of a monster.');
    expect(sheet.heading.textContent).toBe('Sparky');
    expect(sheet.heading.hidden).toBe(false);
    expect(Array.from(sheet.rows.children).map((r) => r.textContent)).toEqual(['Row close']);

    renderContextSheet(sheet, detailC(undefined, 'Prose only.', ['close'], 'close'));
    expect(sheet.prose.textContent).toBe('Prose only.');
    expect(hiddenEl(sheet.heading)).toBe(true);
    expect(sheet.heading.textContent).toBe('');
  });

  it('UIF3.3 one root is reused across list, confirm, detail and list again, with stale state cleared in both directions', () => {
    // WRONG IMPLS KILLED: a new root per variant (the stacked sheets uif-7 forbids: Feed then the
    // evolve confirm replace rows in the SAME sheet); the detail class sticking after detail;
    // prose text surviving into the next list (hidden but stale); a heading that keeps the old
    // title or question when the next content has none; the variant attribute not following.
    const sheet = createContextSheet(document, { frame: 'bag' });
    document.body.appendChild(sheet.root);
    const root = sheet.root;
    const rows = sheet.rows;

    renderContextSheet(sheet, listC('Feed', ['a', 'b', 'c'], 'a'));
    renderContextSheet(sheet, confirmC('Evolve?', ['yes', 'no'], 'no'));
    expect(sheet.heading.textContent).toBe('Evolve?');
    expect(sheet.rows.children.length).toBe(2);
    expect(sheet.root.getAttribute('data-sheet-variant')).toBe('confirm');

    renderContextSheet(sheet, detailC('Info', 'Some prose.', ['close'], 'close'));
    expect(sheet.root.classList.contains('mr-sheet--detail')).toBe(true);
    expect(sheet.prose.textContent).toBe('Some prose.');
    expect(sheet.heading.textContent).toBe('Info');

    renderContextSheet(sheet, listC(undefined, ['a', 'b'], 'b'));
    expect(sheet.root.classList.contains('mr-sheet--detail'), 'detail class cleared').toBe(false);
    expect(sheet.root.getAttribute('data-sheet-variant')).toBe('list');
    expect(sheet.prose.textContent, 'prose cleared, not only hidden').toBe('');
    expect(hiddenEl(sheet.prose)).toBe(true);
    expect(sheet.heading.textContent, 'heading cleared').toBe('');
    expect(hiddenEl(sheet.heading)).toBe(true);
    expect(sheet.rows.hasAttribute('aria-labelledby')).toBe(false);
    expect(Array.from(sheet.rows.children).map((r) => r.id)).toEqual(['bag-root-a', 'bag-root-b']);

    // and the other way: a title-less list into a detail
    renderContextSheet(sheet, detailC('Again', 'More prose.', ['close'], null));
    expect(sheet.root.classList.contains('mr-sheet--detail')).toBe(true);
    expect(sheet.prose.textContent).toBe('More prose.');

    expect(sheet.root).toBe(root);
    expect(sheet.rows).toBe(rows);
    expect(document.querySelectorAll('[data-context-sheet]').length).toBe(1);
    expect(document.querySelectorAll('.mr-sheet').length).toBe(1);
  });

  it('UIF3.3 is sized by its rows: the row count changes the child count, and render writes no inline height', () => {
    // WRONG IMPLS KILLED: a fixed row count; a height computed from the row count and written
    // inline (the CSS and the natural content size own the height, placement caps it only when it
    // scrolls); an inline height surviving on the root or the rows part.
    const sheet = createContextSheet(document, { frame: 'bag' });
    document.body.appendChild(sheet.root);
    for (const n of [1, 2, 5, 9, 3]) {
      const keys = Array.from({ length: n }, (_, k) => `k${k}`);
      renderContextSheet(sheet, listC('T', keys, 'k0'));
      expect(sheet.rows.children.length, `${n} rows`).toBe(n);
      expect(sheet.root.style.height, `${n} rows: root height`).toBe('');
      expect(sheet.rows.style.height, `${n} rows: rows height`).toBe('');
      expect(sheet.root.style.maxHeight).toBe('');
    }
    renderContextSheet(sheet, confirmC('Q?', ['y', 'n'], 'y'));
    renderContextSheet(sheet, detailC('D', 'p', ['c'], 'c'));
    expect(sheet.root.style.height).toBe('');
    expect(sheet.rows.style.height).toBe('');
  });

  it('UIF3.3 writes caller text as text: a markup title, question and prose add no element', () => {
    // WRONG IMPLS KILLED: innerHTML for the heading, the question or the prose.
    const bad = '<img src=x onerror=x><b>b</b>';
    const sheet = createContextSheet(document, { frame: 'bag' });
    document.body.appendChild(sheet.root);
    renderContextSheet(sheet, listC(bad, ['a'], 'a'));
    expect(sheet.heading.childElementCount).toBe(0);
    expect(sheet.heading.textContent).toBe(bad);
    renderContextSheet(sheet, confirmC(bad, ['y'], 'y'));
    expect(sheet.heading.childElementCount).toBe(0);
    expect(sheet.heading.textContent).toBe(bad);
    renderContextSheet(sheet, detailC(bad, bad, ['c'], 'c'));
    expect(sheet.heading.childElementCount).toBe(0);
    expect(sheet.prose.childElementCount).toBe(0);
    expect(sheet.prose.textContent).toBe(bad);
    expect(sheet.root.querySelector('img')).toBeNull();
    expect(sheet.root.querySelector('b')).toBeNull();
  });

  it('UIF3.3 closeContextSheet hides the root and empties the heading, the prose and the rows; a later render shows it again', () => {
    // WRONG IMPLS KILLED: close that only hides (stale rows and prose reappear for a screen reader
    // and on the next open); close that removes the root (the next open has nowhere to paint).
    const sheet = createContextSheet(document, { frame: 'bag' });
    document.body.appendChild(sheet.root);
    renderContextSheet(sheet, detailC('Info', 'Prose', ['close'], 'close'));
    closeContextSheet(sheet);
    expect(sheet.root.hidden).toBe(true);
    expect(sheet.root.hasAttribute('hidden')).toBe(true);
    expect(sheet.heading.textContent).toBe('');
    expect(sheet.prose.textContent).toBe('');
    expect(sheet.rows.childElementCount).toBe(0);
    expect(document.body.contains(sheet.root)).toBe(true);
    renderContextSheet(sheet, listC('Back', ['x'], 'x'));
    expect(sheet.root.hidden).toBe(false);
    expect(sheet.rows.children.length).toBe(1);
    closeContextSheet(sheet);
    closeContextSheet(sheet);
    expect(sheet.root.hidden).toBe(true);
    expect(sheet.rows.childElementCount).toBe(0);
  });
});

// --- UIF3.3 / UIF3.4: placement over stubbed geometry ----------------------------------------
type Box = { l: number; t: number; w: number; h: number };
const domRect = (b: Box): DOMRect =>
  ({
    x: b.l,
    y: b.t,
    left: b.l,
    top: b.t,
    width: b.w,
    height: b.h,
    right: b.l + b.w,
    bottom: b.t + b.h,
    toJSON: () => ({}),
  }) as DOMRect;
const stub = (el: Element, box: () => Box): void => {
  (el as HTMLElement).getBoundingClientRect = () => domRect(box());
};
const px = (v: string): number => Number.parseFloat(v);

describe('placeContextSheet', () => {
  const REM = 20; // root font size: inset = 15px, reserve = 35px
  const BODY: Box = { l: 100, t: 50, w: 400, h: 300 };
  let natural = { w: 180.5, h: 100 };

  function mount(slotBox: Box, scrollTop = 0) {
    const body = document.createElement('div');
    body.className = 'mr-frame-body';
    document.body.appendChild(body);
    const sheet = createContextSheet(document, { frame: 'bag' });
    body.appendChild(sheet.root);
    const slot = document.createElement('div');
    body.appendChild(slot);
    Object.defineProperty(body, 'scrollTop', { value: scrollTop, configurable: true });
    stub(body, () => BODY);
    stub(slot, () => slotBox);
    // The sheet measures its natural size only while no inline height is set, like a browser.
    stub(sheet.root, () => ({
      l: 0,
      t: 0,
      w: natural.w,
      h: sheet.root.style.height === '' ? natural.h : px(sheet.root.style.height),
    }));
    renderContextSheet(sheet, listC('Actions', ['a', 'b', 'c'], 'a'));
    return { body, sheet, slot };
  }

  beforeEach(() => {
    natural = { w: 180.5, h: 100 };
    document.documentElement.style.fontSize = `${REM}px`;
  });
  afterEach(() => {
    document.documentElement.style.fontSize = '';
  });

  it('UIF3.3 writes left and top relative to the body padding box plus its scrollTop, unrounded, with no height when the sheet fits', () => {
    // WRONG IMPLS KILLED: viewport coordinates written as-is (the sheet lands offset by the body's
    // own position); scrollTop ignored (a scrolled body places the sheet off screen); rounding
    // (the width 180.5 makes left 204.5, not 205); a height written when the sheet fits; an inset
    // or reserve in px or in 16-based rem (the root font size here is 20px, so 15px and 35px).
    const { sheet, slot } = mount({ l: 110, t: 60, w: 50, h: 50 });
    const res = placeContextSheet(sheet, slot.parentElement as HTMLElement, slot);
    expect(res).not.toBeNull();
    expect(res?.corner).toBe('br');
    expect(px(sheet.root.style.left)).toBeCloseTo(204.5, 6);
    expect(px(sheet.root.style.top)).toBeCloseTo(150, 6);
    expect(sheet.root.style.height).toBe('');
    expect(res?.scrolls).toBe(false);
    // bottom edge = top + natural height, resting at body bottom - reserve (1.75rem) - inset (0.75rem)
    expect(px(sheet.root.style.top) + natural.h).toBeLessThanOrEqual(300 - 35 - 15 + 1e-6);
  });

  it('UIF3.3 adds the body scrollTop to top (an absolute child scrolls with the content)', () => {
    // WRONG IMPLS KILLED: ignoring scrollTop.
    const { sheet, slot } = mount({ l: 110, t: 60, w: 50, h: 50 }, 40);
    placeContextSheet(sheet, slot.parentElement as HTMLElement, slot);
    expect(px(sheet.root.style.top)).toBeCloseTo(190, 6);
    expect(px(sheet.root.style.left)).toBeCloseTo(204.5, 6);
  });

  it('UIF3.3 a slot on the right half puts the sheet on the left; a full-width bottom slot flips it to the top corner', () => {
    // WRONG IMPLS KILLED: a fixed side; a bottom-only rule that covers the slot.
    const right = mount({ l: 400, t: 60, w: 60, h: 50 });
    const r1 = placeContextSheet(right.sheet, right.body, right.slot);
    expect(r1?.corner).toBe('bl');
    expect(px(right.sheet.root.style.left)).toBeCloseTo(15, 6);
    document.body.replaceChildren();
    const bottom = mount({ l: 100, t: 250, w: 400, h: 100 });
    const r2 = placeContextSheet(bottom.sheet, bottom.body, bottom.slot);
    expect(r2?.corner).toBe('tl');
    expect(px(bottom.sheet.root.style.left)).toBeCloseTo(15, 6);
    expect(px(bottom.sheet.root.style.top)).toBeCloseTo(15, 6);
  });

  it('UIF3.3 writes a height only when the sheet scrolls, and a later shorter sheet leaves no stale height', () => {
    // WRONG IMPLS KILLED: a height written on every placement; an inline height never cleared (the
    // second, shorter sheet would measure its own stale cap and keep it); a cap that ignores the
    // reserve or the inset (natural 400 in a 300px body, usable 265, minus 2 insets: 235).
    natural = { w: 180.5, h: 400 };
    const { sheet, slot, body } = mount({ l: 110, t: 60, w: 50, h: 50 });
    const first = placeContextSheet(sheet, body, slot);
    expect(first?.scrolls).toBe(true);
    expect(px(sheet.root.style.height)).toBeCloseTo(235, 6);
    expect(px(sheet.root.style.top)).toBeCloseTo(15, 6);

    natural = { w: 180.5, h: 100 };
    renderContextSheet(sheet, listC('Actions', ['a'], 'a'));
    const second = placeContextSheet(sheet, body, slot);
    expect(second?.scrolls).toBe(false);
    expect(sheet.root.style.height).toBe('');
    expect(px(sheet.root.style.top)).toBeCloseTo(150, 6);
  });

  it('UIF3.3 the detail variant is not anchored: placement returns null and clears any left, top and height an earlier list placement wrote', () => {
    // WRONG IMPLS KILLED: anchoring the prose sheet (it must stay CSS-centred); a detail placement
    // that returns early without clearing (the stale list offsets would defeat the centring); a
    // clear that leaves the height (a capped list height would cut the prose).
    natural = { w: 180.5, h: 400 };
    const { sheet, slot, body } = mount({ l: 110, t: 60, w: 50, h: 50 });
    placeContextSheet(sheet, body, slot);
    expect(sheet.root.style.left).not.toBe('');
    expect(sheet.root.style.height).not.toBe('');
    renderContextSheet(sheet, detailC('Info', 'Prose', ['close'], 'close'));
    const res = placeContextSheet(sheet, body, slot);
    expect(res).toBeNull();
    expect(sheet.root.style.left).toBe('');
    expect(sheet.root.style.top).toBe('');
    expect(sheet.root.style.height).toBe('');
    // a detail sheet that was never placed stays untouched
    const fresh = mount({ l: 110, t: 60, w: 50, h: 50 });
    renderContextSheet(fresh.sheet, detailC(undefined, 'Prose', ['close'], 'close'));
    expect(placeContextSheet(fresh.sheet, fresh.body, fresh.slot)).toBeNull();
    expect(fresh.sheet.root.style.left).toBe('');
    expect(fresh.sheet.root.style.top).toBe('');
  });
});

// --- UIF3.4: the pure anchor ----------------------------------------------------------------
const EPS = 1e-9;
const overlaps = (a: R, b: R): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

type Input = {
  area: R;
  slot: R;
  sheet: { w: number; h: number };
  inset: number;
  reserve: number;
  minHeight?: number;
};

const run = (inp: Input): ReturnType<typeof anchorSheet> => {
  const { minHeight, ...rest } = inp;
  const arg: AnchorInput = minHeight === undefined ? rest : { ...rest, minHeight };
  return anchorSheet(arg);
};

/** Every property the plan states, over one input. */
function checkAnchor(inp: Input, when: string): void {
  const { area, slot, sheet } = inp;
  const out = run(inp);
  const { rect, corner, scrolls } = out;
  // the plan's clamps: reserve at most half the area, inset at most a quarter of the smaller axis
  const reserve = Math.min(inp.reserve, area.h / 2);
  const usableH = area.h - reserve;
  const inset = Math.min(inp.inset, Math.min(area.w, usableH) / 4);
  const usableBottom = area.y + usableH;
  const minH = inp.minHeight ?? Math.max(1, 4 * inset);
  const wP = Math.min(sheet.w, area.w - 2 * inset);
  const maxH = usableH - 2 * inset;
  const h0 = Math.min(sheet.h, maxH);
  const msg = (what: string): string => `${when}: ${what} ${JSON.stringify(out)}`;

  expect(corner, msg('corner shape')).toMatch(/^[bt][lr]$/);
  // inside the area and clear of the reserve at the foot
  expect(rect.x >= area.x - EPS, msg('left edge inside')).toBe(true);
  expect(rect.x + rect.w <= area.x + area.w + EPS, msg('right edge inside')).toBe(true);
  expect(rect.y >= area.y - EPS, msg('top edge inside')).toBe(true);
  expect(rect.y + rect.h <= usableBottom + EPS, msg('bottom edge above the reserve')).toBe(true);
  expect(rect.h > 0, msg('positive height')).toBe(true);
  expect(rect.w > 0, msg('positive width')).toBe(true);
  expect(rect.w <= area.w + EPS, msg('width within the area')).toBe(true);
  expect(Math.abs(rect.w - wP) < 1e-9, msg('width is min(sheet, area - 2 inset)')).toBe(true);
  expect(rect.h <= sheet.h + EPS, msg('never taller than natural')).toBe(true);
  expect(scrolls, msg('scrolls is exactly rect.h < natural')).toBe(rect.h < sheet.h);

  // the side: away from the slot's centre; the exact centre goes left
  const side = slot.x + slot.w / 2 < area.x + area.w / 2 ? 'r' : 'l';
  expect(corner[1], msg('side away from the slot')).toBe(side);
  const x = side === 'r' ? area.x + area.w - wP - inset : area.x + inset;
  expect(Math.abs(rect.x - x) < 1e-9, msg('flush to the inset on that side')).toBe(true);

  // bottom first when clear; the top only when the bottom is hit
  const bottom: R = { x, y: usableBottom - h0 - inset, w: wP, h: h0 };
  const top: R = { x, y: area.y + inset, w: wP, h: h0 };
  if (!overlaps(bottom, slot)) {
    expect(corner[0], msg('bottom corner when clear')).toBe('b');
    expect(Math.abs(rect.h - h0) < 1e-9, msg('full height in the bottom corner')).toBe(true);
    expect(Math.abs(rect.y - bottom.y) < 1e-9, msg('resting at the foot minus the inset')).toBe(
      true,
    );
  } else if (!overlaps(top, slot)) {
    expect(corner[0], msg('top corner when only it is clear')).toBe('t');
    expect(Math.abs(rect.h - h0) < 1e-9, msg('full height in the top corner')).toBe(true);
    expect(Math.abs(rect.y - top.y) < 1e-9, msg('top corner at the inset')).toBe(true);
  }

  // a slot that leaves room for a floor-height sheet at any of the four inset corners is not covered
  const hmin = Math.min(minH, sheet.h, maxH);
  const corners: R[] = [];
  for (const cx of [area.x + inset, area.x + area.w - wP - inset]) {
    corners.push({ x: cx, y: area.y + inset, w: wP, h: hmin });
    corners.push({ x: cx, y: usableBottom - hmin - inset, w: wP, h: hmin });
  }
  if (corners.some((c) => !overlaps(c, slot))) {
    expect(overlaps(rect, slot), msg('the slot leaves room, so it must not be covered')).toBe(
      false,
    );
  }
}

const dim = fc.oneof(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 400 }));
const areaArb: fc.Arbitrary<R> = fc.record({
  x: fc.integer({ min: -50, max: 50 }),
  y: fc.integer({ min: -50, max: 50 }),
  w: dim,
  h: dim,
});
const slotArb: fc.Arbitrary<R> = fc.record({
  x: fc.integer({ min: -100, max: 500 }),
  y: fc.integer({ min: -100, max: 500 }),
  w: fc.integer({ min: 1, max: 500 }),
  h: fc.integer({ min: 1, max: 500 }),
});
const sheetArb = fc.record({
  w: fc.integer({ min: 1, max: 600 }),
  h: fc.integer({ min: 1, max: 1000 }),
});
const inputArb: fc.Arbitrary<Input> = fc.record({
  area: areaArb,
  slot: slotArb,
  sheet: sheetArb,
  inset: fc.integer({ min: 0, max: 100 }),
  reserve: fc.integer({ min: 0, max: 400 }),
});
// slots that span the whole width (a bar across the area): the capped-band branch
const barInputArb: fc.Arbitrary<Input> = fc
  .tuple(
    areaArb,
    fc.record({
      dx: fc.integer({ min: 0, max: 50 }),
      dy: fc.integer({ min: -50, max: 450 }),
      h: fc.integer({ min: 1, max: 300 }),
    }),
    sheetArb,
    fc.integer({ min: 0, max: 60 }),
    fc.integer({ min: 0, max: 100 }),
  )
  .map(([area, p, sheet, inset, reserve]) => ({
    area,
    slot: { x: area.x - p.dx, y: area.y + p.dy, w: area.w + 2 * p.dx, h: p.h },
    sheet,
    inset,
    reserve,
  }));

describe('anchorSheet (pure)', () => {
  it('UIF3.4 property: inside the area, positive, never wider or taller than allowed, scrolls exactly when shorter than natural', () => {
    // WRONG IMPLS KILLED: the reference negative height when inset*2 >= area.h; a rect leaving the
    // area on a tiny body; the reference "scrolls whenever capped" (a capped sheet that still shows
    // its natural height would report scrolling); a floor that grows a short sheet to minHeight.
    fc.assert(
      fc.property(inputArb, (inp) => {
        checkAnchor(inp, 'any slot');
      }),
      { numRuns: 1000 },
    );
  });

  it('UIF3.4 property: a slot spanning the whole width still gets a rect inside the area that covers it only when no room exists', () => {
    // WRONG IMPLS KILLED: a capped height measured against the wrong band; a cap that ignores the
    // reserve at the foot (the sheet would rest on the feedback strip); a corner chosen from the
    // smaller band.
    fc.assert(
      fc.property(barInputArb, (inp) => {
        checkAnchor(inp, 'bar slot');
      }),
      { numRuns: 1000 },
    );
  });

  it('UIF3.4 property: an explicit minHeight keeps the rect inside the area with a positive height', () => {
    fc.assert(
      fc.property(inputArb, fc.integer({ min: 1, max: 300 }), (inp, minHeight) => {
        checkAnchor({ ...inp, minHeight }, `minHeight ${minHeight}`);
      }),
      { numRuns: 500 },
    );
  });

  it('UIF3.4 the plan pinned counterexamples hold every property (a slot partly outside the area, a huge inset, a reserve over half the area, inset 0)', () => {
    // WRONG IMPLS KILLED: the two shrunk counterexamples the plan review found against the
    // reference: a negative or zero height from an unclamped inset, and a rect on the reserve
    // from an unclamped reserve.
    const one: Input = {
      area: { x: 43, y: 41, w: 31, h: 346 },
      slot: { x: 27, y: 41, w: 28, h: 243 },
      sheet: { w: 127, h: 866 },
      inset: 87,
      reserve: 18,
    };
    checkAnchor(one, 'counterexample 1');
    const r1 = run(one);
    expect(r1.corner).toBe('br');
    expect(r1.scrolls).toBe(true);

    const two: Input = {
      area: { x: 0, y: 0, w: 174, h: 15 },
      slot: { x: 53, y: 12, w: 248, h: 47 },
      sheet: { w: 320, h: 806 },
      inset: 0,
      reserve: 27,
    };
    checkAnchor(two, 'counterexample 2');
    // reserve clamps to 7.5: the usable band is 7.5 tall, the slot starts at 12, so the bottom
    // corner is clear and takes the whole usable height
    expect(run(two)).toEqual({
      corner: 'bl',
      rect: { x: 0, y: 0, w: 174, h: 7.5 },
      scrolls: true,
    });
  });

  const AREA: R = { x: 0, y: 0, w: 400, h: 300 };
  const SHEET = { w: 100, h: 80 };

  it('UIF3.4 worked: a slot in the left half puts the sheet in the bottom-right corner, growing upward from the foot', () => {
    // WRONG IMPLS KILLED: a sheet on the slot side; a top-first rule; a missing inset.
    expect(
      run({
        area: AREA,
        slot: { x: 20, y: 100, w: 60, h: 60 },
        sheet: SHEET,
        inset: 10,
        reserve: 0,
      }),
    ).toEqual({ corner: 'br', rect: { x: 290, y: 210, w: 100, h: 80 }, scrolls: false });
    expect(
      run({
        area: AREA,
        slot: { x: 300, y: 100, w: 60, h: 60 },
        sheet: SHEET,
        inset: 10,
        reserve: 0,
      }),
    ).toEqual({ corner: 'bl', rect: { x: 10, y: 210, w: 100, h: 80 }, scrolls: false });
  });

  it('UIF3.4 worked: a slot centred exactly on the area centre sends the sheet left (strictly-left-of-centre goes right)', () => {
    // WRONG IMPLS KILLED: a <= comparison at the boundary.
    const out = run({
      area: AREA,
      slot: { x: 150, y: 20, w: 100, h: 20 },
      sheet: SHEET,
      inset: 10,
      reserve: 0,
    });
    expect(out.corner).toBe('bl');
    expect(out.rect.x).toBe(10);
  });

  it('UIF3.4 worked: a full-width slot on the bottom row flips the sheet to the top corner', () => {
    // WRONG IMPLS KILLED: a bottom-only rule; a flip taken when the bottom is clear.
    expect(
      run({
        area: AREA,
        slot: { x: 0, y: 220, w: 400, h: 80 },
        sheet: SHEET,
        inset: 10,
        reserve: 0,
      }),
    ).toEqual({ corner: 'tl', rect: { x: 10, y: 10, w: 100, h: 80 }, scrolls: false });
  });

  it('UIF3.4 worked: a slot leaving neither corner caps the sheet to the taller free band and scrolls', () => {
    // WRONG IMPLS KILLED: the shorter band; a cap that forgets the two insets; a sheet kept at its
    // natural height over the slot; scrolls false when capped.
    const tall = { w: 100, h: 250 };
    expect(
      run({
        area: AREA,
        slot: { x: 0, y: 140, w: 400, h: 100 },
        sheet: tall,
        inset: 10,
        reserve: 0,
      }),
    ).toEqual({ corner: 'tl', rect: { x: 10, y: 10, w: 100, h: 120 }, scrolls: true });
    expect(
      run({
        area: AREA,
        slot: { x: 0, y: 60, w: 400, h: 100 },
        sheet: tall,
        inset: 10,
        reserve: 0,
      }),
    ).toEqual({ corner: 'bl', rect: { x: 10, y: 170, w: 100, h: 120 }, scrolls: true });
  });

  it('UIF3.4 worked: the floor is min(minHeight, natural), so a short sheet is never grown past its natural height', () => {
    // WRONG IMPLS KILLED: the reference growing a short sheet to minHeight (covering a slot it did
    // not need to); no floor at all (zero or negative height when the bands are thin).
    const slot = { x: 0, y: 15, w: 400, h: 270 };
    expect(run({ area: AREA, slot, sheet: { w: 100, h: 250 }, inset: 10, reserve: 0 })).toEqual({
      corner: 'tl',
      rect: { x: 10, y: 10, w: 100, h: 40 },
      scrolls: true,
    });
    expect(run({ area: AREA, slot, sheet: { w: 100, h: 30 }, inset: 10, reserve: 0 })).toEqual({
      corner: 'tl',
      rect: { x: 10, y: 10, w: 100, h: 30 },
      scrolls: false,
    });
  });

  it('UIF3.4 worked: the reserve at the foot is honored, so a bottom-corner sheet rests above it', () => {
    // WRONG IMPLS KILLED: ignoring the reserve (the sheet would sit on the 1.75rem feedback strip).
    const out = run({
      area: AREA,
      slot: { x: 20, y: 20, w: 60, h: 60 },
      sheet: SHEET,
      inset: 10,
      reserve: 50,
    });
    expect(out.corner).toBe('br');
    expect(out.rect).toEqual({ x: 290, y: 160, w: 100, h: 80 });
    expect(out.rect.y + out.rect.h).toBeLessThanOrEqual(300 - 50 - 10);
  });

  it('UIF3.4 worked: a width wider than the area is clamped inside the insets', () => {
    // WRONG IMPLS KILLED: a width taken from the sheet unclamped (the rect leaves the area).
    const out = run({
      area: AREA,
      slot: { x: 20, y: 20, w: 20, h: 20 },
      sheet: { w: 900, h: 50 },
      inset: 10,
      reserve: 0,
    });
    expect(out.rect.w).toBe(380);
    expect(out.rect.x).toBe(10);
  });
});
