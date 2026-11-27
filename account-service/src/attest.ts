import { createPrivateKey, type KeyObject, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SignJWT } from 'jose';
import { accountClaims, BASE_GAME_ENTITLEMENT, ENTITLEMENT_CLAIM } from './claims.ts';
import type { Account } from './interactions/router.ts';
import type { AttestationKeys, SigningKeys } from './keys.ts';
import { createRateLimiter } from './rateLimit.ts';
import {
  createIdTokenCheck,
  errorClass,
  isVisibleAscii,
  mediaType,
  readBody,
  sendJson,
} from './worldTicket.ts';

export const ATTEST_PATH = '/attest';
export const ATTESTATION_TTL_SECONDS = 300;
/** An account gets at most this many attestations within any `ATTESTATION_WINDOW_SECONDS`. */
export const ATTESTATION_LIMIT = 20;
export const ATTESTATION_WINDOW_SECONDS = 3600;
export const MAX_WORLD_LENGTH = 512;
export const MAX_NONCE_LENGTH = 128;
export const MAX_ATTEST_BODY_BYTES = 1024;

type AttestationClaims = {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly nonce: string;
  readonly mr_ent: readonly string[];
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
};

/** Every claim of an attestation. */
export const ATTESTATION_CLAIMS = [
  'iss',
  'sub',
  'aud',
  'nonce',
  'mr_ent',
  'iat',
  'exp',
  'jti',
] as const satisfies readonly (keyof AttestationClaims)[];

/** The issuer name an attestation carries. It is not the login issuer, which no world trusts. */
export function attestationIssuer(issuer: string): string {
  return `${issuer}/attest`;
}

export interface AttestRouteOptions {
  /** The login issuer, as its tokens carry it. */
  readonly issuer: string;
  /** The login keys: a bearer token must verify under the public half of one of them. */
  readonly loginKeys: SigningKeys;
  /** The attestation keys: the first signs. */
  readonly attestationKeys: AttestationKeys;
  /** The account behind a subject, read for every attestation; undefined when there is none. */
  readonly account: (sub: string) => Promise<Account | undefined>;
  /** Receives every line the route logs. */
  readonly log: (line: string) => void;
  /** Whole epoch seconds; default the system clock. The only clock the route reads. */
  readonly now?: () => number;
}

type ErrorCode =
  | 'method_not_allowed'
  | 'invalid_token'
  | 'not_entitled'
  | 'invalid_request'
  | 'rate_limited'
  | 'server_error';

/**
 * Every answer says these. The route reads no cookie, so the bearer token is the only way in and
 * a page that holds one could send it from anywhere: an answer is readable from any origin.
 */
const ANSWER_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'retry-after, www-authenticate',
} as const;

/** On an answer sent while the request's body is unread: the connection is not reused. */
const UNREAD = { connection: 'close' } as const;

const JSON_TYPE = 'application/json';

/**
 * The handler of `POST /attest`: a bearer ID token of this issuer and `{ world, nonce }` in, an
 * attestation out, signed by the first attestation key and naming that world, nonce and account.
 *
 * The handler returns true when the request is for the route (it will be answered), and false,
 * having touched nothing, when it is not: the route is exactly `ATTEST_PATH`, under the issuer's
 * `Host`. It never throws, and nothing it starts rejects.
 *
 * A request is checked in this order, and the first failure answers: the bearer token (signed by
 * a login key, from this issuer, unexpired), its entitlement claim, the body, the account's limit,
 * then the account itself, read afresh, since a token outlives a cleared entitlement and a binding
 * outlives both. The token is checked before any of the body is read.
 *
 * The limit counts requests that reached it with a valid token and body. A request the account
 * read refuses keeps its place in the count; one the service failed gives it back.
 *
 * One line is logged per attestation issued, with the account and the time, and one per failure
 * of the service, with the account, the time, the step and the error's class. A refusal logs
 * nothing, so a caller cannot write lines at will. No line holds the world, the nonce, the body, a
 * token or an error's message.
 */
