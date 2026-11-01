// tactics/draft.ts — the client-local DRAFT (BT11.2; plan REV 4 §R4.4 + REV 5 A25/A28/A37): the
// actions a unit has queued but not sent, their costed entries, the ONE board-application walk every
// consumer shares (the menu, the strip, the projection), and the wire shape `submit_queue` takes.
// Pure: data copies and `TacticsRules` calls only — no AP, HP, distance or range arithmetic; a Move
// lands where the rules' path lands, a hit target keeps the HP the rules' forecast leaves it.
import type { QueuedAction } from '../module_bindings/types';
import type {
  ActionTarget,
  Entry,
  QueuedActionRule,
  RuleResult,
  RulesBoard,
  RulesUnit,
  TacticsRules,
  UnitRow,
} from './wasm';

export interface Draft {
  readonly unitId: number;
  readonly actions: readonly QueuedActionRule[];
}

export function emptyDraft(unitId: number): Draft {
  return { unitId, actions: [] };
}

/** A NEW draft with `action` appended. */
export function push(draft: Draft, action: QueuedActionRule): Draft {
  return { unitId: draft.unitId, actions: [...draft.actions, action] };
}

/** A NEW draft without its last action (the same draft when empty). */
export function pop(draft: Draft): Draft {
  if (draft.actions.length === 0) return draft;
  return { unitId: draft.unitId, actions: draft.actions.slice(0, -1) };
}

/** Skill, Item, Recruit, Flee and EndTurn commit; a Move is free (a ghost). */
export function isIrreversible(action: QueuedActionRule): boolean {
  return !(typeof action === 'object' && 'Move' in action);
}

const isOk = <T, E>(r: RuleResult<T, E>): r is { readonly Ok: T } => 'Ok' in r;

function rowOf(board: RulesBoard, id: number): UnitRow | undefined {
  return board.units.find((u) => u.id === id);
}

/** `board` with `row` replaced by `next` (a new board; the input is never mutated). */
function withRow(board: RulesBoard, next: UnitRow): RulesBoard {
  return { ...board, units: board.units.map((u) => (u.id === next.id ? next : u)) };
}

/** The rules' hit set of `skillId` from `caster` bound to `target`: the aim is the bound unit's
 *  tile (or the caster's own for SelfTarget); `null` when the rules refuse the aim or the bound unit
 *  is not among the hit ids (halt-and-return, A25). */
function hitSet(
  rules: TacticsRules,
  board: RulesBoard,
  caster: UnitRow,
  skillId: number,
  target: ActionTarget,
): readonly number[] | null {
  let aim = caster.pos;
  let bound: number | null = null;
  if (target !== 'SelfTarget') {
    const t = rowOf(board, target.Unit);
    if (t === undefined) return null;
    aim = t.pos;
    bound = t.id;
  }
  const hit = rules.targets(board, caster.id, skillId, aim);
  if (!isOk(hit)) return null;
  if (bound !== null && !hit.Ok.includes(bound)) return null;
  return hit.Ok;
}

/** `board` with ONE action of `unitId` applied (the step `applyPlan` folds; REV 6 R6.1), or null
 *  when the rules refuse it now: a Move whose `rules.path` is Err, a Skill whose aim is refused or
 *  whose bound unit is not among the hits, or a unit that is not on the board. Item / Recruit /
 *  Flee / EndTurn leave the same board object (their outcome is the server's roll). */
export function applyAction(
  rules: TacticsRules,
  board: RulesBoard,
  unitId: number,
  action: QueuedActionRule,
): RulesBoard | null {
  const caster = rowOf(board, unitId);
  if (caster === undefined) return null;
  if (typeof action !== 'object') return board; // Flee / EndTurn: nothing on the board.
  if ('Move' in action) {
    const dest = { x: action.Move.x, y: action.Move.y };
    if (!isOk(rules.path(board, unitId, dest))) return null;
    return withRow(board, { ...caster, pos: dest });
  }
  if ('Skill' in action) {
    const hits = hitSet(rules, board, caster, action.Skill.skill_id, action.Skill.target);
    if (hits === null) return null;
    const attacker = rules.unit(caster);
    let out = board;
    for (const id of hits) {
      const row = rowOf(out, id);
      if (row === undefined) continue;
      const flank = rules.flank(out, unitId, id);
      const f = rules.forecast(attacker, rules.unit(row), action.Skill.skill_id, flank);
      out = withRow(out, {
        ...row,
        cur_hp: f.min.hp_after,
        state: f.kills_min ? 'Fainted' : row.state,
      });
    }
    return out;
  }
  return board; // Item / Recruit: nothing on the board.
}

