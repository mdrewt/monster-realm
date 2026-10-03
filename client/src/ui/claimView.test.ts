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
import {
  buildClaimViewModel,
  CLAIM_INITIAL,
  type ClaimEvent,
  type ClaimModelState,
  type ClaimViewModel,
  claimStep,
} from './claimModel';
import { ClaimView, type ClaimViewHandlers } from './claimView';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import type { RowOp } from './screens/profileScreen';

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
    // Every required handler is spelled out: vitest does not typecheck, so a missing one would
    // stay silent in the test run until something clicks the button and calls `undefined()`.
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
    actions: {
      signIn: true,
      join: false,
      decline: true,
      declineConfirm: false,
      declineCancel: false,
    },
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

// BUG-claim-overlay-action-buttons-hidden-unlabelled: ensureElement creates every node
// display:none, and render() used to un-hide only the overlay and its text nodes — the five
// action buttons shipped invisible and blank. The view must show exactly the buttons the VM
// marks operable, each with a non-empty label, and hide the rest.
describe('ClaimView — action buttons are shown per vm.actions and labelled', () => {
  const IDS = {
    signIn: 'claim-signin-btn',
    join: 'claim-join-btn',
    decline: 'claim-decline-btn',
    declineConfirm: 'claim-decline-confirm-btn',
    declineCancel: 'claim-decline-cancel-btn',
  } as const;
  const btn = (id: string): HTMLButtonElement => {
    const el = document.getElementById(id);
    expect(el, `#${id} must exist`).not.toBeNull();
    return el as HTMLButtonElement;
  };
  const shown = (id: string): boolean => btn(id).style.display !== 'none';

  it('prompt actions: sign-in and decline are visible and labelled; join/confirm/cancel stay hidden', () => {
    const { view } = s4Mount();
    view.render(
      makeVm({
        actions: {
          signIn: true,
          join: false,
          decline: true,
          declineConfirm: false,
          declineCancel: false,
        },
      }),
    );
    expect(shown(IDS.signIn)).toBe(true);
    expect(shown(IDS.decline)).toBe(true);
    expect(shown(IDS.join)).toBe(false);
    expect(shown(IDS.declineConfirm)).toBe(false);
    expect(shown(IDS.declineCancel)).toBe(false);
    for (const id of Object.values(IDS)) {
      expect(btn(id).textContent?.trim().length ?? 0, `#${id} must carry a label`).toBeGreaterThan(
        0,
      );
    }
    expect(
      new Set(Object.values(IDS).map((id) => btn(id).textContent)).size,
      'five distinct labels',
    ).toBe(5);
  });

  it('a later render flips visibility (armed decline shows confirm + cancel only)', () => {
    const { view } = s4Mount();
    view.render(makeVm());
    view.render(
      makeVm({
        actions: {
          signIn: false,
          join: false,
          decline: false,
          declineConfirm: true,
          declineCancel: true,
        },
      }),
    );
    expect(shown(IDS.signIn)).toBe(false);
    expect(shown(IDS.decline)).toBe(false);
    expect(shown(IDS.declineConfirm)).toBe(true);
    expect(shown(IDS.declineCancel)).toBe(true);
  });

  it('the initial-focus anchor #claim-signin-btn is VISIBLE when the prompt opens, and focus lands on it', async () => {
    const { view } = s4Mount();
    view.render(
      makeVm({
        actions: {
          signIn: true,
          join: false,
          decline: true,
          declineConfirm: false,
          declineCancel: false,
        },
      }),
    );
    await flushMacrotask();
    const anchor = btn(IDS.signIn);
    expect(anchor.style.display).not.toBe('none');
    expect(document.activeElement).toBe(anchor);
  });
});

