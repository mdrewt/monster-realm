import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { Agent, createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importJWK, type JWTPayload, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HOSTED_DEV_ISSUER } from './config.ts';
import type { Account } from './interactions/router.ts';
import {
  generateHandleKey,
  generateSigningKey,
  type HandleKeys,
  type SigningJwk,
  type SigningKeys,
} from './keys.ts';
import { type AccountStore, openAccountStore } from './store/sqliteAdapter.ts';
import { createHandleCodec, type HandleCodec } from './worldHandle.ts';
import {
  createWorldRoutes,
  createWorldTickets,
  MAX_TICKET_BODY_BYTES,
  MAX_WORLD_CHECK_BODY_BYTES,
  MAX_WORLD_NAME_LENGTH,
  MAX_WORLD_NAMES,
  TICKET_LIMIT,
  TICKET_PATH,
  TICKET_TTL_SECONDS,
  TICKET_WINDOW_SECONDS,
  WORLD_CHECK_ADDRESS_LIMIT,
  WORLD_CHECK_ADDRESS_WINDOW_SECONDS,
  WORLD_CHECK_HANDLE_LIMIT,
  WORLD_CHECK_HANDLE_WINDOW_SECONDS,
  WORLD_CHECK_PATH,
  type WorldTickets,
  worldCheckHosts,
} from './worldTicket.ts';

// The ticket and world-check routes over real HTTP, with a real store, a real handle codec and
// real login keys. The source address, the account lookup, the log and the clock are fakes this
// file controls.

const ISSUER = 'http://localhost:4455';
const HOST = 'localhost:4455';
const IPV4_HOST = 'ipv4.localhost:4455';
const IPV6_HOST = 'ipv6.localhost:4455';
const CLIENT_ID = 'monster-realm';
const SUB = 'dev:1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const SUB2 = 'dev:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const STEAM_SUB = 'steam:76561198000000001';
// Before the wall clock, so a route reading the system clock refuses a token this clock calls fresh.
const T0 = 1_600_000_000;
const NAME = 'dns:play.example.com:3000/c200a1b2c3d4e5f6';
const OTHER_NAME = 'spki:Zm9vYmFyYmF6cXV4LV9-QUJD+/=/c200a1b2c3d4e5f6';
const WORLD = hex64('the first world');
const OTHER_WORLD = hex64('the second world');
const ADDRESS = '198.51.100.7';
const OTHER_ADDRESS = '198.51.100.8';
const IPV6_ADDRESS = '2001:db8:0:1::7';
const IPV6_SAME_64 = '2001:db8:0:1:ffff:ffff:ffff:fffe';
const IPV6_OTHER_64 = '2001:db8:0:2::7';
const JSON_TYPE = 'application/json';
/** The request header this file's fake source address reads. */
const SOURCE_HEADER = 'x-test-source';
const TAB = String.fromCharCode(0x09);
const DEL = String.fromCharCode(0x7f);
const E_ACUTE = String.fromCharCode(0xe9);
const EVERY_VISIBLE_ASCII = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
  String.fromCharCode(0x21 + i),
).join('');
const TICKET_TEXT = /^[A-Za-z0-9_-]{43}$/;

let clock = T0;

function hex64(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The record id a ticket is kept under: its SHA-256 as unpadded base64url. */
function ticketId(ticket: string): string {
  return createHash('sha256').update(ticket).digest('base64url');
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

// ---- the harness ----

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Call {
  readonly method?: string;
  readonly path?: string;
  readonly host?: string;
  /** The source address the fake reports; null sends none, so the address is unknown. */
  readonly source?: string | null;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
}

interface State {
  /** When set, the account lookup rejects with this value. */
  failure: { readonly value: unknown } | undefined;
  /** When true, the ticket store's writes reject. */
  storeFails: boolean;
  /** How many ticket records reached the store. */
  upserts: number;
  fallbacks: number;
  readonly reads: string[];
}

interface Harness {
  readonly port: number;
  readonly login: SigningJwk;
  readonly handles: HandleCodec;
  readonly tickets: WorldTickets;
  readonly store: AccountStore;
  readonly accounts: Map<string, Account>;
  readonly lines: string[];
  readonly state: State;
}

interface HarnessOptions {
  readonly issuer?: string;
  readonly loginKeys?: SigningKeys;
  readonly handleKeys?: HandleKeys;
  /** A store file; an in-memory store when absent. */
  readonly storePath?: string;
}

const servers: Server[] = [];
const stores: AccountStore[] = [];
const dirs: string[] = [];

beforeEach(() => {
  clock = T0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acs14-'));
  dirs.push(dir);
  return dir;
}

/** A store on the file's fake clock: the store decides expiry by the clock the routes read. */
function openStore(path = ':memory:'): AccountStore {
  const store = openAccountStore(path, () => clock);
  stores.push(store);
  return store;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const loginKeys = options.loginKeys ?? { keys: [generateSigningKey()] };
  const handles = createHandleCodec(options.handleKeys ?? { keys: [generateHandleKey()] });
  const store = openStore(options.storePath);
  const accounts = new Map<string, Account>([
    [SUB, { sub: SUB, entitled: true }],
    [SUB2, { sub: SUB2, entitled: true }],
    [STEAM_SUB, { sub: STEAM_SUB, entitled: true }],
  ]);
  const lines: string[] = [];
  const state: State = {
    failure: undefined,
    storeFails: false,
    upserts: 0,
    fallbacks: 0,
    reads: [],
  };
  const tickets = createWorldTickets({
    adapter: (model) => {
      const inner = store.adapter(model);
      return {
        ...inner,
        upsert: (id, payload, expiresIn) => {
          if (state.storeFails) return Promise.reject(new Error('the ticket store is down'));
          state.upserts += 1;
          return inner.upsert(id, payload, expiresIn);
        },
      };
    },
    take: (model, id) => store.take(model, id),
  });
  const route = createWorldRoutes({
    issuer: options.issuer ?? ISSUER,
    loginKeys,
    tickets,
    handles,
    account: (sub) => {
      state.reads.push(sub);
      const failure = state.failure;
      if (failure !== undefined) return Promise.reject(failure.value);
      return Promise.resolve(accounts.get(sub));
    },
    sourceAddress: (req) => {
      const value = req.headers[SOURCE_HEADER];
      return typeof value === 'string' ? value : undefined;
    },
    log: (line) => {
      lines.push(line);
    },
    now: () => clock,
  });
  const server = createServer((req, res) => {
    if (route(req, res)) return;
    state.fallbacks += 1;
    res.writeHead(418, { 'content-type': 'text/plain' });
    res.end('fallback');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    login: loginKeys.keys[0]!,
    handles,
    tickets,
    store,
    accounts,
    lines,
    state,
  };
}

function send(port: number, call: Call): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: call.host ?? HOST, ...call.headers };
    const source = call.source === undefined ? ADDRESS : call.source;
    if (source !== null) headers[SOURCE_HEADER] = source;
    if (call.body !== undefined && !('content-length' in headers)) {
      headers['content-length'] = String(Buffer.byteLength(call.body));
    }
    // A keep-alive agent, so a `connection: close` on an answer is the route's and not ours.
    const agent = new Agent({ keepAlive: true });
    let answered = false;
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: call.path ?? WORLD_CHECK_PATH,
        method: call.method ?? 'POST',
        headers,
        agent,
      },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          agent.destroy();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', (error) => {
      // A server that answers before the body is sent may close while it is still being written.
      if (!answered) {
        agent.destroy();
        reject(error);
      }
    });
    if (call.body !== undefined) req.write(call.body);
    req.end();
  });
}

// ---- tokens ----

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

type Signer = (input: Buffer) => Buffer;

/** A compact JWS of any header and payload, signed by `signer` over `<header>.<payload>`. */
function forge(header: unknown, payload: unknown, signer: Signer): string {
  const input = `${segment(header)}.${segment(payload)}`;
  return `${input}.${signer(Buffer.from(input, 'ascii')).toString('base64url')}`;
}

function es(key: SigningJwk): Signer {
  const privateKey = createPrivateKey({ key: { ...key }, format: 'jwk' });
  return (input) => sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' });
}

const NO_SIGNATURE: Signer = () => Buffer.alloc(0);

/** An ID token's claims at the clock's present, changed by `extra`, less `drop`. */
function claims(extra: Record<string, unknown> = {}, ...drop: string[]): Record<string, unknown> {
  const all: Record<string, unknown> = {
    iss: ISSUER,
    sub: SUB,
    aud: CLIENT_ID,
    mr_ent: ['base-game'],
    iat: clock,
    exp: clock + 3600,
    ...extra,
  };
  return Object.fromEntries(Object.entries(all).filter(([name]) => !drop.includes(name)));
}

/** A token signed by hand with the first login key. */
function good(h: Harness, payload: Record<string, unknown> = claims()): string {
  return forge({ alg: 'ES256', kid: h.login.kid }, payload, es(h.login));
}

/** A token signed by jose with `key`. */
async function joseToken(
  key: SigningJwk,
  payload: Record<string, unknown> = claims(),
): Promise<string> {
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: 'ES256', kid: key.kid })
    .sign(await importJWK({ ...key }, 'ES256'));
}

const otherLogin = generateSigningKey();

// ---- requests ----

function worldBody(world: unknown = NAME): string {
  return JSON.stringify({ world });
}

function padded(text: string, total: number): string {
  return text + ' '.repeat(total - Buffer.byteLength(text));
}

/** `POST /ticket`; `token` undefined sends no Authorization, `contentType` null no Content-Type. */
function ticketCall(
  token: string | undefined,
  body: string | Buffer = worldBody(),
  contentType: string | null = JSON_TYPE,
): Call {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (contentType !== null) headers['content-type'] = contentType;
  return { path: TICKET_PATH, headers, body };
}

function withAuthorization(value: string): Call {
  return {
    path: TICKET_PATH,
    headers: { authorization: value, 'content-type': JSON_TYPE },
    body: worldBody(),
  };
}

/** `POST /world/check` from `source`; a string body is sent as it is, anything else as JSON. */
function checkCall(
  body: unknown,
  source: string | null = ADDRESS,
  contentType: string | null = JSON_TYPE,
): Call {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers['content-type'] = contentType;
  const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return { path: WORLD_CHECK_PATH, source, headers, body: text };
}

function redeemBody(ticket: unknown, names: unknown = [NAME], world: unknown = WORLD): object {
  return { ticket, names, world };
}

function handleBody(handle: unknown, world: unknown = WORLD): object {
  return { handle, world };
}

/** A ticket issued through the route to `sub` for the world named `name`. */
async function issue(h: Harness, sub = SUB, name = NAME): Promise<string> {
  return ticketOf(await send(h.port, ticketCall(good(h, claims({ sub })), worldBody(name))));
}

