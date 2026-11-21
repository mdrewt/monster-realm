import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { PasswordStep } from './interactions/router.ts';
import { generateSigningKey, type SigningJwk } from './keys.ts';
import { createAccountProvider, registerClient } from './provider.ts';

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('end', () => {
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
    socket.on('error', reject);
    socket.write(text);
  });
}

function statusOf(response: string): number {
  const match = /^HTTP\/1\.[01] (\d{3}) /.exec(response);
  return match ? Number(match[1]) : Number.NaN;
}

function allHeaderText(headers: IncomingHttpHeaders): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : (value ?? '')}`)
    .join('\n');
}

interface Counter {
  upserts: number;
}

// A deterministic in-memory stand-in for the SQLite store; it counts every upsert.
function countingAdapter(counter: Counter): (model: string) => Adapter {
  const models = new Map<string, Map<string, AdapterPayload>>();
  return (model) => {
    let records = models.get(model);
    if (records === undefined) {
      records = new Map();
      models.set(model, records);
    }
    const own = records;
    const byMember = (name: string, value: string): AdapterPayload | undefined =>
      [...own.values()].find((stored) => stored[name] === value);
    return {
      upsert(id, payload) {
        counter.upserts += 1;
        own.set(id, payload);
        return Promise.resolve();
      },
      find(id) {
        return Promise.resolve(own.get(id));
      },
      findByUid(uid) {
        return Promise.resolve(byMember('uid', uid));
      },
      findByUserCode(userCode) {
        return Promise.resolve(byMember('userCode', userCode));
      },
      consume(id) {
        const stored = own.get(id);
        if (stored !== undefined) own.set(id, { ...stored, consumed: 1 });
        return Promise.resolve();
      },
      destroy(id) {
        own.delete(id);
        return Promise.resolve();
      },
      revokeByGrantId(grantId) {
        for (const [id, stored] of own) if (stored.grantId === grantId) own.delete(id);
        return Promise.resolve();
      },
    };
  };
}

interface Harness {
  readonly issuer: string;
  readonly host: string;
  keys: readonly SigningJwk[];
  readonly counter: Counter;
  port: number;
  server: Server | undefined;
}

function harness(issuer: string): Harness {
  const h: Harness = {
    issuer,
    host: new URL(issuer).host,
    keys: [],
    counter: { upserts: 0 },
    port: 0,
    server: undefined,
  };
  beforeAll(async () => {
    const keys = [generateSigningKey(), generateSigningKey()];
    h.keys = keys;
    const { handler } = createAccountProvider({
      issuer,
      keys: { keys },
      adapter: countingAdapter(h.counter),
    });
    const server = createServer(handler);
    h.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    h.port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    const server = h.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  return h;
}

const SPOOFS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['Forwarded', { forwarded: 'host=evil.example;proto=http' }],
  ['X-Forwarded-Host', { 'x-forwarded-host': 'evil.example' }],
  ['X-FORWARDED-HOST', { 'X-FORWARDED-HOST': 'evil.example' }],
  ['X-Forwarded-Proto', { 'x-forwarded-proto': 'http' }],
  ['X-Forwarded-Port', { 'x-forwarded-port': '1' }],
  ['X-Original-URL', { 'x-original-url': 'http://evil.example/' }],
  ['X-Rewrite-URL', { 'x-rewrite-url': '/jwks' }],
  [
    'all of them together',
    {
      forwarded: 'host=evil.example;proto=http',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
      'x-forwarded-port': '1',
      'x-original-url': 'http://evil.example/',
      'x-rewrite-url': '/jwks',
    },
  ],
];

function expectDiscoveryPinnedToIssuer(reply: Reply, issuer: string): Record<string, unknown> {
  expect(reply.status).toBe(200);
  expect(String(reply.headers['content-type'])).toContain('application/json');
  const doc = JSON.parse(reply.body) as Record<string, unknown>;
  expect(doc.issuer).toBe(issuer);
  const urls: string[] = [];
  for (const [name, value] of Object.entries(doc)) {
    if (name === 'issuer' || typeof value !== 'string' || !URL.canParse(value)) continue;
    urls.push(value);
    expect(value.startsWith(`${issuer}/`), `${name} = ${value}`).toBe(true);
  }
  expect(urls).toContain(doc.jwks_uri);
  expect(urls.length).toBeGreaterThan(1);
  return doc;
}

describe.each([
  ['an https issuer', 'https://issuer.example.test'],
  ['the local dev issuer', 'http://localhost:4455'],
])('discovery for %s', (_name, issuer) => {
  const h = harness(issuer);

  test('is served with the exact issuer and every URL under it', async () => {
    const reply = await send(h.port, '/.well-known/openid-configuration', { host: h.host });
    expectDiscoveryPinnedToIssuer(reply, issuer);
  });

  test.each(
    SPOOFS,
  )('stays pinned to the issuer when the request carries %s', async (_header, extra) => {
    const reply = await send(h.port, '/.well-known/openid-configuration', {
      host: h.host,
      ...extra,
    });
    expectDiscoveryPinnedToIssuer(reply, issuer);
    expect(reply.body).not.toContain('evil.example');
    expect(allHeaderText(reply.headers)).not.toContain('evil.example');
  });

  test('the key set stays the key set when the request carries spoofing headers', async () => {
    const all = SPOOFS[SPOOFS.length - 1]![1];
    const reply = await send(h.port, '/jwks', { host: h.host, ...all });
    expect(reply.status).toBe(200);
    expect(reply.body).not.toContain('evil.example');
    expect(allHeaderText(reply.headers)).not.toContain('evil.example');
  });

  test('advertises ES256 id tokens, the code response type only, and no implicit grant', async () => {
    const reply = await send(h.port, '/.well-known/openid-configuration', { host: h.host });
    const doc = JSON.parse(reply.body) as Record<string, unknown>;
    expect(doc.id_token_signing_alg_values_supported).toEqual(['ES256']);
    expect(doc.response_types_supported).toEqual(['code']);
    expect(Array.isArray(doc.grant_types_supported)).toBe(true);
    expect(doc.grant_types_supported as unknown[]).not.toContain('implicit');
  });

  test('the issuer hostname on another port, or without its port, gets 421', async () => {
    const { hostname, port } = new URL(issuer);
    const wrong = [`${hostname}:1`, ...(port === '' ? [] : [hostname])];
    for (const host of wrong) {
      const reply = await send(h.port, '/.well-known/openid-configuration', { host });
      expect(reply.status, host).toBe(421);
    }
  });

  test('accepts the issuer host in upper case', async () => {
    const reply = await send(h.port, '/.well-known/openid-configuration', {
      host: h.host.toUpperCase(),
    });
    expectDiscoveryPinnedToIssuer(reply, issuer);
  });
});

describe('a request for another host never reaches the provider', () => {
  const issuer = 'https://issuer.example.test';
  const h = harness(issuer);

  test('the right host is the control: it is answered', async () => {
    const reply = await send(h.port, '/.well-known/openid-configuration', { host: h.host });
    expect(reply.status).toBe(200);
  });

  test.each([
    ['a foreign host', 'evil.example'],
    ['the issuer host on another port', 'issuer.example.test:8443'],
    ['the issuer host with its default port written out', 'issuer.example.test:443'],
    ['a host that only ends with the issuer host', 'xissuer.example.test'],
  ])('%s gets 421 text/plain', async (_name, host) => {
    for (const path of ['/.well-known/openid-configuration', '/jwks']) {
      const reply = await send(h.port, path, { host });
      expect(reply.status).toBe(421);
      expect(String(reply.headers['content-type'])).toMatch(/^text\/plain/);
      expect(reply.body).not.toContain('jwks_uri');
      expect(reply.body).not.toContain(h.keys[0]!.x);
    }
  });

  test("the listening socket's own address as Host gets 421", async () => {
    const reply = await send(h.port, '/.well-known/openid-configuration', {
      host: `127.0.0.1:${h.port}`,
    });
    expect(reply.status).toBe(421);
    expect(String(reply.headers['content-type'])).toMatch(/^text\/plain/);
  });

  test('an HTTP/1.0 request with no Host gets 421', async () => {
    const response = await raw(
      h.port,
      'GET /.well-known/openid-configuration HTTP/1.0\r\nConnection: close\r\n\r\n',
    );
    expect(statusOf(response)).toBe(421);
    expect(response).not.toContain('jwks_uri');
  });

  test('an HTTP/1.0 request with the right Host is the control: it is answered', async () => {
    const response = await raw(
      h.port,
      `GET /.well-known/openid-configuration HTTP/1.0\r\nHost: ${h.host}\r\nConnection: close\r\n\r\n`,
    );
    expect(statusOf(response)).toBe(200);
  });
});

describe('a request cannot choose the client address the provider sees', () => {
  test('X-Forwarded-For and Forwarded for= leave the provider seeing the socket address', async () => {
    const issuer = 'https://issuer.example.test';
    const host = new URL(issuer).host;
    const { provider, handler } = createAccountProvider({
      issuer,
      keys: { keys: [generateSigningKey()] },
      adapter: countingAdapter({ upserts: 0 }),
    });
    const seen: Array<{ ip: string; ips: string[] }> = [];
    provider.use(async (ctx, next) => {
      seen.push({ ip: ctx.ip, ips: [...ctx.ips] });
      await next();
    });
    const server = createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          resolve();
        });
      });
      const port = (server.address() as AddressInfo).port;

      const control = await send(port, '/jwks', { host });
      expect(control.status).toBe(200);
      expect(seen).toHaveLength(1);
      const socketIp = seen[0]!.ip;
      expect(['127.0.0.1', '::ffff:127.0.0.1']).toContain(socketIp);
      expect(seen[0]!.ips).toEqual([]);

      const spoofed = await send(port, '/jwks', {
        host,
        'x-forwarded-for': '203.0.113.9',
        forwarded: 'for=203.0.113.9',
      });
      expect(spoofed.status).toBe(200);
      expect(seen).toHaveLength(2);
      expect(seen[1]!.ip).not.toBe('203.0.113.9');
      expect(seen[1]!.ip).toBe(socketIp);
      expect(seen[1]!.ips).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});

describe('a request target that is not a path gets 400', () => {
  const h = harness('https://issuer.example.test');

  test.each([
    [
      'an absolute-form target',
      'GET http://evil.example/.well-known/openid-configuration HTTP/1.1',
    ],
    [
      'an absolute-form target naming the issuer',
      'GET https://issuer.example.test/.well-known/openid-configuration HTTP/1.1',
    ],
    ['an asterisk-form target', 'OPTIONS * HTTP/1.1'],
  ])('%s with the right Host gets 400', async (_name, line) => {
    const response = await raw(h.port, `${line}\r\nHost: ${h.host}\r\nConnection: close\r\n\r\n`);
    expect(statusOf(response)).toBe(400);
    expect(response).not.toContain('evil.example');
  });
});

describe('the key set', () => {
  const issuer = 'https://issuer.example.test';
  const h = harness(issuer);

  test('publishes exactly the public members of each key, in order', async () => {
    const reply = await send(h.port, '/jwks', { host: h.host });
    expect(reply.status).toBe(200);
    const set = JSON.parse(reply.body) as { keys: Array<Record<string, unknown>> };
    expect(Object.keys(set)).toEqual(['keys']);
    expect(set.keys).toHaveLength(2);
    set.keys.forEach((entry, index) => {
      const key = h.keys[index]!;
      expect(Object.keys(entry).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
      expect(entry).toEqual({
        kty: 'EC',
        crv: 'P-256',
        x: key.x,
        y: key.y,
        kid: key.kid,
        alg: 'ES256',
        use: 'sig',
      });
    });
    for (const key of h.keys) expect(reply.body).not.toContain(key.d);
  });

  test('a signature by the first key verifies under the first published entry', async () => {
    const reply = await send(h.port, '/jwks', { host: h.host });
    const set = JSON.parse(reply.body) as { keys: Array<Record<string, string>> };
    const data = Buffer.from('an id token signing input');
    const signer = h.keys[0]!;
    const signature = sign('sha256', data, {
      key: createPrivateKey({ key: { ...signer }, format: 'jwk' }),
      dsaEncoding: 'ieee-p1363',
    });
    const verifies = (entry: Record<string, string>): boolean =>
      verify(
        'sha256',
        data,
        { key: createPublicKey({ key: { ...entry }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
        signature,
      );
    expect(verifies(set.keys[0]!)).toBe(true);
    expect(verifies(set.keys[1]!)).toBe(false);
  });
});

describe('there is no client and no sign-in step', () => {
  const h = harness('http://localhost:4455');

  test.each(['/interaction/abc', '/session/end'])('GET %s is 404', async (path) => {
    const reply = await send(h.port, path, { host: h.host });
    expect(reply.status).toBe(404);
  });

  test('no anonymous request writes to the store or sets a cookie', async () => {
    const form = { host: h.host, 'content-type': 'application/x-www-form-urlencoded' };
    const requests: ReadonlyArray<readonly [string, string, Record<string, string>, string?]> = [
      ['GET', '/session/end', { host: h.host }],
      ['GET', '/auth?client_id=x&response_type=code&scope=openid', { host: h.host }],
      ['GET', '/me', { host: h.host }],
      ['POST', '/token', form, 'grant_type=authorization_code&code=x&client_id=x'],
      ['POST', '/request', form, 'client_id=x&response_type=code&scope=openid'],
      ['GET', '/interaction/abc', { host: h.host }],
      ['GET', '/jwks', { host: h.host }],
      ['GET', '/.well-known/openid-configuration', { host: h.host }],
    ];
    h.counter.upserts = 0;
    const cookies: string[] = [];
    for (const [method, path, headers, body] of requests) {
      const reply = await send(h.port, path, headers, method, body);
      // Each request reached the provider: none was turned away at the Host check.
      expect(reply.status, `${method} ${path}`).not.toBe(421);
      const setCookie = reply.headers['set-cookie'];
      if (setCookie !== undefined) cookies.push(`${method} ${path}: ${setCookie.join('; ')}`);
    }
    expect(h.counter.upserts).toBe(0);
    expect(cookies).toEqual([]);
  });

  test.each([
    ['a session cookie', '_session=a'],
    ['session, signature and interaction cookies', '_session=a; _session.sig=b; _interaction=c'],
  ])('a request carrying %s writes nothing to the store and sets no cookie', async (_name, cookie) => {
    const plain = { host: h.host, cookie };
    const form = { ...plain, 'content-type': 'application/x-www-form-urlencoded' };
    const requests: ReadonlyArray<readonly [string, string, Record<string, string>, string?]> = [
      ['GET', '/auth?client_id=x&response_type=code&scope=openid', plain],
      ['GET', '/auth', plain],
      ['POST', '/session/end/confirm', form, 'xsrf=x&logout=yes'],
      ['GET', '/session/end', plain],
      ['GET', '/me', plain],
      ['POST', '/token', form, 'grant_type=authorization_code&code=x&client_id=x'],
      ['GET', '/jwks', plain],
      ['GET', '/.well-known/openid-configuration', plain],
    ];
    h.counter.upserts = 0;
    const cookies: string[] = [];
    const upsertsAfter: string[] = [];
    for (const [method, path, headers, body] of requests) {
      const reply = await send(h.port, path, headers, method, body);
      // Each request reached the provider: none was turned away at the Host check.
      expect(reply.status, `${method} ${path}`).not.toBe(421);
      const setCookie = reply.headers['set-cookie'];
      if (setCookie !== undefined) cookies.push(`${method} ${path}: ${setCookie.join('; ')}`);
      if (h.counter.upserts > 0) upsertsAfter.push(`${method} ${path}: ${h.counter.upserts}`);
    }
    expect(upsertsAfter).toEqual([]);
    expect(h.counter.upserts).toBe(0);
    expect(cookies).toEqual([]);
  });

  test('the error page is plain text with no URL outside the issuer', async () => {
    const reply = await send(h.port, '/auth?client_id=x&response_type=code&scope=openid', {
      host: h.host,
    });
    expect(reply.status).toBe(400);
    expect(String(reply.headers['content-type'])).toMatch(/^text\/plain/);
    const urls = reply.body.match(/https?:\/\/[^\s"'<>]*/g) ?? [];
    for (const url of urls) expect(url.startsWith(h.issuer), url).toBe(true);
  });
});

describe('without a sign-in step, the routes nobody uses are off', () => {
  const h = harness('http://localhost:4455');

  test('POST /request (pushed authorization) and GET /me (userinfo) are 404', async () => {
    const pushed = await send(
      h.port,
      '/request',
      { host: h.host, 'content-type': 'application/x-www-form-urlencoded' },
      'POST',
      'client_id=x&response_type=code&scope=openid',
    );
    expect(pushed.status).toBe(404);
    const me = await send(h.port, '/me', { host: h.host });
    expect(me.status).toBe(404);
  });
});

interface Recorded {
  readonly model: string;
  readonly id: string;
  readonly payload: AdapterPayload;
  readonly expiresIn: number | undefined;
}

// The counting stand-in, with every upsert recorded: model, id, payload and expiry.
function recordingAdapter(log: Recorded[]): (model: string) => Adapter {
  const base = countingAdapter({ upserts: 0 });
  return (model) => {
    const inner = base(model);
    return {
      ...inner,
      upsert(id, payload, expiresIn) {
        log.push({ model, id, payload, expiresIn });
        return inner.upsert(id, payload, expiresIn);
      },
    };
  };
}

const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const O_UMLAUT = String.fromCharCode(0xf6);
const GAME_ID = 'monster-realm';
const GAME_REDIRECT = 'http://localhost:5290/';

describe('registerClient', () => {
  test.each([
    [GAME_ID, GAME_REDIRECT],
    [GAME_ID, 'http://127.0.0.1:5290/'],
    [GAME_ID, 'http://[::1]:5290/'],
    [GAME_ID, 'http://localhost/'],
    ['a.B_c-9', 'https://game.example.com/callback'],
    ['x'.repeat(64), 'https://game.example.com/'],
  ])('stores %s with the one redirect %s as { redirectUri } under Client, with no expiry', async (clientId, redirectUri) => {
    const log: Recorded[] = [];
    const adapter = recordingAdapter(log);
    await registerClient(adapter, { clientId, redirectUri });
    expect(log).toEqual([
      { model: 'Client', id: clientId, payload: { redirectUri }, expiresIn: undefined },
    ]);
    expect(await adapter('Client').find(clientId)).toEqual({ redirectUri });
  });

  test('registering a client again replaces its redirect address', async () => {
    const adapter = recordingAdapter([]);
    await registerClient(adapter, { clientId: GAME_ID, redirectUri: GAME_REDIRECT });
    await registerClient(adapter, { clientId: GAME_ID, redirectUri: 'http://localhost:5391/' });
    expect(await adapter('Client').find(GAME_ID)).toEqual({
      redirectUri: 'http://localhost:5391/',
    });
  });

  test.each([
    ['an empty client id', '', GAME_REDIRECT],
    ['a 65-character client id', 'x'.repeat(65), GAME_REDIRECT],
    ['a client id with a space', 'monster realm', GAME_REDIRECT],
    ['a client id with a slash', 'monster/realm', GAME_REDIRECT],
    ['a client id with a letter outside ASCII', `m${O_UMLAUT}nster`, GAME_REDIRECT],
    ['a client id ending in a line feed', `${GAME_ID}${LF}`, GAME_REDIRECT],
    ['an address without its trailing slash', GAME_ID, 'http://localhost:5290'],
    ['a shorthand IPv4 address', GAME_ID, 'http://127.1/'],
    ['an upper-case host', GAME_ID, 'http://LOCALHOST:5290/'],
    ['an address with a tab inside', GAME_ID, `http://localhost:5290/a${TAB}b`],
    ['an address with CR LF inside', GAME_ID, `http://localhost:5290/${CR}${LF}x`],
    ['plain http on a public host', GAME_ID, 'http://game.example.com/'],
    [
      'plain http on a host that only begins with localhost',
      GAME_ID,
      'http://localhost.example.com/',
    ],
    ['plain http on a private address', GAME_ID, 'http://10.0.0.1/'],
    ['plain http on 0.0.0.0', GAME_ID, 'http://0.0.0.0/'],
    ['another scheme', GAME_ID, 'ftp://localhost/'],
    ['a javascript: address', GAME_ID, 'javascript:alert(1)'],
    ['a user and password', GAME_ID, 'http://user:pw@localhost:5290/'],
    ['a user on an https address', GAME_ID, 'https://user@game.example.com/'],
    ['an empty fragment', GAME_ID, 'http://localhost:5290/#'],
    ['a fragment', GAME_ID, 'https://game.example.com/#x'],
    ['text that is not a URL', GAME_ID, 'not a url'],
    ['an empty address', GAME_ID, ''],
  ])('refuses %s with a TypeError and stores nothing', async (_name, clientId, redirectUri) => {
    const log: Recorded[] = [];
    const adapter = recordingAdapter(log);
    await expect(
      Promise.resolve().then(() => registerClient(adapter, { clientId, redirectUri })),
    ).rejects.toBeInstanceOf(TypeError);
    expect(log).toEqual([]);
    expect(await adapter('Client').find(clientId)).toBeUndefined();
  });
});

