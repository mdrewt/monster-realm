// glyphs.ts — the keycap a player sees for a physical key (design §9, CTL12.5). Bindings are
// positional `e.code`s, but a keycap must name what the player's layout types: AZERTY's `KeyW`
// is a "Z". `glyph(code)` is synchronous: the character learned for that code from a real press
// (main.ts teaches every keydown; a capture view hands its press to `learnKey` too), else the
// catalog name of a named key, else a name derived from the code. `toUpperCase` is locale-blind,
// so a Turkish dotless i reads "I": cosmetic only. `navigator.keyboard.getLayoutMap()` is deferred (design §17).
import { t, tf } from '../ui/i18n/resolver';
import type { KeyCode } from './bindings';

/** The modifier bits of a press; a learned key comes from an unmodified one. */
export interface KeyMods {
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}

// One visible character: a letter, digit, punctuation mark or symbol. Spaces, controls, format
// and bidi marks, combining marks and lone surrogates would print a blank or reorder the text.
const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;

const learned = new Map<KeyCode, string>();

/** Record what an unmodified press of `code` typed. Only one printable character is kept (so
 *  `Enter`, `Dead` and `ß`, which uppercases to "SS", are not); numpad keys keep their own name,
 *  or `Numpad1` would read like `Digit1`. */
export function learnKey(code: KeyCode, key: string, mods: KeyMods = {}): void {
  // A synthetic `new Event('keydown')` (autofill, password managers) carries neither field.
  if (typeof code !== 'string' || typeof key !== 'string') return;
  if (mods.shiftKey === true || mods.ctrlKey === true || mods.altKey === true) return;
  if (mods.metaKey === true || code.startsWith('Numpad')) return;
  const upper = key.toUpperCase();
  if (PRINTABLE.test(upper)) learned.set(code, upper);
}

/** Forget every learned key (tests). */
export function resetLearnedKeys(): void {
  learned.clear();
}

// The named keys, each a thunk over a literal catalog id so the active locale is read per call.
const KEY_NAMES: Readonly<Record<KeyCode, () => string>> = {
  Enter: () => t('key.enter'),
  NumpadEnter: () => t('key.numpadEnter'),
  Backspace: () => t('key.backspace'),
  Space: () => t('key.space'),
  Escape: () => t('key.escape'),
  ArrowUp: () => t('key.arrowUp'),
  ArrowDown: () => t('key.arrowDown'),
  ArrowLeft: () => t('key.arrowLeft'),
  ArrowRight: () => t('key.arrowRight'),
  PageUp: () => t('key.pageUp'),
  PageDown: () => t('key.pageDown'),
  Slash: () => t('key.slash'),
};

const LETTER = /^Key([A-Z])$/;
const DIGIT = /^Digit([0-9])$/;
const NUMPAD_DIGIT = /^Numpad([0-9])$/;

/** The keycap for `code`. Never throws: any other code (`F9`, `CapsLock`) reads as itself. */
export function glyph(code: KeyCode): string {
  const known = learned.get(code);
  if (known !== undefined) return known;
  if (Object.hasOwn(KEY_NAMES, code)) return KEY_NAMES[code]();
  const numpad = NUMPAD_DIGIT.exec(code);
  if (numpad !== null) return tf('key.numpad', { key: numpad[1] });
  const derived = LETTER.exec(code) ?? DIGIT.exec(code);
  if (derived !== null) return derived[1];
  return code;
}
