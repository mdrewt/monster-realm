// ui/shopView.ts — thin DOM shell for the shop screen (M13d, ADR-0084).
// Pure rendering from ShopScreenViewModel. No logic — all logic is in shopModel.ts.
// Coverage-excluded per vite.config.ts (DOM shell; behavior validated by e2e).
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type {
  ShopInventoryItemViewModel,
  ShopItemViewModel,
  ShopScreenViewModel,
} from './shopModel';

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
  readonly #cbs: ShopCallbacks;
  // In-flight lock: prevents double-spend when a reducer Promise is pending.
  #pending = false;

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
    // ux2 (ADR-0154): the gold readout is created here, not in index.html, and is
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
    this.#cbs = cbs;
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    // m23-s3 D1: read visibility BEFORE the display write. `show()` is called REPEATEDLY on an
    // already-open overlay (pvpView.ts is the extreme case, main.ts:1699-1701), and a re-open
    // re-schedules overlayA11y's deferred focus -- which would yank focus back to the initial
    // anchor on every store batch. Only the hidden->visible EDGE opens.
    const wasVisible = this.visible;
    this.#overlay.style.display = '';
    if (!wasVisible) openOverlayA11y('shopView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    this.#feedbackEl.textContent = '';
    this.#pending = false;
    // m23-s3 D2: DELIBERATELY UNGUARDED (see pvpView.ts's header). closeOverlayA11y is a
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

    if (vm.kind === 'no-shop') {
      this.#title.textContent = 'Shop';
      this.#forSaleList.innerHTML = '<li>No shop available.</li>';
      this.#inventoryList.innerHTML = '';
      return;
    }

    this.#title.textContent = vm.shopName;
    this.#forSaleList.innerHTML = '';
    for (const item of vm.forSale) {
      this.#forSaleList.appendChild(this.#makeBuyRow(vm.shopId, item));
    }
    if (vm.forSale.length === 0) {
      this.#forSaleList.innerHTML = '<li>Nothing for sale.</li>';
    }

    this.#inventoryList.innerHTML = '';
    for (const item of vm.forSaleByPlayer) {
      this.#inventoryList.appendChild(this.#makeSellRow(item));
    }
    if (vm.forSaleByPlayer.length === 0) {
      this.#inventoryList.innerHTML = '<li>No items to sell.</li>';
    }
  }

  /** Display a feedback message (reducer success/failure). */
  showFeedback(message: string): void {
    this.#feedbackEl.textContent = message;
  }

  #makeBuyRow(shopId: number, item: ShopItemViewModel): HTMLElement {
    const li = document.createElement('li');
    li.textContent = `${item.name} — ${item.buyPrice} gold `;
    const btn = document.createElement('button');
    btn.textContent = 'Buy';
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
    if (item.canSell) {
      li.textContent = `${item.name} (×${item.count}) — ${item.sellPrice} gold `;
      const btn = document.createElement('button');
      btn.textContent = 'Sell';
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
      li.textContent = `${item.name} (×${item.count}) — Cannot sell`;
    }
    return li;
  }
}
