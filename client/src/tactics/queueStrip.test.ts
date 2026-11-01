// tactics/queueStrip.test.ts — bt-11 round-4 RED tests for the plan STRIP model (BT11.3): one chip per
// planned step with its AP cost (the rules' plan of the prefix, the disengage tax judged on the
// current board), a firm / provisional / stale badge judged on the board the unit will ACT on, and
// the `only N held` note of an over-planned bait.
//
// SOURCE OF TRUTH: spec `### bt-11` BT11.3 ("append chips with AP pips (tax on the current board) and
// firm / provisional / stale badges re-evaluated on every subscription update, badge an
// over-planned consumable `~ only N held`"); the plan (memory/projects/monster-realm-bt-11-plan.md)
// REV 6 R6.2 as amended by REV 6.1 C1 (costs on `liveBoard`, legality chained from `actBoard`), C8
// (`partyFull`; no legality call once stale; `locked` dropped), C9, and REV 6.2 C20. The frozen
// exports of client/src/tactics/queueStrip.ts (`stripVM`, `StripInput`, `StripVM`) are the contract.
//
// HOW THE EXPECTED VALUES ARE BUILT: every rule fact comes from a FAKE `TacticsRules` whose answers
// are scripted and whose calls are RECORDED (the draft.test.ts shape). The plan answers can be keyed
// by the CANONICAL entry list asked, so a model that asks the rules about the wrong prefix, the
// wrong tax or the wrong start budget gets an unscripted refusal; every number read back is a
// distinct prime (costs 5 / 11 / 13 / 17, a whole-plan total of 19 that is NOT their sum 46, a
// start budget of ap 29, held / planned bait counts 3 / 7 and 11 / 2); a geometry-free `targets`
// stand-in answers by the board it is GIVEN, so the board a legality question is asked on is
// observable. One untagged scenario (plan REV 6.1 C14) runs the REAL rules (`loadWasmPkg()` +
// `bindTacticsRules`) on content map 1, where only the act board puts the wild in range.
//
// RED REASON: `stripVM` throws `bt-11: not implemented`.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { beforeAll, describe, expect, it } from 'vitest';
import { loadWasmPkg } from '../../test-util/wasmPkg';
import { type StripInput, type StripVM, stripVM } from './queueStrip';
import {
  bindTacticsRules,
  type Cell,
  type EconomyError,
  type Entry,
  type ForecastOut,
  type GeometryError,
  type PipelineTrace,
  type PlanOut,
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

/** Compact JSON with object keys sorted recursively (field order is the implementer's). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const body = Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`);
    return `{${body.join(',')}}`;
  }
  return String(JSON.stringify(v));
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

// --- fixture ----------------------------------------------------------------------------------

/** Skill 11: Light, a Caster-origin Burst. Skill 12: Heavy, a TargetUnit Single. */
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
    stats: { hp: 97, attack: 10, defense: 10, speed: 10, sp_attack: 10, sp_defense: 10 },
    pos: at,
    cur_hp: hp,
    status: null,
    budget: { ap: 0, strides_used: 0, attacks: 0, last: null },
    guard: false,
    first_stand: false,
    state: 'Active',
    stance: side === 'B' ? 'Aggressive' : null,
    wild_index: side === 'B' ? slot : null,
  };
}

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

/** The planning unit 1 at (1,1); wild 3 at (5,1); wild 4 at (5,3). Deep-frozen. */
const LIVE: RulesBoard = deepFreeze<RulesBoard>({
  kind: 'Wild',
  map_id: 1,
  units: [
    rowAt(1, 'A', 0, c(1, 1), 41),
    rowAt(3, 'B', 0, c(5, 1), 47),
    rowAt(4, 'B', 1, c(5, 3), 53),
  ],
});
const LIVE_JSON = JSON.stringify(LIVE);

function rowIn(board: RulesBoard, id: number): UnitRow {
  const r = board.units.find((u) => u.id === id);
  if (r === undefined) throw new Error(`no unit ${id} on the board`);
  return r;
}

/** `board` with unit `id`'s row patched (a new, deep-frozen board). */
function withRow(board: RulesBoard, id: number, patch: Partial<UnitRow>): RulesBoard {
  return deepFreeze<RulesBoard>({
    ...board,
    units: board.units.map((u) => (u.id === id ? { ...u, ...patch } : u)),
  });
}

