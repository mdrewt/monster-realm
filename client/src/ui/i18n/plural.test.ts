// ui/i18n/plural.test.ts — m24-s1 RED gating tests for CLDR-total plural selection and
// locale-aware number formatting (I18N-10).
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M24-internationalization.spec.md §2.3, §6 S1 (I18N-10).
//   docs/adr/0256-i18n-module-total-catalog-resolver-cell-negative-compile.md D6.
//   memory/projects/monster-realm-m24-s1-plan.md §2 plural.ts, §9 M5/M6/M10.
//
// RED REASON: `client/src/ui/i18n/plural.ts` DOES NOT EXIST YET. The static import below fails
// to resolve at collection, redding every test in this file until the specialist ships it.
//
// FIXTURE DISCIPLINE (plan §9 M6): every locale's plural-forms fixture uses SIX PAIRWISE-DISTINCT
// strings across zero/one/two/few/many/other, so a mutant that ignores the locale, picks the
// wrong CLDR category, or always returns `other` cannot coincidentally return the RIGHT string
// for the WRONG reason.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/ADR/plan
// only.

import { describe, expect, it } from 'vitest';
import { cldr, fmtNumber, oneOther, selectPlural } from './plural';

describe('plural — CLDR-total plural selection and locale-aware number formatting (m24-s1, ADR-0256)', () => {
  it('m24s1 I18N-10: selectPlural resolves the CLDR category Intl.PluralRules picks, per-locale, across ru (4 real categories: one/few/many/other), en (2), and ar (6)', () => {
    // WRONG IMPL KILLED: a mutant that ignores `locale` and always applies English rules would
    // return `ruForms.other` for n=3 (few in ru, other in en-style two-category thinking) instead
    // of `ruForms.few` — but only because every category below holds a DISTINCT string can that
    // divergence actually be observed by `toBe`.
    const ruForms = {
      zero: 'ru-zero-x1',
      one: 'ru-one-x2',
      two: 'ru-two-x3',
      few: 'ru-few-x4',
      many: 'ru-many-x5',
      other: 'ru-other-x6',
    };
    expect(selectPlural('ru', 0, ruForms)).toBe(ruForms.many);
    expect(selectPlural('ru', 1, ruForms)).toBe(ruForms.one);
    expect(selectPlural('ru', 3, ruForms)).toBe(ruForms.few);
    expect(selectPlural('ru', 5, ruForms)).toBe(ruForms.many);
    expect(selectPlural('ru', 21, ruForms)).toBe(ruForms.one);
    expect(selectPlural('ru', 22, ruForms)).toBe(ruForms.few);

    const enForms = {
      zero: 'en-zero-y1',
      one: 'en-one-y2',
      two: 'en-two-y3',
      few: 'en-few-y4',
      many: 'en-many-y5',
      other: 'en-other-y6',
    };
    expect(selectPlural('en', 1, enForms)).toBe(enForms.one);
    expect(selectPlural('en', 0, enForms)).toBe(enForms.other);
    expect(selectPlural('en', 2, enForms)).toBe(enForms.other);

    const arForms = {
      zero: 'ar-zero-z1',
      one: 'ar-one-z2',
      two: 'ar-two-z3',
      few: 'ar-few-z4',
      many: 'ar-many-z5',
      other: 'ar-other-z6',
    };
    expect(selectPlural('ar', 0, arForms)).toBe(arForms.zero);
    expect(selectPlural('ar', 1, arForms)).toBe(arForms.one);
    expect(selectPlural('ar', 2, arForms)).toBe(arForms.two);
    expect(selectPlural('ar', 3, arForms)).toBe(arForms.few);
    expect(selectPlural('ar', 11, arForms)).toBe(arForms.many);
    expect(selectPlural('ar', 100, arForms)).toBe(arForms.other);
  });

  it('m24s1 PLURAL-CTORS: oneOther fills the four permanently-dead categories with the `other` form (frozen); cldr is a pure identity returning the SAME reference', () => {
    // WRONG IMPL KILLED (1): `oneOther(one, other)` filling the dead categories with `one`
    // instead of `other` — caught by the exact `toEqual` below.
    // WRONG IMPL KILLED (2): a non-frozen result letting a caller mutate the shared constructor
    // output out from under `selectPlural`.
    const forms = oneOther('a', 'b');
    expect(forms).toEqual({ zero: 'b', one: 'a', two: 'b', few: 'b', many: 'b', other: 'b' });
    expect(Object.isFrozen(forms), 'oneOther(...) must return a frozen object').toBe(true);

    // WRONG IMPL KILLED (3): `cldr` copying/re-wrapping its argument instead of being the
    // identity — `toBe` (reference equality), not `toEqual`, is load-bearing here.
    const cldrInput = { zero: 'z', one: 'o', two: 't', few: 'f', many: 'm', other: 'x' };
    const cldrResult = cldr(cldrInput);
    expect(cldrResult).toBe(cldrInput);
  });

  it('m24s1 PLURAL-REJECT: selectPlural and fmtNumber THROW for a locale Intl has no data for, rather than silently resolving to en-US', () => {
    // WRONG IMPL KILLED: `new Intl.PluralRules('xx')` silently resolves to en-US plural rules
    // for an unsupported/typo'd tag — a naive selectPlural/fmtNumber would ship ENGLISH rules
    // under a bogus locale string instead of failing loudly (ADR-0256 D6 / plan §9 M10).
    expect(
      Intl.PluralRules.supportedLocalesOf(['xx']).length,
      "test premise: 'xx' must genuinely have zero Intl.PluralRules support, or this test proves nothing",
    ).toBe(0);

    const forms = oneOther('a', 'b');
    expect(() => selectPlural('xx', 3, forms)).toThrow();
    expect(() => fmtNumber('xx', 1)).toThrow();
  });

  it('m24s1 FMT-NUMBER: fmtNumber formats per-locale grouping/decimal conventions and passes NumberFormatOptions through', () => {
    expect(fmtNumber('de', 1234.5)).toBe('1.234,5');
    expect(fmtNumber('en', 1234.5)).toBe('1,234.5');
    expect(fmtNumber('en', 0.5, { style: 'percent' })).toBe('50%');
  });
});
