// ui/privacyView.ts — DOM shell for the privacy surface.
//
// DOM shell, but FULLY UNIT-COVERED via happy-dom (the helpView / leaderboardView / renameView
// precedent), so this file is deliberately NOT in `vite.config.ts` coverage.exclude.
// Every decision it could have made lives in `ui/privacyBanner.ts`'s `buildPrivacyViewModel`; this
// file only paints.
//
// THE SHELL IS CONSTRUCTED, NOT STATIC MARKUP (A2-D2). A static shell in `client/index.html` must
// carry `role="dialog" aria-modal="true"`.
// `claimView.ts` / `sessionView.ts` established the constructed route and it costs nothing here.
//
// ★ ensureElement CREATES EVERY NODE display:none, AND THAT IS A TRAP (it hid claimView's title
// and body until ctl-8h, B2). This shell therefore writes `textContent` AND clears `display` on
// every control it owns, and `privacyView.test.ts` asserts reachability by walking the ancestor
// chain rather than by clicking.
//
// ★ FOCUS: the OPEN edge is `overlayA11y.ts`'s alone. The initial anchor is `#privacy-close-btn`
// (overlayRegistry.ts's `initialFocusSelector`), a NATIVE <button>. On an already-open frame this
// shell moves focus in exactly two places (ctl-8h, CTL8H.4): the Privacy screen's row tokens
// (`applyRowOp`, the cursor IS focus) and a render's arm/disarm edge (Keep — a confirm defaults to
// No — then Delete) or a focused control it hid or disabled (`reseatRow`, ui/screens/profileScreen.ts).
//
// ★ hide() CALLS onDismissed (A2-D4). `privacyView` is in BATTLE_FORCE_HIDE, and a force-hide runs
// `main.ts`'s handle thunk — a byte-identical `privacyView?.hide()` that
// cannot be widened at the call site. Routing the disarm through
// `hide()` itself is what stops a battle auto-show from leaving an armed delete confirmation live
// in the model behind a hidden overlay.
//
// NO aria-live / role="status" / role="alert" on the notice: exactly one live region exists and
// `ui/liveRegion.ts` owns it (this applies to the notice too).
//
// The four strings this view owns are resolved through the i18n resolver
// (`t()`, ui/i18n/resolver.ts), never in the constructor (S6 may negotiate the locale after this
// view is constructed): the heading (`privacy.title`) and the close anchor's label
// (`privacy.close`) in show() — the only door that opens this overlay; `render()` never does —
// and the two second-step labels (`privacy.confirm.delete` / `privacy.confirm.keep`) in render().
// The close anchor's `display = ''` / `disabled = false` and the title's `display = ''` STAY in
// the constructor: the never-disabled anchor invariant (A2-D10) must hold before the first
// show(). `privacy.title` shares its English bytes with `claim.privacyButton` today but is a
// DIFFERENT key (a heading, not a button). Every vm label and
// `PRIVACY_PSEUDONYMIZATION_DISCLOSURE` are `privacyBanner.ts` copy, rendered raw.

import { t } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { PRIVACY_PSEUDONYMIZATION_DISCLOSURE, type PrivacyViewModel } from './privacyBanner';
import { type RowOp, reseatRow, rowStep } from './screens/profileScreen';

export interface PrivacyViewHandlers {
  /** Step one of the two-step confirmation: arm it. Writes nothing, sends nothing. */
  readonly onDeleteRequested: () => void;
  readonly onDeleteConfirmed: () => void;
  readonly onConfirmCancelled: () => void;
  readonly onCancelDeletion: () => void;
  readonly onExportRequested: () => void;
  /** Save the artifact that has already ARRIVED. Distinct from `onExportRequested`,
   *  which asks the server to build a new one. */
  readonly onExportDownload: () => void;
  /** Called from `hide()` — every close path, including the battle force-hide. */
  readonly onDismissed: () => void;
}

/** Find an existing element or create a hidden one appended to `parent` (<body> by default), so
 *  the shell works whether or not index.html declares it (it never does — see the header). */
function ensureElement(id: string, tag = 'div', parent: HTMLElement = document.body): HTMLElement {
  const found = document.getElementById(id);
  if (found) return found;
  const el = document.createElement(tag);
  el.id = id;
  el.style.display = 'none';
  parent.appendChild(el);
  return el;
}

