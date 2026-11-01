// tactics/draft.test.ts — bt-11 round-3 RED tests for the client-local DRAFT (BT11.2 + BT11.3's
// Too-late): editing it (push / pop, the irreversible kinds), costing it (`costEntries`: a Move's
// disengage tax judged at its CHAINED start tile, a Skill's tier from the kit), applying it to a board
// (`applyPlan`: the ONE walk the menu, the strip and the projection share, REV 5 A25), the binding
// wire shape `submit_queue` takes (`toWire`), and the cancel race (`isAlreadyActing`, A37).
//
// SOURCE OF TRUTH: spec `### bt-11` BT11.2 / BT11.3; the plan (memory/projects/monster-realm-bt-11-
// plan.md) REV 4 §R4.4 as amended by REV 5 A25 (applyPlan), A28 (the lifecycle), A37 (the Too-late
// predicate). The frozen exports of client/src/tactics/draft.ts are the contract.
//
// HOW THE EXPECTED VALUES ARE BUILT: every rule fact comes from a FAKE `TacticsRules` whose answers
// are scripted per call and whose calls are RECORDED, so a draft that computes a tax, a path, a hit
// set or an HP in TypeScript is caught by the recorded arguments and by the fake's distinctive
// answers (hp_after 37 and 29 are primes no damage arithmetic would land on; target 17's forecast
// says `kills_min` with a NON-zero hp_after, so a Fainted read from `hp_after === 0` fails). Every
// board handed in is deep-frozen, so a mutation throws.
//
// RED REASON: push / pop / isIrreversible / applyPlan / costEntries / toWire / isAlreadyActing throw
// `bt-11: not implemented`; the `tactics.queue.tooLate` key is absent from both catalogs.
//
// bt-11 ROUND 4 (increment C, plan REV 6 R6.1 + REV 6.1 C16 + REV 6.2 C19): BT11-2-DRAFT-COST also
// pins `applyAction`, the ONE step `applyPlan` folds and the strip / the projection share — null on
// a refused Move or Skill (and for a unit not on the board), a new board on an accepted one, and the
// SAME board object for Recruit / Flee / EndTurn / Item (a required pin: the strip chains boards
// through it). Its `applyPlan` pins are unchanged. RED REASON (round 4): `applyAction` throws
// `bt-11: not implemented`.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { describe, expect, it } from 'vitest';
import type { QueuedAction } from '../module_bindings/types';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import { CATALOG_FR } from '../ui/i18n/catalog.fr';
import {
  applyAction,
  applyPlan,
  costEntries,
  type Draft,
  emptyDraft,
  isAlreadyActing,
  isIrreversible,
  pop,
  push,
  toWire,
} from './draft';
import type {
  Cell,
  ForecastOut,
  GeometryError,
  Path,
  PathError,
  PipelineTrace,
  QueuedActionRule,
  RuleResult,
  RulesBoard,
  RulesUnit,
  SkillTactics,
  TacticsRules,
  UnitRow,
} from './wasm';

const EN = CATALOG_EN as unknown as Record<string, unknown>;
const FR = CATALOG_FR as unknown as Record<string, unknown>;
/** U+2014, by code point. */
const EM_DASH = String.fromCharCode(0x2014);

const c = (x: number, y: number): Cell => ({ x, y });

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

// --- fixture ----------------------------------------------------------------------------------

const S11: SkillTactics = {
  skill_id: 11,
  tier: 'Light',
  affinity: 'Plant',
  power: 31,
  accuracy: 89,
  applies_status: null,
  geometry: {
    range_min: 0,
    range_max: 0,
    origin: 'Caster',
    shape: 'Burst',
    radius: 1,
    ff_filter: 'Enemies',
  },
};
const S12: SkillTactics = {
  skill_id: 12,
  tier: 'Heavy',
  affinity: 'Plant',
  power: 53,
  accuracy: 79,
  applies_status: null,
  geometry: {
    range_min: 1,
    range_max: 2,
    origin: 'TargetUnit',
    shape: 'Single',
    radius: 0,
    ff_filter: 'Enemies',
  },
};

