// tactics/provisionalBoard.test.ts — bt-11 round-4 RED tests for the PROVISIONAL board (BT11.5): the
// live rows with this player's own READY / DRAFT plans applied in initiative order, each wild's
// `ai::plan` applied at its turn in PvE (asked of the board as it stands then), enemies frozen in
// PvP, a blocked (asleep / frozen) wild skipped, a unit KO'd earlier in the walk acting no more, the
// walk stopping BEFORE `upTo`, and the PvP enemies walked before `upTo` reported as hidden.
//
// SOURCE OF TRUTH: spec `### bt-11` BT11.5; the plan (memory/projects/monster-realm-bt-11-plan.md)
// REV 6 R6.3 as amended by REV 6.1 C3 (the walk as a table; `wilds`), C4 (`Projection = {board,
// hidden}`) and REV 6.2 C19 (the `upTo` stop tested FIRST, duplicate plans throw, the wild arm gated
// on kind 'wild'). The frozen exports of client/src/tactics/provisionalBoard.ts (`project`,
// `ProjectInput`, `Projection`, `PlanInput`) are the contract.
//
// HOW THE EXPECTED VALUES ARE BUILT: a recording FAKE `TacticsRules` (the draft.test.ts shape): every
// path is Ok, the target sets are a geometry-free stand-in answering by the board it is GIVEN, each
// wild's plan and each target's forecast are scripted per id, and every call is recorded with its
// arguments (so the board a wild's plan is asked of, the number of path questions and the forecast
// arguments are observable). HP numbers are primes no arithmetic lands on (wild 3 at 50 HP, the
// forecast's min.d3 73 and min.hp_after 23: a TypeScript subtraction would give 0 or -23). The
// boards handed in are deep-frozen and compared with their JSON afterwards. One untagged scenario
// (plan REV 6.1 C14) runs the REAL rules on content map 1: a wild KO'd mid-walk never acts.
//
// RED REASON: `project` throws `bt-11: not implemented`.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { beforeAll, describe, expect, it } from 'vitest';
import { loadWasmPkg } from '../../test-util/wasmPkg';
import { type PlanInput, type ProjectInput, type Projection, project } from './provisionalBoard';
import {
  bindTacticsRules,
  type Cell,
  type ForecastOut,
  type GeometryError,
  type PipelineTrace,
  type QueuedActionRule,
  type RuleResult,
  type RulesBoard,
  type RulesUnit,
  type SkillTactics,
  type TacticsRules,
  type TacticsWasmExports,
  type TurnBudget,
  type UnitRow,
} from './wasm';

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

function rowAt(
  id: number,
  side: 'A' | 'B',
  slot: number,
  at: Cell,
  hp: number,
  wild: number | null,
): UnitRow {
  return {
    id,
    side,
    slot,
    species_id: 1,
    level: 10,
    stats: { hp: 97, attack: 10, defense: 10, speed: 10, sp_attack: 10, sp_defense: 10 },
    pos: at,
    cur_hp: hp,
    status: null,
    budget: { ap: 0, strides_used: 0, attacks: 0, last: null },
    guard: false,
    first_stand: false,
    state: 'Active',
    stance: wild === null ? null : 'Aggressive',
    wild_index: wild,
  };
}

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

/** PvE: own 1 (1,1) 41 HP, own 2 (3,2) 43 HP, wild 3 (5,1) 50 HP wild_index 0, wild 4 (5,3) 47 HP
 *  wild_index 1. Deep-frozen. */
const LIVE: RulesBoard = deepFreeze<RulesBoard>({
  kind: 'Wild',
  map_id: 1,
  units: [
    rowAt(1, 'A', 0, c(1, 1), 41, null),
    rowAt(2, 'A', 1, c(3, 2), 43, null),
    rowAt(3, 'B', 0, c(5, 1), 50, 0),
    rowAt(4, 'B', 1, c(5, 3), 47, 1),
  ],
});
const LIVE_JSON = JSON.stringify(LIVE);