function redeem(
  h: Harness,
  ticket: string,
  names: readonly string[] = [NAME],
  world = WORLD,
  source = ADDRESS,
): Promise<Reply> {
  return send(h.port, checkCall(redeemBody(ticket, names, world), source));
}

function checkHandle(h: Harness, handle: string, world = WORLD, source = ADDRESS): Promise<Reply> {
  return send(h.port, checkCall(handleBody(handle, world), source));
}

// ---- answers ----

function jsonOf(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>;
}

function expectJsonHeaders(reply: Reply): void {
  expect(String(reply.headers['content-type'])).toMatch(/^application\/json\b/);
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
}

function expectTicketHeaders(reply: Reply): void {
  expectJsonHeaders(reply);
  expect(reply.headers['access-control-allow-origin']).toBe('*');
}

function expectCheckHeaders(reply: Reply): void {
  expectJsonHeaders(reply);
  const cors = Object.keys(reply.headers).filter((name) => name.startsWith('access-control-'));
  expect(cors).toEqual([]);
}

/** An error answer: the status, the JSON headers and a body of exactly one string `error`. */
function expectError(reply: Reply, status: number): void {
  expect(reply.status, reply.body).toBe(status);
  expectJsonHeaders(reply);
  const json = jsonOf(reply);
  expect(Object.keys(json)).toEqual(['error']);
  expect(json.error).toEqual(expect.any(String));
}

function retryAfterOf(reply: Reply): number {
  const value = String(reply.headers['retry-after']);
  expect(value).toMatch(/^[1-9]\d*$/);
  return Number(value);
}

function ticketOf(reply: Reply): string {
  expect(reply.status, reply.body).toBe(200);
  expectTicketHeaders(reply);
  const json = jsonOf(reply);
  expect(Object.keys(json)).toEqual(['ticket']);
  expect(json.ticket).toMatch(TICKET_TEXT);
  return json.ticket as string;
}

interface Redeemed {
  readonly handle: string;
  readonly entitled: boolean;
  readonly address: string;
  readonly name: string;
}

function redeemedOf(reply: Reply): Redeemed {
  expect(reply.status, reply.body).toBe(200);
  expectCheckHeaders(reply);
  const json = jsonOf(reply);
  expect(Object.keys(json).sort()).toEqual(['address', 'entitled', 'handle', 'name']);
  expect(json.handle).toEqual(expect.any(String));
  expect(typeof json.entitled).toBe('boolean');
  return json as unknown as Redeemed;
}

interface Checked {
  readonly handle: string;
  readonly entitled: boolean;
  readonly address: string;
}

function checkedOf(reply: Reply): Checked {
  expect(reply.status, reply.body).toBe(200);
  expectCheckHeaders(reply);
  const json = jsonOf(reply);
  expect(Object.keys(json).sort()).toEqual(['address', 'entitled', 'handle']);
  expect(json.handle).toEqual(expect.any(String));
  expect(typeof json.entitled).toBe('boolean');
  return json as unknown as Checked;
}

/** A handle that does not stand for this world: exactly `entitled` false and the address. */
function expectMiss(reply: Reply, address = ADDRESS): void {
  expect(reply.status, reply.body).toBe(200);
  expectCheckHeaders(reply);
  expect(jsonOf(reply)).toEqual({ entitled: false, address });
}

/** What a caller can tell two answers apart by: the status, every header but `date`, the body. */
function fixed(reply: Reply): unknown {
  const headers = Object.fromEntries(
    Object.entries(reply.headers).filter(([name]) => name !== 'date'),
  );
  return { status: reply.status, headers, body: reply.body };
}

/** The account has TICKET_LIMIT tickets left in the window, and not one more. */
async function expectTicketsLeft(h: Harness, sub = SUB): Promise<void> {
  const token = good(h, claims({ sub }));
  for (let i = 1; i <= TICKET_LIMIT; i += 1) {
    const reply = await send(h.port, ticketCall(token));
    expect(reply.status, `ticket ${i}: ${reply.body}`).toBe(200);
  }
  expectError(await send(h.port, ticketCall(token)), 429);
}

function splitHandle(handle: string): { readonly kid: string; readonly body: string } {
  const dot = handle.indexOf('.');
  expect(dot).toBeGreaterThan(0);
  return { kid: handle.slice(0, dot), body: handle.slice(dot + 1) };
}

/** `text` with the character at `index` (from the end when negative) replaced by another. */
function changeAt(text: string, index: number): string {
  const at = index < 0 ? text.length + index : index;
  const other = text[at] === 'A' ? 'B' : 'A';
  return `${text.slice(0, at)}${other}${text.slice(at + 1)}`;
}

// ---- createWorldTickets ----

describe('createWorldTickets over a real store', () => {
  test('a ticket is 43 base64url characters, and every one issued is different acs-14.1', async () => {
    const tickets = createWorldTickets(openStore());
    const issued: string[] = [];
    for (let i = 0; i < 16; i += 1) issued.push(await tickets.issue(SUB, NAME));
    for (const ticket of issued) expect(ticket).toMatch(TICKET_TEXT);
    expect(new Set(issued).size).toBe(issued.length);
  });

  test('a ticket is kept under its SHA-256 as the account and the world, and never under its own text acs-14.8', async () => {
    const store = openStore();
    const ticket = await createWorldTickets(store).issue(SUB, NAME);
    const adapter = store.adapter('WorldTicket');
    expect(await adapter.find(ticketId(ticket))).toEqual({ account: SUB, world: NAME });
    expect(await adapter.find(ticket)).toBeUndefined();
  });

  test('spending gives what the ticket was issued for once, and nothing after acs-14.3', async () => {
    const store = openStore();
    const tickets = createWorldTickets(store);
    const ticket = await tickets.issue(STEAM_SUB, OTHER_NAME);
    expect(tickets.spend(ticket)).toEqual({ account: STEAM_SUB, world: OTHER_NAME });
    expect(tickets.spend(ticket)).toBeUndefined();
    expect(await store.adapter('WorldTicket').find(ticketId(ticket))).toBeUndefined();
  });

  test('spending one ticket leaves another, and an unknown ticket gives nothing acs-14.3', async () => {
    const tickets = createWorldTickets(openStore());
    const first = await tickets.issue(SUB, NAME);
    const second = await tickets.issue(SUB2, OTHER_NAME);
    expect(tickets.spend(randomBytes(32).toString('base64url'))).toBeUndefined();
    expect(tickets.spend(first)).toEqual({ account: SUB, world: NAME });
    expect(tickets.spend(second)).toEqual({ account: SUB2, world: OTHER_NAME });
  });

  test('a ticket answers until TICKET_TTL_SECONDS have passed, and at that second it is gone for good acs-14.3', async () => {
    const store = openStore();
    const tickets = createWorldTickets(store);
    const early = await tickets.issue(SUB, NAME);
    const late = await tickets.issue(SUB, NAME);
    clock = T0 + TICKET_TTL_SECONDS - 1;
    expect(tickets.spend(early)).toEqual({ account: SUB, world: NAME });
    clock = T0 + TICKET_TTL_SECONDS;
    expect(tickets.spend(late)).toBeUndefined();
    // The expired record is removed, not only hidden: back at its live time it is still gone.
    clock = T0;
    expect(await store.adapter('WorldTicket').find(ticketId(late))).toBeUndefined();
    expect(tickets.spend(late)).toBeUndefined();
  });

  test('a ticket spent through one store on a file is gone for a second store on that file acs-14.3', async () => {
    const path = join(tempDir(), 'account.sqlite');
    const first = createWorldTickets(openStore(path));
    const second = createWorldTickets(openStore(path));
    const ticket = await first.issue(SUB, NAME);
    expect(second.spend(ticket)).toEqual({ account: SUB, world: NAME });
    expect(first.spend(ticket)).toBeUndefined();
    expect(second.spend(ticket)).toBeUndefined();
  });

  test('the store file holds the record ids and never a ticket text acs-14.8', async () => {
    const dir = tempDir();
    const store = openStore(join(dir, 'account.sqlite'));
    const tickets = createWorldTickets(store);
    const issued = [
      await tickets.issue(SUB, NAME),
      await tickets.issue(SUB2, NAME),
      await tickets.issue(STEAM_SUB, OTHER_NAME),
    ];
    const bytes = Buffer.concat(readdirSync(dir).map((name) => readFileSync(join(dir, name))));
    // The control: the records reached the file.
    expect(bytes.includes(Buffer.from(ticketId(issued[0]!)))).toBe(true);
    for (const ticket of issued) expect(bytes.includes(Buffer.from(ticket))).toBe(false);
  });
});

// ---- POST /ticket ----