const U: RulesUnit = joinRow(rowIn(LIVE, 1));
/** The start budget the strip is costed from: ap 29, a value no fake answer carries elsewhere. */
const START: TurnBudget = { ap: 29, strides_used: 0, attacks: 0, last: null };

const MA: QueuedActionRule = { Move: { x: 2, y: 1, strides: 1 } };
const MB: QueuedActionRule = { Move: { x: 3, y: 1, strides: 2 } };
const SK: QueuedActionRule = { Skill: { skill_id: 12, target: { Unit: 3 } } };
const END: QueuedActionRule = 'EndTurn';
const REC3: QueuedActionRule = { Recruit: { target: 3, bait: null } };
const R43: QueuedActionRule = { Recruit: { target: 3, bait: 43 } };
const R47: QueuedActionRule = { Recruit: { target: 3, bait: 47 } };

function trace(hpAfter: number): PipelineTrace {
  return {
    hit: true,
    d0: 61,
    d1: 67,
    d2: 71,
    d3: 73,
    effectiveness: 'Neutral',
    applied: 73,
    hp_after: hpAfter,
    stood_ground: false,
  };
}
/** What the fake forecast answers for any hit (the strip never reads it; applyAction does). */
const FC: ForecastOut = {
  hit_pct: 83,
  stab: false,
  flank: false,
  guard: false,
  effectiveness: 'Neutral',
  min: trace(37),
  max: trace(31),
  kills_min: false,
  kills_max: false,
  first_stand_saves: false,
  status: null,
  status_blocked: false,
  flank_factor: [5, 4],
  guard_factor: [3, 4],
  type_factor: [1, 1],
};

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
  /** When set, the plan answer of each CANONICAL entry list; any other list is refused. */
  readonly plans?: ReadonlyMap<string, RuleResult<PlanOut, EconomyError>>;
  /** Without `plans`: the default answer refuses the entry lists this predicate names. */
  readonly refuse?: (entries: readonly Entry[]) => boolean;
  /** Canonical destinations `path` refuses. */
  readonly pathRefused?: ReadonlySet<string>;
  readonly targets?: TargetsFn;
  readonly recruitTargets?: readonly number[];
}

interface Fake {
  readonly rules: TacticsRules;
  readonly calls: Call[];
}

/** A plan refusal (the rules' NeedsFullBudget shape). */
const REFUSED: EconomyError = { NeedsFullBudget: { ap: 3, required: 29 } };
/** The refusal of an entry list the test did not script (a model asked the wrong question). */
const UNSCRIPTED: EconomyError = { Unaffordable: { cost: 97, ap: 89 } };
/** The default plan's remaining budget after any non-empty plan it accepts. */
const DEFAULT_REMAINING: TurnBudget = {
  ap: 2,
  strides_used: 1,
  attacks: 1,
  last: { Attack: 'Heavy' },
};

function ok(
  costs: readonly number[],
  total: number,
  remaining: TurnBudget,
): RuleResult<PlanOut, EconomyError> {
  return { Ok: { costs: [...costs], total, remaining, guard_on_end: false } };
}

/** A geometry-free stand-in for the rules' target sets, answering by the board it is GIVEN: skill 11
 *  at the (Active) caster's own tile hits every conscious unit of the other side; skill 12 hits the
 *  conscious enemy standing on the aim. */
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

const notStrip = (name: string) => (): never => {
  throw new Error(`fake: ${name} is not a strip rule`);
};