function rowAt(id: number, side: 'A' | 'B', slot: number, at: Cell, hp: number): UnitRow {
  return {
    id,
    side,
    slot,
    species_id: 1,
    level: 10,
    stats: { hp: 50, attack: 10, defense: 10, speed: 10, sp_attack: 10, sp_defense: 10 },
    pos: at,
    cur_hp: hp,
    status: null,
    budget: { ap: 6, strides_used: 0, attacks: 0, last: null },
    guard: false,
    first_stand: false,
    state: 'Active',
    stance: side === 'B' ? 'Aggressive' : null,
    wild_index: side === 'B' ? slot : null,
  };
}

/** U (5) at (1,1); W31 at (3,1) and W17 at (4,1); an ally 2 at (0,0). Deep-frozen. */
const LIVE: RulesBoard = deepFreeze<RulesBoard>({
  kind: 'Wild',
  map_id: 1,
  units: [
    rowAt(5, 'A', 0, c(1, 1), 41),
    rowAt(2, 'A', 1, c(0, 0), 43),
    rowAt(31, 'B', 0, c(3, 1), 47),
    rowAt(17, 'B', 1, c(4, 1), 53),
  ],
});
const LIVE_JSON = JSON.stringify(LIVE);

/** The rules' join of a row: the row's fields, the fixture kit [11, 12]. */
function joinRow(row: UnitRow): RulesUnit {
  return {
    id: row.id,
    side: row.side,
    slot: row.slot,
    kit: {
      species_id: row.species_id,
      affinity: 'Plant',
      level: row.level,
      stats: row.stats,
      base_speed: 43,
      class: 'Walk',
      skills: [S11, S12],
    },
    pos: row.pos,
    cur_hp: row.cur_hp,
    status: row.status,
    budget: row.budget,
    guard: row.guard,
    first_stand: row.first_stand,
    state: row.state,
  };
}
const U = joinRow(LIVE.units[0] as UnitRow);

function trace(hpAfter: number): PipelineTrace {
  return {
    hit: true,
    d0: 61,
    d1: 67,
    d2: 71,
    d3: 73,
    effectiveness: 'Neutral',
    applied: 79,
    hp_after: hpAfter,
    stood_ground: false,
  };
}
function forecastOut(hpAfter: number, killsMin: boolean): ForecastOut {
  return {
    hit_pct: 83,
    stab: false,
    flank: false,
    guard: false,
    effectiveness: 'Neutral',
    min: trace(hpAfter),
    max: trace(2),
    kills_min: killsMin,
    kills_max: true,
    first_stand_saves: false,
    status: null,
    status_blocked: false,
    flank_factor: [5, 4],
    guard_factor: [3, 4],
    type_factor: [1, 1],
  };
}

// --- the fake rules ---------------------------------------------------------------------------

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

interface Script {
  readonly path?: (board: RulesBoard, mover: number, dest: Cell) => RuleResult<Path, PathError>;
  readonly disengage?: (
    board: RulesBoard,
    mover: number,
    start: Cell | undefined,
  ) => RuleResult<boolean, PathError>;
  readonly targets?: (
    board: RulesBoard,
    caster: number,
    skillId: number,
    aim: Cell,
  ) => RuleResult<number[], GeometryError>;
}

const notDraft = (name: string) => (): never => {
  throw new Error(`fake: ${name} is not a draft rule`);
};

/** The default answers: a path to (2,1) or (2,2) is Ok, to (3,1) occupied; skill 12 at W31's
 *  tile (3,1) hits [31, 17]; skill 11 at (2,1) hits [17]; W31 is flanked from U, W17 is not; the
 *  forecast on W31 leaves 37 HP, on W17 29 HP with kills_min. */
