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
import { type IncomingHttpHeaders, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ConfigError, HOSTED_DEV_ISSUER } from './config.ts';
import { generateSigningKey } from './keys.ts';
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