function fakeRules(s: Script = {}): Fake {
  const calls: Call[] = [];
  const rec = (name: string, args: readonly unknown[]): void => {
    calls.push({ name, args });
  };
  const rules: TacticsRules = {
    map: notStrip('map'),
    freshBudget: notStrip('freshBudget'),
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
      if (s.pathRefused?.has(canon(dest)) === true) return { Err: 'DestOccupied' };
      return { Ok: { steps: [dest], cost: 3 } };
    },
    disengage: (board, mover, start) => {
      rec('disengage', [board, mover, start]);
      // Taxed at the unit's own tile, untaxed from any chained start: a second Move judged at the
      // unit's tile instead of the first Move's destination asks the plan an unscripted question.
      return { Ok: start === undefined };
    },
    flank: (board, attacker, target) => {
      rec('flank', [board, attacker, target]);
      return false;
    },
    forecast: (attacker, target, skillId, flank) => {
      rec('forecast', [attacker, target, skillId, flank]);
      return FC;
    },
    recruitOdds: notStrip('recruitOdds'),
    aiPlan: notStrip('aiPlan'),
    recruitTargets: (board, unit, budget) => {
      rec('recruitTargets', [board, unit, budget]);
      return [...(s.recruitTargets ?? [])];
    },
    isExhausted: notStrip('isExhausted'),
    plan: (start, entries) => {
      rec('plan', [start, entries]);
      if (s.plans !== undefined) return s.plans.get(canon(entries)) ?? { Err: UNSCRIPTED };
      if (s.refuse?.(entries) === true) return { Err: REFUSED };
      if (entries.length === 0) return ok([], 0, start);
      return ok(
        entries.map((_, i) => [5, 11, 13, 17][i] ?? 23),
        19,
        DEFAULT_REMAINING,
      );
    },
    overlays: notStrip('overlays'),
  };
  return { rules, calls };
}

const callsOf = (calls: readonly Call[], name: string): Call[] =>
  calls.filter((x) => x.name === name);

/** The strip over the fixture defaults: the live board as both boards, unit 1, START, pre-queue. */
function strip(fake: Fake, o: Partial<StripInput>): StripVM {
  return stripVM({
    rules: fake.rules,
    liveBoard: LIVE,
    actBoard: LIVE,
    unit: U,
    startBudget: START,
    actions: [],
    mode: 'prequeue',
    partyFull: false,
    baitHeld: new Map<number, number>(),
    baitPlanned: new Map<number, number>(),
    ...o,
  });
}
const badgesOf = (vm: StripVM): string[] => vm.chips.map((ch) => ch.badge);
const counts = (pairs: readonly (readonly [number, number])[]): ReadonlyMap<number, number> =>
  new Map(pairs);

// --- the tagged tests -------------------------------------------------------------------------

