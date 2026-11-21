import { spawn } from 'node:child_process';
import { argon2Sync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../config.ts';
import { devPasswordStep } from '../interactions/devPassword.ts';
import { openAccountStore } from '../store/sqliteAdapter.ts';
import { runAdmin } from './cli.ts';

const ACCOUNT_SERVICE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POSIX = process.platform !== 'win32';
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const PASSWORD_SHAPE = /^[A-Za-z0-9_-]{24}$/;
const SUB_SHAPE = /^dev:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINE = /^([a-z_]+)=(.*)$/;

type Env = Record<string, string | undefined>;

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

interface Row {
  readonly model: string;
  readonly id: string;
  readonly payload: string;
  readonly expires_at: number | null;
}

let root = '';
let dataDir = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acs2-'));
  dataDir = join(root, 'data');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function localEnv(): Env {
  return { MR_ACCOUNT_PROFILE: 'local-dev', MR_ACCOUNT_DATA_DIR: dataDir };
}

function databasePath(): string {
  return join(dataDir, 'account.sqlite');
}

async function admin(argv: readonly string[], env: Env = localEnv()): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdmin(argv, env, {
    out(line) {
      out.push(line);
    },
    err(line) {
      err.push(line);
    },
  });
  return { code, out, err };
}

/** The `name=value` lines of `out`, each name once. */
function fields(lines: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    const match = LINE.exec(line);
    expect(match, `a name=value line: ${line}`).not.toBeNull();
    expect(map.has(match![1]!), `${match![1]} printed twice`).toBe(false);
    map.set(match![1]!, match![2]!);
  }
  return map;
}

function rows(model?: string): Row[] {
  if (!existsSync(databasePath())) return [];
  const db = new DatabaseSync(databasePath(), { readOnly: true });
  try {
    const all = db
      .prepare('SELECT model, id, payload, expires_at FROM oidc_record ORDER BY model, id')
      .all() as unknown as Row[];
    return model === undefined ? all : all.filter((row) => row.model === model);
  } finally {
    db.close();
  }
}

function recomputes(hash: string, password: string): boolean {
  const match = PHC.exec(hash);
  if (match === null) return false;
  const again = argon2Sync('argon2id', {
    message: Buffer.from(password),
    nonce: Buffer.from(match[4]!, 'base64'),
    parallelism: Number(match[3]),
    tagLength: 32,
    memory: Number(match[1]),
    passes: Number(match[2]),
  });
  return again.equals(Buffer.from(match[5]!, 'base64'));
}

function filesHolding(dir: string, secret: string): string[] {
  if (!existsSync(dir)) return [];
  const needle = Buffer.from(secret, 'utf8');
  return readdirSync(dir).filter((name) => readFileSync(join(dir, name)).includes(needle));
}

/** Signs in through the real password step on the database the command wrote. */
async function attempt(email: string, password: string): Promise<{ kind: string; sub?: string }> {
  const store = openAccountStore(databasePath());
  try {
    return await devPasswordStep(store.adapter).attempt(email, password);
  } finally {
    store.close();
  }
}

async function createAccount(email: string, ...flags: string[]): Promise<Map<string, string>> {
  const run = await admin(['create-account', email, ...flags]);
  expect(run.code, run.err.join('\n')).toBe(0);
  return fields(run.out);
}

