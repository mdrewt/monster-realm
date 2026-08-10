// ui/sessionModel.test.ts — AUTH-46/47/49/56/59 (M21b-2, ADR-0182 D17).
//
// EARS COVERED
//   AUTH-46 — the auth-service-unreachable state offers the SAME continue-anonymously
//             affordance as session-expired, without discarding the credential or
//             permanently ceasing retries.
//   AUTH-47 — the session-expired state exists and is DISTINCT from unreachable.
//   AUTH-49 — WHILE either state is showing, the client connects anonymously ONLY in
//             direct, synchronous response to an EXPLICIT "continue as guest" action.
//             No timer, no elapsed time, no automatic escape hatch.
//   AUTH-56 — the decline / continue-anonymously confirmation requires a DISTINCT second
//             step whose copy names the irreversible consequence.
//   AUTH-59 — a retry or continue-anonymously action attempted with no live connection
//             surfaces the SAME visible feedback as an ordinary disconnected action, and
//             is never silently discarded.
//
// AUTH-48's NEGATIVE HALF LIVES HERE: `sign-in-failed` routes through the CLAIM model, not
// this one (ADR-0182 D17). The positive half — the claim model accepts it and renders
// distinct copy — is in claimModel.test.ts; the mechanical negative (this model's event
// vocabulary cannot even express it) is asserted below, because a vocabulary check is the
// only form of "never" a pure model can carry.
//
// RED REASON AT HEAD (8814416): `client/src/ui/sessionModel.ts` DOES NOT EXIST. The import
// below fails to resolve, so every test reds on a MISSING IMPLEMENTATION.
//
// PURE MODEL — no DOM, no SDK, no clock, no storage. Follows the file-local convention of
// healModel.test.ts / renameModel.ts: the decision core is exported and unit-tested; the
// DOM shell (`sessionView.ts`) is coverage-excluded and only binds this core to elements.
//
// THE CONTRACT THE IMPLEMENTER BUILDS:
//
//   export type SessionState = 'hidden' | 'expired' | 'unreachable';
//   export interface SessionModelState {
//     readonly state: SessionState;
//     readonly confirmPending: boolean;      // AUTH-56's second step is armed
//     readonly feedback: string | undefined; // AUTH-59's visible line
//   }
//   export const SESSION_INITIAL: SessionModelState;   // hidden / false / undefined
//   export const SESSION_DISCONNECTED_FEEDBACK: string;
//
//   export type SessionEventKind =
//     | 'session-expired' | 'auth-service-unreachable' | 'connected'
//     | 'continue-anonymously-requested' | 'continue-anonymously-confirmed'
//     | 'confirm-cancelled' | 'retry-requested';
//   export const SESSION_EVENT_KINDS: readonly SessionEventKind[];
//   export type SessionEvent =
//     | { readonly kind: 'session-expired' }
//     | { readonly kind: 'auth-service-unreachable' }
//     | { readonly kind: 'connected' }
//     | { readonly kind: 'continue-anonymously-requested' }
//     | { readonly kind: 'continue-anonymously-confirmed'; readonly hasLiveConnection: boolean }
//     | { readonly kind: 'confirm-cancelled' }
//     | { readonly kind: 'retry-requested'; readonly hasLiveConnection: boolean };
//
//   export type SessionEffect = 'none' | 'continue-anonymously' | 'retry-connect';
//   export interface SessionStep { readonly next: SessionModelState; readonly effect: SessionEffect }
//   export function sessionStep(state: SessionModelState, event: SessionEvent): SessionStep;
//
//   export interface SessionViewModel {
//     readonly visible: boolean;
//     readonly title: string;
//     readonly body: string;
//     readonly primaryActionLabel: string;
//     readonly confirmPrompt: string | undefined;  // present ONLY while confirmPending
//     readonly feedback: string | undefined;
//   }
//   export function buildSessionViewModel(state: SessionModelState): SessionViewModel;
//
// ★ WHAT `hasLiveConnection` MEANS HERE, stated because it reads backwards at first
//   glance: it is "main.ts holds a `Connection` to act on" (`conn !== undefined`), NOT "a
//   DbConnection is live". The whole premise of this overlay is that no DbConnection was
//   built, so requiring one would make the affordance unreachable. What AUTH-59 is about
//   is the window before `connect()` has returned / after teardown, where the button has
//   nowhere to send the action — and where silently doing nothing is the bug.
//
// NO `new RegExp(...)` anywhere (Semgrep `detect-non-literal-regexp`, banned repo-wide).

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildSessionViewModel,
  SESSION_DISCONNECTED_FEEDBACK,
  SESSION_EVENT_KINDS,
  SESSION_INITIAL,
  type SessionEvent,
  type SessionModelState,
  type SessionState,
  sessionStep,
} from './sessionModel';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const ALL_STATES: readonly SessionState[] = ['hidden', 'expired', 'unreachable'];
const SHOWING_STATES: readonly SessionState[] = ['expired', 'unreachable'];

