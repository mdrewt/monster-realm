// ui/claimModel.test.ts — AUTH-48/52/54/55/56/59 (M21b-2, ADR-0182 D16).
//
// EARS COVERED
//   AUTH-54 — the FOUR-WAY reject taxonomy, keyed on the EXACT strings
//             `complete_guest_claim` returns (server-module/src/accounts.rs:375-424, and
//             `ERR_INVALID_CODE` at :61). Read from the Rust source this session, not
//             transcribed from the spec prose.
//   AUTH-55 — client-side elapsed time is NEVER grounds to resume automatic `join_game`
//             while a claim code is outstanding and not explicitly declined.
//   AUTH-56 — declining a pending claim requires a DISTINCT confirmation step naming the
//             irreversible consequence before the code is deleted and joining is permitted.
//   AUTH-48 — a code-exchange failure on a tab with no prior session routes HERE, with
//             distinct copy, and NEVER through the session model.
//   AUTH-52 — the join veto's UI-visible half: while a live unconsumed code exists, a join
//             action does not join.
//   AUTH-59 — a join / retry-join / decline action attempted with no live connection
//             surfaces the ordinary disconnected feedback rather than being dropped.
//   ADR-0182 D16 — the first-run multi-device nudge is shown ONCE PER TAB on the first
//             claim-UI open (task-checklist item; ADR-0179 D8 item 6 deliberately gives it
//             no EARS criterion, so the pin is the ADR's own quoted copy).
//
// AUTH-48's NEGATIVE half ("SHALL NOT surface the session-expired state") is asserted in
// sessionModel.test.ts, where it is mechanical: that model's event vocabulary cannot
// express `sign-in-failed` at all. This file carries the positive half.
//
// RED REASON AT HEAD (8814416): `client/src/ui/claimModel.ts` DOES NOT EXIST. The import
// below fails to resolve, so every test reds on a MISSING IMPLEMENTATION.
//
// PURE MODEL — no DOM, no SDK, no storage, NO CLOCK (that last one is AUTH-55, and it is
// enforced twice: once on the event vocabulary, once by scanning the module's own source).
// The storage half lives in `net/claimCode.ts` (claimCode.test.ts); this model receives the
// nudge flag as a BOOLEAN INPUT rather than reading it, so it stays pure.
//
// THE CONTRACT THE IMPLEMENTER BUILDS:
//
//   export const CLAIM_REJECT_OUTCOMES = [
//     'delete-code-and-permit-join',      // ERR_INVALID_CODE, 'code expired'
//     'retain-destination-terminal',      // 'already has game data', 'account already
//                                         //  claimed', 'cannot claim your own session'
//     'retain-transient-no-autoretry',    // 'close your other tab, then retry',
//                                         //  'already in an ongoing battle'
//     'retain-not-claim-specific',        // 'sign in required', 'no account',
//                                         //  'account pending deletion', and ANYTHING
//                                         //  unrecognised (fail-safe: never destructive)
//   ] as const;
//   export type ClaimRejectOutcome = (typeof CLAIM_REJECT_OUTCOMES)[number];
//   export function classifyClaimReject(message: string): ClaimRejectOutcome;
//   export function claimRejectDeletesCode(outcome: ClaimRejectOutcome): boolean;
//   export function claimRejectPermitsJoin(outcome: ClaimRejectOutcome): boolean;
//
//   export type InvalidCodeSense = 'claim-already-succeeded' | 'code-unusable';
//   export function senseInvalidCode(claimedFrom: string | undefined): InvalidCodeSense;
//
//   export type ClaimPhase =
//     | 'hidden' | 'code-pending' | 'awaiting-account' | 'rejected' | 'sign-in-failed' | 'claimed';
//   export interface ClaimModelState {
//     readonly phase: ClaimPhase;
//     readonly outcome: ClaimRejectOutcome | undefined;
//     readonly signInReason: string | undefined;
//     readonly codeRetained: boolean;
//     readonly joinPermitted: boolean;
//     readonly confirmPending: boolean;
//     readonly nudgeShown: boolean;          // once per TAB — the model's own latch
//     readonly showFirstRunNudge: boolean;   // render it on THIS frame
//     readonly feedback: string | undefined;
//   }
//   export const CLAIM_INITIAL: ClaimModelState;
//   export const CLAIM_DISCONNECTED_FEEDBACK: string;
//
//   export type ClaimEventKind =
//     | 'claim-ui-opened' | 'claim-pending' | 'claim-awaiting-account' | 'claim-rejected'
//     | 'claim-succeeded' | 'sign-in-failed' | 'decline-requested' | 'decline-confirmed'
//     | 'decline-cancelled' | 'join-requested' | 'retry-join-requested';
//   export const CLAIM_EVENT_KINDS: readonly ClaimEventKind[];
//   export type ClaimEvent = <one variant per kind — see EVENTS below for the payloads>;
//   export type ClaimEffect = 'none' | 'join' | 'delete-code-and-permit-join';
//   export interface ClaimStep { readonly next: ClaimModelState; readonly effect: ClaimEffect }
//   export function claimStep(state: ClaimModelState, event: ClaimEvent): ClaimStep;
//
//   export interface ClaimViewModel {
//     readonly visible: boolean; readonly title: string; readonly body: string;
//     readonly confirmPrompt: string | undefined; readonly nudge: string | undefined;
//     readonly feedback: string | undefined;
//   }
//   export function buildClaimViewModel(state: ClaimModelState): ClaimViewModel;
//
// NO `new RegExp(...)` anywhere (Semgrep `detect-non-literal-regexp`, banned repo-wide).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildClaimViewModel,
  CLAIM_DISCONNECTED_FEEDBACK,
  CLAIM_EVENT_KINDS,
  CLAIM_INITIAL,
  CLAIM_REJECT_OUTCOMES,
  type ClaimEvent,
  type ClaimModelState,
  type ClaimRejectOutcome,
  claimRejectDeletesCode,
  claimRejectPermitsJoin,
  claimStep,
  classifyClaimReject,
  senseInvalidCode,
} from './claimModel';

