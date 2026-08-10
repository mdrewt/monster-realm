// net/oidc.ts — the OIDC / PKCE sign-in flow (ADR-0182 D11/D12/D13, M21b-2).
//
// Everything the flow touches — storage, the URL bar, history, crypto and the network — is
// INJECTED through OidcHost (never an ambient reach), so every branch is unit-testable in
// node with no DOM. G30 source-scans this file to prove it names no ambient global and that
// its only module edge is a TYPE import of RenewalOutcome. There is no scheme literal in this
// source: every endpoint comes from the discovery document or from OidcConfig.
//
// TOTALITY IS LOAD-BEARING (G27's precondition, the C1 CRITICAL): renewOrExchange() and
// beginSignIn() NEVER reject across the boundary. Every internal fetch/crypto/JSON error is
// caught and mapped to a transient-error / no-session outcome. connection.ts's
// `try { await resolveCredential() }` is the belt; this file is the braces.
//
// SINGLE-USE, WHICHEVER WAY CONSUMPTION GOES (AUTH-41): consumeReturnLeg deletes the stored
// `state` on every path and the `code_verifier` on every NON-matched path; on a match it
// records the authorization code alongside the verifier so renewOrExchange can branch on
// STORAGE ALONE (D13). renewOrExchange deletes both before it can observe the exchange
// result, so a throw, a rejection, a 5xx and a success all leave the same empty slot. A
// network blip during the exchange costs the sign-in — the direction AUTH-41 chose, because a
// replayable authorization code is the worse failure.

import type { RenewalOutcome } from './credentialDecision';

/** The injected host. `location`/`history`/`crypto`/`fetch` are `unknown` on purpose —
 *  parse-don't-validate happens at each use, because a real browser hands back any shape and
 *  the property access itself can throw. `sessionStorage` is reached through a cast in
 *  storageMethod (never re-declared here) so the G30 scan sees it only host-scoped. */
export interface OidcHost {
  readonly location?: unknown;
  readonly history?: unknown;
  readonly crypto?: unknown;
  readonly fetch?: unknown;
}

/** Static configuration for one connection target. `uri`/`db` are the two storage-key axes. */
export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly uri: string;
  readonly db: string;
}

/** Storage-key namespace. `v1` so a future format change invalidates cleanly. Chosen so
 *  neither it nor `mr.authToken.v1` / `mr.authKind.v1` / `mr.claimCode.v1` is a prefix of the
 *  other. */
export const OIDC_FLOW_KEY_PREFIX = 'mr.oidcFlow.v1';

/** The discovery sub-path. Held apart from any origin so this file carries no scheme literal
 *  (the discovery URL is `<issuer><this>` at runtime). */
const DISCOVERY_PATH = '/.well-known/openid-configuration';

/** State and PKCE verifier are each 32 random bytes. State hex-encodes to 64 chars; the
 *  verifier base64url-encodes to 43. */
const RANDOM_BYTE_LENGTH = 32;

/** base64url alphabet (RFC 4648 §5): `-`/`_` for 62/63, no padding. */
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The STATIC vocabulary any provider error text is mapped onto (AUTH-57). Small and bare —
 *  no interpolation slots — so no third-party error string can ride out on a reason. */
export type SignInReason =
  | 'sign-in-rejected'
  | 'sign-in-expired'
  | 'sign-in-declined'
  | 'auth-service-unreachable'
  | 'sign-in-failed';

export const SIGN_IN_REASONS: readonly SignInReason[] = [
  'sign-in-rejected',
  'sign-in-expired',
  'sign-in-declined',
  'auth-service-unreachable',
  'sign-in-failed',
];

export type BeginSignInResult =
  | { readonly kind: 'ready'; readonly authorizationUrl: string }
  | { readonly kind: 'transient-error' };

export interface OidcClient {
  consumeReturnLeg(): boolean;
  beginSignIn(): Promise<BeginSignInResult>;
  renewOrExchange(): Promise<RenewalOutcome>;
}

/**
 * Per-target flow key. Two axes, each percent-encoded so a `|` inside a value cannot collide
 * two targets onto one key (encodeURIComponent escapes `|`, making the derivation injective).
 * Case is PRESERVED. Same construction as authToken.ts's storageKey.
 */
export function oidcFlowStorageKey(uri: string, db: string): string {
  return `${OIDC_FLOW_KEY_PREFIX}|${encodeURIComponent(uri)}|${encodeURIComponent(db)}`;
}

/**
 * Map arbitrary provider error text onto the static vocabulary. TOTAL over `unknown` (the
 * classifier sits on a catch path where `err` is unknown by construction) and NEVER returns
 * the raw text — the same discipline isStoredCredentialRejected applies at authToken.ts:70-77.
 */