describe('queueStrip: AP pips (BT11.3)', () => {
  it('BT11-3-STRIP-PIPS: each chip`s cost is the rules` charge for that step in the plan of the steps up to it (the second Move taxed from the first Move`s tile on the live board), total and remaining are the whole plan`s, a plan refused from the third step leaves the first two costed and the rest null, and an empty plan is no chip, total 0 and the start budget', () => {
    // WRONG IMPL KILLED: the disengage tax judged on the ACT board (the projection) instead of the
    // live board ("tax on the current board"); the second Move taxed at the unit's own tile instead
    // of the first Move's destination (its entry is then taxed:true, an unscripted plan); a total
    // summed in TypeScript (5 + 11 + 13 + 17 = 46, the rules say 19); `remaining` read from a
    // prefix plan instead of the whole plan; the plan costed from another budget than START; costs
    // read from ONE whole-plan call (when the rules refuse the plan from step 3, every chip would be
    // null instead of 5 and 11); a refused whole plan still reporting a total.
    const E1: Entry = { Move: { strides: 1, taxed: true } };
    const E2: Entry = { Move: { strides: 2, taxed: false } };
    const E3: Entry = { Attack: 'Heavy' };
    const E4: Entry = 'EndTurn';
    const R1: TurnBudget = { ap: 37, strides_used: 1, attacks: 0, last: E1 };
    const R2: TurnBudget = { ap: 41, strides_used: 2, attacks: 0, last: E2 };
    const R3: TurnBudget = { ap: 43, strides_used: 2, attacks: 1, last: E3 };
    const RFULL: TurnBudget = { ap: 47, strides_used: 2, attacks: 1, last: E3 };
    const prefixes: readonly (readonly Entry[])[] = [
      [E1],
      [E1, E2],
      [E1, E2, E3],
      [E1, E2, E3, E4],
    ];
    const scripted = new Map<string, RuleResult<PlanOut, EconomyError>>([
      [canon([]), ok([], 0, START)],
      [canon(prefixes[0]), ok([5], 53, R1)],
      [canon(prefixes[1]), ok([5, 11], 59, R2)],
      [canon(prefixes[2]), ok([5, 11, 13], 61, R3)],
      [canon(prefixes[3]), ok([5, 11, 13, 17], 19, RFULL)],
    ]);
    // The act board differs from the live board (wild 4 walked to (4,3)): costs must not read it.
    const ACT = withRow(LIVE, 4, { pos: c(4, 3) });

    const f = fakeRules({ plans: scripted });
    const vm = strip(f, { actions: [MA, MB, SK, END], actBoard: ACT });
    expect(
      vm.chips.map((ch) => ch.action),
      'one chip per planned action, in order',
    ).toEqual([MA, MB, SK, END]);
    const taxes = callsOf(f.calls, 'disengage');
    expect(taxes.length > 0, 'the Moves are taxed by the rules').toBe(true);
    expect(
      taxes.every((x) => canon(x.args[0]) === canon(LIVE) && x.args[1] === 1),
      'every disengage question is asked of the LIVE board for unit 1 (never the act board)',
    ).toBe(true);
    const starts = new Set(
      taxes.map((x) => (x.args[2] === undefined ? 'own tile' : canon(x.args[2]))),
    );
    expect(
      [...starts].sort(),
      'the first Move is taxed from the unit`s own tile, the second from the first Move`s destination (2,1)',
    ).toEqual(['own tile', canon(c(2, 1))].sort());
    expect(
      vm.chips.map((ch) => ch.cost),
      'chip i costs plan(START, entries[0..=i]).Ok.costs[i]',
    ).toEqual([5, 11, 13, 17]);
    expect(vm.total, 'the rules` whole-plan total (19), never the TypeScript sum 46').toBe(19);
    expect(vm.remaining, 'the whole plan`s remaining budget, not a prefix`s').toEqual(RFULL);
    const plans = callsOf(f.calls, 'plan');
    expect(
      plans.every((x) => canon(x.args[0]) === canon(START)),
      'every plan question starts from START',
    ).toBe(true);
    for (const [i, prefix] of prefixes.entries()) {
      expect(
        plans.some((x) => canon(x.args[1]) === canon(prefix)),
        `the plan of steps 0..=${i} is asked exactly as costEntries builds it`,
      ).toBe(true);
    }
    expect(JSON.stringify(LIVE), 'the live board is untouched').toBe(LIVE_JSON);

    // The rules refuse every plan from the third step on (monotone, as the real economy is).
    const late = new Map<string, RuleResult<PlanOut, EconomyError>>([
      [canon([]), ok([], 0, START)],
      [canon(prefixes[0]), ok([5], 53, R1)],
      [canon(prefixes[1]), ok([5, 11], 59, R2)],
    ]);
    const refusedLate = strip(fakeRules({ plans: late }), { actions: [MA, MB, SK, END] });
    expect(
      refusedLate.chips.map((ch) => ch.cost),
      'refused from step 3: the first two chips keep their prefix costs, the rest are null',
    ).toEqual([5, 11, null, null]);
    expect(
      [refusedLate.total, refusedLate.remaining],
      'a refused whole plan has no total and no remaining',
    ).toEqual([null, null]);
    expect(
      badgesOf(refusedLate),
      'a chip whose prefix the rules refuse is stale, and so is every later one',
    ).toEqual(['provisional', 'provisional', 'stale', 'stale']);

    const empty = strip(fakeRules(), { actions: [] });
    expect(empty.chips, 'an empty plan: no chip').toEqual([]);
    expect(
      [empty.total, empty.remaining],
      'an empty plan: the rules` total 0 and the start budget, passed through',
    ).toEqual([0, START]);
  });
});

