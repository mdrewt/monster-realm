// ui/i18n/locale.ts — BCP-47 locale negotiation and the RTL primary-subtag table
// (m24-s1, ADR-0256 D6, I18N-11).
//
// PURE: no `navigator`, no `document`, no URL — S6 owns the boot-time wiring that feeds
// `navigator.languages` in here and hands the answer to `setLocale`. Zero `RegExp` (the module
// convention ADR-0256 records): every match is `toLowerCase` + `Map`/`Set` membership and a
// `lastIndexOf('-')` truncation loop, which is all RFC 4647 §3.4 lookup needs.
//
// WHY THE RESULT IS THE `available` SPELLING. The caller indexes the resolver's registry with
// the returned tag, so it must be a key of that registry byte-for-byte — matching is
// case-insensitive (BCP-47 tags are), but the returned value is never the requested spelling.
//
// WHY AN `en`-LESS REGISTRY THROWS (reject, do not clamp — ADR-0205 D4). `'en'` is the source
// locale and the negotiation's final fallback; a registry without it is a programming error, and
// returning `'en'` anyway would hand the resolver a locale it cannot serve.

// `ReadonlySet` is the guard here — `Object.freeze` does not reach a Set's internal slots.
const RTL_PRIMARY_SUBTAGS: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'yi']);

/**
 * RFC 4647 lookup: for each `requested` tag IN ORDER, try the tag, then truncate at the last `-`
 * until an `available` tag matches case-insensitively; the first hit wins. No hit, or an empty
 * `requested`, resolves to `en`.
 */
export function negotiateLocale(
  requested: readonly string[],
  available: readonly string[],
): string {
  const byLower = new Map<string, string>();
  for (const tag of available) byLower.set(tag.toLowerCase(), tag);
  const english = byLower.get('en');
  if (english === undefined) {
    throw new Error(`i18n: available locales must include 'en' — got [${available.join(', ')}]`);
  }
  for (const tag of requested) {
    let candidate = tag.toLowerCase();
    for (;;) {
      const hit = byLower.get(candidate);
      if (hit !== undefined) return hit;
      const cut = candidate.lastIndexOf('-');
      if (cut <= 0) break;
      candidate = candidate.slice(0, cut);
    }
  }
  return english;
}

/** Whether the tag's primary language subtag is written right-to-left. A static table (ar, he,
 *  fa, ur, ps, yi) — `Intl.Locale.prototype.getTextInfo` is not universally shipped. */
export function isRtl(locale: string): boolean {
  const dash = locale.indexOf('-');
  const primary = (dash === -1 ? locale : locale.slice(0, dash)).toLowerCase();
  return RTL_PRIMARY_SUBTAGS.has(primary);
}
