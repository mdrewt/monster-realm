/**
 * battleEmitModel.test.ts: the pure battleStart / battleEnd / rankedMatch emit cores (pgcc-c).
 *
 * main.ts used to hold these latches as three module lets (`activeBattleId`, `battleReseedPending`,
 * `reseedPrevBattleId`) mutated inside two `store.onBatchApplied` listeners. The cores are now two
 * pure steps, so the rules are testable without booting main.ts:
 *   - `battleEmitStep(state, { hydrated, latest })` returns the next state and at most one emit
 *     (battleStart | battleEnd | none). Rules: (a) a pre-hydration flush never consumes a pending
 *     reseed; (b) the first post-hydration flush consumes it, and only the battle that survived the
 *     drop is re-baselined silently, anything else falls through to (c)/(d) on the SAME flush;
 *     (c) battleStart fires once per newly seen Ongoing id; (d) battleEnd fires only for the id the
 *     latch saw start; (e) the outcome is the server tag verbatim (never perspective-mapped) and
 *     turnCount is `turnNumber`; (f) PvP is `isPvpBattle` (party AND identity), so wild and
 *     practice are not PvP; (g) `armReseed` keeps the FIRST drop's capture and always arms,
 *     `resetBattleEmit` clears only the latch and never arms. `hydrated` is read only while a
 *     reseed is pending.
 *   - `rankedStep({ lastRating, rating, latest })` baselines on first sight, emits rankedMatch with
 *     the signed delta on a change, and attaches a battle id only when the latest battle is PvP.
 *
 * Pure, node env, no clock. Every row asserts the exact next state and the exact emit. The shell's
 * early returns (no profile, identity '') stay in main.ts and are covered by the boot suite.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  armReseed,
  BATTLE_EMIT_INITIAL,
  type BattleEmitState,
  type BattleSummary,
  battleEmitStep,
  rankedStep,
  resetBattleEmit,
} from './battleEmitModel';
import type { PlaytestEventPayload } from './eventRing';

const PLAYER = 'aa'.repeat(32);
const OPPONENT = 'bb'.repeat(32);
const WILD = '00'.repeat(32);

type Shape = Pick<BattleSummary, 'opponentMonsterIds' | 'opponentIdentity' | 'playerIdentity'>;

/** Four opponent shapes so no row depends on one fixture. */
const SHAPES = {
  /** Challenger's view of a PvP battle: a two-monster owned party, a distinct identity. */
  pvp: { opponentMonsterIds: [101n, 102n], opponentIdentity: OPPONENT, playerIdentity: PLAYER },
  /** Accepter's view of the same kind of battle: one monster, identities swapped. */
  pvpAccepter: { opponentMonsterIds: [7], opponentIdentity: PLAYER, playerIdentity: OPPONENT },
  /** Wild encounter: all-zero WILD identity (!== player) but no owned opponent party. */
  wild: { opponentMonsterIds: [], opponentIdentity: WILD, playerIdentity: PLAYER },
  /** Practice: same identity on both sides, a non-empty party. */
  practice: {
    opponentMonsterIds: [5n, 6n, 7n],
    opponentIdentity: PLAYER,
    playerIdentity: PLAYER,
  },
} as const satisfies Record<string, Shape>;
type ShapeName = keyof typeof SHAPES;

function mk(
  shape: ShapeName,
  battleId: bigint,
  outcome = 'Ongoing',
  turnNumber = 1,
): BattleSummary {
  return { battleId, outcome, turnNumber, ...SHAPES[shape] };
}

const st = (
  activeBattleId: bigint | null,
  reseedPending: boolean,
  reseedPrevBattleId: bigint | null,
): BattleEmitState => ({ activeBattleId, reseedPending, reseedPrevBattleId });

const NONE = st(null, false, null);

const start = (battleId: string, isPvp: boolean): PlaytestEventPayload => ({
  kind: 'battleStart',
  battleId,
  isPvp,
});
const end = (battleId: string, outcome: string, turnCount: number): PlaytestEventPayload => ({
  kind: 'battleEnd',
  battleId,
  outcome,
  turnCount,
});
const ranked = (battleId: string, ratingDelta: number): PlaytestEventPayload => ({
  kind: 'rankedMatch',
  battleId,
  ratingDelta,
});

