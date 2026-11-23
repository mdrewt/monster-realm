// padBindings.ts — the pad's binding table: `Gamepad.buttons` indices (the W3C standard mapping)
// to virtual buttons and menu accelerators. It mirrors the keyboard table in `bindings.ts`, keyed by
// button index instead of `KeyboardEvent.code`. The left stick is not a binding: it always drives
// the D-pad (`stick.ts`).
import { VBUTTONS, type VButton } from './buttons';
import type { MenuAccel } from './router';

/** A `Gamepad.buttons` index. */
export type PadIndex = number;

export interface PadBindings {
  readonly buttons: Readonly<Record<VButton, readonly PadIndex[]>>;
  readonly accels: Readonly<Record<MenuAccel, readonly PadIndex[]>>;
}

const indices = (...list: PadIndex[]): readonly PadIndex[] => Object.freeze(list);

/** The default pad table over the standard mapping: face buttons A 0, B 1, X 2, Y 3; bumpers 4, 5;
 *  Select 8, Start 9; the D-pad 12–15. LT (6) opens Party and RT (7) the Bag; the stick clicks
 *  (10, 11) are unbound. */
export const PAD_DEFAULT_BINDINGS: PadBindings = Object.freeze({
  buttons: Object.freeze({
    Up: indices(12),
    Down: indices(13),
    Left: indices(14),
    Right: indices(15),
    A: indices(0),
    B: indices(1),
    X: indices(2),
    Y: indices(3),
    LB: indices(4),
    RB: indices(5),
    Start: indices(9),
    Select: indices(8),
  }),
  accels: Object.freeze({
    B: indices(),
    I: indices(7),
    V: indices(6),
    J: indices(),
    U: indices(),
    P: indices(),
    L: indices(),
    N: indices(),
    C: indices(),
    Y: indices(),
  } satisfies PadBindings['accels']),
});

/** Indices the OS owns (16 is Home / Guide); no binding may claim them. */
export const RESERVED_PAD_INDICES: readonly PadIndex[] = indices(16);

/** The highest button index a binding may name. */
const MAX_PAD_INDEX = 31;

/** Whether `i` may be bound: an integer button index 0–31 the OS does not own. */
export function isBindablePadIndex(i: unknown): i is PadIndex {
  return (
    typeof i === 'number' &&
    Number.isInteger(i) &&
    i >= 0 &&
    i <= MAX_PAD_INDEX &&
    !RESERVED_PAD_INDICES.includes(i)
  );
}

/** Every menu accelerator, in the default table's order (its `accels` literal is checked to hold
 *  exactly the `MenuAccel` keys): the accelerators a pad can bind. */
export const MENU_ACCELS: readonly MenuAccel[] = Object.freeze(
  Object.keys(PAD_DEFAULT_BINDINGS.accels) as MenuAccel[],
);

/** The virtual button index `i` is bound to, or undefined when it is unbound (or an accelerator). */
export function padButtonFor(b: PadBindings, i: PadIndex): VButton | undefined {
  return VBUTTONS.find((button) => b.buttons[button].includes(i));
}

/** The menu accelerator index `i` is bound to, or undefined when it is unbound (or a button). */
export function padAccelFor(b: PadBindings, i: PadIndex): MenuAccel | undefined {
  return MENU_ACCELS.find((accel) => b.accels[accel].includes(i));
}