function fakeRules(s: Script = {}): { readonly rules: TacticsRules; readonly calls: Call[] } {
  const calls: Call[] = [];
  const rules: TacticsRules = {
    map: notDraft('map'),
    freshBudget: notDraft('freshBudget'),
    unit: (row) => {
      calls.push({ name: 'unit', args: [row] });
      return joinRow(row);
    },
    targets: (board, caster, skillId, aim) => {
      calls.push({ name: 'targets', args: [board, caster, skillId, aim] });
      if (s.targets !== undefined) return s.targets(board, caster, skillId, aim);
      if (skillId === 12 && aim.x === 3 && aim.y === 1) return { Ok: [31, 17] };
      if (skillId === 11 && aim.x === 2 && aim.y === 1) return { Ok: [17] };
      return { Err: 'NoTargetUnit' };
    },
    path: (board, mover, dest) => {
      calls.push({ name: 'path', args: [board, mover, dest] });
      if (s.path !== undefined) return s.path(board, mover, dest);
      const ok = (dest.x === 2 && dest.y === 1) || (dest.x === 2 && dest.y === 2);
      return ok ? { Ok: { steps: [dest], cost: 3 } } : { Err: 'DestOccupied' };
    },
    disengage: (board, mover, start) => {
      calls.push({ name: 'disengage', args: [board, mover, start] });
      if (s.disengage !== undefined) return s.disengage(board, mover, start);
      return { Ok: start === undefined };
    },
    flank: (board, attacker, target) => {
      calls.push({ name: 'flank', args: [board, attacker, target] });
      return target === 31;
    },
    forecast: (attacker, target, skillId, flank) => {
      calls.push({ name: 'forecast', args: [attacker, target, skillId, flank] });
      return target.id === 17 ? forecastOut(29, true) : forecastOut(37, false);
    },
    recruitOdds: notDraft('recruitOdds'),
    aiPlan: notDraft('aiPlan'),
    recruitTargets: notDraft('recruitTargets'),
    isExhausted: notDraft('isExhausted'),
    plan: notDraft('plan'),
    overlays: notDraft('overlays'),
  };
  return { rules, calls };
}

const callsOf = (calls: readonly Call[], name: string): Call[] =>
  calls.filter((x) => x.name === name);
function rowIn(board: RulesBoard, id: number): UnitRow {
  const r = board.units.find((u) => u.id === id);
  if (r === undefined) throw new Error(`no unit ${id} on the board`);
  return r;
}

const MOVE_2_1: QueuedActionRule = { Move: { x: 2, y: 1, strides: 1 } };
const MOVE_3_1: QueuedActionRule = { Move: { x: 3, y: 1, strides: 2 } };
const SKILL_12_ON_31: QueuedActionRule = { Skill: { skill_id: 12, target: { Unit: 31 } } };
const SKILL_11_SELF: QueuedActionRule = { Skill: { skill_id: 11, target: 'SelfTarget' } };

// --- editing ------------------------------------------------------------------------------------

