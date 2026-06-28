// ui/raisingModel.ts — pure view-model for the raising/inventory screen (M9c).
//
// No DOM, no SDK, no side effects, no stat recompute, no id-classification.
// Monster stats are server-DERIVED (ADR-0016) and copied VERBATIM. Items are
// classified as trainable purely by DATA (def.trainStat present), never by a
// hardcoded id list. TOTAL: never throws on empty/unknown/missing input — a throw
// here would starve sibling store batch-listeners (store.ts one-way flow).
import type { StoreInventory, StoreItemRow, StoreMonsterPub } from '../net/store';

export interface RaisingMonsterViewModel {
  readonly monsterId: bigint;
  readonly nickname: string;
  readonly level: number;
  readonly bond: number;
  readonly currentHp: number;
  readonly statHp: number;
  readonly statAttack: number;
  readonly statDefense: number;
  readonly statSpeed: number;
  readonly statSpAttack: number;
  readonly statSpDefense: number;
}

export interface InventoryItemViewModel {
  readonly invId: bigint;
  readonly itemId: number;
  readonly name: string;
  readonly description: string;
  readonly count: number;
  readonly trainStat: string | null;
  readonly canTrain: boolean;
}

export interface RaisingViewModel {
  readonly monsters: readonly RaisingMonsterViewModel[];
  readonly items: readonly InventoryItemViewModel[];
}

function toMonster(m: StoreMonsterPub): RaisingMonsterViewModel {
  return {
    monsterId: m.monsterId,
    nickname: m.nickname,
    level: m.level,
    bond: m.bond,
    currentHp: m.currentHp,
    statHp: m.statHp,
    statAttack: m.statAttack,
    statDefense: m.statDefense,
    statSpeed: m.statSpeed,
    statSpAttack: m.statSpAttack,
    statSpDefense: m.statSpDefense,
  };
}

function toItem(
  item: StoreInventory,
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): InventoryItemViewModel {
  const def = itemDefs.get(item.itemId);
  // `def.trainAmount` is available on StoreItemRow but deliberately not surfaced
  // here — the Train button shows no "+N to stat" magnitude yet (follow-up UI).
  return {
    invId: item.invId,
    itemId: item.itemId,
    name: def?.name ?? `Unknown (#${item.itemId})`,
    description: def?.description ?? '',
    count: item.count,
    trainStat: def?.trainStat ?? null,
    canTrain: def != null && def.trainStat != null,
  };
}

export function buildRaisingViewModel(
  monsters: readonly StoreMonsterPub[],
  inventory: readonly StoreInventory[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
): RaisingViewModel {
  return {
    monsters: monsters.map(toMonster),
    items: inventory.map((item) => toItem(item, itemDefs)),
  };
}
