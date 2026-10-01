/**
 * nav.test.ts: the pure navigation core (ctl-4, CTL4.1 to CTL4.4).
 *
 * Pure, node env: no DOM, no clock. Layouts are `list | grid | tabs` over `NavItem`s; the
 * state holds KEYS only (`{tab, item, perTab}`); `navStep` is the one transition function;
 * `navReconcile` re-seats a state after the content changed; `NavMemory` is an immutable map
 * keyed by frame id.
 *
 * The contract proven here:
 *  - layout constructors reject malformed input (duplicate / empty / whitespace keys, reserved
 *    tab keys, a bad `cols`, a cross-tab id clash) and allow empties (`list([])`, `tabs([])`);
 *  - the active item survives content changes by KEY (`navReconcile` property), never by index;
 *  - fresh edges wrap, repeat edges clamp (lists, grid rows and columns, tabs); a grid's
 *    columns and rows are the ragged ones the items actually fill; the D-pad never changes a
 *    tab; a no-change step returns the SAME state object;
 *  - A on an enabled item activates, on a disabled item reports its reason and does nothing,
 *    and disabled items are reachable by every move;
 *  - the memory restores entry, tab and per-tab item together, per frame, without mutating.
 *
 * Every row asserts concrete states and outcomes. The grid and reconcile oracles are written
 * from the pinned semantics, independently of any implementation.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { VBUTTONS, type VButton } from '../input/buttons';
import {
  EMPTY_NAV_MEMORY,
  grid,
  type ItemLayout,
  list,
  type NavInput,
  type NavItem,
  type NavLayout,
  type NavState,
  type NavTab,
  navFocus,
  navInit,
  navReconcile,
  navStep,
  recallNav,
  rememberNav,
  tabs,
} from './nav';

// --- builders -----------------------------------------------------------------------------
const item = (key: string, enabled = true, reason?: string): NavItem =>
  reason === undefined ? { key, enabled } : { key, enabled, reason };
const itemsOf = (...keys: string[]): NavItem[] => keys.map((k) => item(k));
const press = (button: VButton, repeat = false): NavInput => ({ button, repeat });

const MOVED = { kind: 'moved' } as const;
const NONE = { kind: 'none' } as const;
const IGNORED = { kind: 'ignored' } as const;

/** Freeze a value and everything reachable from it, so an in-place write throws (strict ES). */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Reflect.ownKeys(v)) deepFreeze((v as Record<PropertyKey, unknown>)[k]);
  }
  return v;
}

/** A frozen state literal. */
const at = (
  itemKey: string | null,
  tab: string | null = null,
  perTab: Record<string, string> = {},
): NavState => deepFreeze({ tab, item: itemKey, perTab: { ...perTab } });

const frozen = <T>(v: T): T => deepFreeze(v);

const tab = (key: string, layout: ItemLayout): NavTab => ({ key, layout });
const listTab = (key: string, ...itemKeys: string[]): NavTab =>
  tab(key, list(itemsOf(...itemKeys)));

/** Three non-empty list tabs a, b, c with two items each. */
const abc = (): NavLayout =>
  frozen(tabs([listTab('a', 'a1', 'a2'), listTab('b', 'b1', 'b2'), listTab('c', 'c1', 'c2')]));

/** A mixed tabs layout: a list, a ragged 2-column grid, and an EMPTY tab. */
const mixed = (): NavLayout =>
  frozen(
    tabs([
      listTab('a', 'a1', 'a2', 'a3'),
      tab('b', grid(itemsOf('b1', 'b2', 'b3', 'b4', 'b5'), 2)),
      listTab('c'),
    ]),
  );

const stepAll = (layout: NavLayout, from: NavState, buttons: readonly VButton[]): NavState => {
  let s = from;
  for (const b of buttons) s = navStep(layout, s, press(b)).state;
  return s;
};

