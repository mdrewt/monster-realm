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
//   PTC2-11: hide()=reset draft/feedback/#pending                     → hide-reset tests
//            (CORRECTED 2026-08-24, m23-s3: this line used to read "show()=deferred focus;
//            hide()=…". show() NO LONGER defers focus itself — ui/tradeProposeView.ts:124's
//            `setTimeout(() => this.#target.focus(), 0)` is DELETED by this slice and the defer is
//            owned SOLELY by ui/overlayA11y.ts:111-113. This file never asserted the old behaviour
//            (plan F8), so only the prose was wrong. The replacement contract is pinned by
//            S3-tradeProposeView-DEFER-FOCUS below and, repo-wide, by S3-NO-VIEW-LOCAL-FOCUS in
//            ui/renameView.test.ts.)
//   PTC2-12: single #submit() #pending lock + finally-reset + catch   → lock + finally tests
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.
// Corrections must be traced to the spec and must not weaken the bite.
//
// ---------------------------------------------------------------------------
// m23-s3 ADDITION (2026-08-24) — overlay a11y wiring. ADDITIVE ONLY: nothing above was weakened
// or deleted; the mount helper gained the `role`/`aria-modal` attributes client/index.html:64 has
// always shipped, a file-level a11y sweep was added, and the two stale PTC2-11 prose lines
// (this list and the §PTC2-11 banner further down) were corrected.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/15/16);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1/F2/F7/F8, §1 D1/D2/D7/D8, §2 T6, §4,
//   §7 A1/A3/A6/A7/A8/A13; memory/projects/gates/m23-s3.gates.md X1/X2/X3/X6/X8; ADR-0205 D1-D4, A3.
//
// RED REASON (m23-s3): `client/src/ui/tradeProposeView.ts` DOES NOT CALL
// openOverlayA11y/closeOverlayA11y at all today (ui/tradeProposeView.ts:121-125), so every S3-*
// test below fails now. As with renameView, this view ALREADY defers its own focus, so
// S3-tradeProposeView-DEFER-FOCUS additionally asserts the open helper was CALLED — the two focus
// polarities alone are GREEN on the unwired code and would prove nothing.
//
// TWO ORACLES, BOTH REQUIRED (plan A3, measured by red-team):
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['tradeProposeView'].labelKey)`.
//     `role`/`aria-modal` are ALREADY static literals on the shell in client/index.html:64
//     (m23-s2), so asserting them ALONE is VACUOUS: a view that calls nothing passes. They are
//     asserted only alongside aria-label, and their ABSENCE after close is the partner (attack V1).
//   * MECHANISM oracle — `vi.mock('./overlayA11y', { spy: true })` records the calls AND calls
//     through to the real implementation, so a cheat that hand-writes the three attributes with the
//     correct copied literal (no trap, no return-focus record, no timer) still reds.
//
// WHY THE m23-s3 BLOCK IS DECLARED FIRST IN THIS FILE: several describes below call
// `vi.restoreAllMocks()` in their afterEach. Declaration order is execution order in vitest, so the
// S3 block runs before any of them and its module-level auto-spy cannot be torn down underneath it.
//
// TEST-ISOLATION DEVICE (plan A8 / V7, copied from ui/overlayA11y.test.ts:97-105): overlayA11y.ts
// holds ONE module-private Map and exports no reset hook, so the file-level beforeEach/afterEach
// call the PRODUCTION closeOverlayA11y(id, null) for every OverlayId and flush ONE REAL MACROTASK
// — legal because close-without-open is a documented no-op (ui/overlayA11y.ts:41-45). It also
// cancels the deferred-focus timer that every `view.show()` in this file schedules (plan residual
// A12). `vi.clearAllMocks()` runs LAST so the sweep never pollutes a count.
//
// m23-s3 WRONG-IMPL-KILLED index:
//   - never opens / attribute-only cheat                 -> S3-tradeProposeView-OPEN-ARIA + -HELPER-CALLED
//   - copy-pasted WRONG OverlayId                        -> S3-tradeProposeView-OPEN-ARIA (label) + -HELPER-CALLED (id arg)
//   - view keeps its OWN setTimeout focus (:124 not deleted) -> S3-tradeProposeView-DEFER-FOCUS (call assertion)
//                                                             + S3-NO-VIEW-LOCAL-FOCUS (renameView.test.ts)
//   - synchronous focus (no defer)                       -> S3-tradeProposeView-DEFER-FOCUS (negative polarity)
//   - focuses nothing / a wrapper, not the anchor         -> S3-tradeProposeView-DEFER-FOCUS (identity)
//   - close never strips ARIA / never restores focus      -> S3-tradeProposeView-CLOSE-RESTORE
//   - UNGUARDED show() / `this.visible` read AFTER the write -> S3-tradeProposeView-REPEAT-NO-REOPEN
//   - `fallbackFocus` passed as undefined/an element       -> S3-tradeProposeView-HELPER-CALLED (literal null)
//   - GUARDED close in hide() (plan anti-pattern #3 — kills S1's A13 self-heal)
//                                                        -> S3-tradeProposeView-CLOSE-UNGUARDED

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import type { TradeProposeArgs, TradeProposeLists } from './tradeProposeModel';
import { type TradeProposeCallbacks, TradeProposeView } from './tradeProposeView';

// The m23-s3 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works.
vi.mock('./overlayA11y', { spy: true });

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
  // m23-s3 FIXTURE FIDELITY (index.html:64): `role`/`aria-modal` have shipped as STATIC LITERALS
  // on this shell since m23-s2. They are copied here NOT to be asserted on their own — that is
  // vacuous, a view calling nothing passes — but so that "all three attributes ABSENT after close"
  // is a real tooth: only closeOverlayA11y can remove them (ui/overlayA11y.ts:142-144). No
  // `tabindex` is added: this overlay's OVERLAY_A11Y anchor is the #tradepropose-target <select>,
  // natively focusable, exactly as index.html:65 has it.
  document.body.innerHTML = `
    <div id="tradepropose-overlay" role="dialog" aria-modal="true" style="display:none">
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
// m23-s3 — overlay a11y wiring on the show()/hide() edge.
// Declared FIRST on purpose (see the file header): later describes call vi.restoreAllMocks().
// ---------------------------------------------------------------------------

