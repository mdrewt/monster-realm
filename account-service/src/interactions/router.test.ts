import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { generateSigningKey } from '../keys.ts';
import { createAccountProvider, registerClient, SIGN_IN_TTL_SECONDS } from '../provider.ts';
import { type AccountStore, openAccountStore } from '../store/sqliteAdapter.ts';
import { endedPage, notOwnedPage, PAGE_HEADERS, signInPage } from './pages.ts';
import type { Account, PasswordStep, SignInOutcome } from './router.ts';

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
// covers, and a cookie set again under the same name and path replaces the old one.
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
