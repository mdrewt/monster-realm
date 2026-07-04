// ui/shopView.ts — thin DOM shell for the shop screen (M13d, ADR-0084).
// Pure rendering from ShopScreenViewModel. No logic — all logic is in shopModel.ts.
// Coverage-excluded per vite.config.ts (DOM shell; behavior validated by e2e).
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
  readonly #cbs: ShopCallbacks;

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
    this.#cbs = cbs;
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    this.#overlay.style.display = '';
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    this.#feedbackEl.textContent = '';
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Render or re-render the shop view from the view model. */
  render(vm: ShopScreenViewModel): void {
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
    btn.dataset['itemId'] = String(item.itemId);
    btn.addEventListener('click', () => this.#cbs.onBuy(shopId, item.itemId));
    li.appendChild(btn);
    return li;
  }

  #makeSellRow(item: ShopInventoryItemViewModel): HTMLElement {
    const li = document.createElement('li');
    if (item.canSell) {
      li.textContent = `${item.name} (×${item.count}) — ${item.sellPrice} gold `;
      const btn = document.createElement('button');
      btn.textContent = 'Sell';
      btn.dataset['itemId'] = String(item.itemId);
      btn.addEventListener('click', () => this.#cbs.onSell(item.itemId));
      li.appendChild(btn);
    } else {
      li.textContent = `${item.name} (×${item.count}) — Cannot sell`;
    }
    return li;
  }
}
