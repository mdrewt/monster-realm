// ui/monstersModel.ts — the Monsters frame's pure model (design §5, CTL8B.1): the Party list and
// the Storage grid as one tabbed nav layout. No DOM, SDK, module state or clock. The party size and
// the "boxed" sentinel are game-core's (the `party_size()` / `party_slot_none()` wasm exports),
// handed in by the screen: never TS literals.
import type { StoreEvolutionPath, StoreMonsterPub, StoreSpeciesRow } from '../net/store';
import { buildBoxViewModel, buildPartyViewModel, type MonsterCardViewModel } from './boxModel';
import { grid, list, type NavLayout, tabs } from './nav';

export type MonstersTab = 'party' | 'storage';
export type SheetAction = 'summary' | 'nickname' | 'move';

/** The sheet's actions in display order (Care, Feed… and Evolve… join in ctl-8c). */
export const SHEET_ACTIONS: readonly SheetAction[] = ['summary', 'nickname', 'move'];

/** The Storage grid's columns: the three boxView draws. */
export const STORAGE_COLS = 3;

/** The sheet's nav list. */
export const SHEET_LAYOUT = list(SHEET_ACTIONS.map((key) => ({ key, enabled: true })));

export interface MonstersVm {
  /** The occupied party slots in slot order (at most the party size). */
  readonly party: readonly MonsterCardViewModel[];
  /** The boxed monsters, in store order. */
  readonly storage: readonly MonsterCardViewModel[];
  /** The slot a Move to Storage sends: game-core's PARTY_SLOT_NONE. */
  readonly partySlotNone: number;
}

export function buildMonstersVm(
  monsters: readonly StoreMonsterPub[],
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
  partySize: number,
  partySlotNone: number,
  paths: readonly StoreEvolutionPath[] = [],
): MonstersVm {
  return {
    party: buildPartyViewModel(monsters, speciesMap, partySize, paths).filter(
      (card): card is MonsterCardViewModel => card !== null,
    ),
    storage: buildBoxViewModel(monsters, speciesMap, partySlotNone, paths),
    partySlotNone,
  };
}

/** A monster's nav key: its id in decimal. */
export function monsterKey(monsterId: bigint): string {
  return monsterId.toString();
}

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
