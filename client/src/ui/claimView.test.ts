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
//
// uif-16b (UIF16B.1-UIF16B.4) — THE OVERLAY IS NOW A SECTION. ClaimView is Profile's Account
// section: it opens no a11y of its own (the one dialog is ProfileView's), `render(vm)` NO LONGER
// writes the root's display (`show()` / `hide()` own it; `vm.visible` is main.ts's auto-open
// signal only), the frame title bar becomes `h2#claim-frame-title.mr-section-header`, the frame
// classes go (`mr-button-rows` stays), `applyRowOp` retires (the frame walks the one column), the
// new REQUIRED `onDismissed` handler is called from every `hide()`, and `armed` is public. So the
// m23-s4 block below is REPLACED: its open/close/trap/focus teeth live at frame level in
// ui/profileView.test.ts UIF16B.3 and ui/overlayA11yWiring.test.ts (S10-WIRE-*:profileView); the
// three-doors shape is gone (one door: show()); and the DOCUMENTED RESIDUAL above
// (S4-claimView-REOPEN-AFTER-HIDE) is moot: render() cannot re-show the section, and hide()'s
// onDismissed is the dismissal the model lacked. What stays here is section behaviour.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildClaimViewModel,
  CLAIM_INITIAL,
  type ClaimEvent,
  type ClaimModelState,
  type ClaimViewModel,
  claimStep,
} from './claimModel';
import { ClaimView, type ClaimViewHandlers } from './claimView';
import { CATALOG_EN } from './i18n/catalog.en';
import { t as i18nT } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_IDS } from './overlayRegistry';
import { type RowOp, type RowSection, walkSection } from './screens/profileScreen';

// The m23-s4 MECHANISM oracle. `{ spy: true }` records every call AND calls through
// to the real implementation, so the VALUE oracle (real attribute writes, real focus
// moves) still works.
vi.mock('./overlayA11y', { spy: true });
// The resolver is spied the same way: every t() request is recorded and answered by the real one.
vi.mock('./i18n/resolver', { spy: true });

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

/** Close every overlay record (sync; the file-level hooks also flush a macrotask). */
function sweepA11y(): void {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
}

/** uif-16b: the section's own `applyRowOp` retires (ProfileView walks the one column). This is
 *  the frame's one-token rule over THIS section alone: `walkSection` over its RowSection, a
 *  pressed row clicked when it is a button. The token-once memo is the frame's
 *  (ui/profileView.test.ts UIF16B.2). */
function walk(section: RowSection, op: RowOp): void {
  const press = walkSection(section, document.activeElement, op);
  if (press instanceof HTMLButtonElement) press.click();
}

/** A focusable OUTSIDE the overlay: the "pre-open" element a close must restore focus to. */
function outsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

