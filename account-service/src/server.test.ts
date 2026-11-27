import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type SteamStub, startSteamStub } from '../test-util/steamStub.ts';
import { ID_TOKEN_CLAIMS } from './claims.ts';
import { ConfigError, HOSTED_DEV_ISSUER } from './config.ts';
import { denyList, steamAccounts } from './denyList.ts';
import {
  ATTESTATION_KEY_FILE_NAME,
  generateAttestationKey,
  generateHandleKey,
  generateSigningKey,
  HANDLE_KEY_FILE_NAME,
  publishedAttestationKeys,
} from './keys.ts';
import { type RunningServer, startServer, steamEntitlement } from './server.ts';
import { parseSteamId, type SteamId } from './steam/ownership.ts';
import { createSteamWebApi } from './steam/webApi.ts';
import { type AccountStore, openAccountStore } from './store/sqliteAdapter.ts';

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
    writeHandleKeyFile(join(dataDir, HANDLE_KEY_FILE_NAME), 'hosted-dev');
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
        MR_ACCOUNT_HANDLE_KEY_FILE: join(root, 'handle', 'handle-keys.json'),
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
        MR_ACCOUNT_HANDLE_KEY_FILE: productionHandleKeyFile(),
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
        MR_ACCOUNT_HANDLE_KEY_FILE: join(root, 'handle', 'handle-keys.json'),
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
    writeHandleKeyFile(join(dataDir, HANDLE_KEY_FILE_NAME), 'hosted-dev');
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

// ---- the world ticket routes, served by startServer ----

const TICKET_NAME = 'dns:NAMEMARK-t4Wq8Ze1Lc.example:3000/NAMEMARK-0b7d2e91';
const WORLD_ID = createHash('sha256').update('acs14 server world').digest('hex');
const FORGED_ADDRESS = '203.0.113.66';
const PEER_ADDRESS = '127.0.0.1';
const LOCAL_IPV4_CHECK_HOST = 'ipv4.localhost:4455';
const LOCAL_IPV6_CHECK_HOST = 'ipv6.localhost:4455';
const HANDLE_SETTING = 'MR_ACCOUNT_HANDLE_KEY_FILE';

type HandleKey = ReturnType<typeof generateHandleKey>;

/** Writes a handle key file of one new key marked for `profile`, and returns that key. */
function writeHandleKeyFile(path: string, profile: string, mode = 0o600): HandleKey {
  const key = generateHandleKey();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ profile, keys: [key] }), { mode });
  chmodSync(path, mode);
  return key;
}