describe('queueStrip: badges (BT11.3)', () => {
  it('BT11-3-STRIP-BADGES: a legal pre-queued step is provisional and a live one firm (End and Flee always firm); a step the rules refuse on the act board — a refused path, a Fainted or out-of-range target, a refused Recruit, a plan Err — is stale and so is every later step; legality is chained through the earlier steps from the ACT board, a Recruit asks recruitTargets of that board with the start budget, and once a step is stale no later legality question is asked', () => {
    // WRONG IMPL KILLED: staleness that recovers (a later legal Move or the EndTurn after a stale
    // chip read firm / provisional); legality judged on the LIVE board (the wild that walks into
    // range on the act board would read stale — C1) or on the unchained board (the Skill after a
    // Move judged from the unit's live tile); a live chip shown provisional, or a pre-queued End /
    // Flee shown provisional; a Recruit judged without recruitTargets, from the live board, or with
    // another budget than the start budget for the first chip; a Recruit legal with the party full;
    // legality questions still asked after a chip went stale (C8).
    const PLAN3: readonly QueuedActionRule[] = [MA, SK, END];

    // (1) Everything legal.
    expect(
      badgesOf(strip(fakeRules(), { actions: PLAN3 })),
      'pre-queue, all legal: provisional, provisional, End firm',
    ).toEqual(['provisional', 'provisional', 'firm']);
    expect(
      badgesOf(strip(fakeRules(), { actions: PLAN3, mode: 'live' })),
      'live, all legal: all firm',
    ).toEqual(['firm', 'firm', 'firm']);
    for (const mode of ['prequeue', 'live'] as const) {
      expect(badgesOf(strip(fakeRules(), { actions: ['Flee'], mode })), `${mode}: Flee`).toEqual([
        'firm',
      ]);
    }

    // (2) The path to a is refused: the Move and everything after it are stale, End included.
    const refusedA = new Set([canon(c(2, 1))]);
    expect(
      badgesOf(strip(fakeRules({ pathRefused: refusedA }), { actions: PLAN3 })),
      'pre-queue, the path to (2,1) refused: stale from the Move on',
    ).toEqual(['stale', 'stale', 'stale']);
    expect(
      badgesOf(strip(fakeRules({ pathRefused: refusedA }), { actions: PLAN3, mode: 'live' })),
      'live: a stale chip is never followed by a firm End',
    ).toEqual(['stale', 'stale', 'stale']);

    // (3) Target 3 Fainted on the (live = act) board: the Skill and End are stale, the Move not.
    const KO3 = withRow(LIVE, 3, { state: 'Fainted', cur_hp: 0 });
    expect(
      badgesOf(strip(fakeRules(), { actions: PLAN3, liveBoard: KO3, actBoard: KO3, mode: 'live' })),
      'live, wild 3 Fainted: the Move firm, the Skill on 3 stale, End stale',
    ).toEqual(['firm', 'stale', 'stale']);
    expect(
      badgesOf(strip(fakeRules(), { actions: [SK, MA], liveBoard: KO3, actBoard: KO3 })),
      'a legal Move AFTER a stale Skill stays stale (no recovery)',
    ).toEqual(['stale', 'stale']);

    // (4) The Skill's legality is judged on the CHAINED board (unit 1 moved to a).
    const chained = fakeRules();
    strip(chained, { actions: [MA, SK] });
    const aims = callsOf(chained.calls, 'targets');
    expect(aims.length > 0, 'the Skill`s legality is a targets question').toBe(true);
    expect(
      aims.every(
        (x) =>
          canon(rowIn(x.args[0] as RulesBoard, 1).pos) === canon(c(2, 1)) &&
          x.args[1] === 1 &&
          x.args[2] === 12 &&
          canon(x.args[3]) === canon(c(5, 1)),
      ),
      'asked on the board AFTER the Move (unit 1 at (2,1)), skill 12, aimed at wild 3`s tile',
    ).toBe(true);

    // (5) A Recruit: legal iff recruitTargets(the act board, unit 1, START) lists the target.
    const ACT5 = withRow(LIVE, 3, { pos: c(2, 1) });
    const rec = fakeRules({ recruitTargets: [3] });
    expect(
      badgesOf(strip(rec, { actions: [REC3], actBoard: ACT5 })),
      'a pre-queued Recruit the rules list: provisional',
    ).toEqual(['provisional']);
    const asked = callsOf(rec.calls, 'recruitTargets');
    expect(asked.length > 0, 'the Recruit is a recruitTargets question').toBe(true);
    expect(
      asked.every(
        (x) =>
          canon(x.args[0]) === canon(ACT5) && x.args[1] === 1 && canon(x.args[2]) === canon(START),
      ),
      'asked of the ACT board (board_0), for unit 1, with the start budget',
    ).toBe(true);
    expect(
      badgesOf(strip(fakeRules({ recruitTargets: [3] }), { actions: [REC3], mode: 'live' })),
      'a live Recruit the rules list: firm',
    ).toEqual(['firm']);
    expect(
      badgesOf(strip(fakeRules({ recruitTargets: [4] }), { actions: [REC3] })),
      'a Recruit the rules do not list: stale',
    ).toEqual(['stale']);
    const afterMove = (entries: readonly Entry[]): boolean =>
      entries.length >= 2 && entries.includes('Recruit');
    expect(
      badgesOf(
        strip(fakeRules({ recruitTargets: [3], refuse: afterMove }), { actions: [MA, REC3] }),
      ),
      'a Recruit after a Move: the rules refuse the plan, so it is stale though recruitTargets lists 3',
    ).toEqual(['provisional', 'stale']);
    const firstRefused = fakeRules({ recruitTargets: [3], refuse: (e) => e.length >= 1 });
    expect(
      badgesOf(strip(firstRefused, { actions: [MA, REC3] })),
      'the plan refused from the Move: both stale',
    ).toEqual(['stale', 'stale']);
    expect(
      callsOf(firstRefused.calls, 'recruitTargets'),
      'and the Recruit after a stale chip is never asked about',
    ).toEqual([]);

    // (6) A plan Err at chip i: stale from i.
    expect(
      badgesOf(strip(fakeRules({ refuse: (e) => e.length >= 2 }), { actions: PLAN3 })),
      'the plan refused from step 2: provisional, stale, stale',
    ).toEqual(['provisional', 'stale', 'stale']);

    // (7) Act board != live board: wild 3 at (4,1) on the act board, (5,1) live; the rules aim only
    // where 3 stands at (4,1).
    const ACT7 = withRow(LIVE, 3, { pos: c(4, 1) });
    const inReach: TargetsFn = (board, _caster, _skillId, aim) => {
      const three = board.units.find((u) => u.id === 3);
      const there = three !== undefined && three.pos.x === 4 && three.pos.y === 1;
      return there && aim.x === 4 && aim.y === 1
        ? { Ok: [3] }
        : { Err: { OutOfRange: { distance: 3 } } };
    };
    const projected = fakeRules({ targets: inReach });
    expect(
      badgesOf(strip(projected, { actions: [SK], actBoard: ACT7 })),
      'a Skill in range only on the act board: provisional, not stale',
    ).toEqual(['provisional']);
    const asked7 = callsOf(projected.calls, 'targets');
    expect(
      asked7.length > 0 && asked7.every((x) => canon(x.args[0]) === canon(ACT7)),
      'its legality was asked of the act board',
    ).toBe(true);
    expect(
      badgesOf(strip(fakeRules({ targets: inReach }), { actions: [SK] })),
      'the same Skill when the act board is the live board: stale',
    ).toEqual(['stale']);

    // (8) No recruit headroom: a Recruit is stale and recruitTargets is not asked.
    const full = fakeRules({ recruitTargets: [3] });
    expect(
      badgesOf(strip(full, { actions: [REC3], partyFull: true })),
      'party full: the Recruit is stale',
    ).toEqual(['stale']);
    expect(callsOf(full.calls, 'recruitTargets'), 'and never asked about').toEqual([]);

    // (9) Once stale, no legality question for any later chip.
    const stopped = fakeRules({ pathRefused: refusedA });
    expect(
      badgesOf(strip(stopped, { actions: [MA, MB, SK, END] })),
      'fixture: the first Move refused, all stale',
    ).toEqual(['stale', 'stale', 'stale', 'stale']);
    const paths = callsOf(stopped.calls, 'path');
    expect(
      paths.length > 0 && paths.every((x) => canon(x.args[2]) === canon(c(2, 1))),
      'the refused Move is the only path question (none for the Move to (3,1))',
    ).toBe(true);
    expect(callsOf(stopped.calls, 'targets'), 'no targets question for the later Skill').toEqual(
      [],
    );
    const errAt1 = fakeRules({ refuse: (e) => e.length >= 2 });
    expect(
      badgesOf(strip(errAt1, { actions: [MA, MB, SK, END] })),
      'fixture: the plan refused from the second Move',
    ).toEqual(['provisional', 'stale', 'stale', 'stale']);
    expect(
      callsOf(errAt1.calls, 'targets'),
      'the Skill after the stale chip is never asked about',
    ).toEqual([]);
    expect(
      callsOf(errAt1.calls, 'path').every((x) =>
        [canon(c(2, 1)), canon(c(3, 1))].includes(canon(x.args[2])),
      ),
      'no path question beyond the two Moves',
    ).toBe(true);
  });
});

