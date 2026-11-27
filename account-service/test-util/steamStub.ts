import { createHmac, randomBytes, randomInt } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A local fake of Steam's Web API and of Steam's OpenID endpoint: one HTTP listener on
 * `127.0.0.1`, port 0, answering the two Web API methods and the one OpenID request the account
 * service makes, with the shapes a live run against Steam recorded. No test reaches Steam.
 *
 * What it serves, and how strictly (it is never more lenient than Steam where that would let a
 * broken client pass):
 *
 * - Only the exact request paths `/ISteamUserAuth/AuthenticateUserTicket/v1/` and
 *   `/ISteamUser/CheckAppOwnership/v4/` (trailing slash included, compared as the raw path the
 *   client sent, so no dot segment or doubled slash is normalised away). Anything else is `404`.
 *   A method other than `GET` on either path is `405`.
 * - A parameter given twice (any parameter, `key` included) is `400`.
 * - The key is taken from the `x-webapi-key` header, else from the `key` parameter, as Steam takes
 *   both. None (or empty): `400 text/html`. Another key: `403 text/html`. Both carry an HTML body.
 * - `AuthenticateUserTicket`: `ticket` or `appid` missing is `400`. A ticket this stub issued
 *   (matched as hex, so either letter case is the same ticket) with `appid` written exactly as the
 *   stub's app id and the identity it is issued for: `200` with the `params` success body. No
 *   `identity` parameter at all: the same success, as Steam does. Another identity: errorcode 105.
 *   Another `appid`: errorcode 102. Any other ticket (not issued, not hex, odd length): errorcode 3.
 *   A ticket authenticates any number of times.
 * - `CheckAppOwnership`: `steamid` missing or not 17 digits, or `appid` missing, is `400`.
 *   Otherwise `200` with an `appownership` object. A player never given to `setOwnership`, or an
 *   `appid` not written exactly as the stub's, answers "does not own it": `ownsapp` false,
 *   `permanent` false, `ownersteamid` `"0"`, `sitelicense` false.
 *
 * The OpenID part, at `openIdEndpoint` (`<url>/openid/login`):
 *
 * - `openIdReply(loginUrl, steamId, change?)` plays Steam's side of a browser sign-in. It takes a
 *   checkid_setup address of this stub (exactly the six parameters' values the account service
 *   sends, each once; `openid.realm` a bare origin and `openid.return_to` a URL of that origin;
 *   anything else throws) and gives the address Steam sends the browser to: the request's
 *   return_to with a positive assertion appended (`&` when return_to has a query, `?` when not).
 *   The assertion's `claimed_id` and `identity` are both
 *   `https://steamcommunity.com/openid/id/<steamId>`, that literal host whatever address this stub
 *   listens on; `op_endpoint` is `openIdEndpoint`; `response_nonce` is the clock's time
 *   (`new Date()`, so a faked clock moves it) as `YYYY-MM-DDTHH:MM:SSZ` followed by random base64
 *   characters; `signed` is Steam's own list,
 *   `signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle`; `sig` is the
 *   base64 of an HMAC-SHA1, under a key made per stub, over `name:value\n` for each name `signed`
 *   lists, in order. `change` replaces or adds fields, named without `openid.`, before the
 *   signature is made (`sig` alone cannot be changed), so a changed reply is still one this stub
 *   vouches for.
 * - `POST /openid/login` is `check_authentication` (any other method: `405`). The body is read as
 *   `application/x-www-form-urlencoded` and recorded. A body whose `openid.mode` is not
 *   `check_authentication`: `400`. Otherwise `200`, `text/plain;charset=utf-8`, body exactly
 *   `ns:http://specs.openid.net/auth/2.0\nis_valid:true\n` or the same with `is_valid:false`.
 *   `true` exactly when no parameter name appears twice in the body, and `openid.sig` is the
 *   signature this stub computes over the fields the posted `openid.signed` lists, with the posted
 *   values; and, under `refuseReplayedAssertions(true)`, that signature has not been answered
 *   `true` before.
 *
 * Fault knobs, all through `respondNext(method, answer)`: the answer is queued for that method and
 * used, once, by the next request to that method's path, whatever its parameters, key, body or
 * HTTP method; several queued answers are used in order. The request is recorded either way. The
 * method `CheckAuthentication` is the OpenID path. The kinds:
 *
 * - `status`: that status with `body` (default an HTML page), `statusText` and `headers`
 *   (`content-type` defaults to `text/html`).
 * - `body`: `200` (or `status`) with exactly these body bytes, `statusText` and `headers`
 *   (`content-type` defaults to `application/json; charset=UTF-8`, for `CheckAuthentication`
 *   too, so an OpenID body names its own; `content-length` is the body's length).
 * - `redirect`: `status` (default `302`) with `location`, `statusText`, `headers` and `body`.
 * - `no-answer`: nothing at all is sent; the connection stays open until the client gives up or
 *   `close()` ends it.
 * - `endless-body`: `200` headers (chunked, no length) and `body`, then nothing more, ever.
 * - `closed-mid-body`: `200` headers with a `content-length` longer than `body`, then `body`, then
 *   the connection is destroyed.
 * - `closed`: the connection is destroyed with no answer.
 *
 * `requests` records every request received, in order, before anything is answered: the method,
 * the raw path, the raw request target, the parsed query, the headers as received and the body as
 * text (read whole on the OpenID path, empty on every other).
 * `close()` ends every open connection, hanging ones included.
 */

export type SteamStubMethod =
  | 'AuthenticateUserTicket'
  | 'CheckAppOwnership'
  | 'CheckAuthentication';

type Headers = Readonly<Record<string, string>>;

export type SteamStubAnswer =
  | {
      readonly kind: 'status';
      readonly status: number;
      readonly statusText?: string;
      readonly headers?: Headers;
      readonly body?: string;
    }
  | {
      readonly kind: 'body';
      readonly body: string | Uint8Array;
      readonly status?: number;
      readonly statusText?: string;
      readonly headers?: Headers;
    }
  | {
      readonly kind: 'redirect';
      readonly location: string;
      readonly status?: number;
      readonly statusText?: string;
      readonly headers?: Headers;
      readonly body?: string;
    }
  | { readonly kind: 'no-answer' }
  | {
      readonly kind: 'endless-body';
      readonly body: string;
      readonly statusText?: string;
      readonly headers?: Headers;
    }
  | {
      readonly kind: 'closed-mid-body';
      readonly body: string;
      readonly statusText?: string;
      readonly headers?: Headers;
    }
  | { readonly kind: 'closed' };

export interface SteamStubRequest {
  readonly method: string;
  /** The path as the client sent it, before any `?`. */
  readonly path: string;
  /** The raw request target, path and query. */
  readonly target: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  /** The request body as text; empty for a request with none. */
  readonly body: string;
}

export interface SteamStubOwnership {
  readonly ownsapp: boolean;
  readonly permanent: boolean;
  readonly sitelicense: boolean;
  readonly ownersteamid: string;
}

export interface SteamStub {
  /** `http://127.0.0.1:<port>`, the fake of both API hosts. */
  readonly url: string;
  /** The one key it accepts; generated per stub. */
  readonly key: string;
  /** The app id it answers for; default 480. */
  readonly appId: number;
  /** Every request received, in order. */
  readonly requests: readonly SteamStubRequest[];
  /** A hex ticket that authenticates as `steamId` when checked with this `identity` and the stub's app id. */
  issueTicket(steamId: string, identity: string): string;
  /** What CheckAppOwnership answers for a player and the stub's app. A player never set does not own it. */
  setOwnership(steamId: string, ownership: SteamStubOwnership): void;
  /** Queues `answer` for the next request to `method`'s path (see the file's comment). */
  respondNext(method: SteamStubMethod, answer: SteamStubAnswer): void;
  /** `<url>/openid/login`: the fake of Steam's OpenID endpoint. */
  readonly openIdEndpoint: string;
  /**
   * The address Steam sends the browser to once `steamId` signed in for `loginUrl`, a
   * checkid_setup address of this stub: the request's return_to with a positive assertion
   * appended (`&` when return_to has a query, `?` when not), signed by this stub. `change`
   * replaces assertion fields, named without `openid.`, before signing, so a changed reply is
   * still one this stub answers `is_valid:true` for; the browser is still sent to the request's
   * own return_to. Throws for a `loginUrl` Steam would not accept.
   */
  openIdReply(loginUrl: string, steamId: string, change?: Readonly<Record<string, string>>): string;
  /** With `true`, an assertion is valid at its first check only, as at Steam. Default: at every check. */
  refuseReplayedAssertions(on: boolean): void;
  close(): Promise<void>;
}

const AUTHENTICATE_PATH = '/ISteamUserAuth/AuthenticateUserTicket/v1/';
const OWNERSHIP_PATH = '/ISteamUser/CheckAppOwnership/v4/';
const OPENID_PATH = '/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID_PREFIX = 'https://steamcommunity.com/openid/id/';
// Steam's own list: it names `signed` itself, and neither `ns` nor `mode`.
const STEAM_SIGNED = 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle';
const OPENID_TYPE = 'text/plain;charset=utf-8';
const LOGIN_PARAMETERS = [
  'openid.ns',
  'openid.mode',
  'openid.return_to',
  'openid.realm',
  'openid.identity',
  'openid.claimed_id',
] as const;
const JSON_TYPE = 'application/json; charset=UTF-8';
const HTML_TYPE = 'text/html; charset=UTF-8';
// A live ticket from GetAuthTicketForWebApi is 468 hex characters.
const TICKET_BYTES = 234;
const STEAM_ID = /^\d{17}$/;
const HEX_PAIRS = /^(?:[0-9a-fA-F]{2})+$/;
const OWNED_TIMESTAMP = '2026-11-26T00:00:00Z';
const NEVER = '1970-01-01T00:00:00Z';

export async function startSteamStub(options?: { readonly appId?: number }): Promise<SteamStub> {
  const appId = options?.appId ?? 480;
  const key = `INTERNAL_SECRET_steam_stub_${randomBytes(16).toString('hex')}`;
  const requests: SteamStubRequest[] = [];
  const tickets = new Map<string, { readonly steamId: string; readonly identity: string }>();
  const ownerships = new Map<string, SteamStubOwnership>();
  const queued: Record<SteamStubMethod, SteamStubAnswer[]> = {
    AuthenticateUserTicket: [],
    CheckAppOwnership: [],
    CheckAuthentication: [],
  };
  const sockets = new Set<Socket>();
  const openIdKey = randomBytes(32);
  // Every signature this stub has answered `is_valid:true` for.
  const vouched = new Set<string>();
  let refuseReplays = false;
  let openIdEndpoint = '';

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const target = req.url ?? '';
    const mark = target.indexOf('?');
    const path = mark === -1 ? target : target.slice(0, mark);
    const query = new URLSearchParams(mark === -1 ? '' : target.slice(mark + 1));
    const record = (body: string): SteamStubRequest => {
      const request: SteamStubRequest = {
        method: req.method ?? '',
        path,
        target,
        query,
        headers: req.headers,
        body,
      };
      requests.push(request);
      return request;
    };

    if (path === OPENID_PATH) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.once('end', () => {
        checkAuthentication(req, res, record(Buffer.concat(chunks).toString('utf8')));
      });
      return;
    }
    const request = record('');

    const method: SteamStubMethod | undefined =
      path === AUTHENTICATE_PATH
        ? 'AuthenticateUserTicket'
        : path === OWNERSHIP_PATH
          ? 'CheckAppOwnership'
          : undefined;
    if (method === undefined) {
      html(res, 404, 'Not Found');
      return;
    }
    const answer = queued[method].shift();
    if (answer !== undefined) {
      play(req, res, answer);
      return;
    }
    if (request.method !== 'GET') {
      html(res, 405, 'Method Not Allowed');
      return;
    }
    const names = [...query.keys()];
    if (new Set(names).size !== names.length) {
      html(res, 400, 'Bad Request');
      return;
    }
    const header = req.headers['x-webapi-key'];
    const given = typeof header === 'string' && header !== '' ? header : query.get('key');
    if (given === null || given === '') {
      html(res, 400, 'Bad Request');
      return;
    }
    if (given !== key) {
      html(res, 403, 'Forbidden');
      return;
    }
    if (method === 'AuthenticateUserTicket') authenticate(res, query);
    else ownership(res, query);
  }

  function checkAuthentication(
    req: IncomingMessage,
    res: ServerResponse,
    request: SteamStubRequest,
  ): void {
    const answer = queued.CheckAuthentication.shift();
    if (answer !== undefined) {
      play(req, res, answer);
      return;
    }
    if (request.method !== 'POST') {
      html(res, 405, 'Method Not Allowed');
      return;
    }
    const posted = new URLSearchParams(request.body);
    if (posted.get('openid.mode') !== 'check_authentication') {
      html(res, 400, 'Bad Request');
      return;
    }
    const valid = vouches(posted);
    send(
      res,
      200,
      undefined,
      { 'content-type': OPENID_TYPE },
      `ns:${OPENID_NS}\nis_valid:${valid ? 'true' : 'false'}\n`,
    );
  }

  /** Whether this stub answers `is_valid:true` for a posted check_authentication body. */
  function vouches(posted: URLSearchParams): boolean {
    const names = [...posted.keys()];
    if (new Set(names).size !== names.length) return false;
    const sig = posted.get('openid.sig');
    const signed = posted.get('openid.signed');
    if (sig === null || signed === null) return false;
    const listed = signed.split(',');
    if (listed.some((name) => posted.get(`openid.${name}`) === null)) return false;
    if (signature(signed, (name) => posted.get(`openid.${name}`) ?? '') !== sig) return false;
    if (refuseReplays && vouched.has(sig)) return false;
    vouched.add(sig);
    return true;
  }

  /** The base64 HMAC-SHA1 over `name:value\n` for each name of the comma list `signed`, in order. */
  function signature(signed: string, value: (name: string) => string): string {
    const text = signed
      .split(',')
      .map((name) => `${name}:${value(name)}\n`)
      .join('');
    return createHmac('sha1', openIdKey).update(text, 'utf8').digest('base64');
  }

  function openIdReply(
    loginUrl: string,
    steamId: string,
    change: Readonly<Record<string, string>> = {},
  ): string {
    const refuse = (why: string): never => {
      throw new Error(`the stub's Steam would not accept this login address: ${why}`);
    };
    const prefix = `${openIdEndpoint}?`;
    if (typeof loginUrl !== 'string' || !loginUrl.startsWith(prefix) || loginUrl.includes('#')) {
      refuse(`it is not ${prefix}<parameters>`);
    }
    const params = new URLSearchParams(loginUrl.slice(prefix.length));
    for (const name of LOGIN_PARAMETERS) {
      if (params.getAll(name).length !== 1) refuse(`${name} is not given exactly once`);
    }
    const fixed: ReadonlyArray<readonly [string, string]> = [
      ['openid.ns', OPENID_NS],
      ['openid.mode', 'checkid_setup'],
      ['openid.identity', IDENTIFIER_SELECT],
      ['openid.claimed_id', IDENTIFIER_SELECT],
    ];
    for (const [name, value] of fixed) {
      if (params.get(name) !== value) refuse(`${name} is not ${value}`);
    }
    const realm = params.get('openid.realm') ?? '';
    const returnTo = params.get('openid.return_to') ?? '';
    if (!URL.canParse(realm) || new URL(realm).origin !== realm) {
      refuse('openid.realm is not a bare origin');
    }
    if (!URL.canParse(returnTo) || new URL(returnTo).origin !== realm) {
      refuse('openid.return_to is not a URL of the realm');
    }
    if (Object.hasOwn(change, 'sig')) {
      throw new TypeError('openIdReply signs the reply itself: change cannot name sig');
    }

    const claimedId = `${CLAIMED_ID_PREFIX}${steamId}`;
    const fields = new Map<string, string>([
      ['ns', OPENID_NS],
      ['mode', 'id_res'],
      ['op_endpoint', openIdEndpoint],
      ['claimed_id', claimedId],
      ['identity', claimedId],
      ['return_to', returnTo],
      [
        'response_nonce',
        `${new Date().toISOString().slice(0, 19)}Z${randomBytes(9).toString('base64')}`,
      ],
      ['assoc_handle', String(randomInt(1_000_000_000, 2 ** 47))],
      ['signed', STEAM_SIGNED],
    ]);
    for (const [name, value] of Object.entries(change)) fields.set(name, value);
    fields.set(
      'sig',
      signature(fields.get('signed') ?? '', (name) => fields.get(name) ?? ''),
    );
    const assertion = new URLSearchParams(
      [...fields].map(([name, value]): [string, string] => [`openid.${name}`, value]),
    );
    return `${returnTo}${returnTo.includes('?') ? '&' : '?'}${assertion}`;
  }

  function authenticate(res: ServerResponse, query: URLSearchParams): void {
    const ticket = query.get('ticket');
    const appid = query.get('appid');
    if (ticket === null || appid === null) {
      html(res, 400, 'Bad Request');
      return;
    }
    const issued = HEX_PAIRS.test(ticket) ? tickets.get(ticket.toLowerCase()) : undefined;
    if (issued === undefined) {
      json(res, { response: { error: { errorcode: 3, errordesc: 'Invalid parameter' } } });
      return;
    }
    if (appid !== String(appId)) {
      json(res, { response: { error: { errorcode: 102, errordesc: 'Ticket for other app' } } });
      return;
    }
    const identity = query.get('identity');
    if (identity !== null && identity !== issued.identity) {
      json(res, {
        response: { error: { errorcode: 105, errordesc: 'Identity parameter did not match' } },
      });
      return;
    }
    json(res, {
      response: {
        params: {
          result: 'OK',
          steamid: issued.steamId,
          ownersteamid: issued.steamId,
          vacbanned: false,
          publisherbanned: false,
        },
      },
    });
  }

  function ownership(res: ServerResponse, query: URLSearchParams): void {
    const steamid = query.get('steamid');
    const appid = query.get('appid');
    if (steamid === null || !STEAM_ID.test(steamid) || appid === null) {
      html(res, 400, 'Bad Request');
      return;
    }
    const set = appid === String(appId) ? ownerships.get(steamid) : undefined;
    json(res, {
      appownership:
        set === undefined
          ? {
              ownsapp: false,
              permanent: false,
              timestamp: NEVER,
              timeexpires: NEVER,
              ownersteamid: '0',
              sitelicense: false,
              usercanceled: false,
              result: 'OK',
            }
          : {
              ownsapp: set.ownsapp,
              permanent: set.permanent,
              timestamp: OWNED_TIMESTAMP,
              timeexpires: NEVER,
              ownersteamid: set.ownersteamid,
              sitelicense: set.sitelicense,
              usercanceled: false,
              result: 'OK',
            },
    });
  }

  const server = createServer(handle);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  openIdEndpoint = `${url}${OPENID_PATH}`;

  let closed: Promise<void> | undefined;
  return {
    url,
    openIdEndpoint,
    key,
    appId,
    requests,
    issueTicket(steamId, identity) {
      const ticket = randomBytes(TICKET_BYTES).toString('hex');
      tickets.set(ticket, { steamId, identity });
      return ticket;
    },
    setOwnership(steamId, owned) {
      ownerships.set(steamId, { ...owned });
    },
    respondNext(method, answer) {
      queued[method].push(answer);
    },
    openIdReply,
    refuseReplayedAssertions(on) {
      refuseReplays = on;
    },
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
      return closed;
    },
  };
}

