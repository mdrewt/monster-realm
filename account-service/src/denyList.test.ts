import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterPayload } from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Profile } from './config.ts';
import { denyList, steamAccounts } from './denyList.ts';
import {
  type OwnershipCheck,
  parseSteamId,
  type SteamId,
  steamEntitlementSource,
} from './steam/ownership.ts';
import { type AccountStore, openAccountStore } from './store/sqliteAdapter.ts';

const PLAYER = parseSteamId('76561198000000001')!;
// One digit apart from PLAYER.
const NEIGHBOUR = parseSteamId('76561198000000011')!;
const OTHER = parseSteamId('76561198000000002')!;
// Ids a pattern match (LIKE, a prefix, a glob) would take for PLAYER.
const PATTERN_NEIGHBOURS = ['7656119800000000_', '7656119800000000%', '7656119800000000*'];
// The record models of the deny-list and of the dev flag.
const DENY_MODEL = 'SteamDeny';
const FLAG_MODEL = 'SteamAccount';

const T0 = 1_000_000;
const FAR_FUTURE = T0 + 100 * 365 * 24 * 3600;
let t = T0;
const clock = (): number => t;

const opened: AccountStore[] = [];
const dirs: string[] = [];

beforeEach(() => {
  t = T0;
});

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(path = ':memory:'): AccountStore {
  const store = openAccountStore(path, clock);
  opened.push(store);
  return store;
}

function databaseFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acs8-'));
  dirs.push(dir);
  return join(dir, 'account.sqlite');
}

async function raw(store: AccountStore, model: string, id: string): Promise<AdapterPayload> {
  const found = (await store.adapter(model).find(id)) as AdapterPayload | undefined;
  expect(found, `${model} record ${id}`).toBeDefined();
  return found!;
}

const OWNS: OwnershipCheck = {
  kind: 'answered',
  ownership: { ownsapp: true, permanent: true, sitelicense: false, ownersteamid: PLAYER },
};

describe('the deny-list', () => {
  test('an id is absent before add, present after, and absent after remove acs-8.4', async () => {
    const list = denyList(open().adapter);
    expect(await list.has(PLAYER)).toBe(false);
    await list.add(PLAYER);
    expect(await list.has(PLAYER)).toBe(true);
    await list.remove(PLAYER);
    expect(await list.has(PLAYER)).toBe(false);
  });

  test('add is idempotent: added twice, one remove takes it off acs-8.4', async () => {
    const list = denyList(open().adapter);
    await list.add(PLAYER);
    await list.add(PLAYER);
    expect(await list.has(PLAYER)).toBe(true);
    await list.remove(PLAYER);
    expect(await list.has(PLAYER)).toBe(false);
  });

  test('removing an id never added resolves and leaves other entries acs-8.4', async () => {
    const list = denyList(open().adapter);
    await list.add(OTHER);
    await expect(list.remove(PLAYER)).resolves.toBeUndefined();
    expect(await list.has(PLAYER)).toBe(false);
    expect(await list.has(OTHER)).toBe(true);
  });

  test('ids are matched exactly: a neighbour one digit apart is neither denied nor freed acs-8.4', async () => {
    const list = denyList(open().adapter);
    await list.add(PLAYER);
    expect(await list.has(NEIGHBOUR)).toBe(false);
    expect(await list.has(OTHER)).toBe(false);
    await list.add(NEIGHBOUR);
    await list.remove(PLAYER);
    expect(await list.has(NEIGHBOUR)).toBe(true);
    expect(await list.has(PLAYER)).toBe(false);
  });

  test('a stored entry under a pattern-looking id denies nothing else and survives add and remove of a real id acs-8.4', async () => {
    const store = open();
    const list = denyList(store.adapter);
    await list.add(OTHER);
    const entry = await raw(store, DENY_MODEL, OTHER);
    for (const id of PATTERN_NEIGHBOURS) await store.adapter(DENY_MODEL).upsert(id, { ...entry });
    expect(await list.has(PLAYER)).toBe(false);
    await list.add(PLAYER);
    await list.remove(PLAYER);
    expect(await list.has(PLAYER)).toBe(false);
    for (const id of PATTERN_NEIGHBOURS) await raw(store, DENY_MODEL, id);
  });

  test('an entry survives a close and reopen of the store, and a purge far in the future acs-8.4', async () => {
    const path = databaseFile();
    const first = open(path);
    await denyList(first.adapter).add(PLAYER);
    first.close();

    const again = open(path);
    const list = denyList(again.adapter);
    expect(await list.has(PLAYER)).toBe(true);
    t = FAR_FUTURE;
    again.purgeExpired();
    expect(await list.has(PLAYER)).toBe(true);
    expect(await list.has(OTHER)).toBe(false);
  });
});

