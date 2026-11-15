// @vitest-environment happy-dom
/**
 * connection.runtime.test.ts: drives the REAL connect() through each credential decision with
 * the SDK's DbConnection builder and the OIDC client mocked, and asserts what actually reaches
 * the builder (withToken), what is persisted, and how the retry ladder behaves.
 *
 * Replaces the connection.ts text pins (ledger CT-src-net-connection#credential-wiring).
 * credentialDecision.ts's pure logic has its own tests; this file covers its WIRING in connect().
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  type MockInstance,
  vi,
} from 'vitest';
import { writeAuthKind } from './authToken';
import { claimCode } from './claimCode';
import { type ConnectionOptions, connect } from './connection';
import type { RenewalOutcome } from './credentialDecision';
import { AuthoritativeStore } from './store';
import { OWNER_VIEWS, type OwnerView } from './viewReconcile';
import { APPLY_TIMEOUT_MS, LINGER_MS } from './worldScope';

type Cb = (...args: unknown[]) => void;
/** One `subscriptionBuilder().subscribe(...)` call on the connection handed to onConnect. */
interface SubRec {
  /** The base set's string list, or one world-scope query string. */
  query: readonly string[] | string | undefined;
  onApplied?: Cb;
  onError?: Cb;
  /** What the handle's `isActive()` answers; a test sets it when it applies the set. */
  active: boolean;
  unsubscribes: number;
}
interface BuildRec {
  token: unknown;
  onConnect?: Cb;
  onConnectError?: Cb;
  onDisconnect?: Cb;
  onApplied?: Cb;
  readonly joinGame: ReturnType<typeof vi.fn>;
  readonly completeGuestClaim: ReturnType<typeof vi.fn>;
  readonly startGuestClaim: ReturnType<typeof vi.fn>;
  /** Every subscribe call, in order: the base set first. */
  readonly subs: SubRec[];
  readonly disconnect: ReturnType<typeof vi.fn>;
  /** The query strings handed to the applied-snapshot subscription (conn0's builder). */
  queries?: readonly string[];
  /**
   * This build's own SDK cache by table name, read by its `db` before `H.viewRows`. Additive:
   * undefined by default, so every build reads `H.viewRows`.
   */
  viewRows?: Record<string, unknown[]>;
}

const H = vi.hoisted(() => ({
  builds: [] as BuildRec[],
  renew: null as null | (() => Promise<RenewalOutcome>),
  renewCalls: 0,
  /** What the next build's startGuestClaim returns (default: resolves). */
  startGuestClaimImpl: null as null | (() => Promise<void>),
  beginSignIn: null as unknown as Mock<() => Promise<{ kind: string }>>,
  /** Per-table SDK cache contents (`conn.db.<name>.iter()`) and registered row callbacks. */
  viewRows: {} as Record<string, unknown[]>,
  rowCbs: {} as Record<string, Cb[]>,
  /**
   * qf-15: the same registrations as `rowCbs`, split by event and including onUpdate (which
   * `rowCbs` never records), so a test can hand each handler the arguments the SDK would: `(ctx,
   * row)` for insert and delete, `(ctx, oldRow, row)` for update. Additive: `rowCbs` is untouched.
   */
  rowEvents: {} as Record<string, { insert: Cb[]; update: Cb[]; delete: Cb[] }>,
  /**
   * When true, the builder's `build()` throws synchronously (a malformed URI, an SDK version
   * check), after the build was recorded in `builds`. Additive: false by default, reset in every
   * `beforeEach`.
   */
  builderThrows: false,
  /**
   * How many times each table's `iter()` (an SDK cache read) was called, by table name. Additive:
   * counting changes nothing `iter()` returns; reset by the describes that read it.
   */
  iterCalls: {} as Record<string, number>,
}));

vi.mock('../module_bindings', () => {
  const eventOf = new Map<string | symbol, 'insert' | 'update' | 'delete'>([
    ['onInsert', 'insert'],
    ['onUpdate', 'update'],
    ['onDelete', 'delete'],
  ]);
  const tableFor = (name: string, rec: BuildRec) =>
    new Proxy(
      {},
      {
        get: (_t, k) => {
          if (k === 'iter') {
            return () => {
              H.iterCalls[name] = (H.iterCalls[name] ?? 0) + 1;
              return (rec.viewRows?.[name] ?? H.viewRows[name] ?? [])[Symbol.iterator]();
            };
          }
          return (cb: Cb) => {
            if (k === 'onInsert' || k === 'onDelete') {
              H.rowCbs[name] = [...(H.rowCbs[name] ?? []), cb];
            }
            const event = eventOf.get(k);
            if (event !== undefined) {
              let events = H.rowEvents[name];
              if (events === undefined) {
                events = { insert: [], update: [], delete: [] };
                H.rowEvents[name] = events;
              }
              events[event].push(cb);
            }
          };
        },
      },
    );
  return {
    DbConnection: {
      builder: () => {
        const rec: BuildRec = {
          token: 'UNSET',
          joinGame: vi.fn(() => Promise.resolve()),
          completeGuestClaim: vi.fn(() => Promise.resolve()),
          startGuestClaim: vi.fn(() => (H.startGuestClaimImpl ?? (() => Promise.resolve()))()),
          subs: [],
          disconnect: vi.fn(),
        };
        H.builds.push(rec);
        const sub = {
          onApplied: (cb: Cb) => {
            rec.onApplied = cb;
            return sub;
          },
          onError: () => sub,
          subscribe: () => sub,
        };
        const conn = {
          db: new Proxy({}, { get: (_t, name) => tableFor(String(name), rec) }),
          reducers: {
            joinGame: rec.joinGame,
            completeGuestClaim: rec.completeGuestClaim,
            startGuestClaim: rec.startGuestClaim,
          },
          subscriptionBuilder: () => sub,
        };
        const b = {
          withUri: () => b,
          withDatabaseName: () => b,
          withToken: (t: unknown) => {
            rec.token = t;
            return b;
          },
          onConnect: (cb: Cb) => {
            rec.onConnect = cb;
            return b;
          },
          onConnectError: (cb: Cb) => {
            rec.onConnectError = cb;
            return b;
          },
          onDisconnect: (cb: Cb) => {
            rec.onDisconnect = cb;
            return b;
          },
          build: () => {
            if (H.builderThrows) throw new Error('builder threw');
            return conn;
          },
        };
        return b;
      },
    },
  };
});

vi.mock('./oidc', () => ({
  createOidcClient: () => ({
    consumeReturnLeg: () => false,
    beginSignIn: () => H.beginSignIn(),
    renewOrExchange: () => {
      H.renewCalls += 1;
      if (H.renew === null) throw new Error('renewOrExchange reached with no scripted outcome');
      return H.renew();
    },
  }),
}));

const URI = 'ws://test.invalid';
const DB = 'mr-test';
const ID = { toHexString: () => 'cd'.repeat(32) };

function makeOpts(): ConnectionOptions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    uri: URI,
    db: DB,
    name: 'Tester',
    store: new AuthoritativeStore(200),
    onReady: vi.fn(),
    onReconnect: vi.fn(),
    onHydrated: vi.fn(),
    onError: vi.fn(),
    onSessionExpired: vi.fn(),
    onAuthServiceUnreachable: vi.fn(),
    onSignInFailed: vi.fn(),
    onClaimPending: vi.fn(),
    onClaimAwaitingAccount: vi.fn(),
    onClaimResult: vi.fn(),
  } as unknown as ConnectionOptions & Record<string, ReturnType<typeof vi.fn>>;
}

/** Every value currently in sessionStorage / localStorage. */
const stored = (s: Storage): string[] =>
  Array.from({ length: s.length }, (_, i) => s.getItem(s.key(i) ?? '') ?? '');

const settle = () => vi.advanceTimersByTimeAsync(0);
/** Let every scheduled reconnect fire (backoff is bounded well under a minute). */
const nextAttempt = () => vi.advanceTimersByTimeAsync(60_000);

