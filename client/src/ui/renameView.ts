// ui/renameView.ts — thin DOM shell for the rename form: the Name section of the Profile screen
// (uif-16b; ui/profileView.ts owns the dialog, its a11y and the row walk). Its rows are [the field,
// Save] (`RowSection`); it commits through `onSubmit`.
//
// The one section with a text <input>. Three input-hygiene mechanisms:
//   1. The input's OWN keydown listener calls e.stopPropagation() so field keystrokes
//      never reach the bubble-phase window keydown (movement + letter hotkeys). It also
//      handles Enter=submit locally. Escape is main.ts's typing rule (it stops typing); the
//      section never hides itself, since a section is never shown or hidden alone.
//   2. The deferred initial focus is `ui/overlayA11y.ts`'s: the Profile frame's
//      `initialFocusSelector` is this field (#rename-input, OVERLAY_A11Y.profileView). The defer
//      is load-bearing: it lets the opening key event (KeyN) fully complete so the `n` does not
//      land in the field it just opened.
//   3. hide() resets the input value so a stale draft never survives a re-open. The view owns
//      no message line: a rename's outcome is a toast, routed by main.ts (uif-4b).
//
// Fully unit-covered via happy-dom (leaderboardView/errorOverlayView precedent) — this
// file is therefore NOT in vite.config.ts coverage.exclude.
//
// D2: player-controlled name → textContent ONLY, NEVER innerHTML (XSS firewall).
// A single #submit() path is shared by the button click AND the input's Enter; a
// #pending lock reset via .finally() on BOTH resolve and reject (no dead-button-forever,
// shopView precedent).
//
// The submit label and the section header are the strings this view owns. They are resolved
// through the i18n resolver (`t('chrome.rename.submit')`, `t('menu.profile.name.title')`,
// ui/i18n/resolver.ts) in show(), on every show(); `index.html` ships neither, so both are EMPTY
// until the first show(). The current display name is model data, rendered raw.
import { type Bindings, DEFAULT_BINDINGS } from '../input/bindings';
import { t } from './i18n/resolver';
import { buildRenameViewModel, type RenameViewModel } from './renameModel';
import type { RowSection } from './screens/profileScreen';

/** The section header `#rename-title` as `section`'s first child: index.html ships none, so it is
 *  created once and found after. */
function sectionHeader(section: HTMLElement): HTMLElement {
  const found = document.getElementById('rename-title');
  if (found) return found;
  const header = document.createElement('h2');
  header.id = 'rename-title';
  header.className = 'mr-section-header';
  section.prepend(header);
  return header;
}

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

export class RenameView implements RowSection {
  /** The section has no two-step confirm. */
  readonly armed = false;
  readonly #overlay: HTMLElement;
  readonly #title: HTMLElement;
  readonly #current: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #submitBtn: HTMLButtonElement;
  readonly #cbs: RenameCallbacks;
  // In-flight lock: prevents double-submit while a reducer Promise is pending.
  #pending = false;

  constructor(cbs: RenameCallbacks) {
    const overlay = document.getElementById('rename-overlay');
    if (!overlay) throw new Error('rename-overlay element not found in DOM');
    this.#overlay = overlay;
    this.#title = sectionHeader(overlay);

    const current = document.getElementById('rename-current');
    if (!current) throw new Error('rename-current missing');
    this.#current = current;

    const input = document.getElementById('rename-input');
    if (!input) throw new Error('rename-input missing');
    this.#input = input as HTMLInputElement;

    const submitBtn = document.getElementById('rename-submit');
    if (!submitBtn) throw new Error('rename-submit missing');
    this.#submitBtn = submitBtn as HTMLButtonElement;

    this.#cbs = cbs;

    // Input hygiene (D3 mechanism 1): stop the keydown at the input so it never bubbles
    // to the window keydown listener (movement + letter hotkeys). Enter is handled here.
    this.#input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter' || e.code === 'NumpadEnter') this.#submit();
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
    // EXCEPT the live table's D-pad and B codes (B5, CTL8H.2): the router hands those to the
    // Profile screen, which walks the rows and pops the frame. stopPropagation does not
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
    // The header and the submit label are resolved HERE, on EVERY show(), before the display
    // write (see evolutionView.show() for the boot-order / locale-switch reasoning).
    this.#title.textContent = t('menu.profile.name.title');
    this.#submitBtn.textContent = t('chrome.rename.submit');
    this.#overlay.style.display = '';
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // Stale-draft guard (RT-RN-02): a value from a prior open must not survive.
    this.#input.value = '';
    // Release the in-flight lock (shopView/tradeView precedent): onReconnect and the
    // battle auto-show force-hide the frame, and the SDK never settles an in-flight
    // reducer promise after a link drop — so .finally() may never run.
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

  /** The section root. */
  get sectionRoot(): HTMLElement {
    return this.#overlay;
  }

  /** The rows [the field, Save]; a disabled Save is not a row. */
  sectionRows(): readonly HTMLElement[] {
    return this.#submitBtn.disabled ? [this.#input] : [this.#input, this.#submitBtn];
  }

  /** With no row focused a token seats the field. */
  defaultRow(): HTMLElement {
    return this.#input;
  }

  // Single shared submit path (Enter + click) ⇒ one #pending lock ⇒ no double-submit.
  #submit(): void {
    if (this.#pending) return;
    // currentName is irrelevant here — only trimmedDraft/canSubmit are consulted.
    const vm = buildRenameViewModel('', this.#input.value);
    if (!vm.canSubmit) return; // empty-after-trim → no-op, do NOT call onSubmit.
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
