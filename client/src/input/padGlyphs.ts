// padGlyphs.ts — the keycap a player sees for a pad button, and the one place a chip's keycap is
// chosen between the keyboard and the pad. One glyph family for every pad, named for the Xbox
// layout the virtual buttons are named after: the labels printed on the hardware stay literal in
// every locale, the unlabelled buttons (View, Menu, the D-pad) read from the catalog per call, so a
// locale switch shows at the next render.
import { t, tf } from '../ui/i18n/resolver';
import type { Bindings } from './bindings';
import type { VButton } from './buttons';
import { glyph } from './glyphs';
import type { PadBindings, PadIndex } from './padBindings';

/** Which device the player last pressed: the keycaps follow it. */
export type InputSource = 'keys' | 'pad';

// The standard mapping's labelled buttons, as printed on the pad.
const LABELS: Readonly<Record<PadIndex, string>> = {
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LB',
  5: 'RB',
  6: 'LT',
  7: 'RT',
  10: 'LS',
  11: 'RS',
};

/** The glyph of pad button `i`; any index outside the standard table reads as its generic name
 *  with its number, so a glyph is never empty. */
export function padGlyph(i: PadIndex): string {
  if (Object.hasOwn(LABELS, i)) return LABELS[i];
  switch (i) {
    case 8:
      return t('pad.view');
    case 9:
      return t('pad.menu');
    case 12:
      return t('pad.dpadUp');
    case 13:
      return t('pad.dpadDown');
    case 14:
      return t('pad.dpadLeft');
    case 15:
      return t('pad.dpadRight');
    default:
      return tf('pad.button', { n: i });
  }
}

/** A button's keycap from `source`'s table: the glyph of its first binding, '' when it has none. */
export function keycapFor(
  source: InputSource,
  keys: Bindings,
  pad: PadBindings,
): (button: VButton) => string {
  if (source === 'pad') {
    return (button) => {
      const i = pad.buttons[button][0];
      return i === undefined ? '' : padGlyph(i);
    };
  }
  return (button) => {
    const code = keys.buttons[button][0];
    return code === undefined ? '' : glyph(code);
  };
}