/** The board with `unitId`'s `actions` applied in order (REV 5 A25): the fold of `applyAction`,
 *  halting at the first step the rules refuse (the board so far is returned). */
export function applyPlan(
  rules: TacticsRules,
  board: RulesBoard,
  unitId: number,
  actions: readonly QueuedActionRule[],
): RulesBoard {
  let out = board;
  for (const action of actions) {
    const next = applyAction(rules, out, unitId, action);
    if (next === null) return out;
    out = next;
  }
  return out;
}

/** The costable entries of `actions` on `liveBoard`: a Move's tax is `rules.disengage` at its start
 *  tile (the previous Move's destination, else the unit's tile); a Skill is `{Attack: tier}` from the
 *  unit's kit (an unknown skill throws). */
export function costEntries(
  rules: TacticsRules,
  liveBoard: RulesBoard,
  unit: RulesUnit,
  actions: readonly QueuedActionRule[],
): Entry[] {
  const entries: Entry[] = [];
  let start: { readonly x: number; readonly y: number } | undefined;
  for (const action of actions) {
    if (typeof action !== 'object') {
      entries.push(action);
      continue;
    }
    if ('Move' in action) {
      const taxed = rules.disengage(liveBoard, unit.id, start);
      if (!isOk(taxed)) {
        throw new Error(`unit ${unit.id}: the disengage tax was refused: ${JSON.stringify(taxed)}`);
      }
      entries.push({ Move: { strides: action.Move.strides, taxed: taxed.Ok } });
      start = { x: action.Move.x, y: action.Move.y };
    } else if ('Skill' in action) {
      const skill = unit.kit.skills.find((k) => k.skill_id === action.Skill.skill_id);
      if (skill === undefined) {
        throw new Error(`unit ${unit.id} has no skill ${action.Skill.skill_id} in its kit`);
      }
      entries.push({ Attack: skill.tier });
    } else if ('Item' in action) {
      entries.push('Item');
    } else {
      entries.push('Recruit');
    }
  }
  return entries;
}

type WireTarget = Extract<QueuedAction, { tag: 'Skill' }>['value']['target'];

function wireTarget(target: ActionTarget): WireTarget {
  return target === 'SelfTarget' ? { tag: 'SelfTarget' } : { tag: 'Unit', value: target.Unit };
}

/** The binding-shaped `submit_queue` entries (a bait of null becomes `undefined`). */
export function toWire(actions: readonly QueuedActionRule[]): QueuedAction[] {
  return actions.map((action): QueuedAction => {
    if (action === 'Flee') return { tag: 'Flee' };
    if (action === 'EndTurn') return { tag: 'EndTurn' };
    if ('Move' in action) {
      return {
        tag: 'Move',
        value: { x: action.Move.x, y: action.Move.y, strides: action.Move.strides },
      };
    }
    if ('Skill' in action) {
      return {
        tag: 'Skill',
        value: { skillId: action.Skill.skill_id, target: wireTarget(action.Skill.target) },
      };
    }
    if ('Item' in action) {
      return {
        tag: 'Item',
        value: { itemId: action.Item.item_id, target: wireTarget(action.Item.target) },
      };
    }
    return {
      tag: 'Recruit',
      value: { target: action.Recruit.target, bait: action.Recruit.bait ?? undefined },
    };
  });
}

/** TOTAL: whether a `cancel_queue` rejection is the design's cancel race (`AlreadyActing`): a
 *  SenderError (name equality, as ui/statusModel.ts classifies reducer errors) whose message is
 *  exactly the reducer's `cancel_queue: AlreadyActing`. Never throws (a hostile accessor is `false`). */
export function isAlreadyActing(err: unknown): boolean {
  try {
    if (err === null || typeof err !== 'object') return false;
    const { name, message } = err as { readonly name?: unknown; readonly message?: unknown };
    return name === 'SenderError' && message === 'cancel_queue: AlreadyActing';
  } catch {
    return false;
  }
}
