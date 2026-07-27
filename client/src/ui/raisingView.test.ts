// @vitest-environment happy-dom
// ui/raisingView.test.ts — RED gating tests for feel-polish D1 care feedback (ADR-0159).
//
// SOURCE OF TRUTH: EARS criterion "WHEN the player presses the care-button/action,
// THE UI SHALL show a visible confirmation (toast, animation, or stat-delta
// feedback)." + docs/adr/0159-feel-polish-care-feedback-npc-wander.md D1.
//
// STATUS UPDATE (post-implementation code review): RaisingView has since shipped
// `#raising-feedback` (constructor-appended inside the overlay root, textContent-only)
// and the Care button's `#pending`/disabled re-entrancy guard. Re-verified against the
// current source: every test below (C1-C5) is GREEN against the shipped
// raisingView.ts — code review found no issues in this file; the one open finding
// (stale feedback into a hidden overlay) is a main.ts WIRING bug (the injected
// showFeedback callback has no visibility guard), not a defect in RaisingView itself,
// and is gated separately by main.wiring.test.ts's W-CARE-SHOWFEEDBACK-VISIBLE-GUARD
// and careAction.test.ts's visibility-agnostic pins. This file's original RED reason
// (RaisingView had no showFeedback()/no #pending guard at all) no longer applies; the
// tests below now function as regression guards proving the shipped behaviour holds.
//
// This file did not exist before this change — RaisingView had no unit test file
// (it is currently listed in vite.config.ts coverage.exclude as a "thin DOM shell";
// this suite exercises its new feedback surface directly regardless of that
// coverage-reporting exclusion, which this file does NOT touch).
//
// Pattern follows the sibling idiom EXACTLY (renameView.test.ts / shopView.test.ts /
// tradeProposeView.test.ts): happy-dom environment, DOM fixture built in
// beforeEach, vi.fn() callbacks, assertions on textContent/disabled/containment.
// RaisingView differs from those siblings in one respect: it builds its ENTIRE DOM
// tree via document.createElement in its OWN constructor (raisingView.ts:27-58) —
// there is no static index.html markup to mount, so the fixture below is just an
// empty mount-point `<div>` passed as `parent` to `new RaisingView(parent, cbs)`.
//
// WRONG-IMPL-KILLED list (one per criterion):
//   C1 (showFeedback writes the message)      -> no-op showFeedback impl
//   C2 (CONTAINMENT — the real shipped bug)    -> feedback node appended OUTSIDE the
//                                                 z-index:100 overlay root (the exact
//                                                 statusEl bug this ADR fixes)
//   C3 (no markup injection)                   -> an innerHTML regression (XSS via a
//                                                 server-supplied SenderError string)
//   C4 (re-entrancy guard)                     -> a Care button with no #pending lock
//                                                 (double-click fires two care calls,
//                                                 producing the contradictory
//                                                 "Cared!" -> "care cooldown not yet
//                                                 elapsed" flash)
//   C5 (Care still calls back with monsterId)  -> regression frame around the
//                                                 pre-existing button behaviour
//
// Do NOT edit these tests to match a buggy implementation — corrections must trace
// to ADR-0159 D1 only, never to the code under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaisingViewModel } from './raisingModel';
import type { RaisingViewCallbacks } from './raisingView';
import { RaisingView } from './raisingView';

// ---------------------------------------------------------------------------
// DOM fixture — RaisingView builds its own tree; the fixture is just a mount point.
// happy-dom shares ONE document across the whole file; wipe the body each time so a
// failed test's leftover overlay never bleeds into the next test's lookups.
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mountParent(): HTMLElement {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return parent;
}

function makeCallbacks(overrides: Partial<RaisingViewCallbacks> = {}): RaisingViewCallbacks {
  return {
    onTrain: vi.fn(),
    onCare: vi.fn(),
    ...overrides,
  };
}

