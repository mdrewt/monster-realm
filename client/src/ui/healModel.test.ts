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
// AMENDED 11r-g (ADR-0170 §D3) — nothing above is deleted; the amendment ADDS a
// required VM field and NARROWS isFree:
//   - HealLocationViewModel gains a REQUIRED `costCurrency`
//   - isFree = costItemId undefined AND costQty === 0 AND costCurrency === 0
//
// SUPERSEDED IN PLACE BY 12r-d — the seam is no longer inert and no longer `number`:
//   - `costCurrency` is a REQUIRED `bigint` on BOTH the store row and the VM (u64 column;
//     the wallet-balance doctrine at rowConvert.ts:543-568 applies — no Number(), no default)
//   - the builders take `readonly StoreHealLocationRow[]` DIRECTLY (the inert
//     `HealLocationInputRow` intersection is deleted)
//   - isFree = costItemId undefined AND costQty === 0 AND costCurrency === 0n
//   - NEW export `formatHealCostLine(loc: HealLocationViewModel): string`
// The 11r-g [V-*] block at the foot of this file is REPLACED by the 12r-d [W-*] block,
// which carries a per-case inventory: every retired V case has a named successor or an
// explicit moot-by-type entry. Nothing was weakened.
//
// Pattern follows raisingModel.test.ts: pure function, no DOM, no SDK.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
// 12r-d: the REAL store row type — the local mirror this file used to declare is gone.
// The builders consume `StoreHealLocationRow` directly now, so the fixtures below are
// typed against the SHIPPED shape and drift between the two is no longer expressible.
import type { StoreHealLocationRow, StoreItemRow } from '../net/store';
import {
  buildHealViewModel,
  // uxd2 (ADR-0161 D5): the bound-location selector. Named import — RED until it exists.
  buildHealViewModelForLocation,
  // 12r-d: the cost-line renderer healView.ts:25 delegates to. Named import — the WHOLE
  // file fails to link until the implementer exports it (the established red mode here).
  formatHealCostLine,
  type HealLocationViewModel,
  healTargetLocationId,
} from './healModel';

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
    // 12r-d: `costCurrency` is REQUIRED and bigint, so the default is an explicit 0n
    // (a FREE pad) rather than 11r-g's deliberate absence — absence is no longer a
    // representable input. Tests that need a currency cost pass it via `overrides`.
    costCurrency: 0n,
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
    // 11r-g (ADR-0170 §D3) EXTENSION, MIGRATED BY 12r-d — nothing above removed;
    // `costCurrency` joins the required-key contract, now as a BIGINT. The fixture row is
    // a free-of-currency pad (makeLocation's 0n default), so the required key must be
    // present as 0n — never the number 0, never `undefined`.
    // Kills: an impl that leaves the field off the VM entirely (consumers would read
    // `undefined` and healView would render a "Cost: undefined gold" pad); an impl that
    // Number()s the projection (0n and 0 differ under Object.is, and the typeof pin states
    // it outright); and — via the typed member access below — the type-level form of the
    // same defect (TS2339 against a HealLocationViewModel that lacks the key).
    expect(entry).toHaveProperty('costCurrency', 0n);
    expect(entry.costCurrency).toBe(0n);
    expect(typeof entry.costCurrency).toBe('bigint');
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
    // 11r-g EXTENSION (input domain only — the assertion below is untouched): the
    // generated rows now also carry a costCurrency, so this totality property covers
    // currency-bearing rows too. The VALUE invariants for that field live in the sibling
    // [12r-d W-5] property at the foot of this file.
    // 12r-d MIGRATION: the arbitrary moves to bigint and DROPS its `fc.option(…, {nil:
    // undefined})` wrapper — the field is required, so absence is unrepresentable.
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
            // 0n | anywhere in u64 | negative (unreachable from a u64 column, kept as the
            // adversarial arm — the model must project, never validate).
            costCurrency: fc.oneof(
              fc.constant(0n),
              fc.bigUintN(64),
              fc.bigInt({ min: -1000n, max: -1n }),
            ),
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

// ===========================================================================
// uxd2 (ADR-0161 D5) — buildHealViewModelForLocation: BOUND location view.
// APPENDED BLOCK — every case above this line is untouched. The
// `healTargetLocationId` first-location DEFAULT is deliberately unchanged
// (AC-10′ / adjudication 2: onHealParty's SEND keeps the first-location default;
// only the OVERLAY's VIEW binds, until a second heal location is seeded).
//
// SOURCE OF TRUTH: docs/specs/uxd2-plan.md I6 / AC-3 + docs/adr/0161-*.md §D5.
//
// CONTRACT:
//   export function buildHealViewModelForLocation(
//     locationId: number,
//     healLocations: readonly StoreHealLocationRow[],
//     itemDefs: ReadonlyMap<number, StoreItemRow>,
//   ): HealViewModel
//   THIN: filter to that one location, then DELEGATE to buildHealViewModel.
//   Unknown id → { locations: [] } (never all locations, never a throw).
//
// RED TODAY: `buildHealViewModelForLocation` is not exported from ./healModel, so the
// named import at the top of this file fails to link and the WHOLE file is red — the
// established red mode for this suite (see the healTargetLocationId block header).
// ===========================================================================

