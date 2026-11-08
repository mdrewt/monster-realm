// ui/actionSheetModel.ts — the world picker and action sheet (ctl-10a), and the party-size pick a
// Challenge row asks first (ctl-10b's Yes-default confirm, re-shaped by bt-15 BT15.1). Pure: no DOM,
// module state or clock. Both are one list of entity × action rows over the candidates
// `interact_candidates_coded` returned: A with several opens the picker (every actionable candidate's
// actions), Y opens the primary candidate's sheet (its actions only). The cursor is nav.ts's list rule.
// Every picker / action sheet ends with a Close row (uif-12, UIF12.2): a layout row, never an
// entry, whose A is B's step.
import type { InteractAction, InteractCandidate } from './interactModel';
import { list, type NavInput, type NavLayout, type NavState, navInit, navStep } from './nav';

export interface SheetEntry {
  /** `${candidate.key}|${action.kind}`: unique per row, and how a row is matched to the live
   *  candidates when it is run. */
  readonly key: string;
  readonly candidate: InteractCandidate;
  readonly action: InteractAction;
}

/** The question a Challenge row asks before it runs (bt-15, BT15.1): `key` is the row's, `sizes` the
 *  party sizes offered when the confirm opened (largest first, frozen so the rows hold still) and
 *  `nav` the cursor over `challengeLayout(sizes)`. The chosen size is re-validated against the LIVE
 *  sizes at A. */
export interface SheetConfirm {
  readonly key: string;
  readonly nav: NavState;
  readonly sizes: readonly number[];
}

export interface SheetState {
  readonly entries: readonly SheetEntry[];
  readonly nav: NavState;
  /** Non-null while a Challenge row's confirm is up; the row cursor stays underneath. */
  readonly confirm: SheetConfirm | null;
}

/** A Yes-default Yes / No confirm, Yes first. Options › Controls' Reset-all confirm and the controls
 *  view share it; the Challenge confirm is `challengeLayout`'s since bt-15. */
export const confirmLayout: NavLayout = list([
  { key: 'yes', enabled: true },
  { key: 'no', enabled: true },
]);

const SIZE_ROW = 'size-';

/** The Challenge confirm's rows (bt-15, BT15.1): one `size-<n>` row per offered size, in the offered
 *  order (largest first — the first row is the default, "ranked is 3"), then `no`. */
export const challengeLayout = (sizes: readonly number[]): NavLayout =>
  list([
    ...sizes.map((n) => ({ key: `${SIZE_ROW}${n}`, enabled: true })),
    { key: 'no', enabled: true },
  ]);

/** The party size a `size-<n>` row names — `n` in its canonical decimal form only (`size-03`,
 *  `size-1e3`, `size-0` are not rows); null for `no` or any other key. */
export function sizeOfRow(key: string): number | null {
  if (!key.startsWith(SIZE_ROW)) return null;
  const digits = key.slice(SIZE_ROW.length);
  return /^[1-9][0-9]*$/.test(digits) ? Number(digits) : null;
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
 *  action (an offline player) has no row. */
export function pickerEntries(cands: readonly InteractCandidate[]): readonly SheetEntry[] {
  return cands.flatMap(sheetEntries);
}

/** The key of the Close row every world picker, action sheet and request sheet ends with (uif-12,
 *  UIF12.2). A layout row, never a `SheetEntry`: A on it is B's step. Entry keys are
 *  `<candidate>|<action>`, so it collides with none; `list` would throw if it did. */
export const CLOSE_KEY = 'close';

/** The rows as a nav list: what `sheetStep` steps and the shell renders — the entries, then Close. */
export const sheetLayout = (entries: readonly SheetEntry[]): NavLayout =>
  list([...entries.map((e) => ({ key: e.key, enabled: true })), { key: CLOSE_KEY, enabled: true }]);

/** A sheet on its first row; null when there is no row to show. */
export function openSheet(entries: readonly SheetEntry[]): SheetState | null {
  if (entries.length === 0) return null;
  return { entries, nav: navInit(sheetLayout(entries)), confirm: null };
}

/** `s` with the Challenge confirm up for the row `key`, on the largest of `sizes`. */
export const askConfirm = (s: SheetState, key: string, sizes: readonly number[]): SheetState => ({
  ...s,
  confirm: { key, nav: navInit(challengeLayout(sizes)), sizes: [...sizes] },
});

type SheetStepResult = {
  readonly state: SheetState | null;
  readonly run?: InteractAction;
  /** With a `run` of kind `challenge`: the party size the confirm chose (bt-15, BT15.1). */
  readonly partySize?: number;
};

/** The row `key` among `current`'s rows: what runs is always the live action, never the one the
 *  sheet was opened with. A candidate that walked off the tile or lost the action has none. */
const liveAction = (
  key: string,
  current: readonly InteractCandidate[],
): InteractAction | undefined => pickerEntries(current).find((e) => e.key === key)?.action;

/** One button on an open sheet. A runs the row under the cursor and closes, but only while that
 *  row is still one of `current`'s: otherwise the sheet closes with nothing run. A on the Close
 *  row is B's step: the sheet closes, nothing runs (uif-12, UIF12.2). A Challenge row
 *  asks the party size first (bt-15, BT15.1): A opens the confirm on the largest of `sizes` — with
 *  no size to offer (nothing conscious to field) it closes and runs nothing; A on a size row runs
 *  the challenge (revalidated the same way, and only while that size is still among the LIVE
 *  `sizes`), No and B return to the rows. Start closes from either; B on the rows closes. A held
 *  button does nothing. */
export function sheetStep(
  s: SheetState,
  btn: NavInput,
  current: readonly InteractCandidate[],
  sizes: readonly number[] = [],
): SheetStepResult {
  if ((btn.button === 'Start' || btn.button === 'B') && btn.repeat) return { state: s };
  if (btn.button === 'Start') return { state: null };
  if (s.confirm !== null) return confirmStep(s, s.confirm, btn, current, sizes);
  if (btn.button === 'B') return { state: null };
  const { state: nav, outcome } = navStep(sheetLayout(s.entries), s.nav, btn);
  if (outcome.kind !== 'activate') return { state: nav === s.nav ? s : { ...s, nav } };
  if (outcome.key === CLOSE_KEY) return { state: null };
  const action = liveAction(outcome.key, current);
  if (action === undefined) return { state: null };
  if (action.kind !== 'challenge') return { state: null, run: action };
  return sizes.length === 0 ? { state: null } : { state: askConfirm(s, outcome.key, sizes) };
}

function confirmStep(
  s: SheetState,
  confirm: SheetConfirm,
  btn: NavInput,
  current: readonly InteractCandidate[],
  sizes: readonly number[],
): SheetStepResult {
  if (btn.button === 'B') return { state: { ...s, confirm: null } };
  const { state: nav, outcome } = navStep(challengeLayout(confirm.sizes), confirm.nav, btn);
  if (outcome.kind !== 'activate')
    return { state: nav === confirm.nav ? s : { ...s, confirm: { ...confirm, nav } } };
  const partySize = sizeOfRow(outcome.key);
  if (partySize === null) return { state: { ...s, confirm: null } };
  const action = liveAction(confirm.key, current);
  // The size must still be offered NOW (a faint or a trade since the confirm opened shrinks the
  // party): otherwise close with nothing run, the same rule as a row whose entity walked off.
  if (action === undefined || !sizes.includes(partySize)) return { state: null };
  return { state: null, run: action, partySize };
}
