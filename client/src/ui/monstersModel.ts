// ui/monstersModel.ts — the Monsters frame's pure model (design §5, CTL8B.1, CTL8C.1): the Party
// list and the Storage grid as one tabbed nav layout, the monster sheet's rows, the food list and
// the evolution paths. No DOM, SDK, module state or clock. The party size and the "boxed" sentinel
// are game-core's (the `party_size()` / `party_slot_none()` wasm exports), handed in by the screen:
// never TS literals.
//
// ctl-8c: what is FOOD is the raising screen's data-driven rule (`InventoryItemViewModel.canTrain`,
// an item definition with a `trainStat`), never an id list here. Which evolution paths a monster
// may CHOOSE is the evolution port's (`EvolutionMonsterViewModel.choices`, non-empty only at 2+
// eligible paths: at exactly one the server auto-applies it); this file re-derives neither.
import type { StoreEvolutionPath, StoreMonsterPub, StoreSpeciesRow } from '../net/store';
import { buildBoxViewModel, buildPartyViewModel, type MonsterCardViewModel } from './boxModel';
import {
  buildEvolutionViewModel,
  type EvolutionMonsterViewModel,
  type EvolutionPathViewModel,
} from './evolutionModel';
import { grid, type ItemLayout, list, type NavLayout, tabs } from './nav';
import type { InventoryItemViewModel } from './raisingModel';

export type MonstersTab = 'party' | 'storage';
export type SheetAction = 'summary' | 'care' | 'feed' | 'evolve' | 'nickname' | 'move';

/** The sheet's actions in display order (design §5 row 1). */
export const SHEET_ACTIONS: readonly SheetAction[] = [
  'summary',
  'care',
  'feed',
  'evolve',
  'nickname',
  'move',
];

/** The Storage grid's columns: the three boxView draws. */
export const STORAGE_COLS = 3;

/** The sheet's nav list. Feed… is disabled with no food, Evolve… with no outgoing path; a disabled
 *  row stays reachable (the nav kit's rule), so the player can read why. */
export function sheetLayout(canFeed: boolean, canEvolve: boolean): ItemLayout {
  return list(
    SHEET_ACTIONS.map((key) => ({
      key,
      enabled: key === 'feed' ? canFeed : key === 'evolve' ? canEvolve : true,
    })),
  );
}

/** One food the player can feed: a trainable item with stock. */
export interface FoodVm {
  readonly itemId: number;
  readonly name: string;
  readonly count: number;
}

export interface MonstersVm {
  /** The occupied party slots in slot order (at most the party size). */
  readonly party: readonly MonsterCardViewModel[];
  /** The boxed monsters, in store order. */
  readonly storage: readonly MonsterCardViewModel[];
  /** The slot a Move to Storage sends: game-core's PARTY_SLOT_NONE. */
  readonly partySlotNone: number;
  /** The foods in stock, one per item id (the first row wins), by numeric item id. */
  readonly foods: readonly FoodVm[];
  /** The evolution port's view model, one per own monster, in store order. */
  readonly evolution: readonly EvolutionMonsterViewModel[];
}

export function buildMonstersVm(
  monsters: readonly StoreMonsterPub[],
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
  partySize: number,
  partySlotNone: number,
  paths: readonly StoreEvolutionPath[] = [],
  items: readonly InventoryItemViewModel[] = [],
): MonstersVm {
  return {
    party: buildPartyViewModel(monsters, speciesMap, partySize, paths).filter(
      (card): card is MonsterCardViewModel => card !== null,
    ),
    storage: buildBoxViewModel(monsters, speciesMap, partySlotNone, paths),
    partySlotNone,
    foods: foodsOf(items),
    evolution: buildEvolutionViewModel(monsters, speciesMap, paths).monsters,
  };
}

/** The trainable items with stock, deduped by item id (the nav kit throws on a duplicate key, and
 *  a throw in a view model starves the host), sorted by NUMERIC id. */
