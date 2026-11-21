import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { Agent, createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { createLocalJWKSet, importJWK, type JWK, type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ATTEST_PATH,
  ATTESTATION_CLAIMS,
  ATTESTATION_LIMIT,
  ATTESTATION_TTL_SECONDS,
  ATTESTATION_WINDOW_SECONDS,
  attestationIssuer,
  createAttestRoute,
  MAX_ATTEST_BODY_BYTES,
  MAX_NONCE_LENGTH,
  MAX_WORLD_LENGTH,
} from './attest.ts';
import { BASE_GAME_ENTITLEMENT } from './claims.ts';
import { HOSTED_DEV_ISSUER } from './config.ts';
import type { Account } from './interactions/router.ts';
import {
  type AttestationJwk,
  type AttestationKeys,
  generateAttestationKey,
  generateSigningKey,
  type SigningJwk,
  type SigningKeys,
} from './keys.ts';

// The attestation route over real HTTP, with every dependency a fake this file controls: the
// login and attestation keys, the account lookup, the log and the clock.

const ISSUER = 'http://localhost:4455';
const HOST = 'localhost:4455';
const ATTEST_ISSUER = 'http://localhost:4455/attest';
const CLIENT_ID = 'monster-realm';
const SUB = 'dev:6f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c';
const SUB2 = 'dev:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
// Before the wall clock: a route that reads Date.now() refuses a token this clock calls fresh.
const T0 = 1_600_000_000;
// After the wall clock: a route that reads Date.now() accepts a token this clock calls expired.
const LATER = 4_000_000_000;
// The two name forms of a world (docs/local-play.md, fork (c)).
const SPKI_WORLD = 'spki:Zm9vYmFyYmF6cXV4LV9-QUJD+/=/c200a1b2c3d4e5f6';
const DNS_WORLD = 'dns:play.example.com:3000/c200a1b2c3d4e5f6';
const WORLD = SPKI_WORLD;
const NONCE = 'n-4f8a2c9e1b7d_Q';
const JSON_TYPE = 'application/json';
const TAB = String.fromCharCode(0x09);
const LINE_FEED = String.fromCharCode(0x0a);
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);
const E_ACUTE = String.fromCharCode(0xe9);
const GRINNING_FACE = String.fromCodePoint(0x1f600);
const EVERY_VISIBLE_ASCII = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
  String.fromCharCode(0x21 + i),
).join('');

let clock = T0;

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Call {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
  /** Send the body in small chunks with no Content-Length. */
  readonly chunked?: boolean;
}

type Failure =
  | undefined
  | { readonly kind: 'reject'; readonly value: unknown }
  | { readonly kind: 'throw'; readonly value: unknown };

interface State {
  failure: Failure;
  fallbacks: number;
  readonly reads: string[];
  readonly taken: Array<() => void>;
}

interface Harness {
  readonly port: number;
  readonly login: SigningJwk;
  readonly loginKeys: SigningKeys;
  readonly attestationKeys: AttestationKeys;
  readonly accounts: Map<string, Account>;
  readonly lines: string[];
  readonly state: State;
}

interface HarnessOptions {
  readonly issuer?: string;
  readonly loginKeys?: SigningKeys;
  readonly attestationKeys?: AttestationKeys;
}

const servers: Server[] = [];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  clock = T0;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }
});

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const loginKeys = options.loginKeys ?? { keys: [generateSigningKey()] };
  const attestationKeys = options.attestationKeys ?? { keys: [generateAttestationKey()] };
  const accounts = new Map<string, Account>([
    [SUB, { sub: SUB, entitled: true }],
    [SUB2, { sub: SUB2, entitled: true }],
  ]);
  const lines: string[] = [];
  const state: State = { failure: undefined, fallbacks: 0, reads: [], taken: [] };
  const route = createAttestRoute({
    issuer: options.issuer ?? ISSUER,
    loginKeys,
    attestationKeys,
    account: (sub) => {
      state.reads.push(sub);
      const failure = state.failure;
      if (failure === undefined) return Promise.resolve(accounts.get(sub));
      if (failure.kind === 'throw') throw failure.value;
      return Promise.reject(failure.value);
    },
    log: (line) => {
      lines.push(line);
    },
    now: () => clock,
  });
  const server = createServer((req, res) => {
    if (route(req, res)) {
      for (const waiter of state.taken.splice(0)) waiter();
      return;
    }
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
    loginKeys,
    attestationKeys,
    accounts,
    lines,
    state,
  };
}

function send(port: number, call: Call): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: HOST, ...call.headers };
    if (call.body !== undefined && call.chunked !== true && !('content-length' in headers)) {
      headers['content-length'] = String(Buffer.byteLength(call.body));
    }
    // A keep-alive agent, so an answer's own `connection: close` is the route's and not ours.
    const agent = new Agent({ keepAlive: true });
    let answered = false;
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: call.path ?? ATTEST_PATH,
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
    if (call.body !== undefined) {
      const bytes = typeof call.body === 'string' ? Buffer.from(call.body, 'utf8') : call.body;
      if (call.chunked === true) {
        for (let at = 0; at < bytes.length; at += 64) req.write(bytes.subarray(at, at + 64));
      } else {
        req.write(bytes);
      }
    }
    req.end();
  });
}

// ---- tokens ----

function asJwk(value: object): JsonWebKey {
  return { ...value };
}

function privateKeyOf(jwk: object): KeyObject {
  return createPrivateKey({ key: asJwk(jwk), format: 'jwk' });
}

/** The public half, built here from the members, never by the code under test. */
function loginPublic(key: SigningJwk): JWK {
  return { kty: key.kty, crv: key.crv, x: key.x, y: key.y, kid: key.kid, alg: key.alg, use: 'sig' };
}

function attestationPublic(key: AttestationJwk): JWK {
  return { kty: 'OKP', crv: 'Ed25519', x: key.x, kid: key.kid };
}

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

type Signer = (input: Buffer) => Buffer;

/** A compact JWS of any header and payload, signed by `signer` over `<header>.<payload>`. */
function forge(header: unknown, payload: unknown, signer: Signer): string {
  const input = `${segment(header)}.${segment(payload)}`;
  return `${input}.${signer(Buffer.from(input, 'ascii')).toString('base64url')}`;
}

function es(key: object, hash = 'sha256'): Signer {
  const privateKey = privateKeyOf(key);
  return (input) => sign(hash, input, { key: privateKey, dsaEncoding: 'ieee-p1363' });
}

function ed(key: KeyObject): Signer {
  return (input) => sign(null, input, key);
}

function hs256(secret: string): Signer {
  return (input) => createHmac('sha256', secret).update(input).digest();
}

const NO_SIGNATURE: Signer = () => Buffer.alloc(0);

