import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Provider, { type AdapterPayload } from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type AccountStore, openAccountStore } from './sqliteAdapter.ts';

const T0 = 1_000_000;
let t = T0;
const clock = (): number => t;

const opened: AccountStore[] = [];
const dirs: string[] = [];

// `now: null` opens the store on its default (wall) clock.
function open(path = ':memory:', now: (() => number) | null = clock): AccountStore {
  const store = now === null ? openAccountStore(path) : openAccountStore(path, now);
  opened.push(store);
  return store;
}

function closeQuietly(store: AccountStore): void {
  try {
    store.close();
  } catch {
    // already closed by the test
  }
}

beforeEach(() => {
  t = T0;
});

afterEach(() => {
  for (const store of opened.splice(0)) closeQuietly(store);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function payload(value: Record<string, unknown>): AdapterPayload {
  return value as AdapterPayload;
}

// The Adapter typings return a payload, undefined or void; read one member of the result.
async function member(read: Promise<unknown>, name: string): Promise<unknown> {
  const found = (await read) as Record<string, unknown> | undefined;
  return found === undefined ? undefined : found[name];
}

// Non-ASCII built from code points, never pasted.
const E_ACUTE = String.fromCharCode(0x00e9);
const NIHON = String.fromCharCode(0x65e5, 0x672c);
const DRAGON = String.fromCodePoint(0x1f409);

describe('round trip', () => {
  test('a written record reads back as stored and an absent id reads as undefined', async () => {
    const adapter = open().adapter('AuthorizationCode');
    const stored = payload({ accountId: 'acct-1', grantId: 'g1', scope: 'openid' });
    await adapter.upsert('r1', stored, 60);
    expect(await adapter.find('r1')).toEqual(stored);
    expect(await adapter.find('r2')).toBeUndefined();
  });

  test('a second upsert of an id replaces its payload and its expiry', async () => {
    const adapter = open().adapter('Session');
    await adapter.upsert('r1', payload({ v: 1 }), 10);
    await adapter.upsert('r1', payload({ v: 2 }), 100);
    t = T0 + 50;
    expect(await adapter.find('r1')).toEqual({ v: 2 });
  });

  test('a second upsert can shorten the expiry too', async () => {
    const adapter = open().adapter('Session');
    await adapter.upsert('r1', payload({ v: 1 }), 100);
    await adapter.upsert('r1', payload({ v: 2 }), 10);
    t = T0 + 10;
    expect(await adapter.find('r1')).toBeUndefined();
  });

  test('two adapters for the same model share their records', async () => {
    const store = open();
    await store.adapter('Grant').upsert('g', payload({ accountId: 'a' }), 60);
    expect(await store.adapter('Grant').find('g')).toEqual({ accountId: 'a' });
  });
});

describe('expiry', () => {
  test('a record is readable one second before its expiry and absent at it, through all three reads', async () => {
    const adapter = open().adapter('DeviceCode');
    const stored = payload({ uid: 'u1', userCode: 'UC-1', a: 1 });
    await adapter.upsert('r1', stored, 10);
    t = T0 + 9;
    expect(await adapter.find('r1')).toEqual(stored);
    expect(await adapter.findByUid('u1')).toEqual(stored);
    expect(await adapter.findByUserCode('UC-1')).toEqual(stored);
    t = T0 + 10;
    expect(await adapter.find('r1')).toBeUndefined();
    expect(await adapter.findByUid('u1')).toBeUndefined();
    expect(await adapter.findByUserCode('UC-1')).toBeUndefined();
  });

  test.each([0, -5])('expiresIn %i reads as absent at once', async (expiresIn) => {
    const adapter = open().adapter('Session');
    await adapter.upsert('r1', payload({ uid: 'u1' }), expiresIn);
    expect(await adapter.find('r1')).toBeUndefined();
    expect(await adapter.findByUid('u1')).toBeUndefined();
  });

  test('an undefined expiresIn never expires', async () => {
    const adapter = open().adapter('Grant');
    await adapter.upsert('r1', payload({ a: 1 }), undefined);
    await adapter.upsert('r2', payload({ a: 2 }));
    t = T0 + 100 * 365 * 24 * 3600;
    expect(await adapter.find('r1')).toEqual({ a: 1 });
    expect(await adapter.find('r2')).toEqual({ a: 2 });
  });

  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['the string 60', '60' as unknown as number],
  ])('expiresIn %s rejects with a TypeError and stores nothing', async (_name, expiresIn) => {
    const adapter = open().adapter('Session');
    await expect(adapter.upsert('fresh', payload({ v: 1 }), expiresIn)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(await adapter.find('fresh')).toBeUndefined();
    await adapter.upsert('kept', payload({ v: 1 }), 60);
    await expect(adapter.upsert('kept', payload({ v: 2 }), expiresIn)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(await adapter.find('kept')).toEqual({ v: 1 });
  });
});

describe('consume keeps the record and marks it', () => {
  test('a consumed record reads back with consumed at the time of its first consume', async () => {
    const adapter = open().adapter('AuthorizationCode');
    await adapter.upsert('c1', payload({ grantId: 'g1', uid: 'u1', userCode: 'UC' }), 600);
    t = T0 + 5;
    await adapter.consume('c1');
    t = T0 + 8;
    expect(await adapter.find('c1')).toEqual({
      grantId: 'g1',
      uid: 'u1',
      userCode: 'UC',
      consumed: T0 + 5,
    });
    expect(await member(adapter.findByUid('u1'), 'consumed')).toBe(T0 + 5);
    expect(await member(adapter.findByUserCode('UC'), 'consumed')).toBe(T0 + 5);
    t = T0 + 20;
    await adapter.consume('c1');
    expect(await member(adapter.find('c1'), 'consumed')).toBe(T0 + 5);
  });

  test('an unconsumed record never carries a consume mark', async () => {
    const adapter = open().adapter('RefreshToken');
    await adapter.upsert('c1', payload({ a: 1 }), 600);
    const found = await adapter.find('c1');
    expect(found).toEqual({ a: 1 });
    expect(Object.keys(found as object)).toEqual(['a']);
  });

  test('an upsert after consume takes the new payload and keeps the mark', async () => {
    const adapter = open().adapter('RefreshToken');
    await adapter.upsert('c1', payload({ v: 1 }), 600);
    t = T0 + 3;
    await adapter.consume('c1');
    t = T0 + 4;
    await adapter.upsert('c1', payload({ v: 2 }), 600);
    expect(await adapter.find('c1')).toEqual({ v: 2, consumed: T0 + 3 });
  });

  test("a payload's own consumed member is returned as stored until the numeric mark replaces it", async () => {
    const adapter = open().adapter('AuthorizationCode');
    await adapter.upsert('c1', payload({ consumed: 'x', a: 1 }), 600);
    expect(await adapter.find('c1')).toEqual({ consumed: 'x', a: 1 });
    t = T0 + 7;
    await adapter.consume('c1');
    expect(await adapter.find('c1')).toEqual({ consumed: T0 + 7, a: 1 });
  });

  test('consuming an absent id resolves and creates nothing', async () => {
    const adapter = open().adapter('AuthorizationCode');
    await expect(adapter.consume('nope')).resolves.toBeUndefined();
    expect(await adapter.find('nope')).toBeUndefined();
    await adapter.upsert('nope', payload({ a: 1 }), 600);
    expect(await adapter.find('nope')).toEqual({ a: 1 });
  });

  test('consuming an expired record resolves and does not make it readable', async () => {
    const adapter = open().adapter('AuthorizationCode');
    await adapter.upsert('c1', payload({ a: 1 }), 10);
    t = T0 + 10;
    await expect(adapter.consume('c1')).resolves.toBeUndefined();
    expect(await adapter.find('c1')).toBeUndefined();
    t = T0 + 11;
    expect(await adapter.find('c1')).toBeUndefined();
  });
});

describe('destroy and revokeByGrantId', () => {
  test('destroy removes the record and resolves for an absent id', async () => {
    const adapter = open().adapter('Session');
    await adapter.upsert('r1', payload({ uid: 'u1' }), 600);
    await adapter.upsert('r2', payload({ uid: 'u2' }), 600);
    await adapter.destroy('r1');
    expect(await adapter.find('r1')).toBeUndefined();
    expect(await adapter.findByUid('u1')).toBeUndefined();
    expect(await adapter.find('r2')).toEqual({ uid: 'u2' });
    await expect(adapter.destroy('absent')).resolves.toBeUndefined();
  });

  test("revokeByGrantId removes every record of the grant and leaves other grants' records", async () => {
    const adapter = open().adapter('RefreshToken');
    await adapter.upsert('r1', payload({ grantId: 'g1' }), 600);
    await adapter.upsert('r2', payload({ grantId: 'g1', other: true }), undefined);
    await adapter.upsert('r3', payload({ grantId: 'g2' }), 600);
    await adapter.upsert('r4', payload({ accountId: 'no-grant' }), 600);
    await adapter.consume('r2');
    await adapter.revokeByGrantId('g1');
    expect(await adapter.find('r1')).toBeUndefined();
    expect(await adapter.find('r2')).toBeUndefined();
    expect(await adapter.find('r3')).toEqual({ grantId: 'g2' });
    expect(await adapter.find('r4')).toEqual({ accountId: 'no-grant' });
  });
});

describe('a second upsert moves the record under its new lookup values', () => {
  test('revokeByGrantId follows the grantId of the latest upsert, not the first', async () => {
    const adapter = open().adapter('DeviceCode');
    await adapter.upsert('r1', payload({ userCode: 'UC-1' }), 600);
    await adapter.upsert('r1', payload({ userCode: 'UC-1', grantId: 'g' }), 600);
    await adapter.revokeByGrantId('g');
    expect(await adapter.find('r1')).toBeUndefined();

    await adapter.upsert('r2', payload({ grantId: 'old' }), 600);
    await adapter.upsert('r2', payload({ grantId: 'new', v: 2 }), 600);
    await adapter.revokeByGrantId('old');
    expect(await adapter.find('r2')).toEqual({ grantId: 'new', v: 2 });
    await adapter.revokeByGrantId('new');
    expect(await adapter.find('r2')).toBeUndefined();

    await adapter.upsert('r3', payload({ grantId: 'g3' }), 600);
    await adapter.upsert('r3', payload({ v: 3 }), 600);
    await adapter.revokeByGrantId('g3');
    expect(await adapter.find('r3')).toEqual({ v: 3 });
  });

  test('findByUid finds the uid of the latest upsert and no longer the earlier one', async () => {
    const adapter = open().adapter('Session');
    await adapter.upsert('s1', payload({ uid: 'u-old' }), 600);
    await adapter.upsert('s1', payload({ uid: 'u-new', v: 2 }), 600);
    expect(await adapter.findByUid('u-new')).toEqual({ uid: 'u-new', v: 2 });
    expect(await adapter.findByUid('u-old')).toBeUndefined();

    await adapter.upsert('s2', payload({ v: 1 }), 600);
    await adapter.upsert('s2', payload({ uid: 'u1', v: 2 }), 600);
    expect(await adapter.findByUid('u1')).toEqual({ uid: 'u1', v: 2 });

    await adapter.upsert('s3', payload({ uid: 'u2' }), 600);
    await adapter.upsert('s3', payload({ v: 3 }), 600);
    expect(await adapter.findByUid('u2')).toBeUndefined();
    expect(await adapter.find('s3')).toEqual({ v: 3 });
  });

  test('findByUserCode finds the userCode of the latest upsert and no longer the earlier one', async () => {
    const adapter = open().adapter('DeviceCode');
    await adapter.upsert('d1', payload({ userCode: 'UC-OLD' }), 600);
    await adapter.upsert('d1', payload({ userCode: 'UC-NEW', v: 2 }), 600);
    expect(await adapter.findByUserCode('UC-NEW')).toEqual({ userCode: 'UC-NEW', v: 2 });
    expect(await adapter.findByUserCode('UC-OLD')).toBeUndefined();

    await adapter.upsert('d2', payload({ v: 1 }), 600);
    await adapter.upsert('d2', payload({ userCode: 'UC-1', v: 2 }), 600);
    expect(await adapter.findByUserCode('UC-1')).toEqual({ userCode: 'UC-1', v: 2 });

    await adapter.upsert('d3', payload({ userCode: 'UC-2' }), 600);
    await adapter.upsert('d3', payload({ v: 3 }), 600);
    expect(await adapter.findByUserCode('UC-2')).toBeUndefined();
    expect(await adapter.find('d3')).toEqual({ v: 3 });
  });
});

describe('records of two models never see each other', () => {
  test('the same id in two models: find, consume and destroy touch only their own model', async () => {
    const store = open();
    const codes = store.adapter('AuthorizationCode');
    const tokens = store.adapter('RefreshToken');
    await codes.upsert('same', payload({ m: 'code' }), 600);
    await tokens.upsert('same', payload({ m: 'token' }), 600);
    expect(await codes.find('same')).toEqual({ m: 'code' });
    expect(await tokens.find('same')).toEqual({ m: 'token' });
    await codes.consume('same');
    expect(await tokens.find('same')).toEqual({ m: 'token' });
    expect(await member(codes.find('same'), 'consumed')).toBe(T0);
    await codes.destroy('same');
    expect(await codes.find('same')).toBeUndefined();
    expect(await tokens.find('same')).toEqual({ m: 'token' });
  });

  test('a record of one model is not found through another', async () => {
    const store = open();
    await store
      .adapter('Session')
      .upsert('only', payload({ uid: 'u-only', userCode: 'UC-only' }), 600);
    const other = store.adapter('Interaction');
    expect(await other.find('only')).toBeUndefined();
    expect(await other.findByUid('u-only')).toBeUndefined();
    expect(await other.findByUserCode('UC-only')).toBeUndefined();
  });

  test('the same uid and userCode in two models each find their own record', async () => {
    const store = open();
    const sessions = store.adapter('Session');
    const devices = store.adapter('DeviceCode');
    await sessions.upsert('s1', payload({ uid: 'u', userCode: 'UC', m: 'session' }), 600);
    await devices.upsert('d1', payload({ uid: 'u', userCode: 'UC', m: 'device' }), 600);
    expect(await sessions.findByUid('u')).toEqual({ uid: 'u', userCode: 'UC', m: 'session' });
    expect(await devices.findByUid('u')).toEqual({ uid: 'u', userCode: 'UC', m: 'device' });
    expect(await member(sessions.findByUserCode('UC'), 'm')).toBe('session');
    expect(await member(devices.findByUserCode('UC'), 'm')).toBe('device');
  });

  test('a revoke in one model leaves the same grant in another', async () => {
    const store = open();
    const codes = store.adapter('AuthorizationCode');
    const tokens = store.adapter('RefreshToken');
    await codes.upsert('c', payload({ grantId: 'g1' }), 600);
    await tokens.upsert('r', payload({ grantId: 'g1' }), 600);
    await codes.revokeByGrantId('g1');
    expect(await codes.find('c')).toBeUndefined();
    expect(await tokens.find('r')).toEqual({ grantId: 'g1' });
  });
});

describe('ids, uids and grant ids match as exact strings', () => {
  test('operations on a% and a_c never touch abc', async () => {
    const adapter = open().adapter('Session');
    await adapter.upsert('abc', payload({ v: 'abc' }), 600);
    await adapter.upsert('a%', payload({ v: 'percent' }), 600);
    expect(await adapter.find('a_c')).toBeUndefined();
    expect(await adapter.find('ABC')).toBeUndefined();
    expect(await adapter.find('a%')).toEqual({ v: 'percent' });
    await adapter.consume('a%');
    await adapter.consume('a_c');
    expect(await adapter.find('abc')).toEqual({ v: 'abc' });
    await adapter.destroy('a_c');
    await adapter.destroy('a%');
    expect(await adapter.find('abc')).toEqual({ v: 'abc' });
    expect(await adapter.find('a%')).toBeUndefined();
  });

  test('uid and userCode lookups are exact', async () => {
    const adapter = open().adapter('DeviceCode');
    await adapter.upsert('r1', payload({ uid: 'abc', userCode: 'abc' }), 600);
    for (const probe of ['a%', 'a_c', 'ABC', 'ab', 'abc ', '%']) {
      expect(await adapter.findByUid(probe)).toBeUndefined();
      expect(await adapter.findByUserCode(probe)).toBeUndefined();
    }
    expect(await adapter.findByUid('abc')).toEqual({ uid: 'abc', userCode: 'abc' });
  });

  test('revokeByGrantId with a pattern-looking grant id leaves other grants', async () => {
    const adapter = open().adapter('RefreshToken');
    await adapter.upsert('r1', payload({ grantId: 'g1' }), 600);
    await adapter.revokeByGrantId('g%');
    await adapter.revokeByGrantId('g_');
    await adapter.revokeByGrantId('G1');
    expect(await adapter.find('r1')).toEqual({ grantId: 'g1' });
  });

  test('quote and glob characters in an id round trip', async () => {
    const adapter = open().adapter('Session');
    for (const id of ["o'brien", 'a"b', 'a*b', 'a?b', 'a[1]b']) {
      await adapter.upsert(id, payload({ id }), 600);
    }
    for (const id of ["o'brien", 'a"b', 'a*b', 'a?b', 'a[1]b']) {
      expect(await adapter.find(id)).toEqual({ id });
    }
    expect(await adapter.find('aXb')).toBeUndefined();
  });
});

describe('payload fidelity', () => {
  test('nested objects, arrays, unicode, nulls and numbers come back equal', async () => {
    const adapter = open().adapter('Interaction');
    const stored = payload({
      nested: { deep: { list: [1, 'two', { three: [3] }], flag: false } },
      empty: {},
      none: null,
      float: 1.5,
      negative: -2,
      text: `monstre ${E_ACUTE} ${NIHON} ${DRAGON}`,
    });
    await adapter.upsert('r1', stored, 600);
    expect(await adapter.find('r1')).toEqual(stored);
  });

  test('an own __proto__ member round trips without polluting any prototype', async () => {
    const adapter = open().adapter('Interaction');
    const stored = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as AdapterPayload;
    await adapter.upsert('r1', stored, 600);
    const found = await adapter.find('r1');
    expect(found).toBeDefined();
    expect(JSON.stringify(found)).toBe(JSON.stringify(stored));
    expect(Object.hasOwn(found as object, '__proto__')).toBe(true);
    expect((found as Record<string, unknown>).polluted).toBeUndefined();
    expect((found as Record<string, unknown>).a).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('non-string uid, userCode and grantId are stored but never found by the string lookups', async () => {
    const adapter = open().adapter('DeviceCode');
    await adapter.upsert('n1', payload({ uid: 5, userCode: 9, grantId: 7 }), 600);
    await adapter.upsert('n2', payload({ uid: { x: 1 }, userCode: [1], grantId: { g: 1 } }), 600);
    await adapter.upsert('n3', payload({ uid: null, userCode: true, grantId: null }), 600);
    expect(await adapter.find('n1')).toEqual({ uid: 5, userCode: 9, grantId: 7 });
    for (const probe of ['5', '5.0', '[object Object]', '{"x":1}', 'null', 'true', '1', '[1]']) {
      expect(await adapter.findByUid(probe)).toBeUndefined();
      expect(await adapter.findByUserCode(probe)).toBeUndefined();
    }
    for (const probe of ['7', '{"g":1}', 'null']) await adapter.revokeByGrantId(probe);
    expect(await adapter.find('n1')).toEqual({ uid: 5, userCode: 9, grantId: 7 });
    expect(await adapter.find('n2')).toEqual({ uid: { x: 1 }, userCode: [1], grantId: { g: 1 } });
    expect(await adapter.find('n3')).toEqual({ uid: null, userCode: true, grantId: null });
  });
});

describe('a file-backed store', () => {
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'acs1-'));
    dirs.push(dir);
    return dir;
  }

  test('keeps records, expiries and consume marks across close and reopen', async () => {
    const path = join(tempDir(), 'account.sqlite');
    const first = open(path);
    await first.adapter('Grant').upsert('forever', payload({ a: 1 }), undefined);
    await first.adapter('AuthorizationCode').upsert('code', payload({ grantId: 'g' }), 600);
    await first.adapter('Session').upsert('short', payload({ uid: 'u' }), 10);
    t = T0 + 2;
    await first.adapter('AuthorizationCode').consume('code');
    first.close();

    const second = open(path);
    expect(await second.adapter('Grant').find('forever')).toEqual({ a: 1 });
    expect(await second.adapter('AuthorizationCode').find('code')).toEqual({
      grantId: 'g',
      consumed: T0 + 2,
    });
    expect(await second.adapter('Session').findByUid('u')).toEqual({ uid: 'u' });
    t = T0 + 10;
    expect(await second.adapter('Session').findByUid('u')).toBeUndefined();
  });

  test('creates the database file owner-only', () => {
    const path = join(tempDir(), 'account.sqlite');
    open(path);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });
});

describe('purgeExpired', () => {
  test('removes exactly the expired records and returns how many', async () => {
    const store = open();
    const codes = store.adapter('AuthorizationCode');
    const other = store.adapter('Session');
    await codes.upsert('expires', payload({ a: 'expires' }), 5);
    await codes.upsert('already', payload({ a: 'already' }), 0);
    await codes.upsert('live', payload({ a: 'live' }), 100);
    await codes.upsert('forever', payload({ a: 'forever' }), undefined);
    await codes.upsert('consumed-live', payload({ a: 'consumed-live' }), 100);
    await codes.upsert('consumed-expired', payload({ a: 'consumed-expired' }), 5);
    await other.upsert('other-expired', payload({ uid: 'ou' }), 5);
    await codes.consume('consumed-live');
    await codes.consume('consumed-expired');

    // Control: before the purge, a clock moved back still sees the soon-expired record.
    t = T0 + 1;
    expect(await codes.find('expires')).toEqual({ a: 'expires' });

    t = T0 + 5;
    expect(store.purgeExpired()).toBe(4);
    expect(store.purgeExpired()).toBe(0);
    expect(await codes.find('live')).toEqual({ a: 'live' });
    expect(await codes.find('forever')).toEqual({ a: 'forever' });
    expect(await codes.find('consumed-live')).toEqual({ a: 'consumed-live', consumed: T0 });

    // The purged rows are gone, not merely hidden by the clock.
    t = T0 + 1;
    expect(await codes.find('expires')).toBeUndefined();
    expect(await codes.find('consumed-expired')).toBeUndefined();
    expect(await other.findByUid('ou')).toBeUndefined();
    expect(await codes.find('live')).toEqual({ a: 'live' });
  });
});

describe('the provider itself, over this adapter', () => {
  async function build() {
    const store = open(':memory:', null);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
      format: 'jwk',
    });
    const provider = new Provider('http://localhost:4455', {
      adapter: store.adapter,
      jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: ec.x, y: ec.y, d: ec.d }] },
      clients: [
        {
          client_id: 'game',
          redirect_uris: ['http://localhost:5173/cb'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          id_token_signed_response_alg: 'ES256',
        },
      ],
      features: { devInteractions: { enabled: false } },
    });
    const client = (await provider.Client.find('game'))!;
    const saveGrant = async (): Promise<string> => {
      const grant = new provider.Grant({ accountId: 'acct-1', clientId: 'game' });
      grant.addOIDCScope('openid offline_access');
      return grant.save();
    };
    return { provider, client, saveGrant };
  }

  test('a saved Grant is found and then destroyed', async () => {
    const { provider, saveGrant } = await build();
    const grantId = await saveGrant();
    const grant = await provider.Grant.find(grantId);
    expect(grant?.accountId).toBe('acct-1');
    await grant!.destroy();
    expect(await provider.Grant.find(grantId)).toBeUndefined();
  });

  test('an AuthorizationCode is found unconsumed, and after consume a fresh find carries a numeric mark', async () => {
    const { provider, client, saveGrant } = await build();
    const grantId = await saveGrant();
    const code = new provider.AuthorizationCode({
      accountId: 'acct-1',
      client,
      grantId,
      gty: 'authorization_code',
      scope: 'openid offline_access',
      redirectUri: 'http://localhost:5173/cb',
    });
    const codeValue = await code.save();
    const found = await provider.AuthorizationCode.find(codeValue);
    expect(found).toBeDefined();
    expect(found!.accountId).toBe('acct-1');
    expect((found as unknown as { consumed: unknown }).consumed).toBeUndefined();
    await found!.consume();
    const again = await provider.AuthorizationCode.find(codeValue);
    const mark = (again as unknown as { consumed: unknown }).consumed;
    expect(typeof mark).toBe('number');
    expect(mark as number).toBeGreaterThan(0);
  });

  test('RefreshToken.revokeByGrantId removes the tokens of that grant and keeps those of another', async () => {
    const { provider, client, saveGrant } = await build();
    const grantId = await saveGrant();
    const otherGrantId = await saveGrant();
    const make = (id: string) =>
      new provider.RefreshToken({
        accountId: 'acct-1',
        client,
        grantId: id,
        gty: 'authorization_code',
        scope: 'openid offline_access',
      }).save();
    const revoked = await make(grantId);
    const kept = await make(otherGrantId);
    await provider.RefreshToken.revokeByGrantId(grantId);
    expect(await provider.RefreshToken.find(revoked)).toBeUndefined();
    expect((await provider.RefreshToken.find(kept))?.grantId).toBe(otherGrantId);
  });

  test('a Session is found by its uid', async () => {
    const { provider } = await build();
    const SessionModel: new (properties: {
      accountId: string;
    }) => InstanceType<typeof provider.Session> = provider.Session;
    const session = new SessionModel({ accountId: 'acct-1' });
    await session.save(3600);
    const found = await provider.Session.findByUid(session.uid);
    expect(found?.accountId).toBe('acct-1');
    expect(found?.uid).toBe(session.uid);
    expect(await provider.Session.findByUid(`${session.uid}x`)).toBeUndefined();
  });
});