// --- CTL4.1: layouts, key-not-index, reconcile ---------------------------------------------
describe('nav layouts', () => {
  it('CTL4-1-LAYOUTS builds the three shapes, rejects malformed input, allows empties', () => {
    const a = itemsOf('a', 'b');
    expect(list(a)).toEqual({ kind: 'list', items: a });
    expect(grid(a, 2)).toEqual({ kind: 'grid', items: a, cols: 2 });
    const t = [listTab('one', 'x')];
    expect(tabs(t)).toEqual({ kind: 'tabs', tabs: t });

    // legal empties and boundary values
    expect(list([])).toEqual({ kind: 'list', items: [] });
    expect(grid([], 3)).toEqual({ kind: 'grid', items: [], cols: 3 });
    expect(tabs([])).toEqual({ kind: 'tabs', tabs: [] });
    expect(() => tabs([listTab('empty')]), 'an empty tab is legal').not.toThrow();
    expect(() => grid(a, 1), 'cols 1').not.toThrow();
    expect(() => grid(a, 9), 'cols above the item count').not.toThrow();
    expect(
      () => tabs([listTab('a', 'x'), listTab('b', 'x')]),
      'the same item key in two tabs is legal',
    ).not.toThrow();
    expect(() => tabs([listTab('a-b', 'x')]), 'hyphen in a tab key').not.toThrow();

    // duplicate item keys
    expect(() => list(itemsOf('a', 'b', 'a')), 'dup list key').toThrow();
    expect(() => grid(itemsOf('a', 'a'), 2), 'dup grid key').toThrow();

    // empty / whitespace item keys
    for (const bad of ['', ' ', 'a b', 'a\tb', 'a\nb', ' a', 'a ']) {
      expect(() => list([item(bad)]), `list key ${JSON.stringify(bad)}`).toThrow();
      expect(() => grid([item(bad)], 2), `grid key ${JSON.stringify(bad)}`).toThrow();
    }

    // tab keys: duplicates, empty, whitespace, reserved
    expect(() => tabs([listTab('a', 'x'), listTab('a', 'y')]), 'dup tab key').toThrow();
    for (const bad of ['', ' ', 'a b', 'a\tb', 'tab', 'root']) {
      expect(() => tabs([listTab(bad, 'x')]), `tab key ${JSON.stringify(bad)}`).toThrow();
    }

    // cols must be an integer >= 1
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => grid(a, bad), `cols ${bad}`).toThrow();
    }

    // `${tab}-${key}` must be unique across tabs: tab "a-b" key "c" vs tab "a" key "b-c"
    expect(() => tabs([listTab('a-b', 'c'), listTab('a', 'b-c')]), 'cross-tab id clash').toThrow();
  });

  it('CTL4-1-KEY-NOT-INDEX keeps the active KEY across insertions and removals; state holds keys only', () => {
    const before = list(itemsOf('a', 'b', 'c'));

    // the state shape is exactly {tab, item, perTab}, with no numeric field anywhere
    const init = navInit(before);
    expect(Object.keys(init).sort()).toEqual(['item', 'perTab', 'tab']);
    expect(Object.values(init).some((v) => typeof v === 'number')).toBe(false);
    const down = navStep(before, init, press('Down')).state;
    expect(Object.keys(down).sort()).toEqual(['item', 'perTab', 'tab']);
    expect(down.item).toBe('b');
    expect(Object.values(down).some((v) => typeof v === 'number')).toBe(false);

    // inserting before the active item keeps the active key (an index store would slide)
    const inserted = list(itemsOf('x', 'y', 'a', 'b', 'c'));
    expect(navReconcile(before, inserted, at('c')).item).toBe('c');
    expect(navReconcile(before, inserted, down).item).toBe('b');
    // removing before the active item keeps it too
    const removed = list(itemsOf('b', 'c'));
    expect(navReconcile(before, removed, at('c')).item).toBe('c');
    // a grid follows the list rule
    const g0 = grid(itemsOf('a', 'b', 'c', 'd'), 2);
    const g1 = grid(itemsOf('n', 'a', 'b', 'c', 'd'), 2);
    expect(navReconcile(g0, g1, at('d')).item).toBe('d');

    // tab states hold only strings, even after switching with a remembered item
    const layout = abc();
    let s = navInit(layout);
    s = stepAll(layout, s, ['Down', 'RB']);
    expect(Object.values(s.perTab).every((v) => typeof v === 'string')).toBe(true);
    expect(Object.values(s).some((v) => typeof v === 'number')).toBe(false);
  });

  it('CTL4-1-RECONCILE-PROP keeps the key iff present, else the nearest index, always inside next', () => {
    const alphabet = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const keyList = fc.uniqueArray(fc.constantFrom(...alphabet), { maxLength: 8 });
    fc.assert(
      fc.property(
        keyList,
        keyList,
        fc.nat(),
        fc.boolean(),
        fc.integer({ min: 1, max: 4 }),
        (prevKeys, nextKeys, pick, asGrid, cols) => {
          const make = (keys: string[]): ItemLayout =>
            asGrid
              ? grid(
                  keys.map((k) => item(k)),
                  cols,
                )
              : list(keys.map((k) => item(k)));
          const prev = make(prevKeys);
          const next = make(nextKeys);
          const active = prevKeys.length === 0 ? null : prevKeys[pick % prevKeys.length];
          const state = at(active);

          // oracle, from the pinned rule
          let expected: string | null;
          if (nextKeys.length === 0) expected = null;
          else if (active === null) expected = nextKeys[0];
          else if (nextKeys.includes(active)) expected = active;
          else expected = nextKeys[Math.min(prevKeys.indexOf(active), nextKeys.length - 1)];

          const got = navReconcile(prev, next, state);
          expect(got).toEqual({ tab: null, item: expected, perTab: {} });
          if (got.item !== null) expect(nextKeys).toContain(got.item);
          if (nextKeys.length === 0) expect(got.item).toBeNull();
          // a valid state against an unchanged layout comes back as the very same object
          expect(Object.is(navReconcile(prev, prev, state), state)).toBe(true);
          // reconciling again against the same next layout is a no-op on the same object
          expect(navReconcile(next, next, got)).toBe(got);
        },
      ),
      { numRuns: 400 },
    );
    // concrete rows: nearest index on removal
    const p = list(itemsOf('a', 'b', 'c', 'd'));
    expect(navReconcile(p, list(itemsOf('a', 'b', 'd')), at('c')).item).toBe('d');
    expect(navReconcile(p, list(itemsOf('a', 'b')), at('d')).item).toBe('b');
    expect(navReconcile(p, list(itemsOf('b', 'c', 'd')), at('a')).item).toBe('b');
    expect(navReconcile(p, list([]), at('b')).item).toBeNull();
    expect(navReconcile(list([]), p, at(null)).item).toBe('a');
  });

  it('CTL4-1-RECONCILE-TABS re-seats tab and item across removals, empties and kind changes', () => {
    const l3 = (aKeys: string[], bKeys: string[], cKeys: string[]): NavLayout =>
      frozen(tabs([listTab('a', ...aKeys), listTab('b', ...bKeys), listTab('c', ...cKeys)]));
    const prev = l3(['a1', 'a2', 'a3'], ['b1', 'b2'], ['c1', 'c2']);

    // active tab kept: the item is kept by key, or moves to the nearest index in that tab
    const grew = l3(['n', 'a1', 'a2', 'a3'], ['b1', 'b2'], ['c1', 'c2']);
    expect(navReconcile(prev, grew, at('a3', 'a'))).toEqual({
      tab: 'a',
      item: 'a3',
      perTab: {},
    });
    const shrank = l3(['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']);
    expect(navReconcile(prev, shrank, at('a3', 'a'))).toEqual({
      tab: 'a',
      item: 'a2',
      perTab: {},
    });

    // active tab removed: the tab at min(prevTabIndex, next.length - 1); item from perTab, else first
    const noB = frozen(tabs([listTab('a', 'a1', 'a2', 'a3'), listTab('c', 'c1', 'c2')]));
    const toC = navReconcile(prev, noB, at('b1', 'b', { c: 'c2' }));
    expect(toC.tab).toBe('c');
    expect(toC.item).toBe('c2');
    const toCFirst = navReconcile(prev, noB, at('b1', 'b'));
    expect(toCFirst.tab).toBe('c');
    expect(toCFirst.item).toBe('c1');
    const toCStale = navReconcile(prev, noB, at('b1', 'b', { c: 'gone' }));
    expect(toCStale.tab).toBe('c');
    expect(toCStale.item).toBe('c1');
    // the last tab removed goes to the new last; the first removed goes to the new first
    const noC = frozen(tabs([listTab('a', 'a1', 'a2', 'a3'), listTab('b', 'b1', 'b2')]));
    expect(navReconcile(prev, noC, at('c1', 'c')).tab).toBe('b');
    const noA = frozen(tabs([listTab('b', 'b1', 'b2'), listTab('c', 'c1', 'c2')]));
    expect(navReconcile(prev, noA, at('a2', 'a')).tab).toBe('b');
    expect(navReconcile(prev, noA, at('a2', 'a')).item).toBe('b1');

    // an item key that was never in the previous layout falls to the first item
    expect(navReconcile(prev, prev, at('ghost', 'a'))).toEqual({
      tab: 'a',
      item: 'a1',
      perTab: {},
    });

    // the active tab becomes empty: item null; all tabs gone: tab null and item null
    const aEmptied = l3([], ['b1', 'b2'], ['c1', 'c2']);
    expect(navReconcile(prev, aEmptied, at('a2', 'a'))).toEqual({
      tab: 'a',
      item: null,
      perTab: {},
    });
    const none = frozen(tabs([]));
    const gone = navReconcile(prev, none, at('a2', 'a'));
    expect(gone.tab).toBeNull();
    expect(gone.item).toBeNull();

    // perTab entries of other tabs are resolved lazily on the next switch
    const bShrunk = l3(['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']);
    const kept = navReconcile(prev, grew, at('a1', 'a', { b: 'b2' }));
    expect(navStep(grew, kept, press('RB')).state).toMatchObject({ tab: 'b', item: 'b2' });
    const lazy = navReconcile(prev, bShrunk, at('a1', 'a', { b: 'b2' }));
    expect(navStep(bShrunk, lazy, press('RB')).state).toMatchObject({ tab: 'b', item: 'b1' });

    // kind changes: tabs to list clears tab and perTab; list to tabs takes the first tab, first item
    const flat = list(itemsOf('a2', 'z'));
    const flatState = navReconcile(prev, flat, at('a2', 'a', { b: 'b2' }));
    expect(flatState.tab).toBeNull();
    expect(flatState.perTab).toEqual({});
    expect(['a2', 'z']).toContain(flatState.item);
    expect(navReconcile(flat, prev, at('z'))).toEqual({ tab: 'a', item: 'a1', perTab: {} });

    // identity: a valid state against an unchanged layout is returned as the same object
    const valid = at('b2', 'b', { a: 'a2' });
    expect(Object.is(navReconcile(prev, prev, valid), valid)).toBe(true);
  });
});

