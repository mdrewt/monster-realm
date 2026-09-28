// @vitest-environment happy-dom
/**
 * connection.conversationCoalesce.test.ts — the `my_conversation` view wiring in the REAL
 * connect() (debloat Phase 2: EV-conversation-privacy#ondelete-coalesce).
 *
 * Through a view, a row UPDATE arrives as onInsert(new) + onDelete(old), with no onUpdate
 * and in either order. A naive onDelete -> remove(owner) wipes the dialogue on
 * every mid-tree advance. shouldRemoveOnViewDelete (viewDelete.test.ts) is the pure gate;
 * this file proves connect() actually routes the view's callbacks through it: the SDK
 * DbConnection builder is mocked with a per-table callback recorder, and the recorded
 * my_conversation handlers are fired against the real AuthoritativeStore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConnectionOptions, connect } from './connection';
import { AuthoritativeStore } from './store';

type Cb = (...args: unknown[]) => void;

const H = vi.hoisted(() => ({
  /** table name -> event name (onInsert/onUpdate/onDelete) -> registered callbacks */
  handlers: new Map<string, Map<string, ((...args: unknown[]) => void)[]>>(),
  builds: 0,
}));

vi.mock('../module_bindings', () => {
  const tableFor = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, k) => {
          if (k === 'iter') return () => [][Symbol.iterator]();
          if (typeof k === 'string' && k.startsWith('on')) {
            return (cb: (...args: unknown[]) => void) => {
              let byEvent = H.handlers.get(name);
              if (!byEvent) {
                byEvent = new Map();
                H.handlers.set(name, byEvent);
              }
              byEvent.set(k, [...(byEvent.get(k) ?? []), cb]);
            };
          }
          return () => undefined;
        },
      },
    );
  return {
    DbConnection: {
      builder: () => {
        H.builds += 1;
        const sub = {
          onApplied: () => sub,
          onError: () => sub,
          subscribe: () => sub,
        };
        const conn = {
          db: new Proxy({}, { get: (_d, name) => tableFor(String(name)) }),
          reducers: {
            joinGame: vi.fn(() => Promise.resolve()),
            completeGuestClaim: vi.fn(() => Promise.resolve()),
          },
          subscriptionBuilder: () => sub,
        };
        const b = {
          withUri: () => b,
          withDatabaseName: () => b,
          withToken: () => b,
          onConnect: () => b,
          onConnectError: () => b,
          onDisconnect: () => b,
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
    renewOrExchange: () => Promise.reject(new Error('no OIDC in this suite')),
  }),
}));

const OWNER = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

function sdkRow(ownerHex: string, node: string) {
  return {
    ownerIdentity: { toHexString: () => ownerHex },
    npcEntityId: 7n,
    currentNodeId: node,
  };
}

function fire(event: 'onInsert' | 'onDelete', row: unknown): void {
  const cbs = H.handlers.get('my_conversation')?.get(event) ?? [];
  expect(cbs, `connect() must register exactly one my_conversation.${event}`).toHaveLength(1);
  for (const cb of cbs) (cb as Cb)({}, row);
}

function start(): AuthoritativeStore {
  const store = new AuthoritativeStore(200);
  const noop = vi.fn();
  connect({
    uri: 'ws://test.invalid',
    db: 'mr-test',
    name: 'Tester',
    store,
    onReady: noop,
    onReconnect: noop,
    onHydrated: noop,
    onError: noop,
    onSessionExpired: noop,
    onAuthServiceUnreachable: noop,
    onSignInFailed: noop,
    onClaimPending: noop,
    onClaimAwaitingAccount: noop,
    onClaimResult: noop,
  } as unknown as ConnectionOptions);
  return store;
}

describe('connect(): my_conversation view UPDATE coalescing (runtime)', {
  sequential: true,
}, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    H.handlers = new Map();
    H.builds = 0;
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
  });

  const built = async (): Promise<AuthoritativeStore> => {
    const store = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(H.builds, 'connect() built one connection').toBe(1);
    return store;
  };

  it('insert(new) then delete(old): the advanced node survives the stale delete', async () => {
    const store = await built();
    fire('onInsert', sdkRow(OWNER, 'greeting'));
    fire('onInsert', sdkRow(OWNER, 'second'));
    fire('onDelete', sdkRow(OWNER, 'greeting'));
    expect(store.ownConversation(OWNER)?.currentNodeId).toBe('second');
  });

  it('delete(old) then insert(new): the other delivery order lands the new node too', async () => {
    const store = await built();
    fire('onInsert', sdkRow(OWNER, 'greeting'));
    fire('onDelete', sdkRow(OWNER, 'greeting'));
    fire('onInsert', sdkRow(OWNER, 'second'));
    expect(store.ownConversation(OWNER)?.currentNodeId).toBe('second');
  });

  it('a real end (delete of the stored row) removes the conversation; others are untouched', async () => {
    const store = await built();
    fire('onInsert', sdkRow(OWNER, 'greeting'));
    fire('onInsert', sdkRow(OTHER, 'elsewhere'));
    fire('onDelete', sdkRow(OWNER, 'greeting'));
    expect(store.ownConversation(OWNER)).toBeUndefined();
    expect(store.ownConversation(OTHER)?.currentNodeId).toBe('elsewhere');
  });
});
