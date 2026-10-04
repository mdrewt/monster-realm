/**
 * glyphs.test.ts: the keycap a player reads for a physical key (ctl-12, CTL12.5).
 *
 * `glyph(code)` answers synchronously: the character the player's own layout types on that key when
 * the page has seen it (`learnKey`), else a catalog name for the named keys (read through `t()` so
 * the active locale applies), else a name derived from the code (`KeyQ` is Q, `Digit7` is 7), else
 * the code itself. Only one clean printable character is ever learned: a dead key, a modifier, a
 * space, a combining mark or a character whose upper case is longer than one never becomes a keycap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLocale, t } from '../ui/i18n/resolver';
import { glyph, learnKey, resetLearnedKeys } from './glyphs';

const NBSP = String.fromCharCode(0x00a0);
const ZWSP = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
const COMBINING_ACUTE = String.fromCharCode(0x0301);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const SHARP_S = String.fromCharCode(0x00df);
const PHI = String.fromCharCode(0x03c6);

describe('glyphs (ctl-12)', () => {
  beforeEach(() => {
    resetLearnedKeys();
    setLocale('en');
  });
  afterEach(() => {
    resetLearnedKeys();
    setLocale('en');
  });

  it('CTL12-5-CATALOG-NAME: the named keys read their catalog name (Enter is the key.enter text), follow the active locale, and are distinct and non-empty', () => {
    // WRONG IMPL KILLED: a glyph that returns the raw code for named keys ('NumpadEnter',
    // 'ArrowUp'), a name hard-coded in English (the locale switch below would not move it), one
    // resolved once at import (a locale chosen at boot is ignored), two named keys sharing a name
    // (the keycaps on two rows are indistinguishable), and a Numpad key painted as the bare digit.
    expect(glyph('Enter')).toBe(t('key.enter'));
    expect(glyph('Enter')).toBe('Enter');
    setLocale('fr');
    expect(glyph('Enter'), 'the name is read at call time, in the active locale').toBe(
      t('key.enter'),
    );
    setLocale('en');
    expect(glyph('Enter')).toBe(t('key.enter'));

    const named = [
      'Enter',
      'Backspace',
      'Space',
      'Escape',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'PageUp',
      'PageDown',
      'Slash',
    ];
    const names = named.map((code) => glyph(code));
    for (const [i, name] of names.entries()) {
      expect(typeof name, `${named[i]} is a string`).toBe('string');
      expect(name.length, `${named[i]} has a name`).toBeGreaterThan(0);
    }
    expect(new Set(names).size, 'every named key has its own name').toBe(named.length);
    expect(glyph('Slash'), 'Slash is a catalog name, not the code').not.toBe('Slash');
    expect(glyph('PageUp'), 'PageUp is a catalog name, not the code').not.toBe('PageUp');
    expect(glyph('NumpadEnter').length).toBeGreaterThan(0);

    // A Numpad digit names the digit and is not the bare digit key.
    for (const n of ['0', '1', '5', '9']) {
      const name = glyph(`Numpad${n}`);
      expect(name, `Numpad${n} names its digit`).toContain(n);
      expect(name, `Numpad${n} is not the bare digit`).not.toBe(n);
      expect(glyph(`Digit${n}`)).toBe(n);
    }
  });

  it('CTL12-5-LEARNED-AZERTY: a key learned for a code is its glyph, upper-cased, and the derived name is what it replaces', () => {
    // WRONG IMPL KILLED: a glyph that ignores what the layout typed (an AZERTY player reads W on
    // the key that types Z), one that does not upper-case, one that learns for the wrong code, and
    // a learned value that does not replace the derived name.
    expect(glyph('KeyW'), 'before learning: derived from the code').toBe('W');
    learnKey('KeyW', 'z');
    expect(glyph('KeyW')).toBe('Z');
    expect(glyph('KeyA'), 'another code is not affected').toBe('A');
    expect(glyph('KeyZ'), 'the typed letter does not move its own code').toBe('Z');

    learnKey('KeyQ', 'a', { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
    expect(glyph('KeyQ'), 'explicit false modifiers still learn').toBe('A');

    learnKey('Digit1', '&');
    expect(glyph('Digit1'), 'a punctuation key (AZERTY top row)').toBe('&');
    learnKey('Slash', ':');
    expect(glyph('Slash'), 'a learned key beats the catalog name').toBe(':');

    expect(glyph('KeyQ'), 'derived letters').not.toBe('Q');
    resetLearnedKeys();
    expect(glyph('KeyQ')).toBe('Q');
    expect(glyph('Digit7')).toBe('7');
    expect(glyph('F9')).toBe('F9');
    expect(glyph('F12')).toBe('F12');
    expect(glyph('IntlBackslash'), 'an unknown code is its own glyph').toBe('IntlBackslash');
  });

  it('CTL12-5-CAPTURE-RECORDS: a key recorded by the capture path (learnKey, no modifiers) becomes the glyph, and a later one for the same code overwrites it', () => {
    // WRONG IMPL KILLED: a store that keeps the first value (a layout switch mid-session leaves
    // the old keycap), one keyed by character instead of code, and a record that is lost when the
    // same code is recorded twice.
    learnKey('KeyK', 't');
    expect(glyph('KeyK')).toBe('T');
    learnKey('KeyK', 'y');
    expect(glyph('KeyK'), 'the later record wins').toBe('Y');
    learnKey('KeyJ', 'y');
    expect(glyph('KeyJ')).toBe('Y');
    expect(glyph('KeyK'), 'two codes may type the same character').toBe('Y');
  });

  it('CTL12-5-NO-JUNK-GLYPH: dead keys, names, blanks, spaces, invisible and combining characters, lone surrogates, modifier chords and upper-case expansions are never learned; Numpad codes are never learned; prototype names are their own glyph', () => {
    // WRONG IMPL KILLED: a learn that records any non-empty string (a keycap reading "Dead" or
    // "Shift", an empty keycap), one that checks length before trimming (a space or NBSP keycap),
    // one that lets an invisible character (ZWSP, a bidi override) or a lone combining mark in,
    // one that records 'ß' (its upper case is two letters), a learn that records a Shift-held or
    // Ctrl-held character (a shifted '!' on the Digit1 key), a numpad key painted as the bare
    // digit, and a glyph that throws or returns inherited junk for 'constructor'.
    const junk = [
      'Dead',
      'Enter',
      'Shift',
      '',
      'ab',
      ' ',
      NBSP,
      ZWSP,
      RLO,
      COMBINING_ACUTE,
      LONE_SURROGATE,
      SHARP_S,
      '\n',
      '\t',
      String.fromCharCode(0x0000),
    ];
    for (const key of junk) {
      resetLearnedKeys();
      const before = glyph('KeyW');
      learnKey('KeyW', key);
      expect(glyph('KeyW'), `learnKey('KeyW', ${JSON.stringify(key)}) is ignored`).toBe(before);
      expect(before).toBe('W');
    }
    // A named key whose e.key is multi-character stays on its catalog name.
    const enter = glyph('Enter');
    learnKey('Enter', 'Enter');
    learnKey('Enter', ' ');
    expect(glyph('Enter')).toBe(enter);
    const space = glyph('Space');
    learnKey('Space', ' ');
    expect(glyph('Space'), 'the space bar keeps its name').toBe(space);

    // Modifiers held: ignored.
    for (const mods of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ]) {
      learnKey('Digit1', '!', mods);
      learnKey('KeyW', 'Z', mods);
      expect(glyph('Digit1'), `${JSON.stringify(mods)} on Digit1`).toBe('1');
      expect(glyph('KeyW'), `${JSON.stringify(mods)} on KeyW`).toBe('W');
    }

    // Numpad codes are never learned.
    const numpad1 = glyph('Numpad1');
    learnKey('Numpad1', '1');
    expect(glyph('Numpad1'), 'a numpad key keeps its own name').toBe(numpad1);
    expect(numpad1).not.toBe(glyph('Digit1'));
    expect(glyph('Digit1')).toBe('1');

    // The upper-case rule: one char after upper-casing, and a letter, number, punctuation or symbol.
    learnKey('KeyV', PHI);
    expect(glyph('KeyV'), 'a single non-Latin letter is a clean keycap').toBe(PHI.toUpperCase());

    // Prototype names are plain unknown codes.
    for (const code of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(() => glyph(code), code).not.toThrow();
      expect(glyph(code), code).toBe(code);
    }
  });

  it('learnKey with a missing code or key (a synthetic event with no code or key) does not throw and learns nothing', () => {
    // WRONG IMPL KILLED: a learn that calls .length / .toUpperCase on undefined (a plain
    // `new Event('keydown'), or an event from an extension, throws out of the page's key listener),
    // and one that records the string 'undefined' under a real code.
    expect(() => learnKey(undefined as never, undefined as never)).not.toThrow();
    expect(() => learnKey('KeyA', undefined as never)).not.toThrow();
    expect(() => learnKey(undefined as never, 'a')).not.toThrow();
    expect(() => learnKey(null as never, null as never)).not.toThrow();
    expect(glyph('KeyA'), 'KeyA learned nothing').toBe('A');
    expect(glyph('undefined'), 'no entry was made under the string "undefined"').toBe('undefined');
    learnKey('KeyW', 'z');
    expect(glyph('KeyW'), 'control: a well-formed call still learns').toBe('Z');
  });
});
