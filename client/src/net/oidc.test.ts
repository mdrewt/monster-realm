// net/oidc.test.ts — AUTH-39/40/41/42 + G27's precondition + G30 (half).
// (M21b-2, ADR-0182 D11/D12/D13.)
//
// EARS COVERED
//   AUTH-39 — a sign-in redirect mints `state` (32 random bytes, hex) and a PKCE
//             `code_verifier`/`code_challenge` (S256) pair via `crypto.getRandomValues` /
//             `crypto.subtle.digest`, persists `state` + `code_verifier` in THIS TAB's
//             sessionStorage BEFORE navigating, and includes `state` + `code_challenge`
//             in the authorization request.
//   AUTH-40 — on the return leg the stored `state` is compared BYTE-FOR-BYTE; on mismatch
//             (or when nothing is stored) the load is an ordinary cold start and the
//             authorization code is NEVER exchanged.
//   AUTH-41 — the stored `state`/`code_verifier` are single-use and `history.replaceState`
//             scrubs the return marker BEFORE any other boot work, unconditionally.
//   AUTH-42 — a successful renewal/exchange persists the new `refresh_token` (OVERWRITING
//             any previous value) BEFORE the returned token is used to build a connection.
//   AUTH-44 — a tab with nothing in storage makes NO call to the Better Auth token endpoint.
//   AUTH-48 — a first-time exchange failure produces `exchange-failed` and persists NO
//             refresh token.
//   AUTH-57 — no raw provider error text escapes: the reason is classifier-mapped onto a
//             small STATIC set.
//   AUTH-58 — sessionStorage only.
//   G27 (precondition) — `renewOrExchange()` is TOTAL: throwing fetch, throwing
//             `subtle.digest`, malformed JSON and non-2xx all resolve to
//             `{kind:'transient-error'}`, and the returned promise NEVER rejects. This is
//             the C1 CRITICAL: connection.ts's `try { await resolveCredential() }` is the
//             belt, and THIS is the braces.
//   G30 (half) — oidc.ts reaches no ambient storage/globals; its only module edge is a
//             TYPE import from './credentialDecision'.
//
// RED REASON AT HEAD (8814416): `client/src/net/oidc.ts` DOES NOT EXIST (nor does
// `credentialDecision.ts`, whose type it re-exports through). The imports below fail to
// resolve, so every test reds on a MISSING IMPLEMENTATION, not on a typo here.
//
// THE CONTRACT THE IMPLEMENTER BUILDS:
//
//   import type { RenewalOutcome } from './credentialDecision';  // TYPE-ONLY (G30)
//
//   export interface OidcHost {           // every field `unknown` — parse-don't-validate,
//     readonly sessionStorage?: unknown;  // exactly the `TokenStorageHost` idiom
//     readonly location?: unknown;        // { search?: string; hash?: string; pathname?: string }
//     readonly history?: unknown;         // { replaceState(data, unused, url): void }
//     readonly crypto?: unknown;          // { getRandomValues(v), subtle: { digest(alg, data) } }
//     readonly fetch?: unknown;           // (url, init?) => Promise<{ok, status, json()}>
//   }
//   export interface OidcConfig {
//     readonly issuer: string; readonly clientId: string; readonly redirectUri: string;
//     readonly uri: string; readonly db: string;   // the two storage-key axes
//   }
//   export const OIDC_FLOW_KEY_PREFIX = 'mr.oidcFlow.v1';
//   export function oidcFlowStorageKey(uri: string, db: string): string;
//   export const SIGN_IN_REASONS: readonly SignInReason[];   // the STATIC vocabulary
//   export type SignInReason =
//     | 'sign-in-rejected' | 'sign-in-expired' | 'sign-in-declined'
//     | 'auth-service-unreachable' | 'sign-in-failed';
//   export function classifySignInReason(raw: unknown): SignInReason;
//   export type BeginSignInResult =
//     | { readonly kind: 'ready'; readonly authorizationUrl: string }
//     | { readonly kind: 'transient-error' };
//   export interface OidcClient {
//     consumeReturnLeg(): boolean;              // SYNC, called once at boot
//     beginSignIn(): Promise<BeginSignInResult>;
//     renewOrExchange(): Promise<RenewalOutcome>;   // ZERO arguments — see below
//   }
//   export function createOidcClient(host: OidcHost | undefined, config: OidcConfig): OidcClient;
//
// ★ HOW AUTH-41's "DELETE THE VERIFIER" AND D13's "EXCHANGE WITH THE VERIFIER" ARE BOTH
//   SATISFIED — read this before calling any assertion below wrong. Deleting the
//   code_verifier at boot would make PKCE structurally impossible, so "single-use" is
//   resolved as CONSUMED EXACTLY ONCE, whichever way that consumption goes:
//     * `consumeReturnLeg()` deletes the stored `state` on EVERY path (matched or not) and
//       ALSO deletes the `code_verifier` on every NON-matched path.
//     * On a match it records the authorization code alongside the verifier, so
//       `renewOrExchange()` can branch on STORAGE ALONE (D13: "branches on WHAT IS ACTUALLY
//       IN STORAGE, not on the caller's belief about why this attempt fired").
//     * `renewOrExchange()` deletes BOTH before it can observe the exchange result, so a
//       throw, a rejection, a 5xx or a success all leave the same empty slot.
//   Consequence, stated rather than hidden: a network blip DURING the exchange costs the
//   sign-in (the next attempt sees no verifier and reports `no-session`). That is the
//   direction AUTH-41 chose — a replayable authorization code is the worse failure.
//
// ★ WHY `renewOrExchange()` TAKES NO ARGUMENT (ADR-0182 D13, finalization review H1): a
//   `renewOrExchange(isReturnLeg)` design either throws or misclassifies an ordinary
//   reconnect (wifi blip, laptop sleep) as a failed sign-in, because `connect()` is a
//   singleton per page and the caller's flag outlives the one page load it described. The
//   arity is pinned mechanically below.
//
// PURE NODE UNIT TEST — storage, location, history, crypto and fetch are ALL injected. The
// storage fake family is REUSED from authToken.test.ts:41-94 (plan R8: do not invent a
// parallel helper family); the recording wrapper around it is an ADDITION, not a
// replacement, and exists only to give the four surfaces ONE ordered log so AUTH-41's
// "before any other boot work" is checkable.
//
// NO `new RegExp(...)` anywhere (Semgrep `detect-non-literal-regexp`, banned repo-wide).
// NO scheme literal anywhere either — every URL below is assembled from parts, the same
// move `accounts.rs:40-48` makes for the same class of scanner.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RenewalOutcome } from './credentialDecision';
import {
  classifySignInReason,
  createOidcClient,
  OIDC_FLOW_KEY_PREFIX,
  oidcFlowStorageKey,
  SIGN_IN_REASONS,
} from './oidc';

// ---------------------------------------------------------------------------
// Config fixtures. Every URL is assembled from parts — no contiguous scheme
// literal appears in this file's source (Semgrep `--config auto` matches scheme
// literals even inside comments, and it is remote-only so `just ci` cannot catch it).
// ---------------------------------------------------------------------------

