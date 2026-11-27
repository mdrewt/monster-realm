import { createHash } from 'node:crypto';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type SteamStub,
  type SteamStubAnswer,
  type SteamStubRequest,
  startSteamStub,
} from '../../test-util/steamStub.ts';
import { denyList, steamAccounts } from '../denyList.ts';
import {
  type OwnershipCheck,
  parseSteamId,
  type SteamEntitlement,
  type SteamId,
  steamEntitlementSource,
  steamSubject,
} from '../steam/ownership.ts';
import { type AccountStore, openAccountStore } from '../store/sqliteAdapter.ts';
import {
  STEAM_NONCE_WINDOW_SECONDS,
  STEAM_OPENID_ENDPOINT,
  steamOpenIdStep,
} from './steamOpenId.ts';

type Step = ReturnType<typeof steamOpenIdStep>;
type StepOptions = Parameters<typeof steamOpenIdStep>[0];

interface Write {
  readonly model: string;
  readonly id: string;
  readonly payload: AdapterPayload;
  readonly expiresIn: number | undefined;
}

const REALM = 'http://localhost:4455';
const UID = 'kq3Vx9_ZpL-02mNbT8rYcWd';
const STATE = createHash('sha256').update('one sign-in').digest('base64url');
const OTHER_STATE = createHash('sha256').update('another sign-in').digest('base64url');
const RETURN_TO = `${REALM}/interaction/${UID}/steam?state=${STATE}`;
const EXPECTED = { returnTo: RETURN_TO, state: STATE } as const;
const PLAYER = '76561197960287930';
const OTHER_PLAYER = '76561198000000042';
const NS = 'http://specs.openid.net/auth/2.0';
const SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const STEAM_LOGIN = 'https://steamcommunity.com/openid/login';
const STEAM_SIGNED = 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle';
const REQUIRED_SIGNED = [
  'op_endpoint',
  'claimed_id',
  'identity',
  'return_to',
  'response_nonce',
  'assoc_handle',
] as const;
const FORWARDED_NAMES = [
  'openid.assoc_handle',
  'openid.claimed_id',
  'openid.identity',
  'openid.mode',
  'openid.ns',
  'openid.op_endpoint',
  'openid.response_nonce',
  'openid.return_to',
  'openid.sig',
  'openid.signed',
];
const KV_TYPE = { 'content-type': 'text/plain;charset=utf-8' };
const VALID_ANSWER = `ns:${NS}\nis_valid:true\n`;
const INVALID_ANSWER = `ns:${NS}\nis_valid:false\n`;
const T0 = Date.parse('2026-11-27T12:00:00Z');
const T0_NONCE = '2026-11-27T12:00:00Z';
const SHORT_TIMEOUT_MS = 200;
const REASONS = ['timeout', 'unreachable', 'status', 'malformed'] as const;
const ECHO = 'echo7Hq2LwVb';
const VISIBLE_ASCII = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)).join('');

function claimed(steamId: string): string {
  return `https://steamcommunity.com/openid/id/${steamId}`;
}

function fullwidth(digits: string): string {
  return Array.from(digits, (digit) => String.fromCharCode(0xff10 + Number(digit))).join('');
}

