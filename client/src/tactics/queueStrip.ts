// tactics/queueStrip.ts — the plan STRIP model (BT11.3; plan REV 4 §R4.5 as superseded by REV 6 R6.2):
// one chip per planned step with its AP cost (the rules' plan, tax included on the current board), a
// ✓ / ~ / ✗ badge (firm / provisional / stale, re-evaluated on every paint) and the `only N held` note
// of an over-planned bait. Pure: data and `TacticsRules` calls only — no AP sum, no adjacency or
// range test, no text (tactics/strings.ts resolves the words).
import type { QueuedActionRule, RulesBoard, RulesUnit, TacticsRules, TurnBudget } from './wasm';

export type Badge = 'firm' | 'provisional' | 'stale';
export interface ChipVM {
  readonly action: QueuedActionRule;
  /** The rules' charge for this step (`plan(...).costs[i]`), or null when the plan is refused here. */
  readonly cost: number | null;
  readonly badge: Badge;
  /** For an over-planned bait: how many the player holds; else null. */
  readonly onlyHeld: number | null;
}
export interface StripVM {
  readonly chips: readonly ChipVM[];
  /** The rules' total / remaining budget over the whole plan, or null when the plan is refused. */
  readonly total: number | null;
  readonly remaining: TurnBudget | null;
  /** A READY row is shown and no draft replaces it. */
  readonly locked: boolean;
}
export interface StripInput {
  readonly rules: TacticsRules;
  readonly liveBoard: RulesBoard;
  /** `rules.unit(...)` of the planning unit's LIVE row. */
  readonly unit: RulesUnit;
  readonly startBudget: TurnBudget;
  readonly actions: readonly QueuedActionRule[];
  readonly mode: 'live' | 'prequeue';
  readonly locked: boolean;
  /** Baits held by item id. */
  readonly baitHeld: ReadonlyMap<number, number>;
  /** Baits planned by item id across this unit's shown plan and every other own unit's READY row. */
  readonly baitPlanned: ReadonlyMap<number, number>;
}

export function stripVM(_o: StripInput): StripVM {
  throw new Error('bt-11: not implemented');
}
