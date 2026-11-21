import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { generateSigningKey, type SigningJwk } from './keys.ts';
import { createAccountProvider } from './provider.ts';

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
