// ui/actionSheetModel.ts — the world picker and action sheet (ctl-10a), and the Yes-default confirm
// a Challenge row asks first (ctl-10b). Pure: no DOM, module state or clock. Both are one list of entity × action rows over the candidates `interact_candidates_coded`
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

/** The Yes / No question a Challenge row asks before it runs: `key` is the row's, `nav` the cursor
 *  over `confirmLayout`. */
export interface SheetConfirm {
  readonly key: string;
  readonly nav: NavState;
}

export interface SheetState {
  readonly entries: readonly SheetEntry[];
  readonly nav: NavState;
  /** Non-null while a Challenge row's confirm is up; the row cursor stays underneath. */
  readonly confirm: SheetConfirm | null;
}

/** The confirm's rows, Yes first: Yes is the default. */
export const confirmLayout: NavLayout = list([
  { key: 'yes', enabled: true },
  { key: 'no', enabled: true },
]);

/** The rows of one candidate, in its own action order. */
export function sheetEntries(primary: InteractCandidate): readonly SheetEntry[] {
  return primary.actions.map((action) => ({
    key: `${primary.key}|${action.kind}`,
    candidate: primary,
    action,
  }));
}

/** Every actionable candidate's rows, in the candidates' (priority) order. A candidate with no
 *  action (an offline player) has no row. */
export function pickerEntries(cands: readonly InteractCandidate[]): readonly SheetEntry[] {
  return cands.flatMap(sheetEntries);
}

/** The rows as a nav list: what `sheetStep` steps and the shell renders. */
export const sheetLayout = (entries: readonly SheetEntry[]): NavLayout =>
  list(entries.map((e) => ({ key: e.key, enabled: true })));

/** A sheet on its first row; null when there is no row to show. */
export function openSheet(entries: readonly SheetEntry[]): SheetState | null {
  if (entries.length === 0) return null;
  return { entries, nav: navInit(sheetLayout(entries)), confirm: null };
}

/** `s` with the confirm up for the row `key`, on Yes. */
export const askConfirm = (s: SheetState, key: string): SheetState => ({
  ...s,
  confirm: { key, nav: navInit(confirmLayout) },
});

type SheetStepResult = { readonly state: SheetState | null; readonly run?: InteractAction };

/** The row `key` among `current`'s rows: what runs is always the live action, never the one the
 *  sheet was opened with. A candidate that walked off the tile or lost the action has none. */
const liveAction = (
  key: string,
  current: readonly InteractCandidate[],
): InteractAction | undefined => pickerEntries(current).find((e) => e.key === key)?.action;

/** One button on an open sheet. A runs the row under the cursor and closes, but only while that
 *  row is still one of `current`'s: otherwise the sheet closes with nothing run. A Challenge row
 *  asks first: A opens the confirm on Yes, Yes runs it (revalidated the same way), No and B return
 *  to the rows. Start closes from either; B on the rows closes. A held button does nothing. */
export function sheetStep(
  s: SheetState,
  btn: NavInput,
  current: readonly InteractCandidate[],
): SheetStepResult {
  if ((btn.button === 'Start' || btn.button === 'B') && btn.repeat) return { state: s };
  if (btn.button === 'Start') return { state: null };
  if (s.confirm !== null) return confirmStep(s, s.confirm, btn, current);
  if (btn.button === 'B') return { state: null };
  const { state: nav, outcome } = navStep(sheetLayout(s.entries), s.nav, btn);
  if (outcome.kind !== 'activate') return { state: nav === s.nav ? s : { ...s, nav } };
  const action = liveAction(outcome.key, current);
  if (action === undefined) return { state: null };
  return action.kind === 'challenge'
    ? { state: askConfirm(s, outcome.key) }
    : { state: null, run: action };
}

function confirmStep(
  s: SheetState,
  confirm: SheetConfirm,
  btn: NavInput,
  current: readonly InteractCandidate[],
): SheetStepResult {
  if (btn.button === 'B') return { state: { ...s, confirm: null } };
  const { state: nav, outcome } = navStep(confirmLayout, confirm.nav, btn);
  if (outcome.kind !== 'activate')
    return { state: nav === confirm.nav ? s : { ...s, confirm: { ...confirm, nav } } };
  if (outcome.key === 'no') return { state: { ...s, confirm: null } };
  const action = liveAction(confirm.key, current);
  return action === undefined ? { state: null } : { state: null, run: action };
}