const SCHEME = 'https:';
const ISSUER = `${SCHEME}${'//'}auth.monster-realm.invalid`;
const AUTHORIZATION_ENDPOINT = `${ISSUER}/oauth2/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;
const DISCOVERY_PATH = '/.well-known/openid-configuration';
const CLIENT_ID = 'monster-realm-client-id';
const REDIRECT_URI = `${SCHEME}${'//'}play.monster-realm.invalid/`;
const URI = 'ws://127.0.0.1:3000';
const DB = 'monster-realm';

const CONFIG = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  uri: URI,
  db: DB,
};

const DISCOVERY_DOC = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  jwks_uri: `${ISSUER}/jwks`,
  id_token_signing_alg_values_supported: ['ES256'],
};

const AUTH_CODE = 'AUTHORIZATION-CODE-1';
const ID_TOKEN_1 = 'id-token-one';
const ID_TOKEN_2 = 'id-token-two';
const REFRESH_1 = 'refresh-one';
const REFRESH_2 = 'refresh-two';

/** The two 32-byte draws the fake CSPRNG hands out, in order. Distinct fills so a mint
 *  that draws twice but REUSES one buffer for both secrets is detectable. */
const DRAW_A = Uint8Array.from({ length: 32 }, (_v, i) => i & 0xff);
const DRAW_B = Uint8Array.from({ length: 32 }, (_v, i) => (0x80 + i) & 0xff);
/** The fixed SHA-256 the fake `subtle.digest` returns, so the expected `code_challenge`
 *  is computable here without hashing anything. */
const FIXED_DIGEST = Uint8Array.from({ length: 32 }, (_v, i) => (0xa0 + i) & 0xff);

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------
// Fakes. FakeSessionStorage / ThrowingSetStorage / ThrowingGetStorage are copied
// VERBATIM in behaviour from authToken.test.ts:41-94.
// ---------------------------------------------------------------------------

interface StorageCall {
  readonly op: 'getItem' | 'setItem' | 'removeItem';
  readonly key: string;
  readonly value?: string;
}

class FakeSessionStorage {
  private readonly store = new Map<string, string>();
  readonly calls: StorageCall[] = [];
  /** Shared, ordered log across ALL injected surfaces — see AUTH-41's ordering test. */
  log: string[] = [];

  getItem(key: string): string | null {
    this.calls.push({ op: 'getItem', key });
    this.log.push(`storage.getItem:${key}`);
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.calls.push({ op: 'setItem', key, value });
    this.log.push(`storage.setItem:${key}`);
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.calls.push({ op: 'removeItem', key });
    this.log.push(`storage.removeItem:${key}`);
    this.store.delete(key);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }

  get size(): number {
    return this.store.size;
  }
}

class ThrowingSetStorage {
  getItem(): string | null {
    return null;
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
  removeItem(): void {}
}

class ThrowingGetStorage {
  getItem(): string {
    throw new Error('boom');
  }
  setItem(): void {}
  removeItem(): void {}
}

interface FetchCall {
  readonly url: string;
  readonly init: { method?: string; body?: string; headers?: Record<string, string> } | undefined;
}

interface TokenResponseSpec {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  /** `json()` rejects instead of resolving — a proxy error page / truncated response. */
  readonly malformed?: boolean;
}

const OK_EXCHANGE: TokenResponseSpec = {
  ok: true,
  status: 200,
  body: {
    id_token: ID_TOKEN_1,
    access_token: 'access-one',
    refresh_token: REFRESH_1,
    token_type: 'Bearer',
  },
};
const OK_REFRESH: TokenResponseSpec = {
  ok: true,
  status: 200,
  body: {
    id_token: ID_TOKEN_2,
    access_token: 'access-two',
    refresh_token: REFRESH_2,
    token_type: 'Bearer',
  },
};
const DEFINITIVE_REJECT: TokenResponseSpec = {
  ok: false,
  status: 400,
  body: {
    error: 'invalid_grant',
    error_description: 'the code has already been redeemed by user@example.invalid',
  },
};
const GATEWAY_5XX: TokenResponseSpec = {
  ok: false,
  status: 502,
  body: undefined,
  malformed: true,
};

interface Rig {
  readonly storage: FakeSessionStorage;
  readonly host: Record<string, unknown>;
  readonly log: string[];
  readonly fetchCalls: FetchCall[];
  readonly replaceStateUrls: unknown[];
  readonly navigations: string[];
  readonly digestCalls: { algorithm: unknown; input: string }[];
  readonly randomDraws: number[];
  setSearch(search: string): void;
  setTokenResponse(spec: TokenResponseSpec): void;
  setFetchThrows(mode: FetchThrowMode): void;
  setDigestThrows(value: boolean): void;
  tokenCallCount(): number;
  discoveryCallCount(): number;
}

/** `'token'` throws only at the token endpoint, so discovery still succeeds and the
 *  return leg can be armed before the failure under test happens — without it, a
 *  totality fixture would fail during SETUP and assert nothing about renewOrExchange. */
type FetchThrowMode = 'none' | 'all' | 'token';

interface RigOptions {
  readonly storage?: FakeSessionStorage;
  readonly search?: string;
  readonly tokenResponse?: TokenResponseSpec;
  readonly fetchThrows?: FetchThrowMode;
  readonly digestThrows?: boolean;
  readonly discoveryMalformed?: boolean;
  readonly omitCrypto?: boolean;
}

function makeRig(options: RigOptions = {}): Rig {
  const storage = options.storage ?? new FakeSessionStorage();
  const log = storage.log;

  const fetchCalls: FetchCall[] = [];
  const replaceStateUrls: unknown[] = [];
  const navigations: string[] = [];
  const digestCalls: { algorithm: unknown; input: string }[] = [];
  const randomDraws: number[] = [];
  let drawIndex = 0;
  let search = options.search ?? '';
  let tokenResponse = options.tokenResponse ?? OK_EXCHANGE;
  let fetchThrows: FetchThrowMode = options.fetchThrows ?? 'none';
  let digestThrows = options.digestThrows === true;

  const respond = (spec: TokenResponseSpec) => ({
    ok: spec.ok,
    status: spec.status,
    json: async (): Promise<unknown> => {
      if (spec.malformed === true)
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      return spec.body;
    },
  });

  const host: Record<string, unknown> = {
    sessionStorage: storage,
    get location() {
      return {
        search,
        hash: '',
        pathname: '/',
        assign: (u: string) => navigations.push(u),
        replace: (u: string) => navigations.push(u),
      };
    },
    history: {
      replaceState(_data: unknown, _unused: unknown, url?: unknown): void {
        log.push('history.replaceState');
        replaceStateUrls.push(url);
      },
    },
    fetch: async (url: string, init?: FetchCall['init']) => {
      log.push(`fetch:${url}`);
      fetchCalls.push({ url, init });
      if (fetchThrows === 'all') throw new TypeError('Failed to fetch');
      if (fetchThrows === 'token' && url.indexOf(DISCOVERY_PATH) < 0) {
        throw new TypeError('Failed to fetch');
      }
      if (url.indexOf(DISCOVERY_PATH) >= 0) {
        return respond(
          options.discoveryMalformed === true
            ? { ok: true, status: 200, body: undefined, malformed: true }
            : { ok: true, status: 200, body: DISCOVERY_DOC },
        );
      }
      return respond(tokenResponse);
    },
  };

  if (options.omitCrypto !== true) {
    host.crypto = {
      getRandomValues<T extends ArrayBufferView>(array: T): T {
        log.push(`crypto.getRandomValues:${array.byteLength}`);
        randomDraws.push(array.byteLength);
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        const source = drawIndex === 0 ? DRAW_A : DRAW_B;
        drawIndex += 1;
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = source[i % source.length] as number;
        return array;
      },
      subtle: {
        async digest(
          algorithm: unknown,
          data: ArrayBufferView | ArrayBuffer,
        ): Promise<ArrayBuffer> {
          log.push('subtle.digest');
          const view =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          digestCalls.push({ algorithm, input: Buffer.from(view).toString('utf8') });
          if (digestThrows) throw new Error('NotSupportedError');
          // `new Uint8Array(typedArray).buffer` is exact-length; `Buffer.from(...).buffer`
          // would hand back node's SHARED pool buffer (8 KiB) and every length assertion
          // downstream would be judging the pool, not the digest.
          return new Uint8Array(FIXED_DIGEST).buffer;
        },
      },
    };
  }

  return {
    storage,
    host,
    log,
    fetchCalls,
    replaceStateUrls,
    navigations,
    digestCalls,
    randomDraws,
    setSearch(next: string): void {
      search = next;
    },
    setTokenResponse(spec: TokenResponseSpec): void {
      tokenResponse = spec;
    },
    setFetchThrows(mode: FetchThrowMode): void {
      fetchThrows = mode;
    },
    setDigestThrows(value: boolean): void {
      digestThrows = value;
    },
    tokenCallCount(): number {
      return fetchCalls.filter((c) => c.url === TOKEN_ENDPOINT).length;
    },
    discoveryCallCount(): number {
      return fetchCalls.filter((c) => c.url.indexOf(DISCOVERY_PATH) >= 0).length;
    },
  };
}

/** Read one query parameter out of an authorization URL without `new URL` (which would
 *  need a real scheme literal) and without a regex. */
function queryParam(url: string, name: string): string | undefined {
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  for (const pair of url.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (decodeURIComponent(pair.slice(0, eq)) === name)
      return decodeURIComponent(pair.slice(eq + 1));
  }
  return undefined;
}

/** Drive a full, successful sign-in on one rig: begin -> return leg -> exchange.
 *  Returns the outcome so a caller can assert on it. */
async function completeSignIn(rig: Rig): Promise<{ outcome: RenewalOutcome; state: string }> {
  const client = createOidcClient(rig.host, CONFIG);
  const begun = await client.beginSignIn();
  if (begun.kind !== 'ready') throw new Error(`fixture broken: beginSignIn returned ${begun.kind}`);
  const state = queryParam(begun.authorizationUrl, 'state') as string;
  rig.setSearch(`?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`);
  const matched = client.consumeReturnLeg();
  if (!matched) throw new Error('fixture broken: the return leg did not match its own state');
  const outcome = await client.renewOrExchange();
  return { outcome, state };
}

// ===========================================================================
// AUTH-39 — state + PKCE mint.
// ===========================================================================

describe('oidc.beginSignIn (AUTH-39): state is 32 random bytes hex; PKCE is S256', () => {
  it('★★ BITES: exactly TWO 32-byte getRandomValues draws, and the two secrets come from DIFFERENT draws', () => {
    // WRONG IMPL KILLED (a): one 32-byte draw reused for BOTH state and code_verifier.
    //   The `state` then travels through the URL bar, the provider's logs and the
    //   Referer header — and it IS the PKCE verifier, so the whole point of PKCE (a
    //   secret the redirect never carries) is gone. This is why the two fills differ.
    // WRONG IMPL KILLED (b): a 16-byte draw (halved entropy) or a 64-byte draw.
    // WRONG IMPL KILLED (c): `Math.random()`-derived state — zero draws recorded.
    const rig = makeRig();
    return createOidcClient(rig.host, CONFIG)
      .beginSignIn()
      .then((result) => {
        expect(result.kind).toBe('ready');
        expect(rig.randomDraws, 'exactly two getRandomValues draws').toHaveLength(2);
        expect(
          rig.randomDraws.every((n) => n === 32),
          'each draw must be exactly 32 bytes',
        ).toBe(true);

        const url = (result as { authorizationUrl: string }).authorizationUrl;
        const state = queryParam(url, 'state') as string;
        const verifier = rig.digestCalls[0]?.input as string;

        // Whichever draw the implementation used first, the OTHER one must be the
        // verifier — the order is not pinned, the DISTINCTNESS is.
        if (state === toHex(DRAW_A)) {
          expect(
            verifier,
            'the verifier must come from the OTHER draw, never the state bytes',
          ).toBe(toBase64Url(DRAW_B));
        } else {
          expect(state).toBe(toHex(DRAW_B));
          expect(verifier).toBe(toBase64Url(DRAW_A));
        }
      });
  });

  it('★★ BITES: `state` is 64 LOWERCASE hex characters (32 bytes) — kills a short/base64/uppercase state', () => {
    const rig = makeRig();
    return createOidcClient(rig.host, CONFIG)
      .beginSignIn()
      .then((result) => {
        const state = queryParam(
          (result as { authorizationUrl: string }).authorizationUrl,
          'state',
        ) as string;
        expect(state).toHaveLength(64);
        for (const ch of state) {
          expect(
            '0123456789abcdef'.indexOf(ch),
            `state character ${JSON.stringify(ch)}`,
          ).toBeGreaterThanOrEqual(0);
        }
      });
  });

  it('★★ BITES: code_challenge === base64url(SHA-256(code_verifier)) with method S256 — kills a "plain" challenge and a raw-hex digest', () => {
    // WRONG IMPL KILLED (a): `code_challenge = code_verifier` with
    //   `code_challenge_method=plain`. Better Auth's oauth-provider docs (fetched live,
    //   ADR-0182 D11) state PKCE is ALWAYS required for public clients; `plain` defeats it
    //   entirely — an attacker who observes the authorization request can complete the
    //   exchange.
    // WRONG IMPL KILLED (b): hex-encoding the digest instead of base64url (64 chars, and
    //   the provider's own S256 comparison fails — an unfixable sign-in for every player).
    // WRONG IMPL KILLED (c): digesting the base64url STRING's bytes vs. the raw random
    //   bytes — the assertion on `digestCalls[0].input` pins that the digest input is the
    //   VERIFIER TEXT (RFC 7636's `ASCII(code_verifier)`), which is what the provider hashes.
    const rig = makeRig();
    return createOidcClient(rig.host, CONFIG)
      .beginSignIn()
      .then((result) => {
        const url = (result as { authorizationUrl: string }).authorizationUrl;
        expect(rig.digestCalls, 'subtle.digest must be called exactly once').toHaveLength(1);
        const call = rig.digestCalls[0] as { algorithm: unknown; input: string };
        const algorithmName =
          typeof call.algorithm === 'string'
            ? call.algorithm
            : (call.algorithm as { name?: string })?.name;
        expect(algorithmName, 'S256 means SHA-256').toBe('SHA-256');
        // The verifier is base64url of a 32-byte draw: 43 characters, no padding.
        expect(call.input).toHaveLength(43);
        expect(call.input.indexOf('='), 'base64url carries no padding').toBe(-1);
        expect(call.input.indexOf('+'), 'base64url uses - not +').toBe(-1);
        expect(call.input.indexOf('/'), 'base64url uses _ not /').toBe(-1);

        expect(queryParam(url, 'code_challenge')).toBe(toBase64Url(FIXED_DIGEST));
        expect(queryParam(url, 'code_challenge_method')).toBe('S256');
      });
  });

  it('★ BITES: the authorization URL is the DISCOVERED endpoint and carries the full parameter set', () => {
    // ADR-0182 D11: "Endpoint discovery, not hardcoded paths." A hardcoded
    // `<issuer>/oauth2/authorize` works against today's Better Auth and breaks silently
    // whenever the deployment moves — with no error the client can report.
    const rig = makeRig();
    return createOidcClient(rig.host, CONFIG)
      .beginSignIn()
      .then((result) => {
        const url = (result as { authorizationUrl: string }).authorizationUrl;
        expect(
          url.indexOf(AUTHORIZATION_ENDPOINT),
          'the URL must start at the DISCOVERED authorization_endpoint',
        ).toBe(0);
        expect(queryParam(url, 'response_type')).toBe('code');
        expect(queryParam(url, 'client_id')).toBe(CLIENT_ID);
        expect(queryParam(url, 'redirect_uri')).toBe(REDIRECT_URI);
        expect(queryParam(url, 'scope')).toBe('openid');
        expect(queryParam(url, 'state')).toBeDefined();
        expect(queryParam(url, 'code_challenge')).toBeDefined();
      });
  });

  it('★★ BITES: state + code_verifier are IN STORAGE before beginSignIn resolves — and the module does NOT navigate', () => {
    // AUTH-39's ordering clause. If the redirect fires before the write lands, the return
    // leg has nothing to compare against and every sign-in fails as a state mismatch.
    // Proved BEHAVIOURALLY, without knowing the storage layout: a return leg driven with
    // the state from the URL matches immediately after beginSignIn resolves.
    //
    // And the module must NOT perform the navigation itself: an `oidc.ts` that calls
    // `location.assign` cannot be unit-tested at all past that line, and main.ts owns
    // "when does this tab leave the page".
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client.beginSignIn().then((result) => {
      expect(
        rig.storage.size,
        'the flow record must be persisted before beginSignIn resolves',
      ).toBeGreaterThanOrEqual(1);
      expect(rig.navigations, 'oidc.ts must never navigate — it returns the URL').toEqual([]);
      const state = queryParam(
        (result as { authorizationUrl: string }).authorizationUrl,
        'state',
      ) as string;
      rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
      expect(client.consumeReturnLeg()).toBe(true);
    });
  });

  it('★ BITES: every key beginSignIn writes lives under mr.oidcFlow.v1|<uri>|<db> (AUTH-58 namespacing)', () => {
    const rig = makeRig();
    return createOidcClient(rig.host, CONFIG)
      .beginSignIn()
      .then(() => {
        expect(rig.storage.keys().length).toBeGreaterThanOrEqual(1);
        for (const key of rig.storage.keys()) {
          expect(
            key.indexOf(oidcFlowStorageKey(URI, DB)),
            `key ${key} must be under the flow namespace`,
          ).toBe(0);
        }
      });
  });

  it('★★ BITES: when the flow record CANNOT be persisted, beginSignIn refuses — it never hands back a URL it cannot verify', async () => {
    // AUTH-39's ordering clause read as a precondition, not just an ordering: "persist
    // `state` and `code_verifier` in this tab's sessionStorage BEFORE navigating". If the
    // write failed (Safari private-mode quota, blocked storage, a hostile host), navigating
    // anyway guarantees the return leg finds NOTHING to compare against — AUTH-40 then
    // (correctly) treats the load as a cold start, so the player bounces through the whole
    // provider round trip and lands back signed out, with no error and no way to tell why.
    // Refusing up front is the only outcome the UI can explain.
    //
    // WRONG IMPL KILLED: `write(state); write(verifier); return {kind:'ready', url}` with
    // the writes degrading silently (the house style everywhere else in this module family
    // — right for a MARKER, wrong for the only copy of a one-shot secret; claimCode.mint
    // makes the same call for the same reason).
    for (const [label, sessionStorage] of [
      ['setItem throws (private-mode quota)', new ThrowingSetStorage()],
      ['setItem is not a function', { getItem: () => null, setItem: 'nope' }],
      ['no sessionStorage at all', undefined],
    ] as readonly (readonly [string, unknown])[]) {
      const rig = makeRig();
      const host = { ...rig.host, sessionStorage };
      const result = await createOidcClient(host as never, CONFIG).beginSignIn();
      expect(result, label).toEqual({ kind: 'transient-error' });
    }
  });
});

// ===========================================================================
// AUTH-40 — byte-for-byte state comparison; mismatch means NO exchange.
// ===========================================================================

describe('oidc.consumeReturnLeg (AUTH-40): byte-for-byte state compare, mismatch = ordinary cold start', () => {
  it('★★ BITES: a MISMATCHED state returns false and NO token-endpoint call ever happens', () => {
    // THE CSRF/CODE-INJECTION CASE. An attacker who can put their own `code` in the
    // player's URL bar gets the player's browser to exchange it, binding the player's tab
    // to the ATTACKER's account. AUTH-40's whole content is that the exchange must not
    // happen; asserting `false` is not enough — an implementation could return false and
    // exchange anyway. The zero-token-call assertion is the load-bearing half.
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client
      .beginSignIn()
      .then(() => {
        rig.setSearch(
          `?code=${AUTH_CODE}&state=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`,
        );
        expect(client.consumeReturnLeg()).toBe(false);
        return client.renewOrExchange();
      })
      .then((outcome) => {
        expect(rig.tokenCallCount(), 'a mismatched state must never reach the token endpoint').toBe(
          0,
        );
        expect(outcome).toEqual({ kind: 'no-session' });
      });
  });

  it('★★ BITES: a ONE-CHARACTER difference is a mismatch (byte-for-byte, not a prefix/length/truthiness compare)', () => {
    // WRONG IMPL KILLED: `stored.startsWith(returned)`, `returned.length === stored.length`,
    // `!!returned`, or a `.slice(0, 8)` "cheap" compare. Each accepts a state the attacker
    // can guess or truncate.
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client
      .beginSignIn()
      .then((result) => {
        const state = queryParam(
          (result as { authorizationUrl: string }).authorizationUrl,
          'state',
        ) as string;
        const flipped = `${state.slice(0, 63)}${state[63] === 'a' ? 'b' : 'a'}`;
        expect(flipped).not.toBe(state);
        expect(flipped).toHaveLength(64);
        rig.setSearch(`?code=${AUTH_CODE}&state=${flipped}`);
        expect(client.consumeReturnLeg()).toBe(false);
        return client.renewOrExchange();
      })
      .then(() => {
        expect(rig.tokenCallCount()).toBe(0);
      });
  });

  it('★★ BITES: a case-different state is a mismatch (kills a toLowerCase()-normalising compare)', () => {
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client
      .beginSignIn()
      .then((result) => {
        const state = queryParam(
          (result as { authorizationUrl: string }).authorizationUrl,
          'state',
        ) as string;
        rig.setSearch(`?code=${AUTH_CODE}&state=${state.toUpperCase()}`);
        expect(client.consumeReturnLeg()).toBe(false);
        return client.renewOrExchange();
      })
      .then(() => {
        expect(rig.tokenCallCount()).toBe(0);
      });
  });

  it('★★ BITES: a return marker with NO stored state at all (fresh tab / different tab) is a cold start', () => {
    // Per-tab sessionStorage means the return leg can genuinely land in a tab that never
    // started a sign-in (the player pasted the URL, or the provider opened a new tab). No
    // stored value = nothing to compare = cold start, never an exchange.
    const rig = makeRig({ search: `?code=${AUTH_CODE}&state=${toHex(DRAW_A)}` });
    const client = createOidcClient(rig.host, CONFIG);
    expect(client.consumeReturnLeg()).toBe(false);
    return client.renewOrExchange().then((outcome) => {
      expect(rig.tokenCallCount()).toBe(0);
      expect(outcome).toEqual({ kind: 'no-session' });
    });
  });

  it('★ BITES: a MATCHING state returns true (anti-vacuity — without this every negative above is satisfied by `return false`)', () => {
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client.beginSignIn().then((result) => {
      const state = queryParam(
        (result as { authorizationUrl: string }).authorizationUrl,
        'state',
      ) as string;
      rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
      expect(client.consumeReturnLeg()).toBe(true);
    });
  });

  it('★ BITES: no return marker at all -> false, no history scrub, no storage write', () => {
    // An ordinary page load must be completely inert: an unconditional `replaceState` on
    // every boot would fight main.ts for the history entry and (worse) mask a real
    // navigation bug behind a scrub that always "worked".
    const rig = makeRig({ search: '' });
    const client = createOidcClient(rig.host, CONFIG);
    expect(client.consumeReturnLeg()).toBe(false);
    expect(rig.replaceStateUrls, 'nothing to scrub means no replaceState').toEqual([]);
    expect(rig.storage.calls.filter((c) => c.op === 'setItem')).toEqual([]);
  });
});

// ===========================================================================
// AUTH-41 — scrub FIRST, single-use ALWAYS.
// ===========================================================================

describe('oidc.consumeReturnLeg (AUTH-41): history.replaceState scrubs BEFORE any other work; state/verifier are single-use', () => {
  it('★★ BITES: `history.replaceState` is the FIRST recorded action of the return-leg evaluation', () => {
    // "before any other boot work, unconditionally". The shared ordered log spans storage,
    // crypto, fetch and history, so this assertion sees ANY reordering.
    //
    // WHY IT MATTERS: until the scrub lands, the authorization code sits in
    // `location.search` — where it reaches the Referer header of every subresource the
    // page loads, `document.referrer` of anything it opens, the browser's own history/sync,
    // and any error reporter that captures the URL. A scrub performed AFTER the storage
    // read and the exchange has already lost that race.
    //
    // WRONG IMPL KILLED: `const stored = read(...); if (stored === returned) { ... }
    //                     history.replaceState(...)` — the natural, wrong order.
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client.beginSignIn().then((result) => {
      const state = queryParam(
        (result as { authorizationUrl: string }).authorizationUrl,
        'state',
      ) as string;
      rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
      rig.log.length = 0; // isolate the return-leg evaluation from the mint above
      client.consumeReturnLeg();
      expect(rig.log.length, 'the return leg must do SOMETHING').toBeGreaterThan(0);
      expect(
        rig.log[0],
        `history.replaceState must be the first action; the recorded order was ${JSON.stringify(rig.log)}`,
      ).toBe('history.replaceState');
    });
  });

  it('★★ BITES: the scrubbed URL carries neither `code=` nor `state=`', () => {
    // WRONG IMPL KILLED: `history.replaceState(null, "", location.href)` — a scrub that
    // rewrites the same URL. It is called, the ordering test above passes, and the code is
    // still in the address bar.
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client.beginSignIn().then((result) => {
      const state = queryParam(
        (result as { authorizationUrl: string }).authorizationUrl,
        'state',
      ) as string;
      rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
      client.consumeReturnLeg();
      expect(rig.replaceStateUrls, 'exactly one scrub').toHaveLength(1);
      const scrubbed = String(rig.replaceStateUrls[0] ?? '');
      expect(scrubbed.indexOf('code='), `scrubbed URL still carries the code: ${scrubbed}`).toBe(
        -1,
      );
      expect(scrubbed.indexOf('state='), `scrubbed URL still carries the state: ${scrubbed}`).toBe(
        -1,
      );
      expect(scrubbed.indexOf(AUTH_CODE)).toBe(-1);
    });
  });

  it('★★ BITES: the scrub happens on the MISMATCH path too (unconditionally)', () => {
    // "matched or not". A client that only scrubs on success leaves an attacker-supplied
    // code in the URL bar of exactly the tab that just refused it — and a reload would
    // re-evaluate it.
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client.beginSignIn().then(() => {
      rig.setSearch(`?code=${AUTH_CODE}&state=deadbeef`);
      expect(client.consumeReturnLeg()).toBe(false);
      expect(rig.replaceStateUrls, 'a mismatch must still scrub').toHaveLength(1);
    });
  });

  it('★★ BITES: the stored state is deleted on the MATCHED path — a replay of the same return leg no longer matches', () => {
    // Single-use. WRONG IMPL KILLED: leaving `state` in storage after a match. A reload of
    // the (unscrubbed, in that broken world) URL, or a second `consumeReturnLeg()` call,
    // would re-arm `isReturnLegAttempt` and re-open the Better Auth call gate for a tab
    // that never authenticated — AUTH-44's exact hole (ADR-0182 D13's H1 finding).
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client.beginSignIn().then((result) => {
      const state = queryParam(
        (result as { authorizationUrl: string }).authorizationUrl,
        'state',
      ) as string;
      rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
      expect(client.consumeReturnLeg()).toBe(true);
      expect(
        client.consumeReturnLeg(),
        'a second evaluation of the same marker must not match',
      ).toBe(false);
    });
  });

  it('★★ BITES: the stored verifier is deleted on the MISMATCH path — the next renewOrExchange cannot exchange', () => {
    // "regardless of outcome". A verifier that survives a mismatch is a live PKCE secret
    // waiting for the NEXT code an attacker plants.
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client
      .beginSignIn()
      .then((result) => {
        const state = queryParam(
          (result as { authorizationUrl: string }).authorizationUrl,
          'state',
        ) as string;
        rig.setSearch(`?code=${AUTH_CODE}&state=not-the-state`);
        expect(client.consumeReturnLeg()).toBe(false);
        // Now feed the CORRECT state: the stored copy is gone, so it must still not match.
        rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
        expect(
          client.consumeReturnLeg(),
          'the stored state must have been consumed by the first evaluation',
        ).toBe(false);
        return client.renewOrExchange();
      })
      .then((outcome) => {
        expect(rig.tokenCallCount()).toBe(0);
        expect(outcome).toEqual({ kind: 'no-session' });
      });
  });

  it('★★ BITES: the pending exchange is consumed even when the exchange FAILS — no second exchange attempt', () => {
    // The other half of "regardless of outcome": a failed exchange must not leave the
    // authorization code and verifier in storage for the reconnect ladder to retry
    // forever. Every rung would re-POST a code the provider already burned.
    const rig = makeRig({ tokenResponse: GATEWAY_5XX });
    const client = createOidcClient(rig.host, CONFIG);
    return client
      .beginSignIn()
      .then((result) => {
        const state = queryParam(
          (result as { authorizationUrl: string }).authorizationUrl,
          'state',
        ) as string;
        rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
        client.consumeReturnLeg();
        return client.renewOrExchange();
      })
      .then((first) => {
        expect(first).toEqual({ kind: 'transient-error' });
        expect(rig.tokenCallCount()).toBe(1);
        return client.renewOrExchange();
      })
      .then((second) => {
        expect(rig.tokenCallCount(), 'the burnt code must never be re-POSTed').toBe(1);
        expect(second).toEqual({ kind: 'no-session' });
      });
  });
});

