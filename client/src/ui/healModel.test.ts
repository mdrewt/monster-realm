// ui/healModel.test.ts — M12d red-phase tests for buildHealViewModel.
// SOURCE OF TRUTH: docs/m12d-plan.md + docs/adr/0071-m12d-client-dialogue-quest-heal-ui.md
//
// Tests are INTENTIONALLY RED until healModel.ts is implemented.
// Do NOT edit to match a buggy implementation — correct from the spec only.
//
// Contract: buildHealViewModel(healLocations, itemDefs) -> HealViewModel
//   - HealViewModel { locations: readonly HealLocationViewModel[] }
//   - HealLocationViewModel { locationId, zoneId, tileX, tileY,
//       costItemName: string|null, costQty: number, cooldownMs: number, isFree: boolean }
//   - isFree = costItemId is undefined AND costQty === 0
//   - costItemName resolved from itemDefs by costItemId (null when not found or free)
//   - TOTAL: never throws
//
// Pattern follows raisingModel.test.ts: pure function, no DOM, no SDK.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoreItemRow } from '../net/store';
import { buildHealViewModel, healTargetLocationId } from './healModel';

// ---------------------------------------------------------------------------
// Local type definition (mirrors what store.ts will export as StoreHealLocationRow).
// ---------------------------------------------------------------------------