export function classifySignInReason(raw: unknown): SignInReason {
  const text = typeof raw === 'string' ? raw : '';
  const has = (needle: string): boolean => text.indexOf(needle) >= 0;
  if (has('invalid_grant') || has('expired')) return 'sign-in-expired';
  if (has('access_denied') || has('denied') || has('declined')) return 'sign-in-declined';
  if (
    has('invalid_client') ||
    has('invalid_request') ||
    has('unauthorized_client') ||
    has('unsupported')
  ) {
    return 'sign-in-rejected';
  }
  if (has('unreachable') || has('network') || has('timeout') || has('gateway')) {
    return 'auth-service-unreachable';
  }
  return 'sign-in-failed';
}

/** Narrow an unknown storage-ish value to the one method we are about to call. Returns
 *  undefined rather than throwing so every caller degrades silently. Mirrors
 *  authToken.ts:104-120; the sessionStorage read is host-scoped (G30). */
function storageMethod(host: OidcHost | undefined, name: 'getItem' | 'setItem' | 'removeItem') {
  try {
    const storage = (host as { readonly sessionStorage?: unknown } | undefined)?.sessionStorage as
      | Record<string, unknown>
      | undefined
      | null;
    if (typeof storage !== 'object' || storage === null) return undefined;
    const fn = storage[name];
    return typeof fn === 'function'
      ? (fn as (...args: string[]) => unknown).bind(storage)
      : undefined;
  } catch {
    return undefined;
  }
}

