// ui/privacyModel.ts — the PURE account-deletion / data-export decision core (M22 S8, ADR-0231).
//
// FUNCTIONAL CORE (ADR-0014). No DOM, no SDK, no store, no clock, no storage: `nowMs` and
// `graceMs` are INPUTS. The grace window's single source of truth is game-core, reached from the
// client through the `deletion_grace_ms_default()` wasm accessor (ADR-0212) — this module must
// never carry the number, and neither may its sibling spec: the SSOT eval scans all of `client/`
// for a numeric duplicate and does not exempt test files.
//
// The DOM shell that renders this, the `main.ts` wiring that calls the three reducers, and the
// wasm read itself all ship in m22-s8b. This module therefore emits notice CODES and the
// VERBATIM server message, never player-facing copy: spec §9's required pseudonymization language
// belongs to the slice that actually renders text, where it can be gated.
//
// PRV1-1 (request + grace countdown), PRV1-3 (cancel while the window is live), PRV1-4 (a
// distinct, permanently-rejected terminal state).

/**
 * Where an account sits on the deletion path.
 *
 * `unknown` is DARK — no row yet, or a status tag this client does not recognise. It is not a
 * synonym for `active`: the whole broke-vs-dark discipline (ADR-0154) turns on keeping "we do not
 * know" distinguishable from "we know it is fine".
 */
export type PrivacyPhase = 'unknown' | 'active' | 'grace' | 'due' | 'terminal';

/** Every field is an INPUT — that is what keeps this module clock-free and testable with no
 *  mocks. `nowMs`/`graceMs` are `bigint` at the seam; a non-bigint degrades, it never throws. */
export interface DeletionStatusInput {
  /** The bare `AccountStatus` tag as the store carries it, or `undefined` when there is no row. */
  readonly status: string | undefined;
  readonly deletionRequestedAtMs: bigint | undefined;
  readonly terminalAtMs: bigint | undefined;
  readonly nowMs: bigint;
  readonly graceMs: bigint;
}

export interface DeletionCountdown {
  readonly phase: PrivacyPhase;
  /** `requested + graceMs`, or `undefined` when the countdown is DARK. Never synthesized. */
  readonly deadlineAtMs: bigint | undefined;
  /** Clamped at `0n`; `undefined` when the countdown is DARK. */
  readonly remainingMs: bigint | undefined;
  readonly cancelPermitted: boolean;
  readonly cancelPermanentlyRejected: boolean;
  readonly deletePermitted: boolean;
  readonly exportPermitted: boolean;
}

/** The two status tags this client acts on. Any other tag reads as `unknown`, which is the
 *  forward-compatible answer: a tag added by a later milestone must not be silently treated as
 *  `Active`. */
const STATUS_ACTIVE = 'Active';
const STATUS_PENDING_DELETION = 'PendingDeletion';

/** Is the permanent-deletion marker present?
 *
 *  `terminalAtMs` is an `Option<i64>`, so `0n` is a PERFECTLY VALID marker value — a truthiness
 *  test (`if (terminalAtMs)`) inverts PRV1-4 on it and offers a cancel for an account that is
 *  already gone. The `null` arm mirrors the converter's own SDK-Option guard: a raw `null`
 *  reaching here would otherwise make EVERY account read as permanently deleted. */
function hasTerminalMarker(terminalAtMs: bigint | undefined): boolean {
  return terminalAtMs !== undefined && terminalAtMs !== null;
}

/**
 * Derive the phase, the countdown and the four permissions.
 *
 * TOTAL: never throws, for any input.
 *
 * THE PHASE NEVER DEPENDS ON THE CLOCK. It comes from the terminal marker and `status` alone;
 * `nowMs`/`graceMs` decide only `deadlineAtMs`/`remainingMs`. Degrading the NUMBER on a bad clock
 * is safe; degrading the PERMISSION is not — `nowMs` is `BigInt(Date.now())` at the call site, so
 * a wiring slip passing a raw `number` would otherwise put every `PendingDeletion` account into a
 * state that refuses a cancel the server accepts.
 */
