import { argon2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AdapterPayload } from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { devSubject } from '../claims.ts';
import { createRateLimiter, type RateLimiter } from '../rateLimit.ts';
import { type AccountStore, openAccountStore } from '../store/sqliteAdapter.ts';
import {
  DevAccountError,
  devAccounts,
  devPasswordStep,
  hashPassword,
  MAX_CONCURRENT_HASHES,
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  PASSWORD_FAILURE_LIMIT,
  PASSWORD_FAILURE_WINDOW_SECONDS,
  verifyPassword,
} from './devPassword.ts';

type Step = ReturnType<typeof devPasswordStep>;
type Outcome = Awaited<ReturnType<Step['attempt']>>;
type Verify = (hash: string, password: string) => Promise<boolean>;

// Non-ASCII built from code points, never pasted.
const FULLWIDTH_PLAYER = String.fromCharCode(0xff30, 0xff2c, 0xff21, 0xff39, 0xff25, 0xff32);
const FULLWIDTH_AT = String.fromCharCode(0xff20);
const FI_LIGATURE = String.fromCharCode(0xfb01);
const DRAGON = String.fromCodePoint(0x1f409);
const CROCODILE = String.fromCodePoint(0x1f40a);
const E_ACUTE = String.fromCharCode(0x00e9);
const E_GRAVE = String.fromCharCode(0x00e8);
const CONTROL_SOH = String.fromCharCode(0x01);
const CONTROL_DEL = String.fromCharCode(0x7f);
const CONTROL_NEL = String.fromCharCode(0x85);
const NBSP = String.fromCharCode(0x00a0);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const PASSWORD_SHAPE = /^[A-Za-z0-9_-]{24}$/;

const T0 = 1_800_000_000;
let t = T0;
const now = (): number => t;

const stores: AccountStore[] = [];
const dirs: string[] = [];

beforeEach(() => {
  t = T0;
});

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryStore(): AccountStore {
  const store = openAccountStore(':memory:');
  stores.push(store);
  return store;
}

function fileStore(): { store: AccountStore; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'acs2-'));
  dirs.push(dir);
  const path = join(dir, 'account.sqlite');
  const store = openAccountStore(path);
  stores.push(store);
  return { store, dir, path };
}

function limiter(): RateLimiter {
  return createRateLimiter({ limit: 5, windowSeconds: 600, now });
}

function counting(inner: Verify = verifyPassword): {
  verify: Verify;
  calls: Array<readonly [string, string]>;
} {
  const calls: Array<readonly [string, string]> = [];
  return {
    calls,
    verify: (hash, password) => {
      calls.push([hash, password]);
      return inner(hash, password);
    },
  };
}

interface Pending {
  readonly hash: string;
  readonly password: string;
  readonly resolve: (value: boolean) => void;
  readonly reject: (error: Error) => void;
}

function blocking(): { verify: Verify; pending: Pending[] } {
  const pending: Pending[] = [];
  return {
    pending,
    verify: (hash, password) =>
      new Promise<boolean>((resolve, reject) => {
        pending.push({ hash, password, resolve, reject });
      }),
  };
}

/** Lets queued promise work and I/O callbacks run; returns no result of its own. */
async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function unpadded(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

function phc(options: {
  readonly alg?: string;
  readonly v?: number;
  readonly m: number;
  readonly t: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly tag: Buffer;
}): string {
  const { alg = 'argon2id', v = 19, m, t: passes, p, salt, tag } = options;
  return `$${alg}$v=${v}$m=${m},t=${passes},p=${p}$${unpadded(salt)}$${unpadded(tag)}`;
}

function hashOwn(password: string, m: number, passes: number, p: number): string {
  const salt = randomBytes(16);
  const tag = argon2Sync('argon2id', {
    message: Buffer.from(password),
    nonce: salt,
    parallelism: p,
    tagLength: 32,
    memory: m,
    passes,
  });
  return phc({ m, t: passes, p, salt, tag });
}

/** Recomputes the PHC string's tag from `password` with node:crypto, under the string's own parameters. */
function recomputes(hash: string, password: string): boolean {
  const match = PHC.exec(hash);
  if (match === null) return false;
  const tag = Buffer.from(match[5]!, 'base64');
  const again = argon2Sync('argon2id', {
    message: Buffer.from(password),
    nonce: Buffer.from(match[4]!, 'base64'),
    parallelism: Number(match[3]),
    tagLength: 32,
    memory: Number(match[1]),
    passes: Number(match[2]),
  });
  return again.equals(tag);
}

function expectServiceHashShape(hash: string): void {
  const match = PHC.exec(hash);
  expect(match, hash).not.toBeNull();
  expect([match![1], match![2], match![3]]).toEqual(['19456', '2', '1']);
  expect(match![4]).toHaveLength(22);
  expect(Buffer.from(match![4]!, 'base64')).toHaveLength(16);
  expect(match![5]).toHaveLength(43);
  expect(Buffer.from(match![5]!, 'base64')).toHaveLength(32);
}

async function storedPayload(
  store: AccountStore,
  email: string,
): Promise<Record<string, unknown> | undefined> {
  const found = (await store.adapter('DevAccount').find(email)) as AdapterPayload | undefined;
  return found === undefined ? undefined : (found as unknown as Record<string, unknown>);
}

async function reasonOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DevAccountError) return error.reason;
    return `not a DevAccountError: ${String(error)}`;
  }
  return undefined;
}

