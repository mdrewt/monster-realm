// tactics/forecast.parity.test.ts — bt-11 gating tests for the forecast export (BT11.7: "a vitest SHALL
// assert the forecast output equals the golden fixture"): `rules.forecast(attacker, target, skillId,
// flank)` through the BUILT client-wasm pkg, against the shared fixture's `Pipeline` cases and
// against game-core's own `damage_pipeline` (the `tactics_golden` Pipeline kind) on generated units.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-battle-tactics.spec.md BT11.7 (design §2.4 / §9.3) and
// the bt-11 plan (memory/projects/monster-realm-bt-11-plan.md) §4.1 as amended by REV 2 A8 / A14 /
// A15:
//   - hit_pct = the count of rolls r in 0..100 that hit (`accuracy_check` = `roll < accuracy`,
//     combat/damage.rs:97); the first hitting roll is the forecast's accuracy roll;
//   - min = damage_pipeline at (first hitting roll, variance 85), max = the same at variance 100;
//     when no roll hits, both are the pipeline at (99, 100), a miss;
//   - stab = skill.affinity == attacker.kit.affinity; guard = target.guard;
//     effectiveness = min.effectiveness; kills_* = trace.hit && trace.hp_after == 0;
//     first_stand_saves = min.stood_ground || max.stood_ground; status = skill.applies_status;
//     status_blocked = target.status != null || effectiveness == Immune (resolve.rs:674-675);
//     flank_factor / guard_factor = the tuning's (num, den) (tuning.rs:121-124: 5/4 and 3/4);
//   - a unit failing `validate_unit` is a THROWN error carrying the golden BadCase class text
//     `invalid unit`; the adapter resolves `skillId` from the attacker's kit and throws when absent.
//
// THE FIXTURE (game-core/tests/fixtures/tactics_golden.json lines 265-277): 13 Pipeline cases — 4
// BadCase (invalid units), 1 miss (accuracy 90, roll 90), 2 at variance 85, 5 at variance 100, 1 at
// variance 92. A forecast always uses the FIRST hitting roll, and a hit trace does not depend on
// which hitting roll it was (resolve.rs:521 reads the roll only for the hit test), so a fixture
// trace at variance 85 IS the forecast's min and one at variance 100 IS its max. The fixture
// attackers carry `skills: []`; each case's skill is put into the attacker's kit before the call
// (damage_pipeline never reads kit.skills).
//
// HOW THE TESTS ARE PROVEN: written red against the API-freeze stubs (`bindTacticsRules` threw `bt-11:
// not implemented`, `forecast_of` returned `Err`), now green against the implementation; their
// bite is the WRONG IMPL KILLED note of each test. (The ForecastOut fields asserted here are the
// rules' facts; A18's "no status on a KO" is a view-model rule, pinned in forecast.test.ts.)
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadWasmPkg } from '../../test-util/wasmPkg';
import {
  bindTacticsRules,
  type ForecastOut,
  type PipelineTrace,
  type RuleAffinity,
  type RuleStatBlock,
  type RuleStatusEffect,
  type RuleStatusKind,
  type RulesUnit,
  type SkillTactics,
  type TacticsRules,
  type TacticsWasmExports,
} from './wasm';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../game-core/tests/fixtures/tactics_golden.json',
);

interface GoldenFixture {
  readonly cases: readonly unknown[];
  readonly expected: readonly unknown[];
}

