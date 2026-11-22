// ui/claimModel.ts — the PURE guest-claim decision core, and the sign-in gate's (the screen a
// server that admits only players who own the game puts in front of play: `signInGateStep`,
// `buildSignInGateView`; the main menu frame shows it, ui/screens/mainMenuScreen.ts).
//
// AUTH-48/52/54/55/56/59. No DOM, no SDK, no storage, and NO CLOCK (AUTH-55 — enforced on the
// event alphabet AND by a source scan of this file). The one ambient read is the i18n locale cell
// (set once at boot) behind `t()`: every player-facing line is resolved at step/projection time,
// never at module load, which would freeze English. The storage half lives in net/claimCode.ts;
// this model receives the nudge flag as a boolean INPUT so it stays pure. The AUTHORITATIVE join
// veto is connection.ts's `.onApplied` (G18); this model is its UI-visible mirror.

import { t, tf } from './i18n/resolver';

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

export type InvalidCodeSense = 'claim-already-succeeded' | 'code-unusable';

/** The ONE client-side disambiguation of ERR_INVALID_CODE: if OUR OWN account row
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

/** Handle a join / retry-join action (identical behaviour, AUTH-52/59). The vetoed-join line is
 *  DISTINCT from the repo-wide disconnected one (`chrome.feedback.disconnected`, AUTH-59): the
 *  two causes must not share a line. */
