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

export interface BenchMemberVM {
  readonly teamIndex: number;
  readonly speciesName: string;
  readonly currentHp: number;
  readonly maxHp: number;
}

/**
 * A bait item the player may apply to a recruit attempt. `recruitBonus > 0`
 * (the data-classify rule, ADR-0047) is the ONLY criterion for inclusion — never
 * a hardcoded item id.
 */
export interface BaitItem {
  readonly itemId: number;
  readonly name: string;
  readonly recruitBonus: number;
  readonly count: number;
}

/** A selectable bait option in the recruit UI (already filtered to bait). */
export interface BaitOptionVM {
  readonly itemId: number;
  readonly name: string;
  readonly recruitBonus: number;
  readonly count: number;
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
  /** Non-active, non-fainted team members the player can swap to. */
  readonly bench: readonly BenchMemberVM[];
  /**
   * True only in an ONGOING WILD battle. Wild is detected by the documented
   * asymmetry (ADR-0045): a wild battle has NO owned opponent monster row, so
   * `opponentMonsterIds.length === 0` while `sideB.team.length === 1`.
   */
  readonly canRecruit: boolean;
  /** Bait options (recruit_bonus > 0), classified by data — empty when none. */
  readonly baitOptions: readonly BaitOptionVM[];
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
  baitItems: readonly BaitItem[] = [],
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

  const bench: BenchMemberVM[] = [];
  if (ongoing) {
    for (let i = 0; i < sideA.team.length; i++) {
      const m = sideA.team[i]!;
      if (i !== sideA.active && m.currentHp > 0) {
        bench.push({
          teamIndex: i,
          speciesName: speciesMap.get(m.speciesId)?.name ?? `Unknown (#${m.speciesId})`,
          currentHp: m.currentHp,
          maxHp: m.maxHp,
        });
      }
    }
  }

  // Wild detection (ADR-0045): the wild opponent is UNOWNED, so it has no entry
  // in opponentMonsterIds even though sideB.team holds the wild BattleMonster.
  const isWild = battle.opponentMonsterIds.length === 0;
  const canRecruit = ongoing && isWild;

  // Bait options: classify by DATA (recruit_bonus > 0), never by item id, and
  // only surface stacks the player actually holds (count > 0). Empty when not
  // recruitable.
  const baitOptions: BaitOptionVM[] = canRecruit
    ? baitItems
        .filter((b) => b.recruitBonus > 0 && b.count > 0)
        .map((b) => ({
          itemId: b.itemId,
          name: b.name,
          recruitBonus: b.recruitBonus,
          count: b.count,
        }))
    : [];

  return {
    battleId: battle.battleId,
    turnNumber: battle.turnNumber,
    outcome: battle.outcome,
    playerCard: monsterCard(playerMon, speciesMap),
    opponentCard: monsterCard(opponentMon, speciesMap),
    skills,
    canFlee: ongoing,
    canSwap: bench.length > 0,
    bench,
    canRecruit,
    baitOptions,
  };
}
