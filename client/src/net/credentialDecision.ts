// net/credentialDecision.ts — the PURE credential decision (ADR-0182 D13/D17, M21b-2).
//
// This module is deliberately importless and side-effect free: zero I/O, zero storage,
// zero SDK. It owns its own input alphabet (`RenewalOutcome`) so `oidc.ts` imports the
// type back (type-only) and `connection.ts` calls `decideConnectCredential` inside
// `attemptBuild`'s try. Because `connection.ts` is coverage-excluded (vite.config.ts:98),
// this is the ONE place the threshold boundary (`>` vs `>=`) is observable in a real
// behaviour test — see credentialDecision.test.ts (G16).

/**
 * The result of `oidc.renewOrExchange()`. `reason` on `exchange-failed` is ALREADY
 * mapped onto a static kebab-case string by `oidc.classifySignInReason` — this module
 * forwards it byte-for-byte and never re-classifies (AUTH-57 / G21).
 */
export type RenewalOutcome =
  | { readonly kind: 'ok'; readonly token: string }
  | { readonly kind: 'no-session' }
  | { readonly kind: 'exchange-failed'; readonly reason: string }
  | { readonly kind: 'transient-error' };

/**
 * The credential `build()` acts on. `retry`, `session-expired` and
 * `auth-service-unreachable` carry NO token — the UI decides "signed in" from the
 * my_account row alone (AUTH-51 / G29), so a terminal state must not smuggle a second
 * source of truth into main.ts.
 */
export type ConnectCredential =
  | { readonly kind: 'anon'; readonly token: string | undefined }
  | { readonly kind: 'account'; readonly token: string }
  | { readonly kind: 'retry' }
  | { readonly kind: 'sign-in-failed'; readonly reason: string }
  | { readonly kind: 'session-expired' }
  | { readonly kind: 'auth-service-unreachable' };

/**
 * How many CONSECUTIVE transient renewal errors a previously-authenticated tab absorbs
 * before it escalates to `auth-service-unreachable` and offers the continue-anonymously
 * affordance. 2, not 1 (one Better-Auth hiccup must not declare the service down), and
 * not large (the tab would retry invisibly forever). ADR-0182 D17.
 *
 * Deliberately NOT shared with authToken.ts's AUTH_REJECT_SUPPRESS_THRESHOLD — same value
 * today, independent tuning decision.
 */
export const AUTH_SERVICE_TRANSIENT_THRESHOLD = 2;

/**
 * Pure decision: given a renewal outcome and the tab's history, choose the credential
 * `build()` should act on. Total (never throws), returns a FRESH object, and does not
 * mutate `outcome`. `consecutiveTransientErrors` is already incremented by
 * `resolveCredential` before this call; the escalation is a ratchet (`>=`), not a window.
 */
export function decideConnectCredential(
  outcome: RenewalOutcome,
  everAuthenticated: boolean,
  consecutiveTransientErrors: number,
  anonToken: string | undefined,
): ConnectCredential {
  if (outcome.kind === 'ok') {
    return { kind: 'account', token: outcome.token };
  }
  if (outcome.kind === 'no-session') {
    return everAuthenticated ? { kind: 'session-expired' } : { kind: 'anon', token: anonToken };
  }
  if (outcome.kind === 'exchange-failed') {
    return { kind: 'sign-in-failed', reason: outcome.reason };
  }
  // transient-error
  if (consecutiveTransientErrors < AUTH_SERVICE_TRANSIENT_THRESHOLD) {
    return { kind: 'retry' };
  }
  return everAuthenticated
    ? { kind: 'auth-service-unreachable' }
    : { kind: 'sign-in-failed', reason: 'auth-service-unreachable' };
}
