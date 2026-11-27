import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import type { Adapter } from 'oidc-provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type SteamStub,
  type SteamStubAnswer,
  type SteamStubMethod,
  type SteamStubRequest,
  startSteamStub,
} from '../../test-util/steamStub.ts';
import { ConfigError, type Profile } from '../config.ts';
import { denyList, steamAccounts } from '../denyList.ts';
import { type AccountStore, openAccountStore } from '../store/sqliteAdapter.ts';
import {
  type AppOwnership,
  type OwnershipCheck,
  parseSteamId,
  type SteamId,
  steamEntitlementSource,
} from './ownership.ts';
import {
  createSteamWebApi,
  MAX_STEAM_ANSWER_BYTES,
  MAX_TICKET_BYTES,
  SteamApiError,
  type SteamFailure,
  type SteamWebApi,
  type TicketCheck,
} from './webApi.ts';

type Env = Record<string, string | undefined>;
type Side = 'dev' | 'production';
type Result = TicketCheck | OwnershipCheck;

const PLAYER = parseSteamId('76561198000000001')!;
const OTHER = parseSteamId('76561198000000002')!;
const IDENTITY = 'monster-realm-account';
const DEV_APP_ID = 480;
const GAME_APP_ID = 3_141_590;
const AUTH_PATH = '/ISteamUserAuth/AuthenticateUserTicket/v1/';
const OWN_PATH = '/ISteamUser/CheckAppOwnership/v4/';
const AUTH: SteamStubMethod = 'AuthenticateUserTicket';
const OWN: SteamStubMethod = 'CheckAppOwnership';
const WEB_KEY_SETTING = 'MR_STEAM_WEB_API_KEY';
const PUBLISHER_KEY_SETTING = 'MR_STEAM_PUBLISHER_KEY';
const SHORT_TIMEOUT_MS = 200;
const LOGGED_REASONS: readonly SteamFailure[] = ['timeout', 'unreachable', 'status', 'malformed'];
const NOT_OWNED: AppOwnership = {
  ownsapp: false,
  permanent: false,
  sitelicense: false,
  ownersteamid: '0',
};
const E_ACUTE = String.fromCharCode(0x00e9);
const DEL = String.fromCharCode(0x7f);
const NUL = String.fromCharCode(0);

const stubs: SteamStub[] = [];
const stores: AccountStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const started of stubs.splice(0)) await started.close();
});

async function stub(appId?: number): Promise<SteamStub> {
  const started = await startSteamStub(appId === undefined ? undefined : { appId });
  stubs.push(started);
  return started;
}

function openStore(): AccountStore {
  const store = openAccountStore(':memory:');
  stores.push(store);
  return store;
}

/** A long distinctive value that must never surface anywhere it is looked for. */
function marker(label: string): string {
  return `INTERNAL_SECRET_${label}_${randomBytes(12).toString('hex')}`;
}

function profileOf(side: Side): Profile {
  return side === 'dev' ? 'local-dev' : 'production';
}

function appIdOf(side: Side): number {
  return side === 'dev' ? DEV_APP_ID : GAME_APP_ID;
}

function keySettingOf(side: Side): string {
  return side === 'dev' ? WEB_KEY_SETTING : PUBLISHER_KEY_SETTING;
}

interface Client {
  readonly api: SteamWebApi;
  readonly stub: SteamStub;
  readonly lines: string[];
}

interface ClientOptions {
  /** Put the stub's key in env under the profile's setting; default true. */
  readonly key?: boolean;
  readonly timeoutMs?: number;
  /** The client's app id; default the side's. */
  readonly appId?: number;
  readonly profile?: Profile;
  readonly env?: Env;
  readonly stub?: SteamStub;
}

