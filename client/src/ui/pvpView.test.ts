// @vitest-environment happy-dom
// ui/pvpView.test.ts — m23-s3 RED gating tests for the show()/hide() overlay a11y wiring on the
// view that owns THE CRUX of this slice (the repeat-show() focus steal), plus the pre-existing
// refresh() behaviour this file is the first spec to pin at all.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/15/16);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1/F2/F6/F7, §1 D1/D2/D4/D7/D8, §4, §7 A1/A3/A6/A7/A8;
//   memory/projects/gates/m23-s3.gates.md X1/X2/X3/X6/X8;
//   docs/adr/0205-overlay-a11y-metadata-ssot-and-copy-catalog.md D1-D4, A3; ADR-0110 D6;
//   ui/overlayA11y.ts (the S1 helper this view must DELEGATE to), ui/overlayRegistry.ts (OVERLAY_A11Y).
//
// RED REASON: `client/src/ui/pvpView.ts` DOES NOT CALL openOverlayA11y/closeOverlayA11y AT ALL
// today — the file is byte-unchanged from master @0953db7. Every S3-* test below therefore fails now:
// no aria-label is ever written, nothing schedules a focus, role/aria-modal survive a close (only
// closeOverlayA11y strips them), and every `toHaveBeenCalledTimes(...)` on the spied helpers is 0.
// The NON-S3 tests in this file (refresh behaviour) pass NOW and must keep passing.
//
// WHY pvpView OWNS THE CRUX (plan F6, gate X6). `main.ts:1697-1709` recomputes `forceVisible` on
// EVERY store batch and, once the overlay is up, keeps it true — and `refresh()` calls `show()`
// UNGUARDED while already visible (ui/pvpView.ts:93). A `show()` that delegates to
// `openOverlayA11y` without an edge guard therefore clears and re-schedules the deferred-focus
// timer every tick (ui/overlayA11y.ts:100-113): focus is yanked back to `#pvp-challenge-status`
// several times a second and the overlay is untabbable. That failure mode is INVISIBLE to every
// attribute assertion (a re-open rewrites byte-identical values), so it is proven twice below —
// once by a call COUNT, once by parking focus on a sentinel INSIDE the root and checking it is
// still there. `refresh()` itself must stay BYTE-UNCHANGED (plan T7); the guard belongs in `show()`.
//
// pvpView ALSO KEEPS ITS OWN `#visible` FIELD (plan D4), and that is a main.ts contract, not an
// accident: `overlayProbes.pvpView` (main.ts:335), the auto-show predicate (main.ts:1700) and
// `refresh`'s own `if (this.#visible) this.hide()` all read it. The edge must be read from
// `this.#visible` BEFORE the two writes in `show()` — reading it AFTER makes the guard a constant
// and produces a GREEN behavioural suite (plan anti-pattern #4).
//
// TWO ORACLES, BOTH REQUIRED (plan A3, measured by red-team):
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['pvpView'].labelKey)`. `role`/`aria-modal` are
//     ALREADY static literals on every shell in client/index.html:44 (m23-s2), so asserting them
//     ALONE is VACUOUS: a view that calls nothing passes. They appear here only in the same it() as
//     aria-label, and their ABSENCE after close is the anti-vacuity partner.
//   * MECHANISM oracle — `vi.mock('./overlayA11y', { spy: true })` records the calls AND calls
//     through to the real implementation. A cheat that hand-writes the three attributes with the
//     correct copied literal passes the VALUE oracle while shipping no trap, no return-focus record
//     and no timer; only the call assertion reds it, and the id argument simultaneously kills the
//     copy-pasted-wrong-OverlayId impl (all 16 catalog values are distinct, plan F2).
//
// TEST-ISOLATION DEVICE (plan A8 / V7, copied from ui/overlayA11y.test.ts:97-105 — deliberate, not
// boilerplate): overlayA11y.ts holds ONE module-private Map<OverlayId, record> and exports no reset
// hook (a zero-consumer production export is banned by that module family's A7/A15 rule,
// ui/overlayRegistry.ts:24-30), so beforeEach/afterEach call the PRODUCTION closeOverlayA11y(id,null)
// for every OverlayId and flush ONE REAL MACROTASK. That is legal precisely because
// close-without-open is a documented no-op (ui/overlayA11y.ts:41-45, gated by
// S1-CLOSE-WITHOUT-OPEN-NOOP). It also cancels any pending deferred-focus timer a test deliberately
// left dangling. `vi.clearAllMocks()` runs LAST in beforeEach so the sweep's own close calls never
// pollute a test's call counts.
//
// NEVER FAKE TIMERS (plan anti-pattern #10): the defer is a REAL setTimeout(...,0) by design
// (ui/overlayA11y.ts:17-20); it is flushed with `await new Promise((r) => setTimeout(r, 0))`.
//
// FIXTURE FIDELITY: the overlay root is byte-copied from client/index.html:44-50, INCLUDING
// `style="display:none"`, the static `role`/`aria-modal` literals (without them the "attributes
// absent after close" tooth is vacuous — attack V1) and the `tabindex="-1"` anchor. The tabindex
// buys ZERO test power (plan A7: happy-dom's .focus() moves activeElement onto a bare <div> with no
// tabindex at all — it does not model focusability); it is copied for fidelity only.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.
//
// WRONG-IMPL-KILLED index:
//   - never opens at all / attribute-only cheat          -> S3-pvpView-OPEN-ARIA + -HELPER-CALLED
//   - copy-pasted WRONG OverlayId                        -> S3-pvpView-OPEN-ARIA (label) + -HELPER-CALLED (id arg)
//   - synchronous focus (no defer)                       -> S3-pvpView-DEFER-FOCUS (negative polarity)
//   - focuses nothing / a wrapper instead of the anchor   -> S3-pvpView-DEFER-FOCUS (identity, positive polarity)
//   - close never strips ARIA / never restores focus      -> S3-pvpView-CLOSE-RESTORE
//   - UNGUARDED show() (THE CRUX)                         -> S3-pvpView-REPEAT-NO-REOPEN + S3-pvpView-REFRESH-NO-REOPEN
//   - `this.#visible` read AFTER the writes (guard becomes a constant) -> the same two tests
//   - `fallbackFocus` passed as undefined/an element       -> S3-pvpView-HELPER-CALLED (literal null, D8/A6)
//   - refresh() regressions (auto-show, stale rows, callbacks) -> the refresh-behaviour block

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import type { PvpChallengeViewModel } from './pvpModel';
import { PvpView, type PvpViewCallbacks } from './pvpView';