describe('queueStrip: the over-planned bait (BT11.3)', () => {
  it('BT11-3-STRIP-ONLY-HELD: a Recruit whose bait is planned more often than it is held carries onlyHeld = the HELD count (0 when none is held) and reads provisional even on a live turn; a bait planned no more than held, or no bait, carries null; and a stale Recruit stays stale with its note', () => {
    // WRONG IMPL KILLED: a badge that ignores the shortfall on a live turn (firm while the plan
    // asks for more baits than the bag holds); onlyHeld as the shortfall (planned - held: 1 for
    // planned 1 / held 0, 4 for planned 7 / held 3) instead of the held count; the count read from
    // another bait's entry (bait 47 is planned 2 and held 11); a note on a Recruit without a bait;
    // a missing held entry read as "nothing to compare" instead of 0; the shortfall overriding
    // staleness (a refused Recruit shown provisional).
    const chip0 = (
      o: Partial<StripInput>,
      s: Script = { recruitTargets: [3] },
    ): readonly [number | null | undefined, string | undefined] => {
      const vm = strip(fakeRules(s), o);
      return [vm.chips[0]?.onlyHeld, vm.chips[0]?.badge];
    };
    const short = { baitHeld: counts([[43, 1]]), baitPlanned: counts([[43, 2]]) };

    expect(
      chip0({ actions: [R43], mode: 'live', ...short }),
      'live, bait 43 planned 2, held 1: only 1 held, and provisional despite the live turn',
    ).toEqual([1, 'provisional']);
    expect(
      chip0({ actions: [R43], mode: 'live', baitHeld: counts([]), baitPlanned: counts([[43, 1]]) }),
      'planned 1, held none at all: onlyHeld 0 (the held count, not the shortfall 1)',
    ).toEqual([0, 'provisional']);
    const mixed = {
      baitHeld: counts([
        [43, 3],
        [47, 11],
      ]),
      baitPlanned: counts([
        [43, 7],
        [47, 2],
      ]),
    };
    expect(
      chip0({ actions: [R43], mode: 'live', ...mixed }),
      'bait 43 planned 7, held 3: onlyHeld 3 (not the shortfall 4)',
    ).toEqual([3, 'provisional']);
    expect(
      chip0({ actions: [R47], mode: 'live', ...mixed }),
      'bait 47 planned 2, held 11: no note, firm (its own counts, not bait 43`s)',
    ).toEqual([null, 'firm']);
    expect(
      chip0({ actions: [R43], ...short }),
      'pre-queued and short: only 1 held, provisional',
    ).toEqual([1, 'provisional']);
    const enough = { baitHeld: counts([[43, 1]]), baitPlanned: counts([[43, 1]]) };
    expect(
      chip0({ actions: [R43], mode: 'live', ...enough }),
      'planned 1, held 1: no note, firm on a live turn',
    ).toEqual([null, 'firm']);
    expect(
      chip0({ actions: [R43], ...enough }),
      'planned 1, held 1: no note, provisional pre-queued',
    ).toEqual([null, 'provisional']);
    expect(
      chip0({ actions: [REC3], mode: 'live', ...short }),
      'a Recruit with no bait: no note',
    ).toEqual([null, 'firm']);

    expect(
      chip0({ actions: [R43], mode: 'live', ...short }, { recruitTargets: [] }),
      'stale wins: a Recruit the rules do not list is stale, its note still 1',
    ).toEqual([1, 'stale']);
    expect(
      chip0(
        { actions: [R43], mode: 'live', ...short },
        { recruitTargets: [3], refuse: () => true },
      ),
      'stale wins: a refused plan, note still 1',
    ).toEqual([1, 'stale']);
    expect(
      chip0({ actions: [R43], mode: 'live', partyFull: true, ...short }),
      'stale wins: party full, note still 1',
    ).toEqual([1, 'stale']);
  });
});