interface Row {
  readonly model: string;
  readonly id: string;
  readonly payload: string;
  readonly expires_at: number | null;
  readonly uid: string | null;
}

/** Every row the store wrote, read back from its database file. */
function rows(path: string): Row[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare('SELECT model, id, payload, expires_at, uid FROM oidc_record ORDER BY model, id')
      .all() as unknown as Row[];
  } finally {
    db.close();
  }
}

function filesHolding(dir: string, secret: string): string[] {
  const needle = Buffer.from(secret, 'utf8');
  return readdirSync(dir).filter((name) => readFileSync(join(dir, name)).includes(needle));
}

describe('the limits', () => {
  test('five failures in ten minutes is the password lock acs-2.3', () => {
    expect(PASSWORD_FAILURE_LIMIT).toBe(5);
    expect(PASSWORD_FAILURE_WINDOW_SECONDS).toBe(600);
  });

  test('the field and concurrency limits are the contract numbers', () => {
    expect(MAX_EMAIL_LENGTH).toBe(254);
    expect(MAX_PASSWORD_LENGTH).toBe(128);
    expect(MAX_CONCURRENT_HASHES).toBe(4);
  });
});

describe('hashPassword and verifyPassword', () => {
  test('a hash is argon2id in PHC form that node:crypto recomputes from the password acs-2.6', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expectServiceHashShape(hash);
    expect(recomputes(hash, 'correct horse battery staple')).toBe(true);
    expect(recomputes(hash, 'correct horse battery stapl')).toBe(false);
    expect(hash).not.toContain('correct horse');
  });

  test('two hashes of one password differ in salt and tag acs-2.6', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    expect(PHC.exec(a)![4]).not.toBe(PHC.exec(b)![4]);
    expect(recomputes(a, 'same')).toBe(true);
    expect(recomputes(b, 'same')).toBe(true);
  });

  test('verifyPassword accepts the password and refuses any other', async () => {
    const hash = await hashPassword('Secret-1');
    await expect(verifyPassword(hash, 'Secret-1')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'secret-1')).resolves.toBe(false);
    await expect(verifyPassword(hash, 'Secret-1 ')).resolves.toBe(false);
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });

  test('verifyPassword recomputes under the parameters the string carries', async () => {
    const small = hashOwn('pw', 1024, 1, 1);
    await expect(verifyPassword(small, 'pw')).resolves.toBe(true);
    await expect(verifyPassword(small, 'px')).resolves.toBe(false);
    // The largest parameters allowed, one at a time, still verify.
    await expect(verifyPassword(hashOwn('pw', 65536, 1, 1), 'pw')).resolves.toBe(true);
    await expect(verifyPassword(hashOwn('pw', 1024, 10, 1), 'pw')).resolves.toBe(true);
    await expect(verifyPassword(hashOwn('pw', 1024, 1, 4), 'pw')).resolves.toBe(true);
  });

  test('a string it cannot accept is false, never a throw', async () => {
    const salt = randomBytes(16);
    const tag = argon2Sync('argon2id', {
      message: Buffer.from('pw'),
      nonce: salt,
      parallelism: 1,
      tagLength: 32,
      memory: 1024,
      passes: 1,
    });
    const good = phc({ m: 1024, t: 1, p: 1, salt, tag });
    await expect(verifyPassword(good, 'pw')).resolves.toBe(true);
    const bad = [
      '',
      'garbage',
      '$argon2id$',
      phc({ alg: 'argon2i', m: 1024, t: 1, p: 1, salt, tag }),
      phc({ alg: 'argon2d', m: 1024, t: 1, p: 1, salt, tag }),
      phc({ v: 16, m: 1024, t: 1, p: 1, salt, tag }),
      phc({ m: 65537, t: 1, p: 1, salt, tag }),
      phc({ m: 1024, t: 11, p: 1, salt, tag }),
      phc({ m: 1024, t: 1, p: 5, salt, tag }),
      phc({ m: 1024, t: 1, p: 1, salt: salt.subarray(0, 15), tag }),
      phc({ m: 1024, t: 1, p: 1, salt: Buffer.concat([salt, Buffer.from([0])]), tag }),
      phc({ m: 1024, t: 1, p: 1, salt, tag: tag.subarray(0, 31) }),
      phc({ m: 1024, t: 1, p: 1, salt, tag: Buffer.concat([tag, Buffer.from([0])]) }),
      `${good}$`,
      good.replace('m=1024', 'm=abc'),
      good.replace('m=1024', 'm=-1'),
      good.replace(',t=1', ''),
      `$argon2id$v=19$m=1024,t=1,p=1$${salt.toString('base64')}$${tag.toString('base64')}x`,
    ];
    for (const hash of bad) {
      await expect(verifyPassword(hash, 'pw'), hash).resolves.toBe(false);
    }
  });
});

