import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLocalJWKSet, type JWTPayload, jwtVerify } from 'jose';
import type { Account } from './interactions/router.ts';
import type { SigningKeys } from './keys.ts';
import { addressLimitKey, createRateLimiter, type RateLimiter } from './rateLimit.ts';
import type { AccountStore } from './store/sqliteAdapter.ts';
import { type HandleCodec, WORLD_IDENTITY } from './worldHandle.ts';

export const TICKET_PATH = '/ticket';
export const WORLD_CHECK_PATH = '/world/check';
export const TICKET_TTL_SECONDS = 60;
/** An account gets at most this many tickets within any `TICKET_WINDOW_SECONDS`. */
export const TICKET_LIMIT = 10;
export const TICKET_WINDOW_SECONDS = 60;
/** A source address is answered at most this often within any `WORLD_CHECK_ADDRESS_WINDOW_SECONDS`. */
export const WORLD_CHECK_ADDRESS_LIMIT = 120;
export const WORLD_CHECK_ADDRESS_WINDOW_SECONDS = 60;
/**
 * One account in one world is checked by handle from one source address at most this often
 * within any `WORLD_CHECK_HANDLE_WINDOW_SECONDS`.
 */
export const WORLD_CHECK_HANDLE_LIMIT = 12;
export const WORLD_CHECK_HANDLE_WINDOW_SECONDS = 3600;
export const MAX_WORLD_NAME_LENGTH = 512;
export const MAX_WORLD_NAMES = 16;
export const MAX_TICKET_BODY_BYTES = 1024;
export const MAX_WORLD_CHECK_BODY_BYTES = 16_384;

/** An account's subject is what a log line names: bounded, with no space or line break. */
const MAX_SUBJECT_LENGTH = 255;
const MAX_TICKET_LENGTH = 128;
const MAX_HANDLE_LENGTH = 1024;
const TICKET_BYTES = 32;
const TICKET_MODEL = 'WorldTicket';
/**
 * How many keys each limit of the world check holds at once. Whoever calls that route chooses its
 * keys, so memory needs a bound; past it a new key is refused until an old one's hits die, which
 * refuses every caller the limit has not seen. Each bound is therefore far above what honest
 * worlds reach: a source address's hits live a minute, so the first fills only under about
 * 17,000 new addresses a second; a pair's hits live an hour, and each needs a handle that opens.
 */
const MAX_ADDRESS_LIMIT_KEYS = 1_000_000;
const MAX_HANDLE_LIMIT_KEYS = 250_000;

/** A ticket's holder: the account it was issued to and the world's name it was issued for. */
export interface TicketRecord {
  readonly account: string;
  readonly world: string;
}

export interface WorldTickets {
  /**
   * Makes a ticket for `account` to join the world named `world`: 32 random bytes as unpadded
   * base64url, kept for `TICKET_TTL_SECONDS` under its SHA-256. This is the one place a ticket
   * is made.
   */
  issue(account: string, world: string): Promise<string>;
  /** Spends a ticket: what it was issued for when it was live, undefined otherwise. Either way it is gone. */
  spend(ticket: string): TicketRecord | undefined;
}

/**
 * The tickets of a store. A ticket's record is kept under the SHA-256 of its text (256 random
 * bits; a digest needs no salt), so the store holds nothing that can be presented.
 */
export function createWorldTickets(store: Pick<AccountStore, 'adapter' | 'take'>): WorldTickets {
  const records = store.adapter(TICKET_MODEL);
  return {
    async issue(account, world) {
      const ticket = randomBytes(TICKET_BYTES).toString('base64url');
      await records.upsert(digest(ticket), { account, world }, TICKET_TTL_SECONDS);
      return ticket;
    },
    spend(ticket) {
      const record = store.take(TICKET_MODEL, digest(ticket));
      if (typeof record?.account !== 'string' || typeof record.world !== 'string') return undefined;
      return { account: record.account, world: record.world };
    },
  };
}

function digest(ticket: string): string {
  return createHash('sha256').update(ticket).digest('base64url');
}

/**
 * The hosts `POST /world/check` is answered under: the issuer's, and `ipv4.` and `ipv6.` in front
 * of it, the names a deployment gives an `A` record alone and an `AAAA` record alone, so a world
 * can ask over the address family it wants its own address reported in.
 */
export function worldCheckHosts(issuer: string): readonly string[] {
  const { host } = new URL(issuer);
  return [host, `ipv4.${host}`, `ipv6.${host}`];
}

