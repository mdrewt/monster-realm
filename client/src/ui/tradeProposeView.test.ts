// @vitest-environment happy-dom
// ui/tradeProposeView.test.ts — RED gating tests for pt-c2 DOM shell (PTC2-8..12 + proof-of-teeth).
//
// Slice: pt-c2 · Source-of-truth: docs/specs/pt-c2-plan.md + docs/adr/0134-trade-propose-ui.md
//
// RED REASON: tradeProposeView.ts does not exist yet.
// Every test below will fail with:
//   "Failed to resolve import './tradeProposeView'" (module-not-found)
//
// WRONG-IMPL-KILLED list (one per criterion):
//   PTC2-8: render paints options/checkboxes via textContent (XSS)    → XSS + render tests
//   PTC2-9: stopPropagation on every focusable                        → stopProp spy tests
//   PTC2-10: live submit-enable on change/input                       → live-enable tests
//   PTC2-11: show()=deferred focus; hide()=reset draft/feedback/#pending  → hide-reset tests
//   PTC2-12: single #submit() #pending lock + finally-reset + catch   → lock + finally tests
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.
// Corrections must be traced to the spec and must not weaken the bite.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TradeProposeArgs, TradeProposeLists } from './tradeProposeModel';
import { type TradeProposeCallbacks, TradeProposeView } from './tradeProposeView';

// ---------------------------------------------------------------------------
// DOM mount helper — installs the index.html shell for tradeProposeView (ADR-0134 D1).
// Each test gets a fresh DOM via beforeEach to prevent cross-test contamination.
// The exact ids and data-testids are pinned from the ADR-0134 D1 contract.
// ---------------------------------------------------------------------------

function mountTradeProposeOverlay(): {
  overlay: HTMLElement;
  targetSelect: HTMLSelectElement;
  monstersContainer: HTMLElement;
  offerCurrencyInput: HTMLInputElement;
  requestCurrencyInput: HTMLInputElement;
  submitBtn: HTMLButtonElement;
  feedbackEl: HTMLElement;
} {
  const existing = document.getElementById('tradepropose-overlay');
  if (existing) existing.remove();

  // Exact shell from ADR-0134 D1 — stable ids + data-testids.
  document.body.innerHTML = `
    <div id="tradepropose-overlay" style="display:none">
      <select id="tradepropose-target" data-testid="tradepropose-target"></select>
      <div id="tradepropose-monsters" data-testid="tradepropose-monsters"></div>
      <input id="tradepropose-offer-currency" data-testid="tradepropose-offer-currency" type="number" min="0" />
      <input id="tradepropose-request-currency" data-testid="tradepropose-request-currency" type="number" min="0" />
      <button id="tradepropose-submit" data-testid="tradepropose-submit" type="button">Offer</button>
      <div id="tradepropose-feedback" data-testid="tradepropose-feedback"></div>
    </div>
  `;

  return {
    overlay: document.getElementById('tradepropose-overlay') as HTMLElement,
    targetSelect: document.getElementById('tradepropose-target') as HTMLSelectElement,
    monstersContainer: document.getElementById('tradepropose-monsters') as HTMLElement,
    offerCurrencyInput: document.getElementById('tradepropose-offer-currency') as HTMLInputElement,
    requestCurrencyInput: document.getElementById(
      'tradepropose-request-currency',
    ) as HTMLInputElement,
    submitBtn: document.getElementById('tradepropose-submit') as HTMLButtonElement,
    feedbackEl: document.getElementById('tradepropose-feedback') as HTMLElement,
  };
}

function teardown(): void {
  document.body.innerHTML = '';
}

// Minimal lists fixture for render() calls.
function makeLists(
  targets: Array<{ identity: string; label: string }> = [],
  offerableMonsters: Array<{ monsterId: bigint; label: string }> = [],
): TradeProposeLists {
  return {
    targets: targets.map((t) => ({ identity: t.identity, label: t.label })),
    offerableMonsters: offerableMonsters.map((m) => ({
      monsterId: m.monsterId,
      label: m.label,
    })),
  };
}

