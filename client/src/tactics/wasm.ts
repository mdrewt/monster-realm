// tactics/wasm.ts — the rules PORT (BT11.7, the bt-10 overlay port BT10.4): the ONE module that names
// the `tactics_*` exports of the built client-wasm pkg. Every tactical number the client shows — a
// reach band, a range tile, a danger union, an intent chip, a forecast damage, a recruit percent, an
// AP cost — comes out of a method of `TacticsRules`; no TypeScript arithmetic reproduces a rule.
//
// Bound by dependency injection (`bindTacticsRules(pkg)`): main.ts hands in the pkg namespace it
// already imports (bt-12), tests hand in `loadWasmPkg()`. No lazy import, so the existing
// `client_wasm.js` test mocks need no new names until a caller passes them. Pure and synchronous once
// bound; a thrown wasm error is rethrown by identity (fail loud, never a default). Primitive
// arguments are range-checked here, because a wasm-bindgen `u8`/`u16`/`u32` parameter wraps silently.
//
// The DTO types below mirror game-core's serde shapes exactly as `tactics_golden.json` spells them:
// externally tagged enums (`{ Move: {...} }`, `'EndTurn'`, `{ Ok: ... } | { Err: ... }`), snake_case
// fields, `null` for `None`. They are the RULES' view of a unit (`RulesUnit` = `TacticalUnit`), not
// the board view-model's (`boardModel.ts` `TacticalUnit`).
import type { BattleUnit } from '../module_bindings/types';
import type { StoreTurnState } from '../net/store';
import type { IntentKind, OverlaySets, StatusTag, Tile } from './boardModel';

// --- serde mirrors -----------------------------------------------------------------------------

export type RuleResult<T, E> = { readonly Ok: T } | { readonly Err: E };
/** The Ok arm of a rules answer (one definition for every consumer). */
export const isOk = <T, E>(r: RuleResult<T, E>): r is { readonly Ok: T } => 'Ok' in r;
export interface Cell {
  readonly x: number;
  readonly y: number;
}
export type RuleSide = 'A' | 'B';
export type RuleAffinity =
  | 'Fire'
  | 'Water'
  | 'Plant'
  | 'Electric'
  | 'Earth'
  | 'Wind'
  | 'Light'
  | 'Dark';
export type RuleBattleKind = 'Wild' | 'Pvp' | 'Practice';
export type RuleStance = 'Aggressive' | 'Territorial' | 'Skittish';
export type RuleMoveClass = 'Walk' | 'Nimble' | 'Swim' | 'Fly';
export type RuleTerrain = 'Plain' | 'Rough' | 'Water' | 'Blocked';
export type RuleUnitState = 'Active' | 'Fainted' | 'Recruited';
export type RuleTier = 'Light' | 'Heavy';
export type RuleStatusKind = 'Poison' | 'Burn' | 'Paralysis' | 'Sleep' | 'Freeze';
export type RuleStatusEffect =
  | 'Poison'
  | 'Burn'
  | 'Paralysis'
  | { readonly Sleep: { readonly turns_remaining: number } }
  | 'Freeze';
export type RuleEffectiveness = 'Immune' | 'NotVeryEffective' | 'Neutral' | 'SuperEffective';
export interface RuleStatBlock {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
  readonly speed: number;
  readonly sp_attack: number;
  readonly sp_defense: number;
}
export type Entry =
  | { readonly Move: { readonly strides: number; readonly taxed: boolean } }
  | { readonly Attack: RuleTier }
  | 'Item'
  | 'Recruit'
  | 'Flee'
  | 'EndTurn';
