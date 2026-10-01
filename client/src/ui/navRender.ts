// ui/navRender.ts — renders a nav layout into ONE persistent container (design §6, CTL4.5).
//
// The container is the caller's: it is the single tab stop (`tabindex="0"`) and names the active
// item through `aria-activedescendant`, so DOM focus never roves and a re-render cannot drop it.
// Items are diffed by key — a surviving key keeps its node, attributes are re-written every
// render — and no item or tab ever gets a tabindex. The active item is marked by the `is-active`
// class AND `aria-selected`, never by colour alone; the visible mark is CSS (styles.css).
//
// The kit writes no text of its own: `fill` writes each row's content, `label` each tab's.
import type { ItemLayout, NavItem, NavLayout, NavState, NavTab } from './nav';

export interface NavRenderOptions {
  /** The id prefix: item ids are `{frame}-{tab}-{key}`. */
  readonly frame: string;
  /** Writes one row's content into its (already emptied) element. */
  readonly fill: (el: HTMLElement, item: NavItem) => void;
  /** The element naming a non-tabbed container; a tabbed one is named by its active tab. */
  readonly labelledBy?: string;
}

/** The `{tab}` id segment of a non-tab layout (`root` is a reserved tab key in nav.ts). */
const ROOT_TAB = 'root';

export const navItemId = (frame: string, tab: string | null, key: string): string =>
  `${frame}-${tab ?? ROOT_TAB}-${key}`;

export const navTabId = (frame: string, tab: string): string => `${frame}-tab-${tab}`;

function activeItems(layout: NavLayout, state: NavState): ItemLayout | undefined {
  if (layout.kind !== 'tabs') return layout;
  return layout.tabs.find((t) => t.key === state.tab)?.layout;
}

function setOrRemove(el: HTMLElement, name: string, value: string | undefined): void {
  if (value === undefined) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

/** Put `children` into `parent` in order, moving only misplaced nodes, then drop the rest. */
function placeChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
  children.forEach((child, i) => {
    const at = parent.children[i];
    if (at !== child) parent.insertBefore(child, at ?? null);
  });
  while (parent.children.length > children.length) parent.lastElementChild?.remove();
}

export function renderNav(
  container: HTMLElement,
  layout: NavLayout,
  state: NavState,
  opts: NavRenderOptions,
): void {
  const active = activeItems(layout, state);
  const tab = layout.kind === 'tabs' ? state.tab : null;
  const isGrid = active?.kind === 'grid';
  container.setAttribute('role', isGrid ? 'grid' : 'listbox');
  container.setAttribute('tabindex', '0');
  setOrRemove(
    container,
    'aria-labelledby',
    layout.kind !== 'tabs'
      ? opts.labelledBy
      : tab !== null && active !== undefined
        ? navTabId(opts.frame, tab)
        : undefined,
  );

  // Every item node rendered last time, by key, whether it sat in the container or in a row.
  const previous = new Map<string, HTMLElement>();
  const oldRows: HTMLElement[] = [];
  for (const child of Array.from(container.children) as HTMLElement[]) {
    if (child.getAttribute('role') === 'row') {
      oldRows.push(child);
      for (const cell of Array.from(child.children) as HTMLElement[]) {
        if (cell.dataset.navKey !== undefined) previous.set(cell.dataset.navKey, cell);
      }
    } else if (child.dataset.navKey !== undefined) {
      previous.set(child.dataset.navKey, child);
    }
  }

  const items = active?.items ?? [];
  const activeKey = items.some((i) => i.key === state.item) ? state.item : null;
  const els = items.map((item) => {
    const el = previous.get(item.key) ?? container.ownerDocument.createElement('div');
    el.id = navItemId(opts.frame, tab, item.key);
    el.dataset.navKey = item.key;
    if (tab === null) delete el.dataset.navTab;
    else el.dataset.navTab = tab;
    el.classList.add('mr-nav-item');
    el.setAttribute('role', isGrid ? 'gridcell' : 'option');
    const selected = item.key === activeKey;
    el.classList.toggle('is-active', selected);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
    el.classList.toggle('is-disabled', !item.enabled);
    setOrRemove(el, 'aria-disabled', item.enabled ? undefined : 'true');
    el.replaceChildren();
    opts.fill(el, item);
    return el;
  });

  if (active?.kind === 'grid') {
    const { cols } = active;
    const rows: HTMLElement[] = [];
    for (let r = 0; r * cols < els.length; r++) {
      const row = oldRows[r] ?? container.ownerDocument.createElement('div');
      row.setAttribute('role', 'row');
      row.className = 'mr-nav-row';
      row.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      placeChildren(row, els.slice(r * cols, (r + 1) * cols));
      rows.push(row);
    }
    placeChildren(container, rows);
  } else {
    placeChildren(container, els);
  }

  // The pointer is written AFTER the diff, so it always names a connected node.
  const before = container.getAttribute('aria-activedescendant');
  const activeId = activeKey === null ? undefined : navItemId(opts.frame, tab, activeKey);
  setOrRemove(container, 'aria-activedescendant', activeId);
  if (activeId !== undefined && activeId !== before) {
    const el = els[items.findIndex((i) => i.key === activeKey)];
    // aria-activedescendant does not scroll; an internally scrolling frame body must.
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }
}

/** The tab strip: one `role="tab"` per tab, none for a list or grid. Tabs are never tab stops —
 *  LB/RB switch them, and the nav container stays the only one. */
export function renderTabs(
  strip: HTMLElement,
  layout: NavLayout,
  state: NavState,
  opts: { readonly frame: string; readonly label: (tab: NavTab) => string },
): void {
  strip.setAttribute('role', 'tablist');
  const tabList = layout.kind === 'tabs' ? layout.tabs : [];
  const previous = new Map<string, HTMLElement>();
  for (const child of Array.from(strip.children) as HTMLElement[]) {
    if (child.dataset.navTab !== undefined) previous.set(child.dataset.navTab, child);
  }
  const els = tabList.map((tab) => {
    const el = previous.get(tab.key) ?? strip.ownerDocument.createElement('div');
    el.id = navTabId(opts.frame, tab.key);
    el.dataset.navTab = tab.key;
    el.className = 'mr-nav-tab';
    el.setAttribute('role', 'tab');
    const selected = tab.key === state.tab;
    el.classList.toggle('is-active', selected);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
    el.textContent = opts.label(tab);
    return el;
  });
  placeChildren(strip, els);
}