describe('hash rule edges', () => {
  test('a correctly computed hash over the parameter ceiling is refused acs-2.6', async () => {
    for (const hash of [
      hashOwn('pw', 65537, 1, 1),
      hashOwn('pw', 1024, 11, 1),
      hashOwn('pw', 1024, 1, 5),
    ]) {
      expect(recomputes(hash, 'pw'), hash).toBe(true);
      await expect(verifyPassword(hash, 'pw'), hash).resolves.toBe(false);
    }
  });

  test('the whole of a long password is hashed: a change past character 72 or at the end is refused acs-2.6', async () => {
    const changeAt = (password: string, index: number): string =>
      `${password.slice(0, index)}${password[index] === 'X' ? 'Y' : 'X'}${password.slice(index + 1)}`;

    const long = 'abcdefghij'.repeat(10);
    expect(long).toHaveLength(100);
    const hash = await hashPassword(long);
    expect(recomputes(hash, long)).toBe(true);
    await expect(verifyPassword(hash, long)).resolves.toBe(true);
    for (const other of [changeAt(long, 99), changeAt(long, 72), long.slice(0, 72)]) {
      expect(other).not.toBe(long);
      await expect(verifyPassword(hash, other), other).resolves.toBe(false);
    }

    const longest = 'abcdefgh'.repeat(MAX_PASSWORD_LENGTH / 8);
    expect(longest).toHaveLength(128);
    const longestHash = await hashPassword(longest);
    await expect(verifyPassword(longestHash, longest)).resolves.toBe(true);
    await expect(verifyPassword(longestHash, changeAt(longest, 127))).resolves.toBe(false);
  });

  test('a password is hashed as its UTF-8 bytes: a non-ASCII character counts as itself acs-2.6', async () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      [`caf${E_ACUTE}-password`, `caf${E_GRAVE}-password`],
      [`dragon-${DRAGON}-password`, `dragon-${CROCODILE}-password`],
    ];
    for (const [password, other] of pairs) {
      const hash = await hashPassword(password);
      expectServiceHashShape(hash);
      expect(recomputes(hash, password), password).toBe(true); // argon2Sync over Buffer.from(password, 'utf8')
      await expect(verifyPassword(hash, password), password).resolves.toBe(true);
      await expect(verifyPassword(hash, other), other).resolves.toBe(false);
    }
  });

  test('a tag that differs from the true one in its last or a middle byte is refused acs-2.6', async () => {
    const salt = randomBytes(16);
    const tag = argon2Sync('argon2id', {
      message: Buffer.from('pw'),
      nonce: salt,
      parallelism: 1,
      tagLength: 32,
      memory: 1024,
      passes: 1,
    });
    const altered = (index: number): Buffer => {
      const copy = Buffer.from(tag);
      copy[index] = copy[index]! ^ 0x01;
      return copy;
    };
    await expect(verifyPassword(phc({ m: 1024, t: 1, p: 1, salt, tag }), 'pw')).resolves.toBe(true);
    for (const index of [31, 16]) {
      const forged = phc({ m: 1024, t: 1, p: 1, salt, tag: altered(index) });
      await expect(verifyPassword(forged, 'pw'), `byte ${index}`).resolves.toBe(false);
    }
  });
});