describe('buildHealViewModelForLocation [uxd2-1]: renders ONLY the bound location', () => {
  it('★ [uxd2-1] BITES: with locations {1,2,3} loaded, id 2 yields exactly one entry — location 2', () => {
    // WRONG IMPL KILLED (the dominant one): a body that ignores `locationId` and delegates
    // straight to buildHealViewModel(healLocations, …) — the KeyT heal arm would open an
    // overlay listing every pad in the world instead of the one the player is standing on.
    // The fixture uses a MIDDLE id so neither "first" nor "last" accidentally matches.
    const locs = [
      makeLocation({ locationId: 1, zoneId: 0, tileX: 8, tileY: 3 }),
      makeLocation({ locationId: 2, zoneId: 1, tileX: 4, tileY: 2, costItemId: 7, costQty: 2 }),
      makeLocation({ locationId: 3, zoneId: 1, tileX: 9, tileY: 5 }),
    ];
    const defs = new Map<number, StoreItemRow>([[7, makeItemDef(7, 'Tideglass Shard')]]);
    const vm = buildHealViewModelForLocation(2, locs, defs);
    expect(vm.locations).toHaveLength(1);
    const entry = vm.locations[0]!;
    expect(entry.locationId).toBe(2);
    expect(entry.zoneId).toBe(1);
    expect(entry.tileX).toBe(4);
    expect(entry.tileY).toBe(2);
    // Delegation proof: the cost resolution the default arm performs still happens here.
    expect(entry.costItemName).toBe('Tideglass Shard');
    expect(entry.costQty).toBe(2);
    expect(entry.isFree).toBe(false);
  });

  it('[uxd2-1] BITES: id 3 (the HIGHEST) is selectable — not just the first match', () => {
    // WRONG IMPL KILLED: `healLocations[0]`-style selection with the id argument used only
    // as a presence check.
    const locs = [
      makeLocation({ locationId: 1 }),
      makeLocation({ locationId: 2 }),
      makeLocation({ locationId: 3, tileX: 9, tileY: 5 }),
    ];
    const vm = buildHealViewModelForLocation(3, locs, new Map());
    expect(vm.locations).toHaveLength(1);
    expect(vm.locations[0]!.locationId).toBe(3);
    expect(vm.locations[0]!.tileX).toBe(9);
  });

  it('★ [uxd2-1] BITES: locationId 0 is a valid bound id (falsy-0 trap)', () => {
    // WRONG IMPL KILLED: `if (!locationId) return { locations: healLocations.map(…) }` or
    // `locationId || firstId` — a truthiness guard on a representable u32 id. The sibling
    // healTargetLocationId block already pins the same trap on the SEND side; this is the
    // VIEW side of it.
    const locs = [
      makeLocation({ locationId: 0, tileX: 2, tileY: 2 }),
      makeLocation({ locationId: 1 }),
    ];
    const vm = buildHealViewModelForLocation(0, locs, new Map());
    expect(vm.locations).toHaveLength(1);
    expect(vm.locations[0]!.locationId).toBe(0);
    expect(vm.locations[0]!.tileX).toBe(2);
  });
});

describe('buildHealViewModelForLocation [uxd2-2]: unknown id → empty, never a fallback', () => {
  it('★ [uxd2-2] BITES: an unknown id yields { locations: [] } — NOT the full list, NOT the first', () => {
    // WRONG IMPL KILLED (1): a fallback to the whole list when the id is not found — during
    //   the reconnect hydration gap the bound overlay would silently widen to every pad.
    // WRONG IMPL KILLED (2): a fallback to locations[0] — the overlay would offer a heal at a
    //   pad the player is nowhere near.
    const locs = [makeLocation({ locationId: 1 }), makeLocation({ locationId: 2 })];
    const vm = buildHealViewModelForLocation(99, locs, new Map());
    expect(Array.isArray(vm.locations)).toBe(true);
    expect(vm.locations).toHaveLength(0);
  });

  it('[uxd2-2] BITES: an EMPTY location array with any id → { locations: [] } (no throw)', () => {
    // WRONG IMPL KILLED: a non-null assertion on the filtered array's [0]. The batch listener
    // calls this on every heal-row update; a throw would starve the sibling listeners.
    let vm!: ReturnType<typeof buildHealViewModelForLocation>;
    expect(() => {
      vm = buildHealViewModelForLocation(1, [], new Map());
    }).not.toThrow();
    expect(vm.locations).toHaveLength(0);
  });

  it('★ [uxd2-2] BITES: differential — for a single-location store, ForLocation(thatId) equals the default arm', () => {
    // Cheapest possible proof of "thin filter + delegate" AND a re-pin of the untouched
    // default arm (AC-10′). WRONG IMPL KILLED: a hand-rolled reimplementation inside
    // ForLocation that drops isFree / costItemName / cooldownMs.
    const locs = [makeLocation({ locationId: 4, costItemId: 2, costQty: 1, cooldownMs: 60_000 })];
    const defs = new Map<number, StoreItemRow>([[2, makeItemDef(2, 'Herb')]]);
    expect(buildHealViewModelForLocation(4, locs, defs)).toEqual(buildHealViewModel(locs, defs));
  });
});

