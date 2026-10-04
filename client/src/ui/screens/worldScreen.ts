// ui/screens/worldScreen.ts — what A and Y do at the world base (ctl-10a). Pure. The candidates
// are the wasm rule's answer (ui/interactModel.ts); this decides only what a press does with them.
// Counting is over ACTIONABLE rows, so ctl-10b's player actions add rows without changing the rule:
// none → the press is not ours (no toast); one → it runs; several → the picker opens. A Challenge
// never runs on A alone: a lone Challenge row opens straight into its Yes-default confirm (ctl-10b).
// Notices (ctl-13): with no target, Y opens the oldest pending request's Accept / Decline / View
// sheet, and B dismisses the top notice; the shell runs the returned command, dismissal or view.
import {
  askConfirm,
  openSheet,
  pickerEntries,
  type SheetState,
  sheetEntries,
  sheetStep,
} from '../actionSheetModel';
import type { InteractAction, InteractCandidate } from '../interactModel';
import type { NavInput } from '../nav';
import {
  type Notice,
  openRequestSheet,
  type RequestNotice,
  type RequestSheet,
  requestCommand,
  requestSheetStep,
} from '../noticeModel';
import type { Command } from './types';

/** What the world's notices add to a button: the notices top first, the pending requests (not
 *  filtered by dismissal) and the open request sheet. */
export interface WorldNotices {
  readonly notices: readonly Notice[];
  readonly pending: readonly RequestNotice[];
  readonly request: RequestSheet | null;
}

export interface WorldStep {
  readonly sheet: SheetState | null;
  readonly request: RequestSheet | null;
  readonly result: 'consumed' | 'unhandled';
  readonly run?: InteractAction;
  /** A request answered from its sheet. */
  readonly command?: Command;
  /** The key of the notice B dismissed, or of the request just answered. */
  readonly dismiss?: string;
  /** The request whose View row was chosen. */
  readonly view?: RequestNotice;
}

export function worldButton(
  sheet: SheetState | null,
  cands: readonly InteractCandidate[],
  btn: NavInput,
  n?: WorldNotices,
): WorldStep {
  // An open request sheet owns every button.
  if (n?.request != null) {
    const step = requestSheetStep(n.request, btn, n.pending);
    const base = { sheet: null, request: step.state, result: 'consumed' } as const;
    if (step.run === 'view') return { ...base, view: n.request.notice };
    // Answered: its banner goes too, so a second Y cannot answer again before the row changes.
    if (step.run !== undefined)
      return {
        ...base,
        command: requestCommand(n.request.notice, step.run),
        dismiss: n.request.notice.key,
      };
    return base;
  }
  // An open sheet owns every button.
  if (sheet !== null) {
    const step = sheetStep(sheet, btn, cands);
    return step.run === undefined
      ? { sheet: step.state, request: null, result: 'consumed' }
      : { sheet: step.state, request: null, result: 'consumed', run: step.run };
  }
  if (btn.repeat) return { sheet, request: null, result: 'unhandled' };
  if (btn.button === 'A') {
    const entries = pickerEntries(cands);
    const only = entries.length === 1 ? entries[0] : undefined;
    const opened = openSheet(entries);
    if (only !== undefined && opened !== null && only.action.kind === 'challenge')
      return { sheet: askConfirm(opened, only.key), request: null, result: 'consumed' };
    if (only !== undefined) return { sheet, request: null, result: 'consumed', run: only.action };
    return opened === null
      ? { sheet, request: null, result: 'unhandled' }
      : { sheet: opened, request: null, result: 'consumed' };
  }
  if (btn.button === 'Y') {
    const primary = cands[0];
    const opened = primary === undefined ? null : openSheet(sheetEntries(primary));
    if (opened !== null) return { sheet: opened, request: null, result: 'consumed' };
    const waiting = n?.pending[0];
    return waiting === undefined
      ? { sheet, request: null, result: 'unhandled' }
      : { sheet, request: openRequestSheet(waiting), result: 'consumed' };
  }
  if (btn.button === 'B') {
    const top = n?.notices[0];
    if (top !== undefined) return { sheet, request: null, result: 'consumed', dismiss: top.key };
  }
  return { sheet, request: null, result: 'unhandled' };
}
