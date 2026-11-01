// tactics/commandModel.test.ts — bt-11 round-3 RED tests for the hierarchical command-menu MODEL
// (BT11.1): which root rows the menu offers and in what order, which are greyed and why, the
// per-skill rows and their legal aims, the End row's Guard / End Turn label, the Move band, the
// Recruit targets and the Undo-xor-Cancel offer.
//
// SOURCE OF TRUTH: spec `### bt-11` BT11.1 (+ BT11.2's "UNDO and CANCEL never together"); the plan
// (memory/projects/monster-realm-bt-11-plan.md) REV 4 §R4.3 as amended by REV 5 A24 (the cost board
// vs the aim board), A26 (recruit targets = one rules call), A29 (the mode graph), A34 (the rows:
// `submit`, `boxedIn`, the End label on the REMAINING budget). The frozen exports of
// client/src/tactics/commandModel.ts are the contract.
//
// HOW THE EXPECTED VALUES ARE BUILT: every predicate is a `TacticsRules` call, so the tests hand
// the model a FAKE rules port (`fakeRules`) whose answers are scripted per call and whose every call
// is RECORDED. A model that does arithmetic in TypeScript (AP sums, Manhattan distance, an
// adjacency test) instead of reading the fake is caught twice: its answer disagrees with the
// script, and the recorded arguments miss the call it should have made. The budget handed in ctx
// has ap 6 while the fake still answers Err where the script says so (an AP comparison in TS would
// enable the row). Rules the menu model never needs (unit, path, forecast, …) throw if called.
//
// RED REASON: every export of commandModel.ts throws `bt-11: not implemented`.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { describe, expect, it } from 'vitest';
import {
  endLabel,
  type MenuContext,
  type MenuRow,
  menuRows,
  moveBand,
  offers,
  recruitTargets,
  skillRows,
} from './commandModel';
import type {
  Cell,
  EconomyError,
  Entry,
  GeometryError,
  OverlayQuery,
  OverlaysOut,
  PlanOut,
  QueuedActionRule,
  RuleResult,
  RulesBoard,
  RulesUnit,
  SkillTactics,
  TacticsRules,
  TurnBudget,
  UnitRow,
} from './wasm';

// --- fixture ----------------------------------------------------------------------------------

const c = (x: number, y: number): Cell => ({ x, y });

/** Compact JSON with object keys sorted recursively (the fake's table key: field order is free). */
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

/** What the fake's freshBudget() answers — never the budget the model must use. */
const FRESH: TurnBudget = { ap: 7, strides_used: 0, attacks: 0, last: null };
/** The budget handed in ctx: a full 6 AP (a TS `ap >= cost` check would enable every row). */
const CTX_BUDGET: TurnBudget = { ap: 6, strides_used: 0, attacks: 0, last: null };
/** A draft's remaining budget (the End label reads it, A34). */
const REMAINING: TurnBudget = {
  ap: 3,
  strides_used: 1,
  attacks: 0,
  last: { Move: { strides: 1, taxed: false } },
};

/** Skill 11: Light, Caster-origin Burst (aims at the caster's own tile, `SelfTarget`). */
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
/** Skill 12: Heavy, TargetUnit Single 1..2 (aims at a unit). */
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
  o: Partial<UnitRow> = {},
): UnitRow {
  return {
    id,
    side,
    slot,
    species_id: 1,
    level: 10,
    stats: { hp: 50, attack: 10, defense: 10, speed: 10, sp_attack: 10, sp_defense: 10 },
    pos: at,
    cur_hp: 41,
    status: null,
    budget: CTX_BUDGET,
    guard: false,
    first_stand: false,
    state: 'Active',
    stance: side === 'B' ? 'Aggressive' : null,
    wild_index: side === 'B' ? slot : null,
    ...o,
  };
}

/** The planning unit U (id 5) at (2,2), carrying [11, 12]. */
function unitOf(skills: readonly SkillTactics[] = [S11, S12]): RulesUnit {
  return {
    id: 5,
    side: 'A',
    slot: 0,
    kit: {
      species_id: 1,
      affinity: 'Plant',
      level: 10,
      stats: { hp: 50, attack: 10, defense: 10, speed: 10, sp_attack: 10, sp_defense: 10 },
      base_speed: 43,
      class: 'Walk',
      skills,
    },
    pos: c(2, 2),
    cur_hp: 41,
    status: null,
    budget: CTX_BUDGET,
    guard: false,
    first_stand: false,
    state: 'Active',
  };
}