interface StoreHealLocationRow {
  locationId: number;
  zoneId: number;
  tileX: number;
  tileY: number;
  costItemId?: number;
  costQty: number;
  cooldownMs: number;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeLocation(overrides: Partial<StoreHealLocationRow> = {}): StoreHealLocationRow {
  return {
    locationId: 1,
    zoneId: 0,
    tileX: 10,
    tileY: 15,
    costItemId: undefined,
    costQty: 0,
    cooldownMs: 30000,
    ...overrides,
  };
}

function makeItemDef(id: number, name = `Item-${id}`): StoreItemRow {
  return {
    id,
    name,
    description: `Desc for ${id}`,
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    // M13d: StoreItemRow gains sellPrice (bigint). Default 0n keeps existing heal tests intact.
    sellPrice: 0n,
  };
}

// ---------------------------------------------------------------------------
// Criterion 1 — Empty locations → locations: []
// ---------------------------------------------------------------------------

describe('buildHealViewModel criterion 1: empty locations → locations: []', () => {
  it('BITES: empty locations array → { locations: [] }', () => {
    // Kills: an impl that throws on empty input or returns a default list.
    const vm = buildHealViewModel([], new Map());
    expect(vm).toHaveProperty('locations');
    expect(Array.isArray(vm.locations)).toBe(true);
    expect(vm.locations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — Free location (costItemId undefined, costQty 0) → isFree: true
// ---------------------------------------------------------------------------

describe('buildHealViewModel criterion 2: free location', () => {
  it('BITES: costItemId=undefined, costQty=0 → isFree=true, costItemName=null', () => {
    // Kills: an impl that sets isFree based on costQty alone or costItemId alone.
    const loc = makeLocation({ costItemId: undefined, costQty: 0 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations).toHaveLength(1);
    expect(vm.locations[0]!.isFree).toBe(true);
    expect(vm.locations[0]!.costItemName).toBeNull();
    expect(vm.locations[0]!.costQty).toBe(0);
  });

  it('BITES: isFree is exactly boolean true (not 1, not "true")', () => {
    // Kills: an impl that returns a truthy non-boolean for isFree.
    const loc = makeLocation({ costItemId: undefined, costQty: 0 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.isFree).toBe(true);
    expect(typeof vm.locations[0]!.isFree).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — Paid location → costItemName resolved from itemDefs
// ---------------------------------------------------------------------------

describe('buildHealViewModel criterion 3: paid location resolves costItemName', () => {
  it('BITES: costItemId=2, costQty=1 → costItemName from itemDefs, isFree=false', () => {
    // Kills: an impl that ignores itemDefs and always returns costItemName=null.
    const loc = makeLocation({ costItemId: 2, costQty: 1 });
    const defs = new Map<number, StoreItemRow>([[2, makeItemDef(2, 'Power Root')]]);
    const vm = buildHealViewModel([loc], defs);
    expect(vm.locations).toHaveLength(1);
    expect(vm.locations[0]!.isFree).toBe(false);
    expect(vm.locations[0]!.costItemName).toBe('Power Root');
    expect(vm.locations[0]!.costQty).toBe(1);
  });

  it('BITES: isFree=false when costItemId is defined (even if costQty=0)', () => {
    // Edge case: if server sets costItemId but costQty=0, we still have an item reference.
    // The precise isFree contract is: costItemId is undefined AND costQty === 0.
    // Kills: an impl that only checks costQty===0 for isFree.
    const loc = makeLocation({ costItemId: 5, costQty: 0 });
    const defs = new Map<number, StoreItemRow>([[5, makeItemDef(5, 'Token')]]);
    const vm = buildHealViewModel([loc], defs);
    expect(vm.locations[0]!.isFree).toBe(false);
  });

  it('BITES: costQty=5 is passed through correctly', () => {
    // Kills: an impl that normalizes costQty to 1 or 0.
    const loc = makeLocation({ costItemId: 3, costQty: 5 });
    const defs = new Map<number, StoreItemRow>([[3, makeItemDef(3, 'Coin')]]);
    const vm = buildHealViewModel([loc], defs);
    expect(vm.locations[0]!.costQty).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — Unknown cost item → graceful fallback (no throw)
// ---------------------------------------------------------------------------

describe('buildHealViewModel criterion 4: unknown costItemId → graceful null fallback', () => {
  it('BITES: costItemId=99 not in itemDefs → costItemName=null (not throw)', () => {
    // Kills: an impl that throws when itemDefs.get(costItemId) returns undefined.
    // A throw here would starve batch listeners.
    const loc = makeLocation({ costItemId: 99, costQty: 1 });
    expect(() => {
      const vm = buildHealViewModel([loc], new Map());
      expect(vm.locations[0]!.costItemName).toBeNull();
    }).not.toThrow();
  });

  it('BITES: unknown costItemId → isFree is still false (item is required, just unknown name)', () => {
    // Kills: an impl that sets isFree=true when costItemName cannot be resolved.
    const loc = makeLocation({ costItemId: 999, costQty: 1 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.isFree).toBe(false);
    expect(vm.locations[0]!.costItemName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — cooldownMs passed through correctly
// ---------------------------------------------------------------------------

describe('buildHealViewModel criterion 5: cooldownMs pass-through', () => {
  it('BITES: cooldownMs=30000 is passed through verbatim', () => {
    // Kills: an impl that converts cooldownMs to seconds or resets it.
    const loc = makeLocation({ cooldownMs: 30000 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.cooldownMs).toBe(30000);
    expect(typeof vm.locations[0]!.cooldownMs).toBe('number');
  });

  it('BITES: cooldownMs=0 is preserved (free immediate heal)', () => {
    // Kills: an impl that treats cooldownMs=0 as "no cooldown set" and substitutes a default.
    const loc = makeLocation({ cooldownMs: 0 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.cooldownMs).toBe(0);
  });

  it('BITES: large cooldownMs (e.g. 86400000 = 24h) does not overflow or transform', () => {
    // Kills: an impl that clamps cooldownMs to a max value.
    const loc = makeLocation({ cooldownMs: 86400000 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.cooldownMs).toBe(86400000);
  });
});

// ---------------------------------------------------------------------------
// Criterion 6 — locationId and zoneId passed through correctly
// ---------------------------------------------------------------------------

describe('buildHealViewModel criterion 6: locationId and zoneId pass-through', () => {
  it('BITES: locationId=42, zoneId=3 are passed through verbatim', () => {
    // Kills: an impl that resequences locationId or hardcodes zoneId.
    const loc = makeLocation({ locationId: 42, zoneId: 3 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.locationId).toBe(42);
    expect(vm.locations[0]!.zoneId).toBe(3);
  });

  it('BITES: tileX and tileY are passed through correctly', () => {
    // Kills: an impl that drops tile coordinates from the VM.
    const loc = makeLocation({ tileX: 27, tileY: 42 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.tileX).toBe(27);
    expect(vm.locations[0]!.tileY).toBe(42);
  });

  it('BITES: multiple locations preserve their distinct locationIds', () => {
    // Kills: an impl that uses array index as locationId (would break heal_party dispatch).
    const locs = [
      makeLocation({ locationId: 10, zoneId: 0 }),
      makeLocation({ locationId: 20, zoneId: 1 }),
    ];
    const vm = buildHealViewModel(locs, new Map());
    expect(vm.locations).toHaveLength(2);
    const ids = vm.locations.map((l) => l.locationId);
    expect(ids).toContain(10);
    expect(ids).toContain(20);
  });

  it('BITES: HealLocationViewModel has all required fields (shape contract)', () => {
    // Kills: an impl that omits any of the required fields from the view model.
    const loc = makeLocation({
      locationId: 7,
      zoneId: 2,
      tileX: 13,
      tileY: 8,
      costItemId: 2,
      costQty: 1,
      cooldownMs: 60000,
    });
    const defs = new Map<number, StoreItemRow>([[2, makeItemDef(2, 'Herb')]]);
    const vm = buildHealViewModel([loc], defs);
    const entry = vm.locations[0]!;
    expect(entry).toHaveProperty('locationId', 7);
    expect(entry).toHaveProperty('zoneId', 2);
    expect(entry).toHaveProperty('tileX', 13);
    expect(entry).toHaveProperty('tileY', 8);
    expect(entry).toHaveProperty('costItemName', 'Herb');
    expect(entry).toHaveProperty('costQty', 1);
    expect(entry).toHaveProperty('cooldownMs', 60000);
    expect(entry).toHaveProperty('isFree', false);
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 — TOTAL: never throws on empty/missing inputs
// ---------------------------------------------------------------------------

describe('buildHealViewModel criterion 7: total function — never throws', () => {
  it('BITES: empty locations + empty itemDefs → no throw', () => {
    expect(() => {
      buildHealViewModel([], new Map());
    }).not.toThrow();
  });

  it('BITES: location with costItemId=undefined + empty itemDefs → no throw', () => {
    // Kills: an impl that tries itemDefs.get(undefined) and crashes.
    const loc = makeLocation({ costItemId: undefined });
    expect(() => {
      buildHealViewModel([loc], new Map());
    }).not.toThrow();
  });

  it('BITES: locationId=0 does not throw (falsy number)', () => {
    // Kills: an impl that guards `if (!locationId)` and crashes.
    const loc = makeLocation({ locationId: 0 });
    expect(() => {
      buildHealViewModel([loc], new Map());
    }).not.toThrow();
  });

  it('BITES fast-check: never throws for any valid location array', () => {
    // Property: no structurally valid location array should crash the pure model.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            locationId: fc.integer({ min: 0, max: 9999 }),
            zoneId: fc.integer({ min: 0, max: 99 }),
            tileX: fc.integer({ min: 0, max: 255 }),
            tileY: fc.integer({ min: 0, max: 255 }),
            costItemId: fc.option(fc.integer({ min: 1, max: 999 })),
            costQty: fc.integer({ min: 0, max: 99 }),
            cooldownMs: fc.integer({ min: 0, max: 86400000 }),
          }),
          { maxLength: 20 },
        ),
        (locs) => {
          const mapped = locs.map((l) => ({
            ...l,
            costItemId: l.costItemId ?? undefined,
          }));
          expect(() => {
            buildHealViewModel(mapped, new Map());
          }).not.toThrow();
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// M13.5b §D / ADR-0085 — healTargetLocationId
//
// RED REASON: `healTargetLocationId` is not yet exported from `./healModel` —
// the named import at the top of this file causes a TS compile error until the
// implementer adds the export. Every test in this block is red for that reason.
//
// API CONTRACT (pinned):
//   healTargetLocationId(locations: readonly { locationId: number }[]): number | undefined
//   - []           → undefined  (the SKIP signal — NOT `?? 0`)
//   - [a]          → a.locationId
//   - [a, b, ...]  → a.locationId (first wins)
// ---------------------------------------------------------------------------

describe('healTargetLocationId (M13.5b ADR-0085 §D)', () => {
  it('empty array → undefined (the SKIP signal, not 0)', () => {
    // Kills: the `?? 0` doomed-send bug — an impl that returns 0 for an empty
    // list would cause healParty({ locationId: 0 }) to be sent to the server,
    // guaranteed to produce an invisible Err (no location with id 0 exists).
    // The SKIP signal must be `undefined`, not a falsy number.
    const result = healTargetLocationId([]);
    expect(result).toBeUndefined();
    // Extra proof: explicitly not 0 (the exact doomed-send value).
    expect(result).not.toBe(0);
  });

  it('single location → returns its locationId', () => {
    // Kills: an impl that returns undefined for a non-empty array (over-conservative).
    const result = healTargetLocationId([{ locationId: 7 }]);
    expect(result).toBe(7);
  });

  it('single location with locationId=0 → returns 0 (falsy id is valid)', () => {
    // Kills: an impl that returns undefined for falsy locationId values.
    // locationId=0 IS a valid id when the array is non-empty.
    const result = healTargetLocationId([{ locationId: 0 }]);
    expect(result).toBe(0);
  });

  it('multiple locations → returns the FIRST locationId (current behavior contract)', () => {
    // Kills: an impl that returns the last element, the min, the max, or undefined.
    // The spec says "first, matching current behavior".
    const result = healTargetLocationId([
      { locationId: 42 },
      { locationId: 7 },
      { locationId: 100 },
    ]);
    expect(result).toBe(42); // first wins
  });

  it('two locations → first wins over second', () => {
    // Kills: an impl that returns the second element or picks by min/max.
    expect(healTargetLocationId([{ locationId: 10 }, { locationId: 20 }])).toBe(10);
    expect(healTargetLocationId([{ locationId: 20 }, { locationId: 10 }])).toBe(20);
  });

  it('extra properties on location objects are ignored (structural subtype)', () => {
    // Kills: an impl that requires an exact HealLocationViewModel shape and crashes
    // on a minimal { locationId } object.
    const locs = [{ locationId: 55, zoneId: 1, tileX: 5, tileY: 5 }];
    expect(healTargetLocationId(locs)).toBe(55);
  });
});
