// ui/a11yCopy.ts — the accessible-name resolver the overlays, the announcements and the world
// region read their names through.
//
// THE COPY LIVES IN THE I18N CATALOGS. The `a11y.*` entries are part of `catalog.en.ts` and
// `catalog.fr.ts` (typed by `A11yKey` in `i18n/messageIds.ts`), so every registered locale is
// total over them and `t` here answers in the current locale. The key shape is
// `a11y.<namespace>.<…>` with the OverlayId kept VERBATIM — `a11y.overlay.boxView.title`, capital
// V — so the key is DERIVABLE from `OverlayId` with zero mapping table. No ICU syntax: `{`/`}` are
// banned in an a11y value, and that ban is gated in catalogShape.test.ts.
//
// WHY `t` THROWS RATHER THAN RETURNING THE KEY (reject, do not clamp; the same
// reasoning as `anyVisible`'s deliberate absence of a try/catch, ui/overlayRegistry.ts:366).
// Both silent alternatives have a user-visible cost:
//   - returning the key announces the literal "a11y.overlay.boxView.title" to a screen-reader
//     user, and it makes an UNWIRED catalog look wired;
//   - returning '' ships an UNLABELLED dialog, a WORSE WCAG failure than shipping no dialog
//     role at all.
// `t` takes a plain `string` because `OVERLAY_A11Y[id].labelKey` is one; it is TOTAL on the
// domain CI guarantees (A11Y-4 makes an unresolvable `labelKey` a CI failure), so in shipped code
// the throw is unreachable. Its message names the key so a caller can tell WHICH entry is unwired.

import { CATALOG_EN } from './i18n/catalog.en';
import type { A11yKey } from './i18n/messageIds';
import { CATALOGS, currentLocale } from './i18n/resolver';

/** True for a key of the `a11y.*` namespace that the catalogs define. `Object.hasOwn`, NOT `in`:
 *  `in` is true for `toString`, `constructor` and the other `Object.prototype` names. */
const isA11yKey = (key: string): key is A11yKey =>
  key.startsWith('a11y.') && Object.hasOwn(CATALOG_EN, key);

/**
 * The English `a11y.*` entries, as a flat frozen record — a read-only view of `CATALOG_EN` for
 * tests and gates that enumerate the namespace (the set-equality gate against `OVERLAY_IDS`, the
 * brace check). Runtime names never come from here: they come from `t`, in the current locale.
 */
export const a11yCopy: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.keys(CATALOG_EN)
      .filter(isA11yKey)
      .map((key) => [key, CATALOG_EN[key]]),
  ),
);

/**
 * Resolve one `a11y.*` key in the current locale. THROWS on any other key, naming it. Never returns
 * the key, never returns '', never caches, never mutates.
 */
export function t(key: string): string {
  if (!isA11yKey(key)) {
    throw new Error(`a11yCopy: no entry for key '${key}' — the catalog is unwired for this key`);
  }
  return CATALOGS[currentLocale()][key];
}
