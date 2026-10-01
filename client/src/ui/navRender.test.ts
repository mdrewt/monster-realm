// @vitest-environment happy-dom
/**
 * navRender.test.ts: the nav DOM shell (ctl-4, CTL4.5).
 *
 * `renderNav` writes the ACTIVE list or grid into ONE persistent container the caller owns: the
 * container is the single tab stop, names the active item through `aria-activedescendant`, and
 * is diffed in place so DOM focus on it survives every render. `renderTabs` writes the tab strip.
 *
 * Layouts and states are plain literals here (not built through nav.ts), so this suite is red on
 * the missing render code alone and stays independent of the nav core.
 *
 * The contract proven here:
 *  - one tab stop: the container has tabindex="0"; no item and no tab has a tabindex;
 *  - roles: listbox > option, grid > row > gridcell, tablist > tab;
 *  - ids are `${frame}-${tab ?? 'root'}-${key}`, unique in the document; the active descendant
 *    resolves to a connected element or is absent;
 *  - re-rendering reuses item nodes by key, fixes the order, removes the stale, leaves no stale
 *    row wrappers, clears reused nodes before `fill`, and never moves focus off the container;
 *  - the active item is marked by class AND `aria-selected`; disabled by class AND aria-disabled,
 *    both toggled in both directions;
 *  - the active item is scrolled into view when the active key changes.
 *
 * Caller text is arbitrary; the kit writes no string of its own to the DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemLayout, NavItem, NavLayout, NavState } from './nav';
import { navItemId, navTabId, renderNav, renderTabs } from './navRender';

// --- builders -----------------------------------------------------------------------------
const itm = (key: string, enabled = true): NavItem => ({ key, enabled });
const LIST = (...keys: string[]): ItemLayout => ({ kind: 'list', items: keys.map((k) => itm(k)) });
const GRID = (cols: number, ...keys: string[]): ItemLayout => ({
  kind: 'grid',
  items: keys.map((k) => itm(k)),
  cols,
});
const TABS = (...pairs: Array<readonly [string, ItemLayout]>): NavLayout => ({
  kind: 'tabs',
  tabs: pairs.map(([key, layout]) => ({ key, layout })),
});
const st = (
  item: string | null,
  tab: string | null = null,
  perTab: Record<string, string> = {},
): NavState => ({ tab, item, perTab });

const fillKey = (el: HTMLElement, it: NavItem): void => {
  el.textContent = it.key;
};
const OPTS = { frame: 'f', fill: fillKey } as const;

let container: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement('div');
  document.body.appendChild(container);
});

/** Item elements in document order, keyed by `data-nav-key`. */
const nodes = (c: HTMLElement): Map<string, HTMLElement> =>
  new Map(
    Array.from(c.querySelectorAll<HTMLElement>('[data-nav-key]')).map((e) => [
      e.getAttribute('data-nav-key') as string,
      e,
    ]),
  );
const orderOf = (c: HTMLElement): string[] => Array.from(nodes(c).keys());
const node = (c: HTMLElement, key: string): HTMLElement => {
  const el = nodes(c).get(key);
  if (el === undefined) throw new Error(`no rendered item ${key}`);
  return el;
};

