// @vitest-environment happy-dom
// tactics/tacticsBattle.test.ts — bt-10 RED tests for the tactical battle SHELL: the frame layout
// (BT10.1), event ingest / B-skip / reduced motion / the turn banner (BT10.5), the per-unit cursor
// memory, unit cycling and D-pad reachability (BT10.6), the never-recentring turn bar at the shell
// (BT10.3) and the danger toggle (BT10.4).
//
// SOURCE OF TRUTH: spec `### bt-10`; the plan's API freeze (tacticsBattle.ts stub + DOM block) and
// REV 2 A1 (cycleUnit/toggleDanger are public methods, applyBattleOp handles only move / activate /
// back), A8 (banner), A9 (precedence and edges), A10 (ingest pushes ticker lines immediately, the
// reduceMotion boolean is read live), A13.
//
// DOM CONTRACT PINNED HERE BEYOND THE FREEZE TEXT: the banner is "shown" when `.tactics-banner`
// exists, is not `hidden`, has no inline `display:none` and has text; any of those is "hidden". The
// banner's `{unit}` is `deps.names.unit(id)` or the unit's speciesName (either is accepted). The four
// region labels (`tactics.board/dock/ticker/turnbar.label`) are an aria-label, a title or text
// inside their region. `.tactics-unit--active`, `.tactics-hp--<band>` and the chip state classes are
// pinned in boardRender.test.ts / turnBar.test.ts.
//
// NOT OBSERVABLE WITHOUT A HOOK: whether a B tap really drains the Playback queue. The shell exposes
// no `playing` signal, so the B tests pin what IS observable (no cursor/danger/ticker change, no throw,
// DOM stable across a later tick) and the report asks for a hook if a stronger proof is wanted.
//
// RED REASON (bt-10): the TacticsBattle constructor threw `bt-10: not implemented`.
//
// bt-11 ROUND 3 (increment B: the command menu, the live draft, the controller map, the pre-queue
// Submit / Clear plan; spec BT11.1 / BT11.2 / BT11.3 / BT11.6; plan REV 4 §R4.2 / §R4.7 / §R4.9 as
// amended by REV 5 A24 / A28 / A29 / A30 / A34 / A35 / A36 / A42 / A43). NAMED INTENTIONAL CHANGES to
// the bt-10 part: `vmOf()` builds the new VM (`board` = the raw rows, derived from `units` so the
// two always agree; `readyPlans` replaces `readyUnitIds`; `baits`, `partyFull`) and `make()` the new
// deps (`rules` = a recording FAKE port, `onSubmitQueue` / `onCancelQueue` recorders); the bt-10
// overlay tests (BT10-4-SHELL-DANGER, BT10-6-SHELL-NEW-BATTLE) feed their danger sets through the
// fake's `overlays()` answer (the shell computes the overlays now); A on the selected own unit opens
// the command menu (BT10-4's "activate changes nothing" is now "activate neither toggles danger nor
// moves the cursor"); BT10-6-CYCLE-RULES' "KO'd selection" fixture renders with no active unit, since
// an own Waiting unit is now SELECTED by the render (A28, pinned by BT11-6-SELECT-FOLLOWS-TURN).
//
// DOM CONTRACT PINNED HERE (A43 + the plan's text; the implementer reads it from this file): the
// menu is `.tactics-menu[role=listbox][tabindex=0]` labelled `tactics.menu.label`, absent when
// closed, holding `button.tactics-menu-row[role=option][data-row]` rows (`move`, `skills`, `item`,
// `recruit`, `flee`, `end`, `submit`, `clear`; `skill:<id>`; `bait:none` / `bait:<itemId>`;
// `clearYes` / `clearNo`) with ids, `aria-activedescendant` on the listbox, `aria-selected="true"`
// on the cursor row, `aria-disabled="true"` + a `span.tactics-reason` on a greyed row (never the
// `disabled` attribute); the strip's chips are `.tactics-strip .tactics-chip[data-action]`; the ghost
// is `.tactics-ghost[data-unit-id]` inside `.tactics-grid` at grid-column x+1 / grid-row y+1; the dock
// buttons are `.tactics-dock-danger` (aria-pressed), `.tactics-dock-prev`, `.tactics-dock-next`. A
// is pressed on a unit at its LIVE tile (units are drawn there, R4.7); in `aimMove` the D-pad moves
// a free tile cursor that starts on the unit's tile; entering a skill / bait aim seats the FIRST legal
// aim (A29), so A confirms it at once.
//
// THE FAKE RULES: every `TacticsRules` method records its arguments and answers from a mutable
// script (a band of reach1 (2,1) / reach2 (3,1), a danger list, a Guard flag, a set of refused plans,
// the recruit targets, an overlays throw). Its fresh budget has ap 7 and the live unit's row budget
// ap 5 (pre-queue units ap 0), so the budget a query carries is identifiable; every number read back
// is a distinct prime.
//
// RED REASON (round 3): the shell's bt-11 paths throw or do nothing on the API-freeze stub (the
// `danger` / `cycle` / `start` ops and `hint()` throw `bt-11: not implemented`; `activate` opens no
// menu; the overlays are never asked of the rules), and the new catalog keys are absent.
// Strings are asserted through CATALOG_EN / CATALOG_FR. Do NOT edit these tests to match a buggy
// implementation; correct them from the spec only.

import { afterEach, describe, expect, it } from 'vitest';
import type { EventPayload, QueuedAction } from '../module_bindings/types';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import { CATALOG_FR } from '../ui/i18n/catalog.fr';
import { setLocale } from '../ui/i18n/resolver';
import type { BattleOp } from '../ui/screens/battleScreen';
import type { Side, TacticalUnit } from './boardModel';
import {
  type BaitOption,
  TacticsBattle,
  type TacticsBattleDeps,
  type TacticsBattleVM,
} from './tacticsBattle';
import type { TickerNames } from './ticker';
import type {
  Cell,
  EconomyError,
  Entry,
  ForecastOut,
  GeometryError,
  OverlayQuery,
  OverlaysOut,
  PipelineTrace,
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

const EN = CATALOG_EN as unknown as Record<string, unknown>;

function en(key: string, params: Record<string, unknown> = {}): string {
  const value = EN[key];
  if (typeof value === 'function') return (value as (p: Record<string, unknown>) => string)(params);
  if (typeof value !== 'string') throw new Error(`catalog key missing: ${key}`);
  return value;
}

function unit(o: Partial<TacticalUnit> & { readonly unitId: number }): TacticalUnit {
  return {
    side: 'A',
    mine: true,
    ai: false,
    speciesId: 1,
    speciesName: 'Sprigg',
    level: 5,
    affinity: 'Plant',
    x: 0,
    y: 0,
    curHp: 10,
    maxHp: 10,
    status: null,
    ap: 6,
    guard: false,
    firstStand: false,
    role: null,
    stance: null,
    state: 'Active',
    ...o,
  };
}

const foe = (o: Partial<TacticalUnit> & { readonly unitId: number }): TacticalUnit =>
  unit({ side: 'B', mine: false, ai: true, ...o });

/** 1 own (1,1), 2 own (3,2), 3 wild (5,1), 4 wild (5,3), 5 own KO'd (0,4). */
const UNITS: readonly TacticalUnit[] = [
  unit({ unitId: 1, x: 1, y: 1, speciesName: 'Sprigg' }),
  unit({ unitId: 2, x: 3, y: 2, speciesName: 'Cindertail' }),
  foe({ unitId: 3, x: 5, y: 1, speciesName: 'Mossback' }),
  foe({ unitId: 4, x: 5, y: 3, speciesName: 'Flameling' }),
  unit({ unitId: 5, x: 0, y: 4, speciesName: 'Kip', state: 'Fainted', curHp: 0 }),
];

// --- the fake rules port (bt-11) ---------------------------------------------------------------

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
  return JSON.stringify(v);
}

/** The fake's freshBudget(): ap 7, a value no unit row in these fixtures carries. */
const FRESH: TurnBudget = { ap: 7, strides_used: 0, attacks: 0, last: null };
/** The fake plan's `remaining` after any draft it does not refuse. */
const REMAINING: TurnBudget = {
  ap: 3,
  strides_used: 1,
  attacks: 0,
  last: { Move: { strides: 1, taxed: false } },
};
/** The fake plan's per-entry charges: distinct primes. */
const COSTS: readonly number[] = [5, 11, 13];

/** Skill 11: Light, a Caster-origin Burst (SelfTarget). Skill 12: Heavy, a TargetUnit Single. */
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

/** The fake join: the row's fields, the fixture kit [11, 12] for every species. */
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

function hitTrace(hpAfter: number): PipelineTrace {
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
const FORECAST: ForecastOut = {
  hit_pct: 83,
  stab: false,
  flank: false,
  guard: false,
  effectiveness: 'Neutral',
  min: hitTrace(23),
  max: hitTrace(2),
  kills_min: false,
  kills_max: false,
  first_stand_saves: false,
  status: null,
  status_blocked: false,
  flank_factor: [5, 4],
  guard_factor: [3, 4],
  type_factor: [1, 1],
};

/** A geometry-free stand-in for the rules' target sets: skill 11 at the caster's own tile hits every
 *  conscious unit of the other side; skill 12 hits the conscious enemy standing on the aim. */
function shellTargets(
  board: RulesBoard,
  caster: number,
  skillId: number,
  aim: Cell,
): RuleResult<number[], GeometryError> {
  const me = board.units.find((u) => u.id === caster);
  if (me === undefined) return { Err: { UnknownCaster: caster } };
  const foes = board.units.filter((u) => u.side !== me.side && u.state === 'Active');
  if (skillId === 11) {
    return aim.x === me.pos.x && aim.y === me.pos.y
      ? { Ok: foes.map((u) => u.id) }
      : { Err: 'AimNotCaster' };
  }
  const on = foes.find((u) => u.pos.x === aim.x && u.pos.y === aim.y);
  return on === undefined ? { Err: 'NoTargetUnit' } : { Ok: [on.id] };
}

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** What the fake answers; a test changes it between renders. */
interface ShellScript {
  /** The Move band of a query with a selection (reach1 (2,1), reach2 (3,1) by default). */
  reach1: readonly Cell[];
  reach2: readonly Cell[];
  /** The danger lists of every query. */
  danger: readonly (readonly Cell[])[];
  /** `plan(_, ['EndTurn']).Ok.guard_on_end`. */
  guard: boolean;
  /** Canonical entry lists the plan refuses. */
  refused: Set<string>;
  recruitTargets: readonly number[];
  /** When set, every overlays() call throws it. */
  overlaysThrow: Error | null;
}

interface Fake {
  readonly rules: TacticsRules;
  readonly calls: Call[];
  readonly script: ShellScript;
}

const REFUSED_PLAN: EconomyError = { NeedsFullBudget: { ap: 3, required: 7 } };

function planAnswer(
  script: ShellScript,
  start: TurnBudget,
  entries: readonly Entry[],
): RuleResult<PlanOut, EconomyError> {
  if (script.refused.has(canon(entries))) return { Err: REFUSED_PLAN };
  return {
    Ok: {
      costs: entries.map((_, i) => COSTS[i] ?? 17),
      total: entries.length === 0 ? 0 : 19,
      // An empty plan spends nothing (as the real rules answer); any other leaves REMAINING.
      remaining: entries.length === 0 ? start : REMAINING,
      guard_on_end: entries.length === 1 && entries[0] === 'EndTurn' && script.guard,
    },
  };
}

function overlaysAnswer(script: ShellScript, q: OverlayQuery): OverlaysOut {
  const selected = q.selected !== null;
  return {
    reach1: selected ? script.reach1 : [],
    reach2: selected ? script.reach2 : [],
    range: [],
    aoe: [],
    danger: script.danger,
    shield: [],
    intents: [],
  };
}

/** A recording fake `TacticsRules`: every call is logged with its arguments, every answer scripted. */
function fakeRules(): Fake {
  const calls: Call[] = [];
  const script: ShellScript = {
    reach1: [c(2, 1)],
    reach2: [c(3, 1)],
    danger: [],
    guard: false,
    refused: new Set<string>(),
    recruitTargets: [],
    overlaysThrow: null,
  };
  const rec = (name: string, args: readonly unknown[]): void => {
    calls.push({ name, args });
  };
  const rules: TacticsRules = {
    map: (mapId) => {
      rec('map', [mapId]);
      return { width: 7, height: 5, tiles: [], spawn_a: [], spawn_b: [] };
    },
    freshBudget: () => {
      rec('freshBudget', []);
      return FRESH;
    },
    unit: (row) => {
      rec('unit', [row]);
      return joinRow(row);
    },
    targets: (board, caster, skillId, aim) => {
      rec('targets', [board, caster, skillId, aim]);
      return shellTargets(board, caster, skillId, aim);
    },
    path: (board, mover, dest) => {
      rec('path', [board, mover, dest]);
      return { Ok: { steps: [dest], cost: 3 } };
    },
    disengage: (board, mover, start) => {
      rec('disengage', [board, mover, start]);
      return { Ok: false };
    },
    flank: (board, attacker, target) => {
      rec('flank', [board, attacker, target]);
      return false;
    },
    forecast: (attacker, target, skillId, flank) => {
      rec('forecast', [attacker, target, skillId, flank]);
      return FORECAST;
    },
    recruitOdds: (maxHp, hp, baitBonus) => {
      rec('recruitOdds', [maxHp, hp, baitBonus]);
      return { Ok: { pct: 41, base: 8, bait: 0, weakened: 33 } };
    },
    aiPlan: (board, unit) => {
      rec('aiPlan', [board, unit]);
      return ['EndTurn'];
    },
    recruitTargets: (board, unit, budget) => {
      rec('recruitTargets', [board, unit, budget]);
      return [...script.recruitTargets];
    },
    isExhausted: (curHp, maxHp) => {
      rec('isExhausted', [curHp, maxHp]);
      return false;
    },
    plan: (start, entries) => {
      rec('plan', [start, entries]);
      return planAnswer(script, start, entries);
    },
    overlays: (board, q) => {
      rec('overlays', [board, q]);
      if (script.overlaysThrow !== null) throw script.overlaysThrow;
      return overlaysAnswer(script, q);
    },
  };
  return { rules, calls, script };
}

// --- the VM (the board rows derived from the units, so the two always agree) ------------------

function statusRule(u: TacticalUnit): UnitRow['status'] {
  if (u.status === null) return null;
  return u.status === 'Sleep' ? { Sleep: { turns_remaining: 1 } } : u.status;
}

function rowOfUnit(u: TacticalUnit, slot: number, wildIndex: number | null): UnitRow {
  return {
    id: u.unitId,
    side: u.side,
    slot,
    species_id: u.speciesId,
    level: u.level,
    stats: { hp: u.maxHp, attack: 10, defense: 10, speed: 10, sp_attack: 10, sp_defense: 10 },
    pos: { x: u.x, y: u.y },
    cur_hp: u.curHp,
    status: statusRule(u),
    budget: { ap: u.ap, strides_used: 0, attacks: 0, last: null },
    guard: u.guard,
    first_stand: u.firstStand,
    state: u.state,
    stance: u.stance,
    wild_index: wildIndex,
  };
}

/** The raw rows of `units`: slots counted per side in list order, wild indices for the AI units. */
function boardOf(units: readonly TacticalUnit[], kind: 'wild' | 'pvp'): RulesBoard {
  const slots: Record<Side, number> = { A: 0, B: 0 };
  let wilds = 0;
  return {
    kind: kind === 'wild' ? 'Wild' : 'Pvp',
    map_id: 1,
    units: units.map((u) => {
      const slot = slots[u.side];
      slots[u.side] = slot + 1;
      let wildIndex: number | null = null;
      if (u.ai) {
        wildIndex = wilds;
        wilds += 1;
      }
      return rowOfUnit(u, slot, wildIndex);
    }),
  };
}

function vmOf(o: Partial<TacticsBattleVM> = {}): TacticsBattleVM {
  const units = o.units ?? UNITS;
  const kind = o.kind ?? 'wild';
  return {
    battleId: 1n,
    kind,
    width: 7,
    height: 5,
    units,
    activeUnitId: 1,
    round: 1,
    initiative: [1, 3, 2, 4],
    turnIdx: 0,
    nextInitiative: [1, 3, 2, 4],
    surgeStartRound: 9,
    wildRoundCap: 31,
    targetUnitId: null,
    board: boardOf(units, kind),
    readyPlans: new Map<number, readonly QueuedActionRule[]>(),
    baits: [],
    partyFull: false,
    ...o,
  };
}

/** A `readyPlans` map (this player's READY rows by unit id). */
function readyOf(
  rows: readonly (readonly [number, readonly QueuedActionRule[]])[],
): ReadonlyMap<number, readonly QueuedActionRule[]> {
  return new Map(rows);
}

function makeNames(mySide: Side = 'A'): TickerNames {
  return {
    mySide,
    unit: (id) => `unit#${id}`,
    skill: (id) => `skill#${id}`,
    item: (id) => `item#${id}`,
  };
}

interface Sent {
  readonly battleId: bigint;
  readonly unitId: number;
  readonly entries: readonly QueuedAction[];
}
interface Cancel {
  readonly battleId: bigint;
  readonly unitId: number;
}

interface DepsOpts {
  readonly now?: () => number;
  readonly reduceMotion?: () => boolean;
  readonly names?: TickerNames;
  readonly fake?: Fake;
  readonly sent?: Sent[];
  readonly cancels?: Cancel[];
  readonly failSubmit?: { on: boolean };
}

/** The shell's deps: the fake rules (lazily handed out, as main.ts will), recording submit / cancel
 *  sinks (a submit records first, then throws while `failSubmit.on`). */
function depsOf(o: DepsOpts = {}): TacticsBattleDeps {
  const fake = o.fake ?? fakeRules();
  const sent = o.sent ?? [];
  const cancels = o.cancels ?? [];
  const fail = o.failSubmit ?? { on: false };
  return {
    now: o.now ?? (() => 0),
    reduceMotion: o.reduceMotion ?? (() => false),
    names: o.names ?? makeNames(),
    rules: () => fake.rules,
    onSubmitQueue: (battleId, unitId, entries) => {
      sent.push({ battleId, unitId, entries: [...entries] });
      if (fail.on) throw new Error('submit_queue: the reducer handle failed');
    },
    onCancelQueue: (battleId, unitId) => {
      cancels.push({ battleId, unitId });
    },
  };
}

interface Kit {
  readonly parent: HTMLElement;
  readonly shell: TacticsBattle;
  readonly root: HTMLElement;
  readonly clock: { t: number };
  readonly motion: { reduce: boolean };
  readonly fake: Fake;
  readonly sent: Sent[];
  readonly cancels: Cancel[];
  readonly failSubmit: { on: boolean };
}

/** A constructed, shown shell on a fresh parent. */
function make(reduce = false, mySide: Side = 'A', fake: Fake = fakeRules()): Kit {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const clock = { t: 0 };
  const motion = { reduce };
  const sent: Sent[] = [];
  const cancels: Cancel[] = [];
  const failSubmit = { on: false };
  const shell = new TacticsBattle(
    parent,
    depsOf({
      now: () => clock.t,
      reduceMotion: () => motion.reduce,
      names: makeNames(mySide),
      fake,
      sent,
      cancels,
      failSubmit,
    }),
  );
  shell.show();
  const root = parent.querySelector<HTMLElement>('.tactics-battle');
  if (root === null) throw new Error('the shell painted no .tactics-battle root');
  return { parent, shell, root, clock, motion, fake, sent, cancels, failSubmit };
}

function q<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelector<E>(selector);
  if (found === null) throw new Error(`no element matches ${selector}`);
  return found;
}

