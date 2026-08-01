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
// required VM field and NARROWS isFree. See the appended [11r-g V-*] block at the
// foot of this file for the full pinned contract:
//   - HealLocationViewModel gains a REQUIRED `costCurrency: number` (`?? 0` when absent)
//   - isFree = costItemId undefined AND costQty === 0 AND costCurrency === 0
//
// Pattern follows raisingModel.test.ts: pure function, no DOM, no SDK.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoreItemRow } from '../net/store';
import {
  buildHealViewModel,
  // uxd2 (ADR-0161 D5): the bound-location selector. Named import — RED until it exists.
  buildHealViewModelForLocation,
  healTargetLocationId,
} from './healModel';

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
  // 11r-g (ADR-0170 §D3): the heal-cost currency seam. OPTIONAL here because the net
  // layer's StoreHealLocationRow does NOT carry it yet (the `cost_currency` column leg
  // is parked — ADR-0170 residual 1), so the builder input widens locally to
  // `StoreHealLocationRow & { readonly costCurrency?: number }` and an ABSENT field must
  // project to 0. Deliberately NOT defaulted in makeLocation: absent is production's path.
  costCurrency?: number;
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
    // 11r-g: `costCurrency` is DELIBERATELY absent from the defaults — today's store rows
    // have no such field, so absent ⇒ 0 is the DEFAULT path under test. Tests that need a
    // currency cost pass it explicitly via `overrides`.
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
    // 11r-g (ADR-0170 §D3) EXTENSION — nothing above removed; `costCurrency` joins the
    // required-key contract. The fixture row carries NO costCurrency, so the required key
    // must still be present, as the number 0.
    // Kills: an impl that leaves the field off the VM entirely (consumers would read
    // `undefined` and healView would render a "Cost: undefined gold" pad), and — via the
    // typed member access below — the type-level form of the same defect (TS2339 against a
    // HealLocationViewModel that lacks the key).
    expect(entry).toHaveProperty('costCurrency', 0);
    expect(entry.costCurrency).toBe(0);
    expect(typeof entry.costCurrency).toBe('number');
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
    // generated rows now also carry an optional costCurrency, so this totality property
    // covers currency-bearing rows too. The VALUE invariants for that field live in the
    // sibling [11r-g V-5] property at the foot of this file.
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
            // absent (nil) | 0 | natural | negative | absurdly large (past 2**40).
            costCurrency: fc.option(
              fc.oneof(
                fc.nat(),
                fc.integer({ min: -1000, max: -1 }),
                fc.constant(0),
                fc.integer({ min: 2 ** 40, max: 2 ** 45 }),
              ),
              { nil: undefined },
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
// 11r-g (ADR-0170 §D3) — HEAL COST CURRENCY SEAM.
// APPENDED BLOCK — every case above this line is untouched except two legitimate
// EXTENSIONS: the criterion-6 shape contract gained the new required key, and the
// criterion-7 property gained a costCurrency arbitrary in its INPUT DOMAIN (its
// assertion is unchanged). Nothing was weakened, renamed, or removed.
//
// SOURCE OF TRUTH: docs/adr/0170-server-hardening-cache-completion-log-escaping.md §D3.
//
// CONTRACT (pinned — the implementer builds exactly this in healModel.ts):
//   export interface HealLocationViewModel { …; costCurrency: number }  // REQUIRED
//   buildHealViewModel(
//     healLocations: readonly (StoreHealLocationRow & { readonly costCurrency?: number })[],
//     itemDefs: ReadonlyMap<number, StoreItemRow>,
//   ): HealViewModel
//   - costCurrency = `loc.costCurrency ?? 0`  (NULLISH coalesce — never `|| 0`)
//   - isFree = costItemId === undefined AND costQty === 0 AND costCurrency === 0
//   - the module stays TOTAL: never throws.
//   The field is REQUIRED on the VM (not optional) so every future consumer must reckon
//   with it; an optional field could be `?? 0`-ed past, reintroducing the gap.
//
// WHY THE SEAM IS INERT: the `cost_currency` COLUMN leg is parked (ADR-0170 residual 1),
// so store rows carry no such field today — the ABSENT ⇒ 0 path IS production's path.
// The isFree contract is fixed now so the follow-up wiring is mechanical.
//
// RED TODAY (runtime assertion RED in every case below unless noted): healModel.ts
// computes `isFree = costItemId === undefined && costQty === 0` and never emits
// costCurrency, so `entry.costCurrency` is `undefined` and a currency-only pad reports
// isFree === true — the silent-debit trap (ADR-0170 Context item 3: `spend_currency`
// charges correctly server-side; only the UI lies). The `.costCurrency` member accesses
// are ALSO a type-level RED (TS2339 against the current HealLocationViewModel) — note
// client/tsconfig.json excludes `**/*.test.ts`, so that arm surfaces in the editor and
// not in `npm run typecheck`; the gating signal is the runtime failure under vitest.
// ===========================================================================

describe('buildHealViewModel [11r-g V-1/V-2]: costCurrency projection', () => {
  it('★ [V-1] BITES: costCurrency=50 is passed through verbatim', () => {
    // Kills: an impl that drops the field, hardcodes 0, or re-derives it from costQty.
    const loc = makeLocation({ costCurrency: 50 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations).toHaveLength(1);
    expect(vm.locations[0]!.costCurrency).toBe(50);
    expect(typeof vm.locations[0]!.costCurrency).toBe('number');
  });

  it('[V-1] BITES: a huge costCurrency (2**40) is neither clamped nor bit-truncated', () => {
    // Kills: `costCurrency | 0` / `>>> 0` "normalization" — 2**40 | 0 === 0, which would
    // paint a 1.1-trillion-gold pad as free. Also kills Math.min-style clamping. The
    // server column is u64; the client convention narrows to number (ADR-0170 residual 1).
    const loc = makeLocation({ costCurrency: 1_099_511_627_776 }); // 2 ** 40
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.costCurrency).toBe(1_099_511_627_776);
    expect(vm.locations[0]!.isFree).toBe(false);
  });

  it('★ [V-2] BITES: a row with NO costCurrency key → costCurrency 0 (the inert-seam default)', () => {
    // Kills: a missing `?? 0` projection — the VM would emit `undefined` for EVERY
    // production row today (the column is parked) and healView would render "undefined".
    // makeLocation deliberately leaves the key absent; the pre-condition below pins that.
    const loc = makeLocation();
    expect(Object.hasOwn(loc, 'costCurrency')).toBe(false); // fixture pre-condition
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.costCurrency).toBe(0);
    expect(typeof vm.locations[0]!.costCurrency).toBe('number');
  });

  it('[V-2] BITES: an explicit costCurrency 0 → 0 (not undefined, not dropped)', () => {
    // Kills the same missing-projection defect through the explicit-zero door. `?? 0` and
    // `|| 0` AGREE here and on the absent case above, so pinning BOTH fixes the projection
    // shape without over-specifying the operator; the NaN case in the [V-5] block below is
    // the one place the two operators observably diverge.
    const loc = makeLocation({ costCurrency: 0 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.costCurrency).toBe(0);
  });

  it('[V-1] BITES: an item cost and a currency cost are BOTH surfaced on one row', () => {
    // Kills: an impl that reads costCurrency only in the else-branch of "has an item cost"
    // — a hybrid pad would show the herb and hide the gold.
    const loc = makeLocation({ costItemId: 2, costQty: 3, costCurrency: 75 });
    const defs = new Map<number, StoreItemRow>([[2, makeItemDef(2, 'Herb')]]);
    const vm = buildHealViewModel([loc], defs);
    const entry = vm.locations[0]!;
    expect(entry.costItemName).toBe('Herb');
    expect(entry.costQty).toBe(3);
    expect(entry.costCurrency).toBe(75);
    expect(entry.isFree).toBe(false);
  });

  it('[V-1] BITES: each row keeps its OWN costCurrency (no cross-row bleed)', () => {
    // Kills: an impl that hoists one row's currency out of the per-row map callback, or
    // reuses the first/last row's value for the whole list.
    const locs = [
      makeLocation({ locationId: 1, costCurrency: 10 }),
      makeLocation({ locationId: 2 }),
      makeLocation({ locationId: 3, costCurrency: 250 }),
    ];
    const vm = buildHealViewModel(locs, new Map());
    expect(vm.locations.map((l) => l.costCurrency)).toEqual([10, 0, 250]);
  });
});

describe('buildHealViewModel [11r-g V-3]: isFree requires ALL THREE cost channels empty', () => {
  it('★ [V-3] BITES: no item, costQty 0, costCurrency 50 → isFree FALSE (the silent-debit trap)', () => {
    // THE decisive case. Kills the pre-0170 predicate
    // `isFree = costItemId === undefined && costQty === 0`, which reports TRUE here: a pure
    // CONTENT edit (seed a gold cost on a pad) would then paint "Free heal" over a charge
    // the server happily debits. ADR-0170 Context (3) / §D3.
    const loc = makeLocation({ costItemId: undefined, costQty: 0, costCurrency: 50 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.isFree).toBe(false);
    expect(typeof vm.locations[0]!.isFree).toBe('boolean');
  });

  it('[V-3] BITES: no item, costQty 0, explicit costCurrency 0 → isFree TRUE', () => {
    // Kills the OVER-correction: any impl that treats "the currency field is present" as
    // "there is a cost" (e.g. `costCurrency !== undefined ? false : …`).
    const loc = makeLocation({ costItemId: undefined, costQty: 0, costCurrency: 0 });
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.isFree).toBe(true);
    expect(vm.locations[0]!.costCurrency).toBe(0);
  });

  it('★ [V-3] BITES: an ABSENT costCurrency leaves a legacy free pad free (isFree TRUE)', () => {
    // Kills the other over-correction: `loc.costCurrency === 0` tested WITHOUT the `?? 0`
    // — `undefined === 0` is false, so EVERY production row (the column is parked) would
    // flip to "not free" and today's free heal pad would grow a phantom price. This is the
    // regression guard that keeps the seam INERT until the column leg lands.
    const loc = makeLocation(); // no costCurrency key at all
    const vm = buildHealViewModel([loc], new Map());
    expect(vm.locations[0]!.isFree).toBe(true);
    expect(vm.locations[0]!.costItemName).toBeNull();
    expect(vm.locations[0]!.costCurrency).toBe(0);
  });

  it('★ [V-3] BITES: truth table — isFree is true in EXACTLY 1 of the 8 (item × qty × currency) combinations', () => {
    // Kills every partial predicate at once: `&&` swapped for `||`, a dropped conjunct, a
    // negated conjunct, or a two-of-three check. Only the all-empty row may be free.
    const cases: ReadonlyArray<{
      readonly costItemId: number | undefined;
      readonly costQty: number;
      readonly costCurrency: number;
      readonly isFree: boolean;
    }> = [
      { costItemId: undefined, costQty: 0, costCurrency: 0, isFree: true },
      { costItemId: undefined, costQty: 0, costCurrency: 50, isFree: false },
      { costItemId: undefined, costQty: 2, costCurrency: 0, isFree: false },
      { costItemId: undefined, costQty: 2, costCurrency: 50, isFree: false },
      { costItemId: 2, costQty: 0, costCurrency: 0, isFree: false },
      { costItemId: 2, costQty: 0, costCurrency: 50, isFree: false },
      { costItemId: 2, costQty: 2, costCurrency: 0, isFree: false },
      { costItemId: 2, costQty: 2, costCurrency: 50, isFree: false },
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

describe('buildHealViewModel [11r-g V-4]: a currency-only cost invents no item name', () => {
  it('★ [V-4] BITES: costCurrency 50 with no item cost → isFree false AND costItemName null', () => {
    // Kills: an impl that reaches for an item name whenever ANY cost exists (e.g. widening
    // `itemDefs.get(loc.costItemId ?? 0)?.name` into the currency branch). A gold cost must
    // never fabricate an item row — healView would print a nonexistent reagent.
    const loc = makeLocation({ costItemId: undefined, costQty: 0, costCurrency: 50 });
    const vm = buildHealViewModel([loc], new Map());
    const entry = vm.locations[0]!;
    expect(entry.isFree).toBe(false);
    expect(entry.costItemName).toBeNull();
    expect(entry.costQty).toBe(0);
    expect(entry.costCurrency).toBe(50);
  });

  it('[V-4] BITES: a POPULATED itemDefs map leaks no name onto a currency-only row', () => {
    // Kills: a fallback to itemDefs.get(0) / the first def when costItemId is undefined but
    // a cost is present — id 0 is a representable item id, so an empty map would not have
    // caught it.
    const loc = makeLocation({ costItemId: undefined, costQty: 0, costCurrency: 120 });
    const defs = new Map<number, StoreItemRow>([
      [0, makeItemDef(0, 'Zero Item')],
      [1, makeItemDef(1, 'First Item')],
    ]);
    const vm = buildHealViewModel([loc], defs);
    expect(vm.locations[0]!.costItemName).toBeNull();
    expect(vm.locations[0]!.costCurrency).toBe(120);
    expect(vm.locations[0]!.isFree).toBe(false);
  });
});

describe('buildHealViewModel [11r-g V-5]: totality over adversarial costCurrency', () => {
  it('[V-5] BITES: a negative costCurrency passes through unchanged (projection, not validation)', () => {
    // The VM is a PURE PROJECTION: rejecting an out-of-range cost is the server's job
    // (reject-not-clamp). Kills: `Math.max(0, …)` laundering nonsense content into a
    // plausible-looking zero — which would HIDE the bad row instead of surfacing it.
    const vm = buildHealViewModel([makeLocation({ costCurrency: -25 })], new Map());
    expect(vm.locations[0]!.costCurrency).toBe(-25);
    expect(vm.locations[0]!.isFree).toBe(false); // -25 !== 0
  });

  it('★ [V-5] BITES: costCurrency NaN survives as NaN, is NOT free, and does not throw', () => {
    // THE `?? 0` vs `|| 0` discriminator — the ONE input where they observably differ:
    // `NaN ?? 0` is NaN (the pinned behavior), `NaN || 0` is 0. The `|| 0` variant would
    // launder a corrupt row into "Free heal"; that mutant dies here. Also kills a
    // Number()/isFinite sanitizer that maps NaN to 0, and pins totality on a non-finite.
    let vm!: ReturnType<typeof buildHealViewModel>;
    expect(() => {
      vm = buildHealViewModel([makeLocation({ costCurrency: Number.NaN })], new Map());
    }).not.toThrow();
    expect(vm.locations[0]!.costCurrency).toBeNaN();
    expect(vm.locations[0]!.isFree).toBe(false);
  });

  it('[V-5] BITES fast-check: costCurrency is always a number equal to its input (absent ⇒ 0), and building never throws', () => {
    // Property: for ANY mix of absent / zero / natural / negative / absurd (>= 2**40)
    // currency values, buildHealViewModel is TOTAL, every entry carries a NUMERIC
    // costCurrency exactly equal to its input (0 when absent — never `undefined`, never
    // clamped), and isFree is exactly the three-way conjunction.
    // Kills: a dropped `?? 0` (undefined leaks under randomized input), clamping/coercion,
    // and any isFree predicate that ignores or mis-weights one of the three channels.
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
            costCurrency: fc.option(
              fc.oneof(
                fc.nat(),
                fc.integer({ min: -1000, max: -1 }),
                fc.constant(0),
                fc.integer({ min: 2 ** 40, max: 2 ** 45 }),
              ),
              { nil: undefined },
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
            expect(typeof entry.costCurrency).toBe('number');
            expect(entry.costCurrency).toBe(src.costCurrency ?? 0);
            expect(entry.isFree).toBe(
              src.costItemId === undefined && src.costQty === 0 && (src.costCurrency ?? 0) === 0,
            );
          });
        },
      ),
    );
  });
});

describe('buildHealViewModelForLocation [11r-g V-1]: the bound arm carries costCurrency too', () => {
  it('★ [V-1] BITES: the bound location surfaces its OWN costCurrency and isFree=false', () => {
    // Kills: a ForLocation body that hand-rolls the view model instead of delegating — it
    // would miss the new field entirely, and the bound overlay (the KeyT heal arm) is the
    // ONE heal surface a player actually sees.
    const locs = [
      makeLocation({ locationId: 1, costCurrency: 10 }),
      makeLocation({ locationId: 2, costCurrency: 60 }),
    ];
    const vm = buildHealViewModelForLocation(2, locs, new Map());
    expect(vm.locations).toHaveLength(1);
    expect(vm.locations[0]!.locationId).toBe(2);
    expect(vm.locations[0]!.costCurrency).toBe(60);
    expect(vm.locations[0]!.isFree).toBe(false);
  });

  it('[V-1] CONSISTENCY PIN: ForLocation(id) equals the default arm for a currency-only pad', () => {
    // Differential re-pin of "thin filter + delegate" across the NEW field (the uxd2-2
    // pattern). Kills a future divergence where one arm learns about costCurrency and the
    // other does not. NOTE: both arms are equally wrong today, so this case is GREEN before
    // the fix — it is a divergence guard, not one of the RED teeth.
    const locs = [makeLocation({ locationId: 4, costCurrency: 500 })];
    expect(buildHealViewModelForLocation(4, locs, new Map())).toEqual(
      buildHealViewModel(locs, new Map()),
    );
  });
});