describe('connect() credential wiring (runtime)', { sequential: true }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.builds = [];
    H.renew = null;
    H.renewCalls = 0;
    H.startGuestClaimImpl = null;
    H.viewRows = {};
    H.rowCbs = {};
    H.rowEvents = {};
    H.builderThrows = false;
    H.beginSignIn = vi.fn(() => Promise.resolve({ kind: 'transient-error' }));
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide')); // tear the connection down: no stray rebuilds
    vi.useRealTimers();
  });

  it('ANON: a never-authenticated tab makes no OIDC call, joins, and persists the anon token in sessionStorage only', async () => {
    const opts = makeOpts();
    connect(opts);
    await settle();
    expect(H.renewCalls).toBe(0);
    expect(H.builds).toHaveLength(1);
    expect(H.builds[0].token).toBeUndefined();
    H.builds[0].onConnect?.(conn0(H.builds[0]), ID, 'anon-tok');
    H.builds[0].onApplied?.();
    expect(H.builds[0].joinGame).toHaveBeenCalledWith({ name: 'Tester' });
    expect(stored(sessionStorage)).toContain('anon-tok');
    expect(stored(localStorage)).toEqual([]);
  });

  it('ANON-RECONNECT: after a drop the rebuilt connection re-supplies the saved anon token', async () => {
    const opts = makeOpts();
    connect(opts);
    await settle();
    const b0 = H.builds[0];
    b0.onConnect?.(conn0(b0), ID, 'anon-tok');
    b0.onApplied?.();
    expect(opts.onReady).toHaveBeenCalledWith(ID.toHexString());
    expect(b0.joinGame).toHaveBeenCalledWith({ name: 'Tester' });
    b0.onDisconnect?.();
    await nextAttempt();
    expect(H.builds).toHaveLength(2);
    expect(H.builds[1].token).toBe('anon-tok');
  });

  it('ACCOUNT: a renewed session builds with the account JWT, which never enters the anon slot', async () => {
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'ok', token: 'acct-jwt' });
    const opts = makeOpts();
    connect(opts);
    await settle();
    expect(H.renewCalls).toBe(1);
    expect(H.builds[0].token).toBe('acct-jwt');
    H.builds[0].onConnect?.(conn0(H.builds[0]), ID, 'acct-jwt');
    expect(stored(sessionStorage)).not.toContain('acct-jwt');
    H.builds[0].onApplied?.();
    expect(H.builds[0].joinGame).toHaveBeenCalledTimes(1);
  });

  it('RETRY: a transient outcome never reaches the builder; a second one parks on auth-service-unreachable', async () => {
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'transient-error' });
    const opts = makeOpts();
    const c = connect(opts);
    await settle();
    expect(H.renewCalls).toBe(1);
    expect(H.builds).toHaveLength(0);
    await nextAttempt();
    expect(H.renewCalls).toBe(2);
    expect(H.builds).toHaveLength(0);
    expect(opts.onAuthServiceUnreachable).toHaveBeenCalledTimes(1);
    expect(c.sessionState()).toBe('unreachable');
    expect(c.live()).toBeUndefined();
  });

  it('LADDER: a throwing credential resolve climbs the backoff ladder instead of dying', async () => {
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.reject(new Error('boom'));
    connect(makeOpts());
    await settle();
    expect(H.builds).toHaveLength(0);
    H.renew = () => Promise.resolve({ kind: 'ok', token: 'acct-jwt' });
    await nextAttempt();
    expect(H.renewCalls).toBe(2);
    expect(H.builds.map((b) => b.token)).toEqual(['acct-jwt']);
  });

  it('SESSION-EXPIRED: an ever-authenticated tab with no session parks without building', async () => {
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'no-session' });
    const opts = makeOpts();
    const c = connect(opts);
    await settle();
    expect(opts.onSessionExpired).toHaveBeenCalledTimes(1);
    expect(c.sessionState()).toBe('expired');
    expect(H.builds).toHaveLength(0);
  });

  it('SIGN-IN-FAILED: a failed exchange is reported AND still yields an anon connection (never the reason as a token)', async () => {
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'exchange-failed', reason: 'state-mismatch' });
    const opts = makeOpts();
    connect(opts);
    await settle();
    expect(opts.onSignInFailed).toHaveBeenCalledWith('state-mismatch');
    expect(H.builds).toHaveLength(1);
    expect(H.builds[0].token).toBeUndefined();
  });

  it('FORCED-ANON: continueAnonymously is sticky across reconnects and stops consulting OIDC', async () => {
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'ok', token: 'acct-jwt' });
    const c = connect(makeOpts());
    await settle();
    c.continueAnonymously();
    await settle();
    const anonBuild = H.builds[1];
    expect(anonBuild.token).not.toBe('acct-jwt');
    anonBuild.onConnect?.(conn0(anonBuild), ID, 'anon-tok');
    anonBuild.onDisconnect?.();
    await nextAttempt();
    expect(H.renewCalls).toBe(1);
    expect(H.builds[2].token).toBe('anon-tok');
  });

  it('CLAIM-VETO: an unconsumed claim code vetoes the join on an ACCOUNT build only', async () => {
    claimCode.mint(globalThis, URI, DB);
    const anonOpts = makeOpts();
    connect(anonOpts);
    await settle();
    const anon = H.builds[0];
    anon.onConnect?.(conn0(anon), ID, 'anon-tok');
    anon.onApplied?.();
    expect(anon.joinGame, 'anon builds always join').toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pagehide'));

    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'ok', token: 'acct-jwt' });
    const opts = makeOpts();
    connect(opts);
    await settle();
    const acct = H.builds[1];
    acct.onConnect?.(conn0(acct), ID, 'acct-jwt');
    acct.onApplied?.();
    expect(acct.joinGame).not.toHaveBeenCalled();
    expect(opts.onClaimAwaitingAccount).toHaveBeenCalledTimes(1);
  });

  /** Drives an ACCOUNT build into the AUTH-53 claim re-issue path (unconsumed code + an own
   *  account row), with `completeGuestClaim` scripted by `impl` and `onClaimResult` by `onResult`. */
  async function driveClaimReissue(
    impl: () => Promise<void>,
    onResult: (r: { ok: boolean; message: string }) => void,
  ): Promise<{ opts: ConnectionOptions & Record<string, ReturnType<typeof vi.fn>>; code: string }> {
    claimCode.mint(globalThis, URI, DB);
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'ok', token: 'acct-jwt' });
    const opts = { ...makeOpts(), onClaimResult: vi.fn(onResult) } as unknown as ReturnType<
      typeof makeOpts
    >;
    vi.spyOn(opts.store, 'ownAccount').mockReturnValue({} as never);
    connect(opts);
    await settle();
    const acct = H.builds[0];
    acct.completeGuestClaim.mockImplementation(impl);
    acct.onConnect?.(conn0(acct), ID, 'acct-jwt');
    acct.onApplied?.();
    await settle();
    return { opts, code: claimCode.read(globalThis, URI, DB) as string };
  }

  // ts-6b-9.6 (R-polish-1-CLAIMRESULTCATCHREENTRY).
  it('a throw in the claim-success handler is not reported as a claim rejection', async () => {
    // WRONG IMPL KILLED: `.then(ok).catch(fail)` — a throwing ok-handler lands in the catch and the
    // same claim is reported twice (ok:true, then ok:false: "claim failed" after it succeeded).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: { ok: boolean; message: string }[] = [];
    // (An unhandled rejection fails the whole vitest run on its own; the logging half is asserted.)
    try {
      const { opts } = await driveClaimReissue(
        () => Promise.resolve(),
        (r) => {
          calls.push(r);
          if (r.ok) throw new Error('handler blew up');
        },
      );
      expect(H.builds[0].completeGuestClaim).toHaveBeenCalledTimes(1);
      expect(opts.onClaimResult).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([{ ok: true, message: '' }]);
      expect(
        calls.some((c) => !c.ok),
        'never reported as a rejection',
      ).toBe(false);
      expect(errorSpy, 'the handler error is logged, not swallowed silently').toHaveBeenCalled();
      await settle();
      expect(calls, 'still exactly one call after the chain fully settles').toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a rejected claim reducer is reported as exactly one ok:false', async () => {
    const calls: { ok: boolean; message: string }[] = [];
    const { opts } = await driveClaimReissue(
      () => Promise.reject(new Error('code unknown')),
      (r) => {
        calls.push(r);
      },
    );
    expect(opts.onClaimResult).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ ok: false, message: 'code unknown' }]);
  });

  // BUG-client-never-starts-guest-claim. ADR-0179 D3: the client mints the code, stores it,
  // and registers it with start_guest_claim WHILE STILL CONNECTED AS THE GUEST — only that
  // reducer inserts the guest_claim row complete_guest_claim later resolves. The OIDC
  // redirect leaves the page, so registration must SETTLE before the hand-off.
  it('CLAIM-START: startSignIn registers the stored code via startGuestClaim, and only then begins the OIDC sign-in', async () => {
    let release: () => void = () => {};
    H.startGuestClaimImpl = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const opts = makeOpts();
    const handle = connect(opts);
    await settle();
    H.builds[0].onConnect?.(conn0(H.builds[0]), ID, 'anon-tok');
    H.builds[0].onApplied?.();

    handle.startSignIn();
    const codes = stored(sessionStorage).filter((v) => /^[0-9a-f]{64}$/.test(v));
    expect(codes, 'the code is minted into per-tab storage BEFORE the reducer call').toHaveLength(
      1,
    );
    expect(H.builds[0].startGuestClaim).toHaveBeenCalledTimes(1);
    expect(H.builds[0].startGuestClaim).toHaveBeenCalledWith({ code: codes[0] });
    await settle();
    expect(
      H.beginSignIn,
      'the redirect must wait for the claim registration to settle',
    ).not.toHaveBeenCalled();

    release();
    await settle();
    expect(H.beginSignIn).toHaveBeenCalledTimes(1);
  });

  it('CLAIM-START-UNLOGGED: the claim code (a bearer secret) never reaches the dev reducer-arg logger', async () => {
    const onSend = vi.fn();
    const opts = { ...makeOpts(), onSend } as ConnectionOptions;
    const handle = connect(opts);
    await settle();
    H.builds[0].onConnect?.(conn0(H.builds[0]), ID, 'anon-tok');
    H.builds[0].onApplied?.();
    handle.startSignIn();
    await settle();
    expect(H.builds[0].startGuestClaim).toHaveBeenCalledTimes(1);
    const code = claimCode.read(globalThis, URI, DB) as string;
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(onSend.mock.calls)).not.toContain(code);
  });

  it('CLAIM-START-REJECTED: a refused registration blocks sign-in — code cleared, transient-error reported, no redirect', async () => {
    H.startGuestClaimImpl = () => Promise.reject(new Error('not joined'));
    const opts = makeOpts();
    const handle = connect(opts);
    await settle();
    H.builds[0].onConnect?.(conn0(H.builds[0]), ID, 'anon-tok');
    H.builds[0].onApplied?.();

    handle.startSignIn();
    await settle();
    expect(H.builds[0].startGuestClaim).toHaveBeenCalledTimes(1);
    expect(H.beginSignIn).not.toHaveBeenCalled();
    expect(opts.onSignInFailed).toHaveBeenCalledWith('transient-error');
    expect(
      claimCode.read(globalThis, URI, DB),
      'an unregistered code must not survive',
    ).toBeUndefined();
  });

  it('CLAIM-START-NO-LINK: with no live connection, nothing is minted and sign-in is refused', async () => {
    const opts = makeOpts();
    const handle = connect(opts);
    // Before the first build lands `current` is still undefined (the cold start defers it).
    handle.startSignIn();
    await settle();
    expect(H.beginSignIn).not.toHaveBeenCalled();
    expect(opts.onSignInFailed).toHaveBeenCalledWith('transient-error');
    expect(claimCode.read(globalThis, URI, DB)).toBeUndefined();
  });

  // BUG-inventory-world-readable: inventory is a PRIVATE table read through the owner-scoped
  // my_inventory Vec view. The client must subscribe the VIEW (subscribing the private table
  // errors the whole batch) and rebuild its inventory from the view's post-burst cache — the
  // view has no PK, so no onUpdate ever fires and per-row writes would race insert+delete pairs.
  it('MY-INVENTORY: subscribes the owner-scoped view, never the private table, and reconciles the store from its cache', async () => {
    const opts = makeOpts();
    connect(opts);
    await settle();
    H.builds[0].onConnect?.(conn0(H.builds[0]), ID, 'anon-tok');
    const queries = H.builds[0].queries ?? [];
    expect(queries).toContain('SELECT * FROM my_inventory');
    expect(queries).not.toContain('SELECT * FROM inventory');

    const me = ID.toHexString();
    H.viewRows.my_inventory = [
      { invId: 1n, ownerIdentity: ID, itemId: 5, count: 3 },
      { invId: 2n, ownerIdentity: ID, itemId: 6, count: 1 },
    ];
    for (const cb of H.rowCbs.my_inventory ?? []) cb();
    await settle();
    expect(opts.store.ownInventory(me)).toEqual([
      { invId: 1n, ownerIdentity: me, itemId: 5, count: 3 },
      { invId: 2n, ownerIdentity: me, itemId: 6, count: 1 },
    ]);

    // A count change + a consumed-to-zero stack arrive as a new cache set (no onUpdate).
    H.viewRows.my_inventory = [{ invId: 1n, ownerIdentity: ID, itemId: 5, count: 2 }];
    for (const cb of H.rowCbs.my_inventory ?? []) cb();
    await settle();
    expect(opts.store.ownInventory(me)).toEqual([
      { invId: 1n, ownerIdentity: me, itemId: 5, count: 2 },
    ]);
  });

  // qf-15 (QF15.1): the zone cue names the destination zone from the `zone_def` content table. It
  // is a REGULAR public table with a primary key (`zone_id`), so unlike the PK-less views above it
  // is fed row by row (heal_location_row's idiom) and onUpdate DOES fire.
  it('the one subscription batch includes the public zone_def table exactly once and adds no other query, 29 in all [QF15-1-SUBSCRIBE-ZONE-DEF]', async () => {
    // WRONG IMPL KILLED: no subscription (the client never receives a zone name and the cue stays
    // silent forever); a second subscription call or a duplicate entry (the length pin); a query
    // for a table nobody named riding along (the length pin); the table spelled differently
    // (`zoneDef`, `zone_defs`); `character` in the base set (every step of every player in the
    // world would reach every client).
    // The 29: 20 base queries, zone_def, the seven tactical views (BT12-1-SUBSCRIBE-SEVEN pins
    // which seven) and `my_trade_session` (TS3-SUBSCRIBE-SESSION-VIEW). Not among them:
    // `trade_offer` (TS4-4-NO-TRADE-OFFER) and `character` (the world scope's sets).
    const opts = makeOpts();
    connect(opts);
    await settle();
    H.builds[0].onConnect?.(conn0(H.builds[0]), ID, 'anon-tok');
    const queries = H.builds[0].queries ?? [];
    expect(queries).toContain('SELECT * FROM zone_def');
    expect(
      queries.filter((q) => q === 'SELECT * FROM zone_def'),
      'zone_def is subscribed once',
    ).toHaveLength(1);
    expect(
      queries,
      'the 20 base queries, zone_def, the seven tactical views and my_trade_session',
    ).toHaveLength(29);
    expect(
      queries.filter((q) => /\bcharacter\b/.test(q)),
      'no base query reads `character`: the world scope subscribes it by own row and by zone',
    ).toEqual([]);
  });

  it('an inserted zone_def row stores its name by zone id, an update replaces it, a delete removes it, and each change flushes one batch [QF15-1-WIRE-ZONE-DEF]', async () => {
    // WRONG IMPL KILLED: no row handlers on `conn.db.zoneDef` (nothing is ever stored); an
    // insert-only wiring (a renamed zone keeps its old name: the update leg); an onUpdate that
    // reads the OLD row (arguments are `(ctx, oldRow, row)`: the update leg expects the new name);
    // no onDelete (a deleted zone keeps a name); a store key that is not `row.zoneId` (the width
    // and height differ from the ids on purpose); a handler that stores and never schedules the
    // batcher (no batch is delivered: the flush counts); a store write that clears the other
    // zones' names.
    const opts = makeOpts();
    connect(opts);
    await settle();
    H.builds[0].onConnect?.(conn0(H.builds[0]), ID, 'anon-tok');
    await settle();
    const events = H.rowEvents.zoneDef;
    expect(
      events,
      'precondition: connection.ts registered row handlers on conn.db.zoneDef (the camelCase accessor)',
    ).toBeDefined();
    expect(events.insert.length, 'an onInsert handler').toBeGreaterThan(0);
    expect(events.update.length, 'an onUpdate handler').toBeGreaterThan(0);
    expect(events.delete.length, 'an onDelete handler').toBeGreaterThan(0);

    const flushed = vi.fn();
    opts.store.onBatchApplied(flushed);
    const ctx = {};
    /** NON-shipped ids and names; width and height are neither the id nor each other. */
    const row = (zoneId: number, name: string) => ({ zoneId, name, width: 11, height: 13 });
    /** Run every handler of one event with the SDK's arguments, let the microtask batcher flush,
     *  and report how many batches that delivered. */
    const fire = async (handlers: Cb[], ...args: unknown[]): Promise<number> => {
      flushed.mockClear();
      for (const handler of handlers) handler(ctx, ...args);
      await settle();
      return flushed.mock.calls.length;
    };

    expect(opts.store.zoneName(7), 'nothing is stored before any row').toBeUndefined();

    expect(await fire(events.insert, row(7, 'Cobalt Reach')), 'the insert flushes one batch').toBe(
      1,
    );
    expect(opts.store.zoneName(7), 'the inserted name, by zone id').toBe('Cobalt Reach');
    expect(opts.store.zoneName(11), 'never keyed by the width').toBeUndefined();
    expect(opts.store.zoneName(13), 'never keyed by the height').toBeUndefined();

    expect(await fire(events.insert, row(2, 'Ash Hollow')), 'the second insert flushes').toBe(1);
    expect(opts.store.zoneName(2), 'the second zone has its own name').toBe('Ash Hollow');
    expect(opts.store.zoneName(7), 'and the first is untouched').toBe('Cobalt Reach');

    expect(
      await fire(events.update, row(7, 'Cobalt Reach'), row(7, 'Umber Fen')),
      'the update flushes one batch',
    ).toBe(1);
    expect(opts.store.zoneName(7), 'the NEW row wins, not the old one').toBe('Umber Fen');
    expect(opts.store.zoneName(2), 'an update touches its own zone only').toBe('Ash Hollow');

    expect(await fire(events.delete, row(7, 'Umber Fen')), 'the delete flushes one batch').toBe(1);
    expect(opts.store.zoneName(7), 'a deleted zone has no name').toBeUndefined();
    expect(opts.store.zoneName(2), 'a delete removes its own zone only').toBe('Ash Hollow');
  });

  it('STALE: a superseded build connecting late cannot save its token or claim the identity', async () => {
    const opts = makeOpts();
    const c = connect(opts);
    await settle();
    const first = H.builds[0];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    first.onConnectError?.({}, new Error('refused'));
    expect(opts.onError).toHaveBeenCalledWith('connect', 'refused');
    await nextAttempt();
    expect(H.builds).toHaveLength(2);
    first.onConnect?.(conn0(first), ID, 'stale-tok');
    expect(stored(sessionStorage)).not.toContain('stale-tok');
    expect(c.identity()).toBe('');
  });
});

// =============================================================================================
// bt-12 (BT12.1): the seven tactical views — subscribed, wired to the batcher, reconciled from the
// SDK cache before the flush, one view's throw contained to that view.
// =============================================================================================
//
// SOURCE OF TRUTH: spec BT12.1 ("WHEN the client connects, IT SHALL subscribe to my_tactical_battle,
// my_battle_units, my_battle_queue, my_battle_deploy, my_battle_clock, my_battle_events and
// my_formation, ingest them into the store"); plan §3.3 (the seven strings, the camelCase handles,
// onInsert / onDelete -> batcher.schedule() and NO onUpdate, no per-row store write, seven GUARDED
// reconciles after the inventory block and before flushBatch) and REV 2b B3 (the store is read
// INSIDE a batch listener registered before the row callbacks fire; a 2-row then 1-row delivery
// deletes; the FIRST view throwing on a malformed row never starves the LAST). The SDK cache is
// `H.viewRows[<camelCase handle>]`. RED REASON: connection.ts subscribes none of the seven views,
// registers no handler on them and reconciles none of them (and the store's tactical methods throw
// `bt-12: not implemented` on the API-freeze stub).

const BT12_ME = ID.toHexString();
/** The seven camelCase table handles connection.ts reads (`conn.db.<handle>`), in plan order. */
const BT12_HANDLES = [
  'myTacticalBattle',
  'myBattleUnits',
  'myBattleQueue',
  'myBattleDeploy',
  'myBattleClock',
  'myBattleEvents',
  'myFormation',
] as const;
const BT12_QUERIES = [
  'SELECT * FROM my_tactical_battle',
  'SELECT * FROM my_battle_units',
  'SELECT * FROM my_battle_queue',
  'SELECT * FROM my_battle_deploy',
  'SELECT * FROM my_battle_clock',
  'SELECT * FROM my_battle_events',
  'SELECT * FROM my_formation',
] as const;
/** The private tables behind the views: subscribing any of them errors the whole batch. */
const BT12_PRIVATE_TABLES = [
  'battle_tactical',
  'battle_unit',
  'battle_queue',
  'battle_deploy',
  'battle_clock',
  'battle_event',
  'player_formation',
  'battle_wild_unit',
  'battle_secret',
  'battle_summary',
  'tactical_deadline_sched',
  'tactical_advance_sched',
] as const;
/** Two battle ids past 2^53. */
const BT12_B = 9_007_199_254_740_993n;
const BT12_B2 = 9_007_199_254_741_001n;

// SDK-shaped rows (plain objects, as the generated bindings deliver them).
const bt12Tactical = (battleId: bigint, mapId: number) => ({
  battleId,
  kind: { tag: 'Wild' },
  format: 1,
  mapId,
  contentVersion: 1,
  phase: { tag: 'Deploying' },
  round: 0,
  initiative: [],
  turnIdx: 0,
  turnState: { tag: 'NotActive' },
  tiePrioritySide: { tag: 'A' },
  pendingPadMs: 0,
  attackDamageDealtA: 0,
  attackDamageDealtB: 0,
});
const bt12Unit = (unitId: number) => ({
  unitId,
  battleId: BT12_B,
  side: { tag: 'A' },
  owner: ID,
  slot: 0,
  monsterId: 5n,
  wildIndex: undefined,
  speciesId: 1,
  level: 5,
  affinity: { tag: 'Plant' },
  x: 1,
  y: 1,
  curHp: 20,
  stats: { hp: 20, attack: 5, defense: 5, speed: 5, spAttack: 5, spDefense: 5 },
  skillIds: [],
  status: undefined,
  ap: 6,
  stridesUsed: 0,
  attacks: 0,
  budgetLast: undefined,
  guard: false,
  firstStand: false,
  movement: { tag: 'Walk' },
  stride: 3,
  stance: undefined,
  state: { tag: 'Active' },
});
const bt12Queue = (unitId: number) => ({
  unitId,
  battleId: BT12_B,
  owner: ID,
  entries: [{ tag: 'EndTurn' }],
  submittedAtMs: 1n,
});
const bt12Deploy = (deployId: bigint) => ({
  deployId,
  battleId: BT12_B,
  owner: ID,
  side: { tag: 'A' },
  picks: [{ monsterId: 5n, slot: 0 }],
  locked: false,
});
const bt12Clock = (clockId: bigint) => ({
  clockId,
  battleId: BT12_B,
  side: { tag: 'A' },
  player: ID,
  windowSeq: 1,
  windowOpenMs: undefined,
  deadlineMs: undefined,
  windowsThisUnitTurn: 0,
  idleMsTotal: 0n,
  autopassCount: 0,
});
const bt12Event = (eventId: bigint, seq: number) => ({
  eventId,
  battleId: BT12_B,
  seq,
  round: 1,
  payload: { tag: 'BattleStarted', value: { round: 1 } },
});
const bt12Formation = (monsterIds: bigint[]) => ({ ownerIdentity: ID, monsterIds });
const bt12SdkMonster = {
  speciesId: 1,
  affinity: { tag: 'Plant' },
  level: 5,
  currentHp: 20,
  maxHp: 20,
  stats: { hp: 20, attack: 5, defense: 5, speed: 5, spAttack: 5, spDefense: 5 },
  knownSkillIds: [1],
  status: undefined,
};
const bt12SdkBattle = (battleId: bigint) => ({
  battleId,
  playerIdentity: ID,
  opponentIdentity: { toHexString: () => '00'.repeat(32) },
  state: {
    sideA: { active: 0, team: [bt12SdkMonster] },
    sideB: { active: 0, team: [bt12SdkMonster] },
    outcome: { tag: 'Ongoing' },
    turnNumber: 1,
    weather: undefined,
  },
  partyMonsterIds: [5n],
  opponentMonsterIds: [],
  createdAtMs: 0n,
});

