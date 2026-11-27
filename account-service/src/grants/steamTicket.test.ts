import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import type { Adapter } from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type SteamStub,
  type SteamStubOwnership,
  startSteamStub,
} from '../../test-util/steamStub.ts';
import { ID_TOKEN_CLAIMS } from '../claims.ts';
import { denyList, steamAccounts } from '../denyList.ts';
import type { PasswordStep } from '../interactions/router.ts';
import { generateSigningKey, type SigningKeys } from '../keys.ts';
import { createAccountProvider, registerClient } from '../provider.ts';
import { createSourceAddress } from '../rateLimit.ts';
import {
  parseSteamId,
  type SteamEntitlement,
  type SteamId,
  steamEntitlementSource,
} from '../steam/ownership.ts';
import { createSteamWebApi, SteamApiError, type TicketCheck } from '../steam/webApi.ts';
import { type AccountStore, openAccountStore } from '../store/sqliteAdapter.ts';
import {
  createSteamTicketExchange,
  type SteamTicketGrantOptions,
  type TicketExchange,
} from './steamTicket.ts';

// The Steam ticket grant: first the exchange alone against fakes this file controls, then the
// grant over HTTP through the provider, built from the real Steam client against the Steam stub,
// the real entitlement source over an in-memory store, and an injected clock for the windows.

const IDENTITY = 'monster-realm-account';
const GRANT = 'urn:monster-realm:steam-ticket';
const ISSUER = 'http://localhost:4455';
const HOST = 'localhost:4455';
const CLIENT_ID = 'monster-realm';
const OTHER_CLIENT_ID = 'other-game';
const REDIRECT_URI = 'http://localhost:5290/';
const OTHER_REDIRECT_URI = 'http://localhost:5391/';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const DISCOVERY_PATH = '/.well-known/openid-configuration';
const AUTH_PATH = '/ISteamUserAuth/AuthenticateUserTicket/v1/';
const OWN_PATH = '/ISteamUser/CheckAppOwnership/v4/';
const GAME_APP_ID = 3_141_590;
const T0 = 1_700_000_000;
const PLAYER = parseSteamId('76561198000000001')!;
const OTHER_PLAYER = parseSteamId('76561198000000002')!;
const PLAYER_SUB = 'steam:76561198000000001';
const OTHER_PLAYER_SUB = 'steam:76561198000000002';
const ADDRESS = '198.51.100.7';
const OTHER_ADDRESS = '198.51.100.8';
const IPV6_ADDRESS = '2001:db8:0:1::7';
const IPV6_SAME_64 = '2001:db8:0:1:ffff:ffff:ffff:fffe';
const IPV6_OTHER_64 = '2001:db8:0:2::7';
const FORWARDED = '203.0.113.5';
const OTHER_FORWARDED = '203.0.113.6';
const LOOPBACK_PROXY = { address: '127.0.0.1', prefix: 32, family: 'ipv4' } as const;
const FAILURE_MESSAGE = `INTERNAL_SECRET_failure_${randomBytes(8).toString('hex')}`;

const REJECTED: TicketCheck = { kind: 'rejected' };
const FAILED: TicketCheck = { kind: 'failed', error: new SteamApiError('timeout') };
const ENTITLED: SteamEntitlement = { entitled: true };
const NOT_OWNED: SteamEntitlement = { entitled: false, reason: 'not-owned' };
const DENIED: SteamEntitlement = { entitled: false, reason: 'denied' };
const UNAVAILABLE: SteamEntitlement = {
  entitled: false,
  reason: 'unavailable',
  error: new SteamApiError('unreachable'),
};

/** A failure of the service's own, with a message that must reach no answer and no line. */
class StoreDownError extends Error {
  constructor() {
    super(FAILURE_MESSAGE);
    this.name = 'StoreDownError';
  }
}

function hexTicket(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

/** A hex ticket no fake and no stub has issued: Steam rejects it. */
function madeUp(label: string): string {
  return hexTicket(`made up ${label}`);
}

/** A SteamID of its own for each `n`, apart from PLAYER and OTHER_PLAYER. */
function playerNumber(n: number): SteamId {
  return parseSteamId(`76561198${String(1000 + n).padStart(9, '0')}`)!;
}

function turn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

function count(ends: readonly TicketExchange[], kind: TicketExchange['kind']): number {
  return ends.filter((end) => end.kind === kind).length;
}

async function times<T>(n: number, run: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) out.push(await run(i));
  return out;
}

// ---- the exchange against fakes ----

interface Rig {
  /** One exchange; with no address, each call comes from an address of its own. */
  exchange(ticket: string, address?: string): Promise<TicketExchange>;
  /** A fresh ticket the fake Steam authenticates as `steamId`. */
  issue(steamId: SteamId): string;
  readonly authCalls: Array<readonly [string, string]>;
  readonly entitlementCalls: string[];
  /** What the fake Steam answers, by the ticket in lower case; absent is rejected. */
  readonly tickets: Map<string, TicketCheck | Error>;
  /** What the fake entitlement source answers per SteamID; absent is not owned. */
  readonly entitlements: Map<string, SteamEntitlement | Error>;
  advance(seconds: number): void;
}

