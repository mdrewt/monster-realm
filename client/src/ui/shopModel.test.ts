// ui/shopModel.test.ts — M13d red-phase tests for buildShopViewModel.
// SOURCE OF TRUTH: specs/monster-realm-v2/M13d (shop client UI slice)
//
// Tests are INTENTIONALLY RED until shopModel.ts is implemented.
// Do NOT edit to match a buggy implementation — correct from the spec only.
//
// Contract: buildShopViewModel(shops, shopItems, itemDefs, ownInventory) -> ShopScreenViewModel
//   - ShopScreenViewModel = ShopViewModel | NoShopViewModel
//   - NoShopViewModel { kind: 'no-shop' } when shops array is empty
//   - ShopViewModel { shopId, shopName, forSale, forSaleByPlayer }
//   - forSale: items for the FIRST shop (index 0); item name from itemDef or fallback
//   - forSaleByPlayer: own inventory items with sellPrice > 0n only
//   - TOTAL: never throws
//
// Pattern follows raisingModel.test.ts and healModel.test.ts: pure function,
// no DOM, no SDK, no SpacetimeDB imports.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoreInventory, StoreItemRow } from '../net/store';
import {
  buildShopViewModel,
  type NoShopViewModel,
  type ShopInventoryItemViewModel,
  type ShopItemViewModel,
  type ShopScreenViewModel,
  type ShopViewModel,
} from './shopModel';

// ---------------------------------------------------------------------------
// Local type definitions (mirror what store.ts will export as StoreShopRow /
// StoreShopItemRow after M13d is implemented). Defined locally so tests don't
// import from module_bindings and remain node-only (same pattern as healModel.test.ts).
// ---------------------------------------------------------------------------

interface StoreShopRow {
  readonly shopId: number;
  readonly name: string;
}

interface StoreShopItemRow {
  readonly shopItemId: bigint;
  readonly shopId: number;
  readonly itemId: number;
  readonly buyPrice: bigint;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeShop(shopId: number, name = `Shop-${shopId}`): StoreShopRow {
  return { shopId, name };
}

function makeShopItem(
  shopItemId: bigint,
  shopId: number,
  itemId: number,
  buyPrice: bigint = 10n,
): StoreShopItemRow {
  return { shopItemId, shopId, itemId, buyPrice };
}

function makeItemDef(id: number, overrides: Partial<StoreItemRow> = {}): StoreItemRow {
  return {
    id,
    name: `Item-${id}`,
    description: `Desc for ${id}`,
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 0n,
    ...overrides,
  };
}

function makeInventoryItem(
  invId: bigint,
  itemId: number,
  count = 1,
  ownerIdentity = 'player',
): StoreInventory {
  return { invId, ownerIdentity, itemId, count };
}

// ---------------------------------------------------------------------------
// [m13d-1] No-shop state
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-1]: no-shop state — empty shops array', () => {
  it('[m13d-1] BITES: empty shops → { kind: "no-shop" } (not a crash, not an empty ShopViewModel)', () => {
    // Kills: an impl that returns { shopId:0, shopName:"", forSale:[], forSaleByPlayer:[] }
    // instead of the discriminated NoShopViewModel.
    let result: ShopScreenViewModel;
    expect(() => {
      result = buildShopViewModel([], [], new Map(), []);
    }).not.toThrow();
    result = buildShopViewModel([], [], new Map(), []);
    expect((result as NoShopViewModel).kind).toBe('no-shop');
  });

  it('[m13d-1] BITES: no-shop result does NOT have shopId or shopName (it is NoShopViewModel)', () => {
    // Kills: an impl that returns a fake ShopViewModel with defaults.
    const result = buildShopViewModel([], [], new Map(), []);
    expect(result).not.toHaveProperty('shopId');
    expect(result).not.toHaveProperty('shopName');
    expect(result).not.toHaveProperty('forSale');
  });
});

