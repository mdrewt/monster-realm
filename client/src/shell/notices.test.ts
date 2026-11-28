// @vitest-environment happy-dom
// shell/notices — the request sets the world notices read, their owner functions, the notice input
// built from the store, the session and the views, the requests still waiting on an answer and the
// request line. Each test imports the module afresh (vi.resetModules + dynamic imports), with
// ./session, ./views and the resolver loaded in the same registry so they share its instances.
// The two private sets are read through `noticeInput()`: `opened`, and `dismissed`, which is the
// dismissed keys exactly while nothing is answered.
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  StoreBattleChallenge,
  StorePlayer,
  StoreTradeSession,
  StoreTradeSessionOffer,
} from '../net/store';
import type { ErrorOverlayView } from '../ui/errorOverlayView';
import type { EvolutionNoticeBanner } from '../ui/evolutionNotice';
import type { RequestNotice } from '../ui/noticeModel';

type NoticesModule = typeof import('./notices');

interface Loaded {
  readonly n: NoticesModule;
  readonly session: typeof import('./session');
  readonly views: typeof import('./views');
  readonly resolver: typeof import('../ui/i18n/resolver');
}

async function fresh(): Promise<Loaded> {
  vi.resetModules();
  const n = await import('./notices');
  const session = await import('./session');
  const views = await import('./views');
  const resolver = await import('../ui/i18n/resolver');
  return { n, session, views, resolver };
}

const EXPORTS = [
  'announcedRequests',
  'answeredRequests',
  'dismissRequest',
  'forgetClosedSession',
  'forgetOpenedSessions',
  'forgetRequests',
  'livePending',
  'markAnnounced',
  'markAnswered',
  'markSessionOpened',
  'noticeInput',
  'releaseAnswered',
  'requestLine',
];

const ME = 'a1'.repeat(32);
const PEER = 'b2'.repeat(32);
const OTHER = 'c3'.repeat(32);

const byBigint = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedKeys = (s: ReadonlySet<string>): string[] => [...s].sort();
const openedIds = (m: Loaded): bigint[] => [...m.n.noticeInput().opened].sort(byBigint);

/** The private dismissed set's members: every answered key is released for the read, so
 *  `noticeInput().dismissed` is the dismissed set alone, then answered again. */
function dismissedKeys(m: Loaded): string[] {
  const answered = [...m.n.answeredRequests];
  for (const key of answered) m.n.releaseAnswered(key)();
  const out = sortedKeys(m.n.noticeInput().dismissed);
  for (const key of answered) m.n.markAnswered(key);
  return out;
}

/** One distinct member in each of the four sets. */
function seed(m: Loaded): void {
  m.n.dismissRequest('session-1');
  m.n.markAnnounced('session-2');
  m.n.markAnswered('challenge-3');
  m.n.markSessionOpened(4n);
}

const EMPTY_OFFER: StoreTradeSessionOffer = { monsterIds: [], items: [], currency: 0n, cards: [] };

function tradeSession(
  sessionId: bigint,
  opener: string,
  partner: string,
  createdAtMs: bigint,
): StoreTradeSession {
  return {
    sessionId,
    opener,
    partner,
    openerOffer: EMPTY_OFFER,
    partnerOffer: EMPTY_OFFER,
    openerConfirmed: false,
    partnerConfirmed: false,
    revision: 1n,
    createdAtMs,
  };
}

function challenge(
  challengeId: bigint,
  challenger: string,
  target: string,
  createdAtMs: bigint,
): StoreBattleChallenge {
  return {
    challengeId,
    challenger,
    target,
    challengerPartyIds: [],
    status: 'Pending',
    createdAtMs,
  };
}

function player(identity: string, name: string, entityId: bigint): StorePlayer {
  return { identity, entityId, name, online: true, discriminator: 0, leadLevel: 1 };
}

/** The viewer ME with one incoming untouched trade from PEER (session 11, older) and one Pending
 *  challenge from OTHER (challenge 21), plus a session ME opened and a challenge aimed at OTHER. */