function rig(): Rig {
  let clock = T0;
  let addresses = 0;
  let issued = 0;
  const authCalls: Array<readonly [string, string]> = [];
  const entitlementCalls: string[] = [];
  const tickets = new Map<string, TicketCheck | Error>();
  const entitlements = new Map<string, SteamEntitlement | Error>();
  const run = createSteamTicketExchange({
    authenticateTicket: async (ticket, identity) => {
      authCalls.push([ticket, identity]);
      await turn();
      const answer = tickets.get(ticket.toLowerCase()) ?? REJECTED;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    entitlement: async (steamId) => {
      entitlementCalls.push(steamId);
      await turn();
      const answer = entitlements.get(steamId) ?? NOT_OWNED;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => clock,
  });
  return {
    exchange(ticket, address) {
      addresses += 1;
      const own = `10.0.${Math.floor(addresses / 250)}.${(addresses % 250) + 1}`;
      return run(ticket, address ?? own);
    },
    issue(steamId) {
      issued += 1;
      const ticket = hexTicket(`ticket ${issued} of ${steamId}`);
      tickets.set(ticket, { kind: 'authenticated', steamId });
      return ticket;
    },
    authCalls,
    entitlementCalls,
    tickets,
    entitlements,
    advance(seconds) {
      clock += seconds;
    },
  };
}

describe('one exchange, step by step', () => {
  test('a ticket Steam authenticates for an entitled player ends entitled as steam:<steamid64> acs-9.1', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    r.entitlements.set(OTHER_PLAYER, ENTITLED);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'entitled', sub: PLAYER_SUB });
    expect(await r.exchange(r.issue(OTHER_PLAYER))).toEqual({
      kind: 'entitled',
      sub: OTHER_PLAYER_SUB,
    });
    expect(r.entitlementCalls).toEqual([PLAYER, OTHER_PLAYER]);
  });

  test('Steam is asked with the ticket exactly as given and the identity monster-realm-account acs-9.1', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    const ticket = r.issue(PLAYER);
    const upper = ticket.toUpperCase();
    expect(upper).not.toBe(ticket);
    await r.exchange(ticket);
    await r.exchange(upper);
    expect(r.authCalls).toEqual([
      [ticket, 'monster-realm-account'],
      [upper, 'monster-realm-account'],
    ]);
  });

  test('a ticket Steam rejects is refused and the entitlement source is not asked acs-9.2', async () => {
    const r = rig();
    expect(await r.exchange(madeUp('rejected'))).toEqual({ kind: 'refused' });
    expect(r.authCalls).toHaveLength(1);
    expect(r.entitlementCalls).toEqual([]);
  });

  test.each([
    ['not owned', NOT_OWNED],
    ['denied', DENIED],
  ] as const)('a player whose entitlement says %s is refused acs-9.2', async (_name, answer) => {
    const r = rig();
    r.entitlements.set(PLAYER, answer);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'refused' });
    expect(r.entitlementCalls).toEqual([PLAYER]);
  });

  test('a ticket Steam authenticated once and rejects at its next check is refused, Steam asked again acs-9.2', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    const ticket = r.issue(PLAYER);
    expect(await r.exchange(ticket)).toEqual({ kind: 'entitled', sub: PLAYER_SUB });
    r.tickets.set(ticket, REJECTED);
    expect(await r.exchange(ticket)).toEqual({ kind: 'refused' });
    expect(r.authCalls).toHaveLength(2);
    expect(r.entitlementCalls).toEqual([PLAYER]);
  });

  test('Steam failing to answer the ticket check ends unavailable, the entitlement source not asked', async () => {
    const r = rig();
    const ticket = madeUp('failing');
    r.tickets.set(ticket, FAILED);
    expect(await r.exchange(ticket)).toEqual({ kind: 'unavailable' });
    expect(r.entitlementCalls).toEqual([]);
  });

  test('an entitlement source that cannot answer ends unavailable', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, UNAVAILABLE);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'unavailable' });
  });

  test('a ticket check that rejects rejects the exchange with that error', async () => {
    const r = rig();
    const ticket = madeUp('throwing');
    const error = new StoreDownError();
    r.tickets.set(ticket, error);
    await expect(r.exchange(ticket)).rejects.toBe(error);
    expect(r.entitlementCalls).toEqual([]);
  });

  test('an entitlement source that rejects rejects the exchange with that error', async () => {
    const r = rig();
    const error = new StoreDownError();
    r.entitlements.set(PLAYER, error);
    await expect(r.exchange(r.issue(PLAYER))).rejects.toBe(error);
  });
});

