// ui/evolutionModel.ts — pure view-model for the evolution screen + the CLIENT PORT of
// game-core's evolution eligibility predicate (EG4-1, ADR-0174).
//
// No DOM, no SDK, no side effects. Takes store data, returns the view-model.
// The thin DOM shell (evolutionView.ts) renders these; the loop refreshes on batch.
//
// SSOT: `game-core/src/evolution/eligibility.rs`. The server owns the write path; this
// file is a READ-ONLY port of the same predicate so the requirements/progress panel and
// the reducer's reject message describe a gate identically. Semantics ported verbatim:
// five gates AND-combined, INCLUSIVE `>=` thresholds, a `null` history gate is PERMISSIVE
// (absent — NOT "requires the lowest tier"), an empty essence list imposes no
// requirement, essence is matched by AFFINITY and never by list position, and
// `eligibleEvolutionPaths` returns the FULL eligible set (never a first-match winner).
// Fusion is DELETED, not repurposed — as are `evolvesTo`, `canEvolve` and `bond`.
//
// TOTAL: never throws on empty/unknown/missing input — a throw here starves sibling
// store batch-listeners (store.ts one-way flow).
import type {
  AffinityName,
  StoreEvolutionPath,
  StoreMonsterPub,
  StoreSpeciesRow,
} from '../net/store';

/**
 * The five Trust tiers in ASCENDING order — mirrors `eligibility.rs`'s `ASCENDING`
 * array, which is the order `TrustTier`'s derived `Ord` ranks by.
 *
 * HARD-CODED on purpose (contract A7/A8): deriving it from `HANDLED_ENUM_VARIANTS`
 * would make the ordering-drift test self-referential — green under any Rust reorder,
 * which is the exact failure it exists to catch.
 */
export const TRUST_TIER_ORDER = ['Hostile', 'Wary', 'Neutral', 'Friendly', 'Devoted'] as const;

export type TrustTierName = (typeof TRUST_TIER_ORDER)[number];

/** Rank of a Trust tag: 0 = Hostile .. 4 = Devoted, `-1` for an unrecognized tag.
 *  Never throws — an unknown tag reaches this function whenever the server ships a new
 *  variant (rowConvert's `narrowTag` passes unknown tags through raw). */
export function trustTierRank(tag: string): number {
  return (TRUST_TIER_ORDER as readonly string[]).indexOf(tag);
}

/** The server's legal `Level` range (`server-module/src/marshal.rs` `Level::new`). An
 *  edge whose `min_level` falls outside it is SKIPPED by `check_and_evolve` and hard-
 *  errors in `evolve()` — so the client must never show it as reachable (contract A11). */
const MIN_PATH_LEVEL = 1;
const MAX_PATH_LEVEL = 100;

export type EvolutionGateKind = 'level' | 'essence' | 'trust' | 'qualityTime' | 'nutrition';

export interface EvolutionGateViewModel {
  readonly kind: EvolutionGateKind;
  /** 'Level' | '<Affinity> essence' | 'Trust' | 'Quality time' | 'Nutrition' */
  readonly label: string;
  readonly currentText: string;
  readonly requiredText: string;
  readonly met: boolean;
}

/** A gate row paired with the player-facing reason it would report when unmet. The
 *  reason strings mirror `eligibility.rs`'s `unmet_requirement` formats VERBATIM, so the
 *  panel and the server's reject message never disagree. */
interface GateEntry {
  readonly row: EvolutionGateViewModel;
  readonly reason: string;
}

/** How much of `affinity` this monster holds. Guarded read: a row that lost a column to
 *  schema drift reads 0 rather than `undefined` (which would poison every comparison). */
function essenceHeld(m: StoreMonsterPub, affinity: AffinityName): number {
  const pool: Partial<Record<string, number>> = m.essence;
  return pool[affinity] ?? 0;
}

/**
 * THE single gate walk (contract A5) — `pathRequirements`, `pathSatisfied` and
 * `unmetRequirement` all read this one function, so they cannot drift.
 *
 * Canonical order: level -> essence (LIST order) -> trust -> quality time -> nutrition.
 * Permissive gates emit NO row at all: a `null` threshold and an empty essence list are
 * ABSENT requirements, not satisfied ones.
 */