// The units in STATE order (side, slot) — ids deliberately not ascending: 5, 2, 31, 17, 23.
// The COST board has the wilds where they stand now; the AIM board has them elsewhere (in increment
// C it is the projection), so a model that aims from the wrong board queries the wrong tiles.
const COST_BOARD: RulesBoard = {
  kind: 'Wild',
  map_id: 1,
  units: [
    rowAt(5, 'A', 0, c(2, 2)),
    rowAt(2, 'A', 1, c(1, 2)),
    rowAt(31, 'B', 0, c(3, 2)),
    rowAt(17, 'B', 1, c(6, 6)),
    rowAt(23, 'B', 2, c(0, 0), { state: 'Fainted', cur_hp: 0 }),
  ],
};
const AIM_BOARD: RulesBoard = {
  kind: 'Wild',
  map_id: 1,
  units: [
    rowAt(5, 'A', 0, c(2, 2)),
    rowAt(2, 'A', 1, c(1, 2)),
    rowAt(31, 'B', 0, c(3, 3)),
    rowAt(17, 'B', 1, c(4, 2)),
    rowAt(23, 'B', 2, c(0, 0), { state: 'Fainted', cur_hp: 0 }),
  ],
};

// --- the fake rules ---------------------------------------------------------------------------

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

type PlanFn = (start: TurnBudget, entries: readonly Entry[]) => RuleResult<PlanOut, EconomyError>;
type TargetsFn = (
  board: RulesBoard,
  caster: number,
  skillId: number,
  aim: Cell,
) => RuleResult<number[], GeometryError>;

interface Script {
  readonly plan?: PlanFn;
  readonly band?: { readonly reach1: readonly Cell[]; readonly reach2: readonly Cell[] };
  readonly targets?: TargetsFn;
  readonly recruitTargets?: readonly number[];
}

/** Distinct primes: a cost a model computed itself cannot collide with the fake's. */
const COSTS: readonly number[] = [3, 5, 7, 11];

const okPlan: PlanFn = (_start, entries) => ({
  Ok: {
    costs: entries.map((_, i) => COSTS[i] ?? 13),
    total: 17,
    remaining: REMAINING,
    guard_on_end: false,
  },
});

/** A plan table keyed on the canonical entries; anything not listed is `okPlan`. */
function planTable(table: Readonly<Record<string, RuleResult<PlanOut, EconomyError>>>): PlanFn {
  return (start, entries) => table[canon(entries)] ?? okPlan(start, entries);
}

const STRIDE_CAP: EconomyError = { StrideCap: { used: 2, requested: 1, cap: 2 } };
const UNAFFORDABLE: EconomyError = { Unaffordable: { cost: 5, ap: 3 } };
const NEEDS_FULL: EconomyError = { NeedsFullBudget: { ap: 5, required: 7 } };

const MOVE1: Entry = { Move: { strides: 1, taxed: false } };
const K_MOVE1 = canon([MOVE1]);
const K_RECRUIT = canon(['Recruit']);
const K_FLEE = canon(['Flee']);
const K_END = canon(['EndTurn']);
const K_LIGHT = canon([{ Attack: 'Light' }]);
const K_HEAVY = canon([{ Attack: 'Heavy' }]);

const key = (t: Cell): string => `${t.x},${t.y}`;

/** The default geometry answers, by aim tile ON THE AIM BOARD (see the fixture):
 *  skill 12 at the ally (1,2) → Ok [2] (an ally is a legal aim per the rules here); at W31's aim
 *  tile (3,3) → Ok [31, 17] (two hit); at W17's aim tile (4,2) → Ok [23] (Ok, but W17 is NOT in it);
 *  at the cost-board tiles (3,2) / (6,6) → Ok for 31 / 17 (only a model aiming from the WRONG board
 *  asks there); anything else → NoTargetUnit. Skill 11 at the caster's tile → Ok [31, 2]. */
