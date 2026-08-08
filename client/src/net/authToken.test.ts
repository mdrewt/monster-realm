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
    const gate = createAuthTokenGate('ws://127.0.0.1:3000', 'db', hostWithStorage(storage));
    gate.onConnected('tok-A');
    const setCall = storage.calls.find((c) => c.op === 'setItem');
    expect(setCall).toBeDefined();
    expect(setCall?.key.indexOf('mr.authToken.v1')).toBeGreaterThanOrEqual(0);
    expect(setCall?.value).toBe('tok-A');
  });

  it('round-trip: onConnected then tokenForNextAttempt returns the same token (kills an always-undefined read)', () => {
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    gate.onConnected('tok-A');
    expect(gate.tokenForNextAttempt()).toBe('tok-A');
  });

  it('a second onConnected replaces the stored token (kills a write-only-if-empty impl that strands a dead token)', () => {
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    gate.onConnected('tok-A');
    gate.onConnected('tok-B');
    expect(gate.tokenForNextAttempt()).toBe('tok-B');
  });

  it('an empty store returns undefined from tokenForNextAttempt (kills a hardcoded return)', () => {
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
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
    const gateA = createAuthTokenGate('ws://127.0.0.1:3000', 'same-db', host);
    const gateB = createAuthTokenGate('ws://127.0.0.1:3001', 'same-db', host);
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
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    emptyGate.onConnected('');
    expect(emptyGate.tokenForNextAttempt()).toBeUndefined();

    const whitespaceGate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    whitespaceGate.onConnected('   ');
    expect(whitespaceGate.tokenForNextAttempt()).toBeUndefined();

    const nullGate = createAuthTokenGate('ws://127.0.0.1:3000', 'db', storageReturning(null));
    expect(nullGate.tokenForNextAttempt()).toBeUndefined();

    const numberGate = createAuthTokenGate('ws://127.0.0.1:3000', 'db', storageReturning(42));
    expect(numberGate.tokenForNextAttempt()).toBeUndefined();
  });

  it('a stored token with dots/dashes round-trips VERBATIM (kills an impl that mangles/trims the returned credential)', () => {
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
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

  it('an object whose `message` getter throws: FALSE, does not throw (kills the mutant that removes the try/catch around the message read, which re-throws and permanently strands the reconnect ladder)', () => {
    // A throwing accessor is exactly what a hostile/malformed error-like object can present.
    // Without the try/catch, `const { message } = err as { message?: unknown }` throws
    // synchronously; that throw would escape through `onConnectFailed` into connection.ts's
    // `.onConnectError` callback, where it skips `scheduleRebuild()` — leaving the client
    // with no pending timer and no further reconnect attempts: a permanent, silent freeze
    // recoverable only by reload.
    const throwingGetterErr: unknown = {};
    Object.defineProperty(throwingGetterErr, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => isStoredCredentialRejected(throwingGetterErr)).not.toThrow();
    expect(isStoredCredentialRejected(throwingGetterErr)).toBe(false);
  });

  it('a Proxy whose `get` trap throws: FALSE, does not throw (same mutant as the throwing-getter case, via a different hostile shape)', () => {
    const throwingProxyErr: unknown = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    expect(() => isStoredCredentialRejected(throwingProxyErr)).not.toThrow();
    expect(isStoredCredentialRejected(throwingProxyErr)).toBe(false);
  });

  it('gate.onConnectFailed does not throw for either hostile shape — this is the call that actually sits on the reconnect path (kills the same try/catch-removal mutant one hop closer to the real integration point)', () => {
    const throwingGetterErr: unknown = {};
    Object.defineProperty(throwingGetterErr, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    const throwingProxyErr: unknown = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    expect(() => gate.onConnectFailed(throwingGetterErr)).not.toThrow();
    expect(() => gate.onConnectFailed(throwingProxyErr)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suppression state machine (nh4-3 / nh4-4) — the heart of the slice
// ---------------------------------------------------------------------------

describe('createAuthTokenGate: consecutive-rejection suppression', () => {
  it('below threshold the token is still supplied (kills a suppress-on-first-rejection impl)', () => {
    // The SDK throws this SAME "Failed to verify token: " message for transient 500/502/503
    // gateway errors, not only 401 — dropping identity on ONE rejection would be wrong.
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    gate.onConnected('tok-A');
    for (let i = 0; i < AUTH_REJECT_SUPPRESS_THRESHOLD - 1; i += 1) {
      gate.onConnectFailed(AUTH_ERR);
    }
    expect(gate.tokenForNextAttempt()).toBe('tok-A');
  });

  it('at threshold the token is withheld — but remains in storage (kills a never-suppress AND a delete-on-reject impl)', () => {
    const storage = new FakeSessionStorage();
    const gate = createAuthTokenGate('ws://127.0.0.1:3000', 'db', hostWithStorage(storage));
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

  it('a non-auth failure does NOT reset the counter — it is simply ignored (kills the reset-on-non-auth variant, which alternation defeats)', () => {
    // WRONG IMPL KILLED: the OLD (defective) design reset `rejectionsSinceSuccess` to 0 on
    // ANY non-classified error. That made the counter defeatable by alternation: a host
    // whose failures interleave rejection/network-error (a load balancer where only some
    // replicas rotated the signing key; a flaky link that fails the verify fetch outright)
    // oscillates the counter 0->1->0->1 forever, NEVER reaches the threshold, and the client
    // re-supplies a dead token indefinitely — the exact unrecoverable loop ADR-0150 exists to
    // prevent. Under the CORRECTED design, a non-auth failure neither advances nor resets:
    // it is inert. So with THRESHOLD-1 auth rejections already accrued, one interleaved
    // network error changes nothing, and the very next auth rejection reaches the threshold.
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    gate.onConnected('tok-A');
    for (let i = 0; i < AUTH_REJECT_SUPPRESS_THRESHOLD - 1; i += 1) {
      gate.onConnectFailed(AUTH_ERR);
    }
    gate.onConnectFailed(new Error('NetworkError when attempting to fetch resource.'));
    gate.onConnectFailed(AUTH_ERR);
    // The network error did NOT reset anything: this last AUTH_ERR is the THRESHOLD-th
    // classified rejection since the last success, so the token is now withheld.
    expect(gate.tokenForNextAttempt()).toBeUndefined();
  });

  it('a pure outage never suppresses: unbroken non-auth failures never advance the counter (the single most important safety property in the module)', () => {
    // An unreachable host must never cost the player their identity. Looping WELL past the
    // threshold with ONLY network errors (no classified credential rejection ever occurs)
    // must never withhold the stored token.
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    gate.onConnected('tok-A');
    for (let i = 0; i < 3 * AUTH_REJECT_SUPPRESS_THRESHOLD; i += 1) {
      gate.onConnectFailed(new Error('NetworkError when attempting to fetch resource.'));
      expect(gate.tokenForNextAttempt()).toBe('tok-A');
    }
  });

  it('alternation still reaches the threshold: exactly AUTH_REJECT_SUPPRESS_THRESHOLD auth rejections withhold the token, regardless of how many non-auth errors are interleaved (direct regression test for the red-team finding)', () => {
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    gate.onConnected('tok-A');
    let authRejections = 0;
    let toggle = false;
    while (authRejections < AUTH_REJECT_SUPPRESS_THRESHOLD) {
      if (toggle) {
        gate.onConnectFailed(new Error('NetworkError when attempting to fetch resource.'));
      } else {
        gate.onConnectFailed(AUTH_ERR);
        authRejections += 1;
      }
      toggle = !toggle;
    }
    expect(gate.tokenForNextAttempt()).toBeUndefined();
  });

  it('recovery: onConnected resets the counter AND persists the new token (kills a permanently-latched suppression impl)', () => {
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
    gate.onConnected('tok-OLD');
    for (let i = 0; i < AUTH_REJECT_SUPPRESS_THRESHOLD; i += 1) {
      gate.onConnectFailed(AUTH_ERR);
    }
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    gate.onConnected('tok-NEW');
    expect(gate.tokenForNextAttempt()).toBe('tok-NEW');
  });

  it('nh4-4 host-reset scenario: the suppression loop TERMINATES, then a fresh onConnected supplies the new token', () => {
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
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
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new FakeSessionStorage()),
    );
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
    const gate = createAuthTokenGate('ws://127.0.0.1:3000', 'db', undefined);
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    expect(() => gate.onConnected('t')).not.toThrow();
  });

  it('host is {} (no sessionStorage): same silent degradation', () => {
    const gate = createAuthTokenGate('ws://127.0.0.1:3000', 'db', {});
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
    const gate = createAuthTokenGate('ws://127.0.0.1:3000', 'db', host);
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    expect(() => gate.onConnected('t')).not.toThrow();
  });

  it('sessionStorage present but getItem/setItem are not functions: silent degradation', () => {
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage({ getItem: 'nope', setItem: 'nope' }),
    );
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    expect(() => gate.onConnected('t')).not.toThrow();
  });

  it('setItem throws (Safari private-mode QuotaExceededError): onConnected does not throw', () => {
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new ThrowingSetStorage()),
    );
    expect(() => gate.onConnected('t')).not.toThrow();
  });

  it('getItem throws: tokenForNextAttempt returns undefined and does not throw', () => {
    const gate = createAuthTokenGate(
      'ws://127.0.0.1:3000',
      'db',
      hostWithStorage(new ThrowingGetStorage()),
    );
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
    const gate = createAuthTokenGate('ws://127.0.0.1:3000', 'db', hostWithStorage(storage));
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
    const gate = createAuthTokenGate('ws://127.0.0.1:3000', 'db', hostWithStorage(storage));
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

    const gate = createAuthTokenGate('ws://127.0.0.1:3000', 'db', host);
    expect(gate.tokenForNextAttempt()).toBeUndefined();
    expect(() => gate.onConnected('t')).not.toThrow();
    expect(localFake.calls.some((c) => c.op === 'setItem')).toBe(false);
    expect(localFake.size).toBe(0);
  });
});

// ===========================================================================
// M21b — the auth-KIND marker (ADR-0179, spec EARS AUTH-31).
// APPENDED BLOCK. Nothing above this line is modified, byte for byte.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-M21b-plan.md (the ADDENDUM
// section supersedes the body), plus the coordinator's scope ruling below.
//
// ★★ SCOPE RULING (what this slice is, and what it deliberately is NOT) ★★
// The plan's read-side guard — `decideConnectCredential`,
// `SESSION_EXPIRED_MESSAGE`, `ConnectionOptions.onSessionExpired` and the
// session-expired branch in `connection.ts`'s `build()` — is CUT from this
// slice and ships with M21b-2. It is not buildable here: the guard's early exit
// needs `build()` to be able to decline to return a connection, i.e.
// `DbConnection | undefined`, which cascades into `let current = build()`, the
// `get conn()` accessor, and every `conn.conn.reducers.*` call site in main.ts.
// That is a public-surface change belonging with the cold-start contract it
// depends on (parked item 6). The type system was reporting a real dependency.
//
// WHAT SHIPS HERE: the marker itself — `AuthKind`, `AUTH_KIND_KEY_PREFIX`,
// `authKindStorageKey`, `readAuthKind`, `writeAuthKind` — additive only, plus
// ONE guard at connection.ts's `auth.onConnected(token)` call site so the
// anonymous token slot can never receive an account JWT.
//
// WHY THE APPEND-ONLY DISCIPLINE IS ITSELF THE TEST: AUTH-31 is a NO-CHANGE
// criterion — "the anonymous path behaves exactly as it does today". The
// mechanical proof of that is that `authToken.ts` gains only NEW exports (zero
// edits to any existing body) and this file gains only a NEW block (zero edits
// above this banner). A reviewer diffs both. If a line above this banner moved,
// AUTH-31's proof is void regardless of what the assertions below say. With the
// read side cut, `.withToken(auth.tokenForNextAttempt())` in connection.ts is
// byte-identical too, so the no-change claim is literal rather than argued.
//
// EARS COVERED HERE
//   AUTH-31  — the marker is a NEW, structurally DISJOINT sessionStorage seam:
//              nothing it does can perturb the existing token slot, and every
//              corrupt/blocked-storage path fails to `'anon'` (i.e. to exactly
//              today's behaviour) rather than to `'account'`.
//
// STILL A PURE NODE UNIT TEST — every storage host is injected, exactly as the
// 27 pre-existing tests above do. No DOM, no jsdom, no real sessionStorage.
// The ONE exception is W-M21B-WRITE-HAZARD-DOCUMENTED at the end, which reads
// authToken.ts as text; it is a source scan by necessity (a comment has no
// runtime representation) and says so.
//
// RED REASON: `AuthKind`, `AUTH_KIND_KEY_PREFIX`, `authKindStorageKey`,
// `readAuthKind` and `writeAuthKind` do not exist in `authToken.ts` yet. The
// import below fails to resolve its named exports, so this whole block reds on
// a MISSING IMPLEMENTATION, not on a typo here.
//
// NO `new RegExp(...)` anywhere (Semgrep `detect-non-literal-regexp`, banned
// repo-wide) — string comparison / indexOf / startsWith only.
// ===========================================================================

// A late, second import block. Precedent: client/src/prediction/heldKeys.test.ts:394-397
// does exactly this for its appended integration section. Biome sorts imports WITHIN a
// contiguous chunk and never moves them across intervening statements, so this import
// stays here and no line above the banner is disturbed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTH_KIND_KEY_PREFIX,
  type AuthKind,
  authKindStorageKey,
  readAuthKind,
  writeAuthKind,
} from './authToken';

const M21B_URI = 'ws://127.0.0.1:3000';
const M21B_DB = 'monster-realm';

/** Both members of the `AuthKind` union. Iterating it is what keeps the exported TYPE
 *  load-bearing here: a union narrowed to a single member (or widened to `string`) stops
 *  compiling against this annotation. */
const M21B_KINDS: readonly AuthKind[] = ['anon', 'account'];

/**
 * The TOKEN key for a target, derived BEHAVIOURALLY (the private `storageKey` is not
 * exported and must not become exported for a test's convenience): build a real gate over
 * a private fake storage, let it persist a probe token, and read back the key it chose.
 * This is the same `storage.calls.find(setItem).key` move the persistence tests above use.
 */
function tokenKeyFor(uri: string, db: string): string {
  const storage = new FakeSessionStorage();
  const gate = createAuthTokenGate(uri, db, hostWithStorage(storage));
  gate.onConnected('probe-token');
  const setCall = storage.calls.find((c) => c.op === 'setItem');
  if (setCall === undefined) {
    throw new Error(
      'tokenKeyFor: createAuthTokenGate(...).onConnected() issued no setItem — the fixture ' +
        'is broken, so every disjointness assertion below would be vacuous',
    );
  }
  return setCall.key;
}

// ---------------------------------------------------------------------------
// authKindStorageKey — same two-axis injective derivation, NEW namespace.
// ---------------------------------------------------------------------------

describe('authKindStorageKey', () => {
  it('is namespaced under AUTH_KIND_KEY_PREFIX and is deterministic', () => {
    expect(authKindStorageKey(M21B_URI, M21B_DB).indexOf(AUTH_KIND_KEY_PREFIX)).toBe(0);
    expect(authKindStorageKey(M21B_URI, M21B_DB)).toBe(authKindStorageKey(M21B_URI, M21B_DB));
  });

  it('★ key derivation is injective across the uri|db split (kills naive concatenation without encodeURIComponent)', () => {
    // The SAME adversarial fixture the token key uses above (line ~194): 'a|b' + 'c' vs
    // 'a' + 'b|c'. A naive `${PREFIX}|${uri}|${db}` concat collides them onto one key, so
    // two DIFFERENT connection targets would share one marker: a stale `'account'` written
    // for one host would make a completely different host's tab refuse to connect.
    expect(authKindStorageKey('a|b', 'c')).not.toBe(authKindStorageKey('a', 'b|c'));
    // Each axis is load-bearing on its own (kills a key derived from uri alone / db alone).
    expect(authKindStorageKey('ws://a:3000', 'same-db')).not.toBe(
      authKindStorageKey('ws://b:3000', 'same-db'),
    );
    expect(authKindStorageKey('same-uri', 'db-A')).not.toBe(authKindStorageKey('same-uri', 'db-B'));
    // Case is PRESERVED, exactly as storageKey does (connectionConfig.ts treats
    // `Monster-Realm-Playtest` as a legitimately distinct database).
    expect(authKindStorageKey('same-uri', 'DB')).not.toBe(authKindStorageKey('same-uri', 'db'));
  });
});

// ---------------------------------------------------------------------------
// W-M21B-KIND-DISJOINT — the two key SPACES cannot collide. Pinned DIRECTLY
// (red-team L2), not merely inferred from each derivation's injectivity.
// ---------------------------------------------------------------------------

/** Adversarial (uri, db) targets. Includes the `|`-splitting pair, the empty pair, and two
 *  targets whose URI IS one of the two prefixes — the shapes most likely to pun one key
 *  space onto the other if `encodeURIComponent` or the prefix choice is wrong. */
const M21B_ADVERSARIAL_TARGETS: readonly (readonly [string, string])[] = [
  ['a|b', 'c'],
  ['a', 'b|c'],
  ['a', 'b'],
  ['', ''],
  ['mr.authKind.v1', 'x'],
  ['mr.authToken.v1', 'x'],
  ['mr.authToken.v1|', 'x'],
  ['ws://127.0.0.1:3000', 'monster-realm'],
];

describe('W-M21B-KIND-DISJOINT: the kind key space and the token key space are disjoint', () => {
  it('★ (a) AUTH_KIND_KEY_PREFIX is `mr.authKind.v1` — and NEITHER prefix is a prefix of the other', () => {
    // ADDENDUM S12. The spec's illustrative `mr.authToken.v1.kind` is a SUPERSTRING of the
    // shipped `KEY_PREFIX = 'mr.authToken.v1'` (authToken.ts:49), so under it disjointness
    // would hold only by a subtle argument about the 16th character plus encodeURIComponent
    // stripping `|`. `mr.authKind.v1` makes disjointness STRUCTURAL — which is what demotes
    // this whole gate from sole proof to a cheap regression pin. That is a mechanism choice
    // and it must be pinned, or a later "harmonise the prefixes" edit silently re-opens it.
    const tokenPrefix = 'mr.authToken.v1';
    expect(AUTH_KIND_KEY_PREFIX).toBe('mr.authKind.v1');
    expect(AUTH_KIND_KEY_PREFIX.startsWith(tokenPrefix)).toBe(false);
    expect(tokenPrefix.startsWith(AUTH_KIND_KEY_PREFIX)).toBe(false);
    // Anti-vacuity: the LIVE token key really does start with the prefix this test names.
    // Without this, the two assertions above compare a constant against a string literal
    // that might have nothing to do with the shipped derivation.
    expect(
      tokenKeyFor(M21B_URI, M21B_DB).indexOf(tokenPrefix),
      'the live gate key must start with mr.authToken.v1 — if it does not, the prefix ' +
        'comparisons above are judging a literal that no longer describes the token space',
    ).toBe(0);
  });

  it('★★ (b) BEHAVIOURAL: a token and a kind written for the SAME (uri, db) on the SAME storage coexist — neither clobbers the other, in EITHER write order', () => {
    // ★ THE LOAD-BEARING FORM. A key-string comparison can be satisfied by two derivations
    // that a reader believes are the shipped ones; this drives the SHIPPED writers.
    //
    // WRONG IMPL KILLED (a): `authKindStorageKey` reusing KEY_PREFIX (a copy-paste of
    //   storageKey with the prefix constant left alone). writeAuthKind would then overwrite
    //   the player's reconnect TOKEN with the literal string 'account' — and
    //   tokenForNextAttempt() would hand `'account'` to `.withToken()`, producing the
    //   permanent, self-repeating auth-failure loop ADR-0150 exists to prevent.
    // WRONG IMPL KILLED (b): the reverse — onConnected() overwriting the marker.
    // WRONG IMPL KILLED (c): `authKindStorageKey` dropping encodeURIComponent, which is the
    //   mutation the plan's FINAL list names explicitly.
    for (const [first, second] of [
      ['token', 'kind'],
      ['kind', 'token'],
    ] as const) {
      const storage = new FakeSessionStorage();
      const host = hostWithStorage(storage);
      const gate = createAuthTokenGate(M21B_URI, M21B_DB, host);
      const writeToken = (): void => gate.onConnected('TOK-LIVE');
      const writeKind = (): void => writeAuthKind(host, M21B_URI, M21B_DB, 'account');
      if (first === 'token') writeToken();
      else writeKind();
      if (second === 'token') writeToken();
      else writeKind();

      expect(
        gate.tokenForNextAttempt(),
        `write order ${first} then ${second}: the kind write must not touch the token slot`,
      ).toBe('TOK-LIVE');
      expect(
        readAuthKind(host, M21B_URI, M21B_DB),
        `write order ${first} then ${second}: the token write must not touch the kind slot`,
      ).toBe('account');
      expect(
        storage.size,
        `write order ${first} then ${second}: the two writes must occupy TWO distinct keys ` +
          '— a size of 1 means one space collapsed onto the other',
      ).toBe(2);
    }
  });

  it('★★ (c) NO (uri, db) pair makes a kind key equal ANY token key (adversarial cross-product)', () => {
    // The direct form of the criterion: quantified over a cross-product, not over one
    // matched pair. A same-target comparison alone would miss a derivation under which
    // `kindKey('a|b','c') === tokenKey('a','b|c')` — two DIFFERENT targets punning across
    // the two spaces, which is exactly what dropping encodeURIComponent enables.
    for (const [kindUri, kindDb] of M21B_ADVERSARIAL_TARGETS) {
      const kindKey = authKindStorageKey(kindUri, kindDb);
      for (const [tokenUri, tokenDb] of M21B_ADVERSARIAL_TARGETS) {
        expect(
          kindKey,
          `kind key for (${JSON.stringify(kindUri)}, ${JSON.stringify(kindDb)}) must differ ` +
            `from the TOKEN key for (${JSON.stringify(tokenUri)}, ${JSON.stringify(tokenDb)}) ` +
            '— the two key spaces must be structurally disjoint (ADDENDUM S12)',
        ).not.toBe(tokenKeyFor(tokenUri, tokenDb));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// readAuthKind — total over `unknown`, fails to 'anon' on EVERY hostile path.
// ---------------------------------------------------------------------------

describe('readAuthKind (AUTH-31): fails to "anon" on every absent / blocked / corrupt path', () => {
  it('★ returns "account" for the EXACT stored string "account", read from authKindStorageKey(uri, db)', () => {
    // THE positive. Without it every negative below is a vacuous truth satisfied by
    // `return 'anon'`. It also pins the KEY: the value is seeded directly under
    // authKindStorageKey(...), so a reader that computes some other key reds here.
    const storage = new FakeSessionStorage();
    storage.setItem(authKindStorageKey(M21B_URI, M21B_DB), 'account');
    expect(readAuthKind(hostWithStorage(storage), M21B_URI, M21B_DB)).toBe('account');
  });

  it('★★ fails to "anon" — and never throws — on every hostile host and every non-"account" value', () => {
    // WHY THE FAIL DIRECTION IS 'anon' AND NOT 'account' (the plan's stated justification,
    // restated here because it is the reason this test is a safety test and not a taste
    // test): every tab that exists TODAY has no marker at all. A reader that failed to
    // 'account' would send every one of them down the session-expired branch the moment
    // storage is blocked (Safari private mode, cookies-blocked SecurityError, a corrupt
    // backend) — i.e. it would break every existing anonymous reconnect, which is precisely
    // the AUTH-31 no-change criterion.
    //
    // WRONG IMPL KILLED (a): `return 'account'` on a MISSING key — named in the plan's
    //   FINAL mutation list.
    // WRONG IMPL KILLED (b): `return 'account'` on a THROWING getter — also named there.
    // WRONG IMPL KILLED (c): dropping the try/catch around the property access, so a
    //   SecurityError escapes into build() and takes the whole reconnect ladder down (the
    //   same permanent-freeze mode isStoredCredentialRejected's try/catch guards above).
    // WRONG IMPL KILLED (d): a truthiness read (`raw ? 'account' : 'anon'`) — the
    //   unrecognized-string rows kill it.
    // WRONG IMPL KILLED (e): a lenient match (`raw.includes('account')`, `raw.trim()`,
    //   `raw.toLowerCase()`). EXACT match is the house discipline for a load-bearing string
    //   (connection.ts:569's `'already joined'`); writeAuthKind is the only writer and it
    //   writes the exact literal, so leniency buys nothing and hides marker corruption.
    const throwingPropertyHost: TokenStorageHost = {};
    Object.defineProperty(throwingPropertyHost, 'sessionStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    const throwingProxyStorage = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );

    const cases: readonly (readonly [string, TokenStorageHost | undefined])[] = [
      ['host is undefined', undefined],
      ['host has no sessionStorage', {}],
      ['sessionStorage property access throws (cookies blocked)', throwingPropertyHost],
      ['sessionStorage is a Proxy whose get trap throws', hostWithStorage(throwingProxyStorage)],
      ['sessionStorage is not an object (number)', hostWithStorage(42)],
      ['sessionStorage is not an object (string)', hostWithStorage('nope')],
      ['sessionStorage is null', hostWithStorage(null)],
      ['getItem is not a function', hostWithStorage({ getItem: 'nope', setItem: 'nope' })],
      ['getItem throws', hostWithStorage(new ThrowingGetStorage())],
      [
        'host exposes only localStorage',
        { localStorage: new FakeSessionStorage() } as unknown as TokenStorageHost,
      ],
      [
        'the key is absent (every tab that exists today)',
        hostWithStorage(new FakeSessionStorage()),
      ],
      ['stored value is null', storageReturning(null)],
      ['stored value is a number', storageReturning(42)],
      ['stored value is an object', storageReturning({ kind: 'account' })],
      ['stored value is the empty string', storageReturning('')],
      ['stored value is blank', storageReturning('   ')],
      ['stored value is an unrecognized string', storageReturning('signed-in')],
      ['stored value is a future kind', storageReturning('service')],
      ['near-miss: uppercase ACCOUNT', storageReturning('ACCOUNT')],
      ['near-miss: capitalised Account', storageReturning('Account')],
      ['near-miss: padded " account "', storageReturning(' account ')],
      ['near-miss: superstring accountX', storageReturning('accountX')],
      ['near-miss: substring accoun', storageReturning('accoun')],
      ['near-miss: JSON-wrapped {"kind":"account"}', storageReturning('{"kind":"account"}')],
      ['the literal anon marker', storageReturning('anon')],
    ];

    for (const [label, host] of cases) {
      expect(() => readAuthKind(host, M21B_URI, M21B_DB), label).not.toThrow();
      expect(readAuthKind(host, M21B_URI, M21B_DB), label).toBe('anon');
    }
  });

  it('★ the marker is scoped by uri AND db (kills a fixed key, and a key derived from one axis)', () => {
    // A marker that leaked across targets would make an `'account'` written for the
    // playtest database refuse the connection to the production one — a cross-target
    // denial-of-service on the anonymous path.
    const storage = new FakeSessionStorage();
    const host = hostWithStorage(storage);
    writeAuthKind(host, 'ws://a:3000', 'same-db', 'account');
    expect(readAuthKind(host, 'ws://a:3000', 'same-db')).toBe('account');
    expect(readAuthKind(host, 'ws://b:3000', 'same-db')).toBe('anon');
    expect(readAuthKind(host, 'ws://a:3000', 'other-db')).toBe('anon');
  });

  it('re-reads storage on EVERY call (kills a module-level memo of the first read)', () => {
    // connection.ts calls readAuthKind once per build(), for the same reason
    // authToken.ts:59-61 requires tokenForNextAttempt() to be read fresh per build: a
    // memoized marker would pin one value for the process lifetime.
    const storage = new FakeSessionStorage();
    const host = hostWithStorage(storage);
    const key = authKindStorageKey(M21B_URI, M21B_DB);
    expect(readAuthKind(host, M21B_URI, M21B_DB)).toBe('anon');
    storage.setItem(key, 'account');
    expect(readAuthKind(host, M21B_URI, M21B_DB)).toBe('account');
    storage.setItem(key, 'anon');
    expect(readAuthKind(host, M21B_URI, M21B_DB)).toBe('anon');
  });
});

// ---------------------------------------------------------------------------
// writeAuthKind — the marker's writer (ADDENDUM S11's named YAGNI exception:
// M21b-2's OIDC return leg is the producer). Mirrors onConnected's degradation.
// ---------------------------------------------------------------------------

describe('writeAuthKind (AUTH-31): writes under the kind key and degrades silently', () => {
  it('★ writes the kind VERBATIM under authKindStorageKey(uri, db), and both kinds round-trip', () => {
    // WRONG IMPL KILLED (a): a no-op writer — the round-trip below reds.
    // WRONG IMPL KILLED (b): a writer that stores a JSON envelope (`{"kind":"account"}`) that
    //   the exact-match reader can never recognise. Pinning the RAW stored value, not just
    //   the round-trip, is what catches a writer/reader pair that agree with each other on a
    //   format the plan did not specify.
    const storage = new FakeSessionStorage();
    const host = hostWithStorage(storage);
    const key = authKindStorageKey(M21B_URI, M21B_DB);

    writeAuthKind(host, M21B_URI, M21B_DB, 'account');
    const accountWrite = storage.calls.find((c) => c.op === 'setItem');
    expect(accountWrite?.key, 'writeAuthKind must write under authKindStorageKey(uri, db)').toBe(
      key,
    );
    expect(accountWrite?.value, 'the stored value must be the bare kind string').toBe('account');
    expect(readAuthKind(host, M21B_URI, M21B_DB)).toBe('account');

    writeAuthKind(host, M21B_URI, M21B_DB, 'anon');
    expect(readAuthKind(host, M21B_URI, M21B_DB)).toBe('anon');
    // Only ONE key is ever occupied: the second write REPLACES, it does not accumulate.
    expect(storage.size).toBe(1);

    // BOTH members of the AuthKind union round-trip, driven off the exported type itself —
    // so a union narrowed to one member (or widened to `string`) stops compiling here, and
    // a writer/reader pair that only agrees on ONE of the two values reds.
    for (const kind of M21B_KINDS) {
      writeAuthKind(host, M21B_URI, M21B_DB, kind);
      expect(readAuthKind(host, M21B_URI, M21B_DB), `round-trip for kind ${kind}`).toBe(kind);
    }
  });

  it('★ degrades silently on every hostile host — never throws, never writes elsewhere', () => {
    // Exactly onConnected's contract (authToken.ts:162-169): a quota/private-mode failure
    // costs the marker, never the live connection. A throw here would escape into build()
    // — the same permanent-freeze mode the module header documents.
    const throwingPropertyHost: TokenStorageHost = {};
    Object.defineProperty(throwingPropertyHost, 'sessionStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    const localOnly = new FakeSessionStorage();
    const hosts: readonly (readonly [string, TokenStorageHost | undefined])[] = [
      ['host is undefined', undefined],
      ['host has no sessionStorage', {}],
      ['sessionStorage property access throws', throwingPropertyHost],
      [
        'setItem throws (Safari private-mode QuotaExceededError)',
        hostWithStorage(new ThrowingSetStorage()),
      ],
      ['setItem is not a function', hostWithStorage({ getItem: 'nope', setItem: 'nope' })],
      [
        'host exposes only localStorage',
        { localStorage: localOnly } as unknown as TokenStorageHost,
      ],
    ];
    for (const [label, host] of hosts) {
      expect(() => writeAuthKind(host, M21B_URI, M21B_DB, 'account'), label).not.toThrow();
      expect(() => writeAuthKind(host, M21B_URI, M21B_DB, 'anon'), label).not.toThrow();
    }
    // ADR-0150 D3: sessionStorage only, NEVER localStorage — a marker on an origin-shared
    // store would leak one tab's auth intent into every other tab of the origin.
    expect(localOnly.calls.some((c) => c.op === 'setItem')).toBe(false);
    expect(localOnly.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ★★ W-M21B-WRITE-HAZARD-DOCUMENTED — the prohibition that makes shipping the
// writer safe must be WRITTEN DOWN, in the file, next to the writer.
//
// THE HAZARD, stated plainly: with the read-side credential guard parked to
// M21b-2 (see the scope ruling in this block's banner), the write-side guard
// ALONE IS NOT SUFFICIENT. Writing the marker as 'account' today means the
// account token is not STORED — correct, that is the guard working — while the
// NEXT build still supplies the stale ANON token through connection.ts's
// unchanged `.withToken(auth.tokenForNextAttempt())`. The player is silently
// dropped onto a DIFFERENT identity: no error, no status line, just someone
// else's save. Nothing in this slice writes 'account', and nothing may, until
// the read side lands.
//
// WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST: a comment has no runtime
// representation, so there is no other way to assert it exists. This is the one
// non-injected assertion in the appended block, and it is deliberately narrow —
// it reads authToken.ts as text and checks three phrases in the region that
// belongs to `writeAuthKind`.
//
// WRONG IMPL KILLED: shipping `writeAuthKind` as an unremarked six-line mirror
// of `onConnected`. The next author — quite reasonably — wires M21b-2's OIDC
// return leg to call it, ships the marker write BEFORE the read-side guard, and
// hands a real player someone else's character. The prohibition is the only
// thing standing between "we shipped half a feature safely" and that outcome,
// and a prohibition nobody wrote down is not a prohibition.
//
// NO `new RegExp(...)` — lowercase + indexOf only.
// ---------------------------------------------------------------------------

const AUTH_TOKEN_TS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'authToken.ts');

function readAuthTokenTs(): string {
  try {
    return readFileSync(AUTH_TOKEN_TS_PATH, 'utf8');
  } catch (err) {
    // Fail loud — a missing file must never make a scan vacuously pass.
    throw new Error(
      'authToken.ts could not be read at expected path: ' +
        AUTH_TOKEN_TS_PATH +
        ' — ' +
        String(err),
    );
  }
}

describe('W-M21B-WRITE-HAZARD-DOCUMENTED: writeAuthKind carries the "no production caller" prohibition', () => {
  it('★★ BITES: the region owning writeAuthKind states that no production caller may write "account" until the read-side guard lands in M21b-2', () => {
    // THE SENTENCE THE IMPLEMENTER MUST WRITE (or a variant containing all three
    // phrases below), as a comment on/above `export function writeAuthKind`:
    //
    //   No production caller may write 'account' until the read-side credential guard
    //   lands (M21b-2). With the read side parked, an 'account' marker means the account
    //   token is correctly NOT stored while the next build still supplies the stale anon
    //   token via .withToken(auth.tokenForNextAttempt()) — a silent drop to a different
    //   identity. This slice ships the writer so the marker is a complete read/write
    //   pair; it is exercised only by tests. (ADDENDUM S11's named YAGNI exception.)
    //
    // RED TODAY: `writeAuthKind` does not exist in authToken.ts, so the region extraction
    // below throws — a HARD red on a missing implementation, never a vacuous pass.
    const raw = readAuthTokenTs();

    const readIdx = raw.indexOf('export function readAuthKind');
    const writeIdx = raw.indexOf('export function writeAuthKind');
    expect(
      readIdx,
      'authToken.ts must export readAuthKind. RED TODAY: it does not exist',
    ).toBeGreaterThanOrEqual(0);
    expect(
      writeIdx,
      'authToken.ts must export writeAuthKind. RED TODAY: it does not exist',
    ).toBeGreaterThanOrEqual(0);
    expect(
      writeIdx,
      'writeAuthKind must be declared AFTER readAuthKind (the read/write pair reads in that ' +
        "order, and the region scanned below is the text between them — writeAuthKind's own " +
        'doc comment sits there)',
    ).toBeGreaterThan(readIdx);

    // The region is RAW (never comment-stripped): this is the one tooth whose entire
    // subject IS a comment. It runs from readAuthKind's declaration to writeAuthKind's,
    // i.e. readAuthKind's body plus the doc comment attached to writeAuthKind — needle
    // bounded, not a fixed-width window.
    const region = raw.slice(readIdx, writeIdx).toLowerCase();
    expect(
      region.length,
      'the readAuthKind → writeAuthKind region collapsed to almost nothing — refusing to ' +
        'scan a degenerate region',
    ).toBeGreaterThan(100);

    for (const phrase of ['no production caller', 'read-side', 'm21b-2']) {
      expect(
        region.indexOf(phrase),
        `authToken.ts must document, in the comment attached to writeAuthKind, the phrase ` +
          `"${phrase}". The prohibition in full: no production caller may write 'account' ` +
          'until the read-side credential guard lands (M21b-2) — with the read side parked, ' +
          'an account marker leaves the NEXT build supplying the stale ANON token through ' +
          'the unchanged .withToken(auth.tokenForNextAttempt()), silently dropping the ' +
          'player onto a different identity. This slice ships the writer only so the marker ' +
          'is a complete read/write pair, exercised by tests alone (ADDENDUM S11).',
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('★ BITES: no OTHER module in this slice calls writeAuthKind — the writer has no production caller yet', () => {
    // The prohibition above is prose; this is its mechanical half. connection.ts is the
    // only file this slice wires, and it must read the marker (W-M21B-KIND-READ in
    // connection.test.ts) and NEVER write it. A `writeAuthKind(` call there would be the
    // exact hazard the comment forbids, shipped.
    const connectionTsPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'connection.ts',
    );
    let connectionSrc: string;
    try {
      connectionSrc = readFileSync(connectionTsPath, 'utf8');
    } catch (err) {
      throw new Error(
        'connection.ts could not be read at expected path: ' +
          connectionTsPath +
          ' — ' +
          String(err),
      );
    }
    // Anti-vacuity: prove we are reading the real adapter before trusting a zero.
    expect(
      connectionSrc.indexOf('export function connect(opts: ConnectionOptions): Connection {'),
      'positive control: connection.ts must still declare connect() — a -1 here means this ' +
        'scan is judging the wrong file and the negative below is vacuous',
    ).toBeGreaterThanOrEqual(0);
    expect(
      connectionSrc.split('writeAuthKind(').length - 1,
      'connection.ts must NOT call writeAuthKind( — with the read-side credential guard ' +
        "parked to M21b-2, writing an 'account' marker leaves the next build supplying the " +
        'stale ANON token and silently drops the player onto a different identity. The ' +
        'producer ships WITH the guard, not before it',
    ).toBe(0);
  });
});
