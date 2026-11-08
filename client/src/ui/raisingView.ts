// ui/raisingView.ts — thin DOM shell for the raising/inventory screen (M9c).
//
// Renders a RaisingViewModel produced by raisingModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes, no joins/filters/classification
// (those live in the model) — one-way flow only. The loop calls refresh() on
// batch-applied; the Bag's actions go through its screen (screens/bagScreen.ts), never a callback
// here. Coverage-excluded shell.
//
// qf-9: inventory only. The per-monster Care/Train cards are gone (R-ctl-11b-RAISINGCARDS): care and
// feeding live on the Monsters sheet, whose Summary shows the full stats.
//
// Every player-facing string this view renders is resolved through the i18n
// resolver (`t()`/`tf()`, ui/i18n/resolver.ts) with a catalog key (`raising.*`, and `bag.*` plus a
// few shared ones for the Bag panel) from ui/i18n/catalog.en.ts;
// the English bytes are unchanged (the catalog pins them). Model data (item names, descriptions
// and counts) flow through raw or as params, never as catalog text. Every `t(`/`tf(` first argument is a string LITERAL.
//
// Overlay a11y wiring. This view is a CONSTRUCTED shell:
// its root is `document.createElement`'d here and appended into the shared `#app` MOUNT, so unlike
// the ten static shells S3 wired it ships NO ARIA of its own from `client/index.html` — every
// attribute below comes from `openOverlayA11y`, never from a literal in this file.
//
// THE EDGE, AND WHY IT IS READ FIRST. `wasVisible` is read as the FIRST statement of `show()`,
// before any write. A re-open tears down and re-schedules `openOverlayA11y`'s deferred focus, which
// drags focus off whatever control the player had Tabbed to — invisible to every attribute
// assertion, since a re-open rewrites the same values.
//
// AND WHY THE CLOSE IS DELIBERATELY UNGUARDED. `hide()` calls `closeOverlayA11y` every time, even
// when already hidden. A guarded close reads correct and passes every other assertion while
// permanently leaking a live capture listener, a pending timer and an expiring return target
// whenever a record desynchronises from the DOM; `closeOverlayA11y` with no record is a documented
// pure no-op, so unguarded is the self-healing path. S3's red-team measured the guarded shape
// shipping 62/62 green.
//
// THE OPEN IS THE LAST STATEMENT of the open path, after the display write: in a real browser
// `.focus()` on a `display:none` node is a silent no-op, so an open-before-paint overlay announces
// itself and then never receives focus.
//
// Each `#app`-mounted view creates its OWN root under the shared mount, so opening this view
// never closes a sibling (no close-before-open; boxView.test.ts S4-CROSS-VIEW-DISTINCT-ROOTS).

import {
  type BagAction,
  type BagItemVm,
  type BagVm,
  bagLayout,
  findItem,
  infoLayout,
  isBagBackKey,
  itemActions,
  listNav,
  type Pocket,
  pickerLayout,
} from './bagModel';
import {
  type ContextSheet,
  type ContextSheetContent,
  closeContextSheet,
  createContextSheet,
  placeContextSheet,
  renderContextSheet,
} from './contextSheet';
import { createEmptyState } from './emptyState';
import { currentLocale, t, tf } from './i18n/resolver';
import { renderNav } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { InventoryItemViewModel, RaisingViewModel } from './raisingModel';
import type { BagPaint } from './screens/bagScreen';
import { createTabBar, renderTabBar, type TabBar } from './tabBar';

