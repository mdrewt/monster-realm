// ui/tradeProposeView.ts — thin DOM shell for the trade-PROPOSE overlay.
//
// Mirrors renameView — the same three input-hygiene mechanisms plus a
// multi-field draft (target <select>, monster checkboxes, two currency inputs):
//   1. The select, every checkbox and both currency inputs keep every keydown to themselves
//      (e.stopPropagation()) EXCEPT Escape, Enter and NumpadEnter (ctl-8e, CTL6B.5): letters and
//      arrows never reach the window's hotkey ladder or movement, while Escape (routed in the
//      capture phase anyway) and Enter reach the router as Start and A. The submit button keeps
//      every key: Enter/Space are its own click.
//   2. The deferred initial focus is NO LONGER OWNED HERE. `ui/overlayA11y.ts` is the
//      single owner of the setTimeout(…, 0) defer for all seventeen overlays, and it targets this
//      overlay's `initialFocusSelector` (#tradepropose-target) from OVERLAY_A11Y. The defer is
//      still load-bearing: it lets the opening key event fully complete before focus lands.
//   3. hide() resets the select→placeholder + unchecks all monsters + blanks both currency
//      inputs + feedback + releases the in-flight lock (#pending=false, submit re-enabled —
//      dead-button guard) so a stale draft/lock never survives a re-open.
//
// D6: player-controlled name/nickname → option.textContent / label textContent / value
// ONLY, NEVER innerHTML (XSS firewall; the dynamic checkbox-label path is the risk site).
// render() REBUILDS the monster-checkbox container authoritatively (a monster traded away
// since the last open must not linger — red-team M-2).
//
// Fully unit-covered via happy-dom (renameView precedent) — this file is therefore NOT in
// vite.config.ts coverage.exclude and NOT in the dom-shell-coverage-exclusion DOM_SHELLS.
//
// A single #submit() path is shared by the button click AND the wizard's commit token; a
// #pending lock reset via .finally() on BOTH resolve and reject (no dead-button-forever),
// with a trailing .catch() so a rejecting onSubmit never emits an unhandled rejection.
//
// ctl-8e: the wizard (screens/tradeProposeScreen.ts) drives this view through paint(). The DOM is
// the ONE draft (the select's value, the ticked boxes, the two fields): the screen holds only the
// step, the cursors and two one-shot tokens (toggle, commit), compared by object identity, which
// paint() applies to that draft once. What is on screen is what is sent, and the mouse and the
// D-pad edit the same draft. Focus follows the step, and moves only when the step changes, so the
// D-pad reaches the router on Offer and Review (a focused select or input owns the arrows,
// input/router.ts) and a repaint never pulls focus from where the player put it.
//
// The strings this view owns are resolved through the i18n resolver (`t()`/`tf()`,
// ui/i18n/resolver.ts): the target placeholder (`tradePropose.target.placeholder`, in
// render()), the submit label (`chrome.tradePropose.submit`, in show() — `index.html` no
// longer ships the "Offer" text, so the button is EMPTY until the first show()), and the wizard's
// step names, review question, summary and Yes / No (ctl-8e, in render()/paint()). Target labels
// and monster labels are model data, rendered raw. Every `t(` first argument is a string LITERAL.
import { t, tf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { ProposeCommit, ProposeToggle } from './screens/tradeProposeScreen';
import {
  buildProposeSubmission,
  type ProposeStep,
  parseCurrency,
  proposeSteps,
  type TradeProposeArgs,
  type TradeProposeDraft,
  type TradeProposeLists,
  type TradeProposeTarget,
} from './tradeProposeModel';

export interface TradeProposeCallbacks {
  readonly onSubmit: (args: TradeProposeArgs) => Promise<void> | void;
  /** game-core's per-side monster cap, read once at boot from the
   *  `max_trade_monsters_per_side()` wasm export (main.ts) — never a TS literal. */
  readonly maxMonstersPerSide: number;
}

/** What the wizard screen paints (ctl-8e). */
export interface TradeProposePaint {
  readonly steps: readonly ProposeStep[];
  readonly step: ProposeStep;
  readonly lists: TradeProposeLists;
  /** The Offer cursor's monster id (decimal string); null with nothing to offer. */
  readonly offerCursor: string | null;
  /** The Review cursor: Yes (true) or No. */
  readonly yes: boolean;
  readonly toggle: ProposeToggle | null;
  readonly commit: ProposeCommit | null;
}

// The placeholder <option> value — an empty string maps to "no target" (canSubmit:false).
const PLACEHOLDER_VALUE = '';

// The keys a draft control lets reach the window: Escape (Start, or stop typing) and Enter (A).
const FIELD_RELEASED = new Set(['Escape', 'Enter', 'NumpadEnter']);
const shield = (e: KeyboardEvent): void => {
  if (!FIELD_RELEASED.has(e.code)) e.stopPropagation();
};

/** A header item: the catalogued step name, marked when it is the active step. */
function stepItem(step: ProposeStep, active: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.setAttribute('data-step', step);
  li.textContent = stepLabel(step);
  if (active) li.setAttribute('aria-current', 'step');
  return li;
}

function stepLabel(step: ProposeStep): string {
  switch (step) {
    case 'target':
      return t('tradePropose.step.target');
    case 'offer':
      return t('tradePropose.step.offer');
    case 'coins':
      return t('tradePropose.step.coins');
    case 'ask':
      return t('tradePropose.step.ask');
    case 'review':
      return t('tradePropose.step.review');
  }
}

export class TradeProposeView {
  readonly #overlay: HTMLElement;
  readonly #target: HTMLSelectElement;
  readonly #monsters: HTMLElement;
  readonly #offerInput: HTMLInputElement;
  readonly #requestInput: HTMLInputElement;
  readonly #submitBtn: HTMLButtonElement;
  readonly #feedback: HTMLElement;
  readonly #cbs: TradeProposeCallbacks;
  // ctl-8e: the step header (before the select) and the review row (after the submit button).
  readonly #steps: HTMLOListElement;
  readonly #review: HTMLElement;
  readonly #reviewPrompt: HTMLElement;
  readonly #reviewSummary: HTMLElement;
  readonly #reviewYes: HTMLElement;
  readonly #reviewNo: HTMLElement;
  // The step the last paint showed (null: none since the last hide), and the tokens already applied.
  #paintedStep: ProposeStep | null = null;
  #lastToggle: ProposeToggle | null = null;
  #lastCommit: ProposeCommit | null = null;
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

    // The wizard's parts (ctl-8e). The header goes before the select; the review row goes after
    // the submit button and takes programmatic focus only, so typing mode's Escape (focus to the
    // frame's first non-text control) still lands on the select. Yes / No are marks, not buttons.
    this.#steps = document.createElement('ol');
    this.#steps.setAttribute('data-testid', 'tradepropose-steps');
    this.#target.before(this.#steps);
    this.#monsters.tabIndex = -1;
    this.#review = document.createElement('div');
    this.#review.setAttribute('data-testid', 'tradepropose-review');
    this.#review.tabIndex = -1;
    this.#review.style.display = 'none';
    this.#reviewPrompt = document.createElement('div');
    this.#reviewPrompt.setAttribute('data-testid', 'tradepropose-review-prompt');
    this.#reviewSummary = document.createElement('div');
    this.#reviewSummary.setAttribute('data-testid', 'tradepropose-review-summary');
    this.#reviewYes = document.createElement('span');
    this.#reviewYes.setAttribute('data-testid', 'tradepropose-review-yes');
    this.#reviewNo = document.createElement('span');
    this.#reviewNo.setAttribute('data-testid', 'tradepropose-review-no');
    this.#review.append(this.#reviewPrompt, this.#reviewSummary, this.#reviewYes, this.#reviewNo);
    this.#submitBtn.after(this.#review);

    // Input hygiene (D6 mechanism 1): the select keeps its keys (arrows pick a target natively)
    // but lets Escape / Enter through. change → live submit-enable.
    this.#target.addEventListener('keydown', shield);
    this.#target.addEventListener('change', () => {
      this.#refreshSubmitEnabled();
    });

    // Both currency inputs are typing rows (CTL6B.5): the field owns every key but Escape and
    // Enter, which main.ts routes (stop typing / A). Live enable on input.
    for (const input of [this.#offerInput, this.#requestInput]) {
      input.addEventListener('keydown', shield);
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
    // Only the hidden->visible EDGE opens (see pvpView.ts's header for why).
    const wasVisible = this.visible;
    // The submit label is resolved HERE, on EVERY show() — unconditionally,
    // after the `wasVisible` read, before the display write (see
    // evolutionView.show() for the boot-order / locale-switch reasoning).
    this.#submitBtn.textContent = t('chrome.tradePropose.submit');
    this.#overlay.style.display = '';
    if (!wasVisible) openOverlayA11y('tradeProposeView', this.#overlay);
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
    // Release the in-flight lock: onReconnect and the battle auto-show force-hide
    // this overlay, and the SDK never settles an in-flight reducer promise after a link drop —
    // so .finally() may never run. Without this reset, #pending stays true forever → dead button.
    this.#pending = false;
    this.#submitBtn.disabled = false;
    // A reopen's first paint moves focus again; the review row closes with the wizard.
    this.#paintedStep = null;
    this.#review.style.display = 'none';
    // DELIBERATELY UNGUARDED (see pvpView.ts's header) -- the self-healing path.
    closeOverlayA11y('tradeProposeView', null);
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
    this.#renderLists(lists);
    this.#paintHeader(proposeSteps(false), 'target');
    this.#refreshSubmitEnabled();
  }

  /**
   * Paint the wizard (ctl-8e): rebuild the lists keeping the on-screen draft, apply a new toggle
   * token once, mark the step / cursor / review row, move focus when the step changed, then send
   * once for a new commit token. The commit token is remembered first, so a throw anywhere below
   * can never leave it to send on a later paint.
   */
  paint(p: TradeProposePaint): void {
    const commit = p.commit !== null && p.commit !== this.#lastCommit ? p.commit : null;
    if (commit !== null) this.#lastCommit = commit;

    // The rebuild keeps the on-screen draft, minus a target or monster that left the lists. When
    // it lost any, the player has not seen the draft a send would carry: the token is spent unsent.
    const target = this.#target.value;
    const checked = new Set(this.#readDraft().selectedMonsterIds.map((id) => id.toString()));
    const focusedBox = this.#monsters.contains(document.activeElement)
      ? document.activeElement?.getAttribute('data-monster-id')
      : undefined;
    this.#renderLists(p.lists, target, checked);
    const draftKept =
      this.#target.value === target && this.#readDraft().selectedMonsterIds.length === checked.size;
    // A focused box was replaced: focus its successor, or the list when its monster left.
    if (focusedBox != null) (this.#boxOf(focusedBox) ?? this.#monsters).focus();

    if (p.toggle !== null && p.toggle !== this.#lastToggle) {
      this.#lastToggle = p.toggle;
      const box = this.#boxOf(p.toggle.monsterId.toString());
      if (box !== null) box.checked = !box.checked;
    }

    this.#paintHeader(p.steps, p.step);
    for (const box of this.#monsters.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      const label = box.parentElement;
      if (label === null) continue;
      if (box.getAttribute('data-monster-id') === p.offerCursor) {
        label.setAttribute('aria-current', 'true');
      } else {
        label.removeAttribute('aria-current');
      }
    }
    this.#paintReview(p.yes);

    if (p.step !== this.#paintedStep) {
      this.#paintedStep = p.step;
      this.#focusStep(p.step);
    }
    // Focus has left the review row before it is hidden (never focus inside a hidden subtree).
    this.#review.style.display = p.step === 'review' ? '' : 'none';
    this.#refreshSubmitEnabled();

    if (commit !== null && draftKept) this.#submit();
  }

  /** Rebuild the select and the boxes from `lists`, keeping `target` and the `checked` ids that
   *  are still listed (a target or monster that left is gone: it falls back to the placeholder). */
  #renderLists(
    lists: TradeProposeLists,
    target: string = PLACEHOLDER_VALUE,
    checked: ReadonlySet<string> = new Set(),
  ): void {
    this.#targets = lists.targets;

    // Target <select>: clear, add a placeholder, then one <option> per target.
    this.#target.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = PLACEHOLDER_VALUE;
    placeholder.textContent = t('tradePropose.target.placeholder');
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
      cb.checked = checked.has(id);
      // Each checkbox is a focusable — shielded so a movement key never bleeds (D6).
      cb.addEventListener('keydown', shield);
      cb.addEventListener('change', () => {
        this.#refreshSubmitEnabled();
      });
      label.appendChild(cb);
      // textContent only (XSS firewall — the dynamic checkbox-label path is the risk site).
      label.appendChild(document.createTextNode(` ${m.label}`));
      this.#monsters.appendChild(label);
    }
    this.#target.value = lists.targets.some((x) => x.identity === target)
      ? target
      : PLACEHOLDER_VALUE;
  }

  #boxOf(monsterId: string): HTMLInputElement | null {
    for (const box of this.#monsters.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      if (box.getAttribute('data-monster-id') === monsterId) return box;
    }
    return null;
  }

  /** One item per step, aria-current="step" on the active one. */
  #paintHeader(steps: readonly ProposeStep[], active: ProposeStep): void {
    const items = steps.map((step) => stepItem(step, step === active));
    this.#steps.replaceChildren(...items);
    // The two focus targets that are not form controls are named by their step.
    this.#monsters.setAttribute('aria-label', t('tradePropose.step.offer'));
    this.#review.setAttribute('aria-label', t('tradePropose.step.review'));
  }

  /** The review row, read from the on-screen draft: the question (or why it cannot be sent), a
   *  summary of the PARSED draft, and the Yes / No marks. */
  #paintReview(yes: boolean): void {
    const draft = this.#readDraft();
    const sub = buildProposeSubmission(this.#targets, draft, this.#cbs.maxMonstersPerSide);
    this.#reviewPrompt.textContent = sub.canSubmit
      ? t('tradePropose.review.prompt')
      : t('tradePropose.review.incomplete');
    this.#reviewSummary.textContent = tf('tradePropose.review.summary', {
      target: this.#targets.find((x) => x.identity === draft.targetIdentity)?.label ?? '',
      monsters: draft.selectedMonsterIds.length,
      offer: parseCurrency(draft.offerCurrency).toString(),
      ask: parseCurrency(draft.requestCurrency).toString(),
    });
    this.#reviewYes.textContent = t('tradePropose.review.yes');
    this.#reviewNo.textContent = t('tradePropose.review.no');
    for (const [mark, on] of [
      [this.#reviewYes, yes],
      [this.#reviewNo, !yes],
    ] as const) {
      if (on) mark.setAttribute('aria-current', 'true');
      else mark.removeAttribute('aria-current');
    }
  }

  /** Focus the step's control: the select, the monsters, a typing row, or the review row. */
  #focusStep(step: ProposeStep): void {
    switch (step) {
      case 'target':
        this.#target.focus();
        return;
      case 'offer':
        this.#monsters.focus();
        return;
      case 'coins':
        this.#offerInput.focus();
        return;
      case 'ask':
        this.#requestInput.focus();
        return;
      case 'review':
        this.#review.style.display = '';
        this.#review.focus();
        return;
    }
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
      // Digit-scan guard (mirrors parseCurrency): keeps #readDraft TOTAL even if the
      // data-monster-id attribute is tampered (DevTools) — a non-numeric value is skipped
      // rather than thrown from BigInt() inside the synchronous #submit() path, which the
      // downstream .catch() (a promise-reject handler) would NOT catch (reviewer/red-team).
      if (raw !== null && /^[0-9]+$/.test(raw)) selectedMonsterIds.push(BigInt(raw));
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
    this.#submitBtn.disabled = !buildProposeSubmission(
      this.#targets,
      this.#readDraft(),
      this.#cbs.maxMonstersPerSide,
    ).canSubmit;
  }

  // Single shared submit path (the wizard's commit token + click) ⇒ one #pending lock ⇒ no
  // double-submit.
  #submit(): void {
    if (this.#pending) return;
    const sub = buildProposeSubmission(
      this.#targets,
      this.#readDraft(),
      this.#cbs.maxMonstersPerSide,
    );
    if (!sub.canSubmit || sub.args === null) return; // invalid draft → no-op, no onSubmit call.
    // Clear any prior feedback so a stale "Offer sent!" never lingers under a new submission.
    this.#feedback.textContent = '';
    this.#pending = true;
    this.#submitBtn.disabled = true;
    // .finally() resets on BOTH resolve and reject — no dead-button-forever. .catch() swallows
    // a rejecting onSubmit (main.ts's onSubmit renders feedback itself and never rejects; the
    // view must not emit an unhandled rejection that would fail the vitest run).
    let sent: Promise<void> | void;
    try {
      sent = this.#cbs.onSubmit(sub.args);
    } catch {
      // A SYNCHRONOUS throw releases the lock at once (never a dead button); feedback is the
      // caller's, as for a rejection.
      this.#pending = false;
      this.#submitBtn.disabled = false;
      return;
    }
    void Promise.resolve(sent)
      .finally(() => {
        this.#pending = false;
        this.#submitBtn.disabled = false;
      })
      .catch(() => {
        /* feedback is the caller's responsibility; swallow to avoid unhandled rejection */
      });
  }
}
