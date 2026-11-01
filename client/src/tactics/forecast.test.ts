// tactics/forecast.test.ts — bt-11 gating tests for the pure forecast view-model (BT11.7): which
// line items the panel shows (type, STAB, flank, Guard), the skull, the First-Stand marker, the
// status that may apply, and the numbers copied from the rules' `ForecastOut`.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-battle-tactics.spec.md BT11.7 (design §2.4 / §9.3) and
// the bt-11 plan (memory/projects/monster-realm-bt-11-plan.md) §4.4 as amended by REV 2 A13 and
// REV 3 A18:
//   - hits = f.min.hit; hitPct = f.hit_pct; min / max = f.min.d3 / f.max.d3 (the pipeline's d3,
//     never `applied`, which First-Stand clamps);
//   - lines in the order type, stab, flank, guard; the type line `{kind:'type', effectiveness}` only
//     when the effectiveness is not Neutral (the enum is combat/types.rs:200); `{kind:'stab'}`;
//     `{kind:'flank', num, den}` from `f.flank_factor`; `{kind:'guard', num, den}` from
//     `f.guard_factor`; NO lines on a miss; ONLY the type line on Immune;
//   - skull: kills_min → 'full', else kills_max → 'hollow', else 'none';
//   - firstStand = first_stand_saves; status = (status_blocked || kills_min) ? null : status (A18:
//     when every roll KOs, the resolver's `!ko` clause never lets a status land, resolve.rs:675);
//     the status does not depend on `hits` (it is the status the skill may apply ON a hit).
// The exported `forecastVM` is the contract: every call goes through it.
//
// HOW THE INPUTS ARE BUILT: hand-made `ForecastOut` values (pure, no wasm). Every number is a
// distinct prime and the d0..d3 of each trace differ, so a value copied from the wrong field
// (d0 or d2 instead of d3, the max trace for the min, the accuracy for the hit percent) is caught.
// Two factor pairs are used (5/4 + 3/4 and 7/3 + 2/9) so a label that hard-codes the design's
// numbers instead of reading `flank_factor` / `guard_factor` fails.
//
// HOW THE TESTS ARE PROVEN: written red against the API-freeze stub (`forecastVM` threw `bt-11: not
// implemented`), now green against the implementation; their bite is the WRONG IMPL KILLED note of
// each test (round-2 additions: v6c min/max read from `applied`; A18's KO clause; the status tied
// to `hits`). Do NOT edit these tests to match a buggy implementation; correct them from the spec
// only.
//
// bt-11 ROUND 4 (increment C; plan REV 5 A27 + REV 6 R6.4, NAMED INTENTIONAL CHANGE): the type line
// is `{kind: 'type', effectiveness, num, den}` with `[num, den]` COPIED from `f.type_factor` (the
// panel prints `forecast.typeTimes {num}` / `forecast.typeOver {num, den}` from it). Every
// type-line pin below gains the two fields; the fixtures carry distinct pairs per effectiveness (SuperEffective [2,1],
// NotVeryEffective [1,2], Immune [0,1]) and one row carries an unusual [3,2] so a view-model that
// maps the effectiveness to a factor table instead of copying the rules' pair fails. RED REASON
// (round 4): `forecastVM`'s type line carries no num / den yet.

import { describe, expect, it } from 'vitest';
import { type ForecastLine, forecastVM } from './forecast';
import type { ForecastOut, PipelineTrace, RuleEffectiveness } from './wasm';

/** Round 4: the rules' carried type multiplier per effectiveness (A27: over 10, reduced). */
const TYPE_FACTOR: Readonly<Record<RuleEffectiveness, readonly [number, number]>> = {
  SuperEffective: [2, 1],
  NotVeryEffective: [1, 2],
  Neutral: [1, 1],
  Immune: [0, 1],
};

/** The expected type line (built through a variable so it type-checks against either shape of
 *  `ForecastLine` while the round-4 field is being added). */
function typeLine(effectiveness: RuleEffectiveness, num: number, den: number): ForecastLine {
  const line = { kind: 'type' as const, effectiveness, num, den };
  return line;
}