describe('devAccounts', () => {
  test('create stores only the hash of a generated password, under the normalised email acs-2.6', async () => {
    const { store, dir, path } = fileStore();
    const { account, password } = await devAccounts(store.adapter).create('Player@Example.COM', {
      entitled: true,
    });
    expect(password).toMatch(PASSWORD_SHAPE);
    expect(account.email).toBe('player@example.com');
    expect(account.entitled).toBe(true);
    expect(account.sub.startsWith('dev:')).toBe(true);
    expect(account.sub.slice(4)).toMatch(UUID);
    expect(account.sub).toBe(devSubject(account.sub.slice(4)));

    const all = rows(path);
    expect(all).toHaveLength(1);
    const row = all[0]!;
    expect(row.model).toBe('DevAccount');
    expect(row.id).toBe('player@example.com');
    expect(row.expires_at).toBeNull();
    expect(row.uid).toBe(account.sub);
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['email', 'entitled', 'passwordHash', 'uid']);
    expect(payload.uid).toBe(account.sub);
    expect(payload.email).toBe('player@example.com');
    expect(payload.entitled).toBe(true);
    expectServiceHashShape(payload.passwordHash as string);
    expect(recomputes(payload.passwordHash as string, password)).toBe(true);

    for (const r of all) expect(`${r.id}${r.payload}`).not.toContain(password);
    expect(filesHolding(dir, password)).toEqual([]);
  });

  test('every account gets its own subject and its own password', async () => {
    const accounts = devAccounts(memoryStore().adapter);
    const a = await accounts.create('a@example.com', { entitled: true });
    const b = await accounts.create('b@example.com', { entitled: false });
    expect(a.account.sub).not.toBe(b.account.sub);
    expect(a.password).not.toBe(b.password);
    expect(b.account.entitled).toBe(false);
    expect(b.password).toMatch(PASSWORD_SHAPE);
  });

  test('find answers by the normalised email, by case and by NFKC', async () => {
    const accounts = devAccounts(memoryStore().adapter);
    const { account } = await accounts.create('player@example.com', { entitled: true });
    expect(await accounts.find('PLAYER@EXAMPLE.COM')).toEqual(account);
    expect(await accounts.find(`${FULLWIDTH_PLAYER}@example.com`)).toEqual(account);
    expect(await accounts.find(`player${FULLWIDTH_AT}example.com`)).toEqual(account);
    expect(await accounts.find('someone@example.com')).toBeUndefined();
  });

  test('create refuses an email that already has an account, in any spelling, and changes nothing acs-2.6', async () => {
    const store = memoryStore();
    const accounts = devAccounts(store.adapter);
    const first = await accounts.create('player@example.com', { entitled: true });
    const before = await storedPayload(store, 'player@example.com');
    for (const spelling of [
      'player@example.com',
      'Player@Example.com',
      `${FULLWIDTH_PLAYER}@example.com`,
    ]) {
      expect(await reasonOf(() => accounts.create(spelling, { entitled: false })), spelling).toBe(
        'exists',
      );
    }
    expect(await storedPayload(store, 'player@example.com')).toEqual(before);
    expect(await accounts.find('player@example.com')).toEqual(first.account);
  });

  test('the NFKC form is the stored id: a fullwidth create is found in ASCII', async () => {
    const store = memoryStore();
    const accounts = devAccounts(store.adapter);
    const { account } = await accounts.create(`${FULLWIDTH_PLAYER}${FULLWIDTH_AT}Example.com`, {
      entitled: true,
    });
    expect(account.email).toBe('player@example.com');
    expect(await storedPayload(store, 'player@example.com')).toBeDefined();
    expect(await accounts.find('player@example.com')).toEqual(account);
  });

  const atLimit = `${'a'.repeat(254 - '@b.cd'.length)}@b.cd`;
  const ligatures = (count: number): string => `${FI_LIGATURE.repeat(count)}@b.cd`;

  test('the shortest and longest emails are accepted, the longest counted after normalising', async () => {
    const accounts = devAccounts(memoryStore().adapter);
    expect(atLimit).toHaveLength(254);
    for (const email of ['a@b', atLimit, ligatures(124)]) {
      expect(
        await reasonOf(() => accounts.create(email, { entitled: true })),
        email,
      ).toBeUndefined();
    }
    const expanded = `${'fi'.repeat(124)}@b.cd`;
    expect((await accounts.find(expanded))?.email).toBe(expanded);
    expect((await accounts.find(ligatures(124)))?.email).toBe(expanded);
  });

  test.each([
    ['empty', ''],
    ['two characters', 'a@'],
    ['no at sign', 'player.example.com'],
    ['nothing before the at', '@example.com'],
    ['nothing after the at', 'player@'],
    ['two at signs', 'a@b@example.com'],
    ['a space', 'pla yer@example.com'],
    ['a tab', 'player\t@example.com'],
    ['a no-break space', `player${NBSP}@example.com`],
    ['a control character', `pla${CONTROL_SOH}yer@example.com`],
    ['a DEL', `player@example.com${CONTROL_DEL}`],
    ['a C1 control', `player${CONTROL_NEL}@example.com`],
    ['255 code units', `a${atLimit}`],
    ['255 code units only after NFKC', ligatures(125)],
  ])('an email with %s is invalid everywhere and stores nothing', async (_name, email) => {
    const store = memoryStore();
    const accounts = devAccounts(store.adapter);
    expect(await reasonOf(() => accounts.create(email, { entitled: true }))).toBe('invalid-email');
    expect(await reasonOf(() => accounts.resetPassword(email))).toBe('invalid-email');
    expect(await reasonOf(() => accounts.setEntitled(email, true))).toBe('invalid-email');
    await expect(accounts.find(email)).resolves.toBeUndefined();
    const step = devPasswordStep(store.adapter, { failures: limiter() });
    expect((await step.attempt(email, 'anything')).kind).toBe('refused');
  });

  test('a DevAccountError is an Error carrying its reason', async () => {
    const accounts = devAccounts(memoryStore().adapter);
    let caught: unknown;
    try {
      await accounts.setEntitled('nobody@example.com', true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DevAccountError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as DevAccountError).reason).toBe('unknown');
  });

  test('resetPassword keeps the subject and flag, stores only the new hash, and the old password stops working acs-2.6', async () => {
    const { store, dir, path } = fileStore();
    const accounts = devAccounts(store.adapter);
    const created = await accounts.create('player@example.com', { entitled: false });
    const reset = await accounts.resetPassword('PLAYER@example.com');
    expect(reset.account).toEqual(created.account);
    expect(reset.password).toMatch(PASSWORD_SHAPE);
    expect(reset.password).not.toBe(created.password);

    const payload = await storedPayload(store, 'player@example.com');
    expect(Object.keys(payload ?? {}).sort()).toEqual(['email', 'entitled', 'passwordHash', 'uid']);
    expect(payload?.uid).toBe(created.account.sub);
    expect(payload?.entitled).toBe(false);
    expectServiceHashShape(payload?.passwordHash as string);
    expect(recomputes(payload?.passwordHash as string, reset.password)).toBe(true);
    expect(recomputes(payload?.passwordHash as string, created.password)).toBe(false);

    for (const secret of [created.password, reset.password]) {
      for (const r of rows(path)) expect(`${r.id}${r.payload}`).not.toContain(secret);
      expect(filesHolding(dir, secret)).toEqual([]);
    }

    await accounts.setEntitled('player@example.com', true);
    const step = devPasswordStep(store.adapter, { failures: limiter() });
    expect(await step.attempt('player@example.com', created.password)).toEqual({ kind: 'refused' });
    expect(await step.attempt('player@example.com', reset.password)).toEqual({
      kind: 'signed-in',
      sub: created.account.sub,
    });
  });

  test('resetPassword and setEntitled refuse an email with no account and create none', async () => {
    const store = memoryStore();
    const accounts = devAccounts(store.adapter);
    expect(await reasonOf(() => accounts.resetPassword('nobody@example.com'))).toBe('unknown');
    expect(await reasonOf(() => accounts.setEntitled('nobody@example.com', true))).toBe('unknown');
    expect(await accounts.find('nobody@example.com')).toBeUndefined();
    expect(await storedPayload(store, 'nobody@example.com')).toBeUndefined();
  });

  test('setEntitled changes only the flag', async () => {
    const store = memoryStore();
    const accounts = devAccounts(store.adapter);
    const { account } = await accounts.create('player@example.com', { entitled: true });
    const before = await storedPayload(store, 'player@example.com');
    const off = await accounts.setEntitled('Player@Example.com', false);
    expect(off).toEqual({ ...account, entitled: false });
    expect(await storedPayload(store, 'player@example.com')).toEqual({
      ...before,
      entitled: false,
    });
    const on = await accounts.setEntitled('player@example.com', true);
    expect(on).toEqual(account);
    expect(await storedPayload(store, 'player@example.com')).toEqual(before);
  });
});

