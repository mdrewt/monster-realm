// ui/shopModel.test.ts — M13d red-phase tests for buildShopViewModel.
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
import type { StoreInventory, StoreItemRow, StoreWallet } from '../net/store';
import {
  buildShopViewModel,
  // The bound-shop selector.
  buildShopViewModelForShop,
  // ctl-7d: the success-line formatter (CTL7D.4).
  buyFeedback,
  type NoShopViewModel,
  type ShopBalanceViewModel,
  type ShopFeedback,
  type ShopInventoryItemViewModel,
  type ShopItemViewModel,
  type ShopScreenViewModel,
  type ShopViewModel,
  sellFeedback,
  // ctl-7d: the quantity rule (CTL7D.3).
  validShopQty,
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
  } as StoreItemRow;
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
  // ux2 EXTENSION: this property now also carries the OPTIONAL 5th
  // `ownWallet` argument (build plan §T5 / "Client unit tests"). The original
  // forSale-length invariant is unchanged — the wallet arbitrary is added on top,
  // so the pre-existing tooth is preserved and a second one is folded in:
  // `balance.kind === 'known'` iff `typeof ownWallet?.balance === 'bigint'`.
  // The `undefined`-balance branch of the arbitrary is what makes truthiness
  // (`wallet?.balance ? …`) and nullish-coalescing (`balance ?? 0n`) impls die here
  // as well as in M2/M4 — under randomised input the property covers ALL THREE arms
  // (absent / valid / malformed) in one run.
  it('[m13d-11] BITES fast-check property: forSale length = count of shopItems for selected shop, and balance.kind tracks typeof ownWallet?.balance', () => {
    // The forSale array must contain exactly one entry per shop_item_row with a matching shopId.
    // Kills: an impl that includes items from other shops or drops items from the correct shop.
    // selectedShopId is always 1 (lowest); otherShopIds are always > 1 so the sort is deterministic.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 2, max: 10 }), { minLength: 0, maxLength: 10 }), // other shopIds (always > 1)
        fc.integer({ min: 0, max: 8 }), // count of items for the selected shop
        // ux2: absent wallet | well-formed wallet (INCLUDING 0n) | malformed wallet row
        fc.oneof(
          fc.constant(undefined),
          fc
            .bigInt({ min: 0n, max: 1_000_000n })
            .map((balance) => ({ ownerIdentity: 'own-player', balance })),
          fc.constant({
            ownerIdentity: 'own-player',
            balance: undefined,
          } as unknown as StoreWallet),
        ),
        (otherShopIds, selectedShopItemCount, ownWallet) => {
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
          const result = buildShopViewModel(
            shops,
            allItems,
            new Map(),
            [],
            ownWallet,
          ) as ShopViewModel;
          expect(result.forSale).toHaveLength(selectedShopItemCount);

          // ux2 balance invariant — totality guard is `typeof … === 'bigint'`, nothing else.
          const expectKnown = typeof ownWallet?.balance === 'bigint';
          expect(result.balance.kind).toBe(expectKnown ? 'known' : 'unknown');
          if (expectKnown) {
            const known = result.balance as Extract<ShopBalanceViewModel, { kind: 'known' }>;
            expect(known.amount).toBe(ownWallet?.balance);
            expect(known.label).toBe(`Gold: ${ownWallet?.balance}`);
          }
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

// ===========================================================================
// ux2 — wallet balance view model
//
// CONTRACT UNDER TEST
//   export type ShopBalanceViewModel =
//     | { readonly kind: 'known'; readonly amount: bigint; readonly label: string } // 'Gold: 123'
//     | { readonly kind: 'unknown' };
//   `balance` is present on BOTH ShopViewModel and NoShopViewModel (§T5: "so the
//   shell never decides to clear").
//   buildShopViewModel(shops, shopItems, itemDefs, ownInventory, ownWallet?)
//   — the 5th parameter is OPTIONAL; the totality guard is
//   `typeof ownWallet?.balance === 'bigint'` (NOT truthiness, NOT `!= null`).
//
// THE SEMANTIC INVARIANT: "broke" (0n, a known balance of zero) and "dark" (no
// wallet row subscribed yet) are DIFFERENT STATES and must never collapse into
// one another. §"Anti-patterns" 1 names zero-conflation as the primary hazard.
//
// LABEL FORMAT is spec-pinned to `Gold: <amount>` (§T5 comment "'Gold: 123'").
// It is asserted exactly so that a label which drops the amount, or which renders
// `Gold: undefined`, cannot pass.
// ===========================================================================

type KnownBalance = Extract<ShopBalanceViewModel, { kind: 'known' }>;

function makeStoreWallet(balance: bigint, ownerIdentity = 'own-player'): StoreWallet {
  return { ownerIdentity, balance };
}

// ---------------------------------------------------------------------------
// [ux2-M1] The 5th parameter is OPTIONAL — both existing main.ts call sites are 4-arg
// ---------------------------------------------------------------------------

describe('buildShopViewModel [ux2-M1]: 4-argument call (the existing main.ts shape) → balance unknown', () => {
  it('[ux2-M1] BITES: exactly FOUR arguments → balance.kind === "unknown" (no wallet ⇒ dark)', () => {
    // The 5th (wallet) parameter is optional; a missing wallet must degrade to `unknown`.
    // Kills: (a) a required 5th parameter (this call would be a compile error and the
    //            impl would read `undefined.balance` at runtime);
    //        (b) `balance ?? 0n` zero-conflation — it would report kind:'known' here,
    //            painting a permanent, false "Gold: 0" for every player.
    const shops = [makeShop(1, 'General Store')];
    const defs = new Map([[3, makeItemDef(3, { name: 'Potion' })]]);
    const shopItems = [makeShopItem(1n, 1, 3, 50n)];

    const result = buildShopViewModel(shops, shopItems, defs, []) as ShopViewModel;

    expect(result.kind).toBe('shop');
    expect(result.balance.kind).toBe('unknown');
    // The unknown arm carries NO amount and NO label — illegal states are not representable.
    expect((result.balance as Partial<KnownBalance>).amount).toBeUndefined();
    expect((result.balance as Partial<KnownBalance>).label).toBeUndefined();
  });

  it('[ux2-M1] BITES: 4-argument call on the no-shop path also yields balance.kind === "unknown"', () => {
    // The no-shop early path must produce the same dark state, not a missing `balance`
    // field (which would make the shell crash on `vm.balance.kind`).
    const result = buildShopViewModel([], [], new Map(), []) as NoShopViewModel;

    expect(result.kind).toBe('no-shop');
    expect(result.balance).toBeDefined();
    expect(result.balance.kind).toBe('unknown');
  });

  it('[ux2-M1] BITES: an explicitly-undefined 5th argument behaves exactly like omitting it', () => {
    // Kills: an impl that distinguishes "argument absent" from "argument undefined"
    // (e.g. via `arguments.length`): main.ts passes `store.ownWallet(identity)`, which
    // legitimately returns undefined.
    const shops = [makeShop(1)];
    const omitted = buildShopViewModel(shops, [], new Map(), []) as ShopViewModel;
    const explicit = buildShopViewModel(shops, [], new Map(), [], undefined) as ShopViewModel;

    expect(explicit.balance).toEqual(omitted.balance);
    expect(explicit.balance.kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// [ux2-M2] CORE SEMANTIC TOOTH — 0n is KNOWN, and "broke" never collapses into "dark"
// ---------------------------------------------------------------------------

describe('buildShopViewModel [ux2-M2]: a 0n balance is KNOWN — broke is not the same state as dark', () => {
  it('[ux2-M2] BITES: ownWallet with balance 0n → kind:"known", amount:0n, label:"Gold: 0"', () => {
    // THE anti-pattern-1 kill (zero-conflation). Wrong impls that die here:
    //   `wallet?.balance ? known : unknown`      → 0n is falsy → reports 'unknown'
    //   `if (wallet?.balance) {...}`             → same
    //   `wallet && wallet.balance ? ... : ...`   → same
    //   a label built from a truthiness fallback (`balance || '—'`) → label ≠ 'Gold: 0'
    // A player who has just spent their last gold MUST see "Gold: 0", not a hidden
    // readout that is indistinguishable from "the wallet view has not arrived yet".
    const shops = [makeShop(1, 'General Store')];

    const result = buildShopViewModel(
      shops,
      [],
      new Map(),
      [],
      makeStoreWallet(0n),
    ) as ShopViewModel;

    expect(result.balance.kind).toBe('known');
    const known = result.balance as KnownBalance;
    expect(known.amount).toBe(0n); // bigint literal — `0` (number) dies here
    expect(typeof known.amount).toBe('bigint');
    expect(known.label).toBe('Gold: 0');
  });

  it('[ux2-M2] BITES: the 0n (broke) result is DISTINGUISHABLE from the no-wallet (dark) result', () => {
    // The two states must not collapse in EITHER direction:
    //   `balance ?? 0n` collapses dark → broke (dark would render 'Gold: 0');
    //   truthiness collapses broke → dark (0n would render nothing).
    // This asserts the discriminants differ AND that no string the dark arm can
    // produce equals the broke label.
    const shops = [makeShop(1)];

    const broke = buildShopViewModel(
      shops,
      [],
      new Map(),
      [],
      makeStoreWallet(0n),
    ) as ShopViewModel;
    const dark = buildShopViewModel(shops, [], new Map(), []) as ShopViewModel;

    expect(broke.balance.kind).toBe('known');
    expect(dark.balance.kind).toBe('unknown');
    expect(broke.balance.kind).not.toBe(dark.balance.kind);
    // The dark arm produces NO label at all, so it can never be mistaken for 'Gold: 0'.
    expect((dark.balance as Partial<KnownBalance>).label).toBeUndefined();
    expect((broke.balance as KnownBalance).label).not.toBe(
      (dark.balance as Partial<KnownBalance>).label,
    );
  });

  it('[ux2-M2] BITES: a positive balance keeps the exact bigint amount and the spec label format', () => {
    // Kills: an impl that Number()-casts the amount (2^53+1 is lossy) or that formats
    // the label without the amount.
    const shops = [makeShop(1)];
    const huge = 9007199254740993n; // 2^53 + 1

    const result = buildShopViewModel(
      shops,
      [],
      new Map(),
      [],
      makeStoreWallet(huge),
    ) as ShopViewModel;

    const known = result.balance as KnownBalance;
    expect(typeof known.amount).toBe('bigint');
    expect(known.amount).toBe(huge);
    expect(known.label).toBe('Gold: 9007199254740993');
  });
});

// ---------------------------------------------------------------------------
// [ux2-M3] `balance` is present on the no-shop variant too
// ---------------------------------------------------------------------------

describe('buildShopViewModel [ux2-M3]: no-shop + a wallet → kind "no-shop" AND balance "known"', () => {
  it('[ux2-M3] BITES: empty shops + wallet(123n) → { kind:"no-shop", balance:{kind:"known", amount:123n} }', () => {
    // §T5: `balance` is present on BOTH variants "so the shell never decides to clear".
    // Kills: an impl that computes the balance only on the `shop` path and returns a
    // bare `{ kind: 'no-shop' }` — the shell would then read `vm.balance.kind` off
    // undefined and THROW inside a store batch listener (starving its siblings).
    const result = buildShopViewModel([], [], new Map(), [], makeStoreWallet(123n));

    expect(result.kind).toBe('no-shop');
    const noShop = result as NoShopViewModel;
    expect(noShop.balance).toBeDefined();
    expect(noShop.balance.kind).toBe('known');
    expect((noShop.balance as KnownBalance).amount).toBe(123n);
    expect((noShop.balance as KnownBalance).label).toBe('Gold: 123');
  });

  it('[ux2-M3] BITES: the SAME wallet yields the SAME balance vm on the shop and no-shop paths', () => {
    // Kills: an impl that duplicates the mapping and lets the two copies drift (e.g.
    // 'Gold: 5' on one path and '5 gold' on the other).
    const withShop = buildShopViewModel(
      [makeShop(1)],
      [],
      new Map(),
      [],
      makeStoreWallet(5n),
    ) as ShopViewModel;
    const withoutShop = buildShopViewModel(
      [],
      [],
      new Map(),
      [],
      makeStoreWallet(5n),
    ) as NoShopViewModel;

    expect(withoutShop.balance).toEqual(withShop.balance);
  });
});

// ---------------------------------------------------------------------------
// [ux2-M4] Malformed wallet rows degrade to `unknown` — and NEVER throw
// ---------------------------------------------------------------------------

describe('buildShopViewModel [ux2-M4]: malformed wallet row → unknown, never throws', () => {
  it('[ux2-M4] BITES: { ownerIdentity:"x", balance: undefined } → balance.kind "unknown" (no throw)', () => {
    // §T5: `typeof ownWallet?.balance === 'bigint'` is the totality guard. A row that
    // arrives with a missing field (bad binding, hand-built fake, future schema drift)
    // must degrade to `unknown`, never render 'Gold: undefined', and never throw —
    // a throw here starves sibling store batch listeners (shopModel.ts header contract).
    // Kills: `ownWallet !== undefined ? known : unknown` and `ownWallet != null ? …`,
    // both of which report kind:'known' with a garbage label for this input.
    const malformed = { ownerIdentity: 'x', balance: undefined } as unknown as StoreWallet;
    const shops = [makeShop(1)];

    let result!: ShopScreenViewModel;
    expect(() => {
      result = buildShopViewModel(shops, [], new Map(), [], malformed);
    }).not.toThrow();

    expect(result.balance.kind).toBe('unknown');
    expect((result.balance as Partial<KnownBalance>).label).toBeUndefined();
  });

  it('[ux2-M4] BITES: a NUMBER balance (100, not 100n) → "unknown" — typeof discipline, not truthiness', () => {
    // A number is truthy and non-null, so ONLY the `typeof === 'bigint'` guard rejects it.
    // Kills: `!= null` and truthiness guards, which would emit kind:'known' from a
    // lossy Number-typed balance and silently normalise a precision bug into the UI.
    const numeric = { ownerIdentity: 'x', balance: 100 } as unknown as StoreWallet;

    const result = buildShopViewModel([makeShop(1)], [], new Map(), [], numeric) as ShopViewModel;

    expect(result.balance.kind).toBe('unknown');
  });

  it('[ux2-M4] BITES: a STRING balance ("100") → "unknown" (no coercion into the label)', () => {
    // Kills: an impl that builds the label by interpolation without checking the type —
    // it would print a plausible-looking 'Gold: 100' from an untyped value.
    const stringy = { ownerIdentity: 'x', balance: '100' } as unknown as StoreWallet;

    const result = buildShopViewModel([makeShop(1)], [], new Map(), [], stringy) as ShopViewModel;

    expect(result.balance.kind).toBe('unknown');
  });

  it('[ux2-M4] BITES: a null wallet argument → "unknown" (no throw)', () => {
    // `store.ownWallet()` returns `undefined`, but a null can reach here through any
    // untyped call site. Optional chaining handles it; a bare `ownWallet.balance` throws.
    const nullish = null as unknown as StoreWallet | undefined;

    let result!: ShopScreenViewModel;
    expect(() => {
      result = buildShopViewModel([makeShop(1)], [], new Map(), [], nullish);
    }).not.toThrow();

    expect(result.balance.kind).toBe('unknown');
  });
});

// ===========================================================================
// buildShopViewModelForShop: BOUND shop selection.
//
// CONTRACT:
//   export function buildShopViewModelForShop(
//     shopId: number,
//     shops: readonly StoreShopRow[],
//     shopItems: readonly StoreShopItemRow[],
//     itemDefs: ReadonlyMap<number, StoreItemRow>,
//     ownInventory: readonly StoreInventory[],
//     ownWallet?: StoreWallet,
//   ): ShopScreenViewModel
//   THIN: filter `shops` to the named id, then DELEGATE to buildShopViewModel. An
//   unknown id yields `{ kind:'no-shop', balance }` — never a silent fall back to the
//   first shop (ADR-0161 D5: "never silently swap a bound shop to first-shop").
//
// ===========================================================================

describe('buildShopViewModelForShop [uxd2-1]: selects the NAMED shop, not the first', () => {
  it('★ [uxd2-1] BITES: with shops {1,2,3} loaded, shopId 2 returns SHOP 2 (kills a first-shop copy-paste)', () => {
    // WRONG IMPL KILLED (the dominant one): a body that ignores its `shopId` argument and
    // just calls `buildShopViewModel(shops, …)` — which sorts by shopId and takes [0]. That
    // impl returns shop 1 here and would silently open the wrong shop for every shopkeeper
    // except the lowest-id one. The fixture deliberately uses a MIDDLE id so neither
    // "first" nor "last" accidentally matches.
    const shops = [makeShop(3, 'Third Shop'), makeShop(1, 'First Shop'), makeShop(2, 'Tideglass')];
    const defs = new Map([
      [10, makeItemDef(10, { name: 'Potion' })],
      [20, makeItemDef(20, { name: 'Antidote' })],
      [30, makeItemDef(30, { name: 'Ether' })],
    ]);
    const shopItems = [
      makeShopItem(1n, 1, 10, 50n),
      makeShopItem(2n, 2, 20, 60n),
      makeShopItem(3n, 3, 30, 70n),
    ];
    const result = buildShopViewModelForShop(2, shops, shopItems, defs, []) as ShopViewModel;
    expect(result.kind).toBe('shop');
    expect(result.shopId).toBe(2);
    expect(result.shopName).toBe('Tideglass');
    // …and only shop 2's stock (kills a filter-the-shop-but-not-the-items impl).
    expect(result.forSale).toHaveLength(1);
    expect(result.forSale[0]!.itemId).toBe(20);
    expect(result.forSale[0]!.name).toBe('Antidote');
  });

  it('[uxd2-1] BITES: shopId 3 (the HIGHEST id) is selectable too', () => {
    // WRONG IMPL KILLED: `[...shops].sort(...)[0]` with the filter applied AFTER the sort,
    // or a `shops.find(s => s.shopId >= shopId)`-style near-miss lookup.
    const shops = [makeShop(1, 'First Shop'), makeShop(2, 'Tideglass'), makeShop(3, 'Third Shop')];
    const result = buildShopViewModelForShop(3, shops, [], new Map(), []) as ShopViewModel;
    expect(result.shopId).toBe(3);
    expect(result.shopName).toBe('Third Shop');
  });

  it('★ [uxd2-1] BITES: shopId 0 is a valid bound id (falsy-0 trap)', () => {
    // WRONG IMPL KILLED: `if (!shopId) return buildShopViewModel(shops, …)` — a truthiness
    // guard on the bound id would fall back to the first shop for shop 0 (representable u32),
    // the exact silent-swap ADR-0161 D5 forbids.
    const shops = [makeShop(0, 'Zero Shop'), makeShop(1, 'First Shop')];
    const result = buildShopViewModelForShop(0, shops, [], new Map(), []) as ShopViewModel;
    expect(result.kind).toBe('shop');
    expect(result.shopId).toBe(0);
    expect(result.shopName).toBe('Zero Shop');
  });
});

describe('buildShopViewModelForShop [uxd2-2]: unknown id → no-shop, never a fallback', () => {
  it('★ [uxd2-2] BITES: an unknown shopId returns { kind:"no-shop" } — NOT the first shop', () => {
    // WRONG IMPL KILLED: a "be helpful" fallback to the first shop when the bound id is not
    // (yet) in the store. During the reconnect hydration gap the shop rows can be missing for
    // a beat; a fallback would open a DIFFERENT shop's catalogue under the shopkeeper the
    // player actually walked up to, and a buy would spend real gold on the wrong item.
    const shops = [makeShop(1, 'First Shop'), makeShop(2, 'Tideglass')];
    const shopItems = [makeShopItem(1n, 1, 10, 50n)];
    const result = buildShopViewModelForShop(99, shops, shopItems, new Map(), []);
    expect(result.kind).toBe('no-shop');
    expect(result).not.toHaveProperty('shopId');
    expect(result).not.toHaveProperty('forSale');
  });

  it('[uxd2-2] BITES: an EMPTY shops array with any id → no-shop (no throw)', () => {
    // WRONG IMPL KILLED: a non-null assertion on the filtered array's [0].
    let result!: ShopScreenViewModel;
    expect(() => {
      result = buildShopViewModelForShop(1, [], [], new Map(), []);
    }).not.toThrow();
    expect(result.kind).toBe('no-shop');
  });

  it('★ [uxd2-2] BITES: the no-shop arm still carries the wallet balance (passthrough)', () => {
    // `balance` is present on BOTH arms so the shell never has to decide to clear.
    // WRONG IMPL KILLED: an early `return { kind:'no-shop' }` written inside ForShop instead
    // of delegating — it would drop the balance field and crash the shell on `vm.balance.kind`.
    const wallet = makeStoreWallet(1234n);
    const result = buildShopViewModelForShop(99, [makeShop(1)], [], new Map(), [], wallet);
    expect(result.kind).toBe('no-shop');
    expect(result.balance.kind).toBe('known');
    expect((result.balance as KnownBalance).amount).toBe(1234n);
    expect((result.balance as KnownBalance).label).toBe('Gold: 1234');
  });

  it('[uxd2-2] BITES: omitting the wallet on the no-shop arm yields "unknown", not a fabricated 0', () => {
    // WRONG IMPL KILLED: `balance: { kind:'known', amount: 0n, … }` invented locally.
    const result = buildShopViewModelForShop(99, [makeShop(1)], [], new Map(), []);
    expect(result.balance.kind).toBe('unknown');
  });
});

describe('buildShopViewModelForShop [uxd2-3]: delegation is REAL (sell side + wallet)', () => {
  it('★ [uxd2-3] BITES: forSaleByPlayer + balance are computed exactly as the default arm does', () => {
    // WRONG IMPL KILLED: a hand-rolled reimplementation of the shop VM inside ForShop that
    // forgets the inventory aggregation / canSell rule / balance label. The assertion is a
    // DIFFERENTIAL one: for a single-shop store, ForShop(thatId) must be deeply equal to the
    // default arm's output — which is the cheapest possible proof of "thin filter + delegate"
    // and simultaneously re-pins the default arm as unchanged (AC-10′).
    const shops = [makeShop(1, 'General Store')];
    const defs = new Map([
      [1, makeItemDef(1, { name: 'Herb', sellPrice: 15n })],
      [2, makeItemDef(2, { name: 'Quest Scroll', sellPrice: 0n })],
      [10, makeItemDef(10, { name: 'Potion' })],
    ]);
    const shopItems = [makeShopItem(1n, 1, 10, 50n)];
    const inv = [
      makeInventoryItem(1n, 1, 5),
      makeInventoryItem(2n, 2, 1),
      makeInventoryItem(3n, 1, 2),
    ];
    const wallet = makeStoreWallet(0n); // "broke", NOT "dark" — must stay distinguishable

    const bound = buildShopViewModelForShop(1, shops, shopItems, defs, inv, wallet);
    const dflt = buildShopViewModel(shops, shopItems, defs, inv, wallet);
    expect(bound).toEqual(dflt);

    // Spot-pin a few delegated values so a "both are equally broken" impl cannot pass.
    const vm = bound as ShopViewModel;
    expect(vm.balance.kind).toBe('known');
    expect((vm.balance as KnownBalance).amount).toBe(0n);
    const herb = vm.forSaleByPlayer.find((i) => i.itemId === 1);
    expect(herb?.count).toBe(7); // 5 + 2 aggregated across two stacks
    expect(herb?.canSell).toBe(true);
    expect(vm.forSaleByPlayer.find((i) => i.itemId === 2)?.canSell).toBe(false);
  });
});

// ===========================================================================
// ctl-7d: the shop quantity rule (CTL7D.3) and the success-line formatter (CTL7D.4).
//
// CONTRACT UNDER TEST (`ui/shopModel.ts`):
//   validShopQty(qty: number): boolean
//     true exactly for an integer from 1 to 4294967295 (the buy / sell reducers' u32). Adapters
//     are untyped at runtime, so the rule is total over ANY value and answers the boolean itself.
//   type ShopFeedback =
//     | { kind: 'item'; qty: number; name: string; gold: bigint }
//     | { kind: 'count'; qty: number };
//   buyFeedback(shopId, itemId, qty, shopItems, itemDefs): ShopFeedback
//     the name from the item definition, the unit price from the shop-item row of THE COMMAND'S
//     shop for that item; gold = buyPrice * qty, in bigint.
//   sellFeedback(itemId, qty, itemDefs): ShopFeedback
//     the name and sellPrice from the item definition; gold = sellPrice * qty.
//   The name is the definition's string VERBATIM (untrimmed, uncut, and '' is a name); gold is
//   exact at any size (no 64-bit wrap).
//   A needed row missing, a malformed field, or a qty that is not validShopQty: the count arm,
//   never a throw, never a partial line, never an `Unknown (#N)` name.
//
// main.ts's dispatch call site is not try/catch-wrapped, so a throw here would escape dispatch:
// totality is load-bearing. Every expectation below is a literal, never derived from the model.
// ===========================================================================

describe('validShopQty (ctl-7d, CTL7D.3): the u32 quantity a buy or sell may send', () => {
  it('CTL7D-3-QTY-RULE: validShopQty is true exactly for the integers 1 to 4294967295 and false, without throwing, for zero, negatives, fractions, everything past the u32, the non-finite numbers and every non-number', () => {
    // WRONG IMPL KILLED: a validator that leans on the coercions the SDK's u32 writer applies
    // (`DataView.setUint32` turns -1 into 4294967295, 2^32 + 3 into 3, 1.5 into 1, '3' into 3):
    // `(qty >>> 0) >= 1` (accepts -1 and 2^32 + 1); `qty % 1 === 0 && qty >= 1 && qty <= MAX`
    // (accepts '3', true, [3], new Number(3) and { valueOf }, and THROWS on 3n and a Symbol); the
    // global `isFinite` (coerces '3'); an off-by-one at either bound (0 accepted, 1 refused,
    // 4294967295 refused, 2^32 accepted); `qty > 0` alone (0.9999999999999999 and 1.5 pass); a
    // clamp that answers a number (`Math.max(1, qty | 0)`) instead of the boolean; and a throw.
    const ACCEPT: ReadonlyArray<readonly [string, number]> = [
      ['1 (the lower bound)', 1],
      ['2', 2],
      ['2^31 (past the i32 range)', 2 ** 31],
      ['4294967295 (the u32 maximum)', 4_294_967_295],
    ];
    const REJECT: ReadonlyArray<readonly [string, unknown]> = [
      ['0', 0],
      ['-0', -0],
      ['0.9999999999999999 (1 - 2^-53)', 1 - 2 ** -53],
      ['1.5', 1.5],
      ['-1 (wraps to 4294967295)', -1],
      ['2^32 (wraps to 0)', 2 ** 32],
      ['2^32 + 1 (wraps to 1)', 2 ** 32 + 1],
      ['2^53', 2 ** 53],
      ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
      ['1e21', 1e21],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['NaN', Number.NaN],
      ["the string '3'", '3'],
      ['the empty string', ''],
      ['true', true],
      ['null', null],
      ['undefined', undefined],
      ['the array [3]', [3]],
      ['{ valueOf: () => 3 }', { valueOf: () => 3 }],
      ['new Number(3)', Reflect.construct(Number, [3])],
      ['the bigint 3n', 3n],
      ["Symbol('q')", Symbol('q')],
    ];
    expect(ACCEPT, 'ANTI-VACUITY: four accepted quantities').toHaveLength(4);
    expect(REJECT, 'ANTI-VACUITY: twenty-three refused values').toHaveLength(23);

    for (const [label, qty] of ACCEPT) {
      let got: unknown;
      expect(() => {
        got = validShopQty(qty);
      }, `${label}: never throws`).not.toThrow();
      expect(got, `${label} is a sendable quantity (the boolean true)`).toBe(true);
    }
    for (const [label, value] of REJECT) {
      let got: unknown;
      expect(() => {
        // Adapters are untyped at runtime: the value reaches the rule as it is.
        got = validShopQty(value as number);
      }, `${label}: never throws`).not.toThrow();
      expect(got, `${label} is refused (the boolean false)`).toBe(false);
    }
  });
});

describe('buyFeedback / sellFeedback (ctl-7d, CTL7D.4): what a successful buy or sell moved', () => {
  it('CTL7D-4-FORMATTER: buyFeedback names the item and charges buyPrice x qty from the command`s own shop row, sellFeedback names it and credits sellPrice x qty, in bigint; a missing row gives the quantity alone; malformed rows and an invalid quantity never throw and give the count arm; inputs are not mutated', () => {
    // WRONG IMPL KILLED: gold computed through Number (2^53 + 1 times 3 comes back ...976n) or
    // the unit price instead of the total (qty >= 2 with total != unit); the buy price read off
    // the first row for the ITEM whatever its shop (two shops stock Bait at 20 and 35, in both row
    // orders), off another item of the same shop, or off the bound / lowest shop instead of the
    // command's `shopId` (shop 0 is a real, falsy id); the sell credit read off a shop's buy price
    // instead of the definition's sellPrice; a partial line (`{ kind: 'item', qty, name }` with no
    // gold) or an `Unknown (#12)` name when a row is missing; a stray key on either arm; a
    // malformed row coerced into a plausible line (`BigInt(20)` for a number price, `String(42)`
    // for a number name) or one that throws (Number x BigInt); `BigInt(qty)` on an invalid
    // quantity (throws on 1.5 and NaN, or prints a zero-gold line for 0); an input edited in place;
    // a total wrapped to 64 bits (`BigInt.asUintN(64, ...)`: 2^63 x 4 comes back 0n); and a name
    // that is not carried verbatim (`name.trim()`, `name.slice(0, 40)`, or '' treated as missing).
    const PAST_2_53 = 9_007_199_254_740_993n; // 2^53 + 1: Number(PAST_2_53) is ...992
    const BAIT = Object.freeze(makeItemDef(7, { name: 'Bait', sellPrice: 15n }));
    const BERRY = Object.freeze(makeItemDef(8, { name: 'Berry', sellPrice: 10n }));
    const RELIC = Object.freeze(makeItemDef(9, { name: 'Relic', sellPrice: PAST_2_53 }));
    const defs: ReadonlyMap<number, StoreItemRow> = new Map([
      [7, BAIT],
      [8, BERRY],
      [9, RELIC],
    ]);
    // Shop 3 stocks Berry, Bait, the Relic and item 12 (no definition loaded); shop 0 stocks Bait
    // dearer. Two shops stock Bait, so in each order one shop's Bait row is not the first Bait
    // row; and a row for ANOTHER item of shop 3 is the very first row in both orders.
    const listed: readonly StoreShopItemRow[] = Object.freeze(
      [
        makeShopItem(1n, 3, 8, 11n),
        makeShopItem(2n, 3, 7, 20n),
        makeShopItem(3n, 0, 7, 35n),
        makeShopItem(4n, 3, 9, PAST_2_53),
        makeShopItem(5n, 3, 12, 5n),
      ].map((row) => Object.freeze(row)),
    );
    const reversed: readonly StoreShopItemRow[] = Object.freeze([...listed].reverse());

    const item = (qty: number, name: string, gold: bigint): ShopFeedback => ({
      kind: 'item',
      qty,
      name,
      gold,
    });
    const count = (qty: number): ShopFeedback => ({ kind: 'count', qty });

    type Case = readonly [label: string, run: () => ShopFeedback, want: ShopFeedback];
    const cases: Case[] = [];
    for (const [order, rows] of [
      ['rows as listed', listed],
      ['rows reversed', reversed],
    ] as const) {
      cases.push(
        [
          `${order}: buy 2 Bait at shop 3`,
          () => buyFeedback(3, 7, 2, rows, defs),
          item(2, 'Bait', 40n),
        ],
        [
          `${order}: buy 2 Bait at shop 0`,
          () => buyFeedback(0, 7, 2, rows, defs),
          item(2, 'Bait', 70n),
        ],
        [
          `${order}: buy 3 Relic priced past 2^53`,
          () => buyFeedback(3, 9, 3, rows, defs),
          item(3, 'Relic', 27_021_597_764_222_979n),
        ],
        [`${order}: buy 1 Berry`, () => buyFeedback(3, 8, 1, rows, defs), item(1, 'Berry', 11n)],
        [
          `${order}: buy the u32 maximum of Bait`,
          () => buyFeedback(3, 7, 4_294_967_295, rows, defs),
          item(4_294_967_295, 'Bait', 85_899_345_900n),
        ],
        [
          `${order}: buy item 12 (stocked, no definition loaded)`,
          () => buyFeedback(3, 12, 3, rows, defs),
          count(3),
        ],
        [
          `${order}: buy the Relic at shop 0, which another shop stocks but shop 0 does not`,
          () => buyFeedback(0, 9, 3, rows, defs),
          count(3),
        ],
        [
          `${order}: buy Bait at shop 5, which is not loaded`,
          () => buyFeedback(5, 7, 2, rows, defs),
          count(2),
        ],
        [
          `${order}: buy with no item definitions loaded`,
          () => buyFeedback(3, 7, 2, rows, new Map()),
          count(2),
        ],
      );
    }
    cases.push(
      ['buy with no shop-item rows loaded', () => buyFeedback(3, 7, 2, [], defs), count(2)],
      ['buy with nothing loaded', () => buyFeedback(3, 7, 2, [], new Map()), count(2)],
      ['sell 3 Berry', () => sellFeedback(8, 3, defs), item(3, 'Berry', 30n)],
      [
        'sell 4 Bait (its sellPrice, never a shop`s buy price)',
        () => sellFeedback(7, 4, defs),
        item(4, 'Bait', 60n),
      ],
      ['sell 1 Bait', () => sellFeedback(7, 1, defs), item(1, 'Bait', 15n)],
      [
        'sell 3 Relic priced past 2^53',
        () => sellFeedback(9, 3, defs),
        item(3, 'Relic', 27_021_597_764_222_979n),
      ],
      ['sell item 12 (no definition loaded)', () => sellFeedback(12, 4, defs), count(4)],
      ['sell with no item definitions loaded', () => sellFeedback(8, 3, new Map()), count(3)],
    );

    // No 64-bit wrap, and the name carried verbatim. Their own frozen rows, so the fixtures above
    // (and the purity checks below) are untouched.
    const TWO_63 = 9_223_372_036_854_775_808n; // 2^63
    const TWO_65 = 36_893_488_147_419_103_232n; // 2^65 = 2^63 x 4, which wraps to 0n in 64 bits
    const SPACED = '  Spaced Bait  ';
    const LONG = 'Grandmaster Ultra Premium Deluxe Golden Lure of the Abyss';
    expect(LONG.length, 'fixture: the long name is past 40 characters').toBeGreaterThan(40);
    const extraDefs: ReadonlyMap<number, StoreItemRow> = new Map(
      [
        makeItemDef(20, { name: 'Crown', sellPrice: TWO_63 }),
        makeItemDef(21, { name: SPACED, sellPrice: 7n }),
        makeItemDef(22, { name: LONG, sellPrice: 9n }),
        makeItemDef(23, { name: '', sellPrice: 11n }),
      ].map((def) => [def.id, Object.freeze(def)] as const),
    );
    const extraRows: readonly StoreShopItemRow[] = Object.freeze(
      [
        makeShopItem(20n, 3, 20, TWO_63),
        makeShopItem(21n, 3, 21, 13n),
        makeShopItem(22n, 3, 22, 17n),
        makeShopItem(23n, 3, 23, 19n),
      ].map((row) => Object.freeze(row)),
    );
    cases.push(
      [
        'buy 4 Crown at 2^63 each: no 64-bit wrap',
        () => buyFeedback(3, 20, 4, extraRows, extraDefs),
        item(4, 'Crown', TWO_65),
      ],
      [
        'sell 4 Crown at 2^63 each: no 64-bit wrap',
        () => sellFeedback(20, 4, extraDefs),
        item(4, 'Crown', TWO_65),
      ],
      [
        'buy 2 of a name with leading and trailing spaces: kept untrimmed',
        () => buyFeedback(3, 21, 2, extraRows, extraDefs),
        item(2, SPACED, 26n),
      ],
      [
        'sell 2 of a name with leading and trailing spaces: kept untrimmed',
        () => sellFeedback(21, 2, extraDefs),
        item(2, SPACED, 14n),
      ],
      [
        'buy 2 of a name past 40 characters: kept whole',
        () => buyFeedback(3, 22, 2, extraRows, extraDefs),
        item(2, LONG, 34n),
      ],
      [
        'sell 2 of a name past 40 characters: kept whole',
        () => sellFeedback(22, 2, extraDefs),
        item(2, LONG, 18n),
      ],
      [
        "buy 2 of the empty name '': a string, so the item arm",
        () => buyFeedback(3, 23, 2, extraRows, extraDefs),
        item(2, '', 38n),
      ],
      [
        "sell 2 of the empty name '': a string, so the item arm",
        () => sellFeedback(23, 2, extraDefs),
        item(2, '', 22n),
      ],
    );
    expect(
      cases,
      'ANTI-VACUITY: 9 buy cases per row order, 2 more buys, 6 sells, 2 no-wrap and 6 verbatim-name',
    ).toHaveLength(34);

    const ITEM_KEYS = ['gold', 'kind', 'name', 'qty'];
    const COUNT_KEYS = ['kind', 'qty'];
    for (const [label, run, want] of cases) {
      let got!: ShopFeedback;
      expect(() => {
        got = run();
      }, `${label}: never throws`).not.toThrow();
      // toStrictEqual: an extra `name: undefined` or a number `gold` fails as well.
      expect(got, label).toStrictEqual(want);
      expect(Object.keys(got).sort(), `${label}: exactly the ${want.kind} arm's keys`).toEqual(
        want.kind === 'item' ? ITEM_KEYS : COUNT_KEYS,
      );
    }

    // Totality: malformed row fields and invalid quantities degrade to the count arm, never throw.
    const priced = (buyPrice: unknown): StoreShopItemRow =>
      ({ ...makeShopItem(6n, 4, 7), buyPrice }) as unknown as StoreShopItemRow;
    const definedAs = (overrides: Record<string, unknown>): ReadonlyMap<number, StoreItemRow> =>
      new Map([
        [
          7,
          makeItemDef(7, {
            name: 'Bait',
            sellPrice: 15n,
            ...overrides,
          } as unknown as Partial<StoreItemRow>),
        ],
      ]);
    const degraded: Array<readonly [string, () => ShopFeedback]> = [
      ['buy: a number buyPrice', () => buyFeedback(4, 7, 2, [priced(20)], defs)],
      ['buy: an undefined buyPrice', () => buyFeedback(4, 7, 2, [priced(undefined)], defs)],
      ['buy: a number name', () => buyFeedback(3, 7, 2, listed, definedAs({ name: 42 }))],
      [
        'buy: an undefined name',
        () => buyFeedback(3, 7, 2, listed, definedAs({ name: undefined })),
      ],
      ['sell: a number sellPrice', () => sellFeedback(7, 2, definedAs({ sellPrice: 15 }))],
      [
        'sell: an undefined sellPrice',
        () => sellFeedback(7, 2, definedAs({ sellPrice: undefined })),
      ],
      ['sell: a null name', () => sellFeedback(7, 2, definedAs({ name: null }))],
    ];
    const BAD_QTY: ReadonlyArray<readonly [string, unknown]> = [
      ['1.5', 1.5],
      ['NaN', Number.NaN],
      ['0', 0],
      ['-1', -1],
      ['2^32', 2 ** 32],
      ['Infinity', Number.POSITIVE_INFINITY],
      ["the string '3'", '3'],
      ["Symbol('q')", Symbol('q')],
    ];
    for (const [label, qty] of BAD_QTY) {
      degraded.push(
        [`buy 2 Bait with qty ${label}`, () => buyFeedback(3, 7, qty as number, listed, defs)],
        [`sell Berry with qty ${label}`, () => sellFeedback(8, qty as number, defs)],
      );
    }
    expect(degraded, 'ANTI-VACUITY: 7 malformed rows and 8 invalid quantities x 2').toHaveLength(
      23,
    );
    for (const [label, run] of degraded) {
      let got!: ShopFeedback;
      expect(() => {
        got = run();
      }, `${label}: never throws`).not.toThrow();
      expect(got.kind, `${label}: degrades to the quantity-only line`).toBe('count');
    }

    // Purity: every row was frozen (an in-place write throws in an ES module), and the definition
    // map and both row lists are exactly as built after every call above.
    expect([...defs.entries()], 'the definition map was not edited').toEqual([
      [7, BAIT],
      [8, BERRY],
      [9, RELIC],
    ]);
    expect(defs.get(7), 'the very frozen definition row').toBe(BAIT);
    expect(
      listed.map((row) => row.shopItemId),
      'the listed rows kept their order',
    ).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(reversed.map((row) => row.shopItemId)).toEqual([5n, 4n, 3n, 2n, 1n]);
    expect(
      [BAIT, BERRY, RELIC, ...listed].every((row) => Object.isFrozen(row)),
      'fixture: every input row is frozen',
    ).toBe(true);
  });
});