/** A hit trace whose d0..d3 are all different (so `min` must be d3, not d0 / d1 / d2). */
function trace(o: Partial<PipelineTrace> = {}): PipelineTrace {
  return {
    hit: true,
    d0: 41,
    d1: 43,
    d2: 47,
    d3: 53,
    effectiveness: 'Neutral',
    applied: 53,
    hp_after: 59,
    stood_ground: false,
    ...o,
  };
}

/** A miss trace as `damage_pipeline` returns it (resolve.rs:521-532): every number 0, no effectiveness. */
function missTrace(hpAfter: number): PipelineTrace {
  return {
    hit: false,
    d0: 0,
    d1: 0,
    d2: 0,
    d3: 0,
    effectiveness: null,
    applied: 0,
    hp_after: hpAfter,
    stood_ground: false,
  };
}

function out(o: Partial<ForecastOut> = {}): ForecastOut {
  return {
    hit_pct: 89,
    stab: false,
    flank: false,
    guard: false,
    effectiveness: 'Neutral',
    min: trace(),
    max: trace({ d0: 61, d1: 67, d2: 71, d3: 73, applied: 73, hp_after: 39 }),
    kills_min: false,
    kills_max: false,
    first_stand_saves: false,
    status: null,
    status_blocked: false,
    flank_factor: [5, 4],
    guard_factor: [3, 4],
    // bt-11 REV 5 A27 (round 3): the new ForecastOut field, present so the fixture type-checks. Any
    // pair: the view-model's use of it (the type line's ×num/den) is pinned in round 4.
    type_factor: [1, 1],
    ...o,
  };
}

/** A hit forecast at `eff` (both traces carry it, as `effectiveness = min.effectiveness`); its
 *  `type_factor` is the rules' pair for `eff` unless `o` overrides it (round 4). */
function hitAt(eff: RuleEffectiveness, o: Partial<ForecastOut> = {}): ForecastOut {
  return out({
    effectiveness: eff,
    min: trace({ effectiveness: eff }),
    max: trace({ d0: 61, d1: 67, d2: 71, d3: 73, applied: 73, hp_after: 39, effectiveness: eff }),
    type_factor: TYPE_FACTOR[eff],
    ...o,
  });
}

