// ui/screens/types.ts — the shapes a screen adapter shares with the shell (design §4). A screen is
// a pure reducer over its own state: one input in, the next state and one effect out. ctl-6b grows
// this into the adapter seam; until then the main menu is the only screen.

/** The result of one screen step: the next state and the effect the shell applies. */
export interface ScreenStep<S, E> {
  readonly state: S;
  readonly effect: E;
}
