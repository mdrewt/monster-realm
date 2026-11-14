// @vitest-environment happy-dom
// ui/pvpView.test.ts — m23-s3 RED gating tests for the show()/hide() overlay a11y wiring on the
// view that owns THE CRUX of this slice (the repeat-show() focus steal), plus the pre-existing
// refresh() behaviour this file is the first spec to pin at all.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/15/16);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1/F2/F6/F7, §1 D1/D2/D4/D7/D8, §4, §7 A1/A3/A6/A7/A8;
//   memory/projects/gates/m23-s3.gates.md X1/X2/X3/X6/X8;
//   ui/overlayA11y.ts (the S1 helper this view must DELEGATE to), ui/overlayRegistry.ts (OVERLAY_A11Y).
//
// RED REASON: `client/src/ui/pvpView.ts` DOES NOT CALL openOverlayA11y/closeOverlayA11y AT ALL
// today — the file is byte-unchanged from master @0953db7. Every S3-* test below therefore fails now:
// no aria-label is ever written, nothing schedules a focus, role/aria-modal survive a close (only
// closeOverlayA11y strips them), and every `toHaveBeenCalledTimes(...)` on the spied helpers is 0.
// The NON-S3 tests in this file (refresh behaviour) pass NOW and must keep passing. (20r-a once
// made the Accept-then-Decline case await its view-wide lock between two clicks; qf-8 deleted
// those buttons and the lock, see the qf-8 block below.)
//
// WHY pvpView OWNS THE CRUX (plan F6, gate X6). `main.ts:1697-1709` recomputes `forceVisible` on
// EVERY store batch and, once the overlay is up, keeps it true — and `refresh()` calls `show()`
// UNGUARDED while already visible (ui/pvpView.ts:93). A `show()` that delegates to
// `openOverlayA11y` without an edge guard therefore clears and re-schedules the deferred-focus
// timer every tick (ui/overlayA11y.ts:100-113): focus is yanked back to `#pvp-challenge-status`
// several times a second and the overlay is untabbable. That failure mode is INVISIBLE to every
// attribute assertion (a re-open rewrites byte-identical values), so it is proven twice below —
// once by a call COUNT, once by parking focus on a sentinel INSIDE the root and checking it is
// still there. m23-s3 left `refresh()` byte-unchanged (its plan T7) and put the guard in `show()`;
// 20r-a later extended `refresh()` to RE-APPLY the in-flight lifecycle lock on every refresh
// (retired with the lock by qf-8) — the show()-edge guard still belongs in `show()`, and nothing
// here re-opens.
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
//   - GUARDED close in hide() (plan anti-pattern #3 — kills S1's A13 self-heal on the one view
//     whose close is driven by main.ts's overlayHandles force-hide path) -> S3-pvpView-CLOSE-UNGUARDED
//   - refresh() regressions (auto-show, stale rows, callbacks) -> the refresh-behaviour block
//
// qf-8 (QF8.1, QF8.2) NAMED REMOVALS. The incoming row's Accept / Decline buttons and the outgoing
// row's Cancel Challenge button are DELETED as a mouse-only duplicate of the Social sheet's
// Challenges rows (screens/socialScreen.ts: accept / decline on the incoming request, cancel on the
// outgoing one), with the view-wide lock, its settle re-anchor and the keyed per-container render
// whose only purpose was keeping those button nodes (and their focus) across batches (plan §1.3).
// The labels (`pvp-incoming-label`, `pvp-outgoing-label`) stay.
//   - the refresh-behaviour case "the buttons dispatch the callbacks with the challengeId" keeps
//     its label half and asserts no control; the null-shell case's precondition is the label;
//   - the 20r-a PV-1..PV-6 lock describe and the rb-121 settle re-anchor describe are RETIRED
//     (no control, no double-send; the reducers are the authority and the Social sheet holds no
//     lock by design). Survivors: reachability.test.ts [QF8-2-PVP-RETIRED] / [QF8-2-PVP-NATIVE]
//     (no lifecycle button anywhere; no click / pointer / key on any element reaches a
//     PvpViewCallbacks entry), screens/socialScreen.test.ts CTL8D-2-SHEET-CHALLENGE and
//     CTL8D-2-COMMANDS (the sheet's accept / decline / cancel commands), and the pointer route
//     reachability.test.ts [QF8-1-SOCIAL-CHALLENGE-POINTER];
//   - cifix0901: the node-identity / focus / lock teeth over the buttons are RETIRED with the keyed
//     render; the label-content teeth (the per-batch path, renamed, cleared, outgoing section,
//     direct hide, null shell, throw recovery) stay, retargeted from the buttons to the labels;
//   - m24s3 PV-01 / PV-02 lose `pvp.incoming.accept`, `pvp.incoming.decline`, `pvp.outgoing.cancel`
//     (also from M24S3_PV_PLAIN_KEYS); CTL8D-2-VIEW-CHALLENGE-CURSOR loses its button clicks;
//     CTL10B-2-PVP-NO-INITIATE now asserts no button in ANY state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreBattleChallenge, StorePlayer } from '../net/store';
import { t } from './a11yCopy';
import { t as i18nT, tf as i18nTf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import { buildPvpChallengeViewModel, type PvpChallengeViewModel } from './pvpModel';
import { PvpView, type PvpViewCallbacks } from './pvpView';

// The MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works in the
// same test. Measured working in this repo's vitest 4 (plan §7 "Verified mechanics").
vi.mock('./overlayA11y', { spy: true });
// m24s3 MECHANISM oracle, same shape: records every t()/tf() call AND calls
// through to the real resolver, so PV-01's DOM byte-identity assertions still work.
vi.mock('./i18n/resolver', { spy: true });

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
  };
}