// ===========================================================================
// 12r-d [W-*] — THE HEAL COST CURRENCY DISPLAY PATH, IN THE BIGINT DOMAIN.
//
// This block REPLACES the 11r-g [V-1..V-5] block that stood here. Every case above this
// line is untouched except three MIGRATIONS forced by the type change (not weakenings):
// the criterion-6 shape contract now expects `0n` / typeof 'bigint', the criterion-7
// property's costCurrency arbitrary moved to bigint (its ASSERTION is unchanged), and
// the local StoreHealLocationRow mirror was replaced by an import of the real type.
//
// SOURCE OF TRUTH: 12r-d item 1 (the heal currency display path) +
//   docs/adr/0170-server-hardening-cache-completion-log-escaping.md §D3 (the seam).
//
// CONTRACT (pinned — the implementer builds exactly this in healModel.ts):
//   export interface HealLocationViewModel { …; costCurrency: bigint }  // REQUIRED
//   buildHealViewModel(
//     healLocations: readonly StoreHealLocationRow[],       // ← the row type DIRECTLY;
//     itemDefs: ReadonlyMap<number, StoreItemRow>,          //   HealLocationInputRow is
//   ): HealViewModel                                       //   DELETED
//   - costCurrency = `loc.costCurrency` — a bare pass-through (no ??, no Number(), no clamp)
//   - isFree = costItemId === undefined AND costQty === 0 AND costCurrency === 0n
//   - export function formatHealCostLine(loc: HealLocationViewModel): string
//   - the module stays TOTAL: never throws.
//
// WHY BIGINT: the cost is a u64. `Number()` is lossy above 2^53 and `BigInt(Number(x))`
// restores the TYPE while keeping the WRONG VALUE — the wallet-balance doctrine written
// out at rowConvert.ts:543-568, applied one layer up. WHY REQUIRED: an optional field can
// be `?? 0`-ed past by a future consumer, which is how the silent-debit gap opened in the
// first place (ADR-0170 Context item 3 — `spend_currency` charges correctly server-side;
// only the UI lies).
//
// formatHealCostLine WORDING FREEDOM (deliberate): the implementer chooses the currency
// wording. Only these are pinned, and only these are asserted:
//   * free               → EXACTLY the string 'Free'
//   * item-only          → EXACTLY `${costQty}x ${costItemName ?? 'Unknown item'}` — the
//                          byte-for-byte rendering healView.ts:25 produces TODAY, so no
//                          existing content's overlay text changes
//   * currency-only      → contains the amount rendered FROM THE BIGINT; contains neither
//                          '0x' nor 'Unknown item' (that pair IS the HEAD bug)
//   * both channels      → both renderings present
// Everything else about the currency phrasing is the implementer's to choose.
//
// ---------------------------------------------------------------------------
// PER-CASE INVENTORY — every retired [11r-g V-*] case, with its successor or an
// explicit moot-by-type entry. No case was dropped silently.
//
//  RETIRED [11r-g V-*] CASE                              → 12r-d DISPOSITION
//  1. V-1 "costCurrency=50 passed through verbatim"      → W-1a (50n, typeof 'bigint')
//  2. V-1 "huge 2**40 neither clamped nor bit-truncated" → W-1c (u64::MAX). NOTE the old
//        prey (`x | 0` / `x >>> 0`) is gone by TYPE — bitwise ops THROW on a bigint — so
//        the successor's real prey is Number()/clamping, pinned exactly by W-1b/W-1c.
//  3. V-2 "row with NO costCurrency key → 0"             → MOOT BY TYPE: the field is
//        REQUIRED on StoreHealLocationRow, so an absent key is unrepresentable in the
//        builder's input. The no-defaulting rule still has teeth one layer DOWN, where a
//        malformed SDK row can still arrive: rowConvert.test.ts RC-HL-CC-05.
//        HONEST LIMIT: store.test.ts's M12d block reaches the store through
//        `as unknown as Record<…>` casts, so a hand-rolled row COULD still omit the field
//        at runtime there; that is why RC-HL-CC-05 (converter) and ST-HL-CC-02 (adapter)
//        exist rather than a re-litigation of absence here.
//  4. V-2 "explicit costCurrency 0 → 0"                  → W-1d (0n stays 0n, not `0`)
//  5. V-1 "item cost AND currency cost both surfaced"    → W-1e (75n + 3x Herb)
//  6. V-1 "each row keeps its OWN costCurrency"          → W-1f ([10n, 0n, 250n])
//  7. V-3 "no item, qty 0, currency 50 → isFree FALSE"   → W-3a (50n)
//  8. V-3 "explicit currency 0 → isFree TRUE"            → W-3b (0n)
//  9. V-3 "ABSENT costCurrency leaves a free pad free"   → MOOT BY TYPE (same reason as 3).
//        The "free stays free" outcome it protected is pinned by W-3b and by row 1 of the
//        W-3c truth table.
// 10. V-3 "truth table: exactly 1 of 8 is free"          → W-3c (8 rows, 0n/50n)
// 11. V-4 "currency-only invents no item name"           → W-4a (55n)
// 12. V-4 "populated itemDefs leaks no name"             → W-4b (55n, defs with id 0 and 1)
// 13. V-5 "negative costCurrency passes through"         → W-1g (-25n)
// 14. V-5 "NaN survives as NaN (the ?? vs || tooth)"     → MOOT BY TYPE: there is no NaN in
//        the bigint domain, and `??` vs `||` can only diverge on a falsy-but-present value,
//        which for bigint is 0n alone — already pinned by W-1d (0n stays 0n) and W-3b
//        (0n keeps a pad FREE, which `|| 0n` also produces, so no behavioural gap remains).
//        SUCCESSOR DISCRIMINATOR (the exactness tooth that replaces it): W-1b — 2^53+1
//        survives byte-identically, which is IMPOSSIBLE under any Number()-based impl.
// 15. V-5 "fast-check: costCurrency === input, isFree ⇔ …" → W-5a (bigint domain)
// 16. V-1 bound-arm "ForLocation carries costCurrency"   → W-8a (60n)
// 17. V-1 bound-arm "ForLocation === default arm"        → W-8b (500n)
//  (17 retired it() cases → 24 replacements: 15 named successors, 2 moot-by-type, and a
//   surplus of 9 NEW cases — the formatHealCostLine branch table W-6a..W-6g, the
//   delegation pin W-7, and the second property W-5b. Net test count strictly UP.)
// ---------------------------------------------------------------------------
//
// RED TODAY: `formatHealCostLine` is not exported from ./healModel, so the named import
// at the top of this file fails to link and the WHOLE file is red — the established red
// mode for this suite (see the healTargetLocationId and uxd2 block headers). Underneath
// that, once the export exists, the VALUE teeth stay red until the projection changes:
// healModel.ts computes `costCurrency = loc.costCurrency ?? 0` (a NUMBER) and
// `isFree = … && costCurrency === 0`, and healView.ts:25 renders every non-free pad as
// `${costQty}x ${costItemName ?? 'Unknown item'}` — so a currency-only pad prints
// "0x Unknown item" today. The `.costCurrency` member accesses are ALSO a type-level RED
// (bigint vs number) — note client/tsconfig.json line 15 EXCLUDES `**/*.test.ts`, so that
// arm surfaces in the editor and NOT in `npm run typecheck`; the gating signal is the
// runtime failure under vitest.
// ===========================================================================

/** 2^53 + 1 — the smallest integer a JS `number` cannot represent. Number()-ing it
 *  yields 9007199254740992, which is the counter-value every exactness tooth names. */
const COST_2P53_PLUS_1 = 9007199254740993n;
/** 2^64 - 1 — the largest value the u64 `cost_currency` column can hold. */
const COST_U64_MAX = 18446744073709551615n;

/**
 * Digit-grouping-insensitive needle search. A locale-aware formatter
 * (`amount.toLocaleString()`) may insert separators, which is a legitimate wording
 * choice — so amount assertions strip them before searching. STRING OPERATIONS ONLY:
 * no `new RegExp(` anywhere in this file (the Semgrep ReDoS / non-literal-regexp gate).
 * NOTE the raw line, not this one, is used for the '0x' / 'Unknown item' ABSENCE
 * assertions, since stripping spaces would fuse 'Unknown item' into 'Unknownitem'.
 */
function stripDigitGrouping(s: string): string {
  let out = s;
  // Pass 1 — the ASCII grouping separators. `String(bigint)` emits none of them and an
  // en-US `toLocaleString()` emits only the comma, so this pass covers every realistic
  // wording the implementer might pick.
  for (const sep of [',', ' ', '_', "'"]) {
    out = out.split(sep).join('');
  }
  // Pass 2 — the same set plus the NBSP-family characters other locales group with.
  // Idempotent over pass 1 (split/join on an already-absent separator is a no-op).
  for (const sep of [',', ' ', '_', "'", ' ', ' ', ' ']) {
    out = out.split(sep).join('');
  }
  return out;
}