// ===========================================================================================
// ctl-8h (CTL8H.3): the claim frame's rows, its default-No, B2 and B3.
//
// The rows are the overlay's real shown action buttons plus #claim-privacy-btn, in DOM order; the
// cursor IS document.activeElement. accountScreen hands the view one-shot row tokens through
// `view.applyRowOp(op)` (see renameView.test.ts for the contract's wording). Re-seating on a
// render happens ONLY when the overlay was already visible before it: the arm edge (confirmPrompt
// undefined -> defined) focuses No (#claim-decline-cancel-btn), the disarm edge focuses the arming
// button (#claim-decline-btn), and a focused control that the render hid goes to the default row.
// A plain re-render with the same vm never moves focus.
// ===========================================================================================

/** The nearest ancestor (the node itself included) that is `display:none`, described for a
 *  failure message, or null when the node is on screen all the way to <body>. */
function hiddenAncestorOf(start: Element | null): string | null {
  for (let node: Element | null = start; node instanceof HTMLElement; node = node.parentElement) {
    if (node.style.display === 'none') return node.id === '' ? node.tagName : `#${node.id}`;
  }
  return null;
}

const OPENED: ClaimEvent = { kind: 'claim-ui-opened', nudgeAlreadySeen: true };

/** The model state after `events`, run through the REAL reducer from the initial state. */
function stateAfter(...events: ClaimEvent[]): ClaimModelState {
  let state: ClaimModelState = CLAIM_INITIAL;
  for (const event of events) state = claimStep(state, event).next;
  return state;
}

/** Every visible ClaimPhase, reached by running events, with the buttons it shows (ids, DOM
 *  order, the privacy door last). */
const CLAIM_PHASES: ReadonlyArray<{
  readonly label: string;
  readonly state: ClaimModelState;
  readonly rows: readonly string[];
}> = [
  {
    label: 'prompt',
    state: stateAfter(OPENED),
    rows: ['claim-signin-btn', 'claim-decline-btn', 'claim-privacy-btn'],
  },
  {
    label: 'prompt with the first-run nudge',
    state: stateAfter({ kind: 'claim-ui-opened', nudgeAlreadySeen: false }),
    rows: ['claim-signin-btn', 'claim-decline-btn', 'claim-privacy-btn'],
  },
  {
    label: 'code-pending',
    state: stateAfter(OPENED, { kind: 'claim-pending', code: 'c0de' }),
    rows: ['claim-decline-btn', 'claim-privacy-btn'],
  },
  {
    label: 'awaiting-account',
    state: stateAfter(OPENED, { kind: 'claim-awaiting-account' }),
    rows: ['claim-decline-btn', 'claim-privacy-btn'],
  },
  {
    label: 'rejected: a dead code lifts the veto',
    state: stateAfter(OPENED, {
      kind: 'claim-rejected',
      message: 'code expired',
      claimedFrom: undefined,
    }),
    rows: ['claim-join-btn', 'claim-privacy-btn'],
  },
  {
    label: 'rejected: the destination is terminal',
    state: stateAfter(OPENED, {
      kind: 'claim-rejected',
      message: 'account already claimed',
      claimedFrom: undefined,
    }),
    rows: ['claim-decline-btn', 'claim-privacy-btn'],
  },
  {
    label: 'rejected: transient',
    state: stateAfter(OPENED, {
      kind: 'claim-rejected',
      message: 'close your other tab, then retry',
      claimedFrom: undefined,
    }),
    rows: ['claim-decline-btn', 'claim-privacy-btn'],
  },
  {
    label: 'rejected: not claim specific',
    state: stateAfter(OPENED, {
      kind: 'claim-rejected',
      message: 'sign in required',
      claimedFrom: undefined,
    }),
    rows: ['claim-decline-btn', 'claim-privacy-btn'],
  },
  {
    label: 'sign-in-failed',
    state: stateAfter(OPENED, { kind: 'sign-in-failed', reason: 'sign-in-rejected' }),
    rows: ['claim-signin-btn', 'claim-decline-btn', 'claim-privacy-btn'],
  },
  {
    label: 'sign-in-failed, an unrecognised reason',
    state: stateAfter(OPENED, { kind: 'sign-in-failed', reason: 'something-new' }),
    rows: ['claim-signin-btn', 'claim-decline-btn', 'claim-privacy-btn'],
  },
  {
    label: 'claimed',
    state: stateAfter(OPENED, { kind: 'claim-succeeded' }),
    rows: ['claim-join-btn', 'claim-privacy-btn'],
  },
  {
    label: 'decline armed',
    state: stateAfter(OPENED, { kind: 'decline-requested' }),
    rows: ['claim-decline-confirm-btn', 'claim-decline-cancel-btn', 'claim-privacy-btn'],
  },
];

