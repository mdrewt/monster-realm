// tactics/commandModel.ts — the hierarchical command menu MODEL (BT11.1; plan REV 4 §R4.3 + REV 5
// A26/A29/A34). Pure: codes, never text (tactics/strings.ts resolves them); every legality predicate
// is a `TacticsRules` call — no AP sum, range check or adjacency test lives here.
//
// bt-11 API FREEZE (continuation, increment B): the tester codes to these exports; the bodies throw
// until the implementation lands.
import type {
  ActionTarget,
  Cell,
  QueuedActionRule,
  RuleTier,
  RulesBoard,
  RulesUnit,
  TacticsRules,
  TurnBudget,
} from './wasm';

export type MenuRowId = 'move' | 'skills' | 'item' | 'recruit' | 'flee' | 'end' | 'submit' | 'clear';
export type ReasonCode =
  | 'recruitFullAp'
  | 'fleeFullAp'
  | 'outOfRange'
  | 'partyFull'
  | 'unaffordable'
  | 'strideCap'
  | 'boxedIn'
  | 'notAvailable'
  | 'planComplete';
export interface MenuRow {
  readonly id: MenuRowId;
  readonly enabled: boolean;
  readonly reason: ReasonCode | null;
  /** The row opens a sub-list (skills, bait, clear-confirm) or an aim instead of acting. */
  readonly sub: boolean;
}
/** One legal aim of a skill NOW: the tile to aim at, the bound target and the units it hits. */
export interface SkillAim {
  readonly aim: Cell;
  readonly target: ActionTarget;
  readonly hits: readonly number[];
}
export interface SkillRow {
  readonly skillId: number;
  readonly tier: RuleTier;
  readonly enabled: boolean;
  readonly reason: ReasonCode | null;
  readonly aims: readonly SkillAim[];
}
export interface MenuContext {
  readonly kind: 'wild' | 'pvp';
  readonly mode: 'live' | 'prequeue';
  readonly rules: TacticsRules;
  /** The costing board: the LIVE rows with this unit's own draft applied (REV 5 A24). */
  readonly costBoard: RulesBoard;
  /** The aiming board (B: the cost board; C: the projection up to this unit + its draft). */
  readonly aimBoard: RulesBoard;
  /** The planning unit, joined, at its tile on the boards above. */
  readonly unit: RulesUnit;
  /** The budget left after the draft (the start budget when the draft is empty). */
  readonly budget: TurnBudget;
  readonly actions: readonly QueuedActionRule[];
  readonly partyFull: boolean;
  readonly hasReady: boolean;
}

const NOT_IMPLEMENTED = 'bt-11: not implemented';

/** The root rows in order: move, skills, item, recruit (wild), flee (wild), end, submit (prequeue), clear. */
export function menuRows(_ctx: MenuContext): MenuRow[] {
  throw new Error(NOT_IMPLEMENTED);
}

/** One row per kit skill, kit order. */
export function skillRows(_ctx: MenuContext): SkillRow[] {
  throw new Error(NOT_IMPLEMENTED);
}

/** The End row's live label: `rules.plan(budget, ['EndTurn']).Ok.guard_on_end`. */
export function endLabel(_ctx: MenuContext): 'endTurn' | 'guard' {
  throw new Error(NOT_IMPLEMENTED);
}

/** The Move band on the cost board: reach1 (1 stride) and reach2 (2 strides), exclusive sets. */
export function moveBand(_ctx: MenuContext): { readonly reach1: Cell[]; readonly reach2: Cell[] } {
  throw new Error(NOT_IMPLEMENTED);
}

/** The Recruit targets now: `rules.recruitTargets(costBoard, unit.id, budget)`. */
export function recruitTargets(_ctx: MenuContext): number[] {
  throw new Error(NOT_IMPLEMENTED);
}

/** Undo (B pops a chip) iff the draft is non-empty; Cancel (Clear plan) iff prequeue, a READY row and
 *  no draft — never both. */
export function offers(_ctx: MenuContext): { readonly undo: boolean; readonly cancel: boolean } {
  throw new Error(NOT_IMPLEMENTED);
}
