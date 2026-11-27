import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import type { AdapterPayload } from 'oidc-provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type SteamStub,
  type SteamStubAnswer,
  type SteamStubOwnership,
  startSteamStub,
} from '../../test-util/steamStub.ts';
import { ID_TOKEN_CLAIMS } from '../claims.ts';
import { type DenyList, denyList, type SteamAccounts, steamAccounts } from '../denyList.ts';
import type { SteamTicketGrantOptions } from '../grants/steamTicket.ts';
import { generateSigningKey, type SigningJwk } from '../keys.ts';
import { createAccountProvider, registerClient, SIGN_IN_TTL_SECONDS } from '../provider.ts';
import { createSourceAddress } from '../rateLimit.ts';
import { parseSteamId, type SteamId, steamEntitlementSource } from '../steam/ownership.ts';
import { createSteamWebApi } from '../steam/webApi.ts';
import { type AccountStore, openAccountStore } from '../store/sqliteAdapter.ts';
import { type DevAccounts, devAccounts, devPasswordStep } from './devPassword.ts';
import { endedPage, notOwnedPage, signInPage, unavailablePage } from './pages.ts';
import { type PasswordStep, signInStepFor } from './router.ts';

// The whole sign-in over HTTP: the SQLite store, the real password step, the provider's handler.

const ISSUER = 'http://localhost:4455';
const HOST = 'localhost:4455';
const CLIENT_ID = 'monster-realm';
const REDIRECT_URI = 'http://localhost:5290/';
const CLIENT_ORIGIN = 'http://localhost:5290';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const T0 = 1_800_000_000_000;
const T0_SECONDS = T0 / 1000;
// Values the spec fixes: a code lives 60 seconds, an ID token an hour, a chain 30 days.
const CODE_SECONDS = 60;
const ID_TOKEN_SECONDS = 3600;
const CHAIN_SECONDS = 30 * 24 * 3600;

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const all = { ...headers };
    if (body !== undefined) all['content-length'] = String(Buffer.byteLength(body));
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: all, agent: false },
      (res) => {
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
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// A browser's cookie jar, as far as this flow needs one.
interface Cookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
}

interface Jar {
  cookies: Cookie[];
}

function newJar(): Jar {
  return { cookies: [] };
}

function absorb(jar: Jar, reply: Reply): void {
  for (const line of reply.headers['set-cookie'] ?? []) {
    const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const pathAttribute = attributes.find((a) => a.toLowerCase().startsWith('path='));
    const path = pathAttribute === undefined ? '/' : pathAttribute.slice('path='.length);
    const expired = attributes.some(
      (a) => a.toLowerCase().startsWith('expires=') && Date.parse(a.slice(8)) <= Date.now(),
    );
    jar.cookies = jar.cookies.filter((c) => !(c.name === name && c.path === path));
    if (!expired && value !== '') jar.cookies.push({ name, value, path });
  }
}

