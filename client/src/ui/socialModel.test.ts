// ui/socialModel.test.ts — ctl-8d (CTL8D.1, CTL8D.2): the Social frame's pure view model.
//
// Pure, node env. `buildSocialVm(requested, offers, challenges, identity)` lists the viewer's own
// trade and challenge rows out of the two PUBLIC tables, each with its legal actions in sheet
// order; `socialLayout(vm)` is the nav layout over the four tabs; `oldestWaiting(vm)` names the tab
// and the row of the oldest request the viewer has not answered.
//
// Identities: the viewer 'aa…', Bob 'bb…', Carol 'cc…'. Ids are distinct per row kind (trade 11,
// incoming challenge 21, outgoing challenge 22), so a swapped id or kind shows. Row keys:
// `trade-<tradeId>`, `challenge-<challengeId>`.
//
// The contract (plan "Functional core / imperative shell"):
//   trades       0..1 row: the offer the trade root shows (the viewer a party to it; the lowest
//                tradeId). Actions by role x status: counterparty/Pending accept, decline (waiting);
//                initiator/Pending cancel; initiator/ConfirmedByCounterparty confirm, cancel;
//                counterparty/ConfirmedByCounterparty cancel.
//   challenges   0..2 rows, incoming first: the oldest Pending challenge targeting the viewer (the
//                lowest challengeId) accept, decline (waiting); then the viewer's newest Pending
//                challenge (the highest challengeId) cancel.
//   waiting      only an incoming request the viewer has not answered. oldestWaiting compares the
//                rows' createdAtMs as bigints; a tie goes to the trade.
import { describe, expect, it } from 'vitest';
import type {
  StoreBattleChallenge,
  StoreCharacter,
  StorePlayer,
  StoreProfile,
  StoreTradeOffer,
} from '../net/store';
import { buildLeaderboardViewModel } from './leaderboardModel';
import type { NavLayout } from './nav';
import { buildPvpChallengeViewModel } from './pvpModel';
import type { SocialTab } from './screens/types';
import {
  buildSocialVm,
  NEARBY_TILES,
  oldestWaiting,
  SOCIAL_TABS,
  type SocialAction,
  type SocialPlayerRow,
  type SocialRow,
  type SocialVm,
  socialLayout,
  socialPeopleKey,
  socialPlayers,
  socialRows,
} from './socialModel';
import { buildTradeViewModel } from './tradeModel';

const ME = 'aa'.repeat(32);
const BOB = 'bb'.repeat(32);
const CAROL = 'cc'.repeat(32);

/** Every tab in the design's order, spelled here (never read from the module under test). */
const TABS: readonly SocialTab[] = ['players', 'trades', 'challenges', 'rankings'];

function offer(
  tradeId: bigint,
  initiator: string,
  counterparty: string,
  status: StoreTradeOffer['status'] = 'Pending',
  createdAtMs = 1_000n,
): StoreTradeOffer {
  return {
    tradeId,
    initiator,
    counterparty,
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status,
    createdAtMs,
  };
}

function challenge(
  challengeId: bigint,
  challenger: string,
  target: string,
  status = 'Pending',
  createdAtMs = 2_000n,
): StoreBattleChallenge {
  return { challengeId, challenger, target, challengerPartyIds: [], status, createdAtMs };
}

/** Bob offers trade 11 to the viewer: the viewer is the counterparty, so it is a waiting request. */
const TRADE_IN = offer(11n, BOB, ME, 'Pending', 1_000n);
/** Bob challenges the viewer (21, waiting); the viewer challenges Carol (22). */
const INCOMING = challenge(21n, BOB, ME, 'Pending', 2_000n);
const OUTGOING = challenge(22n, ME, CAROL, 'Pending', 3_000n);

/** ctl-8g (named intentional change): `buildSocialVm`'s fifth parameter, the people the Players and
 *  Rankings tabs list, is REQUIRED now. Every ctl-8d call site passes this empty world, so what
 *  those cases pin (the trade and challenge rows) is unchanged. */
const NO_PEOPLE = { players: [], characters: [], profiles: [] } as const;

/** The view model a plain open (no requested tab) builds for the viewer. */
const vmOf = (offers: StoreTradeOffer[], challenges: StoreBattleChallenge[]): SocialVm =>
  buildSocialVm(null, offers, challenges, ME, NO_PEOPLE);

/** A row with every field the contract names (matched as a subset: a row may carry more). */
const row = (
  key: string,
  kind: 'trade' | 'incoming' | 'outgoing',
  id: bigint,
  actions: readonly SocialAction[],
  waiting: boolean,
  createdAtMs: bigint,
) => ({ key, kind, id, actions, waiting, createdAtMs });

const keysOf = (rows: readonly SocialRow[]): readonly string[] => rows.map((r) => r.key);

/** The item keys of `tab` in a tabs layout. */
function itemKeys(layout: NavLayout, tab: SocialTab): readonly string[] {
  if (layout.kind !== 'tabs') throw new Error(`socialLayout is a ${layout.kind} layout, not tabs`);
  const found = layout.tabs.find((t) => t.key === tab);
  if (found === undefined) throw new Error(`socialLayout has no ${tab} tab`);
  return found.layout.items.map((i) => i.key);
}