const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

const tickerTexts = (root: HTMLElement): (string | null)[] =>
  [...q(root, '.tactics-ticker').children].map((c) => c.textContent);

const cursorTiles = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('.tactics-tile--cursor')].map(
    (t) => `${t.getAttribute('data-x')},${t.getAttribute('data-y')}`,
  );

const expandedIds = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('.tactics-info-row--expanded')].map(
    (r) => r.getAttribute('data-unit-id') ?? '',
  );

/** True when `a` comes before `b` in document order (and neither contains the other). */
function precedes(a: Element, b: Element): boolean {
  return (
    !a.contains(b) &&
    !b.contains(a) &&
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

afterEach(() => {
  document.body.replaceChildren();
  // BT11-1-SHELL-TEXT-FROM-CATALOG paints in French; nothing else may inherit it.
  setLocale('en');
});

// ---------------------------------------------------------------------------------------------
// BT10.1 — layout
// ---------------------------------------------------------------------------------------------

describe('TacticsBattle: the frame (BT10.1)', () => {
  it('BT10-1-SHELL-LAYOUT: the root wears the battle frame classes plus tactics-battle with the battle-title anchor; the turn bar is on top, the field holds the one shared background and the grid, the ticker sits above a last-placed dock, and the region labels come from the catalog', () => {
    // WRONG IMPL KILLED: a root that lacks mr-frame/mr-shell/mr-shell--top/mr-shell--battle (it
    // would not sit in the battle frame's z-order); no battle-title anchor (the overlay's initial
    // focus target); the dock above the ticker or above the field; the turn bar below the board;
    // the ticker or the info boxes missing; the grid outside the field; a hard-coded region
    // label.
    const k = make();
    k.shell.render(vmOf());
    const { root } = k;
    for (const cls of [
      'mr-frame',
      'mr-shell',
      'mr-shell--top',
      'mr-shell--battle',
      'tactics-battle',
    ]) {
      expect(root.classList.contains(cls), `root has class ${cls}`).toBe(true);
    }
    expect(root.classList.contains('tactics--reduced'), 'not reduced by default').toBe(false);
    expect(k.parent.querySelectorAll('.tactics-battle'), 'one root').toHaveLength(1);
    expect(
      root.querySelectorAll('[data-testid="battle-title"]'),
      'one battle-title anchor',
    ).toHaveLength(1);

    const turnbar = q(root, '.tactics-turnbar');
    const field = q(root, '.tactics-field');
    const ticker = q(root, '.tactics-ticker');
    const dock = q(root, '.tactics-dock');
    expect(precedes(turnbar, field), 'turn bar above the field').toBe(true);
    expect(precedes(field, ticker), 'field above the ticker').toBe(true);
    expect(precedes(ticker, dock), 'ticker above the dock').toBe(true);
    expect(root.lastElementChild, 'the dock is the last band of the frame').toBe(dock);
    expect(field.querySelectorAll('.tactics-bg'), 'one background inside the field').toHaveLength(
      1,
    );
    expect(field.querySelectorAll('.tactics-grid'), 'the grid inside the field').toHaveLength(1);
    expect(field.querySelectorAll('.tactics-tile'), '7x5 tiles inside the field').toHaveLength(35);
    expect(root.querySelectorAll('.tactics-info--own'), 'own info box').toHaveLength(1);
    expect(root.querySelectorAll('.tactics-info--foe'), 'foe info box').toHaveLength(1);
    expect(root.querySelectorAll('.tactics-banner'), 'the turn banner element').toHaveLength(1);
    expect(
      root.querySelectorAll('.tactics-turnbar .tactics-chip').length,
      'the bar is painted',
    ).toBeGreaterThan(0);

    const labelled = (region: Element, text: string): boolean =>
      [region, ...region.querySelectorAll('*')].some(
        (e) => e.getAttribute('aria-label') === text || e.getAttribute('title') === text,
      ) || (region.textContent ?? '').includes(text);
    expect(labelled(field, en('tactics.board.label')), 'board label (tactics.board.label)').toBe(
      true,
    );
    expect(labelled(dock, en('tactics.dock.label')), 'dock label (tactics.dock.label)').toBe(true);
    expect(
      labelled(ticker, en('tactics.ticker.label')),
      'ticker label (tactics.ticker.label)',
    ).toBe(true);
    expect(
      labelled(turnbar, en('tactics.turnbar.label')),
      'turn bar label (tactics.turnbar.label)',
    ).toBe(true);
  });

  it("BT10-1-SHELL-IDEMPOTENT: rendering again repaints in place — one of every region, the same tile and unit counts — and a KO'd unit leaves the board but keeps its tile", () => {
    // WRONG IMPL KILLED: a render that appends a second frame (two backgrounds, two docks, 70
    // tiles); only Active units drawn on the first render but all on later ones; the grid
    // shrinking when a unit faints; the info boxes or turn bar duplicated.
    const k = make();
    const regions = [
      '.tactics-bg',
      '.tactics-field',
      '.tactics-grid',
      '.tactics-turnbar',
      '.tactics-ticker',
      '.tactics-dock',
      '.tactics-info--own',
      '.tactics-info--foe',
      '[data-testid="battle-title"]',
    ];
    const count = (sel: string): number => k.root.querySelectorAll(sel).length;
    k.shell.render(vmOf());
    k.shell.render(vmOf());
    k.shell.render(vmOf({ round: 2, turnIdx: 1 }));
    for (const sel of regions) expect(count(sel), `exactly one ${sel}`).toBe(1);
    expect(
      count('.tactics-banner'),
      'at most one banner (hidden on a wild turn)',
    ).toBeLessThanOrEqual(1);
    expect(count('.tactics-tile'), '35 tiles').toBe(35);
    expect(count('.tactics-unit'), "four Active units (the KO'd one is not drawn)").toBe(4);
    expect(k.parent.querySelectorAll('.tactics-battle'), 'one root').toHaveLength(1);

    const ko = UNITS.map((u) =>
      u.unitId === 3 ? { ...u, state: 'Fainted' as const, curHp: 0 } : u,
    );
    k.shell.render(vmOf({ units: ko }));
    expect(count('.tactics-unit'), 'three Active units after a KO').toBe(3);
    expect(count('.tactics-tile'), 'the grid keeps all tiles').toBe(35);
    expect(
      k.root.querySelectorAll('.tactics-tile[data-x="5"][data-y="1"]'),
      "the KO'd unit's tile is still there",
    ).toHaveLength(1);
    for (const sel of regions) expect(count(sel), `still exactly one ${sel}`).toBe(1);
  });

  it('BT10-1-SHELL-SHOWHIDE: the shell starts hidden, show() and hide() flip visible and the root display, and both are idempotent', () => {
    // WRONG IMPL KILLED: a constructor that shows itself (it would cover the world before the
    // store says a tactical row exists); hide() leaving the root displayed; visible not following
    // the calls; a second show()/hide() throwing.
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const shell = new TacticsBattle(parent, depsOf());
    const root = q(parent, '.tactics-battle');
    expect(shell.visible, 'hidden after construction').toBe(false);
    shell.show();
    shell.show();
    expect(shell.visible, 'visible after show').toBe(true);
    expect(root.style.display === 'none', 'the root is displayed after show').toBe(false);
    shell.hide();
    shell.hide();
    expect(shell.visible, 'hidden after hide').toBe(false);
    expect(root.style.display, 'the root is not displayed after hide').toBe('none');
    shell.show();
    expect(shell.visible, 'show works again').toBe(true);
  });

  it('BT10-1-SHELL-POINTER: clicking a tile, or the sprite of a unit standing on a tile, moves the shell cursor there and leaves exactly one cursor tile', () => {
    // WRONG IMPL KILLED: a click handler only on tiles (the unit element above it swallows the
    // click); the cursor moved by a click but not painted; two cursor tiles after a click; the
    // click coordinates transposed.
    const k = make();
    k.shell.render(vmOf());
    click(q(k.root, '.tactics-tile[data-x="4"][data-y="4"]'));
    expect(k.shell.cursor, 'tile click moves the cursor').toEqual({ x: 4, y: 4 });
    expect(cursorTiles(k.root), 'one cursor tile, painted').toEqual(['4,4']);

    click(q(k.root, '.tactics-unit[data-unit-id="3"] .tactics-sprite'));
    expect(k.shell.cursor, 'a sprite click targets its unit tile').toEqual({ x: 5, y: 1 });
    expect(cursorTiles(k.root), 'still exactly one cursor tile').toEqual(['5,1']);

    click(q(k.root, '.tactics-tile[data-x="1"][data-y="3"]'));
    expect(k.shell.cursor, 'x=1,y=3 is not x=3,y=1').toEqual({ x: 1, y: 3 });
    expect(cursorTiles(k.root)).toEqual(['1,3']);
  });
});

// ---------------------------------------------------------------------------------------------
// BT10.6 — cursor memory, cycling, reachability, hover
// ---------------------------------------------------------------------------------------------

const move = (k: Kit, dir: 'Up' | 'Down' | 'Left' | 'Right'): void => {
  k.shell.applyBattleOp({ kind: 'move', dir });
};

describe('TacticsBattle: the cursor (BT10.6)', () => {
  it("BT10-6-CURSOR-MEMORY: the first own Active unit is selected on the first render with the cursor on its tile; D-pad moves are remembered PER unit and cycling restores each unit's own tile", () => {
    // WRONG IMPL KILLED: one shared cursor for every unit (cycling keeps the old position); the
    // cursor snapping back to the unit's tile on every cycle (the memory is lost); memory keyed by
    // slot instead of unitId; the first render not selecting anybody; a move op ignored until the
    // next render; the memory lost on a re-render.
    const k = make();
    k.shell.render(vmOf());
    expect(k.shell.selectedUnitId, 'the first own Active unit is selected').toBe(1);
    expect(k.shell.cursor, 'the cursor starts on that unit').toEqual({ x: 1, y: 1 });

    move(k, 'Right');
    move(k, 'Down');
    expect(k.shell.cursor, 'unit 1 moved to (2,2)').toEqual({ x: 2, y: 2 });
    expect(cursorTiles(k.root), 'the cursor is painted without a render call').toEqual(['2,2']);

    k.shell.cycleUnit(1);
    expect(k.shell.selectedUnitId, 'cycled to unit 2').toBe(2);
    expect(k.shell.cursor, 'unit 2 has no memory: its own tile').toEqual({ x: 3, y: 2 });
    move(k, 'Right');
    expect(k.shell.cursor, 'unit 2 moved to (4,2)').toEqual({ x: 4, y: 2 });

    k.shell.cycleUnit(-1);
    expect(k.shell.selectedUnitId, 'back to unit 1').toBe(1);
    expect(k.shell.cursor, 'unit 1 remembered (2,2)').toEqual({ x: 2, y: 2 });
    k.shell.cycleUnit(1);
    expect(k.shell.cursor, 'unit 2 remembered (4,2)').toEqual({ x: 4, y: 2 });

    k.shell.render(vmOf());
    expect(k.shell.cursor, 'a re-render keeps the memory').toEqual({ x: 4, y: 2 });
    expect(k.shell.selectedUnitId, 'and the selection').toBe(2);
    expect(cursorTiles(k.root)).toEqual(['4,2']);
  });

  it("BT10-6-CYCLE-RULES: cycling visits OWN Active units in input order, wraps both ways, skips foes and the KO'd, falls back to first/last when the selection is gone, and is a harmless no-op without an own Active unit", () => {
    // WRONG IMPL KILLED: a cycle that lands on a foe, a wild unit or a Fainted unit; no wrap (the
    // last unit is a dead end); the wrong direction on -1; a lost selection resolving to the
    // neighbour of the old index instead of the first (+1) / last (-1) own Active unit; a throw
    // or a selection change when nobody is eligible; the selection drifting on a plain
    // re-render.
    const three = [
      unit({ unitId: 1, x: 1, y: 1 }),
      foe({ unitId: 3, x: 5, y: 1 }),
      unit({ unitId: 5, x: 0, y: 4, state: 'Fainted', curHp: 0 }),
      unit({ unitId: 2, x: 3, y: 2 }),
      foe({ unitId: 4, x: 5, y: 3 }),
      unit({ unitId: 6, x: 6, y: 4 }),
    ];
    const k = make();
    k.shell.render(vmOf({ units: three, initiative: [1, 3, 2, 4, 6], nextInitiative: [] }));
    expect(k.shell.selectedUnitId, 'first own Active').toBe(1);
    const walk = (dir: 1 | -1, n: number): (number | null)[] => {
      const out: (number | null)[] = [];
      for (let i = 0; i < n; i++) {
        k.shell.cycleUnit(dir);
        out.push(k.shell.selectedUnitId);
      }
      return out;
    };
    expect(walk(1, 4), "+1 visits 2, 6, wraps to 1, then 2 — never a foe or the KO'd unit").toEqual(
      [2, 6, 1, 2],
    );
    expect(walk(-1, 4), '-1 goes back 1, wraps to 6, 2, 1').toEqual([1, 6, 2, 1]);

    k.shell.cycleUnit(1);
    k.shell.render(vmOf({ units: three, initiative: [1, 3, 2, 4, 6], nextInitiative: [] }));
    expect(k.shell.selectedUnitId, 'selection is stable across a render while alive').toBe(2);
    const reordered = [three[3], three[0], ...three.slice(1, 3), ...three.slice(4)];
    k.shell.render(vmOf({ units: reordered, initiative: [2, 1], nextInitiative: [] }));
    expect(k.shell.selectedUnitId, 'and across a reordered unit list').toBe(2);

    // The selected unit is KO'd (ROUND 2, R7: the render RESELECTS the first own Active unit, the
    // same rule as the first render), so the next cycle steps from that unit and wraps normally.
    // bt-11 (named intentional change, A28): these renders name NO active unit — an own Waiting
    // unit is now selected by the render itself (BT11-6-SELECT-FOLLOWS-TURN), which would mask
    // the first-own-Active rule this fixture is about.
    const order = [
      unit({ unitId: 6, x: 6, y: 4 }),
      unit({ unitId: 1, x: 1, y: 1 }),
      unit({ unitId: 2, x: 3, y: 2 }),
    ];
    const gone = (dir: 1 | -1): { afterRender: number | null; afterCycle: number | null } => {
      const g = make();
      g.shell.render(
        vmOf({ units: order, initiative: [6, 1, 2], nextInitiative: [], activeUnitId: null }),
      );
      expect(g.shell.selectedUnitId, 'fixture: the first own Active is 6').toBe(6);
      g.shell.cycleUnit(1);
      expect(g.shell.selectedUnitId, 'fixture: cycled to unit 1').toBe(1);
      const ko = order.map((u) =>
        u.unitId === 1 ? { ...u, state: 'Fainted' as const, curHp: 0 } : u,
      );
      g.shell.render(
        vmOf({ units: ko, initiative: [6, 1, 2], nextInitiative: [], activeUnitId: null }),
      );
      const afterRender = g.shell.selectedUnitId;
      g.shell.cycleUnit(dir);
      return { afterRender, afterCycle: g.shell.selectedUnitId };
    };
    const plus = gone(1);
    expect(plus.afterRender, "selection KO'd: the render reselects the FIRST own Active (6)").toBe(
      6,
    );
    expect(plus.afterCycle, "then +1 steps from 6 to 2 (the KO'd unit 1 is skipped)").toBe(2);
    const minus = gone(-1);
    expect(minus.afterRender, 'same reselection whatever the later direction').toBe(6);
    expect(minus.afterCycle, 'then -1 wraps from 6 to the last own Active (2)').toBe(2);

    // Nobody to select.
    const none = make();
    const allDown = UNITS.map((u) => (u.mine ? { ...u, state: 'Fainted' as const, curHp: 0 } : u));
    none.shell.render(
      vmOf({ units: allDown, activeUnitId: null, initiative: [3, 4], nextInitiative: [] }),
    );
    expect(none.shell.selectedUnitId, 'no own Active unit: nothing selected').toBeNull();
    const cursorBefore = none.shell.cursor;
    expect(() => none.shell.cycleUnit(1), 'cycle +1 with nobody does not throw').not.toThrow();
    expect(() => none.shell.cycleUnit(-1), 'cycle -1 with nobody does not throw').not.toThrow();
    expect(none.shell.selectedUnitId, 'still nothing selected').toBeNull();
    expect(none.shell.cursor, 'the cursor did not move').toEqual(cursorBefore);
  });

  it('BT10-6-REACH-DPAD: D-pad move presses alone reach every tile of a 7x5 board (and never leave it), each step is reversible, and the unit under the cursor gets the expanded info row', () => {
    // WRONG IMPL KILLED: a cursor that clamps at the wrong width/height (a column or a row
    // unreachable by keyboard); a cursor stuck on units; a clamp that is not symmetrical; the
    // hover reachable by the mouse only (the expanded row must follow the D-pad cursor); more
    // than one expanded row; an expansion left behind on a tile with nobody.
    const k = make();
    k.shell.render(vmOf());
    const seen = new Set<string>();
    const key = (t: { x: number; y: number }): string => `${t.x},${t.y}`;
    const here = (): { x: number; y: number } => {
      const c = k.shell.cursor;
      if (c === null) throw new Error('the cursor is null');
      return c;
    };
    const DIRS = [
      ['Right', 'Left'],
      ['Left', 'Right'],
      ['Down', 'Up'],
      ['Up', 'Down'],
    ] as const;
    const walk = (): void => {
      const origin = here();
      seen.add(key(origin));
      for (const [dir, back] of DIRS) {
        move(k, dir);
        const there = here();
        if (there.x === origin.x && there.y === origin.y) continue;
        expect(
          there.x >= 0 && there.x < 7 && there.y >= 0 && there.y < 5,
          `${key(there)} is on the board`,
        ).toBe(true);
        if (!seen.has(key(there))) walk();
        move(k, back);
        expect(here(), `${dir} then ${back} returns to ${key(origin)}`).toEqual(origin);
      }
    };
    walk();
    expect(seen.size, 'all 35 tiles reached by D-pad moves alone').toBe(35);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 7; x++) {
        expect(seen.has(`${x},${y}`), `tile (${x},${y}) is reachable`).toBe(true);
      }
    }

    // Hover by D-pad: start (1,1) holds unit 1.
    const h = make();
    h.shell.render(vmOf());
    expect(expandedIds(h.root), 'the unit under the starting cursor is expanded').toEqual(['1']);
    for (let i = 0; i < 4; i++) move(h, 'Right');
    expect(h.shell.cursor, 'the cursor reached the wild at (5,1)').toEqual({ x: 5, y: 1 });
    expect(expandedIds(h.root), 'a foe is expanded by cursor hover alone').toEqual(['3']);
    move(h, 'Left');
    expect(expandedIds(h.root), '(4,1) holds nobody: nothing expanded').toEqual([]);
    move(h, 'Down');
    move(h, 'Left');
    expect(h.shell.cursor).toEqual({ x: 3, y: 2 });
    expect(expandedIds(h.root), 'an own unit is expanded too').toEqual(['2']);
  });

  it('BT10-6-HOVER-TARGET: an Active targetUnitId takes precedence over the unit under the cursor; a Fainted or unknown target falls back to the cursor unit', () => {
    // WRONG IMPL KILLED: the cursor unit winning over the target (aiming at a foe must show the
    // foe's box); the target honoured even when it names a Fainted or unknown unit (an empty
    // expansion, or a throw); both units expanded.
    const k = make();
    k.shell.render(vmOf());
    for (let i = 0; i < 4; i++) move(k, 'Right');
    expect(expandedIds(k.root), 'fixture: cursor on the wild 3').toEqual(['3']);
    k.shell.render(vmOf({ targetUnitId: 4 }));
    expect(expandedIds(k.root), 'target 4 beats the cursor unit 3').toEqual(['4']);
    k.shell.render(vmOf({ targetUnitId: 2 }));
    expect(expandedIds(k.root), 'an own target works too').toEqual(['2']);
    k.shell.render(vmOf({ targetUnitId: 5 }));
    expect(expandedIds(k.root), 'a Fainted target falls back to the cursor unit').toEqual(['3']);
    expect(
      () => k.shell.render(vmOf({ targetUnitId: 999 })),
      'an unknown target does not throw',
    ).not.toThrow();
    expect(expandedIds(k.root), 'an unknown target falls back to the cursor unit').toEqual(['3']);
    k.shell.render(vmOf({ targetUnitId: null }));
    expect(expandedIds(k.root), 'no target: the cursor unit').toEqual(['3']);
  });
});

