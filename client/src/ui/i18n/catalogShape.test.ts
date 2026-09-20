// ui/i18n/catalogShape.test.ts — the §5.4 catalog-shape gate: SHAPE-01..06 (m24-s6, I18N-24 /
// I18N-25 / I18N-33, ADR-0262 pending; grammar per ADR-0256 D5).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M24-internationalization.spec.md §5.4
// [I18N-SHAPE-01..06], §6 I18N-24/I18N-25/I18N-33; docs/adr/0256 D5 (SHAPE-03 grammar
// correction); docs/adr/0262 (pending, m24-s6) records the vehicle for this file.
//
// WHY THIS IS A CO-LOCATED TEST, NOT AN EVAL (ADR-0224/ADR-0257): the spec's own vocabulary
// implies a standalone `evals/i18n-catalog-shape.eval.mjs`; ADR-0224 (2026-09-01) retired new
// `evals/*.eval.mjs` files, so the equivalent invariant ships as this ordinary vitest suite,
// discovered by vitest's `src/**/*.test.ts` include and run by `just ci`'s client stage — same
// shape as ui/i18n-no-html-sink.test.ts (S0) and ui/i18n/catalog.test.ts (S1).
//
// RED STATE AT HEAD: every LIVE assertion below is GREEN-ON-ARRIVAL — this gate exists to keep
// the real tree honest going forward (S7's catalog.fr.ts in particular), not to red anything
// m24-s6 ships. Each BAD/GOOD/vacuity FIXTURE is asserted EXACTLY ONCE as the proof-of-teeth: no
// gate-auditing-the-gate, no fixture reused across two assertions to inflate apparent coverage.
//
// ZERO RegExp anywhere in this file (ADR-0055 — a regex literal also blinds the single-owner
// `stripComments` this file imports): every match is `String.indexOf` / `charCodeAt` / a
// hand-rolled char-class walk, exactly like ui/i18n/catalog.test.ts and ui/i18n-no-html-sink.test.ts.
//
// Every assertion message below names the WRONG IMPLEMENTATION it kills (a parser that scans the
// whole file instead of the adjacent block, a `.length` width check instead of code-point, an
// `.includes` grammar check, a `.`-receiver exemption, a `t.length` signature proxy, a raw
// `oneOther(` call-shape scan instead of an identifier-token scan) so a reviewer can tell WHY a
// fixture exists without re-deriving it from the spec.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The comment stripper is IMPORTED, never copied (ADR-0215 single-owner rule). Same path as
// ui/i18n/catalog.test.ts:31.
import { stripComments } from '../../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { a11yCopy } from '../a11yCopy';
import { CATALOGS } from './resolver';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.resolve(I18N_DIR, '..', '..');

// ---------------------------------------------------------------------------
// Shared primitives (no RegExp).
// ---------------------------------------------------------------------------

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isIdentChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 || // _
    c === 36 // $
  );
}

function startsWith(s: string, prefix: string): boolean {
  if (s.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (s.charAt(i) !== prefix.charAt(i)) return false;
  }
  return true;
}

/** Word-boundary occurrence count of `token` in `src`: the char immediately before and after the
 *  match must not be an identifier char. Used for the `export function t<` / `export const t`
 *  pins (SHAPE-05) so `total` never counts as `t`. */
function countWordBoundaryOccurrences(src: string, token: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = src.indexOf(token, from);
    if (at === -1) break;
    from = at + token.length;
    const before = at > 0 ? src.charAt(at - 1) : '';
    const afterIdx = at + token.length;
    const after = afterIdx < src.length ? src.charAt(afterIdx) : '';
    if (!isIdentChar(before) && !isIdentChar(after)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Shared precondition: every SHAPE test calls this FIRST. Kills the "mis-named or unregistered
// S7 catalog file" vacuity, where every downstream SHAPE check would silently scan nothing.
// ---------------------------------------------------------------------------

interface DiscoveredCatalog {
  readonly locale: string;
  readonly file: string;
  readonly raw: string;
}

function discoverCatalogFiles(): DiscoveredCatalog[] {
  const out: DiscoveredCatalog[] = [];
  for (const entry of readdirSync(I18N_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!startsWith(name, 'catalog.') || !name.endsWith('.ts') || name.endsWith('.test.ts')) {
      continue;
    }
    const locale = name.slice('catalog.'.length, name.length - '.ts'.length);
    out.push({ locale, file: name, raw: readFileSync(path.join(I18N_DIR, name), 'utf8') });
  }
  return out;
}

/** Every SHAPE-0N LIVE `it` calls this first. */
function discoverAndVerifyCatalogs(): DiscoveredCatalog[] {
  const discovered = discoverCatalogFiles();
  const discoveredLocales = discovered.map((d) => d.locale).sort();
  const registeredLocales = Object.keys(CATALOGS).sort();
  expect(
    discoveredLocales,
    'discovered catalog.*.ts file set must equal Object.keys(CATALOGS) — a mis-named or ' +
      'unregistered locale file must not silently vacate every SHAPE gate',
  ).toEqual(registeredLocales);
  expect(discoveredLocales.length, 'the discovered catalog set must be non-empty').toBeGreaterThan(
    0,
  );
  return discovered;
}

// ---------------------------------------------------------------------------
// SHAPE-01 (I18N-24) — `// @desc:` adjacency.
// ---------------------------------------------------------------------------

type CodeScanState = 'code' | 'line-comment' | 'block-comment' | 'sq' | 'dq' | 'tl';

/** codeContextAt[i] === true iff index i is reached while the scanner is in ordinary CODE
 *  context — not inside a string/template literal and not inside a `//`/`/* *\/` comment. This
 *  is the MINIMAL in-file port of the hardcodedStrings.ts / client-no-pii-logs.eval.mjs literal
 *  mask idea, deliberately NOT `stripComments`: it must preserve `// @desc:` TEXT (stripComments
 *  blanks it) while still refusing to treat a line that only LOOKS like a `// @desc:` comment —
 *  because it is really payload inside an open multi-line backtick continuation — as a real one.
 *  A checker without this mask reads that payload line as a live comment and wrongly PASSES the
 *  entry below it; the SHAPE-01 "open template literal" fixture below is exactly that case. */
function computeCodeContext(src: string): boolean[] {
  const n = src.length;
  const codeContextAt: boolean[] = new Array<boolean>(n).fill(false);
  let state: CodeScanState = 'code';
  let i = 0;
  while (i < n) {
    codeContextAt[i] = state === 'code';
    const ch = src.charAt(i);
    const next = i + 1 < n ? src.charAt(i + 1) : '';
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line-comment';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block-comment';
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch === "'" ? 'sq' : ch === '"' ? 'dq' : 'tl';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      i += 1;
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    // sq / dq / tl.
    if (ch === '\\' && i + 1 < n) {
      i += 2;
      continue;
    }
    if (
      (state === 'sq' && ch === "'") ||
      (state === 'dq' && ch === '"') ||
      (state === 'tl' && ch === '`')
    ) {
      state = 'code';
    }
    i += 1;
  }
  return codeContextAt;
}

function firstNonWhitespaceIndex(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c !== ' ' && c !== '\t' && c !== '\r') return i;
  }
  return -1;
}