// ---------------------------------------------------------------------------
// The ELEVEN exact reject strings `complete_guest_claim` can return, transcribed
// from server-module/src/accounts.rs by reading it, with the line each sits on.
// The guard NUMBERS are ADR-0182 D16's table; the STRINGS are the Rust source.
// ---------------------------------------------------------------------------

/** accounts.rs:61 — shared by guards 5 and 6 so malformed / never-existed / already-consumed
 *  are deliberately indistinguishable to a caller (AUTH-35's no-oracle requirement). */
const ERR_INVALID_CODE = 'invalid or already-used code';

const SERVER_REJECTS: readonly (readonly [string, ClaimRejectOutcome, string])[] = [
  // reason string                      expected outcome                 provenance
  [ERR_INVALID_CODE, 'delete-code-and-permit-join', 'accounts.rs:61 (guards 5/6)'],
  ['code expired', 'delete-code-and-permit-join', 'accounts.rs:402 (guard 7)'],
  ['already has game data', 'retain-destination-terminal', 'accounts.rs:424 (guard 11)'],
  ['account already claimed', 'retain-destination-terminal', 'accounts.rs:387 (guard 4)'],
  ['cannot claim your own session', 'retain-destination-terminal', 'accounts.rs:406 (guard 8)'],
  [
    'close your other tab, then retry',
    'retain-transient-no-autoretry',
    'accounts.rs:414 (guard 9)',
  ],
  ['already in an ongoing battle', 'retain-transient-no-autoretry', 'accounts.rs:420 (guard 10)'],
  ['sign in required', 'retain-not-claim-specific', 'accounts.rs:375 (guard 1)'],
  ['no account', 'retain-not-claim-specific', 'accounts.rs:379 (guard 2)'],
  ['account pending deletion', 'retain-not-claim-specific', 'accounts.rs:383 (guard 3)'],
];

const GUEST_IDENTITY = 'guest-identity-hex';

function stateOf(overrides: Partial<ClaimModelState> = {}): ClaimModelState {
  return { ...CLAIM_INITIAL, ...overrides };
}

/** A state with a live, unconsumed claim code — the F2 join-veto situation. */
function pending(overrides: Partial<ClaimModelState> = {}): ClaimModelState {
  return stateOf({ phase: 'code-pending', codeRetained: true, joinPermitted: false, ...overrides });
}

const EVENTS: readonly ClaimEvent[] = [
  { kind: 'claim-ui-opened', nudgeAlreadySeen: false },
  { kind: 'claim-ui-opened', nudgeAlreadySeen: true },
  { kind: 'claim-pending', code: 'a'.repeat(64) },
  { kind: 'claim-awaiting-account' },
  { kind: 'claim-rejected', message: ERR_INVALID_CODE, claimedFrom: undefined },
  { kind: 'claim-rejected', message: ERR_INVALID_CODE, claimedFrom: GUEST_IDENTITY },
  { kind: 'claim-rejected', message: 'already has game data', claimedFrom: undefined },
  { kind: 'claim-rejected', message: 'close your other tab, then retry', claimedFrom: undefined },
  { kind: 'claim-rejected', message: 'sign in required', claimedFrom: undefined },
  { kind: 'claim-succeeded' },
  { kind: 'sign-in-failed', reason: 'sign-in-rejected' },
  { kind: 'decline-requested' },
  { kind: 'decline-confirmed', hasLiveConnection: true },
  { kind: 'decline-confirmed', hasLiveConnection: false },
  { kind: 'decline-cancelled' },
  { kind: 'join-requested', hasLiveConnection: true },
  { kind: 'join-requested', hasLiveConnection: false },
  { kind: 'retry-join-requested', hasLiveConnection: true },
  { kind: 'retry-join-requested', hasLiveConnection: false },
];

const SWEEP_STATES: readonly ClaimModelState[] = [
  CLAIM_INITIAL,
  pending(),
  pending({ confirmPending: true }),
  stateOf({ phase: 'awaiting-account', codeRetained: true }),
  stateOf({ phase: 'rejected', outcome: 'retain-destination-terminal', codeRetained: true }),
  stateOf({ phase: 'rejected', outcome: 'retain-transient-no-autoretry', codeRetained: true }),
  stateOf({ phase: 'rejected', outcome: 'retain-not-claim-specific', codeRetained: true }),
  stateOf({ phase: 'rejected', outcome: 'delete-code-and-permit-join', joinPermitted: true }),
  stateOf({ phase: 'sign-in-failed', signInReason: 'sign-in-rejected' }),
  stateOf({ phase: 'claimed', joinPermitted: true }),
];

// ===========================================================================
// AUTH-54 — the four-way taxonomy, driven by the EXACT server strings.
// ===========================================================================