/** m23-s3: one REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0),
 *  and fake timers are banned for this defer (plan anti-pattern #10). */
async function s3FlushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// m23-s3: NEW file-level isolation hooks. They run BEFORE the describe-level
// `mountTradeProposeOverlay` hooks below, so every test still gets the DOM it always got.
beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s3FlushMacrotask();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s3FlushMacrotask();
});

const S3_ID: OverlayId = 'tradeProposeView';
const S3_META = OVERLAY_A11Y[S3_ID];

/** A focusable OUTSIDE the overlay: the "pre-overlay" element a close must restore focus to. */
function s3OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root — render() only rebuilds
 *  #tradepropose-target / #tradepropose-monsters, so if this loses focus something RE-OPENED
 *  the overlay. */
function s3InsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

describe('TradeProposeView — overlay a11y wiring on the show/hide edge (m23-s3)', () => {
  it('S3-tradeProposeView-OPEN-ARIA BITES: the first show() from a display:none shell labels the root from OVERLAY_A11Y/t()', () => {
    const { overlay } = mountTradeProposeOverlay();
    const view = new TradeProposeView(noop());

    // VACUITY ATTACK V4, closed here: without `display:none` the FIRST show() is a NO-EDGE and
    // every open assertion below is silently vacuous. This also pins WIK-3 — an impl that reads
    // `this.visible` AFTER writing `style.display` sees a constant `true` and never opens.
    expect(view.visible, 'V4: the shell must start hidden, so the first show() IS an edge').toBe(
      false,
    );

    view.show();

    // Every expectation is DERIVED from the table at assert time — never a literal (V5).
    expect(overlay.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S3_META.role);
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(
      overlay.getAttribute('aria-label'),
      'THE tooth: role/aria-modal are static literals in index.html:64 and pass a view that calls ' +
        'nothing; aria-label is absent from every shell, so only a real open can produce it — and ' +
        'because all 16 catalog values are distinct, this also kills the wrong-OverlayId impl',
    ).toBe(t(S3_META.labelKey));
  });

  it('S3-tradeProposeView-DEFER-FOCUS BITES: both polarities — NOT focused synchronously, focused after ONE real macrotask, and the defer is owned by openOverlayA11y (NOT by tradeProposeView.ts:124)', async () => {
    const { overlay } = mountTradeProposeOverlay();
    const target = overlay.querySelector<HTMLElement>(S3_META.initialFocusSelector);
    expect(target, `the fixture must contain ${S3_META.initialFocusSelector}`).not.toBeNull();
    const view = new TradeProposeView(noop());

    view.show();

    // NEGATIVE polarity — a synchronous focus reintroduces the bug the defer exists to avoid
    // (ui/overlayA11y.ts:9-15): the key that OPENED the overlay lands in what it just opened.
    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );

    // LOAD-BEARING for THIS view specifically: tradeProposeView.ts:124 ALREADY defers its own
    // focus, so the two polarities alone are GREEN on the unwired code and prove nothing. Only this
    // call assertion shows the defer moved into overlayA11y.ts (A11Y-15 / plan T6's deletion).
    expect(
      vi.mocked(openOverlayA11y),
      'the deferred focus must be scheduled by openOverlayA11y, not by tradeProposeView.ts:124',
    ).toHaveBeenCalledTimes(1);

    await s3FlushMacrotask();

    // POSITIVE polarity, by IDENTITY — never `root.contains(activeElement)`.
    expect(document.activeElement).toBe(target);
  });

  it('S3-tradeProposeView-CLOSE-RESTORE BITES: hide() strips role, aria-modal AND aria-label from the root and hands focus back to the pre-overlay element', async () => {
    const { overlay } = mountTradeProposeOverlay();
    const outside = s3OutsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const view = new TradeProposeView(noop());
    view.show();
    await s3FlushMacrotask();
    expect(
      document.activeElement,
      'precondition: the open moved focus INTO the overlay, so the restore below is a real move',
    ).not.toBe(outside);

    view.hide();

    // VACUITY ATTACK V1: the two static literals can only be ABSENT if closeOverlayA11y really ran.
    expect(
      overlay.getAttribute('role'),
      'a display:none node must not keep claiming to be a dialog',
    ).toBeNull();
    expect(overlay.getAttribute('aria-modal')).toBeNull();
    expect(overlay.getAttribute('aria-label')).toBeNull();

    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
  });

  it('S3-tradeProposeView-REPEAT-NO-REOPEN BITES: show() on an ALREADY-visible overlay neither re-opens nor yanks focus back', async () => {
    // A re-open clears and re-schedules the deferred-focus timer (ui/overlayA11y.ts:100-113).
    // On THIS view the focus half is red today for a second reason too: tradeProposeView.ts:124's
    // own setTimeout fires on every show() and drags focus back to #tradepropose-target.
    const { overlay } = mountTradeProposeOverlay();
    const view = new TradeProposeView(noop());

    view.show();
    await s3FlushMacrotask();

    const inside = s3InsideSentinel(overlay);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.show();
    await s3FlushMacrotask();

    expect(document.activeElement, 'a repeat show() must NOT re-run the deferred focus').toBe(
      inside,
    );
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S3-tradeProposeView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    // THE MECHANISM ORACLE (plan A3): a view that hand-writes the three attributes with the correct
    // copied literal passes every VALUE assertion here while shipping NO trap, NO return-focus
    // record and NO timer. The literal `null` pins ADR-0205 A3 / plan D8. This test also executes
    // BOTH new branches, which matters because this file is in the coverage denominator (R5).
    const { overlay } = mountTradeProposeOverlay();
    const view = new TradeProposeView(noop());

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S3_ID, overlay);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);
  });

  it('S3-tradeProposeView-CLOSE-UNGUARDED BITES: hide() calls the close UNCONDITIONALLY — on a never-opened view, and again on every repeat', () => {
    // Plan D2's deliberate asymmetry, and plan ANTI-PATTERN #3. Measured by red-team: wrapping
    // hide()'s close in `if (wasVisible)` ships with every other gate green. A guarded hide() reads
    // `visible === false` and SKIPS the close whenever a record ever desynchronised from the DOM
    // (S1's named A13 leak, ui/overlayA11y.ts:55-59) — making a live capture listener, a pending
    // timer and a stale return target PERMANENT. This view is in BATTLE_FORCE_HIDE
    // (ui/overlayRegistry.ts:274-283) AND is force-hidden on reconnect, so main.ts drives its close
    // through exactly the desync D2 cites — and it owns four focusable form controls, so a leaked
    // capture trap here is user-visible. Unguarded, hide() HEALS it, and a close with no record is
    // a documented pure no-op (ui/overlayA11y.ts:136-137), so nothing is risked.
    mountTradeProposeOverlay();
    const view = new TradeProposeView(noop());
    expect(view.visible, 'precondition: never opened').toBe(false);

    expect(() => view.hide()).not.toThrow();
    expect(
      vi.mocked(closeOverlayA11y),
      'hide() on a never-opened view MUST still call the close — a guarded hide calls it zero times',
    ).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);

    view.hide();
    expect(
      vi.mocked(closeOverlayA11y),
      'unguarded means unguarded: every hide() calls the close',
    ).toHaveBeenCalledTimes(2);

    // And the same holds after a real open/close cycle: the second hide() still calls it.
    vi.clearAllMocks();
    view.show();
    view.hide();
    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });
});

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
// PTC2-11: hide() resets draft/feedback/#pending
//
// CORRECTED 2026-08-24 (m23-s3): this banner used to say "show() deferred focus; hide() resets…".
// show() no longer owns a deferred focus — ui/tradeProposeView.ts:124's
// `setTimeout(() => this.#target.focus(), 0)` is DELETED by slice m23-s3 and the ONE defer now
// lives in ui/overlayA11y.ts:111-113, scheduled by openOverlayA11y (M23 §2.2, A11Y-14/A11Y-15,
// ADR-0205 D1/D2). No test in this describe ever asserted the old behaviour (plan F8), so nothing
// below changed — only the prose was stale. The replacement contract is pinned by
// S3-tradeProposeView-DEFER-FOCUS above and, repo-wide, by S3-NO-VIEW-LOCAL-FOCUS in
// ui/renameView.test.ts. Net user-visible change (plan A13, verified): identical initial focus,
// PLUS a Tab trap and return-focus restoration.
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