describe('the address window: 60 exchanges within any 60 seconds', () => {
  test('the 61st exchange from one address within 60 seconds is limited without asking Steam acs-9.3', async () => {
    const r = rig();
    const ends = await times(60, (i) => r.exchange(madeUp(`one address ${i}`), ADDRESS));
    expect(count(ends, 'refused')).toBe(60);
    expect(r.authCalls).toHaveLength(60);
    expect(await r.exchange(madeUp('one address 60'), ADDRESS)).toEqual({
      kind: 'rate-limited',
      retryAfter: 60,
    });
    expect(r.authCalls).toHaveLength(60);
    expect(r.entitlementCalls).toEqual([]);
  });

  test('every exchange from an address counts against it, whatever its end acs-9.3', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    r.entitlements.set(OTHER_PLAYER, ENTITLED);
    const ends: TicketExchange[] = [];
    // 30 entitled and one over PLAYER's SteamID window
    ends.push(...(await times(31, () => r.exchange(r.issue(PLAYER), ADDRESS))));
    ends.push(
      ...(await times(10, (i) => {
        const ticket = madeUp(`failing ${i}`);
        r.tickets.set(ticket, FAILED);
        return r.exchange(ticket, ADDRESS);
      })),
    );
    ends.push(...(await times(10, (i) => r.exchange(madeUp(`mixed ${i}`), ADDRESS))));
    ends.push(...(await times(9, (i) => r.exchange(r.issue(playerNumber(i)), ADDRESS))));
    expect([
      count(ends, 'entitled'),
      count(ends, 'rate-limited'),
      count(ends, 'unavailable'),
      count(ends, 'refused'),
    ]).toEqual([30, 1, 10, 19]);
    expect(r.authCalls).toHaveLength(60);

    expect(await r.exchange(r.issue(OTHER_PLAYER), ADDRESS)).toEqual({
      kind: 'rate-limited',
      retryAfter: 60,
    });
    expect(r.authCalls).toHaveLength(60);
    expect(r.entitlementCalls).not.toContain(OTHER_PLAYER);
  });

  test('the address window still refuses one second before it passes and lets an exchange through at 60 seconds acs-9.3', async () => {
    const r = rig();
    await times(60, (i) => r.exchange(madeUp(`passing ${i}`), ADDRESS));
    r.advance(59);
    expect(await r.exchange(madeUp('at 59'), ADDRESS)).toEqual({
      kind: 'rate-limited',
      retryAfter: 1,
    });
    expect(r.authCalls).toHaveLength(60);
    r.advance(1);
    expect(await r.exchange(madeUp('at 60'), ADDRESS)).toEqual({ kind: 'refused' });
    expect(r.authCalls).toHaveLength(61);
  });

  test('retryAfter counts to the oldest live hit of a sliding window acs-9.3', async () => {
    const r = rig();
    await times(30, (i) => r.exchange(madeUp(`early ${i}`), ADDRESS));
    r.advance(30);
    await times(30, (i) => r.exchange(madeUp(`late ${i}`), ADDRESS));
    expect(await r.exchange(madeUp('at 30'), ADDRESS)).toEqual({
      kind: 'rate-limited',
      retryAfter: 30,
    });
    r.advance(29);
    expect(await r.exchange(madeUp('at 59'), ADDRESS)).toEqual({
      kind: 'rate-limited',
      retryAfter: 1,
    });
    r.advance(1);
    // The 30 hits at T0 are a window old; the 30 at T0 + 30 still live.
    const opened = await times(30, (i) => r.exchange(madeUp(`opened ${i}`), ADDRESS));
    expect(count(opened, 'refused')).toBe(30);
    expect(await r.exchange(madeUp('over again'), ADDRESS)).toEqual({
      kind: 'rate-limited',
      retryAfter: 30,
    });
  });

  test('exchanges refused by the address window do not count against it acs-9.3', async () => {
    const r = rig();
    await times(60, (i) => r.exchange(madeUp(`first ${i}`), ADDRESS));
    r.advance(30);
    const limited = await times(60, (i) => r.exchange(madeUp(`hammer ${i}`), ADDRESS));
    expect(count(limited, 'rate-limited')).toBe(60);
    r.advance(30);
    const after = await times(60, (i) => r.exchange(madeUp(`after ${i}`), ADDRESS));
    expect(count(after, 'refused')).toBe(60);
    expect(r.authCalls).toHaveLength(120);
  });

  test('another IPv4 address has a window of its own acs-9.3', async () => {
    const r = rig();
    await times(60, (i) => r.exchange(madeUp(`ipv4 ${i}`), ADDRESS));
    expect(await r.exchange(madeUp('other ipv4'), OTHER_ADDRESS)).toEqual({ kind: 'refused' });
    expect(r.authCalls).toHaveLength(61);
  });

  test('two IPv6 addresses in one /64 share a window; the next /64 and an IPv4 address do not acs-9.3', async () => {
    const r = rig();
    await times(30, (i) => r.exchange(madeUp(`ipv6 a ${i}`), IPV6_ADDRESS));
    await times(30, (i) => r.exchange(madeUp(`ipv6 b ${i}`), IPV6_SAME_64));
    expect(await r.exchange(madeUp('same 64'), IPV6_ADDRESS)).toEqual({
      kind: 'rate-limited',
      retryAfter: 60,
    });
    expect(r.authCalls).toHaveLength(60);
    expect(await r.exchange(madeUp('next 64'), IPV6_OTHER_64)).toEqual({ kind: 'refused' });
    expect(await r.exchange(madeUp('beside'), ADDRESS)).toEqual({ kind: 'refused' });
    expect(r.authCalls).toHaveLength(62);
  });
});