/** A client of `side` against a stub of the side's app id, logging into `lines`. */
async function client(side: Side, options: ClientOptions = {}): Promise<Client> {
  const target = options.stub ?? (await stub(appIdOf(side)));
  const lines: string[] = [];
  const env: Env = { ...options.env };
  if (options.key !== false) env[keySettingOf(side)] = target.key;
  const api = createSteamWebApi({
    config: {
      profile: options.profile ?? profileOf(side),
      steam: { appId: options.appId ?? appIdOf(side) },
    },
    env,
    log: (line) => {
      lines.push(line);
    },
    baseUrl: target.url,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { api, stub: target, lines };
}

function owner(holder: string): AppOwnership {
  return { ownsapp: true, permanent: true, sitelicense: false, ownersteamid: holder };
}

/** The result as one comparable word: its kind, and for a failure its reason and status. */
function outcomeOf(result: Result): string {
  if (result.kind !== 'failed') return result.kind;
  const error = result.error;
  if (!(error instanceof SteamApiError)) return 'failed:not-a-SteamApiError';
  return error.reason === 'status' ? `failed:status:${error.status}` : `failed:${error.reason}`;
}

function failureOf(result: Result): SteamApiError {
  expect(result.kind).toBe('failed');
  if (result.kind !== 'failed') throw new Error(`expected a failure, got ${result.kind}`);
  expect(result.error).toBeInstanceOf(SteamApiError);
  return result.error as SteamApiError;
}

/** Every way an error can be shown: message, string, stack, JSON, inspection and own members. */
function viewsOf(error: Error): string[] {
  const members = Object.getOwnPropertyNames(error).map((name) =>
    String((error as unknown as Record<string, unknown>)[name]),
  );
  return [
    error.message,
    String(error),
    error.stack ?? '',
    JSON.stringify(error) ?? '',
    inspect(error, { depth: null, showHidden: true }),
    ...members,
  ];
}

function expectNothingOf(error: Error, values: readonly string[]): void {
  for (const view of viewsOf(error)) {
    for (const value of values) expect(view).not.toContain(value);
  }
  expect(error.cause).toBeUndefined();
}

function expectKeyOnlyInHeader(sent: SteamStubRequest, key: string): void {
  expect(sent.headers['x-webapi-key']).toBe(key);
  expect(sent.query.has('key')).toBe(false);
  expect(sent.target).not.toContain(key);
  expect(sent.target).not.toContain(encodeURIComponent(key));
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** `json` followed by spaces up to exactly `bytes` bytes: still the same JSON value. */
function padded(json: string, bytes: number): string {
  return json + ' '.repeat(bytes - Buffer.byteLength(json));
}

function percentEncoded(value: string): string {
  return Array.from(
    value,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  ).join('');
}

function ticketBody(params: Record<string, unknown>): string {
  return JSON.stringify({ response: { params } });
}

function ticketSuccess(steamId: string, extra: Record<string, unknown> = {}): string {
  return ticketBody({
    result: 'OK',
    steamid: steamId,
    ownersteamid: steamId,
    vacbanned: false,
    publisherbanned: false,
    ...extra,
  });
}

/** An owner's answer, with members changed or dropped. */
function ownerBody(change: Record<string, unknown> = {}, drop?: string): string {
  const full: Record<string, unknown> = {
    ownsapp: true,
    permanent: true,
    timestamp: '2026-11-26T00:00:00Z',
    timeexpires: '1970-01-01T00:00:00Z',
    ownersteamid: PLAYER,
    sitelicense: false,
    usercanceled: false,
    result: 'OK',
    ...change,
  };
  const appownership = Object.fromEntries(Object.entries(full).filter(([name]) => name !== drop));
  return JSON.stringify({ appownership });
}

// ---------------------------------------------------------------------------------------------
// The failure table: each fault the stub can play, for each call.

interface Fault {
  readonly name: string;
  readonly reason: Exclude<SteamFailure, 'unconfigured'>;
  readonly status?: number;
  /** Needs the short timeout: the answer never completes. */
  readonly short?: boolean;
  /** The stub's answer, with `echo` planted in its body, status text and a header. */
  readonly answer: (echo: string, elsewhere: string) => SteamStubAnswer;
}

const STATUSES = [400, 401, 403, 404, 429, 500, 503];

function malformed(name: string, body: (echo: string) => string): Fault {
  return {
    name,
    reason: 'malformed',
    answer: (echo) => ({
      kind: 'body',
      body: body(echo),
      statusText: echo,
      headers: { 'x-steam-detail': echo },
    }),
  };
}

function commonFaults(path: string, valid: string): Fault[] {
  return [
    ...STATUSES.map(
      (status): Fault => ({
        name: `a ${status} answer`,
        reason: 'status',
        status,
        answer: (echo) => ({
          kind: 'status',
          status,
          statusText: echo,
          headers: { 'x-steam-detail': echo },
          body: `<html><body>${echo}</body></html>`,
        }),
      }),
    ),
    ...[302, 307].map(
      (status): Fault => ({
        name: `a ${status} redirect to another listener`,
        reason: 'status',
        status,
        answer: (echo, elsewhere) => ({
          kind: 'redirect',
          status,
          location: `${elsewhere}${path}?detail=${echo}`,
          statusText: echo,
          headers: { 'x-steam-detail': echo },
          body: echo,
        }),
      }),
    ),
    {
      name: 'no answer at all',
      reason: 'timeout',
      short: true,
      answer: () => ({ kind: 'no-answer' }),
    },
    {
      name: '200 headers then a body that never ends',
      reason: 'timeout',
      short: true,
      answer: (echo) => ({
        kind: 'endless-body',
        body: `{"detail":"${echo}"`,
        statusText: echo,
        headers: { 'x-steam-detail': echo },
      }),
    },
    {
      name: 'the connection closed with no answer',
      reason: 'unreachable',
      answer: () => ({ kind: 'closed' }),
    },
    {
      name: 'the connection closed part-way through a 200 body',
      reason: 'unreachable',
      answer: (echo) => ({
        kind: 'closed-mid-body',
        body: `{"detail":"${echo}",`,
        statusText: echo,
        headers: { 'x-steam-detail': echo },
      }),
    },
    malformed('an empty body', () => ''),
    malformed('an HTML page', (echo) => `<html><body>${echo}</body></html>`),
    malformed('JSON null', () => 'null'),
    malformed('a JSON array', (echo) => `["${echo}"]`),
    malformed('a JSON string', (echo) => `"${echo}"`),
    malformed('a JSON number', () => '42'),
    malformed('an object without the envelope', (echo) => `{"detail":"${echo}"}`),
    malformed('truncated JSON', (echo) => `${valid.slice(0, -3)}${echo}`),
    malformed('a valid answer one byte over the cap', () =>
      padded(valid, MAX_STEAM_ANSWER_BYTES + 1),
    ),
    {
      name: 'a body over the cap that never ends',
      reason: 'malformed',
      short: true,
      answer: (echo) => ({
        kind: 'endless-body',
        body: padded(`{"detail":"${echo}"`, MAX_STEAM_ANSWER_BYTES + 4096),
        headers: { 'x-steam-detail': echo },
      }),
    },
  ];
}

const TICKET_MALFORMED: readonly Fault[] = [
  malformed('an empty response object', () => '{"response":{}}'),
  malformed('a null response', () => '{"response":null}'),
  malformed('a string response', (echo) => `{"response":"${echo}"}`),
  malformed('null params', () => '{"response":{"params":null}}'),
  malformed('a steamid that is a JSON number', () =>
    ticketBody({ result: 'OK', steamid: Number(PLAYER) }),
  ),
  malformed('a steamid of 16 digits', () => ticketSuccess(PLAYER.slice(1))),
  malformed('a steamid of 18 digits', () => ticketSuccess(`${PLAYER}0`)),
  malformed('a steamid with text after it', (echo) => ticketSuccess(`${PLAYER}${echo}`)),
  malformed('a result that is not OK', (echo) =>
    ticketBody({ result: echo, steamid: PLAYER, ownersteamid: PLAYER }),
  ),
  malformed('params without a result', () => ticketBody({ steamid: PLAYER })),
  malformed('params outside the response envelope', () =>
    JSON.stringify({ params: { result: 'OK', steamid: PLAYER } }),
  ),
];

const OWNERSHIP_MALFORMED: readonly Fault[] = [
  malformed('a null appownership', () => '{"appownership":null}'),
  malformed('an array appownership', () => '{"appownership":[]}'),
  malformed('a string appownership', (echo) => `{"appownership":"${echo}"}`),
  malformed('an appownership without ownsapp', () => ownerBody({}, 'ownsapp')),
  malformed('ownsapp the string false', () => '{"appownership":{"ownsapp":"false"}}'),
  malformed('ownsapp 0', () => '{"appownership":{"ownsapp":0}}'),
  malformed('ownsapp the string true', () => ownerBody({ ownsapp: 'true' })),
  malformed('a not-owned answer whose result is not OK', (echo) =>
    JSON.stringify({ appownership: { ownsapp: false, result: echo } }),
  ),
  malformed('a not-owned answer whose result is null', () =>
    JSON.stringify({ appownership: { ownsapp: false, result: null } }),
  ),
  malformed('an owner answer whose result is a lower-case ok', () => ownerBody({ result: 'ok' })),
  malformed('an owner answer without permanent', () => ownerBody({}, 'permanent')),
  malformed('an owner answer without sitelicense', () => ownerBody({}, 'sitelicense')),
  malformed('an owner answer without ownersteamid', () => ownerBody({}, 'ownersteamid')),
  malformed('an owner answer with permanent the string true', () =>
    ownerBody({ permanent: 'true' }),
  ),
  malformed('an owner answer with sitelicense 0', () => ownerBody({ sitelicense: 0 })),
  malformed('an owner answer with sitelicense null', () => ownerBody({ sitelicense: null })),
  malformed('an owner answer with ownersteamid a JSON number', () =>
    ownerBody({ ownersteamid: Number(PLAYER) }),
  ),
  malformed('an owner answer with an empty ownersteamid', () => ownerBody({ ownersteamid: '' })),
  malformed('an owner answer with an ownersteamid of 21 digits', () =>
    ownerBody({ ownersteamid: `${PLAYER}0000` }),
  ),
  malformed('an owner answer with a space before ownersteamid', () =>
    ownerBody({ ownersteamid: ` ${PLAYER}` }),
  ),
  malformed('an owner answer with text for ownersteamid', (echo) =>
    ownerBody({ ownersteamid: echo }),
  ),
  malformed('an owner answer outside the envelope', () =>
    JSON.stringify({ ownsapp: true, permanent: true, sitelicense: false, ownersteamid: PLAYER }),
  ),
];

interface Call {
  readonly label: string;
  readonly side: Side;
  readonly method: SteamStubMethod;
  readonly run: (api: SteamWebApi, target: SteamStub) => Promise<Result>;
  readonly faults: readonly Fault[];
}

const TICKET_FAULTS = [...commonFaults(AUTH_PATH, ticketSuccess(PLAYER)), ...TICKET_MALFORMED];
const OWNERSHIP_FAULTS = [...commonFaults(OWN_PATH, ownerBody()), ...OWNERSHIP_MALFORMED];

const CALLS: readonly Call[] = [
  {
    label: 'AuthenticateUserTicket on production',
    side: 'production',
    method: AUTH,
    run: (api, target) => api.authenticateTicket(target.issueTicket(PLAYER, IDENTITY), IDENTITY),
    faults: TICKET_FAULTS,
  },
  {
    label: 'CheckAppOwnership on production',
    side: 'production',
    method: OWN,
    run: (api) => api.checkAppOwnership(PLAYER),
    faults: OWNERSHIP_FAULTS,
  },
  {
    label: 'AuthenticateUserTicket on local-dev',
    side: 'dev',
    method: AUTH,
    run: (api, target) => api.authenticateTicket(target.issueTicket(PLAYER, IDENTITY), IDENTITY),
    faults: TICKET_FAULTS,
  },
];

const FAILURE_ROWS = CALLS.flatMap((call) =>
  call.faults.map((fault) => [call.label, fault.name, call, fault] as const),
);

// ---------------------------------------------------------------------------------------------

describe('what the client sends', () => {
  test.each([
    'dev',
    'production',
  ] as const)('on %s authenticateTicket sends one GET to the exact path with appid, ticket and identity once each, and the key only in x-webapi-key', async (side) => {
    const c = await client(side);
    const ticket = c.stub.issueTicket(PLAYER, IDENTITY);
    await c.api.authenticateTicket(ticket, IDENTITY);
    expect(c.stub.requests).toHaveLength(1);
    const sent = c.stub.requests[0]!;
    expect(sent.method).toBe('GET');
    expect(sent.path).toBe(AUTH_PATH);
    expect([...sent.query.keys()].sort()).toEqual(['appid', 'identity', 'ticket']);
    expect(sent.query.get('appid')).toBe(String(appIdOf(side)));
    expect(sent.query.get('ticket')).toBe(ticket);
    expect(sent.query.get('identity')).toBe(IDENTITY);
    expectKeyOnlyInHeader(sent, c.stub.key);
  });

  test('on production checkAppOwnership sends one GET to the exact path with appid and steamid once each, and the key only in x-webapi-key', async () => {
    const c = await client('production');
    await c.api.checkAppOwnership(OTHER);
    expect(c.stub.requests).toHaveLength(1);
    const sent = c.stub.requests[0]!;
    expect(sent.method).toBe('GET');
    expect(sent.path).toBe(OWN_PATH);
    expect([...sent.query.keys()].sort()).toEqual(['appid', 'steamid']);
    expect(sent.query.get('appid')).toBe(String(GAME_APP_ID));
    expect(sent.query.get('steamid')).toBe(OTHER);
    expectKeyOnlyInHeader(sent, c.stub.key);
  });

  test('the app id sent is the one in the config', async () => {
    const appId = 4_294_967_295;
    const c = await client('production', { appId });
    await c.api.checkAppOwnership(PLAYER);
    await c.api.authenticateTicket(hex(16), IDENTITY);
    expect(c.stub.requests.map((sent) => sent.query.get('appid'))).toEqual([
      String(appId),
      String(appId),
    ]);
  });

  test.each([
    ['lower case', (ticket: string) => ticket],
    ['upper case', (ticket: string) => ticket.toUpperCase()],
    [
      'mixed case',
      (ticket: string) =>
        Array.from(ticket, (char, i) => (i % 2 === 0 ? char.toUpperCase() : char)).join(''),
    ],
  ])('a ticket in %s is sent exactly as given', async (_name, spell) => {
    const c = await client('production');
    const ticket = spell(c.stub.issueTicket(PLAYER, IDENTITY));
    expect(await c.api.authenticateTicket(ticket, IDENTITY)).toStrictEqual({
      kind: 'authenticated',
      steamId: PLAYER,
    });
    expect(c.stub.requests[0]!.query.getAll('ticket')).toEqual([ticket]);
  });

  test.each([
    ['every allowed punctuation mark', 'Monster.Realm_account:v-2'],
    ['only punctuation', '.:_-'],
    ['one character', 'a'],
    ['128 characters', `${'a'.repeat(120)}.-_:.-_:`],
  ])('an identity of %s arrives as one parameter with the same value', async (_name, identity) => {
    const c = await client('production');
    const result = await c.api.authenticateTicket(c.stub.issueTicket(PLAYER, identity), identity);
    expect(result).toStrictEqual({ kind: 'authenticated', steamId: PLAYER });
    expect(c.stub.requests[0]!.query.getAll('identity')).toEqual([identity]);
    expect([...c.stub.requests[0]!.query.keys()].sort()).toEqual(['appid', 'identity', 'ticket']);
  });

  test('production sends the publisher key and never a web key that is also in env', async () => {
    const webKey = marker('web_key');
    const c = await client('production', { env: { [WEB_KEY_SETTING]: webKey } });
    await c.api.authenticateTicket(c.stub.issueTicket(PLAYER, IDENTITY), IDENTITY);
    await c.api.checkAppOwnership(PLAYER);
    expect(c.stub.requests).toHaveLength(2);
    for (const sent of c.stub.requests) {
      expect(sent.headers['x-webapi-key']).toBe(c.stub.key);
      expect(`${sent.target}${JSON.stringify(sent.headers)}`).not.toContain(webKey);
    }
  });

  test('a dev profile sends the web key and never a publisher key that is also in env', async () => {
    const publisherKey = marker('publisher_key');
    const c = await client('dev', { env: { [PUBLISHER_KEY_SETTING]: publisherKey } });
    await c.api.authenticateTicket(c.stub.issueTicket(PLAYER, IDENTITY), IDENTITY);
    expect(c.stub.requests).toHaveLength(1);
    const sent = c.stub.requests[0]!;
    expect(sent.headers['x-webapi-key']).toBe(c.stub.key);
    expect(`${sent.target}${JSON.stringify(sent.headers)}`).not.toContain(publisherKey);
  });

  test('a dev profile with only a publisher key in env has no key: unconfigured, nothing sent', async () => {
    const target = await stub(DEV_APP_ID);
    const c = await client('dev', {
      stub: target,
      key: false,
      env: { [PUBLISHER_KEY_SETTING]: target.key },
    });
    const result = await c.api.authenticateTicket(target.issueTicket(PLAYER, IDENTITY), IDENTITY);
    expect(outcomeOf(result)).toBe('failed:unconfigured');
    expect(target.requests).toEqual([]);
  });
});

describe('authenticateTicket results', () => {
  test.each([
    'dev',
    'production',
  ] as const)('on %s a ticket issued for the identity authenticates as the SteamID it is issued for, one request, nothing logged', async (side) => {
    const c = await client(side);
    const result = await c.api.authenticateTicket(c.stub.issueTicket(OTHER, IDENTITY), IDENTITY);
    expect(result).toStrictEqual({ kind: 'authenticated', steamId: OTHER });
    expect(c.stub.requests).toHaveLength(1);
    expect(c.lines).toEqual([]);
  });

  test('a ticket issued for another identity is rejected, one request, nothing logged', async () => {
    const c = await client('production');
    const ticket = c.stub.issueTicket(PLAYER, 'another-identity');
    expect(await c.api.authenticateTicket(ticket, IDENTITY)).toStrictEqual({ kind: 'rejected' });
    expect(c.stub.requests).toHaveLength(1);
    expect(c.lines).toEqual([]);
  });

  test('a ticket checked under another app id is rejected, one request, nothing logged', async () => {
    const c = await client('production', { appId: GAME_APP_ID + 1 });
    const ticket = c.stub.issueTicket(PLAYER, IDENTITY);
    expect(await c.api.authenticateTicket(ticket, IDENTITY)).toStrictEqual({ kind: 'rejected' });
    expect(c.stub.requests).toHaveLength(1);
    expect(c.lines).toEqual([]);
  });

  test('a hex ticket Steam never issued is rejected, one request, nothing logged', async () => {
    const c = await client('production');
    expect(await c.api.authenticateTicket(hex(234), IDENTITY)).toStrictEqual({ kind: 'rejected' });
    expect(c.stub.requests).toHaveLength(1);
    expect(c.lines).toEqual([]);
  });

  test.each([
    [
      'params beside an error',
      (echo: string) =>
        JSON.stringify({
          response: {
            params: { result: 'OK', steamid: PLAYER, ownersteamid: PLAYER },
            error: { errorcode: 105, errordesc: echo },
          },
        }),
    ],
    [
      'errorcode 101',
      (echo: string) =>
        JSON.stringify({ response: { error: { errorcode: 101, errordesc: echo } } }),
    ],
    ['an error with no errorcode', (_echo: string) => JSON.stringify({ response: { error: {} } })],
  ])('a 200 whose response holds %s is rejected, holding nothing but its kind', async (_name, body) => {
    const c = await client('production');
    const echo = marker('errordesc');
    c.stub.respondNext(AUTH, { kind: 'body', body: body(echo) });
    const result = await c.api.authenticateTicket(c.stub.issueTicket(PLAYER, IDENTITY), IDENTITY);
    expect(result).toStrictEqual({ kind: 'rejected' });
    expect(Object.keys(result)).toEqual(['kind']);
    expect(c.stub.requests).toHaveLength(1);
    expect(c.lines).toEqual([]);
  });

  test.each([
    ['empty', ''],
    ['of odd length', 'abc'],
    ['not hex', 'zz'],
    ['written with a 0x prefix', '0x00ff'],
    ['holding a space', '00 ff'],
    ['ending in a newline', '00ff\n'],
    ['holding a non-ASCII letter', `00${E_ACUTE}f`],
    ['one byte over MAX_TICKET_BYTES', hex(MAX_TICKET_BYTES + 1)],
  ])('a ticket %s is rejected with no request and nothing logged', async (_name, ticket) => {
    const c = await client('production');
    expect(await c.api.authenticateTicket(ticket, IDENTITY)).toStrictEqual({ kind: 'rejected' });
    expect(c.stub.requests).toEqual([]);
    expect(c.lines).toEqual([]);
  });

  test('a ticket of exactly MAX_TICKET_BYTES bytes is sent', async () => {
    const c = await client('production');
    const ticket = hex(MAX_TICKET_BYTES);
    expect(await c.api.authenticateTicket(ticket, IDENTITY)).toStrictEqual({ kind: 'rejected' });
    expect(c.stub.requests).toHaveLength(1);
    expect(c.stub.requests[0]!.query.get('ticket')).toBe(ticket);
  });

  test('a success answer of exactly MAX_STEAM_ANSWER_BYTES bytes is read', async () => {
    const c = await client('production');
    c.stub.respondNext(AUTH, {
      kind: 'body',
      body: padded(ticketSuccess(OTHER), MAX_STEAM_ANSWER_BYTES),
    });
    const result = await c.api.authenticateTicket(c.stub.issueTicket(PLAYER, IDENTITY), IDENTITY);
    expect(result).toStrictEqual({ kind: 'authenticated', steamId: OTHER });
  });

  test.each([
    ['empty', ''],
    ['a space', 'monster realm'],
    ['an ampersand', 'a&identity=b'],
    ['a hash', 'a#b'],
    ['a percent sign', 'a%26b'],
    ['a plus', 'a+b'],
    ['an equals sign', 'a=b'],
    ['a question mark', 'a?b'],
    ['a slash', 'a/b'],
    ['a newline', 'realm\n'],
    ['a non-ASCII letter', `r${E_ACUTE}alm`],
    ['129 characters', 'a'.repeat(129)],
    ['undefined, from a JS caller', undefined as unknown as string],
  ])('an identity with %s rejects with TypeError and sends nothing', async (_name, identity) => {
    const c = await client('production');
    const ticket = c.stub.issueTicket(PLAYER, IDENTITY);
    await expect(c.api.authenticateTicket(ticket, identity)).rejects.toBeInstanceOf(TypeError);
    expect(c.stub.requests).toEqual([]);
    expect(c.lines).toEqual([]);
  });

  test('a bad identity is refused before a bad ticket and before a missing dev key', async () => {
    const prod = await client('production');
    await expect(prod.api.authenticateTicket('', 'a b')).rejects.toBeInstanceOf(TypeError);
    const dev = await client('dev', { key: false });
    await expect(dev.api.authenticateTicket(hex(8), 'a b')).rejects.toBeInstanceOf(TypeError);
    expect(prod.stub.requests).toEqual([]);
    expect(dev.stub.requests).toEqual([]);
  });

  test('a bad ticket on a dev profile with no key is rejected, not unconfigured', async () => {
    const c = await client('dev', { key: false });
    expect(await c.api.authenticateTicket('zz', IDENTITY)).toStrictEqual({ kind: 'rejected' });
    expect(c.stub.requests).toEqual([]);
  });
});

describe('checkAppOwnership results', () => {
  test('an owner answer comes back with exactly the four members as sent, one request, nothing logged', async () => {
    const c = await client('production');
    c.stub.setOwnership(PLAYER, owner(PLAYER));
    expect(await c.api.checkAppOwnership(PLAYER)).toStrictEqual({
      kind: 'answered',
      ownership: owner(PLAYER),
    });
    expect(c.stub.requests).toHaveLength(1);
    expect(c.lines).toEqual([]);
  });

  test.each([
    [
      'a shared licence',
      { ownsapp: true, permanent: false, sitelicense: true, ownersteamid: OTHER },
    ],
    ['a one-digit owner', { ...owner(PLAYER), ownersteamid: '1' }],
    ['a twenty-digit owner', { ...owner(PLAYER), ownersteamid: '12345678901234567890' }],
  ] as ReadonlyArray<
    readonly [string, AppOwnership]
  >)('an owner answer for %s comes back exactly as sent, the rule not applied', async (_name, ownership) => {
    const c = await client('production');
    c.stub.setOwnership(PLAYER, ownership);
    expect(await c.api.checkAppOwnership(PLAYER)).toStrictEqual({ kind: 'answered', ownership });
    expect(c.lines).toEqual([]);
  });

  test('a player Steam has no licence for is answered with the fixed not-owned value', async () => {
    const c = await client('production');
    expect(await c.api.checkAppOwnership(PLAYER)).toStrictEqual({
      kind: 'answered',
      ownership: NOT_OWNED,
    });
    expect(c.stub.requests).toHaveLength(1);
    expect(c.lines).toEqual([]);
  });

  test.each([
    ['nothing but ownsapp', '{"appownership":{"ownsapp":false}}'],
    [
      'the other members in the player favour',
      JSON.stringify({
        appownership: {
          ownsapp: false,
          permanent: true,
          sitelicense: false,
          ownersteamid: PLAYER,
          result: 'OK',
        },
      }),
    ],
    [
      'the other members of other types',
      JSON.stringify({
        appownership: { ownsapp: false, permanent: 'yes', sitelicense: 1, ownersteamid: 7 },
      }),
    ],
    ['null members', '{"appownership":{"ownsapp":false,"permanent":null,"ownersteamid":null}}'],
  ])('ownsapp false with %s is answered with the fixed not-owned value', async (_name, body) => {
    const c = await client('production');
    c.stub.respondNext(OWN, { kind: 'body', body });
    expect(await c.api.checkAppOwnership(PLAYER)).toStrictEqual({
      kind: 'answered',
      ownership: NOT_OWNED,
    });
    expect(c.stub.requests).toHaveLength(1);
    expect(c.lines).toEqual([]);
  });

  test('an owner answer of exactly MAX_STEAM_ANSWER_BYTES bytes is read', async () => {
    const c = await client('production');
    c.stub.respondNext(OWN, { kind: 'body', body: padded(ownerBody(), MAX_STEAM_ANSWER_BYTES) });
    expect(await c.api.checkAppOwnership(PLAYER)).toStrictEqual({
      kind: 'answered',
      ownership: owner(PLAYER),
    });
  });

  test.each([
    ['0', '0'],
    ['16 digits', PLAYER.slice(1)],
    ['18 digits', `${PLAYER}0`],
    ['a leading space', ` ${PLAYER}`],
    ['a trailing newline', `${PLAYER}\n`],
    ['the subject form', `steam:${PLAYER}`],
    ['an empty string', ''],
    ['a number', Number(PLAYER)],
    ['undefined', undefined],
  ])('a steamId of %s at run time rejects with TypeError and sends nothing', async (_name, raw) => {
    const c = await client('production');
    await expect(c.api.checkAppOwnership(raw as unknown as SteamId)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(c.stub.requests).toEqual([]);
    expect(c.lines).toEqual([]);
  });

  test('a bad steamId on a dev profile rejects with TypeError before unconfigured', async () => {
    const c = await client('dev');
    await expect(c.api.checkAppOwnership('0' as unknown as SteamId)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(c.stub.requests).toEqual([]);
  });
});

describe('a failure of Steam', () => {
  test.each(
    FAILURE_ROWS,
  )('%s, %s: failed with its reason, never a rejection, one request, nothing Steam sent in the error acs-8.2', async (_label, _name, call, fault) => {
    const c = await client(call.side, fault.short ? { timeoutMs: SHORT_TIMEOUT_MS } : {});
    const elsewhere = await stub();
    const echo = marker('steam_answer');
    c.stub.respondNext(call.method, fault.answer(echo, elsewhere.url));
    const error = failureOf(await call.run(c.api, c.stub));
    expect(error.reason).toBe(fault.reason);
    if (fault.reason === 'status') expect(error.status).toBe(fault.status);
    else expect(error.status).toBeUndefined();
    expect(c.stub.requests).toHaveLength(1);
    expect(elsewhere.requests).toEqual([]);
    expectNothingOf(error, [echo, c.stub.key]);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).not.toContain(echo);
  });

  test.each([
    'dev',
    'production',
  ] as const)('on %s a refused connection is unreachable acs-8.2', async (side) => {
    const gone = await stub(appIdOf(side));
    await gone.close();
    const c = await client(side, { stub: gone });
    const ticket = hex(234);
    const error = failureOf(await c.api.authenticateTicket(ticket, IDENTITY));
    expect(error.reason).toBe('unreachable');
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).not.toContain(ticket);
    if (side === 'production') {
      expect(failureOf(await c.api.checkAppOwnership(PLAYER)).reason).toBe('unreachable');
    }
  });

  test.each(
    CALLS.map((call) => [call.label, call] as const),
  )('%s: two errors of one reason have equal messages acs-8.2', async (_label, call) => {
    const target = await stub(appIdOf(call.side));
    const c = await client(call.side, { stub: target });
    const short = await client(call.side, { stub: target, timeoutMs: SHORT_TIMEOUT_MS });
    const failWith = async (answer: SteamStubAnswer, use: Client = c): Promise<SteamApiError> => {
      target.respondNext(call.method, answer);
      return failureOf(await call.run(use.api, target));
    };
    const pairs: ReadonlyArray<readonly [SteamApiError, SteamApiError]> = [
      [
        await failWith({ kind: 'status', status: 500, body: marker('a') }),
        await failWith({ kind: 'status', status: 503, body: marker('b') }),
      ],
      [
        await failWith({ kind: 'status', status: 400, statusText: marker('c') }),
        await failWith({ kind: 'status', status: 403, statusText: marker('d') }),
      ],
      [
        await failWith({ kind: 'no-answer' }, short),
        await failWith({ kind: 'endless-body', body: `{"${marker('e')}"` }, short),
      ],
      [await failWith({ kind: 'closed' }), await failWith({ kind: 'closed-mid-body', body: '{"' })],
      [
        await failWith({ kind: 'body', body: `<html>${marker('f')}</html>` }),
        await failWith({ kind: 'body', body: 'null' }),
      ],
    ];
    for (const [first, second] of pairs) {
      expect(first.reason).toBe(second.reason);
      expect(first.message).toBe(second.message);
    }
    expect(target.requests).toHaveLength(pairs.length * 2);
  });

  test.each(
    OWNERSHIP_FAULTS.map((fault) => [fault.name, fault] as const),
  )('through the production decision, %s is not entitled: unavailable with the client error acs-8.2', async (_name, fault) => {
    const c = await client('production', fault.short ? { timeoutMs: SHORT_TIMEOUT_MS } : {});
    const elsewhere = await stub();
    c.stub.setOwnership(PLAYER, owner(PLAYER));
    c.stub.respondNext(OWN, fault.answer(marker('steam_answer'), elsewhere.url));
    let flagReads = 0;
    const decide = steamEntitlementSource({
      profile: 'production',
      denied: async () => false,
      devFlag: async () => {
        flagReads += 1;
        return true;
      },
      checkAppOwnership: (steamId) => c.api.checkAppOwnership(steamId),
    });
    const result = await decide(PLAYER);
    expect(result.entitled).toBe(false);
    if (result.entitled || result.reason !== 'unavailable') {
      throw new Error(`expected unavailable, got ${JSON.stringify(result)}`);
    }
    expect(result.error).toBeInstanceOf(SteamApiError);
    expect((result.error as SteamApiError).reason).toBe(fault.reason);
    expect(flagReads).toBe(0);
    expect(c.stub.requests).toHaveLength(1);
  });
});

describe('what the client logs', () => {
  test('across a full exchange no line holds a key, a ticket or a request target; each failure logs one line naming its call, nothing else logs, and no other channel is written acs-8.3', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'debug'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    try {
      const lines: string[] = [];
      const log = (line: string): void => {
        lines.push(line);
      };
      const prodStub = await stub(GAME_APP_ID);
      const devStub = await stub(DEV_APP_ID);
      const elsewhere = await stub();
      const make = (
        profile: Profile,
        target: SteamStub,
        env: Env,
        extra: { readonly timeoutMs?: number; readonly appId?: number } = {},
      ): SteamWebApi =>
        createSteamWebApi({
          config: {
            profile,
            steam: { appId: extra.appId ?? (profile === 'production' ? GAME_APP_ID : DEV_APP_ID) },
          },
          env,
          log,
          baseUrl: target.url,
          ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
        });
      const prodEnv: Env = { [PUBLISHER_KEY_SETTING]: prodStub.key };
      const devEnv: Env = { [WEB_KEY_SETTING]: devStub.key };
      const prod = make('production', prodStub, prodEnv);
      const prodShort = make('production', prodStub, prodEnv, { timeoutMs: SHORT_TIMEOUT_MS });
      const prodOtherApp = make('production', prodStub, prodEnv, { appId: GAME_APP_ID + 1 });
      const dev = make('local-dev', devStub, devEnv);
      const devShort = make('local-dev', devStub, devEnv, { timeoutMs: SHORT_TIMEOUT_MS });
      const devNoKey = make('local-dev', devStub, {});

      const prodTicket = prodStub.issueTicket(PLAYER, IDENTITY);
      const devTicket = devStub.issueTicket(PLAYER, IDENTITY);
      const tickets = [prodTicket, devTicket].flatMap((ticket) => [ticket, ticket.toUpperCase()]);
      const secrets = [
        prodStub.key,
        devStub.key,
        ...tickets.flatMap((ticket) => [
          ticket,
          percentEncoded(ticket),
          percentEncoded(ticket).toLowerCase(),
        ]),
      ];

      let failures = 0;
      const exchange = async (
        expected: string,
        call: string,
        target: SteamStub,
        requests: number,
        run: () => Promise<Result>,
      ): Promise<void> => {
        const linesBefore = lines.length;
        const requestsBefore = target.requests.length;
        const result = await run();
        expect(outcomeOf(result), `${call}: ${expected}`).toBe(expected);
        expect(target.requests.length - requestsBefore, `${call}: ${expected}`).toBe(requests);
        const added = lines.slice(linesBefore);
        const error = result.kind === 'failed' ? (result.error as SteamApiError) : undefined;
        const reason = error?.reason;
        if (error !== undefined && reason !== undefined && LOGGED_REASONS.includes(reason)) {
          failures += 1;
          expect(added, `${call}: ${expected}`).toHaveLength(1);
          expect(added[0]).toContain(call);
          expect(added[0]).toContain(reason);
          if (reason === 'status') {
            expect(added[0]).toContain(String(error.status));
          }
        } else {
          expect(added, `${call}: ${expected}`).toEqual([]);
        }
      };

      // Successes, refusals and unconfigured calls: no line.
      await exchange('authenticated', AUTH, prodStub, 1, () =>
        prod.authenticateTicket(prodTicket, IDENTITY),
      );
      await exchange('authenticated', AUTH, prodStub, 1, () =>
        prod.authenticateTicket(prodTicket.toUpperCase(), IDENTITY),
      );
      await exchange('authenticated', AUTH, devStub, 1, () =>
        dev.authenticateTicket(devTicket.toUpperCase(), IDENTITY),
      );
      await exchange('rejected', AUTH, prodStub, 1, () =>
        prod.authenticateTicket(prodStub.issueTicket(PLAYER, 'another-identity'), IDENTITY),
      );
      await exchange('rejected', AUTH, prodStub, 1, () =>
        prodOtherApp.authenticateTicket(prodTicket, IDENTITY),
      );
      await exchange('rejected', AUTH, prodStub, 1, () =>
        prod.authenticateTicket(hex(234), IDENTITY),
      );
      await exchange('rejected', AUTH, prodStub, 0, () =>
        prod.authenticateTicket(`${prodTicket}0`, IDENTITY),
      );
      prodStub.respondNext(AUTH, {
        kind: 'body',
        body: JSON.stringify({
          response: {
            params: { result: 'OK', steamid: PLAYER },
            error: { errorcode: 3, errordesc: `${prodStub.key} ${prodTicket}` },
          },
        }),
      });
      await exchange('rejected', AUTH, prodStub, 1, () =>
        prod.authenticateTicket(prodTicket, IDENTITY),
      );
      prodStub.setOwnership(PLAYER, owner(PLAYER));
      await exchange('answered', OWN, prodStub, 1, () => prod.checkAppOwnership(PLAYER));
      await exchange('answered', OWN, prodStub, 1, () => prod.checkAppOwnership(OTHER));
      await exchange('failed:unconfigured', AUTH, devStub, 0, () =>
        devNoKey.authenticateTicket(devTicket, IDENTITY),
      );
      await exchange('failed:unconfigured', OWN, devStub, 0, () => dev.checkAppOwnership(PLAYER));
      await expect(prod.authenticateTicket(prodTicket, `${IDENTITY} `)).rejects.toBeInstanceOf(
        TypeError,
      );

      // Every failure, the stub echoing the key and the ticket back in its answer.
      const sides = [
        { target: prodStub, ticket: prodTicket, api: prod, short: prodShort, own: true },
        { target: devStub, ticket: devTicket, api: dev, short: devShort, own: false },
      ];
      for (const side of sides) {
        const echo = `${side.target.key}_${side.ticket}_${side.ticket.toUpperCase()}`;
        const runs: Array<
          readonly [SteamStubMethod, readonly Fault[], (api: SteamWebApi) => Promise<Result>]
        > = [[AUTH, TICKET_FAULTS, (api) => api.authenticateTicket(side.ticket, IDENTITY)]];
        if (side.own) runs.push([OWN, OWNERSHIP_FAULTS, (api) => api.checkAppOwnership(PLAYER)]);
        for (const [call, faults, run] of runs) {
          for (const fault of faults) {
            side.target.respondNext(call, fault.answer(echo, elsewhere.url));
            const expected =
              fault.reason === 'status'
                ? `failed:status:${fault.status}`
                : `failed:${fault.reason}`;
            await exchange(expected, call, side.target, 1, () =>
              run(fault.short ? side.short : side.api),
            );
          }
        }
      }

      expect(failures).toBe(2 * TICKET_FAULTS.length + OWNERSHIP_FAULTS.length);
      expect(lines).toHaveLength(failures);
      expect(elsewhere.requests).toEqual([]);
      const targets = [...prodStub.requests, ...devStub.requests].map((sent) => sent.target);
      for (const line of lines) {
        for (const secret of secrets) expect(line).not.toContain(secret);
        for (const target of targets) {
          expect(line).not.toContain(target);
          const query = target.indexOf('?');
          if (query !== -1) expect(line).not.toContain(target.slice(query + 1));
        }
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test('a log that throws changes no result acs-8.3', async () => {
    const target = await stub(GAME_APP_ID);
    const make = (timeoutMs?: number): SteamWebApi =>
      createSteamWebApi({
        config: { profile: 'production', steam: { appId: GAME_APP_ID } },
        env: { [PUBLISHER_KEY_SETTING]: target.key },
        log: () => {
          throw new Error('the log is down');
        },
        baseUrl: target.url,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    const api = make();
    const short = make(SHORT_TIMEOUT_MS);
    const ticket = target.issueTicket(PLAYER, IDENTITY);

    expect(await api.authenticateTicket(ticket, IDENTITY)).toStrictEqual({
      kind: 'authenticated',
      steamId: PLAYER,
    });
    target.respondNext(OWN, { kind: 'status', status: 503 });
    expect(outcomeOf(await api.checkAppOwnership(PLAYER))).toBe('failed:status:503');
    target.respondNext(AUTH, { kind: 'body', body: '<html></html>' });
    expect(outcomeOf(await api.authenticateTicket(ticket, IDENTITY))).toBe('failed:malformed');
    target.respondNext(OWN, { kind: 'closed' });
    expect(outcomeOf(await api.checkAppOwnership(PLAYER))).toBe('failed:unreachable');
    target.respondNext(AUTH, { kind: 'no-answer' });
    expect(outcomeOf(await short.authenticateTicket(ticket, IDENTITY))).toBe('failed:timeout');
    expect(await api.checkAppOwnership(PLAYER)).toStrictEqual({
      kind: 'answered',
      ownership: NOT_OWNED,
    });
    expect(target.requests).toHaveLength(6);
  });

  test.each([
    'dev',
    'production',
  ] as const)('on %s the client object shows no key to JSON or inspection acs-8.3', async (side) => {
    const c = await client(side);
    expect(JSON.stringify(c.api) ?? '').not.toContain(c.stub.key);
    expect(inspect(c.api, { depth: null, showHidden: true })).not.toContain(c.stub.key);
    for (const name of Object.getOwnPropertyNames(c.api)) {
      expect(String((c.api as unknown as Record<string, unknown>)[name])).not.toContain(c.stub.key);
    }
  });
});

describe('constructing the client', () => {
  function thrown(run: () => unknown): unknown {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  function expectConfigError(run: () => unknown, setting: string, values: readonly string[] = []) {
    const error = thrown(run);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe(setting);
    for (const value of values) {
      expect((error as ConfigError).message).not.toContain(value);
      expect(String(error)).not.toContain(value);
      expect((error as ConfigError).stack ?? '').not.toContain(value);
    }
  }

  const ignore = (): void => undefined;

  test.each([
    'dev',
    'production',
  ] as const)('on %s a config without steam is refused for MR_STEAM_APP_ID', (side) => {
    const key = marker('key');
    expectConfigError(
      () =>
        createSteamWebApi({
          config: { profile: profileOf(side) },
          env: { [keySettingOf(side)]: key },
          log: ignore,
        }),
      'MR_STEAM_APP_ID',
      [key],
    );
  });

  test.each([
    ['no key', {}],
    ['an empty key', { [PUBLISHER_KEY_SETTING]: '' }],
    ['only the web key', { [WEB_KEY_SETTING]: 'INTERNAL_SECRET_web_key_acs8' }],
  ] as ReadonlyArray<
    readonly [string, Env]
  >)('production with %s is refused for MR_STEAM_PUBLISHER_KEY', (_name, env) => {
    expectConfigError(
      () =>
        createSteamWebApi({
          config: { profile: 'production', steam: { appId: GAME_APP_ID } },
          env,
          log: ignore,
        }),
      PUBLISHER_KEY_SETTING,
    );
  });

  const badKeys: ReadonlyArray<readonly [string, string]> = [
    ['a space', `${marker('steam_key')} tail`],
    ['a line break', `${marker('steam_key')}\nnext`],
    ['a tab', `${marker('steam_key')}\tnext`],
    ['DEL', `${marker('steam_key')}${DEL}`],
    ['NUL', `${marker('steam_key')}${NUL}`],
    ['a non-ASCII letter', `${marker('steam_key')}${E_ACUTE}`],
    ['257 characters', `${marker('steam_key')}${'x'.repeat(257)}`],
  ];

  test.each(
    (['dev', 'production'] as const).flatMap((side) =>
      badKeys.map(([name, value]) => [side, name, value] as const),
    ),
  )('on %s a key with %s is refused for its setting, the value nowhere in the refusal', (side, _name, value) => {
    expectConfigError(
      () =>
        createSteamWebApi({
          config: { profile: profileOf(side), steam: { appId: appIdOf(side) } },
          env: { [keySettingOf(side)]: value },
          log: ignore,
        }),
      keySettingOf(side),
      [value.slice(0, 40)],
    );
  });

  const visible256 = Array.from({ length: 256 }, (_, i) =>
    String.fromCharCode(0x21 + (i % 94)),
  ).join('');

  test.each(
    (['dev', 'production'] as const).flatMap((side) =>
      (
        [
          ['one character', '!'],
          ['the last visible character', '~'],
          ['256 visible characters', visible256],
        ] as const
      ).map(([name, value]) => [side, name, value] as const),
    ),
  )('on %s a key of %s is accepted', (side, _name, value) => {
    expect(() =>
      createSteamWebApi({
        config: { profile: profileOf(side), steam: { appId: appIdOf(side) } },
        env: { [keySettingOf(side)]: value },
        log: ignore,
      }),
    ).not.toThrow();
  });

  test('a dev profile with no key is built', () => {
    expect(() =>
      createSteamWebApi({
        config: { profile: 'hosted-dev', steam: { appId: DEV_APP_ID } },
        env: {},
        log: ignore,
      }),
    ).not.toThrow();
  });

  test('a key only on the env prototype is not read', async () => {
    const target = await stub(DEV_APP_ID);
    const names = [PUBLISHER_KEY_SETTING, WEB_KEY_SETTING];
    for (const name of names) {
      Object.defineProperty(Object.prototype, name, {
        value: target.key,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    let production: unknown;
    let dev: SteamWebApi | undefined;
    try {
      production = thrown(() =>
        createSteamWebApi({
          config: { profile: 'production', steam: { appId: GAME_APP_ID } },
          env: {},
          log: ignore,
        }),
      );
      dev = createSteamWebApi({
        config: { profile: 'local-dev', steam: { appId: DEV_APP_ID } },
        env: {},
        log: ignore,
        baseUrl: target.url,
      });
    } finally {
      for (const name of names) Reflect.deleteProperty(Object.prototype, name);
    }
    expect(production).toBeInstanceOf(ConfigError);
    expect((production as ConfigError).setting).toBe(PUBLISHER_KEY_SETTING);
    const result = await dev!.authenticateTicket(target.issueTicket(PLAYER, IDENTITY), IDENTITY);
    expect(outcomeOf(result)).toBe('failed:unconfigured');
    expect(target.requests).toEqual([]);
  });

  test.each([
    ['a path', 'http://127.0.0.1:9/x'],
    ['a trailing slash', 'http://127.0.0.1:9/'],
    ['userinfo', 'http://user@127.0.0.1:9'],
    ['a query', 'http://127.0.0.1:9?x=1'],
    ['a fragment', 'http://127.0.0.1:9#x'],
    ['http on a remote host', 'http://example.com'],
    ['http on another loopback address', 'http://127.0.0.2:9'],
    ['http on the any address', 'http://0.0.0.0:9'],
    ['another scheme', 'ftp://127.0.0.1:9'],
    ['an upper-case scheme', 'HTTPS://example.com'],
    ['an https path', 'https://partner.steam-api.com/'],
    ['a leading space', ' https://example.com'],
    ['an empty string', ''],
    ['something that is not a URL', 'not a url'],
  ])('a baseUrl with %s throws TypeError', (_name, baseUrl) => {
    expect(() =>
      createSteamWebApi({
        config: { profile: 'production', steam: { appId: GAME_APP_ID } },
        env: { [PUBLISHER_KEY_SETTING]: 'INTERNAL_SECRET_publisher_key_acs8' },
        log: ignore,
        baseUrl,
      }),
    ).toThrow(TypeError);
  });

  test.each([
    'https://example.com',
    'https://partner.steam-api.com',
    'http://127.0.0.1:9',
    'http://localhost:9',
    'http://localhost',
    'http://[::1]:9',
  ])('the bare origin %s is a baseUrl', (baseUrl) => {
    expect(() =>
      createSteamWebApi({
        config: { profile: 'production', steam: { appId: GAME_APP_ID } },
        env: { [PUBLISHER_KEY_SETTING]: 'INTERNAL_SECRET_publisher_key_acs8' },
        log: ignore,
        baseUrl,
      }),
    ).not.toThrow();
  });

  test.each([
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['2147483648', 2_147_483_648],
  ])('a timeoutMs of %s throws TypeError', (_name, timeoutMs) => {
    expect(() =>
      createSteamWebApi({
        config: { profile: 'production', steam: { appId: GAME_APP_ID } },
        env: { [PUBLISHER_KEY_SETTING]: 'INTERNAL_SECRET_publisher_key_acs8' },
        log: ignore,
        timeoutMs,
      }),
    ).toThrow(TypeError);
  });

  test.each([1, 2_147_483_647])('a timeoutMs of %i is accepted', (timeoutMs) => {
    expect(() =>
      createSteamWebApi({
        config: { profile: 'production', steam: { appId: GAME_APP_ID } },
        env: { [PUBLISHER_KEY_SETTING]: 'INTERNAL_SECRET_publisher_key_acs8' },
        log: ignore,
        timeoutMs,
      }),
    ).not.toThrow();
  });
});

describe('a dev profile never asks Steam about ownership', () => {
  test.each([
    ['with a web key', true],
    ['without a key', false],
  ])('checkAppOwnership %s is unconfigured, sends nothing and logs nothing acs-8.6', async (_name, key) => {
    const c = await client('dev', { key });
    c.stub.setOwnership(PLAYER, owner(PLAYER));
    const error = failureOf(await c.api.checkAppOwnership(PLAYER));
    expect(error.reason).toBe('unconfigured');
    expect(c.stub.requests).toEqual([]);
    expect(c.lines).toEqual([]);
  });

  test('authenticateTicket with no web key is unconfigured, sends nothing and logs nothing acs-8.6', async () => {
    const c = await client('dev', { key: false });
    const result = await c.api.authenticateTicket(c.stub.issueTicket(PLAYER, IDENTITY), IDENTITY);
    expect(failureOf(result).reason).toBe('unconfigured');
    expect(c.stub.requests).toEqual([]);
    expect(c.lines).toEqual([]);
  });
});

/** The store's adapter, noting the model of every read. */
function watched(store: AccountStore): {
  readonly adapter: (model: string) => Adapter;
  readonly reads: string[];
} {
  const reads: string[] = [];
  const adapter = (model: string): Adapter => {
    const inner = store.adapter(model);
    return {
      ...inner,
      find: (id) => {
        reads.push(model);
        return inner.find(id);
      },
      findByUid: (uid) => {
        reads.push(model);
        return inner.findByUid(uid);
      },
      findByUserCode: (userCode) => {
        reads.push(model);
        return inner.findByUserCode(userCode);
      },
    };
  };
  return { adapter, reads };
}

describe('the decision end to end over the real client, store and stub', () => {
  test.each([
    'local-dev',
    'hosted-dev',
  ] as const)('on %s the flag alone decides and the stub receives no ownership request acs-8.6', async (profile) => {
    const c = await client('dev', { profile });
    const store = openStore();
    const list = denyList(store.adapter);
    const accounts = steamAccounts(store.adapter);
    await accounts.setEntitled(PLAYER, true);
    c.stub.setOwnership(PLAYER, { ...owner(PLAYER), ownsapp: false });
    c.stub.setOwnership(OTHER, owner(OTHER));
    const decide = steamEntitlementSource({
      profile,
      denied: (steamId) => list.has(steamId),
      devFlag: (steamId) => accounts.entitled(steamId),
      checkAppOwnership: (steamId) => c.api.checkAppOwnership(steamId),
    });
    expect(await decide(PLAYER)).toStrictEqual({ entitled: true });
    expect(await decide(OTHER)).toStrictEqual({ entitled: false, reason: 'not-owned' });
    expect(c.stub.requests.filter((sent) => sent.path === OWN_PATH)).toEqual([]);
    expect(c.stub.requests).toEqual([]);
    expect(c.lines).toEqual([]);
  });

  test('on production Steam decides with one request each, and the flag record is never read acs-8.6', async () => {
    const c = await client('production');
    const store = openStore();
    const w = watched(store);
    const list = denyList(w.adapter);
    const accounts = steamAccounts(w.adapter);
    await accounts.setEntitled(OTHER, true);
    c.stub.setOwnership(PLAYER, owner(PLAYER));

    // Which models each record store reads, measured alone.
    w.reads.length = 0;
    await list.has(PLAYER);
    const denyModels = new Set(w.reads);
    w.reads.length = 0;
    await accounts.entitled(PLAYER);
    const flagModels = new Set(w.reads);
    expect(flagModels.size, 'the flag is read through the store').toBeGreaterThan(0);
    for (const model of flagModels) expect(denyModels.has(model)).toBe(false);

    const decide = steamEntitlementSource({
      profile: 'production',
      denied: (steamId) => list.has(steamId),
      devFlag: (steamId) => accounts.entitled(steamId),
      checkAppOwnership: (steamId) => c.api.checkAppOwnership(steamId),
    });
    w.reads.length = 0;
    const ownership = (): SteamStubRequest[] =>
      c.stub.requests.filter((sent) => sent.path === OWN_PATH);
    expect(await decide(PLAYER)).toStrictEqual({ entitled: true });
    expect(ownership()).toHaveLength(1);
    expect(await decide(OTHER)).toStrictEqual({ entitled: false, reason: 'not-owned' });
    expect(ownership().map((sent) => sent.query.get('steamid'))).toEqual([PLAYER, OTHER]);
    for (const model of w.reads) expect(flagModels.has(model)).toBe(false);
    expect(c.lines).toEqual([]);
  });
});
