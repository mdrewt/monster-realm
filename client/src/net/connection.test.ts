// @vitest-environment happy-dom
/**
 * connection.test.ts (R-rb-128-E1): re-join after cancel_account_deletion, and a claim-flow join
 * that surfaces its failures.
 *
 * WHEN my_account returns to Active after cancel_account_deletion THE CLIENT SHALL re-issue
 * joinGame, and the claim-flow join SHALL surface failures instead of swallowing them.
 *
 * Four surfaces, each driven through its own door:
 *   E1-DECIDE   the pure decision `shouldRejoinAfterAccountChange` (truth table).
 *   E1-REJOIN   the REAL connect() with the SDK builder mocked: my_account rows delivered through
 *               the captured onInsert callbacks (a view delivers an update as an insert).
 *   E1-JOIN     `Connection.join()`: the one surfaced-failure join the claim flow calls.
 *   E1-MAIN     main.ts (comment-stripped source): applyClaim's join effect goes through
 *               `conn?.join()` and no direct joinGame call remains.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { writeAuthKind } from './authToken';
import { claimCode } from './claimCode';
import { type ConnectionOptions, connect, shouldRejoinAfterAccountChange } from './connection';
import type { RenewalOutcome } from './credentialDecision';
import { AuthoritativeStore } from './store';

type Cb = (...args: unknown[]) => void;
/** One `subscriptionBuilder().subscribe(...)` call on the connection handed to onConnect. */
interface SubRec {
  /** The base set's string list, one world-scope query string, or the protocol gate's string. */
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
  /** Every subscribe call, in order: the base set first. The protocol gate is not among them. */
  readonly subs: SubRec[];
  readonly disconnect: ReturnType<typeof vi.fn>;
  /** The query strings handed to the applied-snapshot subscription (conn0's builder). */
  queries?: readonly string[];
  /**
   * The `module_info` subscribes (the protocol gate), recorded apart from `subs`. The harness
   * applies each, over this build's `moduleInfo` cache, as soon as the onConnect that opened it
   * returns (the real SDK's answer arrives a round trip later).
   */
  readonly gate: SubRec[];
  /** This build's `module_info` cache (default: one row that admits protocol 1). */
  readonly moduleInfo: ModuleInfoFake;
}
interface ModuleInfoRow {
  id: number;
  protocol: number;
  minClientProtocol: number;
}
/** The SDK's `db.moduleInfo` of one build: its cached rows and the row handlers registered on it. */
interface ModuleInfoFake {
  rows: ModuleInfoRow[];
  readonly insert: Cb[];
  readonly update: Cb[];
  readonly delete: Cb[];
  readonly table: Record<string, (...args: unknown[]) => unknown>;
}

/** The one query the protocol gate subscribes. */
const MODULE_INFO_QUERY = 'SELECT * FROM module_info';

const H = vi.hoisted(() => ({
  builds: [] as BuildRec[],
  renew: null as null | (() => Promise<RenewalOutcome>),
  /** Per-table registered row callbacks, one entry per build (wireTables runs once per build). */
  rowCbs: {} as Record<string, Cb[]>,
  /** Per-table registered onUpdate callbacks, one entry per build; called as (ctx, old, new). */
  updCbs: {} as Record<string, Cb[]>,
  /** What the OIDC client's beginSignIn answers; null: a transient error. */
  begin: null as null | (() => Promise<{ kind: string; authorizationUrl?: string }>),
}));