// Every exchange in this block comes from an address of its own unless it names one, so the
// address window never interferes with the SteamID window under test.
describe('the SteamID window: 30 exchanges within any 3600 seconds', () => {
  test('the 31st exchange of one SteamID is limited before the entitlement source is asked acs-9.3', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    const ends = await times(30, () => r.exchange(r.issue(PLAYER)));
    expect(count(ends, 'entitled')).toBe(30);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'rate-limited', retryAfter: 3600 });
    expect(r.authCalls).toHaveLength(31);
    expect(r.entitlementCalls).toHaveLength(30);
  });

  test('a remembered ticket of a SteamID over its window is limited without asking Steam acs-9.3', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    const tickets = Array.from({ length: 30 }, () => r.issue(PLAYER));
    for (const ticket of tickets) await r.exchange(ticket);
    expect(await r.exchange(tickets[0]!)).toEqual({ kind: 'rate-limited', retryAfter: 3600 });
    expect(r.authCalls).toHaveLength(30);
    expect(r.entitlementCalls).toHaveLength(30);
  });

  test('a remembered ticket in the other letter case is the same ticket acs-9.3', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    const tickets = Array.from({ length: 30 }, () => r.issue(PLAYER));
    for (const ticket of tickets) await r.exchange(ticket);
    const upper = tickets[29]!.toUpperCase();
    expect(upper).not.toBe(tickets[29]);
    expect(await r.exchange(upper)).toEqual({ kind: 'rate-limited', retryAfter: 3600 });
    expect(r.authCalls).toHaveLength(30);
  });

  test('thirty refusals of a player who is not entitled fill the window too acs-9.3', async () => {
    const r = rig();
    const notOwned = await times(15, () => r.exchange(r.issue(PLAYER)));
    r.entitlements.set(PLAYER, DENIED);
    const denied = await times(15, () => r.exchange(r.issue(PLAYER)));
    expect(count([...notOwned, ...denied], 'refused')).toBe(30);
    r.entitlements.set(PLAYER, ENTITLED);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'rate-limited', retryAfter: 3600 });
    expect(r.entitlementCalls).toHaveLength(30);
  });

  test('an entitlement source that cannot answer gives its hit back acs-9.3', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, UNAVAILABLE);
    const outage = await times(40, () => r.exchange(r.issue(PLAYER)));
    expect(count(outage, 'unavailable')).toBe(40);
    r.entitlements.set(PLAYER, ENTITLED);
    const after = await times(30, () => r.exchange(r.issue(PLAYER)));
    expect(count(after, 'entitled')).toBe(30);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'rate-limited', retryAfter: 3600 });
  });

  test('an entitlement source that rejects gives its hit back acs-9.3', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, new StoreDownError());
    for (let i = 0; i < 35; i += 1) {
      await expect(r.exchange(r.issue(PLAYER))).rejects.toBeInstanceOf(StoreDownError);
    }
    r.entitlements.set(PLAYER, ENTITLED);
    const after = await times(30, () => r.exchange(r.issue(PLAYER)));
    expect(count(after, 'entitled')).toBe(30);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'rate-limited', retryAfter: 3600 });
  });

  test("a ticket Steam stops authenticating never spends its SteamID's window acs-9.3", async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    const remembered = r.issue(PLAYER);
    expect(await r.exchange(remembered)).toEqual({ kind: 'entitled', sub: PLAYER_SUB });
    r.tickets.set(remembered, REJECTED);
    const refused = await times(30, () => r.exchange(remembered));
    r.tickets.set(remembered, FAILED);
    const failed = await times(10, () => r.exchange(remembered.toUpperCase()));
    expect(count(refused, 'refused')).toBe(30);
    expect(count(failed, 'unavailable')).toBe(10);
    // one hit from the first exchange, 29 from these
    const later = await times(29, () => r.exchange(r.issue(PLAYER)));
    expect(count(later, 'entitled')).toBe(29);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'rate-limited', retryAfter: 3600 });
  });

  test("one SteamID's full window leaves another SteamID its own acs-9.3", async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    r.entitlements.set(OTHER_PLAYER, ENTITLED);
    await times(30, () => r.exchange(r.issue(PLAYER)));
    expect(await r.exchange(r.issue(OTHER_PLAYER))).toEqual({
      kind: 'entitled',
      sub: OTHER_PLAYER_SUB,
    });
  });

  test('the SteamID window still refuses one second before it passes and lets an exchange through at 3600 seconds acs-9.3', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    await times(30, () => r.exchange(r.issue(PLAYER)));
    r.advance(1800);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'rate-limited', retryAfter: 1800 });
    r.advance(1799);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'rate-limited', retryAfter: 1 });
    r.advance(1);
    expect(await r.exchange(r.issue(PLAYER))).toEqual({ kind: 'entitled', sub: PLAYER_SUB });
    expect(r.entitlementCalls).toHaveLength(31);
  });

  test('exchanges refused by the SteamID window do not count against it acs-9.3', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    await times(30, () => r.exchange(r.issue(PLAYER)));
    r.advance(10);
    const limited = await times(50, () => r.exchange(r.issue(PLAYER)));
    expect(count(limited, 'rate-limited')).toBe(50);
    r.advance(3590);
    const after = await times(30, () => r.exchange(r.issue(PLAYER)));
    expect(count(after, 'entitled')).toBe(30);
  });

  test('forty exchanges at once for one SteamID end thirty entitled and ten limited acs-9.3', async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    const tickets = Array.from({ length: 40 }, () => r.issue(PLAYER));
    const ends = await Promise.all(tickets.map((ticket) => r.exchange(ticket)));
    expect(count(ends, 'entitled')).toBe(30);
    expect(count(ends, 'rate-limited')).toBe(10);
    expect(r.entitlementCalls).toHaveLength(30);
  });

  test("the address window answers before a remembered ticket's SteamID window acs-9.3", async () => {
    const r = rig();
    r.entitlements.set(PLAYER, ENTITLED);
    const tickets = Array.from({ length: 30 }, () => r.issue(PLAYER));
    for (const ticket of tickets) await r.exchange(ticket);
    await times(60, (i) => r.exchange(madeUp(`fill ${i}`), ADDRESS));
    expect(await r.exchange(tickets[0]!, ADDRESS)).toEqual({
      kind: 'rate-limited',
      retryAfter: 60,
    });
    expect(await r.exchange(tickets[0]!)).toEqual({ kind: 'rate-limited', retryAfter: 3600 });
  });
});

// ---- the grant over HTTP ----

let clock = T0;
let addressesUsed = 0;

/** A forwarded source address no other request of this file uses. */
function freshAddress(): string {
  addressesUsed += 1;
  return `198.18.${Math.floor(addressesUsed / 250)}.${(addressesUsed % 250) + 1}`;
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Faults {
  authenticate: Error | undefined;
  entitlement: Error | undefined;
  log: 'throws' | 'rejects' | undefined;
}

interface World {
  readonly port: number;
  readonly production: boolean;
  readonly stub: SteamStub;
  readonly keys: SigningKeys;
  readonly store: AccountStore;
  readonly deny: ReturnType<typeof denyList>;
  readonly accounts: ReturnType<typeof steamAccounts>;
  /** What the grant's log received. */
  readonly lines: string[];
  /** The model of every record the provider wrote. */
  readonly writes: string[];
  readonly faults: Faults;
}

interface WorldOptions {
  readonly profile?: 'local-dev' | 'production';
  /** Trust 127.0.0.1 as a proxy, so a request's source is its X-Forwarded-For; default true. */
  readonly trustProxy?: boolean;
  /** Build the provider with the grant; default true. */
  readonly grant?: boolean;
}

const REFUSING_SIGN_IN: PasswordStep = {
  kind: 'password',
  attempt: () => Promise.resolve({ kind: 'refused' }),
  account: () => Promise.resolve(undefined),
};

const servers: Server[] = [];
const stores: AccountStore[] = [];
const stubs: SteamStub[] = [];

beforeEach(() => {
  clock = T0;
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }
  for (const stub of stubs.splice(0)) await stub.close();
  for (const store of stores.splice(0)) store.close();
});

