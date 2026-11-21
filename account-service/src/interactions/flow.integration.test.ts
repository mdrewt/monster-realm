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
import { ID_TOKEN_CLAIMS } from '../claims.ts';
import { generateSigningKey, type SigningJwk } from '../keys.ts';
import { createAccountProvider, registerClient, SIGN_IN_TTL_SECONDS } from '../provider.ts';
import { type AccountStore, openAccountStore } from '../store/sqliteAdapter.ts';
import { type DevAccounts, devAccounts, devPasswordStep } from './devPassword.ts';
import { endedPage, notOwnedPage, signInPage } from './pages.ts';
import type { PasswordStep } from './router.ts';

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
