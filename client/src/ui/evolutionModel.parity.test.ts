// ui/evolutionModel.parity.test.ts — EXECUTABLE parity between the client's TS port of the
// evolution eligibility predicate (evolutionModel.ts) and game-core's real predicate
// (game-core/src/evolution/eligibility.rs), called through the client-wasm export
// `evolution_eligibility`.
//
// The port is kept by ruling (BUG-client-evolution-eligibility-ts-port): rules live once in
// game-core, so the TS copy is only acceptable while this suite proves it agrees with the
// original on generated input. For each case the wasm side receives the RAW monster fields
// (level, essence, trust event counts, quality-time ticks, EVs) and returns game-core's
// answers plus the three tiers the server stamps onto MonsterPub (trust_tier_of,
// quality_time_tier_of, nutrition_pct_of — marshal.rs). The TS side receives the
// StoreMonsterPub the client would really hold (tiers copied verbatim, never re-derived).
// Compared per path: pathSatisfied, unmetRequirement (exact player-facing string), the
// eligible edge set, and the rendered buildEvolutionViewModel met/unmetReason/eligibleCount.
//
// Domain: every value game-core can represent. An out-of-range minLevel (0 or > 100) is NOT
// representable there (`Level` rejects it at deserialize), so it is pinned separately below.
//
// All fast-check properties use the block-body arrow rule (project standard).

import * as fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadWasmPkg } from '../../test-util/wasmPkg';
import type { AffinityName } from '../net/rowConvert';
import type { StoreEvolutionPath, StoreMonsterPub } from '../net/store';
import {
  buildEvolutionViewModel,
  eligibleEvolutionPaths,
  pathSatisfied,
  TRUST_TIER_ORDER,
  type TrustTierName,
  unmetRequirement,
} from './evolutionModel';

/** `Affinity::index()` order — the layout of `MonsterInstance.essence` (Fire..Dark). */
const AFFINITIES = [
  'Fire',
  'Water',
  'Plant',
  'Electric',
  'Earth',
  'Wind',
  'Light',
  'Dark',
] as const satisfies readonly AffinityName[];

const U32_MAX = 0xffff_ffff;

// --- the wire shapes of the wasm export (snake_case serde DTOs) ---------------------------
interface WasmMonster {
  species_id: number;
  level: number;
  essence: number[];
  trust_favorable_count: number;
  trust_unfavorable_count: number;
  quality_time_ticks_total: number;
  evs: number[];
}
interface WasmPath {
  edge_id: number;
  from_species: number;
  to_species: number;
  min_level: number;
  essence: { affinity: AffinityName; amount: number }[];
  min_trust_tier: TrustTierName | null;
  min_quality_time_tier: number | null;
  min_nutrition_pct: number | null;
}
interface WasmReport {
  trust_tier: TrustTierName;
  quality_time_tier: number;
  nutrition_pct: number;
  satisfied: boolean[];
  unmet: (string | null)[];
  eligible_edge_ids: number[];
}

let evolutionEligibility: (m: WasmMonster, p: WasmPath[]) => WasmReport;

beforeAll(async () => {
  const pkg = await loadWasmPkg();
  const fn = pkg.evolution_eligibility;
  if (typeof fn !== 'function') {
    throw new Error(
      'client-wasm exports no evolution_eligibility() — the pkg is stale, run `just wasm`',
    );
  }
  evolutionEligibility = fn as typeof evolutionEligibility;
});

// --- the client-side view of the same case -------------------------------------------------
function toStoreMonster(m: WasmMonster, r: WasmReport): StoreMonsterPub {
  return {
    monsterId: 1n,
    ownerIdentity: '',
    speciesId: m.species_id,
    nickname: '',
    level: m.level,
    xp: 0,
    currentHp: 0,
    statHp: 0,
    statAttack: 0,
    statDefense: 0,
    statSpeed: 0,
    statSpAttack: 0,
    statSpDefense: 0,
    partySlot: 0,
    tier: 0,
    essence: Object.fromEntries(AFFINITIES.map((a, i) => [a, m.essence[i]])) as Record<
      AffinityName,
      number
    >,
    // Server-derived tiers, copied VERBATIM from game-core's answer (as marshal.rs does).
    trustTier: r.trust_tier,
    qualityTimeTier: r.quality_time_tier,
    nutritionPct: r.nutrition_pct,
  };
}

