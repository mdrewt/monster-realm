// ui/socialModel.ts — the Social frame's pure view model (design §5 row 4; CTL8D.1, CTL8D.2).
// No DOM, SDK, resolver, clock or module state. Total: never throws on any input.
//
// Challenges lists the request and the sent challenge the pvp root shows, each picked through that
// root's own selector, so A on a row always acts on what the player sees. Trades lists one row per
// trade session the viewer is in: A on one opens its editor. Players lists the other online
// players (CTL8G.1) and Rankings the leaderboard's rows (CTL8G.2): nav rows only, never a sheet.
import type {
  StoreBattleChallenge,
  StoreCharacter,
  StorePlayer,
  StoreProfile,
  StoreTradeSession,
} from '../net/store';
import { buildLeaderboardViewModel, type LeaderboardRowViewModel } from './leaderboardModel';
import { list, type NavLayout, tabs } from './nav';
import { incomingChallenge, outgoingChallenge } from './pvpModel';
import type { SocialTab } from './screens/types';
import { incomingUntouched, ownSessions, partnerOf, playerName } from './tradeSessionModel';

/** The tabs in strip order. Built from a `Record`, so a new `SocialTab` fails client-typecheck
 *  here. */
export const SOCIAL_TABS = Object.keys({
  players: true,
  trades: true,
  challenges: true,
  rankings: true,
} satisfies Record<SocialTab, true>) as readonly SocialTab[];

/** What a row's sheet can offer. */
export type SocialAction = 'accept' | 'decline' | 'cancel';

export type SocialRowKind = 'session' | 'incoming' | 'outgoing';

/** What a session row paints beside its key. */
export interface SocialSessionFacts {
  /** The other player's name, `#<hex8>` when it is empty or the player is unknown. */
  readonly partnerName: string;
  readonly mineConfirmed: boolean;
  readonly theirsConfirmed: boolean;
}

export interface SocialRow {
  /** The nav key: `session-<sessionId>` or `challenge-<challengeId>`. */
  readonly key: string;
  readonly kind: SocialRowKind;
  /** The sessionId or the challengeId. */
  readonly id: bigint;
  /** The actions legal now, in sheet order. Empty exactly for a session row, which has no sheet:
   *  A on it opens its editor. */
  readonly actions: readonly SocialAction[];
  /** An incoming request the viewer has not answered. */
  readonly waiting: boolean;
  readonly createdAtMs: bigint;
  /** A session row's painted facts; absent on every other kind. */
  readonly session?: SocialSessionFacts;
}

/** The Manhattan distance, in tiles, within which a player in the viewer's zone reads "Nearby".
 *  Presentation only: it gates nothing (no reducer reads it). */
export const NEARBY_TILES = 12;

/** One online player on the Players tab. */
export interface SocialPlayerRow {
  /** The nav key: the player's identity hex. */
  readonly key: string;
  /** The display name: the raw name, `#<hex8>` when it is empty. */
  readonly name: string;
  readonly nearby: boolean;
}

/** The rows the Players and Rankings tabs read, straight from the store. */
interface SocialPeople {
  readonly players: readonly StorePlayer[];
  readonly characters: Iterable<StoreCharacter>;
  readonly profiles: readonly StoreProfile[];
}

export interface SocialVm {
  /** The tab the open path asked for (`ScreenContext.socialTab`), else null. */
  readonly requested: SocialTab | null;
  /** One row per trade session the viewer is in. */
  readonly trades: readonly SocialRow[];
  /** The request the pvp root shows, then the viewer's own sent challenge. */
  readonly challenges: readonly SocialRow[];
  /** The other online players, by name. */
  readonly players: readonly SocialPlayerRow[];
  /** The leaderboard's rows, in its order. */
  readonly rankings: readonly LeaderboardRowViewModel[];
}

const REQUEST_ACTIONS: readonly SocialAction[] = ['accept', 'decline'];
const SENT_ACTIONS: readonly SocialAction[] = ['cancel'];

function sessionRow(
  session: StoreTradeSession,
  identity: string,
  players: readonly StorePlayer[],
): SocialRow {
  const viewerIsOpener = session.opener === identity;
  return {
    key: `session-${session.sessionId}`,
    kind: 'session',
    id: session.sessionId,
    actions: [],
    waiting: incomingUntouched(session, identity),
    createdAtMs: session.createdAtMs,
    session: {
      partnerName: playerName(players, partnerOf(session, identity)),
      mineConfirmed: viewerIsOpener ? session.openerConfirmed : session.partnerConfirmed,
      theirsConfirmed: viewerIsOpener ? session.partnerConfirmed : session.openerConfirmed,
    },
  };
}

function challengeRow(challenge: StoreBattleChallenge, kind: 'incoming' | 'outgoing'): SocialRow {
  const incoming = kind === 'incoming';
  return {
    key: `challenge-${challenge.challengeId}`,
    kind,
    id: challenge.challengeId,
    actions: incoming ? REQUEST_ACTIONS : SENT_ACTIONS,
    waiting: incoming,
    createdAtMs: challenge.createdAtMs,
  };
}

