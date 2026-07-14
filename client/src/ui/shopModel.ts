// ui/shopModel.ts — pure view model for the shop screen (M13d, ADR-0084).
//
// No DOM, no SDK, no side-effects. Never throws on any input — a throw
// here would starve sibling store batch-listeners (store.ts one-way flow).
//
// player_wallet is PRIVATE (ADR-0081/0040); balance is not accessible via
// subscription — only reducer-feedback messages are available to the client.
// Shop catalog comes from the public shop_row / shop_item_row tables.
// Sell eligibility is data-driven: sellPrice > 0n (ADR-0047 classify-by-data).
import type { StoreInventory, StoreItemRow, StoreShopItemRow, StoreShopRow } from '../net/store';

export interface ShopItemViewModel {
  readonly shopItemId: bigint;
  readonly itemId: number;
  readonly name: string;
  readonly buyPrice: bigint;
}

export interface ShopInventoryItemViewModel {
  readonly invId: bigint;
  readonly itemId: number;
  readonly name: string;
  readonly count: number;
  readonly sellPrice: bigint;
  readonly canSell: boolean;
}

export interface ShopViewModel {
  readonly kind: 'shop';
  readonly shopId: number;
  readonly shopName: string;
  readonly forSale: readonly ShopItemViewModel[];
  readonly forSaleByPlayer: readonly ShopInventoryItemViewModel[];
}

export interface NoShopViewModel {
  readonly kind: 'no-shop';
}

export type ShopScreenViewModel = ShopViewModel | NoShopViewModel;

/**
 * Build the shop screen view model from pure subscription data.
 *
 * Selects the first shop from `shops`. Returns NoShopViewModel when shops is
 * empty. All resolution is null-safe — missing itemDef entries produce
 * "Unknown (#N)" names rather than crashes (ADR-0014 total-function contract).
 */
export function buildShopViewModel(
  shops: readonly StoreShopRow[],
  shopItems: readonly StoreShopItemRow[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
  ownInventory: readonly StoreInventory[],
): ShopScreenViewModel {
  if (shops.length === 0) return { kind: 'no-shop' };

  // Sort by shopId for deterministic first-shop selection regardless of Map insertion order.
  // biome-ignore lint/style/noNonNullAssertion: shops.length===0 returns early on line above
  const shop = [...shops].sort((a, b) => a.shopId - b.shopId)[0]!;
  const { shopId, name: shopName } = shop;

  const forSale: ShopItemViewModel[] = shopItems
    .filter((si) => si.shopId === shopId)
    .map((si) => {
      const def = itemDefs.get(si.itemId);
      return {
        shopItemId: si.shopItemId,
        itemId: si.itemId,
        name: def?.name ?? `Unknown (#${si.itemId})`,
        buyPrice: si.buyPrice,
      };
    });

  // Aggregate inventory by itemId: the sell reducer operates on itemId (not invId),
  // so rendering one row per stack creates a false affordance of per-stack targeting.
  const byItemId = new Map<number, { invId: bigint; count: number }>();
  for (const inv of ownInventory) {
    const existing = byItemId.get(inv.itemId);
    if (existing === undefined) {
      byItemId.set(inv.itemId, { invId: inv.invId, count: inv.count });
    } else {
      byItemId.set(inv.itemId, { invId: existing.invId, count: existing.count + inv.count });
    }
  }
  const forSaleByPlayer: ShopInventoryItemViewModel[] = [...byItemId.entries()].map(
    ([itemId, { invId, count }]) => {
      const def = itemDefs.get(itemId);
      const sellPrice = def?.sellPrice ?? 0n;
      return {
        invId,
        itemId,
        name: def?.name ?? `Unknown (#${itemId})`,
        count,
        sellPrice,
        canSell: sellPrice > 0n,
      };
    },
  );

  return { kind: 'shop', shopId, shopName, forSale, forSaleByPlayer };
}
