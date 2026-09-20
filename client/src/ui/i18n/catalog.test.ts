// ui/i18n/catalog.test.ts — m24-s1 RED gating tests for the English catalog: the `// @desc:`
// adjacency scan, the key grammar, catalog-wide shape invariants, and the oneOther-misuse
// proof-of-teeth (SHAPE-01, SHAPE-02, SHAPE-03, SHAPE-06).
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M24-internationalization.spec.md §2.3, §2.6 [I18N-SHAPE-06].
//   docs/adr/0256-i18n-module-total-catalog-resolver-cell-negative-compile.md D2, D5.
//   memory/projects/monster-realm-m24-s1-plan.md §2 catalog.en.ts, §9 M9/L11/L12/L13.
//
// RED REASON: `client/src/ui/i18n/catalog.en.ts` DOES NOT EXIST YET. The static import below
// fails to resolve at collection, redding every test in this file until the specialist ships it.
//
// KEY-GRAMMAR DEVIATION (ADR-0256 D5, plan §1): segments `[a-z][a-zA-Z0-9]*`, at least two,
// dot-separated. Spec §5.4's own `[a-z0-9]+` rejects the spec's own `chrome.helpHint` example —
// `isValidKey` below encodes the ADR-0205-precedented correction, NOT the spec's literal regex.
//
// `@desc` ADJACENCY (plan §9 L11): the contiguous run of `//` comment lines IMMEDIATELY ABOVE an
// entry line must contain a `// @desc:` line with >=10 non-whitespace characters after the
// marker. An entry line is recognised by LINE-START quoted-key-then-colon so a key merely
// ECHOED inside a comment never counts as an entry (plan §9 L13).
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/ADR/plan
// only.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The comment stripper is IMPORTED, never copied (ADR-0215 single-owner rule). Precedent for a
// `.ts` test importing a `.mjs` eval: client/src/ui/i18n-no-html-sink.test.ts:45 (one `..`
// shallower — this file sits one directory deeper, under `ui/i18n/`).
import { stripComments } from '../../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { CATALOG_EN } from './catalog.en';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_EN_PATH = path.join(I18N_DIR, 'catalog.en.ts');
const RAW_SOURCE = readFileSync(CATALOG_EN_PATH, 'utf8');

/** Hand-rolled charCode scanner (no RegExp): >=2 dot-separated segments, each
 *  `[a-z][a-zA-Z0-9]*` — ADR-0256 D5's corrected grammar. */
function isValidKey(key: string): boolean {
  const segments = key.split('.');
  if (segments.length < 2) return false;
  for (const seg of segments) {
    if (seg.length === 0) return false;
    const first = seg.charCodeAt(0);
    if (first < 97 || first > 122) return false; // 'a'-'z'
    for (let i = 1; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      const isLower = c >= 97 && c <= 122;
      const isUpper = c >= 65 && c <= 90;
      const isDigit = c >= 48 && c <= 57;
      if (!isLower && !isUpper && !isDigit) return false;
    }
  }
  return true;
}

/** `indexOf`-loop occurrence counter — no RegExp, reused by the `satisfies Catalog` /
 *  `Object.freeze(` belt-and-braces text pins below. */
function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

interface EntryLine {
  readonly key: string;
  readonly lineIndex: number;
}

/** An entry line is recognised by LINE-START (post-indentation) quoted key immediately followed
 *  by a colon — never a key merely echoed inside a `//` comment (plan §9 L13). */
function scanEntryLines(source: string): EntryLine[] {
  const lines = source.split('\n');
  const out: EntryLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("'")) continue;
    const closeQuote = trimmed.indexOf("'", 1);
    if (closeQuote === -1) continue;
    const afterQuote = trimmed.slice(closeQuote + 1).trimStart();
    if (!afterQuote.startsWith(':')) continue;
    out.push({ key: trimmed.slice(1, closeQuote), lineIndex: i });
  }
  return out;
}

/** For every entry line, walks the contiguous `//` comment block immediately above it and
 *  requires a `// @desc:` line with >=10 non-whitespace characters after the marker. Returns the
 *  keys that FAIL. */