// ctl-8f: this root is the Bag frame. `paint(BagPaint)` (screens/bagScreen.ts) draws the pocket
// tabs, the active pocket's items, the item sheet, the description, the monster picker and the
// status line over the nav kit. Until the adapter's first paint (the first batch or button after an
// open) the legacy inventory grid shows instead; `hide()` drops the kept paint.
//
// uif-8: the frame is built like Monsters' (boxView.ts), so Chromium computes the same spacing: a
// header row holding the title, the kit's TabBar for the pockets, then the tab content area
// `#bag-panel`, which grows to the frame and clips. It holds the list (pseudo-scrolled: renderNav
// scrolls the cursor row into view, the pointer source's wheel presses Up / Down over it, and `.mr-scroll`
// draws the cue), the EmptyState of an empty pocket, the legacy grid and the frame's one
// ContextSheet: the item's actions ending with Close, the Feed picker ending with Back, or the Info
// page (the detail variant, one Back row). The status line `#bag-status` is hidden while empty.
const POCKET_LABELS: Readonly<Record<Pocket, () => string>> = {
  bait: () => t('bag.pocket.bait'),
  food: () => t('bag.pocket.food'),
  medicine: () => t('bag.pocket.medicine'),
  other: () => t('bag.pocket.other'),
};

const ACTION_LABELS: Readonly<Record<BagAction, () => string>> = {
  feed: () => t('bag.action.feed'),
  use: () => t('bag.action.use'),
  info: () => t('bag.action.info'),
  close: () => t('kit.sheet.close'),
};

/** The frame id of every row the one sheet shows (actions, monsters, Back). */
const SHEET_FRAME = 'bagsheet';

/** The tab content area: boxView's `#monsters-panel`, so both frames compute the same, except its
 *  floor: it never shrinks below about four list rows (a row is a body line plus its padding), so on
 *  a tiny window the shell scrolls before the panel would clip the pocket's only rows or its
 *  EmptyState away (UIF4.3: the last row stays reachable above the strip). */
const PANEL_STYLE =
  'flex:1 1 auto;width:100%;max-width:var(--mr-content-max);align-self:center;' +
  'min-height:calc(4 * (var(--mr-font-body-line) * 1em + var(--mr-space-1)) + 2 * var(--mr-space-2));' +
  'box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;' +
  'padding:var(--mr-space-2);position:relative;';

/** The Bag status line's text (empty with no status). */
function statusText(status: BagPaint['status']): string {
  if (status === null) return '';
  switch (status.kind) {
    case 'fed':
      return tf('box.feedback.fed', { name: status.name });
    case 'noMonsters':
      return t('bag.feed.noMonsters');
    case 'battleOnly':
      return t('menu.disabled.battleBag');
  }
}

function setShown(el: HTMLElement, shown: boolean): void {
  el.style.display = shown ? '' : 'none';
}

export class RaisingView {
  readonly #root: HTMLDivElement;
  /** The "Raising & Inventory" heading; its text is resolved in show(), not here. */
  readonly #titleEl: HTMLHeadingElement;
  readonly #panel: HTMLDivElement;
  readonly #tabBar: TabBar;
  readonly #sheet: ContextSheet;
  /** The section heading; text resolved in show() (see show()). */
  readonly #inventoryLabelEl: HTMLHeadingElement;
  readonly #inventoryEl: HTMLDivElement;
  #visible = false;
  // What the inventory grid shows, as a render key (R-ci-fix-20261002T0901Z-RAISINGVIEWREBUILD):
  // a store batch arrives several times a second, and the grid must not be rebuilt for an unchanged
  // view-model on each one.
  readonly #rendered = new Map<HTMLElement, string>();
  // ctl-8f: the Bag panel's parts and the kept paint (null until the adapter paints this open).
  readonly #bagList: HTMLDivElement;
  readonly #bagEmpty: HTMLDivElement;
  readonly #bagStatus: HTMLDivElement;
  #bagPaint: BagPaint | null = null;

