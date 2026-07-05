// prediction/reconnectPolicy.ts — the pure app-level reconnect state machine
// (M13.5b, ADR-0085 D3).
//
// WHAT: backoff delays + a flat link/attempt state with four transitions, feeding
// connection.ts's rebuild-with-backoff loop and main.ts's input freeze.
// WHY IT EXISTS: the SDK does NOT auto-reconnect on the raw builder path (its
// ConnectionManager backoff layer is not root-exported — ADR-0085 SDK evidence),
// so the app owns the retry policy. This module is PURE (no Date, no setTimeout,
// no DOM): the caller (connection.ts) owns all timers, keeping the policy
// unit/property-testable node-only.

/**
 * Base retry delay (attempt 0). WHY 1000: mirrors the SDK ConnectionManager's own
 * constant (`min(1000·2^attempt, 30_000)`) so app-level behavior matches what the
 * framework-integration layer would have done (ADR-0085 D3).
 */
export const RECONNECT_BASE_DELAY_MS = 1000;

/**
 * Delay cap. WHY 30_000: prevents a reconnect storm while keeping attempts
 * UNBOUNDED — a game client keeps trying; there is no terminal give-up state
 * (YAGNI, recorded in ADR-0085).
 */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Exponential backoff: `min(BASE · 2**attempt, MAX)`.
 *
 * WHY `2 ** attempt` and NOT a bitshift: `1 << 31` overflows to a negative i32 and
 * `1 << 1024` wraps to 0; `2 ** 1024` is `Infinity`, which `min` caps safely to MAX
 * (ADR-0085 C5). A negative `attempt` is defensively clamped to 0 — the state
 * machine never produces one, but the function stays TOTAL.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_DELAY_MS);
}

/**
 * The link's lifecycle position. WHY three states (not a boolean): 'reconnecting'
 * distinguishes an in-flight build() attempt from the idle waiting-for-timer gap,
 * so onReconnectAttempt/onAttemptFailed can be no-ops in the right places.
 */
export type LinkState = 'connected' | 'disconnected' | 'reconnecting';

/**
 * Flat policy state (ADR-0085 S1/S3): `attempt` is NOT nested inside a tagged
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
 * starts frozen until the first onConnect — sends against a not-yet-open link
 * would be silently queued on the socket and never settle (ADR-0085 evidence).
 */
export function initialReconnectState(): ReconnectState {
  return { link: 'disconnected', attempt: 0 };
}

/**
 * A rebuild attempt is starting (the reconnect timer fired and build() is being
 * called). No-op when already connected — a stale timer must not regress a live
 * link. Does NOT touch `attempt`: attempts count FAILURES (onAttemptFailed), not
 * tries, so the delay ladder only climbs on actual failure.
 */
export function onReconnectAttempt(s: ReconnectState): ReconnectState {
  if (s.link === 'connected') return s;
  return { link: 'reconnecting', attempt: s.attempt };
}

/**
 * The link came up (onConnect/onApplied). WHY attempt resets HERE and ONLY here:
 * a successful connection is the only evidence the backoff ladder should restart
 * from the base delay; resetting anywhere else would defeat the backoff.
 */
export function onConnected(_s: ReconnectState): ReconnectState {
  return { link: 'connected', attempt: 0 };
}

/**
 * The link dropped (onDisconnect). Preserves `attempt` (only onConnected resets
 * it). IDEMPOTENT: on an already-down link it returns `s` UNCHANGED — the SDK
 * fires onerror-then-onclose as a double event on some drop paths, and the second
 * event must not double-transition or double-schedule (ADR-0085 A7).
 */
export function onDisconnected(s: ReconnectState): ReconnectState {
  if (s.link !== 'connected') return s;
  return { link: 'disconnected', attempt: s.attempt };
}

/**
 * A rebuild attempt failed (onConnectError). Increments `attempt` — this is the
 * ONLY place the ladder climbs — and returns to 'disconnected' to await the next
 * scheduled attempt. No-op when connected: a stale error from a superseded build
 * must not penalize a live link.
 */
export function onAttemptFailed(s: ReconnectState): ReconnectState {
  if (s.link === 'connected') return s;
  return { link: 'disconnected', attempt: s.attempt + 1 };
}

/**
 * Whether input/sends must be gated off. DEFINITIONAL, never stored:
 * `linkFrozen(s) ≡ s.link !== 'connected'` (ADR-0085 S1). WHY event-driven (from
 * link state) and never promise-driven: in-flight reducer promises NEVER settle
 * after a drop (the SDK settles callbacks only on message receipt), so a
 * promise-based freeze would simply never fire.
 */
export function linkFrozen(s: ReconnectState): boolean {
  return s.link !== 'connected';
}
