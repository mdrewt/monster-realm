// @vitest-environment happy-dom
/**
 * tabBar.test.ts: the TabBar kit primitive (uif-3, UIF3.1 and UIF3.2).
 *
 * `createTabBar(doc, { id })` builds ONE row: an LB chip, a `role="tablist"` strip carrying the
 * caller's id, and an RB chip. `renderTabBar(bar, layout, state, { frame, label })` runs the shipped
 * `renderTabs`, then moves the selected marker from the row's `.is-active` to `.is-selected`, and
 * hides the whole row unless the layout is a tabs layout with at least one tab.
 *
 * Every string below is arbitrary caller text: the kit owns no catalog strings.
 */
import * as fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import type { NavLayout, NavState } from './nav';
import { renderTabs } from './navRender';
import { createTabBar, renderTabBar } from './tabBar';

const itm = (key: string) => ({ key, enabled: true });
const tabsL = (...pairs: Array<readonly [string, string[]]>): NavLayout => ({
  kind: 'tabs',
  tabs: pairs.map(([key, ks]) => ({ key, layout: { kind: 'list', items: ks.map(itm) } })),
});
const listL = (...keys: string[]): NavLayout => ({ kind: 'list', items: keys.map(itm) });
const state = (item: string | null, tab: string | null): NavState => ({ tab, item, perTab: {} });
const label = (t: { readonly key: string }): string => `Tab ${t.key}`;

beforeEach(() => {
  document.body.replaceChildren();
});

const tabsOf = (strip: Element): HTMLElement[] =>
  Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"][data-nav-tab]'));
const selectedKeys = (root: Element): string[] =>
  Array.from(root.querySelectorAll<HTMLElement>('.is-selected')).map((e) => e.dataset.navTab ?? '');

describe('createTabBar', () => {
  it('UIF3.1 builds one row: chip LB, the tablist strip, chip RB, in that order, hidden until a tabs layout shows', () => {
    // WRONG IMPLS KILLED: the chips after the strip or both on one side; a strip that is not a
    // direct child of the row (a nested wrapper); the root left visible (an empty bar would paint
    // two bare chips); chips missing their data-button; the strip classes missing (CSS keys on them).
    const bar = createTabBar(document, { id: 'bag-tabs' });
    expect(bar.root.classList.contains('mr-frame-tabs')).toBe(true);
    expect(bar.root.classList.contains('mr-tabbar')).toBe(true);
    expect(bar.root.hidden).toBe(true);
    expect(bar.root.hasAttribute('hidden')).toBe(true);
    const kids = Array.from(bar.root.children) as HTMLElement[];
    expect(kids.length).toBe(3);
    expect(kids[1]).toBe(bar.strip);
    expect(kids[0]).not.toBe(kids[2]);
    expect(kids[0]?.getAttribute('data-button')).toBe('LB');
    expect(kids[2]?.getAttribute('data-button')).toBe('RB');
    for (const chip of [kids[0], kids[2]]) {
      expect(chip?.classList.contains('mr-frame-tabslot')).toBe(true);
      expect(chip?.classList.contains('mr-tabbar-chip')).toBe(true);
    }
    expect(bar.strip.classList.contains('mr-frame-tabstrip')).toBe(true);
    expect(bar.strip.classList.contains('mr-tabbar-strip')).toBe(true);
    expect(bar.strip.children.length).toBe(0);
  });

  it('UIF3.1 the chips are decoration: aria-hidden true, no child nodes at all, no tabindex, not a button; the strip is a visible tablist with no data-button', () => {
    // WRONG IMPLS KILLED: a chip that writes its own LB/RB text (the glyph is the CSS ::before; a
    // text node would be read twice and counts as kit-written text); a chip that is a <button> or
    // has role button or a tabindex (a second tab stop: the nav container must stay the only one);
    // aria-hidden missing on a chip; aria-hidden spilled onto the strip (it would hide every tab).
    const bar = createTabBar(document, { id: 'social-tabs' });
    const [lb, , rb] = Array.from(bar.root.children) as HTMLElement[];
    for (const chip of [lb, rb]) {
      expect(chip?.getAttribute('aria-hidden')).toBe('true');
      expect(chip?.childNodes.length).toBe(0);
      expect(chip?.textContent).toBe('');
      expect(chip?.hasAttribute('tabindex')).toBe(false);
      expect(chip?.tagName).not.toBe('BUTTON');
      expect(chip?.getAttribute('role')).not.toBe('button');
      expect(chip?.hasAttribute('id')).toBe(false);
    }
    expect(bar.strip.getAttribute('role')).toBe('tablist');
    expect(bar.strip.hasAttribute('aria-hidden')).toBe(false);
    expect(bar.strip.hasAttribute('data-button')).toBe(false);
    expect(bar.root.hasAttribute('aria-hidden')).toBe(false);
  });

  it('UIF3.1 the strip carries the caller id, and exactly one element in the document has it', () => {
    // WRONG IMPLS KILLED: a generated id instead of the caller's (e2e keys on #social-tabs); the id
    // also stamped on the root or a chip (a duplicate id breaks every IDREF and the e2e lookup);
    // a suffixed id.
    const bar = createTabBar(document, { id: 'social-tabs' });
    document.body.appendChild(bar.root);
    expect(bar.strip.id).toBe('social-tabs');
    expect(document.querySelectorAll('#social-tabs').length).toBe(1);
    expect(document.getElementById('social-tabs')).toBe(bar.strip);
    expect(bar.root.querySelectorAll('[id]').length).toBe(1);
    expect(bar.root.id).toBe('');

    const other = createTabBar(document, { id: 'bag-tabs' });
    document.body.appendChild(other.root);
    expect(other.strip.id).toBe('bag-tabs');
    expect(other.strip).not.toBe(bar.strip);
    expect(other.root.contains(bar.strip)).toBe(false);
    expect(document.querySelectorAll('[role="tablist"]').length).toBe(2);
  });

  it('UIF3.1 throws on an empty or whitespace-only id (an IDREF is one token) and accepts a hyphenated id', () => {
    // WRONG IMPLS KILLED: no validation (an empty id yields id="" and a dangling IDREF); a check
    // reusing the frame-id rule that bans the hyphen (social-tabs is the shipped id shape).
    for (const bad of ['', ' ', '  ', '\t', '\n']) {
      expect(() => createTabBar(document, { id: bad }), JSON.stringify(bad)).toThrow();
    }
    for (const good of ['social-tabs', 'bag-tabs', 'monsters-tabs', 'x']) {
      const bar = createTabBar(document, { id: good });
      expect(bar.strip.id).toBe(good);
    }
  });
});

