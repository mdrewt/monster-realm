// ui/healModel.ts — pure heal location view model (M12d, ADR-0071).
// TOTAL: never throws.
import type { StoreHealLocationRow, StoreItemRow } from '../net/store';

export interface HealLocationViewModel {
  locationId: number;
  zoneId: number;
  tileX: number;
  tileY: number;
  costItemName: string | null;
  costQty: number;
  cooldownMs: number;
  isFree: boolean; // costItemId === undefined AND costQty === 0
}

export interface HealViewModel {
  locations: ReadonlyArray<HealLocationViewModel>;
}

export function buildHealViewModel(
  healLocations: readonly StoreHealLocationRow[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): HealViewModel {
  return {
    locations: healLocations.map((loc) => {
      const isFree = loc.costItemId === undefined && loc.costQty === 0;
      const costItemName =
        loc.costItemId !== undefined ? (itemDefs.get(loc.costItemId)?.name ?? null) : null;
      return {
        locationId: loc.locationId,
        zoneId: loc.zoneId,
        tileX: loc.tileX,
        tileY: loc.tileY,
        costItemName,
        costQty: loc.costQty,
        cooldownMs: loc.cooldownMs,
        isFree,
      };
    }),
  };
}
