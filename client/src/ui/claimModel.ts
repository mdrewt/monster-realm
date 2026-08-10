// ui/claimModel.ts — the PURE guest-claim decision core (ADR-0182 D16, M21b-2).
//
// AUTH-48/52/54/55/56/59. No DOM, no SDK, no storage, and NO CLOCK (AUTH-55 — enforced on the
// event alphabet AND by a source scan of this file). The storage half lives in net/claimCode.ts;
// this model receives the nudge flag as a boolean INPUT so it stays pure. The AUTHORITATIVE join
// veto is connection.ts's `.onApplied` (G18); this model is its UI-visible mirror.

/** The four-way reject taxonomy (AUTH-54), keyed on the EXACT strings complete_guest_claim
 *  returns (server-module/src/accounts.rs). The name of each bucket IS its consequence. */
export const CLAIM_REJECT_OUTCOMES = [
  'delete-code-and-permit-join', // dead code (invalid / expired) — retaining it vetoes join forever
  'retain-destination-terminal', // the code is fine, this account cannot take it (F2's namesake)
  'retain-transient-no-autoretry', // both fine, a precondition is momentarily false
  'retain-not-claim-specific', // nothing about the CLAIM failed (and any unrecognised message)
] as const;
export type ClaimRejectOutcome = (typeof CLAIM_REJECT_OUTCOMES)[number];

/** accounts.rs:61 — shared by guards 5/6 so malformed / never-existed / consumed are deliberately
 *  indistinguishable (AUTH-35 no-oracle). */
const ERR_INVALID_CODE = 'invalid or already-used code';

/** The exact server strings → bucket. EXACT MATCH ONLY (the SDK delivers the reducer Err verbatim
 *  — a substring/case-folding match is a second, divergent copy of the contract). */
const REJECT_TABLE: ReadonlyMap<string, ClaimRejectOutcome> = new Map([
  [ERR_INVALID_CODE, 'delete-code-and-permit-join'],
  ['code expired', 'delete-code-and-permit-join'],
  ['already has game data', 'retain-destination-terminal'],
  ['account already claimed', 'retain-destination-terminal'],
  ['cannot claim your own session', 'retain-destination-terminal'],
  ['close your other tab, then retry', 'retain-transient-no-autoretry'],
  ['already in an ongoing battle', 'retain-transient-no-autoretry'],
  ['sign in required', 'retain-not-claim-specific'],
  ['no account', 'retain-not-claim-specific'],
  ['account pending deletion', 'retain-not-claim-specific'],
]);

/** Classify a reject message. An unrecognised message falls to the NON-DESTRUCTIVE bucket
 *  (fail-safe: never destroy a live claim on a message the client has not seen before). */
export function classifyClaimReject(message: string): ClaimRejectOutcome {
  return REJECT_TABLE.get(message) ?? 'retain-not-claim-specific';
}

/** True iff this outcome deletes the stored claim code. Only the one destructive bucket does. */
export function claimRejectDeletesCode(outcome: ClaimRejectOutcome): boolean {
  return outcome === 'delete-code-and-permit-join';
}

/** True iff this outcome lifts the join veto. Moves in LOCKSTEP with deletesCode: deleting without
 *  permitting leaves the tab vetoed with no code; permitting while retaining re-opens F2. */
export function claimRejectPermitsJoin(outcome: ClaimRejectOutcome): boolean {
  return outcome === 'delete-code-and-permit-join';
}

export type InvalidCodeSense = 'claim-already-succeeded' | 'code-unusable';

/** The ONE client-side disambiguation of ERR_INVALID_CODE (ADR-0182 D16): if OUR OWN account row
 *  now carries `claimed_from`, the code was consumed BY US and the claim SUCCEEDED. Takes exactly
 *  ONE input — no elapsed time, no attempt count (AUTH-55). */
export function senseInvalidCode(claimedFrom: string | undefined): InvalidCodeSense {
  return claimedFrom !== undefined && claimedFrom !== ''
    ? 'claim-already-succeeded'
    : 'code-unusable';
}

export type ClaimPhase =
  | 'hidden'
  | 'prompt'
  | 'code-pending'
  | 'awaiting-account'
  | 'rejected'
  | 'sign-in-failed'
  | 'claimed';

export interface ClaimModelState {
  readonly phase: ClaimPhase;
  readonly outcome: ClaimRejectOutcome | undefined;
  readonly signInReason: string | undefined;
  readonly codeRetained: boolean;
  readonly joinPermitted: boolean;
  readonly confirmPending: boolean;
  readonly nudgeShown: boolean; // once per TAB — the model's own latch
  readonly showFirstRunNudge: boolean; // render it on THIS frame
  readonly feedback: string | undefined;
}

export const CLAIM_INITIAL: ClaimModelState = {
  phase: 'hidden',
  outcome: undefined,
  signInReason: undefined,
  codeRetained: false,
  joinPermitted: false,
  confirmPending: false,
  nudgeShown: false,
  showFirstRunNudge: false,
  feedback: undefined,
};

/** The repo-wide disconnected line (AUTH-59), pinned BY VALUE (sessionModel carries the mirror). */
export const CLAIM_DISCONNECTED_FEEDBACK = 'disconnected — try again';