describe('the password step: account(sub)', () => {
  test('answers the account behind a subject, afresh after its flag changes, and nothing for others', async () => {
    const store = memoryStore();
    const accounts = devAccounts(store.adapter);
    const { account } = await accounts.create('player@example.com', { entitled: true });
    await accounts.create('other@example.com', { entitled: false });
    const step = devPasswordStep(store.adapter, { failures: limiter() });

    const found = await step.account(account.sub);
    expect(found?.sub).toBe(account.sub);
    expect(found?.entitled).toBe(true);

    await accounts.setEntitled('player@example.com', false);
    const after = await step.account(account.sub);
    expect(after?.sub).toBe(account.sub);
    expect(after?.entitled).toBe(false);

    expect(await step.account(devSubject(randomUUID()))).toBeUndefined();
    expect(await step.account('player@example.com')).toBeUndefined();
    expect(await step.account('')).toBeUndefined();
  });
});

describe('the password step: attempt', () => {
  test('the right password of an entitled account signs in with one hash, against its stored hash acs-2.3', async () => {
    const store = memoryStore();
    const { account, password } = await devAccounts(store.adapter).create('player@example.com', {
      entitled: true,
    });
    const hash = (await storedPayload(store, 'player@example.com'))?.passwordHash;
    const { verify, calls } = counting();
    const failures = limiter();
    const step = devPasswordStep(store.adapter, { failures, verifyPassword: verify });
    expect(await step.attempt('Player@Example.com', password)).toEqual({
      kind: 'signed-in',
      sub: account.sub,
    });
    expect(calls).toEqual([[hash, password]]);
    expect(failures.size).toBe(0); // the slot was given back
  });

  test('the right password of an account without entitlement is not-owned, and gives its slot back', async () => {
    const store = memoryStore();
    const { password } = await devAccounts(store.adapter).create('player@example.com', {
      entitled: false,
    });
    const { verify, calls } = counting();
    const failures = limiter();
    const step = devPasswordStep(store.adapter, { failures, verifyPassword: verify });
    expect(await step.attempt('player@example.com', password)).toEqual({ kind: 'not-owned' });
    expect(calls).toHaveLength(1);
    expect(failures.size).toBe(0);
  });

  test('a wrong password is refused with one hash and keeps its slot acs-2.3', async () => {
    const store = memoryStore();
    await devAccounts(store.adapter).create('player@example.com', { entitled: true });
    const { verify, calls } = counting();
    const failures = limiter();
    const step = devPasswordStep(store.adapter, { failures, verifyPassword: verify });
    expect(await step.attempt('player@example.com', 'wrong-password')).toEqual({ kind: 'refused' });
    expect(calls).toHaveLength(1);
    expect(failures.size).toBe(1);
  });

  test('an unknown email costs one hash of the same parameters, made once for the step acs-2.3', async () => {
    const store = memoryStore();
    await devAccounts(store.adapter).create('player@example.com', { entitled: true });
    const accountHash = (await storedPayload(store, 'player@example.com'))?.passwordHash;
    const { verify, calls } = counting();
    const failures = limiter();
    const step = devPasswordStep(store.adapter, { failures, verifyPassword: verify });
    expect(await step.attempt('nobody@example.com', 'anything')).toEqual({ kind: 'refused' });
    expect(await step.attempt('else@example.com', 'something')).toEqual({ kind: 'refused' });
    expect(calls).toHaveLength(2);
    expectServiceHashShape(calls[0]![0]);
    expect(calls[1]![0]).toBe(calls[0]![0]);
    expect(calls[0]![0]).not.toBe(accountHash);
    expect(calls.map(([, password]) => password)).toEqual(['anything', 'something']);
    expect(failures.size).toBe(2);
  });

  test.each([
    ['an invalid email', 'not-an-email', 'password'],
    ['an empty password', 'player@example.com', ''],
    ['a password of 129 code units', 'player@example.com', 'x'.repeat(129)],
    ['a password of 65 astral characters', 'player@example.com', DRAGON.repeat(65)],
  ])('%s is refused with nothing counted and no hash computed acs-2.3', async (_name, email, password) => {
    const store = memoryStore();
    const created = await devAccounts(store.adapter).create('player@example.com', {
      entitled: true,
    });
    const { verify, calls } = counting();
    const failures = limiter();
    const step = devPasswordStep(store.adapter, { failures, verifyPassword: verify });
    for (let i = 0; i < 10; i += 1) {
      expect(await step.attempt(email, password)).toEqual({ kind: 'refused' });
    }
    expect(calls).toEqual([]);
    expect(failures.size).toBe(0);
    expect((await step.attempt('player@example.com', created.password)).kind).toBe('signed-in');
  });

  test('a password of exactly 128 code units is evaluated', async () => {
    const store = memoryStore();
    await devAccounts(store.adapter).create('player@example.com', { entitled: true });
    const { verify, calls } = counting();
    const step = devPasswordStep(store.adapter, { failures: limiter(), verifyPassword: verify });
    expect(await step.attempt('player@example.com', 'x'.repeat(128))).toEqual({ kind: 'refused' });
    expect(await step.attempt('player@example.com', DRAGON.repeat(64))).toEqual({
      kind: 'refused',
    });
    expect(calls).toHaveLength(2);
  });

  test('five wrong passwords lock the email, the right one included, until ten minutes after the first acs-2.3', async () => {
    const store = memoryStore();
    const { account, password } = await devAccounts(store.adapter).create('player@example.com', {
      entitled: true,
    });
    const { verify, calls } = counting();
    const step = devPasswordStep(store.adapter, { failures: limiter(), verifyPassword: verify });
    const answers: Outcome[] = [];
    for (let i = 0; i < 5; i += 1) {
      t = T0 + i * 10;
      answers.push(await step.attempt('player@example.com', `wrong-${i}`));
    }
    t = T0 + 50;
    answers.push(await step.attempt('player@example.com', 'wrong-5'));
    t = T0 + 60;
    answers.push(await step.attempt('player@example.com', password));
    t = T0 + 599;
    answers.push(await step.attempt('player@example.com', password));
    expect(answers.map((a) => a.kind)).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'locked',
      'locked',
      'locked',
    ]);
    expect(calls).toHaveLength(5); // nothing is hashed while locked

    t = T0 + 600; // ten minutes after the first failure
    expect(await step.attempt('player@example.com', password)).toEqual({
      kind: 'signed-in',
      sub: account.sub,
    });
    expect(calls).toHaveLength(6);
  });

  test('the lock is per normalised email: other spellings are locked, other accounts are not acs-2.3', async () => {
    const store = memoryStore();
    const accounts = devAccounts(store.adapter);
    const player = await accounts.create('player@example.com', { entitled: true });
    const other = await accounts.create('other@example.com', { entitled: true });
    const step = devPasswordStep(store.adapter, { failures: limiter() });
    const spellings = [
      'player@example.com',
      'PLAYER@example.com',
      `${FULLWIDTH_PLAYER}@example.com`,
      'Player@Example.Com',
      `player${FULLWIDTH_AT}example.com`,
    ];
    for (const spelling of spellings) {
      expect((await step.attempt(spelling, 'wrong')).kind, spelling).toBe('refused');
    }
    expect((await step.attempt('player@example.com', player.password)).kind).toBe('locked');
    expect((await step.attempt('PLAYER@EXAMPLE.COM', player.password)).kind).toBe('locked');
    expect(await step.attempt('other@example.com', other.password)).toEqual({
      kind: 'signed-in',
      sub: other.account.sub,
    });
  });

  test('an email with no account goes through exactly the same answers as a wrong password acs-2.3', async () => {
    // The same script for both emails; `right` is the password of player@example.com, so for
    // the email with no account it is just another wrong password.
    async function script(email: string): Promise<{ kinds: string[]; hashes: number }> {
      t = T0;
      const store = memoryStore();
      const { password: right } = await devAccounts(store.adapter).create('player@example.com', {
        entitled: true,
      });
      const { verify, calls } = counting();
      const step = devPasswordStep(store.adapter, { failures: limiter(), verifyPassword: verify });
      const kinds: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        t = T0 + i;
        kinds.push((await step.attempt(email, `wrong-${i}`)).kind);
      }
      t = T0 + 10;
      kinds.push((await step.attempt(email, right)).kind);
      t = T0 + 599;
      kinds.push((await step.attempt(email, 'wrong-again')).kind);
      t = T0 + 600;
      kinds.push((await step.attempt(email, 'wrong-later')).kind);
      kinds.push((await step.attempt(email, 'wrong-last')).kind);
      return { kinds, hashes: calls.length };
    }
    const known = await script('player@example.com');
    const unknown = await script('nobody@example.com');
    expect(unknown).toEqual(known);
    expect(known.kinds).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'locked',
      'locked',
      'locked',
      'refused',
      'locked',
    ]);
    expect(known.hashes).toBe(6);
  });

  test('a right password does not use up a slot: four wrong, one right, then the fifth wrong is still refused acs-2.3', async () => {
    for (const entitled of [true, false]) {
      const store = memoryStore();
      const { password } = await devAccounts(store.adapter).create('player@example.com', {
        entitled,
      });
      const step = devPasswordStep(store.adapter, { failures: limiter() });
      const kinds: string[] = [];
      for (let i = 0; i < 4; i += 1)
        kinds.push((await step.attempt('player@example.com', 'bad')).kind);
      kinds.push((await step.attempt('player@example.com', password)).kind);
      kinds.push((await step.attempt('player@example.com', 'bad')).kind);
      kinds.push((await step.attempt('player@example.com', 'bad')).kind);
      expect(kinds, `entitled=${entitled}`).toEqual([
        'refused',
        'refused',
        'refused',
        'refused',
        entitled ? 'signed-in' : 'not-owned',
        'refused',
        'locked',
      ]);
    }
  });

  test('a verifyPassword that rejects makes the attempt reject with its slot still taken acs-2.3', async () => {
    const store = memoryStore();
    await devAccounts(store.adapter).create('player@example.com', { entitled: true });
    let calls = 0;
    const failing: Verify = () => {
      calls += 1;
      return Promise.reject(new Error('hash pool failed'));
    };
    const failures = limiter();
    const step = devPasswordStep(store.adapter, { failures, verifyPassword: failing });
    for (let i = 0; i < 5; i += 1) {
      await expect(step.attempt('player@example.com', 'whatever')).rejects.toThrow();
    }
    expect(calls).toBe(5);
    expect(failures.size).toBe(1);
    expect(await step.attempt('player@example.com', 'whatever')).toEqual({ kind: 'locked' });
    expect(calls).toBe(5);
  });

  test('with MAX_CONCURRENT_HASHES attempts inside verifyPassword the next is busy, uncounted and unhashed acs-2.3', async () => {
    const store = memoryStore();
    const { password } = await devAccounts(store.adapter).create('player@example.com', {
      entitled: true,
    });
    const { verify, pending } = blocking();
    const failures = limiter();
    const step = devPasswordStep(store.adapter, { failures, verifyPassword: verify });
    const inFlight = Array.from({ length: MAX_CONCURRENT_HASHES }, (_, i) =>
      step.attempt(`waiting-${i}@example.com`, 'pw'),
    );
    await settle();
    expect(pending).toHaveLength(MAX_CONCURRENT_HASHES);
    expect(failures.size).toBe(MAX_CONCURRENT_HASHES);

    expect(await step.attempt('player@example.com', password)).toEqual({ kind: 'busy' });
    expect(await step.attempt('busy@example.com', 'pw')).toEqual({ kind: 'busy' });
    expect(pending).toHaveLength(MAX_CONCURRENT_HASHES);
    expect(failures.size).toBe(MAX_CONCURRENT_HASHES); // neither busy email was counted

    pending[0]!.resolve(false);
    expect(await inFlight[0]).toEqual({ kind: 'refused' });
    const next = step.attempt('player@example.com', password);
    await settle();
    expect(pending).toHaveLength(MAX_CONCURRENT_HASHES + 1);
    pending[MAX_CONCURRENT_HASHES]!.resolve(true);
    expect((await next).kind).toBe('signed-in');

    for (const p of pending.slice(1, MAX_CONCURRENT_HASHES)) p.resolve(false);
    expect((await Promise.all(inFlight)).map((o) => o.kind)).toEqual(
      Array.from({ length: MAX_CONCURRENT_HASHES }, () => 'refused'),
    );
  });

  test('ten attempts fired at once for ten emails put exactly MAX_CONCURRENT_HASHES into verifyPassword acs-2.3', async () => {
    const store = memoryStore();
    const { verify, pending } = blocking();
    const failures = limiter();
    const step = devPasswordStep(store.adapter, { failures, verifyPassword: verify });
    const kinds: string[] = [];
    const all = Array.from({ length: 10 }, (_, i) =>
      step.attempt(`burst-${i}@example.com`, 'pw').then((outcome) => {
        kinds.push(outcome.kind);
        return outcome;
      }),
    );
    await settle();
    expect(pending).toHaveLength(MAX_CONCURRENT_HASHES);
    expect(kinds).toEqual(Array.from({ length: 10 - MAX_CONCURRENT_HASHES }, () => 'busy'));
    expect(failures.size).toBe(MAX_CONCURRENT_HASHES);
    for (const p of pending) p.resolve(false);
    const outcomes = await Promise.all(all);
    expect(outcomes.filter((o) => o.kind === 'refused')).toHaveLength(MAX_CONCURRENT_HASHES);
    expect(outcomes.filter((o) => o.kind === 'busy')).toHaveLength(10 - MAX_CONCURRENT_HASHES);
  });

  test('a hash that rejects frees its concurrency slot', async () => {
    const store = memoryStore();
    const { verify, pending } = blocking();
    const step = devPasswordStep(store.adapter, { failures: limiter(), verifyPassword: verify });
    const inFlight = Array.from({ length: MAX_CONCURRENT_HASHES }, (_, i) =>
      step.attempt(`w-${i}@example.com`, 'pw'),
    );
    const settled = Promise.allSettled(inFlight); // handles every rejection from the start
    await settle();
    expect(pending).toHaveLength(MAX_CONCURRENT_HASHES);
    for (const p of pending) p.reject(new Error('boom'));
    expect((await settled).map((result) => result.status)).toEqual(
      Array.from({ length: MAX_CONCURRENT_HASHES }, () => 'rejected'),
    );
    const after = step.attempt('later@example.com', 'pw');
    await settle();
    expect(pending).toHaveLength(MAX_CONCURRENT_HASHES + 1);
    pending[MAX_CONCURRENT_HASHES]!.resolve(false);
    expect(await after).toEqual({ kind: 'refused' });
  });

  test('twenty attempts fired at once for one email compute at most five hashes acs-2.3', async () => {
    const store = memoryStore();
    await devAccounts(store.adapter).create('player@example.com', { entitled: true });
    const later: Verify = () =>
      new Promise<boolean>((resolve) => {
        setImmediate(() => {
          resolve(false);
        });
      });
    const { verify, calls } = counting(later);
    const step = devPasswordStep(store.adapter, { failures: limiter(), verifyPassword: verify });
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => step.attempt('player@example.com', 'guess')),
    );
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(outcomes.filter((o) => o.kind === 'refused')).toHaveLength(calls.length);
    for (const outcome of outcomes) expect(['refused', 'locked', 'busy']).toContain(outcome.kind);
  });

  test('a slot is taken before the hash: parallel guesses never exceed the limiter even below the hash ceiling acs-2.3', async () => {
    const store = memoryStore();
    await devAccounts(store.adapter).create('player@example.com', { entitled: true });
    const later: Verify = () =>
      new Promise<boolean>((resolve) => {
        setImmediate(() => {
          resolve(false);
        });
      });
    const { verify, calls } = counting(later);
    const failures = createRateLimiter({ limit: 2, windowSeconds: 600, now });
    const step = devPasswordStep(store.adapter, { failures, verifyPassword: verify });
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => step.attempt('player@example.com', 'guess')),
    );
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(outcomes.filter((o) => o.kind === 'refused')).toHaveLength(calls.length);
    expect(outcomes.some((o) => o.kind === 'locked')).toBe(true);
  });

  test('without injected deps the step locks five failures on the wall clock for ten minutes acs-2.3', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0 * 1000);
    const store = memoryStore();
    const { account, password } = await devAccounts(store.adapter).create('player@example.com', {
      entitled: true,
    });
    const step = devPasswordStep(store.adapter);
    const kinds: string[] = [];
    for (let i = 0; i < 5; i += 1)
      kinds.push((await step.attempt('player@example.com', 'bad')).kind);
    kinds.push((await step.attempt('player@example.com', password)).kind);
    vi.setSystemTime((T0 + 599) * 1000);
    kinds.push((await step.attempt('player@example.com', password)).kind);
    expect(kinds).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'locked',
      'locked',
    ]);
    vi.setSystemTime((T0 + 600) * 1000);
    expect(await step.attempt('player@example.com', password)).toEqual({
      kind: 'signed-in',
      sub: account.sub,
    });
  });
});