export interface TurnBudget {
  readonly ap: number;
  readonly strides_used: number;
  readonly attacks: number;
  readonly last: Entry | null;
}
export type ActionTarget = { readonly Unit: number } | 'SelfTarget';
export type QueuedActionRule =
  | { readonly Move: { readonly x: number; readonly y: number; readonly strides: number } }
  | { readonly Skill: { readonly skill_id: number; readonly target: ActionTarget } }
  | { readonly Item: { readonly item_id: number; readonly target: ActionTarget } }
  | { readonly Recruit: { readonly target: number; readonly bait: number | null } }
  | 'Flee'
  | 'EndTurn';
export interface SkillGeometry {
  readonly range_min: number;
  readonly range_max: number;
  readonly origin: 'Caster' | 'TargetUnit';
  readonly shape: 'Single' | 'Diamond' | 'Burst' | 'Line' | 'Cone';
  readonly radius: number;
  readonly ff_filter: 'Enemies' | 'AllButSelf' | 'All';
}
export interface SkillTactics {
  readonly skill_id: number;
  readonly tier: RuleTier;
  readonly affinity: RuleAffinity;
  readonly power: number;
  readonly accuracy: number;
  readonly applies_status: RuleStatusKind | null;
  readonly geometry: SkillGeometry;
}
export interface UnitKit {
  readonly species_id: number;
  readonly affinity: RuleAffinity;
  readonly level: number;
  readonly stats: RuleStatBlock;
  readonly base_speed: number;
  readonly class: RuleMoveClass;
  readonly skills: readonly SkillTactics[];
}
/** The rules' `TacticalUnit` (a `battle_unit` row joined with its species kit). */
export interface RulesUnit {
  readonly id: number;
  readonly side: RuleSide;
  readonly slot: number;
  readonly kit: UnitKit;
  readonly pos: Cell;
  readonly cur_hp: number;
  readonly status: RuleStatusEffect | null;
  readonly budget: TurnBudget;
  readonly guard: boolean;
  readonly first_stand: boolean;
  readonly state: RuleUnitState;
}
/** One `battle_unit` row as the port takes it (`unitRowOf` builds it from the binding row). */
export interface UnitRow {
  readonly id: number;
  readonly side: RuleSide;
  readonly slot: number;
  readonly species_id: number;
  readonly level: number;
  readonly stats: RuleStatBlock;
  readonly pos: Cell;
  readonly cur_hp: number;
  readonly status: RuleStatusEffect | null;
  readonly budget: TurnBudget;
  readonly guard: boolean;
  readonly first_stand: boolean;
  readonly state: RuleUnitState;
  readonly stance: RuleStance | null;
  readonly wild_index: number | null;
}
export interface RulesBoard {
  readonly kind: RuleBattleKind;
  readonly map_id: number;
  readonly units: readonly UnitRow[];
}
export interface TileDef {
  readonly terrain: RuleTerrain;
  readonly elevation: number;
  readonly blocks_los: boolean;
}
export interface BattleMapDef {
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly TileDef[];
  readonly spawn_a: readonly Cell[];
  readonly spawn_b: readonly Cell[];
}
export type GeometryError =
  | { readonly Unsupported: SkillGeometry['shape'] }
  | 'BadRange'
  | { readonly BadRadius: { readonly shape: SkillGeometry['shape']; readonly radius: number } }
  | { readonly UnknownCaster: number }
  | 'OutOfBounds'
  | 'AimNotCaster'
  | { readonly OutOfRange: { readonly distance: number } }
  | 'NoLineOfSight'
  | 'NoTargetUnit';
export type PathError =
  | { readonly UnknownMover: number }
  | 'OutOfBounds'
  | 'SameTile'
  | 'DestImpassable'
  | 'DestOccupied'
  | 'Unreachable';
export interface Path {
  readonly steps: readonly Cell[];
  readonly cost: number;
}
export type EconomyError =
  | 'ZeroStrides'
  | {
      readonly StrideCap: {
        readonly used: number;
        readonly requested: number;
        readonly cap: number;
      };
    }
  | { readonly NeedsFullBudget: { readonly ap: number; readonly required: number } }
  | { readonly Unaffordable: { readonly cost: number; readonly ap: number } };