// ---------------------------------------------------------------------------------------------
// BT10.3 — never recentre, at the shell
// ---------------------------------------------------------------------------------------------

interface RecentreProbe {
  readonly calls: string[];
  restore(): void;
}

/** Records every scrollIntoView / scrollTo / scrollBy / focus call and every scrollLeft /
 *  scrollTop write on ANY element, whichever prototype (Element, HTMLElement) defines it; a name
 *  the environment lacks is defined on Element.prototype so a write there is still seen. */
function probeRecentring(): RecentreProbe {
  const calls: string[] = [];
  const undo: (() => void)[] = [];
  const protos: object[] = [Element.prototype, HTMLElement.prototype];
  for (const name of ['scrollIntoView', 'scrollTo', 'scrollBy', 'focus']) {
    let seen = false;
    for (const proto of protos) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc === undefined || typeof desc.value !== 'function') continue;
      seen = true;
      const original = desc.value as (...a: unknown[]) => unknown;
      Object.defineProperty(proto, name, {
        ...desc,
        value: function (this: unknown, ...args: unknown[]) {
          calls.push(name);
          return original.apply(this, args);
        },
      });
      undo.push(() => Object.defineProperty(proto, name, desc));
    }
    if (!seen) {
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        writable: true,
        value: () => {
          calls.push(name);
        },
      });
      undo.push(() => Reflect.deleteProperty(Element.prototype, name));
    }
  }
  for (const name of ['scrollLeft', 'scrollTop']) {
    let seen = false;
    for (const proto of protos) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc === undefined || desc.set === undefined) continue;
      seen = true;
      const set = desc.set;
      Object.defineProperty(proto, name, {
        ...desc,
        set(this: unknown, value: unknown) {
          calls.push(`${name}=`);
          set.call(this, value);
        },
      });
      undo.push(() => Object.defineProperty(proto, name, desc));
    }
    if (!seen) {
      const store = new WeakMap<object, number>();
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        get(this: object) {
          return store.get(this) ?? 0;
        },
        set(this: object, value: number) {
          calls.push(`${name}=`);
          store.set(this, value);
        },
      });
      undo.push(() => Reflect.deleteProperty(Element.prototype, name));
    }
  }
  return {
    calls,
    restore: () => {
      for (const fn of undo.reverse()) fn();
    },
  };
}

describe('TacticsBattle: the turn bar never recentres (BT10.3)', () => {
  it('BT10-3-SHELL-NO-RECENTRE: advancing the turn, cycling the selection and moving the cursor make no scroll/focus/scrollLeft/scrollTop call, and the turn bar chip host is the same node throughout', () => {
    // WRONG IMPL KILLED: the shell scrolling the new current chip into view on a turn change, or
    // the selected unit's chip on cycleUnit (selection must NOT recentre the bar); focus() pulled
    // onto the bar or the board on a repaint (the D-pad's place is lost); the bar rebuilt on every
    // render (its scroll position resets).
    const k = make();
    k.shell.render(vmOf({ turnIdx: 0 }));
    const host = q(k.root, '.tactics-turnbar .tactics-chip').parentElement;
    expect(host, 'the turn bar has a chip host').not.toBeNull();
    const currentOf = (): string[] =>
      [...k.root.querySelectorAll('.tactics-turnbar .tactics-chip--current')].map(
        (c) => c.getAttribute('data-unit-id') ?? '',
      );
    expect(currentOf(), 'fixture: unit 1 is current').toEqual(['1']);

    const probe = probeRecentring();
    try {
      k.shell.render(vmOf({ turnIdx: 1 }));
      k.shell.cycleUnit(1);
      move(k, 'Right');
      k.shell.render(vmOf({ turnIdx: 2, round: 2 }));
      k.shell.cycleUnit(-1);
      k.shell.toggleDanger();
      k.shell.render(vmOf({ turnIdx: 3 }));
      expect(probe.calls, 'no recentring activity at all').toEqual([]);
    } finally {
      probe.restore();
    }
    expect(
      q(k.root, '.tactics-turnbar .tactics-chip').parentElement,
      'the chip host is the same node after all of that',
    ).toBe(host);
    expect(currentOf(), 'the highlight did follow the turn (unit 4 at turnIdx 3)').toEqual(['4']);
  });
});

// ---------------------------------------------------------------------------------------------
// BT10.4 — the danger toggle
// ---------------------------------------------------------------------------------------------