// --- CTL4.2: wrap fresh, clamp repeat --------------------------------------------------------
describe('nav stepping', () => {
  it('CTL4-2-LIST-WRAP wraps top and bottom on a fresh edge', () => {
    const layout = frozen(list(itemsOf('a', 'b', 'c')));
    const atC = at('c');
    const down = navStep(layout, atC, press('Down'));
    expect(down.outcome).toEqual(MOVED);
    expect(down.state).toEqual({ tab: null, item: 'a', perTab: {} });
    expect(down.state).not.toBe(atC);

    const atA = at('a');
    const up = navStep(layout, atA, press('Up'));
    expect(up.outcome).toEqual(MOVED);
    expect(up.state.item).toBe('c');

    // interior moves are single steps
    expect(navStep(layout, atA, press('Down')).state.item).toBe('b');
    expect(navStep(layout, atC, press('Up')).state.item).toBe('b');

    // a one-item list cannot move: none, and the very same state object
    const one = frozen(list(itemsOf('only')));
    const s1 = at('only');
    for (const b of ['Up', 'Down'] as const) {
      const r = navStep(one, s1, press(b));
      expect(r.outcome).toEqual(NONE);
      expect(r.state).toBe(s1);
    }
    // two items wrap both ways
    const two = frozen(list(itemsOf('x', 'y')));
    expect(navStep(two, at('y'), press('Down')).state.item).toBe('x');
    expect(navStep(two, at('x'), press('Up')).state.item).toBe('y');
  });

  it('CTL4-2-LIST-CLAMP clamps both ends on a repeat edge; Left and Right do nothing in a list', () => {
    const layout = frozen(list(itemsOf('a', 'b', 'c')));
    const atC = at('c');
    const atA = at('a');
    const downEnd = navStep(layout, atC, press('Down', true));
    expect(downEnd.outcome).toEqual(NONE);
    expect(downEnd.state).toBe(atC);
    const upEnd = navStep(layout, atA, press('Up', true));
    expect(upEnd.outcome).toEqual(NONE);
    expect(upEnd.state).toBe(atA);

    // a repeat in the middle still moves
    const mid = navStep(layout, atA, press('Down', true));
    expect(mid.outcome).toEqual(MOVED);
    expect(mid.state.item).toBe('b');
    expect(navStep(layout, atC, press('Up', true)).state.item).toBe('b');

    // Left / Right never move a list, fresh or repeat, and hand back the same state
    const atB = at('b');
    for (const b of ['Left', 'Right'] as const) {
      for (const repeat of [false, true]) {
        const r = navStep(layout, atB, press(b, repeat));
        expect(r.outcome, `${b} repeat=${repeat}`).toEqual(NONE);
        expect(r.state).toBe(atB);
      }
    }
  });

  /** Independent grid oracle: the line is the row (Left/Right) or the column (Up/Down). */
  function gridOracle(
    n: number,
    cols: number,
    i: number,
    dir: 'Up' | 'Down' | 'Left' | 'Right',
    repeat: boolean,
  ): number {
    const all = Array.from({ length: n }, (_, k) => k);
    const row = Math.floor(i / cols);
    const col = i % cols;
    const line =
      dir === 'Left' || dir === 'Right'
        ? all.filter((k) => Math.floor(k / cols) === row)
        : all.filter((k) => k % cols === col);
    const pos = line.indexOf(i);
    const raw = pos + (dir === 'Right' || dir === 'Down' ? 1 : -1);
    if (raw < 0 || raw >= line.length) {
      return repeat ? i : line[(raw + line.length) % line.length];
    }
    return line[raw];
  }

  const GRID_SHAPES: ReadonlyArray<readonly [number, number]> = [
    [8, 3],
    [3, 5],
    [7, 3],
    [7, 2],
    [9, 3],
    [5, 1],
    [1, 1],
    [4, 4],
  ];

  function checkGridAxis(dirs: ReadonlyArray<'Up' | 'Down' | 'Left' | 'Right'>): void {
    for (const [n, cols] of GRID_SHAPES) {
      const keys = Array.from({ length: n }, (_, k) => `k${k}`);
      const layout = frozen(
        grid(
          keys.map((k) => item(k)),
          cols,
        ),
      );
      for (let i = 0; i < n; i += 1) {
        for (const dir of dirs) {
          for (const repeat of [false, true]) {
            const label = `n=${n} cols=${cols} from ${i} ${dir} repeat=${repeat}`;
            const state = at(keys[i]);
            const r = navStep(layout, state, press(dir, repeat));
            const to = gridOracle(n, cols, i, dir, repeat);
            if (to === i) {
              expect(r.outcome, label).toEqual(NONE);
              expect(r.state, label).toBe(state);
            } else {
              expect(r.outcome, label).toEqual(MOVED);
              expect(r.state, label).toEqual({ tab: null, item: keys[to], perTab: {} });
            }
          }
        }
      }
    }
  }

  it('CTL4-2-GRID-ROW moves Left and Right within the row the items actually fill', () => {
    checkGridAxis(['Left', 'Right']);
    // 8 items, 3 cols: the last row is [k6, k7]
    const layout = frozen(grid(itemsOf('k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'), 3));
    expect(navStep(layout, at('k7'), press('Right')).state.item).toBe('k6');
    expect(navStep(layout, at('k6'), press('Left')).state.item).toBe('k7');
    expect(navStep(layout, at('k2'), press('Right')).state.item).toBe('k0');
    expect(navStep(layout, at('k7'), press('Right', true)).outcome).toEqual(NONE);
    // a lone item in the last row cannot move sideways (7 items, 3 cols: row 2 is [k6])
    const seven = frozen(grid(itemsOf('k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6'), 3));
    const lone = at('k6');
    for (const b of ['Left', 'Right'] as const) {
      const r = navStep(seven, lone, press(b));
      expect(r.outcome).toEqual(NONE);
      expect(r.state).toBe(lone);
    }
    // cols above the item count is a single ragged row
    const wide = frozen(grid(itemsOf('k0', 'k1', 'k2'), 5));
    expect(navStep(wide, at('k2'), press('Right')).state.item).toBe('k0');
    expect(navStep(wide, at('k0'), press('Left')).state.item).toBe('k2');
  });

  it('CTL4-2-GRID-COL moves Up and Down within the column, never changing the column', () => {
    checkGridAxis(['Up', 'Down']);
    // 8 items, 3 cols: column 2 holds [k2, k5]; column 1 holds [k1, k4, k7]
    const layout = frozen(grid(itemsOf('k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'), 3));
    expect(navStep(layout, at('k5'), press('Down')).state.item).toBe('k2');
    expect(navStep(layout, at('k2'), press('Up')).state.item).toBe('k5');
    expect(navStep(layout, at('k7'), press('Down')).state.item).toBe('k1');
    expect(navStep(layout, at('k0'), press('Up')).state.item).toBe('k6');
    expect(navStep(layout, at('k4'), press('Down')).state.item).toBe('k7');
    const clamp = navStep(layout, at('k5'), press('Down', true));
    expect(clamp.outcome).toEqual(NONE);
    expect(navStep(layout, at('k7'), press('Down', true)).outcome).toEqual(NONE);
    // a column of one cannot move vertically (3 items, 5 cols: every column has length 1)
    const wide = frozen(grid(itemsOf('k0', 'k1', 'k2'), 5));
    const s = at('k1');
    for (const b of ['Up', 'Down'] as const) {
      const r = navStep(wide, s, press(b));
      expect(r.outcome).toEqual(NONE);
      expect(r.state).toBe(s);
    }
  });

  it('CTL4-2-TABS-WRAP wraps RB on the last tab to the first and LB on the first to the last', () => {
    const layout = abc();
    const start = navInit(layout);
    expect(start).toEqual({ tab: 'a', item: 'a1', perTab: {} });

    const toB = navStep(layout, start, press('RB'));
    expect(toB.outcome).toEqual(MOVED);
    expect(toB.state).toMatchObject({ tab: 'b', item: 'b1' });
    const toC = navStep(layout, toB.state, press('RB'));
    expect(toC.state).toMatchObject({ tab: 'c', item: 'c1' });
    const wrapped = navStep(layout, toC.state, press('RB'));
    expect(wrapped.outcome).toEqual(MOVED);
    expect(wrapped.state).toMatchObject({ tab: 'a', item: 'a1' });

    const lbWrap = navStep(layout, start, press('LB'));
    expect(lbWrap.outcome).toEqual(MOVED);
    expect(lbWrap.state).toMatchObject({ tab: 'c', item: 'c1' });
    expect(navStep(layout, lbWrap.state, press('LB')).state).toMatchObject({ tab: 'b' });

    // a single tab cannot switch: none, same state object, even on a fresh edge
    const solo = frozen(tabs([listTab('only', 'x', 'y')]));
    const s = at('x', 'only');
    for (const b of ['LB', 'RB'] as const) {
      const r = navStep(solo, s, press(b));
      expect(r.outcome).toEqual(NONE);
      expect(r.state).toBe(s);
    }
  });

  it('CTL4-2-TABS-CLAMP clamps LB and RB at the ends on a repeat edge; they do nothing off tabs', () => {
    const layout = abc();
    const atC = at('c1', 'c');
    const atA = at('a1', 'a');
    const rbEnd = navStep(layout, atC, press('RB', true));
    expect(rbEnd.outcome).toEqual(NONE);
    expect(rbEnd.state).toBe(atC);
    const lbEnd = navStep(layout, atA, press('LB', true));
    expect(lbEnd.outcome).toEqual(NONE);
    expect(lbEnd.state).toBe(atA);
    // repeat inside the range still switches
    expect(navStep(layout, atA, press('RB', true)).state.tab).toBe('b');
    expect(navStep(layout, atC, press('LB', true)).state.tab).toBe('b');
    // single tab, repeat
    const solo = frozen(tabs([listTab('only', 'x')]));
    const s = at('x', 'only');
    expect(navStep(solo, s, press('RB', true)).state).toBe(s);

    // LB / RB on a list or a grid is none and returns the same state
    const flat = frozen(list(itemsOf('a', 'b')));
    const g = frozen(grid(itemsOf('a', 'b', 'c'), 2));
    const fs = at('a');
    for (const layoutKind of [flat, g]) {
      for (const b of ['LB', 'RB'] as const) {
        for (const repeat of [false, true]) {
          const r = navStep(layoutKind, fs, press(b, repeat));
          expect(r.outcome).toEqual(NONE);
          expect(r.state).toBe(fs);
        }
      }
    }
    // D-pad repeat inside a tab clamps at the inner list end
    const innerEnd = at('a2', 'a');
    expect(navStep(layout, innerEnd, press('Down', true)).state).toBe(innerEnd);
  });

  it('tabs: the D-pad never changes the tab, even at grid edges', () => {
    const layout = frozen(
      tabs([tab('a', grid(itemsOf('k0', 'k1', 'k2', 'k3', 'k4', 'k5'), 3)), listTab('b', 'b1')]),
    );
    for (let i = 0; i < 6; i += 1) {
      for (const dir of ['Up', 'Down', 'Left', 'Right'] as const) {
        for (const repeat of [false, true]) {
          const r = navStep(layout, at(`k${i}`, 'a'), press(dir, repeat));
          expect(r.state.tab, `from ${i} ${dir} repeat=${repeat}`).toBe('a');
          expect(r.state.item).not.toBeNull();
        }
      }
    }
  });

  it('tabs: switching away and back restores the per-tab item', () => {
    const layout = mixed();
    let s = navInit(layout);
    expect(s).toEqual({ tab: 'a', item: 'a1', perTab: {} });
    s = stepAll(layout, s, ['Down', 'Down']);
    expect(s.item).toBe('a3');

    const toB = navStep(layout, s, press('RB'));
    expect(toB.outcome).toEqual(MOVED);
    expect(toB.state).toMatchObject({ tab: 'b', item: 'b1' });
    expect(toB.state.perTab.a).toBe('a3');

    const inB = navStep(layout, toB.state, press('Down')).state; // b1 -> b3 in the 2-col grid
    expect(inB.item).toBe('b3');
    const back = navStep(layout, inB, press('LB'));
    expect(back.state).toMatchObject({ tab: 'a', item: 'a3' });
    expect(back.state.perTab.b).toBe('b3');
    expect(navStep(layout, back.state, press('RB')).state).toMatchObject({ tab: 'b', item: 'b3' });
  });

  it('tabs: a remembered key that vanished falls to the first item and overwrites the entry', () => {
    const layout = abc();
    const stale = at('b1', 'b', { a: 'ghost' });
    const r = navStep(layout, stale, press('LB'));
    expect(r.state.tab).toBe('a');
    expect(r.state.item).toBe('a1');
    expect(r.state.perTab.a).toBe('a1');
    expect(r.state.perTab.b).toBe('b1');
  });

  it('tabs: an empty tab has a null item and never writes null into perTab', () => {
    const layout = mixed();
    let s = navInit(layout);
    s = navStep(layout, s, press('RB')).state; // b
    s = navStep(layout, s, press('RB')).state; // c (empty)
    expect(s.tab).toBe('c');
    expect(s.item).toBeNull();
    expect(s.perTab.b).toBe('b1');
    // moving inside the empty tab does nothing
    for (const b of ['Up', 'Down', 'Left', 'Right', 'A'] as const) {
      const r = navStep(layout, s, press(b));
      expect(r.outcome, b).toEqual(NONE);
      expect(r.state, b).toBe(s);
    }
    // leaving it wraps to the first tab and restores its item; nothing null was stored
    const home = navStep(layout, s, press('RB')).state;
    expect(home).toMatchObject({ tab: 'a', item: 'a1' });
    expect(Object.hasOwn(home.perTab, 'c')).toBe(false);
    expect(Object.values(home.perTab).every((v) => typeof v === 'string')).toBe(true);
  });

  it('tabs: the keys constructor and __proto__ are ordinary tab keys', () => {
    const layout = frozen(
      tabs([listTab('constructor', 'c1', 'c2'), listTab('__proto__', 'p1', 'p2')]),
    );
    let s = navInit(layout);
    expect(s).toMatchObject({ tab: 'constructor', item: 'c1' });
    s = navStep(layout, s, press('Down')).state; // c2
    s = navStep(layout, s, press('RB')).state;
    expect(s.tab).toBe('__proto__');
    expect(s.item).toBe('p1');
    s = navStep(layout, s, press('Down')).state; // p2
    s = navStep(layout, s, press('LB')).state;
    expect(s.tab).toBe('constructor');
    expect(s.item).toBe('c2');
    s = navStep(layout, s, press('RB')).state;
    expect(s.tab).toBe('__proto__');
    expect(s.item).toBe('p2');

    // an inherited property is not a remembered item: never-saved tabs open on the first item
    const fresh = at('p1', '__proto__');
    const toConstructor = navStep(layout, fresh, press('LB')).state;
    expect(toConstructor.tab).toBe('constructor');
    expect(toConstructor.item).toBe('c1');
    const fresh2 = at('c1', 'constructor');
    const toProto = navStep(layout, fresh2, press('RB')).state;
    expect(toProto.tab).toBe('__proto__');
    expect(toProto.item).toBe('p1');
  });

  it('tabs: an item key shared by two tabs is restored only inside its own tab', () => {
    const layout = frozen(tabs([listTab('a', 'x', 'y'), listTab('b', 'w', 'x')]));
    // the active item x of tab a does not follow the player into tab b
    const r = navStep(layout, at('x', 'a'), press('RB'));
    expect(r.state).toMatchObject({ tab: 'b', item: 'w' });
    expect(r.state.perTab.a).toBe('x');
    // b remembers x; switching back to a lands on a's own remembered x, not b's order
    const onX = at('x', 'b', { a: 'y' });
    const back = navStep(layout, onX, press('LB'));
    expect(back.state).toMatchObject({ tab: 'a', item: 'y' });
    expect(back.state.perTab.b).toBe('x');
  });

  it('zero tabs: the state is empty and every nav button does nothing', () => {
    const layout = frozen(tabs([]));
    const s = navInit(layout);
    expect(s).toEqual({ tab: null, item: null, perTab: {} });
    for (const b of ['Up', 'Down', 'Left', 'Right', 'A', 'LB', 'RB'] as const) {
      const r = navStep(layout, s, press(b));
      expect(r.outcome, b).toEqual(NONE);
      expect(r.state, b).toBe(s);
    }
  });
});