describe('draft: editing (BT11.2)', () => {
  it('BT11-2-DRAFT-EDIT: push and pop return NEW drafts and never touch the one they are given, pop on an empty draft is that same draft, and only a Move is reversible (Skill, Item, Recruit, Flee and End commit)', () => {
    // WRONG IMPL KILLED: a push that mutates the draft (the shell's previous frame would change
    // under it; the frozen input throws); a pop that drops the FIRST chip; a pop on empty that
    // throws or invents a draft; the unit id lost; a Move treated as irreversible (B could not undo
    // a planned step: BT11.2 "B pops the last chip for free") or an attack treated as free (it would
    // never be submitted).
    const empty = deepFreeze(emptyDraft(5));
    expect(empty, 'fixture: an empty draft of unit 5').toEqual({ unitId: 5, actions: [] });
    const one = push(empty, MOVE_2_1);
    expect(one, 'push: the action appended').toEqual({ unitId: 5, actions: [MOVE_2_1] });
    expect(one, 'push returns a new draft').not.toBe(empty);
    expect(empty.actions, 'the input draft is untouched').toEqual([]);
    const two: Draft = deepFreeze(push(deepFreeze(one), SKILL_12_ON_31));
    expect(two.actions, 'push appends at the end').toEqual([MOVE_2_1, SKILL_12_ON_31]);
    expect(one.actions, 'the earlier draft is untouched').toEqual([MOVE_2_1]);

    const back = pop(two);
    expect(back, 'pop: the LAST action removed').toEqual({ unitId: 5, actions: [MOVE_2_1] });
    expect(back, 'pop returns a new draft').not.toBe(two);
    expect(two.actions, 'the popped draft is untouched').toEqual([MOVE_2_1, SKILL_12_ON_31]);
    expect(pop(deepFreeze(back)), 'pop to empty').toEqual({ unitId: 5, actions: [] });
    expect(pop(empty), 'pop on an empty draft is the same draft').toBe(empty);

    const kinds: readonly (readonly [QueuedActionRule, boolean])[] = [
      [MOVE_2_1, false],
      [SKILL_12_ON_31, true],
      [SKILL_11_SELF, true],
      [{ Item: { item_id: 7, target: 'SelfTarget' } }, true],
      [{ Recruit: { target: 31, bait: null } }, true],
      ['Flee', true],
      ['EndTurn', true],
    ];
    for (const [action, irreversible] of kinds) {
      expect(isIrreversible(action), `isIrreversible(${JSON.stringify(action)})`).toBe(
        irreversible,
      );
    }
  });
});

// --- costing and applying -------------------------------------------------------------------------