/** Code-unit order (never localeCompare: locale collation is platform-dependent). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The online players other than the viewer, by raw name then identity. A player is nearby when
 *  both characters are known, in one zone, within `NEARBY_TILES`; one with no character row is
 *  listed, never nearby. */
export function socialPlayers(
  players: readonly StorePlayer[],
  characters: Iterable<StoreCharacter>,
  identity: string,
): readonly SocialPlayerRow[] {
  const byEntity = new Map<bigint, StoreCharacter>();
  for (const character of characters) byEntity.set(character.entityId, character);
  const ownEntity = players.find((p) => p.identity === identity)?.entityId;
  const own = ownEntity === undefined ? undefined : byEntity.get(ownEntity);
  return players
    .filter((p) => p.online && p.identity !== identity)
    .sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.identity, b.identity))
    .map((p) => {
      const them = byEntity.get(p.entityId);
      const nearby =
        own !== undefined &&
        them !== undefined &&
        own.zoneId === them.zoneId &&
        Math.abs(own.tileX - them.tileX) + Math.abs(own.tileY - them.tileY) <= NEARBY_TILES;
      return {
        key: p.identity,
        name: p.name !== '' ? p.name : `#${p.identity.slice(0, 8)}`,
        nearby,
      };
    });
}

/** What the Players tab shows, as one string: equal exactly when the rows' keys, names and nearby
 *  flags are equal in order (JSON quotes every name, so no name forges another list). */
export const socialPeopleKey = (vm: SocialVm): string =>
  JSON.stringify(vm.players.map((row) => [row.key, row.name, row.nearby]));

/** What the session rows paint, as one string: equal exactly when their keys, names and marks are
 *  equal in order. */
export const socialSessionsKey = (vm: SocialVm): string =>
  JSON.stringify(
    vm.trades.flatMap((row) =>
      row.session === undefined
        ? []
        : [
            [
              row.key,
              row.session.partnerName,
              row.session.mineConfirmed,
              row.session.theirsConfirmed,
            ],
          ],
    ),
  );

export function buildSocialVm(
  requested: SocialTab | null,
  challenges: readonly StoreBattleChallenge[],
  identity: string,
  people: SocialPeople,
  sessions: readonly StoreTradeSession[] = [],
): SocialVm {
  const incoming = incomingChallenge(challenges, identity);
  const outgoing = outgoingChallenge(challenges, identity);
  const rows: SocialRow[] = [];
  if (incoming !== undefined) rows.push(challengeRow(incoming, 'incoming'));
  // A challenge to oneself (the server refuses it) would be both rows under one key.
  if (outgoing !== undefined && outgoing.challengeId !== incoming?.challengeId) {
    rows.push(challengeRow(outgoing, 'outgoing'));
  }
  return {
    requested,
    trades: ownSessions(sessions, identity).map((session) =>
      sessionRow(session, identity, people.players),
    ),
    challenges: rows,
    players: socialPlayers(people.players, people.characters, identity),
    rankings: buildLeaderboardViewModel(people.profiles, identity).rows,
  };
}

/** The trade and challenge rows `tab` lists: the rows a sheet can act on. */
export function socialRows(vm: SocialVm, tab: SocialTab): readonly SocialRow[] {
  switch (tab) {
    case 'trades':
      return vm.trades;
    case 'challenges':
      return vm.challenges;
    case 'players':
    case 'rankings':
      return [];
  }
}

/** The nav keys `tab` lists: its rows', the players' or the ranked identities. */
function tabKeys(vm: SocialVm, tab: SocialTab): readonly string[] {
  switch (tab) {
    case 'players':
      return vm.players.map((row) => row.key);
    case 'rankings':
      return vm.rankings.map((row) => row.identityHex);
    case 'trades':
    case 'challenges':
      return socialRows(vm, tab).map((row) => row.key);
  }
}

/** The frame's nav layout: the four tabs, each over its rows. */
export function socialLayout(vm: SocialVm): NavLayout {
  return tabs(
    SOCIAL_TABS.map((key) => ({
      key,
      layout: list(tabKeys(vm, key).map((item) => ({ key: item, enabled: true }))),
    })),
  );
}

/** The oldest waiting request: its tab and row key, else null. A tie goes to the trade session, and
 *  among session rows to the first listed. */
export function oldestWaiting(
  vm: SocialVm,
): { readonly tab: 'trades' | 'challenges'; readonly key: string } | null {
  let trade: SocialRow | undefined;
  for (const row of vm.trades) {
    if (row.waiting && (trade === undefined || row.createdAtMs < trade.createdAtMs)) trade = row;
  }
  const challenge = vm.challenges.find((row) => row.waiting);
  if (
    challenge !== undefined &&
    (trade === undefined || challenge.createdAtMs < trade.createdAtMs)
  ) {
    return { tab: 'challenges', key: challenge.key };
  }
  return trade === undefined ? null : { tab: 'trades', key: trade.key };
}
