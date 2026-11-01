// tactics/queueStrip.ts — the plan STRIP model (BT11.3; plan REV 4 §R4.5 as superseded by REV 6 R6.2 +
// REV 6.1 C1/C8): one chip per planned step with its AP cost (the rules' plan of the steps up to it,
// the disengage tax judged on the CURRENT board), a firm / provisional / stale badge (legality judged
// on the board the unit will ACT on, chained step by step through draft.ts's `applyAction`) and the
// `only N held` note of an over-planned bait. Pure: data and `TacticsRules` calls only — no AP sum,
// no adjacency or range test, no text (tactics/strings.ts resolves the words).
import { applyAction, costEntries } from './draft';
import type {
  QueuedActionRule,
  RuleResult,
  RulesBoard,
  RulesUnit,
  TacticsRules,
  TurnBudget,
} from './wasm';

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
}
export interface StripInput {
  readonly rules: TacticsRules;
  /** The board as it stands NOW: every chip's cost (the disengage tax included) is judged on it. */
  readonly liveBoard: RulesBoard;
  /** The board the unit will ACT on (the projection up to its turn; the live board on a live turn):
   *  every chip's legality is judged on it, chained through `applyAction`. */
  readonly actBoard: RulesBoard;
  /** `rules.unit(...)` of the planning unit's LIVE row. */
  readonly unit: RulesUnit;
  readonly startBudget: TurnBudget;
  readonly actions: readonly QueuedActionRule[];
  readonly mode: 'live' | 'prequeue';
  /** No recruit headroom: a Recruit chip is never legal. */
  readonly partyFull: boolean;
  /** Baits held by item id. */
  readonly baitHeld: ReadonlyMap<number, number>;
  /** Baits planned by item id across this unit's shown plan and every other own unit's plan. */
  readonly baitPlanned: ReadonlyMap<number, number>;
}

const isOk = <T, E>(r: RuleResult<T, E>): r is { readonly Ok: T } => 'Ok' in r;

/** The held count of an over-planned bait (planned more often than held), else null. */
function onlyHeldOf(
  action: QueuedActionRule,
  held: ReadonlyMap<number, number>,
  planned: ReadonlyMap<number, number>,
): number | null {
  if (typeof action !== 'object' || !('Recruit' in action)) return null;
  const bait = action.Recruit.bait;
  if (bait === null) return null;
  const have = held.get(bait) ?? 0;
  return (planned.get(bait) ?? 0) > have ? have : null;
}

/** The board after a legal step, or null when the rules refuse it now: a Recruit must be among the
 *  rules' recruit targets from the chained tile with the budget the step would start from (and the
 *  party must have room); a Move or Skill is `applyAction`'s verdict; Item / Flee / EndTurn are free. */
function legalStep(
  o: StripInput,
  board: RulesBoard,
  action: QueuedActionRule,
  budgetBefore: TurnBudget,
): RulesBoard | null {
  if (typeof action === 'object' && 'Recruit' in action) {
    if (o.partyFull) return null;
    const targets = o.rules.recruitTargets(board, o.unit.id, budgetBefore);
    return targets.includes(action.Recruit.target) ? board : null;
  }
  return applyAction(o.rules, board, o.unit.id, action);
}

/** The strip over `o.actions`: chip i's cost is `plan(startBudget, entries[0..=i]).costs[i]`; a chip is
 *  stale once its prefix plan is refused or its step is illegal on the chained act board, and so is
 *  every later chip (no legality question is asked past the first stale chip); firm on a live turn or
 *  for EndTurn / Flee, else provisional; an over-planned bait is provisional with its held count. */
export function stripVM(o: StripInput): StripVM {
  const { rules, startBudget, actions } = o;
  const entries = costEntries(rules, o.liveBoard, o.unit, actions);
  const chips: ChipVM[] = [];
  let board = o.actBoard;
  let budgetBefore = startBudget;
  let stale = false;
  actions.forEach((action, i) => {
    const plan = rules.plan(startBudget, entries.slice(0, i + 1));
    const cost = isOk(plan) ? (plan.Ok.costs[i] ?? null) : null;
    if (!stale) {
      const next = isOk(plan) ? legalStep(o, board, action, budgetBefore) : null;
      if (next === null) stale = true;
      else board = next;
    }
    if (isOk(plan)) budgetBefore = plan.Ok.remaining;
    const onlyHeld = onlyHeldOf(action, o.baitHeld, o.baitPlanned);
    let badge: Badge = 'provisional';
    if (stale) badge = 'stale';
    else if (
      onlyHeld === null &&
      (o.mode === 'live' || action === 'EndTurn' || action === 'Flee')
    ) {
      badge = 'firm';
    }
    chips.push({ action, cost, badge, onlyHeld });
  });
  const whole = rules.plan(startBudget, entries);
  return {
    chips,
    total: isOk(whole) ? whole.Ok.total : null,
    remaining: isOk(whole) ? whole.Ok.remaining : null,
  };
}
