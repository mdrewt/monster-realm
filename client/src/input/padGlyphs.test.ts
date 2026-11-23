// input/padGlyphs.test.ts — the pad glyph of a `Gamepad.buttons` index and the keycap chooser.
// `padGlyph` names an index by its Xbox label (the face buttons, bumpers, triggers and stick clicks
// literally in every locale; View, Menu and the D-pad from the catalog, so they follow the locale),
// and any other index by the localized generic button name. `keycapFor` picks the keycap of a virtual
// button from the keyboard table or the pad table, the first bound entry of each, empty when unbound.
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, tf } from '../ui/i18n/resolver';
import { type Bindings, DEFAULT_BINDINGS } from './bindings';
import { VBUTTONS } from './buttons';
import { glyph } from './glyphs';
import { PAD_DEFAULT_BINDINGS, type PadBindings } from './padBindings';
import { type InputSource, keycapFor, padGlyph } from './padGlyphs';

afterEach(() => {
  setLocale('en');
});

const UP = String.fromCharCode(0x2191);
const DOWN = String.fromCharCode(0x2193);
const LEFT = String.fromCharCode(0x2190);
const RIGHT = String.fromCharCode(0x2192);

/** The standard indices whose label is a literal in every locale. */
const LITERAL: ReadonlyArray<readonly [number, string]> = [
  [0, 'A'],
  [1, 'B'],
  [2, 'X'],
  [3, 'Y'],
  [4, 'LB'],
  [5, 'RB'],
  [6, 'LT'],
  [7, 'RT'],
  [10, 'LS'],
  [11, 'RS'],
];

/** The standard indices the catalog names, by locale. */
const CATALOG_EN: ReadonlyArray<readonly [number, string]> = [
  [8, 'View'],
  [9, 'Menu'],
  [12, `D-pad ${UP}`],
  [13, `D-pad ${DOWN}`],
  [14, `D-pad ${LEFT}`],
  [15, `D-pad ${RIGHT}`],
];
const CATALOG_FR: ReadonlyArray<readonly [number, string]> = [
  [8, 'Affichage'],
  [9, 'Menu'],
  [12, `Croix ${UP}`],
  [13, `Croix ${DOWN}`],
  [14, `Croix ${LEFT}`],
  [15, `Croix ${RIGHT}`],
];

const STANDARD = new Set([...LITERAL, ...CATALOG_EN].map(([i]) => i));

const padTable = (over: Partial<PadBindings['buttons']>): PadBindings => ({
  ...PAD_DEFAULT_BINDINGS,
  buttons: { ...PAD_DEFAULT_BINDINGS.buttons, ...over },
});
const keyTable = (over: Partial<Bindings['buttons']>): Bindings => ({
  ...DEFAULT_BINDINGS,
  buttons: { ...DEFAULT_BINDINGS.buttons, ...over },
});

describe('padGlyph: the Xbox label of a standard index', () => {
  it('names the face buttons, bumpers, triggers and stick clicks by their Xbox label, and View, Menu and the D-pad by their English words [gp-4.1]', () => {
    // WRONG IMPL KILLED: a table with an index off by one (View and Menu swapped, LT and RT
    // swapped), a stick click left out, a D-pad arrow pointing the wrong way, and a View or Menu
    // read from the wrong catalog id.
    for (const [i, label] of [...LITERAL, ...CATALOG_EN]) {
      expect(padGlyph(i), `index ${i}`).toBe(label);
    }
    const labels = [...LITERAL, ...CATALOG_EN].map(([, label]) => label);
    expect(new Set(labels).size, 'the 16 standard labels are 16 different words').toBe(16);
  });

  it('gives an index outside the table the localized generic button name with its number, never an empty string [gp-4.1]', () => {
    // WRONG IMPL KILLED: an empty string or undefined for an unlisted index (a blank keycap), the
    // Home index 16 treated as a standard one, a name with no number (two unlisted buttons look
    // alike), and a generic name built from a literal instead of the catalog.
    for (const i of [16, 17, 18, 31, 32, 99, 1000]) {
      expect(padGlyph(i), `index ${i}`).toBe(tf('pad.button', { n: i }));
      expect(padGlyph(i), `index ${i} reads English`).toBe(`Button ${i}`);
    }
    expect(padGlyph(17), 'two outside indices differ').not.toBe(padGlyph(18));
    for (let i = 0; i < 64; i += 1) {
      expect(padGlyph(i), `index ${i} is never empty`).not.toBe('');
      if (!STANDARD.has(i)) {
        expect(padGlyph(i), `index ${i} carries its number`).toContain(String(i));
      }
    }
  });
});