// ===========================================================================
// AUTH-42 — the refresh token is persisted, overwriting, before the token is used.
// ===========================================================================

describe('oidc.renewOrExchange (AUTH-42): the new refresh_token is persisted, overwriting, before the token is returned', () => {
  it('★★ BITES: after a successful exchange the refresh token is ALREADY in storage — a fresh client silently refreshes with it', () => {
    // "before the returned token is used to build a connection". Proved behaviourally: the
    // caller's very next act is `build(credential)`, so the only observable form of
    // "before" is that the write has landed by the time the promise resolves. A NEW client
    // over the SAME storage then finds it — which also proves the write went to storage and
    // not to a closure variable.
    //
    // WRONG IMPL KILLED: persisting inside a `.then()` chained after the resolution, or
    // holding the refresh token in memory only. Either way a reload mid-session logs the
    // player out and, worse, drops them onto the anonymous identity.
    const rig = makeRig();
    return completeSignIn(rig)
      .then(({ outcome }) => {
        expect(outcome).toEqual({ kind: 'ok', token: ID_TOKEN_1 });
        rig.setTokenResponse(OK_REFRESH);
        const second = createOidcClient(rig.host, CONFIG);
        return second.renewOrExchange();
      })
      .then((outcome) => {
        expect(outcome).toEqual({ kind: 'ok', token: ID_TOKEN_2 });
        const refreshCall = rig.fetchCalls.filter((c) => c.url === TOKEN_ENDPOINT)[1] as FetchCall;
        expect(
          String(refreshCall.init?.body ?? ''),
          'the second call must be a refresh grant',
        ).toContain('grant_type=refresh_token');
        expect(String(refreshCall.init?.body ?? '')).toContain(REFRESH_1);
      });
  });

  it('★★ BITES: the refresh token is OVERWRITTEN — the third call sends refresh-two, never refresh-one', () => {
    // Better Auth rotates refresh tokens on every refresh (confirmed by live doc fetch,
    // ADR-0182 D11: "this implementation currently issues a new refresh token for every
    // refresh request"). An implementation that writes only when the slot is empty replays
    // a token the provider has already invalidated, and the session dies at the first
    // renewal — indistinguishable from an expired session to the player.
    const rig = makeRig();
    return completeSignIn(rig)
      .then(() => {
        rig.setTokenResponse(OK_REFRESH);
        return createOidcClient(rig.host, CONFIG).renewOrExchange();
      })
      .then(() => createOidcClient(rig.host, CONFIG).renewOrExchange())
      .then(() => {
        const calls = rig.fetchCalls.filter((c) => c.url === TOKEN_ENDPOINT);
        expect(calls).toHaveLength(3);
        const body = String(calls[2]?.init?.body ?? '');
        expect(body, 'the rotated token must be used').toContain(REFRESH_2);
        expect(body, 'the superseded token must be gone from storage').not.toContain(REFRESH_1);
      });
  });

  it('★★ BITES (AUTH-48): a DEFINITIVE exchange failure persists NO refresh token', () => {
    // AUTH-48 spells this out: "SHALL NOT persist a refresh token". A client that wrote
    // whatever came back on the error body (or kept a partially-parsed one) would go on
    // presenting a dead credential on every reconnect, and AUTH-44's "no Better Auth calls
    // for a never-authenticated tab" would be permanently false for that tab.
    const rig = makeRig({ tokenResponse: DEFINITIVE_REJECT });
    const client = createOidcClient(rig.host, CONFIG);
    return client
      .beginSignIn()
      .then((result) => {
        const state = queryParam(
          (result as { authorizationUrl: string }).authorizationUrl,
          'state',
        ) as string;
        rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
        client.consumeReturnLeg();
        return client.renewOrExchange();
      })
      .then((outcome) => {
        expect(outcome.kind).toBe('exchange-failed');
        const before = rig.tokenCallCount();
        return createOidcClient(rig.host, CONFIG)
          .renewOrExchange()
          .then((next) => {
            expect(
              next,
              'nothing was persisted, so the next attempt has no session at all',
            ).toEqual({ kind: 'no-session' });
            expect(rig.tokenCallCount(), 'and it must not call the token endpoint').toBe(before);
          });
      });
  });

  it('★ BITES: the exchange POST carries the PKCE verifier and NO client secret (public client)', () => {
    // ADR-0182 D11: the OAuth client is registered with
    // `token_endpoint_auth_method: 'none'`. A `client_secret` in a browser is not a secret
    // — shipping one would be a real credential in the bundle AND would make the exchange
    // fail against a public client registration.
    const rig = makeRig();
    return completeSignIn(rig).then(() => {
      const call = rig.fetchCalls.filter((c) => c.url === TOKEN_ENDPOINT)[0] as FetchCall;
      const body = String(call.init?.body ?? '');
      expect(String(call.init?.method ?? '').toUpperCase()).toBe('POST');
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code_verifier=');
      expect(body).toContain(encodeURIComponent(AUTH_CODE));
      expect(body).toContain(`client_id=${CLIENT_ID}`);
      expect(body, 'a public client never sends a secret').not.toContain('client_secret');
    });
  });

  it('★ BITES: a 2xx response with NO id_token is a transient error, not a fabricated success', () => {
    // The token handed to `.withToken()` must be the ID token: `Identity = f(iss, sub)` and
    // `audience_allowed` (accounts.rs:91-93) checks `aud` against the client_id, which is
    // the ID token's audience — an access token would be rejected by the module and drop
    // the player onto the anonymous identity with no error. WRONG IMPL KILLED:
    // `token: body.access_token ?? body.id_token` and `token: String(body.id_token)`
    // (which yields the literal 'undefined').
    const rig = makeRig({
      tokenResponse: {
        ok: true,
        status: 200,
        body: { access_token: 'access-only', refresh_token: REFRESH_1 },
      },
    });
    const client = createOidcClient(rig.host, CONFIG);
    return client
      .beginSignIn()
      .then((result) => {
        const state = queryParam(
          (result as { authorizationUrl: string }).authorizationUrl,
          'state',
        ) as string;
        rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
        client.consumeReturnLeg();
        return client.renewOrExchange();
      })
      .then((outcome) => {
        expect(outcome).toEqual({ kind: 'transient-error' });
      });
  });
});

