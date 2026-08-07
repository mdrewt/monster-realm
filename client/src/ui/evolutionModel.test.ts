// ui/evolutionModel.test.ts — EG4 gating tests for the essence-graph evolution
// requirements/progress panel + the client-side eligibility port.
//
// SOURCE OF TRUTH (in this precedence order):
//   1. memory/projects/monster-realm-EG4-contract.md  §B (store types), §C (the frozen
//      evolutionModel API), §G (the EARS -> teeth table). THIS is what the implementer
//      implements and what these tests are written against.
//   2. specs/monster-realm-v2/M-evolution-essence-graph.spec.md  §2 EG4-1/2/5/6.
//   3. game-core/src/evolution/eligibility.rs — the Rust SSOT this file PORTS. Gate
//      semantics (inclusive `>=`, affinity-keyed essence lookup, `None` = permissive,
//      the canonical gate order, the ASCENDING TrustTier order) and the
//      `unmet_requirement` message formats are pinned against it VERBATIM.
//
// These tests are INTENTIONALLY RED until evolutionModel.ts is rewritten. Do NOT edit
// them to match a buggy implementation — correct them FROM THE CONTRACT only, and log a
// rationale when doing so.
//
// The previous fusion/bond/evolvesTo suite is deleted outright, not migrated: `bond`,
// `evolvesTo`, `canEvolve`, `evolvesToSpeciesName` and `fusionRecipes` are all retired
// by EG4-5 / contract §C ("Never reintroduced").
//
// Pure functions, no DOM, no SDK, no wall clock. All inputs are plain literals;
// deterministic; node-only. The ONE filesystem read (A8's binding-order parse) uses
// String.indexOf/slice plus a LITERAL regex — `new RegExp(...)` is banned in this repo
// (Semgrep `detect-non-literal-regexp` runs with `--config auto --error`).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HANDLED_ENUM_VARIANTS } from '../net/rowConvert';
import type {
  AffinityName,
  EssenceByAffinity,
  StoreEvolutionPath,
  StoreMonsterPub,
  StoreSpeciesRow,
} from '../net/store';
import {
  buildEvolutionViewModel,
  type EvolutionGateViewModel,
  type EvolutionMonsterViewModel,
  type EvolutionPathViewModel,
  type EvolutionViewModel,
  eligibleEvolutionPaths,
  pathRequirements,
  pathSatisfied,
  TRUST_TIER_ORDER,
  type TrustTierName,
  trustTierRank,
  unmetRequirement,
} from './evolutionModel';

// ---------------------------------------------------------------------------
// Factories — explicit, typed, no `as any`.
// ---------------------------------------------------------------------------

/** All-zero essence with named overrides. Every one of the 8 AffinityName keys is
 *  supplied explicitly so a missing column is a compile error, not a silent 0. */
function essence(overrides: Partial<Record<AffinityName, number>> = {}): EssenceByAffinity {
  return {
    Fire: 0,
    Water: 0,
    Plant: 0,
    Electric: 0,
    Earth: 0,
    Wind: 0,
    Light: 0,
    Dark: 0,
    ...overrides,
  };
}

function monster(overrides: Partial<StoreMonsterPub> = {}): StoreMonsterPub {
  return {
    monsterId: 1n,
    ownerIdentity: 'player',
    speciesId: 1,
    nickname: 'Blaze',
    level: 50,
    xp: 0,
    currentHp: 30,
    statHp: 40,
    statAttack: 10,
    statDefense: 10,
    statSpeed: 10,
    statSpAttack: 10,
    statSpDefense: 10,
    partySlot: 0,
    tier: 0,
    essence: essence(),
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
    ...overrides,
  };
}

/** A fully PERMISSIVE edge (`minLevel: 1`, empty essence list, all three history
 *  gates absent) — every override below therefore isolates exactly one gate. */
function evoPath(overrides: Partial<StoreEvolutionPath> = {}): StoreEvolutionPath {
  return {
    pathId: 1n,
    edgeId: 1,
    fromSpecies: 1,
    toSpecies: 2,
    minLevel: 1,
    essence: [],
    minTrustTier: null,
    minQualityTimeTier: null,
    minNutritionPct: null,
    ...overrides,
  };
}

function speciesRow(id: number, name: string): StoreSpeciesRow {
  return {
    id,
    name,
    baseHp: 45,
    baseAttack: 49,
    baseDefense: 49,
    baseSpeed: 45,
    baseSpAttack: 65,
    baseSpDefense: 65,
    affinity: 'Fire',
    learnableSkillIds: [],
  };
}

const SPECIES_MAP: ReadonlyMap<number, StoreSpeciesRow> = new Map([
  [1, speciesRow(1, 'Flameling')],
  [2, speciesRow(2, 'Pyrodrake')],
  [3, speciesRow(3, 'Cindermaw')],
  [4, speciesRow(4, 'Emberwing')],
  [9, speciesRow(9, 'Foreignling')],
]);

/**
 * An SDK enum tag that is NOT in TRUST_TIER_ORDER — i.e. a future server-side
 * variant. This value genuinely reaches the store field at runtime despite the
 * static union: `narrowTag` (rowConvert, ADR-0127) logs an unknown tag and passes
 * it through RAW rather than throwing. The single documented cast below is what
 * lets a test express that runtime reality; it is not an `as any` escape hatch.
 */
const UNKNOWN_TRUST_TAG_RAW: string = 'Ascendant';
const UNKNOWN_TRUST_TAG = UNKNOWN_TRUST_TAG_RAW as TrustTierName;

// ---------------------------------------------------------------------------
// A gate matrix used by several groups: every one of the five gates PRESENT and
// met EXACTLY at its threshold (so this fixture doubles as the inclusive-`>=`
// equality case for all five at once).
// ---------------------------------------------------------------------------

const FULL_PATH: StoreEvolutionPath = evoPath({
  edgeId: 42,
  fromSpecies: 1,
  toSpecies: 2,
  minLevel: 20,
  essence: [{ affinity: 'Fire', amount: 120 }],
  minTrustTier: 'Friendly',
  minQualityTimeTier: 3,
  minNutritionPct: 60,
});

const FULL_MONSTER: StoreMonsterPub = monster({
  speciesId: 1,
  level: 20,
  essence: essence({ Fire: 120 }),
  trustTier: 'Friendly',
  qualityTimeTier: 3,
  nutritionPct: 60,
});

// ===========================================================================
// EG4-1 · INCLUSIVE `>=` BOUNDARY — one fixture per gate
// eligibility.rs:49-81 — every gate is `>=`, never `>`.
// ===========================================================================

describe('EG4-1 pathSatisfied: every gate threshold is INCLUSIVE (>=)', () => {
  it('BITES: level === minLevel satisfies; minLevel-1 does not', () => {
    // Kills: `>` instead of `>=` on the level gate (eligibility.rs:50
    // `instance.level >= path.min_level`). An off-by-one here makes every
    // authored edge fire one level late, forever, and silently.
    const p = evoPath({ minLevel: 20 });
    expect(pathSatisfied(monster({ level: 20 }), p)).toBe(true);
    expect(pathSatisfied(monster({ level: 19 }), p)).toBe(false);
    expect(pathSatisfied(monster({ level: 21 }), p)).toBe(true);
  });

  it('BITES: essence amount === required satisfies; required-1 does not', () => {
    // Kills: `>` on the essence gate (eligibility.rs:58 `>= req.amount`).
    const p = evoPath({ essence: [{ affinity: 'Fire', amount: 120 }] });
    expect(pathSatisfied(monster({ essence: essence({ Fire: 120 }) }), p)).toBe(true);
    expect(pathSatisfied(monster({ essence: essence({ Fire: 119 }) }), p)).toBe(false);
    expect(pathSatisfied(monster({ essence: essence({ Fire: 121 }) }), p)).toBe(true);
  });

  it('BITES: trustTier === minTrustTier satisfies; the tier one below does not', () => {
    // Kills: `>` on the trust gate (eligibility.rs:67 `>= tier`). EG3-3/EG3-4 author
    // `min_trust_tier: Some(Friendly)` — an exclusive compare would require Devoted.
    const p = evoPath({ minTrustTier: 'Friendly' });
    expect(pathSatisfied(monster({ trustTier: 'Friendly' }), p)).toBe(true);
    expect(pathSatisfied(monster({ trustTier: 'Neutral' }), p)).toBe(false);
    expect(pathSatisfied(monster({ trustTier: 'Devoted' }), p)).toBe(true);
  });

  it('BITES: qualityTimeTier === minQualityTimeTier satisfies; one below does not', () => {
    // Kills: `>` on the quality-time gate (eligibility.rs:74).
    const p = evoPath({ minQualityTimeTier: 3 });
    expect(pathSatisfied(monster({ qualityTimeTier: 3 }), p)).toBe(true);
    expect(pathSatisfied(monster({ qualityTimeTier: 2 }), p)).toBe(false);
    expect(pathSatisfied(monster({ qualityTimeTier: 4 }), p)).toBe(true);
  });

  it('BITES: nutritionPct === minNutritionPct satisfies; one below does not', () => {
    // Kills: `>` on the nutrition gate (eligibility.rs:80).
    const p = evoPath({ minNutritionPct: 60 });
    expect(pathSatisfied(monster({ nutritionPct: 60 }), p)).toBe(true);
    expect(pathSatisfied(monster({ nutritionPct: 59 }), p)).toBe(false);
    expect(pathSatisfied(monster({ nutritionPct: 61 }), p)).toBe(true);
  });
});