export type RecruitError =
  | { readonly BaitBonus: { readonly bait_bonus: number } }
  | { readonly UnknownUnit: { readonly id: number } }
  | { readonly TargetGone: { readonly id: number } };
export interface RecruitOdds {
  readonly pct: number;
  readonly base: number;
  readonly bait: number;
  readonly weakened: number;
}
export interface PipelineTrace {
  readonly hit: boolean;
  readonly d0: number;
  readonly d1: number;
  readonly d2: number;
  readonly d3: number;
  readonly effectiveness: RuleEffectiveness | null;
  readonly applied: number;
  readonly hp_after: number;
  readonly stood_ground: boolean;
}
export interface ForecastOut {
  readonly hit_pct: number;
  readonly stab: boolean;
  readonly flank: boolean;
  readonly guard: boolean;
  readonly effectiveness: RuleEffectiveness | null;
  readonly min: PipelineTrace;
  readonly max: PipelineTrace;
  readonly kills_min: boolean;
  readonly kills_max: boolean;
  readonly first_stand_saves: boolean;
  readonly status: RuleStatusKind | null;
  readonly status_blocked: boolean;
  readonly flank_factor: readonly [number, number];
  readonly guard_factor: readonly [number, number];
  /** The carried type-chart multiplier over 10, reduced: [0,1] Immune, [1,2], [1,1], [2,1]. */
  readonly type_factor: readonly [number, number];
}
export interface PlanOut {
  readonly costs: readonly number[];
  readonly total: number;
  readonly remaining: TurnBudget;
  readonly guard_on_end: boolean;
}
export interface OverlayQuery {
  readonly viewer: RuleSide;
  readonly selected: number | null;
  readonly skill_id: number | null;
  readonly aim: Cell | null;
  /** The costing basis: the selected unit's live budget on its turn, `freshBudget()` for a pre-queue. */
  readonly budget: TurnBudget;
}
export interface Intent {
  readonly unit: number;
  readonly plan: readonly QueuedActionRule[];
  readonly exhausted: boolean;
  /** How many of the 100 turn-skip rolls block this wild's turn: 0, 25 (Paralysis) or 100 (Sleep, Freeze). */
  readonly block_pct: number;
}
export interface OverlaysOut {
  readonly reach1: readonly Cell[];
  readonly reach2: readonly Cell[];
  readonly range: readonly Cell[];
  readonly aoe: readonly Cell[];
  readonly danger: readonly (readonly Cell[])[];
  readonly shield: readonly Cell[];
  readonly intents: readonly Intent[];
}

// --- the pkg surface this port uses ------------------------------------------------------------

/** The `tactics_*` exports of `client-wasm/pkg/client_wasm.js` (structural: the real namespace fits). */
export interface TacticsWasmExports {
  tactics_map(mapId: number): unknown;
  tactics_fresh_budget(): unknown;
  tactics_unit(row: unknown): unknown;
  tactics_targets(board: unknown, caster: number, skillId: number, aim: unknown): unknown;
  tactics_path(board: unknown, mover: number, dest: unknown): unknown;
  tactics_disengage(board: unknown, mover: number, start: unknown): unknown;
  tactics_flank(board: unknown, attacker: number, target: number): unknown;
  tactics_forecast(attacker: unknown, target: unknown, skill: unknown, flank: boolean): unknown;
  tactics_recruit_odds(maxHp: number, hp: number, baitBonus: number): unknown;
  tactics_ai_plan(board: unknown, unit: number): unknown;
  tactics_recruit_targets(board: unknown, unit: number, budget: unknown): unknown;
  tactics_is_exhausted(curHp: number, maxHp: number): boolean;
  tactics_plan(start: unknown, entries: unknown): unknown;
  tactics_overlays(board: unknown, q: unknown): unknown;
  tactics_tuning(): unknown;
  tactics_next_initiative(board: unknown, thisRoundPriority: unknown): unknown;
}