// --- CTL4.3: A, disabled reasons, reachability ----------------------------------------------
describe('nav activation', () => {
  it('CTL4-3-DISABLED-REASON reports the reason and performs no action', () => {
    const layout = frozen(
      list([item('a'), item('b', false, 'Not enough money'), item('c', false), item('d')]),
    );
    const onB = at('b');
    const r = navStep(layout, onB, press('A'));
    expect(r.outcome).toEqual({
      kind: 'disabled',
      tab: null,
      key: 'b',
      reason: 'Not enough money',
    });
    expect(r.state).toBe(onB);

    // a disabled item with no reason still reports disabled (reason undefined), never activate
    const onC = at('c');
    const noReason = navStep(layout, onC, press('A'));
    expect(noReason.outcome.kind).toBe('disabled');
    expect(noReason.outcome).toMatchObject({ tab: null, key: 'c' });
    expect((noReason.outcome as { reason?: string }).reason).toBeUndefined();
    expect(noReason.state).toBe(onC);

    // inside a tab the outcome names the tab
    const tabbed = frozen(
      tabs([listTab('a', 'a1'), tab('b', list([item('b1', false, 'Sold out')]))]),
    );
    const inTab = at('b1', 'b');
    const t = navStep(tabbed, inTab, press('A'));
    expect(t.outcome).toEqual({ kind: 'disabled', tab: 'b', key: 'b1', reason: 'Sold out' });
    expect(t.state).toBe(inTab);

    // in a grid too
    const g = frozen(grid([item('x'), item('y', false, 'Locked')], 2));
    expect(navStep(g, at('y'), press('A')).outcome).toEqual({
      kind: 'disabled',
      tab: null,
      key: 'y',
      reason: 'Locked',
    });
  });

  it('CTL4-3-DISABLED-REACHABLE never skips a disabled item on any move or on init', () => {
    const l = frozen(list([item('a'), item('b', false, 'no'), item('c', false, 'no'), item('d')]));
    let s = navInit(l);
    const seen: Array<string | null> = [];
    for (const b of ['Down', 'Down', 'Down'] as const) {
      const r = navStep(l, s, press(b));
      expect(r.outcome).toEqual(MOVED);
      s = r.state;
      seen.push(s.item);
    }
    expect(seen).toEqual(['b', 'c', 'd']);
    expect(navStep(l, at('d'), press('Up')).state.item).toBe('c');
    expect(navStep(l, at('a'), press('Up')).state.item).toBe('d');
    // a repeat edge also lands on a disabled neighbour
    expect(navStep(l, at('a'), press('Down', true)).state.item).toBe('b');

    // grid: [a, b(off) / c(off), d]
    const g = frozen(grid([item('a'), item('b', false), item('c', false), item('d')], 2));
    expect(navStep(g, at('a'), press('Right')).state.item).toBe('b');
    expect(navStep(g, at('a'), press('Down')).state.item).toBe('c');
    expect(navStep(g, at('d'), press('Left')).state.item).toBe('c');
    expect(navStep(g, at('d'), press('Up')).state.item).toBe('b');

    // init lands on a disabled first item rather than skipping it
    const firstOff = frozen(list([item('x', false, 'no'), item('y')]));
    expect(navInit(firstOff).item).toBe('x');
    // a tab whose first item is disabled is entered on that item
    const tabbed = frozen(tabs([listTab('a', 'a1'), tab('b', firstOff as ItemLayout)]));
    expect(navStep(tabbed, at('a1', 'a'), press('RB')).state).toMatchObject({
      tab: 'b',
      item: 'x',
    });
  });

  it('CTL4-3-ENABLED-ACTIVATES returns activate with the tab and key and leaves the state alone', () => {
    const l = frozen(list(itemsOf('a', 'b')));
    const sb = at('b');
    const r = navStep(l, sb, press('A'));
    expect(r.outcome).toEqual({ kind: 'activate', tab: null, key: 'b' });
    expect(r.state).toBe(sb);

    const g = frozen(grid(itemsOf('a', 'b', 'c'), 2));
    const sc = at('c');
    const rg = navStep(g, sc, press('A'));
    expect(rg.outcome).toEqual({ kind: 'activate', tab: null, key: 'c' });
    expect(rg.state).toBe(sc);

    const layout = mixed();
    const sTab = at('b4', 'b', { a: 'a2' });
    const rt = navStep(layout, sTab, press('A'));
    expect(rt.outcome).toEqual({ kind: 'activate', tab: 'b', key: 'b4' });
    expect(rt.state).toBe(sTab);
  });

  it('A with the repeat flag never activates', () => {
    const l = frozen(list(itemsOf('a', 'b')));
    const s = at('a');
    const r = navStep(l, s, press('A', true));
    expect(r.outcome).toEqual(NONE);
    expect(r.state).toBe(s);
  });

  it('A on an empty layout, a null item or a phantom key does nothing', () => {
    const empty = frozen(list([]));
    const e = at(null);
    expect(navStep(empty, e, press('A')).outcome).toEqual(NONE);
    expect(navStep(empty, e, press('A')).state).toBe(e);

    const l = frozen(list(itemsOf('a', 'b')));
    const nullItem = at(null);
    expect(navStep(l, nullItem, press('A')).outcome).toEqual(NONE);
    const phantom = at('ghost');
    const rp = navStep(l, phantom, press('A'));
    expect(rp.outcome).toEqual(NONE);
    expect(rp.state).toBe(phantom);

    // a key that exists only in ANOTHER tab is a phantom for the active tab
    const layout = frozen(tabs([listTab('a', 'x'), listTab('b', 'y')]));
    const wrongTab = at('y', 'a');
    expect(navStep(layout, wrongTab, press('A')).outcome).toEqual(NONE);
    // an unknown tab is a phantom too
    expect(navStep(layout, at('x', 'nope'), press('A')).outcome).toEqual(NONE);
  });

  it('every non-nav button (B, X, Y, Start, Select) is ignored with the same state object', () => {
    const layouts: NavLayout[] = [
      frozen(list(itemsOf('a', 'b'))),
      frozen(grid(itemsOf('a', 'b', 'c'), 2)),
      abc(),
    ];
    const states = [at('a'), at('b'), at('a1', 'a')];
    const navButtons = new Set<VButton>(['Up', 'Down', 'Left', 'Right', 'A', 'LB', 'RB']);
    const others = VBUTTONS.filter((b) => !navButtons.has(b));
    expect(others).toEqual(['B', 'X', 'Y', 'Start', 'Select']);
    for (let i = 0; i < layouts.length; i += 1) {
      for (const b of others) {
        for (const repeat of [false, true]) {
          const r = navStep(layouts[i], states[i], press(b, repeat));
          expect(r.outcome, `${b} repeat=${repeat}`).toEqual(IGNORED);
          expect(r.state, `${b} repeat=${repeat}`).toBe(states[i]);
        }
      }
    }
  });

  it('an empty list does nothing on any nav button', () => {
    const empty = frozen(list([]));
    const e = navInit(empty);
    expect(e).toEqual({ tab: null, item: null, perTab: {} });
    for (const b of ['Up', 'Down', 'Left', 'Right', 'A', 'LB', 'RB'] as const) {
      const r = navStep(empty, e, press(b));
      expect(r.outcome, b).toEqual(NONE);
      expect(r.state, b).toBe(e);
    }
  });
});

