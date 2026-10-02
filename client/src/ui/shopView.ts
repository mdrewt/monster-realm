// ui/shopView.ts — thin DOM shell for the shop screen.
// Pure rendering from ShopScreenViewModel. No logic — all logic is in shopModel.ts.
// Coverage-excluded per vite.config.ts (DOM shell; behavior validated by e2e).
//
// Every player-facing string this view renders is resolved through the i18n
// resolver (`t()`/`tf()`, ui/i18n/resolver.ts) with a `shop.*` key from ui/i18n/catalog.en.ts;
// the English bytes are unchanged (the catalog pins them, TRAILING SPACE of the buy/sell rows
// included). `vm.shopName`, `vm.balance.label` and the `showFeedback` message are model data,
// rendered raw; item names, counts and bigint prices flow through as params. Every `t(`/`tf(`
// first argument is a string LITERAL, and the `emptyRow` helper stays (nested `emptyRow(t('…'))`).
// No constructor-time strings: this view renders into the static index.html shell.
//
// THE TABS, THE CURSOR AND THE PROMPTS (ctl-8a, CTL8A.2). The shop screen (ui/screens/
// shopScreen.ts) paints `ShopPaint`: the tab, the cursor row, the Y description and the quantity /
// confirm prompt, into elements this view creates (locate-or-create, no strings at construction).
// BOTH lists are still built by every `render(vm)` — main.ts's feedback tests click their buttons
// after a bare batch, and wallet-balance.spec.ts reads `#shop-for-sale` at first paint — the tabs
// only hide the inactive one and move the cursor. The kept paint is re-applied after every batch
// render and reset to its opening value (Buy, the first row) by a render while hidden and by the
// hidden→visible edge, so a reopened shop never sits under the last visit's confirm.
import { t, tf } from './i18n/resolver';
import { list, tabs } from './nav';
import { renderNav, renderTabs } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import {
  type ShopInventoryItemViewModel,
  type ShopItemViewModel,
  type ShopScreenViewModel,
  type ShopTab,
  shopBuyKey,
  shopSellKey,
} from './shopModel';

/** What the shop screen paints. `activeKey` is a `shopBuyKey` / `shopSellKey` of the active tab's
 *  list; `description` is `undefined` before Y (an empty slot) and `null` for an item with none
 *  (the catalogued mark). */
export interface ShopPaint {
  readonly tab: ShopTab;
  readonly activeKey: string | null;
  readonly description: string | null | undefined;
  readonly prompt:
    | null
    | { readonly kind: 'qty'; readonly tab: ShopTab; readonly name: string; readonly qty: number }
    | {
        readonly kind: 'confirm';
        readonly tab: ShopTab;
        readonly name: string;
        readonly qty: number;
        readonly gold: bigint;
        readonly yes: boolean;
      };
}

/** The opening paint: the Buy tab on its first row (`activeKey` null stands for "the first keyed
 *  row", resolved against the list at apply time, so a render before any paint already shows it). */
const OPENING: ShopPaint = { tab: 'buy', activeKey: null, description: undefined, prompt: null };

/** The tab strip's layout: the two tabs, no rows (renderTabs reads only the keys). */
const TAB_STRIP = tabs([
  { key: 'buy', layout: list([]) },
  { key: 'sell', layout: list([]) },
]);
const CONFIRM_LAYOUT = list([
  { key: 'yes', enabled: true },
  { key: 'no', enabled: true },
]);
/** The Yes / No option labels by nav key, as thunks (resolved per render; ids stay literals). */
const OPTION_LABELS: Readonly<Record<string, () => string>> = {
  yes: () => t('prompt.yes'),
  no: () => t('prompt.no'),
};

/** The prompt's question in the current locale. */
function promptText(prompt: NonNullable<ShopPaint['prompt']>): string {
  const buying = prompt.tab === 'buy';
  if (prompt.kind === 'qty') {
    const { name, qty } = prompt;
    return buying ? tf('shop.qty.buy', { name, qty }) : tf('shop.qty.sell', { name, qty });
  }
  const { qty, name, gold } = prompt;
  return buying
    ? tf('shop.confirm.buy', { qty, name, gold })
    : tf('shop.confirm.sell', { qty, name, gold });
}

