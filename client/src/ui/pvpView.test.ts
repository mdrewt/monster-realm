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
// The NON-S3 tests in this file (refresh behaviour) pass NOW and must keep passing — with ONE
// deliberate 20r-a adaptation: the Accept-then-Decline case awaits the in-flight lock between
// its two clicks (see the `20r-a PV-5` comment on it), because 20r-a made the four lifecycle
// actions share ONE view-wide lock (plan D2).
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
// 20r-a later extended `refresh()` to RE-APPLY the in-flight lifecycle lock after the row rebuild
// (PV-3 below) — the show()-edge guard still belongs in `show()`, and nothing here re-opens.
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
    // A close with no record is a documented pure no-op (ui/overlayA11y.ts:136-137), so the
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
// S3 tests lean on (the caller-owned show/hide decision, the authoritative row rebuild, the
// callbacks) is pinned here rather than assumed. m23-s3 left `refresh()` byte-unchanged (its plan
// T7); 20r-a then added the in-flight lifecycle lock (the `★ PvpView 20r-a` block at the end of
// this file), which `refresh()` re-applies after the rebuild. Every test below still passes; the
// Accept-then-Decline case awaits that lock between its clicks (20r-a PV-5, plan D2).
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

  it('BITES: refresh(vm, true) with an incoming challenge paints the label plus Accept/Decline, and the buttons dispatch the callbacks with the challengeId', async () => {
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

    // 20r-a PV-5 (plan D2): Accept and Decline now share ONE view-wide in-flight lock, so the
    // Decline click must wait for the (void-returning) Accept call to settle — a synchronous
    // second click is exactly the contradictory-outcome pair the lock exists to refuse (PV-1).
    await raFlushPromises();

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

// ---------------------------------------------------------------------------
// 20r-a — ONE view-wide in-flight lock over the four challenge-lifecycle actions (Accept /
// Decline / Cancel / Challenge-a-player). APPENDED BLOCK; the edits above are the header
// clauses and the PV-5 `await` in the Accept-then-Decline case.
//
// SOURCE OF TRUTH: docs/specs/20r-a-plan.md §0 D2/D3/D8/D11, §1 pvpView.ts, §3 PV-1..PV-6.
//
// WHY VIEW-WIDE (plan D2), not per button and not keyed by challengeId: all four actions
// mutate ONE challenge state. Accept-then-Decline (or Decline-then-Cancel of an outgoing while
// the incoming is being accepted) is the contradictory-outcome class — the server processes
// whichever lands first and rejects the other, but the player has now asked for both. A
// per-button lock leaves that open; a per-challengeId lock leaves Cancel-outgoing open beside
// Accept-incoming. So one `#pending: object | null`, and every lifecycle control disables.
//
// WHAT THE LOCK COVERS AND WHAT IT MUST NOT (plan §4 #8): the <button>s under `#incomingEl`,
// `#outgoingEl` and `#playerListEl` — never a `#root`-wide query. PV-1 parks a sentinel
// <button> as a DIRECT child of the root (the S3 idiom above) and asserts it stays enabled.
//
// RED REASON: no `#pending` exists — Accept's click disables nothing, so PV-1's first census
// reds and every other row reds on its "disabled after the click" anchor.
//
// happy-dom facts, the microtask budget and the hostile-re-enable rationale: see
// battleView.test.ts's 20r-a header — the same three facts hold here.
//
// WRONG-IMPL-KILLED index:
//   PV-1  a per-button / per-challengeId lock; a #root-wide disable -> siblings swallowed, sentinel live
//   PV-1b a disabled-only impl (no pending key)                    -> hostile re-enable of Accept
//   PV-2  `.catch` before `.finally`; `Promise.resolve(cb())`; a never-releasing resolve path
//   PV-3  refresh(vm, true) not re-applying the lock / releasing the detached node
//   PV-4  a lock that survives the force-hide (`refresh(vm, false)`)
//   PV-6  a membership-keyed release (D11)                         -> still disabled after the stale settle
// ---------------------------------------------------------------------------

interface RaDeferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (e: unknown) => void;
}

function raDeferred(): RaDeferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Three microtasks — see battleView.test.ts's 20r-a MICROTASK BUDGET note. */
async function raFlushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const RA_INCOMING_ID = 77n;
const RA_OUTGOING_ID = 88n;

/** Incoming from Bob, a Pending outgoing to Carol, and two challengeable players — so ALL FIVE
 *  lifecycle controls render at once: Accept, Decline, Cancel Challenge, Alice, Dave. */
function raPvpVm(): PvpChallengeViewModel {
  return pvpVm({
    incoming: { challengeId: RA_INCOMING_ID, challengerId: '0xbbb', challengerName: 'Bob' },
    outgoing: {
      challengeId: RA_OUTGOING_ID,
      targetId: '0xccc',
      targetName: 'Carol',
      status: 'Pending',
    },
    challengeablePlayers: [
      { identity: '0xaaa1', name: 'Alice' },
      { identity: '0xddd4', name: 'Dave' },
    ],
  });
}

interface RaPvpControls {
  readonly accept: HTMLButtonElement;
  readonly decline: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly players: readonly HTMLButtonElement[];
  /** The five lifecycle controls, in DOM order. */
  readonly all: readonly HTMLButtonElement[];
}

/** The LIVE lifecycle controls (re-query after every refresh — the rows are rebuilt). */
function raPvpControls(): RaPvpControls {
  const accept = document.querySelector<HTMLButtonElement>('[data-testid="pvp-accept-btn"]');
  const decline = document.querySelector<HTMLButtonElement>('[data-testid="pvp-decline-btn"]');
  const cancel = document.querySelector<HTMLButtonElement>('[data-testid="pvp-cancel-btn"]');
  const players = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid="pvp-challenge-player-btn"]'),
  ];
  expect(accept, '20r-a precondition: Accept renders').not.toBeNull();
  expect(decline, '20r-a precondition: Decline renders').not.toBeNull();
  expect(cancel, '20r-a precondition: Cancel Challenge renders').not.toBeNull();
  expect(players, '20r-a precondition: two challenge-player buttons render').toHaveLength(2);
  return {
    accept: accept!,
    decline: decline!,
    cancel: cancel!,
    players,
    all: [accept!, decline!, cancel!, ...players],
  };
}

