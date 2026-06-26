// ui/battleModel.ts — pure view-model for the battle screen (M7c, ADR-0014).
//
// No DOM, no SDK, no side effects. Takes store data, returns view-models.
// The thin DOM shell (battleView.ts) renders these; the loop refreshes on batch.
import type { StoreBattle, StoreSkillRow, StoreSpeciesRow } from '../net/store';
import { hpPercent } from './boxModel';

export interface BattleMonsterCardVM {
  readonly speciesName: string;
  readonly level: number;
  readonly currentHp: number;
  readonly maxHp: number;
  readonly hpPercent: number;
  readonly affinity: string;
}

export interface BattleSkillVM {
  readonly id: number;
  readonly name: string;
  readonly affinity: string;
  readonly power: number;
  readonly accuracy: number;
}

export interface BattleViewModel {
  readonly battleId: bigint;
  readonly turnNumber: number;
  readonly outcome: string;
  readonly playerCard: BattleMonsterCardVM;
  readonly opponentCard: BattleMonsterCardVM;
  readonly skills: readonly BattleSkillVM[];
  readonly canFlee: boolean;
  readonly canSwap: boolean;
}

function monsterCard(
  mon: { speciesId: number; level: number; currentHp: number; maxHp: number; affinity: string },
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
): BattleMonsterCardVM {
  return {
    speciesName: speciesMap.get(mon.speciesId)?.name ?? `Unknown (#${mon.speciesId})`,
    level: mon.level,
    currentHp: mon.currentHp,
    maxHp: mon.maxHp,
    hpPercent: hpPercent(mon.currentHp, mon.maxHp),
    affinity: mon.affinity,
  };
}

export function buildBattleViewModel(
  battle: StoreBattle,
  skillMap: ReadonlyMap<number, StoreSkillRow>,
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
): BattleViewModel | null {
  const { sideA, sideB } = battle;
  if (!sideA.team.length || sideA.active >= sideA.team.length) return null;
  if (!sideB.team.length || sideB.active >= sideB.team.length) return null;

  const playerMon = sideA.team[sideA.active]!;
  const opponentMon = sideB.team[sideB.active]!;
  const ongoing = battle.outcome === 'Ongoing';

  const skills: BattleSkillVM[] = [];
  for (const sid of playerMon.knownSkillIds) {
    const sk = skillMap.get(sid);
    if (sk)
      skills.push({
        id: sk.id,
        name: sk.name,
        affinity: sk.affinity,
        power: sk.power,
        accuracy: sk.accuracy,
      });
  }

  const canSwap = ongoing && sideA.team.some((m, i) => i !== sideA.active && m.currentHp > 0);

  return {
    battleId: battle.battleId,
    turnNumber: battle.turnNumber,
    outcome: battle.outcome,
    playerCard: monsterCard(playerMon, speciesMap),
    opponentCard: monsterCard(opponentMon, speciesMap),
    skills,
    canFlee: ongoing,
    canSwap,
  };
}
