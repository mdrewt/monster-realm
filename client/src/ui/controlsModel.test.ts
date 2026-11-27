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
 *
 * The Pad column has its own capture: `capturePad(pad, target, index)` mirrors `captureKey` over
 * the pad table, one pad index per row: refused (an unbindable index, or a swap that would leave a
 * protected button with no pad index), cancelled (the index the row already holds), bound or swapped.
 * `padOutcomeText` words each outcome with pad glyphs, naming both rows of a swap.
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
  isBindablePadIndex,
  PAD_DEFAULT_BINDINGS,
  type PadBindings,
  type PadIndex,
} from '../input/padBindings';
import { padGlyph } from '../input/padGlyphs';
import type { MenuAccel } from '../input/router';
import {
  type CapturedKey,
  CONTROLS_TABS,
  type ControlsRow,
  type ControlsTab,
  captureKey,
  capturePad,
  capturePrompt,
  clearAccel,
  clearedText,
  clearPadAccel,
  leavePadIndex,
  outcomeText,
  type PadCaptureOutcome,
  type PadRow,
  type PadTarget,
  padCapturePrompt,
  padOutcomeText,
  padRow,
  padSlot,
  rowLabel,
  type Slot,
  type SlotTarget,
  slots,
} from './controlsModel';
import { setLocale, t, tf } from './i18n/resolver';

// --- fixtures --------------------------------------------------------------------------------

type Outcome = ReturnType<typeof captureKey>;

const btn = (id: VButton): ControlsRow => ({ kind: 'button', id });
const acc = (id: Accel): ControlsRow => ({ kind: 'accel', id });

