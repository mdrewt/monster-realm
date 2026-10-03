// @vitest-environment happy-dom
//
// ui/sessionView.test.ts — ctl-8k (CTL8K.1): the session gate as an in-frame system modal.
//
// SOURCE OF TRUTH: CTL8K.1 — "WHEN the session gate is shown in any state, THE SYSTEM SHALL render,
// inside `#game-screen`, a visible title, a visible body and labelled action buttons from the
// catalog, with Retry as the default action. 'Continue as guest' asks for confirmation, defaulting
// to No. B and Start are inert, and the frame says so." Plan: memory/projects/monster-realm-ctl-8k-plan.md
// (REV 2 overrides REV 1).
//
// ★ WHY EVERY CONTROL ASSERTION WALKS THE ANCESTOR CHAIN FIRST. The pre-ctl-8k shell built every
// node with `ensureElement` (display:none) and never un-hid its title, body or buttons, so a
// programmatic `.click()` fired a handler while a human saw nothing. A click-only suite certifies
// that invisible surface as reachable. The walk (`hiddenReason`) fails on inline display:none, the
// `hidden` attribute, visibility:hidden, aria-hidden=true and `inert`, on the node AND every ancestor.
//
// ★ TWO KINDS OF VIEW MODEL. Real ones (`buildSessionViewModel(sessionStep(...))`) prove the view
// paints what the model projects; hand-built ones (`vmOf`) carry DISTINCT sentinel strings per field
// so a swapped wiring (Retry painted with the Continue label, Yes and No transposed) cannot pass.
//
// ★ FOCUS ORACLE. `HTMLElement.prototype.focus` is wrapped for the whole file: each call records its
// target and whether the target (or an ancestor) was hidden AT CALL TIME. A browser silently refuses
// to focus a display:none node, so a focus() ahead of the display write is a no-op there that
// happy-dom would not show.
//
// No regex literal, no `new RegExp(...)`, no innerHTML: DOM reads are textContent only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownership } from '../input/router';
import { CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR } from './i18n/catalog.fr';
import { setLocale } from './i18n/resolver';
import {
  buildSessionViewModel,
  SESSION_INITIAL,
  type SessionModelState,
  type SessionViewModel,
  sessionStep,
} from './sessionModel';
import { SessionView, type SessionViewHandlers } from './sessionView';

const EN = CATALOG_EN as unknown as Record<string, string>;
const FR = CATALOG_FR as unknown as Record<string, string>;

// ---------------------------------------------------------------------------
// The DOM contract, spelled once.
// ---------------------------------------------------------------------------

const ROOT_ID = 'session-overlay';
const TITLE_ID = 'session-title';
const BODY_ID = 'session-body';
const FEEDBACK_ID = 'session-feedback';
const CONFIRM_ID = 'session-confirm';
const RETRY_ID = 'session-retry-btn';
const CONTINUE_ID = 'session-continue-btn';
const YES_ID = 'session-continue-confirm-btn';
const NO_ID = 'session-continue-cancel-btn';
const HINT_ID = 'session-hint';

/** The root's children, in tab and reading order. */
const CHILD_IDS: readonly string[] = [
  TITLE_ID,
  BODY_ID,
  FEEDBACK_ID,
  CONFIRM_ID,
  RETRY_ID,
  CONTINUE_ID,
  YES_ID,
  NO_ID,
  HINT_ID,
];
const BUTTON_IDS: readonly string[] = [RETRY_ID, CONTINUE_ID, YES_ID, NO_ID];

// ---------------------------------------------------------------------------
// Real model states, reached by RUNNING the reducer (never hand-written).
// ---------------------------------------------------------------------------

const EXPIRED: SessionModelState = sessionStep(SESSION_INITIAL, { kind: 'session-expired' }).next;
const UNREACHABLE: SessionModelState = sessionStep(SESSION_INITIAL, {
  kind: 'auth-service-unreachable',
}).next;
const arm = (state: SessionModelState): SessionModelState =>
  sessionStep(state, { kind: 'continue-anonymously-requested' }).next;
/** The confirm click that found no live connection: still armed, now carrying the disconnected line. */
const armedWithFeedback = (state: SessionModelState): SessionModelState =>
  sessionStep(arm(state), { kind: 'continue-anonymously-confirmed', hasLiveConnection: false })
    .next;
const withFeedback = (state: SessionModelState): SessionModelState =>
  sessionStep(state, { kind: 'retry-requested', hasLiveConnection: false }).next;