// --- the real rules (plan REV 6.1 C14) --------------------------------------------------------

describe('queueStrip over the real rules (plan REV 6.1 C14)', () => {
  let real: TacticsRules | undefined;
  beforeAll(async () => {
    real = bindTacticsRules((await loadWasmPkg()) as unknown as TacticsWasmExports);
  });
  const rulesOf = (): TacticsRules => {
    if (real === undefined) throw new Error('the client-wasm pkg did not load — run `just wasm`');
    return real;
  };

  it('on content map 1 a pre-queued Heavy lance bound to a wild three tiles away reads provisional when the act board has the wild two tiles closer, and stale when the act board is the live board, costed by the rules either way', () => {
    // WRONG IMPL KILLED (measured by the plan review, C1): legality judged on the live board (the
    // menu offered the Skill on the projection, the strip then shows it as a refusal); a cost that
    // depends on legality (the economy charges the Heavy whatever the geometry says).
    const r = rulesOf();
    const STATS = { hp: 100, attack: 50, defense: 50, speed: 50, sp_attack: 50, sp_defense: 50 };
    const idle: TurnBudget = { ap: 0, strides_used: 0, attacks: 0, last: null };
    const base = (id: number, side: 'A' | 'B', species: number, at: Cell): UnitRow => ({
      id,
      side,
      slot: 0,
      species_id: species,
      level: 10,
      stats: STATS,
      pos: at,
      cur_hp: 100,
      status: null,
      budget: idle,
      guard: false,
      first_stand: false,
      state: 'Active',
      stance: side === 'B' ? 'Aggressive' : null,
      wild_index: side === 'B' ? 0 : null,
    });
    // U: species 42 (tactics_species/000-core.ron:30, kit (42, 43)) at (1,1); W: species 1, a wild,
    // at (4,1) on the live board (three tiles along row 1, an all-Plain row of map 1) and at (2,1)
    // on the act board.
    const u = base(1, 'A', 42, c(1, 1));
    const w = base(2, 'B', 1, c(4, 1));
    const live: RulesBoard = { kind: 'Wild', map_id: 1, units: [u, w] };
    const act: RulesBoard = { kind: 'Wild', map_id: 1, units: [u, { ...w, pos: c(2, 1) }] };
    const unit = r.unit(u);
    const lance = unit.kit.skills.find((k) => k.skill_id === 43);
    expect(
      lance === undefined
        ? null
        : [lance.tier, lance.geometry.origin, lance.geometry.range_min, lance.geometry.range_max],
      'fixture: skill 43 is a Heavy TargetUnit lance of range 1..2 (tactics_skills/000-core.ron:15)',
    ).toEqual(['Heavy', 'TargetUnit', 1, 2]);
    const near = r.targets(act, 1, 43, c(2, 1));
    expect(
      'Ok' in near && near.Ok.includes(2),
      'fixture: on the act board the wild at (2,1) is in range',
    ).toBe(true);
    expect(
      'Err' in r.targets(live, 1, 43, c(4, 1)),
      'fixture: on the live board the wild at (4,1) is out of range',
    ).toBe(true);

    const input = {
      rules: r,
      liveBoard: live,
      unit,
      startBudget: r.freshBudget(),
      actions: [{ Skill: { skill_id: 43, target: { Unit: 2 } } }] as QueuedActionRule[],
      mode: 'prequeue' as const,
      partyFull: false,
      baitHeld: new Map<number, number>(),
      baitPlanned: new Map<number, number>(),
    };
    const onAct = stripVM({ ...input, actBoard: act });
    expect(
      onAct.chips.map((ch) => [ch.badge, ch.cost]),
      'judged on the act board: provisional, 4 AP (heavy_cost, tuning.rs:114)',
    ).toEqual([['provisional', 4]]);
    expect(
      [onAct.total, onAct.remaining],
      'the whole plan: 4 of the fresh 6 AP, one attack, the Heavy last',
    ).toEqual([4, { ap: 2, strides_used: 0, attacks: 1, last: { Attack: 'Heavy' } }]);
    const onLive = stripVM({ ...input, actBoard: live });
    expect(
      onLive.chips.map((ch) => [ch.badge, ch.cost]),
      'judged on the live board: stale (out of range), still costed 4',
    ).toEqual([['stale', 4]]);
  });
});
