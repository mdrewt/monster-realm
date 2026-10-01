// ui/nav.ts — the pure navigation core every screen adapter drives (design §6). Pure: no DOM,
// module state or clock. Layouts are `list | grid | tabs` over `NavItem`s; the state stores
// KEYS only (the active tab, the active item, and the remembered item per tab), so content
// changes re-seat the cursor by key (`navReconcile`) instead of silently moving it.
//
// A fresh D-pad or LB/RB edge wraps at the ends; a repeat-flagged edge (the router's synthesized
// auto-repeat, ctl-5) clamps. Disabled items stay reachable: A on one reports its reason and acts
// on nothing. `navStep`, `navFocus` and `navReconcile` return the SAME state object when nothing
// changed. Layouts built through `list`/`grid`/`tabs` are validated; navRender re-checks `cols`.
import type { VButton } from '../input/buttons';

export interface NavItem {
  readonly key: string;
  readonly enabled: boolean;
  readonly reason?: string;
}
export type ItemLayout =
  | { readonly kind: 'list'; readonly items: readonly NavItem[] }
  | { readonly kind: 'grid'; readonly items: readonly NavItem[]; readonly cols: number };
export interface NavTab {
  readonly key: string;
  readonly layout: ItemLayout;
}
export type NavLayout = ItemLayout | { readonly kind: 'tabs'; readonly tabs: readonly NavTab[] };

export interface NavState {
  /** The active tab key (tabs layouts); null for a list or grid, or zero tabs. */
  readonly tab: string | null;
  /** The active item key in the active list/grid; null when it is empty. */
  readonly item: string | null;
  /** The remembered item key per tab. Read with `Object.hasOwn` only. */
  readonly perTab: Readonly<Record<string, string>>;
}
export interface NavInput {
  readonly button: VButton;
  readonly repeat: boolean;
}
export type NavOutcome =
  | { readonly kind: 'moved' }
  | { readonly kind: 'none' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'activate'; readonly tab: string | null; readonly key: string }
  | {
      readonly kind: 'disabled';
      readonly tab: string | null;
      readonly key: string;
      readonly reason: string | undefined;
    };
/** Session-scoped nav memory keyed by frame. An immutable value: the caller's session holds it. */
export type NavMemory = ReadonlyMap<string, NavState>;
export const EMPTY_NAV_MEMORY: NavMemory = new Map();

// The id segments navRender builds (`{frame}-{tab}-{key}`, `{frame}-tab-{tab}`) must not collide.
const RESERVED_TAB_KEYS: ReadonlySet<string> = new Set(['tab', 'root']);

function checkKey(key: string): void {
  if (key === '' || [...key].some((ch) => ch.trim() === ''))
    throw new Error(`nav: invalid key ${JSON.stringify(key)}`);
}

function checkItems(items: readonly NavItem[]): void {
  const seen = new Set<string>();
  for (const { key } of items) {
    checkKey(key);
    if (seen.has(key)) throw new Error(`nav: duplicate key ${JSON.stringify(key)}`);
    seen.add(key);
  }
}

export function list(items: readonly NavItem[]): ItemLayout {
  checkItems(items);
  return { kind: 'list', items };
}

/** Rejects a grid column count that is not an integer >= 1 (navRender re-checks it too). */
export function checkCols(cols: number): void {
  if (!Number.isInteger(cols) || cols < 1) throw new Error(`nav: invalid cols ${cols}`);
}

export function grid(items: readonly NavItem[], cols: number): ItemLayout {
  checkCols(cols);
  checkItems(items);
  return { kind: 'grid', items, cols };
}

export function tabs(tabList: readonly NavTab[]): NavLayout {
  const tabKeys = new Set<string>();
  // Every id suffix after `{frame}-`: `tab-{tab}` for tabs, `{tab}-{key}` for items.
  const ids = new Set<string>();
  const claim = (id: string): void => {
    if (ids.has(id)) throw new Error(`nav: ambiguous id segment ${JSON.stringify(id)}`);
    ids.add(id);
  };
  for (const { key, layout } of tabList) {
    checkKey(key);
    if (RESERVED_TAB_KEYS.has(key)) throw new Error(`nav: reserved tab key ${key}`);
    if (tabKeys.has(key)) throw new Error(`nav: duplicate tab key ${JSON.stringify(key)}`);
    tabKeys.add(key);
    if (layout.kind === 'grid') checkCols(layout.cols);
    checkItems(layout.items);
    claim(`tab-${key}`);
    for (const item of layout.items) claim(`${key}-${item.key}`);
  }
  return { kind: 'tabs', tabs: tabList };
}

const EMPTY_PER_TAB: Readonly<Record<string, string>> = {};

const indexOfKey = (items: readonly NavItem[], key: string | null): number =>
  key === null ? -1 : items.findIndex((i) => i.key === key);

const tabIndex = (tabList: readonly NavTab[], key: string | null): number =>
  key === null ? -1 : tabList.findIndex((t) => t.key === key);