function foodsOf(items: readonly InventoryItemViewModel[]): FoodVm[] {
  const seen = new Set<number>();
  const foods: FoodVm[] = [];
  for (const item of items) {
    if (!item.canTrain || item.count <= 0 || seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    foods.push({ itemId: item.itemId, name: item.name, count: item.count });
  }
  return foods.sort((a, b) => a.itemId - b.itemId);
}

/** A monster's name as the frame shows it: the nickname, else the species. */
export function cardName(card: MonsterCardViewModel): string {
  return card.nickname || card.speciesName;
}

/** A monster's nav key: its id in decimal. */
export function monsterKey(monsterId: bigint): string {
  return monsterId.toString();
}

/** A food's nav key: its item id in decimal. */
export const foodKey = (itemId: number): string => String(itemId);

/** An evolution path's nav key: its authored edge id in decimal. */
export const pathKey = (edgeId: number): string => String(edgeId);

const keysOf = (cards: readonly MonsterCardViewModel[]): string[] =>
  cards.map((card) => monsterKey(card.monsterId));

/** Tabs `party` (a list) and `storage` (a grid of STORAGE_COLS), items keyed by `monsterKey`. */
export function monstersLayout(vm: MonstersVm): NavLayout {
  return layoutOfKeys(keysOf(vm.party), keysOf(vm.storage));
}

/** The same layout over bare keys: what the screen re-seats its cursor from. */
export function layoutOfKeys(party: readonly string[], storage: readonly string[]): NavLayout {
  const items = (keys: readonly string[]) => keys.map((key) => ({ key, enabled: true }));
  return tabs([
    { key: 'party', layout: list(items(party)) },
    { key: 'storage', layout: grid(items(storage), STORAGE_COLS) },
  ]);
}

/** Where a monster is listed, or undefined when it is in neither list. */
export function findMonster(
  vm: MonstersVm,
  monsterId: bigint,
): { readonly tab: MonstersTab; readonly card: MonsterCardViewModel } | undefined {
  const party = vm.party.find((c) => c.monsterId === monsterId);
  if (party !== undefined) return { tab: 'party', card: party };
  const stored = vm.storage.find((c) => c.monsterId === monsterId);
  return stored === undefined ? undefined : { tab: 'storage', card: stored };
}

/** The food list: every food in stock, all enabled. */
export function foodLayoutOf(foods: readonly FoodVm[]): ItemLayout {
  return list(foods.map((food) => ({ key: foodKey(food.itemId), enabled: true })));
}

export function foodLayout(vm: MonstersVm): ItemLayout {
  return foodLayoutOf(vm.foods);
}

/** A monster's evolution view model, or undefined when it is not the player's. */
export function findEvolution(
  vm: MonstersVm,
  monsterId: bigint,
): EvolutionMonsterViewModel | undefined {
  return vm.evolution.find((mon) => mon.monsterId === monsterId);
}

/** Evolve… is enabled when the species has ANY outgoing path, met or not: the list is also where
 *  the player reads what a path still needs. */
export function canEvolve(mon: EvolutionMonsterViewModel): boolean {
  return mon.paths.length > 0;
}

/** Whether the path keyed `key` is one the player may pick (the port's `choices`). */
export function isChoice(mon: EvolutionMonsterViewModel, key: string): boolean {
  return mon.choices.some((path) => pathKey(path.edgeId) === key);
}

/** The path keyed `key`, or undefined. */
export function findPath(
  mon: EvolutionMonsterViewModel,
  key: string,
): EvolutionPathViewModel | undefined {
  return mon.paths.find((path) => pathKey(path.edgeId) === key);
}

/** The Evolve list: every outgoing path by edge id, only the choices enabled. */
export function pathLayout(mon: EvolutionMonsterViewModel): ItemLayout {
  const seen = new Set<string>();
  const items: { key: string; enabled: boolean }[] = [];
  for (const path of mon.paths) {
    const key = pathKey(path.edgeId);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, enabled: isChoice(mon, key) });
  }
  return list(items);
}

/** Where the Evolve list opens: the first choice, else the first path, else nothing. */
export function firstPathKey(mon: EvolutionMonsterViewModel): string | null {
  const first = mon.choices[0] ?? mon.paths[0];
  return first === undefined ? null : pathKey(first.edgeId);
}
