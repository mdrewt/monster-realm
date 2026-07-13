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
      // New StatusEffect variant added on the Rust side without updating this map.
      // Warn loudly so the gap is visible at runtime (server bindings regen is needed).
      console.warn(
        `statusBadge: unknown status tag "${tag}" — update statusBadge in battleModel.ts`,
      );
      return '';
  }
}

/** Map a WeatherEffect tag to a display label. Pure — unit-testable.
 *  Returns non-empty string for known variants; console.warn + '' for unknown
 *  (identical contract to statusBadge — a bindings regen that adds a new variant
 *  fails the parity test, surfacing the gap at development time). */
export function weatherBanner(tag: string | null | undefined): string {
  if (!tag) return '';
  switch (tag) {
    case 'Rain':
      return 'Rain';
    case 'Sun':
      return 'Harsh Sun';
    case 'Sandstorm':
      return 'Sandstorm';
    case 'Hail':
      return 'Hail';
    default:
      // New WeatherEffect variant added on the Rust side without updating this map.
      // Warn loudly so the gap is visible at runtime (server bindings regen is needed).
      console.warn(
        `weatherBanner: unknown weather tag "${tag}" — update weatherBanner in battleModel.ts`,
      );
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

/**
 * The valid outcome tags for a battle. Hand-written from the server BattleOutcome enum.
 * The runtime parity test (battleModel.test.ts) asserts that BattleOutcome bindings
 * variants ⊆ this union — a bindings regen adding a new variant fails that test,
 * making this the regen-drift detector. Narrowing from StoreBattle.outcome (string)
 * lives ONLY in buildBattleViewModel; decideBattleOverlay keeps operating on string.
 */
export type BattleOutcomeTag = 'Ongoing' | 'SideAWins' | 'SideBWins' | 'Fled';

export interface BattleViewModel {
  readonly battleId: bigint;
  readonly turnNumber: number;
  readonly outcome: BattleOutcomeTag;
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
  /** Active weather display, or null when no weather is in effect. */
  readonly weather: { readonly label: string; readonly turnsRemaining: number } | null;
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

/** Parse a StoreBattle.outcome string against the BattleOutcomeTag union.
 *  Returns the narrowed tag or null if the string is not a known variant.
 *  Narrowing lives ONLY here — decideBattleOverlay keeps operating on string. */
function parseOutcomeTag(outcome: string): BattleOutcomeTag | null {
  if (
    outcome === 'Ongoing' ||
    outcome === 'SideAWins' ||
    outcome === 'SideBWins' ||
    outcome === 'Fled'
  ) {
    return outcome;
  }
  return null;
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

  // Parse outcome FIRST — unknown tag → warn + null (same null-guard path as corrupt-team).
  // This means the never-check in battleView.ts #renderOutcome is genuinely unreachable.
  const outcomeTag = parseOutcomeTag(battle.outcome);
  if (outcomeTag === null) {
    console.warn(
      `buildBattleViewModel: unknown outcome tag "${battle.outcome}" — update BattleOutcomeTag in battleModel.ts`,
    );
    return null;
  }

  // biome-ignore lint/style/noNonNullAssertion: active index validated by the guard above
  const playerMon = sideA.team[sideA.active]!;
  // biome-ignore lint/style/noNonNullAssertion: active index validated by the guard above
  const opponentMon = sideB.team[sideB.active]!;
  const ongoing = outcomeTag === 'Ongoing';

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

  // Weather: map StoreBattle.weather → VM weather (label + turnsRemaining).
  // battle.weather may be undefined in old test fixtures (vitest doesn't typecheck
  // StoreBattle at runtime) — treat undefined as null so the 778-baseline tests
  // stay green without editing them.
  const storeWeather = (battle as { weather?: { tag: string; turnsRemaining: number } | null })
    .weather;
  const weather =
    storeWeather != null
      ? { label: weatherBanner(storeWeather.tag), turnsRemaining: storeWeather.turnsRemaining }
      : null;

  return {
    battleId: battle.battleId,
    turnNumber: battle.turnNumber,
    outcome: outcomeTag,
    playerCard: monsterCard(playerMon, speciesMap),
    opponentCard: monsterCard(opponentMon, speciesMap),
    skills,
    canFlee: ongoing,
    canSwap: bench.length > 0,
    bench,
    canRecruit,
    baitOptions,
    weather,
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

// ---------------------------------------------------------------------------
// m14.5d — VM-compare guard (battleVMsEqual + shouldSkipBattleRefresh)
// ---------------------------------------------------------------------------

function cardEqual(a: BattleMonsterCardVM, b: BattleMonsterCardVM): boolean {
  return (
    a.speciesName === b.speciesName &&
    a.level === b.level &&
    a.currentHp === b.currentHp &&
    a.maxHp === b.maxHp &&
    a.hpPercent === b.hpPercent &&
    a.affinity === b.affinity &&
    a.status === b.status
  );
}

/**
 * Explicit field-by-field equality for BattleViewModels. Arrays are length-checked
 * first, then compared per-element. bigint battleId uses === directly — NEVER
 * JSON.stringify (bigint throws) or Number() (lossy above 2^53). Covers outcome,
 * turnNumber, both cards (all fields incl. status), skills, bench, baitOptions
 * (itemId + name + recruitBonus + count), canFlee/canSwap/canRecruit, and weather
 * (null-ness, label, turnsRemaining). Used by shouldSkipBattleRefresh.
 */
export function battleVMsEqual(a: BattleViewModel, b: BattleViewModel): boolean {
  if (a.battleId !== b.battleId) return false;
  if (a.turnNumber !== b.turnNumber) return false;
  if (a.outcome !== b.outcome) return false;
  if (a.canFlee !== b.canFlee) return false;
  if (a.canSwap !== b.canSwap) return false;
  if (a.canRecruit !== b.canRecruit) return false;

  if (!cardEqual(a.playerCard, b.playerCard)) return false;
  if (!cardEqual(a.opponentCard, b.opponentCard)) return false;

  // Skills: length-first, then per-element
  if (a.skills.length !== b.skills.length) return false;
  for (let i = 0; i < a.skills.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by a.skills.length (length-checked above)
    const sa = a.skills[i]!;
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by b.skills.length (length === a.skills.length)
    const sb = b.skills[i]!;
    if (
      sa.id !== sb.id ||
      sa.name !== sb.name ||
      sa.affinity !== sb.affinity ||
      sa.power !== sb.power ||
      sa.accuracy !== sb.accuracy
    ) {
      return false;
    }
  }

  // Bench: length-first, then per-element
  if (a.bench.length !== b.bench.length) return false;
  for (let i = 0; i < a.bench.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by a.bench.length (length-checked above)
    const ba = a.bench[i]!;
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by b.bench.length (length === a.bench.length)
    const bb = b.bench[i]!;
    if (
      ba.teamIndex !== bb.teamIndex ||
      ba.speciesName !== bb.speciesName ||
      ba.currentHp !== bb.currentHp ||
      ba.maxHp !== bb.maxHp
    ) {
      return false;
    }
  }

  // BaitOptions: length-first, then per-element (incl. count — intentional per plan)
  if (a.baitOptions.length !== b.baitOptions.length) return false;
  for (let i = 0; i < a.baitOptions.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by a.baitOptions.length (length-checked above)
    const boa = a.baitOptions[i]!;
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by b.baitOptions.length (length === a.baitOptions.length)
    const bob = b.baitOptions[i]!;
    if (
      boa.itemId !== bob.itemId ||
      boa.name !== bob.name ||
      boa.recruitBonus !== bob.recruitBonus ||
      boa.count !== bob.count
    ) {
      return false;
    }
  }

  // Weather: null-ness, then label + turnsRemaining
  const aw = a.weather;
  const bw = b.weather;
  if (aw === null && bw === null) return true;
  if (aw === null || bw === null) return false;
  if (aw.label !== bw.label || aw.turnsRemaining !== bw.turnsRemaining) return false;

  return true;
}

/**
 * Returns true ONLY when the view is visible AND both VMs are non-null AND equal.
 * All other combinations → false (never skip). The visible guard prevents skipping
 * while the view is hidden (stale-hidden trap — a skip-while-hidden would drop the
 * re-show render, including the Escape bare-hide path at main.ts:489 that bypasses
 * refreshBattle's hide branch). null on either side → never skip (after a hide-branch
 * reset of lastBattleVM, the same VM must re-render to become visible again).
 */
export function shouldSkipBattleRefresh(
  visible: boolean,
  lastVm: BattleViewModel | null,
  vm: BattleViewModel | null,
): boolean {
  return visible && vm !== null && lastVm !== null && battleVMsEqual(lastVm, vm);
}