// ===========================================================================
// Discovery caching — once per tab.
// ===========================================================================

describe('oidc discovery (ADR-0182 D11): fetched once per client, then cached', () => {
  it('★★ BITES: a second operation on the SAME client issues NO second discovery fetch', () => {
    // "fetches and caches <issuer>/.well-known/openid-configuration once per tab". Without
    // the cache, every rung of the ADR-0085 reconnect ladder re-fetches discovery — during
    // exactly the outage that made the ladder run, turning a slow auth service into a
    // self-inflicted request storm.
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    return client
      .beginSignIn()
      .then((result) => {
        expect(rig.discoveryCallCount(), 'the first operation fetches discovery').toBe(1);
        const state = queryParam(
          (result as { authorizationUrl: string }).authorizationUrl,
          'state',
        ) as string;
        rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
        client.consumeReturnLeg();
        return client.renewOrExchange();
      })
      .then(() => {
        expect(
          rig.discoveryCallCount(),
          'the second operation must reuse the cached document',
        ).toBe(1);
      });
  });

  it('★ BITES: a discovery document that fails to parse is a transient error, never a hardcoded-path fallback', () => {
    // WRONG IMPL KILLED: `catch { return issuer + "/oauth2/token" }`. A silent fallback to
    // guessed paths turns a misconfigured issuer into POSTs at an endpoint that may belong
    // to something else entirely — with the authorization code in the body.
    const rig = makeRig({ discoveryMalformed: true });
    return createOidcClient(rig.host, CONFIG)
      .beginSignIn()
      .then((result) => {
        expect(result).toEqual({ kind: 'transient-error' });
        expect(rig.tokenCallCount()).toBe(0);
      });
  });
});