interface StepInput {
  readonly hydrated: boolean;
  readonly latest: BattleSummary | undefined;
}
interface Row {
  readonly name: string;
  readonly from: BattleEmitState;
  readonly input: StepInput;
  readonly to: BattleEmitState;
  readonly emit: PlaytestEventPayload | undefined;
}

const flush = (hydrated: boolean, latest: BattleSummary | undefined): StepInput => ({
  hydrated,
  latest,
});

function expectRow(row: Row): void {
  const result = battleEmitStep(row.from, row.input);
  expect(result.state).toEqual(row.to);
  if (row.emit === undefined) expect(result.emit).toBeUndefined();
  else expect(result.emit).toEqual(row.emit);
}

/** Fold flushes through the step, keeping every intermediate state and emit in order. */
function run(
  from: BattleEmitState,
  inputs: readonly StepInput[],
): { readonly states: readonly BattleEmitState[]; readonly emits: readonly unknown[] } {
  let state = from;
  const states: BattleEmitState[] = [];
  const emits: unknown[] = [];
  for (const input of inputs) {
    const result = battleEmitStep(state, input);
    state = result.state;
    states.push(result.state);
    emits.push(result.emit);
  }
  return { states, emits };
}

describe('C1 battleEmitStep: (a) a pre-hydration flush never consumes a pending reseed', () => {
  const pending = st(null, true, 7n);
  const rows: readonly Row[] = [
    // WRONG IMPL KILLED: a reseed burned on a pre-hydration flush (re-baselines the survivor,
    // clearing the latch before hydration finished).
    {
      name: 'the survivor re-sighted Ongoing before hydration: state unchanged, no emit',
      from: pending,
      input: flush(false, mk('pvp', 7n)),
      to: pending,
      emit: undefined,
    },
    // WRONG IMPL KILLED: a reseed burned by a pre-hydration terminal row (clears the reseed and
    // falls through, or emits battleEnd).
    {
      name: 'a terminal row before hydration: state unchanged, no emit',
      from: pending,
      input: flush(false, mk('pvp', 7n, 'SideAWins', 4)),
      to: pending,
      emit: undefined,
    },
    // WRONG IMPL KILLED: a pre-hydration flush that falls through to the battleStart branch.
    {
      name: 'a different Ongoing id before hydration: state unchanged, no battleStart',
      from: pending,
      input: flush(false, mk('wild', 9n)),
      to: pending,
      emit: undefined,
    },
    // WRONG IMPL KILLED: an undefined read before hydration treated as definitive (clears the
    // reseed), the exact empty-flush burn the hydration latch exists to stop.
    {
      name: 'no battle row before hydration: state unchanged, no emit',
      from: pending,
      input: flush(false, undefined),
      to: pending,
      emit: undefined,
    },
    {
      name: 'a latch already holding another id keeps it untouched before hydration',
      from: st(3n, true, 7n),
      input: flush(false, mk('practice', 7n)),
      to: st(3n, true, 7n),
      emit: undefined,
    },
    {
      name: 'a drop with no active battle (prev null) still waits for hydration',
      from: st(null, true, null),
      input: flush(false, mk('pvpAccepter', 5n)),
      to: st(null, true, null),
      emit: undefined,
    },
  ];
  for (const row of rows) it(row.name, () => expectRow(row));

  it('two pre-hydration flushes leave the reseed pending; the first hydrated flush consumes it', () => {
    // WRONG IMPL KILLED: a reseed burned on the FIRST pre-hydration flush: the state after step 1
    // or 2 would already show reseedPending false / active 7.
    const { states, emits } = run(pending, [
      flush(false, mk('pvp', 7n)),
      flush(false, undefined),
      flush(true, mk('pvp', 7n)),
    ]);
    expect(states).toEqual([pending, pending, st(7n, false, null)]);
    expect(emits).toEqual([undefined, undefined, undefined]);
  });
});

