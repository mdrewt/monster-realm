// net/claimCode.test.ts — AUTH-60 / AUTH-58 + G30 (half) (M21b-2, ADR-0182 D16).
//
// EARS COVERED
//   AUTH-60 — WHEN the client mints a claim code it SHALL generate EXACTLY 32 bytes via
//             `crypto.getRandomValues`, hex-encode them to 64 LOWERCASE hex characters
//             (matching the server's AUTH-8 validation, `accounts.rs:80-82`
//             `is_valid_claim_code`), and write the code to this tab's sessionStorage
//             BEFORE `start_guest_claim` is called.
//   AUTH-58 — no OIDC state / code_verifier / refresh token / CLAIM CODE may be persisted
//             in `localStorage`; per-tab sessionStorage only (ADR-0150 D3).
//   AUTH-52/53 — the stored code is what makes the join-veto survive a reconnect, so
//             `read`/`hasUnconsumed` must agree with each other and must never report a
//             code the tab cannot actually re-issue.
//   G30 (half) — claimCode.ts reaches NO ambient storage: no `localStorage`, no
//             `indexedDB`, no `document.cookie`, no `globalThis`; the host is a PARAMETER.
//             (oidc.test.ts carries the other half for oidc.ts.)
//
// RED REASON AT HEAD (8814416): `client/src/net/claimCode.ts` DOES NOT EXIST. The import
// below fails to resolve and every test in this file reds on a MISSING IMPLEMENTATION,
// not on a typo here. The source-scan block reds on `readFileSync` throwing loudly for
// the same reason (it fails loud rather than passing vacuously).
//
// THE CONTRACT THE IMPLEMENTER BUILDS:
//
//   import type { TokenStorageHost } from './authToken';   // TYPE-ONLY (G30 allows this)
//
//   export interface ClaimCodeHost extends TokenStorageHost { readonly crypto?: unknown }
//   export const CLAIM_CODE_KEY_PREFIX = 'mr.claimCode.v1';
//   export function claimCodeStorageKey(uri: string, db: string): string;
//     // `${CLAIM_CODE_KEY_PREFIX}|${encodeURIComponent(uri)}|${encodeURIComponent(db)}`
//   export const claimCode: {
//     mint(host, uri, db): string | undefined;
//     read(host, uri, db): string | undefined;
//     hasUnconsumed(host, uri, db): boolean;
//     clear(host, uri, db): void;
//     hasSeenFirstRunNudge(host, uri, db): boolean;
//     markFirstRunNudgeSeen(host, uri, db): void;
//   };
//
// WHY A NAMESPACE OBJECT AND NOT SIX BARE EXPORTS: ADR-0182 D16's join-gate code is pinned
// by G18 as the contiguous statement
// `const codeUnconsumed = claimCode.hasUnconsumed(globalThis, opts.uri, opts.db);`, and
// G14 (plan ADDENDUM §C, F3) bans `import *` in connection.ts. A NAMED export called
// `claimCode` satisfies both at once.
//
// PURE NODE UNIT TEST — every storage/crypto host is INJECTED, exactly as the 27
// pre-existing tests in authToken.test.ts do. No DOM, no jsdom, no real sessionStorage.
// The fake-storage family below (FakeSessionStorage / ThrowingSetStorage /
// ThrowingGetStorage / hostWithStorage / storageReturning) is REUSED VERBATIM from
// authToken.test.ts:41-94 rather than re-invented — the plan's R8 names a parallel helper
// family as a known failure mode (connection.test.ts:191-197 records the same mistake).
//
// NO `new RegExp(...)` anywhere (Semgrep `detect-non-literal-regexp`, banned repo-wide).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLAIM_CODE_KEY_PREFIX, claimCode, claimCodeStorageKey } from './claimCode';

// ---------------------------------------------------------------------------
// Fake hosts — copied VERBATIM in behaviour from authToken.test.ts:41-94.
// ---------------------------------------------------------------------------

interface StorageCall {
  readonly op: 'getItem' | 'setItem' | 'removeItem';
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

