import { createPrivateKey, type KeyObject, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLocalJWKSet, jwtVerify, SignJWT } from 'jose';
import { accountClaims, BASE_GAME_ENTITLEMENT, ENTITLEMENT_CLAIM } from './claims.ts';
import type { Account } from './interactions/router.ts';
import type { AttestationKeys, SigningKeys } from './keys.ts';
import { createRateLimiter } from './rateLimit.ts';

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

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
const JSON_TYPE = 'application/json';
// A world's name and a nonce are opaque here: visible ASCII, bounded, so the attestation is too.
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

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
  const loginKeys = createLocalJWKSet({
    keys: options.loginKeys.keys.map(({ kty, crv, alg, use, kid, x, y }) => ({
      kty,
      crv,
      alg,
      use,
      kid,
      x,
      y,
    })),
  });
  const limiter = createRateLimiter({
    limit: ATTESTATION_LIMIT,
    windowSeconds: ATTESTATION_WINDOW_SECONDS,
    now,
  });

  /** The subject of a valid bearer token and whether it carries the entitlement, or undefined. */
  const bearer = async (
    authorization: string | undefined,
  ): Promise<{ readonly sub: string; readonly entitled: boolean } | undefined> => {
    const token = BEARER.exec(authorization ?? '')?.[1];
    if (token === undefined) return undefined;
    try {
      const { payload } = await jwtVerify(token, loginKeys, {
        issuer,
        algorithms: ['ES256'],
        requiredClaims: ['exp'],
        currentDate: new Date(now() * 1000),
        clockTolerance: 0,
      });
      const { sub, aud } = payload;
      if (typeof sub !== 'string' || sub === '' || typeof aud !== 'string') return undefined;
      const entitlement = payload[ENTITLEMENT_CLAIM];
      return {
        sub,
        entitled: Array.isArray(entitlement) && entitlement.includes(BASE_GAME_ENTITLEMENT),
      };
    } catch {
      return undefined;
    }
  };

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
    if (!caller.entitled) {
      refuse(res, 403, 'not_entitled', UNREAD);
      return;
    }
    if (mediaType(req) !== JSON_TYPE) {
      refuse(res, 415, 'invalid_request', UNREAD);
      return;
    }
    const body = await readBody(req);
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
      log(`account-service: attest sub=${sub} at=${at}`);
    } catch (error) {
      // The service failed, not the caller: this request does not count against the account. It
      // removes the account's newest hit, which is this one unless another request took one since.
      limiter.giveBack(sub);
      try {
        log(
          `account-service: attest failed sub=${sub} at=${at} step=${step} error=${className(error)}`,
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

function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * The request body as text; `'too-large'` when it is, or says it is, over the cap; `'gone'` when
 * its sender went away before the end.
 */
function readBody(req: IncomingMessage): Promise<string | 'too-large' | 'gone'> {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_ATTEST_BODY_BYTES) {
      resolve('too-large');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_ATTEST_BODY_BYTES) {
        // The rest is discarded as it arrives, so the refusal still reaches the sender.
        req.off('data', onData);
        req.resume();
        resolve('too-large');
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.once('error', () => {
      resolve('gone');
    });
    req.once('close', () => {
      resolve('gone');
    });
  });
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
  if (!isBounded(world, MAX_WORLD_LENGTH) || !isBounded(nonce, MAX_NONCE_LENGTH)) return undefined;
  return { world, nonce };
}

function isBounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && VISIBLE_ASCII.test(value);
}

/** An error's class name when it is one, and nothing else of it: a message may quote a request. */
function className(error: unknown): string {
  return error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : 'unknown';
}

function json(
  res: ServerResponse,
  status: number,
  body: object,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...ANSWER_HEADERS,
    ...headers,
  });
  res.end(text);
}

function refuse(
  res: ServerResponse,
  status: number,
  error: ErrorCode,
  headers: Readonly<Record<string, string>> = {},
): void {
  json(res, status, { error }, headers);
}