/** A vetoed-join line — DISTINCT from the disconnected one: the two causes must not share a line. */
const CLAIM_VETO_FEEDBACK = 'Finish or decline the pending claim before rejoining.';

export type ClaimEventKind =
  | 'claim-ui-opened'
  | 'claim-pending'
  | 'claim-awaiting-account'
  | 'claim-rejected'
  | 'claim-succeeded'
  | 'sign-in-failed'
  | 'decline-requested'
  | 'decline-confirmed'
  | 'decline-cancelled'
  | 'join-requested'
  | 'retry-join-requested';

export const CLAIM_EVENT_KINDS: readonly ClaimEventKind[] = [
  'claim-ui-opened',
  'claim-pending',
  'claim-awaiting-account',
  'claim-rejected',
  'claim-succeeded',
  'sign-in-failed',
  'decline-requested',
  'decline-confirmed',
  'decline-cancelled',
  'join-requested',
  'retry-join-requested',
];

export type ClaimEvent =
  | { readonly kind: 'claim-ui-opened'; readonly nudgeAlreadySeen: boolean }
  | { readonly kind: 'claim-pending'; readonly code: string }
  | { readonly kind: 'claim-awaiting-account' }
  | {
      readonly kind: 'claim-rejected';
      readonly message: string;
      readonly claimedFrom: string | undefined;
    }
  | { readonly kind: 'claim-succeeded' }
  | { readonly kind: 'sign-in-failed'; readonly reason: string }
  | { readonly kind: 'decline-requested' }
  | { readonly kind: 'decline-confirmed'; readonly hasLiveConnection: boolean }
  | { readonly kind: 'decline-cancelled' }
  | { readonly kind: 'join-requested'; readonly hasLiveConnection: boolean }
  | { readonly kind: 'retry-join-requested'; readonly hasLiveConnection: boolean };

export type ClaimEffect = 'none' | 'join' | 'delete-code-and-permit-join';

export interface ClaimStep {
  readonly next: ClaimModelState;
  readonly effect: ClaimEffect;
}

/** Handle a join / retry-join action (identical behaviour, AUTH-52/59). */
function joinAction(base: ClaimModelState, hasLiveConnection: boolean): ClaimStep {
  if (!base.joinPermitted) {
    // AUTH-52's UI-visible half: the authoritative veto is connection.ts's, but a button that
    // silently does nothing teaches the player the client is broken.
    return { next: { ...base, feedback: CLAIM_VETO_FEEDBACK }, effect: 'none' };
  }
  if (!hasLiveConnection) {
    return { next: { ...base, feedback: CLAIM_DISCONNECTED_FEEDBACK }, effect: 'none' };
  }
  return { next: base, effect: 'join' };
}

/** Pure reducer. Total (never throws), FRESH state, never mutates input. Exactly (state, event) —
 *  no clock argument (AUTH-55). */
export function claimStep(state: ClaimModelState, event: ClaimEvent): ClaimStep {
  // Every transition clears the one-frame nudge flag and any stale feedback; each case that needs
  // one sets it back. `claim-ui-opened` recomputes the nudge for itself.
  const base: ClaimModelState = { ...state, showFirstRunNudge: false, feedback: undefined };
  switch (event.kind) {
    case 'claim-ui-opened': {
      const show = !state.nudgeShown && !event.nudgeAlreadySeen;
      return {
        next: { ...base, phase: 'prompt', nudgeShown: true, showFirstRunNudge: show },
        effect: 'none',
      };
    }
    case 'claim-pending':
      return {
        next: {
          ...base,
          phase: 'code-pending',
          outcome: undefined,
          signInReason: undefined,
          codeRetained: true,
          joinPermitted: false,
          confirmPending: false,
        },
        effect: 'none',
      };
    case 'claim-awaiting-account':
      return {
        next: { ...base, phase: 'awaiting-account', codeRetained: true, joinPermitted: false },
        effect: 'none',
      };
    case 'claim-rejected': {
      if (
        event.message === ERR_INVALID_CODE &&
        senseInvalidCode(event.claimedFrom) === 'claim-already-succeeded'
      ) {
        // The reconnect-reissue race resolved in our favour: the pre-drop call already succeeded.
        return {
          next: {
            ...base,
            phase: 'claimed',
            outcome: undefined,
            codeRetained: false,
            joinPermitted: true,
            confirmPending: false,
          },
          effect: 'delete-code-and-permit-join',
        };
      }
      const outcome = classifyClaimReject(event.message);
      const deletes = claimRejectDeletesCode(outcome);
      return {
        next: {
          ...base,
          phase: 'rejected',
          outcome,
          codeRetained: !deletes,
          joinPermitted: deletes,
          confirmPending: false,
        },
        effect: deletes ? 'delete-code-and-permit-join' : 'none',
      };
    }
    case 'claim-succeeded':
      return {
        next: {
          ...base,
          phase: 'claimed',
          outcome: undefined,
          codeRetained: false,
          joinPermitted: true,
          confirmPending: false,
        },
        effect: 'none',
      };
    case 'sign-in-failed':
      // AUTH-48: routes HERE, not to sessionView. A recoverable provider hiccup must not delete
      // the claim code or lift the veto.
      return {
        next: {
          ...base,
          phase: 'sign-in-failed',
          signInReason: event.reason,
          joinPermitted: false,
        },
        effect: 'none',
      };
    case 'decline-requested':
      // AUTH-56 step one: arm the confirmation and delete NOTHING.
      return { next: { ...base, confirmPending: true }, effect: 'none' };
    case 'decline-confirmed': {
      if (!state.confirmPending) return { next: base, effect: 'none' };
      if (!event.hasLiveConnection) {
        // AUTH-59: not silently dropped, and the code stays and the confirmation stays ARMED.
        return {
          next: { ...state, showFirstRunNudge: false, feedback: CLAIM_DISCONNECTED_FEEDBACK },
          effect: 'none',
        };
      }
      return {
        next: { ...base, codeRetained: false, joinPermitted: true, confirmPending: false },
        effect: 'delete-code-and-permit-join',
      };
    }
    case 'decline-cancelled':
      return { next: { ...base, confirmPending: false }, effect: 'none' };
    case 'join-requested':
    case 'retry-join-requested':
      return joinAction(base, event.hasLiveConnection);
  }
}