vi.mock('../module_bindings', () => {
  const tableFor = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, k) => {
          if (k === 'iter') return () => [][Symbol.iterator]();
          return (cb: Cb) => {
            if (k === 'onInsert' || k === 'onDelete') {
              H.rowCbs[name] = [...(H.rowCbs[name] ?? []), cb];
            }
            if (k === 'onUpdate') {
              H.updCbs[name] = [...(H.updCbs[name] ?? []), cb];
            }
          };
        },
      },
    );
  return {
    DbConnection: {
      builder: () => {
        // The build's `module_info` cache, one admitting row by default; the same table
        // whichever connection object (the built one, or the one handed to onConnect) reads it.
        const mi: ModuleInfoFake = {
          rows: [{ id: 0, protocol: 1, minClientProtocol: 1 }],
          insert: [],
          update: [],
          delete: [],
          table: {},
        };
        Object.assign(mi.table, {
          iter: () => mi.rows[Symbol.iterator](),
          count: () => mi.rows.length,
          onInsert: (cb: Cb) => {
            mi.insert.push(cb);
          },
          onUpdate: (cb: Cb) => {
            mi.update.push(cb);
          },
          onDelete: (cb: Cb) => {
            mi.delete.push(cb);
          },
          removeOnInsert: () => undefined,
          removeOnUpdate: () => undefined,
          removeOnDelete: () => undefined,
        });
        const rec: BuildRec = {
          token: 'UNSET',
          joinGame: vi.fn(() => Promise.resolve()),
          completeGuestClaim: vi.fn(() => Promise.resolve()),
          startGuestClaim: vi.fn(() => Promise.resolve()),
          subs: [],
          disconnect: vi.fn(),
          gate: [],
          moduleInfo: mi,
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
        const isModuleInfo = (name: string): boolean =>
          name === 'moduleInfo' || name === 'module_info';
        const conn = {
          db: new Proxy(
            {},
            {
              get: (_t, name) => (isModuleInfo(String(name)) ? mi.table : tableFor(String(name))),
            },
          ),
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
          // The harness applies every `module_info` set this onConnect opened, over the cache, as
          // soon as it returns (the real SDK's answer arrives a round trip later), so a test's
          // onConnect-then-applied sequence drives an admitted build.
          onConnect: (cb: Cb) => {
            rec.onConnect = (...args: unknown[]) => {
              const before = rec.gate.length;
              cb(...args);
              for (const gate of rec.gate.slice(before)) {
                gate.active = true;
                gate.onApplied?.({});
              }
            };
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
    beginSignIn: () =>
      H.begin === null ? Promise.resolve({ kind: 'transient-error' }) : H.begin(),
    renewOrExchange: () => {
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
    // The OIDC mode: the account builds the bootAccount cases drive are reachable only in it.
    signIn: 'oidc',
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
    // The protocol this client speaks; every build's default module_info row admits it.
    clientProtocol: 1,
    onProtocolMismatch: vi.fn(),
  } as unknown as ConnectionOptions & Record<string, ReturnType<typeof vi.fn>>;
}

const settle = () => vi.advanceTimersByTimeAsync(0);
/** Let every scheduled reconnect fire (backoff is bounded well under a minute). */
const nextAttempt = () => vi.advanceTimersByTimeAsync(60_000);

/** The connection object handed to onConnect: its subscriptionBuilder, reducers, and the
 *  `module_info` table the protocol gate reads. */
function conn0(rec: BuildRec) {
  // A fresh builder per call, as the SDK gives: every subscribe is its own handle with its own
  // callbacks. The protocol gate's `module_info` subscribe goes to `rec.gate`; of the others, the
  // first is the base set (`rec.onApplied`, `rec.queries`) and the rest are the world scope's.
  // Which list a subscribe joins is decided when it is issued. `unsubscribe` throws on a second
  // call, as the SDK's does.
  const subscriptionBuilder = () => {
    const sub: SubRec = { query: undefined, active: false, unsubscribes: 0 };
    const builder = {
      onApplied: (cb: Cb) => {
        sub.onApplied = cb;
        return builder;
      },
      onError: (cb: Cb) => {
        sub.onError = cb;
        return builder;
      },
      subscribe: (queries: readonly string[] | string) => {
        sub.query = queries;
        if (queries === MODULE_INFO_QUERY) {
          rec.gate.push(sub);
        } else {
          const first = rec.subs.length === 0;
          rec.subs.push(sub);
          if (first) {
            rec.onApplied = sub.onApplied;
            rec.queries = queries as readonly string[];
          }
        }
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
    db: { moduleInfo: rec.moduleInfo.table, module_info: rec.moduleInfo.table },
    reducers: {
      joinGame: rec.joinGame,
      completeGuestClaim: rec.completeGuestClaim,
      startGuestClaim: rec.startGuestClaim,
    },
  };
}

/** A `my_account` view row as the SDK delivers it (rowConvert.SdkAccountRow). */
function accountRow(tag: string, identity: { toHexString(): string } = ID) {
  return {
    identity,
    authIssuer: 'https://issuer.invalid',
    createdAtMs: 1n,
    lastLoginAtMs: 2n,
    status: { tag },
    deletionRequestedAtMs: undefined,
    claimedFrom: undefined,
    claimedAtMs: undefined,
    terminalAtMs: undefined,
  };
}

/** Deliver one my_account row through build `buildIdx`'s captured onInsert callback, with NO
 *  await: whatever the handler does synchronously has happened when this returns. */
function fireAccount(tag: string, buildIdx = 0, identity: { toHexString(): string } = ID): void {
  const cb = H.rowCbs.my_account?.[buildIdx];
  if (cb === undefined) throw new Error('no my_account onInsert handler was registered');
  cb({}, accountRow(tag, identity));
}

/** fireAccount, then let the microtasks (batch flush, rejection routing) settle. */
async function insertAccount(
  tag: string,
  buildIdx = 0,
  identity: { toHexString(): string } = ID,
): Promise<void> {
  fireAccount(tag, buildIdx, identity);
  await settle();
}

/** Deliver one my_account row through build `buildIdx`'s captured onUpdate callback
 *  (called as (ctx, oldRow, newRow)), then settle. */
async function updateAccount(tag: string, oldTag: string, buildIdx = 0): Promise<void> {
  const cb = H.updCbs.my_account?.[buildIdx];
  if (cb === undefined) throw new Error('no my_account onUpdate handler was registered');
  cb({}, accountRow(oldTag), accountRow(tag));
  await settle();
}

/** Anon build driven through onConnect -> onApplied (joinGame call #1 happens in onApplied). */
async function bootAnon(opts: ConnectionOptions) {
  const handle = connect(opts);
  await settle();
  const b = H.builds[0];
  b.onConnect?.(conn0(b), ID, 'anon-tok');
  b.onApplied?.();
  return { handle, b };
}

/** Account-kind build (credential.kind 'account'), driven through onConnect -> onApplied. */
async function bootAccount(opts: ConnectionOptions) {
  writeAuthKind(globalThis, URI, DB, 'account');
  H.renew = () => Promise.resolve({ kind: 'ok', token: 'acct-jwt' });
  const handle = connect(opts);
  await settle();
  const b = H.builds[0];
  b.onConnect?.(conn0(b), ID, 'acct-jwt');
  b.onApplied?.();
  return { handle, b };
}

/** The onError calls that came from the join path (other `where`s, e.g. 'link', are ignored). */
const joinErrors = (opts: ConnectionOptions): unknown[][] =>
  (opts.onError as unknown as Mock).mock.calls.filter((c) => c[0] === 'join');

describe('E1-DECIDE shouldRejoinAfterAccountChange (pure decision)', () => {
  it('E1-DECIDE-01 PendingDeletion -> Active with no outstanding claim code re-joins', () => {
    expect(shouldRejoinAfterAccountChange('PendingDeletion', 'Active', false)).toBe(true);
  });

  it('E1-DECIDE-02 an undefined previous status (initial snapshot) never re-joins: onApplied owns that join', () => {
    expect(shouldRejoinAfterAccountChange(undefined, 'Active', false)).toBe(false);
  });

  it('E1-DECIDE-03 Active -> Active never re-joins', () => {
    expect(shouldRejoinAfterAccountChange('Active', 'Active', false)).toBe(false);
  });

  it('E1-DECIDE-04 PendingDeletion -> PendingDeletion never re-joins', () => {
    expect(shouldRejoinAfterAccountChange('PendingDeletion', 'PendingDeletion', false)).toBe(false);
  });

  it('E1-DECIDE-05 Active -> PendingDeletion never re-joins', () => {
    expect(shouldRejoinAfterAccountChange('Active', 'PendingDeletion', false)).toBe(false);
  });

  it('E1-DECIDE-06 an unconsumed claim code vetoes the re-join (it is never a second veto bypass)', () => {
    expect(shouldRejoinAfterAccountChange('PendingDeletion', 'Active', true)).toBe(false);
  });

  it('E1-DECIDE-07 PendingDeletion -> an unknown or terminal tag never re-joins', () => {
    expect(shouldRejoinAfterAccountChange('PendingDeletion', 'Deleted', false)).toBe(false);
    expect(shouldRejoinAfterAccountChange('PendingDeletion', 'SomethingNew', false)).toBe(false);
  });

  it('E1-DECIDE-08 only the exact PendingDeletion -> Active edge (and no veto) is true, over the whole tag grid', () => {
    const tags = [undefined, 'Active', 'PendingDeletion', 'Deleted', 'active', ''] as const;
    const nexts = ['Active', 'PendingDeletion', 'Deleted', 'active', ''] as const;
    for (const prev of tags) {
      for (const next of nexts) {
        for (const veto of [false, true]) {
          const want = prev === 'PendingDeletion' && next === 'Active' && !veto;
          expect(
            shouldRejoinAfterAccountChange(prev, next, veto),
            `prev=${String(prev)} next=${next} veto=${veto}`,
          ).toBe(want);
        }
      }
    }
  });
});

describe('E1-REJOIN connect() re-issues joinGame when my_account returns to Active', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.builds = [];
    H.renew = null;
    H.rowCbs = {};
    H.updCbs = {};
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide')); // tear the connection down: no stray rebuilds
    vi.useRealTimers();
  });

  it('E1-REJOIN-01 PendingDeletion then Active re-issues joinGame exactly once more, with the player name', async () => {
    const opts = makeOpts();
    const { b } = await bootAnon(opts);
    expect(b.joinGame, 'onApplied owns join #1').toHaveBeenCalledTimes(1);

    await insertAccount('PendingDeletion');
    expect(b.joinGame, 'entering PendingDeletion must not join').toHaveBeenCalledTimes(1);

    await insertAccount('Active');
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(b.joinGame).toHaveBeenLastCalledWith({ name: 'Tester' });
    expect(joinErrors(opts)).toEqual([]);
  });

  it('E1-REJOIN-02 the first-ever Active row after applied (no previous status) does not re-join', async () => {
    const { b } = await bootAnon(makeOpts());
    await insertAccount('Active');
    expect(b.joinGame).toHaveBeenCalledTimes(1);
  });

  it('E1-REJOIN-03 PendingDeletion then PendingDeletion does not re-join', async () => {
    const { b } = await bootAnon(makeOpts());
    await insertAccount('PendingDeletion');
    await insertAccount('PendingDeletion');
    expect(b.joinGame).toHaveBeenCalledTimes(1);
  });

  it('E1-REJOIN-04 Active then Active does not re-join', async () => {
    const { b } = await bootAnon(makeOpts());
    await insertAccount('Active');
    await insertAccount('Active');
    expect(b.joinGame).toHaveBeenCalledTimes(1);
  });

  it('E1-REJOIN-05 an Active row repeated after the re-join does not join again, and a second cancel cycle joins again', async () => {
    const { b } = await bootAnon(makeOpts());
    await insertAccount('PendingDeletion');
    await insertAccount('Active');
    expect(b.joinGame).toHaveBeenCalledTimes(2);

    await insertAccount('Active');
    expect(b.joinGame, 'a repeated Active is not a new edge').toHaveBeenCalledTimes(2);

    await insertAccount('PendingDeletion');
    await insertAccount('Active');
    expect(b.joinGame, 'each cancel is its own edge').toHaveBeenCalledTimes(3);
  });

  it('E1-REJOIN-06 an unconsumed claim code on an account build vetoes the re-join', async () => {
    claimCode.mint(globalThis, URI, DB);
    const { b } = await bootAccount(makeOpts());
    expect(b.joinGame, 'the account-build join veto holds on onApplied').not.toHaveBeenCalled();

    await insertAccount('PendingDeletion');
    await insertAccount('Active');
    expect(b.joinGame, 'the re-join is not a second veto bypass').not.toHaveBeenCalled();
  });

  it('E1-REJOIN-07 the same account build with NO claim code does re-join (the veto test is not vacuous)', async () => {
    const { b } = await bootAccount(makeOpts());
    expect(b.joinGame).toHaveBeenCalledTimes(1);

    await insertAccount('PendingDeletion');
    await insertAccount('Active');
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(b.joinGame).toHaveBeenLastCalledWith({ name: 'Tester' });
  });

  it('E1-REJOIN-08 a rejected re-join surfaces through the same catch as onApplied: onError("join", message)', async () => {
    const opts = makeOpts();
    const { b } = await bootAnon(opts);
    b.joinGame.mockImplementation(() => Promise.reject(new Error('boom')));

    await insertAccount('PendingDeletion');
    await insertAccount('Active');
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(joinErrors(opts)).toEqual([['join', 'boom']]);
  });

  it('E1-REJOIN-09 a rejected re-join with "already joined" is benign (the player stayed connected through the cancel)', async () => {
    const opts = makeOpts();
    const { b } = await bootAnon(opts);
    b.joinGame.mockImplementation(() => Promise.reject(new Error('already joined')));

    await insertAccount('PendingDeletion');
    await insertAccount('Active');
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(joinErrors(opts)).toEqual([]);
  });

  it('E1-REJOIN-10 after a reconnect the re-join goes out on the CURRENT connection, not the dropped one', async () => {
    const { b: b0 } = await bootAnon(makeOpts());
    b0.onDisconnect?.();
    await nextAttempt();
    expect(H.builds).toHaveLength(2);
    const b1 = H.builds[1];
    b1.onConnect?.(conn0(b1), ID, 'anon-tok');
    b1.onApplied?.();
    expect(b1.joinGame, 'the rebuilt connection joins on its own applied').toHaveBeenCalledTimes(1);
    expect(b0.joinGame).toHaveBeenCalledTimes(1);

    await insertAccount('PendingDeletion', 1);
    await insertAccount('Active', 1);
    expect(b1.joinGame).toHaveBeenCalledTimes(2);
    expect(b1.joinGame).toHaveBeenLastCalledWith({ name: 'Tester' });
    expect(b0.joinGame, 'the dropped connection must never be reused').toHaveBeenCalledTimes(1);
  });

  it('E1-REJOIN-11 the Active half arriving through onUpdate re-joins exactly once', async () => {
    const { b } = await bootAnon(makeOpts());
    await insertAccount('PendingDeletion');
    expect(b.joinGame).toHaveBeenCalledTimes(1);

    await updateAccount('Active', 'PendingDeletion');
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(b.joinGame).toHaveBeenLastCalledWith({ name: 'Tester' });
  });

  it("E1-REJOIN-12 a row for a FOREIGN identity never re-joins, even when it is the Active edge over this player's PendingDeletion", async () => {
    const foreign = { toHexString: () => 'ab'.repeat(32) };
    const { b } = await bootAnon(makeOpts());
    await insertAccount('PendingDeletion');
    await insertAccount('Active', 0, foreign);
    expect(b.joinGame).toHaveBeenCalledTimes(1);
  });

  it('E1-REJOIN-13 any previous status other than PendingDeletion (unknown or terminal tags) never re-joins on Active', async () => {
    const { b } = await bootAnon(makeOpts());
    for (const tag of ['Deleted', 'SomethingNew', 'active', '']) {
      await insertAccount(tag);
      await insertAccount('Active');
      expect(b.joinGame, `${JSON.stringify(tag)} -> Active`).toHaveBeenCalledTimes(1);
    }
  });

  it('E1-REJOIN-14 a superseded build delivering the Active row never joins, on itself or on the current build', async () => {
    const { b: b0 } = await bootAnon(makeOpts());
    b0.onDisconnect?.();
    await nextAttempt();
    const b1 = H.builds[1];
    b1.onConnect?.(conn0(b1), ID, 'anon-tok');
    b1.onApplied?.();
    expect(b1.joinGame).toHaveBeenCalledTimes(1);

    await insertAccount('PendingDeletion', 1);
    await insertAccount('Active', 0);
    expect(b0.joinGame, 'a dead socket must not join').toHaveBeenCalledTimes(1);
    expect(b1.joinGame, 'a stale delivery must not join the current build').toHaveBeenCalledTimes(
      1,
    );

    // The stale delivery did not consume the edge: the current build's own Active still joins.
    await insertAccount('Active', 1);
    expect(b1.joinGame).toHaveBeenCalledTimes(2);
    expect(b0.joinGame).toHaveBeenCalledTimes(1);
  });

  it('E1-REJOIN-15 the re-join is logged to onSend exactly once (not raw, not double-wrapped)', async () => {
    const onSend = vi.fn();
    const { b } = await bootAnon({ ...makeOpts(), onSend } as ConnectionOptions);
    expect(b.joinGame).toHaveBeenCalledTimes(1);
    onSend.mockClear();

    await insertAccount('PendingDeletion');
    await insertAccount('Active');
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls).toEqual([['joinGame', [{ name: 'Tester' }]]]);
  });

  it('E1-REJOIN-16 a claim code minted mid-session vetoes the re-join, and clearing it lifts the veto', async () => {
    const { b } = await bootAnon(makeOpts());
    expect(b.joinGame).toHaveBeenCalledTimes(1);

    claimCode.mint(globalThis, URI, DB);
    await insertAccount('PendingDeletion');
    await insertAccount('Active');
    expect(b.joinGame, 'the veto is read fresh per edge').toHaveBeenCalledTimes(1);

    claimCode.clear(globalThis, URI, DB);
    await insertAccount('PendingDeletion');
    await insertAccount('Active');
    expect(b.joinGame).toHaveBeenCalledTimes(2);
  });

  it('E1-REJOIN-17 the mid-grace reconnect: a rejected first join, a drop, a PendingDeletion snapshot, then Active re-joins once', async () => {
    const opts = makeOpts();
    const handle = connect(opts);
    await settle();
    const b0 = H.builds[0];
    b0.joinGame.mockImplementation(() => Promise.reject(new Error('account pending deletion')));
    b0.onConnect?.(conn0(b0), ID, 'anon-tok');
    b0.onApplied?.();
    await settle();
    expect(joinErrors(opts)).toEqual([['join', 'account pending deletion']]);

    b0.onDisconnect?.();
    await nextAttempt();
    expect(H.builds).toHaveLength(2);
    const b1 = H.builds[1];
    b1.onConnect?.(conn0(b1), ID, 'anon-tok');
    b1.onApplied?.();
    expect(b1.joinGame, 'the rebuilt connection joins on its own applied').toHaveBeenCalledTimes(1);

    await insertAccount('PendingDeletion', 1);
    expect(b1.joinGame, 'the snapshot row has no previous status').toHaveBeenCalledTimes(1);

    await insertAccount('Active', 1);
    expect(b1.joinGame).toHaveBeenCalledTimes(2);
    expect(b1.joinGame).toHaveBeenLastCalledWith({ name: 'Tester' });
    expect(b0.joinGame).toHaveBeenCalledTimes(1);
    expect(handle.linkFrozen()).toBe(false);
  });

  it('E1-REJOIN-18 the re-join is issued synchronously with the Active delivery, before any await', async () => {
    const { b } = await bootAnon(makeOpts());
    await insertAccount('PendingDeletion');
    expect(b.joinGame).toHaveBeenCalledTimes(1);

    fireAccount('Active');
    expect(b.joinGame, 'no microtask deferral').toHaveBeenCalledTimes(2);
    await settle();
    expect(b.joinGame).toHaveBeenCalledTimes(2);
  });
});

describe('E1-JOIN Connection.join() surfaces failures', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.builds = [];
    H.renew = null;
    H.rowCbs = {};
    H.updCbs = {};
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
  });

  it('E1-JOIN-01 on a live link join() calls joinGame with the player name and reports nothing on success', async () => {
    const opts = makeOpts();
    const { handle, b } = await bootAnon(opts);
    expect(b.joinGame).toHaveBeenCalledTimes(1);

    handle.join();
    await settle();
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(b.joinGame).toHaveBeenLastCalledWith({ name: 'Tester' });
    expect(joinErrors(opts)).toEqual([]);
  });

  it('E1-JOIN-02 a rejection "boom" surfaces as onError("join", "boom") exactly once', async () => {
    const opts = makeOpts();
    const { handle, b } = await bootAnon(opts);
    b.joinGame.mockImplementation(() => Promise.reject(new Error('boom')));

    handle.join();
    await settle();
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(joinErrors(opts)).toEqual([['join', 'boom']]);
  });

  it('E1-JOIN-03 the exact rejection "already joined" is benign: onError is never called for join', async () => {
    const opts = makeOpts();
    const { handle, b } = await bootAnon(opts);
    b.joinGame.mockImplementation(() => Promise.reject(new Error('already joined')));

    handle.join();
    await settle();
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(joinErrors(opts)).toEqual([]);
  });

  it('E1-JOIN-04 a rejection with an empty message surfaces the fallback "join failed"', async () => {
    const opts = makeOpts();
    const { handle, b } = await bootAnon(opts);
    b.joinGame.mockImplementation(() => Promise.reject(new Error('')));

    handle.join();
    await settle();
    expect(joinErrors(opts)).toEqual([['join', 'join failed']]);
  });

  it('E1-JOIN-05 a rejection with no error object at all still surfaces the fallback "join failed"', async () => {
    const opts = makeOpts();
    const { handle, b } = await bootAnon(opts);
    b.joinGame.mockImplementation(() => Promise.reject(undefined));

    handle.join();
    await settle();
    expect(joinErrors(opts)).toEqual([['join', 'join failed']]);
  });

  it('E1-JOIN-06 the benign match is EXACT: "already joined!" and "Already joined" are real failures', async () => {
    const opts = makeOpts();
    const { handle, b } = await bootAnon(opts);

    b.joinGame.mockImplementation(() => Promise.reject(new Error('already joined!')));
    handle.join();
    await settle();
    b.joinGame.mockImplementation(() => Promise.reject(new Error('Already joined')));
    handle.join();
    await settle();
    expect(joinErrors(opts)).toEqual([
      ['join', 'already joined!'],
      ['join', 'Already joined'],
    ]);
  });

  it('E1-JOIN-07 with no connection built yet join() is a no-op and queues nothing', async () => {
    const opts = makeOpts();
    const handle = connect(opts);
    expect(H.builds, 'cold start defers the first build').toHaveLength(0);
    handle.join();
    await settle();
    expect(H.builds).toHaveLength(1);
    expect(H.builds[0].joinGame).not.toHaveBeenCalled();

    // The first applied snapshot joins once; the earlier join() was not queued behind it.
    H.builds[0].onConnect?.(conn0(H.builds[0]), ID, 'anon-tok');
    H.builds[0].onApplied?.();
    expect(H.builds[0].joinGame).toHaveBeenCalledTimes(1);
    expect(joinErrors(opts)).toEqual([]);
  });

  it('E1-JOIN-08 before the first applied snapshot the link is frozen, so join() does not call joinGame', async () => {
    const opts = makeOpts();
    const handle = connect(opts);
    await settle();
    const b = H.builds[0];
    b.onConnect?.(conn0(b), ID, 'anon-tok');
    expect(handle.linkFrozen()).toBe(true);

    handle.join();
    await settle();
    expect(b.joinGame).not.toHaveBeenCalled();
    expect(joinErrors(opts)).toEqual([]);
  });

  it('E1-JOIN-09 after a drop (frozen, before the rebuild applies) join() does not call joinGame on the dead connection', async () => {
    const opts = makeOpts();
    const { handle, b } = await bootAnon(opts);
    expect(b.joinGame).toHaveBeenCalledTimes(1);

    b.onDisconnect?.();
    expect(handle.linkFrozen()).toBe(true);
    handle.join();
    await settle();
    expect(b.joinGame).toHaveBeenCalledTimes(1);
    expect(joinErrors(opts)).toEqual([]);
  });

  it('E1-JOIN-10 join() issues joinGame synchronously, before any await', async () => {
    const { handle, b } = await bootAnon(makeOpts());
    handle.join();
    expect(b.joinGame, 'no microtask deferral').toHaveBeenCalledTimes(2);
    await settle();
    expect(b.joinGame).toHaveBeenCalledTimes(2);
  });

  it('E1-JOIN-11 join() is logged to onSend exactly once (not raw, not double-wrapped)', async () => {
    const onSend = vi.fn();
    const { handle, b } = await bootAnon({ ...makeOpts(), onSend } as ConnectionOptions);
    expect(b.joinGame).toHaveBeenCalledTimes(1);
    onSend.mockClear();

    handle.join();
    await settle();
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls).toEqual([['joinGame', [{ name: 'Tester' }]]]);
  });
});

