// ui/screens/profileScreen.ts — the Profile children as pure screens (design §5 row 5, CTL8H.2-4):
// Name (the rename frame), Account (the claim frame) and Privacy & data (the privacy frame). No DOM,
// SDK, module state or clock; the three views apply what `paint` hands them.
//
// The rows are each view's REAL controls and the cursor IS DOM focus, so the mouse, Tab, a native
// Enter or Space on a button and the D-pad all move and press the same thing, and no control is
// drawn twice. Which controls show is the claim and privacy models' (held by main.ts, out of the
// screen's reach), so an adapter keeps no cursor: a press becomes a one-shot row TOKEN (a new object
// each press, compared by identity: the tradeProposeScreen precedent) that the view applies once.
// Every step's state holds the new token or null, so the host's paint after a later button never
// re-applies an old one. B pops the frame, which never confirms anything: privacy disarms on close;
// a claim decline stays armed (claimModel cannot represent a dismissal), but a re-shown armed frame
// seats No on the first press and presses nothing.
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

/** One press on the rows: move the focus up or down, or press the focused row. */
export type RowOp =
  | { readonly kind: 'move'; readonly delta: -1 | 1 }
  | { readonly kind: 'activate' };

/** What the three views implement. */
export interface RowsView {
  applyRowOp(op: RowOp): void;
}

export interface RowsState {
  readonly op: RowOp | null;
}

/** Where a token lands on `rows` (the shown, enabled controls, in order). With no row focused it
 *  only seats `fallback`, whatever the token: an A must never press a row the player cannot see
 *  having chosen (an armed decline re-shown with focus on the page). A move clamps, never wraps. */
export function rowStep<T>(
  rows: readonly T[],
  focused: unknown,
  fallback: T | undefined,
  op: RowOp,
): { readonly focus?: T; readonly press?: T } {
  const at = rows.indexOf(focused as T);
  if (at < 0) return { focus: fallback };
  if (op.kind === 'activate') return { press: rows[at] };
  return { focus: rows[Math.min(rows.length - 1, Math.max(0, at + op.delta))] };
}

/** Where a render of an OPEN frame with a two-step confirm moves focus (CTL8H.3-4; confirms
 *  default to No): arming seats `no`, disarming seats the `armer` while it is still a row (after a
 *  Confirm it is not, and nothing is seated: the first row is Join, which a second Enter would
 *  press), and a focused control the render hid or disabled seats the default row (the render runs
 *  before the browser's own blur, so it still sees that control). `focused` is the focused control
 *  inside the frame, or null for the page. Anything else (a plain re-render) moves nothing, so a
 *  player who chose Confirm keeps it. */
export function reseatRow<T>(
  rows: readonly T[],
  focused: T | null,
  armed: { readonly was: boolean; readonly now: boolean },
  no: T,
  armer: T,
): T | undefined {
  if (armed.now && !armed.was) return no;
  if (armed.was && !armed.now) return rows.includes(armer) ? armer : undefined;
  if (focused !== null && !rows.includes(focused)) return armed.now ? no : rows[0];
  return undefined;
}

const rowsScreen = (): ScreenAdapter<null, RowsState, RowsView> => ({
  nav: true,

  viewModel: () => null,

  init: () => ({ op: null }),

  onButton(_vm, _state, btn): ButtonStep<RowsState> {
    const done = (result: ScreenResult, op: RowOp | null = null) => ({ state: { op }, result });
    switch (btn.button) {
      case 'Start':
        return done(btn.repeat ? 'consumed' : { kind: 'popToBase' });
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      case 'B':
        return done(btn.repeat ? 'consumed' : { kind: 'pop' });
      // A held arrow walks the rows; it never presses one.
      case 'Up':
        return done('consumed', { kind: 'move', delta: -1 });
      case 'Down':
        return done('consumed', { kind: 'move', delta: 1 });
      case 'A':
        return done('consumed', btn.repeat ? null : { kind: 'activate' });
      case 'Left':
      case 'Right':
        return done('consumed');
      default:
        return done('unhandled');
    }
  },

  paint(view, _vm, state): void {
    if (state.op !== null) view.applyRowOp(state.op);
  },
});

/** Profile › Name: rows [the name field, Save]; it opens typing (overlayA11y focuses the field). */
export const nameScreen = rowsScreen();
/** Profile › Account: the claim frame's shown actions, then the privacy door. */
export const accountScreen = rowsScreen();
/** Profile › Privacy & data: the privacy frame's shown, enabled buttons. */
export const privacyScreen = rowsScreen();