describe('C1 battleEmitStep: (b) the first post-hydration flush consumes the reseed', () => {
  const rows: readonly Row[] = [
    // WRONG IMPL KILLED: a post-hydration survivor that emits battleStart again (re-baseline
    // missing), or one that forgets to set activeBattleId.
    {
      name: 'the survivor is still Ongoing under the same id: re-baseline silently',
      from: st(null, true, 7n),
      input: flush(true, mk('pvp', 7n)),
      to: st(7n, false, null),
      emit: undefined,
    },
    {
      name: 'a different Ongoing id: the SAME flush emits battleStart for it',
      from: st(null, true, 7n),
      input: flush(true, mk('pvp', 9n, 'Ongoing', 2)),
      to: st(9n, false, null),
      emit: start('9', true),
    },
    // WRONG IMPL KILLED: a reseed never cleared after resolving on an undefined read (the
    // pending flag or the captured id survives and swallows a later start).
    {
      name: 'no battle row after hydration just clears the reseed',
      from: st(null, true, 7n),
      input: flush(true, undefined),
      to: NONE,
      emit: undefined,
    },
    // WRONG IMPL KILLED: a survivor re-baseline that ignores the outcome (a terminal survivor
    // would set active 7 and arm a phantom battleEnd). After a reconnect resetBattleEmit has
    // nulled the latch, so the terminal survivor finds no latch: no emit. This is the documented
    // residual R2 in main.battle-reseed.test.ts.
    {
      name: 'the survivor ended during the outage and the latch was reset: no emit, latch stays null',
      from: st(null, true, 7n),
      input: flush(true, mk('pvp', 7n, 'SideBWins', 6)),
      to: NONE,
      emit: undefined,
    },
    // WRONG IMPL KILLED: a survivor branch that returns early for ANY row carrying the survivor
    // id (a latch still holding 7 must fall through to battleEnd on the same flush).
    {
      name: 'a terminal survivor against a still-set latch falls through to battleEnd',
      from: st(7n, true, 7n),
      input: flush(true, mk('pvp', 7n, 'SideBWins', 6)),
      to: NONE,
      emit: end('7', 'SideBWins', 6),
    },
    // WRONG IMPL KILLED: a re-baseline that fires for ANY Ongoing row when the drop captured no
    // id (survivedId null) - the row is a new battle and must emit battleStart.
    {
      name: 'nothing was active at the drop: an Ongoing row is a new battle and emits',
      from: st(null, true, null),
      input: flush(true, mk('wild', 7n)),
      to: st(7n, false, null),
      emit: start('7', false),
    },
    // WRONG IMPL KILLED: a re-baseline that fires for any Ongoing row instead of only the
    // captured id (a different battle that happens to be Ongoing is a new start).
    {
      name: 'the drop captured 5 but the Ongoing row is 7: a new battle, it emits',
      from: st(null, true, 5n),
      input: flush(true, mk('practice', 7n)),
      to: st(7n, false, null),
      emit: start('7', false),
    },
  ];
  for (const row of rows) it(row.name, () => expectRow(row));

  it('a resolved reseed does not recur: the next flush behaves as a plain flush', () => {
    // WRONG IMPL KILLED: reseed never cleared after resolving (a stale prev id 7 would silently
    // re-baseline the later Ongoing 7 instead of emitting battleStart).
    const { states, emits } = run(st(null, true, 7n), [
      flush(true, undefined),
      flush(true, mk('pvp', 7n)),
    ]);
    expect(states).toEqual([NONE, st(7n, false, null)]);
    expect(emits).toEqual([undefined, start('7', true)]);
  });
});