// --- navInit / navFocus ---------------------------------------------------------------------
describe('nav init and focus', () => {
  it('navInit opens on the first tab and item, or on what is remembered and still exists', () => {
    expect(navInit(list(itemsOf('a', 'b')))).toEqual({ tab: null, item: 'a', perTab: {} });
    expect(navInit(grid(itemsOf('a', 'b', 'c'), 2))).toEqual({ tab: null, item: 'a', perTab: {} });
    expect(navInit(list([]))).toEqual({ tab: null, item: null, perTab: {} });
    expect(navInit(list(itemsOf('a', 'b', 'c')), at('c'))).toMatchObject({ item: 'c' });
    expect(navInit(list(itemsOf('a', 'b', 'c')), at('gone'))).toMatchObject({ item: 'a' });

    const layout = abc();
    expect(navInit(layout)).toEqual({ tab: 'a', item: 'a1', perTab: {} });
    expect(navInit(layout, at('b2', 'b'))).toMatchObject({ tab: 'b', item: 'b2' });
    expect(navInit(layout, at('b2', 'gone'))).toMatchObject({ tab: 'a', item: 'a1' });
    expect(navInit(layout, at('zzz', 'b'))).toMatchObject({ tab: 'b', item: 'b1' });
  });

  it('navFocus opens on a declared default, ignores unknown keys and returns the same object', () => {
    const l = frozen(list(itemsOf('a', 'b', 'c')));
    const s = at('a');
    expect(navFocus(l, s, { item: 'c' })).toMatchObject({ tab: null, item: 'c' });
    expect(navFocus(l, s, { item: 'zzz' })).toBe(s);
    expect(navFocus(l, s, { item: 'a' })).toBe(s);
    expect(navFocus(l, s, {})).toBe(s);

    const layout = abc();
    const start = navInit(layout);
    expect(navFocus(layout, start, { tab: 'b' })).toMatchObject({ tab: 'b', item: 'b1' });
    expect(navFocus(layout, start, { tab: 'b', item: 'b2' })).toMatchObject({
      tab: 'b',
      item: 'b2',
    });
    expect(navFocus(layout, start, { item: 'a2' })).toMatchObject({ tab: 'a', item: 'a2' });
    expect(navFocus(layout, start, { tab: 'nope' })).toBe(start);
    expect(navFocus(layout, start, { item: 'zzz' })).toBe(start);
    expect(navFocus(layout, start, { tab: 'a' })).toBe(start);
  });
});