// ---------------------------------------------------------------------------
// [m13d-2] Shop catalog display
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-2]: shop catalog display — one shop', () => {
  it('[m13d-2] BITES: one shop row → returns ShopViewModel (not NoShopViewModel)', () => {
    // Kills: an impl that always returns { kind:"no-shop" } regardless of input.
    const shops = [makeShop(1, 'General Store')];
    const defs = new Map([[3, makeItemDef(3, { name: 'Potion' })]]);
    const shopItems = [makeShopItem(1n, 1, 3, 50n)];
    const result = buildShopViewModel(shops, shopItems, defs, []);
    expect((result as NoShopViewModel).kind).not.toBe('no-shop');
  });

  it('[m13d-2] BITES: ShopViewModel has correct shopId and shopName from the shop row', () => {
    // Kills: an impl that hardcodes shopId=0 or shopName="".
    const shops = [makeShop(7, 'Magic Emporium')];
    const result = buildShopViewModel(shops, [], new Map(), []) as ShopViewModel;
    expect(result.shopId).toBe(7);
    expect(result.shopName).toBe('Magic Emporium');
  });

  it('[m13d-2] BITES: forSale contains shop item with correct name from itemDef', () => {
    // Kills: an impl that ignores itemDef and uses a generic name like "Item #N".
    const shops = [makeShop(1)];
    const defs = new Map([[5, makeItemDef(5, { name: 'Fire Herb' })]]);
    const shopItems = [makeShopItem(10n, 1, 5, 100n)];
    const result = buildShopViewModel(shops, shopItems, defs, []) as ShopViewModel;
    expect(result.forSale).toHaveLength(1);
    const item = result.forSale[0] as ShopItemViewModel;
    expect(item.name).toBe('Fire Herb');
    expect(item.buyPrice).toBe(100n);
    expect(item.itemId).toBe(5);
    expect(item.shopItemId).toBe(10n);
  });

  it('[m13d-2] BITES: forSale array is readonly-compatible and has all ShopItemViewModel fields', () => {
    // Kills: an impl that omits shopItemId or buyPrice from forSale items.
    const shops = [makeShop(1)];
    const defs = new Map([[2, makeItemDef(2, { name: 'Speed Berry' })]]);
    const shopItems = [makeShopItem(99n, 1, 2, 25n)];
    const result = buildShopViewModel(shops, shopItems, defs, []) as ShopViewModel;
    const item = result.forSale[0]!;
    expect(item).toHaveProperty('shopItemId');
    expect(item).toHaveProperty('itemId');
    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('buyPrice');
  });
});