// ===========================================================================
// EG4-1 · ESSENCE IS KEYED BY AFFINITY, NOT BY POSITION OR BY A SWAPPED COLUMN
// ===========================================================================

/** Eight DISTINCT values — one per affinity. Distinctness is the whole point:
 *  under any column swap (e.g. Wind<->Light in the rowConvert map) at least one
 *  of the sixteen assertions below flips. */
const DISTINCT_ESSENCE: readonly (readonly [AffinityName, number])[] = [
  ['Fire', 11],
  ['Water', 22],
  ['Plant', 33],
  ['Electric', 44],
  ['Earth', 55],
  ['Wind', 66],
  ['Light', 77],
  ['Dark', 88],
];

describe('EG4-1 essence gate: every AffinityName reads its OWN column', () => {
  it('BITES: 8 distinct essence values — each affinity requirement reads exactly its own column', () => {
    // Kills: a Wind/Light (or any other) column swap in the converter/lookup map, and
    // any lookup that reads a fixed column. With 8 distinct values, a swap makes the
    // exact-amount path fail and/or the amount+1 path wrongly succeed.
    const m = monster({
      essence: essence({
        Fire: 11,
        Water: 22,
        Plant: 33,
        Electric: 44,
        Earth: 55,
        Wind: 66,
        Light: 77,
        Dark: 88,
      }),
    });
    for (const [affinity, amount] of DISTINCT_ESSENCE) {
      expect(
        pathSatisfied(m, evoPath({ essence: [{ affinity, amount }] })),
        `${affinity} at exactly ${amount} must satisfy a ${affinity}:${amount} requirement`,
      ).toBe(true);
      expect(
        pathSatisfied(m, evoPath({ essence: [{ affinity, amount: amount + 1 }] })),
        `${affinity} at ${amount} must NOT satisfy a ${affinity}:${amount + 1} requirement`,
      ).toBe(false);
    }
  });

  it('BITES: the 8 affinity names match the SDK-boundary registry exactly', () => {
    // Kills: AffinityName drifting from HANDLED_ENUM_VARIANTS.Affinity (contract A7 —
    // AffinityName is DERIVED from the registry, never hand-duplicated). A hand-typed
    // union that loses a variant makes the essence Record silently partial.
    const names = DISTINCT_ESSENCE.map(([affinity]) => affinity);
    expect([...names].sort()).toEqual([...HANDLED_ENUM_VARIANTS.Affinity].sort());
  });

  it('BITES: a {Water:10} requirement is matched by affinity, not by list position', () => {
    // Kills: an implementation that indexes the monster's essence by the requirement's
    // POSITION in the list (or by the first non-zero column). {Fire:999, Water:0} has
    // plenty of essence — just not the RIGHT essence.
    const p = evoPath({ essence: [{ affinity: 'Water', amount: 10 }] });
    expect(pathSatisfied(monster({ essence: essence({ Fire: 999, Water: 0 }) }), p)).toBe(false);
    expect(pathSatisfied(monster({ essence: essence({ Fire: 0, Water: 10 }) }), p)).toBe(true);
  });

  it('BITES: essence: [] imposes NO requirement and emits NO gate row', () => {
    // Kills: `.every` -> `.some` on the essence list (eligibility.rs:56-58 uses
    // `.all()`, which is vacuously TRUE on an empty list; `.any()` is vacuously FALSE
    // and would make EG3-4/EG3-7's essence-free edges permanently unreachable).
    const p = evoPath({ essence: [] });
    expect(pathSatisfied(monster({ essence: essence() }), p)).toBe(true);
    expect(pathRequirements(monster(), p).some((g) => g.kind === 'essence')).toBe(false);
  });

  it('BITES: two essence entries — BOTH must be met (AND, not OR)', () => {
    // Kills: `.every` -> `.some` in its non-vacuous direction. One-of-two met must FAIL.
    const p = evoPath({
      essence: [
        { affinity: 'Fire', amount: 100 },
        { affinity: 'Water', amount: 100 },
      ],
    });
    expect(pathSatisfied(monster({ essence: essence({ Fire: 100, Water: 100 }) }), p)).toBe(true);
    expect(pathSatisfied(monster({ essence: essence({ Fire: 100, Water: 99 }) }), p)).toBe(false);
    expect(pathSatisfied(monster({ essence: essence({ Fire: 99, Water: 100 }) }), p)).toBe(false);
  });

  it('BITES (A10): duplicate-affinity requirements are ALL checked — no record collapse', () => {
    // Kills: porting the ORDERED requirement list into a Record keyed by affinity
    // (last-wins). Rust iterates the LIST with `.all()` (eligibility.rs:56-58), so
    // [(Fire,900),(Fire,150)] needs 900. A collapsed Record keeps only (Fire,150) and
    // would call a Fire=200 monster ELIGIBLE — an over-count that silently evolves a
    // monster 750 essence early.
    const p = evoPath({
      essence: [
        { affinity: 'Fire', amount: 900 },
        { affinity: 'Fire', amount: 150 },
      ],
    });
    expect(pathSatisfied(monster({ essence: essence({ Fire: 200 }) }), p)).toBe(false);
    expect(pathSatisfied(monster({ essence: essence({ Fire: 900 }) }), p)).toBe(true);
    // The panel must show BOTH rows, in list order — a collapse loses one.
    const rows = pathRequirements(monster({ essence: essence({ Fire: 200 }) }), p).filter(
      (g) => g.kind === 'essence',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.met).toBe(false);
    expect(rows[1]!.met).toBe(true);
  });

  it('BITES: a zero-amount essence requirement is satisfied by zero essence', () => {
    // Kills: a falsy-coercion guard (`if (req.amount)`) or a `>` compare on 0.
    const p = evoPath({ essence: [{ affinity: 'Fire', amount: 0 }] });
    expect(pathSatisfied(monster({ essence: essence({ Fire: 0 }) }), p)).toBe(true);
    expect(pathRequirements(monster(), p).filter((g) => g.kind === 'essence')).toHaveLength(1);
  });
});

// ===========================================================================
// EG4-1 · THE FIVE GATES ARE AND-COMBINED
// ===========================================================================

describe('EG4-1 pathSatisfied: the five gates are AND-combined', () => {
  it('BITES: all five gates present and met EXACTLY at threshold → satisfied (control)', () => {
    // Non-vacuity control for the five breakers below: without it, an impl that always
    // returns false would pass every one of them.
    expect(pathSatisfied(FULL_MONSTER, FULL_PATH)).toBe(true);
    expect(unmetRequirement(FULL_MONSTER, FULL_PATH)).toBeNull();
  });

  const BREAKERS: readonly (readonly [string, Partial<StoreMonsterPub>])[] = [
    ['level', { level: 19 }],
    ['essence', { essence: essence({ Fire: 119 }) }],
    ['trust', { trustTier: 'Neutral' }],
    ['qualityTime', { qualityTimeTier: 2 }],
    ['nutrition', { nutritionPct: 59 }],
  ];

  for (const [gate, breaker] of BREAKERS) {
    it(`BITES: ${gate} unmet with the other four met → NOT satisfied`, () => {
      // Kills: `&&` -> `||` in path_satisfied's conjunction (eligibility.rs:94-98).
      // Under `||`, four met gates carry the fifth and the monster evolves without
      // ever clearing it. Each of the five must independently veto.
      const m: StoreMonsterPub = { ...FULL_MONSTER, ...breaker };
      expect(pathSatisfied(m, FULL_PATH)).toBe(false);
      expect(unmetRequirement(m, FULL_PATH)).not.toBeNull();
    });
  }

  it('BITES: an absent (null) history gate is PERMISSIVE, not "requires the lowest tier"', () => {
    // Kills: defaulting `minTrustTier: null` to 'Hostile' / `minQualityTimeTier: null`
    // to 0 and emitting a gate row for it. Rust's `is_none_or` short-circuits to TRUE
    // (eligibility.rs:63/73/79); a permissive gate must emit NO row at all (contract §C).
    const p = evoPath({ minTrustTier: null, minQualityTimeTier: null, minNutritionPct: null });
    const m = monster({ trustTier: 'Hostile', qualityTimeTier: 0, nutritionPct: 0 });
    expect(pathSatisfied(m, p)).toBe(true);
    const kinds = pathRequirements(m, p).map((g) => g.kind);
    expect(kinds).not.toContain('trust');
    expect(kinds).not.toContain('qualityTime');
    expect(kinds).not.toContain('nutrition');
  });
});

// ===========================================================================
// EG4-1 · TRUST IS COMPARED BY RANK, NEVER AS A STRING
// ===========================================================================

