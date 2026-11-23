// ui/screens/optionsScreen.ts — Options › Controls as a pure screen over the nav kit (design §9,
// CTL12B.1). No DOM, SDK, module state or clock; `controlsView.ts` paints what `paint` hands it.
// The rules of a remap (swap, protected buttons, Clear) are `controlsModel.ts`'s: this file only
// says which cell does what.
//
// Two binding tabs, each a grid whose rows are the model's rows: Buttons has a Primary, an Alt and
// a Pad cell per button, Shortcuts adds a Clear cell per accelerator, and each ends with a lone Reset
// all (in the first column, so the D-pad reaches it from that column). The F8 and F9 rows have no
// pad binding: their Pad cell is a disabled placeholder, so every row keeps the same columns. A on a
// slot or a Pad cell starts its capture; A on Clear or on the confirm's Yes hands the view a one-shot
// request token (a new object each press, compared by identity: the profileScreen precedent), which
// the shell applies to the table.
//
// The third tab, Display (uif-13), is a screen-layer list of the text-size steps (`controlsModel`
// knows only binding rows): A on a step hands the view a `textStep` token the same way. It has no
// Reset all, which resets bindings only.
//
// While a slot waits for a key the shell takes every keydown before the router (`captureStep`
// below says what that key does); while a Pad cell waits it takes every pad press instead
// (`padCaptureStep`). So the only button that reaches this screen then is the B the shell sends to
// end the capture, or a pointer's.
import type { Bindings } from '../../input/bindings';
import { ACCELS, type Accel, VBUTTONS } from '../../input/buttons';
import type { PadBindings, PadIndex } from '../../input/padBindings';
import { confirmLayout } from '../actionSheetModel';
import {
  type CapturedKey,
  type CaptureTarget,
  type ControlsRow,
  type ControlsTab,
  captureKey,
  capturePad,
  outcomeText,
  type PadCaptureOutcome,
  type PadTarget,
  padOutcomeText,
  padRow,
  type SlotTarget,
} from '../controlsModel';
import { TEXT_STEPS, type TextStep } from '../displayPrefs';
import {
  grid,
  list,
  type NavLayout,
  type NavState,
  navFocus,
  navInit,
  navStep,
  tabs,
} from '../nav';
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

/** What a press asks the shell to do to the table. */
export type ControlsRequest =
  | { readonly kind: 'clear'; readonly accel: Accel }
  | { readonly kind: 'reset' }
  | { readonly kind: 'textStep'; readonly step: TextStep };

/** The screen's tabs: the model's binding tabs, then Display. */
export type ControlsScreenTab = ControlsTab | 'display';

export interface ControlsState {
  readonly nav: NavState;
  /** The slot or Pad cell waiting for a press, else null. */
  readonly capturing: CaptureTarget | null;
  /** The Reset all confirm's cursor over `confirmLayout`, else null. */
  readonly confirm: NavState | null;
  /** This step's request, else null: it lives for one step. */
  readonly request: ControlsRequest | null;
}

export interface ControlsPaint extends ControlsState {
  readonly layout: NavLayout;
}

export interface ControlsScreenView {
  paint(p: ControlsPaint): void;
}

/** What a cell of the layout is. */
export type ControlsItem =
  | { readonly kind: 'slot'; readonly target: SlotTarget | PadTarget }
  /** The Pad cell of a row with no pad binding (F8, F9): disabled, it does nothing. */
  | { readonly kind: 'noPad'; readonly row: ControlsRow }
  | { readonly kind: 'clear'; readonly accel: Accel }
  | { readonly kind: 'reset' }
  | { readonly kind: 'textStep'; readonly step: TextStep };

type ItemEntry = readonly [string, ControlsItem];

/** A row's Primary, Alt and Pad cells. */
function slotEntries(row: ControlsRow): ItemEntry[] {
  const pad = padRow(row);
  return [
    [`${row.id}_0`, { kind: 'slot', target: { row, slot: 0 } }],
    [`${row.id}_1`, { kind: 'slot', target: { row, slot: 1 } }],
    [
      `${row.id}_pad`,
      pad === undefined ? { kind: 'noPad', row } : { kind: 'slot', target: { row: pad, slot: 'pad' } },
    ],
  ];
}
const RESET: ItemEntry = ['reset', { kind: 'reset' }];

/** Each tab's cells by key, in display order: the layout and the decode are built from it. */
const ITEMS: Readonly<Record<ControlsScreenTab, ReadonlyMap<string, ControlsItem>>> = {
  buttons: new Map([...VBUTTONS.flatMap((id) => slotEntries({ kind: 'button', id })), RESET]),
  shortcuts: new Map([
    ...ACCELS.flatMap((id): ItemEntry[] => [
      ...slotEntries({ kind: 'accel', id }),
      [`${id}_clear`, { kind: 'clear', accel: id }],
    ]),
    RESET,
  ]),
  display: new Map(TEXT_STEPS.map((step): ItemEntry => [step, { kind: 'textStep', step }])),
};

// Every cell is enabled but a placeholder.
const itemsOf = (tab: ControlsScreenTab) =>
  [...ITEMS[tab]].map(([key, item]) => ({ key, enabled: item.kind !== 'noPad' }));

const tabGrid = (tab: ControlsTab, cols: number) => grid(itemsOf(tab), cols);

