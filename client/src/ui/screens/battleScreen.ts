// ui/screens/battleScreen.ts — the battle base as a pure screen (design §5 Battle, CTL8I.1-3): the
// D-pad walks the command list and its sub-lists, A presses the cursor, B steps back to the command
// list. No DOM, SDK, module state or clock; the battle view applies what `paint` hands it.
//
// The battle is the stack's BASE, not a frame, so the host steps this adapter directly at a bare
// battle base (screens/index.ts) and the outcome frame keeps the legacy adapter. The cursor lives
// in the view: its rows are re-rendered on every batch and the mouse and Tab move it too, so a press
// is a one-shot op TOKEN (a new object each press, the profileScreen precedent) and every step's
// state holds the new token or null, so a later paint never re-applies an old one. Start never gets
// here in play: main.ts's `battleButton` opens the main menu over a bare battle first.
import type { CursorDir } from '../battleModel';
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

/** One press on the battle's lists. */
export type BattleOp =
  | { readonly kind: 'move'; readonly dir: CursorDir }
  | { readonly kind: 'activate' }
  | { readonly kind: 'back' };

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
      // As at the bare base (baseButton): Start does nothing here, Select toggles help.
      case 'Start':
        return done('consumed');
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      default:
        return done('unhandled');
    }
  },

  paint(view, _vm, state): void {
    if (state.op !== null) view.applyBattleOp(state.op);
  },
};