/** Non-whitespace char count of `rest` (the text after the `// @desc:` marker on one line). */
function nonWhitespaceCount(rest: string): number {
  let count = 0;
  for (let i = 0; i < rest.length; i++) {
    if (!isWhitespace(rest.charAt(i))) count += 1;
  }
  return count;
}

interface ParsedEntry {
  readonly key: string;
  readonly hasDesc: boolean;
}

const DESC_MARKER = '// @desc:';

/** SHAPE-01 parser. An ENTRY line's trimmed form starts with `'`, closes the key at the next
 *  `'`, and that quote is immediately followed by `:` — and the opening `'` must be reached in
 *  genuine CODE context (computeCodeContext), never inside an already-open literal. Its
 *  `// @desc:` block is the maximal run of immediately-preceding lines whose trimmed form starts
 *  with `//` AND whose `/` is itself reached in genuine code context — a blank line, a
 *  non-`//` line, a `/**`-style block-comment line, or a masked `//`-shaped payload line all end
 *  the block (never `.includes('@desc:')` anywhere in the file). */
function parseCatalogSource(src: string): ParsedEntry[] {
  const codeContextAt = computeCodeContext(src);
  const lines = src.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  function isRealCommentLine(lineIdx: number): boolean {
    const line = lines[lineIdx];
    const fw = firstNonWhitespaceIndex(line);
    if (fw === -1) return false;
    const abs = lineStarts[lineIdx] + fw;
    if (!codeContextAt[abs]) return false;
    return startsWith(line.slice(fw), '//');
  }

  function descLenIfMarker(lineIdx: number): number {
    const trimmed = lines[lineIdx].trim();
    if (!startsWith(trimmed, DESC_MARKER)) return 0;
    return nonWhitespaceCount(trimmed.slice(DESC_MARKER.length));
  }

  const entries: ParsedEntry[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const fw = firstNonWhitespaceIndex(line);
    if (fw === -1) continue;
    const abs = lineStarts[idx] + fw;
    if (!codeContextAt[abs]) continue;
    if (line.charAt(fw) !== "'") continue;
    const closeRel = line.indexOf("'", fw + 1);
    if (closeRel === -1) continue;
    if (line.charAt(closeRel + 1) !== ':') continue;
    const key = line.slice(fw + 1, closeRel);

    let hasDesc = false;
    let j = idx - 1;
    while (j >= 0 && isRealCommentLine(j)) {
      if (descLenIfMarker(j) >= 10) hasDesc = true;
      j -= 1;
    }
    entries.push({ key, hasDesc });
  }
  return entries;
}