function readItem(host: OidcHost | undefined, key: string): string | undefined {
  const getItem = storageMethod(host, 'getItem');
  if (getItem === undefined) return undefined;
  try {
    const raw = getItem(key);
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Write a value, returning whether it landed. The caller uses the boolean to REFUSE (mint a
 *  one-shot secret it cannot remember). */
function writeItem(host: OidcHost | undefined, key: string, value: string): boolean {
  const setItem = storageMethod(host, 'setItem');
  if (setItem === undefined) return false;
  try {
    setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function deleteItem(host: OidcHost | undefined, key: string): void {
  const removeItem = storageMethod(host, 'removeItem');
  if (removeItem === undefined) return;
  try {
    removeItem(key);
  } catch {
    // silent degradation
  }
}

/** Draw exactly `n` bytes from the injected CSPRNG, or undefined (never a Math.random
 *  fallback) — a predictable state/verifier defeats PKCE entirely. */
function drawRandomBytes(host: OidcHost | undefined, n: number): Uint8Array | undefined {
  try {
    const source = (host as { crypto?: unknown } | undefined)?.crypto as
      | { getRandomValues?: unknown }
      | undefined
      | null;
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

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** base64url with no padding, computed from the alphabet directly so this file depends on no
 *  ambient encoder (Buffer/btoa) — matching Node's `base64url` byte-for-byte. */
function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64URL_ALPHABET[(n >>> 18) & 63] +
      B64URL_ALPHABET[(n >>> 12) & 63] +
      B64URL_ALPHABET[(n >>> 6) & 63] +
      B64URL_ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64URL_ALPHABET[(n >>> 18) & 63] + B64URL_ALPHABET[(n >>> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      B64URL_ALPHABET[(n >>> 18) & 63] +
      B64URL_ALPHABET[(n >>> 12) & 63] +
      B64URL_ALPHABET[(n >>> 6) & 63];
  }
  return out;
}

/** ASCII bytes of a base64url/ASCII string, without an ambient TextEncoder — every character
 *  the verifier can hold is < 128 by construction. This is what `subtle.digest` hashes
 *  (RFC 7636's `ASCII(code_verifier)`). */
function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

/** SHA-256 of the verifier via the injected subtle, base64url'd — or undefined on any failure
 *  (missing subtle, throwing digest). S256; `plain` is never used. */
async function computeChallenge(
  host: OidcHost | undefined,
  verifier: string,
): Promise<string | undefined> {
  try {
    const subtle = (
      (host as { crypto?: unknown } | undefined)?.crypto as { subtle?: unknown } | undefined | null
    )?.subtle as { digest?: unknown } | undefined | null;
    const digest = subtle?.digest;
    if (typeof digest !== 'function') return undefined;
    const hashBuf = await (digest as (a: unknown, d: unknown) => Promise<ArrayBuffer>).call(
      subtle,
      { name: 'SHA-256' },
      asciiBytes(verifier),
    );
    return base64UrlEncode(new Uint8Array(hashBuf));
  } catch {
    return undefined;
  }
}

/** Read one query parameter out of a `location.search` string, without `new URL` (which needs
 *  a scheme literal) and without a regex. */
function readParam(search: string, name: string): string | undefined {
  let s = search;
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(q + 1);
  if (s === '') return undefined;
  for (const pair of s.split('&')) {
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      key = rawKey;
    }
    if (key === name) {
      if (eq < 0) return '';
      try {
        return decodeURIComponent(pair.slice(eq + 1));
      } catch {
        return pair.slice(eq + 1);
      }
    }
  }
  return undefined;
}

type TokenResponse = { readonly ok: boolean; readonly status: number; json(): Promise<unknown> };

/**
 * Build the OIDC client for one connection target. The discovery document, the flow record
 * and the return-leg state are all scoped to this client.
 */
export function createOidcClient(host: OidcHost | undefined, config: OidcConfig): OidcClient {
  const flowBase = oidcFlowStorageKey(config.uri, config.db);
  const STATE_KEY = `${flowBase}|state`;
  const VERIFIER_KEY = `${flowBase}|verifier`;
  const CODE_KEY = `${flowBase}|code`;
  const REFRESH_KEY = `${flowBase}|refresh`;

  let cachedDiscovery: { authorizationEndpoint: string; tokenEndpoint: string } | undefined;

  async function doFetch(url: string, init?: unknown): Promise<TokenResponse> {
    const fn = (host as { fetch?: unknown } | undefined)?.fetch;
    if (typeof fn !== 'function') throw new Error('no fetch');
    const res = await (fn as (u: string, i?: unknown) => Promise<unknown>)(url, init);
    return res as TokenResponse;
  }

  /** Fetch + cache the discovery document once per client. Throws on any failure (which
   *  beginSignIn/renewOrExchange catch) rather than falling back to guessed paths. */
  async function getDiscovery(): Promise<{ authorizationEndpoint: string; tokenEndpoint: string }> {
    if (cachedDiscovery !== undefined) return cachedDiscovery;
    const issuer = config.issuer.endsWith('/') ? config.issuer.slice(0, -1) : config.issuer;
    const res = await doFetch(issuer + DISCOVERY_PATH);
    if (!res.ok) throw new Error('discovery request failed');
    const doc = await res.json();
    const authEndpoint = (doc as { authorization_endpoint?: unknown } | null | undefined)
      ?.authorization_endpoint;
    const tokenEndpoint = (doc as { token_endpoint?: unknown } | null | undefined)?.token_endpoint;
    if (typeof authEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
      throw new Error('discovery document missing endpoints');
    }
    cachedDiscovery = { authorizationEndpoint: authEndpoint, tokenEndpoint };
    return cachedDiscovery;
  }

  /** Turn a token-endpoint response into an outcome. The refresh path and the exchange path
   *  land a DEFINITIVE rejection on different outcomes (session-expired vs sign-in-failed). */
  async function handleTokenResponse(
    res: TokenResponse,
    isRefresh: boolean,
  ): Promise<RenewalOutcome> {
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { kind: 'transient-error' };
      }
      const err = (body as { error?: unknown } | null | undefined)?.error;
      if (typeof err === 'string' && err !== '') {
        // A structured OAuth error body is DEFINITIVE. Only `error` is read — never
        // `error_description`, which routinely names the account (AUTH-57).
        if (isRefresh) return { kind: 'no-session' };
        return { kind: 'exchange-failed', reason: classifySignInReason(err) };
      }
      // A bare non-2xx (a 5xx from a gateway) is AMBIGUOUS: climb the retry ladder.
      return { kind: 'transient-error' };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: 'transient-error' };
    }
    const idToken = (body as { id_token?: unknown } | null | undefined)?.id_token;
    if (typeof idToken !== 'string' || idToken === '') {
      // The credential handed to .withToken() must be the ID token (its `aud` is the
      // client_id the module checks). An access-token-only response is not a success.
      return { kind: 'transient-error' };
    }
    const refresh = (body as { refresh_token?: unknown } | null | undefined)?.refresh_token;
    if (typeof refresh === 'string' && refresh !== '') {
      // Persist (overwriting) BEFORE returning: the caller's next act is build(credential),
      // so "before the token is used" is observable only as "the write has already landed".
      writeItem(host, REFRESH_KEY, refresh);
    }
    return { kind: 'ok', token: idToken };
  }

  return {
    consumeReturnLeg(): boolean {
      try {
        const loc = (host as { location?: unknown } | undefined)?.location as
          | { search?: unknown }
          | undefined
          | null;
        const search = typeof loc?.search === 'string' ? loc.search : '';
        const code = readParam(search, 'code');
        const returnedState = readParam(search, 'state');
        if (code === undefined && returnedState === undefined) {
          // Ordinary page load — completely inert: no scrub, no storage write.
          return false;
        }
        // A return marker is present. Scrub FIRST, unconditionally, before any other work —
        // until it lands the authorization code sits in the URL bar (Referer, history, error
        // reporters). This must precede the storage read.
        const history = (host as { history?: unknown } | undefined)?.history as
          | { replaceState?: unknown }
          | undefined
          | null;
        const replaceState = history?.replaceState;
        if (typeof replaceState === 'function') {
          const pathname = (host as { location?: unknown } | undefined)?.location as
            | { pathname?: unknown }
            | undefined
            | null;
          const scrubbed = typeof pathname?.pathname === 'string' ? pathname.pathname : '/';
          try {
            (replaceState as (d: unknown, u: unknown, url: unknown) => void).call(
              history,
              null,
              '',
              scrubbed,
            );
          } catch {
            // a failed scrub must not abort the single-use consumption below
          }
        }
        const storedState = readItem(host, STATE_KEY);
        // Single-use: the stored state is consumed on EVERY path (matched or not).
        deleteItem(host, STATE_KEY);
        const matched =
          code !== undefined &&
          returnedState !== undefined &&
          storedState !== undefined &&
          storedState === returnedState;
        if (!matched) {
          // Single-use, regardless of outcome: a verifier that survives a mismatch is a live
          // PKCE secret waiting for the next code an attacker plants.
          deleteItem(host, VERIFIER_KEY);
          return false;
        }
        // Record the authorization code alongside the verifier so renewOrExchange branches on
        // storage alone (D13). The verifier stays until the exchange consumes it.
        writeItem(host, CODE_KEY, code);
        return true;
      } catch {
        return false;
      }
    },

    async beginSignIn(): Promise<BeginSignInResult> {
      try {
        const disco = await getDiscovery();
        const stateBytes = drawRandomBytes(host, RANDOM_BYTE_LENGTH);
        const verifierBytes = drawRandomBytes(host, RANDOM_BYTE_LENGTH);
        if (stateBytes === undefined || verifierBytes === undefined) {
          return { kind: 'transient-error' };
        }
        const state = toHex(stateBytes);
        const verifier = base64UrlEncode(verifierBytes);
        const challenge = await computeChallenge(host, verifier);
        if (challenge === undefined) return { kind: 'transient-error' };
        // Persist BEFORE handing back a URL: if the write fails, navigating anyway guarantees
        // the return leg finds nothing to compare against. Refusing up front is the only
        // outcome the UI can explain (claimCode.mint makes the same call).
        if (!writeItem(host, STATE_KEY, state) || !writeItem(host, VERIFIER_KEY, verifier)) {
          return { kind: 'transient-error' };
        }
        const params: readonly (readonly [string, string])[] = [
          ['response_type', 'code'],
          ['client_id', config.clientId],
          ['redirect_uri', config.redirectUri],
          ['scope', 'openid'],
          ['state', state],
          ['code_challenge', challenge],
          ['code_challenge_method', 'S256'],
        ];
        const query = params
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&');
        // The module returns the URL; main.ts owns "when does this tab leave the page".
        return { kind: 'ready', authorizationUrl: `${disco.authorizationEndpoint}?${query}` };
      } catch {
        return { kind: 'transient-error' };
      }
    },

    async renewOrExchange(): Promise<RenewalOutcome> {
      try {
        const code = readItem(host, CODE_KEY);
        const verifier = readItem(host, VERIFIER_KEY);
        if (code !== undefined && verifier !== undefined) {
          // Single-use: consume BOTH before observing the exchange result — a throw, a 5xx
          // and a success all leave the same empty slot, so the burnt code is never re-POSTed.
          deleteItem(host, CODE_KEY);
          deleteItem(host, VERIFIER_KEY);
          const disco = await getDiscovery();
          const body =
            `grant_type=authorization_code` +
            `&code=${encodeURIComponent(code)}` +
            `&code_verifier=${encodeURIComponent(verifier)}` +
            `&client_id=${encodeURIComponent(config.clientId)}` +
            `&redirect_uri=${encodeURIComponent(config.redirectUri)}`;
          const res = await doFetch(disco.tokenEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
          });
          return await handleTokenResponse(res, false);
        }
        const refresh = readItem(host, REFRESH_KEY);
        if (refresh !== undefined) {
          const disco = await getDiscovery();
          const body =
            `grant_type=refresh_token` +
            `&refresh_token=${encodeURIComponent(refresh)}` +
            `&client_id=${encodeURIComponent(config.clientId)}`;
          const res = await doFetch(disco.tokenEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
          });
          return await handleTokenResponse(res, true);
        }
        // Nothing in storage: no network at all (AUTH-44).
        return { kind: 'no-session' };
      } catch {
        return { kind: 'transient-error' };
      }
    },
  };
}