const defaultTargets: TargetsFn = (_board, _caster, skillId, aim) => {
  if (skillId === 11) {
    return key(aim) === '2,2' ? { Ok: [31, 2] } : { Err: 'AimNotCaster' };
  }
  const table: Readonly<Record<string, number[]>> = {
    '1,2': [2],
    '3,3': [31, 17],
    '4,2': [23],
    '3,2': [31],
    '6,6': [17],
  };
  const hit = table[key(aim)];
  return hit === undefined ? { Err: 'NoTargetUnit' } : { Ok: hit };
};

const notMenu = (name: string) => (): never => {
  throw new Error(`fake: ${name} is not a menu-model rule`);
};

function fakeRules(s: Script = {}): { readonly rules: TacticsRules; readonly calls: Call[] } {
  const calls: Call[] = [];
  const band = s.band ?? { reach1: [c(2, 1)], reach2: [c(2, 0)] };
  const rules: TacticsRules = {
    map: notMenu('map'),
    freshBudget: () => {
      calls.push({ name: 'freshBudget', args: [] });
      return FRESH;
    },
    unit: notMenu('unit'),
    targets: (board, caster, skillId, aim) => {
      calls.push({ name: 'targets', args: [board, caster, skillId, aim] });
      return (s.targets ?? defaultTargets)(board, caster, skillId, aim);
    },
    path: notMenu('path'),
    disengage: notMenu('disengage'),
    flank: notMenu('flank'),
    forecast: notMenu('forecast'),
    recruitOdds: notMenu('recruitOdds'),
    aiPlan: notMenu('aiPlan'),
    recruitTargets: (board, unit, budget) => {
      calls.push({ name: 'recruitTargets', args: [board, unit, budget] });
      return [...(s.recruitTargets ?? [31])];
    },
    isExhausted: notMenu('isExhausted'),
    plan: (start, entries) => {
      calls.push({ name: 'plan', args: [start, entries] });
      return (s.plan ?? okPlan)(start, entries);
    },
    overlays: (board, q): OverlaysOut => {
      calls.push({ name: 'overlays', args: [board, q] });
      return {
        reach1: band.reach1,
        reach2: band.reach2,
        range: [],
        aoe: [],
        danger: [],
        shield: [],
        intents: [],
      };
    },
  };
  return { rules, calls };
}

function ctxOf(o: Partial<MenuContext> = {}): MenuContext {
  return {
    kind: 'wild',
    mode: 'live',
    rules: fakeRules().rules,
    costBoard: COST_BOARD,
    aimBoard: AIM_BOARD,
    unit: unitOf(),
    budget: CTX_BUDGET,
    actions: [],
    partyFull: false,
    hasReady: false,
    ...o,
  };
}

/** `[id, enabled, reason]` for a quick whole-menu comparison. */
const triples = (rows: readonly MenuRow[]): Array<[string, boolean, string | null]> =>
  rows.map((r) => [r.id, r.enabled, r.reason]);