/** `key` if it is in `items`, else the first item's key; null when empty. */
const keyOrFirst = (items: readonly NavItem[], key: string | null | undefined): string | null =>
  key != null && indexOfKey(items, key) >= 0 ? key : (items[0]?.key ?? null);

const remembered = (perTab: Readonly<Record<string, string>>, tab: string): string | undefined =>
  Object.hasOwn(perTab, tab) ? perTab[tab] : undefined;

/** perTab with `tab` set to `item`, or the entry removed when `item` is null. Built with
 *  `Object.fromEntries` (own data properties), never by assignment: `next.__proto__ = …` would
 *  set the prototype instead of remembering a tab named `__proto__`. */
function withPerTab(
  perTab: Readonly<Record<string, string>>,
  tab: string,
  item: string | null,
): Readonly<Record<string, string>> {
  if (item === null ? !Object.hasOwn(perTab, tab) : remembered(perTab, tab) === item) {
    return perTab;
  }
  const entries = Object.entries(perTab).filter(([k]) => k !== tab);
  if (item !== null) entries.push([tab, item]);
  return Object.fromEntries(entries);
}

const sameState = (a: NavState, b: NavState): boolean =>
  a.tab === b.tab &&
  a.item === b.item &&
  (a.perTab === b.perTab ||
    (Object.keys(a.perTab).length === Object.keys(b.perTab).length &&
      Object.keys(a.perTab).every((k) => remembered(b.perTab, k) === a.perTab[k])));

/** Return `prev` itself when `next` is equal to it, so callers can compare by reference. */
const keep = (prev: NavState, next: NavState): NavState => (sameState(prev, next) ? prev : next);

/** The active list/grid of a layout under `state`, or undefined (zero tabs / unknown tab). */
export function activeLayout(layout: NavLayout, state: NavState): ItemLayout | undefined {
  if (layout.kind !== 'tabs') return layout;
  return layout.tabs[tabIndex(layout.tabs, state.tab)]?.layout;
}

export function navInit(layout: NavLayout, rememberedState?: NavState): NavState {
  if (layout.kind !== 'tabs') {
    return { tab: null, item: keyOrFirst(layout.items, rememberedState?.item), perTab: {} };
  }
  const { tabs: tabList } = layout;
  const at = tabIndex(tabList, rememberedState?.tab ?? null);
  const tab = tabList[at >= 0 ? at : 0];
  if (tab === undefined) return { tab: null, item: null, perTab: {} };
  // Entries of surviving tabs are kept as keys and resolved lazily on the next tab switch.
  const perTab = Object.fromEntries(
    Object.entries(rememberedState?.perTab ?? EMPTY_PER_TAB).filter(
      ([k]) => tabIndex(tabList, k) >= 0,
    ),
  );
  // The remembered tab vanished: land on the first tab's remembered item, as navReconcile does.
  const item = at >= 0 ? rememberedState?.item : remembered(perTab, tab.key);
  return { tab: tab.key, item: keyOrFirst(tab.layout.items, item), perTab };
}

/** Move the cursor to a declared default (Shop opens on Buy, Fight each turn, Yes/No). */
export function navFocus(
  layout: NavLayout,
  state: NavState,
  target: { readonly tab?: string; readonly item?: string },
): NavState {
  if (layout.kind !== 'tabs') {
    if (target.item === undefined || indexOfKey(layout.items, target.item) < 0) return state;
    return keep(state, { ...state, item: target.item });
  }
  let tab: NavTab | undefined;
  if (target.tab !== undefined) {
    tab = layout.tabs[tabIndex(layout.tabs, target.tab)];
    if (tab === undefined) return state;
  } else if (target.item !== undefined) {
    const active = layout.tabs[tabIndex(layout.tabs, state.tab)];
    const item = target.item;
    tab =
      active !== undefined && indexOfKey(active.layout.items, item) >= 0
        ? active
        : layout.tabs.find((t) => indexOfKey(t.layout.items, item) >= 0);
    if (tab === undefined) return state;
  } else {
    return state;
  }
  const item =
    target.item !== undefined && indexOfKey(tab.layout.items, target.item) >= 0
      ? target.item
      : null;
  if (tab.key === state.tab) return item === null ? state : keep(state, { ...state, item });
  return keep(state, switchTab(tab, state, item));
}

/** Leave the active tab for `to`: remember the old item, land on `item` or the remembered/first. */
function switchTab(to: NavTab, state: NavState, item: string | null): NavState {
  let perTab = state.perTab;
  if (state.tab !== null) perTab = withPerTab(perTab, state.tab, state.item);
  const landed = item ?? keyOrFirst(to.layout.items, remembered(perTab, to.key));
  return { tab: to.key, item: landed, perTab: withPerTab(perTab, to.key, landed) };
}

const NONE = { kind: 'none' } as const;
const MOVED = { kind: 'moved' } as const;
const IGNORED = { kind: 'ignored' } as const;

