// shell/inputState — the live input devices: the binding table, the keyboard source built over
// it, the router, the held movement directions and the key codes whose OS repeats are cancelled.
// Every other module reads them through its import, which is live. Only this module assigns
// `bindings` and `keyboard` (`applyBindings`) and only its functions change `navHeldCodes`;
// `held` and `inputRouter` are used through their own methods. Module scope reads the saved
// table from storage and constructs the devices: it registers no listener and writes nothing.

import { browserStorage, loadBindings, saveBindings } from '../input/bindingStore';
import type { Bindings } from '../input/bindings';
import { KeyboardSource } from '../input/keyboardSource';
import { InputRouter } from '../input/router';
import { HeldDirections } from '../prediction/heldKeys';

// The ONE binding table every input path and keycap reads: the player's saved table, else the
// defaults (CTL12.4). Read at import; Controls replaces it live (`applyBindings`).
export let bindings = loadBindings(browserStorage());

// Held movement keys (most-recently-pressed stack) — drives the frame-loop
// continuation re-issue so a held key keeps walking.
export const held = new HeldDirections();

// The input pipeline (design §12): the keyboard source maps keys through the ONE binding
// table into `{button, down}` edges; the pure router decides what each edge does. The router
// owns the D-pad and X (Jump), plus A, B and Y while the main menu is up, and hands every other
// button (and a nav-capable screen's D-pad) to the top frame's adapter. It also decides each
// accelerator (`accelDecision`).
export let keyboard = new KeyboardSource(bindings);
export const inputRouter = new InputRouter();

// Codes whose press the menu or a nav-capable screen consumed: their OS key-repeats are cancelled
// until the keyup, so a held Enter that opened a child cannot activate the child's focused button.
const navHeld = new Set<string>();
export const navHeldCodes: ReadonlySet<string> = navHeld;

/** A press of `code` was consumed: its OS key-repeats are cancelled until it is released. */
export function noteNavHeld(code: string): void {
  navHeld.add(code);
}

/** The key `code` was released: its next press is a fresh one. */
export function releaseNavHeld(code: string): void {
  navHeld.delete(code);
}

// Drop every held button so nothing stays "held" while the page cannot see the keyup.
export const releaseAllInput = (): void => {
  keyboard.releaseAll();
  inputRouter.releaseAll();
  navHeld.clear();
  held.clear();
};

// A remap applies at once (CTL12B.2): saved, then every input path reads the new table. The
// keyboard source takes its table at construction, so it is replaced; whatever was held is
// released first, or its keyup (unknown to the new source) would leave a button stuck. False when
// the table could not be saved: it still applies, until the page reloads.
export const applyBindings = (next: Bindings): boolean => {
  const saved = saveBindings(browserStorage(), next);
  releaseAllInput();
  bindings = next;
  keyboard = new KeyboardSource(next);
  return saved;
};