describe('renderTabBar', () => {
  const layout = tabsL(['a', ['a1']], ['b', ['b1']], ['c', ['c1']]);

  it('UIF3.2 marks exactly one tab selected, as .is-selected and aria-selected together, never .is-active, for the first, a middle and the last tab', () => {
    // WRONG IMPLS KILLED: leaving renderTabs' is-active on the selected tab (the inverted fill the
    // wireframe forbids); is-selected on the wrong index; is-selected without aria-selected (or the
    // reverse); every tab marked; an off-by-one that selects the last tab for the first.
    for (const [key, item] of [
      ['a', 'a1'],
      ['b', 'b1'],
      ['c', 'c1'],
    ] as const) {
      const bar = createTabBar(document, { id: 'bag-tabs' });
      renderTabBar(bar, layout, state(item, key), { frame: 'bag', label });
      expect(selectedKeys(bar.root), `selected ${key}`).toEqual([key]);
      const aria = tabsOf(bar.strip)
        .filter((t) => t.getAttribute('aria-selected') === 'true')
        .map((t) => t.dataset.navTab);
      expect(aria, `aria-selected ${key}`).toEqual([key]);
      expect(bar.root.querySelectorAll('.is-active').length, `no is-active ${key}`).toBe(0);
      for (const t of tabsOf(bar.strip)) {
        expect(['true', 'false']).toContain(t.getAttribute('aria-selected'));
        expect(t.classList.contains('mr-nav-tab')).toBe(true);
      }
      expect(bar.root.hidden).toBe(false);
    }
  });

  it('UIF3.2 the selected marker MOVES on a re-render: the old tab loses is-selected, the new one gains it, nodes survive, still no is-active', () => {
    // WRONG IMPLS KILLED: an is-selected that is only ever added (two tabs selected after a move);
    // a marker keyed on node identity that sticks to the first tab; renderTabs' is-active
    // re-added on the second render (renderTabs rewrites it each call).
    const bar = createTabBar(document, { id: 'bag-tabs' });
    renderTabBar(bar, layout, state('a1', 'a'), { frame: 'bag', label });
    const before = tabsOf(bar.strip);
    renderTabBar(bar, layout, state('b1', 'b'), { frame: 'bag', label });
    const after = tabsOf(bar.strip);
    expect(after.length).toBe(3);
    after.forEach((t, i) => {
      expect(t).toBe(before[i]);
    });
    expect(selectedKeys(bar.root)).toEqual(['b']);
    expect(after.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(after[0]?.classList.contains('is-selected')).toBe(false);
    renderTabBar(bar, layout, state('c1', 'c'), { frame: 'bag', label });
    renderTabBar(bar, layout, state('c1', 'c'), { frame: 'bag', label });
    expect(selectedKeys(bar.root)).toEqual(['c']);
    expect(bar.root.querySelectorAll('.is-active').length).toBe(0);
    expect(tabsOf(bar.strip).map((t) => t.textContent)).toEqual(['Tab a', 'Tab b', 'Tab c']);
  });

  it('UIF3.2 a state naming no tab selects none: no is-selected, no aria-selected true', () => {
    // WRONG IMPLS KILLED: a default of "first tab selected" that disagrees with aria-selected.
    const bar = createTabBar(document, { id: 'bag-tabs' });
    renderTabBar(bar, layout, state(null, null), { frame: 'bag', label });
    expect(selectedKeys(bar.root)).toEqual([]);
    expect(tabsOf(bar.strip).filter((t) => t.getAttribute('aria-selected') === 'true')).toEqual([]);
    expect(bar.root.querySelectorAll('.is-active').length).toBe(0);
  });

  it('UIF3.2 property: for any tab count and any selected index, is-selected equals aria-selected true, exactly one, never is-active', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 0, max: 7 }),
        (n, i, j) => {
          const keys = Array.from({ length: n }, (_, k) => `t${k}`);
          const pairs: Array<readonly [string, string[]]> = keys.map((k) => [k, [`${k}x`]]);
          const l = tabsL(...pairs);
          const bar = createTabBar(document, { id: 'p-tabs' });
          const first = keys[i % n] as string;
          const second = keys[j % n] as string;
          renderTabBar(bar, l, state(`${first}x`, first), { frame: 'p', label });
          renderTabBar(bar, l, state(`${second}x`, second), { frame: 'p', label });
          expect(selectedKeys(bar.root)).toEqual([second]);
          const aria = tabsOf(bar.strip)
            .filter((t) => t.getAttribute('aria-selected') === 'true')
            .map((t) => t.dataset.navTab);
          expect(aria).toEqual([second]);
          expect(bar.root.querySelectorAll('.is-active').length).toBe(0);
          expect(tabsOf(bar.strip).length).toBe(n);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('UIF3.2 hides itself for a list, a grid and a tabs layout with no tab, and a restored tabs layout un-hides it with the strip rebuilt', () => {
    // WRONG IMPLS KILLED: hidden set once at creation and never recomputed (a tabs layout after a
    // list stays hidden: the sticky-hidden bug); hidden never set after a tabs layout (a list
    // screen keeps two orphan chips); zero tabs treated as visible; a list that leaves stale tabs.
    const bar = createTabBar(document, { id: 'bag-tabs' });
    const show = (l: NavLayout, s: NavState): void =>
      renderTabBar(bar, l, s, { frame: 'bag', label });
    show(layout, state('a1', 'a'));
    expect(bar.root.hidden).toBe(false);
    expect(bar.root.hasAttribute('hidden')).toBe(false);
    show(listL('x', 'y'), state('x', null));
    expect(bar.root.hasAttribute('hidden')).toBe(true);
    expect(bar.strip.children.length).toBe(0);
    expect(bar.root.children.length).toBe(3);
    show(layout, state('b1', 'b'));
    expect(bar.root.hasAttribute('hidden')).toBe(false);
    expect(selectedKeys(bar.root)).toEqual(['b']);
    expect(tabsOf(bar.strip).length).toBe(3);
    show(tabsL(), state(null, null));
    expect(bar.root.hasAttribute('hidden')).toBe(true);
    expect(bar.strip.children.length).toBe(0);
    show(layout, state('a1', 'a'));
    expect(bar.root.hasAttribute('hidden')).toBe(false);
    show({ kind: 'grid', items: [itm('g')], cols: 2 }, state('g', null));
    expect(bar.root.hasAttribute('hidden')).toBe(true);
    show(tabsL(['only', ['o']]), state('o', 'only'));
    expect(bar.root.hasAttribute('hidden')).toBe(false);
    expect(selectedKeys(bar.root)).toEqual(['only']);
  });

  it('UIF3.2 keeps the pointer key and the id scheme: each tab is [role=tab][data-nav-tab] with the frame-scoped id, and the chips are never tabs', () => {
    // WRONG IMPLS KILLED: a tab rebuilt with another role or without data-nav-tab (pointer tab
    // clicks key on that pair); ids that drop the frame prefix; chips counted among the tabs.
    const bar = createTabBar(document, { id: 'shop-tabs' });
    renderTabBar(bar, tabsL(['buy', ['b']], ['sell', ['s']]), state('b', 'buy'), {
      frame: 'shop',
      label,
    });
    expect(tabsOf(bar.strip).map((t) => t.id)).toEqual(['shop-tab-buy', 'shop-tab-sell']);
    expect(bar.root.querySelectorAll('[role="tab"]').length).toBe(2);
    expect(bar.strip.children.length).toBe(2);
    expect(bar.strip.id).toBe('shop-tabs');
  });

  it('UIF3.2 renderTabs on a plain strip still writes is-active and never is-selected (navRender is unchanged)', () => {
    // WRONG IMPLS KILLED: moving the is-selected logic into renderTabs itself (every other strip
    // in the product, which calls renderTabs directly, would lose its is-active mark).
    const strip = document.createElement('div');
    renderTabs(strip, layout, state('b1', 'b'), { frame: 'bag', label });
    const active = Array.from(strip.querySelectorAll('.is-active')).map(
      (e) => (e as HTMLElement).dataset.navTab,
    );
    expect(active).toEqual(['b']);
    expect(strip.querySelectorAll('.is-selected').length).toBe(0);
    expect(strip.getAttribute('role')).toBe('tablist');
  });
});