function word(text: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9])${text}($|[^A-Za-z0-9])`);
}

let stub: SteamStub;
let store: AccountStore;
let writes: Write[];
let asked: string[];
let lines: string[];
let extraStubs: SteamStub[];
let decision: (steamId: SteamId) => Promise<SteamEntitlement>;
let storeFault: { readonly on: 'upsert' | 'find'; readonly error: Error } | undefined;
/** Runs around each read of the SteamNonce model: `before` ahead of the inner read, `after` once it answered. */
let nonceRead: { readonly before?: () => void; readonly after?: () => Promise<void> } | undefined;

function adapter(model: string): Adapter {
  const inner = store.adapter(model);
  return {
    ...inner,
    async upsert(id, payload, expiresIn) {
      writes.push({ model, id, payload, expiresIn });
      if (storeFault?.on === 'upsert') throw storeFault.error;
      return inner.upsert(id, payload, expiresIn);
    },
    async find(id) {
      if (storeFault?.on === 'find') throw storeFault.error;
      const around = model === 'SteamNonce' ? nonceRead : undefined;
      around?.before?.();
      const found = await inner.find(id);
      await around?.after?.();
      return found;
    },
  };
}

function entitlement(steamId: SteamId): Promise<SteamEntitlement> {
  asked.push(steamId);
  return decision(steamId);
}

function makeStep(options: Partial<StepOptions> = {}): Step {
  return steamOpenIdStep({
    realm: REALM,
    adapter,
    entitlement,
    log: (line) => {
      lines.push(line);
    },
    endpoint: stub.openIdEndpoint,
    ...options,
  });
}

/** Steam's reply for `step`'s login address, as the query the browser brings back. */
function replyFor(
  step: Step,
  options: {
    readonly change?: Readonly<Record<string, string>>;
    readonly steamId?: string;
    readonly returnTo?: string;
  } = {},
): URLSearchParams {
  const address = stub.openIdReply(
    step.loginUrl(options.returnTo ?? RETURN_TO),
    options.steamId ?? PLAYER,
    options.change,
  );
  return new URL(address).searchParams;
}

function posts(of: SteamStub = stub): SteamStubRequest[] {
  return of.requests.filter((request) => request.path === '/openid/login');
}

function postedBody(index = 0): URLSearchParams {
  return new URLSearchParams(posts()[index]!.body);
}

function nonceWrites(): Write[] {
  return writes.filter((write) => write.model === 'SteamNonce');
}

/** Everything a completion left behind, in one value so a failure shows all of it. */
function aftermath(outcome: unknown) {
  return {
    outcome,
    asked: [...asked],
    posts: posts().length,
    stored: writes.length,
    lines: [...lines],
  };
}

const REFUSED_HERE = { outcome: { kind: 'refused' }, asked: [], posts: 0, stored: 0, lines: [] };
const REFUSED_BY_STEAM = {
  outcome: { kind: 'refused' },
  asked: [],
  posts: 1,
  stored: 0,
  lines: [],
};

function setNow(iso: string): void {
  vi.setSystemTime(Date.parse(iso));
}

function answering(answer: SteamStubAnswer): void {
  stub.respondNext('CheckAuthentication', answer);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  stub = await startSteamStub();
  store = openAccountStore(':memory:');
  writes = [];
  asked = [];
  lines = [];
  extraStubs = [];
  storeFault = undefined;
  decision = async () => ({ entitled: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([stub.close(), ...extraStubs.map((other) => other.close())]);
  store.close();
});

describe('the exported constants', () => {
  test("Steam's OpenID address is https://steamcommunity.com/openid/login", () => {
    expect(STEAM_OPENID_ENDPOINT).toBe('https://steamcommunity.com/openid/login');
  });

  test('the nonce window is 300 seconds', () => {
    expect(STEAM_NONCE_WINDOW_SECONDS).toBe(300);
  });
});

describe('loginUrl', () => {
  test('is the endpoint with exactly the six checkid_setup parameters, each once', () => {
    const url = new URL(makeStep().loginUrl(RETURN_TO));
    expect(`${url.origin}${url.pathname}`).toBe(stub.openIdEndpoint);
    expect(url.hash).toBe('');
    const names = [...url.searchParams.keys()];
    expect(names.sort()).toEqual(
      [
        'openid.claimed_id',
        'openid.identity',
        'openid.mode',
        'openid.ns',
        'openid.realm',
        'openid.return_to',
      ].sort(),
    );
    expect(url.searchParams.getAll('openid.ns')).toEqual(['http://specs.openid.net/auth/2.0']);
    expect(url.searchParams.getAll('openid.mode')).toEqual(['checkid_setup']);
    expect(url.searchParams.getAll('openid.return_to')).toEqual([RETURN_TO]);
    expect(url.searchParams.getAll('openid.realm')).toEqual([REALM]);
    expect(url.searchParams.getAll('openid.identity')).toEqual([
      'http://specs.openid.net/auth/2.0/identifier_select',
    ]);
    expect(url.searchParams.getAll('openid.claimed_id')).toEqual([
      'http://specs.openid.net/auth/2.0/identifier_select',
    ]);
  });

  test('without an endpoint it sends players to https://steamcommunity.com/openid/login', () => {
    const step = steamOpenIdStep({
      realm: REALM,
      adapter,
      entitlement,
      log: (line) => {
        lines.push(line);
      },
    });
    const address = step.loginUrl(RETURN_TO);
    expect(address.startsWith('https://steamcommunity.com/openid/login?')).toBe(true);
    const url = new URL(address);
    expect(`${url.origin}${url.pathname}`).toBe(STEAM_LOGIN);
    expect(url.searchParams.get('openid.return_to')).toBe(RETURN_TO);
  });

  test('carries a return address with reserved characters through unchanged', () => {
    const returnTo = `${REALM}/interaction/${UID}/steam?state=a+b/c%20d&e=f#g`;
    const url = new URL(makeStep().loginUrl(returnTo));
    expect(url.searchParams.getAll('openid.return_to')).toEqual([returnTo]);
    expect(url.hash).toBe('');
  });

  test('the realm is the origin the step was built with', () => {
    const realm = 'https://accounts.example.test';
    const url = new URL(makeStep({ realm }).loginUrl(`${realm}/interaction/${UID}/steam?state=x`));
    expect(url.searchParams.getAll('openid.realm')).toEqual([realm]);
  });

  test('is pure: the same address twice, nothing sent and nothing stored', () => {
    const step = makeStep();
    expect(step.loginUrl(RETURN_TO)).toBe(step.loginUrl(RETURN_TO));
    expect(stub.requests).toEqual([]);
    expect(writes).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('the endpoint option', () => {
  test.each([
    ["Steam's own address", 'https://steamcommunity.com/openid/login'],
    ['another https address', 'https://openid.example.test/openid/login'],
    ['http on localhost', 'http://localhost:8080/openid/login'],
    ['http on 127.0.0.1', 'http://127.0.0.1:9/openid/login'],
    ['http on [::1]', 'http://[::1]:9/openid/login'],
  ])('%s is accepted and is where players are sent', (_name, endpoint) => {
    const url = new URL(makeStep({ endpoint }).loginUrl(RETURN_TO));
    expect(`${url.origin}${url.pathname}`).toBe(endpoint);
  });

  test("the stub's address is accepted", () => {
    expect(() => makeStep({ endpoint: stub.openIdEndpoint })).not.toThrow();
  });

  test.each([
    ['a host that begins with localhost', 'http://localhost.evil.test/openid/login'],
    ['http on another host', 'http://openid.example.test/openid/login'],
    ['http on another loopback address', 'http://127.0.0.2/openid/login'],
    ['http on an address spelt in hex', 'http://0x7f.0.0.1/openid/login'],
    ['http on an upper-case localhost', 'http://LOCALHOST/openid/login'],
    ['a user before the host', 'http://localhost@evil.test/openid/login'],
    ['a user and a password', 'https://user:pw@openid.example.test/openid/login'],
    ['a query', 'https://openid.example.test/openid/login?x=1'],
    ['a fragment', 'https://openid.example.test/openid/login#f'],
    ['an upper-case scheme and host', 'HTTPS://OPENID.EXAMPLE.TEST/openid/login'],
    ['the default port written out', 'https://openid.example.test:443/openid/login'],
    ['a dot segment', 'https://openid.example.test/x/../openid/login'],
    ['a leading space', ' https://openid.example.test/openid/login'],
    ['another scheme', 'ftp://openid.example.test/openid/login'],
    ['text that is not a URL', 'not a url'],
    ['an empty string', ''],
  ])('%s throws a TypeError when the step is built', (_name, endpoint) => {
    expect(() => makeStep({ endpoint })).toThrow(TypeError);
  });
});

describe('a valid reply', () => {
  test('an entitled player signs in as steam:<steamid64>, the subject the ticket grant issues acs-10.4', async () => {
    const step = makeStep();
    const outcome = await step.complete(replyFor(step), EXPECTED);
    expect(outcome).toEqual({ kind: 'signed-in', sub: 'steam:76561197960287930' });
    expect(outcome).toEqual({ kind: 'signed-in', sub: steamSubject(parseSteamId(PLAYER)!) });
  });

  test('the subject is the SteamID the claimed id names acs-10.4', async () => {
    const step = makeStep();
    const outcome = await step.complete(replyFor(step, { steamId: OTHER_PLAYER }), EXPECTED);
    expect(outcome).toEqual({ kind: 'signed-in', sub: `steam:${OTHER_PLAYER}` });
    expect(asked).toEqual([OTHER_PLAYER]);
  });

  test('asks the entitlement source once, about the captured SteamID', async () => {
    const step = makeStep();
    await step.complete(replyFor(step), EXPECTED);
    expect(asked).toEqual([PLAYER]);
  });

  test('sends one POST to the endpoint path, with no query, as a form', async () => {
    const step = makeStep();
    await step.complete(replyFor(step), EXPECTED);
    expect(posts()).toHaveLength(1);
    expect(stub.requests).toHaveLength(1);
    const post = posts()[0]!;
    expect(post.method).toBe('POST');
    expect(post.target).toBe('/openid/login');
    const type = String(post.headers['content-type'] ?? '');
    expect(type.split(';', 1)[0]!.trim().toLowerCase()).toBe('application/x-www-form-urlencoded');
  });

  test('the POST holds exactly the contract names, each once', async () => {
    const step = makeStep();
    await step.complete(replyFor(step), EXPECTED);
    const names = [...postedBody().keys()];
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([...FORWARDED_NAMES].sort());
  });

  test('the POST sends the mode as check_authentication', async () => {
    const step = makeStep();
    await step.complete(replyFor(step), EXPECTED);
    expect(postedBody().getAll('openid.mode')).toEqual(['check_authentication']);
  });

  test('the POST carries the values the reply carried', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    await step.complete(reply, EXPECTED);
    const body = postedBody();
    for (const name of FORWARDED_NAMES) {
      if (name === 'openid.mode') continue;
      expect(body.getAll(name), name).toEqual([reply.get(name)!]);
    }
  });

  test('a nonce holding + / and = reaches Steam unchanged', async () => {
    const step = makeStep();
    const nonce = `${T0_NONCE}a+b/c=d`;
    const outcome = await step.complete(
      replyFor(step, { change: { response_nonce: nonce } }),
      EXPECTED,
    );
    expect(postedBody().getAll('openid.response_nonce')).toEqual([nonce]);
    expect(outcome).toEqual({ kind: 'signed-in', sub: `steam:${PLAYER}` });
  });

  test('a parameter the signed list does not name is not sent, and the reply still signs in', async () => {
    const step = makeStep();
    const reply = replyFor(step, { change: { extra: ECHO } });
    reply.append('utm_source', ECHO);
    const outcome = await step.complete(reply, EXPECTED);
    expect(outcome).toEqual({ kind: 'signed-in', sub: `steam:${PLAYER}` });
    const body = postedBody();
    expect(body.has('openid.extra')).toBe(false);
    expect(body.has('utm_source')).toBe(false);
    expect(body.has('state')).toBe(false);
    expect(posts()[0]!.body).not.toContain(ECHO);
  });

  test('a signed list of the six names without signed itself is accepted', async () => {
    const step = makeStep();
    const outcome = await step.complete(
      replyFor(step, { change: { signed: REQUIRED_SIGNED.join(',') } }),
      EXPECTED,
    );
    expect(outcome).toEqual({ kind: 'signed-in', sub: `steam:${PLAYER}` });
    expect([...postedBody().keys()].sort()).toEqual([...FORWARDED_NAMES].sort());
  });

  test('a signed list that also names ns sends ns once', async () => {
    const step = makeStep();
    const outcome = await step.complete(
      replyFor(step, { change: { signed: `${STEAM_SIGNED},ns` } }),
      EXPECTED,
    );
    expect(postedBody().getAll('openid.ns')).toEqual([NS]);
    expect(outcome).toEqual({ kind: 'signed-in', sub: `steam:${PLAYER}` });
  });

  test('a signed list that names an extra field sends that field once with its value', async () => {
    const step = makeStep();
    const outcome = await step.complete(
      replyFor(step, { change: { extra: 'x1', signed: `${STEAM_SIGNED},extra` } }),
      EXPECTED,
    );
    expect(postedBody().getAll('openid.extra')).toEqual(['x1']);
    expect(outcome).toEqual({ kind: 'signed-in', sub: `steam:${PLAYER}` });
  });

  test('a signed list that names mode still sends the mode once, as check_authentication', async () => {
    const step = makeStep();
    await step.complete(replyFor(step, { change: { signed: `${STEAM_SIGNED},mode` } }), EXPECTED);
    expect(postedBody().getAll('openid.mode')).toEqual(['check_authentication']);
  });

  test('stores one SteamNonce record and nothing else', async () => {
    const step = makeStep();
    await step.complete(replyFor(step), EXPECTED);
    expect(nonceWrites()).toHaveLength(1);
    expect(writes).toHaveLength(1);
    const record = await store.adapter('SteamNonce').find(nonceWrites()[0]!.id);
    expect(record).toBeDefined();
  });

  test('writes no log line', async () => {
    const step = makeStep();
    await step.complete(replyFor(step), EXPECTED);
    expect(lines).toEqual([]);
  });

  test('two replies of the same second are two nonces: both sign in', async () => {
    const step = makeStep();
    const first = replyFor(step);
    const second = replyFor(step);
    expect(first.get('openid.response_nonce')!.slice(0, 20)).toBe(T0_NONCE);
    expect(second.get('openid.response_nonce')!.slice(0, 20)).toBe(T0_NONCE);
    expect(await step.complete(first, EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
    expect(await step.complete(second, EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
    expect(nonceWrites()).toHaveLength(2);
  });

  test('two different replies completed in parallel both sign in', async () => {
    const step = makeStep();
    const outcomes = await Promise.all([
      step.complete(replyFor(step), EXPECTED),
      step.complete(replyFor(step), EXPECTED),
    ]);
    expect(outcomes).toEqual([
      { kind: 'signed-in', sub: `steam:${PLAYER}` },
      { kind: 'signed-in', sub: `steam:${PLAYER}` },
    ]);
  });

  test("Steam's answer may carry other keys, in any order", async () => {
    const step = makeStep();
    answering({
      kind: 'body',
      body: `invalidate_handle:${ECHO}\nis_valid:true\nns:${NS}\n`,
      headers: KV_TYPE,
    });
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
  });

  test("Steam's answer of exactly 64 KiB is read", async () => {
    const step = makeStep();
    const padding = 65_536 - Buffer.byteLength(VALID_ANSWER) - 'pad:\n'.length;
    const body = `${VALID_ANSWER}pad:${'a'.repeat(padding)}\n`;
    expect(Buffer.byteLength(body)).toBe(65_536);
    answering({ kind: 'body', body, headers: KV_TYPE });
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
  });
});

describe('is_valid:false: Steam does not vouch for the reply', () => {
  test('a signature changed after signing ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    const sig = reply.get('openid.sig')!;
    reply.set('openid.sig', `${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`);
    expect(reply.get('openid.sig')).not.toBe(sig);
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_BY_STEAM);
  });

  test('a field changed after signing ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.set('openid.assoc_handle', '1');
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_BY_STEAM);
  });

  test('Steam answering is_valid:false ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    answering({ kind: 'body', body: INVALID_ANSWER, headers: KV_TYPE });
    expect(aftermath(await step.complete(replyFor(step), EXPECTED))).toEqual(REFUSED_BY_STEAM);
  });

  test('a reply Steam answered is_valid:false is stored nowhere acs-10.2', async () => {
    const step = makeStep();
    answering({ kind: 'body', body: INVALID_ANSWER, headers: KV_TYPE });
    await step.complete(replyFor(step), EXPECTED);
    expect(writes).toEqual([]);
  });
});

