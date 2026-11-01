// ui/screens/battleScreen.ts — the battle base as a pure screen (design §5 Battle, CTL8I.1-3): the
// D-pad walks the command list and its sub-lists, A presses the cursor, B steps back to the command
// list. No DOM, SDK, module state or clock; the battle view applies what `paint` hands it.
//
// The battle is the stack's BASE, not a frame, so the host steps this adapter directly at a bare
// battle base (screens/index.ts) and the outcome frame keeps the legacy adapter. The cursor lives
// in the view: its rows are re-rendered on every batch and the mouse and Tab move it too, so a press
// is a one-shot op TOKEN (a new object each press, the profileScreen precedent) and every step's
// state holds the new token or null, so a later paint never re-applies an old one. At a LEGACY
// battle Start never gets here in play: main.ts's `battleButton` opens the main menu first; the
// tactical shell (bt-11) leaves Start to this adapter (End Turn / Guard / Submit).
import type { CursorDir } from '../battleModel';
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

/** One press on the battle's lists. */
export type BattleOp =
  | { readonly kind: 'move'; readonly dir: CursorDir }
  | { readonly kind: 'activate' }
  | { readonly kind: 'back' }
  // bt-11 (BT11.6): the danger toggle (X), own-unit cycling (LB / RB) and Start (End Turn / Guard
  // live, Submit for a pre-queue). The legacy BattleView ignores them (its switch has no default arm).
  | { readonly kind: 'danger' }
  | { readonly kind: 'cycle'; readonly dir: -1 | 1 }
  | { readonly kind: 'start' };

/** What the battle view implements. */
export interface BattleOpsView {
  applyBattleOp(op: BattleOp): void;
}

export interface BattleScreenState {
  readonly op: BattleOp | null;
}

export const battleScreen: ScreenAdapter<null, BattleScreenState, BattleOpsView> = {
  nav: true,

  viewModel: () => null,

  init: () => ({ op: null }),

  onButton(_vm, _state, btn): ButtonStep<BattleScreenState> {
    const done = (result: ScreenResult, op: BattleOp | null = null) => ({ state: { op }, result });
    switch (btn.button) {
      // A held arrow walks the lists; it never presses or backs out.
      case 'Up':
      case 'Down':
      case 'Left':
      case 'Right':
        return done('consumed', { kind: 'move', dir: btn.button });
      case 'A':
        return done('consumed', btn.repeat ? null : { kind: 'activate' });
      case 'B':
        return done('consumed', btn.repeat ? null : { kind: 'back' });
      // bt-11 (BT11.6): X toggles the danger overlay, LB / RB cycle the player's units. (The
      // input router still swallows X before any screen is asked — R-bt-11-ROUTERX; the dock's
      // Danger button is the working pointer path until it routes X here.)
      case 'X':
        return done('consumed', btn.repeat ? null : { kind: 'danger' });
      case 'LB':
        return done('consumed', btn.repeat ? null : { kind: 'cycle', dir: -1 });
      case 'RB':
        return done('consumed', btn.repeat ? null : { kind: 'cycle', dir: 1 });
      // Start: End Turn / Guard on a live turn, Submit for a pre-queue. main.ts's `battleButton`
      // answers Start first at a LEGACY battle (the main menu), so this op reaches only the
      // tactical shell. Select toggles help, as at the bare base.
      case 'Start':
        return done('consumed', btn.repeat ? null : { kind: 'start' });
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      // Y stays the page's (the design's Hold-Y gesture is the confirmed Clear plan row).
      default:
        return done('unhandled');
    }
  },

  paint(view, _vm, state): void {
    if (state.op !== null) view.applyBattleOp(state.op);
  },
};