function refusingStep(): PasswordStep {
  return {
    kind: 'password',
    attempt: () => Promise.resolve({ kind: 'refused' } as const),
    account: () => Promise.resolve(undefined),
  };
}

describe('discovery with a sign-in step', () => {
  const issuer = 'http://localhost:4455';
  const host = new URL(issuer).host;
  let port = 0;
  let server: Server | undefined;

  beforeAll(async () => {
    const { handler } = createAccountProvider({
      issuer,
      keys: { keys: [generateSigningKey()] },
      adapter: countingAdapter({ upserts: 0 }),
      signIn: refusingStep(),
    });
    const listening = createServer(handler);
    server = listening;
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject);
      listening.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    port = (listening.address() as AddressInfo).port;
  });

  afterAll(async () => {
    const listening = server;
    if (listening === undefined) return;
    listening.closeAllConnections();
    await new Promise<void>((resolve) => {
      listening.close(() => {
        resolve();
      });
    });
  });

  test('advertises openid as the only scope, the code and refresh grants, S256 only, and no userinfo or pushed-request endpoint', async () => {
    const reply = await send(port, '/.well-known/openid-configuration', { host });
    const doc = expectDiscoveryPinnedToIssuer(reply, issuer);
    expect(doc.scopes_supported).toEqual(['openid']);
    expect([...(doc.grant_types_supported as string[])].sort()).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    expect(doc).not.toHaveProperty('userinfo_endpoint');
    expect(doc).not.toHaveProperty('pushed_authorization_request_endpoint');
    expect(doc.id_token_signing_alg_values_supported).toEqual(['ES256']);
    expect(doc.response_types_supported).toEqual(['code']);
  });
});

