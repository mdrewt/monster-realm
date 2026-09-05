// @vitest-environment happy-dom
// ui/claimView.test.ts — m23-s4 RED gating tests for the overlay a11y wiring on the
// guest-claim overlay's THREE open doors (show(), render(vm.visible)).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2/§2.3, §6
// (A11Y-13/14/15/16); memory/projects/monster-realm-m23-s4-plan.md §0 F1, §1 D5,
// §8 A1/A5/A6; memory/projects/gates/m23-s4.gates.md X1/X2/X3/X6/X7/X8, and the
// ledger's DOCUMENTED RESIDUAL note (claimView can re-open after a manual dismiss).
//
// RED REASON: claimView.ts's show()/hide()/render()/toggle() do not call
// openOverlayA11y/closeOverlayA11y at all today — every test below fails now.
//
// WHY THIS FILE IS NEW (not an extension): claimView has no pre-existing spec file.
//
// D5 — THE THREE-DOOR SHAPE THIS FILE PINS: `show()` and `render(vm)` BOTH guard on
// the SAME derived `wasVisible` source (`claimView.ts:71-73`'s existing `visible`
// getter — never a second field); `hide()` is UNGUARDED; `render()`'s close arm IS
// guarded (`else if (!vm.visible && wasVisible)`). Open is the LAST statement of
// render(), after the textContent writes, so the deferred querySelector resolves
// against a painted root. The real production call sequence (main.ts:446 -> :457 ->
// :458, `renderClaim -> show() -> renderClaim`, inside `openClaim()`) means the true
// open edge fires INSIDE render() at :446 — one statement BEFORE show() is even
// called — so S4-claimView-THREE-DOORS replays exactly that sequence.
//
// COMPOSITION NOTE (plan §8 A7): DEFER-FOCUS and CLOSE-RESTORE are folded into
// S4-claimView-ANCHOR-FOCUS and S4-claimView-CLOSE-RESTORE-UNGUARDED.
//
// DOCUMENTED RESIDUAL (plan §8 A1, ledger X7): `ClaimPhase` never transitions back
// to 'hidden', and main.ts's KeyC close calls `claimView.hide()` DIRECTLY (never
// through `applyClaim`), so the model still believes the overlay is open. A LATER
// reconnect-driven `render(vm.visible === true)` therefore RE-OPENS the overlay —
// today that silently re-shows it (a pre-existing display bug); after S4 it also
// announces and steals focus. S4-claimView-REOPEN-AFTER-HIDE PINS this composed
// behaviour rather than hiding it — the fix needs claimModel.ts (a new ClaimEvent)
// or main.ts (route KeyC through applyClaim), BOTH outside this slice's touches:,
// and main.ts is reserved for S5 by spec §4.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import type { ClaimViewModel } from './claimModel';
import { ClaimView, type ClaimViewHandlers } from './claimView';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

// The m23-s4 MECHANISM oracle. `{ spy: true }` records every call AND calls through
// to the real implementation, so the VALUE oracle (real attribute writes, real focus
// moves) still works.
vi.mock('./overlayA11y', { spy: true });

/** ONE real macrotask boundary — never vi.useFakeTimers() (plan anti-pattern #10). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// File-level sweep (mandatory): overlayA11y.ts holds ONE module-private Map and
// exports no reset hook, so this calls the PRODUCTION closeOverlayA11y(id, null) for
// every OverlayId and flushes one real macrotask — legal because close-without-open
// is a documented no-op. `document.body.innerHTML = ''` guarantees a fresh DOM so
// claimView.ts's `ensureElement` always CREATES fresh elements (display:none) rather
// than reusing a previous test's. vi.clearAllMocks() runs LAST.
beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
});

const S4_ID: OverlayId = 'claimView';
const S4_META = OVERLAY_A11Y[S4_ID];

/** A focusable OUTSIDE the overlay: the "pre-open" element a close must restore focus to. */
function outsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root. */
function insideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'inside-sentinel';
  root.appendChild(btn);
  return btn;
}

/** OPEN-LAST capture (plan §8 A3/A5 — applied to the render() door specifically, not
 *  only show(), per D5's real production sequence). See battleView.test.ts's file
 *  header for the full mechanism rationale: a post-hoc read of
 *  mock.calls[...][1].style.display is provably vacuous; this spies on the FIRST
 *  attribute write (`role`) and delegates to the real setAttribute. NEVER
 *  vi.importActual('./overlayA11y'). */