describe('socialModel — the rows, the layout and the oldest waiting request (ctl-8d)', () => {
  it('CTL8D-1-MODEL-ROWS: SOCIAL_TABS is players, trades, challenges, rankings; buildSocialVm lists the viewer`s trade row and its challenge rows (incoming before outgoing) with their key, kind, id, actions, waiting flag and createdAtMs, ignoring another pair`s trade, a third party`s challenge and every non-Pending row; each row is the one its legacy root shows (the lowest tradeId, the oldest incoming, the newest outgoing); an empty store or identity lists nothing; requested passes through; socialLayout is the four tabs with the rows on Trades and Challenges', () => {
    // WRONG IMPL KILLED: tabs in another order or missing one; a trade row for another pair's
    // offer (it sorts first by id here) or for any offer in the table; a challenge row for a third
    // party's Pending challenge (first in store order here), for a Declined / Accepted challenge
    // aimed at the viewer or for the viewer's Cancelled one (each has an id the selection rule
    // would otherwise prefer); rows in store order (the outgoing one is stored first); keys that
    // are not `trade-<id>` / `challenge-<id>`; the trade's reject spelled `reject`; a waiting flag
    // on a row the viewer cannot answer; createdAtMs dropped or cast; an incoming row that is the
    // first in store order rather than the oldest (lowest id), or an outgoing one that is not the
    // newest (highest id), so the Social row and its root would show different requests; a throw
    // or a stray row on an empty store or an empty identity; a requested tab that is dropped or
    // rewritten; and a layout that is not tabs, puts rows on Players / Rankings, or loses one.
    expect(SOCIAL_TABS, 'the four tabs, in order').toEqual(TABS);

    // Another pair's trade sorts first by id; a third party's Pending challenge is first in store
    // order; the outgoing one is stored before the incoming one; three non-Pending rows involve
    // the viewer, each with an id that a selector without the status filter would pick.
    const offers = [offer(5n, BOB, CAROL), TRADE_IN];
    const challenges = [
      challenge(3n, BOB, CAROL),
      OUTGOING,
      challenge(4n, BOB, ME, 'Declined'),
      challenge(30n, ME, CAROL, 'Cancelled'),
      challenge(31n, CAROL, ME, 'Accepted'),
      INCOMING,
    ];
    const vm = buildSocialVm(null, offers, challenges, ME, NO_PEOPLE);
    expect(vm.requested, 'a plain open').toBeNull();
    expect(vm.trades, 'the viewer`s trade, never the other pair`s').toMatchObject([
      row('trade-11', 'trade', 11n, ['accept', 'decline'], true, 1_000n),
    ]);
    expect(vm.challenges, 'incoming first, then outgoing; nothing else').toMatchObject([
      row('challenge-21', 'incoming', 21n, ['accept', 'decline'], true, 2_000n),
      row('challenge-22', 'outgoing', 22n, ['cancel'], false, 3_000n),
    ]);

    // Two offers the viewer is a party to (TR-20 says it cannot happen), two challenges to it and
    // two from it, each pair stored in the order a first-match rule would get wrong: every row is
    // the one its legacy root shows, so A on a Social row acts on the block the player can see.
    const twoOffers = [offer(15n, ME, BOB), offer(12n, CAROL, ME)];
    const twoEach = [
      challenge(27n, CAROL, ME),
      challenge(25n, ME, BOB),
      challenge(21n, BOB, ME),
      challenge(22n, ME, CAROL),
    ];
    const both = vmOf(twoOffers, twoEach);
    expect(both.trades, 'the lowest tradeId the viewer is a party to').toMatchObject([
      row('trade-12', 'trade', 12n, ['accept', 'decline'], true, 1_000n),
    ]);
    expect(keysOf(both.challenges), 'the oldest incoming, then the newest outgoing').toEqual([
      'challenge-21',
      'challenge-25',
    ]);
    const tradeRoot = buildTradeViewModel(twoOffers, ME, new Map(), new Map());
    expect(
      tradeRoot.kind === 'trade' ? tradeRoot.tradeId : null,
      'the trade root shows that very offer',
    ).toBe(both.trades[0]?.id);
    const pvpRoot = buildPvpChallengeViewModel(twoEach, ME, []);
    expect(pvpRoot.incoming?.challengeId, 'the pvp root shows that very request').toBe(
      both.challenges[0]?.id,
    );
    expect(pvpRoot.outgoing?.challengeId, 'and that very outgoing challenge').toBe(
      both.challenges[1]?.id,
    );

    // An empty store, and an identity that is no party to anything, list nothing and never throw.
    expect(vmOf([], []), 'an empty store').toMatchObject({
      requested: null,
      trades: [],
      challenges: [],
    });
    expect(
      buildSocialVm(null, offers, challenges, '', NO_PEOPLE),
      'an empty identity',
    ).toMatchObject({
      trades: [],
      challenges: [],
    });
    expect(buildSocialVm(null, [], [], '', NO_PEOPLE), 'both').toMatchObject({
      trades: [],
      challenges: [],
    });

    // The requested tab passes through as given.
    for (const requested of [...TABS, null]) {
      expect(
        buildSocialVm(requested, offers, challenges, ME, NO_PEOPLE).requested,
        `requested ${String(requested)}`,
      ).toBe(requested);
    }

    // The layout: tabs over the four tabs, the rows on Trades and Challenges only.
    const layout = socialLayout(vm);
    expect(layout.kind, 'a tabs layout').toBe('tabs');
    expect(
      layout.kind === 'tabs' ? layout.tabs.map((t) => t.key) : [],
      'the four tabs, in order',
    ).toEqual(TABS);
    expect(itemKeys(layout, 'trades'), 'Trades: the trade row').toEqual(['trade-11']);
    expect(itemKeys(layout, 'challenges'), 'Challenges: incoming, then outgoing').toEqual([
      'challenge-21',
      'challenge-22',
    ]);
    expect(itemKeys(layout, 'players'), 'Players lists nothing yet (ctl-8g)').toEqual([]);
    expect(itemKeys(layout, 'rankings'), 'Rankings lists nothing yet (ctl-8g)').toEqual([]);
    const emptyLayout = socialLayout(vmOf([], []));
    for (const tab of TABS) {
      expect(itemKeys(emptyLayout, tab), `an empty store: ${tab} lists nothing`).toEqual([]);
    }

    // An offer in a status this client does not know (version skew: the row converter passes it
    // through raw) offers no action, so it is no row: the view model never throws (the host
    // builds it uncaught on every button), nothing waits and Trades lists nothing.
    // WRONG IMPL KILLED: a trade row with an empty sheet (or a throw) for an unknown status, and
    // such a row counted as a waiting request.
    const WEIRD = 'Weird' as StoreTradeOffer['status'];
    for (const [role, weird] of [
      ['the viewer as counterparty', offer(11n, BOB, ME, WEIRD)],
      ['the viewer as initiator', offer(11n, ME, BOB, WEIRD)],
    ] as const) {
      // Called directly: a throw fails the case.
      const skewed = vmOf([weird], [OUTGOING]);
      expect(skewed.trades, `${role}: an unknown status is no row`).toEqual([]);
      expect(keysOf(skewed.challenges), `${role}: the other rows stay`).toEqual(['challenge-22']);
      expect(oldestWaiting(skewed), `${role}: nothing waits`).toBeNull();
      expect(itemKeys(socialLayout(skewed), 'trades'), `${role}: Trades lists nothing`).toEqual([]);
    }

    // A Pending challenge from the viewer to the viewer (the server refuses it, but the table is
    // public data) is both the request and the sent challenge: it is ONE row, the request, and
    // the layout (whose nav kit throws on a duplicate key) builds.
    // WRONG IMPL KILLED: the guard in buildSocialVm removed (two rows under one key: the layout
    // throws, and so does every button through the host).
    const toSelf = vmOf([], [challenge(40n, ME, ME, 'Pending', 2_000n)]);
    expect(toSelf.challenges, 'one row, the request').toMatchObject([
      row('challenge-40', 'incoming', 40n, ['accept', 'decline'], true, 2_000n),
    ]);
    expect(() => socialLayout(toSelf), 'the layout builds').not.toThrow();
    expect(itemKeys(socialLayout(toSelf), 'challenges'), 'Challenges lists it once').toEqual([
      'challenge-40',
    ]);
  });

  it('CTL8D-1-MODEL-OLDEST-WAITING: oldestWaiting is null when nothing waits (an outgoing challenge, a trade the viewer sent, already accepted or must still confirm), the trade or the challenge when only it waits, the one with the smaller createdAtMs when both wait (in either order, with stamps past 2^53), and the trade on a tie', () => {
    // WRONG IMPL KILLED: a waiting rule that counts every listed row (the viewer's own outgoing
    // challenge, or a trade it sent, would open Social on it), or a trade awaiting the viewer's own
    // final Confirm (not a request: design section 4's notice kind); one that picks the NEWEST
    // request; one that compares Number(createdAtMs) (2^53 and 2^53 + 1 are one Number, so the
    // challenge-older order below reads as a tie and goes to the trade); a bigint subtraction in a
    // sort comparator (a TypeError on two bigints); a tie that goes to the challenge; and an
    // answer naming the wrong tab or key.
    expect(oldestWaiting(vmOf([], [])), 'an empty store').toBeNull();

    const NOT_WAITING: ReadonlyArray<readonly [string, StoreTradeOffer]> = [
      ['a trade the viewer sent', offer(11n, ME, BOB, 'Pending', 1n)],
      ['a trade the viewer already accepted', offer(11n, BOB, ME, 'ConfirmedByCounterparty', 1n)],
      [
        'a trade awaiting the viewer`s own Confirm',
        offer(11n, ME, BOB, 'ConfirmedByCounterparty', 1n),
      ],
    ];
    for (const [label, notWaiting] of NOT_WAITING) {
      const vm = vmOf([notWaiting], [challenge(22n, ME, CAROL, 'Pending', 0n)]);
      expect(
        keysOf([...vm.trades, ...vm.challenges]),
        `${label}: fixture: the trade and the outgoing challenge are listed`,
      ).toEqual(['trade-11', 'challenge-22']);
      expect(oldestWaiting(vm), `${label}, and an outgoing challenge: nothing waits`).toBeNull();
    }

    // Only the trade waits: an older outgoing challenge is listed too.
    expect(
      oldestWaiting(
        vmOf(
          [offer(11n, BOB, ME, 'Pending', 5_000n)],
          [challenge(22n, ME, CAROL, 'Pending', 100n)],
        ),
      ),
      'only the trade waits',
    ).toEqual({ tab: 'trades', key: 'trade-11' });
    // Only the challenge waits: an older trade the viewer sent and an older outgoing challenge are
    // listed too.
    expect(
      oldestWaiting(
        vmOf(
          [offer(11n, ME, BOB, 'Pending', 100n)],
          [challenge(22n, ME, CAROL, 'Pending', 100n), challenge(21n, BOB, ME, 'Pending', 5_000n)],
        ),
      ),
      'only the challenge waits',
    ).toEqual({ tab: 'challenges', key: 'challenge-21' });

    // Both wait: the smaller createdAtMs, in either order, with stamps no Number can tell apart.
    const BIG = 2n ** 53n;
    expect(Number(BIG) === Number(BIG + 1n), 'fixture: the two stamps are one Number').toBe(true);
    const bothWaiting = (tradeAt: bigint, challengeAt: bigint): SocialVm =>
      vmOf(
        [offer(11n, BOB, ME, 'Pending', tradeAt)],
        [challenge(21n, BOB, ME, 'Pending', challengeAt)],
      );
    expect(oldestWaiting(bothWaiting(BIG, BIG + 1n)), 'the trade is older').toEqual({
      tab: 'trades',
      key: 'trade-11',
    });
    expect(oldestWaiting(bothWaiting(BIG + 1n, BIG)), 'the challenge is older').toEqual({
      tab: 'challenges',
      key: 'challenge-21',
    });
    expect(oldestWaiting(bothWaiting(BIG + 3n, BIG + 3n)), 'a tie goes to the trade').toEqual({
      tab: 'trades',
      key: 'trade-11',
    });
  });

  it('CTL8D-2-MODEL-ACTIONS: each row offers its legal actions in sheet order: a trade by the viewer`s role and its status (counterparty/Pending accept, decline; initiator/Pending cancel; initiator/ConfirmedByCounterparty confirm, cancel; counterparty/ConfirmedByCounterparty cancel), an incoming challenge accept, decline and an outgoing one cancel; a row`s kind comes from the row, never from its position', () => {
    // WRONG IMPL KILLED: the role x status table mis-transcribed (a cell swapped, Confirm offered to
    // the counterparty, Accept offered to the initiator, Cancel missing on a confirmed offer);
    // `reject` passed through instead of `decline`; actions in another order (the sheet opens on
    // the FIRST: Accept for a request); a waiting flag on a trade the viewer cannot answer; and a
    // challenge kind chosen by position (the first challenge row read as incoming: an
    // outgoing-only list would offer Accept / Decline on the viewer's own challenge).
    const TRADE_CELLS: ReadonlyArray<
      readonly [string, StoreTradeOffer, readonly SocialAction[], boolean]
    > = [
      ['counterparty, Pending', offer(11n, BOB, ME, 'Pending'), ['accept', 'decline'], true],
      ['initiator, Pending', offer(11n, ME, BOB, 'Pending'), ['cancel'], false],
      [
        'initiator, ConfirmedByCounterparty',
        offer(11n, ME, BOB, 'ConfirmedByCounterparty'),
        ['confirm', 'cancel'],
        false,
      ],
      [
        'counterparty, ConfirmedByCounterparty',
        offer(11n, BOB, ME, 'ConfirmedByCounterparty'),
        ['cancel'],
        false,
      ],
    ];
    for (const [label, cell, actions, waiting] of TRADE_CELLS) {
      expect(vmOf([cell], []).trades, label).toMatchObject([
        row('trade-11', 'trade', 11n, actions, waiting, 1_000n),
      ]);
    }

    expect(vmOf([], [INCOMING, OUTGOING]).challenges, 'both challenge rows').toMatchObject([
      row('challenge-21', 'incoming', 21n, ['accept', 'decline'], true, 2_000n),
      row('challenge-22', 'outgoing', 22n, ['cancel'], false, 3_000n),
    ]);
    // Alone, each row keeps its own kind and actions.
    expect(vmOf([], [OUTGOING]).challenges, 'the outgoing row alone').toMatchObject([
      row('challenge-22', 'outgoing', 22n, ['cancel'], false, 3_000n),
    ]);
    expect(vmOf([], [INCOMING]).challenges, 'the incoming row alone').toMatchObject([
      row('challenge-21', 'incoming', 21n, ['accept', 'decline'], true, 2_000n),
    ]);
  });
});

