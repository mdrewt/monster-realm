// ui/tradeModel.ts — the view models of one side of a trade: its monster cards, item lines and
// coins. The session editor (ui/tradeSessionModel.ts) builds both sides through `buildSideViewModel`.
//
// No DOM, no SDK, no side-effects. Never throws on any input — a throw
// here would starve sibling store batch-listeners (store.ts one-way flow).
// MonsterCard snapshots contain NO genes.
import type { StoreItemRow, StoreMonsterCard, StoreTradeItem } from '../net/store';

// ---------------------------------------------------------------------------
// View model types
// ---------------------------------------------------------------------------

/** One monster card of a trade side (no genes). */
export interface TradeCardViewModel {
  readonly monsterId: bigint;
  readonly speciesName: string;
  readonly nickname: string;
  readonly level: number;
  readonly currentHp: number;
  readonly statHp: number;
}

/** One item line of a trade side. */
export interface TradeItemViewModel {
  readonly itemId: number;
  readonly name: string;
  readonly qty: number;
}

/** One side of a trade (the viewer's or the partner's). */
export interface TradeSideViewModel {
  readonly cards: readonly TradeCardViewModel[];
  readonly items: readonly TradeItemViewModel[];
  readonly currency: bigint;
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

/** One side's cards, item lines and coins as view models. Missing species / item defs read
 *  "Unknown (#N)". */
export function buildSideViewModel(
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
