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
interface BuildRec {
  token: unknown;
  onConnect?: Cb;
  onConnectError?: Cb;
  onDisconnect?: Cb;
  onApplied?: Cb;
  readonly joinGame: ReturnType<typeof vi.fn>;
  readonly completeGuestClaim: ReturnType<typeof vi.fn>;
  readonly startGuestClaim: ReturnType<typeof vi.fn>;
}

const H = vi.hoisted(() => ({
  builds: [] as BuildRec[],
  renew: null as null | (() => Promise<RenewalOutcome>),
  /** Per-table registered row callbacks, one entry per build (wireTables runs once per build). */
  rowCbs: {} as Record<string, Cb[]>,
  /** Per-table registered onUpdate callbacks, one entry per build; called as (ctx, old, new). */
  updCbs: {} as Record<string, Cb[]>,
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
        const rec: BuildRec = {
          token: 'UNSET',
          joinGame: vi.fn(() => Promise.resolve()),
          completeGuestClaim: vi.fn(() => Promise.resolve()),
          startGuestClaim: vi.fn(() => Promise.resolve()),
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
    beginSignIn: () => Promise.resolve({ kind: 'transient-error' }),
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

const settle = () => vi.advanceTimersByTimeAsync(0);
/** Let every scheduled reconnect fire (backoff is bounded well under a minute). */
const nextAttempt = () => vi.advanceTimersByTimeAsync(60_000);

/** The connection object handed to onConnect: only subscriptionBuilder + reducers are read there. */
function conn0(rec: BuildRec) {
  const sub = {
    onApplied: (cb: Cb) => {
      rec.onApplied = cb;
      return sub;
    },
    onError: () => sub,
    subscribe: () => sub,
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
