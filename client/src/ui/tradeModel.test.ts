// ui/tradeModel.test.ts — the trade side view models (the session editor's side builder).
//
// Contract: buildSideViewModel(cards, items, currency, speciesMap, itemDefs) -> TradeSideViewModel
//   - cards: one TradeCardViewModel per StoreMonsterCard, in input order, no genes
//     (monsterId, speciesName, nickname, level, currentHp, statHp)
//   - items: one TradeItemViewModel per StoreTradeItem, in input order (itemId, name, qty)
//   - currency: passed through as a bigint
//   - TOTAL: never throws; a missing species def reads "Unknown (#<speciesId>)", a missing item def
//     "Unknown (#<itemId>)"
//   - bigint fields never Number()-cast (monsterId, currency)
// The module exports nothing else at runtime (ts-4 plan "Resume 2": the legacy offer view model,
// its selectors and its action table are not part of it).
//
// Pattern follows shopModel.test.ts: pure function, no DOM, no SDK imports.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoreItemRow, StoreMonsterCard, StoreTradeItem } from '../net/store';
import * as tradeModel from './tradeModel';
import {
  buildSideViewModel,
  type TradeCardViewModel,
  type TradeItemViewModel,
  type TradeSideViewModel,
} from './tradeModel';

// ---------------------------------------------------------------------------
// Factories — typed, defaulted, no DOM/SDK
// ---------------------------------------------------------------------------

function makeCard(
  monsterId: bigint,
  speciesId: number,
  overrides: Partial<StoreMonsterCard> = {},
): StoreMonsterCard {
  return {
    monsterId,
    speciesId,
    nickname: `Mon-${monsterId}`,
    level: 10,
    currentHp: 30,
    statHp: 40,
    ...overrides,
  };
}

function makeTradeItem(itemId: number, qty = 1): StoreTradeItem {
  return { itemId, qty };
}

function makeItemDef(id: number, overrides: Partial<StoreItemRow> = {}): StoreItemRow {
  return {
    id,
    name: `Item-${id}`,
    description: `Desc-${id}`,
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 0n,
    cureStatus: null,
    ...overrides,
  };
}

const NO_SPECIES: ReadonlyMap<number, { readonly name: string }> = new Map();
const NO_ITEMS: ReadonlyMap<number, StoreItemRow> = new Map();

/** One side with only cards. */
const cardsSide = (
  cards: readonly StoreMonsterCard[],
  speciesMap: ReadonlyMap<number, { readonly name: string }> = NO_SPECIES,
): TradeSideViewModel => buildSideViewModel(cards, [], 0n, speciesMap, NO_ITEMS);

/** One side with only item lines. */
const itemsSide = (
  items: readonly StoreTradeItem[],
  itemDefs: ReadonlyMap<number, StoreItemRow> = NO_ITEMS,
): TradeSideViewModel => buildSideViewModel([], items, 0n, NO_SPECIES, itemDefs);

// ---------------------------------------------------------------------------
// [m15b-TM-5] Name resolution — speciesMap and itemDefs
// ---------------------------------------------------------------------------

