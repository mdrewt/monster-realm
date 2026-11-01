// tactics/provisionalBoard.ts — the PROVISIONAL board (BT11.5; plan REV 4 §R4.6 as superseded by
// REV 6 R6.3 + REV 6.1 C3/C4 + REV 6.2 C19): the live rows with this player's own plans applied in
// initiative order, each wild's `ai::plan` applied at its turn in PvE (asked of the board as it stands
// then), enemies frozen in PvP. Pure and rules-consuming: every position comes from `rules.path`,
// every HP from `rules.forecast`, every wild plan from `rules.aiPlan` — through the ONE `applyPlan`
// walk of draft.ts; no geometry or arithmetic here.
import { applyPlan } from './draft';
import type { QueuedActionRule, RuleSide, RulesBoard, TacticsRules } from './wasm';

export interface PlanInput {
  readonly unitId: number;
  readonly actions: readonly QueuedActionRule[];
}
export interface Projection {
  readonly board: RulesBoard;
  /** PvP only: the enemy units walked BEFORE `upTo` (they act first, with a secret plan). */
  readonly hidden: ReadonlySet<number>;
}
export interface ProjectInput {
  readonly kind: 'wild' | 'pvp';
  readonly mySide: RuleSide;
  /** The turn order to walk: the rest of this round, then the next round. */
  readonly order: readonly number[];
  /** One plan per unit (two for one unit is a programming error and throws). */
  readonly plans: readonly PlanInput[];
  /** Wilds whose live `Intent.block_pct` is 100 (asleep / frozen): they do not act. */
  readonly blocked: ReadonlySet<number>;
  /** Apply each wild's `rules.aiPlan` at its turn (the aim board); false holds every enemy at its
   *  live tile (the danger board: where the enemies can strike on their UPCOMING turn). */
  readonly wilds: boolean;
  /** Stop BEFORE this unit's turn (the forecast board of a pre-queued unit). */
  readonly upTo?: number;
}

/** Walk `o.order` once per unit, stopping before `upTo`: an own unit applies its plan; a wild (PvE)
 *  applies the plan the rules give it on the board as it stands — unless asleep (`blocked`) or held
 *  (`wilds: false`); any other enemy is frozen and, in PvP with an `upTo`, hidden. A unit absent or
 *  no longer Active when its turn comes acts no more. `live` is never mutated. */
export function project(rules: TacticsRules, live: RulesBoard, o: ProjectInput): Projection {
  const plans = new Map<number, readonly QueuedActionRule[]>();
  for (const p of o.plans) {
    if (plans.has(p.unitId)) throw new Error(`project: two plans for unit ${p.unitId}`);
    plans.set(p.unitId, p.actions);
  }
  const hidden = new Set<number>();
  const walked = new Set<number>();
  let board = live;
  for (const id of o.order) {
    if (id === o.upTo) break;
    if (walked.has(id)) continue;
    walked.add(id);
    const row = board.units.find((u) => u.id === id);
    if (row === undefined || row.state !== 'Active') continue;
    if (row.side === o.mySide) {
      const actions = plans.get(id);
      if (actions !== undefined) board = applyPlan(rules, board, id, actions);
    } else if (o.kind === 'wild' && row.wild_index !== null) {
      // A blocked wild skips its turn; a held one (the danger board) stands where it is.
      if (!o.blocked.has(id) && o.wilds)
        board = applyPlan(rules, board, id, rules.aiPlan(board, id));
    } else if (o.kind === 'pvp' && o.upTo !== undefined) {
      hidden.add(id);
    }
  }
  return { board, hidden };
}
