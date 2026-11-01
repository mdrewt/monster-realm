// tactics/provisionalBoard.ts — the PROVISIONAL board (BT11.5; plan REV 4 §R4.6 as superseded by
// REV 6 R6.3): the live rows with this player's own READY and DRAFT plans applied in initiative order,
// each wild's `ai::plan` applied in PvE, enemies frozen in PvP. Pure and rules-consuming: every
// position comes from `rules.path`, every HP from `rules.forecast`, every wild plan from
// `rules.aiPlan` — through the ONE `applyPlan` walk of draft.ts; no geometry or arithmetic here.
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
  readonly plans: readonly PlanInput[];
  /** Wilds whose live `Intent.block_pct` is 100 (asleep / frozen): they do not act. */
  readonly blocked: ReadonlySet<number>;
  /** Apply each wild's `rules.aiPlan` at its turn (the aim board); false holds every enemy at its
   *  live tile (the danger board: where the enemies can strike on their UPCOMING turn). */
  readonly wilds: boolean;
  /** Stop BEFORE this unit's turn (the forecast board of a pre-queued unit). */
  readonly upTo?: number;
}

export function project(_rules: TacticsRules, _live: RulesBoard, _o: ProjectInput): Projection {
  throw new Error('bt-11: not implemented');
}