  /** `_retired` is accepted and never read: overlayA11yWiring.test.ts (outside qf-9's touches)
   *  still passes the deleted cards' `{ onTrain, onCare }` (R-qf-9-RAISINGVESTIGES). */
  constructor(parent: HTMLElement, _retired?: unknown) {
    this.#root = document.createElement('div');
    // ctl-7b: a class-styled frame. `.mr-shell` places it inside `#game-screen` (the `#app` mount
    // main.ts passes is inside it) and `.mr-frame` paints the frame tokens; inline is only the
    // display toggle and the centring.
    this.#root.className = 'mr-frame mr-shell';
    // uif-8: inline only the display toggle (the measured `align-items:center` is gone: the frame
    // lays out like Monsters').
    this.#root.style.cssText = 'display:none;';

    // The header row, as Monsters' (boxView.ts): it owns the gap under the title.
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:16px;margin-bottom:16px;';
    // NO text here — `raising.title` is resolved in show() (see there for why).
    const title = document.createElement('h2');
    // The OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'raising-title');
    title.setAttribute('tabindex', '-1');
    title.style.cssText = 'margin:0;color:#fff;';
    this.#titleEl = title;
    header.appendChild(title);
    this.#root.appendChild(header);

    // Its text (`raising.inventory.heading`) is resolved in show(), not here.
    const inventoryLabel = document.createElement('h3');
    inventoryLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#inventoryLabelEl = inventoryLabel;
    this.#root.appendChild(inventoryLabel);

    // The pockets: the kit's TabBar (its strip keeps the id `bag-tabs`, which e2e keys on), hidden
    // until the adapter paints.
    this.#tabBar = createTabBar(document, { id: 'bag-tabs' });
    this.#root.appendChild(this.#tabBar.root);

    // The tab content area (see PANEL_STYLE); also the sheet's containing block.
    this.#panel = document.createElement('div');
    this.#panel.id = 'bag-panel';
    this.#panel.style.cssText = PANEL_STYLE;
    this.#root.appendChild(this.#panel);

    // The list never shows a scrollbar: the cursor scrolls it (`renderNav` scrolls the active row
    // into view, once per row).
    this.#bagList = document.createElement('div');
    this.#bagList.id = 'bag-list';
    this.#bagList.style.cssText = 'display:none;flex:1 1 auto;min-height:0;overflow-y:hidden;';
    this.#bagEmpty = document.createElement('div');
    this.#bagEmpty.id = 'bag-empty';
    this.#bagEmpty.style.display = 'none';

    this.#inventoryEl = document.createElement('div');
    this.#inventoryEl.id = 'raising-inventory';
    this.#inventoryEl.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:700px;';

    this.#sheet = createContextSheet(document, { frame: SHEET_FRAME });
    this.#sheet.root.id = 'bag-sheet';
    this.#panel.append(this.#bagList, this.#bagEmpty, this.#inventoryEl, this.#sheet.root);
    // Re-place the open sheet when the panel's size changes. Never disconnected: the view lives as
    // long as the page, and a hidden frame places nothing.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (this.#visible) this.#placeSheet();
      }).observe(this.#panel);
    }

    // The frame's one line, a direct root child (the strip's sticky rule keys on it); hidden while
    // empty (R-uif-4-BAGSTATUS-EMPTY).
    this.#bagStatus = document.createElement('div');
    this.#bagStatus.id = 'bag-status';
    this.#bagStatus.className = 'mr-frame-feedback';
    this.#bagStatus.style.display = 'none';
    this.#root.appendChild(this.#bagStatus);

    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  toggle(): void {
    this.#visible ? this.hide() : this.show();
  }

  show(): void {
    const wasVisible = this.#visible;
    this.#visible = true;
    // A new open shows the legacy grid until its adapter paints, whatever was painted since the
    // close (an observe may land between a hide and the stack's sync).
    if (!wasVisible) {
      this.#bagPaint = null;
      this.#applyBag();
    }
    // The strings set ONCE and never rewritten by a render are resolved
    // HERE, on EVERY show() — unconditionally, after the `wasVisible` read, before the display
    // write. See evolutionView.show() for the boot-order / locale-switch reasoning.
    this.#titleEl.textContent = t('raising.title');
    this.#inventoryLabelEl.textContent = t('raising.inventory.heading');
    this.#root.style.display = 'flex';
    if (!wasVisible) openOverlayA11y('raisingView', this.#root);
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
    // The next open shows the legacy grid until its adapter paints.
    this.#bagPaint = null;
    this.#applyBag();
    closeOverlayA11y('raisingView', null);
  }

  /** The Bag screen's paint: kept until the next `hide()`. */
  paint(p: BagPaint): void {
    this.#bagPaint = p;
    this.#applyBag();
  }

  #applyBag(): void {
    const p = this.#bagPaint;
    this.#inventoryEl.style.display = p === null ? 'grid' : 'none';
    setShown(this.#bagList, p !== null);
    const hadFocus = this.#sheet.root.contains(document.activeElement);
    if (p === null) {
      this.#tabBar.root.hidden = true;
      this.#closeSheet();
      this.#showEmpty(false);
      this.#setStatus(null);
      return;
    }

    const { vm, nav } = p;
    const layout = bagLayout(vm);
    renderTabBar(this.#tabBar, layout, nav, {
      frame: 'bag',
      label: (tab) => POCKET_LABELS[tab.key as Pocket](),
    });
    const pocket = vm.pockets.find((pk) => pk.pocket === nav.tab);
    renderNav(this.#bagList, layout, nav, {
      frame: 'bag',
      fill: (el, row) => {
        const it = pocket?.items.find((i) => i.key === row.key);
        if (it !== undefined) {
          el.textContent = tf('raising.inventory.item', { name: it.name, count: it.count });
        }
      },
    });
    // An empty pocket, or no pocket at all (no item definitions yet), says why, where items come
    // from and what to do (UIF8.4). The cue only over rows: an empty list has nothing to scroll.
    const empty = pocket === undefined || pocket.items.length === 0;
    this.#bagList.classList.toggle('mr-scroll', !empty);
    this.#showEmpty(empty);

    const item = p.phase.kind === 'list' ? undefined : findItem(vm, p.phase.itemId);
    const content = item === undefined ? null : this.#sheetContent(p, vm, item);
    if (content === null) this.#closeSheet();
    else renderContextSheet(this.#sheet, content);
    this.#placeSheet();
    // Focus inside a sheet that closes stays in the frame. (While it shows, its rows container is
    // kept across repaints and is the only focusable part, so focus never leaves it.)
    if (hadFocus && this.#sheet.root.hidden) this.#titleEl.focus();

    this.#setStatus(p.status);

    // A part hidden under the focus would strand it (the next key would heal focus to the world,
    // out of the frame): hand it to the frame's anchor (boxView's rule).
    const focused = document.activeElement;
    if (this.#visible && focused instanceof HTMLElement && this.#hiddenInFrame(focused)) {
      this.#titleEl.focus();
    }
  }

  /** The one sheet's content for this paint's phase over `item`: the actions (ending with Close),
   *  the Feed picker (ending with Back) or the Info page (the detail variant, one Back row). */
  #sheetContent(p: BagPaint, vm: BagVm, item: BagItemVm): ContextSheetContent | null {
    const phase = p.phase;
    switch (phase.kind) {
      case 'list':
        return null;
      case 'sheet':
        return {
          variant: 'list',
          title: item.name,
          layout: itemActions(vm, item),
          state: listNav(phase.action),
          fill: (el, row) => {
            el.textContent = ACTION_LABELS[row.key as BagAction]();
          },
        };
      case 'picker':
        return {
          variant: 'list',
          title: t('bag.picker.title'),
          layout: pickerLayout(vm),
          state: listNav(phase.monster),
          fill: (el, row) => {
            el.textContent = isBagBackKey(row.key)
              ? t('kit.sheet.back')
              : (vm.monsters.find((m) => m.key === row.key)?.name ?? '');
          },
        };
      case 'info':
        return {
          variant: 'detail',
          title: item.name,
          prose: item.description || t('shop.description.none'),
          layout: infoLayout,
          state: listNav(null),
          fill: (el) => {
            el.textContent = t('kit.sheet.back');
          },
        };
    }
  }

  /** Close the sheet if it shows. Never on a closed one: `renderNav` makes its rows a tab stop,
   *  and a never-opened sheet has none. */
  #closeSheet(): void {
    if (!this.#sheet.root.hidden) closeContextSheet(this.#sheet);
  }

  /** Anchor the shown sheet away from the cursor row (the kit's rule). Nothing to place while the
   *  sheet is hidden, the panel has no box (hidden, or no layout engine) or no row is active. */
  #placeSheet(): void {
    if (this.#sheet.root.hidden || this.#panel.getBoundingClientRect().width <= 0) return;
    const row = this.#bagList.querySelector<HTMLElement>('[data-nav-key].is-active');
    if (row !== null) placeContextSheet(this.#sheet, this.#panel, row);
  }

  /** Show (rebuilt in the current locale) or hide and empty the pocket's EmptyState. */
  #showEmpty(shown: boolean): void {
    setShown(this.#bagEmpty, shown);
    this.#bagEmpty.replaceChildren(
      ...(shown
        ? [
            createEmptyState(document, {
              reason: t('raising.inventory.empty'),
              cue: t('bag.empty.cue'),
              nextStep: t('bag.empty.next'),
            }),
          ]
        : []),
    );
  }

  /** The frame's line: hidden and emptied with no status (R-uif-4-BAGSTATUS-EMPTY). */
  #setStatus(status: BagPaint['status']): void {
    setShown(this.#bagStatus, status !== null);
    if (status?.kind === 'fed') this.#bagStatus.setAttribute('data-feedback', 'ok');
    else this.#bagStatus.removeAttribute('data-feedback');
    this.#bagStatus.textContent = statusText(status);
  }

  /** Whether `el` sits in the frame below an inline-hidden part (the root itself excluded). */
  #hiddenInFrame(el: HTMLElement): boolean {
    if (!this.#root.contains(el)) return false;
    for (let n: HTMLElement | null = el; n !== null && n !== this.#root; n = n.parentElement) {
      if (n.style.display === 'none' || n.hidden) return true;
    }
    return false;
  }

  /** Renders the inventory grid; `vm.monsters` is not read (qf-9: the cards are gone). */
  refresh(vm: RaisingViewModel): void {
    this.#renderIfChanged(this.#inventoryEl, [vm.items], () => this.#renderInventory(vm.items));
  }

  /** Runs `render` for `el` unless `shown` — everything that render reads, plus the locale its
   *  strings resolve in — is what `el` already shows (the pvpView.ts shape). The key is JSON with
   *  bigints as decimal strings (never Number: ids past 2^53 would collide). A render that throws
   *  leaves `el` with no key, so the next refresh renders it again. */
  #renderIfChanged(el: HTMLElement, shown: readonly unknown[], render: () => void): void {
    const key = JSON.stringify([currentLocale(), ...shown], (_, v: unknown) =>
      typeof v === 'bigint' ? `${v}` : v,
    );
    if (this.#rendered.get(el) === key) return;
    this.#rendered.delete(el);
    render();
    this.#rendered.set(el, key);
  }

  #renderInventory(items: readonly InventoryItemViewModel[]): void {
    this.#inventoryEl.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = t('raising.inventory.empty');
      empty.style.color = '#aaa';
      this.#inventoryEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const el = document.createElement('div');
      el.style.cssText = 'border:1px solid #444;border-radius:4px;padding:8px;background:#1a1a2e;';

      const nameSpan = document.createElement('div');
      nameSpan.textContent = tf('raising.inventory.item', { name: item.name, count: item.count });
      nameSpan.style.fontWeight = 'bold';
      el.appendChild(nameSpan);

      const desc = document.createElement('div');
      desc.style.cssText = 'font-size:11px;margin-top:4px;color:#ccc;';
      desc.textContent = item.description;
      el.appendChild(desc);

      this.#inventoryEl.appendChild(el);
    }
  }
}
