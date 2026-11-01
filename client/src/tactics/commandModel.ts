// tactics/commandModel.ts — the hierarchical command menu MODEL (BT11.1; plan REV 4 §R4.3 + REV 5
// A26/A29/A34). Pure: codes, never text (tactics/strings.ts resolves them); every legality predicate
// is a `TacticsRules` call — no AP sum, range check or adjacency test lives here. The boards it reads
// are the shell's (REV 5 A24): the COST board (the live rows with this unit's own draft applied) for
// movement, costing and recruit targets, the AIM board for skill aims.
import type {
  ActionTarget,
  Cell,
  EconomyError,
  Entry,
  QueuedActionRule,
  RuleResult,
  RulesBoard,
  RulesUnit,
  RuleTier,
  TacticsRules,
  TurnBudget,
} from './wasm';

export type MenuRowId =
  | 'move'
  | 'skills'
  | 'item'
  | 'recruit'
  | 'flee'
  | 'end'
  | 'submit'
  | 'clear';
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

const isOk = <T, E>(r: RuleResult<T, E>): r is { readonly Ok: T } => 'Ok' in r;

/** Whether the rules spend `entries` from the ctx budget. */
const affordable = (ctx: MenuContext, entries: readonly Entry[]): boolean =>
  isOk(ctx.rules.plan(ctx.budget, entries));

/** The economy's refusal of one stride, as a reason code. */
function strideReason(err: EconomyError): ReasonCode {
  return typeof err === 'object' && 'StrideCap' in err ? 'strideCap' : 'unaffordable';
}

/** The plan is closed: nothing may follow EndTurn, Recruit or Flee (the server's "must be alone"
 *  and "EndTurn only last" rules). */
function planComplete(actions: readonly QueuedActionRule[]): boolean {
  const last = actions[actions.length - 1];
  if (last === undefined) return false;
  return last === 'EndTurn' || last === 'Flee' || 'Recruit' in last;
}

/** The Move band on the cost board: reach1 (1 stride) and reach2 (2 strides), exclusive sets. */
export function moveBand(ctx: MenuContext): { readonly reach1: Cell[]; readonly reach2: Cell[] } {
  const out = ctx.rules.overlays(ctx.costBoard, {
    viewer: ctx.unit.side,
    selected: ctx.unit.id,
    skill_id: null,
    aim: null,
    budget: ctx.budget,
  });
  return { reach1: [...out.reach1], reach2: [...out.reach2] };
}

/** The Recruit targets now: `rules.recruitTargets(costBoard, unit.id, budget)`, as the rules list them. */
export function recruitTargets(ctx: MenuContext): number[] {
  return [...ctx.rules.recruitTargets(ctx.costBoard, ctx.unit.id, ctx.budget)];
}

/** The End row's live label: `rules.plan(budget, ['EndTurn']).Ok.guard_on_end`. */
export function endLabel(ctx: MenuContext): 'endTurn' | 'guard' {
  const end = ctx.rules.plan(ctx.budget, ['EndTurn']);
  return isOk(end) && end.Ok.guard_on_end ? 'guard' : 'endTurn';
}

/** Undo (B pops a chip) iff the draft is non-empty; Cancel (Clear plan) iff prequeue, a READY row and
 *  no draft — never both. */
export function offers(ctx: MenuContext): { readonly undo: boolean; readonly cancel: boolean } {
  const drafted = ctx.actions.length > 0;
  return { undo: drafted, cancel: ctx.mode === 'prequeue' && ctx.hasReady && !drafted };
}

/** One row per kit skill, kit order. */
export function skillRows(ctx: MenuContext): SkillRow[] {
  return ctx.unit.kit.skills.map((skill): SkillRow => {
    if (!affordable(ctx, [{ Attack: skill.tier }])) {
      return {
        skillId: skill.skill_id,
        tier: skill.tier,
        enabled: false,
        reason: 'unaffordable',
        aims: [],
      };
    }
    const aims: SkillAim[] = [];
    if (skill.geometry.origin === 'Caster') {
      const hit = ctx.rules.targets(ctx.aimBoard, ctx.unit.id, skill.skill_id, ctx.unit.pos);
      if (isOk(hit)) aims.push({ aim: ctx.unit.pos, target: 'SelfTarget', hits: hit.Ok });
    } else {
      // Every unit of either side is a candidate aim; the rules decide (range, line of sight,
      // consciousness, friendly fire). The bound unit must itself be in the hit set.
      for (const u of ctx.aimBoard.units) {
        const hit = ctx.rules.targets(ctx.aimBoard, ctx.unit.id, skill.skill_id, u.pos);
        if (isOk(hit) && hit.Ok.includes(u.id)) {
          aims.push({ aim: u.pos, target: { Unit: u.id }, hits: hit.Ok });
        }
      }
    }
    return {
      skillId: skill.skill_id,
      tier: skill.tier,
      enabled: aims.length > 0,
      reason: aims.length > 0 ? null : 'outOfRange',
      aims,
    };
  });
}

/** The root rows in order: move, skills, item, recruit (wild), flee (wild), end, submit (prequeue),
 *  clear (prequeue with a READY row and no draft). */
export function menuRows(ctx: MenuContext): MenuRow[] {
  const closed = planComplete(ctx.actions);
  const greyed = (id: MenuRowId, reason: ReasonCode, sub: boolean): MenuRow => ({
    id,
    enabled: false,
    reason,
    sub,
  });
  const row = (id: MenuRowId, reason: ReasonCode | null, sub: boolean): MenuRow =>
    closed ? greyed(id, 'planComplete', sub) : { id, enabled: reason === null, reason, sub };

  let moveReason: ReasonCode | null = null;
  if (!closed) {
    const band = moveBand(ctx);
    if (band.reach1.length === 0 && band.reach2.length === 0) {
      const one = ctx.rules.plan(ctx.budget, [{ Move: { strides: 1, taxed: false } }]);
      moveReason = isOk(one) ? 'boxedIn' : strideReason(one.Err);
    }
  }
  let skillsReason: ReasonCode | null = null;
  if (!closed) {
    const skills = skillRows(ctx);
    const usable = skills.some((s) => s.enabled);
    if (!usable) skillsReason = skills[0]?.reason ?? 'outOfRange';
  }

  const rows: MenuRow[] = [
    row('move', moveReason, true),
    row('skills', skillsReason, true),
    greyed('item', 'notAvailable', false),
  ];
  if (ctx.kind === 'wild') {
    let recruitReason: ReasonCode | null = null;
    if (!closed) {
      if (ctx.partyFull) recruitReason = 'partyFull';
      else if (!affordable(ctx, ['Recruit']) || recruitTargets(ctx).length === 0) {
        recruitReason = 'recruitFullAp';
      }
    }
    rows.push(row('recruit', recruitReason, true));
    rows.push(row('flee', closed ? null : affordable(ctx, ['Flee']) ? null : 'fleeFullAp', false));
  }
  rows.push(row('end', null, false));
  if (ctx.mode === 'prequeue') {
    const drafted = ctx.actions.length > 0;
    rows.push({ id: 'submit', enabled: drafted, reason: null, sub: false });
    if (offers(ctx).cancel) rows.push({ id: 'clear', enabled: true, reason: null, sub: true });
  }
  return rows;
}