function seedRequests(m: Loaded): void {
  m.session.adoptIdentity(ME);
  m.session.store.upsertPlayer(player(PEER, 'Pia', 1n));
  m.session.store.upsertPlayer(player(OTHER, 'Oto', 2n));
  m.session.store.reconcileTradeSessionsFromView([
    tradeSession(11n, PEER, ME, 100n),
    tradeSession(12n, ME, OTHER, 50n),
  ]);
  m.session.store.upsertChallenge(challenge(21n, OTHER, ME, 200n));
  m.session.store.upsertChallenge(challenge(20n, PEER, OTHER, 10n));
}

const liveKeys = (m: Loaded): string[] => m.n.livePending().map((r) => r.key);

describe('shell/notices', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('exports exactly the thirteen owner names, with both request-set views typed read-only', async () => {
    // expectTypeOf is checked by tsc over the test files and does nothing at run time.
    expectTypeOf<NoticesModule['announcedRequests']>().toEqualTypeOf<ReadonlySet<string>>();
    expectTypeOf<NoticesModule['answeredRequests']>().toEqualTypeOf<ReadonlySet<string>>();
    expectTypeOf<keyof NoticesModule>().toEqualTypeOf<
      | 'announcedRequests'
      | 'answeredRequests'
      | 'markAnswered'
      | 'releaseAnswered'
      | 'dismissRequest'
      | 'markAnnounced'
      | 'forgetRequests'
      | 'markSessionOpened'
      | 'forgetOpenedSessions'
      | 'forgetClosedSession'
      | 'noticeInput'
      | 'livePending'
      | 'requestLine'
    >();
    const m = await fresh();
    expect(Object.keys(m.n).sort()).toEqual(EXPORTS);
  });

  it('a fresh module holds nothing announced, answered, dismissed or opened', async () => {
    const m = await fresh();
    expect(m.n.announcedRequests.size).toBe(0);
    expect(m.n.answeredRequests.size).toBe(0);
    expect(m.n.noticeInput().dismissed.size).toBe(0);
    expect(m.n.noticeInput().opened.size).toBe(0);
  });

  it('markAnswered adds its key to the answered set and leaves the other three as they were', async () => {
    const m = await fresh();
    seed(m);
    m.n.markAnswered('challenge-9');
    expect(sortedKeys(m.n.answeredRequests)).toEqual(['challenge-3', 'challenge-9']);
    expect(sortedKeys(m.n.announcedRequests)).toEqual(['session-2']);
    expect(openedIds(m)).toEqual([4n]);
    expect(dismissedKeys(m)).toEqual(['session-1']);
  });

  it('dismissRequest adds its key to the dismissed set and leaves the other three as they were', async () => {
    const m = await fresh();
    seed(m);
    m.n.dismissRequest('challenge-9');
    expect(dismissedKeys(m)).toEqual(['challenge-9', 'session-1']);
    expect(sortedKeys(m.n.answeredRequests)).toEqual(['challenge-3']);
    expect(sortedKeys(m.n.announcedRequests)).toEqual(['session-2']);
    expect(openedIds(m)).toEqual([4n]);
  });

  it('markAnnounced adds its key to the announced set and leaves the other three as they were', async () => {
    const m = await fresh();
    seed(m);
    m.n.markAnnounced('challenge-9');
    expect(sortedKeys(m.n.announcedRequests)).toEqual(['challenge-9', 'session-2']);
    expect(sortedKeys(m.n.answeredRequests)).toEqual(['challenge-3']);
    expect(openedIds(m)).toEqual([4n]);
    expect(dismissedKeys(m)).toEqual(['session-1']);
  });

  it('markSessionOpened adds its id to the opened set and leaves the three request sets as they were', async () => {
    const m = await fresh();
    seed(m);
    m.n.markSessionOpened(9n);
    expect(openedIds(m)).toEqual([4n, 9n]);
    expect(sortedKeys(m.n.announcedRequests)).toEqual(['session-2']);
    expect(sortedKeys(m.n.answeredRequests)).toEqual(['challenge-3']);
    expect(dismissedKeys(m)).toEqual(['session-1']);
  });

  it('releaseAnswered changes nothing until its thunk runs, which removes only that answered key', async () => {
    const m = await fresh();
    seed(m);
    m.n.markAnswered('challenge-9');
    const release = m.n.releaseAnswered('challenge-9');
    expect(typeof release).toBe('function');
    expect(sortedKeys(m.n.answeredRequests)).toEqual(['challenge-3', 'challenge-9']);
    release();
    expect(sortedKeys(m.n.answeredRequests)).toEqual(['challenge-3']);
    expect(sortedKeys(m.n.announcedRequests)).toEqual(['session-2']);
    expect(openedIds(m)).toEqual([4n]);
    expect(dismissedKeys(m)).toEqual(['session-1']);
  });

  it('forgetRequests empties the dismissed, announced and answered sets and keeps the opened one', async () => {
    const m = await fresh();
    seed(m);
    m.n.forgetRequests();
    expect(m.n.announcedRequests.size).toBe(0);
    expect(m.n.answeredRequests.size).toBe(0);
    expect(sortedKeys(m.n.noticeInput().dismissed)).toEqual([]);
    expect(openedIds(m)).toEqual([4n]);
  });

  it('forgetOpenedSessions empties the opened set and keeps the three request sets', async () => {
    const m = await fresh();
    seed(m);
    m.n.forgetOpenedSessions();
    expect(openedIds(m)).toEqual([]);
    expect(sortedKeys(m.n.announcedRequests)).toEqual(['session-2']);
    expect(sortedKeys(m.n.answeredRequests)).toEqual(['challenge-3']);
    expect(dismissedKeys(m)).toEqual(['session-1']);
  });

  it('forgetClosedSession removes the session id and its session key from every set, and keeps other ids and the same-numbered challenge key', async () => {
    const m = await fresh();
    m.n.markSessionOpened(7n);
    m.n.markSessionOpened(8n);
    for (const key of ['session-7', 'session-8', 'challenge-7']) {
      m.n.dismissRequest(key);
      m.n.markAnnounced(key);
      m.n.markAnswered(key);
    }
    m.n.forgetClosedSession(7n);
    expect(openedIds(m)).toEqual([8n]);
    expect(sortedKeys(m.n.announcedRequests)).toEqual(['challenge-7', 'session-8']);
    expect(sortedKeys(m.n.answeredRequests)).toEqual(['challenge-7', 'session-8']);
    // With the answered keys released, `dismissed` is the dismissed set alone.
    m.n.releaseAnswered('challenge-7')();
    m.n.releaseAnswered('session-8')();
    expect(sortedKeys(m.n.noticeInput().dismissed)).toEqual(['challenge-7', 'session-8']);
  });

  it('noticeInput carries the store rows and the adopted identity, empty before any', async () => {
    const m = await fresh();
    const before = m.n.noticeInput();
    expect(before.sessions).toEqual([]);
    expect(before.challenges).toEqual([]);
    expect(before.players).toEqual([]);
    expect(before.identity).toBe('');
    seedRequests(m);
    const after = m.n.noticeInput();
    expect(after.sessions).toEqual(m.session.store.allTradeSessions());
    expect(after.sessions.map((s) => s.sessionId)).toEqual([11n, 12n]);
    expect(after.challenges).toEqual(m.session.store.allChallenges());
    expect(after.challenges.map((c) => c.challengeId).sort(byBigint)).toEqual([20n, 21n]);
    expect(after.players).toEqual(m.session.store.allPlayers());
    expect(after.players.map((p) => p.identity).sort()).toEqual([PEER, OTHER].sort());
    expect(after.identity).toBe(ME);
  });

  it('noticeInput reads errorPending from the error overlay and evolutionPending from the evolution banner, false with neither mounted', async () => {
    const m = await fresh();
    const pending = () => {
      const i = m.n.noticeInput();
      return [i.errorPending, i.evolutionPending];
    };
    expect(pending()).toEqual([false, false]);
    const error = { visible: false };
    const evolution = { visible: false };
    m.views.mountViews({
      errorOverlayView: error as unknown as ErrorOverlayView,
      evolutionNoticeBanner: evolution as unknown as EvolutionNoticeBanner,
    });
    expect(pending()).toEqual([false, false]);
    error.visible = true;
    expect(pending()).toEqual([true, false]);
    error.visible = false;
    evolution.visible = true;
    expect(pending()).toEqual([false, true]);
    error.visible = true;
    expect(pending()).toEqual([true, true]);
    error.visible = false;
    evolution.visible = false;
    expect(pending()).toEqual([false, false]);
  });

  it('noticeInput.dismissed holds exactly the dismissed keys while nothing is answered', async () => {
    const m = await fresh();
    m.n.dismissRequest('session-1');
    m.n.dismissRequest('challenge-2');
    m.n.markAnnounced('session-5');
    expect(sortedKeys(m.n.noticeInput().dismissed)).toEqual(['challenge-2', 'session-1']);
  });

  it('noticeInput.dismissed holds the dismissed and answered keys together, without writing the answered ones into the dismissed set', async () => {
    const m = await fresh();
    m.n.dismissRequest('session-1');
    m.n.dismissRequest('challenge-2');
    m.n.markAnswered('challenge-9');
    expect(sortedKeys(m.n.noticeInput().dismissed)).toEqual([
      'challenge-2',
      'challenge-9',
      'session-1',
    ]);
    m.n.releaseAnswered('challenge-9')();
    expect(sortedKeys(m.n.noticeInput().dismissed)).toEqual(['challenge-2', 'session-1']);
  });

  it('noticeInput.opened holds exactly the sessions marked opened', async () => {
    const m = await fresh();
    m.n.markSessionOpened(3n);
    m.n.markSessionOpened(5n);
    m.n.markAnnounced('session-6');
    expect(openedIds(m)).toEqual([3n, 5n]);
  });

  it('livePending returns the incoming trade and the challenge aimed at the viewer, oldest first', async () => {
    const m = await fresh();
    seedRequests(m);
    expect(m.n.livePending().map((r) => [r.key, r.fromName])).toEqual([
      ['session-11', 'Pia'],
      ['challenge-21', 'Oto'],
    ]);
  });

  it('livePending leaves out an answered request', async () => {
    const m = await fresh();
    seedRequests(m);
    m.n.markAnswered('session-11');
    expect(liveKeys(m)).toEqual(['challenge-21']);
  });

  it('livePending still returns a dismissed request', async () => {
    const m = await fresh();
    seedRequests(m);
    m.n.dismissRequest('challenge-21');
    expect(liveKeys(m)).toEqual(['session-11', 'challenge-21']);
  });

  it('livePending leaves out a session whose editor was opened, and returns it once its answer is released while unopened', async () => {
    const m = await fresh();
    seedRequests(m);
    m.n.markAnswered('session-11');
    m.n.releaseAnswered('session-11')();
    expect(liveKeys(m)).toEqual(['session-11', 'challenge-21']);
    m.n.markSessionOpened(11n);
    expect(liveKeys(m)).toEqual(['challenge-21']);
  });

  describe('requestLine in English', () => {
    const notice = (over: Partial<RequestNotice>): RequestNotice => ({
      kind: 'request',
      key: 'session-5',
      request: 'trade',
      id: 5n,
      fromName: 'Pia',
      createdAtMs: 1n,
      ...over,
    });

    async function english(): Promise<Loaded> {
      const m = await fresh();
      m.resolver.setLocale('en');
      return m;
    }

    it('reads a challenge as its sender challenging the viewer to a battle', async () => {
      const m = await english();
      const line = m.n.requestLine(
        notice({ key: 'challenge-4', request: 'challenge', id: 4n, fromName: 'Oto' }),
      );
      expect(line).toBe('Oto challenges you to a battle');
    });

    it('reads a trade notice that stands for several requests as their count', async () => {
      const m = await english();
      const line = m.n.requestLine(
        notice({ count: 3, keys: ['session-5', 'session-6', 'session-7'] }),
      );
      expect(line).toBe('3 trade requests');
    });

    it('reads a single trade request as its sender wanting to trade', async () => {
      const m = await english();
      expect(m.n.requestLine(notice({}))).toBe('Pia wants to trade');
    });
  });
});