// ===========================================================================
// Storage-driven branch selection — NO flag argument (ADR-0182 D13 / H1).
// ===========================================================================

describe('oidc.renewOrExchange: branches on STORAGE alone, with no flag argument', () => {
  it('★★ BITES: renewOrExchange declares ZERO parameters (kills renewOrExchange(isReturnLeg))', () => {
    // The H1 finding, made mechanical. `connect()` is a singleton per page
    // (connection.ts:166-170), so a caller-supplied "this is the return leg" flag survives
    // the ONE page load it described and misclassifies every later reconnect. Function
    // arity is the one property of a signature that is observable at runtime.
    const rig = makeRig();
    const client = createOidcClient(rig.host, CONFIG);
    expect(client.renewOrExchange.length, 'renewOrExchange must take no arguments').toBe(0);
    expect(client.consumeReturnLeg.length, 'consumeReturnLeg must take no arguments').toBe(0);
    expect(client.beginSignIn.length, 'beginSignIn must take no arguments').toBe(0);
  });

  it('★★ BITES: a pending verifier selects the EXCHANGE grant', () => {
    const rig = makeRig();
    return completeSignIn(rig).then(({ outcome }) => {
      expect(outcome).toEqual({ kind: 'ok', token: ID_TOKEN_1 });
      const body = String(
        (rig.fetchCalls.filter((c) => c.url === TOKEN_ENDPOINT)[0] as FetchCall).init?.body ?? '',
      );
      expect(body).toContain('grant_type=authorization_code');
      expect(body).not.toContain('grant_type=refresh_token');
    });
  });

  it('★★ BITES: a stored refresh token with NO verifier selects the SILENT REFRESH grant', () => {
    const rig = makeRig();
    return completeSignIn(rig)
      .then(() => {
        rig.setTokenResponse(OK_REFRESH);
        return createOidcClient(rig.host, CONFIG).renewOrExchange();
      })
      .then((outcome) => {
        expect(outcome).toEqual({ kind: 'ok', token: ID_TOKEN_2 });
        const body = String(
          (rig.fetchCalls.filter((c) => c.url === TOKEN_ENDPOINT)[1] as FetchCall).init?.body ?? '',
        );
        expect(body).toContain('grant_type=refresh_token');
        expect(body).not.toContain('grant_type=authorization_code');
      });
  });

  it('★★ BITES (AUTH-44): NEITHER present -> no-session with ZERO fetches, not even discovery', () => {
    // AUTH-44's client-side half. `resolveCredential` only reaches here when the attempt
    // gate is open, but a module that fetches discovery before checking storage still
    // contacts Better Auth on every single reconnect of every tab that ever opened the
    // sign-in page once. Nothing to do means no network at all.
    const rig = makeRig();
    return createOidcClient(rig.host, CONFIG)
      .renewOrExchange()
      .then((outcome) => {
        expect(outcome).toEqual({ kind: 'no-session' });
        expect(
          rig.fetchCalls,
          'an empty flow record must produce NO network calls whatsoever',
        ).toEqual([]);
      });
  });

  it('★★ BITES: a definitive REFRESH rejection is `no-session` (AUTH-47), not `exchange-failed`', () => {
    // The two definitive-failure paths land on different outcomes on purpose: a failed
    // REFRESH for a tab that had a session is a session that expired (AUTH-47 ->
    // session-expired); a failed EXCHANGE is a sign-in that failed (AUTH-48 ->
    // sign-in-failed). Collapsing them shows "your session expired" to somebody who never
    // had one, or hides a genuine expiry behind the claim UI.
    const rig = makeRig();
    return completeSignIn(rig)
      .then(() => {
        rig.setTokenResponse(DEFINITIVE_REJECT);
        return createOidcClient(rig.host, CONFIG).renewOrExchange();
      })
      .then((outcome) => {
        expect(outcome).toEqual({ kind: 'no-session' });
      });
  });

  it('★★ BITES: a definitive EXCHANGE rejection is `exchange-failed` with a CLASSIFIED reason', () => {
    const rig = makeRig({ tokenResponse: DEFINITIVE_REJECT });
    const client = createOidcClient(rig.host, CONFIG);
    return client
      .beginSignIn()
      .then((result) => {
        const state = queryParam(
          (result as { authorizationUrl: string }).authorizationUrl,
          'state',
        ) as string;
        rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
        client.consumeReturnLeg();
        return client.renewOrExchange();
      })
      .then((outcome) => {
        expect(outcome.kind).toBe('exchange-failed');
        const reason = (outcome as { reason: string }).reason;
        expect(
          SIGN_IN_REASONS,
          `reason ${JSON.stringify(reason)} must be in the static vocabulary`,
        ).toContain(reason);
        // AUTH-57: the provider's `error_description` names a user's email address in this
        // fixture. NONE of it may ride out on the reason.
        expect(reason.indexOf('@'), 'the provider description must never reach the reason').toBe(
          -1,
        );
        expect(reason.indexOf('example.invalid')).toBe(-1);
        expect(reason.indexOf('redeemed')).toBe(-1);
      });
  });
});

