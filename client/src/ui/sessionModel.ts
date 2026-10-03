// ui/sessionModel.ts — the PURE session-lifecycle decision core.
//
// AUTH-49/56/59. No DOM, no SDK, no clock, no storage — the whole point is that the
// continue-anonymously affordance can ONLY be reached by an explicit, confirmed action, and a
// model whose input alphabet carries no time cannot be driven by a timer (AUTH-49). The one
// ambient read is the i18n locale cell (set once at boot) behind `t()`: every player-facing line
// is resolved at step/projection time, never at module load, which would freeze English. The DOM
// shell (`sessionView.ts`) is coverage-excluded and binds this core to elements; it is driven
// directly by `conn.sessionState()` (registry-external, D17). `connection.ts` imports the
// `SessionState` type from here as the SSOT.

import { t } from './i18n/resolver';

/** The three states the session terminal can be in. `hidden` is the ordinary case (nothing
 *  showing); `expired` and `unreachable` each own DISTINCT copy. The `'hidden'`
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
        return { next: { ...state, feedback: t('chrome.feedback.disconnected') }, effect: 'none' };
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
        return { next: { ...state, feedback: t('chrome.feedback.disconnected') }, effect: 'none' };
      }
      return { next: { ...state, feedback: undefined }, effect: 'retry-connect' };
  }
}

export interface SessionViewModel {
  readonly visible: boolean;
  readonly title: string;
  readonly body: string;
  /** The Continue-as-guest label. Not the default action: Retry is (CTL8K.1). */
  readonly primaryActionLabel: string;
  /** The default action, focused when the gate opens (CTL8K.1). */
  readonly retryLabel: string;
  /** The second step's options; No is the default (CTL8K.1). */
  readonly confirmYesLabel: string;
  readonly confirmNoLabel: string;
  /** Says B and Start are inert under the gate (CTL8K.1). */
  readonly hint: string;
  /** Present ONLY while confirmPending (AUTH-56's distinct second step). */
  readonly confirmPrompt: string | undefined;
  readonly feedback: string | undefined;
}

/** Pure projection of the model state into what the DOM shell renders. */
export function buildSessionViewModel(state: SessionModelState): SessionViewModel {
  const visible = state.state !== 'hidden';
  const expired = state.state === 'expired';
  return {
    visible,
    title: expired ? t('chrome.session.expired.title') : t('chrome.session.unreachable.title'),
    body: expired ? t('chrome.session.expired.body') : t('chrome.session.unreachable.body'),
    primaryActionLabel: t('chrome.session.continue'),
    retryLabel: t('session.retry'),
    confirmYesLabel: t('prompt.yes'),
    confirmNoLabel: t('prompt.no'),
    hint: t('session.hint'),
    // AUTH-56: names the irreversible consequence. Longer than 20 chars, and the first step must
    // not already carry it.
    confirmPrompt: state.confirmPending ? t('chrome.session.confirmPrompt') : undefined,
    feedback: state.feedback,
  };
}
