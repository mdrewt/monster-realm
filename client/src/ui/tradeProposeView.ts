// ui/tradeProposeView.ts — thin DOM shell for the trade-PROPOSE overlay (pt-c2, ADR-0134).
//
// Mirrors renameView (pt-c1b, ADR-0133) — the same three input-hygiene mechanisms plus a
// multi-field draft (target <select>, monster checkboxes, two currency inputs):
//   1. Every focusable's OWN keydown listener calls e.stopPropagation() so field keystrokes
//      never reach the bubble-phase window keydown (movement + letter hotkeys). The currency
//      inputs additionally handle Enter=submit / Escape=hide locally (D6, red-team H-2).
//   2. show() DEFERS focus via setTimeout(…, 0) so the opening key event fully completes
//      before focus lands on the target <select>.
//   3. hide() resets the select→placeholder + unchecks all monsters + blanks both currency
//      inputs + feedback + releases the in-flight lock (#pending=false, submit re-enabled —
//      dead-button guard, ADR-0085 C6) so a stale draft/lock never survives a re-open.
//
// D6: player-controlled name/nickname → option.textContent / label textContent / value
// ONLY, NEVER innerHTML (XSS firewall; the dynamic checkbox-label path is the risk site).
// render() REBUILDS the monster-checkbox container authoritatively (a monster traded away
// since the last open must not linger — red-team M-2).
//
// Fully unit-covered via happy-dom (renameView precedent) — this file is therefore NOT in
// vite.config.ts coverage.exclude and NOT in the dom-shell-coverage-exclusion DOM_SHELLS.
//
// A single #submit() path is shared by the button click AND the currency-input Enter; a
// #pending lock reset via .finally() on BOTH resolve and reject (no dead-button-forever),
// with a trailing .catch() so a rejecting onSubmit never emits an unhandled rejection.
import {
  buildProposeSubmission,
  type TradeProposeArgs,
  type TradeProposeDraft,
  type TradeProposeLists,
  type TradeProposeTarget,
} from './tradeProposeModel';

export interface TradeProposeCallbacks {
  readonly onSubmit: (args: TradeProposeArgs) => Promise<void> | void;
}

// The placeholder <option> value — an empty string maps to "no target" (canSubmit:false).
const PLACEHOLDER_VALUE = '';

export class TradeProposeView {
  readonly #overlay: HTMLElement;
  readonly #target: HTMLSelectElement;
  readonly #monsters: HTMLElement;
  readonly #offerInput: HTMLInputElement;
  readonly #requestInput: HTMLInputElement;
  readonly #submitBtn: HTMLButtonElement;
  readonly #feedback: HTMLElement;
  readonly #cbs: TradeProposeCallbacks;
  // The rendered target list — the submission SSOT input (validated against the draft target).
  #targets: readonly TradeProposeTarget[] = [];
  // In-flight lock: prevents double-submit while a reducer Promise is pending.
  #pending = false;