// The MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works in the
// same test. Measured working in this repo's vitest 4 (plan §7 "Verified mechanics").
vi.mock('./overlayA11y', { spy: true });

const ID: OverlayId = 'pvpView';
const META = OVERLAY_A11Y[ID];

// ---------------------------------------------------------------------------
// Fixture + helpers
// ---------------------------------------------------------------------------

/** Byte-copy of client/index.html:44-50 — the shell PvpView binds to. */
function mountPvpOverlay(): HTMLElement {
  document.body.innerHTML = `
    <div id="pvp-challenge-overlay" role="dialog" aria-modal="true" style="display:none">
      <div id="pvp-challenge-status" tabindex="-1"></div>
      <div id="pvp-challenge-incoming"></div>
      <div id="pvp-challenge-outgoing"></div>
      <ul id="pvp-player-list"></ul>
      <div id="pvp-challenge-feedback"></div>
    </div>
  `;
  return document.getElementById('pvp-challenge-overlay') as HTMLElement;
}

/** One REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A focusable OUTSIDE the overlay: the "pre-overlay" element a close must restore focus to. */
function addOutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root. refresh() only calls
 *  replaceChildren() on #pvp-challenge-incoming, #pvp-challenge-outgoing and #pvp-player-list, so
 *  this node survives every refresh. If it loses focus, something RE-OPENED the overlay and re-ran
 *  the deferred initial focus. */
function addInsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

