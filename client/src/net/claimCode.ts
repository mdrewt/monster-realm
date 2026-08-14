// net/claimCode.ts — the guest-claim code primitive (AUTH-60 / AUTH-58, ADR-0182 D16).
//
// The claim code IS the whole secret (ADR-0179 D3: the server never mints one, so its
// entropy is entirely client-side). This module owns three things and nothing else:
//   1. minting a fresh code — exactly 32 bytes of injected CSPRNG, hex-encoded to 64
//      LOWERCASE characters (the server's AUTH-8 shape, accounts.rs:80-82), persisted to
//      per-tab storage BEFORE it is returned;
//   2. reading it back on reconnect (AUTH-53) with parse-don't-validate — a malformed
//      stored value is treated as absent, never as a live code that permanently vetoes join;
//   3. a first-run multi-device nudge flag, kept in the SAME namespace, a disjoint slot.
//
// The storage/crypto HOST is INJECTED (never an ambient reach), exactly as authToken.ts
// does, so every branch — including the throwing storage-property access — is unit-testable
// in node with no DOM. G30 source-scans this file to prove it names no ambient global.
//
// Type-only import (G30 allows this): the runtime dependency graph is EMPTY on purpose — a
// runtime import of authToken.ts's private storageMethod would grow a shared mutable seam
// between two modules with different fail directions (authToken fails to 'anon'; claimCode
// fails to "no code"). We re-derive the tiny helper here instead.

import type { TokenStorageHost } from './authToken';

/** The injected host: `sessionStorage` (per-tab, ADR-0150 D3) plus a `crypto` that may
 *  expose `getRandomValues`. Both typed `unknown` — parse-don't-validate happens below. */
export interface ClaimCodeHost extends TokenStorageHost {
  readonly crypto?: unknown;
}

/** Storage-key namespace. `v1` so a future format change invalidates cleanly. Chosen so
 *  neither it nor `mr.authToken.v1` / `mr.authKind.v1` / `mr.oidcFlow.v1` is a prefix of the
 *  other — a collision would overwrite a reconnect token with a 64-hex code. */
export const CLAIM_CODE_KEY_PREFIX = 'mr.claimCode.v1';

/** The number of RANDOM bytes drawn, and the resulting hex length. 32 bytes → 64 hex chars,
 *  which is exactly `CLAIM_CODE_LEN` (accounts.rs:56). Neither may drift. */
const CODE_BYTE_LENGTH = 32;
const CODE_HEX_LENGTH = 64;

/**
 * Per-target code key. Two axes, each percent-encoded so a `|` inside a value cannot collide
 * two distinct targets onto one key (`encodeURIComponent` escapes `|`, making the derivation
 * injective). Case is PRESERVED — connectionConfig.ts treats `Monster-Realm-Playtest` as a
 * legitimately distinct database. Same construction as authToken.ts's storageKey.
 */
export function claimCodeStorageKey(uri: string, db: string): string {
  return `${CLAIM_CODE_KEY_PREFIX}|${encodeURIComponent(uri)}|${encodeURIComponent(db)}`;
}

/** The first-run nudge slot. Distinct from the code key by construction: the fixed `nudge`
 *  infix gives it one more `|`-segment than any code key, so the two can never collide (a
 *  code key has exactly two `|`; this has exactly three). Same namespace, no new prefix. */
function nudgeStorageKey(uri: string, db: string): string {
  return `${CLAIM_CODE_KEY_PREFIX}|nudge|${encodeURIComponent(uri)}|${encodeURIComponent(db)}`;
}

/** Narrow an unknown storage-ish value to the one method we are about to call. Returns
 *  undefined rather than throwing so every caller degrades silently — the property access
 *  itself can throw SecurityError when site data is blocked, which is why the host is
 *  injected. Mirrors authToken.ts:104-120. */