describe('EG4-1 trust gate: compared by RANK, never lexicographically', () => {
  it('BITES: minTrustTier "Neutral" + monster "Devoted" → eligible', () => {
    // Kills: a raw string `>=`. Lexicographically 'Devoted' < 'Neutral', so a string
    // compare reports this (correct) case as INELIGIBLE — the most-trusted monster
    // would be locked out of a mid-tier gate forever.
    const p = evoPath({ minTrustTier: 'Neutral' });
    expect(pathSatisfied(monster({ trustTier: 'Devoted' }), p)).toBe(true);
  });

  it('BITES: minTrustTier "Devoted" + monster "Hostile" → NOT eligible', () => {
    // Kills: the same raw string `>=` in its other direction. Lexicographically
    // 'Hostile' > 'Devoted', so a string compare would PHANTOM-ELIGIBLE the most
    // distrustful monster against the hardest gate. Together with the case above, a
    // string compare gets BOTH backwards — neither test alone proves the rank port.
    const p = evoPath({ minTrustTier: 'Devoted' });
    expect(pathSatisfied(monster({ trustTier: 'Hostile' }), p)).toBe(false);
  });

  it('BITES: the lexicographic order of the five tags genuinely DIFFERS from the rank order', () => {
    // Non-vacuity control for the two cases above: if the tags happened to sort into
    // ascending rank order, a string compare would pass both and they would prove
    // nothing. This asserts the trap is real.
    const lexicographic = [...TRUST_TIER_ORDER].sort();
    expect(lexicographic).not.toEqual([...TRUST_TIER_ORDER]);
    expect(lexicographic).toEqual(['Devoted', 'Friendly', 'Hostile', 'Neutral', 'Wary']);
  });
});

// ---------------------------------------------------------------------------
// 25 hard-coded rank comparisons. The expected booleans are LITERALS, written out
// by hand from eligibility.rs:183-189's ASCENDING array — deliberately NOT derived
// from TRUST_TIER_ORDER, because a derived table is self-referential and stays
// green under ANY reorder of the very constant it claims to gate (contract A7/M3).
// ---------------------------------------------------------------------------

const RANK_GE_MATRIX: readonly (readonly [TrustTierName, TrustTierName, boolean])[] = [
  ['Hostile', 'Hostile', true],
  ['Hostile', 'Wary', false],
  ['Hostile', 'Neutral', false],
  ['Hostile', 'Friendly', false],
  ['Hostile', 'Devoted', false],
  ['Wary', 'Hostile', true],
  ['Wary', 'Wary', true],
  ['Wary', 'Neutral', false],
  ['Wary', 'Friendly', false],
  ['Wary', 'Devoted', false],
  ['Neutral', 'Hostile', true],
  ['Neutral', 'Wary', true],
  ['Neutral', 'Neutral', true],
  ['Neutral', 'Friendly', false],
  ['Neutral', 'Devoted', false],
  ['Friendly', 'Hostile', true],
  ['Friendly', 'Wary', true],
  ['Friendly', 'Neutral', true],
  ['Friendly', 'Friendly', true],
  ['Friendly', 'Devoted', false],
  ['Devoted', 'Hostile', true],
  ['Devoted', 'Wary', true],
  ['Devoted', 'Neutral', true],
  ['Devoted', 'Friendly', true],
  ['Devoted', 'Devoted', true],
];

describe('EG4-1 trustTierRank: 25 hand-written rank comparisons', () => {
  it('BITES: all 25 (a,b) pairs compare as the hand-written literal booleans say', () => {
    // Kills: any reordering of TRUST_TIER_ORDER, and any rank function that is not a
    // strictly ascending 0..4 over Hostile<Wary<Neutral<Friendly<Devoted. The expected
    // column is written out by hand; regenerating it from TRUST_TIER_ORDER would make
    // this test tautological.
    expect(RANK_GE_MATRIX).toHaveLength(25);
    for (const [a, b, expected] of RANK_GE_MATRIX) {
      expect(trustTierRank(a) >= trustTierRank(b), `rank(${a}) >= rank(${b})`).toBe(expected);
    }
  });

  it('BITES: the five ranks are exactly 0,1,2,3,4 in ascending trust order (literals)', () => {
    // Kills: a rank function returning a constant, a reversed scale, or a sparse map
    // whose gaps break the "one tier below" boundary cases above.
    expect(trustTierRank('Hostile')).toBe(0);
    expect(trustTierRank('Wary')).toBe(1);
    expect(trustTierRank('Neutral')).toBe(2);
    expect(trustTierRank('Friendly')).toBe(3);
    expect(trustTierRank('Devoted')).toBe(4);
  });

  it('BITES: an unrecognized tag ranks -1 and does not throw', () => {
    // Kills: a throw (a throw in a model starves sibling store batch-listeners) and a
    // `?? 0` default that would silently read an unknown tag as 'Hostile'.
    expect(() => trustTierRank('Ascendant')).not.toThrow();
    expect(trustTierRank('Ascendant')).toBe(-1);
    expect(trustTierRank('')).toBe(-1);
    expect(trustTierRank('hostile')).toBe(-1); // case-sensitive: SDK tags are exact
  });
});

// ===========================================================================
// EG4-1 (A2) · UNKNOWN TRUST TAGS FAIL CLOSED ON BOTH SIDES
// ===========================================================================

describe('EG4-1 (A2) trust gate: unknown tags fail CLOSED, on either side', () => {
  it('BITES: an unknown THRESHOLD tag makes the gate unsatisfiable (never phantom-eligible)', () => {
    // Kills: gating through a shared `rank(unknown) === -1` sentinel. `rank(monster) >= -1`
    // is ALWAYS true, so a naive port fails OPEN on the threshold side: a server that
    // ships a new TrustTier variant would make every edge gated on it instantly eligible
    // for every monster — the client would render "ready to evolve" for an edge the
    // server rejects.
    const p = evoPath({ minTrustTier: UNKNOWN_TRUST_TAG });
    const devoted = monster({ trustTier: 'Devoted' });
    expect(pathSatisfied(devoted, p)).toBe(false);
    expect(pathSatisfied(monster({ trustTier: 'Hostile' }), p)).toBe(false);
    expect(eligibleEvolutionPaths(devoted, [p])).toEqual([]);
    // RED-TEAM ADDITION: pin the SAME verdict on the gate ROW. A5 says pathRequirements
    // is THE single walk and pathSatisfied derives from it — but nothing here forced the
    // ROW to fail closed. An impl that special-cases the unknown threshold in
    // pathSatisfied while pathRequirements keeps the `-1` sentinel renders an all-green
    // trust row next to a blocked path: the panel says "requirement met", the server
    // rejects. This is the fail-open direction A2 exists to forbid, one layer down.
    const trustRow = pathRequirements(devoted, p).find((g) => g.kind === 'trust');
    expect(trustRow, 'a present (non-null) threshold must still emit a trust row').toBeDefined();
    expect(trustRow!.met, 'the trust ROW must fail closed on an unknown THRESHOLD tag') //
      .toBe(false);
    expect(unmetRequirement(devoted, p)).not.toBeNull();
  });

  it('BITES: an unknown MONSTER tag makes the gate unsatisfiable, even against the lowest threshold', () => {
    // Kills: treating an unrecognized monster tag as merely "lowest tier", which would
    // still CLEAR a `minTrustTier: 'Hostile'` gate. A2: the gate returns false when
    // EITHER tag is unrecognized.
    const p = evoPath({ minTrustTier: 'Hostile' });
    const unknown = monster({ trustTier: UNKNOWN_TRUST_TAG });
    expect(pathSatisfied(unknown, p)).toBe(false);
    // Control: a KNOWN lowest tag does clear it, so the assertion above is not vacuous.
    expect(pathSatisfied(monster({ trustTier: 'Hostile' }), p)).toBe(true);
    // RED-TEAM ADDITION: same row-level pin on the monster side, and the CONTROL row must
    // read met=true — so "the row is always false" cannot satisfy this pair either.
    const unknownRow = pathRequirements(unknown, p).find((g) => g.kind === 'trust');
    const knownRow = pathRequirements(monster({ trustTier: 'Hostile' }), p).find(
      (g) => g.kind === 'trust',
    );
    expect(unknownRow, 'a trust row must be emitted for an unknown monster tag too') //
      .toBeDefined();
    expect(knownRow, 'a trust row must be emitted for the known-tag control').toBeDefined();
    expect(unknownRow!.met, 'the trust ROW must fail closed on an unknown MONSTER tag') //
      .toBe(false);
    expect(knownRow!.met, "CONTROL: 'Hostile' vs 'Hostile' is met — the row is not constant") //
      .toBe(true);
    expect(unmetRequirement(unknown, p)).not.toBeNull();
  });

  it('BITES: neither unknown-tag direction throws', () => {
    // A throw inside a model kills the whole flushBatch burst (store.ts one-way flow,
    // no per-listener isolation) — every sibling overlay stops updating.
    const m = monster({ trustTier: UNKNOWN_TRUST_TAG });
    const p = evoPath({ minTrustTier: UNKNOWN_TRUST_TAG });
    expect(() => pathSatisfied(m, p)).not.toThrow();
    expect(() => pathRequirements(m, p)).not.toThrow();
    expect(() => unmetRequirement(m, p)).not.toThrow();
    expect(() => eligibleEvolutionPaths(m, [p])).not.toThrow();
    expect(() => buildEvolutionViewModel([m], SPECIES_MAP, [p])).not.toThrow();
  });

  it('BITES: an unknown monster tag against an ABSENT threshold is still satisfied (permissive wins)', () => {
    // Contract §C: a null threshold emits NO row, so there is no comparison to fail.
    // Kills: a blanket "unknown tag => path unsatisfiable" that would black-hole every
    // essence-only edge (EG3-7/EG3-8) the moment the server adds a TrustTier variant.
    const p = evoPath({ minTrustTier: null });
    expect(pathSatisfied(monster({ trustTier: UNKNOWN_TRUST_TAG }), p)).toBe(true);
  });
});