function makeCallbacks(): PvpViewCallbacks {
  return {
    onAccept: vi.fn(),
    onDecline: vi.fn(),
    onCancel: vi.fn(),
    onChallenge: vi.fn(),
  };
}

function pvpVm(overrides: Partial<PvpChallengeViewModel> = {}): PvpChallengeViewModel {
  return {
    incoming: null,
    outgoing: null,
    challengeablePlayers: [],
    ...overrides,
  };
}

beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
  // LAST: the sweep above calls the spied close; clearing after it keeps per-test counts honest.
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// m23-s3 — overlay a11y wiring on the show()/hide() edge
// ---------------------------------------------------------------------------

describe('PvpView — overlay a11y wiring on the show/hide edge (m23-s3)', () => {
  it('S3-pvpView-OPEN-ARIA BITES: the first show() from a hidden shell labels the root from OVERLAY_A11Y/t(), and the view really starts hidden', () => {
    const root = mountPvpOverlay();
    const view = new PvpView(makeCallbacks());

    // VACUITY ATTACK V4, closed here. For pvpView the edge source is the `#visible` FIELD (plan
    // D4), not a DOM read — so both are pinned: the field must start false (otherwise the first
    // show() is a no-edge and every open assertion below is silently vacuous), and the shell must
    // really carry index.html's `style="display:none"`.
    expect(view.visible, 'V4: the view must start hidden, so the first show() IS an edge').toBe(
      false,
    );
    expect(root.style.display, 'V4: the fixture must copy index.html:44 display:none').toBe('none');

    view.show();

    // Every expectation is DERIVED from the table at assert time — never a literal (V5).
    // WRONG IMPL KILLED: a hardcoded 'PvP Challenge'/'dialog' pair reds the day the catalog
    // changes; a copy-pasted WRONG OverlayId reds NOW (all 16 catalog values are distinct, F2).
    expect(root.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(META.role);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(
      root.getAttribute('aria-label'),
      'THE tooth: role/aria-modal are static literals in index.html:44 and pass a view that calls ' +
        'nothing; aria-label is absent from every shell, so only a real open can produce it',
    ).toBe(t(META.labelKey));
  });

  it('S3-pvpView-DEFER-FOCUS BITES: both polarities — NOT focused synchronously, focused after ONE real macrotask, and the defer is owned by openOverlayA11y', async () => {
    const root = mountPvpOverlay();
    const target = root.querySelector<HTMLElement>(META.initialFocusSelector);
    expect(target, `the fixture must contain ${META.initialFocusSelector}`).not.toBeNull();
    const view = new PvpView(makeCallbacks());

    view.show();

    // NEGATIVE polarity. WRONG IMPL KILLED: a synchronous focus reintroduces the exact bug the
    // defer exists to avoid (ui/overlayA11y.ts:9-15) — the letter that OPENED the overlay (KeyP
    // here) lands in the thing it just opened.
    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );

    // The defer must come from the S1 helper, not from a view-local setTimeout (A11Y-15).
    expect(
      vi.mocked(openOverlayA11y),
      'the deferred focus must be scheduled by openOverlayA11y, not by the view',
    ).toHaveBeenCalledTimes(1);

    await flushMacrotask();

    // POSITIVE polarity, by IDENTITY — never `root.contains(activeElement)`, which passes on any
    // decorative wrapper. WRONG IMPL KILLED: an impl that focuses the root itself, or nothing.
    expect(document.activeElement).toBe(target);
  });

  it('S3-pvpView-CLOSE-RESTORE BITES: hide() strips role, aria-modal AND aria-label from the root and hands focus back to the pre-overlay element', async () => {
    const root = mountPvpOverlay();
    const outside = addOutsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const view = new PvpView(makeCallbacks());
    view.show();
    await flushMacrotask();
    expect(
      document.activeElement,
      'precondition: the open moved focus INTO the overlay, so the restore below is a real move',
    ).not.toBe(outside);

    view.hide();

    // VACUITY ATTACK V1, closed here: index.html ships role/aria-modal as STATIC LITERALS, so the
    // only way they can be ABSENT is if closeOverlayA11y really ran (ui/overlayA11y.ts:142-144).
    // This is the anti-vacuity partner of S3-pvpView-OPEN-ARIA and it kills the "rely on the static
    // literals, call nothing" cheat outright.
    expect(
      root.getAttribute('role'),
      'a display:none node must not keep claiming to be a dialog',
    ).toBeNull();
    expect(root.getAttribute('aria-modal')).toBeNull();
    expect(root.getAttribute('aria-label')).toBeNull();

    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
  });

  it('S3-pvpView-REPEAT-NO-REOPEN BITES: show() on an ALREADY-visible overlay neither re-opens nor yanks focus back', async () => {
    // The direct form of the crux: main.ts's KeyP handler and refresh() both call show()
    // unconditionally. A guard that reads `this.#visible` AFTER the writes is a constant-true and
    // reds here; a guard that reads it BEFORE passes.
    const root = mountPvpOverlay();
    const view = new PvpView(makeCallbacks());

    view.show();
    await flushMacrotask();

    const inside = addInsideSentinel(root);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.show();
    await flushMacrotask();

    expect(
      document.activeElement,
      'a repeat show() must NOT re-run the deferred initial focus',
    ).toBe(inside);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S3-pvpView-REFRESH-NO-REOPEN BITES: three consecutive refresh(vm, true) calls produce EXACTLY ONE open and never steal focus back', async () => {
    // THE SLICE'S CRUX, through the exact production path (main.ts:1697-1709 -> refresh ->
    // ui/pvpView.ts:93's unguarded show()). Once the overlay is up, `forceVisible` stays true, so
    // this runs on EVERY store batch — several times a second while a challenge is live.
    // WRONG IMPL KILLED: an unguarded `openOverlayA11y` in show(); the player Tabs to the Accept
    // button and focus is dragged back to #pvp-challenge-status before they can press it.
    const root = mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    const vm = pvpVm({
      challengeablePlayers: [{ identity: '0xaaa1', name: 'Alice' }],
    });

    view.refresh(vm, true); // 1st — the open edge
    await flushMacrotask();

    const inside = addInsideSentinel(root);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.refresh(vm, true); // 2nd — a batch tick
    view.refresh(vm, true); // 3rd — another batch tick
    await flushMacrotask();

    expect(
      document.activeElement,
      'repeated refreshes must NOT drag focus back to the initial-focus anchor',
    ).toBe(inside);
    expect(
      vi.mocked(openOverlayA11y),
      'three refresh(vm, true) calls are ONE open edge, not three',
    ).toHaveBeenCalledTimes(1);
  });

  it('S3-pvpView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    // THE MECHANISM ORACLE (plan A3). Measured by red-team: a view that hand-writes
    // role/aria-modal/aria-label with the correct copied literal passes every VALUE assertion in
    // this file while shipping NO focus trap, NO return-focus record and NO deferred-focus timer.
    // Only this call assertion reds it. The id argument also kills the copy-pasted-wrong-id impl,
    // and the literal `null` pins ADR-0205 A3 / plan D8 (S3 views hold no canvas handle).
    const root = mountPvpOverlay();
    const view = new PvpView(makeCallbacks());

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(ID, root);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(ID, null);
  });
});