function findDescViolations(source: string): string[] {
  const lines = source.split('\n');
  const violations: string[] = [];
  for (const entry of scanEntryLines(source)) {
    let j = entry.lineIndex - 1;
    let hasDesc = false;
    while (j >= 0) {
      const commentLine = lines[j].trim();
      if (!commentLine.startsWith('//')) break;
      if (commentLine.startsWith('// @desc:')) {
        const rest = commentLine.slice('// @desc:'.length);
        let nonWs = 0;
        for (let k = 0; k < rest.length; k++) {
          const ch = rest[k];
          if (ch !== ' ' && ch !== '\t' && ch !== '\r') nonWs += 1;
        }
        if (nonWs >= 10) hasDesc = true;
      }
      j -= 1;
    }
    if (!hasDesc) violations.push(entry.key);
  }
  return violations;
}

/** [I18N-SHAPE-06]: `oneOther` may only be used, in a locale's catalog source, for a locale
 *  whose Intl.PluralRules category set is exactly {one, other}. Throws naming the locale and its
 *  real category set otherwise. */
function checkOneOtherUsage(localeTag: string, source: string): void {
  if (!source.includes('oneOther(')) return;
  const categories = new Intl.PluralRules(localeTag).resolvedOptions().pluralCategories;
  const isTwoCategory =
    categories.length === 2 && categories.includes('one') && categories.includes('other');
  if (!isTwoCategory) {
    throw new Error(
      `oneOther( used in a catalog for locale '${localeTag}' whose CLDR category set is ${JSON.stringify(categories)} — exceeds {one, other}; author with cldr(...) instead`,
    );
  }
}