describe('C1 battleEmitStep: (c) battleStart fires once per newly seen Ongoing id', () => {
  const rows: readonly Row[] = [
    {
      name: 'the first Ongoing PvP row emits battleStart and latches the id',
      from: NONE,
      input: flush(true, mk('pvp', 4n)),
      to: st(4n, false, null),
      emit: start('4', true),
    },
    {
      name: 'the same Ongoing row again emits nothing',
      from: st(4n, false, null),
      input: flush(true, mk('pvp', 4n, 'Ongoing', 3)),
      to: st(4n, false, null),
      emit: undefined,
    },
    {
      name: 'a new Ongoing id emits again and moves the latch',
      from: st(4n, false, null),
      input: flush(true, mk('pvpAccepter', 5n)),
      to: st(5n, false, null),
      emit: start('5', true),
    },
    // WRONG IMPL KILLED: a truthiness test on the latch (id 0 read as "no battle").
    {
      name: 'battle id 0 latches and emits like any other id',
      from: NONE,
      input: flush(true, mk('wild', 0n)),
      to: st(0n, false, null),
      emit: start('0', false),
    },
    {
      name: 'battle id 0 re-sighted emits nothing',
      from: st(0n, false, null),
      input: flush(true, mk('wild', 0n)),
      to: st(0n, false, null),
      emit: undefined,
    },
    // WRONG IMPL KILLED: hydrated consulted when no reseed is pending (an ordinary flush with
    // hydrated:false would be dropped).
    {
      name: 'hydrated:false with no reseed pending still emits normally',
      from: NONE,
      input: flush(false, mk('practice', 4n)),
      to: st(4n, false, null),
      emit: start('4', false),
    },
  ];
  for (const row of rows) it(row.name, () => expectRow(row));
});

describe('C1 battleEmitStep: (d) battleEnd fires only for the id the latch saw start', () => {
  const rows: readonly Row[] = [
    // WRONG IMPL KILLED: a battleEnd that does not clear activeBattleId (state would keep 4).
    {
      name: 'a terminal row for the latched id emits battleEnd and clears the latch',
      from: st(4n, false, null),
      input: flush(true, mk('pvp', 4n, 'SideAWins', 12)),
      to: NONE,
      emit: end('4', 'SideAWins', 12),
    },
    // WRONG IMPL KILLED: battleEnd for a never-started id (a stale-terminal login).
    {
      name: 'a battle first seen already terminal emits nothing',
      from: NONE,
      input: flush(true, mk('pvp', 4n, 'SideAWins', 12)),
      to: NONE,
      emit: undefined,
    },
    // WRONG IMPL KILLED: battleEnd keyed on "any terminal row while a latch is set", or one that
    // clears the latch for a different id.
    {
      name: 'a terminal row of a different id emits nothing and leaves the latch alone',
      from: st(4n, false, null),
      input: flush(true, mk('pvp', 5n, 'SideBWins', 2)),
      to: st(4n, false, null),
      emit: undefined,
    },
    {
      name: 'hydrated:false with no reseed pending still emits battleEnd',
      from: st(4n, false, null),
      input: flush(false, mk('wild', 4n, 'SideBWins', 3)),
      to: NONE,
      emit: end('4', 'SideBWins', 3),
    },
    {
      name: 'no battle row changes nothing',
      from: st(4n, false, null),
      input: flush(true, undefined),
      to: st(4n, false, null),
      emit: undefined,
    },
  ];
  for (const row of rows) it(row.name, () => expectRow(row));

  it('start, repeat, end, repeat emits exactly one start and one end', () => {
    // WRONG IMPL KILLED: battleEnd not clearing activeBattleId (the repeated terminal row would
    // emit a second battleEnd), and a start that re-fires on the repeated Ongoing row.
    const { states, emits } = run(NONE, [
      flush(true, mk('pvp', 4n)),
      flush(true, mk('pvp', 4n, 'Ongoing', 2)),
      flush(true, mk('pvp', 4n, 'SideAWins', 5)),
      flush(true, mk('pvp', 4n, 'SideAWins', 5)),
    ]);
    expect(states).toEqual([st(4n, false, null), st(4n, false, null), NONE, NONE]);
    expect(emits).toEqual([start('4', true), undefined, end('4', 'SideAWins', 5), undefined]);
  });

  it('a newer Ongoing id replaces the latch: the older id never ends, the newer one does', () => {
    // WRONG IMPL KILLED: battleEnd for a never-started (replaced) id.
    const { states, emits } = run(NONE, [
      flush(true, mk('pvp', 4n)),
      flush(true, mk('wild', 5n)),
      flush(true, mk('pvp', 4n, 'SideBWins', 9)),
      flush(true, mk('wild', 5n, 'SideAWins', 2)),
    ]);
    expect(states).toEqual([st(4n, false, null), st(5n, false, null), st(5n, false, null), NONE]);
    expect(emits).toEqual([
      start('4', true),
      start('5', false),
      undefined,
      end('5', 'SideAWins', 2),
    ]);
  });
});