/** What the store shows for the six readable tactical views (the deploy map has no accessor). */
function bt12Seen(store: AuthoritativeStore): Record<string, unknown> {
  return {
    tactical: [BT12_B, BT12_B2].filter((id) => store.tacticalBattle(id) !== undefined),
    units: store.battleUnits(BT12_B).map((u) => u.unitId),
    queues: store.ownQueue(BT12_B, BT12_ME).map((q) => q.unitId),
    clocks: store.battleClocks(BT12_B).map((c) => c.clockId),
    events: store.battleEvents(BT12_B).map((e) => e.eventId),
    formation: store.ownFormation(BT12_ME)?.monsterIds ?? null,
  };
}

/** Run every `event` handler registered on each named handle, as the SDK would: `(ctx, row)`. */
function bt12Fire(event: 'insert' | 'delete', handles: readonly string[]): void {
  for (const handle of handles) {
    for (const cb of H.rowEvents[handle]?.[event] ?? []) cb({}, {});
  }
}

/** Connect, build and land the onConnect (the subscription call) of the first build. */
async function bt12Connect(): Promise<ReturnType<typeof makeOpts>> {
  const opts = makeOpts();
  connect(opts);
  await settle();
  H.builds[0].onConnect?.(conn0(H.builds[0]), ID, 'anon-tok');
  await settle();
  return opts;
}

describe('connect(): the tactical views (bt-12, BT12.1)', { sequential: true }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.builds = [];
    H.renew = null;
    H.renewCalls = 0;
    H.startGuestClaimImpl = null;
    H.viewRows = {};
    H.rowCbs = {};
    H.rowEvents = {};
    H.builderThrows = false;
    H.beginSignIn = vi.fn(() => Promise.resolve({ kind: 'transient-error' }));
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
  });

  it('the one subscription batch names each of the seven owner-scoped tactical views exactly once and no private battle table, 29 queries in all [BT12-1-SUBSCRIBE-SEVEN]', async () => {
    // WRONG IMPL KILLED: a view left out (its rows never reach the client: the deploy panel or the
    // results never show); a view subscribed twice (the length pin); the PRIVATE table subscribed
    // instead of its view (`battle_unit`, `player_formation`: a private table errors the WHOLE
    // batch and onApplied never fires — every session would hang); a view spelled differently
    // (`my_battle_unit`, `myFormation`).
    await bt12Connect();
    const queries = H.builds[0].queries ?? [];
    for (const query of BT12_QUERIES) {
      expect(
        queries.filter((q) => q === query),
        `${query} is subscribed exactly once`,
      ).toHaveLength(1);
    }
    expect(
      queries.filter((q) => BT12_PRIVATE_TABLES.some((table) => q.endsWith(` ${table}`))),
      'no private battle table is subscribed',
    ).toEqual([]);
    // The 21 non-tactical queries (no `trade_offer`, no `character`), the seven, my_trade_session.
    expect(queries, 'the 21 non-tactical queries, the seven, my_trade_session').toHaveLength(29);
    expect(
      queries.filter((q) => /\bcharacter\b/.test(q)),
      'no base query reads `character`: the world scope subscribes it by own row and by zone',
    ).toEqual([]);
  });

  it('each tactical view registers an insert and a delete handler and never an update handler; a handler writes nothing to the store itself, and one insert or one delete is exactly one flushed batch that reconciles the view from the SDK cache [BT12-1-VIEW-HANDLERS]', async () => {
    // WRONG IMPL KILLED: a handle spelled snake_case or misnamed (no handler on the camelCase
    // accessor connection.ts must read); an onUpdate handler on a view (a PK-less view never fires
    // one: wiring it implies a delivery guarantee the SDK does not make); no onDelete (a deleted row
    // never schedules the flush, so the store keeps it); a handler that writes its row into the
    // store (a view's insert+delete pair arrives unordered: the delete half would wipe the row the
    // insert half wrote); a handler that never schedules the batcher; two flushes for one event.
    const opts = await bt12Connect();
    const flushed = vi.fn();
    opts.store.onBatchApplied(flushed);
    const rowsFor: Record<(typeof BT12_HANDLES)[number], unknown[]> = {
      myTacticalBattle: [bt12Tactical(BT12_B, 7)],
      myBattleUnits: [bt12Unit(3)],
      myBattleQueue: [bt12Queue(3)],
      myBattleDeploy: [bt12Deploy(13n)],
      myBattleClock: [bt12Clock(19n)],
      myBattleEvents: [bt12Event(29n, 1)],
      myFormation: [bt12Formation([37n])],
    };
    /** Whether the store shows the handle's row (null: the deploy map has no accessor). */
    const shows = (handle: (typeof BT12_HANDLES)[number]): boolean | null => {
      const s = opts.store;
      switch (handle) {
        case 'myTacticalBattle':
          return s.tacticalBattle(BT12_B) !== undefined;
        case 'myBattleUnits':
          return s.battleUnits(BT12_B).length > 0;
        case 'myBattleQueue':
          return s.ownQueue(BT12_B, BT12_ME).length > 0;
        case 'myBattleDeploy':
          return null;
        case 'myBattleClock':
          return s.battleClocks(BT12_B).length > 0;
        case 'myBattleEvents':
          return s.battleEvents(BT12_B).length > 0;
        case 'myFormation':
          return s.ownFormation(BT12_ME) !== undefined;
        default:
          return handle satisfies never;
      }
    };
    for (const handle of BT12_HANDLES) {
      const events = H.rowEvents[handle];
      expect(
        events,
        `${handle}: connection.ts registered row handlers on conn.db.${handle}`,
      ).toBeDefined();
      if (events === undefined) continue;
      expect(events.insert.length, `${handle}: an onInsert handler`).toBeGreaterThan(0);
      expect(events.delete.length, `${handle}: an onDelete handler`).toBeGreaterThan(0);
      expect(events.update.length, `${handle}: NO onUpdate handler on a view`).toBe(0);
      const row = rowsFor[handle][0];

      // The handler is handed a row while the SDK cache is still empty: it must write nothing.
      H.viewRows[handle] = [];
      flushed.mockClear();
      for (const cb of events.insert) cb({}, row);
      expect(shows(handle), `${handle}: the insert handler wrote nothing to the store`).not.toBe(
        true,
      );
      await settle();
      expect(
        flushed.mock.calls.length,
        `${handle}: an empty cache changes nothing, so the flush wakes nobody (no per-row write)`,
      ).toBe(0);

      // The row in the cache, one insert: exactly one flushed batch, and the row lands.
      H.viewRows[handle] = rowsFor[handle];
      flushed.mockClear();
      for (const cb of events.insert) cb({}, row);
      await settle();
      expect(flushed.mock.calls.length, `${handle}: one insert, one flushed batch`).toBe(1);
      if (shows(handle) !== null) {
        expect(shows(handle), `${handle}: the cached row landed`).toBe(true);
      }

      // The cache emptied, one delete: exactly one flushed batch, and the row is gone.
      H.viewRows[handle] = [];
      flushed.mockClear();
      for (const cb of events.delete) cb({}, row);
      await settle();
      expect(flushed.mock.calls.length, `${handle}: one delete, one flushed batch`).toBe(1);
      if (shows(handle) !== null) {
        expect(shows(handle), `${handle}: the deleted row is gone`).toBe(false);
      }
    }
  });

  it('the flush rebuilds every tactical view from the SDK cache BEFORE the batch listeners run: a listener registered first already reads the new rows, once per burst, and a 2-row then 1-row then empty cache leaves exactly 2, 1 and 0 rows [BT12-1-RECONCILE-FROM-CACHE]', async () => {
    // WRONG IMPL KILLED: the reconciles placed AFTER flushBatch() (the listener — main.ts's
    // refreshBattle — paints the PRE-burst store: the deploy panel opens one batch late or never);
    // a reconcile run only on the first flush or only when its own handle fired; an upsert-only
    // reconcile (the 2-then-1 delivery keeps the stale row: deletes are not only-when-empty); a
    // flush per handle instead of one per burst (the listener runs seven times); the formation
    // wired with the per-row my_account idiom (an empty cache keeps the old formation).
    const opts = await bt12Connect();
    const seen: Record<string, unknown>[] = [];
    opts.store.onBatchApplied(() => {
      seen.push(bt12Seen(opts.store));
    });

    H.viewRows.myTacticalBattle = [bt12Tactical(BT12_B, 7), bt12Tactical(BT12_B2, 11)];
    H.viewRows.myBattleUnits = [bt12Unit(3), bt12Unit(5)];
    H.viewRows.myBattleQueue = [bt12Queue(3), bt12Queue(5)];
    H.viewRows.myBattleDeploy = [bt12Deploy(13n), bt12Deploy(17n)];
    H.viewRows.myBattleClock = [bt12Clock(19n), bt12Clock(23n)];
    H.viewRows.myBattleEvents = [bt12Event(29n, 1), bt12Event(31n, 2)];
    H.viewRows.myFormation = [bt12Formation([37n, 41n])];
    bt12Fire('insert', BT12_HANDLES);
    await settle();
    expect(seen, 'one burst of row callbacks is one flushed batch').toHaveLength(1);
    expect(seen[0], 'inside the listener, every view already reads the cached rows').toEqual({
      tactical: [BT12_B, BT12_B2],
      units: [3, 5],
      queues: [3, 5],
      clocks: [19n, 23n],
      events: [29n, 31n],
      formation: [37n, 41n],
    });

    H.viewRows.myTacticalBattle = [bt12Tactical(BT12_B, 7)];
    H.viewRows.myBattleUnits = [bt12Unit(3)];
    H.viewRows.myBattleQueue = [bt12Queue(3)];
    H.viewRows.myBattleDeploy = [bt12Deploy(13n)];
    H.viewRows.myBattleClock = [bt12Clock(19n)];
    H.viewRows.myBattleEvents = [bt12Event(29n, 1)];
    H.viewRows.myFormation = [bt12Formation([41n])];
    bt12Fire('delete', BT12_HANDLES);
    await settle();
    expect(seen, 'the second burst is the second batch').toHaveLength(2);
    expect(seen[1], 'a row absent from the cache is deleted from every view').toEqual({
      tactical: [BT12_B],
      units: [3],
      queues: [3],
      clocks: [19n],
      events: [29n],
      formation: [41n],
    });

    for (const handle of BT12_HANDLES) H.viewRows[handle] = [];
    bt12Fire('delete', BT12_HANDLES);
    await settle();
    expect(seen, 'the third burst is the third batch').toHaveLength(3);
    expect(seen[2], 'an emptied cache empties every view and clears the formation').toEqual({
      tactical: [],
      units: [],
      queues: [],
      clocks: [],
      events: [],
      formation: null,
    });
  });

  it('a malformed row that makes the FIRST tactical view`s converter throw is contained to that view: the other six (the formation, last, included), the monster, battle and inventory views all land, the batch still flushes and the throw is logged [BT12-1-RECONCILE-ISOLATED]', async () => {
    // WRONG IMPL KILLED: the seven reconciles in ONE shared try (the first view's throw starves the
    // other six: the formation never lands); the tactical reconciles placed inside the monster /
    // battle try ahead of them (the battle view starves too); no guard at all (the throw escapes
    // the batcher and no batch is ever delivered); a guard that swallows silently (no log line).
    const opts = await bt12Connect();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const flushed = vi.fn();
      opts.store.onBatchApplied(flushed);
      const malformed = new Proxy(
        {},
        {
          get: () => {
            throw new Error('malformed my_tactical_battle row');
          },
        },
      );
      H.viewRows.myTacticalBattle = [malformed, bt12Tactical(BT12_B2, 11)];
      H.viewRows.myBattleUnits = [bt12Unit(3)];
      H.viewRows.myBattleQueue = [bt12Queue(3)];
      H.viewRows.myBattleDeploy = [bt12Deploy(13n)];
      H.viewRows.myBattleClock = [bt12Clock(19n)];
      H.viewRows.myBattleEvents = [bt12Event(29n, 1)];
      H.viewRows.myFormation = [bt12Formation([37n])];
      H.viewRows.my_inventory = [{ invId: 43n, ownerIdentity: ID, itemId: 5, count: 3 }];
      H.viewRows.myBattle = [bt12SdkBattle(47n)];
      bt12Fire('insert', [...BT12_HANDLES, 'my_inventory']);
      await settle();

      expect(flushed, 'the batch is still delivered, once').toHaveBeenCalledTimes(1);
      expect(
        opts.store.ownFormation(BT12_ME)?.monsterIds,
        'the LAST view (my_formation) still lands',
      ).toEqual([37n]);
      expect(
        opts.store.battleUnits(BT12_B).map((u) => u.unitId),
        'units land',
      ).toEqual([3]);
      expect(
        opts.store.ownQueue(BT12_B, BT12_ME).map((q) => q.unitId),
        'plans land',
      ).toEqual([3]);
      expect(
        opts.store.battleClocks(BT12_B).map((c) => c.clockId),
        'clocks land',
      ).toEqual([19n]);
      expect(
        opts.store.battleEvents(BT12_B).map((e) => e.eventId),
        'events land',
      ).toEqual([29n]);
      expect(opts.store.ownInventory(BT12_ME), 'the inventory view is intact').toEqual([
        { invId: 43n, ownerIdentity: BT12_ME, itemId: 5, count: 3 },
      ]);
      expect(opts.store.ongoingBattle(BT12_ME)?.battleId, 'the battle view is intact').toBe(47n);
      expect(
        errors.mock.calls.some((call) => call[0] === '[net] view reconcile threw; flushing anyway'),
        'the contained throw is logged',
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});

// =============================================================================================
// ts-3 (M-trade-sessions): the `my_trade_session` view — subscribed (never the private
// `trade_session`), wired to the batcher with onInsert / onDelete and NO onUpdate (a PK-less Vec
// view), reconciled from the SDK cache (`conn.db.myTradeSession.iter()`) in its OWN guarded block
// before the flush, so a converter throw starves no other reconcile.
//
// SOURCE OF TRUTH: memory/projects/monster-realm-ts-3-plan.md §Contracts › Store (`connection.ts`).
// RED REASON: connection.ts subscribes no session view, registers no handler on it and reconciles
// nothing into `store.allTradeSessions()` (which does not exist yet).
// =============================================================================================

/** A `my_trade_session` row as the bindings deliver it (identities as SDK objects). */
const ts3Row = (sessionId: bigint, revision = 1n) => ({
  sessionId,
  opener: ID,
  partner: { toHexString: () => 'bb'.repeat(32) },
  openerOffer: { monsterIds: [5n], items: [{ itemId: 3, qty: 1 }], currency: 2n, cards: [] },
  partnerOffer: { monsterIds: [], items: [], currency: 0n, cards: [] },
  openerConfirmed: false,
  partnerConfirmed: false,
  revision,
  createdAtMs: 1n,
});

describe('connect(): the trade session view (ts-3)', { sequential: true }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.builds = [];
    H.renew = null;
    H.renewCalls = 0;
    H.startGuestClaimImpl = null;
    H.viewRows = {};
    H.rowCbs = {};
    H.rowEvents = {};
    H.builderThrows = false;
    H.beginSignIn = vi.fn(() => Promise.resolve({ kind: 'transient-error' }));
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
  });

  it('the one subscription batch names my_trade_session exactly once and never the private trade_session, 29 queries in all [TS3-SUBSCRIBE-SESSION-VIEW]', async () => {
    // WRONG IMPL KILLED: the view left out (the editor and the Trades rows never see a session);
    // the PRIVATE table subscribed (it errors the whole batch: onApplied never fires and every
    // session hangs); the view subscribed twice; another query riding along (the length pin).
    await bt12Connect();
    const queries = H.builds[0].queries ?? [];
    expect(queries.filter((q) => q === 'SELECT * FROM my_trade_session')).toHaveLength(1);
    expect(queries, 'never the private table').not.toContain('SELECT * FROM trade_session');
    expect(queries.filter((q) => q.endsWith(' trade_session'))).toEqual([]);
    expect(queries).toHaveLength(29);
    expect(
      queries.filter((q) => /\bcharacter\b/.test(q)),
      'no base query reads `character`: the world scope subscribes it by own row and by zone',
    ).toEqual([]);
  });

  it('ts-4.4: no trade_offer query is subscribed, no handler is registered on the trade_offer table, and a trade_offer row delivered by the SDK changes no store state and flushes no batch [TS4-4-NO-TRADE-OFFER]', async () => {
    // WRONG IMPL KILLED: the `trade_offer` query kept (the client ingests every public offer);
    // the query dropped but the onInsert / onUpdate / onDelete handlers kept on
    // `conn.db.trade_offer` (or a camelCase `tradeOffer`); a handler that writes the row into
    // the session map or schedules a flush (a trade_offer row would wake every batch listener).
    const opts = await bt12Connect();
    const queries = H.builds[0].queries ?? [];
    expect(
      queries.filter((q) => /trade_?offer/i.test(q)),
      'no query names the trade_offer table',
    ).toEqual([]);
    expect(
      Object.keys(H.rowEvents).filter((name) => /trade_?offer/i.test(name)),
      'no handler on the trade_offer table handle',
    ).toEqual([]);

    const flushed = vi.fn();
    opts.store.onBatchApplied(flushed);
    const offerRow = {
      tradeId: 7n,
      initiator: ID,
      counterparty: { toHexString: () => 'bb'.repeat(32) },
      initiatorMonsterIds: [5n],
      initiatorItems: [],
      initiatorCurrency: 0n,
      counterpartyMonsterIds: [],
      counterpartyItems: [],
      counterpartyCurrency: 0n,
      initiatorCards: [],
      counterpartyCards: [],
      status: { tag: 'Pending' },
      createdAtMs: 1n,
    };
    for (const name of ['trade_offer', 'tradeOffer']) {
      const events = H.rowEvents[name];
      for (const cb of events?.insert ?? []) cb({}, offerRow);
      for (const cb of events?.update ?? []) cb({}, offerRow, offerRow);
      for (const cb of events?.delete ?? []) cb({}, offerRow);
    }
    await settle();
    expect(flushed, 'a trade_offer row flushes no batch').toHaveBeenCalledTimes(0);
    expect(opts.store.allTradeSessions(), 'nor lands in the session map').toEqual([]);
    const store = opts.store as unknown as Record<string, unknown>;
    for (const member of ['ownTradeOffer', 'allTradeOffers', 'upsertTradeOffer']) {
      expect(Reflect.has(store, member), `the store has no ${member}`).toBe(false);
    }
  });

  it('myTradeSession registers onInsert and onDelete and no onUpdate; a burst of callbacks is ONE flushed batch, and the store is rebuilt from the view cache inside it (a row leaving the cache leaves the store)', async () => {
    // WRONG IMPL KILLED: no handler on `conn.db.myTradeSession` (nothing is ever reconciled); an
    // onUpdate (a PK-less view never fires one); a per-row store write (an unordered insert+delete
    // pair would wipe the row the insert half wrote); a flush per callback; the reconcile placed
    // after flushBatch (a listener would read the pre-burst sessions: the editor one batch late);
    // an upsert-only reconcile (a cancelled session never leaves).
    const opts = await bt12Connect();
    const events = H.rowEvents.myTradeSession;
    expect(events, 'handlers on conn.db.myTradeSession').toBeDefined();
    if (events === undefined) return;
    expect(events.insert.length).toBeGreaterThan(0);
    expect(events.delete.length).toBeGreaterThan(0);
    expect(events.update.length, 'no onUpdate on a view').toBe(0);

    const seen: bigint[][] = [];
    opts.store.onBatchApplied(() => {
      seen.push(opts.store.allTradeSessions().map((s) => s.sessionId));
    });
    H.viewRows.myTradeSession = [ts3Row(9n), ts3Row(4n)];
    for (const cb of events.insert) cb({}, ts3Row(9n));
    for (const cb of events.insert) cb({}, ts3Row(4n));
    await settle();
    expect(seen, 'one burst, one batch, the cache already reconciled').toEqual([[4n, 9n]]);
    expect(opts.store.allTradeSessions()[0]?.opener, 'converted: the identity hex').toBe(
      ID.toHexString(),
    );

    H.viewRows.myTradeSession = [ts3Row(9n, 2n)];
    for (const cb of events.delete) cb({}, ts3Row(4n));
    for (const cb of events.insert) cb({}, ts3Row(9n, 2n));
    await settle();
    expect(seen, 'the second burst is the second batch').toEqual([[4n, 9n], [9n]]);
    expect(opts.store.allTradeSessions()[0]?.revision).toBe(2n);

    H.viewRows.myTradeSession = [];
    for (const cb of events.delete) cb({}, ts3Row(9n, 2n));
    await settle();
    expect(opts.store.allTradeSessions(), 'the emptied cache empties the store').toEqual([]);
  });

  it('a malformed my_trade_session row that makes the converter throw is contained: the inventory, battle and tactical views still land, the batch still flushes once and the throw is logged', async () => {
    // WRONG IMPL KILLED: the session reconcile inside another view's try (its throw would starve
    // that view's siblings); no guard at all (the throw escapes the batcher and no batch is ever
    // delivered); a silent swallow (no log line).
    const opts = await bt12Connect();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const flushed = vi.fn();
      opts.store.onBatchApplied(flushed);
      const malformed = new Proxy(
        {},
        {
          get: () => {
            throw new Error('malformed my_trade_session row');
          },
        },
      );
      H.viewRows.myTradeSession = [malformed];
      H.viewRows.my_inventory = [{ invId: 43n, ownerIdentity: ID, itemId: 5, count: 3 }];
      H.viewRows.myBattle = [bt12SdkBattle(47n)];
      H.viewRows.myFormation = [bt12Formation([37n])];
      for (const cb of H.rowEvents.myTradeSession?.insert ?? []) cb({}, {});
      bt12Fire('insert', ['my_inventory', 'myFormation']);
      await settle();
      expect(flushed, 'the batch is still delivered, once').toHaveBeenCalledTimes(1);
      expect(opts.store.ownInventory(BT12_ME)).toEqual([
        { invId: 43n, ownerIdentity: BT12_ME, itemId: 5, count: 3 },
      ]);
      expect(opts.store.ongoingBattle(BT12_ME)?.battleId).toBe(47n);
      expect(opts.store.ownFormation(BT12_ME)?.monsterIds).toEqual([37n]);
      expect(errors.mock.calls.length, 'the contained throw is logged').toBeGreaterThan(0);
    } finally {
      errors.mockRestore();
    }
  });
});

