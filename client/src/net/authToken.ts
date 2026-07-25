// net/authToken.ts — the reconnect-credential gate (nh4, ADR-0150).
//
// PURE-ish core for the one decision `connection.ts` must not make inline: which auth
// token (if any) to hand `DbConnection.builder().withToken(...)` on the NEXT build, and
// how to react when the host rejects the one we supplied. The storage HOST is injected
// (never a `globalThis` reach from inside), so every branch — including the ones that can
// only be reached when the browser throws on the storage property access itself — is
// unit-testable in a node environment with no DOM.
//
// WHY THIS MODULE EXISTS AT ALL: `connection.ts` is coverage-EXCLUDED (client/vite.config.ts,
// exact-set-guarded by the dom-shell-coverage-exclusion eval), so logic living there is
// provable only by source-scan — which can pin wiring but never behavior. Keeping the state
// machine here is what makes "the classifier was quietly changed to `return true`" a caught
// bug rather than an invisible one.
//
// SUPPRESS, NEVER CLEAR (ADR-0150 D2). The SDK throws the SAME message
// (`Failed to verify token: <statusText>`, dist/index.mjs:5057-5063) for a transient
// 500/502/503 from the token-verify endpoint as for a genuine 401 — and HTTP/2 mandates an
// empty `statusText`, collapsing every case to one string. So we never delete a stored
// token: once AUTH_REJECT_SUPPRESS_THRESHOLD rejections have accrued SINCE THE LAST SUCCESS
// we merely WITHHOLD it. If the resulting anonymous attempt succeeds, the host is up and
// really did reject us, and `onConnected` overwrites the dead token with the new one — a
// successful connect is the only oracle available for "the host is up and refused US".
// A non-auth failure (an unreachable or flaky host) never advances the counter at all, so
// an outage can never cost the player their identity.

/**
 * Credential rejections tolerated since the last successful connect before the stored token
 * is withheld. WHY 2 and not 1: one transient non-2xx from the verify endpoint is
 * indistinguishable from a real rejection (see the header), so a threshold of 1 would swap
 * the player's identity on a single server hiccup. WHY not higher: a genuinely dead token
 * repeats deterministically, so each extra rung only delays recovery — at 2 the host-reset
 * loop terminates after the 1 s + 2 s backoff rungs (ADR-0085 ladder), about 3 s.
 */
export const AUTH_REJECT_SUPPRESS_THRESHOLD = 2;

/**
 * The exact prefix the SDK throws when the host refuses a supplied token
 * (`openWebSocket`, spacetimedb/dist/index.mjs:5062). The trailing `': '` is load-bearing:
 * without it, an unrelated message such as `'Failed to verify tokens for the batch'` would
 * classify as a credential rejection. Pinned against SDK drift by the SDK-DRIFT tooth in
 * connection.test.ts — same exact-string-contract discipline connection.ts already applies
 * to the `'already joined'` reducer error.
 */
const CREDENTIAL_REJECTED_PREFIX = 'Failed to verify token: ';

/** Storage-key namespace. `v1` so a future format change invalidates cleanly instead of
 *  being misread as a valid-but-garbage credential. */
const KEY_PREFIX = 'mr.authToken.v1';

/** An object that MAY expose `sessionStorage`. `globalThis` satisfies it structurally.
 *  Typed `unknown` rather than `Storage` on purpose: parse-don't-validate happens below,
 *  because the property access itself can throw and the value can be any shape. */
export interface TokenStorageHost {
  readonly sessionStorage?: unknown;
}

export interface AuthTokenGate {
  /** The token to hand `.withToken()` for the NEXT build; `undefined` = connect
   *  anonymously. MUST be called fresh per build — a cached value would make suppression
   *  inert and a host-reset reconnect loop permanent (ADR-0150 D2). */
  tokenForNextAttempt(): string | undefined;
  /** A build connected: persist this connection's token and reset the rejection state. */
  onConnected(token: string): void;
  /** A build failed: a credential rejection advances the suppression counter; any other
   *  failure is ignored (only a successful connect resets it). */
  onConnectFailed(err: unknown): void;
}

/**
 * True iff `err` is the SDK's token-verification rejection.
 *
 * TOTAL over `unknown` by construction — the SDK's `ws.onerror` path emits a DOM `Event`,
 * not an `Error` (dist/index.mjs:5829-5831), so `connection.ts`'s `err: Error` annotation is
 * a lie on that path. An unguarded `err.message.startsWith(...)` would throw a TypeError
 * inside `onConnectError` and take the whole reconnect ladder down with it.
 */