/** bt-12: the tuning the client shows and sizes by (`tactics_tuning()`): the Surge start and the wild
 *  round cap (the turn bar), the pack cap (the deploy slot count is `min(max_pack, spawn_a.length)`). */
export interface TacticsTuning {
  readonly surge_start_round: number;
  readonly wild_round_cap: number;
  readonly max_pack: number;
}

/** The rules as the tactical client asks them. Synchronous once bound; throws on malformed input. */
export interface TacticsRules {
  map(mapId: number): BattleMapDef;
  freshBudget(): TurnBudget;
  unit(row: UnitRow): RulesUnit;
  targets(
    board: RulesBoard,
    caster: number,
    skillId: number,
    aim: Cell,
  ): RuleResult<number[], GeometryError>;
  path(board: RulesBoard, mover: number, dest: Cell): RuleResult<Path, PathError>;
  /** The disengage tax at the mover's tile, or at `start` when given. */
  disengage(board: RulesBoard, mover: number, start?: Cell): RuleResult<boolean, PathError>;
  flank(board: RulesBoard, attacker: number, target: number): boolean;
  /** `skillId` must be one of the attacker's kit skills (throws otherwise); `flank` from `flank()` on the same board. */
  forecast(attacker: RulesUnit, target: RulesUnit, skillId: number, flank: boolean): ForecastOut;
  recruitOdds(maxHp: number, hp: number, baitBonus: number): RuleResult<RecruitOdds, RecruitError>;
  aiPlan(board: RulesBoard, unit: number): QueuedActionRule[];
  /** The Recruit targets `unit` could bind now with `budget` as its ledger (one `validate_at_pop`
   *  chain per candidate: PvP refusal, wild actor, player-owned target, adjacency, full budget). */
  recruitTargets(board: RulesBoard, unit: number, budget: TurnBudget): number[];
  isExhausted(curHp: number, maxHp: number): boolean;
  plan(start: TurnBudget, entries: readonly Entry[]): RuleResult<PlanOut, EconomyError>;
  overlays(board: RulesBoard, q: OverlayQuery): OverlaysOut;
}

/** bt-12 (BT12.1): what main.ts's view-model builder asks beyond the shell's port — the tuning the shell
 *  shows and the next round's initiative. A separate extension so the shell's deps (and every fake
 *  `TacticsRules` in the pure models' tests) stay the port the shell actually calls. */
export interface TacticsClientRules extends TacticsRules {
  /** The loaded tuning's client-facing fields. */
  tuning(): TacticsTuning;
  /** The NEXT round's initiative over `board`'s conscious units, given the side that holds tie priority
   *  THIS round (`battle_tactical.tie_priority_side`): game-core's alternation, never a flip here. */
  nextInitiative(board: RulesBoard, thisRoundPriority: RuleSide): number[];
}

/** The `tactics_*` exports the port binds, in the order `bindTacticsRules` checks them. */
const EXPORT_NAMES = [
  'tactics_map',
  'tactics_fresh_budget',
  'tactics_unit',
  'tactics_targets',
  'tactics_path',
  'tactics_disengage',
  'tactics_flank',
  'tactics_forecast',
  'tactics_recruit_odds',
  'tactics_ai_plan',
  'tactics_recruit_targets',
  'tactics_is_exhausted',
  'tactics_plan',
  'tactics_overlays',
  'tactics_tuning',
  'tactics_next_initiative',
] as const satisfies readonly (keyof TacticsWasmExports)[];

const U16_MAX = 0xffff;
const U32_MAX = 0xffff_ffff;