async function world(options: WorldOptions = {}): Promise<World> {
  const profile = options.profile ?? 'local-dev';
  const production = profile === 'production';
  const stub = await startSteamStub(production ? { appId: GAME_APP_ID } : undefined);
  stubs.push(stub);
  const store = openAccountStore(':memory:');
  stores.push(store);
  const writes: string[] = [];
  const adapter = (model: string): Adapter => {
    const inner = store.adapter(model);
    return {
      ...inner,
      upsert: (id, payload, expiresIn) => {
        writes.push(model);
        return inner.upsert(id, payload, expiresIn);
      },
    };
  };
  const deny = denyList(store.adapter);
  const accounts = steamAccounts(store.adapter);
  const steamLines: string[] = [];
  const api = createSteamWebApi({
    config: { profile, steam: { appId: stub.appId } },
    env: production ? { MR_STEAM_PUBLISHER_KEY: stub.key } : { MR_STEAM_WEB_API_KEY: stub.key },
    log: (line) => {
      steamLines.push(line);
    },
    baseUrl: stub.url,
  });
  const entitlement = steamEntitlementSource({
    profile,
    denied: (steamId) => deny.has(steamId),
    devFlag: (steamId) => accounts.entitled(steamId),
    checkAppOwnership: (steamId) => api.checkAppOwnership(steamId),
  });
  const faults: Faults = { authenticate: undefined, entitlement: undefined, log: undefined };
  const lines: string[] = [];
  const writeLine = (line: string): Promise<void> | undefined => {
    if (faults.log === 'throws') throw new StoreDownError();
    lines.push(line);
    return faults.log === 'rejects' ? Promise.reject(new StoreDownError()) : undefined;
  };
  const steamTicket: SteamTicketGrantOptions = {
    authenticateTicket: (ticket, identity) =>
      faults.authenticate === undefined
        ? api.authenticateTicket(ticket, identity)
        : Promise.reject(faults.authenticate),
    entitlement: (steamId) =>
      faults.entitlement === undefined ? entitlement(steamId) : Promise.reject(faults.entitlement),
    sourceAddress: createSourceAddress(options.trustProxy === false ? [] : [LOOPBACK_PROXY]),
    log: writeLine,
    now: () => clock,
  };
  const keys: SigningKeys = { keys: [generateSigningKey()] };
  const { handler } = createAccountProvider({
    issuer: ISSUER,
    keys,
    adapter,
    signIn: REFUSING_SIGN_IN,
    steamTicket: options.grant === false ? undefined : steamTicket,
  });
  await registerClient(store.adapter, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    production,
    stub,
    keys,
    store,
    deny,
    accounts,
    lines,
    writes,
    faults,
  };
}

function send(
  port: number,
  call: {
    readonly path: string;
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: HOST, ...call.headers };
    if (call.body !== undefined) headers['content-length'] = String(Buffer.byteLength(call.body));
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: call.path,
        method: call.method ?? 'GET',
        headers,
        agent: false,
      },
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
    if (call.body !== undefined) req.write(call.body);
    req.end();
  });
}

interface Asking {
  /** The X-Forwarded-For sent; default an address of its own; null sends none. */
  readonly from?: string | null;
  readonly headers?: Record<string, string>;
  /** Members added to (or replacing) the form's. */
  readonly fields?: Record<string, string>;
}

/** POST /token with a form body. */
function post(
  w: World,
  body: Record<string, string> | string,
  asking: Asking = {},
): Promise<Reply> {
  const text = typeof body === 'string' ? body : new URLSearchParams(body).toString();
  const from = asking.from === undefined ? freshAddress() : asking.from;
  const headers: Record<string, string> = {
    'content-type': FORM_TYPE,
    accept: 'application/json',
    ...asking.headers,
  };
  if (from !== null) headers['x-forwarded-for'] = from;
  return send(w.port, { path: '/token', method: 'POST', headers, body: text });
}

function exchange(w: World, ticket: string, asking: Asking = {}): Promise<Reply> {
  return post(
    w,
    { grant_type: GRANT, client_id: CLIENT_ID, steam_ticket: ticket, ...asking.fields },
    asking,
  );
}

function bodyOf(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>;
}

function asked(w: World, path: string): number {
  return w.stub.requests.filter((sent) => sent.path === path).length;
}

function owned(steamId: SteamId): SteamStubOwnership {
  return { ownsapp: true, permanent: true, sitelicense: false, ownersteamid: steamId };
}

/** A ticket for `steamId`, who the world's profile holds entitled. */
async function entitledTicket(w: World, steamId: SteamId = PLAYER): Promise<string> {
  if (w.production) w.stub.setOwnership(steamId, owned(steamId));
  else await w.accounts.setEntitled(steamId, true);
  return w.stub.issueTicket(steamId, IDENTITY);
}

async function verified(w: World, idToken: unknown) {
  const jwks = JSON.parse((await send(w.port, { path: '/jwks' })).body) as JSONWebKeySet;
  return jwtVerify(String(idToken), createLocalJWKSet(jwks), { issuer: ISSUER });
}

/** The headers that describe an answer: all but `date`. */
function describing(headers: IncomingHttpHeaders): Record<string, unknown> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'date'));
}

function expectLimited(reply: Reply, retryAfter: number): void {
  expect(reply.status).toBe(429);
  expect(reply.headers['retry-after']).toBe(String(retryAfter));
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(bodyOf(reply).error).not.toBe('invalid_grant');
  expect(bodyOf(reply)).not.toHaveProperty('id_token');
}

function expectNotInvalidGrant(reply: Reply, status: number): void {
  expect(reply.status).toBe(status);
  expect(bodyOf(reply).error).not.toBe('invalid_grant');
  expect(bodyOf(reply)).not.toHaveProperty('id_token');
}