/** The single-location VM the cost-line table renders, built through the REAL builder
 *  so the branch table also proves the projection feeding it. */
function vmFor(
  overrides: Partial<StoreHealLocationRow>,
  defs: ReadonlyMap<number, StoreItemRow> = new Map(),
): HealLocationViewModel {
  const vm = buildHealViewModel([makeLocation(overrides)], defs);
  return vm.locations[0]!;
}

describe('buildHealViewModel [12r-d W-1]: costCurrency projection (bigint)', () => {
  it('★ [W-1a] BITES: costCurrency 50n is passed through verbatim as a bigint', () => {
    // Successor to V-1 "costCurrency=50 passed through verbatim".
    // Kills: an impl that drops the field, hardcodes 0n, re-derives it from costQty
    // (`BigInt(costQty)` would read 0n here), or Number()s it (50 !== 50n under Object.is,
    // and the typeof pin states the defect outright).
    const vm = buildHealViewModel([makeLocation({ costCurrency: 50n })], new Map());
    expect(vm.locations).toHaveLength(1);
    expect(vm.locations[0]!.costCurrency).toBe(50n);
    expect(typeof vm.locations[0]!.costCurrency).toBe('bigint');
  });

  it('★ [W-1b] BITES (DISCRIMINATOR): 2^53 + 1 survives byte-identically — impossible under a Number() projection', () => {
    // THE successor discriminator to the retired V-5 `?? 0` vs `|| 0` NaN tooth (see the
    // inventory in this block's header: NaN does not exist in the bigint domain).
    //   Number(9007199254740993n)         === 9007199254740992   (silently off by one)
    //   BigInt(Number(9007199254740993n)) === 9007199254740992n  (right TYPE, wrong VALUE)
    // A `costCurrency: Number(loc.costCurrency)` projection — or a VM field typed `number`
    // that the implementer "fixes" with a BigInt() round trip — dies exactly here. The
    // second assertion names the mutant's output so the failure reads as the diagnosis.
    const vm = buildHealViewModel([makeLocation({ costCurrency: COST_2P53_PLUS_1 })], new Map());
    const entry = vm.locations[0]!;
    expect(typeof entry.costCurrency).toBe('bigint');
    expect(entry.costCurrency).toBe(9007199254740993n);
    expect(
      entry.costCurrency,
      'costCurrency must NOT equal BigInt(Number(2^53+1)) === 9007199254740992n — that is ' +
        'exactly what a Number() round trip produces (rowConvert.ts:543-568 doctrine)',
    ).not.toBe(9007199254740992n);
    expect(entry.isFree).toBe(false);
  });

  it('[W-1c] BITES: u64::MAX is neither clamped nor truncated', () => {
    // Successor to V-1 "huge 2**40 neither clamped nor bit-truncated". The OLD prey
    // (`x | 0` / `x >>> 0`) is gone by TYPE — bitwise operators THROW on a bigint — so this
    // successor hunts the survivors: Math.min-style clamping, and the float round trip
    // (Number(u64::MAX) === 18446744073709551616, one ABOVE the true value, so a lossy impl
    // OVERSTATES the price). A 18-quintillion-gold pad must still read as not-free.
    const vm = buildHealViewModel([makeLocation({ costCurrency: COST_U64_MAX })], new Map());
    expect(vm.locations[0]!.costCurrency).toBe(18446744073709551615n);
    expect(vm.locations[0]!.costCurrency).not.toBe(BigInt(Number(COST_U64_MAX)));
    expect(vm.locations[0]!.isFree).toBe(false);
  });

  it('[W-1d] BITES: an explicit costCurrency 0n → 0n (a bigint zero, never the number 0, never undefined)', () => {
    // Successor to V-2 "explicit costCurrency 0 → 0". With the field REQUIRED, 0n is the
    // free-pad path production actually takes, so this is the case a dropped projection
    // (undefined) and a Number()-ed projection (the number 0) BOTH fail — `toBe` is
    // Object.is, under which 0n and 0 are different values.
    const vm = buildHealViewModel([makeLocation({ costCurrency: 0n })], new Map());
    expect(vm.locations[0]!.costCurrency).toBe(0n);
    expect(typeof vm.locations[0]!.costCurrency).toBe('bigint');
  });

  it('[W-1e] BITES: an item cost and a currency cost are BOTH surfaced on one row', () => {
    // Successor to V-1 "item cost AND currency cost both surfaced".
    // Kills: an impl that reads costCurrency only in the else-branch of "has an item cost"
    // — a hybrid pad would show the herb and hide the gold.
    const loc = makeLocation({ costItemId: 2, costQty: 3, costCurrency: 75n });
    const defs = new Map<number, StoreItemRow>([[2, makeItemDef(2, 'Herb')]]);
    const entry = buildHealViewModel([loc], defs).locations[0]!;
    expect(entry.costItemName).toBe('Herb');
    expect(entry.costQty).toBe(3);
    expect(entry.costCurrency).toBe(75n);
    expect(entry.isFree).toBe(false);
  });

  it('[W-1f] BITES: each row keeps its OWN costCurrency (no cross-row bleed)', () => {
    // Successor to V-1 "each row keeps its OWN costCurrency".
    // Kills: an impl that hoists one row's currency out of the per-row map callback, or
    // reuses the first/last row's value for the whole list. The MIDDLE row is the free one,
    // so a first-wins bleed and a last-wins bleed produce different wrong answers — both
    // caught by one toEqual.
    const locs = [
      makeLocation({ locationId: 1, costCurrency: 10n }),
      makeLocation({ locationId: 2, costCurrency: 0n }),
      makeLocation({ locationId: 3, costCurrency: 250n }),
    ];
    const vm = buildHealViewModel(locs, new Map());
    expect(vm.locations.map((l) => l.costCurrency)).toEqual([10n, 0n, 250n]);
    expect(vm.locations.map((l) => l.isFree)).toEqual([false, true, false]);
  });

  it('[W-1g] BITES: a negative costCurrency passes through unchanged (projection, not validation)', () => {
    // Successor to V-5 "negative costCurrency passes through". The column is u64 so this is
    // unreachable from a healthy server — the point is that the model does not invent a
    // policy anyway. Kills `Math.max`/`< 0n ? 0n :` laundering, which would turn nonsense
    // content into a plausible-looking FREE pad and HIDE the bad row instead of surfacing it.
    const vm = buildHealViewModel([makeLocation({ costCurrency: -25n })], new Map());
    expect(vm.locations[0]!.costCurrency).toBe(-25n);
    expect(vm.locations[0]!.isFree).toBe(false); // -25n !== 0n
  });
});