function raExpectAll(controls: RaPvpControls, disabled: boolean, why: string): void {
  expect(
    controls.all.map((b) => `${b.textContent ?? ''}=${String(b.disabled)}`),
    why,
  ).toEqual(controls.all.map((b) => `${b.textContent ?? ''}=${String(disabled)}`));
}

describe('★ PvpView 20r-a: ONE view-wide in-flight lock over the challenge-lifecycle controls', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('20r-a PV-1 BITES: Accept unsettled → Decline / Cancel / every challenge-player button DISABLED and swallowed (hostile re-enable included); a root-level sentinel stays enabled; all released on settle', async () => {
    // WRONG IMPL KILLED (1): the shipped code — nothing disables, Decline fires beside Accept.
    // WRONG IMPL KILLED (2): a PER-BUTTON lock — Decline stays live while Accept is in flight
    //   (the contradictory-outcome pair, plan D2). The hostile re-enable of each sibling is what
    //   reaches the listener; only a SHARED key can refuse it.
    // WRONG IMPL KILLED (3): a lock keyed by challengeId — Cancel (outgoing 88n) and the
    //   challenge-player buttons (no challenge yet) would stay live beside Accept (incoming 77n).
    // WRONG IMPL KILLED (4): `#root.querySelectorAll('button')` (plan §4 #8) — the sentinel
    //   parked as a DIRECT child of the root would be disabled too. The lock's registry is the
    //   three dynamic containers, never the shell root.
    const root = mountPvpOverlay();
    const d = raDeferred();
    const cbs = makeCallbacks();
    (cbs.onAccept as ReturnType<typeof vi.fn>).mockReturnValue(d.promise);
    const view = new PvpView(cbs);
    view.refresh(raPvpVm(), true);
    const sentinel = addInsideSentinel(root);
    const c = raPvpControls();
    raExpectAll(c, false, '20r-a PV-1 precondition: every lifecycle control starts enabled');

    c.accept.click();
    c.accept.click();
    expect(
      cbs.onAccept,
      '20r-a PV-1: two rapid Accept clicks dispatch onAccept exactly ONCE',
    ).toHaveBeenCalledTimes(1);
    expect(cbs.onAccept).toHaveBeenCalledWith(RA_INCOMING_ID);
    raExpectAll(
      c,
      true,
      '20r-a PV-1: ALL FIVE lifecycle controls must be disabled while Accept is in flight — one ' +
        'challenge state, one lock (plan D2)',
    );
    expect(
      sentinel.disabled,
      '20r-a PV-1: a <button> that is a DIRECT child of the shell root must NOT be disabled — the ' +
        'lock walks #incomingEl / #outgoingEl / #playerListEl, never #root (plan §4 #8)',
    ).toBe(false);

    const siblings: readonly (readonly [HTMLButtonElement, unknown, string])[] = [
      [c.decline, cbs.onDecline, 'Decline'],
      [c.cancel, cbs.onCancel, 'Cancel Challenge'],
      [c.players[0]!, cbs.onChallenge, 'challenge Alice'],
      [c.players[1]!, cbs.onChallenge, 'challenge Dave'],
    ];
    for (const [btn, spy, label] of siblings) {
      btn.click(); // swallowed by disabled (happy-dom, D1)
      btn.disabled = false; // HOSTILE re-enable
      btn.click();
      expect(
        spy,
        `20r-a PV-1: ${label} must be swallowed by the SHARED pending key even after the node is ` +
          're-enabled by hand — a per-button or per-challengeId lock lets it through',
      ).not.toHaveBeenCalled();
      btn.disabled = true; // restore so the post-settle census is about the release
    }
    await raFlushPromises();
    raExpectAll(
      raPvpControls(),
      true,
      '20r-a PV-1: still disabled after the microtasks drain — a void-returning dispatch releases ' +
        'here while the reducer call is in flight',
    );

    d.resolve();
    await raFlushPromises();
    const after = raPvpControls();
    raExpectAll(after, false, '20r-a PV-1: every lifecycle control re-enabled on settle');
    after.decline.click();
    expect(cbs.onDecline, '20r-a PV-1: Decline dispatches after the settle').toHaveBeenCalledTimes(
      1,
    );
    expect(cbs.onDecline).toHaveBeenCalledWith(RA_INCOMING_ID);
    await raFlushPromises();
  });

  it('20r-a PV-1b BITES: hostile re-enable — click Accept, set the LIVE button `disabled = false` by hand, click again → still ONE onAccept', async () => {
    // WRONG IMPL KILLED: a disabled-only implementation with no pending key (plan D1).
    mountPvpOverlay();
    const d = raDeferred();
    const cbs = makeCallbacks();
    (cbs.onAccept as ReturnType<typeof vi.fn>).mockReturnValue(d.promise);
    const view = new PvpView(cbs);
    view.refresh(raPvpVm(), true);
    const c = raPvpControls();

    c.accept.click();
    expect(cbs.onAccept).toHaveBeenCalledTimes(1);
    expect(c.accept.disabled, '20r-a PV-1b precondition: the lock disabled Accept').toBe(true);
    c.accept.disabled = false;
    c.accept.click();
    expect(
      cbs.onAccept,
      '20r-a PV-1b: with the node re-enabled by hand the PENDING KEY must still swallow the click',
    ).toHaveBeenCalledTimes(1);

    d.resolve();
    await raFlushPromises();
    c.accept.click();
    expect(cbs.onAccept, '20r-a PV-1b: dispatches again after the settle').toHaveBeenCalledTimes(2);
    await raFlushPromises();
  });

  it('20r-a PV-2 BITES: the lock releases on an already-resolved return (the sendGuarded short-circuit), on a REJECTION, and on a synchronous THROW — Accept and Decline enabled after each flush', async () => {
    // WRONG IMPL KILLED (1): a release that waits for a value / a `.then`-only release — the
    //   frozen-link short-circuit in main.ts returns `Promise.resolve()` (M-2), which must
    //   release exactly like a real settle; otherwise every click on a dead link parks the
    //   overlay dead until the force-hide.
    // WRONG IMPL KILLED (2): `.catch` before `.finally` — the rejection skips the release.
    //   `.finally` with no trailing `.catch` — vitest fails the run on the unhandled rejection.
    // WRONG IMPL KILLED (3): `Promise.resolve(cb())` (plan D3) — the sync throw escapes after
    //   the lock is set; with happy-dom's error capturing disabled it comes out of `.click()`.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mountPvpOverlay();
    const rejected = raDeferred();
    const onAccept = vi
      .fn()
      .mockReturnValueOnce(Promise.resolve())
      .mockReturnValueOnce(rejected.promise)
      .mockImplementationOnce(() => {
        throw new Error('20r-a PV-2: synchronous throw');
      });
    const cbs = makeCallbacks();
    const view = new PvpView({ ...cbs, onAccept });
    view.refresh(raPvpVm(), true);
    const c = raPvpControls();

    // (a) short-circuit: an already-resolved promise.
    c.accept.click();
    expect(onAccept).toHaveBeenCalledTimes(1);
    raExpectAll(c, true, '20r-a PV-2 (a): the lock is taken even for an already-resolved return');
    await raFlushPromises();
    raExpectAll(
      c,
      false,
      '20r-a PV-2 (a): an already-resolved return (the frozen-link short-circuit) must release ' +
        'the lock after the microtasks drain',
    );

    // (b) rejection.
    c.accept.click();
    expect(onAccept).toHaveBeenCalledTimes(2);
    raExpectAll(c, true, '20r-a PV-2 (b): locked while the rejecting call is in flight');
    await raFlushPromises();
    raExpectAll(c, true, '20r-a PV-2 (b): still locked before the rejection');
    rejected.reject(new Error('20r-a PV-2: accept rejected'));
    await raFlushPromises();
    raExpectAll(
      c,
      false,
      '20r-a PV-2 (b): a REJECTED call must release the lock (the release lives in `.finally`)',
    );

    // (c) synchronous throw.
    expect(
      () => c.accept.click(),
      '20r-a PV-2 (c): a synchronously-throwing onAccept must not throw out of the click',
    ).not.toThrow();
    expect(onAccept).toHaveBeenCalledTimes(3);
    raExpectAll(c, true, '20r-a PV-2 (c): the lock was taken before the callback threw');
    await raFlushPromises();
    raExpectAll(
      c,
      false,
      '20r-a PV-2 (c): the sync throw must settle the chain and RELEASE — `Promise.resolve(cb())` ' +
        'leaves the overlay dead here',
    );
    c.decline.click();
    expect(
      cbs.onDecline,
      '20r-a PV-2: Decline dispatches once the lock is free',
    ).toHaveBeenCalledWith(RA_INCOMING_ID);
    await raFlushPromises();
  });

  it('20r-a PV-3 BITES: a mid-flight refresh(vm, true) rebuilds every lifecycle control DISABLED, swallows a click on the new node, and the settle re-enables the LIVE nodes', async () => {
    // WRONG IMPL KILLED (1): refresh() not re-applying the lock after `#renderIncoming` /
    //   `#renderOutgoing` / `#renderPlayerList` rebuild the rows — main.ts calls
    //   `refresh(vm, true)` on EVERY batch while the overlay is up (S3-pvpView-REFRESH-NO-REOPEN
    //   above), so an unlocked rebuild lands within one tick of any click.
    // WRONG IMPL KILLED (2): the `.finally` re-enabling the closure-captured nodes — after the
    //   rebuild they are detached and the LIVE buttons stay disabled.
    mountPvpOverlay();
    const d = raDeferred();
    const cbs = makeCallbacks();
    (cbs.onAccept as ReturnType<typeof vi.fn>).mockReturnValue(d.promise);
    const view = new PvpView(cbs);
    view.refresh(raPvpVm(), true);
    const before = raPvpControls();
    before.accept.click();
    raExpectAll(before, true, '20r-a PV-3 precondition: locked');

    view.refresh(raPvpVm(), true); // a batch tick while Accept is in flight
    const rebuilt = raPvpControls();
    expect(rebuilt.accept, '20r-a PV-3 precondition: refresh() rebuilt the node').not.toBe(
      before.accept,
    );
    expect(before.accept.isConnected, '20r-a PV-3 precondition: the old node is detached').toBe(
      false,
    );
    raExpectAll(
      rebuilt,
      true,
      '20r-a PV-3: every REBUILT lifecycle control must come back DISABLED — refresh() re-applies ' +
        'the lock after the row rebuild, not lost on rebuild',
    );
    rebuilt.decline.click(); // swallowed by disabled
    rebuilt.decline.disabled = false; // hostile
    rebuilt.decline.click();
    expect(
      cbs.onDecline,
      '20r-a PV-3: a click on a rebuilt (and hand re-enabled) Decline is swallowed by the key',
    ).not.toHaveBeenCalled();
    rebuilt.decline.disabled = true;

    d.resolve();
    await raFlushPromises();
    const live = raPvpControls();
    expect(live.accept, '20r-a PV-3: a settle does not re-render').toBe(rebuilt.accept);
    raExpectAll(
      live,
      false,
      '20r-a PV-3: the LIVE (rebuilt) controls must be re-enabled on settle — re-enabling the ' +
        'detached closure nodes strands the real ones disabled',
    );
    live.decline.click();
    expect(cbs.onDecline).toHaveBeenCalledWith(RA_INCOMING_ID);
    await raFlushPromises();
  });

  it('20r-a PV-4 BITES: the force-hide releases the lock — pending, then refresh(vm, false) (hide) and refresh(vm, true) → enabled, and the next click dispatches', async () => {
    // WRONG IMPL KILLED: a lock released ONLY by `.finally` — the SDK never settles an
    //   in-flight reducer promise after a link drop, and this view's ONLY dismiss paths are
    //   `refresh(vm, false)` (main.ts's batch listener) and the force-hide handle, both of which
    //   reach `hide()`. The tradeProposeView precedent (`hide()` clears `#pending`) is the shape.
    mountPvpOverlay();
    const d = raDeferred(); // deliberately never settled
    const cbs = makeCallbacks();
    (cbs.onAccept as ReturnType<typeof vi.fn>).mockReturnValue(d.promise);
    const view = new PvpView(cbs);
    view.refresh(raPvpVm(), true);
    const c = raPvpControls();
    c.accept.click();
    raExpectAll(c, true, '20r-a PV-4 precondition: locked');

    view.refresh(raPvpVm(), false); // the production force-hide path
    expect(view.visible, '20r-a PV-4 precondition: hidden').toBe(false);
    expect(
      vi.mocked(closeOverlayA11y),
      '20r-a PV-4: hide() must still close the overlay a11y record exactly once (plan D8 — the ' +
        'release is added BEFORE the close, the close stays last and unguarded)',
    ).toHaveBeenCalledTimes(1);
    view.refresh(raPvpVm(), true);
    const after = raPvpControls();
    raExpectAll(
      after,
      false,
      '20r-a PV-4: after the force-hide + re-show every lifecycle control must be ENABLED — ' +
        'hide() is the release path for a promise that will never settle (link drop)',
    );
    after.accept.click();
    expect(cbs.onAccept, '20r-a PV-4: dispatches after the hide-release').toHaveBeenCalledTimes(2);
  });

  it('20r-a PV-6 BITES: two overlapping generations — click (P1), refresh(vm,false), refresh(vm,true) + click (P2), settle P1 → STILL disabled and a third click is swallowed; settle P2 → enabled', async () => {
    // WRONG IMPL KILLED (plan D11): a release that clears `#pending` unconditionally (a boolean,
    //   or `#pending = null` with no identity check). hide() clears it, the overlay re-opens, a
    //   second click sets it again with P2 in flight, then the STALE P1 settles and clears it —
    //   P2's controls come back live and a THIRD lifecycle action is sent. Only
    //   `if (this.#pending === myToken)` refuses it.
    mountPvpOverlay();
    const p1 = raDeferred();
    const p2 = raDeferred();
    const cbs = makeCallbacks();
    (cbs.onAccept as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(p1.promise)
      .mockReturnValueOnce(p2.promise);
    const view = new PvpView(cbs);
    view.refresh(raPvpVm(), true);

    raPvpControls().accept.click(); // generation 1
    expect(cbs.onAccept).toHaveBeenCalledTimes(1);
    raExpectAll(raPvpControls(), true, '20r-a PV-6 precondition: generation 1 holds the lock');

    view.refresh(raPvpVm(), false); // force-hide releases generation 1 — P1 still in flight
    view.refresh(raPvpVm(), true);
    const gen2 = raPvpControls();
    raExpectAll(gen2, false, '20r-a PV-6 precondition: the hide released generation 1');
    gen2.accept.click(); // generation 2
    expect(cbs.onAccept).toHaveBeenCalledTimes(2);
    raExpectAll(gen2, true, '20r-a PV-6 precondition: generation 2 holds the lock');

    p1.resolve(); // the STALE settle
    await raFlushPromises();
    const afterStale = raPvpControls();
    raExpectAll(
      afterStale,
      true,
      "20r-a PV-6: generation 1's settle must NOT release generation 2's lock — P2 is still in " +
        'flight. An unconditional clear in `.finally` re-enables everything here',
    );
    afterStale.decline.click(); // swallowed by disabled
    afterStale.decline.disabled = false; // hostile
    afterStale.decline.click();
    expect(
      cbs.onDecline,
      '20r-a PV-6: a third lifecycle click while P2 is in flight must be swallowed by the key',
    ).not.toHaveBeenCalled();
    afterStale.decline.disabled = true;

    p2.resolve();
    await raFlushPromises();
    raExpectAll(raPvpControls(), false, "20r-a PV-6: generation 2's OWN settle releases");
    raPvpControls().decline.click();
    expect(cbs.onDecline).toHaveBeenCalledWith(RA_INCOMING_ID);
    await raFlushPromises();
  });
});
