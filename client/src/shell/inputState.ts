// shell/inputState — the live input devices: the keyboard and pad binding tables, the keyboard
// source built over the one, the pad source built over the other, the router, the held movement
// directions, the key codes whose OS repeats are cancelled and the source of the last press, which
// the keycaps follow. Every other module reads them through its import, which is live. Only this
// module assigns `bindings`, `keyboard` and `padBindings` (`applyTables`, behind every
// function that changes a table) and `lastSource` (`noteInputSource`); only its functions change
// `navHeldCodes`; `held`, `pad` and `inputRouter` are used through their own methods. Module scope
// reads the saved tables from storage and constructs the devices: it registers no listener, writes
// nothing and reads no Gamepad API (the pad source reads it at each poll).

import { browserStorage, loadBindings, loadPadBindings, saveBindings } from '../input/bindingStore';
import { type Bindings, DEFAULT_BINDINGS } from '../input/bindings';
import type { VButton } from '../input/buttons';
import { GamepadSource } from '../input/gamepadSource';
import { KeyboardSource } from '../input/keyboardSource';
import { PAD_DEFAULT_BINDINGS, type PadBindings } from '../input/padBindings';
import { type InputSource, keycapFor } from '../input/padGlyphs';
import { InputRouter } from '../input/router';
import { HeldDirections } from '../prediction/heldKeys';

// The ONE binding table every input path and keycap reads: the player's saved table, else the
// defaults (CTL12.4). Read at import; Controls replaces it live (`applyTables`).
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

// Where a fault of the Gamepad API goes: the console until `main.ts` installs the error ring's
// reporter (`installPadFaultSink`, at its module scope). This module imports no shell module.
let padFault: (err: unknown) => void = (err) => console.error('[pad]', err);

/** The Gamepad API's first fault (the pad source reports no other) goes to `sink`. */
export function installPadFaultSink(sink: (err: unknown) => void): void {
  padFault = sink;
}

// The ONE pad table the pad source and the keycaps both read: the player's saved pad table, else
// the defaults, from the same record as `bindings`. Controls replaces it live (`applyTables`).
export let padBindings: PadBindings = loadPadBindings(browserStorage());

// The pad source: every connected pad through the pad table into the same
// `{button, down}` edges, polled once per animation frame by `main.ts`. `navigator.getGamepads` is
// looked up at each poll: a browser without it reads as no pads, and one that throws reads as no
// pads and reaches the fault sink once.
export const pad = new GamepadSource(() => navigator.getGamepads?.() ?? [], padBindings, {
  onError: (err) => padFault(err),
});

// The device of the last press: a keydown notes 'keys', a pad press 'pad'; a pointer press notes
// nothing. Every keycap the player sees is drawn from it.
export let lastSource: InputSource = 'keys';

/** The player's last press came from `source`. */
export function noteInputSource(source: InputSource): void {
  lastSource = source;
}

/** The live keycap of `button`: the glyph of its first binding in the last-used source's table
 *  (the keyboard table, or the pad table the pad source reads), '' when it has none there. */
export const keycap = (button: VButton): string =>
  keycapFor(lastSource, bindings, padBindings)(button);

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

// Drop every held button so nothing stays "held" while the page cannot see the keyup. The pad is
// read once first, so a button pressed since the last frame's poll is latched too: every pad button
// and stick direction held now acts again only once released and pressed again.
export const releaseAllInput = (): void => {
  keyboard.releaseAll();
  pad.poll();
  pad.releaseAll();
  inputRouter.releaseAll();
  navHeld.clear();
  held.clear();
};

// A remap or a Clear applies at once (CTL12B.2): both tables saved in one record, then every input
// path reads the new tables. The keyboard source takes its table at construction, so it is replaced;
// whatever was held is released first, or its keyup (unknown to the new source) would leave a button
// stuck. The pad source is rebound, which latches every pad button held now: it acts only once
// released and pressed again. False when the tables could not be saved: they still apply, until the
// page reloads.
export const applyTables = (keys: Bindings, padTable: PadBindings): boolean => {
  const saved = saveBindings(browserStorage(), keys, padTable);
  releaseAllInput();
  bindings = keys;
  keyboard = new KeyboardSource(keys);
  padBindings = padTable;
  pad.rebind(padTable);
  return saved;
};

/** Apply and save a keyboard table; the live pad table is saved beside it. */
export const applyBindings = (next: Bindings): boolean => applyTables(next, padBindings);

/** Apply and save a pad table; the live keyboard table is saved beside it. */
export const applyPadBindings = (next: PadBindings): boolean => applyTables(bindings, next);

/** Reset all: both default tables, applied and saved together. */
export const resetAllBindings = (): boolean => applyTables(DEFAULT_BINDINGS, PAD_DEFAULT_BINDINGS);
