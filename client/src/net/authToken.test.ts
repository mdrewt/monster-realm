// net/authToken.test.ts — RED tests for nh4-1..nh4-4: stored-credential auth-token gate.
//
// SOURCE OF TRUTH: nh4 EARS criteria — persistence (nh4-1), key scoping (nh4-2/nh4-3),
// the "Failed to verify token: " rejection classifier, the consecutive-rejection
// suppression state machine (nh4-3/nh4-4), and the playtest-wipe-does-NOT-invalidate-
// the-token corrected semantics (nh4-4).
//
// This is a PURE unit test over an INJECTED fake `TokenStorageHost` — it never touches
// a real `sessionStorage` / DOM. The gate's storage side effects (SecurityError when a
// browser blocks cookies/storage, QuotaExceededError in Safari private mode, a stale
// non-string value left by a prior schema) are exactly the kind of environment-dependent
// failure that must degrade SILENTLY so a storage quirk can never break the connection —
// a fake host lets every one of those edges be forced deterministically, which a real
// DOM/jsdom environment cannot do on demand.
//
// RED REASON: `authToken.ts` does not exist yet. Every import below fails with
// "does not provide an export named ..." until the implementer creates
// `client/src/net/authToken.ts` exporting the contract below.
//
// NOTE: no `new RegExp(...)` anywhere (Semgrep-banned repo-wide) — the classifier's
// prefix check is asserted here via literal string construction only.

import { describe, expect, it } from 'vitest';
import {
  AUTH_REJECT_SUPPRESS_THRESHOLD,
  createAuthTokenGate,
  isStoredCredentialRejected,
  type TokenStorageHost,
} from './authToken';

// ---------------------------------------------------------------------------
// Fake storage host — deterministic in-memory stand-in for `Window.sessionStorage`.
// ---------------------------------------------------------------------------

interface StorageCall {
  readonly op: 'getItem' | 'setItem';
  readonly key: string;
  readonly value?: string;
}

class FakeSessionStorage {
  private readonly store = new Map<string, string>();
  readonly calls: StorageCall[] = [];

