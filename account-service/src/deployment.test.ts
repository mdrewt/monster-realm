import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type IncomingHttpHeaders, request } from 'node:http';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { notOwnedPage } from './interactions/pages.ts';

// The deployment recipe in ops/auth, driven through the real docker CLI (Engine + Compose v2).

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const OPS_AUTH = resolve(REPO_ROOT, 'ops', 'auth');
const ISSUER = 'http://localhost:4455';
const HOST = 'localhost:4455';
const CLIENT_ID = 'monster-realm';
const REDIRECT_URI = 'http://localhost:5290/';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const SERVICE = 'account-local-dev';
const DB_PATH = '/var/lib/account-service/db/account.sqlite';
const KEYS_DIR = '/var/lib/account-service/keys';
const ALL_PROFILES = ['local-dev', 'hosted-dev', 'production'];
const LOCAL = ['local-dev'];

interface Run {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly out: string;
  readonly err: string;
}

interface RunOptions {
  readonly env?: Record<string, string | undefined>;
  readonly input?: Buffer | string;
}

function compose(
  project: string,
  profiles: readonly string[],
  args: readonly string[],
  options: RunOptions = {},
): Run {
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) cleaned[name] = value;
  }
  const full = ['compose', '-p', project, ...profiles.flatMap((p) => ['--profile', p]), ...args];
  const result = spawnSync('docker', full, {
    cwd: OPS_AUTH,
    env: cleaned,
    input: options.input,
    maxBuffer: 512 * 1024 * 1024,
    timeout: 280_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    out: result.stdout.toString('utf8'),
    err: result.stderr.toString('utf8'),
  };
}

function expectOk(run: Run, label: string): Run {
  expect(run.status, `${label}: ${run.err}`).toBe(0);
  return run;
}

const projects: string[] = [];

function newProject(): string {
  const name = `mr-auth-test-${randomBytes(4).toString('hex')}`;
  projects.push(name);
  return name;
}

// An empty env file for every `config` call, so an operator's ops/auth/.env cannot change it.
const EMPTY_ENV_DIR = mkdtempSync(join(tmpdir(), 'mr-auth-env-'));
const EMPTY_ENV_FILE = join(EMPTY_ENV_DIR, 'empty.env');
writeFileSync(EMPTY_ENV_FILE, '');

interface ServiceModel {
  readonly ports?: Array<Record<string, unknown>>;
  readonly read_only?: boolean;
  readonly cap_drop?: string[];
  readonly security_opt?: string[];
  readonly privileged?: boolean;
  readonly user?: string;
  readonly volumes?: Array<{ readonly target?: string }>;
}

function configModel(
  profiles: readonly string[],
  env: Record<string, string | undefined> = {},
): Record<string, ServiceModel> {
  const run = expectOk(
    compose(newProject(), profiles, ['--env-file', EMPTY_ENV_FILE, 'config', '--format', 'json'], {
      env: { MR_AUTH_LOCAL_PORT: undefined, ...env },
    }),
    'config',
  );
  return (JSON.parse(run.out) as { services: Record<string, ServiceModel> }).services;
}

