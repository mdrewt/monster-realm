// ui/privacyView.ts — DOM shell for the privacy surface (rb-52, PRV1-3/PRV1-4;
// ADR-0231 Amendment A2).
//
// DOM shell, but FULLY UNIT-COVERED via happy-dom (the helpView / leaderboardView / renameView
// precedent), so this file is deliberately NOT in `vite.config.ts` coverage.exclude and NOT in
// `evals/dom-shell-coverage-exclusion.eval.mjs`'s DOM_SHELLS. Every decision it could have made
// lives in `ui/privacyBanner.ts`'s `buildPrivacyViewModel`; this file only paints.
//
// THE SHELL IS CONSTRUCTED, NOT STATIC MARKUP (A2-D2). A static shell in `client/index.html` must
// carry `role="dialog" aria-modal="true"`, and `evals/overlay-live-region-custody.eval.mjs` pins
// the count of those in `index.html` at EXACTLY eleven — an eval outside this slice's `touches:`.
// `claimView.ts` / `sessionView.ts` established the constructed route and it costs nothing here.
//
// ★ ensureElement CREATES EVERY NODE display:none, AND THAT IS A TRAP. `claimView.ts` never
// un-hides its buttons, so today's claim overlay ships five blank, invisible buttons that a
// programmatic `.click()` still fires — green in happy-dom and in Chromium, invisible to a human.
// This shell therefore writes `textContent` AND clears `display` on every control it owns, and
// `privacyView.test.ts` asserts reachability by walking the ancestor chain rather than by clicking.
//
// ★ NO `.focus()` ANYWHERE IN THIS FILE, in any spelling.
// `evals/overlay-a11y-manifest.eval.mjs` bans `.focus(`, `?.focus`, `['focus']` and `autofocus`
// in every `client/src/ui/**/*View.ts` (A11Y-15): focus placement belongs to `overlayA11y.ts`,
// which is the single owner. The initial anchor is `#privacy-delete-btn`, a NATIVE <button> —
// `evals/keyboard-operable-rows.eval.mjs` hard-fails a `tabindex` write from any file outside its
// frozen table, so a tabindex-ed heading anchor is not available to us (A2-D3). That same eval
// only accepts a `this.#field` click receiver as native when the FIELD'S DECLARED TYPE is
// `HTMLButtonElement`, which is why the five button fields below are typed that way rather than
// as `HTMLElement` (the `renameView.ts` `#submitBtn` precedent).
//
// ★ hide() CALLS onDismissed (A2-D4). `privacyView` is in BATTLE_FORCE_HIDE, and a force-hide runs
// `main.ts`'s handle thunk — a byte-identical `privacyView?.hide()` pinned by
// W-UXD3C-HANDLE-TABLE, so it cannot be widened at the call site. Routing the disarm through
// `hide()` itself is what stops a battle auto-show from leaving an armed delete confirmation live
// in the model behind a hidden overlay.
//
// NO aria-live / role="status" / role="alert" on the notice: exactly one live region exists and
// `ui/liveRegion.ts` owns it (the rb-51 A1-D4 call, which applies to this notice too).

import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { PRIVACY_PSEUDONYMIZATION_DISCLOSURE, type PrivacyViewModel } from './privacyBanner';

export interface PrivacyViewHandlers {
  /** Step one of the two-step confirmation: arm it. Writes nothing, sends nothing. */
  readonly onDeleteRequested: () => void;
  readonly onDeleteConfirmed: () => void;
  readonly onConfirmCancelled: () => void;
  readonly onCancelDeletion: () => void;
  readonly onExportRequested: () => void;
  /** Called from `hide()` — every close path, including the battle force-hide. */
  readonly onDismissed: () => void;
}

/** Find an existing overlay element or create a detached one appended to <body>, so the shell
 *  works whether or not index.html declares it (it never does — see the header). */
