// ui/controlsModel.ts — the rules of Options › Controls (design §9, CTL12.1-CTL12.3, CTL12.7).
// Pure: no DOM, storage or module state. A view captures a real key press and asks `captureKey`
// what it does to the table; the shell saves whatever table comes back (`saveBindings`).
//
// Every row has a Primary and an Alt slot over one key namespace shared by the buttons and the
// accelerators. A captured key held elsewhere swaps with the slot's old key; the protected buttons
// (`PROTECTED_BUTTONS`) always keep one, so no capture can lock the player out. A row is a list,
// so a row whose Primary loses its key moves its Alt up.
//
// The Pad cell is the same rule in the pad's own namespace (`capturePad`): one pad button per row,
// a captured index held elsewhere swaps, and the protected buttons always keep a pad button. The F8
// and F9 rows have no pad binding (`padRow`). One pad button always leaves a waiting cell
// unchanged (`leavePadIndex`): the one a Pad cell shows, else B's.
import { type Bindings, isBindableCode, type KeyCode, PROTECTED_BUTTONS } from '../input/bindings';
import { ACCELS, type Accel, VBUTTONS, type VButton } from '../input/buttons';
import { glyph } from '../input/glyphs';
import {
  isBindablePadIndex,
  MENU_ACCELS,
  type PadBindings,
  type PadIndex,
  padButtonFor,
} from '../input/padBindings';
import { padGlyph } from '../input/padGlyphs';
import type { MenuAccel } from '../input/router';
import { t, tf } from './i18n/resolver';

export const CONTROLS_TABS = ['buttons', 'shortcuts'] as const;
export type ControlsTab = (typeof CONTROLS_TABS)[number];

export type ControlsRow =
  | { readonly kind: 'button'; readonly id: VButton }
  | { readonly kind: 'accel'; readonly id: Accel };

/** 0 is the Primary slot, 1 the Alt slot. */
export type Slot = 0 | 1;

export interface SlotTarget {
  readonly row: ControlsRow;
  readonly slot: Slot;
}

/** A row with a Pad cell: every button, and every accelerator but F8 and F9. */
export type PadRow =
  | { readonly kind: 'button'; readonly id: VButton }
  | { readonly kind: 'accel'; readonly id: MenuAccel };

/** A row's Pad cell (one pad button per row). */
export interface PadTarget {
  readonly row: PadRow;
  readonly slot: 'pad';
}

/** What waits for a press: a key slot, or a Pad cell. */
export type CaptureTarget = SlotTarget | PadTarget;

/** The press a capture received (a real KeyboardEvent satisfies it). */
export interface CapturedKey {
  readonly code: KeyCode;
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** What a capture does to a table `T` whose keys are `K` and whose cells are `O`: the keyboard's
 *  by default, the pad's as `PadCaptureOutcome`. */
export type CaptureOutcome<T = Bindings, K = KeyCode, O = SlotTarget> =
  | { readonly kind: 'refused'; readonly reason: 'reserved' | 'protected' }
  /** The press named the key the slot already shows: capture ends with the table unchanged. */
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'bound'; readonly bindings: T }
  /** The key was bound at `other`, which now holds `displaced` (or lost its key). */
  | {
      readonly kind: 'swapped';
      readonly bindings: T;
      readonly other: O;
      readonly code: K;
      readonly displaced: K | undefined;
    };

/** What a pad press captured for a Pad cell does to the pad table. */
export type PadCaptureOutcome = CaptureOutcome<PadBindings, PadIndex, PadTarget>;

const BUTTON_ROWS: readonly ControlsRow[] = VBUTTONS.map((id) => ({ kind: 'button', id }));
const ACCEL_ROWS: readonly ControlsRow[] = ACCELS.map((id) => ({ kind: 'accel', id }));

