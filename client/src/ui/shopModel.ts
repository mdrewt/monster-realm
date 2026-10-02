// ui/shopModel.ts — pure view model for the shop screen.
//
// No DOM, no SDK, no side-effects. Total for every well-typed input, and
// malformed row FIELDS degrade to a safe value rather than throwing (see the
// wallet malformed-row teeth) — a throw here would starve sibling store batch-listeners
// (store.ts one-way flow). It is not hardened against a hostile argument (a
// null `shops`, a throwing getter): unreachable from the store, and the view-model
// call sites are try/catch-wrapped with per-listener isolation (M10.5d). The quantity
// rule and the feedback facts run inside main.ts's `dispatch` with no try around them,
// where a throw would hold the shop's in-flight lock: they never throw.
//
// The wallet table stays PRIVATE; the
// balance reaches the client through the owner-scoped `my_wallet` view only, as
// an optional StoreWallet. Absent or malformed ⇒ `unknown`, never a fabricated 0.
// Shop catalog comes from the public shop_row / shop_item_row tables.
// Sell eligibility is data-driven: sellPrice > 0n (classify-by-data).
import type {
  StoreInventory,
  StoreItemRow,
  StoreShopItemRow,
  StoreShopRow,
  StoreWallet,
} from '../net/store';

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

/**
 * The player's gold readout. Two arms, so "broke" (a known
 * balance of 0n) and "dark" (the wallet view has not arrived) can never
 * collapse into one another, and `{kind:'known'}` without an amount is not
 * representable.
 */
export type ShopBalanceViewModel =
  | { readonly kind: 'known'; readonly amount: bigint; readonly label: string }
  | { readonly kind: 'unknown' };

export interface ShopViewModel {
  readonly kind: 'shop';
  readonly shopId: number;
  readonly shopName: string;
  readonly forSale: readonly ShopItemViewModel[];
  readonly forSaleByPlayer: readonly ShopInventoryItemViewModel[];
  readonly balance: ShopBalanceViewModel;
}

export interface NoShopViewModel {
  readonly kind: 'no-shop';
  /** Present on this variant too, so the shell never has to decide to clear. */
  readonly balance: ShopBalanceViewModel;
}

export type ShopScreenViewModel = ShopViewModel | NoShopViewModel;

/**
 * Map the optional own-wallet row to the balance view model.
 *
 * `typeof … === 'bigint'` is the totality guard, deliberately not truthiness
 * (which would misreport 0n as dark) and not `!= null` (which would let a
 * number or string through and render `Gold: 100` from a lossy value).
 * Module-private: the HUD does not exist yet and would likely want a different
 * string; exporting later is a one-word diff.
 */
function balanceViewModel(ownWallet: StoreWallet | undefined): ShopBalanceViewModel {
  const amount = ownWallet?.balance;
  if (typeof amount !== 'bigint') return { kind: 'unknown' };
  return { kind: 'known', amount, label: `Gold: ${amount}` };
}

/**
 * Build the shop screen view model from pure subscription data.
 *
 * Selects the first shop from `shops`. Returns NoShopViewModel when shops is
 * empty. All resolution is null-safe — missing itemDef entries produce
 * "Unknown (#N)" names rather than crashes (total-function contract).
 */
export function buildShopViewModel(
  shops: readonly StoreShopRow[],
  shopItems: readonly StoreShopItemRow[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
  ownInventory: readonly StoreInventory[],
  ownWallet?: StoreWallet,
): ShopScreenViewModel {
  const balance = balanceViewModel(ownWallet);
  if (shops.length === 0) return { kind: 'no-shop', balance };

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

  return { kind: 'shop', shopId, shopName, forSale, forSaleByPlayer, balance };
}

/**
 * Bound-shop selection: the view model for ONE named shop.
 * THIN filter-then-delegate — every rule (stock filter, inventory aggregation,
 * canSell, balance) stays in buildShopViewModel, exactly once. An unknown id
 * filters to zero shops and delegates to the `no-shop` arm (balance included):
 * NEVER a silent fall back to the first shop ("never silently swap a bound
 * shop", D5). `===` on the id — a truthiness guard would break shop id 0.
 */
export function buildShopViewModelForShop(
  shopId: number,
  shops: readonly StoreShopRow[],
  shopItems: readonly StoreShopItemRow[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
  ownInventory: readonly StoreInventory[],
  ownWallet?: StoreWallet,
): ShopScreenViewModel {
  return buildShopViewModel(
    shops.filter((s) => s.shopId === shopId),
    shopItems,
    itemDefs,
    ownInventory,
    ownWallet,
  );
}

/** Whether `qty` fits the buy and sell reducers' u32 quantity: an integer from 1 to 4294967295.
 *  The SDK writes any other value as some u32 without complaint (-1 as 4294967295, 1.5 as 1), so
 *  the caller refuses it instead. False, never a throw, for anything that is not a number. */
export function validShopQty(qty: number): boolean {
  return Number.isInteger(qty) && qty >= 1 && qty <= 4294967295;
}

/** What a buy or sell moved, for its success line: the item and the gold when the rows that
 *  price it are loaded, else the quantity alone. */
export type ShopFeedback =
  | { readonly kind: 'item'; readonly qty: number; readonly name: string; readonly gold: bigint }
  | { readonly kind: 'count'; readonly qty: number };

/** The one rule both sides share. A missing or malformed name or price, or a quantity that is
 *  not sendable, gives the quantity alone: never a partial line, never a throw. */
function shopFeedback(qty: number, name: unknown, unitPrice: unknown): ShopFeedback {
  if (typeof name !== 'string' || typeof unitPrice !== 'bigint' || !validShopQty(qty)) {
    return { kind: 'count', qty };
  }
  return { kind: 'item', qty, name, gold: unitPrice * BigInt(qty) };
}

/** A buy of `qty` of `itemId` at `shopId`: the price is that shop's own stock row, as the
 *  reducer reads it. */
export function buyFeedback(
  shopId: number,
  itemId: number,
  qty: number,
  shopItems: readonly StoreShopItemRow[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): ShopFeedback {
  const stock = shopItems.find((si) => si.shopId === shopId && si.itemId === itemId);
  return shopFeedback(qty, itemDefs.get(itemId)?.name, stock?.buyPrice);
}

/** A sale of `qty` of `itemId`: the price is the item definition's `sellPrice`. */
export function sellFeedback(
  itemId: number,
  qty: number,
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): ShopFeedback {
  const def = itemDefs.get(itemId);
  return shopFeedback(qty, def?.name, def?.sellPrice);
}