const rowOf = (rows: readonly MenuRow[], id: string): MenuRow => {
  const r = rows.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no ${id} row in ${rows.map((x) => x.id).join(', ')}`);
  return r;
};
const callsOf = (calls: readonly Call[], name: string): Call[] =>
  calls.filter((x) => x.name === name);

const MOVE_ACTION: QueuedActionRule = { Move: { x: 2, y: 1, strides: 1 } };

// --- the root rows ------------------------------------------------------------------------------

describe('commandModel: the root rows (BT11.1)', () => {
  it('BT11-1-MENU-ROWS: the root menu is move, skills, item, recruit, flee, end (live), plus submit (pre-queue) and clear only for a pre-queue with a READY row and an empty draft; Item is always greyed Not available; End is always enabled; after a terminal action every action row is greyed Plan complete; offers() is Undo xor Cancel', () => {
    // WRONG IMPL KILLED: a hard-coded row list (submit / clear on a live turn, clear beside a draft,
    // no submit in a pre-queue); rows in another order; an enabled Item (the server refuses Item
    // entries in P1: tactics.rs ITEMS_NOT_AVAILABLE); End greyed; clear keyed to hasReady alone
    // (a live unit or a drafted pre-queue offered Clear); action rows left enabled after End /
    // Recruit / Flee closed the plan; a Skill treated as terminal (two attacks are legal); Undo
    // and Cancel offered together.
    const live = menuRows(ctxOf());
    expect(triples(live), 'live, empty draft: every row in order, Item greyed').toEqual([
      ['move', true, null],
      ['skills', true, null],
      ['item', false, 'notAvailable'],
      ['recruit', true, null],
      ['flee', true, null],
      ['end', true, null],
    ]);
    expect(
      [rowOf(live, 'move').sub, rowOf(live, 'skills').sub, rowOf(live, 'recruit').sub],
      'move (an aim), skills and recruit (sub-lists) open something',
    ).toEqual([true, true, true]);
    expect([rowOf(live, 'flee').sub, rowOf(live, 'end').sub], 'flee and end act at once').toEqual([
      false,
      false,
    ]);

    const pre = menuRows(ctxOf({ mode: 'prequeue', budget: FRESH }));
    expect(
      pre.map((r) => r.id),
      'pre-queue, no READY row: submit is added, no clear',
    ).toEqual(['move', 'skills', 'item', 'recruit', 'flee', 'end', 'submit']);
    expect(rowOf(pre, 'submit').enabled, 'submit is greyed while the draft is empty').toBe(false);
    expect(rowOf(pre, 'submit').sub, 'submit acts at once').toBe(false);

    const ready = menuRows(ctxOf({ mode: 'prequeue', budget: FRESH, hasReady: true }));
    expect(
      ready.map((r) => r.id),
      'pre-queue, a READY row and no draft: clear is the last row',
    ).toEqual(['move', 'skills', 'item', 'recruit', 'flee', 'end', 'submit', 'clear']);
    expect(
      [rowOf(ready, 'clear').enabled, rowOf(ready, 'clear').sub],
      'clear is enabled and opens its confirm',
    ).toEqual([true, true]);

    const drafted = menuRows(
      ctxOf({ mode: 'prequeue', budget: REMAINING, hasReady: true, actions: [MOVE_ACTION] }),
    );
    expect(
      drafted.map((r) => r.id),
      'pre-queue with a READY row AND a draft: no clear (the draft replaces the plan)',
    ).toEqual(['move', 'skills', 'item', 'recruit', 'flee', 'end', 'submit']);
    expect(rowOf(drafted, 'submit').enabled, 'submit is enabled with a draft').toBe(true);

    const liveReady = menuRows(ctxOf({ hasReady: true }));
    expect(
      liveReady.map((r) => r.id),
      'a live unit never gets submit or clear, whatever hasReady says',
    ).toEqual(['move', 'skills', 'item', 'recruit', 'flee', 'end']);

    for (const terminal of [
      'EndTurn',
      'Flee',
      { Recruit: { target: 31, bait: null } },
    ] as const satisfies readonly QueuedActionRule[]) {
      const label = `after ${canon(terminal)}`;
      const rows = menuRows(
        ctxOf({
          mode: 'prequeue',
          budget: REMAINING,
          hasReady: true,
          actions: [MOVE_ACTION, terminal],
        }),
      );
      for (const id of ['move', 'skills', 'recruit', 'flee']) {
        expect([rowOf(rows, id).enabled, rowOf(rows, id).reason], `${label}: ${id}`).toEqual([
          false,
          'planComplete',
        ]);
      }
      expect(rowOf(rows, 'item').enabled, `${label}: item stays greyed`).toBe(false);
      expect(
        rows.some((r) => r.id === 'clear'),
        `${label}: no clear`,
      ).toBe(false);
      expect(rowOf(rows, 'submit').enabled, `${label}: the plan can still be submitted`).toBe(true);
    }
    const afterSkill = menuRows(
      ctxOf({ actions: [{ Skill: { skill_id: 12, target: { Unit: 31 } } }], budget: REMAINING }),
    );
    expect(
      [rowOf(afterSkill, 'move').enabled, rowOf(afterSkill, 'move').reason],
      'a Skill is not terminal: the Move row still follows its band',
    ).toEqual([true, null]);
    expect(rowOf(afterSkill, 'end').enabled, 'End is enabled after a Skill').toBe(true);

    // offers(): Undo iff a chip to pop; Cancel iff pre-queue + READY + no draft; never both.
    let combos = 0;
    for (const mode of ['live', 'prequeue'] as const) {
      for (const hasReady of [false, true]) {
        for (const actions of [[], [MOVE_ACTION]] as const) {
          const o = offers(ctxOf({ mode, hasReady, actions }));
          const label = `${mode} ready=${hasReady} draft=${actions.length}`;
          expect(o.undo, `${label}: undo`).toBe(actions.length > 0);
          expect(o.cancel, `${label}: cancel`).toBe(
            mode === 'prequeue' && hasReady && actions.length === 0,
          );
          expect(o.undo && o.cancel, `${label}: never both`).toBe(false);
          combos += 1;
        }
      }
    }
    expect(combos, 'ANTI-VACUITY: the 2 x 2 x 2 table').toBe(8);
  });
});

// --- the reasons --------------------------------------------------------------------------------

describe('commandModel: why a row is greyed (BT11.1)', () => {
  it('BT11-1-MENU-REASONS: each greyed row carries the rules` reason — Party full before the full-budget reason, Recruit greyed by either an unaffordable Recruit or no recruit target, Flee by an unaffordable Flee, Move by the stride cap / the AP / an empty band, Skills by its first skill`s reason — all asked of the rules with the ctx budget', () => {
    // WRONG IMPL KILLED: TS arithmetic on ap (the ctx budget has 6 AP, yet the fake refuses — an
    // `ap >= 6` check enables the row); a Recruit row enabled with no recruit target (the spec's
    // "start your turn adjacent"), or greyed with the wrong reason when the plan is fine but nobody
    // is adjacent; Party full losing to the AP reason; a Move reason that ignores the plan's Err kind
    // (StrideCap vs Unaffordable) or greys a row whose band is non-empty; boxedIn missing; the
    // Skills row greyed while one skill is usable, or carrying the LAST skill's reason; the rules
    // asked with freshBudget() or the unit's row budget instead of ctx.budget; the Move band or the
    // recruit targets asked of the aim board.
    const recruit = (s: Script, partyFull: boolean): [boolean, string | null] => {
      const r = rowOf(menuRows(ctxOf({ rules: fakeRules(s).rules, partyFull })), 'recruit');
      return [r.enabled, r.reason];
    };
    expect(
      recruit({ plan: planTable({ [K_RECRUIT]: { Err: NEEDS_FULL } }), recruitTargets: [] }, true),
      'party full wins over everything',
    ).toEqual([false, 'partyFull']);
    expect(recruit({ recruitTargets: [31] }, true), 'party full alone').toEqual([
      false,
      'partyFull',
    ]);
    expect(
      recruit(
        { plan: planTable({ [K_RECRUIT]: { Err: NEEDS_FULL } }), recruitTargets: [31] },
        false,
      ),
      'Recruit not affordable (the plan refuses it) at 6 AP in ctx',
    ).toEqual([false, 'recruitFullAp']);
    expect(
      recruit({ recruitTargets: [] }, false),
      'Recruit affordable but no recruit target',
    ).toEqual([false, 'recruitFullAp']);
    expect(recruit({ recruitTargets: [17] }, false), 'a target the rules list').toEqual([
      true,
      null,
    ]);

    const flee = (s: Script): [boolean, string | null] => {
      const r = rowOf(menuRows(ctxOf({ rules: fakeRules(s).rules })), 'flee');
      return [r.enabled, r.reason];
    };
    expect(
      flee({ plan: planTable({ [K_FLEE]: { Err: NEEDS_FULL } }) }),
      'Flee refused by the plan',
    ).toEqual([false, 'fleeFullAp']);
    expect(flee({}), 'Flee affordable').toEqual([true, null]);

    const EMPTY = { reach1: [], reach2: [] };
    const move = (s: Script): [boolean, string | null] => {
      const r = rowOf(menuRows(ctxOf({ rules: fakeRules(s).rules })), 'move');
      return [r.enabled, r.reason];
    };
    expect(
      move({ band: EMPTY, plan: planTable({ [K_MOVE1]: { Err: STRIDE_CAP } }) }),
      'no band, the stride cap',
    ).toEqual([false, 'strideCap']);
    expect(
      move({ band: EMPTY, plan: planTable({ [K_MOVE1]: { Err: UNAFFORDABLE } }) }),
      'no band, not enough AP',
    ).toEqual([false, 'unaffordable']);
    expect(move({ band: EMPTY }), 'no band though a stride is affordable: boxed in').toEqual([
      false,
      'boxedIn',
    ]);
    expect(
      move({
        band: { reach1: [], reach2: [c(4, 4)] },
        plan: planTable({ [K_MOVE1]: { Err: UNAFFORDABLE } }),
      }),
      'a band (reach2 only) enables Move whatever the one-stride plan says',
    ).toEqual([true, null]);

    const skills = (s: Script): [boolean, string | null] => {
      const r = rowOf(menuRows(ctxOf({ rules: fakeRules(s).rules })), 'skills');
      return [r.enabled, r.reason];
    };
    const noAim: TargetsFn = () => ({ Err: 'NoTargetUnit' });
    expect(
      skills({ plan: planTable({ [K_LIGHT]: { Err: UNAFFORDABLE } }), targets: noAim }),
      'skill 11 unaffordable, skill 12 out of range: the FIRST row`s reason',
    ).toEqual([false, 'unaffordable']);
    expect(
      skills({ plan: planTable({ [K_HEAVY]: { Err: UNAFFORDABLE } }), targets: noAim }),
      'skill 11 out of range, skill 12 unaffordable: the first row`s reason',
    ).toEqual([false, 'outOfRange']);
    expect(
      skills({ plan: planTable({ [K_LIGHT]: { Err: UNAFFORDABLE } }) }),
      'skill 12 still usable: Skills is enabled',
    ).toEqual([true, null]);

    // The questions themselves: asked with ctx.budget, the band and the targets on the cost board
    // (an empty band, so the Move row MUST ask the one-stride plan for its reason).
    const { rules, calls } = fakeRules({ recruitTargets: [17], band: EMPTY });
    const ctx = ctxOf({ rules });
    menuRows(ctx);
    const plans = callsOf(calls, 'plan');
    expect(plans.length > 0, 'the rows ask the plan').toBe(true);
    for (const p of plans) {
      expect(canon(p.args[0]), `plan(${canon(p.args[1])}) is costed from ctx.budget`).toBe(
        canon(CTX_BUDGET),
      );
    }
    const asked = plans.map((p) => canon(p.args[1]));
    for (const k of [K_RECRUIT, K_FLEE, K_MOVE1]) {
      expect(asked, `the plan is asked ${k}`).toContain(k);
    }
    const overlays = callsOf(calls, 'overlays');
    expect(overlays.length > 0, 'the Move band is asked of the overlays').toBe(true);
    expect(overlays[0]?.args[0], 'on the cost board').toStrictEqual(COST_BOARD);
    expect(
      overlays[0]?.args[1],
      'selected = the unit, its side, no skill, no aim, ctx.budget',
    ).toEqual({
      viewer: 'A',
      selected: 5,
      skill_id: null,
      aim: null,
      budget: CTX_BUDGET,
    } satisfies OverlayQuery);
    expect(
      callsOf(calls, 'recruitTargets').map((x) => x.args),
      'recruit targets: one call on the cost board with ctx.budget',
    ).toEqual([[COST_BOARD, 5, CTX_BUDGET]]);
    expect(callsOf(calls, 'freshBudget'), 'freshBudget() is never the menu`s budget').toEqual([]);

    // The two helpers the shell reads, one hop each.
    const band = fakeRules({ band: { reach1: [c(1, 1), c(3, 2)], reach2: [c(2, 0)] } });
    expect(moveBand(ctxOf({ rules: band.rules })), 'moveBand copies the rules` sets').toEqual({
      reach1: [c(1, 1), c(3, 2)],
      reach2: [c(2, 0)],
    });
    const targets = fakeRules({ recruitTargets: [17, 31] });
    expect(
      recruitTargets(ctxOf({ rules: targets.rules })),
      'recruitTargets is the rules` list as is (no TS adjacency filter: 17 stands far away)',
    ).toEqual([17, 31]);
    expect(callsOf(targets.calls, 'recruitTargets')[0]?.args).toEqual([COST_BOARD, 5, CTX_BUDGET]);
  });
});