describe('ts-4.4 connect() subscribes no trade_offer and wires no handler on it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.builds = [];
    H.renew = null;
    H.rowCbs = {};
    H.updCbs = {};
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
  });

  it('ts-4.4 the subscription batch is exactly the 30 queries below, none naming trade_offer, none an unfiltered character query, and no row handler is registered on the trade_offer table; before it the protocol gate subscribes exactly the bare string SELECT * FROM module_info, which the batch does not repeat [lpw-4.3]', async () => {
    // WRONG IMPL KILLED: `SELECT * FROM trade_offer` kept (every public offer reaches the
    // client); it swapped for another table (the exact set); a duplicate (the sorted list);
    // the query dropped but the trade_offer onInsert / onUpdate / onDelete handlers kept.
    // The gate query put inside the base array (then no gate and a 31-query batch); the
    // gate as a one-string array; a second gate; another table or text for the gate.
    const { b } = await bootAnon(makeOpts());
    expect(
      b.gate.map((sub) => sub.query),
      'the protocol gate: one subscribe of the bare string',
    ).toEqual(['SELECT * FROM module_info']);
    expect(
      (b.queries ?? []).filter((q) => q.includes('module_info')),
      'the base batch never names module_info',
    ).toEqual([]);
    const whole = (tables: string[]): string[] => tables.map((table) => `SELECT * FROM ${table}`);
    const want = [
      ...whole([
        'player',
        'my_monster_pub',
        'species_row',
        'my_battle',
        'skill_row',
        'my_inventory',
        'item_row',
        'evolution_path',
        'my_conversation',
        'my_player_quest',
        'heal_location_row',
        'npc',
        'zone_def',
        'shop_row',
        'shop_item_row',
        'my_wallet',
        'battle_challenge',
      ]),
      // sr-4b: `profile` is read as the leaderboard_top members (a join) plus the own row.
      'SELECT profile.* FROM profile JOIN leaderboard_top ON profile.identity = leaderboard_top.identity',
      `SELECT * FROM profile WHERE identity = 0x${ID.toHexString()}`,
      ...whole([
        'my_account',
        'my_export_bundle',
        'my_pending_evolution_notices',
        'my_tactical_battle',
        'my_battle_units',
        'my_battle_queue',
        'my_battle_deploy',
        'my_battle_clock',
        'my_battle_events',
        'my_formation',
        'my_trade_session',
      ]),
    ];
    expect(want).toHaveLength(30);
    expect([...(b.queries ?? [])].sort()).toEqual([...want].sort());
    // `character` is written on every step of every player, so the base set never carries it
    // whole; the world scope subscribes the own row and each wanted zone as sets of their own.
    expect(
      (b.queries ?? []).filter((q) => /^\s*SELECT\s.*\sFROM\s+character\s*;?\s*$/i.test(q)),
      'no base string is an unfiltered character query',
    ).toEqual([]);
    expect((b.queries ?? []).filter((q) => /\bcharacter\b/.test(q))).toEqual([]);
    expect((b.queries ?? []).filter((q) => q.includes('trade_offer'))).toEqual([]);
    // sr-3: player_quest is private; the client reads its own rows through my_player_quest.
    expect(
      (b.queries ?? []).filter((q) => /FROM\s+player_quest\b/.test(q)),
      'the private player_quest table is never subscribed',
    ).toEqual([]);
    const handled = [...Object.keys(H.rowCbs), ...Object.keys(H.updCbs)];
    expect(handled, 'precondition: the row handlers were wired').toContain('my_account');
    expect(handled.filter((name) => /trade_?offer/i.test(name))).toEqual([]);
  });
});