describe('padGlyph: the French locale', () => {
  it('reads View, Menu and the D-pad glyphs in French, keeps the literal labels literal, and reads the generic name in French [gp-4.5]', () => {
    // WRONG IMPL KILLED: a View or D-pad word that stays English under French, a locale read once
    // at import (a French player sees English), a literal label put through the catalog, and a
    // generic name that stays English.
    setLocale('fr');
    for (const [i, label] of CATALOG_FR) {
      expect(padGlyph(i), `fr index ${i}`).toBe(label);
    }
    for (const [i, label] of LITERAL) {
      expect(padGlyph(i), `fr literal index ${i}`).toBe(label);
    }
    expect(padGlyph(16), 'fr generic name').toBe('Bouton 16');
    expect(padGlyph(8), 'View is not the English word').not.toBe('View');
    expect(padGlyph(12), 'the D-pad is not the English word').not.toBe(`D-pad ${UP}`);
  });

  it('follows a locale switch at the next call, and a keycap function built before the switch reads the new locale [gp-4.5]', () => {
    // WRONG IMPL KILLED: a glyph table built once (a switch shows only after a reload) and a
    // keycap chooser that captures the glyph strings when it is built.
    setLocale('en');
    const cap = keycapFor('pad', DEFAULT_BINDINGS, PAD_DEFAULT_BINDINGS);
    expect(cap('Select'), 'en View').toBe('View');
    expect(cap('Start'), 'en Menu').toBe('Menu');
    expect(cap('Up'), 'en D-pad up').toBe(`D-pad ${UP}`);
    setLocale('fr');
    expect(padGlyph(8), 'fr View').toBe('Affichage');
    expect(cap('Select'), 'the same function reads fr View').toBe('Affichage');
    expect(cap('Up'), 'the same function reads fr D-pad up').toBe(`Croix ${UP}`);
    setLocale('en');
    expect(cap('Select'), 'back to en View').toBe('View');
  });
});

describe('keycapFor: the keycap a source shows for a virtual button', () => {
  it('with the pad as source shows the pad glyph of the first index bound to the button, for every button of the default pad table [gp-4.2]', () => {
    // WRONG IMPL KILLED: a pad keycap that reads the keyboard table, the glyph of an alias (the
    // second index) instead of the first, and a glyph taken from the wrong button's row.
    const cap = keycapFor('pad', DEFAULT_BINDINGS, PAD_DEFAULT_BINDINGS);
    const expected: Record<string, string> = {
      Up: `D-pad ${UP}`,
      Down: `D-pad ${DOWN}`,
      Left: `D-pad ${LEFT}`,
      Right: `D-pad ${RIGHT}`,
      A: 'A',
      B: 'B',
      X: 'X',
      Y: 'Y',
      LB: 'LB',
      RB: 'RB',
      Start: 'Menu',
      Select: 'View',
    };
    expect(Object.keys(expected).sort(), 'the fixture names every virtual button').toEqual(
      [...VBUTTONS].sort(),
    );
    for (const button of VBUTTONS) {
      expect(cap(button), `pad keycap of ${button}`).toBe(expected[button]);
    }
    const aliased = keycapFor('pad', DEFAULT_BINDINGS, padTable({ A: [5, 0], B: [99, 1] }));
    expect(aliased('A'), 'the first bound index, not the second').toBe('RB');
    expect(aliased('B'), 'an outside first index reads the generic name').toBe('Button 99');
  });

  it('with the keyboard as source shows the keyboard glyph of the first key bound to the button, whatever the pad table holds [gp-4.3]', () => {
    // WRONG IMPL KILLED: a keyboard keycap that reads the pad table, the glyph of an alias, and a
    // keycap that ignores the keyboard table it is given (a remap lies).
    const cap = keycapFor('keys', DEFAULT_BINDINGS, PAD_DEFAULT_BINDINGS);
    for (const button of VBUTTONS) {
      const code = DEFAULT_BINDINGS.buttons[button][0] as string;
      expect(cap(button), `keyboard keycap of ${button}`).toBe(glyph(code));
    }
    expect(cap('A'), 'A reads the Enter key').toBe('Enter');
    expect(cap('Start'), 'Start reads the Escape key').toBe('Esc');
    const remapped = keycapFor('keys', keyTable({ A: ['KeyZ', 'Enter'] }), padTable({ A: [5] }));
    expect(remapped('A'), 'the first remapped key, not the pad').toBe(glyph('KeyZ'));
  });

  it('with the pad as source shows an empty keycap for a button with no pad index bound, and only that button [gp-4.4]', () => {
    // WRONG IMPL KILLED: undefined or a crash for an unbound pad button, a fallback to the
    // keyboard glyph (a pad player sees "Enter"), and an empty keycap that spreads to bound ones.
    const cap = keycapFor('pad', DEFAULT_BINDINGS, padTable({ A: [], Select: [] }));
    expect(cap('A'), 'A has no pad index').toBe('');
    expect(cap('Select'), 'Select has no pad index').toBe('');
    expect(cap('B'), 'B keeps its glyph').toBe('B');
    expect(cap('Start'), 'Start keeps its glyph').toBe('Menu');
  });

  it('with the keyboard as source shows an empty keycap for a button with no key bound, and only that button [gp-4.4]', () => {
    // WRONG IMPL KILLED: glyph(undefined) read as a key (a crash or the text "undefined"), a
    // fallback to the pad glyph, and an empty keycap that spreads to bound buttons.
    const cap = keycapFor('keys', keyTable({ A: [], Select: [] }), PAD_DEFAULT_BINDINGS);
    expect(cap('A'), 'A has no key').toBe('');
    expect(cap('Select'), 'Select has no key').toBe('');
    expect(cap('B'), 'B keeps its glyph').toBe(glyph('Backspace'));
    expect(cap('Start'), 'Start keeps its glyph').toBe('Esc');
  });

  it('picks the table by its source argument alone: the same tables give different keycaps for keys and for pad [gp-4.2]', () => {
    // WRONG IMPL KILLED: a chooser that ignores its source (always keys or always pad).
    const sources: readonly InputSource[] = ['keys', 'pad'];
    const [keys, pad] = sources.map((s) => keycapFor(s, DEFAULT_BINDINGS, PAD_DEFAULT_BINDINGS));
    expect(keys?.('Start')).toBe('Esc');
    expect(pad?.('Start')).toBe('Menu');
  });
});