describe('buildHealViewModel [12r-d W-3]: isFree requires ALL THREE cost channels empty', () => {
  it('★ [W-3a] BITES: no item, costQty 0, costCurrency 50n → isFree FALSE (the silent-debit trap)', () => {
    // Successor to V-3 "currency 50 → isFree FALSE". THE decisive case. Kills the pre-0170
    // predicate `isFree = costItemId === undefined && costQty === 0`, which reports TRUE
    // here: a pure CONTENT edit (seed a gold cost on a pad) would then paint "Free heal"
    // over a charge the server happily debits. ADR-0170 Context (3) / §D3.
    const loc = makeLocation({ costItemId: undefined, costQty: 0, costCurrency: 50n });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.isFree).toBe(false);
    expect(typeof vm.locations[0]!.isFree).toBe('boolean');
  });

  it('[W-3b] BITES: no item, costQty 0, costCurrency 0n → isFree TRUE (a free pad stays free)', () => {
    // Successor to V-3 "explicit currency 0 → isFree TRUE" AND to the retired
    // "ABSENT costCurrency leaves a free pad free" case (absence is unrepresentable now —
    // 0n is the value every legacy free pad carries). Kills the OVER-correction: any impl
    // that treats "the currency field exists" as "there is a cost"
    // (`costCurrency !== undefined ? false : …`), which would grow a phantom price on every
    // free heal pad in the world.
    const loc = makeLocation({ costItemId: undefined, costQty: 0, costCurrency: 0n });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.isFree).toBe(true);
    expect(vm.locations[0]!.costItemName).toBeNull();
    expect(vm.locations[0]!.costCurrency).toBe(0n);
  });

  it('★ [W-3c] BITES: truth table — isFree is true in EXACTLY 1 of the 8 (item × qty × currency) combinations', () => {
    // Successor to V-3's truth table, in the bigint domain and still EXHAUSTIVE over the
    // three binary channels. Kills every partial predicate at once: `&&` swapped for `||`,
    // a dropped conjunct, a negated conjunct, or a two-of-three check. Only the all-empty
    // row may be free. The `0n` column also kills a `costCurrency` comparison written
    // against the NUMBER zero (`=== 0`), which is false for 0n and would flip every free
    // pad to paid — the mirror-image of the silent-debit bug.
    const cases: ReadonlyArray<{
      readonly costItemId: number | undefined;
      readonly costQty: number;
      readonly costCurrency: bigint;
      readonly isFree: boolean;
    }> = [
      { costItemId: undefined, costQty: 0, costCurrency: 0n, isFree: true },
      { costItemId: undefined, costQty: 0, costCurrency: 50n, isFree: false },
      { costItemId: undefined, costQty: 2, costCurrency: 0n, isFree: false },
      { costItemId: undefined, costQty: 2, costCurrency: 50n, isFree: false },
      { costItemId: 2, costQty: 0, costCurrency: 0n, isFree: false },
      { costItemId: 2, costQty: 0, costCurrency: 50n, isFree: false },
      { costItemId: 2, costQty: 2, costCurrency: 0n, isFree: false },
      { costItemId: 2, costQty: 2, costCurrency: 50n, isFree: false },
    ];
    expect(cases).toHaveLength(8); // the table itself is well-formed: all 8 combinations…
    expect(cases.filter((c) => c.isFree)).toHaveLength(1); // …and exactly one is free.
    for (const c of cases) {
      const vm = buildHealViewModel(
        [
          makeLocation({
            costItemId: c.costItemId,
            costQty: c.costQty,
            costCurrency: c.costCurrency,
          }),
        ],
        new Map(),
      );
      // Compare whole cases so a failure names the exact offending combination.
      expect({ ...c, actualIsFree: vm.locations[0]!.isFree }).toEqual({
        ...c,
        actualIsFree: c.isFree,
      });
    }
  });
});