/** Drop comments from TypeScript source, line-based so a stray quote or backtick inside a
 *  string/template cannot desynchronise it: whole-line double-slash comments, block comments
 *  (multi-line, tracked by line), inline block comments, and a trailing double-slash comment
 *  whose code prefix has balanced quotes. */
function stripComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      inBlock = false;
      line = line.slice(end + 2);
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/', 2);
      if (end === -1) {
        inBlock = true;
        continue;
      }
      line = trimmed.slice(end + 2);
    }
    line = line.replace(/\/\*.*?\*\//g, '');
    const m = /\s\/\/.*$/.exec(line);
    if (m !== null) {
      const before = line.slice(0, m.index);
      const balanced = ["'", '"', '`'].every((q) => before.split(q).length % 2 === 1);
      if (balanced) line = before;
    }
    out.push(line);
  }
  return out.join('\n');
}

describe('E1-MAIN main.ts routes the claim-flow join through conn.join()', () => {
  const mainPath = resolve(dirname(fileURLToPath(import.meta.url)), '../main.ts');
  const code = stripComments(readFileSync(mainPath, 'utf8'));

  it('E1-MAIN-01 main.ts contains no direct joinGame call (the unhandled-rejection defect)', () => {
    const direct = code.match(/\bjoinGame\s*\(/g) ?? [];
    expect(direct).toHaveLength(0);
  });

  it("E1-MAIN-02 applyClaim's join effect calls conn?.join() exactly once, inside the 'join' branch", () => {
    const start = code.indexOf('function applyClaim(');
    expect(start, 'applyClaim must exist').toBeGreaterThanOrEqual(0);
    const rest = code.slice(start);
    const end = rest.indexOf('\n}');
    expect(end, 'applyClaim must close at column 0').toBeGreaterThan(0);
    const body = rest.slice(0, end);

    expect(body.split('conn?.join()').length - 1).toBe(1);
    expect(body).toMatch(/step\.effect === 'join'\)\s*(?:\{\s*)?(?:void\s+)?conn\?\.join\(\)/);
  });

  // RAW source, no comment stripping: the token is gone from main.ts entirely, so a bracket
  // (`reducers['join' + 'Game']`), destructured or string-hidden call has nowhere to live.
  it('E1-MAIN-03 the raw main.ts source never contains the token joinGame', () => {
    const raw = readFileSync(mainPath, 'utf8');
    expect(raw.split('joinGame').length - 1).toBe(0);
  });

  it('E1-MAIN-04 the raw main.ts source never indexes reducers by bracket', () => {
    const raw = readFileSync(mainPath, 'utf8');
    expect(raw.split('reducers[').length - 1).toBe(0);
  });
});

// =============================================================================================
// The account gate: a connection that needs an account withholds an anonymous join, learns that
// need from the server's ownership refusal, and starts a sign-in without a claim code.
// =============================================================================================

type GateOpts = ConnectionOptions & Record<string, Mock>;

/** makeOpts plus the gate's two callbacks. Each lifecycle callback also appends its name to
 *  `order`, so a case reads which one came first. */
function gateOpts(extra: Record<string, unknown> = {}): { opts: GateOpts; order: string[] } {
  const order: string[] = [];
  const opts = {
    ...makeOpts(),
    onReady: vi.fn(() => {
      order.push('ready');
    }),
    onReconnect: vi.fn(() => {
      order.push('reconnect');
    }),
    onAccountRequired: vi.fn(() => {
      order.push('account-required');
    }),
    onOwnershipRefused: vi.fn(() => {
      order.push('ownership-refused');
    }),
    ...extra,
  } as unknown as GateOpts;
  return { opts, order };
}

/** The error join_game answers a caller that does not own the game with, as the SDK hands it. */
const OWNERSHIP_REQUIRED = 'ownership required';

/** connect(), then build 0 through onConnect and its applied snapshot, then settle. `prime` runs
 *  on the build record before the snapshot applies, so a case can script joinGame. */
async function bootGate(
  opts: ConnectionOptions,
  prime?: (b: BuildRec) => void,
  token = 'anon-tok',
): Promise<{ handle: ReturnType<typeof connect>; b: BuildRec }> {
  const handle = connect(opts);
  await settle();
  const b = H.builds[0];
  prime?.(b);
  b.onConnect?.(conn0(b), ID, token);
  b.onApplied?.();
  await settle();
  return { handle, b };
}

/** Drop build `from`, let the rebuild fire, and drive it through onConnect and its snapshot. */
async function reconnectFrom(from: number, token = 'anon-tok'): Promise<BuildRec> {
  H.builds[from].onDisconnect?.();
  await nextAttempt();
  const b = H.builds[from + 1];
  if (b === undefined) throw new Error(`build ${from} was not rebuilt`);
  b.onConnect?.(conn0(b), ID, token);
  b.onApplied?.();
  await settle();
  return b;
}

const rejectWith = (message: string) => () => Promise.reject(new Error(message));

/** Every entry of both storage areas, sorted, as [key, value] pairs. */
function storageSnapshot(): { session: string[][]; local: string[][] } {
  const entries = (s: Storage): string[][] => {
    const out: string[][] = [];
    for (let i = 0; i < s.length; i += 1) {
      const key = s.key(i);
      if (key !== null) out.push([key, s.getItem(key) ?? '']);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  };
  return { session: entries(sessionStorage), local: entries(localStorage) };
}

/** Where the scripted beginSignIn sends the page. */
const AUTHORIZE_URL = 'https://auth.example.invalid/authorize?gate';

/** `location.assign` as a spy, so a sign-in redirect is observed and never taken. */
function stubNavigation(): Mock {
  const assign = vi.fn();
  vi.stubGlobal('location', { assign, href: 'http://localhost:3000/', pathname: '/', search: '' });
  return assign;
}

/** beginSignIn answers `ready` with AUTHORIZE_URL. */
function redirectReady(): Mock {
  const begin = vi.fn(() => Promise.resolve({ kind: 'ready', authorizationUrl: AUTHORIZE_URL }));
  H.begin = begin;
  return begin;
}

describe('connect() withholds the join of a connection that needs an account', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.builds = [];
    H.renew = null;
    H.rowCbs = {};
    H.updCbs = {};
    H.begin = null;
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
    vi.unstubAllGlobals();
    H.begin = null;
  });

  it('an anonymous build of a connection that requires an account calls no joinGame on its applied snapshot and reports onAccountRequired once, before onReady [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the join still sent; onAccountRequired after onReady (main.ts would paint
    // onReady's screen first); onAccountRequired twice per snapshot; no onAccountRequired at all.
    const { opts, order } = gateOpts({ accountRequired: true });
    const { b } = await bootGate(opts);
    expect(b.joinGame, 'no join_game before sign-in').not.toHaveBeenCalled();
    expect(opts.onAccountRequired).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['account-required', 'ready']);
    expect(joinErrors(opts)).toEqual([]);
  });

  it('a withheld join still opens the connection: the base set is subscribed, the link is not frozen and onReady carries the identity [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the withheld join returning early from the applied snapshot (no onReady,
    // the link left frozen, so the sign-in screen never appears and nothing can be sent).
    const { opts } = gateOpts({ accountRequired: true });
    const { handle, b } = await bootGate(opts);
    expect(opts.onAccountRequired).toHaveBeenCalledTimes(1);
    expect(opts.onReady).toHaveBeenCalledTimes(1);
    expect(opts.onReady).toHaveBeenCalledWith(ID.toHexString());
    expect(handle.linkFrozen(), 'the link is live').toBe(false);
    expect(b.queries ?? [], 'the base set was subscribed').toContain('SELECT * FROM player');
    expect(handle.identity()).toBe(ID.toHexString());
  });

  it('each later applied snapshot of a required anonymous connection reports onAccountRequired again, just before onReconnect, and no build sends joinGame [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the gate reported on the first snapshot only (a reconnect would show no
    // sign-in screen); the reconnect joining; onAccountRequired after onReconnect.
    const { opts, order } = gateOpts({ accountRequired: true });
    const { b } = await bootGate(opts);
    const b1 = await reconnectFrom(0);
    expect(b.joinGame).not.toHaveBeenCalled();
    expect(b1.joinGame).not.toHaveBeenCalled();
    expect(opts.onAccountRequired).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['account-required', 'ready', 'account-required', 'reconnect']);
  });

  it('an account build of a connection that requires an account joins on its applied snapshot and never reports onAccountRequired [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the join withheld for every build while an account is required (a signed-in
    // owner could never play); onAccountRequired fired for an account build.
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'ok', token: 'acct-jwt' });
    const { opts, order } = gateOpts({ accountRequired: true });
    const { b } = await bootGate(opts, undefined, 'acct-jwt');
    expect(b.token, 'precondition: an account build').toBe('acct-jwt');
    expect(b.joinGame).toHaveBeenCalledTimes(1);
    expect(b.joinGame).toHaveBeenCalledWith({ name: 'Tester' });
    expect(opts.onAccountRequired).not.toHaveBeenCalled();
    expect(order).toEqual(['ready']);
  });

  it('an account build with an unconsumed claim code keeps the claim veto while an account is required: no joinGame, no onAccountRequired, the claim flow awaits the account [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the gate's join bypassing the claim veto (the guest's progress would be
    // stranded); onAccountRequired fired for an account build.
    claimCode.mint(globalThis, URI, DB);
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'ok', token: 'acct-jwt' });
    const { opts } = gateOpts({ accountRequired: true });
    const { b } = await bootGate(opts, undefined, 'acct-jwt');
    expect(b.joinGame).not.toHaveBeenCalled();
    expect(opts.onAccountRequired).not.toHaveBeenCalled();
    expect(opts.onClaimAwaitingAccount).toHaveBeenCalledTimes(1);
  });

  it('with no account required an anonymous build joins on its applied snapshot and never reports onAccountRequired [acs-7.1]', async () => {
    // Control: the anonymous join of an open server is the same as before.
    const { opts } = gateOpts();
    const { b } = await bootGate(opts);
    expect(b.joinGame).toHaveBeenCalledTimes(1);
    expect(opts.onAccountRequired).not.toHaveBeenCalled();
  });

  it('with accountRequired false an anonymous build joins on its applied snapshot and never reports onAccountRequired [acs-7.1]', async () => {
    // Control: false is the same as absent.
    const { opts } = gateOpts({ accountRequired: false });
    const { b } = await bootGate(opts);
    expect(b.joinGame).toHaveBeenCalledTimes(1);
    expect(opts.onAccountRequired).not.toHaveBeenCalled();
  });

  it('join() on an anonymous build while an account is required calls no joinGame [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the gate applied in the applied snapshot only, so the claim flow's join()
    // still sends an anonymous join_game the server refuses.
    const { opts } = gateOpts({ accountRequired: true });
    const { handle, b } = await bootGate(opts);
    handle.join();
    await settle();
    expect(b.joinGame).not.toHaveBeenCalled();
    expect(joinErrors(opts)).toEqual([]);
  });
});

