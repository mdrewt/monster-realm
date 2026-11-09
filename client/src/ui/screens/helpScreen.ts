// ui/screens/helpScreen.ts — How to Play as a pure screen over the nav kit (uif-14, UIF14.1,
// UIF14.4-UIF14.5; uif-14b, UIF14B.1-UIF14B.2: A on the Introduction's Report a problem row returns
// the `reportProblem` command). No DOM, SDK, module state, clock or resolver. The content is `helpModel.ts`'s,
// bound into `helpView.ts` when the frame opens; this screen says which tab shows, where each tab's
// cursor is (the nav kit keeps one per tab) and which Encyclopedia entry's detail is open.
//
// The detail is a phase of the frame, not a stack frame: A on an entry opens it, B (or A on its Back
// row) closes it back to the same entry, and while it shows the tabs and the list underneath do not
// move. A click outside the detail presses B through the pointer source (uif-5), so it closes the
// same way.
import { ENTRY_KEYS, type EntryKey, HELP_TABS } from '../helpModel';
import {
  type ItemLayout,
  list,
  type NavLayout,
  type NavState,
  navInit,
  navStep,
  tabs,
} from '../nav';
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

export interface HelpState {
  readonly nav: NavState;
  /** The Encyclopedia entry whose detail shows, else null. */
  readonly detail: EntryKey | null;
}

export interface HelpPaint {
  readonly layout: NavLayout;
  readonly nav: NavState;
  readonly detail: EntryKey | null;
}

export interface HelpScreenView {
  paint(p: HelpPaint): void;
}

const TAB_LAYOUTS: Readonly<Record<(typeof HELP_TABS)[number], ItemLayout>> = {
  // The Introduction is prose, then one row: Report a problem (uif-14b), so the D-pad stays on it.
  intro: list([{ key: 'report', enabled: true }]),
  encyclopedia: list(ENTRY_KEYS.map((key) => ({ key, enabled: true }))),
};

export const HELP_LAYOUT: NavLayout = tabs(
  HELP_TABS.map((key) => ({ key, layout: TAB_LAYOUTS[key] })),
);

/** The detail's one row: Back. */
export const DETAIL_LAYOUT: NavLayout = list([{ key: 'back', enabled: true }]);

const isEntry = (key: string | null): key is EntryKey =>
  key !== null && (ENTRY_KEYS as readonly string[]).includes(key);

export const helpScreen: ScreenAdapter<null, HelpState, HelpScreenView> = {
  nav: true,

  viewModel: () => null,

  init: () => ({ nav: navInit(HELP_LAYOUT), detail: null }),

  onButton(_vm, state, btn): ButtonStep<HelpState> {
    const done = (result: ScreenResult, next: HelpState = state) => ({ state: next, result });
    switch (btn.button) {
      case 'Start':
        return done(btn.repeat ? 'consumed' : { kind: 'popToBase' });
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      case 'X':
      case 'Y':
        return done('unhandled');
      default:
        break;
    }
    if (state.detail !== null) {
      // B, or A on the Back row, closes the detail back to its entry; everything else waits.
      const closes = (btn.button === 'B' || btn.button === 'A') && !btn.repeat;
      return done('consumed', closes ? { nav: state.nav, detail: null } : state);
    }
    switch (btn.button) {
      case 'B':
        return done(btn.repeat ? 'consumed' : { kind: 'pop' });
      case 'A': {
        const item = state.nav.item;
        if (btn.repeat) return done('consumed');
        // Report a problem saves the bug bundle, as F9 does (uif-14b); the frame stays as it is.
        if (state.nav.tab === 'intro' && item === 'report') return done({ kind: 'reportProblem' });
        if (state.nav.tab !== 'encyclopedia' || !isEntry(item)) return done('consumed');
        return done('consumed', { nav: state.nav, detail: item });
      }
      default: {
        // LB / RB switch the tab; the D-pad moves the cursor (the Introduction's one item stays).
        const nav = navStep(HELP_LAYOUT, state.nav, btn).state;
        return done('consumed', nav === state.nav ? state : { nav, detail: null });
      }
    }
  },

  paint(view, _vm, state): void {
    view.paint({ layout: HELP_LAYOUT, nav: state.nav, detail: state.detail });
  },
};