function captureDisplayAtOpen(root: HTMLElement): { display: () => string | undefined } {
  let captured: string | undefined;
  const real = root.setAttribute.bind(root);
  vi.spyOn(root, 'setAttribute').mockImplementation((name: string, value: string) => {
    if (name === 'role' && captured === undefined) captured = root.style.display;
    real(name, value);
  });
  return { display: () => captured };
}

function makeHandlers(): ClaimViewHandlers {
  return {
    onSignIn: vi.fn(),
    onJoin: vi.fn(),
    onDeclineRequested: vi.fn(),
    onDeclineConfirmed: vi.fn(),
    onDeclineCancelled: vi.fn(),
    // rb-52: client specs are NOT typechecked (`client/tsconfig.json` excludes `*.test.ts`), so a
    // missing required handler here is silent until something clicks the button and calls
    // `undefined()`. Spelled out rather than relying on the compiler that does not run.
    onPrivacy: vi.fn(),
  };
}

function makeVm(overrides: Partial<ClaimViewModel> = {}): ClaimViewModel {
  return {
    visible: true,
    title: 'Keep your guest progress',
    body: 'Sign in to claim the progress you made as a guest.',
    confirmPrompt: undefined,
    nudge: undefined,
    feedback: undefined,
    ...overrides,
  };
}

function s4Mount(): { view: ClaimView; handlers: ClaimViewHandlers; overlay: HTMLElement } {
  const handlers = makeHandlers();
  const view = new ClaimView(handlers);
  const overlay = document.getElementById('claim-overlay') as HTMLElement;
  return { view, handlers, overlay };
}