/** A valid production handle key file outside any data directory; returns its path. */
function productionHandleKeyFile(): string {
  const path = join(root, 'handle', HANDLE_KEY_FILE_NAME);
  writeHandleKeyFile(path, 'production');
  return path;
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<FlowReply> {
  return flowSend(
    port,
    'POST',
    path,
    { host: LOCAL_HOST_HEADER, 'content-type': 'application/json', ...extra },
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

function bodyOf(reply: FlowReply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>;
}

async function ticketFor(port: number, idToken: string, host = LOCAL_HOST_HEADER): Promise<string> {
  const reply = await postJson(
    port,
    '/ticket',
    { world: TICKET_NAME },
    { host, authorization: `Bearer ${idToken}` },
  );
  expect(reply.status, reply.body).toBe(200);
  const json = bodyOf(reply);
  expect(Object.keys(json)).toEqual(['ticket']);
  expect(json.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return json.ticket as string;
}

function redeemTicket(
  port: number,
  ticket: string,
  extra: Record<string, string> = {},
): Promise<FlowReply> {
  return postJson(port, '/world/check', { ticket, names: [TICKET_NAME], world: WORLD_ID }, extra);
}

function checkHandleAt(
  port: number,
  handle: string,
  extra: Record<string, string> = {},
): Promise<FlowReply> {
  return postJson(port, '/world/check', { handle, world: WORLD_ID }, extra);
}

/** A redemption's answer: exactly handle, entitled, address and name. */
function redeemedIn(reply: FlowReply): Record<string, unknown> {
  expect(reply.status, reply.body).toBe(200);
  const json = bodyOf(reply);
  expect(Object.keys(json).sort()).toEqual(['address', 'entitled', 'handle', 'name']);
  expect(json.handle).toEqual(expect.any(String));
  return json;
}

async function startRefusal(env: Env, lines: string[]): Promise<unknown> {
  try {
    await start(env, lines);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Bytes of the database and any journal beside it. */
function databaseBytes(dataDir: string): Buffer {
  const files = readdirSync(dataDir).filter((name) => name.startsWith('account.sqlite'));
  expect(files).toContain('account.sqlite');
  return Buffer.concat(files.map((name) => readFileSync(join(dataDir, name))));
}

function hostedKeyFiles(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeOwnerOnly(
    join(dataDir, 'keys.json'),
    JSON.stringify({ profile: 'hosted-dev', keys: [generateSigningKey()] }),
  );
  writeOwnerOnly(
    join(dataDir, ATTESTATION_KEY_FILE_NAME),
    JSON.stringify({ profile: 'hosted-dev', keys: [generateAttestationKey()] }),
  );
}

describe('the world ticket routes served by startServer', () => {
  test('on local-dev a real ID token gets a ticket a world redeems for handle, entitled, address and name, and the handle checks back acs-14.2', async () => {
    const local = await signedInLocal();
    const ticket = await ticketFor(local.port, local.idToken);
    const answer = redeemedIn(await redeemTicket(local.port, ticket));
    expect(answer).toMatchObject({ entitled: true, address: PEER_ADDRESS, name: TICKET_NAME });
    const checked = await checkHandleAt(local.port, String(answer.handle));
    expect(checked.status, checked.body).toBe(200);
    expect(bodyOf(checked)).toEqual({
      handle: answer.handle,
      entitled: true,
      address: PEER_ADDRESS,
    });
    const again = await redeemTicket(local.port, ticket);
    expect(again.status).toBe(403);
    expect(Object.keys(bodyOf(again))).toEqual(['error']);
  });

  test('the check is answered under the ipv4. and ipv6. names of the issuer, and /ticket is not acs-14.2', async () => {
    const local = await signedInLocal();
    const ticket = await ticketFor(local.port, local.idToken);
    const answer = redeemedIn(
      await redeemTicket(local.port, ticket, { host: LOCAL_IPV4_CHECK_HOST }),
    );
    const checked = await checkHandleAt(local.port, String(answer.handle), {
      host: LOCAL_IPV6_CHECK_HOST,
    });
    expect(checked.status, checked.body).toBe(200);
    expect(bodyOf(checked).handle).toBe(answer.handle);
    const misplaced = await postJson(
      local.port,
      '/ticket',
      { world: TICKET_NAME },
      { host: LOCAL_IPV4_CHECK_HOST, authorization: `Bearer ${local.idToken}` },
    );
    expect(misplaced.status).toBe(421);
    expect(misplaced.body).not.toContain('"ticket"');
  });

  test('a ticket is issued to an account that is not entitled, and its redemption answers entitled false with a handle acs-14.1', async () => {
    const local = await signedInLocal();
    await admin(local.adminEnv, ['set-entitlement', local.email, 'not-entitled']);
    const ticket = await ticketFor(local.port, local.idToken);
    const answer = redeemedIn(await redeemTicket(local.port, ticket));
    expect(answer.entitled).toBe(false);
    expect(answer.name).toBe(TICKET_NAME);
  });

  test('no ticket is issued without a valid ID token: none, or one changed after signing acs-14.1', async () => {
    const lines: string[] = [];
    const local = await signedInLocal(lines);
    const [header, payload, signature] = local.idToken.split('.');
    const signedClaims = JSON.parse(
      Buffer.from(payload ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const otherSub = Buffer.from(
      JSON.stringify({ ...signedClaims, sub: 'dev:00000000-0000-4000-8000-000000000000' }),
    ).toString('base64url');
    const refusals: ReadonlyArray<readonly [string, Record<string, string>]> = [
      ['no token', {}],
      ['a changed token', { authorization: `Bearer ${header}.${otherSub}.${signature}` }],
      ['a token under another scheme', { authorization: `Basic ${local.idToken}` }],
    ];
    for (const [name, extra] of refusals) {
      const reply = await postJson(local.port, '/ticket', { world: TICKET_NAME }, extra);
      expect(reply.status, name).toBe(401);
      expect(reply.headers['www-authenticate'], name).toBe('Bearer');
      expect(Object.keys(bodyOf(reply)), name).toEqual(['error']);
    }
    expect(lines).toHaveLength(1);
  });

  test('with no trusted proxy set a forged X-Forwarded-For is ignored: the address is the peer acs-14.2', async () => {
    const local = await signedInLocal();
    const forged = { 'x-forwarded-for': FORGED_ADDRESS };
    const ticket = await ticketFor(local.port, local.idToken);
    const answer = redeemedIn(await redeemTicket(local.port, ticket, forged));
    expect(answer.address).toBe(PEER_ADDRESS);
    const checked = await checkHandleAt(local.port, String(answer.handle), forged);
    expect(bodyOf(checked).address).toBe(PEER_ADDRESS);
  });

  test('the log gains one line with the sub per ticket issued and redeemed, none per handle check, and never a world, name, handle, ticket or address acs-14.8', async () => {
    const lines: string[] = [];
    const local = await signedInLocal(lines);
    expect(lines).toHaveLength(1);
    const forged = { 'x-forwarded-for': FORGED_ADDRESS };

    const ticket = await ticketFor(local.port, local.idToken);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(local.sub);
    const answer = redeemedIn(await redeemTicket(local.port, ticket, forged));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(local.sub);
    const handle = String(answer.handle);
    expect((await checkHandleAt(local.port, handle, forged)).status).toBe(200);
    expect((await checkHandleAt(local.port, `${handle}A`, forged)).status).toBe(200);

    const refused: ReadonlyArray<readonly [string, Promise<FlowReply>]> = [
      ['a ticket with no token', postJson(local.port, '/ticket', { world: TICKET_NAME })],
      ['a spent ticket', redeemTicket(local.port, ticket, forged)],
      [
        'a check with a member more',
        postJson(local.port, '/world/check', { handle, world: WORLD_ID, x: TICKET_NAME }),
      ],
    ];
    for (const [name, pending] of refused) {
      expect((await pending).status, name).not.toBe(200);
    }
    expect(lines).toHaveLength(3);

    const dot = handle.indexOf('.');
    const secrets = [
      ticket,
      handle,
      handle.slice(dot + 1),
      local.idToken,
      ...local.idToken.split('.'),
      WORLD_ID,
      WORLD_ID.slice(0, 16),
      FORGED_ADDRESS,
      PEER_ADDRESS,
    ];
    // The start line names the address the server listens on; every line after it is checked.
    for (const line of lines.slice(1)) {
      expect(line).not.toContain('NAMEMARK');
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });

  test('the database file holds no ticket text, issued or spent acs-14.8', async () => {
    const local = await signedInLocal();
    const spent = await ticketFor(local.port, local.idToken);
    const kept = await ticketFor(local.port, local.idToken);
    redeemedIn(await redeemTicket(local.port, spent));
    const bytes = databaseBytes(local.dataDir);
    // The control: the live ticket's record reached the file.
    const keptId = createHash('sha256').update(kept).digest('base64url');
    expect(bytes.includes(Buffer.from(keptId))).toBe(true);
    expect(bytes.includes(Buffer.from(spent))).toBe(false);
    expect(bytes.includes(Buffer.from(kept))).toBe(false);
  });

  test('local-dev writes an owner-only handle key file beside the login key file, and a restart answers the same handle', async () => {
    const local = await signedInLocal();
    const handleFile = join(local.dataDir, HANDLE_KEY_FILE_NAME);
    expect(existsSync(handleFile)).toBe(true);
    const bytes = readFileSync(handleFile);
    const ticket = await ticketFor(local.port, local.idToken);
    const handle = String(redeemedIn(await redeemTicket(local.port, ticket)).handle);
    await local.server.close();

    const again = await start(localEnv(local.dataDir));
    const checked = await checkHandleAt(portOf(again.url), handle);
    expect(checked.status, checked.body).toBe(200);
    expect(bodyOf(checked)).toEqual({ handle, entitled: true, address: PEER_ADDRESS });
    expect(readFileSync(handleFile).equals(bytes)).toBe(true);
    if (POSIX) expect(statSync(handleFile).mode & 0o077).toBe(0);
  });

  test('local-dev with the login key file elsewhere writes its handle key file beside that file', async () => {
    const dataDir = join(root, 'data');
    const keyDir = join(root, 'elsewhere');
    const server = await start({
      ...localEnv(dataDir),
      MR_ACCOUNT_KEY_FILE: join(keyDir, 'keys.json'),
    });
    await publishedKeys(portOf(server.url));
    expect(existsSync(join(keyDir, HANDLE_KEY_FILE_NAME))).toBe(true);
    expect(existsSync(join(dataDir, HANDLE_KEY_FILE_NAME))).toBe(false);
  });
});

describe('the handle key file at start', () => {
  test('hosted-dev with its login and attestation key files and no handle key file is refused naming the setting, writing and listening on nothing', async () => {
    const dataDir = join(root, 'hosted');
    hostedKeyFiles(dataDir);
    const port = await freePort();
    const lines: string[] = [];
    const error = await startRefusal(
      {
        MR_ACCOUNT_PROFILE: 'hosted-dev',
        MR_ACCOUNT_DATA_DIR: dataDir,
        MR_ACCOUNT_PORT: String(port),
      },
      lines,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe(HANDLE_SETTING);
    expect(readdirSync(dataDir).sort()).toEqual([ATTESTATION_KEY_FILE_NAME, 'keys.json'].sort());
    expect(lines).toEqual([]);
    expect(await connectOutcome(port)).toBe('refused');
  });

  test.each([
    ['group can read', 'hosted-dev', 0o640],
    ['others can read', 'hosted-dev', 0o604],
    ['marked local-dev', 'local-dev', 0o600],
    ['marked production', 'production', 0o600],
  ] as ReadonlyArray<
    readonly [string, string, number]
  >)('hosted-dev refuses a handle key file that %s, naming the setting and no part of its key', async (_name, profile, mode) => {
    if (!POSIX && mode !== 0o600) return;
    const dataDir = join(root, 'hosted');
    hostedKeyFiles(dataDir);
    const key = writeHandleKeyFile(join(dataDir, HANDLE_KEY_FILE_NAME), profile, mode);
    const lines: string[] = [];
    const error = await startRefusal(
      { MR_ACCOUNT_PROFILE: 'hosted-dev', MR_ACCOUNT_DATA_DIR: dataDir, MR_ACCOUNT_PORT: '0' },
      lines,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe(HANDLE_SETTING);
    expect((error as ConfigError).message).not.toContain(key.k);
    expect((error as ConfigError).message).not.toContain(key.k.slice(0, 16));
    expect(lines).toEqual([]);
  });

  test("hosted-dev with MR_ACCOUNT_HANDLE_KEY_FILE elsewhere starts, leaves that file as it is, and seals under that file's key", async () => {
    const { createHandleCodec } = await import('./worldHandle.ts');
    const dataDir = join(root, 'hosted');
    hostedKeyFiles(dataDir);
    const handleFile = join(root, 'handle-elsewhere', 'hosted-handle.json');
    const key = writeHandleKeyFile(handleFile, 'hosted-dev');
    const bytes = readFileSync(handleFile);
    const env: Env = {
      MR_ACCOUNT_PROFILE: 'hosted-dev',
      MR_ACCOUNT_DATA_DIR: dataDir,
      MR_ACCOUNT_HANDLE_KEY_FILE: handleFile,
    };
    const email = 'hosted.ticket@example.com';
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
    const ticket = await ticketFor(port, idToken, HOSTED_HOST_HEADER);
    const answer = redeemedIn(
      await redeemTicket(port, ticket, { host: `ipv4.${HOSTED_HOST_HEADER}` }),
    );
    expect(answer.entitled).toBe(true);
    expect(createHandleCodec({ keys: [key] }).open(String(answer.handle))).toEqual({
      account: made.get('sub'),
      world: WORLD_ID,
    });
    expect(readFileSync(handleFile).equals(bytes)).toBe(true);
    expect(readdirSync(dataDir)).not.toContain(HANDLE_KEY_FILE_NAME);
  });

  function productionEnv(dataDir: string, port: number, extra: Env = {}): Env {
    return {
      MR_ACCOUNT_PROFILE: 'production',
      MR_ACCOUNT_ISSUER: 'https://accounts.example.com',
      MR_ACCOUNT_DATA_DIR: dataDir,
      MR_ACCOUNT_PORT: String(port),
      ...extra,
    };
  }

  interface ProductionRefusal {
    readonly name: string;
    /** The handle key setting to start with; `written` collects the key text of any file made. */
    readonly setting: (written: string[]) => Env;
    readonly posixOnly?: boolean;
  }

  const PRODUCTION_REFUSALS: readonly ProductionRefusal[] = [
    { name: 'unset', setting: () => ({}) },
    { name: 'empty', setting: () => ({ [HANDLE_SETTING]: '' }) },
    {
      name: 'naming a path with no file',
      setting: () => ({ [HANDLE_SETTING]: join(root, 'absent', 'handle-keys.json') }),
    },
    {
      name: 'a relative path',
      setting: () => ({ [HANDLE_SETTING]: 'HANDLEPATHMARK/handle-keys.json' }),
    },
    {
      name: 'a path through ..',
      setting: () => ({ [HANDLE_SETTING]: `${root}/x/../HANDLEPATHMARK.json` }),
    },
    {
      name: 'naming a file marked hosted-dev',
      setting: (written) => {
        const path = join(root, 'handle', 'handle-keys.json');
        written.push(writeHandleKeyFile(path, 'hosted-dev').k);
        return { [HANDLE_SETTING]: path };
      },
    },
    {
      name: 'naming a production file that group can read',
      setting: (written) => {
        const path = join(root, 'handle', 'handle-keys.json');
        written.push(writeHandleKeyFile(path, 'production', 0o640).k);
        return { [HANDLE_SETTING]: path };
      },
      posixOnly: true,
    },
  ];

  test.each(
    PRODUCTION_REFUSALS,
  )('production with the handle key setting $name is refused naming it and never its value, writing and listening on nothing acs-14.9', async ({
    setting,
    posixOnly = false,
  }) => {
    if (posixOnly && !POSIX) return;
    const dataDir = join(root, 'data');
    const port = await freePort();
    const written: string[] = [];
    const lines: string[] = [];
    const error = await startRefusal(productionEnv(dataDir, port, setting(written)), lines);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe(HANDLE_SETTING);
    const message = (error as ConfigError).message;
    expect(message).toContain(HANDLE_SETTING);
    expect(message).not.toContain('HANDLEPATHMARK');
    for (const k of written) {
      expect(message).not.toContain(k);
      expect(message).not.toContain(k.slice(0, 16));
    }
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(join(root, 'absent'))).toBe(false);
    expect(lines).toEqual([]);
    expect(await connectOutcome(port)).toBe('refused');
  });

  test('production with a valid handle key file goes on to the refusal of the profile, since this build holds no external signer acs-14.9', async () => {
    const dataDir = join(root, 'data');
    const handleFile = productionHandleKeyFile();
    const bytes = readFileSync(handleFile);
    const lines: string[] = [];
    const error = await startRefusal(
      productionEnv(dataDir, 0, { [HANDLE_SETTING]: handleFile }),
      lines,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe('MR_ACCOUNT_PROFILE');
    expect(readFileSync(handleFile).equals(bytes)).toBe(true);
    expect(existsSync(dataDir)).toBe(false);
    expect(lines).toEqual([]);
  });

  test('the entry file refuses a production env with no handle key setting: it exits 1 and names the setting on stderr acs-14.9', async () => {
    const dataDir = join(root, 'data');
    const proc = track(
      process.execPath,
      ['src/server.ts'],
      ACCOUNT_SERVICE_DIR,
      childEnv({
        MR_ACCOUNT_PROFILE: 'production',
        MR_ACCOUNT_ISSUER: 'https://accounts.example.com',
        MR_ACCOUNT_DATA_DIR: dataDir,
        MR_ACCOUNT_PORT: '0',
      }),
      false,
    );
    const result = await proc.exit;
    expect(result.error).toBeUndefined();
    expect(result.code, proc.output.stderr).toBe(1);
    expect(proc.output.stderr).toContain(HANDLE_SETTING);
    expect(proc.output.stdout).not.toContain('listening=');
    expect(existsSync(dataDir)).toBe(false);
  });
});

describe('a local-dev start whose handle key path is unusable', () => {
  test('a symbolic link at the handle key path that points at nothing refuses the start, naming the setting, writing and listening on nothing', async () => {
    if (!POSIX) return;
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    const target = join(dataDir, 'nowhere.json');
    const link = join(dataDir, HANDLE_KEY_FILE_NAME);
    symlinkSync(target, link);
    const port = await freePort();
    const lines: string[] = [];
    const error = await startRefusal(
      { ...localEnv(dataDir), MR_ACCOUNT_PORT: String(port) },
      lines,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe(HANDLE_SETTING);
    expect((error as ConfigError).message).toContain(HANDLE_SETTING);
    expect(readdirSync(dataDir)).toEqual([HANDLE_KEY_FILE_NAME]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(lines).toEqual([]);
    expect(await connectOutcome(port)).toBe('refused');
  });

  test('MR_ACCOUNT_HANDLE_KEY_FILE naming the default login key file refuses the start, naming the setting, writing and listening on nothing', async () => {
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    const port = await freePort();
    const lines: string[] = [];
    const error = await startRefusal(
      {
        ...localEnv(dataDir),
        MR_ACCOUNT_PORT: String(port),
        [HANDLE_SETTING]: join(dataDir, 'keys.json'),
      },
      lines,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe(HANDLE_SETTING);
    expect(readdirSync(dataDir)).toEqual([]);
    expect(lines).toEqual([]);
    expect(await connectOutcome(port)).toBe('refused');
  });

  test('MR_ACCOUNT_HANDLE_KEY_FILE naming a set login key file refuses the start and creates neither directory', async () => {
    const dataDir = join(root, 'data');
    const keyFile = join(root, 'keys-elsewhere', 'keys.json');
    const port = await freePort();
    const lines: string[] = [];
    const error = await startRefusal(
      {
        ...localEnv(dataDir),
        MR_ACCOUNT_PORT: String(port),
        MR_ACCOUNT_KEY_FILE: keyFile,
        [HANDLE_SETTING]: keyFile,
      },
      lines,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe(HANDLE_SETTING);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(dirname(keyFile))).toBe(false);
    expect(lines).toEqual([]);
    expect(await connectOutcome(port)).toBe('refused');
  });
});

// ---- the Steam ticket grant, served by startServer ----

const STEAM_GRANT = 'urn:monster-realm:steam-ticket';
const STEAM_IDENTITY = 'monster-realm-account';
const AUTHENTICATE_PATH = '/ISteamUserAuth/AuthenticateUserTicket/v1/';
const stubs: SteamStub[] = [];

afterEach(async () => {
  for (const stub of stubs.splice(0)) await stub.close();
});

/** A Steam fake for one test, closed after it. */
async function steamStub(): Promise<SteamStub> {
  const stub = await startSteamStub();
  stubs.push(stub);
  return stub;
}

/** A local-dev env with Steam as app 480 and the fake's key. */
function steamEnv(dataDir: string, stub: SteamStub, extra: Env = {}): Env {
  return {
    ...localEnv(dataDir),
    MR_STEAM_APP_ID: '480',
    MR_STEAM_WEB_API_KEY: stub.key,
    ...extra,
  };
}

/** `startServer` with the test's Steam fake as Steam's origin; the server is closed after the test. */
async function startWithSteam(
  env: Env,
  stub: SteamStub,
  lines: string[] = [],
): Promise<RunningServer> {
  const server = await startServer(
    env,
    (line) => {
      lines.push(line);
    },
    { steamBaseUrl: stub.url },
  );
  servers.push(server);
  return server;
}

interface SteamLocal {
  readonly stub: SteamStub;
  readonly port: number;
  readonly adminEnv: Env;
}

/**
 * A fresh Steam fake and a local-dev server that checks Steam as app 480 against it, with the
 * client made by the admin command. `extra` adds settings to the server's env.
 */
async function steamLocal(extra: Env = {}, lines: string[] = []): Promise<SteamLocal> {
  const dataDir = join(root, 'steam');
  const adminEnv: Env = { MR_ACCOUNT_PROFILE: 'local-dev', MR_ACCOUNT_DATA_DIR: dataDir };
  await admin(adminEnv, ['set-client', CLIENT_ID, REDIRECT_URI]);
  const stub = await steamStub();
  const server = await startWithSteam(steamEnv(dataDir, stub, extra), stub, lines);
  return { stub, port: portOf(server.url), adminEnv };
}

/** One exchange at the token endpoint: `headers` and `params` add to the request. */
function exchange(
  port: number,
  ticket: string,
  headers: Record<string, string> = {},
  params: Record<string, string> = {},
): Promise<FlowReply> {
  return flowSend(
    port,
    'POST',
    '/token',
    { host: LOCAL_HOST_HEADER, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    new URLSearchParams({
      grant_type: STEAM_GRANT,
      client_id: CLIENT_ID,
      steam_ticket: ticket,
      ...params,
    }).toString(),
  );
}

function forwardedFor(address: string): Record<string, string> {
  return { 'x-forwarded-for': address };
}

function setSteamEntitlement(
  adminEnv: Env,
  steamId: string,
  flag: 'entitled' | 'not-entitled',
): Promise<Map<string, string>> {
  return admin(adminEnv, ['set-entitlement', `steam:${steamId}`, flag]);
}

/** A ticket the fake never issued, of a live ticket's length in hex: Steam is asked and says no. */
function unissuedTicket(): string {
  return randomBytes(234).toString('hex');
}

/** The ID token of a `200` whose body is exactly `{ id_token, expires_in }`. */
function issuedIn(reply: FlowReply, name = ''): string {
  expect(reply.status, `${name} ${reply.body}`).toBe(200);
  const json = bodyOf(reply);
  expect(Object.keys(json).sort(), name).toEqual(['expires_in', 'id_token']);
  expect(json.expires_in, name).toBe(3600);
  expect(json.id_token, name).toEqual(expect.any(String));
  return json.id_token as string;
}

/** The refusal of a ticket: `400`, `invalid_grant` and a description, nothing else. */
function expectRefused(reply: FlowReply, name = ''): void {
  expect(reply.status, `${name} ${reply.body}`).toBe(400);
  const json = bodyOf(reply);
  expect(Object.keys(json).sort(), name).toEqual(['error', 'error_description']);
  expect(json.error, name).toBe('invalid_grant');
  expect(json.error_description, name).toEqual(expect.any(String));
}

/** An answer of the service that is no ticket refusal: `status`, an `error` not invalid_grant. */
function expectServiceRefusal(reply: FlowReply, status: number, name = ''): void {
  expect(reply.status, `${name} ${reply.body}`).toBe(status);
  const json = bodyOf(reply);
  expect(json.error, name).toEqual(expect.any(String));
  expect(json.error, name).not.toBe('invalid_grant');
  expect(json, name).not.toHaveProperty('id_token');
}

/** A `429` whose `retry-after` is whole seconds, at least 1 and at most the window. */
function expectLimited(reply: FlowReply, windowSeconds: number, name = ''): void {
  expectServiceRefusal(reply, 429, name);
  const retryAfter = String(reply.headers['retry-after']);
  expect(retryAfter, name).toMatch(/^[1-9][0-9]*$/);
  expect(Number(retryAfter), name).toBeLessThanOrEqual(windowSeconds);
}

/** Every header of an answer but `date`. */
function describingHeaders(reply: FlowReply): Record<string, unknown> {
  return Object.fromEntries(Object.entries(reply.headers).filter(([name]) => name !== 'date'));
}

async function discoveryWith(
  port: number,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const reply = await flowSend(port, 'GET', '/.well-known/openid-configuration', {
    host: LOCAL_HOST_HEADER,
    ...headers,
  });
  expect(reply.status, reply.body).toBe(200);
  return bodyOf(reply);
}

describe('the Steam ticket grant served by startServer', () => {
  test('a SteamID the admin command entitled exchanges a ticket for an ID token that verifies under /jwks, with exactly the named claims and sub steam:<id> acs-9.1', async () => {
    const local = await steamLocal();
    const steamId = '76561198000000001';
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    const ticket = local.stub.issueTicket(steamId, 'monster-realm-account');
    const reply = await exchange(local.port, ticket);
    const idToken = issuedIn(reply);
    expect(reply.headers['cache-control']).toBe('no-store');

    const served = await getJson(local.port, '/jwks', LOCAL_HOST_HEADER);
    expect(served.status).toBe(200);
    const verified = await jwtVerify(
      idToken,
      createLocalJWKSet(served.json as unknown as JSONWebKeySet),
      { issuer: 'http://localhost:4455', audience: CLIENT_ID, algorithms: ['ES256'] },
    );
    expect(Object.keys(verified.payload).sort()).toEqual([...ID_TOKEN_CLAIMS].sort());
    expect(verified.payload.sub).toBe('steam:76561198000000001');
    expect(verified.payload.iss).toBe('http://localhost:4455');
    expect(verified.payload.aud).toBe(CLIENT_ID);
    expect(verified.payload.mr_ent).toEqual(['base-game']);
    expect(verified.payload.exp! - verified.payload.iat!).toBe(3600);
    expect((served.json.keys as PublicKey[]).map((key) => key.kid)).toContain(
      verified.protectedHeader.kid,
    );

    // Steam is asked once, with the ticket as sent and the service's identity; a dev profile
    // never asks Steam about ownership.
    expect(local.stub.requests).toHaveLength(1);
    const [asked] = local.stub.requests;
    expect(asked!.path).toBe(AUTHENTICATE_PATH);
    expect(asked!.query.get('ticket')).toBe(ticket);
    expect(asked!.query.get('identity')).toBe('monster-realm-account');
  });

  test('a ticket in the other letter case is the same ticket and issues for the same sub acs-9.1', async () => {
    const local = await steamLocal();
    const steamId = '76561198000000002';
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    const ticket = local.stub.issueTicket(steamId, STEAM_IDENTITY);
    const upper = claimsOf(issuedIn(await exchange(local.port, ticket.toUpperCase())));
    expect(upper.sub).toBe('steam:76561198000000002');
  });

  test('no flag, a not-entitled flag, an entitled flag then denied, another identity, a ticket Steam never issued and one not hex all get one identical invalid_grant answer, and nothing is issued acs-9.2', async () => {
    const lines: string[] = [];
    const local = await steamLocal({}, lines);
    const noFlag = '76561198000000011';
    const notEntitled = '76561198000000012';
    const denied = '76561198000000013';
    const otherIdentity = '76561198000000014';
    await setSteamEntitlement(local.adminEnv, notEntitled, 'not-entitled');
    await setSteamEntitlement(local.adminEnv, denied, 'entitled');
    await admin(local.adminEnv, ['deny', `steam:${denied}`]);
    await setSteamEntitlement(local.adminEnv, otherIdentity, 'entitled');

    const causes: ReadonlyArray<readonly [string, string]> = [
      ['no flag', local.stub.issueTicket(noFlag, STEAM_IDENTITY)],
      ['flagged not-entitled', local.stub.issueTicket(notEntitled, STEAM_IDENTITY)],
      ['entitled and denied', local.stub.issueTicket(denied, STEAM_IDENTITY)],
      ['issued for another identity', local.stub.issueTicket(otherIdentity, 'another-identity')],
      ['never issued by Steam', unissuedTicket()],
      ['not hex', `${randomBytes(16).toString('hex')}zz`],
    ];
    const replies: FlowReply[] = [];
    for (const [name, ticket] of causes) {
      const reply = await exchange(local.port, ticket);
      expectRefused(reply, name);
      replies.push(reply);
    }
    const first = replies[0]!;
    for (const [index, reply] of replies.entries()) {
      const name = causes[index]![0];
      expect(reply.body, name).toBe(first.body);
      expect(describingHeaders(reply), name).toEqual(describingHeaders(first));
    }
    expect(lines).toHaveLength(1);

    // The control: the player refused for the identity is entitled, and its own ticket issues.
    const control = claimsOf(
      issuedIn(await exchange(local.port, local.stub.issueTicket(otherIdentity, STEAM_IDENTITY))),
    );
    expect(control.sub).toBe('steam:76561198000000014');
  });

  test('deny refuses at the next exchange and allow after it issues again, on the same ticket acs-9.2', async () => {
    const local = await steamLocal();
    const steamId = '76561198000000021';
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    const ticket = local.stub.issueTicket(steamId, STEAM_IDENTITY);
    issuedIn(await exchange(local.port, ticket), 'entitled');
    await admin(local.adminEnv, ['deny', `steam:${steamId}`]);
    expectRefused(await exchange(local.port, ticket), 'denied');
    await admin(local.adminEnv, ['allow', `steam:${steamId}`]);
    const allowed = claimsOf(issuedIn(await exchange(local.port, ticket), 'allowed'));
    expect(allowed.sub).toBe('steam:76561198000000021');
  });

  test('set-entitlement entitled after a refusal issues at the next exchange, and not-entitled refuses again acs-9.2', async () => {
    const local = await steamLocal();
    const steamId = '76561198000000022';
    const ticket = local.stub.issueTicket(steamId, STEAM_IDENTITY);
    expectRefused(await exchange(local.port, ticket), 'no flag');
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    const entitled = claimsOf(issuedIn(await exchange(local.port, ticket), 'entitled'));
    expect(entitled.sub).toBe('steam:76561198000000022');
    await setSteamEntitlement(local.adminEnv, steamId, 'not-entitled');
    expectRefused(await exchange(local.port, ticket), 'not-entitled');
  });

  test('a ticket that issued once is refused when Steam rejects it at the next exchange acs-9.2', async () => {
    const local = await steamLocal();
    const steamId = '76561198000000023';
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    const ticket = local.stub.issueTicket(steamId, STEAM_IDENTITY);
    issuedIn(await exchange(local.port, ticket));
    local.stub.respondNext('AuthenticateUserTicket', {
      kind: 'body',
      body: JSON.stringify({
        response: { error: { errorcode: 3, errordesc: 'Invalid parameter' } },
      }),
    });
    const before = local.stub.requests.length;
    expectRefused(await exchange(local.port, ticket));
    expect(local.stub.requests.length).toBe(before + 1);
  });

  test('with a trusted proxy the 61st exchange from one forwarded address is 429 with nothing sent to Steam, while another forwarded address is answered acs-9.3', async () => {
    const local = await steamLocal({ MR_ACCOUNT_TRUSTED_PROXY: '127.0.0.1' });
    const ticket = unissuedTicket();
    // The proxy appends the caller's address: the last entry is the source, whatever precedes it.
    for (let i = 0; i < 60; i += 1) {
      expectRefused(
        await exchange(local.port, ticket, forwardedFor(`198.51.100.${i}, 203.0.113.10`)),
        `exchange ${i + 1}`,
      );
    }
    expect(local.stub.requests).toHaveLength(60);
    expectLimited(
      await exchange(local.port, ticket, forwardedFor('198.51.100.200, 203.0.113.10')),
      60,
    );
    expectLimited(await exchange(local.port, unissuedTicket(), forwardedFor('203.0.113.10')), 60);
    expect(local.stub.requests).toHaveLength(60);

    const steamId = '76561198000000031';
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    const other = await exchange(
      local.port,
      local.stub.issueTicket(steamId, STEAM_IDENTITY),
      forwardedFor('203.0.113.20'),
    );
    expect(claimsOf(issuedIn(other)).sub).toBe('steam:76561198000000031');
    expect(local.stub.requests).toHaveLength(61);
  });

  test('with no trusted proxy a changed X-Forwarded-For does not escape the address window acs-9.3', async () => {
    const local = await steamLocal();
    const ticket = unissuedTicket();
    for (let i = 0; i < 60; i += 1) {
      expectRefused(
        await exchange(local.port, ticket, forwardedFor(`203.0.113.${i}`)),
        `exchange ${i + 1}`,
      );
    }
    expect(local.stub.requests).toHaveLength(60);
    expectLimited(await exchange(local.port, ticket, forwardedFor('203.0.113.250')), 60);
    expectLimited(await exchange(local.port, unissuedTicket()), 60);
    expect(local.stub.requests).toHaveLength(60);
  });

  test("the 31st exchange of one SteamID's ticket is 429 with nothing sent to Steam, from any address and in either letter case acs-9.3", async () => {
    const local = await steamLocal({ MR_ACCOUNT_TRUSTED_PROXY: '127.0.0.1' });
    const steamId = '76561198000000041';
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    const ticket = local.stub.issueTicket(steamId, STEAM_IDENTITY);
    for (let i = 0; i < 30; i += 1) {
      issuedIn(
        await exchange(local.port, ticket, forwardedFor(`203.0.113.${i}`)),
        `exchange ${i + 1}`,
      );
    }
    const sent = local.stub.requests.length;
    expectLimited(await exchange(local.port, ticket, forwardedFor('203.0.113.200')), 3600);
    expectLimited(
      await exchange(local.port, ticket.toUpperCase(), forwardedFor('203.0.113.201')),
      3600,
    );
    expect(local.stub.requests.length).toBe(sent);

    // The window is the SteamID's own: another player is still answered.
    const otherId = '76561198000000042';
    await setSteamEntitlement(local.adminEnv, otherId, 'entitled');
    const other = await exchange(
      local.port,
      local.stub.issueTicket(otherId, STEAM_IDENTITY),
      forwardedFor('203.0.113.202'),
    );
    expect(claimsOf(issuedIn(other)).sub).toBe('steam:76561198000000042');
  });

  test('thirty refusals of a player who is not entitled fill that SteamID window too, and a flag set after it does not reopen it acs-9.3', async () => {
    const local = await steamLocal();
    const steamId = '76561198000000043';
    const ticket = local.stub.issueTicket(steamId, STEAM_IDENTITY);
    for (let i = 0; i < 30; i += 1) {
      expectRefused(await exchange(local.port, ticket), `exchange ${i + 1}`);
    }
    const sent = local.stub.requests.length;
    expectLimited(await exchange(local.port, ticket), 3600);
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    expectLimited(await exchange(local.port, ticket), 3600);
    expect(local.stub.requests.length).toBe(sent);
  });

  test('tickets Steam never issued, sent with a steamid parameter naming a player, never spend that player window acs-9.3', async () => {
    const local = await steamLocal();
    const steamId = '76561198000000044';
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    for (let i = 0; i < 30; i += 1) {
      expectRefused(
        await exchange(local.port, unissuedTicket(), {}, { steamid: steamId }),
        `exchange ${i + 1}`,
      );
    }
    const real = await exchange(local.port, local.stub.issueTicket(steamId, STEAM_IDENTITY));
    expect(claimsOf(issuedIn(real)).sub).toBe('steam:76561198000000044');
  });

  test('35 parallel exchanges of one SteamID issue exactly 30 tokens and limit the other 5 acs-9.3', async () => {
    const local = await steamLocal();
    const steamId = '76561198000000045';
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    const ticket = local.stub.issueTicket(steamId, STEAM_IDENTITY);
    const replies = await Promise.all(
      Array.from({ length: 35 }, () => exchange(local.port, ticket)),
    );
    const issued = replies.filter((reply) => reply.status === 200);
    const limited = replies.filter((reply) => reply.status === 429);
    expect(issued).toHaveLength(30);
    expect(limited).toHaveLength(5);
    for (const reply of issued) issuedIn(reply);
    for (const reply of limited) expectLimited(reply, 3600);
  });

  test('without MR_STEAM_APP_ID the token endpoint answers unsupported_grant_type and discovery does not list the grant', async () => {
    const dataDir = join(root, 'data');
    await admin({ MR_ACCOUNT_PROFILE: 'local-dev', MR_ACCOUNT_DATA_DIR: dataDir }, [
      'set-client',
      CLIENT_ID,
      REDIRECT_URI,
    ]);
    const server = await start(localEnv(dataDir));
    const port = portOf(server.url);
    const reply = await exchange(port, unissuedTicket());
    expect(reply.status, reply.body).toBe(400);
    expect(bodyOf(reply).error).toBe('unsupported_grant_type');
    expect(bodyOf(reply)).not.toHaveProperty('id_token');
    const discovery = await discoveryWith(port);
    expect(discovery.grant_types_supported).toEqual(expect.any(Array));
    expect(discovery.grant_types_supported).not.toContain('urn:monster-realm:steam-ticket');
  });

  test('with Steam configured discovery lists the grant and names the issuer under forged forwarding headers', async () => {
    const local = await steamLocal({ MR_ACCOUNT_TRUSTED_PROXY: '127.0.0.1' });
    const plain = await discoveryWith(local.port);
    expect(plain.grant_types_supported).toContain('urn:monster-realm:steam-ticket');
    const forged = await discoveryWith(local.port, {
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.9',
    });
    expect(forged.issuer).toBe('http://localhost:4455');
    expect(forged.token_endpoint).toBe('http://localhost:4455/token');
    expect(forged.jwks_uri).toBe('http://localhost:4455/jwks');
    expect(forged.grant_types_supported).toContain('urn:monster-realm:steam-ticket');
  });

  test('MR_STEAM_APP_ID 480 with no Web API key starts and offers the grant, and every exchange answers 503 with nothing sent to Steam', async () => {
    const dataDir = join(root, 'steam');
    const adminEnv: Env = { MR_ACCOUNT_PROFILE: 'local-dev', MR_ACCOUNT_DATA_DIR: dataDir };
    await admin(adminEnv, ['set-client', CLIENT_ID, REDIRECT_URI]);
    const steamId = '76561198000000051';
    await setSteamEntitlement(adminEnv, steamId, 'entitled');
    const stub = await steamStub();
    const server = await startWithSteam({ ...localEnv(dataDir), MR_STEAM_APP_ID: '480' }, stub);
    const port = portOf(server.url);
    expect((await discoveryWith(port)).grant_types_supported).toContain(
      'urn:monster-realm:steam-ticket',
    );
    expectServiceRefusal(await exchange(port, stub.issueTicket(steamId, STEAM_IDENTITY)), 503);
    expectServiceRefusal(await exchange(port, unissuedTicket()), 503);
    expect(stub.requests).toHaveLength(0);
  });

  test('a Web API key with a space refuses the start naming MR_STEAM_WEB_API_KEY and never its value, writing and listening on nothing', async () => {
    const dataDir = join(root, 'steam');
    const stub = await steamStub();
    const parts = [randomBytes(12).toString('hex'), randomBytes(12).toString('hex')];
    const spaced = parts.join(' ');
    const port = await freePort();
    const lines: string[] = [];
    let error: unknown;
    try {
      await startWithSteam(
        {
          ...localEnv(dataDir),
          MR_ACCOUNT_PORT: String(port),
          MR_STEAM_APP_ID: '480',
          MR_STEAM_WEB_API_KEY: spaced,
        },
        stub,
        lines,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).setting).toBe('MR_STEAM_WEB_API_KEY');
    for (const part of parts) expect((error as ConfigError).message).not.toContain(part);
    expect(existsSync(dataDir)).toBe(false);
    expect(lines).toEqual([]);
    expect(await connectOutcome(port)).toBe('refused');
    expect(stub.requests).toHaveLength(0);
  });

  test('across a run that issues, refuses, fails and limits, the log holds the start line, one line with the sub and time per token, one Steam failure line, and no ticket, key or address', async () => {
    const lines: string[] = [];
    const local = await steamLocal({ MR_ACCOUNT_TRUSTED_PROXY: '127.0.0.1' }, lines);
    const from = forwardedFor('203.0.113.77');
    const startedAt = Math.floor(Date.now() / 1000);
    const steamId = '76561198000000061';
    const notEntitled = '76561198000000062';
    await setSteamEntitlement(local.adminEnv, steamId, 'entitled');
    const ticket = local.stub.issueTicket(steamId, STEAM_IDENTITY);
    const unissued = unissuedTicket();
    const notEntitledTicket = local.stub.issueTicket(notEntitled, STEAM_IDENTITY);
    const otherIdentityTicket = local.stub.issueTicket(steamId, 'another-identity');

    local.stub.respondNext('AuthenticateUserTicket', { kind: 'status', status: 500 });
    expectServiceRefusal(await exchange(local.port, ticket, from), 503, 'Steam failed');
    const idTokens: string[] = [];
    idTokens.push(issuedIn(await exchange(local.port, ticket.toUpperCase(), from)));
    for (let i = 1; i < 30; i += 1) {
      idTokens.push(issuedIn(await exchange(local.port, ticket, from), `exchange ${i + 1}`));
    }
    expectRefused(await exchange(local.port, unissued, from), 'never issued');
    expectRefused(await exchange(local.port, notEntitledTicket, from), 'not entitled');
    expectRefused(await exchange(local.port, otherIdentityTicket, from), 'another identity');
    expectLimited(await exchange(local.port, ticket, from), 3600);
    const endedAt = Math.floor(Date.now() / 1000);

    expect(START_LINE.exec(lines[0] ?? ''), lines[0]).not.toBeNull();
    const after = lines.slice(1);
    const tokenLines = after.filter((line) => line.includes('steam:76561198000000061'));
    expect(tokenLines).toHaveLength(30);
    expect(after).toHaveLength(31);
    for (const line of tokenLines) {
      const time = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.exec(line);
      expect(time, line).not.toBeNull();
      const seconds = Date.parse(time![0]) / 1000;
      expect(seconds, line).toBeGreaterThanOrEqual(startedAt);
      expect(seconds, line).toBeLessThanOrEqual(endedAt);
    }

    const tickets = [ticket, unissued, notEntitledTicket, otherIdentityTicket];
    const secrets = [
      local.stub.key,
      '203.0.113.77',
      ...tickets.flatMap((t) => [t, t.toUpperCase(), t.slice(0, 32), t.slice(0, 32).toUpperCase()]),
      ...idTokens.map((token) => token.split('.')[2] ?? token),
    ];
    for (const line of lines) {
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
    // The start line names the address the server listens on; every line after it is checked.
    for (const line of after) expect(line).not.toContain('127.0.0.1');
  });
});

// ---- the entitlement decision startServer wires for the grant ----

const PRODUCTION_APP_ID = 2_000_000;
const OWNERSHIP_PATH = '/ISteamUser/CheckAppOwnership/v4/';
const ENTITLED_PLAYER = parseSteamId('76561198000000101')!;
const LENDER = parseSteamId('76561198000000102')!;

interface EntitlementRig {
  readonly stub: SteamStub;
  readonly decide: (steamId: SteamId) => Promise<unknown>;
  readonly deny: ReturnType<typeof denyList>;
  readonly accounts: ReturnType<typeof steamAccounts>;
}

describe('the entitlement decision startServer wires for the grant', () => {
  const stores: AccountStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  /** A Steam fake answering as a game of its own, and a production client of it. */
  async function productionSteam() {
    const stub = await startSteamStub({ appId: PRODUCTION_APP_ID });
    stubs.push(stub);
    const steam = createSteamWebApi({
      config: { profile: 'production', steam: { appId: PRODUCTION_APP_ID } },
      env: { MR_STEAM_PUBLISHER_KEY: stub.key },
      log: () => undefined,
      baseUrl: stub.url,
    });
    return { stub, steam };
  }

  /** A Steam fake answering as app 480, and a client of it under a dev profile. */
  async function devSteam(profile: 'local-dev' | 'hosted-dev') {
    const stub = await startSteamStub();
    stubs.push(stub);
    const steam = createSteamWebApi({
      config: { profile, steam: { appId: 480 } },
      env: { MR_STEAM_WEB_API_KEY: stub.key },
      log: () => undefined,
      baseUrl: stub.url,
    });
    return { stub, steam };
  }

  function rigOf(
    profile: 'local-dev' | 'hosted-dev' | 'production',
    steam: { readonly stub: SteamStub; readonly steam: ReturnType<typeof createSteamWebApi> },
  ): EntitlementRig {
    const store = openAccountStore(':memory:');
    stores.push(store);
    return {
      stub: steam.stub,
      decide: steamEntitlement(profile, store.adapter, steam.steam),
      deny: denyList(store.adapter),
      accounts: steamAccounts(store.adapter),
    };
  }

  function ownershipAsks(rig: EntitlementRig): string[] {
    return rig.stub.requests
      .filter((sent) => sent.path === OWNERSHIP_PATH)
      .map((sent) => sent.query.get('steamid') ?? '');
  }

  function owns(steamId: SteamId, holder: SteamId = steamId) {
    return { ownsapp: true, permanent: true, sitelicense: false, ownersteamid: holder };
  }

  test('on production a player flagged entitled whom Steam reports not owning the game is not entitled', async () => {
    const rig = rigOf('production', await productionSteam());
    await rig.accounts.setEntitled(ENTITLED_PLAYER, true);
    expect(await rig.decide(ENTITLED_PLAYER)).toEqual({ entitled: false, reason: 'not-owned' });
    expect(ownershipAsks(rig)).toEqual([ENTITLED_PLAYER]);
  });

  test('on production a player with no flag whom Steam reports owning the game is entitled', async () => {
    const rig = rigOf('production', await productionSteam());
    rig.stub.setOwnership(ENTITLED_PLAYER, owns(ENTITLED_PLAYER));
    expect(await rig.decide(ENTITLED_PLAYER)).toEqual({ entitled: true });
    expect(ownershipAsks(rig)).toEqual([ENTITLED_PLAYER]);
  });

  test('on production a borrowed licence is not entitled, a flag set entitled beside it', async () => {
    const rig = rigOf('production', await productionSteam());
    await rig.accounts.setEntitled(ENTITLED_PLAYER, true);
    rig.stub.setOwnership(ENTITLED_PLAYER, owns(ENTITLED_PLAYER, LENDER));
    expect(await rig.decide(ENTITLED_PLAYER)).toEqual({ entitled: false, reason: 'not-owned' });
    expect(ownershipAsks(rig)).toEqual([ENTITLED_PLAYER]);
  });

  test('on production a player on the deny-list whom Steam reports owning the game is denied and Steam is not asked', async () => {
    const rig = rigOf('production', await productionSteam());
    rig.stub.setOwnership(ENTITLED_PLAYER, owns(ENTITLED_PLAYER));
    await rig.deny.add(ENTITLED_PLAYER);
    expect(await rig.decide(ENTITLED_PLAYER)).toEqual({ entitled: false, reason: 'denied' });
    expect(ownershipAsks(rig)).toEqual([]);
  });

  test('on production Steam failing to answer is unavailable, a flag set entitled beside it', async () => {
    const rig = rigOf('production', await productionSteam());
    await rig.accounts.setEntitled(ENTITLED_PLAYER, true);
    rig.stub.setOwnership(ENTITLED_PLAYER, owns(ENTITLED_PLAYER));
    rig.stub.respondNext('CheckAppOwnership', { kind: 'status', status: 500 });
    const decision = await rig.decide(ENTITLED_PLAYER);
    expect(decision).toMatchObject({ entitled: false, reason: 'unavailable' });
    expect((decision as { readonly error?: unknown }).error).toBeInstanceOf(Error);
    expect(ownershipAsks(rig)).toEqual([ENTITLED_PLAYER]);
  });

  const DEV_PROFILES = ['local-dev', 'hosted-dev'] as const;

  test.each(DEV_PROFILES)('on %s a player flagged entitled is entitled', async (profile) => {
    const rig = rigOf(profile, await devSteam(profile));
    await rig.accounts.setEntitled(ENTITLED_PLAYER, true);
    expect(await rig.decide(ENTITLED_PLAYER)).toEqual({ entitled: true });
    expect(ownershipAsks(rig)).toEqual([]);
  });

  // A Steam client that can ask, and a fake that answers "owns it": only the flag may decide.
  test.each(
    DEV_PROFILES,
  )('on %s the flag decides and no CheckAppOwnership request is sent, whatever Steam would answer', async (profile) => {
    const rig = rigOf(profile, await productionSteam());
    rig.stub.setOwnership(ENTITLED_PLAYER, owns(ENTITLED_PLAYER));
    expect(await rig.decide(ENTITLED_PLAYER)).toEqual({ entitled: false, reason: 'not-owned' });
    await rig.accounts.setEntitled(ENTITLED_PLAYER, false);
    expect(await rig.decide(ENTITLED_PLAYER)).toEqual({ entitled: false, reason: 'not-owned' });
    await rig.accounts.setEntitled(ENTITLED_PLAYER, true);
    rig.stub.setOwnership(ENTITLED_PLAYER, owns(ENTITLED_PLAYER, LENDER));
    expect(await rig.decide(ENTITLED_PLAYER)).toEqual({ entitled: true });
    expect(ownershipAsks(rig)).toEqual([]);
  });

  test.each(DEV_PROFILES)('on %s the deny-list wins over a flag set entitled', async (profile) => {
    const rig = rigOf(profile, await devSteam(profile));
    await rig.accounts.setEntitled(ENTITLED_PLAYER, true);
    await rig.deny.add(ENTITLED_PLAYER);
    expect(await rig.decide(ENTITLED_PLAYER)).toEqual({ entitled: false, reason: 'denied' });
    expect(ownershipAsks(rig)).toEqual([]);
  });
});
