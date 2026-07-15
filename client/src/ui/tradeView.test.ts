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

import { describe, expect, it, vi } from 'vitest';
import type { TradeScreenViewModel } from './tradeModel';
import type { TradeCallbacks } from './tradeView';
import { TradeView } from './tradeView';

// ---------------------------------------------------------------------------
// DOM setup helper — mirrors the structure in client/index.html that TradeView
// expects.  Must be called before constructing TradeView in each test so the
// constructor querySelector calls succeed.
// ---------------------------------------------------------------------------
function mountTradeOverlay(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = 'trade-overlay';
  overlay.style.display = 'none';

  const statusEl = document.createElement('div');
  statusEl.id = 'trade-status';
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