describe('classifyClaimReject (AUTH-54): the four-way taxonomy over the exact accounts.rs strings', () => {
  it('★★ BITES: all ten server reject strings classify into their AUTH-54 bucket', () => {
    // Each bucket has a distinct consequence, and getting one wrong is destructive in a
    // different way:
    //   delete-code-and-permit-join   — the code is DEAD (consumed / never existed /
    //       expired). Retaining it vetoes `join_game` on this tab FOREVER: the player can
    //       never re-enter the world.
    //   retain-destination-terminal   — the CODE is fine, the ACCOUNT cannot take it
    //       ('already has game data' is F2's namesake). Deleting the code here throws away
    //       a live claim that a DIFFERENT account could still complete.
    //   retain-transient-no-autoretry — the code and the account are both fine; a
    //       precondition is momentarily false. Deleting is data loss; auto-retrying is
    //       AUTH-55's forbidden timer.
    //   retain-not-claim-specific     — nothing about the CLAIM failed; the caller was not
    //       in a position to claim at all. Presenting it as a claim error tells the player
    //       their guest progress is gone when it is not.
    let checked = 0;
    for (const [message, expected, provenance] of SERVER_REJECTS) {
      expect(classifyClaimReject(message), `${JSON.stringify(message)} — ${provenance}`).toBe(
        expected,
      );
      checked += 1;
    }
    expect(checked, 'the ten accounts.rs reject strings must all be exercised').toBe(10);
  });

  it('★★ BITES: matching is EXACT — a near-miss is never classified as the string it resembles', () => {
    // connection.ts:596-602 states the house rule and the reason: "the SDK delivers the
    // reducer's Err string VERBATIM (SenderError(errorString)) ... a substring test would
    // swallow hypothetical non-benign messages that merely contain the phrase".
    //
    // WRONG IMPL KILLED (a): `message.includes('code expired')`. `'the code expired
    //   yesterday'` — or any future wrapped/prefixed SDK error — would then DELETE the
    //   player's live claim code.
    // WRONG IMPL KILLED (b): a case-folding or trimming match. The server literal is
    //   lowercase and untrimmed; anything else is a second, divergent copy of the contract.
    // WRONG IMPL KILLED (c): `startsWith`. `'no account'` is a prefix of nothing today, but
    //   `'already has game data'` and `'already in an ongoing battle'` share a 7-character
    //   head and sit in DIFFERENT buckets — a prefix or `includes('already')` classifier
    //   silently merges a terminal failure with a retriable one.
    const nearMisses: readonly string[] = [
      'Code expired',
      'CODE EXPIRED',
      ' code expired',
      'code expired ',
      'the code expired yesterday',
      'error: invalid or already-used code',
      'invalid or already-used code.',
      'already',
      'already has game',
      'account',
      '',
    ];
    for (const message of nearMisses) {
      expect(
        classifyClaimReject(message),
        `${JSON.stringify(message)} is NOT a server reject string — it must fall to the ` +
          'non-destructive bucket, never to delete-code-and-permit-join',
      ).toBe('retain-not-claim-specific');
    }
  });

  it('★★ BITES: an UNRECOGNISED message falls to the non-destructive bucket (fail-safe direction)', () => {
    // AUTH-54's last clause: "take no destructive action, and SHALL NOT present the failure
    // as claim-specific". An unknown message is exactly that situation — a network-shaped
    // SDK error, a future server reason, a wrapped rejection. Defaulting to
    // delete-code-and-permit-join would destroy a live claim on any error the client has
    // never seen before.
    fc.assert(
      fc.property(fc.string(), (message) => {
        const known = SERVER_REJECTS.some(([m]) => m === message);
        if (known) return;
        expect(classifyClaimReject(message)).toBe('retain-not-claim-specific');
      }),
    );
  });

  it('★★ BITES: deletesCode / permitsJoin are TRUE for exactly one outcome (exhaustive over the taxonomy)', () => {
    // The taxonomy only matters through these two consequences, and they must move
    // together: a bucket that deletes the code without permitting join leaves the tab
    // vetoed with no code to complete; one that permits join while retaining the code
    // re-opens F2 (an account-class connection joining while a claim is outstanding).
    let deleting = 0;
    for (const outcome of CLAIM_REJECT_OUTCOMES) {
      const deletes = claimRejectDeletesCode(outcome);
      const permits = claimRejectPermitsJoin(outcome);
      expect(deletes, `${outcome}: delete and permit must agree`).toBe(permits);
      if (outcome === 'delete-code-and-permit-join') {
        expect(deletes, 'the one destructive bucket must actually delete').toBe(true);
        deleting += 1;
      } else {
        expect(deletes, `${outcome} must RETAIN the code — its name says so`).toBe(false);
      }
    }
    expect(deleting, 'exactly one bucket deletes').toBe(1);
    expect([...CLAIM_REJECT_OUTCOMES].sort()).toEqual(
      [
        'delete-code-and-permit-join',
        'retain-destination-terminal',
        'retain-not-claim-specific',
        'retain-transient-no-autoretry',
      ].sort(),
    );
  });

  it('★★ BITES: a rejected claim moves the model into the matching outcome, and only the delete bucket lifts the veto', () => {
    for (const [message, expected] of SERVER_REJECTS) {
      const step = claimStep(pending(), {
        kind: 'claim-rejected',
        message,
        claimedFrom: undefined,
      });
      expect(step.next.outcome, message).toBe(expected);
      expect(step.next.joinPermitted, `${message}: joinPermitted`).toBe(
        claimRejectPermitsJoin(expected),
      );
      expect(step.next.codeRetained, `${message}: codeRetained`).toBe(
        !claimRejectDeletesCode(expected),
      );
      expect(step.effect, `${message}: effect`).toBe(
        claimRejectDeletesCode(expected) ? 'delete-code-and-permit-join' : 'none',
      );
    }
  });

  it('★★ BITES: NO reject path ever re-issues the claim (AUTH-54 "SHALL NOT auto-retry")', () => {
    // The parenthetical AUTH-54 gained at finalization is precise: "SHALL NOT auto-retry"
    // means SHALL NOT retry ON A CLIENT-SIDE TIMER (AUTH-55) — it does not conflict with
    // AUTH-53's reconnect-triggered reissue, which fires once per NEW CONNECTION and lives
    // in connection.ts's `.onApplied`, not here. So the mechanical form is: this model's
    // effect alphabet contains nothing that re-issues a claim.
    const allowed = ['none', 'join', 'delete-code-and-permit-join'];
    const seen = new Set<string>();
    for (const state of SWEEP_STATES) {
      for (const event of EVENTS) seen.add(claimStep(state, event).effect);
    }
    for (const effect of seen) {
      expect(allowed, `effect ${effect} is outside the sanctioned alphabet`).toContain(effect);
      expect(effect.indexOf('retry'), `effect ${effect} names a retry`).toBe(-1);
      expect(effect.indexOf('claim-again')).toBe(-1);
    }
    expect(seen.size, 'anti-vacuity: the sweep must observe more than one effect').toBeGreaterThan(
      1,
    );
  });
});