// ===========================================================================
// EG4-1 (A11) · minLevel OUTSIDE 1..=100 IS NEVER SATISFIED
// ===========================================================================

describe('EG4-1 (A11) level gate: minLevel outside 1..=100 is never satisfied', () => {
  it('BITES: minLevel 0 is NEVER satisfied, even at level 100', () => {
    // Kills: a naive `level >= minLevel`, which reads minLevel 0 as trivially satisfied.
    // marshal.rs:354-362 `Level::new` REJECTS 0, so `check_and_evolve` SKIPS such an
    // edge server-side — a client that shows it as ready is lying about an edge the
    // server will never apply and `evolve()` hard-errors on.
    const p = evoPath({ minLevel: 0 });
    const m = monster({ level: 100 });
    expect(pathSatisfied(m, p)).toBe(false);
    expect(eligibleEvolutionPaths(m, [p])).toEqual([]);
    expect(unmetRequirement(m, p)).not.toBeNull();
  });

  it('BITES: minLevel 101 is NEVER satisfied, even at level 100', () => {
    // Kills: the same naive compare at the upper bound (Level::new rejects > 100).
    const p = evoPath({ minLevel: 101 });
    const m = monster({ level: 100 });
    expect(pathSatisfied(m, p)).toBe(false);
    expect(eligibleEvolutionPaths(m, [p])).toEqual([]);
    expect(unmetRequirement(m, p)).not.toBeNull();
  });

  it('BITES: the in-range endpoints 1 and 100 ARE satisfiable (control)', () => {
    // Non-vacuity control: kills an over-broad A11 clamp that also rejects the legal
    // endpoints, which would black-hole EG3-3/EG3-4's authored `min_level: 1` edges.
    expect(pathSatisfied(monster({ level: 1 }), evoPath({ minLevel: 1 }))).toBe(true);
    expect(pathSatisfied(monster({ level: 100 }), evoPath({ minLevel: 100 }))).toBe(true);
  });

  it('BITES: unmetRequirement is null EXACTLY when pathSatisfied is true, A11 paths included', () => {
    // Kills: an A11 range-check bolted onto pathSatisfied ALONE. If unmetRequirement
    // still walks only the gate rows, a minLevel-0 path reports `satisfied === false`
    // with `reason === null` — and the panel renders a blocked path with no explanation
    // at all. Mirrors Rust's `unmet_requirement_agrees_with_path_satisfied` property.
    const paths: readonly StoreEvolutionPath[] = [
      evoPath({ minLevel: 0 }),
      evoPath({ minLevel: 101 }),
      evoPath({ minLevel: 1 }),
      evoPath({ minLevel: 100 }),
      FULL_PATH,
      evoPath({ minTrustTier: UNKNOWN_TRUST_TAG }),
    ];
    const monsters: readonly StoreMonsterPub[] = [
      monster({ level: 1 }),
      monster({ level: 100 }),
      FULL_MONSTER,
      monster({ trustTier: UNKNOWN_TRUST_TAG }),
    ];
    for (const m of monsters) {
      for (const p of paths) {
        expect(
          unmetRequirement(m, p) === null,
          `agreement for level=${m.level} trust=${m.trustTier} minLevel=${p.minLevel}`,
        ).toBe(pathSatisfied(m, p));
      }
    }
  });
});

// ===========================================================================
// EG4-1 · pathRequirements — THE single gate walk (contract A5)
// ===========================================================================

describe('EG4-1 pathRequirements: canonical gate order, labels, and current-vs-required', () => {
  it('BITES: gate rows come in canonical order level → essence → trust → qualityTime → nutrition', () => {
    // Kills: reordered gate reporting. The order is load-bearing twice over: it is the
    // order the panel reads top-to-bottom, AND it is the order unmetRequirement scans,
    // so a reorder silently changes which reason the server's reject string is compared
    // against (eligibility.rs:117-149).
    expect(pathRequirements(FULL_MONSTER, FULL_PATH).map((g) => g.kind)).toEqual([
      'level',
      'essence',
      'trust',
      'qualityTime',
      'nutrition',
    ]);
  });

  it('BITES: multiple essence entries keep LIST order and sit between level and trust', () => {
    // Kills: sorting/deduping the essence rows, or hoisting them out of the walk.
    const p = evoPath({
      ...FULL_PATH,
      essence: [
        { affinity: 'Water', amount: 10 },
        { affinity: 'Fire', amount: 20 },
      ],
    });
    const rows = pathRequirements(FULL_MONSTER, p);
    expect(rows.map((g) => g.kind)).toEqual([
      'level',
      'essence',
      'essence',
      'trust',
      'qualityTime',
      'nutrition',
    ]);
    expect(rows[1]!.label).toBe('Water essence');
    expect(rows[2]!.label).toBe('Fire essence');
  });

  it('BITES: the five labels are exactly Level / <Affinity> essence / Trust / Quality time / Nutrition', () => {
    // Kills: label drift (contract §C pins these strings). The panel is the only place
    // a player learns WHICH stat is blocking them.
    expect(pathRequirements(FULL_MONSTER, FULL_PATH).map((g) => g.label)).toEqual([
      'Level',
      'Fire essence',
      'Trust',
      'Quality time',
      'Nutrition',
    ]);
  });

  it('BITES: every row carries the monster CURRENT value and the path REQUIRED value, distinctly', () => {
    // Kills: an impl that renders the requirement twice (currentText === requiredText),
    // which is the "progress panel" with the progress half missing — EG4-1's whole point
    // (contract A5). All ten numbers below are distinct, so a swap cannot pass.
    const m = monster({
      level: 17,
      essence: essence({ Fire: 33 }),
      trustTier: 'Wary',
      qualityTimeTier: 1,
      nutritionPct: 41,
    });
    const rows = pathRequirements(m, FULL_PATH);
    const byKind = (kind: EvolutionGateViewModel['kind']): EvolutionGateViewModel => {
      const row = rows.find((g) => g.kind === kind);
      expect(row, `a "${kind}" gate row must be present`).toBeDefined();
      return row as EvolutionGateViewModel;
    };
    expect(byKind('level').currentText).toContain('17');
    expect(byKind('level').requiredText).toContain('20');
    expect(byKind('essence').currentText).toContain('33');
    expect(byKind('essence').requiredText).toContain('120');
    expect(byKind('trust').currentText).toContain('Wary');
    expect(byKind('trust').requiredText).toContain('Friendly');
    expect(byKind('qualityTime').currentText).toContain('1');
    expect(byKind('qualityTime').requiredText).toContain('3');
    expect(byKind('nutrition').currentText).toContain('41');
    expect(byKind('nutrition').requiredText).toContain('60');
    // Every one of these five is unmet, and `met` must say so per-row.
    expect(rows.every((g) => g.met === false)).toBe(true);
  });

  it('BITES: pathSatisfied agrees with "every emitted row is met" for in-range levels', () => {
    // Kills: a second, divergent gate walk inside pathSatisfied (contract A5: ONE walk,
    // both derive). A drifted copy shows a panel of all-green rows next to a blocked path.
    const m = monster({
      level: 20,
      essence: essence({ Fire: 120 }),
      trustTier: 'Friendly',
      qualityTimeTier: 3,
      nutritionPct: 59, // only nutrition unmet
    });
    const rows = pathRequirements(m, FULL_PATH);
    expect(rows.every((g) => g.met)).toBe(false);
    expect(pathSatisfied(m, FULL_PATH)).toBe(false);
    expect(rows.filter((g) => !g.met).map((g) => g.kind)).toEqual(['nutrition']);
  });
});

// ===========================================================================
// EG4-1 · unmetRequirement — FIRST unmet gate, Rust message formats verbatim
// eligibility.rs:116-151
// ===========================================================================

