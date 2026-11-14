// ui/claimView.ts — DOM shell for the guest-claim prompt: the Account section of the Profile screen
// (uif-16b; ui/profileView.ts owns the dialog, its a11y and the row walk).
// DOM shell — coverage-excluded (all logic lives in claimModel.ts). Its heading and body show in
// every phase (B2), and its shown buttons are rows of the Profile column (`RowSection`), the cursor
// being DOM focus. On an already-open frame a render moves focus only on the decline confirm's arm
// edge (No: a confirm defaults to No), its disarm edge (Decline) or off a control it hid
// (`reseatRow`, ui/screens/profileScreen.ts), and never focus that is in another section.
//
// SHOWN IFF THE FRAME IS. `show()` and `hide()` own this section's `display`; `render(vm)` never
// writes it. `vm.visible` is main.ts's signal that a claim phase wants the screen opened (the
// auto-open), not this section's visibility: inside an open Profile the section always shows.
//
// EVERY CLOSE DISARMS. `hide()` calls `onDismissed`, on every close path including the battle and
// reconnect force-hides, and main.ts cancels an armed decline there: in one column an armed "Yes"
// would otherwise be the next row under the name field of a re-opened screen.
//
// Button labels and the section header are the strings this view owns, resolved through the i18n
// resolver (the five `claim.*Button` action labels and the header
// `t('menu.profile.account.title')`) in BOTH `render()` and `show()` — unconditionally, on every
// call, never in the constructor (the locale may be negotiated after this view is constructed).
// The rows are the claim actions only: the Privacy section is the next section down the same
// column, so the Down walk reaches it without a door here. WHICH action buttons are shown is
// `vm.actions` (claimModel owns the rule); `render()` writes each one's display.
// The vm strings (`title`, `body`, `nudge`, `feedback`, `confirmPrompt`) are model copy from
// `claimModel.ts`, rendered raw; `vm.title` is the phase heading `#claim-title`, below the header.
// The shown buttons stack as a column (`.mr-button-rows`, QF13.2), the axis the Up/Down rows walk.
import type { ClaimActions, ClaimViewModel } from './claimModel';
import { t } from './i18n/resolver';
import { type RowSection, reseatRow } from './screens/profileScreen';

export interface ClaimViewHandlers {
  readonly onSignIn: () => void;
  readonly onJoin: () => void;
  readonly onDeclineRequested: () => void;
  readonly onDeclineConfirmed: () => void;
  readonly onDeclineCancelled: () => void;
  /** Called from `hide()` — every close path, including the battle force-hide. */
  readonly onDismissed: () => void;
}

/** Find an existing element or create a hidden one appended to `parent` (<body> by default), so
 *  the shell works whether or not index.html declares it (it never does). */
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

/** The section header `#claim-frame-title` as `section`'s first child: created once, found by a
 *  later construction. */
function sectionHeader(section: HTMLElement): HTMLElement {
  const found = document.getElementById('claim-frame-title');
  if (found) return found;
  const header = document.createElement('h2');
  header.id = 'claim-frame-title';
  header.className = 'mr-section-header';
  section.prepend(header);
  return header;
}

export class ClaimView implements RowSection {
  readonly #overlay: HTMLElement;
  readonly #frameTitle: HTMLElement;
  readonly #title: HTMLElement;
  readonly #body: HTMLElement;
  readonly #nudge: HTMLElement;
  readonly #feedback: HTMLElement;
  readonly #confirm: HTMLElement;
  readonly #actionBtns: Readonly<Record<keyof ClaimActions, HTMLButtonElement>>;
  readonly #onDismissed: () => void;