/** A wasm-bindgen integer parameter wraps silently: refuse anything that is not an integer in range. */
function int(label: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label}: ${String(value)} is not an integer in 0..=${max}`);
  }
  return value;
}

/** Bind the port to a pkg namespace. Throws naming the first `tactics_*` export that is not a function. */
export function bindTacticsRules(pkg: TacticsWasmExports): TacticsClientRules {
  const exports = pkg as unknown as Record<string, unknown>;
  for (const name of EXPORT_NAMES) {
    if (typeof exports[name] !== 'function') {
      throw new Error(`client-wasm pkg exports no ${name}() — the pkg is stale, run \`just wasm\``);
    }
  }
  return {
    map: (mapId) => pkg.tactics_map(int('mapId', mapId, U32_MAX)) as BattleMapDef,
    freshBudget: () => pkg.tactics_fresh_budget() as TurnBudget,
    unit: (row) => pkg.tactics_unit(row) as RulesUnit,
    targets: (board, caster, skillId, aim) =>
      pkg.tactics_targets(
        board,
        int('caster', caster, U32_MAX),
        int('skillId', skillId, U32_MAX),
        aim,
      ) as RuleResult<number[], GeometryError>,
    path: (board, mover, dest) =>
      pkg.tactics_path(board, int('mover', mover, U32_MAX), dest) as RuleResult<Path, PathError>,
    disengage: (board, mover, start) =>
      pkg.tactics_disengage(board, int('mover', mover, U32_MAX), start ?? null) as RuleResult<
        boolean,
        PathError
      >,
    flank: (board, attacker, target) =>
      pkg.tactics_flank(
        board,
        int('attacker', attacker, U32_MAX),
        int('target', target, U32_MAX),
      ) as boolean,
    forecast: (attacker, target, skillId, flank) => {
      int('skillId', skillId, U32_MAX);
      const skill = attacker.kit.skills.find((k) => k.skill_id === skillId);
      if (skill === undefined) {
        throw new Error(`unit ${attacker.id} has no skill ${skillId} in its kit`);
      }
      return pkg.tactics_forecast(attacker, target, skill, flank) as ForecastOut;
    },
    recruitOdds: (maxHp, hp, baitBonus) =>
      pkg.tactics_recruit_odds(
        int('maxHp', maxHp, U16_MAX),
        int('hp', hp, U16_MAX),
        int('baitBonus', baitBonus, U16_MAX),
      ) as RuleResult<RecruitOdds, RecruitError>,
    aiPlan: (board, unit) =>
      pkg.tactics_ai_plan(board, int('unit', unit, U32_MAX)) as QueuedActionRule[],
    recruitTargets: (board, unit, budget) =>
      pkg.tactics_recruit_targets(board, int('unit', unit, U32_MAX), budget) as number[],
    isExhausted: (curHp, maxHp) =>
      pkg.tactics_is_exhausted(int('curHp', curHp, U16_MAX), int('maxHp', maxHp, U16_MAX)),
    plan: (start, entries) => pkg.tactics_plan(start, entries) as RuleResult<PlanOut, EconomyError>,
    overlays: (board, q) => pkg.tactics_overlays(board, q) as OverlaysOut,
    tuning: () => pkg.tactics_tuning() as TacticsTuning,
    nextInitiative: (board, thisRoundPriority) =>
      pkg.tactics_next_initiative(board, thisRoundPriority) as number[],
  };
}

// --- bt-12 (BT12.1): the store → shell view-model mappers (pure; main.ts assembles the VM) ----------

/** The shell's battle kind: Wild → `wild`; Pvp AND Practice → `pvp` (Practice uses the PvP ruleset and
 *  both sides are the player's — R-bt-11-PRACTICEKIND). Exhaustive. */
export function shellKind(kind: RuleBattleKind): 'wild' | 'pvp' {
  void kind;
  throw new Error('bt-12: shellKind not implemented');
}

/** The current initiative unit of either side: `Waiting(U)` → U; `Advancing` → the initiative entry at
 *  `turnIdx` (the unit executing or about to), else null; `NotActive` → null. */