describe('create-account', () => {
  test('prints the account and a generated password once, and stores only its argon2id hash acs-2.6', async () => {
    const run = await admin(['create-account', 'Player@Example.COM']);
    expect(run.code, run.err.join('\n')).toBe(0);
    const out = fields(run.out);
    expect([...out.keys()].sort()).toEqual(['email', 'entitled', 'password', 'sub']);
    expect(out.get('email')).toBe('player@example.com');
    expect(out.get('entitled')).toBe('true');
    expect(out.get('sub')).toMatch(SUB_SHAPE);
    const password = out.get('password')!;
    expect(password).toMatch(PASSWORD_SHAPE);
    expect(run.out.filter((line) => line.includes(password))).toEqual([`password=${password}`]);
    for (const line of run.err) expect(line).not.toContain(password);

    const accounts = rows('DevAccount');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.id).toBe('player@example.com');
    const payload = JSON.parse(accounts[0]!.payload) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['email', 'entitled', 'passwordHash', 'uid']);
    expect(payload.uid).toBe(out.get('sub'));
    expect(payload.entitled).toBe(true);
    const hash = payload.passwordHash as string;
    expect(PHC.exec(hash)?.slice(1, 4)).toEqual(['19456', '2', '1']);
    expect(recomputes(hash, password)).toBe(true);

    for (const row of rows()) expect(`${row.id}${row.payload}`).not.toContain(password);
    expect(filesHolding(dataDir, password)).toEqual([]);
  });

  test('the printed password signs in through the password step on the same database acs-2.6', async () => {
    const out = await createAccount('player@example.com');
    expect(await attempt('player@example.com', out.get('password')!)).toEqual({
      kind: 'signed-in',
      sub: out.get('sub'),
    });
    expect((await attempt('player@example.com', 'not-the-password')).kind).toBe('refused');
  });

  test('--not-entitled makes an account that signs in as not-owned', async () => {
    const out = await createAccount('player@example.com', '--not-entitled');
    expect(out.get('entitled')).toBe('false');
    expect(out.get('password')).toMatch(PASSWORD_SHAPE);
    expect(await attempt('player@example.com', out.get('password')!)).toEqual({
      kind: 'not-owned',
    });
  });

  test('creates the data directory owner-only and the database 0600', async () => {
    expect(existsSync(dataDir)).toBe(false);
    await createAccount('player@example.com');
    expect(existsSync(databasePath())).toBe(true);
    if (!POSIX) return;
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath()).mode & 0o777).toBe(0o600);
    for (const name of readdirSync(dataDir)) {
      expect(statSync(join(dataDir, name)).mode & 0o077, name).toBe(0);
    }
  });

  test('a second create of the same email, in any case, exits 1 and leaves the first account as it was acs-2.6', async () => {
    const first = await createAccount('player@example.com');
    const before = rows('DevAccount');
    for (const spelling of ['player@example.com', 'PLAYER@example.com']) {
      const again = await admin(['create-account', spelling, '--not-entitled']);
      expect(again.code, spelling).toBe(1);
      expect(again.out).toEqual([]);
      expect(again.err).toHaveLength(1);
    }
    expect(rows('DevAccount')).toEqual(before);
    expect((await attempt('player@example.com', first.get('password')!)).kind).toBe('signed-in');
  });

  test('an invalid email exits 1 with one line and stores no account', async () => {
    for (const email of ['not-an-email', 'a b@example.com', '@example.com']) {
      const run = await admin(['create-account', email]);
      expect(run.code, email).toBe(1);
      expect(run.out).toEqual([]);
      expect(run.err).toHaveLength(1);
    }
    expect(rows('DevAccount')).toEqual([]);
  });
});

describe('reset-password', () => {
  test('keeps the subject and flag, prints a new password, and stores only its hash acs-2.6', async () => {
    const first = await createAccount('player@example.com', '--not-entitled');
    const run = await admin(['reset-password', 'Player@example.com']);
    expect(run.code, run.err.join('\n')).toBe(0);
    const out = fields(run.out);
    expect([...out.keys()].sort()).toEqual(['email', 'entitled', 'password', 'sub']);
    expect(out.get('sub')).toBe(first.get('sub'));
    expect(out.get('email')).toBe('player@example.com');
    expect(out.get('entitled')).toBe('false');
    const password = out.get('password')!;
    expect(password).toMatch(PASSWORD_SHAPE);
    expect(password).not.toBe(first.get('password'));
    for (const line of run.err) expect(line).not.toContain(password);

    const payload = JSON.parse(rows('DevAccount')[0]!.payload) as Record<string, unknown>;
    expect(payload.uid).toBe(first.get('sub'));
    expect(payload.entitled).toBe(false);
    expect(recomputes(payload.passwordHash as string, password)).toBe(true);
    expect(recomputes(payload.passwordHash as string, first.get('password')!)).toBe(false);
    for (const secret of [password, first.get('password')!]) {
      expect(filesHolding(dataDir, secret)).toEqual([]);
    }

    expect((await attempt('player@example.com', password)).kind).toBe('not-owned');
    expect((await attempt('player@example.com', first.get('password')!)).kind).toBe('refused');
  });

  test('an email with no account exits 1 and creates none', async () => {
    await createAccount('player@example.com');
    const run = await admin(['reset-password', 'nobody@example.com']);
    expect(run.code).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toHaveLength(1);
    expect(rows('DevAccount').map((row) => row.id)).toEqual(['player@example.com']);
  });
});