/** Locate-or-create `#id` right after `after`, a `div` unless `tag` says otherwise. */
function part(after: Element, id: string, tag: 'div' | 'p' = 'div'): HTMLElement {
  const existing = document.getElementById(id);
  if (existing !== null) return existing;
  const el = document.createElement(tag);
  el.id = id;
  after.insertAdjacentElement('afterend', el);
  return el;
}

/** The empty-state row is ELEMENT-built — `createElement` +
 *  `textContent`, never `innerHTML` markup. The client has zero HTML-parsing sinks
 *  (pinned by `i18n-no-html-sink.test.ts`) so a future catalog value can never be
 *  parsed as HTML. Clears use `replaceChildren()` for the same reason. */
function emptyRow(text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.textContent = text;
  return li;
}

export interface ShopCallbacks {
  readonly onBuy: (shopId: number, itemId: number) => void;
  readonly onSell: (itemId: number) => void;
}

export class ShopView {
  readonly #overlay: HTMLElement;
  readonly #title: HTMLElement;
  readonly #forSaleList: HTMLElement;
  readonly #inventoryList: HTMLElement;
  readonly #feedbackEl: HTMLElement;
  readonly #balanceEl: HTMLElement;
  readonly #tabStrip: HTMLElement;
  readonly #description: HTMLElement;
  readonly #prompt: HTMLElement;
  readonly #promptText: HTMLElement;
  readonly #confirm: HTMLElement;
  readonly #cbs: ShopCallbacks;
  // In-flight lock: prevents double-spend when a reducer Promise is pending.
  #pending = false;
  #paint: ShopPaint = OPENING;
  /** The cursor row last scrolled into view, so a batch render does not scroll again. */
  #scrolledKey: string | null = null;