/** The rows Options › Controls lists per tab, in display order. */
function controlsRows(tab: ControlsTab): readonly ControlsRow[] {
  return tab === 'buttons' ? VBUTTONS.map((id) => btn(id)) : ACCELS.map((id) => acc(id));
}

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

  it('a same-row swap names its row once, both keycaps, and still starts "Swapped:"', () => {
    // WRONG IMPL KILLED: a line built as "{a} is now {x}, {b} is now {y}" that repeats the row
    // label when both slots belong to one row ("Select is now /, Select is now R"), one that names
    // only one keycap, and one that loses the fixed prefix on this path.
    learnKey('KeyR', PHI); // the layout types a distinctive letter on KeyR
    const o = captureKey(DEFAULT_BINDINGS, { row: btn('Select'), slot: 0 }, press('Slash'));
    const s = swapped(o);
    expect(s.other, 'the swap partner is the same row').toEqual({ row: btn('Select'), slot: 1 });
    const text = outcomeText(o);
    expect(text.startsWith('Swapped:'), text).toBe(true);
    const label = rowLabel(btn('Select'));
    expect(text.split(label).length - 1, `"${label}" appears exactly once in: ${text}`).toBe(1);
    expect(text).toContain(glyph('Slash'));
    expect(text).toContain(PHI.toUpperCase());
    expect(text).not.toContain('KeyR');
  });

  it('isBindableCode is total: undefined, null and non-strings are not bindable, and a capture with no code is refused as reserved', () => {
    // WRONG IMPL KILLED: a regex test on `undefined` (it stringifies to "undefined", which matches
    // the pattern and binds the string "undefined"), a typeof-free length check that throws, and a
    // capture of a synthetic event (no code) that binds or throws.
    expect(isBindableCode(undefined as never)).toBe(false);
    expect(isBindableCode(null as never)).toBe(false);
    expect(isBindableCode(5 as never)).toBe(false);
    expect(isBindableCode({} as never)).toBe(false);
    expect(isBindableCode('KeyK'), 'control: a real code is bindable').toBe(true);
    expect(
      captureKey(
        DEFAULT_BINDINGS,
        { row: btn('B'), slot: 0 },
        { code: undefined as never, key: 'x' },
      ),
    ).toEqual({ kind: 'refused', reason: 'reserved' });
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

  // ---- qf-14 (QF14.2): the Controls accelerator is an ordinary, remappable shortcut -------------

  it('lists the Controls accelerator Y among the Shortcuts rows with its own label (en Controls, fr Commandes), and rebinding or clearing it moves or unbinds KeyY like any other shortcut, leaving the Y button alone [QF14-2-REMAP-MODEL]', () => {
    // WRONG IMPL KILLED: a Y row missing from the Shortcuts tab (the generated surface would never
    // list it), a label that is another row's (two rows a player cannot tell apart) or the Y
    // BUTTON's label (the namespaces mixed), a hard-coded English label (fr would read English),
    // a rebind that leaves KeyY bound as well (the old key still opens Controls), a rebind or
    // clear that writes the button Y (KeyF) instead of the accelerator, a Y that cannot be cleared
    // (every other shortcut can), a swap that strands KeyJ, and a table mutated in place.
    const yRow = acc('Y');
    expect(controlsRows('shortcuts')).toContainEqual({ kind: 'accel', id: 'Y' });
    expect(controlsRows('buttons'), 'Y is a shortcut row, not a new button row').not.toContainEqual(
      {
        kind: 'accel',
        id: 'Y',
      },
    );
    expect(
      controlsRows('shortcuts').filter((r) => r.kind === 'accel' && r.id === 'Y'),
    ).toHaveLength(1);
    expect(rowLabel(yRow)).toBe('Controls');
    expect(rowLabel(yRow), 'not the Y button`s label').not.toBe(rowLabel(btn('Y')));
    expect(slots(DEFAULT_BINDINGS, yRow)).toEqual(['KeyY', undefined]);
    expect(slots(DEFAULT_BINDINGS, btn('Y')), 'the button Y is still KeyF').toEqual([
      'KeyF',
      undefined,
    ]);
    expect(capturePrompt(yRow)).toContain('Controls');
    try {
      setLocale('fr');
      expect(rowLabel(yRow), 'the label follows the locale').toBe('Commandes');
    } finally {
      setLocale('en');
    }

    // Rebind to a free key: the new code opens it, KeyY no longer does.
    const frozen = deepFreeze(table());
    const moved = captureKey(frozen, { row: yRow, slot: 0 }, press('KeyK'));
    expect(moved).toEqual({ kind: 'bound', bindings: table({}, { Y: ['KeyK'] }) });
    const after = resultOf(moved);
    expect(accelForCode(after, 'KeyK')).toBe('Y');
    expect(accelForCode(after, 'KeyY'), 'the old key is free again').toBeUndefined();
    expect(buttonForCode(after, 'KeyY')).toBeUndefined();
    expect(after.buttons.Y, 'the Y button is untouched').toEqual(['KeyF']);
    expect(frozen, 'the input table is untouched').toEqual(DEFAULT_BINDINGS);
    expectSane(after);

    // Take another shortcut's key: the two trade.
    const swap = swapped(captureKey(frozen, { row: yRow, slot: 0 }, press('KeyJ')));
    expect(swap.bindings).toEqual(table({}, { Y: ['KeyJ'], J: ['KeyY'] }));
    expect(swap.other).toEqual({ row: acc('J'), slot: 0 });
    expect(accelForCode(swap.bindings, 'KeyJ')).toBe('Y');
    expect(accelForCode(swap.bindings, 'KeyY')).toBe('J');

    // Across the namespaces: the accelerator Y and the button Y share an id, not a row. KeyF (the
    // button's key) captured onto the accelerator swaps with the BUTTON row, and the reverse.
    const toAccel = swapped(captureKey(frozen, { row: yRow, slot: 0 }, press('KeyF')));
    expect(toAccel.other, 'the holder is the BUTTON Y, slot 0').toEqual({ row: btn('Y'), slot: 0 });
    expect(toAccel.code).toBe('KeyF');
    expect(toAccel.displaced, 'the accelerator`s old key goes to the button').toBe('KeyY');
    expect(toAccel.bindings).toEqual(table({ Y: ['KeyY'] }, { Y: ['KeyF'] }));
    expect(toAccel.bindings.buttons.Y, 'button Y ends on KeyY').toEqual(['KeyY']);
    expect(toAccel.bindings.accels.Y, 'accelerator Y ends on KeyF').toEqual(['KeyF']);
    expect(accelForCode(toAccel.bindings, 'KeyF')).toBe('Y');
    expect(buttonForCode(toAccel.bindings, 'KeyF')).toBeUndefined();
    expect(buttonForCode(toAccel.bindings, 'KeyY')).toBe('Y');
    expect(accelForCode(toAccel.bindings, 'KeyY')).toBeUndefined();
    const text = outcomeText(captureKey(frozen, { row: yRow, slot: 0 }, press('KeyF')));
    expect(text, 'the line names both rows').toContain(rowLabel(btn('Y')));
    expect(text).toContain(rowLabel(yRow));

    const toButton = swapped(captureKey(frozen, { row: btn('Y'), slot: 0 }, press('KeyY')));
    expect(toButton.other, 'the holder is the ACCELERATOR Y, slot 0').toEqual({
      row: yRow,
      slot: 0,
    });
    expect(toButton.bindings).toEqual(table({ Y: ['KeyY'] }, { Y: ['KeyF'] }));

    // Clear: both slots empty, the key does nothing, every other row is untouched.
    const cleared = clearAccel(DEFAULT_BINDINGS, 'Y');
    expect(cleared).toEqual(table({}, { Y: [] }));
    expect(slots(cleared, yRow)).toEqual([undefined, undefined]);
    expect(accelForCode(cleared, 'KeyY')).toBeUndefined();
    expect(buttonForCode(cleared, 'KeyY')).toBeUndefined();
    expect(allCodes(cleared)).not.toContain('KeyY');
    expect(accelForCode(cleared, 'KeyC'), 'a neighbour still fires').toBe('C');
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

// =============================================================================================
// The Pad column: padRow / padSlot, capturePad, padOutcomeText and padCapturePrompt
// =============================================================================================

/** U+2026 HORIZONTAL ELLIPSIS, by code point. */
const ELLIPSIS = String.fromCharCode(0x2026);

const padBtn = (id: VButton): PadRow => ({ kind: 'button', id });
const padAcc = (id: MenuAccel): PadRow => ({ kind: 'accel', id });
const padAt = (row: PadRow): PadTarget => ({ row, slot: 'pad' });

/** The menu accelerators of the pad table, in its key order. */
const MENU_ACCEL_IDS: readonly MenuAccel[] = Object.keys(
  PAD_DEFAULT_BINDINGS.accels,
) as MenuAccel[];

/** The default pad table with some lists replaced (deep-frozen, like a real table). */
function padTable(
  buttons: Partial<Record<VButton, readonly PadIndex[]>> = {},
  accels: Partial<Record<MenuAccel, readonly PadIndex[]>> = {},
): PadBindings {
  return deepFreeze({
    buttons: { ...PAD_DEFAULT_BINDINGS.buttons, ...buttons },
    accels: { ...PAD_DEFAULT_BINDINGS.accels, ...accels },
  });
}

function padSwapped(o: PadCaptureOutcome): Extract<PadCaptureOutcome, { kind: 'swapped' }> {
  if (o.kind !== 'swapped') throw new Error(`expected swapped, got ${JSON.stringify(o)}`);
  return o;
}

const padListOf = (p: PadBindings, row: PadRow): readonly PadIndex[] =>
  row.kind === 'button' ? p.buttons[row.id] : p.accels[row.id];

function expectSanePad(p: PadBindings): void {
  const all: PadIndex[] = [];
  for (const b of VBUTTONS) {
    expect(p.buttons[b].length, `button ${b} has at most one pad index`).toBeLessThanOrEqual(1);
    all.push(...p.buttons[b]);
  }
  for (const a of MENU_ACCEL_IDS) {
    expect(p.accels[a].length, `accelerator ${a} has at most one pad index`).toBeLessThanOrEqual(1);
    all.push(...p.accels[a]);
  }
  for (const b of PROTECTED_BUTTONS) {
    expect(p.buttons[b], `protected button ${b} keeps one pad index`).toHaveLength(1);
  }
  expect(new Set(all).size, 'no pad index is bound twice').toBe(all.length);
  for (const i of all) expect(isBindablePadIndex(i), `bound index ${String(i)}`).toBe(true);
}

/** The plan's exact English lines for the two pad refusals. */
const PAD_REFUSED_RESERVED = 'That button cannot be bound.';
const PAD_REFUSED_PROTECTED = 'Movement, Confirm, Back and Menu must always keep a pad button.';

describe('controlsModel: the Pad column', () => {
  afterEach(() => {
    setLocale('en');
  });

  it('padRow names the pad row of every button row and of every menu accelerator row and none for the F8 and F9 rows; padSlot reads a row`s one pad index, in its own namespace, or undefined [gp-5.5]', () => {
    // WRONG IMPL KILLED: a pad row for the debug accelerators (their Pad cell would start a capture
    // the pad table cannot hold), a row that changes kind (the accelerator B read as the B button),
    // a padSlot that reads the keyboard table or the other namespace (the accelerator Y would show
    // the Y button's 3), and one that pads an empty row with a default.
    for (const row of controlsRows('buttons')) {
      expect(padRow(row), `${row.kind} ${row.id}`).toEqual(row);
    }
    let accelRows = 0;
    for (const row of controlsRows('shortcuts')) {
      if (row.id === 'F8' || row.id === 'F9') {
        expect(padRow(row), `${row.id} has no Pad cell`).toBeUndefined();
      } else {
        expect(padRow(row), `accelerator ${row.id}`).toEqual(row);
        accelRows += 1;
      }
    }
    expect(accelRows, 'ANTI-VACUITY: the ten menu accelerators').toBe(10);

    const d = PAD_DEFAULT_BINDINGS;
    expect(padSlot(d, padBtn('A'))).toBe(0);
    expect(padSlot(d, padBtn('Up'))).toBe(12);
    expect(padSlot(d, padBtn('Start'))).toBe(9);
    expect(padSlot(d, padBtn('Select'))).toBe(8);
    expect(padSlot(d, padAcc('I')), 'the Bag on RT').toBe(7);
    expect(padSlot(d, padAcc('V')), 'Party on LT').toBe(6);
    expect(padSlot(d, padAcc('J')), 'the Journal has no pad button').toBeUndefined();
    expect(padSlot(d, padBtn('B')), 'the B button').toBe(1);
    expect(padSlot(d, padAcc('B')), 'the Storage accelerator B is another row').toBeUndefined();
    expect(padSlot(d, padBtn('Y')), 'the Y button').toBe(3);
    expect(padSlot(d, padAcc('Y')), 'the Controls accelerator Y is another row').toBeUndefined();
    expect(padSlot(padTable({ X: [] }), padBtn('X')), 'an emptied row').toBeUndefined();
    expect(padSlot(padTable({ A: [3], Y: [0] }), padBtn('A')), 'a remapped row').toBe(3);
  });

  it('capturePad binds a free index onto the target row, whose old index goes unbound, on button and accelerator rows, up to index 31; it never mutates its input [gp-5.5]', () => {
    // WRONG IMPL KILLED: a bind that appends instead of replacing (a row with two pad buttons), one
    // that keeps the replaced index on the row, one that binds onto the button of the same name as an
    // accelerator, a range check that refuses 17 to 31, and one that edits the frozen table in
    // place (it throws here).
    const frozen = padTable();
    expect(capturePad(frozen, padAt(padBtn('X')), 10), 'X onto LS').toEqual({
      kind: 'bound',
      bindings: padTable({ X: [10] }),
    });
    expect(capturePad(frozen, padAt(padAcc('J')), 11), 'the Journal onto RS').toEqual({
      kind: 'bound',
      bindings: padTable({}, { J: [11] }),
    });
    expect(capturePad(frozen, padAt(padBtn('A')), 17), 'A onto 17: its 0 goes unbound').toEqual({
      kind: 'bound',
      bindings: padTable({ A: [17] }),
    });
    expect(capturePad(frozen, padAt(padAcc('C')), 31), 'the last bindable index').toEqual({
      kind: 'bound',
      bindings: padTable({}, { C: [31] }),
    });
    expect(capturePad(frozen, padAt(padAcc('B')), 10), 'the Storage accelerator, not B').toEqual({
      kind: 'bound',
      bindings: padTable({}, { B: [10] }),
    });
    expect(frozen, 'the input is untouched').toEqual(PAD_DEFAULT_BINDINGS);
  });

  it('capturePad cancels on the index the target row already holds, on every button row, on the accelerator rows and on a remapped row (its new index, not its default) [gp-5.5]', () => {
    // WRONG IMPL KILLED: a capture that "binds" the row's own index again (a needless save, and no
    // way for a pad-only player to leave a capture unchanged), one that compares with the DEFAULT
    // index (a remapped row would cancel on its old button), and one that cancels on any index the
    // row's other namespace twin holds.
    const frozen = padTable();
    for (const b of VBUTTONS) {
      const own = PAD_DEFAULT_BINDINGS.buttons[b][0] as PadIndex;
      expect(capturePad(frozen, padAt(padBtn(b)), own), `${b} on its own ${own}`).toEqual({
        kind: 'cancelled',
      });
    }
    expect(capturePad(frozen, padAt(padAcc('I')), 7)).toEqual({ kind: 'cancelled' });
    expect(capturePad(frozen, padAt(padAcc('V')), 6)).toEqual({ kind: 'cancelled' });
    const moved = padTable({ A: [3], Y: [0] });
    expect(capturePad(moved, padAt(padBtn('A')), 3), 'A on its new 3').toEqual({
      kind: 'cancelled',
    });
    expect(capturePad(moved, padAt(padBtn('A')), 0).kind, 'A on its old 0 swaps').toBe('swapped');
    expect(capturePad(frozen, padAt(padAcc('Y')), 3).kind, 'the accelerator Y on 3 swaps').toBe(
      'swapped',
    );
  });

  it('capturePad swaps with the row holding the index, both ways, across buttons and accelerators: the holder takes the target`s old index, and the outcome names it with the index and the displaced one [gp-5.5]', () => {
    // WRONG IMPL KILLED: a bind that leaves the index on its holder too (one pad button pressing two
    // things), a holder that loses its index and gets nothing back (Y emptied for no reason), a
    // swap that hands the holder the DEFAULT index instead of the target's current one, an outcome
    // that names the target as the other row, a code / displaced pair swapped, and a guard that
    // refuses every swap touching a protected button (A may give 0 away for X's 2).
    const frozen = padTable();
    expect(padSwapped(capturePad(frozen, padAt(padBtn('X')), 3)), 'X takes Y`s 3').toEqual({
      kind: 'swapped',
      bindings: padTable({ X: [3], Y: [2] }),
      other: padAt(padBtn('Y')),
      code: 3,
      displaced: 2,
    });
    expect(padSwapped(capturePad(frozen, padAt(padBtn('Y')), 2)), 'Y takes X`s 2').toEqual({
      kind: 'swapped',
      bindings: padTable({ X: [3], Y: [2] }),
      other: padAt(padBtn('X')),
      code: 2,
      displaced: 3,
    });
    expect(padSwapped(capturePad(frozen, padAt(padBtn('X')), 7)), 'X takes the Bag`s RT').toEqual({
      kind: 'swapped',
      bindings: padTable({ X: [7] }, { I: [2] }),
      other: padAt(padAcc('I')),
      code: 7,
      displaced: 2,
    });
    expect(padSwapped(capturePad(frozen, padAt(padAcc('I')), 2)), 'the Bag takes X`s 2').toEqual({
      kind: 'swapped',
      bindings: padTable({ X: [7] }, { I: [2] }),
      other: padAt(padBtn('X')),
      code: 2,
      displaced: 7,
    });
    expect(
      padSwapped(capturePad(frozen, padAt(padAcc('V')), 7)),
      'Party takes the Bag`s RT',
    ).toEqual({
      kind: 'swapped',
      bindings: padTable({}, { V: [7], I: [6] }),
      other: padAt(padAcc('I')),
      code: 7,
      displaced: 6,
    });
    expect(padSwapped(capturePad(frozen, padAt(padBtn('X')), 0)), 'A gives 0 for X`s 2').toEqual({
      kind: 'swapped',
      bindings: padTable({ X: [0], A: [2] }),
      other: padAt(padBtn('A')),
      code: 0,
      displaced: 2,
    });
    // A remapped holder gives back the target's CURRENT index.
    const moved = padTable({ X: [10] });
    expect(padSwapped(capturePad(moved, padAt(padBtn('X')), 3)).bindings, 'Y gets X`s 10').toEqual(
      padTable({ X: [3], Y: [10] }),
    );
    expect(frozen, 'the input is untouched').toEqual(PAD_DEFAULT_BINDINGS);
  });

  it('capturePad on an empty row takes a non-protected holder`s index and leaves that row empty, displaced undefined; X, Y, LB, RB and Select may each be emptied so [gp-5.5]', () => {
    // WRONG IMPL KILLED: a swap that refuses whenever the target is empty (a cleared accelerator
    // could never take a pad button already in use), one that gives the holder a default instead of
    // nothing, and a protected guard that over-reaches to the free buttons.
    const frozen = padTable();
    expect(padSwapped(capturePad(frozen, padAt(padAcc('J')), 2)), 'the Journal takes X').toEqual({
      kind: 'swapped',
      bindings: padTable({ X: [] }, { J: [2] }),
      other: padAt(padBtn('X')),
      code: 2,
      displaced: undefined,
    });
    expect(
      padSwapped(capturePad(frozen, padAt(padAcc('Y')), 3)),
      'the Controls accelerator takes the Y button`s 3',
    ).toEqual({
      kind: 'swapped',
      bindings: padTable({ Y: [] }, { Y: [3] }),
      other: padAt(padBtn('Y')),
      code: 3,
      displaced: undefined,
    });
    for (const b of ['X', 'Y', 'LB', 'RB', 'Select'] as const) {
      const index = PAD_DEFAULT_BINDINGS.buttons[b][0] as PadIndex;
      const s = padSwapped(capturePad(frozen, padAt(padAcc('U')), index));
      expect(s.bindings.buttons[b], `${b} may be emptied`).toEqual([]);
      expect(s.bindings.accels.U, `the Trades accelerator holds ${index}`).toEqual([index]);
    }
  });

  it('capturePad refuses as protected a swap that would leave Up, Down, Left, Right, A, B or Start with no pad index, and changes nothing [gp-5.5]', () => {
    // WRONG IMPL KILLED: a swap that strands the D-pad, A, B or Start on the pad (a pad-only player
    // could not move, confirm, back out or reach the menu that fixes it), a refusal reported with
    // the reserved reason, and a refusal that still hands back a table.
    // B's index on an EMPTY row is the cancel press (its own test below), so the empty Journal row
    // is refused for every protected button except B.
    const frozen = padTable();
    const guarded = PROTECTED_BUTTONS.filter((p) => p !== 'B');
    expect(guarded, 'ANTI-VACUITY: six protected buttons besides B').toHaveLength(6);
    for (const p of guarded) {
      const index = PAD_DEFAULT_BINDINGS.buttons[p][0] as PadIndex;
      expect(capturePad(frozen, padAt(padAcc('J')), index), `the Journal takes ${p}`).toEqual({
        kind: 'refused',
        reason: 'protected',
      });
    }
    // An emptied X row cannot take Up's index either.
    expect(capturePad(padTable({ X: [] }), padAt(padBtn('X')), 12)).toEqual({
      kind: 'refused',
      reason: 'protected',
    });
    expect(frozen, 'the input is untouched').toEqual(PAD_DEFAULT_BINDINGS);
  });

  it('capturePad refuses as reserved the Guide button 16 and every unbindable index (32, 100, -1, 1.5, NaN, Infinity), on any row, and changes nothing [gp-5.8]', () => {
    // WRONG IMPL KILLED: a capture that binds Guide (the OS opens its overlay on it: the bound button
    // would fire under every OS press), one that binds an index no standard pad reports, a
    // fractional or negative index stored, and a reserved press reported as protected or cancelled.
    const frozen = padTable();
    for (const index of [16, 32, 100, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const row of [padBtn('X'), padBtn('A'), padAcc('J'), padAcc('I')]) {
        expect(capturePad(frozen, padAt(row), index), `${row.id} on ${index}`).toEqual({
          kind: 'refused',
          reason: 'reserved',
        });
      }
    }
    expect(frozen, 'the input is untouched').toEqual(PAD_DEFAULT_BINDINGS);
  });

  it('after any sequence of pad captures every table keeps each protected button on one pad index, binds no index twice, holds only bindable indices and no list over one; a bound or swapped index ends on its target row [gp-5.5]', () => {
    // WRONG IMPL KILLED: a capture path with one unguarded corner (a swap through an empty
    // accelerator, an index above 15, a remapped holder) that duplicates an index or strands a
    // protected button, a reserved index that slips through, and a capture that mutates its frozen
    // input (each table is deep-frozen before the next step).
    const rows: PadRow[] = [...controlsRows('buttons'), ...controlsRows('shortcuts')].flatMap(
      (row) => {
        const p = padRow(row);
        return p === undefined ? [] : [p];
      },
    );
    const pool = [...Array.from({ length: 18 }, (_, i) => i), 31, 32, -1, 1.5];
    const opArb = fc.record({ row: fc.nat(rows.length - 1), index: fc.constantFrom(...pool) });
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        let p: PadBindings = PAD_DEFAULT_BINDINGS;
        for (const op of ops) {
          const row = rows[op.row] as PadRow;
          const outcome = capturePad(p, padAt(row), op.index);
          if (outcome.kind === 'bound' || outcome.kind === 'swapped') {
            expect(padListOf(outcome.bindings, row), 'the index is on its row').toEqual([op.index]);
            p = deepFreeze(outcome.bindings);
          } else if (outcome.kind === 'refused' && outcome.reason === 'reserved') {
            expect(isBindablePadIndex(op.index), `${op.index} is unbindable`).toBe(false);
          }
          expectSanePad(p);
        }
      }),
    );
  });

  it('padOutcomeText names both rows and both pad glyphs on a swap ("Swapped: <glyph> is now <row>, <glyph> is now <other row>"), with pad glyphs and never a raw index, across buttons and accelerators [gp-5.5]', () => {
    // WRONG IMPL KILLED: a line that names one row only, one that prints the raw index ("13 is now
    // Jump (X)"), one that reads the keyboard keycap table for an index, one that names the target
    // as the other row (the target is found by looking the index up in the new table), and one that
    // reuses the keyboard's swappedSlots wording.
    const frozen = padTable();
    const xDown = capturePad(frozen, padAt(padBtn('X')), 13);
    const text = padOutcomeText(xDown);
    expect(text).toBe(
      tf('controls.swapped', {
        key: padGlyph(13),
        label: rowLabel(btn('X')),
        otherKey: padGlyph(2),
        otherLabel: rowLabel(btn('Down')),
      }),
    );
    expect(text.startsWith('Swapped:'), text).toBe(true);
    expect(text, 'names the target row').toContain(rowLabel(btn('X')));
    expect(text, 'names the other row').toContain(rowLabel(btn('Down')));
    expect(text, 'the captured pad glyph').toContain(padGlyph(13));
    expect(text.includes('13'), 'never the raw index').toBe(false);

    const bagX = capturePad(frozen, padAt(padAcc('I')), 2);
    expect(padOutcomeText(bagX)).toBe(
      tf('controls.swapped', {
        key: padGlyph(2),
        label: rowLabel(acc('I')),
        otherKey: padGlyph(7),
        otherLabel: rowLabel(btn('X')),
      }),
    );
  });

  it('padOutcomeText for a swap that leaves the other row with no pad button reads "Swapped: <glyph> is now <row>, <other row> has no pad button", in the active locale [gp-5.5]', () => {
    // WRONG IMPL KILLED: the keyboard line ("... has no key": wrong for a pad), a line naming one
    // row, an "undefined" displaced glyph printed, and a line frozen in English.
    const frozen = padTable();
    const journal = capturePad(frozen, padAt(padAcc('J')), 2);
    const en = padOutcomeText(journal);
    expect(en).toBe(
      `Swapped: ${padGlyph(2)} is now ${rowLabel(acc('J'))}, ${rowLabel(btn('X'))} has no pad button`,
    );
    const trades = capturePad(frozen, padAt(padAcc('U')), 4);
    expect(padOutcomeText(trades)).toBe(
      `Swapped: ${padGlyph(4)} is now ${rowLabel(acc('U'))}, ${rowLabel(btn('LB'))} has no pad button`,
    );
    expect(en.includes('undefined'), 'no undefined glyph').toBe(false);
    setLocale('fr');
    const fr = padOutcomeText(journal);
    expect(fr, 'the French line').not.toBe(en);
    expect(fr, 'names the French row label').toContain(rowLabel(acc('J')));
    expect(fr).toContain(padGlyph(2));
  });

  it('padOutcomeText reads "That button cannot be bound." for a reserved press (not the keyboard`s browser line), the pad protected line for a protected refusal, and the shared cancelled and bound lines [gp-5.5] [gp-5.8]', () => {
    // WRONG IMPL KILLED: the keyboard reserved line ("That key belongs to the browser": false for
    // Guide, which the OS owns), the keyboard protected line ("... keep a key"), a silent refusal,
    // and a cancel or bind worded differently from a key capture's.
    const reserved = padOutcomeText({ kind: 'refused', reason: 'reserved' });
    expect(reserved).toBe(PAD_REFUSED_RESERVED);
    expect(reserved).not.toBe(outcomeText({ kind: 'refused', reason: 'reserved' }));
    const prot = padOutcomeText({ kind: 'refused', reason: 'protected' });
    expect(prot).toBe(PAD_REFUSED_PROTECTED);
    expect(prot).not.toBe(outcomeText({ kind: 'refused', reason: 'protected' }));
    expect(padOutcomeText({ kind: 'cancelled' })).toBe(t('controls.cancelled'));
    const frozen = padTable();
    expect(padOutcomeText(capturePad(frozen, padAt(padBtn('X')), 10))).toBe(t('controls.bound'));
    expect(padOutcomeText(capturePad(frozen, padAt(padBtn('X')), 16))).toBe(PAD_REFUSED_RESERVED);
    expect(padOutcomeText(capturePad(frozen, padAt(padAcc('J')), 0))).toBe(PAD_REFUSED_PROTECTED);
  });

  it('padCapturePrompt reads "Press a pad button for <row>…" for every row, differs from the key prompt, and follows the locale [gp-5.6]', () => {
    // WRONG IMPL KILLED: the key prompt reused (a pad player is told to press a key), a prompt that
    // names the wrong row or none, three dots instead of U+2026, and a prompt frozen in English.
    expect(padCapturePrompt(btn('A'))).toBe(`Press a pad button for Confirm (A)${ELLIPSIS}`);
    for (const tab of CONTROLS_TABS) {
      for (const row of controlsRows(tab)) {
        expect(padCapturePrompt(row), `${row.kind} ${row.id}`).toBe(
          `Press a pad button for ${rowLabel(row)}${ELLIPSIS}`,
        );
        expect(padCapturePrompt(row)).not.toBe(capturePrompt(row));
      }
    }
    const en = padCapturePrompt(acc('I'));
    setLocale('fr');
    expect(padCapturePrompt(acc('I')), 'the French prompt').not.toBe(en);
    expect(padCapturePrompt(acc('I'))).toContain(rowLabel(acc('I')));
  });

  // ---- the Back button (B) cancels a capture through the live pad table ------------------------

  it('capturePad on an empty row cancels on B`s index and changes nothing, on a Journal row and on an emptied button row [rb-138.3]', () => {
    // WRONG IMPL KILLED: a refused/protected for B on an empty row (a pad-only player has no way
    // out of the capture), a "bound" that moves B onto the row, and a swap that strands B.
    const frozen = padTable();
    expect(capturePad(frozen, padAt(padAcc('J')), 1), 'the Journal on B`s 1').toEqual({
      kind: 'cancelled',
    });
    expect(capturePad(frozen, padAt(padAcc('Y')), 1), 'the Controls accelerator on B`s 1').toEqual({
      kind: 'cancelled',
    });
    expect(capturePad(padTable({ X: [] }), padAt(padBtn('X')), 1), 'an emptied X row').toEqual({
      kind: 'cancelled',
    });
    expect(frozen, 'the input is untouched').toEqual(PAD_DEFAULT_BINDINGS);
  });

  it('capturePad on an empty row cancels on B`s LIVE index (a remapped B, not the default 1), and the default 1 is then an ordinary index [rb-138.3]', () => {
    // WRONG IMPL KILLED: a hard-coded index 1 (the remapped B would stay refused and the default 1
    // would cancel), and a cancel that ignores whether the index is B's.
    const moved = padTable({ B: [10] });
    expect(capturePad(moved, padAt(padAcc('J')), 10), 'the Journal on B`s new 10').toEqual({
      kind: 'cancelled',
    });
    expect(capturePad(moved, padAt(padAcc('J')), 1), 'the default 1 is free now').toEqual({
      kind: 'bound',
      bindings: padTable({ B: [10] }, { J: [1] }),
    });
    const held = padTable({ B: [10], X: [1] });
    const taken = padSwapped(capturePad(held, padAt(padAcc('J')), 1));
    expect(taken.bindings, 'the default 1 belongs to X here: an ordinary swap').toEqual(
      padTable({ B: [10], X: [] }, { J: [1] }),
    );
    expect(taken.displaced).toBeUndefined();
  });

  it('capturePad on a row WITH a pad button reads B`s index like any other: another row`s B swaps (X on 1 gives B the 2), the shown button cancels, and no swap there is refused [rb-138.4]', () => {
    // WRONG IMPL KILLED: a B cancel that fires on a filled row too (X could never be swapped with
    // B), a swap that hands B nothing, and a protected refusal on a swap that strands no one.
    const frozen = padTable();
    expect(padSwapped(capturePad(frozen, padAt(padBtn('X')), 1)), 'X takes B`s 1').toEqual({
      kind: 'swapped',
      bindings: padTable({ X: [1], B: [2] }),
      other: padAt(padBtn('B')),
      code: 1,
      displaced: 2,
    });
    expect(capturePad(frozen, padAt(padBtn('X')), 2), 'X on its shown 2').toEqual({
      kind: 'cancelled',
    });
    expect(capturePad(frozen, padAt(padBtn('B')), 1), 'B on its own 1').toEqual({
      kind: 'cancelled',
    });
    expect(
      padSwapped(capturePad(padTable({}, { J: [11] }), padAt(padAcc('J')), 1)).bindings,
      'a Journal row with a button swaps with B',
    ).toEqual(padTable({ B: [11] }, { J: [1] }));
    for (const p of PROTECTED_BUTTONS) {
      const index = PAD_DEFAULT_BINDINGS.buttons[p][0] as PadIndex;
      expect(capturePad(frozen, padAt(padBtn('X')), index).kind, `X takes ${p}`).toBe('swapped');
    }
  });

  it('capturePad on a filled row cancels on its own remapped B index only when that row is B, and swaps with the live B otherwise [rb-138.4]', () => {
    // WRONG IMPL KILLED: a hard-coded 1 on a filled row, and a swap that gives B the default.
    const moved = padTable({ B: [10] });
    const s = padSwapped(capturePad(moved, padAt(padBtn('X')), 10));
    expect(s.bindings).toEqual(padTable({ X: [10], B: [2] }));
    expect(s.other).toEqual(padAt(padBtn('B')));
    expect(capturePad(moved, padAt(padBtn('X')), 1), 'the free old 1 binds').toEqual({
      kind: 'bound',
      bindings: padTable({ B: [10], X: [1] }),
    });
  });

  it('leavePadIndex names the shown button of a Pad cell, and B`s live first index for an empty Pad cell or any Key cell [rb-138.5]', () => {
    // WRONG IMPL KILLED: B's index for a filled Pad cell (the line would tell the player to press a
    // button that swaps), the default 1 for a remapped B, and a Key cell that reads the row's pad.
    const d = PAD_DEFAULT_BINDINGS;
    expect(leavePadIndex(d, padAt(padBtn('X'))), 'X shows 2').toBe(2);
    expect(leavePadIndex(d, padAt(padBtn('A'))), 'A shows 0').toBe(0);
    expect(leavePadIndex(d, padAt(padBtn('B'))), 'B shows 1').toBe(1);
    expect(leavePadIndex(d, padAt(padAcc('I'))), 'the Bag shows 7').toBe(7);
    expect(leavePadIndex(d, padAt(padAcc('J'))), 'an empty Journal cell: B`s 1').toBe(1);
    expect(leavePadIndex(padTable({ X: [] }), padAt(padBtn('X'))), 'an emptied X: B`s 1').toBe(1);
    const keyCell: SlotTarget = { row: btn('X'), slot: 1 };
    expect(leavePadIndex(d, keyCell), 'a Key cell: B`s 1, not the X row`s 2').toBe(1);
    expect(leavePadIndex(d, { row: acc('I'), slot: 0 }), 'a Key cell of the Bag').toBe(1);
    const moved = padTable({ B: [10], X: [4] });
    expect(leavePadIndex(moved, keyCell), 'a remapped B on a Key cell').toBe(10);
    expect(leavePadIndex(moved, padAt(padAcc('J'))), 'a remapped B on an empty Pad cell').toBe(10);
    expect(leavePadIndex(moved, padAt(padBtn('X'))), 'a remapped shown button').toBe(4);
  });

  it('capturePrompt and padCapturePrompt with no leave read the plain line, and with a leave button also name its pad glyph, in English [rb-138.5]', () => {
    // WRONG IMPL KILLED: a prompt that changes without a leave (the keyboard line is exactly
    // the plain one), one that omits the glyph, and one that names the wrong button.
    const row = btn('A');
    expect(capturePrompt(row)).toBe(`Press a key for Confirm (A)${ELLIPSIS}`);
    expect(capturePrompt(row, undefined)).toBe(`Press a key for Confirm (A)${ELLIPSIS}`);
    expect(padCapturePrompt(row)).toBe(`Press a pad button for Confirm (A)${ELLIPSIS}`);
    for (const leave of [1, 10, 2, 0]) {
      expect(capturePrompt(row, leave), `key, leave ${leave}`).toBe(
        `Press a key for ${rowLabel(row)}${ELLIPSIS} To leave it unchanged, press ${padGlyph(leave)} on the pad.`,
      );
      expect(padCapturePrompt(row, leave), `pad, leave ${leave}`).toBe(
        `Press a pad button for ${rowLabel(row)}${ELLIPSIS} To leave it unchanged, press ${padGlyph(leave)}.`,
      );
    }
    expect(capturePrompt(row, 1)).not.toBe(capturePrompt(row, 10));
    expect(padCapturePrompt(acc('J'), 1)).not.toBe(padCapturePrompt(acc('J'), 10));
  });

  it('capturePrompt and padCapturePrompt with a leave button follow the locale: the French line differs from the English and holds the row label and the pad glyph [rb-138.5]', () => {
    // WRONG IMPL KILLED: a leave sentence frozen in English, and one that drops the label or glyph.
    const row = acc('I');
    const enKey = capturePrompt(row, 1);
    const enPad = padCapturePrompt(row, 1);
    setLocale('fr');
    for (const [en, fr] of [
      [enKey, capturePrompt(row, 1)],
      [enPad, padCapturePrompt(row, 1)],
    ] as const) {
      expect(fr, 'the French line').not.toBe(en);
      expect(fr).toContain(rowLabel(row));
      expect(fr).toContain(padGlyph(1));
    }
    expect(capturePrompt(row, 1), 'key and pad lines differ').not.toBe(padCapturePrompt(row, 1));
  });
});

// Clear empties a shortcut's pad row as well as its keys; its cleared line says so.
describe('controlsModel: clearing the pad half of a shortcut', () => {
  const RIGHT_QUOTE = String.fromCharCode(0x2019);

  afterEach(() => {
    setLocale('en');
  });

  it('clearPadAccel empties the accelerator`s pad row (the default Bag 7, a remapped Party 12 + LT on Journal) and changes no other row; it never mutates its input [rb-141.1]', () => {
    // WRONG IMPL KILLED: a missing export (Clear leaves the pad button live); one that clears the
    // wrong namespace (the button of the same name: the accelerator B vs the B button), one that
    // clears a neighbour or resets the table to defaults, one that falls back to the default index
    // instead of empty, and one that mutates the frozen input.
    const bag = clearPadAccel(PAD_DEFAULT_BINDINGS, 'I');
    expect(bag.accels.I, 'the Bag has no pad index').toEqual([]);
    expect(bag).toEqual(padTable({}, { I: [] }));
    expect(bag.buttons, 'no button row changed').toEqual(PAD_DEFAULT_BINDINGS.buttons);
    expect(PAD_DEFAULT_BINDINGS.accels.I, 'the default table is untouched').toEqual([7]);
    expect(Object.isFrozen(bag), 'the result is frozen like a real table').toBe(true);

    const remapped = padTable({}, { J: [6], V: [] });
    const cleared = clearPadAccel(remapped, 'J');
    expect(cleared.accels.J, 'the remapped Journal button is gone').toEqual([]);
    expect(cleared.accels.I, 'a neighbour keeps its index').toEqual([7]);
    expect(cleared.accels.V, 'a neighbour keeps its (empty) row').toEqual([]);
    expect(cleared.buttons).toEqual(PAD_DEFAULT_BINDINGS.buttons);
    expect(remapped.accels.J, 'the input is untouched').toEqual([6]);

    const accelB = clearPadAccel(PAD_DEFAULT_BINDINGS, 'B');
    expect(accelB.buttons.B, 'the B button is a different row').toEqual([1]);

    for (const a of MENU_ACCEL_IDS) {
      const result = clearPadAccel(PAD_DEFAULT_BINDINGS, a);
      expect(result.accels[a], a).toEqual([]);
      for (const other of MENU_ACCEL_IDS) {
        if (other !== a)
          expect(result.accels[other], `${a} clears not ${other}`).toEqual(
            PAD_DEFAULT_BINDINGS.accels[other],
          );
      }
      expect(result.buttons, a).toEqual(PAD_DEFAULT_BINDINGS.buttons);
    }
  });

  it('clearPadAccel answers the same table object for F8 and F9, which have no pad row [rb-141.1]', () => {
    // WRONG IMPL KILLED: an F8 / F9 clear that throws on the missing row, adds a key to the table,
    // or returns a copy (a needless re-save and re-apply).
    expect(clearPadAccel(PAD_DEFAULT_BINDINGS, 'F8')).toBe(PAD_DEFAULT_BINDINGS);
    expect(clearPadAccel(PAD_DEFAULT_BINDINGS, 'F9')).toBe(PAD_DEFAULT_BINDINGS);
    const remapped = padTable({}, { J: [6] });
    expect(clearPadAccel(remapped, 'F9')).toBe(remapped);
  });

  it('clearedText says the row has no key and no pad button for every pad-bindable accelerator, and no key for F8 and F9, in English and French [rb-141.3]', () => {
    // WRONG IMPL KILLED: the old "has no key now" line for a pad-bindable row (the pad button is
    // never mentioned); a "no pad button" line for F8 / F9 (they never had one); a hard-coded row
    // label; the French lines left as the English text; an ASCII apostrophe for U+2019.
    for (const a of MENU_ACCEL_IDS) {
      const label = rowLabel(acc(a));
      expect(clearedText(a), a).toBe(`${label} has no key and no pad button now.`);
      expect(clearedText(a), a).toBe(tf('controls.clearedPad', { label }));
    }
    for (const a of ['F8', 'F9'] as const) {
      const label = rowLabel(acc(a));
      expect(clearedText(a), a).toBe(`${label} has no key now.`);
      expect(clearedText(a), a).toBe(tf('controls.cleared', { label }));
    }
    setLocale('fr');
    for (const a of MENU_ACCEL_IDS) {
      expect(clearedText(a), `fr ${a}`).toBe(
        `${rowLabel(acc(a))} n${RIGHT_QUOTE}a plus ni touche ni bouton de manette.`,
      );
    }
    for (const a of ['F8', 'F9'] as const) {
      expect(clearedText(a), `fr ${a}`).toBe(
        `${rowLabel(acc(a))} n${RIGHT_QUOTE}a plus de touche.`,
      );
    }
  });
});
