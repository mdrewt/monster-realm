// ui/i18n/hardcodedStrings.test.ts — m24-s2 RED gating tests for the hardcoded-string extraction
// lint: §2.2's default-fail character inversion, fixture-proven through the SAME `scanSource` the
// real whole-tree scan uses, plus the exactly-pinned migration ceiling.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M24-internationalization.spec.md §2.2 (the rule, F2 RESOLVED), §5.2
//     ([I18N-HC-01..05], BAD (1)-(4), GOOD (1)-(3), vacuity attacks (a)(b)(c)), §6 S2 (I18N-12..18).
//   docs/adr/0257-i18n-hardcoded-string-lint-colocated-vitest-exact-ratchet.md D1-D7.
//   memory/projects/gates/m24-s2.gates.md X1-X7 (the `-t` handles below are the ledger's CHECKs).
//   memory/projects/monster-realm-m24-s2-plan.md (R1-R9 override the earlier text).
//
// WHY THIS IS A CO-LOCATED TEST, NOT AN EVAL (ADR-0224 / ADR-0257 D1): spec §5.2 names a NEW
// `evals/i18n-hardcoded-strings.eval.mjs`. ADR-0224 (2026-09-01, after the spec's ceremony)
// retires new `evals/*.eval.mjs` files; the identical enforcement semantics ship as this ordinary
// vitest suite, discovered by vitest's `src/**/*.test.ts` include and run by `just ci`'s client
// stage. The baseline is plain data (`__fixtures__/i18n-hardcoded.json`), not an eval file.
//
// SCOPE (ADR-0257 D2, plan R1): every `client/src/**/*.ts` whose name does NOT end in `.test.ts`
// (`endsWith`, never substring) — the S0 precedent's walk. The 19 spec-named files
// (`SCAN_TARGETS`) are asserted present-and-non-empty; `SINK_FLOOR = 169` is `>=` over the
// whole-tree total. Two post-spec files (`ui/privacyView.ts`, `ui/evolutionNotice.ts`) are inside
// the scope because of this, not silently outside it.
//
// PHASE 0 (tests I18N-12..16, HC-01) NEVER TOUCHES THE FILESYSTEM: every fixture is a named
// `const` (biome's lineWidth 100 would otherwise wrap an inline template and change its bytes)
// fed straight to `scanSource` (or through the imported `stripComments` first, where the fixture
// is about stripping). Every fixture assertion pins COUNTS `{sinks, failing}` — never a bare
// boolean — and, where the spec/plan names them, the exact failing segment strings.
//
// MATCHER DISCIPLINE: `String.indexOf` loops only — no regex literal, no `RegExp` constructor —
// in this file too (a regex literal blinds the single-owner `stripComments` this file imports).
//
// RED REASON AT HEAD (m24-s2 T2): `hardcodedStrings.ts` is a SKELETON — `isCleanSegment` and
// `scanSource` both `throw new Error('m24-s2: not implemented')`. Every Phase-0 test therefore
// fails on that message; I18N-17/18/18x call `scanSource` per real file inside the memoised
// `scan()` and fail on the same throw. The ceiling placeholder is 0 until T4 measures it.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/ADR/plan
// only.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixture is scanned source text, not a template
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The comment stripper is IMPORTED, never copied (ADR-0215 single-owner rule). Precedent for a
// `.ts` test under `ui/i18n/` importing a `.mjs` eval: ./catalog.test.ts:32.
import { stripComments } from '../../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import {
  isCleanSegment,
  NON_TRANSLATABLE_CHARS,
  SCAN_TARGETS,
  type ScanResult,
  SET_ATTRIBUTE_ALLOWLIST,
  SINK_FLOOR,
  type Sink,
  scanSource,
} from './hardcodedStrings';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.resolve(I18N_DIR, '..', '..');
const HELPER_PATH = path.join(I18N_DIR, 'hardcodedStrings.ts');
const CEILING_PATH = path.join(I18N_DIR, '__fixtures__', 'i18n-hardcoded.json');

// m24-s2 measured 2026-09-20 at the S2 build: 81 failing of 182 sinks (whole non-test tree).
// Shrink-only: raising above this needs a test edit.
const CEILING_AT_S2 = 81;

// ---------------------------------------------------------------------------
// Small helpers (no RegExp anywhere)
// ---------------------------------------------------------------------------

interface Counts {
  readonly sinks: number;
  readonly failing: number;
}

function counts(r: ScanResult): Counts {
  return { sinks: r.sinks.length, failing: r.failing.length };
}

/** Every failing segment across every failing sink, in source order. */
function failingSegmentsOf(r: ScanResult): string[] {
  const out: string[] = [];
  for (const s of r.failing) out.push(...s.failingSegments);
  return out;
}

/** `indexOf`-loop occurrence counter. */
function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return n;
    n++;
    from = at + needle.length;
  }
}

/** ADR-0257 D5: the baseline JSON is EXACTLY `{HARDCODED_CEILING: non-negative integer}` — one
 *  key, no extras, no string, no float, no negative. Throws a named reason otherwise. */
