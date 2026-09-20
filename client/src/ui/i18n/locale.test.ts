// ui/i18n/locale.test.ts — m24-s1 RED gating tests for BCP-47 locale negotiation and the RTL
// primary-subtag table (I18N-11).
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M24-internationalization.spec.md §2.7, §6 S1 (I18N-11).
//   docs/adr/0256-i18n-module-total-catalog-resolver-cell-negative-compile.md D6.
//   memory/projects/monster-realm-m24-s1-plan.md §2 locale.ts, §9 M7/M8.
//
// RED REASON: `client/src/ui/i18n/locale.ts` DOES NOT EXIST YET. The static import below fails
// to resolve at collection, redding every test in this file until the specialist ships it.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/ADR/plan
// only.

import { describe, expect, it } from 'vitest';
import { isRtl, negotiateLocale } from './locale';

describe('locale — RFC 4647 BCP-47 negotiation and the RTL primary-subtag table (m24-s1, ADR-0256)', () => {
  it('m24s1 I18N-11: negotiateLocale is a per-tag, in-order RFC 4647 lookup with truncation fallback, case-insensitive matching, exact-beats-truncated preference, and an en-less available set throws', () => {
    // WRONG IMPL KILLED (1): a mutant returning `requested[0]` verbatim instead of the matched
    // `available` spelling — killed by the ['fr'],['en','FR'] -> 'FR' case (case differs).
    expect(negotiateLocale(['fr-CA'], ['en', 'fr'])).toBe('fr');
    // WRONG IMPL KILLED (2): a mutant that never falls back to 'en' on a total miss.
    expect(negotiateLocale(['de'], ['en', 'fr'])).toBe('en');
    // Empty requested list -> 'en'.
    expect(negotiateLocale([], ['en', 'fr'])).toBe('en');
    // WRONG IMPL KILLED (3): a mutant doing case-sensitive comparison — 'FR-ca' must still match
    // the available 'fr'.
    expect(negotiateLocale(['FR-ca'], ['en', 'fr'])).toBe('fr');
    // WRONG IMPL KILLED (4): the RETURNED string must be the AVAILABLE set's spelling, not the
    // requested tag's — 'fr' requested against an available 'FR' returns 'FR'.
    expect(negotiateLocale(['fr'], ['en', 'FR'])).toBe('FR');
    // WRONG IMPL KILLED (5): a mutant that ALWAYS truncates before matching — an exact match in
    // the available set must win over a truncated one when both are present.
    expect(negotiateLocale(['fr-CA', 'en'], ['en', 'fr-CA', 'fr'])).toBe('fr-CA');
    // WRONG IMPL KILLED (6): a mutant that tries all requested tags UNORDERED (e.g. sorts them,
    // or picks the best match across the whole list) instead of walking requested tags IN ORDER
    // and returning the FIRST that resolves — 'de' has no match at all (not even truncated), so
    // the chain must fall through to 'fr-CA' -> 'fr', in requested order.
    expect(negotiateLocale(['de', 'fr-CA'], ['en', 'fr'])).toBe('fr');
    // WRONG IMPL KILLED (7): a mutant that only truncates ONCE — 'zh-Hant-TW' needs TWO
    // truncations ('zh-Hant-TW' -> 'zh-Hant' -> 'zh') before it matches the available 'zh'.
    expect(negotiateLocale(['zh-Hant-TW'], ['zh', 'en'])).toBe('zh');
    // A private-use singleton subtag ('-x-') truncates through to the bare language via the
    // SAME plain `lastIndexOf('-')` loop as any other subtag — no dedicated singleton-drop
    // branch is required: 'fr-x-priv' -> 'fr-x' (no match) -> 'fr' (match).
    expect(negotiateLocale(['en-x-priv'], ['en', 'fr'])).toBe('en');
    expect(negotiateLocale(['fr-x-priv'], ['en', 'fr'])).toBe('fr');
    // An available set lacking 'en' is a programming error — negotiateLocale must throw rather
    // than return a locale the resolver cannot actually serve.
    expect(() => negotiateLocale(['fr'], ['fr'])).toThrow();
  });

  it("m24s1 IS-RTL: isRtl is a primary-subtag table over {ar,he,fa,ur,ps,yi} — region-tagged and case-varied forms still resolve true, en/fr/'' resolve false", () => {
    for (const code of ['ar', 'he', 'fa', 'ur', 'ps', 'yi']) {
      expect(isRtl(code), `${code} must be RTL`).toBe(true);
    }
    // Region subtags and mixed case must not defeat the primary-subtag lookup.
    expect(isRtl('ar-SA')).toBe(true);
    expect(isRtl('AR-EG')).toBe(true);
    expect(isRtl('he-IL')).toBe(true);
    // Non-RTL languages, including a region-tagged one, and the empty string.
    expect(isRtl('en')).toBe(false);
    expect(isRtl('en-US')).toBe(false);
    expect(isRtl('fr')).toBe(false);
    expect(isRtl('')).toBe(false);
  });
});
