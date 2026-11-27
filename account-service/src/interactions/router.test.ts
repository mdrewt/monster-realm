import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { generateSigningKey } from '../keys.ts';
import { createAccountProvider, registerClient, SIGN_IN_TTL_SECONDS } from '../provider.ts';
import { type AccountStore, openAccountStore } from '../store/sqliteAdapter.ts';
import { endedPage, notOwnedPage, PAGE_HEADERS, signInPage, unavailablePage } from './pages.ts';
import type {
  Account,
  PasswordAndSteamStep,
  PasswordStep,
  SignInOutcome,
  SteamSignInOutcome,
  SteamStep,
} from './router.ts';

// `/interaction/<uid>` over HTTP, through `createAccountProvider(...).handler`, with a stub
// sign-in step whose every outcome is scripted and whose every call is recorded.

const ISSUER = 'http://localhost:4455';
const HOST = 'localhost:4455';
const CLIENT_ID = 'monster-realm';
const REDIRECT_URI = 'http://localhost:5290/';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const BODY_LIMIT = 8192;
const T0 = 1_800_000_000_000;

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
  chunked = false,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const all = { ...headers };
    if (body !== undefined && !chunked) all['content-length'] = String(Buffer.byteLength(body));
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

// A browser's cookie jar, as far as this flow needs one: a cookie goes only to a path its `Path`
// covers, and a cookie set again under the same name and path takes the place of the one held.
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

/** The cookie header the jar sends to `target`, with the named cookie's value rewritten. */
function rewritten(jar: Jar, target: string, name: string, change: (value: string) => string) {
  const path = target.split('?')[0] ?? target;
  const sent = jar.cookies.filter((c) => pathCovers(c.path, path));
  expect(sent.map((c) => c.name)).toContain(name);
  return sent.map((c) => `${c.name}=${c.name === name ? change(c.value) : c.value}`).join('; ');
}