// ==========================================================================================
// ctl-8g (CTL8G.1, CTL8G.2): the Players and Rankings tabs' rows.
//
// `socialPlayers(players, characters, identity)` lists the OTHER online players, each with the
// name to show and a `nearby` flag (the same zone and |dx| + |dy| <= NEARBY_TILES = 12, Manhattan);
// `buildSocialVm(..., people)` carries them as `vm.players` and the ranked rows as `vm.rankings`;
// `socialLayout` keys the Players tab by identity hex and the Rankings tab by the ranked identity
// hex in leaderboard order; `socialPeopleKey(vm)` is a signature of `vm.players` (the screen's
// change-detection key). The ZONE NAME clause of CTL8G.1 is DEFERRED (no client source of zone
// names), so nothing here asserts one.
//
// Fixture world: the viewer ME 'aa…' (entity 1) stands at (50, 50) in zone 0 unless a case moves
// it. Each other player's entity id is distinct, so a character looked up by the wrong id shows.
// ==========================================================================================

const ME_EID = 1n;
const DAN = 'dd'.repeat(32);
const EVE = 'ee'.repeat(32);

function person(
  identity: string,
  name: string,
  entityId: bigint,
  online = true,
  lastInputSeq = 0n,
): StorePlayer {
  return { identity, name, entityId, online, lastInputSeq };
}