function joinAction(base: ClaimModelState, hasLiveConnection: boolean): ClaimStep {
  if (!base.joinPermitted) {
    // AUTH-52's UI-visible half: the authoritative veto is connection.ts's, but a button that
    // silently does nothing teaches the player the client is broken.
    return { next: { ...base, feedback: t('claim.feedback.veto') }, effect: 'none' };
  }
  if (!hasLiveConnection) {
    return { next: { ...base, feedback: t('chrome.feedback.disconnected') }, effect: 'none' };
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
        // A consumed code: kept, it would re-issue complete_guest_claim on the next connect.
        effect: 'delete-code-and-permit-join',
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
          next: {
            ...state,
            showFirstRunNudge: false,
            feedback: t('chrome.feedback.disconnected'),
          },
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

/** Whether this build can start a sign-in, and under which provider's name. */
export type SignInOffer =
  | { readonly kind: 'none' }
  | { readonly kind: 'provider'; readonly name: string };

/** The offer for a build's OIDC issuer and provider name. `issuer` is the value `connect`
 *  receives: empty means the build has no issuer for this server, so nothing is offered. A build
 *  that names no provider shows the issuer string. Exact string tests: the OIDC flow is what
 *  refuses an issuer it cannot use. */
export function signInOffer(issuer: string, providerName: string): SignInOffer {
  if (issuer === '') return { kind: 'none' };
  return { kind: 'provider', name: providerName === '' ? issuer : providerName };
}

/** Which of the overlay's five action buttons the player can operate right now. */
export interface ClaimActions {
  readonly signIn: boolean;
  readonly join: boolean;
  readonly decline: boolean;
  readonly declineConfirm: boolean;
  readonly declineCancel: boolean;
}

export interface ClaimViewModel {
  readonly visible: boolean;
  readonly title: string;
  readonly body: string;
  readonly confirmPrompt: string | undefined;
  readonly nudge: string | undefined;
  readonly feedback: string | undefined;
  readonly actions: ClaimActions;
  /** The Sign In button's text; undefined when the build offers no sign-in. */
  readonly signInLabel: string | undefined;
}

/** The operable buttons. Sign in is offered only by a build with a provider, from the prompt and
 *  after a failed sign-in; decline whenever a claim can still be given up (the join veto is up);
 *  declining is two-step, so an armed decline offers ONLY confirm / cancel; join exactly when the
 *  veto is lifted. */
function claimActions(state: ClaimModelState, offer: SignInOffer): ClaimActions {
  if (state.phase === 'hidden') {
    return {
      signIn: false,
      join: false,
      decline: false,
      declineConfirm: false,
      declineCancel: false,
    };
  }
  const armed = state.confirmPending;
  return {
    signIn:
      offer.kind === 'provider' &&
      !armed &&
      !state.joinPermitted &&
      (state.phase === 'prompt' || state.phase === 'sign-in-failed'),
    join: !armed && state.joinPermitted,
    decline: !armed && !state.joinPermitted && state.phase !== 'claimed',
    declineConfirm: armed,
    declineCancel: armed,
  };
}

/** Copy for a refused claim, keyed on the outcome bucket. The fail-safe bucket, an absent
 *  outcome and — so the projection stays TOTAL — any value the type system did not admit all
 *  read as the generic refusal. One literal key per arm: a key computed from the outcome would
 *  be invisible to the catalog's call-site census. */
function rejectCopy(outcome: ClaimRejectOutcome | undefined): {
  readonly title: string;
  readonly body: string;
} {
  switch (outcome) {
    case 'delete-code-and-permit-join':
      return { title: t('claim.reject.unusable.title'), body: t('claim.reject.unusable.body') };
    case 'retain-destination-terminal':
      return {
        title: t('claim.reject.destination.title'),
        body: t('claim.reject.destination.body'),
      };
    case 'retain-transient-no-autoretry':
      return { title: t('claim.reject.transient.title'), body: t('claim.reject.transient.body') };
    default:
      return { title: t('claim.reject.generic.title'), body: t('claim.reject.generic.body') };
  }
}

/** Body for a failed sign-in, keyed on the reason main.ts reports. A `switch`, never a
 *  `Record[reason]` read: an unrecognised reason — including an `Object.prototype` name — falls
 *  to the fallback line instead of rendering a prototype member. */
function signInFailedBody(reason: string | undefined): string {
  switch (reason) {
    case 'sign-in-rejected':
      return t('claim.signInFailed.rejected');
    case 'sign-in-expired':
      return t('claim.signInFailed.expired');
    case 'sign-in-declined':
      return t('claim.signInFailed.declined');
    case 'auth-service-unreachable':
      return t('claim.signInFailed.unreachable');
    default:
      return t('claim.signInFailed.fallback');
  }
}

/** Pure projection into what the DOM shell renders. Title, body, confirm prompt, nudge and the
 *  Sign In label are resolved HERE, at projection time (a module-level `t()` would freeze the boot
 *  locale); `feedback` arrives already resolved from `claimStep`. With no offer the prompt says
 *  accounts are not available on this server, and no phase offers Sign In. */
export function buildClaimViewModel(state: ClaimModelState, offer: SignInOffer): ClaimViewModel {
  let title: string;
  let body: string;
  switch (state.phase) {
    case 'awaiting-account':
      title = t('claim.awaiting.title');
      body = t('claim.awaiting.body');
      break;
    case 'claimed':
      title = t('claim.claimed.title');
      body = t('claim.claimed.body');
      break;
    case 'sign-in-failed':
      title = t('claim.signInFailed.title');
      body = signInFailedBody(state.signInReason);
      break;
    case 'rejected': {
      const copy = rejectCopy(state.outcome);
      title = copy.title;
      body = copy.body;
      break;
    }
    case 'prompt':
      title = t('claim.pending.title');
      body = offer.kind === 'none' ? t('claim.prompt.noProvider') : t('claim.pending.body');
      break;
    default:
      title = t('claim.pending.title');
      body = t('claim.pending.body');
      break;
  }
  return {
    visible: state.phase !== 'hidden',
    title,
    body,
    confirmPrompt: state.confirmPending ? t('claim.decline.confirmPrompt') : undefined,
    nudge: state.showFirstRunNudge ? t('claim.nudge') : undefined,
    feedback: state.feedback,
    actions: claimActions(state, offer),
    signInLabel:
      offer.kind === 'provider'
        ? tf('claim.signInWithProvider', { provider: offer.name })
        : undefined,
  };
}

// --- the sign-in gate --------------------------------------------------------------------------
// A server that admits only players who own the game refuses `join_game` to everyone else. The
// gate is what such a player sees instead of the world: a sign-in offer, and after a refusal the
// not-owned message with the store row. net/connection.ts reports the two facts that raise it
// (a join it withheld, a join the server refused); main.ts feeds them here and shows the view.

/** Where the store row leads: the Steam store's front page. Joined from its parts, because this
 *  file's clock scan reads each line only up to a two-slash token and so allows none in live code. */
export const OWNERSHIP_STORE_URL = ['https:', '', 'store.steampowered.com', ''].join('/');

export type SignInGatePhase = 'hidden' | 'sign-in' | 'not-owned';

export interface SignInGateState {
  readonly phase: SignInGatePhase;
  /** Why the last sign-in attempt failed, until the player has joined. */
  readonly failure: string | undefined;
}

export const SIGN_IN_GATE_INITIAL: SignInGateState = { phase: 'hidden', failure: undefined };

export type SignInGateEvent =
  /** The connection withheld its join: the server admits no player without an account. */
  | { readonly kind: 'account-required' }
  /** `join_game` answered the ownership error. */
  | { readonly kind: 'ownership-refused' }
  | { readonly kind: 'sign-in-failed'; readonly reason: string }
  /** The own player row arrived. */
  | { readonly kind: 'joined' };

/** Pure reducer. Total, and always a fresh state. A refusal is never downgraded: once the
 *  not-owned screen is up, a later withheld join (a reconnect) keeps it. A failed sign-in is
 *  recorded in every phase, `hidden` included, so a gate raised after it can say so. */
export function signInGateStep(state: SignInGateState, event: SignInGateEvent): SignInGateState {
  switch (event.kind) {
    case 'account-required':
      return { phase: state.phase === 'hidden' ? 'sign-in' : state.phase, failure: state.failure };
    case 'ownership-refused':
      return { phase: 'not-owned', failure: state.failure };
    case 'sign-in-failed':
      return { phase: state.phase, failure: event.reason };
    case 'joined':
      return { phase: 'hidden', failure: undefined };
  }
}

/** The not-owned message on its own: the status line of a target that shows no gate (a
 *  single-player world, a friends server, a build with no sign-in to offer). */
export const notOwnedLine = (): string => t('claim.gate.notOwned.title');

export interface SignInGateRow {
  readonly key: 'signIn' | 'store';
  readonly label: string;
  readonly description: string;
}

export interface SignInGateView {
  readonly title: string;
  /** The standing line: why the screen is up, or why the last sign-in failed. */
  readonly line: { readonly kind: 'info' | 'error'; readonly text: string };
  /** `signIn` first; `store` only in the not-owned phase. */
  readonly rows: readonly SignInGateRow[];
  /** What B answers: the screen stays until the player signs in. */
  readonly stays: string;
}

/** Pure projection of the gate, every string resolved here. `undefined` while the gate is hidden,
 *  and for a build that offers no sign-in: with nothing to offer there is no screen to show. */
export function buildSignInGateView(
  state: SignInGateState,
  offer: SignInOffer,
): SignInGateView | undefined {
  if (state.phase === 'hidden' || offer.kind === 'none') return undefined;
  const notOwned = state.phase === 'not-owned';
  const signIn: SignInGateRow = {
    key: 'signIn',
    label: tf('claim.signInWithProvider', { provider: offer.name }),
    description: t('claim.gate.signIn.desc'),
  };
  const store: SignInGateRow = {
    key: 'store',
    label: t('claim.gate.store.title'),
    description: t('claim.gate.store.desc'),
  };
  let line: SignInGateView['line'];
  if (state.failure !== undefined) {
    line = { kind: 'error', text: signInFailedBody(state.failure) };
  } else if (notOwned) {
    line = { kind: 'error', text: t('claim.gate.notOwned.body') };
  } else {
    line = { kind: 'info', text: t('claim.gate.signIn.body') };
  }
  return {
    title: notOwned ? t('claim.gate.notOwned.title') : t('claim.gate.signIn.title'),
    line,
    rows: notOwned ? [signIn, store] : [signIn],
    stays: t('claim.gate.stays'),
  };
}