  constructor(handlers: ClaimViewHandlers) {
    this.#overlay = ensureElement('claim-overlay', 'div', frameAnchor());
    this.#overlay.classList.add('mr-button-rows');
    this.#frameTitle = sectionHeader(this.#overlay);
    this.#title = ensureElement('claim-title', 'h2');
    this.#body = ensureElement('claim-body', 'p');
    this.#nudge = ensureElement('claim-nudge', 'p');
    this.#feedback = ensureElement('claim-feedback', 'p');
    this.#confirm = ensureElement('claim-confirm', 'p');
    for (const child of [this.#title, this.#body, this.#nudge, this.#feedback, this.#confirm]) {
      if (child.parentElement !== this.#overlay) this.#overlay.appendChild(child);
    }
    // The five action buttons start hidden (`ensureElement`) and are shown per `vm.actions` by
    // every `render()`; labels are written by every render and show (header).
    this.#actionBtns = {
      signIn: this.#wireButton('claim-signin-btn', handlers.onSignIn),
      join: this.#wireButton('claim-join-btn', handlers.onJoin),
      decline: this.#wireButton('claim-decline-btn', handlers.onDeclineRequested),
      declineConfirm: this.#wireButton('claim-decline-confirm-btn', handlers.onDeclineConfirmed),
      declineCancel: this.#wireButton('claim-decline-cancel-btn', handlers.onDeclineCancelled),
    };
    this.#onDismissed = handlers.onDismissed;
  }

  /** Write the section header and every button label (every render and show — header). */
  #writeLabels(): void {
    this.#frameTitle.textContent = t('menu.profile.account.title');
    const b = this.#actionBtns;
    b.signIn.textContent = t('claim.signInButton');
    b.join.textContent = t('claim.joinButton');
    b.decline.textContent = t('claim.declineButton');
    b.declineConfirm.textContent = t('claim.declineConfirmButton');
    b.declineCancel.textContent = t('claim.declineCancelButton');
  }

  #wireButton(id: string, handler: () => void): HTMLButtonElement {
    const btn = ensureElement(id, 'button') as HTMLButtonElement;
    if (btn.parentElement !== this.#overlay) this.#overlay.appendChild(btn);
    btn.addEventListener('click', () => handler());
    return btn;
  }

  /** Render from the pure VM (textContent only — the claim body is never player-controlled, but
   *  the discipline mirrors the rest of the UI: never innerHTML with data). */
  render(vm: ClaimViewModel): void {
    const wasArmed = this.armed;
    // B2: the title and body are shown in every phase (ensureElement creates them hidden).
    this.#title.textContent = vm.title;
    this.#title.style.display = '';
    this.#body.textContent = vm.body;
    this.#body.style.display = '';
    this.#nudge.textContent = vm.nudge ?? '';
    this.#nudge.style.display = vm.nudge === undefined ? 'none' : 'block';
    this.#feedback.textContent = vm.feedback ?? '';
    this.#feedback.style.display = vm.feedback === undefined ? 'none' : 'block';
    this.#confirm.textContent = vm.confirmPrompt ?? '';
    this.#confirm.style.display = vm.confirmPrompt === undefined ? 'none' : 'block';
    for (const action of Object.keys(this.#actionBtns) as (keyof ClaimActions)[]) {
      this.#actionBtns[action].style.display = vm.actions[action] ? '' : 'none';
    }
    // Every render, unconditionally.
    this.#writeLabels();
    // Only while the section shows: the open edge's focus is the frame's.
    if (this.visible) this.#reseat(wasArmed);
  }

  /** The decline confirm is armed: its No is shown. */
  get armed(): boolean {
    return this.#actionBtns.declineCancel.style.display !== 'none';
  }

  /** The section root. */
  get sectionRoot(): HTMLElement {
    return this.#overlay;
  }

  /** The rows (CTL8H.3): the shown action buttons in DOM order. */
  sectionRows(): readonly HTMLElement[] {
    return [...this.#overlay.querySelectorAll('button')].filter(
      (b) => b.style.display !== 'none' && !b.disabled,
    );
  }

  /** No while the decline is armed, else the first row. */
  defaultRow(): HTMLElement | undefined {
    return this.armed ? this.#actionBtns.declineCancel : this.sectionRows()[0];
  }

  /** A render moves focus only on the arm and disarm edges, or off a control it hid; never focus
   *  that is outside this section (`reseatRow`). */
  #reseat(wasArmed: boolean): void {
    const active = document.activeElement;
    const onPage = !(active instanceof HTMLElement) || active === document.body;
    if (!onPage && !this.#overlay.contains(active)) return;
    const b = this.#actionBtns;
    const target = reseatRow(
      this.sectionRows(),
      onPage ? null : active,
      { was: wasArmed, now: this.armed },
      b.declineCancel,
      b.decline,
    );
    target?.focus();
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none' && this.#overlay.style.display !== '';
  }

  show(): void {
    // Every show(), unconditionally, before the display write.
    this.#writeLabels();
    this.#overlay.style.display = 'block';
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // Every close disarms (header), including a force-hide that reaches this method alone.
    this.#onDismissed();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }
}
