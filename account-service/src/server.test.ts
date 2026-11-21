import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ConfigError, HOSTED_DEV_ISSUER } from './config.ts';
import {
  ATTESTATION_KEY_FILE_NAME,
  generateAttestationKey,
  generateSigningKey,
  publishedAttestationKeys,
} from './keys.ts';
import { type RunningServer, startServer } from './server.ts';

const ACCOUNT_SERVICE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(ACCOUNT_SERVICE_DIR, '..');
const POSIX = process.platform !== 'win32';
const LOCAL_HOST_HEADER = 'localhost:4455';
const START_LINE =
  /^account-service: profile=(\S+) issuer=(\S+) listening=(\S+) kids=([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*)$/m;

type Env = Record<string, string | undefined>;

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

interface Tracked {
  readonly child: ChildProcess;
  readonly group: boolean;
  readonly output: { stdout: string; stderr: string };
  readonly exit: Promise<Exit>;
}

let root = '';
const servers: RunningServer[] = [];
const children: Tracked[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acs1-'));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {
      // the test already closed it
    }
  }
  for (const tracked of children.splice(0)) {
    if (tracked.child.exitCode === null && tracked.child.signalCode === null) {
      signal(tracked, 'SIGKILL');
    }
    await tracked.exit;
  }
  rmSync(root, { recursive: true, force: true });
});

function childEnv(settings: Env): Env {
  // Never spread process.env: a developer's own MR_* variables must not change the result.
  return { PATH: process.env.PATH, HOME: process.env.HOME ?? root, ...settings };
}

function track(command: string, args: string[], cwd: string, env: Env, group: boolean): Tracked {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: group,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => {
    output.stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output.stderr += chunk.toString('utf8');
  });
  const exit = new Promise<Exit>((resolveExit) => {
    child.once('error', (error) => {
      resolveExit({ code: null, signal: null, error });
    });
    child.once('close', (code, sig) => {
      resolveExit({ code, signal: sig });
    });
  });
  const tracked: Tracked = { child, group, output, exit };
  children.push(tracked);
  return tracked;
}

function signal(tracked: Tracked, name: NodeJS.Signals): void {
  const pid = tracked.child.pid;
  if (pid === undefined) return;
  try {
    // A grouped child (the just recipe) is signalled as a terminal would: the whole group.
    if (tracked.group) process.kill(-pid, name);
    else tracked.child.kill(name);
  } catch {
    // already gone
  }
}

function waitForStdout(tracked: Tracked, pattern: RegExp): Promise<RegExpExecArray> {
  return new Promise((resolveMatch, reject) => {
    function check(): boolean {
      const match = pattern.exec(tracked.output.stdout);
      if (match === null) return false;
      tracked.child.stdout?.off('data', onData);
      resolveMatch(match);
      return true;
    }
    function onData(): void {
      check();
    }
    if (check()) return;
    tracked.child.stdout?.on('data', onData);
    tracked.exit.then((result) => {
      if (!check()) {
        reject(
          new Error(
            `exited (${String(result.code)}, ${String(result.signal)}, ${String(result.error)}) before ${pattern}; stderr: ${tracked.output.stderr}`,
          ),
        );
      }
    });
  });
}

function getJson(
  port: number,
  path: string,
  host: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolveReply, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: { host }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolveReply({
              status: res.statusCode ?? 0,
              json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            });
          } catch (error) {
            reject(error);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function connectOutcome(port: number): Promise<'connected' | 'refused'> {
  return new Promise((resolveOutcome, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolveOutcome('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolveOutcome('refused');
      else reject(error);
    });
  });
}

function portOf(url: string): number {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(url);
  expect(match, url).not.toBeNull();
  return Number(match![1]);
}

interface PublicKey {
  readonly kid: string;
  readonly x: string;
  readonly y: string;
}

async function publishedKeys(port: number, host = LOCAL_HOST_HEADER): Promise<PublicKey[]> {
  const reply = await getJson(port, '/jwks', host);
  expect(reply.status).toBe(200);
  return (reply.json.keys as PublicKey[]).map(({ kid, x, y }) => ({ kid, x, y }));
}

function localEnv(dataDir: string): Env {
  return { MR_ACCOUNT_PROFILE: 'local-dev', MR_ACCOUNT_DATA_DIR: dataDir, MR_ACCOUNT_PORT: '0' };
}

async function start(env: Env, lines: string[] = []): Promise<RunningServer> {
  const server = await startServer(env, (line) => {
    lines.push(line);
  });
  servers.push(server);
  return server;
}

