// ui/boxModel.ts — pure view-model for the box/party screen (M6c, ADR-0014).
//
// No DOM, no SDK, no side effects. Takes store data, returns view-models.
// The thin DOM shell (boxView.ts) renders these; the loop refreshes on batch.
import type { StoreMonsterPub, StoreSpeciesRow } from '../net/store';

export interface MonsterCardViewModel {
  readonly monsterId: bigint;
  readonly speciesName: string;
  readonly nickname: string;
  readonly level: number;
  readonly currentHp: number;
  readonly statHp: number;
  readonly hpPercent: number;
  readonly partySlot: number;
}

const PARTY_SIZE = 6;
const BOX_SLOT = 255;

function toCard(
  m: StoreMonsterPub,
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
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
  };
}

export function buildPartyViewModel(
  monsters: readonly StoreMonsterPub[],
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
): (MonsterCardViewModel | null)[] {
  const slots: (MonsterCardViewModel | null)[] = Array.from({ length: PARTY_SIZE }, () => null);
  for (const m of monsters) {
    if (m.partySlot < PARTY_SIZE) {
      slots[m.partySlot] = toCard(m, speciesMap);
    }
  }
  return slots;
}

export function buildBoxViewModel(
  monsters: readonly StoreMonsterPub[],
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
): MonsterCardViewModel[] {
  return monsters.filter((m) => m.partySlot === BOX_SLOT).map((m) => toCard(m, speciesMap));
}

export function hpPercent(currentHp: number, statHp: number): number {
  if (statHp <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((currentHp / statHp) * 100)));
}

export function nextFreePartySlot(monsters: readonly StoreMonsterPub[]): number | null {
  const occupied = new Set(
    monsters.filter((m) => m.partySlot < PARTY_SIZE).map((m) => m.partySlot),
  );
  for (let slot = 0; slot < PARTY_SIZE; slot++) {
    if (!occupied.has(slot)) return slot;
  }
  return null;
}