/** PvP: the same tiles, 3 and 4 the opponent's player units (no wild_index). Deep-frozen. */
const PVP: RulesBoard = deepFreeze<RulesBoard>({
  kind: 'Pvp',
  map_id: 1,
  units: [
    rowAt(1, 'A', 0, c(1, 1), 41, null),
    rowAt(2, 'A', 1, c(3, 2), 43, null),
    rowAt(3, 'B', 0, c(5, 1), 50, null),
    rowAt(4, 'B', 1, c(5, 3), 47, null),
  ],
});
const PVP_JSON = JSON.stringify(PVP);

function rowIn(board: RulesBoard, id: number): UnitRow {
  const r = board.units.find((u) => u.id === id);
  if (r === undefined) throw new Error(`no unit ${id} on the board`);
  return r;
}
const posOf = (board: RulesBoard, id: number): Cell => rowIn(board, id).pos;

function trace(d3: number, hpAfter: number): PipelineTrace {
  return {
    hit: true,
    d0: 151,
    d1: 157,
    d2: 163,
    d3,
    effectiveness: 'Neutral',
    applied: 167,
    hp_after: hpAfter,
    stood_ground: false,
  };
}
/** A forecast whose min roll leaves `minAfter` (a prime no `cur_hp - d3` lands on). */
function fc(minD3: number, minAfter: number, killsMin: boolean): ForecastOut {
  return {
    hit_pct: 83,
    stab: false,
    flank: false,
    guard: false,
    effectiveness: 'Neutral',
    min: trace(minD3, minAfter),
    max: trace(minD3 + 6, 0),
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

type TargetsFn = (
  board: RulesBoard,
  caster: number,
  skillId: number,
  aim: Cell,
) => RuleResult<number[], GeometryError>;

interface Script {
  /** Each wild's plan by unit id (default ['EndTurn']). */
  readonly aiPlan?: ReadonlyMap<number, readonly QueuedActionRule[]>;
  /** The forecast by TARGET id (default min.d3 73, min.hp_after 23, no KO). */
  readonly forecastFor?: ReadonlyMap<number, ForecastOut>;
  readonly targets?: TargetsFn;
  /** What `flank` answers (default false). */
  readonly flank?: boolean;
}

interface Fake {
  readonly rules: TacticsRules;
  readonly calls: Call[];
}

/** Skill 11 at the (Active) caster's own tile hits every conscious unit of the other side; skill 12
 *  hits the conscious enemy standing on the aim — answered by the board GIVEN. */
const standIn: TargetsFn = (board, caster, skillId, aim) => {
  const me = board.units.find((u) => u.id === caster);
  if (me === undefined || me.state !== 'Active') return { Err: { UnknownCaster: caster } };
  const foes = board.units.filter((u) => u.side !== me.side && u.state === 'Active');
  if (skillId === 11) {
    return aim.x === me.pos.x && aim.y === me.pos.y
      ? { Ok: foes.map((u) => u.id) }
      : { Err: 'AimNotCaster' };
  }
  const on = foes.find((u) => u.pos.x === aim.x && u.pos.y === aim.y);
  return on === undefined ? { Err: 'NoTargetUnit' } : { Ok: [on.id] };
};

const notProjection = (name: string) => (): never => {
  throw new Error(`fake: ${name} is not a projection rule`);
};

const DEFAULT_FC = fc(73, 23, false);
/** A wild's default plan: hold. */
const END_ONLY: readonly QueuedActionRule[] = ['EndTurn'];

function fakeRules(s: Script = {}): Fake {
  const calls: Call[] = [];
  const rec = (name: string, args: readonly unknown[]): void => {
    calls.push({ name, args });
  };
  const rules: TacticsRules = {
    map: notProjection('map'),
    freshBudget: notProjection('freshBudget'),
    unit: (row) => {
      rec('unit', [row]);
      return joinRow(row);
    },
    targets: (board, caster, skillId, aim) => {
      rec('targets', [board, caster, skillId, aim]);
      return (s.targets ?? standIn)(board, caster, skillId, aim);
    },
    path: (board, mover, dest) => {
      rec('path', [board, mover, dest]);
      return { Ok: { steps: [dest], cost: 3 } };
    },
    disengage: notProjection('disengage'),
    flank: (board, attacker, target) => {
      rec('flank', [board, attacker, target]);
      return s.flank ?? false;
    },
    forecast: (attacker, target, skillId, flank) => {
      rec('forecast', [attacker, target, skillId, flank]);
      return s.forecastFor?.get(target.id) ?? DEFAULT_FC;
    },
    recruitOdds: notProjection('recruitOdds'),
    aiPlan: (board, unit) => {
      rec('aiPlan', [board, unit]);
      return [...(s.aiPlan?.get(unit) ?? END_ONLY)];
    },
    recruitTargets: notProjection('recruitTargets'),
    isExhausted: notProjection('isExhausted'),
    plan: notProjection('plan'),
    overlays: notProjection('overlays'),
  };
  return { rules, calls };
}

const callsOf = (calls: readonly Call[], name: string): Call[] =>
  calls.filter((x) => x.name === name);
/** The unit ids `aiPlan` was asked about, in call order. */
const aiAsked = (f: Fake): unknown[] => callsOf(f.calls, 'aiPlan').map((x) => x.args[1]);
const hiddenOf = (p: Projection): number[] => [...p.hidden].sort((a, b) => a - b);

/** `project` over the fixture defaults: PvE, side A, nothing blocked, the wilds applied. */
function walk(f: Fake, live: RulesBoard, o: Partial<ProjectInput>): Projection {
  return project(f.rules, live, {
    kind: 'wild',
    mySide: 'A',
    order: [],
    plans: [],
    blocked: new Set<number>(),
    wilds: true,
    ...o,
  });
}

const M1: QueuedActionRule = { Move: { x: 2, y: 1, strides: 1 } };
const M2: QueuedActionRule = { Move: { x: 3, y: 1, strides: 1 } };
const SKILL_12_ON = (id: number): QueuedActionRule => ({
  Skill: { skill_id: 12, target: { Unit: id } },
});
const PLANS: readonly PlanInput[] = [
  { unitId: 1, actions: [M1] },
  { unitId: 2, actions: [M2] },
];

// --- the tagged tests -------------------------------------------------------------------------

describe('provisionalBoard: the walk (BT11.5)', () => {
  it('BT11-5-PROJECT-ORDER: own plans apply in the order given, each unit once although the order holds two rounds; the walk stops before upTo (also when upTo was KO`d on the way); an empty order is the live board; a plan for a unit outside the order or a Fainted unit is not applied; duplicate plans throw; and the live board is never mutated', () => {
    // WRONG IMPL KILLED: the second round applied again (each Move asked of `path` twice, a wild
    // planned twice); `upTo` ignored (unit 2 moved although the walk must stop before it) or
    // treated as "stop after"; the `upTo` stop tested after the Fainted skip (a U KO'd by an
    // earlier wild is skipped and the walk runs on into wild 4 — REV 6.2 C19); a plan applied for a
    // unit the order never reaches, or for a Fainted own unit; a second plan for one unit silently
    // merged or ignored instead of refused; `live` mutated (the boards are frozen).
    const order = [1, 3, 2, 4, 1, 3, 2, 4];

    const all = fakeRules();
    const p = walk(all, LIVE, { order, plans: PLANS });
    expect(posOf(p.board, 1), 'unit 1 at its planned (2,1)').toEqual(c(2, 1));
    expect(posOf(p.board, 2), 'unit 2 at its planned (3,1)').toEqual(c(3, 1));
    expect(
      callsOf(all.calls, 'path').map((x) => [x.args[1], x.args[2]]),
      'one path question per planned Move: the second round is skipped',
    ).toEqual([
      [1, c(2, 1)],
      [2, c(3, 1)],
    ]);
    expect(aiAsked(all), 'each wild planned once, in order').toEqual([3, 4]);
    expect(
      [posOf(p.board, 3), posOf(p.board, 4)],
      'the wilds hold (their plan is EndTurn)',
    ).toEqual([c(5, 1), c(5, 3)]);
    expect(hiddenOf(p), 'PvE: nothing hidden').toEqual([]);

    const upTo2 = fakeRules();
    const before2 = walk(upTo2, LIVE, { order, plans: PLANS, upTo: 2 });
    expect(
      [posOf(before2.board, 1), posOf(before2.board, 2)],
      'upTo 2: unit 1 moved, unit 2 NOT (the walk stops before it)',
    ).toEqual([c(2, 1), c(3, 2)]);
    expect(aiAsked(upTo2), 'upTo 2: only wild 3 walked before it').toEqual([3]);
    const upTo3 = fakeRules();
    const before3 = walk(upTo3, LIVE, { order, plans: PLANS, upTo: 3 });
    expect([posOf(before3.board, 1), posOf(before3.board, 2)], 'upTo 3: only unit 1').toEqual([
      c(2, 1),
      c(3, 2),
    ]);
    expect(aiAsked(upTo3), 'upTo 3: no wild walked').toEqual([]);
    const absent = walk(fakeRules(), LIVE, { order, plans: PLANS, upTo: 99 });
    expect(absent.board, 'an upTo the order never reaches: the whole walk').toEqual(p.board);

    const none = fakeRules();
    const empty = walk(none, LIVE, { order: [], plans: PLANS });
    expect(empty.board, 'an empty order: the live board').toEqual(LIVE);
    expect(hiddenOf(empty), 'and nothing hidden').toEqual([]);
    expect(callsOf(none.calls, 'path'), 'and no rule asked').toEqual([]);

    const outside = fakeRules();
    const skipped = walk(outside, LIVE, { order: [1, 3, 4], plans: PLANS });
    expect(
      posOf(skipped.board, 2),
      'a plan for a unit the order never reaches: not applied',
    ).toEqual(c(3, 2));
    expect(
      callsOf(outside.calls, 'path').map((x) => x.args[1]),
      'no path question for it',
    ).toEqual([1]);

    const LIVE5 = deepFreeze<RulesBoard>({
      ...LIVE,
      units: [...LIVE.units, { ...rowAt(5, 'A', 2, c(0, 4), 0, null), state: 'Fainted' }],
    });
    const fainted = fakeRules();
    const ko = walk(fainted, LIVE5, {
      order: [5, 1],
      plans: [
        { unitId: 5, actions: [{ Move: { x: 0, y: 3, strides: 1 } }] },
        PLANS[0] as PlanInput,
      ],
    });
    expect(posOf(ko.board, 5), 'a Fainted own unit`s plan is skipped').toEqual(c(0, 4));
    expect(
      callsOf(fainted.calls, 'path').map((x) => x.args[1]),
      'no path question for the Fainted unit; unit 1 still moves',
    ).toEqual([1]);

    expect(
      () =>
        walk(fakeRules(), LIVE, {
          order,
          plans: [
            { unitId: 1, actions: [M1] },
            { unitId: 1, actions: [M2] },
          ],
        }),
      'two plans for one unit are a programming error: project throws',
    ).toThrow();

    // REV 6.2 C19: wild 3 KOs unit 2 before 2's turn; upTo 2 still stops the walk before wild 4.
    const koU = fakeRules({
      aiPlan: new Map<number, readonly QueuedActionRule[]>([
        [3, [SKILL_12_ON(2)]],
        [4, [{ Move: { x: 4, y: 3, strides: 1 } }]],
      ]),
      forecastFor: new Map([[2, fc(73, 0, true)]]),
    });
    const stopped = walk(koU, LIVE, { order, plans: PLANS, upTo: 2 });
    expect(rowIn(stopped.board, 2).state, 'fixture: wild 3 KOs unit 2 on the way').toBe('Fainted');
    expect(
      aiAsked(koU),
      'the walk stopped at unit 2 although it is Fainted: wild 4 never planned',
    ).toEqual([3]);
    expect(posOf(stopped.board, 4), 'and wild 4 stays').toEqual(c(5, 3));

    expect(JSON.stringify(LIVE), 'the live board is never mutated').toBe(LIVE_JSON);
  });

  it('BT11-5-PROJECT-WILDS: each wild`s plan is asked of the board as it stands at the wild`s turn and applied (its Move and its attack); a blocked wild is not asked and holds; a wild KO`d earlier in the walk never acts; wilds: false and a PvP walk never ask aiPlan and hold every enemy while own plans still apply', () => {
    // WRONG IMPL KILLED: aiPlan asked of the LIVE board (unit 1's planned Move ignored by the wild
    // that acts after it); the wild's attack HP computed in TypeScript (41 - 61) instead of the
    // forecast's min.hp_after 13; `blocked` ignored (an asleep wild walks and strikes); a wild
    // Fainted by an earlier plan still planned and applied; `wilds: false` ignored (the danger board
    // would be the turn after next — C6); wilds walked in PvP (a pvp row with a wild_index is still
    // the opponent's frozen unit — C19).
    const wildPlans = new Map<number, readonly QueuedActionRule[]>([
      [3, [{ Move: { x: 4, y: 1, strides: 1 } }, SKILL_12_ON(1)]],
      [4, ['EndTurn']],
    ]);
    const hits1 = new Map([[1, fc(61, 13, false)]]);
    const order = [1, 3, 2, 4];

    const f = fakeRules({ aiPlan: wildPlans, forecastFor: hits1 });
    const p = walk(f, LIVE, { order, plans: [{ unitId: 1, actions: [M1] }] });
    const asked = callsOf(f.calls, 'aiPlan');
    expect(
      asked.map((x) => x.args[1]),
      'fixture: wild 3, then wild 4',
    ).toEqual([3, 4]);
    expect(
      posOf(asked[0]?.args[0] as RulesBoard, 1),
      'wild 3`s plan is asked with unit 1 ALREADY at (2,1)',
    ).toEqual(c(2, 1));
    expect(
      posOf(asked[1]?.args[0] as RulesBoard, 3),
      'wild 4`s plan is asked with wild 3 already moved to (4,1)',
    ).toEqual(c(4, 1));
    expect(posOf(p.board, 3), 'wild 3 ends where its plan moves it').toEqual(c(4, 1));
    expect(
      [rowIn(p.board, 1).cur_hp, rowIn(p.board, 1).state],
      'unit 1 at the forecast`s min.hp_after 13 (never 41 - 61), still Active',
    ).toEqual([13, 'Active']);
    const strike = callsOf(f.calls, 'forecast');
    expect(
      strike.map((x) => [
        (x.args[0] as RulesUnit).id,
        (x.args[0] as RulesUnit).pos,
        (x.args[1] as RulesUnit).id,
      ]),
      'the wild`s attack is forecast from its moved tile on unit 1',
    ).toEqual([[3, c(4, 1), 1]]);

    const blocked = fakeRules({ aiPlan: wildPlans, forecastFor: hits1 });
    const held = walk(blocked, LIVE, {
      order,
      plans: [{ unitId: 1, actions: [M1] }],
      blocked: new Set([3]),
    });
    expect(aiAsked(blocked), 'a blocked wild is never asked for a plan').toEqual([4]);
    expect(posOf(held.board, 3), 'and stays at (5,1)').toEqual(c(5, 1));
    expect(rowIn(held.board, 1).cur_hp, 'and unit 1`s HP is intact').toBe(41);
    expect(hiddenOf(held), 'a blocked wild is skipped, not hidden').toEqual([]);

    const killed = fakeRules({
      aiPlan: wildPlans,
      forecastFor: new Map([[3, fc(73, 0, true)]]),
    });
    const dead = walk(killed, LIVE, { order, plans: [{ unitId: 1, actions: [SKILL_12_ON(3)] }] });
    expect(rowIn(dead.board, 3).state, 'fixture: unit 1 KOs wild 3 first').toBe('Fainted');
    expect(aiAsked(killed), 'a wild KO`d earlier in the walk is never planned').toEqual([4]);
    expect(posOf(dead.board, 3), 'and never moves').toEqual(c(5, 1));

    const heldWilds = fakeRules({ aiPlan: wildPlans, forecastFor: hits1 });
    const danger = walk(heldWilds, LIVE, {
      order,
      plans: [{ unitId: 1, actions: [M1] }],
      wilds: false,
    });
    expect(aiAsked(heldWilds), 'wilds: false never asks aiPlan').toEqual([]);
    expect(
      [posOf(danger.board, 3), posOf(danger.board, 4), rowIn(danger.board, 1).cur_hp],
      'every wild holds its live tile and strikes nobody',
    ).toEqual([c(5, 1), c(5, 3), 41]);
    expect(posOf(danger.board, 1), 'own plans still apply').toEqual(c(2, 1));

    const pvp = fakeRules({ aiPlan: wildPlans, forecastFor: hits1 });
    const frozen = walk(pvp, LIVE, { kind: 'pvp', order, plans: [{ unitId: 1, actions: [M1] }] });
    expect(
      aiAsked(pvp),
      'PvP (even over rows that carry a wild_index): aiPlan is never asked',
    ).toEqual([]);
    expect([posOf(frozen.board, 3), posOf(frozen.board, 4)], 'every enemy frozen').toEqual([
      c(5, 1),
      c(5, 3),
    ]);
    expect(posOf(frozen.board, 1), 'own plans still apply in PvP').toEqual(c(2, 1));
    expect(JSON.stringify(LIVE), 'the live board is never mutated').toBe(LIVE_JSON);
  });

  it('BT11-5-PROJECT-HP: a Skill sets each hit target`s HP to the forecast`s min.hp_after and Fainted exactly when kills_min, asked with the rules` join of both rows, the skill id and the rules` flank; a Caster-origin Burst reduces every unit the rules say it hits; a Skill whose bound target is not hit halts the plan', () => {
    // WRONG IMPL KILLED: HP arithmetic (50 - 73 clamps to 0 or reads -23; the rules say 23); Fainted
    // read from hp_after instead of kills_min, or never set; the attacker or the target passed as a
    // raw row instead of `rules.unit(row)`; the flank computed or defaulted (the rules say true); a
    // Burst that reduces only its first target (wild 4 must drop to 19 too); a refused aim skipped
    // while the Move after it still runs.
    const forecastFor = new Map([
      [3, fc(73, 23, false)],
      [4, fc(79, 19, false)],
    ]);
    const f = fakeRules({ forecastFor, flank: true });
    const p = walk(f, LIVE, { order: [1], plans: [{ unitId: 1, actions: [SKILL_12_ON(3)] }] });
    expect(
      [rowIn(p.board, 3).cur_hp, rowIn(p.board, 3).state],
      'wild 3 (50 HP): the forecast`s min.hp_after 23, still Active',
    ).toEqual([23, 'Active']);
    const fcs = callsOf(f.calls, 'forecast');
    expect(fcs.length, 'one forecast for the one hit target').toBe(1);
    expect(fcs[0]?.args[0], 'the attacker is rules.unit(unit 1`s row)').toEqual(
      joinRow(rowIn(LIVE, 1)),
    );
    expect(fcs[0]?.args[1], 'the target is rules.unit(wild 3`s row)').toEqual(
      joinRow(rowIn(LIVE, 3)),
    );
    expect(
      [fcs[0]?.args[2], fcs[0]?.args[3]],
      'skill 12 and the rules` flank answer (true)',
    ).toEqual([12, true]);
    expect(
      callsOf(f.calls, 'flank').map((x) => [x.args[1], x.args[2]]),
      'flank asked for unit 1 on wild 3',
    ).toEqual([[1, 3]]);

    const lethal = walk(fakeRules({ forecastFor: new Map([[3, fc(73, 0, true)]]) }), LIVE, {
      order: [1],
      plans: [{ unitId: 1, actions: [SKILL_12_ON(3)] }],
    });
    expect(
      [rowIn(lethal.board, 3).cur_hp, rowIn(lethal.board, 3).state],
      'kills_min: Fainted at 0',
    ).toEqual([0, 'Fainted']);

    const burst = fakeRules({ forecastFor });
    const both = walk(burst, LIVE, {
      order: [1],
      plans: [{ unitId: 1, actions: [{ Skill: { skill_id: 11, target: 'SelfTarget' } }] }],
    });
    expect(
      [rowIn(both.board, 3).cur_hp, rowIn(both.board, 4).cur_hp],
      'the Burst reduces every conscious foe the rules list: 23 and 19',
    ).toEqual([23, 19]);
    expect(
      callsOf(burst.calls, 'targets').map((x) => [x.args[1], x.args[2], x.args[3]]),
      'aimed at the caster`s own tile',
    ).toEqual([[1, 11, c(1, 1)]]);

    const refused = fakeRules({ forecastFor, targets: () => ({ Err: 'NoLineOfSight' }) });
    const halted = walk(refused, LIVE, {
      order: [1],
      plans: [{ unitId: 1, actions: [SKILL_12_ON(3), M1] }],
    });
    expect(halted.board, 'a refused aim halts: nothing of the plan applies').toEqual(LIVE);
    expect(callsOf(refused.calls, 'path'), 'the Move after it is never asked').toEqual([]);
    expect(callsOf(refused.calls, 'forecast'), 'nor any forecast').toEqual([]);
    expect(JSON.stringify(LIVE), 'the live board is never mutated').toBe(LIVE_JSON);
  });

  it('BT11-5-PROJECT-HIDDEN: in PvP the enemy units walked before upTo are hidden (they act first with a secret plan) — upTo 2 hides 3 and 4, upTo 1 hides 3, no upTo hides none — while enemies stay frozen and own plans apply; a PvE walk hides nothing, a blocked or held wild included', () => {
    // WRONG IMPL KILLED: hidden computed from geometry or from the side alone (every enemy hidden,
    // or the ones after upTo); hidden filled without upTo (the full projection has no "before");
    // the hidden set leaking into PvE (a blocked wild is skipped, a held wild frozen, neither is a
    // secret plan — C3); a pvp row carrying a wild_index planned instead of frozen and hidden (C19).
    const order = [3, 1, 4, 2];
    const plans: readonly PlanInput[] = [{ unitId: 1, actions: [M1] }];

    const f2 = fakeRules();
    const two = walk(f2, PVP, { kind: 'pvp', order, plans, upTo: 2 });
    expect(hiddenOf(two), 'upTo 2: 3 and 4 act before 2').toEqual([3, 4]);
    expect(posOf(two.board, 1), 'own plan applied (1 walked before 2)').toEqual(c(2, 1));
    expect([posOf(two.board, 3), posOf(two.board, 4)], 'the enemies are frozen').toEqual([
      c(5, 1),
      c(5, 3),
    ]);
    expect(aiAsked(f2), 'and never planned').toEqual([]);
    const one = walk(fakeRules(), PVP, { kind: 'pvp', order, plans, upTo: 1 });
    expect(hiddenOf(one), 'upTo 1: only 3 acts before 1').toEqual([3]);
    expect(posOf(one.board, 1), 'upTo 1: unit 1`s own plan is not applied yet').toEqual(c(1, 1));
    const full = walk(fakeRules(), PVP, { kind: 'pvp', order, plans });
    expect(hiddenOf(full), 'no upTo: nothing is hidden').toEqual([]);
    expect(posOf(full.board, 1), 'and the own plan applies').toEqual(c(2, 1));

    const wildRows = fakeRules();
    const pvpOverWild = walk(wildRows, LIVE, { kind: 'pvp', order, plans, upTo: 2 });
    expect(
      hiddenOf(pvpOverWild),
      'PvP over rows that carry a wild_index: still frozen and hidden',
    ).toEqual([3, 4]);
    expect(aiAsked(wildRows), 'never planned').toEqual([]);

    const pve = walk(fakeRules(), LIVE, { order, plans, upTo: 2 });
    expect(hiddenOf(pve), 'PvE, upTo 2: nothing hidden').toEqual([]);
    const blockedWild = fakeRules();
    const asleep = walk(blockedWild, LIVE, { order, plans, upTo: 2, blocked: new Set([3]) });
    expect(hiddenOf(asleep), 'a blocked wild in a PvE walk is skipped, NOT hidden').toEqual([]);
    expect(aiAsked(blockedWild), 'only wild 4 is planned').toEqual([4]);
    const heldWild = walk(fakeRules(), LIVE, { order, plans, upTo: 2, wilds: false });
    expect(hiddenOf(heldWild), 'a held wild (wilds: false) is frozen, NOT hidden').toEqual([]);
    expect(JSON.stringify(PVP), 'the PvP board is never mutated').toBe(PVP_JSON);
  });
});

// --- the real rules (plan REV 6.1 C14) --------------------------------------------------------

describe('provisionalBoard over the real rules (plan REV 6.1 C14)', () => {
  let real: TacticsRules | undefined;
  beforeAll(async () => {
    real = bindTacticsRules((await loadWasmPkg()) as unknown as TacticsWasmExports);
  });
  const rulesOf = (): TacticsRules => {
    if (real === undefined) throw new Error('the client-wasm pkg did not load — run `just wasm`');
    return real;
  };

  it('on content map 1 a wild KO`d by the planned Water Gun of the unit before it is Fainted on the projection and never acts — it keeps its live tile although its own plan would have moved it', () => {
    // WRONG IMPL KILLED: a wild planned and applied after the projection already KO'd it (it would
    // walk next to unit 1 and strike); HP taken from anything but the real forecast.
    const r = rulesOf();
    const idle: TurnBudget = { ap: 0, strides_used: 0, attacks: 0, last: null };
    const STATS = { hp: 100, attack: 50, defense: 50, speed: 50, sp_attack: 50, sp_defense: 50 };
    // U: species 2 (Tidalin, Water; kit (3, 6), tactics_species/000-core.ron:13) at (1,1), whose
    // Water Gun (skill 3: Light, 1..2, accuracy 100) reaches (3,1). W: species 1 (Flameling, Fire;
    // kit (1, 2), Aggressive) at (3,1) with 1 of 4 HP — not Exhausted (1 x 4 is not < 4, ai.rs:53),
    // so its plan moves it next to U for a Fire Fang.
    const u: UnitRow = {
      id: 1,
      side: 'A',
      slot: 0,
      species_id: 2,
      level: 10,
      stats: STATS,
      pos: c(1, 1),
      cur_hp: 100,
      status: null,
      budget: idle,
      guard: false,
      first_stand: false,
      state: 'Active',
      stance: null,
      wild_index: null,
    };
    const w: UnitRow = {
      ...u,
      id: 2,
      side: 'B',
      species_id: 1,
      stats: { ...STATS, hp: 4 },
      pos: c(3, 1),
      cur_hp: 1,
      stance: 'Aggressive',
      wild_index: 0,
    };
    const live: RulesBoard = deepFreeze<RulesBoard>({ kind: 'Wild', map_id: 1, units: [u, w] });
    const liveJson = JSON.stringify(live);
    const gun: QueuedActionRule = { Skill: { skill_id: 3, target: { Unit: 2 } } };

    expect(
      r.forecast(r.unit(u), r.unit(w), 3, r.flank(live, 1, 2)).kills_min,
      'fixture: the Water Gun KOs the 1-HP wild at the minimum roll',
    ).toBe(true);
    const wildMove = r
      .aiPlan(live, 2)
      .find(
        (a): a is Extract<QueuedActionRule, { Move: unknown }> =>
          typeof a === 'object' && 'Move' in a,
      );
    expect(wildMove !== undefined, 'fixture: left alone, the wild`s own plan moves it').toBe(true);

    const asked: number[] = [];
    const spy: TacticsRules = {
      ...r,
      aiPlan: (board, unit) => {
        asked.push(unit);
        return r.aiPlan(board, unit);
      },
    };
    const input: ProjectInput = {
      kind: 'wild',
      mySide: 'A',
      order: [1, 2],
      plans: [{ unitId: 1, actions: [gun] }],
      blocked: new Set<number>(),
      wilds: true,
    };
    const p = project(spy, live, input);
    expect(
      [rowIn(p.board, 2).state, rowIn(p.board, 2).cur_hp],
      'the wild is Fainted at 0 HP on the projection',
    ).toEqual(['Fainted', 0]);
    expect(posOf(p.board, 2), 'and still on its live tile (3,1): it never acted').toEqual(c(3, 1));
    expect(asked, 'its plan was never asked').toEqual([]);

    const control = project(spy, live, { ...input, plans: [] });
    expect(
      posOf(control.board, 2),
      'control: with no plan for unit 1 the wild acts and lands on its own plan`s Move',
    ).toEqual(wildMove === undefined ? null : { x: wildMove.Move.x, y: wildMove.Move.y });
    expect(JSON.stringify(live), 'the live board is never mutated').toBe(liveJson);
  });
});
