// ui/claimView.ts — DOM shell for the guest-claim overlay (M21b-2, ADR-0182 D16).
// DOM shell — coverage-excluded (all logic lives in claimModel.ts). Joins overlayRegistry as
// GUARD_ONLY, so `anyOverlayVisible()` suppresses movement input for free while it is open.
//
// m23-s4 (M23 §2.2, ADR-0205 D1/D2/A3) — overlay a11y wiring. THREE DOORS, ONE NULLITY SOURCE.
// This shell is opened and closed through `show()`, `hide()` AND `render(vm)` (whose `vm.visible`
// drives `display` directly), so all three must agree. They do, because they all read the SAME
// existing derived `visible` getter below — never a shadow field. A `#lastRenderVisible` field
// would never see `hide()`, so after a manual dismiss the next `render(vm)` is not a field
// transition and the re-opened overlay would ship no role, no label, no focus and no trap, while
// passing every single-cycle test (the failure `ui/questLogView.ts` documents for S3).
//
// THE REAL OPEN EDGE FIRES IN `render()`, NOT `show()`. `main.ts`'s `openClaim()` runs
// `renderClaim()` -> `claimView.show()` -> `renderClaim()`, and the claim phase has already moved
// by the first of those, so `render()` sees the hidden->visible transition one statement before
// `show()` is even called. Both are therefore guarded on `wasVisible`, read BEFORE the display
// write; an unguarded `render()` would re-open on every claim event (feedback update, decline
// prompt), tearing down and re-scheduling the deferred focus and yanking the player back to
// `#claim-signin-btn` mid-interaction.
//
// THE GUARDS ARE ASYMMETRIC ON PURPOSE. `render()`'s close arm IS guarded; `hide()`'s is NOT.
// `closeOverlayA11y` with no record is a documented pure no-op, so the unguarded `hide()` is the
// self-healing path for a record that desynchronised from the DOM, while a guarded one would leak
// a live capture listener, a pending timer and an expiring return target permanently.
//
// The open is the LAST statement of each door, after the display and `textContent` writes: in a
// real browser `.focus()` on a `display:none` node is a silent no-op, and the deferred
// `querySelector('#claim-signin-btn')` must resolve against a painted root.
//
// KNOWN RESIDUAL, PINNED NOT FIXED (S4-claimView-REOPEN-AFTER-HIDE). `ClaimPhase` never returns to
// `'hidden'` and `main.ts`'s `KeyC` close calls `hide()` directly rather than through `applyClaim`,
// so the model still believes the overlay is open. A later reconnect-driven render then arrives
// with `vm.visible === true` while the DOM reads hidden, and re-opens. That already re-showed the
// overlay before this slice; it now also announces and moves focus. The a11y layer is correct for
// the DOM state it observes — the defect is upstream, in a model that cannot represent "dismissed".
// Fixing it needs `claimModel.ts` (a new `ClaimEvent`) or `client/src/main.ts` (route the `KeyC`
// close through `applyClaim`), both outside this slice's scope and `main.ts` reserved for S5.
import type { ClaimViewModel } from './claimModel';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

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
    // Read the ONE nullity source FIRST, before the display write below flips it (header).
    const wasVisible = this.visible;
    this.#overlay.style.display = vm.visible ? 'block' : 'none';
    this.#title.textContent = vm.title;
    this.#body.textContent = vm.body;
    this.#nudge.textContent = vm.nudge ?? '';
    this.#nudge.style.display = vm.nudge === undefined ? 'none' : 'block';
    this.#feedback.textContent = vm.feedback ?? '';
    this.#feedback.style.display = vm.feedback === undefined ? 'none' : 'block';
    this.#confirm.textContent = vm.confirmPrompt ?? '';
    this.#confirm.style.display = vm.confirmPrompt === undefined ? 'none' : 'block';
    // LAST, after every write above, so the deferred focus resolves against a painted root.
    if (vm.visible && !wasVisible) openOverlayA11y('claimView', this.#overlay);
    else if (!vm.visible && wasVisible) closeOverlayA11y('claimView', null);
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none' && this.#overlay.style.display !== '';
  }

  show(): void {
    const wasVisible = this.visible;
    this.#overlay.style.display = 'block';
    if (!wasVisible) openOverlayA11y('claimView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    closeOverlayA11y('claimView', null);
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }
}