describe('another endpoint', () => {
  const others: ReadonlyArray<readonly [string, (endpoint: string) => string]> = [
    ["Steam's own address", () => 'https://steamcommunity.com/openid/login'],
    ['the endpoint with a trailing slash', (endpoint) => `${endpoint}/`],
    ['the endpoint with a query', (endpoint) => `${endpoint}?x=1`],
    ['a prefix of the endpoint', (endpoint) => endpoint.slice(0, -1)],
    ['the endpoint under localhost', (endpoint) => endpoint.replace('127.0.0.1', 'localhost')],
    [
      'the endpoint on another port',
      (endpoint) => {
        const url = new URL(endpoint);
        url.port = String(Number(url.port) === 65_535 ? 1 : Number(url.port) + 1);
        return url.href;
      },
    ],
    ['the endpoint over https', (endpoint) => endpoint.replace('http:', 'https:')],
    ['another host with the same path', () => 'http://evil.test/openid/login'],
    ['the endpoint as a suffix of a longer path', (endpoint) => `${endpoint}/../login`],
    ['an upper-case scheme', (endpoint) => endpoint.replace('http:', 'HTTP:')],
    ['an empty value', () => ''],
  ];

  test.each(others)('an op_endpoint of %s ends the sign-in acs-10.2', async (_name, other) => {
    const step = makeStep();
    const reply = replyFor(step, { change: { op_endpoint: other(stub.openIdEndpoint) } });
    expect(reply.get('openid.op_endpoint')).not.toBe(stub.openIdEndpoint);
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('a reply naming a second listener reaches neither listener acs-10.2', async () => {
    const second = await startSteamStub();
    extraStubs.push(second);
    const step = makeStep();
    const reply = replyFor(step, { change: { op_endpoint: second.openIdEndpoint } });
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
    expect(second.requests).toEqual([]);
  });

  test('a reply without an op_endpoint ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.delete('openid.op_endpoint');
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });
});

describe('another return_to', () => {
  const returnTos: ReadonlyArray<readonly [string, string]> = [
    ['a trailing &x=1', `${RETURN_TO}&x=1`],
    ['a prefix of ours', RETURN_TO.slice(0, -1)],
    ['ours without its query', `${REALM}/interaction/${UID}/steam`],
    [
      'another uid with the same state',
      `${REALM}/interaction/Zz9Yy8Xx7Ww6Vv5Uu4Tt3/steam?state=${STATE}`,
    ],
    ['another state', `${REALM}/interaction/${UID}/steam?state=${OTHER_STATE}`],
    ['another scheme', RETURN_TO.replace('http://', 'https://')],
    ['another host', RETURN_TO.replace('localhost', '127.0.0.1')],
    ['another port', RETURN_TO.replace(':4455', ':4456')],
    ['an upper-case host', RETURN_TO.replace('localhost', 'LOCALHOST')],
    ['a trailing slash on the path', `${REALM}/interaction/${UID}/steam/?state=${STATE}`],
    ['a fragment', `${RETURN_TO}#x`],
    ['ours twice', `${RETURN_TO}${RETURN_TO}`],
    ['a percent-encoded letter in the path', `${REALM}/interaction/${UID}/%73team?state=${STATE}`],
    ['an empty value', ''],
  ];

  test.each(returnTos)('a return_to with %s ends the sign-in acs-10.2', async (_name, returnTo) => {
    const step = makeStep();
    const reply = replyFor(step, { change: { return_to: returnTo } });
    expect(reply.get('state')).toBe(STATE);
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('a reply without a return_to ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.delete('openid.return_to');
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test("a reply to another sign-in's callback is refused for this one acs-10.2", async () => {
    const step = makeStep();
    const elsewhere = `${REALM}/interaction/Zz9Yy8Xx7Ww6Vv5Uu4Tt3/steam?state=${OTHER_STATE}`;
    const reply = replyFor(step, { returnTo: elsewhere });
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });
});

describe('a mismatched state', () => {
  const states: ReadonlyArray<readonly [string, (reply: URLSearchParams) => void]> = [
    [
      "another sign-in's state",
      (reply) => {
        reply.set('state', OTHER_STATE);
      },
    ],
    [
      'no state',
      (reply) => {
        reply.delete('state');
      },
    ],
    [
      'an empty state',
      (reply) => {
        reply.set('state', '');
      },
    ],
    [
      'a prefix of the state',
      (reply) => {
        reply.set('state', STATE.slice(0, -1));
      },
    ],
    [
      'the state with a character more',
      (reply) => {
        reply.set('state', `${STATE}A`);
      },
    ],
    [
      'the state in upper case',
      (reply) => {
        reply.set(
          'state',
          STATE.toUpperCase() === STATE ? STATE.toLowerCase() : STATE.toUpperCase(),
        );
      },
    ],
    [
      'the uid for the state',
      (reply) => {
        reply.set('state', UID);
      },
    ],
    [
      'the right state twice',
      (reply) => {
        reply.append('state', STATE);
      },
    ],
    [
      'a wrong state after the right one',
      (reply) => {
        reply.append('state', OTHER_STATE);
      },
    ],
    [
      'a wrong state before the right one',
      (reply) => {
        reply.delete('state');
        reply.append('state', OTHER_STATE);
        reply.append('state', STATE);
      },
    ],
  ];

  test.each(states)('a reply with %s ends the sign-in acs-10.2', async (_name, alter) => {
    const step = makeStep();
    const reply = replyFor(step);
    alter(reply);
    expect(reply.get('openid.return_to')).toBe(RETURN_TO);
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('a reply checked against another expected state ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const outcome = await step.complete(replyFor(step), {
      returnTo: RETURN_TO,
      state: OTHER_STATE,
    });
    expect(aftermath(outcome)).toEqual(REFUSED_HERE);
  });
});

describe('a malformed claimed id', () => {
  const claimedIds: ReadonlyArray<readonly [string, string]> = [
    ['16 digits', claimed(PLAYER.slice(1))],
    ['18 digits', claimed(`${PLAYER}0`)],
    ['a trailing newline', `${claimed(PLAYER)}\n`],
    ['a line before it', `https://evil.test/\n${claimed(PLAYER)}`],
    ['a line after it', `${claimed(PLAYER)}\nhttps://evil.test/`],
    ['fullwidth digits', claimed(fullwidth(PLAYER))],
    ['http', `http://steamcommunity.com/openid/id/${PLAYER}`],
    ['a www host', `https://www.steamcommunity.com/openid/id/${PLAYER}`],
    ['a trailing slash', `${claimed(PLAYER)}/`],
    ['a prefix before https', `x${claimed(PLAYER)}`],
    ['a space before it', ` ${claimed(PLAYER)}`],
    ['a space after it', `${claimed(PLAYER)} `],
    [
      'a longer host ending in the name',
      `https://steamcommunity.com.evil.test/openid/id/${PLAYER}`,
    ],
    ['any character for the dot', `https://steamcommunityxcom/openid/id/${PLAYER}`],
    ['an upper-case host', `https://STEAMCOMMUNITY.COM/openid/id/${PLAYER}`],
    ['a port', `https://steamcommunity.com:443/openid/id/${PLAYER}`],
    ['a query', `${claimed(PLAYER)}?x=1`],
    ['a fragment', `${claimed(PLAYER)}#x`],
    ['a user part', `https://someone@steamcommunity.com/openid/id/${PLAYER}`],
    ['a dot segment', `https://steamcommunity.com/openid/x/../id/${PLAYER}`],
    ['a letter among the digits', claimed(`${PLAYER.slice(0, -1)}x`)],
    ['a sign before the digits', claimed(`+${PLAYER.slice(1)}`)],
    ['the identifier_select value', SELECT],
    ['an empty value', ''],
  ];

  test.each(claimedIds)('a claimed id with %s ends the sign-in acs-10.2', async (_name, value) => {
    const step = makeStep();
    const reply = replyFor(step, { change: { claimed_id: value, identity: value } });
    expect(reply.get('openid.claimed_id')).toBe(value);
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('an identity naming another player ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step, { change: { identity: claimed(OTHER_PLAYER) } });
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('an identity that differs from the claimed id by a trailing slash ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step, { change: { identity: `${claimed(PLAYER)}/` } });
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('a reply without an identity ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.delete('openid.identity');
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('a reply without a claimed id ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.delete('openid.claimed_id');
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });
});

describe('a reused nonce', () => {
  test('the same reply completed twice is refused the second time acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    expect(await step.complete(reply, EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'refused' });
    expect(asked).toEqual([PLAYER]);
    expect(nonceWrites()).toHaveLength(1);
  });

  test("a second reply signed over the first reply's nonce is refused acs-10.2", async () => {
    const step = makeStep();
    const first = replyFor(step);
    expect((await step.complete(first, EXPECTED)).kind).toBe('signed-in');
    const second = replyFor(step, {
      change: { response_nonce: first.get('openid.response_nonce')! },
    });
    expect(second.get('openid.sig')).not.toBe(first.get('openid.sig'));
    expect(await step.complete(second, EXPECTED)).toEqual({ kind: 'refused' });
    expect(asked).toEqual([PLAYER]);
  });

  test('of eight parallel completions of one reply exactly one signs in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => step.complete(new URLSearchParams(reply), EXPECTED)),
    );
    expect(outcomes.filter((outcome) => outcome.kind === 'signed-in')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'refused')).toHaveLength(7);
    expect(asked).toEqual([PLAYER]);
    expect(nonceWrites()).toHaveLength(1);
  });

  test('a replay in the last second the nonce is admitted is refused acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    expect((await step.complete(reply, EXPECTED)).kind).toBe('signed-in');
    vi.setSystemTime(T0 + 300_000);
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'refused' });
    expect(asked).toEqual([PLAYER]);
  });

  test('in that last second a fresh nonce of the same time still signs in', async () => {
    const step = makeStep();
    expect((await step.complete(replyFor(step), EXPECTED)).kind).toBe('signed-in');
    vi.setSystemTime(T0 + 300_000);
    const fresh = replyFor(step, { change: { response_nonce: `${T0_NONCE}fresh` } });
    expect(await step.complete(fresh, EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
  });

  test('a nonce dated 300 seconds ahead is still refused when replayed 600 seconds later acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step, { change: { response_nonce: '2026-11-27T12:05:00Zahead' } });
    expect((await step.complete(reply, EXPECTED)).kind).toBe('signed-in');
    vi.setSystemTime(T0 + 600_000);
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'refused' });
    expect(asked).toEqual([PLAYER]);
  });

  test('a nonce seen by one step is refused by another step over the same store acs-10.2', async () => {
    const reply = replyFor(makeStep());
    expect((await makeStep().complete(reply, EXPECTED)).kind).toBe('signed-in');
    expect(await makeStep().complete(reply, EXPECTED)).toEqual({ kind: 'refused' });
    expect(asked).toEqual([PLAYER]);
  });

  test('a replay Steam also refuses is refused acs-10.2', async () => {
    stub.refuseReplayedAssertions(true);
    const step = makeStep();
    const reply = replyFor(step);
    expect((await step.complete(reply, EXPECTED)).kind).toBe('signed-in');
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'refused' });
    expect(asked).toEqual([PLAYER]);
  });
});