function storageMethod(
  host: ClaimCodeHost | undefined,
  name: 'getItem' | 'setItem' | 'removeItem',
) {
  try {
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

/** Draw exactly `n` bytes from the injected CSPRNG. Returns undefined — never a Math.random
 *  fallback — when crypto is absent, the wrong shape, or throws: a predictable claim code
 *  would let any observer complete someone else's claim, so we fail CLOSED (AUTH-60). */
function drawRandomBytes(host: ClaimCodeHost | undefined, n: number): Uint8Array | undefined {
  try {
    const source = host?.crypto as { getRandomValues?: unknown } | undefined | null;
    if (typeof source !== 'object' || source === null) return undefined;
    const fn = source.getRandomValues;
    if (typeof fn !== 'function') return undefined;
    const bytes = new Uint8Array(n);
    (fn as (a: Uint8Array) => unknown).call(source, bytes);
    return bytes;
  } catch {
    return undefined;
  }
}

/** Lowercase, zero-padded base16 of every byte. `.toString(16)` is already lowercase; the
 *  `padStart(2, '0')` is what keeps a low byte (0x05) two characters wide so the code is
 *  always 64 chars (a missing pad yields a short code the server rejects). */
function toLowerHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * True iff `raw` is a well-formed claim code: exactly 64 characters, each `0-9` or `a-f`.
 * Matches accounts.rs:80-82's `b'0'..=b'9' | b'a'..=b'f'` byte-for-byte (which deliberately
 * does NOT accept uppercase). Anything else — a number, an object, a blank, a truncated or
 * uppercased or JSON-wrapped value — is treated as absent, so it can never latch a permanent
 * join veto (parse-don't-validate, as tokenForNextAttempt does for a blank token).
 */
function isValidClaimCode(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length !== CODE_HEX_LENGTH) return false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    const isDigit = c >= 0x30 && c <= 0x39;
    const isLowerAf = c >= 0x61 && c <= 0x66;
    if (!isDigit && !isLowerAf) return false;
  }
  return true;
}

/**
 * The claim-code storage primitive, exported as a NAMED OBJECT so connection.ts can call
 * `claimCode.hasUnconsumed(...)` without an `import *` (banned by G14). Every method degrades
 * silently on a hostile/blocked/absent host and fails to the SAFE direction (no code, no
 * veto). `read` re-reads storage on every call — the join gate depends on a FRESH read inside
 * every `onApplied`, so a memo here would defeat that from underneath (ADR-0182 anti-pattern #3).
 */
export const claimCode = {
  /** Mint a fresh code, persist it BEFORE returning, and return it — or `undefined` if it
   *  could not be drawn or could not be persisted. Never returns a code the tab cannot
   *  re-issue: a stored-but-unremembered claim strands the guest's progress. */
  mint(host: ClaimCodeHost | undefined, uri: string, db: string): string | undefined {
    const bytes = drawRandomBytes(host, CODE_BYTE_LENGTH);
    if (bytes === undefined) return undefined;
    const code = toLowerHex(bytes);
    const setItem = storageMethod(host, 'setItem');
    if (setItem === undefined) return undefined;
    try {
      setItem(claimCodeStorageKey(uri, db), code);
    } catch {
      return undefined;
    }
    return code;
  },

  /** The stored code for this target, or `undefined` if absent or malformed. */
  read(host: ClaimCodeHost | undefined, uri: string, db: string): string | undefined {
    const getItem = storageMethod(host, 'getItem');
    if (getItem === undefined) return undefined;
    try {
      const raw = getItem(claimCodeStorageKey(uri, db));
      return isValidClaimCode(raw) ? raw : undefined;
    } catch {
      return undefined;
    }
  },

  /** True iff a re-issuable code is stored — defined as `read(...) !== undefined` so the veto
   *  and the reissue can never disagree. */
  hasUnconsumed(host: ClaimCodeHost | undefined, uri: string, db: string): boolean {
    return claimCode.read(host, uri, db) !== undefined;
  },

  /** Remove the stored code (declining or completing a claim). Silent no-op on an empty
   *  store; does NOT touch the nudge slot. */
  clear(host: ClaimCodeHost | undefined, uri: string, db: string): void {
    const removeItem = storageMethod(host, 'removeItem');
    if (removeItem === undefined) return;
    try {
      removeItem(claimCodeStorageKey(uri, db));
    } catch {
      // Silent degradation — the live connection is unaffected.
    }
  },

  /** Whether this tab has already shown the first-run multi-device nudge. Fails to `false`
   *  (show it) on every lossy path. */
  hasSeenFirstRunNudge(host: ClaimCodeHost | undefined, uri: string, db: string): boolean {
    const getItem = storageMethod(host, 'getItem');
    if (getItem === undefined) return false;
    try {
      return getItem(nudgeStorageKey(uri, db)) === '1';
    } catch {
      return false;
    }
  },

  /** Record that the nudge has been shown. Idempotent; silent on a blocked host. */
  markFirstRunNudgeSeen(host: ClaimCodeHost | undefined, uri: string, db: string): void {
    const setItem = storageMethod(host, 'setItem');
    if (setItem === undefined) return;
    try {
      setItem(nudgeStorageKey(uri, db), '1');
    } catch {
      // Silent degradation — at worst the nudge shows again next tab.
    }
  },
};