/** One step along an axis of `len` positions: wrap when fresh, clamp when repeated. */
function stepAxis(pos: number, delta: -1 | 1, len: number, repeat: boolean): number {
  const next = pos + delta;
  if (next >= 0 && next < len) return next;
  return repeat ? pos : (next + len) % len;
}

/** The index the D-pad moves to inside a list or grid, or the same index when it stays. */
function moveInLayout(layout: ItemLayout, index: number, button: VButton, repeat: boolean): number {
  const n = layout.items.length;
  if (layout.kind === 'list') {
    if (button === 'Up') return stepAxis(index, -1, n, repeat);
    if (button === 'Down') return stepAxis(index, 1, n, repeat);
    return index;
  }
  const { cols } = layout;
  const row = Math.floor(index / cols);
  const col = index % cols;
  if (button === 'Left' || button === 'Right') {
    const rowLen = Math.min(cols, n - row * cols);
    return row * cols + stepAxis(col, button === 'Left' ? -1 : 1, rowLen, repeat);
  }
  if (button === 'Up' || button === 'Down') {
    // Only rows holding an item at this column; the column never changes.
    const colLen = Math.floor((n - 1 - col) / cols) + 1;
    return stepAxis(row, button === 'Up' ? -1 : 1, colLen, repeat) * cols + col;
  }
  return index;
}

const DPAD: ReadonlySet<VButton> = new Set(['Up', 'Down', 'Left', 'Right']);

export function navStep(
  layout: NavLayout,
  state: NavState,
  input: NavInput,
): { state: NavState; outcome: NavOutcome } {
  const { button, repeat } = input;
  if (button === 'LB' || button === 'RB') {
    if (layout.kind !== 'tabs') return { state, outcome: NONE };
    const at = tabIndex(layout.tabs, state.tab);
    if (at < 0) return { state, outcome: NONE };
    const to = stepAxis(at, button === 'LB' ? -1 : 1, layout.tabs.length, repeat);
    if (to === at) return { state, outcome: NONE };
    return { state: switchTab(layout.tabs[to] as NavTab, state, null), outcome: MOVED };
  }
  if (button !== 'A' && !DPAD.has(button)) return { state, outcome: IGNORED };

  const active = activeLayout(layout, state);
  const index = active === undefined ? -1 : indexOfKey(active.items, state.item);
  if (active === undefined || index < 0) return { state, outcome: NONE };

  if (button === 'A') {
    const item = active.items[index] as NavItem;
    if (repeat) return { state, outcome: NONE };
    if (!item.enabled) {
      return {
        state,
        outcome: { kind: 'disabled', tab: state.tab, key: item.key, reason: item.reason },
      };
    }
    return { state, outcome: { kind: 'activate', tab: state.tab, key: item.key } };
  }

  const to = moveInLayout(active, index, button, repeat);
  if (to === index) return { state, outcome: NONE };
  return { state: { ...state, item: (active.items[to] as NavItem).key }, outcome: MOVED };
}

/** The key at `key`'s index in `prev`, re-seated in `next`: kept if present, else the nearest
 *  index; the first when `key` was not in `prev`; null when `next` is empty. */
function reseat<T extends { readonly key: string }>(
  prev: readonly T[],
  next: readonly T[],
  key: string | null,
): string | null {
  if (key !== null && next.some((x) => x.key === key)) return key;
  if (next.length === 0) return null;
  const was = key === null ? -1 : prev.findIndex((x) => x.key === key);
  if (was < 0) return (next[0] as T).key;
  return (next[Math.min(was, next.length - 1)] as T).key;
}

export function navReconcile(prev: NavLayout, next: NavLayout, state: NavState): NavState {
  if (next.kind !== 'tabs') {
    const prevItems = prev.kind === 'tabs' ? [] : prev.items;
    return keep(state, { tab: null, item: reseat(prevItems, next.items, state.item), perTab: {} });
  }
  if (prev.kind !== 'tabs') return keep(state, navInit(next));
  const tabKey = reseat(prev.tabs, next.tabs, state.tab);
  const tab = next.tabs[tabIndex(next.tabs, tabKey)];
  if (tab === undefined) return keep(state, { tab: null, item: null, perTab: state.perTab });
  if (tab.key === state.tab) {
    const before = prev.tabs[tabIndex(prev.tabs, state.tab)]?.layout.items ?? [];
    return keep(state, { ...state, item: reseat(before, tab.layout.items, state.item) });
  }
  // The active tab is gone: land on the nearest tab, on its remembered item, else its first.
  const item = keyOrFirst(tab.layout.items, remembered(state.perTab, tab.key));
  return keep(state, { tab: tab.key, item, perTab: withPerTab(state.perTab, tab.key, item) });
}

export function rememberNav(mem: NavMemory, frame: string, state: NavState): NavMemory {
  return new Map(mem).set(frame, state);
}

export function recallNav(mem: NavMemory, frame: string): NavState | undefined {
  return mem.get(frame);
}