afterAll(() => {
  rmSync(EMPTY_ENV_DIR, { recursive: true, force: true });
  for (const project of projects.splice(0)) {
    try {
      compose(project, ALL_PROFILES, ['down', '-v', '--remove-orphans', '--rmi', 'local']);
    } catch (error) {
      process.stderr.write(`cleanup of ${project} failed: ${String(error)}\n`);
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

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
  return new Promise((resolveReply, reject) => {
    const all = { host: HOST, ...headers };
    const withLength =
      body === undefined ? all : { ...all, 'content-length': String(Buffer.byteLength(body)) };
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: withLength, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolveReply({
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

interface Cookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
}

interface Jar {
  cookies: Cookie[];
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

async function call(
  port: number,
  jar: Jar,
  method: string,
  target: string,
  options: { readonly body?: string; readonly headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { host: HOST, ...options.headers };
  const cookie = cookiesFor(jar, target);
  if (cookie !== '') headers.cookie = cookie;
  const reply = await send(port, method, target, headers, options.body);
  absorb(jar, reply);
  return reply;
}

const GOOD_POST: Record<string, string> = { origin: ISSUER, 'content-type': FORM_TYPE };

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function authQuery(): { verifier: string; state: string; query: string } {
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
  }).toString();
  return { verifier, state, query };
}

function interactionUid(location: string | undefined): string {
  const target = new URL(String(location), ISSUER);
  expect(target.origin).toBe(ISSUER);
  const match = /^\/interaction\/([^/]+)$/.exec(target.pathname);
  expect(match, target.href).not.toBeNull();
  expect(target.searchParams.has('code')).toBe(false);
  return String(match?.[1]);
}

interface Started {
  readonly uid: string;
  readonly path: string;
  readonly state: string;
  readonly verifier: string;
}

async function begin(port: number, jar: Jar): Promise<Started> {
  const { verifier, state, query } = authQuery();
  const reply = await call(port, jar, 'GET', `/auth?${query}`);
  expect(reply.status, reply.body).toBe(303);
  const uid = interactionUid(reply.headers.location);
  return { uid, path: `/interaction/${uid}`, state, verifier };
}

function credentials(email: string, password: string): string {
  return new URLSearchParams({ email, password }).toString();
}

interface Signed {
  readonly code: string;
  readonly verifier: string;
}

async function signInToCode(port: number, email: string, password: string): Promise<Signed> {
  const jar: Jar = { cookies: [] };
  const started = await begin(port, jar);
  const form = await call(port, jar, 'GET', started.path);
  expect(form.status).toBe(200);
  const posted = await call(port, jar, 'POST', started.path, {
    headers: GOOD_POST,
    body: credentials(email, password),
  });
  expect(posted.status, posted.body).toBe(303);
  expect(posted.headers.location).toBe(`${ISSUER}/auth/${started.uid}`);
  const resumed = await call(port, jar, 'GET', `/auth/${started.uid}`);
  expect(resumed.status, resumed.body).toBe(303);
  const back = new URL(String(resumed.headers.location));
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  expect(back.searchParams.get('state')).toBe(started.state);
  expect(back.searchParams.get('iss')).toBe(ISSUER);
  const code = back.searchParams.get('code');
  expect(code).toEqual(expect.any(String));
  return { code: String(code), verifier: started.verifier };
}

interface TokenReply {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function token(port: number, fields: Record<string, string>): Promise<TokenReply> {
  const reply = await send(
    port,
    'POST',
    '/token',
    { host: HOST, 'content-type': FORM_TYPE },
    new URLSearchParams(fields).toString(),
  );
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(reply.body) as Record<string, unknown>;
  } catch {
    // not JSON: the assertions on `json` then fail with the status in view
  }
  return { status: reply.status, json };
}

function exchange(port: number, signed: Signed): Promise<TokenReply> {
  return token(port, {
    grant_type: 'authorization_code',
    code: signed.code,
    code_verifier: signed.verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
}

function refresh(port: number, refreshToken: string): Promise<TokenReply> {
  return token(port, {
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
  readonly refresh_token: string;
}

function tokensOf(reply: TokenReply): Tokens {
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  const { id_token, refresh_token } = reply.json;
  expect(id_token).toEqual(expect.any(String));
  expect(refresh_token).toEqual(expect.any(String));
  return { id_token: id_token as string, refresh_token: refresh_token as string };
}

async function signInToTokens(port: number, email: string, password: string): Promise<Tokens> {
  return tokensOf(await exchange(port, await signInToCode(port, email, password)));
}

interface Jwk {
  readonly kty: string;
  readonly crv: string;
  readonly kid: string;
  readonly x: string;
  readonly y: string;
}

async function keySet(port: number): Promise<{ readonly keys: readonly Jwk[] }> {
  const reply = await send(port, 'GET', '/jwks', { host: HOST });
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body) as { keys: Jwk[] };
}

async function discovery(port: number): Promise<Reply> {
  return send(port, 'GET', '/.well-known/openid-configuration', { host: HOST });
}

async function waitForDiscovery(port: number): Promise<Reply> {
  const deadline = Date.now() + 60_000;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const reply = await discovery(port);
      if (reply.status === 200) return reply;
      last = `status ${reply.status}`;
    } catch (error) {
      last = String(error);
    }
    await sleep(1000);
  }
  throw new Error(`discovery did not answer 200 within 60 s: ${last}`);
}

function publishedPort(project: string): number {
  const run = expectOk(compose(project, LOCAL, ['port', 'caddy-local-dev', '4455']), 'port');
  const address = run.out.trim().split('\n')[0] ?? '';
  const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
  expect(match, `published address ${address}`).not.toBeNull();
  return Number(match?.[1]);
}

async function bringUp(project: string, build: boolean): Promise<number> {
  const args = build ? ['up', '-d', '--build'] : ['up', '-d'];
  expectOk(compose(project, LOCAL, args, { env: { MR_AUTH_LOCAL_PORT: '0' } }), 'up');
  const port = publishedPort(project);
  await waitForDiscovery(port);
  return port;
}

function admin(project: string, args: readonly string[]): Run {
  return compose(project, LOCAL, ['exec', '-T', SERVICE, 'node', 'src/admin/cli.ts', ...args]);
}

function fields(run: Run): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of run.out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) found[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return found;
}

function createAccount(project: string, email: string, entitled: boolean): string {
  const args = entitled ? ['create-account', email] : ['create-account', email, '--not-entitled'];
  const made = fields(expectOk(admin(project, args), `create-account ${email}`));
  expect(made.password, 'the generated password line').toEqual(expect.any(String));
  expect(String(made.password).length).toBeGreaterThan(0);
  return String(made.password);
}

function setClient(project: string): void {
  expectOk(admin(project, ['set-client', CLIENT_ID, REDIRECT_URI]), 'set-client');
}

function exec(project: string, args: readonly string[]): Run {
  return compose(project, LOCAL, ['exec', '-T', SERVICE, ...args]);
}

// ---- the world ticket routes through the recipe ----

const WORLD_NAME = 'dns:play.example.com:3000/c200a1b2c3d4e5f6';
const WORLD_ID = createHash('sha256').update('acs14 deployment world').digest('hex');
// A documentation address (RFC 5737): never a container's, never the host's.
const FORGED_ADDRESS = '203.0.113.66';
const IPV4_CHECK_HOST = 'ipv4.localhost:4455';
const IPV6_CHECK_HOST = 'ipv6.localhost:4455';

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return send(
    port,
    'POST',
    path,
    { 'content-type': 'application/json', ...headers },
    JSON.stringify(body),
  );
}

function jsonBody(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>;
}

async function ticketThrough(
  port: number,
  idToken: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const reply = await postJson(
    port,
    '/ticket',
    { world: WORLD_NAME },
    { authorization: `Bearer ${idToken}`, ...headers },
  );
  expect(reply.status, reply.body).toBe(200);
  const ticket = jsonBody(reply).ticket;
  expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return String(ticket);
}

function redeemThrough(
  port: number,
  ticket: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return postJson(port, '/world/check', { ticket, names: [WORLD_NAME], world: WORLD_ID }, headers);
}

/** The handle a stack answers for the token's account, or undefined when it answers none. */
async function handleIfAnswered(port: number, idToken: string): Promise<string | undefined> {
  try {
    const issued = await postJson(
      port,
      '/ticket',
      { world: WORLD_NAME },
      { authorization: `Bearer ${idToken}` },
    );
    if (issued.status !== 200) return undefined;
    const ticket = jsonBody(issued).ticket;
    if (typeof ticket !== 'string') return undefined;
    const redeemed = await redeemThrough(port, ticket);
    if (redeemed.status !== 200) return undefined;
    const handle = jsonBody(redeemed).handle;
    return typeof handle === 'string' ? handle : undefined;
  } catch {
    return undefined;
  }
}

/** Every address docker gives a compose service's container, on every network it joins. */
function containerAddresses(project: string, service: string): string[] {
  const id = expectOk(compose(project, LOCAL, ['ps', '-q', service]), `ps ${service}`).out.trim();
  expect(id).not.toBe('');
  const inspected = spawnSync(
    'docker',
    [
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}} {{end}}',
      id,
    ],
    { encoding: 'utf8' },
  );
  expect(inspected.status, inspected.stderr).toBe(0);
  return inspected.stdout.split(/\s+/).filter((address) => address !== '');
}

// Run inside the account container: POSTs argv[2] to the service itself, on its own loopback
// port, with argv[1] as X-Forwarded-For, and prints the status and body as JSON.
const IN_CONTAINER_CHECK = [
  'const http = require("node:http");',
  'const body = process.argv[2];',
  'const req = http.request({ host: "127.0.0.1", port: 4455, path: "/world/check", method: "POST",',
  'headers: { host: "localhost:4455", "content-type": "application/json",',
  '"x-forwarded-for": process.argv[1], "content-length": Buffer.byteLength(body) } }, (res) => {',
  'let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });',
  'res.on("end", () => { process.stdout.write(JSON.stringify({ status: res.statusCode, body: text })); });',
  '});',
  'req.on("error", (error) => { process.stderr.write(String(error)); process.exitCode = 1; });',
  'req.end(body);',
].join(' ');

describe('the image runs locked down', () => {
  let project = '';
  let port = 0;

  beforeAll(async () => {
    project = newProject();
    port = await bringUp(project, true);
  });

  test('the process runs as a non-root user, and the image and container say so too acs-4.1', () => {
    const uid = expectOk(exec(project, ['id', '-u']), 'id -u').out.trim();
    expect(uid).toMatch(/^\d+$/);
    expect(uid).not.toBe('0');

    const id = expectOk(compose(project, LOCAL, ['ps', '-q', SERVICE]), 'ps').out.trim();
    expect(id).not.toBe('');
    const inspected = spawnSync(
      'docker',
      ['inspect', '--format', '{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}', id],
      { encoding: 'utf8' },
    );
    expect(inspected.status, inspected.stderr).toBe(0);
    const [user = '', readonlyRoot = ''] = inspected.stdout.trim().split('|');
    expect(user).not.toBe('');
    expect(user).not.toBe('0');
    expect(user).not.toBe('root');
    expect(readonlyRoot).toBe('true');
  });

  test('the root file system is read-only while the service serves discovery acs-4.1', async () => {
    const served = await discovery(port);
    expect(served.status).toBe(200);

    // The control: the scratch directory is writable, so a failure elsewhere is the file system.
    expectOk(exec(project, ['sh', '-c', 'touch /tmp/probe && rm /tmp/probe']), 'write in /tmp');
    const underApp = exec(project, ['sh', '-c', 'touch /app/probe']);
    expect(underApp.status, 'a write under /app').not.toBe(0);
    const underRoot = exec(project, ['sh', '-c', 'touch /probe']);
    expect(underRoot.status, 'a write under /').not.toBe(0);
    expect((await discovery(port)).status).toBe(200);
  });

  test('the account process has no capabilities and cannot gain privileges acs-4.1', () => {
    const status = expectOk(exec(project, ['cat', '/proc/1/status']), 'status').out;
    expect(status).toContain('CapEff:\t0000000000000000');
    expect(status).toContain('NoNewPrivs:\t1');
  });

  test('every service in every profile is locked down as the tool renders it acs-4.1', () => {
    const services = configModel(ALL_PROFILES, {
      MR_ACCOUNT_ISSUER: 'https://accounts.example.com',
    });
    for (const name of ['account-local-dev', 'account-hosted-dev', 'account-production']) {
      const service = services[name];
      expect(service, name).toBeDefined();
      expect(service?.ports ?? [], `${name} ports`).toEqual([]);
      expect(service?.read_only, `${name} read_only`).toBe(true);
      expect(service?.cap_drop, `${name} cap_drop`).toEqual(['ALL']);
      expect(service?.security_opt ?? [], `${name} security_opt`).toContain(
        'no-new-privileges:true',
      );
      expect(service?.privileged, `${name} privileged`).not.toBe(true);
      expect(['root', '0'], `${name} user`).not.toContain(service?.user);
      const targets = (service?.volumes ?? []).map((v) => v.target);
      expect(targets, `${name} volumes`).toContain('/var/lib/account-service/db');
      if (name !== 'account-production') {
        expect(targets, `${name} volumes`).toContain('/var/lib/account-service/keys');
      }
    }
    for (const name of ['caddy-local-dev', 'caddy-hosted-dev', 'caddy-production']) {
      const service = services[name];
      expect(service, name).toBeDefined();
      expect(service?.read_only, `${name} read_only`).toBe(true);
      expect(service?.cap_drop, `${name} cap_drop`).toEqual(['ALL']);
      expect(service?.security_opt ?? [], `${name} security_opt`).toContain(
        'no-new-privileges:true',
      );
      const published = (service?.ports ?? []).map((p) => p.host_ip);
      if (name === 'caddy-local-dev') {
        expect(published).toEqual(['127.0.0.1']);
      } else {
        const targets = (service?.ports ?? []).map((p) => Number(p.target));
        expect(targets, `${name} ports`).toEqual(expect.arrayContaining([80, 443]));
        expect(published, `${name} binds`).not.toContain('127.0.0.1');
      }
    }
  });

  test('a hosted-dev start on fresh volumes without a login key file refuses and names MR_ACCOUNT_KEY_FILE acs-4.1', () => {
    const run = compose(
      newProject(),
      ['hosted-dev'],
      ['run', '--rm', '--no-deps', '--build', 'account-hosted-dev'],
    );
    expect(run.status).not.toBe(0);
    expect(run.err).toContain('refusing to start');
    expect(run.err).toContain('MR_ACCOUNT_KEY_FILE');
  });

  test('a production start with an empty MR_ACCOUNT_ISSUER refuses and names it acs-4.1', () => {
    const run = compose(
      newProject(),
      ['production'],
      ['run', '--rm', '--no-deps', '--build', 'account-production'],
      { env: { MR_ACCOUNT_ISSUER: '' } },
    );
    expect(run.status).not.toBe(0);
    expect(run.err).toContain('refusing to start');
    expect(run.err).toContain('MR_ACCOUNT_ISSUER');
  });

  test('a start with the profile unset refuses and names MR_ACCOUNT_PROFILE acs-4.1', () => {
    const run = compose(newProject(), LOCAL, [
      'run',
      '--rm',
      '--no-deps',
      '--build',
      '-e',
      'MR_ACCOUNT_PROFILE=',
      SERVICE,
    ]);
    expect(run.status).not.toBe(0);
    expect(run.err).toContain('refusing to start');
    expect(run.err).toContain('MR_ACCOUNT_PROFILE');
  });

  // The world ticket routes, in this same stack.
  describe('the world ticket routes behind Caddy', () => {
    let idToken = '';

    beforeAll(async () => {
      setClient(project);
      const password = createAccount(project, 'world@example.com', true);
      idToken = (await signInToTokens(port, 'world@example.com', password)).id_token;
    });

    test("a ticket issued and redeemed through Caddy under a forged X-Forwarded-For answers the address Caddy saw, not the forged one or Caddy's own", async () => {
      const forged = { 'x-forwarded-for': FORGED_ADDRESS };
      const ticket = await ticketThrough(port, idToken, forged);
      const reply = await redeemThrough(port, ticket, forged);
      expect(reply.status, reply.body).toBe(200);
      const answer = jsonBody(reply);
      expect(Object.keys(answer).sort()).toEqual(['address', 'entitled', 'handle', 'name']);
      expect(answer.entitled).toBe(true);
      expect(answer.name).toBe(WORLD_NAME);
      const address = String(answer.address);
      expect(isIP(address), address).not.toBe(0);
      expect(address).not.toBe(FORGED_ADDRESS);
      const caddy = containerAddresses(project, 'caddy-local-dev');
      expect(caddy.length).toBeGreaterThan(0);
      expect(caddy).not.toContain(address);

      const checked = await postJson(
        port,
        '/world/check',
        { handle: answer.handle, world: WORLD_ID },
        forged,
      );
      expect(checked.status, checked.body).toBe(200);
      expect(jsonBody(checked)).toEqual({ handle: answer.handle, entitled: true, address });
    });

    test('a check sent from inside the account container with a forged X-Forwarded-For answers 127.0.0.1', () => {
      const body = JSON.stringify({ handle: 'not-a-handle', world: WORLD_ID });
      const run = expectOk(
        exec(project, ['node', '-e', IN_CONTAINER_CHECK, FORGED_ADDRESS, body]),
        'a check from inside the container',
      );
      const outcome = JSON.parse(run.out) as { status: number; body: string };
      expect(outcome.status, outcome.body).toBe(200);
      expect(JSON.parse(outcome.body)).toEqual({ entitled: false, address: '127.0.0.1' });
    });

    test('a check under the ipv4. and ipv6. names is answered, and discovery under them is not', async () => {
      for (const host of [IPV4_CHECK_HOST, IPV6_CHECK_HOST]) {
        const reply = await postJson(
          port,
          '/world/check',
          { handle: 'not-a-handle', world: WORLD_ID },
          { host },
        );
        expect(reply.status, `${host}: ${reply.body}`).toBe(200);
        const answer = jsonBody(reply);
        expect(Object.keys(answer).sort(), host).toEqual(['address', 'entitled']);
        expect(answer.entitled, host).toBe(false);
        expect(isIP(String(answer.address)), host).not.toBe(0);
        const discovered = await send(port, 'GET', '/.well-known/openid-configuration', { host });
        expect(discovered.status, host).toBe(421);
      }
    });
  });
});

describe('the local-dev recipe', () => {
  test('Caddy publishes exactly 127.0.0.1:4455 to port 4455 and the account service publishes nothing acs-4.2', () => {
    const services = configModel(LOCAL);
    const caddyPorts = services['caddy-local-dev']?.ports ?? [];
    expect(caddyPorts).toHaveLength(1);
    expect(caddyPorts[0]).toMatchObject({ target: 4455, published: '4455', host_ip: '127.0.0.1' });
    expect(services[SERVICE]).toBeDefined();
    expect(services[SERVICE]?.ports ?? []).toEqual([]);
  });

  test('discovery is served through Caddy with the issuer and the key set address, and /jwks holds public keys only acs-4.2', async () => {
    const project = newProject();
    const port = await bringUp(project, true);
    const served = await discovery(port);
    expect(served.status).toBe(200);
    const document = JSON.parse(served.body) as Record<string, unknown>;
    expect(document.issuer).toBe(ISSUER);
    expect(document.jwks_uri).toBe(`${ISSUER}/jwks`);

    const set = await keySet(port);
    expect(set.keys.length).toBeGreaterThan(0);
    for (const key of set.keys) {
      expect(key).toMatchObject({ kty: 'EC', crv: 'P-256' });
      expect(key.kid).toEqual(expect.any(String));
      expect(key.x).toEqual(expect.any(String));
      expect(key.y).toEqual(expect.any(String));
      expect(Object.keys(key)).not.toContain('d');
    }
  });

  test('the database and the keys survive a restart without -v: same /jwks, and the account still signs in acs-4.2', async () => {
    const project = newProject();
    let port = await bringUp(project, true);
    setClient(project);
    const password = createAccount(project, 'r@example.com', true);
    const before = await keySet(port);

    expectOk(compose(project, ALL_PROFILES, ['down']), 'down');
    port = await bringUp(project, false);

    expect(await keySet(port)).toEqual(before);
    const signed = await signInToCode(port, 'r@example.com', password);
    expect(signed.code).not.toBe('');
  });
});

interface Backup {
  readonly db: Buffer;
  readonly keys: Buffer;
}

const BACKUP_PATH = '/var/lib/account-service/db/backup.sqlite';
const VACUUM_SCRIPT =
  'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1], { readOnly: true }); db.exec("PRAGMA busy_timeout = 5000"); db.prepare("VACUUM INTO ?").run(process.argv[2]);';

function takeBackup(project: string): Backup {
  expectOk(exec(project, ['rm', '-f', BACKUP_PATH]), 'rm -f backup');
  expectOk(exec(project, ['node', '-e', VACUUM_SCRIPT, DB_PATH, BACKUP_PATH]), 'VACUUM INTO');
  const db = expectOk(exec(project, ['cat', BACKUP_PATH]), 'cat backup').stdout;
  expectOk(exec(project, ['rm', BACKUP_PATH]), 'rm backup');
  const keys = expectOk(exec(project, ['tar', '-C', KEYS_DIR, '-cf', '-', '.']), 'tar keys').stdout;
  return { db, keys };
}

function restoreDatabase(project: string, backup: Backup): Run {
  return compose(
    project,
    LOCAL,
    [
      'run',
      '--rm',
      '-T',
      '--no-deps',
      '--entrypoint',
      'sh',
      SERVICE,
      '-c',
      `umask 077 && set -C && cat > ${DB_PATH}`,
    ],
    { input: backup.db },
  );
}

function restore(project: string, backup: Backup): void {
  expectOk(
    compose(
      project,
      LOCAL,
      [
        'run',
        '--rm',
        '-T',
        '--no-deps',
        '--build',
        '--entrypoint',
        'sh',
        SERVICE,
        '-c',
        `test -z "$(ls -A ${KEYS_DIR})" && tar -C ${KEYS_DIR} -xpf -`,
      ],
      { input: backup.keys },
    ),
    'restore keys',
  );
  expectOk(restoreDatabase(project, backup), 'restore database');
  // A restore never overwrites a database already in a volume.
  expect(restoreDatabase(project, backup).status, 'second restore').not.toBe(0);
}

function verifyEs256(jwt: string, set: { readonly keys: readonly Jwk[] }): boolean {
  const [header = '', payload = '', signature = ''] = jwt.split('.');
  const { kid, alg } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
    kid?: string;
    alg?: string;
  };
  expect(alg).toBe('ES256');
  const jwk = set.keys.find((key) => key.kid === kid);
  expect(jwk, `a key with kid ${kid}`).toBeDefined();
  if (jwk === undefined) return false;
  const key = createPublicKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    format: 'jwk',
  });
  return verify(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
}

describe('a backup restored into fresh volumes', () => {
  test('keeps every account, the refresh-token chain with its spent mark, and the keys acs-4.3', async () => {
    const source = newProject();
    const sourcePort = await bringUp(source, true);
    setClient(source);
    const passwordA = createAccount(source, 'a@example.com', true);
    const passwordB = createAccount(source, 'b@example.com', false);

    const signedIn = await signInToTokens(sourcePort, 'a@example.com', passwordA);
    const r1 = signedIn.refresh_token;
    const second = tokensOf(await refresh(sourcePort, r1));
    const r2 = second.refresh_token;
    expect(r2).not.toBe(r1);
    const sourceKeys = await keySet(sourcePort);
    // The handle the source stack answers for this account and world, asserted at the end.
    const sourceHandle = await handleIfAnswered(sourcePort, signedIn.id_token);

    const backup = takeBackup(source);
    expect(backup.db.length).toBeGreaterThan(0);
    expect(backup.db.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    expect(backup.keys.length).toBeGreaterThan(0);
    expectOk(compose(source, ALL_PROFILES, ['stop']), 'stop source');

    const target = newProject();
    restore(target, backup);
    const port = await bringUp(target, false);

    // The keys came across, and the first stack's ID token verifies against the restored set.
    const restoredKeys = await keySet(port);
    expect(restoredKeys).toEqual(sourceKeys);
    expect(verifyEs256(signedIn.id_token, restoredKeys)).toBe(true);

    // The accounts came across: the entitled one signs in, the other gets the not-owned page.
    const again = await signInToCode(port, 'a@example.com', passwordA);
    expect(again.code).not.toBe('');
    const jar: Jar = { cookies: [] };
    const started = await begin(port, jar);
    const refused = await call(port, jar, 'POST', started.path, {
      headers: GOOD_POST,
      body: credentials('b@example.com', passwordB),
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toBe(notOwnedPage());
    expect(refused.headers.location).toBeUndefined();
    const resumed = await call(port, jar, 'GET', `/auth/${started.uid}`);
    expect(resumed.status).toBe(303);
    expect(String(resumed.headers.location)).not.toContain('code=');

    // The chain came across: its newest token still refreshes, with a new token.
    const r3 = tokensOf(await refresh(port, r2)).refresh_token;
    expect(r3).not.toBe(r2);

    // The spent mark came across: a spent token is refused and takes the chain's newest with it.
    expectInvalidGrant(await refresh(port, r1));
    expectInvalidGrant(await refresh(port, r3));

    // The handle key came across: the restored stack answers the source stack's handle unchanged,
    // for a check by that handle and for a new ticket of the same account and world.
    expect(sourceHandle, 'the source stack answered a handle').toEqual(expect.any(String));
    const checked = await postJson(port, '/world/check', {
      handle: sourceHandle,
      world: WORLD_ID,
    });
    expect(checked.status, checked.body).toBe(200);
    expect(jsonBody(checked).handle).toBe(sourceHandle);
    const redeemed = await redeemThrough(port, await ticketThrough(port, signedIn.id_token));
    expect(redeemed.status, redeemed.body).toBe(200);
    expect(jsonBody(redeemed).handle).toBe(sourceHandle);
  });
});
