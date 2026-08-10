// ui/claimView.ts — DOM shell for the guest-claim overlay (M21b-2, ADR-0182 D16).
// DOM shell — coverage-excluded (all logic lives in claimModel.ts). Joins overlayRegistry as
// GUARD_ONLY, so `anyOverlayVisible()` suppresses movement input for free while it is open.
import type { ClaimViewModel } from './claimModel';

export interface ClaimViewHandlers {
  readonly onSignIn: () => void;
  readonly onJoin: () => void;
  readonly onDeclineRequested: () => void;
  readonly onDeclineConfirmed: () => void;
  readonly onDeclineCancelled: () => void;
}

/** Find an existing overlay element or create a detached one appended to <body>, so the shell
 *  works whether or not index.html declares it (it is never rendered under test). */
function ensureElement(id: string, tag = 'div'): HTMLElement {
  const found = document.getElementById(id);
  if (found) return found;
  const el = document.createElement(tag);
  el.id = id;
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

export class ClaimView {
  readonly #overlay: HTMLElement;
  readonly #title: HTMLElement;
  readonly #body: HTMLElement;
  readonly #nudge: HTMLElement;
  readonly #feedback: HTMLElement;
  readonly #confirm: HTMLElement;

  constructor(handlers: ClaimViewHandlers) {
    this.#overlay = ensureElement('claim-overlay');
    this.#title = ensureElement('claim-title', 'h2');
    this.#body = ensureElement('claim-body', 'p');
    this.#nudge = ensureElement('claim-nudge', 'p');
    this.#feedback = ensureElement('claim-feedback', 'p');
    this.#confirm = ensureElement('claim-confirm', 'p');
    for (const child of [this.#title, this.#body, this.#nudge, this.#feedback, this.#confirm]) {
      if (child.parentElement !== this.#overlay) this.#overlay.appendChild(child);
    }
    this.#wireButton('claim-signin-btn', handlers.onSignIn);
    this.#wireButton('claim-join-btn', handlers.onJoin);
    this.#wireButton('claim-decline-btn', handlers.onDeclineRequested);
    this.#wireButton('claim-decline-confirm-btn', handlers.onDeclineConfirmed);
    this.#wireButton('claim-decline-cancel-btn', handlers.onDeclineCancelled);
  }

  #wireButton(id: string, handler: () => void): void {
    const btn = ensureElement(id, 'button');
    if (btn.parentElement !== this.#overlay) this.#overlay.appendChild(btn);
    btn.addEventListener('click', () => handler());
  }

  /** Render from the pure VM (textContent only — the claim body is never player-controlled, but
   *  the discipline mirrors the rest of the UI: never innerHTML with data). */
  render(vm: ClaimViewModel): void {
    this.#overlay.style.display = vm.visible ? 'block' : 'none';
    this.#title.textContent = vm.title;
    this.#body.textContent = vm.body;
    this.#nudge.textContent = vm.nudge ?? '';
    this.#nudge.style.display = vm.nudge === undefined ? 'none' : 'block';
    this.#feedback.textContent = vm.feedback ?? '';
    this.#feedback.style.display = vm.feedback === undefined ? 'none' : 'block';
    this.#confirm.textContent = vm.confirmPrompt ?? '';
    this.#confirm.style.display = vm.confirmPrompt === undefined ? 'none' : 'block';
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none' && this.#overlay.style.display !== '';
  }

  show(): void {
    this.#overlay.style.display = 'block';
  }

  hide(): void {
    this.#overlay.style.display = 'none';
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }
}
