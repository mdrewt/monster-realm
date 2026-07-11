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
  /** Short status badge label ("PSN", "BRN", "PAR", "SLP", "FRZ"), or null. */
  readonly status: string | null;
}

/** Map a StatusEffect tag to a short badge label. Pure — unit-testable. */
export function statusBadge(tag: string | null | undefined): string {
  if (!tag) return '';
  switch (tag) {
    case 'Poison':
      return 'PSN';
    case 'Burn':
      return 'BRN';
    case 'Paralysis':
      return 'PAR';
    case 'Sleep':
      return 'SLP';
    case 'Freeze':
      return 'FRZ';
    default:
      return '';
  }
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
 * a hardcoded item id. Also serves directly as the selectable bait option in the
 * recruit UI (consumed unchanged — no transformation, so no separate VM type).
 */
export interface BaitItem {
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
  readonly baitOptions: readonly BaitItem[];
}

function monsterCard(
  mon: {
    speciesId: number;
    level: number;
    currentHp: number;
    maxHp: number;
    affinity: string;
    status: { tag: string } | null;
  },
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
): BattleMonsterCardVM {
  return {
    speciesName: speciesMap.get(mon.speciesId)?.name ?? `Unknown (#${mon.speciesId})`,
    level: mon.level,
    currentHp: mon.currentHp,
    maxHp: mon.maxHp,
    hpPercent: hpPercent(mon.currentHp, mon.maxHp),
    affinity: mon.affinity,
    status: statusBadge(mon.status?.tag) || null,
  };
}

export function buildBattleViewModel(
  battle: StoreBattle,
  skillMap: ReadonlyMap<number, StoreSkillRow>,
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
  baitItems: readonly BaitItem[] = [],
): BattleViewModel | null {
  const { sideA, sideB } = battle;
  if (!sideA.team.length || sideA.active < 0 || sideA.active >= sideA.team.length) return null;
  if (!sideB.team.length || sideB.active < 0 || sideB.active >= sideB.team.length) return null;

  // biome-ignore lint/style/noNonNullAssertion: active index validated by the guard above
  const playerMon = sideA.team[sideA.active]!;
  // biome-ignore lint/style/noNonNullAssertion: active index validated by the guard above
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
      // biome-ignore lint/style/noNonNullAssertion: i is bounded by sideA.team.length
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
  const baitOptions: readonly BaitItem[] = canRecruit
    ? baitItems.filter((b) => b.recruitBonus > 0 && b.count > 0)
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

// ---------------------------------------------------------------------------
// M8.7e — battle-overlay decision (pure reducer for the outcome-frame lifecycle)
// ---------------------------------------------------------------------------

export type BattleOverlayAction =
  | { readonly kind: 'show'; readonly battle: StoreBattle }
  | { readonly kind: 'hide' };
export interface OverlayState {
  readonly dismissedBattleId: bigint | null;
  readonly synced: boolean;
}
export interface OverlayResult {
  readonly action: BattleOverlayAction;
  readonly dismissedBattleId: bigint | null;
  readonly synced: boolean;
}

/**
 * Pure overlay decision (no DOM, store, or timers): a (state, input) → (action,
 * nextState) reducer that decides whether the battle overlay shows a battle
 * (Ongoing auto-shows; a resolved battle shows its outcome frame) or hides — and
 * tracks the dismiss/first-sight lifecycle so a resolved outcome renders once but
 * never re-pops, and a battle already terminal at first sight (historical/stale on
 * login) is pre-dismissed rather than popped. (M8.7e, EARS §3; ADR-0014.)
 */
export function decideBattleOverlay(
  latest: StoreBattle | undefined,
  state: OverlayState,
): OverlayResult {
  // 1. No battle for this player → hide, state untouched.
  if (latest === undefined) {
    return {
      action: { kind: 'hide' },
      dismissedBattleId: state.dismissedBattleId,
      synced: state.synced,
    };
  }
  // 2. First battle observed this session (synced becomes true).
  if (!state.synced) {
    // A row already terminal at first sight is historical → pre-dismiss, don't pop.
    if (latest.outcome !== 'Ongoing') {
      return { action: { kind: 'hide' }, dismissedBattleId: latest.battleId, synced: true };
    }
    return {
      action: { kind: 'show', battle: latest },
      dismissedBattleId: state.dismissedBattleId,
      synced: true,
    };
  }
  // 3. Steady state: a dismissed (or pre-dismissed) battle stays hidden; anything
  //    else shows (Ongoing auto-shows; a mid-session terminal shows its outcome).
  if (state.dismissedBattleId === latest.battleId) {
    return { action: { kind: 'hide' }, dismissedBattleId: state.dismissedBattleId, synced: true };
  }
  return {
    action: { kind: 'show', battle: latest },
    dismissedBattleId: state.dismissedBattleId,
    synced: true,
  };
}