function toStorePath(p: WasmPath, i: number): StoreEvolutionPath {
  return {
    pathId: BigInt(i),
    edgeId: p.edge_id,
    fromSpecies: p.from_species,
    toSpecies: p.to_species,
    minLevel: p.min_level,
    essence: p.essence.map((e) => ({ affinity: e.affinity, amount: e.amount })),
    minTrustTier: p.min_trust_tier,
    minQualityTimeTier: p.min_quality_time_tier,
    minNutritionPct: p.min_nutrition_pct,
  };
}

// --- arbitraries over the real type ranges ------------------------------------------------
/** A u32 amount: mostly small (so thresholds collide with holdings), sometimes anywhere,
 *  sometimes exactly an extreme. */
const u32Arb = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 0, max: 40 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: U32_MAX }) },
  { weight: 1, arbitrary: fc.constantFrom(0, U32_MAX) },
);
/** Trust event counts: small values sweep all five tiers; huge ones exercise the u64 widening. */
const countArb = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 0, max: 60 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: U32_MAX }) },
  { weight: 1, arbitrary: fc.constantFrom(0, U32_MAX) },
);
/** Quality-time ticks: dense around the tier bands [10, 50, 150, 400], plus the full range. */
const ticksArb = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 0, max: 450 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: U32_MAX }) },
);
/** Six EVs, each <= 252, total <= 510 (EVs::new's caps), built without filtering: each stat
 *  takes min(drawn, remaining budget), so an over-budget draw lands EXACTLY on 510. */
const evsArb = fc
  .oneof(
    fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 6, maxLength: 6 }),
    fc.array(fc.integer({ min: 0, max: 252 }), { minLength: 6, maxLength: 6 }),
  )
  .map((vals) => {
    let budget = 510;
    return vals.map((v) => {
      const x = Math.min(v, budget);
      budget -= x;
      return x;
    });
  });

const SPECIES = { min: 1, max: 3 }; // a small id space so from_species matches often

const monsterArb: fc.Arbitrary<WasmMonster> = fc.record({
  species_id: fc.integer(SPECIES),
  level: fc.integer({ min: 1, max: 100 }),
  essence: fc.array(u32Arb, { minLength: 8, maxLength: 8 }),
  trust_favorable_count: countArb,
  trust_unfavorable_count: countArb,
  quality_time_ticks_total: ticksArb,
  evs: evsArb,
});

const pathBodyArb = fc.record({
  from_species: fc.integer(SPECIES),
  to_species: fc.integer({ min: 1, max: 50 }),
  min_level: fc.integer({ min: 1, max: 100 }),
  // <= 3 entries (R7); duplicate affinities are legal content and each is its own gate.
  essence: fc.array(fc.record({ affinity: fc.constantFrom(...AFFINITIES), amount: u32Arb }), {
    maxLength: 3,
  }),
  min_trust_tier: fc.option(fc.constantFrom(...TRUST_TIER_ORDER), { nil: null }),
  // u8 columns: include thresholds above the reachable maxima (tier 4, 100%).
  min_quality_time_tier: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }),
  min_nutrition_pct: fc.option(
    fc.oneof(fc.integer({ min: 0, max: 105 }), fc.integer({ min: 0, max: 255 })),
    { nil: null },
  ),
});

/** 0..6 paths with DISTINCT edge ids (R12), in arbitrary list order. */
const pathsArb: fc.Arbitrary<WasmPath[]> = fc
  .tuple(
    fc.array(pathBodyArb, { maxLength: 6 }),
    fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { minLength: 6, maxLength: 6 }),
  )
  .map(([bodies, ids]) => bodies.map((b, i) => ({ edge_id: ids[i], ...b })));