describe('C1 battleEmitStep: (e) the outcome is the server tag verbatim', () => {
  const rows: readonly Row[] = [
    // WRONG IMPL KILLED: an outcome perspective-mapped for the accepter (SideAWins is the
    // accepter's OWN loss; a mapped impl would report SideBWins / Loss / Defeat).
    {
      name: "an accepter's own loss is recorded as SideAWins",
      from: st(31n, false, null),
      input: flush(true, mk('pvpAccepter', 31n, 'SideAWins', 8)),
      to: NONE,
      emit: end('31', 'SideAWins', 8),
    },
    {
      name: "a challenger's loss is recorded as SideBWins with its own turn count",
      from: st(32n, false, null),
      input: flush(true, mk('pvp', 32n, 'SideBWins', 3)),
      to: NONE,
      emit: end('32', 'SideBWins', 3),
    },
    // WRONG IMPL KILLED: turnCount defaulted with `||` (turn 0 read as missing) or taken from a
    // constant.
    {
      name: 'turn 0 and a non-win tag pass through unchanged',
      from: st(33n, false, null),
      input: flush(true, mk('practice', 33n, 'Draw', 0)),
      to: NONE,
      emit: end('33', 'Draw', 0),
    },
  ];
  for (const row of rows) it(row.name, () => expectRow(row));
});

describe('C1 battleEmitStep: (f) PvP is classified by isPvpBattle', () => {
  const cases: readonly {
    readonly name: string;
    readonly shape: ShapeName;
    readonly pvp: boolean;
  }[] = [
    // WRONG IMPL KILLED: isPvp via identity inequality only (the wild WILD_IDENTITY !== player).
    {
      name: 'a wild battle (all-zero identity, empty party) is not PvP',
      shape: 'wild',
      pvp: false,
    },
    // WRONG IMPL KILLED: isPvp via party-non-empty only (practice has a party but the same id).
    {
      name: 'a practice battle (same identity, non-empty party) is not PvP',
      shape: 'practice',
      pvp: false,
    },
    { name: "a challenger's PvP battle is PvP", shape: 'pvp', pvp: true },
    { name: "an accepter's PvP battle is PvP", shape: 'pvpAccepter', pvp: true },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const result = battleEmitStep(NONE, flush(true, mk(c.shape, 21n)));
      expect(result.state).toEqual(st(21n, false, null));
      expect(result.emit).toEqual(start('21', c.pvp));
    });
  }
});