describe('connect() routes the ownership refusal of join_game', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.builds = [];
    H.renew = null;
    H.rowCbs = {};
    H.updCbs = {};
    H.begin = null;
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
    vi.unstubAllGlobals();
    H.begin = null;
  });

  it('joinGame refused with exactly "ownership required" reports onOwnershipRefused once and nothing through onError [acs-7.2]', async () => {
    // WRONG IMPL KILLED: the refusal still surfaced as onError('join', …) (the raw line on the
    // status bar); reported twice; reported through both callbacks.
    const { opts, order } = gateOpts();
    await bootGate(opts, (b) => {
      b.joinGame.mockImplementation(rejectWith(OWNERSHIP_REQUIRED));
    });
    expect(opts.onOwnershipRefused).toHaveBeenCalledTimes(1);
    expect(joinErrors(opts)).toEqual([]);
    expect(order, 'the refusal settles after onReady').toEqual(['ready', 'ownership-refused']);
  });

  it('the ownership match is exact: other case, a trailing dot, a prefix and the empty message go to onError("join", …), "already joined" stays silent, and none reaches onOwnershipRefused [acs-7.2]', async () => {
    // WRONG IMPL KILLED: a case-folded, includes(), endsWith() or startsWith() match; every join
    // error routed to onOwnershipRefused; the empty message losing its fallback.
    const { opts } = gateOpts();
    const { handle, b } = await bootGate(opts);
    for (const message of [
      'Ownership required',
      'ownership required.',
      'join_game: ownership required',
      '',
      'already joined',
    ]) {
      b.joinGame.mockImplementation(rejectWith(message));
      handle.join();
      await settle();
    }
    expect(b.joinGame, 'precondition: every join was sent').toHaveBeenCalledTimes(6);
    expect(opts.onOwnershipRefused).not.toHaveBeenCalled();
    expect(joinErrors(opts)).toEqual([
      ['join', 'Ownership required'],
      ['join', 'ownership required.'],
      ['join', 'join_game: ownership required'],
      ['join', 'join failed'],
    ]);
    // A near miss teaches nothing: the next applied snapshot still joins.
    const b1 = await reconnectFrom(0);
    expect(b1.joinGame).toHaveBeenCalledTimes(1);
    expect(opts.onAccountRequired).not.toHaveBeenCalled();
    // The exact message does reach it, on the same connection.
    b1.joinGame.mockImplementation(rejectWith(OWNERSHIP_REQUIRED));
    handle.join();
    await settle();
    expect(opts.onOwnershipRefused).toHaveBeenCalledTimes(1);
    expect(joinErrors(opts), 'and onError gained nothing').toHaveLength(4);
  });

  it('join() refused for ownership reports onOwnershipRefused, never onError [acs-7.2]', async () => {
    // WRONG IMPL KILLED: the routing put in the applied snapshot's call alone, so join() (the claim
    // flow's join) still surfaces the raw string.
    const { opts } = gateOpts();
    const { handle, b } = await bootGate(opts);
    b.joinGame.mockImplementation(rejectWith(OWNERSHIP_REQUIRED));
    handle.join();
    await settle();
    expect(b.joinGame).toHaveBeenCalledTimes(2);
    expect(opts.onOwnershipRefused).toHaveBeenCalledTimes(1);
    expect(joinErrors(opts)).toEqual([]);
  });

  it('the cancel-deletion re-join refused for ownership reports onOwnershipRefused, never onError [acs-7.2]', async () => {
    // WRONG IMPL KILLED: a second join path that keeps today's catch.
    const { opts } = gateOpts();
    const { b } = await bootGate(opts);
    b.joinGame.mockImplementation(rejectWith(OWNERSHIP_REQUIRED));
    await insertAccount('PendingDeletion');
    await insertAccount('Active');
    expect(b.joinGame, 'precondition: the re-join was sent').toHaveBeenCalledTimes(2);
    expect(opts.onOwnershipRefused).toHaveBeenCalledTimes(1);
    expect(joinErrors(opts)).toEqual([]);
  });

  it('after an ownership refusal a reconnect of the same connection withholds its anonymous join and reports onAccountRequired just before onReconnect [acs-7.2]', async () => {
    // WRONG IMPL KILLED: the refusal not remembered across a rebuild (every reconnect probes the
    // server again and the sign-in screen falls back to the refusal's); the memory kept per build.
    const { opts, order } = gateOpts();
    await bootGate(opts, (b) => {
      b.joinGame.mockImplementation(rejectWith(OWNERSHIP_REQUIRED));
    });
    expect(opts.onOwnershipRefused).toHaveBeenCalledTimes(1);
    const b1 = await reconnectFrom(0);
    expect(b1.joinGame).not.toHaveBeenCalled();
    expect(opts.onAccountRequired).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['ready', 'ownership-refused', 'account-required', 'reconnect']);
  });

  it('after an ownership refusal join() on the anonymous build calls no joinGame [acs-7.2]', async () => {
    const { opts } = gateOpts();
    const { handle, b } = await bootGate(opts, (rec) => {
      rec.joinGame.mockImplementation(rejectWith(OWNERSHIP_REQUIRED));
    });
    expect(opts.onOwnershipRefused).toHaveBeenCalledTimes(1);
    handle.join();
    await settle();
    expect(b.joinGame).toHaveBeenCalledTimes(1);
  });

  it('after an ownership refusal a later account build of the same connection still joins and reports no onAccountRequired [acs-7.2]', async () => {
    // WRONG IMPL KILLED: the learned need withholding every later join, the owner's account
    // connection included.
    const { opts } = gateOpts();
    await bootGate(opts, (b) => {
      b.joinGame.mockImplementation(rejectWith(OWNERSHIP_REQUIRED));
    });
    expect(opts.onOwnershipRefused).toHaveBeenCalledTimes(1);
    writeAuthKind(globalThis, URI, DB, 'account');
    H.renew = () => Promise.resolve({ kind: 'ok', token: 'acct-jwt' });
    const b1 = await reconnectFrom(0, 'acct-jwt');
    expect(b1.token, 'precondition: the rebuild is an account build').toBe('acct-jwt');
    expect(b1.joinGame).toHaveBeenCalledTimes(1);
    expect(opts.onAccountRequired).not.toHaveBeenCalled();
  });

  it('a refusal that settles after its build was superseded reports neither callback and teaches nothing: the next anonymous build still joins [acs-7.2]', async () => {
    // WRONG IMPL KILLED: the rejection handler with no superseded-build guard (a dead socket's late
    // answer raises the screen, or teaches the page to withhold every later join).
    let rejectFirst: (err: Error) => void = () => {};
    const { opts } = gateOpts();
    await bootGate(opts, (b) => {
      b.joinGame.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      );
    });
    H.builds[0].onDisconnect?.();
    await nextAttempt();
    expect(H.builds, 'precondition: a newer build exists').toHaveLength(2);
    rejectFirst(new Error(OWNERSHIP_REQUIRED));
    await settle();
    expect(opts.onOwnershipRefused).not.toHaveBeenCalled();
    expect(joinErrors(opts)).toEqual([]);
    const b1 = H.builds[1];
    b1.onConnect?.(conn0(b1), ID, 'anon-tok');
    b1.onApplied?.();
    await settle();
    expect(b1.joinGame).toHaveBeenCalledTimes(1);
    expect(opts.onAccountRequired).not.toHaveBeenCalled();
  });
});