// =============================================================================================
// The world scope: `character` is subscribed as the own row plus one set per wanted zone, each a
// handle of its own, driven by worldScope.ts. These tests drive the REAL connect() with the SDK
// faked: what is subscribed and when, what a warp does, what a rebuild and a failed set do.
// =============================================================================================

const WS_E = 77n;
const WS_OWN_QUERY = 'SELECT * FROM character WHERE entity_id = 77';
const wsZoneQuery = (zone: number) => `SELECT * FROM character WHERE zone_id = ${zone}`;
const wsPlayer = (entityId: bigint = WS_E, identity: { toHexString(): string } = ID) => ({
  identity,
  entityId,
  name: 'Tester',
  online: true,
  discriminator: 0,
  leadLevel: 0,
});
const wsChar = (entityId: bigint, zoneId: number, tileX = 2, tileY = 2) => ({
  entityId,
  zoneId,
  tileX,
  tileY,
  facing: { tag: 'Down' },
  action: { tag: 'Idle' },
  moveStartedAtMs: 0n,
  moveQueue: [],
  ackedSeq: 0n,
});
/** Run build `buildIdx`'s handler for one row event, as the SDK would. */
function wsFire(
  table: 'character' | 'player',
  event: 'insert' | 'update' | 'delete',
  args: unknown[],
  buildIdx = 0,
): void {
  const cb = H.rowEvents[table]?.[event][buildIdx];
  if (cb === undefined) throw new Error(`no ${table}.${event} handler for build ${buildIdx}`);
  cb({}, ...args);
}
/** The world-scope subscribes of a build: every subscribe after the base set. */
const wsSubs = (b: BuildRec): SubRec[] => b.subs.slice(1);
const wsQueries = (b: BuildRec): unknown[] => wsSubs(b).map((sub) => sub.query);
function wsApply(sub: SubRec | undefined): void {
  if (sub === undefined) throw new Error('no such subscribe');
  sub.active = true;
  sub.onApplied?.();
}
function wsReject(sub: SubRec | undefined, message = 'bad query'): void {
  if (sub === undefined) throw new Error('no such subscribe');
  sub.active = false;
  sub.onError?.({ event: new Error(message) });
}
const wsUnsubscribes = (b: BuildRec): number =>
  b.subs.reduce((total, sub) => total + sub.unsubscribes, 0);
/** Options whose scope-facing callbacks are typed mocks. */
function wsOpts() {
  const onError = vi.fn<(where: string, message: string) => void>();
  const onScopeSettled = vi.fn<(settled: boolean) => void>();
  const onOwnWarp = vi.fn<(newZoneId: number) => void>();
  const opts: ConnectionOptions = { ...makeOpts(), onError, onScopeSettled, onOwnWarp };
  return { opts, onError, onScopeSettled, onOwnWarp };
}
type WsOpts = ReturnType<typeof wsOpts>;
const wsErrors = (w: WsOpts, where: string): unknown[][] =>
  w.onError.mock.calls.filter(([at]) => at === where);
const wsLinkErrors = (w: WsOpts): unknown[][] => wsErrors(w, 'link');

/** Connect, apply the base set, then deliver the own player row and the own character row, each
 *  set applied as it is issued: the login sequence, ending settled in `zone`. */
async function wsSettled(zone = 0, w: WsOpts = wsOpts(), tileX = 2, tileY = 2) {
  const handle = connect(w.opts);
  await settle();
  const b = H.builds[0];
  b.onConnect?.(conn0(b), ID, 'anon-tok');
  b.onApplied?.();
  wsFire('player', 'insert', [wsPlayer()]);
  wsApply(wsSubs(b)[0]);
  wsFire('character', 'insert', [wsChar(WS_E, zone, tileX, tileY)]);
  wsApply(wsSubs(b)[1]);
  return { handle, w, b };
}
/** Zones 0 and 1, each with one warp on (1,5) into the other, as the content has them. */
const wsZoneWarps = (zoneId: number) =>
  zoneId === 0 || zoneId === 1 ? [{ from: { x: 1, y: 5 }, to_zone: 1 - zoneId }] : [];
/** Options as `wsOpts`, with the two-zone warp table. */
function wsPrefetchOpts(): WsOpts {
  const w = wsOpts();
  return { ...w, opts: { ...w.opts, zoneWarps: wsZoneWarps } };
}
/** Move the own row one step inside its zone. */
function wsStep(zone: number, from: [number, number], to: [number, number]): void {
  wsFire('character', 'update', [wsChar(WS_E, zone, ...from), wsChar(WS_E, zone, ...to)]);
}