describe('C1 battleEmitStep: (g) armReseed and resetBattleEmit', () => {
  const rows: readonly {
    readonly name: string;
    readonly fn: 'arm' | 'reset';
    readonly from: BattleEmitState;
    readonly to: BattleEmitState;
  }[] = [
    {
      name: 'armReseed captures the active battle and arms',
      fn: 'arm',
      from: st(7n, false, null),
      to: st(7n, true, 7n),
    },
    {
      name: 'armReseed with no active battle arms with a null capture',
      fn: 'arm',
      from: NONE,
      to: st(null, true, null),
    },
    // WRONG IMPL KILLED: armReseed overwriting the capture on a second drop (the latch was
    // already reset to null by the first drop, so the second capture would erase the 7).
    {
      name: 'a second armReseed while pending keeps the FIRST capture',
      fn: 'arm',
      from: st(null, true, 7n),
      to: st(null, true, 7n),
    },
    // WRONG IMPL KILLED: armReseed overwriting the capture (prev 7 -> 9) or not re-arming when
    // already pending (pending must stay true).
    {
      name: 'a pending reseed stays pending and keeps its capture even if the latch moved on',
      fn: 'arm',
      from: st(9n, true, 7n),
      to: st(9n, true, 7n),
    },
    // WRONG IMPL KILLED: an armReseed that keeps a stale capture because it tests the capture
    // (prev !== null) instead of the pending flag.
    {
      name: 'a stale capture with no reseed pending is replaced by the current latch',
      fn: 'arm',
      from: st(3n, false, 7n),
      to: st(3n, true, 3n),
    },
    // WRONG IMPL KILLED: resetBattleEmit clearing the reseed fields (the capture would be lost
    // between armReseed and the first hydrated flush).
    {
      name: 'resetBattleEmit clears only the latch and keeps a pending reseed',
      fn: 'reset',
      from: st(7n, true, 7n),
      to: st(null, true, 7n),
    },
    // WRONG IMPL KILLED: resetBattleEmit arming a reseed (a zone switch would then swallow the
    // next battleStart).
    {
      name: 'resetBattleEmit does not arm a reseed',
      fn: 'reset',
      from: st(7n, false, null),
      to: NONE,
    },
    {
      name: 'resetBattleEmit keeps a pending reseed with a null capture',
      fn: 'reset',
      from: st(5n, true, null),
      to: st(null, true, null),
    },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const next = row.fn === 'arm' ? armReseed(row.from) : resetBattleEmit(row.from);
      expect(next).toEqual(row.to);
    });
  }

  it('the pure steps do not mutate their (frozen) inputs', () => {
    const frozenState = Object.freeze(st(7n, true, 7n));
    const frozenLatest = Object.freeze({
      ...mk('pvp', 7n),
      opponentMonsterIds: Object.freeze([1n]),
    });
    expect(() => battleEmitStep(frozenState, flush(true, frozenLatest))).not.toThrow();
    expect(() => armReseed(frozenState)).not.toThrow();
    expect(() => resetBattleEmit(frozenState)).not.toThrow();
    expect(frozenState).toEqual(st(7n, true, 7n));
  });
});

describe('C1 battleEmitStep: composed shell-order scenarios', () => {
  it('reconnect, survivor re-sighted before and after hydration, then it ends: one battleEnd', () => {
    // The shell order on reconnect: armReseed, resetBattleEmit, then flushes. WRONG IMPL KILLED:
    // any of reseed burned pre-hydration, no silent re-baseline, a re-baseline that does not
    // restore the latch (the final terminal row would then emit nothing), armReseed capturing
    // AFTER the reset (a null capture would turn the survivor into a new battleStart).
    const live = battleEmitStep(NONE, flush(true, mk('pvp', 7n)));
    expect(live.state).toEqual(st(7n, false, null));
    expect(live.emit).toEqual(start('7', true));

    const armed = armReseed(live.state);
    const reset = resetBattleEmit(armed);
    expect(reset).toEqual(st(null, true, 7n));

    const { states, emits } = run(reset, [
      flush(false, mk('pvp', 7n)),
      flush(true, mk('pvp', 7n)),
      flush(true, mk('pvp', 7n, 'SideBWins', 11)),
    ]);
    expect(states).toEqual([st(null, true, 7n), st(7n, false, null), NONE]);
    expect(emits).toEqual([undefined, undefined, end('7', 'SideBWins', 11)]);
  });

  it('two drops before hydration: the first capture survives and the survivor is silent', () => {
    // WRONG IMPL KILLED: armReseed overwriting the capture on the second drop (prev would be
    // null and the survivor would emit a spurious battleStart).
    const live = battleEmitStep(NONE, flush(true, mk('pvp', 7n))).state;
    const afterFirstDrop = resetBattleEmit(armReseed(live));
    const afterSecondDrop = resetBattleEmit(armReseed(afterFirstDrop));
    expect(afterSecondDrop).toEqual(st(null, true, 7n));
    const { states, emits } = run(afterSecondDrop, [
      flush(false, undefined),
      flush(true, mk('pvp', 7n)),
    ]);
    expect(states).toEqual([st(null, true, 7n), st(7n, false, null)]);
    expect(emits).toEqual([undefined, undefined]);
  });

  it('reconnect where a different battle replaced the survivor: that battle emits battleStart', () => {
    const live = battleEmitStep(NONE, flush(true, mk('wild', 7n))).state;
    const reset = resetBattleEmit(armReseed(live));
    const { states, emits } = run(reset, [flush(true, mk('pvp', 9n))]);
    expect(states).toEqual([st(9n, false, null)]);
    expect(emits).toEqual([start('9', true)]);
  });

  it('a zone switch (reset without arm) makes the re-sighted battle a fresh battleStart', () => {
    // WRONG IMPL KILLED: resetBattleEmit arming the reseed (the re-sighting would be silent).
    const live = battleEmitStep(NONE, flush(true, mk('practice', 7n))).state;
    const reset = resetBattleEmit(live);
    expect(reset).toEqual(NONE);
    const { states, emits } = run(reset, [flush(true, mk('practice', 7n))]);
    expect(states).toEqual([st(7n, false, null)]);
    expect(emits).toEqual([start('7', false)]);
  });
});