describe('set-entitlement', () => {
  test('turns the flag off and on, printing the account without a password', async () => {
    const first = await createAccount('player@example.com');
    const password = first.get('password')!;

    const off = await admin(['set-entitlement', 'PLAYER@example.com', 'not-entitled']);
    expect(off.code, off.err.join('\n')).toBe(0);
    const offOut = fields(off.out);
    expect([...offOut.keys()].sort()).toEqual(['email', 'entitled', 'sub']);
    expect(offOut.get('sub')).toBe(first.get('sub'));
    expect(offOut.get('email')).toBe('player@example.com');
    expect(offOut.get('entitled')).toBe('false');
    expect((await attempt('player@example.com', password)).kind).toBe('not-owned');

    const on = await admin(['set-entitlement', 'player@example.com', 'entitled']);
    expect(on.code, on.err.join('\n')).toBe(0);
    expect(fields(on.out).get('entitled')).toBe('true');
    expect(await attempt('player@example.com', password)).toEqual({
      kind: 'signed-in',
      sub: first.get('sub'),
    });
  });

  test('an email with no account exits 1 and creates none', async () => {
    const run = await admin(['set-entitlement', 'nobody@example.com', 'entitled']);
    expect(run.code).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toHaveLength(1);
    expect(rows('DevAccount')).toEqual([]);
  });
});

describe('set-client', () => {
  test('stores the client with its one redirect address and prints both', async () => {
    const run = await admin(['set-client', 'monster-realm', 'http://localhost:5290/']);
    expect(run.code, run.err.join('\n')).toBe(0);
    const out = fields(run.out);
    expect([...out.keys()].sort()).toEqual(['client', 'redirect_uri']);
    expect(out.get('client')).toBe('monster-realm');
    expect(out.get('redirect_uri')).toBe('http://localhost:5290/');
    const clients = rows('Client');
    expect(clients.map((row) => row.id)).toEqual(['monster-realm']);
    expect(JSON.parse(clients[0]!.payload)).toEqual({ redirectUri: 'http://localhost:5290/' });
    expect(clients[0]!.expires_at).toBeNull();
  });

  test('a second set-client replaces the redirect address', async () => {
    expect((await admin(['set-client', 'monster-realm', 'http://localhost:5290/'])).code).toBe(0);
    expect((await admin(['set-client', 'monster-realm', 'http://localhost:5391/'])).code).toBe(0);
    const clients = rows('Client');
    expect(clients).toHaveLength(1);
    expect(JSON.parse(clients[0]!.payload)).toEqual({ redirectUri: 'http://localhost:5391/' });
  });

  test.each([
    ['an address without its path', 'monster-realm', 'http://localhost:5290'],
    ['plain http to a remote host', 'monster-realm', 'http://game.example.com/'],
    ['a fragment', 'monster-realm', 'http://localhost:5290/#'],
    ['a user in the address', 'monster-realm', 'https://user@game.example.com/'],
    ['a javascript address', 'monster-realm', 'javascript:alert(1)'],
    ['a client id with a space', 'monster realm', 'http://localhost:5290/'],
    ['a client id of 65 characters', 'a'.repeat(65), 'http://localhost:5290/'],
  ])('%s exits 1 with one line and stores no client', async (_name, clientId, redirectUri) => {
    const run = await admin(['set-client', clientId, redirectUri]);
    expect(run.code).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toHaveLength(1);
    expect(rows('Client')).toEqual([]);
  });
});

describe('usage', () => {
  test.each([
    ['no command', []],
    ['an unknown command', ['delete-account', 'player@example.com']],
    ['create-account without an email', ['create-account']],
    ['create-account with an extra argument', ['create-account', 'player@example.com', 'extra']],
    ['create-account with an unknown flag', ['create-account', 'player@example.com', '--admin']],
    [
      'create-account given a password',
      ['create-account', 'player@example.com', '--password', 'hunter2hunter2'],
    ],
    ['reset-password without an email', ['reset-password']],
    ['reset-password with two emails', ['reset-password', 'a@example.com', 'b@example.com']],
    ['set-entitlement without its value', ['set-entitlement', 'player@example.com']],
    [
      'set-entitlement with an extra argument',
      ['set-entitlement', 'player@example.com', 'entitled', 'extra'],
    ],
    ['set-client without an address', ['set-client', 'monster-realm']],
    [
      'set-client with an extra argument',
      ['set-client', 'monster-realm', 'http://localhost:5290/', 'extra'],
    ],
  ])('%s exits 2 with usage on err, nothing on out, and nothing created', async (_name, argv) => {
    const run = await admin(argv);
    expect(run.code).toBe(2);
    expect(run.out).toEqual([]);
    expect(run.err.length).toBeGreaterThan(0);
    expect(run.err.join('\n')).not.toContain('hunter2hunter2');
    expect(existsSync(dataDir)).toBe(false);
  });
});