function pvpVm(overrides: Partial<PvpChallengeViewModel> = {}): PvpChallengeViewModel {
  return {
    incoming: null,
    outgoing: null,
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
// Overlay a11y wiring on the show()/hide() edge
// ---------------------------------------------------------------------------

describe('PvpView — no view-owned message line (uif-4b, UIF4B.5)', () => {
  it('UIF4B.5 the view has no showFeedback (it had no caller: WF1-A5) and works with no #pvp-challenge-feedback node in the shell', () => {
    // INTENTIONAL CHANGE (uif-4b, UIF4B.5): `showFeedback` and the `#pvp-challenge-feedback` lookup
    // are retired (the line is gone from index.html with its roster row; challenge messages go
    // through the one seam). The mount below drops the node the shared fixture still carries, so a
    // constructor or refresh that needs it throws. Was: the view held the node and exposed a
    // `showFeedback` nothing called.
    // WRONG IMPL KILLED: a surviving showFeedback, and a constructor/refresh that still looks the
    // retired node up.
    const root = mountPvpOverlay();
    document.getElementById('pvp-challenge-feedback')?.remove();
    const view = new PvpView(makeCallbacks());
    expect(() => view.refresh(pvpVm(), false)).not.toThrow();
    expect('showFeedback' in view, 'no showFeedback on the view').toBe(false);
    expect(root.querySelector('#pvp-challenge-feedback'), 'and none is created').toBeNull();
  });
});

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
    // defer exists to avoid — the letter that OPENED the overlay (KeyP
    // here) lands in the thing it just opened.
    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );

    // The defer must come from the S1 helper, not from a view-local setTimeout.
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
    // only way they can be ABSENT is if closeOverlayA11y really ran.
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
    // WRONG IMPL KILLED: an unguarded `openOverlayA11y` in show(); the player Tabs to a control
    // in the overlay (since qf-8, the hosted Social sheet) and focus is dragged back to
    // #pvp-challenge-status before they can use it.
    const root = mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    const vm = pvpVm();

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

  it('S3-pvpView-CLOSE-UNGUARDED BITES: hide() calls the close UNCONDITIONALLY — on a never-opened view, and again on every repeat', () => {
    // Plan D2's deliberate asymmetry, and plan ANTI-PATTERN #3. Measured by red-team: wrapping
    // hide()'s close in `if (wasVisible)` ships with every other gate green — and pvpView is the
    // WORST place for it to ship. Two reasons, both specific to this view:
    //
    //   1. Its close is driven by main.ts's force-hide path (`overlayHandles[id]?.()`,
    //      main.ts:357-368 / plan R2), which is EXACTLY the desync D2 cites: if the record ever
    //      falls out of step with the DOM (S1's named A13 leak, ui/overlayA11y.ts:55-59), a guarded
    //      hide() reads false, skips the close, and the live capture listener + pending timer +
    //      stale return target become PERMANENT. Unguarded, hide() HEALS it.
    //   2. The guard would read `this.#visible` — a SECOND source of truth (plan D4) that main.ts
    //      also writes through `refresh()`. `refresh(vm, false)` ALREADY guards its own call
    //      (`if (this.#visible) this.hide()`, ui/pvpView.ts:89), so an internal guard is pure
    //      double-counting: it adds nothing on the normal path and removes the only self-heal.
    //
    // A close with no record is a documented pure no-op, so the
    // unconditional call risks nothing.
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    expect(view.visible, 'precondition: never opened').toBe(false);

    expect(() => view.hide()).not.toThrow();
    expect(
      vi.mocked(closeOverlayA11y),
      'hide() on a never-opened view MUST still call the close — a guarded hide calls it zero times',
    ).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(ID, null);

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
// Pre-existing refresh() behaviour — this file is the FIRST spec for pvpView, so the behaviour the
// S3 tests lean on (the caller-owned show/hide decision, the authoritative row rebuild when the
// view-model changes, the callbacks) is pinned here rather than assumed.
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

  it('BITES: refresh(vm, true) with an incoming challenge paints the status and the label, and no Accept / Decline control', () => {
    // qf-8 (NAMED REMOVAL): "the buttons dispatch the callbacks with the challengeId" clicked the
    // deleted Accept / Decline buttons. Survivor: screens/socialScreen.test.ts CTL8D-2-COMMANDS
    // (the sheet's accept / decline send the request's challengeId).
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
    expect(
      (document.getElementById('pvp-challenge-incoming') as HTMLElement).querySelectorAll('button'),
      'qf-8: the incoming row carries no control',
    ).toHaveLength(0);
  });

  it('BITES: refresh(null, true) shows the bare shell — status "PvP" and every dynamic container emptied', () => {
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());

    // NAMED INTENTIONAL CHANGE (ctl-10b, CTL10B.2): the precondition used the per-player Challenge
    // button; it then used the incoming row's Accept / Decline buttons.
    // NAMED INTENTIONAL CHANGE (qf-8): those buttons are deleted; the precondition is the label.
    view.refresh(
      pvpVm({ incoming: { challengeId: 77n, challengerId: '0xbbb', challengerName: 'Bob' } }),
      true,
    );
    expect(
      (document.getElementById('pvp-challenge-incoming') as HTMLElement).querySelectorAll(
        '[data-testid="pvp-incoming-label"]',
      ),
      'precondition: the incoming row is painted',
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

  // NAMED REMOVAL (ctl-10b, CTL10B.2): "the challengeable-player list rebuilds authoritatively and
  // each button dispatches onChallenge with the identity" tested only the per-player Challenge
  // list, which is deleted; its survivor is CTL10B-2-PVP-NO-INITIATE below.

  // NAMED REMOVAL (uif-4b, UIF4B.5): "hide() clears the feedback line, and showFeedback() writes it
  // via textContent" tested the retired `showFeedback` and `#pvp-challenge-feedback`. Its survivor is
  // the UIF4B.5 absence test at the top of this file.
});

// ---------------------------------------------------------------------------
// 20r-a: ONE view-wide in-flight lock over the challenge-lifecycle controls — RETIRED by qf-8
// (NAMED REMOVAL). The six cases (PV-1 shared key + root-level sentinel, PV-1b hostile re-enable,
// PV-2 release on resolve / reject / throw, PV-3 re-applied over a mid-flight rebuild, PV-4 release
// on the force-hide, PV-6 generation-keyed release) all drove the Accept / Decline / Cancel
// Challenge buttons, which are deleted with the lock (QF8.1): with no control there is no
// contradictory-outcome pair for a lock to refuse. The Social sheet sends one command per A and
// holds no lock by design; the reducers are the authority. Survivors: reachability.test.ts
// [QF8-2-PVP-RETIRED] / [QF8-2-PVP-NATIVE]; screens/socialScreen.test.ts CTL8D-2-COMMANDS and
// CTL8D-2-SHEET-CHALLENGE.
//
// The fixture below stays: the cifix0901, paintCursor and ctl-10b cases render it.
// ---------------------------------------------------------------------------

const RA_INCOMING_ID = 77n;
const RA_OUTGOING_ID = 88n;

/** Incoming from Bob and a Pending outgoing to Carol — so both request rows render at once
 *  (both labels, no control). */
function raPvpVm(): PvpChallengeViewModel {
  return pvpVm({
    incoming: { challengeId: RA_INCOMING_ID, challengerId: '0xbbb', challengerName: 'Bob' },
    outgoing: {
      challengeId: RA_OUTGOING_ID,
      targetId: '0xccc',
      targetName: 'Carol',
      status: 'Pending',
    },
  });
}

// =============================================================================
// i18n migration batch A: pvpView.ts routes its migrated sinks
// through t()/tf() (ADR-0256/0257 resolver) instead of raw English literals.
//
// =============================================================================

// the pvpView keys this sentinel matrix can legitimately produce — see
// battleView.test.ts's m24s3IsExpectedSentinelSpan header for why a bracket span
// whose content is not EXACTLY one of these must be LEFT IN PLACE (never elided)
// rather than blindly stripped — a forged `.append('«Accept»')`-style span must not
// launder raw English past the roster-word scan below.
const M24S3_PV_PLAIN_KEYS = new Set([
  'pvp.title.idle',
  'pvp.title.challenge',
  // INTENTIONAL CHANGE (qf-8): `pvp.incoming.accept`, `pvp.incoming.decline` and
  // `pvp.outgoing.cancel` leave with the lifecycle buttons (such a span is now an unexpected
  // sentinel); 'Accept', 'Decline' and 'Cancel' stay in M24S3_PV_ROSTER, so they appear nowhere.
]);

const M24S3_PV_PARAM_KEYS = new Set(['pvp.incoming.label', 'pvp.outgoing.label']);

/** True iff `content` (the text strictly between one `«`/`»` pair) is EXACTLY an
 *  expected sentinel: a bare roster key, or `key|<json>` where `key` is a roster PARAM
 *  key and the tail after the FIRST `|` parses to a plain (non-array, non-null) object. */
function m24s3PvIsExpectedSentinelSpan(content: string): boolean {
  const bar = content.indexOf('|');
  if (bar === -1) {
    return M24S3_PV_PLAIN_KEYS.has(content) || M24S3_PV_PARAM_KEYS.has(content);
  }
  const key = content.slice(0, bar);
  if (!M24S3_PV_PARAM_KEYS.has(key)) return false;
  const tail = content.slice(bar + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch {
    return false;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/** Elides only the bracket spans that are EXACTLY an expected sentinel (manual
 *  indexOf loop — no RegExp) and reports every OTHER `«...»` span verbatim
 *  in `unexpectedSpans`, un-elided, so it stays in `stripped` for the roster-word scan
 *  too (belt-and-braces). See battleView.test.ts's m24s3SplitSentinels header. */
function m24s3PvSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
  let out = '';
  const unexpectedSpans: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('«', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = text.indexOf('»', open + 1);
    if (close === -1) {
      out += text.slice(open);
      break;
    }
    const span = text.slice(open, close + 1);
    const content = text.slice(open + 1, close);
    if (m24s3PvIsExpectedSentinelSpan(content)) {
      // Elide — this is a real, correctly-formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

/** Whole-subtree walk (plan R5): every descendant's own text-node children, every
 *  element's `title` attribute, and every `<option>`'s text. */
function m24s3PvWalkSubtree(root: HTMLElement): string[] {
  const texts: string[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    const titleAttr = el.getAttribute('title');
    if (titleAttr) texts.push(titleAttr);
    if (el.tagName === 'OPTION') texts.push(el.textContent ?? '');
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) texts.push(node.textContent ?? ''); // TEXT_NODE
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return texts;
}

const M24S3_PV_ROSTER = [
  'PvP',
  'Challenge',
  'challenged',
  'Accept',
  'Decline',
  'waiting',
  'Cancel',
  'No players',
];

function m24s3PvAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s3PvSplitSentinels(texts.join('\n'));
  // a FORGED bracket span (raw English wrapped in `«...»` by
  // something other than the resolver) is never elided — it must not exist at all
  // under a correct implementation.
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel (a forged ` +
      `bracket span around raw content is not exempted from the roster scan)`,
  ).toEqual([]);
  for (const word of M24S3_PV_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s3 (ADR-0259): pvpView.ts routes its migrated sinks through t()/tf()', () => {
  it('m24s3 PV-01: every migrated sink calls t()/tf() with the exact key and params, showFeedback never touches the resolver, and every DOM string stays byte-identical', () => {
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());

    // idle
    view.refresh(null, true);
    expect(i18nT).toHaveBeenCalledWith('pvp.title.idle');
    expect(document.getElementById('pvp-challenge-status')?.textContent).toBe('PvP');

    // incoming — from Bob
    vi.mocked(i18nT).mockClear();
    view.refresh(
      pvpVm({ incoming: { challengeId: 77n, challengerId: '0xbbb', challengerName: 'Bob' } }),
      true,
    );
    expect(i18nT).toHaveBeenCalledWith('pvp.title.challenge');
    expect(i18nTf).toHaveBeenCalledWith('pvp.incoming.label', { challenger: 'Bob' });
    expect(document.querySelector('[data-testid="pvp-incoming-label"]')?.textContent).toBe(
      'Bob has challenged you!',
    );
    // INTENTIONAL CHANGE (qf-8): the Accept / Decline buttons (and their `pvp.incoming.accept` /
    // `.decline` ids) are deleted: the incoming row is its label alone.
    expect(
      document.getElementById('pvp-challenge-incoming')?.querySelectorAll('button').length,
      'qf-8: no Accept / Decline control',
    ).toBe(0);

    // outgoing — to Alice, Pending
    vi.mocked(i18nT).mockClear();
    view.refresh(
      pvpVm({
        outgoing: { challengeId: 88n, targetId: '0xccc', targetName: 'Alice', status: 'Pending' },
      }),
      true,
    );
    expect(i18nTf).toHaveBeenCalledWith('pvp.outgoing.label', { target: 'Alice' });
    expect(document.querySelector('[data-testid="pvp-outgoing-label"]')?.textContent).toBe(
      'Challenge sent to Alice — waiting…',
    );
    // INTENTIONAL CHANGE (qf-8): the Cancel Challenge button (`pvp.outgoing.cancel`) is deleted.
    expect(
      document.getElementById('pvp-challenge-outgoing')?.querySelectorAll('button').length,
      'qf-8: no Cancel Challenge control',
    ).toBe(0);

    // NAMED REMOVAL (ctl-10b, CTL10B.2): the "players empty" (pvp.players.none) and "players
    // present" (pvp.players.heading + raw-name button) blocks tested the deleted player list.

    // INTENTIONAL CHANGE (uif-4b, UIF4B.5): the "showFeedback never touches the resolver" clause is
    // dropped with the method (retired). Was: `view.showFeedback('some feedback text')` with no
    // t()/tf() call after it. Survivor: pvpView UIF4B.5 (the view has no showFeedback).
  });

  it('m24s3 PV-02: under «key» sentinels, every rendered surface shows resolver output and never an English roster word outside a sentinel', () => {
    const root = mountPvpOverlay();
    // the view is CONSTRUCTED here, BEFORE the sentinel
    // mockImplementation is installed below — same ordering as battleView.test.ts's
    // BV-02 (see its m24s3 H3 comment). pvpView.ts has no constructor-time t()/tf()
    // call today, but this ordering is what would surface one if a future edit ever
    // hoisted a resolver call into the constructor (pvpView's own version of the plan
    // R1 hazard battleView.ts's constructor once had): resolving against the REAL
    // (call-through) resolver at construction time would show up as stale, unbracketed
    // English in the very first m24s3PvAssertNoRosterWord below. Installing the mock
    // before `new PvpView(...)` would silently hide that regression class.
    const view = new PvpView(makeCallbacks());

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );

      view.refresh(null, true);
      let texts = m24s3PvWalkSubtree(root);
      m24s3PvAssertNoRosterWord(texts, 'idle');
      expect(texts.join('\n')).toContain('«pvp.title.idle»');

      view.refresh(
        pvpVm({ incoming: { challengeId: 77n, challengerId: '0xbbb', challengerName: 'Bob' } }),
        true,
      );
      texts = m24s3PvWalkSubtree(root);
      m24s3PvAssertNoRosterWord(texts, 'incoming');
      let joined = texts.join('\n');
      expect(joined).toContain('«pvp.title.challenge»');
      expect(joined).toContain('«pvp.incoming.label|{"challenger":"Bob"}»');
      // INTENTIONAL CHANGE (qf-8): no «pvp.incoming.accept» / «pvp.incoming.decline» (deleted).
      expect(joined).not.toContain('«pvp.incoming.accept»');
      expect(joined).not.toContain('«pvp.incoming.decline»');

      view.refresh(
        pvpVm({
          outgoing: { challengeId: 88n, targetId: '0xccc', targetName: 'Alice', status: 'Pending' },
        }),
        true,
      );
      texts = m24s3PvWalkSubtree(root);
      m24s3PvAssertNoRosterWord(texts, 'outgoing');
      joined = texts.join('\n');
      expect(joined).toContain('«pvp.outgoing.label|{"target":"Alice"}»');
      // INTENTIONAL CHANGE (qf-8): no «pvp.outgoing.cancel» (deleted).
      expect(joined).not.toContain('«pvp.outgoing.cancel»');

      // NAMED REMOVAL (ctl-10b, CTL10B.2): the "players empty" / "players present" steps tested
      // the deleted player list (pvp.players.none / .heading).
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key — the new pvp.* keys do not
    // exist in the catalog until the specialist ships them).
    expect(i18nT('chrome.help.title')).toBe('How to Play');
  });
});

// ---------------------------------------------------------------------------
// rb-121 (residual R-20r-a-FOCUS): a settle-released lifecycle lock re-anchors focus the no-batch
// path stranded on <body> — RETIRED by qf-8 (NAMED REMOVAL). Its eight cases (REJECT, RESOLVE,
// THROW, DETACH, KEEP-INROOT, KEEP-OUTROOT, STALE, HIDDEN) clicked the Accept button to take the
// 20r-a lock and pinned what its settle did to focus. The button, the lock and `#reanchorStranded
// Focus` are deleted together (QF8.1): no click can strand focus on a disabled control any more.
// Survivors: the overlay's own focus contract, S3-pvpView-DEFER-FOCUS / -REPEAT-NO-REOPEN /
// -REFRESH-NO-REOPEN above; the absence of every lifecycle control, reachability.test.ts
// [QF8-2-PVP-RETIRED] / [QF8-2-PVP-NATIVE].
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// cifix0901 — refresh(vm, true) shows in each container exactly what the view model holds.
//
// main.ts's PvP batch listener calls `refresh(buildPvpChallengeViewModel(...), forceVisible)` on
// EVERY store batch (about 9 a second with idle players), each time with a FRESHLY BUILT
// view-model. Before qf-8 each container re-rendered only when what IT showed changed, so the
// Accept / Decline / Cancel buttons (and keyboard focus on them) survived a batch.
//
// qf-8 (NAMED INTENTIONAL CHANGE, plan §1.3): the buttons are deleted, and the keyed render with
// them (its only purpose was keeping those nodes and their focus; the labels are plain text and
// the Social cursor marks the CONTAINERS, which no refresh replaces). RETIRED with it:
// ROSTER-CHANGE-KEEPS-INCOMING / INCOMING-CHANGE-KEEPS-ROSTER (node identity and focus over the
// buttons), LOCK-REAPPLIED (the lock) and INCOMING-NEW-ID (the buttons' challengeId; the Social
// sheet's commands send the request's id: screens/socialScreen.test.ts CTL8D-2-COMMANDS). The
// CONTENT teeth stay, read off the labels: the per-batch path (SAME-VALUE-KEEPS-NODES, its
// identity / focus clauses dropped), a renamed or cleared incoming request, the outgoing
// section's appear / relabel / leave-Pending, a direct hide() then re-show (HIDE-RESETS, its lock
// half dropped), the null shell, and recovery after a render that threw. That a container keeps
// the cursor mark across refreshes is CTL8D-2-VIEW-CHALLENGE-CURSOR below.
//
// WRONG-IMPL-KILLED index. The view keeps no render key since qf-8 (every refresh rebuilds both
// containers' labels), so the rows below are what a label must show after each event, against a
// regression that brings a "skip if unchanged" render back or breaks the rebuild:
//   an equal batch that drops / duplicates a label  -> SAME-VALUE-KEEPS-NODES
//   never re-render after the first render          -> INCOMING-RENAMED-AND-CLEARED, OUTGOING-SECTION
//   a skip comparing the incoming challengeId alone -> INCOMING-RENAMED-AND-CLEARED
//   a skip ignoring the outgoing status or target   -> OUTGOING-SECTION
//   a hide() that empties rows a skip never refills -> HIDE-RESETS
//   a skip the null shell does not clear            -> NULL-SHELL-RESETS
//   a "last shown" record kept over a render that   -> THROW-RECOVERS-PREVIOUS
//     threw after emptying its container
//   a "last shown" record taken before the render   -> THROW-RECOVERS-SAME
//     runs
// ---------------------------------------------------------------------------

/** Store rows the way main.ts's batch listener reads them: an incoming challenge from Bob, a
 *  Pending outgoing one to Carol, and two more online players (Alice, Dave), so both request
 *  rows render (before qf-8: every lifecycle control). */
const CIFIX_ME = '0xme01';
const CIFIX_CHALLENGES: readonly StoreBattleChallenge[] = [
  {
    challengeId: RA_INCOMING_ID,
    challenger: '0xbbb',
    target: CIFIX_ME,
    challengerPartyIds: [1n],
    status: 'Pending',
    createdAtMs: 1_000n,
  },
  {
    challengeId: RA_OUTGOING_ID,
    challenger: CIFIX_ME,
    target: '0xccc',
    challengerPartyIds: [2n],
    status: 'Pending',
    createdAtMs: 2_000n,
  },
];
const CIFIX_PLAYERS: readonly StorePlayer[] = [
  { identity: CIFIX_ME, entityId: 1n, name: 'Me', online: true },
  { identity: '0xbbb', entityId: 2n, name: 'Bob', online: true },
  { identity: '0xccc', entityId: 3n, name: 'Carol', online: true },
  { identity: '0xaaa1', entityId: 4n, name: 'Alice', online: true },
  { identity: '0xddd4', entityId: 5n, name: 'Dave', online: true },
];

function cifixShown(testId: string): boolean {
  return document.querySelector(`[data-testid="${testId}"]`) !== null;
}

function cifixText(testId: string): string | null {
  return document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
}

// NAMED REMOVAL (ctl-10b, CTL10B.2): cifixPlayerButtons / cifixPlayerIdentities / cifixRosterVm
// served only the deleted player-list teeth below.

/** An incoming challenge (77n) from `challengerName` and nothing else. */
function cifixIncomingVm(challengerName: string): PvpChallengeViewModel {
  return pvpVm({ incoming: { challengeId: 77n, challengerId: '0xbbb', challengerName } });
}

const CIFIX_TF_THROW = 'cifix0901: the incoming label render throws once';

describe('cifix0901 PvpView refresh(vm, true): each container shows what the view model holds', () => {
  it('cifix0901-PVP-SAME-VALUE-KEEPS-NODES BITES: equal batches (two buildPvpChallengeViewModel() calls over the same store rows, main.ts`s per-batch path) show the same incoming and outgoing labels, each inside its own shell container; the two containers stay the same nodes (the ones the Social cursor marks), and no batch renders a lifecycle control', () => {
    // NAMED INTENTIONAL CHANGE (ctl-10b, CTL10B.2): retargeted from five controls to three (the
    // per-player Challenge buttons are deleted).
    // NAMED INTENTIONAL CHANGE (qf-8): was "keep Accept, Decline and Cancel as the same connected
    // nodes, and focus on Accept stays there". The buttons are deleted, and with them the render
    // key that kept them (plan §1.3): every refresh now rebuilds both containers' children, so
    // the nodes an equal batch must keep are the CONTAINERS (the Social cursor's mark lives on
    // them) and what it must keep showing is the label text; button identity and focus are retired.
    // WRONG IMPL KILLED: an equal batch that drops, duplicates or swaps a label; a label written
    // outside its container (the cursor mark would sit on an empty row); a container replaced by a
    // refresh (the mark would be lost); a lifecycle control rebuilt on the per-batch path.
    const root = mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    const vm1 = buildPvpChallengeViewModel(CIFIX_CHALLENGES, CIFIX_ME, CIFIX_PLAYERS);
    const vm2 = buildPvpChallengeViewModel(CIFIX_CHALLENGES, CIFIX_ME, CIFIX_PLAYERS);
    expect(vm2, 'precondition: a separately built view-model, not the same object').not.toBe(vm1);
    expect(vm2, 'precondition: equal by value').toEqual(vm1);
    const incoming = document.getElementById('pvp-challenge-incoming') as HTMLElement;
    const outgoing = document.getElementById('pvp-challenge-outgoing') as HTMLElement;
    const shows = (): Record<string, unknown> => ({
      incomingLabels: [...incoming.querySelectorAll('[data-testid="pvp-incoming-label"]')].map(
        (el) => el.textContent,
      ),
      outgoingLabels: [...outgoing.querySelectorAll('[data-testid="pvp-outgoing-label"]')].map(
        (el) => el.textContent,
      ),
      buttons: root.querySelectorAll('button').length,
    });
    const expected = {
      incomingLabels: [i18nTf('pvp.incoming.label', { challenger: 'Bob' })],
      outgoingLabels: [i18nTf('pvp.outgoing.label', { target: 'Carol' })],
      buttons: 0,
    };

    view.refresh(vm1, true);
    expect(shows(), 'the first batch').toEqual(expected);
    view.refresh(vm2, true); // a batch tick
    view.refresh(buildPvpChallengeViewModel(CIFIX_CHALLENGES, CIFIX_ME, CIFIX_PLAYERS), true);
    expect(shows(), 'cifix0901: equal batches show the same, and no control').toEqual(expected);
    expect(
      document.getElementById('pvp-challenge-incoming'),
      'the incoming container is the same node',
    ).toBe(incoming);
    expect(
      document.getElementById('pvp-challenge-outgoing'),
      'the outgoing container is the same node',
    ).toBe(outgoing);
  });

  // qf-8 (NAMED REMOVALS, see the section header): cifix0901-PVP-LOCK-REAPPLIED (the lock kept on
  // kept button nodes), -ROSTER-CHANGE-KEEPS-INCOMING and -INCOMING-CHANGE-KEEPS-ROSTER (button
  // node identity and focus across a one-container change) and -INCOMING-NEW-ID (the buttons
  // dispatch the NEW challengeId) drove the deleted Accept / Decline / Cancel buttons; the keyed
  // render they also pinned is deleted (plan §1.3), so no label node identity is claimed. Survivors:
  // a relabelled incoming section, -INCOMING-RENAMED-AND-CLEARED below; a roster that renders
  // nothing, CTL10B-2-PVP-NO-INITIATE; the request's id on the sheet's commands,
  // screens/socialScreen.test.ts CTL8D-2-COMMANDS; no control at all, reachability.test.ts
  // [QF8-2-PVP-RETIRED].

  it('cifix0901-PVP-INCOMING-RENAMED-AND-CLEARED BITES: the same incoming id with a new challenger name relabels the incoming section, and incoming going null removes the label', () => {
    // WRONG IMPL KILLED: a refresh that skips when the incoming challengeId is unchanged (the
    // renamed challenger never shows); never re-rendering.
    // qf-8 (named intentional change): "removes the label, Accept and Decline" reads "removes the
    // label": the two buttons are deleted (their absence in every state: [QF8-2-PVP-RETIRED]).
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    view.refresh(
      pvpVm({ incoming: { challengeId: 77n, challengerId: '0xbbb', challengerName: 'Bob' } }),
      true,
    );
    expect(cifixText('pvp-incoming-label'), 'precondition: Bob is shown').toBe(
      i18nTf('pvp.incoming.label', { challenger: 'Bob' }),
    );

    view.refresh(
      pvpVm({ incoming: { challengeId: 77n, challengerId: '0xbbb', challengerName: 'Robert' } }),
      true,
    );
    expect(
      cifixText('pvp-incoming-label'),
      'cifix0901: a renamed challenger must show under the same challengeId',
    ).toBe(i18nTf('pvp.incoming.label', { challenger: 'Robert' }));

    view.refresh(pvpVm(), true);
    expect(
      cifixShown('pvp-incoming-label'),
      'cifix0901: a cleared incoming challenge must remove its label',
    ).toBe(false);
  });

  it('cifix0901-PVP-OUTGOING-SECTION BITES: an outgoing challenge appearing adds its label and disappearing removes it; a new target name relabels it; a new id keeps it shown; a status leaving Pending removes it', () => {
    // WRONG IMPL KILLED: never re-rendering; a refresh that skips the outgoing section while only
    // its target name or only its status changed (an Accepted outgoing would keep reading
    // "waiting").
    // qf-8 (named intentional change): the section's presence is read off its label, not the
    // deleted Cancel Challenge button; "Cancel dispatches a new id" is RETIRED with the button
    // (survivor: screens/socialScreen.test.ts CTL8D-2-COMMANDS, the sheet's cancel sends the
    // outgoing request's id).
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    const out = (challengeId: bigint, targetName: string, status: string): PvpChallengeViewModel =>
      pvpVm({ outgoing: { challengeId, targetId: '0xccc', targetName, status } });

    view.refresh(pvpVm(), true);
    expect(cifixShown('pvp-outgoing-label'), 'precondition: no outgoing, no label').toBe(false);

    view.refresh(out(88n, 'Carol', 'Pending'), true);
    expect(
      cifixText('pvp-outgoing-label'),
      'cifix0901: an outgoing challenge appearing must add its label',
    ).toBe(i18nTf('pvp.outgoing.label', { target: 'Carol' }));

    view.refresh(pvpVm(), true);
    expect(
      cifixShown('pvp-outgoing-label'),
      'cifix0901: the outgoing challenge disappearing must remove its label',
    ).toBe(false);

    view.refresh(out(88n, 'Carol', 'Pending'), true);
    view.refresh(out(88n, 'Zed', 'Pending'), true);
    expect(
      cifixText('pvp-outgoing-label'),
      'cifix0901: a new target name must relabel the outgoing section',
    ).toBe(i18nTf('pvp.outgoing.label', { target: 'Zed' }));

    view.refresh(out(89n, 'Zed', 'Pending'), true);
    expect(cifixText('pvp-outgoing-label'), 'a new id, the same target: still shown').toBe(
      i18nTf('pvp.outgoing.label', { target: 'Zed' }),
    );

    view.refresh(out(89n, 'Zed', 'Accepted'), true);
    expect(
      cifixShown('pvp-outgoing-label'),
      'cifix0901: a status leaving Pending must remove the outgoing label',
    ).toBe(false);
  });

  // NAMED REMOVALS (ctl-10b, CTL10B.2): cifix0901-PVP-PLAYER-RENAMED, -PLAYER-SAME-NAME-NEW-IDENTITY,
  // -HEADING-FOLLOWS-ACTIVE and -EMPTY-ROSTER-NONE-LINE tested only the deleted player list (its
  // buttons, onChallenge identity, heading and "none" line). Survivor: CTL10B-2-PVP-NO-INITIATE.

  it('cifix0901-PVP-HIDE-RESETS BITES: after hide() called DIRECTLY (reconnect / KeyP / force-hide), an equal view model shown again shows both request labels again', () => {
    // WRONG IMPL KILLED: a hide() that empties the containers while the next refresh skips a view
    // model equal to the last one shown (a "skip if unchanged" record that outlives the hide): the
    // re-shown overlay reads blank. The view keeps no such record since qf-8 (every refresh
    // rebuilds both containers); this pins the label behaviour for any render that brings one back.
    // qf-8 (named intentional change): the lock half ("a lock taken ... every lifecycle control
    // is ENABLED and Accept dispatches") is RETIRED with the buttons and the lock; the re-show half
    // is read off the labels.
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    view.refresh(raPvpVm(), true);
    view.hide();
    expect(view.visible, 'precondition: hidden').toBe(false);
    view.refresh(raPvpVm(), true);

    expect(
      [cifixText('pvp-incoming-label'), cifixText('pvp-outgoing-label')],
      'cifix0901: the re-shown overlay shows both requests',
    ).toEqual([
      i18nTf('pvp.incoming.label', { challenger: 'Bob' }),
      i18nTf('pvp.outgoing.label', { target: 'Carol' }),
    ]);
  });

  it('cifix0901-PVP-NULL-SHELL-RESETS BITES: after refresh(null, true) empties both rows, an equal view model shows both request labels again', () => {
    // WRONG IMPL KILLED: a refresh that skips a view model equal to the last non-null one shown,
    // with a "last shown" record the null shell does not clear: the emptied rows stay empty.
    // qf-8 (named intentional change): read off the labels (was "Accept, Decline and Cancel
    // render, and Accept dispatches"; those buttons are deleted).
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    view.refresh(raPvpVm(), true);
    view.refresh(null, true);
    expect(
      ['pvp-incoming-label', 'pvp-outgoing-label'].filter(cifixShown),
      'precondition: the null shell emptied both rows',
    ).toEqual([]);

    view.refresh(raPvpVm(), true);
    expect(
      [cifixText('pvp-incoming-label'), cifixText('pvp-outgoing-label')],
      'cifix0901: an equal view-model after the null shell renders both rows again',
    ).toEqual([
      i18nTf('pvp.incoming.label', { challenger: 'Bob' }),
      i18nTf('pvp.outgoing.label', { target: 'Carol' }),
    ]);
  });

  // NAMED REMOVALS (ctl-10b, CTL10B.2): cifix0901-PVP-ROSTER-THIRD-ADDED, -ROSTER-THIRD-RENAMED,
  // -ROSTER-THIRD-SAME-NAME-NEW-IDENTITY and -ROSTER-REORDERED tested only the deleted player list.

  it('cifix0901-PVP-THROW-RECOVERS-PREVIOUS BITES: after Bob is shown and a refresh for Robert throws mid-render (main.ts catches and logs it), the next refresh for Bob shows Bob`s incoming label again', () => {
    // WRONG IMPL KILLED: a refresh that skips a view model equal to the last one it finished
    // showing, while the render that threw had already emptied the container: the record still
    // says Bob, Bob's batch is skipped and the label never comes back.
    // qf-8 (named intentional change): the row's presence is read off its label (was its deleted
    // Accept button).
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    view.refresh(cifixIncomingVm('Bob'), true);
    expect(cifixShown('pvp-incoming-label'), 'precondition: the row renders for Bob').toBe(true);

    try {
      vi.mocked(i18nTf).mockImplementationOnce(() => {
        throw new Error(CIFIX_TF_THROW);
      });
      expect(
        () => view.refresh(cifixIncomingVm('Robert'), true),
        'precondition: the incoming render for Robert threw',
      ).toThrow(CIFIX_TF_THROW);
    } finally {
      vi.mocked(i18nTf).mockRestore(); // back to the real resolver (the m24s3 PV-02 idiom)
    }

    view.refresh(cifixIncomingVm('Bob'), true); // the next batch
    expect(
      cifixText('pvp-incoming-label'),
      'cifix0901: after a render that threw, the next refresh must show the row again',
    ).toBe(i18nTf('pvp.incoming.label', { challenger: 'Bob' }));
  });

  it('cifix0901-PVP-THROW-RECOVERS-SAME BITES: after a first refresh whose incoming render throws, the SAME view model again shows the incoming label', () => {
    // WRONG IMPL KILLED: a refresh that records its view model as shown before the render runs:
    // the throw leaves "Bob is shown" over an empty container and every later equal batch is
    // skipped.
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    try {
      vi.mocked(i18nTf).mockImplementationOnce(() => {
        throw new Error(CIFIX_TF_THROW);
      });
      expect(
        () => view.refresh(cifixIncomingVm('Bob'), true),
        'precondition: the incoming render for Bob threw',
      ).toThrow(CIFIX_TF_THROW);
    } finally {
      vi.mocked(i18nTf).mockRestore(); // back to the real resolver (the m24s3 PV-02 idiom)
    }

    view.refresh(cifixIncomingVm('Bob'), true); // the next batch, same value
    // qf-8 (named intentional change): read off the label (was the deleted Accept button).
    expect(
      cifixText('pvp-incoming-label'),
      'cifix0901: after a render that threw, the same view-model must render the row',
    ).toBe(i18nTf('pvp.incoming.label', { challenger: 'Bob' }));
  });
});

// ---------------------------------------------------------------------------
// ctl-8s (CTL8S.3): the Social frame's chrome. main.ts builds ONE chrome element and moves it into
// whichever Social panel shows, through that panel's `hostChrome(el)`: `el` becomes the root's
// FIRST element child (a tab strip ctl-8d paints there sits above the panel), nothing else on the
// root changes, and a second call with `el` already first is a no-op.
//
// happy-dom limit (measured on ctl-4): re-inserting a node before itself records no mutation and
// keeps focus here, so an unconditional `prepend(el)` on an `el` already first is invisible at this
// tier. A remove-then-insert is not: it records two mutations.
// ---------------------------------------------------------------------------

describe('PvpView.hostChrome (ctl-8s, CTL8S.3)', () => {
  it('CTL8S-3-HOST-CHROME-PVP: hostChrome(el) moves el out of wherever it was to be the FIRST element child of #pvp-challenge-overlay; the other children, their order and ids, the hidden shell and its dialog state are unchanged; a second call with el already first records no mutation and keeps focus inside el', async () => {
    // WRONG IMPL KILLED: an append (el lands LAST, under the feedback line); a clone (the node
    // main.ts paints is not the node shown, and the original stays where it was); a host that also
    // shows the view (pvpView's own `#visible` flag would flip, and main.ts reads it as "pvp is
    // open"); one that opens its dialog; one that replaces the root's children (the status, the
    // challenge rows and the player list are gone); and a re-host that removes el and inserts it
    // again when it is already first.
    const root = mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    const IDS = [
      'pvp-challenge-status',
      'pvp-challenge-incoming',
      'pvp-challenge-outgoing',
      'pvp-player-list',
      'pvp-challenge-feedback',
    ];
    const before = [...root.children];
    expect(
      before.map((c) => c.id),
      'precondition: the shell children',
    ).toEqual(IDS);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    const chrome = document.createElement('div');
    const tab = document.createElement('button');
    chrome.appendChild(tab);
    elsewhere.appendChild(chrome);

    view.hostChrome(chrome);

    expect(root.firstElementChild, 'el is the first element child of the root').toBe(chrome);
    expect(chrome.parentElement, 'moved, not cloned').toBe(root);
    expect(elsewhere.childElementCount, 'and no longer where it was').toBe(0);
    expect(root.childElementCount, 'one child more, nothing replaced').toBe(before.length + 1);
    for (const [i, child] of before.entries()) {
      expect(root.children[i + 1], `#${child.id}: kept, in its order`).toBe(child);
    }
    expect(
      before.map((c) => c.id),
      'their ids are unchanged',
    ).toEqual(IDS);
    expect(root.id).toBe('pvp-challenge-overlay');
    expect(root.style.display, 'the shell stays hidden').toBe('none');
    expect(view.visible, 'the view stays hidden').toBe(false);
    expect(root.getAttribute('aria-label'), 'no dialog was opened').toBeNull();

    // On the shown panel, a second host of the element already first moves nothing.
    view.refresh(pvpVm(), true);
    await flushMacrotask();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => {
      records.push(...batch);
    });
    observer.observe(root, { childList: true });
    tab.focus();
    expect(document.activeElement, 'precondition: focus is on a tab inside the chrome').toBe(tab);
    view.hostChrome(chrome);
    await flushMacrotask();
    observer.disconnect();
    expect(records.length, 'no node was removed or inserted').toBe(0);
    expect(document.activeElement, 'focus inside the chrome survives').toBe(tab);
    expect(root.firstElementChild).toBe(chrome);
    expect(root.childElementCount).toBe(before.length + 1);
    expect(view.visible, 'the shown panel stays shown').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ctl-8d (CTL8D.2): the Social adapter's cursor on a challenge row. On the Challenges tab the
// cursor sits on the incoming or the outgoing request, and `paintCursor` marks the container the
// pvp root shows that request in (`#pvp-challenge-incoming` / `#pvp-challenge-outgoing`) with the
// nav-item class, the active class and aria-current: never by colour alone. The containers survive
// every refresh (only their children are rebuilt), so the mark does too; `hide()` clears it.
// qf-8: the legacy buttons that sat inside a marked container are deleted (QF8.1); the rows are
// answered from the Social sheet.
// ---------------------------------------------------------------------------

describe('PvpView.paintCursor (ctl-8d, CTL8D.2)', () => {
  it('CTL8D-2-VIEW-CHALLENGE-CURSOR: paintCursor(incoming) marks #pvp-challenge-incoming alone and paintCursor(outgoing) #pvp-challenge-outgoing alone (mr-nav-item, is-active, aria-current="true"), null clears both; the mark survives a refresh of the same view model and one that rebuilds the row, hide() clears it; paintCursor re-renders no row and adds no child to the root', () => {
    // WRONG IMPL KILLED: a mark on both containers, or left on the old one when the cursor moves
    // (two rows read as current); a mark by class alone (no aria-current); a mark written into the
    // row's children, which the next refresh that changes the row rebuilds away; a mark that
    // survives hide(), so a reopened panel shows a stale cursor; a paintCursor that re-renders the
    // rows; and one that inserts a cursor element into the dialog root.
    // qf-8 (NAMED REMOVAL): "Accept, Decline and Cancel inside a marked container still dispatch
    // their callbacks" clicked the deleted buttons. Survivor: screens/socialScreen.test.ts
    // CTL8D-2-COMMANDS (the sheet's accept / decline / cancel on the marked request).
    const root = mountPvpOverlay();
    const cbs = makeCallbacks();
    const view = new PvpView(cbs);
    const vm = raPvpVm();
    view.refresh(vm, true);
    const children = [...root.children];
    const incoming = document.getElementById('pvp-challenge-incoming') as HTMLElement;
    const outgoing = document.getElementById('pvp-challenge-outgoing') as HTMLElement;
    // NAMED INTENTIONAL CHANGE (uif-9, UIF9.3): was "a container carries mr-nav-item only while it
    // holds the cursor" (ROW === UNMARKED here: no mark at all off the cursor); now a container
    // that holds a row carries mr-nav-item while the view shows (ROW = [true, false, null]), so a
    // row's padding does not change with the cursor, and only the cursor row adds is-active and
    // aria-current (MARKED). An empty container, and every container once the view is hidden,
    // carry nothing (UNMARKED). The cursor-moves / mark-survives-refresh / hide-clears teeth stay.
    const MARKED = [true, true, 'true'] as const;
    const ROW = [true, false, null] as const;
    const UNMARKED = [false, false, null] as const;
    const marks = (): Array<[boolean, boolean, string | null]> =>
      [incoming, outgoing].map((el): [boolean, boolean, string | null] => [
        el.classList.contains('mr-nav-item'),
        el.classList.contains('is-active'),
        el.getAttribute('aria-current'),
      ]);
    expect(marks(), 'precondition: both rows are rows, neither holds the cursor').toEqual([
      ROW,
      ROW,
    ]);

    // The incoming request.
    view.paintCursor('incoming');
    expect(marks(), 'incoming: the cursor on that container alone').toEqual([MARKED, ROW]);
    view.refresh(vm, true);
    expect(marks(), 'a refresh of the same view model keeps it').toEqual([MARKED, ROW]);
    view.refresh(
      pvpVm({
        ...vm,
        incoming: { challengeId: RA_INCOMING_ID, challengerId: '0xbbb', challengerName: 'Bobby' },
      }),
      true,
    );
    expect(
      document.querySelector('[data-testid="pvp-incoming-label"]')?.textContent,
      'precondition: the refresh rebuilt the incoming row',
    ).toBe(i18nTf('pvp.incoming.label', { challenger: 'Bobby' }));
    expect(marks(), 'a refresh that rebuilds the row keeps it').toEqual([MARKED, ROW]);
    const incomingLabel = incoming.querySelector('[data-testid="pvp-incoming-label"]');
    expect(incomingLabel, 'precondition: the incoming label is in its container').not.toBeNull();

    // The outgoing request.
    view.paintCursor('outgoing');
    expect(marks(), 'outgoing: the cursor on that container alone').toEqual([ROW, MARKED]);
    expect(
      incoming.querySelector('[data-testid="pvp-incoming-label"]'),
      'paintCursor re-renders no row',
    ).toBe(incomingLabel);

    // No row under the cursor: both are still rows, neither is current.
    view.paintCursor(null);
    expect(marks(), 'null: no cursor on either container').toEqual([ROW, ROW]);

    // hide() clears every mark (the nav-item class too), and a reopened panel carries no cursor.
    view.paintCursor('incoming');
    expect(marks(), 'precondition: incoming marked again').toEqual([MARKED, ROW]);
    view.hide();
    expect(marks(), 'hide(): neither container carries any mark').toEqual([UNMARKED, UNMARKED]);
    view.refresh(vm, true);
    expect(marks(), 'reopened: rows again, no cursor from the last visit').toEqual([ROW, ROW]);

    expect(root.children.length, 'paintCursor added no child to the root').toBe(children.length);
    children.forEach((child, i) => {
      expect(root.children[i], `root child ${i} is unchanged`).toBe(child);
    });
  });
});

// ---------------------------------------------------------------------------
// ctl-10b (CTL10B.2): pvpView is respond-only. It lists no challengeable players and starts no
// challenge: it has no per-player Challenge buttons (nor "Challenge:" / "No players online to
// challenge" lines), and its view model carries no player roster. A challenge starts face to
// face (A -> picker -> Challenge -> Yes).
// ---------------------------------------------------------------------------

describe('PvpView is respond-only (ctl-10b, CTL10B.2)', () => {
  it('CTL10B-2-PVP-NO-INITIATE: the idle root holds no button, no challenge-player control and no heading line, and clicking every element calls no callback; with live challenges the root still holds no button, the two requests read as labels, and clicking every element calls no callback', () => {
    // WRONG IMPL KILLED: a view that renders per-player Challenge buttons; one that renders list
    // rows with a click handler (a clickable non-button); one that keeps the "Challenge:" heading
    // or the "No players online to challenge" line; one whose click on anything calls a callback.
    // qf-8 (named intentional change): "with live challenges the only buttons are Accept, Decline
    // and Cancel" (and its "one that drops Accept / Decline / Cancel" kill) is inverted: those
    // buttons are deleted (QF8.1), the view holds no button in ANY state, and it still shows both
    // requests (as labels) so the Social cursor has rows to mark.
    // The literal English bytes are used on purpose: the pvp.players.* catalog ids are removed.
    const root = mountPvpOverlay();
    const cbs = makeCallbacks();
    const view = new PvpView(cbs);

    view.refresh(pvpVm(), true);
    expect(view.visible, 'ANTI-VACUITY: the overlay really rendered').toBe(true);
    expect(root.querySelectorAll('button'), 'no button at all while idle').toHaveLength(0);
    expect(root.querySelectorAll('[data-testid="pvp-challenge-player-btn"]')).toHaveLength(0);
    expect(root.querySelectorAll('[data-player-identity]')).toHaveLength(0);
    expect(root.querySelectorAll('li'), 'no list rows').toHaveLength(0);
    const text = root.textContent ?? '';
    expect(text.includes('Challenge:'), 'the old heading is gone').toBe(false);
    expect(text.includes('No players online to challenge'), 'the old "none" line is gone').toBe(
      false,
    );
    expect(
      document.getElementById('pvp-challenge-status')?.textContent,
      'ANTI-VACUITY: the title still renders',
    ).toBe('PvP Challenge');

    for (const el of root.querySelectorAll<HTMLElement>('*')) el.click();
    for (const [name, spy] of Object.entries(cbs)) {
      expect(spy, `clicking everything calls no ${name}`).not.toHaveBeenCalled();
    }

    // With live challenges the root lists no player, and (qf-8) no button renders.
    view.refresh(raPvpVm(), true);
    expect(root.querySelectorAll('button'), 'qf-8: no button with live challenges').toHaveLength(0);
    expect(
      [
        root.querySelector('[data-testid="pvp-incoming-label"]')?.textContent,
        root.querySelector('[data-testid="pvp-outgoing-label"]')?.textContent,
      ],
      'ANTI-VACUITY: both requests rendered',
    ).toEqual([
      i18nTf('pvp.incoming.label', { challenger: 'Bob' }),
      i18nTf('pvp.outgoing.label', { target: 'Carol' }),
    ]);
    expect(root.querySelectorAll('[data-testid="pvp-challenge-player-btn"]')).toHaveLength(0);
    for (const el of root.querySelectorAll<HTMLElement>('*')) el.click();
    for (const [name, spy] of Object.entries(cbs)) {
      expect(
        spy,
        `qf-8: with live challenges, clicking everything calls no ${name}`,
      ).not.toHaveBeenCalled();
    }
  });

  it('ts-6b-13 PvpViewCallbacks has no onChallenge member (an object literal naming it is a type error)', () => {
    // WRONG IMPL KILLED: a PvpViewCallbacks that keeps the unread `onChallenge` member declared.
    const withChallenge: PvpViewCallbacks = {
      onAccept: vi.fn(),
      onDecline: vi.fn(),
      onCancel: vi.fn(),
      // @ts-expect-error onChallenge is not a PvpViewCallbacks member
      onChallenge: vi.fn(),
    };
    expect(Object.keys(withChallenge)).toContain('onAccept');
  });
});

// ---------------------------------------------------------------------------
// uif-9 (UIF9.4, UIF9.3): the Challenges rows as RowCards with a uniform row treatment.
//
// UIF9.4: each shown challenge renders as `createRowCard` output: ONE `.mr-card` that is the only
// child of its container, its `.mr-card-title` the catalogued label, the e2e testid ON the card.
// UIF9.3: a container that holds a row carries `mr-nav-item` (the kit's row padding) while the view
// shows, whether or not the cursor is on it, so the row's padding never changes with the cursor;
// the cursor adds `is-active` + aria-current alone; an empty container is not a row; hide() clears
// every mark.
// ---------------------------------------------------------------------------

describe('PvpView challenge rows are RowCards (uif-9, UIF9.4)', () => {
  const containers = (): { incoming: HTMLElement; outgoing: HTMLElement } => ({
    incoming: document.getElementById('pvp-challenge-incoming') as HTMLElement,
    outgoing: document.getElementById('pvp-challenge-outgoing') as HTMLElement,
  });

  it('UIF9.4 each shown challenge is ONE .mr-card, the only child of its container, whose .mr-card-title reads the catalogued label and which carries the pvp-incoming-label / pvp-outgoing-label testid itself; the card holds its title and nothing else', () => {
    // WRONG IMPL KILLED: today's bare `<div data-testid>` label (no `.mr-card`); a card wrapped
    // around the labelled div (the testid on an inner node, not on the card); the testid on the
    // card's title instead of the card; a label written beside the card (two children); a title
    // that is a hand-typed English string instead of the resolver's `pvp.*.label`; an extra line
    // the kit's card was never given (`.mr-card-line` with a repeated label).
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    view.refresh(raPvpVm(), true);
    const { incoming, outgoing } = containers();
    const cases = [
      {
        name: 'incoming',
        box: incoming,
        testid: 'pvp-incoming-label',
        title: i18nTf('pvp.incoming.label', { challenger: 'Bob' }),
      },
      {
        name: 'outgoing',
        box: outgoing,
        testid: 'pvp-outgoing-label',
        title: i18nTf('pvp.outgoing.label', { target: 'Carol' }),
      },
    ];
    for (const c of cases) {
      expect(c.box.children.length, `${c.name}: the card is the container's only child`).toBe(1);
      const card = c.box.firstElementChild as HTMLElement;
      expect(card.classList.contains('mr-card'), `${c.name}: the child is a .mr-card`).toBe(true);
      expect(card.getAttribute('data-testid'), `${c.name}: the testid is ON the card`).toBe(
        c.testid,
      );
      expect(
        [...card.children].map((el) => el.className),
        `${c.name}: the card holds its title alone`,
      ).toEqual(['mr-card-title']);
      expect(card.querySelector('.mr-card-title')?.textContent, `${c.name}: the title`).toBe(
        c.title,
      );
      expect(card.textContent, `${c.name}: and the card reads only the title`).toBe(c.title);
      expect(
        c.box.querySelectorAll(`[data-testid="${c.testid}"]`).length,
        `${c.name}: exactly one element carries the testid`,
      ).toBe(1);
    }
    // The two requests are distinct cards.
    expect(incoming.firstElementChild, 'two different cards').not.toBe(outgoing.firstElementChild);
  });

  it('UIF9.4 a refresh rebuilds each card (the label follows the view model), a cleared or non-Pending challenge leaves its container with no card, and the idle shell holds none', () => {
    // WRONG IMPL KILLED: a card created once and never relabelled (a renamed challenger keeps the
    // old title); a cleared incoming that leaves its empty card (a bordered box with no text); an
    // outgoing that is no longer Pending but keeps its card; a second card appended per refresh
    // (the container holds two after two batches).
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    const { incoming, outgoing } = containers();
    const titleOf = (box: HTMLElement): string[] =>
      [...box.querySelectorAll('.mr-card')].map(
        (c) => c.querySelector('.mr-card-title')?.textContent ?? '',
      );

    view.refresh(raPvpVm(), true);
    view.refresh(raPvpVm(), true);
    expect(
      incoming.querySelectorAll('.mr-card').length,
      'two batches: still one incoming card',
    ).toBe(1);
    expect(
      outgoing.querySelectorAll('.mr-card').length,
      'two batches: still one outgoing card',
    ).toBe(1);

    view.refresh(
      pvpVm({
        ...raPvpVm(),
        incoming: { challengeId: RA_INCOMING_ID, challengerId: '0xbbb', challengerName: 'Bobby' },
      }),
      true,
    );
    expect(titleOf(incoming), 'a renamed challenger relabels the card').toEqual([
      i18nTf('pvp.incoming.label', { challenger: 'Bobby' }),
    ]);

    view.refresh(
      pvpVm({
        outgoing: {
          challengeId: RA_OUTGOING_ID,
          targetId: '0xccc',
          targetName: 'Carol',
          status: 'Accepted',
        },
      }),
      true,
    );
    expect(incoming.querySelectorAll('.mr-card').length, 'a cleared incoming: no card').toBe(0);
    expect(outgoing.querySelectorAll('.mr-card').length, 'a non-Pending outgoing: no card').toBe(0);
    expect(incoming.children.length, 'a cleared incoming: no node at all').toBe(0);
    expect(outgoing.children.length, 'a non-Pending outgoing: no node at all').toBe(0);

    view.refresh(raPvpVm(), true);
    view.refresh(null, true);
    expect(document.querySelectorAll('.mr-card').length, 'the idle shell holds no card').toBe(0);
  });
});

describe('PvpView rows carry the one row treatment whatever the cursor (uif-9, UIF9.3)', () => {
  const rowState = (
    el: HTMLElement,
  ): { navItem: boolean; active: boolean; current: string | null } => ({
    navItem: el.classList.contains('mr-nav-item'),
    active: el.classList.contains('is-active'),
    current: el.getAttribute('aria-current'),
  });

  it('UIF9.3 a visible view marks every container that holds a row mr-nav-item (the cursor row adds is-active and aria-current alone, the other row none), an empty container is no row, and hide() clears every mark while the rows stay in the DOM', () => {
    // WRONG IMPL KILLED: today's marks (mr-nav-item only on the cursor row, so the other row's
    // padding is 0 against 2px 8px 2px 20px on the cursor row and the rows do not line up); a mark
    // on the cursor row that moves the other row's class too (is-active on both); mr-nav-item on
    // an EMPTY container (a padded blank row); marks left after hide() (the hidden panel's rows
    // keep their padding, and the next open starts decorated); marks written while the view is
    // hidden.
    mountPvpOverlay();
    const view = new PvpView(makeCallbacks());
    const { incoming, outgoing } = {
      incoming: document.getElementById('pvp-challenge-incoming') as HTMLElement,
      outgoing: document.getElementById('pvp-challenge-outgoing') as HTMLElement,
    };
    const ROW = { navItem: true, active: false, current: null };
    const CURSOR = { navItem: true, active: true, current: 'true' };
    const NONE = { navItem: false, active: false, current: null };

    // Both rows, no cursor.
    view.refresh(raPvpVm(), true);
    expect([rowState(incoming), rowState(outgoing)], 'two rows, no cursor').toEqual([ROW, ROW]);
    // The cursor on one, then the other: the other stays a plain row.
    view.paintCursor('incoming');
    expect([rowState(incoming), rowState(outgoing)], 'cursor on incoming').toEqual([CURSOR, ROW]);
    view.paintCursor('outgoing');
    expect([rowState(incoming), rowState(outgoing)], 'cursor on outgoing').toEqual([ROW, CURSOR]);

    // An empty container is not a row, even with the cursor asked for on it.
    view.refresh(pvpVm({ incoming: raPvpVm().incoming }), true);
    expect(outgoing.children.length, 'precondition: the outgoing container is empty').toBe(0);
    expect(rowState(outgoing).navItem, 'an empty container carries no mr-nav-item').toBe(false);
    expect(rowState(incoming).navItem, 'the incoming row still does').toBe(true);

    // The row going away takes its mark; the row arriving gains it.
    view.paintCursor(null);
    view.refresh(pvpVm(), true);
    expect([rowState(incoming), rowState(outgoing)], 'no rows: no marks').toEqual([NONE, NONE]);
    view.refresh(raPvpVm(), true);
    expect([rowState(incoming), rowState(outgoing)], 'rows arrive: marked').toEqual([ROW, ROW]);

    // hide(): every mark gone, the rows themselves kept.
    view.paintCursor('incoming');
    view.hide();
    expect([rowState(incoming), rowState(outgoing)], 'hidden: no mark of any kind').toEqual([
      NONE,
      NONE,
    ]);
    expect(incoming.children.length + outgoing.children.length, 'hide() empties no row').toBe(2);
    // refresh(vm, false) on a hidden view writes nothing either.
    view.refresh(raPvpVm(), false);
    expect([rowState(incoming), rowState(outgoing)], 'a refresh that keeps it hidden').toEqual([
      NONE,
      NONE,
    ]);
    // Reopened: rows again, cursor only where the screen puts it.
    view.refresh(raPvpVm(), true);
    expect([rowState(incoming), rowState(outgoing)], 'reopened').toEqual([ROW, ROW]);
  });
});