// --- CTL4.4: NavMemory ----------------------------------------------------------------------
describe('nav memory', () => {
  it('CTL4-4-MEMORY-PER-FRAME keeps each frame in its own slot', () => {
    const menu = at('bag');
    const shop = at('potion', 'buy', { sell: 'rope' });
    let mem = rememberNav(EMPTY_NAV_MEMORY, 'menu', menu);
    expect(recallNav(mem, 'menu')).toEqual(menu);
    // frame A's state is invisible to frame B
    expect(recallNav(mem, 'shop')).toBeUndefined();
    mem = rememberNav(mem, 'shop', shop);
    expect(recallNav(mem, 'menu')).toEqual(menu);
    expect(recallNav(mem, 'shop')).toEqual(shop);
    // remembering a frame again replaces only that frame
    const menu2 = at('quests');
    const mem2 = rememberNav(mem, 'menu', menu2);
    expect(recallNav(mem2, 'menu')).toEqual(menu2);
    expect(recallNav(mem2, 'shop')).toEqual(shop);
    // unknown frames, including names that exist on every object, recall as undefined
    for (const name of ['nope', 'constructor', '__proto__', 'toString', '']) {
      expect(recallNav(mem2, name), name).toBeUndefined();
      expect(recallNav(EMPTY_NAV_MEMORY, name), name).toBeUndefined();
    }
    // such names are ordinary frame ids when written
    const odd = rememberNav(EMPTY_NAV_MEMORY, '__proto__', menu);
    expect(recallNav(odd, '__proto__')).toEqual(menu);
    expect(recallNav(odd, 'menu')).toBeUndefined();
  });

  it('CTL4-4-MEMORY-TAB-ITEMS restores entry, tab and per-tab item together', () => {
    const layout = mixed();
    let s = navInit(layout);
    s = stepAll(layout, s, ['Down', 'RB', 'Down']); // a2 saved, then b3 in tab b
    expect(s).toMatchObject({ tab: 'b', item: 'b3' });
    const mem = rememberNav(EMPTY_NAV_MEMORY, 'bag', s);

    const restored = navInit(layout, recallNav(mem, 'bag'));
    expect(restored).toEqual(s);
    // the per-tab item survived the round trip: LB returns to a2
    expect(navStep(layout, restored, press('LB')).state).toMatchObject({ tab: 'a', item: 'a2' });

    // a layout where the remembered keys vanished degrades to the first tab / first item
    const slim = frozen(
      tabs([listTab('a', 'a1', 'a3'), tab('b', grid(itemsOf('b1', 'b2'), 2)), listTab('c')]),
    );
    const degraded = navInit(slim, recallNav(mem, 'bag'));
    expect(degraded).toMatchObject({ tab: 'b', item: 'b1' });
    const backHome = navStep(slim, degraded, press('LB')).state;
    expect(backHome).toMatchObject({ tab: 'a', item: 'a1' });

    // the remembered tab itself is gone: first tab, first item
    const noB = frozen(tabs([listTab('a', 'a1', 'a3'), listTab('c', 'c1')]));
    expect(navInit(noB, recallNav(mem, 'bag'))).toMatchObject({ tab: 'a', item: 'a1' });
  });

  it('CTL4-4-MEMORY-IMMUTABLE returns a new map and never mutates its inputs', () => {
    const s = at('potion', 'buy', { sell: 'rope' });
    const first = rememberNav(EMPTY_NAV_MEMORY, 'shop', s);
    expect(first).not.toBe(EMPTY_NAV_MEMORY);
    expect(EMPTY_NAV_MEMORY.size).toBe(0);
    expect(recallNav(EMPTY_NAV_MEMORY, 'shop')).toBeUndefined();
    expect(first.size).toBe(1);

    const second = rememberNav(first, 'menu', at('bag'));
    expect(second).not.toBe(first);
    expect(first.size).toBe(1);
    expect(recallNav(first, 'menu')).toBeUndefined();
    expect(second.size).toBe(2);

    // overwriting returns a third map and leaves the earlier value readable in the old map
    const third = rememberNav(second, 'shop', at('rope', 'sell'));
    expect(third).not.toBe(second);
    expect(recallNav(second, 'shop')).toEqual(s);
    expect(recallNav(third, 'shop')).toMatchObject({ item: 'rope', tab: 'sell' });
    expect(third.size).toBe(2);

    // the stored state is not rewritten (it is frozen, so a write would throw)
    expect(Object.isFrozen(s)).toBe(true);
    expect(s).toEqual({ tab: 'buy', item: 'potion', perTab: { sell: 'rope' } });
  });
});
