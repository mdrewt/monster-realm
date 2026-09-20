// ui/i18n/resolver.ts — the catalog registry, the module-level locale cell, and the `t()`/`tf()`
// resolvers (m24-s1, ADR-0256 D1, M24 §2.3/§2.8).
//
// WHERE THE LOCALE LIVES (ADR-0256 D1). `t(key): string` is pinned byte-identical to M23 §2.8
// (`[I18N-SHAPE-05]`) and `tf(key, params): string` mirrors it — neither takes a locale, so the
// locale is ONE module-level cell read by both. A `createResolver()` factory was rejected: the
// shape pin wants a named module `t`, so a factory would need the same singleton underneath.
// Zero IO: nothing here reads `navigator`, `document` or a URL — S6 negotiates at boot
// (`locale.ts`) and calls `setLocale` once.
//
// WHY `setLocale` THROWS ON AN UNREGISTERED LOCALE (D1, rejected alternative (c)). Clamping to
// `en` would make an unwired locale look wired — the vacuity ADR-0205 D4 exists to kill. The cell
// is left unchanged on the throw. There is no per-call fallback to `en` in `t`/`tf` either: the
// `Catalog` type makes every registered locale total (ADR-0256 D2), so a miss can only be a key
// that is not a `MessageId` at all, and that is a bug to surface, not paper over.
//
// WHY `t`/`tf` THROW RATHER THAN RETURNING THE KEY OR '' — the `a11yCopy.t` reasoning verbatim
// (ADR-0205 D4): the key text on screen makes an unwired catalog look wired, and '' ships a blank
// label. Both are TOTAL on the domain the types admit (a `PlainMessageId` / `ParamMessageId` is
// always present in a total catalog), so every throw below is a fail-loud backstop for a caller
// that lied to the type system (`as never`, a JS caller); each message names the key.

import { CATALOG_EN } from './catalog.en';
import type {
  A11yKey,
  Catalog,
  MessageId,
  MessageParams,
  ParamMessageId,
  PlainMessageId,
} from './messageIds';

/** The source locale; the cell's initial value and the negotiation fallback. */
export const DEFAULT_LOCALE = 'en';

/** Every registered catalog by BCP-47 tag. Frozen: registration is a source edit (S7 adds `fr`
 *  here), never a runtime `registerCatalog` hook — a runtime hook is exactly the seam through
 *  which a partial catalog would arrive untyped. */
export const CATALOGS: Readonly<Record<string, Catalog>> = Object.freeze({ en: CATALOG_EN });

let current: string = DEFAULT_LOCALE;

/** Switch the cell to a REGISTERED locale. Throws — cell unchanged — for any other tag. */
export function setLocale(locale: string): void {
  if (!Object.hasOwn(CATALOGS, locale)) {
    throw new Error(
      `i18n: locale '${locale}' is not registered — CATALOGS has [${Object.keys(CATALOGS).join(', ')}]`,
    );
  }
  current = locale;
}

/** The tag the resolvers read from right now. */
export function currentLocale(): string {
  return current;
}

/** The single miss path shared by both resolvers. `Object.hasOwn`, not `in`: `'constructor' in
 *  catalog` is TRUE via Object.prototype, and the test suite pins that a prototype name throws
 *  the SAME message as an ordinary absent key. Checked before any `typeof` so the miss message is
 *  a pure function of the key. */
function lookup(key: string): Catalog[MessageId] {
  const catalog = CATALOGS[current];
  if (!Object.hasOwn(catalog, key)) {
    throw new Error(
      `i18n: no entry for key '${key}' in locale '${current}' — the catalog is unwired for this key`,
    );
  }
  return catalog[key as MessageId];
}

/** Resolve a plain (parameterless) message in the current locale. */
export function t(key: A11yKey | PlainMessageId): string {
  const entry = lookup(key);
  if (typeof entry !== 'string') {
    throw new Error(`i18n: key '${key}' is a parameterized message — use tf()`);
  }
  return entry;
}

/** Resolve a parameterized message in the current locale; `params` is typed by the key. */
export function tf<K extends ParamMessageId>(key: K, params: MessageParams[K]): string {
  const entry = lookup(key);
  if (typeof entry !== 'function') {
    throw new Error(`i18n: key '${key}' is a plain message — use t()`);
  }
  // The ONE narrowing in this module. `lookup` returns the union of every key's branch, so once a
  // second `MessageParams` entry exists the narrowed `entry` is a union of closures whose call
  // signature is the INTERSECTION of their params — uncallable with `MessageParams[K]`. The cast
  // is sound: `Object.hasOwn` + `typeof === 'function'` established that `entry` is K's own
  // closure, and `Catalog` types that closure as exactly `(p: MessageParams[K]) => string`.
  const fn = entry as (p: MessageParams[K]) => string;
  return fn(params);
}
