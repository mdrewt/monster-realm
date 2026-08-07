// ui/healModel.ts — pure heal location view model (M12d, ADR-0071).
// TOTAL: never throws.
//
// 12r-d (closes ADR-0170 residual 1): the heal-cost currency seam is LIVE.
// `StoreHealLocationRow.costCurrency` is a REQUIRED bigint fed from the
// `heal_location_row.cost_currency` column (u64 — bigint end-to-end, same
// no-Number() doctrine as the wallet balance; see rowConvert.ts), so the VM
// carries it verbatim and `isFree` requires all THREE cost channels empty.
import type { StoreHealLocationRow, StoreItemRow } from '../net/store';

export interface HealLocationViewModel {
  locationId: number;
  zoneId: number;
  tileX: number;
  tileY: number;
  costItemName: string | null;
  costQty: number;
  // REQUIRED (not optional) so every future consumer must reckon with it —
  // an optional field could be silently defaulted past (ADR-0170 D3, amended
  // 12r-d: bigint, not number — a Number() hop lies above 2^53).
  costCurrency: bigint;
  cooldownMs: number;
  isFree: boolean; // costItemId === undefined AND costQty === 0 AND costCurrency === 0n
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
  healLocations: readonly StoreHealLocationRow[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): HealViewModel {
  return buildHealViewModel(
    healLocations.filter((loc) => loc.locationId === locationId),
    itemDefs,
  );
}

export function buildHealViewModel(
  healLocations: readonly StoreHealLocationRow[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): HealViewModel {
  return {
    locations: healLocations.map((loc) => {
      // Pure projection, no clamping, no Number() hop — the bigint is carried
      // verbatim (rowConvert.ts wallet doctrine; a float round-trip lies at 2^53).
      const costCurrency = loc.costCurrency;
      const isFree = loc.costItemId === undefined && loc.costQty === 0 && costCurrency === 0n;
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

/**
 * The cost line the heal overlay renders for one location (12r-d, closes
 * ADR-0170 residual 1's display arm). Pure + TOTAL: never throws, never returns
 * an empty string. The item wording is byte-identical to the pre-12r-d shell
 * (`3x Herb` / `1x Unknown item`) — this function exists so the currency channel
 * cannot be silently dropped by the coverage-excluded DOM shell: a currency-only
 * pad used to render as `0x Unknown item` (the silent-debit trap).
 * Currency wording follows the shop/trade precedent (`N gold`).
 */
export function formatHealCostLine(loc: HealLocationViewModel): string {
  if (loc.isFree) return 'Free';
  const parts: string[] = [];
  if (loc.costQty > 0 || loc.costItemName !== null) {
    parts.push(`${loc.costQty}x ${loc.costItemName ?? 'Unknown item'}`);
  }
  if (loc.costCurrency !== 0n) {
    parts.push(`${loc.costCurrency} gold`);
  }
  if (parts.length === 0) {
    // Unreachable from buildHealViewModel (isFree covers the all-empty shape);
    // a hand-built inconsistent VM still gets the legacy non-free rendering
    // rather than a lie ('Free') or an empty line.
    return `${loc.costQty}x ${loc.costItemName ?? 'Unknown item'}`;
  }
  return parts.join(' + ');
}