describe('POST /ticket issues a ticket to a valid ID token', () => {
  test('a valid token gets 200 with exactly a ticket, the JSON headers and any origin allowed acs-14.1', async () => {
    const h = await harness();
    const reply = await send(h.port, ticketCall(await joseToken(h.login)));
    const ticket = ticketOf(reply);
    expect(h.tickets.spend(ticket)).toEqual({ account: SUB, world: NAME });
  });

  test('the ticket is kept for the token sub and the body world, under its SHA-256 acs-14.1', async () => {
    const h = await harness();
    const ticket = ticketOf(await send(h.port, ticketCall(good(h), worldBody(OTHER_NAME))));
    expect(h.state.upserts).toBe(1);
    const stored = await h.store.adapter('WorldTicket').find(ticketId(ticket));
    expect(stored).toEqual({ account: SUB, world: OTHER_NAME });
  });

  test('every ticket is different, even for one token, body and second acs-14.1', async () => {
    const h = await harness();
    const token = good(h);
    const issued: string[] = [];
    for (let i = 0; i < TICKET_LIMIT; i += 1) {
      issued.push(ticketOf(await send(h.port, ticketCall(token))));
    }
    expect(new Set(issued).size).toBe(issued.length);
  });

  test.each([
    ['a token with no mr_ent', (h: Harness) => good(h, claims({}, 'mr_ent'))],
    ['a token whose mr_ent is empty', (h: Harness) => good(h, claims({ mr_ent: [] }))],
    [
      'an account that is not entitled',
      (h: Harness) => {
        h.accounts.set(SUB, { sub: SUB, entitled: false });
        return good(h);
      },
    ],
    [
      'an account that is gone',
      (h: Harness) => {
        h.accounts.delete(SUB);
        return good(h);
      },
    ],
  ] as ReadonlyArray<
    readonly [string, (h: Harness) => string]
  >)('%s still gets a ticket, and the account is not read acs-14.1', async (_name, build) => {
    const h = await harness();
    const ticket = ticketOf(await send(h.port, ticketCall(build(h))));
    expect(h.state.reads).toEqual([]);
    expect(h.tickets.spend(ticket)).toEqual({ account: SUB, world: NAME });
  });

  test('a token from a second login key is accepted, as is one from the first acs-14.1', async () => {
    const first = generateSigningKey();
    const second = generateSigningKey();
    const h = await harness({ loginKeys: { keys: [first, second] } });
    const bySecond = forge({ alg: 'ES256', kid: second.kid }, claims(), es(second));
    ticketOf(await send(h.port, ticketCall(bySecond)));
    ticketOf(await send(h.port, ticketCall(await joseToken(first))));
  });

  interface Accepted {
    readonly name: string;
    readonly build: (h: Harness) => Call;
    readonly sub?: string;
    readonly world?: string;
  }

  const longest = `dns:${'w'.repeat(MAX_WORLD_NAME_LENGTH - 'dns:'.length)}`;
  const subOf255 = `dev:${'A'.repeat(255 - 'dev:'.length)}`;
  const ACCEPTED: readonly Accepted[] = [
    {
      name: 'a world name at MAX_WORLD_NAME_LENGTH characters',
      build: (h) => ticketCall(good(h), worldBody(longest)),
      world: longest,
    },
    {
      name: 'a world name holding every visible ASCII character',
      build: (h) => ticketCall(good(h), worldBody(EVERY_VISIBLE_ASCII)),
      world: EVERY_VISIBLE_ASCII,
    },
    {
      name: 'a world name of one character',
      build: (h) => ticketCall(good(h), worldBody('!')),
      world: '!',
    },
    {
      name: 'a sub of 255 visible ASCII characters',
      build: (h) => ticketCall(good(h, claims({ sub: subOf255 }))),
      sub: subOf255,
    },
    {
      name: 'a Steam sub',
      build: (h) => ticketCall(good(h, claims({ sub: STEAM_SUB }))),
      sub: STEAM_SUB,
    },
    {
      name: 'a token whose exp is one second after the clock',
      build: (h) => ticketCall(good(h, claims({ exp: clock + 1 }))),
    },
    {
      name: 'application/json with a charset parameter',
      build: (h) => ticketCall(good(h), worldBody(), 'application/json; charset=utf-8'),
    },
    {
      name: 'a body of exactly MAX_TICKET_BODY_BYTES',
      build: (h) => ticketCall(good(h), padded(worldBody(), MAX_TICKET_BODY_BYTES)),
    },
  ];

  test.each(ACCEPTED)('$name gets a ticket for that sub and world acs-14.1', async ({
    build,
    sub = SUB,
    world = NAME,
  }) => {
    const h = await harness();
    const ticket = ticketOf(await send(h.port, build(h)));
    expect(h.tickets.spend(ticket)).toEqual({ account: sub, world });
  });
});

interface Refusal {
  readonly name: string;
  readonly build: (h: Harness) => Call;
  readonly status: number;
}

const TICKET_REFUSALS: readonly Refusal[] = [
  // the method
  {
    name: 'GET with a good token',
    build: (h) => ({ ...ticketCall(good(h)), method: 'GET', body: undefined }),
    status: 405,
  },
  {
    name: 'PUT with a good token and body',
    build: (h) => ({ ...ticketCall(good(h)), method: 'PUT' }),
    status: 405,
  },
  { name: 'DELETE', build: (h) => ({ ...ticketCall(good(h)), method: 'DELETE' }), status: 405 },
  {
    name: 'GET with an expired token',
    build: (h) => ({
      ...ticketCall(good(h, claims({ exp: clock }))),
      method: 'GET',
      body: undefined,
    }),
    status: 405,
  },
  // the Authorization header
  { name: 'no Authorization header', build: () => ticketCall(undefined), status: 401 },
  {
    name: 'Basic credentials',
    build: () => withAuthorization(`Basic ${Buffer.from('a:b').toString('base64')}`),
    status: 401,
  },
  { name: 'Bearer with nothing', build: () => withAuthorization('Bearer'), status: 401 },
  { name: 'a token with no scheme', build: (h) => withAuthorization(good(h)), status: 401 },
  {
    name: 'a token followed by a second word',
    build: (h) => withAuthorization(`Bearer ${good(h)} more`),
    status: 401,
  },
  // the signature
  {
    name: 'alg none naming the login kid',
    build: (h) => ticketCall(forge({ alg: 'none', kid: h.login.kid }, claims(), NO_SIGNATURE)),
    status: 401,
  },
  {
    name: 'a key not in loginKeys',
    build: () => ticketCall(forge({ alg: 'ES256', kid: otherLogin.kid }, claims(), es(otherLogin))),
    status: 401,
  },
  {
    name: 'another key naming the login kid',
    build: (h) => ticketCall(forge({ alg: 'ES256', kid: h.login.kid }, claims(), es(otherLogin))),
    status: 401,
  },
  {
    name: 'a payload changed after signing',
    build: (h) => {
      const [header, , signature] = good(h).split('.');
      return ticketCall(`${header}.${segment(claims({ sub: SUB2 }))}.${signature}`);
    },
    status: 401,
  },
  // exp and iss
  {
    name: 'exp equal to the clock',
    build: (h) => ticketCall(good(h, claims({ exp: clock }))),
    status: 401,
  },
  {
    name: 'exp an hour before the clock',
    build: (h) => ticketCall(good(h, claims({ exp: clock - 3600 }))),
    status: 401,
  },
  { name: 'no exp', build: (h) => ticketCall(good(h, claims({}, 'exp'))), status: 401 },
  {
    name: 'another issuer',
    build: (h) => ticketCall(good(h, claims({ iss: 'http://localhost:4456' }))),
    status: 401,
  },
  {
    name: 'the hosted issuer',
    build: (h) => ticketCall(good(h, claims({ iss: HOSTED_DEV_ISSUER }))),
    status: 401,
  },
  {
    name: 'the issuer with a trailing slash',
    build: (h) => ticketCall(good(h, claims({ iss: `${ISSUER}/` }))),
    status: 401,
  },
  { name: 'no iss', build: (h) => ticketCall(good(h, claims({}, 'iss'))), status: 401 },
  // sub and aud
  { name: 'an empty sub', build: (h) => ticketCall(good(h, claims({ sub: '' }))), status: 401 },
  { name: 'no sub', build: (h) => ticketCall(good(h, claims({}, 'sub'))), status: 401 },
  { name: 'a numeric sub', build: (h) => ticketCall(good(h, claims({ sub: 7 }))), status: 401 },
  {
    name: 'a sub of 256 characters',
    build: (h) => ticketCall(good(h, claims({ sub: `dev:${'A'.repeat(256 - 'dev:'.length)}` }))),
    status: 401,
  },
  {
    name: 'a sub holding a space',
    build: (h) => ticketCall(good(h, claims({ sub: `${SUB} x` }))),
    status: 401,
  },
  {
    name: 'a sub holding a non-ASCII character',
    build: (h) => ticketCall(good(h, claims({ sub: `dev:${E_ACUTE}` }))),
    status: 401,
  },
  {
    name: 'an array aud',
    build: (h) => ticketCall(good(h, claims({ aud: [CLIENT_ID] }))),
    status: 401,
  },
  { name: 'no aud', build: (h) => ticketCall(good(h, claims({}, 'aud'))), status: 401 },
  // the order of the rows: the token before anything of the body
  {
    name: 'an expired token with a bad body',
    build: (h) => ticketCall(good(h, claims({ exp: clock })), '{"world":'),
    status: 401,
  },
  {
    name: 'an expired token with no content type',
    build: (h) => ticketCall(good(h, claims({ exp: clock })), worldBody(), null),
    status: 401,
  },
  {
    name: 'no token and a body over the cap',
    build: () => ticketCall(undefined, padded(worldBody(), MAX_TICKET_BODY_BYTES + 1)),
    status: 401,
  },
  {
    name: 'a bad content type and a body over the cap',
    build: (h) => ticketCall(good(h), padded(worldBody(), MAX_TICKET_BODY_BYTES + 1), 'text/plain'),
    status: 415,
  },
  {
    name: 'a body over the cap that is not JSON',
    build: (h) => ticketCall(good(h), `{${'x'.repeat(MAX_TICKET_BODY_BYTES + 10)}`),
    status: 413,
  },
  // the content type
  { name: 'no content type', build: (h) => ticketCall(good(h), worldBody(), null), status: 415 },
  { name: 'text/plain', build: (h) => ticketCall(good(h), worldBody(), 'text/plain'), status: 415 },
  {
    name: 'a form content type',
    build: (h) => ticketCall(good(h), worldBody(), 'application/x-www-form-urlencoded'),
    status: 415,
  },
  {
    name: 'application/json-patch+json',
    build: (h) => ticketCall(good(h), worldBody(), 'application/json-patch+json'),
    status: 415,
  },
  // the body's size
  {
    name: 'a body one byte over MAX_TICKET_BODY_BYTES',
    build: (h) => ticketCall(good(h), padded(worldBody(), MAX_TICKET_BODY_BYTES + 1)),
    status: 413,
  },
  {
    name: 'a declared Content-Length one over the cap on a short body',
    build: (h) => {
      const call = ticketCall(good(h));
      return {
        ...call,
        headers: { ...call.headers, 'content-length': String(MAX_TICKET_BODY_BYTES + 1) },
      };
    },
    status: 413,
  },
  // the body
  { name: 'a body that is not JSON', build: (h) => ticketCall(good(h), '{"world":'), status: 400 },
  { name: 'an empty body', build: (h) => ticketCall(good(h), ''), status: 400 },
  { name: 'JSON null', build: (h) => ticketCall(good(h), 'null'), status: 400 },
  {
    name: 'a JSON array',
    build: (h) => ticketCall(good(h), JSON.stringify([NAME])),
    status: 400,
  },
  {
    name: 'a JSON string',
    build: (h) => ticketCall(good(h), JSON.stringify(NAME)),
    status: 400,
  },
  { name: 'an empty object', build: (h) => ticketCall(good(h), '{}'), status: 400 },
  {
    name: 'a second member',
    build: (h) => ticketCall(good(h), JSON.stringify({ world: NAME, names: [NAME] })),
    status: 400,
  },
  {
    name: '__proto__ as a second member',
    build: (h) => ticketCall(good(h), `{"world":${JSON.stringify(NAME)},"__proto__":{}}`),
    status: 400,
  },
  { name: 'a numeric world', build: (h) => ticketCall(good(h), worldBody(1)), status: 400 },
  {
    name: 'a world in an array',
    build: (h) => ticketCall(good(h), worldBody([NAME])),
    status: 400,
  },
  { name: 'an empty world', build: (h) => ticketCall(good(h), worldBody('')), status: 400 },
  {
    name: 'a world one character over MAX_WORLD_NAME_LENGTH',
    build: (h) => ticketCall(good(h), worldBody('w'.repeat(MAX_WORLD_NAME_LENGTH + 1))),
    status: 400,
  },
  {
    name: 'a world with a space',
    build: (h) => ticketCall(good(h), worldBody('dns:a b')),
    status: 400,
  },
  {
    name: 'a world with a tab',
    build: (h) => ticketCall(good(h), worldBody(`dns:a${TAB}b`)),
    status: 400,
  },
  {
    name: 'a world with DEL',
    build: (h) => ticketCall(good(h), worldBody(`dns:a${DEL}b`)),
    status: 400,
  },
  {
    name: 'a world with a non-ASCII character',
    build: (h) => ticketCall(good(h), worldBody(`dns:${E_ACUTE}`)),
    status: 400,
  },
];

