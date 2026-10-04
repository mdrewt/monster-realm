/**
 * bindings.test.ts: the ONE binding table (ctl-1, CTL1.1; design section 3).
 *
 * Pure, node env. The table is data, so the tests assert the shipped values (the design's
 * default keymap, primary first then aliases) and the invariants that must hold for ANY
 * future edit of it: a code is bound once, a reserved code is never bound, every virtual
 * button has a key, and the whole table is frozen.
 *
 * `buttonForCode` resolves a physical code through a given table to its virtual button.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { accelForCode, buttonForCode, DEFAULT_BINDINGS, RESERVED_CODES } from './bindings';
import { ACCELS, VBUTTONS, type VButton } from './buttons';

/** Design section 3, transcribed. Order inside a list is primary-first. */
const EXPECTED_BUTTONS: Readonly<Record<VButton, readonly string[]>> = {
  Up: ['KeyW', 'ArrowUp'],
  Down: ['KeyS', 'ArrowDown'],
  Left: ['KeyA', 'ArrowLeft'],
  Right: ['KeyD', 'ArrowRight'],
  A: ['Enter', 'NumpadEnter'],
  B: ['Backspace'],
  X: ['Space'],
  Y: ['KeyF'],
  LB: ['KeyQ', 'PageUp'],
  RB: ['KeyE', 'PageDown'],
  Start: ['Escape', 'KeyM'],
  Select: ['KeyR', 'Slash'],
};

const EXPECTED_ACCELS: Readonly<Record<string, readonly string[]>> = {
  B: ['KeyB'],
  I: ['KeyI'],
  V: ['KeyV'],
  J: ['KeyJ'],
  U: ['KeyU'],
  P: ['KeyP'],
  L: ['KeyL'],
  N: ['KeyN'],
  C: ['KeyC'],
  F9: ['F9'],
  F8: ['F8'],
};

/** Every (owner, code) pair across buttons and accelerators, in table order. */
const flat = (): ReadonlyArray<{ readonly owner: string; readonly code: string }> => [
  ...Object.entries(DEFAULT_BINDINGS.buttons).flatMap(([owner, codes]) =>
    codes.map((code) => ({ owner: `button:${owner}`, code })),
  ),
  ...Object.entries(DEFAULT_BINDINGS.accels).flatMap(([owner, codes]) =>
    codes.map((code) => ({ owner: `accel:${owner}`, code })),
  ),
];

describe('DEFAULT_BINDINGS: the design section 3 keymap', () => {
  it('CTL1-1-BINDINGS-TABLE: holds the exact design keymap, primary code first, for every button and accelerator', () => {
    // WRONG IMPL KILLED: a table missing an alias (Numpad Enter, PageUp), with the primary
    // and alias swapped (the label code comes from index 0), or with a roster drifted from
    // the design (Y on the wrong key, Start without M, Select without Slash).
    expect(DEFAULT_BINDINGS.buttons).toEqual(EXPECTED_BUTTONS);
    expect(DEFAULT_BINDINGS.accels).toEqual(EXPECTED_ACCELS);
    for (const b of VBUTTONS) {
      expect(DEFAULT_BINDINGS.buttons[b][0], `primary code of ${b}`).toBe(EXPECTED_BUTTONS[b][0]);
    }
    // The roster constants match the table's own keys, in order.
    expect([...VBUTTONS]).toEqual(Object.keys(EXPECTED_BUTTONS));
    expect([...ACCELS]).toEqual(Object.keys(EXPECTED_ACCELS));
    expect(Object.keys(DEFAULT_BINDINGS.buttons)).toEqual([...VBUTTONS]);
    expect(Object.keys(DEFAULT_BINDINGS.accels)).toEqual([...ACCELS]);
  });

  it('CTL1-1-BINDINGS-UNIQUE: no code is bound twice, no reserved code is bound, every button has a key', () => {
    // WRONG IMPL KILLED: a code reused by a button and an accelerator (two owners for one
    // physical key), Tab/F5/F11/F12/a bare modifier bound, and a virtual button with an
    // empty code list (unreachable from the keyboard).
    const all = flat();
    const index = fc.nat({ max: all.length - 1 });
    fc.assert(
      fc.property(index, index, (i, j) => {
        fc.pre(i !== j);
        expect(all[i].code, `${all[i].owner} vs ${all[j].owner}`).not.toBe(all[j].code);
      }),
      { numRuns: 500 },
    );
    expect(new Set(all.map((e) => e.code)).size).toBe(all.length);

    expect(RESERVED_CODES).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    const bound = new Set(all.map((e) => e.code));
    fc.assert(
      fc.property(fc.constantFrom(...RESERVED_CODES), (reserved) => {
        expect(bound.has(reserved), `${reserved} must never be bound`).toBe(false);
      }),
    );

    for (const b of VBUTTONS) {
      expect(DEFAULT_BINDINGS.buttons[b].length, `${b} needs at least one code`).toBeGreaterThan(0);
    }
  });

  it('is deeply frozen: the record, each list and the accelerator table reject mutation', () => {
    expect(Object.isFrozen(DEFAULT_BINDINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BINDINGS.buttons)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BINDINGS.accels)).toBe(true);
    for (const b of VBUTTONS) {
      expect(Object.isFrozen(DEFAULT_BINDINGS.buttons[b]), `buttons.${b}`).toBe(true);
    }
    for (const a of ACCELS) {
      expect(Object.isFrozen(DEFAULT_BINDINGS.accels[a]), `accels.${a}`).toBe(true);
    }
    expect(() => {
      (DEFAULT_BINDINGS.buttons.Up as unknown as string[]).push('KeyZ');
    }).toThrow();
  });
});

