/**
 * padBindings.test.ts: the gamepad binding table (pure data plus two lookups, node env).
 *
 * The table maps `Gamepad.buttons` indices (the standard mapping) onto virtual buttons and
 * menu accelerators. The shipped values are asserted as data; the lookups are asserted over
 * hand-built tables so a wrong lookup order or a wrong filter shows up.
 */
import { describe, expect, it } from 'vitest';
import { VBUTTONS, type VButton } from './buttons';
import {
  isBindablePadIndex,
  PAD_DEFAULT_BINDINGS,
  type PadBindings,
  type PadIndex,
  padAccelFor,
  padButtonFor,
  RESERVED_PAD_INDICES,
} from './padBindings';
import type { MenuAccel } from './router';

const EXPECTED_BUTTONS: Readonly<Record<VButton, readonly PadIndex[]>> = {
  Up: [12],
  Down: [13],
  Left: [14],
  Right: [15],
  A: [0],
  B: [1],
  X: [2],
  Y: [3],
  LB: [4],
  RB: [5],
  Start: [9],
  Select: [8],
};

const EXPECTED_ACCELS: Readonly<Record<MenuAccel, readonly PadIndex[]>> = {
  B: [],
  I: [7],
  V: [6],
  J: [],
  U: [],
  P: [],
  L: [],
  N: [],
  C: [],
  Y: [],
};

/** The default table with some entries replaced. */
function table(
  buttons: Partial<Record<VButton, readonly PadIndex[]>>,
  accels: Partial<Record<MenuAccel, readonly PadIndex[]>> = {},
): PadBindings {
  return {
    buttons: { ...PAD_DEFAULT_BINDINGS.buttons, ...buttons },
    accels: { ...PAD_DEFAULT_BINDINGS.accels, ...accels },
  };
}

describe('PAD_DEFAULT_BINDINGS', () => {
  it('binds the standard-mapping buttons to the virtual buttons', () => {
    for (const b of VBUTTONS) {
      expect(PAD_DEFAULT_BINDINGS.buttons[b]).toEqual(EXPECTED_BUTTONS[b]);
    }
  });

  it('binds V to 6 and I to 7 and every other accelerator to nothing', () => {
    expect(PAD_DEFAULT_BINDINGS.accels).toEqual(EXPECTED_ACCELS);
  });

  it('binds an index to at most one virtual button or accelerator', () => {
    const seen: PadIndex[] = [];
    for (const list of [
      ...Object.values(PAD_DEFAULT_BINDINGS.buttons),
      ...Object.values(PAD_DEFAULT_BINDINGS.accels),
    ]) {
      seen.push(...list);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('binds only bindable indices', () => {
    for (const list of [
      ...Object.values(PAD_DEFAULT_BINDINGS.buttons),
      ...Object.values(PAD_DEFAULT_BINDINGS.accels),
    ]) {
      for (const i of list) {
        expect(isBindablePadIndex(i)).toBe(true);
      }
    }
  });

  it('is frozen, lists included', () => {
    expect(Object.isFrozen(PAD_DEFAULT_BINDINGS)).toBe(true);
    expect(Object.isFrozen(PAD_DEFAULT_BINDINGS.buttons)).toBe(true);
    expect(Object.isFrozen(PAD_DEFAULT_BINDINGS.accels)).toBe(true);
    for (const list of [
      ...Object.values(PAD_DEFAULT_BINDINGS.buttons),
      ...Object.values(PAD_DEFAULT_BINDINGS.accels),
    ]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
});

describe('RESERVED_PAD_INDICES', () => {
  it('is exactly the guide button index 16, frozen', () => {
    expect(RESERVED_PAD_INDICES).toEqual([16]);
    expect(Object.isFrozen(RESERVED_PAD_INDICES)).toBe(true);
  });
});

describe('isBindablePadIndex', () => {
  it('accepts every integer 0 to 31 except the reserved one [gp-1.13]', () => {
    for (let i = 0; i <= 31; i++) {
      expect(isBindablePadIndex(i)).toBe(i !== 16);
    }
  });

  it('refuses the reserved index 16 [gp-1.13]', () => {
    expect(isBindablePadIndex(16)).toBe(false);
    for (const r of RESERVED_PAD_INDICES) {
      expect(isBindablePadIndex(r)).toBe(false);
    }
  });

  it('refuses an integer outside 0 to 31 [gp-1.13]', () => {
    for (const i of [-1, 32, 33, 100, -16, Number.MAX_SAFE_INTEGER]) {
      expect(isBindablePadIndex(i)).toBe(false);
    }
  });

  it('refuses a non-integer number [gp-1.13]', () => {
    for (const i of [
      0.5,
      1.5,
      15.999,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(isBindablePadIndex(i)).toBe(false);
    }
  });

  it('refuses a value that is not a number [gp-1.13]', () => {
    for (const i of ['3', '', null, undefined, true, [], {}, [3], 3n]) {
      expect(isBindablePadIndex(i)).toBe(false);
    }
  });
});

describe('padButtonFor', () => {
  it('resolves each default index to its virtual button', () => {
    for (const b of VBUTTONS) {
      for (const i of EXPECTED_BUTTONS[b]) {
        expect(padButtonFor(PAD_DEFAULT_BINDINGS, i)).toBe(b);
      }
    }
  });

  it('is undefined for an accelerator, an unbound or the reserved index', () => {
    for (const i of [6, 7, 10, 11, 16, 17, 31]) {
      expect(padButtonFor(PAD_DEFAULT_BINDINGS, i)).toBeUndefined();
    }
  });

  it('resolves a custom table, including a multi-index list', () => {
    const t = table({ A: [20, 21], B: [] });
    expect(padButtonFor(t, 20)).toBe('A');
    expect(padButtonFor(t, 21)).toBe('A');
    expect(padButtonFor(t, 1)).toBeUndefined();
  });

  it('takes the first virtual button in VBUTTONS order when two share an index', () => {
    expect(padButtonFor(table({ A: [22], RB: [22] }), 22)).toBe('A');
    expect(padButtonFor(table({ Left: [23], Select: [23] }), 23)).toBe('Left');
  });

  it('does not filter the reserved index itself', () => {
    expect(padButtonFor(table({ A: [16] }), 16)).toBe('A');
  });
});

describe('padAccelFor', () => {
  it('resolves 6 to V and 7 to I by default', () => {
    expect(padAccelFor(PAD_DEFAULT_BINDINGS, 6)).toBe('V');
    expect(padAccelFor(PAD_DEFAULT_BINDINGS, 7)).toBe('I');
  });

  it('is undefined for a button, an unbound or the reserved index', () => {
    for (const i of [0, 1, 4, 8, 9, 10, 12, 15, 16, 17]) {
      expect(padAccelFor(PAD_DEFAULT_BINDINGS, i)).toBeUndefined();
    }
  });

  it('resolves a custom table', () => {
    const t = table({}, { N: [24, 25], V: [] });
    expect(padAccelFor(t, 24)).toBe('N');
    expect(padAccelFor(t, 25)).toBe('N');
    expect(padAccelFor(t, 6)).toBeUndefined();
  });

  it('takes the first accelerator in accelerator order when two share an index', () => {
    expect(padAccelFor(table({}, { B: [26], I: [26] }), 26)).toBe('B');
    expect(padAccelFor(table({}, { L: [27], C: [27] }), 27)).toBe('L');
  });
});