const moveOp = (delta: -1 | 1): RowOp => ({ kind: 'move', delta });
const activateOp = (): RowOp => ({ kind: 'activate' });
const focusedId = (): string => (document.activeElement as HTMLElement | null)?.id ?? '';
const blurAll = (): void => (document.activeElement as HTMLElement | null)?.blur();

/** The handlers that fired, by name. */
const firedNames = (h: ClaimViewHandlers): string[] =>
  (Object.keys(h) as (keyof ClaimViewHandlers)[]).filter(
    (name) => vi.mocked(h[name]).mock.calls.length > 0,
  );

const PROMPT_VM: ClaimViewModel = makeVm();
const ARMED_VM: ClaimViewModel = makeVm({
  confirmPrompt: 'Really decline?',
  actions: {
    signIn: false,
    join: false,
    decline: false,
    declineConfirm: true,
    declineCancel: true,
  },
});
const CLAIMED_VM: ClaimViewModel = makeVm({
  actions: {
    signIn: false,
    join: true,
    decline: false,
    declineConfirm: false,
    declineCancel: false,
  },
});

/** A brand new DOM and view, rendered once with `vm` (the overlay is visible afterwards). */
function freshVisible(vm: ClaimViewModel): { view: ClaimView; handlers: ClaimViewHandlers } {
  closeOverlayA11y('claimView', null);
  document.body.replaceChildren();
  const handlers = makeHandlers();
  const view = new ClaimView(handlers);
  view.render(vm);
  return { view, handlers };
}

/** The ids of the focusable rows, found by pressing the view's own D-pad: seat the default row,
 *  walk to the first row (clamped), then walk down until the cursor stops. */
function walkRows(view: ClaimView): string[] {
  blurAll();
  view.applyRowOp(moveOp(-1));
  for (let i = 0; i < 12; i += 1) view.applyRowOp(moveOp(-1));
  const out = [focusedId()];
  for (let i = 0; i < 12; i += 1) {
    view.applyRowOp(moveOp(1));
    const id = focusedId();
    if (id === out[out.length - 1]) break;
    out.push(id);
  }
  return out;
}

const div = (id: string): HTMLElement => {
  const el = document.createElement('div');
  el.id = id;
  return el;
};

