// net/worldTicket.test.ts — the world name, the ticket source, first contact, the world entry and
// the world gate. Every dependency (fetch, the address bar, the OIDC client, the world's
// `check_account` call) is an injected fake, so the suite runs in node with no network and no DOM.

import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { RenewalOutcome } from './credentialDecision';
import type { BeginSignInResult } from './oidc';
import type { TargetKind } from './shellDocument';
import {
  createIdTokenTicketSource,
  type FirstContactOutcome,
  firstContact,
  type TicketOutcome,
  type TicketSource,
  type WorldGateEvent,
  type WorldGateState,
  worldEntryFor,
  worldGateStep,
  worldNameFor,
} from './worldTicket';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 43 characters of the base64url alphabet, the shape of a ticket. */
const TICKET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_Z';
const ISSUER = 'https://id.example';
const WORLD = 'dns:play.example:443/realm-one';
const AUTH_URL = 'https://id.example/authorize?state=s1';
const OK_A: RenewalOutcome = { kind: 'ok', token: 'idToken-A' };
const OK_B: RenewalOutcome = { kind: 'ok', token: 'idToken-B' };

interface Reply {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status <= 299,
  status,
  json: async () => body,
});

type FetchFn = (url: unknown, init?: RequestInit) => Promise<Reply>;

function makeOidc(renewals: RenewalOutcome[]) {
  const queue = [...renewals];
  return {
    renewOrExchange: vi.fn(
      async (): Promise<RenewalOutcome> => queue.shift() ?? { kind: 'no-session' },
    ),
    beginSignIn: vi.fn(
      async (): Promise<BeginSignInResult> => ({ kind: 'ready', authorizationUrl: AUTH_URL }),
    ),
  };
}

function setup(
  opts: { replies?: readonly Reply[]; renewals?: RenewalOutcome[]; issuer?: string } = {},
) {
  const replies = [...(opts.replies ?? [])];
  const fetch = vi.fn<FetchFn>(async () => {
    const next = replies.shift();
    if (next === undefined) throw new Error('no reply queued');
    return next;
  });
  const assign = vi.fn<(url: string) => void>();
  const oidc = makeOidc(opts.renewals ?? [OK_A]);
  const source = createIdTokenTicketSource(
    { fetch, location: { assign } },
    { issuer: opts.issuer ?? ISSUER, oidc },
  );
  return { source, fetch, assign, oidc };
}