describe('buttonForCode', () => {
  it('resolves every bound button code to its owner, primary and alias alike', () => {
    for (const b of VBUTTONS) {
      for (const code of EXPECTED_BUTTONS[b]) {
        expect(buttonForCode(DEFAULT_BINDINGS, code), code).toBe(b);
      }
    }
  });

  it('returns undefined for accelerator codes (they are not virtual buttons), reserved codes and unbound codes', () => {
    for (const codes of Object.values(EXPECTED_ACCELS)) {
      for (const code of codes) expect(buttonForCode(DEFAULT_BINDINGS, code), code).toBeUndefined();
    }
    for (const code of RESERVED_CODES) {
      expect(buttonForCode(DEFAULT_BINDINGS, code), code).toBeUndefined();
    }
    for (const code of ['KeyZ', 'KeyX', 'Digit1', 'F1', '', 'keyw', 'Numpad5']) {
      expect(buttonForCode(DEFAULT_BINDINGS, code), code).toBeUndefined();
    }
  });

  it('agrees with a table oracle for arbitrary codes (resolution reads only the code string)', () => {
    const owner = new Map<string, VButton>();
    for (const b of VBUTTONS) for (const code of EXPECTED_BUTTONS[b]) owner.set(code, b);
    const boundCodes = [...owner.keys()];
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...boundCodes), fc.string({ maxLength: 12 })),
        (code) => {
          expect(buttonForCode(DEFAULT_BINDINGS, code)).toBe(owner.get(code));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('resolves through the table it is given, not a hard-coded one', () => {
    const custom = {
      buttons: { ...DEFAULT_BINDINGS.buttons, Y: ['KeyZ'] },
      accels: DEFAULT_BINDINGS.accels,
    };
    expect(buttonForCode(custom, 'KeyZ')).toBe('Y');
    expect(buttonForCode(custom, 'KeyF')).toBeUndefined();
  });
});

// ==========================================================================================
// ctl-11a: accelerators move to the router; Q and E are the bumpers (CTL11A.1 / CTL11A.3)
// ==========================================================================================
//
// `accelForCode(bindings, code)` is the accelerator twin of `buttonForCode`: the accelerator a
// physical code is bound to in `bindings.accels`, else undefined (a button code, a reserved code
// and an unbound code all give undefined). Q and E leave the legacy ladder for good: they are LB and
// RB (with PageUp and PageDown), and no accelerator claims them.

describe('accelForCode (ctl-11a)', () => {
  it('CTL11A-1-ACCEL-FOR-CODE: resolves every default accelerator code (F8 and F9 included) to its accelerator, gives undefined for every button code, reserved code and unbound code, resolves through the table it is given, and agrees with a table oracle for arbitrary codes', () => {
    // WRONG IMPL KILLED: a lookup that reads `buttons` (every accelerator code would be
    // unbound, or Q would read as an accelerator), one that reads a hard-coded letter list instead
    // of the table it is given (a remapped accelerator would never resolve, and its old key would
    // still fire), one that returns the first accelerator whose list merely CONTAINS a prefix of
    // the code, a case-insensitive match (`keyj` would open the Journal), a missing F8 or F9 row,
    // and one that answers a button code (A, Start, the D-pad would open menus).
    for (const accel of ACCELS) {
      for (const code of EXPECTED_ACCELS[accel]) {
        expect(accelForCode(DEFAULT_BINDINGS, code), `${code} is accelerator ${accel}`).toBe(accel);
      }
    }
    for (const codes of Object.values(EXPECTED_BUTTONS)) {
      for (const code of codes) {
        expect(accelForCode(DEFAULT_BINDINGS, code), `${code} is a button, not an accel`).toBe(
          undefined,
        );
      }
    }
    for (const code of RESERVED_CODES) {
      expect(accelForCode(DEFAULT_BINDINGS, code), `${code} is reserved`).toBe(undefined);
    }
    for (const code of [
      'KeyZ',
      'KeyX',
      'Digit1',
      'F1',
      'F7',
      '',
      'keyj',
      'KEYJ',
      'KeyJJ',
      ' KeyJ',
    ]) {
      expect(accelForCode(DEFAULT_BINDINGS, code), JSON.stringify(code)).toBe(undefined);
    }

    // It resolves through the table it is given: a remapped Journal answers its new keys only.
    const custom = {
      buttons: DEFAULT_BINDINGS.buttons,
      accels: { ...DEFAULT_BINDINGS.accels, J: ['KeyZ', 'KeyY'] },
    };
    expect(accelForCode(custom, 'KeyZ')).toBe('J');
    expect(accelForCode(custom, 'KeyY')).toBe('J');
    expect(accelForCode(custom, 'KeyJ'), 'the old key no longer fires').toBe(undefined);
    expect(accelForCode(custom, 'KeyB'), 'the others are untouched').toBe('B');

    // Property: for arbitrary strings the answer is exactly the table oracle's.
    const owner = new Map<string, string>();
    for (const accel of ACCELS) for (const code of EXPECTED_ACCELS[accel]) owner.set(code, accel);
    const boundCodes = [...owner.keys()];
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...boundCodes), fc.string({ maxLength: 12 })),
        (code) => {
          expect(accelForCode(DEFAULT_BINDINGS, code)).toBe(owner.get(code));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('CTL11A-3-BINDINGS: LB is Q then PageUp and RB is E then PageDown, no accelerator claims Q, E, PageUp or PageDown, and the legacy J, V, U, P, L letters stay accelerators', () => {
    // WRONG IMPL KILLED: a table that leaves KeyQ or KeyE as an accelerator or as an alias of two
    // owners (Q would both open a screen and page its tabs: migration rule 2 lands Q/E -> LB/RB in
    // one slice), LB and RB with the primary and alias swapped (the label glyph comes from index
    // 0), a bumper dropped from its list (the router would stop reading it), and an accelerator
    // table that lost the keys the new menu paths hang on.
    expect(DEFAULT_BINDINGS.buttons.LB).toEqual(['KeyQ', 'PageUp']);
    expect(DEFAULT_BINDINGS.buttons.RB).toEqual(['KeyE', 'PageDown']);
    expect(buttonForCode(DEFAULT_BINDINGS, 'KeyQ')).toBe('LB');
    expect(buttonForCode(DEFAULT_BINDINGS, 'KeyE')).toBe('RB');
    expect(buttonForCode(DEFAULT_BINDINGS, 'PageUp')).toBe('LB');
    expect(buttonForCode(DEFAULT_BINDINGS, 'PageDown')).toBe('RB');
    for (const code of ['KeyQ', 'KeyE', 'PageUp', 'PageDown']) {
      expect(accelForCode(DEFAULT_BINDINGS, code), `${code} is no accelerator`).toBe(undefined);
      for (const accel of ACCELS) {
        expect(DEFAULT_BINDINGS.accels[accel], `${code} not in accel ${accel}`).not.toContain(code);
      }
    }
    // The accelerators the canonical paths hang on stay bound to their letters.
    expect(
      ['KeyB', 'KeyI', 'KeyV', 'KeyJ', 'KeyU', 'KeyP', 'KeyL', 'KeyN', 'KeyC'].map((code) =>
        accelForCode(DEFAULT_BINDINGS, code),
      ),
    ).toEqual(['B', 'I', 'V', 'J', 'U', 'P', 'L', 'N', 'C']);
  });
});