function walkGates(m: StoreMonsterPub, p: StoreEvolutionPath): readonly GateEntry[] {
  const entries: GateEntry[] = [];

  // --- level. The range check mirrors the server's skip (A11): an out-of-range
  // min_level is permanently unreachable, so the row reports met:false (D2) rather
  // than a green row on a path that can never apply.
  const levelInRange = p.minLevel >= MIN_PATH_LEVEL && p.minLevel <= MAX_PATH_LEVEL;
  entries.push({
    row: {
      kind: 'level',
      label: 'Level',
      currentText: `Lv ${m.level}`,
      requiredText: `Lv ${p.minLevel}`,
      met: levelInRange && m.level >= p.minLevel,
    },
    reason: `requires level ${p.minLevel}`,
  });

  // --- essence: EVERY entry of the ORDERED list, looked up by affinity. A duplicate
  // affinity is legal content and each occurrence gets its own row.
  for (const req of p.essence) {
    const held = essenceHeld(m, req.affinity);
    entries.push({
      row: {
        kind: 'essence',
        label: `${req.affinity} essence`,
        currentText: `${held}`,
        requiredText: `${req.amount}`,
        met: held >= req.amount,
      },
      reason: `requires ${req.amount} ${req.affinity} essence`,
    });
  }

  // --- trust: compared by RANK, never as a string (lexicographic order gets it
  // backwards in BOTH directions). Fails CLOSED when EITHER tag is unrecognized
  // (contract A2): an unknown threshold is unsatisfiable, an unknown monster tier is
  // below every threshold. Deliberately NOT `heldRank >= needRank` alone — that
  // comparison fails OPEN on the threshold side, since rank(unknown) is -1.
  const minTrustTier = p.minTrustTier;
  if (minTrustTier != null) {
    const needRank = trustTierRank(minTrustTier);
    const heldRank = trustTierRank(m.trustTier);
    entries.push({
      row: {
        kind: 'trust',
        label: 'Trust',
        currentText: m.trustTier,
        requiredText: minTrustTier,
        met: needRank >= 0 && heldRank >= 0 && heldRank >= needRank,
      },
      reason: `requires trust tier ${minTrustTier}`,
    });
  }

  // --- quality time
  const minQualityTimeTier = p.minQualityTimeTier;
  if (minQualityTimeTier != null) {
    entries.push({
      row: {
        kind: 'qualityTime',
        label: 'Quality time',
        currentText: `Tier ${m.qualityTimeTier}`,
        requiredText: `Tier ${minQualityTimeTier}`,
        met: m.qualityTimeTier >= minQualityTimeTier,
      },
      reason: `requires quality time tier ${minQualityTimeTier}`,
    });
  }

  // --- nutrition
  const minNutritionPct = p.minNutritionPct;
  if (minNutritionPct != null) {
    entries.push({
      row: {
        kind: 'nutrition',
        label: 'Nutrition',
        currentText: `${m.nutritionPct}%`,
        requiredText: `${minNutritionPct}%`,
        met: m.nutritionPct >= minNutritionPct,
      },
      reason: `requires nutrition ${minNutritionPct}%`,
    });
  }

  return entries;
}

/** Every gate this path imposes, with the monster's current value beside each
 *  requirement — the requirements/PROGRESS panel's data (EG4-1). */
export function pathRequirements(
  m: StoreMonsterPub,
  p: StoreEvolutionPath,
): readonly EvolutionGateViewModel[] {
  return walkGates(m, p).map((entry) => entry.row);
}

/** Does `m` satisfy EVERY gate on `p`? Does NOT check `fromSpecies` — that is
 *  `eligibleEvolutionPaths`' filter (mirrors `path_satisfied`). */
export function pathSatisfied(m: StoreMonsterPub, p: StoreEvolutionPath): boolean {
  return walkGates(m, p).every((entry) => entry.row.met);
}

/** Why `m` does NOT satisfy `p` — the FIRST unmet gate in canonical order, in the same
 *  words the server's reject message uses. `null` exactly when `pathSatisfied` is true. */
export function unmetRequirement(m: StoreMonsterPub, p: StoreEvolutionPath): string | null {
  return walkGates(m, p).find((entry) => !entry.row.met)?.reason ?? null;
}