// --- pinned boundary examples (always run, before the random cases) ------------------------
function mon(over: Partial<WasmMonster> = {}): WasmMonster {
  return {
    species_id: 1,
    level: 20,
    essence: [10, 0, 0, 0, 0, 0, 0, 0],
    trust_favorable_count: 0,
    trust_unfavorable_count: 0,
    quality_time_ticks_total: 10,
    evs: [51, 0, 0, 0, 0, 0], // 51 * 100 / 510 = 10%
    ...over,
  };
}
function path(over: Partial<WasmPath> = {}): WasmPath {
  return {
    edge_id: 1,
    from_species: 1,
    to_species: 2,
    min_level: 20,
    essence: [{ affinity: 'Fire', amount: 10 }],
    min_trust_tier: 'Neutral', // zero history is exactly 50% -> Neutral
    min_quality_time_tier: 1, // 10 ticks is the tier-1 floor
    min_nutrition_pct: 10,
    ...over,
  };
}
const EXAMPLES: [WasmMonster, WasmPath[]][] = [
  // Every gate an EXACT tie (inclusive >=) -> satisfied.
  [mon(), [path()]],
  // One below each gate, one path per gate, so each unmet reason is exercised.
  [
    mon(),
    [
      path({ edge_id: 5, min_level: 21 }),
      path({ edge_id: 4, essence: [{ affinity: 'Fire', amount: 11 }] }),
      path({ edge_id: 3, min_trust_tier: 'Friendly' }),
      path({ edge_id: 2, min_quality_time_tier: 2 }),
      path({ edge_id: 1, min_nutrition_pct: 11 }),
    ],
  ],
  // u32::MAX trust counts on both sides (the u64 widening) against every threshold.
  [
    mon({ trust_favorable_count: U32_MAX, trust_unfavorable_count: U32_MAX }),
    TRUST_TIER_ORDER.map((t, i) => path({ edge_id: i, min_trust_tier: t })),
  ],
  [
    mon({ trust_favorable_count: U32_MAX, trust_unfavorable_count: 0 }),
    [path({ min_trust_tier: 'Devoted' })],
  ],
  // Duplicate affinity + a u32::MAX requirement + an order-sensitive first-unmet essence.
  [
    mon({ essence: [U32_MAX, 5, 0, 0, 0, 0, 0, 0] }),
    [
      path({
        essence: [
          { affinity: 'Fire', amount: U32_MAX },
          { affinity: 'Water', amount: 6 },
          { affinity: 'Fire', amount: 1 },
        ],
      }),
    ],
  ],
  // Unreachable thresholds (tier 5 > max 4; 101% / 255% > 100%), full EV budget, max ticks.
  [
    mon({ evs: [252, 252, 6, 0, 0, 0], quality_time_ticks_total: U32_MAX }),
    [
      path({ edge_id: 7, min_quality_time_tier: 5 }),
      path({ edge_id: 8, min_nutrition_pct: 101 }),
      path({ edge_id: 9, min_nutrition_pct: 255 }),
      path({ edge_id: 10, min_nutrition_pct: 100, min_quality_time_tier: 4 }),
    ],
  ],
  // Level extremes; a path out of a different species; no paths at all.
  [mon({ level: 100 }), [path({ min_level: 100 }), path({ edge_id: 2, from_species: 2 })]],
  [mon({ level: 1 }), [path({ min_level: 1, essence: [] })]],
  [mon(), []],
];

// --- the comparison ---------------------------------------------------------------------
interface Coverage {
  satisfied: number;
  unsatisfied: number;
  firstUnmet: Set<string>;
  eligibleSets: number;
}

/** Which gate a game-core unmet reason names (the reason formats are the parity subject). */
function gateOf(reason: string | null): string {
  if (reason === null) return 'none';
  if (reason.startsWith('requires level ')) return 'level';
  if (reason.endsWith(' essence')) return 'essence';
  if (reason.startsWith('requires trust tier ')) return 'trust';
  if (reason.startsWith('requires quality time tier ')) return 'qualityTime';
  if (reason.startsWith('requires nutrition ')) return 'nutrition';
  return `unknown: ${reason}`;
}

