// ui/sessionModel.ts — the PURE session-lifecycle decision core (ADR-0182 D17, M21b-2).
//
// AUTH-46/47/49/56/59. No DOM, no SDK, no clock, no storage — the whole point is that the
// continue-anonymously affordance can ONLY be reached by an explicit, confirmed action, and a
// model whose input alphabet carries no time cannot be driven by a timer (AUTH-49). The DOM
// shell (`sessionView.ts`) is coverage-excluded and binds this core to elements; it is driven
// directly by `conn.sessionState()` (registry-external, D17). `connection.ts` imports the
// `SessionState` type from here as the SSOT.

/** The three states the session terminal can be in. `hidden` is the ordinary case (nothing
 *  showing); `expired` and `unreachable` each own DISTINCT copy (AUTH-46/47). The `'hidden'`
 *  literal is a cross-file contract with main.ts's `conn?.sessionState() !== 'hidden'` gate. */
export type SessionState = 'hidden' | 'expired' | 'unreachable';

export interface SessionModelState {
  readonly state: SessionState;
  /** AUTH-56's second step is armed. */
  readonly confirmPending: boolean;
  /** AUTH-59's visible line (the ordinary disconnected feedback), or undefined. */
  readonly feedback: string | undefined;
}

export const SESSION_INITIAL: SessionModelState = {
  state: 'hidden',
  confirmPending: false,
  feedback: undefined,
};

/** The repo-wide disconnected line (AUTH-59). Pinned BY VALUE against careAction.ts / main.ts's
 *  own copy — exporting careAction.ts's module-private constant is outside this slice's touches. */
export const SESSION_DISCONNECTED_FEEDBACK = 'disconnected — try again';

export type SessionEventKind =
  | 'session-expired'
  | 'auth-service-unreachable'
  | 'connected'
  | 'continue-anonymously-requested'
  | 'continue-anonymously-confirmed'
  | 'confirm-cancelled'
  | 'retry-requested';

export const SESSION_EVENT_KINDS: readonly SessionEventKind[] = [
  'session-expired',
  'auth-service-unreachable',
  'connected',
  'continue-anonymously-requested',
  'continue-anonymously-confirmed',
  'confirm-cancelled',
  'retry-requested',
];

export type SessionEvent =
  | { readonly kind: 'session-expired' }
  | { readonly kind: 'auth-service-unreachable' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'continue-anonymously-requested' }
  | { readonly kind: 'continue-anonymously-confirmed'; readonly hasLiveConnection: boolean }
  | { readonly kind: 'confirm-cancelled' }
  | { readonly kind: 'retry-requested'; readonly hasLiveConnection: boolean };

export type SessionEffect = 'none' | 'continue-anonymously' | 'retry-connect';

export interface SessionStep {
  readonly next: SessionModelState;
  readonly effect: SessionEffect;
}

/** Pure reducer. Total (never throws), returns a FRESH state, never mutates its input. Takes
 *  exactly `(state, event)` — no clock argument, by design (AUTH-49). */
export function sessionStep(state: SessionModelState, event: SessionEvent): SessionStep {
  switch (event.kind) {
    case 'session-expired':
      return {
        next: { state: 'expired', confirmPending: false, feedback: undefined },
        effect: 'none',
      };
    case 'auth-service-unreachable':
      return {
        next: { state: 'unreachable', confirmPending: false, feedback: undefined },
        effect: 'none',
      };
    case 'connected':
      return { next: SESSION_INITIAL, effect: 'none' };
    case 'continue-anonymously-requested':
      // Arm the DISTINCT second step (AUTH-56) — only while a terminal is showing, and emit
      // nothing (the first step must never connect).
      if (state.state === 'hidden') return { next: state, effect: 'none' };
      return { next: { ...state, confirmPending: true }, effect: 'none' };
    case 'continue-anonymously-confirmed': {
      // The effect is emitted ONLY by a confirmed action on an armed, showing state with a live
      // connection to act on (AUTH-49). Anything else is inert or surfaces feedback (AUTH-59).
      if (state.state === 'hidden' || !state.confirmPending) return { next: state, effect: 'none' };
      if (!event.hasLiveConnection) {
        // AUTH-59: not silently dropped — the same disconnected line, and the confirmation stays
        // ARMED so the player can retry the exact click that could not be delivered.
        return { next: { ...state, feedback: SESSION_DISCONNECTED_FEEDBACK }, effect: 'none' };
      }
      // Spend the confirmation and clear any stale feedback; the overlay stays until `connected`.
      return {
        next: { state: state.state, confirmPending: false, feedback: undefined },
        effect: 'continue-anonymously',
      };
    }
    case 'confirm-cancelled':
      return { next: { ...state, confirmPending: false }, effect: 'none' };
    case 'retry-requested':
      if (!event.hasLiveConnection) {
        return { next: { ...state, feedback: SESSION_DISCONNECTED_FEEDBACK }, effect: 'none' };
      }
      return { next: { ...state, feedback: undefined }, effect: 'retry-connect' };
  }
}

export interface SessionViewModel {
  readonly visible: boolean;
  readonly title: string;
  readonly body: string;
  readonly primaryActionLabel: string;
  /** Present ONLY while confirmPending (AUTH-56's distinct second step). */
  readonly confirmPrompt: string | undefined;
  readonly feedback: string | undefined;
}

const EXPIRED_TITLE = 'Session expired';
const EXPIRED_BODY =
  'Your sign-in has expired. Sign in again to keep saving progress across your devices, or continue as a guest on this one.';
const UNREACHABLE_TITLE = 'Sign-in service unavailable';
const UNREACHABLE_BODY =
  'We could not reach the sign-in service. Your account is safe — the game keeps retrying in the background, or you can continue as a guest for now.';
const CONTINUE_LABEL = 'Continue as guest';
// AUTH-56: names the irreversible consequence. Longer than 20 chars, and the first step must not
// already carry it.
const CONFIRM_PROMPT =
  'Continuing as a guest gives up this account session on this tab and cannot be undone. Continue as a guest?';

/** Pure projection of the model state into what the DOM shell renders. */
export function buildSessionViewModel(state: SessionModelState): SessionViewModel {
  const visible = state.state !== 'hidden';
  const expired = state.state === 'expired';
  return {
    visible,
    title: expired ? EXPIRED_TITLE : UNREACHABLE_TITLE,
    body: expired ? EXPIRED_BODY : UNREACHABLE_BODY,
    primaryActionLabel: CONTINUE_LABEL,
    confirmPrompt: state.confirmPending ? CONFIRM_PROMPT : undefined,
    feedback: state.feedback,
  };
}