function pathCovers(cookiePath: string, path: string): boolean {
  if (cookiePath === '/' || path === cookiePath) return true;
  return path.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

function cookiesFor(jar: Jar, target: string): string {
  const path = target.split('?')[0] ?? target;
  return jar.cookies
    .filter((c) => pathCovers(c.path, path))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// One fresh service per test: its own temp directory, database file, keys, accounts and server.
interface Row {
  readonly model: string;
  readonly id: string;
  readonly payload: string;
  readonly grant_id: string | null;
}

interface World {
  readonly port: number;
  readonly dir: string;
  readonly dbPath: string;
  readonly store: AccountStore;
  readonly keys: readonly SigningJwk[];
  readonly accounts: DevAccounts;
}

interface WorldOptions {
  readonly keyCount?: number;
  readonly maxPendingSignIns?: number;
  /** Wraps the real password step (to make its `account` fail, say). */
  readonly step?: (real: PasswordStep) => PasswordStep;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

function freezeAt(ms: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ms);
}

async function world(options: WorldOptions = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'acs2-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const dbPath = join(dir, 'account.sqlite');
  const store = openAccountStore(dbPath);
  cleanups.push(() => {
    store.close();
  });
  await registerClient(store.adapter, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
  const keys = Array.from({ length: options.keyCount ?? 1 }, () => generateSigningKey());
  const real = devPasswordStep(store.adapter);
  const { handler } = createAccountProvider({
    issuer: ISSUER,
    keys: { keys },
    adapter: store.adapter,
    signIn: options.step === undefined ? real : options.step(real),
    maxPendingSignIns: options.maxPendingSignIns,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  return {
    port: (server.address() as AddressInfo).port,
    dir,
    dbPath,
    store,
    keys,
    accounts: devAccounts(store.adapter),
  };
}

function rows(w: World): Row[] {
  const db = new DatabaseSync(w.dbPath, { readOnly: true });
  try {
    return db
      .prepare('SELECT model, id, payload, grant_id FROM oidc_record')
      .all() as unknown as Row[];
  } finally {
    db.close();
  }
}

function expectStoredUnderDigest(
  w: World,
  records: ReadonlyArray<readonly [string, string]>,
): void {
  const stored = rows(w);
  for (const [model, value] of records) {
    const digest = createHash('sha256').update(value).digest('base64url');
    const matching = stored.filter((row) => row.id === digest);
    expect(matching, `${model} under its digest`).toHaveLength(1);
    expect(matching[0]!.model).toBe(model);
    expect((JSON.parse(matching[0]!.payload) as Record<string, unknown>).jti).toBe(digest);
  }
}

function interactionExpiries(w: World): number[] {
  const db = new DatabaseSync(w.dbPath, { readOnly: true });
  try {
    const found = db
      .prepare("SELECT expires_at FROM oidc_record WHERE model = 'Interaction'")
      .all() as unknown as Array<{ expires_at: number | null }>;
    return found.map((row) => Number(row.expires_at));
  } finally {
    db.close();
  }
}

function grantIds(w: World): string[] {
  return rows(w)
    .filter((row) => row.model === 'Grant')
    .map((row) => row.id);
}

function recordsOfGrant(w: World, grantId: string): Row[] {
  return rows(w).filter(
    (row) => row.grant_id === grantId || (row.model === 'Grant' && row.id === grantId),
  );
}

interface Person {
  readonly email: string;
  readonly sub: string;
  readonly password: string;
}

async function person(w: World, entitled = true): Promise<Person> {
  const email = `player-${randomBytes(5).toString('hex')}@example.com`;
  const { account, password } = await w.accounts.create(email, { entitled });
  return { email, sub: account.sub, password };
}

interface CallOptions {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** `undefined`: the jar's cookies for the target; `null`: none; a string: exactly that. */
  readonly cookie?: string | null;
}

async function call(
  w: World,
  jar: Jar,
  method: string,
  target: string,
  options: CallOptions = {},
): Promise<Reply> {
  const headers: Record<string, string> = { host: HOST, ...options.headers };
  const cookie = options.cookie === undefined ? cookiesFor(jar, target) : options.cookie;
  if (cookie !== null && cookie !== '') headers.cookie = cookie;
  const reply = await send(w.port, method, target, headers, options.body);
  absorb(jar, reply);
  return reply;
}

const GOOD_POST: Record<string, string> = { origin: ISSUER, 'content-type': FORM_TYPE };

function credentials(email: string, password: string): string {
  return new URLSearchParams({ email, password }).toString();
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function authQuery(extra: Record<string, string> = {}): {
  verifier: string;
  state: string;
  query: string;
} {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(9).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state,
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
    ...extra,
  }).toString();
  return { verifier, state, query };
}

interface Started {
  readonly uid: string;
  readonly path: string;
  readonly state: string;
  readonly verifier: string;
}

function interactionUid(location: string | undefined): string {
  const target = new URL(String(location), ISSUER);
  expect(target.origin).toBe(ISSUER);
  const match = /^\/interaction\/([^/]+)$/.exec(target.pathname);
  expect(match, target.href).not.toBeNull();
  expect(target.searchParams.has('code')).toBe(false);
  return match![1]!;
}

async function begin(w: World, jar: Jar, extra: Record<string, string> = {}): Promise<Started> {
  const { verifier, state, query } = authQuery(extra);
  const reply = await call(w, jar, 'GET', `/auth?${query}`);
  expect(reply.status, reply.body).toBe(303);
  const uid = interactionUid(reply.headers.location);
  return { uid, path: `/interaction/${uid}`, state, verifier };
}

interface Signed {
  readonly code: string;
  readonly verifier: string;
  readonly jar: Jar;
  readonly grantId: string;
}

async function signInToCode(
  w: World,
  email: string,
  password: string,
  extra: Record<string, string> = {},
): Promise<Signed> {
  const before = grantIds(w);
  const jar = newJar();
  const started = await begin(w, jar, extra);
  const form = await call(w, jar, 'GET', started.path);
  expect(form.status).toBe(200);
  expect(form.body).toBe(signInPage({ action: started.path }));
  const posted = await call(w, jar, 'POST', started.path, {
    headers: GOOD_POST,
    body: credentials(email, password),
  });
  expect(posted.status, posted.body).toBe(303);
  expect(posted.headers.location).toBe(`${ISSUER}/auth/${started.uid}`);
  const resumed = await call(w, jar, 'GET', `/auth/${started.uid}`);
  expect(resumed.status, resumed.body).toBe(303);
  const back = new URL(String(resumed.headers.location));
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  expect(back.searchParams.get('state')).toBe(started.state);
  expect(back.searchParams.get('iss')).toBe(ISSUER);
  const code = back.searchParams.get('code');
  expect(code).toEqual(expect.any(String));
  const fresh = grantIds(w).filter((id) => !before.includes(id));
  expect(fresh).toHaveLength(1);
  return { code: code!, verifier: started.verifier, jar, grantId: fresh[0]! };
}

interface TokenReply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly json: Record<string, unknown>;
}

async function token(
  w: World,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<TokenReply> {
  const reply = await send(
    w.port,
    'POST',
    '/token',
    { host: HOST, 'content-type': FORM_TYPE, ...headers },
    new URLSearchParams(fields).toString(),
  );
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(reply.body) as Record<string, unknown>;
  } catch {
    // not JSON: the assertions on `json` then fail with the status in view
  }
  return { status: reply.status, headers: reply.headers, json };
}

function exchange(
  w: World,
  code: string,
  verifier: string,
  headers: Record<string, string> = {},
): Promise<TokenReply> {
  return token(
    w,
    {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    },
    headers,
  );
}

function refresh(w: World, refreshToken: string): Promise<TokenReply> {
  return token(w, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
}

function expectInvalidGrant(reply: TokenReply): void {
  expect(reply.status, JSON.stringify(reply.json)).toBe(400);
  expect(reply.json.error).toBe('invalid_grant');
}

interface Tokens {
  readonly id_token: string;
  readonly access_token: string;
  readonly refresh_token: string;
}

function tokensOf(reply: TokenReply): Tokens {
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  const { id_token, access_token, refresh_token } = reply.json;
  expect(id_token).toEqual(expect.any(String));
  expect(access_token).toEqual(expect.any(String));
  expect(refresh_token).toEqual(expect.any(String));
  return {
    id_token: id_token as string,
    access_token: access_token as string,
    refresh_token: refresh_token as string,
  };
}

async function signInToTokens(
  w: World,
  who: Person,
  extra: Record<string, string> = {},
): Promise<Signed & { readonly tokens: Tokens }> {
  const signed = await signInToCode(w, who.email, who.password, extra);
  return { ...signed, tokens: tokensOf(await exchange(w, signed.code, signed.verifier)) };
}

function decodeSegment(segment: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(String(segment), 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function headerOf(jwt: string): Record<string, unknown> {
  return decodeSegment(jwt.split('.')[0]);
}

function payloadOf(jwt: string): Record<string, unknown> {
  return decodeSegment(jwt.split('.')[1]);
}

const SUBJECT = /^dev:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function expectIdTokenClaims(jwt: string, who: Person): Record<string, unknown> {
  const payload = payloadOf(jwt);
  expect(Object.keys(payload).sort()).toEqual([...ID_TOKEN_CLAIMS].sort());
  expect(payload.iss).toBe(ISSUER);
  expect(payload.sub).toBe(who.sub);
  expect(payload.aud).toBe(CLIENT_ID);
  expect(payload.mr_ent).toEqual(['base-game']);
  expect(Number(payload.exp) - Number(payload.iat)).toBe(ID_TOKEN_SECONDS);
  return payload;
}

async function servedKeySet(w: World): Promise<JSONWebKeySet> {
  const reply = await send(w.port, 'GET', '/jwks', { host: HOST });
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body) as JSONWebKeySet;
}

const UNCHALLENGED: ReadonlyArray<readonly [string, Record<string, string | undefined>]> = [
  ['without a code_challenge', { code_challenge: undefined, code_challenge_method: undefined }],
  ['with code_challenge_method=plain', { code_challenge_method: 'plain' }],
];

describe('an entitled account signs in', () => {
  test('the right password gives a code that exchanges for an ID token with exactly the named claims, and a refresh token acs-2.1', async () => {
    freezeAt(T0);
    const w = await world({ keyCount: 2 });
    const who = await person(w);
    expect(who.sub).toMatch(SUBJECT);
    const signed = await signInToCode(w, who.email, who.password);
    const reply = await exchange(w, signed.code, signed.verifier);
    const tokens = tokensOf(reply);
    expect(reply.json.token_type).toBe('Bearer');
    expect(reply.json.expires_in).toEqual(expect.any(Number));
    expect(tokens.refresh_token).not.toBe(tokens.access_token);

    expect(headerOf(tokens.id_token).alg).toBe('ES256');
    expect(headerOf(tokens.id_token).kid).toBe(w.keys[0]!.kid);
    expectIdTokenClaims(tokens.id_token, who);
    expect(payloadOf(tokens.id_token)).toEqual({
      iss: ISSUER,
      sub: who.sub,
      aud: CLIENT_ID,
      mr_ent: ['base-game'],
      iat: T0_SECONDS,
      exp: T0_SECONDS + ID_TOKEN_SECONDS,
    });
  });

  test('a second exchange of the code is refused and ends the chain: the refresh token stops working and no record of the grant remains acs-2.1', async () => {
    const w = await world();
    const who = await person(w);
    const signed = await signInToTokens(w, who);
    // The control: the grant has records before the replay.
    expect(recordsOfGrant(w, signed.grantId).length).toBeGreaterThan(1);

    expectInvalidGrant(await exchange(w, signed.code, signed.verifier));
    expectInvalidGrant(await refresh(w, signed.tokens.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
  });

  test('a code presented 60 seconds after it was issued is refused, and one second earlier it is exchanged acs-2.1', async () => {
    freezeAt(T0);
    const w = await world();
    const who = await person(w);

    const late = await signInToCode(w, who.email, who.password);
    vi.setSystemTime(T0 + CODE_SECONDS * 1000);
    expectInvalidGrant(await exchange(w, late.code, late.verifier));

    const issuedAt = T0 + 120_000;
    vi.setSystemTime(issuedAt);
    const onTime = await signInToCode(w, who.email, who.password);
    vi.setSystemTime(issuedAt + (CODE_SECONDS - 1) * 1000);
    tokensOf(await exchange(w, onTime.code, onTime.verifier));
  });

  test('a wrong PKCE verifier is refused and does not burn the code acs-2.1', async () => {
    const w = await world();
    const who = await person(w);
    const signed = await signInToCode(w, who.email, who.password);
    const wrong = randomBytes(32).toString('base64url');
    expectInvalidGrant(await exchange(w, signed.code, wrong));
    expectIdTokenClaims(tokensOf(await exchange(w, signed.code, signed.verifier)).id_token, who);
  });

  test.each(
    UNCHALLENGED,
  )('an authorization request %s is sent back with invalid_request and starts no sign-in acs-2.1', async (_name, change) => {
    const w = await world();
    const verifier = randomBytes(32).toString('base64url');
    const params: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      state: 'st',
      code_challenge: verifier,
      code_challenge_method: 'S256',
      ...change,
    };
    const query = new URLSearchParams(
      Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const reply = await send(w.port, 'GET', `/auth?${query}`, { host: HOST });
    expect([302, 303]).toContain(reply.status);
    const back = new URL(String(reply.headers.location));
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    expect(back.searchParams.get('error')).toBe('invalid_request');
    expect(back.searchParams.has('code')).toBe(false);
    expect(reply.headers['set-cookie'] ?? []).toEqual([]);
    expect(rows(w).filter((row) => row.model === 'Interaction')).toEqual([]);
  });

  test('a request that sends a nonce gets an ID token that adds only nonce acs-2.1', async () => {
    const w = await world();
    const who = await person(w);
    const signed = await signInToTokens(w, who, { nonce: 'n-0S6_WzA2Mj' });
    const payload = payloadOf(signed.tokens.id_token);
    expect(Object.keys(payload).sort()).toEqual([...ID_TOKEN_CLAIMS, 'nonce'].sort());
    expect(payload.nonce).toBe('n-0S6_WzA2Mj');
    expect(payload.sub).toBe(who.sub);
  });

  test("another client's code is refused acs-2.1", async () => {
    const w = await world();
    await registerClient(w.store.adapter, {
      clientId: 'other-game',
      redirectUri: 'http://localhost:5391/',
    });
    const who = await person(w);
    const signed = await signInToCode(w, who.email, who.password);
    expectInvalidGrant(
      await token(w, {
        grant_type: 'authorization_code',
        code: signed.code,
        code_verifier: signed.verifier,
        client_id: 'other-game',
        redirect_uri: 'http://localhost:5391/',
      }),
    );
  });

  test("the token endpoint names the client's origin in Access-Control-Allow-Origin and no other origin", async () => {
    const w = await world();
    const who = await person(w);
    const first = await signInToCode(w, who.email, who.password);
    const allowed = await exchange(w, first.code, first.verifier, { origin: CLIENT_ORIGIN });
    tokensOf(allowed);
    expect(allowed.headers['access-control-allow-origin']).toBe(CLIENT_ORIGIN);

    const second = await signInToCode(w, who.email, who.password);
    const foreign = await exchange(w, second.code, second.verifier, {
      origin: 'http://evil.example',
    });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the ID token checked with the served key set', () => {
  test('verifies with jose under /jwks one second before its exp, and is refused as expired at its exp acs-2.7', async () => {
    freezeAt(T0);
    const w = await world({ keyCount: 2 });
    const who = await person(w);
    const signed = await signInToTokens(w, who);
    const keySet = createLocalJWKSet(await servedKeySet(w));
    const options = { issuer: ISSUER, audience: CLIENT_ID };

    const verified = await jwtVerify(signed.tokens.id_token, keySet, {
      ...options,
      currentDate: new Date((T0_SECONDS + ID_TOKEN_SECONDS - 1) * 1000),
    });
    expect(verified.payload.sub).toBe(who.sub);
    expect(verified.payload.iat).toBe(T0_SECONDS);
    expect(verified.protectedHeader.alg).toBe('ES256');
    expect(verified.protectedHeader.kid).toBe(w.keys[0]!.kid);

    await expect(
      jwtVerify(signed.tokens.id_token, keySet, {
        ...options,
        currentDate: new Date((T0_SECONDS + ID_TOKEN_SECONDS) * 1000),
      }),
    ).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
  });

  test('a token with any one payload byte changed does not verify, nor under a key set without the first key acs-2.7', async () => {
    freezeAt(T0);
    const w = await world({ keyCount: 2 });
    const who = await person(w);
    const signed = await signInToTokens(w, who);
    const served = await servedKeySet(w);
    const keySet = createLocalJWKSet(served);
    const options = {
      issuer: ISSUER,
      audience: CLIENT_ID,
      currentDate: new Date((T0_SECONDS + 1) * 1000),
    };
    // The control: the untouched token verifies.
    await expect(jwtVerify(signed.tokens.id_token, keySet, options)).resolves.toBeDefined();

    const [header, payload, signature] = signed.tokens.id_token.split('.');
    const bytes = Buffer.from(String(payload), 'base64url');
    expect(bytes.length).toBeGreaterThan(0);
    for (let i = 0; i < bytes.length; i += 1) {
      const changed = Buffer.from(bytes);
      changed[i] ^= 0x01;
      const forged = `${header}.${changed.toString('base64url')}.${signature}`;
      await expect(jwtVerify(forged, keySet, options), `payload byte ${i}`).rejects.toMatchObject({
        code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
      });
    }

    const withoutFirst = createLocalJWKSet({
      keys: served.keys.filter((key) => key.kid !== w.keys[0]!.kid),
    });
    expect(served.keys.length).toBe(2);
    await expect(jwtVerify(signed.tokens.id_token, withoutFirst, options)).rejects.toBeDefined();
  });

  test('an ID token from a refresh verifies too, carrying the same claims acs-2.7', async () => {
    freezeAt(T0);
    const w = await world();
    const who = await person(w);
    const signed = await signInToTokens(w, who);
    vi.setSystemTime(T0 + 600_000);
    const rotated = tokensOf(await refresh(w, signed.tokens.refresh_token));
    const payload = expectIdTokenClaims(rotated.id_token, who);
    expect(payload.iat).toBe(T0_SECONDS + 600);
    const keySet = createLocalJWKSet(await servedKeySet(w));
    const verified = await jwtVerify(rotated.id_token, keySet, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      currentDate: new Date((T0_SECONDS + 600 + ID_TOKEN_SECONDS - 1) * 1000),
    });
    expect(verified.payload.sub).toBe(who.sub);
  });
});

describe('an account created without entitlement', () => {
  test('gets the not-owned page, the same bytes for two such accounts naming neither, and no code by any continuation acs-2.2', async () => {
    const w = await world();
    const pages: string[] = [];
    const people = [await person(w, false), await person(w, false)];
    for (const who of people) {
      const jar = newJar();
      const started = await begin(w, jar);
      for (let i = 0; i < 2; i += 1) {
        const posted = await call(w, jar, 'POST', started.path, {
          headers: GOOD_POST,
          body: credentials(who.email, who.password),
        });
        expect(posted.status).toBe(403);
        expect(posted.body).toBe(notOwnedPage());
        expect(posted.headers.location).toBeUndefined();
        pages.push(posted.body);
      }
      const resumed = await call(w, jar, 'GET', `/auth/${started.uid}`);
      expect(resumed.status).toBe(303);
      expect(interactionUid(resumed.headers.location)).not.toBe(started.uid);
      expect(String(resumed.headers.location)).not.toContain('code=');
    }
    for (const page of pages) {
      expect(page).toBe(pages[0]);
      for (const who of people) {
        expect(page).not.toContain(who.email);
        expect(page).not.toContain(who.sub);
        expect(page).not.toContain(who.sub.slice('dev:'.length));
      }
    }
    expect(grantIds(w)).toEqual([]);
  });

  test('that stops being entitled between the password step and the resume gets a new sign-in step and no code', async () => {
    const w = await world();
    const who = await person(w);
    const jar = newJar();
    const started = await begin(w, jar);
    const posted = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials(who.email, who.password),
    });
    expect(posted.status).toBe(303);
    await w.accounts.setEntitled(who.email, false);
    const resumed = await call(w, jar, 'GET', `/auth/${started.uid}`);
    expect(resumed.status).toBe(303);
    expect(interactionUid(resumed.headers.location)).not.toBe(started.uid);
    expect(String(resumed.headers.location)).not.toContain('code=');
  });
});

describe('refresh tokens', () => {
  test('a refresh issues a new refresh token; the spent one is then refused and takes the newest with it, leaving no record of the grant acs-2.4', async () => {
    const w = await world();
    const who = await person(w);
    const signed = await signInToTokens(w, who);
    const first = tokensOf(await refresh(w, signed.tokens.refresh_token));
    expect(first.refresh_token).not.toBe(signed.tokens.refresh_token);
    expectIdTokenClaims(first.id_token, who);
    const second = tokensOf(await refresh(w, first.refresh_token));
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.refresh_token).not.toBe(signed.tokens.refresh_token);
    expect(recordsOfGrant(w, signed.grantId).length).toBeGreaterThan(1);

    expectInvalidGrant(await refresh(w, first.refresh_token));
    expectInvalidGrant(await refresh(w, second.refresh_token));
    expectInvalidGrant(await refresh(w, signed.tokens.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
  });

  test("a rotated refresh token keeps the first one's expiry: a refresh works 60 seconds before 30 days and the newest fails 1 second after acs-2.4", async () => {
    freezeAt(T0);
    const w = await world();
    const who = await person(w);
    const signed = await signInToTokens(w, who);
    vi.setSystemTime(T0 + 86_400_000);
    const dayOne = tokensOf(await refresh(w, signed.tokens.refresh_token));
    vi.setSystemTime(T0 + (CHAIN_SECONDS - 60) * 1000);
    const lastMinute = tokensOf(await refresh(w, dayOne.refresh_token));
    expectIdTokenClaims(lastMinute.id_token, who);
    vi.setSystemTime(T0 + (CHAIN_SECONDS + 1) * 1000);
    expectInvalidGrant(await refresh(w, lastMinute.refresh_token));
  });

  test("two sign-ins of one account are two chains: replaying one's spent token leaves the other working acs-2.4", async () => {
    const w = await world();
    const who = await person(w);
    const one = await signInToTokens(w, who);
    const two = await signInToTokens(w, who);
    expect(two.grantId).not.toBe(one.grantId);
    tokensOf(await refresh(w, one.tokens.refresh_token));
    expectInvalidGrant(await refresh(w, one.tokens.refresh_token));
    expect(recordsOfGrant(w, one.grantId)).toEqual([]);
    tokensOf(await refresh(w, two.tokens.refresh_token));
  });
});

describe('the entitlement is read again at every issuance', () => {
  test('a refresh after the entitlement is removed is refused, the chain is revoked, and restoring the flag revives no token of it acs-2.5', async () => {
    const w = await world();
    const who = await person(w);
    const signed = await signInToTokens(w, who);
    const rotated = tokensOf(await refresh(w, signed.tokens.refresh_token));
    await w.accounts.setEntitled(who.email, false);
    expectInvalidGrant(await refresh(w, rotated.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);

    await w.accounts.setEntitled(who.email, true);
    expectInvalidGrant(await refresh(w, rotated.refresh_token));
    expectInvalidGrant(await refresh(w, signed.tokens.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
  });

  test('a code exchange after the entitlement is removed is refused and leaves no record of the grant, flag restored or not acs-2.5', async () => {
    const w = await world();
    const who = await person(w);
    const signed = await signInToCode(w, who.email, who.password);
    await w.accounts.setEntitled(who.email, false);
    expectInvalidGrant(await exchange(w, signed.code, signed.verifier));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
    await w.accounts.setEntitled(who.email, true);
    expectInvalidGrant(await exchange(w, signed.code, signed.verifier));
  });

  test('a refresh for an account that no longer exists is refused and revokes the chain acs-2.5', async () => {
    const w = await world();
    const who = await person(w);
    const signed = await signInToTokens(w, who);
    await w.store.adapter('DevAccount').destroy(who.email);
    expect(await w.accounts.find(who.email)).toBeUndefined();
    expectInvalidGrant(await refresh(w, signed.tokens.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
  });

  test('an account lookup that fails is a server error, revokes nothing, and the same token works once it answers', async () => {
    let down = false;
    const w = await world({
      step: (real) => ({
        kind: 'password',
        attempt: (email, password) => real.attempt(email, password),
        account: (sub) =>
          down ? Promise.reject(new Error('the account store is down')) : real.account(sub),
      }),
    });
    const who = await person(w);
    const signed = await signInToTokens(w, who);
    const before = recordsOfGrant(w, signed.grantId).length;
    down = true;
    const failed = await refresh(w, signed.tokens.refresh_token);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(failed.status).toBeLessThan(600);
    expect(failed.json.error).toBe('server_error');
    expect(recordsOfGrant(w, signed.grantId)).toHaveLength(before);
    down = false;
    expectIdTokenClaims(tokensOf(await refresh(w, signed.tokens.refresh_token)).id_token, who);
  });
});

describe('what the store holds', () => {
  test('after a sign-in and a refresh, no row and no byte of the database file holds the code, an access token or a refresh token', async () => {
    const w = await world();
    const who = await person(w);
    const code = await signInToCode(w, who.email, who.password);
    const signed = { ...code, tokens: tokensOf(await exchange(w, code.code, code.verifier)) };
    // The positive half: each record is keyed by the SHA-256 digest of its value, read while the
    // records still exist (the code's and first tokens' right after the exchange).
    expectStoredUnderDigest(w, [
      ['AuthorizationCode', signed.code],
      ['AccessToken', signed.tokens.access_token],
      ['RefreshToken', signed.tokens.refresh_token],
    ]);
    const rotated = tokensOf(await refresh(w, signed.tokens.refresh_token));
    expectStoredUnderDigest(w, [
      ['AccessToken', rotated.access_token],
      ['RefreshToken', rotated.refresh_token],
    ]);
    const secrets: ReadonlyArray<readonly [string, string]> = [
      ['the code', signed.code],
      ['the first access token', signed.tokens.access_token],
      ['the first refresh token', signed.tokens.refresh_token],
      ['the second access token', rotated.access_token],
      ['the second refresh token', rotated.refresh_token],
    ];
    const stored = rows(w);
    expect(stored.some((row) => row.model === 'RefreshToken')).toBe(true);
    for (const [name, value] of secrets) {
      for (const row of stored) {
        expect(row.id.includes(value), `${name} as the id of a ${row.model}`).toBe(false);
        expect(row.payload.includes(value), `${name} in a ${row.model}`).toBe(false);
      }
    }
    const files = readdirSync(w.dir).map(
      (name) => [name, readFileSync(join(w.dir, name)).toString('latin1')] as const,
    );
    // The control: the file is read, and holds what it should (the account's subject).
    expect(files.some(([, text]) => text.includes(who.sub))).toBe(true);
    for (const [file, text] of files) {
      for (const [name, value] of secrets) {
        expect(text.includes(value), `${name} in ${file}`).toBe(false);
      }
    }
  });

  test('an unknown client id, or a client record without a string redirectUri, is invalid_client and writes nothing', async () => {
    const w = await world();
    await w.store.adapter('Client').upsert('broken-a', {
      redirect: 'x',
    } as unknown as AdapterPayload);
    await w.store.adapter('Client').upsert('broken-b', {
      redirectUri: [REDIRECT_URI],
    } as unknown as AdapterPayload);
    for (const clientId of ['nobody', 'broken-a', 'broken-b']) {
      const before = rows(w).length;
      const { query } = authQuery({ client_id: clientId });
      const reply = await send(w.port, 'GET', `/auth?${query}`, { host: HOST });
      expect(reply.status, clientId).toBe(400);
      expect(reply.body, clientId).toMatch(/^invalid_client\b/);
      expect(reply.headers.location, clientId).toBeUndefined();
      expect(reply.headers['set-cookie'] ?? [], clientId).toEqual([]);
      expect(rows(w).length, clientId).toBe(before);
    }
  });

  test('a stored record asking for more is still a public client with exactly its one redirect address', async () => {
    const w = await world();
    await w.store.adapter('Client').upsert(CLIENT_ID, {
      redirectUri: REDIRECT_URI,
      redirect_uris: ['http://evil.example/'],
      token_endpoint_auth_method: 'client_secret_basic',
      client_secret: 'unused',
      grant_types: ['implicit'],
      response_types: ['id_token'],
    } as unknown as AdapterPayload);
    const before = rows(w).length;
    const { query } = authQuery({ redirect_uri: 'http://evil.example/' });
    const elsewhere = await send(w.port, 'GET', `/auth?${query}`, { host: HOST });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.headers.location).toBeUndefined();
    expect(rows(w).length).toBe(before);

    const who = await person(w);
    const signed = await signInToTokens(w, who);
    expectIdTokenClaims(signed.tokens.id_token, who);
  });
});

describe('sign-in sessions', () => {
  test('after a completed sign-in, an authorization request carrying every cookie the browser holds still asks for the sign-in step', async () => {
    const w = await world();
    const who = await person(w);
    const signed = await signInToTokens(w, who);
    const everything = signed.jar.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const { query } = authQuery();
    const again = await call(w, signed.jar, 'GET', `/auth?${query}`, { cookie: everything });
    expect(again.status).toBe(303);
    interactionUid(again.headers.location);
  });

  test('wrong passwords for an account and for an email with no account get the same answers in the same bytes, locked after five until ten minutes pass', async () => {
    freezeAt(T0);
    const w = await world();
    const known = await person(w);
    const unknownEmail = `nobody-${randomBytes(5).toString('hex')}@example.com`;
    const jar = newJar();
    const started = await begin(w, jar);
    const attempt = (email: string, password: string): Promise<Reply> =>
      call(w, jar, 'POST', started.path, {
        headers: GOOD_POST,
        body: credentials(email, password),
      });

    const knownReplies: Reply[] = [];
    const unknownReplies: Reply[] = [];
    for (let i = 0; i < 6; i += 1) {
      knownReplies.push(await attempt(known.email, `wrong-${i}`));
      unknownReplies.push(await attempt(unknownEmail, `wrong-${i}`));
    }
    knownReplies.push(await attempt(known.email, known.password));
    unknownReplies.push(await attempt(unknownEmail, known.password));

    const shape = (reply: Reply): readonly [number, string] => [reply.status, reply.body];
    expect(knownReplies.map(shape)).toEqual(unknownReplies.map(shape));
    expect(knownReplies.map((reply) => reply.status)).toEqual([400, 400, 400, 400, 400, 429, 429]);
    expect(knownReplies[0]!.body).toBe(signInPage({ action: started.path, notice: 'refused' }));
    expect(knownReplies[6]!.body).toBe(signInPage({ action: started.path, notice: 'locked' }));
    expect(grantIds(w)).toEqual([]);

    vi.setSystemTime(T0 + 599_000);
    expect((await attempt(known.email, known.password)).status).toBe(429);
    vi.setSystemTime(T0 + 601_000);
    await signInToCode(w, known.email, known.password);
  });
});

// The spellings of the authorization endpoint the provider answers alike.
const AUTH_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/auth'],
  ['HEAD', '/auth'],
  ['GET', '/AUTH'],
  ['GET', '/auth/'],
];

function interactionRows(w: World): Row[] {
  return rows(w).filter((row) => row.model === 'Interaction');
}

describe('the cap on sign-ins started', () => {
  test('past maxPendingSignIns within the window /auth gets 503 and writes nothing, the rest still answers, and the window moving on lets it through', async () => {
    freezeAt(T0);
    const cap = 3;
    const w = await world({ maxPendingSignIns: cap });
    const who = await person(w);
    const jars = Array.from({ length: cap }, () => newJar());
    const started: Started[] = [];
    for (const jar of jars) started.push(await begin(w, jar));

    const before = rows(w).length;
    // Every spelling of the authorization endpoint the provider answers is refused once full.
    for (const [method, path] of AUTH_SPELLINGS) {
      const label = `${method} ${path}`;
      const refused = await send(w.port, method, `${path}?${authQuery().query}`, { host: HOST });
      expect(refused.status, label).toBe(503);
      expect(String(refused.headers['content-type']), label).toMatch(/^text\/plain/);
      expect(refused.headers['set-cookie'] ?? [], label).toEqual([]);
      expect(refused.headers.location, label).toBeUndefined();
      if (method === 'HEAD') expect(refused.body, label).toBe('');
      else expect(refused.body, label).toMatch(/^temporarily_unavailable/);
      expect(rows(w).length, label).toBe(before);
    }
    // POST is not an authorization request at all.
    const { query } = authQuery();
    const posted = await send(
      w.port,
      'POST',
      '/auth',
      { host: HOST, 'content-type': FORM_TYPE },
      query,
    );
    expect(posted.status).toBe(404);
    expect(posted.headers['set-cookie'] ?? []).toEqual([]);
    expect(rows(w).length).toBe(before);

    expect((await send(w.port, 'GET', '/jwks', { host: HOST })).status).toBe(200);
    const discovery = '/.well-known/openid-configuration';
    expect((await send(w.port, 'GET', discovery, { host: HOST })).status).toBe(200);

    // A sign-in already started still completes: its form, its post, its resume and /token.
    const jar = jars[0]!;
    const first = started[0]!;
    const form = await call(w, jar, 'GET', first.path);
    expect(form.status).toBe(200);
    const signedIn = await call(w, jar, 'POST', first.path, {
      headers: GOOD_POST,
      body: credentials(who.email, who.password),
    });
    expect(signedIn.status).toBe(303);
    const resumed = await call(w, jar, 'GET', `/auth/${first.uid}`);
    expect(resumed.status).toBe(303);
    const code = new URL(String(resumed.headers.location)).searchParams.get('code');
    expect(code).toEqual(expect.any(String));
    tokensOf(await exchange(w, code!, first.verifier));

    vi.setSystemTime(T0 + (SIGN_IN_TTL_SECONDS - 1) * 1000);
    expect((await send(w.port, 'GET', `/auth?${authQuery().query}`, { host: HOST })).status).toBe(
      503,
    );
    vi.setSystemTime(T0 + SIGN_IN_TTL_SECONDS * 1000);
    await begin(w, newJar());
  });

  test('every spelling of the authorization endpoint counts while there is room, and the request after the cap is 503', async () => {
    freezeAt(T0);
    const w = await world({ maxPendingSignIns: AUTH_SPELLINGS.length });
    const uids: string[] = [];
    for (const [method, path] of AUTH_SPELLINGS) {
      const reply = await call(w, newJar(), method, `${path}?${authQuery().query}`);
      expect(reply.status, `${method} ${path}`).toBe(303);
      uids.push(interactionUid(reply.headers.location));
    }
    expect(new Set(uids).size).toBe(AUTH_SPELLINGS.length);
    expect(interactionRows(w)).toHaveLength(AUTH_SPELLINGS.length);
    const after = await send(w.port, 'GET', `/auth?${authQuery().query}`, { host: HOST });
    expect(after.status).toBe(503);
    expect(interactionRows(w)).toHaveLength(AUTH_SPELLINGS.length);
  });

  test('requests the provider refuses for its own reasons do not use the cap up', async () => {
    freezeAt(T0);
    const cap = 2;
    const w = await world({ maxPendingSignIns: cap });
    for (let i = 0; i < cap + 2; i += 1) {
      const unknown = await send(
        w.port,
        'GET',
        `/auth?${authQuery({ client_id: 'nobody' }).query}`,
        {
          host: HOST,
        },
      );
      expect(unknown.status).toBe(400);

      const elsewhere = authQuery({ redirect_uri: 'http://localhost:5291/' }).query;
      const misdirected = await send(w.port, 'GET', `/auth?${elsewhere}`, { host: HOST });
      expect(misdirected.status).toBe(400);
      expect(misdirected.headers.location).toBeUndefined();

      const params = new URLSearchParams(authQuery().query);
      params.delete('code_challenge');
      params.delete('code_challenge_method');
      const unchallenged = await send(w.port, 'GET', `/auth?${params}`, { host: HOST });
      expect([302, 303]).toContain(unchallenged.status);
      const back = new URL(String(unchallenged.headers.location));
      expect(back.searchParams.get('error')).toBe('invalid_request');
    }
    expect(interactionRows(w)).toEqual([]);
    for (let i = 0; i < cap; i += 1) await begin(w, newJar());
    // The control: the cap is still in force, now full.
    const full = await send(w.port, 'GET', `/auth?${authQuery().query}`, { host: HOST });
    expect(full.status).toBe(503);
  });
});

/** An authorization request target of exactly `length` characters, padded in `state`. */
function authTargetOfLength(length: number): string {
  const params = new URLSearchParams(authQuery().query);
  params.set('state', '');
  const empty = `/auth?${params}`;
  params.set('state', 'a'.repeat(length - empty.length));
  const target = `/auth?${params}`;
  expect(target.length).toBe(length);
  return target;
}

describe('a sign-in ends ten minutes after it started', () => {
  test('resuming a sign-in nobody signed in to starts a new step whose record expires when the first would have', async () => {
    freezeAt(T0);
    const w = await world();
    const jar = newJar();
    const first = await begin(w, jar);
    expect(interactionExpiries(w)).toEqual([T0_SECONDS + SIGN_IN_TTL_SECONDS]);

    vi.setSystemTime(T0 + 500_000);
    const resumed = await call(w, jar, 'GET', `/auth/${first.uid}`);
    expect(resumed.status).toBe(303);
    const second = interactionUid(resumed.headers.location);
    expect(second).not.toBe(first.uid);
    expect(interactionExpiries(w)).toEqual([T0_SECONDS + 600]);

    const path = `/interaction/${second}`;
    vi.setSystemTime(T0 + 599_000);
    const form = await call(w, jar, 'GET', path);
    expect(form.status).toBe(200);
    expect(form.body).toBe(signInPage({ action: path }));
    vi.setSystemTime(T0 + 600_000);
    const ended = await call(w, jar, 'GET', path);
    expect(ended.status).toBe(400);
    expect(ended.body).toBe(endedPage());
  });

  test('after a not-owned answer, the resumed step still expires when the first would have', async () => {
    freezeAt(T0);
    const w = await world();
    const who = await person(w, false);
    const jar = newJar();
    const first = await begin(w, jar);
    vi.setSystemTime(T0 + 100_000);
    const posted = await call(w, jar, 'POST', first.path, {
      headers: GOOD_POST,
      body: credentials(who.email, who.password),
    });
    expect(posted.status).toBe(403);
    vi.setSystemTime(T0 + 200_000);
    const resumed = await call(w, jar, 'GET', `/auth/${first.uid}`);
    expect(resumed.status).toBe(303);
    expect(interactionUid(resumed.headers.location)).not.toBe(first.uid);
    expect(interactionExpiries(w)).toEqual([T0_SECONDS + 600]);
  });
});

describe('request targets', () => {
  test('an authorization request target of 2049 characters is 414 text/plain with no record and no cookie; 2048 starts one sign-in', async () => {
    const w = await world();
    const before = rows(w).length;
    const long = await send(w.port, 'GET', authTargetOfLength(2049), { host: HOST });
    expect(long.status).toBe(414);
    expect(String(long.headers['content-type'])).toMatch(/^text\/plain/);
    expect(long.headers['set-cookie'] ?? []).toEqual([]);
    expect(long.headers.location).toBeUndefined();
    expect(rows(w).length).toBe(before);

    const exact = await call(w, newJar(), 'GET', authTargetOfLength(2048));
    expect(exact.status).toBe(303);
    interactionUid(exact.headers.location);
    expect(interactionRows(w)).toHaveLength(1);
    expect(rows(w).length).toBe(before + 1);
  });

  test('a /jwks target of 2049 characters is 414 text/plain, and of 2048 is served', async () => {
    const w = await world();
    const target = (length: number): string => `/jwks?${'a'.repeat(length - '/jwks?'.length)}`;
    expect(target(2049)).toHaveLength(2049);
    const long = await send(w.port, 'GET', target(2049), { host: HOST });
    expect(long.status).toBe(414);
    expect(String(long.headers['content-type'])).toMatch(/^text\/plain/);
    expect(long.body).not.toContain(w.keys[0]!.x);
    const exact = await send(w.port, 'GET', target(2048), { host: HOST });
    expect(exact.status).toBe(200);
    expect(exact.body).toContain(w.keys[0]!.x);
  });
});

const INTERACTION_COOKIES = [
  '_interaction',
  '_interaction.sig',
  '_interaction_resume',
  '_interaction_resume.sig',
].sort();

describe('a password reset ends what earlier seconds issued', () => {
  test('refreshing a token and exchanging a code issued before the reset second are refused, their grants are gone, and another account is untouched [wr261127-c.4]', {
    timeout: 30_000,
  }, async () => {
    // WRONG IMPL KILLED: no check at the token endpoints (the chain outlives the reset); a refusal
    // that leaves the grant's records behind; a check that refuses every account's tokens.
    freezeAt(T0);
    const w = await world();
    const who = await person(w);
    const other = await person(w);
    const chain = await signInToTokens(w, who);
    const held = await signInToCode(w, who.email, who.password);
    const bystander = await signInToTokens(w, other);
    expect(
      recordsOfGrant(w, chain.grantId).length,
      'control: the chain has records',
    ).toBeGreaterThan(1);

    vi.setSystemTime(T0 + 1000);
    await w.accounts.resetPassword(who.email);

    expectInvalidGrant(await refresh(w, chain.tokens.refresh_token));
    expectInvalidGrant(await exchange(w, held.code, held.verifier));
    expect(recordsOfGrant(w, chain.grantId)).toEqual([]);
    expect(recordsOfGrant(w, held.grantId)).toEqual([]);
    tokensOf(await refresh(w, bystander.tokens.refresh_token));
  });

  test('a token issued 100 ms before the reset, in the second before it, is refused [wr261127-c.4]', {
    timeout: 30_000,
  }, async () => {
    // WRONG IMPL KILLED: a comparison that lets a token of the second just before the reset
    // through (a >= against the second after, or a grace window).
    freezeAt(T0 + 900);
    const w = await world();
    const who = await person(w);
    const chain = await signInToTokens(w, who);
    vi.setSystemTime(T0 + 1000);
    await w.accounts.resetPassword(who.email);
    expectInvalidGrant(await refresh(w, chain.tokens.refresh_token));
    expect(recordsOfGrant(w, chain.grantId)).toEqual([]);
  });

  test('after the reset the earlier password gets the refusal form and no code [wr261127-c.4]', {
    timeout: 30_000,
  }, async () => {
    // WRONG IMPL KILLED: a reset that leaves the earlier password working at the form.
    freezeAt(T0);
    const w = await world();
    const who = await person(w);
    vi.setSystemTime(T0 + 1000);
    await w.accounts.resetPassword(who.email);
    const jar = newJar();
    const started = await begin(w, jar);
    const posted = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials(who.email, who.password),
    });
    expect(posted.status).toBe(400);
    expect(posted.body).toBe(signInPage({ action: started.path, notice: 'refused' }));
    expect(posted.headers.location).toBeUndefined();
    expect(grantIds(w)).toEqual([]);
  });

  test('a code minted at a resume after the reset, for a password checked before it, does not exchange [wr261127-c.4]', {
    timeout: 30_000,
  }, async () => {
    // WRONG IMPL KILLED: a check on the token's issue second alone (the resume second is after
    // the reset, so the code passes while the password it vouches for is gone).
    freezeAt(T0);
    const w = await world();
    const who = await person(w);
    const jar = newJar();
    const started = await begin(w, jar);
    const posted = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials(who.email, who.password),
    });
    expect(posted.status).toBe(303);

    vi.setSystemTime(T0 + 1000);
    await w.accounts.resetPassword(who.email);
    const resumed = await call(w, jar, 'GET', `/auth/${started.uid}`);
    expect(resumed.status).toBe(303);
    const back = new URL(String(resumed.headers.location), ISSUER);
    const code = back.searchParams.get('code');
    expect(code, 'the resume still mints a code').toEqual(expect.any(String));
    expectInvalidGrant(await exchange(w, code as string, started.verifier));
  });

  test('a stored refresh token whose authTime is removed is refused and its grant revoked [wr261127-c.4]', {
    timeout: 30_000,
  }, async () => {
    // WRONG IMPL KILLED: a missing authTime read as 0 or as current (the token passes); a
    // refusal that leaves the grant's records behind.
    freezeAt(T0);
    const w = await world();
    const who = await person(w);
    const chain = await signInToTokens(w, who);
    const digest = createHash('sha256').update(chain.tokens.refresh_token).digest('base64url');
    const db = new DatabaseSync(w.dbPath);
    try {
      const found = db
        .prepare("SELECT payload FROM oidc_record WHERE model = 'RefreshToken' AND id = ?")
        .get(digest) as { payload: string } | undefined;
      expect(found, 'control: the refresh token record is stored under its digest').toBeDefined();
      const payload = JSON.parse(found!.payload) as Record<string, unknown>;
      expect(payload.authTime, 'control: authTime is stored').toEqual(expect.any(Number));
      delete payload.authTime;
      db.prepare("UPDATE oidc_record SET payload = ? WHERE model = 'RefreshToken' AND id = ?").run(
        JSON.stringify(payload),
        digest,
      );
    } finally {
      db.close();
    }
    expectInvalidGrant(await refresh(w, chain.tokens.refresh_token));
    expect(recordsOfGrant(w, chain.grantId)).toEqual([]);
  });
});

describe('a sign-in with the new password after a reset', () => {
  test('in the reset second and in a later one issues codes and refresh tokens that exchange and refresh, as for an account never reset [wr261127-c.5]', {
    timeout: 60_000,
  }, async () => {
    // WRONG IMPL KILLED: a > where >= is meant (the reset second's own sign-in refused); a
    // permanent lock-out of the reset account; a rotated token refused on its second refresh;
    // the check applied to an account whose record has no stored second.
    freezeAt(T0);
    const w = await world();
    const who = await person(w);
    const legacy = await person(w);

    vi.setSystemTime(T0 + 1500);
    const reset = await w.accounts.resetPassword(who.email);

    vi.setSystemTime(T0 + 1900);
    const sameSecond = await signInToCode(w, who.email, reset.password);
    const first = tokensOf(await exchange(w, sameSecond.code, sameSecond.verifier));
    const rotated = tokensOf(await refresh(w, first.refresh_token));
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    expectIdTokenClaims(rotated.id_token, who);
    tokensOf(await refresh(w, rotated.refresh_token));

    vi.setSystemTime(T0 + 5000);
    const later = await signInToTokens(w, { ...who, password: reset.password });
    const next = tokensOf(await refresh(w, later.tokens.refresh_token));
    tokensOf(await refresh(w, next.refresh_token));

    const old = await signInToTokens(w, legacy);
    expectIdTokenClaims(tokensOf(await refresh(w, old.tokens.refresh_token)).id_token, legacy);
  });
});

describe('only the interaction cookies, by exact name, reach the provider', () => {
  test.each([
    ['no cookie (the control)', null],
    [
      'session cookies whose values are interaction cookie names',
      '_session=_interaction; _session.sig=_interaction.sig',
    ],
    [
      'cookies whose names or values merely contain an interaction cookie name',
      'x_interaction=1; _session=abc._interaction_resume',
    ],
  ])('an authorization request with %s starts a sign-in step and stores only its Interaction', async (_name, cookie) => {
    const w = await world();
    const key = (row: Row): string => `${row.model}/${row.id}`;
    const before = new Set(rows(w).map(key));
    const reply = await call(w, newJar(), 'GET', `/auth?${authQuery().query}`, { cookie });
    expect(reply.status).toBe(303);
    interactionUid(reply.headers.location);
    const names = (reply.headers['set-cookie'] ?? []).map((line) => line.split('=')[0]);
    expect([...names].sort()).toEqual(INTERACTION_COOKIES);
    const added = rows(w).filter((row) => !before.has(key(row)));
    expect(added.map((row) => row.model)).toEqual(['Interaction']);
  });
});

// ---- the Steam browser sign-in over HTTP: the SQLite store, the Steam stub, and the step ----
// ---- signInStepFor builds over a real entitlement source ----

const PLAYER = parseSteamId('76561198000000001')!;
const OTHER_PLAYER = parseSteamId('76561198000000002')!;
const THIRD_PLAYER = parseSteamId('76561198000000003')!;
const PLAYER_SUB = 'steam:76561198000000001';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID_PREFIX = 'https://steamcommunity.com/openid/id/';
const OPENID_PATH = '/openid/login';
const OWNERSHIP_PATH = '/ISteamUser/CheckAppOwnership/v4/';
const TICKET_GRANT = 'urn:monster-realm:steam-ticket';
const TICKET_IDENTITY = 'monster-realm-account';
/** The production rows' app id: the game's own, not Valve's 480. */
const GAME_APP_ID = 3_141_590;
/** The six parameters of Steam's login address, sorted. */
const LOGIN_PARAMETERS = [
  'openid.claimed_id',
  'openid.identity',
  'openid.mode',
  'openid.ns',
  'openid.realm',
  'openid.return_to',
];
const LINE_FEED = String.fromCharCode(10);
/** 43 base64url characters: the form of an interaction's state, and no sign-in's. */
const MADE_UP_STATE = 'A'.repeat(43);
/** The models of what a sign-in issues: none is stored for a player who gets nothing. */
const ISSUED_MODELS: ReadonlySet<string> = new Set([
  'AuthorizationCode',
  'AccessToken',
  'RefreshToken',
]);

interface SteamWorld extends World {
  readonly stub: SteamStub;
  readonly deny: DenyList;
  /** The dev profiles' entitlement flags on `steam:` subjects. */
  readonly flags: SteamAccounts;
  /** What the Steam step logged. */
  readonly lines: string[];
  readonly production: boolean;
  readonly method: 'steam' | 'dev-password';
}

interface SteamWorldOptions {
  /** The profile's sign-in method; default `steam`. */
  readonly signIn?: 'steam' | 'dev-password';
  /** Give the step Steam (the entitlement source, the log, the stub's endpoint); default true. */
  readonly withSteam?: boolean;
  /** The entitlement source's profile; default `local-dev`, where the dev flag decides. */
  readonly profile?: 'local-dev' | 'production';
  /** Build the provider with the Steam ticket grant beside the step; default false. */
  readonly ticketGrant?: boolean;
}

/** One fresh service with a Steam stub: its own temp directory, database file, keys and server. */
async function steamWorld(options: SteamWorldOptions = {}): Promise<SteamWorld> {
  const profile = options.profile ?? 'local-dev';
  const production = profile === 'production';
  const method = options.signIn ?? 'steam';
  const stub = await startSteamStub(production ? { appId: GAME_APP_ID } : undefined);
  cleanups.push(() => stub.close());
  const dir = mkdtempSync(join(tmpdir(), 'acs10-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const dbPath = join(dir, 'account.sqlite');
  const store = openAccountStore(dbPath);
  cleanups.push(() => {
    store.close();
  });
  await registerClient(store.adapter, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
  const keys = [generateSigningKey()];
  const deny = denyList(store.adapter);
  const flags = steamAccounts(store.adapter);
  const api = createSteamWebApi({
    config: { profile, steam: { appId: stub.appId } },
    env: production ? { MR_STEAM_PUBLISHER_KEY: stub.key } : { MR_STEAM_WEB_API_KEY: stub.key },
    log: () => undefined,
    baseUrl: stub.url,
  });
  const entitlement = steamEntitlementSource({
    profile,
    denied: (steamId) => deny.has(steamId),
    devFlag: (steamId) => flags.entitled(steamId),
    checkAppOwnership: (steamId) => api.checkAppOwnership(steamId),
  });
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
  };
  const steam =
    options.withSteam === false ? undefined : { entitlement, log, endpoint: stub.openIdEndpoint };
  const step = signInStepFor({ signIn: method, issuer: ISSUER }, store.adapter, steam);
  expect(step, 'the sign-in step of the profile').toBeDefined();
  const steamTicket: SteamTicketGrantOptions | undefined =
    options.ticketGrant === true
      ? {
          authenticateTicket: (ticket, identity) => api.authenticateTicket(ticket, identity),
          entitlement,
          sourceAddress: createSourceAddress([]),
          log: () => undefined,
        }
      : undefined;
  const { handler } = createAccountProvider({
    issuer: ISSUER,
    keys: { keys },
    adapter: store.adapter,
    signIn: step,
    steamTicket,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  return {
    port: (server.address() as AddressInfo).port,
    dir,
    dbPath,
    store,
    keys,
    accounts: devAccounts(store.adapter),
    stub,
    deny,
    flags,
    lines,
    production,
    method,
  };
}

function owned(steamId: string): SteamStubOwnership {
  return { ownsapp: true, permanent: true, sitelicense: false, ownersteamid: steamId };
}

/** Makes `steamId` entitled the way the world's profile reads it. */
async function entitle(w: SteamWorld, steamId: SteamId): Promise<void> {
  if (w.production) w.stub.setOwnership(steamId, owned(steamId));
  else await w.flags.setEntitled(steamId, true);
}

function openIdChecks(w: SteamWorld): number {
  return w.stub.requests.filter((sent) => sent.path === OPENID_PATH).length;
}

function ownershipChecks(w: SteamWorld): number {
  return w.stub.requests.filter((sent) => sent.path === OWNERSHIP_PATH).length;
}

function nonceRows(w: World): Row[] {
  return rows(w).filter((row) => row.model === 'SteamNonce');
}

function issuedRows(w: World): Row[] {
  return rows(w).filter((row) => ISSUED_MODELS.has(row.model));
}

function addedRows(w: World, before: readonly Row[]): Row[] {
  const seen = new Set(before.map((row) => `${row.model}/${row.id}`));
  return rows(w).filter((row) => !seen.has(`${row.model}/${row.id}`));
}

/** The payload of the one `model` record stored under the digest of `value`. */
function storedPayload(w: World, model: string, value: string): Record<string, unknown> {
  const id = createHash('sha256').update(value).digest('base64url');
  const found = rows(w).filter((row) => row.model === model && row.id === id);
  expect(found, `${model} under its digest`).toHaveLength(1);
  return JSON.parse(found[0]!.payload) as Record<string, unknown>;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

function unescapeHtml(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|#39|#x27);/g,
    (entity) => HTML_ENTITIES[entity] ?? entity,
  );
}

/** The address of the one link of a page, unescaped. */
function steamLinkOf(page: string): string {
  expect(page.match(/<a[\s>]/g) ?? [], 'links on the page').toHaveLength(1);
  const found = /<a\s[^>]*?\bhref=(?:"([^"]*)"|'([^']*)')/.exec(page);
  expect(found, 'the link has an address').not.toBeNull();
  return unescapeHtml(found![1] ?? found![2] ?? '');
}

/** Checks Steam's login address for the sign-in `uid`, and returns its callback and state. */
function expectLoginUrl(
  w: SteamWorld,
  address: string,
  uid: string,
): { readonly returnTo: string; readonly callbackState: string } {
  expect(address.startsWith(`${w.stub.openIdEndpoint}?`), address).toBe(true);
  const query = new URLSearchParams(address.slice(w.stub.openIdEndpoint.length + 1));
  expect([...query.keys()].sort()).toEqual(LOGIN_PARAMETERS);
  expect(query.get('openid.ns')).toBe('http://specs.openid.net/auth/2.0');
  expect(query.get('openid.mode')).toBe('checkid_setup');
  expect(query.get('openid.identity')).toBe(IDENTIFIER_SELECT);
  expect(query.get('openid.claimed_id')).toBe(IDENTIFIER_SELECT);
  expect(query.get('openid.realm')).toBe('http://localhost:4455');
  const returnTo = String(query.get('openid.return_to'));
  const prefix = `http://localhost:4455/interaction/${uid}/steam?state=`;
  expect(returnTo.startsWith(prefix), returnTo).toBe(true);
  const callbackState = returnTo.slice(prefix.length);
  expect(callbackState).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(callbackState).not.toBe(uid);
  return { returnTo, callbackState };
}

interface SteamStart {
  readonly jar: Jar;
  readonly started: Started;
  /** Steam's login address the step gave the browser. */
  readonly loginUrl: string;
  /** Our callback: the `openid.return_to` of `loginUrl`. */
  readonly returnTo: string;
  /** The interaction's state in the callback. */
  readonly callbackState: string;
}

/** Steam's login address on the step's page: the redirect of a Steam-only step, else the link. */
function loginUrlOf(w: SteamWorld, page: Reply, action: string): string {
  if (w.method === 'steam') {
    expect(page.status, page.body).toBe(303);
    expect(page.headers['cache-control']).toBe('no-store');
    return String(page.headers.location);
  }
  expect(page.status, page.body).toBe(200);
  const link = steamLinkOf(page.body);
  expect(page.body).toBe(signInPage({ action, steam: link }));
  return link;
}

/** Starts a sign-in and opens its step: the browser holds Steam's login address. */
async function steamStart(w: SteamWorld, extra: Record<string, string> = {}): Promise<SteamStart> {
  const jar = newJar();
  const started = await begin(w, jar, extra);
  const page = await call(w, jar, 'GET', started.path);
  const loginUrl = loginUrlOf(w, page, started.path);
  const { returnTo, callbackState } = expectLoginUrl(w, loginUrl, started.uid);
  return { jar, started, loginUrl, returnTo, callbackState };
}

/** The request target of an address of the issuer. */
function replyTarget(reply: string): string {
  const url = new URL(reply);
  expect(url.origin).toBe(ISSUER);
  return `${url.pathname}${url.search}`;
}

/** The browser's request when Steam sends it back from `s` signed in as `steamId`. */
function replyFor(
  w: SteamWorld,
  s: SteamStart,
  steamId: string = PLAYER,
  change?: Readonly<Record<string, string>>,
): string {
  return replyTarget(w.stub.openIdReply(s.loginUrl, steamId, change));
}

/** The browser's request for a valid reply for PLAYER, its query then changed by `edit`. */
function editedReply(w: SteamWorld, s: SteamStart, edit: (query: URLSearchParams) => void): string {
  const url = new URL(w.stub.openIdReply(s.loginUrl, PLAYER));
  expect(url.origin).toBe(ISSUER);
  const query = new URLSearchParams(url.search);
  edit(query);
  return `${url.pathname}?${query.toString()}`;
}

function firstCharacterChanged(text: string): string {
  return `${text.startsWith('A') ? 'B' : 'A'}${text.slice(1)}`;
}

/** `digits` in their fullwidth forms: digits to a reader, not to an ASCII digit class. */
function fullwidthDigits(digits: string): string {
  return [...digits].map((digit) => String.fromCharCode(0xff10 + Number(digit))).join('');
}

function codeOf(resumed: Reply, started: Started): string {
  expect(resumed.status, resumed.body).toBe(303);
  const back = new URL(String(resumed.headers.location));
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  expect(back.searchParams.get('state')).toBe(started.state);
  expect(back.searchParams.get('iss')).toBe(ISSUER);
  const code = back.searchParams.get('code');
  expect(code).toEqual(expect.any(String));
  return code!;
}

function expectNoCode(reply: Reply): void {
  const location = reply.headers.location;
  if (location !== undefined) {
    expect(new URL(location, ISSUER).searchParams.has('code'), location).toBe(false);
  }
}

interface SteamSigned extends Signed {
  readonly start: SteamStart;
}

async function steamSignInToCode(
  w: SteamWorld,
  steamId: string,
  extra: Record<string, string> = {},
): Promise<SteamSigned> {
  const before = grantIds(w);
  const s = await steamStart(w, extra);
  const back = await call(w, s.jar, 'GET', replyFor(w, s, steamId));
  expect(back.status, back.body).toBe(303);
  expect(back.headers.location).toBe(`${ISSUER}/auth/${s.started.uid}`);
  expect(back.headers['cache-control']).toBe('no-store');
  const code = codeOf(await call(w, s.jar, 'GET', `/auth/${s.started.uid}`), s.started);
  const fresh = grantIds(w).filter((id) => !before.includes(id));
  expect(fresh).toHaveLength(1);
  return { code, verifier: s.started.verifier, jar: s.jar, grantId: fresh[0]!, start: s };
}

async function steamSignInToTokens(
  w: SteamWorld,
  steamId: string,
  extra: Record<string, string> = {},
): Promise<SteamSigned & { readonly tokens: Tokens }> {
  const signed = await steamSignInToCode(w, steamId, extra);
  return { ...signed, tokens: tokensOf(await exchange(w, signed.code, signed.verifier)) };
}

/** A password sign-in on a page that also offers Steam. */
async function passwordSignInBesideSteam(w: SteamWorld, who: Person): Promise<Tokens> {
  const jar = newJar();
  const started = await begin(w, jar);
  const posted = await call(w, jar, 'POST', started.path, {
    headers: GOOD_POST,
    body: credentials(who.email, who.password),
  });
  expect(posted.status, posted.body).toBe(303);
  expect(posted.headers.location).toBe(`${ISSUER}/auth/${started.uid}`);
  const code = codeOf(await call(w, jar, 'GET', `/auth/${started.uid}`), started);
  return tokensOf(await exchange(w, code, started.verifier));
}

/** The ID token the ticket grant issues for a fresh ticket of `steamId`. */
async function ticketIdToken(w: SteamWorld, steamId: string): Promise<string> {
  const reply = await token(
    w,
    {
      grant_type: TICKET_GRANT,
      client_id: CLIENT_ID,
      steam_ticket: w.stub.issueTicket(steamId, TICKET_IDENTITY),
    },
    { accept: 'application/json' },
  );
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  expect(reply.json.id_token).toEqual(expect.any(String));
  return reply.json.id_token as string;
}

/** Verifies an ID token under /jwks: exactly the named claims, for `sub`, an hour long. */
async function expectSteamIdToken(
  w: World,
  jwt: string,
  sub: string,
): Promise<Record<string, unknown>> {
  const keySet = createLocalJWKSet(await servedKeySet(w));
  const { payload, protectedHeader } = await jwtVerify(jwt, keySet, {
    issuer: ISSUER,
    audience: CLIENT_ID,
  });
  expect(protectedHeader.alg).toBe('ES256');
  expect(Object.keys(payload).sort()).toEqual([...ID_TOKEN_CLAIMS].sort());
  expect(payload.iss).toBe(ISSUER);
  expect(payload.sub).toBe(sub);
  expect(payload.aud).toBe(CLIENT_ID);
  expect(payload.mr_ent).toEqual(['base-game']);
  expect(Number(payload.exp) - Number(payload.iat)).toBe(3600);
  return { ...payload };
}

/**
 * After a sign-in ended: the same reply again, a fresh valid reply, the step's page and the resume
 * each give the ended page or no code, Steam is asked nothing more, and nothing is issued.
 */
async function expectEndedForGood(w: SteamWorld, s: SteamStart, target: string): Promise<void> {
  const asked = openIdChecks(w);
  for (const again of [target, replyFor(w, s)]) {
    const reply = await call(w, s.jar, 'GET', again);
    expect(reply.status, reply.body).toBe(400);
    expect(reply.body).toBe(endedPage());
  }
  const page = await call(w, s.jar, 'GET', s.started.path);
  expect(page.status).toBe(400);
  expect(page.body).toBe(endedPage());
  expectNoCode(await call(w, s.jar, 'GET', `/auth/${s.started.uid}`));
  expect(openIdChecks(w), 'check_authentication requests after the end').toBe(asked);
  expect(grantIds(w)).toEqual([]);
  expect(issuedRows(w)).toEqual([]);
}

/** The reply `target` on `s` ends the sign-in: the ended page, nothing stored, and no way on. */
async function expectEndedBy(
  w: SteamWorld,
  s: SteamStart,
  target: string,
  steamAsked: number,
): Promise<void> {
  const before = rows(w);
  const answered = await call(w, s.jar, 'GET', target);
  expect(answered.status, answered.body).toBe(400);
  expect(answered.body).toBe(endedPage());
  expect(answered.headers.location).toBeUndefined();
  expect(openIdChecks(w), 'check_authentication requests').toBe(steamAsked);
  expect(addedRows(w, before)).toEqual([]);
  expect(nonceRows(w)).toEqual([]);
  expect(w.lines).toEqual([]);
  await expectEndedForGood(w, s, target);
}

/** The browser's request for a reply on the sign-in `s`, whose player PLAYER is entitled. */
type ReplyTarget = (w: SteamWorld, s: SteamStart) => string | Promise<string>;

function signedEndpoint(make: (endpoint: string) => string): ReplyTarget {
  return (w, s) => replyFor(w, s, PLAYER, { op_endpoint: make(w.stub.openIdEndpoint) });
}

function signedReturnTo(make: (s: SteamStart) => string): ReplyTarget {
  return (w, s) => replyFor(w, s, PLAYER, { return_to: make(s) });
}

/** A valid reply whose browser query carries exactly these `state` values instead of its own. */
function browserState(states: (s: SteamStart) => readonly string[]): ReplyTarget {
  return (w, s) =>
    editedReply(w, s, (query) => {
      query.delete('state');
      for (const state of states(s)) query.append('state', state);
    });
}

function claimedAs(claimedId: string): ReplyTarget {
  return (w, s) => replyFor(w, s, PLAYER, { claimed_id: claimedId, identity: claimedId });
}

/** Replies Steam answers is_valid:false for, each right in every other respect. */
const STEAM_SAYS_INVALID: ReadonlyArray<readonly [string, ReplyTarget]> = [
  [
    'its signature changed after signing',
    (w, s) =>
      editedReply(w, s, (query) => {
        query.set('openid.sig', firstCharacterChanged(String(query.get('openid.sig'))));
      }),
  ],
  [
    "another player's claimed id and identity put in after signing",
    (w, s) =>
      editedReply(w, s, (query) => {
        query.set('openid.claimed_id', `${CLAIMED_ID_PREFIX}${OTHER_PLAYER}`);
        query.set('openid.identity', `${CLAIMED_ID_PREFIX}${OTHER_PLAYER}`);
      }),
  ],
  [
    'an is_valid:false answer from Steam',
    (w, s) => {
      w.stub.respondNext('CheckAuthentication', {
        kind: 'body',
        body: `ns:${OPENID_NS}${LINE_FEED}is_valid:false${LINE_FEED}`,
        headers: { 'content-type': 'text/plain;charset=utf-8' },
      });
      return replyFor(w, s);
    },
  ],
];

/** Replies that fail a check of the reply itself, each signed so Steam would vouch for it. */
const REPLY_CHECKS: ReadonlyArray<readonly [string, ReplyTarget]> = [
  ['an op_endpoint at localhost', signedEndpoint((e) => e.replace('127.0.0.1', 'localhost'))],
  ['an op_endpoint with a trailing slash', signedEndpoint((e) => `${e}/`)],
  ['an op_endpoint with a query', signedEndpoint((e) => `${e}?x=1`)],
  ['an op_endpoint over https', signedEndpoint((e) => e.replace('http:', 'https:'))],
  ['an op_endpoint spelt /OpenID/', signedEndpoint((e) => e.replace('/openid/', '/OpenID/'))],
  [
    "another sign-in's callback as return_to",
    async (w, s) => replyFor(w, s, PLAYER, { return_to: (await steamStart(w)).returnTo }),
  ],
  [
    "this sign-in's state under another sign-in's uid as return_to",
    async (w, s) => {
      const other = await steamStart(w);
      return replyFor(w, s, PLAYER, {
        return_to: `${ISSUER}/interaction/${other.started.uid}/steam?state=${s.callbackState}`,
      });
    },
  ],
  ['the callback with &x=1 appended', signedReturnTo((s) => `${s.returnTo}&x=1`)],
  ['the callback without its query', signedReturnTo((s) => s.returnTo.split('?')[0]!)],
  ['the callback over https', signedReturnTo((s) => s.returnTo.replace('http:', 'https:'))],
  ['the callback at an IP', signedReturnTo((s) => s.returnTo.replace('localhost', '127.0.0.1'))],
  ['the callback at another port', signedReturnTo((s) => s.returnTo.replace(':4455/', ':4456/'))],
  ['no state', browserState(() => [])],
  [
    "another sign-in's state",
    async (w, s) => {
      const other = await steamStart(w);
      return editedReply(w, s, (query) => {
        query.set('state', other.callbackState);
      });
    },
  ],
  ['the uid as the state', browserState((s) => [s.started.uid])],
  ['the state twice', browserState((s) => [s.callbackState, s.callbackState])],
  ['the state, then another', browserState((s) => [s.callbackState, MADE_UP_STATE])],
  ['another state, then the state', browserState((s) => [MADE_UP_STATE, s.callbackState])],
  [
    'the state with one character changed',
    browserState((s) => [firstCharacterChanged(s.callbackState)]),
  ],
  ['a claimed id of 16 digits', claimedAs(`${CLAIMED_ID_PREFIX}${PLAYER.slice(0, 16)}`)],
  ['a claimed id of 18 digits', claimedAs(`${CLAIMED_ID_PREFIX}${PLAYER}1`)],
  ['a claimed id over http', claimedAs(`http://steamcommunity.com/openid/id/${PLAYER}`)],
  ['a claimed id at www', claimedAs(`https://www.steamcommunity.com/openid/id/${PLAYER}`)],
  ['a claimed id with a trailing slash', claimedAs(`${CLAIMED_ID_PREFIX}${PLAYER}/`)],
  ['a claimed id ending in a line feed', claimedAs(`${CLAIMED_ID_PREFIX}${PLAYER}${LINE_FEED}`)],
  ['a fullwidth claimed id', claimedAs(`${CLAIMED_ID_PREFIX}${fullwidthDigits(PLAYER)}`)],
  ['a claimed id with a prefix before https', claimedAs(`x${CLAIMED_ID_PREFIX}${PLAYER}`)],
  [
    'two claimed ids on two lines',
    claimedAs(`${CLAIMED_ID_PREFIX}${OTHER_PLAYER}${LINE_FEED}${CLAIMED_ID_PREFIX}${PLAYER}`),
  ],
  [
    "another player's identity",
    (w, s) => replyFor(w, s, PLAYER, { identity: `${CLAIMED_ID_PREFIX}${OTHER_PLAYER}` }),
  ],
  [
    "another player's claimed id",
    (w, s) => replyFor(w, s, PLAYER, { claimed_id: `${CLAIMED_ID_PREFIX}${OTHER_PLAYER}` }),
  ],
];

/** Ways a dev profile stops entitling a Steam player, each with its undoing. */
const DEV_REVOCATIONS: ReadonlyArray<
  readonly [string, (w: SteamWorld) => Promise<void>, (w: SteamWorld) => Promise<void>]
> = [
  [
    'the flag set not-entitled',
    (w) => w.flags.setEntitled(PLAYER, false),
    (w) => w.flags.setEntitled(PLAYER, true),
  ],
  ['the player denied', (w) => w.deny.add(PLAYER), (w) => w.deny.remove(PLAYER)],
];

/** What Steam may report for PLAYER that does not entitle them. */
const OWNERSHIP_LOSSES: ReadonlyArray<readonly [string, SteamStubOwnership]> = [
  ['no licence', { ownsapp: false, permanent: false, sitelicense: false, ownersteamid: '0' }],
  [
    "another player's licence",
    { ownsapp: true, permanent: true, sitelicense: false, ownersteamid: OTHER_PLAYER },
  ],
  ['a site licence', { ownsapp: true, permanent: true, sitelicense: true, ownersteamid: PLAYER }],
  [
    'a licence that is not permanent',
    { ownsapp: true, permanent: false, sitelicense: false, ownersteamid: PLAYER },
  ],
];

const OWNERSHIP_OUTAGES: ReadonlyArray<readonly [string, SteamStubAnswer]> = [
  ['answers 500', { kind: 'status', status: 500 }],
  ['answers a body that is not JSON', { kind: 'body', body: 'not json' }],
  ['closes the connection', { kind: 'closed' }],
];

describe('a Steam player signs in through the browser', () => {
  test('the step sends the browser to Steam with exactly the six parameters, our callback as return_to and our origin as realm, the same address at every look and another state for another sign-in acs-10.1', async () => {
    const w = await steamWorld();
    const s = await steamStart(w);
    expect(s.returnTo).toBe(
      `http://localhost:4455/interaction/${s.started.uid}/steam?state=${s.callbackState}`,
    );
    const again = await call(w, s.jar, 'GET', s.started.path);
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe(s.loginUrl);
    const other = await steamStart(w);
    expect(other.started.uid).not.toBe(s.started.uid);
    expect(other.callbackState).not.toBe(s.callbackState);
    expect(w.stub.requests).toEqual([]);
  });

  test('an entitled player completes the round trip to a code that exchanges for an ID token verified under /jwks with exactly the named claims, sub steam:<steamid64>, and a refresh token acs-10.1', async () => {
    freezeAt(T0);
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    const signed = await steamSignInToCode(w, PLAYER);
    const reply = await exchange(w, signed.code, signed.verifier);
    const tokens = tokensOf(reply);
    expect(reply.json.token_type).toBe('Bearer');
    expect(tokens.refresh_token).not.toBe(tokens.access_token);
    expect(payloadOf(tokens.id_token)).toEqual({
      iss: ISSUER,
      sub: 'steam:76561198000000001',
      aud: CLIENT_ID,
      mr_ent: ['base-game'],
      iat: T0_SECONDS,
      exp: T0_SECONDS + 3600,
    });
    await expectSteamIdToken(w, tokens.id_token, 'steam:76561198000000001');

    const checks = w.stub.requests.filter((sent) => sent.path === OPENID_PATH);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.method).toBe('POST');
    expect(String(checks[0]!.headers['content-type'])).toMatch(
      /^application\/x-www-form-urlencoded/,
    );
    const posted = new URLSearchParams(checks[0]!.body);
    expect(posted.get('openid.mode')).toBe('check_authentication');
    expect(posted.get('openid.claimed_id')).toBe(
      'https://steamcommunity.com/openid/id/76561198000000001',
    );
    expect(nonceRows(w)).toHaveLength(1);
    expect(ownershipChecks(w)).toBe(0);
    expect(w.lines).toEqual([]);
  });

  test("a second exchange of a Steam sign-in's code is refused and ends its chain, leaving no record of the grant acs-10.1", async () => {
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    const signed = await steamSignInToTokens(w, PLAYER);
    expect(recordsOfGrant(w, signed.grantId).length).toBeGreaterThan(1);
    expectInvalidGrant(await exchange(w, signed.code, signed.verifier));
    expectInvalidGrant(await refresh(w, signed.tokens.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
  });

  test("a Steam sign-in's code presented 60 seconds after it was issued is refused, and one second earlier it is exchanged acs-10.1", async () => {
    freezeAt(T0);
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    const late = await steamSignInToCode(w, PLAYER);
    vi.setSystemTime(T0 + 60_000);
    expectInvalidGrant(await exchange(w, late.code, late.verifier));

    vi.setSystemTime(T0 + 120_000);
    const onTime = await steamSignInToCode(w, PLAYER);
    vi.setSystemTime(T0 + 179_000);
    const tokens = tokensOf(await exchange(w, onTime.code, onTime.verifier));
    await expectSteamIdToken(w, tokens.id_token, PLAYER_SUB);
  });

  test('the code and tokens of a Steam sign-in are stored under their digests, and a refresh rotates the refresh token, the spent one then ending the chain acs-10.1', async () => {
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    const signed = await steamSignInToCode(w, PLAYER);
    const tokens = tokensOf(await exchange(w, signed.code, signed.verifier));
    expectStoredUnderDigest(w, [
      ['AuthorizationCode', signed.code],
      ['AccessToken', tokens.access_token],
      ['RefreshToken', tokens.refresh_token],
    ]);
    const rotated = tokensOf(await refresh(w, tokens.refresh_token));
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    await expectSteamIdToken(w, rotated.id_token, PLAYER_SUB);
    expectStoredUnderDigest(w, [['RefreshToken', rotated.refresh_token]]);

    expectInvalidGrant(await refresh(w, tokens.refresh_token));
    expectInvalidGrant(await refresh(w, rotated.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
  });

  test('five loads of one valid reply at once are one decision: Steam is asked once, one grant is made, every load gets the same redirect, and the resume gives a code acs-10.1', async () => {
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    w.stub.refuseReplayedAssertions(true);
    const s = await steamStart(w);
    const target = replyFor(w, s);
    const loads = await Promise.all(Array.from({ length: 5 }, () => call(w, s.jar, 'GET', target)));
    for (const load of loads) {
      expect(load.status, load.body).toBe(303);
      expect(load.headers.location).toBe(`${ISSUER}/auth/${s.started.uid}`);
    }
    expect(openIdChecks(w)).toBe(1);
    expect(grantIds(w)).toHaveLength(1);

    const reload = await call(w, s.jar, 'GET', target);
    expect(reload.status).toBe(303);
    expect(reload.headers.location).toBe(`${ISSUER}/auth/${s.started.uid}`);
    expect(openIdChecks(w)).toBe(1);
    expect(grantIds(w)).toHaveLength(1);

    const code = codeOf(await call(w, s.jar, 'GET', `/auth/${s.started.uid}`), s.started);
    const tokens = tokensOf(await exchange(w, code, s.started.verifier));
    await expectSteamIdToken(w, tokens.id_token, PLAYER_SUB);
  });
});

describe("a reply that fails one of the reply's checks ends the sign-in", () => {
  test.each(
    STEAM_SAYS_INVALID,
  )('a reply with %s is checked with Steam once and ends the sign-in: the ended page, nothing stored, and no code by any continuation acs-10.2', async (_name, make) => {
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    await w.flags.setEntitled(OTHER_PLAYER, true);
    const s = await steamStart(w);
    await expectEndedBy(w, s, await make(w, s), 1);
  });

  test.each(
    REPLY_CHECKS,
  )('a reply with %s ends the sign-in at once: the ended page, nothing sent to Steam, nothing stored, and no code by any continuation acs-10.2', async (_name, make) => {
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    await w.flags.setEntitled(OTHER_PLAYER, true);
    const s = await steamStart(w);
    await expectEndedBy(w, s, await make(w, s), 0);
  });

  test('a reply naming a second listener as its op_endpoint reaches neither listener and ends the sign-in acs-10.2', async () => {
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    const second = await startSteamStub();
    cleanups.push(() => second.close());
    const s = await steamStart(w);
    const target = replyFor(w, s, PLAYER, { op_endpoint: second.openIdEndpoint });
    await expectEndedBy(w, s, target, 0);
    expect(second.requests).toEqual([]);
  });
});

describe('a reused nonce ends the sign-in', () => {
  test('a reply answered not-owned, presented again on the same sign-in once the player is flagged, gets the ended page and no code by any continuation acs-10.2', async () => {
    const w = await steamWorld();
    const s = await steamStart(w);
    const target = replyFor(w, s);
    const first = await call(w, s.jar, 'GET', target);
    expect(first.status).toBe(403);
    expect(first.body).toBe(notOwnedPage());
    expect(nonceRows(w)).toHaveLength(1);

    await w.flags.setEntitled(PLAYER, true);
    const before = rows(w);
    const again = await call(w, s.jar, 'GET', target);
    expect(again.status, again.body).toBe(400);
    expect(again.body).toBe(endedPage());
    expect(addedRows(w, before)).toEqual([]);
    expect(nonceRows(w)).toHaveLength(1);
    await expectEndedForGood(w, s, target);

    // The control: the flag entitles the player on a sign-in of their own with a fresh nonce.
    const signed = await steamSignInToTokens(w, PLAYER);
    await expectSteamIdToken(w, signed.tokens.id_token, PLAYER_SUB);
  });

  test('a new reply signed over the nonce of one answered not-owned, on the same sign-in, gets the ended page and no code by any continuation acs-10.2', async () => {
    const w = await steamWorld();
    const s = await steamStart(w);
    const target = replyFor(w, s);
    const nonce = String(new URLSearchParams(target.split('?')[1]).get('openid.response_nonce'));
    expect((await call(w, s.jar, 'GET', target)).status).toBe(403);

    await w.flags.setEntitled(PLAYER, true);
    const replay = replyFor(w, s, PLAYER, { response_nonce: nonce });
    expect(replay).not.toBe(target);
    const before = rows(w);
    const again = await call(w, s.jar, 'GET', replay);
    expect(again.status, again.body).toBe(400);
    expect(again.body).toBe(endedPage());
    expect(addedRows(w, before)).toEqual([]);
    await expectEndedForGood(w, s, replay);
  });

  test("a reply signed over the nonce of another sign-in's reply gets the ended page and no code acs-10.2", async () => {
    const w = await steamWorld();
    const first = await steamStart(w);
    const target = replyFor(w, first);
    const nonce = String(new URLSearchParams(target.split('?')[1]).get('openid.response_nonce'));
    expect((await call(w, first.jar, 'GET', target)).status).toBe(403);

    await w.flags.setEntitled(PLAYER, true);
    const s = await steamStart(w);
    const replay = replyFor(w, s, PLAYER, { response_nonce: nonce });
    const before = rows(w);
    const again = await call(w, s.jar, 'GET', replay);
    expect(again.status, again.body).toBe(400);
    expect(again.body).toBe(endedPage());
    expect(addedRows(w, before)).toEqual([]);
    await expectEndedForGood(w, s, replay);
  });
});

describe('Steam not answering the check of a reply', () => {
  test('ends the sign-in with the unavailable page, stores no nonce, logs one line holding nothing of the reply, and a new sign-in completes', async () => {
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    const s = await steamStart(w);
    const target = replyFor(w, s);
    const query = new URLSearchParams(target.split('?')[1]);
    w.stub.respondNext('CheckAuthentication', { kind: 'status', status: 500 });
    const before = rows(w);
    const answer = await call(w, s.jar, 'GET', target);
    expect(answer.status, answer.body).toBe(503);
    expect(answer.body).toBe(unavailablePage());
    expect(openIdChecks(w)).toBe(1);
    expect(addedRows(w, before)).toEqual([]);
    expect(nonceRows(w)).toEqual([]);
    expect(w.lines).toHaveLength(1);
    const reply = [
      String(query.get('openid.sig')),
      String(query.get('openid.response_nonce')),
      PLAYER,
      s.callbackState,
      s.returnTo,
    ];
    for (const value of reply) expect(w.lines[0]).not.toContain(value);
    await expectEndedForGood(w, s, target);

    const signed = await steamSignInToTokens(w, PLAYER);
    await expectSteamIdToken(w, signed.tokens.id_token, PLAYER_SUB);
  });
});

describe('a Steam player who is not entitled', () => {
  test('with no flag, a flag set not-entitled, or an entitled flag and a place on the deny-list, gets the not-owned page in the same bytes and nothing stored for a grant acs-10.3', async () => {
    const w = await steamWorld();
    await w.flags.setEntitled(OTHER_PLAYER, false);
    await w.flags.setEntitled(THIRD_PLAYER, true);
    await w.deny.add(THIRD_PLAYER);
    for (const steamId of [PLAYER, OTHER_PLAYER, THIRD_PLAYER]) {
      const s = await steamStart(w);
      const answer = await call(w, s.jar, 'GET', replyFor(w, s, steamId));
      expect(answer.status, steamId).toBe(403);
      expect(answer.body, steamId).toBe(notOwnedPage());
      expect(answer.headers.location).toBeUndefined();
      const resumed = await call(w, s.jar, 'GET', `/auth/${s.started.uid}`);
      expect(resumed.status, steamId).toBe(303);
      expect(interactionUid(resumed.headers.location)).not.toBe(s.started.uid);
    }
    expect(grantIds(w)).toEqual([]);
    expect(issuedRows(w)).toEqual([]);
  });

  test('a not-owned answer leaves the sign-in open: once the player is flagged, a fresh reply on it signs in', async () => {
    const w = await steamWorld();
    const s = await steamStart(w);
    expect((await call(w, s.jar, 'GET', replyFor(w, s))).status).toBe(403);
    await w.flags.setEntitled(PLAYER, true);
    const back = await call(w, s.jar, 'GET', replyFor(w, s));
    expect(back.status, back.body).toBe(303);
    expect(back.headers.location).toBe(`${ISSUER}/auth/${s.started.uid}`);
    const code = codeOf(await call(w, s.jar, 'GET', `/auth/${s.started.uid}`), s.started);
    const tokens = tokensOf(await exchange(w, code, s.started.verifier));
    await expectSteamIdToken(w, tokens.id_token, PLAYER_SUB);
  });

  test.each(
    DEV_REVOCATIONS,
  )("%s between Steam's reply and the resume gives a new sign-in step and no code acs-10.3", async (_name, revoke) => {
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    const s = await steamStart(w);
    const back = await call(w, s.jar, 'GET', replyFor(w, s));
    expect(back.status, back.body).toBe(303);
    await revoke(w);
    const resumed = await call(w, s.jar, 'GET', `/auth/${s.started.uid}`);
    expect(resumed.status).toBe(303);
    expect(interactionUid(resumed.headers.location)).not.toBe(s.started.uid);
    expect(issuedRows(w)).toEqual([]);
  });
});

describe('the entitlement of a Steam sign-in is read again at every issuance', () => {
  test.each(
    DEV_REVOCATIONS,
  )('after a Steam sign-in, %s makes the next refresh fail with every record of the grant gone, and undoing it revives no token of it acs-10.3', async (_name, revoke, restore) => {
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    const signed = await steamSignInToTokens(w, PLAYER);
    const rotated = tokensOf(await refresh(w, signed.tokens.refresh_token));
    expect(recordsOfGrant(w, signed.grantId).length).toBeGreaterThan(1);
    await revoke(w);
    expectInvalidGrant(await refresh(w, rotated.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);

    await restore(w);
    expectInvalidGrant(await refresh(w, rotated.refresh_token));
    expectInvalidGrant(await refresh(w, signed.tokens.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
    // The control: undone, the player signs in again.
    await steamSignInToTokens(w, PLAYER);
  });

  test.each(
    DEV_REVOCATIONS,
  )('after a Steam sign-in, %s makes the code exchange fail with every record of the grant gone, undone or not acs-10.3', async (_name, revoke, restore) => {
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    const signed = await steamSignInToCode(w, PLAYER);
    expect(recordsOfGrant(w, signed.grantId).length).toBeGreaterThan(0);
    await revoke(w);
    expectInvalidGrant(await exchange(w, signed.code, signed.verifier));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
    await restore(w);
    expectInvalidGrant(await exchange(w, signed.code, signed.verifier));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
  });
});

describe('on a production step, the ownership Steam reports decides at every issuance', () => {
  test.each(
    OWNERSHIP_LOSSES,
  )('a player Steam reports with %s gets the not-owned page and nothing stored for a grant acs-10.3', async (_name, ownership) => {
    const w = await steamWorld({ profile: 'production' });
    w.stub.setOwnership(PLAYER, ownership);
    const s = await steamStart(w);
    const answer = await call(w, s.jar, 'GET', replyFor(w, s));
    expect(answer.status, answer.body).toBe(403);
    expect(answer.body).toBe(notOwnedPage());
    expect(ownershipChecks(w)).toBeGreaterThan(0);
    const resumed = await call(w, s.jar, 'GET', `/auth/${s.started.uid}`);
    expect(resumed.status).toBe(303);
    expect(interactionUid(resumed.headers.location)).not.toBe(s.started.uid);
    expect(grantIds(w)).toEqual([]);
    expect(issuedRows(w)).toEqual([]);
  });

  test.each(
    OWNERSHIP_LOSSES,
  )('after a sign-in, Steam reporting %s makes the next refresh fail with every record of the grant gone, and owning it again revives nothing acs-10.3', async (_name, ownership) => {
    const w = await steamWorld({ profile: 'production' });
    w.stub.setOwnership(PLAYER, owned(PLAYER));
    const signed = await steamSignInToTokens(w, PLAYER);
    await expectSteamIdToken(w, signed.tokens.id_token, PLAYER_SUB);
    const rotated = tokensOf(await refresh(w, signed.tokens.refresh_token));
    w.stub.setOwnership(PLAYER, ownership);
    expectInvalidGrant(await refresh(w, rotated.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);

    w.stub.setOwnership(PLAYER, owned(PLAYER));
    expectInvalidGrant(await refresh(w, rotated.refresh_token));
    expectInvalidGrant(await refresh(w, signed.tokens.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
  });

  test.each(
    OWNERSHIP_LOSSES,
  )('after a sign-in, Steam reporting %s makes the code exchange fail with every record of the grant gone acs-10.3', async (_name, ownership) => {
    const w = await steamWorld({ profile: 'production' });
    w.stub.setOwnership(PLAYER, owned(PLAYER));
    const signed = await steamSignInToCode(w, PLAYER);
    w.stub.setOwnership(PLAYER, ownership);
    expectInvalidGrant(await exchange(w, signed.code, signed.verifier));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
    w.stub.setOwnership(PLAYER, owned(PLAYER));
    expectInvalidGrant(await exchange(w, signed.code, signed.verifier));
  });

  test('an owner on the deny-list gets the not-owned page, and denying an owner after a sign-in ends the chain, allowed again or not acs-10.3', async () => {
    const w = await steamWorld({ profile: 'production' });
    w.stub.setOwnership(PLAYER, owned(PLAYER));
    w.stub.setOwnership(OTHER_PLAYER, owned(OTHER_PLAYER));
    await w.deny.add(OTHER_PLAYER);
    const s = await steamStart(w);
    const answer = await call(w, s.jar, 'GET', replyFor(w, s, OTHER_PLAYER));
    expect(answer.status, answer.body).toBe(403);
    expect(answer.body).toBe(notOwnedPage());
    expect(grantIds(w)).toEqual([]);

    const signed = await steamSignInToTokens(w, PLAYER);
    await w.deny.add(PLAYER);
    expectInvalidGrant(await refresh(w, signed.tokens.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
    await w.deny.remove(PLAYER);
    expectInvalidGrant(await refresh(w, signed.tokens.refresh_token));
  });

  test.each(
    OWNERSHIP_OUTAGES,
  )('an ownership check that %s at a refresh is a server error that revokes nothing, and the same refresh token works once Steam answers acs-10.3', async (_name, outage) => {
    const w = await steamWorld({ profile: 'production' });
    w.stub.setOwnership(PLAYER, owned(PLAYER));
    const signed = await steamSignInToTokens(w, PLAYER);
    const before = recordsOfGrant(w, signed.grantId).length;
    expect(before).toBeGreaterThan(1);
    w.stub.respondNext('CheckAppOwnership', outage);
    const failed = await refresh(w, signed.tokens.refresh_token);
    expect(failed.status, JSON.stringify(failed.json)).toBeGreaterThanOrEqual(500);
    expect(failed.status).toBeLessThan(600);
    expect(failed.json.error).toBe('server_error');
    expect(failed.json).not.toHaveProperty('id_token');
    expect(recordsOfGrant(w, signed.grantId)).toHaveLength(before);

    const next = tokensOf(await refresh(w, signed.tokens.refresh_token));
    await expectSteamIdToken(w, next.id_token, PLAYER_SUB);
  });
});

describe('one player through the ticket grant and through the browser', () => {
  test.each([
    ['local-dev'],
    ['production'],
  ] as const)('on %s gets ID tokens with one sub, steam:<steamid64> acs-10.4', async (profile) => {
    const w = await steamWorld({ profile, ticketGrant: true });
    await entitle(w, PLAYER);
    const browser = await steamSignInToTokens(w, PLAYER);
    const fromBrowser = await expectSteamIdToken(w, browser.tokens.id_token, PLAYER_SUB);
    const fromTicket = await expectSteamIdToken(w, await ticketIdToken(w, PLAYER), PLAYER_SUB);
    expect(fromTicket.sub).toBe(fromBrowser.sub);
    expect(fromBrowser.sub).toBe('steam:76561198000000001');
  });
});

describe('a dev profile', () => {
  test('without Steam offers the password form alone, the same bytes as before, answers its Steam callback 404 and writes and asks nothing acs-10.5', async () => {
    const w = await steamWorld({ signIn: 'dev-password', withSteam: false });
    const jar = newJar();
    const started = await begin(w, jar);
    const page = await call(w, jar, 'GET', started.path);
    expect(page.status).toBe(200);
    expect(page.body).toBe(signInPage({ action: started.path }));
    expect(page.body).not.toMatch(/<a[\s>]/);

    const before = rows(w);
    const callback = `${started.path}/steam?state=${MADE_UP_STATE}&openid.mode=id_res`;
    const answer = await call(w, jar, 'GET', callback);
    expect(answer.status).toBe(404);
    expect(rows(w)).toEqual(before);
    expect(w.stub.requests).toEqual([]);

    const who = await person(w);
    const signed = await signInToTokens(w, who);
    expectIdTokenClaims(signed.tokens.id_token, who);
  });

  test("with Steam offers the form and one link to Steam's login address, and the password sign-in still works beside it acs-10.5", async () => {
    const w = await steamWorld({ signIn: 'dev-password' });
    const s = await steamStart(w);
    expect(s.loginUrl.startsWith(`${w.stub.openIdEndpoint}?`)).toBe(true);
    const who = await person(w);
    const tokens = await passwordSignInBesideSteam(w, who);
    expectIdTokenClaims(tokens.id_token, who);
    expect(w.stub.requests).toEqual([]);
  });

  test('a Steam sign-in there is entitled by the dev flag alone: a licence Steam would report, with no flag or a flag set not-entitled, gets the not-owned page, and Steam is never asked about ownership acs-10.5', async () => {
    const w = await steamWorld({ signIn: 'dev-password' });
    w.stub.setOwnership(PLAYER, owned(PLAYER));
    for (const flag of ['none', 'not-entitled'] as const) {
      if (flag === 'not-entitled') await w.flags.setEntitled(PLAYER, false);
      const s = await steamStart(w);
      const answer = await call(w, s.jar, 'GET', replyFor(w, s));
      expect(answer.status, flag).toBe(403);
      expect(answer.body, flag).toBe(notOwnedPage());
      const resumed = await call(w, s.jar, 'GET', `/auth/${s.started.uid}`);
      expect(resumed.status, flag).toBe(303);
      expect(interactionUid(resumed.headers.location)).not.toBe(s.started.uid);
    }
    expect(grantIds(w)).toEqual([]);
    expect(ownershipChecks(w)).toBe(0);
  });

  test('a Steam player the dev flag entitles signs in there with no licence at Steam, and the flag alone ends the chain at a refresh, Steam never asked about ownership acs-10.5', async () => {
    const w = await steamWorld({ signIn: 'dev-password' });
    await w.flags.setEntitled(PLAYER, true);
    const signed = await steamSignInToTokens(w, PLAYER);
    await expectSteamIdToken(w, signed.tokens.id_token, PLAYER_SUB);
    const rotated = tokensOf(await refresh(w, signed.tokens.refresh_token));
    w.stub.setOwnership(PLAYER, owned(PLAYER));
    await w.flags.setEntitled(PLAYER, false);
    expectInvalidGrant(await refresh(w, rotated.refresh_token));
    expect(recordsOfGrant(w, signed.grantId)).toEqual([]);
    expect(ownershipChecks(w)).toBe(0);
  });

  test('with Steam, each kind of account is read from its own source at a refresh: a dev: subject from the password accounts, a steam: subject from the dev flag acs-10.5', async () => {
    const w = await steamWorld({ signIn: 'dev-password' });
    await w.flags.setEntitled(PLAYER, true);
    const dev = await person(w);
    const devChain = await passwordSignInBesideSteam(w, dev);
    const steamChain = await steamSignInToTokens(w, PLAYER);

    await w.accounts.setEntitled(dev.email, false);
    expectInvalidGrant(await refresh(w, devChain.refresh_token));
    const steamNext = tokensOf(await refresh(w, steamChain.tokens.refresh_token));
    await expectSteamIdToken(w, steamNext.id_token, PLAYER_SUB);

    const otherDev = await person(w);
    const otherChain = await passwordSignInBesideSteam(w, otherDev);
    await w.flags.setEntitled(PLAYER, false);
    expectInvalidGrant(await refresh(w, steamNext.refresh_token));
    expectIdTokenClaims(tokensOf(await refresh(w, otherChain.refresh_token)).id_token, otherDev);
    expect(ownershipChecks(w)).toBe(0);
  });
});

describe('the time of a Steam sign-in', () => {
  test('the code, every refresh token and an ID token asked for with max_age carry the second the reply was checked, however late the resume', async () => {
    freezeAt(T0);
    const w = await steamWorld();
    await w.flags.setEntitled(PLAYER, true);
    const s = await steamStart(w, { max_age: '3600' });
    vi.setSystemTime(T0 + 5000);
    const back = await call(w, s.jar, 'GET', replyFor(w, s));
    expect(back.status, back.body).toBe(303);

    vi.setSystemTime(T0 + 40_000);
    const code = codeOf(await call(w, s.jar, 'GET', `/auth/${s.started.uid}`), s.started);
    expect(storedPayload(w, 'AuthorizationCode', code).authTime).toBe(T0_SECONDS + 5);

    vi.setSystemTime(T0 + 41_000);
    const tokens = tokensOf(await exchange(w, code, s.started.verifier));
    const payload = payloadOf(tokens.id_token);
    expect(payload.sub).toBe(PLAYER_SUB);
    expect(payload.auth_time).toBe(T0_SECONDS + 5);
    expect(payload.iat).toBe(T0_SECONDS + 41);
    expect(storedPayload(w, 'RefreshToken', tokens.refresh_token).authTime).toBe(T0_SECONDS + 5);

    vi.setSystemTime(T0 + 600_000);
    const rotated = tokensOf(await refresh(w, tokens.refresh_token));
    expect(storedPayload(w, 'RefreshToken', rotated.refresh_token).authTime).toBe(T0_SECONDS + 5);
  });

  test("a password reset of a dev account in a later second ends that account's chain and leaves a Steam player's code and chain working", async () => {
    freezeAt(T0);
    const w = await steamWorld({ signIn: 'dev-password' });
    await w.flags.setEntitled(PLAYER, true);
    const someone = await person(w);
    const theirs = await passwordSignInBesideSteam(w, someone);
    const chain = await steamSignInToTokens(w, PLAYER);
    const held = await steamSignInToCode(w, PLAYER);

    vi.setSystemTime(T0 + 1000);
    await w.accounts.resetPassword(someone.email);
    vi.setSystemTime(T0 + 2000);
    expectInvalidGrant(await refresh(w, theirs.refresh_token));
    const rotated = tokensOf(await refresh(w, chain.tokens.refresh_token));
    await expectSteamIdToken(w, rotated.id_token, PLAYER_SUB);
    tokensOf(await refresh(w, rotated.refresh_token));
    const exchanged = tokensOf(await exchange(w, held.code, held.verifier));
    await expectSteamIdToken(w, exchanged.id_token, PLAYER_SUB);
  });
});
