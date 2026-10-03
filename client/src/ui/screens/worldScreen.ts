// ui/screens/worldScreen.ts — what A and Y do at the world base (ctl-10a). Pure. The candidates
// are the wasm rule's answer (ui/interactModel.ts); this decides only what a press does with them.
// Counting is over ACTIONABLE rows, so ctl-10b's player actions add rows without changing the rule:
// none → the press is not ours (no toast); one → it runs; several → the picker opens.
import {
  openSheet,
  pickerEntries,
  type SheetState,
  sheetEntries,
  sheetStep,
} from '../actionSheetModel';
import type { InteractAction, InteractCandidate } from '../interactModel';
import type { NavInput } from '../nav';

export function worldButton(
  sheet: SheetState | null,
  cands: readonly InteractCandidate[],
  btn: NavInput,
): {
  readonly sheet: SheetState | null;
  readonly result: 'consumed' | 'unhandled';
  readonly run?: InteractAction;
} {
  // An open sheet owns every button.
  if (sheet !== null) {
    const step = sheetStep(sheet, btn, cands);
    return step.run === undefined
      ? { sheet: step.state, result: 'consumed' }
      : { sheet: step.state, result: 'consumed', run: step.run };
  }
  if (btn.repeat) return { sheet, result: 'unhandled' };
  if (btn.button === 'A') {
    const entries = pickerEntries(cands);
    const only = entries.length === 1 ? entries[0] : undefined;
    if (only !== undefined) return { sheet, result: 'consumed', run: only.action };
    const opened = openSheet(entries);
    return opened === null ? { sheet, result: 'unhandled' } : { sheet: opened, result: 'consumed' };
  }
  if (btn.button === 'Y') {
    const primary = cands[0];
    const opened = primary === undefined ? null : openSheet(sheetEntries(primary));
    return opened === null ? { sheet, result: 'unhandled' } : { sheet: opened, result: 'consumed' };
  }
  return { sheet, result: 'unhandled' };
}