export const CONTROLS_LAYOUT: NavLayout = tabs([
  { key: 'buttons', layout: tabGrid('buttons', 3) },
  { key: 'shortcuts', layout: tabGrid('shortcuts', 4) },
  { key: 'display', layout: list(itemsOf('display')) },
]);

/** The cell `key` of `tab`, or undefined when the layout has none. */
export function controlsItem(tab: string | null, key: string): ControlsItem | undefined {
  return tab !== null && Object.hasOwn(ITEMS, tab)
    ? ITEMS[tab as ControlsScreenTab].get(key)
    : undefined;
}

/** What a captured press does, for a table `T` (the shell applies it). */
export interface CaptureResult<T> {
  /** The capture is over (bound, swapped or cancelled); a refusal keeps waiting. */
  readonly done: boolean;
  /** The table to save and apply, when the press changed it. */
  readonly bindings: T | undefined;
  /** The feedback line. */
  readonly text: string;
}

export interface CaptureStep extends CaptureResult<Bindings> {
  /** False for a reserved press: Tab, F5 and the browser's chords stay the browser's. */
  readonly prevent: boolean;
}

/** What a key pressed while `target` waits for one does (the shell applies it). */
export function captureStep(b: Bindings, target: SlotTarget, key: CapturedKey): CaptureStep {
  const outcome = captureKey(b, target, key);
  const text = outcomeText(outcome);
  switch (outcome.kind) {
    case 'bound':
    case 'swapped':
      return { done: true, bindings: outcome.bindings, text, prevent: true };
    case 'cancelled':
      return { done: true, bindings: undefined, text, prevent: true };
    case 'refused':
      return { done: false, bindings: undefined, text, prevent: outcome.reason !== 'reserved' };
  }
}

/** What a pad press read while the Pad cell `target` waits does (the shell applies it):
 *  `'refused'` is a press the pad source could not bind (Home / Guide, an index past the range). */
export function padCaptureStep(
  pad: PadBindings,
  target: PadTarget,
  read: PadIndex | 'refused',
): CaptureResult<PadBindings> {
  const outcome: PadCaptureOutcome =
    read === 'refused' ? { kind: 'refused', reason: 'reserved' } : capturePad(pad, target, read);
  const text = padOutcomeText(outcome);
  switch (outcome.kind) {
    case 'bound':
    case 'swapped':
      return { done: true, bindings: outcome.bindings, text };
    case 'cancelled':
      return { done: true, bindings: undefined, text };
    case 'refused':
      return { done: false, bindings: undefined, text };
  }
}

export const controlsScreen: ScreenAdapter<null, ControlsState, ControlsScreenView> = {
  nav: true,

  // The view reads the live table itself: a remap repaints with no state of this screen changing.
  viewModel: () => null,

  init: () => ({ nav: navInit(CONTROLS_LAYOUT), capturing: null, confirm: null, request: null }),

  onButton(_vm, state, btn): ButtonStep<ControlsState> {
    const base = state.request === null ? state : { ...state, request: null };
    const done = (result: ScreenResult, next: ControlsState = base) => ({ state: next, result });
    if (btn.button === 'Start') return done(btn.repeat ? 'consumed' : { kind: 'popToBase' });

    if (base.capturing !== null) {
      return btn.button === 'B' && !btn.repeat
        ? done('consumed', { ...base, capturing: null })
        : done('consumed');
    }

    if (base.confirm !== null) {
      if (btn.button === 'B')
        return done('consumed', btn.repeat ? base : { ...base, confirm: null });
      if (btn.button !== 'Up' && btn.button !== 'Down' && btn.button !== 'A') {
        return done('consumed');
      }
      const step = navStep(confirmLayout, base.confirm, btn);
      if (step.outcome.kind !== 'activate')
        return done('consumed', { ...base, confirm: step.state });
      const request: ControlsRequest | null = step.outcome.key === 'yes' ? { kind: 'reset' } : null;
      return done('consumed', { ...base, confirm: null, request });
    }

    switch (btn.button) {
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      case 'B':
        return done(btn.repeat ? 'consumed' : { kind: 'pop' });
      case 'X':
      case 'Y':
        return done('unhandled');
      default:
        break;
    }
    const step = navStep(CONTROLS_LAYOUT, base.nav, btn);
    if (step.outcome.kind !== 'activate') return done('consumed', { ...base, nav: step.state });
    const item = controlsItem(step.outcome.tab, step.outcome.key);
    switch (item?.kind) {
      case 'slot':
        return done('consumed', { ...base, capturing: item.target });
      case 'noPad':
        return done('consumed');
      case 'clear':
        return done('consumed', { ...base, request: { kind: 'clear', accel: item.accel } });
      case 'textStep':
        return done('consumed', { ...base, request: { kind: 'textStep', step: item.step } });
      case 'reset':
        // The confirm defaults to No (`navInit` alone lands on Yes, the list's first row).
        return done('consumed', {
          ...base,
          confirm: navFocus(confirmLayout, navInit(confirmLayout), { item: 'no' }),
        });
      case undefined:
        return done('consumed');
    }
  },

  paint(view, _vm, state): void {
    view.paint({ layout: CONTROLS_LAYOUT, ...state });
  },
};
