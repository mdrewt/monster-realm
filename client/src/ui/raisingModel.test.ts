// ui/raisingModel.ts — pure view-model for the raising/inventory screen (M9c).
// SOURCE OF TRUTH: specs/monster-realm-v2/M9-raising.spec.md
// Tests the pure function buildRaisingViewModel — no DOM, no SDK, no side effects.
// All inputs are plain objects; deterministic; node-only.
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoreInventory, StoreItemRow, StoreMonsterPub } from '../net/store';
import {
  buildRaisingViewModel,
  type InventoryItemViewModel,
  type RaisingMonsterViewModel,
  type RaisingViewModel,
} from './raisingModel';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function monster(monsterId: bigint, overrides: Partial<StoreMonsterPub> = {}): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: 'player',
    speciesId: 1,
    nickname: `M-${monsterId}`,
    level: 5,
    xp: 0,
    bond: 50,
    currentHp: 30,
    statHp: 40,
    statAttack: 10,
    statDefense: 10,
    statSpeed: 10,
    statSpAttack: 10,
    statSpDefense: 10,
    partySlot: 255,
    ...overrides,
  };
}

function inventoryItem(
  invId: bigint,
  itemId: number,
  count = 1,
  ownerIdentity = 'player',
): StoreInventory {
  return { invId, ownerIdentity, itemId, count };
}

function itemDef(id: number, overrides: Partial<StoreItemRow> = {}): StoreItemRow {
  return {
    id,
    name: `Item-${id}`,
    description: `Desc for ${id}`,
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    ...overrides,
  };
}

function trainItemDef(id: number, trainStat: string): StoreItemRow {
  return itemDef(id, { trainStat, trainAmount: 10 });
}

// ---------------------------------------------------------------------------
// Criterion 1 — Server-DERIVED stats, NO client recompute (ADR-0016)
// ---------------------------------------------------------------------------