/** Who a valid bearer ID token names, and the claims it carries. */
export interface IdTokenHolder {
  readonly sub: string;
  readonly claims: JWTPayload;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/**
 * Builds the check of an `Authorization` header: the holder of a bearer ID token that a login key
 * signed with ES256, from this issuer, unexpired at `now`, with a bounded visible-ASCII `sub` and
 * an `aud`; undefined for anything else.
 */
export function createIdTokenCheck(options: {
  readonly issuer: string;
  readonly loginKeys: SigningKeys;
  readonly now: () => number;
}): (authorization: string | undefined) => Promise<IdTokenHolder | undefined> {
  const { issuer, now } = options;
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
  return async (authorization) => {
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
      if (!isVisibleAscii(sub, MAX_SUBJECT_LENGTH) || typeof aud !== 'string') return undefined;
      return { sub, claims: payload };
    } catch {
      return undefined;
    }
  };
}

export interface WorldRoutesOptions {
  /** The login issuer, as its tokens carry it. */
  readonly issuer: string;
  /** The login keys: a bearer token must verify under the public half of one of them. */
  readonly loginKeys: SigningKeys;
  readonly tickets: WorldTickets;
  readonly handles: HandleCodec;
  /** The account behind a subject, read for every check; undefined when there is none. */
  readonly account: (sub: string) => Promise<Account | undefined>;
  /** A request's source address, or undefined when it cannot be known. */
  readonly sourceAddress: (req: IncomingMessage) => string | undefined;
  /** Receives every line the routes log. */
  readonly log: (line: string) => void;
  /** Whole epoch seconds; default the system clock. The only clock the routes read. */
  readonly now?: () => number;
}

type ErrorCode =
  | 'method_not_allowed'
  | 'invalid_token'
  | 'invalid_request'
  | 'ticket_refused'
  | 'rate_limited'
  | 'server_error';

type Headers = Readonly<Record<string, string>>;

const ANSWER_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

/**
 * On every answer of the ticket route. It reads no cookie, so the bearer token is the only way in
 * and a page that holds one could send it from anywhere: an answer is readable from any origin.
 * The world check carries none of these: a world's server calls it, never a page.
 */
const TICKET_HEADERS = {
  ...ANSWER_HEADERS,
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'retry-after, www-authenticate',
} as const;

/** On an answer sent while the request's body is unread: the connection is not reused. */
const UNREAD = { connection: 'close' } as const;

const JSON_TYPE = 'application/json';
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

type CheckRequest =
  | {
      readonly kind: 'ticket';
      readonly ticket: string;
      readonly names: readonly string[];
      readonly world: string;
    }
  | { readonly kind: 'handle'; readonly handle: string; readonly world: string };

/**
 * The handler of the two routes a world's account check runs on. It returns true when the request
 * is for one of them (it will be answered), and false, having touched nothing, when it is not.
 * It never throws, and nothing it starts rejects.
 *
 * `POST /ticket`, exactly that target under the issuer's `Host`: a bearer ID token of this issuer
 * and `{ world }`, the name of the world its holder is joining, in; `{ ticket }` out. The token
 * is checked before any of the body is read, and the account is not read: a ticket says only who
 * asked and for which world, and the check that redeems it answers for the account. An account's
 * limit counts requests that reached it with a valid token and body; one the service failed is
 * given back.
 *
 * `POST /world/check`, exactly that target under one of `worldCheckHosts`: no token, since its
 * caller is a world's server, which nothing identifies. A request is checked in this order, and
 * the first failure answers: the source address is known; its limit, counted for every `POST`
 * before any of the body is read; the body, exactly one of two forms.
 * - `{ ticket, names, world }` spends the ticket. One that is unknown, spent or expired, or was
 *   issued for a name that is not among `names`, gets one fixed `403`. Otherwise the account is
 *   read and the answer is `{ handle, entitled, address, name }`: the account's handle in the
 *   world whose database identity is `world`, whether it owns the game now, the request's source
 *   address, and the name the ticket was issued for.
 * - `{ handle, world }` re-checks an account a world already knows. A handle that does not open,
 *   or is another world's, answers `{ entitled: false, address }`. Otherwise the limit of that
 *   account, world and source address applies, the account is read, and the answer is
 *   `{ handle, entitled, address }` with the handle under the current key.
 * An account that is gone answers as one that does not own the game, in both forms.
 *
 * One line is logged per ticket issued and per ticket redeemed, with the account and the time,
 * and one per failure of the service. A refusal logs nothing, and neither does an answered handle
 * check, whose caller is anonymous: no caller can write lines at will. No line holds a world, a
 * name, a handle, a ticket, an address or an error's message.
 */