function at(entityId: bigint, tileX: number, tileY: number, zoneId = 0): StoreCharacter {
  return {
    entityId,
    zoneId,
    tileX,
    tileY,
    facing: 'South',
    action: 'Idle',
    moveStartedAtMs: 0n,
    moveQueue: [],
  };
}

const profile = (
  identity: string,
  name: string,
  rating: number,
  wins = 0,
  losses = 0,
): StoreProfile => ({ identity, name, rating, wins, losses });

/** The row's `{ key, name, nearby }`, nothing else (a row may carry more). */
const brief = (rows: readonly SocialPlayerRow[]) =>
  rows.map((r) => ({ key: r.key, name: r.name, nearby: r.nearby }));

const keysOfPlayers = (rows: readonly SocialPlayerRow[]): readonly string[] =>
  rows.map((r) => r.key);

/** The items of `tab` in a tabs layout, with their enabled flag. */
function itemsOf(
  layout: NavLayout,
  tab: SocialTab,
): readonly { readonly key: string; readonly enabled: boolean }[] {
  if (layout.kind !== 'tabs') throw new Error(`socialLayout is a ${layout.kind} layout, not tabs`);
  const found = layout.tabs.find((t) => t.key === tab);
  if (found === undefined) throw new Error(`socialLayout has no ${tab} tab`);
  return found.layout.items.map((i) => ({ key: i.key, enabled: i.enabled }));
}

/** The viewer at (x, y) in `zone`, and one other player BOB at (bx, by) in `bzone`. */
function pair(
  me: readonly [number, number],
  bob: readonly [number, number],
  zones: readonly [number, number] = [0, 0],
): readonly SocialPlayerRow[] {
  return socialPlayers(
    [person(ME, 'Me', ME_EID), person(BOB, 'Bob', 2n)],
    [at(ME_EID, me[0], me[1], zones[0]), at(2n, bob[0], bob[1], zones[1])],
    ME,
  );
}