  removeItem(key: string): void {
    this.calls.push({ op: 'removeItem', key });
    this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(): string[] {
    return [...this.store.keys()];
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
  removeItem(): void {}
}

/** A `sessionStorage.getItem` that always throws — corrupted/hostile storage backend. */
class ThrowingGetStorage {
  getItem(): string {
    throw new Error('boom');
  }
  setItem(): void {}
  removeItem(): void {}
}

/** A deterministic `crypto.getRandomValues` that records every requested byte length.
 *  Deterministic ON PURPOSE: the hex encoding is asserted against an EXACT expected
 *  string, which is what kills a missing zero-pad and an uppercase encoder. */
class RecordingCrypto {
  readonly requestedByteLengths: number[] = [];
  constructor(private readonly fill: (index: number) => number) {}

  getRandomValues<T extends ArrayBufferView>(array: T): T {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    this.requestedByteLengths.push(array.byteLength);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = this.fill(i) & 0xff;
    return array;
  }
}

class ThrowingCrypto {
  getRandomValues(): never {
    throw new Error('SecurityError');
  }
}

interface ClaimHostShape {
  readonly sessionStorage?: unknown;
  readonly crypto?: unknown;
}

function hostWith(sessionStorage: unknown, crypto?: unknown): ClaimHostShape {
  return { sessionStorage, crypto };
}

/** A minimal fake `sessionStorage` whose `getItem` returns a fixed raw value verbatim. */
function storageReturning(raw: unknown): ClaimHostShape {
  return {
    sessionStorage: {
      getItem: () => raw,
      setItem: () => {},
      removeItem: () => {},
    },
    crypto: new RecordingCrypto(() => 0),
  };
}

const URI = 'ws://127.0.0.1:3000';
const DB = 'monster-realm';

/** Bytes 0x00..0x1f — the canonical fixture: it exercises the zero-pad (0x00 -> '00',
 *  0x05 -> '05') and the a-f range (0x0a -> '0a') in one 32-byte draw. */
const ASCENDING_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const HEX_ALPHABET = '0123456789abcdef';

function ascendingCryptoHost(storage: FakeSessionStorage): ClaimHostShape {
  return hostWith(storage, new RecordingCrypto((i) => i));
}

// ---------------------------------------------------------------------------
// AUTH-60 — the mint: exactly 32 bytes, 64 lowercase hex.
// ---------------------------------------------------------------------------

describe('claimCode.mint (AUTH-60): exactly 32 bytes of crypto.getRandomValues, hex-encoded', () => {
  it('★★ BITES: requests EXACTLY ONE 32-byte draw — kills a 16-byte (halved entropy) and a 64-byte draw', () => {
    // The server accepts a 64-CHARACTER code (`CLAIM_CODE_LEN = 64`, accounts.rs:56), so an
    // implementation that draws 64 BYTES and hex-encodes them produces 128 characters and
    // is rejected by `is_valid_claim_code` — a bug the mint itself cannot see. Worse in the
    // other direction: 16 bytes hex-encoded is 32 characters, ALSO rejected; and 32 bytes
    // rendered as base16 of a 16-byte draw padded to 64 characters would pass the shape
    // check while carrying HALF the entropy the ADR-0179 D3 threat model assumes (the code
    // is the whole secret — server RNG is never used).
    const storage = new FakeSessionStorage();
    const crypto = new RecordingCrypto((i) => i);
    const code = claimCode.mint(hostWith(storage, crypto), URI, DB);
    expect(code).toBeDefined();
    expect(crypto.requestedByteLengths, 'exactly one getRandomValues draw').toHaveLength(1);
    expect(crypto.requestedByteLengths[0], 'the draw must be exactly 32 bytes').toBe(32);
  });

  it('★★ BITES: 32 known bytes hex-encode to the EXACT expected 64-char string — kills a missing zero-pad and an uppercase encoder', () => {
    // WRONG IMPL KILLED (a): `bytes[i].toString(16)` with no `.padStart(2, "0")`. Every byte
    //   below 0x10 renders as ONE character, so the ascending fixture yields 58 characters,
    //   not 64 — and `is_valid_claim_code` rejects it server-side, meaning
    //   `start_guest_claim` fails for a random-looking subset of players (any code whose
    //   draw contains a low byte — i.e. almost all of them).
    // WRONG IMPL KILLED (b): `.toUpperCase()` / `Buffer.from(b).toString('hex').toUpperCase()`.
    //   accounts.rs:80-82 matches `b'0'..=b'9' | b'a'..=b'f'` and deliberately does NOT use
    //   `is_ascii_hexdigit`, so an uppercase code is rejected outright.
    // WRONG IMPL KILLED (c): base64url / base64 encoding of the same bytes (43/44 chars,
    //   and carries characters outside the hex alphabet).
    const storage = new FakeSessionStorage();
    const code = claimCode.mint(ascendingCryptoHost(storage), URI, DB);
    expect(code).toBe(ASCENDING_HEX);
    expect(code as string).toHaveLength(64);
  });

  it('★ BITES: an all-0xff draw yields 64 lowercase "f"s (kills a toUpperCase that the ascending fixture alone would miss)', () => {
    // The ascending fixture's high nibbles never exceed 0x1f, so its only a-f characters
    // come from LOW nibbles. This fixture puts a-f in BOTH nibble positions.
    const storage = new FakeSessionStorage();
    const code = claimCode.mint(hostWith(storage, new RecordingCrypto(() => 0xff)), URI, DB);
    expect(code).toBe('ff'.repeat(32));
  });

  it('★ BITES: every character is in the server-accepted alphabet 0-9a-f (the AUTH-8 shape, stated independently of the two fixtures above)', () => {
    const storage = new FakeSessionStorage();
    const code = claimCode.mint(
      hostWith(storage, new RecordingCrypto((i) => (i * 37) & 0xff)),
      URI,
      DB,
    ) as string;
    expect(code).toHaveLength(64);
    for (const ch of code) {
      expect(
        HEX_ALPHABET.indexOf(ch),
        `character ${JSON.stringify(ch)} is not lowercase hex`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('★★ BITES: the code is IN STORAGE by the time mint returns — kills a mint that returns first and persists later', () => {
    // AUTH-60's ordering clause exists because `start_guest_claim` is called with the
    // returned code: if the write has not happened yet (or is deferred to a microtask), a
    // reload between the reducer call and the write leaves a LIVE server-side claim whose
    // code this tab can never re-issue (AUTH-53's reconnect reissue reads storage) and
    // never complete — the guest's progress is stranded until the reaper expires it.
    const storage = new FakeSessionStorage();
    const code = claimCode.mint(ascendingCryptoHost(storage), URI, DB) as string;
    expect(
      storage.has(claimCodeStorageKey(URI, DB)),
      'the code must be persisted BEFORE mint returns',
    ).toBe(true);
    expect(claimCode.read(hostWith(storage), URI, DB)).toBe(code);
  });

  it('★★ BITES: mint returns undefined when the code could NOT be persisted — never a code the tab cannot remember', () => {
    // THE FAIL-SAFE DIRECTION. If mint handed back a code it failed to store, the caller
    // would call `start_guest_claim` and mint a real server-side claim that this tab can
    // neither re-issue on reconnect nor complete. Returning undefined lets the caller
    // refuse to start the claim at all — a visible "claim unavailable" beats an invisible
    // stranded claim.
    //
    // WRONG IMPL KILLED: `const code = hex(...); write(code); return code;` with the write
    // failing silently (the house degradation style everywhere else in this module family).
    // Silent degradation is right for a MARKER and wrong for the only copy of a secret.
    for (const [label, host] of [
      ['host is undefined', undefined],
      ['host has no sessionStorage', { crypto: new RecordingCrypto((i) => i) } as ClaimHostShape],
      [
        'setItem throws (private mode quota)',
        hostWith(new ThrowingSetStorage(), new RecordingCrypto((i) => i)),
      ],
      [
        'setItem is not a function',
        hostWith({ getItem: 'nope', setItem: 'nope' }, new RecordingCrypto((i) => i)),
      ],
    ] as readonly (readonly [string, ClaimHostShape | undefined])[]) {
      expect(() => claimCode.mint(host, URI, DB), label).not.toThrow();
      expect(claimCode.mint(host, URI, DB), label).toBeUndefined();
    }
  });

  it('★ BITES: mint returns undefined and does not throw when crypto is absent or throws (kills a Math.random fallback)', () => {
    // WRONG IMPL KILLED: `?? Math.random()`-derived entropy when `crypto` is missing. The
    // claim code IS the whole secret (ADR-0179 D3: server RNG is never a CSPRNG here), so
    // a predictable code lets any observer complete someone else's claim. Failing closed
    // is the only acceptable behaviour.
    const storage = new FakeSessionStorage();
    for (const [label, host] of [
      ['no crypto at all', hostWith(storage, undefined)],
      ['crypto is not an object', hostWith(storage, 42)],
      ['getRandomValues is not a function', hostWith(storage, { getRandomValues: 'nope' })],
      ['getRandomValues throws', hostWith(storage, new ThrowingCrypto())],
    ] as readonly (readonly [string, ClaimHostShape])[]) {
      expect(() => claimCode.mint(host, URI, DB), label).not.toThrow();
      expect(claimCode.mint(host, URI, DB), label).toBeUndefined();
      expect(storage.size, `${label}: nothing may be written when no code was minted`).toBe(0);
    }
  });

  it('★ BITES: a second mint REPLACES the stored code (kills a write-only-if-empty mint that strands the new code)', () => {
    const storage = new FakeSessionStorage();
    const first = claimCode.mint(hostWith(storage, new RecordingCrypto(() => 0x11)), URI, DB);
    const second = claimCode.mint(hostWith(storage, new RecordingCrypto(() => 0x22)), URI, DB);
    expect(first).toBe('11'.repeat(32));
    expect(second).toBe('22'.repeat(32));
    expect(claimCode.read(hostWith(storage), URI, DB)).toBe(second);
    expect(storage.size, 'the second mint must replace, not accumulate').toBe(1);
  });
});

// ---------------------------------------------------------------------------
// read / hasUnconsumed / clear — the join-veto's storage half (AUTH-52/53).
// ---------------------------------------------------------------------------

describe('claimCode read / hasUnconsumed / clear (AUTH-52/53)', () => {
  it('★★ BITES: mint -> hasUnconsumed true -> clear -> hasUnconsumed false, read undefined', () => {
    // The full lifecycle the join gate depends on. WRONG IMPL KILLED: a `clear` that writes
    // an empty string instead of removing the key — `hasUnconsumed` would then have to
    // treat `''` as absent, and any reader that does not would veto `join_game` FOREVER
    // (F2 re-opened: the player can never join again on this tab).
    const storage = new FakeSessionStorage();
    const code = claimCode.mint(ascendingCryptoHost(storage), URI, DB) as string;
    const host = hostWith(storage);

    expect(claimCode.hasUnconsumed(host, URI, DB)).toBe(true);
    expect(claimCode.read(host, URI, DB)).toBe(code);

    claimCode.clear(host, URI, DB);

    expect(claimCode.hasUnconsumed(host, URI, DB)).toBe(false);
    expect(claimCode.read(host, URI, DB)).toBeUndefined();
  });

  it('★★ BITES: a MALFORMED stored value is not "unconsumed" — kills a permanent join veto on garbage', () => {
    // THE LATCH THIS PREVENTS: `hasUnconsumed` returning true for any non-empty stored
    // string. A truncated / uppercased / schema-drifted value can never be completed by
    // `complete_guest_claim` (accounts.rs:390 rejects it as ERR_INVALID_CODE before the
    // code is even looked up), so an account-class connection on this tab would be vetoed
    // from `join_game` on EVERY reconnect, forever, with no way for the player to recover.
    // Parse-don't-validate, exactly as `tokenForNextAttempt` does for a blank token
    // (authToken.ts:147-150).
    const malformed: readonly (readonly [string, unknown])[] = [
      ['null (key absent)', null],
      ['a number', 42],
      ['an object', { code: ASCENDING_HEX }],
      ['the empty string', ''],
      ['blank', '   '],
      ['too short (63 chars)', ASCENDING_HEX.slice(1)],
      ['too long (65 chars)', `${ASCENDING_HEX}a`],
      ['uppercase hex (server rejects: no is_ascii_hexdigit)', ASCENDING_HEX.toUpperCase()],
      ['non-hex characters', 'g'.repeat(64)],
      ['padded with whitespace', ` ${ASCENDING_HEX.slice(1)} `],
      ['JSON-wrapped', `{"code":"${ASCENDING_HEX}"}`],
    ];
    for (const [label, raw] of malformed) {
      const host = storageReturning(raw);
      expect(claimCode.read(host, URI, DB), label).toBeUndefined();
      expect(claimCode.hasUnconsumed(host, URI, DB), label).toBe(false);
    }
  });

  it('★ BITES: hasUnconsumed ALWAYS agrees with read (property) — kills a second, divergent validity check', () => {
    // Two independent implementations of "is there a live code" is how the veto and the
    // reissue end up disagreeing: `shouldJoin` says "vetoed" while `read()!` (ADR-0182
    // D16's reissue arm) returns undefined and throws inside the onApplied callback.
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const host = storageReturning(raw);
        expect(claimCode.hasUnconsumed(host, URI, DB)).toBe(
          claimCode.read(host, URI, DB) !== undefined,
        );
      }),
    );
  });

  it('★ BITES: a well-formed 64-lowercase-hex value seeded directly under the key round-trips (anti-vacuity for the negatives above)', () => {
    // Without this, every malformed-value assertion is satisfied by `read: () => undefined`.
    const storage = new FakeSessionStorage();
    storage.setItem(claimCodeStorageKey(URI, DB), ASCENDING_HEX);
    const host = hostWith(storage);
    expect(claimCode.read(host, URI, DB)).toBe(ASCENDING_HEX);
    expect(claimCode.hasUnconsumed(host, URI, DB)).toBe(true);
  });

  it('★ BITES: read re-reads storage on EVERY call (kills a module-level memo that survives a clear)', () => {
    // ADR-0182's anti-pattern #3: the code check is read FRESH inside every `onApplied`.
    // A memo here would defeat that from underneath, no matter how correctly connection.ts
    // is wired, and G18's source scan cannot see it.
    const storage = new FakeSessionStorage();
    const host = hostWith(storage);
    const key = claimCodeStorageKey(URI, DB);
    expect(claimCode.read(host, URI, DB)).toBeUndefined();
    storage.setItem(key, ASCENDING_HEX);
    expect(claimCode.read(host, URI, DB)).toBe(ASCENDING_HEX);
    storage.setItem(key, 'ff'.repeat(32));
    expect(claimCode.read(host, URI, DB)).toBe('ff'.repeat(32));
  });

  it('★ BITES: clear on an empty store is a silent no-op (kills a clear that throws when the key is absent)', () => {
    const storage = new FakeSessionStorage();
    expect(() => claimCode.clear(hostWith(storage), URI, DB)).not.toThrow();
    expect(storage.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Key derivation + per-segment encoding injectivity.
// ---------------------------------------------------------------------------

describe('claimCodeStorageKey: namespaced under mr.claimCode.v1, injective per segment', () => {
  it('★ BITES: the prefix is exactly `mr.claimCode.v1` and the key starts with it', () => {
    expect(CLAIM_CODE_KEY_PREFIX).toBe('mr.claimCode.v1');
    expect(claimCodeStorageKey(URI, DB).indexOf(CLAIM_CODE_KEY_PREFIX)).toBe(0);
  });

  it('★ BITES: neither this prefix nor the authToken/authKind prefixes is a prefix of the other (structural key-space disjointness)', () => {
    // The same construction authToken.ts:215-224 argues by hand: disjointness must be
    // STRUCTURAL, not a subtle argument about which character follows a shared head. A
    // collision here would overwrite a player's reconnect token with a 64-hex claim code —
    // which `tokenForNextAttempt()` would then hand straight to `.withToken()`.
    for (const other of ['mr.authToken.v1', 'mr.authKind.v1', 'mr.oidcFlow.v1']) {
      expect(CLAIM_CODE_KEY_PREFIX.startsWith(other), `vs ${other}`).toBe(false);
      expect(other.startsWith(CLAIM_CODE_KEY_PREFIX), `vs ${other}`).toBe(false);
    }
  });

  it('★★ BITES: per-segment encoding — `a|b`+`c` and `a`+`b|c` derive DIFFERENT keys (kills naive concatenation)', () => {
    // The exact adversarial fixture authToken.test.ts:194 and :738 use. A naive
    // `${PREFIX}|${uri}|${db}` collides these two DIFFERENT connection targets onto one
    // key, so a code minted for the playtest database would be read back as the live one's.
    expect(claimCodeStorageKey('a|b', 'c')).not.toBe(claimCodeStorageKey('a', 'b|c'));
    // Each axis is load-bearing on its own. Two distinct loopback PORTS, not two
    // hostnames — the file's own idiom (Semgrep's detect-insecure-websocket exempts
    // loopback and the property under test is only that the URIs differ).
    expect(claimCodeStorageKey('ws://127.0.0.1:3000', 'same-db')).not.toBe(
      claimCodeStorageKey('ws://127.0.0.1:3001', 'same-db'),
    );
    expect(claimCodeStorageKey('same-uri', 'db-A')).not.toBe(
      claimCodeStorageKey('same-uri', 'db-B'),
    );
    // Case is PRESERVED (connectionConfig.ts treats `Monster-Realm-Playtest` as a
    // legitimately distinct database).
    expect(claimCodeStorageKey('same-uri', 'DB')).not.toBe(claimCodeStorageKey('same-uri', 'db'));
  });

  it('★★ BITES (property): DISTINCT (uri, db) pairs always derive DISTINCT keys', () => {
    // The `|`-collision argument authToken.ts:96-99 makes in prose, made mechanical over
    // arbitrary inputs — including the separator character itself, which fast-check's
    // string generator produces freely.
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (u1, d1, u2, d2) => {
        if (u1 === u2 && d1 === d2) {
          expect(claimCodeStorageKey(u1, d1)).toBe(claimCodeStorageKey(u2, d2));
          return;
        }
        expect(claimCodeStorageKey(u1, d1)).not.toBe(claimCodeStorageKey(u2, d2));
      }),
    );
  });

  it('★ BITES: two targets do not see each other codes end to end (the behavioural form of the key axes)', () => {
    const storage = new FakeSessionStorage();
    claimCode.mint(
      hostWith(storage, new RecordingCrypto(() => 0xaa)),
      'ws://127.0.0.1:3000',
      'same-db',
    );
    const host = hostWith(storage);
    expect(claimCode.read(host, 'ws://127.0.0.1:3000', 'same-db')).toBe('aa'.repeat(32));
    expect(claimCode.read(host, 'ws://127.0.0.1:3001', 'same-db')).toBeUndefined();
    expect(claimCode.read(host, 'ws://127.0.0.1:3000', 'other-db')).toBeUndefined();
    expect(claimCode.hasUnconsumed(host, 'ws://127.0.0.1:3001', 'same-db')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// First-run multi-device nudge — a boolean in the SAME namespace, no new prefix.
// (ADR-0182 D16: task-checklist item only, deliberately no EARS criterion —
// ADR-0179 D8 item 6 scoped the copy decisions out of EARS coverage.)
// ---------------------------------------------------------------------------

describe('claimCode first-run nudge flag: same mr.claimCode.v1 namespace, disjoint slot', () => {
  it('★★ BITES: the nudge flag lives under a key starting with CLAIM_CODE_KEY_PREFIX — no new key prefix', () => {
    // ADR-0182 D16 states this explicitly ("tracked by a boolean in the same
    // mr.claimCode.v1 storage namespace, not a new key"). A third namespace would be a
    // third thing to reason about for AUTH-58's localStorage ban and for any future
    // storage-clearing path.
    const storage = new FakeSessionStorage();
    claimCode.markFirstRunNudgeSeen(hostWith(storage), URI, DB);
    expect(storage.keys().length).toBeGreaterThanOrEqual(1);
    for (const key of storage.keys()) {
      expect(
        key.indexOf(CLAIM_CODE_KEY_PREFIX),
        `key ${key} must be in the claim-code namespace`,
      ).toBe(0);
    }
  });

  it('★★ BITES: the nudge slot and the CODE slot are DIFFERENT keys — neither write clobbers the other, in either order', () => {
    // WRONG IMPL KILLED: reusing `claimCodeStorageKey(uri, db)` for the flag. The nudge
    // write would replace the live claim code with `'1'`/`'true'`, `read()` would then
    // return undefined (malformed), the join veto would lift, and the guest's progress
    // would be stranded — a data-loss bug caused by a UI-copy flag.
    for (const order of ['code-first', 'nudge-first'] as const) {
      const storage = new FakeSessionStorage();
      const host = hostWith(storage, new RecordingCrypto(() => 0x3c));
      const writeCode = (): void => {
        claimCode.mint(host, URI, DB);
      };
      const writeNudge = (): void => claimCode.markFirstRunNudgeSeen(host, URI, DB);
      if (order === 'code-first') {
        writeCode();
        writeNudge();
      } else {
        writeNudge();
        writeCode();
      }
      expect(
        claimCode.read(host, URI, DB),
        `${order}: the nudge write must not touch the code slot`,
      ).toBe('3c'.repeat(32));
      expect(
        claimCode.hasSeenFirstRunNudge(host, URI, DB),
        `${order}: the code write must not touch the nudge slot`,
      ).toBe(true);
      expect(storage.size, `${order}: two distinct keys must be occupied`).toBe(2);
    }
  });

  it('★ BITES: hasSeenFirstRunNudge is false before it is marked and true after (shown ONCE per tab)', () => {
    const storage = new FakeSessionStorage();
    const host = hostWith(storage);
    expect(claimCode.hasSeenFirstRunNudge(host, URI, DB)).toBe(false);
    claimCode.markFirstRunNudgeSeen(host, URI, DB);
    expect(claimCode.hasSeenFirstRunNudge(host, URI, DB)).toBe(true);
    // Idempotent: marking twice is not an error and does not accumulate keys.
    claimCode.markFirstRunNudgeSeen(host, URI, DB);
    expect(claimCode.hasSeenFirstRunNudge(host, URI, DB)).toBe(true);
    expect(storage.size).toBe(1);
  });

  it('★ BITES: the nudge flag is scoped per (uri, db) like everything else in this module', () => {
    const storage = new FakeSessionStorage();
    const host = hostWith(storage);
    claimCode.markFirstRunNudgeSeen(host, 'ws://127.0.0.1:3000', 'same-db');
    expect(claimCode.hasSeenFirstRunNudge(host, 'ws://127.0.0.1:3000', 'same-db')).toBe(true);
    expect(claimCode.hasSeenFirstRunNudge(host, 'ws://127.0.0.1:3001', 'same-db')).toBe(false);
    expect(claimCode.hasSeenFirstRunNudge(host, 'ws://127.0.0.1:3000', 'other-db')).toBe(false);
  });

  it('★ BITES: clear() does NOT reset the nudge flag (the nudge is per tab, the code is per claim)', () => {
    // Declining or completing a claim deletes the CODE. Re-showing the multi-device nudge
    // afterwards would nag the player on every subsequent claim in the same tab.
    const storage = new FakeSessionStorage();
    const host = hostWith(storage, new RecordingCrypto(() => 0x7e));
    claimCode.mint(host, URI, DB);
    claimCode.markFirstRunNudgeSeen(host, URI, DB);
    claimCode.clear(host, URI, DB);
    expect(claimCode.read(host, URI, DB)).toBeUndefined();
    expect(claimCode.hasSeenFirstRunNudge(host, URI, DB)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AUTH-58 + storage degradation — sessionStorage only, never throws.
// ---------------------------------------------------------------------------

describe('claimCode (AUTH-58): sessionStorage only, and every path degrades silently', () => {
  it('★★ BITES: a host exposing ONLY localStorage is never touched by ANY entry point', () => {
    // AUTH-58 / ADR-0150 D3. An origin-shared claim code is worse than an origin-shared
    // token: a second tab would read a code minted for a DIFFERENT guest identity and
    // veto its own `join_game` against a claim it can never complete.
    const localFake = new FakeSessionStorage();
    const host = {
      localStorage: localFake,
      crypto: new RecordingCrypto((i) => i),
    } as unknown as ClaimHostShape;

    expect(claimCode.mint(host, URI, DB)).toBeUndefined();
    expect(claimCode.read(host, URI, DB)).toBeUndefined();
    expect(claimCode.hasUnconsumed(host, URI, DB)).toBe(false);
    expect(claimCode.hasSeenFirstRunNudge(host, URI, DB)).toBe(false);
    expect(() => claimCode.clear(host, URI, DB)).not.toThrow();
    expect(() => claimCode.markFirstRunNudgeSeen(host, URI, DB)).not.toThrow();

    expect(localFake.calls, 'localStorage must never be read or written').toEqual([]);
    expect(localFake.size).toBe(0);
  });

  it('★★ BITES: every entry point degrades silently over the whole hostile-host family — no throw escapes', () => {
    // A throw from ANY of these escapes into `.onApplied` (the join gate reads
    // `hasUnconsumed` there) and takes down the subscription-applied callback: the
    // client would be connected with no join, no claim reissue and no error.
    // The host family is the one authToken.test.ts:899-946 already enumerates.
    const throwingPropertyHost: ClaimHostShape = { crypto: new RecordingCrypto((i) => i) };
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

    const hosts: readonly (readonly [string, ClaimHostShape | undefined])[] = [
      ['host is undefined', undefined],
      ['host has no sessionStorage', { crypto: new RecordingCrypto((i) => i) }],
      ['sessionStorage property access throws (cookies blocked)', throwingPropertyHost],
      [
        'sessionStorage is a Proxy whose get trap throws',
        hostWith(throwingProxyStorage, new RecordingCrypto((i) => i)),
      ],
      ['sessionStorage is not an object (number)', hostWith(42, new RecordingCrypto((i) => i))],
      ['sessionStorage is null', hostWith(null, new RecordingCrypto((i) => i))],
      [
        'getItem/setItem are not functions',
        hostWith({ getItem: 'nope', setItem: 'nope' }, new RecordingCrypto((i) => i)),
      ],
      ['getItem throws', hostWith(new ThrowingGetStorage(), new RecordingCrypto((i) => i))],
      ['setItem throws (quota)', hostWith(new ThrowingSetStorage(), new RecordingCrypto((i) => i))],
    ];

    for (const [label, host] of hosts) {
      expect(() => claimCode.mint(host, URI, DB), `mint: ${label}`).not.toThrow();
      expect(() => claimCode.read(host, URI, DB), `read: ${label}`).not.toThrow();
      expect(() => claimCode.hasUnconsumed(host, URI, DB), `hasUnconsumed: ${label}`).not.toThrow();
      expect(() => claimCode.clear(host, URI, DB), `clear: ${label}`).not.toThrow();
      expect(
        () => claimCode.hasSeenFirstRunNudge(host, URI, DB),
        `nudge read: ${label}`,
      ).not.toThrow();
      expect(
        () => claimCode.markFirstRunNudgeSeen(host, URI, DB),
        `nudge write: ${label}`,
      ).not.toThrow();

      // And the fail direction is the SAFE one everywhere: no code, no veto.
      expect(claimCode.read(host, URI, DB), `read: ${label}`).toBeUndefined();
      expect(claimCode.hasUnconsumed(host, URI, DB), `hasUnconsumed: ${label}`).toBe(false);
      expect(claimCode.hasSeenFirstRunNudge(host, URI, DB), `nudge read: ${label}`).toBe(false);
    }
  });
});

// ===========================================================================
// G30 (half) — SOURCE SCAN of claimCode.ts.
//
// WHY A SOURCE SCAN AT ALL, when everything above is behavioural: the behaviour
// tests prove the module BEHAVES correctly for the hosts they inject. They cannot
// prove it never reaches PAST the host — a module that reads `globalThis
// .sessionStorage` as a FALLBACK when `host` is undefined passes every "host is
// undefined" assertion above under vitest (node has no sessionStorage global) and
// then quietly uses the real per-origin store in a browser. Only a source scan sees
// that. This is the same split-of-duties connection.test.ts:43-49 documents.
//
// NAMED RESIDUAL (same honesty as the plan's G26 note): a substring scan cannot see
// bracket/string-splitting evasion — `globalThis['session' + 'Storage']` and
// `(0, eval)('localStorage')` both pass every count below. What the scan guarantees
// is precisely: the shipped source does not NAME the banned surfaces. The behavioural
// half above is what makes the evasion pointless (the injected host is the only thing
// the tests ever populate), and review is the honest place to catch a deliberate one.
//
// NO `new RegExp(...)` — indexOf / split only.
// ===========================================================================

const CLAIM_CODE_TS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claimCode.ts');

function readSourceOrThrow(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    // Fail loud — a missing file must never make a scan vacuously pass.
    throw new Error(`could not read ${filePath} — ${String(err)}`);
  }
}

/** Count NON-OVERLAPPING occurrences via split (no `new RegExp`). The verbatim
 *  main.wiring.test.ts:2557-2560 / connection.test.ts:195-197 form. */
function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

/** Drop `/* ... *\/` block comments, then `//` line comments — copied in behaviour from
 *  connection.test.ts:95-122 so the two source scans cannot drift apart. */
function stripComments(src: string): string {
  let withoutBlocks = '';
  let i = 0;
  for (;;) {
    const start = src.indexOf('/*', i);
    if (start === -1) {
      withoutBlocks += src.slice(i);
      break;
    }
    withoutBlocks += src.slice(i, start);
    const end = src.indexOf('*/', start + 2);
    if (end === -1) break;
    i = end + 2;
  }
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const j = line.indexOf('//');
      return j === -1 ? line : line.slice(0, j);
    })
    .join('\n');
}

/** Every line whose trimmed form begins with `import` or `export ... from`, i.e. every
 *  module-graph edge. Comment-stripped input only. */
function moduleEdgeLines(stripped: string): string[] {
  return stripped
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith('import') || line.startsWith('export {') || line.startsWith('export *'),
    );
}

/**
 * Every occurrence of `sessionStorage` in the stripped source sits on a line that also
 * names `host` — i.e. it is a property access on the INJECTED parameter, never an
 * ambient reach.
 *
 * WHAT THIS SEES: `globalThis.sessionStorage`, `window.sessionStorage`, and a bare
 * `sessionStorage.getItem(...)` (the implicit-global form the `globalThis` count alone
 * cannot catch).
 * WHAT IT DOES NOT SEE: an alias assigned on an earlier line (`const s = globalThis;`
 * then `s.sessionStorage`) — but the `globalThis`/`window` counts below are zero, so
 * that alias has nowhere to come from.
 */
function sessionStorageReachesOnlyThroughHost(stripped: string): {
  ok: boolean;
  offending: string;
} {
  for (const line of stripped.split('\n')) {
    if (line.indexOf('sessionStorage') === -1) continue;
    if (line.indexOf('host') === -1) return { ok: false, offending: line.trim() };
  }
  return { ok: true, offending: '' };
}

describe('G30 (claimCode.ts source scan): the storage host is a PARAMETER, never an ambient reach', () => {
  it('★ CALIBRATION: the stripper is not vacuous, and claimCode.ts carries no "://" literal (the stripLineComments blind spot)', () => {
    // THE CALIBRATION THIS FILE OWES (plan ADDENDUM §C, last bullet). Two independent
    // failure modes of the scan itself, closed here so no count below can pass vacuously:
    //
    // (1) A stripper that returns '' (or the whole file unchanged) makes every `=== 0`
    //     count below meaningless. The fixture proves it removes commented-out code and
    //     keeps live code.
    // (2) `stripComments` truncates each line at the first `//`, so a line containing a
    //     scheme literal loses everything after it — a real `localStorage.setItem(...)`
    //     parked after a URL on one line would be INVISIBLE to every ban below. Pinning
    //     zero occurrences of the two-slash-after-colon token in claimCode.ts closes that
    //     hole by construction. connection.test.ts:1247-1260 pins the identical property
    //     for connection.ts; build any URL from parts if one is ever needed here.
    const fixture = [
      'const live = 1;',
      '// localStorage.setItem("x", "y")',
      '/* indexedDB.open() */ const also = 2;',
    ].join('\n');
    const strippedFixture = stripComments(fixture);
    expect(countOccurrences(strippedFixture, 'localStorage')).toBe(0);
    expect(countOccurrences(strippedFixture, 'indexedDB')).toBe(0);
    expect(
      countOccurrences(strippedFixture, 'const live = 1;'),
      'the stripper must keep live code',
    ).toBe(1);
    expect(
      countOccurrences(strippedFixture, 'const also = 2;'),
      'a trailing block comment must not swallow the line',
    ).toBe(1);

    const raw = readSourceOrThrow(CLAIM_CODE_TS_PATH);
    expect(
      countOccurrences(raw, ':' + '//'),
      'claimCode.ts must contain no scheme literal — the line-comment stripper truncates ' +
        'at the first two-slash token, so a URL on a live line would hide whatever follows ' +
        'it from every ban in this block. Build any URL from parts (accounts.rs:40-48 makes ' +
        'the same move for the same class of scanner)',
    ).toBe(0);
  });

  it('★★ BITES: zero localStorage / indexedDB / document.cookie / globalThis / window in the comment-stripped source', () => {
    // WRONG IMPL KILLED (a): `localStorage.setItem(key, code)` — AUTH-58 violated, and the
    //   claim code becomes readable by every tab on the origin.
    // WRONG IMPL KILLED (b): `globalThis.sessionStorage.getItem(key)` as a fallback when
    //   `host` is undefined. Every behavioural test above still passes (node has no
    //   sessionStorage global) while the browser silently uses the ambient store — the
    //   injected-host discipline becomes decorative.
    // WRONG IMPL KILLED (c): an `indexedDB` / `document.cookie` "durable" variant, which
    //   would survive the tab and re-open the cross-tab identity hazard ADR-0150 D3 closes.
    const stripped = stripComments(readSourceOrThrow(CLAIM_CODE_TS_PATH));

    // Anti-vacuity FIRST: a stub file (or a stripper that ate everything) would satisfy
    // every zero below.
    expect(
      countOccurrences(stripped, 'sessionStorage'),
      'the scanned source must actually reference sessionStorage — a zero here means this ' +
        'scan is judging an empty or wrong file and every ban below is vacuous',
    ).toBeGreaterThanOrEqual(1);
    expect(
      countOccurrences(stripped, 'export'),
      'the scanned source must export something',
    ).toBeGreaterThanOrEqual(3);

    for (const banned of ['localStorage', 'indexedDB', 'document.cookie', 'globalThis', 'window']) {
      expect(
        countOccurrences(stripped, banned),
        `claimCode.ts must never name "${banned}" — the storage host is an injected ` +
          'PARAMETER (ADR-0182 D16 / G30). Reaching an ambient global makes every ' +
          'injected-host test in this file decorative',
      ).toBe(0);
    }
  });

  it('★★ BITES: every `sessionStorage` occurrence is host-scoped (kills a bare implicit-global `sessionStorage.getItem`)', () => {
    const stripped = stripComments(readSourceOrThrow(CLAIM_CODE_TS_PATH));
    const verdict = sessionStorageReachesOnlyThroughHost(stripped);
    expect(
      verdict.ok,
      'every line naming sessionStorage must also name the injected `host` parameter. ' +
        `Offending line: ${JSON.stringify(verdict.offending)}. A bare \`sessionStorage.getItem(k)\` ` +
        'resolves to the ambient global in a browser and to nothing under vitest — the exact ' +
        'shape that passes every test here and fails in production',
    ).toBe(true);
  });

  it('★★ BITES: claimCode.ts imports NOTHING at runtime (type-only imports allowed) and never uses `import *`', () => {
    // WHY (plan ADDENDUM §C, F19): this module is the storage primitive the join veto
    // depends on. A runtime import gives it a transitive dependency graph — and the first
    // thing anyone would reach for is `authToken.ts`'s private `storageMethod`, which is
    // not exported, so the temptation is to export it and grow a shared mutable seam
    // between two modules with DIFFERENT fail directions (authToken fails to 'anon';
    // claimCode fails to "no code"). A TYPE import of `TokenStorageHost` is free at
    // runtime and is what this file's own import block uses.
    //
    // `import *` is banned for the same reason G14 bans it in connection.ts: a namespace
    // import makes an identifier-level scan (the one that caught the aliasing evasion
    // recorded at authToken.test.ts:1368-1377) unable to see which members are used.
    const stripped = stripComments(readSourceOrThrow(CLAIM_CODE_TS_PATH));
    expect(countOccurrences(stripped, 'import *'), 'no namespace imports').toBe(0);
    expect(countOccurrences(stripped, 'require('), 'no CommonJS require').toBe(0);

    for (const line of moduleEdgeLines(stripped)) {
      expect(
        line.startsWith('import type') || line.startsWith('export type'),
        `claimCode.ts may carry TYPE-ONLY module edges. Offending line: ${JSON.stringify(line)}`,
      ).toBe(true);
    }
  });
});