function readCeiling(text: string): number {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('i18n-hardcoded.json: top level must be a plain object');
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'HARDCODED_CEILING') {
    throw new Error(
      `i18n-hardcoded.json: exactly one key HARDCODED_CEILING expected, got [${keys.join(', ')}]`,
    );
  }
  const value = (parsed as { HARDCODED_CEILING: unknown }).HARDCODED_CEILING;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `i18n-hardcoded.json: HARDCODED_CEILING must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Real-tree scan (memoised; only I18N-17/18/18x reach it)
// ---------------------------------------------------------------------------

interface FileScan {
  readonly file: string;
  readonly stripped: string;
  readonly result: ScanResult;
}

interface TreeScan {
  readonly files: readonly string[];
  readonly perFile: readonly FileScan[];
  readonly sinks: ReadonlyArray<{ readonly file: string; readonly sink: Sink }>;
  readonly failing: ReadonlyArray<{ readonly file: string; readonly sink: Sink }>;
}

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(abs, rel, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(rel);
    }
  }
}

let cached: TreeScan | undefined;

/** Memoised: the tree is walked and every file read/stripped/scanned exactly once. */
function scan(): TreeScan {
  if (cached) return cached;
  const files: string[] = [];
  walk(CLIENT_SRC, '', files);
  files.sort();
  const perFile: FileScan[] = [];
  const sinks: Array<{ file: string; sink: Sink }> = [];
  const failing: Array<{ file: string; sink: Sink }> = [];
  for (const rel of files) {
    const raw = readFileSync(path.join(CLIENT_SRC, ...rel.split('/')), 'utf8');
    const stripped = stripComments(raw);
    const result = scanSource(stripped);
    perFile.push({ file: rel, stripped, result });
    for (const sink of result.sinks) sinks.push({ file: rel, sink });
    for (const sink of result.failing) failing.push({ file: rel, sink });
  }
  cached = { files, perFile, sinks, failing };
  return cached;
}

function describeSink(entry: { readonly file: string; readonly sink: Sink }): string {
  return `${entry.file}:${entry.sink.line} ${entry.sink.kind} ${JSON.stringify(entry.sink.failingSegments)}`;
}

// ---------------------------------------------------------------------------
// Fixtures — spec §5.2 VERBATIM (BAD 1-4, GOOD 1-3, vacuity (a)) + plan R7 RHS shapes.
// Named constants: biome's formatter must never be able to rewrap a fixture's bytes.
// ---------------------------------------------------------------------------

// BAD (1) battleView.ts:212 (E3) — the fixture B3's own ">=3 alphabetic run" rule PASSES.
const BAD_1_LV = 'lvSpan.textContent = `Lv${card.level}`';
// BAD (2) leaderboardView.ts:57 (E4) — the fixture B6's own ">=2 + allowlist" repair PASSES.
const BAD_2_WL = 'li.textContent = `${n} — ${r} (W${w}/L${l})`';
// BAD (3) index.html:54's counterpart.
const BAD_3_RENAME = "el.textContent = 'Rename'";
// BAD (4) allowlisted attribute, raw value.
const BAD_4_ARIA = "el.setAttribute('aria-label', 'Empty slot')";
// GOOD (1) glyph-only statics — proves the closed set is not a blanket alphabetic ban.
const GOOD_1_DOT = 'sep.textContent = `${a} · ${b}`';
// GOOD (2) attribute-name filtering runs BEFORE content classification ('box-slot' would fail).
const GOOD_2_TESTID = "el.setAttribute('data-testid', 'box-slot')";
// GOOD (3) a commented-out raw literal directly above a real t() call — through stripComments.
const GOOD_3_COMMENTED = "// el.textContent = 'Rename'\nel.textContent = t('chrome.rename');";
// Control for GOOD (3): the comment marker removed, the first statement `;`-terminated.
const GOOD_3_CONTROL = "el.textContent = 'Rename';\nel.textContent = t('chrome.rename');";
// Vacuity (a): per-file classification would pass this; per-sink fails exactly one.
const VACUITY_A = "heading.textContent = t('x.y');\nli.textContent = 'raw';";

// I18N-16 structural absence (spec [I18N-HC-02]): none of these tokens is in the sink vocabulary.
const STRUCTURAL_ABSENCE =
  "el.id = 'x'; el.className = 'y'; el.style.cssText = 'z'; el.dataset.k = 'v'; el.addEventListener('click', f);";
const SET_ATTR_T = "el.setAttribute('aria-label', t('a11y.x'))";
const SET_ATTR_TITLE_RAW = "el.setAttribute('title', 'Raw')";
const SET_ATTR_ALT_IDENT = "el.setAttribute('alt', name)";
const SET_ATTR_NONLITERAL_NAME = "el.setAttribute(ARIA, 'Raw')";
const SET_ATTR_DQ = 'el.setAttribute("aria-label", "Raw")';
const SET_ATTR_LIVE_RAW = "el.setAttribute('aria-live', 'polite')";
const SET_ATTR_DESCRIBEDBY_IDENT = "el.setAttribute('aria-describedby', id)";
const SET_ATTR_TEMPLATE = "el.setAttribute('aria-label', `Lv${n}`)";
// biome-wrapped call shape with a trailing comma.
const SET_ATTR_MULTILINE = "el.setAttribute(\n  'aria-label',\n  'Raw value',\n);";

// I18N-HC-01 RHS shapes (plan R7 / ADR-0257 D3).
const RHS_TERNARY_RAW = "el.textContent = c ? 'A' : 'B';";
const RHS_TERNARY_T = "el.textContent = x ? t('a') : t('b');";
const RHS_T_PLUS_SPACE = "el.textContent = t('k') + ' ' + n;";
const RHS_T_PLUS_RAW = "el.textContent = t('k') + 'Raw';";
const RHS_T_OR_RAW = "el.textContent = t('k') || 'Raw';";
const RHS_OBJ_T = "el.textContent = obj.t('Raw');";
const RHS_AT_CALL = "el.textContent = at('Raw');";
const RHS_T_SPACE_PAREN = "el.textContent = t ('Raw');";
const RHS_TF = "el.textContent = tf('chrome.x', { n: count });";
const RHS_T_NESTED = "el.textContent = t(pick('a'));";
const RHS_WRAP_T = "el.textContent = wrap(t('k'));";
const RHS_WRAP_RAW = "el.textContent = wrap('Raw');";
const RHS_STRING_N = 'el.textContent = String(n);';
const RHS_IDENT = 'el.textContent = label;';
const RHS_EMPTY = "el.textContent = '';";
const RHS_RC_EMPTY = 'list.replaceChildren();';
const RHS_RC_SPREAD = 'list.replaceChildren(...nodes);';
const RHS_RC_HELPER_RAW = "list.replaceChildren(helper('Raw'));"; // shopView.ts:125/136/144 shape
const RHS_RC_STRING = "list.replaceChildren('Hi');";
const RHS_RC_SECOND_ARG_RAW = "list.replaceChildren(t('a'), 'Raw');";
const RHS_TPL_TERNARY = "el.textContent = `${c ? 'A' : 'B'}`;";
const RHS_TPL_NULLISH_EMPTY = "el.textContent = `${x ?? ''}`;";
const RHS_TPL_TWO_T = "el.textContent = `${t('a')} · ${t('b')}`;";
const RHS_MULTILINE_TERNARY =
  "el.textContent = cond\n  ? 'Yes'\n  : 'No';\nother.textContent = t('k');";
const RHS_ARROW_PAREN = 'items.forEach((x) => (el.textContent = x));';
const RHS_COMMA_END = "el.textContent = 'Raw', other();";
const RHS_NEWLINE_AFTER_EQ = "el.textContent =\n  'Raw';";
const RHS_NULLISH_NEWLINE = "el.textContent = x ??\n  'Raw';"; // evolutionView.ts:248 shape
const RHS_MULTILINE_CONCAT = "el.textContent =\n  'Only monsters ' +\n  'can battle.';"; // boxView.ts:94
const RHS_PLUS_EQ = "el.textContent += 'x';";
const RHS_STRICT_EQ = "if (el.textContent === 'x') {}";
const RHS_LOOSE_EQ = "el.textContent == 'x'";
const RHS_TITLE_EL = "vm.titleEl = 'x';";
const RHS_TITLE_RAW = "el.title = 'Raw';";
const RHS_TITLE_READ = 'const v = vm.title;';
const RHS_TITLE_CALL = "vm.title('x');";
const RHS_LOGICAL_ASSIGN = "el.textContent ??= 'x'; el.textContent ||= 'y';";
// Coverage fixtures (plan R8): brace depth inside `${}`, an allowlisted setAttribute with NO value
// argument (empty payload), and a NON-bare (concatenated) first argument.
const RHS_TPL_BRACES = 'el.textContent = `${fmt({ n: 1 })}`;';
const SET_ATTR_NO_VALUE = "el.setAttribute('alt')";
const SET_ATTR_CONCAT_NAME = "el.setAttribute('title' + x, 'Raw')";
const RHS_UNTERMINATED = "el.textContent = 'oops;";
const RHS_TRUNCATED = "el.textContent = f('a'";
// Plan R5 parity flip: two regex literals each holding ONE quote. stringMask reads the first `'`
// as opening a literal that the `'` of 'Raw' closes, then 'Raw' is CODE and the closing `'`
// re-opens a literal that the second regex's quote closes — `unterminated` stays FALSE while
// `.textContent =` sits at a MASKED index. The loud signal is `maskedSinkTokens`.
const RHS_PARITY_FLIP = "const a = /'/;\nel.textContent = 'Raw';\nconst b = /'/;";