function head(
  res: ServerResponse,
  status: number,
  statusText: string | undefined,
  headers: OutgoingHttpHeaders,
): void {
  if (statusText === undefined) res.writeHead(status, headers);
  else res.writeHead(status, statusText, headers);
}

function send(
  res: ServerResponse,
  status: number,
  statusText: string | undefined,
  headers: OutgoingHttpHeaders,
  body: string | Uint8Array,
): void {
  head(res, status, statusText, { ...headers, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function html(res: ServerResponse, status: number, title: string): void {
  send(
    res,
    status,
    undefined,
    { 'content-type': HTML_TYPE },
    `<html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
  );
}

function json(res: ServerResponse, value: unknown): void {
  send(res, 200, undefined, { 'content-type': JSON_TYPE }, JSON.stringify(value));
}

function play(req: IncomingMessage, res: ServerResponse, answer: SteamStubAnswer): void {
  switch (answer.kind) {
    case 'status':
      send(
        res,
        answer.status,
        answer.statusText,
        { 'content-type': HTML_TYPE, ...answer.headers },
        answer.body ?? `<html><body><h1>${answer.status}</h1></body></html>`,
      );
      return;
    case 'body':
      send(
        res,
        answer.status ?? 200,
        answer.statusText,
        { 'content-type': JSON_TYPE, ...answer.headers },
        answer.body,
      );
      return;
    case 'redirect':
      send(
        res,
        answer.status ?? 302,
        answer.statusText,
        { 'content-type': HTML_TYPE, ...answer.headers, location: answer.location },
        answer.body ?? '',
      );
      return;
    case 'no-answer':
      return;
    case 'endless-body':
      head(res, 200, answer.statusText, { 'content-type': JSON_TYPE, ...answer.headers });
      res.write(answer.body);
      return;
    case 'closed-mid-body': {
      const bytes = Buffer.from(answer.body, 'utf8');
      head(res, 200, answer.statusText, {
        'content-type': JSON_TYPE,
        ...answer.headers,
        'content-length': bytes.length + 1024,
      });
      res.write(bytes, () => {
        res.destroy();
      });
      return;
    }
    case 'closed':
      req.socket.destroy();
      return;
  }
}