function stateOf(
  state: SessionState,
  confirmPending = false,
  feedback: string | undefined = undefined,
): SessionModelState {
  return { state, confirmPending, feedback };
}

/** Every event the vocabulary can produce, including both `hasLiveConnection` values for
 *  the two that carry one. Used to drive the exhaustive AUTH-49 / AUTH-59 sweeps. */
const ALL_EVENTS: readonly SessionEvent[] = [
  { kind: 'session-expired' },
  { kind: 'auth-service-unreachable' },
  { kind: 'connected' },
  { kind: 'continue-anonymously-requested' },
  { kind: 'continue-anonymously-confirmed', hasLiveConnection: true },
  { kind: 'continue-anonymously-confirmed', hasLiveConnection: false },
  { kind: 'confirm-cancelled' },
  { kind: 'retry-requested', hasLiveConnection: true },
  { kind: 'retry-requested', hasLiveConnection: false },
];

/** Every reachable model state, for the exhaustive sweeps. */
const ALL_MODEL_STATES: readonly SessionModelState[] = ALL_STATES.flatMap((state) =>
  [true, false].flatMap((confirmPending) =>
    [undefined, SESSION_DISCONNECTED_FEEDBACK].map((feedback) =>
      stateOf(state, confirmPending, feedback),
    ),
  ),
);

// ---------------------------------------------------------------------------
// The state alphabet.
// ---------------------------------------------------------------------------

describe('sessionModel: the three states (AUTH-46 / AUTH-47 / D17)', () => {
  it('★ BITES: the initial state is hidden, with nothing armed and no feedback', () => {
    expect(SESSION_INITIAL).toEqual({
      state: 'hidden',
      confirmPending: false,
      feedback: undefined,
    });
  });

  it('★★ BITES: `session-expired` and `auth-service-unreachable` reach DISTINCT states — neither is an alias', () => {
    // AUTH-46 says the unreachable state offers "the same continue-anonymously affordance
    // as session-expired" — the same AFFORDANCE, a different STATE. Collapsing them loses
    // the distinct copy the player needs to tell "sign in again" from "we cannot reach the
    // sign-in service right now, your account is fine".
    expect(sessionStep(SESSION_INITIAL, { kind: 'session-expired' }).next.state).toBe('expired');
    expect(sessionStep(SESSION_INITIAL, { kind: 'auth-service-unreachable' }).next.state).toBe(
      'unreachable',
    );
  });

  it('★ BITES: the two states are mutually reachable — a later definitive reject supersedes unreachable, and vice versa', () => {
    // The reconnect ladder can produce either outcome on any rung: two ambiguous failures
    // then a definitive 401 is `unreachable -> expired`. A model that latches the first
    // state would leave the wrong copy on screen for the rest of the tab's life.
    expect(sessionStep(stateOf('unreachable'), { kind: 'session-expired' }).next.state).toBe(
      'expired',
    );
    expect(sessionStep(stateOf('expired'), { kind: 'auth-service-unreachable' }).next.state).toBe(
      'unreachable',
    );
  });

  it('★★ BITES: `connected` returns to hidden and disarms the confirmation and the feedback line', () => {
    // A stale armed confirmation surviving a successful reconnect means the NEXT time the
    // overlay appears its second step is already armed — one click away from discarding a
    // session that is now perfectly healthy.
    for (const state of SHOWING_STATES) {
      const step = sessionStep(stateOf(state, true, SESSION_DISCONNECTED_FEEDBACK), {
        kind: 'connected',
      });
      expect(step.next, `from ${state}`).toEqual({
        state: 'hidden',
        confirmPending: false,
        feedback: undefined,
      });
      expect(step.effect).toBe('none');
    }
  });

  it('★★ BITES (AUTH-48 negative half): the vocabulary cannot express `sign-in-failed`', () => {
    // ADR-0182 D17: "a first-time claim-flow redirect whose code exchange fails is not
    // 'session expired' — there was no prior session to expire. Routes through claimModel,
    // NOT sessionView." The positive half is claimModel.test.ts's business; this is the
    // only mechanical form of "never here" a pure model can carry.
    //
    // WRONG IMPL KILLED: adding a `sign-in-failed` event that maps onto the `expired`
    // state. The player who just tried to sign in for the FIRST time would be told their
    // session expired, and the claim they were part-way through would be invisible.
    expect(SESSION_EVENT_KINDS).not.toContain('sign-in-failed');
    for (const kind of SESSION_EVENT_KINDS) {
      expect(String(kind).indexOf('sign-in'), `event kind ${kind}`).toBe(-1);
    }
  });
});

