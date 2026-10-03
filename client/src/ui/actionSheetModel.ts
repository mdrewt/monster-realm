// ui/actionSheetModel.ts — the world picker and action sheet (ctl-10a). Pure: no DOM, module state
// or clock. Both are one list of entity × action rows over the candidates `interact_candidates_coded`
// returned: A with several opens the picker (every actionable candidate's actions), Y opens the
// primary candidate's sheet (its actions only). The cursor is nav.ts's list rule.
import type { InteractAction, InteractCandidate } from './interactModel';
import { list, type NavInput, type NavLayout, type NavState, navInit, navStep } from './nav';

export interface SheetEntry {
  /** `${candidate.key}|${action.kind}`: unique per row, and how a row is matched to the live
   *  candidates when it is run. */
  readonly key: string;
  readonly candidate: InteractCandidate;
  readonly action: InteractAction;
}

export interface SheetState {
  readonly entries: readonly SheetEntry[];
  readonly nav: NavState;
}

/** The rows of one candidate, in its own action order. */
export function sheetEntries(primary: InteractCandidate): readonly SheetEntry[] {
  return primary.actions.map((action) => ({
    key: `${primary.key}|${action.kind}`,
    candidate: primary,
    action,
  }));
}

/** Every actionable candidate's rows, in the candidates' (priority) order. A candidate with no
 *  action (a player, until ctl-10b) has no row. */
export function pickerEntries(cands: readonly InteractCandidate[]): readonly SheetEntry[] {
  return cands.flatMap(sheetEntries);
}

const layoutOf = (entries: readonly SheetEntry[]): NavLayout =>
  list(entries.map((e) => ({ key: e.key, enabled: true })));

/** A sheet on its first row; null when there is no row to show. */
export function openSheet(entries: readonly SheetEntry[]): SheetState | null {
  if (entries.length === 0) return null;
  return { entries, nav: navInit(layoutOf(entries)) };
}

/** One button on an open sheet. A runs the row under the cursor and closes, but only while that
 *  row is still one of `current`'s: a candidate that walked off the tile or lost the action closes
 *  the sheet with nothing run. B and Start close it; a repeat A does nothing. */
export function sheetStep(
  s: SheetState,
  btn: NavInput,
  current: readonly InteractCandidate[],
): { readonly state: SheetState | null; readonly run?: InteractAction } {
  if (btn.button === 'B' || btn.button === 'Start') return { state: null };
  const { state: nav, outcome } = navStep(layoutOf(s.entries), s.nav, btn);
  if (outcome.kind !== 'activate') return { state: nav === s.nav ? s : { ...s, nav } };
  const live = pickerEntries(current).find((e) => e.key === outcome.key);
  return live === undefined ? { state: null } : { state: null, run: live.action };
}