export interface ClaimViewModel {
  readonly visible: boolean;
  readonly title: string;
  readonly body: string;
  readonly confirmPrompt: string | undefined;
  readonly nudge: string | undefined;
  readonly feedback: string | undefined;
}

const NUDGE_COPY = 'Guest progress transfers only from the device you claim it on.';
const CONFIRM_PROMPT =
  'Declining permanently deletes this claim code — your guest progress cannot be undone once the code is gone. Decline and continue as a guest?';

const PENDING_TITLE = 'Keep your guest progress';
const PENDING_BODY =
  'Sign in to claim the progress you made as a guest, or decline to keep playing as a guest on this device.';
const AWAITING_TITLE = 'Finishing your claim';
const AWAITING_BODY =
  'Waiting for your account to be ready before your guest progress can transfer.';
const CLAIMED_TITLE = 'Progress claimed';
const CLAIMED_BODY = 'Your guest progress is now attached to your account.';

const REJECT_COPY: Readonly<Record<ClaimRejectOutcome, { title: string; body: string }>> = {
  'delete-code-and-permit-join': {
    title: 'That claim code is no longer usable',
    body: 'This claim code has already been used or has expired. You can keep playing on this device.',
  },
  'retain-destination-terminal': {
    title: 'This account cannot take that progress',
    body: 'This account already has game data, so the guest progress cannot be moved onto it. The claim code is still valid on another account.',
  },
  'retain-transient-no-autoretry': {
    title: 'Not ready to claim yet',
    body: 'The claim could not complete right now — close your other tab or finish your current battle, then try again.',
  },
  'retain-not-claim-specific': {
    title: 'Could not complete the claim',
    body: 'Signing in is required before this progress can be claimed. Your guest progress is safe.',
  },
};

const SIGN_IN_FAILED_COPY: Readonly<Record<string, string>> = {
  'sign-in-rejected': 'Sign-in was rejected. Please try signing in again.',
  'sign-in-expired': 'That sign-in link expired. Please try signing in again.',
  'sign-in-declined': 'Sign-in was cancelled. You can try again whenever you are ready.',
  'auth-service-unreachable':
    'We could not reach the sign-in service. Please try again in a moment — your guest progress is safe.',
};

function signInFailedBody(reason: string | undefined): string {
  return (
    (reason !== undefined ? SIGN_IN_FAILED_COPY[reason] : undefined) ??
    'Sign-in did not complete. Please try again — your guest progress is safe.'
  );
}

/** Pure projection into what the DOM shell renders. */
export function buildClaimViewModel(state: ClaimModelState): ClaimViewModel {
  let title = PENDING_TITLE;
  let body = PENDING_BODY;
  switch (state.phase) {
    case 'prompt':
      return {
        visible: true,
        title: PENDING_TITLE,
        body: PENDING_BODY,
        confirmPrompt: undefined,
        nudge: state.showFirstRunNudge ? NUDGE_COPY : undefined,
        feedback: state.feedback,
      };
    case 'awaiting-account':
      title = AWAITING_TITLE;
      body = AWAITING_BODY;
      break;
    case 'claimed':
      title = CLAIMED_TITLE;
      body = CLAIMED_BODY;
      break;
    case 'sign-in-failed':
      title = 'Sign-in did not finish';
      body = signInFailedBody(state.signInReason);
      break;
    case 'rejected': {
      const copy = REJECT_COPY[state.outcome ?? 'retain-not-claim-specific'];
      title = copy.title;
      body = copy.body;
      break;
    }
    default:
      break;
  }
  return {
    visible: state.phase !== 'hidden',
    title,
    body,
    confirmPrompt: state.confirmPending ? CONFIRM_PROMPT : undefined,
    nudge: state.showFirstRunNudge ? NUDGE_COPY : undefined,
    feedback: state.feedback,
  };
}