// --- PvP -----------------------------------------------------------------------------------------

describe('commandModel: a player battle (BT11.1)', () => {
  it('BT11-1-MENU-PVP: in a player battle the menu omits Recruit and Flee and keeps every other row in order (Clear and Submit included for a pre-queue), and never asks the rules about recruiting or fleeing', () => {
    // WRONG IMPL KILLED: Recruit or Flee shown (greyed or not) in PvP — the spec omits them; the
    // other rows dropped or reordered with them; the recruit targets or a Recruit / Flee plan still
    // asked (wasted rules calls that also leak the wild-battle logic into PvP).
    const pvpCost: RulesBoard = { ...COST_BOARD, kind: 'Pvp' };
    const pvpAim: RulesBoard = { ...AIM_BOARD, kind: 'Pvp' };
    const { rules, calls } = fakeRules();
    const live = menuRows(ctxOf({ kind: 'pvp', rules, costBoard: pvpCost, aimBoard: pvpAim }));
    expect(triples(live), 'live PvP').toEqual([
      ['move', true, null],
      ['skills', true, null],
      ['item', false, 'notAvailable'],
      ['end', true, null],
    ]);
    const ready = menuRows(
      ctxOf({
        kind: 'pvp',
        mode: 'prequeue',
        hasReady: true,
        rules,
        costBoard: pvpCost,
        aimBoard: pvpAim,
      }),
    );
    expect(
      ready.map((r) => r.id),
      'pre-queue PvP with a READY row',
    ).toEqual(['move', 'skills', 'item', 'end', 'submit', 'clear']);
    expect(callsOf(calls, 'recruitTargets'), 'no recruit targets asked in PvP').toEqual([]);
    const asked = callsOf(calls, 'plan').map((p) => canon(p.args[1]));
    expect(asked.includes(K_RECRUIT), 'no Recruit plan asked in PvP').toBe(false);
    expect(asked.includes(K_FLEE), 'no Flee plan asked in PvP').toBe(false);
    const wild = menuRows(ctxOf());
    expect(
      wild.map((r) => r.id),
      'control: the same ctx in a wild battle keeps both',
    ).toEqual(['move', 'skills', 'item', 'recruit', 'flee', 'end']);
  });
});

