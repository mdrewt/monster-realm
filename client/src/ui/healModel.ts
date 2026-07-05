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

/**
 * Pick the heal location to target: the FIRST location's id (matching the
 * pre-M13.5b behavior), or `undefined` when none are loaded (M13.5b, ADR-0085 §D).
 *
 * WHY `undefined` and not 0: the old call site did `locations[0]?.locationId ?? 0`
 * — with no locations loaded it dispatched the heal reducer with locationId 0, a
 * guaranteed-invisible server `Err` (no location 0 exists). `undefined` is the
 * SKIP signal: the caller must not send at all (and surfaces "no heal location
 * available" instead — ADR-0085 A9). TOTAL: never throws (matching this module's
 * contract); a falsy-but-present locationId (0) on a non-empty array is valid.
 */
export function healTargetLocationId(
  locations: readonly { locationId: number }[],
): number | undefined {
  return locations[0]?.locationId;
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
