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
// ctl-8e: the wizard's own strings come from the i18n resolver (the file's `t` above is a11yCopy's).
import { t as i18nT, tf as i18nTf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import { proposeSteps, type TradeProposeArgs, type TradeProposeLists } from './tradeProposeModel';
import {
  type TradeProposeCallbacks,
  type TradeProposePaint,
  TradeProposeView,
} from './tradeProposeView';

// The m23-s3 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works.
vi.mock('./overlayA11y', { spy: true });

// ---------------------------------------------------------------------------
// DOM mount helper — installs the index.html shell for tradeProposeView.
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
  // m23-s3 FIXTURE FIDELITY: `role`/`aria-modal` have shipped as STATIC LITERALS
  // on this shell since m23-s2. They are copied here NOT to be asserted on their own — that is
  // vacuous, a view calling nothing passes — but so that "all three attributes ABSENT after close"
  // is a real tooth: only closeOverlayA11y can remove them. No
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
  return { onSubmit: async (_args: TradeProposeArgs) => {}, maxMonstersPerSide: 64 };
}

// ---------------------------------------------------------------------------
// Overlay a11y wiring on the show()/hide() edge.
// Declared FIRST on purpose (see the file header): later describes call vi.restoreAllMocks().
// ---------------------------------------------------------------------------

/** One REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0),
 *  and fake timers are banned for this defer (plan anti-pattern #10). */