function assertParity(m: WasmMonster, paths: WasmPath[], cov: Coverage): void {
  const r = evolutionEligibility(m, paths);
  const pub = toStoreMonster(m, r);
  const storePaths = paths.map(toStorePath);
  const ctx = `monster=${JSON.stringify(m)} paths=${JSON.stringify(paths)}`;

  expect(r.satisfied, ctx).toHaveLength(paths.length);
  storePaths.forEach((p, i) => {
    expect(pathSatisfied(pub, p), `pathSatisfied[${i}] ${ctx}`).toBe(r.satisfied[i]);
    expect(unmetRequirement(pub, p), `unmetRequirement[${i}] ${ctx}`).toBe(r.unmet[i]);
    if (r.satisfied[i]) cov.satisfied++;
    else {
      cov.unsatisfied++;
      cov.firstUnmet.add(gateOf(r.unmet[i]));
    }
  });

  const eligibleTs = eligibleEvolutionPaths(pub, storePaths).map((p) => p.edgeId);
  const eligibleRs = [...r.eligible_edge_ids].sort((a, b) => a - b);
  expect(eligibleTs, `eligible edge set ${ctx}`).toEqual(eligibleRs);
  if (eligibleRs.length > 0) cov.eligibleSets++;

  // The rendered surface: per-edge met/unmetReason and the eligible count.
  const vm = buildEvolutionViewModel([pub], new Map(), storePaths).monsters[0];
  expect(vm.eligibleCount, `eligibleCount ${ctx}`).toBe(eligibleRs.length);
  for (const row of vm.paths) {
    const i = paths.findIndex((p) => p.edge_id === row.edgeId);
    expect(row.met, `vm met edge ${row.edgeId} ${ctx}`).toBe(r.satisfied[i]);
    expect(row.unmetReason, `vm unmetReason edge ${row.edgeId} ${ctx}`).toBe(r.unmet[i]);
  }
}

describe('evolution eligibility: TS port == game-core (via client-wasm), executable parity', () => {
  it('★ BITES: 1000 generated monsters x path sets agree on satisfied / unmet reason / eligible set / view model', () => {
    // WRONG IMPL KILLED (any of these in evolutionModel.ts fails a case): a strict `>`
    // threshold, essence matched by list position, an essence first-unmet other than list
    // order, a string (lexicographic) trust compare, a null history gate treated as
    // "requires the lowest tier", a first-match eligible set, a reason-string format drift.
    const cov: Coverage = { satisfied: 0, unsatisfied: 0, firstUnmet: new Set(), eligibleSets: 0 };
    fc.assert(
      fc.property(monsterArb, pathsArb, (m, paths) => {
        assertParity(m, paths, cov);
      }),
      { numRuns: 1000, examples: EXAMPLES },
    );
    // Non-vacuity: the run must have produced both verdicts, non-empty eligible sets, and
    // every gate as a first-unmet reason at least once.
    expect(cov.satisfied, 'no generated path was ever satisfied').toBeGreaterThan(0);
    expect(cov.unsatisfied, 'no generated path was ever unsatisfied').toBeGreaterThan(0);
    expect(cov.eligibleSets, 'no generated case had an eligible path').toBeGreaterThan(0);
    expect(
      [...cov.firstUnmet].sort(),
      'every gate must be a first-unmet reason at least once',
    ).toEqual(['essence', 'level', 'nutrition', 'qualityTime', 'trust']);
  });
});

describe('evolution eligibility: out-of-range minLevel is unrepresentable in game-core', () => {
  it('BITES: game-core rejects min_level 0 / 101 at the boundary while the TS port reports the edge unmet', () => {
    // game-core's `Level` rejects 0 and > 100 at deserialize (RON content never carries
    // such an edge; the server skips it). The TS port shows such an edge as met:false.
    // Both sides therefore refuse it — pinned so neither side silently starts accepting.
    for (const minLevel of [0, 101]) {
      const p = path({ min_level: minLevel });
      expect(() => evolutionEligibility(mon(), [p]), `min_level ${minLevel}`).toThrow();
      const report = evolutionEligibility(mon(), []);
      const pub = toStoreMonster(mon(), report);
      expect(pathSatisfied(pub, toStorePath(p, 0)), `TS minLevel ${minLevel}`).toBe(false);
    }
    // And a monster level outside 1..=100 is likewise rejected by the export.
    expect(() => evolutionEligibility(mon({ level: 0 }), [])).toThrow();
    expect(() => evolutionEligibility(mon({ level: 101 }), [])).toThrow();
  });
});