/** Where a constructed frame lives (B3, CTL8H.1): the frame layer inside #game-screen, else the
 *  game screen, else <body> for a shell-less boot. */
function frameAnchor(): HTMLElement {
  return (
    document.getElementById('frame-layer') ??
    document.getElementById('game-screen') ??
    document.body
  );
}

export class PrivacyView {
  readonly #overlay: HTMLElement;
  readonly #title: HTMLElement;
  readonly #status: HTMLElement;
  readonly #notice: HTMLElement;
  readonly #disclosure: HTMLElement;
  readonly #confirm: HTMLElement;
  // Typed HTMLButtonElement, not HTMLElement: a native <button> is keyboard-operable.
  // FIRST in DOM order and enabled in every phase — it is the a11y anchor (A2-D10).
  readonly #closeBtn: HTMLButtonElement;
  readonly #deleteBtn: HTMLButtonElement;
  readonly #confirmBtn: HTMLButtonElement;
  readonly #confirmCancelBtn: HTMLButtonElement;
  readonly #cancelBtn: HTMLButtonElement;
  readonly #exportBtn: HTMLButtonElement;
  // ALWAYS painted, only ever `disabled`. Unlike every other control here its
  // enablement is driven by INCOMING SERVER DATA, so it can flip while the player has it
  // focused — and a control that becomes `display:none` under focus drops focus to <body>,
  // which is outside the overlay root, so focusTrap's capture listener never fires and Tab
  // walks the page behind the dialog (the hazard overlayRegistry.ts:275-279 records).
  readonly #downloadBtn: HTMLButtonElement;
  readonly #exportStatus: HTMLElement;
  readonly #onDismissed: () => void;
  // The last row token applied: a token is applied once (ui/screens/profileScreen.ts).
  #lastOp: RowOp | null = null;

  constructor(handlers: PrivacyViewHandlers) {
    // B3: a class-styled frame in the game screen (.mr-frame, .mr-shell), like the static shells.
    this.#overlay = ensureElement('privacy-overlay', 'div', frameAnchor());
    this.#overlay.classList.add('mr-frame', 'mr-shell');
    this.#title = ensureElement('privacy-title', 'h2');
    this.#status = ensureElement('privacy-status', 'p');
    this.#notice = ensureElement('privacy-notice', 'p');
    this.#disclosure = ensureElement('privacy-disclosure', 'p');
    this.#confirm = ensureElement('privacy-confirm', 'p');
    this.#closeBtn = this.#ensureButton('privacy-close-btn', () => this.hide());
    this.#deleteBtn = this.#ensureButton('privacy-delete-btn', handlers.onDeleteRequested);
    this.#confirmBtn = this.#ensureButton('privacy-confirm-btn', handlers.onDeleteConfirmed);
    this.#confirmCancelBtn = this.#ensureButton(
      'privacy-confirm-cancel-btn',
      handlers.onConfirmCancelled,
    );
    this.#cancelBtn = this.#ensureButton('privacy-cancel-btn', handlers.onCancelDeletion);
    this.#exportBtn = this.#ensureButton('privacy-export-btn', handlers.onExportRequested);
    this.#downloadBtn = this.#ensureButton('privacy-download-btn', handlers.onExportDownload);
    this.#exportStatus = ensureElement('privacy-export-status', 'p');
    this.#onDismissed = handlers.onDismissed;