/** An entitled account's ID token claims at the clock's present, changed by `extra`, less `drop`. */
function claims(extra: Record<string, unknown> = {}, ...drop: string[]): Record<string, unknown> {
  const all: Record<string, unknown> = {
    iss: ISSUER,
    sub: SUB,
    aud: CLIENT_ID,
    mr_ent: [BASE_GAME_ENTITLEMENT],
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

function body(world: unknown = WORLD, nonce: unknown = NONCE): string {
  return JSON.stringify({ world, nonce });
}

function padded(text: string, total: number): string {
  return text + ' '.repeat(total - Buffer.byteLength(text));
}

function withToken(
  token: string,
  payload: string | Buffer = body(),
  /** `null` sends no Content-Type header at all. */
  contentType: string | null = JSON_TYPE,
): Call {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (contentType !== null) headers['content-type'] = contentType;
  return { headers, body: payload };
}

function withAuthorization(value: string | undefined): Call {
  const headers: Record<string, string> = { 'content-type': JSON_TYPE };
  if (value !== undefined) headers.authorization = value;
  return { headers, body: body() };
}

function post(h: Harness, token: string, payload: string | Buffer = body()): Promise<Reply> {
  return send(h.port, withToken(token, payload));
}

// ---- answers ----

function decode(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(String(part), 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function headerOf(jwt: string): Record<string, unknown> {
  return decode(jwt.split('.')[0]);
}

function payloadOf(jwt: string): Record<string, unknown> {
  return decode(jwt.split('.')[1]);
}

function expectRouteHeaders(reply: Reply, json = true): void {
  if (json) expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers['access-control-allow-origin']).toBe('*');
  expect(reply.headers['access-control-expose-headers']).toBe('retry-after, www-authenticate');
}

/** The headers each refusal row names; `connection: close` where it answers before the body. */
const ROW_HEADERS: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  400: {},
  401: { 'www-authenticate': 'Bearer', connection: 'close' },
  403: { connection: 'close' },
  405: { allow: 'POST, OPTIONS', connection: 'close' },
  413: { connection: 'close' },
  415: { connection: 'close' },
};

function expectRefusal(
  reply: Reply,
  status: number,
  code: string,
  rowHeaders: Readonly<Record<string, string>> = ROW_HEADERS[status] ?? {},
): void {
  expect(reply.status, reply.body).toBe(status);
  expectRouteHeaders(reply);
  expect(reply.body).toBe(JSON.stringify({ error: code }));
  const json = JSON.parse(reply.body) as Record<string, unknown>;
  expect(Object.hasOwn(json, 'attestation')).toBe(false);
  for (const [name, value] of Object.entries(rowHeaders)) {
    expect(reply.headers[name], name).toBe(value);
  }
}

function attestationOf(reply: Reply): string {
  expect(reply.status, reply.body).toBe(200);
  const json = JSON.parse(reply.body) as Record<string, unknown>;
  expect(Object.keys(json)).toEqual(['attestation']);
  expect(json.attestation).toEqual(expect.any(String));
  const attestation = json.attestation as string;
  expect(attestation.split('.')).toHaveLength(3);
  return attestation;
}

async function verifyAttestation(
  attestation: string,
  key: AttestationJwk,
  world = WORLD,
  issuer = ATTEST_ISSUER,
) {
  return jwtVerify(attestation, createLocalJWKSet({ keys: [attestationPublic(key)] }), {
    issuer,
    audience: world,
    algorithms: ['Ed25519'],
    currentDate: new Date(clock * 1000),
  });
}

/** 20 good requests still pass and the 21st is refused: the request before took no hit. */
async function expectNoHitTaken(h: Harness): Promise<void> {
  const token = good(h);
  for (let i = 1; i <= 20; i += 1) {
    const reply = await post(h, token);
    expect(reply.status, `good request ${i}: ${reply.body}`).toBe(200);
  }
  expect((await post(h, token)).status).toBe(429);
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

// ---- acs-3.1 ----

describe('an entitled account with a valid token gets an attestation', () => {
  test('the answer is 200 JSON holding exactly an attestation member, with the route headers acs-3.1', async () => {
    const h = await harness();
    const reply = await post(h, good(h));
    attestationOf(reply);
    expectRouteHeaders(reply);
  });

  test('the protected header is exactly alg Ed25519 and the kid of the first attestation key acs-3.1', async () => {
    const h = await harness();
    const attestation = attestationOf(await post(h, good(h)));
    expect(headerOf(attestation)).toEqual({ alg: 'Ed25519', kid: h.attestationKeys.keys[0]!.kid });
  });

  test('the payload holds exactly the eight claims of the contract acs-3.1', async () => {
    const h = await harness();
    const payload = payloadOf(attestationOf(await post(h, good(h))));
    const eight = ['iss', 'sub', 'aud', 'nonce', 'mr_ent', 'iat', 'exp', 'jti'];
    expect([...ATTESTATION_CLAIMS]).toEqual(eight);
    expect(Object.keys(payload).sort()).toEqual([...eight].sort());
  });

  test('each claim has its contract value: iss the issuer with /attest, sub, aud the world, nonce, mr_ent, iat, exp acs-3.1', async () => {
    clock = T0 + 12_345;
    const h = await harness();
    const payload = payloadOf(attestationOf(await post(h, good(h))));
    expect(attestationIssuer(ISSUER)).toBe(ATTEST_ISSUER);
    expect(payload).toEqual({
      iss: ATTEST_ISSUER,
      sub: SUB,
      aud: WORLD,
      nonce: NONCE,
      mr_ent: ['base-game'],
      iat: T0 + 12_345,
      exp: T0 + 12_345 + 300,
      jti: expect.any(String),
    });
    expect(ATTESTATION_TTL_SECONDS).toBe(300);
    expect(Number(payload.exp) - Number(payload.iat)).toBe(ATTESTATION_TTL_SECONDS);
    expect(String(payload.jti).length).toBeGreaterThan(0);
  });

  test('iat follows the injected clock as it moves, and exp stays five minutes after it acs-3.1', async () => {
    const h = await harness();
    const token = good(h, claims({ exp: T0 + 7200 }));
    for (const at of [T0, T0 + 1, T0 + 999]) {
      clock = at;
      const payload = payloadOf(attestationOf(await post(h, token)));
      expect(payload.iat).toBe(at);
      expect(payload.exp).toBe(at + 300);
    }
  });

  const worlds: ReadonlyArray<readonly [string, string]> = [
    ['the spki: name form', SPKI_WORLD],
    ['the dns: name form', DNS_WORLD],
    ['512 characters, the bound', `dns:${'w'.repeat(512 - 'dns:'.length)}`],
    ['every visible ASCII character, quote and backslash among them', EVERY_VISIBLE_ASCII],
    ['one character', '!'],
  ];

  test.each(worlds)('aud is the body world byte for byte for %s acs-3.1', async (_name, world) => {
    const h = await harness();
    if (world.length === 512) expect(MAX_WORLD_LENGTH).toBe(512);
    const attestation = attestationOf(await post(h, good(h), body(world, NONCE)));
    expect(payloadOf(attestation).aud).toBe(world);
    const verified = await verifyAttestation(attestation, h.attestationKeys.keys[0]!, world);
    expect(verified.payload.aud).toBe(world);
  });

  test.each([
    ['128 characters, the bound', 'n'.repeat(128)],
    ['every visible ASCII character', EVERY_VISIBLE_ASCII.slice(0, 128)],
    ['one character', '~'],
  ])('nonce is the body nonce byte for byte for %s acs-3.1', async (_name, nonce) => {
    const h = await harness();
    expect(MAX_NONCE_LENGTH).toBe(128);
    const attestation = attestationOf(await post(h, good(h), body(WORLD, nonce)));
    expect(payloadOf(attestation).nonce).toBe(nonce);
  });

  test('every attestation carries its own jti, even for the same token, body and second acs-3.1', async () => {
    const h = await harness();
    const token = good(h);
    const ids: unknown[] = [];
    for (let i = 0; i < 8; i += 1) ids.push(payloadOf(attestationOf(await post(h, token))).jti);
    for (const id of ids) expect(id).toEqual(expect.any(String));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the token's own aud, the client id, does not reach the attestation acs-3.1", async () => {
    const h = await harness();
    const attestation = attestationOf(await post(h, good(h, claims({ aud: 'other-client-id' }))));
    const payload = payloadOf(attestation);
    expect(payload.aud).toBe(WORLD);
    expect(JSON.stringify(payload)).not.toContain('other-client-id');
  });

  test("the token's own nonce and auth_time do not reach the attestation acs-3.1", async () => {
    const h = await harness();
    const token = good(h, claims({ nonce: 'token-nonce-value', auth_time: T0 - 5 }));
    const payload = payloadOf(attestationOf(await post(h, token)));
    expect(payload.nonce).toBe(NONCE);
    expect(Object.keys(payload).sort()).toEqual([...ATTESTATION_CLAIMS].sort());
    expect(JSON.stringify(payload)).not.toContain('token-nonce-value');
  });

  test('mr_ent is exactly base-game even when the token holds more entitlements acs-3.1', async () => {
    const h = await harness();
    const token = good(h, claims({ mr_ent: ['beta-tester', 'base-game', 'dlc-one'] }));
    expect(payloadOf(attestationOf(await post(h, token))).mr_ent).toEqual(['base-game']);
  });

  test('the attestation verifies with jose under the public attestation key alone acs-3.1', async () => {
    const h = await harness();
    const attestation = attestationOf(await post(h, await joseToken(h.login)));
    const verified = await verifyAttestation(attestation, h.attestationKeys.keys[0]!);
    expect(verified.payload.sub).toBe(SUB);
    expect(verified.protectedHeader.alg).toBe('Ed25519');
  });

  test('node:crypto verifies the signature over the raw segments, and not over a changed payload acs-3.1', async () => {
    const h = await harness();
    const attestation = attestationOf(await post(h, good(h)));
    const [header, payload, signature] = attestation.split('.');
    const key = h.attestationKeys.keys[0]!;
    const publicKey = createPublicKey({ key: asJwk(attestationPublic(key)), format: 'jwk' });
    const signature64 = Buffer.from(String(signature), 'base64url');
    expect(signature64).toHaveLength(64);
    expect(verify(null, Buffer.from(`${header}.${payload}`), publicKey, signature64)).toBe(true);
    const changed = segment({ ...payloadOf(attestation), aud: DNS_WORLD });
    expect(verify(null, Buffer.from(`${header}.${changed}`), publicKey, signature64)).toBe(false);
  });

  test('with two attestation keys the first signs, and the second alone does not verify it acs-3.1', async () => {
    const first = generateAttestationKey();
    const second = generateAttestationKey();
    const h = await harness({ attestationKeys: { keys: [first, second] } });
    const attestation = attestationOf(await post(h, good(h)));
    expect(headerOf(attestation).kid).toBe(first.kid);
    await expect(verifyAttestation(attestation, first)).resolves.toBeDefined();
    const underSecond = createLocalJWKSet({
      keys: [{ ...attestationPublic(second), kid: first.kid }],
    });
    await expect(
      jwtVerify(attestation, underSecond, { currentDate: new Date(clock * 1000) }),
    ).rejects.toThrow();
  });

  test('under another issuer the route answers at that issuer host and names that issuer acs-3.1', async () => {
    const h = await harness({ issuer: HOSTED_DEV_ISSUER });
    const host = new URL(HOSTED_DEV_ISSUER).host;
    const token = good(h, claims({ iss: HOSTED_DEV_ISSUER }));
    const call = withToken(token);
    const reply = await send(h.port, { ...call, headers: { ...call.headers, host } });
    const attestation = attestationOf(reply);
    expect(attestationIssuer(HOSTED_DEV_ISSUER)).toBe(`${HOSTED_DEV_ISSUER}/attest`);
    expect(payloadOf(attestation).iss).toBe(`${HOSTED_DEV_ISSUER}/attest`);
    // The local issuer's host and tokens are not this route's.
    const local = await post(h, token);
    expect(local.status).toBe(418);
    const localToken = good(h);
    const misissued = await send(h.port, {
      ...withToken(localToken),
      headers: { ...withToken(localToken).headers, host },
    });
    expectRefusal(misissued, 401, 'invalid_token');
  });
});

// ---- acs-3.2 ----

type Build = (h: Harness) => Call;

const otherLogin = generateSigningKey();
const edKeys = generateKeyPairSync('ed25519');

function publicPem(key: SigningJwk): string {
  return String(
    createPublicKey({
      key: asJwk({ kty: key.kty, crv: key.crv, x: key.x, y: key.y }),
      format: 'jwk',
    }).export({ type: 'spki', format: 'pem' }),
  );
}

const REFUSED: ReadonlyArray<readonly [string, Build, number, string]> = [
  // method
  [
    'GET',
    (h) => ({ method: 'GET', headers: { authorization: `Bearer ${good(h)}` } }),
    405,
    'method_not_allowed',
  ],
  [
    'PUT with a good token and body',
    (h) => ({ ...withToken(good(h)), method: 'PUT' }),
    405,
    'method_not_allowed',
  ],
  ['DELETE', (h) => ({ ...withToken(good(h)), method: 'DELETE' }), 405, 'method_not_allowed'],
  ['PATCH', (h) => ({ ...withToken(good(h)), method: 'PATCH' }), 405, 'method_not_allowed'],
  ['GET with no token', () => ({ method: 'GET' }), 405, 'method_not_allowed'],
  // the Authorization header
  ['no Authorization header', () => withAuthorization(undefined), 401, 'invalid_token'],
  [
    'Basic credentials',
    () => withAuthorization(`Basic ${Buffer.from('a:b').toString('base64')}`),
    401,
    'invalid_token',
  ],
  [
    'a good token under the Basic scheme',
    (h) => withAuthorization(`Basic ${good(h)}`),
    401,
    'invalid_token',
  ],
  ['Bearer with nothing', () => withAuthorization('Bearer'), 401, 'invalid_token'],
  [
    'Bearer and two spaces before the token',
    (h) => withAuthorization(`Bearer  ${good(h)}`),
    401,
    'invalid_token',
  ],
  [
    'Bearer joined to the token',
    (h) => withAuthorization(`Bearer${good(h)}`),
    401,
    'invalid_token',
  ],
  ['a token with no scheme', (h) => withAuthorization(good(h)), 401, 'invalid_token'],
  [
    'a token followed by a second word',
    (h) => withAuthorization(`Bearer ${good(h)} more`),
    401,
    'invalid_token',
  ],
  [
    'a token of two segments',
    (h) => withToken(good(h).split('.').slice(0, 2).join('.')),
    401,
    'invalid_token',
  ],
  ['a token of four segments', (h) => withToken(`${good(h)}.${segment({})}`), 401, 'invalid_token'],
  [
    'a token whose header is not JSON',
    (h) => withToken(`bm90IGpzb24.${good(h).split('.').slice(1).join('.')}`),
    401,
    'invalid_token',
  ],
  // the signature
  [
    'alg none with an empty signature',
    () => withToken(forge({ alg: 'none' }, claims(), NO_SIGNATURE)),
    401,
    'invalid_token',
  ],
  [
    'alg none naming the login kid',
    (h) => withToken(forge({ alg: 'none', kid: h.login.kid }, claims(), NO_SIGNATURE)),
    401,
    'invalid_token',
  ],
  [
    'HS256 keyed with the login public key as PEM',
    (h) =>
      withToken(forge({ alg: 'HS256', kid: h.login.kid }, claims(), hs256(publicPem(h.login)))),
    401,
    'invalid_token',
  ],
  [
    'HS256 keyed with the login public key as JWK JSON',
    (h) =>
      withToken(
        forge(
          { alg: 'HS256', kid: h.login.kid },
          claims(),
          hs256(JSON.stringify(loginPublic(h.login))),
        ),
      ),
    401,
    'invalid_token',
  ],
  [
    'ES384 over the login key',
    (h) => withToken(forge({ alg: 'ES384', kid: h.login.kid }, claims(), es(h.login, 'sha384'))),
    401,
    'invalid_token',
  ],
  [
    'an Ed25519-signed token under alg Ed25519',
    (h) => withToken(forge({ alg: 'Ed25519', kid: h.login.kid }, claims(), ed(edKeys.privateKey))),
    401,
    'invalid_token',
  ],
  [
    'an Ed25519-signed token under alg EdDSA',
    (h) => withToken(forge({ alg: 'EdDSA', kid: h.login.kid }, claims(), ed(edKeys.privateKey))),
    401,
    'invalid_token',
  ],
  [
    'the right claims under a login key not in loginKeys',
    () => withToken(forge({ alg: 'ES256', kid: otherLogin.kid }, claims(), es(otherLogin))),
    401,
    'invalid_token',
  ],
  [
    'the right claims under another key naming the login kid',
    (h) => withToken(forge({ alg: 'ES256', kid: h.login.kid }, claims(), es(otherLogin))),
    401,
    'invalid_token',
  ],
  [
    'a payload changed after signing',
    (h) => {
      const [header, , signature] = good(h).split('.');
      return withToken(`${header}.${segment(claims({ sub: SUB2 }))}.${signature}`);
    },
    401,
    'invalid_token',
  ],
  [
    'a signature with one bit flipped',
    (h) => {
      const [header, payload, signature] = good(h).split('.');
      const bytes = Buffer.from(String(signature), 'base64url');
      bytes[10] ^= 0x01;
      return withToken(`${header}.${payload}.${bytes.toString('base64url')}`);
    },
    401,
    'invalid_token',
  ],
  [
    'a payload that is a JSON array',
    (h) => withToken(forge({ alg: 'ES256', kid: h.login.kid }, [claims()], es(h.login))),
    401,
    'invalid_token',
  ],
  // iss
  [
    'the right key and another iss',
    (h) => withToken(good(h, claims({ iss: 'http://localhost:4456' }))),
    401,
    'invalid_token',
  ],
  [
    'the right key and the hosted issuer',
    (h) => withToken(good(h, claims({ iss: HOSTED_DEV_ISSUER }))),
    401,
    'invalid_token',
  ],
  [
    'the right key and the attestation issuer as iss',
    (h) => withToken(good(h, claims({ iss: ATTEST_ISSUER }))),
    401,
    'invalid_token',
  ],
  [
    'the right key and the issuer with a trailing slash',
    (h) => withToken(good(h, claims({ iss: `${ISSUER}/` }))),
    401,
    'invalid_token',
  ],
  ['the right key and no iss', (h) => withToken(good(h, claims({}, 'iss'))), 401, 'invalid_token'],
  // exp
  [
    'a valid signature over a payload with no exp',
    (h) => withToken(good(h, claims({}, 'exp'))),
    401,
    'invalid_token',
  ],
  [
    'exp as a string',
    (h) => withToken(good(h, claims({ exp: String(clock + 3600) }))),
    401,
    'invalid_token',
  ],
  ['exp null', (h) => withToken(good(h, claims({ exp: null }))), 401, 'invalid_token'],
  ['exp equal to now', (h) => withToken(good(h, claims({ exp: clock }))), 401, 'invalid_token'],
  [
    'exp an hour ago',
    (h) => withToken(good(h, claims({ exp: clock - 3600 }))),
    401,
    'invalid_token',
  ],
  [
    'exp one second ago on a clock past the wall clock',
    (h) => {
      clock = LATER;
      return withToken(good(h, claims({ exp: LATER - 1 })));
    },
    401,
    'invalid_token',
  ],
  // sub and aud
  ['an empty sub', (h) => withToken(good(h, claims({ sub: '' }))), 401, 'invalid_token'],
  ['no sub', (h) => withToken(good(h, claims({}, 'sub'))), 401, 'invalid_token'],
  ['a numeric sub', (h) => withToken(good(h, claims({ sub: 7 }))), 401, 'invalid_token'],
  ['an array sub', (h) => withToken(good(h, claims({ sub: [SUB] }))), 401, 'invalid_token'],
  ['an array aud', (h) => withToken(good(h, claims({ aud: [CLIENT_ID] }))), 401, 'invalid_token'],
  ['no aud', (h) => withToken(good(h, claims({}, 'aud'))), 401, 'invalid_token'],
  ['a numeric aud', (h) => withToken(good(h, claims({ aud: 1 }))), 401, 'invalid_token'],
  // mr_ent
  ['a token without mr_ent', (h) => withToken(good(h, claims({}, 'mr_ent'))), 403, 'not_entitled'],
  [
    'mr_ent as a string',
    (h) => withToken(good(h, claims({ mr_ent: 'base-game' }))),
    403,
    'not_entitled',
  ],
  ['mr_ent an empty array', (h) => withToken(good(h, claims({ mr_ent: [] }))), 403, 'not_entitled'],
  [
    'mr_ent without base-game',
    (h) => withToken(good(h, claims({ mr_ent: ['dlc-one'] }))),
    403,
    'not_entitled',
  ],
  [
    'mr_ent with base-game in another case',
    (h) => withToken(good(h, claims({ mr_ent: ['BASE-GAME'] }))),
    403,
    'not_entitled',
  ],
  ['mr_ent null', (h) => withToken(good(h, claims({ mr_ent: null }))), 403, 'not_entitled'],
  [
    'mr_ent an object keyed base-game',
    (h) => withToken(good(h, claims({ mr_ent: { 'base-game': true } }))),
    403,
    'not_entitled',
  ],
  // the order of the rows
  [
    'an expired token with a bad body',
    (h) => withToken(good(h, claims({ exp: clock })), '{"world":'),
    401,
    'invalid_token',
  ],
  [
    'an expired token with no content type',
    (h) => withToken(good(h, claims({ exp: clock })), body(), null),
    401,
    'invalid_token',
  ],
  [
    'no token and a body over the cap',
    () => ({ headers: { 'content-type': JSON_TYPE }, body: padded(body(), 2000) }),
    401,
    'invalid_token',
  ],
  [
    'a token without mr_ent and a bad body',
    (h) => withToken(good(h, claims({}, 'mr_ent')), '{"world":'),
    403,
    'not_entitled',
  ],
  [
    'a token without mr_ent and no content type',
    (h) => withToken(good(h, claims({}, 'mr_ent')), body(), null),
    403,
    'not_entitled',
  ],
  [
    'a token without mr_ent and a body over the cap',
    (h) => withToken(good(h, claims({}, 'mr_ent')), padded(body(), 2000)),
    403,
    'not_entitled',
  ],
  [
    'GET with an expired token',
    (h) => ({
      method: 'GET',
      headers: { authorization: `Bearer ${good(h, claims({ exp: clock }))}` },
    }),
    405,
    'method_not_allowed',
  ],
  [
    'a bad content type and a body over the cap',
    (h) => withToken(good(h), padded(body(), 2000), 'text/plain'),
    415,
    'invalid_request',
  ],
  [
    'a body over the cap that is not JSON',
    (h) => withToken(good(h), `{${'x'.repeat(1100)}`),
    413,
    'invalid_request',
  ],
  // the content type
  ['no content type', (h) => withToken(good(h), body(), null), 415, 'invalid_request'],
  ['text/plain', (h) => withToken(good(h), body(), 'text/plain'), 415, 'invalid_request'],
  [
    'a form content type',
    (h) => withToken(good(h), body(), 'application/x-www-form-urlencoded'),
    415,
    'invalid_request',
  ],
  ['text/json', (h) => withToken(good(h), body(), 'text/json'), 415, 'invalid_request'],
  [
    'application/json-patch+json',
    (h) => withToken(good(h), body(), 'application/json-patch+json'),
    415,
    'invalid_request',
  ],
  [
    'application/json with a parameter but no semicolon',
    (h) => withToken(good(h), body(), 'application/json charset=utf-8'),
    415,
    'invalid_request',
  ],
  // the body's size
  ['a body of 1025 bytes', (h) => withToken(good(h), padded(body(), 1025)), 413, 'invalid_request'],
  [
    'a body of 1025 bytes in chunks with no Content-Length',
    (h) => ({ ...withToken(good(h), padded(body(), 1025)), chunked: true }),
    413,
    'invalid_request',
  ],
  [
    'a declared Content-Length of 1025 over a short body',
    (h) => {
      const call = withToken(good(h));
      return { ...call, headers: { ...call.headers, 'content-length': '1025' } };
    },
    413,
    'invalid_request',
  ],
  [
    'a declared Content-Length of a million',
    (h) => {
      const call = withToken(good(h));
      return { ...call, headers: { ...call.headers, 'content-length': '1000000' } };
    },
    413,
    'invalid_request',
  ],
  // the body
  ['a body that is not JSON', (h) => withToken(good(h), '{"world":'), 400, 'invalid_request'],
  ['a form-encoded body', (h) => withToken(good(h), 'world=a&nonce=b'), 400, 'invalid_request'],
  ['an empty body', (h) => withToken(good(h), ''), 400, 'invalid_request'],
  [
    'a JSON array',
    (h) => withToken(good(h), JSON.stringify([WORLD, NONCE])),
    400,
    'invalid_request',
  ],
  ['JSON null', (h) => withToken(good(h), 'null'), 400, 'invalid_request'],
  ['a JSON string', (h) => withToken(good(h), JSON.stringify(WORLD)), 400, 'invalid_request'],
  ['a JSON number', (h) => withToken(good(h), '42'), 400, 'invalid_request'],
  [
    'an object without nonce',
    (h) => withToken(good(h), JSON.stringify({ world: WORLD })),
    400,
    'invalid_request',
  ],
  [
    'an object without world',
    (h) => withToken(good(h), JSON.stringify({ nonce: NONCE })),
    400,
    'invalid_request',
  ],
  ['an empty object', (h) => withToken(good(h), '{}'), 400, 'invalid_request'],
  [
    'a third member',
    (h) => withToken(good(h), JSON.stringify({ world: WORLD, nonce: NONCE, extra: 'x' })),
    400,
    'invalid_request',
  ],
  [
    '__proto__ as an extra member',
    (h) =>
      withToken(
        good(h),
        `{"world":${JSON.stringify(WORLD)},"nonce":${JSON.stringify(NONCE)},"__proto__":{}}`,
      ),
    400,
    'invalid_request',
  ],
  [
    'constructor as an extra member',
    (h) =>
      withToken(
        good(h),
        `{"world":${JSON.stringify(WORLD)},"nonce":${JSON.stringify(NONCE)},"constructor":"x"}`,
      ),
    400,
    'invalid_request',
  ],
  ['a numeric world', (h) => withToken(good(h), body(1, NONCE)), 400, 'invalid_request'],
  ['a null nonce', (h) => withToken(good(h), body(WORLD, null)), 400, 'invalid_request'],
  [
    'a world inside an array',
    (h) => withToken(good(h), body([WORLD], NONCE)),
    400,
    'invalid_request',
  ],
  [
    'a world that is an object',
    (h) => withToken(good(h), body({ name: WORLD }, NONCE)),
    400,
    'invalid_request',
  ],
  ['a boolean nonce', (h) => withToken(good(h), body(WORLD, true)), 400, 'invalid_request'],
  ['an empty world', (h) => withToken(good(h), body('', NONCE)), 400, 'invalid_request'],
  ['an empty nonce', (h) => withToken(good(h), body(WORLD, '')), 400, 'invalid_request'],
  [
    'a world of 513 characters',
    (h) => withToken(good(h), body('w'.repeat(513), NONCE)),
    400,
    'invalid_request',
  ],
  [
    'a nonce of 129 characters',
    (h) => withToken(good(h), body(WORLD, 'n'.repeat(129))),
    400,
    'invalid_request',
  ],
  [
    'a world with a space',
    (h) => withToken(good(h), body('spki:a b/c', NONCE)),
    400,
    'invalid_request',
  ],
  ['a nonce with a space', (h) => withToken(good(h), body(WORLD, 'n n')), 400, 'invalid_request'],
  [
    'a world with a tab',
    (h) => withToken(good(h), body(`w${TAB}w`, NONCE)),
    400,
    'invalid_request',
  ],
  [
    'a world with a line feed',
    (h) => withToken(good(h), body(`w${LINE_FEED}w`, NONCE)),
    400,
    'invalid_request',
  ],
  ['a world with DEL', (h) => withToken(good(h), body(`w${DEL}w`, NONCE)), 400, 'invalid_request'],
  ['a nonce with NUL', (h) => withToken(good(h), body(WORLD, `n${NUL}n`)), 400, 'invalid_request'],
  [
    'a world with a non-ASCII character',
    (h) => withToken(good(h), body(`w${E_ACUTE}`, NONCE)),
    400,
    'invalid_request',
  ],
  [
    'a nonce with an astral character',
    (h) => withToken(good(h), body(WORLD, `n${GRINNING_FACE}`)),
    400,
    'invalid_request',
  ],
  [
    'a world holding a byte that is not UTF-8',
    (h) =>
      withToken(
        good(h),
        Buffer.concat([
          Buffer.from('{"world":"w'),
          Buffer.from([0xff]),
          Buffer.from(`","nonce":${JSON.stringify(NONCE)}}`),
        ]),
      ),
    400,
    'invalid_request',
  ],
];

describe('every refusal before the limit answers with no attestation and takes no hit', () => {
  const refusedRows = REFUSED.map(([name, build, status, code]) => ({ name, build, status, code }));

  test.each(refusedRows)('$name is refused $status $code acs-3.2', async ({
    build,
    status,
    code,
  }) => {
    const h = await harness();
    const reply = await send(h.port, build(h));
    expectRefusal(reply, status, code);
    expect(h.state.fallbacks).toBe(0);
    expect(h.state.reads).toEqual([]);
    expect(h.lines).toEqual([]);
    await expectNoHitTaken(h);
  });

  test('the caps the rows use are the contract constants acs-3.2', () => {
    expect(MAX_ATTEST_BODY_BYTES).toBe(1024);
    expect(MAX_WORLD_LENGTH).toBe(512);
    expect(MAX_NONCE_LENGTH).toBe(128);
    expect(ATTEST_PATH).toBe('/attest');
  });

  test('a token that was valid is refused once the injected clock reaches its exp acs-3.2', async () => {
    const h = await harness();
    const token = good(h, claims({ exp: T0 + 100 }));
    attestationOf(await post(h, token));
    clock = T0 + 99;
    attestationOf(await post(h, token));
    clock = T0 + 100;
    expectRefusal(await post(h, token), 401, 'invalid_token');
  });

  test('an account that is gone, or not entitled, is refused 403 not_entitled with no attestation acs-3.2', async () => {
    const h = await harness();
    h.accounts.delete(SUB);
    expectRefusal(await post(h, good(h)), 403, 'not_entitled', {});
    h.accounts.set(SUB2, { sub: SUB2, entitled: false });
    expectRefusal(await post(h, good(h, claims({ sub: SUB2 }))), 403, 'not_entitled', {});
    expect(h.state.reads).toEqual([SUB, SUB2]);
    expect(h.lines).toEqual([]);
  });

  test('the account is read afresh for every attestation acs-3.2', async () => {
    const h = await harness();
    const token = good(h);
    attestationOf(await post(h, token));
    h.accounts.set(SUB, { sub: SUB, entitled: false });
    expectRefusal(await post(h, token), 403, 'not_entitled', {});
    h.accounts.set(SUB, { sub: SUB, entitled: true });
    attestationOf(await post(h, token));
    expect(h.state.reads).toEqual([SUB, SUB, SUB]);
  });

  test('a token from a second login key in loginKeys is accepted, as is one from the first acs-3.2', async () => {
    const first = generateSigningKey();
    const second = generateSigningKey();
    const h = await harness({ loginKeys: { keys: [first, second] } });
    const bySecond = forge({ alg: 'ES256', kid: second.kid }, claims(), es(second));
    expect(payloadOf(attestationOf(await post(h, bySecond))).sub).toBe(SUB);
    expect(payloadOf(attestationOf(await post(h, await joseToken(first)))).sub).toBe(SUB);
  });

  interface Accepted {
    readonly name: string;
    readonly build: Build;
    readonly world?: string;
    readonly nonce?: string;
  }

  const ACCEPTED: readonly Accepted[] = [
    {
      name: 'a token whose exp is one second after now',
      build: (h) => withToken(good(h, claims({ exp: clock + 1 }))),
    },
    { name: 'the scheme written bearer', build: (h) => withAuthorization(`bearer ${good(h)}`) },
    { name: 'the scheme written BEARER', build: (h) => withAuthorization(`BEARER ${good(h)}`) },
    {
      name: 'application/json; charset=utf-8',
      build: (h) => withToken(good(h), body(), 'application/json; charset=utf-8'),
    },
    { name: 'APPLICATION/JSON', build: (h) => withToken(good(h), body(), 'APPLICATION/JSON') },
    {
      name: 'application/json with spaces before its parameter',
      build: (h) => withToken(good(h), body(), 'application/json ; charset=utf-8'),
    },
    {
      name: 'a body of exactly 1024 bytes',
      build: (h) => withToken(good(h), padded(body(), 1024)),
    },
    {
      name: 'a body in chunks with no Content-Length',
      build: (h) => ({ ...withToken(good(h)), chunked: true }),
    },
    {
      name: 'a world of 512 and a nonce of 128 characters',
      build: (h) => withToken(good(h), body('w'.repeat(512), 'n'.repeat(128))),
      world: 'w'.repeat(512),
      nonce: 'n'.repeat(128),
    },
    {
      name: 'the members in the other order',
      build: (h) => withToken(good(h), JSON.stringify({ nonce: NONCE, world: WORLD })),
    },
    {
      name: 'Host LOCALHOST:4455',
      build: (h) => {
        const call = withToken(good(h));
        return { ...call, headers: { ...call.headers, host: 'LOCALHOST:4455' } };
      },
    },
  ];

  test.each(ACCEPTED)('$name is answered with an attestation acs-3.2', async ({
    build,
    world = WORLD,
    nonce = NONCE,
  }) => {
    const h = await harness();
    const attestation = attestationOf(await send(h.port, build(h)));
    const verified = await verifyAttestation(attestation, h.attestationKeys.keys[0]!, world);
    expect(verified.payload.nonce).toBe(nonce);
    expect(verified.payload.sub).toBe(SUB);
  });

  const NOT_TAKEN: ReadonlyArray<readonly [string, Build]> = [
    ['/attest?x=1', (h) => ({ ...withToken(good(h)), path: '/attest?x=1' })],
    ['/attest?', (h) => ({ ...withToken(good(h)), path: '/attest?' })],
    ['/attest/', (h) => ({ ...withToken(good(h)), path: '/attest/' })],
    ['/ATTEST', (h) => ({ ...withToken(good(h)), path: '/ATTEST' })],
    ['/Attest', (h) => ({ ...withToken(good(h)), path: '/Attest' })],
    ['//attest', (h) => ({ ...withToken(good(h)), path: '//attest' })],
    ['/attest/x', (h) => ({ ...withToken(good(h)), path: '/attest/x' })],
    [
      'an absolute-form target',
      (h) => ({ ...withToken(good(h)), path: 'http://localhost:4455/attest' }),
    ],
    ['OPTIONS /attest/', () => ({ method: 'OPTIONS', path: '/attest/' })],
    ['GET /attest?x=1', () => ({ method: 'GET', path: '/attest?x=1' })],
    ...['localhost:4456', 'localhost', '127.0.0.1:4455', 'example.com', 'evil.localhost:4455'].map(
      (host): readonly [string, Build] => [
        `Host ${host}`,
        (h) => {
          const call = withToken(good(h));
          return { ...call, headers: { ...call.headers, host } };
        },
      ],
    ),
  ];

  test.each(
    NOT_TAKEN,
  )('%s is not taken: it reaches the fallback untouched acs-3.2', async (_name, build) => {
    const h = await harness();
    const reply = await send(h.port, build(h));
    expect(reply.status).toBe(418);
    expect(reply.body).toBe('fallback');
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    expect(reply.headers['cache-control']).toBeUndefined();
    expect(h.state.fallbacks).toBe(1);
    expect(h.state.reads).toEqual([]);
    expect(h.lines).toEqual([]);
    await expectNoHitTaken(h);
  });

  test.each([
    ['no token', () => ({})],
    ['a valid token', (h: Harness) => ({ authorization: `Bearer ${good(h)}` })],
    ['an invalid token', () => ({ authorization: 'Bearer a.b.c' })],
  ] as ReadonlyArray<
    readonly [string, (h: Harness) => Record<string, string>]
  >)('OPTIONS with %s is 204 with the preflight headers and no body acs-3.2', async (_name, headers) => {
    const h = await harness();
    const reply = await send(h.port, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5290',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
        ...headers(h),
      },
    });
    expect(reply.status).toBe(204);
    expect(reply.body).toBe('');
    expectRouteHeaders(reply, false);
    expect(reply.headers['access-control-allow-methods']).toBe('POST');
    expect(reply.headers['access-control-allow-headers']).toBe('authorization, content-type');
    expect(reply.headers['access-control-max-age']).toBe('600');
    expect(h.state.reads).toEqual([]);
    expect(h.lines).toEqual([]);
    await expectNoHitTaken(h);
  });
});

// ---- acs-3.3 ----

describe('the limit of 20 attestations an hour per account', () => {
  test('20 pass and the 21st is 429 rate_limited, retry-after counting to the first hit turning an hour old acs-3.3', async () => {
    expect(ATTESTATION_LIMIT).toBe(20);
    expect(ATTESTATION_WINDOW_SECONDS).toBe(3600);
    const h = await harness();
    const token = good(h, claims({ exp: T0 + 7200 }));
    for (let i = 0; i < 20; i += 1) {
      clock = T0 + i * 10;
      attestationOf(await post(h, token));
    }
    clock = T0 + 500;
    const refused = await post(h, token);
    expectRefusal(refused, 429, 'rate_limited');
    expect(refused.headers['retry-after']).toBe('3100');
    expect(h.state.reads).toHaveLength(20);
    expect(h.lines).toHaveLength(20);
  });

  test('one second before the hour it is still 429 with retry-after 1; at the hour the next passes, and the window slides acs-3.3', async () => {
    const h = await harness();
    const token = good(h, claims({ exp: T0 + 9000 }));
    for (let i = 0; i < 20; i += 1) {
      clock = T0 + i * 10;
      attestationOf(await post(h, token));
    }
    clock = T0 + 3599;
    const last = await post(h, token);
    expectRefusal(last, 429, 'rate_limited');
    expect(last.headers['retry-after']).toBe('1');
    clock = T0 + 3600;
    attestationOf(await post(h, token));
    const next = await post(h, token);
    expectRefusal(next, 429, 'rate_limited');
    expect(next.headers['retry-after']).toBe('10');
    clock = T0 + 3610;
    attestationOf(await post(h, token));
  });

  test("the limit is per account: a second account is untouched by the first's 20 acs-3.3", async () => {
    const h = await harness();
    const first = good(h);
    const second = good(h, claims({ sub: SUB2 }));
    for (let i = 0; i < 20; i += 1) attestationOf(await post(h, first));
    expectRefusal(await post(h, first), 429, 'rate_limited');
    for (let i = 0; i < 20; i += 1) {
      expect(payloadOf(attestationOf(await post(h, second))).sub).toBe(SUB2);
    }
    expectRefusal(await post(h, second), 429, 'rate_limited');
  });

  test('the limit is keyed by the account, not the token: 20 different tokens of one account use it up acs-3.3', async () => {
    const h = await harness();
    for (let i = 0; i < 20; i += 1) {
      attestationOf(await post(h, good(h, claims({ iat: T0 - i, aud: `client-${i}` }))));
    }
    expectRefusal(await post(h, good(h, claims({ iat: T0 - 99 }))), 429, 'rate_limited');
  });

  test('a 429 holds no attestation, logs nothing and is answered before the account is read, even when it is gone acs-3.3', async () => {
    const h = await harness();
    const token = good(h);
    for (let i = 0; i < 20; i += 1) attestationOf(await post(h, token));
    const lines = h.lines.length;
    const reads = h.state.reads.length;
    h.accounts.delete(SUB);
    const refused = await post(h, token);
    expectRefusal(refused, 429, 'rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(h.lines).toHaveLength(lines);
    expect(h.state.reads).toHaveLength(reads);
  });

  test.each([
    ['gone', (h: Harness) => h.accounts.delete(SUB)],
    ['not entitled', (h: Harness) => h.accounts.set(SUB, { sub: SUB, entitled: false })],
  ] as ReadonlyArray<
    readonly [string, (h: Harness) => unknown]
  >)('a request refused because the account is %s keeps its hit: after 20, an entitled account is 429 acs-3.3', async (_name, change) => {
    const h = await harness();
    const token = good(h);
    change(h);
    for (let i = 0; i < 20; i += 1) {
      expectRefusal(await post(h, token), 403, 'not_entitled', {});
    }
    h.accounts.set(SUB, { sub: SUB, entitled: true });
    expectRefusal(await post(h, token), 429, 'rate_limited');
  });

  test('a request that ends in 500 gives its hit back: after 25 such, 20 pass acs-3.3', async () => {
    const h = await harness();
    const token = good(h);
    h.state.failure = { kind: 'reject', value: new Error('the account store is down') };
    for (let i = 0; i < 25; i += 1) {
      expectRefusal(await post(h, token), 500, 'server_error', {});
    }
    h.state.failure = undefined;
    await expectNoHitTaken(h);
  });
});

// ---- acs-3.4 ----

describe('the attestation key set and the login key set are disjoint', () => {
  test('an attestation does not verify under the login key set acs-3.4', async () => {
    const h = await harness();
    const attestation = attestationOf(await post(h, good(h)));
    await expect(verifyAttestation(attestation, h.attestationKeys.keys[0]!)).resolves.toBeDefined();
    const loginSet = createLocalJWKSet({ keys: h.loginKeys.keys.map(loginPublic) });
    await expect(
      jwtVerify(attestation, loginSet, { currentDate: new Date(clock * 1000) }),
    ).rejects.toThrow();
  });

  test('a login token does not verify under the attestation key set acs-3.4', async () => {
    const h = await harness();
    const token = await joseToken(h.login);
    const loginSet = createLocalJWKSet({ keys: h.loginKeys.keys.map(loginPublic) });
    await expect(
      jwtVerify(token, loginSet, { currentDate: new Date(clock * 1000) }),
    ).resolves.toBeDefined();
    const attestationSet = createLocalJWKSet({
      keys: h.attestationKeys.keys.map(attestationPublic),
    });
    await expect(
      jwtVerify(token, attestationSet, { currentDate: new Date(clock * 1000) }),
    ).rejects.toThrow();
  });

  test('an attestation sent back as the bearer token is refused 401 acs-3.4', async () => {
    const h = await harness();
    const attestation = attestationOf(await post(h, good(h)));
    expectRefusal(await post(h, attestation), 401, 'invalid_token');
  });

  test('a token signed with the attestation private key under alg ES256 is refused 401 acs-3.4', async () => {
    const h = await harness();
    const key = h.attestationKeys.keys[0]!;
    const signer = ed(privateKeyOf(key));
    for (const kid of [key.kid, h.login.kid]) {
      const token = forge({ alg: 'ES256', kid }, claims(), signer);
      expectRefusal(await post(h, token), 401, 'invalid_token');
    }
    // Under its own alg too: an ID token shape signed by the attestation key is no login token.
    const own = forge({ alg: 'Ed25519', kid: key.kid }, claims(), signer);
    expectRefusal(await post(h, own), 401, 'invalid_token');
  });
});

// ---- acs-3.5 ----

const WORLD_MARK = 'dns:WORLDMARK-q7Zr2XvKp9Lm.example:3000/WORLDMARK-c41d9f0e';
const NONCE_MARK = 'NONCEMARK-8Jt3Lw0QyVbH5n';

function markedBody(): string {
  return body(WORLD_MARK, NONCE_MARK);
}

function expectCleanLines(lines: readonly string[], secrets: readonly string[]): void {
  for (const line of lines) {
    expect(line).not.toContain('WORLDMARK');
    expect(line).not.toContain('NONCEMARK');
    for (const secret of secrets) expect(line).not.toContain(secret);
  }
}

describe('what the route logs', () => {
  test('no line holds the world, the nonce, a token or an attestation; a success logs one line, a 500 one, anything else none acs-3.5', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    const h = await harness();
    h.accounts.set(SUB2, { sub: SUB2, entitled: false });
    const secrets: string[] = [];
    const remember = (token: string): string => {
      secrets.push(token, ...token.split('.').filter((part) => part.length > 0));
      return token;
    };

    const step = async (call: Call, status: number, added: number): Promise<Reply> => {
      const before = h.lines.length;
      const reply = await send(h.port, call);
      expect(reply.status, reply.body).toBe(status);
      expect(h.lines.length - before, `${status} logged`).toBe(added);
      return reply;
    };

    const token = remember(good(h, claims({ exp: T0 + 7200 })));
    const success = async (): Promise<void> => {
      const reply = await step(withToken(token, markedBody()), 200, 1);
      remember(attestationOf(reply));
      const line = h.lines[h.lines.length - 1]!;
      expect(line).toContain(SUB);
      expect(line).toContain(iso(clock));
    };

    await success();
    clock += 7;
    await success();

    await step({ ...withToken(token, markedBody()), method: 'GET' }, 405, 0);
    await step({ ...withToken(token, markedBody()), method: 'PUT' }, 405, 0);
    await step({ method: 'OPTIONS', headers: { authorization: `Bearer ${token}` } }, 204, 0);
    await step({ headers: { 'content-type': JSON_TYPE }, body: markedBody() }, 401, 0);
    const forged = remember(forge({ alg: 'ES256', kid: h.login.kid }, claims(), es(otherLogin)));
    await step(withToken(forged, markedBody()), 401, 0);
    const expired = remember(good(h, claims({ exp: clock })));
    await step(withToken(expired, markedBody()), 401, 0);
    const unentitled = remember(good(h, claims({}, 'mr_ent')));
    await step(withToken(unentitled, markedBody()), 403, 0);
    await step(withToken(token, markedBody(), 'text/plain'), 415, 0);
    await step(withToken(token, padded(markedBody(), 1500)), 413, 0);
    await step(
      withToken(token, JSON.stringify({ world: WORLD_MARK, nonce: NONCE_MARK, x: WORLD_MARK })),
      400,
      0,
    );
    await step(withToken(token, body(`${WORLD_MARK} x`, NONCE_MARK)), 400, 0);
    await step(withToken(token, body(WORLD_MARK, `${NONCE_MARK} x`)), 400, 0);
    const second = remember(good(h, claims({ sub: SUB2 })));
    await step(withToken(second, markedBody()), 403, 0);

    // The service failing: one line with the account, never the error's message.
    const failures: Failure[] = [
      { kind: 'reject', value: new Error(`the store is down for ${WORLD_MARK} ${NONCE_MARK}`) },
      { kind: 'reject', value: `rejected for ${WORLD_MARK}` },
      { kind: 'reject', value: undefined },
      { kind: 'throw', value: new TypeError(`thrown for ${NONCE_MARK}`) },
    ];
    for (const failure of failures) {
      h.state.failure = failure;
      await step(withToken(token, markedBody()), 500, 1);
      expect(h.lines[h.lines.length - 1]).toContain(SUB);
    }
    h.state.failure = undefined;

    // 18 more successes use up the hour; the 21st is a 429.
    for (let i = 0; i < 18; i += 1) await success();
    await step(withToken(token, markedBody()), 429, 0);

    expect(h.lines).toHaveLength(20 + failures.length);
    expectCleanLines(h.lines, secrets);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test('a signing failure is a 500 that logs one line with the account and no world, nonce or token acs-3.5', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    const unusable: AttestationJwk = { ...generateAttestationKey(), d: '' };
    const h = await harness({ attestationKeys: { keys: [unusable] } });
    const token = good(h);
    const reply = await post(h, token, markedBody());
    expectRefusal(reply, 500, 'server_error', {});
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain(SUB);
    expectCleanLines(h.lines, [token, ...token.split('.')]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

// ---- the handler never throws ----

const UNREADABLE = new Proxy(
  {},
  {
    get() {
      throw new Error('every read of this value throws');
    },
  },
);

function watchUnhandled(): unknown[] {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  cleanups.push(() => {
    process.off('unhandledRejection', listener);
  });
  return seen;
}

describe('the route never throws and keeps serving', () => {
  // Built inside the test, so the runner never formats the unreadable value into a title.
  const failures: ReadonlyArray<readonly [string, () => Failure]> = [
    ['rejects with an Error', () => ({ kind: 'reject', value: new Error('down') })],
    ['rejects with a string', () => ({ kind: 'reject', value: 'down' })],
    ['rejects with undefined', () => ({ kind: 'reject', value: undefined })],
    [
      'rejects with a value whose every property read throws',
      () => ({ kind: 'reject', value: UNREADABLE }),
    ],
    ['throws an Error synchronously', () => ({ kind: 'throw', value: new Error('thrown') })],
    ['throws a string synchronously', () => ({ kind: 'throw', value: 'thrown' })],
  ];

  test.each(
    failures,
  )('an account that %s answers 500 server_error, and the next request is answered 200', async (_name, failure) => {
    const unhandled = watchUnhandled();
    const h = await harness();
    const token = good(h);
    h.state.failure = failure();
    expectRefusal(await post(h, token), 500, 'server_error', {});
    h.state.failure = undefined;
    attestationOf(await post(h, token));
    expect(unhandled).toEqual([]);
  });

  test('a request destroyed after its headers and half its body leaves the server answering the next', async () => {
    const unhandled = watchUnhandled();
    const h = await harness();
    const token = good(h);
    const full = body();
    const arrived = new Promise<void>((resolve) => {
      h.state.taken.push(resolve);
    });
    const socket = connect(h.port, '127.0.0.1');
    socket.on('error', () => {
      // destroyed on purpose
    });
    await new Promise<void>((resolve) => {
      socket.once('connect', () => {
        resolve();
      });
    });
    socket.write(
      `POST ${ATTEST_PATH} HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer ${token}\r\n` +
        `Content-Type: ${JSON_TYPE}\r\nContent-Length: ${full.length}\r\n\r\n` +
        full.slice(0, Math.floor(full.length / 2)),
    );
    await arrived;
    socket.destroy();
    attestationOf(await post(h, token));
    // The abandoned request reached no limit row: the hour still holds 19 more.
    for (let i = 0; i < 19; i += 1) attestationOf(await post(h, token));
    expect((await post(h, token)).status).toBe(429);
    expect(unhandled).toEqual([]);
  });
});