// --- CTL4.5 --------------------------------------------------------------------------------
describe('nav render', () => {
  it('CTL4-5-SINGLE-TABSTOP makes the container the only tab stop; items and tabs carry no tabindex', () => {
    renderNav(container, LIST('a', 'b', 'c'), st('b'), OPTS);
    expect(container.getAttribute('tabindex')).toBe('0');
    expect(container.querySelectorAll('[tabindex]').length).toBe(0);
    expect(document.querySelectorAll('[tabindex]').length).toBe(1);

    renderNav(container, GRID(2, 'a', 'b', 'c'), st('a'), OPTS);
    expect(container.getAttribute('tabindex')).toBe('0');
    expect(container.querySelectorAll('[tabindex]').length).toBe(0);

    // a disabled item is no tab stop either
    const withDisabled: ItemLayout = { kind: 'list', items: [itm('a'), itm('b', false)] };
    renderNav(container, withDisabled, st('b'), OPTS);
    expect(container.querySelectorAll('[tabindex]').length).toBe(0);

    // tabbed: the strip's tabs carry no tabindex, so the container is still the only stop
    const strip = document.createElement('div');
    document.body.appendChild(strip);
    const layout = TABS(['x', LIST('x1', 'x2')], ['y', GRID(2, 'y1', 'y2', 'y3')]);
    renderNav(container, layout, st('x1', 'x'), OPTS);
    renderTabs(strip, layout, st('x1', 'x'), { frame: 'f', label: (t) => t.key });
    expect(strip.querySelectorAll('[tabindex]').length).toBe(0);
    expect(document.querySelectorAll('[tabindex]').length).toBe(1);
    expect(document.querySelector('[tabindex]')).toBe(container);
    // the container is still the very node the caller made, still in place
    expect(container.parentElement).toBe(document.body);
  });

  it('CTL4-5-ROLES uses listbox/option, grid/row/gridcell and tablist/tab', () => {
    renderNav(container, LIST('a', 'b', 'c'), st('a'), OPTS);
    expect(container.getAttribute('role')).toBe('listbox');
    const opts = Array.from(container.querySelectorAll('[data-nav-key]'));
    expect(opts.length).toBe(3);
    for (const el of opts) expect(el.getAttribute('role')).toBe('option');
    expect(container.querySelectorAll('[role="row"]').length).toBe(0);

    // grid: 8 items in 3 columns are rows of 3, 3 and 2 gridcells
    renderNav(container, GRID(3, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), st('a'), OPTS);
    expect(container.getAttribute('role')).toBe('grid');
    const rows = Array.from(container.children);
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.getAttribute('role')).toBe('row');
    expect(rows.map((r) => r.children.length)).toEqual([3, 3, 2]);
    for (const row of rows) {
      for (const cell of Array.from(row.children)) {
        expect(cell.getAttribute('role')).toBe('gridcell');
        expect(cell.getAttribute('data-nav-key')).not.toBeNull();
      }
    }
    expect(orderOf(container)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

    // a tabbed layout renders the ACTIVE tab's inner layout with that layout's roles
    const layout = TABS(['x', LIST('x1', 'x2')], ['y', GRID(2, 'y1', 'y2', 'y3')]);
    renderNav(container, layout, st('x1', 'x'), OPTS);
    expect(container.getAttribute('role')).toBe('listbox');
    expect(orderOf(container)).toEqual(['x1', 'x2']);
    renderNav(container, layout, st('y1', 'y'), OPTS);
    expect(container.getAttribute('role')).toBe('grid');
    expect(orderOf(container)).toEqual(['y1', 'y2', 'y3']);
    expect(container.querySelectorAll('[role="row"]').length).toBe(2);

    // the tab strip is a tablist of tabs
    const strip = document.createElement('div');
    document.body.appendChild(strip);
    renderTabs(strip, layout, st('y1', 'y'), { frame: 'f', label: (t) => t.key });
    expect(strip.getAttribute('role')).toBe('tablist');
    expect(Array.from(strip.children).map((e) => e.getAttribute('role'))).toEqual(['tab', 'tab']);
  });

  it('CTL4-5-IDS gives stable unique ids and an active descendant that names a connected element', () => {
    expect(navItemId('menu', null, 'bag')).toBe('menu-root-bag');
    expect(navItemId('shop', 'buy', 'potion')).toBe('shop-buy-potion');
    expect(navTabId('shop', 'buy')).toBe('shop-tab-buy');

    // list: tab segment is "root"
    renderNav(container, LIST('a', 'b', 'c'), st('b'), OPTS);
    for (const key of ['a', 'b', 'c']) {
      expect(node(container, key).id).toBe(`f-root-${key}`);
      expect(node(container, key).id).toBe(navItemId('f', null, key));
    }
    const active = container.getAttribute('aria-activedescendant');
    expect(active).toBe('f-root-b');
    expect(document.getElementById(active as string)).toBe(node(container, 'b'));
    expect(node(container, 'b').isConnected).toBe(true);

    // ids survive a re-render unchanged for surviving keys
    renderNav(container, LIST('a', 'b', 'c', 'd'), st('d'), OPTS);
    expect(node(container, 'a').id).toBe('f-root-a');
    expect(container.getAttribute('aria-activedescendant')).toBe('f-root-d');
    expect(document.getElementById('f-root-d')).toBe(node(container, 'd'));

    // grid ids too
    renderNav(container, GRID(2, 'a', 'b', 'c'), st('c'), OPTS);
    expect(node(container, 'c').id).toBe('f-root-c');
    expect(document.getElementById(container.getAttribute('aria-activedescendant') as string)).toBe(
      node(container, 'c'),
    );

    // tabbed: the tab key is the segment; the same item key in two tabs never collides
    const strip = document.createElement('div');
    document.body.appendChild(strip);
    const layout = TABS(['x', LIST('same', 'x2')], ['y', LIST('same', 'y2')]);
    for (const tab of ['x', 'y']) {
      renderNav(container, layout, st('same', tab), OPTS);
      renderTabs(strip, layout, st('same', tab), { frame: 'f', label: (t) => t.key });
      expect(node(container, 'same').id).toBe(`f-${tab}-same`);
      expect(node(container, 'same').id).toBe(navItemId('f', tab, 'same'));
      const desc = container.getAttribute('aria-activedescendant');
      expect(desc).toBe(`f-${tab}-same`);
      expect(document.getElementById(desc as string)).toBe(node(container, 'same'));
      const ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.id);
      expect(new Set(ids).size, `ids unique after rendering tab ${tab}`).toBe(ids.length);
      expect(node(container, 'same').getAttribute('data-nav-tab')).toBe(tab);
    }
    // tab ids sit in a different namespace from item ids
    expect(strip.querySelector('#f-tab-x')).not.toBeNull();
    expect(strip.querySelector('#f-tab-y')).not.toBeNull();

    // data-nav-key names the key on every item
    expect(nodes(container).size).toBe(2);
    expect(orderOf(container)).toEqual(['same', 'y2']);

    // empty layout, no active item, or a phantom key: no active descendant (and no stale one)
    renderNav(container, LIST('a', 'b'), st('a'), OPTS);
    expect(container.hasAttribute('aria-activedescendant')).toBe(true);
    renderNav(container, LIST(), st(null), OPTS);
    expect(container.hasAttribute('aria-activedescendant')).toBe(false);
    expect(container.children.length).toBe(0);
    renderNav(container, LIST('a', 'b'), st('a'), OPTS);
    renderNav(container, LIST('a', 'b'), st(null), OPTS);
    expect(container.hasAttribute('aria-activedescendant')).toBe(false);
    renderNav(container, LIST('a', 'b'), st('ghost'), OPTS);
    expect(container.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('CTL4-5-DIFF-FOCUS re-renders in place: focus stays on the container and surviving nodes are reused', () => {
    const fill = vi.fn((el: HTMLElement, it: NavItem) => {
      const span = document.createElement('span');
      span.textContent = it.key;
      el.appendChild(span);
    });
    const o = { frame: 'f', fill } as const;
    const survivors = (prev: Map<string, HTMLElement>, next: Map<string, HTMLElement>): void => {
      for (const [key, el] of next) {
        if (prev.has(key)) expect(el, `node for ${key} reused`).toBe(prev.get(key));
      }
    };
    const containerStays = (label: string): void => {
      expect(document.activeElement, `focus after ${label}`).toBe(container);
      expect(container.isConnected, `container attached after ${label}`).toBe(true);
      expect(container.parentElement, `container parent after ${label}`).toBe(document.body);
      expect(container.getAttribute('tabindex'), `tabindex after ${label}`).toBe('0');
    };

    renderNav(container, LIST('a', 'b', 'c'), st('a'), o);
    container.focus();
    expect(document.activeElement).toBe(container);
    let prev = nodes(container);
    expect(fill).toHaveBeenCalledTimes(3);

    // (a) a different active key
    renderNav(container, LIST('a', 'b', 'c'), st('b'), o);
    containerStays('active change');
    let next = nodes(container);
    survivors(prev, next);
    expect(orderOf(container)).toEqual(['a', 'b', 'c']);
    expect(container.getAttribute('aria-activedescendant')).toBe('f-root-b');
    // fill ran again on the reused nodes and did not accumulate children
    expect(fill).toHaveBeenCalledTimes(6);
    for (const [key, el] of next) {
      expect(el.querySelectorAll('span').length, `span count for ${key}`).toBe(1);
      expect(el.children.length, `child count for ${key}`).toBe(1);
      expect(el.textContent).toBe(key);
    }
    prev = next;

    // (b) reordered content [a, b, c] -> [c, a, b]
    renderNav(container, LIST('c', 'a', 'b'), st('b'), o);
    containerStays('reorder');
    next = nodes(container);
    survivors(prev, next);
    expect(orderOf(container)).toEqual(['c', 'a', 'b']);
    expect(Array.from(container.children).map((e) => e.getAttribute('data-nav-key'))).toEqual([
      'c',
      'a',
      'b',
    ]);
    prev = next;

    // (c) an item removed
    const removed = node(container, 'b');
    renderNav(container, LIST('c', 'a'), st('a'), o);
    containerStays('removal');
    next = nodes(container);
    survivors(prev, next);
    expect(removed.isConnected).toBe(false);
    expect(container.contains(removed)).toBe(false);
    expect(container.children.length).toBe(2);
    expect(orderOf(container)).toEqual(['c', 'a']);
    prev = next;

    // (d) list -> grid -> narrower grid -> list
    renderNav(container, GRID(2, 'c', 'a', 'd'), st('a'), o);
    containerStays('list to grid');
    expect(container.getAttribute('role')).toBe('grid');
    next = nodes(container);
    survivors(prev, next);
    expect(Array.from(container.children).map((r) => r.getAttribute('role'))).toEqual([
      'row',
      'row',
    ]);
    expect(Array.from(container.children).map((r) => r.children.length)).toEqual([2, 1]);
    expect(orderOf(container)).toEqual(['c', 'a', 'd']);
    prev = next;

    renderNav(container, GRID(1, 'c', 'a', 'd'), st('a'), o);
    containerStays('grid to 1 column');
    next = nodes(container);
    survivors(prev, next);
    expect(container.querySelectorAll('[role="row"]').length).toBe(3);
    expect(container.children.length).toBe(3);
    prev = next;

    renderNav(container, LIST('c', 'a', 'd'), st('a'), o);
    containerStays('grid to list');
    expect(container.getAttribute('role')).toBe('listbox');
    next = nodes(container);
    survivors(prev, next);
    // no stale row wrappers: the items are direct children again
    expect(container.querySelectorAll('[role="row"]').length).toBe(0);
    expect(container.children.length).toBe(3);
    for (const el of next.values()) {
      expect(el.parentElement).toBe(container);
      expect(el.getAttribute('role')).toBe('option');
      expect(el.querySelectorAll('span').length).toBe(1);
    }
    expect(orderOf(container)).toEqual(['c', 'a', 'd']);

    // a tab switch re-renders into the same container too
    const layout = TABS(['x', LIST('x1')], ['y', GRID(2, 'y1', 'y2')]);
    renderNav(container, layout, st('x1', 'x'), o);
    containerStays('tabbed render');
    renderNav(container, layout, st('y1', 'y'), o);
    containerStays('tab switch');
    expect(container.getAttribute('role')).toBe('grid');
    expect(orderOf(container)).toEqual(['y1', 'y2']);
  });

  it('CTL4-5-ACTIVE-MARK marks the active item by class and aria-selected, and disabled by class and aria-disabled, both ways', () => {
    const mk = (flags: Record<string, boolean>): ItemLayout => ({
      kind: 'list',
      items: Object.entries(flags).map(([key, enabled]) => itm(key, enabled)),
    });
    const el = (key: string): HTMLElement => node(container, key);

    renderNav(container, mk({ a: true, b: false, c: true }), st('b'), OPTS);
    for (const key of ['a', 'b', 'c']) expect(el(key).classList.contains('mr-nav-item')).toBe(true);
    // active + disabled: both marks on the same item
    expect(el('b').classList.contains('is-active')).toBe(true);
    expect(el('b').getAttribute('aria-selected')).toBe('true');
    expect(el('b').classList.contains('is-disabled')).toBe(true);
    expect(el('b').getAttribute('aria-disabled')).toBe('true');
    // inactive enabled items: explicit aria-selected="false", no disabled marks at all
    for (const key of ['a', 'c']) {
      expect(el(key).classList.contains('is-active'), key).toBe(false);
      expect(el(key).getAttribute('aria-selected'), key).toBe('false');
      expect(el(key).classList.contains('is-disabled'), key).toBe(false);
      expect(el(key).hasAttribute('aria-disabled'), key).toBe(false);
    }

    // b is re-enabled and the active mark moves to c: every stale mark is removed
    renderNav(container, mk({ a: true, b: true, c: true }), st('c'), OPTS);
    expect(el('b').classList.contains('is-active')).toBe(false);
    expect(el('b').getAttribute('aria-selected')).toBe('false');
    expect(el('b').classList.contains('is-disabled')).toBe(false);
    expect(el('b').hasAttribute('aria-disabled')).toBe(false);
    expect(el('c').classList.contains('is-active')).toBe(true);
    expect(el('c').getAttribute('aria-selected')).toBe('true');
    expect(el('a').classList.contains('is-active')).toBe(false);

    // a becomes disabled and active; c is no longer marked
    renderNav(container, mk({ a: false, b: true, c: true }), st('a'), OPTS);
    expect(el('a').classList.contains('is-active')).toBe(true);
    expect(el('a').classList.contains('is-disabled')).toBe(true);
    expect(el('a').getAttribute('aria-disabled')).toBe('true');
    expect(el('c').classList.contains('is-active')).toBe(false);
    expect(el('c').getAttribute('aria-selected')).toBe('false');
    expect(container.querySelectorAll('.is-active').length).toBe(1);
    expect(container.querySelectorAll('[aria-selected="true"]').length).toBe(1);

    // no active item: nothing is marked and everything is explicitly unselected
    renderNav(container, mk({ a: true, b: true }), st(null), OPTS);
    expect(container.querySelectorAll('.is-active').length).toBe(0);
    expect(container.querySelectorAll('[aria-selected="true"]').length).toBe(0);
    expect(container.querySelectorAll('[aria-selected="false"]').length).toBe(2);

    // gridcells carry the same marks
    const g: ItemLayout = { kind: 'grid', cols: 2, items: [itm('a'), itm('b', false), itm('c')] };
    renderNav(container, g, st('b'), OPTS);
    expect(el('b').getAttribute('role')).toBe('gridcell');
    expect(el('b').classList.contains('is-active')).toBe(true);
    expect(el('b').getAttribute('aria-selected')).toBe('true');
    expect(el('b').getAttribute('aria-disabled')).toBe('true');
    expect(el('a').getAttribute('aria-selected')).toBe('false');
  });

  it('CTL4-5-TABS renders a tablist of tabs and labels the container by the active tab', () => {
    const layout = TABS(['x', LIST('x1', 'x2')], ['y', LIST('y1')], ['z', LIST()]);
    const strip = document.createElement('div');
    document.body.appendChild(strip);
    const labelled: string[] = [];
    const label = (t: { readonly key: string }): string => {
      labelled.push(t.key);
      return `Label ${t.key}`;
    };

    renderTabs(strip, layout, st('x1', 'x'), { frame: 'f', label });
    expect(strip.getAttribute('role')).toBe('tablist');
    const tabEls = Array.from(strip.children);
    expect(tabEls.length).toBe(3);
    expect(tabEls.map((e) => e.getAttribute('role'))).toEqual(['tab', 'tab', 'tab']);
    expect(tabEls.map((e) => e.id)).toEqual(['f-tab-x', 'f-tab-y', 'f-tab-z']);
    expect(tabEls.map((e) => e.id)).toEqual(['x', 'y', 'z'].map((k) => navTabId('f', k)));
    expect(tabEls.map((e) => e.getAttribute('data-nav-tab'))).toEqual(['x', 'y', 'z']);
    expect(tabEls.map((e) => e.textContent)).toEqual(['Label x', 'Label y', 'Label z']);
    expect(labelled).toEqual(expect.arrayContaining(['x', 'y', 'z']));
    expect(tabEls.map((e) => e.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabEls.map((e) => e.classList.contains('is-active'))).toEqual([true, false, false]);
    expect(strip.querySelectorAll('[tabindex]').length).toBe(0);

    // switching tab toggles both marks
    renderTabs(strip, layout, st('y1', 'y'), { frame: 'f', label });
    const after = Array.from(strip.children);
    expect(after.map((e) => e.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(after.map((e) => e.classList.contains('is-active'))).toEqual([false, true, false]);

    // a removed tab leaves the strip
    const fewer = TABS(['x', LIST('x1')], ['y', LIST('y1')]);
    renderTabs(strip, fewer, st('y1', 'y'), { frame: 'f', label });
    expect(Array.from(strip.children).map((e) => e.id)).toEqual(['f-tab-x', 'f-tab-y']);

    // the container is labelled by the active tab id
    renderNav(container, layout, st('x1', 'x'), OPTS);
    expect(container.getAttribute('aria-labelledby')).toBe('f-tab-x');
    renderNav(container, layout, st('y1', 'y'), OPTS);
    expect(container.getAttribute('aria-labelledby')).toBe('f-tab-y');
    // ... even when the caller also passes a label for the non-tab case
    renderNav(container, layout, st('x1', 'x'), { ...OPTS, labelledBy: 'title' });
    expect(container.getAttribute('aria-labelledby')).toBe('f-tab-x');

    // a non-tab layout is labelled by the caller's element, or not at all
    renderNav(container, LIST('a'), st('a'), { ...OPTS, labelledBy: 'menu-title' });
    expect(container.getAttribute('aria-labelledby')).toBe('menu-title');
    renderNav(container, LIST('a'), st('a'), OPTS);
    expect(container.hasAttribute('aria-labelledby')).toBe(false);
    renderNav(container, layout, st('x1', 'x'), OPTS);
    expect(container.getAttribute('aria-labelledby')).toBe('f-tab-x');
    renderNav(container, GRID(2, 'a', 'b'), st('a'), OPTS);
    expect(container.hasAttribute('aria-labelledby')).toBe(false);

    // a non-tabs layout empties the strip
    renderTabs(strip, LIST('a', 'b'), st('a'), { frame: 'f', label });
    expect(strip.children.length).toBe(0);
    renderTabs(strip, layout, st('x1', 'x'), { frame: 'f', label });
    expect(strip.children.length).toBe(3);
    renderTabs(strip, GRID(2, 'a'), st('a'), { frame: 'f', label });
    expect(strip.children.length).toBe(0);
  });
});

// --- review-lens hardening (round 2): untagged, so each CTL4 tag stays in exactly one test ------
describe('nav render hardening', () => {
  const RUNAWAY = 'runaway render loop';

  /** Run renderNav and return what it threw (undefined when it returned). A createElement budget
   *  turns an unbounded row loop into a thrown RUNAWAY error instead of hanging the run. */
  function renderCaught(layout: NavLayout, state: NavState, frame = 'f'): unknown {
    const real = document.createElement.bind(document);
    let made = 0;
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((
      ...args: Parameters<Document['createElement']>
    ) => {
      made += 1;
      if (made > 5000) throw new Error(RUNAWAY);
      return real(...args);
    }) as unknown as Document['createElement']);
    try {
      renderNav(container, layout, state, { frame, fill: fillKey });
      return undefined;
    } catch (e) {
      return e;
    } finally {
      spy.mockRestore();
    }
  }

  it('renderNav rejects a hand-built grid with an invalid cols instead of looping', () => {
    for (const cols of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = renderCaught(GRID(cols, 'a', 'b', 'c'), st('a'));
      expect(err, `cols ${cols} must throw`).toBeInstanceOf(Error);
      expect((err as Error).message, `cols ${cols} must be rejected, not run away`).not.toBe(
        RUNAWAY,
      );
      // the same layout inside a tab is rejected too
      const tabbed = TABS(['t', GRID(cols, 'a', 'b')]);
      const tabErr = renderCaught(tabbed, st('a', 't'));
      expect(tabErr, `tab cols ${cols} must throw`).toBeInstanceOf(Error);
      expect((tabErr as Error).message).not.toBe(RUNAWAY);
    }
    // a valid cols still renders
    expect(renderCaught(GRID(2, 'a', 'b', 'c'), st('a'))).toBeUndefined();
  });

  it('renderNav validates the frame id: non-empty, no whitespace, no hyphen', () => {
    for (const bad of ['', 'my frame', 'a-b', ' ', 'a\tb', 'x ']) {
      expect(renderCaught(LIST('a'), st('a'), bad), `frame ${JSON.stringify(bad)}`).toBeInstanceOf(
        Error,
      );
    }
    for (const good of ['menuView', 'shop', 'f']) {
      expect(renderCaught(LIST('a'), st('a'), good), `frame ${good}`).toBeUndefined();
      expect(node(container, 'a').id).toBe(`${good}-root-a`);
    }
  });

  it('a reused node comes back with the kit classes only: fill-added classes do not stick', () => {
    // Contract: `fill` owns an item's children, and the kit resets the node's classes every
    // render. Attributes other than the kit's own are NOT promised to survive or to be cleared.
    const fill = (el: HTMLElement, it: NavItem): void => {
      el.textContent = it.key;
      if (!it.enabled) el.classList.add('x');
    };
    const o = { frame: 'f', fill } as const;
    const mk = (enabled: boolean): ItemLayout => ({
      kind: 'list',
      items: [itm('a'), { key: 'b', enabled }],
    });

    renderNav(container, mk(false), st('a'), o);
    const b = node(container, 'b');
    expect(b.classList.contains('x')).toBe(true);
    expect(b.classList.contains('is-disabled')).toBe(true);

    renderNav(container, mk(true), st('a'), o);
    expect(node(container, 'b')).toBe(b);
    expect(b.classList.contains('x')).toBe(false);
    expect(b.classList.contains('mr-nav-item')).toBe(true);
    expect(b.classList.contains('is-disabled')).toBe(false);
    expect(b.classList.contains('is-active')).toBe(false);
  });

  it('grid rows carry an inline column template naming the column count', () => {
    for (const cols of [2, 3]) {
      renderNav(container, GRID(cols, 'a', 'b', 'c', 'd', 'e', 'f', 'g'), st('a'), OPTS);
      const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="row"]'));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.style.gridTemplateColumns, `cols ${cols}`).toContain(`repeat(${cols}`);
      }
    }
  });

  it('an unchanged re-render moves no item and no row (list and grid)', () => {
    const cases: ReadonlyArray<readonly [string, ItemLayout]> = [
      ['list', LIST('a', 'b', 'c', 'd', 'e')],
      ['grid', GRID(2, 'a', 'b', 'c', 'd', 'e')],
    ];
    for (const [name, layout] of cases) {
      document.body.replaceChildren();
      container = document.createElement('div');
      document.body.appendChild(container);
      renderNav(container, layout, st('b'), OPTS);
      const before = nodes(container);
      const observer = new MutationObserver(() => undefined);
      observer.observe(container, { childList: true, subtree: true });
      renderNav(container, layout, st('b'), OPTS);
      const records = observer.takeRecords();
      observer.disconnect();
      // fill's own writes land on item elements; the container and the rows are never touched
      const structural = records.filter(
        (r) => r.target === container || (r.target as HTMLElement).getAttribute?.('role') === 'row',
      );
      expect(structural.length, `${name}: structural childList records`).toBe(0);
      for (const [key, el] of nodes(container)) {
        expect(el, `${name}: node ${key} reused`).toBe(before.get(key));
      }
    }
  });

  it('a grid re-render with a different active key keeps the very same row nodes', () => {
    const layout = GRID(3, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
    renderNav(container, layout, st('a'), OPTS);
    const rowsBefore = Array.from(container.children);
    expect(rowsBefore.length).toBe(3);
    renderNav(container, layout, st('e'), OPTS);
    const rowsAfter = Array.from(container.children);
    expect(rowsAfter.length).toBe(3);
    rowsAfter.forEach((row, i) => {
      expect(row, `row ${i} reused`).toBe(rowsBefore[i]);
    });
  });

  it('a container pre-set to tabindex -1 becomes the tab stop (0) after renderNav', () => {
    container.setAttribute('tabindex', '-1');
    renderNav(container, LIST('a', 'b'), st('a'), OPTS);
    expect(container.getAttribute('tabindex')).toBe('0');
  });
});

// --- scrolling the active item into view ----------------------------------------------------
describe('nav render scrolling', () => {
  const calls: Array<{ readonly el: unknown; readonly arg: unknown }> = [];
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    calls.length = 0;
    original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value(this: HTMLElement, arg?: unknown) {
        calls.push({ el: this, arg });
      },
    });
  });
  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(proto, 'scrollIntoView');
    else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
  });

  it('scrolls the newly active element into view when the active key changes, and only then', () => {
    renderNav(container, LIST('a', 'b', 'c'), st('a'), OPTS);
    calls.length = 0;

    // unchanged active key: no scroll
    renderNav(container, LIST('a', 'b', 'c'), st('a'), OPTS);
    expect(calls.length).toBe(0);

    // changed: exactly one scroll, on the new active element, with block "nearest"
    renderNav(container, LIST('a', 'b', 'c'), st('c'), OPTS);
    expect(calls.length).toBe(1);
    expect(calls[0].el).toBe(node(container, 'c'));
    expect(calls[0].arg).toEqual({ block: 'nearest' });

    // unchanged again
    calls.length = 0;
    renderNav(container, LIST('a', 'b', 'c'), st('c'), OPTS);
    expect(calls.length).toBe(0);

    // and back
    renderNav(container, LIST('a', 'b', 'c'), st('a'), OPTS);
    expect(calls.length).toBe(1);
    expect(calls[0].el).toBe(node(container, 'a'));
  });

  it('a first render into a detached container still scrolls once it is attached and rendered', () => {
    const detached = document.createElement('div');
    renderNav(detached, LIST('a', 'b', 'c'), st('c'), OPTS);
    expect(detached.isConnected).toBe(false);
    // whatever the detached render did, only the attached render is judged
    calls.length = 0;

    document.body.appendChild(detached);
    renderNav(detached, LIST('a', 'b', 'c'), st('c'), OPTS);
    expect(calls.length).toBe(1);
    expect(calls[0].el).toBe(nodes(detached).get('c'));
    expect(calls[0].arg).toEqual({ block: 'nearest' });

    // connected and unchanged: no scroll again
    calls.length = 0;
    renderNav(detached, LIST('a', 'b', 'c'), st('c'), OPTS);
    expect(calls.length).toBe(0);
  });
});