export function createAttestRoute(
  options: AttestRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const { issuer, log } = options;
  const host = new URL(issuer).host;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const bearer = createIdTokenCheck({ issuer, loginKeys: options.loginKeys, now });
  const limiter = createRateLimiter({
    limit: ATTESTATION_LIMIT,
    windowSeconds: ATTESTATION_WINDOW_SECONDS,
    now,
  });

  let signingKey: KeyObject | undefined;
  const sign = (claims: AttestationClaims): Promise<string> => {
    const { kty, crv, x, d, kid } = options.attestationKeys.keys[0];
    signingKey ??= createPrivateKey({ key: { kty, crv, x, d }, format: 'jwk' });
    return new SignJWT(claims).setProtectedHeader({ alg: 'Ed25519', kid }).sign(signingKey);
  };

  const answer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...ANSWER_HEADERS,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      refuse(res, 405, 'method_not_allowed', { allow: 'POST, OPTIONS', ...UNREAD });
      return;
    }
    const caller = await bearer(req.headers.authorization);
    if (caller === undefined) {
      refuse(res, 401, 'invalid_token', { 'www-authenticate': 'Bearer', ...UNREAD });
      return;
    }
    const claimed = caller.claims[ENTITLEMENT_CLAIM];
    if (!(Array.isArray(claimed) && claimed.includes(BASE_GAME_ENTITLEMENT))) {
      refuse(res, 403, 'not_entitled', UNREAD);
      return;
    }
    if (mediaType(req) !== JSON_TYPE) {
      refuse(res, 415, 'invalid_request', UNREAD);
      return;
    }
    const body = await readBody(req, MAX_ATTEST_BODY_BYTES);
    if (body === 'gone') return;
    if (body === 'too-large') {
      refuse(res, 413, 'invalid_request', UNREAD);
      return;
    }
    const asked = parseRequest(body);
    if (asked === undefined) {
      refuse(res, 400, 'invalid_request');
      return;
    }

    const { sub } = caller;
    if (!limiter.take(sub)) {
      refuse(res, 429, 'rate_limited', { 'retry-after': String(limiter.retryAfter(sub)) });
      return;
    }
    const iat = now();
    const at = new Date(iat * 1000).toISOString();
    let step = 'account';
    let attestation: string;
    try {
      const account = await options.account(sub);
      const entitlement =
        account === undefined ? undefined : accountClaims(account)[ENTITLEMENT_CLAIM];
      if (entitlement === undefined) {
        refuse(res, 403, 'not_entitled');
        return;
      }
      step = 'sign';
      attestation = await sign({
        iss: attestationIssuer(issuer),
        sub,
        aud: asked.world,
        nonce: asked.nonce,
        mr_ent: entitlement,
        iat,
        exp: iat + ATTESTATION_TTL_SECONDS,
        jti: randomUUID(),
      });
      // Logged before it is sent: an attestation that cannot be logged is not issued.
      step = 'log';
      log(`account-service: attest sub=${sub} at=${at}`);
    } catch (error) {
      // The service failed, not the caller: this request does not count against the account. It
      // removes the account's newest hit, which is this one unless another request took one since.
      limiter.giveBack(sub);
      try {
        log(
          `account-service: attest failed sub=${sub} at=${at} step=${step} error=${errorClass(error)}`,
        );
      } catch {
        // a log that cannot be written changes nothing about the answer
      }
      refuse(res, 500, 'server_error');
      return;
    }
    json(res, 200, { attestation });
  };

  return (req, res) => {
    if (req.url !== ATTEST_PATH || req.headers.host?.toLowerCase() !== host) return false;
    answer(req, res).catch(() => {
      // Nothing above is expected to reach here; the request gets no answer and the rest go on.
      res.destroy();
    });
    return true;
  };
}

/** The world and nonce a body asks for, or undefined when it is not exactly those two. */
function parseRequest(
  body: string,
): { readonly world: string; readonly nonce: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).sort().join() !== 'nonce,world') return undefined;
  const { world, nonce } = value as { readonly world: unknown; readonly nonce: unknown };
  // A world's name and a nonce are opaque here: visible ASCII and bounded, so the attestation is
  // too.
  if (!isVisibleAscii(world, MAX_WORLD_LENGTH) || !isVisibleAscii(nonce, MAX_NONCE_LENGTH)) {
    return undefined;
  }
  return { world, nonce };
}

function json(
  res: ServerResponse,
  status: number,
  body: object,
  headers: Readonly<Record<string, string>> = {},
): void {
  sendJson(res, status, body, { ...ANSWER_HEADERS, ...headers });
}

function refuse(
  res: ServerResponse,
  status: number,
  error: ErrorCode,
  headers: Readonly<Record<string, string>> = {},
): void {
  json(res, status, { error }, headers);
}
