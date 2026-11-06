// ui/battlePolicy.test.ts — bt-15 increment B RED tests for `ratingChange` (BT15.3): the pure rule
// that decides whether the Finished phase shows a rating line, and with which before / after.
//
// SOURCE OF TRUTH: spec `M-battle-tactics.spec.md` §bt-15 BT15.3 ("THE Finished phase SHALL show the
// rating change ... when one applied"); plan memory/projects/monster-realm-bt-15-plan.md §8 REV 3.1
// H1: the server rates ONLY a ranked PvP battle with a decisive outcome (ranking.rs
// `apply_pvp_rating`: never wild / practice, never a `Fled` or an unfinished battle), the profile row
// is created lazily by the first rated game (no profile at Active: a null `before`), and the BEFORE is
// the per-battle baseline main.ts snapshotted at the first non-Finished sighting — a baseline of
// another battle is never this battle's. API freeze: `ratingChange({ kind, outcome, battleId,
// baseline, after })` → `{ before, after } | null`, null unless kind === 'Pvp' AND outcome is
// SideAWins / SideBWins AND baseline?.battleId === battleId AND after !== undefined.
//
// RED REASON: `ratingChange` is not exported by ui/battlePolicy.ts.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { describe, expect, it } from 'vitest';
import { ratingChange } from './battlePolicy';

/** A battle id past 2^53, and one that differs from it only above 2^53. */
const B = 2n ** 60n + 7n;
const B_TWIN = B + 2n ** 53n;

type Input = Parameters<typeof ratingChange>[0];
const base = (o: Partial<Input> = {}): Input => ({
  kind: 'Pvp',
  outcome: 'SideBWins',
  battleId: B,
  baseline: { battleId: B, rating: 1000 },
  after: 984,
  ...o,
});

describe('battlePolicy: the rating change of a finished battle (bt-15 B, BT15.3)', () => {
  it('ratingChange is the before / after pair of a decided ranked PvP battle whose baseline was taken for THIS battle — 1000 to 984 on a loss, 1000 to 1016 on a win, a null before on a first rated game — and null for a wild or practice battle, an unknown kind, a flight, an unfinished or unknown outcome, another battle`s baseline, no baseline or no profile after [BT15-3]', () => {
    // WRONG IMPL KILLED (REV 3.1 H1): a rating line for a battle the server never rates (Wild,
    // Practice: the plan's "(+0)" line would be WRONG, not missing); a Fled or Ongoing outcome read
    // as decided; the baseline's battle id ignored (a previous battle's snapshot used as this one's
    // BEFORE), or compared through Number() (the twin id differs only above 2^53); a null baseline
    // rating turned into 0 (a first game read as "0 → 1016"); a missing after-profile defaulted to
    // the before or to 0; before and after swapped.
    expect(ratingChange(base()), 'Pvp SideBWins, this battle`s baseline').toEqual({
      before: 1000,
      after: 984,
    });
    expect(ratingChange(base({ outcome: 'SideAWins', after: 1016 })), 'a win').toEqual({
      before: 1000,
      after: 1016,
    });
    expect(
      ratingChange(base({ after: 1000 })),
      'a decided game that left the rating unchanged still has a line',
    ).toEqual({ before: 1000, after: 1000 });
    expect(
      ratingChange(
        base({ outcome: 'SideAWins', baseline: { battleId: B, rating: null }, after: 1016 }),
      ),
      'a first rated game: no profile at the baseline',
    ).toEqual({ before: null, after: 1016 });

    const none: ReadonlyArray<readonly [string, Partial<Input>]> = [
      ['a wild battle', { kind: 'Wild' }],
      ['a practice battle', { kind: 'Practice' }],
      ['no tactical kind', { kind: undefined }],
      ['a flight', { outcome: 'Fled' }],
      ['an unfinished battle', { outcome: 'Ongoing' }],
      ['an unknown outcome', { outcome: 'Draw' }],
      [
        'another battle`s baseline (differing only above 2^53)',
        { baseline: { battleId: B_TWIN, rating: 1000 } },
      ],
      ['no baseline (a reload after the finish)', { baseline: null }],
      ['no profile after', { after: undefined }],
    ];
    for (const [label, o] of none) {
      expect(ratingChange(base(o)), `${label}: no rating line`).toBeNull();
    }
    expect(
      ratingChange(
        base({ battleId: B_TWIN, baseline: { battleId: B_TWIN, rating: 1203 }, after: 1189 }),
      ),
      'control: the twin battle with ITS own baseline',
    ).toEqual({ before: 1203, after: 1189 });
  });
});