// One monster, zero items — keeps the rendered DOM to exactly ONE <button> (Care),
// so `querySelector('button')` unambiguously finds the Care button in the C4/C5
// tests regardless of how the implementer lays out the feedback node.
function oneMonsterVm(monsterId: bigint): RaisingViewModel {
  return {
    monsters: [
      {
        monsterId,
        nickname: 'Aria',
        level: 5,
        bond: 10,
        currentHp: 20,
        statHp: 20,
        statAttack: 5,
        statDefense: 5,
        statSpeed: 5,
        statSpAttack: 5,
        statSpDefense: 5,
      },
    ],
    items: [],
  };
}

// The overlay root is the SOLE child RaisingView appends into `parent` at
// construction time (raisingView.ts:58 `parent.appendChild(this.#root)`) — grabbing
// `parent.firstElementChild` gets the real overlay root regardless of what internal
// feedback node the implementer adds (the C2 containment tooth below).
function overlayRootOf(parent: HTMLElement): HTMLElement {
  const root = parent.firstElementChild;
  if (root === null) {
    throw new Error('RaisingView did not append an overlay root into parent');
  }
  return root as HTMLElement;
}

// Drain the microtask queue for .finally()-driven pending-lock resets
// (renameView.test.ts / shopView.test.ts precedent).
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// C1: showFeedback writes the message into the feedback node's textContent.
// ---------------------------------------------------------------------------

describe('RaisingView showFeedback(): writes the message (C1, ADR-0159 D1)', () => {
  it('C1 BITES: showFeedback("Cared!") puts "Cared!" in #raising-feedback textContent — kills no-op impl', () => {
    // WRONG IMPL KILLED: an impl where showFeedback() is a no-op, or writes to the
    // wrong element, or is missing entirely (TypeError — the RED reason today).
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());

    view.showFeedback('Cared!');

    const feedbackEl = document.getElementById('raising-feedback');
    expect(
      feedbackEl,
      'RaisingView must create a #raising-feedback node (ADR-0159 D1)',
    ).not.toBeNull();
    expect(feedbackEl!.textContent).toBe('Cared!');
  });
});

// ---------------------------------------------------------------------------
// C2: CONTAINMENT — the tooth that kills the ACTUAL shipped bug. The feedback node
// must be a descendant of the raising overlay root (position:fixed; inset:0;
// z-index:100), never a sibling node like statusEl that the overlay paints over.
// ---------------------------------------------------------------------------