export function deriveDeletionCountdown(input: DeletionStatusInput): DeletionCountdown {
  // The marker is checked BEFORE the status, mirroring `cancel_account_deletion`'s own guard-first
  // order (server-module/src/accounts.rs): on the illegal Active-plus-marker shape a status-first
  // read would launder an already-erased account back into a cancellable one. Returns early — a
  // deadline is meaningless once the erasure has happened.
  if (hasTerminalMarker(input.terminalAtMs)) {
    return {
      phase: 'terminal',
      deadlineAtMs: undefined,
      remainingMs: undefined,
      cancelPermitted: false,
      cancelPermanentlyRejected: true,
      deletePermitted: false,
      exportPermitted: false,
    };
  }

  if (input.status !== STATUS_PENDING_DELETION) {
    // `Active` and every dark/unrecognised tag. An account with no live deletion request has no
    // window to show, so the countdown stays dark even if a stale timestamp is still on the row.
    const active = input.status === STATUS_ACTIVE;
    return {
      phase: active ? 'active' : 'unknown',
      deadlineAtMs: undefined,
      remainingMs: undefined,
      cancelPermitted: false,
      cancelPermanentlyRejected: false,
      deletePermitted: active,
      // Mirrors `should_reject_for_deletion`'s negative: only pending-or-terminal is refused, so
      // a dark account may still ask. The server stays authoritative either way; this only avoids
      // a control that silently fails.
      exportPermitted: true,
    };
  }

  // PendingDeletion. The permissions below do NOT depend on anything computed after this point.
  const computable =
    typeof input.deletionRequestedAtMs === 'bigint' &&
    typeof input.nowMs === 'bigint' &&
    typeof input.graceMs === 'bigint';
  let deadlineAtMs: bigint | undefined;
  let remainingMs: bigint | undefined;
  if (computable) {
    const deadline = (input.deletionRequestedAtMs as bigint) + input.graceMs;
    deadlineAtMs = deadline;
    remainingMs = deadline > input.nowMs ? deadline - input.nowMs : 0n;
  }
  // A DARK countdown resolves to `grace`, never `due`: both are cancel-permitted, and `grace` is
  // the non-alarming one. `due` is only ever reached from a COMPUTED zero.
  return {
    phase: remainingMs !== undefined && remainingMs === 0n ? 'due' : 'grace',
    deadlineAtMs,
    remainingMs,
    // `due` IS permitted. The server's only cancel refusal is the terminal marker; the grace
    // deadline is not a cancel precondition anywhere, so a client-side pre-reject would invent a
    // second SSOT and cost the player their real window.
    cancelPermitted: true,
    cancelPermanentlyRejected: false,
    deletePermitted: false,
    exportPermitted: false,
  };
}

/** Is a delete confirmation armed? The first step of the two-step confirmation must write nothing
 *  and emit nothing (the repo's own irreversible-action rule). */
export type PrivacyConfirm = 'none' | 'delete-armed';

/** Which request is awaiting its result. `none` is the only value from which a new one may start. */
export type PrivacyRequest = 'none' | 'delete' | 'cancel' | 'export';

/**
 * What the shell should tell the player about, as a CODE — the copy lives in the view.
 *
 * `permanently-deleted` names PRV1-4's distinct, non-generic outcome. `request-rejected` carries
 * everything else, alongside the verbatim server message.
 */
export type PrivacyNotice = 'none' | 'disconnected' | 'permanently-deleted' | 'request-rejected';

export interface PrivacyModelState {
  /** Derived state, written ONLY by `account-changed`. Holding it here rather than passing it per
   *  event is what makes "an armed delete confirmation on an already-erased account"
   *  unrepresentable instead of merely guarded. */
  readonly countdown: DeletionCountdown;
  readonly confirm: PrivacyConfirm;
  readonly inFlight: PrivacyRequest;
  readonly notice: PrivacyNotice;
  /** The server's message, VERBATIM, for the shell to render. */
  readonly rejectMessage: string | undefined;
}

const INITIAL_COUNTDOWN: DeletionCountdown = deriveDeletionCountdown({
  status: undefined,
  deletionRequestedAtMs: undefined,
  terminalAtMs: undefined,
  nowMs: 0n,
  graceMs: 0n,
});

export const PRIVACY_INITIAL: PrivacyModelState = {
  countdown: INITIAL_COUNTDOWN,
  confirm: 'none',
  inFlight: 'none',
  notice: 'none',
  rejectMessage: undefined,
};

export type PrivacyEvent =
  | { readonly kind: 'account-changed'; readonly countdown: DeletionCountdown }
  | { readonly kind: 'delete-requested' }
  | { readonly kind: 'delete-confirmed'; readonly hasLiveConnection: boolean }
  | { readonly kind: 'confirm-cancelled' }
  | { readonly kind: 'cancel-deletion-requested'; readonly hasLiveConnection: boolean }
  | { readonly kind: 'export-requested'; readonly hasLiveConnection: boolean }
  | { readonly kind: 'request-succeeded'; readonly which: PrivacyRequest }
  | { readonly kind: 'request-failed'; readonly which: PrivacyRequest; readonly message: string };

export type PrivacyEffect =
  | 'none'
  | 'call-delete-account'
  | 'call-cancel-account-deletion'
  | 'call-request-data-export';

export interface PrivacyStep {
  readonly next: PrivacyModelState;
  readonly effect: PrivacyEffect;
}

/**
 * `REJECT_ALREADY_DELETED` (`server-module/src/accounts.rs`, a module-private const returned
 * VERBATIM by that module's `reject()` helper). Duplicated BY VALUE because the symbol is private
 * to the server module. That duplication is tolerable precisely because this is the SECOND route
 * to the terminal state: the account row's own `terminalAtMs` is the primary one, so a drift here
 * degrades a redundant backup, never the only signal.
 */
export const SERVER_ALREADY_DELETED_MESSAGE = 'this account has already been permanently deleted';

/** Does a reducer rejection name the permanent-deletion outcome?
 *
 *  `endsWith`, not `===`: the shell composes `` `${where}: ${message}` `` before this model ever
 *  sees the string, so an equality match would be dead at the real call site — while a bare
 *  `includes` would also fire on a message that merely QUOTES the sentence. */
