// ui/screens/battleScreen.ts — the battle base as a pure screen (design §5 Battle, CTL8I.1-3): the
// D-pad walks the command list and its sub-lists, A presses the cursor, B steps back to the command
// list. No DOM, SDK, module state or clock; the battle view applies what `paint` hands it.
//
// The battle is the stack's BASE, not a frame, so the host steps this adapter directly at a bare
// battle base (screens/index.ts). The views that implement `BattleOpsView` are the tactical shell
// and the deploy panel (bt-17 deleted the 1v1 view). The cursor lives in the view: its rows are
// re-rendered on every batch and the mouse and Tab move it too, so a press is a one-shot op TOKEN (a
// new object each press, the profileScreen precedent) and every step's state holds the new token or
// null, so a later paint never re-applies an old one. At a deploy CONFIRM screen Start never gets
// here in play: main.ts's `battleButton` opens the main menu first; the tactical shell (bt-11) and
// the deploy EDITOR leave Start to this adapter (End Turn / Guard / Submit). Y is the Clear plan
// gesture: a tap hints, a hold clears. `battleHoldButtons` is the stack-level rule that lists Y as
// hold-capable for the router, so its tap reaches this adapter at the release.
import type { VButton } from '../../input/buttons';
import type { CursorDir } from '../battleModel';
import { isBareBattle } from '../battlePolicy';
import type { Stack } from '../contextStack';
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

/** One press on the battle's lists. */
export type BattleOp =
  | { readonly kind: 'move'; readonly dir: CursorDir }
  | { readonly kind: 'activate' }
  | { readonly kind: 'back' }
  // bt-11 (BT11.6): the danger toggle (X), own-unit cycling (LB / RB) and Start (End Turn / Guard
  // live, Submit for a pre-queue).
  | { readonly kind: 'danger' }
  | { readonly kind: 'cycle'; readonly dir: -1 | 1 }
  | { readonly kind: 'start' }
  // Y: a tap asks for the "Hold Y" hint, a hold clears the selected unit's READY plan.
  | { readonly kind: 'holdHint' }
  | { readonly kind: 'clearPlan' };

/** What the battle view implements. */
export interface BattleOpsView {
  applyBattleOp(op: BattleOp): void;
}

export interface BattleScreenState {
  readonly op: BattleOp | null;
}

const CLEAR_PLAN_HOLD: ReadonlySet<VButton> = new Set<VButton>(['Y']);

/** The router's hold-capable buttons for `stack`: Y while the bare battle base is the top frame and
 *  its tactical shell can clear a plan with a hold (`clearPlanHoldable`); none otherwise. */
export function battleHoldButtons(
  stack: Stack,
  clearPlanHoldable: boolean,
): ReadonlySet<VButton> | undefined {
  return clearPlanHoldable && isBareBattle(stack) ? CLEAR_PLAN_HOLD : undefined;
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
      // answers Start first when no tactical view owns it (the main menu), so this op reaches only
      // the tactical shell and the deploy editor. Select toggles help, as at the bare base.
      case 'Start':
        return done('consumed', btn.repeat ? null : { kind: 'start' });
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      // Y: the router hands over a tap at its release and a hold once it has been held; the view
      // acts on either only while it offers Clear plan.
      case 'Y':
        if (btn.hold === true) return done('consumed', { kind: 'clearPlan' });
        return done('consumed', btn.repeat ? null : { kind: 'holdHint' });
      default:
        return btn.button satisfies never;
    }
  },

  paint(view, _vm, state): void {
    if (state.op !== null) view.applyBattleOp(state.op);
  },
};