describe('connect(): the world scope', { sequential: true }, () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    H.builds = [];
    H.renew = null;
    H.renewCalls = 0;
    H.startGuestClaimImpl = null;
    H.viewRows = {};
    H.rowCbs = {};
    H.rowEvents = {};
    H.builderThrows = false;
    H.beginSignIn = vi.fn(() => Promise.resolve({ kind: 'transient-error' }));
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
  });

  it('login: nothing beyond the base set until the own player row, then the own-row set, then the own zone once the own character row arrives; settled only when both are applied [WS-LOGIN]', async () => {
    // WRONG IMPL KILLED: a zone assumed before the own row says which (zone 0 subscribed for a
    // character that is in zone 1); the zone set issued before the own-row set applied a row;
    // settled reported on the first applied set; a query text other than the canonical one.
    const w = wsOpts();
    const handle = connect(w.opts);
    await settle();
    const b = H.builds[0];
    b.onConnect?.(conn0(b), ID, 'anon-tok');
    expect(b.subs, 'onConnect issues the base set alone').toHaveLength(1);
    b.onApplied?.();
    expect(wsQueries(b), 'no own player row yet: nothing to scope by').toEqual([]);
    expect(w.onScopeSettled.mock.calls, 'the scope opens unsettled').toEqual([[false]]);

    // Another player's rows decide nothing.
    const other = { toHexString: () => 'ee'.repeat(32) };
    wsFire('player', 'insert', [wsPlayer(5n, other)]);
    wsFire('character', 'insert', [wsChar(5n, 1)]);
    expect(wsQueries(b)).toEqual([]);

    wsFire('player', 'insert', [wsPlayer()]);
    expect(wsQueries(b), 'the own-row set, by entity id').toEqual([WS_OWN_QUERY]);
    wsApply(wsSubs(b)[0]);
    expect(wsQueries(b), 'no own character row yet: no zone').toEqual([WS_OWN_QUERY]);

    wsFire('character', 'insert', [wsChar(WS_E, 1)]);
    expect(wsQueries(b), 'the zone the own row is in, never an assumed one').toEqual([
      WS_OWN_QUERY,
      wsZoneQuery(1),
    ]);
    expect(handle.worldScope()).toEqual({
      own: 'active',
      zones: [{ zoneId: 1, state: 'pending' }],
      settled: false,
    });
    expect(w.onScopeSettled.mock.calls).toEqual([[false]]);

    wsApply(wsSubs(b)[1]);
    expect(w.onScopeSettled.mock.calls).toEqual([[false], [true]]);
    expect(handle.worldScope()).toEqual({
      own: 'active',
      zones: [{ zoneId: 1, state: 'active' }],
      settled: true,
    });
    // Nothing else is ever issued while nothing changes.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.subs).toHaveLength(3);
    expect(wsUnsubscribes(b)).toBe(0);
    expect(b.disconnect).not.toHaveBeenCalled();
  });

  it('a second tab: the own player row is already there when the base set applies, and the scope follows the own character row into zone 1 [WS-SECOND-TAB]', async () => {
    const { b, handle } = await wsSettled(1);
    expect(wsQueries(b)).toEqual([WS_OWN_QUERY, wsZoneQuery(1)]);
    expect(handle.worldScope().settled).toBe(true);
  });

  it('a warp is one own-row update: exactly one onOwnWarp, before the store takes the row, and the new zone is subscribed inside that same callback; the old zone is unsubscribed once, after the new one applied and the linger passed [WS-WARP]', async () => {
    // WRONG IMPL KILLED: onOwnWarp after ingestChar (switchZone would run against a store already
    // in the new zone); the zone subscribe left to the timer (one tick of empty zone on top of
    // the round trip); the old zone unsubscribed at the warp, or before the new one applied (a
    // frame with neither zone's rows); unsubscribed twice.
    const w = wsOpts();
    const seen: { storeZone: number | undefined; subs: number }[] = [];
    const { b } = await wsSettled(0, w);
    w.onOwnWarp.mockImplementation(() => {
      seen.push({
        storeZone: w.opts.store.ownCharacter(ID.toHexString())?.row.zoneId,
        subs: b.subs.length,
      });
    });
    const zone0 = wsSubs(b)[1];
    w.onScopeSettled.mockClear();

    wsFire('character', 'update', [wsChar(WS_E, 0, 1, 5), wsChar(WS_E, 1, 1, 5)]);
    expect(w.onOwnWarp.mock.calls).toEqual([[1]]);
    expect(
      seen,
      'at onOwnWarp the store still holds the old row and nothing is issued yet',
    ).toEqual([{ storeZone: 0, subs: 3 }]);
    expect(w.opts.store.ownCharacter(ID.toHexString())?.row.zoneId).toBe(1);
    expect(wsQueries(b), 'issued by the time the update callback returns').toEqual([
      WS_OWN_QUERY,
      wsZoneQuery(0),
      wsZoneQuery(1),
    ]);
    expect(w.onScopeSettled.mock.calls).toEqual([[false]]);
    expect(wsUnsubscribes(b), 'the old zone is held').toBe(0);

    // Four seconds on the new zone is still not applied: the old zone is held.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(wsUnsubscribes(b)).toBe(0);
    wsApply(wsSubs(b)[2]);
    expect(w.onScopeSettled.mock.calls).toEqual([[false], [true]]);
    expect(wsUnsubscribes(b), 'applied, but the linger has not passed').toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(zone0.unsubscribes, 'the old zone, once').toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(wsUnsubscribes(b)).toBe(1);
    expect(b.subs).toHaveLength(4);
    expect(w.onOwnWarp).toHaveBeenCalledTimes(1);
  });

  it('a zone whose linger has ended is held while the own zone is not applied, and released once it is [WS-WARP-CHAIN]', async () => {
    // WRONG IMPL KILLED: the old zone released on its linger alone. After a second warp the
    // first zone's linger ends while the third zone's set is still inside its timeout; with
    // zone 0 gone the store would hold no zone the player has been drawn in.
    const { b } = await wsSettled(0);
    const zone0 = wsSubs(b)[1];
    wsFire('character', 'update', [wsChar(WS_E, 0, 1, 5), wsChar(WS_E, 1, 1, 5)]);
    wsApply(wsSubs(b)[2]);
    await vi.advanceTimersByTimeAsync(4_000);
    wsFire('character', 'update', [wsChar(WS_E, 1, 1, 5), wsChar(WS_E, 2, 1, 5)]);
    expect(wsQueries(b)).toEqual([WS_OWN_QUERY, wsZoneQuery(0), wsZoneQuery(1), wsZoneQuery(2)]);

    // 5.5 s after zone 0 was left, 1.5 s into zone 2's subscribe.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(wsUnsubscribes(b), 'zone 0 has lingered; zone 2 is not applied').toBe(0);

    wsApply(wsSubs(b)[3]);
    expect(zone0.unsubscribes, 'released in the step that applied the own zone').toBe(1);
    expect(wsUnsubscribes(b), 'zone 1 was left 1.5 s ago').toBe(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(wsSubs(b).map((sub) => sub.unsubscribes)).toEqual([0, 1, 1, 0]);
  });

  it('a bounce back into the old zone inside the linger re-subscribes nothing and unsubscribes nothing until the zone left last has lingered [WS-BOUNCE]', async () => {
    const { b } = await wsSettled(0);
    wsFire('character', 'update', [wsChar(WS_E, 0), wsChar(WS_E, 1)]);
    wsApply(wsSubs(b)[2]);
    await vi.advanceTimersByTimeAsync(2_000);
    wsFire('character', 'update', [wsChar(WS_E, 1), wsChar(WS_E, 0)]);
    expect(b.subs, 'zone 0 is still held: no new subscribe').toHaveLength(4);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(wsUnsubscribes(b), 'zone 0 is wanted again; zone 1 has lingered 4 s').toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(wsSubs(b).map((sub) => sub.unsubscribes)).toEqual([0, 0, 1]);
  });

  it('within four tiles of a warp the destination zone is subscribed, in the step that crossed the line; the warp is then one own-row update that subscribes nothing and never unsettles; both zones are held while the row stands by the return warp [WS-PREFETCH]', async () => {
    // WRONG IMPL KILLED: no prefetch (the warp issues the destination's subscribe and the scope
    // is unsettled for a round trip); a distance other than four; the prefetch left to the
    // 500 ms timer; the warps of zone 0 read for a row that stands in zone 1 (zone 0 would be
    // released while the player stands on the return warp); a prefetched set gating `settled`.
    const w = wsPrefetchOpts();
    // (6,5) is five tiles from the warp on (1,5).
    const { b, handle } = await wsSettled(0, w, 6, 5);
    expect(wsQueries(b), 'five tiles away: the own zone alone').toEqual([
      WS_OWN_QUERY,
      wsZoneQuery(0),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.subs, 'standing five tiles away issues nothing').toHaveLength(3);
    w.onScopeSettled.mockClear();

    wsStep(0, [6, 5], [5, 5]);
    expect(wsQueries(b), 'four tiles away: issued by the time the update callback returns').toEqual(
      [WS_OWN_QUERY, wsZoneQuery(0), wsZoneQuery(1)],
    );
    expect(
      handle.worldScope(),
      'a prefetched set that is pending leaves the scope settled',
    ).toEqual({
      own: 'active',
      zones: [
        { zoneId: 0, state: 'active' },
        { zoneId: 1, state: 'pending' },
      ],
      settled: true,
    });
    wsApply(wsSubs(b)[2]);
    for (const x of [4, 3, 2]) wsStep(0, [x + 1, 5], [x, 5]);
    expect(b.subs, 'walking on toward the warp issues nothing more').toHaveLength(4);

    // The warp: the own row leaves zone 0's set and enters zone 1's, both held, so it is an update.
    wsFire('character', 'update', [wsChar(WS_E, 0, 2, 5), wsChar(WS_E, 1, 1, 5)]);
    expect(w.onOwnWarp.mock.calls).toEqual([[1]]);
    expect(b.subs, 'the destination is already held: the warp subscribes nothing').toHaveLength(4);
    expect(w.onScopeSettled.mock.calls, 'and the scope never left settled').toEqual([]);
    expect(handle.worldScope()).toEqual({
      own: 'active',
      zones: [
        { zoneId: 0, state: 'active' },
        { zoneId: 1, state: 'active' },
      ],
      settled: true,
    });

    // Standing on the arrival tile is standing on zone 1's warp back: zone 0 stays wanted.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsUnsubscribes(b), 'zone 0 is held by the return warp, however long').toBe(0);

    // Five tiles from the return warp zone 0 is no longer wanted; it goes after its linger.
    for (const x of [2, 3, 4, 5, 6]) wsStep(1, [x - 1, 5], [x, 5]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(wsUnsubscribes(b)).toBe(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(wsSubs(b).map((sub) => sub.unsubscribes)).toEqual([0, 1, 0]);
    expect(w.onScopeSettled.mock.calls).toEqual([]);
    expect(b.disconnect).not.toHaveBeenCalled();
  });

  it('pacing across the four-tile line costs the host at most one subscribe and one unsubscribe of the destination zone per linger [WS-PREFETCH-PACING]', async () => {
    // WRONG IMPL KILLED: unsubscribe on leaving the range (a pair per crossing, 2.5 pairs a
    // second at walking speed); a linger restarted or skipped by a re-entry.
    const w = wsPrefetchOpts();
    const { b } = await wsSettled(0, w, 6, 5);
    const subscribedAt: number[] = [];
    const unsubscribedAt: number[] = [];
    let seenSubs = b.subs.length;
    let seenUnsubs = 0;
    /** Apply every set issued since the last look and stamp what the host was asked for. */
    const look = (): void => {
      for (const sub of b.subs.slice(seenSubs)) {
        expect(sub.query, 'only the destination zone is ever issued').toBe(wsZoneQuery(1));
        subscribedAt.push(performance.now());
        wsApply(sub);
      }
      seenSubs = b.subs.length;
      for (let n = wsUnsubscribes(b); seenUnsubs < n; seenUnsubs += 1) {
        unsubscribedAt.push(performance.now());
      }
    };
    /** One crossing in and one back out, then `outMs` standing outside, looked at every 100 ms. */
    const cross = async (outMs: number): Promise<void> => {
      wsStep(0, [6, 5], [5, 5]);
      look();
      await vi.advanceTimersByTimeAsync(200);
      wsStep(0, [5, 5], [6, 5]);
      look();
      for (let waited = 0; waited < outMs; waited += 100) {
        await vi.advanceTimersByTimeAsync(100);
        look();
      }
    };
    // Fast pacing (a crossing every 400 ms) for 12 s, then slow pacing whose stay outside is
    // just over a linger, then fast again.
    for (let i = 0; i < 30; i += 1) await cross(200);
    expect(subscribedAt, 'fast pacing: one subscribe').toHaveLength(1);
    expect(unsubscribedAt, 'fast pacing: the zone never lingers out').toHaveLength(0);
    for (let i = 0; i < 4; i += 1) await cross(5_600);
    for (let i = 0; i < 30; i += 1) await cross(200);

    expect(subscribedAt.length, 'ANTI-VACUITY: the slow pacing re-subscribed').toBeGreaterThan(3);
    expect(unsubscribedAt.length, 'ANTI-VACUITY: and unsubscribed').toBeGreaterThan(3);
    const gaps = (at: number[]): number[] => at.slice(1).map((t, i) => t - (at[i] as number));
    expect(Math.min(...gaps(subscribedAt)), 'subscribes are a linger apart').toBeGreaterThanOrEqual(
      LINGER_MS,
    );
    expect(
      Math.min(...gaps(unsubscribedAt)),
      'unsubscribes are a linger apart',
    ).toBeGreaterThanOrEqual(LINGER_MS);
    expect(
      wsSubs(b).every((sub) => sub.unsubscribes <= 1),
      'no set is ended twice',
    ).toBe(true);
    expect(wsLinkErrors(w)).toEqual([]);
  });

  it('a prefetched zone that is rejected is reported, tried again no sooner than a second later, and never ends the connection; one that never applies does not either [WS-PREFETCH-FAILS]', async () => {
    // WRONG IMPL KILLED: a prefetch failure on the own zone's ladder (a zone the player is not
    // in costs them their connection); a rejected prefetch re-issued on every scope run.
    const w = wsPrefetchOpts();
    const { b, handle } = await wsSettled(0, w, 5, 5);
    expect(wsQueries(b)).toEqual([WS_OWN_QUERY, wsZoneQuery(0), wsZoneQuery(1)]);
    for (let round = 0; round < 6; round += 1) {
      wsReject(b.subs[b.subs.length - 1]);
      expect(wsErrors(w, 'subscribe')).toHaveLength(round + 1);
      const held = b.subs.length;
      await vi.advanceTimersByTimeAsync(900);
      expect(b.subs, 'not re-issued inside the second').toHaveLength(held);
      await vi.advanceTimersByTimeAsync(600);
      expect(b.subs, 'still wanted a second later: one more try').toHaveLength(held + 1);
    }
    // The last try is never answered.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.subs, 'the base set, the three first issued, six retries').toHaveLength(4 + 6);
    expect(handle.worldScope().settled).toBe(true);
    expect(wsLinkErrors(w)).toEqual([]);
    expect(b.disconnect).not.toHaveBeenCalled();
  });

  it('a rebuilt connection starts with no world-scope set and nothing is unsubscribed on the way out; the dropped build issues nothing more [WS-REBUILD]', async () => {
    // WRONG IMPL KILLED: unsubscribe on a dead socket (the SDK throws or queues onto nothing);
    // scope state kept across the rebuild (the new connection believes it holds sets it never
    // asked for and shows an empty zone); the old build's timer still subscribing.
    const w = wsOpts();
    const { b, handle } = await wsSettled(0, w);
    w.onScopeSettled.mockClear();

    b.onDisconnect?.();
    expect(w.onScopeSettled.mock.calls, 'the drop unsettles').toEqual([[false]]);
    expect(handle.worldScope()).toEqual({ own: null, zones: [], settled: false });
    expect(w.opts.store.characterCount).toBe(0);
    await nextAttempt();
    expect(H.builds).toHaveLength(2);
    const b1 = H.builds[1];
    b1.onConnect?.(conn0(b1), ID, 'anon-tok');
    b1.onApplied?.();
    expect(b1.subs, 'the base set alone').toHaveLength(1);
    expect(wsUnsubscribes(b), 'no unsubscribe on the dropped connection').toBe(0);

    // A late callback of a dropped set, and time, change nothing on either build.
    wsApply(wsSubs(b)[1]);
    wsReject(wsSubs(b)[0]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.subs).toHaveLength(3);
    expect(b1.subs).toHaveLength(1);
    expect(wsUnsubscribes(b)).toBe(0);
    expect(handle.worldScope()).toEqual({ own: null, zones: [], settled: false });

    // The new build scopes from its own rows.
    wsFire('player', 'insert', [wsPlayer()], 1);
    expect(wsQueries(b1)).toEqual([WS_OWN_QUERY]);
  });

  it('a rejected own-zone set is reported and retried in place after each backoff; rejected once more than there are retries, the connection takes the drop path and is closed [WS-REJECTED]', async () => {
    // WRONG IMPL KILLED: a rejection ignored (the player stands in an empty zone for good); an
    // immediate retry loop; a retry issued while the previous handle is live; the drop path taken
    // on the first rejection (a reconnect replaces the player's character); the socket left open
    // after it.
    const { b, w } = await wsSettled(0);
    const subscribeErrors = (): unknown[][] => wsErrors(w, 'subscribe');

    wsReject(wsSubs(b)[1], 'no such column');
    expect(subscribeErrors()).toEqual([['subscribe', 'no such column']]);
    expect(b.subs, 'not retried at once').toHaveLength(3);

    const backoffs = [250, 500, 1000];
    for (const [i, wait] of backoffs.entries()) {
      // The 500 ms tick is what retries: by `wait` rounded up to a tick the retry is out, and
      // one tick earlier it is not.
      const ticks = Math.ceil(wait / 500);
      await vi.advanceTimersByTimeAsync((ticks - 1) * 500);
      expect(b.subs, `retry ${i + 1} waits its backoff`).toHaveLength(3 + i);
      await vi.advanceTimersByTimeAsync(500);
      expect(b.subs, `retry ${i + 1} is issued`).toHaveLength(4 + i);
      expect(b.subs[3 + i].query).toBe(wsZoneQuery(0));
      expect(wsLinkErrors(w), 'still on this connection').toEqual([]);
      expect(b.disconnect).not.toHaveBeenCalled();
      wsReject(b.subs[3 + i]);
    }
    // The fourth rejection in a row: the scope is re-evaluated in that callback and drops.
    expect(subscribeErrors()).toHaveLength(4);
    expect(wsLinkErrors(w)).toHaveLength(1);
    expect(b.disconnect).toHaveBeenCalledTimes(1);
    expect(wsUnsubscribes(b), 'nothing is unsubscribed on the way out').toBe(0);
    expect(w.opts.store.playerCount, 'the drop path reset the store').toBe(0);
    await nextAttempt();
    expect(H.builds, 'and a rebuild follows').toHaveLength(2);
    expect(b.subs, 'no further retry on the dropped build').toHaveLength(6);
  });

  it('a set that applies clears its rejections: a later rejection starts the ladder again [WS-REJECTED-RESET]', async () => {
    const { b, w } = await wsSettled(0);
    for (let i = 0; i < 3; i += 1) {
      wsReject(b.subs[b.subs.length - 1]);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(b.subs).toHaveLength(6);
    wsApply(b.subs[5]);
    wsReject(b.subs[5]);
    expect(
      b.disconnect,
      'one rejection after an applied set is not the fourth',
    ).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(b.subs).toHaveLength(7);
    expect(wsLinkErrors(w)).toEqual([]);
  });

  it('an own-zone set still not applied after 5 s takes the drop path; at 4.5 s it has not [WS-TIMEOUT]', async () => {
    // WRONG IMPL KILLED: no timeout (a lost applied message leaves the player in an empty zone
    // with a live-looking link); a timeout that retries in place on an ordered socket.
    const w = wsOpts();
    connect(w.opts);
    await settle();
    const b = H.builds[0];
    b.onConnect?.(conn0(b), ID, 'anon-tok');
    b.onApplied?.();
    wsFire('player', 'insert', [wsPlayer()]);
    wsApply(wsSubs(b)[0]);
    wsFire('character', 'insert', [wsChar(WS_E, 0)]);
    expect(wsQueries(b)).toEqual([WS_OWN_QUERY, wsZoneQuery(0)]);

    await vi.advanceTimersByTimeAsync(4_500);
    expect(b.disconnect).not.toHaveBeenCalled();
    expect(wsLinkErrors(w)).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(b.disconnect).toHaveBeenCalledTimes(1);
    expect(wsLinkErrors(w)).toHaveLength(1);
    expect(wsUnsubscribes(b)).toBe(0);
    await nextAttempt();
    expect(H.builds).toHaveLength(2);
  });

  it('an own-row set still not applied after 5 s takes the drop path too [WS-TIMEOUT-OWN]', async () => {
    const w = wsOpts();
    connect(w.opts);
    await settle();
    const b = H.builds[0];
    b.onConnect?.(conn0(b), ID, 'anon-tok');
    b.onApplied?.();
    wsFire('player', 'insert', [wsPlayer()]);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(b.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(b.disconnect).toHaveBeenCalledTimes(1);
  });

  it('a player row`s discriminator and lead level reach the store through the real connect(): an insert carries 42 and 7, an update to lead level 8 replaces the row, and another player`s row keeps its own values [ih-3.1]', async () => {
    // WRONG IMPL KILLED: a converter that drops the two fields (undefined in the store), hard-codes
    // 0, swaps them (7 / 42), or reads the lead level from the discriminator (42 / 42); an update
    // handler that keeps the inserted row (the level stays 7); a store keyed so that the second
    // player's row overwrites the first one's values.
    const { w } = await wsSettled(0);
    const store = w.opts.store;
    const hex = ID.toHexString();
    const other = { toHexString: () => 'ef'.repeat(32) };
    const inserted = { ...wsPlayer(), discriminator: 42, leadLevel: 7 };
    wsFire('player', 'insert', [inserted]);
    expect(store.player(hex), 'the inserted row, both fields from the row').toMatchObject({
      identity: hex,
      entityId: WS_E,
      name: 'Tester',
      online: true,
      discriminator: 42,
      leadLevel: 7,
    });
    wsFire('player', 'insert', [{ ...wsPlayer(6n, other), discriminator: 1234, leadLevel: 3 }]);
    wsFire('player', 'update', [inserted, { ...inserted, leadLevel: 8 }]);
    expect(store.player(hex)?.discriminator, 'the update keeps the discriminator').toBe(42);
    expect(store.player(hex)?.leadLevel, 'the update replaces the lead level').toBe(8);
    expect(store.player(other.toHexString())?.discriminator, 'the other row, its own tag').toBe(
      1234,
    );
    expect(store.player(other.toHexString())?.leadLevel, 'the other row, its own level').toBe(3);
  });

  it('an unsubscribe that throws does not escape the scope run, and the scope carries on [WS-UNSUBSCRIBE-THROWS]', async () => {
    // WRONG IMPL KILLED: an unguarded unsubscribe. A scope run inside a row callback would abort the SDK's
    // dispatch of the rest of that message; a throw in the timer is an uncaught error every tick.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { b, handle, w } = await wsSettled(0);
      wsFire('character', 'update', [wsChar(WS_E, 0), wsChar(WS_E, 1)]);
      wsApply(wsSubs(b)[2]);
      // The zone-0 handle now throws on unsubscribe, as the SDK's does when it was already called.
      const zone0 = wsSubs(b)[1];
      zone0.unsubscribes = 1;
      await vi.advanceTimersByTimeAsync(4_900);
      // The tick that ends the linger makes the call; the throw stays inside the scope run.
      expect(() => {
        vi.advanceTimersByTime(600);
      }).not.toThrow();
      expect(zone0.unsubscribes, 'it was called, and threw').toBe(2);
      expect(errors).toHaveBeenCalled();
      expect(handle.worldScope()).toEqual({
        own: 'active',
        zones: [{ zoneId: 1, state: 'active' }],
        settled: true,
      });
      // The scope still works: the next warp subscribes as usual.
      expect(() => wsFire('character', 'update', [wsChar(WS_E, 1), wsChar(WS_E, 2)])).not.toThrow();
      expect(wsQueries(b)[3]).toBe(wsZoneQuery(2));
      expect(wsLinkErrors(w)).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('losing the own character row unsettles the scope and its zone is unsubscribed after the linger; the own-row set stays [WS-OWN-ROW-LOST]', async () => {
    const w = wsOpts();
    const { b, handle } = await wsSettled(0, w);
    w.onScopeSettled.mockClear();
    wsFire('character', 'delete', [wsChar(WS_E, 0)]);
    expect(w.onScopeSettled.mock.calls).toEqual([[false]]);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(wsSubs(b).map((sub) => sub.unsubscribes)).toEqual([0, 1]);
    expect(handle.worldScope()).toEqual({ own: 'active', zones: [], settled: false });
    expect(b.disconnect).not.toHaveBeenCalled();
  });
});

// =============================================================================================
// Every reconnect attempt that ends without an applied subscription climbs exactly one rung
// of the backoff ladder (1000, 2000, 4000, 8000, 16000, 30000, 30000 ms …), whichever events
// report the failure and whichever build path started the attempt.
// =============================================================================================

/** The build at index `i`, failing the test readably when that attempt never reached the builder. */
function npBuild(i: number): BuildRec {
  const b = H.builds[i];
  expect(b, `build #${i} was made`).toBeDefined();
  return b;
}

/** The attempt's socket opened, then dropped before any subscription applied. */
function npOpenAndDrop(b: BuildRec): void {
  b.onConnect?.(conn0(b), ID, 'anon-tok');
  b.onDisconnect?.();
}

/** The attempt's socket reported a connect error. */
function npConnectError(b: BuildRec): void {
  b.onConnectError?.({}, new Error('refused'));
}

/** The attempt's socket opened, its first subscription applied, then the link dropped. */
function npConnectedDrop(b: BuildRec): void {
  b.onConnect?.(conn0(b), ID, 'anon-tok');
  b.onApplied?.();
  b.onDisconnect?.();
}

/**
 * The next attempt starts exactly `delayMs` from now: `count` is unchanged after `delayMs - 1`
 * and one higher after 1 ms more. `count` defaults to the builder calls; an account tab whose
 * attempts never reach the builder counts the credential resolves instead.
 */
async function npExpectNextAttemptAfter(
  delayMs: number,
  count: () => number = () => H.builds.length,
): Promise<void> {
  const before = count();
  await vi.advanceTimersByTimeAsync(delayMs - 1);
  expect(count(), `no attempt ${delayMs - 1} ms after the failure`).toBe(before);
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(count(), `the next attempt ${delayMs} ms after the failure`).toBe(before + 1);
}

describe('connect(): one backoff rung per failed reconnect attempt', { sequential: true }, () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    H.builds = [];
    H.renew = null;
    H.renewCalls = 0;
    H.startGuestClaimImpl = null;
    H.viewRows = {};
    H.rowCbs = {};
    H.rowEvents = {};
    H.builderThrows = false;
    H.beginSignIn = vi.fn(() => Promise.resolve({ kind: 'transient-error' }));
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
  });

  it('successive attempts that each open and drop before the first applied subscription are rebuilt at 1000, 2000, 4000, 8000, 16000, 30000, 30000 ms [np-d.7]', async () => {
    // WRONG IMPL KILLED: the drop of a non-connected link as a no-op (every rebuild at 1000 ms, a
    // restarting host hammered); a drop that climbs two rungs (4000 where 2000 is due); an
    // uncapped ladder (32000 where 30000 is due).
    connect(makeOpts());
    await settle();
    npConnectedDrop(npBuild(0));
    const ladder = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const delay of ladder) {
      await npExpectNextAttemptAfter(delay);
      npOpenAndDrop(npBuild(H.builds.length - 1));
    }
  });

  it('first boot: an attempt that opens and drops before its subscription applies is retried at 2000 ms, not 1000 [np-d.5]', async () => {
    // Trace: boot starts attempt 0 → open, drop → rung 1 → 2000 ms.
    // WRONG IMPL KILLED: the first boot not starting an attempt (its drop climbs nothing: 1000).
    connect(makeOpts());
    await settle();
    npOpenAndDrop(npBuild(0));
    await npExpectNextAttemptAfter(2000);
  });

  it('first boot: a drop then a connect error of the one attempt climbs one rung — 2000 ms, then 4000 after the next failure [np-d.5]', async () => {
    // Trace: boot attempt 0 → drop → rung 1 (2000 scheduled) → connect error → still rung 1;
    // attempt 1 → connect error → rung 2 → 4000.
    // WRONG IMPL KILLED: the drop climbing nothing (the 1000 ms rebuild is already pending when
    // the error climbs); both events climbing (rung 3 after the second attempt: 8000).
    connect(makeOpts());
    await settle();
    const b0 = npBuild(0);
    b0.onDisconnect?.();
    npConnectError(b0);
    await npExpectNextAttemptAfter(2000);
    npConnectError(npBuild(1));
    await npExpectNextAttemptAfter(4000);
  });

  it('first boot: a connect error then a drop of the one attempt climbs one rung — 2000 ms, then 4000 after the next failure [np-d.5]', async () => {
    // Trace: boot attempt 0 → connect error → rung 1 (2000) → drop → still rung 1;
    // attempt 1 → connect error → rung 2 → 4000.
    // WRONG IMPL KILLED: the trailing drop climbing a second rung (8000 after the next failure).
    connect(makeOpts());
    await settle();
    const b0 = npBuild(0);
    npConnectError(b0);
    b0.onDisconnect?.();
    await npExpectNextAttemptAfter(2000);
    npConnectError(npBuild(1));
    await npExpectNextAttemptAfter(4000);
  });

  it('timer path: a rebuilt attempt reporting a connect error then a drop climbs one rung — 2000 ms, then 4000 [np-d.5]', async () => {
    // Trace: connected drop keeps rung 0 → 1000; attempt (timer) → error → rung 1 (2000) → drop
    // → still rung 1; next attempt → error → rung 2 → 4000.
    // WRONG IMPL KILLED: the drop after the error climbing again (8000 where 4000 is due).
    connect(makeOpts());
    await settle();
    npConnectedDrop(npBuild(0));
    await npExpectNextAttemptAfter(1000);
    const b1 = npBuild(1);
    npConnectError(b1);
    b1.onDisconnect?.();
    await npExpectNextAttemptAfter(2000);
    npConnectError(npBuild(2));
    await npExpectNextAttemptAfter(4000);
  });

  it('timer path: a rebuilt attempt reporting a drop then a connect error climbs one rung — 2000 ms, then 4000 [np-d.5]', async () => {
    // Trace: connected drop → 1000; attempt (timer) → drop → rung 1 (2000 scheduled) → error →
    // still rung 1; next attempt → error → rung 2 → 4000.
    // WRONG IMPL KILLED: the drop climbing nothing (the 1000 ms rebuild is scheduled before the
    // error climbs); both events climbing (8000 where 4000 is due).
    connect(makeOpts());
    await settle();
    npConnectedDrop(npBuild(0));
    await npExpectNextAttemptAfter(1000);
    const b1 = npBuild(1);
    b1.onDisconnect?.();
    npConnectError(b1);
    await npExpectNextAttemptAfter(2000);
    npConnectError(npBuild(2));
    await npExpectNextAttemptAfter(4000);
  });

  it('reconnectNow called on a disconnected link with a rebuild pending starts an attempt that climbs its own rung [np-d.5]', async () => {
    // Trace (rung after each step):
    //   boot attempt 0 → connect error → rung 1, link disconnected, the 2000 ms rebuild pending
    //   reconnectNow → attempt 1 → open, drop → rung 2 (the pending timer is kept)
    //   the pending timer fires at 2000 → attempt 2 → open, drop → rung 3 → 8000 ms
    // WRONG IMPL KILLED: reconnectNow not starting an attempt (its drop lands on a disconnected
    // link and climbs nothing: rung 2 → 4000); the drop of a non-connected link climbing nothing
    // (2000).
    const handle = connect(makeOpts());
    await settle();
    npConnectError(npBuild(0));
    handle.reconnectNow();
    await settle();
    expect(H.builds, 'reconnectNow built at once').toHaveLength(2);
    npOpenAndDrop(npBuild(1));
    await npExpectNextAttemptAfter(2000);
    npOpenAndDrop(npBuild(2));
    await npExpectNextAttemptAfter(8000);
  });

  it('continueAnonymously called on a disconnected link with a rebuild pending starts an attempt that climbs its own rung [np-d.5]', async () => {
    // Trace (rung after each step), an account tab:
    //   boot attempt 0 → the credential resolve rejects → rung 1, link disconnected, 2000 pending
    //   continueAnonymously → attempt 1 (anon build) → open, drop → rung 2
    //   the pending timer fires at 2000 → attempt 2 (anon, no resolve) → open, drop → rung 3 → 8000
    // WRONG IMPL KILLED: continueAnonymously not starting an attempt (rung 2 → 4000); the drop of a
    // non-connected link climbing nothing (2000).
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.reject(new Error('boom'));
    const handle = connect(makeOpts());
    await settle();
    expect(H.renewCalls).toBe(1);
    expect(H.builds).toHaveLength(0);
    handle.continueAnonymously();
    await settle();
    expect(H.builds, 'continueAnonymously built at once').toHaveLength(1);
    npOpenAndDrop(npBuild(0));
    await npExpectNextAttemptAfter(2000);
    expect(H.renewCalls, 'forced anonymous: no further resolve').toBe(1);
    npOpenAndDrop(npBuild(1));
    await npExpectNextAttemptAfter(8000);
  });

  it('a rejecting credential resolve on an account tab climbs one rung per attempt: resolves at 2000, 4000, 8000 ms [np-d.5]', async () => {
    // WRONG IMPL KILLED: an attempt started after the async credential gap (or not at all), so its
    // failure lands on a link that does not mark an attempt in flight and climbs nothing.
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.reject(new Error('boom'));
    connect(makeOpts());
    await settle();
    expect(H.renewCalls).toBe(1);
    const resolves = (): number => H.renewCalls;
    await npExpectNextAttemptAfter(2000, resolves);
    await npExpectNextAttemptAfter(4000, resolves);
    await npExpectNextAttemptAfter(8000, resolves);
    expect(H.builds, 'no attempt reached the builder').toHaveLength(0);
  });

  it('a transient-error credential outcome (the retry credential) climbs one rung: the second resolve at 2000 ms, not 1000 [np-d.5]', async () => {
    // WRONG IMPL KILLED: the retry arm's failure landing on an attempt not yet started (rung 0).
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'transient-error' });
    connect(makeOpts());
    await settle();
    expect(H.renewCalls).toBe(1);
    expect(H.builds).toHaveLength(0);
    await npExpectNextAttemptAfter(2000, () => H.renewCalls);
  });

  it('a synchronously throwing builder climbs one rung per attempt: rebuilt at 2000, then 4000 ms [np-d.5]', async () => {
    // WRONG IMPL KILLED: the build-throw arm's failure landing on an attempt not yet started.
    H.builderThrows = true;
    const opts = makeOpts();
    connect(opts);
    await settle();
    expect(H.builds, 'the first build reached the builder and threw').toHaveLength(1);
    expect(opts.onError).toHaveBeenCalledWith('connect', 'builder threw');
    await npExpectNextAttemptAfter(2000);
    await npExpectNextAttemptAfter(4000);
  });

  it('a connected drop followed by three attempts that each open and drop reports the lost link exactly once [np-d.6]', async () => {
    // WRONG IMPL KILLED: the link-lost report fired on every failed attempt's drop (it belongs to
    // the connected→disconnected edge only).
    const opts = makeOpts();
    connect(opts);
    await settle();
    npConnectedDrop(npBuild(0));
    for (let i = 1; i <= 3; i += 1) {
      await nextAttempt();
      npOpenAndDrop(npBuild(i));
    }
    expect(H.builds).toHaveLength(4);
    const linkReports = vi.mocked(opts.onError).mock.calls.filter((call) => call[0] === 'link');
    expect(linkReports).toHaveLength(1);
  });

  it('a reconnect whose subscription applies resets the ladder: the next drop is rebuilt at 1000 ms again [np-d.6]', async () => {
    // WRONG IMPL KILLED: the applied subscription not resetting the rung (the drop after it rebuilt
    // at 8000).
    connect(makeOpts());
    await settle();
    npConnectedDrop(npBuild(0));
    await npExpectNextAttemptAfter(1000);
    npConnectError(npBuild(1));
    await npExpectNextAttemptAfter(2000);
    npConnectError(npBuild(2));
    await npExpectNextAttemptAfter(4000);
    npConnectedDrop(npBuild(3));
    await npExpectNextAttemptAfter(1000);
  });
});