describe('TacticsBattle: the danger toggle (BT10.4)', () => {
  it('BT10-4-SHELL-DANGER: toggleDanger flips dangerOn and repaints the de-duplicated danger union the rules compute only while on; the toggle survives a re-render; activate neither toggles danger nor moves the cursor', () => {
    // WRONG IMPL KILLED: a toggle that flips the flag but never repaints (or repaints only on the
    // next render); danger painted while off; one danger tile per enemy overlap; the flag reset
    // by render(); activate (A) toggling danger or moving the cursor (bt-11: it opens the command
    // menu). bt-11 (named intentional change): the danger lists come from the rules port's
    // overlays() answer (the shell asks it on every paint), no longer from the VM.
    const k = make();
    k.fake.script.danger = [
      [
        { x: 4, y: 0 },
        { x: 5, y: 0 },
      ],
      [
        { x: 5, y: 0 },
        { x: 6, y: 0 },
      ],
    ];
    k.shell.render(vmOf());
    const dangerTiles = (): string[] =>
      [...k.root.querySelectorAll('.tactics-tile--danger')].map(
        (t) => `${t.getAttribute('data-x')},${t.getAttribute('data-y')}`,
      );
    expect(k.shell.dangerOn, 'off by default').toBe(false);
    expect(dangerTiles(), 'nothing painted while off').toEqual([]);

    k.shell.toggleDanger();
    expect(k.shell.dangerOn, 'on after one toggle').toBe(true);
    expect(dangerTiles().sort(), 'the union of both enemy sets, once each').toEqual([
      '4,0',
      '5,0',
      '6,0',
    ]);

    k.shell.render(vmOf({ round: 2 }));
    expect(k.shell.dangerOn, 'a render keeps the toggle').toBe(true);
    expect(dangerTiles().sort(), 'and keeps the paint').toEqual(['4,0', '5,0', '6,0']);

    const cursorBefore = k.shell.cursor;
    k.shell.applyBattleOp({ kind: 'activate' });
    expect(k.shell.dangerOn, 'activate does not toggle danger').toBe(true);
    expect(k.shell.cursor, 'activate does not move the cursor').toEqual(cursorBefore);

    k.shell.toggleDanger();
    expect(k.shell.dangerOn, 'off after a second toggle').toBe(false);
    expect(dangerTiles(), 'cleared again').toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// BT10.5 — ingest, skip, reduced motion, banner
// ---------------------------------------------------------------------------------------------

const roundEnded = (round: number): EventPayload => ({ tag: 'RoundEnded', value: { round } });

describe('TacticsBattle: events, skip and motion (BT10.5)', () => {
  it("BT10-5-SHELL-INGEST: every ingested event is a ticker line IMMEDIATELY — before any playback tick, in both motion modes — built through the names dependency and the viewer's side; the list keeps the newest 50", () => {
    // WRONG IMPL KILLED: ticker lines released beat by beat with the playback (a player on
    // reduced motion, or one who skips, would see none); lines pushed only when motion is
    // reduced; the cap not applied (60 children); ids shown raw instead of through names; the
    // viewer's side ignored (a B player would read "won" on a loss); events dropped or reordered
    // across two ingests.
    for (const reduce of [false, true]) {
      const k = make(reduce);
      k.shell.render(vmOf());
      k.shell.ingest(Array.from({ length: 60 }, (_, i) => roundEnded(i + 1)));
      const texts = tickerTexts(k.root);
      expect(texts, `reduce=${reduce}: fifty lines right after ingest`).toHaveLength(50);
      expect(texts[0], `reduce=${reduce}: the oldest kept is round 11`).toBe(
        en('tactics.ticker.roundEnded', { round: 11 }),
      );
      expect(texts[49], `reduce=${reduce}: the newest is last`).toBe(
        en('tactics.ticker.roundEnded', { round: 60 }),
      );
    }

    const k = make(false);
    k.shell.render(vmOf());
    const executed: EventPayload = {
      tag: 'Executed',
      value: {
        attacker: 1,
        skillId: 7,
        results: [
          {
            unit: 3,
            hit: true,
            damage: 12,
            effectiveness: undefined,
            flank: false,
            guard: false,
            ko: true,
          },
          {
            unit: 4,
            hit: false,
            damage: 0,
            effectiveness: undefined,
            flank: false,
            guard: false,
            ko: false,
          },
        ],
      },
    };
    // ROUND 2 (R1): the miss and the ko have their own events, so this line shows the hit only.
    k.shell.ingest([executed]);
    k.shell.ingest([]);
    k.shell.ingest([{ tag: 'StoodGround', value: { unit: 3 } }]);
    const EM = String.fromCharCode(0x2014);
    expect(
      tickerTexts(k.root),
      'names resolve ids; two ingests keep their order; an empty ingest adds nothing',
    ).toEqual([
      [
        en('tactics.ticker.executed', { unit: 'unit#1', skill: 'skill#7' }),
        en('tactics.ticker.hit', { target: 'unit#3', damage: 12 }),
      ].join(` ${EM} `),
      en('tactics.ticker.stoodGround', { unit: 'unit#3' }),
    ]);

    const end = (side: Side): string | null => {
      const s = make(false, side);
      s.shell.render(vmOf());
      s.shell.ingest([
        {
          tag: 'BattleEnd',
          value: { outcome: { tag: 'SideBWins' }, how: { tag: 'SideEmpty' } },
        } as unknown as EventPayload,
      ]);
      return tickerTexts(s.root)[0];
    };
    expect(end('B'), 'side B player: B wins is a win').toBe(en('tactics.ticker.won'));
    expect(end('A'), 'side A player: B wins is a loss').toBe(en('tactics.ticker.lost'));
  });

  it('BT10-5-SHELL-SKIP: B while playback runs changes nothing observable (cursor, danger, ticker) and drains it (a later tick leaves the frame untouched); B while idle is a no-op; hide() drains too and the ticker persists', () => {
    // WRONG IMPL KILLED: B moving the cursor, toggling danger or clearing the ticker (it is the
    // SKIP key, not back-out in bt-10); B throwing when nothing plays; a tick after a skip
    // replaying beats into the frame; hide() wiping the ticker log; an ingest after a hide
    // being lost.
    const events: EventPayload[] = [
      { tag: 'BattleStarted', value: { round: 1 } },
      { tag: 'Executed', value: { attacker: 1, skillId: 7, results: [] } },
      roundEnded(1),
    ];
    const k = make(false);
    k.shell.render(vmOf());
    move(k, 'Right');
    k.shell.toggleDanger();
    k.shell.ingest(events);
    const textsBefore = tickerTexts(k.root);
    const cursorBefore = k.shell.cursor;
    expect(textsBefore, 'fixture: three lines').toHaveLength(3);

    k.shell.applyBattleOp({ kind: 'back' });
    expect(tickerTexts(k.root), 'B during playback: the ticker is untouched').toEqual(textsBefore);
    expect(k.shell.cursor, 'B during playback: the cursor is untouched').toEqual(cursorBefore);
    expect(k.shell.dangerOn, 'B during playback: danger is untouched').toBe(true);
    const frozen = k.root.innerHTML;
    k.clock.t = 1_000_000;
    expect(() => k.shell.tick(), 'a tick after a skip does not throw').not.toThrow();
    expect(k.root.innerHTML, 'a tick after a skip leaves the frame as it was').toBe(frozen);

    // Idle: everything has played; B is a no-op.
    const idleSnap = {
      cursor: k.shell.cursor,
      danger: k.shell.dangerOn,
      texts: tickerTexts(k.root),
      html: k.root.innerHTML,
    };
    expect(
      () => k.shell.applyBattleOp({ kind: 'back' }),
      'B while idle does not throw',
    ).not.toThrow();
    expect(k.shell.cursor, 'idle B: cursor').toEqual(idleSnap.cursor);
    expect(k.shell.dangerOn, 'idle B: danger').toBe(idleSnap.danger);
    expect(tickerTexts(k.root), 'idle B: ticker').toEqual(idleSnap.texts);
    expect(k.root.innerHTML, 'idle B: the frame').toBe(idleSnap.html);

    const fresh = make(false);
    fresh.shell.render(vmOf());
    const freshHtml = fresh.root.innerHTML;
    const freshCursor = fresh.shell.cursor;
    fresh.shell.applyBattleOp({ kind: 'back' });
    expect(fresh.shell.cursor, 'B on a fresh shell: cursor').toEqual(freshCursor);
    expect(fresh.shell.dangerOn, 'B on a fresh shell: danger').toBe(false);
    expect(fresh.root.innerHTML, 'B on a fresh shell: the frame').toBe(freshHtml);
    expect(() => fresh.shell.tick(), 'tick with nothing queued').not.toThrow();

    // hide() drains the queue and keeps the log.
    const h = make(false);
    h.shell.render(vmOf());
    h.shell.ingest(events);
    h.shell.hide();
    expect(h.shell.visible, 'hidden').toBe(false);
    expect(tickerTexts(h.root), 'the ticker persists through hide()').toHaveLength(3);
    h.clock.t = 1_000_000;
    expect(() => h.shell.tick(), 'tick after hide does not throw').not.toThrow();
    h.shell.show();
    expect(tickerTexts(h.root), 'and through show()').toHaveLength(3);
    h.shell.ingest([roundEnded(2)]);
    expect(tickerTexts(h.root), 'a later ingest appends').toHaveLength(4);
  });

  it('BT10-5-SHELL-REDUCED: the root wears tactics--reduced exactly when reduceMotion() is true at render time (read live, never cached), and ingest still fills the ticker in both states', () => {
    // WRONG IMPL KILLED: the flag read once in the constructor (a player who turns reduced motion
    // on mid-battle keeps the slides); the class left on after the preference is cleared; the
    // class on a shell whose reduceMotion() is false; ingest skipping the ticker when reduced.
    const k = make(false);
    k.shell.render(vmOf());
    expect(k.root.classList.contains('tactics--reduced'), 'off while the preference is off').toBe(
      false,
    );
    k.motion.reduce = true;
    k.shell.render(vmOf());
    expect(
      k.root.classList.contains('tactics--reduced'),
      'on after the preference flips and a render',
    ).toBe(true);
    k.shell.ingest([roundEnded(1)]);
    expect(tickerTexts(k.root), 'reduced ingest: the ticker line is there at once').toEqual([
      en('tactics.ticker.roundEnded', { round: 1 }),
    ]);
    k.motion.reduce = false;
    k.shell.render(vmOf());
    expect(
      k.root.classList.contains('tactics--reduced'),
      'off again after the preference clears',
    ).toBe(false);
    k.shell.ingest([roundEnded(2)]);
    expect(tickerTexts(k.root), 'non-reduced ingest: the next line too').toEqual([
      en('tactics.ticker.roundEnded', { round: 1 }),
      en('tactics.ticker.roundEnded', { round: 2 }),
    ]);

    const born = make(true);
    born.shell.render(vmOf());
    expect(
      born.root.classList.contains('tactics--reduced'),
      'a shell built under reduced motion',
    ).toBe(true);
  });

  it("BT10-5-SHELL-BANNER: the turn banner is shown (with the catalog text) for the current unit only when it is not READY and not AI — an own live turn or a human opponent's — and hidden for a READY unit, a wild AI unit, a KO'd unit or no current unit", () => {
    // WRONG IMPL KILLED: a banner on a READY turn or on a wild turn (the spec forbids both); a
    // banner reserved for own units (the human opponent's turn also gets one); the banner never
    // shown; a stale banner left after the turn moves on; the text hard-coded instead of
    // tactics.banner.turn; a banner for a turn index that names nobody.
    const bannerShown = (root: HTMLElement): boolean => {
      const el = root.querySelector<HTMLElement>('.tactics-banner');
      return (
        el !== null &&
        !el.hidden &&
        !el.hasAttribute('hidden') &&
        el.style.display !== 'none' &&
        (el.textContent ?? '') !== ''
      );
    };
    const bannerText = (root: HTMLElement): string => q(root, '.tactics-banner').textContent ?? '';
    const acceptable = (id: number, speciesName: string): string[] => [
      en('tactics.banner.turn', { unit: `unit#${id}` }),
      en('tactics.banner.turn', { unit: speciesName }),
    ];

    const k = make();
    k.shell.render(vmOf({ turnIdx: 0, activeUnitId: 1 }));
    expect(bannerShown(k.root), 'own, not READY: shown').toBe(true);
    expect(acceptable(1, 'Sprigg'), `banner text "${bannerText(k.root)}"`).toContain(
      bannerText(k.root),
    );

    // bt-11 (named intentional change): a READY row is a `readyPlans` entry (was `readyUnitIds`).
    k.shell.render(vmOf({ turnIdx: 0, readyPlans: readyOf([[1, ['EndTurn']]]) }));
    expect(bannerShown(k.root), 'own, READY: hidden').toBe(false);

    k.shell.render(vmOf({ turnIdx: 1, activeUnitId: 3 }));
    expect(bannerShown(k.root), 'wild AI unit (unit 3): hidden').toBe(false);

    k.shell.render(vmOf({ turnIdx: 2, activeUnitId: 2 }));
    expect(bannerShown(k.root), 'the next own unit, not READY: shown again (no stale hide)').toBe(
      true,
    );
    expect(acceptable(2, 'Cindertail'), `banner text "${bannerText(k.root)}"`).toContain(
      bannerText(k.root),
    );

    const humanFoe = UNITS.map((u) => (u.unitId === 3 ? { ...u, ai: false } : u));
    k.shell.render(vmOf({ units: humanFoe, turnIdx: 1, activeUnitId: 3 }));
    expect(bannerShown(k.root), 'a human opponent, not READY: shown').toBe(true);
    k.shell.render(
      vmOf({
        units: humanFoe,
        turnIdx: 1,
        activeUnitId: 3,
        readyPlans: readyOf([[3, ['EndTurn']]]),
      }),
    );
    expect(bannerShown(k.root), 'a human opponent, READY: hidden').toBe(false);

    k.shell.render(vmOf({ turnIdx: -1 }));
    expect(bannerShown(k.root), 'no current unit (turnIdx -1): hidden').toBe(false);
    k.shell.render(vmOf({ turnIdx: 9 }));
    expect(bannerShown(k.root), 'turnIdx past the order: hidden').toBe(false);
    k.shell.render(vmOf({ initiative: [5, 1, 2], turnIdx: 0 }));
    expect(bannerShown(k.root), "the current unit is KO'd: hidden").toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// ROUND 2 — playback wiring, per-battle state, reselection, atomic ingest, pointer memory
// ---------------------------------------------------------------------------------------------

const PLAYING = 'tactics-battle--playing';
const isPlaying = (root: HTMLElement): boolean => root.classList.contains(PLAYING);
const executed = (): EventPayload => ({
  tag: 'Executed',
  value: { attacker: 1, skillId: 7, results: [] },
});

describe('TacticsBattle: playback wiring (BT10.5, round 2)', () => {
  it('BT10-5-SHELL-PLAYING: the root wears tactics-battle--playing exactly while a beat is in flight — set by ingest, cleared by the tick that ends it, by B and by hide() — and reduced motion plays instantly (read on every ingest)', () => {
    // WRONG IMPL KILLED (ROUND 2, R5): a Playback that nothing observable follows (the class never
    // set, so a B skip or a hide() could not be told from a no-op); a class that outlives its beat
    // (399 ms is still playing, 400 is not); B that leaves the queue running; hide() that leaves
    // it running; reduced motion that still plays a 400 ms beat; the reduceMotion flag cached at
    // construction (the flip below must change the next ingest).
    const k = make(false);
    k.shell.render(vmOf());
    expect(isPlaying(k.root), 'idle before any event').toBe(false);

    k.shell.ingest([executed()]);
    expect(isPlaying(k.root), 'a 400 ms action beat is playing right after ingest').toBe(true);
    k.clock.t = 399;
    k.shell.tick();
    expect(isPlaying(k.root), 'still playing at +399').toBe(true);
    k.clock.t = 400;
    k.shell.tick();
    expect(isPlaying(k.root), 'done at +400').toBe(false);

    k.clock.t = 1000;
    k.shell.ingest([executed()]);
    expect(isPlaying(k.root), 'a second beat plays').toBe(true);
    k.shell.applyBattleOp({ kind: 'back' });
    expect(isPlaying(k.root), 'B mid-beat clears it at once').toBe(false);
    k.clock.t = 100_000;
    k.shell.tick();
    expect(isPlaying(k.root), 'and a following tick leaves it clear').toBe(false);

    k.shell.ingest([executed()]);
    expect(isPlaying(k.root), 'a third beat plays').toBe(true);
    k.shell.hide();
    expect(isPlaying(k.root), 'hide() mid-beat clears it').toBe(false);
    k.shell.show();
    expect(isPlaying(k.root), 'and show() does not resurrect it').toBe(false);
    k.clock.t = 200_000;
    k.shell.tick();
    expect(isPlaying(k.root), 'nor does a later tick').toBe(false);

    // Reduced motion: every beat is 0 ms, so ONE tick at the same `now` finishes it.
    const r = make(true);
    r.shell.render(vmOf());
    r.shell.ingest([executed()]);
    r.shell.tick();
    expect(isPlaying(r.root), 'reduced: one tick at the same now ends the beat').toBe(false);
    r.motion.reduce = false;
    r.shell.ingest([executed()]);
    expect(
      isPlaying(r.root),
      'reduceMotion() flipped off is read on the next ingest: it plays',
    ).toBe(true);
    r.shell.tick();
    expect(isPlaying(r.root), 'at the same now a 400 ms beat is not done').toBe(true);
    r.clock.t = 400;
    r.shell.tick();
    expect(isPlaying(r.root), 'done at +400').toBe(false);
    r.motion.reduce = true;
    r.shell.ingest([executed()]);
    r.shell.tick();
    expect(isPlaying(r.root), 'flipped back on: instant again').toBe(false);
  });

  it('BT10-5-SHELL-HIDDEN-INGEST: an ingest while the view is hidden (never shown, or after hide) still fills the ticker but starts no playback', () => {
    // WRONG IMPL KILLED (ROUND 2, R5): a hidden view queueing beats nobody sees, then dumping the
    // backlog as a playing state the moment it is shown; ticker lines dropped while hidden (the
    // log must be complete when the player returns).
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const shell = new TacticsBattle(parent, depsOf());
    const root = q(parent, '.tactics-battle');
    shell.ingest([executed(), roundEnded(1)]);
    expect(tickerTexts(root), 'never shown: the lines are there').toEqual([
      en('tactics.ticker.executed', { unit: 'unit#1', skill: 'skill#7' }),
      en('tactics.ticker.roundEnded', { round: 1 }),
    ]);
    expect(isPlaying(root), 'never shown: no playback').toBe(false);
    shell.show();
    expect(isPlaying(root), 'showing does not start the backlog').toBe(false);

    const k = make(false);
    k.shell.render(vmOf());
    k.shell.hide();
    k.shell.ingest([executed()]);
    expect(tickerTexts(k.root), 'after hide: the line is there').toHaveLength(1);
    expect(isPlaying(k.root), 'after hide: no playback').toBe(false);
    k.shell.show();
    expect(isPlaying(k.root), 'after show: still none').toBe(false);
    k.shell.ingest([executed()]);
    expect(isPlaying(k.root), 'a visible ingest plays again').toBe(true);
  });

  it('BT10-5-SHELL-INGEST-ATOMIC: an ingest holding an event the client cannot render throws and commits NOTHING — no ticker line, no playback — whichever position the bad event holds', () => {
    // WRONG IMPL KILLED (ROUND 2, R8): lines pushed one by one until the forged event throws (the
    // log keeps the first half of a batch and the playback never hears of it); the beats queued
    // before the throw; a failed ingest that poisons the next valid one.
    const forged = { tag: 'FutureThing', value: {} } as unknown as EventPayload;
    const fresh = make(false);
    fresh.shell.render(vmOf());
    expect(() => fresh.shell.ingest([executed(), forged]), 'bad event last').toThrow();
    expect(tickerTexts(fresh.root), 'nothing committed to the ticker').toEqual([]);
    expect(isPlaying(fresh.root), 'nothing queued for playback').toBe(false);

    const k = make(false);
    k.shell.render(vmOf());
    k.shell.ingest([roundEnded(1)]);
    k.clock.t = 100_000;
    k.shell.tick();
    const base = tickerTexts(k.root);
    expect(base, 'fixture: one committed line').toHaveLength(1);
    expect(isPlaying(k.root), 'fixture: idle').toBe(false);

    expect(() => k.shell.ingest([forged, executed()]), 'bad event first').toThrow();
    expect(tickerTexts(k.root), 'bad first: ticker untouched').toEqual(base);
    expect(isPlaying(k.root), 'bad first: no playback').toBe(false);
    expect(
      () => k.shell.ingest([executed(), roundEnded(2), forged, executed()]),
      'bad in the middle',
    ).toThrow();
    expect(tickerTexts(k.root), 'bad in the middle: ticker untouched').toEqual(base);
    expect(isPlaying(k.root), 'bad in the middle: no playback').toBe(false);

    k.shell.ingest([roundEnded(3)]);
    expect(tickerTexts(k.root), 'a valid ingest afterwards still works').toEqual([
      ...base,
      en('tactics.ticker.roundEnded', { round: 3 }),
    ]);
  });
});

describe('TacticsBattle: per-battle state and selection (BT10.6, round 2)', () => {
  it('BT10-6-SHELL-NEW-BATTLE: rendering a different battleId resets the cursor memory, the selection, the ticker, the danger toggle and the playback, so a reused unit id starts on its NEW tile', () => {
    // WRONG IMPL KILLED (ROUND 2, R6): the shell outliving a battle with its old state — unit 1's
    // remembered (3,1) from battle 1 applied to a different unit 1 in battle 2 (the cursor lands
    // on another monster's tile or off the new board); the stale selection (unit 2) kept; last
    // battle's log still in the ticker; danger left on; a playback still running.
    const k = make(false);
    k.shell.render(vmOf({ battleId: 1n }));
    move(k, 'Right');
    move(k, 'Right');
    expect(k.shell.cursor, 'fixture: unit 1 remembered (3,1)').toEqual({ x: 3, y: 1 });
    k.shell.cycleUnit(1);
    move(k, 'Right');
    expect(k.shell.selectedUnitId, 'fixture: unit 2 selected').toBe(2);
    expect(k.shell.cursor, 'fixture: unit 2 remembered (4,2)').toEqual({ x: 4, y: 2 });
    k.shell.toggleDanger();
    k.shell.ingest([executed(), roundEnded(1)]);
    expect(tickerTexts(k.root), 'fixture: two lines').toHaveLength(2);
    expect(isPlaying(k.root), 'fixture: playing').toBe(true);

    const second: readonly TacticalUnit[] = [
      unit({ unitId: 1, x: 0, y: 3, speciesName: 'Newleaf' }),
      unit({ unitId: 2, x: 5, y: 4 }),
      unit({ unitId: 7, x: 6, y: 0 }),
      foe({ unitId: 8, x: 4, y: 4 }),
    ];
    // bt-11 (named intentional change): battle 2's danger list comes from the rules port.
    k.fake.script.danger = [[{ x: 2, y: 2 }]];
    k.shell.render(
      vmOf({
        battleId: 2n,
        units: second,
        initiative: [1, 8, 7, 2],
        nextInitiative: [],
        activeUnitId: 1,
      }),
    );
    expect(k.shell.selectedUnitId, 'the first own Active of the NEW battle (not the stale 2)').toBe(
      1,
    );
    expect(k.shell.cursor, "unit 1's tile in battle 2, not the remembered (3,1)").toEqual({
      x: 0,
      y: 3,
    });
    expect(cursorTiles(k.root), 'painted there').toEqual(['0,3']);
    expect(tickerTexts(k.root), 'the ticker is cleared').toEqual([]);
    expect(k.shell.dangerOn, 'danger is off').toBe(false);
    expect(k.root.querySelectorAll('.tactics-tile--danger'), 'and not painted').toHaveLength(0);
    expect(isPlaying(k.root), 'the playback is drained').toBe(false);

    k.shell.cycleUnit(1);
    expect(k.shell.selectedUnitId, 'cycle -> unit 2').toBe(2);
    expect(k.shell.cursor, "unit 2's NEW tile, not its battle-1 memory (4,2)").toEqual({
      x: 5,
      y: 4,
    });
    k.shell.cycleUnit(1);
    expect(k.shell.cursor, 'unit 7').toEqual({ x: 6, y: 0 });
    k.shell.cycleUnit(1);
    expect(k.shell.selectedUnitId, 'wrapped to unit 1').toBe(1);
    expect(k.shell.cursor, 'unit 1 still on its battle-2 tile').toEqual({ x: 0, y: 3 });

    // The new battle's own log and memory work from there.
    k.shell.ingest([roundEnded(5)]);
    expect(tickerTexts(k.root), 'battle 2 logs from zero').toEqual([
      en('tactics.ticker.roundEnded', { round: 5 }),
    ]);
    k.shell.render(
      vmOf({ battleId: 2n, units: second, initiative: [1, 8, 7, 2], nextInitiative: [] }),
    );
    expect(tickerTexts(k.root), 'the SAME battleId again keeps the log').toHaveLength(1);
  });

  it("BT10-6-SHELL-RESELECT-KO: when the selected unit is KO'd the next render reselects the first own Active unit with its remembered (else current) tile, and with no own Active unit left the selection is null without a throw", () => {
    // WRONG IMPL KILLED (ROUND 2, R7): a selection that dies silently (selectedUnitId null and the
    // cursor parked on a corpse while a live own unit waits); the reselected unit's cursor not
    // restored from memory; a throw when the last own unit falls.
    const trio: readonly TacticalUnit[] = [
      unit({ unitId: 1, x: 1, y: 1 }),
      unit({ unitId: 2, x: 3, y: 2 }),
      foe({ unitId: 3, x: 5, y: 1 }),
    ];
    const withKo = (ids: readonly number[]): TacticalUnit[] =>
      trio.map((u) => (ids.includes(u.unitId) ? { ...u, state: 'Fainted' as const, curHp: 0 } : u));
    const base = { initiative: [1, 3, 2], nextInitiative: [] };

    const a = make();
    a.shell.render(vmOf({ ...base, units: trio }));
    expect(a.shell.selectedUnitId, 'fixture: unit 1 selected').toBe(1);
    a.shell.render(vmOf({ ...base, units: withKo([1]) }));
    expect(a.shell.selectedUnitId, "unit 1 KO'd: unit 2 is selected").toBe(2);
    expect(a.shell.cursor, "no memory: unit 2's current tile").toEqual({ x: 3, y: 2 });
    expect(cursorTiles(a.root), 'painted on unit 2').toEqual(['3,2']);
    a.shell.render(vmOf({ ...base, units: withKo([1]) }));
    expect(a.shell.selectedUnitId, 'and it stays selected on later renders').toBe(2);

    const b = make();
    b.shell.render(vmOf({ ...base, units: trio }));
    b.shell.cycleUnit(1);
    move(b, 'Right');
    expect(b.shell.cursor, 'fixture: unit 2 remembered (4,2)').toEqual({ x: 4, y: 2 });
    b.shell.cycleUnit(-1);
    expect(b.shell.selectedUnitId, 'fixture: back on unit 1').toBe(1);
    b.shell.render(vmOf({ ...base, units: withKo([1]) }));
    expect(b.shell.selectedUnitId, "unit 1 KO'd: unit 2").toBe(2);
    expect(b.shell.cursor, "unit 2's REMEMBERED tile").toEqual({ x: 4, y: 2 });

    const c = make();
    c.shell.render(vmOf({ ...base, units: trio }));
    expect(
      () => c.shell.render(vmOf({ ...base, units: withKo([1, 2]) })),
      'last own unit falls',
    ).not.toThrow();
    expect(c.shell.selectedUnitId, 'no own Active unit left: nothing selected').toBeNull();
    expect(() => c.shell.cycleUnit(1), 'cycling with nobody does not throw').not.toThrow();
    expect(() => move(c, 'Right'), 'moving the cursor with nobody does not throw').not.toThrow();
    expect(c.shell.selectedUnitId, 'still nothing selected').toBeNull();
  });

  it("BT10-6-POINTER-MEMORY: a pointer click writes the selected unit's cursor memory, so cycling away and back returns to the clicked tile", () => {
    // WRONG IMPL KILLED (ROUND 2, R9): a click that moves the cursor but not the memory (cycling
    // to another unit and back snaps to the old D-pad tile): mouse and D-pad must be one path.
    const k = make();
    k.shell.render(vmOf());
    expect(k.shell.selectedUnitId, 'fixture: unit 1 selected').toBe(1);
    click(q(k.root, '.tactics-tile[data-x="4"][data-y="2"]'));
    expect(k.shell.cursor, 'the click moved the cursor').toEqual({ x: 4, y: 2 });
    k.shell.cycleUnit(1);
    expect(k.shell.selectedUnitId, 'cycled to unit 2').toBe(2);
    expect(k.shell.cursor, 'unit 2 has no memory: its own tile (3,2)').toEqual({ x: 3, y: 2 });
    k.shell.cycleUnit(-1);
    expect(k.shell.selectedUnitId, 'back on unit 1').toBe(1);
    expect(k.shell.cursor, 'unit 1 remembered the CLICKED tile').toEqual({ x: 4, y: 2 });
    expect(cursorTiles(k.root)).toEqual(['4,2']);
  });
});

// =============================================================================================
// bt-11 round 3 — the command menu, the live draft, the pre-queue, the controller map
// =============================================================================================

const KINDS = ['wild', 'pvp'] as const;
type Kind = (typeof KINDS)[number];

/** A held bait (`vm.baits`, bt-12 builds it): item 43, two held. */
const BAIT: BaitOption = { itemId: 43, name: 'Lure Berry', count: 2, bonus: 150 };
/** The live unit's row budget (ap 5: back live after a halt) — never the fake's fresh one (ap 7). */
const LIVE_BUDGET: TurnBudget = { ap: 5, strides_used: 0, attacks: 0, last: null };
/** An off-turn own unit's row budget. */
const IDLE_BUDGET: TurnBudget = { ap: 0, strides_used: 0, attacks: 0, last: null };

/** 1 own (1,1) live (ap 5), 2 own (3,2) off-turn (ap 0), 3 foe (5,1), 4 foe (5,3): wild AI units in
 *  PvE, the opponent's units in PvP. */
function tacUnits(kind: Kind): TacticalUnit[] {
  const ai = kind === 'wild';
  return [
    unit({ unitId: 1, x: 1, y: 1, ap: 5, speciesName: 'Sprigg' }),
    unit({ unitId: 2, x: 3, y: 2, ap: 0, speciesName: 'Cindertail' }),
    foe({ unitId: 3, x: 5, y: 1, ai, speciesName: 'Mossback' }),
    foe({ unitId: 4, x: 5, y: 3, ai, speciesName: 'Flameling' }),
  ];
}

/** Unit 1's live turn (activeUnitId 1, turnIdx 0) unless overridden; the board rows derived. */
function tacVm(kind: Kind, o: Partial<TacticsBattleVM> = {}): TacticsBattleVM {
  return vmOf({
    kind,
    units: o.units ?? tacUnits(kind),
    initiative: [1, 3, 2, 4],
    nextInitiative: [1, 3, 2, 4],
    activeUnitId: 1,
    baits: [BAIT],
    ...o,
  });
}

const W_MOVE_2_1: QueuedAction = { tag: 'Move', value: { x: 2, y: 1, strides: 1 } };
const W_MOVE_3_1: QueuedAction = { tag: 'Move', value: { x: 3, y: 1, strides: 2 } };
const W_SKILL_12_ON_3: QueuedAction = {
  tag: 'Skill',
  value: { skillId: 12, target: { tag: 'Unit', value: 3 } },
};
const W_END: QueuedAction = { tag: 'EndTurn' };

// Ops: a NEW token object per press (the adapter's contract).
const press = (k: Kit, op: BattleOp): void => {
  k.shell.applyBattleOp(op);
};
const pressA = (k: Kit): void => press(k, { kind: 'activate' });
const pressB = (k: Kit): void => press(k, { kind: 'back' });
const pressStart = (k: Kit): void => press(k, { kind: 'start' });
const pressX = (k: Kit): void => press(k, { kind: 'danger' });
const pressCycle = (k: Kit, dir: -1 | 1): void => press(k, { kind: 'cycle', dir });

const menuOf = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>('.tactics-menu');
const menuRowEls = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('.tactics-menu .tactics-menu-row'),
];
const rowIds = (root: HTMLElement): string[] =>
  menuRowEls(root).map((r) => r.getAttribute('data-row') ?? '');
const menuRow = (root: HTMLElement, id: string): HTMLElement =>
  q(root, `.tactics-menu .tactics-menu-row[data-row="${id}"]`);
const selectedRowId = (root: HTMLElement): string | null =>
  root
    .querySelector('.tactics-menu .tactics-menu-row[aria-selected="true"]')
    ?.getAttribute('data-row') ?? null;
/** A row's label: its text without the reason span. */
function rowLabel(row: HTMLElement): string {
  const copy = row.cloneNode(true) as HTMLElement;
  for (const r of copy.querySelectorAll('.tactics-reason')) r.remove();
  return (copy.textContent ?? '').trim();
}
const rowReason = (row: HTMLElement): string | null =>
  row.querySelector('.tactics-reason')?.textContent?.trim() ?? null;
const stripChips = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('.tactics-strip .tactics-chip'),
];
const stripActions = (root: HTMLElement): string[] =>
  stripChips(root).map((ch) => ch.getAttribute('data-action') ?? '');
const ghosts = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('.tactics-ghost'),
];
const tileAt = (root: HTMLElement, t: Cell): HTMLElement =>
  q(root, `.tactics-tile[data-x="${t.x}"][data-y="${t.y}"]`);
const tileHas = (root: HTMLElement, t: Cell, cls: string): boolean =>
  tileAt(root, t).classList.contains(cls);
/** An inline style value read either way (a typed accessor or the kebab-case property). */
function css(el: HTMLElement, camel: string, kebab: string): string {
  const direct = (el.style as unknown as Record<string, unknown>)[camel];
  if (typeof direct === 'string' && direct !== '') return direct;
  return el.style.getPropertyValue(kebab);
}
const gridCell = (el: HTMLElement): [string, string] => [
  css(el, 'gridColumn', 'grid-column'),
  css(el, 'gridRow', 'grid-row'),
];
/** True when `el` carries `text` as its aria-label, its title or its whole text. */
const named = (el: Element, text: string): boolean =>
  el.getAttribute('aria-label') === text ||
  el.getAttribute('title') === text ||
  (el.textContent ?? '').trim() === text;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** D-pad the (tile or aim) cursor onto `to`, one step at a time. */
function cursorTo(k: Kit, to: Cell): void {
  for (let i = 0; i < 24; i += 1) {
    const at = k.shell.cursor;
    if (at === null) throw new Error('cursorTo: the cursor is null');
    if (at.x === to.x && at.y === to.y) return;
    let dir: 'Up' | 'Down' | 'Left' | 'Right' = 'Up';
    if (at.x < to.x) dir = 'Right';
    else if (at.x > to.x) dir = 'Left';
    else if (at.y < to.y) dir = 'Down';
    move(k, dir);
  }
  throw new Error(`cursorTo: never reached ${to.x},${to.y} (at ${JSON.stringify(k.shell.cursor)})`);
}

/** Cursor onto the unit's (live) tile and A: the command menu must open. */
function openMenuAt(k: Kit, tile: Cell, label: string): void {
  cursorTo(k, tile);
  pressA(k);
  expect(
    menuOf(k.root),
    `${label}: A on the own unit at (${tile.x},${tile.y}) opens the menu`,
  ).not.toBeNull();
}

/** Walk the open menu down to the row `id` (wrapping). */
function menuTo(k: Kit, id: string): void {
  for (let i = 0; i < 12; i += 1) {
    if (selectedRowId(k.root) === id) return;
    move(k, 'Down');
  }
  throw new Error(`menuTo: no row ${id} reached (rows: ${rowIds(k.root).join(', ')})`);
}
/** Walk to the row `id` and press A on it. */
function choose(k: Kit, id: string): void {
  menuTo(k, id);
  pressA(k);
}
/** Open unit 1's menu, Move, confirm the tile `to`: a Move chip. */
function draftMove(k: Kit, from: Cell, to: Cell, label: string): void {
  openMenuAt(k, from, label);
  menuTo(k, 'move');
  pressA(k);
  cursorTo(k, to);
  pressA(k);
}

const callsSince = (k: Kit, mark: number, name: string): Call[] =>
  k.fake.calls.slice(mark).filter((x) => x.name === name);

describe('TacticsBattle: the command menu (BT11.1)', () => {
  it('BT11-1-SHELL-MENU: A on the selected own unit opens a labelled, focused listbox of the catalog`s rows — the greyed ones aria-disabled with their reason, the cursor row aria-selected and active — that Down / Up walk (wrapping) and B closes; A on an empty tile or a foe opens nothing; the End row reads Guard exactly when the rules grant it', () => {
    // WRONG IMPL KILLED: a menu with a hard-coded or English label (the catalog's menu.label /
    // menu.* keys); rows painted as divs (no keyboard / AT button semantics) or greyed with the
    // `disabled` attribute (A34: aria-disabled, so a reason stays reachable); a greyed row with no
    // reason text, or the reason {ap} baked to 6 instead of the rules' fresh budget (ap 7 here);
    // aria-activedescendant / aria-selected not following the cursor; no wrap at either end; the
    // D-pad walking the tile cursor while the menu is open; focus left behind (A36: the listbox on
    // open, the title anchor on close); a menu for an empty tile or a foe; Guard hard-coded.
    const k = make();
    k.fake.script.refused.add(canon(['Flee']));
    k.shell.render(tacVm('wild'));
    expect(menuOf(k.root), 'no menu before A').toBeNull();
    openMenuAt(k, c(1, 1), 'unit 1');
    const m = menuOf(k.root) as HTMLElement;
    expect(m.getAttribute('role'), 'a listbox').toBe('listbox');
    expect(m.getAttribute('tabindex'), 'focusable').toBe('0');
    expect(m.getAttribute('aria-label'), 'labelled tactics.menu.label').toBe(
      en('tactics.menu.label'),
    );
    expect(document.activeElement, 'the opened listbox has the focus (A36)').toBe(m);
    expect(rowIds(k.root), 'the live PvE rows, in order').toEqual([
      'move',
      'skills',
      'item',
      'recruit',
      'flee',
      'end',
    ]);
    const rows = menuRowEls(k.root);
    const ids = rows.map((r) => r.id);
    expect(
      ids.every((id) => id !== ''),
      'every row has an id',
    ).toBe(true);
    expect(new Set(ids).size, 'the ids are distinct').toBe(rows.length);
    for (const r of rows) {
      const id = r.getAttribute('data-row');
      expect(r.tagName, `${id}: a button`).toBe('BUTTON');
      expect(r.getAttribute('role'), `${id}: an option`).toBe('option');
      expect(r.hasAttribute('disabled'), `${id}: never the disabled attribute`).toBe(false);
    }
    expect(m.getAttribute('aria-activedescendant'), 'the cursor row is the active one').toBe(
      rows[0]?.id,
    );
    expect(selectedRowId(k.root), 'the cursor starts on Move').toBe('move');
    expect(
      rows.filter((r) => r.getAttribute('aria-selected') === 'true'),
      'exactly one selected row',
    ).toHaveLength(1);
    const LABELS: Readonly<Record<string, string>> = {
      move: 'tactics.menu.move',
      skills: 'tactics.menu.skills',
      item: 'tactics.menu.item',
      recruit: 'tactics.menu.recruit',
      flee: 'tactics.menu.flee',
      end: 'tactics.menu.endTurn',
    };
    for (const [id, key] of Object.entries(LABELS)) {
      expect(rowLabel(menuRow(k.root, id)), `${id}: the catalog label`).toBe(en(key));
    }
    const GREYED: Readonly<Record<string, string>> = {
      item: en('tactics.reason.notAvailable'),
      recruit: en('tactics.reason.recruitFullAp', { ap: FRESH.ap }),
      flee: en('tactics.reason.fleeFullAp', { ap: FRESH.ap }),
    };
    for (const [id, reason] of Object.entries(GREYED)) {
      const r = menuRow(k.root, id);
      expect(r.getAttribute('aria-disabled'), `${id}: greyed`).toBe('true');
      expect(rowReason(r), `${id}: the reason, {ap} from freshBudget()`).toBe(reason);
    }
    for (const id of ['move', 'skills', 'end']) {
      const r = menuRow(k.root, id);
      expect(r.getAttribute('aria-disabled') === 'true', `${id}: enabled`).toBe(false);
      expect(rowReason(r), `${id}: no reason`).toBeNull();
    }
    expect(menuRow(k.root, 'skills').getAttribute('data-sub'), 'Skills opens a sub-list').toBe(
      'true',
    );
    expect(menuRow(k.root, 'end').getAttribute('data-sub') === 'true', 'End acts').toBe(false);

    move(k, 'Down');
    expect(selectedRowId(k.root), 'Down: Skills').toBe('skills');
    expect(menuOf(k.root)?.getAttribute('aria-activedescendant'), 'the active row follows').toBe(
      menuRow(k.root, 'skills').id,
    );
    move(k, 'Up');
    move(k, 'Up');
    expect(selectedRowId(k.root), 'Up past the top wraps to End').toBe('end');
    move(k, 'Down');
    expect(selectedRowId(k.root), 'Down past the bottom wraps to Move').toBe('move');
    expect(k.shell.cursor, 'the tile cursor stayed on the unit').toEqual(c(1, 1));

    pressB(k);
    expect(menuOf(k.root), 'B closes the menu').toBeNull();
    expect(document.activeElement, 'and the focus returns to the title anchor').toBe(
      q(k.root, '[data-testid="battle-title"]'),
    );

    cursorTo(k, c(2, 3));
    pressA(k);
    expect(menuOf(k.root), 'A on an empty tile opens nothing').toBeNull();
    cursorTo(k, c(5, 1));
    pressA(k);
    expect(menuOf(k.root), 'A on a foe opens nothing').toBeNull();

    k.fake.script.guard = true;
    k.shell.render(tacVm('wild'));
    openMenuAt(k, c(1, 1), 'guard granted');
    expect(rowLabel(menuRow(k.root, 'end')), 'the rules grant Guard: the End row reads Guard').toBe(
      en('tactics.menu.guard'),
    );
    pressB(k);
    k.fake.script.guard = false;
    k.shell.render(tacVm('wild'));
    openMenuAt(k, c(1, 1), 'no guard');
    expect(rowLabel(menuRow(k.root, 'end')), 'no Guard: End Turn').toBe(en('tactics.menu.endTurn'));
  });

  it('BT11-1-SHELL-TEXT-FROM-CATALOG: painted in French, every text node, aria-label and title in the dock — the menu rows and their reasons, the Skills sub-list, the strip and its chip, the dock buttons — is a French catalog value, a name from the names dependency, a digit string or a glyph, and none is an English catalog word', () => {
    // WRONG IMPL KILLED: a literal word in the dock (`el('button', 'c', 'Move')`, a hard-coded
    // "Skills" or "Danger") that the strings.test.ts source scan cannot see (built by concatenation
    // or in a helper); a label resolved once at construction (the French boot would read English);
    // a reason or a chip label read from the English catalog.
    setLocale('fr');
    const FRC = CATALOG_FR as unknown as Record<string, unknown>;
    const k = make();
    k.fake.script.refused.add(canon(['Flee']));
    k.shell.render(tacVm('wild'));
    draftMove(k, c(1, 1), c(2, 1), 'fr');
    expect(stripActions(k.root), 'fixture: a Move chip in the strip').toEqual(['Move']);
    openMenuAt(k, c(1, 1), 'fr');
    const rootTexts = dockTexts(k.root);
    choose(k, 'skills');
    expect(rowIds(k.root), 'fixture: the Skills sub-list').toEqual(['skill:11', 'skill:12']);
    const skillTexts = dockTexts(k.root);

    const allowed = new Set<string>();
    for (const v of Object.values(FRC)) if (typeof v === 'string') allowed.add(v);
    for (const key of ['tactics.reason.recruitFullAp', 'tactics.reason.fleeFullAp']) {
      const fn = FRC[key];
      if (typeof fn === 'function') {
        allowed.add((fn as (p: Record<string, unknown>) => string)({ ap: FRESH.ap }));
      }
    }
    for (const id of [1, 2, 3, 4]) allowed.add(`unit#${id}`);
    for (const id of [11, 12]) allowed.add(`skill#${id}`);
    allowed.add(`item#${BAIT.itemId}`);
    allowed.add(BAIT.name);
    const GLYPHS = [0x2713, 0x7e, 0x2717, 0x2014, 0xd7].map((cp) => String.fromCharCode(cp));
    const english = Object.entries(EN)
      .filter(([key, v]) => typeof v === 'string' && v !== FRC[key])
      .map(([, v]) => v as string);

    const texts = [...rootTexts, ...skillTexts];
    expect(texts.length, 'ANTI-VACUITY: the dock painted texts').toBeGreaterThanOrEqual(10);
    for (const t of texts) {
      expect(
        allowed.has(t) || /^\d+$/.test(t) || GLYPHS.includes(t),
        `"${t}" is a French catalog value, a name, digits or a glyph`,
      ).toBe(true);
      expect(english.includes(t), `"${t}" is not an English catalog value`).toBe(false);
    }
    for (const key of [
      'tactics.menu.skills',
      'tactics.reason.notAvailable',
      'tactics.dock.danger',
      'tactics.menu.move',
    ]) {
      expect(rootTexts, `ANTI-VACUITY: the root frame shows fr ${key}`).toContain(FRC[key]);
    }
    expect(skillTexts, 'ANTI-VACUITY: the sub-list names skill 12').toContain('skill#12');
  });

  it('BT11-1-SHELL-ROW-THROWS: a render whose rules call throws propagates the error and leaves the previous frame byte for byte (cursor and danger too), the next healthy render paints; a VM whose units disagree with its board rows — an id missing or extra, x, y, HP or state different — throws naming the unit and paints nothing', () => {
    // WRONG IMPL KILLED (REV 5 A30): a paint that writes the DOM as it goes (the turn bar or a unit
    // moved before the overlays throw: a half-painted frame); an error swallowed (a blank or stale
    // frame with no report); a throw that poisons the shell (the next render dead); the units and
    // the rows trusted to agree (a sprite drawn where the rules think nobody stands).
    const k = make();
    k.shell.render(tacVm('wild'));
    move(k, 'Right');
    k.shell.toggleDanger();
    const html = k.root.outerHTML;
    const cursor = k.shell.cursor;
    const moved = tacUnits('wild').map((u) => (u.unitId === 3 ? { ...u, x: 6 } : u));
    const next = tacVm('wild', { units: moved, round: 2, turnIdx: 1 });
    const boom = new Error('fake overlays: refused');
    k.fake.script.overlaysThrow = boom;
    expect(
      thrown(() => k.shell.render(next)),
      'the rules error propagates out of render',
    ).toBe(boom);
    expect(k.root.outerHTML, 'the previous frame, byte for byte').toBe(html);
    expect(k.shell.cursor, 'the cursor is unchanged').toEqual(cursor);
    expect(k.shell.dangerOn, 'the danger toggle is unchanged').toBe(true);
    k.fake.script.overlaysThrow = null;
    k.shell.render(next);
    expect(
      gridCell(q(k.root, '.tactics-unit[data-unit-id="3"]'))[0],
      'the next healthy render paints (unit 3 at x 6)',
    ).toBe('7');
    expect(k.root.outerHTML, 'a new frame').not.toBe(html);

    const P = [
      unit({ unitId: 61, x: 1, y: 1 }),
      unit({ unitId: 67, x: 3, y: 2 }),
      foe({ unitId: 71, x: 5, y: 1 }),
    ];
    const good = vmOf({ units: P, initiative: [61, 71, 67], nextInitiative: [], activeUnitId: 61 });
    const p = make();
    p.shell.render(good);
    const before = p.root.outerHTML;
    const rows = good.board.units;
    const r67 = rows[1] as UnitRow;
    const variants: readonly (readonly [string, readonly UnitRow[], string])[] = [
      ['unit 67 missing from the rows', rows.filter((r) => r.id !== 67), '67'],
      ['an extra row 73', [...rows, { ...r67, id: 73, slot: 5 }], '73'],
      ['unit 67`s x differs', rows.map((r) => (r.id === 67 ? { ...r, pos: c(4, 2) } : r)), '67'],
      ['unit 67`s y differs', rows.map((r) => (r.id === 67 ? { ...r, pos: c(3, 3) } : r)), '67'],
      ['unit 67`s HP differs', rows.map((r) => (r.id === 67 ? { ...r, cur_hp: 7 } : r)), '67'],
      [
        'unit 67`s state differs',
        rows.map((r) => (r.id === 67 ? { ...r, state: 'Fainted' as const } : r)),
        '67',
      ],
    ];
    for (const [label, units, id] of variants) {
      const err = thrown(() =>
        p.shell.render({ ...good, round: 2, board: { ...good.board, units } }),
      );
      expect(err instanceof Error, `${label}: render throws`).toBe(true);
      expect(
        err instanceof Error ? err.message : '',
        `${label}: the error names unit ${id}`,
      ).toContain(id);
      expect(p.root.outerHTML, `${label}: nothing is painted`).toBe(before);
    }
    p.shell.render({ ...good, round: 2 });
    expect(p.root.outerHTML, 'control: the agreeing VM paints round 2').not.toBe(before);
  });
});

/** Every text node, aria-label and title inside the dock, trimmed, non-empty. */
function dockTexts(root: HTMLElement): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? '').trim();
      if (t !== '') out.push(t);
      return;
    }
    if (n instanceof Element) {
      for (const attr of ['aria-label', 'title']) {
        const v = n.getAttribute(attr);
        if (v !== null && v.trim() !== '') out.push(v.trim());
      }
    }
    for (const child of n.childNodes) walk(child);
  };
  walk(q(root, '.tactics-dock'));
  return out;
}

describe('TacticsBattle: the live draft (BT11.2)', () => {
  it('BT11-2-SHELL-GHOST: in PvE and PvP, Move on the live unit shows the rules` band on the cost board from the unit`s own budget with the aim on its tile; A on a band tile drafts a Move of that band`s strides — a ghost at the destination, the sprite on its live tile, one chip, nothing sent — A off the band drafts nothing; and B pops the chip for free', () => {
    // WRONG IMPL KILLED: the band computed in TS, or asked with freshBudget() on a live turn (ap 7
    // instead of the unit's 5) or of a board other than the cost board; the aim starting elsewhere;
    // a tile outside the band accepted as a Move (or the aim dropped); reach2 drafted as one stride
    // (the rules are then asked to cost the wrong Move); a Move that SUBMITS (BT11.2: a draft);
    // the sprite moved instead of a ghost, two ghosts, or a ghost off the destination cell; the
    // strip empty; B that sends, keeps the ghost, or only works in PvE ("in PvE and PvP alike").
    for (const kind of KINDS) {
      const k = make();
      k.shell.render(tacVm(kind));
      openMenuAt(k, c(1, 1), kind);
      expect(selectedRowId(k.root), `${kind}: the cursor row starts on Move`).toBe('move');
      const mark = k.fake.calls.length;
      pressA(k);
      expect(k.shell.cursor, `${kind}: the aim starts on the unit's tile`).toEqual(c(1, 1));
      expect(tileHas(k.root, c(2, 1), 'tactics-tile--reach1'), `${kind}: (2,1) is reach1`).toBe(
        true,
      );
      expect(tileHas(k.root, c(3, 1), 'tactics-tile--reach2'), `${kind}: (3,1) is reach2`).toBe(
        true,
      );
      const band = callsSince(k, mark, 'overlays').filter(
        (x) => (x.args[1] as OverlayQuery).selected === 1,
      );
      expect(band.length > 0, `${kind}: the band is asked of the rules for unit 1`).toBe(true);
      for (const x of band) {
        expect(
          (x.args[1] as OverlayQuery).budget,
          `${kind}: a live turn is costed from the unit's row budget (ap 5), not freshBudget()`,
        ).toEqual(LIVE_BUDGET);
        expect(
          (x.args[0] as RulesBoard).units,
          `${kind}: on the cost board (no draft yet: the live rows)`,
        ).toEqual(tacVm(kind).board.units);
      }

      pressA(k);
      expect(stripActions(k.root), `${kind}: A off the band drafts nothing`).toEqual([]);
      expect(tileHas(k.root, c(3, 1), 'tactics-tile--reach2'), `${kind}: and the aim stays`).toBe(
        true,
      );
      cursorTo(k, c(3, 1));
      const push = k.fake.calls.length;
      pressA(k);
      expect(menuOf(k.root), `${kind}: the confirmed Move closes to idle`).toBeNull();
      const g = ghosts(k.root);
      expect(g, `${kind}: one ghost`).toHaveLength(1);
      const ghost = g[0] as HTMLElement;
      expect(ghost.getAttribute('data-unit-id'), `${kind}: the ghost is unit 1's`).toBe('1');
      expect(ghost.closest('.tactics-grid'), `${kind}: inside the grid`).not.toBeNull();
      expect(gridCell(ghost), `${kind}: at (3,1): column 4, row 2`).toEqual(['4', '2']);
      expect(ghost.querySelector('.tactics-sprite'), `${kind}: a sprite`).not.toBeNull();
      expect(ghost.getAttribute('aria-label'), `${kind}: labelled ghost.label`).toBe(
        en('tactics.ghost.label'),
      );
      expect(
        gridCell(q(k.root, '.tactics-unit[data-unit-id="1"]')),
        `${kind}: the unit stays on its live tile (1,1)`,
      ).toEqual(['2', '2']);
      expect(stripActions(k.root), `${kind}: one Move chip`).toEqual(['Move']);
      expect(stripChips(k.root)[0]?.textContent?.trim(), `${kind}: labelled menu.move`).toBe(
        en('tactics.menu.move'),
      );
      expect(k.sent, `${kind}: a Move sends nothing`).toEqual([]);
      expect(
        callsSince(k, push, 'plan').map((x) => canon(x.args[1])),
        `${kind}: the rules cost the draft as ONE 2-stride Move (reach2)`,
      ).toContain(canon([{ Move: { strides: 2, taxed: false } }]));

      pressB(k);
      expect(ghosts(k.root), `${kind}: B: the ghost is gone`).toEqual([]);
      expect(stripActions(k.root), `${kind}: B: the strip is empty`).toEqual([]);
      expect(k.sent, `${kind}: B sends nothing`).toEqual([]);

      openMenuAt(k, c(1, 1), kind);
      pressA(k);
      cursorTo(k, c(2, 1));
      const push1 = k.fake.calls.length;
      pressA(k);
      expect(stripActions(k.root), `${kind}: a reach1 Move chip`).toEqual(['Move']);
      expect(
        callsSince(k, push1, 'plan').map((x) => canon(x.args[1])),
        `${kind}: a reach1 tile is ONE stride`,
      ).toContain(canon([{ Move: { strides: 1, taxed: false } }]));
      expect(gridCell(ghosts(k.root)[0] as HTMLElement), `${kind}: the ghost at (2,1)`).toEqual([
        '3',
        '2',
      ]);
      pressB(k);
      expect([ghosts(k.root), stripActions(k.root), k.sent], `${kind}: popped again`).toEqual([
        [],
        [],
        [],
      ]);
    }
  });

  it('BT11-2-SHELL-COMMIT: in PvE and PvP an irreversible action submits the whole draft once — a Move then skill 12 on its first legal target; Start on an empty live draft ends the turn once a new turn re-arms the unit; Recruit with its bait and Flee (PvE); the End row after a Move — and a submit that throws keeps the draft', () => {
    // WRONG IMPL KILLED: a Skill sent without the Move before it (BT11.2: "submit the draft") or
    // the Move sent alone; the wire not the binding shape; two submits for one press; the draft
    // kept after a commit (the next press re-sends it) or cleared BEFORE the call (A28: a throwing
    // submit must keep it); Start sending while the last commit is in flight; Start on a live turn
    // that sends nothing or forgets EndTurn; a Recruit without its bait or target; Flee or End not
    // committing at once on a live turn; End dropping the drafted Move.
    for (const kind of KINDS) {
      const k = make();
      k.fake.script.recruitTargets = [3];
      k.shell.render(tacVm(kind));
      draftMove(k, c(1, 1), c(2, 1), kind);
      expect(stripActions(k.root), `${kind}: fixture: a Move chip`).toEqual(['Move']);
      openMenuAt(k, c(1, 1), kind);
      choose(k, 'skills');
      expect(rowIds(k.root), `${kind}: the Skills sub-list, kit order`).toEqual([
        'skill:11',
        'skill:12',
      ]);
      expect(rowLabel(menuRow(k.root, 'skill:12')), `${kind}: named by names.skill`).toBe(
        'skill#12',
      );
      choose(k, 'skill:12');
      expect(k.sent, `${kind}: aiming sends nothing`).toEqual([]);
      pressA(k);
      expect(k.sent, `${kind}: the Skill submits the draft and itself, once`).toEqual([
        { battleId: 1n, unitId: 1, entries: [W_MOVE_2_1, W_SKILL_12_ON_3] },
      ]);
      expect(stripActions(k.root), `${kind}: the draft is cleared`).toEqual([]);
      expect(ghosts(k.root), `${kind}: and its ghost`).toEqual([]);
      expect(menuOf(k.root), `${kind}: closed to idle`).toBeNull();

      pressStart(k);
      expect(k.sent, `${kind}: Start while the commit is in flight is swallowed`).toHaveLength(1);
      let round = 2;
      const rearm = (): void => {
        k.shell.render(tacVm(kind, { round }));
        round += 1;
      };
      rearm();
      pressStart(k);
      expect(k.sent.at(-1), `${kind}: Start on an empty live draft ends the turn`).toEqual({
        battleId: 1n,
        unitId: 1,
        entries: [W_END],
      });

      if (kind === 'wild') {
        rearm();
        openMenuAt(k, c(1, 1), kind);
        choose(k, 'recruit');
        expect(rowIds(k.root), 'the bait sub-list: no bait, then each held bait').toEqual([
          'bait:none',
          'bait:43',
        ]);
        expect(rowLabel(menuRow(k.root, 'bait:none')), 'menu.noBait').toBe(
          en('tactics.menu.noBait'),
        );
        expect(rowLabel(menuRow(k.root, 'bait:43')), 'the bait`s name').toContain(BAIT.name);
        choose(k, 'bait:43');
        pressA(k);
        expect(k.sent.at(-1), 'Recruit sends its target and bait').toEqual({
          battleId: 1n,
          unitId: 1,
          entries: [{ tag: 'Recruit', value: { target: 3, bait: 43 } }],
        });
        rearm();
        openMenuAt(k, c(1, 1), kind);
        choose(k, 'flee');
        expect(k.sent.at(-1), 'Flee commits at once').toEqual({
          battleId: 1n,
          unitId: 1,
          entries: [{ tag: 'Flee' }],
        });
      }

      rearm();
      draftMove(k, c(1, 1), c(2, 1), kind);
      openMenuAt(k, c(1, 1), kind);
      choose(k, 'end');
      expect(k.sent.at(-1), `${kind}: the End row sends the draft and EndTurn`).toEqual({
        battleId: 1n,
        unitId: 1,
        entries: [W_MOVE_2_1, W_END],
      });

      rearm();
      draftMove(k, c(1, 1), c(2, 1), kind);
      k.failSubmit.on = true;
      const tries = k.sent.length;
      thrown(() => pressStart(k));
      expect(k.sent, `${kind}: the failing submit was attempted`).toHaveLength(tries + 1);
      expect(stripActions(k.root), `${kind}: a submit that throws keeps the draft`).toEqual([
        'Move',
      ]);
      expect(ghosts(k.root), `${kind}: and its ghost`).toHaveLength(1);
    }
  });

  it('BT11-2-SHELL-UNDO-XOR-CANCEL: over PvE / PvP x the unit on its turn or not x a READY row or not x a draft or not, the hint`s undo is exactly "a chip is drafted", the Clear plan row exactly "pre-queue, READY and no draft", never both, the strip locks exactly on a READY row with no draft, and Start reads Submit for a pre-queue and Guard / End Turn per the rules on a live turn', () => {
    // WRONG IMPL KILLED: undo keyed to the READY row (B would claim to undo a submitted plan);
    // Clear offered beside a draft or on a live turn (BT11.2: "UNDO and CANCEL SHALL never be offered
    // together"); a READY row treated as live; the strip locked over a draft (A28: the draft
    // replaces the READY row) or never locked; Start's verb fixed, or Submit on a live turn.
    let combos = 0;
    for (const kind of KINDS) {
      for (const active of [true, false]) {
        for (const hasReady of [false, true]) {
          for (const drafted of [false, true]) {
            const label = `${kind} ${active ? 'on its turn' : 'off-turn'} ready=${hasReady} draft=${drafted}`;
            const k = make();
            k.fake.script.guard = !drafted;
            const readyPlans = hasReady
              ? readyOf([[2, [{ Move: { x: 3, y: 1, strides: 2 } }, 'EndTurn']]])
              : readyOf([]);
            k.shell.render(
              tacVm(kind, {
                activeUnitId: active ? 2 : 3,
                turnIdx: active ? 2 : 1,
                readyPlans,
              }),
            );
            for (let i = 0; i < 3 && k.shell.selectedUnitId !== 2; i += 1) k.shell.cycleUnit(1);
            expect(k.shell.selectedUnitId, `${label}: fixture: unit 2 selected`).toBe(2);
            const live = active && !hasReady;
            if (drafted) {
              draftMove(k, c(3, 2), c(3, 1), label);
              expect(stripActions(k.root), `${label}: fixture: a Move chip`).toEqual(['Move']);
            }
            const hint = k.shell.hint();
            expect(hint.undo, `${label}: B undoes exactly a drafted chip`).toBe(drafted);
            let start = 'submit';
            if (live) start = drafted ? 'endTurn' : 'guard';
            expect(hint.start, `${label}: Start`).toBe(start);
            expect(
              k.root.querySelector('.tactics-strip--locked') !== null,
              `${label}: the strip locks on a READY row with no draft`,
            ).toBe(hasReady && !drafted);
            openMenuAt(k, c(3, 2), label);
            const clear = rowIds(k.root).includes('clear');
            expect(clear, `${label}: the Clear plan row`).toBe(!live && hasReady && !drafted);
            expect(hint.undo && clear, `${label}: never Undo and Clear together`).toBe(false);
            pressB(k);
            combos += 1;
          }
        }
      }
    }
    expect(combos, 'ANTI-VACUITY: the 2 x 2 x 2 x 2 table').toBe(16);
  });

  it('BT11-2-SHELL-INFLIGHT: in PvE and PvP a second commit or Start for the same unit before any render is swallowed — one submit — and so is one after a render with the same (battle, unit, round, turn index); a render that advances the turn index re-arms it for exactly one more', () => {
    // WRONG IMPL KILLED (REV 5 A28): a double press that submits twice (the server would reject the
    // second as a duplicate and the player read an error); an in-flight key that ignores the turn
    // (re-armed by any re-render, e.g. a subscription batch for another table); one never re-armed
    // (the unit's next turn is dead); a key per press instead of per unit.
    for (const kind of KINDS) {
      const k = make();
      k.shell.render(tacVm(kind));
      openMenuAt(k, c(1, 1), kind);
      choose(k, 'end');
      expect(k.sent, `${kind}: the End row commits`).toEqual([
        { battleId: 1n, unitId: 1, entries: [W_END] },
      ]);
      cursorTo(k, c(1, 1));
      pressA(k);
      if (menuOf(k.root) !== null) choose(k, 'end');
      pressStart(k);
      expect(
        k.sent,
        `${kind}: a second commit and a Start before any render: swallowed`,
      ).toHaveLength(1);
      k.shell.render(tacVm(kind));
      pressStart(k);
      expect(k.sent, `${kind}: the same turn key keeps it swallowed`).toHaveLength(1);
      k.shell.render(tacVm(kind, { turnIdx: 1 }));
      pressStart(k);
      expect(k.sent, `${kind}: turnIdx + 1 re-arms`).toHaveLength(2);
      expect(k.sent[1], `${kind}: the re-armed Start ends the turn`).toEqual({
        battleId: 1n,
        unitId: 1,
        entries: [W_END],
      });
      pressStart(k);
      expect(k.sent, `${kind}: and is in flight again`).toHaveLength(2);
    }
  });
});

describe('TacticsBattle: the pre-queue (BT11.3)', () => {
  it('BT11-3-SHELL-PREQUEUE: RB to the second own unit during a foe`s turn plans a pre-queue with the same menu, costed from the rules` fresh budget; a Move and a Skill only append chips; Start submits exactly the draft (no EndTurn added) and a later READY row locks the strip with its chips and no undo', () => {
    // WRONG IMPL KILLED: a pre-queue costed from the unit's (spent) row budget instead of
    // rules.freshBudget(); a pre-queue Skill that submits at once (live semantics); EndTurn appended
    // by the client (the server appends it); Start that sends nothing, or sends twice; the READY row
    // not shown, not locked, or undoable by B.
    const k = make();
    k.shell.render(tacVm('wild', { activeUnitId: 3, turnIdx: 1 }));
    expect(k.shell.selectedUnitId, 'a foe`s turn leaves the first own unit selected').toBe(1);
    pressCycle(k, 1);
    expect(k.shell.selectedUnitId, 'RB selects unit 2').toBe(2);
    expect(k.shell.cursor, 'on its tile').toEqual(c(3, 2));
    expect(k.shell.hint().start, 'Start submits a pre-queue').toBe('submit');
    const mark = k.fake.calls.length;
    openMenuAt(k, c(3, 2), 'pre-queue');
    expect(rowIds(k.root), 'the same menu, plus Submit').toEqual([
      'move',
      'skills',
      'item',
      'recruit',
      'flee',
      'end',
      'submit',
    ]);
    const plans = callsSince(k, mark, 'plan');
    expect(
      plans.some((x) => canon(x.args[0]) === canon(FRESH)),
      'the rows are costed from freshBudget()',
    ).toBe(true);
    expect(
      plans.some((x) => canon(x.args[0]) === canon(IDLE_BUDGET)),
      'never from unit 2`s spent row budget',
    ).toBe(false);
    pressA(k);
    const band = callsSince(k, mark, 'overlays')
      .map((x) => x.args[1] as OverlayQuery)
      .filter((x) => x.selected === 2);
    expect(band.length > 0, 'the band is asked for unit 2').toBe(true);
    for (const x of band) expect(x.budget, 'with the fresh budget').toEqual(FRESH);
    cursorTo(k, c(3, 1));
    pressA(k);
    expect(stripActions(k.root), 'a Move chip').toEqual(['Move']);
    expect(k.sent, 'nothing sent').toEqual([]);

    openMenuAt(k, c(3, 2), 'pre-queue');
    choose(k, 'skills');
    choose(k, 'skill:12');
    pressA(k);
    expect(stripActions(k.root), 'the Skill is APPENDED').toEqual(['Move', 'Skill']);
    expect(k.sent, 'nothing sent before Start').toEqual([]);
    expect(menuOf(k.root), 'closed to idle').toBeNull();

    pressStart(k);
    expect(k.sent, 'Start submits exactly the draft').toEqual([
      { battleId: 1n, unitId: 2, entries: [W_MOVE_3_1, W_SKILL_12_ON_3] },
    ]);
    const readyRow: readonly QueuedActionRule[] = [
      { Move: { x: 3, y: 1, strides: 2 } },
      { Skill: { skill_id: 12, target: { Unit: 3 } } },
      'EndTurn',
    ];
    k.shell.render(
      tacVm('wild', { activeUnitId: 3, turnIdx: 1, readyPlans: readyOf([[2, readyRow]]) }),
    );
    expect(k.shell.selectedUnitId, 'still unit 2').toBe(2);
    expect(k.root.querySelector('.tactics-strip--locked'), 'the strip locks').not.toBeNull();
    expect(stripActions(k.root), 'showing the READY row').toEqual(['Move', 'Skill', 'EndTurn']);
    expect(k.shell.hint().undo, 'a READY row is not B-undoable').toBe(false);
  });

  it('BT11-3-SHELL-CLEAR: a pre-queue unit with a READY row and no draft offers Clear plan, which opens a Yes / No confirm; Yes calls cancel_queue once and closes, No closes and sends nothing, B at the confirm returns to the root menu', () => {
    // WRONG IMPL KILLED: Clear that cancels without a confirm (no hold edge exists, so the confirm
    // IS the safety); Yes sending twice or to the wrong unit; No that cancels; B that closes the
    // whole menu instead of stepping back; a Clear that submits.
    const k = make();
    k.shell.render(
      tacVm('wild', {
        activeUnitId: 3,
        turnIdx: 1,
        readyPlans: readyOf([[2, [{ Move: { x: 3, y: 1, strides: 2 } }, 'EndTurn']]]),
      }),
    );
    k.shell.cycleUnit(1);
    expect(k.shell.selectedUnitId, 'fixture: unit 2').toBe(2);
    openMenuAt(k, c(3, 2), 'clear');
    expect(rowIds(k.root).at(-1), 'Clear plan is the last row').toBe('clear');
    expect(rowLabel(menuRow(k.root, 'clear')), 'labelled menu.clearPlan').toBe(
      en('tactics.menu.clearPlan'),
    );
    choose(k, 'clear');
    expect([...rowIds(k.root)].sort(), 'the confirm').toEqual(['clearNo', 'clearYes']);
    expect(rowLabel(menuRow(k.root, 'clearYes')), 'menu.clearYes').toBe(
      en('tactics.menu.clearYes'),
    );
    expect(rowLabel(menuRow(k.root, 'clearNo')), 'menu.clearNo').toBe(en('tactics.menu.clearNo'));
    expect(k.cancels, 'nothing sent at the confirm').toEqual([]);
    choose(k, 'clearYes');
    expect(k.cancels, 'Yes: cancel_queue once, for unit 2').toEqual([{ battleId: 1n, unitId: 2 }]);
    expect(menuOf(k.root), 'and the menu closes').toBeNull();

    openMenuAt(k, c(3, 2), 'clear');
    choose(k, 'clear');
    choose(k, 'clearNo');
    expect(menuOf(k.root), 'No: the menu closes').toBeNull();
    expect(k.cancels, 'and nothing is sent').toHaveLength(1);

    openMenuAt(k, c(3, 2), 'clear');
    choose(k, 'clear');
    pressB(k);
    expect(rowIds(k.root), 'B at the confirm: the root menu again').toContain('move');
    expect(rowIds(k.root), 'with its Clear row').toContain('clear');
    expect(k.cancels, 'still one cancel').toHaveLength(1);
    expect(k.sent, 'Clear never submits').toEqual([]);
  });
});

describe('TacticsBattle: the controller map (BT11.6)', () => {
  it('BT11-6-SHELL-MAP: the danger op toggles the overlay and its dock button`s aria-pressed; the cycle op is cycleUnit and closes an open menu or aim; the D-pad walks the menu while it is open and the tile cursor otherwise, never off the board; B during playback skips first and leaves the draft, the next B pops', () => {
    // WRONG IMPL KILLED: X / LB / RB unwired (BT11.6); the dock button's pressed state stale; a
    // cycle that differs from cycleUnit (own Active units, input order, wrapping) or leaves the
    // previous unit's menu / aim open (A on the next unit would confirm the old aim); the D-pad
    // moving the tile cursor under an open menu; a cursor that leaves the board; B during playback
    // that also pops the chip (the player loses a step to a skip).
    const k = make();
    k.shell.render(tacVm('wild'));
    const dangerBtn = (): HTMLElement => q(k.root, '.tactics-dock-danger');
    expect(dangerBtn().getAttribute('aria-pressed'), 'off at first').toBe('false');
    pressX(k);
    expect(k.shell.dangerOn, 'X: on').toBe(true);
    expect(dangerBtn().getAttribute('aria-pressed'), 'the button is pressed').toBe('true');
    pressX(k);
    expect(k.shell.dangerOn, 'X again: off').toBe(false);
    expect(dangerBtn().getAttribute('aria-pressed')).toBe('false');

    const units = [...tacUnits('wild'), unit({ unitId: 6, x: 0, y: 4 })];
    const a = make();
    const twin = make();
    a.shell.render(tacVm('wild', { units }));
    twin.shell.render(tacVm('wild', { units }));
    for (const dir of [1, 1, 1, -1, -1, 1] as const) {
      pressCycle(a, dir);
      twin.shell.cycleUnit(dir);
      expect([a.shell.selectedUnitId, a.shell.cursor], `cycle ${dir} is cycleUnit(${dir})`).toEqual(
        [twin.shell.selectedUnitId, twin.shell.cursor],
      );
    }

    const m = make();
    m.shell.render(tacVm('wild'));
    openMenuAt(m, c(1, 1), 'map');
    pressCycle(m, 1);
    expect(menuOf(m.root), 'RB closes the open menu').toBeNull();
    expect(m.shell.selectedUnitId, 'and selects unit 2').toBe(2);
    pressCycle(m, -1);
    openMenuAt(m, c(1, 1), 'map');
    menuTo(m, 'move');
    pressA(m);
    pressCycle(m, 1);
    expect(m.shell.selectedUnitId, 'RB out of the Move aim').toBe(2);
    expect(m.shell.cursor, 'seated on unit 2').toEqual(c(3, 2));
    pressA(m);
    expect(menuOf(m.root), 'A now opens unit 2`s menu: the aim is gone').not.toBeNull();
    expect(stripActions(m.root), 'and no Move was confirmed').toEqual([]);
    const at = m.shell.cursor;
    move(m, 'Down');
    expect(selectedRowId(m.root), 'Down walks the open menu').toBe('skills');
    expect(m.shell.cursor, 'not the tile cursor').toEqual(at);
    pressB(m);
    expect(menuOf(m.root), 'fixture: closed').toBeNull();
    move(m, 'Down');
    expect(m.shell.cursor, 'closed: Down moves the tile cursor').toEqual(c(3, 3));
    for (let i = 0; i < 10; i += 1) move(m, 'Right');
    for (let i = 0; i < 10; i += 1) move(m, 'Down');
    expect(m.shell.cursor, 'the far corner, never past it').toEqual(c(6, 4));
    for (let i = 0; i < 10; i += 1) move(m, 'Left');
    for (let i = 0; i < 10; i += 1) move(m, 'Up');
    expect(m.shell.cursor, 'the near corner, never past it').toEqual(c(0, 0));

    const p = make();
    p.shell.render(tacVm('wild'));
    draftMove(p, c(1, 1), c(2, 1), 'playback');
    expect(stripActions(p.root), 'fixture: a Move chip').toEqual(['Move']);
    p.shell.ingest([executed()]);
    expect(isPlaying(p.root), 'fixture: a beat is playing').toBe(true);
    pressB(p);
    expect(isPlaying(p.root), 'the first B skips the playback').toBe(false);
    expect(stripActions(p.root), 'and leaves the draft').toEqual(['Move']);
    pressB(p);
    expect(stripActions(p.root), 'the next B pops the chip').toEqual([]);
    expect(p.sent, 'none of it sends').toEqual([]);
  });

  it('BT11-6-POINTER-MIRROR: a click on a menu row is A on it, a click on an own unit selects it and opens its menu, a click on a band tile in the Move aim confirms it (elsewhere it only moves the cursor), and three labelled dock buttons toggle danger and cycle to the previous / next unit', () => {
    // WRONG IMPL KILLED (REV 5 A35): rows that only the keyboard can press (BT11.6: "keyboard and
    // pointer mirror it"); a unit click that only moves the cursor; a band click that does nothing,
    // or an off-band click that drafts; danger / cycling reachable only by X / LB / RB (the router
    // swallows X today, A22: the dock button is its only working path); unlabelled dock buttons; a
    // tile click that toggles danger.
    const k = make();
    k.shell.render(tacVm('wild'));
    click(q(k.root, '.tactics-unit[data-unit-id="1"] .tactics-sprite'));
    expect(menuOf(k.root), 'a click on the own unit opens its menu').not.toBeNull();
    click(menuRow(k.root, 'end'));
    expect(k.sent, 'a click on the End row is A on it').toEqual([
      { battleId: 1n, unitId: 1, entries: [W_END] },
    ]);
    expect(menuOf(k.root), 'and the menu closes').toBeNull();
    click(q(k.root, '.tactics-unit[data-unit-id="2"] .tactics-sprite'));
    expect(k.shell.selectedUnitId, 'a click on another own unit selects it').toBe(2);
    expect(rowIds(k.root), 'and opens ITS (pre-queue) menu').toContain('submit');

    const a = make();
    a.shell.render(tacVm('wild'));
    click(q(a.root, '.tactics-unit[data-unit-id="1"] .tactics-sprite'));
    click(menuRow(a.root, 'move'));
    expect(tileHas(a.root, c(2, 1), 'tactics-tile--reach1'), 'the row click entered the aim').toBe(
      true,
    );
    click(tileAt(a.root, c(1, 3)));
    expect(a.shell.cursor, 'a click off the band moves the cursor').toEqual(c(1, 3));
    expect(stripActions(a.root), 'and drafts nothing').toEqual([]);
    click(tileAt(a.root, c(2, 1)));
    expect(stripActions(a.root), 'a click on a band tile confirms the Move').toEqual(['Move']);
    expect(ghosts(a.root), 'with its ghost').toHaveLength(1);
    expect(a.sent, 'and sends nothing').toEqual([]);

    const d = make();
    d.shell.render(tacVm('wild'));
    const btn = (cls: string): HTMLElement => q(d.root, `.tactics-dock-buttons .${cls}`);
    const DOCK: Readonly<Record<string, string>> = {
      'tactics-dock-danger': en('tactics.dock.danger'),
      'tactics-dock-prev': en('tactics.dock.prevUnit'),
      'tactics-dock-next': en('tactics.dock.nextUnit'),
    };
    for (const [cls, label] of Object.entries(DOCK)) {
      expect(btn(cls).tagName, `${cls}: a button`).toBe('BUTTON');
      expect(named(btn(cls), label), `${cls}: labelled ${label}`).toBe(true);
    }
    click(btn('tactics-dock-danger'));
    expect(d.shell.dangerOn, 'the danger button toggles it on').toBe(true);
    expect(btn('tactics-dock-danger').getAttribute('aria-pressed'), 'pressed').toBe('true');
    click(btn('tactics-dock-next'));
    expect(d.shell.selectedUnitId, 'next unit').toBe(2);
    click(btn('tactics-dock-prev'));
    expect(d.shell.selectedUnitId, 'previous unit').toBe(1);
    click(tileAt(d.root, c(4, 4)));
    expect(d.shell.dangerOn, 'a tile click never toggles danger').toBe(true);
    expect(d.shell.selectedUnitId, 'nor cycles').toBe(1);
  });

  it('BT11-6-SELECT-FOLLOWS-TURN: when the active unit becomes an own unit the render selects it with the cursor on its tile and closes another unit`s open menu; a foe`s turn leaves the selection alone, and a re-render naming the same active unit keeps a selection the player cycled', () => {
    // WRONG IMPL KILLED (REV 5 A28): the first own unit selected on a turn that is the second's
    // (the player plans the wrong monster); the old unit's menu left open over the new turn; a foe's
    // turn grabbing or clearing the selection; a level-triggered follow that yanks the selection
    // back on every subscription batch while the player pre-queues another unit.
    const units = [
      unit({ unitId: 1, x: 1, y: 1 }),
      unit({ unitId: 2, x: 3, y: 2 }),
      foe({ unitId: 3, x: 5, y: 1 }),
    ];
    const at = (activeUnitId: number, turnIdx: number): TacticsBattleVM =>
      vmOf({ units, initiative: [2, 1, 3], nextInitiative: [], activeUnitId, turnIdx });
    const k = make();
    k.shell.render(at(2, 0));
    expect(k.shell.selectedUnitId, 'unit 2 is waiting: selected').toBe(2);
    expect(k.shell.cursor, 'the cursor on its tile').toEqual(c(3, 2));
    openMenuAt(k, c(3, 2), 'unit 2');
    k.shell.render(at(1, 1));
    expect(k.shell.selectedUnitId, 'unit 1`s turn: selected').toBe(1);
    expect(k.shell.cursor, 'the cursor on its tile').toEqual(c(1, 1));
    expect(menuOf(k.root), 'unit 2`s menu is closed').toBeNull();
    k.shell.cycleUnit(1);
    expect(k.shell.selectedUnitId, 'fixture: the player cycles to unit 2').toBe(2);
    k.shell.render(at(1, 1));
    expect(k.shell.selectedUnitId, 'the same active unit again: the player`s choice stands').toBe(
      2,
    );
    k.shell.render(at(3, 2));
    expect(k.shell.selectedUnitId, 'a foe`s turn leaves it alone').toBe(2);
  });
});