// Each label is a thunk over a literal catalog id, read in the active locale.
const BUTTON_LABELS: Readonly<Record<VButton, () => string>> = {
  Up: () => t('controls.button.up'),
  Down: () => t('controls.button.down'),
  Left: () => t('controls.button.left'),
  Right: () => t('controls.button.right'),
  A: () => t('controls.button.a'),
  B: () => t('controls.button.b'),
  X: () => t('controls.button.x'),
  Y: () => t('controls.button.y'),
  LB: () => t('controls.button.lb'),
  RB: () => t('controls.button.rb'),
  Start: () => t('controls.button.start'),
  Select: () => t('controls.button.select'),
};
const ACCEL_LABELS: Readonly<Record<Accel, () => string>> = {
  B: () => t('controls.accel.storage'),
  I: () => t('controls.accel.bag'),
  V: () => t('controls.accel.party'),
  J: () => t('controls.accel.journal'),
  U: () => t('controls.accel.trades'),
  P: () => t('controls.accel.challenges'),
  L: () => t('controls.accel.rankings'),
  N: () => t('controls.accel.name'),
  C: () => t('controls.accel.account'),
  Y: () => t('controls.accel.controls'),
  F9: () => t('controls.accel.bugReport'),
  F8: () => t('controls.accel.dismissError'),
};

/** What a row is called ("Confirm (A)", "Bag"). */
export function rowLabel(row: ControlsRow): string {
  return row.kind === 'button' ? BUTTON_LABELS[row.id]() : ACCEL_LABELS[row.id]();
}

/** The line shown while a slot of `row` waits for a key; `leave` is the pad button it names as the
 *  way out (none for a player on the keyboard). */
export function capturePrompt(row: ControlsRow, leave?: PadIndex): string {
  const label = rowLabel(row);
  return leave === undefined
    ? tf('controls.capture.prompt', { label })
    : tf('controls.capture.promptLeave', { label, key: padGlyph(leave) });
}

/** The line shown while the Pad cell of `row` waits for a pad button; `leave` as `capturePrompt`. */
export function padCapturePrompt(row: ControlsRow, leave?: PadIndex): string {
  const label = rowLabel(row);
  return leave === undefined
    ? tf('controls.capture.padPrompt', { label })
    : tf('controls.capture.padPromptLeave', { label, key: padGlyph(leave) });
}

const codesOf = (b: Bindings, row: ControlsRow): readonly KeyCode[] =>
  row.kind === 'button' ? b.buttons[row.id] : b.accels[row.id];

/** A row's Primary and Alt keys; undefined where a slot is empty. */
export function slots(
  b: Bindings,
  row: ControlsRow,
): readonly [KeyCode | undefined, KeyCode | undefined] {
  const codes = codesOf(b, row);
  return [codes[0], codes[1]];
}

const sameRow = (a: ControlsRow, b: ControlsRow): boolean => a.kind === b.kind && a.id === b.id;

/** Where `code` is bound, if anywhere. */
function holderOf(b: Bindings, code: KeyCode): SlotTarget | undefined {
  for (const row of [...BUTTON_ROWS, ...ACCEL_ROWS]) {
    const slot = codesOf(b, row).indexOf(code);
    if (slot === 0 || slot === 1) return { row, slot };
  }
  return undefined;
}

/** `b` with `row`'s list replaced. */
function withRow(b: Bindings, row: ControlsRow, codes: readonly KeyCode[]): Bindings {
  const list = Object.freeze([...codes]);
  return row.kind === 'button'
    ? Object.freeze({ buttons: Object.freeze({ ...b.buttons, [row.id]: list }), accels: b.accels })
    : Object.freeze({ buttons: b.buttons, accels: Object.freeze({ ...b.accels, [row.id]: list }) });
}

/** `codes` with slot `slot` set to `code` (appended when the list is shorter), or cleared (the
 *  Alt moves up) when `code` is undefined. */
function setSlot(codes: readonly KeyCode[], slot: Slot, code: KeyCode | undefined): KeyCode[] {
  const next = [...codes];
  if (code === undefined) next.splice(slot, 1);
  else if (slot < next.length) next[slot] = code;
  else next.push(code);
  return next;
}

/** A press the browser keeps, or no key at all: Ctrl/Alt/Meta chords, an IME composition, and
 *  any code `isBindableCode` refuses (Tab, F5, F11, F12, a bare modifier, `Unidentified`). */
const reserved = (k: CapturedKey): boolean =>
  k.ctrlKey === true ||
  k.altKey === true ||
  k.metaKey === true ||
  k.isComposing === true ||
  k.keyCode === 229 ||
  !isBindableCode(k.code);