// ===========================================================================
// ERR_INVALID_CODE — disambiguated ONLY by ownAccount.claimedFrom.
// ===========================================================================

describe('senseInvalidCode (ADR-0182 D16): the ONE client-side disambiguation of ERR_INVALID_CODE', () => {
  it('★★ BITES: a set `claimedFrom` means OUR claim already succeeded; absent means the code is unusable', () => {
    // Guards 5 and 6 return the SAME string on purpose (AUTH-35: no code-existence oracle),
    // so the client cannot tell "never existed" from "already consumed" — and MUST NOT try.
    // The single legitimate disambiguation is local and non-oracular: if OUR OWN account row
    // now carries `claimed_from`, the code was consumed BY US (the pre-drop promise did
    // settle server-side, ADR-0085 D3) and the claim SUCCEEDED. Anything else is a dead code.
    expect(senseInvalidCode(GUEST_IDENTITY)).toBe('claim-already-succeeded');
    expect(senseInvalidCode(undefined)).toBe('code-unusable');
    expect(senseInvalidCode(''), 'an empty identity is not a claim').toBe('code-unusable');
  });

  it('★★ BITES: the disambiguation takes exactly ONE input — no elapsed time, no attempt count', () => {
    // AUTH-55 in miniature. A signature that also took `nowMs` or `attempts` would let
    // "we have been trying for a while, assume it worked" creep in — a client-side
    // inference about server state, which is the exact class of bug the no-oracle rule and
    // ADR-0085 D3 both exist to prevent.
    expect(senseInvalidCode.length).toBe(1);
  });

  it('★★ BITES: ERR_INVALID_CODE WITH claimedFrom lands on `claimed`, not `rejected`', () => {
    // The reconnect-reissue race, end to end: connection.ts re-issues `complete_guest_claim`
    // on the new connection's first `onApplied` (AUTH-53). If the pre-drop call had already
    // succeeded, the reissue returns ERR_INVALID_CODE — and telling the player "invalid
    // code" at the exact moment their claim COMPLETED is the worst possible outcome: they
    // would decline, delete the code, and believe their guest progress was lost.
    const step = claimStep(pending(), {
      kind: 'claim-rejected',
      message: ERR_INVALID_CODE,
      claimedFrom: GUEST_IDENTITY,
    });
    expect(step.next.phase).toBe('claimed');
    expect(step.next.joinPermitted, 'a completed claim lifts the veto').toBe(true);
    expect(step.next.codeRetained, 'and the consumed code is gone').toBe(false);
  });

  it('★★ BITES: ERR_INVALID_CODE WITHOUT claimedFrom lands on the delete bucket (the ordinary dead-code path)', () => {
    const step = claimStep(pending(), {
      kind: 'claim-rejected',
      message: ERR_INVALID_CODE,
      claimedFrom: undefined,
    });
    expect(step.next.phase).toBe('rejected');
    expect(step.next.outcome).toBe('delete-code-and-permit-join');
    expect(step.next.joinPermitted).toBe(true);
  });

  it('★★ BITES: claimedFrom does NOT rewrite any OTHER reject (the disambiguation is scoped to ERR_INVALID_CODE)', () => {
    // WRONG IMPL KILLED: `if (claimedFrom !== undefined) return 'claimed'` applied to every
    // reject. 'account already claimed' (guard 4) fires PRECISELY BECAUSE `claimed_from` is
    // already set — from a DIFFERENT, earlier claim. Treating it as success would tell the
    // player this claim worked when their guest progress is still stranded.
    for (const [message, expected] of SERVER_REJECTS) {
      if (message === ERR_INVALID_CODE) continue;
      const step = claimStep(pending(), {
        kind: 'claim-rejected',
        message,
        claimedFrom: GUEST_IDENTITY,
      });
      expect(step.next.phase, `${message} must not be re-read as success`).toBe('rejected');
      expect(step.next.outcome, message).toBe(expected);
    }
  });
});

// ===========================================================================
// AUTH-55 — no elapsed-time resumption, enforced twice.
// ===========================================================================