describe('EG4-1 unmetRequirement: first unmet gate in canonical order, Rust message formats', () => {
  it('BITES: all five unmet → reports LEVEL first', () => {
    // Kills: reordered reporting. The client message must name the SAME gate the server's
    // reject string names (eligibility.rs:117-119), or the panel contradicts the reducer.
    const m = monster({
      level: 19,
      essence: essence({ Fire: 0 }),
      trustTier: 'Hostile',
      qualityTimeTier: 0,
      nutritionPct: 0,
    });
    expect(unmetRequirement(m, FULL_PATH)).toBe('requires level 20');
  });

  it('BITES: level met, rest unmet → reports the ESSENCE entry, naming amount + affinity', () => {
    // Kills: message drift. Rust formats `requires {amount} {Affinity:?} essence`
    // (eligibility.rs:127-130) — amount FIRST, then the Debug-printed variant name.
    const m = monster({
      level: 20,
      essence: essence({ Fire: 0 }),
      trustTier: 'Hostile',
      qualityTimeTier: 0,
      nutritionPct: 0,
    });
    expect(unmetRequirement(m, FULL_PATH)).toBe('requires 120 Fire essence');
  });

  it('BITES: the FIRST unmet essence entry is named, in list order', () => {
    // Kills: reporting the last unmet entry (or a Record-collapsed one) — Rust uses
    // `.find()` over the list (eligibility.rs:122-126).
    const p = evoPath({
      essence: [
        { affinity: 'Water', amount: 10 },
        { affinity: 'Dark', amount: 20 },
      ],
    });
    const m = monster({ essence: essence({ Water: 0, Dark: 0 }) });
    expect(unmetRequirement(m, p)).toBe('requires 10 Water essence');
  });

  it('BITES: level+essence met → reports TRUST as "requires trust tier {Tier}"', () => {
    // Kills: message drift (eligibility.rs:132-137). Note the threshold tier is named,
    // never the monster's own tier.
    const m = monster({
      level: 20,
      essence: essence({ Fire: 120 }),
      trustTier: 'Neutral',
      qualityTimeTier: 0,
      nutritionPct: 0,
    });
    expect(unmetRequirement(m, FULL_PATH)).toBe('requires trust tier Friendly');
  });

  it('BITES: level+essence+trust met → reports "requires quality time tier {n}"', () => {
    // Kills: message drift (eligibility.rs:138-143) — three words, lowercase, no hyphen.
    const m = monster({
      level: 20,
      essence: essence({ Fire: 120 }),
      trustTier: 'Friendly',
      qualityTimeTier: 2,
      nutritionPct: 0,
    });
    expect(unmetRequirement(m, FULL_PATH)).toBe('requires quality time tier 3');
  });

  it('BITES: only nutrition unmet → reports "requires nutrition {n}%" with the percent sign', () => {
    // Kills: message drift (eligibility.rs:144-149) — the trailing `%` is part of the
    // server's reject string.
    const m = monster({
      level: 20,
      essence: essence({ Fire: 120 }),
      trustTier: 'Friendly',
      qualityTimeTier: 3,
      nutritionPct: 59,
    });
    expect(unmetRequirement(m, FULL_PATH)).toBe('requires nutrition 60%');
  });

  it('BITES: fully satisfied → null (not "" and not undefined)', () => {
    // Kills: returning an empty string, which every `if (reason)` consumer treats as
    // "satisfied" but every `reason !== null` consumer treats as blocked.
    const reason = unmetRequirement(FULL_MONSTER, FULL_PATH);
    expect(reason).toBeNull();
    expect(reason).not.toBe('');
    expect(reason).not.toBeUndefined();
  });
});

// ===========================================================================
// EG4-1 (A9) · eligibleEvolutionPaths — fromSpecies filter, FULL set, edgeId order
// ===========================================================================

describe('EG4-1 (A9) eligibleEvolutionPaths: filtered, complete, and sorted by edgeId', () => {
  it('BITES: shuffled insertion order → the eligible set is ascending by edgeId', () => {
    // Kills: dependence on Map-iteration order (= subscription-arrival order, which is
    // nondeterministic and changes on every content republish per A1). The player's
    // choice list would silently reorder between sessions, so a muscle-memory click
    // picks a different evolution.
    //
    // RED-TEAM CORRECTION (fixture, not assertion): pathId is now ANTI-correlated with
    // edgeId. The authored fixture used pathId = edgeId * 10, so "sort by pathId" — the
    // single most likely wrong key, since pathId is the store's Map key and the field an
    // implementer has closest to hand — produced the IDENTICAL order and sailed through.
    // toSpecies is anti-correlated for the same reason. Against this fixture, only an
    // edgeId-ascending sort yields [2,4,7,9]; the three anti-key assertions below prove
    // that, so the equality is a genuine discrimination rather than a coincidence.
    const shuffled: readonly StoreEvolutionPath[] = [
      evoPath({ pathId: 90n, edgeId: 7, toSpecies: 4 }),
      evoPath({ pathId: 40n, edgeId: 2, toSpecies: 9 }),
      evoPath({ pathId: 20n, edgeId: 9, toSpecies: 2 }),
      evoPath({ pathId: 70n, edgeId: 4, toSpecies: 3 }),
    ];
    const got = eligibleEvolutionPaths(monster({ speciesId: 1 }), shuffled);
    expect(got.map((p) => p.edgeId)).toEqual([2, 4, 7, 9]);
    expect(
      shuffled.map((p) => p.edgeId),
      'FIXTURE SOUNDNESS: insertion order must differ from edgeId order',
    ).not.toEqual([2, 4, 7, 9]);
    expect(
      [...shuffled].sort((a, b) => Number(a.pathId - b.pathId)).map((p) => p.edgeId),
      'FIXTURE SOUNDNESS: pathId order must differ from edgeId order, or a pathId sort ' +
        'passes this test for free',
    ).not.toEqual([2, 4, 7, 9]);
    expect(
      [...shuffled].sort((a, b) => a.toSpecies - b.toSpecies).map((p) => p.edgeId),
      'FIXTURE SOUNDNESS: toSpecies order must differ from edgeId order, or a toSpecies ' +
        'sort passes this test for free',
    ).not.toEqual([2, 4, 7, 9]);
  });

  it('BITES: a different insertion permutation yields the SAME order', () => {
    // Kills: an "already sorted by luck" impl — two permutations must converge.
    const a: readonly StoreEvolutionPath[] = [
      evoPath({ edgeId: 9 }),
      evoPath({ edgeId: 2 }),
      evoPath({ edgeId: 7 }),
    ];
    const b: readonly StoreEvolutionPath[] = [
      evoPath({ edgeId: 7 }),
      evoPath({ edgeId: 9 }),
      evoPath({ edgeId: 2 }),
    ];
    const m = monster({ speciesId: 1 });
    expect(eligibleEvolutionPaths(m, a).map((p) => p.edgeId)).toEqual([2, 7, 9]);
    expect(eligibleEvolutionPaths(m, b).map((p) => p.edgeId)).toEqual([2, 7, 9]);
  });

  it('BITES: paths whose fromSpecies is not the monster species are excluded, however satisfied', () => {
    // Kills: a missing fromSpecies filter (eligibility.rs:165). A fully-permissive edge
    // out of some OTHER species would otherwise show up as this monster's evolution.
    const m = monster({ speciesId: 1 });
    const paths: readonly StoreEvolutionPath[] = [
      evoPath({ edgeId: 1, fromSpecies: 1, toSpecies: 2 }),
      evoPath({ edgeId: 2, fromSpecies: 9, toSpecies: 3 }), // foreign, fully satisfied
    ];
    expect(eligibleEvolutionPaths(m, paths).map((p) => p.edgeId)).toEqual([1]);
  });

  it('BITES: the FULL eligible set is returned — never a first-match winner', () => {
    // Kills: `.find()` / `[0]` (EG2-2's anti-pattern: the Tamagotchi/Wurmple silent race).
    const m = monster({ speciesId: 1 });
    const paths: readonly StoreEvolutionPath[] = [
      evoPath({ edgeId: 1, toSpecies: 2 }),
      evoPath({ edgeId: 2, toSpecies: 3 }),
      evoPath({ edgeId: 3, toSpecies: 4 }),
    ];
    expect(eligibleEvolutionPaths(m, paths)).toHaveLength(3);
    expect(eligibleEvolutionPaths(m, paths).map((p) => p.toSpecies)).toEqual([2, 3, 4]);
  });

  it('BITES: unsatisfied paths are excluded even when their fromSpecies matches', () => {
    // Kills: an eligibility function that filters on fromSpecies only and forgets the
    // gates entirely.
    const m = monster({ speciesId: 1, level: 5 });
    const paths: readonly StoreEvolutionPath[] = [
      evoPath({ edgeId: 1, minLevel: 4 }),
      evoPath({ edgeId: 2, minLevel: 6 }),
    ];
    expect(eligibleEvolutionPaths(m, paths).map((p) => p.edgeId)).toEqual([1]);
  });

  it('BITES: an empty paths array returns [] and does not throw', () => {
    expect(() => eligibleEvolutionPaths(monster(), [])).not.toThrow();
    expect(eligibleEvolutionPaths(monster(), [])).toEqual([]);
  });
});

// ===========================================================================
// EG4-1 (A8) · MECHANICAL DRIFT GATE — TRUST_TIER_ORDER vs the generated bindings
// ===========================================================================

const TYPES_TS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'module_bindings',
  'types.ts',
);

/**
 * The declared key order of the generated `__t.enum("TrustTier", { ... })` block.
 *
 * `spacetime generate` emits the variants in RUST DECLARATION ORDER, which is exactly
 * what `TrustTier`'s derived `Ord` (game-core/src/content.rs) ranks by — so this file
 * IS the mechanical witness for the Rust ordering, without a new Rust fixture (A14).
 *
 * Parsed with String.indexOf/slice plus a LITERAL regex. `new RegExp(...)` is BANNED:
 * Semgrep's `detect-non-literal-regexp` runs `--config auto --error` in CI and has
 * broken this repo twice.
 */
function parseTrustTierBindingOrder(): readonly string[] {
  const src = readFileSync(TYPES_TS_PATH, 'utf8');
  const marker = '__t.enum("TrustTier", {';
  const start = src.indexOf(marker);
  expect(
    start,
    `precondition (A8): '${marker}' must exist in module_bindings/types.ts — if the ` +
      'generator changes its emission shape this parse silently matches nothing and the ' +
      'whole ordering gate goes vacuous',
  ).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = src.indexOf('});', bodyStart);
  expect(end, 'precondition (A8): the enum block must terminate with "});"').toBeGreaterThan(
    bodyStart,
  );
  const body = src.slice(bodyStart, end);
  const keys = [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1] as string);
  expect(
    keys.length,
    'precondition (A8): the parse must find variants — an empty result would make the ' +
      'equality assertion below pass for the wrong reason',
  ).toBeGreaterThan(0);
  return keys;
}

