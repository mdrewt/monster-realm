// bindings.ts — the ONE binding table from physical keys to virtual buttons and accelerators
// (design §3). Keys match on `KeyboardEvent.code`, which is positional: case and Shift never
// change it, so the table needs no per-case or per-layout rows.
import { type Accel, VBUTTONS, type VButton } from './buttons';

/** A `KeyboardEvent.code` value (the physical key, not the character it types). */
export type KeyCode = string;

export interface Bindings {
  readonly buttons: Readonly<Record<VButton, readonly KeyCode[]>>;
  readonly accels: Readonly<Record<Accel, readonly KeyCode[]>>;
}

const codes = (...list: KeyCode[]): readonly KeyCode[] => Object.freeze(list);

/** The default keymap. Each list is primary first, then aliases; a code appears once. */
export const DEFAULT_BINDINGS: Bindings = Object.freeze({
  buttons: Object.freeze({
    Up: codes('KeyW', 'ArrowUp'),
    Down: codes('KeyS', 'ArrowDown'),
    Left: codes('KeyA', 'ArrowLeft'),
    Right: codes('KeyD', 'ArrowRight'),
    A: codes('Enter', 'NumpadEnter'),
    B: codes('Backspace'),
    X: codes('Space'),
    Y: codes('KeyF'),
    LB: codes('KeyQ', 'PageUp'),
    RB: codes('KeyE', 'PageDown'),
    Start: codes('Escape', 'KeyM'),
    Select: codes('KeyR', 'Slash'),
  }),
  accels: Object.freeze({
    B: codes('KeyB'),
    I: codes('KeyI'),
    V: codes('KeyV'),
    J: codes('KeyJ'),
    U: codes('KeyU'),
    P: codes('KeyP'),
    L: codes('KeyL'),
    N: codes('KeyN'),
    C: codes('KeyC'),
    F9: codes('F9'),
    F8: codes('F8'),
  }),
});

/** Keys the browser or OS owns; no binding may ever claim them (design §3). */
export const RESERVED_CODES: readonly KeyCode[] = codes(
  'Tab',
  'F5',
  'F11',
  'F12',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
);

/** The virtual button `code` is bound to, or undefined when it is unbound (or an accelerator). */
export function buttonForCode(b: Bindings, code: KeyCode): VButton | undefined {
  return VBUTTONS.find((button) => b.buttons[button].includes(code));
}
