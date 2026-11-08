// ui/displayPrefs.ts — the player's text size in `localStorage['mr.display']` (uif-13, #586 D1).
// Plain functions over an injected storage and root, the bindingStore precedent: every storage access
// is wrapped, so a browser with no storage plays at Normal.
//
// The step reaches the page as `--mr-text-step` on `documentElement`, which the one rem rule in
// styles.css multiplies into the root font size beside `--mr-ui-scale`. The step never touches
// `--mr-ui-scale` or the world's `deviceScale`: the text grows, the world does not.
import type { StorageLike } from '../input/bindingStore';

export const DISPLAY_STORAGE_KEY = 'mr.display';

/** The text-size steps, in display order. */
export const TEXT_STEPS = ['normal', 'large', 'xlarge'] as const;
export type TextStep = (typeof TEXT_STEPS)[number];

/** Each step's multiplier on the root font size (×1.5 is fine on a vector font; none is pixel). */
export const TEXT_STEP_SCALE: Readonly<Record<TextStep, number>> = Object.freeze({
  normal: 1,
  large: 1.5,
  xlarge: 2,
});

/** The property the root rem rule reads. */
export const TEXT_STEP_PROP = '--mr-text-step';

const DEFAULT_STEP: TextStep = 'normal';

const isTextStep = (v: unknown): v is TextStep =>
  typeof v === 'string' && (TEXT_STEPS as readonly string[]).includes(v);

/** An own property of a plain record, or undefined: never an inherited one. */
const own = (raw: unknown, key: string): unknown =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.hasOwn(raw, key)
    ? (raw as Record<string, unknown>)[key]
    : undefined;

/** The step a stored value stands for: Normal for anything but a `v: 1` object naming a step. */
export function parseTextStep(raw: unknown): TextStep {
  if (own(raw, 'v') !== 1) return DEFAULT_STEP;
  const step = own(raw, 'textStep');
  return isTextStep(step) ? step : DEFAULT_STEP;
}

/** The saved step, or Normal when there is none or the storage cannot be read. Never writes. */
export function loadTextStep(storage: StorageLike | null): TextStep {
  if (storage === null) return DEFAULT_STEP;
  try {
    const text = storage.getItem(DISPLAY_STORAGE_KEY);
    return typeof text === 'string' ? parseTextStep(JSON.parse(text)) : DEFAULT_STEP;
  } catch {
    return DEFAULT_STEP;
  }
}

/** Save `step` at once; false when the storage is missing or refuses the write. */
export function saveTextStep(storage: StorageLike | null, step: TextStep): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify({ v: 1, textStep: step }));
    return true;
  } catch {
    return false;
  }
}

/** Write `step` on the root: the one property, nothing else. */
export function applyTextStep(
  root: { readonly style: Pick<CSSStyleDeclaration, 'setProperty'> },
  step: TextStep,
): void {
  root.style.setProperty(TEXT_STEP_PROP, String(TEXT_STEP_SCALE[step]));
}