// =============================================================================================
// sr-6b: the owner views reconcile only when dirty. Each owner view's onInsert / onDelete marks
// that view for the next batch; an applied snapshot, a connection build() builds and a reset
// store mark every view; a non-view row handler that throws marks every view and schedules the
// flush before its error goes on to the SDK. Observed through the store's reconcile methods
// (spied, calling through) and the SDK cache reads (`H.iterCalls`). A new connection's views all
// start dirty, so each test first proves every view clean (a burst of character rows reconciles
// nothing) and only then pulls the one trigger it is about.
// =============================================================================================

type Sr6bMethod = Extract<keyof AuthoritativeStore, `reconcile${string}FromView`>;
/** The store method each owner view's reconcile calls: the expected wiring, written by hand. */
const SR6B_METHOD: Record<OwnerView, Sr6bMethod> = {
  my_monster_pub: 'reconcileMonstersFromView',
  myBattle: 'reconcileBattlesFromView',
  my_export_bundle: 'reconcileExportChunksFromView',
  myPendingEvolutionNotices: 'reconcileEvolutionNoticesFromView',
  my_inventory: 'reconcileInventoryFromView',
  myTacticalBattle: 'reconcileTacticalBattlesFromView',
  myBattleUnits: 'reconcileBattleUnitsFromView',
  myBattleQueue: 'reconcileBattleQueuesFromView',
  myBattleDeploy: 'reconcileBattleDeploysFromView',
  myBattleClock: 'reconcileBattleClocksFromView',
  myBattleEvents: 'reconcileBattleEventsFromView',
  myFormation: 'reconcileFormationFromView',
  myTradeSession: 'reconcileTradeSessionsFromView',
};
/** The owner views of the table above, in no particular order. A test that expects every view
 *  in reconcile order takes that order from OWNER_VIEWS, whose roster test is in
 *  viewReconcile.test.ts. */