/** What a press captured for `target` does to `b` (CTL12.2, CTL12.3). Never mutates `b`. */
export function captureKey(b: Bindings, target: SlotTarget, k: CapturedKey): CaptureOutcome {
  if (reserved(k)) return { kind: 'refused', reason: 'reserved' };
  const { code } = k;
  const [mine, theirs] =
    target.slot === 0 ? slots(b, target.row) : [...slots(b, target.row)].reverse();
  // Keyboard cancel (design §9): the key the slot holds, or for an empty slot the row's other key.
  if (code === mine || (mine === undefined && code === theirs)) return { kind: 'cancelled' };
  const holder = holderOf(b, code);
  const own = codesOf(b, target.row);
  if (holder === undefined) {
    return { kind: 'bound', bindings: withRow(b, target.row, setSlot(own, target.slot, code)) };
  }
  let next: Bindings;
  if (sameRow(holder.row, target.row)) {
    // The row's two keys trade places (`mine` is defined: an empty slot cancelled above).
    next = withRow(b, target.row, setSlot(setSlot(own, holder.slot, mine), target.slot, code));
  } else {
    next = withRow(b, target.row, setSlot(own, target.slot, code));
    next = withRow(next, holder.row, setSlot(codesOf(b, holder.row), holder.slot, mine));
  }
  if (PROTECTED_BUTTONS.some((button) => next.buttons[button].length === 0)) {
    return { kind: 'refused', reason: 'protected' };
  }
  return { kind: 'swapped', bindings: next, other: holder, code, displaced: mine };
}

const isMenuAccel = (a: Accel): a is MenuAccel => (MENU_ACCELS as readonly Accel[]).includes(a);

/** `row` as a row with a Pad cell, or undefined for F8 and F9 (no pad binding). */
export function padRow(row: ControlsRow): PadRow | undefined {
  if (row.kind === 'button') return row;
  const { id } = row;
  return isMenuAccel(id) ? { kind: 'accel', id } : undefined;
}

const PAD_ROWS: readonly PadRow[] = [
  ...VBUTTONS.map((id): PadRow => ({ kind: 'button', id })),
  ...MENU_ACCELS.map((id): PadRow => ({ kind: 'accel', id })),
];

const padIndicesOf = (pad: PadBindings, row: PadRow): readonly PadIndex[] =>
  row.kind === 'button' ? pad.buttons[row.id] : pad.accels[row.id];

/** A row's pad button; undefined when it has none. */
export function padSlot(pad: PadBindings, row: PadRow): PadIndex | undefined {
  return padIndicesOf(pad, row)[0];
}

/** The pad button that ends `target`'s capture unchanged: the one a Pad cell shows, else B's. */
export function leavePadIndex(pad: PadBindings, target: CaptureTarget): PadIndex | undefined {
  const shown = target.slot === 'pad' ? padSlot(pad, target.row) : undefined;
  return shown ?? pad.buttons.B[0];
}

/** The row `index` is bound to, if any. */
const padHolderOf = (pad: PadBindings, index: PadIndex): PadRow | undefined =>
  PAD_ROWS.find((row) => padIndicesOf(pad, row).includes(index));

/** `pad` with `row`'s pad button replaced (none when `index` is undefined). */
function withPadRow(pad: PadBindings, row: PadRow, index: PadIndex | undefined): PadBindings {
  const list: readonly PadIndex[] = Object.freeze(index === undefined ? [] : [index]);
  return row.kind === 'button'
    ? Object.freeze({
        buttons: Object.freeze({ ...pad.buttons, [row.id]: list }),
        accels: pad.accels,
      })
    : Object.freeze({
        buttons: pad.buttons,
        accels: Object.freeze({ ...pad.accels, [row.id]: list }),
      });
}

/** What a pad press captured for `target` does to `pad`: `captureKey`'s rule with one slot per
 *  row. The index the cell shows cancels, as does B's on an empty cell; an index held by another row
 *  swaps with the cell's old one, unless a protected button would end with no pad button. Never
 *  mutates `pad`. */