export function isStoredCredentialRejected(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  try {
    // The READ itself can throw — a throwing accessor or a Proxy `get` trap. Without this
    // catch the throw escapes through `onConnectFailed` into `.onConnectError`, where it
    // would skip `scheduleRebuild()` and silently strand the client with no timer and no
    // further attempts: a permanent, invisible freeze (red-team finding, ADR-0150 D5).
    const { message } = err as { message?: unknown };
    return typeof message === 'string' && message.startsWith(CREDENTIAL_REJECTED_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Per-target storage key. Two axes because `uri` is the token's VALIDITY domain (the JWT is
 * verified host-level, so a token minted by one host is refused by another) and `db` its
 * USEFULNESS domain (state is per-database). Each segment is percent-encoded so a `|` inside
 * a value cannot collide two distinct targets onto one key — `encodeURIComponent` escapes
 * `|`, which makes the derivation injective. Case is PRESERVED: connectionConfig.ts
 * deliberately treats `Monster-Realm-Playtest` as a legitimately distinct database.
 */
function storageKey(uri: string, db: string): string {
  return `${KEY_PREFIX}|${encodeURIComponent(uri)}|${encodeURIComponent(db)}`;
}

/** Narrow an unknown storage-ish value to the one method we are about to call. Returns
 *  undefined rather than throwing so every caller degrades silently. */
function storageMethod(host: TokenStorageHost | undefined, name: 'getItem' | 'setItem') {
  try {
    // The PROPERTY ACCESS itself can throw SecurityError when cookies/site data are
    // blocked — this is exactly why the HOST is injected instead of a resolved storage
    // object: the throwing read has to sit inside this try/catch to be testable.
    const storage = host?.sessionStorage as Record<string, unknown> | undefined | null;
    if (typeof storage !== 'object' || storage === null) return undefined;
    const fn = storage[name];
    return typeof fn === 'function'
      ? (fn as (...args: string[]) => unknown).bind(storage)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the per-connection-target credential gate.
 *
 * `host` is the object that may expose `sessionStorage` — per-TAB storage, deliberately not
 * `localStorage` (ADR-0150 D3): the server's `on_disconnect` keys purely on identity with no
 * live-connection check, so two tabs sharing one identity would let closing either one
 * forfeit the other's PvP battle and delete its character row. Per-tab storage keeps a second
 * tab behaving exactly as it does today — an independent identity — while still surviving
 * the page reload nh4 exists to fix.
 */
export function createAuthTokenGate(
  uri: string,
  db: string,
  host: TokenStorageHost | undefined,
): AuthTokenGate {
  const key = storageKey(uri, db);
  let rejectionsSinceSuccess = 0;

  return {
    tokenForNextAttempt(): string | undefined {
      if (rejectionsSinceSuccess >= AUTH_REJECT_SUPPRESS_THRESHOLD) return undefined;
      const getItem = storageMethod(host, 'getItem');
      if (getItem === undefined) return undefined;
      try {
        const raw = getItem(key);
        // Parse-don't-validate: only a non-blank string is a credential. Handing `''` to
        // `.withToken()` would make the SDK attempt a verify with an empty bearer token —
        // a guaranteed, permanently self-repeating auth failure.
        if (typeof raw !== 'string' || raw.trim() === '') return undefined;
        return raw;
      } catch {
        return undefined;
      }
    },

    onConnected(token: string): void {
      // Unconditional write: the connection that just succeeded is authoritative about which
      // credential is live. A "write only if empty" variant would strand a dead token forever
      // after the suppressed anonymous reconnect mints a new identity.
      rejectionsSinceSuccess = 0;
      const setItem = storageMethod(host, 'setItem');
      if (setItem === undefined) return;
      try {
        setItem(key, token);
      } catch {
        // Quota/private-mode failures degrade silently — the live connection is unaffected,
        // only the resume-on-reload guarantee is lost.
      }
    },

    onConnectFailed(err: unknown): void {
      // Count rejections SINCE THE LAST SUCCESS, and reset ONLY on success (in onConnected).
      // A non-auth failure is ignored rather than resetting the counter: resetting made the
      // threshold defeatable by ALTERNATION — a host whose failures interleave
      // rejection/network-error (a load balancer with only some replicas rotated, or a flaky
      // link failing the verify fetch outright) would oscillate 0→1→0→1 forever, never
      // suppress, and re-supply a dead token indefinitely (red-team finding, ADR-0150 D2).
      // Counting since-last-success is strictly stronger AND still safe for the case the
      // reset was protecting: a pure network outage produces no classified rejections at
      // all, so the counter never advances and the stored token is never withheld.
      if (isStoredCredentialRejected(err)) rejectionsSinceSuccess += 1;
    },
  };
}
