// bindingStore.ts — the player's binding table in `localStorage['mr.controls']` (design §9,
// CTL12.4). Plain functions over an injected storage: every access is wrapped, so a browser with
// no storage (private mode, a sandboxed frame, a full quota) plays on the in-memory defaults.
//
// `parseBindings` is total: whatever the stored value is, it answers a table every input path can
// trust. Each entry falls back to its default on its own, a code is never bound twice, and the
// protected buttons always keep a key.
import {
  type Bindings,
  DEFAULT_BINDINGS,
  isBindableCode,
  type KeyCode,
  PROTECTED_BUTTONS,
} from './bindings';
import { ACCELS, type Accel, VBUTTONS, type VButton } from './buttons';

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

/** The saved table, or the defaults when there is none or the storage cannot be read. */
export function loadBindings(storage: StorageLike | null): Bindings {
  if (storage === null) return DEFAULT_BINDINGS;
  try {
    const text = storage.getItem(CONTROLS_STORAGE_KEY);
    return text === null ? DEFAULT_BINDINGS : parseBindings(JSON.parse(text));
  } catch {
    return DEFAULT_BINDINGS;
  }
}

/** Save `b` at once; false when the storage is missing or refuses the write. */
export function saveBindings(storage: StorageLike | null, b: Bindings): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(
      CONTROLS_STORAGE_KEY,
      JSON.stringify({ v: 1, buttons: b.buttons, accels: b.accels }),
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