// ---------------------------------------------------------------------------
// Pre-existing refresh() behaviour — this file is the FIRST spec for pvpView, so the behaviour the
// S3 tests lean on (the caller-owned show/hide decision, the authoritative row rebuild, the
// callbacks) is pinned here rather than assumed. `refresh()` must stay BYTE-UNCHANGED in this slice
// (plan T7), so every test below passes on master TODAY and must keep passing afterwards.
// ---------------------------------------------------------------------------

describe('PvpView refresh(): existing behaviour (pinned, must stay byte-unchanged by m23-s3)', () => {
  it('BITES: refresh(vm, false) never auto-shows — the caller owns the show/hide decision (ADR-0110 D6)', () => {
    const root = mountPvpOverlay();
    const view = new PvpView(makeCallbacks());

    view.refresh(
      pvpVm({ incoming: { challengeId: 1n, challengerId: '0xbbb', challengerName: 'Bob' } }),
      false,
    );

    expect(view.visible, 'a pending challenge must NOT pop the overlay over a battle').toBe(false);
    expect(root.style.display).toBe('none');
  });

  it('BITES: refresh(vm, false) while visible hides the overlay', () => {
    const root = mountPvpOverlay();
    const view = new PvpView(makeCallbacks());

    view.refresh(pvpVm(), true);
    expect(view.visible).toBe(true);

    view.refresh(pvpVm(), false);
    expect(view.visible).toBe(false);
    expect(root.style.display).toBe('none');
  });

  it('BITES: refresh(vm, true) with an incoming challenge paints the label plus Accept/Decline, and the buttons dispatch the callbacks with the challengeId', () => {
    mountPvpOverlay();
    const cbs = makeCallbacks();
    const view = new PvpView(cbs);

    view.refresh(
      pvpVm({ incoming: { challengeId: 77n, challengerId: '0xbbb', challengerName: 'Bob' } }),
      true,
    );

    expect(view.visible).toBe(true);
    expect(document.getElementById('pvp-challenge-status')?.textContent).toBe('PvP Challenge');
    expect(document.querySelector('[data-testid="pvp-incoming-label"]')?.textContent).toBe(
      'Bob has challenged you!',
    );

    (document.querySelector('[data-testid="pvp-accept-btn"]') as HTMLButtonElement).click();
    expect(cbs.onAccept).toHaveBeenCalledWith(77n);

    (document.querySelector('[data-testid="pvp-decline-btn"]') as HTMLButtonElement).click();
    expect(cbs.onDecline).toHaveBeenCalledWith(77n);
  });

  it('BITES: refresh(null, true) shows the bare shell — status "PvP" and every dynamic container emptied', () => {
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());

    view.refresh(pvpVm({ challengeablePlayers: [{ identity: '0xaaa1', name: 'Alice' }] }), true);
    expect(
      (document.getElementById('pvp-player-list') as HTMLElement).querySelectorAll('button'),
    ).toHaveLength(1);

    view.refresh(null, true);

    expect(document.getElementById('pvp-challenge-status')?.textContent).toBe('PvP');
    expect(
      (document.getElementById('pvp-challenge-incoming') as HTMLElement).children,
    ).toHaveLength(0);
    expect(
      (document.getElementById('pvp-challenge-outgoing') as HTMLElement).children,
    ).toHaveLength(0);
    expect((document.getElementById('pvp-player-list') as HTMLElement).children).toHaveLength(0);
  });

  it('BITES: the challengeable-player list rebuilds authoritatively and each button dispatches onChallenge with the identity', () => {
    mountPvpOverlay();
    const cbs = makeCallbacks();
    const view = new PvpView(cbs);

    view.refresh(
      pvpVm({
        challengeablePlayers: [
          { identity: '0xaaa1', name: 'Alice' },
          { identity: '0xbbb2', name: 'Bob' },
        ],
      }),
      true,
    );
    const list = document.getElementById('pvp-player-list') as HTMLElement;
    let buttons = list.querySelectorAll('[data-testid="pvp-challenge-player-btn"]');
    expect(buttons).toHaveLength(2);

    (buttons[0] as HTMLButtonElement).click();
    expect(cbs.onChallenge).toHaveBeenCalledWith('0xaaa1');

    // A second refresh REPLACES the rows — a player who went offline must not linger.
    view.refresh(pvpVm({ challengeablePlayers: [{ identity: '0xccc3', name: 'Carol' }] }), true);
    buttons = list.querySelectorAll('[data-testid="pvp-challenge-player-btn"]');
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as HTMLElement).getAttribute('data-player-identity')).toBe('0xccc3');
  });

  it('BITES: hide() clears the feedback line, and showFeedback() writes it via textContent', () => {
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    const feedback = document.getElementById('pvp-challenge-feedback') as HTMLElement;

    view.show();
    view.showFeedback('Challenge sent!');
    expect(feedback.textContent).toBe('Challenge sent!');

    view.hide();
    expect(feedback.textContent).toBe('');
  });
});