describe('EG4-1 (A8) TRUST_TIER_ORDER: mechanically pinned to the generated bindings', () => {
  it('BITES: TRUST_TIER_ORDER equals the __t.enum("TrustTier") key order, element for element', () => {
    // Kills: a Rust `enum TrustTier` REORDER. `sdk-enum-exhaustiveness.eval.mjs` checks
    // MEMBERSHIP only, so swapping two variants in game-core is invisible to it — yet it
    // silently inverts every `Ord >=` trust gate on the server while the client keeps the
    // old ranks. This is the one in-scope gate on Rust<->TS ordering drift (A14 deferred
    // the full parity-fixture matrix).
    expect(parseTrustTierBindingOrder()).toEqual([...TRUST_TIER_ORDER]);
  });

  it('BITES: TRUST_TIER_ORDER is the hard-coded ascending literal from eligibility.rs ASCENDING', () => {
    // Kills: deriving TRUST_TIER_ORDER from HANDLED_ENUM_VARIANTS (A7/A17) — a derived
    // constant makes the ordering test above self-referential and green under any reorder.
    expect([...TRUST_TIER_ORDER]).toEqual(['Hostile', 'Wary', 'Neutral', 'Friendly', 'Devoted']);
  });

  it('BITES: TRUST_TIER_ORDER as a SET equals HANDLED_ENUM_VARIANTS.TrustTier', () => {
    // Kills: a server-added TrustTier variant landing in the SDK registry while
    // TRUST_TIER_ORDER (and therefore every rank comparison) stays stale — the ranks
    // would be silently wrong for the new variant and every variant above it.
    const registry: readonly string[] = HANDLED_ENUM_VARIANTS.TrustTier;
    expect([...registry].sort()).toEqual([...TRUST_TIER_ORDER].sort());
    expect(new Set(registry).size).toBe(TRUST_TIER_ORDER.length);
  });
});

// ===========================================================================
// EG4-2 · THE CHOICE UI APPEARS ONLY AT 2+ ELIGIBLE
// ===========================================================================

function vmFor(
  m: StoreMonsterPub,
  paths: readonly StoreEvolutionPath[],
): EvolutionMonsterViewModel {
  const vm: EvolutionViewModel = buildEvolutionViewModel([m], SPECIES_MAP, paths);
  expect(vm.monsters, 'precondition: one monster in → one monster view-model out').toHaveLength(1);
  return vm.monsters[0] as EvolutionMonsterViewModel;
}

describe('EG4-2 buildEvolutionViewModel: choices appear ONLY at 2+ eligible', () => {
  it('BITES: 2 simultaneously eligible → choices.length === 2 with BOTH toSpecies present', () => {
    // Kills: a first-match auto-resolve (`.find()` / `[0]`) — the exact silent-race
    // anti-pattern EG2-2/EG4-2 exist to forbid. The player, not the client, picks.
    const mon = vmFor(monster({ speciesId: 1, level: 30 }), [
      evoPath({ edgeId: 5, toSpecies: 3, minLevel: 20 }),
      evoPath({ edgeId: 2, toSpecies: 2, minLevel: 20 }),
    ]);
    expect(mon.eligibleCount).toBe(2);
    expect(mon.choices).toHaveLength(2);
    expect(mon.choices.map((c) => c.toSpecies).sort()).toEqual([2, 3]);
    expect(mon.choices.map((c) => c.toSpeciesName).sort()).toEqual(['Cindermaw', 'Pyrodrake']);
    expect(mon.choices.every((c) => c.met)).toBe(true);
    expect(mon.choices.every((c) => c.unmetReason === null)).toBe(true);
  });

  it('BITES (A9): choices are ascending by edgeId, not by arrival order', () => {
    // Kills: Map-iteration-order dependence leaking into the player-facing choice list.
    //
    // RED-TEAM CORRECTION (fixture, not assertion): pathId and toSpecies are now both
    // ANTI-correlated with edgeId. The authored fixture had edge9→to4, edge3→to2,
    // edge6→to3 — i.e. toSpecies ascending produced the SAME [3,6,9], so an impl that
    // sorted the choice list by target species (a plausible "alphabetical-ish" choice for
    // a player-facing picker) passed for free. pathId defaulted to 1n on all three, so a
    // pathId sort was merely stable and was caught only by luck of arrival order.
    const mon = vmFor(monster({ speciesId: 1 }), [
      evoPath({ pathId: 30n, edgeId: 9, toSpecies: 2 }),
      evoPath({ pathId: 90n, edgeId: 3, toSpecies: 4 }),
      evoPath({ pathId: 60n, edgeId: 6, toSpecies: 3 }),
    ]);
    // edgeId ascending → [3,6,9]; toSpecies ascending → [9,6,3]; pathId ascending →
    // [9,6,3]; arrival order → [9,3,6]. Only the contracted sort produces the expected.
    expect(mon.choices.map((c) => c.edgeId)).toEqual([3, 6, 9]);
    expect(
      mon.choices.map((c) => c.toSpecies),
      'FIXTURE SOUNDNESS: with edgeId-ascending choices the toSpecies sequence must be ' +
        'DESCENDING here — if it reads ascending, the fixture no longer discriminates a ' +
        'toSpecies sort from the contracted edgeId sort',
    ).toEqual([4, 3, 2]);
  });

  it('BITES: exactly 1 eligible → choices is EMPTY', () => {
    // Kills: `>= 1` on the choice threshold. EG4-2 is explicit: the client SHALL NOT
    // present an Evolve action for the single-eligible case — the server auto-applies it
    // (EG2-11), so a choice UI there is an action the player must never be offered.
    const mon = vmFor(monster({ speciesId: 1, level: 30 }), [
      evoPath({ edgeId: 1, toSpecies: 2, minLevel: 20 }),
      evoPath({ edgeId: 2, toSpecies: 3, minLevel: 99 }),
    ]);
    expect(mon.eligibleCount).toBe(1);
    expect(mon.choices).toEqual([]);
  });

  it('BITES: the monster view-model has NO canEvolve and NO evolvesToSpeciesName key', () => {
    // Kills: reintroducing the retired single-eligible Evolve action (contract §C
    // "Never reintroduced"). A surviving `canEvolve` is exactly the surface a view would
    // hang a forbidden Evolve button off.
    const mon = vmFor(monster({ speciesId: 1, level: 30 }), [evoPath({ edgeId: 1, minLevel: 20 })]);
    const keys = Object.keys(mon);
    expect(keys).not.toContain('canEvolve');
    expect(keys).not.toContain('evolvesToSpeciesName');
    expect(keys).not.toContain('evolvesTo');
    expect(keys).not.toContain('bond');
    expect(keys).not.toContain('toSpecies');
  });

  it('BITES: 0 eligible → choices empty AND every path carries a non-null unmetReason', () => {
    // Kills: a panel that lists blocked paths with no explanation — EG4-1's requirements
    // half. Also kills an impl that only computes reasons for the eligible set.
    const mon = vmFor(monster({ speciesId: 1, level: 5, nutritionPct: 0 }), [
      evoPath({ edgeId: 1, toSpecies: 2, minLevel: 20 }),
      evoPath({ edgeId: 2, toSpecies: 3, minNutritionPct: 60 }),
    ]);
    expect(mon.eligibleCount).toBe(0);
    expect(mon.choices).toEqual([]);
    expect(mon.paths).toHaveLength(2);
    expect(mon.paths.every((p) => p.met === false)).toBe(true);
    expect(mon.paths.map((p) => p.unmetReason)).toEqual([
      'requires level 20',
      'requires nutrition 60%',
    ]);
  });

  it('BITES: paths lists ALL outgoing edges (the progress panel), not just the eligible ones', () => {
    // Kills: `paths = eligible` — the panel would then show nothing at all for the
    // 0-eligible monster, which is the state a player most needs to read (EG4-1).
    const mon = vmFor(monster({ speciesId: 1, level: 30 }), [
      evoPath({ edgeId: 1, toSpecies: 2, minLevel: 20 }),
      evoPath({ edgeId: 2, toSpecies: 3, minLevel: 99 }),
      evoPath({ edgeId: 3, fromSpecies: 9, toSpecies: 4 }), // foreign species — excluded
    ]);
    expect(mon.paths.map((p) => p.edgeId)).toEqual([1, 2]);
    expect(mon.paths.map((p) => p.met)).toEqual([true, false]);
    expect(mon.paths.map((p) => p.unmetReason)).toEqual([null, 'requires level 99']);
  });

  it('BITES (A1/EG1-12): no path view-model leaks pathId — it is a DB-internal store key', () => {
    // RED-TEAM ADDITION (contract §B: "DB-internal key ONLY — the store map key (A1).
    // NEVER read by a model or a view-model (EG1-12)"; §C freezes EvolutionPathViewModel
    // to exactly {edgeId, toSpecies, toSpeciesName, met, unmetReason, gates}).
    //
    // Kills: `{ ...path, toSpeciesName, met, ... }` — a spread-the-store-row view-model.
    // It is the shortest way to write the builder and it passes EVERY other assertion in
    // this file. But pathId is RE-MINTED on every content republish (sync_content), so any
    // view or callback that grows to key off it — a picker's `data-path-id`, a selection
    // that survives a refresh — silently retargets after the next publish. Forbidding the
    // field at the boundary is what stops that from ever becoming reachable.
    const mon = vmFor(monster({ speciesId: 1, level: 30 }), [
      evoPath({ pathId: 777n, edgeId: 1, toSpecies: 2, minLevel: 20 }),
      evoPath({ pathId: 888n, edgeId: 2, toSpecies: 3, minLevel: 99 }),
    ]);
    expect(mon.paths, 'precondition: both outgoing edges are present').toHaveLength(2);
    for (const p of mon.paths) {
      const keys = Object.keys(p);
      expect(keys, 'EvolutionPathViewModel must not carry pathId').not.toContain('pathId');
      expect(keys, 'nor fromSpecies — the panel is already scoped to this monster') //
        .not.toContain('fromSpecies');
      expect(keys, 'nor the raw thresholds — gates[] is the rendered surface') //
        .not.toContain('minLevel');
      // Positive frame: the six contracted fields ARE all present, so the negatives above
      // cannot be satisfied by an empty or degenerate object.
      for (const field of ['edgeId', 'toSpecies', 'toSpeciesName', 'met', 'unmetReason', 'gates']) {
        expect(keys, `EvolutionPathViewModel must carry ${field}`).toContain(field);
      }
    }
  });

  it('BITES: each path view-model carries its own gate rows (the progress half)', () => {
    // Kills: dropping `gates` from EvolutionPathViewModel, which reduces EG4-1's
    // "requirements/PROGRESS panel" to a bare yes/no.
    const mon = vmFor(monster({ speciesId: 1, level: 17 }), [
      { ...FULL_PATH, edgeId: 1, fromSpecies: 1, toSpecies: 2 },
    ]);
    const p: EvolutionPathViewModel = mon.paths[0] as EvolutionPathViewModel;
    expect(p.gates.map((g) => g.kind)).toEqual([
      'level',
      'essence',
      'trust',
      'qualityTime',
      'nutrition',
    ]);
    expect(p.gates[0]!.currentText).toContain('17');
  });
});