export function createWorldRoutes(
  options: WorldRoutesOptions,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const { issuer, tickets, handles, log } = options;
  const host = new URL(issuer).host;
  const checkHosts: ReadonlySet<string> = new Set(worldCheckHosts(issuer));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const idToken = createIdTokenCheck({ issuer, loginKeys: options.loginKeys, now });
  const ticketLimit = createRateLimiter({
    limit: TICKET_LIMIT,
    windowSeconds: TICKET_WINDOW_SECONDS,
    now,
  });
  const addressLimit = createRateLimiter({
    limit: WORLD_CHECK_ADDRESS_LIMIT,
    windowSeconds: WORLD_CHECK_ADDRESS_WINDOW_SECONDS,
    now,
    maxKeys: MAX_ADDRESS_LIMIT_KEYS,
  });
  const handleLimit = createRateLimiter({
    limit: WORLD_CHECK_HANDLE_LIMIT,
    windowSeconds: WORLD_CHECK_HANDLE_WINDOW_SECONDS,
    now,
    maxKeys: MAX_HANDLE_LIMIT_KEYS,
  });

  const time = (): string => new Date(now() * 1000).toISOString();

  /** Logs a failure of the service; a log that cannot be written changes nothing about the answer. */
  const logFailure = (line: string): void => {
    try {
      log(line);
    } catch {
      // the answer is a 500 either way
    }
  };

  const answerTicket = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...TICKET_HEADERS,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    const refuse = (status: number, error: ErrorCode, headers: Headers = {}): void => {
      sendJson(res, status, { error }, { ...TICKET_HEADERS, ...headers });
    };
    if (req.method !== 'POST') {
      refuse(405, 'method_not_allowed', { allow: 'POST, OPTIONS', ...UNREAD });
      return;
    }
    const holder = await idToken(req.headers.authorization);
    if (holder === undefined) {
      refuse(401, 'invalid_token', { 'www-authenticate': 'Bearer', ...UNREAD });
      return;
    }
    if (mediaType(req) !== JSON_TYPE) {
      refuse(415, 'invalid_request', UNREAD);
      return;
    }
    const body = await readBody(req, MAX_TICKET_BODY_BYTES);
    if (body === 'gone') return;
    if (body === 'too-large') {
      refuse(413, 'invalid_request', UNREAD);
      return;
    }
    const world = ticketRequest(body);
    if (world === undefined) {
      refuse(400, 'invalid_request');
      return;
    }

    const { sub } = holder;
    if (!ticketLimit.take(sub)) {
      refuse(429, 'rate_limited', retryAfter(ticketLimit, sub));
      return;
    }
    const at = time();
    let step = 'store';
    let ticket: string;
    try {
      ticket = await tickets.issue(sub, world);
      // Logged before it is sent: a ticket that cannot be logged is not handed out.
      step = 'log';
      log(`account-service: ticket sub=${sub} at=${at}`);
    } catch (error) {
      // The service failed, not the caller: this request does not count against the account.
      ticketLimit.giveBack(sub);
      logFailure(
        `account-service: ticket failed sub=${sub} at=${at} step=${step} error=${errorClass(error)}`,
      );
      refuse(500, 'server_error');
      return;
    }
    sendJson(res, 200, { ticket }, TICKET_HEADERS);
  };

  const answerCheck = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const answer = (status: number, body: object, headers: Headers = {}): void => {
      sendJson(res, status, body, { ...ANSWER_HEADERS, ...headers });
    };
    const refuse = (status: number, error: ErrorCode, headers: Headers = {}): void => {
      answer(status, { error }, headers);
    };
    if (req.method !== 'POST') {
      refuse(405, 'method_not_allowed', { allow: 'POST', ...UNREAD });
      return;
    }
    const address = options.sourceAddress(req);
    if (address === undefined) {
      refuse(400, 'invalid_request', UNREAD);
      return;
    }
    const source = addressLimitKey(address);
    if (!addressLimit.take(source)) {
      refuse(429, 'rate_limited', { ...retryAfter(addressLimit, source), ...UNREAD });
      return;
    }
    if (mediaType(req) !== JSON_TYPE) {
      refuse(415, 'invalid_request', UNREAD);
      return;
    }
    const body = await readBody(req, MAX_WORLD_CHECK_BODY_BYTES);
    if (body === 'gone') return;
    if (body === 'too-large') {
      refuse(413, 'invalid_request', UNREAD);
      return;
    }
    const asked = checkRequest(body);
    if (asked === undefined) {
      refuse(400, 'invalid_request');
      return;
    }

    const at = time();
    let sub: string | undefined;
    let step = 'ticket';
    try {
      if (asked.kind === 'ticket') {
        const spent = tickets.spend(asked.ticket);
        if (spent === undefined || !asked.names.includes(spent.world)) {
          refuse(403, 'ticket_refused');
          return;
        }
        sub = spent.account;
        step = 'account';
        const entitled = (await options.account(sub))?.entitled === true;
        step = 'seal';
        const handle = handles.seal(sub, asked.world);
        step = 'log';
        log(`account-service: world-check sub=${sub} at=${at}`);
        answer(200, { handle, entitled, address, name: spent.world });
        return;
      }

      const opened = handles.open(asked.handle);
      if (opened === undefined || opened.world !== asked.world) {
        answer(200, { entitled: false, address });
        return;
      }
      sub = opened.account;
      // A subject is visible ASCII, so a line break cannot be part of one.
      const pair = `${sub}\n${asked.world}\n${source}`;
      if (!handleLimit.take(pair)) {
        refuse(429, 'rate_limited', retryAfter(handleLimit, pair));
        return;
      }
      step = 'account';
      const entitled = (await options.account(sub))?.entitled === true;
      step = 'seal';
      answer(200, { handle: handles.seal(sub, asked.world), entitled, address });
    } catch (error) {
      // A failed check keeps its place in the pair's count: while the account cannot be read, a
      // caller must not be able to ask for it without bound.
      const who = sub === undefined ? '' : ` sub=${sub}`;
      logFailure(
        `account-service: world-check failed${who} at=${at} step=${step} error=${errorClass(error)}`,
      );
      refuse(500, 'server_error');
    }
  };

  return (req, res) => {
    const requestHost = req.headers.host?.toLowerCase();
    let answer: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    if (req.url === TICKET_PATH && requestHost === host) answer = answerTicket;
    else if (
      req.url === WORLD_CHECK_PATH &&
      requestHost !== undefined &&
      checkHosts.has(requestHost)
    ) {
      answer = answerCheck;
    } else return false;
    answer(req, res).catch(() => {
      // Nothing above is expected to reach here; the request gets no answer and the rest go on.
      res.destroy();
    });
    return true;
  };
}