describe('ClaimView — m23-s4 overlay a11y wiring on the show()/hide()/render()/toggle() doors', () => {
  it('S4-claimView-OPEN-ARIA BITES: the first show() from a hidden shell labels the root from OVERLAY_A11Y/t()', () => {
    const { view, overlay } = s4Mount();
    expect(
      view.visible,
      'the shell must start hidden (ensureElement sets display:none), so show() IS an edge',
    ).toBe(false);

    view.show();

    expect(overlay.getAttribute('role')).toBe(S4_META.role);
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('aria-label')).toBe(t(S4_META.labelKey));
  });

  it('S4-claimView-ANCHOR-FOCUS BITES: the anchor resolves to the EXISTING #claim-signin-btn <button> with NO tabindex attribute at all, and focus moves to it after ONE real macrotask (never synchronously)', async () => {
    const { view, overlay } = s4Mount();
    view.show();

    const anchor = overlay.querySelector<HTMLElement>(S4_META.initialFocusSelector);
    expect(
      anchor,
      `the anchor selector ${S4_META.initialFocusSelector} must resolve`,
    ).not.toBeNull();
    expect(anchor!.tagName).toBe('BUTTON');
    expect(
      anchor!.hasAttribute('tabindex'),
      'a NATIVELY focusable control must carry NO tabindex attribute at all — unlike the ' +
        'four <h2> anchors, #claim-signin-btn is a real <button> (claimView.ts:52)',
    ).toBe(false);

    expect(document.activeElement, 'not focused synchronously').not.toBe(anchor);
    await flushMacrotask();
    expect(document.activeElement, 'focused by IDENTITY after one real macrotask').toBe(anchor);
  });

  it('S4-claimView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    const { view, overlay } = s4Mount();

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S4_ID, overlay);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);
  });

  it('S4-claimView-CLOSE-RESTORE-UNGUARDED BITES: hide() strips all three attributes and restores focus to the pre-open element; hide() on a never-shown view still closes without throwing; show/hide/hide yields exactly two closes', async () => {
    const outside = outsideSentinel();
    outside.focus();
    const { view, overlay } = s4Mount();

    view.show();
    await flushMacrotask();
    expect(document.activeElement, 'precondition: the open moved focus into the overlay').not.toBe(
      outside,
    );

    view.hide();
    expect(
      overlay.getAttribute('role'),
      'a display:none root must not keep claiming to be a dialog',
    ).toBeNull();
    expect(overlay.getAttribute('aria-modal')).toBeNull();
    expect(overlay.getAttribute('aria-label')).toBeNull();
    expect(document.activeElement, 'focus must return to the pre-open element').toBe(outside);

    // hide() on a never-shown view: still closes, does not throw (D2's self-heal). Reuses
    // the SAME underlying DOM (ensureElement finds the existing #claim-overlay), which is
    // fine — a NEW ClaimView instance whose visible is already false is what this pins.
    const fresh = new ClaimView(makeHandlers());
    expect(fresh.visible, 'precondition: already hidden from the previous hide() above').toBe(
      false,
    );
    expect(() => fresh.hide()).not.toThrow();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);

    // show/hide/hide => exactly TWO close calls (D2's deliberate asymmetry).
    vi.clearAllMocks();
    const cycle = new ClaimView(makeHandlers());
    cycle.show();
    cycle.hide();
    cycle.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });

  it('S4-claimView-REPEAT-NO-REOPEN BITES: show() on an already-visible overlay neither re-opens nor yanks focus off a sentinel parked inside the root', async () => {
    const { view, overlay } = s4Mount();
    view.show();
    await flushMacrotask();

    const inside = insideSentinel(overlay);
    inside.focus();
    expect(document.activeElement).toBe(inside);

    view.show();
    await flushMacrotask();

    expect(document.activeElement, 'a repeat open must NOT re-run the deferred focus').toBe(inside);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S4-claimView-OPEN-LAST BITES: render(vm.visible=true) from a hidden shell invokes openOverlayA11y AFTER the display write is painted (neither "none" nor "") — never open-before-paint, and applied to the render() door specifically, not only show()', () => {
    const { view, overlay } = s4Mount();
    const capture = captureDisplayAtOpen(overlay);

    view.render(makeVm({ visible: true }));

    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(
      capture.display(),
      'overlay.style.display AT THE INSTANT of the first setAttribute call inside ' +
        'openOverlayA11y, invoked from render() rather than show()',
    ).not.toBe('none');
    expect(capture.display()).not.toBe('');
  });

  it('S4-claimView-TOGGLE BITES: toggle() from hidden opens exactly once; toggle() again closes exactly once', () => {
    const { view } = s4Mount();
    expect(view.visible).toBe(false);

    view.toggle();
    expect(view.visible).toBe(true);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);

    view.toggle();
    expect(view.visible).toBe(false);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S4-claimView-THREE-DOORS BITES: replaying the real production sequence main.ts:446->457->458 (render(visible:true) -> show() -> render(visible:true), inside openClaim()) opens EXACTLY once; then hide() -> render(visible:false) closes exactly once and open stays at one', () => {
    const { view } = s4Mount();
    const vm = makeVm({ visible: true });

    view.render(vm); // main.ts:446 — applyClaim's trailing renderClaim(), BEFORE show()
    view.show(); // main.ts:457 — openClaim's own claimView?.show()
    view.render(vm); // main.ts:458 — openClaim's trailing renderClaim()

    expect(
      vi.mocked(openOverlayA11y),
      'D5: render() and show() must guard on the SAME derived wasVisible source — an ' +
        'unguarded show() (a second open in the same tick) or an unguarded render() open ' +
        '(re-opening on every render) both fail this count',
    ).toHaveBeenCalledTimes(1);

    view.hide();
    view.render(makeVm({ visible: false }));

    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(openOverlayA11y),
      'the close arm of render() must not have re-opened the overlay',
    ).toHaveBeenCalledTimes(1);
  });

  it("S4-claimView-REOPEN-AFTER-HIDE BITES [DOCUMENTED RESIDUAL — pinned, not fixed here; upstream owner: claimModel.ts (a new ClaimEvent) or main.ts (route KeyC through applyClaim), both outside this slice's touches: and reserved for S5]: after hide(), a LATER render(visible=true) — which really happens on reconnect, because ClaimPhase never returns to 'hidden' — re-opens EXACTLY once", () => {
    const { view } = s4Mount();

    view.render(makeVm({ visible: true }));
    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);

    // main.ts's KeyC close calls hide() DIRECTLY, never through applyClaim — so the model
    // still believes the overlay is open.
    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    // A LATER reconnect-driven onClaimPending/onClaimAwaitingAccount/onClaimResult calls
    // applyClaim -> render(vm) with vm.visible === true, because ClaimPhase never
    // transitions back to 'hidden' (verified: no claimStep arm produces it).
    view.render(makeVm({ visible: true }));

    expect(
      vi.mocked(openOverlayA11y),
      'PINNED, not an aspiration: the a11y layer is behaving correctly for the DOM state it ' +
        'observes (hidden -> visible IS a real edge); the defect is upstream, in a model that ' +
        'cannot represent "dismissed". Today this silently re-shows the overlay (a ' +
        'pre-existing display bug); after S4 it also announces and steals focus. Flagged ' +
        'upward, not fixed.',
    ).toHaveBeenCalledTimes(1);
  });
});