// ===========================================================================
// EG4-2 (A3) · readyPathName — informational, non-null IFF eligibleCount === 1
// ===========================================================================

describe('EG4-2 (A3) readyPathName: non-null IFF exactly one path is eligible', () => {
  it('BITES: exactly 1 eligible → readyPathName names THAT path (and choices stay empty)', () => {
    // Kills: rendering the 1-eligible state identically to the 0-eligible one. A monster
    // can sit at exactly-1-eligible indefinitely (content republish adds an edge; boxed
    // monsters; enqueue_move's QT-tick gate), so "nothing at all" is a wrong readout.
    const mon = vmFor(monster({ speciesId: 1, level: 30 }), [
      evoPath({ edgeId: 1, toSpecies: 2, minLevel: 20 }), // eligible → Pyrodrake
      evoPath({ edgeId: 2, toSpecies: 3, minLevel: 99 }), // blocked
    ]);
    expect(mon.eligibleCount).toBe(1);
    expect(mon.readyPathName).toBe('Pyrodrake');
    expect(mon.readyPathName).not.toBe('Cindermaw');
    expect(mon.choices).toEqual([]);
  });

  it('BITES: 0 eligible → readyPathName is null', () => {
    // Kills: a readyPathName that falls back to the first (blocked) path's name.
    const mon = vmFor(monster({ speciesId: 1, level: 5 }), [
      evoPath({ edgeId: 1, toSpecies: 2, minLevel: 20 }),
    ]);
    expect(mon.eligibleCount).toBe(0);
    expect(mon.readyPathName).toBeNull();
  });

  it('BITES: 2 eligible → readyPathName is null (the choice list is the surface, not this)', () => {
    // Kills: `eligibleCount >= 1` on readyPathName, which would render "Ready — evolves on
    // your next action" for the ambiguous case that will NEVER auto-resolve (EG2-11).
    const mon = vmFor(monster({ speciesId: 1, level: 30 }), [
      evoPath({ edgeId: 1, toSpecies: 2, minLevel: 20 }),
      evoPath({ edgeId: 2, toSpecies: 3, minLevel: 20 }),
    ]);
    expect(mon.eligibleCount).toBe(2);
    expect(mon.readyPathName).toBeNull();
  });

  it('BITES: no outgoing edges at all → readyPathName null, choices empty, paths empty', () => {
    const mon = vmFor(monster({ speciesId: 1 }), []);
    expect(mon.paths).toEqual([]);
    expect(mon.choices).toEqual([]);
    expect(mon.eligibleCount).toBe(0);
    expect(mon.readyPathName).toBeNull();
  });
});

// ===========================================================================
// EG4-6 (NAMED PROOF-OF-TEETH) · the three derived tiers are GATED, not just copied
// ===========================================================================

describe('EG4-6 PROOF-OF-TEETH: trust / quality-time / nutrition are differential, not pass-through', () => {
  it('BITES: two monsters differing ONLY in trustTier — one eligible, one not', () => {
    // Kills: a panel that renders only level+essence and merely COPIES the three tier
    // scalars onto the view-model. Such an impl passes any "the scalar is on the VM"
    // assertion while ignoring the trust gate entirely — both monsters below would come
    // back eligible. Everything except trustTier is identical here, so the ONLY thing
    // that can produce the differing verdicts is the trust gate actually running.
    const p = evoPath({ edgeId: 1, toSpecies: 2, minTrustTier: 'Friendly' });
    const base = { speciesId: 1, level: 50, qualityTimeTier: 4, nutritionPct: 100 } as const;
    const hi = vmFor(monster({ ...base, trustTier: 'Devoted' }), [p]);
    const lo = vmFor(monster({ ...base, trustTier: 'Wary' }), [p]);
    expect(hi.eligibleCount).toBe(1);
    expect(lo.eligibleCount).toBe(0);
    expect(lo.paths[0]!.unmetReason).toBe('requires trust tier Friendly');
    // ...and the gate row exists on BOTH, carrying each monster's CURRENT value.
    const hiTrust = hi.paths[0]!.gates.find((g) => g.kind === 'trust');
    const loTrust = lo.paths[0]!.gates.find((g) => g.kind === 'trust');
    expect(hiTrust, 'a trust gate row must be present').toBeDefined();
    expect(loTrust, 'a trust gate row must be present').toBeDefined();
    expect(hiTrust!.currentText).toContain('Devoted');
    expect(loTrust!.currentText).toContain('Wary');
    expect(hiTrust!.requiredText).toContain('Friendly');
    expect(hiTrust!.met).toBe(true);
    expect(loTrust!.met).toBe(false);
  });

  it('BITES: two monsters differing ONLY in qualityTimeTier — one eligible, one not', () => {
    // Kills: the same pass-through impl, on the quality-time axis.
    const p = evoPath({ edgeId: 1, toSpecies: 2, minQualityTimeTier: 3 });
    const base = { speciesId: 1, level: 50, trustTier: 'Devoted', nutritionPct: 100 } as const;
    const hi = vmFor(monster({ ...base, qualityTimeTier: 4 }), [p]);
    const lo = vmFor(monster({ ...base, qualityTimeTier: 1 }), [p]);
    expect(hi.eligibleCount).toBe(1);
    expect(lo.eligibleCount).toBe(0);
    expect(lo.paths[0]!.unmetReason).toBe('requires quality time tier 3');
    const hiQt = hi.paths[0]!.gates.find((g) => g.kind === 'qualityTime');
    const loQt = lo.paths[0]!.gates.find((g) => g.kind === 'qualityTime');
    expect(hiQt, 'a qualityTime gate row must be present').toBeDefined();
    expect(loQt, 'a qualityTime gate row must be present').toBeDefined();
    expect(hiQt!.currentText).toContain('4');
    expect(loQt!.currentText).toContain('1');
    expect(hiQt!.requiredText).toContain('3');
    expect(hiQt!.met).toBe(true);
    expect(loQt!.met).toBe(false);
  });

  it('BITES: two monsters differing ONLY in nutritionPct — one eligible, one not', () => {
    // Kills: the same pass-through impl, on the nutrition axis.
    const p = evoPath({ edgeId: 1, toSpecies: 2, minNutritionPct: 60 });
    const base = { speciesId: 1, level: 50, trustTier: 'Devoted', qualityTimeTier: 4 } as const;
    const hi = vmFor(monster({ ...base, nutritionPct: 88 }), [p]);
    const lo = vmFor(monster({ ...base, nutritionPct: 41 }), [p]);
    expect(hi.eligibleCount).toBe(1);
    expect(lo.eligibleCount).toBe(0);
    expect(lo.paths[0]!.unmetReason).toBe('requires nutrition 60%');
    const hiNut = hi.paths[0]!.gates.find((g) => g.kind === 'nutrition');
    const loNut = lo.paths[0]!.gates.find((g) => g.kind === 'nutrition');
    expect(hiNut, 'a nutrition gate row must be present').toBeDefined();
    expect(loNut, 'a nutrition gate row must be present').toBeDefined();
    expect(hiNut!.currentText).toContain('88');
    expect(loNut!.currentText).toContain('41');
    expect(hiNut!.requiredText).toContain('60');
    expect(hiNut!.met).toBe(true);
    expect(loNut!.met).toBe(false);
  });

  it('BITES: the equality (=== threshold) case is ELIGIBLE on each of the three history gates', () => {
    // Kills: `>` on any of the three (the boundary group above pins pathSatisfied; this
    // pins the same boundary through the VIEW-MODEL, which is what the panel renders).
    const trustP = evoPath({ edgeId: 1, toSpecies: 2, minTrustTier: 'Neutral' });
    const qtP = evoPath({ edgeId: 1, toSpecies: 2, minQualityTimeTier: 2 });
    const nutP = evoPath({ edgeId: 1, toSpecies: 2, minNutritionPct: 45 });
    expect(vmFor(monster({ speciesId: 1, trustTier: 'Neutral' }), [trustP]).eligibleCount).toBe(1);
    expect(vmFor(monster({ speciesId: 1, qualityTimeTier: 2 }), [qtP]).eligibleCount).toBe(1);
    expect(vmFor(monster({ speciesId: 1, nutritionPct: 45 }), [nutP]).eligibleCount).toBe(1);
  });

  it('BITES: the three derived tiers are ALSO surfaced verbatim on the monster view-model', () => {
    // EG4-6's literal wording ("surfaces all three tier-derivation outputs"). This is the
    // WEAK half on its own — it is passable by an impl that ignores all three gates —
    // which is exactly why the four differential cases above exist. Kept because the
    // panel header renders these three, and a re-derivation (rather than a verbatim copy
    // of the server-computed value) would be a second source of truth.
    const mon = vmFor(
      monster({
        speciesId: 1,
        nickname: 'Blaze',
        level: 37,
        tier: 2,
        trustTier: 'Hostile',
        qualityTimeTier: 1,
        nutritionPct: 41,
      }),
      [],
    );
    expect(mon.trustTier).toBe('Hostile');
    expect(mon.qualityTimeTier).toBe(1);
    expect(mon.nutritionPct).toBe(41);
    expect(mon.tier).toBe(2);
    expect(mon.level).toBe(37);
    expect(mon.nickname).toBe('Blaze');
    expect(mon.speciesName).toBe('Flameling');
    expect(mon.monsterId).toBe(1n);
    expect(typeof mon.monsterId).toBe('bigint');
  });
});