describe('what spends a nonce', () => {
  const outages: ReadonlyArray<readonly [string, SteamStubAnswer]> = [
    ['a 500', { kind: 'status', status: 500, body: VALID_ANSWER, headers: KV_TYPE }],
    ['a closed connection', { kind: 'closed' }],
    ['a body that is not key-value form', { kind: 'body', body: '{}', headers: KV_TYPE }],
  ];

  test.each(
    outages,
  )('after %s the same reply still signs in once Steam answers', async (_name, answer) => {
    const step = makeStep();
    const reply = replyFor(step);
    answering(answer);
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'unavailable' });
    expect(writes).toEqual([]);
    expect(await step.complete(reply, EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
  });

  test('after Steam timed out the same reply still signs in once Steam answers', async () => {
    const step = makeStep({ timeoutMs: SHORT_TIMEOUT_MS });
    const reply = replyFor(step);
    answering({ kind: 'no-answer' });
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'unavailable' });
    expect(writes).toEqual([]);
    expect(await step.complete(reply, EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
  });

  test('a reply Steam vouched for is recorded when the player is not entitled acs-10.2', async () => {
    decision = async () => ({ entitled: false, reason: 'not-owned' });
    const step = makeStep();
    const reply = replyFor(step);
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'not-owned' });
    expect(nonceWrites()).toHaveLength(1);
    decision = async () => ({ entitled: true });
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'refused' });
    expect(asked).toEqual([PLAYER]);
  });

  test('a reply Steam vouched for is recorded when entitlement is unavailable acs-10.2', async () => {
    decision = async () => ({ entitled: false, reason: 'unavailable', error: new Error('down') });
    const step = makeStep();
    const reply = replyFor(step);
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'unavailable' });
    expect(nonceWrites()).toHaveLength(1);
    decision = async () => ({ entitled: true });
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'refused' });
  });

  test('a reply Steam vouched for is recorded when the entitlement source throws acs-10.2', async () => {
    const failure = new Error('the entitlement source failed');
    decision = async () => {
      throw failure;
    };
    const step = makeStep();
    const reply = replyFor(step);
    await expect(step.complete(reply, EXPECTED)).rejects.toBe(failure);
    expect(nonceWrites()).toHaveLength(1);
    decision = async () => ({ entitled: true });
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'refused' });
  });
});