describe('claimModel AUTH-55: no elapsed-time input can unblock joining', () => {
  it('★★ BITES: the event vocabulary carries NO time input', () => {
    // The mutant: "if the claim has been pending for 60 s, assume it failed and let the
    // player in". That silently re-opens F2 — an account-class connection joins while the
    // guest's claim code is still live, and the guest's progress is stranded behind a claim
    // that can now never complete.
    for (const kind of CLAIM_EVENT_KINDS) {
      for (const timeWord of [
        'tick',
        'timeout',
        'timer',
        'elapsed',
        'now',
        'expire-after',
        'auto',
      ]) {
        expect(String(kind).indexOf(timeWord), `event kind ${kind} names "${timeWord}"`).toBe(-1);
      }
    }
    expect(claimStep.length, 'claimStep takes exactly (state, event) — no clock argument').toBe(2);
  });

  it('★★ BITES (exhaustive): joinPermitted goes false -> true ONLY via a delete-bucket reject, a completed claim, or a CONFIRMED decline', () => {
    // The veto's whole safety argument, quantified. Any other transition into
    // `joinPermitted: true` is a way for `join_game` to resume while a live claim code is
    // outstanding — AUTH-52's exact prohibition, and the one AUTH-55 says elapsed time may
    // never cause.
    let lifted = 0;
    for (const state of SWEEP_STATES) {
      if (state.joinPermitted) continue;
      for (const event of EVENTS) {
        const step = claimStep(state, event);
        if (!step.next.joinPermitted) continue;
        lifted += 1;
        const via = event.kind;
        const legitimate =
          (via === 'claim-rejected' &&
            (classifyClaimReject((event as { message: string }).message) ===
              'delete-code-and-permit-join' ||
              (event as { claimedFrom?: string }).claimedFrom !== undefined)) ||
          via === 'claim-succeeded' ||
          (via === 'decline-confirmed' &&
            state.confirmPending &&
            (event as { hasLiveConnection: boolean }).hasLiveConnection);
        expect(legitimate, `the veto was lifted by ${via} from ${JSON.stringify(state)}`).toBe(
          true,
        );
      }
    }
    expect(
      lifted,
      'anti-vacuity: the sweep must observe the veto lifting at least once',
    ).toBeGreaterThan(0);
  });

  it('★ BITES: repeating the SAME event never drifts the state (no hidden counter that eventually unblocks)', () => {
    // A counter-based "give up after N attempts" is elapsed time by another name. Applying
    // one event twenty times must be indistinguishable from applying it once.
    const event: ClaimEvent = { kind: 'join-requested', hasLiveConnection: true };
    let state = pending();
    const first = claimStep(state, event).next;
    for (let i = 0; i < 20; i += 1) state = claimStep(state, event).next;
    expect(state).toEqual(first);
    expect(state.joinPermitted, 'a vetoed join must stay vetoed however often it is clicked').toBe(
      false,
    );
  });
});

// ===========================================================================
// AUTH-52 / AUTH-59 — the veto's UI half and the disconnected feedback.
// ===========================================================================

describe('claimModel AUTH-52 / AUTH-59: joining while vetoed, and acting with no live connection', () => {
  it('★★ BITES: a join action while a live code is outstanding does NOT join — and is not silent', () => {
    // AUTH-52's UI-visible half. The AUTHORITATIVE veto lives in connection.ts's
    // `.onApplied` (G18) and does not depend on this model — but a button that appears to
    // do nothing teaches the player the client is broken.
    for (const kind of ['join-requested', 'retry-join-requested'] as const) {
      const step = claimStep(pending(), { kind, hasLiveConnection: true });
      expect(step.effect, `${kind} must not join while the claim is outstanding`).toBe('none');
      expect(step.next.feedback, `${kind} must explain itself`).toBeDefined();
      expect(
        step.next.feedback,
        'a vetoed join is NOT a disconnection — the two causes must not share one line',
      ).not.toBe(CLAIM_DISCONNECTED_FEEDBACK);
    }
  });

  it('★★ BITES: once the veto lifts, a join action actually joins', () => {
    // Anti-vacuity for the test above: `effect: 'none'` everywhere would satisfy it.
    for (const kind of ['join-requested', 'retry-join-requested'] as const) {
      const step = claimStep(stateOf({ phase: 'claimed', joinPermitted: true }), {
        kind,
        hasLiveConnection: true,
      });
      expect(step.effect, kind).toBe('join');
    }
  });

  it('★★ BITES (AUTH-59): the feedback line is EXACTLY the repo-wide disconnected string', () => {
    // "the SAME visible feedback as an ordinary disconnected action" — the literal
    // careAction.ts:32 and main.ts's ten guarded reducer sites already use. Pinned BY VALUE
    // on both sides (sessionModel.test.ts carries the mirror) because careAction.ts's copy
    // is module-private and exporting it is outside this slice's touch set. NAMED RESIDUAL:
    // if either side drifts, this reds, and the honest fix is one exported constant.
    expect(CLAIM_DISCONNECTED_FEEDBACK).toBe('disconnected — try again');
  });

  it('★★ BITES (AUTH-59): all THREE actions produce that same line with no live connection, and none of them acts', () => {
    const feedbacks = new Set<string | undefined>();
    const cases: readonly (readonly [string, ClaimModelState, ClaimEvent])[] = [
      [
        'join',
        stateOf({ phase: 'claimed', joinPermitted: true }),
        { kind: 'join-requested', hasLiveConnection: false },
      ],
      [
        'retry-join',
        stateOf({ phase: 'claimed', joinPermitted: true }),
        { kind: 'retry-join-requested', hasLiveConnection: false },
      ],
      [
        'decline',
        pending({ confirmPending: true }),
        { kind: 'decline-confirmed', hasLiveConnection: false },
      ],
    ];
    for (const [label, state, event] of cases) {
      const step = claimStep(state, event);
      expect(step.effect, `${label} must not act with no live connection`).toBe('none');
      expect(step.next.feedback, `${label} must not be silently discarded`).toBeDefined();
      feedbacks.add(step.next.feedback);
    }
    expect([...feedbacks], 'one shared line, not one per handler').toEqual([
      CLAIM_DISCONNECTED_FEEDBACK,
    ]);
  });

  it('★★ BITES: a dropped decline does NOT delete the code and leaves the confirmation armed', () => {
    // The worst possible way to mishandle AUTH-59 here: treat the dropped action as
    // completed, delete the code, and permit joining. The player's guest progress would be
    // unrecoverable and nothing would have been sent to the server.
    const step = claimStep(pending({ confirmPending: true }), {
      kind: 'decline-confirmed',
      hasLiveConnection: false,
    });
    expect(step.next.codeRetained, 'a dropped decline must not delete the code').toBe(true);
    expect(step.next.joinPermitted).toBe(false);
    expect(step.next.confirmPending, 'the confirmation is not spent by an undelivered click').toBe(
      true,
    );
  });
});