async function s3FlushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// NEW file-level isolation hooks. They run BEFORE the describe-level
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

    // NEGATIVE polarity — a synchronous focus reintroduces the bug the defer exists to avoid:
    // the key that OPENED the overlay lands in what it just opened.
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
    // A re-open clears and re-schedules the deferred-focus timer.
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
    // AND is force-hidden on reconnect, so main.ts drives its close
    // through exactly the desync D2 cites — and it owns four focusable form controls, so a leaked
    // capture trap here is user-visible. Unguarded, hide() HEALS it, and a close with no record is
    // a documented pure no-op, so nothing is risked.
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
// render() — paints <select> options and monster checkboxes via textContent
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
    // `<input type=checkbox>` carries monsterId in `value` AND `data-monster-id`.
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
    // "Player-controlled name/nickname → textContent/option.textContent/value ONLY,
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
    // The dynamic checkbox-label path is the specific risk site for XSS.
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
    // "set submit disabled from a fresh buildProposeSubmission".
    // After render with no pre-selected target, the submit must be disabled.
    const view = new TradeProposeView(noop());
    view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;
    // No selection = no valid target → canSubmit:false → disabled:true
    expect(btn.disabled).toBe(true);
  });

  it('BITES: render() rebuilds monster checkboxes on successive calls (stale-monster guard)', () => {
    // "show() ... REBUILDS the monster-checkbox container from the current
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
// stopPropagation on EVERY focusable
// Proof-of-teeth: a keydown on each focusable MUST NOT reach window keydown listener.
// ---------------------------------------------------------------------------

describe('★★ TradeProposeView PTC2-9: stopPropagation on every focusable — kills movement-bleed impl', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('★★ BITES: keydown on target <select> does NOT reach window — kills missing-stopProp impl (arrow bleed)', () => {
    // "stopPropagation on the `keydown` of the target <select>".
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
    // stopPropagation on EACH monster checkbox.
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
    // stopPropagation on BOTH currency inputs.
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
    // stopPropagation on BOTH currency inputs.
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
    // stopPropagation on the submit <button>.
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
// Enter and Escape local handling on currency inputs
// ---------------------------------------------------------------------------

describe('TradeProposeView PTC2-9: Escape and Enter on the currency inputs belong to the router', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  // INTENTIONAL CHANGE (ctl-8e, CTL8E.1 / CTL6B.5): was "Escape on the offer / request input hides
  // the overlay" (the input's own Escape listener) and "Enter submits". Now the currency inputs
  // hold neither: main.ts routes Escape in the CAPTURE phase (it stops typing, then the next Escape
  // is Start) and Enter reaches the router as A, which steps the wizard. Pinned the other way round:
  // Escape leaves the overlay open and reaches the window, Enter sends nothing.
  for (const [id, label] of [
    ['tradepropose-offer-currency', 'offer'],
    ['tradepropose-request-currency', 'request'],
  ] as const) {
    it(`CTL8E-1-VIEW-KEYS: Escape on the ${label}-currency input no longer hides the overlay on its own (the router owns it) and still reaches the window`, async () => {
      // WRONG IMPL KILLED: the pre-ctl-8e local `else if (e.code === 'Escape') this.hide()` (it would
      // close the overlay under the router's typing-mode rule, losing the draft the rule keeps), and
      // a blanket stopPropagation (the window would never see the Escape that stops typing).
      const view = new TradeProposeView(noop());
      view.show();
      expect(view.visible).toBe(true);
      const spy = vi.fn();
      window.addEventListener('keydown', spy);
      const input = document.getElementById(id) as HTMLInputElement;
      input.value = '25';
      input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
      await flushPromises();
      window.removeEventListener('keydown', spy);
      expect(view.visible, 'Escape must not hide the overlay from the field').toBe(true);
      expect(input.value, 'and the typed text is kept').toBe('25');
      expect(spy, 'Escape reaches the window listeners').toHaveBeenCalledTimes(1);
    });

    it(`CTL8E-1-VIEW-KEYS: Enter on the ${label}-currency input no longer submits (it is the router's A) and still reaches the window`, async () => {
      // WRONG IMPL KILLED: the pre-ctl-8e `if (e.code === 'Enter') this.#submit()` (an Enter on Coins
      // would send the half-built draft instead of stepping to Ask), and a blanket stopPropagation
      // (the router would never see the A that steps the wizard).
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const view = new TradeProposeView({ onSubmit, maxMonstersPerSide: 64 });
      view.render(makeLists([{ identity: '0xaaa1', label: 'Alice' }], []));
      view.show();
      const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
      select.value = '0xaaa1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.getElementById(id) as HTMLInputElement;
      input.value = '100';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const spy = vi.fn();
      window.addEventListener('keydown', spy);
      for (const code of ['Enter', 'NumpadEnter']) {
        input.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      }
      await flushPromises();
      window.removeEventListener('keydown', spy);
      expect(
        onSubmit,
        'a complete draft, but Enter in the field sends nothing',
      ).not.toHaveBeenCalled();
      expect(spy, 'both Enter keys reach the window listeners').toHaveBeenCalledTimes(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Live submit-enable on input/change listeners
// ---------------------------------------------------------------------------

describe('TradeProposeView PTC2-10: live submit-enable recomputes on input/change', () => {
  beforeEach(() => mountTradeProposeOverlay());
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('★ BITES: typing a valid offer currency enables submit when target is selected — kills static-disable impl', () => {
    // "live submit-enable via input/change listeners recomputing buildProposeSubmission".
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

  it('★ BITES: the view gates on the INJECTED maxMonstersPerSide — kills a view that drops the option', () => {
    // main.ts injects game-core's cap (the max_trade_monsters_per_side() wasm export). With
    // an injected cap of 1, a second ticked monster must veto submission. WRONG IMPL
    // KILLED: a view passing a literal/undefined cap to buildProposeSubmission (a literal
    // 64 keeps 2 monsters legal; `n <= undefined` is always false and disables row 1 too).
    const view = new TradeProposeView({ ...noop(), maxMonstersPerSide: 1 });
    view.render(
      makeLists(
        [{ identity: '0xaaa1', label: 'Alice' }],
        [
          { monsterId: 1n, label: 'One' },
          { monsterId: 2n, label: 'Two' },
        ],
      ),
    );
    view.show();
    const select = document.getElementById('tradepropose-target') as HTMLSelectElement;
    const btn = document.getElementById('tradepropose-submit') as HTMLButtonElement;
    const boxes = Array.from(
      document.querySelectorAll('#tradepropose-monsters input[type="checkbox"]'),
    ) as HTMLInputElement[];
    select.value = '0xaaa1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
    expect(btn.disabled, 'one monster is at the injected cap → enabled').toBe(false);
    boxes[1].checked = true;
    boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
    expect(btn.disabled, 'two monsters exceed the injected cap of 1 → disabled').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hide() resets draft/feedback/#pending
//
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
    // "hide() ... releases the in-flight lock (#pending=false, submit re-enabled —
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
    const viewWithSubmit = new TradeProposeView({ onSubmit, maxMonstersPerSide: 64 });
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
// Single #submit() #pending lock + finally-reset + catch
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
    const view = new TradeProposeView({ onSubmit, maxMonstersPerSide: 64 });
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
    const view = new TradeProposeView({ onSubmit, maxMonstersPerSide: 64 });
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
    const view = new TradeProposeView({ onSubmit, maxMonstersPerSide: 64 });
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
    const view = new TradeProposeView({ onSubmit, maxMonstersPerSide: 64 });
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

// ===========================================================================================
// ctl-10b (CTL10B.1): the wizard opened face to face carries its target.
// ===========================================================================================

describe('TradeProposeView ctl-10b: a pre-filled target (CTL10B.1)', () => {
  afterEach(() => {
    teardown();
  });

  it('CTL10B-1-VIEW-PREFILL: render(lists, target) pre-selects the target, DISABLES the select and paints a header with no Target step (and a paint keeps all three); render(lists) after it is enabled, on the placeholder, with the full five-step header; the pre-filled target is what a submit sends', async () => {
    // WRONG IMPL KILLED: a render that ignores its second argument (the wizard would ask for a
    // counterparty already chosen); one that pre-selects but leaves the select ENABLED (a mouse or
    // Tab press retargets the trade to someone not faced: red-team #1); one that disables it but
    // leaves the Target step in the header; a paint that rebuilds the select and drops the value or
    // the lock; a lock that survives into the next unsupplied render (a dead, empty select); a
    // render(lists) that keeps the previous target; and a pre-selected target that is not what
    // submit sends.
    mountTradeProposeOverlay();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const view = new TradeProposeView({ onSubmit, maxMonstersPerSide: 64 });

    view.render(WIZ_LISTS, WIZ_BOB.identity);
    expect(wizSelect().value, 'the target is pre-selected').toBe(WIZ_BOB.identity);
    expect(wizSelect().disabled, 'the select is locked').toBe(true);
    expect(headerSteps(), 'no Target step in the header').toEqual(proposeSteps(true));
    expect(headerSteps()).not.toContain('target');

    view.show();
    view.paint(wizPaint({ steps: proposeSteps(true), step: 'offer' }));
    expect(wizSelect().value, 'a paint keeps the target').toBe(WIZ_BOB.identity);
    expect(wizSelect().disabled, 'a paint keeps the lock').toBe(true);
    expect(headerSteps()).toEqual(proposeSteps(true));

    // What is sent is the pre-filled target.
    userCheck(12, true);
    wizSubmit().click();
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      targetIdentity: WIZ_BOB.identity,
      initiatorMonsterIds: [12n],
      initiatorCurrency: 0n,
      counterpartyCurrency: 0n,
    });

    // The next unsupplied render: enabled, placeholder, five steps.
    view.render(WIZ_LISTS);
    expect(wizSelect().disabled, 'an unsupplied render unlocks the select').toBe(false);
    expect(wizSelect().value, 'and is back on the placeholder').toBe('');
    expect(headerSteps()).toEqual(proposeSteps(false));

    // hide() then an unsupplied render is unlocked too.
    view.render(WIZ_LISTS, WIZ_ALICE.identity);
    expect(wizSelect().value).toBe(WIZ_ALICE.identity);
    view.hide();
    view.render(WIZ_LISTS);
    expect(wizSelect().disabled).toBe(false);
    expect(wizSelect().value).toBe('');
    expect(headerSteps()).toEqual(proposeSteps(false));

    // A plain render(lists) on a fresh view is the legacy shape: enabled, placeholder.
    mountTradeProposeOverlay();
    const plain = new TradeProposeView(noop());
    plain.render(WIZ_LISTS);
    expect(wizSelect().disabled).toBe(false);
    expect(wizSelect().value).toBe('');
    expect(headerSteps()).toEqual(proposeSteps(false));
  });
});

// ===========================================================================================
// ctl-8e (CTL8E.1, defect B5): the trade-propose wizard's view.
//
// `paint(p)` is how the converted screen drives this view (screens/tradeProposeScreen.ts). The
// DOM stays the ONE draft: the target is the select's value, the offer is the checked boxes, the
// coins are the two fields. The screen holds only the step, the cursors and two ONE-SHOT TOKENS
// (toggle, commit) that the view applies to the DOM, compared by object identity. So what is on
// screen is exactly what is sent, and the mouse and the D-pad compose with no divergence.
//
// Paint order (the plan's adjudication): a commit token not seen before is remembered FIRST; the
// select and the boxes are rebuilt from `p.lists` PRESERVING the DOM draft; a toggle token not seen
// before flips its box once; the header, cursor mark and review row follow; focus moves ONLY when
// the step changed; the submit button is refreshed from the DOM draft; and the new commit token
// runs the existing submit path once.
// ===========================================================================================

const WIZ_ALICE = { identity: '0xaaa1', label: 'Alice' };
const WIZ_BOB = { identity: '0xbbb2', label: 'Bob' };
const WIZ_CY = { identity: '0xccc3', label: 'Cy' };
const WIZ_LISTS: TradeProposeLists = makeLists(
  [WIZ_ALICE, WIZ_BOB],
  [
    { monsterId: 5n, label: 'Sparky Lv.3' },
    { monsterId: 12n, label: 'Flame Lv.1' },
    { monsterId: 30n, label: 'Third Lv.2' },
  ],
);

/** A paint on the Target step with the cursor on monster 5, overridden per case. */
function wizPaint(over: Partial<TradeProposePaint> = {}): TradeProposePaint {
  return {
    steps: proposeSteps(false),
    step: 'target',
    lists: WIZ_LISTS,
    offerCursor: '5',
    yes: true,
    toggle: null,
    commit: null,
    ...over,
  };
}

/** A NEW commit token each call (the view compares tokens by identity). */
const newCommit = (): { readonly kind: 'commit' } => ({ kind: 'commit' });

const wizEl = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return el;
};
const wizTest = (testId: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`[data-testid="${testId}"] is not in the document`);
  return el;
};
const wizSelect = (): HTMLSelectElement => wizEl('tradepropose-target') as HTMLSelectElement;
const wizMonsters = (): HTMLElement => wizEl('tradepropose-monsters');
const wizOffer = (): HTMLInputElement => wizEl('tradepropose-offer-currency') as HTMLInputElement;
const wizRequest = (): HTMLInputElement =>
  wizEl('tradepropose-request-currency') as HTMLInputElement;
const wizSubmit = (): HTMLButtonElement => wizEl('tradepropose-submit') as HTMLButtonElement;
const wizBox = (monsterId: number | string): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>(
    `#tradepropose-monsters input[data-monster-id="${monsterId}"]`,
  );
  if (el === null) throw new Error(`no checkbox for monster ${monsterId}`);
  return el;
};
const wizCheckedIds = (): (string | null)[] =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>(
      '#tradepropose-monsters input[type="checkbox"]:checked',
    ),
  ).map((b) => b.getAttribute('data-monster-id'));
const wizAllBoxIds = (): (string | null)[] =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>('#tradepropose-monsters input[type="checkbox"]'),
  ).map((b) => b.getAttribute('data-monster-id'));

/** What the user does with the mouse and keyboard on the DOM draft. */
function userSelect(identity: string): void {
  wizSelect().value = identity;
  wizSelect().dispatchEvent(new Event('change', { bubbles: true }));
}
function userCheck(monsterId: number | string, checked: boolean): void {
  const box = wizBox(monsterId);
  box.checked = checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}
function userType(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
/** Bob, Flame (12), 25 coins offered and 7 asked: a draft that can submit. */
function fillValidDraft(): void {
  userSelect(WIZ_BOB.identity);
  userCheck(12, true);
  userType(wizOffer(), '25');
  userType(wizRequest(), '7');
}
const VALID_ARGS: TradeProposeArgs = {
  targetIdentity: WIZ_BOB.identity,
  initiatorMonsterIds: [12n],
  initiatorCurrency: 25n,
  counterpartyCurrency: 7n,
};

interface Wizard {
  readonly view: TradeProposeView;
  readonly onSubmit: ReturnType<typeof vi.fn>;
}
/** A mounted, rendered, shown wizard whose onSubmit resolves at once (override per case). */
function mountWizard(onSubmit = vi.fn().mockResolvedValue(undefined)): Wizard {
  mountTradeProposeOverlay();
  const view = new TradeProposeView({ onSubmit, maxMonstersPerSide: 64 });
  view.render(WIZ_LISTS);
  view.show();
  return { view, onSubmit };
}

type StepKey = 'target' | 'offer' | 'coins' | 'ask' | 'review';
function stepLabel(step: StepKey): string {
  switch (step) {
    case 'target':
      return i18nT('tradePropose.step.target');
    case 'offer':
      return i18nT('tradePropose.step.offer');
    case 'coins':
      return i18nT('tradePropose.step.coins');
    case 'ask':
      return i18nT('tradePropose.step.ask');
    case 'review':
      return i18nT('tradePropose.step.review');
  }
}
const WIZ_STEPS: readonly StepKey[] = ['target', 'offer', 'coins', 'ask', 'review'];

/** The review summary line for these draft facts, resolved through the catalog. */
function summaryOf(target: string, monsters: number, offer: string, ask: string): string {
  return i18nTf('tradePropose.review.summary', { target, monsters, offer, ask } as never);
}

const headerOf = (): HTMLElement => wizTest('tradepropose-steps');
const headerSteps = (): (string | null)[] =>
  Array.from(headerOf().querySelectorAll('li')).map((li) => li.getAttribute('data-step'));
const headerCurrent = (): (string | null)[] =>
  Array.from(headerOf().querySelectorAll('li'))
    .filter((li) => li.getAttribute('aria-current') !== null)
    .map((li) => `${li.getAttribute('data-step')}=${li.getAttribute('aria-current')}`);

describe('TradeProposeView ctl-8e: the step header, the cursor mark and the review row (CTL8E.1)', () => {
  afterEach(() => {
    teardown();
  });

  it('CTL8E-1-VIEW-PAINT: paint draws ONE ordered list of steps before the select, one catalogued item per step of p.steps with aria-current="step" on the active one alone, and a repeat paint moves the mark without adding a second header', () => {
    // WRONG IMPL KILLED: a header appended on every paint (N paints, N headers); the active mark
    // on every item, on none, or as aria-selected / aria-current="true" (a screen reader announces
    // the step only for aria-current="step"); items in a fixed order instead of p.steps' (a
    // supplied target would still show Target); step names hard-coded English instead of the
    // catalog; the list placed after the select or outside the overlay.
    const { view } = mountWizard();
    view.paint(wizPaint({ step: 'coins' }));

    expect(document.querySelectorAll('[data-testid="tradepropose-steps"]')).toHaveLength(1);
    const header = headerOf();
    expect(header.tagName, 'an ordered list').toBe('OL');
    const select = wizSelect();
    expect(header.parentElement, 'a sibling of the select').toBe(select.parentElement);
    const siblings = Array.from(select.parentElement?.children ?? []);
    expect(siblings.indexOf(header), 'before the select').toBeGreaterThanOrEqual(0);
    expect(siblings.indexOf(header)).toBeLessThan(siblings.indexOf(select));

    expect(headerSteps()).toEqual([...WIZ_STEPS]);
    expect(
      Array.from(header.querySelectorAll('li')).map((li) => li.textContent),
      'the catalogued names, in order',
    ).toEqual(WIZ_STEPS.map(stepLabel));
    expect(headerCurrent(), 'the active step alone').toEqual(['coins=step']);

    view.paint(wizPaint({ step: 'review' }));
    expect(
      document.querySelectorAll('[data-testid="tradepropose-steps"]'),
      'still one',
    ).toHaveLength(1);
    expect(headerSteps(), 'still five items').toEqual([...WIZ_STEPS]);
    expect(headerCurrent(), 'the mark moved').toEqual(['review=step']);

    // A supplied target: p.steps has no Target, so the header has none.
    view.paint(wizPaint({ steps: proposeSteps(true), step: 'offer' }));
    expect(document.querySelectorAll('[data-testid="tradepropose-steps"]')).toHaveLength(1);
    expect(headerSteps(), 'four items, no Target').toEqual(['offer', 'coins', 'ask', 'review']);
    expect(headerCurrent()).toEqual(['offer=step']);
  });

  it('CTL8E-1-VIEW-PAINT: render (the open path in main.ts, before any paint) draws the opening header on Target with all five steps and keeps one header across repeated renders', () => {
    // WRONG IMPL KILLED: a header that exists only after the first button (the wizard opens with no
    // sign of where it is); an opening header with no active step or on the wrong step; and a
    // render that appends a fresh header each time the overlay opens.
    const { view } = mountWizard();
    expect(document.querySelectorAll('[data-testid="tradepropose-steps"]')).toHaveLength(1);
    expect(headerSteps()).toEqual([...WIZ_STEPS]);
    expect(headerCurrent(), 'opens on Target').toEqual(['target=step']);
    view.paint(wizPaint({ step: 'ask' }));
    view.hide();
    view.render(WIZ_LISTS);
    view.show();
    expect(
      document.querySelectorAll('[data-testid="tradepropose-steps"]'),
      'one after reopen',
    ).toHaveLength(1);
    expect(headerCurrent(), 'a reopen starts over on Target').toEqual(['target=step']);
  });

  it('CTL8E-1-VIEW-PAINT: the offer cursor`s checkbox label carries aria-current="true" and no other label does, the mark follows p.offerCursor across paints and clears for null, and the monsters container is the programmatic focus target (tabindex -1)', () => {
    // WRONG IMPL KILLED: a cursor mark on every label or none; one that sticks to the first paint's
    // monster; a mark on the checkbox instead of the label (the label is what a sighted user
    // sees); a cursor index in place of the monster id; a container that cannot take focus (the
    // Offer step's focus would silently fail and keys would keep going to the select).
    const { view } = mountWizard();
    const marked = (): (string | null)[] =>
      wizAllBoxIds().filter((id) => {
        const label = wizBox(id as string).closest('label');
        return label?.getAttribute('aria-current') === 'true';
      });
    view.paint(wizPaint({ step: 'offer', offerCursor: '12' }));
    expect(wizMonsters().getAttribute('tabindex')).toBe('-1');
    expect(marked(), 'the mark is on monster 12`s label').toEqual(['12']);
    expect(
      wizBox(12).closest('label')?.getAttribute('aria-current'),
      'exactly the string "true"',
    ).toBe('true');
    for (const id of ['5', '30']) {
      expect(wizBox(id).closest('label')?.hasAttribute('aria-current'), `${id}: no mark`).toBe(
        false,
      );
    }
    view.paint(wizPaint({ step: 'offer', offerCursor: '30' }));
    expect(marked(), 'it follows the cursor').toEqual(['30']);
    view.paint(wizPaint({ step: 'offer', offerCursor: null }));
    expect(marked(), 'no cursor, no mark').toEqual([]);
  });

  it('CTL8E-1-VIEW-PAINT: the review row follows the submit button, takes programmatic focus (tabindex -1), is shown only on the Review step, and its Yes / No are two non-focusable catalogued spans with aria-current="true" on the cursor one', () => {
    // WRONG IMPL KILLED: a row shown on every step (the confirm question visible while typing
    // coins); a row hidden on Review; one placed before the submit button; a Yes / No that are
    // buttons (Tab stops and a second Enter owner: native buttons own Enter, so the router never
    // sees A); the cursor mark on both, on neither, or inverted; raw English labels.
    const { view } = mountWizard();
    view.paint(wizPaint({ step: 'target' }));
    const row = wizTest('tradepropose-review');
    expect(row.getAttribute('tabindex'), 'focusable by script only').toBe('-1');
    const submit = wizSubmit();
    expect(row.parentElement, 'a sibling of the submit button').toBe(submit.parentElement);
    const kids = Array.from(submit.parentElement?.children ?? []);
    expect(kids.indexOf(row), 'after the submit button').toBeGreaterThan(kids.indexOf(submit));

    for (const step of WIZ_STEPS) {
      view.paint(wizPaint({ step }));
      expect(row.style.display, `step ${step}`).toBe(step === 'review' ? '' : 'none');
    }

    view.paint(wizPaint({ step: 'review', yes: true }));
    const yes = wizTest('tradepropose-review-yes');
    const no = wizTest('tradepropose-review-no');
    expect(yes.textContent).toBe(i18nT('tradePropose.review.yes'));
    expect(no.textContent).toBe(i18nT('tradePropose.review.no'));
    for (const span of [yes, no]) {
      expect(span.tagName, 'a span, not a control').toBe('SPAN');
      expect(span.hasAttribute('tabindex'), 'not focusable').toBe(false);
    }
    expect([yes.getAttribute('aria-current'), no.getAttribute('aria-current')]).toEqual([
      'true',
      null,
    ]);
    view.paint(wizPaint({ step: 'review', yes: false }));
    expect([yes.getAttribute('aria-current'), no.getAttribute('aria-current')]).toEqual([
      null,
      'true',
    ]);
  });

  it('CTL8E-1-VIEW-PAINT: the review prompt and summary are read from the ON-SCREEN draft at each paint: an empty draft reads "incomplete" with an empty target and zeros, a complete one reads the prompt with the selected target`s LABEL, the checked count and the PARSED coins', () => {
    // WRONG IMPL KILLED: a prompt computed from the paint payload (the screen cannot see the DOM
    // draft, so it would call an empty draft sendable); a prompt that is set once and never
    // refreshed; a summary of the raw field text ('025' and 'abc' instead of the parsed 25 and 0:
    // what is printed must be what is sent); the target identity instead of its label; a monster
    // count taken from p.lists (3) instead of the checked boxes (2); and a summary line outside
    // the catalog.
    const { view } = mountWizard();
    view.paint(wizPaint({ step: 'review' }));
    const prompt = wizTest('tradepropose-review-prompt');
    const summary = wizTest('tradepropose-review-summary');
    expect(prompt.textContent, 'nothing chosen yet').toBe(i18nT('tradePropose.review.incomplete'));
    expect(summary.textContent).toBe(summaryOf('', 0, '0', '0'));

    userSelect(WIZ_BOB.identity);
    userCheck(5, true);
    userCheck(30, true);
    userType(wizOffer(), '025');
    userType(wizRequest(), 'abc');
    view.paint(wizPaint({ step: 'review' }));
    expect(prompt.textContent, 'a complete draft').toBe(i18nT('tradePropose.review.prompt'));
    expect(summary.textContent, 'label, checked count, parsed coins').toBe(
      summaryOf('Bob', 2, '25', '0'),
    );
    expect(
      i18nT('tradePropose.review.prompt'),
      'fixture: the two prompts differ, so the assertions above can tell them apart',
    ).not.toBe(i18nT('tradePropose.review.incomplete'));

    // The draft empties again: the same elements follow it back.
    userCheck(5, false);
    userCheck(30, false);
    userType(wizOffer(), '');
    userType(wizRequest(), '');
    view.paint(wizPaint({ step: 'review' }));
    expect(prompt.textContent).toBe(i18nT('tradePropose.review.incomplete'));
    expect(summary.textContent).toBe(summaryOf('Bob', 0, '0', '0'));
  });

  it('CTL8E-1-VIEW-PAINT: paint rebuilds the select and the boxes from p.lists but PRESERVES the on-screen draft: the chosen target and the checked monsters still offered stay, a monster that left is gone, a target that left falls back to the placeholder, and the typed coins are untouched', () => {
    // WRONG IMPL KILLED: a paint that rebuilds and loses the player's mouse input (every D-pad
    // press would uncheck what was clicked and reset the target); one that never rebuilds (a
    // traded-away monster would linger as an offerable box); one that keeps a stale select value
    // after its option left (an empty value that reads as a valid target); one that carries a
    // checked mark onto a different monster by position; and one that clears the coin fields.
    const { view } = mountWizard();
    userSelect(WIZ_BOB.identity);
    userCheck(12, true);
    userCheck(30, true);
    userType(wizOffer(), '40');
    view.paint(wizPaint({ step: 'offer' }));
    expect(wizSelect().value).toBe(WIZ_BOB.identity);
    expect(wizCheckedIds()).toEqual(['12', '30']);
    expect(wizOffer().value).toBe('40');

    // Alice and monster 12 leave, Cy and monster 31 arrive.
    const next = makeLists(
      [WIZ_BOB, WIZ_CY],
      [
        { monsterId: 5n, label: 'Sparky Lv.3' },
        { monsterId: 30n, label: 'Third Lv.2' },
        { monsterId: 31n, label: 'Fresh Lv.1' },
      ],
    );
    view.paint(wizPaint({ step: 'offer', lists: next }));
    expect(
      Array.from(wizSelect().options).map((o) => o.value),
      'the placeholder, then the new targets',
    ).toEqual(['', WIZ_BOB.identity, WIZ_CY.identity]);
    expect(wizSelect().value, 'Bob is still offered: still chosen').toBe(WIZ_BOB.identity);
    expect(wizAllBoxIds(), 'the new monster list').toEqual(['5', '30', '31']);
    expect(wizCheckedIds(), '30 stays checked; 12 left; nothing shifted onto 31').toEqual(['30']);
    expect(wizOffer().value, 'the coins are untouched').toBe('40');

    // The chosen target leaves: back to the placeholder, and the submit button follows the DOM.
    view.paint(
      wizPaint({
        step: 'offer',
        lists: makeLists(
          [WIZ_CY],
          next.offerableMonsters.map((m) => m),
        ),
      }),
    );
    expect(wizSelect().value, 'a chosen target that left falls back to the placeholder').toBe('');
    expect(wizSubmit().disabled, 'no target: cannot submit').toBe(true);
  });

  it('CTL8E-1-VIEW-PAINT: a repaint with new lists also updates the targets the submission is validated against, so a target that only arrived with the repaint can be sent', async () => {
    // WRONG IMPL KILLED: a rebuild that updates the visible options but not the submission's target
    // list (the new counterparty would be rejected as "not in the list": a silent no-send).
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { view } = mountWizard(onSubmit);
    view.paint(wizPaint({ step: 'offer', lists: makeLists([WIZ_BOB, WIZ_CY], []) }));
    userSelect(WIZ_CY.identity);
    userType(wizOffer(), '9');
    expect(wizSubmit().disabled, 'Cy is a valid target after the repaint').toBe(false);
    wizSubmit().click();
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      targetIdentity: WIZ_CY.identity,
      initiatorMonsterIds: [],
      initiatorCurrency: 9n,
      counterpartyCurrency: 0n,
    });
  });

  it('CTL8E-1-VIEW-PAINT: a toggle token flips its monster`s checkbox EXACTLY once however many times the same token object is painted, a NEW token object flips it again, a token for a monster that is not listed flips nothing, and a toggle never overwrites a box the mouse set', () => {
    // WRONG IMPL KILLED: a toggle applied on every paint (a step change or any later key would
    // flip the box back and forth); tokens compared by monster id instead of identity (the second
    // A on one monster would never untick it); a toggle that throws on an unknown id; a paint that
    // resets every box to the screen's idea of the draft (a ticked box clicked with the mouse
    // would be wiped); and a toggle that does not enable the submit button.
    const { view } = mountWizard();
    userSelect(WIZ_BOB.identity);
    expect(wizSubmit().disabled, 'fixture: a target but no asset').toBe(true);

    const first = { monsterId: 12n };
    view.paint(wizPaint({ step: 'offer', toggle: first }));
    expect(wizCheckedIds(), 'first paint of the token: ticked').toEqual(['12']);
    expect(wizSubmit().disabled, 'a ticked monster is an asset: submit enabled').toBe(false);
    view.paint(wizPaint({ step: 'offer', toggle: first }));
    expect(wizCheckedIds(), 'the same object again: not flipped back').toEqual(['12']);
    view.paint(wizPaint({ step: 'coins', toggle: first }));
    expect(wizCheckedIds(), 'a later step, the same object: still ticked').toEqual(['12']);

    const second = { monsterId: 12n };
    view.paint(wizPaint({ step: 'coins', toggle: second }));
    expect(wizCheckedIds(), 'a new object for the same monster: unticked').toEqual([]);
    expect(wizSubmit().disabled, 'and the submit button follows').toBe(true);

    view.paint(wizPaint({ toggle: { monsterId: 30n } }));
    expect(wizCheckedIds()).toEqual(['30']);
    view.paint(wizPaint({ toggle: { monsterId: 99n } }));
    expect(wizCheckedIds(), 'an unlisted monster flips nothing').toEqual(['30']);

    // The mouse ticks 5 between two paints; the next toggle (for 12) must leave that tick alone.
    userCheck(5, true);
    view.paint(wizPaint({ toggle: { monsterId: 12n } }));
    expect(wizCheckedIds(), 'the mouse tick survives a toggle of another box').toEqual([
      '5',
      '12',
      '30',
    ]);
  });
});

describe('TradeProposeView ctl-8e: focus follows the step (CTL8E.1)', () => {
  afterEach(() => {
    teardown();
  });

  it('CTL8E-1-VIEW-FOCUS: the first paint of each step moves focus to that step`s control, by identity: Target the select, Offer the monsters container, Coins the offer field, Ask the request field, Review the review row', () => {
    // WRONG IMPL KILLED: no focus move at all (the wizard's keys would keep going to whatever was
    // focused); one focus target for every step; Offer focusing the first checkbox (a native
    // checkbox owns Space and the D-pad would stop reaching the router); Review focusing the
    // submit button (a native button owns Enter, so the A press would never reach the router, and
    // a held Enter could click it); and a focus handed to a different field (Coins to Ask).
    const expected: ReadonlyArray<readonly [StepKey, () => HTMLElement]> = [
      ['target', wizSelect],
      ['offer', wizMonsters],
      ['coins', wizOffer],
      ['ask', wizRequest],
      ['review', () => wizTest('tradepropose-review')],
    ];
    for (const [step, target] of expected) {
      const { view } = mountWizard();
      // Arrive from a DIFFERENT step, so the move is a real step change whatever render() remembers.
      view.paint(wizPaint({ step: step === 'coins' ? 'ask' : 'coins' }));
      view.paint(wizPaint({ step }));
      expect(document.activeElement, `the ${step} step focuses its control`).toBe(target());
      expect(document.activeElement, `the ${step} step never focuses submit`).not.toBe(wizSubmit());
      view.hide();
      teardown();
    }
  });

  it('CTL8E-1-VIEW-FOCUS: focus moves ONLY when the step changed since the last paint: a repaint of the same step (a cursor move, a toggle, a batch) leaves focus where the player put it, and the next step change moves it again', () => {
    // WRONG IMPL KILLED: a paint that refocuses every time (a cursor move would yank focus back
    // from the field the player clicked; a store batch would steal the keyboard from a typist); one
    // that remembers the step only on the first paint; and one that never moves again after the
    // first move.
    const { view } = mountWizard();
    view.paint(wizPaint({ step: 'offer' }));
    expect(document.activeElement).toBe(wizMonsters());

    wizOffer().focus();
    expect(document.activeElement, 'fixture: the player moved focus to the offer field').toBe(
      wizOffer(),
    );
    view.paint(wizPaint({ step: 'offer', offerCursor: '12' }));
    view.paint(wizPaint({ step: 'offer', offerCursor: '12', toggle: { monsterId: 12n } }));
    expect(document.activeElement, 'same step: focus is left alone').toBe(wizOffer());

    view.paint(wizPaint({ step: 'coins' }));
    expect(document.activeElement, 'a changed step moves it').toBe(wizOffer());
    wizRequest().focus();
    view.paint(wizPaint({ step: 'coins' }));
    expect(document.activeElement, 'coins painted twice: no second move').toBe(wizRequest());
    view.paint(wizPaint({ step: 'ask' }));
    expect(document.activeElement, 'Ask moves it to the request field').toBe(wizRequest());
    view.paint(wizPaint({ step: 'offer' }));
    expect(document.activeElement, 'stepping BACK moves it too').toBe(wizMonsters());
  });

  it('CTL8E-1-VIEW-FOCUS: leaving Review moves focus off the review row before it is hidden: stepping back from Review lands on the Ask field with the row hidden, never on a hidden element', () => {
    // WRONG IMPL KILLED: a paint that hides the row first and focuses second (or never): focus
    // would sit inside display:none, main.ts would heal it to the canvas on the next key, and the
    // wizard's keys would stop reaching the field the player expects.
    const { view } = mountWizard();
    view.paint(wizPaint({ step: 'review' }));
    const row = wizTest('tradepropose-review');
    expect(document.activeElement).toBe(row);
    view.paint(wizPaint({ step: 'ask' }));
    expect(row.style.display, 'the row is hidden').toBe('none');
    expect(document.activeElement, 'and focus left it for the Ask field').toBe(wizRequest());
    expect(row.contains(document.activeElement), 'not inside the hidden row').toBe(false);
  });

  it('CTL8E-1-VIEW-FOCUS: hide() forgets the last painted step so a reopen`s first paint moves focus again, while show() and render() never move focus themselves', () => {
    // WRONG IMPL KILLED: a view that keeps its last step across a close (the reopened wizard's
    // first paint on the same step would leave focus on the page: the D-pad stays with the world);
    // a render() or show() that focuses the select or the container itself (it would fight the
    // overlay helper's deferred initial focus on the select and the S10-WIRE-FOCUS-IDENTITY pin).
    const { view } = mountWizard();
    const outside = document.createElement('button');
    outside.id = 'wiz-outside-sentinel';
    document.body.appendChild(outside);

    view.paint(wizPaint({ step: 'offer' }));
    expect(document.activeElement).toBe(wizMonsters());
    outside.focus();
    view.render(WIZ_LISTS);
    expect(document.activeElement, 'render() moves no focus').toBe(outside);
    view.show();
    expect(document.activeElement, 'show() on a visible overlay moves no focus').toBe(outside);

    view.paint(wizPaint({ step: 'offer' }));
    expect(document.activeElement, 'same step, no second move').toBe(outside);

    view.hide();
    outside.focus();
    view.render(WIZ_LISTS);
    view.show();
    expect(document.activeElement, 'the reopen itself moves no focus synchronously').toBe(outside);
    view.paint(wizPaint({ step: 'offer' }));
    expect(document.activeElement, 'but the first paint after the reopen does').toBe(wizMonsters());
  });
});

describe('TradeProposeView ctl-8e: the commit token sends the on-screen draft once (CTL8E.1)', () => {
  afterEach(() => {
    teardown();
  });

  it('CTL8E-1-VIEW-COMMIT: a new commit token sends the ON-SCREEN draft through onSubmit exactly once (the typed target, the ticked monsters and the PARSED coins as bigints), the same token object painted again sends nothing, and the legacy submit click sends the same draft', async () => {
    // WRONG IMPL KILLED: a view that sends on every paint that carries a commit (the next key press
    // would send again); one that sends a draft held by the screen instead of the DOM's (what is
    // sent would not be what the player saw); coins as numbers or strings instead of bigints; a
    // view that drops the legacy click path (Tab then Enter on the button must still send).
    const { view, onSubmit } = mountWizard();
    fillValidDraft();
    const commit = newCommit();
    view.paint(wizPaint({ step: 'review', commit }));
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(VALID_ARGS);

    view.paint(wizPaint({ step: 'review', commit }));
    view.paint(wizPaint({ step: 'ask', commit }));
    await flushPromises();
    expect(onSubmit, 'the same token object never sends twice').toHaveBeenCalledTimes(1);

    const later = newCommit();
    expect(later, 'fixture: equal by value, distinct by identity').toEqual(commit);
    view.paint(wizPaint({ step: 'review', commit: later }));
    await flushPromises();
    expect(onSubmit, 'a NEW token object sends again').toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith(VALID_ARGS);

    wizSubmit().click();
    await flushPromises();
    expect(onSubmit, 'the legacy click still sends the same draft').toHaveBeenCalledTimes(3);
    expect(onSubmit).toHaveBeenLastCalledWith(VALID_ARGS);
  });

  it('CTL8E-1-VIEW-COMMIT: a commit token on a draft that cannot submit sends nothing AND is spent: completing the draft afterwards and repainting the same token still sends nothing, while a new token then sends', async () => {
    // WRONG IMPL KILLED: a commit that is kept pending until the draft turns valid (the player
    // fixes the draft on the Offer step and the stale Yes fires out of nowhere, unseen); one that
    // sends a half-built draft; and one that compares by value so the second, later Yes is
    // ignored as "already seen".
    const { view, onSubmit } = mountWizard();
    userSelect(WIZ_BOB.identity);
    const stale = newCommit();
    view.paint(wizPaint({ step: 'review', commit: stale }));
    await flushPromises();
    expect(onSubmit, 'no asset: nothing to send').not.toHaveBeenCalled();

    userCheck(12, true);
    view.paint(wizPaint({ step: 'review', commit: stale }));
    await flushPromises();
    expect(onSubmit, 'the spent token does not fire later').not.toHaveBeenCalled();

    view.paint(wizPaint({ step: 'review', commit: newCommit() }));
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      targetIdentity: WIZ_BOB.identity,
      initiatorMonsterIds: [12n],
      initiatorCurrency: 0n,
      counterpartyCurrency: 0n,
    });
  });

  it('CTL8E-1-VIEW-COMMIT: the in-flight lock still holds: while a send is pending a new commit token sends nothing, and once it settles the next new token sends', async () => {
    // WRONG IMPL KILLED: a commit path that bypasses #pending (a second Yes while the first offer
    // is in flight would propose the same trade twice); a lock that never releases (the wizard
    // could send only once).
    let settle: () => void = () => undefined;
    const onSubmit = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const { view } = mountWizard(onSubmit);
    fillValidDraft();
    view.paint(wizPaint({ step: 'review', commit: newCommit() }));
    view.paint(wizPaint({ step: 'review', commit: newCommit() }));
    await flushPromises();
    expect(onSubmit, 'one in flight: the second token is refused').toHaveBeenCalledTimes(1);
    settle();
    await flushPromises();
    view.paint(wizPaint({ step: 'review', commit: newCommit() }));
    await flushPromises();
    expect(onSubmit, 'settled: the next token sends').toHaveBeenCalledTimes(2);
  });

  it('CTL8E-1-VIEW-COMMIT: one paint carrying a toggle token AND a commit token applies the toggle to the on-screen draft BEFORE it sends, so the sent offer contains the toggled monster', async () => {
    // WRONG IMPL KILLED: a paint that runs the send before applying the toggle (the offer would
    // go without the monster the player just ticked, or not go at all on an otherwise-empty
    // draft), and one that applies the toggle but sends a draft snapshot taken before it.
    const { view, onSubmit } = mountWizard();
    userSelect(WIZ_BOB.identity);
    view.paint(wizPaint({ step: 'review', toggle: { monsterId: 12n }, commit: newCommit() }));
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      targetIdentity: WIZ_BOB.identity,
      initiatorMonsterIds: [12n],
      initiatorCurrency: 0n,
      counterpartyCurrency: 0n,
    });
  });

  it('CTL8E-1-VIEW-COMMIT: every paint leaves the submit button enabled exactly when the ON-SCREEN draft can submit, whatever the payload says', () => {
    // WRONG IMPL KILLED: a paint that does not refresh the button (it stays at the state the last
    // input event left, but a rebuild or toggle changed the draft); one that enables it from the
    // payload; one that leaves it disabled after a draft turned valid by a toggle token.
    const { view } = mountWizard();
    view.paint(wizPaint({ step: 'offer' }));
    expect(wizSubmit().disabled, 'empty draft').toBe(true);
    userSelect(WIZ_BOB.identity);
    view.paint(wizPaint({ step: 'offer' }));
    expect(wizSubmit().disabled, 'a target but no asset').toBe(true);
    view.paint(wizPaint({ step: 'offer', toggle: { monsterId: 5n } }));
    expect(wizSubmit().disabled, 'a ticked monster').toBe(false);
    userCheck(5, false);
    view.paint(wizPaint({ step: 'offer' }));
    expect(wizSubmit().disabled, 'unticked again').toBe(true);
  });
});

describe('TradeProposeView ctl-8e: which keys the controls keep (CTL8E.1, CTL6B.5)', () => {
  afterEach(() => {
    teardown();
  });

  const RELEASED = ['Escape', 'Enter', 'NumpadEnter'] as const;
  const SHIELDED = [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'KeyW',
    'KeyS',
    'KeyO',
    'KeyU',
    'Space',
    'PageUp',
    'PageDown',
    'Backspace',
  ] as const;

  /** Dispatch `code` as a keydown on `el` and say whether a window listener saw it. */
  function reachesWindow(el: HTMLElement, code: string): boolean {
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    el.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
    window.removeEventListener('keydown', spy);
    return spy.mock.calls.length > 0;
  }

  it('CTL8E-1-VIEW-KEYS: the select, a monster checkbox and both currency inputs let Escape, Enter and NumpadEnter reach the window (the router`s Start and A) and keep every other key to themselves (letters, arrows, Space, paging, Backspace)', () => {
    // WRONG IMPL KILLED: the pre-ctl-8e blanket stopPropagation (Escape and Enter never reach the
    // router: B5, and the A press that steps the wizard is dead); the opposite, no shield at all
    // (a typed letter would reach the hotkey ladder, ArrowDown on the select would walk the
    // character, Backspace would pop the frame in the middle of typing); and a shield on only
    // some of the four control kinds.
    const { view } = mountWizard();
    view.paint(wizPaint({ step: 'offer' }));
    const controls: ReadonlyArray<readonly [string, HTMLElement]> = [
      ['select', wizSelect()],
      ['checkbox', wizBox(5)],
      ['offer input', wizOffer()],
      ['request input', wizRequest()],
    ];
    for (const [label, el] of controls) {
      for (const code of RELEASED) {
        expect(reachesWindow(el, code), `${label}: ${code} reaches the router`).toBe(true);
      }
      for (const code of SHIELDED) {
        expect(reachesWindow(el, code), `${label}: ${code} stays with the control`).toBe(false);
      }
    }
  });

  it('CTL8E-1-VIEW-KEYS: checkboxes rebuilt by a paint carry the same shield, so a rebuilt box never leaks a letter or lets Enter be swallowed', () => {
    // WRONG IMPL KILLED: a paint that rebuilds the boxes with a bare createElement (no keydown
    // listener): after the first D-pad press every box would pass letters to the hotkey ladder and
    // the Offer step would lose its shield; or with a shield that stops Enter (A would die there).
    const { view } = mountWizard();
    view.paint(
      wizPaint({
        step: 'offer',
        lists: makeLists([WIZ_BOB], [{ monsterId: 77n, label: 'Rebuilt Lv.2' }]),
      }),
    );
    const rebuilt = wizBox(77);
    for (const code of RELEASED) {
      expect(reachesWindow(rebuilt, code), `rebuilt box: ${code}`).toBe(true);
    }
    for (const code of SHIELDED) {
      expect(reachesWindow(rebuilt, code), `rebuilt box: ${code}`).toBe(false);
    }
  });
});

// ===========================================================================================
// ctl-8e round 2 (review-lens gaps): the review row is displayed BEFORE it takes focus and is
// hidden again by a close; a commit whose own rebuild changed the draft is spent, not sent; a
// focused checkbox survives a rebuild; a throwing onSubmit does not wedge the lock.
// ===========================================================================================

/** No element from `el` up has an inline display:none: what a real browser needs to focus it. */
function wizDisplayed(el: HTMLElement): boolean {
  for (let n: Element | null = el; n instanceof HTMLElement; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
}

describe('TradeProposeView ctl-8e round 2: focus and the review row', () => {
  afterEach(() => {
    teardown();
  });

  it('CTL8E-1-VIEW-FOCUS: when Review focuses the review row it is already DISPLAYED (not hidden at the moment of the focus() call)', () => {
    // WRONG IMPL KILLED: a paint that focuses the row first and un-hides it afterwards. happy-dom
    // focuses a display:none node, but a real browser refuses: focus stays where it was, the
    // router never sees the D-pad or A, and Review is dead to the keyboard (mutant: focusStep
    // ('review') not un-hiding before focus).
    const { view } = mountWizard();
    view.paint(wizPaint({ step: 'ask' }));
    const row = wizTest('tradepropose-review');
    expect(row.style.display, 'fixture: hidden before Review').toBe('none');

    const original = HTMLElement.prototype.focus;
    const displayedAtFocus: boolean[] = [];
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ): void {
      if (this === row) displayedAtFocus.push(wizDisplayed(this));
      original.call(this, options);
    });
    try {
      view.paint(wizPaint({ step: 'review' }));
    } finally {
      spy.mockRestore();
    }
    expect(displayedAtFocus.length, 'the row was focused').toBeGreaterThan(0);
    expect(
      displayedAtFocus.every((shown) => shown),
      'and displayed at that moment',
    ).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it('CTL8E-1-VIEW-FOCUS: a close from Review hides the review row, and a render + show reopen keeps it hidden', () => {
    // WRONG IMPL KILLED: a hide() that forgets the runtime row (the reopened wizard opens on Target
    // with the Review question still on screen), and a render() that un-hides it.
    const { view } = mountWizard();
    view.paint(wizPaint({ step: 'review' }));
    const row = wizTest('tradepropose-review');
    expect(row.style.display, 'fixture: shown on Review').toBe('');
    view.hide();
    expect(row.style.display, 'hidden by the close').toBe('none');
    view.render(WIZ_LISTS);
    view.show();
    expect(row.style.display, 'still hidden after the reopen').toBe('none');
    expect(headerCurrent(), 'the reopen is on Target').toEqual(['target=step']);
  });

  it('CTL8E-1-VIEW-FOCUS: a focused checkbox survives a paint`s rebuild (the new box with the same monster id has focus and keeps its checked state), and when its monster left the list focus goes to the monsters container, never the body', () => {
    // WRONG IMPL KILLED: a rebuild that replaces the focused box and drops focus to <body> (the
    // D-pad then walks the character under the open overlay, and main.ts heals focus to the
    // canvas); one that loses the checked state; and one that, for a vanished monster, leaves
    // focus on a detached node.
    const { view } = mountWizard();
    view.paint(wizPaint({ step: 'offer' }));
    userCheck(30, true);
    wizBox(30).focus();
    expect(document.activeElement, 'fixture: box 30 has focus').toBe(wizBox(30));

    view.paint(wizPaint({ step: 'offer', offerCursor: '12' }));
    const kept = document.activeElement as HTMLInputElement;
    expect(kept.getAttribute('data-monster-id'), 'focus is on monster 30`s box').toBe('30');
    expect(kept.isConnected, 'a live box, not a detached one').toBe(true);
    expect(kept, 'the box in the container now').toBe(wizBox(30));
    expect(kept.checked, 'still checked').toBe(true);

    userCheck(5, false);
    wizBox(5).focus();
    view.paint(wizPaint({ step: 'offer', toggle: { monsterId: 12n } }));
    const unchecked = document.activeElement as HTMLInputElement;
    expect(unchecked.getAttribute('data-monster-id'), 'an unchecked focused box too').toBe('5');
    expect(unchecked.checked).toBe(false);

    wizBox(30).focus();
    view.paint(
      wizPaint({
        step: 'offer',
        lists: makeLists(
          [WIZ_ALICE, WIZ_BOB],
          [
            { monsterId: 5n, label: 'Sparky Lv.3' },
            { monsterId: 12n, label: 'Flame Lv.1' },
          ],
        ),
      }),
    );
    expect(document.activeElement, 'monster 30 left: the container takes focus').toBe(
      wizMonsters(),
    );
    expect(document.activeElement, 'never the body').not.toBe(document.body);
  });
});

describe('TradeProposeView ctl-8e round 2: a commit is spent by the draft it was painted with', () => {
  afterEach(() => {
    teardown();
  });

  it('CTL8E-1-VIEW-COMMIT: a commit token painted with lists that REMOVE a ticked monster sends nothing (the token is spent), the box is gone and the summary shows the new draft, and a NEW token then sends the new draft', async () => {
    // WRONG IMPL KILLED: a paint that rebuilds, then sends the draft as it now is: the player
    // confirmed "monster 12 + 25 coins" on screen and an offer for 25 coins alone goes out (what
    // is sent must be what was seen). Also a view that sends the pre-rebuild snapshot, and one
    // that keeps the token pending so a later paint sends it.
    const { view, onSubmit } = mountWizard();
    userSelect(WIZ_BOB.identity);
    userCheck(12, true);
    userType(wizOffer(), '25');
    view.paint(wizPaint({ step: 'review' }));

    const gone = makeLists(
      [WIZ_ALICE, WIZ_BOB],
      [
        { monsterId: 5n, label: 'Sparky Lv.3' },
        { monsterId: 30n, label: 'Third Lv.2' },
      ],
    );
    const spent = newCommit();
    view.paint(wizPaint({ step: 'review', lists: gone, commit: spent }));
    await flushPromises();
    expect(
      onSubmit,
      'the confirmed draft changed under the token: nothing is sent',
    ).not.toHaveBeenCalled();
    expect(wizAllBoxIds().includes('12'), 'monster 12 is gone').toBe(false);
    expect(
      wizTest('tradepropose-review-summary').textContent,
      'the summary shows the new draft',
    ).toBe(summaryOf('Bob', 0, '25', '0'));

    view.paint(wizPaint({ step: 'review', lists: gone, commit: spent }));
    await flushPromises();
    expect(onSubmit, 'the spent token never fires later').not.toHaveBeenCalled();

    view.paint(wizPaint({ step: 'review', lists: gone, commit: newCommit() }));
    await flushPromises();
    expect(onSubmit, 'a new token confirms the new draft').toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      targetIdentity: WIZ_BOB.identity,
      initiatorMonsterIds: [],
      initiatorCurrency: 25n,
      counterpartyCurrency: 0n,
    });
  });

  it('CTL8E-1-VIEW-COMMIT: a commit token painted with lists that REMOVE the chosen target sends nothing, the select falls back to the placeholder, and the spent token does not fire when the target returns', async () => {
    // WRONG IMPL KILLED: a send keyed to the target as it was before the rebuild (an offer to a
    // player who has left); a token kept pending until the target is valid again.
    const { view, onSubmit } = mountWizard();
    fillValidDraft();
    const spent = newCommit();
    view.paint(
      wizPaint({
        step: 'review',
        lists: makeLists([WIZ_ALICE], [...WIZ_LISTS.offerableMonsters]),
        commit: spent,
      }),
    );
    await flushPromises();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(wizSelect().value, 'back to the placeholder').toBe('');
    view.paint(wizPaint({ step: 'review', commit: spent }));
    await flushPromises();
    expect(onSubmit, 'Bob is listed again, but the token is spent').not.toHaveBeenCalled();
  });

  it('CTL8E-1-VIEW-COMMIT: an onSubmit that THROWS synchronously does not wedge the lock: paint and click swallow it, submit is not left disabled, and a later new token or click calls onSubmit again', async () => {
    // WRONG IMPL KILLED: a #submit that sets #pending (and disables the button) before calling
    // onSubmit and never restores it when the call throws: every later Yes and click is a silent
    // no-op until the overlay is closed; and a throw that escapes paint() or the click handler (an
    // unhandled error out of a keydown).
    const errors: unknown[] = [];
    const onError = (e: Event): void => {
      errors.push(e);
    };
    window.addEventListener('error', onError);
    try {
      const onSubmit = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('boom');
        })
        .mockImplementationOnce(() => {
          throw new Error('boom again');
        })
        .mockResolvedValue(undefined);
      const { view } = mountWizard(onSubmit);
      fillValidDraft();

      expect(() => view.paint(wizPaint({ step: 'review', commit: newCommit() }))).not.toThrow();
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(wizSubmit().disabled, 'the button is not left disabled').toBe(false);

      expect(() => wizSubmit().click(), 'the click handler swallows it too').not.toThrow();
      expect(
        onSubmit,
        'the lock was released: the click called onSubmit again',
      ).toHaveBeenCalledTimes(2);
      expect(wizSubmit().disabled).toBe(false);

      view.paint(wizPaint({ step: 'review', commit: newCommit() }));
      await flushPromises();
      expect(onSubmit, 'and a later new token sends').toHaveBeenCalledTimes(3);
      expect(errors, 'no error escaped to the window').toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
    }
  });
});