  getItem(key: string): string | null {
    this.calls.push({ op: 'getItem', key });
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.calls.push({ op: 'setItem', key, value });
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  get size(): number {
    return this.store.size;
  }
}

/** A `sessionStorage.setItem` that always throws — Safari private-mode QuotaExceededError. */
class ThrowingSetStorage {
  getItem(): string | null {
    return null;
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
}

/** A `sessionStorage.getItem` that always throws — corrupted/hostile storage backend. */
class ThrowingGetStorage {
  getItem(): string {
    throw new Error('boom');
  }
  setItem(): void {}
}

function hostWithStorage(sessionStorage: unknown): TokenStorageHost {
  return { sessionStorage };
}

/** A minimal fake `sessionStorage` whose `getItem` returns a fixed raw value verbatim. */
function storageReturning(raw: unknown): TokenStorageHost {
  return {
    sessionStorage: {
      getItem: () => raw,
      setItem: () => {},
    },
  };
}

const AUTH_ERR = new Error('Failed to verify token: Unauthorized');

// ---------------------------------------------------------------------------
// Threshold VALUE — every other test in this file derives its loop count from the
// imported constant, so only THIS test hardcodes the number the spec actually mandates.
// ---------------------------------------------------------------------------

describe('AUTH_REJECT_SUPPRESS_THRESHOLD', () => {
  it('is exactly 2 (kills an exported 1, which would swap the player identity on a single transient 5xx, and kills a large value, which would outlive the ~3s ADR-0085 1s+2s backoff window)', () => {
    // WRONG IMPL KILLED: every OTHER test in this file derives its loop count from
    // `AUTH_REJECT_SUPPRESS_THRESHOLD` itself (`AUTH_REJECT_SUPPRESS_THRESHOLD - 1`,
    // `for (i = 0; i < AUTH_REJECT_SUPPRESS_THRESHOLD; ...)`), so an implementation
    // exporting 1 or 50 passes all 26 other tests in this suite. This is the ONLY
    // hardcoded pin of the value.
    //
    // WHY 2, not 1: the SDK throws the SAME "Failed to verify token: " message for a
    // transient 500/502/503 gateway error as for a genuine 401 (see the SDK-DRIFT
    // gate in connection.test.ts) — suppressing on a single rejection would swap the
    // player's identity on a mere gateway blip, not just a real credential rejection.
    // WHY 2, not large: the suppression window is meant to resolve inside the
    // existing ADR-0085 backoff ladder's first couple of rungs (1s + 2s ≈ 3s); a
    // threshold stretched far past that lets the client sit in an unrecoverable
    // reconnect loop long after a human would notice something is wrong.
    expect(AUTH_REJECT_SUPPRESS_THRESHOLD).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Persistence (nh4-1)
// ---------------------------------------------------------------------------

describe('createAuthTokenGate: persistence', () => {
  it('onConnected writes the token under a key containing mr.authToken.v1 (kills a no-op onConnected)', () => {
    const storage = new FakeSessionStorage();
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(storage));
    gate.onConnected('tok-A');
    const setCall = storage.calls.find((c) => c.op === 'setItem');
    expect(setCall).toBeDefined();
    expect(setCall?.key.indexOf('mr.authToken.v1')).toBeGreaterThanOrEqual(0);
    expect(setCall?.value).toBe('tok-A');
  });

  it('round-trip: onConnected then tokenForNextAttempt returns the same token (kills an always-undefined read)', () => {
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new FakeSessionStorage()));
    gate.onConnected('tok-A');
    expect(gate.tokenForNextAttempt()).toBe('tok-A');
  });

  it('a second onConnected replaces the stored token (kills a write-only-if-empty impl that strands a dead token)', () => {
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new FakeSessionStorage()));
    gate.onConnected('tok-A');
    gate.onConnected('tok-B');
    expect(gate.tokenForNextAttempt()).toBe('tok-B');
  });

  it('an empty store returns undefined from tokenForNextAttempt (kills a hardcoded return)', () => {
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new FakeSessionStorage()));
    expect(gate.tokenForNextAttempt()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Supply + key scoping (nh4-2 / nh4-3)
// ---------------------------------------------------------------------------

describe('createAuthTokenGate: key scoping by uri + db', () => {
  it('two gates differing ONLY in uri do not see each other token (kills a key derived from db alone)', () => {
    const storage = new FakeSessionStorage();
    const host = hostWithStorage(storage);
    const gateA = createAuthTokenGate('ws://uri-A', 'same-db', host);
    const gateB = createAuthTokenGate('ws://uri-B', 'same-db', host);
    gateA.onConnected('tok-A');
    expect(gateB.tokenForNextAttempt()).toBeUndefined();
    expect(gateA.tokenForNextAttempt()).toBe('tok-A');
  });

  it('two gates differing ONLY in db do not see each other token (kills a key derived from uri alone)', () => {
    const storage = new FakeSessionStorage();
    const host = hostWithStorage(storage);
    const gateA = createAuthTokenGate('same-uri', 'db-A', host);
    const gateB = createAuthTokenGate('same-uri', 'db-B', host);
    gateA.onConnected('tok-A');
    expect(gateB.tokenForNextAttempt()).toBeUndefined();
    expect(gateA.tokenForNextAttempt()).toBe('tok-A');
  });

  it('key derivation is injective across the uri|db split (kills naive concatenation without encodeURIComponent)', () => {
    // 'a|b' + 'c'  vs  'a' + 'b|c' — a naive `${uri}|${db}` concat collides on both keys;
    // encodeURIComponent-ing each component before joining must keep them distinct.
    const storage = new FakeSessionStorage();
    const host = hostWithStorage(storage);
    const gate1 = createAuthTokenGate('a|b', 'c', host);
    const gate2 = createAuthTokenGate('a', 'b|c', host);
    gate1.onConnected('tok-1');
    gate2.onConnected('tok-2');
    expect(gate1.tokenForNextAttempt()).toBe('tok-1');
    expect(gate2.tokenForNextAttempt()).toBe('tok-2');
  });

  it('non-string/empty stored values yield undefined (kills passing "" to .withToken(), a permanent auth-fail loop)', () => {
    const emptyGate = createAuthTokenGate(
      'ws://x',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    emptyGate.onConnected('');
    expect(emptyGate.tokenForNextAttempt()).toBeUndefined();

    const whitespaceGate = createAuthTokenGate(
      'ws://x',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    whitespaceGate.onConnected('   ');
    expect(whitespaceGate.tokenForNextAttempt()).toBeUndefined();

    const nullGate = createAuthTokenGate('ws://x', 'db', storageReturning(null));
    expect(nullGate.tokenForNextAttempt()).toBeUndefined();

    const numberGate = createAuthTokenGate('ws://x', 'db', storageReturning(42));
    expect(numberGate.tokenForNextAttempt()).toBeUndefined();
  });

  it('a stored token with dots/dashes round-trips VERBATIM (kills an impl that mangles/trims the returned credential)', () => {
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new FakeSessionStorage()));
    gate.onConnected('abc.def-ghi');
    expect(gate.tokenForNextAttempt()).toBe('abc.def-ghi');
  });
});

// ---------------------------------------------------------------------------
// Classifier: isStoredCredentialRejected
// ---------------------------------------------------------------------------

describe('isStoredCredentialRejected', () => {
  it('TRUE for "Failed to verify token: ..." messages (kills an always-false classifier that hangs reconnect forever)', () => {
    expect(isStoredCredentialRejected(new Error('Failed to verify token: Unauthorized'))).toBe(
      true,
    );
    expect(isStoredCredentialRejected(new Error('Failed to verify token: Forbidden'))).toBe(true);
  });

  it('TRUE for the HTTP/2 empty-statusText shape "Failed to verify token: " (spec-mandated)', () => {
    expect(isStoredCredentialRejected(new Error('Failed to verify token: '))).toBe(true);
  });

  it('FALSE for a message missing the ": " delimiter (kills a delimiter-less prefix or includes("verify token") impl)', () => {
    expect(isStoredCredentialRejected(new Error('Failed to verify tokens for the batch'))).toBe(
      false,
    );
  });

  it('FALSE for a message that contains the full prefix but NOT at index 0 (kills a full-prefix `includes(...)` variant that survives the "batch" negative above)', () => {
    // The only current negative, 'Failed to verify tokens for the batch', returns
    // false under BOTH `startsWith` and `includes('Failed to verify token: ')` — so an
    // `err.message.includes('Failed to verify token: ')` implementation (instead of
    // the spec-mandated `startsWith`) would survive it. This message embeds the exact
    // prefix substring starting at index 7, not index 0: an `includes` implementation
    // wrongly returns true and misclassifies an unrelated wrapped/nested error as a
    // credential rejection, wrongly advancing the suppression counter.
    expect(isStoredCredentialRejected(new Error('Warning: Failed to verify token: nested'))).toBe(
      false,
    );
  });

  it('FALSE for unrelated errors and a DOM-Event-like plain object (the real ws.onerror shape on a wifi blip)', () => {
    expect(isStoredCredentialRejected(new Error(''))).toBe(false);
    expect(
      isStoredCredentialRejected(new Error('NetworkError when attempting to fetch resource.')),
    ).toBe(false);
    expect(isStoredCredentialRejected({ type: 'error' })).toBe(false);
  });

  it('total over hostile input: never throws, always false (kills an unguarded err.message.startsWith(...))', () => {
    const hostileInputs: unknown[] = [
      undefined,
      null,
      { message: 42 },
      { message: null },
      'a bare string',
    ];
    for (const input of hostileInputs) {
      expect(() => isStoredCredentialRejected(input)).not.toThrow();
      expect(isStoredCredentialRejected(input)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Suppression state machine (nh4-3 / nh4-4) — the heart of the slice
// ---------------------------------------------------------------------------

describe('createAuthTokenGate: consecutive-rejection suppression', () => {
  it('below threshold the token is still supplied (kills a suppress-on-first-rejection impl)', () => {
    // The SDK throws this SAME "Failed to verify token: " message for transient 500/502/503
    // gateway errors, not only 401 — dropping identity on ONE rejection would be wrong.
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new FakeSessionStorage()));
    gate.onConnected('tok-A');
    for (let i = 0; i < AUTH_REJECT_SUPPRESS_THRESHOLD - 1; i += 1) {
      gate.onConnectFailed(AUTH_ERR);
    }
    expect(gate.tokenForNextAttempt()).toBe('tok-A');
  });

  it('at threshold the token is withheld — but remains in storage (kills a never-suppress AND a delete-on-reject impl)', () => {
    const storage = new FakeSessionStorage();
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(storage));
    gate.onConnected('tok-A');
    for (let i = 0; i < AUTH_REJECT_SUPPRESS_THRESHOLD; i += 1) {
      gate.onConnectFailed(AUTH_ERR);
    }
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    // Suppression, not deletion: the underlying store still holds the token.
    const setCall = storage.calls.find((c) => c.op === 'setItem');
    expect(setCall).toBeDefined();
    expect(storage.has(setCall?.key as string)).toBe(true);
  });

  it('a non-auth failure resets the counter (never destroy identity while the host is merely unreachable)', () => {
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new FakeSessionStorage()));
    gate.onConnected('tok-A');
    for (let i = 0; i < AUTH_REJECT_SUPPRESS_THRESHOLD - 1; i += 1) {
      gate.onConnectFailed(AUTH_ERR);
    }
    gate.onConnectFailed(new Error('NetworkError when attempting to fetch resource.'));
    gate.onConnectFailed(AUTH_ERR);
    // Only 1 consecutive auth-rejection since the network-error reset — still below threshold.
    expect(gate.tokenForNextAttempt()).toBe('tok-A');
  });

  it('recovery: onConnected resets the counter AND persists the new token (kills a permanently-latched suppression impl)', () => {
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new FakeSessionStorage()));
    gate.onConnected('tok-OLD');
    for (let i = 0; i < AUTH_REJECT_SUPPRESS_THRESHOLD; i += 1) {
      gate.onConnectFailed(AUTH_ERR);
    }
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    gate.onConnected('tok-NEW');
    expect(gate.tokenForNextAttempt()).toBe('tok-NEW');
  });

  it('nh4-4 host-reset scenario: the suppression loop TERMINATES, then a fresh onConnected supplies the new token', () => {
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new FakeSessionStorage()));
    gate.onConnected('tok-OLD');
    for (let i = 0; i < AUTH_REJECT_SUPPRESS_THRESHOLD; i += 1) {
      // Each retry up to the threshold still reads the OLD stored token before it fails.
      expect(gate.tokenForNextAttempt()).toBe('tok-OLD');
      gate.onConnectFailed(AUTH_ERR);
    }
    // The next build connects anonymously — the loop is broken, not stuck forever.
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    gate.onConnected('tok-NEW');
    expect(gate.tokenForNextAttempt()).toBe('tok-NEW');
  });

  it('nh4-4 post-wipe scenario: a playtest-wipe does NOT invalidate the token — successful reconnect never suppresses', () => {
    // A `playtest-wipe` (--delete-data) clears one DATABASE's rows; it does not revoke the
    // host-level JWT the client already holds. The server's `joinGame` reducer is
    // UNCONDITIONAL and its `!has_monsters` gate re-grants a starter monster on the very
    // next connect for that (now row-less) identity — so a successful reconnect with the
    // SAME token after a wipe is the correct, expected path, and no client-side token clear
    // belongs here. Modeled by: no `onConnectFailed` call at all — the JWT itself was never
    // rejected — just a repeat `onConnected` with the identical token.
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new FakeSessionStorage()));
    gate.onConnected('tok-SAME');
    gate.onConnected('tok-SAME');
    expect(gate.tokenForNextAttempt()).toBe('tok-SAME');
  });
});