describe('startServer, in process', () => {
  test('serves local discovery and its generated keys, logs one start line, and closes', async () => {
    const dataDir = join(root, 'data');
    const lines: string[] = [];
    const server = await start(localEnv(dataDir), lines);
    const port = portOf(server.url);
    expect(port).toBeGreaterThan(0);
    expect(server.config.profile).toBe('local-dev');
    expect(server.config.dataDir).toBe(dataDir);

    const discovery = await getJson(port, '/.well-known/openid-configuration', LOCAL_HOST_HEADER);
    expect(discovery.status).toBe(200);
    expect(discovery.json.issuer).toBe('http://localhost:4455');
    expect(discovery.json.jwks_uri).toBe('http://localhost:4455/jwks');
    const keys = await publishedKeys(port);
    expect(keys.length).toBeGreaterThan(0);

    expect(lines).toHaveLength(1);
    const line = START_LINE.exec(lines[0]!);
    expect(line, lines[0]).not.toBeNull();
    expect(line![1]).toBe('local-dev');
    expect(line![2]).toBe('http://localhost:4455');
    expect(line![3]).toBe(server.url);
    expect(line![4]!.split(',')).toEqual(keys.map((key) => key.kid));

    const stored = JSON.parse(readFileSync(join(dataDir, 'keys.json'), 'utf8')) as {
      keys: PublicKey[];
    };
    expect(stored.keys.map(({ kid, x, y }) => ({ kid, x, y }))).toEqual(keys);

    await expect(server.close()).resolves.toBeUndefined();
    expect(await connectOutcome(port)).toBe('refused');
  });

  test('a second start on the same data directory serves the same keys and keeps the key file', async () => {
    const dataDir = join(root, 'data');
    const first = await start(localEnv(dataDir));
    const firstKeys = await publishedKeys(portOf(first.url));
    const bytes = readFileSync(join(dataDir, 'keys.json'));
    await first.close();

    const second = await start(localEnv(dataDir));
    expect(await publishedKeys(portOf(second.url))).toEqual(firstKeys);
    expect(readFileSync(join(dataDir, 'keys.json')).equals(bytes)).toBe(true);
  });

  test('the data directory and everything in it are owner-only', async () => {
    const dataDir = join(root, 'data');
    const server = await start(localEnv(dataDir));
    await publishedKeys(portOf(server.url));
    if (!POSIX) return;
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, 'keys.json')).mode & 0o077).toBe(0);
    expect(statSync(join(dataDir, 'account.sqlite')).mode & 0o077).toBe(0);
    for (const name of readdirSync(dataDir)) {
      expect(statSync(join(dataDir, name)).mode & 0o077, name).toBe(0);
    }
  });

  test('the server itself creates an absent data directory owner-only when the key file lives elsewhere', async () => {
    const dataDir = join(root, 'data');
    const keyDir = join(root, 'elsewhere');
    const keyFile = join(keyDir, 'keys.json');
    const server = await start({ ...localEnv(dataDir), MR_ACCOUNT_KEY_FILE: keyFile });
    await publishedKeys(portOf(server.url));
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(keyFile)).toBe(true);
    expect(existsSync(join(dataDir, 'keys.json'))).toBe(false);
    if (!POSIX) return;
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, 'account.sqlite')).mode & 0o077).toBe(0);
  });

  test('hosted-dev starts on a key file the operator provided and serves the hosted issuer', async () => {
    const dataDir = join(root, 'hosted');
    mkdirSync(dataDir, { mode: 0o700 });
    const key = generateSigningKey();
    const keyFile = join(dataDir, 'keys.json');
    writeFileSync(keyFile, JSON.stringify({ profile: 'hosted-dev', keys: [key] }), { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const attestationKeyFile = join(dataDir, ATTESTATION_KEY_FILE_NAME);
    writeFileSync(
      attestationKeyFile,
      JSON.stringify({ profile: 'hosted-dev', keys: [generateAttestationKey()] }),
      { mode: 0o600 },
    );
    chmodSync(attestationKeyFile, 0o600);
    const lines: string[] = [];
    const server = await start(
      { MR_ACCOUNT_PROFILE: 'hosted-dev', MR_ACCOUNT_DATA_DIR: dataDir, MR_ACCOUNT_PORT: '0' },
      lines,
    );
    const port = portOf(server.url);
    const host = new URL(HOSTED_DEV_ISSUER).host;
    const discovery = await getJson(port, '/.well-known/openid-configuration', host);
    expect(discovery.json.issuer).toBe(HOSTED_DEV_ISSUER);
    expect(await publishedKeys(port, host)).toEqual([{ kid: key.kid, x: key.x, y: key.y }]);
    expect(START_LINE.exec(lines[0] ?? '')?.[4]).toBe(key.kid);
  });
});