describe('the production profile', () => {
  const commands: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['create-account', ['create-account', 'player@example.com']],
    ['reset-password', ['reset-password', 'player@example.com']],
    ['set-entitlement', ['set-entitlement', 'player@example.com', 'entitled']],
    ['set-client', ['set-client', 'monster-realm', 'https://game.example.com/']],
  ];
  const envs: ReadonlyArray<readonly [string, (dir: string) => Env]> = [
    [
      'valid production settings',
      (dir) => ({
        MR_ACCOUNT_PROFILE: 'production',
        MR_ACCOUNT_ISSUER: 'https://accounts.example.com',
        MR_ACCOUNT_DATA_DIR: dir,
      }),
    ],
    ['only the profile', () => ({ MR_ACCOUNT_PROFILE: 'production' })],
    [
      'settings that loadConfig would refuse under another name',
      (dir) => ({
        MR_ACCOUNT_PROFILE: 'production',
        MR_ACCOUNT_DATA_DIR: dir,
        MR_ACCOUNT_SIGN_IN: 'dev-password',
        MR_ACCOUNT_KEY_FILE: join(dir, 'keys.json'),
        MR_ACCOUNT_BOGUS: 'x',
      }),
    ],
  ];
  const cases = commands.flatMap(([command, argv]) =>
    envs.map(([envName, build]) => [command, envName, argv, build] as const),
  );

  test.each(
    cases,
  )('%s with %s exits 1 naming MR_ACCOUNT_PROFILE and creates nothing acs-2.6', async (_command, _envName, argv, build) => {
    const absent = join(root, 'absent');
    const run = await admin(argv, build(join(absent, 'data')));
    expect(run.code).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toHaveLength(1);
    expect(run.err[0]).toContain('MR_ACCOUNT_PROFILE');
    expect(existsSync(absent)).toBe(false);
  });
});

describe('configuration errors', () => {
  test.each([
    ['a relative data directory', { MR_ACCOUNT_PROFILE: 'local-dev', MR_ACCOUNT_DATA_DIR: 'data' }],
    ['an unknown profile', { MR_ACCOUNT_PROFILE: 'staging' }],
    ['no profile', {}],
  ])('%s exits 1 with the ConfigError message as its one line', async (_name, env: Env) => {
    let expected = '';
    try {
      loadConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expected = (error as ConfigError).message;
    }
    expect(expected).not.toBe('');
    const run = await admin(['create-account', 'player@example.com'], env);
    expect(run.code).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toHaveLength(1);
    expect(run.err[0]).toContain(expected);
  });

  test('an unknown setting exits 1 naming it and creates nothing', async () => {
    const env = { ...localEnv(), MR_ACCOUNT_DATADIR: dataDir };
    const run = await admin(['create-account', 'player@example.com'], env);
    expect(run.code).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toHaveLength(1);
    expect(run.err[0]).toContain('MR_ACCOUNT_DATADIR');
    expect(existsSync(dataDir)).toBe(false);
  });
});

describe('the entry file, as a process', () => {
  function run(
    args: string[],
    env: Env,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, ['src/admin/cli.ts', ...args], {
        cwd: ACCOUNT_SERVICE_DIR,
        // Never spread process.env: a developer's own MR_* variables must not change the result.
        env: { PATH: process.env.PATH, HOME: process.env.HOME ?? root, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('close', (code) => {
        resolveRun({ code, stdout, stderr });
      });
    });
  }

  test('create-account run with node prints the account on stdout, exits 0, and the password signs in acs-2.6', async () => {
    const result = await run(['create-account', 'spawned@example.com'], localEnv());
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    const out = fields(lines);
    expect([...out.keys()].sort()).toEqual(['email', 'entitled', 'password', 'sub']);
    expect(out.get('email')).toBe('spawned@example.com');
    const password = out.get('password')!;
    expect(password).toMatch(PASSWORD_SHAPE);
    expect(filesHolding(dataDir, password)).toEqual([]);
    expect(await attempt('spawned@example.com', password)).toEqual({
      kind: 'signed-in',
      sub: out.get('sub'),
    });
  });

  test('the production profile run with node exits 1 naming MR_ACCOUNT_PROFILE on stderr acs-2.6', async () => {
    const absent = join(root, 'absent');
    const result = await run(['create-account', 'spawned@example.com'], {
      MR_ACCOUNT_PROFILE: 'production',
      MR_ACCOUNT_ISSUER: 'https://accounts.example.com',
      MR_ACCOUNT_DATA_DIR: join(absent, 'data'),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('MR_ACCOUNT_PROFILE');
    expect(existsSync(absent)).toBe(false);
  });

  test('a usage error run with node exits 2 with nothing on stdout', async () => {
    const result = await run([], localEnv());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
    expect(existsSync(dataDir)).toBe(false);
  });
});