// ---------------------------------------------------------------------------
// [m13d-3] Item name fallback
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-3]: item name fallback when itemDef is missing', () => {
  it('[m13d-3] BITES: missing itemDef → name is "Unknown (#N)" where N is the itemId', () => {
    // Kills: an impl that throws on missing def, or returns "" or "Unknown" without the id.
    const shops = [makeShop(1)];
    const shopItems = [makeShopItem(1n, 1, 42, 10n)];
    const result = buildShopViewModel(shops, shopItems, new Map(), []) as ShopViewModel;
    expect(result.forSale).toHaveLength(1);
    expect(result.forSale[0]!.name).toBe('Unknown (#42)');
  });

  it('[m13d-3] BITES: multiple missing itemDefs get distinct "Unknown (#N)" names (not all "Unknown")', () => {
    // Kills: an impl that returns "Unknown" without the id, making all unknowns indistinguishable.
    const shops = [makeShop(1)];
    const shopItems = [makeShopItem(1n, 1, 10, 5n), makeShopItem(2n, 1, 20, 15n)];
    const result = buildShopViewModel(shops, shopItems, new Map(), []) as ShopViewModel;
    const names = result.forSale.map((i) => i.name);
    expect(names).toContain('Unknown (#10)');
    expect(names).toContain('Unknown (#20)');
    expect(names).not.toContain('Unknown (#42)'); // other ids don't appear
  });

  it('[m13d-3] BITES: missing itemDef does NOT cause a throw (total function)', () => {
    // Kills: an impl that throws Map.get(undefined) or does unguarded property access.
    const shops = [makeShop(1)];
    const shopItems = [makeShopItem(1n, 1, 9999, 1n)];
    expect(() => {
      buildShopViewModel(shops, shopItems, new Map(), []);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [m13d-4] Sell inventory display — only items with sellPrice > 0n
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-4]: sell inventory — only sellable items in forSaleByPlayer', () => {
  it('[m13d-4] BITES: item with sellPrice=0n is excluded from forSaleByPlayer', () => {
    // Kills: an impl that includes all inventory items regardless of sellPrice.
    const shops = [makeShop(1)];
    const defs = new Map([[3, makeItemDef(3, { name: 'Key', sellPrice: 0n })]]);
    const inv = [makeInventoryItem(1n, 3, 1)];
    const result = buildShopViewModel(shops, [], defs, inv) as ShopViewModel;
    // Key has sellPrice=0n, must not appear in forSaleByPlayer (or canSell must be false)
    const hasSellable = result.forSaleByPlayer.some((i) => i.itemId === 3 && i.canSell);
    expect(hasSellable).toBe(false);
  });

  it('[m13d-4] BITES: item with sellPrice > 0n IS included in forSaleByPlayer', () => {
    // Kills: an impl that always returns an empty forSaleByPlayer list.
    const shops = [makeShop(1)];
    const defs = new Map([[2, makeItemDef(2, { name: 'Herb', sellPrice: 10n })]]);
    const inv = [makeInventoryItem(5n, 2, 3)];
    const result = buildShopViewModel(shops, [], defs, inv) as ShopViewModel;
    expect(result.forSaleByPlayer.some((i) => i.itemId === 2)).toBe(true);
  });

  it('[m13d-4] BITES: item with missing itemDef is NOT in forSaleByPlayer as canSell:true', () => {
    // When itemDef is missing, sellPrice defaults to 0n (no sell info) → must not be canSell.
    // Kills: an impl that assumes sellPrice=1n when def is missing.
    const shops = [makeShop(1)];
    const inv = [makeInventoryItem(1n, 999, 1)]; // itemId 999 has no def
    const result = buildShopViewModel(shops, [], new Map(), inv) as ShopViewModel;
    const hasSellable = result.forSaleByPlayer.some((i) => i.itemId === 999 && i.canSell);
    expect(hasSellable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [m13d-5] canSell discriminator
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-5]: canSell discriminator — sellPrice > 0n ↔ canSell:true', () => {
  it('[m13d-5] BITES: item with sellPrice=50n → canSell:true', () => {
    // Kills: an impl that always sets canSell:false or ignores sellPrice.
    const shops = [makeShop(1)];
    const defs = new Map([[1, makeItemDef(1, { sellPrice: 50n })]]);
    const inv = [makeInventoryItem(1n, 1, 2)];
    const result = buildShopViewModel(shops, [], defs, inv) as ShopViewModel;
    const item = result.forSaleByPlayer.find((i) => i.itemId === 1);
    expect(item).toBeDefined();
    expect(item!.canSell).toBe(true);
    expect(item!.sellPrice).toBe(50n);
  });

  it('[m13d-5] BITES: item with sellPrice=0n → canSell:false (or excluded — no canSell:true item with id)', () => {
    // Kills: an impl that always sets canSell:true.
    const shops = [makeShop(1)];
    const defs = new Map([[2, makeItemDef(2, { sellPrice: 0n })]]);
    const inv = [makeInventoryItem(2n, 2, 1)];
    const result = buildShopViewModel(shops, [], defs, inv) as ShopViewModel;
    // Either excluded from forSaleByPlayer OR present with canSell:false — neither canSell:true allowed
    const sellableWithId2 = result.forSaleByPlayer.filter((i) => i.itemId === 2 && i.canSell);
    expect(sellableWithId2).toHaveLength(0);
  });

  it('[m13d-5] BITES: two items — one sellable, one not — canSell classified independently', () => {
    // Kills: an impl that applies a single all-or-nothing canSell decision.
    const shops = [makeShop(1)];
    const defs = new Map([
      [1, makeItemDef(1, { name: 'Herb', sellPrice: 20n })],
      [2, makeItemDef(2, { name: 'Key', sellPrice: 0n })],
    ]);
    const inv = [makeInventoryItem(1n, 1, 3), makeInventoryItem(2n, 2, 1)];
    const result = buildShopViewModel(shops, [], defs, inv) as ShopViewModel;
    const herb = result.forSaleByPlayer.find((i) => i.itemId === 1);
    expect(herb).toBeDefined();
    expect(herb!.canSell).toBe(true);
    // Key must not appear as canSell:true
    const keySellable = result.forSaleByPlayer.find((i) => i.itemId === 2 && i.canSell);
    expect(keySellable).toBeUndefined();
  });

  it('[m13d-5] BITES: ShopInventoryItemViewModel has all required fields when sellable', () => {
    // Kills: an impl that omits invId, count, or sellPrice from the view model.
    const shops = [makeShop(1)];
    const defs = new Map([[4, makeItemDef(4, { name: 'Potion', sellPrice: 30n })]]);
    const inv = [makeInventoryItem(7n, 4, 5)];
    const result = buildShopViewModel(shops, [], defs, inv) as ShopViewModel;
    const item: ShopInventoryItemViewModel = result.forSaleByPlayer[0]!;
    expect(item).toHaveProperty('invId');
    expect(item).toHaveProperty('itemId');
    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('count');
    expect(item).toHaveProperty('sellPrice');
    expect(item).toHaveProperty('canSell');
    expect(item.invId).toBe(7n);
    expect(item.itemId).toBe(4);
    expect(item.name).toBe('Potion');
    expect(item.count).toBe(5);
    expect(item.sellPrice).toBe(30n);
    expect(item.canSell).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [m13d-6] First shop selection — when multiple shops exist
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-6]: shop selection — lowest shopId wins', () => {
  it('[m13d-6] BITES: shop with lowest shopId is selected (deterministic regardless of array order)', () => {
    // Kills: an impl that picks shops[0] without sorting, which would be
    // non-deterministic under Map insertion order across reconnects.
    const shops = [makeShop(5, 'Alpha Store'), makeShop(1, 'Beta Store')];
    const result = buildShopViewModel(shops, [], new Map(), []) as ShopViewModel;
    expect(result.shopId).toBe(1); // lowest shopId wins
    expect(result.shopName).toBe('Beta Store');
  });

  it('[m13d-6] BITES: only items for the selected shopId appear in forSale', () => {
    // The forSale list must be filtered to the selected shop. Items from other shops are excluded.
    // Kills: an impl that shows ALL shop items regardless of shopId.
    const shops = [makeShop(2, 'Second Shop'), makeShop(1, 'First Shop')];
    const defs = new Map([
      [10, makeItemDef(10, { name: 'Sword' })],
      [20, makeItemDef(20, { name: 'Shield' })],
    ]);
    // shopId=2 sells item 10, shopId=1 sells item 20
    const shopItems = [makeShopItem(1n, 2, 10, 100n), makeShopItem(2n, 1, 20, 80n)];
    const result = buildShopViewModel(shops, shopItems, defs, []) as ShopViewModel;
    // Selected shop is shopId=1 (lowest), so only item 20 appears
    expect(result.forSale).toHaveLength(1);
    expect(result.forSale[0]!.itemId).toBe(20);
    expect(result.forSale.some((i) => i.itemId === 10)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [m13d-7] Total safety — never throws
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-7]: total safety — never throws on any valid input', () => {
  it('[m13d-7] BITES: empty everything → no throw', () => {
    // Kills: an impl that throws on empty arrays.
    expect(() => {
      buildShopViewModel([], [], new Map(), []);
    }).not.toThrow();
  });

  it('[m13d-7] BITES: shop with no matching shopItems → forSale=[] (no throw)', () => {
    // Kills: an impl that throws when filtered shopItems is empty.
    const shops = [makeShop(99)];
    const shopItems = [makeShopItem(1n, 1, 3, 10n)]; // shopId=1, not 99
    expect(() => {
      const result = buildShopViewModel(shops, shopItems, new Map(), []);
      expect((result as ShopViewModel).forSale).toHaveLength(0);
    }).not.toThrow();
  });

  it('[m13d-7] BITES: empty ownInventory → forSaleByPlayer=[] (no throw)', () => {
    // Kills: an impl that throws when ownInventory is [].
    const shops = [makeShop(1)];
    expect(() => {
      const result = buildShopViewModel(shops, [], new Map(), []);
      expect((result as ShopViewModel).forSaleByPlayer).toHaveLength(0);
    }).not.toThrow();
  });

  it('[m13d-7] BITES: shopItems with mismatched shopId (no items for selected shop) → no throw', () => {
    // Kills: an impl that throws when filtering produces an empty array.
    const shops = [makeShop(10)];
    const shopItems = [makeShopItem(1n, 5, 1, 10n)]; // shopId=5 ≠ selected shopId=10
    expect(() => {
      buildShopViewModel(shops, shopItems, new Map(), []);
    }).not.toThrow();
  });

  it('[m13d-7] BITES: large inputs — no throw under scale', () => {
    // Kills: an impl with a size-based guard that throws when inputs are large.
    const shops = Array.from({ length: 5 }, (_, i) => makeShop(i + 1));
    const defs = new Map(
      Array.from({ length: 30 }, (_, i) => [i + 1, makeItemDef(i + 1)] as [number, StoreItemRow]),
    );
    const shopItems = Array.from({ length: 30 }, (_, i) =>
      makeShopItem(BigInt(i + 1), 1, i + 1, BigInt(i * 10)),
    );
    const inv = Array.from({ length: 20 }, (_, i) =>
      makeInventoryItem(BigInt(i + 1), i + 1, i + 1),
    );
    expect(() => {
      buildShopViewModel(shops, shopItems, defs, inv);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [m13d-11] Property: forSale length equals shopItems filtered to selected shopId
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-11]: property — forSale.length === shopItems for selected shopId', () => {
  it('[m13d-11] BITES fast-check property: forSale length = count of shopItems for selected shop', () => {
    // The forSale array must contain exactly one entry per shop_item_row with a matching shopId.
    // Kills: an impl that includes items from other shops or drops items from the correct shop.
    // selectedShopId is always 1 (lowest); otherShopIds are always > 1 so the sort is deterministic.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 2, max: 10 }), { minLength: 0, maxLength: 10 }), // other shopIds (always > 1)
        fc.integer({ min: 0, max: 8 }), // count of items for the selected shop
        (otherShopIds, selectedShopItemCount) => {
          const selectedShopId = 1; // always lowest → always selected after sort
          const shops = [
            makeShop(selectedShopId, 'Main'),
            ...otherShopIds.filter((id) => id !== selectedShopId).map((id) => makeShop(id)),
          ];
          // Items for the selected shop
          const selectedItems = Array.from({ length: selectedShopItemCount }, (_, i) =>
            makeShopItem(BigInt(i + 1), selectedShopId, i + 1, 10n),
          );
          // Items for other shops (must not appear in forSale)
          const otherItems = otherShopIds
            .filter((id) => id !== selectedShopId)
            .flatMap((id, i) => [makeShopItem(BigInt(100 + i), id, i + 50, 5n)]);
          const allItems = [...selectedItems, ...otherItems];
          const result = buildShopViewModel(shops, allItems, new Map(), []) as ShopViewModel;
          expect(result.forSale).toHaveLength(selectedShopItemCount);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// [m13d-12] Property: forSaleByPlayer only own items
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-12]: property — forSaleByPlayer only contains items from ownInventory', () => {
  it('[m13d-12] BITES fast-check property: every forSaleByPlayer invId is from ownInventory', () => {
    // No inventory items from other players can appear in forSaleByPlayer.
    // Kills: an impl that reads a shared/global inventory instead of ownInventory.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            invId: fc.bigInt({ min: 1n, max: 10000n }),
            itemId: fc.integer({ min: 1, max: 20 }),
            count: fc.integer({ min: 1, max: 99 }),
          }),
          { minLength: 0, maxLength: 10 },
        ),
        (invItems) => {
          const ownInventory = invItems.map((i) =>
            makeInventoryItem(i.invId, i.itemId, i.count, 'own-player'),
          );
          // Build defs with sellPrice > 0n so items qualify for forSaleByPlayer
          const defs = new Map<number, StoreItemRow>(
            invItems.map((i) => [i.itemId, makeItemDef(i.itemId, { sellPrice: 50n })]),
          );
          const shops = [makeShop(1)];
          const result = buildShopViewModel(shops, [], defs, ownInventory) as ShopViewModel;
          // Every invId in forSaleByPlayer must come from ownInventory
          const ownInvIds = new Set(ownInventory.map((i) => i.invId));
          for (const item of result.forSaleByPlayer) {
            expect(ownInvIds.has(item.invId)).toBe(true);
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// [m13d-13] BITES: items from wrong shop don't appear
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-13]: BITES — items from wrong shop must not appear in forSale', () => {
  it('[m13d-13] BITES: shopId=2 items excluded when selected shop is shopId=1 (lowest wins)', () => {
    // Selected shop is shopId=1 (lowest shopId). Items from shopId=2 must NOT appear.
    // This directly catches an impl that skips the shopId filter entirely.
    // Wrong implementation: return all shopItems without filtering by shopId.
    const shops = [makeShop(2, 'Second Shop'), makeShop(1, 'First Shop')];
    const defs = new Map([
      [10, makeItemDef(10, { name: 'Potion' })],
      [20, makeItemDef(20, { name: 'Antidote' })],
    ]);
    // Shop 1 sells Antidote (itemId=20), Shop 2 sells Potion (itemId=10)
    const shopItems = [
      makeShopItem(1n, 2, 10, 50n), // wrong shop (shopId=2) — must NOT appear
      makeShopItem(2n, 1, 20, 30n), // correct shop (shopId=1)
    ];
    const result = buildShopViewModel(shops, shopItems, defs, []) as ShopViewModel;
    // Potion (from shopId=2) must NOT be in forSale (selected shop is shopId=1)
    expect(result.forSale.some((i) => i.itemId === 10)).toBe(false);
    // Antidote (from shopId=1) MUST be in forSale
    expect(result.forSale.some((i) => i.itemId === 20)).toBe(true);
    expect(result.forSale).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [m13d-14] BITES: zero-sell-price not in forSaleByPlayer as canSell:true
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-14]: BITES — zero sellPrice must never produce canSell:true', () => {
  it('[m13d-14] BITES: sellPrice=0n item in inventory is not canSell:true in forSaleByPlayer', () => {
    // An impl that doesn't check sellPrice and always sets canSell:true would fail this.
    // Wrong implementation: canSell = invId !== undefined (always true for all items)
    const shops = [makeShop(1)];
    const defs = new Map([[5, makeItemDef(5, { name: 'Quest Key', sellPrice: 0n })]]);
    const inv = [makeInventoryItem(3n, 5, 1)];
    const result = buildShopViewModel(shops, [], defs, inv) as ShopViewModel;
    // Quest Key has sellPrice=0n → must NOT appear as canSell:true
    const questKeySellable = result.forSaleByPlayer.find((i) => i.itemId === 5 && i.canSell);
    expect(questKeySellable).toBeUndefined();
  });

  it('[m13d-14] BITES: mixed inventory — 0n and >0n items — canSell is per-item, not global', () => {
    // An impl that computes canSell based on the overall inventory (e.g., "any sellable?")
    // would incorrectly mark the 0n item as canSell:true.
    // Wrong implementation: canSell = forSaleByPlayer.length > 0 for all items
    const shops = [makeShop(1)];
    const defs = new Map([
      [1, makeItemDef(1, { name: 'Herb', sellPrice: 15n })],
      [2, makeItemDef(2, { name: 'Quest Scroll', sellPrice: 0n })],
    ]);
    const inv = [makeInventoryItem(1n, 1, 5), makeInventoryItem(2n, 2, 1)];
    const result = buildShopViewModel(shops, [], defs, inv) as ShopViewModel;
    const herb = result.forSaleByPlayer.find((i) => i.itemId === 1);
    const scroll = result.forSaleByPlayer.find((i) => i.itemId === 2 && i.canSell);
    // Herb is sellable
    expect(herb?.canSell).toBe(true);
    // Scroll is not
    expect(scroll).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// [m13d-15] Structural: ShopViewModel shape and array presence
// ---------------------------------------------------------------------------

describe('buildShopViewModel [m13d-15]: output structure — ShopViewModel has all required fields', () => {
  it('[m13d-15] BITES: ShopViewModel has shopId, shopName, forSale, forSaleByPlayer', () => {
    // Kills: an impl that omits any of the four required top-level fields.
    const shops = [makeShop(3, 'Trader Joe')];
    const result = buildShopViewModel(shops, [], new Map(), []) as ShopViewModel;
    expect(result).toHaveProperty('shopId', 3);
    expect(result).toHaveProperty('shopName', 'Trader Joe');
    expect(result).toHaveProperty('forSale');
    expect(result).toHaveProperty('forSaleByPlayer');
    expect(Array.isArray(result.forSale)).toBe(true);
    expect(Array.isArray(result.forSaleByPlayer)).toBe(true);
  });

  it('[m13d-15] BITES: invId and sellPrice in ShopInventoryItemViewModel stay bigint across 2^53', () => {
    // Kills: an impl that Number()-casts bigint fields in the output view model.
    const largeInvId = 9007199254740993n; // 2^53 + 1 — lossy if Number()-cast
    const largeSellPrice = 9007199254740994n;
    const shops = [makeShop(1)];
    const defs = new Map([[1, makeItemDef(1, { sellPrice: largeSellPrice })]]);
    const inv = [makeInventoryItem(largeInvId, 1, 1)];
    const result = buildShopViewModel(shops, [], defs, inv) as ShopViewModel;
    const item = result.forSaleByPlayer[0]!;
    expect(typeof item.invId).toBe('bigint');
    expect(item.invId).toBe(largeInvId);
    expect(typeof item.sellPrice).toBe('bigint');
    expect(item.sellPrice).toBe(largeSellPrice);
  });

  it('[m13d-15] BITES: shopItemId and buyPrice in ShopItemViewModel stay bigint across 2^53', () => {
    // Kills: an impl that Number()-casts shopItemId or buyPrice in the for-sale list.
    const largeShopItemId = 9007199254740993n;
    const largeBuyPrice = 9007199254740994n;
    const shops = [makeShop(1)];
    const defs = new Map([[1, makeItemDef(1)]]);
    const shopItems = [makeShopItem(largeShopItemId, 1, 1, largeBuyPrice)];
    const result = buildShopViewModel(shops, shopItems, defs, []) as ShopViewModel;
    const item = result.forSale[0]!;
    expect(typeof item.shopItemId).toBe('bigint');
    expect(item.shopItemId).toBe(largeShopItemId);
    expect(typeof item.buyPrice).toBe('bigint');
    expect(item.buyPrice).toBe(largeBuyPrice);
  });
});
