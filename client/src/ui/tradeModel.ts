// ui/tradeModel.ts — pure view model for the trade overlay (m15b, ADR-0107).
//
// No DOM, no SDK, no side-effects. Never throws on any input — a throw
// here would starve sibling store batch-listeners (store.ts one-way flow).
//
// The trade_offer table is PUBLIC (both parties subscribe — ADR-0106 D3).
// The model filters by own identity rather than trusting the store pre-filter:
// this is defense-in-depth against a future per-row RLS gap (ADR-0015).
// MonsterCard snapshots contain NO genes (ADR-0015 / ADR-0106 D2).
import type { StoreItemRow, StoreMonsterCard, StoreTradeItem, StoreTradeOffer } from '../net/store';

// ---------------------------------------------------------------------------
// View model types
// ---------------------------------------------------------------------------

/** One monster card rendered in a trade offer (no genes — ADR-0015). */
export interface TradeCardViewModel {
  readonly monsterId: bigint;
  readonly speciesName: string;
  readonly nickname: string;
  readonly level: number;
  readonly currentHp: number;
  readonly statHp: number;
}

/** One item stack in a trade offer. */
export interface TradeItemViewModel {
  readonly itemId: number;
  readonly name: string;
  readonly qty: number;
}

/** One side of the trade (own or other party). */
export interface TradeSideViewModel {
  readonly cards: readonly TradeCardViewModel[];
  readonly items: readonly TradeItemViewModel[];
  readonly currency: bigint;
}

/**
 * The reducer action the viewer may take.
 * - 'accept'  → respondTrade(tradeId, accepted:true)
 * - 'reject'  → respondTrade(tradeId, accepted:false)
 * - 'confirm' → confirmTrade(tradeId)
 * - 'cancel'  → cancelTrade(tradeId)
 * accept/reject are the SAME reducer (respond_trade) with different accepted arg.
 */
export type TradeAction = 'accept' | 'reject' | 'confirm' | 'cancel';

export interface TradeOfferViewModel {
  readonly kind: 'trade';
  readonly tradeId: bigint;
  /** What the viewer gives up. */
  readonly mySide: TradeSideViewModel;
  /** What the viewer receives. */
  readonly theirSide: TradeSideViewModel;
  /** True when the viewer is the initiator of this offer. */
  readonly viewerIsInitiator: boolean;
  /** Human-readable status label. */
  readonly statusLabel: string;
  /** Ordered list of buttons to render. Empty = viewer can only wait. */
  readonly actions: readonly TradeAction[];
}

export interface NoTradeViewModel {
  readonly kind: 'no-trade';
}

export type TradeScreenViewModel = TradeOfferViewModel | NoTradeViewModel;

// ---------------------------------------------------------------------------
// Action-derivation table (spec §5 — encode exactly, no deviation)
//
// | Viewer role  | status                  | actions            | statusLabel                        |
// |--------------|-------------------------|--------------------|------------------------------------|
// | initiator    | Pending                 | ['cancel']         | "Waiting for response"             |
// | counterparty | Pending                 | ['accept','reject']| "Offer received"                   |
// | initiator    | ConfirmedByCounterparty | ['confirm','cancel']| "Accepted — confirm to finalize"  |
// | counterparty | ConfirmedByCounterparty | ['cancel']         | "Accepted — awaiting confirmation" |
// ---------------------------------------------------------------------------

function deriveActionsAndLabel(
  isInitiator: boolean,
  status: string,
): { actions: readonly TradeAction[]; statusLabel: string } {
  if (isInitiator) {
    if (status === 'ConfirmedByCounterparty') {
      return { actions: ['confirm', 'cancel'], statusLabel: 'Accepted — confirm to finalize' };
    }
    return { actions: ['cancel'], statusLabel: 'Waiting for response' };
  }
  if (status === 'ConfirmedByCounterparty') {
    return { actions: ['cancel'], statusLabel: 'Accepted — awaiting confirmation' };
  }
  return { actions: ['accept', 'reject'], statusLabel: 'Offer received' };
}

// ---------------------------------------------------------------------------
// Builder helpers (pure — no DB access)
// ---------------------------------------------------------------------------

function buildCardViewModel(
  card: StoreMonsterCard,
  speciesMap: ReadonlyMap<number, { readonly name: string }>,
): TradeCardViewModel {
  return {
    monsterId: card.monsterId,
    speciesName: speciesMap.get(card.speciesId)?.name ?? `Unknown (#${card.speciesId})`,
    nickname: card.nickname,
    level: card.level,
    currentHp: card.currentHp,
    statHp: card.statHp,
  };
}

function buildItemViewModel(
  item: StoreTradeItem,
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): TradeItemViewModel {
  return {
    itemId: item.itemId,
    name: itemDefs.get(item.itemId)?.name ?? `Unknown (#${item.itemId})`,
    qty: item.qty,
  };
}

function buildSideViewModel(
  cards: readonly StoreMonsterCard[],
  items: readonly StoreTradeItem[],
  currency: bigint,
  speciesMap: ReadonlyMap<number, { readonly name: string }>,
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): TradeSideViewModel {
  return {
    cards: cards.map((c) => buildCardViewModel(c, speciesMap)),
    items: items.map((i) => buildItemViewModel(i, itemDefs)),
    currency,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the trade overlay view model from pure subscription data.
 *
 * Filters `offers` to the single offer where `identity` is initiator OR
 * counterparty; if multiple (should be impossible per TR-20 / D4 one-active-per-player),
 * selects the lowest tradeId for determinism (mirrors shopModel's sort idiom).
 *
 * Returns NoTradeViewModel when no offer involves the viewer.
 * TOTAL: never throws. Missing species/item defs → "Unknown (#N)".
 */
export function buildTradeViewModel(
  offers: readonly StoreTradeOffer[],
  identity: string,
  speciesMap: ReadonlyMap<number, { readonly name: string }>,
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): TradeScreenViewModel {
  // Filter to offers where viewer is a party (defense-in-depth — PUBLIC table).
  const ownOffers = offers.filter((o) => o.initiator === identity || o.counterparty === identity);
  if (ownOffers.length === 0) return { kind: 'no-trade' };

  // Deterministic selection: lowest tradeId wins (TR-20 means only one should exist).
  // biome-ignore lint/style/noNonNullAssertion: length > 0 checked above
  const offer = ownOffers.sort((a, b) => (a.tradeId < b.tradeId ? -1 : 1))[0]!;

  const isInitiator = offer.initiator === identity;
  const { actions, statusLabel } = deriveActionsAndLabel(isInitiator, offer.status);

  const initiatorSide = buildSideViewModel(
    offer.initiatorCards,
    offer.initiatorItems,
    offer.initiatorCurrency,
    speciesMap,
    itemDefs,
  );
  const counterpartySide = buildSideViewModel(
    offer.counterpartyCards,
    offer.counterpartyItems,
    offer.counterpartyCurrency,
    speciesMap,
    itemDefs,
  );

  return {
    kind: 'trade',
    tradeId: offer.tradeId,
    mySide: isInitiator ? initiatorSide : counterpartySide,
    theirSide: isInitiator ? counterpartySide : initiatorSide,
    viewerIsInitiator: isInitiator,
    statusLabel,
    actions,
  };
}
