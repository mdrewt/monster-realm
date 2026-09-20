// ui/i18n/plural.ts — CLDR-total plural selection and locale-aware number formatting
// (m24-s1, ADR-0256 D2/D6, I18N-9/I18N-10).
//
// WHY THE FORMS TYPE IS TOTAL AND NEVER `Partial` (ADR-0256 D2). Branching on `n === 1` at a
// call site is structurally incapable of Russian's four categories or Arabic's six, and a
// `Partial<Record<…>>` would let a Russian catalog omit `few` and ship a runtime blank. So
// `PluralForms` names all six `Intl.LDMLPluralRule` categories, and a two-category locale fills
// its four permanently-dead ones ONCE via `oneOther` instead of authoring them by hand. `cldr`
// is the identity for a locale that genuinely needs all six — it exists so a catalog line reads
// as a declared intent (`cldr({…})` vs `oneOther(…)`) that SHAPE-06 can check per locale.
//
// WHY AN UNSUPPORTED LOCALE THROWS (ADR-0256 D6 — reject, do not clamp, the ADR-0205 D4 stance).
// `new Intl.PluralRules('xx')` does not fail: it resolves SILENTLY to the runtime default
// (en-US), so a typo'd tag would ship English plural rules under a foreign catalog with no
// signal. `supportedLocalesOf` is the only probe that says "no data", so both entry points ask
// it first. No cache of `Intl` objects (YAGNI — chrome strings, not a hot path).

/** One string per CLDR plural category. Total by construction — see the header. */
export type PluralForms = Readonly<Record<Intl.LDMLPluralRule, string>>;

function assertLocaleSupported(kind: string, locale: string, supported: readonly string[]): void {
  if (supported.length === 0) {
    throw new Error(`i18n: no CLDR ${kind} data for locale '${locale}'`);
  }
}

/** The form for `n` under `locale`'s CLDR rules. Throws when ICU has no plural data for the
 *  locale rather than silently applying en-US rules. */
export function selectPlural(locale: string, n: number, forms: PluralForms): string {
  assertLocaleSupported('plural', locale, Intl.PluralRules.supportedLocalesOf([locale]));
  return forms[new Intl.PluralRules(locale).select(n)];
}

/** `n` formatted with `locale`'s grouping/decimal conventions; `opts` passes straight through to
 *  `Intl.NumberFormat`. Same reject-not-clamp guard as `selectPlural`. */
export function fmtNumber(locale: string, n: number, opts?: Intl.NumberFormatOptions): string {
  assertLocaleSupported('number', locale, Intl.NumberFormat.supportedLocalesOf([locale]));
  return new Intl.NumberFormat(locale, opts).format(n);
}

/** Total forms for a locale whose CLDR category set is exactly {one, other} (en, de, …): the
 *  four dead categories take `other`. Frozen so a shared constructor result cannot be mutated
 *  out from under `selectPlural`. */
export function oneOther(one: string, other: string): PluralForms {
  return Object.freeze({ zero: other, one, two: other, few: other, many: other, other });
}

/** Identity marker for a locale that needs all six categories authored by hand. Returns the SAME
 *  reference — it is a declaration of intent for the SHAPE-06 scan, not a transform. */
export function cldr(forms: PluralForms): PluralForms {
  return forms;
}
