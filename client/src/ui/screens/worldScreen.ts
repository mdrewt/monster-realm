// ui/screens/worldScreen.ts — what A and Y do at the world base (ctl-10a). Pure. The candidates
// are the wasm rule's answer (ui/interactModel.ts); this decides only what a press does with them.
// Counting is over ACTIONABLE rows, so ctl-10b's player actions add rows without changing the rule:
// none → the press is not ours (no toast); one → it runs; several → the picker opens. A Challenge
// never runs on A alone: a lone Challenge row opens straight into its party-size pick (ctl-10b's
// Yes-default confirm, re-shaped by bt-15 BT15.1), and a confirmed pick leaves as a SIZED `challenge`
// Command, never as a run. Notices (ctl-13): with no target, Y opens the oldest pending request's
// Accept / Decline / View sheet, and B dismisses the top notice; the shell runs the returned command,
// dismissal or view. Over any sheet, Select closes it and is left to the base (Help, uif-12).
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
  /** A request answered from its sheet, or a challenge confirmed with its party size (bt-15). */
  readonly command?: Command;
  /** The key of the notice B dismissed, or of the request just answered. */
  readonly dismiss?: string;
  /** The request whose View row was chosen. */
  readonly view?: RequestNotice;
}

/** One sheet step's outcome: a plain action runs; a confirmed challenge is the sized `challenge`
 *  Command (bt-15, BT15.1) and never a run — a challenge without a size runs nothing. */
function sheetOutcome(step: ReturnType<typeof sheetStep>): WorldStep {
  const base = { sheet: step.state, request: null, result: 'consumed' } as const;
  if (step.run === undefined) return base;
  if (step.run.kind !== 'challenge') return { ...base, run: step.run };
  if (step.partySize === undefined) return base;
  return {
    ...base,
    command: {
      kind: 'challenge',
      targetIdentity: step.run.playerIdentity,
      partySize: step.partySize,
    },
  };
}

/** `sizes` (bt-15): the party sizes a Challenge confirm may offer, largest first; empty when there
 *  is nothing conscious to field, so a Challenge row runs nothing and opens no confirm. */
export function worldButton(
  sheet: SheetState | null,
  cands: readonly InteractCandidate[],
  btn: NavInput,
  n?: WorldNotices,
  sizes: readonly number[] = [],
): WorldStep {
  // Select is Help everywhere (uif-12, UIF12.3): over any world sheet it closes the sheet and falls
  // to the base, so Help opens over the bare world and never under the sheet. A held one does nothing.
  if (btn.button === 'Select' && (sheet !== null || n?.request != null)) {
    return btn.repeat
      ? { sheet, request: n?.request ?? null, result: 'consumed' }
      : { sheet: null, request: null, result: 'unhandled' };
  }
  // An open request sheet owns every button.
  if (n?.request != null) {
    const step = requestSheetStep(n.request, btn, n.pending);
    const base = { sheet: null, request: step.state, result: 'consumed' } as const;
    if (step.run === 'view') return { ...base, view: n.request.notice };
    // Answered: its banner goes too (main.ts also keeps the answered key out of `pending`, so a
    // second Y cannot answer again before the row changes).
    if (step.run !== undefined)
      return {
        ...base,
        command: requestCommand(n.request.notice, step.run),
        dismiss: n.request.notice.key,
      };
    return base;
  }
  // An open sheet owns every button.
  if (sheet !== null) return sheetOutcome(sheetStep(sheet, btn, cands, sizes));
  if (btn.repeat) return { sheet, request: null, result: 'unhandled' };
  if (btn.button === 'A') {
    const entries = pickerEntries(cands);
    const only = entries.length === 1 ? entries[0] : undefined;
    const opened = openSheet(entries);
    if (only !== undefined && opened !== null && only.action.kind === 'challenge') {
      // A lone Challenge opens straight into its pick; with nothing to field it does nothing.
      return sizes.length === 0
        ? { sheet, request: null, result: 'consumed' }
        : { sheet: askConfirm(opened, only.key, sizes), request: null, result: 'consumed' };
    }
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