// ===========================================================================
// TOTALITY — G27's precondition (the C1 CRITICAL).
// ===========================================================================

describe('oidc.renewOrExchange TOTALITY (G27 precondition): every failure resolves to transient-error, never rejects', () => {
  /**
   * Arm a real return leg on `rig`, then run `renewOrExchange`. The arming half must
   * SUCCEED — a fixture that fails during setup would assert nothing about the failure
   * under test, which is why `fetchThrows: 'token'` (not `'all'`) is the mode used below:
   * discovery still resolves, the exchange is what breaks.
   */
  const armAndRenew = async (rig: Rig): Promise<RenewalOutcome> => {
    const client = createOidcClient(rig.host, CONFIG);
    const begun = await client.beginSignIn();
    if (begun.kind !== 'ready') {
      throw new Error(`fixture broken: beginSignIn returned ${begun.kind} during setup`);
    }
    const state = queryParam(begun.authorizationUrl, 'state') as string;
    rig.setSearch(`?code=${AUTH_CODE}&state=${state}`);
    if (!client.consumeReturnLeg()) throw new Error('fixture broken: the return leg did not match');
    return client.renewOrExchange();
  };

  it('★★ BITES: a THROWING fetch at the token endpoint resolves to transient-error', async () => {
    // `fetch` rejects with a TypeError on DNS failure, CORS refusal, offline and an aborted
    // request — the ordinary conditions of the reconnect ladder. Letting it propagate would
    // escape `resolveCredential`; connection.ts's try/catch (G27) catches it, but the two
    // guards exist independently ON PURPOSE: this one keeps the CLASSIFICATION honest (a
    // network failure is transient, not a failed sign-in), the other is only the belt.
    const rig = makeRig({ fetchThrows: 'token' });
    await expect(armAndRenew(rig)).resolves.toEqual({ kind: 'transient-error' });
  });

  it('★★ BITES: a THROWING fetch at DISCOVERY resolves both entry points, never rejects', async () => {
    const rig = makeRig({ fetchThrows: 'all' });
    const client = createOidcClient(rig.host, CONFIG);
    await expect(client.beginSignIn()).resolves.toEqual({ kind: 'transient-error' });
    // Nothing was persisted (discovery never resolved), so the renewal has no session —
    // the point is that it RESOLVES rather than rejecting.
    await expect(client.renewOrExchange()).resolves.toEqual({ kind: 'no-session' });
  });

  it('★★ BITES: a THROWING crypto.subtle.digest resolves to transient-error and never rejects', async () => {
    // `subtle` is undefined on a non-secure origin and `digest` can reject under a
    // locked-down policy. WRONG IMPL KILLED: an unguarded `await subtle.digest(...)` whose
    // rejection becomes an unhandled promise rejection — which under vitest fails a
    // DIFFERENT test than the one that caused it, and in production escapes
    // `resolveCredential` on the ONE path (the claim-flow sign-in) that has a player
    // watching it.
    const rig = makeRig({ digestThrows: true });
    await expect(createOidcClient(rig.host, CONFIG).beginSignIn()).resolves.toEqual({
      kind: 'transient-error',
    });

    // And a digest that starts failing MID-FLIGHT (the sign-in was armed while crypto
    // worked) must still resolve. Either outcome is defensible — an implementation that
    // re-derives the challenge at exchange time reports transient-error, one that does not
    // succeeds — but NEITHER may reject.
    const armed = makeRig();
    const client = createOidcClient(armed.host, CONFIG);
    const begun = await client.beginSignIn();
    const state = queryParam(
      (begun as { authorizationUrl: string }).authorizationUrl,
      'state',
    ) as string;
    armed.setSearch(`?code=${AUTH_CODE}&state=${state}`);
    client.consumeReturnLeg();
    armed.setDigestThrows(true);
    const outcome = await client.renewOrExchange();
    expect(
      ['ok', 'transient-error'],
      `mid-flight digest failure produced ${outcome.kind}`,
    ).toContain(outcome.kind);
  });

  it('★★ BITES: MALFORMED JSON from the token endpoint resolves to transient-error', async () => {
    // A reverse proxy returning an HTML error page with a 200 is the classic shape.
    const rig = makeRig({
      tokenResponse: { ok: true, status: 200, body: undefined, malformed: true },
    });
    await expect(armAndRenew(rig)).resolves.toEqual({ kind: 'transient-error' });
  });

  it('★★ BITES: a NON-2xx with no OAuth error body resolves to transient-error, never a definitive rejection', async () => {
    // The split that makes AUTH-45/46 work: a 502 from a load balancer is AMBIGUOUS and
    // must climb the retry ladder; only a structured `{"error": ...}` body is definitive.
    // WRONG IMPL KILLED: `if (!res.ok) return {kind:'exchange-failed'}` — every gateway
    // hiccup during a claim flow would tell the player their sign-in failed and send them
    // back to the provider, and (via AUTH-48) would refuse to persist the refresh token
    // that would have recovered the session.
    await expect(armAndRenew(makeRig({ tokenResponse: GATEWAY_5XX }))).resolves.toEqual({
      kind: 'transient-error',
    });
    await expect(
      armAndRenew(
        makeRig({ tokenResponse: { ok: false, status: 503, body: { message: 'upstream down' } } }),
      ),
    ).resolves.toEqual({ kind: 'transient-error' });
  });

  it('★★ BITES: a hostile HOST (missing fetch / missing crypto / throwing storage) never rejects', async () => {
    // The whole host object is `unknown`-typed for exactly this reason: every one of these
    // shapes is reachable in a real browser (blocked storage, non-secure origin, a
    // sandboxed iframe with no fetch).
    const hosts: readonly (readonly [string, unknown])[] = [
      ['host is undefined', undefined],
      ['host is empty', {}],
      ['fetch is not a function', { sessionStorage: new FakeSessionStorage(), fetch: 'nope' }],
      [
        'crypto is missing',
        {
          sessionStorage: new FakeSessionStorage(),
          fetch: async () => ({ ok: true, status: 200, json: async () => DISCOVERY_DOC }),
        },
      ],
      ['getItem throws', { sessionStorage: new ThrowingGetStorage() }],
      ['setItem throws', { sessionStorage: new ThrowingSetStorage() }],
      [
        'history is missing',
        {
          sessionStorage: new FakeSessionStorage(),
          location: { search: `?code=${AUTH_CODE}&state=x` },
        },
      ],
    ];
    for (const [label, host] of hosts) {
      const client = createOidcClient(host as never, CONFIG);
      expect(() => client.consumeReturnLeg(), `consumeReturnLeg: ${label}`).not.toThrow();
      const outcome = await client.renewOrExchange();
      expect(
        ['no-session', 'transient-error'],
        `renewOrExchange: ${label} -> ${outcome.kind}`,
      ).toContain(outcome.kind);
      const begun = await client.beginSignIn();
      expect(['ready', 'transient-error'], `beginSignIn: ${label}`).toContain(begun.kind);
    }
  });

  it('★ BITES: the outcome kind is ALWAYS one of the four RenewalOutcome members (property over failure shapes)', () => {
    // Totality restated as a closed alphabet: `decideConnectCredential`'s table is
    // exhaustive over exactly these four, so a fifth kind (or `undefined`) silently falls
    // through its branch chain — the mutant credentialDecision.test.ts's own totality
    // property exists to catch from the other side.
    const kinds = ['ok', 'no-session', 'exchange-failed', 'transient-error'];
    return fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 599 }),
        fc.boolean(),
        async (status, malformed) => {
          const outcome = await armAndRenew(
            makeRig({
              tokenResponse: {
                ok: status < 300,
                status,
                body: { error: 'invalid_grant' },
                malformed,
              },
            }),
          );
          expect(kinds).toContain(outcome.kind);
        },
      ),
      { numRuns: 40 },
    );
  });
});