describe('startServer refuses before anything is written or listening', () => {
  const refusals: ReadonlyArray<readonly [string, (dataDir: string) => Env, string]> = [
    [
      'production with dev-password sign-in',
      (dataDir) => ({
        MR_ACCOUNT_PROFILE: 'production',
        MR_ACCOUNT_ISSUER: 'https://accounts.example.com',
        MR_ACCOUNT_DATA_DIR: dataDir,
        MR_ACCOUNT_SIGN_IN: 'dev-password',
        MR_ACCOUNT_PORT: '0',
      }),
      'MR_ACCOUNT_SIGN_IN',
    ],
    [
      'production with an http issuer',
      (dataDir) => ({
        MR_ACCOUNT_PROFILE: 'production',
        MR_ACCOUNT_ISSUER: 'http://accounts.example.com',
        MR_ACCOUNT_DATA_DIR: dataDir,
        MR_ACCOUNT_PORT: '0',
      }),
      'MR_ACCOUNT_ISSUER',
    ],
    [
      'local-dev with a Steam publisher key',
      (dataDir) => ({
        ...localEnv(dataDir),
        MR_STEAM_PUBLISHER_KEY: 'INTERNAL_SECRET_publisher_key',
      }),
      'MR_STEAM_PUBLISHER_KEY',
    ],
    [
      'hosted-dev with no key file',
      (dataDir) => ({
        MR_ACCOUNT_PROFILE: 'hosted-dev',
        MR_ACCOUNT_DATA_DIR: dataDir,
        MR_ACCOUNT_PORT: '0',
      }),
      'MR_ACCOUNT_KEY_FILE',
    ],
    [
      'production with valid settings, since there is no external signer',
      (dataDir) => ({
        MR_ACCOUNT_PROFILE: 'production',
        MR_ACCOUNT_ISSUER: 'https://accounts.example.com',
        MR_ACCOUNT_DATA_DIR: dataDir,
        MR_ACCOUNT_PORT: '0',
      }),
      'MR_ACCOUNT_PROFILE',
    ],
  ];

  async function refusal(env: Env, lines: string[]): Promise<unknown> {
    try {
      await start(env, lines);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  test.each(
    refusals,
  )('%s is refused naming the setting, and the data directory is never created', async (_name, build, setting) => {
    const dataDir = join(root, 'data');
    const lines: string[] = [];
    const error = await refusal(build(dataDir), lines);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe(setting);
    expect((error as ConfigError).message).toContain(setting);
    expect((error as ConfigError).message).not.toContain('INTERNAL_SECRET_');
    expect(existsSync(dataDir)).toBe(false);
    expect(lines).toEqual([]);
  });

  test('hosted-dev with an existing data directory but no key file writes nothing into it', async () => {
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    const error = await refusal(
      { MR_ACCOUNT_PROFILE: 'hosted-dev', MR_ACCOUNT_DATA_DIR: dataDir, MR_ACCOUNT_PORT: '0' },
      [],
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe('MR_ACCOUNT_KEY_FILE');
    expect(readdirSync(dataDir)).toEqual([]);
  });
});

describe('the entry file, as a process', () => {
  test('a production env carrying a dev-only setting exits 1 naming it on stderr', async () => {
    const dataDir = join(root, 'data');
    const proc = track(
      process.execPath,
      ['src/server.ts'],
      ACCOUNT_SERVICE_DIR,
      childEnv({
        MR_ACCOUNT_PROFILE: 'production',
        MR_ACCOUNT_ISSUER: 'https://accounts.example.com',
        MR_ACCOUNT_DATA_DIR: dataDir,
        MR_ACCOUNT_SIGN_IN: 'dev-password',
        MR_ACCOUNT_PORT: '0',
      }),
      false,
    );
    const result = await proc.exit;
    expect(result.error).toBeUndefined();
    expect(result.code, proc.output.stderr).toBe(1);
    expect(proc.output.stderr).toContain('account-service: refusing to start');
    expect(proc.output.stderr).toContain('MR_ACCOUNT_SIGN_IN');
    expect(proc.output.stdout).not.toContain('listening=');
    expect(existsSync(dataDir)).toBe(false);
  });

  test('a valid local env starts, prints the start line, and exits 0 on SIGTERM', async () => {
    const dataDir = join(root, 'data');
    const proc = track(
      process.execPath,
      ['src/server.ts'],
      ACCOUNT_SERVICE_DIR,
      childEnv(localEnv(dataDir)),
      false,
    );
    const line = await waitForStdout(proc, START_LINE);
    const port = portOf(line[3]!);
    const discovery = await getJson(port, '/.well-known/openid-configuration', LOCAL_HOST_HEADER);
    expect(discovery.json.issuer).toBe('http://localhost:4455');
    signal(proc, 'SIGTERM');
    const result = await proc.exit;
    expect(result.code, proc.output.stderr).toBe(0);
    expect(await connectOutcome(port)).toBe('refused');
  });
});

describe('just account-dev', () => {
  async function runRecipe(dataDir: string): Promise<{ line: RegExpExecArray; keys: PublicKey[] }> {
    const proc = track(
      'just',
      ['--no-deps', 'account-dev'],
      REPO_ROOT,
      childEnv({ MR_ACCOUNT_DATA_DIR: dataDir, MR_ACCOUNT_PORT: '0' }),
      true,
    );
    const line = await waitForStdout(proc, START_LINE);
    const port = portOf(line[3]!);
    const discovery = await getJson(port, '/.well-known/openid-configuration', LOCAL_HOST_HEADER);
    expect(discovery.status).toBe(200);
    expect(discovery.json.issuer).toBe('http://localhost:4455');
    const keys = await publishedKeys(port);
    signal(proc, 'SIGTERM');
    await proc.exit;
    return { line, keys };
  }

  test('serves local discovery with keys it generated, and a second run reuses them', async () => {
    const dataDir = join(root, 'data');
    const first = await runRecipe(dataDir);
    expect(first.line[1]).toBe('local-dev');
    expect(first.line[2]).toBe('http://localhost:4455');
    expect(first.line[4]!.split(',')).toEqual(first.keys.map((key) => key.kid));
    expect(first.keys.length).toBeGreaterThan(0);
    const stored = JSON.parse(readFileSync(join(dataDir, 'keys.json'), 'utf8')) as {
      profile: string;
      keys: PublicKey[];
    };
    expect(stored.profile).toBe('local-dev');
    expect(stored.keys.map(({ kid, x, y }) => ({ kid, x, y }))).toEqual(first.keys);

    const second = await runRecipe(dataDir);
    expect(second.keys).toEqual(first.keys);
  });
});

interface FlowReply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function flowSend(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<FlowReply> {
  return new Promise((resolveReply, reject) => {
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

interface FlowCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
}

/** A cookie jar that sends each cookie only to a path its `Path` covers. */
function flowBrowser(port: number) {
  let cookies: FlowCookie[] = [];
  const covers = (cookiePath: string, path: string): boolean =>
    cookiePath === '/' ||
    path === cookiePath ||
    path.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
  return async (
    method: string,
    target: string,
    extra: Record<string, string> = {},
    body?: string,
  ): Promise<FlowReply> => {
    const path = target.split('?')[0] ?? target;
    const cookie = cookies
      .filter((c) => covers(c.path, path))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const headers: Record<string, string> = { host: LOCAL_HOST_HEADER, ...extra };
    if (cookie !== '') headers.cookie = cookie;
    const reply = await flowSend(port, method, target, headers, body);
    for (const line of reply.headers['set-cookie'] ?? []) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const pathAttribute = attributes.find((a) => a.toLowerCase().startsWith('path='));
      const cookiePath = pathAttribute === undefined ? '/' : pathAttribute.slice('path='.length);
      const expired = attributes.some(
        (a) => a.toLowerCase().startsWith('expires=') && Date.parse(a.slice(8)) <= Date.now(),
      );
      cookies = cookies.filter((c) => !(c.name === name && c.path === cookiePath));
      if (!expired && value !== '') cookies.push({ name, value, path: cookiePath });
    }
    return reply;
  };
}

describe('a local-dev server with a client and an account made by the admin command', () => {
  test('serves the sign-in form and completes a sign-in to an ID token for that account', async () => {
    const { runAdmin } = await import('./admin/cli.ts');
    const dataDir = join(root, 'data');
    const adminEnv: Env = { MR_ACCOUNT_PROFILE: 'local-dev', MR_ACCOUNT_DATA_DIR: dataDir };
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      out: (line: string) => {
        out.push(line);
      },
      err: (line: string) => {
        err.push(line);
      },
    };
    const clientId = 'monster-realm';
    const redirectUri = 'http://localhost:5290/';
    expect(await runAdmin(['set-client', clientId, redirectUri], adminEnv, io)).toBe(0);
    expect(await runAdmin(['create-account', 'Server.Test@Example.com'], adminEnv, io)).toBe(0);
    expect(err).toEqual([]);
    const printed = new Map(
      out.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const password = printed.get('password');
    const sub = printed.get('sub');
    expect(password).toEqual(expect.any(String));
    expect(sub).toEqual(expect.any(String));
    expect(printed.get('email')).toBe('server.test@example.com');

    const server = await start(localEnv(dataDir));
    const port = portOf(server.url);
    const browse = flowBrowser(port);

    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid',
      state: 'server-test',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const started = await browse('GET', `/auth?${query}`);
    expect(started.status, started.body).toBe(303);
    const interaction = new URL(String(started.headers.location), 'http://localhost:4455');
    expect(interaction.pathname).toMatch(/^\/interaction\/[^/]+$/);

    const form = await browse('GET', interaction.pathname);
    expect(form.status).toBe(200);
    expect(String(form.headers['content-type'])).toMatch(/^text\/html/);
    expect(form.body).toContain(`action="${interaction.pathname}"`);
    expect(form.body).toContain('name="email"');
    expect(form.body).toContain('name="password"');

    const posted = await browse(
      'POST',
      interaction.pathname,
      { origin: 'http://localhost:4455', 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ email: 'server.test@example.com', password: password! }).toString(),
    );
    expect(posted.status, posted.body).toBe(303);
    const resume = new URL(String(posted.headers.location));
    const back = await browse('GET', resume.pathname);
    expect(back.status, back.body).toBe(303);
    const redirect = new URL(String(back.headers.location));
    expect(`${redirect.origin}${redirect.pathname}`).toBe(redirectUri);
    expect(redirect.searchParams.get('state')).toBe('server-test');
    const code = redirect.searchParams.get('code');
    expect(code).toEqual(expect.any(String));

    const exchanged = await flowSend(
      port,
      'POST',
      '/token',
      { host: LOCAL_HOST_HEADER, 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: redirectUri,
      }).toString(),
    );
    expect(exchanged.status, exchanged.body).toBe(200);
    const tokens = JSON.parse(exchanged.body) as Record<string, unknown>;
    expect(tokens.refresh_token).toEqual(expect.any(String));
    const payload = JSON.parse(
      Buffer.from(String(tokens.id_token).split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload.iss).toBe('http://localhost:4455');
    expect(payload.aud).toBe(clientId);
    expect(payload.sub).toBe(sub);
    expect(payload.mr_ent).toEqual(['base-game']);
  });
});

// ---- the attestation route, served by startServer ----

const CLIENT_ID = 'monster-realm';
const REDIRECT_URI = 'http://localhost:5290/';
const LOCAL_ATTEST_ISSUER = 'http://localhost:4455/attest';
const HOSTED_HOST_HEADER = new URL(HOSTED_DEV_ISSUER).host;
const WORLD = 'dns:play.example.com:3000/c200a1b2c3d4';
const NONCE = 'n-9d2c7e4a1f';
const WORLD_MARK = 'dns:WORLDMARK-r8Ys3WuJo2Kn.example:3000/WORLDMARK-e93b1a7c';
const NONCE_MARK = 'NONCEMARK-5Gx1Pq7ZtRmC2v';

/** A cookie jar, as `flowBrowser`, for a server answering as `host`. */
function hostBrowser(port: number, host: string) {
  let cookies: FlowCookie[] = [];
  const covers = (cookiePath: string, path: string): boolean =>
    cookiePath === '/' ||
    path === cookiePath ||
    path.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
  return async (
    method: string,
    target: string,
    extra: Record<string, string> = {},
    body?: string,
  ): Promise<FlowReply> => {
    const path = target.split('?')[0] ?? target;
    const cookie = cookies
      .filter((c) => covers(c.path, path))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const headers: Record<string, string> = { host, ...extra };
    if (cookie !== '') headers.cookie = cookie;
    const reply = await flowSend(port, method, target, headers, body);
    for (const line of reply.headers['set-cookie'] ?? []) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const pathAttribute = attributes.find((a) => a.toLowerCase().startsWith('path='));
      const cookiePath = pathAttribute === undefined ? '/' : pathAttribute.slice('path='.length);
      cookies = cookies.filter((c) => !(c.name === name && c.path === cookiePath));
      if (value !== '') cookies.push({ name, value, path: cookiePath });
    }
    return reply;
  };
}

async function admin(env: Env, argv: string[]): Promise<Map<string, string>> {
  const { runAdmin } = await import('./admin/cli.ts');
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdmin(argv, env, {
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
  });
  expect(code, err.join('\n')).toBe(0);
  return new Map(
    out.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

/** A full sign-in by authorization code and PKCE; returns the ID token. */
async function signInToIdToken(options: {
  readonly port: number;
  readonly host: string;
  readonly origin: string;
  readonly email: string;
  readonly password: string;
}): Promise<string> {
  const browse = hostBrowser(options.port, options.host);
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    state: 'attest-test',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const started = await browse('GET', `/auth?${query}`);
  expect(started.status, started.body).toBe(303);
  const interaction = new URL(String(started.headers.location), options.origin);
  const form = await browse('GET', interaction.pathname);
  expect(form.status, form.body).toBe(200);
  const posted = await browse(
    'POST',
    interaction.pathname,
    { origin: options.origin, 'content-type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({ email: options.email, password: options.password }).toString(),
  );
  expect(posted.status, posted.body).toBe(303);
  const back = await browse('GET', new URL(String(posted.headers.location)).pathname);
  expect(back.status, back.body).toBe(303);
  const code = new URL(String(back.headers.location)).searchParams.get('code');
  expect(code).toEqual(expect.any(String));
  const exchanged = await flowSend(
    options.port,
    'POST',
    '/token',
    { host: options.host, 'content-type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  );
  expect(exchanged.status, exchanged.body).toBe(200);
  const idToken = (JSON.parse(exchanged.body) as Record<string, unknown>).id_token;
  expect(idToken).toEqual(expect.any(String));
  return idToken as string;
}

function postAttest(
  port: number,
  idToken: string,
  body: string,
  extra: Record<string, string> = {},
): Promise<FlowReply> {
  return flowSend(
    port,
    'POST',
    '/attest',
    {
      host: LOCAL_HOST_HEADER,
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json',
      ...extra,
    },
    body,
  );
}

function attestationIn(reply: FlowReply): string {
  expect(reply.status, reply.body).toBe(200);
  const json = JSON.parse(reply.body) as Record<string, unknown>;
  expect(Object.keys(json)).toEqual(['attestation']);
  return json.attestation as string;
}

function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function publishedLocalSet() {
  return createLocalJWKSet({ keys: [...publishedAttestationKeys()['local-dev']] });
}

interface SignedInLocal {
  readonly server: RunningServer;
  readonly port: number;
  readonly dataDir: string;
  readonly adminEnv: Env;
  readonly email: string;
  readonly sub: string;
  readonly idToken: string;
}

/** A local-dev server, a client and an account made by the admin command, and its ID token. */
async function signedInLocal(lines: string[] = []): Promise<SignedInLocal> {
  const dataDir = join(root, 'data');
  const adminEnv: Env = { MR_ACCOUNT_PROFILE: 'local-dev', MR_ACCOUNT_DATA_DIR: dataDir };
  const email = 'attest.test@example.com';
  await admin(adminEnv, ['set-client', CLIENT_ID, REDIRECT_URI]);
  const made = await admin(adminEnv, ['create-account', email]);
  const server = await start(localEnv(dataDir), lines);
  const port = portOf(server.url);
  const idToken = await signInToIdToken({
    port,
    host: LOCAL_HOST_HEADER,
    origin: 'http://localhost:4455',
    email,
    password: made.get('password')!,
  });
  const sub = made.get('sub')!;
  expect(claimsOf(idToken).sub).toBe(sub);
  return { server, port, dataDir, adminEnv, email, sub, idToken };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen) => {
    probe.listen(0, '127.0.0.1', () => {
      resolveListen();
    });
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolveClose) => {
    probe.close(() => {
      resolveClose();
    });
  });
  return port;
}

function writeOwnerOnly(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

describe('the attestation route served by startServer', () => {
  test('on local-dev a real ID token gets an attestation that verifies under the published local-dev key acs-3.1', async () => {
    const local = await signedInLocal();
    const reply = await postAttest(
      local.port,
      local.idToken,
      JSON.stringify({ world: WORLD, nonce: NONCE }),
    );
    const attestation = attestationIn(reply);
    const verified = await jwtVerify(attestation, publishedLocalSet(), {
      issuer: LOCAL_ATTEST_ISSUER,
      audience: WORLD,
      algorithms: ['Ed25519'],
    });
    expect(verified.payload.iss).toBe('http://localhost:4455/attest');
    expect(verified.payload.sub).toBe(local.sub);
    expect(verified.payload.aud).toBe(WORLD);
    expect(verified.payload.nonce).toBe(NONCE);
    expect(verified.payload.mr_ent).toEqual(['base-game']);
    expect(verified.protectedHeader.kid).toBe(publishedAttestationKeys()['local-dev'][0]!.kid);
  });

  test('the attestation does not verify under the key set the server publishes at /jwks acs-3.1', async () => {
    const local = await signedInLocal();
    const attestation = attestationIn(
      await postAttest(local.port, local.idToken, JSON.stringify({ world: WORLD, nonce: NONCE })),
    );
    const served = await getJson(local.port, '/jwks', LOCAL_HOST_HEADER);
    expect(served.status).toBe(200);
    const loginSet = createLocalJWKSet(served.json as unknown as JSONWebKeySet);
    // The control: the ID token verifies under it.
    await expect(jwtVerify(local.idToken, loginSet)).resolves.toBeDefined();
    await expect(jwtVerify(attestation, loginSet)).rejects.toThrow();
  });

  test('a local-dev start on an empty data directory writes no attestation key file, before or after an attestation acs-3.1', async () => {
    const fresh = join(root, 'fresh');
    await start(localEnv(fresh));
    expect(readdirSync(fresh)).not.toContain(ATTESTATION_KEY_FILE_NAME);
    const local = await signedInLocal();
    attestationIn(
      await postAttest(local.port, local.idToken, JSON.stringify({ world: WORLD, nonce: NONCE })),
    );
    expect(readdirSync(local.dataDir)).not.toContain(ATTESTATION_KEY_FILE_NAME);
    expect(readdirSync(fresh)).not.toContain(ATTESTATION_KEY_FILE_NAME);
  });

  test('hosted-dev without attestation-keys.json is refused naming MR_ACCOUNT_KEY_FILE, writes nothing and listens on nothing acs-3.1', async () => {
    const dataDir = join(root, 'hosted');
    mkdirSync(dataDir, { mode: 0o700 });
    writeOwnerOnly(
      join(dataDir, 'keys.json'),
      JSON.stringify({ profile: 'hosted-dev', keys: [generateSigningKey()] }),
    );
    const port = await freePort();
    const lines: string[] = [];
    let error: unknown;
    try {
      await start(
        {
          MR_ACCOUNT_PROFILE: 'hosted-dev',
          MR_ACCOUNT_DATA_DIR: dataDir,
          MR_ACCOUNT_PORT: String(port),
        },
        lines,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe('MR_ACCOUNT_KEY_FILE');
    expect((error as ConfigError).message).toContain(ATTESTATION_KEY_FILE_NAME);
    expect(readdirSync(dataDir)).toEqual(['keys.json']);
    expect(lines).toEqual([]);
    expect(await connectOutcome(port)).toBe('refused');
  });

  test('hosted-dev refused for its attestation key file creates no data directory and writes nothing beside the key file acs-3.1', async () => {
    const dataDir = join(root, 'not-yet', 'data');
    const keyDir = join(root, 'keys');
    mkdirSync(keyDir, { mode: 0o700 });
    const keyFile = join(keyDir, 'login.json');
    writeOwnerOnly(
      keyFile,
      JSON.stringify({ profile: 'hosted-dev', keys: [generateSigningKey()] }),
    );
    const lines: string[] = [];
    let error: unknown;
    try {
      await start(
        {
          MR_ACCOUNT_PROFILE: 'hosted-dev',
          MR_ACCOUNT_DATA_DIR: dataDir,
          MR_ACCOUNT_KEY_FILE: keyFile,
          MR_ACCOUNT_PORT: '0',
        },
        lines,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe('MR_ACCOUNT_KEY_FILE');
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(join(root, 'not-yet'))).toBe(false);
    expect(readdirSync(keyDir)).toEqual(['login.json']);
    expect(lines).toEqual([]);
  });

  test("hosted-dev with attestation-keys.json signs with that file's key acs-3.1", async () => {
    const dataDir = join(root, 'hosted');
    mkdirSync(dataDir, { mode: 0o700 });
    const attestationKey = generateAttestationKey();
    writeOwnerOnly(
      join(dataDir, 'keys.json'),
      JSON.stringify({ profile: 'hosted-dev', keys: [generateSigningKey()] }),
    );
    writeOwnerOnly(
      join(dataDir, ATTESTATION_KEY_FILE_NAME),
      JSON.stringify({ profile: 'hosted-dev', keys: [attestationKey] }),
    );
    const env: Env = { MR_ACCOUNT_PROFILE: 'hosted-dev', MR_ACCOUNT_DATA_DIR: dataDir };
    const email = 'hosted.attest@example.com';
    await admin(env, ['set-client', CLIENT_ID, REDIRECT_URI]);
    const made = await admin(env, ['create-account', email]);
    const server = await start({ ...env, MR_ACCOUNT_PORT: '0' });
    const port = portOf(server.url);
    const idToken = await signInToIdToken({
      port,
      host: HOSTED_HOST_HEADER,
      origin: HOSTED_DEV_ISSUER,
      email,
      password: made.get('password')!,
    });
    const attestation = attestationIn(
      await postAttest(port, idToken, JSON.stringify({ world: WORLD, nonce: NONCE }), {
        host: HOSTED_HOST_HEADER,
      }),
    );
    const fileSet = createLocalJWKSet({
      keys: [{ kty: 'OKP', crv: 'Ed25519', x: attestationKey.x, kid: attestationKey.kid }],
    });
    const verified = await jwtVerify(attestation, fileSet, {
      issuer: `${HOSTED_DEV_ISSUER}/attest`,
      audience: WORLD,
      algorithms: ['Ed25519'],
    });
    expect(verified.protectedHeader.kid).toBe(attestationKey.kid);
    expect(verified.payload.sub).toBe(made.get('sub'));
    await expect(jwtVerify(attestation, publishedLocalSet())).rejects.toThrow();
  });

  test("POST /attest under another Host gets the provider's 421 and no attestation", async () => {
    const local = await signedInLocal();
    const reply = await postAttest(
      local.port,
      local.idToken,
      JSON.stringify({ world: WORLD, nonce: NONCE }),
      { host: 'example.com' },
    );
    expect(reply.status).toBe(421);
    expect(reply.body).not.toContain('attestation');
  });

  test('after the entitlement is cleared with the admin command, a still-valid ID token gets 403 not_entitled acs-3.1', async () => {
    const local = await signedInLocal();
    const body = JSON.stringify({ world: WORLD, nonce: NONCE });
    attestationIn(await postAttest(local.port, local.idToken, body));
    await admin(local.adminEnv, ['set-entitlement', local.email, 'not-entitled']);
    const refused = await postAttest(local.port, local.idToken, body);
    expect(refused.status).toBe(403);
    expect(refused.body).toBe(JSON.stringify({ error: 'not_entitled' }));
  });

  test('the log keeps its one start line, gains one line with the sub per attestation, and never a world or nonce acs-3.5', async () => {
    const lines: string[] = [];
    const local = await signedInLocal(lines);
    expect(lines).toHaveLength(1);
    expect(START_LINE.exec(lines[0]!), lines[0]).not.toBeNull();
    const marked = JSON.stringify({ world: WORLD_MARK, nonce: NONCE_MARK });

    const attestation = attestationIn(await postAttest(local.port, local.idToken, marked));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(local.sub);

    const refusals: ReadonlyArray<readonly [string, Promise<FlowReply>]> = [
      [
        'no token',
        flowSend(
          local.port,
          'POST',
          '/attest',
          { host: LOCAL_HOST_HEADER, 'content-type': 'application/json' },
          marked,
        ),
      ],
      [
        'a wrong content type',
        postAttest(local.port, local.idToken, marked, { 'content-type': 'text/plain' }),
      ],
      [
        'a third member',
        postAttest(
          local.port,
          local.idToken,
          JSON.stringify({ world: WORLD_MARK, nonce: NONCE_MARK, x: 1 }),
        ),
      ],
      [
        'a world with a space',
        postAttest(
          local.port,
          local.idToken,
          JSON.stringify({ world: `${WORLD_MARK} x`, nonce: NONCE_MARK }),
        ),
      ],
      [
        'GET',
        flowSend(local.port, 'GET', '/attest', {
          host: LOCAL_HOST_HEADER,
          authorization: `Bearer ${local.idToken}`,
        }),
      ],
      ['another Host', postAttest(local.port, local.idToken, marked, { host: 'example.com' })],
    ];
    for (const [name, pending] of refusals) {
      const reply = await pending;
      expect(reply.status, name).not.toBe(200);
    }
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain('WORLDMARK');
      expect(line).not.toContain('NONCEMARK');
      expect(line).not.toContain(local.idToken);
      expect(line).not.toContain(attestation);
      for (const part of [...local.idToken.split('.'), ...attestation.split('.')]) {
        expect(line).not.toContain(part);
      }
    }
  });
});
