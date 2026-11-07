// ui/tabBar.ts — the one tab bar (uif-3, UIF3.1-UIF3.2): an LB chip, a `role="tablist"` strip and an
// RB chip in one horizontal row. Consumers arrive in uif-6 onward; `createFrame` builds through it now.
//
// The kit writes only caller text: a chip's letters are `.mr-frame-tabslot::before`, keyed on
// `data-button`, and the chips are hidden from assistive technology. The strip keeps a caller-supplied
// id because e2e keys on strip ids (`#social-tabs`), and tabs stay what `renderTabs` writes, because
// pointer clicks key on `[role="tab"][data-nav-tab]`.
//
// A selected tab carries `is-selected`, never the row cursor's `is-active`, so "which tab" and "which
// row" can both be true on one screen (wireframes, "Selected tab"; feedback 060, 169).
import type { NavLayout, NavState, NavTab } from './nav';
import { renderTabs } from './navRender';

export interface TabBar {
  /** The whole row; `hidden` unless a tabs layout with a tab is shown. */
  readonly root: HTMLElement;
  /** The tablist, holding only tabs. */
  readonly strip: HTMLElement;
}

function chip(doc: Document, button: 'LB' | 'RB'): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'mr-frame-tabslot mr-tabbar-chip';
  el.dataset.button = button;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export function createTabBar(doc: Document, opts: { readonly id: string }): TabBar {
  if (opts.id === '' || [...opts.id].some((ch) => ch.trim() === '')) {
    throw new Error(`tabBar: invalid strip id ${JSON.stringify(opts.id)}`);
  }
  const root = doc.createElement('div');
  root.className = 'mr-frame-tabs mr-tabbar';
  root.hidden = true;
  const strip = doc.createElement('div');
  strip.className = 'mr-frame-tabstrip mr-tabbar-strip';
  strip.id = opts.id;
  strip.setAttribute('role', 'tablist');
  root.append(chip(doc, 'LB'), strip, chip(doc, 'RB'));
  return { root, strip };
}

export function renderTabBar(
  bar: TabBar,
  layout: NavLayout,
  state: NavState,
  opts: { readonly frame: string; readonly label: (tab: NavTab) => string },
): void {
  renderTabs(bar.strip, layout, state, opts);
  for (const tab of bar.strip.children) {
    tab.classList.remove('is-active');
    tab.classList.toggle('is-selected', tab.getAttribute('aria-selected') === 'true');
  }
  bar.root.hidden = layout.kind !== 'tabs' || layout.tabs.length === 0;
}