// ===========================================================================
// AUTH-56 — the decline confirmation.
// ===========================================================================

describe('claimModel AUTH-56: declining requires a DISTINCT second step naming the irreversible consequence', () => {
  it('★★ BITES: `decline-requested` arms the confirmation and deletes NOTHING', () => {
    // WRONG IMPL KILLED: a one-click decline. AUTH-56 exists because the consequence is
    // unrecoverable — the code is the only handle on the guest identity's data, and once it
    // is gone (or consumed by the reaper) that progress cannot be claimed by anyone, ever.
    const step = claimStep(pending(), { kind: 'decline-requested' });
    expect(step.next.confirmPending).toBe(true);
    expect(step.next.codeRetained, 'step one must not delete anything').toBe(true);
    expect(step.next.joinPermitted, 'step one must not lift the veto').toBe(false);
    expect(step.effect).toBe('none');
  });

  it('★★ BITES: a confirm with NOTHING armed is inert (the two steps are not interchangeable)', () => {
    const step = claimStep(pending({ confirmPending: false }), {
      kind: 'decline-confirmed',
      hasLiveConnection: true,
    });
    expect(step.effect).toBe('none');
    expect(step.next.codeRetained).toBe(true);
    expect(step.next.joinPermitted).toBe(false);
  });

  it('★★ BITES: an ARMED, delivered confirm deletes the code and permits joining', () => {
    const step = claimStep(pending({ confirmPending: true }), {
      kind: 'decline-confirmed',
      hasLiveConnection: true,
    });
    expect(step.effect).toBe('delete-code-and-permit-join');
    expect(step.next.codeRetained).toBe(false);
    expect(step.next.joinPermitted).toBe(true);
    expect(step.next.confirmPending).toBe(false);
  });

  it('★ BITES: cancelling disarms and changes nothing else', () => {
    const step = claimStep(pending({ confirmPending: true }), { kind: 'decline-cancelled' });
    expect(step.effect).toBe('none');
    expect(step.next.confirmPending).toBe(false);
    expect(step.next.codeRetained).toBe(true);
    expect(step.next.joinPermitted).toBe(false);
  });

  it('★★ BITES: the confirmation copy NAMES THE IRREVERSIBLE CONSEQUENCE, and step one does not', () => {
    // ★ DELIBERATE COPY PIN — "names the irreversible consequence" is otherwise
    // unfalsifiable. The two phrases below are the contract; change them in this test ONLY
    // from the spec, never to match an implementation that wrote something else.
    //
    // WRONG IMPL KILLED: `confirmPrompt: 'Are you sure?'` — a distinct second step that
    // says nothing about what is lost, i.e. the dialog every player clicks through.
    const armed = buildClaimViewModel(pending({ confirmPending: true }));
    expect(armed.confirmPrompt, 'the armed decline must carry a prompt').toBeDefined();
    const prompt = String(armed.confirmPrompt);
    expect(
      prompt.indexOf('cannot be undone'),
      'the prompt must name the irreversibility',
    ).toBeGreaterThanOrEqual(0);
    expect(
      prompt.indexOf('guest progress'),
      'and it must name WHAT is lost',
    ).toBeGreaterThanOrEqual(0);
    expect(prompt.length).toBeGreaterThan(20);

    const unarmed = buildClaimViewModel(pending({ confirmPending: false }));
    expect(unarmed.confirmPrompt, 'an unarmed decline shows no prompt').toBeUndefined();
    expect(
      `${unarmed.title}${unarmed.body}`.indexOf('cannot be undone'),
      'the FIRST step must not already carry the confirmation copy — if it does, the two ' +
        'steps are not distinct',
    ).toBe(-1);
  });
});

// ===========================================================================
// AUTH-48 — sign-in-failed routes HERE, with distinct copy.
// ===========================================================================

