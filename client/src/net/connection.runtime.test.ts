// @vitest-environment happy-dom
/**
 * connection.runtime.test.ts: drives the REAL connect() through each credential decision with
 * the SDK's DbConnection builder and the OIDC client mocked, and asserts what actually reaches
 * the builder (withToken), what is persisted, and how the retry ladder behaves.
 *
 * Replaces the connection.ts text pins (ledger CT-src-net-connection#credential-wiring).
 * credentialDecision.ts's pure logic has its own tests; this file covers its WIRING in connect().
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { writeAuthKind } from './authToken';
import { claimCode } from './claimCode';
import { type ConnectionOptions, connect } from './connection';
import type { RenewalOutcome } from './credentialDecision';
import { AuthoritativeStore } from './store';

type Cb = (...args: unknown[]) => void;
interface BuildRec {
  token: unknown;
  onConnect?: Cb;
  onConnectError?: Cb;
  onDisconnect?: Cb;
  onApplied?: Cb;
  readonly joinGame: ReturnType<typeof vi.fn>;
  readonly completeGuestClaim: ReturnType<typeof vi.fn>;
  readonly startGuestClaim: ReturnType<typeof vi.fn>;
  /** The query strings handed to the applied-snapshot subscription (conn0's builder). */
  queries?: readonly string[];
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
}));

vi.mock('../module_bindings', () => {
  const eventOf = new Map<string | symbol, 'insert' | 'update' | 'delete'>([
    ['onInsert', 'insert'],
    ['onUpdate', 'update'],
    ['onDelete', 'delete'],
  ]);
  const tableFor = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, k) => {
          if (k === 'iter') return () => (H.viewRows[name] ?? [])[Symbol.iterator]();
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
          db: new Proxy({}, { get: (_t, name) => tableFor(String(name)) }),
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
          build: () => conn,
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
  it('the one subscription batch includes the public zone_def table exactly once and adds no other query, 30 in all since bt-12 [QF15-1-SUBSCRIBE-ZONE-DEF]', async () => {
    // WRONG IMPL KILLED: no subscription (the client never receives a zone name and the cue stays
    // silent forever); a second subscription call or a duplicate entry (the length pin); a query
    // for a table nobody named riding along (the length pin: 22 queries before qf-15, plus this
    // one); the table spelled differently (`zoneDef`, `zone_defs`).
    // bt-12 (named intentional change, BT12.1): 23 → 30, the seven tactical views
    // (BT12-1-SUBSCRIBE-SEVEN pins which seven).
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
      'the 22 queries that were there, plus zone_def, plus (bt-12) the seven tactical views',
    ).toHaveLength(30);
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
    H.beginSignIn = vi.fn(() => Promise.resolve({ kind: 'transient-error' }));
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
  });

  it('the one subscription batch names each of the seven owner-scoped tactical views exactly once and no private battle table, 30 queries in all [BT12-1-SUBSCRIBE-SEVEN]', async () => {
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
    expect(queries, 'the 23 that were there, plus the seven').toHaveLength(30);
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

/** The connection object handed to onConnect: only subscriptionBuilder is read there. */
function conn0(rec: BuildRec) {
  const sub = {
    onApplied: (cb: Cb) => {
      rec.onApplied = cb;
      return sub;
    },
    onError: () => sub,
    subscribe: (queries: readonly string[]) => {
      rec.queries = queries;
      return sub;
    },
  };
  return {
    subscriptionBuilder: () => sub,
    reducers: {
      joinGame: rec.joinGame,
      completeGuestClaim: rec.completeGuestClaim,
      startGuestClaim: rec.startGuestClaim,
    },
  };
}
