// bindingStore.ts — the player's binding tables in `localStorage['mr.controls']` (design §9,
// CTL12.4). Plain functions over an injected storage: every access is wrapped, so a browser with
// no storage (private mode, a sandboxed frame, a full quota) plays on the in-memory defaults.
//
// One record holds both tables: `{v: 1, buttons, accels, pad: {buttons, accels}}`. The pad table is
// an extra key of the v1 record rather than a v2 format, because every client reads only `v`,
// `buttons` and `accels` and ignores any other key: a record with `pad` loads everywhere, and a
// record without one gives the pad defaults. Every save writes both tables, so neither remap drops
// the other.
//
// `parseBindings` and `parsePadBindings` are total: whatever the stored value is, each answers a
// table every input path can trust. Each entry falls back to its default on its own, a code or a
// pad index is never bound twice, and the protected buttons always keep a key and a pad button.
import {
  type Bindings,
  DEFAULT_BINDINGS,
  isBindableCode,
  type KeyCode,
  PROTECTED_BUTTONS,
} from './bindings';
import { ACCELS, type Accel, VBUTTONS, type VButton } from './buttons';
import {
  isBindablePadIndex,
  MENU_ACCELS,
  PAD_DEFAULT_BINDINGS,
  type PadBindings,
  type PadIndex,
} from './padBindings';
import type { MenuAccel } from './router';

export const CONTROLS_STORAGE_KEY = 'mr.controls';

/** The storage calls the store makes (a real `Storage` satisfies it). */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

// Each row has a Primary and an Alt slot.
const MAX_CODES = 2;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An own property of `side`, or undefined: never an inherited one (`__proto__`, `toString`). */
const own = (side: unknown, key: string): unknown =>
  isRecord(side) && Object.hasOwn(side, key) ? side[key] : undefined;

/** A stored entry as a code list, or undefined when it is not a valid one. */
function codeList(raw: unknown, emptyOk: boolean): KeyCode[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_CODES || (raw.length === 0 && !emptyOk)) {
    return undefined;
  }
  if (!raw.every(isBindableCode)) return undefined;
  return new Set(raw).size === raw.length ? raw : undefined;
}

/** The table a stored value stands for: the defaults for anything but a `v: 1` object. */
export function parseBindings(raw: unknown): Bindings {
  if (own(raw, 'v') !== 1) return DEFAULT_BINDINGS;
  const storedButtons = own(raw, 'buttons');
  const storedAccels = own(raw, 'accels');
  // One namespace (design §9): the stored entries claim their codes first, buttons then
  // accelerators, so a code an earlier entry claimed is dropped from a later one; only then do
  // the defaults fill the invalid or missing entries, minus every code already claimed. A bad
  // entry therefore never costs a good one its key.
  const claimed = new Set<KeyCode>();
  const claim = (codes: readonly KeyCode[]): readonly KeyCode[] =>
    Object.freeze(
      codes.filter((c) => {
        if (claimed.has(c)) return false;
        claimed.add(c);
        return true;
      }),
    );
  const buttons = {} as Record<VButton, readonly KeyCode[]>;
  const accels = {} as Record<Accel, readonly KeyCode[]>;
  for (const b of VBUTTONS) {
    const list = codeList(own(storedButtons, b), !PROTECTED_BUTTONS.includes(b));
    if (list !== undefined) buttons[b] = claim(list);
  }
  for (const a of ACCELS) {
    const list = codeList(own(storedAccels, a), true);
    if (list !== undefined) accels[a] = claim(list);
  }
  for (const b of VBUTTONS) buttons[b] ??= claim(DEFAULT_BINDINGS.buttons[b]);
  for (const a of ACCELS) accels[a] ??= claim(DEFAULT_BINDINGS.accels[a]);
  if (PROTECTED_BUTTONS.some((b) => buttons[b].length === 0)) return DEFAULT_BINDINGS;
  return Object.freeze({ buttons: Object.freeze(buttons), accels: Object.freeze(accels) });
}