describe('★ RaisingView showFeedback(): CONTAINMENT — feedback node is inside the overlay root (C2, ADR-0159 D1)', () => {
  it('★ C2 BITES: the #raising-feedback node is a DESCENDANT of the overlay root — kills the exact shipped bug (a node OUTSIDE the z-index:100 overlay, invisible behind it)', () => {
    // WRONG IMPL KILLED: an impl that writes feedback to a node appended to `document.body`
    // (or reuses main.ts's `statusEl`) instead of INSIDE the RaisingView's own overlay root.
    // The raising overlay is `position:fixed; inset:0; z-index:100` (raisingView.ts:28-31) —
    // a message written OUTSIDE it is painted over and invisible, exactly like the
    // pre-fix statusEl bug this ADR fixes. A textContent-only assertion on a node found
    // by getElementById alone would NOT catch this (the node could exist anywhere in the
    // document and still satisfy a naive "does the text appear somewhere" check) — the
    // `.contains()` assertion is what makes this bite.
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());

    view.showFeedback('Cared!');

    const overlayRoot = overlayRootOf(parent);
    const feedbackEl = document.getElementById('raising-feedback');
    expect(feedbackEl, '#raising-feedback must exist').not.toBeNull();
    expect(
      overlayRoot.contains(feedbackEl!),
      'the feedback node must be a DESCENDANT of the raising overlay root — a node appended ' +
        'outside the overlay (e.g. a bare document.body child, or reusing main.ts statusEl) is ' +
        'painted over by the fixed/z-index:100 overlay and is never visible to the player',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C3: NO MARKUP INJECTION — server-supplied SenderError text (which can carry
// player-adjacent or arbitrary strings) must render as literal text, never markup.
// ---------------------------------------------------------------------------

describe('★ RaisingView showFeedback(): NO markup injection — textContent only (C3, ADR-0159 D1)', () => {
  it('★ C3 BITES: showFeedback with an HTML-looking string leaves literal text and ZERO element children — kills an innerHTML regression (XSS)', () => {
    // WRONG IMPL KILLED: an impl that writes `el.innerHTML = message` instead of
    // `el.textContent = message`. The message can carry a server-supplied SenderError
    // reason string (reduceErrorMessage(err, 'care')) — innerHTML would let an
    // attacker-crafted or malformed server string execute as markup/script.
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());
    const payload = '<img src=x onerror=alert(1)>';

    view.showFeedback(payload);

    const feedbackEl = document.getElementById('raising-feedback');
    expect(feedbackEl, '#raising-feedback must exist').not.toBeNull();
    expect(
      feedbackEl!.textContent,
      'the raw string must be preserved verbatim as literal text',
    ).toBe(payload);
    expect(
      feedbackEl!.children.length,
      'the feedback node must have ZERO element children — an innerHTML write would parse ' +
        '<img> into a real element child',
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C4: RE-ENTRANCY GUARD — the Care button gains the #pending/disabled lock already
// shipped on shopView/renameView, so a double-click cannot fire two care calls.
// ---------------------------------------------------------------------------

describe('★ RaisingView Care button: re-entrancy guard (C4, ADR-0159 D1)', () => {
  it('★ C4 BITES: two rapid Care clicks before the first call settles invoke onCare exactly ONCE, and the button is disabled while pending — kills missing-#pending-lock impl', async () => {
    // WRONG IMPL KILLED: a Care button with no #pending lock (the CURRENT shipped
    // shape — raisingView.ts:120-124 calls `this.#callbacks.onCare(mon.monsterId)`
    // directly on every click, unconditionally). Without the guard, a double-click
    // fires onCare TWICE before the first reducer call settles — the exact
    // contradictory "Cared!" -> "care cooldown not yet elapsed" flash ADR-0159 D1
    // exists to prevent.
    let resolveFlight: (() => void) | undefined;
    const flightPromise = new Promise<void>((res) => {
      resolveFlight = res;
    });
    // onCare is typed `(monsterId: bigint) => void`, but (shopView/renameView
    // precedent) the guard implementation is expected to wrap the callback's return
    // value via `Promise.resolve(this.#cbs.onCare(...)).finally(...)` so a caller that
    // genuinely returns a pending Promise keeps the lock held until it settles.
    const onCare = vi.fn().mockReturnValue(flightPromise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.refresh(oneMonsterVm(7n));

    const careBtn = overlayRootOf(parent).querySelector('button') as HTMLButtonElement;
    expect(careBtn, 'the Care button must exist after refresh()').toBeTruthy();

    careBtn.click(); // first click — initiates the in-flight call
    careBtn.click(); // second click while still in-flight — must be a no-op

    expect(
      onCare,
      'onCare must be called exactly once despite two rapid clicks (#pending re-entrancy lock)',
    ).toHaveBeenCalledOnce();
    expect(careBtn.disabled, 'the Care button must be disabled while a care call is pending').toBe(
      true,
    );

    resolveFlight?.();
    await flushPromises();

    expect(
      careBtn.disabled,
      'the Care button must be re-enabled once the pending call settles (no dead-button-forever)',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C5: regression frame — Care still calls back with the correct monsterId.
// ---------------------------------------------------------------------------

describe('RaisingView Care button: calls onCare with the correct monsterId (C5, regression)', () => {
  it('C5: clicking Care invokes onCare exactly once, with the monsterId from the rendered VM — kills a wrong-id/no-call regression', () => {
    const onCare = vi.fn();
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.refresh(oneMonsterVm(42n));

    const careBtn = overlayRootOf(parent).querySelector('button') as HTMLButtonElement;
    expect(careBtn, 'the Care button must exist after refresh()').toBeTruthy();

    careBtn.click();

    expect(onCare).toHaveBeenCalledOnce();
    expect(onCare).toHaveBeenCalledWith(42n);
  });
});