// ===========================================================================
// classifySignInReason — AUTH-57's static vocabulary.
// ===========================================================================

describe('classifySignInReason (AUTH-57): arbitrary provider text maps onto a small STATIC set', () => {
  it('★★ BITES: raw provider text NEVER passes through — an arbitrary string maps to a member of SIGN_IN_REASONS', () => {
    // THE LEAK THIS CLOSES: `opts.onSignInFailed(err.message)` puts third-party error text
    // on a callback that reaches the claim UI and (via main.ts) the error ring, the F9 bug
    // bundle and the telemetry sink. Better Auth's `error_description` routinely names the
    // account — an email, a `sub`, a trace id. G21's eval enforces the CALL SITE; this
    // enforces that the classifier it calls actually classifies.
    const hostile = [
      'user@example.invalid is not permitted (trace 8f31c2)',
      'invalid_grant: refresh token 7ab3... expired at 2026-08-10T00:00:00Z',
      '<html><body>502 Bad Gateway</body></html>',
      '',
      '   ',
    ];
    for (const raw of hostile) {
      const reason = classifySignInReason(raw);
      expect(SIGN_IN_REASONS, `raw ${JSON.stringify(raw)} -> ${reason}`).toContain(reason);
      expect(reason.indexOf('@'), 'no address may survive classification').toBe(-1);
      expect(reason.indexOf('trace')).toBe(-1);
      expect(reason.indexOf('7ab3')).toBe(-1);
    }
  });

  it('★★ BITES (property): EVERY string maps into the static set — kills `return raw` and `return raw.slice(0, 40)`', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(SIGN_IN_REASONS).toContain(classifySignInReason(raw));
      }),
    );
  });

  it('★ BITES: non-string inputs are total too (Error, undefined, null, object, number)', () => {
    // The classifier sits on a catch path, where `err` is `unknown` by construction — the
    // identical totality argument `isStoredCredentialRejected` makes at authToken.ts:70-77.
    for (const raw of [
      undefined,
      null,
      42,
      { error: 'invalid_grant' },
      new Error('boom'),
      Symbol('x'),
    ]) {
      expect(() => classifySignInReason(raw as unknown), String(raw)).not.toThrow();
      expect(SIGN_IN_REASONS, String(raw)).toContain(classifySignInReason(raw as unknown));
    }
  });

  it('★ BITES: the vocabulary is SMALL and every member is a bare kebab-case token (no interpolation slots)', () => {
    // A "static set" whose members are templates is not static. Kills a vocabulary that
    // grew a `sign-in-failed: ${detail}` member.
    expect(SIGN_IN_REASONS.length).toBeGreaterThanOrEqual(2);
    expect(
      SIGN_IN_REASONS.length,
      'a vocabulary this large is not a vocabulary',
    ).toBeLessThanOrEqual(8);
    for (const reason of SIGN_IN_REASONS) {
      expect(typeof reason).toBe('string');
      expect(reason.indexOf('$'), `${reason} looks interpolated`).toBe(-1);
      expect(reason.indexOf(':'), `${reason} carries a detail slot`).toBe(-1);
      expect(reason.trim()).toBe(reason);
      expect(reason.length).toBeGreaterThan(0);
    }
    // The one member other modules name by literal: credentialDecision.ts returns
    // `{kind:'sign-in-failed', reason:'auth-service-unreachable'}` for a threshold-exceeded
    // never-authenticated tab (plan ADDENDUM §B), so that token must exist here too.
    expect(SIGN_IN_REASONS).toContain('auth-service-unreachable');
  });

  it('★ BITES: distinguishable provider errors map to DISTINCT reasons (kills a constant classifier)', () => {
    // `return 'sign-in-failed'` satisfies every assertion above. The claim UI renders
    // different copy for "the provider rejected this sign-in" vs "we could not reach the
    // auth service", so collapsing them is a real regression.
    expect(classifySignInReason('invalid_grant')).not.toBe(classifySignInReason('invalid_client'));
  });
});