describe('buildRaisingViewModel: server-derived stats (ADR-0016, criterion 1)', () => {
  it('BITES: monster with impossible stats (level 5 but statHp 999) are returned verbatim', () => {
    // An impl that recomputes HP from a formula would never return 999 for level 5.
    // Kills: any stat recomputation, transformation, or clamp on server-provided values.
    const m = monster(1n, {
      level: 5,
      statHp: 999,
      statAttack: 888,
      statDefense: 777,
      statSpeed: 666,
      statSpAttack: 555,
      statSpDefense: 444,
      bond: 127,
      currentHp: 500,
    });
    const vm = buildRaisingViewModel([m], [], new Map());
    const mon = vm.monsters[0]!;
    expect(mon.statHp).toBe(999);
    expect(mon.statAttack).toBe(888);
    expect(mon.statDefense).toBe(777);
    expect(mon.statSpeed).toBe(666);
    expect(mon.statSpAttack).toBe(555);
    expect(mon.statSpDefense).toBe(444);
    expect(mon.bond).toBe(127);
    expect(mon.level).toBe(5);
    expect(mon.currentHp).toBe(500);
  });

  it('BITES: nickname and monsterId are copied verbatim', () => {
    // Kills: an impl that looks up or transforms the nickname.
    const m = monster(42n, { nickname: 'Sparkzilla' });
    const vm = buildRaisingViewModel([m], [], new Map());
    const mon = vm.monsters[0]!;
    expect(mon.monsterId).toBe(42n);
    expect(mon.nickname).toBe('Sparkzilla');
  });

  it('BITES fast-check property: all six stat fields === their StoreMonsterPub counterparts', () => {
    // Property test over arbitrary stat values — any transform/clamp breaks this.
    // Kills: any impl that clamps, rounds, or recomputes stat values.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 65535 }),
        fc.integer({ min: 0, max: 65535 }),
        fc.integer({ min: 0, max: 65535 }),
        fc.integer({ min: 0, max: 65535 }),
        fc.integer({ min: 0, max: 65535 }),
        fc.integer({ min: 0, max: 65535 }),
        (hp, atk, def, spd, spAtk, spDef) => {
          const m = monster(1n, {
            statHp: hp,
            statAttack: atk,
            statDefense: def,
            statSpeed: spd,
            statSpAttack: spAtk,
            statSpDefense: spDef,
          });
          const vm = buildRaisingViewModel([m], [], new Map());
          const mon = vm.monsters[0]!;
          expect(mon.statHp).toBe(hp);
          expect(mon.statAttack).toBe(atk);
          expect(mon.statDefense).toBe(def);
          expect(mon.statSpeed).toBe(spd);
          expect(mon.statSpAttack).toBe(spAtk);
          expect(mon.statSpDefense).toBe(spDef);
        },
      ),
    );
  });

  it('BITES fast-check property: bond and level copied verbatim from StoreMonsterPub', () => {
    // Kills: an impl that recalculates bond or level from other fields.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 1, max: 100 }),
        (bond, level) => {
          const m = monster(1n, { bond, level });
          const vm = buildRaisingViewModel([m], [], new Map());
          const mon = vm.monsters[0]!;
          expect(mon.bond).toBe(bond);
          expect(mon.level).toBe(level);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — Value/type contract for train + care args
// ---------------------------------------------------------------------------

describe('buildRaisingViewModel: item/monster id type contract (criterion 2)', () => {
  it('BITES: monsterId in RaisingMonsterViewModel stays bigint (never Number()-ed)', () => {
    // The train reducer takes monsterId as bigint. If the VM downcasts to number,
    // the shell would pass a number to the reducer binding — wrong type.
    // Value > 2^53 proves bigint is preserved (Number() would lose precision).
    const largeId = 9007199254740993n; // 2^53 + 1
    const m = monster(largeId);
    const vm = buildRaisingViewModel([m], [], new Map());
    expect(typeof vm.monsters[0]!.monsterId).toBe('bigint');
    expect(vm.monsters[0]!.monsterId).toBe(largeId);
  });

  it('BITES: invId in InventoryItemViewModel stays bigint across 2^53 boundary', () => {
    // The shell needs invId as bigint to pass to store lookups and display correctly.
    // Kills: an impl that converts invId to number for the view model.
    const largeInvId = 9007199254740993n;
    const defs = new Map([[1, itemDef(1)]]);
    const inv = inventoryItem(largeInvId, 1, 3);
    const vm = buildRaisingViewModel([], [inv], defs);
    expect(typeof vm.items[0]!.invId).toBe('bigint');
    expect(vm.items[0]!.invId).toBe(largeInvId);
  });

  it('BITES: itemId in InventoryItemViewModel is number (the foodItemId for train reducer)', () => {
    // train({monsterId, foodItemId}) expects foodItemId as number (u32).
    // Kills: an impl that bigints itemId.
    const defs = new Map([[7, itemDef(7, { trainStat: 'Attack' })]]);
    const inv = inventoryItem(1n, 7, 2);
    const vm = buildRaisingViewModel([], [inv], defs);
    expect(typeof vm.items[0]!.itemId).toBe('number');
    expect(vm.items[0]!.itemId).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — Non-owner items never appear (enforced by caller; reset clears)
// (ownInventory filtering is in store.test.ts; here we confirm the VM takes
// pre-filtered input and does NOT re-filter or reject any passed row)
// ---------------------------------------------------------------------------

describe('buildRaisingViewModel: accepts pre-filtered input (criterion 3 — view-model side)', () => {
  it('BITES: all passed inventory rows appear in output (no hidden second filter)', () => {
    // The caller (store.ownInventory) already filters by owner. The VM must not
    // apply a second owner filter that might silently drop rows.
    // Kills: an impl that double-filters and loses rows.
    const defs = new Map([
      [1, itemDef(1)],
      [2, itemDef(2)],
    ]);
    const items = [inventoryItem(1n, 1, 5), inventoryItem(2n, 2, 3)];
    const vm = buildRaisingViewModel([], items, defs);
    expect(vm.items).toHaveLength(2);
    const ids = vm.items.map((i) => i.invId);
    expect(ids).toContain(1n);
    expect(ids).toContain(2n);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — canTrain classified by DATA (trainStat present), not by item id
// ---------------------------------------------------------------------------

describe('buildRaisingViewModel: canTrain classified by data not by item id (criterion 4)', () => {
  it('BITES: item with trainStat:"Attack" -> canTrain true', () => {
    // Kills: an impl that always sets canTrain:false or uses a hardcoded id list.
    const defs = new Map([[1, trainItemDef(1, 'Attack')]]);
    const inv = inventoryItem(10n, 1, 1);
    const vm = buildRaisingViewModel([], [inv], defs);
    expect(vm.items[0]!.canTrain).toBe(true);
  });

  it('BITES: item with trainStat:null -> canTrain false', () => {
    // Kills: an impl that always sets canTrain:true or checks name/id instead of trainStat.
    const defs = new Map([[2, itemDef(2, { trainStat: null })]]);
    const inv = inventoryItem(20n, 2, 1);
    const vm = buildRaisingViewModel([], [inv], defs);
    expect(vm.items[0]!.canTrain).toBe(false);
  });

  it('BITES: item with no def in map -> canTrain false (missing def treated as no-train)', () => {
    // S4 overlaps: missing def must NOT throw and must set canTrain:false.
    // Kills: an impl that throws on missing def or defaults canTrain:true.
    const inv = inventoryItem(30n, 999, 1); // itemId 999 not in defs map
    const vm = buildRaisingViewModel([], [inv], new Map());
    expect(vm.items[0]!.canTrain).toBe(false);
  });

  it('BITES: item with "plausible food id" but trainStat:null -> canTrain false (no id-classifier)', () => {
    // This is the key anti-hardcoding probe: item id=2 is the real "Power Root" in content,
    // but if trainStat is null, canTrain must be false regardless of the id value.
    // Kills: any impl that uses a hardcoded set of "known food ids" to gate canTrain.
    const defs = new Map([[2, itemDef(2, { trainStat: null })]]);
    const inv = inventoryItem(1n, 2, 5); // itemId=2 is the real Power Root, but no trainStat
    const vm = buildRaisingViewModel([], [inv], defs);
    expect(vm.items[0]!.canTrain).toBe(false);
  });

  it('BITES: two items — one with trainStat, one without — correctly classified independently', () => {
    // Kills: an impl that applies a single all-or-nothing canTrain decision
    // (e.g. "if any item has trainStat, all items get canTrain:true").
    const defs = new Map([
      [1, trainItemDef(1, 'Hp')],
      [2, itemDef(2, { trainStat: null })],
    ]);
    const items = [inventoryItem(1n, 1, 2), inventoryItem(2n, 2, 1)];
    const vm = buildRaisingViewModel([], items, defs);
    const itemVms = vm.items;
    const trainItem = itemVms.find((i) => i.itemId === 1)!;
    const nonTrainItem = itemVms.find((i) => i.itemId === 2)!;
    expect(trainItem.canTrain).toBe(true);
    expect(nonTrainItem.canTrain).toBe(false);
  });

  it('BITES: every StatKind tag -> canTrain true (not just "Attack")', () => {
    // Kills: an impl that only whitelists specific stat tags.
    const tags = ['Hp', 'Attack', 'Defense', 'Speed', 'SpAttack', 'SpDefense'] as const;
    for (const tag of tags) {
      const defs = new Map([[1, trainItemDef(1, tag)]]);
      const inv = inventoryItem(1n, 1, 1);
      const vm = buildRaisingViewModel([], [inv], defs);
      expect(vm.items[0]!.canTrain).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// S4 — buildRaisingViewModel is TOTAL: never throws, returns safe VMs
// ---------------------------------------------------------------------------

describe('buildRaisingViewModel S4: never throws, returns safe defaults (S4)', () => {
  it('S4: BITES empty inputs -> { monsters: [], items: [] } (no throw, no crash)', () => {
    // Kills: an impl that throws on empty arrays or crashes when maps are empty.
    let vm: RaisingViewModel;
    expect(() => {
      vm = buildRaisingViewModel([], [], new Map());
    }).not.toThrow();
    expect(vm!.monsters).toHaveLength(0);
    expect(vm!.items).toHaveLength(0);
  });

  it('S4: BITES unknown itemId (no def in map) -> name "Unknown (#id)", description "", canTrain false', () => {
    // A throw here would starve sibling batch listeners (store.ts one-way flow).
    // Kills: an impl that throws on Map.get() returning undefined.
    const inv = inventoryItem(1n, 42, 3); // itemId 42 not in defs
    let vm: RaisingViewModel;
    expect(() => {
      vm = buildRaisingViewModel([], [inv], new Map());
    }).not.toThrow();
    const item = vm!.items[0]!;
    expect(item.name).toBe('Unknown (#42)');
    expect(item.description).toBe('');
    expect(item.canTrain).toBe(false);
    expect(item.trainStat).toBeNull();
  });

  it('S4: BITES missing def -> count is preserved from the inventory row', () => {
    // The count field comes from the inventory row, not the def. Must survive missing def.
    // Kills: an impl that reads count from the def (which is undefined here).
    const inv = inventoryItem(1n, 99, 7); // count=7, no def
    const vm = buildRaisingViewModel([], [inv], new Map());
    expect(vm.items[0]!.count).toBe(7);
  });

  it('S4: BITES multiple unknown itemIds — each gets its own "Unknown (#id)" name', () => {
    // Kills: an impl that returns "Unknown" without the id, making all unknowns indistinguishable.
    const items = [inventoryItem(1n, 10, 1), inventoryItem(2n, 20, 1)];
    const vm = buildRaisingViewModel([], items, new Map());
    const names = vm.items.map((i) => i.name);
    expect(names).toContain('Unknown (#10)');
    expect(names).toContain('Unknown (#20)');
  });

  it('S4: BITES many monsters and items — no throw on large inputs', () => {
    // Regression guard: a totalising impl must stay non-throwing under scale.
    // Kills: an impl with a size-based guard that throws when inputs are large.
    const monsters = Array.from({ length: 30 }, (_, i) => monster(BigInt(i + 1)));
    const defs = new Map(
      Array.from({ length: 50 }, (_, i) => [i + 1, itemDef(i + 1)] as [number, StoreItemRow]),
    );
    const items = Array.from({ length: 50 }, (_, i) => inventoryItem(BigInt(i + 1), i + 1, i + 1));
    expect(() => {
      buildRaisingViewModel(monsters, items, defs);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// RaisingViewModel structure tests
// ---------------------------------------------------------------------------

describe('buildRaisingViewModel: output structure', () => {
  it('BITES: monsters and items arrays are present on the returned object', () => {
    // Kills: an impl that returns only one of the two arrays or a flat structure.
    const vm = buildRaisingViewModel([], [], new Map());
    expect(vm).toHaveProperty('monsters');
    expect(vm).toHaveProperty('items');
    expect(Array.isArray(vm.monsters)).toBe(true);
    expect(Array.isArray(vm.items)).toBe(true);
  });

  it('BITES: InventoryItemViewModel has all required fields when def is present', () => {
    // Kills: an impl that omits any of the required InventoryItemViewModel fields.
    const defs = new Map([[5, trainItemDef(5, 'Defense')]]);
    const inv = inventoryItem(10n, 5, 4);
    const vm = buildRaisingViewModel([], [inv], defs);
    const item = vm.items[0]!;
    expect(item).toHaveProperty('invId');
    expect(item).toHaveProperty('itemId');
    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('description');
    expect(item).toHaveProperty('count');
    expect(item).toHaveProperty('trainStat');
    expect(item).toHaveProperty('canTrain');
    // Spot-check values
    expect(item.invId).toBe(10n);
    expect(item.itemId).toBe(5);
    expect(item.name).toBe('Item-5');
    expect(item.count).toBe(4);
    expect(item.trainStat).toBe('Defense');
    expect(item.canTrain).toBe(true);
  });

  it('BITES: RaisingMonsterViewModel has all required fields', () => {
    // Kills: an impl that omits any of the required RaisingMonsterViewModel fields.
    const m = monster(3n, { nickname: 'Blaze', level: 12, bond: 80 });
    const vm = buildRaisingViewModel([m], [], new Map());
    const mon = vm.monsters[0]!;
    expect(mon).toHaveProperty('monsterId');
    expect(mon).toHaveProperty('nickname');
    expect(mon).toHaveProperty('level');
    expect(mon).toHaveProperty('bond');
    expect(mon).toHaveProperty('currentHp');
    expect(mon).toHaveProperty('statHp');
    expect(mon).toHaveProperty('statAttack');
    expect(mon).toHaveProperty('statDefense');
    expect(mon).toHaveProperty('statSpeed');
    expect(mon).toHaveProperty('statSpAttack');
    expect(mon).toHaveProperty('statSpDefense');
  });

  it('BITES: multiple monsters in -> multiple monsters in output (same count, same order)', () => {
    // Kills: an impl that deduplicates or re-sorts the monsters array.
    const monsters = [
      monster(3n, { nickname: 'Third' }),
      monster(1n, { nickname: 'First' }),
      monster(2n, { nickname: 'Second' }),
    ];
    const vm = buildRaisingViewModel(monsters, [], new Map());
    expect(vm.monsters).toHaveLength(3);
    // Order preserved: same order as input (no re-sort by monsterId)
    expect(vm.monsters[0]!.monsterId).toBe(3n);
    expect(vm.monsters[1]!.monsterId).toBe(1n);
    expect(vm.monsters[2]!.monsterId).toBe(2n);
  });

  it('BITES: trainStat from def is copied verbatim to InventoryItemViewModel.trainStat', () => {
    // Kills: an impl that always sets trainStat:null or sets it to true/false.
    const defs = new Map([[1, trainItemDef(1, 'SpAttack')]]);
    const inv = inventoryItem(1n, 1, 1);
    const vm = buildRaisingViewModel([], [inv], defs);
    expect(vm.items[0]!.trainStat).toBe('SpAttack');
  });
});
