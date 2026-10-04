// ui/renameView.ts — thin DOM shell for the profile-rename overlay: Profile › Name (ctl-8h). Its
// rows are [the field, Save], the cursor being DOM focus (`applyRowOp`, the Name screen's tokens);
// it opens typing (overlayA11y focuses the field) and commits through `onSubmit`.
//
// First overlay with a text <input>. Three input-hygiene mechanisms the read-only
// overlays never needed:
//   1. The input's OWN keydown listener calls e.stopPropagation() so field keystrokes
//      never reach the bubble-phase window keydown (movement + letter hotkeys). It also
//      handles Enter=submit / Escape=cancel locally.
//   2. The deferred initial focus is NO LONGER OWNED HERE. `ui/overlayA11y.ts` is the
//      single owner of the setTimeout(…, 0) defer for every overlay, and it targets this
//      overlay's `initialFocusSelector` (#rename-input) from OVERLAY_A11Y. The defer itself is
//      still load-bearing for the same reason it always was: it lets the opening key event (KeyN)
//      fully complete so the `n` does not land in the field it just opened.
//   3. hide() resets the input value + feedback so a stale draft never survives a re-open.
//
// Fully unit-covered via happy-dom (leaderboardView/errorOverlayView precedent) — this
// file is therefore NOT in vite.config.ts coverage.exclude.
//
// D2: player-controlled name → textContent ONLY, NEVER innerHTML (XSS firewall).
// A single #submit() path is shared by the button click AND the input's Enter; a
// #pending lock reset via .finally() on BOTH resolve and reject (no dead-button-forever,
// shopView precedent).
//
// The submit label is the one string this view owns. It is resolved through
// the i18n resolver (`t('chrome.rename.submit')`, ui/i18n/resolver.ts) in show(), on every
// show(); `index.html` no longer ships the "Rename" text, so the button is EMPTY until the first
// show(). The current display name is model data, rendered raw.
import { type Bindings, DEFAULT_BINDINGS } from '../input/bindings';
import { t } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { buildRenameViewModel, type RenameViewModel } from './renameModel';
import { type RowOp, rowStep } from './screens/profileScreen';

/** Whether `code` leaves the focused submit button for the router: only the keys `b` binds to the
 *  D-pad and B do. */
const routedOnSubmit = (b: Bindings, code: string): boolean =>
  (['Up', 'Down', 'Left', 'Right', 'B'] as const).some((button) =>
    b.buttons[button].includes(code),
  );

export interface RenameCallbacks {
  readonly onSubmit: (name: string) => Promise<void> | void;
  /** The live binding table (a remap applies at once); absent, the defaults. */
  readonly bindings?: () => Bindings;
}

export class RenameView {
  // The last row token applied: a token is applied once (ui/screens/profileScreen.ts).
  #lastOp: RowOp | null = null;
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
      if (e.code === 'Enter' || e.code === 'NumpadEnter') this.#submit();
      else if (e.code === 'Escape') this.hide();
    });

    // Live-update the submit-enabled state as the user types: render() only runs on
    // open (empty draft → disabled), and real browsers do not fire click on a disabled
    // button, so without this the button would stay dead no matter what is typed. Uses
    // the same buildRenameViewModel SSOT so the enabled state matches #submit()'s gate.
    this.#input.addEventListener('input', () => {
      this.#refreshSubmitEnabled();
    });

    // The submit button is a second focus target (Tab from the input, a mouse click, or
    // the D-pad leaves it focused). Its keydown stops every hotkey so a letter pressed
    // while the button holds focus never reaches the window listener (red-team Finding 1),
    // EXCEPT the live table's D-pad and B codes (B5, CTL8H.2): the router hands those to the Name
    // screen, which walks the rows and pops the frame. stopPropagation does not
    // preventDefault, so Enter/Space still fire the click.
    this.#submitBtn.addEventListener('keydown', (e) => {
      const table = this.#cbs.bindings?.() ?? DEFAULT_BINDINGS;
      if (!routedOnSubmit(table, e.code)) e.stopPropagation();
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
    // Only the hidden->visible EDGE opens, so a repeat show() cannot re-schedule
    // overlayA11y's deferred focus and steal focus back from wherever the player put it.
    const wasVisible = this.visible;
    // The submit label is resolved HERE, on EVERY show() — unconditionally,
    // after the `wasVisible` read, before the display write (see
    // evolutionView.show() for the boot-order / locale-switch reasoning).
    this.#submitBtn.textContent = t('chrome.rename.submit');
    this.#overlay.style.display = '';
    if (!wasVisible) openOverlayA11y('renameView', this.#overlay);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // Stale-draft guard (RT-RN-02): a value/feedback from a prior open must not survive.
    this.#input.value = '';
    this.#feedback.textContent = '';
    // Release the in-flight lock (shopView/tradeView precedent): onReconnect and the
    // battle auto-show force-hide this overlay, and the SDK never settles an in-flight
    // reducer promise after a link drop — so .finally() may never run.
    // Without this reset, #pending stays true forever → dead submit button (reviewer B-1).
    this.#pending = false;
    this.#submitBtn.disabled = false;
    // DELIBERATELY UNGUARDED (see pvpView.ts's header) -- the self-healing path.
    closeOverlayA11y('renameView', null);
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

  /** One press on the rows [the field, Save] (the Name screen, CTL8H.2). The cursor is DOM focus;
   *  with no row focused it only seats the field. A on the field keeps typing; on Save it clicks,
   *  so #submit's own empty/pending gates hold. A disabled Save is not a row. */
  applyRowOp(op: RowOp): void {
    if (op === this.#lastOp) return;
    this.#lastOp = op;
    const rows = this.#submitBtn.disabled ? [this.#input] : [this.#input, this.#submitBtn];
    const { focus, press } = rowStep(rows, document.activeElement, this.#input, op);
    focus?.focus();
    if (press === this.#submitBtn) press.click();
  }

  /** Display a feedback message (reducer success / failure). textContent only (XSS). */
  showFeedback(msg: string): void {
    this.#feedback.textContent = msg;
  }

  // Single shared submit path (Enter + click) ⇒ one #pending lock ⇒ no double-submit.
  #submit(): void {
    if (this.#pending) return;
    // currentName is irrelevant here — only trimmedDraft/canSubmit are consulted.
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
