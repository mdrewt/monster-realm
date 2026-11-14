// prediction/reconnectPolicy.ts — the pure app-level reconnect state machine.
//
// WHAT: backoff delays + a flat link/attempt state with four transitions, feeding
// connection.ts's rebuild-with-backoff loop and main.ts's input freeze.
// WHY IT EXISTS: the SDK does NOT auto-reconnect on the raw builder path (its
// ConnectionManager backoff layer is not root-exported),
// so the app owns the retry policy. This module is PURE (no Date, no setTimeout,
// no DOM): the caller (connection.ts) owns all timers, keeping the policy
// unit/property-testable node-only.

/**
 * Base retry delay (attempt 0). WHY 1000: mirrors the SDK ConnectionManager's own
 * constant (`min(1000·2^attempt, 30_000)`) so app-level behavior matches what the
 * framework-integration layer would have done.
 */
export const RECONNECT_BASE_DELAY_MS = 1000;

/**
 * Delay cap. WHY 30_000: prevents a reconnect storm while keeping attempts
 * UNBOUNDED — a game client keeps trying; there is no terminal give-up state
 * (YAGNI).
 */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Exponential backoff: `min(BASE · 2**attempt, MAX)`.
 *
 * WHY `2 ** attempt` and NOT a bitshift: `1 << 31` overflows to a negative i32 and
 * `1 << 1024` wraps to 0; `2 ** 1024` is `Infinity`, which `min` caps safely to MAX
 * A negative `attempt` is defensively clamped to 0 — the state
 * machine never produces one, but the function stays TOTAL.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_DELAY_MS);
}

/**
 * The link's lifecycle position. WHY three states (not a boolean): 'reconnecting'
 * is an attempt that has started and not yet failed; 'disconnected' is the gap
 * after a failure or a connected drop, waiting for the next attempt. Telling the
 * two apart is what makes one attempt climb exactly one rung of the ladder,
 * however many events report its failure.
 */
export type LinkState = 'connected' | 'disconnected' | 'reconnecting';

/**
 * Flat policy state: `attempt` is NOT nested inside a tagged
 * union — every transition reads/writes the same two fields, and the input freeze
 * is DERIVED from `link` (see `linkFrozen`), never stored as a third field that
 * could drift.
 */
export interface ReconnectState {
  readonly link: LinkState;
  readonly attempt: number;
}

/**
 * The pre-connection state. WHY 'disconnected' (not 'connected'): the client
 * starts frozen until the first applied subscription — sends against a
 * not-yet-open link would be silently queued on the socket and never settle.
 */
export function initialReconnectState(): ReconnectState {
  return { link: 'disconnected', attempt: 0 };
}

/**
 * A connection attempt is starting, on any build path (the reconnect timer, the
 * first boot, a user retry). No-op when already connected — a stale timer must
 * not regress a live link. Does NOT touch `attempt`: attempts count FAILURES
 * (onAttemptFailed), not tries, so the delay ladder only climbs on actual failure.
 */
export function onReconnectAttempt(s: ReconnectState): ReconnectState {
  if (s.link === 'connected') return s;
  return { link: 'reconnecting', attempt: s.attempt };
}

/**
 * The link came up (the first applied subscription). WHY attempt resets HERE and ONLY here:
 * a successful connection is the only evidence the backoff ladder should restart
 * from the base delay; resetting anywhere else would defeat the backoff.
 */
export function onConnected(_s: ReconnectState): ReconnectState {
  return { link: 'connected', attempt: 0 };
}

/**
 * The link dropped (onDisconnect). A connected link goes 'disconnected' and keeps
 * `attempt` (only onConnected resets it). A 'reconnecting' link is an attempt
 * whose socket opened and closed before its first applied subscription: that
 * attempt failed, so the drop is onAttemptFailed. A 'disconnected' link is
 * returned UNCHANGED — the SDK fires onerror-then-onclose as a double event on
 * some drop paths, and the second event must not transition or climb again.
 */
export function onDisconnected(s: ReconnectState): ReconnectState {
  if (s.link === 'connected') return { link: 'disconnected', attempt: s.attempt };
  return onAttemptFailed(s);
}

/**
 * The attempt in flight failed: a connect error, a credential or build failure,
 * or (through onDisconnected) a drop before the first applied subscription.
 * Climbs ONE rung — this is the only place the ladder climbs — and returns to
 * 'disconnected' to await the next scheduled attempt. Only a 'reconnecting' link
 * climbs: on 'disconnected' the attempt has already failed, so a second event
 * reporting the same failure changes nothing; on 'connected' a stale error from
 * a superseded build must not penalize a live link.
 */
export function onAttemptFailed(s: ReconnectState): ReconnectState {
  if (s.link !== 'reconnecting') return s;
  return { link: 'disconnected', attempt: s.attempt + 1 };
}

/**
 * Whether input/sends must be gated off. DEFINITIONAL, never stored:
 * `linkFrozen(s) ≡ s.link !== 'connected'`. WHY event-driven (from
 * link state) and never promise-driven: in-flight reducer promises NEVER settle
 * after a drop (the SDK settles callbacks only on message receipt), so a
 * promise-based freeze would simply never fire.
 */
export function linkFrozen(s: ReconnectState): boolean {
  return s.link !== 'connected';
}