export function activeUnitOf(
  turnState: StoreTurnState,
  initiative: readonly number[],
  turnIdx: number,
): number | null {
  void turnState;
  void initiative;
  void turnIdx;
  throw new Error('bt-12: activeUnitOf not implemented');
}

/** The board view's status tag of a rules status (`{ Sleep: … }` → `'Sleep'`); null stays null. */
export function statusTagOf(status: RuleStatusEffect | null): StatusTag | null {
  void status;
  throw new Error('bt-12: statusTagOf not implemented');
}

const has = (action: QueuedActionRule, tag: 'Skill' | 'Move'): boolean =>
  typeof action === 'object' && tag in action;

/** A wild whose every turn-skip roll blocks (Sleep / Freeze: `block_pct` 100) does not act. */
export const isBlocked = (blockPct: number): boolean => blockPct >= 100;

/** The chip kind of a wild's plan: a blocked turn is a hold; else any Skill is an attack, else any Move a move. */
export function intentKind(plan: readonly QueuedActionRule[], blockPct: number): IntentKind {
  if (isBlocked(blockPct)) return 'hold';
  if (plan.some((a) => has(a, 'Skill'))) return 'attack';
  if (plan.some((a) => has(a, 'Move'))) return 'move';
  return 'hold';
}

const copyTiles = (tiles: readonly Cell[]): Tile[] => tiles.map((t) => ({ x: t.x, y: t.y }));

/** The computed overlays as bt-10's `OverlaySets` port (tiles copied, intents classified). */
export function overlaySets(out: OverlaysOut): OverlaySets {
  return {
    reach1: copyTiles(out.reach1),
    reach2: copyTiles(out.reach2),
    range: copyTiles(out.range),
    aoe: copyTiles(out.aoe),
    danger: out.danger.map(copyTiles),
    shield: copyTiles(out.shield),
    intents: out.intents.map((i) => ({ unitId: i.unit, kind: intentKind(i.plan, i.block_pct) })),
  };
}

function statusOf(status: BattleUnit['status']): RuleStatusEffect | null {
  if (status === undefined) return null;
  switch (status.tag) {
    case 'Sleep':
      return { Sleep: { turns_remaining: status.value } };
    case 'Poison':
    case 'Burn':
    case 'Paralysis':
    case 'Freeze':
      return status.tag;
    default:
      return status satisfies never;
  }
}

function lastOf(last: BattleUnit['budgetLast']): Entry | null {
  if (last === undefined) return null;
  switch (last.tag) {
    case 'Move':
      return { Move: { strides: last.value.strides, taxed: last.value.taxed } };
    case 'AttackLight':
      return { Attack: 'Light' };
    case 'AttackHeavy':
      return { Attack: 'Heavy' };
    case 'Item':
    case 'Recruit':
    case 'Flee':
    case 'EndTurn':
      return last.tag;
    default:
      return last satisfies never;
  }
}

/** A `my_battle_units` binding row as the port's `UnitRow` (tags → serde forms, stats renamed). */
export function unitRowOf(row: BattleUnit): UnitRow {
  return {
    id: row.unitId,
    side: row.side.tag,
    slot: row.slot,
    species_id: row.speciesId,
    level: row.level,
    stats: {
      hp: row.stats.hp,
      attack: row.stats.attack,
      defense: row.stats.defense,
      speed: row.stats.speed,
      sp_attack: row.stats.spAttack,
      sp_defense: row.stats.spDefense,
    },
    pos: { x: row.x, y: row.y },
    cur_hp: row.curHp,
    status: statusOf(row.status),
    budget: {
      ap: row.ap,
      strides_used: row.stridesUsed,
      attacks: row.attacks,
      last: lastOf(row.budgetLast),
    },
    guard: row.guard,
    first_stand: row.firstStand,
    state: row.state.tag,
    stance: row.stance?.tag ?? null,
    wild_index: row.wildIndex ?? null,
  };
}