/** A hand-built view model: every label a DISTINCT sentinel, so a swapped wiring fails. */
function vmOf(overrides: Partial<SessionViewModel> = {}): SessionViewModel {
  return {
    visible: true,
    title: 'SENT TITLE',
    body: 'SENT BODY',
    primaryActionLabel: 'SENT CONTINUE',
    confirmPrompt: undefined,
    feedback: undefined,
    retryLabel: 'SENT RETRY',
    confirmYesLabel: 'SENT YES',
    confirmNoLabel: 'SENT NO',
    hint: 'SENT HINT',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The visibility walk and the shown / hidden assertions.
// ---------------------------------------------------------------------------

/** Why `start` (or one of its ancestors up to <html>) is off screen, or null when it is on screen. */
function hiddenReason(start: Element | null): string | null {
  for (let node: Element | null = start; node instanceof HTMLElement; node = node.parentElement) {
    const where = node.id === '' ? node.tagName : `#${node.id}`;
    if (node.style.display === 'none') return `${where} has display:none`;
    if (node.hasAttribute('hidden')) return `${where} has the hidden attribute`;
    if (node.style.visibility === 'hidden') return `${where} has visibility:hidden`;
    if (node.getAttribute('aria-hidden') === 'true') return `${where} has aria-hidden=true`;
    if (node.hasAttribute('inert')) return `${where} is inert`;
  }
  return null;
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  expect(found, `#${id} must exist — the shell constructs it`).not.toBeNull();
  return found as HTMLElement;
}

/** On screen all the way to the document, carrying exactly `text` (non-empty). */
function expectShown(id: string, text: string): HTMLElement {
  const node = el(id);
  expect(hiddenReason(node), `#${id} must be on screen`).toBeNull();
  const own = node.textContent ?? '';
  expect(
    own.length,
    `#${id} must carry text — a blank node is invisible to everyone`,
  ).toBeGreaterThan(0);
  expect(own, `#${id} must paint the view model's own text`).toBe(text);
  return node;
}

function expectHidden(id: string): void {
  expect(hiddenReason(el(id)), `#${id} must be off screen`).not.toBeNull();
}

/** A shown native button: type=button, text only, no aria-label, never disabled, and Enter, Space
 *  and NumpadEnter stay the button's own (the router must not eat them). */
function expectActionButton(id: string, label: string): HTMLButtonElement {
  const node = expectShown(id, label);
  expect(node.tagName, `#${id} must be a native <button>`).toBe('BUTTON');
  const button = node as HTMLButtonElement;
  expect(button.type, `#${id} must be type=button`).toBe('button');
  expect(button.hasAttribute('aria-label'), `#${id}: its text is its name, no aria-label`).toBe(
    false,
  );
  expect(button.children.length, `#${id} holds text only`).toBe(0);
  expect(button.disabled, `#${id} is never disabled — a disabled button cannot be focused`).toBe(
    false,
  );
  for (const code of ['Enter', 'Space', 'NumpadEnter']) {
    expect(ownership(button, { code }), `${code} on #${id} stays native`).toBe('target');
  }
  return button;
}

// ---------------------------------------------------------------------------
// The focus oracle.
// ---------------------------------------------------------------------------

interface FocusCall {
  readonly target: HTMLElement;
  readonly hiddenAtCall: string | null;
}

let focusCalls: FocusCall[] = [];
const realFocus = HTMLElement.prototype.focus;

function resetFocusLog(): void {
  focusCalls = [];
}

const focusedIds = (): string[] => focusCalls.map((call) => call.target.id);
const activeId = (): string => document.activeElement?.id ?? '';

/** Every recorded focus() that landed on a node that was off screen at that moment. */
function expectNoFocusOnHidden(): void {
  expect(
    focusCalls.filter((call) => call.hiddenAtCall !== null).map((call) => call.hiddenAtCall),
    'focus() must come AFTER every display write: a browser refuses to focus a hidden node',
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

type HandlerName = keyof SessionViewHandlers;
const HANDLER_NAMES: readonly HandlerName[] = [
  'onContinueRequested',
  'onContinueConfirmed',
  'onConfirmCancelled',
  'onRetry',
];

let spies: Record<HandlerName, ReturnType<typeof vi.fn>>;
let view: SessionView;

function freshSpies(): Record<HandlerName, ReturnType<typeof vi.fn>> {
  return {
    onContinueRequested: vi.fn(),
    onContinueConfirmed: vi.fn(),
    onConfirmCancelled: vi.fn(),
    onRetry: vi.fn(),
  };
}

function clearSpies(): void {
  for (const name of HANDLER_NAMES) spies[name].mockClear();
}

/** Exactly one handler fired exactly once and the other three fired ZERO times: a Cancel wired to
 *  Continue is how a guest session gets minted by a "No". */
function expectOnly(fired: HandlerName): void {
  for (const name of HANDLER_NAMES) {
    expect(
      spies[name],
      name === fired ? `${name} must fire exactly once` : `${name} must NOT fire`,
    ).toHaveBeenCalledTimes(name === fired ? 1 : 0);
  }
}

/** The game screen the shell mounts into: `#game-screen > #frame-layer`. */
function mountGameScreen(): void {
  document.body.replaceChildren();
  const screen = document.createElement('div');
  screen.id = 'game-screen';
  const layer = document.createElement('div');
  layer.id = 'frame-layer';
  screen.appendChild(layer);
  document.body.appendChild(screen);
}

/** A fresh document, a fresh shell, fresh spies and an empty focus log. */
function freshView(): SessionView {
  mountGameScreen();
  spies = freshSpies();
  resetFocusLog();
  return new SessionView(spies as unknown as SessionViewHandlers);
}

/** A focusable control OUTSIDE the overlay (a page control the player is on). */
function outsideButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.id = 'outside-control';
  button.textContent = 'outside';
  document.body.appendChild(button);
  return button;
}

beforeEach(() => {
  HTMLElement.prototype.focus = function recordedFocus(this: HTMLElement, options?: FocusOptions) {
    focusCalls.push({ target: this, hiddenAtCall: hiddenReason(this) });
    realFocus.call(this, options);
  };
  view = freshView();
});

afterEach(() => {
  HTMLElement.prototype.focus = realFocus;
  setLocale('en');
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------

describe('SessionView (ctl-8k, CTL8K.1): the session gate as an in-frame system modal', () => {
  it('CTL8K-1-RED-EXPIRED: an expired gate paints a visible title, a visible body, the hint and the Retry and Continue buttons labelled from the catalog (the red: title and body were display:none and the buttons blank)', () => {
    // WRONG IMPL KILLED (the measured one): the pre-ctl-8k shell, whose ensureElement nodes stay
    // display:none and whose buttons carry no text. Also: a Retry painted with the Continue label,
    // and an unarmed gate that already shows the second step.
    const vm = buildSessionViewModel(EXPIRED);
    expect(vm.visible, 'fixture: the expired gate is showing').toBe(true);
    expect(vm.title).toBe('Session expired');
    expect(vm.body).toBe(EN['chrome.session.expired.body']);
    expect(vm.retryLabel, 'the model owns the Retry copy').toBe('Retry');
    expect(vm.primaryActionLabel).toBe('Continue as guest');
    expect(vm.hint).toBe('B and Start do nothing here. Tab moves, Enter chooses.');

    view.render(vm);

    expect(el(ROOT_ID).style.display, 'the root is shown').toBe('block');
    expectShown(TITLE_ID, 'Session expired');
    expectShown(BODY_ID, EN['chrome.session.expired.body']);
    expectShown(HINT_ID, 'B and Start do nothing here. Tab moves, Enter chooses.');
    expectActionButton(RETRY_ID, 'Retry');
    expectActionButton(CONTINUE_ID, 'Continue as guest');
    // The second step is not on screen yet.
    expectHidden(CONFIRM_ID);
    expectHidden(YES_ID);
    expectHidden(NO_ID);
    expectHidden(FEEDBACK_ID);
  });

  it('CTL8K-1-UNREACHABLE: an unreachable gate paints its own distinct title and body with the same buttons, labelled and on screen', () => {
    // WRONG IMPL KILLED: painting the expired copy for both states (AUTH-46 wants distinct copy);
    // painting the title and body only for the first state ever rendered.
    const vm = buildSessionViewModel(UNREACHABLE);
    expect(vm.title).toBe('Sign-in service unavailable');
    expect(vm.retryLabel).toBe('Retry');

    view.render(vm);

    expect(el(ROOT_ID).style.display).toBe('block');
    expectShown(TITLE_ID, 'Sign-in service unavailable');
    expectShown(BODY_ID, EN['chrome.session.unreachable.body']);
    expect(el(TITLE_ID).textContent, 'distinct from the expired title').not.toBe(
      EN['chrome.session.expired.title'],
    );
    expectShown(HINT_ID, EN['session.hint']);
    expectActionButton(RETRY_ID, 'Retry');
    expectActionButton(CONTINUE_ID, 'Continue as guest');
    expectHidden(CONFIRM_ID);
    expectHidden(YES_ID);
    expectHidden(NO_ID);
  });

  it('CTL8K-1-IN-GAME-SCREEN: the root sits in #frame-layer (else #game-screen, else <body>) with the frame, shell and top classes, shown as block, and every child lives inside it', () => {
    // WRONG IMPL KILLED: a root appended to <body> (outside the game screen, below the fold); a
    // root without .mr-frame / .mr-shell (dark-on-dark default) or without .mr-shell--top (it
    // would sink under the battle overlay at z-index 110); a root shown as '' (the `visible`
    // getter reads '' as hidden); a child parked on <body>, which the root's close would not hide.
    view.render(vmOf());
    const root = el(ROOT_ID);
    expect(root.parentElement?.id, 'the root is a direct child of #frame-layer').toBe(
      'frame-layer',
    );
    expect(el('game-screen').contains(root), 'and so lives inside #game-screen').toBe(true);
    for (const cls of ['mr-frame', 'mr-shell', 'mr-shell--top']) {
      expect(root.classList.contains(cls), `the root carries .${cls}`).toBe(true);
    }
    expect(root.style.display, 'shown as block, never the empty string').toBe('block');
    for (const id of CHILD_IDS) {
      expect(el(id).parentElement, `#${id} is a direct child of the root`).toBe(root);
    }

    // Fallback anchors: no frame layer, then no game screen at all.
    document.body.replaceChildren();
    const screenOnly = document.createElement('div');
    screenOnly.id = 'game-screen';
    document.body.appendChild(screenOnly);
    const inScreen = new SessionView(freshSpies() as unknown as SessionViewHandlers);
    inScreen.render(vmOf());
    expect(el(ROOT_ID).parentElement?.id, 'with no frame layer the root joins #game-screen').toBe(
      'game-screen',
    );

    document.body.replaceChildren();
    const inBody = new SessionView(freshSpies() as unknown as SessionViewHandlers);
    inBody.render(vmOf());
    expect(el(ROOT_ID).parentElement, 'with no game screen the root joins <body>').toBe(
      document.body,
    );
    expectShown(TITLE_ID, 'SENT TITLE');
  });

  it('CTL8K-1-ORDER: the root holds exactly the nine nodes in reading and tab order, with the right tags, Retry before Continue and Yes before No', () => {
    // WRONG IMPL KILLED: Continue before Retry in the DOM (Tab would reach the irreversible
    // action first); No before Yes; a missing hint node; the title as a <div> (no heading); a
    // stowaway node between the controls.
    view.render(vmOf());
    const root = el(ROOT_ID);
    expect(
      Array.from(root.children).map((child) => child.id),
      'the nine children in order',
    ).toEqual([...CHILD_IDS]);
    expect(el(TITLE_ID).tagName).toBe('H2');
    for (const id of [BODY_ID, FEEDBACK_ID, CONFIRM_ID, HINT_ID]) {
      expect(el(id).tagName, `#${id} is a <p>`).toBe('P');
    }
    for (const id of BUTTON_IDS) {
      expect(el(id).tagName, `#${id} is a native <button>`).toBe('BUTTON');
      expect((el(id) as HTMLButtonElement).type, `#${id} is type=button`).toBe('button');
    }
    // Rendering again must not reshuffle or duplicate anything.
    view.render(vmOf({ confirmPrompt: 'SENT PROMPT', feedback: 'SENT FEEDBACK' }));
    expect(Array.from(root.children).map((child) => child.id)).toEqual([...CHILD_IDS]);
    expect(document.querySelectorAll(`#${ROOT_ID}`)).toHaveLength(1);
  });

  it('CTL8K-1-RETRY-DEFAULT: opening the gate focuses Retry (never Continue) with exactly one focus() after every display write, and a click on it fires onRetry only', () => {
    // WRONG IMPL KILLED: no focus at all (the player lands on <body> behind a modal); focus on
    // Continue (the irreversible action is the default); focus() before the display write (a
    // no-op in a real browser); two focus() calls; Retry wired to the wrong handler; Retry painted
    // with the Continue label (sentinel labels are distinct).
    view.render(vmOf());
    expect(focusedIds(), 'exactly one focus() on the open edge, on Retry').toEqual([RETRY_ID]);
    expectNoFocusOnHidden();
    expect(activeId()).toBe(RETRY_ID);
    const retry = expectActionButton(RETRY_ID, 'SENT RETRY');
    expect(retry.textContent).not.toBe('SENT CONTINUE');
    expectActionButton(CONTINUE_ID, 'SENT CONTINUE');
    clearSpies();
    retry.click();
    expectOnly('onRetry');

    // The same, from each real state.
    for (const state of [EXPIRED, UNREACHABLE]) {
      view = freshView();
      const vm = buildSessionViewModel(state);
      view.render(vm);
      expect(focusedIds(), `${state.state}: one focus() on Retry`).toEqual([RETRY_ID]);
      expectNoFocusOnHidden();
      expectActionButton(RETRY_ID, vm.retryLabel);
    }
  });

  it('CTL8K-1-OPEN-ARMED: opening a gate that is already armed focuses No, never Yes or Continue, and a click on it cancels', () => {
    // WRONG IMPL KILLED: the open edge always focusing Retry (it is hidden while armed, so the
    // focus() is a no-op and the player is on <body>); focusing Yes (a confirm defaults to No);
    // No and Yes transposed (sentinel labels differ); No wired to the confirm handler.
    view.render(vmOf({ confirmPrompt: 'SENT PROMPT' }));
    expect(focusedIds(), 'exactly one focus() on the open edge, on No').toEqual([NO_ID]);
    expectNoFocusOnHidden();
    expect(activeId()).toBe(NO_ID);
    const no = expectActionButton(NO_ID, 'SENT NO');
    expect(document.activeElement?.textContent, 'the focused button is labelled No').toBe(
      'SENT NO',
    );
    expectActionButton(YES_ID, 'SENT YES');
    expectShown(CONFIRM_ID, 'SENT PROMPT');
    clearSpies();
    no.click();
    expectOnly('onConfirmCancelled');

    // A real armed state, through the real model.
    view = freshView();
    const vm = buildSessionViewModel(arm(EXPIRED));
    expect(vm.confirmPrompt, 'fixture: really armed').toBeDefined();
    view.render(vm);
    expect(activeId()).toBe(NO_ID);
    expect(document.activeElement?.textContent).toBe('No');
    expect(focusedIds()).toEqual([NO_ID]);
    expectNoFocusOnHidden();
  });

  it('CTL8K-1-NO-STEAL: a re-render of an open gate never moves or takes focus that is on an outside control or on Continue', () => {
    // WRONG IMPL KILLED: a render that always re-focuses Retry or No (it would yank a player off
    // the control they are on); a reseat that ignores the outside-the-frame guard; a plain
    // re-render that touches focus at all (a focus() call count of zero is the oracle).
    view.render(vmOf());
    const outside = outsideButton();
    outside.focus();
    expect(activeId(), 'fixture: the player is on an outside control').toBe('outside-control');
    resetFocusLog();
    const outsideSequence: SessionViewModel[] = [
      vmOf(),
      vmOf({ feedback: 'SENT FEEDBACK' }),
      vmOf({ confirmPrompt: 'SENT PROMPT' }),
      vmOf({ confirmPrompt: 'SENT PROMPT', feedback: 'SENT FEEDBACK 2' }),
      vmOf({ title: 'SENT TITLE 2', body: 'SENT BODY 2' }),
    ];
    for (const vm of outsideSequence) {
      view.render(vm);
      expect(activeId(), 'focus stays on the outside control').toBe('outside-control');
    }
    expect(focusedIds(), 'a re-render over an outside control makes zero focus() calls').toEqual(
      [],
    );
    // ANTI-VACUITY: the frame really was painted by those renders.
    expectShown(TITLE_ID, 'SENT TITLE 2');
    expectShown(CONTINUE_ID, 'SENT CONTINUE');

    // Focus on Continue: a plain re-render (same vm, a feedback change, expired -> unreachable)
    // moves nothing either.
    view = freshView();
    view.render(buildSessionViewModel(EXPIRED));
    const continueBtn = el(CONTINUE_ID);
    continueBtn.focus();
    expect(activeId()).toBe(CONTINUE_ID);
    resetFocusLog();
    for (const state of [EXPIRED, withFeedback(EXPIRED), UNREACHABLE, withFeedback(UNREACHABLE)]) {
      view.render(buildSessionViewModel(state));
      expect(activeId(), `focus stays on Continue (${state.state})`).toBe(CONTINUE_ID);
    }
    expect(focusedIds(), 'a plain re-render makes zero focus() calls').toEqual([]);
    expectShown(TITLE_ID, EN['chrome.session.unreachable.title']);
  });

  it('CTL8K-1-ARM-NO-DEFAULT: arming on an open gate moves focus to No exactly once (from Retry or Continue), No is labelled No and cancels, and an armed re-render leaves focus where it is', () => {
    // WRONG IMPL KILLED: no reseat (focus stays on a hidden Continue or Retry and drops to
    // <body>); focus on Yes (one Enter confirms an irreversible choice); a reseat that fires on
    // EVERY armed render (it would yank a player off Yes they tabbed to); No and Yes transposed.
    for (const startId of [RETRY_ID, CONTINUE_ID]) {
      view = freshView();
      view.render(vmOf());
      el(startId).focus();
      expect(activeId(), `fixture: focus starts on #${startId}`).toBe(startId);
      resetFocusLog();

      view.render(vmOf({ confirmPrompt: 'SENT PROMPT' }));
      expect(focusedIds(), `arming from #${startId}: exactly one focus(), on No`).toEqual([NO_ID]);
      expectNoFocusOnHidden();
      expect(activeId()).toBe(NO_ID);
      const no = expectActionButton(NO_ID, 'SENT NO');
      expect(document.activeElement?.textContent).toBe('SENT NO');
      expect(document.activeElement?.textContent).not.toBe('SENT YES');
      clearSpies();
      no.click();
      expectOnly('onConfirmCancelled');
    }

    // Already armed: a feedback re-render keeps focus on No, and on Yes when the player tabbed there.
    view = freshView();
    view.render(vmOf({ confirmPrompt: 'SENT PROMPT' }));
    resetFocusLog();
    view.render(vmOf({ confirmPrompt: 'SENT PROMPT', feedback: 'SENT FEEDBACK' }));
    expect(activeId(), 'armed -> armed keeps No').toBe(NO_ID);
    el(YES_ID).focus();
    resetFocusLog();
    view.render(vmOf({ confirmPrompt: 'SENT PROMPT', feedback: 'SENT FEEDBACK 2' }));
    expect(activeId(), 'armed -> armed keeps Yes when the player is on Yes').toBe(YES_ID);
    expect(focusedIds(), 'and makes no focus() call').toEqual([]);
  });

  it('CTL8K-1-UNARMED-HIDDEN: an unarmed gate hides the prompt, Yes and No and shows Retry and Continue; arming swaps them; disarming swaps them back', () => {
    // WRONG IMPL KILLED: the second step painted from the start (a bare "Yes" beside "Continue as
    // guest" is a one-step decline); Retry and Continue left on screen under the prompt; a
    // one-way write (shown once, never hidden again); a disabled control standing in for a hidden
    // one (a disabled button cannot take focus).
    for (const state of [EXPIRED, UNREACHABLE]) {
      view = freshView();
      const unarmed = buildSessionViewModel(state);
      const armed = buildSessionViewModel(arm(state));
      expect(armed.confirmPrompt, 'fixture: the armed projection carries the prompt').toBeDefined();

      view.render(unarmed);
      expectActionButton(RETRY_ID, unarmed.retryLabel);
      expectActionButton(CONTINUE_ID, unarmed.primaryActionLabel);
      expectHidden(CONFIRM_ID);
      expectHidden(YES_ID);
      expectHidden(NO_ID);

      view.render(armed);
      expectShown(CONFIRM_ID, armed.confirmPrompt as string);
      expectActionButton(YES_ID, armed.confirmYesLabel);
      expectActionButton(NO_ID, armed.confirmNoLabel);
      expectShown(TITLE_ID, armed.title);
      expectShown(BODY_ID, armed.body);
      expectShown(HINT_ID, armed.hint);
      expectHidden(RETRY_ID);
      expectHidden(CONTINUE_ID);

      view.render(unarmed);
      expectActionButton(RETRY_ID, unarmed.retryLabel);
      expectActionButton(CONTINUE_ID, unarmed.primaryActionLabel);
      expectHidden(CONFIRM_ID);
      expectHidden(YES_ID);
      expectHidden(NO_ID);
    }
  });

  it('CTL8K-1-DISARM-CONTINUE: disarming on an open gate moves focus to Continue exactly once (from No or Yes), never to Retry', () => {
    // WRONG IMPL KILLED: no reseat (focus drops to <body> when No hides); disarm focusing Retry
    // (the player who just said No would land on a different action than the one they chose
    // between); focusing a hidden node; Continue painted with the wrong label.
    for (const startId of [NO_ID, YES_ID]) {
      view = freshView();
      view.render(vmOf({ confirmPrompt: 'SENT PROMPT' }));
      el(startId).focus();
      expect(activeId(), `fixture: focus starts on #${startId}`).toBe(startId);
      resetFocusLog();

      view.render(vmOf());
      expect(focusedIds(), `disarming from #${startId}: exactly one focus(), on Continue`).toEqual([
        CONTINUE_ID,
      ]);
      expectNoFocusOnHidden();
      expect(activeId()).toBe(CONTINUE_ID);
      expect(document.activeElement?.textContent).toBe('SENT CONTINUE');
      expectActionButton(CONTINUE_ID, 'SENT CONTINUE');
    }

    // Through the real model: arm, then cancel.
    view = freshView();
    view.render(buildSessionViewModel(arm(EXPIRED)));
    expect(activeId()).toBe(NO_ID);
    const cancelled = sessionStep(arm(EXPIRED), { kind: 'confirm-cancelled' }).next;
    resetFocusLog();
    view.render(buildSessionViewModel(cancelled));
    expect(activeId()).toBe(CONTINUE_ID);
  });

  it('CTL8K-1-HINT: the hint is on screen in every state, armed or not, with feedback or without, and says B and Start do nothing here', () => {
    // WRONG IMPL KILLED: a hint painted only unarmed (the armed frame stops saying why B does
    // nothing); a hint left display:none; the hint hard-coded in the view instead of read from the
    // model (the sentinel differs from the shipped copy).
    const states: SessionModelState[] = [
      EXPIRED,
      UNREACHABLE,
      arm(EXPIRED),
      arm(UNREACHABLE),
      withFeedback(EXPIRED),
      armedWithFeedback(UNREACHABLE),
    ];
    for (const state of states) {
      view = freshView();
      const vm = buildSessionViewModel(state);
      view.render(vm);
      expectShown(HINT_ID, 'B and Start do nothing here. Tab moves, Enter chooses.');
      expect(vm.hint).toBe(el(HINT_ID).textContent);
    }
    view = freshView();
    view.render(vmOf({ hint: 'SENT HINT A' }));
    expectShown(HINT_ID, 'SENT HINT A');
    view.render(vmOf({ hint: 'SENT HINT B', confirmPrompt: 'SENT PROMPT' }));
    expectShown(HINT_ID, 'SENT HINT B');
  });

  it('CTL8K-1-FEEDBACK: the feedback line is on screen with the VM text exactly while the VM carries feedback, and gone again when it does not, armed or not', () => {
    // WRONG IMPL KILLED: feedback never shown (the player clicks Retry offline and sees
    // nothing); feedback shown with an empty or stale text; a one-way show (the disconnected line
    // would stay after a successful retry); a feedback line that hides the prompt it accompanies.
    const unarmedFeedback = buildSessionViewModel(withFeedback(EXPIRED));
    expect(unarmedFeedback.feedback, 'fixture: the model carries the disconnected line').toBe(
      EN['chrome.feedback.disconnected'],
    );
    const armedFeedback = buildSessionViewModel(armedWithFeedback(EXPIRED));
    expect(armedFeedback.confirmPrompt, 'fixture: the dropped confirm stays armed').toBeDefined();
    expect(armedFeedback.feedback).toBe(EN['chrome.feedback.disconnected']);

    view.render(buildSessionViewModel(EXPIRED));
    expectHidden(FEEDBACK_ID);

    view.render(unarmedFeedback);
    expectShown(FEEDBACK_ID, EN['chrome.feedback.disconnected']);
    expectActionButton(RETRY_ID, unarmedFeedback.retryLabel);

    view.render(buildSessionViewModel(EXPIRED));
    expectHidden(FEEDBACK_ID);

    view.render(armedFeedback);
    expectShown(FEEDBACK_ID, EN['chrome.feedback.disconnected']);
    expectShown(CONFIRM_ID, armedFeedback.confirmPrompt as string);
    expectActionButton(NO_ID, armedFeedback.confirmNoLabel);

    view.render(vmOf({ feedback: 'SENT FEEDBACK A' }));
    expectShown(FEEDBACK_ID, 'SENT FEEDBACK A');
    view.render(vmOf({ feedback: 'SENT FEEDBACK B' }));
    expectShown(FEEDBACK_ID, 'SENT FEEDBACK B');
    view.render(vmOf());
    expectHidden(FEEDBACK_ID);
  });

  it('CTL8K-1-REOPEN: closing and re-opening the gate re-takes focus on each open edge (Retry unarmed, No armed) with exactly one focus() each', () => {
    // WRONG IMPL KILLED: an open edge detected from a latched "opened once" flag (the second open
    // leaves focus on <body>); the open edge reading the stale armed state of the DOM instead of
    // the VM (an armed re-open would focus a hidden Retry); focus() before the display write.
    view.render(vmOf());
    expect(activeId()).toBe(RETRY_ID);
    view.render(vmOf({ visible: false }));
    expect(el(ROOT_ID).style.display, 'closed').toBe('none');
    resetFocusLog();

    view.render(vmOf());
    expect(el(ROOT_ID).style.display, 're-opened').toBe('block');
    expect(focusedIds(), 'one focus() on the second open edge').toEqual([RETRY_ID]);
    expectNoFocusOnHidden();
    expect(activeId()).toBe(RETRY_ID);
    expectShown(TITLE_ID, 'SENT TITLE');

    // Re-open already armed: the DOM was last unarmed, the VM is armed, so No is the target.
    view.render(vmOf({ visible: false }));
    resetFocusLog();
    view.render(vmOf({ confirmPrompt: 'SENT PROMPT' }));
    expect(focusedIds(), 'one focus() on the armed open edge').toEqual([NO_ID]);
    expectNoFocusOnHidden();
    expect(activeId()).toBe(NO_ID);

    // And back to unarmed on the next open.
    view.render(vmOf({ visible: false }));
    resetFocusLog();
    view.render(vmOf());
    expect(focusedIds()).toEqual([RETRY_ID]);
    expect(activeId()).toBe(RETRY_ID);
  });

  it('CTL8K-1-HANDLERS: each button, on screen and labelled, fires exactly its own handler exactly once', () => {
    // WRONG IMPL KILLED: a handler bound twice (a re-render must not re-wire); two buttons sharing
    // one handler (Cancel wired to Continue); Yes wired to the request handler (a one-step
    // decline); a button that is only reachable by a programmatic click (hidden).
    view.render(vmOf());
    const unarmedRows: Array<readonly [string, string, HandlerName]> = [
      [RETRY_ID, 'SENT RETRY', 'onRetry'],
      [CONTINUE_ID, 'SENT CONTINUE', 'onContinueRequested'],
    ];
    for (const [id, label, handler] of unarmedRows) {
      const button = expectActionButton(id, label);
      clearSpies();
      button.click();
      expectOnly(handler);
    }

    view.render(vmOf({ confirmPrompt: 'SENT PROMPT' }));
    view.render(vmOf({ confirmPrompt: 'SENT PROMPT', feedback: 'SENT FEEDBACK' }));
    const armedRows: Array<readonly [string, string, HandlerName]> = [
      [YES_ID, 'SENT YES', 'onContinueConfirmed'],
      [NO_ID, 'SENT NO', 'onConfirmCancelled'],
    ];
    for (const [id, label, handler] of armedRows) {
      const button = expectActionButton(id, label);
      clearSpies();
      button.click();
      expectOnly(handler);
    }
  });

  it('CTL8K-1-NO-LIVE-REGION: no node under the root is a live region, a status or an alert, and the root is not a dialog of its own, while the frame is painted', () => {
    // WRONG IMPL KILLED: an aria-live / role=status on the feedback line (exactly one live region
    // exists and ui/liveRegion.ts owns it); a role=dialog / aria-modal on the root (the gate is
    // registry-external: it must not fight the overlay registry's single modal). The painted-title
    // precondition keeps this from passing against an unpainted frame.
    const states: SessionModelState[] = [
      EXPIRED,
      armedWithFeedback(UNREACHABLE),
      withFeedback(EXPIRED),
    ];
    for (const state of states) {
      view.render(buildSessionViewModel(state));
      expectShown(TITLE_ID, buildSessionViewModel(state).title);
      const root = el(ROOT_ID);
      expect(
        root.querySelectorAll('[aria-live], [role="status"], [role="alert"]').length,
        'no live region under the root',
      ).toBe(0);
      for (const attr of ['aria-live', 'role', 'aria-modal']) {
        expect(root.hasAttribute(attr), `the root must not carry ${attr}`).toBe(false);
      }
    }
  });

  it('CTL8K-1-NO-REPEAT: a held Enter (a repeat keydown) on any gate button is default-prevented, a first press is not', () => {
    // WRONG IMPL KILLED: no repeat guard (a held Enter on Retry fires one click per OS repeat, and
    // a held Enter on Continue arms the gate, lands on No and then cancels it); a guard that eats
    // the FIRST press too (the native click would never fire); a guard on Retry only.
    const press = (target: HTMLElement, repeat: boolean): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        repeat,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event;
    };

    view.render(vmOf());
    expect(activeId(), 'fixture: Retry is the focused button').toBe(RETRY_ID);
    const retry = expectActionButton(RETRY_ID, 'SENT RETRY');
    expect(press(retry, true).defaultPrevented, 'a repeat keydown on Retry is prevented').toBe(
      true,
    );
    expect(press(retry, false).defaultPrevented, 'a first press on Retry is left native').toBe(
      false,
    );
    const continueBtn = expectActionButton(CONTINUE_ID, 'SENT CONTINUE');
    expect(press(continueBtn, true).defaultPrevented, 'a repeat on Continue is prevented').toBe(
      true,
    );
    expect(press(continueBtn, false).defaultPrevented).toBe(false);

    view.render(vmOf({ confirmPrompt: 'SENT PROMPT' }));
    for (const id of [YES_ID, NO_ID]) {
      const button = expectActionButton(id, id === YES_ID ? 'SENT YES' : 'SENT NO');
      expect(press(button, true).defaultPrevented, `a repeat on #${id} is prevented`).toBe(true);
      expect(press(button, false).defaultPrevented, `a first press on #${id} is native`).toBe(
        false,
      );
    }
  });

  it('CTL8K-1-LOCALE: every shown label, title, body and hint follows the active locale on every render (open edge, arm, disarm, state switch), and a new render re-paints every label', () => {
    // WRONG IMPL KILLED: labels written once at construction or on the open edge only (a locale
    // switch while open leaves English on screen); the hint hard-coded; the unreachable state
    // keeping the expired title and body while open; Retry, Yes and No re-painted from a stale VM.
    view.render(buildSessionViewModel(EXPIRED));
    expectShown(TITLE_ID, EN['chrome.session.expired.title']);

    setLocale('fr');
    const frExpired = buildSessionViewModel(EXPIRED);
    view.render(frExpired);
    expectShown(TITLE_ID, FR['chrome.session.expired.title']);
    expectShown(BODY_ID, FR['chrome.session.expired.body']);
    expectShown(HINT_ID, FR['session.hint']);
    expectActionButton(RETRY_ID, FR['session.retry']);
    expectActionButton(CONTINUE_ID, FR['chrome.session.continue']);
    expect(el(RETRY_ID).textContent, 'French, not English').not.toBe(EN['session.retry']);

    view.render(buildSessionViewModel(arm(EXPIRED)));
    expectShown(CONFIRM_ID, FR['chrome.session.confirmPrompt']);
    expectActionButton(YES_ID, FR['prompt.yes']);
    expectActionButton(NO_ID, FR['prompt.no']);
    expectShown(HINT_ID, FR['session.hint']);
    expectShown(TITLE_ID, FR['chrome.session.expired.title']);

    view.render(buildSessionViewModel(EXPIRED));
    expectActionButton(RETRY_ID, FR['session.retry']);
    expectActionButton(CONTINUE_ID, FR['chrome.session.continue']);
    expectShown(HINT_ID, FR['session.hint']);

    // expired -> unreachable while open: both the title and the body change.
    const titleBefore = el(TITLE_ID).textContent;
    const bodyBefore = el(BODY_ID).textContent;
    view.render(buildSessionViewModel(UNREACHABLE));
    expectShown(TITLE_ID, FR['chrome.session.unreachable.title']);
    expectShown(BODY_ID, FR['chrome.session.unreachable.body']);
    expect(el(TITLE_ID).textContent, 'the title changed').not.toBe(titleBefore);
    expect(el(BODY_ID).textContent, 'the body changed').not.toBe(bodyBefore);

    // Back to English while open: every label follows.
    setLocale('en');
    view.render(buildSessionViewModel(UNREACHABLE));
    expectShown(TITLE_ID, EN['chrome.session.unreachable.title']);
    expectActionButton(RETRY_ID, 'Retry');
    expectShown(HINT_ID, 'B and Start do nothing here. Tab moves, Enter chooses.');

    // Sentinel pair: every label is re-painted from the latest VM.
    view = freshView();
    view.render(vmOf());
    view.render(
      vmOf({
        title: 'OTHER TITLE',
        body: 'OTHER BODY',
        primaryActionLabel: 'OTHER CONTINUE',
        retryLabel: 'OTHER RETRY',
        hint: 'OTHER HINT',
      }),
    );
    expectShown(TITLE_ID, 'OTHER TITLE');
    expectShown(BODY_ID, 'OTHER BODY');
    expectShown(HINT_ID, 'OTHER HINT');
    expectActionButton(RETRY_ID, 'OTHER RETRY');
    expectActionButton(CONTINUE_ID, 'OTHER CONTINUE');
    view.render(
      vmOf({
        confirmPrompt: 'OTHER PROMPT',
        confirmYesLabel: 'OTHER YES',
        confirmNoLabel: 'OTHER NO',
      }),
    );
    expectShown(CONFIRM_ID, 'OTHER PROMPT');
    expectActionButton(YES_ID, 'OTHER YES');
    expectActionButton(NO_ID, 'OTHER NO');
  });

  it('CTL8K-1-CLOSE-BLUR: closing the gate hides the root and leaves no focus inside it, from Retry and from No', () => {
    // WRONG IMPL KILLED: a close that only writes display:none (focus stays on a hidden button, so
    // the next key goes to a node nobody can see); a blur on the wrong edge (every render).
    for (const armed of [false, true]) {
      view = freshView();
      view.render(armed ? vmOf({ confirmPrompt: 'SENT PROMPT' }) : vmOf());
      const focused = el(armed ? NO_ID : RETRY_ID);
      expect(document.activeElement, 'fixture: the open gate holds focus').toBe(focused);
      expect(el(ROOT_ID).contains(document.activeElement)).toBe(true);

      view.render(vmOf({ visible: false }));
      expect(el(ROOT_ID).style.display, 'the root is hidden').toBe('none');
      expect(
        el(ROOT_ID).contains(document.activeElement),
        'no focus is left inside the hidden gate',
      ).toBe(false);
    }
  });

  it('CTL8K-1-Z-ORDER: in the real index.html the session root is appended to #frame-layer after #menu-overlay and #help-overlay, all on the same top tier', () => {
    // WRONG IMPL KILLED: a root on <body> (outside the frame layer's stacking context); a root
    // inserted BEFORE the static menu or help (an equal z-index loses the tie by document order, so
    // Start over the gate would paint above it); a root without .mr-shell--top (the battle overlay
    // at z 110 would cover it).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');
    // The module script is cut out: parsing must never try to load main.ts.
    const scriptAt = raw.lastIndexOf('<script');
    const scriptEnd = raw.indexOf('</script>', scriptAt) + '</script>'.length;
    const markup = raw.slice(0, scriptAt) + raw.slice(scriptEnd);
    const detached = new Window({
      settings: {
        disableCSSFileLoading: true,
        disableJavaScriptFileLoading: true,
        disableJavaScriptEvaluation: true,
      },
    });
    const parsed = new detached.DOMParser().parseFromString(markup, 'text/html');
    const sourceScreen = parsed.getElementById('game-screen');
    expect(sourceScreen, 'ANTI-VACUITY: index.html declares #game-screen').not.toBeNull();

    const rebuild = (src: Element): HTMLElement => {
      const out = document.createElement(src.tagName.toLowerCase());
      for (const attr of Array.from(src.attributes)) out.setAttribute(attr.name, attr.value);
      for (const child of Array.from(src.children)) out.appendChild(rebuild(child));
      return out;
    };
    document.body.replaceChildren(rebuild(sourceScreen as unknown as Element));
    spies = freshSpies();
    view = new SessionView(spies as unknown as SessionViewHandlers);
    view.render(vmOf());

    const layer = el('frame-layer');
    const ids = Array.from(layer.children).map((child) => child.id);
    const session = ids.indexOf(ROOT_ID);
    expect(session, 'the session root is a direct child of #frame-layer').toBeGreaterThanOrEqual(0);
    for (const staticId of ['menu-overlay', 'help-overlay']) {
      const at = ids.indexOf(staticId);
      expect(at, `ANTI-VACUITY: #${staticId} is in the real markup`).toBeGreaterThanOrEqual(0);
      expect(session, `the session root follows #${staticId} in document order`).toBeGreaterThan(
        at,
      );
      expect(
        el(staticId).classList.contains('mr-shell--top'),
        `#${staticId} is on the top tier, so document order breaks the tie`,
      ).toBe(true);
    }
    expect(el(ROOT_ID).classList.contains('mr-shell--top')).toBe(true);
    expect(el(ROOT_ID).style.display).toBe('block');
    expectShown(TITLE_ID, 'SENT TITLE');
  });
});