describe('C1 battleEmitStep: property over arbitrary flush sequences', () => {
  const flushArb = fc.option(
    fc.record({
      shape: fc.constantFrom<ShapeName>('pvp', 'pvpAccepter', 'wild', 'practice'),
      id: fc.constantFrom(1n, 2n, 3n),
      terminal: fc.option(fc.constantFrom('SideAWins', 'SideBWins', 'Draw'), { nil: undefined }),
      turn: fc.integer({ min: 0, max: 40 }),
    }),
    { nil: undefined },
  );

  it('every battleEnd follows a battleStart of the same id, with at most one emit per step', () => {
    fc.assert(
      fc.property(fc.array(flushArb, { maxLength: 40 }), (flushes) => {
        let state: BattleEmitState = BATTLE_EMIT_INITIAL;
        const open = new Map<bigint, boolean>();
        for (const f of flushes) {
          const latest = f ? mk(f.shape, f.id, f.terminal ?? 'Ongoing', f.turn) : undefined;
          const result = battleEmitStep(state, flush(true, latest));
          state = result.state;
          const emit = result.emit;
          expect(Array.isArray(emit)).toBe(false);
          if (emit === undefined) continue;
          expect(latest).toBeDefined();
          if (emit.kind === 'battleStart') {
            expect(emit.battleId).toBe(latest?.battleId.toString());
            expect(latest?.outcome).toBe('Ongoing');
            open.set(BigInt(emit.battleId), true);
          } else {
            expect(emit.kind).toBe('battleEnd');
            if (emit.kind !== 'battleEnd') continue;
            expect(emit.battleId).toBe(latest?.battleId.toString());
            expect(emit.outcome).toBe(latest?.outcome);
            expect(emit.turnCount).toBe(latest?.turnNumber);
            expect(open.get(BigInt(emit.battleId))).toBe(true);
            open.set(BigInt(emit.battleId), false);
            expect(state.activeBattleId).toBeNull();
          }
        }
      }),
    );
  });
});