describe('buildSideViewModel [m15b-TM-5]: name resolution — species and items', () => {
  it('[m15b-TM-5a] BITES: present speciesId resolves to species name (not "Unknown")', () => {
    // Kills: an impl that always returns "Unknown (#N)" regardless of speciesMap content.
    const side = cardsSide([makeCard(1n, 7)], new Map([[7, { name: 'Flamox' }]]));
    expect(side.cards[0]?.speciesName).toBe('Flamox');
  });

  it('[m15b-TM-5b] BITES: missing speciesId → speciesName is "Unknown (#N)" with the actual speciesId', () => {
    // Kills: an impl that throws on missing species, returns "" or "Unknown" without id.
    expect(cardsSide([makeCard(1n, 42)]).cards[0]?.speciesName).toBe('Unknown (#42)');
  });

  it('[m15b-TM-5c] BITES: multiple missing species get DISTINCT "Unknown (#N)" names, a known one between them its own name, in input order', () => {
    // Kills: an impl that returns "Unknown" for all missing species (no id suffix); one that
    // resolves every card through the first card's species; one that reorders the cards.
    const side = cardsSide(
      [makeCard(1n, 10), makeCard(2n, 3), makeCard(3n, 20)],
      new Map([[3, { name: 'Voltix' }]]),
    );
    expect(side.cards.map((c) => c.speciesName)).toEqual([
      'Unknown (#10)',
      'Voltix',
      'Unknown (#20)',
    ]);
    expect(side.cards.map((c) => c.monsterId)).toEqual([1n, 2n, 3n]);
  });

  it('[m15b-TM-5d] BITES: present itemId resolves to item name (not "Unknown")', () => {
    // Kills: an impl that always returns "Unknown (#N)" regardless of itemDefs content.
    const side = itemsSide(
      [makeTradeItem(5, 3)],
      new Map([[5, makeItemDef(5, { name: 'Fire Herb' })]]),
    );
    expect(side.items[0]?.name).toBe('Fire Herb');
  });

  it('[m15b-TM-5e] BITES: missing itemId → name is "Unknown (#N)" with the actual itemId', () => {
    // Kills: an impl that throws on missing item def, or returns "" without id.
    expect(itemsSide([makeTradeItem(99, 1)]).items[0]?.name).toBe('Unknown (#99)');
  });

  it('[m15b-TM-5f] BITES: item qty is preserved unchanged from StoreTradeItem, line by line in input order', () => {
    // Kills: an impl that hardcodes qty=1, drops qty, sums lines or sorts them.
    const side = itemsSide([makeTradeItem(3, 7), makeTradeItem(1, 2), makeTradeItem(3, 1)]);
    expect(side.items.map((i) => [i.itemId, i.qty])).toEqual([
      [3, 7],
      [1, 2],
      [3, 1],
    ]);
  });

  it('[m15b-TM-5g] BITES: the species map and the item defs are read by their own key space (an item id that is also a species id resolves as an item)', () => {
    // Kills: an impl that resolves item names from the species map, or card names from the item
    // defs (both are numeric-keyed maps).
    const side = buildSideViewModel(
      [makeCard(1n, 5)],
      [makeTradeItem(5, 1)],
      0n,
      new Map([[5, { name: 'Aquafin' }]]),
      new Map([[5, makeItemDef(5, { name: 'Mega Gem' })]]),
    );
    expect(side.cards[0]?.speciesName).toBe('Aquafin');
    expect(side.items[0]?.name).toBe('Mega Gem');
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-6] Total safety — never throws
// ---------------------------------------------------------------------------

describe('buildSideViewModel [m15b-TM-6]: total safety — never throws on any input', () => {
  it('[m15b-TM-6a] BITES: empty cards, items and maps → an empty side, no throw', () => {
    // Kills: an impl that reads cards[0] or items[0] without a guard.
    expect(buildSideViewModel([], [], 0n, NO_SPECIES, NO_ITEMS)).toEqual({
      cards: [],
      items: [],
      currency: 0n,
    });
  });

  it('[m15b-TM-6c] BITES: all defs missing (empty speciesMap and itemDefs) → fallback names, no throw', () => {
    // Kills: an impl that does speciesMap.get(id).name without optional chaining.
    const side = buildSideViewModel(
      [makeCard(1n, 99)],
      [makeTradeItem(88, 1)],
      0n,
      NO_SPECIES,
      NO_ITEMS,
    );
    expect(side.cards[0]?.speciesName).toBe('Unknown (#99)');
    expect(side.items[0]?.name).toBe('Unknown (#88)');
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-7] bigint preservation — no Number() cast
// ---------------------------------------------------------------------------

describe('buildSideViewModel [m15b-TM-7]: bigint preservation past 2^53', () => {
  it('[m15b-TM-7b] BITES: currency stays bigint past 2^53', () => {
    // Kills: an impl that does currency = Number(currency).
    const largeCurrency = 9007199254740994n;
    const side = buildSideViewModel([], [], largeCurrency, NO_SPECIES, NO_ITEMS);
    expect(typeof side.currency).toBe('bigint');
    expect(side.currency).toBe(largeCurrency);
  });

  it('[m15b-TM-7d] BITES: cards[].monsterId stays bigint past 2^53', () => {
    // Kills: an impl that maps cards through Number() or uses +monsterId.
    const largeMonsterId = 9007199254740996n;
    const side = cardsSide([makeCard(largeMonsterId, 1)]);
    expect(typeof side.cards[0]?.monsterId).toBe('bigint');
    expect(side.cards[0]?.monsterId).toBe(largeMonsterId);
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-9] Structural shape
// ---------------------------------------------------------------------------

describe('buildSideViewModel [m15b-TM-9]: output structure', () => {
  it('[m15b-TM-9b] BITES: TradeSideViewModel has exactly cards, items, currency', () => {
    // Kills: an impl that flattens the side object, loses a field or adds a stray one.
    const side: TradeSideViewModel = buildSideViewModel([], [], 5n, NO_SPECIES, NO_ITEMS);
    expect(Object.keys(side).sort()).toEqual(['cards', 'currency', 'items']);
    expect(Array.isArray(side.cards)).toBe(true);
    expect(Array.isArray(side.items)).toBe(true);
    expect(side.currency).toBe(5n);
  });

  it('[m15b-TM-9c] BITES: TradeCardViewModel has exactly the six card fields (no genes, no speciesId)', () => {
    // Kills: an impl that omits level, currentHp or statHp, or leaks a source field.
    const card = makeCard(55n, 3, { nickname: 'Sparky', level: 15, currentHp: 20, statHp: 35 });
    const c: TradeCardViewModel | undefined = cardsSide([card], new Map([[3, { name: 'Voltix' }]]))
      .cards[0];
    expect(c).toEqual({
      monsterId: 55n,
      speciesName: 'Voltix',
      nickname: 'Sparky',
      level: 15,
      currentHp: 20,
      statHp: 35,
    });
  });

  it('[m15b-TM-9d] BITES: TradeItemViewModel has exactly itemId, name, qty', () => {
    // Kills: an impl that omits itemId or qty from the item view model.
    const i: TradeItemViewModel | undefined = itemsSide(
      [makeTradeItem(77, 4)],
      new Map([[77, makeItemDef(77, { name: 'Mega Gem' })]]),
    ).items[0];
    expect(i).toEqual({ itemId: 77, name: 'Mega Gem', qty: 4 });
  });
});

// ---------------------------------------------------------------------------
// [m15b-TM-10] Property: total and faithful for any side
// ---------------------------------------------------------------------------

const cardArb = fc.record({
  monsterId: fc.bigInt({ min: 1n, max: 2n ** 64n }),
  speciesId: fc.integer({ min: 1, max: 20 }),
  nickname: fc.string({ maxLength: 16 }),
  level: fc.integer({ min: 1, max: 50 }),
  currentHp: fc.integer({ min: 0, max: 100 }),
  statHp: fc.integer({ min: 1, max: 100 }),
});
const itemArb = fc.record({
  itemId: fc.integer({ min: 1, max: 50 }),
  qty: fc.integer({ min: 1, max: 10 }),
});
const knownIdsArb = fc.uniqueArray(fc.integer({ min: 1, max: 50 }), { maxLength: 10 });

describe('buildSideViewModel [m15b-TM-10]: property — total and faithful on any input', () => {
  it('[m15b-TM-10a] fast-check property: for any cards, items, currency and partial defs, the side has one card and one line per input, in order, each named from its def or "Unknown (#N)", and the currency unchanged', () => {
    // BITES: kills any impl with unguarded property access, a reorder, a dropped or merged
    // entry, a fallback that ignores a present def, or a cast of a bigint.
    fc.assert(
      fc.property(
        fc.array(cardArb, { maxLength: 6 }),
        fc.array(itemArb, { maxLength: 6 }),
        fc.bigInt({ min: 0n, max: 2n ** 64n }),
        knownIdsArb,
        knownIdsArb,
        (cards, items, currency, knownSpecies, knownItems) => {
          const speciesMap = new Map(knownSpecies.map((id) => [id, { name: `S${id}` }]));
          const itemDefs = new Map(knownItems.map((id) => [id, makeItemDef(id)]));
          const side = buildSideViewModel(cards, items, currency, speciesMap, itemDefs);
          expect(side.currency).toBe(currency);
          expect(side.cards.map((c) => c.monsterId)).toEqual(cards.map((c) => c.monsterId));
          expect(side.cards.map((c) => c.speciesName)).toEqual(
            cards.map((c) =>
              speciesMap.has(c.speciesId) ? `S${c.speciesId}` : `Unknown (#${c.speciesId})`,
            ),
          );
          expect(side.items.map((i) => [i.itemId, i.qty])).toEqual(
            items.map((i) => [i.itemId, i.qty]),
          );
          expect(side.items.map((i) => i.name)).toEqual(
            items.map((i) =>
              itemDefs.has(i.itemId) ? `Item-${i.itemId}` : `Unknown (#${i.itemId})`,
            ),
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// ts-4 (ts-4.6): the module is the side builder alone.
// ---------------------------------------------------------------------------

describe('tradeModel — the side builder alone (ts-4, ts-4.6)', () => {
  it('ts-4.6 the module`s runtime exports are exactly buildSideViewModel: no legacy offer view model, selector or action table', () => {
    // WRONG IMPL KILLED: buildTradeViewModel, shownTradeOffer or tradeActions left exported (a
    // second, offer-based path a caller could still reach).
    const exported = Object.keys(tradeModel as unknown as Record<string, unknown>).sort();
    expect(exported).toEqual(['buildSideViewModel']);
    expect(typeof tradeModel.buildSideViewModel).toBe('function');
  });
});