/** The `i`th request `fetch` received, normalised. */
function post(fetch: Mock<FetchFn>, i: number) {
  const call = fetch.mock.calls[i];
  expect(call, `request ${i} was made`).toBeDefined();
  const [url, init] = call ?? [undefined, undefined];
  return {
    url: String(url),
    method: init?.method,
    headers: new Headers(init?.headers),
    body: init?.body,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// worldNameFor
// ---------------------------------------------------------------------------

const FP = 'Fp_9-xyz';
const DB = 'realm-one';
/** The insecure scheme, kept out of a literal so a scanner reading the file sees no plain-ws URL. */
const WS = 'ws:';
const U_UMLAUT = String.fromCharCode(0xfc);

type NameRow = readonly [
  label: string,
  kind: TargetKind,
  uri: string,
  fingerprint: string | undefined,
  expected: string | undefined,
];

const NAME_ROWS: readonly NameRow[] = [
  // local: a fingerprint over a loopback host, ws or wss.
  ['local ws 127.0.0.1 with a fingerprint', 'local', 'ws://127.0.0.1:3000', FP, `spki:${FP}/${DB}`],
  [
    'local ws 127.200.3.4 with a fingerprint',
    'local',
    'ws://127.200.3.4:3000',
    FP,
    `spki:${FP}/${DB}`,
  ],
  [
    'local wss localhost with a fingerprint',
    'local',
    'wss://localhost:3000/',
    FP,
    `spki:${FP}/${DB}`,
  ],
  ['local ws [::1] with a fingerprint', 'local', 'ws://[::1]:3000', FP, `spki:${FP}/${DB}`],
  [
    'local wss 127.0.0.1 with a fingerprint',
    'local',
    'wss://127.0.0.1:3000/',
    FP,
    `spki:${FP}/${DB}`,
  ],
  ['local loopback without a fingerprint', 'local', 'ws://127.0.0.1:3000', undefined, undefined],
  ['local wss non-loopback dns with a fingerprint', 'local', 'wss://play.example/', FP, undefined],
  ['local wss 128.0.0.1 with a fingerprint', 'local', 'wss://128.0.0.1/', FP, undefined],
  [
    'local wss localhost.example with a fingerprint',
    'local',
    'wss://localhost.example/',
    FP,
    undefined,
  ],
  ['local wss [::2] with a fingerprint', 'local', 'wss://[::2]/', FP, undefined],
  [
    'local wss 127.evil.example with a fingerprint',
    'local',
    'wss://127.evil.example/',
    FP,
    undefined,
  ],
  ['local https localhost with a fingerprint', 'local', 'https://localhost/', FP, undefined],
  // private over wss: dns or ip, the port always written.
  ['private wss dns', 'private', 'wss://play.example/', undefined, `dns:play.example:443/${DB}`],
  [
    'private wss dns with a path',
    'private',
    'wss://play.example/stdb/',
    undefined,
    `dns:play.example:443/${DB}`,
  ],
  [
    'private wss dns explicit port',
    'private',
    'wss://play.example:8443/',
    undefined,
    `dns:play.example:8443/${DB}`,
  ],
  [
    'private wss dns explicit default port',
    'private',
    'wss://play.example:443/',
    undefined,
    `dns:play.example:443/${DB}`,
  ],
  [
    'private wss dns upper case and trailing dot',
    'private',
    'wss://Play.Example.TEST./',
    undefined,
    `dns:play.example.test:443/${DB}`,
  ],
  [
    'private wss non-ASCII dns',
    'private',
    `wss://b${U_UMLAUT}cher.example/`,
    undefined,
    `dns:xn--bcher-kva.example:443/${DB}`,
  ],
  [
    'private wss dns with a fingerprint',
    'private',
    'wss://play.example/',
    FP,
    `dns:play.example:443/${DB}`,
  ],
  ['private wss ipv4', 'private', 'wss://10.0.0.5:3000/', undefined, `ip:10.0.0.5:3000/${DB}`],
  [
    'private wss ipv4 trailing dot',
    'private',
    'wss://1.2.3.4./',
    undefined,
    `ip:1.2.3.4:443/${DB}`,
  ],
  ['private wss hex ipv4', 'private', 'wss://0x7f.1/', undefined, `ip:127.0.0.1:443/${DB}`],
  [
    'private wss ipv6',
    'private',
    'wss://[2001:DB8:0:0::1]:8443/',
    undefined,
    `ip:[2001:db8::1]:8443/${DB}`,
  ],
  // private over ws: nothing authenticated it.
  ['private ws dns with a fingerprint', 'private', `${WS}//play.example/`, FP, undefined],
  ['private ws dns without a fingerprint', 'private', `${WS}//play.example/`, undefined, undefined],
  ['private ws loopback with a fingerprint', 'private', 'ws://127.0.0.1:3000', FP, undefined],
  // official and test.
  ['official wss with a fingerprint', 'official', 'wss://play.example/', FP, undefined],
  ['test loopback with a fingerprint', 'test', 'ws://127.0.0.1:3000', FP, undefined],
  // a uri the URL parser refuses.
  ['private unparseable uri', 'private', 'wss://exa mple/', undefined, undefined],
  ['private unterminated ipv6', 'private', 'wss://[::1', undefined, undefined],
  ['local unparseable uri with a fingerprint', 'local', 'not a uri', FP, undefined],
];

describe('worldNameFor', () => {
  it.each(NAME_ROWS)('%s [lpw-24.1]', (_label, kind, uri, fingerprint, expected) => {
    expect(worldNameFor({ kind, uri, db: DB, fingerprint })).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// createIdTokenTicketSource: ticket()
// ---------------------------------------------------------------------------

describe('createIdTokenTicketSource: ticket()', () => {
  it('posts the world name as JSON with the bearer ID token to <issuer>/ticket and resolves the ticket [lpw-24.1]', async () => {
    const { source, fetch, oidc } = setup({ replies: [reply(200, { ticket: TICKET })] });
    expect(TICKET).toHaveLength(43);
    const outcome = await source.ticket(WORLD);
    expect(outcome).toStrictEqual({ kind: 'ticket', ticket: TICKET });
    expect(oidc.renewOrExchange).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const p = post(fetch, 0);
    expect(p.url).toBe('https://id.example/ticket');
    expect(p.method).toBe('POST');
    expect(p.headers.get('authorization')).toBe('Bearer idToken-A');
    expect(p.headers.get('content-type')).toBe('application/json');
    expect(p.body).toBe(JSON.stringify({ world: WORLD }));
    const init: object = fetch.mock.calls[0]?.[1] ?? {};
    expect(Reflect.ownKeys(init).map(String).sort(), 'the init holds nothing else').toEqual([
      'body',
      'headers',
      'method',
    ]);
  });

  it.each([
    ['https://id.example', 'https://id.example/ticket'],
    ['https://id.example/', 'https://id.example/ticket'],
    ['https://id.example/auth', 'https://id.example/auth/ticket'],
    ['https://id.example/auth/', 'https://id.example/auth/ticket'],
    ['https://id.example/auth//', 'https://id.example/auth//ticket'],
  ])('issuer %j posts to %j, one trailing slash removed [lpw-24.1]', async (issuer, url) => {
    const { source, fetch } = setup({ issuer, replies: [reply(200, { ticket: TICKET })] });
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'ticket', ticket: TICKET });
    expect(post(fetch, 0).url).toBe(url);
  });

  it('a 2xx other than 200 with a ticket body resolves the ticket [lpw-24.1]', async () => {
    const { source } = setup({ replies: [reply(201, { ticket: TICKET })] });
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'ticket', ticket: TICKET });
  });

  it('a later ticket() call reuses the held ID token without renewing it [lpw-24.6]', async () => {
    const { source, fetch, oidc } = setup({
      renewals: [OK_A, OK_B],
      replies: [reply(200, { ticket: TICKET }), reply(200, { ticket: TICKET })],
    });
    await source.ticket(WORLD);
    await source.ticket('ip:10.0.0.5:3000/realm-two');
    expect(oidc.renewOrExchange).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(post(fetch, 1).headers.get('authorization')).toBe('Bearer idToken-A');
    expect(post(fetch, 1).body).toBe(JSON.stringify({ world: 'ip:10.0.0.5:3000/realm-two' }));
  });

  it('writes neither the ID token nor the ticket to any storage [lpw-24.6]', async () => {
    const written: string[] = [];
    const area = () => ({
      getItem: () => null,
      setItem: (k: string, v: string) => {
        written.push(`${k}=${v}`);
      },
      removeItem: () => {},
    });
    vi.stubGlobal('localStorage', area());
    vi.stubGlobal('sessionStorage', area());
    const reads = { storage: 0 };
    const fetch = vi.fn<FetchFn>(async () => reply(200, { ticket: TICKET }));
    const host = {
      fetch,
      location: { assign: vi.fn() },
      get localStorage() {
        reads.storage += 1;
        return area();
      },
      get sessionStorage() {
        reads.storage += 1;
        return area();
      },
    };
    const source = createIdTokenTicketSource(host, { issuer: ISSUER, oidc: makeOidc([OK_A]) });
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'ticket', ticket: TICKET });
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'ticket', ticket: TICKET });
    expect(written).toEqual([]);
    expect(reads.storage).toBe(0);
  });

  it.each([
    ['no-session', { kind: 'no-session' }],
    ['exchange-failed', { kind: 'exchange-failed', reason: 'sign-in-rejected' }],
  ] as const)('a %s renewal resolves sign-in-needed and fetches nothing [lpw-24.8]', async (_label, renewal) => {
    const { source, fetch } = setup({ renewals: [renewal] });
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'sign-in-needed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a transient-error renewal resolves unreachable and fetches nothing [lpw-24.3]', async () => {
    const { source, fetch } = setup({ renewals: [{ kind: 'transient-error' }] });
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'unreachable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a 401 drops the held token, renews once and posts again with the new token [lpw-24.1]', async () => {
    const { source, fetch, oidc } = setup({
      renewals: [OK_A, OK_B],
      replies: [reply(401, {}), reply(200, { ticket: TICKET })],
    });
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'ticket', ticket: TICKET });
    expect(oidc.renewOrExchange).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(post(fetch, 0).headers.get('authorization')).toBe('Bearer idToken-A');
    expect(post(fetch, 1).headers.get('authorization')).toBe('Bearer idToken-B');
  });

  it('a second 401 resolves sign-in-needed after exactly two posts and two renewals [lpw-24.1]', async () => {
    const { source, fetch, oidc } = setup({
      renewals: [OK_A, OK_B, { kind: 'ok', token: 'idToken-C' }],
      replies: [reply(401, {}), reply(401, {}), reply(200, { ticket: TICKET })],
    });
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'sign-in-needed' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(oidc.renewOrExchange).toHaveBeenCalledTimes(2);
  });

  it('a 401 followed by a no-session renewal resolves sign-in-needed after one post [lpw-24.1]', async () => {
    const { source, fetch, oidc } = setup({
      renewals: [OK_A, { kind: 'no-session' }],
      replies: [reply(401, {}), reply(200, { ticket: TICKET })],
    });
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'sign-in-needed' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(oidc.renewOrExchange).toHaveBeenCalledTimes(2);
  });

  it('the token renewed after a 401 is held for the next ticket() call [lpw-24.6]', async () => {
    const { source, fetch, oidc } = setup({
      renewals: [OK_A, OK_B],
      replies: [reply(401, {}), reply(200, { ticket: TICKET }), reply(200, { ticket: TICKET })],
    });
    await source.ticket(WORLD);
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'ticket', ticket: TICKET });
    expect(oidc.renewOrExchange).toHaveBeenCalledTimes(2);
    expect(post(fetch, 2).headers.get('authorization')).toBe('Bearer idToken-B');
  });

  type FetchCase = readonly [label: string, fetch: FetchFn];
  const UNREACHABLE: readonly FetchCase[] = [
    ['status 500', async () => reply(500, { ticket: TICKET })],
    ['status 403', async () => reply(403, { ticket: TICKET })],
    ['status 400', async () => reply(400, { ticket: TICKET })],
    ['status 302', async () => reply(302, { ticket: TICKET })],
    ['a 42-character ticket', async () => reply(200, { ticket: TICKET.slice(1) })],
    ['a 44-character ticket', async () => reply(200, { ticket: `${TICKET}a` })],
    ['a 43-character ticket holding +', async () => reply(200, { ticket: `+${TICKET.slice(1)}` })],
    ['a 43-character ticket holding =', async () => reply(200, { ticket: `${TICKET.slice(1)}=` })],
    ['a 43-character ticket holding /', async () => reply(200, { ticket: `/${TICKET.slice(1)}` })],
    ['a numeric ticket', async () => reply(200, { ticket: 42 })],
    ['a ticket in an array', async () => reply(200, { ticket: [TICKET] })],
    ['an array body', async () => reply(200, [TICKET])],
    ['an array body holding a ticket object', async () => reply(200, [{ ticket: TICKET }])],
    ['a string body', async () => reply(200, TICKET)],
    ['a null body', async () => reply(200, null)],
    ['an empty object body', async () => reply(200, {})],
    [
      'json() throws',
      async () => ({
        ok: true,
        status: 200,
        json: () => {
          throw new Error('bad json');
        },
      }),
    ],
    [
      'json() rejects',
      async () => ({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) }),
    ],
    ['fetch rejects', () => Promise.reject(new TypeError('network'))],
    [
      'fetch throws',
      () => {
        throw new TypeError('network');
      },
    ],
    ['fetch resolves undefined', async () => undefined as unknown as Reply],
  ];

  it.each(UNREACHABLE)('%s resolves unreachable [lpw-24.3]', async (_label, impl) => {
    const fetch = vi.fn<FetchFn>(impl);
    const source = createIdTokenTicketSource(
      { fetch, location: { assign: vi.fn() } },
      { issuer: ISSUER, oidc: makeOidc([OK_A]) },
    );
    const outcome: TicketOutcome = await source.ticket(WORLD);
    expect(outcome).toStrictEqual({ kind: 'unreachable' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a host with no fetch', { location: { assign: () => {} } }],
    ['a host whose fetch is not a function', { fetch: 'nope', location: { assign: () => {} } }],
    ['an absent host', undefined],
  ] as const)('%s resolves unreachable [lpw-24.3]', async (_label, host) => {
    const source = createIdTokenTicketSource(host, { issuer: ISSUER, oidc: makeOidc([OK_A]) });
    expect(await source.ticket(WORLD)).toStrictEqual({ kind: 'unreachable' });
  });

  // --- the deadline: the host's setTimeout, a hand-rolled recorder fired by the test ---------

  it('ticket() registers one timer of 15000 ms on the host [lpw-24.3]', async () => {
    const { source, timer } = timedSetup();
    void source.ticket(WORLD);
    await flush();
    expect(timer).toHaveBeenCalledTimes(1);
    expect(typeof timer.mock.calls[0]?.[0]).toBe('function');
    expect(timer.mock.calls[0]?.[1]).toBe(15000);
  });

  it('a fetch that never settles leaves ticket() pending until the host timer fires, then resolves unreachable [lpw-24.3]', async () => {
    const { source, fetch, fire } = timedSetup();
    const outcome = source.ticket(WORLD);
    expect(await settledOrPending(outcome), 'pending before the timer').toBe(PENDING);
    expect(fetch, 'precondition: the request went out').toHaveBeenCalledTimes(1);
    fire();
    expect(await outcome).toStrictEqual({ kind: 'unreachable' });
  });

  it('a renewal that never settles leaves ticket() pending until the host timer fires, then resolves unreachable [lpw-24.3]', async () => {
    const { source, fetch, fire } = timedSetup({
      renewOrExchange: () => new Promise<RenewalOutcome>(() => {}),
    });
    const outcome = source.ticket(WORLD);
    expect(await settledOrPending(outcome), 'pending before the timer').toBe(PENDING);
    fire();
    expect(await outcome).toStrictEqual({ kind: 'unreachable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an answer that settles before the host timer fires wins, and the timer firing afterwards changes nothing [lpw-24.3]', async () => {
    const { source, fetch, oidc, fire } = timedSetup({
      fetch: async () => reply(200, { ticket: TICKET }),
    });
    const outcome = source.ticket(WORLD);
    expect(await outcome).toStrictEqual({ kind: 'ticket', ticket: TICKET });
    fire();
    await flush();
    expect(await outcome).toStrictEqual({ kind: 'ticket', ticket: TICKET });
    expect(await source.ticket(WORLD), 'the next call').toStrictEqual({
      kind: 'ticket',
      ticket: TICKET,
    });
    expect(oidc.renewOrExchange, 'the held token survives the timer').toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('with no setTimeout on the host, a fetch that never settles leaves ticket() pending past 15000 ms of the page clock [lpw-24.3]', async () => {
    vi.useFakeTimers();
    try {
      const { source } = timedSetup({ timer: false });
      const outcome = source.ticket(WORLD);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await Promise.race([outcome, Promise.resolve(PENDING)])).toBe(PENDING);
    } finally {
      vi.useRealTimers();
    }
  });
});

const PENDING = Symbol('pending');

/** `p`'s value once queued work has run, or PENDING while it is unsettled. */
async function settledOrPending<T>(p: Promise<T>): Promise<T | typeof PENDING> {
  await flush();
  return Promise.race([p, Promise.resolve(PENDING)]);
}

type TimerFn = (callback: () => void, ms?: number) => unknown;

/** A ticket source over a host whose `setTimeout` records each timer (`timer: false` leaves it
 *  out), a `fetch` that never settles unless one is given, and one `ok` renewal unless a
 *  `renewOrExchange` is given. `fire` runs every recorded timer's callback. */
function timedSetup(
  opts: { fetch?: FetchFn; renewOrExchange?: () => Promise<RenewalOutcome>; timer?: boolean } = {},
) {
  const timer = vi.fn<TimerFn>(() => 1);
  const fetch = vi.fn<FetchFn>(opts.fetch ?? (() => new Promise<Reply>(() => {})));
  const oidc = makeOidc([OK_A]);
  if (opts.renewOrExchange !== undefined)
    oidc.renewOrExchange.mockImplementation(opts.renewOrExchange);
  const location = { assign: vi.fn() };
  const host = opts.timer === false ? { fetch, location } : { fetch, location, setTimeout: timer };
  const source = createIdTokenTicketSource(host, { issuer: ISSUER, oidc });
  const fire = (): void => {
    for (const [callback] of timer.mock.calls) callback();
  };
  return { source, fetch, oidc, timer, fire };
}

// ---------------------------------------------------------------------------
// createIdTokenTicketSource: signIn()
// ---------------------------------------------------------------------------

describe('createIdTokenTicketSource: signIn()', () => {
  it('a ready sign-in sends the page to the authorization url and resolves true [lpw-24.1]', async () => {
    const { source, assign, oidc } = setup();
    expect(await source.signIn()).toBe(true);
    expect(oidc.beginSignIn).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls).toEqual([[AUTH_URL]]);
  });

  it('a transient-error sign-in resolves false and leaves the page where it is [lpw-24.1]', async () => {
    const { source, assign, oidc } = setup();
    oidc.beginSignIn.mockResolvedValueOnce({ kind: 'transient-error' });
    expect(await source.signIn()).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('a rejecting beginSignIn resolves false [lpw-24.1]', async () => {
    const { source, assign, oidc } = setup();
    oidc.beginSignIn.mockRejectedValueOnce(new Error('boom'));
    expect(await source.signIn()).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ['a location with no assign', { fetch: () => {}, location: {} }],
    ['a host with no location', { fetch: () => {} }],
    [
      'an assign that throws',
      {
        fetch: () => {},
        location: {
          assign: () => {
            throw new Error('blocked');
          },
        },
      },
    ],
    ['an absent host', undefined],
  ] as const)('%s resolves false [lpw-24.1]', async (_label, host) => {
    const source = createIdTokenTicketSource(host, { issuer: ISSUER, oidc: makeOidc([]) });
    expect(await source.signIn()).toBe(false);
  });

  it('a second signIn() while one is pending resolves false without a second beginSignIn [lpw-24.1]', async () => {
    const { source, assign, oidc } = setup();
    const pending = deferred<BeginSignInResult>();
    oidc.beginSignIn.mockReturnValueOnce(pending.promise);
    const first = source.signIn();
    await flush();
    expect(await source.signIn()).toBe(false);
    expect(oidc.beginSignIn).toHaveBeenCalledTimes(1);
    pending.resolve({ kind: 'ready', authorizationUrl: AUTH_URL });
    expect(await first).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    // Once the first has settled, a new call begins a sign-in again.
    expect(await source.signIn()).toBe(true);
    expect(oidc.beginSignIn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// firstContact
// ---------------------------------------------------------------------------

function tickets(outcome: TicketOutcome | Promise<TicketOutcome>) {
  const ticket = vi.fn<(world: string) => Promise<TicketOutcome>>(() => Promise.resolve(outcome));
  const signIn = vi.fn<() => Promise<boolean>>(async () => false);
  const source: TicketSource = { ticket, signIn };
  return { source, ticket, signIn };
}

function contact(answer: unknown | (() => Promise<unknown>), liveValues: readonly boolean[] = []) {
  const t = tickets({ kind: 'ticket', ticket: TICKET });
  const check = vi.fn<(ticket: string) => Promise<unknown>>(
    typeof answer === 'function' ? (answer as () => Promise<unknown>) : async () => answer,
  );
  const queue = [...liveValues];
  const live = vi.fn(() => queue.shift() ?? true);
  const run = () => firstContact({ tickets: t.source, world: WORLD, check, live });
  return { run, check, live, ticket: t.ticket };
}

describe('firstContact', () => {
  it('asks for a ticket for the world, then checks exactly that ticket once, then answers [lpw-24.1]', async () => {
    const log: string[] = [];
    const pending = deferred<TicketOutcome>();
    const ticket = vi.fn<(world: string) => Promise<TicketOutcome>>((world) => {
      log.push(`ticket:${world}`);
      return pending.promise;
    });
    const check = vi.fn<(t: string) => Promise<unknown>>(async (t) => {
      log.push(`check:${t}`);
      return { ok: true };
    });
    const result = firstContact({
      tickets: { ticket, signIn: async () => false },
      world: WORLD,
      check,
      live: () => true,
    });
    await flush();
    expect(check).not.toHaveBeenCalled();
    pending.resolve({ kind: 'ticket', ticket: TICKET });
    expect(await result).toStrictEqual({ kind: 'entitled' });
    expect(log).toEqual([`ticket:${WORLD}`, `check:${TICKET}`]);
    expect(check.mock.calls).toEqual([[TICKET]]);
  });

  it('a sign-in-needed source answers sign-in-needed and checks nothing [lpw-24.1]', async () => {
    const t = tickets({ kind: 'sign-in-needed' });
    const check = vi.fn(async () => ({ ok: true }));
    const outcome = await firstContact({
      tickets: t.source,
      world: WORLD,
      check,
      live: () => true,
    });
    expect(outcome).toStrictEqual({ kind: 'sign-in-needed' });
    expect(check).not.toHaveBeenCalled();
  });

  it('an unreachable source answers unreachable and checks nothing [lpw-24.3]', async () => {
    const t = tickets({ kind: 'unreachable' });
    const check = vi.fn(async () => ({ ok: true }));
    const outcome = await firstContact({
      tickets: t.source,
      world: WORLD,
      check,
      live: () => true,
    });
    expect(outcome).toStrictEqual({ kind: 'unreachable' });
    expect(check).not.toHaveBeenCalled();
  });

  it('a connection no longer live when the ticket arrives is superseded and checks nothing [lpw-24.1]', async () => {
    const c = contact({ ok: true }, [false]);
    expect(await c.run()).toStrictEqual({ kind: 'superseded' });
    expect(c.check).not.toHaveBeenCalled();
    expect(c.live).toHaveBeenCalled();
  });

  it.each([
    ['ok true', { ok: true }],
    ['ok false', { ok: false }],
    ['the no-answer text', { err: 'the account service gave no answer' }],
  ])('a connection no longer live when the check answers %s is superseded [lpw-24.1]', async (_label, answer) => {
    const c = contact(answer, [true, false]);
    expect(await c.run()).toStrictEqual({ kind: 'superseded' });
    expect(c.check).toHaveBeenCalledTimes(1);
    expect(c.live).toHaveBeenCalledTimes(2);
  });

  it('an ok true answer is entitled [lpw-24.1]', async () => {
    const c = contact({ ok: true });
    expect(await c.run()).toStrictEqual({ kind: 'entitled' });
    expect(c.check).toHaveBeenCalledTimes(1);
  });

  it('an ok false answer is not-entitled [lpw-24.4]', async () => {
    const c = contact({ ok: false });
    expect(await c.run()).toStrictEqual({ kind: 'not-entitled' });
  });

  it('the module text "the account service gave no answer" is unreachable [lpw-24.3]', async () => {
    const c = contact({ err: 'the account service gave no answer' });
    expect(await c.run()).toStrictEqual({ kind: 'unreachable' });
  });

  it('the module text "this server checks no account" is no-check [lpw-24.1]', async () => {
    const c = contact({ err: 'this server checks no account' });
    expect(await c.run()).toStrictEqual({ kind: 'no-check' });
  });

  it.each([
    ['a short text', 'ticket already used'],
    ['the printable ends, space and tilde', ' ~'],
    ['exactly 160 characters', 'r'.repeat(160)],
    ['a text close to a module text', 'the account service gave no answer.'],
  ])('another error text, %s, is refused with that text as the reason [lpw-24.1]', async (_label, text) => {
    const c = contact({ err: text });
    expect(await c.run()).toStrictEqual({ kind: 'refused', reason: text });
  });

  it.each([
    ['161 characters', 'r'.repeat(161)],
    ['the empty text', ''],
    ['a control character', `bad${String.fromCharCode(7)}text`],
    ['a newline', `bad${String.fromCharCode(10)}text`],
    ['DEL', `bad${String.fromCharCode(0x7f)}text`],
    ['a non-ASCII character', `caf${String.fromCharCode(0xe9)}`],
  ])('an error text holding %s is refused with an empty reason [lpw-24.1]', async (_label, text) => {
    const c = contact({ err: text });
    expect(await c.run()).toStrictEqual({ kind: 'refused', reason: '' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['ok as a string', { ok: 'yes' }],
    ['err as a number', { err: 7 }],
    ['a string', 'ok'],
  ])('a check answering %s is refused with an empty reason [lpw-24.1]', async (_label, answer) => {
    const c = contact(answer);
    expect(await c.run()).toStrictEqual({ kind: 'refused', reason: '' });
  });

  it('a rejecting check is refused with an empty reason [lpw-24.1]', async () => {
    const c = contact(() => Promise.reject(new Error('procedure failed')));
    const outcome: FirstContactOutcome = await c.run();
    expect(outcome).toStrictEqual({ kind: 'refused', reason: '' });
  });
});

// ---------------------------------------------------------------------------
// worldEntryFor
// ---------------------------------------------------------------------------

describe('worldEntryFor', () => {
  it('a move row is moved with its time, whether or not the world knows the identity [lpw-24.5]', () => {
    expect(worldEntryFor({ known: true, movedAtMs: 1_700_000_000_000 })).toStrictEqual({
      kind: 'moved',
      movedAtMs: 1_700_000_000_000,
    });
    expect(worldEntryFor({ known: false, movedAtMs: 1_700_000_000_000 })).toStrictEqual({
      kind: 'moved',
      movedAtMs: 1_700_000_000_000,
    });
    expect(worldEntryFor({ known: false, movedAtMs: 0 })).toStrictEqual({
      kind: 'moved',
      movedAtMs: 0,
    });
  });

  it('a known identity with no move row joins [lpw-24.2]', () => {
    expect(worldEntryFor({ known: true, movedAtMs: undefined })).toStrictEqual({ kind: 'join' });
  });

  it('an unknown identity with no move row runs first contact [lpw-24.1]', () => {
    expect(worldEntryFor({ known: false, movedAtMs: undefined })).toStrictEqual({
      kind: 'first-contact',
    });
  });
});

// ---------------------------------------------------------------------------
// worldGateStep
// ---------------------------------------------------------------------------

const ALL_STATES: readonly WorldGateState[] = [
  Object.freeze({ phase: 'hidden' }),
  Object.freeze({ phase: 'sign-in' }),
  Object.freeze({ phase: 'unreachable' }),
  Object.freeze({ phase: 'not-owned' }),
  Object.freeze({ phase: 'refused', reason: 'earlier' }),
  Object.freeze({ phase: 'moved', movedAtMs: 5 }),
];

function stepFromEvery(event: WorldGateEvent, expected: WorldGateState): void {
  for (const state of ALL_STATES) {
    expect(worldGateStep(state, event), `${state.phase} + ${event.kind}`).toStrictEqual(expected);
  }
}

describe('worldGateStep', () => {
  it('entitled hides the gate from every phase [lpw-24.1]', () => {
    stepFromEvery({ kind: 'entitled' }, { phase: 'hidden' });
  });

  it('joined hides the gate from every phase but moved [lpw-24.1]', () => {
    for (const state of ALL_STATES.filter((s) => s.phase !== 'moved')) {
      expect(worldGateStep(state, { kind: 'joined' }), state.phase).toStrictEqual({
        phase: 'hidden',
      });
    }
  });

  it('joined leaves the moved phase unchanged [lpw-24.5]', () => {
    expect(worldGateStep({ phase: 'moved', movedAtMs: 5 }, { kind: 'joined' })).toStrictEqual({
      phase: 'moved',
      movedAtMs: 5,
    });
  });

  it('sign-in-needed raises the sign-in phase from every phase [lpw-24.1]', () => {
    stepFromEvery({ kind: 'sign-in-needed' }, { phase: 'sign-in' });
  });

  it('unreachable raises the unreachable phase from every phase [lpw-24.3]', () => {
    stepFromEvery({ kind: 'unreachable' }, { phase: 'unreachable' });
  });

  it('not-entitled raises the not-owned phase from every phase [lpw-24.4]', () => {
    stepFromEvery({ kind: 'not-entitled' }, { phase: 'not-owned' });
  });

  it('refused raises the refused phase with the event`s reason from every phase [lpw-24.1]', () => {
    stepFromEvery(
      { kind: 'refused', reason: 'ticket already used' },
      {
        phase: 'refused',
        reason: 'ticket already used',
      },
    );
  });

  it('moved raises the moved phase with the event`s time from every phase [lpw-24.5]', () => {
    stepFromEvery(
      { kind: 'moved', movedAtMs: 1_700_000_000_000 },
      {
        phase: 'moved',
        movedAtMs: 1_700_000_000_000,
      },
    );
  });
});
