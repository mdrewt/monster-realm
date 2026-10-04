/**
 * controlsModel.test.ts: the pure core of the Options > Controls screen (ctl-12, CTL12.2, CTL12.3,
 * CTL12.7).
 *
 * `captureKey(bindings, target, key)` decides what pressing a key means while a slot waits for one:
 * refused (a reserved key, a chord, an unbindable or composing event, or a swap that would leave
 * Up, Down, Left, Right, A, B or Start without a key), cancelled (the key it already has), bound
 * (a free key) or swapped (a key held elsewhere: the two slots trade). It never mutates its input.
 * `clearAccel` empties both slots of a shortcut, and a cleared shortcut's key is unbound again.
 *
 * Every expectation is spelled out against `DEFAULT_BINDINGS` (the defaults are the contract), and
 * the properties drive random capture / clear sequences through the same two functions.
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accelForCode,
  type Bindings,
  buttonForCode,
  DEFAULT_BINDINGS,
  isBindableCode,
  PROTECTED_BUTTONS,
} from '../input/bindings';
import { ACCELS, type Accel, VBUTTONS, type VButton } from '../input/buttons';
import { glyph, learnKey, resetLearnedKeys } from '../input/glyphs';
import {
  type CapturedKey,
  CONTROLS_TABS,
  type ControlsRow,
  captureKey,
  capturePrompt,
  clearAccel,
  controlsRows,
  outcomeText,
  rowLabel,
  type Slot,
  slots,
} from './controlsModel';

// --- fixtures --------------------------------------------------------------------------------

type Outcome = ReturnType<typeof captureKey>;

const btn = (id: VButton): ControlsRow => ({ kind: 'button', id });
const acc = (id: Accel): ControlsRow => ({ kind: 'accel', id });

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The defaults with some button / accelerator lists replaced (frozen, like a real table). */
function table(
  buttons: Partial<Record<VButton, readonly string[]>> = {},
  accels: Partial<Record<Accel, readonly string[]>> = {},
): Bindings {
  return deepFreeze({
    buttons: { ...DEFAULT_BINDINGS.buttons, ...buttons },
    accels: { ...DEFAULT_BINDINGS.accels, ...accels },
  });
}

const press = (
  code: string,
  extra: Partial<Omit<CapturedKey, 'code' | 'key'>> = {},
): CapturedKey => ({
  code,
  key: 'x',
  ...extra,
});

function swapped(o: Outcome): Extract<Outcome, { kind: 'swapped' }> {
  if (o.kind !== 'swapped') throw new Error(`expected swapped, got ${JSON.stringify(o)}`);
  return o;
}

/** The bindings of a bound or swapped outcome. */
function resultOf(o: Outcome): Bindings {
  if (o.kind !== 'bound' && o.kind !== 'swapped') {
    throw new Error(`expected bound or swapped, got ${JSON.stringify(o)}`);
  }
  return o.bindings;
}

const listOf = (b: Bindings, row: ControlsRow): readonly string[] =>
  row.kind === 'button' ? b.buttons[row.id] : b.accels[row.id];

function allCodes(b: Bindings): string[] {
  const out: string[] = [];
  for (const v of VBUTTONS) out.push(...b.buttons[v]);
  for (const a of ACCELS) out.push(...b.accels[a]);
  return out;
}

function expectSane(b: Bindings): void {
  for (const v of VBUTTONS) {
    expect(b.buttons[v].length, `button ${v} has at most two codes`).toBeLessThanOrEqual(2);
  }
  for (const a of ACCELS) {
    expect(b.accels[a].length, `accelerator ${a} has at most two codes`).toBeLessThanOrEqual(2);
  }
  for (const p of PROTECTED_BUTTONS) {
    expect(b.buttons[p].length, `protected button ${p} keeps a code`).toBeGreaterThanOrEqual(1);
  }
  const codes = allCodes(b);
  expect(new Set(codes).size, 'no code is bound twice').toBe(codes.length);
  for (const c of codes) expect(isBindableCode(c), `bound code ${JSON.stringify(c)}`).toBe(true);
}