  constructor(cbs: TradeProposeCallbacks) {
    const overlay = document.getElementById('tradepropose-overlay');
    if (!overlay) throw new Error('tradepropose-overlay element not found in DOM');
    this.#overlay = overlay;

    const target = document.getElementById('tradepropose-target');
    if (!target) throw new Error('tradepropose-target missing');
    this.#target = target as HTMLSelectElement;

    const monsters = document.getElementById('tradepropose-monsters');
    if (!monsters) throw new Error('tradepropose-monsters missing');
    this.#monsters = monsters;

    const offerInput = document.getElementById('tradepropose-offer-currency');
    if (!offerInput) throw new Error('tradepropose-offer-currency missing');
    this.#offerInput = offerInput as HTMLInputElement;

    const requestInput = document.getElementById('tradepropose-request-currency');
    if (!requestInput) throw new Error('tradepropose-request-currency missing');
    this.#requestInput = requestInput as HTMLInputElement;

    const submitBtn = document.getElementById('tradepropose-submit');
    if (!submitBtn) throw new Error('tradepropose-submit missing');
    this.#submitBtn = submitBtn as HTMLButtonElement;

    const feedback = document.getElementById('tradepropose-feedback');
    if (!feedback) throw new Error('tradepropose-feedback missing');
    this.#feedback = feedback;

    this.#cbs = cbs;

    // Input hygiene (D6 mechanism 1): stop the keydown at the <select> so arrow-key scrolling
    // never bubbles to the window movement listener (red-team H-2). change → live submit-enable.
    this.#target.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });
    this.#target.addEventListener('change', () => {
      this.#refreshSubmitEnabled();
    });

    // Both currency inputs: stopPropagation + local Enter=submit / Escape=hide + live enable.
    for (const input of [this.#offerInput, this.#requestInput]) {
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.code === 'Enter') this.#submit();
        else if (e.code === 'Escape') this.hide();
      });
      input.addEventListener('input', () => {
        this.#refreshSubmitEnabled();
      });
    }

    // The submit button is a focus target (Tab / mouse click leaves it focused); its keydown
    // must also stopPropagation so a hotkey/movement key never reaches the window listener.
    // stopPropagation does not preventDefault, so Enter/Space still fire the click.
    this.#submitBtn.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });
    this.#submitBtn.addEventListener('click', () => {
      this.#submit();
    });
  }

  get visible(): boolean {
    return this.#overlay.style.display !== 'none';
  }

  show(): void {
    this.#overlay.style.display = '';
    // Deferred focus (D6 mechanism 2): let the opening key event fully complete first.
    setTimeout(() => this.#target.focus(), 0);
  }

  hide(): void {
    this.#overlay.style.display = 'none';
    // Stale-draft guard: reset the select to the placeholder + uncheck all monsters + blank
    // both currency inputs + feedback so a prior open's draft never survives (red-team M-2).
    this.#target.value = PLACEHOLDER_VALUE;
    for (const cb of this.#monsters.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      cb.checked = false;
    }
    this.#offerInput.value = '';
    this.#requestInput.value = '';
    this.#feedback.textContent = '';
    // Release the in-flight lock (ADR-0085 C6): onReconnect and the battle auto-show force-hide
    // this overlay, and the SDK never settles an in-flight reducer promise after a link drop —
    // so .finally() may never run. Without this reset, #pending stays true forever → dead button.
    this.#pending = false;
    this.#submitBtn.disabled = false;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /**
   * Paint the target <select> options + REBUILD the monster-checkbox container.
   * textContent / value ONLY, NEVER innerHTML (XSS firewall). Authoritative rebuild: a
   * monster traded away since the last open must not linger (D6, red-team M-2).
   */
  render(lists: TradeProposeLists): void {
    this.#targets = lists.targets;

    // Target <select>: clear, add a placeholder, then one <option> per target.
    this.#target.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = PLACEHOLDER_VALUE;
    placeholder.textContent = 'Select a player…';
    this.#target.appendChild(placeholder);
    for (const t of lists.targets) {
      const opt = document.createElement('option');
      opt.value = t.identity; // value = identity (not the label — XSS-safe + selectOption target)
      opt.textContent = t.label; // textContent only (XSS firewall)
      this.#target.appendChild(opt);
    }

    // Monster checkboxes: full rebuild (never append) so stale monsters cannot linger.
    this.#monsters.replaceChildren();
    for (const m of lists.offerableMonsters) {
      const id = m.monsterId.toString();
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = id; // monsterId in value AND data-monster-id (the e2e reads data-monster-id)
      cb.setAttribute('data-monster-id', id);
      // Each checkbox is a focusable — stopPropagation so a movement key never bleeds (D6).
      cb.addEventListener('keydown', (e) => {
        e.stopPropagation();
      });
      cb.addEventListener('change', () => {
        this.#refreshSubmitEnabled();
      });
      label.appendChild(cb);
      // textContent only (XSS firewall — the dynamic checkbox-label path is the risk site).
      label.appendChild(document.createTextNode(` ${m.label}`));
      this.#monsters.appendChild(label);
    }

    this.#refreshSubmitEnabled();
  }

  /** Display a feedback message (reducer success / failure). textContent only (XSS). */
  showFeedback(msg: string): void {
    this.#feedback.textContent = msg;
  }

  // Read the live draft from the DOM: selected target, checked monster ids, currency strings.
  #readDraft(): TradeProposeDraft {
    const selectedMonsterIds: bigint[] = [];
    for (const cb of this.#monsters.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]:checked',
    )) {
      const raw = cb.getAttribute('data-monster-id');
      if (raw !== null) selectedMonsterIds.push(BigInt(raw));
    }
    return {
      targetIdentity: this.#target.value,
      selectedMonsterIds,
      offerCurrency: this.#offerInput.value,
      requestCurrency: this.#requestInput.value,
    };
  }

  // Recompute the submit-enabled state from the live draft, via the same
  // buildProposeSubmission SSOT that #submit() uses.
  #refreshSubmitEnabled(): void {
    this.#submitBtn.disabled = !buildProposeSubmission(this.#targets, this.#readDraft()).canSubmit;
  }

  // Single shared submit path (Enter + click) ⇒ one #pending lock ⇒ no double-submit.
  #submit(): void {
    if (this.#pending) return;
    const sub = buildProposeSubmission(this.#targets, this.#readDraft());
    if (!sub.canSubmit || sub.args === null) return; // invalid draft → no-op, no onSubmit call.
    // Clear any prior feedback so a stale "Offer sent!" never lingers under a new submission.
    this.#feedback.textContent = '';
    this.#pending = true;
    this.#submitBtn.disabled = true;
    // .finally() resets on BOTH resolve and reject — no dead-button-forever. .catch() swallows
    // a rejecting onSubmit (main.ts's onSubmit renders feedback itself and never rejects; the
    // view must not emit an unhandled rejection that would fail the vitest run).
    void Promise.resolve(this.#cbs.onSubmit(sub.args))
      .finally(() => {
        this.#pending = false;
        this.#submitBtn.disabled = false;
      })
      .catch(() => {
        /* feedback is the caller's responsibility; swallow to avoid unhandled rejection */
      });
  }
}
