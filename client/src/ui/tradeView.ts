// ui/tradeView.ts — thin DOM shell for the trade overlay (m15b, ADR-0107).
// Pure rendering from TradeScreenViewModel. No logic — all logic is in tradeModel.ts.
// Coverage-excluded per vite.config.ts (DOM shell; behavior validated by e2e).
import type { TradeAction, TradeScreenViewModel, TradeSideViewModel } from './tradeModel';

export interface TradeCallbacks {
  readonly onAccept: (tradeId: bigint) => void;
  readonly onReject: (tradeId: bigint) => void;
  readonly onConfirm: (tradeId: bigint) => void;
  readonly onCancel: (tradeId: bigint) => void;
}

export class TradeView {
  readonly #overlay: HTMLElement;
  readonly #statusEl: HTMLElement;
  readonly #mySideEl: HTMLElement;
  readonly #theirSideEl: HTMLElement;
  readonly #actionsEl: HTMLElement;
  readonly #feedbackEl: HTMLElement;
  readonly #cbs: TradeCallbacks;
  // In-flight lock: prevents double-send when a reducer Promise is pending.
  #pending = false;

  constructor(cbs: TradeCallbacks) {
    const el = document.getElementById('trade-overlay');
    if (!el) throw new Error('trade-overlay element not found in DOM');
    this.#overlay = el;
    this.#statusEl =
      el.querySelector('#trade-status') ??
      (() => {
        throw new Error('trade-status missing');
      })();
    this.#mySideEl =
      el.querySelector('#trade-my-side') ??
      (() => {
        throw new Error('trade-my-side missing');
      })();
    this.#theirSideEl =
      el.querySelector('#trade-their-side') ??
      (() => {
        throw new Error('trade-their-side missing');
      })();
    this.#actionsEl =
      el.querySelector('#trade-actions') ??
      (() => {
        throw new Error('trade-actions missing');
      })();
    this.#feedbackEl =
      el.querySelector('#trade-feedback') ??
      (() => {
        throw new Error('trade-feedback missing');
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
    this.#pending = false;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Render or re-render the trade view from the view model. */
  render(vm: TradeScreenViewModel): void {
    if (vm.kind === 'no-trade') {
      this.#statusEl.textContent = 'No active trade';
      this.#mySideEl.innerHTML = '';
      this.#theirSideEl.innerHTML = '';
      this.#actionsEl.innerHTML = '';
      return;
    }

    this.#statusEl.textContent = vm.statusLabel;
    this.#renderSide(this.#mySideEl, vm.mySide, 'You offer');
    this.#renderSide(this.#theirSideEl, vm.theirSide, 'You receive');
    this.#renderActions(vm.tradeId, vm.actions);
  }

  /** Display a feedback message (reducer success/failure). */
  showFeedback(message: string): void {
    this.#feedbackEl.textContent = message;
  }

  #renderSide(el: HTMLElement, side: TradeSideViewModel, heading: string): void {
    el.innerHTML = '';
    const h = document.createElement('h4');
    h.textContent = heading;
    el.appendChild(h);

    if (side.cards.length > 0) {
      const ul = document.createElement('ul');
      ul.dataset.section = 'monsters';
      for (const card of side.cards) {
        const li = document.createElement('li');
        li.dataset.monsterId = card.monsterId.toString();
        li.textContent = `${card.nickname} (${card.speciesName}) Lv.${card.level} HP:${card.currentHp}/${card.statHp}`;
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }

    if (side.items.length > 0) {
      const ul = document.createElement('ul');
      ul.dataset.section = 'items';
      for (const item of side.items) {
        const li = document.createElement('li');
        li.textContent = `${item.name} ×${item.qty}`;
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }

    if (side.currency > 0n) {
      const p = document.createElement('p');
      p.dataset.currency = side.currency.toString();
      p.textContent = `${side.currency} gold`;
      el.appendChild(p);
    }

    if (side.cards.length === 0 && side.items.length === 0 && side.currency === 0n) {
      const p = document.createElement('p');
      p.textContent = '(nothing)';
      el.appendChild(p);
    }
  }

  #renderActions(tradeId: bigint, actions: readonly TradeAction[]): void {
    this.#actionsEl.innerHTML = '';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.dataset.action = action;
      btn.textContent = this.#actionLabel(action);
      btn.addEventListener('click', () => {
        if (this.#pending) return;
        this.#pending = true;
        btn.disabled = true;
        void Promise.resolve(this.#dispatch(action, tradeId)).finally(() => {
          this.#pending = false;
          btn.disabled = false;
        });
      });
      this.#actionsEl.appendChild(btn);
    }
  }

  #actionLabel(action: TradeAction): string {
    switch (action) {
      case 'accept':
        return 'Accept';
      case 'reject':
        return 'Reject';
      case 'confirm':
        return 'Confirm Trade';
      case 'cancel':
        return 'Cancel';
    }
  }

  #dispatch(action: TradeAction, tradeId: bigint): void {
    switch (action) {
      case 'accept':
        this.#cbs.onAccept(tradeId);
        break;
      case 'reject':
        this.#cbs.onReject(tradeId);
        break;
      case 'confirm':
        this.#cbs.onConfirm(tradeId);
        break;
      case 'cancel':
        this.#cbs.onCancel(tradeId);
        break;
    }
  }
}