describe('claimModel AUTH-48: a failed first-time sign-in routes into the claim UI with distinct copy', () => {
  it('★★ BITES: the vocabulary accepts `sign-in-failed` and the model reaches its own phase', () => {
    // ADR-0182 D17: "a first-time claim-flow redirect whose code exchange fails is not
    // 'session expired' — there was no prior session to expire." The mirror assertion (the
    // session model cannot express this event at all) lives in sessionModel.test.ts.
    expect(CLAIM_EVENT_KINDS).toContain('sign-in-failed');
    const step = claimStep(pending(), { kind: 'sign-in-failed', reason: 'sign-in-rejected' });
    expect(step.next.phase).toBe('sign-in-failed');
    expect(step.next.signInReason).toBe('sign-in-rejected');
  });

  it('★★ BITES: a failed sign-in does NOT delete the claim code or lift the veto', () => {
    // The player can try signing in again; their guest progress must still be claimable.
    // WRONG IMPL KILLED: treating a sign-in failure as a claim failure and running the
    // delete bucket — the code would be gone and the guest data stranded, over a
    // recoverable provider hiccup.
    const step = claimStep(pending(), {
      kind: 'sign-in-failed',
      reason: 'auth-service-unreachable',
    });
    expect(step.next.codeRetained).toBe(true);
    expect(step.next.joinPermitted).toBe(false);
    expect(step.effect).toBe('none');
  });

  it('★★ BITES: the sign-in-failed copy is DISTINCT from the pending and rejected copy', () => {
    // "a distinct sign-in-failed outcome through the claim UI". Reusing the generic reject
    // copy would tell a player whose SIGN-IN failed that their CLAIM was rejected — and the
    // remedy for the two is different (retry the provider vs. give up on the claim).
    const signInFailed = buildClaimViewModel(
      stateOf({ phase: 'sign-in-failed', signInReason: 'sign-in-rejected' }),
    );
    const pendingVm = buildClaimViewModel(pending());
    const rejectedVm = buildClaimViewModel(
      stateOf({ phase: 'rejected', outcome: 'retain-destination-terminal', codeRetained: true }),
    );
    expect(signInFailed.visible).toBe(true);
    expect(signInFailed.body.length).toBeGreaterThan(0);
    expect(signInFailed.body).not.toBe(pendingVm.body);
    expect(signInFailed.body).not.toBe(rejectedVm.body);
    expect(signInFailed.title).not.toBe(rejectedVm.title);
  });

  it('★ BITES: the classified reason reaches the copy path but the raw vocabulary is never rendered verbatim as the whole body', () => {
    // AUTH-57 keeps the reason a static token like `sign-in-rejected`; showing that token
    // to a player is a bug of a different kind. Two different reasons must be
    // distinguishable in the copy, without the copy BEING the token.
    const a = buildClaimViewModel(
      stateOf({ phase: 'sign-in-failed', signInReason: 'sign-in-rejected' }),
    );
    const b = buildClaimViewModel(
      stateOf({ phase: 'sign-in-failed', signInReason: 'auth-service-unreachable' }),
    );
    expect(a.body).not.toBe('sign-in-rejected');
    expect(b.body).not.toBe('auth-service-unreachable');
    expect(a.body).not.toBe(b.body);
  });
});

// ===========================================================================
// First-run multi-device nudge — once per tab (ADR-0182 D16).
// ===========================================================================

describe('claimModel first-run nudge: shown once per tab on the first claim-UI open', () => {
  it('★★ BITES: the first open with an unseen flag shows the nudge; the second open does not', () => {
    // "shown once per tab the first time the claim UI is opened (tracked by a boolean in
    // the same mr.claimCode.v1 storage namespace, not a new key)". The STORAGE half is
    // claimCode.test.ts's; the model receives the flag as an input so it stays pure — and
    // the model needs its OWN latch too, because a tab that opens the UI twice before the
    // flag is written back would otherwise nag twice.
    const first = claimStep(CLAIM_INITIAL, { kind: 'claim-ui-opened', nudgeAlreadySeen: false });
    expect(first.next.showFirstRunNudge).toBe(true);
    expect(first.next.nudgeShown, 'the model latches so a re-open in the same tab is quiet').toBe(
      true,
    );

    const second = claimStep(first.next, { kind: 'claim-ui-opened', nudgeAlreadySeen: false });
    expect(second.next.showFirstRunNudge, 'the second open in the same tab must be quiet').toBe(
      false,
    );
  });

  it('★★ BITES: a tab whose stored flag is already set never shows the nudge', () => {
    const step = claimStep(CLAIM_INITIAL, { kind: 'claim-ui-opened', nudgeAlreadySeen: true });
    expect(step.next.showFirstRunNudge).toBe(false);
    expect(step.next.nudgeShown).toBe(true);
  });

  it('★★ BITES: the nudge copy is the ADR-quoted sentence, and it appears ONLY when the flag says so', () => {
    // ★ DELIBERATE COPY PIN: ADR-0182 D16 quotes this sentence verbatim, so it IS the
    // contract, not a paraphrase. Its content is load-bearing — a player who claims on a
    // second device would otherwise expect progress from the first one to follow.
    const NUDGE = 'Guest progress transfers only from the device you claim it on.';
    const shown = buildClaimViewModel(pending({ showFirstRunNudge: true, nudgeShown: true }));
    expect(String(shown.nudge)).toBe(NUDGE);
    const quiet = buildClaimViewModel(pending({ showFirstRunNudge: false, nudgeShown: true }));
    expect(quiet.nudge).toBeUndefined();
  });

  it('★ BITES: opening the UI does not disturb the claim state (the nudge is decoration, not a transition)', () => {
    const before = pending({ confirmPending: true });
    const after = claimStep(before, { kind: 'claim-ui-opened', nudgeAlreadySeen: true }).next;
    expect(after.phase).toBe(before.phase);
    expect(after.codeRetained).toBe(before.codeRetained);
    expect(after.joinPermitted).toBe(before.joinPermitted);
    expect(after.confirmPending).toBe(before.confirmPending);
  });
});

// ===========================================================================
// Purity + totality.
// ===========================================================================

