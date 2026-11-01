// tactics/forecast.test.ts — bt-11 RED tests for the pure forecast view-model (BT11.7): which line
// items the panel shows (type, STAB, flank, Guard), the skull, the First-Stand marker, the status
// that may apply, and the numbers copied from the rules' `ForecastOut`.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-battle-tactics.spec.md BT11.7 (design §2.4 / §9.3) and
// the bt-11 plan (memory/projects/monster-realm-bt-11-plan.md) §4.4 as amended by REV 2 A13:
//   - hits = f.min.hit; hitPct = f.hit_pct; min / max = f.min.d3 / f.max.d3;
//   - lines in the order type, stab, flank, guard; the type line `{kind:'type', effectiveness}` only
//     when the effectiveness is not Neutral (the enum is combat/types.rs:200); `{kind:'stab'}`;
//     `{kind:'flank', num, den}` from `f.flank_factor`; `{kind:'guard', num, den}` from
//     `f.guard_factor`; NO lines on a miss; ONLY the type line on Immune;
//   - skull: kills_min → 'full', else kills_max → 'hollow', else 'none';
//   - firstStand = first_stand_saves; status = status_blocked ? null : status.
// The stub in forecast.ts IS the contract: every call goes through `forecastVM`.
//
// HOW THE INPUTS ARE BUILT: hand-made `ForecastOut` values (pure, no wasm). Every number is a
// distinct prime and the d0..d3 of each trace differ, so a value copied from the wrong field
// (d0 or d2 instead of d3, the max trace for the min, the accuracy for the hit percent) is caught.
// Two factor pairs are used (5/4 + 3/4 and 7/3 + 2/9) so a label that hard-codes the design's
// numbers instead of reading `flank_factor` / `guard_factor` fails.
//
// RED REASON: `forecastVM` throws `bt-11: not implemented`.
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { describe, expect, it } from 'vitest';
import { type ForecastLine, forecastVM } from './forecast';
import type { ForecastOut, PipelineTrace, RuleEffectiveness } from './wasm';

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
    ...o,
  };
}

/** A hit forecast at `eff` (both traces carry it, as `effectiveness = min.effectiveness`). */
function hitAt(eff: RuleEffectiveness, o: Partial<ForecastOut> = {}): ForecastOut {
  return out({
    effectiveness: eff,
    min: trace({ effectiveness: eff }),
    max: trace({ d0: 61, d1: 67, d2: 71, d3: 73, applied: 73, hp_after: 39, effectiveness: eff }),
    ...o,
  });
}

describe('forecastVM: the line items and the numbers (BT11.7, A13)', () => {
  it('BT11-7-FORECAST-VM-LINES: lines follow type, stab, flank, guard with the factors copied from the rules; Neutral has no type line, Immune only the type line, a miss none; min/max are d3 and the hit percent is copied', () => {
    // WRONG IMPL KILLED: a type line for Neutral; STAB/flank/Guard lines on an Immune hit (0 damage:
    // only the immunity is news); any line on a miss; the lines in another order; a flank or Guard
    // label that hard-codes 5/4 or 3/4 instead of reading flank_factor / guard_factor (the 7/3 + 2/9
    // rows); num and den swapped; min/max taken from d0 or d2 (or both from one trace); the hit
    // percent recomputed (or the accuracy) instead of copied; `hits` from the max trace.

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
      { kind: 'type', effectiveness: 'SuperEffective' },
      { kind: 'stab' },
      { kind: 'flank', num: 7, den: 3 },
      { kind: 'guard', num: 2, den: 9 },
    ]);
    expect(all.min, 'min is the min trace d3 (not d0 41, d1 43 or d2 47)').toBe(53);
    expect(all.max, 'max is the max trace d3 (not d0 61 or d2 71)').toBe(73);
    expect(all.hitPct, 'the hit percent is copied from hit_pct').toBe(89);
    expect(all.hits, 'a hit forecast hits').toBe(true);

    const neutral = forecastVM(hitAt('Neutral', { stab: true }));
    expect(neutral.lines, 'Neutral shows no type line').toEqual([{ kind: 'stab' }]);

    const nve = forecastVM(hitAt('NotVeryEffective', { guard: true }));
    expect(nve.lines, 'NotVeryEffective shows its type line, then Guard (design 3/4)').toEqual([
      { kind: 'type', effectiveness: 'NotVeryEffective' },
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
    expect(immune.lines, 'Immune shows ONLY the type line').toEqual([
      { kind: 'type', effectiveness: 'Immune' },
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
            if (eff === 'Immune') {
              want.push({ kind: 'type', effectiveness: 'Immune' });
            } else {
              if (eff !== 'Neutral') want.push({ kind: 'type', effectiveness: eff });
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
    // from hit_pct > 0.
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

    const halfMiss = forecastVM(out({ min: missTrace(80), hit_pct: 1 }));
    expect(halfMiss.hits, 'hits is min.hit (false here), not hit_pct > 0 or max.hit').toBe(false);
    expect(forecastVM(out({ max: missTrace(80) })).hits, 'hits ignores the max trace').toBe(true);
  });
});