const SR6B_VIEWS = Object.keys(SR6B_METHOD) as OwnerView[];
/** The owner-view tables, to tell them from every other table connect() wires. */
const SR6B_VIEW_TABLES = new Set<string>(SR6B_VIEWS);
/** Every owner-view row handler: each view's insert and delete. */
const SR6B_HANDLERS = SR6B_VIEWS.flatMap((view) =>
  (['insert', 'delete'] as const).map((event) => [view, event] as const),
);
/** Two callbacks the base subscription's onApplied makes, either of which may throw: the earliest
 *  after its stale check, and one near its end. */
const SR6B_APPLIED_THROWERS = (['claimCode.hasUnconsumed', 'onScopeSettled'] as const).map(
  (thrower) => [thrower] as const,
);
type Sr6bSpies = Record<OwnerView, MockInstance>;

const sr6bOther = { toHexString: () => 'ee'.repeat(32) };
const sr6bInventory = (invId: bigint, count: number) => ({
  invId,
  ownerIdentity: ID,
  itemId: 5,
  count,
});
/** The store row an `sr6bInventory` row lands as. */
const sr6bStoredInventory = (invId: bigint, count: number) => ({
  invId,
  ownerIdentity: BT12_ME,
  itemId: 5,
  count,
});
const sr6bChunk = (chunkId: bigint) => ({
  chunkId,
  ownerIdentity: ID,
  requestId: 3n,
  tableName: 'monster',
  chunkIndex: 0,
  totalChunks: 1,
  payloadJson: '{"a":"1"}',
  createdAtMs: 5n,
});
/** A row whose every property read throws `thrown`. */
const sr6bMalformed = (thrown: unknown): unknown =>
  new Proxy(
    {},
    {
      get: () => {
        throw thrown;
      },
    },
  );

/** Spies, calling through, on the store's owner-view reconcile methods. */
function sr6bSpy(store: AuthoritativeStore): Sr6bSpies {
  const target = store as unknown as Record<Sr6bMethod, (...args: unknown[]) => void>;
  const spies: Partial<Sr6bSpies> = {};
  for (const view of SR6B_VIEWS) spies[view] = vi.spyOn(target, SR6B_METHOD[view]);
  return spies as Sr6bSpies;
}

/** The owner views whose store reconcile ran since the last clear, in call order. */
function sr6bReconciled(spies: Sr6bSpies): OwnerView[] {
  const calls = SR6B_VIEWS.flatMap((view) =>
    spies[view].mock.invocationCallOrder.map((at) => ({ at, view })),
  );
  return calls.sort((a, b) => a.at - b.at).map(({ view }) => view);
}

/** How many times each owner view's SDK cache was read since the last clear (unread: omitted). */
function sr6bReads(): Record<string, number> {
  const read = SR6B_VIEWS.filter((view) => (H.iterCalls[view] ?? 0) > 0);
  return Object.fromEntries(read.map((view) => [view, H.iterCalls[view]]));
}

/** Since the last clear: exactly `views` were reconciled, once each and in this order, and theirs
 *  are the only owner-view caches read, once each. */
function sr6bExpect(spies: Sr6bSpies, views: readonly OwnerView[], when: string): void {
  expect(sr6bReconciled(spies), `${when}: the reconciles that ran, in order`).toEqual(views);
  expect(sr6bReads(), `${when}: the view caches read`).toEqual(
    Object.fromEntries(views.map((view) => [view, 1])),
  );
}

function sr6bClear(spies: Sr6bSpies): void {
  for (const view of SR6B_VIEWS) spies[view].mockClear();
  H.iterCalls = {};
}

/** One burst of a single `character` insert (a row of no owner view) on build `buildIdx`, and its
 *  flush. */
async function sr6bCharacterBurst(buildIdx = 0): Promise<void> {
  wsFire('character', 'insert', [wsChar(900n, 0)], buildIdx);
  await settle();
}

/** Every view is clean: a burst of character rows only reconciles nothing and reads no view. */
async function sr6bExpectDrained(spies: Sr6bSpies, buildIdx = 0): Promise<void> {
  sr6bClear(spies);
  await sr6bCharacterBurst(buildIdx);
  sr6bExpect(spies, [], 'drained (a burst of character rows only)');
  sr6bClear(spies);
}

/** Run build `buildIdx`'s `event` handler of the owner view `view` once, as the SDK would. */
function sr6bFire(view: OwnerView, event: 'insert' | 'delete', buildIdx = 0): void {
  const cb = H.rowEvents[view]?.[event][buildIdx];
  if (cb === undefined) throw new Error(`no ${view}.${event} handler for build ${buildIdx}`);
  cb({}, {});
}

/** What `call` threw (a sentinel string when it returned). */
function sr6bThrown(call: () => void): unknown {
  try {
    call();
  } catch (err) {
    return err;
  }
  return 'returned without a throw';
}

/** Connect, open build 0, apply its snapshot unless `applied` is false, and land one burst (it
 *  reconciles every view of the new connection from `H.viewRows`); then spy on the store's
 *  reconcile methods. */
async function sr6bConnected(opts: ConnectionOptions = makeOpts(), applied = true) {
  const handle = connect(opts);
  await settle();
  const b0 = npBuild(0);
  b0.onConnect?.(conn0(b0), ID, 'anon-tok');
  if (applied) b0.onApplied?.();
  await sr6bCharacterBurst();
  return { handle, b0, spies: sr6bSpy(opts.store) };
}