describe('draft: costing and applying (BT11.2, REV 5 A25)', () => {
  it('BT11-2-DRAFT-COST: costEntries asks the rules for each Move`s disengage tax at its CHAINED start tile on the live board and takes a Skill`s tier from the kit; applyPlan moves the row only along an Ok path, sets each hit target`s HP and Fainted state from the rules` forecast at the caster`s moved tile, and halts the rest of the plan at the first refusal — never mutating the board; applyAction, the one step it folds, answers null for a refused Move or Skill and for a unit not on the board, and the very same board for Recruit, Flee, End and Item', () => {
    // WRONG IMPL KILLED: the tax computed in TS (an adjacency test) or always judged at the unit's
    // own tile (the second Move must be taxed at the FIRST Move's destination: the fake says
    // untaxed there); `taxed` hard-coded; strides not copied from the action; the tier from the
    // skill id or a table instead of the unit's kit; an unknown skill or a refused tax silently
    // costed; a Move applied though the path is refused, or a refused step skipped while the rest of
    // the plan still runs; a Skill whose bound unit is not in the rules' hit set still applied; HP
    // computed from damage numbers instead of copying `min.hp_after`; Fainted read from
    // `hp_after === 0` instead of `kills_min`; the forecast or the flank judged from the caster's
    // LIVE tile; SelfTarget aimed anywhere but the caster's (moved) tile; the input board mutated.

    // costEntries — two Moves and a Skill.
    {
      const { rules, calls } = fakeRules();
      const entries = costEntries(rules, LIVE, U, [MOVE_3_1, MOVE_2_1, SKILL_12_ON_31]);
      expect(
        entries,
        'Move taxes from the rules (taxed, then untaxed), the kit`s Heavy tier',
      ).toEqual([
        { Move: { strides: 2, taxed: true } },
        { Move: { strides: 1, taxed: false } },
        { Attack: 'Heavy' },
      ]);
      const taxes = callsOf(calls, 'disengage');
      expect(taxes, 'one tax question per Move').toHaveLength(2);
      expect(taxes[0]?.args[0], 'the first Move: on the live board').toEqual(LIVE);
      expect(taxes[0]?.args[1], 'the mover is the unit').toBe(5);
      expect(taxes[0]?.args[2], 'the first Move starts on the unit`s tile (no start)').toBe(
        undefined,
      );
      expect(taxes[1]?.args[0], 'the second Move: still the live board').toEqual(LIVE);
      expect(taxes[1]?.args[2], 'the second Move starts where the first ends').toEqual(c(3, 1));
      expect(JSON.stringify(LIVE), 'the live board is untouched').toBe(LIVE_JSON);
    }
    {
      const { rules } = fakeRules({ disengage: () => ({ Ok: true }) });
      expect(
        costEntries(rules, LIVE, U, [MOVE_2_1, { Skill: { skill_id: 11, target: 'SelfTarget' } }]),
        'taxed copied from the rules (true), Light from the kit',
      ).toEqual([{ Move: { strides: 1, taxed: true } }, { Attack: 'Light' }]);
    }
    {
      const { rules } = fakeRules();
      const mapped: readonly (readonly [QueuedActionRule, unknown])[] = [
        [{ Recruit: { target: 31, bait: null } }, 'Recruit'],
        [{ Recruit: { target: 31, bait: 43 } }, 'Recruit'],
        ['Flee', 'Flee'],
        ['EndTurn', 'EndTurn'],
        [{ Item: { item_id: 7, target: { Unit: 2 } } }, 'Item'],
      ];
      for (const [action, entry] of mapped) {
        expect(
          costEntries(rules, LIVE, U, [action]),
          `costEntries(${JSON.stringify(action)})`,
        ).toEqual([entry]);
      }
      expect(
        () => costEntries(rules, LIVE, U, [{ Skill: { skill_id: 99, target: { Unit: 31 } } }]),
        'a skill outside the kit throws',
      ).toThrow();
    }
    {
      const { rules } = fakeRules({ disengage: () => ({ Err: 'OutOfBounds' }) });
      expect(() => costEntries(rules, LIVE, U, [MOVE_2_1]), 'a refused tax throws').toThrow();
    }

    // applyPlan — a Move, then a Skill on W31 that also hits W17.
    {
      const { rules, calls } = fakeRules();
      const out = applyPlan(rules, LIVE, 5, [MOVE_2_1, SKILL_12_ON_31]);
      expect(JSON.stringify(LIVE), 'the input board is untouched').toBe(LIVE_JSON);
      expect(rowIn(out, 5), 'U moved to (2,1), nothing else of its row changed').toEqual({
        ...rowIn(LIVE, 5),
        pos: c(2, 1),
      });
      expect([rowIn(out, 31).cur_hp, rowIn(out, 31).state], 'W31: min.hp_after 37').toEqual([
        37,
        'Active',
      ]);
      expect(
        [rowIn(out, 17).cur_hp, rowIn(out, 17).state],
        'W17: min.hp_after 29 and kills_min: Fainted',
      ).toEqual([29, 'Fainted']);
      expect(rowIn(out, 2), 'the ally is untouched').toEqual(rowIn(LIVE, 2));
      expect(
        callsOf(calls, 'path').map((x) => [x.args[1], x.args[2]]),
        'one path question: U to (2,1)',
      ).toEqual([[5, c(2, 1)]]);
      const aim = callsOf(calls, 'targets');
      expect(
        aim.map((x) => [x.args[1], x.args[2], x.args[3]]),
        'skill 12 aimed at W31`s tile',
      ).toEqual([[5, 12, c(3, 1)]]);
      expect(
        rowIn(aim[0]?.args[0] as RulesBoard, 5).pos,
        'the hit set is asked on the board AFTER the Move',
      ).toEqual(c(2, 1));
      const fc = callsOf(calls, 'forecast');
      expect(
        fc.map((x) => [
          (x.args[0] as RulesUnit).id,
          (x.args[0] as RulesUnit).pos,
          (x.args[1] as RulesUnit).id,
          x.args[2],
          x.args[3],
        ]),
        'one forecast per hit target: the caster AT ITS MOVED TILE, the skill, the rules` flank',
      ).toEqual([
        [5, c(2, 1), 31, 12, true],
        [5, c(2, 1), 17, 12, false],
      ]);
      const flanks = callsOf(calls, 'flank');
      expect(
        flanks.map((x) => [x.args[1], x.args[2]]),
        'flank asked per target',
      ).toEqual([
        [5, 31],
        [5, 17],
      ]);
      for (const f of flanks) {
        expect(rowIn(f.args[0] as RulesBoard, 5).pos, 'flank on the moved board').toEqual(c(2, 1));
      }
    }
    // A refused Move halts the plan: nothing after it happens.
    {
      const { rules, calls } = fakeRules();
      const out = applyPlan(rules, LIVE, 5, [MOVE_3_1, MOVE_2_1, SKILL_12_ON_31]);
      expect(out.units, 'a refused first Move: the board as it was').toEqual(LIVE.units);
      expect(callsOf(calls, 'path'), 'and the later Move is never asked').toHaveLength(1);
      expect(callsOf(calls, 'forecast'), 'nor the Skill').toEqual([]);
    }
    // A Skill whose bound unit is not in the hit set halts (and so does a refused aim).
    const refusals: readonly (readonly [string, () => RuleResult<number[], GeometryError>])[] = [
      ['W31 not in the set', () => ({ Ok: [17] })],
      ['the aim refused', () => ({ Err: 'NoLineOfSight' })],
    ];
    for (const [label, targets] of refusals) {
      const { rules, calls } = fakeRules({ targets });
      const out = applyPlan(rules, LIVE, 5, [SKILL_12_ON_31, MOVE_2_1]);
      expect(out.units, `${label}: nothing changes`).toEqual(LIVE.units);
      expect(callsOf(calls, 'forecast'), `${label}: no forecast`).toEqual([]);
      expect(callsOf(calls, 'path'), `${label}: the later Move is never asked`).toEqual([]);
    }
    // SelfTarget aims at the caster's (moved) tile.
    {
      const { rules, calls } = fakeRules();
      const out = applyPlan(rules, LIVE, 5, [MOVE_2_1, SKILL_11_SELF]);
      expect(
        callsOf(calls, 'targets').map((x) => [x.args[1], x.args[2], x.args[3]]),
        'SelfTarget: skill 11 aimed at the caster`s moved tile',
      ).toEqual([[5, 11, c(2, 1)]]);
      expect([rowIn(out, 17).cur_hp, rowIn(out, 17).state], 'W17 hit by the Burst').toEqual([
        29,
        'Fainted',
      ]);
      expect(rowIn(out, 31).cur_hp, 'W31 not in the Burst`s set: untouched').toBe(47);
    }
    // The non-board kinds change nothing.
    {
      const { rules } = fakeRules();
      for (const action of [
        'EndTurn',
        'Flee',
        { Recruit: { target: 31, bait: null } },
        { Item: { item_id: 7, target: 'SelfTarget' } },
      ] as const satisfies readonly QueuedActionRule[]) {
        expect(
          applyPlan(rules, LIVE, 5, [action]).units,
          `${JSON.stringify(action)} changes nothing`,
        ).toEqual(LIVE.units);
      }
    }

    // bt-11 round 4 (REV 6 R6.1 / REV 6.2 C19): applyAction, the ONE step. WRONG IMPL KILLED: a
    // refused Move or Skill answered with the unchanged board instead of null (the strip could not
    // tell a stale chip from a legal Recruit); a Skill applied although its bound unit is not in the
    // hit set; a non-board kind answered with a COPY or null (the strip chains `?? board_i`, and a
    // null would read as stale); the step mutating the board; a caster that is not on the board
    // moved anyway (the fake path says Ok for (2,1)).
    {
      const { rules, calls } = fakeRules();
      expect(applyAction(rules, LIVE, 5, MOVE_3_1), 'a refused Move (path Err) is null').toBeNull();
      const moved = applyAction(rules, LIVE, 5, MOVE_2_1);
      expect(moved, 'an accepted Move is a NEW board').not.toBe(LIVE);
      expect(moved === null ? null : rowIn(moved, 5), 'the row at the destination').toEqual({
        ...rowIn(LIVE, 5),
        pos: c(2, 1),
      });
      expect(
        moved === null ? null : moved.units.filter((u) => u.id !== 5),
        'every other row as it was',
      ).toEqual(LIVE.units.filter((u) => u.id !== 5));
      expect(
        callsOf(calls, 'path').map((x) => [x.args[1], x.args[2]]),
        'one path question per Move',
      ).toEqual([
        [5, c(3, 1)],
        [5, c(2, 1)],
      ]);
      const hit = applyAction(rules, LIVE, 5, SKILL_12_ON_31);
      expect(
        hit === null ? null : [rowIn(hit, 31).cur_hp, rowIn(hit, 31).state],
        'a Skill: W31 at the forecast`s min.hp_after 37',
      ).toEqual([37, 'Active']);
      expect(
        hit === null ? null : [rowIn(hit, 17).cur_hp, rowIn(hit, 17).state],
        'and W17 (also hit) at 29, Fainted on kills_min',
      ).toEqual([29, 'Fainted']);
      expect(
        applyAction(rules, LIVE, 99, MOVE_2_1),
        'a unit that is not on the board: null (never a row invented at the destination)',
      ).toBeNull();
      for (const action of [
        'EndTurn',
        'Flee',
        { Recruit: { target: 31, bait: 43 } },
        { Item: { item_id: 7, target: 'SelfTarget' } },
      ] as const satisfies readonly QueuedActionRule[]) {
        expect(
          applyAction(rules, LIVE, 5, action),
          `${JSON.stringify(action)}: the SAME board object`,
        ).toBe(LIVE);
      }
      expect(JSON.stringify(LIVE), 'the board is untouched by every step').toBe(LIVE_JSON);
    }
    for (const [label, targets] of refusals) {
      const { rules, calls } = fakeRules({ targets });
      expect(applyAction(rules, LIVE, 5, SKILL_12_ON_31), `applyAction, ${label}: null`).toBeNull();
      expect(callsOf(calls, 'forecast'), `applyAction, ${label}: no forecast`).toEqual([]);
    }
  });
});