function isAlreadyDeletedMessage(message: string): boolean {
  return typeof message === 'string' && message.endsWith(SERVER_ALREADY_DELETED_MESSAGE);
}

/** Start a request, or explain why it did not start. Shared by all three emitters so the
 *  double-submit guard is uniform — a guard applied to one of three is not a guard.
 *
 *  `confirmOnDelivery` is the confirmation state to write ON THE DELIVERED PATH ONLY — the name is
 *  the guard: there is no value for a caller to spend on a path that delivered nothing. */
function begin(
  state: PrivacyModelState,
  permitted: boolean,
  hasLiveConnection: boolean,
  which: PrivacyRequest,
  effect: PrivacyEffect,
  confirmOnDelivery: PrivacyConfirm,
): PrivacyStep {
  if (!permitted || state.inFlight !== 'none') {
    // A control that should not have been reachable. Nothing happened, so there is nothing to
    // tell the player — inventing a rejection here would claim the server refused when it was
    // never asked — and nothing is SPENT either: an armed confirmation survives a click that was
    // refused, exactly as it survives one that could not be delivered (the branch below).
    // Returning `state` itself, not a copy, is this module's shape for a true no-op — the same
    // shape the `'delete-requested'` arm below uses for a dark control.
    return { next: state, effect: 'none' };
  }
  if (!hasLiveConnection) {
    // Never silently dropped, and an armed confirmation stays ARMED so the player can retry the
    // exact click that could not be delivered.
    return { next: { ...state, notice: 'disconnected', rejectMessage: undefined }, effect: 'none' };
  }
  return {
    next: {
      ...state,
      confirm: confirmOnDelivery,
      inFlight: which,
      notice: 'none',
      rejectMessage: undefined,
    },
    effect,
  };
}

/**
 * Pure reducer. Total (never throws), never mutates its input, and takes exactly
 * `(state, event)` — no clock. It does NOT promise a fresh object on every step: the two paths
 * that exist to say "nothing happened" — a dark control (`'delete-requested'` while the delete is
 * not permitted) and a refused emitter (`begin`'s guard) — return the input state itself. So
 * `next === state` is a SUFFICIENT signal that nothing happened, never a necessary one.
 */
export function privacyStep(state: PrivacyModelState, event: PrivacyEvent): PrivacyStep {
  switch (event.kind) {
    case 'account-changed': {
      // The SOLE writer of `countdown`. Leaving `active` disarms any pending confirmation: an
      // armed delete on an account that is already pending or terminal is not a state this model
      // may hold.
      const stillActive = event.countdown.phase === 'active';
      return {
        next: {
          ...state,
          countdown: event.countdown,
          confirm: stillActive ? state.confirm : 'none',
          inFlight: 'none',
        },
        effect: 'none',
      };
    }
    case 'delete-requested':
      // Step one of the two-step confirmation: arm, and do nothing else.
      if (!state.countdown.deletePermitted) return { next: state, effect: 'none' };
      return { next: { ...state, confirm: 'delete-armed' }, effect: 'none' };
    case 'confirm-cancelled':
      return { next: { ...state, confirm: 'none' }, effect: 'none' };
    case 'delete-confirmed':
      return begin(
        state,
        state.confirm === 'delete-armed' && state.countdown.deletePermitted,
        event.hasLiveConnection,
        'delete',
        'call-delete-account',
        // Spent ON DELIVERY only. Every refusal `begin` can return — not permitted, another
        // request in flight, no live connection — leaves the confirmation ARMED, so the player
        // never loses step two to a click that did nothing.
        'none',
      );
    case 'cancel-deletion-requested': {
      if (state.countdown.cancelPermanentlyRejected) {
        // PRV1-4's distinct, non-generic outcome, reached from the ROW rather than from a
        // round trip — the player is told before a doomed call is even made.
        return {
          next: { ...state, notice: 'permanently-deleted', rejectMessage: undefined },
          effect: 'none',
        };
      }
      return begin(
        state,
        state.countdown.cancelPermitted,
        event.hasLiveConnection,
        'cancel',
        'call-cancel-account-deletion',
        state.confirm,
      );
    }
    case 'export-requested':
      return begin(
        state,
        state.countdown.exportPermitted,
        event.hasLiveConnection,
        'export',
        'call-request-data-export',
        state.confirm,
      );
    case 'request-succeeded':
      return {
        next: { ...state, inFlight: 'none', notice: 'none', rejectMessage: undefined },
        effect: 'none',
      };
    case 'request-failed': {
      // Keyed on the MESSAGE, never on `which` alone: a transient cancel failure must not tell a
      // player their account is permanently gone.
      const terminal = event.which === 'cancel' && isAlreadyDeletedMessage(event.message);
      return {
        next: {
          ...state,
          inFlight: 'none',
          notice: terminal ? 'permanently-deleted' : 'request-rejected',
          rejectMessage: event.message,
        },
        effect: 'none',
      };
    }
  }
}
