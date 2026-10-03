// ui/sessionView.ts — DOM shell for the session-lifecycle overlay: the session gate, an in-frame
// system modal (ctl-8k, CTL8K.1).
// DOM shell — coverage-excluded (all copy and every state decision live in sessionModel.ts; this
// file only places, shows and focuses). REGISTRY-EXTERNAL by design: it is NOT an OverlayId member
// (a second EXCLUSIVE_TOP would break overlayRegistry's decide(), D17), so it gets no overlayA11y
// focus trap. main.ts drives it directly from `conn.sessionState()`, checked first on every input
// path via `sessionGateBlocks()`, which leaves a focused native <button> its Enter and Space.
//
// ★ ensureElement CREATES EVERY NODE display:none (the trap that hid this gate's title, body and
// buttons until ctl-8k, B1), so render() writes `display` on every node it owns.
//
// ★ PLACEMENT: a `.mr-shell--top` frame in #frame-layer, appended at boot after the static menu and
// help shells, so it wins their z-index tie by document order and sits above the battle root.
//
// ★ FOCUS: the open edge seats Retry (No when it opens armed); on an open gate only the arm and
// disarm edges move it (No, then Continue — reseatRow, ui/screens/profileScreen.ts); closing
// blurs a focused control so focus is never left in a hidden subtree.
import { reseatRow } from './screens/profileScreen';
import type { SessionViewModel } from './sessionModel';

export interface SessionViewHandlers {
  readonly onContinueRequested: () => void;
  readonly onContinueConfirmed: () => void;
  readonly onConfirmCancelled: () => void;
  readonly onRetry: () => void;
}

function ensureElement(id: string, tag = 'div', parent: HTMLElement = document.body): HTMLElement {
  const found = document.getElementById(id);
  if (found) return found;
  const el = document.createElement(tag);
  el.id = id;
  el.style.display = 'none';
  parent.appendChild(el);
  return el;
}

/** Where a constructed frame lives (B3): the frame layer inside #game-screen, else the game
 *  screen, else <body> for a shell-less boot. */
function frameAnchor(): HTMLElement {
  return (
    document.getElementById('frame-layer') ??
    document.getElementById('game-screen') ??
    document.body
  );
}

export class SessionView {
  readonly #overlay: HTMLElement;
  readonly #title: HTMLElement;
  readonly #body: HTMLElement;
  readonly #feedback: HTMLElement;
  readonly #confirm: HTMLElement;
  readonly #retryBtn: HTMLButtonElement;
  readonly #continueBtn: HTMLButtonElement;
  readonly #yesBtn: HTMLButtonElement;
  readonly #noBtn: HTMLButtonElement;
  readonly #hint: HTMLElement;

  constructor(handlers: SessionViewHandlers) {
    this.#overlay = ensureElement('session-overlay', 'div', frameAnchor());
    this.#overlay.classList.add('mr-frame', 'mr-shell', 'mr-shell--top');
    this.#title = ensureElement('session-title', 'h2');
    this.#body = ensureElement('session-body', 'p');
    this.#feedback = ensureElement('session-feedback', 'p');
    this.#confirm = ensureElement('session-confirm', 'p');
    this.#retryBtn = this.#ensureButton('session-retry-btn', handlers.onRetry);
    this.#continueBtn = this.#ensureButton('session-continue-btn', handlers.onContinueRequested);
    this.#yesBtn = this.#ensureButton('session-continue-confirm-btn', handlers.onContinueConfirmed);
    this.#noBtn = this.#ensureButton('session-continue-cancel-btn', handlers.onConfirmCancelled);
    this.#hint = ensureElement('session-hint', 'p');
    // Reading and tab order; appendChild moves a node already in place to the end, in turn.
    for (const child of [
      this.#title,
      this.#body,
      this.#feedback,
      this.#confirm,
      this.#retryBtn,
      this.#continueBtn,
      this.#yesBtn,
      this.#noBtn,
      this.#hint,
    ]) {
      this.#overlay.appendChild(child);
    }
    // The gate returns before main.ts's repeat check, so a held Enter on a focused button would
    // click it on every OS repeat (a Retry flood, an arm/disarm flap). Only the first press acts.
    this.#overlay.addEventListener('keydown', (e) => {
      if (e.repeat) e.preventDefault();
    });
  }

  #ensureButton(id: string, handler: () => void): HTMLButtonElement {
    const btn = ensureElement(id, 'button') as HTMLButtonElement;
    btn.type = 'button';
    btn.addEventListener('click', () => handler());
    return btn;
  }

  /** The second step is armed: No is shown. */
  get #armed(): boolean {
    return this.#noBtn.style.display !== 'none';
  }

  render(vm: SessionViewModel): void {
    if (!vm.visible) {
      this.hide();
      return;
    }
    const wasVisible = this.visible;
    const wasArmed = this.#armed;
    const armed = vm.confirmPrompt !== undefined;
    this.#paint(this.#title, vm.title, true);
    this.#paint(this.#body, vm.body, true);
    this.#paint(this.#feedback, vm.feedback ?? '', vm.feedback !== undefined);
    this.#paint(this.#confirm, vm.confirmPrompt ?? '', armed);
    // AUTH-56: the second step replaces the first, so Yes/No and Retry/Continue never share a frame.
    this.#paint(this.#retryBtn, vm.retryLabel, !armed);
    this.#paint(this.#continueBtn, vm.primaryActionLabel, !armed);
    this.#paint(this.#yesBtn, vm.confirmYesLabel, armed);
    this.#paint(this.#noBtn, vm.confirmNoLabel, armed);
    this.#paint(this.#hint, vm.hint, true);
    this.#overlay.style.display = 'block';
    // After every display write: a browser will not focus a display:none node.
    if (!wasVisible) (armed ? this.#noBtn : this.#retryBtn).focus();
    else this.#reseat(wasArmed, armed);
  }

  /** `textContent` only, and `display` on every write (the ensureElement trap). */
  #paint(el: HTMLElement, text: string, shown: boolean): void {
    el.textContent = text;
    el.style.display = shown ? '' : 'none';
  }

  /** On an open gate: arming seats No, disarming seats Continue, a focused control the render hid
   *  seats the default; a plain re-render, or focus outside the frame, moves nothing. */
  #reseat(wasArmed: boolean, armed: boolean): void {
    const active = document.activeElement;
    const onPage = !(active instanceof HTMLElement) || active === document.body;
    if (!onPage && !this.#overlay.contains(active)) return;
    const rows: HTMLElement[] = [
      this.#retryBtn,
      this.#continueBtn,
      this.#yesBtn,
      this.#noBtn,
    ].filter((b) => b.style.display !== 'none');
    const target = reseatRow(
      rows,
      onPage ? null : active,
      { was: wasArmed, now: armed },
      this.#noBtn,
      this.#continueBtn,
    );
    target?.focus();
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none' && this.#overlay.style.display !== '';
  }

  hide(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.#overlay.contains(active)) active.blur();
    this.#overlay.style.display = 'none';
  }
}
