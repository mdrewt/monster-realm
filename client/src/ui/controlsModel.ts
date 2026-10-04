// ui/controlsModel.ts — the rules of Options › Controls (design §9, CTL12.1-CTL12.3, CTL12.7).
// Pure: no DOM, storage or module state. A view captures a real key press and asks `captureKey`
// what it does to the table; the shell saves whatever table comes back (`saveBindings`).
//
// Every row has a Primary and an Alt slot over one key namespace shared by the buttons and the
// accelerators. A captured key held elsewhere swaps with the slot's old key; the protected buttons
// (`PROTECTED_BUTTONS`) always keep one, so no capture can lock the player out. A row is a list,
// so a row whose Primary loses its key moves its Alt up.
import { type Bindings, isBindableCode, type KeyCode, PROTECTED_BUTTONS } from '../input/bindings';
import { ACCELS, type Accel, VBUTTONS, type VButton } from '../input/buttons';
import { glyph } from '../input/glyphs';
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

export type CaptureOutcome =
  | { readonly kind: 'refused'; readonly reason: 'reserved' | 'protected' }
  /** The press named the key the slot already shows: capture ends with the table unchanged. */
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'bound'; readonly bindings: Bindings }
  /** The key was bound at `other`, which now holds `displaced` (or lost its key). */
  | {
      readonly kind: 'swapped';
      readonly bindings: Bindings;
      readonly other: SlotTarget;
      readonly code: KeyCode;
      readonly displaced: KeyCode | undefined;
    };

const BUTTON_ROWS: readonly ControlsRow[] = VBUTTONS.map((id) => ({ kind: 'button', id }));
const ACCEL_ROWS: readonly ControlsRow[] = ACCELS.map((id) => ({ kind: 'accel', id }));

/** A tab's rows, in display order: the twelve buttons, or every accelerator. */
export function controlsRows(tab: ControlsTab): readonly ControlsRow[] {
  return tab === 'buttons' ? BUTTON_ROWS : ACCEL_ROWS;
}

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
  F9: () => t('controls.accel.bugReport'),
  F8: () => t('controls.accel.dismissError'),
};

/** What a row is called ("Confirm (A)", "Bag"). */
export function rowLabel(row: ControlsRow): string {
  return row.kind === 'button' ? BUTTON_LABELS[row.id]() : ACCEL_LABELS[row.id]();
}

/** The line shown while a slot of `row` waits for a key. */
export function capturePrompt(row: ControlsRow): string {
  return tf('controls.capture.prompt', { label: rowLabel(row) });
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

/** Clear on an accelerator row (CTL12.7): both slots unbound, so its key does nothing until it is
 *  bound again. Button rows have no Clear: a protected button can never be emptied. */
export function clearAccel(b: Bindings, accel: Accel): Bindings {
  return withRow(b, { kind: 'accel', id: accel }, []);
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