describe('catalog.en — the English catalog: @desc adjacency, key grammar, and shape invariants (m24-s1, ADR-0256)', () => {
  it('m24s1 SHAPE-01: every catalog.en.ts entry line has an immediately-adjacent `// @desc:` comment with >=10 non-whitespace characters', () => {
    const violations = findDescViolations(RAW_SOURCE);
    expect(
      violations,
      `entries missing an adjacent @desc comment (>=10 non-ws chars): ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it("m24s1 SHAPE-02: CATALOG_EN['chrome.helpHint'] is <=47 characters, and is exactly 38 today", () => {
    const value = (CATALOG_EN as Record<string, unknown>)['chrome.helpHint'];
    expect(typeof value, "CATALOG_EN['chrome.helpHint'] must be a string").toBe('string');
    expect((value as string).length).toBeLessThanOrEqual(47);
    expect((value as string).length).toBe(38);
  });

  it('m24s1 SHAPE-03: the ADR-0256 D5 key grammar (>=2 dot-segments, each [a-z][a-zA-Z0-9]*) accepts the boundary-valid fixtures, rejects the boundary-invalid fixtures, and accepts every real CATALOG_EN key', () => {
    const validFixtures = ['a.b', 'chrome.helpHint', 'chrome.status.disconnected'];
    const invalidFixtures = [
      'chrome',
      'chrome.',
      '.chrome',
      'chrome..status',
      'Battle.HPLine',
      'chrome.help_hint',
      'chrome.1x',
      'chrome.help-hint',
      'chrome.helpHint ',
    ];
    for (const f of validFixtures) {
      expect(isValidKey(f), `${f} must be VALID`).toBe(true);
    }
    for (const f of invalidFixtures) {
      expect(isValidKey(f), `${f} must be INVALID`).toBe(false);
    }

    const realKeys = Object.keys(CATALOG_EN as Record<string, unknown>);
    expect(realKeys.length > 0, 'ANTI-VACUITY: CATALOG_EN must not be empty').toBe(true);
    for (const key of realKeys) {
      expect(isValidKey(key), `real key ${key} must satisfy the grammar`).toBe(true);
    }
  });

  it("m24s1 CATALOG-SHAPE: CATALOG_EN is frozen, its source entry-line count matches Object.keys, no own prototype-name keys, every value resolves to a non-empty string, the key roster is exactly the plan's 10, and the source spells `satisfies Catalog` + `Object.freeze(` exactly once each", () => {
    expect(Object.isFrozen(CATALOG_EN), 'CATALOG_EN must be Object.freeze()d').toBe(true);

    const keys = Object.keys(CATALOG_EN as Record<string, unknown>);
    const entryLineCount = scanEntryLines(RAW_SOURCE).length;
    expect(
      entryLineCount,
      'the number of line-start-quoted-key entry lines in catalog.en.ts must equal Object.keys(CATALOG_EN).length — a key merely echoed in a comment must not count',
    ).toBe(keys.length);

    for (const forbidden of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(
        Object.hasOwn(CATALOG_EN as object, forbidden),
        `CATALOG_EN must not have an OWN key named ${forbidden}`,
      ).toBe(false);
    }

    let checked = 0;
    for (const key of keys) {
      const value = (CATALOG_EN as Record<string, unknown>)[key];
      if (typeof value === 'function') {
        const result = (value as (p: { where: string }) => string)({ where: 'x' });
        expect(typeof result, `${key}(...) must return a string`).toBe('string');
        expect(result.length > 0, `${key}(...) must return a non-empty string`).toBe(true);
      } else {
        expect(typeof value, `CATALOG_EN[${key}] must be a string or a function`).toBe('string');
        expect((value as string).length > 0, `CATALOG_EN[${key}] must be non-empty`).toBe(true);
      }
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every catalog key must have been examined').toBe(keys.length);

    const expectedKeys = [
      'chrome.helpHint',
      'chrome.help.title',
      'chrome.rename.submit',
      'chrome.tradePropose.submit',
      'chrome.status.exportBlocked',
      'chrome.status.privacyOverlayBusy',
      'chrome.status.disconnected',
      'chrome.status.contentStale',
      'chrome.status.bugBundleBlocked',
      'chrome.status.healUnavailable',
    ]
      .slice()
      .sort();
    expect(keys.slice().sort()).toEqual(expectedKeys);

    // Belt-and-braces TEXT pin (test-review round), scoped to this OWNED file: `satisfies
    // Catalog` restores the excess-property check that `Object.freeze<T>`'s generic signature
    // would otherwise swallow (plan §2 D2), and both structural checks above (Object.isFrozen,
    // the exact key-roster/stowaway checks) remain the REAL runtime backstop if this text pin is
    // ever weakened or the clause is dropped without breaking either of them.
    const strippedSource = stripComments(RAW_SOURCE);
    expect(
      countOccurrences(strippedSource, 'satisfies Catalog'),
      "catalog.en.ts must spell 'satisfies Catalog' exactly once",
    ).toBe(1);
    expect(
      countOccurrences(strippedSource, 'Object.freeze('),
      "catalog.en.ts must call 'Object.freeze(' exactly once",
    ).toBe(1);
  });

  it('m24s1 SHAPE-06: checkOneOtherUsage BITES when oneOther( appears in a catalog for a locale whose CLDR set exceeds {one, other}, and is silent for en; every real catalog.<tag>.ts in the i18n directory passes it', () => {
    // PROOF-OF-TEETH, asserted first: the helper itself must actually discriminate before it is
    // trusted on real files.
    expect(() => checkOneOtherUsage('ru', "x: oneOther('a','b')")).toThrow();
    expect(() => checkOneOtherUsage('en', "x: oneOther('a','b')")).not.toThrow();

    const found: string[] = [];
    for (const entry of readdirSync(I18N_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith('catalog.')) continue;
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      const tag = entry.name.slice('catalog.'.length, entry.name.length - '.ts'.length);
      const source = readFileSync(path.join(I18N_DIR, entry.name), 'utf8');
      found.push(tag);
      checkOneOtherUsage(tag, source);
    }
    expect(
      found.length > 0,
      `ANTI-VACUITY: at least catalog.en.ts must have been found under ${I18N_DIR}`,
    ).toBe(true);
  });
});