// ---------------------------------------------------------------------------
// Storage degradation — must never break the connection
// ---------------------------------------------------------------------------

describe('createAuthTokenGate: storage degrades silently, never throws', () => {
  it('host is undefined: tokenForNextAttempt is undefined, onConnected does not throw', () => {
    const gate = createAuthTokenGate('ws://x', 'db', undefined);
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    expect(() => gate.onConnected('t')).not.toThrow();
  });

  it('host is {} (no sessionStorage): same silent degradation', () => {
    const gate = createAuthTokenGate('ws://x', 'db', {});
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    expect(() => gate.onConnected('t')).not.toThrow();
  });

  it('host.sessionStorage is a getter that throws (SecurityError, cookies blocked): silent degradation', () => {
    const host: TokenStorageHost = {};
    Object.defineProperty(host, 'sessionStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    const gate = createAuthTokenGate('ws://x', 'db', host);
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    expect(() => gate.onConnected('t')).not.toThrow();
  });

  it('sessionStorage present but getItem/setItem are not functions: silent degradation', () => {
    const gate = createAuthTokenGate(
      'ws://x',
      'db',
      hostWithStorage({ getItem: 'nope', setItem: 'nope' }),
    );
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    expect(() => gate.onConnected('t')).not.toThrow();
  });

  it('setItem throws (Safari private-mode QuotaExceededError): onConnected does not throw', () => {
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new ThrowingSetStorage()));
    expect(() => gate.onConnected('t')).not.toThrow();
  });

  it('getItem throws: tokenForNextAttempt returns undefined and does not throw', () => {
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(new ThrowingGetStorage()));
    expect(() => gate.tokenForNextAttempt()).not.toThrow();
    expect(gate.tokenForNextAttempt()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Per-attempt re-read — every OTHER test above uses a single gate instance and never
// mutates storage externally, so a closure-caching implementation (one that only
// updates a remembered token inside onConnected, instead of re-reading storage on
// every tokenForNextAttempt() call) is otherwise indistinguishable from a compliant
// one. That distinction is load-bearing: a fresh per-attempt read is what lets a
// suppressed-then-recovered state observe the right value.
// ---------------------------------------------------------------------------

describe('createAuthTokenGate: re-reads storage on every attempt (not closure-cached)', () => {
  it('external mutation of storage is observed by the very next tokenForNextAttempt() call (kills a closure-cached token updated only inside onConnected)', () => {
    const storage = new FakeSessionStorage();
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(storage));
    gate.onConnected('tok-A');
    expect(gate.tokenForNextAttempt()).toBe('tok-A');

    // Mutate the underlying fake storage DIRECTLY, bypassing the gate entirely — no
    // gate.onConnected() call happens here. A closure-caching implementation would
    // still return the stale 'tok-A' below.
    const setCall = storage.calls.find((c) => c.op === 'setItem');
    const key = setCall?.key as string;
    storage.setItem(key, 'tok-EXTERNAL');

    expect(gate.tokenForNextAttempt()).toBe('tok-EXTERNAL');
  });

  it('tokenForNextAttempt() calls storage.getItem EACH time (kills a memoized read after the first call)', () => {
    const storage = new FakeSessionStorage();
    const gate = createAuthTokenGate('ws://x', 'db', hostWithStorage(storage));
    gate.onConnected('tok-A');
    const getCallsBefore = storage.calls.filter((c) => c.op === 'getItem').length;
    gate.tokenForNextAttempt();
    gate.tokenForNextAttempt();
    const getCallsAfter = storage.calls.filter((c) => c.op === 'getItem').length;
    expect(
      getCallsAfter - getCallsBefore,
      'two consecutive tokenForNextAttempt() calls must each issue a fresh storage.getItem ' +
        '— a memoized/cached read would issue fewer than 2 additional getItem calls here',
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// sessionStorage, never localStorage — ADR-0150 D3.
// ---------------------------------------------------------------------------

describe('createAuthTokenGate: reads/writes sessionStorage only, never localStorage (ADR-0150 D3)', () => {
  it('a host exposing ONLY localStorage (no sessionStorage at all) is never touched: tokenForNextAttempt is undefined, onConnected writes nothing, neither throws', () => {
    // WRONG IMPL KILLED: an implementation that reads/writes `host.localStorage`
    // instead of (or as a fallback for) `host.sessionStorage`. ADR-0150 D3: the token
    // MUST be per-tab (sessionStorage) — the server's `on_disconnect` handler keys on
    // identity alone with no live-connection check, so an origin-shared
    // (localStorage) token would let closing a SECOND tab forfeit the FIRST tab's
    // still-live PvP battle and delete its character row.
    const localFake = new FakeSessionStorage();
    // This cast models a browser-like host object that exposes only `localStorage`
    // and has NO `sessionStorage` property at all. `TokenStorageHost.sessionStorage`
    // is optional, so omitting it entirely is a valid shape of that type; the bridge
    // through `unknown` is only needed to attach the extra `localStorage` property
    // without reaching for `any`.
    const host = { localStorage: localFake } as unknown as TokenStorageHost;

    const gate = createAuthTokenGate('ws://x', 'db', host);
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    expect(() => gate.onConnected('t')).not.toThrow();
    expect(localFake.calls.some((c) => c.op === 'setItem')).toBe(false);
    expect(localFake.size).toBe(0);
  });
});
