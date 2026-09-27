// @vitest-environment happy-dom
/**
 * connection.runtime.test.ts: drives the REAL connect() through each credential decision with
 * the SDK's DbConnection builder and the OIDC client mocked, and asserts what actually reaches
 * the builder (withToken), what is persisted, and how the retry ladder behaves.
 *
 * Replaces the connection.ts text pins (ledger CT-src-net-connection#credential-wiring).
 * credentialDecision.ts's pure logic has its own tests; this file covers its WIRING in connect().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
}

const H = vi.hoisted(() => ({
  builds: [] as BuildRec[],
  renew: null as null | (() => Promise<RenewalOutcome>),
  renewCalls: 0,
}));

vi.mock('../module_bindings', () => {
  const table = new Proxy(
    {},
    { get: (_t, k) => (k === 'iter' ? () => [][Symbol.iterator]() : () => undefined) },
  );
  return {
    DbConnection: {
      builder: () => {
        const rec: BuildRec = {
          token: 'UNSET',
          joinGame: vi.fn(() => Promise.resolve()),
          completeGuestClaim: vi.fn(() => Promise.resolve()),
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
          db: new Proxy({}, { get: () => table }),
          reducers: { joinGame: rec.joinGame, completeGuestClaim: rec.completeGuestClaim },
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

/** The connection object handed to onConnect: only subscriptionBuilder is read there. */
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
    reducers: { joinGame: rec.joinGame, completeGuestClaim: rec.completeGuestClaim },
  };
}