describe('the grant issues an ID token', () => {
  test('an entitled player gets exactly { id_token, expires_in: 3600 } and nothing is stored acs-9.1', async () => {
    const w = await world();
    const reply = await exchange(w, await entitledTicket(w));
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    const body = bodyOf(reply);
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'id_token']);
    expect(body.expires_in).toBe(3600);
    expect(w.writes).toEqual([]);
  });

  test('the ID token verifies under /jwks with exactly the named claims and sub steam:<steamid64> acs-9.1', async () => {
    const w = await world();
    const reply = await exchange(w, await entitledTicket(w));
    const { payload, protectedHeader } = await verified(w, bodyOf(reply).id_token);
    expect(protectedHeader.alg).toBe('ES256');
    expect(protectedHeader.kid).toBe(w.keys.keys[0]!.kid);
    expect(Object.keys(payload).sort()).toEqual([...ID_TOKEN_CLAIMS].sort());
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'mr_ent', 'sub']);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.sub).toBe(PLAYER_SUB);
    expect(payload.aud).toBe(CLIENT_ID);
    expect(payload.mr_ent).toEqual(['base-game']);
    expect(payload.exp! - payload.iat!).toBe(3600);
  });

  test("the token's aud is the client that asked acs-9.1", async () => {
    const w = await world();
    await registerClient(w.store.adapter, {
      clientId: OTHER_CLIENT_ID,
      redirectUri: OTHER_REDIRECT_URI,
    });
    const reply = await exchange(w, await entitledTicket(w), {
      fields: { client_id: OTHER_CLIENT_ID },
    });
    expect(reply.status).toBe(200);
    const { payload } = await verified(w, bodyOf(reply).id_token);
    expect(payload.aud).toBe(OTHER_CLIENT_ID);
  });

  test('parameters a request adds put no claim in the token and name no other player acs-9.1', async () => {
    const w = await world();
    await w.accounts.setEntitled(OTHER_PLAYER, true);
    const reply = await exchange(w, await entitledTicket(w), {
      fields: {
        nonce: 'n-0S6_WzA2Mj',
        max_age: '0',
        claims: JSON.stringify({ id_token: { email: null } }),
        steamid: OTHER_PLAYER,
      },
    });
    expect(reply.status).toBe(200);
    const { payload } = await verified(w, bodyOf(reply).id_token);
    expect(Object.keys(payload).sort()).toEqual([...ID_TOKEN_CLAIMS].sort());
    expect(payload.sub).toBe(PLAYER_SUB);
  });

  test('on production the ownership Steam reports decides who gets a token acs-9.1', async () => {
    const w = await world({ profile: 'production' });
    const ticket = w.stub.issueTicket(PLAYER, IDENTITY);
    const before = await exchange(w, ticket);
    expect(before.status).toBe(400);
    expect(bodyOf(before).error).toBe('invalid_grant');
    w.stub.setOwnership(PLAYER, owned(PLAYER));
    const after = await exchange(w, ticket);
    expect(after.status).toBe(200);
    const { payload } = await verified(w, bodyOf(after).id_token);
    expect(payload.sub).toBe(PLAYER_SUB);
    expect(asked(w, OWN_PATH)).toBe(2);
  });
});

const REFUSALS: ReadonlyArray<readonly [string, (w: World) => Promise<string>]> = [
  ['a ticket Steam never issued', () => Promise.resolve(madeUp('never issued'))],
  [
    'a ticket made for another identity',
    async (w) => {
      await w.accounts.setEntitled(PLAYER, true);
      return w.stub.issueTicket(PLAYER, 'another-identity');
    },
  ],
  ['a player with no flag', (w) => Promise.resolve(w.stub.issueTicket(PLAYER, IDENTITY))],
  [
    'a player flagged not entitled',
    async (w) => {
      await w.accounts.setEntitled(PLAYER, false);
      return w.stub.issueTicket(PLAYER, IDENTITY);
    },
  ],
  [
    'an entitled player on the deny-list',
    async (w) => {
      await w.accounts.setEntitled(PLAYER, true);
      await w.deny.add(PLAYER);
      return w.stub.issueTicket(PLAYER, IDENTITY);
    },
  ],
  ['a ticket that is not hex', () => Promise.resolve('not-hex-zz')],
];

describe('the grant refuses', () => {
  test.each(
    REFUSALS,
  )('%s is invalid_grant, issues nothing and writes no line acs-9.2', async (_name, prepare) => {
    const w = await world();
    const reply = await exchange(w, await prepare(w));
    expect(reply.status).toBe(400);
    expect(reply.headers['cache-control']).toBe('no-store');
    const body = bodyOf(reply);
    expect(Object.keys(body).sort()).toEqual(['error', 'error_description']);
    expect(body.error).toBe('invalid_grant');
    expect(w.lines).toEqual([]);
    expect(w.writes).toEqual([]);
  });

  test('every cause of a refusal gets the same status, body bytes and headers acs-9.2', async () => {
    const replies: Reply[] = [];
    for (const [, prepare] of REFUSALS) {
      const w = await world();
      replies.push(await exchange(w, await prepare(w)));
    }
    const production = await world({ profile: 'production' });
    replies.push(await exchange(production, production.stub.issueTicket(PLAYER, IDENTITY)));
    const first = replies[0]!;
    expect(first.status).toBe(400);
    expect(bodyOf(first).error).toBe('invalid_grant');
    expect(typeof bodyOf(first).error_description).toBe('string');
    for (const reply of replies.slice(1)) {
      expect(reply.status).toBe(first.status);
      expect(reply.body).toBe(first.body);
      expect(describing(reply.headers)).toEqual(describing(first.headers));
    }
  });

  test('a ticket that authenticated before and is refused at its next check gets invalid_grant acs-9.2', async () => {
    const w = await world();
    const ticket = await entitledTicket(w);
    expect((await exchange(w, ticket)).status).toBe(200);
    await w.deny.add(PLAYER);
    const reply = await exchange(w, ticket);
    expect(reply.status).toBe(400);
    expect(bodyOf(reply).error).toBe('invalid_grant');
    expect(asked(w, AUTH_PATH)).toBe(2);
  });
});

