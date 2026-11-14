// ui/privacyView.ts — DOM shell for the privacy surface: the Privacy section of the Profile screen
// (uif-16b; ui/profileView.ts owns the dialog, its a11y, the Close row and the row walk).
//
// DOM shell, but FULLY UNIT-COVERED via happy-dom (the helpView / leaderboardView / renameView
// precedent), so this file is deliberately NOT in `vite.config.ts` coverage.exclude.
// Every decision it could have made lives in `ui/privacyBanner.ts`'s `buildPrivacyViewModel`; this
// file only paints.
//
// THE SECTION IS CONSTRUCTED, NOT STATIC MARKUP (A2-D2), then moved into the Profile frame.
//
// ★ ensureElement CREATES EVERY NODE display:none, AND THAT IS A TRAP (it hid claimView's title
// and body until ctl-8h, B2). This shell therefore writes `textContent` AND clears `display` on
// every control it owns, and `privacyView.test.ts` asserts reachability by walking the ancestor
// chain rather than by clicking.
//
// ★ FOCUS: the OPEN edge is the frame's. This shell moves focus only on a render of the shown
// section (ctl-8h, CTL8H.4): the arm/disarm edge (Keep — a confirm defaults to No — then Delete),
// or a FOCUSED control the render hid or disabled (`reseatRow`, ui/screens/profileScreen.ts). That
// last case seats `fallbackRow` (the frame's Close, always enabled) when one is wired: every
// control here can be refused at once (a request in flight, the terminal phase), and the section's
// first enabled row is an action a second Enter would press.
//
// ★ hide() CALLS onDismissed (A2-D4). A battle or a reconnect force-hides the Profile frame, which
// hides every section; routing the disarm through `hide()` itself is what stops a force-hide from
// leaving an armed delete confirmation live in the model behind a hidden screen.
//
// NO aria-live / role="status" / role="alert" on the notice: exactly one live region exists and
// `ui/liveRegion.ts` owns it (this applies to the notice too).
//
// The four strings this view owns are resolved through the i18n resolver
// (`t()`, ui/i18n/resolver.ts), never in the constructor (S6 may negotiate the locale after this
// view is constructed): the section header (`privacy.title`) and the pseudonymization disclosure
// (`privacy.disclosure`, whose English is `privacyBanner.ts`'s pinned
// `PRIVACY_PSEUDONYMIZATION_DISCLOSURE`) in show(), and the two second-step labels
// (`privacy.confirm.delete` / `privacy.confirm.keep`) in render(). Every vm label is
// `privacyBanner.ts` copy, rendered raw.

import { t } from './i18n/resolver';
import type { PrivacyViewModel } from './privacyBanner';
import { type RowSection, reseatRow } from './screens/profileScreen';

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
  /** A row outside this section that is always enabled (the frame's Close): where focus goes
   *  when a render refuses the focused control (header). Absent, focus is left where it is. */
  readonly fallbackRow?: () => HTMLElement | undefined;
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

/** Where the section is built before the Profile frame takes it (B3, CTL8H.1): the frame layer
 *  inside #game-screen, else the game screen, else <body> for a shell-less boot. */
function frameAnchor(): HTMLElement {
  return (
    document.getElementById('frame-layer') ??
    document.getElementById('game-screen') ??
    document.body
  );
}

export class PrivacyView implements RowSection {
  readonly #overlay: HTMLElement;
  readonly #title: HTMLElement;
  readonly #status: HTMLElement;
  readonly #notice: HTMLElement;
  readonly #disclosure: HTMLElement;
  readonly #confirm: HTMLElement;
  // Typed HTMLButtonElement, not HTMLElement: a native <button> is keyboard-operable.
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
  readonly #fallbackRow: (() => HTMLElement | undefined) | undefined;

  constructor(handlers: PrivacyViewHandlers) {
    this.#overlay = ensureElement('privacy-overlay', 'div', frameAnchor());
    // The buttons stack as a column, the axis the Up/Down rows walk (styles.css).
    this.#overlay.classList.add('mr-button-rows');
    this.#title = ensureElement('privacy-title', 'h2');
    this.#title.classList.add('mr-section-header');
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
    this.#downloadBtn = this.#ensureButton('privacy-download-btn', handlers.onExportDownload);
    this.#exportStatus = ensureElement('privacy-export-status', 'p');
    this.#onDismissed = handlers.onDismissed;
    this.#fallbackRow = handlers.fallbackRow;

    for (const child of [
      this.#title,
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

    // The title and the disclosure are un-hidden here but their TEXT is resolved in show()
    // (header). No render writes the disclosure: it is present in EVERY state of the shown
    // section — it is the §9 language, and a render path that blanked it on the terminal branch
    // would drop it exactly when it matters most.
    this.#title.style.display = '';
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
    const wasArmed = this.armed;
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
    // Only while the section shows: the open edge's focus is the frame's.
    if (this.visible) this.#reseat(wasArmed);
  }

  /** The deletion confirm is armed: Keep is shown. */
  get armed(): boolean {
    return this.#confirmCancelBtn.style.display !== 'none';
  }

  /** The section root. */
  get sectionRoot(): HTMLElement {
    return this.#overlay;
  }

  /** The rows (CTL8H.4): the shown, enabled buttons in DOM order. */
  sectionRows(): readonly HTMLElement[] {
    return [...this.#overlay.querySelectorAll('button')].filter(
      (b) => b.style.display !== 'none' && !b.disabled,
    );
  }

  /** Keep while the deletion confirm is armed, else the first row (none when every control is
   *  refused). */
  defaultRow(): HTMLElement | undefined {
    return this.armed ? this.#confirmCancelBtn : this.sectionRows()[0];
  }

  /** A render moves focus only on the arm and disarm edges (Keep, then Delete: `reseatRow`), or
   *  off a control it hid or disabled, to the fallback row (header); never focus that is outside
   *  this section. */
  #reseat(wasArmed: boolean): void {
    const active = document.activeElement;
    const onPage = !(active instanceof HTMLElement) || active === document.body;
    if (!onPage && !this.#overlay.contains(active)) return;
    const focused = onPage ? null : active;
    const rows = this.sectionRows();
    const armed = { was: wasArmed, now: this.armed };
    // Unarmed on both sides and the focused control is no longer a row: `reseatRow` would answer
    // the section's first row, an action here. The fallback row instead, or nothing.
    const refused = !armed.was && !armed.now && focused !== null && !rows.includes(focused);
    const target = refused
      ? this.#fallbackRow?.()
      : reseatRow(rows, focused, armed, this.#confirmCancelBtn, this.#deleteBtn);
    target?.focus();
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none' && this.#overlay.style.display !== '';
  }

  show(): void {
    // The header and the disclosure are resolved HERE, on EVERY show(), before the display write.
    this.#title.textContent = t('privacy.title');
    this.#disclosure.textContent = t('privacy.disclosure');
    this.#overlay.style.display = 'block';
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // A2-D4: every close disarms, including a force-hide of the frame.
    this.#onDismissed();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }
}