describe('socialModel — the Players and Rankings rows (ctl-8g)', () => {
  it('CTL8G-1-NEARBY-CONST: NEARBY_TILES is the number 12, and it only marks a badge: a player a thousand tiles away, or in another zone, is still listed', () => {
    // WRONG IMPL KILLED: a constant of another value (10, 16: the 12/13 boundary below then moves
    // with it, but this pin names the spec's number); a string or bigint constant; and a distance
    // that FILTERS the list (CTL8G.1: "gates nothing") instead of only setting `nearby`.
    expect(NEARBY_TILES).toBe(12);
    expect(typeof NEARBY_TILES).toBe('number');
    const far = pair([50, 50], [1050, 1050]);
    expect(brief(far), 'a thousand tiles away: listed, not nearby').toEqual([
      { key: BOB, name: 'Bob', nearby: false },
    ]);
    const elsewhere = pair([50, 50], [50, 50], [0, 9]);
    expect(brief(elsewhere), 'another zone: listed, not nearby').toEqual([
      { key: BOB, name: 'Bob', nearby: false },
    ]);
    // The same through buildSocialVm: the vm carries the same rows.
    const vm = buildSocialVm(null, [], [], ME, {
      players: [person(ME, 'Me', ME_EID), person(BOB, 'Bob', 2n)],
      characters: [at(ME_EID, 50, 50), at(2n, 1050, 1050)],
      profiles: [],
    });
    expect(brief(vm.players)).toEqual([{ key: BOB, name: 'Bob', nearby: false }]);
  });

  it('CTL8G-1-ONLINE-ONLY: only online players are listed, never the viewer (by identity, whatever its name or entity), another player who shares the viewer`s name is still listed, an empty identity excludes nobody, and an empty store lists nothing', () => {
    // WRONG IMPL KILLED: an offline player listed (the row of someone who logged out); the
    // viewer's own row listed (a player could "walk up" to themselves); self excluded by NAME
    // (another player called Me vanishes) or by entity id; self excluded only when it is the first
    // row; and a throw on an empty store or an empty identity (the host builds the vm uncaught on
    // every button).
    const me = person(ME, 'Me', ME_EID);
    const rows = socialPlayers(
      [
        person(BOB, 'Bob', 2n, false),
        me,
        person(CAROL, 'Carol', 3n, true),
        person(DAN, 'Me', 4n, true),
        person(EVE, 'Eve', 5n, false),
      ],
      [at(ME_EID, 50, 50), at(2n, 50, 51), at(3n, 50, 52), at(4n, 50, 53), at(5n, 50, 54)],
      ME,
    );
    expect(brief(rows), 'Carol and the other Me, in name order; no offline, no self').toEqual([
      { key: CAROL, name: 'Carol', nearby: true },
      { key: DAN, name: 'Me', nearby: true },
    ]);

    // Self last, self with a name no one else has, self on another entity id than its character.
    const selfLast = socialPlayers(
      [person(CAROL, 'Carol', 3n), person(ME, 'Zzz-self', 99n)],
      [at(3n, 50, 50)],
      ME,
    );
    expect(keysOfPlayers(selfLast), 'self last').toEqual([CAROL]);

    expect(socialPlayers([], [], ME), 'an empty store').toEqual([]);
    expect(socialPlayers([person(ME, 'Me', ME_EID)], [at(ME_EID, 1, 1)], ME), 'only self').toEqual(
      [],
    );
    expect(socialPlayers([person(BOB, 'Bob', 2n, false)], [], ME), 'only an offline one').toEqual(
      [],
    );
    // An empty identity (before onReady) is nobody's: every online player is listed, none nearby.
    expect(
      brief(socialPlayers([person(BOB, 'Bob', 2n), person(CAROL, 'Carol', 3n)], [], '')),
      'an empty identity',
    ).toEqual([
      { key: BOB, name: 'Bob', nearby: false },
      { key: CAROL, name: 'Carol', nearby: false },
    ]);
  });

  it('CTL8G-1-NEARBY: nearby is the same zone and |dx| + |dy| <= 12 (Manhattan, either direction, any coordinates): (12, 0) and (6, 6) are nearby, (13, 0), (6, 7) and (7, 7) are not; a different zone at distance 0 is not, a same non-zero zone is; with no own character nobody is nearby, a player with no character is listed and not nearby; a one-shot iterator of characters gives the same rows', () => {
    // WRONG IMPL KILLED: Chebyshev distance (max(|dx|, |dy|) <= 12: (7, 7) wrongly nearby);
    // Euclidean distance (sqrt: (8, 8) at 11.3 wrongly nearby); a per-axis box; `<` for `<=` (12
    // not nearby) or `<= 13`; a signed difference (a player WEST or NORTH of the viewer never
    // nearby, since dx < 0 <= 12 would be nearby under `dx + dy <= 12`: (-20, 0) must not be);
    // the zone ignored (same tile, other zone, listed nearby); the zone compared to 0 (a viewer in
    // zone 3 with a neighbour in zone 3 not nearby); a viewer-at-the-origin assumption; nearby for
    // everyone when the viewer has no character (undefined coordinates compare false only by
    // luck: here NaN distances must read false); a throw or a dropped row for a player with no
    // character; and an impl that walks `characters` twice (a one-shot iterator is spent after the
    // first pass).
    const ORIGIN = [50, 50] as const;
    const OFFSETS: ReadonlyArray<readonly [number, number, boolean]> = [
      [0, 0, true],
      [12, 0, true],
      [13, 0, false],
      [0, 12, true],
      [0, 13, false],
      [-12, 0, true],
      [-13, 0, false],
      [0, -12, true],
      [0, -13, false],
      [6, 6, true],
      [6, 7, false],
      [7, 5, true],
      [7, 6, false],
      [7, 7, false],
      [8, 8, false],
      [-6, -6, true],
      [-7, -6, false],
      [-7, 5, true],
      [5, -7, true],
      [-20, 0, false],
      [0, -40, false],
    ];
    let checked = 0;
    for (const [dx, dy, nearby] of OFFSETS) {
      const rows = pair(ORIGIN, [ORIGIN[0] + dx, ORIGIN[1] + dy]);
      expect(brief(rows), `offset (${dx}, ${dy})`).toEqual([{ key: BOB, name: 'Bob', nearby }]);
      checked += 1;
    }
    // The same offsets with the viewer far from the origin: only the difference matters.
    for (const [dx, dy, nearby] of OFFSETS) {
      const rows = pair([200, 300], [200 + dx, 300 + dy]);
      expect(brief(rows), `viewer at (200, 300), offset (${dx}, ${dy})`).toEqual([
        { key: BOB, name: 'Bob', nearby },
      ]);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: 21 offsets at two viewer positions').toBe(42);

    // The zone: same tile in another zone is not nearby; the same non-zero zone is; the viewer in
    // a non-zero zone with a neighbour in zone 0 is not.
    expect(pair([50, 50], [50, 50], [0, 1])[0]?.nearby, 'same tile, zone 1 vs 0').toBe(false);
    expect(pair([50, 50], [50, 50], [3, 3])[0]?.nearby, 'same non-zero zone').toBe(true);
    expect(pair([50, 50], [50, 50], [3, 0])[0]?.nearby, 'viewer in zone 3, other in zone 0').toBe(
      false,
    );
    expect(pair([50, 50], [51, 50], [0, 3])[0]?.nearby, 'next tile, zone 3').toBe(false);

    // No own character: listed, none nearby, even on the same tile. Two ways to have none: a
    // player row with no character, and no player row at all for the viewer.
    const noOwnChar = socialPlayers(
      [person(ME, 'Me', ME_EID), person(BOB, 'Bob', 2n)],
      [at(2n, 50, 50)],
      ME,
    );
    expect(brief(noOwnChar), 'the viewer has no character').toEqual([
      { key: BOB, name: 'Bob', nearby: false },
    ]);
    const noOwnRow = socialPlayers([person(BOB, 'Bob', 2n)], [at(2n, 50, 50), at(9n, 50, 50)], ME);
    expect(brief(noOwnRow), 'the viewer has no player row').toEqual([
      { key: BOB, name: 'Bob', nearby: false },
    ]);
    // A listed player with no character row is listed and not nearby; its neighbour still is.
    const mixed = socialPlayers(
      [person(ME, 'Me', ME_EID), person(BOB, 'Bob', 2n), person(CAROL, 'Carol', 3n)],
      [at(ME_EID, 50, 50), at(3n, 50, 55)],
      ME,
    );
    expect(brief(mixed), 'Bob has no character, Carol is five tiles away').toEqual([
      { key: BOB, name: 'Bob', nearby: false },
      { key: CAROL, name: 'Carol', nearby: true },
    ]);

    // A one-shot iterator of characters (the store hands out an iterator): spent after one pass.
    const players = [
      person(ME, 'Me', ME_EID),
      person(BOB, 'Bob', 2n),
      person(CAROL, 'Carol', 3n),
      person(DAN, 'Dan', 4n),
    ];
    const chars = [at(ME_EID, 50, 50), at(2n, 50, 62), at(3n, 50, 63), at(4n, 38, 50)];
    function* oneShot(): Generator<StoreCharacter> {
      yield* chars;
    }
    const fromArray = socialPlayers(players, chars, ME);
    const fromIterator = socialPlayers(players, oneShot(), ME);
    expect(brief(fromArray), 'fixture: 12 yes, 13 no, 12 west yes').toEqual([
      { key: BOB, name: 'Bob', nearby: true },
      { key: CAROL, name: 'Carol', nearby: false },
      { key: DAN, name: 'Dan', nearby: true },
    ]);
    expect(brief(fromIterator), 'a one-shot iterator gives the same rows').toEqual(
      brief(fromArray),
    );
    // And through buildSocialVm, which receives the same iterator.
    const vm = buildSocialVm(null, [], [], ME, {
      players,
      characters: oneShot(),
      profiles: [],
    });
    expect(brief(vm.players), 'buildSocialVm with a one-shot iterator').toEqual(brief(fromArray));
  });

  it('CTL8G-1-ORDER: rows are in raw name order by code unit then identity order, never nearby-first, and the order does not depend on the input order: Zed before abe, an empty name first (its #hex8 fallback is not the sort key), a surrogate pair before U+FF5E, equal names by identity', () => {
    // WRONG IMPL KILLED: localeCompare / Intl (abe before Zed); a sort by the DISPLAY name (the
    // empty-named player's `#bbbbbbbb` sorts after `!Bang`, but the raw '' sorts before it); code
    // POINT order (the emoji, U+1F600, after U+FF5E; code units say before); nearby players first
    // (the rows would jump as the viewer walks: stable order is the point); equal names left in
    // input order (a tie-break absent or on the wrong end); a mutating sort of the caller's array;
    // and an order that follows the player or character input order.
    const WIDE = String.fromCharCode(0xff5e);
    const EMOJI = String.fromCodePoint(0x1f600);
    const me = person(ME, 'Me', ME_EID);
    const others: readonly StorePlayer[] = [
      person(BOB, '', 2n),
      person(CAROL, 'Zed', 3n),
      person(DAN, 'abe', 4n),
      person(EVE, '!Bang', 5n),
      person('ff'.repeat(32), 'Sam', 6n),
      person('11'.repeat(32), 'Sam', 7n),
      person('22'.repeat(32), WIDE, 8n),
      person('33'.repeat(32), EMOJI, 9n),
    ];
    const characters = [
      at(ME_EID, 50, 50),
      // Zed is the only one nearby: a nearby-first order would put it at the top.
      at(3n, 50, 50),
      at(4n, 50, 90),
      at(5n, 90, 90),
    ];
    const rows = socialPlayers([me, ...others], characters, ME);
    expect(
      rows.map((r) => [r.key.slice(0, 2), r.name, r.nearby]),
      'raw name by code unit: "", !Bang, Sam (11 then ff), Zed, abe, the emoji, U+FF5E',
    ).toEqual([
      ['bb', `#${BOB.slice(0, 8)}`, false],
      ['ee', '!Bang', false],
      ['11', 'Sam', false],
      ['ff', 'Sam', false],
      ['cc', 'Zed', true],
      ['dd', 'abe', false],
      ['33', EMOJI, false],
      ['22', WIDE, false],
    ]);
    expect(rows[0]?.name, 'the empty name shows as # and the first eight hex digits').toBe(
      '#bbbbbbbb',
    );

    // Every rotation and the reverse of the player and character inputs: the same rows.
    const want = brief(rows);
    const all = [me, ...others];
    for (let k = 1; k < all.length; k++) {
      const rotated = [...all.slice(k), ...all.slice(0, k)];
      expect(
        brief(socialPlayers(rotated, [...characters].reverse(), ME)),
        `rotated by ${k}`,
      ).toEqual(want);
    }
    expect(brief(socialPlayers([...all].reverse(), characters, ME)), 'reversed').toEqual(want);

    // The caller's arrays are not sorted in place.
    const input = [...all].reverse();
    const snapshot = input.map((p) => p.identity);
    socialPlayers(input, characters, ME);
    expect(
      input.map((p) => p.identity),
      'the input array is untouched',
    ).toEqual(snapshot);

    // Equal names, both orders of input: the lower identity first.
    const twins = [person(CAROL, 'Sam', 3n), person(BOB, 'Sam', 2n)];
    expect(keysOfPlayers(socialPlayers(twins, [], ME)), 'twins: identity asc').toEqual([
      BOB,
      CAROL,
    ]);
    expect(keysOfPlayers(socialPlayers([...twins].reverse(), [], ME)), 'twins, reversed').toEqual([
      BOB,
      CAROL,
    ]);
  });

  it('CTL8G-1-LAYOUT: socialLayout keys the Players tab by the players` identity hex in row order, every row enabled, while socialRows stays empty for Players (A never opens a sheet) and the other tabs keep their rows', () => {
    // WRONG IMPL KILLED: a Players tab left empty; keys that are not the identity hex (the entity
    // id, the name, an index: two players with one name would collide in the nav kit); keys in
    // input order rather than row order; a disabled row (the cursor would skip it); Players rows
    // returned by `socialRows` (the screen would open a trade sheet on a player); and the trade and
    // challenge keys lost when people are listed.
    const vm = buildSocialVm(null, [TRADE_IN], [INCOMING, OUTGOING], ME, {
      players: [
        person(ME, 'Me', ME_EID),
        person(DAN, 'Sam', 4n),
        person(BOB, 'Sam', 2n),
        person(CAROL, 'Abe', 3n, false),
        person(EVE, 'Zed', 5n),
      ],
      characters: [at(ME_EID, 50, 50), at(4n, 50, 51)],
      profiles: [],
    });
    expect(
      keysOfPlayers(vm.players),
      'Sam (bb), Sam (dd), Zed; offline Abe and self absent',
    ).toEqual([BOB, DAN, EVE]);
    const layout = socialLayout(vm);
    expect(itemsOf(layout, 'players')).toEqual([
      { key: BOB, enabled: true },
      { key: DAN, enabled: true },
      { key: EVE, enabled: true },
    ]);
    expect(socialRows(vm, 'players'), 'no actionable row on Players').toEqual([]);
    expect(socialRows(vm, 'rankings'), 'no actionable row on Rankings').toEqual([]);
    expect(itemKeys(layout, 'trades'), 'Trades keeps its row').toEqual(['trade-11']);
    expect(itemKeys(layout, 'challenges'), 'Challenges keeps its rows').toEqual([
      'challenge-21',
      'challenge-22',
    ]);
    expect(
      layout.kind === 'tabs' ? layout.tabs.map((t) => t.key) : [],
      'the four tabs, in order',
    ).toEqual(TABS);
    // No players: an empty Players tab.
    expect(itemsOf(socialLayout(vmOf([], [])), 'players')).toEqual([]);
  });

  it('CTL8G-1-PEOPLE-KEY: socialPeopleKey is equal for equal rows built twice and differs for a changed name, a nearby flip, a joined or left player, a swapped order and a changed identity; it ignores the other tabs` rows; and no choice of separators in a name makes two different row lists collide', () => {
    // WRONG IMPL KILLED: a key built from the vm object's identity (every fresh vm differs: the
    // screen would repaint on every batch); one that drops nearby (a player crossing the 12-tile
    // line never repaints), the name (a rename never repaints) or the order; one that reads the
    // whole vm (a trade arriving changes it: a repaint per unrelated batch); one over the
    // player's count only; and a naive delimiter join, where a name carrying the delimiters forges
    // another list's key (stale rows kept under a "no change").
    const base: {
      players: StorePlayer[];
      characters: StoreCharacter[];
      profiles: StoreProfile[];
    } = {
      players: [person(ME, 'Me', ME_EID), person(BOB, 'Bob', 2n), person(CAROL, 'Carol', 3n)],
      characters: [at(ME_EID, 50, 50), at(2n, 50, 55), at(3n, 50, 70)],
      profiles: [],
    };
    const build = (over: Partial<typeof base> = {}, offers: StoreTradeOffer[] = []): SocialVm =>
      buildSocialVm(null, offers, [], ME, { ...base, ...over });
    const key = (over: Partial<typeof base> = {}, offers: StoreTradeOffer[] = []): string =>
      socialPeopleKey(build(over, offers));

    const k0 = key();
    expect(typeof k0).toBe('string');
    expect(key(), 'rebuilt from fresh rows').toBe(k0);
    expect(
      socialPeopleKey({ ...build(), players: build().players.map((r) => ({ ...r })) }),
      'copied row objects',
    ).toBe(k0);
    expect(key({}, [TRADE_IN]), 'a trade arriving is not a people change').toBe(k0);
    expect(
      key({ profiles: [profile(BOB, 'Bob', 1200)] }),
      'a ranking row is not a people change',
    ).toBe(k0);

    const changes: ReadonlyArray<readonly [string, string]> = [
      [
        'a rename',
        key({
          players: [
            base.players[0] as StorePlayer,
            person(BOB, 'Bobby', 2n),
            base.players[2] as StorePlayer,
          ],
        }),
      ],
      ['Bob walks off', key({ characters: [at(ME_EID, 50, 50), at(2n, 50, 70), at(3n, 50, 70)] })],
      ['Carol walks up', key({ characters: [at(ME_EID, 50, 50), at(2n, 50, 55), at(3n, 50, 60)] })],
      [
        'Carol leaves',
        key({ players: [base.players[0] as StorePlayer, base.players[1] as StorePlayer] }),
      ],
      ['Dan joins', key({ players: [...base.players, person(DAN, 'Dan', 4n)] })],
      [
        'Bob and Carol swap identities',
        key({
          players: [
            base.players[0] as StorePlayer,
            person(CAROL, 'Bob', 2n),
            person(BOB, 'Carol', 3n),
          ],
        }),
      ],
    ];
    for (const [what, changed] of changes) {
      expect(changed, what).not.toBe(k0);
    }
    expect(
      new Set([k0, ...changes.map(([, c]) => c)]).size,
      'every change differs from every other',
    ).toBe(changes.length + 1);
    // Going offline lists the same rows as leaving: the same key (the signature is of the rows).
    expect(
      key({
        players: [
          base.players[0] as StorePlayer,
          base.players[1] as StorePlayer,
          person(CAROL, 'Carol', 3n, false),
        ],
      }),
      'Carol goes offline: the rows of Carol leaving',
    ).toBe(changes[3]?.[1]);

    // Order: the same rows, swapped, by hand (socialPlayers always sorts).
    const rowsAB: readonly SocialPlayerRow[] = [
      { key: 'a', name: 'x', nearby: false },
      { key: 'b', name: 'y', nearby: true },
    ];
    const withRows = (players: readonly SocialPlayerRow[]): SocialVm => ({ ...build(), players });
    expect(socialPeopleKey(withRows([...rowsAB].reverse())), 'swapped order').not.toBe(
      socialPeopleKey(withRows(rowsAB)),
    );
    expect(socialPeopleKey(withRows([])), 'empty').not.toBe(socialPeopleKey(withRows(rowsAB)));

    // Nothing is truncated: a rename that differs only after the eighth character, and two full
    // 64-character identities that differ only in their last character, each change the key.
    // WRONG IMPL KILLED: a key built from `name.slice(0, 8)` or `key.slice(0, 8)` (the `#hex8`
    // display length): a long name edited past its eighth character, or two players whose identity
    // hexes share a long prefix, would read as "no change" and keep stale rows.
    const renameKey = (name: string): string =>
      key({
        players: [
          base.players[0] as StorePlayer,
          person(BOB, name, 2n),
          base.players[2] as StorePlayer,
        ],
      });
    expect(renameKey('Alexander1'), 'Alexander1 -> Alexander2').not.toBe(renameKey('Alexander2'));
    expect(renameKey('Alexander'), 'a name extended past eight characters').not.toBe(
      renameKey('Alexander1'),
    );
    const LONG_PREFIX = 'ab'.repeat(31);
    const HEX_A = `${LONG_PREFIX}c0`;
    const HEX_B = `${LONG_PREFIX}c1`;
    expect(HEX_A.length, 'fixture: a full 64-character identity').toBe(64);
    expect(HEX_A.slice(0, 63), 'fixture: they differ only in the last character').toBe(
      HEX_B.slice(0, 63),
    );
    const twinRows = (first: string, second: string): readonly SocialPlayerRow[] => [
      { key: first, name: 'twin', nearby: false },
      { key: second, name: 'twin', nearby: false },
    ];
    expect(
      socialPeopleKey(withRows(twinRows(HEX_A, HEX_B))),
      'two identities that differ only in the last character, swapped',
    ).not.toBe(socialPeopleKey(withRows(twinRows(HEX_B, HEX_A))));
    expect(
      socialPeopleKey(withRows(twinRows(HEX_A, HEX_B))),
      'a different last character is a different list',
    ).not.toBe(socialPeopleKey(withRows(twinRows(HEX_A, HEX_A.slice(0, 63) + '2'))));
    // The same through socialPlayers: two unnamed players share the `#abababab` display name, so
    // only the full identity (and the nearby flag riding on it) tells which of them walked up.
    const twinsVm = (nearEntity: bigint): string =>
      key({
        players: [base.players[0] as StorePlayer, person(HEX_A, '', 20n), person(HEX_B, '', 21n)],
        characters: [
          at(ME_EID, 50, 50),
          at(nearEntity, 50, 51),
          at(nearEntity === 20n ? 21n : 20n, 50, 90),
        ],
      });
    expect(twinsVm(20n), 'the first twin walks up').not.toBe(twinsVm(21n));

    // Delimiter forgery: a one-row list whose name spells out another list's whole encoding under
    // an assumed `key<in>name<in>nearby` joined by `<out>` format, for each pair of common
    // separators and each spelling of the boolean.
    const NUL = String.fromCharCode(0);
    const SEPS = [',', '|', ':', ';', ' ', '\n', '\t', '/', '#', '=', '&', '-', '.', '_', NUL];
    const BOOLS: ReadonlyArray<readonly [string, string]> = [
      ['false', 'true'],
      ['0', '1'],
      ['F', 'T'],
      ['n', 'y'],
    ];
    let forged = 0;
    for (const inner of SEPS) {
      for (const outer of SEPS) {
        for (const [no, yes] of BOOLS) {
          const honest: readonly SocialPlayerRow[] = [
            { key: 'a', name: 'b', nearby: false },
            { key: 'c', name: 'd', nearby: true },
          ];
          const hostile: readonly SocialPlayerRow[] = [
            {
              key: 'a',
              name: `b${inner}${no}${outer}c${inner}d`,
              nearby: true,
            },
          ];
          // `yes` is the honest second row's boolean in this format; the hostile row's own boolean
          // is the same token, so the naive join of both reads the same.
          expect(
            socialPeopleKey(withRows(hostile)),
            `a name forging two rows (${JSON.stringify(inner)} in, ${JSON.stringify(outer)} out, ${no}/${yes})`,
          ).not.toBe(socialPeopleKey(withRows(honest)));
          forged += 1;
        }
      }
    }
    expect(forged, 'ANTI-VACUITY: 15 x 15 x 4 forgeries tried').toBe(900);
  });

  it('CTL8G-2-LAYOUT: vm.rankings is the leaderboard`s rows (rating desc, raw name asc, identity asc, the #hex8 fallback and the own flag) in any input order, socialLayout keys the Rankings tab by the ranked identity hex in that order, every row enabled, and the Players tab is independent of the profiles', () => {
    // WRONG IMPL KILLED: a second comparator in socialModel (the leaderboard's own order is the one
    // the legacy root shows: a drift would rank the same player differently on the two screens); a
    // sort by name first or by rating asc; the display fallback as the sort key; keys that are not
    // the identity hex; a Rankings tab left empty; rankings in input order; the own flag lost; an
    // unranked online player (no profile) listed on Rankings, or a ranked offline one dropped; and
    // profiles leaking into the Players rows.
    const profiles: readonly StoreProfile[] = [
      profile(CAROL, 'Carol', 1000, 3, 4),
      profile(BOB, 'Bob', 1200, 10, 2),
      profile(ME, 'Me', 1000, 5, 5),
      profile(DAN, '', 1000, 0, 1),
      profile(EVE, 'Abe', 1000, 1, 1),
    ];
    const vm = buildSocialVm(null, [], [], ME, {
      players: [
        person(ME, 'Me', ME_EID),
        person(BOB, 'Bob', 2n),
        person('77'.repeat(32), 'Zoe', 8n),
      ],
      characters: [],
      profiles,
    });
    const legacy = buildLeaderboardViewModel(profiles, ME).rows;
    expect(vm.rankings, 'the leaderboard model`s rows, verbatim').toEqual(legacy);
    expect(
      vm.rankings.map((r) => r.identityHex),
      'Bob 1200; then 1000: "" (raw name sorts first), Abe, Carol, Me',
    ).toEqual([BOB, DAN, EVE, CAROL, ME]);
    expect(vm.rankings[1]?.displayName, 'the empty name shows as #hex8').toBe('#dddddddd');
    expect(vm.rankings.filter((r) => r.isOwn).map((r) => r.identityHex)).toEqual([ME]);

    const layout = socialLayout(vm);
    expect(itemsOf(layout, 'rankings')).toEqual([
      { key: BOB, enabled: true },
      { key: DAN, enabled: true },
      { key: EVE, enabled: true },
      { key: CAROL, enabled: true },
      { key: ME, enabled: true },
    ]);
    expect(keysOfPlayers(vm.players), 'Players is not the profile list').toEqual([
      BOB,
      '77'.repeat(32),
    ]);

    // Any input order of the profiles: the same ranking.
    for (const shuffled of [
      [...profiles].reverse(),
      [...profiles.slice(2), ...profiles.slice(0, 2)],
    ]) {
      const again = buildSocialVm(null, [], [], ME, {
        players: [],
        characters: [],
        profiles: shuffled,
      });
      expect(again.rankings.map((r) => r.identityHex)).toEqual([BOB, DAN, EVE, CAROL, ME]);
    }
    // A long board: every ranked identity, the LAST included, is a Rankings key, in leaderboard
    // order. WRONG IMPL KILLED: a layout (or a vm) that caps the tab at the first few rows
    // (`rows.slice(0, 5)`): the cursor could never reach the sixth ranked player.
    const LONG = 9;
    const longProfiles: StoreProfile[] = [];
    for (let i = 0; i < LONG; i++) {
      // Hex pairs 10..18, ratings strictly descending with the index: the expected order is the index.
      longProfiles.push(profile((16 + i).toString(16).repeat(32), `P${i}`, 1500 - i * 10, i, 0));
    }
    const longIds = longProfiles.map((p) => p.identity);
    expect(longIds.length, 'ANTI-VACUITY: a board of at least seven').toBeGreaterThanOrEqual(7);
    expect(new Set(longIds).size, 'ANTI-VACUITY: distinct identities').toBe(LONG);
    for (const input of [
      [...longProfiles],
      [...longProfiles].reverse(),
      [...longProfiles.slice(4), ...longProfiles.slice(0, 4)],
    ]) {
      const long = buildSocialVm(null, [], [], ME, {
        players: [],
        characters: [],
        profiles: input,
      });
      expect(
        long.rankings.map((r) => r.identityHex),
        'vm.rankings holds every ranked row, in leaderboard order',
      ).toEqual(longIds);
      const keys = itemsOf(socialLayout(long), 'rankings');
      expect(
        keys.map((i) => i.key),
        'the Rankings tab keys every ranked identity, the last included, in leaderboard order',
      ).toEqual(longIds);
      expect(
        keys.every((i) => i.enabled),
        'every row enabled',
      ).toBe(true);
      expect(keys[keys.length - 1]?.key, 'the last ranked identity is reachable').toBe(
        longIds[LONG - 1],
      );
    }

    // No profiles: no rows, an empty tab, never a throw.
    const empty = buildSocialVm(null, [], [], ME, NO_PEOPLE);
    expect(empty.rankings).toEqual([]);
    expect(itemsOf(socialLayout(empty), 'rankings')).toEqual([]);
    // The identity passed in decides the own flag.
    expect(
      buildSocialVm(null, [], [], BOB, { players: [], characters: [], profiles })
        .rankings.filter((r) => r.isOwn)
        .map((r) => r.identityHex),
    ).toEqual([BOB]);
  });
});