describe('connect() starts a sign-in without a claim code while an account is required', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.builds = [];
    H.renew = null;
    H.rowCbs = {};
    H.updCbs = {};
    H.begin = null;
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
    vi.unstubAllGlobals();
    H.begin = null;
  });

  it('startSignIn on a live link while an account is required mints no claim code, calls no startGuestClaim and begins the OIDC redirect [acs-7.1]', async () => {
    // WRONG IMPL KILLED: startSignIn still minting a code and calling start_guest_claim, which the
    // server refuses for a caller it never admitted ("not joined"), so no sign-in ever starts.
    const assign = stubNavigation();
    const begin = redirectReady();
    const { opts } = gateOpts({ accountRequired: true });
    const { handle, b } = await bootGate(opts);
    handle.startSignIn();
    await settle();
    expect(b.startGuestClaim).not.toHaveBeenCalled();
    expect(claimCode.read(globalThis, URI, DB), 'no claim code was minted').toBeUndefined();
    expect(begin).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls).toEqual([[AUTHORIZE_URL]]);
    expect(opts.onSignInFailed).not.toHaveBeenCalled();
  });

  it('startSignIn while an account is required begins the redirect with no live link: before the first build and after a drop [acs-7.1]', async () => {
    // WRONG IMPL KILLED: the live-link check kept in front of the gate's sign-in (a player whose
    // link is down could not sign in from the screen that asks them to).
    const assign = stubNavigation();
    const begin = redirectReady();
    const { opts } = gateOpts({ accountRequired: true });
    const handle = connect(opts);
    handle.startSignIn();
    await settle();
    expect(begin, 'before any build').toHaveBeenCalledTimes(1);
    expect(assign.mock.calls).toEqual([[AUTHORIZE_URL]]);

    const b0 = H.builds[0];
    b0.onConnect?.(conn0(b0), ID, 'anon-tok');
    b0.onApplied?.();
    await settle();
    b0.onDisconnect?.();
    expect(handle.linkFrozen(), 'precondition: the link is down').toBe(true);
    handle.startSignIn();
    await settle();
    expect(begin, 'after a drop').toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledTimes(2);
    expect(b0.startGuestClaim).not.toHaveBeenCalled();
    expect(opts.onSignInFailed).not.toHaveBeenCalled();
    expect(claimCode.read(globalThis, URI, DB)).toBeUndefined();
  });

  it('startSignIn while an account is required leaves a claim code already in storage byte for byte as it was [acs-7.1]', async () => {
    // WRONG IMPL KILLED: a fresh code minted over the stored one, or the stored one cleared (a guest
    // from before the server enforced would lose the only way to move its progress).
    stubNavigation();
    const begin = redirectReady();
    const stored = claimCode.mint(globalThis, URI, DB);
    expect(stored, 'precondition: a code is stored').toMatch(/^[0-9a-f]{64}$/);
    const { opts } = gateOpts({ accountRequired: true });
    const { handle, b } = await bootGate(opts);
    const before = storageSnapshot();
    handle.startSignIn();
    await settle();
    expect(storageSnapshot()).toEqual(before);
    expect(claimCode.read(globalThis, URI, DB)).toBe(stored);
    expect(b.startGuestClaim).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it('after an ownership refusal startSignIn mints no claim code, calls no startGuestClaim and begins the redirect [acs-7.2]', async () => {
    const assign = stubNavigation();
    const begin = redirectReady();
    const { opts } = gateOpts();
    const { handle, b } = await bootGate(opts, (rec) => {
      rec.joinGame.mockImplementation(rejectWith(OWNERSHIP_REQUIRED));
    });
    expect(opts.onOwnershipRefused).toHaveBeenCalledTimes(1);
    handle.startSignIn();
    await settle();
    expect(b.startGuestClaim).not.toHaveBeenCalled();
    expect(claimCode.read(globalThis, URI, DB)).toBeUndefined();
    expect(begin).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls).toEqual([[AUTHORIZE_URL]]);
  });

  it('with sign-in off startSignIn reports only "sign-in-off" while an account is required [acs-7.1]', async () => {
    // Control: sign-in off still does nothing else.
    const assign = stubNavigation();
    const begin = redirectReady();
    const { opts } = gateOpts({ accountRequired: true, signIn: 'off' });
    const { handle, b } = await bootGate(opts);
    handle.startSignIn();
    await settle();
    expect(opts.onSignInFailed.mock.calls).toEqual([['sign-in-off']]);
    expect(b.startGuestClaim).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(claimCode.read(globalThis, URI, DB)).toBeUndefined();
  });

  it('with no account required startSignIn is unchanged: it mints a code, registers it with startGuestClaim, then begins the redirect [acs-7.1]', async () => {
    // Control: the guest claim flow's sign-in.
    const assign = stubNavigation();
    const begin = redirectReady();
    const { opts } = gateOpts();
    const { handle, b } = await bootGate(opts);
    handle.startSignIn();
    const code = claimCode.read(globalThis, URI, DB);
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(b.startGuestClaim.mock.calls).toEqual([[{ code }]]);
    await settle();
    expect(begin).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls).toEqual([[AUTHORIZE_URL]]);
  });
});