// ===========================================================================
// Key namespacing + disjointness.
// ===========================================================================

describe('oidcFlowStorageKey: mr.oidcFlow.v1|<uri>|<db>, disjoint from the authToken/authKind spaces', () => {
  it('★ BITES: the prefix is exactly `mr.oidcFlow.v1` and the key starts with it', () => {
    expect(OIDC_FLOW_KEY_PREFIX).toBe('mr.oidcFlow.v1');
    expect(oidcFlowStorageKey(URI, DB).indexOf(OIDC_FLOW_KEY_PREFIX)).toBe(0);
  });

  it('★★ BITES: neither this prefix nor mr.authToken.v1 / mr.authKind.v1 is a prefix of the other', () => {
    // The construction authToken.ts:215-224 argues in prose. A collision would let a
    // refresh-token write land in the slot `tokenForNextAttempt()` hands to
    // `.withToken()` — the SDK would then present a refresh token as a connection
    // credential on every build, failing verification forever.
    for (const other of ['mr.authToken.v1', 'mr.authKind.v1', 'mr.claimCode.v1']) {
      expect(OIDC_FLOW_KEY_PREFIX.startsWith(other), `vs ${other}`).toBe(false);
      expect(other.startsWith(OIDC_FLOW_KEY_PREFIX), `vs ${other}`).toBe(false);
    }
  });

  it('★★ BITES (property): DISTINCT (uri, db) pairs derive DISTINCT keys (per-segment encoding)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (u1, d1, u2, d2) => {
        if (u1 === u2 && d1 === d2) {
          expect(oidcFlowStorageKey(u1, d1)).toBe(oidcFlowStorageKey(u2, d2));
          return;
        }
        expect(oidcFlowStorageKey(u1, d1)).not.toBe(oidcFlowStorageKey(u2, d2));
      }),
    );
  });

  it('★ BITES: the `a|b`+`c` vs `a`+`b|c` adversarial pair does not collide', () => {
    expect(oidcFlowStorageKey('a|b', 'c')).not.toBe(oidcFlowStorageKey('a', 'b|c'));
  });

  it('★★ BITES (AUTH-58): a host exposing ONLY localStorage is never touched', () => {
    const localFake = new FakeSessionStorage();
    const rig = makeRig();
    const host = { ...rig.host, sessionStorage: undefined, localStorage: localFake };
    const client = createOidcClient(host as never, CONFIG);
    client.consumeReturnLeg();
    return client
      .renewOrExchange()
      .then(() => client.beginSignIn())
      .then(() => {
        expect(localFake.calls, 'localStorage must never be read or written').toEqual([]);
        expect(localFake.size).toBe(0);
      });
  });
});

// ===========================================================================
// G30 (half) — SOURCE SCAN of oidc.ts.
//
// Same split of duties, and the same NAMED RESIDUAL, as claimCode.test.ts's scan:
// a substring scan cannot see bracket/string-splitting evasion
// (`globalThis['session' + 'Storage']`). What it guarantees is that the shipped
// source does not NAME the banned surfaces; the injected-host behaviour above is
// what makes an evasion pointless, and review is where a deliberate one is caught.
// ===========================================================================

const OIDC_TS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oidc.ts');

function readSourceOrThrow(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${filePath} — ${String(err)}`);
  }
}

function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

/** Copied in behaviour from connection.test.ts:95-122 so the two scans cannot drift. */
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

function moduleEdgeLines(stripped: string): string[] {
  return stripped
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith('import') || line.startsWith('export {') || line.startsWith('export *'),
    );
}

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

describe('G30 (oidc.ts source scan): every ambient surface arrives through the injected host', () => {
  it('★ CALIBRATION: the stripper is not vacuous, and oidc.ts carries no scheme literal', () => {
    // Plan ADDENDUM §C, last bullet. (1) proves the stripper strips and keeps; (2) closes
    // `stripComments`'s quote-blindness — it truncates each line at the first two-slash
    // token, so a live line carrying a URL would hide everything after it from every ban
    // below. Every URL oidc.ts needs comes from the discovery document or from
    // `OidcConfig`, so zero scheme literals is achievable AND is the design.
    const fixture = [
      'const live = 1;',
      '// globalThis.fetch(x)',
      '/* localStorage.setItem() */ const also = 2;',
    ].join('\n');
    const strippedFixture = stripComments(fixture);
    expect(countOccurrences(strippedFixture, 'globalThis')).toBe(0);
    expect(countOccurrences(strippedFixture, 'localStorage')).toBe(0);
    expect(countOccurrences(strippedFixture, 'const live = 1;')).toBe(1);
    expect(countOccurrences(strippedFixture, 'const also = 2;')).toBe(1);

    expect(
      countOccurrences(readSourceOrThrow(OIDC_TS_PATH), ':' + '//'),
      'oidc.ts must contain no scheme literal: the line-comment stripper truncates at the ' +
        'first two-slash token, so a URL on a live line hides whatever follows it from ' +
        'every ban in this block. Take every endpoint from discovery or from OidcConfig',
    ).toBe(0);
  });

  it('★★ BITES: zero localStorage / indexedDB / document.cookie / globalThis / window in the comment-stripped source', () => {
    // WRONG IMPL KILLED (a): `globalThis.fetch(...)` when `host.fetch` is missing — every
    //   totality test above still passes (node HAS fetch) while the injected-host
    //   discipline silently stops applying, and the eval that scans for network calls in
    //   oidc.ts stops seeing them.
    // WRONG IMPL KILLED (b): `localStorage` for the refresh token — AUTH-58 violated, and
    //   an origin-shared refresh token re-opens the cross-tab identity hazard ADR-0150 D3
    //   closes.
    // WRONG IMPL KILLED (c): `window.history.replaceState(...)` — the scrub would silently
    //   no-op under vitest and the AUTH-41 ordering test would be judging nothing.
    const stripped = stripComments(readSourceOrThrow(OIDC_TS_PATH));

    expect(
      countOccurrences(stripped, 'sessionStorage'),
      'anti-vacuity: the scanned source must actually reference sessionStorage',
    ).toBeGreaterThanOrEqual(1);
    expect(
      countOccurrences(stripped, 'export'),
      'anti-vacuity: it must export something',
    ).toBeGreaterThanOrEqual(3);

    for (const banned of ['localStorage', 'indexedDB', 'document.cookie', 'globalThis', 'window']) {
      expect(
        countOccurrences(stripped, banned),
        `oidc.ts must never name "${banned}" — storage, location, history, crypto and fetch ` +
          'are ALL injected through OidcHost (ADR-0182 D12 / G30)',
      ).toBe(0);
    }
  });

  it('★★ BITES: every `sessionStorage` occurrence is host-scoped (kills a bare implicit-global access)', () => {
    const verdict = sessionStorageReachesOnlyThroughHost(
      stripComments(readSourceOrThrow(OIDC_TS_PATH)),
    );
    expect(
      verdict.ok,
      `every line naming sessionStorage must also name the injected host. Offending: ${JSON.stringify(verdict.offending)}`,
    ).toBe(true);
  });

  it('★★ BITES: the ONLY module edge is a TYPE import from ./credentialDecision; no `import *`', () => {
    // Plan ADDENDUM §C, F19. oidc.ts is where the network, the crypto and the tab's
    // storage meet; a runtime import here is a runtime dependency for every one of them.
    // The type import of `RenewalOutcome` is free at runtime and is the ONLY edge the
    // design needs (credentialDecision.ts owns its own input alphabet — ADR-0182 D13).
    //
    // WRONG IMPL KILLED: `import { createAuthTokenGate } from './authToken'` (two storage
    // seams with different fail directions fused into one), or a runtime import of the
    // generated SDK bindings (which would make oidc.ts un-importable under vitest and
    // delete this whole file's ability to test anything).
    const stripped = stripComments(readSourceOrThrow(OIDC_TS_PATH));
    expect(countOccurrences(stripped, 'import *'), 'no namespace imports').toBe(0);
    expect(countOccurrences(stripped, 'require('), 'no CommonJS require').toBe(0);

    const edges = moduleEdgeLines(stripped);
    for (const line of edges) {
      expect(
        line.startsWith('import type') || line.startsWith('export type'),
        `oidc.ts may carry TYPE-ONLY module edges. Offending line: ${JSON.stringify(line)}`,
      ).toBe(true);
      expect(
        line.indexOf('./credentialDecision') >= 0,
        `oidc.ts may only import from './credentialDecision'. Offending line: ${JSON.stringify(line)}`,
      ).toBe(true);
    }
  });
});