// --- the End label --------------------------------------------------------------------------------

describe('commandModel: the End row`s label (BT11.1)', () => {
  it('BT11-1-MENU-END-LABEL: the End row reads Guard exactly when the rules grant Guard on an End Turn from the REMAINING budget handed in ctx, and End Turn when they do not or refuse the End Turn', () => {
    // WRONG IMPL KILLED: the label hard-coded (always End Turn, or Guard); the Guard test restated
    // in TS (no attack this turn and ap >= 2: REMAINING has ap 3 and no attack, yet the fake says
    // no Guard in one row); the plan asked from freshBudget() or the start budget instead of the
    // remaining one; the draft re-costed into the End Turn question (A34: `plan(budget,
    // ['EndTurn'])`); a refused End Turn read as Guard.
    const label = (
      endResult: RuleResult<PlanOut, EconomyError>,
    ): {
      readonly label: string;
      readonly calls: Call[];
    } => {
      const { rules, calls } = fakeRules({ plan: planTable({ [K_END]: endResult }) });
      return {
        label: endLabel(ctxOf({ rules, budget: REMAINING, actions: [MOVE_ACTION] })),
        calls,
      };
    };
    const planOut = (guard: boolean): RuleResult<PlanOut, EconomyError> => ({
      Ok: { costs: [0], total: 0, remaining: REMAINING, guard_on_end: guard },
    });
    const guard = label(planOut(true));
    expect(guard.label, 'guard_on_end: Guard').toBe('guard');
    expect(
      callsOf(guard.calls, 'plan').map((p) => [canon(p.args[0]), canon(p.args[1])]),
      'one question: plan(the remaining budget, [EndTurn])',
    ).toEqual([[canon(REMAINING), K_END]]);
    expect(label(planOut(false)).label, 'no Guard: End Turn').toBe('endTurn');
    expect(label({ Err: UNAFFORDABLE }).label, 'a refused End Turn: End Turn').toBe('endTurn');
    expect(
      callsOf(guard.calls, 'freshBudget'),
      'the fresh budget is not the End label`s basis',
    ).toEqual([]);
  });
});

