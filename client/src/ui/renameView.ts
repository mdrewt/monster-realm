// ui/renameView.ts — thin DOM shell for the profile-rename overlay (pt-c1b, ADR-0133).
//
// First overlay with a text <input>. Three input-hygiene mechanisms the read-only
// overlays never needed (ADR-0133 D3):
//   1. The input's OWN keydown listener calls e.stopPropagation() so field keystrokes
//      never reach the bubble-phase window keydown (movement + letter hotkeys). It also
//      handles Enter=submit / Escape=cancel locally.
//   2. show() DEFERS focus via setTimeout(…, 0) so the opening key event fully completes
//      before focus lands (belt-and-suspenders with e.preventDefault() in the KeyN branch).
//   3. hide() resets the input value + feedback so a stale draft never survives a re-open.
//
// Fully unit-covered via happy-dom (leaderboardView/errorOverlayView precedent) — this
// file is therefore NOT in vite.config.ts coverage.exclude and NOT in the
// dom-shell-coverage-exclusion eval's DOM_SHELLS.
//
// D2: player-controlled name → textContent ONLY, NEVER innerHTML (XSS firewall).
// A single #submit() path is shared by the button click AND the input's Enter; a
// #pending lock reset via .finally() on BOTH resolve and reject (no dead-button-forever,
// ADR-0085 C6 / shopView precedent).
import { buildRenameViewModel, type RenameViewModel } from './renameModel';

export interface RenameCallbacks {
  readonly onSubmit: (name: string) => Promise<void> | void;
}

export class RenameView {
  readonly #overlay: HTMLElement;
  readonly #current: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #submitBtn: HTMLButtonElement;
  readonly #feedback: HTMLElement;
  readonly #cbs: RenameCallbacks;
  // In-flight lock: prevents double-submit while a reducer Promise is pending.
  #pending = false;

  constructor(cbs: RenameCallbacks) {
    const overlay = document.getElementById('rename-overlay');
    if (!overlay) throw new Error('rename-overlay element not found in DOM');
    this.#overlay = overlay;

    const current = document.getElementById('rename-current');
    if (!current) throw new Error('rename-current missing');
    this.#current = current;

    const input = document.getElementById('rename-input');
    if (!input) throw new Error('rename-input missing');
    this.#input = input as HTMLInputElement;

    const submitBtn = document.getElementById('rename-submit');
    if (!submitBtn) throw new Error('rename-submit missing');
    this.#submitBtn = submitBtn as HTMLButtonElement;

    const feedback = document.getElementById('rename-feedback');
    if (!feedback) throw new Error('rename-feedback missing');
    this.#feedback = feedback;

    this.#cbs = cbs;

    // Input hygiene (D3 mechanism 1): stop the keydown at the input so it never bubbles
    // to the window keydown listener (movement + letter hotkeys). Enter/Escape handled here.
    this.#input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') this.#submit();
      else if (e.code === 'Escape') this.hide();
    });

    // Live-update the submit-enabled state as the user types: render() only runs on
    // open (empty draft → disabled), and real browsers do not fire click on a disabled
    // button, so without this the button would stay dead no matter what is typed. Uses
    // the same buildRenameViewModel SSOT so the enabled state matches #submit()'s gate.
    this.#input.addEventListener('input', () => {
      this.#refreshSubmitEnabled();
    });

    // The submit button is a second focus target (Tab from the input, or a mouse
    // click leaves it focused). Its keydown must also stopPropagation so a hotkey/
    // movement key pressed while the button holds focus never reaches the window
    // listener (completes the D3 stopPropagation contract — red-team Finding 1).
    // stopPropagation does not preventDefault, so Enter/Space still fire the click.
    this.#submitBtn.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });

    this.#submitBtn.addEventListener('click', () => {
      this.#submit();
    });
  }

  // Recompute the submit-enabled state from the live input value, via the same
  // buildRenameViewModel SSOT that render() and #submit() use.
  #refreshSubmitEnabled(): void {
    this.#submitBtn.disabled = !buildRenameViewModel('', this.#input.value).canSubmit;
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    this.#overlay.style.display = '';
    // Deferred focus (D3 mechanism 2): let the opening key event fully complete first.
    setTimeout(() => this.#input.focus(), 0);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // Stale-draft guard (RT-RN-02): a value/feedback from a prior open must not survive.
    this.#input.value = '';
    this.#feedback.textContent = '';
    // Release the in-flight lock (shopView/tradeView precedent): onReconnect and the
    // battle auto-show force-hide this overlay, and the SDK never settles an in-flight
    // reducer promise after a link drop (ADR-0085) — so .finally() may never run.
    // Without this reset, #pending stays true forever → dead submit button (reviewer B-1).
    this.#pending = false;
    this.#submitBtn.disabled = false;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Render the current-name label + submit-enabled state. textContent only (XSS). */
  render(vm: RenameViewModel): void {
    this.#current.textContent = vm.displayCurrentName;
    this.#submitBtn.disabled = !vm.canSubmit;
  }

  /** Display a feedback message (reducer success / failure). textContent only (XSS). */
  showFeedback(msg: string): void {
    this.#feedback.textContent = msg;
  }

  // Single shared submit path (Enter + click) ⇒ one #pending lock ⇒ no double-submit.
  #submit(): void {
    if (this.#pending) return;
    // currentName is irrelevant here — only trimmedDraft/canSubmit are consulted (PTC1B-7).
    const vm = buildRenameViewModel('', this.#input.value);
    if (!vm.canSubmit) return; // empty-after-trim → no-op, do NOT call onSubmit.
    // Clear any prior feedback so a stale "Name updated!" never lingers under a new
    // in-flight submission (red-team Finding 2 — misleading positive UX).
    this.#feedback.textContent = '';
    this.#pending = true;
    this.#submitBtn.disabled = true;
    // .finally() resets on BOTH resolve and reject — no dead-button-forever (RT-RN-03).
    // .catch() swallows a rejecting onSubmit: in production main.ts's onSubmit try/catch
    // never rejects (it renders feedback itself), but the view must not emit an unhandled
    // rejection if a caller ever hands it a rejecting promise — that would fail the vitest
    // run (unhandled error) even though every assertion passes.
    void Promise.resolve(this.#cbs.onSubmit(vm.trimmedDraft))
      .finally(() => {
        this.#pending = false;
        this.#submitBtn.disabled = false;
      })
      .catch(() => {
        /* feedback is the caller's responsibility; swallow to avoid unhandled rejection */
      });
  }
}