describe('without a sign-in step, a stored client is not served', () => {
  const issuer = 'http://localhost:4455';
  const host = new URL(issuer).host;
  const counter: Counter = { upserts: 0 };
  let port = 0;
  let server: Server | undefined;

  beforeAll(async () => {
    const adapter = countingAdapter(counter);
    // The client is in the store before the provider exists.
    await registerClient(adapter, { clientId: GAME_ID, redirectUri: GAME_REDIRECT });
    const { handler } = createAccountProvider({
      issuer,
      keys: { keys: [generateSigningKey()] },
      adapter,
    });
    const listening = createServer(handler);
    server = listening;
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject);
      listening.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    port = (listening.address() as AddressInfo).port;
  });

  afterAll(async () => {
    const listening = server;
    if (listening === undefined) return;
    listening.closeAllConnections();
    await new Promise<void>((resolve) => {
      listening.close(() => {
        resolve();
      });
    });
  });

  test('a well-formed GET /auth for the registered client is invalid_client, sets no cookie and writes nothing', async () => {
    counter.upserts = 0;
    const challenge = createHash('sha256')
      .update('a-code-verifier-of-forty-three-characters-x')
      .digest('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: GAME_ID,
      redirect_uri: GAME_REDIRECT,
      scope: 'openid',
      state: 'state-1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const reply = await send(port, `/auth?${query.toString()}`, { host });
    expect(reply.status).toBe(400);
    expect(reply.body.startsWith('invalid_client'), reply.body).toBe(true);
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(reply.headers.location).toBeUndefined();
    expect(counter.upserts).toBe(0);
  });
});