// --- the skill rows ------------------------------------------------------------------------------

describe('commandModel: the Skills sub-list (BT11.1)', () => {
  it('BT11-1-MENU-SKILLS: one row per kit skill in kit order with its tier; a skill the plan refuses is Not enough AP; a TargetUnit skill aims at every unit — either side — whose tile the rules hit it from on the AIM board, in state order, with the hit list; a Caster skill aims once at its own tile; no aim is Out of range', () => {
    // WRONG IMPL KILLED: rows sorted by id or tier instead of kit order; a Manhattan range check
    // (W17's aim tile is two tiles away, in the skill's 1..2, yet the rules' set does not hold it;
    // the ally one tile away IS a legal aim per the rules); aiming only at enemies; an aim listed for
    // an Ok answer that does not contain the aimed unit; the aims read from the COST board (its
    // tiles answer differently); the hit list re-derived (one id per aim) instead of copied; a
    // Caster skill aimed at a unit, or listed when the rules refuse it; outOfRange on a skill that
    // has an aim; an unaffordable skill still enabled.
    const { rules, calls } = fakeRules();
    const rows = skillRows(ctxOf({ rules }));
    expect(
      rows.map((r) => [r.skillId, r.tier]),
      'kit order, with tiers',
    ).toEqual([
      [11, 'Light'],
      [12, 'Heavy'],
    ]);
    const [s11, s12] = rows;
    expect(
      s12?.aims,
      'skill 12 aims, state order (ally 2, then W31), the rules` hit lists',
    ).toEqual([
      { aim: c(1, 2), target: { Unit: 2 }, hits: [2] },
      { aim: c(3, 3), target: { Unit: 31 }, hits: [31, 17] },
    ]);
    expect([s12?.enabled, s12?.reason], 'skill 12 is usable').toEqual([true, null]);
    expect(s11?.aims, 'skill 11 (Caster) aims once, at the caster`s own tile').toEqual([
      { aim: c(2, 2), target: 'SelfTarget', hits: [31, 2] },
    ]);
    expect([s11?.enabled, s11?.reason], 'skill 11 is usable').toEqual([true, null]);

    const geometry = callsOf(calls, 'targets');
    expect(geometry.length > 0, 'the aims are asked of the rules').toBe(true);
    for (const g of geometry) {
      expect(
        g.args[0],
        `targets(${canon(g.args.slice(1))}) is asked on the aim board`,
      ).toStrictEqual(AIM_BOARD);
      expect(g.args[1], 'the caster is the planning unit').toBe(5);
    }
    const asked12 = geometry.filter((g) => g.args[2] === 12).map((g) => key(g.args[3] as Cell));
    for (const t of ['1,2', '3,3', '4,2']) {
      expect(asked12, `skill 12 is asked at the aim-board tile ${t}`).toContain(t);
    }
    expect(asked12.includes('3,2') || asked12.includes('6,6'), 'never at cost-board tiles').toBe(
      false,
    );

    const reversed = skillRows(ctxOf({ unit: unitOf([S12, S11]) }));
    expect(
      reversed.map((r) => r.skillId),
      'the kit`s own order, whatever the ids',
    ).toEqual([12, 11]);

    const refused = skillRows(
      ctxOf({ rules: fakeRules({ plan: planTable({ [K_HEAVY]: { Err: UNAFFORDABLE } }) }).rules }),
    );
    expect(
      [refused[1]?.enabled, refused[1]?.reason],
      'skill 12 refused by the plan: Not enough AP',
    ).toEqual([false, 'unaffordable']);
    expect([refused[0]?.enabled, refused[0]?.reason], 'skill 11 unaffected').toEqual([true, null]);

    const blind = skillRows(
      ctxOf({ rules: fakeRules({ targets: () => ({ Err: 'OutOfBounds' }) }).rules }),
    );
    for (const r of blind) {
      expect([r.enabled, r.reason, r.aims], `skill ${r.skillId} with no aim`).toEqual([
        false,
        'outOfRange',
        [],
      ]);
    }
  });
});
