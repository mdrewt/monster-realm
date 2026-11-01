// tactics/draft.ts — the client-local DRAFT (BT11.2; plan REV 4 §R4.4 + REV 5 A25/A28/A37): the
// actions a unit has queued but not sent, their costed entries, the one board-application walk every
// consumer shares, and the wire shape `submit_queue` takes. Pure: data copies and `TacticsRules`
// calls only — no AP, HP, distance or range arithmetic.
//
// bt-11 API FREEZE (continuation, increment B): the tester codes to these exports; the bodies throw
// until the implementation lands.
import type { QueuedAction } from '../module_bindings/types';
import type { Entry, QueuedActionRule, RulesBoard, RulesUnit, TacticsRules } from './wasm';

export interface Draft {
  readonly unitId: number;
  readonly actions: readonly QueuedActionRule[];
}

const NOT_IMPLEMENTED = 'bt-11: not implemented';

export function emptyDraft(unitId: number): Draft {
  return { unitId, actions: [] };
}

/** A NEW draft with `action` appended. */
export function push(_draft: Draft, _action: QueuedActionRule): Draft {
  throw new Error(NOT_IMPLEMENTED);
}

/** A NEW draft without its last action (the same draft when empty). */
export function pop(_draft: Draft): Draft {
  throw new Error(NOT_IMPLEMENTED);
}

/** Skill, Item, Recruit, Flee and EndTurn commit; a Move is free (a ghost). */
export function isIrreversible(_action: QueuedActionRule): boolean {
  throw new Error(NOT_IMPLEMENTED);
}

/** The board with `unitId`'s `actions` applied in order (REV 5 A25): a Move puts the row on its
 *  destination when `rules.path` is Ok; a Skill sets each hit target's `cur_hp` to the forecast's
 *  minimum-roll `hp_after` (Fainted when `kills_min`); an Err halts the rest of the plan. */
export function applyPlan(
  _rules: TacticsRules,
  _board: RulesBoard,
  _unitId: number,
  _actions: readonly QueuedActionRule[],
): RulesBoard {
  throw new Error(NOT_IMPLEMENTED);
}

/** The costable entries of `actions` on `liveBoard`: a Move's tax is `rules.disengage` at its start
 *  tile (the previous Move's destination, else the unit's tile); a Skill is `{Attack: tier}` from the
 *  unit's kit (an unknown skill throws). */
export function costEntries(
  _rules: TacticsRules,
  _liveBoard: RulesBoard,
  _unit: RulesUnit,
  _actions: readonly QueuedActionRule[],
): Entry[] {
  throw new Error(NOT_IMPLEMENTED);
}

/** The binding-shaped `submit_queue` entries (a bait of null becomes `undefined`). */
export function toWire(_actions: readonly QueuedActionRule[]): QueuedAction[] {
  throw new Error(NOT_IMPLEMENTED);
}

/** TOTAL: whether a `cancel_queue` rejection is the design's cancel race (`AlreadyActing`). */
export function isAlreadyActing(_err: unknown): boolean {
  throw new Error(NOT_IMPLEMENTED);
}
