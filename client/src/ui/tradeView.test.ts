// @vitest-environment happy-dom
// ui/tradeView.test.ts — RED tests for m16.5c §16.5c-3: render hygiene in TradeView.
//
// SOURCE OF TRUTH: M16.5-ninth-review-residuals.spec.md §16.5c-3
//
// RED REASON (m16.5c-TV-1 — disabled lock during re-render while #pending):
//   TradeView.#renderActions() recreates buttons via innerHTML='' then createElement.
//   Each freshly-created button sets btn.disabled = false ONLY in the click handler's
//   finally block — but the handler never fires during a re-render.  The button is
//   created with no explicit disabled assignment, so it defaults to disabled=false.
//   When #pending=true and a server batch triggers render() again, the new buttons
//   land with disabled=false even though a reducer call is in flight.  The player can
//   double-click before the finally() runs.
//   After fix: render() (or #renderActions()) checks #pending and sets btn.disabled=true
//   for every newly-created button when #pending is already true.
//
// RED REASON (m16.5c-TV-2 — stale feedback not cleared on offer-state change):
//   TradeView.render() never touches #feedbackEl.  Once showFeedback('Trade accepted!')
//   is called, that text persists through every subsequent render() call, including
//   when the server changes status (e.g. Pending→ConfirmedByCounterparty) and a new
//   statusLabel appears in #trade-status.  The "Trade accepted!" message stays visible
//   after the status has already changed, which is stale and misleading.
//   After fix: render() clears #feedbackEl when the statusLabel (or kind) changes
//   relative to the previous render call.
//
// RED REASON (m16.5c-TV-3 — feedback not cleared on kind transition no-trade→trade):
//   Same root cause: render() with kind='no-trade' does not touch #feedbackEl.
//   If showFeedback() was called during a prior trade session, then the offer is
//   removed (kind='no-trade'), then a new offer arrives (kind='trade'), the stale
//   feedback from the previous session is still visible.
//   After fix: the kind transition from 'no-trade' to 'trade' (or any state change)
//   clears #feedbackEl.
//
// WRONG IMPL KILLED per test:
//   TV-1: any impl where #renderActions() creates buttons with disabled=false when
//         #pending=true — the double-send vector is open.
//   TV-2: any impl where render() with a changed statusLabel does NOT clear
//         #feedbackEl — "Trade accepted!" persists after the server advances the offer.
//   TV-3: any impl where render() with kind='trade' does NOT clear #feedbackEl when
//         previously in kind='no-trade' — stale cross-session feedback leaks.
//
// Pattern follows battleView.test.ts: @vitest-environment happy-dom, DOM set up
// before construction, vi.fn() callbacks, no SDK/wasm/network.
//
// ---------------------------------------------------------------------------
// m23-s3 ADDITION (2026-08-24) — overlay a11y wiring. ADDITIVE ONLY: nothing above was weakened
// or deleted; the mount helper gained the `role`/`aria-modal`/`tabindex` attributes
// client/index.html:36-37 has always shipped, and a file-level a11y sweep was added.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/16);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1/F2/F7, §1 D1/D2/D7/D8, §4, §7 A1/A3/A6/A7/A8;
//   memory/projects/gates/m23-s3.gates.md X1/X2/X3/X6/X8; ADR-0205 D1-D4, A3.
//
// RED REASON (m23-s3): `client/src/ui/tradeView.ts` DOES NOT CALL openOverlayA11y/closeOverlayA11y
// at all today — show() is a single `style.display = ''` (ui/tradeView.ts:63-65). Every S3-* test
// below therefore fails now; every m16.5c test above still passes.
//
// TWO ORACLES, BOTH REQUIRED (plan A3, measured by red-team):
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['tradeView'].labelKey)`. `role`/`aria-modal`
//     are ALREADY static literals on the shell in client/index.html:36 (m23-s2), so asserting them
//     ALONE is VACUOUS: a view that calls nothing passes. They are asserted only alongside
//     aria-label, and their ABSENCE after close is the anti-vacuity partner (attack V1).
//   * MECHANISM oracle — `vi.mock('./overlayA11y', { spy: true })` records the calls AND calls
//     through to the real implementation, so a cheat that hand-writes the three attributes with the
//     correct copied literal (no trap, no return-focus record, no timer) still reds.
//
// TEST-ISOLATION DEVICE (plan A8 / V7, copied from ui/overlayA11y.test.ts:97-105): overlayA11y.ts
// holds ONE module-private Map and exports no reset hook, so the file-level beforeEach/afterEach
// call the PRODUCTION closeOverlayA11y(id, null) for every OverlayId and flush ONE REAL MACROTASK
// — legal because close-without-open is a documented no-op (ui/overlayA11y.ts:41-45). It also
// cancels the deferred-focus timer every pre-existing `view.show()` above will schedule once the
// wiring lands (plan residual A12). `vi.clearAllMocks()` runs LAST so the sweep's own calls never
// pollute a count.
//
// m23-s3 WRONG-IMPL-KILLED index:
//   - never opens / attribute-only cheat                 -> S3-tradeView-OPEN-ARIA + -HELPER-CALLED
//   - copy-pasted WRONG OverlayId                        -> S3-tradeView-OPEN-ARIA (label) + -HELPER-CALLED (id arg)
//   - synchronous focus (no defer)                       -> S3-tradeView-DEFER-FOCUS (negative polarity)
//   - focuses nothing / a wrapper, not the anchor         -> S3-tradeView-DEFER-FOCUS (identity)
//   - close never strips ARIA / never restores focus      -> S3-tradeView-CLOSE-RESTORE
//   - UNGUARDED show() / `this.visible` read AFTER the write -> S3-tradeView-REPEAT-NO-REOPEN
//   - `fallbackFocus` passed as undefined/an element       -> S3-tradeView-HELPER-CALLED (literal null)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import type { TradeScreenViewModel } from './tradeModel';
import type { TradeCallbacks } from './tradeView';
import { TradeView } from './tradeView';

// The m23-s3 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works.
vi.mock('./overlayA11y', { spy: true });

/** m23-s3: one REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0),
 *  and fake timers are banned for this defer (plan anti-pattern #10). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// m23-s3: NEW file-level isolation hooks (this file previously had none — every test mounted and
// removed its own overlay inline, which leaks on a failed assertion).
beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// DOM setup helper — mirrors the structure in client/index.html that TradeView
// expects.  Must be called before constructing TradeView in each test so the
// constructor querySelector calls succeed.
// ---------------------------------------------------------------------------
function mountTradeOverlay(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = 'trade-overlay';
  overlay.style.display = 'none';
  // m23-s3 FIXTURE FIDELITY (index.html:36): the shell has shipped these two as STATIC LITERALS
  // since m23-s2. They are copied here NOT to be asserted on their own — that is vacuous, a view
  // calling nothing passes — but so that "all three attributes ABSENT after close" is a real
  // tooth: only closeOverlayA11y can remove them (ui/overlayA11y.ts:142-144).
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const statusEl = document.createElement('div');
  statusEl.id = 'trade-status';
  // m23-s3 (index.html:37): the OVERLAY_A11Y initialFocusSelector anchor. Copied for fidelity
  // only — happy-dom focuses a bare <div> with no tabindex at all, so this buys ZERO test power
  // (plan A7) and a passing A11Y-14 here is NOT proof a real browser would honour the focus.
  statusEl.setAttribute('tabindex', '-1');
  overlay.appendChild(statusEl);

  const mySideEl = document.createElement('div');
  mySideEl.id = 'trade-my-side';
  overlay.appendChild(mySideEl);

  const theirSideEl = document.createElement('div');
  theirSideEl.id = 'trade-their-side';
  overlay.appendChild(theirSideEl);

  const actionsEl = document.createElement('div');
  actionsEl.id = 'trade-actions';
  overlay.appendChild(actionsEl);

  const feedbackEl = document.createElement('div');
  feedbackEl.id = 'trade-feedback';
  overlay.appendChild(feedbackEl);

  document.body.appendChild(overlay);
  return overlay;
}

function removeOverlay(overlay: HTMLElement): void {
  if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
}

// ---------------------------------------------------------------------------
// Minimal callbacks factory — TradeCallbacks with vi.fn() stubs.
// onAccept/onReject/onConfirm/onCancel all return a never-settling Promise so
// that #pending stays true during the test (simulating an in-flight reducer).
// ---------------------------------------------------------------------------
function makeCallbacks(): TradeCallbacks {
  const pending = new Promise<void>(() => {
    /* intentionally never resolves — keeps #pending=true for TV-1 */
  });
  return {
    onAccept: vi.fn(() => pending),
    onReject: vi.fn(() => pending),
    onConfirm: vi.fn(() => pending),
    onCancel: vi.fn(() => pending),
  };
}

// ---------------------------------------------------------------------------
// Minimal TradeScreenViewModel factories.
// ---------------------------------------------------------------------------

function makePendingTradeVM(
  statusLabel = 'Offer received',
  actions: Array<'accept' | 'reject' | 'confirm' | 'cancel'> = ['accept', 'reject'],
): TradeScreenViewModel {
  return {
    kind: 'trade',
    tradeId: 1n,
    mySide: { cards: [], items: [], currency: 0n },
    theirSide: { cards: [], items: [], currency: 0n },
    viewerIsInitiator: false,
    statusLabel,
    actions,
  };
}

function makeNoTradeVM(): TradeScreenViewModel {
  return { kind: 'no-trade' };
}

// ---------------------------------------------------------------------------
// [m16.5c-TV-1] BITES: buttons render disabled when #pending is true
//
// Procedure:
//   1. Construct TradeView
//   2. show() + render() with a trade VM (Pending, actions=['accept','reject'])
//   3. Verify buttons start with disabled=false (baseline)
//   4. Click one button — this triggers the click handler → sets #pending=true,
//      btn.disabled=true, dispatches the never-settling onAccept Promise
//   5. Call render() again with the same VM (simulating a server batch while in-flight)
//   6. Assert ALL buttons in #trade-actions are disabled=true
//
// Why it's RED before fix:
//   #renderActions() clears actionsEl.innerHTML then creates fresh buttons.
//   Each fresh button is created with no explicit disabled attribute — defaults to
//   false.  The click handler's finally() (which sets disabled=false) hasn't fired
//   and won't fire until the reducer resolves.  But #pending=true at the moment
//   render() runs, so the fix must set btn.disabled=true for new buttons when #pending.
//   Without the fix, the newly-created buttons have disabled=false → the player can
//   click again → double-send.
// ---------------------------------------------------------------------------
describe('TradeView [m16.5c-TV-1]: buttons render disabled when #pending is true', () => {
  it('BITES: re-render while #pending=true must create buttons with disabled=true', () => {
    const overlay = mountTradeOverlay();
    const cbs = makeCallbacks();
    const view = new TradeView(cbs);

    view.show();
    const vm = makePendingTradeVM('Offer received', ['accept', 'reject']);

    // First render: baseline — buttons must exist and be enabled (disabled=false).
    view.render(vm);

    const actionsEl = document.getElementById('trade-actions')!;
    const buttonsAfterFirstRender = actionsEl.querySelectorAll('button');
    expect(buttonsAfterFirstRender.length).toBeGreaterThan(0);
    for (const btn of buttonsAfterFirstRender) {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    }

    // Click the first button — sets #pending=true inside TradeView.
    // onAccept returns a never-settling Promise so #pending stays true.
    (buttonsAfterFirstRender[0] as HTMLButtonElement).click();

    // Now re-render with the same VM while the reducer Promise is still pending.
    // This simulates a server batch arriving (store flush) while the action is in-flight.
    view.render(vm);

    // BITES: without the fix, freshly-created buttons default to disabled=false.
    // After fix: #renderActions detects #pending=true and sets btn.disabled=true.
    const buttonsAfterSecondRender = actionsEl.querySelectorAll('button');
    expect(buttonsAfterSecondRender.length).toBeGreaterThan(0);
    for (const btn of buttonsAfterSecondRender) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// [m16.5c-TV-2] BITES: stale feedback cleared on offer-state change (statusLabel changes)
//
// Procedure:
//   1. Construct TradeView, show()
//   2. render() with statusLabel='Offer received', actions=['accept','reject']
//   3. showFeedback('Trade accepted!')
//   4. Verify #trade-feedback text is 'Trade accepted!'
//   5. render() again with SAME statusLabel='Offer received' (same state)
//   6. Verify feedback STILL 'Trade accepted!' — no clear on SAME state (intentional)
//   7. render() with CHANGED statusLabel='Accepted — awaiting confirmation'
//   8. Verify #trade-feedback is now EMPTY (cleared on state change)
//
// Why it's RED before fix:
//   render() never touches #feedbackEl.  After step 7, the statusLabel in
//   #trade-status updates to 'Accepted — awaiting confirmation', but
//   #trade-feedback still shows 'Trade accepted!' from step 3.  Misleading UX.
//   After fix: render() tracks the previous statusLabel; on change, it clears
//   #feedbackEl.textContent before applying the new VM state.
// ---------------------------------------------------------------------------
describe('TradeView [m16.5c-TV-2]: stale feedback cleared when offer statusLabel changes', () => {
  it('BITES: feedback persists on same-status re-render but clears when statusLabel changes', () => {
    const overlay = mountTradeOverlay();
    const cbs = makeCallbacks();
    const view = new TradeView(cbs);

    view.show();

    // Step 2: initial render — statusLabel='Offer received'
    const vmPending = makePendingTradeVM('Offer received', ['accept', 'reject']);
    view.render(vmPending);

    // Step 3: show feedback (e.g. from a prior accept action response)
    view.showFeedback('Trade accepted!');

    const feedbackEl = document.getElementById('trade-feedback')!;

    // Step 4: feedback must be visible
    expect(feedbackEl.textContent).toBe('Trade accepted!');

    // Step 5: re-render with SAME statusLabel — feedback must NOT be cleared
    view.render(vmPending);

    // Step 6: same state → feedback preserved (no clear on same state)
    expect(feedbackEl.textContent).toBe('Trade accepted!');

    // Step 7: re-render with CHANGED statusLabel (server advanced offer)
    const vmConfirmed = makePendingTradeVM('Accepted — awaiting confirmation', ['cancel']);
    view.render(vmConfirmed);

    // Step 8: BITES — without fix, 'Trade accepted!' still visible.
    // After fix: #feedbackEl is cleared when statusLabel changes.
    expect(feedbackEl.textContent).toBe('');

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// [m16.5c-TV-3] BITES: feedback cleared when offer transitions from no-trade to trade
//
// Procedure:
//   1. Construct TradeView, show()
//   2. render() with kind='no-trade'
//   3. showFeedback('stale!') directly (simulate feedback from a prior trade session)
//   4. render() with kind='trade' (new offer appeared from server)
//   5. Verify #trade-feedback is empty (cleared on kind transition)
//
// Why it's RED before fix:
//   render() for kind='no-trade' exits early at line 77 without touching #feedbackEl.
//   render() for kind='trade' also never touches #feedbackEl.  So 'stale!' stays
//   visible even after the new offer is shown with fresh buttons.
//   After fix: any state transition (including no-trade→trade) clears #feedbackEl.
// ---------------------------------------------------------------------------
describe('TradeView [m16.5c-TV-3]: feedback cleared on kind transition no-trade→trade', () => {
  it('BITES: stale feedback from prior session must be cleared when new offer arrives', () => {
    const overlay = mountTradeOverlay();
    const cbs = makeCallbacks();
    const view = new TradeView(cbs);

    view.show();

    // Step 2: render no-trade state (offer was cancelled or never existed)
    view.render(makeNoTradeVM());

    // Step 3: inject stale feedback (this simulates a message set during a prior
    // trade session — e.g. the player saw "Trade accepted!" but then the server
    // removed the offer and the overlay is still open)
    view.showFeedback('stale!');

    const feedbackEl = document.getElementById('trade-feedback')!;
    expect(feedbackEl.textContent).toBe('stale!'); // precondition

    // Step 4: new offer arrives from server — render with kind='trade'
    const vmNewOffer = makePendingTradeVM('Offer received', ['accept', 'reject']);
    view.render(vmNewOffer);

    // Step 5: BITES — without fix, 'stale!' persists because render() never
    // clears #feedbackEl.  After fix: the kind transition clears the element.
    expect(feedbackEl.textContent).toBe('');

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// [m16.5c-TV-4] BITES: buttons re-enabled after Promise resolves post mid-flight render
//
// Invariant: after a reducer Promise settles (success or error), ALL currently
// visible trade action buttons must be enabled (disabled=false) and #pending must
// be false.  A mid-flight render() between click and Promise settlement replaces
// the old button DOM elements with fresh ones (innerHTML=''), so the `finally`
// block's `btn.disabled = false` targets a DETACHED (orphaned) element and has no
// effect on the newly-rendered buttons — they remain permanently disabled=true
// even though #pending has been reset to false.
//
// Repro path (normal SpacetimeDB flow):
//   click → server commit → row update batch → store.flushBatch() → render() [mid-flight]
//   → Promise resolves → finally() → #pending=false + orphaned btn.disabled=false
//   → newly-rendered buttons permanently stuck at disabled=true → UI deadlock
//
// Procedure:
//   1. Construct TradeView, show(), render() with ['accept','reject'] buttons.
//   2. Click the first button.  Callback returns a Promise that we resolve manually.
//   3. BEFORE resolving, call render() again (simulates mid-flight batch update).
//   4. Verify new buttons are disabled=true (mid-flight guard, also verified by TV-1).
//   5. Resolve the callback Promise (simulates server response arriving).
//   6. Await a microtask flush so finally() runs (Promise.resolve().then().then()
//      requires two microtask ticks: one for the resolution, one for finally).
//   7. Assert ALL buttons in #trade-actions are disabled=false and #pending=false.
//
// BITES: kills any impl where finally() only resets the captured btn reference
//   (which is now a detached DOM element) without re-enabling the buttons that
//   are currently live in the DOM.
// ---------------------------------------------------------------------------
describe('TradeView [m16.5c-TV-4]: buttons re-enabled after Promise resolves post mid-flight render', () => {
  it('BITES: after mid-flight render + Promise resolve, live buttons must be disabled=false', async () => {
    const overlay = mountTradeOverlay();

    // A resolvable Promise: we hold the resolve handle to trigger settlement manually.
    let resolveCallback!: () => void;
    const resolvablePromise = new Promise<void>((res) => {
      resolveCallback = res;
    });

    const cbs: TradeCallbacks = {
      onAccept: vi.fn(() => resolvablePromise),
      onReject: vi.fn(() => resolvablePromise),
      onConfirm: vi.fn(() => resolvablePromise),
      onCancel: vi.fn(() => resolvablePromise),
    };

    const view = new TradeView(cbs);
    view.show();

    const vm = makePendingTradeVM('Offer received', ['accept', 'reject']);

    // Step 1: initial render — buttons start enabled.
    view.render(vm);

    const actionsEl = document.getElementById('trade-actions')!;
    const firstButtons = actionsEl.querySelectorAll('button');
    expect(firstButtons.length).toBeGreaterThan(0);

    // Step 2: click — sets #pending=true, dispatches resolvablePromise.
    (firstButtons[0] as HTMLButtonElement).click();

    // Step 3: mid-flight render while Promise is still in-flight.
    // Simulates a store.flushBatch() triggered by the server's row update
    // arriving before the reducer Promise resolves.
    view.render(vm);

    // Step 4: new buttons are disabled (TV-1 guard — confirmed).
    const midFlightButtons = actionsEl.querySelectorAll('button');
    expect(midFlightButtons.length).toBeGreaterThan(0);
    for (const btn of midFlightButtons) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }

    // Step 5: resolve the Promise (server responded successfully).
    resolveCallback();

    // Step 6: flush microtasks so finally() runs.
    await Promise.resolve();
    await Promise.resolve();

    // Step 7: BITES — without fix, buttons remain disabled=true because finally()
    // targeted the now-detached first-render button reference.
    // After fix: finally() re-enables the CURRENTLY LIVE buttons (or triggers
    // a re-render that creates them with disabled=false).
    const afterResolveButtons = actionsEl.querySelectorAll('button');
    expect(afterResolveButtons.length).toBeGreaterThan(0);
    for (const btn of afterResolveButtons) {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    }

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// m23-s3 — overlay a11y wiring on the show()/hide() edge (ADDITIVE; see the file header)
// ---------------------------------------------------------------------------

const S3_ID: OverlayId = 'tradeView';
const S3_META = OVERLAY_A11Y[S3_ID];

/** A focusable OUTSIDE the overlay: the "pre-overlay" element a close must restore focus to. */
function s3OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root — render() only rebuilds the
 *  side/action containers, so if this loses focus something RE-OPENED the overlay. */
function s3InsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

describe('TradeView — overlay a11y wiring on the show/hide edge (m23-s3)', () => {
  it('S3-tradeView-OPEN-ARIA BITES: the first show() from a display:none shell labels the root from OVERLAY_A11Y/t()', () => {
    const overlay = mountTradeOverlay();
    const view = new TradeView(makeCallbacks());

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
      'THE tooth: role/aria-modal are static literals in index.html:36 and pass a view that calls ' +
        'nothing; aria-label is absent from every shell, so only a real open can produce it — and ' +
        'because all 16 catalog values are distinct, this also kills the wrong-OverlayId impl',
    ).toBe(t(S3_META.labelKey));
  });

  it('S3-tradeView-DEFER-FOCUS BITES: both polarities — NOT focused synchronously, focused after ONE real macrotask, and the defer is owned by openOverlayA11y', async () => {
    const overlay = mountTradeOverlay();
    const target = overlay.querySelector<HTMLElement>(S3_META.initialFocusSelector);
    expect(target, `the fixture must contain ${S3_META.initialFocusSelector}`).not.toBeNull();
    const view = new TradeView(makeCallbacks());

    view.show();

    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );
    expect(
      vi.mocked(openOverlayA11y),
      'the deferred focus must be scheduled by openOverlayA11y, not by the view (A11Y-15)',
    ).toHaveBeenCalledTimes(1);

    await flushMacrotask();

    // IDENTITY, never `root.contains(activeElement)` — that passes on any decorative wrapper.
    expect(document.activeElement).toBe(target);
  });

  it('S3-tradeView-CLOSE-RESTORE BITES: hide() strips role, aria-modal AND aria-label from the root and hands focus back to the pre-overlay element', async () => {
    const overlay = mountTradeOverlay();
    const outside = s3OutsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const view = new TradeView(makeCallbacks());
    view.show();
    await flushMacrotask();
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

  it('S3-tradeView-REPEAT-NO-REOPEN BITES: show() on an ALREADY-visible overlay neither re-opens nor yanks focus back', async () => {
    // A re-open clears and re-schedules the deferred-focus timer (ui/overlayA11y.ts:100-113).
    // INVISIBLE to every attribute assertion, so it is proven twice: by a call COUNT and by the
    // sentinel still holding focus.
    const overlay = mountTradeOverlay();
    const view = new TradeView(makeCallbacks());

    view.show();
    await flushMacrotask();

    const inside = s3InsideSentinel(overlay);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.show();
    await flushMacrotask();

    expect(document.activeElement, 'a repeat show() must NOT re-run the deferred focus').toBe(
      inside,
    );
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S3-tradeView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    // THE MECHANISM ORACLE (plan A3): a view that hand-writes the three attributes with the correct
    // copied literal passes every VALUE assertion here while shipping NO trap, NO return-focus
    // record and NO timer. The literal `null` pins ADR-0205 A3 / plan D8.
    const overlay = mountTradeOverlay();
    const view = new TradeView(makeCallbacks());

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S3_ID, overlay);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);
  });
});