/** The tokens hardcodedStrings.ts must never contain (even in comments) — plan Q6/R6: other
 *  source-scanning gates read every non-test client file, this helper included. */
const HELPER_FORBIDDEN_TOKENS = [
  '.innerHTML',
  '.outerHTML',
  '[aria-live',
  'matchMedia',
  'window',
  'addEventListener(',
  '.dataset.',
  'tabindex',
  'document.body',
  'new RegExp',
  'RegExp(',
];

describe('i18n-hardcoded-strings (M24 S2, ADR-0257)', () => {
  it('m24s2 I18N-12: isCleanSegment admits exactly the 33-member closed set and rejects any other character with no length exemption', () => {
    // The set itself: 4 ASCII whitespace + 10 digits + 19 glyphs (spec §2.2).
    expect(NON_TRANSLATABLE_CHARS.size).toBe(33);
    for (const ch of [' ', '\t', '\n', '\r'])
      expect(NON_TRANSLATABLE_CHARS.has(ch), `ws ${JSON.stringify(ch)}`).toBe(true);
    for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(NON_TRANSLATABLE_CHARS.has(d), `digit ${d}`).toBe(true);
    }
    const glyphs = [
      '·',
      '×',
      '‰',
      '%',
      '/',
      ':',
      '(',
      ')',
      '[',
      ']',
      ',',
      '.',
      '-',
      '—',
      '+',
      '#',
      '°',
      "'",
      '"',
    ];
    expect(glyphs.length).toBe(19);
    for (const g of glyphs) expect(NON_TRANSLATABLE_CHARS.has(g), `glyph ${g}`).toBe(true);
    // Explicit code-point pins for the glyphs that have look-alikes. `String.fromCharCode`, not a
    // `\u` escape: the format hook rewrites escapes into the literal glyph, which for U+00A0
    // below would be indistinguishable from a space on the page.
    const cp = (code: number): string => String.fromCharCode(code);
    expect(NON_TRANSLATABLE_CHARS.has(cp(0x2014)), 'em dash U+2014').toBe(true);
    expect(NON_TRANSLATABLE_CHARS.has(cp(0x00b7)), 'middle dot U+00B7').toBe(true);
    expect(NON_TRANSLATABLE_CHARS.has(cp(0x00d7)), 'multiplication sign U+00D7').toBe(true);
    expect(NON_TRANSLATABLE_CHARS.has(cp(0x2030)), 'per mille U+2030').toBe(true);
    expect(NON_TRANSLATABLE_CHARS.has(cp(0x00b0)), 'degree U+00B0').toBe(true);
    expect(NON_TRANSLATABLE_CHARS.has(cp(0x0027)), "apostrophe U+0027 (')").toBe(true);
    expect(NON_TRANSLATABLE_CHARS.has(cp(0x0022)), 'quotation mark U+0022 (")').toBe(true);
    // Every member is a single UTF-16 code unit (no surrogate-pair glyph slipped in).
    for (const m of NON_TRANSLATABLE_CHARS) expect(m.length, `member ${JSON.stringify(m)}`).toBe(1);

    // The whole set concatenated is CLEAN; the empty segment is CLEAN.
    expect(isCleanSegment([...NON_TRANSLATABLE_CHARS].join(''))).toBe(true);
    expect(isCleanSegment('')).toBe(true);
    expect(isCleanSegment(' — ')).toBe(true);
    expect(isCleanSegment(' · ')).toBe(true);
    expect(isCleanSegment('12/34:56 (+7‰) ×8 90%')).toBe(true);
    // Default-fail: a LONE letter fails — no minimum length of any kind (F2).
    expect(isCleanSegment('W')).toBe(false);
    expect(isCleanSegment('L')).toBe(false);
    expect(isCleanSegment('v')).toBe(false);
    expect(isCleanSegment('Lv')).toBe(false);
    expect(isCleanSegment(' (W')).toBe(false);
    expect(isCleanSegment('/L')).toBe(false);
    // Backslash (an escape sequence) is not a member — fails toward extraction.
    expect(isCleanSegment('\\')).toBe(false);
    // Whitespace is ASCII-only: NBSP (U+00A0) and en dash (U+2013) are look-alikes OUTSIDE the
    // set (code-point constructed — see the `cp` note above).
    expect(cp(0x00a0)).not.toBe(' ');
    expect(isCleanSegment(cp(0x00a0)), 'NBSP U+00A0').toBe(false);
    expect(cp(0x2013)).not.toBe(cp(0x2014));
    expect(isCleanSegment(cp(0x2013)), 'en dash U+2013').toBe(false);
    expect(isCleanSegment(cp(0x2026)), 'ellipsis U+2026').toBe(false);
    expect(isCleanSegment(cp(0x2192)), 'arrow U+2192').toBe(false);
  });

  it('m24s2 I18N-13: BAD (1) lvSpan.textContent = `Lv${card.level}` fails on the static segment Lv (kills bare-literal-only scanning, vacuity (b))', () => {
    const r = scanSource(BAD_1_LV);
    expect(counts(r)).toEqual({ sinks: 1, failing: 1 });
    expect(r.sinks[0].kind).toBe('textContent');
    expect(r.sinks[0].line).toBe(1);
    // R2: the only static run is `Lv` (the run after `${card.level}` is empty and not a segment).
    expect(r.sinks[0].segments).toEqual(['Lv']);
    expect(failingSegmentsOf(r)).toEqual(['Lv']);
    expect(r.unterminated).toBe(false);
    expect(r.sinks[0].truncated).toBe(false);
    // `failing` is exactly the segment-failing subset of `sinks` (same objects, same order).
    expect(r.failing).toEqual(r.sinks.filter((s) => s.failingSegments.length > 0));
  });

  it('m24s2 I18N-14: BAD (2) li.textContent = `${n} — ${r} (W${w}/L${l})` fails on the 1-character segments  (W and /L (kills any length threshold, vacuity (c))', () => {
    const r = scanSource(BAD_2_WL);
    expect(counts(r)).toEqual({ sinks: 1, failing: 1 });
    // Static segments outside every ${}: ' — ' (clean), ' (W' (W fails), '/L' (L fails), ')' (clean).
    expect(r.sinks[0].segments).toEqual([' — ', ' (W', '/L', ')']);
    expect(failingSegmentsOf(r)).toEqual([' (W', '/L']);
    expect(r.unterminated).toBe(false);
  });

  it('m24s2 I18N-15: GOOD (1) glyph-only template passes {1,0}; BAD (3) raw literal fails {1,1}; GOOD (3) commented-out literal above a t() call passes through stripComments {1,0}; vacuity (a) one t() + one raw literal yields {2,1} per sink', () => {
    // GOOD (1): ' · ' is all-glyph — the closed set is not a blanket alphabetic ban.
    const good1 = scanSource(GOOD_1_DOT);
    expect(counts(good1)).toEqual({ sinks: 1, failing: 0 });
    expect(good1.sinks[0].segments).toEqual([' · ']);
    expect(good1.sinks[0].failingSegments).toEqual([]);

    // BAD (3): a bare string literal is ONE static segment under the same rule.
    const bad3 = scanSource(BAD_3_RENAME);
    expect(counts(bad3)).toEqual({ sinks: 1, failing: 1 });
    expect(failingSegmentsOf(bad3)).toEqual(['Rename']);

    // GOOD (3): the commented line is gone after stripping, the newline is kept (line numbers
    // stay stable) and the surviving sink's RHS is a t( call span — zero segments.
    const stripped = stripComments(GOOD_3_COMMENTED);
    expect(stripped.indexOf('Rename')).toBe(-1);
    const good3 = scanSource(stripped);
    expect(counts(good3)).toEqual({ sinks: 1, failing: 0 });
    expect(good3.sinks[0].line).toBe(2);
    expect(good3.sinks[0].segments).toEqual([]);
    // Control: the same two lines with the comment marker removed (and the first statement
    // terminated) are two sinks, one failing — the `//` is the only thing that makes GOOD (3) pass.
    const good3Control = scanSource(GOOD_3_CONTROL);
    expect(counts(good3Control)).toEqual({ sinks: 2, failing: 1 });
    expect(good3Control.failing[0].line).toBe(1);

    // Vacuity (a): per-file classification would pass this file on its one t() call.
    const vac = scanSource(VACUITY_A);
    expect(counts(vac)).toEqual({ sinks: 2, failing: 1 });
    expect(vac.sinks[0].line).toBe(1);
    expect(vac.sinks[1].line).toBe(2);
    expect(vac.failing[0].line).toBe(2);
    expect(failingSegmentsOf(vac)).toEqual(['raw']);
  });

  it('m24s2 I18N-16: setAttribute is a sink only when its FIRST argument is a bare literal in the 5-member allowlist, decided before any RHS character is read; .id/.className/.style.cssText/.dataset/addEventListener are structurally absent', () => {
    // The allowlist is exactly the spec's five (HC-02).
    expect([...SET_ATTRIBUTE_ALLOWLIST].sort()).toEqual([
      'alt',
      'aria-describedby',
      'aria-label',
      'aria-live',
      'title',
    ]);
    // BAD (4): allowlisted name, raw value.
    const bad4 = scanSource(BAD_4_ARIA);
    expect(counts(bad4)).toEqual({ sinks: 1, failing: 1 });
    expect(bad4.sinks[0].kind).toBe('setAttribute');
    expect(failingSegmentsOf(bad4)).toEqual(['Empty slot']);
    // GOOD (2): 'data-testid' is EXCLUDED before classification — 'box-slot' would fail if read.
    expect(counts(scanSource(GOOD_2_TESTID))).toEqual({ sinks: 0, failing: 0 });
    // Structural absence: none of these is a sink at all.
    expect(counts(scanSource(STRUCTURAL_ABSENCE))).toEqual({ sinks: 0, failing: 0 });
    // Allowlisted name + t() value → sink, passes.
    expect(counts(scanSource(SET_ATTR_T))).toEqual({ sinks: 1, failing: 0 });
    // 'title' and 'aria-live' are allowlisted; raw values fail under the character rule.
    expect(counts(scanSource(SET_ATTR_TITLE_RAW))).toEqual({ sinks: 1, failing: 1 });
    expect(counts(scanSource(SET_ATTR_LIVE_RAW))).toEqual({ sinks: 1, failing: 1 });
    // 'alt' / 'aria-describedby' with an identifier value → sink, passes (zero segments).
    expect(counts(scanSource(SET_ATTR_ALT_IDENT))).toEqual({ sinks: 1, failing: 0 });
    expect(counts(scanSource(SET_ATTR_DESCRIBEDBY_IDENT))).toEqual({ sinks: 1, failing: 0 });
    // A NON-literal first argument is not a sink (documented residual, ADR-0257 Consequences).
    expect(counts(scanSource(SET_ATTR_NONLITERAL_NAME))).toEqual({ sinks: 0, failing: 0 });
    // Double-quoted first argument is a bare literal too.
    expect(counts(scanSource(SET_ATTR_DQ))).toEqual({ sinks: 1, failing: 1 });
    // A template value inside setAttribute decomposes like any other RHS.
    const tpl = scanSource(SET_ATTR_TEMPLATE);
    expect(counts(tpl)).toEqual({ sinks: 1, failing: 1 });
    expect(failingSegmentsOf(tpl)).toEqual(['Lv']);
    // biome-wrapped multi-line call with a trailing comma.
    const multi = scanSource(SET_ATTR_MULTILINE);
    expect(counts(multi)).toEqual({ sinks: 1, failing: 1 });
    expect(failingSegmentsOf(multi)).toEqual(['Raw value']);
  });

  it('m24s2 I18N-HC-01: every RHS shape — literals at any depth outside t(/tf( spans contribute segments; zero segments pass; span ends at depth-0 delimiters; tripwires fire', () => {
    const check = (label: string, src: string, expected: Counts, segments?: string[]): void => {
      const r = scanSource(src);
      expect(counts(r), label).toEqual(expected);
      if (segments) expect(failingSegmentsOf(r), `${label} segments`).toEqual(segments);
      expect(r.unterminated, `${label} unterminated`).toBe(false);
      for (const s of r.sinks) expect(s.truncated, `${label} truncated`).toBe(false);
    };

    // Conditional / logical shapes.
    check('ternary raw', RHS_TERNARY_RAW, { sinks: 1, failing: 1 }, ['A', 'B']);
    check('ternary t()', RHS_TERNARY_T, { sinks: 1, failing: 0 });
    check("t() + ' ' + n", RHS_T_PLUS_SPACE, { sinks: 1, failing: 0 });
    check("t() + 'Raw' (span ends at its paren)", RHS_T_PLUS_RAW, { sinks: 1, failing: 1 }, [
      'Raw',
    ]);
    check("t() || 'Raw'", RHS_T_OR_RAW, { sinks: 1, failing: 1 }, ['Raw']);
    // Exemption boundary (plan R3): identifier boundary, no `.` receiver, no whitespace.
    check('obj.t() is NOT exempt', RHS_OBJ_T, { sinks: 1, failing: 1 }, ['Raw']);
    check('at() is NOT exempt', RHS_AT_CALL, { sinks: 1, failing: 1 }, ['Raw']);
    check('t () is NOT exempt', RHS_T_SPACE_PAREN, { sinks: 1, failing: 1 }, ['Raw']);
    check('tf() with an object arg is exempt', RHS_TF, { sinks: 1, failing: 0 });
    check('t() with nested parens is exempt through the balance', RHS_T_NESTED, {
      sinks: 1,
      failing: 0,
    });
    check('wrap(t())', RHS_WRAP_T, { sinks: 1, failing: 0 });
    check("wrap('Raw') — literal at depth 1", RHS_WRAP_RAW, { sinks: 1, failing: 1 }, ['Raw']);
    // Zero-segment RHS passes.
    check('String(n)', RHS_STRING_N, { sinks: 1, failing: 0 });
    check('bare identifier', RHS_IDENT, { sinks: 1, failing: 0 });
    check("'' (empty literal, empty segment)", RHS_EMPTY, { sinks: 1, failing: 0 });
    // replaceChildren payloads.
    check('replaceChildren()', RHS_RC_EMPTY, { sinks: 1, failing: 0 });
    check('replaceChildren(...nodes)', RHS_RC_SPREAD, { sinks: 1, failing: 0 });
    check(
      "replaceChildren(helper('Raw')) shopView.ts:125",
      RHS_RC_HELPER_RAW,
      { sinks: 1, failing: 1 },
      ['Raw'],
    );
    check("replaceChildren('Hi')", RHS_RC_STRING, { sinks: 1, failing: 1 }, ['Hi']);
    check(
      "replaceChildren(t('a'), 'Raw') — second arg",
      RHS_RC_SECOND_ARG_RAW,
      { sinks: 1, failing: 1 },
      ['Raw'],
    );
    // Template interpolation contents recurse (ADR-0257 D3).
    check("`${c ? 'A' : 'B'}`", RHS_TPL_TERNARY, { sinks: 1, failing: 1 }, ['A', 'B']);
    check("`${x ?? ''}`", RHS_TPL_NULLISH_EMPTY, { sinks: 1, failing: 0 });
    check("`${t('a')} · ${t('b')}`", RHS_TPL_TWO_T, { sinks: 1, failing: 0 });
    // Span boundaries.
    const multi = scanSource(RHS_MULTILINE_TERNARY);
    expect(counts(multi), 'multi-line ternary + second sink').toEqual({ sinks: 2, failing: 1 });
    expect(multi.sinks[0].line, 'first sink line').toBe(1);
    expect(multi.sinks[1].line, 'second sink line').toBe(4);
    expect(failingSegmentsOf(multi), 'multi-line ternary segments').toEqual(['Yes', 'No']);
    expect(multi.failing[0].line).toBe(1);
    check('arrow body (el.textContent = x) ends at the depth-0 )', RHS_ARROW_PAREN, {
      sinks: 1,
      failing: 0,
    });
    check("comma operator: 'Raw', other()", RHS_COMMA_END, { sinks: 1, failing: 1 }, ['Raw']);
    check('newline after =', RHS_NEWLINE_AFTER_EQ, { sinks: 1, failing: 1 }, ['Raw']);
    check(
      'x ??\\n  Raw (evolutionView.ts:248 shape)',
      RHS_NULLISH_NEWLINE,
      { sinks: 1, failing: 1 },
      ['Raw'],
    );
    check(
      'multi-line + concat (boxView.ts:94 shape)',
      RHS_MULTILINE_CONCAT,
      { sinks: 1, failing: 1 },
      ['Only monsters ', 'can battle.'],
    );
    // Operator discrimination (plan Q3).
    check('+= is a sink', RHS_PLUS_EQ, { sinks: 1, failing: 1 }, ['x']);
    check('=== is a read', RHS_STRICT_EQ, { sinks: 0, failing: 0 });
    check('== is a read', RHS_LOOSE_EQ, { sinks: 0, failing: 0 });
    check('.titleEl is another member', RHS_TITLE_EL, { sinks: 0, failing: 0 });
    const title = scanSource(RHS_TITLE_RAW);
    expect(counts(title), '.title = Raw').toEqual({ sinks: 1, failing: 1 });
    expect(title.sinks[0].kind).toBe('title');
    check('vm.title; is a read', RHS_TITLE_READ, { sinks: 0, failing: 0 });
    check('vm.title( is a call', RHS_TITLE_CALL, { sinks: 0, failing: 0 });
    check('??= / ||= are not sinks', RHS_LOGICAL_ASSIGN, { sinks: 0, failing: 0 });
    // Coverage fixtures (plan R8).
    check('`${fmt({ n: 1 })}` — brace depth inside an interpolation, no literal', RHS_TPL_BRACES, {
      sinks: 1,
      failing: 0,
    });
    check("setAttribute('alt') — allowlisted name, empty payload", SET_ATTR_NO_VALUE, {
      sinks: 1,
      failing: 0,
    });
    check("setAttribute('title' + x, 'Raw') — non-bare first arg", SET_ATTR_CONCAT_NAME, {
      sinks: 0,
      failing: 0,
    });

    // Tripwires (ADR-0257 D6).
    expect(scanSource(RHS_UNTERMINATED).unterminated, 'unterminated literal').toBe(true);
    const trunc = scanSource(RHS_TRUNCATED);
    expect(trunc.sinks.length, 'truncated: the sink is still reported').toBe(1);
    expect(trunc.sinks[0].truncated, 'truncated flag').toBe(true);
    // Plan R5: mask desync without an unterminated signal must still be LOUD.
    const flip = scanSource(RHS_PARITY_FLIP);
    expect(flip.unterminated, 'parity flip leaves unterminated false — that is the point').toBe(
      false,
    );
    expect(flip.maskedSinkTokens, 'parity flip: the masked .textContent = must be counted').toBe(1);
    // And a healthy source reports zero masked tokens.
    expect(scanSource(BAD_3_RENAME).maskedSinkTokens).toBe(0);
    expect(scanSource(VACUITY_A).maskedSinkTokens).toBe(0);
  });

  it('m24s2 I18N-17: the real scan reads every non-test client/src/**/*.ts, finds all 19 SCAN_TARGETS present and non-empty, observes >= SINK_FLOOR sinks, and trips no unterminated/truncated/masked tripwire', () => {
    // The roster is the spec's 19 (main.ts + 18 ui/*View.ts), sorted, no duplicates.
    expect(SCAN_TARGETS.length).toBe(19);
    expect([...SCAN_TARGETS].sort()).toEqual([...SCAN_TARGETS]);
    expect(new Set(SCAN_TARGETS).size).toBe(19);
    expect(SCAN_TARGETS).toContain('main.ts');
    expect(SCAN_TARGETS.filter((f) => f.startsWith('ui/') && f.endsWith('View.ts')).length).toBe(
      18,
    );
    expect(SINK_FLOOR).toBe(169);

    const tree = scan();
    const byFile = new Map(tree.perFile.map((p) => [p.file, p]));
    // HC-05: present-or-fail, never a skip. Also non-empty after stripping.
    for (const target of SCAN_TARGETS) {
      expect(tree.files, `SCAN_TARGET missing from the walk: ${target}`).toContain(target);
      const entry = byFile.get(target);
      expect(entry, `SCAN_TARGET not scanned: ${target}`).toBeDefined();
      expect(entry!.stripped.trim().length, `${target} is empty after stripping`).toBeGreaterThan(
        0,
      );
    }
    // The two post-spec player-facing files are inside the scope (plan R1).
    expect(tree.files).toContain('ui/privacyView.ts');
    expect(tree.files).toContain('ui/evolutionNotice.ts');

    // HC-03: the whole-tree total is at or above the floor.
    expect(
      tree.sinks.length,
      `scanner saw ${tree.sinks.length} sinks < SINK_FLOOR ${SINK_FLOOR} — it has stopped seeing the tree`,
    ).toBeGreaterThanOrEqual(SINK_FLOOR);

    // D6 tripwires: every file's mask terminated, no masked sink token, no truncated RHS.
    const unterminated = tree.perFile.filter((p) => p.result.unterminated).map((p) => p.file);
    expect(unterminated, `unterminated literal mask in: ${unterminated.join(', ')}`).toEqual([]);
    const masked = tree.perFile
      .filter((p) => p.result.maskedSinkTokens > 0)
      .map((p) => `${p.file} (${p.result.maskedSinkTokens})`);
    expect(masked, `sink token at a masked index (mask desync) in: ${masked.join(', ')}`).toEqual(
      [],
    );
    const truncated = tree.sinks.filter((e) => e.sink.truncated).map(describeSink);
    expect(truncated, `truncated RHS span(s):\n${truncated.join('\n')}`).toEqual([]);

    // Consistency: the per-file `failing` is exactly the segment-failing subset of `sinks`.
    for (const p of tree.perFile) {
      expect(p.result.failing, `${p.file}: failing != sinks.filter(failingSegments)`).toEqual(
        p.result.sinks.filter((s) => s.failingSegments.length > 0),
      );
    }

    // Plan Q6/R6: the helper's RAW source (comments included) carries none of the tokens other
    // source-scanning gates census — a vocabulary leak would trip THEIR gates on THIS file.
    const helperRaw = readFileSync(HELPER_PATH, 'utf8');
    for (const token of HELPER_FORBIDDEN_TOKENS) {
      expect(
        countOccurrences(helperRaw, token),
        `hardcodedStrings.ts contains forbidden token ${token}`,
      ).toBe(0);
    }
  });

  it('m24s2 I18N-18: the failing-sink count does not exceed HARDCODED_CEILING from __fixtures__/i18n-hardcoded.json', () => {
    const ceiling = readCeiling(readFileSync(CEILING_PATH, 'utf8'));
    const tree = scan();
    const beyond = tree.failing.slice(ceiling).map(describeSink);
    const message = [
      `${tree.failing.length} failing sinks > HARDCODED_CEILING ${ceiling}.`,
      'Migrate them to t()/tf() (never raise the ceiling). Failing sinks beyond the ceiling:',
      ...beyond,
    ].join('\n');
    expect(tree.failing.length, message).toBeLessThanOrEqual(ceiling);
  });

  it('m24s2 I18N-18x: HARDCODED_CEILING equals the measured failing count exactly (shrink-only made mechanical), the JSON is exactly {HARDCODED_CEILING: non-negative integer <= sinks}, and never exceeds CEILING_AT_S2', () => {
    // Shape teeth for readCeiling itself: string / float / negative / extra key / array all throw.
    expect(() => readCeiling('{"HARDCODED_CEILING":"3"}')).toThrow('non-negative integer');
    expect(() => readCeiling('{"HARDCODED_CEILING":1.5}')).toThrow('non-negative integer');
    expect(() => readCeiling('{"HARDCODED_CEILING":-1}')).toThrow('non-negative integer');
    expect(() => readCeiling('{"HARDCODED_CEILING":true}')).toThrow('non-negative integer');
    expect(() => readCeiling('{"HARDCODED_CEILING":3,"x":1}')).toThrow('exactly one key');
    expect(() => readCeiling('{"ceiling":3}')).toThrow('exactly one key');
    expect(() => readCeiling('[3]')).toThrow('plain object');
    expect(readCeiling('{"HARDCODED_CEILING": 0}\n')).toBe(0);
    expect(readCeiling('{"HARDCODED_CEILING":42}')).toBe(42);

    const rawJson = readFileSync(CEILING_PATH, 'utf8');
    const ceiling = readCeiling(rawJson);
    expect(Object.keys(JSON.parse(rawJson))).toEqual(['HARDCODED_CEILING']);
    expect(Number.isInteger(ceiling)).toBe(true);
    expect(ceiling).toBeGreaterThanOrEqual(0);
    expect(
      ceiling,
      `HARDCODED_CEILING ${ceiling} > CEILING_AT_S2 ${CEILING_AT_S2}: the ceiling never rises above the S2 mark`,
    ).toBeLessThanOrEqual(CEILING_AT_S2);

    const tree = scan();
    expect(ceiling, 'HARDCODED_CEILING must not exceed the sink total').toBeLessThanOrEqual(
      tree.sinks.length,
    );
    const measured = tree.failing.length;
    let message: string | undefined;
    if (measured < ceiling) {
      message = [
        `ceiling stale: lower HARDCODED_CEILING to ${measured} in __fixtures__/i18n-hardcoded.json`,
        '— shrink-only, reviewed edit; if a sibling slice merged first, re-measure and edit the one line',
      ].join(' ');
    } else if (measured > ceiling) {
      message = [
        `${measured} failing sinks exceed HARDCODED_CEILING ${ceiling} — migrate, never raise`,
        '(see the preceding <= test for the list)',
      ].join(' ');
    }
    expect(measured, message).toBe(ceiling);
  });
});