// --- the wire shape -------------------------------------------------------------------------------

describe('draft: the submit_queue wire (BT11.2)', () => {
  it('BT11-2-DRAFT-WIRE: toWire maps every action to the generated QueuedAction binding shape in order — Move, Skill on a unit or on itself, Item, Recruit with and without a bait (null becomes undefined), Flee, EndTurn', () => {
    // WRONG IMPL KILLED: the serde shape sent as is ({Move:{…}} — the SDK rejects it); skill_id /
    // item_id not renamed to skillId / itemId; an ActionTarget left as {Unit: id} or 'SelfTarget'
    // instead of {tag, value} / {tag}; a null bait sent as null (the binding's option is undefined)
    // or a real bait dropped; Flee / EndTurn given a value; the order changed; a variant missing
    // from the switch (it would throw or fall through).
    const actions: readonly QueuedActionRule[] = [
      { Move: { x: 3, y: 4, strides: 2 } },
      { Skill: { skill_id: 12, target: { Unit: 31 } } },
      { Skill: { skill_id: 11, target: 'SelfTarget' } },
      { Item: { item_id: 5, target: { Unit: 2 } } },
      { Item: { item_id: 7, target: 'SelfTarget' } },
      { Recruit: { target: 31, bait: null } },
      { Recruit: { target: 17, bait: 43 } },
      'Flee',
      'EndTurn',
    ];
    // Typed as the generated binding: the expected wire must itself be a valid QueuedAction[].
    const want: QueuedAction[] = [
      { tag: 'Move', value: { x: 3, y: 4, strides: 2 } },
      { tag: 'Skill', value: { skillId: 12, target: { tag: 'Unit', value: 31 } } },
      { tag: 'Skill', value: { skillId: 11, target: { tag: 'SelfTarget' } } },
      { tag: 'Item', value: { itemId: 5, target: { tag: 'Unit', value: 2 } } },
      { tag: 'Item', value: { itemId: 7, target: { tag: 'SelfTarget' } } },
      { tag: 'Recruit', value: { target: 31, bait: undefined } },
      { tag: 'Recruit', value: { target: 17, bait: 43 } },
      { tag: 'Flee' },
      { tag: 'EndTurn' },
    ];
    const wire: QueuedAction[] = toWire(actions);
    expect(wire, 'every variant, in order').toEqual(want);
    expect(wire, 'one entry per action').toHaveLength(actions.length);
    const noBait = wire[5];
    expect(
      noBait?.tag === 'Recruit' ? noBait.value.bait : 'not a Recruit',
      'a null bait is undefined on the wire',
    ).toBe(undefined);
    const bait = wire[6];
    expect(bait?.tag === 'Recruit' ? bait.value.bait : 'not a Recruit', 'a bait is kept').toBe(43);
    expect(toWire([]), 'an empty plan is an empty wire').toEqual([]);
    expect(toWire(['EndTurn']), 'End alone').toEqual([{ tag: 'EndTurn' }]);
  });
});