describe('the shape of the reply', () => {
  const duplicated = [
    'openid.ns',
    'openid.mode',
    'openid.op_endpoint',
    'openid.claimed_id',
    'openid.identity',
    'openid.return_to',
    'openid.response_nonce',
    'openid.assoc_handle',
    'openid.signed',
    'openid.sig',
  ];

  test.each(
    duplicated,
  )('%s given twice with the same value ends the sign-in acs-10.2', async (name) => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.append(name, reply.get(name)!);
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('a second claimed id naming another player ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.append('openid.claimed_id', claimed(OTHER_PLAYER));
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('a claimed id of another player before ours ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step, { steamId: OTHER_PLAYER });
    const own = reply.get('openid.claimed_id')!;
    reply.delete('openid.claimed_id');
    reply.append('openid.claimed_id', claimed(PLAYER));
    reply.append('openid.claimed_id', own);
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('a second sig ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.append('openid.sig', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test.each([
    ['OpenID 1.1', 'http://openid.net/signon/1.1'],
    ['a trailing slash', `${NS}/`],
    ['https', NS.replace('http:', 'https:')],
    ['an empty value', ''],
  ])('a namespace of %s ends the sign-in acs-10.2', async (_name, ns) => {
    const step = makeStep();
    expect(aftermath(await step.complete(replyFor(step, { change: { ns } }), EXPECTED))).toEqual(
      REFUSED_HERE,
    );
  });

  test('a reply without a namespace ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.delete('openid.ns');
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test.each([
    'cancel',
    'error',
    'check_authentication',
    'checkid_setup',
    'ID_RES',
    'id_res ',
    '',
  ])('a mode of %j ends the sign-in acs-10.2', async (mode) => {
    const step = makeStep();
    expect(aftermath(await step.complete(replyFor(step, { change: { mode } }), EXPECTED))).toEqual(
      REFUSED_HERE,
    );
  });

  test('a reply without a mode ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.delete('openid.mode');
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });
});

describe('the signed list', () => {
  test.each(
    REQUIRED_SIGNED,
  )('a signed list without %s ends the sign-in acs-10.2', async (missing) => {
    const step = makeStep();
    const signed = STEAM_SIGNED.split(',')
      .filter((name) => name !== missing)
      .join(',');
    expect(
      aftermath(await step.complete(replyFor(step, { change: { signed } }), EXPECTED)),
    ).toEqual(REFUSED_HERE);
  });

  test.each([
    ['a name twice', `${STEAM_SIGNED},claimed_id`],
    ['signed twice', `signed,${STEAM_SIGNED}`],
    ['a space after a comma', STEAM_SIGNED.replaceAll(',', ', ')],
    ['an empty name', `${STEAM_SIGNED},`],
    ['an empty list', ''],
    ['a name the reply does not carry', `${STEAM_SIGNED},invalidate_handle`],
  ])('a signed list with %s ends the sign-in acs-10.2', async (_name, signed) => {
    const step = makeStep();
    expect(
      aftermath(await step.complete(replyFor(step, { change: { signed } }), EXPECTED)),
    ).toEqual(REFUSED_HERE);
  });

  test.each([
    'openid.signed',
    'openid.sig',
    'openid.assoc_handle',
    'openid.response_nonce',
  ])('a reply without %s ends the sign-in acs-10.2', async (name) => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.delete(name);
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('an empty sig ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step);
    reply.set('openid.sig', '');
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });
});

describe('the nonce form', () => {
  test.each([
    ['a lower-case z', '2026-11-27T12:00:00zx'],
    ['a lower-case t', '2026-11-27t12:00:00Zx'],
    ['no Z', '2026-11-27T12:00:00x'],
    ['no Z and nothing after', '2026-11-27T12:00:00'],
    ['an offset', '2026-11-27T12:00:00+00:00x'],
    ['fractional seconds', '2026-11-27T12:00:00.000Zx'],
    ['a space for the T', '2026-11-27 12:00:00Zx'],
    ['no seconds', '2026-11-27T12:00Zx'],
    ['a six-digit year', '+002026-11-27T12:00:00Zx'],
    ['a date alone', '2026-11-27Zx'],
    ['a leading space', ` ${T0_NONCE}x`],
    ['a space in the suffix', `${T0_NONCE}a b`],
    ['a tab in the suffix', `${T0_NONCE}a\tb`],
    ['a newline in the suffix', `${T0_NONCE}a\nb`],
    ['a DEL in the suffix', `${T0_NONCE}a${String.fromCharCode(0x7f)}`],
    ['a letter outside ASCII in the suffix', `${T0_NONCE}${String.fromCharCode(0xe9)}`],
    ['236 characters after the time', `${T0_NONCE}${'a'.repeat(236)}`],
    ['epoch seconds', String(T0 / 1000)],
    ['an empty value', ''],
  ])('a nonce with %s ends the sign-in acs-10.2', async (_name, nonce) => {
    const step = makeStep();
    const reply = replyFor(step, { change: { response_nonce: nonce } });
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test.each([
    ['February 30th', '2026-02-30T12:00:00Zx', '2026-03-02T12:00:00Z'],
    ['November 31st', '2026-11-31T12:00:00Zx', '2026-12-01T12:00:00Z'],
    ['day 0', '2026-11-00T12:00:00Zx', '2026-10-31T12:00:00Z'],
    ['month 13', '2026-13-01T12:00:00Zx', '2027-01-01T12:00:00Z'],
    ['hour 25', '2026-11-27T25:00:00Zx', '2026-11-28T01:00:00Z'],
    ['minute 60', '2026-11-27T12:60:00Zx', '2026-11-27T13:00:00Z'],
    ['second 60', '2026-11-27T12:00:60Zx', '2026-11-27T12:01:00Z'],
  ])('a nonce dated %s ends the sign-in even at the instant it would roll over to acs-10.2', async (_name, nonce, now) => {
    const step = makeStep();
    const reply = replyFor(step, { change: { response_nonce: nonce } });
    setNow(now);
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test.each([
    ['nothing after the time', T0_NONCE],
    ['235 characters after the time', `${T0_NONCE}${'a'.repeat(235)}`],
    ['every visible ASCII character after the time', `${T0_NONCE}${VISIBLE_ASCII}`],
  ])('a nonce with %s is accepted', async (_name, nonce) => {
    const step = makeStep();
    const reply = replyFor(step, { change: { response_nonce: nonce } });
    expect(await step.complete(reply, EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
  });
});

describe('the nonce window of 300 seconds', () => {
  test('a nonce 300 seconds old is accepted', async () => {
    const step = makeStep();
    const reply = replyFor(step, { change: { response_nonce: '2026-11-27T11:55:00Zold' } });
    expect(await step.complete(reply, EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
  });

  test('a nonce 301 seconds old ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step, { change: { response_nonce: '2026-11-27T11:54:59Zold' } });
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('a nonce 300 seconds ahead is accepted', async () => {
    const step = makeStep();
    const reply = replyFor(step, { change: { response_nonce: '2026-11-27T12:05:00Zahead' } });
    expect(await step.complete(reply, EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
  });

  test('a nonce 301 seconds ahead ends the sign-in acs-10.2', async () => {
    const step = makeStep();
    const reply = replyFor(step, { change: { response_nonce: '2026-11-27T12:05:01Zahead' } });
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test("Steam's own nonce completed 300 seconds later is accepted", async () => {
    const step = makeStep();
    const reply = replyFor(step);
    vi.setSystemTime(T0 + 300_000);
    expect(await step.complete(reply, EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
  });

  test("Steam's own nonce completed 301 seconds later ends the sign-in acs-10.2", async () => {
    const step = makeStep();
    const reply = replyFor(step);
    vi.setSystemTime(T0 + 301_000);
    expect(aftermath(await step.complete(reply, EXPECTED))).toEqual(REFUSED_HERE);
  });

  test('the window is read from the injected clock acs-10.2', async () => {
    const t0 = T0 / 1000;
    const late = makeStep({ now: () => t0 + 301 });
    expect(aftermath(await late.complete(replyFor(late), EXPECTED))).toEqual(REFUSED_HERE);
    const onTime = makeStep({ now: () => t0 + 300 });
    expect(await onTime.complete(replyFor(onTime), EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
  });
});

describe("Steam's answer", () => {
  const unreadable: ReadonlyArray<readonly [string, string]> = [
    ['is_valid:true then is_valid:false', `ns:${NS}\nis_valid:true\nis_valid:false\n`],
    ['is_valid:false then is_valid:true', `ns:${NS}\nis_valid:false\nis_valid:true\n`],
    ['is_valid:true twice', `ns:${NS}\nis_valid:true\nis_valid:true\n`],
    ['a longer key ending in is_valid', `ns:${NS}\nxis_valid:true\n`],
    ['a space before the value', `ns:${NS}\nis_valid: true\n`],
    ['lines ended by CRLF', `ns:${NS}\r\nis_valid:true\r\n`],
    ['an upper-case TRUE', `ns:${NS}\nis_valid:TRUE\n`],
    ['a value of yes', `ns:${NS}\nis_valid:yes\n`],
    ['no is_valid line', `ns:${NS}\n`],
    ['no ns line', 'is_valid:true\n'],
    ['an ns of another value', 'ns:http://openid.net/signon/1.1\nis_valid:true\n'],
    ['ns twice', `ns:${NS}\nns:${NS}\nis_valid:true\n`],
    ['no line end after the last line', `ns:${NS}\nis_valid:true`],
    ['a line with no colon', `ns:${NS}\nis_valid:true\n${ECHO}\n`],
    ['an empty body', ''],
    ['a JSON body', '{"ns":"http://specs.openid.net/auth/2.0","is_valid":true}'],
    ['is_valid:true inside an HTML page', `<html><body>ns:${NS}\nis_valid:true\n</body></html>`],
  ];

  test.each(
    unreadable,
  )('a 200 body with %s is Steam not answering: no sign-in acs-10.2', async (_name, body) => {
    const step = makeStep();
    answering({ kind: 'body', body, headers: KV_TYPE });
    const outcome = await step.complete(replyFor(step), EXPECTED);
    expect({ outcome, asked, stored: writes.length, posts: posts().length }).toEqual({
      outcome: { kind: 'unavailable' },
      asked: [],
      stored: 0,
      posts: 1,
    });
  });

  test.each(unreadable)('a 200 body with %s logs one malformed line', async (_name, body) => {
    const step = makeStep();
    answering({ kind: 'body', body, headers: KV_TYPE });
    await step.complete(replyFor(step), EXPECTED);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(word('malformed'));
  });

  test('an answer one byte over 64 KiB is Steam not answering acs-10.2', async () => {
    const step = makeStep();
    const padding = 65_537 - Buffer.byteLength(VALID_ANSWER) - 'pad:\n'.length;
    const body = `${VALID_ANSWER}pad:${'a'.repeat(padding)}\n`;
    expect(Buffer.byteLength(body)).toBe(65_537);
    answering({ kind: 'body', body, headers: KV_TYPE });
    expect(aftermath(await step.complete(replyFor(step), EXPECTED)).outcome).toEqual({
      kind: 'unavailable',
    });
    expect(asked).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('a 70 KiB answer that says is_valid:true first is Steam not answering acs-10.2', async () => {
    const step = makeStep();
    answering({
      kind: 'body',
      body: `${VALID_ANSWER}pad:${'a'.repeat(70 * 1024)}\n`,
      headers: KV_TYPE,
    });
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({ kind: 'unavailable' });
    expect(asked).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('is_valid:false writes no log line', async () => {
    const step = makeStep();
    answering({ kind: 'body', body: INVALID_ANSWER, headers: KV_TYPE });
    await step.complete(replyFor(step), EXPECTED);
    expect(lines).toEqual([]);
  });
});

describe('Steam giving no answer', () => {
  interface Fault {
    readonly name: string;
    readonly answer: (endpoint: string) => SteamStubAnswer;
    /** The reason the one log line names; undefined where any of the four is right. */
    readonly reason?: (typeof REASONS)[number];
    readonly status?: number;
    readonly short?: boolean;
  }

  const faults: readonly Fault[] = [
    {
      name: 'a 500 whose body says is_valid:true',
      answer: () => ({
        kind: 'status',
        status: 500,
        statusText: ECHO,
        headers: { ...KV_TYPE, 'x-steam-detail': ECHO },
        body: `${VALID_ANSWER}detail:${ECHO}\n`,
      }),
      reason: 'status',
      status: 500,
    },
    {
      name: 'a 503',
      answer: () => ({ kind: 'status', status: 503, body: ECHO }),
      reason: 'status',
      status: 503,
    },
    {
      name: 'a 201 whose body says is_valid:true',
      answer: () => ({ kind: 'body', status: 201, body: VALID_ANSWER, headers: KV_TYPE }),
      reason: 'status',
      status: 201,
    },
    {
      name: 'a 302 to this same endpoint',
      answer: (endpoint) => ({
        kind: 'redirect',
        status: 302,
        location: `${endpoint}?detail=${ECHO}`,
        body: VALID_ANSWER,
        headers: KV_TYPE,
      }),
    },
    {
      name: 'a 307 to this same endpoint',
      answer: (endpoint) => ({
        kind: 'redirect',
        status: 307,
        location: `${endpoint}?detail=${ECHO}`,
        body: VALID_ANSWER,
        headers: KV_TYPE,
      }),
    },
    {
      name: 'no answer at all',
      answer: () => ({ kind: 'no-answer' }),
      reason: 'timeout',
      short: true,
    },
    {
      name: 'a body that never ends',
      answer: () => ({ kind: 'endless-body', body: `ns:${NS}\n`, headers: KV_TYPE }),
      reason: 'timeout',
      short: true,
    },
    {
      name: 'a body over the cap that never ends',
      answer: () => ({
        kind: 'endless-body',
        body: `${VALID_ANSWER}pad:${'a'.repeat(70 * 1024)}`,
        headers: KV_TYPE,
      }),
      short: true,
    },
    {
      name: 'the connection closed with no answer',
      answer: () => ({ kind: 'closed' }),
      reason: 'unreachable',
    },
    {
      name: 'the connection closed part-way through the body',
      answer: () => ({ kind: 'closed-mid-body', body: `ns:${NS}\nis_valid:tr`, headers: KV_TYPE }),
    },
  ];

  function faultStep(fault: Fault): Step {
    return makeStep(fault.short === true ? { timeoutMs: SHORT_TIMEOUT_MS } : {});
  }

  test.each(faults)('$name: no sign-in, nothing stored, nobody asked acs-10.2', async (fault) => {
    const step = faultStep(fault);
    answering(fault.answer(stub.openIdEndpoint));
    const outcome = await step.complete(replyFor(step), EXPECTED);
    expect({ outcome, asked, stored: writes.length }).toEqual({
      outcome: { kind: 'unavailable' },
      asked: [],
      stored: 0,
    });
  });

  test.each(faults)('$name: one request, never retried and no redirect followed', async (fault) => {
    const step = faultStep(fault);
    answering(fault.answer(stub.openIdEndpoint));
    await step.complete(replyFor(step), EXPECTED);
    expect(stub.requests).toHaveLength(1);
    expect(posts()).toHaveLength(1);
  });

  test.each(faults)('$name: one log line naming the reason', async (fault) => {
    const step = faultStep(fault);
    answering(fault.answer(stub.openIdEndpoint));
    await step.complete(replyFor(step), EXPECTED);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    const named = REASONS.filter((reason) => word(reason).test(line));
    if (fault.reason === undefined) {
      expect(named).toHaveLength(1);
    } else {
      expect(named).toEqual([fault.reason]);
    }
    if (fault.status !== undefined) expect(line).toMatch(word(String(fault.status)));
  });

  test.each(
    faults,
  )('$name: the log line holds nothing of the reply or of the answer', async (fault) => {
    const step = faultStep(fault);
    answering(fault.answer(stub.openIdEndpoint));
    const reply = replyFor(step);
    await step.complete(reply, EXPECTED);
    const secrets = [
      ECHO,
      reply.get('openid.sig')!,
      reply.get('openid.response_nonce')!,
      reply.get('openid.response_nonce')!.slice(20),
      reply.get('openid.assoc_handle')!,
      PLAYER,
      STATE,
      UID,
      RETURN_TO,
    ];
    for (const line of lines) {
      for (const secret of secrets) expect(line, secret).not.toContain(secret);
    }
  });

  test('a log that throws changes no outcome', async () => {
    const step = makeStep({
      log: () => {
        throw new Error('the log is down');
      },
    });
    answering({ kind: 'status', status: 500 });
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({ kind: 'unavailable' });
  });

  test('a log that returns a rejected promise changes no outcome', async () => {
    const step = makeStep({ log: () => Promise.reject(new Error('the log is down')) });
    answering({ kind: 'status', status: 500 });
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({ kind: 'unavailable' });
  });

  test('a refused reply writes no log line', async () => {
    const step = makeStep();
    await step.complete(replyFor(step, { change: { mode: 'cancel' } }), EXPECTED);
    expect(lines).toEqual([]);
  });
});

describe('the entitlement decision', () => {
  test('a player who does not own the game is not-owned acs-10.3', async () => {
    decision = async () => ({ entitled: false, reason: 'not-owned' });
    const step = makeStep();
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({ kind: 'not-owned' });
    expect(asked).toEqual([PLAYER]);
  });

  test('a player on the deny-list is not-owned acs-10.3', async () => {
    decision = async () => ({ entitled: false, reason: 'denied' });
    const step = makeStep();
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({ kind: 'not-owned' });
  });

  test('an entitlement source that cannot reach Steam gives unavailable', async () => {
    decision = async () => ({ entitled: false, reason: 'unavailable', error: new Error('down') });
    const step = makeStep();
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({ kind: 'unavailable' });
  });

  test('an entitlement source that rejects makes complete reject with its error', async () => {
    const failure = new Error('the entitlement source failed');
    decision = async () => {
      throw failure;
    };
    const step = makeStep();
    await expect(step.complete(replyFor(step), EXPECTED)).rejects.toBe(failure);
  });

  test('a store whose write rejects makes complete reject, and no one signs in', async () => {
    const failure = new Error('the store failed');
    storeFault = { on: 'upsert', error: failure };
    const step = makeStep();
    await expect(step.complete(replyFor(step), EXPECTED)).rejects.toBe(failure);
  });

  test('a store whose read rejects makes complete reject, and no one signs in', async () => {
    const failure = new Error('the store failed');
    storeFault = { on: 'find', error: failure };
    const step = makeStep();
    await expect(step.complete(replyFor(step), EXPECTED)).rejects.toBe(failure);
  });
});

describe('account', () => {
  test('an entitled Steam subject is entitled, with no passwordChangedAt', async () => {
    const account = await makeStep().account(`steam:${PLAYER}`);
    expect(account).toEqual({ sub: `steam:${PLAYER}`, entitled: true });
    expect(Object.hasOwn(account!, 'passwordChangedAt')).toBe(false);
    expect(asked).toEqual([PLAYER]);
  });

  test('a Steam subject that does not own the game is not entitled acs-10.3', async () => {
    decision = async () => ({ entitled: false, reason: 'not-owned' });
    expect(await makeStep().account(`steam:${PLAYER}`)).toEqual({
      sub: `steam:${PLAYER}`,
      entitled: false,
    });
  });

  test('a Steam subject on the deny-list is not entitled acs-10.3', async () => {
    decision = async () => ({ entitled: false, reason: 'denied' });
    expect(await makeStep().account(`steam:${PLAYER}`)).toEqual({
      sub: `steam:${PLAYER}`,
      entitled: false,
    });
  });

  test('a Steam subject whose entitlement cannot be read rejects, never answering', async () => {
    decision = async () => ({ entitled: false, reason: 'unavailable', error: new Error('down') });
    await expect(makeStep().account(`steam:${PLAYER}`)).rejects.toBeDefined();
  });

  test('is asked afresh at every call: a player who stops being entitled reads as not entitled acs-10.3', async () => {
    const step = makeStep();
    expect(await step.account(`steam:${PLAYER}`)).toEqual({
      sub: `steam:${PLAYER}`,
      entitled: true,
    });
    decision = async () => ({ entitled: false, reason: 'not-owned' });
    expect(await step.account(`steam:${PLAYER}`)).toEqual({
      sub: `steam:${PLAYER}`,
      entitled: false,
    });
    expect(asked).toEqual([PLAYER, PLAYER]);
  });

  test('sends nothing to Steam and stores nothing', async () => {
    await makeStep().account(`steam:${PLAYER}`);
    expect(stub.requests).toEqual([]);
    expect(writes).toEqual([]);
  });

  test.each([
    ['steam:1', 'steam:1'],
    ['16 digits', `steam:${PLAYER.slice(1)}`],
    ['18 digits', `steam:${PLAYER}0`],
    ['fullwidth digits', `steam:${fullwidth(PLAYER)}`],
    ['a trailing newline', `steam:${PLAYER}\n`],
    ['a space after the colon', `steam: ${PLAYER}`],
    ['an upper-case prefix', `STEAM:${PLAYER}`],
    ['a leading space', ` steam:${PLAYER}`],
    ['the SteamID alone', PLAYER],
    ['the prefix alone', 'steam:'],
    ['a dev subject', 'dev:11111111-1111-4111-8111-111111111111'],
    ['an empty subject', ''],
  ])('a subject with %s is no Steam account and asks nobody', async (_name, sub) => {
    expect(await makeStep().account(sub)).toBeUndefined();
    expect(asked).toEqual([]);
  });
});

describe('a dev profile', () => {
  function devSource() {
    const deny = denyList(store.adapter);
    const accounts = steamAccounts(store.adapter);
    const ownershipAsked: SteamId[] = [];
    const owned = (steamId: SteamId): Promise<OwnershipCheck> => {
      ownershipAsked.push(steamId);
      return Promise.resolve({
        kind: 'answered',
        ownership: { ownsapp: true, permanent: true, sitelicense: false, ownersteamid: steamId },
      });
    };
    stub.setOwnership(PLAYER, {
      ownsapp: true,
      permanent: true,
      sitelicense: false,
      ownersteamid: PLAYER,
    });
    const source = steamEntitlementSource({
      profile: 'local-dev',
      denied: (steamId) => deny.has(steamId),
      devFlag: (steamId) => accounts.entitled(steamId),
      checkAppOwnership: owned,
    });
    decision = source;
    return { deny, accounts, ownershipAsked };
  }

  function ownershipRequests(): SteamStubRequest[] {
    return stub.requests.filter((request) => request.path === '/ISteamUser/CheckAppOwnership/v4/');
  }

  test('a player with no flag is not-owned, though Steam says they own the game acs-10.5', async () => {
    const dev = devSource();
    const step = makeStep();
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({ kind: 'not-owned' });
    expect(dev.ownershipAsked).toEqual([]);
    expect(ownershipRequests()).toEqual([]);
  });

  test('a player flagged not entitled is not-owned acs-10.5', async () => {
    const dev = devSource();
    await dev.accounts.setEntitled(parseSteamId(PLAYER)!, false);
    const step = makeStep();
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({ kind: 'not-owned' });
  });

  test('a player the flag entitles signs in, and Steam is never asked about ownership acs-10.5', async () => {
    const dev = devSource();
    await dev.accounts.setEntitled(parseSteamId(PLAYER)!, true);
    const step = makeStep();
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({
      kind: 'signed-in',
      sub: `steam:${PLAYER}`,
    });
    expect(await step.account(`steam:${PLAYER}`)).toEqual({
      sub: `steam:${PLAYER}`,
      entitled: true,
    });
    expect(dev.ownershipAsked).toEqual([]);
    expect(ownershipRequests()).toEqual([]);
  });

  test('a flagged player on the deny-list is not-owned and reads as not entitled acs-10.3', async () => {
    const dev = devSource();
    await dev.accounts.setEntitled(parseSteamId(PLAYER)!, true);
    await dev.deny.add(parseSteamId(PLAYER)!);
    const step = makeStep();
    expect(await step.complete(replyFor(step), EXPECTED)).toEqual({ kind: 'not-owned' });
    expect(await step.account(`steam:${PLAYER}`)).toEqual({
      sub: `steam:${PLAYER}`,
      entitled: false,
    });
  });

  test('removing the flag after a sign-in makes the account read as not entitled acs-10.3', async () => {
    const dev = devSource();
    await dev.accounts.setEntitled(parseSteamId(PLAYER)!, true);
    const step = makeStep();
    expect((await step.complete(replyFor(step), EXPECTED)).kind).toBe('signed-in');
    await dev.accounts.setEntitled(parseSteamId(PLAYER)!, false);
    expect(await step.account(`steam:${PLAYER}`)).toEqual({
      sub: `steam:${PLAYER}`,
      entitled: false,
    });
  });
});

describe('a store that answers late', () => {
  afterEach(() => {
    nonceRead = undefined;
  });

  test('of five parallel completions of one reply over a slow store exactly one signs in acs-10.2', async () => {
    nonceRead = {
      after: () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        }),
    };
    const step = makeStep();
    const reply = replyFor(step);
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => step.complete(new URLSearchParams(reply), EXPECTED)),
    );
    expect(outcomes.filter((outcome) => outcome.kind === 'signed-in')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'refused')).toHaveLength(4);
    expect(nonceWrites()).toHaveLength(1);
    expect(asked).toEqual([PLAYER]);
  });

  test.each([
    ['a second', 301],
    ['the default allowance of 5 seconds', 305],
  ])('a replay admitted in the last second is refused when Steam answers %s later acs-10.2', async (_name, readAt) => {
    const step = makeStep();
    const reply = replyFor(step);
    expect((await step.complete(reply, EXPECTED)).kind).toBe('signed-in');
    vi.setSystemTime(T0 + 300_000);
    nonceRead = {
      before: () => {
        vi.setSystemTime(T0 + readAt * 1000);
      },
    };
    expect(await step.complete(reply, EXPECTED)).toEqual({ kind: 'refused' });
    expect(asked).toEqual([PLAYER]);
  });
});