describe('catalogShape (M24 S6, ADR-0262 §5.4)', () => {
  it('m24s6 SHAPE-01: I18N-24 — every catalog entry has an adjacent // @desc: >=10 chars', () => {
    const discovered = discoverAndVerifyCatalogs();
    for (const d of discovered) {
      const entries = parseCatalogSource(d.raw);
      const missing = entries.filter((e) => !e.hasDesc).map((e) => e.key);
      expect(
        missing,
        `${d.file}: entries with no adjacent // @desc: (>=10 non-ws chars): ${missing.join(', ')}`,
      ).toEqual([]);
      const catalog: Readonly<Record<string, unknown>> = CATALOGS[d.locale];
      const parsedKeys = entries.map((e) => e.key).sort();
      const registeredKeys = Object.keys(catalog).sort();
      expect(
        parsedKeys,
        `${d.file}: parsed key set must equal Object.keys(CATALOGS['${d.locale}']) — the ` +
          'line-start entry detector must see every registered key, never fewer or more',
      ).toEqual(registeredKeys);
    }
  });

  it('m24s6 SHAPE-01: fixtures — proof-of-teeth for the adjacency parser', () => {
    // BAD: a `// @desc:` substring exists ELSEWHERE in the file (header prose), but is not
    // adjacent to the entry — kills a naive whole-file `.includes('@desc:')` implementation.
    const headerDecoy = [
      '// carries one `// @desc:` line convention note (decoy, not adjacent to any entry)',
      '',
      'export const X = Object.freeze({',
      '  // plain comment, no descriptor',
      "  'chrome.helpHint': 'Press ? for help',",
      '});',
    ].join('\n');
    expect(
      parseCatalogSource(headerDecoy),
      'a header-prose mention of `// @desc:` must not satisfy an unrelated entry',
    ).toEqual([{ key: 'chrome.helpHint', hasDesc: false }]);

    // BAD: exactly 9 non-whitespace chars after the marker — kills an off-by-one length check.
    const nineChar = ['  // @desc: 123456789', "  'chrome.a': 'v',"].join('\n');
    expect(
      parseCatalogSource(nineChar),
      'a 9-char @desc body is BELOW the >=10 threshold and must fail',
    ).toEqual([{ key: 'chrome.a', hasDesc: false }]);

    // BAD: `/** @desc: ... */` JSDoc form — kills a checker that accepts block comments.
    const jsdocForm = [
      '  /** @desc: this description is easily long enough to pass */',
      "  'chrome.b': 'v',",
    ].join('\n');
    expect(
      parseCatalogSource(jsdocForm),
      'a `/** @desc: */` block-comment form must NOT satisfy the `//`-only convention',
    ).toEqual([{ key: 'chrome.b', hasDesc: false }]);

    // BAD: a blank line separates the comment block from the entry — kills a checker that scans
    // upward past blank lines.
    const blankGap = [
      '  // @desc: this description is easily long enough to pass',
      '',
      "  'chrome.c': 'v',",
    ].join('\n');
    expect(
      parseCatalogSource(blankGap),
      'a blank line between the comment block and the entry must break adjacency',
    ).toEqual([{ key: 'chrome.c', hasDesc: false }]);

    // BAD: the `// @desc:`-shaped line is really PAYLOAD inside an open multi-line backtick
    // continuation from the PRECEDING entry — kills a checker with no literal mask.
    const insideOpenTemplate = [
      "  'chrome.d': `text",
      '// @desc: filler filler`,',
      "  'chrome.e': 'value two',",
    ].join('\n');
    expect(
      parseCatalogSource(insideOpenTemplate),
      'a `// @desc:`-shaped line that is really backtick payload must not satisfy the NEXT entry',
    ).toEqual([
      { key: 'chrome.d', hasDesc: false },
      { key: 'chrome.e', hasDesc: false },
    ]);

    // GOOD: a 2-entry source (one plain, one `(p) =>` multi-line closure) parses exactly 2 keys,
    // both with a valid adjacent @desc — proves multi-line closure VALUES never confuse the
    // entry-line detector (only the entry line itself is examined).
    const good = [
      '  // @desc: Plain entry for fixture testing purposes with enough characters.',
      "  'ns.plain': 'Plain value',",
      '  // @desc: Closure entry for fixture testing purposes with enough characters.',
      "  'ns.closure': (p) =>",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture IS catalog source text
      '    `Closure ${p.value}`,',
    ].join('\n');
    expect(parseCatalogSource(good), 'a valid 2-entry source must parse exactly 2 keys').toEqual([
      { key: 'ns.plain', hasDesc: true },
      { key: 'ns.closure', hasDesc: true },
    ]);
  });

  // -------------------------------------------------------------------------
  // SHAPE-02 (I18N-25) — width budgets.
  // -------------------------------------------------------------------------

  it('m24s6 SHAPE-02: I18N-25 — WIDTH_CONSTRAINED_KEYS respected in every locale', () => {
    const discovered = discoverAndVerifyCatalogs();
    expect(
      Object.keys(WIDTH_CONSTRAINED_KEYS).length,
      'WIDTH_CONSTRAINED_KEYS must be non-empty',
    ).toBeGreaterThan(0);
    const catalogs: Readonly<Record<string, Readonly<Record<string, unknown>>>> = CATALOGS;
    const violations = checkWidths(catalogs, WIDTH_CONSTRAINED_KEYS);
    expect(violations, `width violations: ${JSON.stringify(violations)}`).toEqual([]);
    const en = discovered.find((d) => d.locale === 'en');
    if (en === undefined) throw new Error('en catalog file not discovered');
    const enValue = catalogs.en['chrome.helpHint'];
    expect(typeof enValue, 'chrome.helpHint must be a plain string in en').toBe('string');
    expect(
      Array.from((enValue as string).normalize('NFC')).length,
      'en chrome.helpHint must measure exactly 38 code points — pins the measurement path ' +
        '(Array.from + NFC, not .length) that the fixtures below exercise',
    ).toBe(38);
  });

  it('m24s6 SHAPE-02: fixtures — proof-of-teeth for the width checker', () => {
    const budgets = { 'chrome.helpHint': 47 };
    const cat = (value: unknown): Readonly<Record<string, Readonly<Record<string, unknown>>>> => ({
      fr: { 'chrome.helpHint': value },
    });

    const over52 = 'x'.repeat(52);
    expect(over52.length, 'precondition: fixture must be exactly 52 code points').toBe(52);
    expect(
      checkWidths(cat(over52), budgets).length,
      'a 52-char value must exceed the 47 budget and FAIL',
    ).toBeGreaterThan(0);

    const exact47 = 'x'.repeat(47);
    expect(exact47.length, 'precondition: fixture must be exactly 47 code points').toBe(47);
    expect(
      checkWidths(cat(exact47), budgets),
      'a 47-char value must be exactly AT budget and PASS (<=, not <)',
    ).toEqual([]);

    const over48 = 'x'.repeat(48);
    expect(over48.length, 'precondition: fixture must be exactly 48 code points').toBe(48);
    expect(
      checkWidths(cat(over48), budgets).length,
      'a 48-char value (one over budget) must FAIL — kills an off-by-one <= vs < mixup',
    ).toBeGreaterThan(0);

    // 46 ASCII + one astral char = 47 CODE POINTS via Array.from, but 48 UTF-16 units via
    // `.length` — kills a checker that measures `.length` instead of code points. Built via
    // `String.fromCodePoint` (never a raw literal in this source file) so the fixture bytes stay
    // unambiguous ASCII regardless of how any tool in the authoring pipeline handles `\u`
    // escapes.
    const astral = `${'x'.repeat(46)}${String.fromCodePoint(0x1f600)}`;
    expect(astral.length, 'precondition: UTF-16 .length must be 48 (surrogate pair)').toBe(48);
    expect(Array.from(astral).length, 'precondition: code-point length must be 47').toBe(47);
    expect(
      checkWidths(cat(astral), budgets),
      'a 47-code-point value with one astral char must PASS despite .length === 48',
    ).toEqual([]);

    // 46 ASCII + a DECOMPOSED e-acute (plain 'e' + combining acute accent, code point 0x0301) =
    // 47 code points only AFTER NFC normalization collapses the pair into one — kills a checker
    // that skips .normalize('NFC'). Built via `String.fromCharCode` (never a raw literal or a
    // `\u`-escaped literal in this source file) for the same reason as the astral fixture above.
    const decomposed = `${'x'.repeat(46)}e${String.fromCharCode(0x0301)}`;
    expect(
      Array.from(decomposed).length,
      'precondition: the RAW (non-normalized) fixture must be 48 code points',
    ).toBe(48);
    expect(
      Array.from(decomposed.normalize('NFC')).length,
      'precondition: after NFC the fixture collapses to 47 code points',
    ).toBe(47);
    expect(
      checkWidths(cat(decomposed), budgets),
      'a decomposed value that is 47 code points ONLY after NFC must PASS',
    ).toEqual([]);

    // Missing key: a HARD FAIL, not a vacuous skip — kills a checker that only checks keys that
    // happen to be present.
    expect(
      checkWidths({ fr: {} }, budgets).length,
      'a catalog missing the width-constrained key entirely must HARD FAIL, not pass vacuously',
    ).toBeGreaterThan(0);

    // Empty budget map: a FAIL (not a vacuous pass) — kills a checker that treats "nothing to
    // check" as "everything passes".
    expect(
      checkWidths(cat('short'), {}).length,
      'an empty WIDTH_CONSTRAINED_KEYS map must itself be flagged, never silently pass',
    ).toBeGreaterThan(0);

    // Closure value under a width-constrained key: a FAIL — kills a checker that only inspects
    // `typeof === 'function'` params and forgets non-string values can't be measured for width.
    expect(
      checkWidths(
        cat((p: { readonly x: string }) => p.x),
        budgets,
      ).length,
      'a closure (parameterized) value under a width-constrained key must FAIL, not be skipped',
    ).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // SHAPE-03 — key grammar (ADR-0256 D5).
  // -------------------------------------------------------------------------

  it('m24s6 SHAPE-03: ADR-0256 D5 — every catalog key matches the corrected grammar', () => {
    // Belt for tsc's suspenders (MessageId is a compile-time literal union already); the
    // fixtures below are the real teeth (red-team correction).
    discoverAndVerifyCatalogs();
    for (const locale of Object.keys(CATALOGS)) {
      const catalog: Readonly<Record<string, unknown>> = CATALOGS[locale];
      const bad = Object.keys(catalog).filter((k) => !isValidKeyGrammar(k));
      expect(bad, `${locale}: keys violating ADR-0256 D5 grammar: ${bad.join(', ')}`).toEqual([]);
    }
  });

  it('m24s6 SHAPE-03: fixtures — proof-of-teeth for the key grammar', () => {
    const bad = [
      'Battle.HPLine', // uppercase first segment char
      'chrome', // only 1 segment
      'chrome..x', // empty middle segment
      'chrome.1x', // second segment starts with a digit
      'a-b.c', // hyphen is not alphanumeric
      'x.y.', // trailing dot -> empty last segment
      '.x.y', // leading dot -> empty first segment
      'x.Y', // uppercase segment start
    ];
    for (const key of bad) {
      expect(isValidKeyGrammar(key), `'${key}' must FAIL ADR-0256 D5 grammar`).toBe(false);
    }
    const good = ['chrome.helpHint', 'a11y.overlay.boxView.title'];
    for (const key of good) {
      expect(isValidKeyGrammar(key), `'${key}' must PASS ADR-0256 D5 grammar`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // SHAPE-04 — a11y isolation.
  // -------------------------------------------------------------------------

  it('m24s6 SHAPE-04: a11y.* keys stay out of tf(), out of CATALOGS, brace-free', () => {
    discoverAndVerifyCatalogs();
    const { files, tfHitsByFile, a11yHits } = scanTfCalls();
    expect(
      a11yHits,
      `tf() call(s) whose first arg is an a11y.* literal (I18N-27 dynamic keys are out of ` +
        `scope; see the header note): ${a11yHits.map((h) => `${h.file}:${h.index}`).join(', ')}`,
    ).toEqual([]);
    // Anti-vacuity: the walker must have actually READ these S3-S5-migrated view files and
    // found REAL tf( calls (any key, not just a11y.*) — kills a single-file or empty walker.
    const roster = [
      'ui/battleView.ts',
      'ui/boxView.ts',
      'ui/leaderboardView.ts',
      'ui/shopView.ts',
      'ui/tradeView.ts',
    ];
    for (const f of roster) {
      expect(files, `roster file missing from the SHAPE-04 walk: ${f}`).toContain(f);
      expect(
        tfHitsByFile.get(f) ?? 0,
        `${f} must have >=1 tf( call (any key) — proves the tokenizer actually reads this file`,
      ).toBeGreaterThan(0);
    }

    const catalogs: Readonly<Record<string, Readonly<Record<string, unknown>>>> = CATALOGS;
    const braceViolations = checkA11yBraceFree(catalogs, a11yCopy);
    expect(braceViolations, `a11y.* brace violations: ${JSON.stringify(braceViolations)}`).toEqual(
      [],
    );
    const a11yKeyCount = Object.keys(a11yCopy).filter((k) => startsWith(k, 'a11y.')).length;
    expect(
      a11yKeyCount,
      'anti-vacuity: a11yCopy must have >=1 a11y.* key or the brace check runs on nothing',
    ).toBeGreaterThan(0);
  });

  it('m24s6 SHAPE-04: fixtures — proof-of-teeth for the tf( scanner and brace check', () => {
    const hit = (src: string) =>
      findTfCalls(src).filter(
        (c) => c.firstArgLiteral !== undefined && startsWith(c.firstArgLiteral, 'a11y.'),
      );

    expect(
      hit("tf('a11y.overlay.boxView.title', {n: 1})").length,
      'a bare tf( call with an a11y.* literal must be caught',
    ).toBe(1);
    expect(hit('tf("a11y.x", {})').length, 'double-quoted literal must be caught').toBe(1);
    expect(
      hit("tf(\n  'a11y.x', {})").length,
      'a newline between `tf(` and the literal must not defeat the whitespace skip',
    ).toBe(1);
    expect(
      hit("tf ('a11y.x', {})").length,
      'whitespace before the `(` must not defeat detection',
    ).toBe(1);
    expect(
      hit("this.tf('a11y.x', {})").length,
      'a `this.tf(` receiver must still hit — SHAPE-04 does NOT apply the S2 `.`-receiver exemption',
    ).toBe(1);
    expect(
      hit("tf<'a11y.x'>('a11y.x', {})").length,
      'a generic type argument `tf<...>(` must be skipped over, not treated as a boundary break',
    ).toBe(1);
    expect(hit("tf('box.title', {})").length, 'a non-a11y literal must never hit').toBe(0);
    expect(hit("t('a11y.x')").length, 'a `t(` call (not `tf(`) must never hit').toBe(0);

    // I18N-27 DYNAMIC-KEY is explicitly out of scope for this literal-only scanner (S7 owns the
    // census): `const k = 'a11y.x' as const; tf(k, {});` has no string literal as the first
    // argument at all, so it produces zero hits here by construction — messageIds.ts:299's
    // `AssertNoA11yParamKey` is the compile-time half of that guarantee.
    // Also out of scope, same reason: FUNCTION-VALUE indirection (`[tf][0]('a11y.x', …)`,
    // `const f = tf; f('a11y.x', …)`) is not a text-scannable call site — I18N-27's census and
    // tsc's totality (`A11yKey = never`, so only an `as never` cast compiles) are the backstops.
    expect(
      findTfCalls("const k = 'a11y.x' as const; tf(k, {});").filter(
        (c) => c.firstArgLiteral !== undefined,
      ).length,
      'a dynamic key variable is I18N-27 territory, not this literal-only SHAPE-04 scan',
    ).toBe(0);

    const braceBad = { en: { 'a11y.count.items': 'You have {count} items' } };
    expect(
      checkA11yBraceFree(braceBad, {}).length,
      'an a11y.* catalog value containing { or } must FAIL',
    ).toBeGreaterThan(0);
    const braceGood = { en: { 'a11y.count.items': 'You have count items' } };
    expect(checkA11yBraceFree(braceGood, {}), 'the same value with no braces must PASS').toEqual(
      [],
    );
  });

  // -------------------------------------------------------------------------
  // SHAPE-05 — t() signature pin. ONE `it` (live + fixtures together, per the brief).
  // -------------------------------------------------------------------------

  it('m24s6 SHAPE-05: resolver.ts export function t( signature is pinned exactly', () => {
    discoverAndVerifyCatalogs();
    const resolverSrc = readFileSync(path.join(I18N_DIR, 'resolver.ts'), 'utf8');
    const live = checkTSignature(stripComments(resolverSrc));
    expect(
      live.ok,
      `resolver.ts export function t( signature check failed: ${JSON.stringify(live)}`,
    ).toBe(true);

    // BAD: `key: string` instead of `key: A11yKey | PlainMessageId` — kills a widened signature.
    const widened = checkTSignature('export function t(key: string): string {}');
    expect(widened.ok, 'a widened `key: string` parameter must FAIL').toBe(false);
    expect(widened.paramText, 'the widened parameter text must be extracted exactly').toBe(
      'key: string',
    );

    // BAD: an extra `...rest` parameter riding along — kills a non-exact (prefix) comparison.
    const withRest = checkTSignature(
      'export function t(key: A11yKey | PlainMessageId, ...rest: never[]): string {}',
    );
    expect(withRest.ok, 'a trailing `...rest` parameter must FAIL exact-equality').toBe(false);

    // BAD: an overload pair (two `export function t(` declarations) — kills a "first match wins"
    // scanner that never counts occurrences.
    const overloadPair = [
      'export function t(key: A11yKey | PlainMessageId): string;',
      'export function t(key: A11yKey | PlainMessageId): string {',
      "  return '';",
      '}',
    ].join('\n');
    expect(checkTSignature(overloadPair).ok, 'an overload pair must FAIL (declCount !== 1)').toBe(
      false,
    );
    expect(checkTSignature(overloadPair).declCount, 'the overload pair must count as 2').toBe(2);

    // GOOD: the exact pinned text.
    const exact = [
      'export function t(key: A11yKey | PlainMessageId): string {',
      "  return '';",
      '}',
    ].join('\n');
    expect(checkTSignature(exact).ok, 'the exact pinned signature must PASS').toBe(true);
  });

  // -------------------------------------------------------------------------
  // SHAPE-06 (I18N-33) — oneOther guard.
  // -------------------------------------------------------------------------

  it('m24s6 SHAPE-06: I18N-33 — oneOther only where CLDR categories are {one,other}', () => {
    const discovered = discoverAndVerifyCatalogs();

    // Self-checks on the Intl data itself (not on any file).
    expect(
      Array.from(new Intl.PluralRules('en').resolvedOptions().pluralCategories).sort(),
      'precondition: en plural categories must be exactly {one,other}',
    ).toEqual(['one', 'other']);
    const ruCats = new Intl.PluralRules('ru').resolvedOptions().pluralCategories;
    expect(ruCats, 'precondition: ru must have `few`').toContain('few');
    expect(ruCats, 'precondition: ru must have `many`').toContain('many');
    const frCats = new Intl.PluralRules('fr').resolvedOptions().pluralCategories;
    // French carries `many` (large-number forms) in addition to {one,other} — so S7's
    // catalog.fr.ts must author its plural forms via cldr(), never oneOther().
    expect(
      frCats,
      'precondition: fr must have `many` (S7 catalog.fr.ts must not use oneOther)',
    ).toContain('many');

    for (const d of discovered) {
      const result = checkOneOther(d.locale, d.raw);
      expect(
        result.ok,
        `${d.file}: locale '${d.locale}' plural categories are not exactly {one,other} but the ` +
          `source still uses the identifier oneOther ${result.count} time(s) and/or the quoted ` +
          `literal token 'oneOther' ${result.literalCount} time(s)`,
      ).toBe(true);
    }

    // The load-bearing strip: catalog.en.ts mentions `oneOther` in a COMMENT (plural.ts header
    // cross-reference), not in code. Prove the raw text contains it, AND that the masked count
    // is 0 — a checker that forgets to strip comments would count 1 here.
    const en = discovered.find((d) => d.locale === 'en');
    if (en === undefined) throw new Error('en catalog file not discovered');
    expect(
      en.raw.indexOf('oneOther') !== -1,
      'precondition: catalog.en.ts must mention `oneOther` somewhere (in a comment) for this ' +
        'self-check to be meaningful',
    ).toBe(true);
    expect(
      checkOneOther('en', en.raw).count,
      'oneOther appears only in a comment in catalog.en.ts; the comment-strip must remove it ' +
        'before counting, even though en is exempt from the rule either way',
    ).toBe(0);
  });

  it('m24s6 SHAPE-06: fixtures — proof-of-teeth for the oneOther identifier scan', () => {
    expect(
      checkOneOther('ru', "const forms = oneOther('one item', 'many items');").ok,
      'a ru file calling oneOther( must FAIL (ru is not {one,other})',
    ).toBe(false);
    expect(
      checkOneOther('ru', "const forms = oneOther ('one item', 'many items');").ok,
      'a SPACED oneOther ( call must still be caught — this is an identifier scan, not a ' +
        'call-shape scan',
    ).toBe(false);
    expect(
      checkOneOther('ru', "import { oneOther as x } from './plural';").ok,
      'an aliased import of oneOther must FAIL — the identifier appears regardless of alias',
    ).toBe(false);
    expect(
      checkOneOther('ru', 'const oo = oneOther;').ok,
      'a bare reference (no call at all) must FAIL — this is an identifier scan',
    ).toBe(false);
    expect(
      checkOneOther('ru', "const label = plural['oneOther']('a', 'b');").ok,
      "a ru file accessing plural['oneOther'](...) via string-index must FAIL — the quoted " +
        'literal token is caught separately, since maskOutLiteralText blanks it before the ' +
        'identifier scan runs',
    ).toBe(false);
    expect(
      checkOneOther('en', "const forms = oneOther('a', 'b');").ok,
      'en IS {one,other}, so any oneOther usage is allowed',
    ).toBe(true);
    expect(
      checkOneOther('ru', "// this file must never call oneOther('x', 'y')\nconst x = 1;").ok,
      'oneOther mentioned ONLY inside a comment must PASS (the strip is load-bearing)',
    ).toBe(true);
    expect(
      checkOneOther(
        'ru',
        "const forms = cldr({ one: 'a', two: 'a', few: 'b', many: 'c', other: 'a', zero: 'a' });",
      ).ok,
      'cldr( usage with no oneOther identifier anywhere must PASS',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SHAPE-02 checker + budget table.
// ---------------------------------------------------------------------------

const WIDTH_CONSTRAINED_KEYS: Readonly<Record<string, number>> = Object.freeze({
  'chrome.helpHint': 47,
});

interface WidthViolation {
  readonly locale: string;
  readonly key: string;
  readonly reason: string;
}

function checkWidths(
  catalogs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  budgets: Readonly<Record<string, number>>,
): WidthViolation[] {
  const violations: WidthViolation[] = [];
  const budgetKeys = Object.keys(budgets);
  if (budgetKeys.length === 0) {
    violations.push({
      locale: '*',
      key: '*',
      reason: 'WIDTH_CONSTRAINED_KEYS is empty — nothing would be checked',
    });
    return violations;
  }
  for (const locale of Object.keys(catalogs)) {
    const catalog = catalogs[locale];
    for (const key of budgetKeys) {
      const budget = budgets[key];
      if (!Object.hasOwn(catalog, key)) {
        violations.push({
          locale,
          key,
          reason: `catalog is missing width-constrained key '${key}'`,
        });
        continue;
      }
      const value = catalog[key];
      if (typeof value !== 'string') {
        violations.push({
          locale,
          key,
          reason: 'value is not a string (a closure value cannot be width-checked)',
        });
        continue;
      }
      const len = Array.from(value.normalize('NFC')).length;
      if (len > budget) {
        violations.push({ locale, key, reason: `${len} code points > budget ${budget}` });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// SHAPE-03 checker.
// ---------------------------------------------------------------------------

function isLowerAlpha(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 97 && c <= 122;
}

function isKeySegmentTailChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** ADR-0256 D5: dot-separated segments, >=2, each `[a-z][a-zA-Z0-9]*` — corrects the spec's own
 *  `[a-z0-9]+` (which rejects `chrome.helpHint` / `a11y.overlay.boxView.title`). */
function isValidKeyGrammar(key: string): boolean {
  const segments = key.split('.');
  if (segments.length < 2) return false;
  for (const seg of segments) {
    if (seg.length === 0) return false;
    if (!isLowerAlpha(seg.charAt(0))) return false;
    for (let i = 1; i < seg.length; i++) {
      if (!isKeySegmentTailChar(seg.charAt(i))) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// SHAPE-04 checkers: the tf( scanner and the a11y brace check.
// ---------------------------------------------------------------------------

interface TfCall {
  readonly index: number;
  readonly firstArgLiteral: string | undefined;
}

/** Locate every `tf` call in (comment-stripped) source: the identifier token `tf` at a word
 *  boundary, optional whitespace, an optional single balanced `<...>` generic-argument span,
 *  optional whitespace, then `(`, optional whitespace, then a string literal. `this.tf(` /
 *  `obj.tf(` count (no `.`-receiver exemption — unlike the S2 hardcoded-string scanner, an a11y
 *  key reached through a receiver is exactly as live as a bare call). */
function findTfCalls(src: string): TfCall[] {
  const calls: TfCall[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const at = src.indexOf('tf', i);
    if (at === -1) break;
    const before = at > 0 ? src.charAt(at - 1) : '';
    const afterCh = at + 2 < n ? src.charAt(at + 2) : '';
    if (isIdentChar(before) || isIdentChar(afterCh)) {
      i = at + 2;
      continue;
    }
    let j = at + 2;
    while (j < n && isWhitespace(src.charAt(j))) j += 1;
    if (src.charAt(j) === '<') {
      let depth = 0;
      while (j < n) {
        const ch = src.charAt(j);
        if (ch === '<') {
          depth += 1;
          j += 1;
        } else if (ch === '>') {
          depth -= 1;
          j += 1;
          if (depth === 0) break;
        } else {
          j += 1;
        }
      }
      while (j < n && isWhitespace(src.charAt(j))) j += 1;
    }
    if (src.charAt(j) !== '(') {
      i = at + 2;
      continue;
    }
    j += 1;
    while (j < n && isWhitespace(src.charAt(j))) j += 1;
    const quote = src.charAt(j);
    let literal: string | undefined;
    if (quote === "'" || quote === '"' || quote === '`') {
      let k = j + 1;
      let text = '';
      while (k < n && src.charAt(k) !== quote) {
        if (src.charAt(k) === '\\' && k + 1 < n) {
          text += src.charAt(k + 1);
          k += 2;
          continue;
        }
        text += src.charAt(k);
        k += 1;
      }
      literal = text;
    }
    calls.push({ index: at, firstArgLiteral: literal });
    i = at + 2;
  }
  return calls;
}

function hasBrace(s: string): boolean {
  return s.indexOf('{') !== -1 || s.indexOf('}') !== -1;
}

interface BraceViolation {
  readonly source: string;
  readonly key: string;
  readonly reason: string;
}

function checkA11yBraceFree(
  catalogs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  a11y: Readonly<Record<string, string>>,
): BraceViolation[] {
  const violations: BraceViolation[] = [];
  for (const locale of Object.keys(catalogs)) {
    const catalog = catalogs[locale];
    for (const key of Object.keys(catalog)) {
      if (!startsWith(key, 'a11y.')) continue;
      const value = catalog[key];
      if (typeof value === 'string' && hasBrace(value)) {
        violations.push({
          source: `CATALOGS.${locale}`,
          key,
          reason: 'a11y.* value contains { or }',
        });
      }
    }
  }
  for (const key of Object.keys(a11y)) {
    if (!startsWith(key, 'a11y.')) continue;
    if (hasBrace(a11y[key])) {
      violations.push({ source: 'a11yCopy', key, reason: 'a11y.* value contains { or }' });
    }
  }
  return violations;
}

function walkClientSrc(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      walkClientSrc(abs, rel, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(rel);
    }
  }
}

interface TfScan {
  readonly files: readonly string[];
  readonly tfHitsByFile: ReadonlyMap<string, number>;
  readonly a11yHits: ReadonlyArray<{ readonly file: string; readonly index: number }>;
}

let cachedTfScan: TfScan | undefined;

/** Memoised: the tree is walked and every non-test file read/stripped/scanned exactly once. */
function scanTfCalls(): TfScan {
  if (cachedTfScan) return cachedTfScan;
  const files: string[] = [];
  walkClientSrc(CLIENT_SRC, '', files);
  files.sort();
  const tfHitsByFile = new Map<string, number>();
  const a11yHits: Array<{ file: string; index: number }> = [];
  for (const rel of files) {
    const raw = readFileSync(path.join(CLIENT_SRC, ...rel.split('/')), 'utf8');
    const stripped = stripComments(raw);
    const calls = findTfCalls(stripped);
    tfHitsByFile.set(rel, calls.length);
    for (const call of calls) {
      if (call.firstArgLiteral !== undefined && startsWith(call.firstArgLiteral, 'a11y.')) {
        a11yHits.push({ file: rel, index: call.index });
      }
    }
  }
  cachedTfScan = { files, tfHitsByFile, a11yHits };
  return cachedTfScan;
}

// ---------------------------------------------------------------------------
// SHAPE-05 checker.
// ---------------------------------------------------------------------------

const T_DECL = 'export function t(';
const PINNED_PARAM_TEXT = 'key: A11yKey | PlainMessageId';

interface ParenSpan {
  readonly start: number;
  readonly end: number;
}

function balancedParenSpan(src: string, openIdx: number): ParenSpan | undefined {
  if (src.charAt(openIdx) !== '(') return undefined;
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { start: openIdx + 1, end: i };
    }
    i += 1;
  }
  return undefined;
}

function squashWhitespace(s: string): string {
  let out = '';
  let lastWasSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (isWhitespace(ch)) {
      if (!lastWasSpace) out += ' ';
      lastWasSpace = true;
    } else {
      out += ch;
      lastWasSpace = false;
    }
  }
  return out;
}

function stripLeadingSpace(s: string): string {
  let i = 0;
  while (i < s.length && s.charAt(i) === ' ') i += 1;
  return s.slice(i);
}

function findTDeclarations(src: string): number[] {
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(T_DECL, from);
    if (at === -1) break;
    positions.push(at);
    from = at + T_DECL.length;
  }
  return positions;
}

interface TSignatureCheck {
  readonly ok: boolean;
  readonly declCount: number;
  readonly paramText: string | undefined;
}

/** SHAPE-05: exactly one `export function t(`, parameter text EXACTLY
 *  `key: A11yKey | PlainMessageId` (whole balanced-paren span, exact equality — never a prefix
 *  compare, so a trailing `, ...rest: never[]` cannot ride along), return annotation starting
 *  with `: string` right after the parameter list, zero `export function t<`, zero
 *  `export const t`, zero `export { t` / `export {t` re-export forms. Deliberately does NOT use
 *  `t.length` (a rest/default param would not move it either way — red-team correction). */
function checkTSignature(src: string): TSignatureCheck {
  const decls = findTDeclarations(src);
  const genericCount = countWordBoundaryOccurrences(src, 'export function t<');
  const constTCount = countWordBoundaryOccurrences(src, 'export const t');
  const reExport = src.indexOf('export { t') !== -1 || src.indexOf('export {t') !== -1;

  let paramText: string | undefined;
  let returnOk = false;
  if (decls.length === 1) {
    const openIdx = decls[0] + T_DECL.length - 1;
    const span = balancedParenSpan(src, openIdx);
    if (span !== undefined) {
      paramText = src.slice(span.start, span.end);
      const afterRaw = src.slice(span.end + 1, Math.min(src.length, span.end + 1 + 40));
      const afterSquashed = stripLeadingSpace(squashWhitespace(afterRaw));
      returnOk = startsWith(afterSquashed, ': string');
    }
  }

  const ok =
    decls.length === 1 &&
    paramText === PINNED_PARAM_TEXT &&
    returnOk &&
    genericCount === 0 &&
    constTCount === 0 &&
    !reExport;
  return { ok, declCount: decls.length, paramText };
}

// ---------------------------------------------------------------------------
// SHAPE-06 checker.
// ---------------------------------------------------------------------------

/** Blanks out string/template literal PAYLOAD (post comment-strip) so an `oneOther` mention
 *  inside a plain string value never counts as an identifier use. Simpler than SHAPE-01's mask:
 *  `stripComments` has already removed every comment, so this only needs to track sq/dq/tl. */
function maskOutLiteralText(src: string): string {
  const out: string[] = [];
  let state: 'code' | 'sq' | 'dq' | 'tl' = 'code';
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (state === 'code') {
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch === "'" ? 'sq' : ch === '"' ? 'dq' : 'tl';
        out.push(' ');
      } else {
        out.push(ch);
      }
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      out.push(' ', ' ');
      i += 1;
      continue;
    }
    if (
      (state === 'sq' && ch === "'") ||
      (state === 'dq' && ch === '"') ||
      (state === 'tl' && ch === '`')
    ) {
      state = 'code';
    }
    out.push(' ');
  }
  return out.join('');
}

function countIdentifierOccurrences(src: string, ident: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = src.indexOf(ident, from);
    if (at === -1) break;
    from = at + ident.length;
    const before = at > 0 ? src.charAt(at - 1) : '';
    const afterIdx = at + ident.length;
    const after = afterIdx < src.length ? src.charAt(afterIdx) : '';
    if (!isIdentChar(before) && !isIdentChar(after)) count += 1;
  }
  return count;
}

/** Counts occurrences of `ident` as a WHOLE single/double/backtick-quoted string literal — e.g.
 *  `'oneOther'`, `"oneOther"`, `` `oneOther` `` — in `src`. Catches `plural['oneOther'](...)`
 *  string-index access: `maskOutLiteralText` blanks quoted literal payload BY DESIGN (a
 *  translated string value that merely contains the word `oneOther` must never trip the
 *  identifier scan), which is exactly what let that string-index access through as a bypass; an
 *  exact quote-ident-matching-quote substring search leaves no room for a partial match
 *  (`'xoneOtherx'` never counts). */
function countWholeLiteralTokenOccurrences(src: string, ident: string): number {
  let count = 0;
  for (const quote of ["'", '"', '`']) {
    const token = `${quote}${ident}${quote}`;
    let from = 0;
    for (;;) {
      const at = src.indexOf(token, from);
      if (at === -1) break;
      from = at + token.length;
      count += 1;
    }
  }
  return count;
}

interface OneOtherResult {
  readonly ok: boolean;
  readonly count: number;
  readonly literalCount: number;
}

/** SHAPE-06 (I18N-33): the IDENTIFIER token `oneOther` at word boundaries (import specifiers,
 *  aliases, spaced calls, bare references all count — this is not a `oneOther(` call-shape
 *  scan), over comment-stripped + literal-masked source, PLUS the whole quoted literal token
 *  `'oneOther'` / `"oneOther"` / `` `oneOther` `` on the comment-stripped but UNMASKED source (a
 *  `plural['oneOther'](...)` string-index access hides the identifier inside a literal that the
 *  mask blanks for the first scan; a catalog value that is exactly the bare word `oneOther` is
 *  never a real translated string either way, so it is also a violation). `locale`'s CLDR
 *  category set decides whether ANY occurrence, of either kind, is a violation. */
function checkOneOther(locale: string, rawSrc: string): OneOtherResult {
  const categories = Array.from(
    new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
  ).sort();
  const isTwoCategory =
    categories.length === 2 && categories[0] === 'one' && categories[1] === 'other';
  const stripped = stripComments(rawSrc);
  const masked = maskOutLiteralText(stripped);
  const count = countIdentifierOccurrences(masked, 'oneOther');
  const literalCount = countWholeLiteralTokenOccurrences(stripped, 'oneOther');
  return { ok: isTwoCategory || (count === 0 && literalCount === 0), count, literalCount };
}
