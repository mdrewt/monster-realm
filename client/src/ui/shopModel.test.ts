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
import type { StoreInventory, StoreItemRow, StoreWallet } from '../net/store';
import {
  buildShopViewModel,
  // uxd2 (ADR-0161 D5): the bound-shop selector. Named import — RED until it exists.
  buildShopViewModelForShop,
  type NoShopViewModel,
  type ShopBalanceViewModel,
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
  // ux2 (ADR-0154) EXTENSION: this property now also carries the OPTIONAL 5th
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
// ux2 (ADR-0154) — wallet balance view model
//
// SOURCE OF TRUTH: ux2 build plan v3 §T5 + "Client unit tests".
// Tests are INTENTIONALLY RED until shopModel.ts grows the balance arm.
// Do NOT edit them to match a buggy implementation — correct from the plan only.
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
    // §T5 / anti-pattern 8: main.ts is FORBIDDEN in this slice and has TWO call sites
    // (:701-708 KeyG and :1265-1279 the batch listener). Both stay 4-arg, so the 5th
    // parameter must be optional AND the no-wallet case must degrade to `unknown`.
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
    // (e.g. via `arguments.length`), which would diverge once ux2b wires
    // `store.ownWallet(identity)` — that expression legitimately returns undefined.
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
// uxd2 (ADR-0161 D5) — buildShopViewModelForShop: BOUND shop selection.
// APPENDED BLOCK — every case above this line is untouched and is the
// byte-preservation guard for the first-shop DEFAULT arm (plan AC-10′).
//
// SOURCE OF TRUTH: docs/specs/uxd2-plan.md I6 + AC-10′ + docs/adr/0161-*.md §D5.
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
// RED TODAY: `buildShopViewModelForShop` is not exported from ./shopModel, so this
// file's named import fails to link and the WHOLE file is red. That is the intended
// red state (healModel.test.ts / helpModel.test.ts precedent) — the existing cases
// come back green the moment the export exists, unchanged.
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
    // ADR-0154: `balance` is present on BOTH arms so the shell never has to decide to clear.
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
