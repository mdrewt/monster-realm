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
import type { StoreBattleChallenge, StoreTradeOffer } from '../net/store';
import type { NavLayout } from './nav';
import { buildPvpChallengeViewModel } from './pvpModel';
import type { SocialTab } from './screens/types';
import {
  buildSocialVm,
  oldestWaiting,
  SOCIAL_TABS,
  type SocialAction,
  type SocialRow,
  type SocialVm,
  socialLayout,
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

/** The view model a plain open (no requested tab) builds for the viewer. */
const vmOf = (offers: StoreTradeOffer[], challenges: StoreBattleChallenge[]): SocialVm =>
  buildSocialVm(null, offers, challenges, ME);

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
    const vm = buildSocialVm(null, offers, challenges, ME);
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
    expect(buildSocialVm(null, offers, challenges, ''), 'an empty identity').toMatchObject({
      trades: [],
      challenges: [],
    });
    expect(buildSocialVm(null, [], [], ''), 'both').toMatchObject({ trades: [], challenges: [] });

    // The requested tab passes through as given.
    for (const requested of [...TABS, null]) {
      expect(
        buildSocialVm(requested, offers, challenges, ME).requested,
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