// --- the cancel race --------------------------------------------------------------------------------

describe('draft: the Too-late notice (BT11.3, REV 5 A37)', () => {
  it('BT11-3-TOO-LATE: isAlreadyActing is true only for a SenderError whose message is exactly cancel_queue: AlreadyActing — false for another reason, another reducer, another error class, a bare string and anything else, and it never throws (a hostile getter); the notice reads Too late — already acting in English and has its own French', () => {
    // WRONG IMPL KILLED: a substring match (submit_queue's AlreadyActing, or a padded message, would
    // show the cancel notice); the error class ignored (an InternalError or a plain Error carrying
    // the words); `instanceof` instead of the name (the SDK's classes cross bundle chunks); a throw on
    // a hostile `name` / `message` getter (inside a promise rejection handler the player would see
    // nothing); the notice hard-coded or its dash a hyphen; the French left as the English copy.
    const sender = (message: string): Error => {
      const e = new Error(message);
      e.name = 'SenderError';
      return e;
    };
    expect(isAlreadyActing(sender('cancel_queue: AlreadyActing')), 'the cancel race').toBe(true);
    const internal = new Error('cancel_queue: AlreadyActing');
    internal.name = 'InternalError';
    const hostileName = {
      get name(): string {
        throw new Error('hostile name');
      },
    };
    const hostileMessage = {
      name: 'SenderError',
      get message(): string {
        throw new Error('hostile message');
      },
    };
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile proxy');
        },
      },
    );
    const notIt: readonly (readonly [string, unknown])[] = [
      ['another cancel reason', sender('cancel_queue: NoPlan')],
      ['the submit reducer`s AlreadyActing', sender('submit_queue: AlreadyActing')],
      ['a padded message', sender('cancel_queue: AlreadyActing ')],
      ['another case', sender('cancel_queue: alreadyacting')],
      ['the bare reason', sender('AlreadyActing')],
      ['an InternalError with the words', internal],
      ['a plain Error with the words', new Error('cancel_queue: AlreadyActing')],
      ['a bare string', 'cancel_queue: AlreadyActing'],
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an empty object', {}],
      ['a hostile name getter', hostileName],
      ['a hostile message getter', hostileMessage],
      ['a hostile proxy', trap],
    ];
    for (const [label, err] of notIt) {
      let got: unknown = 'threw';
      expect(() => {
        got = isAlreadyActing(err);
      }, `${label}: never throws`).not.toThrow();
      expect(got, `${label}: not the cancel race`).toBe(false);
    }

    const en = EN['tactics.queue.tooLate'];
    expect(en, 'the English notice, U+2014 by code point').toBe(
      `Too late ${EM_DASH} already acting`,
    );
    expect(typeof FR['tactics.queue.tooLate'], 'a French notice exists').toBe('string');
    expect(FR['tactics.queue.tooLate'], 'and is not the English copy').not.toBe(en);
  });
});
