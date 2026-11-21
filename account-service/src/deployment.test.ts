import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { type IncomingHttpHeaders, request } from 'node:http';
import { resolve } from 'node:path';
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

afterAll(() => {
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
});

describe('the local-dev recipe', () => {
  test('Caddy publishes exactly 127.0.0.1:4455 to port 4455 and the account service publishes nothing acs-4.2', () => {
    const run = expectOk(
      compose(newProject(), LOCAL, ['config', '--format', 'json'], {
        env: { MR_AUTH_LOCAL_PORT: undefined },
      }),
      'config',
    );
    const model = JSON.parse(run.out) as {
      services: Record<string, { ports?: Array<Record<string, unknown>> }>;
    };
    const caddyPorts = model.services['caddy-local-dev']?.ports ?? [];
    expect(caddyPorts).toHaveLength(1);
    expect(caddyPorts[0]).toMatchObject({ target: 4455, published: '4455', host_ip: '127.0.0.1' });
    expect(model.services[SERVICE]).toBeDefined();
    expect(model.services[SERVICE]?.ports ?? []).toEqual([]);
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

function takeBackup(project: string): Backup {
  expectOk(
    exec(project, [
      'node',
      '-e',
      'new (require("node:sqlite").DatabaseSync)(process.argv[1]).prepare("VACUUM INTO ?").run(process.argv[2])',
      DB_PATH,
      '/tmp/account.sqlite',
    ]),
    'VACUUM INTO',
  );
  const db = expectOk(exec(project, ['cat', '/tmp/account.sqlite']), 'cat backup').stdout;
  expectOk(exec(project, ['rm', '/tmp/account.sqlite']), 'rm backup');
  const keys = expectOk(exec(project, ['tar', '-C', KEYS_DIR, '-cf', '-', '.']), 'tar keys').stdout;
  return { db, keys };
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
        'tar',
        SERVICE,
        '-C',
        KEYS_DIR,
        '-xpf',
        '-',
      ],
      { input: backup.keys },
    ),
    'restore keys',
  );
  expectOk(
    compose(
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
        `umask 077 && cat > ${DB_PATH}`,
      ],
      { input: backup.db },
    ),
    'restore database',
  );
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
  });
});
