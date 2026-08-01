// ui/healModel.ts — pure heal location view model (M12d, ADR-0071).
// TOTAL: never throws.
//
// 11r-g (ADR-0170 D3): the heal-cost currency seam. The builders accept an
// optional `costCurrency` on each input row and the VM carries a REQUIRED
// `costCurrency` (absent ⇒ 0 via `??`), with `isFree` requiring all THREE cost
// channels empty. The input field is INERT until the parked `cost_currency`
// column lands (ADR-0170 residual 1) — today's store rows never carry it, so
// absent ⇒ 0 is production's path.
import type { StoreHealLocationRow, StoreItemRow } from '../net/store';

/**
 * Builder input row: the net-layer store row widened by the not-yet-wired
 * currency cost (ADR-0170 D3). Plain `StoreHealLocationRow[]` remains
 * assignable — the extra field is optional on the INPUT only.
 */
type HealLocationInputRow = StoreHealLocationRow & { readonly costCurrency?: number };

export interface HealLocationViewModel {
  locationId: number;
  zoneId: number;
  tileX: number;
  tileY: number;
  costItemName: string | null;
  costQty: number;
  // REQUIRED (not optional) so every future consumer must reckon with it —
  // an optional field could be silently `?? 0`-ed past (ADR-0170 D3).
  costCurrency: number;
  cooldownMs: number;
  isFree: boolean; // costItemId === undefined AND costQty === 0 AND costCurrency === 0
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

/**
 * Bound-location view (uxd2, ADR-0161 D5): the heal view model for ONE
 * location id. THIN filter-then-delegate — cost/isFree resolution stays in
 * buildHealViewModel. Unknown id → `{ locations: [] }` (never the full list,
 * never the first pad, never a throw). `===` on the id — location id 0 is a
 * valid bound id (falsy-0 trap).
 */
export function buildHealViewModelForLocation(
  locationId: number,
  healLocations: readonly HealLocationInputRow[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): HealViewModel {
  return buildHealViewModel(
    healLocations.filter((loc) => loc.locationId === locationId),
    itemDefs,
  );
}

export function buildHealViewModel(
  healLocations: readonly HealLocationInputRow[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): HealViewModel {
  return {
    locations: healLocations.map((loc) => {
      // `??`, never `||` (ADR-0170 D3): a NaN cost must survive as NaN — `|| 0`
      // would launder a corrupt row into "Free heal". Pure projection, no clamping.
      const costCurrency = loc.costCurrency ?? 0;
      const isFree = loc.costItemId === undefined && loc.costQty === 0 && costCurrency === 0;
      const costItemName =
        loc.costItemId !== undefined ? (itemDefs.get(loc.costItemId)?.name ?? null) : null;
      return {
        locationId: loc.locationId,
        zoneId: loc.zoneId,
        tileX: loc.tileX,
        tileY: loc.tileY,
        costItemName,
        costQty: loc.costQty,
        costCurrency,
        cooldownMs: loc.cooldownMs,
        isFree,
      };
    }),
  };
}