describe('forecastVM: the line items and the numbers (BT11.7, A13)', () => {
  it('BT11-7-FORECAST-VM-LINES: lines follow type, stab, flank, guard with the factors copied from the rules — the type line carrying the rules` type_factor as num / den; Neutral has no type line, Immune only the type line, a miss none; min/max are d3 and the hit percent is copied', () => {
    // WRONG IMPL KILLED: a type line for Neutral; STAB/flank/Guard lines on an Immune hit (0 damage:
    // only the immunity is news); any line on a miss; the lines in another order; a flank or Guard
    // label that hard-codes 5/4 or 3/4 instead of reading flank_factor / guard_factor (the 7/3 + 2/9
    // rows); num and den swapped; min/max taken from d0 or d2 (or both from one trace); the hit
    // percent recomputed (or the accuracy) instead of copied; `hits` from the max trace. Round 4
    // (A27): a type line with no num / den; num / den looked up from the effectiveness (a ×2 / ×½
    // table) instead of copied from type_factor (the [3,2] row); num and den swapped (the [2,1] and
    // [1,2] rows).

    // Literal rows first, each aimed at ONE cheat.
    const all = forecastVM(
      hitAt('SuperEffective', {
        stab: true,
        flank: true,
        guard: true,
        flank_factor: [7, 3],
        guard_factor: [2, 9],
      }),
    );
    expect(all.lines, 'every line, in the order type, stab, flank, guard, factors copied').toEqual([
      { kind: 'type', effectiveness: 'SuperEffective', num: 2, den: 1 },
      { kind: 'stab' },
      { kind: 'flank', num: 7, den: 3 },
      { kind: 'guard', num: 2, den: 9 },
    ]);
    expect(
      forecastVM(hitAt('SuperEffective', { type_factor: [3, 2] })).lines,
      'round 4: an unusual type_factor [3,2] is copied as is, never looked up from the effectiveness',
    ).toEqual([{ kind: 'type', effectiveness: 'SuperEffective', num: 3, den: 2 }]);
    expect(all.min, 'min is the min trace d3 (not d0 41, d1 43 or d2 47)').toBe(53);
    expect(all.max, 'max is the max trace d3 (not d0 61 or d2 71)').toBe(73);
    expect(all.hitPct, 'the hit percent is copied from hit_pct').toBe(89);
    expect(all.hits, 'a hit forecast hits').toBe(true);

    const neutral = forecastVM(hitAt('Neutral', { stab: true }));
    expect(neutral.lines, 'Neutral shows no type line').toEqual([{ kind: 'stab' }]);

    const nve = forecastVM(hitAt('NotVeryEffective', { guard: true }));
    expect(
      nve.lines,
      'NotVeryEffective shows its type line ([1,2], den first would be [2,1]), then Guard (design 3/4)',
    ).toEqual([
      { kind: 'type', effectiveness: 'NotVeryEffective', num: 1, den: 2 },
      { kind: 'guard', num: 3, den: 4 },
    ]);

    const immune = forecastVM(
      hitAt('Immune', {
        stab: true,
        flank: true,
        guard: true,
        min: trace({ effectiveness: 'Immune', d0: 0, d1: 0, d2: 0, d3: 0, applied: 0 }),
        max: trace({ effectiveness: 'Immune', d0: 0, d1: 0, d2: 0, d3: 0, applied: 0 }),
      }),
    );
    expect(immune.lines, 'Immune shows ONLY the type line, its factor [0,1]').toEqual([
      { kind: 'type', effectiveness: 'Immune', num: 0, den: 1 },
    ]);
    expect([immune.min, immune.max], 'an Immune hit forecasts 0..0').toEqual([0, 0]);

    const miss = forecastVM(
      out({
        hit_pct: 0,
        stab: true,
        flank: true,
        guard: true,
        effectiveness: null,
        min: missTrace(97),
        max: missTrace(97),
      }),
    );
    expect(miss.lines, 'a miss shows no line items, whatever the flags').toEqual([]);
    expect(miss.hits, 'no roll hits').toBe(false);
    expect([miss.min, miss.max, miss.hitPct], 'a miss forecasts 0..0 at 0 %').toEqual([0, 0, 0]);

    const flankOnly = forecastVM(hitAt('Neutral', { flank: true }));
    expect(flankOnly.lines, 'flank alone, the design 5/4').toEqual([
      { kind: 'flank', num: 5, den: 4 },
    ]);

    // First-Stand clamps `applied` (13 HP target: d3 30 applies 12, resolve.rs:549-551); the panel
    // shows the pipeline damage d3, not what the clamp let through (round-2 mutant v6c).
    const stood = forecastVM(
      hitAt('Neutral', {
        min: trace({
          d0: 29,
          d1: 30,
          d2: 30,
          d3: 30,
          applied: 12,
          hp_after: 1,
          stood_ground: true,
        }),
        max: trace({
          d0: 35,
          d1: 37,
          d2: 37,
          d3: 37,
          applied: 12,
          hp_after: 1,
          stood_ground: true,
        }),
        first_stand_saves: true,
      }),
    );
    expect([stood.min, stood.max], 'min/max are d3 (30, 37), never applied (12)').toEqual([30, 37]);

    // The whole table: effectiveness x stab x flank x guard, with the unusual factors.
    const EFFS: readonly RuleEffectiveness[] = [
      'SuperEffective',
      'NotVeryEffective',
      'Neutral',
      'Immune',
    ];
    let rows = 0;
    for (const eff of EFFS) {
      for (const stab of [false, true]) {
        for (const flank of [false, true]) {
          for (const guard of [false, true]) {
            const f = hitAt(eff, {
              stab,
              flank,
              guard,
              hit_pct: 97,
              flank_factor: [7, 3],
              guard_factor: [2, 9],
            });
            const want: ForecastLine[] = [];
            const [num, den] = TYPE_FACTOR[eff];
            if (eff === 'Immune') {
              want.push(typeLine('Immune', num, den));
            } else {
              if (eff !== 'Neutral') want.push(typeLine(eff, num, den));
              if (stab) want.push({ kind: 'stab' });
              if (flank) want.push({ kind: 'flank', num: 7, den: 3 });
              if (guard) want.push({ kind: 'guard', num: 2, den: 9 });
            }
            const label = `${eff} stab=${stab} flank=${flank} guard=${guard}`;
            const vm = forecastVM(f);
            expect(vm.lines, `${label}: lines`).toEqual(want);
            expect([vm.min, vm.max, vm.hitPct, vm.hits], `${label}: numbers`).toEqual([
              53,
              73,
              97,
              true,
            ]);
            rows += 1;
          }
        }
      }
    }
    expect(rows, 'ANTI-VACUITY: the full 4 x 2 x 2 x 2 table ran').toBe(32);
  });

  it('BT11-7-FORECAST-VM-SKULL: kills_min is the full skull, kills_max alone the hollow one, else none; First-Stand and the status follow their flags; hits is the min trace', () => {
    // WRONG IMPL KILLED: the skull read from kills_max first (both true must be 'full'); 'hollow'
    // for kills_min alone; a skull from first_stand_saves; firstStand hard-coded or read from a
    // trace's stood_ground; a status shown although status_blocked; a status dropped when not
    // blocked; the status read from something else than `status`; `hits` from the max trace or
    // from hit_pct > 0. Round 2 (A18): a status shown although the min roll already KOs; the KO
    // clause read from kills_max (a max-only KO must still show it); the status hidden on a miss.
    const skulls: readonly (readonly [boolean, boolean, string])[] = [
      [true, true, 'full'],
      [true, false, 'full'],
      [false, true, 'hollow'],
      [false, false, 'none'],
    ];
    for (const [killsMin, killsMax, skull] of skulls) {
      expect(
        forecastVM(out({ kills_min: killsMin, kills_max: killsMax })).skull,
        `kills_min=${killsMin} kills_max=${killsMax}`,
      ).toBe(skull);
    }
    expect(
      forecastVM(out({ first_stand_saves: true, kills_min: false, kills_max: false })).skull,
      'a First-Stand save is not a skull',
    ).toBe('none');

    expect(forecastVM(out({ first_stand_saves: true })).firstStand, 'First-Stand saves').toBe(true);
    expect(
      forecastVM(
        out({
          first_stand_saves: false,
          min: trace({ stood_ground: true }),
          max: trace({ stood_ground: true }),
        }),
      ).firstStand,
      'firstStand is first_stand_saves, not a trace flag',
    ).toBe(false);

    const statuses: readonly (readonly [ForecastOut['status'], boolean, ForecastOut['status']])[] =
      [
        ['Poison', false, 'Poison'],
        ['Poison', true, null],
        [null, false, null],
        ['Sleep', false, 'Sleep'],
        ['Freeze', true, null],
        ['Paralysis', false, 'Paralysis'],
      ];
    for (const [status, blocked, want] of statuses) {
      expect(
        forecastVM(out({ status, status_blocked: blocked })).status,
        `status ${String(status)} blocked=${blocked}`,
      ).toBe(want);
    }

    // A18: a status never lands on a KO (resolve.rs:675 `!ko`), so when even the min roll KOs the
    // panel shows none; a KO only at the max roll leaves the min roll's status possible.
    const onKo: readonly (readonly [boolean, boolean, boolean, ForecastOut['status']])[] = [
      [true, true, false, null],
      [true, false, false, null],
      [false, true, false, 'Poison'],
      [false, false, false, 'Poison'],
      [true, true, true, null],
    ];
    for (const [killsMin, killsMax, blocked, want] of onKo) {
      expect(
        forecastVM(
          out({
            status: 'Poison',
            status_blocked: blocked,
            kills_min: killsMin,
            kills_max: killsMax,
          }),
        ).status,
        `Poison, kills_min=${killsMin} kills_max=${killsMax} blocked=${blocked}`,
      ).toBe(want);
    }
    expect(
      forecastVM(
        out({
          hit_pct: 0,
          effectiveness: null,
          min: missTrace(80),
          max: missTrace(80),
          status: 'Poison',
          status_blocked: false,
        }),
      ).status,
      'a miss forecast still names the status the skill applies on a hit (not tied to hits)',
    ).toBe('Poison');

    const halfMiss = forecastVM(out({ min: missTrace(80), hit_pct: 1 }));
    expect(halfMiss.hits, 'hits is min.hit (false here), not hit_pct > 0 or max.hit').toBe(false);
    expect(forecastVM(out({ max: missTrace(80) })).hits, 'hits ignores the max trace').toBe(true);
  });
});