  constructor(cbs: ShopCallbacks) {
    const el = document.getElementById('shop-overlay');
    if (!el) throw new Error('shop-overlay element not found in DOM');
    this.#overlay = el;
    this.#title =
      el.querySelector('#shop-title') ??
      (() => {
        throw new Error('shop-title missing');
      })();
    this.#forSaleList =
      el.querySelector('#shop-for-sale') ??
      (() => {
        throw new Error('shop-for-sale missing');
      })();
    this.#inventoryList =
      el.querySelector('#shop-inventory') ??
      (() => {
        throw new Error('shop-inventory missing');
      })();
    this.#feedbackEl =
      el.querySelector('#shop-feedback') ??
      (() => {
        throw new Error('shop-feedback missing');
      })();
    // The gold readout is created here, not in index.html, and is
    // inserted directly after the shop title so it reads as part of the shop panel.
    // No inline positioning: #shop-overlay is a plain in-flow shell, and floating
    // just this child would put a naked balance in the viewport corner while the
    // panel it belongs to stays below the fold (owned by the overlay-registry slice).
    // Locate-or-create so a second construction against the same document cannot
    // produce a duplicate `id` (the shipped app builds one ShopView, but an
    // idempotent lookup costs nothing and keeps the invariant local).
    const existing = el.querySelector('#shop-balance');
    let balanceEl: Element;
    if (existing === null) {
      const created = document.createElement('p');
      created.id = 'shop-balance';
      created.hidden = true;
      this.#title.insertAdjacentElement('afterend', created);
      balanceEl = created;
    } else {
      balanceEl = existing;
    }
    this.#balanceEl = balanceEl as HTMLElement;
    // The balance in the title (CTL8A.2): one title bar holds the title, then the balance.
    // Locate-or-create, like the balance above; the nodes are MOVED, never cloned.
    let bar = this.#title.parentElement;
    if (bar === null || !bar.classList.contains('mr-frame-titlebar')) {
      bar = document.createElement('div');
      bar.className = 'mr-frame-titlebar';
      this.#title.insertAdjacentElement('beforebegin', bar);
      bar.append(this.#title, this.#balanceEl);
    }
    this.#tabStrip = part(bar, 'shop-tabs');
    this.#description = part(this.#inventoryList, 'shop-description', 'p');
    this.#prompt = part(this.#description, 'shop-prompt');
    this.#promptText = part(this.#prompt, 'shop-prompt-text', 'p');
    this.#confirm = part(this.#promptText, 'shop-confirm');
    if (this.#promptText.parentElement !== this.#prompt) this.#prompt.append(this.#promptText);
    if (this.#confirm.parentElement !== this.#prompt) this.#prompt.append(this.#confirm);
    this.#cbs = cbs;
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    // Read visibility BEFORE the display write. `show()` is called REPEATEDLY on an
    // already-open overlay (pvpView.ts is the extreme case, main.ts:1699-1701), and a re-open
    // re-schedules overlayA11y's deferred focus -- which would yank focus back to the initial
    // anchor on every store batch. Only the hidden->visible EDGE opens.
    const wasVisible = this.visible;
    this.#overlay.style.display = '';
    if (!wasVisible) {
      // A reopened shop starts over: the Buy tab, its first row, no prompt from the last visit.
      this.#paint = OPENING;
      this.#apply();
      openOverlayA11y('shopView', this.#overlay);
    }
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    this.#feedbackEl.textContent = '';
    this.#pending = false;
    // DELIBERATELY UNGUARDED (see pvpView.ts's header). closeOverlayA11y is a
    // documented no-op with no open record, and leaving it unguarded is what lets a record
    // that ever desynchronised from the DOM self-heal instead of leaking a live trap forever.
    closeOverlayA11y('shopView', null);
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Render or re-render the shop view from the view model. */
  render(vm: ShopScreenViewModel): void {
    // BEFORE the no-shop early return: the balance is owned by the wallet view, not
    // by shop proximity, so the no-shop path must still refresh it (a write placed
    // after the return would freeze a stale gold count on screen).
    const known = vm.balance.kind === 'known';
    this.#balanceEl.textContent = known ? vm.balance.label : '';
    this.#balanceEl.hidden = !known;
    this.#balanceEl.dataset.balanceState = vm.balance.kind;
    // openPendingShop renders BEFORE show(): a render while hidden is an open, so it starts over.
    if (!this.visible) this.#paint = OPENING;

    if (vm.kind === 'no-shop') {
      this.#title.textContent = t('shop.title');
      this.#forSaleList.replaceChildren(emptyRow(t('shop.noShop')));
      this.#inventoryList.replaceChildren();
      this.#apply();
      return;
    }

    this.#title.textContent = vm.shopName;
    this.#forSaleList.replaceChildren();
    for (const item of vm.forSale) {
      this.#forSaleList.appendChild(this.#makeBuyRow(vm.shopId, item));
    }
    if (vm.forSale.length === 0) {
      this.#forSaleList.replaceChildren(emptyRow(t('shop.forSale.empty')));
    }

    this.#inventoryList.replaceChildren();
    for (const item of vm.forSaleByPlayer) {
      this.#inventoryList.appendChild(this.#makeSellRow(item));
    }
    if (vm.forSaleByPlayer.length === 0) {
      this.#inventoryList.replaceChildren(emptyRow(t('shop.inventory.empty')));
    }
    this.#apply();
  }

  /** Display a feedback message (reducer success/failure). */
  showFeedback(message: string): void {
    this.#feedbackEl.textContent = message;
  }

  /** The screen's paint: kept, so the next batch render re-applies it. */
  paint(p: ShopPaint): void {
    this.#paint = p;
    this.#apply();
  }

  /** Apply the kept paint to the DOM the last render built: the tab strip, which list is shown,
   *  the cursor row (class AND aria-current, never colour alone), the description slot and the
   *  prompt. The cursor row is scrolled into view when it changes (`.mr-shell` scrolls). */
  #apply(): void {
    const p = this.#paint;
    const navState = { tab: p.tab, item: null, perTab: {} };
    renderTabs(this.#tabStrip, TAB_STRIP, navState, {
      frame: 'shop',
      label: (tab) => (tab.key === 'buy' ? t('shop.tab.buy') : t('shop.tab.sell')),
    });
    this.#forSaleList.hidden = p.tab !== 'buy';
    this.#inventoryList.hidden = p.tab !== 'sell';

    const active = p.tab === 'buy' ? this.#forSaleList : this.#inventoryList;
    const rows = Array.from(active.querySelectorAll<HTMLElement>('li[data-nav-key]'));
    const key = p.activeKey ?? rows[0]?.dataset.navKey ?? null;
    for (const listEl of [this.#forSaleList, this.#inventoryList]) {
      for (const li of Array.from(listEl.querySelectorAll<HTMLElement>('li'))) {
        const on = listEl === active && key !== null && li.dataset.navKey === key;
        li.classList.toggle('is-active', on);
        if (on) li.setAttribute('aria-current', 'true');
        else li.removeAttribute('aria-current');
        if (on && this.#scrolledKey !== key) {
          if (typeof li.scrollIntoView === 'function') li.scrollIntoView({ block: 'nearest' });
          this.#scrolledKey = key;
        }
      }
    }

    this.#description.textContent =
      p.description === undefined
        ? ''
        : p.description === null
          ? t('shop.description.none')
          : p.description;

    const prompt = p.prompt;
    this.#prompt.hidden = prompt === null;
    this.#confirm.hidden = prompt?.kind !== 'confirm';
    this.#promptText.textContent = prompt === null ? '' : promptText(prompt);
    if (prompt === null || prompt.kind !== 'confirm') return;
    renderNav(
      this.#confirm,
      CONFIRM_LAYOUT,
      { tab: null, item: prompt.yes ? 'yes' : 'no', perTab: {} },
      {
        frame: 'shopConfirm',
        labelledBy: 'shop-prompt-text',
        fill: (el, item) => {
          el.textContent = OPTION_LABELS[item.key]?.() ?? '';
        },
      },
    );
  }

  #makeBuyRow(shopId: number, item: ShopItemViewModel): HTMLElement {
    const li = document.createElement('li');
    li.className = 'mr-nav-item';
    li.dataset.navKey = shopBuyKey(item);
    li.textContent = tf('shop.buy.row', { name: item.name, price: item.buyPrice });
    const btn = document.createElement('button');
    btn.textContent = t('shop.buy.submit');
    btn.dataset.itemId = String(item.itemId);
    btn.addEventListener('click', () => {
      if (this.#pending) return;
      this.#pending = true;
      btn.disabled = true;
      void Promise.resolve(this.#cbs.onBuy(shopId, item.itemId)).finally(() => {
        this.#pending = false;
        btn.disabled = false;
      });
    });
    li.appendChild(btn);
    return li;
  }

  #makeSellRow(item: ShopInventoryItemViewModel): HTMLElement {
    const li = document.createElement('li');
    li.className = 'mr-nav-item';
    li.dataset.navKey = shopSellKey(item);
    if (item.canSell) {
      li.textContent = tf('shop.sell.row', {
        name: item.name,
        count: item.count,
        price: item.sellPrice,
      });
      const btn = document.createElement('button');
      btn.textContent = t('shop.sell.submit');
      btn.dataset.itemId = String(item.itemId);
      btn.addEventListener('click', () => {
        if (this.#pending) return;
        this.#pending = true;
        btn.disabled = true;
        void Promise.resolve(this.#cbs.onSell(item.itemId)).finally(() => {
          this.#pending = false;
          btn.disabled = false;
        });
      });
      li.appendChild(btn);
    } else {
      li.textContent = tf('shop.sell.unsellable', { name: item.name, count: item.count });
    }
    return li;
  }
}