/** Every edge out of `m`'s current species whose gates are ALL satisfied, ascending by
 *  `edgeId` (contract A9: Map-iteration order is subscription-arrival order and is
 *  re-shuffled on every content republish). The FULL set — never a first-match winner:
 *  a monster eligible for two paths yields both, which is what the choice UX is built on. */
export function eligibleEvolutionPaths(
  m: StoreMonsterPub,
  paths: readonly StoreEvolutionPath[],
): readonly StoreEvolutionPath[] {
  return paths
    .filter((p) => p.fromSpecies === m.speciesId && pathSatisfied(m, p))
    .sort((a, b) => a.edgeId - b.edgeId);
}

export interface EvolutionPathViewModel {
  readonly edgeId: number;
  readonly toSpecies: number;
  readonly toSpeciesName: string;
  readonly met: boolean;
  readonly unmetReason: string | null;
  readonly gates: readonly EvolutionGateViewModel[];
}

export interface EvolutionMonsterViewModel {
  readonly monsterId: bigint;
  readonly speciesName: string;
  readonly nickname: string;
  readonly level: number;
  readonly tier: number;
  readonly trustTier: TrustTierName;
  readonly qualityTimeTier: number;
  readonly nutritionPct: number;
  /** ALL outgoing edges of this monster's species, ascending by edgeId (A9/D1) — the
   *  progress panel, which the 0-eligible monster needs most. */
  readonly paths: readonly EvolutionPathViewModel[];
  readonly eligibleCount: number;
  /** Non-empty IFF `eligibleCount >= 2` (EG4-2). ALWAYS empty at 0 or 1: at exactly one
   *  eligible path the server auto-applies the evolution, so offering an action there
   *  offers the player something that does not exist. */
  readonly choices: readonly EvolutionPathViewModel[];
  /** Non-null IFF `eligibleCount === 1` (contract A3). INFORMATIONAL copy only — never
   *  an action, never a callback. */
  readonly readyPathName: string | null;
}

export interface EvolutionViewModel {
  readonly monsters: readonly EvolutionMonsterViewModel[];
}

function speciesName(speciesMap: ReadonlyMap<number, StoreSpeciesRow>, id: number): string {
  return speciesMap.get(id)?.name ?? `Unknown (#${id})`;
}

function toPath(
  m: StoreMonsterPub,
  p: StoreEvolutionPath,
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
): EvolutionPathViewModel {
  const entries = walkGates(m, p);
  // Explicit field mapping, NEVER `{ ...p }`: `pathId` is a DB-internal store key that
  // sync_content re-mints on every republish, so it must not become reachable from a
  // view or a callback (contract A1 / EG1-12).
  return {
    edgeId: p.edgeId,
    toSpecies: p.toSpecies,
    toSpeciesName: speciesName(speciesMap, p.toSpecies),
    met: entries.every((entry) => entry.row.met),
    unmetReason: entries.find((entry) => !entry.row.met)?.reason ?? null,
    gates: entries.map((entry) => entry.row),
  };
}

function toMonster(
  m: StoreMonsterPub,
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
  paths: readonly StoreEvolutionPath[],
): EvolutionMonsterViewModel {
  const outgoing = paths
    .filter((p) => p.fromSpecies === m.speciesId)
    .sort((a, b) => a.edgeId - b.edgeId)
    .map((p) => toPath(m, p, speciesMap));
  const eligible = outgoing.filter((p) => p.met);
  return {
    monsterId: m.monsterId,
    speciesName: speciesName(speciesMap, m.speciesId),
    nickname: m.nickname,
    level: m.level,
    tier: m.tier,
    // The three derived tiers are copied VERBATIM from the server-computed row — never
    // re-derived here, which would be a second source of truth.
    trustTier: m.trustTier,
    qualityTimeTier: m.qualityTimeTier,
    nutritionPct: m.nutritionPct,
    paths: outgoing,
    eligibleCount: eligible.length,
    choices: eligible.length >= 2 ? eligible : [],
    readyPathName: eligible.length === 1 ? eligible[0].toSpeciesName : null,
  };
}

export function buildEvolutionViewModel(
  monsters: readonly StoreMonsterPub[],
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
  paths: readonly StoreEvolutionPath[] = [],
): EvolutionViewModel {
  return {
    monsters: monsters.map((m) => toMonster(m, speciesMap, paths)),
  };
}
