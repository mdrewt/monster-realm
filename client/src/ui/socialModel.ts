// ui/socialModel.ts — the Social frame's pure view model (design §5 row 4; CTL8D.1, CTL8D.2).
// No DOM, SDK, resolver, clock or module state. Total: never throws on any input.
//
// The frame's rows are the blocks its legacy roots show: the one offer the trade root shows, and
// the request and the sent challenge the pvp root shows, each picked through that root's own
// selector, so A on a row always acts on what the player sees. Players and Rankings list nothing
// until ctl-8g.
import type { StoreBattleChallenge, StoreTradeOffer } from '../net/store';
import { list, type NavLayout, tabs } from './nav';
import { incomingChallenge, outgoingChallenge } from './pvpModel';
import type { SocialTab } from './screens/types';
import { shownTradeOffer, type TradeAction, tradeActions } from './tradeModel';

/** The tabs in strip order. Built from a `Record`, so a new `SocialTab` fails client-typecheck
 *  here. */
export const SOCIAL_TABS = Object.keys({
  players: true,
  trades: true,
  challenges: true,
  rankings: true,
} satisfies Record<SocialTab, true>) as readonly SocialTab[];

/** What a row's sheet can offer. */
export type SocialAction = 'accept' | 'decline' | 'confirm' | 'cancel';

export type SocialRowKind = 'trade' | 'incoming' | 'outgoing';

export interface SocialRow {
  /** The nav key: `trade-<tradeId>` or `challenge-<challengeId>`. */
  readonly key: string;
  readonly kind: SocialRowKind;
  /** The tradeId or the challengeId. */
  readonly id: bigint;
  /** The actions legal now, in sheet order; never empty. */
  readonly actions: readonly SocialAction[];
  /** An incoming request the viewer has not answered. */
  readonly waiting: boolean;
  readonly createdAtMs: bigint;
}

export interface SocialVm {
  /** The tab the open path asked for (`ScreenContext.socialTab`), else null. */
  readonly requested: SocialTab | null;
  /** The offer the trade root shows, if any. */
  readonly trades: readonly SocialRow[];
  /** The request the pvp root shows, then the viewer's own sent challenge. */
  readonly challenges: readonly SocialRow[];
}

/** The sheet's name for each trade action: the legacy `reject` reads Decline. */
const TRADE_ACTION: Readonly<Record<TradeAction, SocialAction>> = {
  accept: 'accept',
  reject: 'decline',
  confirm: 'confirm',
  cancel: 'cancel',
};
const REQUEST_ACTIONS: readonly SocialAction[] = ['accept', 'decline'];
const SENT_ACTIONS: readonly SocialAction[] = ['cancel'];

function tradeRow(offer: StoreTradeOffer, identity: string): SocialRow {
  return {
    key: `trade-${offer.tradeId}`,
    kind: 'trade',
    id: offer.tradeId,
    actions: tradeActions(offer, identity).map((action) => TRADE_ACTION[action]),
    // An offer awaiting the viewer's own final Confirm is not a request (design §4).
    waiting: offer.counterparty === identity && offer.status === 'Pending',
    createdAtMs: offer.createdAtMs,
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

export function buildSocialVm(
  requested: SocialTab | null,
  offers: readonly StoreTradeOffer[],
  challenges: readonly StoreBattleChallenge[],
  identity: string,
): SocialVm {
  const offer = shownTradeOffer(offers, identity);
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
    trades: offer === undefined ? [] : [tradeRow(offer, identity)],
    challenges: rows,
  };
}

/** The rows `tab` lists. */
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

/** The frame's nav layout: the four tabs, each over its rows. */
export function socialLayout(vm: SocialVm): NavLayout {
  return tabs(
    SOCIAL_TABS.map((key) => ({
      key,
      layout: list(socialRows(vm, key).map((row) => ({ key: row.key, enabled: true }))),
    })),
  );
}

/** The oldest waiting request: its tab and row key, else null. A tie goes to the trade. */
export function oldestWaiting(
  vm: SocialVm,
): { readonly tab: 'trades' | 'challenges'; readonly key: string } | null {
  const trade = vm.trades.find((row) => row.waiting);
  const challenge = vm.challenges.find((row) => row.waiting);
  if (
    challenge !== undefined &&
    (trade === undefined || challenge.createdAtMs < trade.createdAtMs)
  ) {
    return { tab: 'challenges', key: challenge.key };
  }
  return trade === undefined ? null : { tab: 'trades', key: trade.key };
}