describe('the other answers of the token endpoint', () => {
  test('Steam failing to answer the ticket check is 503, not invalid_grant, and writes no line', async () => {
    const w = await world();
    const ticket = await entitledTicket(w);
    w.stub.respondNext('AuthenticateUserTicket', { kind: 'status', status: 500 });
    const reply = await exchange(w, ticket);
    expectNotInvalidGrant(reply, 503);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(w.lines).toEqual([]);
  });

  const missing: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ['no steam_ticket', { grant_type: GRANT, client_id: CLIENT_ID }],
    ['an empty steam_ticket', { grant_type: GRANT, client_id: CLIENT_ID, steam_ticket: '' }],
  ];
  test.each(
    missing,
  )('%s is 400, not invalid_grant, and Steam is not asked', async (_name, form) => {
    const w = await world();
    expectNotInvalidGrant(await post(w, form), 400);
    expect(asked(w, AUTH_PATH)).toBe(0);
  });

  test('steam_ticket given twice is 400 and Steam is not asked', async () => {
    const w = await world();
    const ticket = await entitledTicket(w);
    const form = new URLSearchParams([
      ['grant_type', GRANT],
      ['client_id', CLIENT_ID],
      ['steam_ticket', ticket],
      ['steam_ticket', ticket],
    ]).toString();
    const reply = await post(w, form);
    expect(reply.status).toBe(400);
    expect(reply.body).not.toContain('id_token');
    expect(asked(w, AUTH_PATH)).toBe(0);
  });

  test('a client id nobody registered is 401 and Steam is not asked', async () => {
    const w = await world();
    const reply = await exchange(w, await entitledTicket(w), { fields: { client_id: 'nobody' } });
    expect(reply.status).toBe(401);
    expect(reply.body).not.toContain('id_token');
    expect(asked(w, AUTH_PATH)).toBe(0);
  });

  test('a trusted proxy that forwards no address gets 400, not invalid_grant, and Steam is not asked', async () => {
    const w = await world();
    const reply = await exchange(w, await entitledTicket(w), { from: null });
    expectNotInvalidGrant(reply, 400);
    expect(asked(w, AUTH_PATH)).toBe(0);
    expect(w.lines).toEqual([]);
  });

  test.each([
    ['the entitlement source', 'entitlement'],
    ['the ticket check', 'authenticate'],
  ] as const)('%s rejecting is 500 with no token, and one line names the error class and not its message', async (_name, fault) => {
    const w = await world();
    const ticket = await entitledTicket(w);
    w.faults[fault] = new StoreDownError();
    const reply = await exchange(w, ticket);
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain('id_token');
    expect(reply.body).not.toContain(FAILURE_MESSAGE);
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toContain('StoreDownError');
    expect(w.lines[0]).not.toContain(FAILURE_MESSAGE);
  });

  test('a token whose line cannot be written is not handed out: 500 with no token', async () => {
    const w = await world();
    const ticket = await entitledTicket(w);
    w.faults.log = 'throws';
    const reply = await exchange(w, ticket);
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain('id_token');
    expect(reply.body).not.toContain(FAILURE_MESSAGE);
  });

  test('a log that answers with a rejected promise leaves the service answering', async () => {
    const w = await world();
    const ticket = await entitledTicket(w);
    w.faults.log = 'rejects';
    const first = await exchange(w, ticket);
    expect(first.body).not.toContain(FAILURE_MESSAGE);
    await turn();
    await turn();
    w.faults.log = undefined;
    expect((await exchange(w, ticket)).status).toBe(200);
  });

  test('a provider built without the grant answers unsupported_grant_type and does not list it', async () => {
    const w = await world({ grant: false });
    const reply = await exchange(w, await entitledTicket(w));
    expect(reply.status).toBe(400);
    expect(bodyOf(reply).error).toBe('unsupported_grant_type');
    expect(asked(w, AUTH_PATH)).toBe(0);
    const doc = bodyOf(await send(w.port, { path: DISCOVERY_PATH }));
    expect(doc.grant_types_supported as unknown[]).not.toContain(GRANT);
  });

  test('discovery lists urn:monster-realm:steam-ticket when the grant is configured', async () => {
    const w = await world();
    const doc = bodyOf(await send(w.port, { path: DISCOVERY_PATH }));
    expect(doc.grant_types_supported as unknown[]).toContain('urn:monster-realm:steam-ticket');
  });

  test('discovery names the issuer in every URL under forged forwarding headers', async () => {
    const w = await world();
    const reply = await send(w.port, {
      path: DISCOVERY_PATH,
      headers: {
        'x-forwarded-for': FORWARDED,
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        forwarded: 'host=evil.example;proto=https',
      },
    });
    expect(reply.status).toBe(200);
    const doc = bodyOf(reply);
    expect(doc.issuer).toBe(ISSUER);
    const urls = Object.entries(doc).filter(
      ([name, value]) => name !== 'issuer' && typeof value === 'string' && URL.canParse(value),
    );
    expect(urls.length).toBeGreaterThan(1);
    for (const [name, value] of urls) {
      expect(String(value).startsWith(`${ISSUER}/`), name).toBe(true);
    }
  });

  test("an Origin that is not the client's redirect origin gets no access-control-allow-origin", async () => {
    const w = await world();
    const reply = await exchange(w, await entitledTicket(w), {
      headers: { origin: 'http://evil.example' },
    });
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the log of the grant', () => {
  test('an issued token writes one line with its sub and the exchange time, and no ticket, key or address', async () => {
    clock = T0 + 4321;
    const w = await world();
    const ticket = await entitledTicket(w);
    const reply = await exchange(w, ticket.toUpperCase(), { from: '203.0.113.77' });
    expect(reply.status).toBe(200);
    expect(w.lines).toHaveLength(1);
    const line = w.lines[0]!;
    expect(line).toContain(PLAYER_SUB);
    expect(line).toContain(new Date((T0 + 4321) * 1000).toISOString());
    for (const value of [ticket, ticket.toUpperCase(), w.stub.key, '203.0.113.77', '127.0.0.1']) {
      expect(line).not.toContain(value);
    }
  });
});

describe('the windows over HTTP', () => {
  test('the 61st exchange from one forwarded address within 60 seconds is 429 and sends Steam nothing acs-9.3', async () => {
    // Made-up tickets name no SteamID, so only the address window is in play.
    const w = await world();
    for (let i = 0; i < 60; i += 1) {
      expect((await exchange(w, madeUp(`a ${i}`), { from: FORWARDED })).status).toBe(400);
    }
    expect(asked(w, AUTH_PATH)).toBe(60);
    expectLimited(await exchange(w, madeUp('a 60'), { from: FORWARDED }), 60);
    expect(asked(w, AUTH_PATH)).toBe(60);
    expect(w.lines).toEqual([]);
  });

  test('another forwarded address behind the same proxy is still answered acs-9.3', async () => {
    // Made-up tickets name no SteamID, so only the address window is in play.
    const w = await world();
    await times(60, (i) => exchange(w, madeUp(`b ${i}`), { from: FORWARDED }));
    expectLimited(await exchange(w, madeUp('b 60'), { from: FORWARDED }), 60);
    expect((await exchange(w, madeUp('b other'), { from: OTHER_FORWARDED })).status).toBe(400);
    expect(asked(w, AUTH_PATH)).toBe(61);
  });

  test('the last X-Forwarded-For entry is the source, whatever its sender put before it acs-9.3', async () => {
    // Made-up tickets name no SteamID, so only the address window is in play.
    const w = await world();
    for (let i = 0; i < 60; i += 1) {
      const from = `10.1.0.${i + 1}, ${FORWARDED}`;
      expect((await exchange(w, madeUp(`c ${i}`), { from })).status).toBe(400);
    }
    expectLimited(await exchange(w, madeUp('c 60'), { from: `10.2.0.1, ${FORWARDED}` }), 60);
    const reply = await exchange(w, madeUp('c other'), {
      from: `${FORWARDED}, ${OTHER_FORWARDED}`,
    });
    expect(reply.status).toBe(400);
    expect(asked(w, AUTH_PATH)).toBe(61);
  });

  test('without a trusted proxy a changed X-Forwarded-For does not escape the window acs-9.3', async () => {
    // Every request's source is the socket's 127.0.0.1; made-up tickets name no SteamID.
    const w = await world({ trustProxy: false });
    for (let i = 0; i < 60; i += 1) {
      expect((await exchange(w, madeUp(`d ${i}`), { from: `203.0.113.${i + 1}` })).status).toBe(
        400,
      );
    }
    expectLimited(await exchange(w, madeUp('d 60'), { from: '192.0.2.1' }), 60);
    expect(asked(w, AUTH_PATH)).toBe(60);
  });

  test('the address window answers 429 with retry-after 1 at 59 seconds and lets an exchange through at 60 acs-9.3', async () => {
    // Made-up tickets name no SteamID, so only the address window is in play.
    const w = await world();
    await times(60, (i) => exchange(w, madeUp(`e ${i}`), { from: FORWARDED }));
    clock = T0 + 59;
    expectLimited(await exchange(w, madeUp('e 59'), { from: FORWARDED }), 1);
    expect(asked(w, AUTH_PATH)).toBe(60);
    clock = T0 + 60;
    expect((await exchange(w, madeUp('e 60'), { from: FORWARDED })).status).toBe(400);
    expect(asked(w, AUTH_PATH)).toBe(61);
  });

  test('the 31st exchange of one SteamID is 429, and its remembered ticket sends Steam nothing acs-9.3', async () => {
    // Each request comes from a forwarded address of its own, so only the SteamID window is in play.
    const w = await world();
    const tickets: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const ticket = await entitledTicket(w);
      tickets.push(ticket);
      expect((await exchange(w, ticket)).status).toBe(200);
    }
    expect(asked(w, AUTH_PATH)).toBe(30);
    expectLimited(await exchange(w, tickets[0]!), 3600);
    expect(asked(w, AUTH_PATH)).toBe(30);
    expectLimited(await exchange(w, await entitledTicket(w)), 3600);
    expect(asked(w, AUTH_PATH)).toBe(31);
    expect(w.lines).toHaveLength(30);
  });

  test('on production a player over the SteamID window is 429 with no CheckAppOwnership request acs-9.3', async () => {
    // Each request comes from a forwarded address of its own, so only the SteamID window is in play.
    const w = await world({ profile: 'production' });
    for (let i = 0; i < 30; i += 1) {
      expect((await exchange(w, await entitledTicket(w))).status).toBe(200);
    }
    expect(asked(w, OWN_PATH)).toBe(30);
    expectLimited(await exchange(w, await entitledTicket(w)), 3600);
    expect(asked(w, AUTH_PATH)).toBe(31);
    expect(asked(w, OWN_PATH)).toBe(30);
  });

  test('an ownership outage on production answers 503 and spends nothing of the window acs-9.3', async () => {
    // Each request comes from a forwarded address of its own, so only the SteamID window is in play.
    const w = await world({ profile: 'production' });
    const ticket = await entitledTicket(w);
    for (let i = 0; i < 30; i += 1) {
      w.stub.respondNext('CheckAppOwnership', { kind: 'status', status: 500 });
      expectNotInvalidGrant(await exchange(w, ticket), 503);
    }
    expect(w.lines).toEqual([]);
    for (let i = 0; i < 30; i += 1) {
      expect((await exchange(w, await entitledTicket(w))).status).toBe(200);
    }
    expect(asked(w, OWN_PATH)).toBe(60);
    expectLimited(await exchange(w, await entitledTicket(w)), 3600);
    expect(asked(w, OWN_PATH)).toBe(60);
  });

  test("made-up tickets sent with a player's steamid spend nothing of that player's window acs-9.3", async () => {
    // Each request comes from a forwarded address of its own, so only the SteamID window is in play.
    const w = await world();
    for (let i = 0; i < 40; i += 1) {
      const reply = await exchange(w, madeUp(`f ${i}`), { fields: { steamid: PLAYER } });
      expect(reply.status).toBe(400);
      expect(bodyOf(reply).error).toBe('invalid_grant');
    }
    for (let i = 0; i < 30; i += 1) {
      expect((await exchange(w, await entitledTicket(w))).status).toBe(200);
    }
    expectLimited(await exchange(w, await entitledTicket(w)), 3600);
  });

  test('thirty-five exchanges at once for one SteamID issue thirty tokens acs-9.3', async () => {
    // Each request comes from a forwarded address of its own, so only the SteamID window is in play.
    const w = await world();
    await w.accounts.setEntitled(PLAYER, true);
    const tickets = Array.from({ length: 35 }, () => w.stub.issueTicket(PLAYER, IDENTITY));
    const replies = await Promise.all(tickets.map((ticket) => exchange(w, ticket)));
    expect(replies.filter((reply) => reply.status === 200)).toHaveLength(30);
    expect(replies.filter((reply) => reply.status === 429)).toHaveLength(5);
    expect(w.lines).toHaveLength(30);
  });
});
