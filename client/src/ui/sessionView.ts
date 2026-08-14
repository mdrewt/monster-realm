// ui/sessionView.ts — DOM shell for the session-lifecycle overlay (M21b-2, ADR-0182 D17).
// DOM shell — coverage-excluded (all logic lives in sessionModel.ts). REGISTRY-EXTERNAL by
// design: it is NOT an OverlayId member (a second EXCLUSIVE_TOP would break overlayRegistry's
// decide(), D17). main.ts drives it directly from `conn.sessionState()`, checked first on every
// input path via `sessionGateBlocks()`.
import type { SessionViewModel } from './sessionModel';

export interface SessionViewHandlers {
  readonly onContinueRequested: () => void;
  readonly onContinueConfirmed: () => void;
  readonly onConfirmCancelled: () => void;
  readonly onRetry: () => void;
}

function ensureElement(id: string, tag = 'div'): HTMLElement {
  const found = document.getElementById(id);
  if (found) return found;
  const el = document.createElement(tag);
  el.id = id;
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

export class SessionView {
  readonly #overlay: HTMLElement;
  readonly #title: HTMLElement;
  readonly #body: HTMLElement;
  readonly #confirm: HTMLElement;
  readonly #feedback: HTMLElement;

  constructor(handlers: SessionViewHandlers) {
    this.#overlay = ensureElement('session-overlay');
    this.#title = ensureElement('session-title', 'h2');
    this.#body = ensureElement('session-body', 'p');
    this.#confirm = ensureElement('session-confirm', 'p');
    this.#feedback = ensureElement('session-feedback', 'p');
    for (const child of [this.#title, this.#body, this.#confirm, this.#feedback]) {
      if (child.parentElement !== this.#overlay) this.#overlay.appendChild(child);
    }
    this.#wireButton('session-continue-btn', handlers.onContinueRequested);
    this.#wireButton('session-continue-confirm-btn', handlers.onContinueConfirmed);
    this.#wireButton('session-continue-cancel-btn', handlers.onConfirmCancelled);
    this.#wireButton('session-retry-btn', handlers.onRetry);
  }

  #wireButton(id: string, handler: () => void): void {
    const btn = ensureElement(id, 'button');
    if (btn.parentElement !== this.#overlay) this.#overlay.appendChild(btn);
    btn.addEventListener('click', () => handler());
  }

  render(vm: SessionViewModel): void {
    this.#overlay.style.display = vm.visible ? 'block' : 'none';
    this.#title.textContent = vm.title;
    this.#body.textContent = vm.body;
    this.#confirm.textContent = vm.confirmPrompt ?? '';
    this.#confirm.style.display = vm.confirmPrompt === undefined ? 'none' : 'block';
    this.#feedback.textContent = vm.feedback ?? '';
    this.#feedback.style.display = vm.feedback === undefined ? 'none' : 'block';
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none' && this.#overlay.style.display !== '';
  }

  hide(): void {
    this.#overlay.style.display = 'none';
  }
}