function ensureElement(id: string, tag = 'div'): HTMLElement {
  const found = document.getElementById(id);
  if (found) return found;
  const el = document.createElement(tag);
  el.id = id;
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

export class PrivacyView {
  readonly #overlay: HTMLElement;
  readonly #title: HTMLElement;
  readonly #status: HTMLElement;
  readonly #notice: HTMLElement;
  readonly #disclosure: HTMLElement;
  readonly #confirm: HTMLElement;
  // Typed HTMLButtonElement, not HTMLElement — see the header's keyboard-operable-rows note.
  readonly #deleteBtn: HTMLButtonElement;
  readonly #confirmBtn: HTMLButtonElement;
  readonly #confirmCancelBtn: HTMLButtonElement;
  readonly #cancelBtn: HTMLButtonElement;
  readonly #exportBtn: HTMLButtonElement;
  readonly #onDismissed: () => void;

  constructor(handlers: PrivacyViewHandlers) {
    this.#overlay = ensureElement('privacy-overlay');
    // position:fixed WITH inset:0. W-ONE-CORNER-AFFORDANCE pins the set of fixed-but-not-inset-0
    // elements to exactly {build-stamp, help-hint}, so a centred fixed panel is not available.
    this.#overlay.style.position = 'fixed';
    this.#overlay.style.inset = '0';
    this.#overlay.style.zIndex = '100';
    this.#overlay.style.overflow = 'auto';
    this.#overlay.style.background = 'rgba(0, 0, 0, 0.88)';
    this.#overlay.style.padding = '24px';
    this.#overlay.style.font = '14px/1.6 monospace';
    this.#overlay.style.color = '#e0e0e0';
    this.#title = ensureElement('privacy-title', 'h2');
    this.#status = ensureElement('privacy-status', 'p');
    this.#notice = ensureElement('privacy-notice', 'p');
    this.#disclosure = ensureElement('privacy-disclosure', 'p');
    this.#confirm = ensureElement('privacy-confirm', 'p');
    this.#deleteBtn = this.#ensureButton('privacy-delete-btn', handlers.onDeleteRequested);
    this.#confirmBtn = this.#ensureButton('privacy-confirm-btn', handlers.onDeleteConfirmed);
    this.#confirmCancelBtn = this.#ensureButton(
      'privacy-confirm-cancel-btn',
      handlers.onConfirmCancelled,
    );
    this.#cancelBtn = this.#ensureButton('privacy-cancel-btn', handlers.onCancelDeletion);
    this.#exportBtn = this.#ensureButton('privacy-export-btn', handlers.onExportRequested);
    this.#onDismissed = handlers.onDismissed;

    for (const child of [
      this.#title,
      this.#status,
      this.#deleteBtn,
      this.#confirm,
      this.#confirmBtn,
      this.#confirmCancelBtn,
      this.#cancelBtn,
      this.#exportBtn,
      this.#notice,
      this.#disclosure,
    ]) {
      if (child.parentElement !== this.#overlay) this.#overlay.appendChild(child);
    }

    // The title and the disclosure never vary, so they are written ONCE here rather than on every
    // render. The disclosure in particular must be present in EVERY state — it is the §9 language,
    // and a render path that blanked it on the terminal branch would drop it exactly when it
    // matters most.
    this.#title.textContent = 'Privacy & Account Data';
    this.#title.style.display = '';
    this.#disclosure.textContent = PRIVACY_PSEUDONYMIZATION_DISCLOSURE;
    this.#disclosure.style.display = '';
  }

  #ensureButton(id: string, handler: () => void): HTMLButtonElement {
    const btn = ensureElement(id, 'button') as HTMLButtonElement;
    btn.addEventListener('click', () => handler());
    return btn;
  }

  /** Paint one control: its label, its enabled state, and its visibility. `textContent` only —
   *  never innerHTML, even though none of this copy is player-authored. */
  #paintButton(btn: HTMLButtonElement, label: string, enabled: boolean): void {
    btn.textContent = label;
    btn.disabled = !enabled;
    btn.style.display = '';
  }

  /** Render from the pure VM. Every branch below is a write — nothing is decided here. */
  render(vm: PrivacyViewModel): void {
    this.#status.textContent = vm.statusLabel;
    this.#status.style.display = '';
    this.#paintButton(this.#deleteBtn, vm.deleteLabel, vm.deleteEnabled);
    this.#paintButton(this.#cancelBtn, vm.cancelLabel, vm.cancelEnabled);
    this.#paintButton(this.#exportBtn, vm.exportLabel, vm.exportEnabled);

    const armed = vm.confirmPrompt !== undefined;
    this.#confirm.textContent = vm.confirmPrompt ?? '';
    this.#confirm.style.display = armed ? '' : 'none';
    // Step two only exists while step one is armed. Painting them unconditionally would put a bare
    // "Confirm" beside "Delete my account" at all times, which is the opposite of a two-step gate.
    this.#paintButton(this.#confirmBtn, 'Confirm deletion', armed);
    this.#paintButton(this.#confirmCancelBtn, 'Keep my account', armed);
    this.#confirmBtn.style.display = armed ? '' : 'none';
    this.#confirmCancelBtn.style.display = armed ? '' : 'none';

    this.#notice.textContent = vm.noticeLabel ?? '';
    this.#notice.style.display = vm.noticeLabel === undefined ? 'none' : '';
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none' && this.#overlay.style.display !== '';
  }

  show(): void {
    // Read the ONE nullity source BEFORE the display write: `show()` is called repeatedly on an
    // already-open overlay, and a re-open would re-schedule overlayA11y's deferred focus and yank
    // the player back to the anchor mid-interaction.
    const wasVisible = this.visible;
    this.#overlay.style.display = 'block';
    if (!wasVisible) openOverlayA11y('privacyView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // DELIBERATELY UNGUARDED, the pvpView/claimView rule: `closeOverlayA11y` with no open record is
    // a documented no-op, so an unguarded call self-heals a record that desynchronised from the
    // DOM, while a guarded one would leak a live capture listener and a pending timer forever.
    closeOverlayA11y('privacyView', null);
    // A2-D4: every close disarms, including the battle force-hide, which reaches this method
    // through main.ts's pinned byte-identical handle thunk and cannot carry the call itself.
    this.#onDismissed();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }
}