describe('the deny-list in the decision', () => {
  test.each([
    'local-dev',
    'hosted-dev',
  ] as const)('on %s a denied id is denied with its flag set entitled, and entitled again once removed acs-8.4', async (profile: Profile) => {
    const store = open();
    const list = denyList(store.adapter);
    const accounts = steamAccounts(store.adapter);
    let steamCalls = 0;
    const decide = steamEntitlementSource({
      profile,
      denied: (id) => list.has(id),
      devFlag: (id) => accounts.entitled(id),
      checkAppOwnership: async () => {
        steamCalls += 1;
        return OWNS;
      },
    });
    await accounts.setEntitled(PLAYER, true);
    await list.add(PLAYER);
    expect(await decide(PLAYER)).toStrictEqual({ entitled: false, reason: 'denied' });
    await list.remove(PLAYER);
    expect(await decide(PLAYER)).toStrictEqual({ entitled: true });
    expect(steamCalls).toBe(0);
  });

  test('on production a denied id is denied while Steam says it owns the game, and entitled again once removed acs-8.4', async () => {
    const store = open();
    const list = denyList(store.adapter);
    const asked: SteamId[] = [];
    const decide = steamEntitlementSource({
      profile: 'production',
      denied: (id) => list.has(id),
      devFlag: async () => {
        throw new Error('production never reads the dev flag');
      },
      checkAppOwnership: async (id) => {
        asked.push(id);
        return OWNS;
      },
    });
    await list.add(PLAYER);
    expect(await decide(PLAYER)).toStrictEqual({ entitled: false, reason: 'denied' });
    expect(asked).toEqual([]);
    await list.remove(PLAYER);
    expect(await decide(PLAYER)).toStrictEqual({ entitled: true });
    expect(asked).toEqual([PLAYER]);
  });
});

describe('the dev flag on a Steam account', () => {
  test('an id with no flag is not entitled acs-8.6', async () => {
    expect(await steamAccounts(open().adapter).entitled(PLAYER)).toBe(false);
  });

  test('set true reads entitled, set false reads not entitled acs-8.6', async () => {
    const accounts = steamAccounts(open().adapter);
    await accounts.setEntitled(PLAYER, true);
    expect(await accounts.entitled(PLAYER)).toBe(true);
    await accounts.setEntitled(PLAYER, false);
    expect(await accounts.entitled(PLAYER)).toBe(false);
    await accounts.setEntitled(PLAYER, true);
    expect(await accounts.entitled(PLAYER)).toBe(true);
  });

  test('ids are independent and matched exactly acs-8.6', async () => {
    const accounts = steamAccounts(open().adapter);
    await accounts.setEntitled(PLAYER, true);
    expect(await accounts.entitled(NEIGHBOUR)).toBe(false);
    expect(await accounts.entitled(OTHER)).toBe(false);
    await accounts.setEntitled(OTHER, true);
    await accounts.setEntitled(PLAYER, false);
    expect(await accounts.entitled(OTHER)).toBe(true);
    expect(await accounts.entitled(PLAYER)).toBe(false);
  });

  test('the flag survives a close and reopen of the store, and a purge far in the future acs-8.6', async () => {
    const path = databaseFile();
    const first = open(path);
    await steamAccounts(first.adapter).setEntitled(PLAYER, true);
    await steamAccounts(first.adapter).setEntitled(OTHER, false);
    first.close();

    const again = open(path);
    const accounts = steamAccounts(again.adapter);
    expect(await accounts.entitled(PLAYER)).toBe(true);
    t = FAR_FUTURE;
    again.purgeExpired();
    expect(await accounts.entitled(PLAYER)).toBe(true);
    expect(await accounts.entitled(OTHER)).toBe(false);
  });

  test('a stored record whose flag is not the boolean true reads not entitled acs-8.6', async () => {
    const store = open();
    const accounts = steamAccounts(store.adapter);
    await accounts.setEntitled(PLAYER, true);
    const stored = await raw(store, FLAG_MODEL, PLAYER);
    const flags = Object.entries(stored)
      .filter(([, value]) => value === true)
      .map(([name]) => name);
    expect(flags.length, 'the record holds its flag as the boolean true').toBeGreaterThan(0);

    const variants: Record<string, unknown>[] = [{}];
    for (const name of flags) {
      for (const value of ['true', 1, 'yes', {}, [true], null]) {
        variants.push({ ...stored, [name]: value });
      }
      variants.push(Object.fromEntries(Object.entries(stored).filter(([key]) => key !== name)));
    }
    for (const variant of variants) {
      await store.adapter(FLAG_MODEL).upsert(PLAYER, variant as AdapterPayload);
      expect(await accounts.entitled(PLAYER), JSON.stringify(variant)).toBe(false);
    }
  });
});

describe('the deny-list and the dev flag are separate records', () => {
  test('a flagged id is not denied, and denying then allowing it leaves its flag as it was acs-8.6', async () => {
    const store = open();
    const list = denyList(store.adapter);
    const accounts = steamAccounts(store.adapter);
    await accounts.setEntitled(PLAYER, true);
    expect(await list.has(PLAYER)).toBe(false);
    await list.add(PLAYER);
    expect(await accounts.entitled(PLAYER)).toBe(true);
    await list.remove(PLAYER);
    expect(await accounts.entitled(PLAYER)).toBe(true);
  });

  test('denying an id with no flag gives it none, and a cleared flag stays cleared through deny and allow acs-8.4', async () => {
    const store = open();
    const list = denyList(store.adapter);
    const accounts = steamAccounts(store.adapter);
    await list.add(OTHER);
    expect(await accounts.entitled(OTHER)).toBe(false);
    await accounts.setEntitled(PLAYER, false);
    await list.add(PLAYER);
    await list.remove(PLAYER);
    expect(await accounts.entitled(PLAYER)).toBe(false);
    expect(await list.has(OTHER)).toBe(true);
  });
});