// ---------------------------------------------------------------------------
// AUTH-49 — explicit action ONLY. No timer, no auto-escape.
// ---------------------------------------------------------------------------

describe('sessionModel AUTH-49: connecting anonymously requires an explicit, confirmed action', () => {
  it('★★ BITES: the event vocabulary carries NO time input at all (no tick / timeout / elapsed / now)', () => {
    // THE MUTANT THIS EXISTS FOR: "after 30 s of unreachable, just connect as a guest so
    // the player is not stuck". That is precisely what AUTH-49 forbids — it silently
    // abandons a real account session and mints a guest identity the player never asked
    // for, and (because the anon token slot is a single slot, D11/D14) it can strand their
    // account behind a credential they no longer present.
    //
    // Checked on the exported vocabulary rather than by scanning source, because the
    // vocabulary IS the model's whole input surface: a timer cannot drive a reducer whose
    // alphabet has no time in it.
    for (const kind of SESSION_EVENT_KINDS) {
      for (const timeWord of [
        'tick',
        'timeout',
        'timer',
        'elapsed',
        'now',
        'expire-after',
        'auto',
      ]) {
        expect(
          String(kind).indexOf(timeWord),
          `event kind ${kind} names "${timeWord}" — AUTH-49 forbids an elapsed-time escape`,
        ).toBe(-1);
      }
    }
    expect(sessionStep.length, 'sessionStep takes exactly (state, event) — no clock argument').toBe(
      2,
    );
  });

  it('★★ BITES (exhaustive): the continue-anonymously EFFECT is emitted ONLY by a confirmed action on an armed, showing state with a live connection', () => {
    // THE LOAD-BEARING SWEEP. Quantified over every (model state x event) pair the
    // vocabulary can produce, so no single-path implementation can satisfy it by accident.
    //
    // WRONG IMPLS KILLED:
    //   (a) `continue-anonymously-requested` emitting the effect directly — that is a
    //       ONE-step decline, and AUTH-56 requires two.
    //   (b) the effect firing from the `hidden` state (nothing is showing; whatever the
    //       player clicked, it was not this).
    //   (c) the effect firing when `confirmPending` is false — an unarmed confirm event,
    //       i.e. a stray keypress reaching the handler.
    //   (d) the effect firing with no live connection — AUTH-59 requires feedback there,
    //       not a silently-dropped effect.
    let emitted = 0;
    for (const state of ALL_MODEL_STATES) {
      for (const event of ALL_EVENTS) {
        const { effect } = sessionStep(state, event);
        if (effect !== 'continue-anonymously') continue;
        emitted += 1;
        expect(event.kind, JSON.stringify({ state, event })).toBe('continue-anonymously-confirmed');
        expect(state.confirmPending, JSON.stringify({ state, event })).toBe(true);
        expect(state.state, JSON.stringify({ state, event })).not.toBe('hidden');
        expect(
          (event as { hasLiveConnection?: boolean }).hasLiveConnection,
          JSON.stringify({ state, event }),
        ).toBe(true);
      }
    }
    // Anti-vacuity: `effect: 'none'` everywhere would satisfy every assertion above.
    expect(
      emitted,
      'the sweep must have observed the effect at least once — otherwise this test is ' +
        'satisfied by a model that can never continue anonymously at all',
    ).toBeGreaterThanOrEqual(2);
  });

  it('★★ BITES: requesting alone arms the confirmation and emits NOTHING', () => {
    for (const state of SHOWING_STATES) {
      const step = sessionStep(stateOf(state), { kind: 'continue-anonymously-requested' });
      expect(step.next.confirmPending, `from ${state}`).toBe(true);
      expect(step.next.state, 'arming must not change which state is showing').toBe(state);
      expect(step.effect, 'the first step must never connect').toBe('none');
    }
  });

  it('★★ BITES: a confirm with NOTHING armed is inert (kills a model that treats the two steps as interchangeable)', () => {
    for (const state of SHOWING_STATES) {
      const step = sessionStep(stateOf(state, false), {
        kind: 'continue-anonymously-confirmed',
        hasLiveConnection: true,
      });
      expect(step.effect, `from ${state}`).toBe('none');
      expect(step.next.state).toBe(state);
    }
  });

  it('★ BITES: cancelling disarms without connecting and leaves the state showing', () => {
    // The player must be able to back out of the irreversible choice. WRONG IMPL KILLED: a
    // cancel that also hides the overlay — the session is still expired, so hiding it
    // leaves the player in a game that silently cannot save.
    for (const state of SHOWING_STATES) {
      const step = sessionStep(stateOf(state, true), { kind: 'confirm-cancelled' });
      expect(step.effect).toBe('none');
      expect(step.next.confirmPending).toBe(false);
      expect(step.next.state, `from ${state}`).toBe(state);
    }
  });

  it('★★ BITES: a confirmed action does NOT hide the overlay by itself — only `connected` does', () => {
    // AUTH-46: the affordance must not "permanently cease retries", and the anonymous build
    // can itself fail. Hiding on the click would drop the player into a blank game with no
    // indication that anything is still wrong; the overlay stays until a connection
    // actually applies.
    const step = sessionStep(stateOf('expired', true), {
      kind: 'continue-anonymously-confirmed',
      hasLiveConnection: true,
    });
    expect(step.effect).toBe('continue-anonymously');
    expect(step.next.state, 'the overlay stays until `connected` arrives').toBe('expired');
    expect(step.next.confirmPending, 'but the confirmation is spent').toBe(false);
  });

  it('★ BITES: retrying emits `retry-connect`, never `continue-anonymously` (the two actions are not interchangeable)', () => {
    // AUTH-46 requires the unreachable state to keep retrying WITHOUT discarding the stored
    // credential. A retry button wired to the guest path would discard the account session
    // the player was trying to recover.
    for (const state of SHOWING_STATES) {
      const step = sessionStep(stateOf(state), {
        kind: 'retry-requested',
        hasLiveConnection: true,
      });
      expect(step.effect, `from ${state}`).toBe('retry-connect');
      expect(step.next.state).toBe(state);
    }
  });
});