function makeHandlers(): ClaimViewHandlers {
  return {
    onSignIn: vi.fn(),
    onJoin: vi.fn(),
    onDeclineRequested: vi.fn(),
    onDeclineConfirmed: vi.fn(),
    onDeclineCancelled: vi.fn(),
    // Every required handler is spelled out so a missing one cannot stay silent until something
    // clicks the button and calls `undefined()`.
    // The required dismissal, called from every hide().
    onDismissed: vi.fn(),
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

// uif-16b: the nine m23-s4 tests that stood here (OPEN-ARIA, ANCHOR-FOCUS, HELPER-CALLED,
// CLOSE-RESTORE-UNGUARDED, REPEAT-NO-REOPEN, OPEN-LAST, TOGGLE, THREE-DOORS, REOPEN-AFTER-HIDE)
// pinned this view's OWN overlay a11y on three doors. The section opens nothing now; the frame's
// equivalents are ui/profileView.test.ts UIF16B.3 (one dialog via the helper, labelled from
// a11yCopy; close strips and restores; a repeat show() neither re-opens nor moves focus; the
// unguarded close; the Account section's anchor seated by show('account')). The residual
// REOPEN-AFTER-HIDE pinned is moot (header). The section-level halves follow.

describe('ClaimView (uif-16b): a section with one door', () => {
  it('UIF16B.3 show(), render() of every phase, a repeat show() and hide() never call openOverlayA11y or closeOverlayA11y, and the root never carries role, aria-modal or aria-label', async () => {
    // WRONG IMPL KILLED: a section that still opens its own dialog from show() or from render()
    // (two traps cannot coexist; a claim event would re-open a second dialog inside Profile); a
    // hand-written dialog attribute; a hide() that still closes `claimView`.
    const { view, overlay } = s4Mount();
    view.show();
    for (const [, state] of CLAIM_PHASES.map((c) => [c.label, c.state] as const)) {
      view.render(buildClaimViewModel(state));
    }
    view.show();
    await flushMacrotask();
    for (const attr of ['role', 'aria-modal', 'aria-label']) {
      expect(overlay.hasAttribute(attr), `no ${attr}`).toBe(false);
    }
    view.hide();
    expect(vi.mocked(openOverlayA11y), 'the section opens nothing').not.toHaveBeenCalled();
    expect(vi.mocked(closeOverlayA11y), 'nor closes anything').not.toHaveBeenCalled();
  });

  it('UIF16B.1 render(vm) never writes the root display: a render of a hidden section leaves it hidden (vm.visible true or false), a render of a shown section leaves it shown; only show() and hide() move it', () => {
    // WRONG IMPL KILLED: the old `display = vm.visible ? 'block' : 'none'` kept (a claim event
    // would show the Account section ALONE outside the frame, or hide it inside an open Profile:
    // a hole in the one screen); a show() that leaves the root hidden.
    const { view, overlay } = s4Mount();
    expect(view.visible, 'constructed hidden').toBe(false);
    view.render(makeVm({ visible: true }));
    expect(view.visible, 'a visible vm does not show a hidden section').toBe(false);
    expect(overlay.style.display).toBe('none');
    view.show();
    expect(view.visible, 'show() shows it').toBe(true);
    expect(overlay.style.display).toBe('block');
    view.render(makeVm({ visible: false }));
    expect(view.visible, 'a hidden vm does not hide a shown section').toBe(true);
    expect(overlay.style.display).toBe('block');
    view.render(ARMED_VM);
    expect(view.visible).toBe(true);
    view.hide();
    expect(view.visible, 'hide() hides it').toBe(false);
    view.render(makeVm({ visible: true }));
    expect(view.visible, 'and a later render cannot re-show it (the old residual)').toBe(false);
  });

  it('UIF16B.4 every hide() calls onDismissed exactly once (shown or not), and nothing else fires', () => {
    // WRONG IMPL KILLED: no dismissal (an armed decline stays armed behind a closed Profile, one
    // Down away from the Name field next time: plan review RT-1); a dismissal guarded on
    // visibility (a reconnect's force-hide of an already-hidden frame would skip it); a dismissal
    // wired to Decline cancel (it would send a model event the player never chose).
    const { view, handlers } = s4Mount();
    view.hide();
    expect(handlers.onDismissed, 'a hide() of a never-shown section').toHaveBeenCalledTimes(1);
    view.show();
    view.render(ARMED_VM);
    view.hide();
    expect(handlers.onDismissed, 'a hide() of a shown, armed section').toHaveBeenCalledTimes(2);
    expect(firedNames(handlers), 'only the dismissal').toEqual(['onDismissed']);
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

  it('UIF16B.3 in the sign-in prompt the section`s default row (the anchor show(`account`) seats) is the VISIBLE #claim-signin-btn, and a render alone moves no focus', async () => {
    // INTENTIONAL CHANGE (uif-16b): was "the initial-focus anchor #claim-signin-btn is VISIBLE
    // when the prompt opens, and focus lands on it" (render() opened this overlay's own a11y,
    // whose deferred anchor focused it). The Account anchor is now the frame's
    // focusSection('account') = this section's defaultRow() (ui/profileView.test.ts UIF16B.3).
    // WRONG IMPL KILLED: a default row on a hidden button; a render that still focuses (a claim
    // event would pull the player out of the Name field).
    const { view } = s4Mount();
    const outside = outsideSentinel();
    outside.focus();
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
    expect(view.defaultRow()).toBe(anchor);
    expect(document.activeElement, 'a render moves no focus').toBe(outside);
  });
});

// ===========================================================================================
// ctl-8h (CTL8H.3): the claim frame's rows, its default-No, B2 and B3.
//
// The rows are the overlay's real shown action buttons, in DOM order; the
// cursor IS document.activeElement. accountScreen hands the view one-shot row tokens through
// `walk(view,op)` (see renameView.test.ts for the contract's wording). Re-seating on a
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
 *  order). */
const CLAIM_PHASES: ReadonlyArray<{
  readonly label: string;
  readonly state: ClaimModelState;
  readonly rows: readonly string[];
}> = [
  {
    label: 'prompt',
    state: stateAfter(OPENED),
    rows: ['claim-signin-btn', 'claim-decline-btn'],
  },
  {
    label: 'prompt with the first-run nudge',
    state: stateAfter({ kind: 'claim-ui-opened', nudgeAlreadySeen: false }),
    rows: ['claim-signin-btn', 'claim-decline-btn'],
  },
  {
    label: 'code-pending',
    state: stateAfter(OPENED, { kind: 'claim-pending', code: 'c0de' }),
    rows: ['claim-decline-btn'],
  },
  {
    label: 'awaiting-account',
    state: stateAfter(OPENED, { kind: 'claim-awaiting-account' }),
    rows: ['claim-decline-btn'],
  },
  {
    label: 'rejected: a dead code lifts the veto',
    state: stateAfter(OPENED, {
      kind: 'claim-rejected',
      message: 'code expired',
      claimedFrom: undefined,
    }),
    rows: ['claim-join-btn'],
  },
  {
    label: 'rejected: the destination is terminal',
    state: stateAfter(OPENED, {
      kind: 'claim-rejected',
      message: 'account already claimed',
      claimedFrom: undefined,
    }),
    rows: ['claim-decline-btn'],
  },
  {
    label: 'rejected: transient',
    state: stateAfter(OPENED, {
      kind: 'claim-rejected',
      message: 'close your other tab, then retry',
      claimedFrom: undefined,
    }),
    rows: ['claim-decline-btn'],
  },
  {
    label: 'rejected: not claim specific',
    state: stateAfter(OPENED, {
      kind: 'claim-rejected',
      message: 'sign in required',
      claimedFrom: undefined,
    }),
    rows: ['claim-decline-btn'],
  },
  {
    label: 'sign-in-failed',
    state: stateAfter(OPENED, { kind: 'sign-in-failed', reason: 'sign-in-rejected' }),
    rows: ['claim-signin-btn', 'claim-decline-btn'],
  },
  {
    label: 'sign-in-failed, an unrecognised reason',
    state: stateAfter(OPENED, { kind: 'sign-in-failed', reason: 'something-new' }),
    rows: ['claim-signin-btn', 'claim-decline-btn'],
  },
  {
    label: 'claimed',
    state: stateAfter(OPENED, { kind: 'claim-succeeded' }),
    rows: ['claim-join-btn'],
  },
  {
    label: 'decline armed',
    state: stateAfter(OPENED, { kind: 'decline-requested' }),
    rows: ['claim-decline-confirm-btn', 'claim-decline-cancel-btn'],
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

/** A brand new DOM and view, rendered once with `vm` and then shown (the section is visible
 *  afterwards). uif-16b (named fixture change): render() no longer shows the section, so the
 *  fixture paints and then calls show(), the order main.ts's showProfile thunk uses (paint, then
 *  ProfileView.show()). Was: render(vm) alone. */
function freshVisible(vm: ClaimViewModel): { view: ClaimView; handlers: ClaimViewHandlers } {
  sweepA11y();
  document.body.replaceChildren();
  const handlers = makeHandlers();
  const view = new ClaimView(handlers);
  view.render(vm);
  view.show();
  return { view, handlers };
}

/** The ids of the focusable rows, found by pressing the view's own D-pad: seat the default row,
 *  walk to the first row (clamped), then walk down until the cursor stops. */
function walkRows(view: ClaimView): string[] {
  blurAll();
  walk(view, moveOp(-1));
  for (let i = 0; i < 12; i += 1) walk(view, moveOp(-1));
  const out = [focusedId()];
  for (let i = 0; i < 12; i += 1) {
    walk(view, moveOp(1));
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
  it('UIF16B.1 in every visible claim phase (prompt, code-pending, awaiting-account, each rejection, sign-in-failed, claimed, armed decline) a render un-hides #claim-title and #claim-body with the vm text (only the still-hidden section root hides them), and once show() runs they are on screen all the way up to <body>', () => {
    // INTENTIONAL CHANGE (uif-16b): was CTL8H-3-B2-TITLE-BODY-VISIBLE, "a render alone shows ...
    // all the way up to <body>". render() no longer writes the root's display, so a render alone
    // leaves the nearest hidden ancestor the section root itself; the B2 bite (the nodes' OWN
    // ensureElement display:none) is kept by pinning that ancestor's id exactly.
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
      sweepA11y();
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
      expect(view.visible, `${label}: a render alone does not show the section`).toBe(false);
      expect(hiddenAncestorOf(title), `${label}: only the root hides #claim-title`).toBe(
        '#claim-overlay',
      );
      expect(hiddenAncestorOf(body), `${label}: only the root hides #claim-body`).toBe(
        '#claim-overlay',
      );
      view.show();
      expect(view.visible, `${label}: the section is visible`).toBe(true);
      expect(hiddenAncestorOf(title), `${label}: #claim-title on screen`).toBeNull();
      expect(hiddenAncestorOf(body), `${label}: #claim-body on screen`).toBeNull();
      expect(title?.textContent, `${label}: the title text`).toBe(vm.title);
      expect(body?.textContent, `${label}: the body text`).toBe(vm.body);
      expect((title?.textContent ?? '').length, `${label}: a title to read`).toBeGreaterThan(0);
      expect((body?.textContent ?? '').length, `${label}: a body to read`).toBeGreaterThan(0);
    }
  });

  it('UIF16B.1 the section is constructed under #frame-layer when present, else under #game-screen, else directly under <body>, carries mr-button-rows and NOT mr-frame / mr-shell, with all its controls inside it', () => {
    // INTENTIONAL CHANGE (uif-16b): was CTL8H-3-B3-ANCHOR, "... carries the classes mr-frame and
    // mr-shell". A section styled as a frame is a bordered absolute shell inside Profile's shell.
    // The construction anchor is unchanged (ProfileView re-parents the root into its frame).
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
      expect(overlay.classList.contains('mr-frame'), 'no class mr-frame').toBe(false);
      expect(overlay.classList.contains('mr-shell'), 'no class mr-shell').toBe(false);
      expect(overlay.classList.contains('mr-button-rows'), 'class mr-button-rows').toBe(true);
      for (const id of ['claim-title', 'claim-body', 'claim-signin-btn', 'claim-decline-btn']) {
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

  it('CTL8H-3-VIEW-ROW-OPS: the section walk covers the shown buttons in DOM order with focus as the cursor (hidden buttons skipped, clamped, no wrap), no row focused seats the default row (the first, or No when armed), activate clicks the focused button once and fires nothing when no row is focused', () => {
    // WRONG IMPL KILLED: rows that include a display:none button (focus() on it is a no-op: the
    // cursor sticks); a wrap; a move from nothing that lands on the second row; an activate that
    // fires the default row when nothing is focused (an armed reopen would CONFIRM the decline
    // on a stray A); an activate that clicks twice or clicks the wrong button; a default that is
    // the first row while armed (Confirm); and an op re-applied by shape instead of identity.
    const { view, handlers } = freshVisible(PROMPT_VM);

    // --- no row focused: the default row, for either direction ---------------------------------
    blurAll();
    walk(view, moveOp(1));
    expect(focusedId(), 'move +1 with nothing focused: the first row').toBe('claim-signin-btn');
    blurAll();
    walk(view, moveOp(-1));
    expect(focusedId(), 'move -1 with nothing focused: the first row').toBe('claim-signin-btn');

    // --- the walk: hidden join / confirm / cancel buttons are skipped, the ends clamp ---------
    const down: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      walk(view, moveOp(1));
      down.push(focusedId());
    }
    expect(down, 'down, then clamped on the last row').toEqual([
      'claim-decline-btn',
      'claim-decline-btn',
      'claim-decline-btn',
      'claim-decline-btn',
    ]);
    const up: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      walk(view, moveOp(-1));
      up.push(focusedId());
    }
    expect(up, 'up, then clamped on the first row').toEqual([
      'claim-signin-btn',
      'claim-signin-btn',
      'claim-signin-btn',
      'claim-signin-btn',
    ]);

    // --- activate clicks the focused button, once ----------------------------------------------
    walk(view, moveOp(1));
    expect(focusedId()).toBe('claim-decline-btn');
    walk(view, activateOp());
    expect(firedNames(handlers), 'A on Decline').toEqual(['onDeclineRequested']);
    expect(handlers.onDeclineRequested).toHaveBeenCalledTimes(1);

    // --- activate with no row focused: seat the default row, fire nothing ------------------------
    for (const name of Object.keys(handlers) as (keyof ClaimViewHandlers)[]) {
      vi.mocked(handlers[name]).mockClear();
    }
    blurAll();
    walk(view, activateOp());
    expect(focusedId(), 'A with no row focused seats the first row').toBe('claim-signin-btn');
    expect(firedNames(handlers), 'and fires nothing').toEqual([]);

    // --- armed: the default row is No, never Confirm ------------------------------------------
    view.render(ARMED_VM);
    blurAll();
    walk(view, moveOp(1));
    expect(focusedId(), 'armed, nothing focused: move seats No, not the first row').toBe(
      'claim-decline-cancel-btn',
    );
    blurAll();
    walk(view, activateOp());
    expect(focusedId(), 'armed, nothing focused: A seats No').toBe('claim-decline-cancel-btn');
    expect(firedNames(handlers), 'and neither confirms nor cancels').toEqual([]);
    walk(view, moveOp(-1));
    expect(focusedId(), 'up from No: Confirm').toBe('claim-decline-confirm-btn');
    walk(view, moveOp(1));
    walk(view, moveOp(1));
    expect(focusedId(), 'down past No: clamped on No, the last row').toBe(
      'claim-decline-cancel-btn',
    );

    // uif-16b: the identity-memo segment that stood here moved with `applyRowOp` to the frame:
    // ui/profileView.test.ts UIF16B.2 "a token is applied once".
  });

  it('CTL8H-3-ROWS: in every claim phase the rows the D-pad walks are exactly the shown buttons in DOM order', () => {
    // WRONG IMPL KILLED: a fixed row list (the armed phase swaps Decline for Confirm / Cancel; a
    // claimed account shows Join; a dead code shows Join, not Decline); rows that include a hidden
    // button; and rows derived from a stale vm instead of the DOM the last render painted.
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
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every phase case was walked').toBe(CLAIM_PHASES.length);
  });

  it("the Account section's rows are its claim actions only, with no privacy door", () => {
    // WRONG IMPL KILLED: the shipped section (a `#claim-privacy-btn` row always shown last, so the
    // Account column ends with a second way into Privacy that duplicates the Privacy section); the
    // button kept but hidden (it still exists in the DOM); the button removed from the rows but
    // left in the DOM; its `claim.privacyButton` label still resolved at render or show (a retired
    // key requested by a view that no longer has the button); a rows list that adds any element
    // that is not one of the five claim action buttons.
    const ACTION_IDS: Readonly<Record<keyof ClaimViewModel['actions'], string>> = {
      signIn: 'claim-signin-btn',
      join: 'claim-join-btn',
      decline: 'claim-decline-btn',
      declineConfirm: 'claim-decline-confirm-btn',
      declineCancel: 'claim-decline-cancel-btn',
    };
    const order = Object.keys(ACTION_IDS) as (keyof ClaimViewModel['actions'])[];
    vi.mocked(i18nT).mockClear();
    let checked = 0;
    for (const { label, state, rows } of CLAIM_PHASES) {
      const vm = buildClaimViewModel(state);
      const { view } = freshVisible(vm);
      const shownActions = order.filter((k) => vm.actions[k]).map((k) => ACTION_IDS[k]);
      expect(shownActions, `${label}: the table names the vm's shown actions`).toEqual(rows);
      expect(
        view.sectionRows().map((el) => el.id),
        `${label}: the rows are the shown claim action buttons, in DOM order, and nothing else`,
      ).toEqual(shownActions);
      expect(
        document.getElementById('claim-privacy-btn'),
        `${label}: no privacy door exists in the DOM`,
      ).toBeNull();
      const overlay = document.getElementById('claim-overlay') as HTMLElement;
      expect(
        [...overlay.querySelectorAll('button')].map((b) => b.id).sort(),
        `${label}: the section holds the five action buttons and no other`,
      ).toEqual(Object.values(ACTION_IDS).sort());
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every phase case was checked').toBe(CLAIM_PHASES.length);
    expect(
      vi.mocked(i18nT).mock.calls.map((c) => c[0]),
      'the retired privacy label is never requested',
    ).not.toContain('claim.privacyButton');
    expect(
      vi.mocked(i18nT).mock.calls.length,
      'ANTI-VACUITY: the spy saw the section resolve its labels',
    ).toBeGreaterThan(0);
  });

  it('CTL8H-3-DEFAULT-NO: when the overlay is already visible, arming focuses No (from a focused Decline, a focused Sign in or the page), disarming focuses the Decline button, a focused control the render hid goes to the default row, and a re-render with the same vm moves nothing; the open edge moves nothing; a re-shown armed overlay with focus on the page seats No on A and never confirms', () => {
    // WRONG IMPL KILLED: a default-No that only runs on the click edge (the arm edge is a render:
    // the Decline button is hidden under focus and focus falls to the page, where the next A /
    // Enter is a stray key); a Confirm that takes the focus (one Enter confirms a deletion of the
    // claim code); a re-seat on every render (the player's own move to Confirm is undone by the
    // next batch); a re-seat on the open edge (overlayA11y owns it, and a second focus owner
    // steals from the page); a disarm that leaves focus on a hidden button; and, for an overlay
    // hidden and shown again while still armed, an activate that fires Confirm for focus on <body>.
    const id = (x: string): HTMLButtonElement => document.getElementById(x) as HTMLButtonElement;

    // --- a render of a hidden section moves nothing (the frame's show() owns the anchor) ------
    sweepA11y();
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
    // --- the arm edge: from Sign in (also hidden by the render) -------------------------------
    {
      const { view } = freshVisible(PROMPT_VM);
      id('claim-signin-btn').focus();
      view.render(ARMED_VM);
      expect(focusedId(), 'armed with focus on Sign in: focus on No').toBe(
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
      id('claim-decline-btn').focus();
      view.render(PROMPT_VM);
      view.render(makeVm({ feedback: 'Something happened' }));
      expect(focusedId(), 'unarmed re-renders leave the focus where it is').toBe(
        'claim-decline-btn',
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
      // uif-16b (named fixture change): the section is hidden and re-shown through hide() /
      // show() (render no longer writes the display). Was: render({visible:false}), render(ARMED).
      const { view, handlers } = freshVisible(ARMED_VM);
      view.hide();
      expect(view.visible, 'precondition: the overlay is hidden').toBe(false);
      vi.mocked(handlers.onDismissed).mockClear();
      blurAll();
      view.render(ARMED_VM);
      view.show();
      expect(view.visible, 'shown again, still armed').toBe(true);
      expect(document.activeElement, 'precondition: focus is on the page').toBe(document.body);
      walk(view, activateOp());
      expect(focusedId(), 'A seats No').toBe('claim-decline-cancel-btn');
      expect(
        handlers.onDeclineConfirmed,
        'and does not confirm the decline',
      ).not.toHaveBeenCalled();
      expect(firedNames(handlers), 'it fired nothing at all').toEqual([]);
      walk(view, activateOp());
      expect(
        handlers.onDeclineCancelled,
        'the next A is the real press on No',
      ).toHaveBeenCalledTimes(1);
      expect(handlers.onDeclineConfirmed).not.toHaveBeenCalled();
    }
  });

  it('CTL8H-RT-CLAIM-NO-STEAL: a render of an open frame never moves focus that is on the page behind it (a sentinel outside the frame across the arm edge, the disarm edge, a render that hides a control and a plain re-render) nor focus on <body> (an unarmed or an armed same-vm re-render, a feedback-only re-render, a render that hides a control)', () => {
    // WRONG IMPL KILLED: a #reseat without its "focus outside the overlay -> return" guard (any
    // focused element that is not a row reads as "a control the render hid" and is yanked to the
    // default row, or to No / Decline on an edge: the page behind the modal loses the player's
    // focus on every claim event); <body> treated as a focused row (`active` passed to reseatRow
    // instead of null) or a reseatRow that no longer tells "the page" (null) from "a hidden
    // control" (the first row is seated on every plain re-render with focus on the page).
    const parked = (): HTMLButtonElement => {
      const sentinel = outsideSentinel();
      sentinel.focus();
      expect(document.activeElement, 'precondition: focus is on the page behind the frame').toBe(
        sentinel,
      );
      return sentinel;
    };
    const fresh = (vm: ClaimViewModel): ClaimView => {
      blurAll();
      return freshVisible(vm).view;
    };

    // --- a focused element OUTSIDE the frame ---------------------------------------------------
    let view = fresh(PROMPT_VM);
    let sentinel = parked();
    view.render(ARMED_VM);
    expect(document.activeElement, 'the arm edge leaves focus outside the frame alone').toBe(
      sentinel,
    );

    view = fresh(ARMED_VM);
    sentinel = parked();
    view.render(PROMPT_VM);
    expect(document.activeElement, 'the disarm edge leaves focus outside the frame alone').toBe(
      sentinel,
    );

    view = fresh(PROMPT_VM);
    sentinel = parked();
    view.render(CLAIMED_VM);
    expect(document.activeElement, 'a render that hides controls leaves outside focus alone').toBe(
      sentinel,
    );

    view = fresh(PROMPT_VM);
    sentinel = parked();
    view.render(PROMPT_VM);
    view.render(makeVm({ feedback: 'Something happened' }));
    expect(document.activeElement, 'a plain re-render leaves outside focus alone').toBe(sentinel);

    // --- focus on <body> ----------------------------------------------------------------------
    view = fresh(PROMPT_VM);
    expect(document.activeElement, 'precondition: focus is on the page').toBe(document.body);
    view.render(PROMPT_VM);
    expect(document.activeElement, 'an unarmed same-vm re-render seats no row').toBe(document.body);
    view.render(makeVm({ feedback: 'Something happened' }));
    expect(document.activeElement, 'a feedback-only re-render seats no row').toBe(document.body);

    view = fresh(ARMED_VM);
    expect(document.activeElement, 'precondition: focus is on the page').toBe(document.body);
    view.render(ARMED_VM);
    expect(document.activeElement, 'an armed same-vm re-render seats no row').toBe(document.body);
    view.render({ ...ARMED_VM, feedback: 'Something happened' });
    expect(document.activeElement, 'an armed feedback-only re-render seats no row').toBe(
      document.body,
    );

    view = fresh(CLAIMED_VM);
    expect(document.activeElement, 'precondition: focus is on the page').toBe(document.body);
    view.render(PROMPT_VM);
    expect(document.activeElement, 'a render that hides Join seats nothing for the page').toBe(
      document.body,
    );
  });

  it('CTL8H-RT-CLAIM-CONFIRM-SEATS-NOTHING: once the decline is CONFIRMED (the confirm row gone, Decline hidden, Join shown) the disarm-edge render seats no row, whether focus was on the hidden Confirm or on the page, and an A with no row focused then seats Join without pressing it', () => {
    // WRONG IMPL KILLED: a disarm that falls back to the last row or the first
    // row (Join: a second Enter would press it and re-enter the game the player just declined)
    // when the arming Decline is no longer a row; a disarm that seats the hidden Decline without
    // asking whether it is still a row; and an A that presses the row it seated.
    const armedState = stateAfter(OPENED, { kind: 'decline-requested' });
    const confirmedState = claimStep(armedState, {
      kind: 'decline-confirmed',
      hasLiveConnection: true,
    }).next;
    const promptVm = buildClaimViewModel(stateAfter(OPENED));
    const armedVm = buildClaimViewModel(armedState);
    const confirmedVm = buildClaimViewModel(confirmedState);
    expect(armedVm.actions.declineCancel, 'ANTI-VACUITY: the model armed the confirm').toBe(true);
    expect(confirmedVm.visible, 'ANTI-VACUITY: the frame stays open after a confirm').toBe(true);
    expect(
      confirmedVm.actions,
      'ANTI-VACUITY: confirm row gone, Decline hidden, Join shown',
    ).toEqual({
      signIn: false,
      join: true,
      decline: false,
      declineConfirm: false,
      declineCancel: false,
    });

    for (const where of ['on the hidden Confirm', 'on the page'] as const) {
      blurAll();
      const { view, handlers } = freshVisible(promptVm);
      view.render(armedVm);
      expect(focusedId(), `${where}: precondition: arming seated No`).toBe(
        'claim-decline-cancel-btn',
      );
      if (where === 'on the hidden Confirm') {
        (document.getElementById('claim-decline-confirm-btn') as HTMLElement).focus();
        expect(focusedId(), `${where}: precondition`).toBe('claim-decline-confirm-btn');
      } else {
        blurAll();
        expect(document.activeElement, `${where}: precondition`).toBe(document.body);
      }

      view.render(confirmedVm);
      expect(focusedId(), `${where}: the disarm edge does not seat Join`).not.toBe(
        'claim-join-btn',
      );
      expect(focusedId(), `${where}: nor the hidden Decline`).not.toBe('claim-decline-btn');
      if (where === 'on the page') {
        expect(document.activeElement, `${where}: focus is still on the page`).toBe(document.body);
      }

      blurAll();
      walk(view, activateOp());
      expect(focusedId(), `${where}: A with no row focused seats the first row, Join`).toBe(
        'claim-join-btn',
      );
      expect(handlers.onJoin, `${where}: and does not press it`).not.toHaveBeenCalled();
      expect(firedNames(handlers), `${where}: it fired nothing at all`).toEqual([]);
    }
  });
});

// ===========================================================================================
// qf-13 (QF13.1, QF13.2): the Account frame's title bar and its column layout.
//
// QF13.1 EARS: THE Account frame SHALL render a visible frame title. It is frame chrome (ui/frame.ts
// createFrame's convention): a `div.mr-frame-titlebar` as #claim-overlay's FIRST element child,
// holding a `div.mr-frame-title#claim-frame-title` that reads t('menu.profile.account.title'),
// resolved in BOTH open doors (render and show) on every call (the i18n half is in
// claimView.i18n.test.ts). The existing #claim-title <h2> is the per-phase heading (vm.title) and
// stays, after the bar. The title is chrome: not focusable, no role, never a row.
//
// QF13.2 EARS: THE Account frame's buttons SHALL be laid out as a column. The view writes the
// overlay's inline display ('block'), so `.mr-frame`'s flex column never applies and the native
// buttons flow inline; the computed style is what is asserted, not a selector spelling.
// ===========================================================================================

const QF13_STYLES_CSS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
  'utf8',
);

/** The English catalogue value of the Account frame's title (a plain string entry). */
function qf13EnglishAccountTitle(): string {
  const entry = CATALOG_EN['menu.profile.account.title'];
  if (typeof entry !== 'string') {
    throw new Error('menu.profile.account.title must be a plain message');
  }
  return entry;
}

/** A brand new DOM and view, NOT rendered (the overlay is hidden and unwritten afterwards). */
function qf13Fresh(): { view: ClaimView; overlay: HTMLElement; handlers: ClaimViewHandlers } {
  sweepA11y();
  document.body.replaceChildren();
  const handlers = makeHandlers();
  const view = new ClaimView(handlers);
  return { view, overlay: document.getElementById('claim-overlay') as HTMLElement, handlers };
}

/** A computed style that PAINTS: nothing here makes the element invisible by a route other than
 *  display / visibility (opacity, a zero font size, a transparent colour, taking it out of flow,
 *  a clip, a zero box, an off-screen text indent or a collapsing transform). Called on the bar AND
 *  the title; a property happy-dom does not compute reads '' and passes, so each check is a
 *  denylist of the exact cheat value. */
function qf13ExpectPainted(style: CSSStyleDeclaration, label: string): void {
  expect(['', '1'], `${label}: opacity`).toContain(style.getPropertyValue('opacity'));
  expect(['0', '0px', '0em', '0rem', '0%'], `${label}: font-size`).not.toContain(style.fontSize);
  expect(['transparent', 'rgba(0, 0, 0, 0)'], `${label}: colour`).not.toContain(style.color);
  expect(['absolute', 'fixed'], `${label}: out of flow`).not.toContain(style.position);
  expect(['', 'none'], `${label}: float`).toContain(style.getPropertyValue('float'));
  expect(['', 'none'], `${label}: clip-path`).toContain(style.getPropertyValue('clip-path'));
  expect(['', 'none'], `${label}: transform`).toContain(style.getPropertyValue('transform'));
  expect(style.getPropertyValue('text-indent').startsWith('-'), `${label}: text-indent`).toBe(
    false,
  );
  for (const prop of ['height', 'max-height', 'width', 'max-width', 'line-height']) {
    expect(
      ['0', '0px', '0em', '0rem', '0%'],
      `${label}: ${prop} is not collapsed to zero`,
    ).not.toContain(style.getPropertyValue(prop));
  }
  expect(style.visibility, `${label}: visibility`).not.toBe('hidden');
  expect(style.display, `${label}: display`).not.toBe('none');
}

/** The structural contract of the Account section header, asserted on the section as it stands.
 *  Returns the header node.
 *  INTENTIONAL CHANGE (uif-16b, UIF16B.1): was the frame title bar contract (a
 *  `div.mr-frame-titlebar` first child holding `div.mr-frame-title#claim-frame-title`). The
 *  section leads with `h2.mr-section-header#claim-frame-title`, same key; no title bar at all. */
function qf13AssertAccountBar(label: string, overlay: HTMLElement): HTMLElement {
  expect(overlay.querySelector('.mr-frame-titlebar'), `${label}: no frame title bar`).toBeNull();
  expect(overlay.querySelector('.mr-frame-title'), `${label}: no frame title`).toBeNull();
  const titles = overlay.querySelectorAll('#claim-frame-title');
  expect(titles.length, `${label}: exactly one #claim-frame-title in the overlay`).toBe(1);
  expect(
    document.querySelectorAll('[id="claim-frame-title"]').length,
    `${label}: and one in the document`,
  ).toBe(1);
  const title = titles[0] as HTMLElement;
  const bar = title;
  expect(overlay.firstElementChild, `${label}: the header leads the section`).toBe(title);
  expect(title.tagName, `${label}: the header is an h2`).toBe('H2');
  expect(
    [...title.classList],
    `${label}: the header carries exactly the section-header class`,
  ).toEqual(['mr-section-header']);
  expect(title.hasAttribute('tabindex'), `${label}: the title is not focusable`).toBe(false);
  expect(title.hasAttribute('role'), `${label}: the title carries no role`).toBe(false);
  expect(bar?.hasAttribute('tabindex'), `${label}: the titlebar is not focusable`).toBe(false);
  expect(title.closest('button'), `${label}: the title is not inside a button`).toBeNull();
  // Visible to assistive tech too: neither node is aria-hidden or inert.
  for (const [what, node] of [
    ['titlebar', bar],
    ['title', title],
  ] as const) {
    expect(node?.getAttribute('aria-hidden'), `${label}: ${what} has no aria-hidden`).toBeNull();
    expect(node?.hasAttribute('inert'), `${label}: ${what} is not inert`).toBe(false);
  }
  for (let node: HTMLElement | null = title; node !== null; node = node.parentElement) {
    const where = node === title ? '#claim-frame-title' : node.id || node.tagName;
    expect(node.hidden, `${label}: ${where} is not [hidden]`).toBe(false);
    expect(node.hasAttribute('hidden'), `${label}: ${where} has no hidden attribute`).toBe(false);
    if (node === overlay) break;
  }
  expect(hiddenAncestorOf(title), `${label}: the title is on screen all the way up`).toBeNull();
  return title;
}

describe('qf-13 (QF13.1): the Account frame title', () => {
  it('UIF16B.1 in every visible claim phase, a paint gives the single h2.mr-section-header#claim-frame-title as the first child reading the catalogue Account title (independent of vm.title), on screen, not a row, with #claim-title still showing vm.title AFTER it; show() alone does the same; no second view duplicates it', () => {
    // INTENTIONAL CHANGE (uif-16b): was [QF13-1-ACCOUNT-TITLE] over the frame title bar; the
    // contract helper above carries the change. "A render alone" became render + show
    // (freshVisible): render no longer shows the section.
    // WRONG IMPL KILLED: no title (today); a title appended AFTER #claim-title or the buttons (the
    // bar must lead the overlay); the per-phase heading #claim-title reused or overwritten as the
    // frame title (it must keep vm.title); a title that is the vm's text; bare element/classes or a
    // wrong id; hard-coded English instead of the catalogue value; a title left display:none
    // (ensureElement's default) in some phase or in one door; a tabindex/role on the title; a
    // write in only ONE door; a constructor that adds a bar per view; and a title that joins the
    // rows (the D-pad walk would land on it).
    const expected = qf13EnglishAccountTitle();
    expect(expected.length, 'ANTI-VACUITY: the catalogue has an Account title').toBeGreaterThan(0);
    expect(
      new Set(CLAIM_PHASES.map((c) => buildClaimViewModel(c.state).title)).size,
      'ANTI-VACUITY: the phases carry several distinct vm.title values',
    ).toBeGreaterThanOrEqual(3);

    let checked = 0;
    for (const { label, state, rows } of CLAIM_PHASES) {
      // --- the render door alone ---------------------------------------------------------------
      const vm = buildClaimViewModel(state);
      const { view } = freshVisible(vm);
      const overlay = document.getElementById('claim-overlay') as HTMLElement;
      const title = qf13AssertAccountBar(`${label} / render`, overlay);
      expect(title.textContent, `${label} / render: the catalogue Account title`).toBe(expected);

      const heading = document.getElementById('claim-title') as HTMLElement;
      expect(heading.textContent, `${label}: #claim-title still shows vm.title`).toBe(vm.title);
      expect(heading.tagName, `${label}: #claim-title is still the h2`).toBe('H2');
      expect(title.textContent, `${label}: the frame title is not the per-phase heading`).not.toBe(
        heading.textContent,
      );
      const bar = overlay.firstElementChild as HTMLElement;
      expect(
        bar.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${label}: #claim-title follows the titlebar in DOM order`,
      ).toBeTruthy();
      expect(
        [...overlay.querySelectorAll('button')]
          .filter((b) => hiddenAncestorOf(b) === null)
          .map((b) => b.id),
        `${label}: the shown buttons are unchanged`,
      ).toEqual(rows);
      expect(
        walkRows(view),
        `${label}: the D-pad rows are unchanged, the title is not one`,
      ).toEqual(rows);
      expect(document.activeElement, `${label}: the walk never lands on the title`).not.toBe(title);

      // --- no duplication by a second view over the same DOM -------------------------------------
      const again = new ClaimView(makeHandlers());
      again.render(vm);
      expect(
        overlay.querySelectorAll('.mr-section-header').length,
        `${label}: still one section header after a second view`,
      ).toBe(1);
      expect(overlay.firstElementChild, `${label}: the same bar still leads`).toBe(bar);
      expect(
        document.getElementById('claim-frame-title'),
        `${label}: and the same title node`,
      ).toBe(title);

      // --- the show door alone (a brand new DOM, no render at all) -------------------------------
      const shown = qf13Fresh();
      shown.view.show();
      const shownTitle = qf13AssertAccountBar(`${label} / show`, shown.overlay);
      expect(shownTitle.textContent, `${label} / show: the catalogue Account title`).toBe(expected);
      // The production sequence (openClaim): render -> show -> render keeps the same single title.
      shown.view.render(vm);
      shown.view.show();
      const afterAll = qf13AssertAccountBar(`${label} / render-show-render`, shown.overlay);
      expect(afterAll, `${label}: the title node survives every door`).toBe(shownTitle);
      expect(afterAll.textContent).toBe(expected);
      expect(
        (document.getElementById('claim-title') as HTMLElement).textContent,
        `${label}: #claim-title shows vm.title after the full sequence`,
      ).toBe(vm.title);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every phase case was walked').toBe(CLAIM_PHASES.length);
  });

  describe('with the real styles.css', () => {
    let sheet: HTMLStyleElement | null = null;
    beforeEach(() => {
      sheet = document.createElement('style');
      sheet.textContent = QF13_STYLES_CSS;
      document.head.appendChild(sheet);
    });
    afterEach(() => {
      sheet?.remove();
      sheet = null;
    });

    it('UIF16B.1 the shown Account section header paints from the stylesheet and not from inline style, and the section is not an absolute frame shell, in the prompt and the armed-decline phases', () => {
      // INTENTIONAL CHANGE (uif-16b): was [QF13-1-ACCOUNT-TITLE-COMPUTED] (the title bar a flex row
      // with a bottom border, the title bold). The header is the type scale's section level.
      // WRONG IMPL KILLED: a header hidden by the sheet; an inline style standing in for the class;
      // a section still classed mr-shell (an absolutely placed box inside Profile's box).
      // happy-dom caches computed style per element: each is read once, from a fresh DOM.
      for (const [label, vm] of [
        ['prompt', PROMPT_VM],
        ['armed', ARMED_VM],
      ] as const) {
        freshVisible(vm);
        const overlay = document.getElementById('claim-overlay') as HTMLElement;
        const title = document.getElementById('claim-frame-title') as HTMLElement | null;
        expect(title, `${label}: the header exists`).not.toBeNull();
        if (title === null) continue;
        expect(title.style.cssText, `${label}: the header carries no inline style`).toBe('');
        const titleStyle = getComputedStyle(title);
        expect(titleStyle.display, `${label}: the header is displayed`).not.toBe('none');
        expect(titleStyle.visibility, `${label}: the header is visible`).not.toBe('hidden');
        qf13ExpectPainted(titleStyle, `${label}: header`);
        expect(getComputedStyle(overlay).position, `${label}: not an absolute shell`).not.toBe(
          'absolute',
        );
      }
    });

    it('in the sign-in prompt and the armed-decline phase every SHOWN button under #claim-overlay computes a block-level outer display (or the overlay is a flex column), while the hidden actions still compute none [QF13-2-COLUMN-COMPUTED]', () => {
      // WRONG IMPL KILLED: the shipped sheet (the view's inline `display: block` on the overlay
      // beats `.mr-frame`'s flex, so the native buttons compute inline-block and flow in a row); a
      // rule keyed to a selector the buttons do not match; `display: inline-block` / `inline`; a
      // rule that also un-hides the hidden actions (an `!important` display, or one that targets
      // every button whatever its inline state). happy-dom caches computed style per element: the
      // overlay and each button are read once, from a brand new DOM per phase.
      const ALL_BUTTONS = [
        'claim-signin-btn',
        'claim-join-btn',
        'claim-decline-btn',
        'claim-decline-confirm-btn',
        'claim-decline-cancel-btn',
      ];
      const cases: ReadonlyArray<{
        label: string;
        vm: ClaimViewModel;
        shown: readonly string[];
        hidden: readonly string[];
      }> = [
        {
          label: 'sign-in prompt',
          vm: PROMPT_VM,
          shown: ['claim-signin-btn', 'claim-decline-btn'],
          hidden: ['claim-join-btn', 'claim-decline-confirm-btn', 'claim-decline-cancel-btn'],
        },
        {
          label: 'armed decline',
          vm: ARMED_VM,
          shown: ['claim-decline-confirm-btn', 'claim-decline-cancel-btn'],
          hidden: ['claim-signin-btn', 'claim-join-btn', 'claim-decline-btn'],
        },
        // EVERY visible claim phase (a rule or class that applies in some phases only fails here).
        ...CLAIM_PHASES.map(({ label, state, rows }) => ({
          label: `phase: ${label}`,
          vm: buildClaimViewModel(state),
          shown: rows,
          hidden: ALL_BUTTONS.filter((id) => !rows.includes(id)),
        })),
      ];
      expect(cases.length, 'ANTI-VACUITY: the two named cases plus every phase').toBe(
        2 + CLAIM_PHASES.length,
      );
      for (const { label, vm, shown, hidden } of cases) {
        freshVisible(vm);
        const overlay = document.getElementById('claim-overlay') as HTMLElement;
        const overlayStyle = getComputedStyle(overlay);
        // uif-16b (named change): the section is no longer `.mr-frame`, so the old anti-vacuity
        // ("the sheet reaches the overlay: .mr-frame is a column") is gone with the class; the
        // sheet's reach is proved by the per-button `display: block` below (`.mr-button-rows`).
        expect(
          overlay.classList.contains('mr-button-rows'),
          `${label}: ANTI-VACUITY: the section carries the column class`,
        ).toBe(true);
        const buttons = [...overlay.querySelectorAll('button')];
        expect(
          buttons.filter((b) => b.style.display !== 'none').map((b) => b.id),
          `${label}: ANTI-VACUITY: the phase shows exactly the expected buttons`,
        ).toEqual(shown);

        // ANTI-VACUITY: the view writes the overlay's inline display 'block' (so the overlay is NOT
        // itself a flex column here), which is why the buttons need a rule of their own. With the
        // overlay block, the per-button check below always runs.
        expect(overlayStyle.display, `${label}: the overlay computes block`).toBe('block');
        for (const id of shown) {
          const style = getComputedStyle(document.getElementById(id) as HTMLElement);
          expect(style.display, `${label}: #${id} stacks as a block`).toBe('block');
          expect(['', 'none'], `${label}: #${id} float`).toContain(style.getPropertyValue('float'));
          expect(['absolute', 'fixed'], `${label}: #${id} stays in flow`).not.toContain(
            style.position,
          );
        }
        for (const id of hidden) {
          const el = document.getElementById(id) as HTMLElement;
          expect(getComputedStyle(el).display, `${label}: hidden #${id} stays none`).toBe('none');
        }
      }

      // The class that stacks the buttons is on from construction: after a render a shown button
      // stacks as a block under the overlay's class, whatever order show() and render ran in.
      const opened = qf13Fresh();
      opened.view.show();
      opened.view.render(PROMPT_VM);
      const signIn = document.getElementById('claim-signin-btn') as HTMLElement;
      expect(
        getComputedStyle(signIn).display,
        'show() then render: the Sign in button stacks as a block',
      ).toBe('block');

      // The rule must not leak: buttons outside the Account overlay keep the UA default.
      freshVisible(PROMPT_VM);
      const plain = document.createElement('button');
      const framedShell = document.createElement('div');
      framedShell.className = 'mr-frame mr-shell';
      const inShell = document.createElement('button');
      framedShell.appendChild(inShell);
      const framed = document.createElement('div');
      framed.className = 'mr-frame';
      const inFrame = document.createElement('button');
      framed.appendChild(inFrame);
      document.body.append(plain, framedShell, framed);
      expect(
        getComputedStyle(document.getElementById('claim-signin-btn') as HTMLElement).display,
        'ANTI-VACUITY: in the same document the claim button does stack',
      ).toBe('block');
      for (const [what, el] of [
        ['a plain button on the body', plain],
        ['a button in a .mr-frame.mr-shell that is not the claim overlay', inShell],
        ['a button in a .mr-frame that is not the claim overlay', inFrame],
      ] as const) {
        expect(getComputedStyle(el).display, `${what} keeps the UA default`).not.toBe('block');
      }
    });

    it('claimView.ts writes no markup from strings: no innerHTML, insertAdjacentHTML or outerHTML in its comment-stripped source', () => {
      // WRONG IMPL KILLED: a title or label written through an HTML sink (the vm strings are model
      // copy and the catalogue is translator-supplied: textContent only, the discipline of
      // renameView's RT-RN-07). Comments are stripped first so the header prose does not trip it.
      const src = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'claimView.ts'),
        'utf8',
      );
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
      expect(
        code.includes('textContent') && code.includes('class ClaimView'),
        'ANTI-VACUITY: the stripped source still holds the view',
      ).toBe(true);
      for (const sink of ['innerHTML', 'insertAdjacentHTML', 'outerHTML']) {
        expect(code.includes(sink), `claimView.ts must not use ${sink}`).toBe(false);
      }
    });

    // uif-1 (named intentional change, UIF1.4): the title block was "font-weight only"; the type
    // scale rewrites it. The new contract is EXACTLY font-size, font-weight and line-height, each
    // pinned to its exact token value, so `.mr-frame-title { font-size: 0 }` (a literal that would
    // hide the chrome) still reds: the old pin killed it by prop roster alone, this kills it by value.
    it('styles.css: the only rules whose selector mentions mr-frame-title are exactly one .mr-frame-titlebar block and one .mr-frame-title block, and the title block declares exactly font-size, font-weight and line-height, each set to its type-scale token', () => {
      // WRONG IMPL KILLED: a class-keyed hide of the chrome added to the sheet (for example
      // `.mr-button-rows > .mr-frame-titlebar { opacity: 0 }` or `.mr-frame-title { font-size: 0 }`
      // appended as a second block, in a @media block, or in a compound selector): the computed
      // probes read one DOM, this reads the whole sheet. Compared by selector EQUALITY, not by
      // substring; comments are stripped first so a decoy in a comment neither hides nor plants one.
      // uif-1 adds: the one title block with a literal (`font-size: 0`, `20px`) or a wrong token.
      const stripped = QF13_STYLES_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
      const blocks: Array<{
        selectors: string[];
        props: string[];
        decls: Array<[string, string]>;
      }> = [];
      for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const head = (m[1] ?? '').split(';').pop() ?? '';
        const decls: Array<[string, string]> = (m[2] ?? '')
          .split(';')
          .filter((d) => d.includes(':'))
          .map((d): [string, string] => [
            d.slice(0, d.indexOf(':')).trim().toLowerCase(),
            d
              .slice(d.indexOf(':') + 1)
              .trim()
              .replace(/\s+/g, ' '),
          ])
          .filter(([p]) => p !== '');
        blocks.push({
          selectors: head.split(',').map((s) => s.trim()),
          props: decls.map(([p]) => p),
          decls,
        });
      }
      expect(
        blocks.some((b) => b.selectors.includes('.sr-only')),
        'ANTI-VACUITY: the scan sees the existing .sr-only rule',
      ).toBe(true);
      const mentioning = blocks.filter((b) =>
        b.selectors.some((s) => s.includes('mr-frame-title')),
      );
      expect(
        mentioning.map((b) => b.selectors.join(', ')).sort(),
        'every selector list that names the chrome, with multiplicity',
      ).toEqual(['.mr-frame-title', '.mr-frame-titlebar']);
      const title = mentioning.find((b) => b.selectors.join(', ') === '.mr-frame-title');
      expect(
        title?.props,
        'ANTI-VACUITY: the title block was found and declares something',
      ).not.toEqual([]);
      expect(
        [...(title?.decls ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        'the title rule declares exactly font-size, font-weight and line-height, each its token',
      ).toEqual([
        ['font-size', 'var(--mr-font-title)'],
        ['font-weight', 'var(--mr-font-title-weight)'],
        ['line-height', 'var(--mr-font-title-line)'],
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// uif-16a (UIF16A.1, UIF16A.2): the claim view as a RowSection, walked through the interface.
// ---------------------------------------------------------------------------

describe('ClaimView uif-16a: the shared section interface', () => {
  const ACTIONS_NONE = {
    signIn: false,
    join: false,
    decline: false,
    declineConfirm: false,
    declineCancel: false,
  };
  const PROMPT16 = makeVm(); // signIn + decline
  const JOIN16 = makeVm({ actions: { ...ACTIONS_NONE, join: true, decline: true } });
  const ARMED16 = makeVm({
    confirmPrompt: 'Really decline?',
    actions: { ...ACTIONS_NONE, declineConfirm: true, declineCancel: true },
  });
  const move16 = (delta: -1 | 1): RowOp => ({ kind: 'move', delta });
  const activate16 = (): RowOp => ({ kind: 'activate' });
  const focusedId16 = (): string => (document.activeElement as HTMLElement | null)?.id ?? '';
  const blur16 = (): void => (document.activeElement as HTMLElement | null)?.blur();
  const ids16 = (els: readonly HTMLElement[]): string[] => els.map((e) => e.id);
  const byId16 = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
  const open16 = (vm: ClaimViewModel): { view: ClaimView; handlers: ClaimViewHandlers } => {
    const handlers = makeHandlers();
    const view = new ClaimView(handlers);
    view.render(vm);
    // uif-16b (named fixture change): render no longer shows the section; show() does.
    view.show();
    return { view, handlers };
  };
  const override16 = (view: ClaimView, patch: Partial<RowSection>): void => {
    Object.assign(view as unknown as object, patch);
  };

  it('UIF16A.1 sectionRoot is the identical #claim-overlay element and the view is assignable to RowSection', () => {
    const view = new ClaimView(makeHandlers());
    const section: RowSection = view;
    expect(section.sectionRoot).toBe(document.getElementById('claim-overlay'));
  });

  it('UIF16A.1 sectionRows is the shown buttons in DOM order, per phase', () => {
    const { view: prompt } = open16(PROMPT16);
    expect(ids16(prompt.sectionRows()), 'sign-in prompt').toEqual([
      'claim-signin-btn',
      'claim-decline-btn',
    ]);
    prompt.render(ARMED16);
    expect(ids16(prompt.sectionRows()), 'armed decline').toEqual([
      'claim-decline-confirm-btn',
      'claim-decline-cancel-btn',
    ]);
    prompt.render(JOIN16);
    expect(ids16(prompt.sectionRows()), 'a different action set').toEqual([
      'claim-join-btn',
      'claim-decline-btn',
    ]);
  });

  it('UIF16A.1 a disabled shown button is not a row', () => {
    const { view } = open16(PROMPT16);
    (byId16('claim-decline-btn') as HTMLButtonElement).disabled = true;
    expect(ids16(view.sectionRows())).toEqual(['claim-signin-btn']);
  });

  it('UIF16A.1 defaultRow is No while the decline is armed, else the first row', () => {
    const { view } = open16(PROMPT16);
    expect(view.defaultRow(), 'unarmed prompt: the first row').toBe(byId16('claim-signin-btn'));
    view.render(ARMED16);
    expect(view.defaultRow(), 'armed: No').toBe(byId16('claim-decline-cancel-btn'));
    view.render(JOIN16);
    expect(view.defaultRow(), 'another unarmed phase: its first row').toBe(
      byId16('claim-join-btn'),
    );
  });

  // uif-16b (named change): the UIF16A.2 tests below drove `view.applyRowOp`, which retires; they
  // now drive the `walk` helper (walkSection over this RowSection, the frame's rule). The
  // frame-level walk is gated in ui/profileView.test.ts UIF16B.2.
  it('UIF16A.2 the section walk seats defaultRow() when no row is focused: an overridden default wins', () => {
    const { view, handlers } = open16(PROMPT16);
    override16(view, { defaultRow: () => byId16('claim-decline-btn') });
    blur16();
    walk(view, move16(1));
    expect(focusedId16(), 'the override, not a private No / first-row fallback').toBe(
      'claim-decline-btn',
    );
    blur16();
    walk(view, activate16());
    expect(focusedId16()).toBe('claim-decline-btn');
    expect(handlers.onDeclineRequested, 'seating presses nothing').not.toHaveBeenCalled();
  });

  it('UIF16A.2 the section walk follows the rows sectionRows() returns: an overridden list sets the order, the clamp and what A presses', () => {
    const { view, handlers } = open16(PROMPT16);
    // Real rows: [signin, decline]. Override: decline first, signin last.
    override16(view, {
      sectionRows: () => [byId16('claim-decline-btn'), byId16('claim-signin-btn')],
    });
    byId16('claim-decline-btn').focus();
    walk(view, move16(1));
    expect(focusedId16(), 'down from the first overridden row').toBe('claim-signin-btn');
    walk(view, move16(1));
    expect(focusedId16(), 'clamped at the last overridden row, no wrap').toBe('claim-signin-btn');
    walk(view, activate16());
    expect(handlers.onSignIn, 'A presses the focused overridden row once').toHaveBeenCalledTimes(1);

    // A real row the interface does not list is not a row: no press, the default is seated.
    override16(view, { sectionRows: () => [byId16('claim-signin-btn')] });
    byId16('claim-decline-btn').focus();
    walk(view, activate16());
    expect(
      handlers.onDeclineRequested,
      'A on an unlisted control presses nothing',
    ).not.toHaveBeenCalled();
  });

  it('UIF16A.2 through the real interface: focus on the page seats No while armed and presses nothing; the clamp holds at both ends', () => {
    const { view, handlers } = open16(PROMPT16);
    view.render(ARMED16);
    blur16();
    walk(view, activate16());
    expect(focusedId16(), 'armed, nothing focused: A seats No').toBe('claim-decline-cancel-btn');
    expect(handlers.onDeclineConfirmed, 'and confirms nothing').not.toHaveBeenCalled();
    expect(handlers.onDeclineCancelled, 'and does not press No either').not.toHaveBeenCalled();

    byId16('claim-decline-cancel-btn').focus();
    walk(view, move16(1));
    expect(focusedId16(), 'no wrap past the last row').toBe('claim-decline-cancel-btn');
    byId16('claim-decline-confirm-btn').focus();
    walk(view, move16(-1));
    expect(focusedId16(), 'no wrap past the first row').toBe('claim-decline-confirm-btn');
  });

  it('UIF16A.2 the render-time reseat reads sectionRows(): a focused control the interface does not list is moved to its first row on a plain re-render', () => {
    const { view } = open16(PROMPT16);
    byId16('claim-decline-btn').focus();
    view.render(PROMPT16);
    expect(
      focusedId16(),
      'precondition: the real rows keep Decline, so a plain re-render moves nothing',
    ).toBe('claim-decline-btn');
    override16(view, {
      sectionRows: () => [byId16('claim-signin-btn')],
    });
    view.render(PROMPT16);
    expect(focusedId16(), 'the render hid nothing, but the interface does not list Decline').toBe(
      'claim-signin-btn',
    );
  });

  it('UIF16B.4 armed is public and true exactly while the decline confirm is armed, across real phases', () => {
    // WRONG IMPL KILLED: `armed` left private (ProfileView.defaultRow cannot prefer No); an
    // `armed` that reads the Decline button (true in the plain prompt); one that is stuck after a
    // disarm.
    const { view } = open16(PROMPT16);
    let armedSeen = 0;
    for (const { label, state } of CLAIM_PHASES) {
      const vm = buildClaimViewModel(state);
      view.render(vm);
      expect(view.armed, label).toBe(vm.actions.declineCancel);
      if (view.armed) armedSeen += 1;
    }
    expect(armedSeen, 'ANTI-VACUITY: the armed phase was reached').toBe(1);
    view.render(PROMPT16);
    expect(view.armed, 'disarmed again').toBe(false);
  });

  it('UIF16B.2 the section no longer walks itself: it has no applyRowOp', () => {
    // WRONG IMPL KILLED: a section that keeps `applyRowOp` + `#lastOp` (a second identity memo
    // over the frame's token, or a section-scoped walk clamping at the section edge).
    const view = new ClaimView(makeHandlers());
    expect('applyRowOp' in view, 'no section-level applyRowOp').toBe(false);
  });
});