/** The fixture's `Pipeline` case payload (golden.rs:123-129). */
interface PipelineInput {
  readonly attacker: RulesUnit;
  readonly target: RulesUnit;
  readonly skill: SkillTactics;
  readonly flank: boolean;
  readonly rolls: { readonly accuracy: number; readonly variance: number };
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFixture;

/** Every Pipeline case of the fixture with its expected result, in fixture order. */
const PIPELINES: readonly { readonly input: PipelineInput; readonly expected: unknown }[] =
  fixture.cases.flatMap((c, i) => {
    const o = c as Record<string, unknown>;
    return 'Pipeline' in o
      ? [{ input: o.Pipeline as PipelineInput, expected: fixture.expected[i] }]
      : [];
  });

type Klass = 'bad' | 'miss' | 'min' | 'max' | 'between';

function klassOf(p: { readonly input: PipelineInput; readonly expected: unknown }): Klass {
  const e = p.expected as Record<string, unknown>;
  if ('BadCase' in e) return 'bad';
  if (!(e.Pipeline as PipelineTrace).hit) return 'miss';
  if (p.input.rolls.variance === 85) return 'min';
  if (p.input.rolls.variance === 100) return 'max';
  return 'between';
}

function fixtureTrace(p: { readonly expected: unknown }): PipelineTrace {
  return (p.expected as { readonly Pipeline: PipelineTrace }).Pipeline;
}

let pkg: Record<string, unknown> | undefined;
let bound: TacticsRules | undefined;

beforeAll(async () => {
  pkg = await loadWasmPkg();
});

function realPkg(): Record<string, unknown> {
  if (pkg === undefined) throw new Error('the client-wasm pkg did not load — run `just wasm`');
  return pkg;
}

function rules(): TacticsRules {
  bound ??= bindTacticsRules(realPkg() as unknown as TacticsWasmExports);
  return bound;
}

/** Compact JSON with object keys sorted recursively — the byte-identity form. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const body = Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(v);
}

/** game-core's `damage_pipeline` through the golden harness of the same wasm build. */
function pipelines(inputs: readonly PipelineInput[]): PipelineTrace[] {
  const fn = realPkg().tactics_golden;
  if (typeof fn !== 'function') {
    throw new Error('client-wasm exports no tactics_golden() — the pkg is stale, run `just wasm`');
  }
  const out = (fn as (cs: readonly unknown[]) => unknown)(inputs.map((p) => ({ Pipeline: p })));
  if (!Array.isArray(out) || out.length !== inputs.length) {
    throw new Error('tactics_golden returns one result per case');
  }
  return out.map((r) => {
    if (r === null || typeof r !== 'object' || !('Pipeline' in r)) {
      throw new Error(`golden: expected a Pipeline result, got ${canon(r)}`);
    }
    return (r as { readonly Pipeline: PipelineTrace }).Pipeline;
  });
}

const pipeline = (input: PipelineInput): PipelineTrace => pipelines([input])[0];

function withSkill(u: RulesUnit, skill: SkillTactics): RulesUnit {
  return { ...u, kit: { ...u.kit, skills: [skill] } };
}

/** The forecast of a Pipeline case: its skill put into the attacker's kit, resolved by id. */
function forecastOf(p: PipelineInput): ForecastOut {
  return rules().forecast(withSkill(p.attacker, p.skill), p.target, p.skill.skill_id, p.flank);
}

/** Plan A15: refused (thrown, not a wasm trap), the message naming the problem. */
function rejects(label: string, call: () => unknown, needle: string): void {
  let threw = false;
  let caught: unknown;
  try {
    call();
  } catch (err) {
    threw = true;
    caught = err;
  }
  expect(threw, `${label}: throws (the forecast never silently clamps)`).toBe(true);
  expect(
    caught instanceof WebAssembly.RuntimeError,
    `${label}: a refused input, not a wasm trap (${String(caught)})`,
  ).toBe(false);
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(message, `${label}: the message`).toContain(needle);
}

function caseOf(klass: Klass, pick: (p: PipelineInput) => boolean = () => true) {
  const found = PIPELINES.find((p) => klassOf(p) === klass && pick(p.input));
  if (found === undefined) throw new Error(`fixture: no ${klass} Pipeline case`);
  return found;
}

/** Fixture line 266: Fire L5 A40 -> Plant D40 at 30/100 HP, Fire power 40 accuracy 100 (valid units). */
const goodCase = () => caseOf('max', (p) => p.target.cur_hp === 30);

describe('forecast parity: the fixture Pipeline cases (BT11.7)', () => {
  it('BT11-7-FORECAST-FIXTURE: over the 13 fixture Pipeline cases the 4 invalid-unit inputs are refused and the 7 comparable cases match — variance 85 is the forecast min, variance 100 its max', () => {
    // WRONG IMPL KILLED: a min at variance 79 / 80 or a max at 99; the traces swapped; a forecast
    // that clamps an invalid unit (0 HP, HP over max, 0 defense) instead of refusing it, or panics
    // on it; a pipeline re-implemented in the shell (any rounding drift shows on these known
    // answers: flank before Guard, the floor of 1, First-Stand at 14 into 14 and 12 into 12).
    expect(PIPELINES, 'the fixture carries 13 Pipeline cases').toHaveLength(13);
    const counts: Record<Klass, number> = { bad: 0, miss: 0, min: 0, max: 0, between: 0 };
    for (const p of PIPELINES) counts[klassOf(p)] += 1;
    expect(counts, 'pinned: 4 bad, 1 miss, 2 at variance 85, 5 at variance 100, 1 between').toEqual(
      { bad: 4, miss: 1, min: 2, max: 5, between: 1 },
    );
    let compared = 0;
    let refused = 0;
    PIPELINES.forEach((p, i) => {
      const k = klassOf(p);
      const label = `Pipeline #${i} (${k})`;
      if (k === 'bad') {
        rejects(label, () => forecastOf(p.input), 'invalid unit');
        refused += 1;
        return;
      }
      if (k !== 'min' && k !== 'max') return;
      const f = forecastOf(p.input);
      const want = canon(fixtureTrace(p));
      if (k === 'min') {
        expect(canon(f.min), `${label}: min == the fixture trace at variance 85`).toBe(want);
      } else {
        expect(canon(f.max), `${label}: max == the fixture trace at variance 100`).toBe(want);
      }
      // Every comparable case hits at roll 0 with accuracy <= 100: r < accuracy for `accuracy` rolls.
      expect(f.hit_pct, `${label}: hit_pct`).toBe(Math.min(p.input.skill.accuracy, 100));
      compared += 1;
    });
    expect([compared, refused], 'the 7 comparable cases and the 4 refusals ran').toEqual([7, 4]);
    const good = goodCase();
    expect(
      canon(forecastOf(good.input).max),
      'after the refusals the instance still forecasts',
    ).toBe(canon(fixtureTrace(good)));
  });

  it('BT11-7-FORECAST-BETWEEN: the variance-92 trace lies between the forecast min and max; the fixture miss (accuracy 90, roll 90) is forecast as a 90 % HIT at the first hitting roll; accuracy 0 forecasts two miss traces at 0 %', () => {
    // WRONG IMPL KILLED: the forecast rolled at the fixture's own accuracy roll (the miss case would
    // forecast a miss); hit_pct = 100 or 91 for accuracy 90 (`<=`); min > max (variance reversed);
    // an accuracy-0 forecast at a hitting roll, or with a nonzero hit_pct, an effectiveness or a
    // kill flag.
    const between = caseOf('between');
    const t = fixtureTrace(between);
    const f = forecastOf(between.input);
    expect([f.min.hit, f.max.hit], 'accuracy 95: the forecast hits').toEqual([true, true]);
    expect(
      f.min.d3 <= t.d3 && t.d3 <= f.max.d3,
      `variance 92: min.d3 ${f.min.d3} <= ${t.d3} <= max.d3 ${f.max.d3}`,
    ).toBe(true);
    expect(f.min.d3 < f.max.d3, 'the range is not a point').toBe(true);
    expect(canon(f.min), 'min = the pipeline at (0, 85)').toBe(
      canon(pipeline({ ...between.input, rolls: { accuracy: 0, variance: 85 } })),
    );
    expect(canon(f.max), 'max = the pipeline at (0, 100)').toBe(
      canon(pipeline({ ...between.input, rolls: { accuracy: 0, variance: 100 } })),
    );
    expect(f.hit_pct, 'accuracy 95').toBe(95);

    const miss = caseOf('miss');
    expect(
      [miss.input.skill.accuracy, miss.input.rolls.accuracy, fixtureTrace(miss).hit],
      'the fixture miss case',
    ).toEqual([90, 90, false]);
    const fm = forecastOf(miss.input);
    expect(fm.hit_pct, 'accuracy 90: rolls 0..89 hit').toBe(90);
    expect(fm.min.hit, 'the forecast uses the first HITTING roll, not the fixture roll').toBe(true);
    expect(canon(fm.min) === canon(fixtureTrace(miss)), 'so it is not the fixture miss trace').toBe(
      false,
    );
    expect(canon(fm.min), 'min = the pipeline at (0, 85)').toBe(
      canon(pipeline({ ...miss.input, rolls: { accuracy: 0, variance: 85 } })),
    );
    expect(canon(fm.max), 'max = the pipeline at (0, 100)').toBe(
      canon(pipeline({ ...miss.input, rolls: { accuracy: 0, variance: 100 } })),
    );

    const good = goodCase().input;
    const zero: PipelineInput = { ...good, skill: { ...good.skill, accuracy: 0 } };
    const missTrace = pipeline({ ...zero, rolls: { accuracy: 99, variance: 100 } });
    expect(missTrace.hit, 'golden: accuracy 0 never hits').toBe(false);
    const fz = forecastOf(zero);
    expect(canon(fz.min), 'accuracy 0: min is the miss trace').toBe(canon(missTrace));
    expect(canon(fz.max), 'accuracy 0: max is the miss trace').toBe(canon(missTrace));
    expect(fz.min, 'a miss: zeros, the target untouched').toStrictEqual({
      hit: false,
      d0: 0,
      d1: 0,
      d2: 0,
      d3: 0,
      effectiveness: null,
      applied: 0,
      hp_after: 30,
      stood_ground: false,
    });
    expect(
      [fz.hit_pct, fz.effectiveness, fz.kills_min, fz.kills_max, fz.first_stand_saves],
      'accuracy 0: 0 %, no effectiveness, no kill, no save',
    ).toEqual([0, null, false, false, false]);
  });

  it('BT11-7-FORECAST-BAD: a 0-HP target, a Fainted target, a target over its max HP and a 0-defense attacker are refused (never clamped); a skill outside the attacker kit is refused by the adapter', () => {
    // WRONG IMPL KILLED: cur_hp clamped into 1..max; defense clamped to 1; the trap of a divide by
    // zero passed off as a refusal; validate_unit skipped for the attacker; the adapter defaulting
    // to the first kit skill (or sending the id to wasm) for an unknown skill id.
    const good = goodCase().input;
    const variants: readonly (readonly [string, PipelineInput])[] = [
      ['a target at 0 HP', { ...good, target: { ...good.target, cur_hp: 0 } }],
      ['a Fainted target', { ...good, target: { ...good.target, state: 'Fainted', cur_hp: 0 } }],
      ['a target over its max HP', { ...good, target: { ...good.target, cur_hp: 101 } }],
      [
        'an attacker with 0 defense',
        {
          ...good,
          attacker: {
            ...good.attacker,
            kit: { ...good.attacker.kit, stats: { ...good.attacker.kit.stats, defense: 0 } },
          },
        },
      ],
      [
        'a target with 0 defense',
        {
          ...good,
          target: {
            ...good.target,
            kit: { ...good.target.kit, stats: { ...good.target.kit.stats, defense: 0 } },
          },
        },
      ],
    ];
    for (const [label, input] of variants) {
      rejects(label, () => forecastOf(input), 'invalid unit');
    }
    rejects(
      'skill 77 outside the attacker kit',
      () => rules().forecast(withSkill(good.attacker, good.skill), good.target, 77, false),
      '77',
    );
    expect(
      canon(forecastOf(good).max),
      'a later valid forecast still answers (the fixture trace)',
    ).toBe(canon(fixtureTrace(goodCase())));
  });
});

// --- the generated sweep (A14) ----------------------------------------------------------------------

const AFFINITIES: readonly RuleAffinity[] = [
  'Fire',
  'Water',
  'Plant',
  'Electric',
  'Earth',
  'Wind',
  'Light',
  'Dark',
];
const STATUSES: readonly (RuleStatusEffect | null)[] = [
  null,
  'Poison',
  'Burn',
  'Paralysis',
  { Sleep: { turns_remaining: 2 } },
  'Freeze',
];
const APPLIES: readonly (RuleStatusKind | null)[] = [
  null,
  'Poison',
  'Burn',
  'Paralysis',
  'Sleep',
  'Freeze',
];
const MELEE = {
  range_min: 1,
  range_max: 1,
  origin: 'TargetUnit',
  shape: 'Single',
  radius: 0,
  ff_filter: 'Enemies',
} as const;

interface FighterSpec {
  readonly id: number;
  readonly side: 'A' | 'B';
  readonly affinity: RuleAffinity;
  readonly level: number;
  readonly stats: RuleStatBlock;
  readonly curHp: number;
  readonly status: RuleStatusEffect | null;
  readonly guard: boolean;
  readonly firstStand: boolean;
  readonly skills: readonly SkillTactics[];
}

function fighter(o: FighterSpec): RulesUnit {
  return {
    id: o.id,
    side: o.side,
    slot: 0,
    kit: {
      species_id: o.id,
      affinity: o.affinity,
      level: o.level,
      stats: o.stats,
      base_speed: 50,
      class: 'Walk',
      skills: o.skills,
    },
    pos: { x: o.side === 'A' ? 0 : 1, y: 0 },
    cur_hp: o.curHp,
    status: o.status,
    budget: { ap: 0, strides_used: 0, attacks: 0, last: null },
    guard: o.guard,
    first_stand: o.firstStand,
    state: 'Active',
  };
}

/**
 * Which of the 100 accuracy rolls hit at this accuracy, measured through the golden Pipeline at
 * (r, 100) on the fixture's valid case (the hit test reads only skill.accuracy and the roll,
 * resolve.rs:521, so one probe pair serves every generated unit). Memoised per accuracy.
 */
const HITS = new Map<number, { readonly count: number; readonly first: number | null }>();
function hitsAt(accuracy: number): { readonly count: number; readonly first: number | null } {
  const memo = HITS.get(accuracy);
  if (memo !== undefined) return memo;
  const base = goodCase().input;
  const traces = pipelines(
    Array.from({ length: 100 }, (_, r) => ({
      ...base,
      skill: { ...base.skill, accuracy },
      rolls: { accuracy: r, variance: 100 },
    })),
  );
  const hitting = traces.flatMap((t, r) => (t.hit ? [r] : []));
  const out = { count: hitting.length, first: hitting.length > 0 ? hitting[0] : null };
  HITS.set(accuracy, out);
  return out;
}

describe('forecast parity: the generated sweep against damage_pipeline (BT11.7, A14)', () => {
  it('BT11-7-FORECAST-GOLDEN-CHAIN: for 200 seeded random attackers / targets / skills, min and max are the golden Pipeline at (first hitting roll, 85 / 100), hit_pct counts the hitting rolls, and every flag is read off those traces', () => {
    // WRONG IMPL KILLED: a table lookup (random stats and levels); variance 79 / 80 for the min;
    // a min / max rolled at the last or a fixed roll (a miss for accuracy < 100); hit_pct =
    // accuracy (101 and 255 must read 100); a hard-coded or inverted stab (mixed affinities);
    // kills_* ignoring First-Stand or the hit; first_stand_saves read from one trace; the status
    // shown though the target already has one; restated factors.
    let killsMin = 0;
    let saves = 0;
    let stabs = 0;
    let offStabs = 0;
    let misses = 0;
    let capped = 0;
    let blocked = 0;
    let free = 0;
    const effectivenesses = new Set<string>();
    const arb = fc.record({
      level: fc.integer({ min: 30, max: 100 }),
      attack: fc.integer({ min: 150, max: 255 }),
      defense: fc.integer({ min: 5, max: 40 }),
      power: fc.integer({ min: 150, max: 250 }),
      accuracy: fc.oneof(
        fc.constantFrom(0, 1, 50, 89, 90, 99, 100, 101, 255),
        fc.integer({ min: 0, max: 255 }),
      ),
      attackerAffinity: fc.constantFrom(...AFFINITIES),
      targetAffinity: fc.constantFrom(...AFFINITIES),
      sameAffinity: fc.boolean(),
      skillAffinity: fc.constantFrom(...AFFINITIES),
      maxHp: fc.integer({ min: 1, max: 65_535 }),
      hpPick: fc.integer({ min: 0, max: 4 }),
      basis: fc.constantFrom(85, 100),
      guard: fc.boolean(),
      flank: fc.boolean(),
      firstStand: fc.boolean(),
      status: fc.integer({ min: 0, max: STATUSES.length - 1 }),
      applies: fc.integer({ min: 0, max: APPLIES.length - 1 }),
      heavy: fc.boolean(),
    });
    fc.assert(
      fc.property(arb, (g) => {
        const skill: SkillTactics = {
          skill_id: 77,
          tier: g.heavy ? 'Heavy' : 'Light',
          affinity: g.sameAffinity ? g.attackerAffinity : g.skillAffinity,
          power: g.power,
          accuracy: g.accuracy,
          applies_status: APPLIES[g.applies],
          geometry: MELEE,
        };
        const attacker = fighter({
          id: 1,
          side: 'A',
          affinity: g.attackerAffinity,
          level: g.level,
          stats: {
            hp: 300,
            attack: g.attack,
            defense: 60,
            speed: 50,
            sp_attack: 50,
            sp_defense: 50,
          },
          curHp: 300,
          status: null,
          guard: false,
          firstStand: false,
          skills: [skill],
        });
        const atFull = fighter({
          id: 2,
          side: 'B',
          affinity: g.targetAffinity,
          level: 50,
          stats: {
            hp: g.maxHp,
            attack: 50,
            defense: g.defense,
            speed: 50,
            sp_attack: 50,
            sp_defense: 50,
          },
          curHp: g.maxHp,
          status: STATUSES[g.status],
          guard: g.guard,
          firstStand: g.firstStand,
          skills: [],
        });
        const hits = hitsAt(g.accuracy);
        const roll = hits.first ?? 99;
        // d3 does not depend on cur_hp (calc_damage reads stats and levels): probe it at full HP,
        // then put the target on either side of it.
        const d3 = pipeline({
          attacker,
          target: atFull,
          skill,
          flank: g.flank,
          rolls: { accuracy: roll, variance: g.basis },
        }).d3;
        const picks = [d3 - 1, d3, d3 + 1, 1, g.maxHp];
        const target: RulesUnit = {
          ...atFull,
          cur_hp: Math.min(Math.max(picks[g.hpPick], 1), g.maxHp),
        };
        const [min, max] = pipelines([
          { attacker, target, skill, flank: g.flank, rolls: { accuracy: roll, variance: 85 } },
          { attacker, target, skill, flank: g.flank, rolls: { accuracy: roll, variance: 100 } },
        ]);
        const f = rules().forecast(attacker, target, 77, g.flank);
        expect(canon(f.min), 'min = Pipeline(first hit, 85)').toBe(canon(min));
        expect(canon(f.max), 'max = Pipeline(first hit, 100)').toBe(canon(max));
        expect(f.hit_pct, `hit_pct at accuracy ${g.accuracy}`).toBe(hits.count);
        expect(f.stab, 'stab = skill affinity == attacker kit affinity').toBe(
          skill.affinity === attacker.kit.affinity,
        );
        expect([f.flank, f.guard], 'flank as asked, guard = target.guard').toEqual([
          g.flank,
          g.guard,
        ]);
        expect(f.effectiveness, 'effectiveness = min.effectiveness').toBe(min.effectiveness);
        expect(f.kills_min, 'kills_min').toBe(min.hit && min.hp_after === 0);
        expect(f.kills_max, 'kills_max').toBe(max.hit && max.hp_after === 0);
        expect(f.first_stand_saves, 'first_stand_saves').toBe(min.stood_ground || max.stood_ground);
        expect(f.status, 'status = the skill status').toBe(skill.applies_status);
        expect(f.status_blocked, 'status_blocked = a status already, or Immune').toBe(
          target.status !== null || min.effectiveness === 'Immune',
        );
        expect([f.flank_factor, f.guard_factor], 'the tuning factors').toEqual([
          [5, 4],
          [3, 4],
        ]);
        killsMin += Number(f.kills_min);
        saves += Number(f.first_stand_saves);
        stabs += Number(f.stab);
        offStabs += Number(!f.stab);
        misses += Number(!f.min.hit);
        capped += Number(g.accuracy > 100);
        blocked += Number(f.status_blocked);
        free += Number(!f.status_blocked);
        if (f.effectiveness !== null) effectivenesses.add(f.effectiveness);
      }),
      { seed: 20_261_101, numRuns: 200 },
    );
    // ANTI-VACUITY: the seeded runs exercised each branch the assertions distinguish (floors set
    // well under the expected counts for 200 runs; if an upgrade moves one below its floor,
    // re-measure and pick another seed — never lower a floor).
    for (const [name, n] of Object.entries({
      killsMin,
      saves,
      stabs,
      offStabs,
      misses,
      capped,
      blocked,
      free,
    })) {
      expect(n, `ANTI-VACUITY: ${name}`).toBeGreaterThanOrEqual(3);
    }
    expect(effectivenesses.size, 'ANTI-VACUITY: several type matchups').toBeGreaterThanOrEqual(2);
  });
});