describe('POST /ticket issues none to anything else', () => {
  test.each(
    TICKET_REFUSALS,
  )('$name is refused $status, issuing nothing and taking no hit acs-14.1', async ({
    build,
    status,
  }) => {
    const h = await harness();
    const reply = await send(h.port, build(h));
    expectError(reply, status);
    expectTicketHeaders(reply);
    if (status === 401) expect(reply.headers['www-authenticate']).toBe('Bearer');
    if (status === 405) expect(String(reply.headers.allow)).toContain('POST');
    expect(h.state.upserts).toBe(0);
    expect(h.state.reads).toEqual([]);
    expect(h.state.fallbacks).toBe(0);
    expect(h.lines).toEqual([]);
    await expectTicketsLeft(h);
  });

  test('a token that the clock reaches the exp of is refused from that second acs-14.1', async () => {
    const h = await harness();
    const token = good(h, claims({ exp: T0 + 100 }));
    clock = T0 + 99;
    ticketOf(await send(h.port, ticketCall(token)));
    clock = T0 + 100;
    expectError(await send(h.port, ticketCall(token)), 401);
    expect(h.state.upserts).toBe(1);
  });

  test('OPTIONS is a CORS preflight: 204 allowing POST with authorization and content-type, issuing nothing', async () => {
    const h = await harness();
    const reply = await send(h.port, {
      path: TICKET_PATH,
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5290',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(reply.status).toBe(204);
    expect(reply.body).toBe('');
    expect(reply.headers['access-control-allow-origin']).toBe('*');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(String(reply.headers['access-control-allow-methods'])).toContain('POST');
    const allowed = String(reply.headers['access-control-allow-headers']).toLowerCase();
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('content-type');
    expect(h.state.upserts).toBe(0);
    expect(h.lines).toEqual([]);
  });

  const NOT_TAKEN: ReadonlyArray<readonly [string, Partial<Call>]> = [
    ['/ticket/', { path: '/ticket/' }],
    ['/TICKET', { path: '/TICKET' }],
    ['/ticket?x=1', { path: '/ticket?x=1' }],
    ['//ticket', { path: '//ticket' }],
    ['/ticket/x', { path: '/ticket/x' }],
    ['/ticket under the ipv4. check host', { host: IPV4_HOST }],
    ['/ticket under the ipv6. check host', { host: IPV6_HOST }],
    ['Host localhost:4456', { host: 'localhost:4456' }],
    ['Host example.com', { host: 'example.com' }],
    ['Host evil.localhost:4455', { host: 'evil.localhost:4455' }],
  ];

  test.each(
    NOT_TAKEN,
  )('%s is not taken: it reaches the fallback with nothing issued', async (_name, change) => {
    const h = await harness();
    const reply = await send(h.port, { ...ticketCall(good(h)), ...change });
    expect(reply.status).toBe(418);
    expect(reply.body).toBe('fallback');
    expect(reply.headers['cache-control']).toBeUndefined();
    expect(h.state.fallbacks).toBe(1);
    expect(h.state.upserts).toBe(0);
    expect(h.lines).toEqual([]);
    await expectTicketsLeft(h);
  });
});

describe('the ticket limit of TICKET_LIMIT per account in TICKET_WINDOW_SECONDS', () => {
  test('TICKET_LIMIT pass and the next is 429 with a retry-after, issuing nothing', async () => {
    const h = await harness();
    const token = good(h);
    for (let i = 0; i < TICKET_LIMIT; i += 1) ticketOf(await send(h.port, ticketCall(token)));
    const refused = await send(h.port, ticketCall(token));
    expectError(refused, 429);
    expectTicketHeaders(refused);
    expect(retryAfterOf(refused)).toBeLessThanOrEqual(TICKET_WINDOW_SECONDS);
    expect(h.state.upserts).toBe(TICKET_LIMIT);
    expect(h.lines).toHaveLength(TICKET_LIMIT);
  });

  test('the window slides: refused a second before the first hit leaves it, answered at that second', async () => {
    const h = await harness();
    const token = good(h, claims({ exp: T0 + 7200 }));
    for (let i = 0; i < TICKET_LIMIT; i += 1) ticketOf(await send(h.port, ticketCall(token)));
    clock = T0 + TICKET_WINDOW_SECONDS - 1;
    const refused = await send(h.port, ticketCall(token));
    expectError(refused, 429);
    expect(retryAfterOf(refused)).toBe(1);
    clock = T0 + TICKET_WINDOW_SECONDS;
    ticketOf(await send(h.port, ticketCall(token)));
  });

  test("the limit is per account: a second account is untouched by the first's", async () => {
    const h = await harness();
    const token = good(h);
    for (let i = 0; i < TICKET_LIMIT; i += 1) ticketOf(await send(h.port, ticketCall(token)));
    expectError(await send(h.port, ticketCall(token)), 429);
    await expectTicketsLeft(h, SUB2);
  });

  test('the limit is keyed by the account, not the token: many tokens of one account use it up', async () => {
    const h = await harness();
    for (let i = 0; i < TICKET_LIMIT; i += 1) {
      const token = good(h, claims({ iat: T0 - i, aud: `client-${i}` }));
      ticketOf(await send(h.port, ticketCall(token)));
    }
    expectError(await send(h.port, ticketCall(good(h, claims({ iat: T0 - 999 })))), 429);
  });

  test('a store that fails answers 500, issues nothing and takes no hit', async () => {
    const h = await harness();
    const token = good(h);
    h.state.storeFails = true;
    for (let i = 0; i < TICKET_LIMIT + 3; i += 1) {
      const reply = await send(h.port, ticketCall(token, worldBody(NAME)));
      expectError(reply, 500);
      expectTicketHeaders(reply);
    }
    h.state.storeFails = false;
    expect(h.state.upserts).toBe(0);
    for (const line of h.lines) expect(line).not.toContain(NAME);
    await expectTicketsLeft(h);
  });
});

// ---- POST /world/check with a ticket ----

describe('a ticket whose name is among names is spent for a handle, entitled, address and name', () => {
  test('the answer is 200 with exactly handle, entitled, address and name acs-14.2', async () => {
    const h = await harness();
    const ticket = await issue(h);
    const answer = redeemedOf(await redeem(h, ticket));
    expect(answer).toEqual({
      handle: h.handles.seal(SUB, WORLD),
      entitled: true,
      address: ADDRESS,
      name: NAME,
    });
    expect(h.handles.open(answer.handle)).toEqual({ account: SUB, world: WORLD });
    expect(h.state.reads).toEqual([SUB]);
  });

  test('name is the one the ticket was issued for, wherever it sits in names acs-14.2', async () => {
    const h = await harness();
    const first = await issue(h, SUB, NAME);
    const second = await issue(h, SUB, OTHER_NAME);
    expect(redeemedOf(await redeem(h, first, [OTHER_NAME, 'dns:x', NAME])).name).toBe(NAME);
    expect(redeemedOf(await redeem(h, second, [NAME, OTHER_NAME])).name).toBe(OTHER_NAME);
  });

  test('the handle is sealed for the account and the world identity presented, not the name acs-14.2', async () => {
    const h = await harness();
    const ticket = await issue(h, STEAM_SUB);
    const answer = redeemedOf(await redeem(h, ticket, [NAME], OTHER_WORLD));
    expect(h.handles.open(answer.handle)).toEqual({ account: STEAM_SUB, world: OTHER_WORLD });
    expect(answer.handle).toBe(h.handles.seal(STEAM_SUB, OTHER_WORLD));
  });

  test('entitled is the account read at the check, not the token: no mr_ent and entitled is true acs-14.2', async () => {
    const h = await harness();
    const ticket = ticketOf(await send(h.port, ticketCall(good(h, claims({}, 'mr_ent')))));
    expect(redeemedOf(await redeem(h, ticket)).entitled).toBe(true);
  });

  test('an account that is not entitled at the check is answered entitled false with its handle acs-14.2', async () => {
    const h = await harness();
    const ticket = await issue(h);
    h.accounts.set(SUB, { sub: SUB, entitled: false });
    const answer = redeemedOf(await redeem(h, ticket));
    expect(answer.entitled).toBe(false);
    expect(answer.handle).toBe(h.handles.seal(SUB, WORLD));
  });

  test('an account that is gone is answered 200, entitled false, with its handle acs-14.2', async () => {
    const h = await harness();
    const ticket = await issue(h);
    h.accounts.delete(SUB);
    const answer = redeemedOf(await redeem(h, ticket));
    expect(answer.entitled).toBe(false);
    expect(answer.handle).toBe(h.handles.seal(SUB, WORLD));
  });

  test('address is the source address of the check, not of the ticket request acs-14.2', async () => {
    const h = await harness();
    const ticket = ticketOf(await send(h.port, { ...ticketCall(good(h)), source: OTHER_ADDRESS }));
    expect(redeemedOf(await redeem(h, ticket, [NAME], WORLD, IPV6_ADDRESS)).address).toBe(
      IPV6_ADDRESS,
    );
  });

  test.each([
    HOST,
    IPV4_HOST,
    IPV6_HOST,
  ])('under %s the ticket is redeemed acs-14.2', async (host) => {
    const h = await harness();
    const ticket = await issue(h);
    const reply = await send(h.port, { ...checkCall(redeemBody(ticket)), host });
    expect(redeemedOf(reply).name).toBe(NAME);
    expect(h.state.fallbacks).toBe(0);
  });

  test('names of MAX_WORLD_NAMES with the ticket name last, and a name of MAX_WORLD_NAME_LENGTH, are accepted acs-14.2', async () => {
    const h = await harness();
    const longest = `dns:${'n'.repeat(MAX_WORLD_NAME_LENGTH - 'dns:'.length)}`;
    const ticket = await issue(h, SUB, longest);
    const names = Array.from({ length: MAX_WORLD_NAMES - 1 }, (_, i) => `dns:other-${i}`);
    expect(redeemedOf(await redeem(h, ticket, [...names, longest])).name).toBe(longest);
  });

  test('a body of exactly MAX_WORLD_CHECK_BODY_BYTES is accepted acs-14.2', async () => {
    const h = await harness();
    const ticket = await issue(h);
    const body = padded(JSON.stringify(redeemBody(ticket)), MAX_WORLD_CHECK_BODY_BYTES);
    expect(redeemedOf(await send(h.port, checkCall(body))).name).toBe(NAME);
  });

  test('a redemption logs one line with the sub and the time acs-14.2', async () => {
    const h = await harness();
    const ticket = await issue(h);
    clock = T0 + 17;
    const before = h.lines.length;
    redeemedOf(await redeem(h, ticket));
    expect(h.lines).toHaveLength(before + 1);
    expect(h.lines[before]).toContain(SUB);
    expect(h.lines[before]).toContain(iso(T0 + 17));
  });

  test('the account is read only after the ticket is spent: a refused ticket reads none acs-14.2', async () => {
    const h = await harness();
    const ticket = await issue(h);
    expectError(await redeem(h, ticket, [OTHER_NAME]), 403);
    expect(h.state.reads).toEqual([]);
  });
});

describe('a ticket that is unknown, spent, expired or not in names gets one fixed 403', () => {
  test('the four answers are one: the same status, headers and body acs-14.3', async () => {
    const h = await harness();
    const unknown = await redeem(h, randomBytes(32).toString('base64url'));
    const spentTicket = await issue(h);
    redeemedOf(await redeem(h, spentTicket));
    const spent = await redeem(h, spentTicket);
    const expiring = await issue(h);
    clock = T0 + TICKET_TTL_SECONDS;
    const expired = await redeem(h, expiring);
    const unlisted = await redeem(h, await issue(h), [OTHER_NAME]);
    expectError(unknown, 403);
    expectCheckHeaders(unknown);
    expect(Object.hasOwn(jsonOf(unknown), 'handle')).toBe(false);
    for (const other of [spent, expired, unlisted]) expect(fixed(other)).toEqual(fixed(unknown));
    expect(h.state.reads).toEqual([SUB]);
  });

  test('a ticket presented with names that do not hold its world is spent all the same acs-14.3', async () => {
    const h = await harness();
    const ticket = await issue(h);
    const wrong = await redeem(h, ticket, [OTHER_NAME]);
    expectError(wrong, 403);
    expect(fixed(await redeem(h, ticket))).toEqual(fixed(wrong));
    expect(h.state.reads).toEqual([]);
  });

  test.each([
    ['in upper case', NAME.toUpperCase()],
    ['less its last character', NAME.slice(0, -1)],
    ['with a character more', `${NAME}/`],
  ])('names are exact strings: the name %s is not the ticket name acs-14.3', async (_name, near) => {
    const h = await harness();
    const ticket = await issue(h);
    expectError(await redeem(h, ticket, [near]), 403);
    expectError(await redeem(h, ticket), 403);
  });

  test('a ticket is redeemed a second before TICKET_TTL_SECONDS pass, and refused at that second acs-14.3', async () => {
    const h = await harness();
    const early = await issue(h);
    const late = await issue(h);
    clock = T0 + TICKET_TTL_SECONDS - 1;
    redeemedOf(await redeem(h, early));
    clock = T0 + TICKET_TTL_SECONDS;
    expectError(await redeem(h, late), 403);
  });

  test('of presentations of one ticket at the same time, exactly one is answered 200 acs-14.3', async () => {
    const h = await harness();
    const refusal = fixed(await redeem(h, randomBytes(32).toString('base64url')));
    const ticket = await issue(h);
    const replies = await Promise.all(Array.from({ length: 8 }, () => redeem(h, ticket)));
    const answered = replies.filter((reply) => reply.status === 200);
    expect(answered).toHaveLength(1);
    redeemedOf(answered[0]!);
    for (const reply of replies.filter((r) => r.status !== 200)) {
      expect(fixed(reply)).toEqual(refusal);
    }
    expect(h.state.reads).toEqual([SUB]);
  });

  test('a ticket presented under several names at once is still spent once acs-14.3', async () => {
    const h = await harness();
    const ticket = await issue(h);
    const replies = await Promise.all([
      redeem(h, ticket, [NAME]),
      redeem(h, ticket, [OTHER_NAME, NAME]),
      redeem(h, ticket, [NAME], OTHER_WORLD),
    ]);
    expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1);
  });

  test('a 403 logs nothing and reads no account acs-14.3', async () => {
    const h = await harness();
    const ticket = await issue(h);
    const before = h.lines.length;
    expectError(await redeem(h, randomBytes(32).toString('base64url')), 403);
    expectError(await redeem(h, ticket, [OTHER_NAME]), 403);
    expectError(await redeem(h, ticket), 403);
    expect(h.lines).toHaveLength(before);
    expect(h.state.reads).toEqual([]);
  });

  const BAD_REDEEMS: ReadonlyArray<readonly [string, (ticket: string) => unknown]> = [
    ['no names', (ticket) => ({ ticket, world: WORLD })],
    ['no world', (ticket) => ({ ticket, names: [NAME] })],
    ['no ticket', () => ({ names: [NAME], world: WORLD })],
    ['empty names', (ticket) => redeemBody(ticket, [])],
    ['names as a string', (ticket) => redeemBody(ticket, NAME)],
    [
      'one name more than MAX_WORLD_NAMES',
      (ticket) =>
        redeemBody(ticket, [
          ...Array.from({ length: MAX_WORLD_NAMES }, (_, i) => `dns:${i}`),
          NAME,
        ]),
    ],
    [
      'a name one character over MAX_WORLD_NAME_LENGTH',
      (ticket) => redeemBody(ticket, [NAME, 'n'.repeat(MAX_WORLD_NAME_LENGTH + 1)]),
    ],
    ['an empty name', (ticket) => redeemBody(ticket, [NAME, ''])],
    ['a name with a space', (ticket) => redeemBody(ticket, [NAME, 'dns:a b'])],
    ['a name with a non-ASCII character', (ticket) => redeemBody(ticket, [NAME, `dns:${E_ACUTE}`])],
    ['a name that is a number', (ticket) => redeemBody(ticket, [NAME, 7])],
    ['a world in upper case', (ticket) => redeemBody(ticket, [NAME], WORLD.toUpperCase())],
    ['a world of 63 hex digits', (ticket) => redeemBody(ticket, [NAME], WORLD.slice(1))],
    ['a world of 65 hex digits', (ticket) => redeemBody(ticket, [NAME], `${WORLD}0`)],
    ['a world that is not hex', (ticket) => redeemBody(ticket, [NAME], `g${WORLD.slice(1)}`)],
    ['the world name as the world', (ticket) => redeemBody(ticket, [NAME], NAME)],
    ['a numeric world', (ticket) => redeemBody(ticket, [NAME], 7)],
    ['a fourth member', (ticket) => ({ ...redeemBody(ticket), extra: 1 })],
    ['a handle member too', (ticket) => ({ ...redeemBody(ticket), handle: 'x.y' })],
    ['the ticket in an array', (ticket) => redeemBody([ticket])],
    ['the ticket with a space after it', (ticket) => redeemBody(`${ticket} `)],
    ['a ticket of 129 characters', () => redeemBody('t'.repeat(129))],
    ['an empty ticket', () => redeemBody('')],
    ['a body that is not JSON', (ticket) => `{"ticket":${JSON.stringify(ticket)}`],
    ['a JSON array', (ticket) => JSON.stringify([ticket, [NAME], WORLD])],
    ['JSON null', () => 'null'],
    ['an empty body', () => ''],
    [
      '__proto__ as a fourth member',
      (ticket) =>
        `{"ticket":${JSON.stringify(ticket)},"names":${JSON.stringify([NAME])},"world":"${WORLD}","__proto__":{}}`,
    ],
  ];

  test.each(BAD_REDEEMS)('%s is 400 and spends nothing acs-14.3', async (_name, build) => {
    const h = await harness();
    const ticket = await issue(h);
    const reply = await send(h.port, checkCall(build(ticket)));
    expectError(reply, 400);
    expectCheckHeaders(reply);
    expect(h.state.reads).toEqual([]);
    redeemedOf(await redeem(h, ticket));
  });

  test('a ticket of 128 visible characters that names nothing is the fixed 403 acs-14.3', async () => {
    const h = await harness();
    const refusal = fixed(await redeem(h, randomBytes(32).toString('base64url')));
    expect(fixed(await redeem(h, EVERY_VISIBLE_ASCII.slice(0, 94) + 'x'.repeat(34)))).toEqual(
      refusal,
    );
  });
});

// ---- POST /world/check with a handle ----

describe('a handle presented for its own world', () => {
  test('is answered 200 with exactly handle, entitled and address, the handle unchanged acs-14.4', async () => {
    const h = await harness();
    const { handle } = redeemedOf(await redeem(h, await issue(h)));
    const reads = h.state.reads.length;
    const answer = checkedOf(await checkHandle(h, handle, WORLD, OTHER_ADDRESS));
    expect(answer).toEqual({ handle, entitled: true, address: OTHER_ADDRESS });
    expect(h.state.reads.slice(reads)).toEqual([SUB]);
  });

  test('a gone account answers exactly as one that is not entitled: status, headers and body acs-14.4', async () => {
    const h = await harness();
    const handle = h.handles.seal(SUB, WORLD);
    h.accounts.set(SUB, { sub: SUB, entitled: false });
    const notEntitled = await checkHandle(h, handle);
    h.accounts.delete(SUB);
    const gone = await checkHandle(h, handle);
    expect(checkedOf(notEntitled)).toEqual({ handle, entitled: false, address: ADDRESS });
    expect(fixed(gone)).toEqual(fixed(notEntitled));
  });

  test('a redemption for a gone account answers exactly as one for an account not entitled acs-14.4', async () => {
    const h = await harness();
    const first = await issue(h);
    const second = await issue(h);
    h.accounts.set(SUB, { sub: SUB, entitled: false });
    const notEntitled = await redeem(h, first);
    h.accounts.delete(SUB);
    const gone = await redeem(h, second);
    expect(redeemedOf(notEntitled).entitled).toBe(false);
    expect(fixed(gone)).toEqual(fixed(notEntitled));
  });

  test('the entitlement is read afresh at every check acs-14.4', async () => {
    const h = await harness();
    const handle = h.handles.seal(SUB2, WORLD);
    expect(checkedOf(await checkHandle(h, handle)).entitled).toBe(true);
    h.accounts.set(SUB2, { sub: SUB2, entitled: false });
    expect(checkedOf(await checkHandle(h, handle)).entitled).toBe(false);
    h.accounts.set(SUB2, { sub: SUB2, entitled: true });
    expect(checkedOf(await checkHandle(h, handle)).entitled).toBe(true);
    expect(h.state.reads).toEqual([SUB2, SUB2, SUB2]);
  });

  test('address is the source address of the check acs-14.4', async () => {
    const h = await harness();
    const handle = h.handles.seal(SUB, WORLD);
    expect(checkedOf(await checkHandle(h, handle, WORLD, IPV6_ADDRESS)).address).toBe(IPV6_ADDRESS);
  });

  test('an answered handle check logs nothing acs-14.4', async () => {
    const h = await harness();
    const handle = h.handles.seal(SUB, WORLD);
    checkedOf(await checkHandle(h, handle));
    h.accounts.delete(SUB);
    checkedOf(await checkHandle(h, handle));
    expect(h.lines).toEqual([]);
  });

  test.each([
    HOST,
    IPV4_HOST,
    IPV6_HOST,
  ])('under %s the handle is checked acs-14.4', async (host) => {
    const h = await harness();
    const handle = h.handles.seal(SUB, WORLD);
    const reply = await send(h.port, { ...checkCall(handleBody(handle)), host });
    expect(checkedOf(reply).handle).toBe(handle);
  });
});

describe('a handle that does not decrypt, or decrypts to another world', () => {
  interface Miss {
    readonly name: string;
    readonly build: (h: Harness) => string;
    readonly world?: string;
  }

  const sealed = (h: Harness): string => h.handles.seal(SUB, WORLD);
  const MISSES: readonly Miss[] = [
    { name: 'text that is no handle', build: () => 'not-a-handle' },
    {
      name: 'a handle with the first character of its body changed',
      build: (h) => changeAt(sealed(h), splitHandle(sealed(h)).kid.length + 1),
    },
    {
      name: 'a handle with a middle character changed',
      build: (h) => changeAt(sealed(h), -12),
    },
    { name: 'a handle with its last character changed', build: (h) => changeAt(sealed(h), -1) },
    { name: 'a handle less its last character', build: (h) => sealed(h).slice(0, -1) },
    { name: 'a handle with a character more', build: (h) => `${sealed(h)}A` },
    { name: 'a handle with base64 padding', build: (h) => `${sealed(h)}=` },
    {
      name: 'a handle whose kid names no key',
      build: (h) => `nokey.${splitHandle(sealed(h)).body}`,
    },
    { name: '__proto__ as the kid', build: (h) => `__proto__.${splitHandle(sealed(h)).body}` },
    { name: 'constructor as the kid', build: (h) => `constructor.${splitHandle(sealed(h)).body}` },
    { name: 'the body with no kid and no dot', build: (h) => splitHandle(sealed(h)).body },
    { name: 'the kid and a dot alone', build: (h) => `${splitHandle(sealed(h)).kid}.` },
    {
      name: 'a handle sealed for another world',
      build: (h) => h.handles.seal(SUB, OTHER_WORLD),
    },
    {
      name: 'a handle for this world presented for another',
      build: (h) => sealed(h),
      world: OTHER_WORLD,
    },
    {
      name: 'a handle sealed under a key the service does not hold',
      build: () => createHandleCodec({ keys: [generateHandleKey()] }).seal(SUB, WORLD),
    },
    {
      name: "another key's body under this key's kid",
      build: (h) => {
        const foreign = createHandleCodec({ keys: [generateHandleKey()] }).seal(SUB, WORLD);
        return `${splitHandle(sealed(h)).kid}.${splitHandle(foreign).body}`;
      },
    },
    { name: 'a handle of 1024 characters', build: () => 'h'.repeat(1024) },
  ];

  test.each(
    MISSES,
  )('$name answers exactly entitled false and the address, reading no account acs-14.5', async ({
    build,
    world = WORLD,
  }) => {
    const h = await harness();
    expectMiss(await checkHandle(h, build(h), world));
    expect(h.state.reads).toEqual([]);
    expect(h.lines).toEqual([]);
    // The control: the handle these are made from is answered.
    expect(checkedOf(await checkHandle(h, sealed(h))).entitled).toBe(true);
  });

  test("another key's kid in front of this key's body answers entitled false acs-14.5", async () => {
    const first = generateHandleKey();
    const second = generateHandleKey();
    const h = await harness({ handleKeys: { keys: [first, second] } });
    const handle = h.handles.seal(SUB, WORLD);
    const { kid, body } = splitHandle(handle);
    expect(kid).toBe(first.kid);
    expectMiss(await checkHandle(h, `${second.kid}.${body}`));
    expect(h.state.reads).toEqual([]);
    expect(checkedOf(await checkHandle(h, handle)).handle).toBe(handle);
  });

  test('a handle for another world reads no account and counts under no handle limit acs-14.5', async () => {
    const h = await harness();
    const elsewhere = h.handles.seal(SUB, OTHER_WORLD);
    for (let i = 0; i <= WORLD_CHECK_HANDLE_LIMIT; i += 1) {
      expectMiss(await checkHandle(h, elsewhere));
    }
    expect(h.state.reads).toEqual([]);
    for (let i = 0; i < WORLD_CHECK_HANDLE_LIMIT; i += 1) {
      checkedOf(await checkHandle(h, h.handles.seal(SUB, WORLD)));
    }
  });

  test('a handle check under the address of another source answers that address acs-14.5', async () => {
    const h = await harness();
    expectMiss(await checkHandle(h, 'not-a-handle', WORLD, IPV6_ADDRESS), IPV6_ADDRESS);
  });
});

describe('one account and world answer one handle under one key', () => {
  test('two tickets of one account for one world redeem to one handle, and its check answers it acs-14.6', async () => {
    const h = await harness();
    const first = redeemedOf(await redeem(h, await issue(h, SUB, NAME))).handle;
    const second = redeemedOf(
      await redeem(h, await issue(h, SUB, OTHER_NAME), [OTHER_NAME]),
    ).handle;
    expect(second).toBe(first);
    expect(checkedOf(await checkHandle(h, first)).handle).toBe(first);
    expect(checkedOf(await checkHandle(h, first)).handle).toBe(first);
  });

  test('another world or another account answers another handle acs-14.6', async () => {
    const h = await harness();
    const mine = redeemedOf(await redeem(h, await issue(h, SUB))).handle;
    const elsewhere = redeemedOf(await redeem(h, await issue(h, SUB), [NAME], OTHER_WORLD)).handle;
    const theirs = redeemedOf(await redeem(h, await issue(h, SUB2))).handle;
    expect(new Set([mine, elsewhere, theirs]).size).toBe(3);
    expect(checkedOf(await checkHandle(h, elsewhere, OTHER_WORLD)).handle).toBe(elsewhere);
    expect(checkedOf(await checkHandle(h, theirs)).handle).toBe(theirs);
  });

  test('two services on one key answer one handle for one account and world acs-14.6', async () => {
    const key = generateHandleKey();
    const a = await harness({ handleKeys: { keys: [key] } });
    const b = await harness({ handleKeys: { keys: [key] } });
    const fromA = redeemedOf(await redeem(a, await issue(a))).handle;
    const fromB = redeemedOf(await redeem(b, await issue(b))).handle;
    expect(fromB).toBe(fromA);
    expect(checkedOf(await checkHandle(b, fromA)).handle).toBe(fromA);
  });

  test('a service on another key answers another handle, and does not open the first acs-14.6', async () => {
    const a = await harness();
    const b = await harness();
    const fromA = redeemedOf(await redeem(a, await issue(a))).handle;
    const fromB = redeemedOf(await redeem(b, await issue(b))).handle;
    expect(fromB).not.toBe(fromA);
    expectMiss(await checkHandle(b, fromA));
  });

  test('a handle under a retired key answers its replacement under the current key acs-14.6', async () => {
    const retired = generateHandleKey();
    const current = generateHandleKey();
    const old = createHandleCodec({ keys: [retired] }).seal(SUB, WORLD);
    const h = await harness({ handleKeys: { keys: [current, retired] } });
    const answer = checkedOf(await checkHandle(h, old));
    expect(answer.entitled).toBe(true);
    expect(answer.handle).not.toBe(old);
    expect(splitHandle(answer.handle).kid).toBe(current.kid);
    expect(answer.handle).toBe(createHandleCodec({ keys: [current] }).seal(SUB, WORLD));
    expect(h.handles.open(answer.handle)).toEqual({ account: SUB, world: WORLD });
    // The replacement is answered back unchanged.
    expect(checkedOf(await checkHandle(h, answer.handle)).handle).toBe(answer.handle);
  });

  test('a ticket redeemed with a retired key held seals under the current key acs-14.6', async () => {
    const retired = generateHandleKey();
    const current = generateHandleKey();
    const h = await harness({ handleKeys: { keys: [current, retired] } });
    const { handle } = redeemedOf(await redeem(h, await issue(h)));
    expect(splitHandle(handle).kid).toBe(current.kid);
    expect(handle).not.toBe(createHandleCodec({ keys: [retired] }).seal(SUB, WORLD));
  });
});

// ---- the limits ----

describe('the source address limit of WORLD_CHECK_ADDRESS_LIMIT per WORLD_CHECK_ADDRESS_WINDOW_SECONDS', () => {
  test('an address is answered WORLD_CHECK_ADDRESS_LIMIT times and then 429; another address is still answered acs-14.7', async () => {
    const h = await harness();
    for (let i = 0; i < WORLD_CHECK_ADDRESS_LIMIT; i += 1) {
      expectMiss(await checkHandle(h, 'not-a-handle'));
    }
    const refused = await checkHandle(h, 'not-a-handle');
    expectError(refused, 429);
    expectCheckHeaders(refused);
    expect(retryAfterOf(refused)).toBeLessThanOrEqual(WORLD_CHECK_ADDRESS_WINDOW_SECONDS);
    expectMiss(await checkHandle(h, 'not-a-handle', WORLD, OTHER_ADDRESS), OTHER_ADDRESS);
    expectError(await checkHandle(h, 'not-a-handle'), 429);
  });

  test('every POST from the address counts, whatever its body, and the limit answers before the content type acs-14.7', async () => {
    const h = await harness();
    const over = padded(JSON.stringify(handleBody('x')), MAX_WORLD_CHECK_BODY_BYTES + 1);
    for (let i = 0; i < WORLD_CHECK_ADDRESS_LIMIT; i += 1) {
      const kind = i % 4;
      if (kind === 0)
        expectError(await send(h.port, checkCall(handleBody('x'), ADDRESS, 'text/plain')), 415);
      else if (kind === 1) expectError(await send(h.port, checkCall(over)), 413);
      else if (kind === 2) expectError(await send(h.port, checkCall('{')), 400);
      else expectMiss(await checkHandle(h, 'not-a-handle'));
    }
    expectError(await checkHandle(h, 'not-a-handle'), 429);
    expectError(await send(h.port, checkCall(handleBody('x'), ADDRESS, 'text/plain')), 429);
    expectError(await send(h.port, checkCall(over)), 429);
  });

  test('a ticket refused for the address limit is not spent, and redeems once the window passes acs-14.7', async () => {
    const h = await harness();
    for (let i = 0; i < WORLD_CHECK_ADDRESS_LIMIT; i += 1) {
      expectMiss(await checkHandle(h, 'not-a-handle'));
    }
    clock = T0 + Math.floor(WORLD_CHECK_ADDRESS_WINDOW_SECONDS / 2);
    const ticket = await issue(h);
    expectError(await redeem(h, ticket), 429);
    expect(h.state.reads).toEqual([]);
    clock = T0 + WORLD_CHECK_ADDRESS_WINDOW_SECONDS;
    expect(redeemedOf(await redeem(h, ticket)).name).toBe(NAME);
  });

  test('the window slides: refused a second before it passes, answered when it has acs-14.7', async () => {
    const h = await harness();
    for (let i = 0; i < WORLD_CHECK_ADDRESS_LIMIT; i += 1) {
      expectMiss(await checkHandle(h, 'not-a-handle'));
    }
    clock = T0 + WORLD_CHECK_ADDRESS_WINDOW_SECONDS - 1;
    const refused = await checkHandle(h, 'not-a-handle');
    expectError(refused, 429);
    expect(retryAfterOf(refused)).toBe(1);
    clock = T0 + WORLD_CHECK_ADDRESS_WINDOW_SECONDS;
    expectMiss(await checkHandle(h, 'not-a-handle'));
  });

  test('IPv6 addresses in one /64 share the limit; an address in another /64 is still answered acs-14.7', async () => {
    const h = await harness();
    for (let i = 0; i < WORLD_CHECK_ADDRESS_LIMIT; i += 1) {
      const source = i % 2 === 0 ? IPV6_ADDRESS : IPV6_SAME_64;
      expectMiss(await checkHandle(h, 'not-a-handle', WORLD, source), source);
    }
    expectError(await checkHandle(h, 'not-a-handle', WORLD, IPV6_SAME_64), 429);
    expectMiss(await checkHandle(h, 'not-a-handle', WORLD, IPV6_OTHER_64), IPV6_OTHER_64);
  });

  test('two IPv4 addresses never share the limit acs-14.7', async () => {
    const h = await harness();
    for (let i = 0; i < WORLD_CHECK_ADDRESS_LIMIT; i += 1) {
      expectMiss(await checkHandle(h, 'not-a-handle'));
    }
    expectError(await checkHandle(h, 'not-a-handle'), 429);
    expectMiss(await checkHandle(h, 'not-a-handle', WORLD, '198.51.100.6'), '198.51.100.6');
    expectMiss(await checkHandle(h, 'not-a-handle', WORLD, '198.51.101.7'), '198.51.101.7');
  });

  test('a method other than POST counts nothing acs-14.7', async () => {
    const h = await harness();
    for (let i = 0; i < WORLD_CHECK_ADDRESS_LIMIT; i += 1) {
      const reply = await send(h.port, { ...checkCall(handleBody('x')), method: 'GET' });
      expectError(reply, 405);
    }
    expectMiss(await checkHandle(h, 'not-a-handle'));
  });
});

describe('the handle limit of WORLD_CHECK_HANDLE_LIMIT per account, world and source address', () => {
  test('past the limit the pair alone is refused: another address, account or world is still answered acs-14.7', async () => {
    const h = await harness();
    const handle = h.handles.seal(SUB, WORLD);
    for (let i = 0; i < WORLD_CHECK_HANDLE_LIMIT; i += 1) checkedOf(await checkHandle(h, handle));
    const reads = h.state.reads.length;
    const refused = await checkHandle(h, handle);
    expectError(refused, 429);
    expectCheckHeaders(refused);
    expect(retryAfterOf(refused)).toBeLessThanOrEqual(WORLD_CHECK_HANDLE_WINDOW_SECONDS);
    expect(h.state.reads).toHaveLength(reads);
    // The same handle from another source address.
    expect(checkedOf(await checkHandle(h, handle, WORLD, OTHER_ADDRESS)).handle).toBe(handle);
    // Another account's handle from this source address.
    const theirs = h.handles.seal(SUB2, WORLD);
    expect(checkedOf(await checkHandle(h, theirs)).handle).toBe(theirs);
    // The same account in another world from this source address.
    const elsewhere = h.handles.seal(SUB, OTHER_WORLD);
    expect(checkedOf(await checkHandle(h, elsewhere, OTHER_WORLD)).handle).toBe(elsewhere);
    expectError(await checkHandle(h, handle), 429);
  });

  test('a handle limit counts per /64: another address of the /64 is refused, another /64 is answered acs-14.7', async () => {
    const h = await harness();
    const handle = h.handles.seal(SUB, WORLD);
    for (let i = 0; i < WORLD_CHECK_HANDLE_LIMIT; i += 1) {
      checkedOf(await checkHandle(h, handle, WORLD, IPV6_ADDRESS));
    }
    expectError(await checkHandle(h, handle, WORLD, IPV6_SAME_64), 429);
    expect(checkedOf(await checkHandle(h, handle, WORLD, IPV6_OTHER_64)).handle).toBe(handle);
  });

  test('a handle under a retired key counts with its replacement acs-14.7', async () => {
    const retired = generateHandleKey();
    const current = generateHandleKey();
    const old = createHandleCodec({ keys: [retired] }).seal(SUB, WORLD);
    const h = await harness({ handleKeys: { keys: [current, retired] } });
    const replacement = h.handles.seal(SUB, WORLD);
    for (let i = 0; i < WORLD_CHECK_HANDLE_LIMIT; i += 1) {
      checkedOf(await checkHandle(h, i % 2 === 0 ? old : replacement));
    }
    expectError(await checkHandle(h, old), 429);
    expectError(await checkHandle(h, replacement), 429);
  });

  test('the window slides: refused a second before it passes, answered when it has acs-14.7', async () => {
    const h = await harness();
    const handle = h.handles.seal(SUB, WORLD);
    for (let i = 0; i < WORLD_CHECK_HANDLE_LIMIT; i += 1) checkedOf(await checkHandle(h, handle));
    clock = T0 + WORLD_CHECK_HANDLE_WINDOW_SECONDS - 1;
    const refused = await checkHandle(h, handle);
    expectError(refused, 429);
    expect(retryAfterOf(refused)).toBe(1);
    clock = T0 + WORLD_CHECK_HANDLE_WINDOW_SECONDS;
    checkedOf(await checkHandle(h, handle));
  });
});

// ---- which requests ----

describe('which requests the world check takes', () => {
  test('the check hosts are the issuer host and its ipv4. and ipv6. names', () => {
    expect([...worldCheckHosts(ISSUER)].sort()).toEqual([HOST, IPV4_HOST, IPV6_HOST].sort());
    const hosted = new URL(HOSTED_DEV_ISSUER).host;
    expect([...worldCheckHosts(HOSTED_DEV_ISSUER)].sort()).toEqual(
      [hosted, `ipv4.${hosted}`, `ipv6.${hosted}`].sort(),
    );
  });

  test('under the hosted issuer both routes answer at its own hosts and not at the local ones', async () => {
    const h = await harness({ issuer: HOSTED_DEV_ISSUER });
    const hosted = new URL(HOSTED_DEV_ISSUER).host;
    const token = good(h, claims({ iss: HOSTED_DEV_ISSUER }));
    const ticket = ticketOf(await send(h.port, { ...ticketCall(token), host: hosted }));
    const reply = await send(h.port, { ...checkCall(redeemBody(ticket)), host: `ipv4.${hosted}` });
    expect(redeemedOf(reply).name).toBe(NAME);
    expect((await send(h.port, ticketCall(token))).status).toBe(418);
    expect((await send(h.port, checkCall(handleBody('x')))).status).toBe(418);
  });

  const NOT_TAKEN: ReadonlyArray<readonly [string, Partial<Call>]> = [
    ['/world/check?x=1', { path: '/world/check?x=1' }],
    ['/world/check/', { path: '/world/check/' }],
    ['/World/Check', { path: '/World/Check' }],
    ['/world', { path: '/world' }],
    ['/world/check/x', { path: '/world/check/x' }],
    ['/ticket under the ipv4. check host', { path: TICKET_PATH, host: IPV4_HOST }],
    ['Host localhost:4456', { host: 'localhost:4456' }],
    ['Host ipv4.localhost:4456', { host: 'ipv4.localhost:4456' }],
    ['Host ipv5.localhost:4455', { host: 'ipv5.localhost:4455' }],
    ['Host ipv4.ipv4.localhost:4455', { host: 'ipv4.ipv4.localhost:4455' }],
    ['Host example.com', { host: 'example.com' }],
  ];

  test.each(
    NOT_TAKEN,
  )('%s is not taken: it reaches the fallback and spends nothing', async (_name, change) => {
    const h = await harness();
    const ticket = await issue(h);
    const reply = await send(h.port, { ...checkCall(redeemBody(ticket)), ...change });
    expect(reply.status).toBe(418);
    expect(reply.body).toBe('fallback');
    expect(h.state.fallbacks).toBe(1);
    expect(h.state.reads).toEqual([]);
    redeemedOf(await redeem(h, ticket));
  });

  test.each([
    'GET',
    'PUT',
    'DELETE',
    'OPTIONS',
  ])('%s is 405 with allow and no CORS header, and spends nothing', async (method) => {
    const h = await harness();
    const ticket = await issue(h);
    const reply = await send(h.port, { ...checkCall(redeemBody(ticket)), method });
    expectError(reply, 405);
    expectCheckHeaders(reply);
    expect(String(reply.headers.allow)).toContain('POST');
    redeemedOf(await redeem(h, ticket));
  });

  test('a check whose source address is unknown is 400 and spends nothing', async () => {
    const h = await harness();
    const ticket = await issue(h);
    const reply = await send(h.port, checkCall(redeemBody(ticket), null));
    expectError(reply, 400);
    expectCheckHeaders(reply);
    expect(h.state.reads).toEqual([]);
    redeemedOf(await redeem(h, ticket));
  });

  test.each([
    ['no content type', null],
    ['text/plain', 'text/plain'],
    ['a form content type', 'application/x-www-form-urlencoded'],
    ['text/json', 'text/json'],
  ] as ReadonlyArray<
    readonly [string, string | null]
  >)('%s is 415 and spends nothing', async (_name, contentType) => {
    const h = await harness();
    const ticket = await issue(h);
    const reply = await send(h.port, checkCall(redeemBody(ticket), ADDRESS, contentType));
    expectError(reply, 415);
    expectCheckHeaders(reply);
    redeemedOf(await redeem(h, ticket));
  });

  test('a body one byte over MAX_WORLD_CHECK_BODY_BYTES, or declared so, is 413 and spends nothing', async () => {
    const h = await harness();
    const ticket = await issue(h);
    const body = JSON.stringify(redeemBody(ticket));
    expectError(await send(h.port, checkCall(padded(body, MAX_WORLD_CHECK_BODY_BYTES + 1))), 413);
    const declared = checkCall(body);
    const reply = await send(h.port, {
      ...declared,
      headers: { ...declared.headers, 'content-length': String(MAX_WORLD_CHECK_BODY_BYTES + 1) },
    });
    expectError(reply, 413);
    expectCheckHeaders(reply);
    redeemedOf(await redeem(h, ticket));
  });

  test('a body holding both forms, or a handle form with a member more, is 400', async () => {
    const h = await harness();
    const handle = h.handles.seal(SUB, WORLD);
    const rows: unknown[] = [
      { handle, world: WORLD, names: [NAME] },
      { handle, world: WORLD, extra: 1 },
      { handle },
      { world: WORLD },
      { handle: '', world: WORLD },
      { handle: 'h'.repeat(1025), world: WORLD },
      { handle: `${handle} `, world: WORLD },
      { handle: [handle], world: WORLD },
      { handle, world: WORLD.toUpperCase() },
      {},
    ];
    for (const row of rows) expectError(await send(h.port, checkCall(row)), 400);
    expect(h.state.reads).toEqual([]);
  });
});

// ---- the service failing ----

describe('a check whose account read fails', () => {
  test('a ticket check answers 500, logs one line with the sub and the time and no message, and the ticket is spent acs-14.8', async () => {
    const h = await harness();
    const ticket = await issue(h);
    clock = T0 + 9;
    const before = h.lines.length;
    h.state.failure = { value: new Error('ERRMARK-k3Vd the account store is down') };
    const reply = await redeem(h, ticket);
    expectError(reply, 500);
    expectCheckHeaders(reply);
    expect(h.lines).toHaveLength(before + 1);
    expect(h.lines[before]).toContain(SUB);
    expect(h.lines[before]).toContain(iso(T0 + 9));
    expect(h.lines[before]).not.toContain('ERRMARK');
    h.state.failure = undefined;
    expectError(await redeem(h, ticket), 403);
  });

  test('a handle check answers 500 and logs one line with the sub and the time and no message acs-14.8', async () => {
    const h = await harness();
    const handle = h.handles.seal(SUB2, WORLD);
    clock = T0 + 21;
    h.state.failure = { value: new TypeError('ERRMARK-p8Qs thrown') };
    const reply = await checkHandle(h, handle);
    expectError(reply, 500);
    expectCheckHeaders(reply);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain(SUB2);
    expect(h.lines[0]).toContain(iso(T0 + 21));
    expect(h.lines[0]).not.toContain('ERRMARK');
    h.state.failure = undefined;
    expect(checkedOf(await checkHandle(h, handle)).handle).toBe(handle);
  });

  test('an account read that rejects with a non-Error value answers 500 and the next check is answered', async () => {
    const h = await harness();
    const handle = h.handles.seal(SUB, WORLD);
    for (const value of ['down', undefined, 7]) {
      h.state.failure = { value };
      expectError(await checkHandle(h, handle), 500);
    }
    h.state.failure = undefined;
    expect(checkedOf(await checkHandle(h, handle)).entitled).toBe(true);
  });
});

// ---- what is logged and stored ----

// Values for each thing no line may hold, made so they cannot occur in a line by accident.
const NAME_MARK = 'dns:NAMEMARK-q7Zr2XvKp9Lm.example:3000/NAMEMARK-c41d9f0e';
const OTHER_NAME_MARK = 'dns:NAMEMARK-other-w2Lx8.example';
const WORLD_MARK = hex64('acs14 world mark');
const ADDRESS_MARK = '203.0.113.219';
const IPV6_ADDRESS_MARK = '2001:db8:5eed:a11::77';

function expectCleanLines(lines: readonly string[], secrets: readonly string[]): void {
  for (const line of lines) {
    expect(line).not.toContain('NAMEMARK');
    expect(line).not.toContain(WORLD_MARK);
    expect(line).not.toContain(WORLD_MARK.slice(0, 16));
    expect(line).not.toContain(WORLD_MARK.slice(-16));
    expect(line).not.toContain(ADDRESS_MARK);
    expect(line).not.toContain(IPV6_ADDRESS_MARK);
    expect(line).not.toContain('ERRMARK');
    for (const secret of secrets) expect(line).not.toContain(secret);
  }
}

describe('what the routes log and store', () => {
  test('one line per ticket issued and per ticket redeemed, with the sub and the time; never a world, name, handle, ticket or address acs-14.8', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    const h = await harness();
    const secrets: string[] = [];
    const remember = (value: string): string => {
      secrets.push(value);
      return value;
    };
    const step = async (call: Call, status: number, added: number): Promise<Reply> => {
      const before = h.lines.length;
      const reply = await send(h.port, call);
      expect(reply.status, reply.body).toBe(status);
      expect(h.lines.length - before, `${status} logged`).toBe(added);
      return reply;
    };
    const expectLast = (at: number): void => {
      const line = h.lines[h.lines.length - 1]!;
      expect(line).toContain(SUB);
      expect(line).toContain(iso(at));
    };
    const token = good(h, claims({ exp: T0 + 7200 }));
    const issueMarked = async (): Promise<string> => {
      const reply = await step(
        { ...ticketCall(token, worldBody(NAME_MARK)), source: ADDRESS_MARK },
        200,
        1,
      );
      expectLast(clock);
      return remember(ticketOf(reply));
    };
    const redeemCall = (ticket: string, names = [NAME_MARK]): Call =>
      checkCall(redeemBody(ticket, names, WORLD_MARK), ADDRESS_MARK);

    // A ticket issued and redeemed: a line each.
    clock = T0 + 3;
    const ticket = await issueMarked();
    clock = T0 + 5;
    const redeemedReply = await step(redeemCall(ticket), 200, 1);
    expectLast(T0 + 5);
    const { handle } = redeemedOf(redeemedReply);
    remember(handle);
    remember(splitHandle(handle).body);

    // Handle checks, answered or not: no line.
    await step(checkCall(handleBody(handle, WORLD_MARK), IPV6_ADDRESS_MARK), 200, 0);
    await step(checkCall(handleBody(`${handle}A`, WORLD_MARK), ADDRESS_MARK), 200, 0);
    await step(checkCall(handleBody(handle, hex64('acs14 other world')), ADDRESS_MARK), 200, 0);

    // Refusals of /ticket: no line.
    await step({ ...ticketCall(undefined, worldBody(NAME_MARK)), source: ADDRESS_MARK }, 401, 0);
    await step(ticketCall(token, worldBody(`${NAME_MARK} x`)), 400, 0);
    await step(ticketCall(token, JSON.stringify({ world: NAME_MARK, x: NAME_MARK })), 400, 0);
    await step(ticketCall(token, worldBody(NAME_MARK), 'text/plain'), 415, 0);
    await step(ticketCall(token, padded(worldBody(NAME_MARK), MAX_TICKET_BODY_BYTES + 1)), 413, 0);
    await step(
      { path: TICKET_PATH, method: 'GET', headers: { authorization: `Bearer ${token}` } },
      405,
      0,
    );

    // Refusals of /world/check: no line.
    await step(redeemCall(ticket), 403, 0);
    const unlisted = await issueMarked();
    await step(redeemCall(unlisted, [OTHER_NAME_MARK]), 403, 0);
    await step(
      checkCall(
        redeemBody(remember(randomBytes(32).toString('base64url')), [NAME_MARK], WORLD_MARK),
        ADDRESS_MARK,
      ),
      403,
      0,
    );
    await step(
      checkCall({ ...redeemBody(ticket, [NAME_MARK], WORLD_MARK), extra: NAME_MARK }, ADDRESS_MARK),
      400,
      0,
    );
    await step(checkCall(handleBody(handle, WORLD_MARK), null), 400, 0);
    await step(checkCall(handleBody(handle, WORLD_MARK), ADDRESS_MARK, 'text/plain'), 415, 0);
    await step(
      { ...checkCall(handleBody(handle, WORLD_MARK), ADDRESS_MARK), method: 'GET' },
      405,
      0,
    );

    // The service failing: one line with the sub, and nothing of the error's message.
    const failing = await issueMarked();
    h.state.failure = { value: new Error(`ERRMARK ${NAME_MARK} ${WORLD_MARK} ${ADDRESS_MARK}`) };
    clock = T0 + 8;
    await step(redeemCall(failing), 500, 1);
    expectLast(T0 + 8);
    await step(checkCall(handleBody(handle, WORLD_MARK), IPV6_ADDRESS_MARK), 500, 1);
    expectLast(T0 + 8);
    h.state.failure = undefined;

    // The pair's limit: its 429 logs nothing.
    let last = 0;
    for (let i = 0; i <= WORLD_CHECK_HANDLE_LIMIT + 1 && last !== 429; i += 1) {
      const before = h.lines.length;
      const reply = await send(h.port, checkCall(handleBody(handle, WORLD_MARK), ADDRESS_MARK));
      last = reply.status;
      expect([200, 429]).toContain(last);
      expect(h.lines).toHaveLength(before);
    }
    expect(last).toBe(429);

    expect(h.lines).toHaveLength(6);
    expectCleanLines(h.lines, secrets);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test('the store file holds no ticket text, before or after a redemption, and a spent record is gone acs-14.8', async () => {
    const dir = tempDir();
    const h = await harness({ storePath: join(dir, 'account.sqlite') });
    const issued = [await issue(h), await issue(h, SUB2), await issue(h, STEAM_SUB, OTHER_NAME)];
    const bytesOf = (): Buffer =>
      Buffer.concat(readdirSync(dir).map((name) => readFileSync(join(dir, name))));
    // The control: the records reached the file.
    expect(bytesOf().includes(Buffer.from(ticketId(issued[1]!)))).toBe(true);
    for (const ticket of issued) expect(bytesOf().includes(Buffer.from(ticket))).toBe(false);
    redeemedOf(await redeem(h, issued[0]!));
    for (const ticket of issued) expect(bytesOf().includes(Buffer.from(ticket))).toBe(false);
    const adapter = h.store.adapter('WorldTicket');
    expect(await adapter.find(ticketId(issued[0]!))).toBeUndefined();
    expect(await adapter.find(ticketId(issued[1]!))).toEqual({ account: SUB2, world: NAME });
  });
});