describe('buildHealViewModel [12r-d W-4]: a currency-only cost invents no item name', () => {
  it('★ [W-4a] BITES: costCurrency 55n with no item cost → isFree false AND costItemName null', () => {
    // Successor to V-4 "currency-only invents no item name".
    // Kills: an impl that reaches for an item name whenever ANY cost exists (e.g. widening
    // `itemDefs.get(loc.costItemId ?? 0)?.name` into the currency branch). A gold cost must
    // never fabricate an item row — the overlay would print a nonexistent reagent. This is
    // the MODEL half of the HEAD bug; the RENDER half is [W-6d].
    const loc = makeLocation({ costItemId: undefined, costQty: 0, costCurrency: 55n });
    const entry = buildHealViewModel([loc], new Map()).locations[0]!;
    expect(entry.isFree).toBe(false);
    expect(entry.costItemName).toBeNull();
    expect(entry.costQty).toBe(0);
    expect(entry.costCurrency).toBe(55n);
  });

  it('[W-4b] BITES: a POPULATED itemDefs map leaks no name onto a currency-only row', () => {
    // Successor to V-4 "populated itemDefs leaks no name".
    // Kills: a fallback to itemDefs.get(0) / the first def when costItemId is undefined but
    // a cost is present — id 0 is a representable item id, so an empty map would not have
    // caught it.
    const loc = makeLocation({ costItemId: undefined, costQty: 0, costCurrency: 55n });
    const defs = new Map<number, StoreItemRow>([
      [0, makeItemDef(0, 'Zero Item')],
      [1, makeItemDef(1, 'First Item')],
    ]);
    const entry = buildHealViewModel([loc], defs).locations[0]!;
    expect(entry.costItemName).toBeNull();
    expect(entry.costCurrency).toBe(55n);
    expect(entry.isFree).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [12r-d W-6] formatHealCostLine — the cost-line renderer healView.ts:25 delegates to.
//
// THE HEAD BUG THIS BLOCK EXISTS FOR: healView.ts:25 renders every non-free pad as
// `${loc.costQty}x ${loc.costItemName ?? 'Unknown item'}`. A currency-only pad has
// costQty 0 and costItemName null, so the overlay prints the literal text
// "Heal here (0x Unknown item)" — a nonexistent reagent, in place of the gold price the
// server is about to debit.
//
// WORDING FREEDOM: only the four pins listed in this block's header comment are asserted.
// The currency phrasing ('120 gold', 'Cost: 120g', '120 coins', …) is the implementer's.
// ---------------------------------------------------------------------------

describe('formatHealCostLine [12r-d W-6]: the cost-line branches', () => {
  it('★ [W-6a] BITES: a free pad renders EXACTLY the string "Free"', () => {
    // Kills: an impl that decorates the free case ('Free!', 'Free heal', 'No cost') — the
    // string is the VISUAL CONTRACT today's overlay already ships (healView.ts:25), and
    // every currently-seeded pad is free, so a reworded free case is a visible regression
    // for 100% of live content. Also kills an impl that ignores isFree and falls into the
    // item branch, which would print '0x Unknown item' for a free pad.
    const line = formatHealCostLine(vmFor({ costItemId: undefined, costQty: 0, costCurrency: 0n }));
    expect(line).toBe('Free');
  });

  it('★ [W-6b] BITES: an item-only cost is BYTE-IDENTICAL to today\'s rendering ("3x Herb")', () => {
    // THE no-visual-regression tooth. healView.ts:25 produces exactly
    // `${costQty}x ${costItemName ?? 'Unknown item'}` today, and every seeded item-cost pad
    // in the world renders through it. Kills: any "improvement" to the item wording
    // ('3 x Herb', 'Herb x3', '3× Herb' with U+00D7) smuggled in alongside the currency
    // feature — the delegation in [W-7] means such a change ships straight to the player.
    const line = formatHealCostLine(
      vmFor(
        { costItemId: 2, costQty: 3, costCurrency: 0n },
        new Map<number, StoreItemRow>([[2, makeItemDef(2, 'Herb')]]),
      ),
    );
    expect(line).toBe('3x Herb');
  });

  it('[W-6c] BITES: an UNKNOWN cost item keeps the "Unknown item" fallback ("1x Unknown item")', () => {
    // The other half of the byte-identical contract: when itemDefs has no entry for the
    // cost item, costItemName is null and today's shell prints 'Unknown item'. Kills: an
    // impl that drops the fallback (rendering '1x null' / '1x undefined') while moving the
    // logic out of the view, and kills one that swallows the row into 'Free'.
    const line = formatHealCostLine(vmFor({ costItemId: 99, costQty: 1, costCurrency: 0n }));
    expect(line).toBe('1x Unknown item');
  });

  it('★ [W-6d] BITES: a currency-only cost names the AMOUNT and renders neither "0x" nor "Unknown item"', () => {
    // THE HEAD BUG, pinned. WRONG IMPL KILLED (1): today's shell logic moved verbatim into
    // the new function — it prints '0x Unknown item' for this row, which this case catches
    // three ways (the '0x' needle, the 'Unknown item' needle, and the missing amount).
    // WRONG IMPL KILLED (2): a currency branch that renders the ITEM channel's zero
    // quantity anyway ('55 gold, 0x Unknown item').
    // WRONG IMPL KILLED (3): 'Free' (the pre-0170 predicate leaking into the renderer).
    //
    // THE AMOUNT IS 55n ON PURPOSE: it has no trailing zero digit, so the '0x' needle can
    // only fire on a costQty-0 item rendering — a legitimate `${amount}x Gold` wording
    // (which would contain '0x' for an amount like 120) is NOT punished by this assertion.
    const line = formatHealCostLine(
      vmFor({ costItemId: undefined, costQty: 0, costCurrency: 55n }),
    );
    expect(typeof line).toBe('string');
    expect(line).not.toBe('Free');
    expect(line.length).toBeGreaterThan(0);
    expect(
      stripDigitGrouping(line).includes('55'),
      'a currency-only cost line must NAME the amount (55) — the player has to know the price',
    ).toBe(true);
    expect(
      line.includes('0x'),
      'the cost line must not render the item channel\'s zero quantity — "0x …" is the HEAD bug',
    ).toBe(false);
    expect(
      line.includes('Unknown item'),
      'a currency cost must never fabricate an item name — "Unknown item" is the HEAD bug',
    ).toBe(false);
    expect(line.includes('undefined')).toBe(false);
    expect(line.includes('null')).toBe(false);
    expect(line.includes('NaN')).toBe(false);
  });

  it('★ [W-6e] BITES (DISCRIMINATOR): a 2^53+1 amount is rendered FROM THE BIGINT, not from a Number()', () => {
    // The render-side twin of [W-1b]. `String(Number(9007199254740993n))` is
    // '9007199254740992' — a formatter that Number()s the amount before templating shows
    // the player a price that is off by one and unpayable. Both needles are checked on the
    // grouping-stripped line so a locale-aware `toLocaleString()` wording stays legal.
    const line = formatHealCostLine(
      vmFor({ costItemId: undefined, costQty: 0, costCurrency: COST_2P53_PLUS_1 }),
    );
    const flat = stripDigitGrouping(line);
    expect(
      flat.includes('9007199254740993'),
      'the amount must be rendered from the bigint (9007199254740993)',
    ).toBe(true);
    expect(
      flat.includes('9007199254740992'),
      'the line contains 9007199254740992 — the value a Number() hop produces for 2^53+1',
    ).toBe(false);
    expect(flat.includes('e+')).toBe(false); // no exponential float notation either
  });

  it('[W-6f] BITES: a pad with BOTH channels renders BOTH (the item rendering AND the amount)', () => {
    // Kills: an early `return` in the item branch (or in the currency branch) that hides
    // the other channel — a hybrid pad would understate what the player is about to pay.
    // The item half is asserted as the byte-identical substring '2x Herb', so a both-channel
    // impl cannot quietly reformat the item wording either. Amount 75n: no trailing zero.
    const line = formatHealCostLine(
      vmFor(
        { costItemId: 2, costQty: 2, costCurrency: 75n },
        new Map<number, StoreItemRow>([[2, makeItemDef(2, 'Herb')]]),
      ),
    );
    expect(line.includes('2x Herb'), 'the item channel must still render as "2x Herb"').toBe(true);
    expect(stripDigitGrouping(line).includes('75'), 'the currency channel must render too').toBe(
      true,
    );
    expect(line).not.toBe('Free');
    expect(line.includes('Unknown item')).toBe(false);
  });

  it('[W-6g] BITES: TOTAL — never throws, always returns a non-empty string, never leaks "undefined"/"NaN"', () => {
    // The module's standing contract (this file's header: TOTAL, never throws) extended to
    // the new export. The list includes an INTERNALLY INCONSISTENT view model — every
    // channel empty but isFree false — which no builder produces but which a hand-built VM
    // in a future call site could. Kills: a formatter that assumes exactly one channel is
    // populated and dereferences its way into a throw, and one that returns '' for a shape
    // it does not recognise (an empty cost line reads as a rendering bug in the overlay).
    const vms: readonly HealLocationViewModel[] = [
      { ...vmFor({ costCurrency: 0n }) },
      { ...vmFor({ costCurrency: COST_U64_MAX }) },
      { ...vmFor({ costCurrency: -5n }) },
      { ...vmFor({ costItemId: 7, costQty: 0, costCurrency: 0n }) },
      { ...vmFor({ costItemId: 7, costQty: 99, costCurrency: COST_U64_MAX }) },
      // Inconsistent-by-construction: all three channels empty, yet flagged not-free.
      { ...vmFor({ costCurrency: 0n }), isFree: false },
      // A defined-but-empty item name (a content row with a blank name).
      {
        ...vmFor(
          { costItemId: 4, costQty: 1, costCurrency: 0n },
          new Map<number, StoreItemRow>([[4, makeItemDef(4, '')]]),
        ),
      },
    ];
    for (const vm of vms) {
      let line!: string;
      expect(() => {
        line = formatHealCostLine(vm);
      }, 'formatHealCostLine must be TOTAL — healView renders it inside a forEach over every pad').not.toThrow();
      expect(typeof line).toBe('string');
      expect(line.length).toBeGreaterThan(0);
      expect(line.includes('undefined')).toBe(false);
      expect(line.includes('NaN')).toBe(false);
      expect(line.includes('[object')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// [12r-d W-7] The delegation pin for the coverage-excluded DOM shell.
// healView.ts is listed in vite.config.ts's coverage exclusions and has NO test file —
// it is a DOM shell by policy. That makes a SOURCE SCAN the only available gate on the
// one line of it that matters: the cost string must come from the pure function this
// file tests, not from a second, divergent copy of the logic inside the view.
// Literal needles + `.includes` only — no `new RegExp(` anywhere (the Semgrep
// detect-non-literal-regexp / ReDoS gate), and the source is COMMENT-STRIPPED first so a
// prose mention can never satisfy the tooth.
// ---------------------------------------------------------------------------

// Drop block comments (marker scan, multi-line aware) THEN line comments, so a needle that
// only appears in a COMMENT — including one hidden by commenting out the real body — cannot
// satisfy a tooth. Order matters: blocks are stripped FIRST so a `//` living inside a block
// comment cannot be mis-parsed by the line pass afterwards (it is simply gone by then).
// Ported from the established precedent at main.wiring.test.ts:1424-1453 (11r-h / ADR-0172
// D7), which was itself written after a raw `.includes` tooth resolved to a comment 147
// lines from the real statement. String scanning only: no RegExp, literal or otherwise —
// and the delimiters are plain literals, matching that precedent byte for byte (a
// concatenated spelling would trip biome's useless-string-concat lint).
function stripBlockComments(src: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = src.indexOf('/*', i);
    if (start === -1) {
      out += src.slice(i);
      return out;
    }
    out += src.slice(i, start);
    const end = src.indexOf('*/', start + 2);
    if (end === -1) {
      // Unterminated block comment — drop the remainder defensively. A needle that only
      // survives inside an unterminated comment must never count as a call site.
      return out;
    }
    i = end + 2;
  }
}

/** Comment-free view of a TypeScript source file: block comments then line comments.
 *  Idempotent. Deliberately naive about comment markers inside string literals — healView
 *  is a 39-line DOM shell with none, and erring toward stripping only ever makes a tooth
 *  HARDER to satisfy, never easier. */
function stripSourceComments(src: string): string {
  return stripBlockComments(src)
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

describe('healView.ts [12r-d W-7]: the cost line is DELEGATED to formatHealCostLine', () => {
  it('★ [W-7] BITES: healView.ts CALLS formatHealCostLine( in real code (comment-stripped) and no longer rebuilds the cost inline', () => {
    // WRONG IMPL KILLED (1): shipping formatHealCostLine as a new export that healView.ts
    // never calls. Every behavioural tooth in [W-6] would pass, the model would be perfect,
    // and the player would STILL read "Heal here (0x Unknown item)" — the bug fixed
    // everywhere except the one surface a human sees. Nothing else in this suite can see
    // that failure mode, because healView is unreachable from a node-only unit test AND is
    // excluded from the coverage denominator (vite.config.ts), so it has no other gate.
    //
    // WRONG IMPL KILLED (2) — why the source is COMMENT-STRIPPED: a raw `.includes` is
    // satisfied by `// TODO: call formatHealCostLine(vm)` sitting above an untouched inline
    // template. That is a one-line cheat that turns this tooth green while shipping the
    // exact bug. Stripping blocks + line comments first makes the prose mention worthless.
    //
    // WRONG IMPL KILLED (3) — why 'Unknown item' must be GONE from the shell: an impl that
    // calls formatHealCostLine into an unused local (or in a dead branch) while the live
    // template still renders `${loc.costQty}x ${loc.costItemName ?? 'Unknown item'}`. The
    // fallback string is pinned to the MODEL by [W-6c]; after delegation the view has no
    // business spelling it at all, so its presence in real code means a second, divergent
    // copy of the cost logic survived inside the shell.
    const viewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'healView.ts');
    let rawSrc: string;
    try {
      rawSrc = readFileSync(viewPath, 'utf8');
    } catch (err) {
      // Fail LOUD rather than vacuously green if the file moves or is renamed.
      throw new Error('healView.ts could not be read — the file must exist: ' + String(err));
    }
    const src = stripSourceComments(rawSrc);
    // Pre-condition: stripping must not have eaten the file (a stripper bug would make the
    // needle assertion below fail for the WRONG reason, and the absence assertion pass
    // vacuously). healView's class declaration is comment-free and load-bearing.
    expect(
      src.includes('export class HealView'),
      'the comment-stripper ate real code — healView.ts must still declare `export class HealView`',
    ).toBe(true);
    expect(
      src.includes('formatHealCostLine('),
      'healView.ts must CALL formatHealCostLine(...) in real code — a comment mentioning it ' +
        'does not count (the source is comment-stripped), and the cost string may not be ' +
        'rebuilt inline in the DOM shell (that copy is coverage-excluded and cannot be gated)',
    ).toBe(true);
    expect(
      src.includes('Unknown item'),
      'healView.ts must no longer spell the "Unknown item" fallback — after delegation that ' +
        'string lives in formatHealCostLine (pinned by [W-6c]); its survival in the shell ' +
        'means the old inline cost template is still the live path',
    ).toBe(false);
  });
});

describe('buildHealViewModel [12r-d W-5]: properties over the bigint domain', () => {
  it('★ [W-5a] BITES fast-check: costCurrency equals its input EXACTLY, isFree is the three-way conjunction, and building never throws', () => {
    // Successor to the V-5 property. For ANY mix of 0n / u64 / negative currency values the
    // model is TOTAL, every entry carries a BIGINT costCurrency exactly equal to its input
    // (never `undefined`, never coerced, never clamped), and isFree is exactly the
    // three-way conjunction. Kills: a Number() hop (fails for most of the u64 domain), a
    // clamp, and any isFree predicate that ignores or mis-weights one of the three channels.
    // Block-bodied arrow: fast-check reads an expression-bodied matcher's return value as a
    // `false` predicate and fails spuriously.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            locationId: fc.integer({ min: 0, max: 9999 }),
            zoneId: fc.integer({ min: 0, max: 99 }),
            tileX: fc.integer({ min: 0, max: 255 }),
            tileY: fc.integer({ min: 0, max: 255 }),
            costItemId: fc.option(fc.integer({ min: 1, max: 999 }), { nil: undefined }),
            costQty: fc.integer({ min: 0, max: 99 }),
            cooldownMs: fc.integer({ min: 0, max: 86400000 }),
            costCurrency: fc.oneof(
              fc.constant(0n),
              fc.bigUintN(64),
              fc.bigInt({ min: -1000n, max: -1n }),
            ),
          }),
          { maxLength: 20 },
        ),
        (locs) => {
          let vm!: ReturnType<typeof buildHealViewModel>;
          expect(() => {
            vm = buildHealViewModel(locs, new Map());
          }).not.toThrow();
          expect(vm.locations).toHaveLength(locs.length);
          vm.locations.forEach((entry, i) => {
            const src = locs[i]!;
            expect(typeof entry.costCurrency).toBe('bigint');
            expect(entry.costCurrency).toBe(src.costCurrency);
            expect(entry.isFree).toBe(
              src.costItemId === undefined && src.costQty === 0 && src.costCurrency === 0n,
            );
          });
        },
      ),
    );
  });

  it('★ [W-5b] BITES fast-check: formatHealCostLine returns "Free" for EXACTLY the free pads, and never leaks a placeholder', () => {
    // The renderer's own invariant, stated as an IFF so both directions bite:
    //   * a free pad that renders anything but 'Free' (e.g. '0x Unknown item'), and
    //   * a PAID pad that renders 'Free' — the silent-debit lie, reached through the
    //     renderer instead of through isFree.
    // Plus: the line is always a non-empty string containing no 'undefined' / 'NaN' /
    // '[object Object]' for ANY generated row. Kills a formatter that only handles the
    // shapes the hand-written table above happens to use.
    fc.assert(
      fc.property(
        fc.record({
          costItemId: fc.option(fc.integer({ min: 1, max: 999 }), { nil: undefined }),
          costQty: fc.integer({ min: 0, max: 99 }),
          costCurrency: fc.oneof(fc.constant(0n), fc.bigUintN(64)),
        }),
        ({ costItemId, costQty, costCurrency }) => {
          const entry = buildHealViewModel(
            [makeLocation({ costItemId, costQty, costCurrency })],
            new Map(),
          ).locations[0]!;
          let line!: string;
          expect(() => {
            line = formatHealCostLine(entry);
          }).not.toThrow();
          expect(typeof line).toBe('string');
          expect(line.length).toBeGreaterThan(0);
          expect(line === 'Free').toBe(entry.isFree);
          expect(line.includes('undefined')).toBe(false);
          expect(line.includes('NaN')).toBe(false);
          expect(line.includes('[object')).toBe(false);
        },
      ),
    );
  });
});

describe('buildHealViewModelForLocation [12r-d W-8]: the bound arm carries costCurrency too', () => {
  it('★ [W-8a] BITES: the bound location surfaces its OWN costCurrency (60n) and isFree=false', () => {
    // Successor to the 11r-g bound-arm case. Kills: a ForLocation body that hand-rolls the
    // view model instead of delegating — it would miss the new field entirely, and the BOUND
    // overlay (the KeyT heal arm, main.ts:444-446) is the ONE heal surface a player actually
    // sees. The fixture puts a DIFFERENT non-zero cost on the unselected pad, so an impl
    // that filters after projecting the first row also dies here.
    const locs = [
      makeLocation({ locationId: 1, costCurrency: 10n }),
      makeLocation({ locationId: 2, costCurrency: 60n }),
    ];
    const vm = buildHealViewModelForLocation(2, locs, new Map());
    expect(vm.locations).toHaveLength(1);
    expect(vm.locations[0]!.locationId).toBe(2);
    expect(vm.locations[0]!.costCurrency).toBe(60n);
    expect(typeof vm.locations[0]!.costCurrency).toBe('bigint');
    expect(vm.locations[0]!.isFree).toBe(false);
  });

  it('[W-8b] CONSISTENCY PIN: ForLocation(id) equals the default arm for a currency-only pad', () => {
    // Successor to the 11r-g bound-arm consistency pin. Differential re-pin of "thin filter
    // + delegate" across the currency field (the uxd2-2 pattern). Kills a future divergence
    // where one arm learns about costCurrency and the other does not. HONEST NOTE: both arms
    // are equally wrong at HEAD, so the toEqual here is a DIVERGENCE guard, not one of the
    // RED value teeth (the file is red at import either way until formatHealCostLine ships).
    const locs = [makeLocation({ locationId: 4, costCurrency: 500n })];
    expect(buildHealViewModelForLocation(4, locs, new Map())).toEqual(
      buildHealViewModel(locs, new Map()),
    );
  });
});