/** A `retry-after` of at least a second: a key refused for want of room has no hit to wait out. */
function retryAfter(limiter: RateLimiter, key: string): Headers {
  return { 'retry-after': String(Math.max(1, limiter.retryAfter(key))) };
}

/** The world a ticket is asked for, or undefined when the body is not exactly `{ world }`. */
function ticketRequest(body: string): string | undefined {
  const value = parseObject(body);
  if (value === undefined || Object.keys(value).join() !== 'world') return undefined;
  return isVisibleAscii(value.world, MAX_WORLD_NAME_LENGTH) ? value.world : undefined;
}

/** What a check asks, or undefined when the body is neither of its two forms exactly. */
function checkRequest(body: string): CheckRequest | undefined {
  const value = parseObject(body);
  if (value === undefined) return undefined;
  const { ticket, names, handle, world } = value;
  if (typeof world !== 'string' || !WORLD_IDENTITY.test(world)) return undefined;
  const members = Object.keys(value).sort().join();
  if (members === 'names,ticket,world') {
    if (
      !isVisibleAscii(ticket, MAX_TICKET_LENGTH) ||
      !Array.isArray(names) ||
      names.length < 1 ||
      names.length > MAX_WORLD_NAMES ||
      !names.every((name): name is string => isVisibleAscii(name, MAX_WORLD_NAME_LENGTH))
    ) {
      return undefined;
    }
    return { kind: 'ticket', ticket, names, world };
  }
  if (members === 'handle,world') {
    if (!isVisibleAscii(handle, MAX_HANDLE_LENGTH)) return undefined;
    return { kind: 'handle', handle, world };
  }
  return undefined;
}

function parseObject(body: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Whether `value` is a string of 1 to `max` characters of visible ASCII (`0x21` to `0x7E`). */
export function isVisibleAscii(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && VISIBLE_ASCII.test(value);
}

/** A request's media type, without its parameters, in lower case. */
export function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * The request body as text; `'too-large'` when it is, or says it is, over `maxBytes`; `'gone'`
 * when its sender went away before the end.
 */
export function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<string | 'too-large' | 'gone'> {
  return new Promise((resolve) => {
    if (Number(req.headers['content-length'] ?? 0) > maxBytes) {
      resolve('too-large');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
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

/** An error's class name when it is one, and nothing else of it: a message may quote a request. */
export function errorClass(error: unknown): string {
  return error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : 'unknown';
}

/** Sends `body` as JSON under exactly `headers` and the two that describe it. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: object,
  headers: Headers,
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}