describe('claimModel: purity and totality', () => {
  it('★★ BITES (exhaustive): claimStep never mutates its input and always returns a well-formed state', () => {
    for (const state of SWEEP_STATES) {
      for (const event of EVENTS) {
        const before = JSON.stringify(state);
        const step = claimStep(state, event);
        expect(JSON.stringify(state), `mutated by ${event.kind}`).toBe(before);
        expect(typeof step.next.codeRetained, JSON.stringify(event)).toBe('boolean');
        expect(typeof step.next.joinPermitted, JSON.stringify(event)).toBe('boolean');
        expect(typeof step.next.confirmPending, JSON.stringify(event)).toBe('boolean');
        expect(() => buildClaimViewModel(step.next)).not.toThrow();
      }
    }
  });

  it('★ BITES: the exported event vocabulary is exactly the eleven kinds the reducer handles', () => {
    // The AUTH-55 no-timer test quantifies over this list, so a kind that exists in the
    // union but not in the list is invisible to it — the exact shape a "temporary"
    // auto-resume event would take.
    expect([...CLAIM_EVENT_KINDS].sort()).toEqual(
      [
        'claim-awaiting-account',
        'claim-pending',
        'claim-rejected',
        'claim-succeeded',
        'claim-ui-opened',
        'decline-cancelled',
        'decline-confirmed',
        'decline-requested',
        'join-requested',
        'retry-join-requested',
        'sign-in-failed',
      ].sort(),
    );
  });

  it('★ BITES: classifyClaimReject is total over arbitrary input and never throws', () => {
    fc.assert(
      fc.property(fc.string(), (message) => {
        expect(CLAIM_REJECT_OUTCOMES).toContain(classifyClaimReject(message));
      }),
    );
  });
});

// ===========================================================================
// AUTH-55 SOURCE SCAN — the model owns no clock.
//
// WHY BOTH THIS AND THE VOCABULARY TEST: the vocabulary test proves no time can
// ENTER through the reducer's alphabet. It cannot see a module that reaches
// `Date.now()` (or arms a `setTimeout`) internally — a `buildClaimViewModel` that
// hides the decline button "after 60 s" is invisible to every behavioural
// assertion above and is exactly the elapsed-time resumption AUTH-55 forbids.
//
// NAMED RESIDUAL, same honesty as the G30 scans: a substring scan cannot see
// `globalThis['Date']` or a clock injected through a parameter this file does not
// know about. What it guarantees is that the shipped source does not NAME a clock.
// ===========================================================================

const CLAIM_MODEL_TS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'claimModel.ts',
);

function readSourceOrThrow(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    // Fail loud — a missing file must never make a scan vacuously pass.
    throw new Error(`could not read ${filePath} — ${String(err)}`);
  }
}

function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

/** Copied in behaviour from connection.test.ts:95-122 so the source scans cannot drift. */
function stripComments(src: string): string {
  let withoutBlocks = '';
  let i = 0;
  for (;;) {
    const start = src.indexOf('/*', i);
    if (start === -1) {
      withoutBlocks += src.slice(i);
      break;
    }
    withoutBlocks += src.slice(i, start);
    const end = src.indexOf('*/', start + 2);
    if (end === -1) break;
    i = end + 2;
  }
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const j = line.indexOf('//');
      return j === -1 ? line : line.slice(0, j);
    })
    .join('\n');
}

describe('AUTH-55 source scan: claimModel.ts names no clock and schedules nothing', () => {
  it('★ CALIBRATION: the stripper is not vacuous, and claimModel.ts carries no scheme literal', () => {
    // Plan ADDENDUM §C, last bullet. The scheme pin closes `stripComments`'s quote
    // blindness: it truncates each line at the first two-slash token, so a live line
    // carrying a URL would hide whatever follows it from the bans below.
    const fixture = [
      'const live = 1;',
      '// setTimeout(f, 60000)',
      '/* Date.now() */ const also = 2;',
    ].join('\n');
    const strippedFixture = stripComments(fixture);
    expect(countOccurrences(strippedFixture, 'setTimeout')).toBe(0);
    expect(countOccurrences(strippedFixture, 'Date.now')).toBe(0);
    expect(countOccurrences(strippedFixture, 'const live = 1;')).toBe(1);
    expect(countOccurrences(strippedFixture, 'const also = 2;')).toBe(1);
    expect(countOccurrences(readSourceOrThrow(CLAIM_MODEL_TS_PATH), ':' + '//')).toBe(0);
  });

  it('★★ BITES: zero Date.now / new Date / setTimeout / setInterval / performance.now / requestAnimationFrame', () => {
    const stripped = stripComments(readSourceOrThrow(CLAIM_MODEL_TS_PATH));
    // Anti-vacuity first: a stub (or a stripper that ate everything) satisfies every zero.
    expect(
      countOccurrences(stripped, 'export'),
      'the scanned source must export something',
    ).toBeGreaterThanOrEqual(5);
    expect(
      countOccurrences(stripped, 'claimStep'),
      'and it must define the reducer',
    ).toBeGreaterThanOrEqual(1);

    for (const banned of [
      'Date.now',
      'new Date',
      'setTimeout',
      'setInterval',
      'performance.now',
      'requestAnimationFrame',
      'nowMs',
      'elapsedMs',
    ]) {
      expect(
        countOccurrences(stripped, banned),
        `claimModel.ts must never name "${banned}" — AUTH-55 forbids client-side elapsed ` +
          'time as grounds to resume automatic join_game while a claim code is outstanding',
      ).toBe(0);
    }
  });
});
