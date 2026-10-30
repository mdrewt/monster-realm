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
  bagLayout,
  findItem,
  itemActions,
  listNav,
  type Pocket,
  pickerLayout,
} from './bagModel';
import { currentLocale, t, tf } from './i18n/resolver';
import { navItemId, renderNav, renderTabs } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { InventoryItemViewModel, RaisingViewModel } from './raisingModel';
import type { BagPaint } from './screens/bagScreen';

// ctl-8f: this root is the Bag frame. `paint(BagPaint)` (screens/bagScreen.ts) draws the pocket
// tabs, the active pocket's items, the item sheet, the description, the monster picker and the
// status line over the nav kit. Until the adapter's first paint (the first batch or button after an
// open) the legacy inventory grid shows instead; `hide()` drops the kept paint.
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
};

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
  /** The section heading; text resolved in show() (see show()). */
  readonly #inventoryLabelEl: HTMLHeadingElement;
  readonly #inventoryEl: HTMLDivElement;
  #visible = false;
  // What the inventory grid shows, as a render key (R-ci-fix-20261002T0901Z-RAISINGVIEWREBUILD):
  // a store batch arrives several times a second, and the grid must not be rebuilt for an unchanged
  // view-model on each one.
  readonly #rendered = new Map<HTMLElement, string>();
  // ctl-8f: the Bag panel's parts and the kept paint (null until the adapter paints this open).
  readonly #bagTabs: HTMLDivElement;
  readonly #bagList: HTMLDivElement;
  readonly #bagEmpty: HTMLDivElement;
  readonly #bagSheet: HTMLDivElement;
  readonly #bagInfo: HTMLDivElement;
  readonly #bagPickerTitle: HTMLDivElement;
  readonly #bagPicker: HTMLDivElement;
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
    this.#root.style.cssText = 'display:none;align-items:center;';

    // NO text here — `raising.title` is resolved in show() (see there for why).
    const title = document.createElement('h2');
    // The OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'raising-title');
    title.setAttribute('tabindex', '-1');
    title.style.cssText = 'margin:0 0 16px;color:#fff;';
    this.#titleEl = title;
    this.#root.appendChild(title);

    // Its text (`raising.inventory.heading`) is resolved in show(), not here.
    const inventoryLabel = document.createElement('h3');
    inventoryLabel.style.cssText = 'margin:0 0 8px;color:#aaa;';
    this.#inventoryLabelEl = inventoryLabel;
    this.#root.appendChild(inventoryLabel);

    const part = (id: string): HTMLDivElement => {
      const el = document.createElement('div');
      el.id = id;
      el.style.display = 'none';
      this.#root.appendChild(el);
      return el;
    };
    this.#bagTabs = part('bag-tabs');
    this.#bagTabs.className = 'mr-frame-tabstrip';
    this.#bagList = part('bag-list');
    this.#bagEmpty = part('bag-empty');
    this.#bagSheet = part('bag-sheet');
    this.#bagInfo = part('bag-info');
    this.#bagPickerTitle = part('bag-picker-title');
    this.#bagPicker = part('bag-picker');
    this.#bagStatus = part('bag-status');
    this.#bagStatus.className = 'mr-frame-feedback';
    this.#bagStatus.style.display = '';

    this.#inventoryEl = document.createElement('div');
    this.#inventoryEl.id = 'raising-inventory';
    this.#inventoryEl.style.cssText =
      'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;max-width:700px;';
    this.#root.appendChild(this.#inventoryEl);

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
    setShown(this.#bagTabs, p !== null);
    setShown(this.#bagList, p !== null);
    const item = p === null || p.phase.kind === 'list' ? undefined : findItem(p.vm, p.phase.itemId);
    const phase = item === undefined ? 'list' : (p?.phase.kind ?? 'list');
    setShown(this.#bagSheet, phase === 'sheet');
    setShown(this.#bagInfo, phase === 'info');
    setShown(this.#bagPickerTitle, phase === 'picker');
    setShown(this.#bagPicker, phase === 'picker');
    if (p === null) {
      setShown(this.#bagEmpty, false);
      this.#bagEmpty.textContent = '';
      this.#bagStatus.textContent = '';
      this.#bagStatus.removeAttribute('data-feedback');
      return;
    }

    const { vm, nav } = p;
    const layout = bagLayout(vm);
    renderTabs(this.#bagTabs, layout, nav, {
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
    // An empty pocket, or no pocket at all (no item definitions yet), says so.
    const empty = pocket === undefined || pocket.items.length === 0;
    setShown(this.#bagEmpty, empty);
    this.#bagEmpty.textContent = empty ? t('raising.inventory.empty') : '';

    if (item !== undefined && p.phase.kind === 'sheet') {
      renderNav(this.#bagSheet, itemActions(vm, item), listNav(p.phase.action), {
        frame: 'bagsheet',
        labelledBy: navItemId('bag', nav.tab, item.key),
        fill: (el, row) => {
          el.textContent = ACTION_LABELS[row.key as BagAction]();
        },
      });
    }
    if (item !== undefined && p.phase.kind === 'info') {
      this.#bagInfo.textContent = item.description || t('shop.description.none');
    }
    if (item !== undefined && p.phase.kind === 'picker') {
      this.#bagPickerTitle.textContent = t('bag.picker.title');
      renderNav(this.#bagPicker, pickerLayout(vm), listNav(p.phase.monster), {
        frame: 'bagpick',
        labelledBy: 'bag-picker-title',
        fill: (el, row) => {
          el.textContent = vm.monsters.find((m) => m.key === row.key)?.name ?? '';
        },
      });
    }

    const status = p.status;
    if (status?.kind === 'fed') this.#bagStatus.setAttribute('data-feedback', 'ok');
    else this.#bagStatus.removeAttribute('data-feedback');
    this.#bagStatus.textContent = statusText(status);

    // A part hidden under the focus would strand it (the next key would heal focus to the world,
    // out of the frame): hand it to the frame's anchor (boxView's rule).
    const focused = document.activeElement;
    if (this.#visible && focused instanceof HTMLElement && this.#hiddenInFrame(focused)) {
      this.#titleEl.focus();
    }
  }

  /** Whether `el` sits in the frame below an inline-hidden part (the root itself excluded). */
  #hiddenInFrame(el: HTMLElement): boolean {
    if (!this.#root.contains(el)) return false;
    for (let n: HTMLElement | null = el; n !== null && n !== this.#root; n = n.parentElement) {
      if (n.style.display === 'none') return true;
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
