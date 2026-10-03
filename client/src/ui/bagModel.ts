// ui/bagModel.ts — the pure Bag view model (design §5 row 2; CTL8F.1, CTL8F.2). No DOM, SDK,
// module state or clock.
//
// An item definition carries no pocket field, so the pocket is DERIVED from what the item does:
// a training stat makes it Food, a cured status Medicine, a recruit bonus Bait, and anything else
// (the essence shards, an unknown definition) lands in Other. The tabs are the pockets the
// definitions hold, ordered by the lowest item id in each, so content decides both which tabs
// exist and their order; no item id and no fixed tab list appear here.
import type { StoreInventory, StoreItemRow, StoreMonsterPub, StoreSpeciesRow } from '../net/store';
import { buildBoxViewModel, buildPartyViewModel, type MonsterCardViewModel } from './boxModel';
import { cardName, monsterKey } from './monstersModel';
import { type ItemLayout, list, type NavLayout, tabs } from './nav';
import { buildInventoryItems } from './raisingModel';

export type Pocket = 'bait' | 'food' | 'medicine' | 'other';

export interface BagItemVm {
  /** The nav key: the item id in decimal. */
  readonly key: string;
  readonly itemId: number;
  readonly name: string;
  readonly description: string;
  readonly count: number;
  /** Food: a monster can be fed it (`train`). */
  readonly canFeed: boolean;
  /** Used from the battle Bag command (a cure or a bait), never from this screen. */
  readonly battleUse: boolean;
}

export interface BagPocketVm {
  readonly pocket: Pocket;
  readonly items: readonly BagItemVm[];
}

/** A Feed target. */
export interface BagMonsterVm {
  readonly key: string;
  readonly monsterId: bigint;
  readonly name: string;
}

export interface BagVm {
  readonly pockets: readonly BagPocketVm[];
  readonly monsters: readonly BagMonsterVm[];
}

export type BagAction = 'feed' | 'use' | 'info';

/** The pocket an item definition belongs to; an unknown definition is Other. */
export function pocketOf(def: StoreItemRow | undefined): Pocket {
  if (def === undefined) return 'other';
  if (def.trainStat != null) return 'food';
  if (def.cureStatus != null) return 'medicine';
  if (def.recruitBonus > 0) return 'bait';
  return 'other';
}

/** Every pocket a definition defines (owned or not) plus Other for an owned row with no
 *  definition, each with its owned items (count > 0, one row per item id, counts summed, in
 *  inventory order), ordered by the lowest item id in the pocket. */
export function buildBagVm(
  inventory: readonly StoreInventory[],
  itemDefs: ReadonlyMap<number, StoreItemRow>,
  monsters: readonly BagMonsterVm[],
): BagVm {
  const lowest = new Map<Pocket, number>();
  const claim = (pocket: Pocket, id: number): void => {
    const at = lowest.get(pocket);
    if (at === undefined || id < at) lowest.set(pocket, id);
  };
  for (const def of itemDefs.values()) claim(pocketOf(def), def.id);

  // One row per owned item id, at its first owned row, with every owned row's count summed.
  const counts = new Map<number, number>();
  const firstRows: StoreInventory[] = [];
  for (const row of inventory) {
    if (row.count <= 0) continue;
    if (!counts.has(row.itemId)) firstRows.push(row);
    counts.set(row.itemId, (counts.get(row.itemId) ?? 0) + row.count);
    if (!itemDefs.has(row.itemId)) claim('other', row.itemId);
  }
  const items = buildInventoryItems(firstRows, itemDefs).map((item) => {
    const def = itemDefs.get(item.itemId);
    return {
      key: String(item.itemId),
      itemId: item.itemId,
      name: item.name,
      description: item.description,
      count: counts.get(item.itemId) ?? 0,
      canFeed: item.canTrain,
      battleUse: def !== undefined && (def.cureStatus != null || def.recruitBonus > 0),
    };
  });

  const pockets = [...lowest.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([pocket]) => ({
      pocket,
      items: items.filter((item) => pocketOf(itemDefs.get(item.itemId)) === pocket),
    }));
  return { pockets, monsters };
}

/** The Feed targets: the party in slot order, then storage in store order, by their card name. */
export function bagMonsters(
  monsters: readonly StoreMonsterPub[],
  species: ReadonlyMap<number, StoreSpeciesRow>,
  partySize: number,
  partySlotNone: number,
): BagMonsterVm[] {
  const party = buildPartyViewModel(monsters, species, partySize).filter(
    (card): card is MonsterCardViewModel => card !== null,
  );
  return [...party, ...buildBoxViewModel(monsters, species, partySlotNone)].map((card) => ({
    key: monsterKey(card.monsterId),
    monsterId: card.monsterId,
    name: cardName(card),
  }));
}

/** One tab per pocket, each a list of its items. */
export function bagLayout(vm: BagVm): NavLayout {
  return tabs(
    vm.pockets.map((p) => ({
      key: p.pocket,
      layout: list(p.items.map((item) => ({ key: item.key, enabled: true }))),
    })),
  );
}

/** The item's actions: Feed (food; disabled with no monster to feed), Use (battle items, always
 *  disabled here: they are used from the battle Bag command), then Info. */
export function actionLayout(item: BagItemVm, hasMonsters: boolean): ItemLayout {
  const rows: { key: BagAction; enabled: boolean; reason?: string }[] = [];
  if (item.canFeed) {
    rows.push(
      hasMonsters
        ? { key: 'feed', enabled: true }
        : { key: 'feed', enabled: false, reason: 'noMonsters' },
    );
  }
  if (item.battleUse) rows.push({ key: 'use', enabled: false, reason: 'battleOnly' });
  rows.push({ key: 'info', enabled: true });
  return list(rows);
}

/** The Feed picker: one row per monster. */
export function pickerLayout(vm: BagVm): ItemLayout {
  return list(vm.monsters.map((m) => ({ key: m.key, enabled: true })));
}

export function findItem(vm: BagVm, itemId: number): BagItemVm | undefined {
  for (const p of vm.pockets) {
    const item = p.items.find((i) => i.itemId === itemId);
    if (item !== undefined) return item;
  }
  return undefined;
}
