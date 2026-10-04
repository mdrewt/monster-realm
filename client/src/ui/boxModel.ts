// ui/boxModel.ts — pure view-model for the box/party screen.
//
// No DOM, no SDK, no side effects. Takes store data, returns view-models.
// The thin DOM shell (boxView.ts) renders these; the loop refreshes on batch.
import type { StoreEvolutionPath, StoreMonsterPub, StoreSpeciesRow } from '../net/store';
// EG4-8 (contract A4/A16): the ONE eligibility predicate, imported — never re-implemented
// here. House precedent runs the other way too (battleModel.ts imports hpPercent below).
import { eligibleEvolutionPaths } from './evolutionModel';

export interface MonsterCardViewModel {
  readonly monsterId: bigint;
  readonly speciesName: string;
  readonly nickname: string;
  readonly level: number;
  readonly currentHp: number;
  readonly statHp: number;
  readonly hpPercent: number;
  readonly partySlot: number;
  /** True IFF this monster has 2+ CURRENTLY-ELIGIBLE evolution paths — the
   *  ambiguous case the server will never auto-resolve, so it needs the player. */
  readonly evolutionChoicePending: boolean;
}

function toCard(
  m: StoreMonsterPub,
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
  paths: readonly StoreEvolutionPath[],
): MonsterCardViewModel {
  return {
    monsterId: m.monsterId,
    speciesName: speciesMap.get(m.speciesId)?.name ?? `Unknown (#${m.speciesId})`,
    nickname: m.nickname,
    level: m.level,
    currentHp: m.currentHp,
    statHp: m.statHp,
    hpPercent: hpPercent(m.currentHp, m.statHp),
    partySlot: m.partySlot,
    evolutionChoicePending: eligibleEvolutionPaths(m, paths).length >= 2,
  };
}

export function buildPartyViewModel(
  monsters: readonly StoreMonsterPub[],
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
  partySize: number,
  paths: readonly StoreEvolutionPath[] = [],
): (MonsterCardViewModel | null)[] {
  const slots: (MonsterCardViewModel | null)[] = Array.from({ length: partySize }, () => null);
  for (const m of monsters) {
    if (m.partySlot < partySize) {
      slots[m.partySlot] = toCard(m, speciesMap, paths);
    }
  }
  return slots;
}

export function buildBoxViewModel(
  monsters: readonly StoreMonsterPub[],
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
  partySlotNone: number,
  paths: readonly StoreEvolutionPath[] = [],
): MonsterCardViewModel[] {
  return monsters
    .filter((m) => m.partySlot === partySlotNone)
    .map((m) => toCard(m, speciesMap, paths));
}

export function hpPercent(currentHp: number, statHp: number): number {
  if (statHp <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((currentHp / statHp) * 100)));
}

/** The "next free party slot" request the Monsters view's To Party emits. `resolvePartySlot`
 *  turns it into a real slot; the server never sees it. */
export const NEXT_FREE_PARTY_SLOT = -1;

export type PartySlotResolution =
  | { readonly kind: 'send'; readonly slot: number }
  | { readonly kind: 'partyFull' };

/** The slot a move sends: an explicit slot (or the box sentinel) as-is, the next-free request as
 *  the first free slot — or `partyFull`, since sending the box sentinel then would be an accepted
 *  server no-op the player never sees. */
export function resolvePartySlot(
  requested: number,
  ownMonsters: readonly StoreMonsterPub[],
  partySize: number,
): PartySlotResolution {
  if (requested !== NEXT_FREE_PARTY_SLOT) return { kind: 'send', slot: requested };
  const free = nextFreePartySlot(ownMonsters, partySize);
  return free === null ? { kind: 'partyFull' } : { kind: 'send', slot: free };
}

export function nextFreePartySlot(
  monsters: readonly StoreMonsterPub[],
  partySize: number,
): number | null {
  const occupied = new Set(monsters.filter((m) => m.partySlot < partySize).map((m) => m.partySlot));
  for (let slot = 0; slot < partySize; slot++) {
    if (!occupied.has(slot)) return slot;
  }
  return null;
}
