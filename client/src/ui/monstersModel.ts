// ui/monstersModel.ts — the Monsters frame's pure model (design §5, CTL8B.1): the Party list and
// the Storage grid as one tabbed nav layout. No DOM, SDK, module state or clock. The party size and
// the "boxed" sentinel are game-core's (the `party_size()` / `party_slot_none()` wasm exports),
// handed in by the screen: never TS literals.
import type { StoreEvolutionPath, StoreMonsterPub, StoreSpeciesRow } from '../net/store';
import type { MonsterCardViewModel } from './boxModel';
import type { NavLayout } from './nav';

export type MonstersTab = 'party' | 'storage';
export type SheetAction = 'summary' | 'nickname' | 'move';

/** The sheet's actions in display order (Care, Feed… and Evolve… join in ctl-8c). */
export const SHEET_ACTIONS: readonly SheetAction[] = ['summary', 'nickname', 'move'];

/** The Storage grid's columns: the three boxView draws. */
export const STORAGE_COLS = 3;

export interface MonstersVm {
  /** The occupied party slots in slot order (at most the party size). */
  readonly party: readonly MonsterCardViewModel[];
  /** The boxed monsters, in store order. */
  readonly storage: readonly MonsterCardViewModel[];
  /** The slot a Move to Storage sends: game-core's PARTY_SLOT_NONE. */
  readonly partySlotNone: number;
}

export function buildMonstersVm(
  _monsters: readonly StoreMonsterPub[],
  _speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
  _partySize: number,
  _partySlotNone: number,
  _paths: readonly StoreEvolutionPath[] = [],
): MonstersVm {
  throw new Error('ctl-8b: unimplemented');
}

/** A monster's nav key: its id in decimal. */
export function monsterKey(_monsterId: bigint): string {
  throw new Error('ctl-8b: unimplemented');
}

/** Tabs `party` (a list) and `storage` (a grid of STORAGE_COLS), items keyed by `monsterKey`. */
export function monstersLayout(_vm: MonstersVm): NavLayout {
  throw new Error('ctl-8b: unimplemented');
}

/** Where a monster is listed, or undefined when it is in neither list. */
export function findMonster(
  _vm: MonstersVm,
  _monsterId: bigint,
): { readonly tab: MonstersTab; readonly card: MonsterCardViewModel } | undefined {
  throw new Error('ctl-8b: unimplemented');
}