    for (const child of [
      this.#title,
      this.#closeBtn,
      this.#status,
      this.#deleteBtn,
      this.#confirm,
      this.#confirmBtn,
      this.#confirmCancelBtn,
      this.#cancelBtn,
      this.#exportBtn,
      this.#exportStatus,
      this.#downloadBtn,
      this.#notice,
      this.#disclosure,
    ]) {
      if (child.parentElement !== this.#overlay) this.#overlay.appendChild(child);
    }

    // The disclosure never varies and is not catalogued (privacyBanner.ts copy, M24 §2.5), so it
    // is written ONCE here rather than on every render. It must be present in EVERY state — it
    // is the §9 language, and a render path that blanked it on the terminal branch would drop it
    // exactly when it matters most. The title is un-hidden here but its TEXT is resolved in
    // show() (header).
    this.#title.style.display = '';
    this.#disclosure.textContent = PRIVACY_PSEUDONYMIZATION_DISCLOSURE;
    this.#disclosure.style.display = '';
    // The close anchor is un-hidden and ALWAYS enabled from construction: it is
    // `initialFocusSelector`, and an overlay whose anchor can be `disabled` has no reachable focus
    // in the phases where every other control is refused. Its label, too, is resolved in show().
    this.#closeBtn.style.display = '';
    this.#closeBtn.disabled = false;
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
    const wasArmed = this.#armed;
    this.#status.textContent = vm.statusLabel;
    this.#status.style.display = '';
    this.#paintButton(this.#deleteBtn, vm.deleteLabel, vm.deleteEnabled);
    this.#paintButton(this.#cancelBtn, vm.cancelLabel, vm.cancelEnabled);
    this.#paintButton(this.#exportBtn, vm.exportLabel, vm.exportEnabled);
    // A3-D4: painted on EVERY render, in every state — `#paintButton` clears `display`, so the
    // control keeps its place in the focus ring whether or not an artifact is available.
    this.#paintButton(this.#downloadBtn, vm.downloadLabel, vm.downloadEnabled);
    // The status line is not focusable, so it may hide — the `#notice` rule.
    this.#exportStatus.textContent = vm.exportStatusLabel ?? '';
    this.#exportStatus.style.display = vm.exportStatusLabel === undefined ? 'none' : '';

    const armed = vm.confirmPrompt !== undefined;
    this.#confirm.textContent = vm.confirmPrompt ?? '';
    this.#confirm.style.display = armed ? '' : 'none';
    // Step two only exists while step one is armed. Painting them unconditionally would put a bare
    // "Confirm" beside "Delete my account" at all times, which is the opposite of a two-step gate.
    this.#paintButton(this.#confirmBtn, t('privacy.confirm.delete'), armed);
    this.#paintButton(this.#confirmCancelBtn, t('privacy.confirm.keep'), armed);
    this.#confirmBtn.style.display = armed ? '' : 'none';
    this.#confirmCancelBtn.style.display = armed ? '' : 'none';

    this.#notice.textContent = vm.noticeLabel ?? '';
    this.#notice.style.display = vm.noticeLabel === undefined ? 'none' : '';
    // Only on a frame already open: the open edge's focus is overlayA11y's.
    if (this.visible) this.#reseat(wasArmed);
  }

  /** The deletion confirm is armed: Keep is shown. */
  get #armed(): boolean {
    return this.#confirmCancelBtn.style.display !== 'none';
  }

  /** The rows (CTL8H.4): the shown, enabled buttons in DOM order. */
  #rows(): HTMLButtonElement[] {
    return [...this.#overlay.querySelectorAll('button')].filter(
      (b) => b.style.display !== 'none' && !b.disabled,
    );
  }

  /** A render moves focus only on the arm and disarm edges (Keep, then Delete), or off a control
   *  it hid or disabled; never focus that is outside the frame (`reseatRow`). */
  #reseat(wasArmed: boolean): void {
    const active = document.activeElement;
    const onPage = !(active instanceof HTMLElement) || active === document.body;
    if (!onPage && !this.#overlay.contains(active)) return;
    const target = reseatRow(
      this.#rows(),
      onPage ? null : active,
      { was: wasArmed, now: this.#armed },
      this.#confirmCancelBtn,
      this.#deleteBtn,
    );
    target?.focus();
  }

  /** One press on the rows (the Privacy screen, CTL8H.4). The cursor is DOM focus; with no row
   *  focused it only seats the default row (Keep while armed, else the first), so an A never
   *  confirms a deletion nobody chose. */
  applyRowOp(op: RowOp): void {
    if (op === this.#lastOp) return;
    this.#lastOp = op;
    const rows = this.#rows();
    const fallback = this.#armed ? this.#confirmCancelBtn : rows[0];
    const { focus, press } = rowStep(rows, document.activeElement, fallback, op);
    focus?.focus();
    press?.click();
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none' && this.#overlay.style.display !== '';
  }

  show(): void {
    // Read the ONE nullity source BEFORE the display write: `show()` is called repeatedly on an
    // already-open overlay, and a re-open would re-schedule overlayA11y's deferred focus and yank
    // the player back to the anchor mid-interaction.
    const wasVisible = this.visible;
    // The heading and the close anchor's label are resolved HERE, on EVERY
    // show() — unconditionally, after the `wasVisible` read, before the display write.
    this.#title.textContent = t('privacy.title');
    this.#paintButton(this.#closeBtn, t('privacy.close'), true);
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
