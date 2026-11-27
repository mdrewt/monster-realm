import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A local fake of Steam's Web API: one HTTP listener on `127.0.0.1`, port 0, answering the two
 * methods the account service calls with the shapes a live run against Steam recorded. No test
 * reaches Steam.
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
 * Fault knobs, all through `respondNext(method, answer)`: the answer is queued for that method and
 * used, once, by the next request to that method's path, whatever its parameters, key or HTTP
 * method; several queued answers are used in order. The request is recorded either way. The kinds:
 *
 * - `status`: that status with `body` (default an HTML page), `statusText` and `headers`
 *   (`content-type` defaults to `text/html`).
 * - `body`: `200` (or `status`) with exactly these body bytes, `statusText` and `headers`
 *   (`content-type` defaults to `application/json; charset=UTF-8`; `content-length` is the
 *   body's length).
 * - `redirect`: `status` (default `302`) with `location`, `statusText`, `headers` and `body`.
 * - `no-answer`: nothing at all is sent; the connection stays open until the client gives up or
 *   `close()` ends it.
 * - `endless-body`: `200` headers (chunked, no length) and `body`, then nothing more, ever.
 * - `closed-mid-body`: `200` headers with a `content-length` longer than `body`, then `body`, then
 *   the connection is destroyed.
 * - `closed`: the connection is destroyed with no answer.
 *
 * `requests` records every request received, in order, before anything is answered: the method,
 * the raw path, the raw request target, the parsed query and the headers as received.
 * `close()` ends every open connection, hanging ones included.
 */

export type SteamStubMethod = 'AuthenticateUserTicket' | 'CheckAppOwnership';

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
  close(): Promise<void>;
}

const AUTHENTICATE_PATH = '/ISteamUserAuth/AuthenticateUserTicket/v1/';
const OWNERSHIP_PATH = '/ISteamUser/CheckAppOwnership/v4/';
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
  };
  const sockets = new Set<Socket>();

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const target = req.url ?? '';
    const mark = target.indexOf('?');
    const path = mark === -1 ? target : target.slice(0, mark);
    const query = new URLSearchParams(mark === -1 ? '' : target.slice(mark + 1));
    const request: SteamStubRequest = {
      method: req.method ?? '',
      path,
      target,
      query,
      headers: req.headers,
    };
    requests.push(request);

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

  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
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