describe('C2 rankedStep: baseline and unchanged rating emit nothing', () => {
  const rows: readonly {
    readonly name: string;
    readonly lastRating: number | null;
    readonly rating: number;
    readonly latest: BattleSummary | undefined;
    readonly next: number;
  }[] = [
    // WRONG IMPL KILLED: rankedStep emitting on baseline (rating - null read as the full rating).
    {
      name: 'first sight baselines to the current rating even beside a PvP battle',
      lastRating: null,
      rating: 1000,
      latest: mk('pvp', 42n),
      next: 1000,
    },
    // WRONG IMPL KILLED: a falsy test on lastRating that treats a 0 baseline as "unset" in the
    // other direction (rating 0 first sight must still be a baseline, not a delta).
    {
      name: 'first sight at rating 0 baselines to 0',
      lastRating: null,
      rating: 0,
      latest: undefined,
      next: 0,
    },
    {
      name: 'an unchanged rating emits nothing and keeps the baseline',
      lastRating: 1000,
      rating: 1000,
      latest: mk('pvp', 42n),
      next: 1000,
    },
    {
      name: 'an unchanged rating of 0 emits nothing',
      lastRating: 0,
      rating: 0,
      latest: mk('pvpAccepter', 8n),
      next: 0,
    },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const result = rankedStep({
        lastRating: row.lastRating,
        rating: row.rating,
        latest: row.latest,
      });
      expect(result.lastRating).toBe(row.next);
      expect(result.emit).toBeUndefined();
    });
  }
});

describe('C2 rankedStep: a changed rating emits rankedMatch with the signed delta', () => {
  const rows: readonly {
    readonly name: string;
    readonly lastRating: number;
    readonly rating: number;
    readonly latest: BattleSummary | undefined;
    readonly emit: PlaytestEventPayload;
  }[] = [
    // WRONG IMPL KILLED: delta sign flipped (lastRating - rating).
    {
      name: 'a gain is a positive delta and moves the baseline',
      lastRating: 1000,
      rating: 1016,
      latest: mk('pvp', 42n, 'SideAWins', 6),
      emit: ranked('42', 16),
    },
    {
      name: 'a loss is a negative delta and moves the baseline',
      lastRating: 1016,
      rating: 997,
      latest: mk('pvpAccepter', 43n, 'SideAWins', 6),
      emit: ranked('43', -19),
    },
    // WRONG IMPL KILLED: a falsy test on lastRating (a 0 baseline is a real rating, not unset).
    {
      name: 'a change from a baseline of 0 emits',
      lastRating: 0,
      rating: 25,
      latest: mk('pvp', 44n),
      emit: ranked('44', 25),
    },
    {
      name: 'a drop to rating 0 emits a negative delta',
      lastRating: 12,
      rating: 0,
      latest: mk('pvp', 45n),
      emit: ranked('45', -12),
    },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const result = rankedStep({
        lastRating: row.lastRating,
        rating: row.rating,
        latest: row.latest,
      });
      expect(result.lastRating).toBe(row.rating);
      expect(result.emit).toEqual(row.emit);
    });
  }

  it('the delta is rating minus lastRating and the baseline follows, for any change', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5000, max: 5000 }),
        fc.integer({ min: -5000, max: 5000 }),
        (lastRating, rating) => {
          const result = rankedStep({ lastRating, rating, latest: mk('pvp', 9n) });
          expect(result.lastRating).toBe(rating);
          if (rating === lastRating) {
            expect(result.emit).toBeUndefined();
          } else {
            expect(result.emit).toEqual(ranked('9', rating - lastRating));
          }
        },
      ),
    );
  });
});

describe('C2 rankedStep: the battle id is attached only for a PvP battle', () => {
  const rows: readonly {
    readonly name: string;
    readonly latest: BattleSummary | undefined;
    readonly battleId: string;
  }[] = [
    // WRONG IMPL KILLED: battleId attached for non-PvP (latestPlayerBattle may be a wild fight).
    {
      name: 'a wild latest battle yields an empty battle id',
      latest: mk('wild', 50n),
      battleId: '',
    },
    {
      name: 'a practice latest battle yields an empty battle id',
      latest: mk('practice', 51n),
      battleId: '',
    },
    { name: 'no latest battle yields an empty battle id', latest: undefined, battleId: '' },
    {
      name: 'a PvP latest battle (accepter view) carries its id',
      latest: mk('pvpAccepter', 52n),
      battleId: '52',
    },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const result = rankedStep({ lastRating: 1000, rating: 1008, latest: row.latest });
      expect(result.lastRating).toBe(1008);
      expect(result.emit).toEqual(ranked(row.battleId, 8));
    });
  }
});