describe('ClaimView ctl-8h: rows, default-No, B2 and B3', () => {
  it('CTL8H-3-B2-TITLE-BODY-VISIBLE: in every visible claim phase (prompt, code-pending, awaiting-account, each rejection, sign-in-failed, claimed, armed decline) a render alone shows #claim-title and #claim-body, with the vm text, all the way up to <body>', () => {
    // WRONG IMPL KILLED: today's shell (ensureElement creates both display:none and render()
    // only writes their text: a player reads an empty box, B2); an un-hide done in show() only
    // (the production sequence is render -> show -> render, but a reconnect-driven render alone
    // re-opens it); an un-hide in ONE phase only (the prompt, the e2e's A1); an un-hide of the
    // title but not the body; and text written to the wrong node. The phases are reached by
    // running the real reducer, never by a hand-built vm.
    expect(
      new Set(CLAIM_PHASES.map((c) => c.state.phase)),
      'ANTI-VACUITY: every visible phase is driven',
    ).toEqual(
      new Set([
        'prompt',
        'code-pending',
        'awaiting-account',
        'rejected',
        'sign-in-failed',
        'claimed',
      ]),
    );
    for (const { label, state } of CLAIM_PHASES) {
      closeOverlayA11y('claimView', null);
      document.body.replaceChildren();
      const view = new ClaimView(makeHandlers());
      const title = document.getElementById('claim-title');
      const body = document.getElementById('claim-body');
      expect(hiddenAncestorOf(title), `${label}: ANTI-VACUITY: hidden before the render`).not.toBe(
        null,
      );
      expect(hiddenAncestorOf(body), `${label}: ANTI-VACUITY: hidden before the render`).not.toBe(
        null,
      );

      const vm = buildClaimViewModel(state);
      view.render(vm);
      expect(view.visible, `${label}: the overlay is visible`).toBe(true);
      expect(hiddenAncestorOf(title), `${label}: #claim-title on screen`).toBeNull();
      expect(hiddenAncestorOf(body), `${label}: #claim-body on screen`).toBeNull();
      expect(title?.textContent, `${label}: the title text`).toBe(vm.title);
      expect(body?.textContent, `${label}: the body text`).toBe(vm.body);
      expect((title?.textContent ?? '').length, `${label}: a title to read`).toBeGreaterThan(0);
      expect((body?.textContent ?? '').length, `${label}: a body to read`).toBeGreaterThan(0);
    }
  });

  it('CTL8H-3-B3-ANCHOR: the overlay is attached under #frame-layer when present, else under #game-screen, else directly under <body>, and carries the classes mr-frame and mr-shell with all its controls inside it', () => {
    // WRONG IMPL KILLED: an overlay appended to <body> whatever the page has (it renders in flow
    // below the canvas, black on near-black: B3); one anchored by a parent id alone (always
    // #game-screen, or the first child of <body>); a frame-layer lookup that only works inside
    // #game-screen; a lookup that ignores #frame-layer when #game-screen exists; a missing class
    // (the shell styles hang on mr-frame / mr-shell); and children left outside the overlay.
    const build = (...nodes: HTMLElement[]): HTMLElement => {
      document.body.replaceChildren(...nodes);
      const view = new ClaimView(makeHandlers());
      expect(view.visible, 'constructed hidden').toBe(false);
      const overlay = document.getElementById('claim-overlay');
      if (overlay === null) throw new Error('#claim-overlay must exist after construction');
      expect(overlay.classList.contains('mr-frame'), 'class mr-frame').toBe(true);
      expect(overlay.classList.contains('mr-shell'), 'class mr-shell').toBe(true);
      for (const id of ['claim-title', 'claim-body', 'claim-signin-btn', 'claim-privacy-btn']) {
        expect(overlay.contains(document.getElementById(id)), `#${id} is inside the overlay`).toBe(
          true,
        );
      }
      return overlay;
    };

    // #game-screen > #frame-layer
    const gameScreen = div('game-screen');
    const frameLayer = div('frame-layer');
    gameScreen.appendChild(frameLayer);
    let overlay = build(gameScreen, div('app'));
    expect(frameLayer.contains(overlay), 'under #frame-layer').toBe(true);
    expect(gameScreen.contains(overlay), 'and so inside #game-screen').toBe(true);
    expect(overlay.parentElement, 'not parked on <body>').not.toBe(document.body);

    // #game-screen alone
    const lonely = div('game-screen');
    overlay = build(lonely, div('app'));
    expect(lonely.contains(overlay), 'else under #game-screen').toBe(true);

    // #frame-layer outside #game-screen
    const looseLayer = div('frame-layer');
    overlay = build(div('app'), looseLayer);
    expect(looseLayer.contains(overlay), 'a lone #frame-layer is still the anchor').toBe(true);

    // neither: directly under <body>, not inside some unrelated first child
    const app = div('app');
    overlay = build(app);
    expect(overlay.parentElement, 'else directly under <body>').toBe(document.body);
    expect(app.contains(overlay), 'and not inside an unrelated node').toBe(false);
  });

  it('CTL8H-3-VIEW-ROW-OPS: applyRowOp walks the shown buttons in DOM order with focus as the cursor (hidden buttons skipped, clamped, no wrap), no row focused seats the default row (the first, or No when armed), activate clicks the focused button once and fires nothing when no row is focused, and the same op object applies once', () => {
    // WRONG IMPL KILLED: rows that include a display:none button (focus() on it is a no-op: the
    // cursor sticks); a wrap; a move from nothing that lands on the second row; an activate that
    // fires the default row when nothing is focused (an armed reopen would CONFIRM the decline
    // on a stray A); an activate that clicks twice or clicks the wrong button; a default that is
    // the first row while armed (Confirm); and an op re-applied by shape instead of identity.
    const { view, handlers } = freshVisible(PROMPT_VM);

    // --- no row focused: the default row, for either direction ---------------------------------
    blurAll();
    view.applyRowOp(moveOp(1));
    expect(focusedId(), 'move +1 with nothing focused: the first row').toBe('claim-signin-btn');
    blurAll();
    view.applyRowOp(moveOp(-1));
    expect(focusedId(), 'move -1 with nothing focused: the first row').toBe('claim-signin-btn');

    // --- the walk: hidden join / confirm / cancel buttons are skipped, the ends clamp ---------
    const down: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      view.applyRowOp(moveOp(1));
      down.push(focusedId());
    }
    expect(down, 'down, then clamped on the privacy door').toEqual([
      'claim-decline-btn',
      'claim-privacy-btn',
      'claim-privacy-btn',
      'claim-privacy-btn',
    ]);
    const up: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      view.applyRowOp(moveOp(-1));
      up.push(focusedId());
    }
    expect(up, 'up, then clamped on the first row').toEqual([
      'claim-decline-btn',
      'claim-signin-btn',
      'claim-signin-btn',
      'claim-signin-btn',
    ]);

    // --- activate clicks the focused button, once ----------------------------------------------
    view.applyRowOp(moveOp(1));
    expect(focusedId()).toBe('claim-decline-btn');
    view.applyRowOp(activateOp());
    expect(firedNames(handlers), 'A on Decline').toEqual(['onDeclineRequested']);
    expect(handlers.onDeclineRequested).toHaveBeenCalledTimes(1);
    view.applyRowOp(moveOp(1));
    expect(focusedId()).toBe('claim-privacy-btn');
    view.applyRowOp(activateOp());
    expect(handlers.onPrivacy, 'A on the privacy door').toHaveBeenCalledTimes(1);
    expect(handlers.onDeclineRequested, 'and nothing else fired again').toHaveBeenCalledTimes(1);

    // --- activate with no row focused: seat the default row, fire nothing ------------------------
    for (const name of Object.keys(handlers) as (keyof ClaimViewHandlers)[]) {
      vi.mocked(handlers[name]).mockClear();
    }
    blurAll();
    view.applyRowOp(activateOp());
    expect(focusedId(), 'A with no row focused seats the first row').toBe('claim-signin-btn');
    expect(firedNames(handlers), 'and fires nothing').toEqual([]);

    // --- armed: the default row is No, never Confirm ------------------------------------------
    view.render(ARMED_VM);
    blurAll();
    view.applyRowOp(moveOp(1));
    expect(focusedId(), 'armed, nothing focused: move seats No, not the first row').toBe(
      'claim-decline-cancel-btn',
    );
    blurAll();
    view.applyRowOp(activateOp());
    expect(focusedId(), 'armed, nothing focused: A seats No').toBe('claim-decline-cancel-btn');
    expect(firedNames(handlers), 'and neither confirms nor cancels').toEqual([]);
    view.applyRowOp(moveOp(-1));
    expect(focusedId(), 'up from No: Confirm').toBe('claim-decline-confirm-btn');
    view.applyRowOp(moveOp(1));
    view.applyRowOp(moveOp(1));
    expect(focusedId(), 'down past No: the privacy door').toBe('claim-privacy-btn');

    // --- the identity memo ----------------------------------------------------------------
    view.render(PROMPT_VM);
    const hop = moveOp(1);
    (document.getElementById('claim-signin-btn') as HTMLElement).focus();
    view.applyRowOp(hop);
    expect(focusedId(), 'the first application moves').toBe('claim-decline-btn');
    (document.getElementById('claim-signin-btn') as HTMLElement).focus();
    view.applyRowOp(hop);
    expect(focusedId(), 'the same op object is not applied twice').toBe('claim-signin-btn');
    view.applyRowOp(moveOp(1));
    expect(focusedId(), 'an equal but fresh op is a new press').toBe('claim-decline-btn');

    vi.mocked(handlers.onDeclineRequested).mockClear();
    const press = activateOp();
    view.applyRowOp(press);
    view.applyRowOp(press);
    expect(
      handlers.onDeclineRequested,
      'the same activate token clicks once',
    ).toHaveBeenCalledTimes(1);
    view.applyRowOp(activateOp());
    expect(handlers.onDeclineRequested, 'a fresh token clicks again').toHaveBeenCalledTimes(2);
  });

  it('CTL8H-3-ROWS: in every claim phase the rows the D-pad walks are exactly the shown buttons in DOM order, the privacy door last', () => {
    // WRONG IMPL KILLED: a fixed row list (the armed phase swaps Decline for Confirm / Cancel; a
    // claimed account shows Join; a dead code shows Join, not Decline); rows that include a hidden
    // button or omit the always-shown privacy door; privacy not last; and rows derived from a
    // stale vm instead of the DOM the last render painted.
    let checked = 0;
    for (const { label, state, rows } of CLAIM_PHASES) {
      const { view } = freshVisible(buildClaimViewModel(state));
      const overlay = document.getElementById('claim-overlay') as HTMLElement;
      const shownInDom = [...overlay.querySelectorAll('button')]
        .filter((b) => hiddenAncestorOf(b) === null && !b.disabled)
        .map((b) => b.id);
      expect(shownInDom, `${label}: the table agrees with the DOM the render painted`).toEqual(
        rows,
      );
      expect(walkRows(view), `${label}: the D-pad rows`).toEqual(rows);
      expect(rows[rows.length - 1], `${label}: the privacy door is last`).toBe('claim-privacy-btn');
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every phase case was walked').toBe(CLAIM_PHASES.length);
  });

  it('CTL8H-3-DEFAULT-NO: when the overlay is already visible, arming focuses No (from a focused Decline, the privacy door or the page), disarming focuses the Decline button, a focused control the render hid goes to the default row, and a re-render with the same vm moves nothing; the open edge moves nothing; a re-shown armed overlay with focus on the page seats No on A and never confirms', () => {
    // WRONG IMPL KILLED: a default-No that only runs on the click edge (the arm edge is a render:
    // the Decline button is hidden under focus and focus falls to the page, where the next A /
    // Enter is a stray key); a Confirm that takes the focus (one Enter confirms a deletion of the
    // claim code); a re-seat on every render (the player's own move to Confirm is undone by the
    // next batch); a re-seat on the open edge (overlayA11y owns it, and a second focus owner
    // steals from the page); a disarm that leaves focus on a hidden button; and, for an overlay
    // hidden and shown again while still armed, an activate that fires Confirm for focus on <body>.
    const id = (x: string): HTMLButtonElement => document.getElementById(x) as HTMLButtonElement;

    // --- the open edge moves nothing (overlayA11y owns the initial focus) -----------------------
    closeOverlayA11y('claimView', null);
    document.body.replaceChildren();
    const outside = outsideSentinel();
    outside.focus();
    const opening = new ClaimView(makeHandlers());
    opening.render(ARMED_VM);
    expect(document.activeElement, 'the open edge re-seats nothing').toBe(outside);

    // --- the arm edge: from a focused Decline (hidden by the render) ------------------------------
    {
      const { view } = freshVisible(PROMPT_VM);
      id('claim-decline-btn').focus();
      view.render(ARMED_VM);
      expect(focusedId(), 'armed from Decline: focus on No').toBe('claim-decline-cancel-btn');
      expect(focusedId(), 'never Confirm').not.toBe('claim-decline-confirm-btn');
    }
    // --- the arm edge: from a control the render keeps (the privacy door) --------------------
    {
      const { view } = freshVisible(PROMPT_VM);
      id('claim-privacy-btn').focus();
      view.render(ARMED_VM);
      expect(focusedId(), 'armed with focus elsewhere in the overlay: focus on No').toBe(
        'claim-decline-cancel-btn',
      );
    }
    // --- the arm edge: from the page -----------------------------------------------------------
    {
      const { view } = freshVisible(PROMPT_VM);
      blurAll();
      view.render(ARMED_VM);
      expect(focusedId(), 'armed with focus on the page: focus on No').toBe(
        'claim-decline-cancel-btn',
      );
    }
    // --- a plain re-render with the same vm moves nothing ----------------------------------
    {
      const { view } = freshVisible(ARMED_VM);
      id('claim-decline-confirm-btn').focus();
      view.render(ARMED_VM);
      expect(focusedId(), 'the player moved to Confirm: a same-vm render leaves it').toBe(
        'claim-decline-confirm-btn',
      );
      view.render(ARMED_VM);
      expect(focusedId(), 'and again').toBe('claim-decline-confirm-btn');
    }
    {
      const { view } = freshVisible(PROMPT_VM);
      id('claim-privacy-btn').focus();
      view.render(PROMPT_VM);
      view.render(makeVm({ feedback: 'Something happened' }));
      expect(focusedId(), 'unarmed re-renders leave the focus where it is').toBe(
        'claim-privacy-btn',
      );
    }
    // --- the disarm edge: back to the Decline button ---------------------------------------------
    {
      const { view } = freshVisible(PROMPT_VM);
      id('claim-decline-btn').focus();
      view.render(ARMED_VM);
      id('claim-decline-confirm-btn').focus();
      view.render(PROMPT_VM);
      expect(focusedId(), 'disarmed: focus on the button that armed it').toBe('claim-decline-btn');
    }
    // --- a focused control the render hid goes to the default row ------------------------------
    {
      const { view } = freshVisible(CLAIMED_VM);
      id('claim-join-btn').focus();
      view.render(PROMPT_VM);
      expect(focusedId(), 'Join was hidden under focus: the first row of the new prompt').toBe(
        'claim-signin-btn',
      );
    }
    // --- hidden, then shown again while armed, focus on the page: A seats No, confirms nothing --
    {
      const { view, handlers } = freshVisible(ARMED_VM);
      view.render(makeVm({ visible: false }));
      expect(view.visible, 'precondition: the overlay is hidden').toBe(false);
      blurAll();
      view.render(ARMED_VM);
      expect(view.visible, 'shown again, still armed').toBe(true);
      expect(document.activeElement, 'precondition: focus is on the page').toBe(document.body);
      view.applyRowOp(activateOp());
      expect(focusedId(), 'A seats No').toBe('claim-decline-cancel-btn');
      expect(
        handlers.onDeclineConfirmed,
        'and does not confirm the decline',
      ).not.toHaveBeenCalled();
      expect(firedNames(handlers), 'it fired nothing at all').toEqual([]);
      view.applyRowOp(activateOp());
      expect(
        handlers.onDeclineCancelled,
        'the next A is the real press on No',
      ).toHaveBeenCalledTimes(1);
      expect(handlers.onDeclineConfirmed).not.toHaveBeenCalled();
    }
  });
});