describe('connect(): owner views reconcile only when dirty (sr-6b)', { sequential: true }, () => {
  beforeEach(() => {
    // The world scope's tick is a setInterval and its apply timeout is measured on
    // performance.now(): both are faked so advancing the timers drives the scope's drop path.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    H.builds = [];
    H.renew = null;
    H.renewCalls = 0;
    H.startGuestClaimImpl = null;
    H.viewRows = {};
    H.rowCbs = {};
    H.rowEvents = {};
    H.iterCalls = {};
    H.builderThrows = false;
    H.beginSignIn = vi.fn(() => Promise.resolve({ kind: 'transient-error' }));
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
  });

  it('a burst of only character and player rows flushes one batch that carries them, runs no owner-view reconcile and reads no view cache [SR6B.1]', async () => {
    // WRONG IMPL KILLED: every view reconciled on every batch (each movement step pays for every
    // owned row); a clean view's cache read or converted with only the store call skipped; a batch
    // with no dirty view that skips the flush too (the step never reaches a listener).
    const opts = makeOpts();
    H.viewRows.my_inventory = [sr6bInventory(1n, 3)];
    H.viewRows.myBattle = [bt12SdkBattle(47n)];
    const { spies } = await sr6bConnected(opts);
    const leaver = wsPlayer(6n, { toHexString: () => 'ab'.repeat(32) });
    wsFire('player', 'insert', [leaver]);
    await sr6bExpectDrained(spies);

    const flushed = vi.fn();
    opts.store.onBatchApplied(flushed);
    const mover = wsChar(901n, 0, 2, 2);
    const other = wsPlayer(7n, sr6bOther);
    wsFire('character', 'insert', [mover]);
    wsFire('character', 'update', [mover, wsChar(901n, 0, 3, 2)]);
    wsFire('player', 'insert', [other]);
    wsFire('player', 'update', [other, { ...other, leadLevel: 9 }]);
    wsFire('player', 'delete', [leaver]);
    await settle();
    expect(flushed, 'one burst, one flushed batch').toHaveBeenCalledTimes(1);
    expect(opts.store.character(901n)?.row.tileX, 'the step is in the store').toBe(3);
    expect(opts.store.player(sr6bOther.toHexString())?.leadLevel, 'the updated player').toBe(9);
    expect(opts.store.player('ab'.repeat(32)), 'the deleted player is gone').toBeUndefined();
    sr6bExpect(spies, [], 'a burst of character and player rows');
    expect(opts.store.ownInventory(BT12_ME), 'the owner views keep their rows').toEqual([
      sr6bStoredInventory(1n, 3),
    ]);
    expect(opts.store.ongoingBattle(BT12_ME)?.battleId).toBe(47n);
  });

  it.each(
    SR6B_HANDLERS,
  )('the %s %s handler marks that view alone: the next batch reconciles it and no other view, and then it is clean [SR6B.2]', async (view, event) => {
    // WRONG IMPL KILLED: a handler that marks another view (myBattleUnits marking myBattleQueue:
    // the units view stays stale); a view handler that marks every view; a handler that schedules
    // without marking (a deleted row stays in the store) or marks without scheduling (nothing
    // flushes); an onUpdate wired on a view.
    const { spies } = await sr6bConnected();
    expect(H.rowEvents[view]?.update ?? [], `${view}: no onUpdate on a view`).toEqual([]);
    await sr6bExpectDrained(spies);
    sr6bFire(view, event);
    await settle();
    sr6bExpect(spies, [view], `after one ${view} ${event}`);
    await sr6bExpectDrained(spies);
  });

  it('a burst of a character row and a view row is one batch: the view is rebuilt first, then the hydration edge fires once, then the batch listener runs once and already reads the rebuilt view [SR6B.2]', async () => {
    // WRONG IMPL KILLED: the reconcile moved after flushBatch with a second flush (the listener
    // runs twice, first on the stale view); onHydrated fired before the reconcile (the hydrated
    // screen reads the pre-snapshot view); onHydrated fired after the flush (the listener runs on
    // a store not yet announced as hydrated).
    const opts = makeOpts();
    H.viewRows.my_inventory = [sr6bInventory(1n, 3)];
    const { b0, spies } = await sr6bConnected(opts, false);
    await sr6bExpectDrained(spies);
    expect(
      opts.onHydrated,
      'precondition: no snapshot yet, so no hydration edge',
    ).not.toHaveBeenCalled();
    const seen: unknown[] = [];
    const listener = vi.fn(() => {
      seen.push(opts.store.ownInventory(BT12_ME));
    });
    opts.store.onBatchApplied(listener);
    // The snapshot arms the hydration edge; then one burst of a character row and a view row.
    b0.onApplied?.();
    H.viewRows.my_inventory = [sr6bInventory(1n, 4)];
    wsFire('character', 'insert', [wsChar(903n, 0)]);
    sr6bFire('my_inventory', 'insert');
    await settle();
    expect(listener, 'one burst, one batch').toHaveBeenCalledTimes(1);
    expect(seen, 'inside the listener the view is already rebuilt').toEqual([
      [sr6bStoredInventory(1n, 4)],
    ]);
    expect(opts.onHydrated, 'the hydration edge fires once').toHaveBeenCalledTimes(1);
    const reconciledAt = spies.my_inventory.mock.invocationCallOrder[0];
    const hydratedAt = vi.mocked(opts.onHydrated).mock.invocationCallOrder[0];
    const listenedAt = listener.mock.invocationCallOrder[0];
    expect(reconciledAt, 'the view is rebuilt before the hydration edge').toBeLessThan(hydratedAt);
    expect(hydratedAt, 'the hydration edge fires before the listener').toBeLessThan(listenedAt);
  });

  it('an applied snapshot marks every view: the next batch, of character rows only, reconciles each one, and the store takes the rows the snapshot left in the cache [SR6B.3]', async () => {
    // WRONG IMPL KILLED: no mark in the base subscription's onApplied (a view the snapshot changed
    // with no row callback for it keeps its old rows until it next changes).
    const opts = makeOpts();
    H.viewRows.my_inventory = [sr6bInventory(1n, 3)];
    const { b0, spies } = await sr6bConnected(opts, false);
    await sr6bExpectDrained(spies);
    H.viewRows.my_inventory = [sr6bInventory(1n, 2), sr6bInventory(2n, 1)];
    b0.onApplied?.();
    await sr6bCharacterBurst();
    sr6bExpect(spies, OWNER_VIEWS, 'the first batch after the snapshot');
    expect(opts.store.ownInventory(BT12_ME)).toEqual([
      sr6bStoredInventory(1n, 2),
      sr6bStoredInventory(2n, 1),
    ]);
    await sr6bExpectDrained(spies);
  });

  it.each(
    (['reconnectNow', 'continueAnonymously'] as const).map((how) => [how] as const),
  )('a connection rebuilt by %s marks every view: the first batch on it, of character rows only, reconciles each one from the new cache [SR6B.3]', async (how) => {
    // WRONG IMPL KILLED: no mark when build() builds a connection (this rebuild resets nothing and
    // applies no snapshot, so every view keeps the old connection's rows until it next changes);
    // a reconcile that keeps reading the first connection's cache (the old rows land instead).
    const opts = makeOpts();
    H.viewRows.my_inventory = [sr6bInventory(1n, 3)];
    H.viewRows.myFormation = [bt12Formation([37n])];
    H.viewRows.myTradeSession = [ts3Row(9n)];
    const { handle, spies } = await sr6bConnected(opts);
    await sr6bExpectDrained(spies);
    // The first connection's cache moves on too, with no row callback: only the new
    // connection's rows may land.
    H.viewRows.my_inventory = [sr6bInventory(1n, 7)];
    H.viewRows.myFormation = [bt12Formation([43n])];
    H.viewRows.myTradeSession = [ts3Row(5n)];
    handle[how]();
    await settle();
    expect(H.builds, 'the rebuild built a second connection').toHaveLength(2);
    const b1 = npBuild(1);
    b1.viewRows = {
      my_inventory: [sr6bInventory(1n, 2)],
      myFormation: [bt12Formation([41n])],
      myTradeSession: [ts3Row(4n)],
    };
    b1.onConnect?.(conn0(b1), ID, 'anon-tok');
    await sr6bCharacterBurst(1);
    sr6bExpect(spies, OWNER_VIEWS, `the first batch on the connection ${how} built`);
    expect(opts.store.ownInventory(BT12_ME), 'the new connection`s inventory').toEqual([
      sr6bStoredInventory(1n, 2),
    ]);
    expect(opts.store.ownFormation(BT12_ME)?.monsterIds, 'its formation').toEqual([41n]);
    expect(
      opts.store.allTradeSessions().map((s) => s.sessionId),
      'its trade session',
    ).toEqual([4n]);
    await sr6bExpectDrained(spies, 1);
  });

  it('a dropped connection resets the store and marks every view: the next batch, of character rows only, reconciles each one [SR6B.3]', async () => {
    // WRONG IMPL KILLED: no mark beside store.reset() on the drop path (the reset store holds no
    // owner-view rows, and nothing rebuilds them until each view next changes). The rows that
    // batch reads are not asserted: before the rebuild it reads the dropped connection's cache, a
    // known residual and not behaviour to pin.
    const { b0, spies } = await sr6bConnected();
    await sr6bExpectDrained(spies);
    b0.onDisconnect?.();
    expect(H.builds, 'no rebuild yet: its timer has not run').toHaveLength(1);
    await sr6bCharacterBurst();
    sr6bExpect(spies, OWNER_VIEWS, 'the first batch after the drop');
  });

  it('a world scope that takes its drop path resets the store and marks every view with no onDisconnect: the next batch, of character rows only, reconciles each one [SR6B.3]', async () => {
    // WRONG IMPL KILLED: the reset-site mark placed in the onDisconnect callback instead of
    // handleDrop() (the scope's drop path, like a pageshow restore, resets the store through
    // handleDrop() with no onDisconnect, so every view would stay empty until it next changed). As
    // on the onDisconnect path, the rows that batch reads are not asserted.
    const { b0, spies } = await sr6bConnected();
    // The login sequence: the own player row, its own-row set applied, then the own character
    // row, whose zone set is issued and never applies.
    wsFire('player', 'insert', [wsPlayer()]);
    wsApply(wsSubs(b0)[0]);
    wsFire('character', 'insert', [wsChar(WS_E, 0)]);
    expect(wsQueries(b0), 'precondition: the own zone set is pending').toEqual([
      WS_OWN_QUERY,
      wsZoneQuery(0),
    ]);
    await sr6bExpectDrained(spies);
    expect(b0.disconnect, 'precondition: no drop yet').not.toHaveBeenCalled();

    // The tick APPLY_TIMEOUT_MS after the zone set was issued takes the drop path; the rebuild it
    // schedules is a backoff later, beyond this advance.
    await vi.advanceTimersByTimeAsync(APPLY_TIMEOUT_MS);
    expect(
      b0.disconnect,
      'the scope took its drop path and closed the socket',
    ).toHaveBeenCalledTimes(1);
    expect(H.builds, 'no rebuild yet: its timer has not run').toHaveLength(1);
    await sr6bCharacterBurst();
    sr6bExpect(spies, OWNER_VIEWS, 'the first batch after the scope`s drop');
  });

  it('each connect() has its own reconciler: a view marked on one connection is reconciled by that connection`s next batch and never by another connection`s [SR6B.3]', async () => {
    // WRONG IMPL KILLED: one reconciler for the module (the second connection's batch, queued first
    // in the turn, takes the first connection's mark: the first store never gets the new row, and
    // the second rebuilds a view that never changed for it). A rebuild marks every view, so only
    // two live connections tell the two apart.
    H.viewRows.my_inventory = [sr6bInventory(1n, 3)];
    const first = makeOpts();
    const second = makeOpts();
    connect(first);
    await settle();
    connect(second);
    await settle();
    expect(H.builds, 'one build per connect()').toHaveLength(2);
    const b0 = npBuild(0);
    const b1 = npBuild(1);
    b0.onConnect?.(conn0(b0), ID, 'anon-tok');
    b1.onConnect?.(conn0(b1), ID, 'anon-tok');
    await sr6bCharacterBurst(0);
    await sr6bCharacterBurst(1);
    const firstSpies = sr6bSpy(first.store);
    const secondSpies = sr6bSpy(second.store);
    H.iterCalls = {};
    await sr6bCharacterBurst(0);
    await sr6bCharacterBurst(1);
    sr6bExpect(firstSpies, [], 'the first connection, drained');
    sr6bExpect(secondSpies, [], 'the second connection, drained');

    // One turn: the second connection's batch is queued first, then the first connection's
    // inventory changes and its batch is queued.
    H.viewRows.my_inventory = [sr6bInventory(1n, 2)];
    wsFire('character', 'insert', [wsChar(902n, 0)], 1);
    sr6bFire('my_inventory', 'insert', 0);
    await settle();
    expect(sr6bReconciled(secondSpies), 'the second connection marked nothing').toEqual([]);
    expect(sr6bReconciled(firstSpies), 'the first connection reconciles its own mark').toEqual([
      'my_inventory',
    ]);
    expect(sr6bReads(), 'one cache read, by the first connection').toEqual({ my_inventory: 1 });
    expect(first.store.ownInventory(BT12_ME)).toEqual([sr6bStoredInventory(1n, 2)]);
    expect(second.store.ownInventory(BT12_ME)).toEqual([sr6bStoredInventory(1n, 3)]);
  });

  it('a view whose converter throws stays dirty: its batch still flushes once with the other groups landed and the throw logged, and the next batch, of character rows only, lands it from the fixed cache [SR6B.4]', async () => {
    // WRONG IMPL KILLED: the throwing view cleared with the rest (the battle never lands until it
    // next changes); the later view of its group that never ran cleared too (the export chunk
    // never lands); the retry left to a batch the batcher queues for itself (a second flush in
    // the same turn); the throw escaping the batcher (no batch at all).
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const opts = makeOpts();
      const { spies } = await sr6bConnected(opts);
      await sr6bExpectDrained(spies);
      errors.mockClear();
      const thrown = new Error('malformed my_battle row');
      H.viewRows.myBattle = [sr6bMalformed(thrown), bt12SdkBattle(47n)];
      H.viewRows.my_export_bundle = [sr6bChunk(1n)];
      H.viewRows.my_inventory = [sr6bInventory(43n, 3)];
      H.viewRows.myFormation = [bt12Formation([37n])];
      const seen: Record<string, unknown>[] = [];
      opts.store.onBatchApplied(() => {
        seen.push({
          battle: opts.store.ongoingBattle(BT12_ME)?.battleId,
          chunks: opts.store.ownExportChunks(BT12_ME).map((c) => c.chunkId),
          inventory: opts.store.ownInventory(BT12_ME).map((i) => i.invId),
          formation: opts.store.ownFormation(BT12_ME)?.monsterIds,
        });
        // The cache is fixed as the throwing batch is delivered, with no row callback: only a
        // later batch may land it.
        H.viewRows.myBattle = [bt12SdkBattle(47n)];
      });
      for (const view of ['myBattle', 'my_export_bundle', 'my_inventory', 'myFormation'] as const) {
        sr6bFire(view, 'insert');
      }
      await settle();
      expect(seen, 'the throwing batch is delivered once, with the other groups landed').toEqual([
        { battle: undefined, chunks: [], inventory: [43n], formation: [37n] },
      ]);
      expect(sr6bReconciled(spies), 'the reconciles that returned').toEqual([
        'my_inventory',
        'myFormation',
      ]);
      expect(errors.mock.calls, 'the throw is logged once, as thrown').toEqual([
        ['[net] view reconcile threw; flushing anyway', thrown],
      ]);

      sr6bClear(spies);
      await sr6bCharacterBurst();
      expect(
        sr6bReconciled(spies),
        'the view that threw and the later view of its group that did not run',
      ).toEqual(['myBattle', 'my_export_bundle']);
      expect(opts.store.ongoingBattle(BT12_ME)?.battleId, 'the battle lands').toBe(47n);
      expect(
        opts.store.ownExportChunks(BT12_ME).map((c) => c.chunkId),
        'the export chunk lands',
      ).toEqual([1n]);
      await sr6bExpectDrained(spies);
      expect(errors, 'nothing more is logged').toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  it('a character row handler that throws marks every owner view and schedules the flush before the same error goes on to the SDK: that flush reconciles every view, so view rows whose own callbacks the SDK then skips still land [SR6B.3]', async () => {
    // WRONG IMPL KILLED: no recovery around a non-view handler (the SDK stops dispatching that
    // message, whose view rows are already in its cache: their callbacks never run, and the views
    // stay stale and clean); a recovery that swallows the error or throws another; a mark with no
    // schedule (nothing flushes until some later row arrives).
    const opts = makeOpts();
    H.viewRows.my_inventory = [sr6bInventory(1n, 3)];
    const { spies } = await sr6bConnected(opts);
    await sr6bExpectDrained(spies);
    const flushed = vi.fn();
    opts.store.onBatchApplied(flushed);
    // The rest of the message: rows already in the SDK cache whose callbacks never run.
    H.viewRows.my_inventory = [sr6bInventory(1n, 2)];
    H.viewRows.myBattle = [bt12SdkBattle(47n)];
    const thrown = new Error('malformed character row');
    expect(
      sr6bThrown(() => wsFire('character', 'insert', [sr6bMalformed(thrown)])),
      'the handler`s own error goes on to the SDK',
    ).toBe(thrown);
    await settle();
    expect(flushed, 'one flushed batch').toHaveBeenCalledTimes(1);
    sr6bExpect(spies, OWNER_VIEWS, 'the flush the throwing handler scheduled');
    expect(opts.store.ownInventory(BT12_ME)).toEqual([sr6bStoredInventory(1n, 2)]);
    expect(opts.store.ongoingBattle(BT12_ME)?.battleId).toBe(47n);
  });

  it('a player row handler that throws marks every owner view and schedules the flush before the same error goes on to the SDK [SR6B.3]', async () => {
    // WRONG IMPL KILLED: the recovery around the character handlers only, or around inserts only.
    const opts = makeOpts();
    const { spies } = await sr6bConnected(opts);
    const before = wsPlayer(8n, sr6bOther);
    wsFire('player', 'insert', [before]);
    await sr6bExpectDrained(spies);
    H.viewRows.myFormation = [bt12Formation([37n])];
    H.viewRows.myTradeSession = [ts3Row(9n)];
    const thrown = new Error('malformed player identity');
    const broken = {
      ...before,
      identity: {
        toHexString: () => {
          throw thrown;
        },
      },
    };
    expect(
      sr6bThrown(() => wsFire('player', 'update', [before, broken])),
      'the handler`s own error goes on to the SDK',
    ).toBe(thrown);
    await settle();
    sr6bExpect(spies, OWNER_VIEWS, 'the flush the throwing handler scheduled');
    expect(opts.store.ownFormation(BT12_ME)?.monsterIds).toEqual([37n]);
    expect(opts.store.allTradeSessions().map((s) => s.sessionId)).toEqual([9n]);
  });

  it('every row handler connect() wires on a table that is not an owner view, whatever value it throws, marks every owner view and schedules the flush before that same value goes on to the SDK [SR6B.3]', async () => {
    // WRONG IMPL KILLED: any one non-view handler left without the recovery (my_wallet's insert,
    // my_account's update, my_conversation's delete, character's delete: the views of the message
    // the SDK stops dispatching stay stale and clean); a recovery that marks only on an Error, so a
    // thrown string or object goes on unmarked.
    const opts = makeOpts();
    const { spies } = await sr6bConnected(opts);
    // What connect() registered on the tables that are not owner views.
    const handlers = Object.entries(H.rowEvents)
      .filter(([table]) => !SR6B_VIEW_TABLES.has(table))
      .flatMap(([table, events]) =>
        (['insert', 'update', 'delete'] as const).flatMap((event) =>
          events[event].map((handler) => ({ table, event, handler })),
        ),
      );
    expect(handlers.length, 'connect() wires non-view row handlers').toBeGreaterThan(0);
    const tables = new Set(handlers.map(({ table }) => table));
    for (const table of ['character', 'player', 'my_wallet', 'my_account', 'my_conversation']) {
      expect(tables.has(table), `a handler on ${table}`).toBe(true);
    }
    // An Error, a string and a plain object, in turn.
    const throwables = [
      (at: string): unknown => new Error(`${at} threw`),
      (at: string): unknown => `${at} threw`,
      (at: string): unknown => ({ at }),
    ];
    for (const [i, { table, event, handler }] of handlers.entries()) {
      const at = `${table}.${event}`;
      await sr6bExpectDrained(spies);
      // The rest of the message: a view row already in the SDK cache whose callback never runs.
      H.viewRows.my_inventory = [sr6bInventory(1n, 10 + i)];
      const thrown = throwables[i % throwables.length](at);
      const row = sr6bMalformed(thrown);
      const args = event === 'update' ? [row, row] : [row];
      expect(
        sr6bThrown(() => handler({}, ...args)),
        `${at}: the value it threw goes on to the SDK`,
      ).toBe(thrown);
      await settle();
      sr6bExpect(spies, OWNER_VIEWS, `the flush the ${at} throw scheduled`);
      expect(opts.store.ownInventory(BT12_ME), `${at}: the view row landed`).toEqual([
        sr6bStoredInventory(1n, 10 + i),
      ]);
    }
  });

  it.each(
    SR6B_APPLIED_THROWERS,
  )('an applied snapshot marks every owner view before anything in it can throw: a throw from %s escapes onApplied and the next batch still reconciles every view [SR6B.3]', async (thrower) => {
    // WRONG IMPL KILLED: the snapshot's mark placed after a call onApplied makes that can throw
    // (claimCode.hasUnconsumed is the earliest after the stale check, onScopeSettled is near the
    // end): the throw skips the mark, and the rows the snapshot left in the cache never land.
    const onScopeSettled = vi.fn<(settled: boolean) => void>();
    const opts: ConnectionOptions = { ...makeOpts(), onScopeSettled };
    H.viewRows.my_inventory = [sr6bInventory(1n, 3)];
    const { b0, spies } = await sr6bConnected(opts, false);
    await sr6bExpectDrained(spies);
    expect(onScopeSettled, 'precondition: no scope before the snapshot').not.toHaveBeenCalled();
    const thrown = new Error(`${thrower} threw`);
    const hasUnconsumed = vi.spyOn(claimCode, 'hasUnconsumed');
    try {
      const fail = (): never => {
        throw thrown;
      };
      if (thrower === 'claimCode.hasUnconsumed') hasUnconsumed.mockImplementationOnce(fail);
      else onScopeSettled.mockImplementation(fail);
      H.viewRows.my_inventory = [sr6bInventory(1n, 2)];
      expect(
        sr6bThrown(() => b0.onApplied?.()),
        `the ${thrower} throw escapes onApplied`,
      ).toBe(thrown);
      expect(hasUnconsumed, 'onApplied reached the claim-code check once').toHaveBeenCalledTimes(1);
      expect(
        onScopeSettled.mock.calls.length,
        'the scope listener is reached only when the claim-code check returns',
      ).toBe(thrower === 'claimCode.hasUnconsumed' ? 0 : 1);
      await sr6bCharacterBurst();
      sr6bExpect(spies, OWNER_VIEWS, 'the first batch after the snapshot');
      expect(opts.store.ownInventory(BT12_ME)).toEqual([sr6bStoredInventory(1n, 2)]);
    } finally {
      hasUnconsumed.mockRestore();
    }
  });
});

/** The connection object handed to onConnect: only subscriptionBuilder is read there. */
function conn0(rec: BuildRec) {
  // A fresh builder per call, as the SDK gives: every subscribe is its own handle with its own
  // callbacks. The first is the base set (`rec.onApplied`, `rec.queries`); the rest are the world
  // scope's. `unsubscribe` throws on a second call, as the SDK's does.
  const subscriptionBuilder = () => {
    const sub: SubRec = { query: undefined, active: false, unsubscribes: 0 };
    const first = rec.subs.length === 0;
    rec.subs.push(sub);
    const builder = {
      onApplied: (cb: Cb) => {
        sub.onApplied = cb;
        if (first) rec.onApplied = cb;
        return builder;
      },
      onError: (cb: Cb) => {
        sub.onError = cb;
        return builder;
      },
      subscribe: (queries: readonly string[] | string) => {
        sub.query = queries;
        if (first) rec.queries = queries as readonly string[];
        return {
          isActive: () => sub.active,
          unsubscribe: () => {
            sub.unsubscribes += 1;
            if (sub.unsubscribes > 1) throw new Error('Unsubscribe has already been called');
            sub.active = false;
          },
        };
      },
    };
    return builder;
  };
  return {
    subscriptionBuilder,
    disconnect: rec.disconnect,
    reducers: {
      joinGame: rec.joinGame,
      completeGuestClaim: rec.completeGuestClaim,
      startGuestClaim: rec.startGuestClaim,
    },
  };
}