// Drain microtask queue through promise chain (pending→finally→catch).
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// Default no-op callbacks.
function noop(): TradeProposeCallbacks {
  return { onSubmit: async (_args: TradeProposeArgs) => {} };
}

// ---------------------------------------------------------------------------
// Constructor: throw when required DOM nodes are missing
// ---------------------------------------------------------------------------

describe('TradeProposeView constructor: throws when required DOM nodes are missing', () => {
  afterEach(() => teardown());

  it('BITES: ctor throws when #tradepropose-overlay is absent — kills no-guard impl', () => {
    // DOM is empty; no overlay exists.
    expect(() => new TradeProposeView(noop())).toThrow();
  });

  it('BITES: ctor throws when #tradepropose-target select is missing — kills partial-DOM impl', () => {
    document.body.innerHTML = `
      <div id="tradepropose-overlay" style="display:none">
        <div id="tradepropose-monsters"></div>
        <input id="tradepropose-offer-currency" type="number" />
        <input id="tradepropose-request-currency" type="number" />
        <button id="tradepropose-submit" type="button">Offer</button>
        <div id="tradepropose-feedback"></div>
      </div>`;
    expect(() => new TradeProposeView(noop())).toThrow();
  });

  it('BITES: ctor throws when #tradepropose-monsters container is missing — kills partial-DOM impl', () => {
    document.body.innerHTML = `
      <div id="tradepropose-overlay" style="display:none">
        <select id="tradepropose-target"></select>
        <input id="tradepropose-offer-currency" type="number" />
        <input id="tradepropose-request-currency" type="number" />
        <button id="tradepropose-submit" type="button">Offer</button>
        <div id="tradepropose-feedback"></div>
      </div>`;
    expect(() => new TradeProposeView(noop())).toThrow();
  });

  it('BITES: ctor throws when #tradepropose-submit button is missing — kills partial-DOM impl', () => {
    document.body.innerHTML = `
      <div id="tradepropose-overlay" style="display:none">
        <select id="tradepropose-target"></select>
        <div id="tradepropose-monsters"></div>
        <input id="tradepropose-offer-currency" type="number" />
        <input id="tradepropose-request-currency" type="number" />
        <div id="tradepropose-feedback"></div>
      </div>`;
    expect(() => new TradeProposeView(noop())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Visibility: show / hide / visible / toggle
// ---------------------------------------------------------------------------

describe('TradeProposeView visibility: show / hide / visible / toggle', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => teardown());

  it('BITES: visible is false initially (display:none in index.html) — kills always-visible impl', () => {
    const view = new TradeProposeView(noop());
    expect(view.visible).toBe(false);
  });

  it('BITES: show() makes visible=true — kills no-op show impl', () => {
    const view = new TradeProposeView(noop());
    view.show();
    expect(view.visible).toBe(true);
  });

  it('BITES: hide() makes visible=false — kills no-op hide impl', () => {
    const view = new TradeProposeView(noop());
    view.show();
    view.hide();
    expect(view.visible).toBe(false);
  });

  it('BITES: toggle() opens when hidden, closes when visible — kills no-op toggle impl', () => {
    const view = new TradeProposeView(noop());
    expect(view.visible).toBe(false);
    view.toggle();
    expect(view.visible).toBe(true);
    view.toggle();
    expect(view.visible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PTC2-8: render() — paints <select> options and monster checkboxes via textContent
// ---------------------------------------------------------------------------

describe('TradeProposeView PTC2-8: render() paints options and checkboxes via textContent', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => teardown());

  it('BITES: render() populates #tradepropose-target with one <option> per target — kills no-render impl', () => {
    const view = new TradeProposeView(noop());
    view.render(
      makeLists(
        [
          { identity: '0xaaa1', label: 'Alice' },
          { identity: '0xbbb2', label: 'Bob' },
        ],
        [],
      ),
    );
    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    // May have a placeholder option + 2 target options, or exactly 2 — at least 2.
    const options = Array.from(select.options).filter(
      (o) => o.value === '0xaaa1' || o.value === '0xbbb2',
    );
    expect(options).toHaveLength(2);
  });

  it('BITES: render() sets option value to identity — kills impl that uses label as value', () => {
    const view = new TradeProposeView(noop());
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    const opt = Array.from(select.options).find((o) => o.value === '0xaaa1');
    expect(opt, 'option with value=0xaaa1 must exist').toBeTruthy();
  });

  it('BITES: render() sets option textContent to label — kills impl that sets innerHTML', () => {
    const view = new TradeProposeView(noop());
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    const opt = Array.from(select.options).find((o) => o.value === '0xaaa1');
    expect(opt?.textContent?.trim()).toBe('Alice');
  });

  it('BITES: render() injects monster checkboxes into #tradepropose-monsters — kills no-checkbox impl', () => {
    const view = new TradeProposeView(noop());
    view.render(
      makeLists(
        [],
        [
          { monsterId: 5n, label: 'Sparky Lv.3' },
          { monsterId: 12n, label: 'Flameling Lv.1' },
        ],
      ),
    );
    const container = document.getElementById('tradepropose-monsters') as HTMLElement;
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
  });

  it('BITES: each checkbox carries monsterId as value AND data-monster-id — kills missing-data-attr impl', () => {
    // ADR-0134 D1: `<input type=checkbox>` carries monsterId in `value` AND `data-monster-id`.
    // WRONG IMPL KILLED: an impl that sets value but not data-monster-id (or vice versa) —
    // the e2e reads data-monster-id to assert the SPECIFIC monster transferred.
    const view = new TradeProposeView(noop());
    view.render(makeLists([], [{ monsterId: 42n, label: 'Bulb Lv.5' }]));
    const container = document.getElementById('tradepropose-monsters') as HTMLElement;
    const cb = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(cb, 'checkbox must exist').toBeTruthy();
    expect(cb.value).toBe('42');
    expect(cb.getAttribute('data-monster-id')).toBe('42');
  });

  it('★ BITES (XSS): target name containing <script> is rendered as literal textContent — kills innerHTML impl', () => {
    // ADR-0134 D6: "Player-controlled name/nickname → textContent/option.textContent/value ONLY,
    // NEVER innerHTML (XSS firewall; the dynamic checkbox-label path is the risk site)."
    // WRONG IMPL KILLED: an impl that sets option.innerHTML = target.label — the
    // <script> tag would be parsed and executed in a browser context.
    // PROOF-OF-TEETH: a script element must NOT appear in the select after render.
    const xssLabel = '<script>alert(1)</script>';
    const view = new TradeProposeView(noop());
    view.render(makeLists([{ identity: '0xevil', label: xssLabel }], []));
    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    // No <script> node must exist inside the select
    expect(select.querySelector('script')).toBeNull();
    // The option text must equal the literal string (not the empty string after innerHTML strips it)
    const opt = Array.from(select.options).find((o) => o.value === '0xevil');
    expect(opt, 'option for xss identity must exist').toBeTruthy();
    expect(opt!.textContent).toBe(xssLabel);
  });

  it('★ BITES (XSS): monster nickname containing <script> is rendered as literal textContent — kills label-innerHTML impl', () => {
    // ADR-0134 D6: the dynamic checkbox-label path is the specific risk site for XSS.
    // WRONG IMPL KILLED: `container.innerHTML += '<label>...' + monster.label + '...'`
    // PROOF-OF-TEETH: no <script> node in the monsters container after render.
    const xssNickname = '<script>alert("monster")</script>';
    const view = new TradeProposeView(noop());
    view.render(makeLists([], [{ monsterId: 7n, label: xssNickname }]));
    const container = document.getElementById('tradepropose-monsters') as HTMLElement;
    expect(container.querySelector('script')).toBeNull();
    // The label text must appear as literal text somewhere in the container
    expect(container.textContent).toContain(xssNickname);
  });

  it('BITES: render() sets submit disabled=true when no target selected (empty draft) — kills always-enabled impl', () => {
    // ADR-0134 D6: "set submit disabled from a fresh buildProposeSubmission".
    // After render with no pre-selected target, the submit must be disabled.
    const view = new TradeProposeView(noop());
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;
    // No selection = no valid target → canSubmit:false → disabled:true
    expect(btn.disabled).toBe(true);
  });

  it('BITES: render() rebuilds monster checkboxes on successive calls (stale-monster guard)', () => {
    // ADR-0134 D6: "show() ... REBUILDS the monster-checkbox container from the current
    // offerableMonsters (authoritative rebuild — a monster traded away since the last open
    // must not linger, red-team M-2)."
    // WRONG IMPL KILLED: an impl that appends rather than rebuilding — old monsters linger.
    const view = new TradeProposeView(noop());
    view.render(makeLists([], [{ monsterId: 1n, label: 'First' }]));
    const container = document.getElementById('tradepropose-monsters') as HTMLElement;
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);

    // Second render with DIFFERENT monsters — old one must be gone
    view.render(
      makeLists(
        [],
        [
          { monsterId: 2n, label: 'Second' },
          { monsterId: 3n, label: 'Third' },
        ],
      ),
    );
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    // First monster's checkbox (value='1') must no longer exist
    expect(container.querySelector('input[value="1"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PTC2-8 / showFeedback: writes textContent to #tradepropose-feedback
// ---------------------------------------------------------------------------

describe('TradeProposeView showFeedback()', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => teardown());

  it('BITES: showFeedback() sets feedback textContent — kills no-op impl', () => {
    const view = new TradeProposeView(noop());
    view.showFeedback('Offer sent!');
    const fb = document.getElementById('tradepropose-feedback') as HTMLElement;
    expect(fb.textContent).toBe('Offer sent!');
  });
});

// ---------------------------------------------------------------------------
// PTC2-9: stopPropagation on EVERY focusable (ADR-0134 D6)
// Proof-of-teeth: a keydown on each focusable MUST NOT reach window keydown listener.
// ---------------------------------------------------------------------------

describe('★★ TradeProposeView PTC2-9: stopPropagation on every focusable — kills movement-bleed impl', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('★★ BITES: keydown on target <select> does NOT reach window — kills missing-stopProp impl (arrow bleed)', () => {
    // ADR-0134 D6: "stopPropagation on the `keydown` of the target <select>".
    // Red-team H-2: a focused <select> scrolled with arrows would otherwise walk the character.
    // WRONG IMPL KILLED: a view that doesn't call stopPropagation on the select's keydown.
    const view = new TradeProposeView(noop());
    view.show();
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    select.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true }));
    expect(spy, 'ArrowDown on select must not reach window (arrow bleed)').not.toHaveBeenCalled();
    window.removeEventListener('keydown', spy);
  });

  it('★★ BITES: keydown on monster checkbox does NOT reach window — kills missing-stopProp impl', () => {
    // ADR-0134 D6: stopPropagation on EACH monster checkbox.
    // WRONG IMPL KILLED: impl that only stopPropagates the select but forgets checkboxes.
    const view = new TradeProposeView(noop());
    view.render(makeLists([], [{ monsterId: 5n, label: 'Sparky Lv.3' }]));
    view.show();
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    const container = document.getElementById('tradepropose-monsters') as HTMLElement;
    const cb = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    cb.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    expect(spy, 'KeyW on monster checkbox must not reach window').not.toHaveBeenCalled();
    window.removeEventListener('keydown', spy);
  });

  it('★★ BITES: keydown on offer currency input does NOT reach window — kills missing-stopProp impl', () => {
    // ADR-0134 D6: stopPropagation on BOTH currency inputs.
    const view = new TradeProposeView(noop());
    view.show();
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    const input = document.getElementById('tradepropose-offer-currency') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }));
    expect(spy, 'KeyA on offer currency input must not reach window').not.toHaveBeenCalled();
    window.removeEventListener('keydown', spy);
  });

  it('★★ BITES: keydown on request currency input does NOT reach window — kills missing-stopProp impl', () => {
    // ADR-0134 D6: stopPropagation on BOTH currency inputs.
    const view = new TradeProposeView(noop());
    view.show();
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    const input = document.getElementById('tradepropose-request-currency') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', bubbles: true }));
    expect(spy, 'KeyS on request currency input must not reach window').not.toHaveBeenCalled();
    window.removeEventListener('keydown', spy);
  });

  it('★★ BITES: keydown on submit button does NOT reach window — kills button-stopProp-missing impl', () => {
    // ADR-0134 D6: stopPropagation on the submit <button>.
    // WRONG IMPL KILLED: impl that stopPropagates inputs but forgets the button —
    // tab-focus leaves button focused; then a hotkey keydown would bleed to window.
    const view = new TradeProposeView(noop());
    view.show();
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;
    btn.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', bubbles: true }));
    expect(spy, 'KeyL on submit button must not reach window').not.toHaveBeenCalled();
    window.removeEventListener('keydown', spy);
  });
});

// ---------------------------------------------------------------------------
// PTC2-9: Enter and Escape local handling on currency inputs
// ---------------------------------------------------------------------------

describe('TradeProposeView PTC2-9: Enter=submit / Escape=hide on currency inputs', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('BITES: Escape on offer-currency input hides the overlay — kills missing-Escape impl', async () => {
    const view = new TradeProposeView(noop());
    view.show();
    expect(view.visible).toBe(true);
    const input = document.getElementById('tradepropose-offer-currency') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    await flushPromises();
    expect(view.visible).toBe(false);
  });

  it('BITES: Escape on request-currency input hides the overlay — kills missing-Escape impl', async () => {
    const view = new TradeProposeView(noop());
    view.show();
    const input = document.getElementById('tradepropose-request-currency') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    await flushPromises();
    expect(view.visible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PTC2-10: live submit-enable on input/change listeners
// ---------------------------------------------------------------------------

describe('TradeProposeView PTC2-10: live submit-enable recomputes on input/change', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('★ BITES: typing a valid offer currency enables submit when target is selected — kills static-disable impl', () => {
    // ADR-0134 D6: "live submit-enable via input/change listeners recomputing buildProposeSubmission".
    // WRONG IMPL KILLED: a view whose submit-disabled state is only set by render() on open
    // (empty draft → disabled) and never re-evaluated as the user types.
    // Real browsers do not fire click on a disabled button, so the overlay would be unusable.
    const view = new TradeProposeView(noop());
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    view.show();

    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    const offerInput = document.getElementById('tradepropose-offer-currency') as HTMLInputElement;
    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;

    // Select a target
    select.value = '0xaaa1';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    // Type a valid currency amount
    offerInput.value = '100';
    offerInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(btn.disabled, 'submit must be ENABLED when target selected + currency entered').toBe(
      false,
    );
  });

  it('★ BITES: clearing currency when no monster selected disables submit — kills no-disable impl', () => {
    const view = new TradeProposeView(noop());
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    view.show();

    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    const offerInput = document.getElementById('tradepropose-offer-currency') as HTMLInputElement;
    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;

    // Select target + type currency → enabled
    select.value = '0xaaa1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    offerInput.value = '50';
    offerInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.disabled).toBe(false);

    // Clear currency → should disable again (no monster, no currency)
    offerInput.value = '';
    offerInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn.disabled, 'submit must be DISABLED when currency cleared and no monster').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PTC2-11: show() deferred focus; hide() resets draft/feedback/#pending
// ---------------------------------------------------------------------------

describe('TradeProposeView PTC2-11: hide() resets select, checkboxes, currencies, feedback, #pending', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('BITES: hide() clears feedback textContent — kills impl that leaves stale feedback on re-open', () => {
    const view = new TradeProposeView(noop());
    view.show();
    view.showFeedback('Offer rejected!');
    view.hide();
    const fb = document.getElementById('tradepropose-feedback') as HTMLElement;
    expect(fb.textContent).toBe('');
  });

  it('BITES: hide() blanks offer currency input — kills impl that leaves stale draft', () => {
    const view = new TradeProposeView(noop());
    view.show();
    const input = document.getElementById('tradepropose-offer-currency') as HTMLInputElement;
    input.value = '999';
    view.hide();
    expect(input.value).toBe('');
  });

  it('BITES: hide() blanks request currency input — kills impl that leaves stale draft', () => {
    const view = new TradeProposeView(noop());
    view.show();
    const input = document.getElementById('tradepropose-request-currency') as HTMLInputElement;
    input.value = '50';
    view.hide();
    expect(input.value).toBe('');
  });

  it('BITES: hide() unchecks all monster checkboxes — kills impl that leaves stale selections', () => {
    const view = new TradeProposeView(noop());
    view.render(makeLists([], [{ monsterId: 5n, label: 'Sparky Lv.3' }]));
    view.show();
    const container = document.getElementById('tradepropose-monsters') as HTMLElement;
    const cb = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    cb.checked = true;
    view.hide();
    // After hide, checkbox must be unchecked
    const cbAfter = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    if (cbAfter) {
      expect(cbAfter.checked).toBe(false);
    }
    // (If the container is cleared, that also satisfies the invariant — no checked boxes remain)
    const checkedBoxes = container.querySelectorAll('input[type="checkbox"]:checked');
    expect(checkedBoxes).toHaveLength(0);
  });

  it('★ BITES: hide() while in-flight resets #pending lock — later submit fires again (dead-button guard, ADR-0085 C6)', async () => {
    // ADR-0134 D6: "hide() ... releases the in-flight lock (#pending=false, submit re-enabled —
    // dead-button guard, ADR-0085 C6). [...] the SDK never settles an in-flight reducer promise
    // after a link drop — so .finally() may never run."
    // WRONG IMPL KILLED: a hide() that does not reset #pending — onReconnect/battle force-hide
    // leaves #pending=true forever → dead submit button.
    const view = new TradeProposeView(noop());
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    view.show();

    let resolveFirst: (() => void) | undefined;
    const onSubmit = vi.fn().mockImplementation(
      (_args: TradeProposeArgs) =>
        new Promise<void>((res) => {
          resolveFirst = res;
        }),
    );
    const viewWithSubmit = new TradeProposeView({ onSubmit });
    viewWithSubmit.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    viewWithSubmit.show();

    // Set a valid state so submit fires
    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    const offerInput = document.getElementById('tradepropose-offer-currency') as HTMLInputElement;
    select.value = '0xaaa1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    offerInput.value = '100';
    offerInput.dispatchEvent(new Event('input', { bubbles: true }));

    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;
    btn.click(); // first submit — #pending=true, promise never settles

    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Force-hide while in-flight (reconnect / battle auto-show path)
    viewWithSubmit.hide();

    // Re-open and try a new submit: hide() must have reset #pending
    viewWithSubmit.show();
    viewWithSubmit.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    select.value = '0xaaa1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    offerInput.value = '50';
    offerInput.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();

    expect(
      onSubmit,
      'hide() must reset #pending so a post-hide submit can fire',
    ).toHaveBeenCalledTimes(2);

    resolveFirst?.();
    await flushPromises();
  });

  it('BITES: hide() re-enables submit button — kills impl that leaves button permanently disabled after hide', () => {
    // Dead-button guard: if hide() doesn't re-enable, the button stays disabled on re-open.
    const view = new TradeProposeView(noop());
    view.show();
    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;
    btn.disabled = true; // simulate disabled state
    view.hide();
    // After hide, button must be re-enabled (so user can submit on next open)
    expect(btn.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PTC2-12: single #submit() #pending lock + finally-reset + catch
// ---------------------------------------------------------------------------

describe('★ TradeProposeView PTC2-12: #pending lock — two rapid clicks → onSubmit called once', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('★ BITES: two rapid submit clicks before first promise resolves → onSubmit called exactly once', async () => {
    // WRONG IMPL KILLED: an impl without #pending lock — second click fires another reducer call.
    let resolveFlight: (() => void) | undefined;
    const flightPromise = new Promise<void>((res) => {
      resolveFlight = res;
    });
    const onSubmit = vi.fn().mockReturnValue(flightPromise);
    const view = new TradeProposeView({ onSubmit });
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    view.show();

    // Set valid state
    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    const offerInput = document.getElementById('tradepropose-offer-currency') as HTMLInputElement;
    select.value = '0xaaa1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    offerInput.value = '100';
    offerInput.dispatchEvent(new Event('input', { bubbles: true }));

    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;
    btn.click(); // first submit
    btn.click(); // second click — must be a no-op (#pending)
    btn.click(); // third click — also no-op

    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    resolveFlight?.();
    await flushPromises();
  });

  it('★ BITES: rejecting onSubmit re-enables submit button (.finally() reset — no dead-button-forever)', async () => {
    // WRONG IMPL KILLED: an impl using .then(reset) only — when onSubmit rejects, .then
    // is skipped and the button stays disabled forever (ADR-0085 C6 dead-button antipattern).
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSubmit = vi.fn().mockRejectedValue(new Error('server rejected'));
    const view = new TradeProposeView({ onSubmit });
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    view.show();

    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    const offerInput = document.getElementById('tradepropose-offer-currency') as HTMLInputElement;
    select.value = '0xaaa1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    offerInput.value = '100';
    offerInput.dispatchEvent(new Event('input', { bubbles: true }));

    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;
    btn.click();

    await flushPromises();

    // .finally() must have re-enabled the button even on rejection
    expect(btn.disabled, 'submit must be re-enabled after rejection via .finally()').toBe(false);

    consoleSpy.mockRestore();
  });

  it('★ BITES: rejecting onSubmit does NOT produce an unhandled rejection — kills impl without .catch()', async () => {
    // WRONG IMPL KILLED: an impl that does `await onSubmit(args)` without try/catch, or
    // `Promise.resolve(onSubmit(args)).then(reset)` without .catch() — a rejection would
    // produce an unhandledrejection event that vitest reports as a test failure even when
    // all assertions pass.
    // PROOF-OF-TEETH: if this test itself fails (vitest caught unhandled rejection), the
    // impl is missing the .catch(swallow) guard.
    const onSubmit = vi.fn().mockRejectedValue(new Error('network error'));
    const view = new TradeProposeView({ onSubmit });
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    view.show();

    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    const offerInput = document.getElementById('tradepropose-offer-currency') as HTMLInputElement;
    select.value = '0xaaa1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    offerInput.value = '10';
    offerInput.dispatchEvent(new Event('input', { bubbles: true }));

    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;

    // Suppress console.error for this test (the view may log the swallowed rejection)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    btn.click();
    // Allow all microtasks to drain — the rejection + .finally() + .catch() must all settle.
    await flushPromises();
    // If we reach here without vitest reporting an unhandled rejection, the .catch() is present.
    expect(onSubmit).toHaveBeenCalledOnce();

    consoleSpy.mockRestore();
  });

  it('BITES: submit is a no-op when canSubmit is false — onSubmit NOT called', async () => {
    // WRONG IMPL KILLED: an impl that calls onSubmit even when canSubmit=false (empty offer).
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new TradeProposeView({ onSubmit });
    // Render with a target but empty draft → canSubmit=false
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    view.show();

    // Do NOT select a target or enter currency — draft remains empty
    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;
    btn.click(); // Should be a no-op
    await flushPromises();

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ★ Source-scan: tradeProposeView.ts must not use innerHTML with data (XSS firewall)
// ADR-0134 D6: "textContent/option.textContent/value ONLY, NEVER innerHTML".
// ---------------------------------------------------------------------------

describe('★ tradeProposeView.ts source scan: no .innerHTML assignment with data', () => {
  it('★ BITES: tradeProposeView.ts source must not contain ".innerHTML =" — kills innerHTML-with-data impl', () => {
    // WRONG IMPL KILLED: an impl that sets container.innerHTML = ... to build monster
    // checkbox rows — player-controlled nicknames would be injected as HTML (XSS).
    // ADR-0134 D6: the dynamic checkbox-label path is the specific risk site.
    // Uses .includes() — no new RegExp() (ReDoS ban).
    const viewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tradeProposeView.ts');
    let src: string;
    try {
      src = readFileSync(viewPath, 'utf8');
    } catch (err) {
      // File must exist post-impl; fail loud (vacuous-revival-gate precedent).
      throw new Error(
        'tradeProposeView.ts could not be read — post-impl the file must exist: ' + String(err),
      );
    }
    expect(
      src.includes('.innerHTML ='),
      'tradeProposeView.ts must not contain ".innerHTML =" — player-controlled names/nicknames ' +
        'must only be written via textContent or option.textContent/value (RT-XSS, ADR-0134 D6)',
    ).toBe(false);
  });
});
