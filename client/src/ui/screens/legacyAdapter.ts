// ui/screens/legacyAdapter.ts — the adapter the legacy DOM-button frames keep for good
// (design §4, CTL6B.1). The ctl-8 screen program is complete: the battle outcome frame
// (battleView), the evolution frame and the menu frame stay on this adapter permanently —
// no further slice swaps in its own. The tradeView, pvpView and leaderboardView rows in
// SCREEN_ADAPTERS also hold it, but only as Record-totality placeholders: those overlays
// show as the one `social` frame (ctl-8s), so their entries are never asked.
// The legacy shells drive themselves through their own buttons, so A is left to native
// activation (Enter on the focused control); B goes back one frame, Start closes every frame
// above the base and Select toggles Help. It keeps no state (the one it is handed passes
// through) and takes no D-pad. Pure.
import type { VButton } from '../../input/buttons';
import type { ScreenAdapter, ScreenResult } from './types';

const LEGACY: Readonly<Partial<Record<VButton, ScreenResult>>> = {
  B: { kind: 'pop' },
  Start: { kind: 'popToBase' },
  Select: { kind: 'toggleHelp' },
};

export const legacyAdapter: ScreenAdapter<undefined, undefined> = {
  viewModel: () => undefined,
  init: () => undefined,
  onButton(_vm, state, btn) {
    const result = LEGACY[btn.button];
    if (result === undefined) return { state, result: 'unhandled' };
    // A held key acts once: its repeat is swallowed, never a second pop.
    return { state, result: btn.repeat ? 'consumed' : result };
  },
};