export function capturePad(
  pad: PadBindings,
  target: PadTarget,
  index: PadIndex,
): PadCaptureOutcome {
  if (!isBindablePadIndex(index)) return { kind: 'refused', reason: 'reserved' };
  const mine = padSlot(pad, target.row);
  // As `captureKey`'s cancel; an empty cell shows no button to press again, so B leaves it.
  if (index === mine || (mine === undefined && padButtonFor(pad, index) === 'B')) {
    return { kind: 'cancelled' };
  }
  const holder = padHolderOf(pad, index);
  const bound = withPadRow(pad, target.row, index);
  if (holder === undefined) return { kind: 'bound', bindings: bound };
  const next = withPadRow(bound, holder, mine);
  if (PROTECTED_BUTTONS.some((button) => next.buttons[button].length === 0)) {
    return { kind: 'refused', reason: 'protected' };
  }
  return {
    kind: 'swapped',
    bindings: next,
    other: { row: holder, slot: 'pad' },
    code: index,
    displaced: mine,
  };
}

/** The keyboard half of Clear on an accelerator row (CTL12.7): both slots unbound, so its key does
 *  nothing until it is bound again. Button rows have no Clear: a protected button can never be
 *  emptied. */
export function clearAccel(b: Bindings, accel: Accel): Bindings {
  return withRow(b, { kind: 'accel', id: accel }, []);
}

/** The pad half of Clear: `accel`'s pad button unbound. `pad` itself for F8 and F9, which have no
 *  pad row. */
export function clearPadAccel(pad: PadBindings, accel: Accel): PadBindings {
  const row = padRow({ kind: 'accel', id: accel });
  return row === undefined ? pad : withPadRow(pad, row, undefined);
}

/** The feedback line once `accel`'s row was cleared: it names the pad button only where a pad can
 *  bind one. */
export function clearedText(accel: Accel): string {
  const row: ControlsRow = { kind: 'accel', id: accel };
  const label = rowLabel(row);
  return padRow(row) === undefined
    ? tf('controls.cleared', { label })
    : tf('controls.clearedPad', { label });
}

/** The feedback line for a capture's outcome. */
export function outcomeText(outcome: CaptureOutcome): string {
  switch (outcome.kind) {
    case 'refused':
      return outcome.reason === 'reserved'
        ? t('controls.refused.reserved')
        : t('controls.refused.protected');
    case 'cancelled':
      return t('controls.cancelled');
    case 'bound':
      return t('controls.bound');
    case 'swapped': {
      // The captured key now sits on the target row; `holderOf` always finds it there.
      const target = holderOf(outcome.bindings, outcome.code);
      const key = glyph(outcome.code);
      const label = target === undefined ? '' : rowLabel(target.row);
      const otherLabel = rowLabel(outcome.other.row);
      if (outcome.displaced === undefined) {
        return tf('controls.swappedUnbound', { key, label, otherLabel });
      }
      const otherKey = glyph(outcome.displaced);
      // A row whose Primary and Alt traded places: name the row once.
      return target !== undefined && sameRow(target.row, outcome.other.row)
        ? tf('controls.swappedSlots', { key, otherKey, label })
        : tf('controls.swapped', { key, label, otherKey, otherLabel });
    }
  }
}

/** The feedback line for a pad capture's outcome. */
export function padOutcomeText(outcome: PadCaptureOutcome): string {
  switch (outcome.kind) {
    case 'refused':
      return outcome.reason === 'reserved'
        ? t('controls.refused.padReserved')
        : t('controls.refused.padProtected');
    case 'cancelled':
      return t('controls.cancelled');
    case 'bound':
      return t('controls.bound');
    case 'swapped': {
      // The captured index now sits on the target row; `padHolderOf` always finds it there.
      const target = padHolderOf(outcome.bindings, outcome.code);
      const key = padGlyph(outcome.code);
      const label = target === undefined ? '' : rowLabel(target);
      const otherLabel = rowLabel(outcome.other.row);
      if (outcome.displaced === undefined) {
        return tf('controls.swappedPadUnbound', { key, label, otherLabel });
      }
      return tf('controls.swapped', {
        key,
        label,
        otherKey: padGlyph(outcome.displaced),
        otherLabel,
      });
    }
  }
}