// ===========================================================================
// EG4-5 · FUSION IS GONE
// ===========================================================================

describe('EG4-5: no fusion surface survives on the evolution view-model', () => {
  it('BITES: EvolutionViewModel has NO fusionRecipes key — only `monsters`', () => {
    // Kills: a partial deletion that leaves `fusionRecipes: []` behind as dead wiring,
    // which would keep evolutionView's recipe-list renderer alive and compiling.
    const vm: EvolutionViewModel = buildEvolutionViewModel([], SPECIES_MAP, []);
    expect(Object.keys(vm)).toEqual(['monsters']);
    expect(Object.keys(vm)).not.toContain('fusionRecipes');
  });

  it('BITES: the fusion key stays absent with real monsters and real paths, too', () => {
    // Kills: a conditional that only omits fusionRecipes on the empty input.
    const vm = buildEvolutionViewModel([monster({ speciesId: 1 })], SPECIES_MAP, [evoPath({})]);
    expect(Object.keys(vm)).toEqual(['monsters']);
  });
});

// ===========================================================================
// TOTALITY — a throw in a model starves sibling store batch-listeners
// ===========================================================================

describe('EG4-1 totality: the model never throws', () => {
  it('BITES: empty monsters + empty paths → { monsters: [] }, no throw', () => {
    // Kills: any guard that throws on empty input. store.ts's flushBatch has NO
    // per-listener isolation — one throw kills every other overlay's refresh.
    let vm: EvolutionViewModel | undefined;
    expect(() => {
      vm = buildEvolutionViewModel([], SPECIES_MAP, []);
    }).not.toThrow();
    expect(vm).toEqual({ monsters: [] });
  });

  it('BITES: an empty paths list yields a monster with no paths, not a crash', () => {
    // Reached on EVERY fresh connect: main.ts's refreshEvolution runs before the
    // evolution_path subscription has applied, so `[...store.evolutionPaths()]` is `[]`.
    // Kills: an impl that assumes at least one edge (e.g. `paths[0]` for readyPathName).
    let vm: EvolutionViewModel | undefined;
    expect(() => {
      vm = buildEvolutionViewModel([monster({ speciesId: 1 })], SPECIES_MAP, []);
    }).not.toThrow();
    expect(vm!.monsters[0]!.paths).toEqual([]);
    expect(vm!.monsters[0]!.choices).toEqual([]);
    expect(vm!.monsters[0]!.eligibleCount).toBe(0);
    expect(vm!.monsters[0]!.readyPathName).toBeNull();
  });

  it('BITES: an unknown species id falls back to "Unknown (#N)" rather than throwing', () => {
    // Kills: a Map-miss throw. Species rows and monster rows arrive in separate batches,
    // so this state is reached on every fresh connect.
    const vm = buildEvolutionViewModel([monster({ speciesId: 777 })], new Map(), [
      evoPath({ fromSpecies: 777, toSpecies: 888 }),
    ]);
    expect(vm.monsters[0]!.speciesName).toBe('Unknown (#777)');
    expect(vm.monsters[0]!.paths[0]!.toSpeciesName).toBe('Unknown (#888)');
  });

  it('BITES: zero amounts, zero level, zero ids, empty nickname → no throw', () => {
    // Kills: falsy-coercion guards (`||`) on genuinely-zero values — the SDK decodes
    // `Some(0)` as `0`, so 0 is a real, reachable value everywhere here.
    expect(() => {
      buildEvolutionViewModel(
        [monster({ monsterId: 0n, level: 0, nickname: '', tier: 0, nutritionPct: 0 })],
        new Map(),
        [
          evoPath({
            pathId: 0n,
            edgeId: 0,
            fromSpecies: 1,
            toSpecies: 0,
            minLevel: 0,
            essence: [{ affinity: 'Dark', amount: 0 }],
            minQualityTimeTier: 0,
            minNutritionPct: 0,
          }),
        ],
      );
    }).not.toThrow();
  });

  it('BITES fast-check: never throws across arbitrary monster/path combinations', () => {
    // Kills: any crash on a structurally-valid but unusual combination. Deterministic:
    // fast-check seeds its own RNG; no clock, no wasm, no DB.
    const trustArb = fc.constantFrom<TrustTierName>(...TRUST_TIER_ORDER);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 0, max: 999 }),
        trustArb,
        trustArb,
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 0, max: 120 }),
        (level, fireEssence, monsterTrust, threshold, qtTier, nutrition, minLevel) => {
          const m = monster({
            speciesId: 1,
            level,
            essence: essence({ Fire: fireEssence }),
            trustTier: monsterTrust,
            qualityTimeTier: qtTier,
            nutritionPct: nutrition,
          });
          const p = evoPath({
            minLevel,
            essence: [{ affinity: 'Fire', amount: fireEssence }],
            minTrustTier: threshold,
            minQualityTimeTier: qtTier,
            minNutritionPct: nutrition,
          });
          expect(() => pathRequirements(m, p)).not.toThrow();
          expect(() => pathSatisfied(m, p)).not.toThrow();
          expect(() => unmetRequirement(m, p)).not.toThrow();
          expect(() => buildEvolutionViewModel([m], SPECIES_MAP, [p])).not.toThrow();
        },
      ),
    );
  });

  it('BITES fast-check: unmetRequirement is null EXACTLY when pathSatisfied is true', () => {
    // Kills: any drift between the two derived outputs of the ONE gate walk (contract A5).
    // A path shown as blocked with no reason — or as ready while unmetRequirement names a
    // gate — is a panel that contradicts itself.
    const trustArb = fc.constantFrom<TrustTierName>(...TRUST_TIER_ORDER);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 105 }),
        fc.integer({ min: 0, max: 105 }),
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 0, max: 300 }),
        trustArb,
        trustArb,
        (level, minLevel, have, need, monsterTrust, threshold) => {
          const m = monster({
            speciesId: 1,
            level,
            essence: essence({ Plant: have }),
            trustTier: monsterTrust,
          });
          const p = evoPath({
            minLevel,
            essence: [{ affinity: 'Plant', amount: need }],
            minTrustTier: threshold,
          });
          expect(unmetRequirement(m, p) === null).toBe(pathSatisfied(m, p));
        },
      ),
    );
  });

  it('BITES: 30 monsters x 4 paths — output order mirrors input order, no throw', () => {
    // Kills: sorting or deduping the MONSTER list (only the path list is sorted, A9).
    const monsters = Array.from({ length: 30 }, (_, i) =>
      monster({ monsterId: BigInt(100 - i), speciesId: (i % 3) + 1, level: i }),
    );
    const paths = [
      evoPath({ edgeId: 1, fromSpecies: 1, toSpecies: 2, minLevel: 10 }),
      evoPath({ edgeId: 2, fromSpecies: 1, toSpecies: 3, minLevel: 20 }),
      evoPath({ edgeId: 3, fromSpecies: 2, toSpecies: 4, minLevel: 5 }),
      evoPath({ edgeId: 4, fromSpecies: 3, toSpecies: 9, minLevel: 1 }),
    ];
    let vm: EvolutionViewModel | undefined;
    expect(() => {
      vm = buildEvolutionViewModel(monsters, SPECIES_MAP, paths);
    }).not.toThrow();
    expect(vm!.monsters.map((m) => m.monsterId)).toEqual(monsters.map((m) => m.monsterId));
  });
});