const NBSP = String.fromCharCode(0x00a0);
const RLO = String.fromCharCode(0x202e);
const PHI = String.fromCharCode(0x03c6);

// --- tests -------------------------------------------------------------------------------------

describe('controlsModel (ctl-12)', () => {
  afterEach(() => {
    resetLearnedKeys();
  });

  // ---- rows, slots, labels -------------------------------------------------------------------

  it('lists the two tabs, the twelve button rows and every shortcut row in order, with a label for each', () => {
    // WRONG IMPL KILLED: a missing or re-ordered row, buttons and shortcuts under one kind, and a
    // blank or shared label (two rows a player cannot tell apart).
    expect(CONTROLS_TABS).toEqual(['buttons', 'shortcuts']);
    expect(controlsRows('buttons')).toEqual(VBUTTONS.map((id) => ({ kind: 'button', id })));
    expect(controlsRows('buttons')).toHaveLength(12);
    expect(controlsRows('shortcuts')).toEqual(ACCELS.map((id) => ({ kind: 'accel', id })));
    for (const tab of CONTROLS_TABS) {
      const rows = controlsRows(tab);
      const labels = rows.map((r) => rowLabel(r));
      for (const label of labels) expect(label.length).toBeGreaterThan(0);
      expect(new Set(labels).size, `${tab}: every row has its own label`).toBe(rows.length);
      for (const row of rows) {
        expect(capturePrompt(row), `${tab}: the prompt names the row`).toContain(rowLabel(row));
      }
    }
  });

  it('slots reads primary and alt from a row, undefined where a slot is empty', () => {
    // WRONG IMPL KILLED: a slots that pads with '' or the default, one that swaps primary and alt,
    // and one that reads the wrong namespace for an accelerator that shares a name with a button.
    expect(slots(DEFAULT_BINDINGS, btn('Up'))).toEqual(['KeyW', 'ArrowUp']);
    expect(slots(DEFAULT_BINDINGS, btn('X'))).toEqual(['Space', undefined]);
    expect(slots(DEFAULT_BINDINGS, acc('B'))).toEqual(['KeyB', undefined]);
    expect(slots(DEFAULT_BINDINGS, btn('B'))).toEqual(['Backspace', undefined]);
    expect(slots(table({ Y: [] }), btn('Y'))).toEqual([undefined, undefined]);
  });

  // ---- CTL12.2: what a captured key means -----------------------------------------------------

  it('CTL12-2-ACCEPT-ESC-ENTER-BKSP: Escape, Enter and Backspace are ordinary keys to capture: each lands on the target and its old holder takes the displaced code, in the slot the captured key came from', () => {
    // WRONG IMPL KILLED: a capture that refuses the three keys that close or confirm screens (a
    // hard-coded "cancel on Escape", "confirm on Enter"), one that binds without taking the code
    // from its holder (the key fires two things), one that lands the displaced code in the wrong
    // slot, and one that mutates its input (frozen here).
    const target = { row: acc('I'), slot: 0 as Slot };

    const esc = swapped(captureKey(DEFAULT_BINDINGS, target, press('Escape')));
    expect(esc).toEqual({
      kind: 'swapped',
      bindings: table({ Start: ['KeyI', 'KeyM'] }, { I: ['Escape'] }),
      other: { row: btn('Start'), slot: 0 },
      code: 'Escape',
      displaced: 'KeyI',
    });
    expect(buttonForCode(esc.bindings, 'Escape')).toBeUndefined();
    expect(accelForCode(esc.bindings, 'Escape')).toBe('I');

    const enter = swapped(captureKey(DEFAULT_BINDINGS, target, press('Enter')));
    expect(enter).toEqual({
      kind: 'swapped',
      bindings: table({ A: ['KeyI', 'NumpadEnter'] }, { I: ['Enter'] }),
      other: { row: btn('A'), slot: 0 },
      code: 'Enter',
      displaced: 'KeyI',
    });

    const bksp = swapped(captureKey(DEFAULT_BINDINGS, target, press('Backspace')));
    expect(bksp).toEqual({
      kind: 'swapped',
      bindings: table({ B: ['KeyI'] }, { I: ['Backspace'] }),
      other: { row: btn('B'), slot: 0 },
      code: 'Backspace',
      displaced: 'KeyI',
    });
    expect(buttonForCode(bksp.bindings, 'KeyI')).toBe('B');
    expect(accelForCode(bksp.bindings, 'KeyI')).toBeUndefined();
  });

  it('CTL12-2-REFUSE-RESERVED: every reserved key (Tab with or without Shift, F5, F11, F12, the bare modifiers) is refused as reserved and changes nothing', () => {
    // WRONG IMPL KILLED: a reserved list that misses Tab under Shift (Shift+Tab is the same code),
    // a function key left bindable (F5 reloads the page), a bare modifier bound (Shift would walk),
    // a refusal that reports another reason, and one that still returns a table.
    const reserved = [
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
    ];
    for (const row of [btn('A'), btn('X'), acc('I')]) {
      for (const slot of [0, 1] as const) {
        for (const code of reserved) {
          expect(
            captureKey(DEFAULT_BINDINGS, { row, slot }, press(code)),
            `${row.kind} ${row.id} slot ${slot}: ${code}`,
          ).toEqual({ kind: 'refused', reason: 'reserved' });
        }
      }
    }
    expect(
      captureKey(DEFAULT_BINDINGS, { row: btn('A'), slot: 0 }, press('Tab', { shiftKey: true })),
    ).toEqual({ kind: 'refused', reason: 'reserved' });
  });

  it('CTL12-2-REFUSE-CHORD: a key held with Ctrl, Alt or Meta is refused as reserved; Shift alone is an ordinary capture', () => {
    // WRONG IMPL KILLED: a chord that binds the base key (Ctrl+K binds K: the browser keeps the
    // chord), one that refuses only Ctrl, and a Shift that is treated as a chord (a player cannot
    // capture a key they typed with Shift held).
    const target = { row: btn('A'), slot: 0 as Slot };
    for (const held of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect(
        captureKey(DEFAULT_BINDINGS, target, press('KeyK', held)),
        JSON.stringify(held),
      ).toEqual({ kind: 'refused', reason: 'reserved' });
    }
    expect(
      captureKey(DEFAULT_BINDINGS, target, press('KeyK', { ctrlKey: true, shiftKey: true })),
    ).toEqual({ kind: 'refused', reason: 'reserved' });
    expect(captureKey(DEFAULT_BINDINGS, target, press('KeyK', { shiftKey: true }))).toEqual({
      kind: 'bound',
      bindings: table({ A: ['KeyK', 'NumpadEnter'] }),
    });
    expect(
      captureKey(DEFAULT_BINDINGS, target, press('KeyK', { ctrlKey: false, altKey: false })).kind,
    ).toBe('bound');
  });

  it('CTL12-2-CANCEL-SAME-KEY: capturing the key a slot already holds cancels and changes nothing, in either slot', () => {
    // WRONG IMPL KILLED: a capture that "swaps" a slot with itself, one that reports bound with an
    // unchanged table, and one that clears the slot.
    expect(captureKey(DEFAULT_BINDINGS, { row: btn('A'), slot: 0 }, press('Enter'))).toEqual({
      kind: 'cancelled',
    });
    expect(captureKey(DEFAULT_BINDINGS, { row: btn('A'), slot: 1 }, press('NumpadEnter'))).toEqual({
      kind: 'cancelled',
    });
    expect(captureKey(DEFAULT_BINDINGS, { row: acc('J'), slot: 0 }, press('KeyJ'))).toEqual({
      kind: 'cancelled',
    });
    expect(captureKey(DEFAULT_BINDINGS, { row: btn('B'), slot: 0 }, press('Backspace'))).toEqual({
      kind: 'cancelled',
    });
  });

  it('CTL12-2-CANCEL-EMPTY-OTHER-SLOT: capturing, on an empty slot, the key the same row already holds in its other slot cancels (no duplicate in the row, no swap with itself)', () => {
    // WRONG IMPL KILLED: a capture that treats the row's own code as "held elsewhere" and swaps
    // (the row's list becomes [KeyB] after losing its code to itself), and one that writes the
    // same code twice into the row.
    expect(captureKey(DEFAULT_BINDINGS, { row: acc('B'), slot: 1 }, press('KeyB'))).toEqual({
      kind: 'cancelled',
    });
    expect(captureKey(DEFAULT_BINDINGS, { row: btn('X'), slot: 1 }, press('Space'))).toEqual({
      kind: 'cancelled',
    });
    expect(captureKey(DEFAULT_BINDINGS, { row: btn('Y'), slot: 1 }, press('KeyF'))).toEqual({
      kind: 'cancelled',
    });
  });

  it('CTL12-2-REFUSE-UNBINDABLE: an empty code, Unidentified, __proto__, a 33-character code and a composing event are refused as reserved', () => {
    // WRONG IMPL KILLED: a capture that binds whatever string arrives (the table then fails its
    // own parse on the next boot and resets to the defaults), one that binds an IME composition's
    // key, and one that checks only the reserved list.
    const target = { row: btn('X'), slot: 0 as Slot };
    const refused = { kind: 'refused', reason: 'reserved' };
    for (const code of ['', 'Unidentified', '__proto__', 'A'.repeat(33), 'Key K', `Key${RLO}K`]) {
      expect(captureKey(DEFAULT_BINDINGS, target, press(code)), JSON.stringify(code)).toEqual(
        refused,
      );
    }
    expect(captureKey(DEFAULT_BINDINGS, target, press('KeyK', { isComposing: true }))).toEqual(
      refused,
    );
    expect(captureKey(DEFAULT_BINDINGS, target, press('KeyK', { keyCode: 229 }))).toEqual(refused);
    // Controls: the same key without the composition, and the longest allowed code, bind.
    expect(captureKey(DEFAULT_BINDINGS, target, press('KeyK', { isComposing: false })).kind).toBe(
      'bound',
    );
    expect(captureKey(DEFAULT_BINDINGS, target, press('A'.repeat(32))).kind).toBe('bound');
  });

  it('any other key is bindable: a free key binds, the old code of the slot is unbound, and Caps Lock, Context Menu and F1 are ordinary keys', () => {
    // WRONG IMPL KILLED: an allow-list of "sensible" keys, a bind that leaves the slot's old code
    // bound as well, one that writes the wrong slot, and one that returns the input table.
    const frozen = deepFreeze(table());
    const a = captureKey(frozen, { row: btn('Up'), slot: 1 }, press('KeyK'));
    expect(a).toEqual({ kind: 'bound', bindings: table({ Up: ['KeyW', 'KeyK'] }) });
    expect(buttonForCode(resultOf(a), 'ArrowUp'), 'the replaced code is unbound').toBeUndefined();
    const b = captureKey(frozen, { row: btn('Up'), slot: 0 }, press('KeyK'));
    expect(b).toEqual({ kind: 'bound', bindings: table({ Up: ['KeyK', 'ArrowUp'] }) });
    for (const code of ['CapsLock', 'ContextMenu', 'F1', 'Digit0', 'Numpad5']) {
      const o = captureKey(frozen, { row: acc('I'), slot: 0 }, press(code));
      expect(o, code).toEqual({ kind: 'bound', bindings: table({}, { I: [code] }) });
    }
    expect(frozen).toEqual(DEFAULT_BINDINGS);
  });

  it('slot compaction: writing slot 1 of a row with an empty slot 0 stores the key as the primary code, and a row that loses its primary shifts its alt up', () => {
    // WRONG IMPL KILLED: a list with a hole ([undefined, code] or ['', code]) that fails the next
    // parse, a swap that leaves the other row's alt in slot 1 with slot 0 empty, and a swap that
    // lands the key in the wrong slot.
    const cleared = clearAccel(DEFAULT_BINDINGS, 'B');
    expect(cleared.accels.B).toEqual([]);
    const into1 = captureKey(cleared, { row: acc('B'), slot: 1 }, press('KeyK'));
    expect(into1).toEqual({ kind: 'bound', bindings: table({}, { B: ['KeyK'] }) });
    expect(slots(resultOf(into1), acc('B'))).toEqual(['KeyK', undefined]);

    // Accel B has an empty alt slot, so taking LB's primary (KeyQ) empties no one: LB's alt shifts.
    const o = swapped(captureKey(DEFAULT_BINDINGS, { row: acc('B'), slot: 1 }, press('KeyQ')));
    expect(o).toEqual({
      kind: 'swapped',
      bindings: table({ LB: ['PageUp'] }, { B: ['KeyB', 'KeyQ'] }),
      other: { row: btn('LB'), slot: 0 },
      code: 'KeyQ',
      displaced: undefined,
    });
    expect(slots(o.bindings, btn('LB'))).toEqual(['PageUp', undefined]);
  });

  // ---- CTL12.3: swaps and protection ----------------------------------------------------------

  it('CTL12-3-SWAP-BUTTONS: a key held by another button trades places with the target (the displaced code lands in the slot the captured key came from), and the same row can trade its own two slots', () => {
    // WRONG IMPL KILLED: a capture that steals the key and leaves its holder with nothing (X would
    // lose Space for good), one that refuses a held key instead of swapping, a displaced code
    // landed in the holder's slot 0 whatever slot it came from, an `other` that names the wrong
    // slot or row, a wrong `displaced`, and one that treats the row's own other slot as foreign.
    // Primary to primary.
    expect(captureKey(DEFAULT_BINDINGS, { row: btn('X'), slot: 0 }, press('KeyF'))).toEqual({
      kind: 'swapped',
      bindings: table({ X: ['KeyF'], Y: ['Space'] }),
      other: { row: btn('Y'), slot: 0 },
      code: 'KeyF',
      displaced: 'Space',
    });
    // From an alt slot: Select's alt (Slash) goes to X, X's Space goes to Select's alt.
    expect(captureKey(DEFAULT_BINDINGS, { row: btn('X'), slot: 0 }, press('Slash'))).toEqual({
      kind: 'swapped',
      bindings: table({ X: ['Slash'], Select: ['KeyR', 'Space'] }),
      other: { row: btn('Select'), slot: 1 },
      code: 'Slash',
      displaced: 'Space',
    });
    // Alt target, primary holder.
    expect(captureKey(DEFAULT_BINDINGS, { row: btn('Up'), slot: 1 }, press('KeyS'))).toEqual({
      kind: 'swapped',
      bindings: table({ Up: ['KeyW', 'KeyS'], Down: ['ArrowUp', 'ArrowDown'] }),
      other: { row: btn('Down'), slot: 0 },
      code: 'KeyS',
      displaced: 'ArrowUp',
    });
    // The same row: A's two slots trade.
    expect(captureKey(DEFAULT_BINDINGS, { row: btn('A'), slot: 0 }, press('NumpadEnter'))).toEqual({
      kind: 'swapped',
      bindings: table({ A: ['NumpadEnter', 'Enter'] }),
      other: { row: btn('A'), slot: 1 },
      code: 'NumpadEnter',
      displaced: 'Enter',
    });
  });

  it('CTL12-3-SWAP-ACROSS-NAMESPACE: a button can take a shortcut key and a shortcut can take a button key; the holder in the other namespace receives the displaced code', () => {
    // WRONG IMPL KILLED: a duplicate check over one namespace only (KeyI ends up on the Bag
    // shortcut and on X: one key fires two things), a swap that writes the displaced code into
    // the wrong namespace, and an accelerator lookup that still finds the old holder.
    const toButton = swapped(
      captureKey(DEFAULT_BINDINGS, { row: btn('X'), slot: 0 }, press('KeyI')),
    );
    expect(toButton).toEqual({
      kind: 'swapped',
      bindings: table({ X: ['KeyI'] }, { I: ['Space'] }),
      other: { row: acc('I'), slot: 0 },
      code: 'KeyI',
      displaced: 'Space',
    });
    expect(buttonForCode(toButton.bindings, 'KeyI')).toBe('X');
    expect(accelForCode(toButton.bindings, 'KeyI')).toBeUndefined();
    expect(accelForCode(toButton.bindings, 'Space')).toBe('I');
    expect(buttonForCode(toButton.bindings, 'Space')).toBeUndefined();

    const toAccel = swapped(
      captureKey(DEFAULT_BINDINGS, { row: acc('J'), slot: 0 }, press('Space')),
    );
    expect(toAccel).toEqual({
      kind: 'swapped',
      bindings: table({ X: ['KeyJ'] }, { J: ['Space'] }),
      other: { row: btn('X'), slot: 0 },
      code: 'Space',
      displaced: 'KeyJ',
    });
    expect(accelForCode(toAccel.bindings, 'Space')).toBe('J');
    expect(buttonForCode(toAccel.bindings, 'KeyJ')).toBe('X');

    // Between two shortcuts.
    expect(captureKey(DEFAULT_BINDINGS, { row: acc('I'), slot: 0 }, press('KeyJ'))).toEqual({
      kind: 'swapped',
      bindings: table({}, { I: ['KeyJ'], J: ['KeyI'] }),
      other: { row: acc('J'), slot: 0 },
      code: 'KeyJ',
      displaced: 'KeyI',
    });
  });

  it('CTL12-3-SWAP-MESSAGE: the swap line starts "Swapped:" and names both keycaps (read through glyph) and both row labels', () => {
    // WRONG IMPL KILLED: a line that prints raw codes ('KeyF' for a key the player knows as the
    // letter their layout types), one that names one side only, one that omits the row labels, and
    // one that does not start with the fixed "Swapped:" prefix the live region keys on.
    learnKey('KeyF', PHI); // the layout types a distinctive letter on KeyF
    const o = captureKey(DEFAULT_BINDINGS, { row: btn('X'), slot: 0 }, press('KeyF'));
    expect(o.kind).toBe('swapped');
    const text = outcomeText(o);
    expect(text.startsWith('Swapped:'), text).toBe(true);
    expect(text).toContain(glyph('KeyF'));
    expect(text).toContain(PHI.toUpperCase());
    expect(text).toContain(glyph('Space'));
    expect(rowLabel(btn('X'))).not.toBe(rowLabel(btn('Y')));
    expect(text).toContain(rowLabel(btn('X')));
    expect(text).toContain(rowLabel(btn('Y')));
    expect(text).not.toContain('KeyF');
  });

  it('refusal and bound lines are non-empty, and the reserved and protected reasons differ', () => {
    // WRONG IMPL KILLED: a silent refusal (the player presses a key and nothing says why), and one
    // reason text reused for both refusals.
    const reserved = outcomeText({ kind: 'refused', reason: 'reserved' });
    const protectedText = outcomeText({ kind: 'refused', reason: 'protected' });
    expect(reserved.length).toBeGreaterThan(0);
    expect(protectedText.length).toBeGreaterThan(0);
    expect(reserved).not.toBe(protectedText);
    const bound = captureKey(DEFAULT_BINDINGS, { row: btn('Up'), slot: 1 }, press('KeyK'));
    expect(outcomeText(bound).length).toBeGreaterThan(0);
  });

  it('CTL12-3-REFUSE-PROTECTED: a swap that would leave Up, Down, Left, Right, A, B or Start with no key is refused as protected; one that empties Select or X is allowed', () => {
    // WRONG IMPL KILLED: a swap that strands the D-pad or Start (the menu can no longer be opened:
    // the player is locked out of the very screen that fixes it), a refusal that reports the
    // reserved reason, a refusal that still hands back a table, and a guard over-reaching to the
    // buttons the spec leaves free (Select, X).
    const frozen = deepFreeze(table());
    // Accelerator B's slot 1 is empty, so taking Backspace (the B button's only key) strands B.
    expect(captureKey(frozen, { row: acc('B'), slot: 1 }, press('Backspace'))).toEqual({
      kind: 'refused',
      reason: 'protected',
    });
    // A custom table where each protected button has one key: taking it from an empty slot strands it.
    for (const id of PROTECTED_BUTTONS) {
      const only = DEFAULT_BINDINGS.buttons[id][0];
      const single = table(
        Object.fromEntries(PROTECTED_BUTTONS.map((p) => [p, [DEFAULT_BINDINGS.buttons[p][0]]])),
      );
      expect(single.buttons[id], `fixture: ${id} has a single key`).toEqual([only]);
      expect(
        captureKey(single, { row: acc('I'), slot: 1 }, press(only)),
        `${id}: taking its only key from an empty slot`,
      ).toEqual({ kind: 'refused', reason: 'protected' });
    }
    expect(frozen).toEqual(DEFAULT_BINDINGS);

    // X may end up empty: its Space goes to a shortcut's empty alt slot.
    const x = swapped(captureKey(frozen, { row: acc('B'), slot: 1 }, press('Space')));
    expect(x).toEqual({
      kind: 'swapped',
      bindings: table({ X: [] }, { B: ['KeyB', 'Space'] }),
      other: { row: btn('X'), slot: 0 },
      code: 'Space',
      displaced: undefined,
    });
    expect(slots(x.bindings, btn('X'))).toEqual([undefined, undefined]);
    // Select too, once both its keys are taken.
    const one = swapped(captureKey(frozen, { row: acc('B'), slot: 1 }, press('KeyR')));
    const two = swapped(captureKey(one.bindings, { row: acc('I'), slot: 1 }, press('Slash')));
    expect(two.bindings.buttons.Select).toEqual([]);
  });

  it('CTL12-3-INVARIANT-PROPERTY: after any sequence of captures and clears every table keeps a key on each protected button, binds no code twice, holds no unbindable code and no list over two; a bound or swapped key ends on its target row', () => {
    // WRONG IMPL KILLED: a capture path with one unguarded corner (a swap through the alt slot, a
    // cross-namespace swap, a same-row trade, a chord after a clear) that duplicates a key or
    // strands a protected button, and a clear that leaves a ghost code. The pool mixes every
    // default key, reserved keys, fresh keys and unbindable junk so a sequence meets each rule.
    const rows = [...controlsRows('buttons'), ...controlsRows('shortcuts')];
    const pool = [
      ...allCodes(DEFAULT_BINDINGS),
      'Tab',
      'F5',
      'F11',
      'F12',
      'ShiftLeft',
      'ControlRight',
      'KeyK',
      'KeyZ',
      'Digit0',
      'F1',
      'CapsLock',
      'Numpad5',
      '',
      'Unidentified',
    ];
    type Op =
      | {
          readonly kind: 'capture';
          readonly row: number;
          readonly slot: Slot;
          readonly code: string;
          readonly shift: boolean;
          readonly ctrl: boolean;
        }
      | { readonly kind: 'clear'; readonly accel: Accel };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      {
        weight: 8,
        arbitrary: fc.record({
          kind: fc.constant('capture' as const),
          row: fc.nat(rows.length - 1),
          slot: fc.constantFrom<Slot>(0, 1),
          code: fc.constantFrom(...pool),
          shift: fc.boolean(),
          ctrl: fc.constantFrom(false, false, false, false, true),
        }),
      },
      {
        weight: 1,
        arbitrary: fc.record({
          kind: fc.constant('clear' as const),
          accel: fc.constantFrom(...ACCELS),
        }),
      },
    );
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        let b: Bindings = DEFAULT_BINDINGS;
        for (const op of ops) {
          if (op.kind === 'clear') {
            b = deepFreeze(clearAccel(b, op.accel));
          } else {
            const row = rows[op.row];
            const outcome = captureKey(
              b,
              { row, slot: op.slot },
              { code: op.code, key: 'x', shiftKey: op.shift, ctrlKey: op.ctrl },
            );
            if (outcome.kind === 'bound' || outcome.kind === 'swapped') {
              expect(listOf(outcome.bindings, row), 'the captured key is on its row').toContain(
                op.code,
              );
              b = deepFreeze(outcome.bindings);
            }
          }
          expectSane(b);
        }
      }),
    );
  });

  // ---- CTL12.7: clearing a shortcut ------------------------------------------------------------

  it('CTL12-7-CLEAR-BOTH-SLOTS: clearing a shortcut empties both its slots, leaves every other row alone and does not mutate its input', () => {
    // WRONG IMPL KILLED: a clear that empties only the primary (the alt keeps firing the
    // shortcut), one that falls back to the default, one that clears the wrong namespace (the
    // button of the same name), one that clears a neighbour, and one that mutates the frozen input.
    const one = clearAccel(DEFAULT_BINDINGS, 'B');
    expect(one).toEqual(table({}, { B: [] }));
    expect(one.buttons.B, 'the B button is a different row').toEqual(['Backspace']);
    expect(slots(one, acc('B'))).toEqual([undefined, undefined]);

    // A shortcut with two keys: both go.
    const two = captureKey(deepFreeze(table()), { row: acc('J'), slot: 1 }, press('KeyK'));
    const withTwo = resultOf(two);
    expect(withTwo.accels.J).toEqual(['KeyJ', 'KeyK']);
    const cleared = clearAccel(withTwo, 'J');
    expect(cleared.accels.J).toEqual([]);
    expect(cleared).toEqual(table({}, { J: [] }));
    expect(withTwo.accels.J, 'the input is untouched').toEqual(['KeyJ', 'KeyK']);

    // Every shortcut clears, including the two function keys.
    for (const a of ACCELS) {
      const result = clearAccel(DEFAULT_BINDINGS, a);
      expect(result.accels[a], a).toEqual([]);
      for (const other of ACCELS) {
        if (other !== a) expect(result.accels[other]).toEqual(DEFAULT_BINDINGS.accels[other]);
      }
      expect(result.buttons).toEqual(DEFAULT_BINDINGS.buttons);
    }
  });

  it('CTL12-7-CLEARED-KEY-UNBOUND: after a clear, neither slot key is bound to anything, as a shortcut or a button, so the key does nothing', () => {
    // WRONG IMPL KILLED: a clear that leaves the code in the accelerator lookup (the shortcut
    // still fires), one that moves the code to a button, and one that unbinds only the primary.
    const cleared = clearAccel(DEFAULT_BINDINGS, 'I');
    expect(accelForCode(cleared, 'KeyI')).toBeUndefined();
    expect(buttonForCode(cleared, 'KeyI')).toBeUndefined();
    expect(allCodes(cleared)).not.toContain('KeyI');
    // The neighbour is untouched: a control that the lookup is live.
    expect(accelForCode(cleared, 'KeyJ')).toBe('J');

    const f9 = clearAccel(DEFAULT_BINDINGS, 'F9');
    expect(accelForCode(f9, 'F9')).toBeUndefined();
    expect(accelForCode(f9, 'F8')).toBe('F8');

    const withTwo = resultOf(
      captureKey(deepFreeze(table()), { row: acc('J'), slot: 1 }, press('KeyK')),
    );
    expect(accelForCode(withTwo, 'KeyK')).toBe('J');
    const both = clearAccel(withTwo, 'J');
    expect(accelForCode(both, 'KeyJ')).toBeUndefined();
    expect(accelForCode(both, 'KeyK')).toBeUndefined();
    expect(allCodes(both)).not.toContain('KeyK');

    // A cleared key is free to bind again: capture it onto a button.
    const rebound = captureKey(both, { row: btn('X'), slot: 1 }, press('KeyJ'));
    expect(rebound).toEqual({
      kind: 'bound',
      bindings: table({ X: ['Space', 'KeyJ'] }, { J: [] }),
    });
  });

  it('the NBSP and Space characters are not codes: a code with an NBSP is refused', () => {
    // WRONG IMPL KILLED: an unbindable check that trims or normalises a code before testing it.
    const target = { row: btn('X'), slot: 0 as Slot };
    expect(captureKey(DEFAULT_BINDINGS, target, press(`Key${NBSP}K`))).toEqual({
      kind: 'refused',
      reason: 'reserved',
    });
  });
});