// A pad row holds one button (`decision-defaulted:pad-slots=one-per-row`).
const MAX_PAD_INDICES = 1;

/** A stored pad entry as an index list, or undefined when it is not a valid one or names an index
 *  `claimed` already holds. */
function padIndexList(
  raw: unknown,
  emptyOk: boolean,
  claimed: ReadonlySet<PadIndex>,
): PadIndex[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_PAD_INDICES || (raw.length === 0 && !emptyOk)) {
    return undefined;
  }
  return raw.every((i) => isBindablePadIndex(i) && !claimed.has(i)) ? [...raw] : undefined;
}

/** The pad table a stored `pad` value stands for: the defaults for anything but an object. Its
 *  entries sit under `buttons` and `accels`, as `saveBindings` writes them. */
export function parsePadBindings(raw: unknown): PadBindings {
  if (!isRecord(raw)) return PAD_DEFAULT_BINDINGS;
  const storedButtons = own(raw, 'buttons');
  const storedAccels = own(raw, 'accels');
  // One namespace, as the keyboard's: the valid stored entries claim their index first, buttons
  // then accelerators. An entry naming an index an earlier one claimed is invalid, so it falls back
  // with the missing ones to its default minus every index already claimed.
  const claimed = new Set<PadIndex>();
  const claim = (list: readonly PadIndex[]): readonly PadIndex[] =>
    Object.freeze(
      list.filter((i) => {
        if (claimed.has(i)) return false;
        claimed.add(i);
        return true;
      }),
    );
  const buttons = {} as Record<VButton, readonly PadIndex[]>;
  const accels = {} as Record<MenuAccel, readonly PadIndex[]>;
  for (const b of VBUTTONS) {
    const list = padIndexList(own(storedButtons, b), !PROTECTED_BUTTONS.includes(b), claimed);
    if (list !== undefined) buttons[b] = claim(list);
  }
  for (const a of MENU_ACCELS) {
    const list = padIndexList(own(storedAccels, a), true, claimed);
    if (list !== undefined) accels[a] = claim(list);
  }
  for (const b of VBUTTONS) buttons[b] ??= claim(PAD_DEFAULT_BINDINGS.buttons[b]);
  for (const a of MENU_ACCELS) accels[a] ??= claim(PAD_DEFAULT_BINDINGS.accels[a]);
  if (PROTECTED_BUTTONS.some((b) => buttons[b].length === 0)) return PAD_DEFAULT_BINDINGS;
  return Object.freeze({ buttons: Object.freeze(buttons), accels: Object.freeze(accels) });
}

/** The stored record, or undefined when there is none or the storage cannot be read. */
function readRecord(storage: StorageLike | null): unknown {
  if (storage === null) return undefined;
  try {
    const text = storage.getItem(CONTROLS_STORAGE_KEY);
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The saved table, or the defaults when there is none or the storage cannot be read. */
export function loadBindings(storage: StorageLike | null): Bindings {
  const record = readRecord(storage);
  return record === undefined ? DEFAULT_BINDINGS : parseBindings(record);
}

/** The saved pad table, read from the same record: the defaults when there is none, it is not a
 *  `v: 1` record, or the storage cannot be read. */
export function loadPadBindings(storage: StorageLike | null): PadBindings {
  const record = readRecord(storage);
  return own(record, 'v') === 1 ? parsePadBindings(own(record, 'pad')) : PAD_DEFAULT_BINDINGS;
}

/** Save both tables at once; false when the storage is missing or refuses the write. */
export function saveBindings(storage: StorageLike | null, b: Bindings, pad: PadBindings): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(
      CONTROLS_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        buttons: b.buttons,
        accels: b.accels,
        pad: { buttons: pad.buttons, accels: pad.accels },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** The page's localStorage, or null where reading it throws (a sandboxed or opaque origin). */
export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