// ---------------------------------------------------------------------------
// AUTH-56 — the distinct second step, naming the irreversible consequence.
// ---------------------------------------------------------------------------

describe('sessionModel AUTH-56: the confirmation is a DISTINCT second step naming the irreversible consequence', () => {
  it('★★ BITES: `confirmPrompt` is absent until the confirmation is armed, and present after', () => {
    // "a distinct confirmation step". A view model that always carries the prompt lets the
    // shell render both steps at once — which is one step, not two.
    for (const state of SHOWING_STATES) {
      expect(
        buildSessionViewModel(stateOf(state, false)).confirmPrompt,
        `${state} unarmed`,
      ).toBeUndefined();
      const armed = buildSessionViewModel(stateOf(state, true)).confirmPrompt;
      expect(armed, `${state} armed`).toBeDefined();
      expect(String(armed).length, 'a one-word prompt is not a confirmation').toBeGreaterThan(20);
    }
  });

  it('★★ BITES: the confirmation copy NAMES THE IRREVERSIBLE CONSEQUENCE, and the first step does not', () => {
    // ★ DELIBERATE COPY PIN, and the reason it is a pin: "names the irreversible
    // consequence" is otherwise unfalsifiable — any string satisfies "has copy". The exact
    // phrase below is the contract; change it in this test ONLY by changing the spec, never
    // to match an implementation that wrote something else (this file's own anti-pattern #1).
    //
    // WRONG IMPL KILLED: `confirmPrompt: 'Are you sure?'`. It is a distinct second step and
    // it says nothing about what is lost — which is exactly the dialog players click
    // through. The consequence here is real: continuing as a guest abandons the account
    // session this tab was holding.
    const IRREVERSIBLE = 'cannot be undone';
    for (const state of SHOWING_STATES) {
      const armed = buildSessionViewModel(stateOf(state, true));
      expect(
        String(armed.confirmPrompt).indexOf(IRREVERSIBLE),
        `the armed confirmation for ${state} must contain "${IRREVERSIBLE}"`,
      ).toBeGreaterThanOrEqual(0);
      const unarmed = buildSessionViewModel(stateOf(state, false));
      expect(
        `${unarmed.body}${unarmed.primaryActionLabel}`.indexOf(IRREVERSIBLE),
        'the FIRST step must not already carry the confirmation copy — if it does, the ' +
          'two steps are not distinct and the second one teaches the player nothing new',
      ).toBe(-1);
    }
  });

  it('★★ BITES: expired and unreachable render DIFFERENT copy (AUTH-46 same affordance, distinct copy)', () => {
    // ADR-0182 D17: "same terminal shape as session-expired, same continue-anonymously
    // affordance, DISTINCT COPY". Identical copy would tell a player whose account is fine
    // (the auth service is merely down) that their session expired — and they would
    // reasonably go and re-authenticate against a service that is not answering.
    const expired = buildSessionViewModel(stateOf('expired'));
    const unreachable = buildSessionViewModel(stateOf('unreachable'));
    expect(expired.visible).toBe(true);
    expect(unreachable.visible).toBe(true);
    expect(expired.body).not.toBe(unreachable.body);
    expect(expired.title).not.toBe(unreachable.title);
    expect(expired.body.length).toBeGreaterThan(0);
    expect(unreachable.body.length).toBeGreaterThan(0);
  });

  it('★ BITES: the hidden state renders invisible, with no prompt and no leaked copy', () => {
    const vm = buildSessionViewModel(SESSION_INITIAL);
    expect(vm.visible).toBe(false);
    expect(vm.confirmPrompt).toBeUndefined();
    expect(vm.feedback).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AUTH-59 — no live connection: same visible feedback, never silently dropped.
// ---------------------------------------------------------------------------

describe('sessionModel AUTH-59: an action with no live connection surfaces the ordinary disconnected feedback', () => {
  it('★★ BITES: the feedback string is EXACTLY the repo-wide disconnected line', () => {
    // "the SAME visible feedback as an ordinary disconnected action" — the literal is the
    // one careAction.ts:32 and main.ts's ten guarded reducer sites already use. Pinned BY
    // VALUE on both sides rather than shared, because careAction.ts's copy is
    // module-private and exporting it is outside this slice's touch set. Stated as a
    // NAMED RESIDUAL rather than hidden: if either side drifts, this assertion reds and the
    // honest fix is to export the constant once.
    expect(SESSION_DISCONNECTED_FEEDBACK).toBe('disconnected — try again');
  });

  it('★★ BITES: BOTH actions produce that SAME feedback when no connection exists — and neither emits an effect', () => {
    // "the same visible feedback" is a sameness claim, so it is asserted as one: the two
    // action paths must not drift into two different strings (which is what happens the
    // moment each handler writes its own).
    //
    // WRONG IMPL KILLED: `if (!hasLiveConnection) return { next: state, effect: 'none' }` —
    // structurally correct, feedback-free, and the button does nothing at all with no
    // explanation. That is the "silently discard" AUTH-59 names.
    const feedbacks = new Set<string | undefined>();
    for (const state of SHOWING_STATES) {
      const confirmStep = sessionStep(stateOf(state, true), {
        kind: 'continue-anonymously-confirmed',
        hasLiveConnection: false,
      });
      const retryStep = sessionStep(stateOf(state), {
        kind: 'retry-requested',
        hasLiveConnection: false,
      });
      for (const [label, step] of [
        ['continue-anonymously', confirmStep],
        ['retry', retryStep],
      ] as const) {
        expect(step.effect, `${label} from ${state} must not act`).toBe('none');
        expect(step.next.feedback, `${label} from ${state} must not be silent`).toBeDefined();
        feedbacks.add(step.next.feedback);
      }
    }
    expect(
      [...feedbacks],
      'every no-live-connection action must surface the SAME line, not one per handler',
    ).toEqual([SESSION_DISCONNECTED_FEEDBACK]);
  });

  it('★★ BITES: a dropped confirm leaves the confirmation ARMED (the player can retry the same click)', () => {
    // If the action could not be delivered, the second step has not been spent. Disarming
    // it would force the player back through step one for a click that never happened.
    const step = sessionStep(stateOf('expired', true), {
      kind: 'continue-anonymously-confirmed',
      hasLiveConnection: false,
    });
    expect(step.next.confirmPending).toBe(true);
    expect(step.next.state).toBe('expired');
  });

  it('★ BITES: the feedback reaches the view model (a state field nobody renders is still silent)', () => {
    const vm = buildSessionViewModel(stateOf('expired', false, SESSION_DISCONNECTED_FEEDBACK));
    expect(vm.feedback).toBe(SESSION_DISCONNECTED_FEEDBACK);
  });

  it('★ BITES: a SUCCESSFUL action clears any stale feedback (kills a sticky disconnected line)', () => {
    const step = sessionStep(stateOf('expired', true, SESSION_DISCONNECTED_FEEDBACK), {
      kind: 'continue-anonymously-confirmed',
      hasLiveConnection: true,
    });
    expect(step.effect).toBe('continue-anonymously');
    expect(
      step.next.feedback,
      'the stale disconnected line must not outlive the retry',
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Purity + totality.
// ---------------------------------------------------------------------------

describe('sessionModel: purity and totality', () => {
  it('★★ BITES (exhaustive): sessionStep never mutates its input and always returns a complete state', () => {
    // The model is fed from connection.ts's callbacks and from keydown handlers, both of
    // which hold their own copy of the state. An in-place mutation makes the two disagree
    // in a way no single-path test can see.
    for (const state of ALL_MODEL_STATES) {
      for (const event of ALL_EVENTS) {
        const before = JSON.stringify(state);
        const step = sessionStep(state, event);
        expect(JSON.stringify(state), `mutated by ${event.kind}`).toBe(before);
        expect(ALL_STATES, JSON.stringify(event)).toContain(step.next.state);
        expect(typeof step.next.confirmPending, JSON.stringify(event)).toBe('boolean');
        expect(['none', 'continue-anonymously', 'retry-connect'], JSON.stringify(event)).toContain(
          step.effect,
        );
      }
    }
  });

  it('★ BITES (property): sessionStep is total over arbitrary states and never throws', () => {
    // Block-body arrow: fast-check reads an expression-bodied matcher's return value as a
    // `false` predicate and fails spuriously (repo convention, rowConvert.test.ts:3025).
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATES),
        fc.boolean(),
        fc.option(fc.string(), { nil: undefined }),
        fc.constantFrom(...ALL_EVENTS),
        (state, confirmPending, feedback, event) => {
          const step = sessionStep({ state, confirmPending, feedback }, event);
          expect(ALL_STATES).toContain(step.next.state);
          expect(buildSessionViewModel(step.next)).toBeDefined();
        },
      ),
    );
  });

  it('★ BITES: SESSION_EVENT_KINDS lists exactly the seven kinds the reducer handles (no dead vocabulary, no hidden kind)', () => {
    // The vocabulary is what the AUTH-49 no-timer test quantifies over, so a kind that
    // exists in the union but NOT in the exported list would be invisible to it — the exact
    // shape a "temporary" auto-continue event would take.
    expect([...SESSION_EVENT_KINDS].sort()).toEqual(
      [
        'auth-service-unreachable',
        'confirm-cancelled',
        'connected',
        'continue-anonymously-confirmed',
        'continue-anonymously-requested',
        'retry-requested',
        'session-expired',
      ].sort(),
    );
  });

  it('★ BITES: the SessionState alphabet is exactly hidden | expired | unreachable', () => {
    // main.ts's session gate is pinned by G20 as `if (conn?.sessionState() !== 'hidden')`,
    // so the literal `'hidden'` is a cross-file contract: a fourth state (or a renamed
    // 'none') silently makes that gate always-true or always-false.
    const reached = new Set<SessionState>();
    for (const state of ALL_MODEL_STATES) {
      for (const event of ALL_EVENTS) reached.add(sessionStep(state, event).next.state);
    }
    expect([...reached].sort()).toEqual(['expired', 'hidden', 'unreachable']);
  });
});