function otherLastChar(value: string): string {
  const last = value.slice(-1);
  return `${value.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
}

// The stub sign-in step.
interface Stub extends PasswordStep {
  readonly attempts: Array<readonly [string, string]>;
  readonly script: Array<SignInOutcome | Error>;
  readonly accounts: Map<string, Account>;
}

function stubStep(): Stub {
  const attempts: Array<readonly [string, string]> = [];
  const script: Array<SignInOutcome | Error> = [];
  const accounts = new Map<string, Account>();
  return {
    kind: 'password',
    attempts,
    script,
    accounts,
    attempt(email, password) {
      attempts.push([email, password]);
      const next = script.shift() ?? { kind: 'refused' };
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    account(sub) {
      return Promise.resolve(accounts.get(sub));
    },
  };
}

// Every write the provider makes through the adapter, counted and recorded.
interface Upsert {
  readonly model: string;
  readonly id: string;
  readonly payload: AdapterPayload;
  readonly expiresIn: number | undefined;
}

interface Writes {
  count: number;
  upserts: Upsert[];
}

function watched(base: (model: string) => Adapter, writes: Writes): (model: string) => Adapter {
  return (model) => {
    const inner = base(model);
    return {
      upsert(id, payload, expiresIn) {
        writes.count += 1;
        writes.upserts.push({ model, id, payload, expiresIn });
        return inner.upsert(id, payload, expiresIn);
      },
      find: (id) => inner.find(id),
      findByUid: (uid) => inner.findByUid(uid),
      findByUserCode: (userCode) => inner.findByUserCode(userCode),
      consume(id) {
        writes.count += 1;
        return inner.consume(id);
      },
      destroy(id) {
        writes.count += 1;
        return inner.destroy(id);
      },
      revokeByGrantId(grantId) {
        writes.count += 1;
        return inner.revokeByGrantId(grantId);
      },
    };
  };
}

interface World {
  readonly port: number;
  readonly step: Stub;
  readonly writes: Writes;
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

async function freshStore(): Promise<AccountStore> {
  const store = openAccountStore(':memory:');
  cleanups.push(() => {
    store.close();
  });
  await registerClient(store.adapter, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
  return store;
}

async function serve(store: AccountStore): Promise<World> {
  const writes: Writes = { count: 0, upserts: [] };
  const step = stubStep();
  const { handler } = createAccountProvider({
    issuer: ISSUER,
    keys: { keys: [generateSigningKey()] },
    adapter: watched(store.adapter, writes),
    signIn: step,
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
  return { port: (server.address() as AddressInfo).port, step, writes };
}

async function world(): Promise<World> {
  return serve(await freshStore());
}

function resetWrites(w: World): void {
  w.writes.count = 0;
  w.writes.upserts.length = 0;
}

function grantIds(w: World): string[] {
  return [...new Set(w.writes.upserts.filter((u) => u.model === 'Grant').map((u) => u.id))];
}

interface CallOptions {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** `undefined`: the jar's cookies for the target; `null`: none; a string: exactly that. */
  readonly cookie?: string | null;
  readonly chunked?: boolean;
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
  const reply = await send(w.port, method, target, headers, options.body, options.chunked ?? false);
  absorb(jar, reply);
  return reply;
}

const GOOD_POST: Record<string, string> = { origin: ISSUER, 'content-type': FORM_TYPE };

function credentials(email: string, password: string): string {
  return new URLSearchParams({ email, password }).toString();
}

const VALID_BODY = credentials('one@example.com', 'pw');

/** A valid body padded with an ignored field to exactly `bytes` bytes. */
function padded(bytes: number): string {
  const base = `${VALID_BODY}&pad=`;
  return `${base}${'x'.repeat(bytes - base.length)}`;
}

interface Started {
  readonly uid: string;
  readonly path: string;
  readonly state: string;
  /** The raw `Set-Cookie` lines of the authorization request's reply. */
  readonly setCookie: readonly string[];
}

async function begin(w: World, jar: Jar): Promise<Started> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(9).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const reply = await call(w, jar, 'GET', `/auth?${query}`);
  expect(reply.status, reply.body).toBe(303);
  const target = new URL(String(reply.headers.location), ISSUER);
  expect(target.origin).toBe(ISSUER);
  const match = /^\/interaction\/([^/]+)$/.exec(target.pathname);
  expect(match, target.href).not.toBeNull();
  const uid = match![1]!;
  return { uid, path: `/interaction/${uid}`, state, setCookie: reply.headers['set-cookie'] ?? [] };
}

async function opened(): Promise<{ w: World; jar: Jar; started: Started }> {
  const w = await world();
  const jar = newJar();
  const started = await begin(w, jar);
  resetWrites(w);
  return { w, jar, started };
}

function expectRouterHeaders(reply: Reply): void {
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
}

function expectPage(reply: Reply, html: string): void {
  expectRouterHeaders(reply);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) {
    expect(reply.headers[name.toLowerCase()], name).toBe(value);
  }
  expect(reply.body).toBe(html);
}

function expectText(reply: Reply, status: number): void {
  expect(reply.status).toBe(status);
  expect(String(reply.headers['content-type'])).toMatch(/^text\/plain/);
  expectRouterHeaders(reply);
}

describe('GET /interaction/<uid>', () => {
  test('with its sign-in cookies serves the form whose action is that path, with every page header', async () => {
    const { w, jar, started } = await opened();
    const reply = await call(w, jar, 'GET', started.path);
    expect(reply.status).toBe(200);
    expectPage(reply, signInPage({ action: started.path }));
    expect(w.step.attempts).toEqual([]);
  });

  test('the authorization request set the two interaction cookies and their signatures, HttpOnly, SameSite=Lax, scoped to the sign-in, and one Interaction record living SIGN_IN_TTL_SECONDS', async () => {
    const w = await world();
    const jar = newJar();
    const started = await begin(w, jar);
    const byName = new Map(jar.cookies.map((c) => [c.name, c.path]));
    expect(byName.get('_interaction')).toBe(started.path);
    expect(byName.get('_interaction.sig')).toBe(started.path);
    expect(byName.get('_interaction_resume')).toBe(`/auth/${started.uid}`);
    expect(byName.get('_interaction_resume.sig')).toBe(`/auth/${started.uid}`);
    for (const name of [
      '_interaction',
      '_interaction.sig',
      '_interaction_resume',
      '_interaction_resume.sig',
    ]) {
      const line = started.setCookie.find((l) => l.startsWith(`${name}=`));
      expect(line, name).toBeDefined();
      const attributes = line!
        .split(';')
        .slice(1)
        .map((a) => a.trim().toLowerCase());
      expect(attributes, name).toContain('httponly');
      expect(attributes, name).toContain('samesite=lax');
    }
    const interactions = w.writes.upserts.filter((u) => u.model === 'Interaction');
    expect(interactions).toHaveLength(1);
    expect(interactions[0]!.expiresIn).toBe(SIGN_IN_TTL_SECONDS);
  });

  test.each([
    ['no cookies', (_jar: Jar, _path: string): string | null => null],
    [
      'an _interaction cookie whose value was changed',
      (jar: Jar, path: string): string | null =>
        rewritten(jar, path, '_interaction', (value) => `${value}x`),
    ],
    [
      'an _interaction cookie whose signature was changed',
      (jar: Jar, path: string): string | null =>
        rewritten(jar, path, '_interaction.sig', otherLastChar),
    ],
  ])('with %s is the ended page, writes nothing and never asks the step', async (_name, cookie) => {
    const { w, jar, started } = await opened();
    const reply = await call(w, jar, 'GET', started.path, { cookie: cookie(jar, started.path) });
    expect(reply.status).toBe(400);
    expectPage(reply, endedPage());
    expect(w.step.attempts).toEqual([]);
    expect(w.writes.count).toBe(0);
  });

  test("with another sign-in's cookies is the ended page and writes nothing", async () => {
    const w = await world();
    const first = newJar();
    const second = newJar();
    const one = await begin(w, first);
    const two = await begin(w, second);
    resetWrites(w);
    const reply = await call(w, first, 'GET', one.path, { cookie: cookiesFor(second, two.path) });
    expect(reply.status).toBe(400);
    expectPage(reply, endedPage());
    expect(w.writes.count).toBe(0);
    // The control: each sign-in's own cookies still open its own form.
    expect((await call(w, first, 'GET', one.path)).status).toBe(200);
    expect((await call(w, second, 'GET', two.path)).status).toBe(200);
  });

  test('after the sign-in has expired is the ended page, for GET and POST, and never asks the step', async () => {
    freezeAt(T0);
    const { w, jar, started } = await opened();
    vi.setSystemTime(T0 + SIGN_IN_TTL_SECONDS * 1000);
    const shown = await call(w, jar, 'GET', started.path);
    expect(shown.status).toBe(400);
    expectPage(shown, endedPage());
    const posted = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: VALID_BODY,
    });
    expect(posted.status).toBe(400);
    expectPage(posted, endedPage());
    expect(w.step.attempts).toEqual([]);
    expect(w.writes.count).toBe(0);
  });
});

describe('cookie keys are made per provider instance', () => {
  test("a second provider over the same store refuses the first one's interaction cookies with the ended page", async () => {
    const store = await freshStore();
    const a = await serve(store);
    const b = await serve(store);
    const jar = newJar();
    const started = await begin(a, jar);
    const cookie = cookiesFor(jar, started.path);
    resetWrites(a);
    resetWrites(b);

    const shown = await call(b, newJar(), 'GET', started.path, { cookie });
    expect(shown.status).toBe(400);
    expectPage(shown, endedPage());
    const posted = await call(b, newJar(), 'POST', started.path, {
      cookie,
      headers: GOOD_POST,
      body: VALID_BODY,
    });
    expect(posted.status).toBe(400);
    expectPage(posted, endedPage());
    expect(b.step.attempts).toEqual([]);
    expect(b.writes.count).toBe(0);

    // The control: the instance that set them accepts them.
    const own = await call(a, jar, 'GET', started.path);
    expect(own.status).toBe(200);
    expectPage(own, signInPage({ action: started.path }));
  });
});

interface Refusal {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly cookies: boolean;
  readonly chunked?: boolean;
  readonly status: number;
  readonly ended?: boolean;
}

const REFUSALS: ReadonlyArray<readonly [string, Refusal]> = [
  [
    'PUT, with a foreign origin, a wrong media type and no cookies, is 405 with Allow: GET, POST',
    {
      method: 'PUT',
      headers: { origin: 'http://evil.example', 'content-type': 'text/plain' },
      body: 'x',
      cookies: false,
      status: 405,
    },
  ],
  [
    'DELETE with the sign-in cookies is 405 with Allow: GET, POST',
    { method: 'DELETE', headers: GOOD_POST, cookies: true, status: 405 },
  ],
  [
    'a POST with no Origin, a wrong media type and no cookies is 403',
    {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: VALID_BODY,
      cookies: false,
      status: 403,
    },
  ],
  [
    'a POST from a foreign origin, otherwise valid, is 403',
    {
      method: 'POST',
      headers: { ...GOOD_POST, origin: 'http://evil.example' },
      body: VALID_BODY,
      cookies: true,
      status: 403,
    },
  ],
  [
    "a POST from the issuer's host on another port is 403",
    {
      method: 'POST',
      headers: { ...GOOD_POST, origin: 'http://localhost:4456' },
      body: VALID_BODY,
      cookies: true,
      status: 403,
    },
  ],
  [
    "a POST whose Origin only begins with the issuer's origin, as a longer host, is 403",
    {
      method: 'POST',
      headers: { ...GOOD_POST, origin: 'http://localhost:4455.evil.example' },
      body: VALID_BODY,
      cookies: true,
      status: 403,
    },
  ],
  [
    "a POST whose Origin only begins with the issuer's origin, as a longer port, is 403",
    {
      method: 'POST',
      headers: { ...GOOD_POST, origin: 'http://localhost:44556' },
      body: VALID_BODY,
      cookies: true,
      status: 403,
    },
  ],
  [
    "a POST with no Origin but a Referer on the issuer's origin is 403",
    {
      method: 'POST',
      headers: { 'content-type': FORM_TYPE, referer: `${ISSUER}/interaction/x` },
      body: VALID_BODY,
      cookies: true,
      status: 403,
    },
  ],
  [
    "a POST with no Origin but a Referer that is the issuer's root is 403",
    {
      method: 'POST',
      headers: { 'content-type': FORM_TYPE, referer: `${ISSUER}/` },
      body: VALID_BODY,
      cookies: true,
      status: 403,
    },
  ],
  [
    'a POST whose Origin is "null" is 403',
    {
      method: 'POST',
      headers: { ...GOOD_POST, origin: 'null' },
      body: VALID_BODY,
      cookies: true,
      status: 403,
    },
  ],
  [
    "a POST from the game client's origin is 403",
    {
      method: 'POST',
      headers: { ...GOOD_POST, origin: 'http://localhost:5290' },
      body: VALID_BODY,
      cookies: true,
      status: 403,
    },
  ],
  [
    'a text/plain POST with no cookies and an oversized body is 415',
    {
      method: 'POST',
      headers: { origin: ISSUER, 'content-type': 'text/plain' },
      body: padded(BODY_LIMIT + 1),
      cookies: false,
      status: 415,
    },
  ],
  [
    'a multipart/form-data POST is 415',
    {
      method: 'POST',
      headers: { origin: ISSUER, 'content-type': 'multipart/form-data; boundary=b' },
      body: VALID_BODY,
      cookies: true,
      status: 415,
    },
  ],
  [
    'a POST with no content type is 415',
    { method: 'POST', headers: { origin: ISSUER }, body: VALID_BODY, cookies: true, status: 415 },
  ],
  [
    'a valid POST with no cookies and an oversized body is the ended page',
    {
      method: 'POST',
      headers: GOOD_POST,
      body: padded(BODY_LIMIT + 1),
      cookies: false,
      status: 400,
      ended: true,
    },
  ],
  [
    'a POST with its cookies and a body one byte over the limit is 413',
    {
      method: 'POST',
      headers: GOOD_POST,
      body: padded(BODY_LIMIT + 1),
      cookies: true,
      status: 413,
    },
  ],
  [
    'a chunked POST with its cookies and a body one byte over the limit is 413',
    {
      method: 'POST',
      headers: GOOD_POST,
      body: padded(BODY_LIMIT + 1),
      cookies: true,
      chunked: true,
      status: 413,
    },
  ],
  [
    'a POST with no password field is 400 text',
    {
      method: 'POST',
      headers: GOOD_POST,
      body: 'email=one%40example.com',
      cookies: true,
      status: 400,
    },
  ],
  [
    'a POST with two email fields is 400 text',
    {
      method: 'POST',
      headers: GOOD_POST,
      body: `${VALID_BODY}&email=two%40example.com`,
      cookies: true,
      status: 400,
    },
  ],
  [
    'a POST with two password fields is 400 text',
    {
      method: 'POST',
      headers: GOOD_POST,
      body: `${VALID_BODY}&password=other`,
      cookies: true,
      status: 400,
    },
  ],
  [
    'a POST with an empty body is 400 text',
    { method: 'POST', headers: GOOD_POST, body: '', cookies: true, status: 400 },
  ],
];

describe('POST /interaction/<uid> refuses in the contract order, and no refusal asks the step', () => {
  test.each(REFUSALS)('%s', async (_name, refusal) => {
    const { w, jar, started } = await opened();
    const reply = await call(w, jar, refusal.method, started.path, {
      headers: refusal.headers,
      body: refusal.body,
      cookie: refusal.cookies ? undefined : null,
      chunked: refusal.chunked,
    });
    expect(reply.status).toBe(refusal.status);
    expectRouterHeaders(reply);
    if (refusal.status === 405) {
      expect(reply.headers.allow).toBe('GET, POST');
    } else if (refusal.ended === true) {
      expectPage(reply, endedPage());
    } else {
      expectText(reply, refusal.status);
    }
    expect(w.step.attempts).toEqual([]);
    expect(w.writes.count).toBe(0);
  });

  test.each([
    'application/x-www-form-urlencoded; charset=UTF-8',
    'Application/X-WWW-Form-URLEncoded',
  ])('the media type %s is accepted and reaches the step', async (type) => {
    const { w, jar, started } = await opened();
    const reply = await call(w, jar, 'POST', started.path, {
      headers: { origin: ISSUER, 'content-type': type },
      body: VALID_BODY,
    });
    expect(reply.status).toBe(400);
    expectPage(reply, signInPage({ action: started.path, notice: 'refused' }));
    expect(w.step.attempts).toEqual([['one@example.com', 'pw']]);
  });

  test.each([
    ['with a content length', false],
    ['chunked', true],
  ])('a body of exactly the limit, sent %s, reaches the step', async (_name, chunked) => {
    const { w, jar, started } = await opened();
    const body = padded(BODY_LIMIT);
    expect(Buffer.byteLength(body)).toBe(BODY_LIMIT);
    const reply = await call(w, jar, 'POST', started.path, { headers: GOOD_POST, body, chunked });
    expect(reply.status).toBe(400);
    expect(w.step.attempts).toEqual([['one@example.com', 'pw']]);
  });

  test('the step gets the decoded email and password, and other fields are ignored', async () => {
    const { w, jar, started } = await opened();
    const password = 'p w&=+%';
    const body = `remember=1&${new URLSearchParams({ email: 'dev+1@example.com', password })}&x=`;
    const reply = await call(w, jar, 'POST', started.path, { headers: GOOD_POST, body });
    expect(reply.status).toBe(400);
    expect(w.step.attempts).toEqual([['dev+1@example.com', password]]);
  });
});

describe('POST /interaction/<uid> answers each outcome of the step', () => {
  test('signed-in is a 303 to the resume, with one openid grant stored for that subject and client, and the resume gives a code', async () => {
    const { w, jar, started } = await opened();
    w.step.accounts.set('dev:one', { sub: 'dev:one', entitled: true });
    w.step.script.push({ kind: 'signed-in', sub: 'dev:one' });
    const reply = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials('one@example.com', 'right horse'),
    });
    expect(reply.status).toBe(303);
    expectRouterHeaders(reply);
    expect(reply.headers.location).toBe(`${ISSUER}/auth/${started.uid}`);
    expect(w.step.attempts).toEqual([['one@example.com', 'right horse']]);

    expect(grantIds(w)).toHaveLength(1);
    const stored = w.writes.upserts.filter((u) => u.model === 'Grant').at(-1)!.payload;
    const grant = stored as unknown as Record<string, unknown>;
    expect(grant.accountId).toBe('dev:one');
    expect(grant.clientId).toBe(CLIENT_ID);
    const openid = grant.openid as { scope?: unknown } | undefined;
    expect(String(openid?.scope).split(' ')).toContain('openid');

    const resumed = await call(w, jar, 'GET', `/auth/${started.uid}`);
    expect(resumed.status).toBe(303);
    const back = new URL(String(resumed.headers.location));
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    expect(back.searchParams.get('code')).toEqual(expect.any(String));
    expect(back.searchParams.get('state')).toBe(started.state);
    expect(back.searchParams.get('iss')).toBe(ISSUER);
  });

  test('a further POST after signed-in gets the same 303, without asking the step again or storing a second grant', async () => {
    const { w, jar, started } = await opened();
    w.step.accounts.set('dev:one', { sub: 'dev:one', entitled: true });
    w.step.script.push(
      { kind: 'signed-in', sub: 'dev:one' },
      { kind: 'signed-in', sub: 'dev:two' },
    );
    const first = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: VALID_BODY,
    });
    expect(first.status).toBe(303);
    const again = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials('two@example.com', 'other'),
    });
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe(first.headers.location);
    expect(w.step.attempts).toHaveLength(1);
    expect(grantIds(w)).toHaveLength(1);
  });

  test('not-owned is a 403 not-owned page with no grant, and the resume starts a new sign-in with no code acs-2.2', async () => {
    const { w, jar, started } = await opened();
    w.step.script.push({ kind: 'not-owned' });
    const email = 'unowned@example.com';
    const reply = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials(email, 'right horse'),
    });
    expect(reply.status).toBe(403);
    expectPage(reply, notOwnedPage());
    expect(reply.body).not.toContain(email);
    expect(grantIds(w)).toEqual([]);

    const resumed = await call(w, jar, 'GET', `/auth/${started.uid}`);
    expect(resumed.status).toBe(303);
    const location = String(resumed.headers.location);
    const target = new URL(location, ISSUER);
    expect(target.origin).toBe(ISSUER);
    expect(target.pathname).toMatch(/^\/interaction\/[^/]+$/);
    expect(target.pathname).not.toBe(started.path);
    expect(location).not.toContain('code=');
    expect(grantIds(w)).toEqual([]);
  });

  test('after not-owned the same sign-in accepts another attempt acs-2.2', async () => {
    const { w, jar, started } = await opened();
    w.step.accounts.set('dev:owner', { sub: 'dev:owner', entitled: true });
    w.step.script.push({ kind: 'not-owned' }, { kind: 'signed-in', sub: 'dev:owner' });
    const first = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: VALID_BODY,
    });
    expect(first.status).toBe(403);
    expect(grantIds(w)).toEqual([]);
    const second = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials('owner@example.com', 'pw2'),
    });
    expect(second.status).toBe(303);
    expect(second.headers.location).toBe(`${ISSUER}/auth/${started.uid}`);
    expect(w.step.attempts).toHaveLength(2);
    expect(grantIds(w)).toHaveLength(1);
  });

  test('refused is a 400 form with the refused notice, byte-identical whatever the email, naming neither acs-2.3', async () => {
    const { w, jar, started } = await opened();
    w.step.script.push({ kind: 'refused' }, { kind: 'refused' });
    const known = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials('known@example.com', 'secret-one'),
    });
    const unknown = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials('nobody@example.com', 'secret-two'),
    });
    for (const reply of [known, unknown]) {
      expect(reply.status).toBe(400);
      expectPage(reply, signInPage({ action: started.path, notice: 'refused' }));
      for (const secret of [
        'known@example.com',
        'nobody@example.com',
        'secret-one',
        'secret-two',
      ]) {
        expect(reply.body).not.toContain(secret);
      }
    }
    expect(unknown.body).toBe(known.body);
    expect(grantIds(w)).toEqual([]);
  });

  test('locked is a 429 form with the locked notice, byte-identical whatever the email acs-2.3', async () => {
    const { w, jar, started } = await opened();
    w.step.script.push({ kind: 'locked' }, { kind: 'locked' });
    const known = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials('known@example.com', 'right horse'),
    });
    const unknown = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials('nobody@example.com', 'right horse'),
    });
    for (const reply of [known, unknown]) {
      expect(reply.status).toBe(429);
      expectPage(reply, signInPage({ action: started.path, notice: 'locked' }));
      expect(reply.body).not.toContain('example.com');
    }
    expect(unknown.body).toBe(known.body);
    expect(grantIds(w)).toEqual([]);
  });

  test('a run of refusals then a lock is answered 400 each time and then 429, with no grant acs-2.3', async () => {
    const { w, jar, started } = await opened();
    w.step.script.push(
      ...Array.from({ length: 5 }, (): SignInOutcome => ({ kind: 'refused' })),
      { kind: 'locked' },
      { kind: 'locked' },
    );
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const reply = await call(w, jar, 'POST', started.path, {
        headers: GOOD_POST,
        body: credentials('known@example.com', `guess-${i}`),
      });
      statuses.push(reply.status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429, 429]);
    expect(w.step.attempts).toHaveLength(7);
    expect(grantIds(w)).toEqual([]);
  });

  test('busy is a 503 form with the busy notice', async () => {
    const { w, jar, started } = await opened();
    w.step.script.push({ kind: 'busy' });
    const reply = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: VALID_BODY,
    });
    expect(reply.status).toBe(503);
    expectPage(reply, signInPage({ action: started.path, notice: 'busy' }));
    expect(grantIds(w)).toEqual([]);
  });

  test('an attempt that rejects is a 500 in plain text with no detail of the error', async () => {
    const { w, jar, started } = await opened();
    w.step.script.push(new Error('INTERNAL_DETAIL_argon2_pool_exploded'));
    const reply = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: VALID_BODY,
    });
    expectText(reply, 500);
    expect(reply.body).not.toContain('INTERNAL_DETAIL');
    expect(reply.body).not.toContain('argon2');
    expect(grantIds(w)).toEqual([]);
  });
});

// ---- the Steam step ----
//
// The same router with a scripted Steam step, alone (`kind: 'steam'`) and beside the password stub
// (`kind: 'password-and-steam'`). Its `loginUrl` records the callback it is given and answers an
// address built from it; its `complete` records what it is given and answers from a script (an
// outcome, an error, or a promise the test settles); its `account` answers from a map.

const STEAM_LOGIN = 'https://steam.example/openid/login';
const STEAM_SUB = 'steam:76561197960287930';
const STATE_FORM = /^[A-Za-z0-9_-]{43}$/;

type SteamKind = 'steam' | 'password-and-steam';
const STEAM_KINDS: readonly SteamKind[] = ['steam', 'password-and-steam'];

/** The address the scripted Steam step answers for `returnTo`. */
function steamLoginFor(returnTo: string): string {
  return `${STEAM_LOGIN}?for=${encodeURIComponent(returnTo)}`;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value) {
      settle?.(value);
    },
  };
}

interface SteamCompletion {
  readonly reply: URLSearchParams;
  /** The reply's pairs at the call, in order. */
  readonly pairs: ReadonlyArray<readonly [string, string]>;
  readonly expected: { readonly returnTo: string; readonly state: string };
  /** `Date.now()` at the call. */
  readonly calledAt: number;
}

type SteamAnswer = SteamSignInOutcome | Error | Promise<SteamSignInOutcome>;

interface FakeSteam extends SteamStep {
  readonly loginUrls: string[];
  readonly completions: SteamCompletion[];
  readonly script: SteamAnswer[];
  readonly accounts: Map<string, Account>;
  /** Resolves once `complete` has been called `count` times in all. */
  completed(count: number): Promise<void>;
}

function fakeSteam(): FakeSteam {
  const loginUrls: string[] = [];
  const completions: SteamCompletion[] = [];
  const script: SteamAnswer[] = [];
  const accounts = new Map<string, Account>();
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  return {
    kind: 'steam',
    loginUrls,
    completions,
    script,
    accounts,
    loginUrl(returnTo) {
      loginUrls.push(returnTo);
      return steamLoginFor(returnTo);
    },
    complete(reply, expected) {
      completions.push({
        reply,
        pairs: [...reply.entries()],
        expected: { returnTo: expected.returnTo, state: expected.state },
        calledAt: Date.now(),
      });
      for (const waiter of waiters) {
        if (waiter.count <= completions.length) waiter.resolve();
      }
      const next: SteamAnswer = script.shift() ?? { kind: 'refused' };
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    account(sub) {
      return Promise.resolve(accounts.get(sub));
    },
    completed(count) {
      if (completions.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
      });
    },
  };
}

// How many reads of an Interaction record have finished: a request has found its sign-in once its
// read is done.
interface Finds {
  interactions: number;
  readonly waiters: Array<{ readonly count: number; readonly resolve: () => void }>;
}

function counting(base: (model: string) => Adapter, finds: Finds): (model: string) => Adapter {
  return (model) => {
    const inner = base(model);
    if (model !== 'Interaction') return inner;
    return {
      upsert: (id, payload, expiresIn) => inner.upsert(id, payload, expiresIn),
      async find(id) {
        const found = await inner.find(id);
        finds.interactions += 1;
        for (const waiter of finds.waiters) {
          if (waiter.count <= finds.interactions) waiter.resolve();
        }
        return found;
      },
      findByUid: (uid) => inner.findByUid(uid),
      findByUserCode: (userCode) => inner.findByUserCode(userCode),
      consume: (id) => inner.consume(id),
      destroy: (id) => inner.destroy(id),
      revokeByGrantId: (grantId) => inner.revokeByGrantId(grantId),
    };
  };
}

function untilFinds(finds: Finds, count: number): Promise<void> {
  if (finds.interactions >= count) return Promise.resolve();
  return new Promise<void>((resolve) => {
    finds.waiters.push({ count, resolve });
  });
}

/** Lets the event loop go round `count` times: work already queued runs, nothing is timed. */
async function turns(count = 10): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

interface SteamWorld extends World {
  readonly kind: SteamKind;
  readonly steam: FakeSteam;
  readonly store: AccountStore;
  readonly finds: Finds;
}

async function listenOn(
  handler: ReturnType<typeof createAccountProvider>['handler'],
): Promise<number> {
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
  return (server.address() as AddressInfo).port;
}

/**
 * A provider whose sign-in step is the scripted Steam step (`steam`), or that step beside the
 * password stub (`password-and-steam`, whose `account` gives a `steam:` subject to the Steam step
 * and every other to the password stub). `step` is the password stub either way: with a Steam-only
 * step it is wired to nothing, so its attempts stay empty.
 */
async function steamWorld(kind: SteamKind): Promise<SteamWorld> {
  const store = await freshStore();
  const writes: Writes = { count: 0, upserts: [] };
  const finds: Finds = { interactions: 0, waiters: [] };
  const password = stubStep();
  const steam = fakeSteam();
  const both: PasswordAndSteamStep = {
    kind: 'password-and-steam',
    password,
    steam,
    account: (sub) => (sub.startsWith('steam:') ? steam.account(sub) : password.account(sub)),
  };
  const { handler } = createAccountProvider({
    issuer: ISSUER,
    keys: { keys: [generateSigningKey()] },
    adapter: watched(counting(store.adapter, finds), writes),
    signIn: kind === 'steam' ? steam : both,
  });
  return { port: await listenOn(handler), step: password, writes, kind, steam, store, finds };
}

interface SteamStarted extends Started {
  readonly verifier: string;
}

/** As `begin`, keeping the PKCE verifier for the code exchange. */
async function beginSteam(w: World, jar: Jar): Promise<SteamStarted> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(9).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const reply = await call(w, jar, 'GET', `/auth?${query}`);
  expect(reply.status, reply.body).toBe(303);
  const target = new URL(String(reply.headers.location), ISSUER);
  expect(target.origin).toBe(ISSUER);
  const match = /^\/interaction\/([^/]+)$/.exec(target.pathname);
  expect(match, target.href).not.toBeNull();
  const uid = match![1]!;
  return {
    uid,
    path: `/interaction/${uid}`,
    state,
    setCookie: reply.headers['set-cookie'] ?? [],
    verifier,
  };
}

async function steamOpened(
  kind: SteamKind,
): Promise<{ w: SteamWorld; jar: Jar; started: SteamStarted }> {
  const w = await steamWorld(kind);
  const jar = newJar();
  const started = await beginSteam(w, jar);
  resetWrites(w);
  return { w, jar, started };
}

interface Look {
  readonly reply: Reply;
  /** The callback the Steam step was given at this look. */
  readonly callback: string;
  /** The `state` of that callback. */
  readonly steamState: string;
}

/** A GET of the step's page with the sign-in's cookies: the step is asked for one address. */
async function lookUp(w: SteamWorld, jar: Jar, started: Started): Promise<Look> {
  const before = w.steam.loginUrls.length;
  const reply = await call(w, jar, 'GET', started.path);
  expect(reply.status, reply.body).toBe(w.kind === 'steam' ? 303 : 200);
  expect(w.steam.loginUrls).toHaveLength(before + 1);
  const callback = w.steam.loginUrls.at(-1)!;
  return { reply, callback, steamState: new URL(callback).searchParams.get('state') ?? '' };
}

interface Looked {
  readonly w: SteamWorld;
  readonly jar: Jar;
  readonly started: SteamStarted;
  readonly callback: string;
  readonly steamState: string;
}

async function looked(kind: SteamKind): Promise<Looked> {
  const { w, jar, started } = await steamOpened(kind);
  const { callback, steamState } = await lookUp(w, jar, started);
  resetWrites(w);
  return { w, jar, started, callback, steamState };
}

/** The request target of a reply at the sign-in's Steam callback. */
function callbackOf(started: Started, query: string): string {
  return `${started.path}/steam?${query}`;
}

/** A reply's query: the state, and parameters the scripted step never reads. */
function steamReply(steamState: string, extra = ''): string {
  return `state=${steamState}&openid.mode=id_res&openid.sig=c2lnbmVk${extra}`;
}

function lastPayload(w: World, model: string): Record<string, unknown> {
  const stored = w.writes.upserts.filter((u) => u.model === model).at(-1);
  expect(stored, model).toBeDefined();
  return stored!.payload as unknown as Record<string, unknown>;
}

/** The resume of a sign-in that completed: the code it sends the client. */
async function resumedCode(w: World, jar: Jar, started: Started): Promise<string> {
  const resumed = await call(w, jar, 'GET', `/auth/${started.uid}`);
  expect(resumed.status, resumed.body).toBe(303);
  const back = new URL(String(resumed.headers.location));
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  expect(back.searchParams.get('state')).toBe(started.state);
  const code = back.searchParams.get('code');
  expect(code).toEqual(expect.any(String));
  return code!;
}

async function redeemed(
  w: World,
  started: SteamStarted,
  code: string,
): Promise<Record<string, unknown>> {
  const reply = await send(
    w.port,
    'POST',
    '/token',
    { host: HOST, 'content-type': FORM_TYPE },
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: started.verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  );
  expect(reply.status, reply.body).toBe(200);
  return JSON.parse(reply.body) as Record<string, unknown>;
}

function payloadOf(jwt: unknown): Record<string, unknown> {
  expect(jwt).toEqual(expect.any(String));
  const part = String(jwt).split('.')[1] ?? '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** An answer that sends nobody a code: no `location`, or one without a `code` parameter. */
function expectNoCode(reply: Reply): void {
  const location = reply.headers.location;
  if (location === undefined) return;
  expect(new URL(String(location), ISSUER).searchParams.has('code'), String(location)).toBe(false);
}

async function interactionRecord(w: SteamWorld, uid: string): Promise<unknown> {
  return w.store.adapter('Interaction').find(uid);
}

/** A sign-in the scripted step completes as `sub`, entitled, through one callback. */
async function signedInBySteam(
  kind: SteamKind,
  sub = STEAM_SUB,
): Promise<Looked & { readonly reply: Reply }> {
  const opened = await looked(kind);
  opened.w.steam.accounts.set(sub, { sub, entitled: true });
  opened.w.steam.script.push({ kind: 'signed-in', sub });
  const target = callbackOf(opened.started, steamReply(opened.steamState));
  const reply = await call(opened.w, opened.jar, 'GET', target);
  return { ...opened, reply };
}

/**
 * Loads each query at the callback, all in flight together: the first is loaded and its decision
 * held open (the step's next answer is a promise this settles with `outcome`); the others are sent
 * once the step has been asked, and the decision is let go only after each of them has found its
 * sign-in. Answers in the order of `queries`.
 */
async function inParallel(
  w: SteamWorld,
  jar: Jar,
  started: Started,
  queries: readonly string[],
  outcome: SteamSignInOutcome,
): Promise<Reply[]> {
  const decision = deferred<SteamSignInOutcome>();
  w.steam.script.unshift(decision.promise);
  const [head = '', ...others] = queries;
  const asked = w.steam.completions.length;
  const first = call(w, jar, 'GET', callbackOf(started, head));
  await w.steam.completed(asked + 1);
  const found = w.finds.interactions;
  const rest = others.map((query) => call(w, jar, 'GET', callbackOf(started, query)));
  await Promise.race([untilFinds(w.finds, found + rest.length), Promise.all(rest)]);
  await turns();
  decision.resolve(outcome);
  return Promise.all([first, ...rest]);
}

describe('GET /interaction/<uid> with a Steam-only step', () => {
  test('is a 303 with no-store to the address the step makes from our callback, and asks nothing else acs-10.1', async () => {
    const { w, jar, started } = await steamOpened('steam');
    const { reply, callback } = await lookUp(w, jar, started);
    expect(reply.headers.location).toBe(steamLoginFor(callback));
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(w.steam.completions).toEqual([]);
    expect(w.step.attempts).toEqual([]);
    expect(w.writes.count).toBe(0);
  });

  test('a POST is 405 with Allow: GET, and neither step is asked', async () => {
    const { w, jar, started } = await steamOpened('steam');
    const reply = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: VALID_BODY,
    });
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe('GET');
    expectRouterHeaders(reply);
    expect(w.steam.loginUrls).toEqual([]);
    expect(w.steam.completions).toEqual([]);
    expect(w.step.attempts).toEqual([]);
    expect(w.writes.count).toBe(0);
  });
});

describe('GET /interaction/<uid> with the password step and the Steam step beside it', () => {
  test('is 200 with exactly the form carrying the address the Steam step makes from our callback, with every page header acs-10.5', async () => {
    const { w, jar, started } = await steamOpened('password-and-steam');
    const { reply, callback } = await lookUp(w, jar, started);
    expectPage(reply, signInPage({ action: started.path, steam: steamLoginFor(callback) }));
    expect(w.steam.completions).toEqual([]);
    expect(w.step.attempts).toEqual([]);
  });

  test('offers more than the password form alone acs-10.5', async () => {
    const { w, jar, started } = await steamOpened('password-and-steam');
    const { reply } = await lookUp(w, jar, started);
    expect(reply.body).not.toBe(signInPage({ action: started.path }));
  });

  test('a POST is decided by the password step, the Steam step is not asked, and its sign-in resumes to a code for the password subject acs-10.5', async () => {
    const { w, jar, started } = await steamOpened('password-and-steam');
    w.step.accounts.set('dev:one', { sub: 'dev:one', entitled: true });
    w.step.script.push({ kind: 'signed-in', sub: 'dev:one' });
    const reply = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials('one@example.com', 'right horse'),
    });
    expect(reply.status, reply.body).toBe(303);
    expect(reply.headers.location).toBe(`${ISSUER}/auth/${started.uid}`);
    expect(w.step.attempts).toEqual([['one@example.com', 'right horse']]);
    expect(w.steam.completions).toEqual([]);
    expect(w.steam.loginUrls).toEqual([]);
    expect(lastPayload(w, 'Grant').accountId).toBe('dev:one');
    const tokens = await redeemed(w, started, await resumedCode(w, jar, started));
    expect(payloadOf(tokens.id_token).sub).toBe('dev:one');
  });

  test('a POST the password step refuses is 400 with no grant, and the Steam step is not asked acs-10.5', async () => {
    const { w, jar, started } = await steamOpened('password-and-steam');
    w.step.script.push({ kind: 'refused' });
    const reply = await call(w, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: VALID_BODY,
    });
    expect(reply.status).toBe(400);
    expect(w.step.attempts).toEqual([['one@example.com', 'pw']]);
    expect(w.steam.completions).toEqual([]);
    expect(grantIds(w)).toEqual([]);
  });
});

describe('the step page of a Steam step without a live sign-in', () => {
  test.each(
    STEAM_KINDS,
  )('with no cookies a %s step page is the ended page, and the step is not asked', async (kind) => {
    const { w, jar, started } = await steamOpened(kind);
    const reply = await call(w, jar, 'GET', started.path, { cookie: null });
    expect(reply.status).toBe(400);
    expectPage(reply, endedPage());
    expect(w.steam.loginUrls).toEqual([]);
    expect(w.writes.count).toBe(0);
  });
});

describe('the Steam callback of a password step alone', () => {
  test('the step page is exactly the password form alone acs-10.5', async () => {
    const { w, jar, started } = await opened();
    const reply = await call(w, jar, 'GET', started.path);
    expect(reply.status).toBe(200);
    expectPage(reply, signInPage({ action: started.path }));
  });

  test.each([
    'GET',
    'POST',
  ])('a %s of the callback of a live sign-in is 404 in plain text, asks nothing and writes nothing acs-10.5', async (method) => {
    const { w, jar, started } = await opened();
    const target = `${started.path}/steam?state=x&openid.mode=id_res`;
    const reply = await call(
      w,
      jar,
      method,
      target,
      method === 'POST' ? { headers: GOOD_POST, body: VALID_BODY } : {},
    );
    expectText(reply, 404);
    expect(w.step.attempts).toEqual([]);
    expect(w.writes.count).toBe(0);
  });
});

const CALLBACK_METHODS = STEAM_KINDS.flatMap((kind) =>
  ['POST', 'PUT', 'DELETE'].map((method) => [kind, method] as const),
);

const NOT_LIVE: ReadonlyArray<readonly [string, (jar: Jar, target: string) => string | null]> = [
  ['no cookies', () => null],
  [
    'an _interaction cookie whose value was changed',
    (jar, target) => rewritten(jar, target, '_interaction', (value) => `${value}x`),
  ],
  [
    'an _interaction cookie whose signature was changed',
    (jar, target) => rewritten(jar, target, '_interaction.sig', otherLastChar),
  ],
];

const NOT_LIVE_CASES = STEAM_KINDS.flatMap((kind) =>
  NOT_LIVE.map(([name, cookie]) => [kind, name, cookie] as const),
);

describe('/interaction/<uid>/steam refuses before it asks the step', () => {
  test.each(
    CALLBACK_METHODS,
  )('a %s step answers a %s of the callback with 405 and Allow: GET, and asks nothing', async (kind, method) => {
    const { w, jar, started, steamState } = await looked(kind);
    const reply = await call(w, jar, method, callbackOf(started, steamReply(steamState)), {
      headers: GOOD_POST,
      body: VALID_BODY,
    });
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe('GET');
    expectRouterHeaders(reply);
    expect(w.steam.completions).toEqual([]);
    expect(w.step.attempts).toEqual([]);
    expect(w.writes.count).toBe(0);
  });

  test.each(
    NOT_LIVE_CASES,
  )('a %s step answers a callback with %s with the ended page, asks nothing and writes nothing', async (kind, _name, cookie) => {
    const { w, jar, started, steamState } = await looked(kind);
    const target = callbackOf(started, steamReply(steamState));
    const reply = await call(w, jar, 'GET', target, { cookie: cookie(jar, target) });
    expect(reply.status).toBe(400);
    expectPage(reply, endedPage());
    expect(w.steam.completions).toEqual([]);
    expect(w.writes.count).toBe(0);
  });

  test.each(
    STEAM_KINDS,
  )("a %s step answers a callback carrying another sign-in's cookies with the ended page, and asks nothing", async (kind) => {
    const { w, jar, started, steamState } = await looked(kind);
    const otherJar = newJar();
    const other = await beginSteam(w, otherJar);
    resetWrites(w);
    const target = callbackOf(started, steamReply(steamState));
    const reply = await call(w, jar, 'GET', target, { cookie: cookiesFor(otherJar, other.path) });
    expect(reply.status).toBe(400);
    expectPage(reply, endedPage());
    expect(w.steam.completions).toEqual([]);
    expect(w.writes.count).toBe(0);
  });

  test.each(
    STEAM_KINDS,
  )('a %s step answers a callback after the sign-in expired with the ended page, and asks nothing', async (kind) => {
    freezeAt(T0);
    const { w, jar, started, steamState } = await looked(kind);
    vi.setSystemTime(T0 + SIGN_IN_TTL_SECONDS * 1000);
    const reply = await call(w, jar, 'GET', callbackOf(started, steamReply(steamState)));
    expect(reply.status).toBe(400);
    expectPage(reply, endedPage());
    expect(w.steam.completions).toEqual([]);
    expect(w.writes.count).toBe(0);
  });
});

describe('the interaction state and what complete is given', () => {
  test.each(
    STEAM_KINDS,
  )('a %s step is given exactly <issuer>/interaction/<uid>/steam?state= and 43 base64url characters acs-10.2', async (kind) => {
    const { w, jar, started } = await steamOpened(kind);
    const { callback, steamState } = await lookUp(w, jar, started);
    expect(steamState).toMatch(STATE_FORM);
    expect(callback).toBe(`${ISSUER}/interaction/${started.uid}/steam?state=${steamState}`);
  });

  test('the state is neither the uid nor an unkeyed encoding or digest of it acs-10.2', async () => {
    const { started, steamState } = await looked('steam');
    expect(steamState).not.toBe(started.uid);
    expect(steamState).not.toContain(started.uid);
    expect(steamState).not.toBe(Buffer.from(started.uid).toString('base64url'));
    expect(steamState).not.toBe(createHash('sha256').update(started.uid).digest('base64url'));
  });

  test.each(
    STEAM_KINDS,
  )('two looks at one sign-in with a %s step give one callback acs-10.2', async (kind) => {
    const { w, jar, started } = await steamOpened(kind);
    const one = await lookUp(w, jar, started);
    const two = await lookUp(w, jar, started);
    expect(two.callback).toBe(one.callback);
  });

  test('two sign-ins get two states acs-10.2', async () => {
    const { w, jar, started } = await steamOpened('steam');
    const otherJar = newJar();
    const other = await beginSteam(w, otherJar);
    const one = await lookUp(w, jar, started);
    const two = await lookUp(w, otherJar, other);
    expect(two.steamState).toMatch(STATE_FORM);
    expect(two.steamState).not.toBe(one.steamState);
  });

  test('complete is called once with the request query as sent: every pair in order, duplicates and encodings kept acs-10.2', async () => {
    const { w, jar, started, steamState } = await looked('steam');
    const query =
      `state=${steamState}&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0` +
      '&openid.claimed_id=a&openid.claimed_id=b&openid.sig=x%2By%3D&openid.empty=&plain+space=1%202';
    await call(w, jar, 'GET', callbackOf(started, query));
    expect(w.steam.completions).toHaveLength(1);
    const [completion] = w.steam.completions;
    expect(completion!.reply).toBeInstanceOf(URLSearchParams);
    expect(completion!.pairs).toEqual([...new URLSearchParams(query).entries()]);
    expect(completion!.reply.getAll('openid.claimed_id')).toEqual(['a', 'b']);
  });

  test.each(
    STEAM_KINDS,
  )('complete with a %s step expects exactly our callback and its state acs-10.2', async (kind) => {
    const { w, jar, started, callback, steamState } = await looked(kind);
    await call(w, jar, 'GET', callbackOf(started, steamReply(steamState)));
    expect(w.steam.completions).toHaveLength(1);
    const { expected } = w.steam.completions[0]!;
    expect(expected).toEqual({ returnTo: callback, state: steamState });
    expect(expected.returnTo).toBe(
      `${ISSUER}/interaction/${started.uid}/steam?state=${expected.state}`,
    );
  });

  test("a reply naming another sign-in's state is asked with this sign-in's own callback and state acs-10.2", async () => {
    const { w, jar, started, callback, steamState } = await looked('steam');
    const otherJar = newJar();
    const other = await lookUp(w, otherJar, await beginSteam(w, otherJar));
    expect(other.steamState).not.toBe(steamState);
    await call(w, jar, 'GET', callbackOf(started, steamReply(other.steamState)));
    expect(w.steam.completions).toHaveLength(1);
    expect(w.steam.completions[0]!.expected).toEqual({ returnTo: callback, state: steamState });
    expect(w.steam.completions[0]!.reply.get('state')).toBe(other.steamState);
  });

  test("a reply with no state is asked with this sign-in's own callback and state acs-10.2", async () => {
    const { w, jar, started, callback, steamState } = await looked('steam');
    await call(w, jar, 'GET', callbackOf(started, 'openid.mode=id_res'));
    expect(w.steam.completions).toHaveLength(1);
    expect(w.steam.completions[0]!.expected).toEqual({ returnTo: callback, state: steamState });
  });

  test('a callback before any look at the step page expects the callback a later look is given acs-10.2', async () => {
    const { w, jar, started } = await steamOpened('steam');
    w.steam.script.push({ kind: 'not-owned' });
    await call(w, jar, 'GET', callbackOf(started, 'openid.mode=id_res'));
    expect(w.steam.completions).toHaveLength(1);
    const { expected } = w.steam.completions[0]!;
    expect(expected.state).toMatch(STATE_FORM);
    const { callback } = await lookUp(w, jar, started);
    expect(callback).toBe(expected.returnTo);
  });
});

describe.each(STEAM_KINDS)('a callback a %s step answers signed-in', (kind) => {
  test('is a 303 with no-store to <issuer>/auth/<uid> acs-10.1', async () => {
    const { reply, started, w } = await signedInBySteam(kind);
    expect(reply.status, reply.body).toBe(303);
    expectRouterHeaders(reply);
    expect(reply.headers.location).toBe(`${ISSUER}/auth/${started.uid}`);
    expect(w.steam.completions).toHaveLength(1);
  });

  test("stores one grant for the step's subject and the client, with scope openid acs-10.1", async () => {
    const { w } = await signedInBySteam(kind);
    expect(grantIds(w)).toHaveLength(1);
    const grant = lastPayload(w, 'Grant');
    expect(grant.accountId).toBe(STEAM_SUB);
    expect(grant.clientId).toBe(CLIENT_ID);
    const openid = grant.openid as { scope?: unknown } | undefined;
    expect(String(openid?.scope).split(' ')).toContain('openid');
  });

  test("the resume gives the client a code that exchanges for an ID token whose sub is the step's subject, with a refresh token acs-10.1", async () => {
    const { w, jar, started } = await signedInBySteam(kind, 'steam:76561197960287931');
    const tokens = await redeemed(w, started, await resumedCode(w, jar, started));
    expect(payloadOf(tokens.id_token).sub).toBe('steam:76561197960287931');
    expect(payloadOf(tokens.id_token).aud).toBe(CLIENT_ID);
    expect(tokens.refresh_token).toEqual(expect.any(String));
    expect(lastPayload(w, 'AuthorizationCode').accountId).toBe('steam:76561197960287931');
  });

  test('a reload of the callback is the same 303, without asking the step or storing a second grant acs-10.1', async () => {
    const { w, jar, started, steamState, reply } = await signedInBySteam(kind);
    w.steam.script.push({ kind: 'refused' });
    const again = await call(w, jar, 'GET', callbackOf(started, steamReply(steamState)));
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe(reply.headers.location);
    expectRouterHeaders(again);
    expect(w.steam.completions).toHaveLength(1);
    expect(grantIds(w)).toHaveLength(1);
  });

  test('a later, different reply that the step would refuse does not end the sign-in: the resume still gives a code acs-10.1', async () => {
    const { w, jar, started, steamState } = await signedInBySteam(kind);
    w.steam.script.push({ kind: 'refused' });
    const later = await call(
      w,
      jar,
      'GET',
      callbackOf(started, steamReply(steamState, '&openid.response_nonce=other')),
    );
    expect(later.status).toBe(303);
    expect(w.steam.completions).toHaveLength(1);
    const tokens = await redeemed(w, started, await resumedCode(w, jar, started));
    expect(payloadOf(tokens.id_token).sub).toBe(STEAM_SUB);
  });
});

describe('the time of a Steam sign-in', () => {
  test('the code and the refresh token carry as authTime the second the decision began, not the second complete answered or the resume ran', async () => {
    freezeAt(T0);
    const { w, jar, started, steamState } = await looked('steam');
    w.steam.accounts.set(STEAM_SUB, { sub: STEAM_SUB, entitled: true });
    const decision = deferred<SteamSignInOutcome>();
    w.steam.script.push(decision.promise);
    const pending = call(w, jar, 'GET', callbackOf(started, steamReply(steamState)));
    await w.steam.completed(1);
    expect(w.steam.completions[0]!.calledAt).toBe(T0);
    vi.setSystemTime(T0 + 7_000);
    decision.resolve({ kind: 'signed-in', sub: STEAM_SUB });
    expect((await pending).status).toBe(303);
    vi.setSystemTime(T0 + 20_000);
    const code = await resumedCode(w, jar, started);
    expect(lastPayload(w, 'AuthorizationCode').authTime).toBe(1_800_000_000);
    const tokens = await redeemed(w, started, code);
    expect(tokens.refresh_token).toEqual(expect.any(String));
    expect(lastPayload(w, 'RefreshToken').authTime).toBe(1_800_000_000);
  });
});

interface Ending {
  readonly label: string;
  readonly outcome: SteamSignInOutcome;
  readonly status: number;
  readonly pageName: string;
  readonly page: () => string;
  readonly tag: string;
}

const ENDINGS: readonly Ending[] = [
  {
    label: 'refused',
    outcome: { kind: 'refused' },
    status: 400,
    pageName: 'the ended page',
    page: () => endedPage(),
    tag: ' acs-10.2',
  },
  {
    label: 'unavailable',
    outcome: { kind: 'unavailable' },
    status: 503,
    pageName: 'the unavailable page',
    page: () => unavailablePage(),
    tag: '',
  },
];

for (const ending of ENDINGS) {
  for (const kind of STEAM_KINDS) {
    describe(`a callback the ${kind} step answers ${ending.label} ends the sign-in`, () => {
      async function end(): Promise<Looked & { readonly reply: Reply }> {
        const opened = await looked(kind);
        expect(await interactionRecord(opened.w, opened.started.uid)).toBeDefined();
        opened.w.steam.accounts.set(STEAM_SUB, { sub: STEAM_SUB, entitled: true });
        opened.w.steam.script.push(ending.outcome);
        const target = callbackOf(opened.started, steamReply(opened.steamState));
        const reply = await call(opened.w, opened.jar, 'GET', target);
        return { ...opened, reply };
      }

      test(`the answer is ${ending.status}, exactly ${ending.pageName}, with every page header${ending.tag}`, async () => {
        const { w, reply } = await end();
        expect(reply.status).toBe(ending.status);
        expectPage(reply, ending.page());
        expect(w.steam.completions).toHaveLength(1);
      });

      test(`no grant and no code are stored${ending.tag}`, async () => {
        const { w } = await end();
        expect(grantIds(w)).toEqual([]);
        expect(w.writes.upserts.filter((u) => u.model === 'AuthorizationCode')).toEqual([]);
      });

      test(`the record of the sign-in is gone${ending.tag}`, async () => {
        const { w, started } = await end();
        expect(await interactionRecord(w, started.uid)).toBeUndefined();
      });

      test(`a later GET of the step page is the ended page, and the step is not asked${ending.tag}`, async () => {
        const { w, jar, started } = await end();
        const looks = w.steam.loginUrls.length;
        const again = await call(w, jar, 'GET', started.path);
        expect(again.status).toBe(400);
        expectPage(again, endedPage());
        expect(w.steam.loginUrls).toHaveLength(looks);
      });

      test(`a later callback, even one the step would sign in, is the ended page, and the step is not asked${ending.tag}`, async () => {
        const { w, jar, started, steamState } = await end();
        w.steam.script.push({ kind: 'signed-in', sub: STEAM_SUB });
        const target = callbackOf(started, steamReply(steamState, '&openid.response_nonce=later'));
        const again = await call(w, jar, 'GET', target);
        expect(again.status).toBe(400);
        expectPage(again, endedPage());
        expect(w.steam.completions).toHaveLength(1);
        expect(grantIds(w)).toEqual([]);
      });

      test(`the resume gives no code${ending.tag}`, async () => {
        const { w, jar, started } = await end();
        const resumed = await call(w, jar, 'GET', `/auth/${started.uid}`);
        expectNoCode(resumed);
        expect(w.writes.upserts.filter((u) => u.model === 'AuthorizationCode')).toEqual([]);
        expect(grantIds(w)).toEqual([]);
      });
    });
  }
}

describe.each(STEAM_KINDS)('a callback a %s step answers not-owned', (kind) => {
  async function refusedOwnership(): Promise<Looked & { readonly reply: Reply }> {
    const opened = await looked(kind);
    opened.w.steam.script.push({ kind: 'not-owned' });
    const target = callbackOf(opened.started, steamReply(opened.steamState));
    const reply = await call(opened.w, opened.jar, 'GET', target);
    return { ...opened, reply };
  }

  test('is a 403 with exactly the not-owned page, and no grant acs-10.3', async () => {
    const { w, reply } = await refusedOwnership();
    expect(reply.status).toBe(403);
    expectPage(reply, notOwnedPage());
    expect(grantIds(w)).toEqual([]);
    expect(w.writes.upserts.filter((u) => u.model === 'AuthorizationCode')).toEqual([]);
  });

  test("leaves the sign-in open: its record stays, and the step's page is served again acs-10.3", async () => {
    const { w, jar, started, callback } = await refusedOwnership();
    expect(await interactionRecord(w, started.uid)).toBeDefined();
    const again = await lookUp(w, jar, started);
    expect(again.callback).toBe(callback);
  });

  test('a later reply on the same sign-in is decided afresh, and can sign in acs-10.3', async () => {
    const { w, jar, started, steamState } = await refusedOwnership();
    w.steam.accounts.set(STEAM_SUB, { sub: STEAM_SUB, entitled: true });
    w.steam.script.push({ kind: 'signed-in', sub: STEAM_SUB });
    const target = callbackOf(started, steamReply(steamState, '&openid.response_nonce=later'));
    const later = await call(w, jar, 'GET', target);
    expect(later.status, later.body).toBe(303);
    expect(later.headers.location).toBe(`${ISSUER}/auth/${started.uid}`);
    expect(w.steam.completions).toHaveLength(2);
    expect(grantIds(w)).toHaveLength(1);
  });

  test('the resume gives no code acs-10.3', async () => {
    const { w, jar, started } = await refusedOwnership();
    const resumed = await call(w, jar, 'GET', `/auth/${started.uid}`);
    expectNoCode(resumed);
    expect(grantIds(w)).toEqual([]);
  });
});

describe.each(STEAM_KINDS)('a callback whose complete rejects, with a %s step', (kind) => {
  test('is a 500 in plain text with nothing of the error, and no grant', async () => {
    const { w, jar, started, steamState } = await looked(kind);
    w.steam.script.push(new Error('INTERNAL_DETAIL_openid_exploded'));
    const reply = await call(w, jar, 'GET', callbackOf(started, steamReply(steamState)));
    expectText(reply, 500);
    expect(reply.body).not.toContain('INTERNAL_DETAIL');
    expect(reply.body).not.toContain('openid_exploded');
    expect(grantIds(w)).toEqual([]);
  });
});

describe('one decision per sign-in at a time', () => {
  test('four parallel loads of one reply ask the step once, and all four get the same 303 to the resume acs-10.1', async () => {
    const { w, jar, started, steamState } = await looked('steam');
    w.steam.accounts.set(STEAM_SUB, { sub: STEAM_SUB, entitled: true });
    w.steam.script.push({ kind: 'refused' }, { kind: 'refused' }, { kind: 'refused' });
    const query = steamReply(steamState);
    const replies = await inParallel(w, jar, started, [query, query, query, query], {
      kind: 'signed-in',
      sub: STEAM_SUB,
    });
    expect(w.steam.completions).toHaveLength(1);
    for (const reply of replies) {
      expect(reply.status, reply.body).toBe(303);
      expect(reply.headers.location).toBe(`${ISSUER}/auth/${started.uid}`);
      expect(reply.body).toBe(replies[0]!.body);
    }
    expect(grantIds(w)).toHaveLength(1);
  });

  test('replies that arrive while a decision is in flight, which the step would refuse, cannot end the sign-in it completes: the resume gives a code acs-10.1', async () => {
    const { w, jar, started, steamState } = await looked('steam');
    w.steam.accounts.set(STEAM_SUB, { sub: STEAM_SUB, entitled: true });
    w.steam.script.push({ kind: 'refused' }, { kind: 'refused' }, { kind: 'refused' });
    const queries = [1, 2, 3, 4].map((n) =>
      steamReply(steamState, `&openid.response_nonce=reply-${n}`),
    );
    const replies = await inParallel(w, jar, started, queries, {
      kind: 'signed-in',
      sub: STEAM_SUB,
    });
    expect(w.steam.completions).toHaveLength(1);
    expect(w.steam.completions[0]!.pairs).toEqual([...new URLSearchParams(queries[0]).entries()]);
    expect(replies.map((reply) => reply.status)).toEqual([303, 303, 303, 303]);
    const tokens = await redeemed(w, started, await resumedCode(w, jar, started));
    expect(payloadOf(tokens.id_token).sub).toBe(STEAM_SUB);
  });

  test('four parallel loads of a reply the step refuses ask it once, and all four get the ended page acs-10.2', async () => {
    const { w, jar, started, steamState } = await looked('steam');
    w.steam.accounts.set(STEAM_SUB, { sub: STEAM_SUB, entitled: true });
    w.steam.script.push(
      { kind: 'signed-in', sub: STEAM_SUB },
      { kind: 'signed-in', sub: STEAM_SUB },
      { kind: 'signed-in', sub: STEAM_SUB },
    );
    const query = steamReply(steamState);
    const replies = await inParallel(w, jar, started, [query, query, query, query], {
      kind: 'refused',
    });
    expect(w.steam.completions).toHaveLength(1);
    for (const reply of replies) {
      expect(reply.status).toBe(400);
      expectPage(reply, endedPage());
    }
    expect(grantIds(w)).toEqual([]);
  });

  test('a load with no cookies while a decision is in flight is the ended page at once, and joins nothing acs-10.2', async () => {
    const { w, jar, started, steamState } = await looked('steam');
    w.steam.accounts.set(STEAM_SUB, { sub: STEAM_SUB, entitled: true });
    const decision = deferred<SteamSignInOutcome>();
    w.steam.script.push(decision.promise);
    const target = callbackOf(started, steamReply(steamState));
    const first = call(w, jar, 'GET', target);
    await w.steam.completed(1);
    const stranger = await call(w, newJar(), 'GET', target, { cookie: null });
    expect(stranger.status).toBe(400);
    expectPage(stranger, endedPage());
    decision.resolve({ kind: 'signed-in', sub: STEAM_SUB });
    expect((await first).status).toBe(303);
    expect(w.steam.completions).toHaveLength(1);
  });
});
