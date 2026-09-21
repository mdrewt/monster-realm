// ui/i18n/catalogRoundTrip.test.ts — the M24 S8 ICU round-trip gate: I18N-29 (export → import →
// re-export identity) and I18N-30 (no RegExp in either script), plus the completion baseline
// (§5.5) and both CLIs (m24-s8, ADR-0264).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M24-internationalization.spec.md §2.6, §5.5, §6 S8
// [I18N-29/I18N-30]; memory/projects/monster-realm-m24-s8-plan.md §1–§4 as AMENDED by §10
// (A1 quoting, A2 biome quote flip, A4 gap-only ratchet, A5 verbatim description, A7 structured
// `err.code`, A10 runtime-truth oracle, A11 behavioural RegExp oracle, A12 process.execPath).
//
// VEHICLE (ADR-0224): a co-located vitest suite importing the two main-guarded `.mjs` scripts
// statically (precedent: catalogShape.test.ts importing an eval). RED REASON AT HEAD:
// `scripts/catalog-export.mjs` and `scripts/catalog-import.mjs` DO NOT EXIST — the static
// imports below fail to resolve, so the whole file fails at COLLECTION (0 tests run) until the
// specialist ships both scripts.
//
// ZERO RegExp anywhere in this file (ADR-0055; a regex literal also blinds the single-owner
// `stripComments`): every scan is `indexOf` / `charCodeAt` / a hand-rolled char walk. The
// needles that name banned tokens (`RegExp`, `eval(`, `.test(` …) are never spelled in CODE —
// each is SPLICED from two halves at runtime — so a code-scanning gate over test files cannot
// mistake the pin for a use; they ARE spelled in comments like this one, which is fine because
// the raw-text pins run against the two SCRIPTS, never against this file.
//
// Every fixture is asserted EXACTLY ONCE; every assertion message names the WRONG IMPLEMENTATION
// it kills. Nothing is ever written under client/src/ui/i18n (fixtures are in-memory; emitted
// files go to a mkdtemp under the OS tmpdir, or — only if vitest refuses to import a `.ts` from
// there — to the gitignored client/test-results/m24-s8-<pid>/, both removed in afterAll).
//
// CONTRACT (the exact API this suite programs against; the implementer builds THIS — where it
// differs from the plan the difference is deliberate and listed in the tester's report):
//   scripts/catalog-export.mjs (ESM, main-guarded, zero RegExp; PROJECT_ROOT = dirname/..) exports
//     discoverLocales(i18nDir = <root>/client/src/ui/i18n): string[]
//       sorted <tag>s of `catalog.<tag>.ts` (never `*.test.ts`); LOCALE-UNSUPPORTED on a tag
//       `Intl.PluralRules.supportedLocalesOf` rejects.
//     parseCatalogSource(source, { tag, file }): { tag, entries: Entry[] }   (RAW source, comments
//       included — never the runtime module)
//       Entry = { key, kind: 'plain' | 'closure', text, params: string[],
//                 plurals: Record<param, PluralForms(six keys zero/one/two/few/many/other)>,
//                 description: string, translated: boolean }
//       HOLE MODEL: `text` is the DECODED value text. In a closure a param hole is spelled
//         `${p.<name>}` and a plural hole `${plural.<name>}` — the hoisted forms-const NAME is
//         dropped from the text (its six forms live in plurals[<name>]); a plain entry's text has
//         no holes. A decoded literal `${` (source `\${`) is PARSE (the importer rejects it too).
//       params = first-appearance order of every distinct <name> across both hole kinds.
//       description (A5, verbatim): the block's first line MUST be `// @desc:`; description =
//         marker remainder + every following block line with its leading `// ` (or bare `//`)
//         stripped, joined with '\n', `// @translated:` lines excluded. No notes, no citation
//         heuristic, no wrapping. A block not directly above an entry is ignored (SHAPE-01).
//       translated: `// @translated: false` → false; `// @translated: true` or no marker → true;
//         any other value → PARSE. Trailing comment on an entry line → PARSE. Trailing comma
//         after the last entry optional. `"…"` plain values accepted (A2). No `oneOther` (A8).
//     toIcuMessage(entry, liveCategories): string   (A1 DOUBLE_REQUIRED emission)
//     liveCategories(tag): string[]   canonical zero,one,two,few,many,other filtered by
//       new Intl.PluralRules(tag).resolvedOptions().pluralCategories
//     exportLocale(tag, { i18nDir } = {}): { json, text }   text = JSON.stringify(json, null, 2) + '\n'
//       json = { locale, sourceLocale: 'en', generatedBy: 'scripts/catalog-export.mjs',
//                messages: { [key]: { message, description, params, translated } } } — catalog
//       order, exactly those four per-message fields, no timestamp.
//     computeCompletion(models: Array<{ tag, entries }>): { [tag]: { total, translated, gap } }
//       (keys sorted by tag; gap = total − translated)
//     checkCompletion(live, baseline): { lines: string[], exitCode: 0 | 1 }   A4 gap-only:
//       per tag of baseline ∪ live (sorted): OK | REGRESSION (tag missing live, or live.gap >
//       base.gap) | STALE (live.gap < base.gap, or tag absent from baseline); total/translated
//       are informational (never compared). Lines, EXACT (RT-11 pins all four verdict shapes):
//         `i18n-completion: <tag> total=<n> translated=<n> gap=<n> OK`
//         `i18n-completion: <tag> total=<n> translated=<n> gap=<n> REGRESSION gap <b> -> <l>`
//         `i18n-completion: <tag> total=- translated=- gap=- REGRESSION missing live (baseline gap <b>)`
//         `i18n-completion: <tag> total=<n> translated=<n> gap=<n> STALE gap <b> -> <l>`
//         `i18n-completion: <tag> total=<n> translated=<n> gap=<n> STALE not in baseline`
//         then `i18n-completion: <k> locale(s) checked, <m> not OK`; exitCode 1 iff m > 0.
//     Errors: Object.assign(new Error('catalog-export: <CODE> <detail>'), { code: '<CODE>' }),
//       CODE ∈ { PARSE (detail starts `<file>:<line>:`), LOCALE-UNSUPPORTED, LOCALE-IS-SOURCE }.
//     CLI: `[--out <dir>]` | `--completion [--check] [--baseline <path>]` | `--seed <tag> [--out
//       <dir>]`, each accepting `--i18n-dir <dir>` (M5: the catalog directory to read instead of
//       <root>/client/src/ui/i18n — this is how the A4 WRITER refusal is exercised: `--completion
//       --i18n-dir <dir> --baseline <b>` with a live gap larger than <b>'s prints the REGRESSION
//       line to stdout, exits 1 and leaves <b> byte-unchanged); exit 0 ok / 1 check failed (incl.
//       BASELINE-MISSING, writer refusal) / 2 usage or a named error on stderr (`catalog-export:
//       <CODE> …`). cwd-independent. Importing the module never runs main (no stdout, no writes).
//   scripts/catalog-import.mjs (imports parseCatalogSource/discoverLocales from ./catalog-export.mjs)
//     parseIcuMessage(message, { liveCategories, roster }): { text, params, plurals }
//       same hole model; plurals[<name>] = Record<liveCategory, decoded branch text> (live
//       categories only, as authored); ICU4J DOUBLE_OPTIONAL decoding (A1); whitespace-free ICU
//       (`{n,plural,one{a}other{b}}`, `{ x }`) parses.
//     validateImport(json, { tag, enModel }): ImportModel = { tag, entries: Entry[] }   PURE —
//       entries in enModel order, plurals filled to six keys with dead categories = the `other`
//       form. Accepts tag 'en' (the round-trip identity for en is proven through it);
//       LOCALE-IS-SOURCE is importLocale's and the CLI's guard. Throws A7 codes.
//     emitCatalogTs(tag, model): string   header line 1 `// ui/i18n/catalog.<tag>.ts — generated
//       by scripts/catalog-import.mjs …` (no braces, no `oneOther(`, no `@desc:` in the header),
//       `import type { Catalog } from './messageIds';`, `import { cldr, selectPlural } from
//       './plural';` only when ≥1 plural, one `const <KEY_UPPER_DOT→_>_<PARAM_UPPER>_FORMS =
//       cldr({` per plural with one UNQUOTED `  <cat>: '<form>',` line per category,
//       `export const CATALOG_<TAG_UPPER,-→_>: Catalog = Object.freeze({`, per entry
//       `  // @desc: <line1>` / `  // <line n>` / `  // @translated: false` LAST when flagged /
//       `  '<key>': <value>,`, `} satisfies Catalog);`. Plain values AND forms lines take the A2
//       quote (double when the text has `'` and no `"`, else single with `\'`); closures
//       `(p) => \`…\`` with `${p.x}` and `${selectPlural('<tag>', p.n, <CONST>)}`. The
//       `.replace(` / `.replaceAll(` / `.split(` calls in both scripts must take a STRING LITERAL
//       first argument (RT-12's rule, applied to the comment-stripped source).
//     importLocale(tag, jsonText, { enModel, outPath }): void   SYNC. LOCALE-IS-SOURCE on 'en'
//       BEFORE any write; validate → emit → re-parse with parseCatalogSource → model compare
//       (EMIT-MISMATCH) → write `<outPath>.tmp` → rename.
//     Error codes (A7): LOCALE-MISMATCH, LOCALE-UNSUPPORTED, LOCALE-IS-SOURCE, KEY-SET-MISMATCH
//       (message names the keys), TRANSLATED-NOT-BOOLEAN, DESC-INVALID, PARAMS-MISMATCH,
//       ICU-SYNTAX, ICU-UNSUPPORTED, PLURAL-CATEGORIES, ICU-HASH, MSG-EMPTY, CONTROL-CHAR
//       (message / branch / description), FORMS-NAME-COLLISION, EMIT-MISMATCH.
//     CLI: `<tag> <file.icu.json> [--out <path>]`; exit 0 / 2 (`catalog-import: <CODE> …` on
//       stderr, nothing written); on success prints the out path and, for a tag NOT in
//       discoverLocales(), the four manual registration edits (resolver.ts CATALOGS,
//       resolver.test.ts, catalogParity.test.ts PLURAL_CATEGORIES / PLURAL_PARAM_KEYS).
//   I18N-30 text pins (RT-12) run on the RAW script text for `.test(` / `.exec(` / `new RegExp(`
//     (blind-proof) — so neither script may spell those even in a comment; on the comment-stripped
//     + literal-masked text for the `RegExp` / `Function(` / `eval(` / `import(` / `require(` /
//     `getBuiltinModule` / `globalThis` / `.match(` / `.matchAll(` / `.search(` tokens, a
//     regex-LITERAL detector (a `/` after `( , = : [ ! & | ? { } ; + - * % < > ~ ^` or after
//     return/typeof/case/in/of/do/else/throw/await/void), and a dangling-quote mask state; every
//     word-boundary `from` / bare `import '…'` specifier must be in {node:fs, node:path, node:url,
//     node:process, ./catalog-export.mjs} (`export … from` counts too).
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// The comment stripper is IMPORTED, never copied (ADR-0215 single-owner rule). Same path as
// catalogShape.test.ts:35.
import { stripComments } from '../../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import {
  checkCompletion,
  computeCompletion,
  discoverLocales,
  exportLocale,
  liveCategories,
  parseCatalogSource,
  toIcuMessage,
} from '../../../../scripts/catalog-export.mjs';
import {
  emitCatalogTs,
  importLocale,
  parseIcuMessage,
  validateImport,
} from '../../../../scripts/catalog-import.mjs';
import { CATALOG_EN } from './catalog.en';
import { CATALOG_FR } from './catalog.fr';
import { CATALOGS } from './resolver';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(I18N_DIR, '..', '..', '..');
const PROJECT_ROOT = path.resolve(CLIENT_DIR, '..');
const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
const EXPORT_SCRIPT = path.join(SCRIPTS_DIR, 'catalog-export.mjs');
const IMPORT_SCRIPT = path.join(SCRIPTS_DIR, 'catalog-import.mjs');
/** `client/node_modules/.bin/biome`, resolved explicitly (never PATH/npx) — a missing binary must
 *  RED RT-04/RT-05, never silently skip (ADR-0205 D6 precedent). */
const BIOME_BIN = path.join(CLIENT_DIR, 'node_modules', '.bin', 'biome');
const MESSAGE_IDS_PATH = path.join(I18N_DIR, 'messageIds.ts');
const SPAWN_TIMEOUT_MS = 30000;
const LONG_TEST_MS = 120000;

// ---------------------------------------------------------------------------
// Local types for the untyped .mjs surface.
// ---------------------------------------------------------------------------

type PluralForms = Readonly<Record<string, string>>;

interface Entry {
  readonly key: string;
  readonly kind: 'plain' | 'closure';
  readonly text: string;
  readonly params: readonly string[];
  readonly plurals: Readonly<Record<string, PluralForms>>;
  readonly description: string;
  readonly translated: boolean;
}

interface Model {
  readonly tag: string;
  readonly entries: readonly Entry[];
}

interface IcuMessage {
  message: string;
  description: string;
  params: string[];
  translated: boolean;
}

interface IcuJson {
  locale: string;
  sourceLocale: string;
  generatedBy: string;
  messages: Record<string, IcuMessage>;
}

interface Completion {
  readonly [tag: string]: {
    readonly total: number;
    readonly translated: number;
    readonly gap: number;
  };
}

type ParseCatalogSource = (source: string, opts: { tag: string; file: string }) => Model;
type ToIcuMessage = (entry: Entry, live: readonly string[]) => string;
type ExportLocale = (tag: string, opts?: { i18nDir?: string }) => { json: IcuJson; text: string };
type ComputeCompletion = (models: readonly Model[]) => Completion;
type CheckCompletion = (
  live: Completion,
  baseline: Completion,
) => { lines: string[]; exitCode: number };
type LiveCategories = (tag: string) => string[];
type DiscoverLocales = (dir?: string) => string[];
type ParseIcuMessage = (
  message: string,
  opts: { liveCategories: readonly string[]; roster: readonly string[] },
) => { text: string; params: string[]; plurals: Record<string, Record<string, string>> };
type ValidateImport = (json: unknown, opts: { tag: string; enModel: Model }) => Model;
type EmitCatalogTs = (tag: string, model: Model) => string;
type ImportLocale = (
  tag: string,
  jsonText: string,
  opts: { enModel: Model; outPath: string },
) => void;

const parseCatalog: ParseCatalogSource = parseCatalogSource;
const toIcu: ToIcuMessage = toIcuMessage;
const exportTag: ExportLocale = exportLocale;
const completionOf: ComputeCompletion = computeCompletion;
const checkBaseline: CheckCompletion = checkCompletion;
const liveCats: LiveCategories = liveCategories;
const discover: DiscoverLocales = discoverLocales;
const parseIcu: ParseIcuMessage = parseIcuMessage;
const validate: ValidateImport = validateImport;
const emitTs: EmitCatalogTs = emitCatalogTs;
const importTag: ImportLocale = importLocale;

// ---------------------------------------------------------------------------
// Shared primitives (no RegExp) — mirrored from catalogShape.test.ts.
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

function endsWith(s: string, suffix: string): boolean {
  if (s.length < suffix.length) return false;
  return s.slice(s.length - suffix.length) === suffix;
}

function countOccurrences(src: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

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

function nonWhitespaceCount(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) if (!isWhitespace(s.charAt(i))) count += 1;
  return count;
}

type MaskState = 'code' | 'sq' | 'dq' | 'tl';

/** Blanks string/template literal PAYLOAD (post comment-strip) — catalogShape.test.ts:1109 —
 *  and reports the FINAL scanner state: anything but 'code' means a dangling quote desynced the
 *  mask (a regex literal carrying a quote does exactly that), which is itself a finding (M2). */
function maskWithState(src: string): { masked: string; finalState: MaskState } {
  const out: string[] = [];
  let state: MaskState = 'code';
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
  return { masked: out.join(''), finalState: state };
}

/** Two halves glued at runtime so the banned token never appears verbatim in this file. */
function spliced(a: string, b: string): string {
  return a + b;
}

/** The `${` opener, built by concatenation so no string literal in this file ever holds a
 *  `${…}` (biome noTemplateCurlyInString) and no template literal needs an escape. */
const DOLLAR_BRACE = spliced('$', '{');

/** `${p.<name>}` — the CONTRACT param-hole token. */
function hole(name: string): string {
  return `${DOLLAR_BRACE}p.${name}}`;
}

/** `${plural.<name>}` — the CONTRACT plural-hole token. */
function pluralHole(name: string): string {
  return `${DOLLAR_BRACE}plural.${name}}`;
}

/** `${selectPlural('<tag>', p.<name>, <ident>)}` as catalog SOURCE text. */
function selectHole(tag: string, name: string, ident: string): string {
  return `${DOLLAR_BRACE}selectPlural('${tag}', p.${name}, ${ident})}`;
}

// ---------------------------------------------------------------------------
// Live inputs (memoised) + the MessageParams-derived sample params.
// ---------------------------------------------------------------------------

const modelCache = new Map<string, Model>();

function liveSource(tag: string): string {
  return readFileSync(path.join(I18N_DIR, `catalog.${tag}.ts`), 'utf8');
}

function liveModel(tag: string): Model {
  const cached = modelCache.get(tag);
  if (cached) return cached;
  const model = parseCatalog(liveSource(tag), { tag, file: `catalog.${tag}.ts` });
  modelCache.set(tag, model);
  return model;
}

function fieldNameOf(decl: string): string {
  let d = decl.trim();
  if (startsWith(d, 'readonly ')) d = d.slice('readonly '.length);
  const colon = d.indexOf(':');
  return (colon === -1 ? d : d.slice(0, colon)).trim();
}

/** Parses `export interface MessageParams { readonly '<key>': { readonly <f>: <T>; … }; … }` from
 *  comment-stripped messageIds.ts source — one-line and multi-line rows — into key → field
 *  names. Independent of the scripts under test: the closure roster they must find. */
function parseMessageParams(src: string): Map<string, string[]> {
  const stripped = stripComments(src);
  const start = stripped.indexOf('export interface MessageParams {');
  if (start === -1) throw new Error('messageIds.ts: export interface MessageParams not found');
  const lines = stripped.slice(start).split('\n');
  const out = new Map<string, string[]>();
  let openKey: string | undefined;
  let fields: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '}') break;
    const trimmed = line.trim();
    if (openKey === undefined) {
      if (!startsWith(trimmed, "readonly '")) continue;
      const rest = trimmed.slice("readonly '".length);
      const close = rest.indexOf("'");
      const key = rest.slice(0, close);
      const afterKey = rest.slice(close + 1);
      const braceAt = afterKey.indexOf('{');
      const braceEnd = afterKey.indexOf('}');
      if (braceEnd !== -1) {
        const body = afterKey.slice(braceAt + 1, braceEnd);
        out.set(
          key,
          body
            .split(';')
            .map((d) => d.trim())
            .filter((d) => d.length > 0)
            .map(fieldNameOf),
        );
      } else {
        openKey = key;
        fields = [];
      }
    } else if (startsWith(trimmed, '}')) {
      out.set(openKey, fields);
      openKey = undefined;
    } else if (trimmed.length > 0) {
      fields.push(fieldNameOf(trimmed));
    }
  }
  return out;
}

let cachedParams: Map<string, string[]> | undefined;

function messageParams(): Map<string, string[]> {
  if (!cachedParams) cachedParams = parseMessageParams(readFileSync(MESSAGE_IDS_PATH, 'utf8'));
  return cachedParams;
}

/** Param names that are PLURAL holes in ANY live locale (fr's `turns` today) — those must be
 *  real numbers (catalogParity's PLURAL_PARAM_KEYS reasoning); every other field gets a
 *  distinctive string, which template interpolation renders identically for number/bigint. */
function pluralParamsOf(key: string): Set<string> {
  const out = new Set<string>();
  for (const tag of discover()) {
    const entry = liveModel(tag).entries.find((e) => e.key === key);
    if (entry) for (const name of Object.keys(entry.plurals)) out.add(name);
  }
  return out;
}

const PLURAL_SAMPLE_NUMBERS: readonly number[] = [1, 2, 1_000_000];

function samplesFor(key: string): Array<Record<string, unknown>> {
  const fields = messageParams().get(key);
  if (fields === undefined) throw new Error(`no MessageParams row for closure key '${key}'`);
  const numeric = pluralParamsOf(key);
  const rounds = numeric.size > 0 ? PLURAL_SAMPLE_NUMBERS : [0];
  return rounds.map((n) => {
    const p: Record<string, unknown> = {};
    for (const f of fields) p[f] = numeric.has(f) ? n : `«${key}:${f}»`;
    return p;
  });
}

/** Renders an Entry's hole-model text with concrete params — the TEST's own substitution, so
 *  RT-01 compares the parser's model against the real closure's output. */
function renderEntry(entry: Entry, tag: string, params: Record<string, unknown>): string {
  let out = '';
  let i = 0;
  const text = entry.text;
  for (;;) {
    const at = text.indexOf(DOLLAR_BRACE, i);
    if (at === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, at);
    const close = text.indexOf('}', at);
    if (close === -1) throw new Error(`unterminated hole in '${entry.key}': ${text}`);
    const inner = text.slice(at + 2, close);
    if (startsWith(inner, 'p.')) {
      out += String(params[inner.slice(2)]);
    } else if (startsWith(inner, 'plural.')) {
      const name = inner.slice('plural.'.length);
      const forms = entry.plurals[name];
      if (forms === undefined)
        throw new Error(`'${entry.key}': plural hole '${name}' has no forms`);
      out += forms[new Intl.PluralRules(tag).select(Number(params[name]))];
    } else {
      throw new Error(`'${entry.key}': unknown hole kind '${inner}' — CONTRACT hole model`);
    }
    i = close + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

const DESC = 'Fixture description long enough to satisfy SHAPE-01 for this entry.';

/** A minimal catalog SOURCE around the given entry lines (each entry line array = the `//`
 *  block + value lines, already indented). */
function catalogSource(
  tag: string,
  hoisted: readonly string[],
  entryLines: readonly string[],
): string {
  const upper = tag.toUpperCase();
  return [
    "import type { Catalog } from './messageIds';",
    ...hoisted,
    '',
    `export const CATALOG_${upper}: Catalog = Object.freeze({`,
    ...entryLines,
    '} satisfies Catalog);',
    '',
  ].join('\n');
}

function plainEntry(key: string, value: string): string[] {
  return [`  // @desc: ${DESC}`, `  '${key}': ${value},`];
}

function mkEntry(over: Partial<Entry> & { key: string; text: string }): Entry {
  return {
    kind: 'plain',
    params: [],
    plurals: {},
    description: DESC,
    translated: true,
    ...over,
  };
}

const SIX_FR_FORMS: PluralForms = Object.freeze({
  zero: 'tour',
  one: 'tour',
  two: 'tours',
  few: 'tours',
  many: 'de tours',
  other: 'tours',
});

function sixForms(one: string, other: string, many = other): PluralForms {
  return Object.freeze({ zero: other, one, two: other, few: other, many, other });
}

/** Catches, asserts the throw happened, asserts the STRUCTURED code (A7) — never message text. */
function expectCode(fn: () => unknown, code: string, why: string): Error {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(
    caught,
    `${why} — must THROW (an accept-and-guess implementation returned instead)`,
  ).toBeInstanceOf(Error);
  expect((caught as { code?: unknown }).code, `${why} — err.code`).toBe(code);
  return caught as Error;
}

// ---------------------------------------------------------------------------
// The reference ICU decoder (A1) — ICU4J MessagePattern DOUBLE_OPTIONAL apostrophe semantics on
// the depth-1 subset, written INDEPENDENTLY of the importer and used as the oracle for RT-03 and
// RT-09. `''` → `'`; a `'` followed by a syntax char (`{` `}` always, `#` inside a plural branch)
// opens a quoted span that ends at the next LONE `'` (`''` inside = literal `'`, span stays
// open); any other lone `'` is a literal apostrophe. A simple argument `{name}` becomes the
// hole-model token `${p.name}`. Stricter than ICU4J on two edges (never produced by the emitter,
// both A1 importer rules): an unterminated span and an unquoted branch `#` THROW.
// ---------------------------------------------------------------------------

function decodeIcuPattern(pattern: string, inPluralBranch: boolean): string {
  const n = pattern.length;
  const isSyntax = (ch: string): boolean =>
    ch === '{' || ch === '}' || (inPluralBranch && ch === '#');
  let out = '';
  let i = 0;
  while (i < n) {
    const ch = pattern.charAt(i);
    if (ch === "'") {
      const next = i + 1 < n ? pattern.charAt(i + 1) : '';
      if (next === "'") {
        out += "'";
        i += 2;
        continue;
      }
      if (!isSyntax(next)) {
        out += "'";
        i += 1;
        continue;
      }
      let j = i + 1;
      for (;;) {
        const close = pattern.indexOf("'", j);
        if (close === -1) throw new Error('reference decoder: unterminated quoted span');
        out += pattern.slice(j, close);
        if (pattern.charAt(close + 1) === "'") {
          out += "'";
          j = close + 2;
          continue;
        }
        i = close + 1;
        break;
      }
      continue;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) throw new Error('reference decoder: unbalanced brace');
      out += hole(pattern.slice(i + 1, close).trim());
      i = close + 1;
      continue;
    }
    if (ch === '#' && inPluralBranch) throw new Error('reference decoder: unquoted # in a branch');
    out += ch;
    i += 1;
  }
  return out;
}

/** Splits an emitted `{<name>, plural, <cat> {<body>} …}` argument into cat → RAW body (quote-
 *  aware, so a quoted `'}'` inside a body never ends it). Returns the categories in emitted order. */
function splitPluralBranches(
  icu: string,
  name: string,
): { cats: string[]; bodies: Record<string, string> } {
  const prefix = `{${name}, plural,`;
  const start = icu.indexOf(prefix);
  if (start === -1) throw new Error(`no plural argument for '${name}' in: ${icu}`);
  let i = start + prefix.length;
  const cats: string[] = [];
  const bodies: Record<string, string> = {};
  for (;;) {
    while (i < icu.length && isWhitespace(icu.charAt(i))) i += 1;
    if (icu.charAt(i) === '}') break;
    let cat = '';
    while (i < icu.length && icu.charAt(i) !== '{' && !isWhitespace(icu.charAt(i))) {
      cat += icu.charAt(i);
      i += 1;
    }
    while (i < icu.length && isWhitespace(icu.charAt(i))) i += 1;
    if (icu.charAt(i) !== '{') throw new Error(`expected { after category '${cat}'`);
    const bodyStart = i + 1;
    let depth = 1;
    let j = bodyStart;
    while (j < icu.length && depth > 0) {
      const ch = icu.charAt(j);
      if (ch === "'") {
        const next = icu.charAt(j + 1);
        if (next === "'") {
          j += 2;
          continue;
        }
        if (next === '{' || next === '}' || next === '#') {
          let k = j + 1;
          for (;;) {
            const close = icu.indexOf("'", k);
            if (close === -1) throw new Error('unterminated quoted span in branch');
            if (icu.charAt(close + 1) === "'") {
              k = close + 2;
              continue;
            }
            j = close + 1;
            break;
          }
          continue;
        }
        j += 1;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      if (depth > 0) j += 1;
    }
    cats.push(cat);
    bodies[cat] = icu.slice(bodyStart, j);
    i = j + 1;
  }
  return { cats, bodies };
}

// ---------------------------------------------------------------------------
// I18N-30 scanner (RT-12).
// ---------------------------------------------------------------------------

const REGEXP_IDENT = spliced('Reg', 'Exp');
const RAW_NEEDLES: readonly string[] = [
  spliced('new Reg', 'Exp('),
  spliced('.te', 'st('),
  spliced('.ex', 'ec('),
];
const MASKED_NEEDLES: readonly string[] = [
  spliced('Func', 'tion('),
  spliced('ev', 'al('),
  spliced('imp', 'ort('),
  spliced('requ', 'ire('),
  spliced('getBuiltin', 'Module'),
  spliced('global', 'This'),
  spliced('.ma', 'tch('),
  spliced('.match', 'All('),
  spliced('.sea', 'rch('),
];
/** A `/` (not `//`) whose previous non-whitespace char is one of these, or whose preceding word
 *  is one of the keywords below, can only start a regex LITERAL — never a division (B2a). */
const REGEX_PRECEDING_CHARS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_PRECEDING_WORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'do',
  'else',
  'throw',
  'await',
  'void',
]);

/** RegExp-free regex-literal detector over the MASKED source (string payloads blanked, so a `/`
 *  inside a string never counts; a `#!` first line is skipped). Returns the candidate offsets. */
function findRegexLiteralStarts(masked: string): number[] {
  const hits: number[] = [];
  let start = 0;
  if (startsWith(masked, '#!')) {
    const nl = masked.indexOf('\n');
    start = nl === -1 ? masked.length : nl + 1;
  }
  for (let i = start; i < masked.length; i++) {
    if (masked.charAt(i) !== '/' || masked.charAt(i + 1) === '/') continue;
    let p = i - 1;
    while (p >= start && isWhitespace(masked.charAt(p))) p -= 1;
    if (p < start) {
      hits.push(i);
      continue;
    }
    const prev = masked.charAt(p);
    if (REGEX_PRECEDING_CHARS.indexOf(prev) !== -1) {
      hits.push(i);
      continue;
    }
    if (isIdentChar(prev)) {
      let w = p;
      while (w >= start && isIdentChar(masked.charAt(w))) w -= 1;
      if (REGEX_PRECEDING_WORDS.has(masked.slice(w + 1, p + 1))) hits.push(i);
    }
  }
  return hits;
}
const STRING_ARG_METHODS: readonly string[] = ['.replace(', '.replaceAll(', '.split('];
const ALLOWED_IMPORT_SPECIFIERS: ReadonlySet<string> = new Set([
  'node:fs',
  'node:path',
  'node:url',
  'node:process',
  './catalog-export.mjs',
]);

/** Findings over ONE script's RAW source: raw pins for the blind-proof needles, comment-stripped +
 *  literal-masked pins for the identifier/method needles, and the "string-arg methods must be
 *  followed by a quote" rule on the stripped-but-unmasked text. */
function scanForRegexUse(raw: string): string[] {
  const findings: string[] = [];
  for (const needle of RAW_NEEDLES) {
    const n = countOccurrences(raw, needle);
    if (n > 0) findings.push(`raw '${needle}' x${n}`);
  }
  const stripped = stripComments(raw);
  const { masked, finalState } = maskWithState(stripped);
  if (finalState !== 'code') {
    findings.push(
      `literal mask ends in state '${finalState}' — a dangling quote (a regex literal carrying a quote desyncs the mask)`,
    );
  }
  const regexStarts = findRegexLiteralStarts(masked);
  if (regexStarts.length > 0)
    findings.push(`regex literal candidate(s) at ${regexStarts.join(',')}`);
  const identCount = countWordBoundaryOccurrences(masked, REGEXP_IDENT);
  if (identCount > 0) findings.push(`identifier ${REGEXP_IDENT} x${identCount}`);
  for (const needle of MASKED_NEEDLES) {
    const n = countWordBoundaryOccurrences(masked, needle);
    if (n > 0) findings.push(`masked '${needle}' x${n}`);
  }
  for (const method of STRING_ARG_METHODS) {
    let from = 0;
    for (;;) {
      const at = stripped.indexOf(method, from);
      if (at === -1) break;
      from = at + method.length;
      let j = from;
      while (j < stripped.length && isWhitespace(stripped.charAt(j))) j += 1;
      const ch = stripped.charAt(j);
      if (ch !== "'" && ch !== '"' && ch !== '`') {
        findings.push(`${method} at ${at} not followed by a string literal`);
      }
    }
  }
  return findings;
}

/** Every module specifier reached through a word-boundary `from` or a bare `import '<spec>'` in
 *  CODE state of the comment-stripped source (M1): the keyword is located in the literal-MASKED
 *  text (same length as the stripped text, string payloads blanked — so an emitter's own
 *  `"import type { Catalog } from './messageIds';"` string is never scanned) and the quoted
 *  specifier is then read from the stripped text at that offset. Catches `import … from`,
 *  `export { x } from`, `export * from`, and side-effect imports alike. */
function collectImportSpecifiers(stripped: string): string[] {
  const { masked } = maskWithState(stripped);
  const out: string[] = [];
  const readQuoted = (k: number): string | undefined => {
    let j = k;
    while (j < stripped.length && isWhitespace(stripped.charAt(j))) j += 1;
    const quote = stripped.charAt(j);
    if (quote !== "'" && quote !== '"') return undefined;
    const close = stripped.indexOf(quote, j + 1);
    return close === -1 ? undefined : stripped.slice(j + 1, close);
  };
  for (const keyword of ['from', 'import']) {
    let i = 0;
    for (;;) {
      const at = masked.indexOf(keyword, i);
      if (at === -1) break;
      i = at + keyword.length;
      const before = at > 0 ? masked.charAt(at - 1) : '';
      if (isIdentChar(before) || isIdentChar(masked.charAt(i))) continue;
      const spec = readQuoted(i);
      if (spec !== undefined) out.push(spec);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RT-04/05 machinery: derived biome config, the emitted-file round trip, dynamic import.
// ---------------------------------------------------------------------------

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `m24s8-${label}-`));
  cleanupDirs.push(dir);
  return dir;
}

/** The REAL project formatter settings (biome.json `formatter` + `javascript`), re-homed into
 *  the scratch dir so the real biome binary formats files that live outside the project root. */
function derivedBiomeConfig(): string {
  const project = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'biome.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return `${JSON.stringify(
    { formatter: project.formatter, javascript: project.javascript, linter: { enabled: false } },
    null,
    2,
  )}\n`;
}

function biomeFormat(dir: string, fileName: string): void {
  expect(
    existsSync(BIOME_BIN),
    `${BIOME_BIN} must exist — the I18N-29 property runs the REAL formatter and must FAIL, never skip, without it`,
  ).toBe(true);
  writeFileSync(path.join(dir, 'biome.json'), derivedBiomeConfig(), 'utf8');
  const run = spawnSync(BIOME_BIN, ['format', '--write', fileName], {
    cwd: dir,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  expect(run.status, `biome format --write ${fileName} must exit 0: ${output}`).toBe(0);
  expect(
    output.indexOf('1 file') !== -1,
    `biome must report having processed the one file (proves it ran): ${output}`,
  ).toBe(true);
}

/** Rewrites the emitted file's two relative specifiers to ABSOLUTE extension-less paths so the
 *  copy can be imported from anywhere (indexOf/slice via split/join — no RegExp). */
function rewriteSpecifiers(ts: string): string {
  return ts
    .split("from './messageIds';")
    .join(`from ${JSON.stringify(path.join(I18N_DIR, 'messageIds'))};`)
    .split("from './plural';")
    .join(`from ${JSON.stringify(path.join(I18N_DIR, 'plural'))};`);
}

async function importEmitted(
  tag: string,
  importableText: string,
  tmpDir: string,
): Promise<Record<string, unknown>> {
  const primary = path.join(tmpDir, `catalog.${tag}.runtime.ts`);
  writeFileSync(primary, importableText, 'utf8');
  const errors: string[] = [];
  for (const spec of [primary, pathToFileURL(primary).href]) {
    try {
      return (await import(/* @vite-ignore */ spec)) as Record<string, unknown>;
    } catch (e) {
      errors.push(`${spec}: ${String(e)}`);
    }
  }
  // Fallback (A10): vitest refused a .ts outside the project root — use the gitignored
  // client/test-results/m24-s8-<pid>/ (test-results/ is in the repo .gitignore), removed in afterAll.
  const fallbackDir = path.join(CLIENT_DIR, 'test-results', `m24-s8-${process.pid}`);
  mkdirSync(fallbackDir, { recursive: true });
  cleanupDirs.push(fallbackDir);
  const fallback = path.join(fallbackDir, `catalog.${tag}.runtime.ts`);
  writeFileSync(fallback, importableText, 'utf8');
  try {
    return (await import(/* @vite-ignore */ fallback)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `dynamic import of the emitted catalog failed everywhere:\n${errors.join('\n')}\n${fallback}: ${String(e)}`,
    );
  }
}

/** The §3b comparable projection of an Entry: plural forms restricted to the locale's LIVE
 *  categories (a dead category is authored `tour` in catalog.fr.ts but re-emitted as the `other`
 *  form — by design, ADR-0264 D7 — so only the reachable forms are part of the identity). */
function entrySummary(e: Entry, live: readonly string[]): Record<string, unknown> {
  const plurals: Record<string, Record<string, string>> = {};
  for (const name of Object.keys(e.plurals)) {
    const projected: Record<string, string> = {};
    for (const cat of live) projected[cat] = e.plurals[name][cat];
    plurals[name] = projected;
  }
  return {
    key: e.key,
    kind: e.kind,
    text: e.text,
    params: [...e.params].sort(),
    plurals,
    description: e.description,
    translated: e.translated,
  };
}

/** §3b + A2 + A10: J1 = export(parse(live)); T = biome(emit(import(J1))); J2 = export(parse(T));
 *  J1 === J2, model equality, and runtime truth via dynamic import against the live catalog. */
async function assertRoundTripIdentity(tag: string): Promise<void> {
  const original = exportTag(tag);
  const j1 = original.text;
  expect(j1, 'exportLocale().text must be JSON.stringify(json, null, 2) + newline').toBe(
    `${JSON.stringify(original.json, null, 2)}\n`,
  );
  // m9: the JSON envelope and the message order are the catalog's.
  expect(
    {
      locale: original.json.locale,
      sourceLocale: original.json.sourceLocale,
      generatedBy: original.json.generatedBy,
      keys: Object.keys(original.json.messages),
    },
    `${tag}: JSON envelope (locale/sourceLocale/generatedBy) and message key order`,
  ).toEqual({
    locale: tag,
    sourceLocale: 'en',
    generatedBy: 'scripts/catalog-export.mjs',
    keys: liveModel(tag).entries.map((e) => e.key),
  });
  const model = validate(JSON.parse(j1), { tag, enModel: liveModel('en') });
  const emitted = emitTs(tag, model);
  const dir = scratchDir(`rt-${tag}`);
  const fileName = `catalog.${tag}.ts`;
  writeFileSync(path.join(dir, fileName), emitted, 'utf8');
  biomeFormat(dir, fileName);
  const formatted = readFileSync(path.join(dir, fileName), 'utf8');

  // M4: `i18nDir` must be honoured — an exportLocale that always reads the live dir would make
  // J1 === J2 below a tautology.
  expect(
    () => exportTag(tag, { i18nDir: path.join(dir, 'absent') }),
    `${tag}: exportLocale must read catalog.${tag}.ts from the GIVEN i18nDir (an absent dir throws)`,
  ).toThrow();
  const j2 = exportTag(tag, { i18nDir: dir }).text;
  expect(
    j2,
    `${tag}: J2 = export(parse(biome(emit(import(J1))))) must be BYTE-IDENTICAL to J1 — kills a ` +
      'non-deterministic key order, a lossy description join, dead-category leakage, and a quote ' +
      'flip or biome re-wrap that the parser cannot read back',
  ).toBe(j1);

  const live = liveCats(tag);
  const before = liveModel(tag).entries.map((e) => entrySummary(e, live));
  const after = parseCatalog(formatted, { tag, file: fileName }).entries.map((e) =>
    entrySummary(e, live),
  );
  expect(
    after,
    `${tag}: parse(T) must equal parse(original) on key order, kind, text, param set, LIVE plural forms, description, translated`,
  ).toEqual(before);

  const runtime = await importEmitted(tag, rewriteSpecifiers(formatted), dir);
  const exportName = `CATALOG_${tag.toUpperCase()}`;
  const emittedCatalog = runtime[exportName] as Record<string, unknown> | undefined;
  expect(emittedCatalog, `${tag}: the emitted module must export ${exportName}`).toBeDefined();
  const cat = emittedCatalog as Record<string, unknown>;
  const liveCatalog = CATALOGS[tag] as unknown as Record<string, unknown>;
  expect(Object.isFrozen(cat), `${tag}: the emitted catalog must be Object.freeze()d`).toBe(true);
  expect(Object.keys(cat), `${tag}: emitted key ORDER must equal the live catalog's`).toEqual(
    Object.keys(liveCatalog),
  );
  const mismatches: string[] = [];
  let compared = 0;
  for (const key of Object.keys(liveCatalog)) {
    const liveValue = liveCatalog[key];
    const emittedValue = cat[key];
    if (typeof liveValue === 'function') {
      if (typeof emittedValue !== 'function') {
        mismatches.push(`${key}: live is a closure, emitted is ${typeof emittedValue}`);
        continue;
      }
      for (const sample of samplesFor(key)) {
        const a = (liveValue as (p: unknown) => string)(sample);
        const b = (emittedValue as (p: unknown) => string)(sample);
        compared += 1;
        if (a !== b)
          mismatches.push(
            `${key}(${JSON.stringify(sample)}): ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
          );
      }
    } else {
      compared += 1;
      if (emittedValue !== liveValue)
        mismatches.push(`${key}: ${JSON.stringify(liveValue)} vs ${JSON.stringify(emittedValue)}`);
    }
  }
  expect(
    mismatches,
    `${tag}: RUNTIME truth — every plain value === and every closure output === the live catalog's ` +
      '(kills an emitter whose TS parses back the same but evaluates differently: wrong escape, ' +
      'wrong selectPlural wiring, dead-category fill on a live category)',
  ).toEqual([]);
  expect(
    compared,
    `${tag}: anti-vacuity — exactly 114 runtime comparisons (77 plain + 34 closures × 1 + 1 plural closure × 3)`,
  ).toBe(114);
}

// ---------------------------------------------------------------------------
// Helpers for the importer fixtures: an fr ICU JSON document with overrides.
// ---------------------------------------------------------------------------

function frJson(mutate?: (json: IcuJson) => void): IcuJson {
  const json = structuredClone(exportTag('fr').json);
  if (mutate) mutate(json);
  return json;
}

function setMessage(json: IcuJson, key: string, message: string): void {
  json.messages[key].message = message;
}

function runNode(
  args: readonly string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [...args], {
    cwd,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

function lineStartingWith(lines: readonly string[], prefix: string): string | undefined {
  return lines.find((l) => startsWith(l, prefix));
}

/** The text of ONE top-level function in comment-stripped script source: from its `header`
 *  (e.g. `export function importLocale(`) to the first column-0 `}` after it. Used for the
 *  RegExp-free ORDERING pins that stand in for mutants no accepted input can reach. */
function functionBody(stripped: string, header: string): string {
  const start = stripped.indexOf(header);
  expect(start, `script must define ${header}`).not.toBe(-1);
  expect(stripped.indexOf(header, start + 1), `script must define ${header} exactly once`).toBe(-1);
  const end = stripped.indexOf('\n}', start);
  expect(end, `${header} body must close at a column-0 brace`).not.toBe(-1);
  return stripped.slice(start, end);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('catalogRoundTrip (M24 S8, ADR-0264)', { sequential: true }, () => {
  it('m24s8 RT-01: parser over the live catalogs — 112 entries, order, closures, plurals, verbatim descriptions, runtime truth', () => {
    expect(
      discover(),
      'discoverLocales() must equal Object.keys(CATALOGS) sorted — kills a hard-coded [en] or a scan that picks up *.test.ts',
    ).toEqual(Object.keys(CATALOGS).sort());
    expect(liveCats('en'), 'liveCategories(en) must be the canonical-order live set').toEqual([
      'one',
      'other',
    ]);
    expect(
      liveCats('fr'),
      'liveCategories(fr) must be canonical zero,one,two,few,many,other order filtered (kills a sorted or Intl-order emission)',
    ).toEqual(['one', 'many', 'other']);

    const en = liveModel('en');
    const fr = liveModel('fr');
    expect(en.tag, 'parseCatalogSource must echo the tag').toBe('en');
    expect(en.entries.length, 'en must parse exactly 112 entries').toBe(112);
    expect(fr.entries.length, 'fr must parse exactly 112 entries').toBe(112);
    expect(
      fr.entries.map((e) => e.key),
      'fr key ORDER must equal en key order (a set-based parser loses catalog order)',
    ).toEqual(en.entries.map((e) => e.key));
    expect(
      en.entries.map((e) => e.key),
      'parsed en key order must be the runtime CATALOG_EN key order',
    ).toEqual(Object.keys(CATALOG_EN));
    expect(en.entries.filter((e) => e.kind === 'closure').length, 'en closures').toBe(35);
    expect(fr.entries.filter((e) => e.kind === 'closure').length, 'fr closures').toBe(35);

    const enPlurals = en.entries.filter((e) => Object.keys(e.plurals).length > 0).map((e) => e.key);
    expect(enPlurals, 'en has ZERO plural entries').toEqual([]);
    const frPlurals = fr.entries.filter((e) => Object.keys(e.plurals).length > 0);
    expect(
      frPlurals.map((e) => ({ key: e.key, plurals: e.plurals })),
      "fr's only plural is battle.weather.banner on `turns` with the SIX hoisted cldr forms resolved (kills a parser that never resolves the hoisted const)",
    ).toEqual([{ key: 'battle.weather.banner', plurals: { turns: SIX_FR_FORMS } }]);
    const banner = frPlurals[0];
    expect(
      banner.params,
      'battle.weather.banner params in FIRST-APPEARANCE order, `turns` once despite two holes (kills first-hole-only and duplicate-collecting parsers)',
    ).toEqual(['label', 'turns']);
    expect(banner.text, 'the fr plural hole is the CONTRACT token, const name dropped').toBe(
      `${hole('label')} (${hole('turns')} ${pluralHole('turns')})`,
    );
    expect(
      liveCats('fr').map((c) => banner.plurals.turns[c]),
      'the live projection of the fr forms',
    ).toEqual(['tour', 'de tours', 'tours']);

    const paramMismatch: string[] = [];
    for (let i = 0; i < en.entries.length; i++) {
      const a = [...en.entries[i].params].sort().join(',');
      const b = [...fr.entries[i].params].sort().join(',');
      if (a !== b || en.entries[i].kind !== fr.entries[i].kind) {
        paramMismatch.push(`${en.entries[i].key}: en(${a}) fr(${b})`);
      }
    }
    expect(paramMismatch, 'per-key kind + param SET must agree between en and fr').toEqual([]);
    expect(
      en.entries.find((e) => e.key === 'battle.card.hpLine')?.params,
      'battle.card.hpLine params stay in hole order current,max,affinity (kills a sorting parser)',
    ).toEqual(['current', 'max', 'affinity']);

    // B1: the sum of description LINES equals the count of indented `//` lines in the file —
    // every block line is a description line (kills a parser that keeps only the first N lines).
    for (const [tag, model, measured] of [
      ['en', en, 355],
      ['fr', fr, 360],
    ] as const) {
      const descLines = model.entries.reduce((n, e) => n + e.description.split('\n').length, 0);
      expect(
        descLines,
        `every indented // line of catalog.${tag}.ts is a description line — kills a parser that keeps only the first N block lines`,
      ).toBe(countOccurrences(liveSource(tag), '\n  //'));
      expect(descLines, `catalog.${tag}.ts description-line census measured today`).toBe(measured);
    }

    // M3: the exported JSON is exactly one message object per entry, in entry order, with the
    // four CONTRACT fields and the entry's params list (kills a stowaway field or a re-sort).
    expect(
      Object.entries(exportTag('fr').json.messages).map(([k, m]) => [k, Object.keys(m), m.params]),
      'exportLocale(fr).json.messages: [key, field roster, params] per entry in catalog order',
    ).toEqual(
      fr.entries.map((e) => [e.key, ['message', 'description', 'params', 'translated'], e.params]),
    );

    // m6: discoverLocales over scratch dirs — an unsupported tag throws, `*.test.ts` is skipped.
    const dirWith = (...names: string[]): string => {
      const dir = scratchDir('rt01-discover');
      for (const name of names) writeFileSync(path.join(dir, name), '', 'utf8');
      return dir;
    };
    expectCode(
      () => discover(dirWith('catalog.xx.ts')),
      'LOCALE-UNSUPPORTED',
      'discoverLocales must reject a catalog.xx.ts whose tag Intl has no plural data for',
    );
    expect(
      discover(dirWith('catalog.de.ts', 'catalog.de.test.ts', 'resolver.ts')),
      'discoverLocales lists catalog.<tag>.ts only — never *.test.ts, never other files',
    ).toEqual(['de']);

    const closureKeys = en.entries
      .filter((e) => e.kind === 'closure')
      .map((e) => e.key)
      .sort();
    expect(
      Array.from(messageParams().keys()).sort(),
      'the MessageParams rows parsed from messageIds.ts must be exactly the 35 closure keys (anti-vacuity for the sample builder)',
    ).toEqual(closureKeys);

    const helpHint = en.entries.find((e) => e.key === 'chrome.helpHint');
    expect(
      helpHint?.description,
      'A5: description is the comment block VERBATIM, newline-joined, citation line included (kills a space-join, a citation heuristic, and a trim-happy reader)',
    ).toBe(
      'Menu-launcher button pinned to the bottom-left of the world view, telling the player\n' +
        'how to open help and the menu. One line, at most 47 characters (fits a 320px-wide viewport).\n' +
        'index.html:143',
    );
    const shortDesc = [...en.entries, ...fr.entries]
      .filter((e) => nonWhitespaceCount(e.description.split('\n')[0]) < 10)
      .map((e) => e.key);
    expect(shortDesc, 'every description first line has >=10 non-whitespace chars').toEqual([]);
    expect(
      [...en.entries, ...fr.entries].filter((e) => !e.translated).map((e) => e.key),
      'no live entry carries a @translated: false marker today',
    ).toEqual([]);

    // Runtime truth (A10): the parsed model, rendered by THIS file, equals the real catalog.
    const drift: string[] = [];
    let rendered = 0;
    for (const [tag, model, live] of [
      ['en', en, CATALOG_EN as unknown as Record<string, unknown>],
      ['fr', fr, CATALOG_FR as unknown as Record<string, unknown>],
    ] as const) {
      for (const entry of model.entries) {
        const value = live[entry.key];
        if (entry.kind === 'plain') {
          rendered += 1;
          if (entry.text !== value)
            drift.push(
              `${tag} ${entry.key}: ${JSON.stringify(entry.text)} vs ${JSON.stringify(value)}`,
            );
          continue;
        }
        for (const sample of samplesFor(entry.key)) {
          rendered += 1;
          const expected = (value as (p: unknown) => string)(sample);
          const actual = renderEntry(entry, tag, sample);
          if (actual !== expected)
            drift.push(
              `${tag} ${entry.key}(${JSON.stringify(sample)}): ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`,
            );
        }
      }
    }
    expect(
      drift,
      'every parsed plain text === the catalog value and every closure text with holes substituted === the closure output (kills a lossy escape decoder, a hole parser that drops a param, wrong plural resolution)',
    ).toEqual([]);
    expect(
      rendered,
      'anti-vacuity: exactly 228 renderings — 2 locales × (77 plain + 34 closures × 1 sample + 1 plural closure × 3 samples)',
    ).toBe(228);

    const enBuy = en.entries.find((e) => e.key === 'shop.buy.row');
    expect(
      endsWith(enBuy?.text ?? '', ' '),
      'shop.buy.row text must END with a space (trailing-space-trimming parser)',
    ).toBe(true);
    const enRow = en.entries.find((e) => e.key === 'leaderboard.row');
    expect(startsWith(enRow?.text ?? '', ' — '), "leaderboard.row text must START with ' — '").toBe(
      true,
    );
    const frDisconnected = fr.entries.find((e) => e.key === 'chrome.status.disconnected');
    expect(
      (frDisconnected?.text ?? '').indexOf(String.fromCharCode(0xa0)) !== -1,
      'fr chrome.status.disconnected must keep its U+00A0 (a whitespace-normalising parser loses it)',
    ).toBe(true);
    const fallback = en.entries.find((e) => e.key === 'evolutionNotice.species.fallback');
    expect(fallback?.text, 'a top-level literal # survives parsing').toBe(`Species #${hole('id')}`);
  });

  it('m24s8 RT-02: parser fixtures — block/desc/marker/quotes/escapes/wrapping/trailing-comment/trailing-comma/PARSE cases', () => {
    const fr = (hoisted: readonly string[], lines: readonly string[]): Model =>
      parseCatalog(catalogSource('fr', hoisted, lines), { tag: 'fr', file: 'fixture.ts' });
    const one = (hoisted: readonly string[], lines: readonly string[]): Entry => {
      const m = fr(hoisted, lines);
      expect(m.entries.length, 'fixture precondition: exactly one entry').toBe(1);
      return m.entries[0];
    };
    const parseFails = (
      lines: readonly string[],
      why: string,
      hoisted: readonly string[] = [],
    ): Error => expectCode(() => fr(hoisted, lines), 'PARSE', why);

    // (a) A5 verbatim description: citation line and a following line are KEPT, newline-joined,
    // leading `// ` stripped, nothing else trimmed; the marker line is first.
    const verbatim = one(
      [],
      [
        '  // @desc: First line of the note.',
        '  // index.html:143',
        '  //   indented continuation kept verbatim',
        '  // kept trailing space ',
        '  //',
        "  'a.b': 'v',",
      ],
    );
    expect(
      verbatim.description,
      '(a) description must be the block verbatim (newline join, `// ` stripped, no citation heuristic, no re-trim: a trailing space and a bare `//` line survive — the IMPORTER, not this parser, rejects trailing whitespace)',
    ).toBe(
      'First line of the note.\nindex.html:143\n  indented continuation kept verbatim\nkept trailing space \n',
    );

    // (b) `// @translated: false` read, and excluded from the description.
    const flagged = one([], [`  // @desc: ${DESC}`, '  // @translated: false', "  'a.b': 'v',"]);
    expect(
      { translated: flagged.translated, description: flagged.description },
      '(b) the marker sets translated=false and is NOT part of the description',
    ).toEqual({ translated: false, description: DESC });

    // (c) `// @translated: true` is accepted (= true); (d) any other value is PARSE.
    const explicitTrue = one(
      [],
      [`  // @desc: ${DESC}`, '  // @translated: true', "  'a.b': 'v',"],
    );
    expect(explicitTrue.translated, '(c) @translated: true reads as true').toBe(true);
    parseFails(
      [`  // @desc: ${DESC}`, '  // @translated: yes', "  'a.b': 'v',"],
      '(d) @translated: yes',
    );

    // (e) closure wrapping after `=>` (biome shape) and (f) a plain value on the line after `:`.
    const wrapped = one(
      [],
      [`  // @desc: ${DESC}`, "  'a.b': (p) =>", `    \`Lv${hole('level')} · ${hole('trust')}\`,`],
    );
    expect(
      { kind: wrapped.kind, text: wrapped.text, params: wrapped.params },
      '(e) a closure whose template starts on the NEXT line must parse (kills an entry-line-only value reader)',
    ).toEqual({
      kind: 'closure',
      text: `Lv${hole('level')} · ${hole('trust')}`,
      params: ['level', 'trust'],
    });
    const nextLine = one([], [`  // @desc: ${DESC}`, "  'a.b':", "    'value on the next line',"]);
    expect(nextLine.text, '(f) a plain value on the line after the colon').toBe(
      'value on the next line',
    );
    // (f2) leading + trailing spaces inside a PLAIN value are payload — kills a `.trim()` on the
    // decoded plain text (the closure path is covered by the live shop.buy.row / leaderboard.row
    // pins in RT-01; this is the plain-string twin).
    const padded = one([], [`  // @desc: ${DESC}`, "  'a.b': ' padded ',"]);
    expect(padded.text, '(f2) a padded plain value keeps both spaces').toBe(' padded ');

    // (g) hoisted six-form cldr const resolves; ws-tolerant selectPlural hole.
    const hoistedForms = [
      'const FORMS = cldr({',
      "  zero: 'z',",
      "  one: 'o',",
      "  two: 't',",
      "  few: 'f',",
      "  many: 'm',",
      "  other: 'x',",
      '});',
    ];
    const plural = one(hoistedForms, [
      `  // @desc: ${DESC}`,
      `  'a.b': (p) => \`${hole('n')} ${DOLLAR_BRACE} selectPlural( 'fr' , p.n , FORMS ) }\`,`,
    ]);
    expect(
      { text: plural.text, params: plural.params, plurals: plural.plurals },
      '(g) a whitespace-padded selectPlural hole resolves the hoisted const into six forms (kills a fixed-spacing hole matcher)',
    ).toEqual({
      text: `${hole('n')} ${pluralHole('n')}`,
      params: ['n'],
      plurals: { n: { zero: 'z', one: 'o', two: 't', few: 'f', many: 'm', other: 'x' } },
    });

    // (h) tag mismatch, (i) unresolved const, (j) two plurals on one param, (k) oneOther (A8).
    parseFails(
      [`  // @desc: ${DESC}`, `  'a.b': (p) => \`${selectHole('en', 'n', 'FORMS')}\`,`],
      '(h) selectPlural tag != file tag',
      hoistedForms,
    );
    parseFails(
      [`  // @desc: ${DESC}`, `  'a.b': (p) => \`${selectHole('fr', 'n', 'NOPE')}\`,`],
      '(i) unresolved forms const',
      hoistedForms,
    );
    parseFails(
      [
        `  // @desc: ${DESC}`,
        `  'a.b': (p) => \`${selectHole('fr', 'n', 'FORMS')} ${selectHole('fr', 'n', 'FORMS')}\`,`,
      ],
      '(j) two plural holes on one param',
      hoistedForms,
    );
    parseFails(
      [`  // @desc: ${DESC}`, `  'a.b': (p) => \`${selectHole('fr', 'n', 'F')}\`,`],
      '(k) an oneOther hoisted const is no longer parseable (A8) — a hole naming it cannot resolve',
      ["const F = oneOther('a', 'b');"],
    );
    parseFails(
      [`  // @desc: ${DESC}`, `  'a.b': (p) => \`${selectHole('fr', 'n', 'F')}\`,`],
      '(k2) any other shape after `= cldr(` is unparseable — a hole naming it cannot resolve',
      ['const F = cldr(FOO);'],
    );

    // (l) unsupported holes, (m) backtick inside a hole.
    parseFails(
      [`  // @desc: ${DESC}`, "  'a.b': (p) => `$" + '{foo}`,'],
      '(l) a bare-identifier hole (not p.<name>)',
    );
    parseFails(
      [`  // @desc: ${DESC}`, "  'a.b': (p) => `$" + '{p.x.y}`,'],
      '(l2) a nested-member hole p.x.y',
    );
    parseFails(
      [`  // @desc: ${DESC}`, "  'a.b': (p) => `$" + '{`x`}`,'],
      '(m) a backtick inside a hole (nested template)',
    );
    parseFails(
      [`  // @desc: ${DESC}`, "  'a.b': (p) => `\\$" + '{p.x}`,'],
      '(m2) a decoded literal dollar-brace (escaped in the source) — the CONTRACT hole model has no room for it',
    );

    // (n) no @desc, (o) two @desc, (p) blank line between block and entry, (q) marker not first.
    parseFails(['  // just a note without the marker', "  'a.b': 'v',"], '(n) no @desc line');
    parseFails(
      [`  // @desc: ${DESC}`, `  // @desc: ${DESC}`, "  'a.b': 'v',"],
      '(o) two @desc lines',
    );
    parseFails(
      [`  // @desc: ${DESC}`, '', "  'a.b': 'v',"],
      '(p) a blank line breaks adjacency — the entry has no block (SHAPE-01)',
    );
    parseFails(
      ['  // index.html:143', `  // @desc: ${DESC}`, "  'a.b': 'v',"],
      '(q) A5: the FIRST block line must be the @desc marker',
    );

    // (r) duplicate key, (s) trailing comment on an entry line, (t) unsupported value shapes.
    parseFails([...plainEntry('a.b', "'v'"), ...plainEntry('a.b', "'w'")], '(r) duplicate key');
    parseFails(
      [`  // @desc: ${DESC}`, "  'a.b': 'v', // trailing"],
      '(s) a trailing comment on an entry line',
    );
    parseFails([`  // @desc: ${DESC}`, "  'a.b': someIdent,"], '(t) an identifier value');
    parseFails([`  // @desc: ${DESC}`, "  'a.b': 'a' + 'b',"], '(t2) a concatenation value');
    parseFails([`  // @desc: ${DESC}`, "  'a.b': (x) => `v`,"], '(t3) a closure not named p');

    // (u) GOOD: `"it's"` double-quoted plain value (A2 — biome flips the quote).
    const dq = one([], [`  // @desc: ${DESC}`, "  'a.b': \"it's\","]);
    expect(dq.text, "(u) a double-quoted plain value decodes (biome's quote flip must parse)").toBe(
      "it's",
    );

    // (v) escapes decode: sq `\'` `\\` `\n`; template `` \` `` `\\` `\$`.
    const sqEsc = one([], [`  // @desc: ${DESC}`, "  'a.b': 'a\\'b\\\\c\\nd',"]);
    expect(sqEsc.text, "(v) single-quoted escapes \\' \\\\ \\n decode").toBe("a'b\\c\nd");
    const tlEsc = one([], [`  // @desc: ${DESC}`, "  'a.b': (p) => `a\\`b\\\\c\\$d`,"]);
    expect(tlEsc.text, '(v2) template escapes \\` \\\\ \\$ decode').toBe('a`b\\c$d');
    parseFails([`  // @desc: ${DESC}`, "  'a.b': 'a\\qb',"], '(v3) an unsupported escape');

    // (w) trailing comma after the last entry optional (rev-m8); (x) structural anchors missing.
    const noComma = fr([], [`  // @desc: ${DESC}`, "  'a.b': 'v'"]);
    expect(
      noComma.entries.map((e) => e.text),
      '(w) no trailing comma after the last entry',
    ).toEqual(['v']);
    expectCode(
      () =>
        parseCatalog(
          catalogSource('fr', [], plainEntry('a.b', "'v'")).split('Object.freeze({').join('{'),
          { tag: 'fr', file: 'f.ts' },
        ),
      'PARSE',
      '(x) missing `Object.freeze({`',
    );
    expectCode(
      () =>
        parseCatalog(
          catalogSource('fr', [], plainEntry('a.b', "'v'"))
            .split('} satisfies Catalog);')
            .join('});'),
          { tag: 'fr', file: 'f.ts' },
        ),
      'PARSE',
      '(x2) missing `satisfies Catalog`',
    );

    // (y) PARSE detail carries <file>:<line> (A7): the bad hole is on line 5 of this source.
    const err = parseFails(
      [`  // @desc: ${DESC}`, "  'a.b': (p) => `$" + '{foo}`,'],
      '(y) file:line in the PARSE detail',
    );
    expect(
      err.message.indexOf('fixture.ts:5:') !== -1,
      `(y) PARSE message must name fixture.ts:5: — got ${err.message}`,
    ).toBe(true);
  });

  it('m24s8 RT-03: ICU emission — A1 quoting, live-only categories in canonical order, top-level # untouched, reference decoder', () => {
    const en = liveCats('en');
    const frLive = liveCats('fr');
    const plain = (text: string): string => toIcu(mkEntry({ key: 'x.y', text }), en);
    const closure = (
      text: string,
      params: string[],
      plurals: Record<string, PluralForms> = {},
      live = en,
    ): string => toIcu(mkEntry({ key: 'x.y', kind: 'closure', text, params, plurals }), live);

    // Byte pins (one per fixture) — the A1 canonical forms.
    expect(plain("it's"), "an apostrophe not adjacent to a special is doubled: it''s").toBe(
      "it''s",
    );
    expect(plain('{}'), "a run of specials is ONE span: '{}'").toBe("'{}'");
    expect(plain("{'}"), "an apostrophe inside a run is doubled inside the span: '{''}'").toBe(
      "'{''}'",
    );
    expect(plain('x}{y'), "x}{y -> x'}{'y (kills per-char quoting '}''{')").toBe("x'}{'y");
    expect(plain('{x}'), "a literal {x} in a PLAIN value is quoted, not a hole: '{'x'}'").toBe(
      "'{'x'}'",
    );
    expect(
      closure(`l'${hole('x')}`, ['x']),
      "l'{x} hole: apostrophe doubled, hole kept: l''{x}",
    ).toBe("l''{x}");
    expect(closure(`Species #${hole('id')}`, ['id']), 'a TOP-LEVEL # is never quoted').toBe(
      'Species #{id}',
    );
    expect(closure(`${hole('b')} ${hole('a')}`, ['b', 'a']), 'hole order preserved').toBe(
      '{b} {a}',
    );
    expect(
      closure(
        `${hole('label')} (${hole('turns')} ${pluralHole('turns')})`,
        ['label', 'turns'],
        { turns: SIX_FR_FORMS },
        frLive,
      ),
      'a six-form fr plural emits ONLY one/many/other, canonical order (kills all-six emission and dead-category leakage)',
    ).toBe('{label} ({turns} {turns, plural, one {tour} many {de tours} other {tours}})');
    expect(
      closure(pluralHole('n'), ['n'], { n: sixForms('#1', '#n') }),
      "# INSIDE a branch is quoted: '#'",
    ).toBe("{n, plural, one {'#'1} other {'#'n}}");
    expect(
      closure(pluralHole('n'), ['n'], { n: sixForms("l'objet", "l'objets") }),
      'an apostrophe inside a branch is doubled',
    ).toBe("{n, plural, one {l''objet} other {l''objets}}");

    // Reference-decoder self-checks (ICU4J DOUBLE_OPTIONAL) — the oracle must itself be right.
    expect(decodeIcuPattern("it''s", false), "decoder: '' is one apostrophe").toBe("it's");
    expect(
      decodeIcuPattern("'{''}'", false),
      "decoder: '' inside a span is a literal apostrophe and the span stays open",
    ).toBe("{'}");
    expect(decodeIcuPattern("'#'x", true), 'decoder: # is a syntax char inside a branch').toBe(
      '#x',
    );
    expect(
      decodeIcuPattern("'#'x", false),
      'decoder: # is NOT syntax at top level, so both apostrophes are literal',
    ).toBe("'#'x");
    expect(
      decodeIcuPattern("a'b {x}", false),
      'decoder: lone apostrophe literal, simple arg -> hole token',
    ).toBe(`a'b ${hole('x')}`);
    expect(() => decodeIcuPattern("'{x", false), 'decoder: an unterminated span throws').toThrow();

    // Decoder-oracle fixtures: decode(toIcu(text)) === text, on inputs distinct from the pins.
    const decodeMismatch: string[] = [];
    const roundTripTexts = [
      "don't {stop} 'now'",
      "a'{b",
      "{'",
      "'{'x'}'",
      'plain text · no specials',
    ];
    for (const text of roundTripTexts) {
      const decoded = decodeIcuPattern(plain(text), false);
      if (decoded !== text)
        decodeMismatch.push(
          `${JSON.stringify(text)} -> ${JSON.stringify(plain(text))} -> ${JSON.stringify(decoded)}`,
        );
    }
    expect(
      decodeMismatch,
      'every plain text must survive emit -> reference decode (kills an emitter whose quoting ICU4J reads differently)',
    ).toEqual([]);
    const closureText = `'${hole('a')}' #{ ${hole('b')}`;
    expect(
      decodeIcuPattern(closure(closureText, ['a', 'b']), false),
      'a closure with apostrophes around holes, a top-level # and a literal brace decodes back (holes as tokens)',
    ).toBe(closureText);

    // Plural branches through the decoder: each emitted branch body decodes to its form and the
    // category roster is exactly the live set in canonical order.
    const trickyForms = sixForms("l'{#}", '#s', 'de #');
    const pluralIcu = closure(`${hole('n')} ${pluralHole('n')}`, ['n'], { n: trickyForms }, frLive);
    const { cats, bodies } = splitPluralBranches(pluralIcu, 'n');
    const decodedBranches: Record<string, string> = {};
    for (const cat of cats) decodedBranches[cat] = decodeIcuPattern(bodies[cat], true);
    expect(
      { cats, decodedBranches },
      'branch bodies with # { } and apostrophes decode to the authored forms; categories = live fr set in canonical order',
    ).toEqual({
      cats: ['one', 'many', 'other'],
      decodedBranches: { one: "l'{#}", many: 'de #', other: '#s' },
    });
  });

  it(
    'm24s8 RT-04: I18N-29 en identity — J1 === J2 through the real biome, model equality, dynamic-import runtime truth',
    async () => {
      await assertRoundTripIdentity('en');
    },
    LONG_TEST_MS,
  );

  it(
    'm24s8 RT-05: I18N-29 fr identity — J1 === J2 through the real biome, model equality, dynamic-import runtime truth (plural, NBSP, quote flip)',
    async () => {
      await assertRoundTripIdentity('fr');
    },
    LONG_TEST_MS,
  );

  it('m24s8 RT-06: emitted TS shape pins (en + fr, unformatted) — imports, satisfies, freeze, forms const, header, SHAPE-01 re-parse', () => {
    const enModel = liveModel('en');
    const emittedEn = emitTs('en', validate(exportTag('en').json, { tag: 'en', enModel }));
    const emittedFr = emitTs('fr', validate(exportTag('fr').json, { tag: 'fr', enModel }));
    const strippedEn = stripComments(emittedEn);
    const strippedFr = stripComments(emittedFr);

    for (const [tag, raw, stripped] of [
      ['en', emittedEn, strippedEn],
      ['fr', emittedFr, strippedFr],
    ] as const) {
      const upper = tag.toUpperCase();
      expect(
        countOccurrences(stripped, "import type { Catalog } from './messageIds';"),
        `${tag}: exactly one Catalog type import`,
      ).toBe(1);
      expect(
        countOccurrences(stripped, 'satisfies Catalog'),
        `${tag}: exactly one satisfies Catalog (kills an emitter that forgets the excess-property check)`,
      ).toBe(1);
      expect(
        countOccurrences(stripped, 'Object.freeze('),
        `${tag}: exactly one Object.freeze(`,
      ).toBe(1);
      expect(
        countOccurrences(stripped, `export const CATALOG_${upper}: Catalog = Object.freeze({`),
        `${tag}: the export declaration line`,
      ).toBe(1);
      expect(
        countWordBoundaryOccurrences(stripped, 'oneOther'),
        `${tag}: the oneOther identifier must never appear in emitted code`,
      ).toBe(0);
      expect(
        raw.indexOf('oneOther(') === -1,
        `${tag}: the raw oneOther( token must be absent even from comments (catalog.test.ts scans raw)`,
      ).toBe(true);
      expect(countOccurrences(stripped, '(p) =>'), `${tag}: 35 closures`).toBe(35);
      expect(countOccurrences(raw, '// @desc: '), `${tag}: one @desc marker per entry`).toBe(112);
      expect(
        countOccurrences(raw, '@translated:'),
        `${tag}: no marker when every entry is translated (never write true)`,
      ).toBe(0);
      const firstLine = raw.split('\n')[0];
      expect(
        startsWith(firstLine, `// ui/i18n/catalog.${tag}.ts`),
        `${tag}: header line 1 names the file`,
      ).toBe(true);
      expect(
        firstLine.indexOf('generated by scripts/catalog-import.mjs') !== -1,
        `${tag}: header names the generator`,
      ).toBe(true);
      const importAt = raw.indexOf('\nimport type { Catalog }');
      expect(importAt, `${tag}: the Catalog type import follows the header`).toBeGreaterThan(0);
      const header = raw.slice(0, importAt);
      expect(
        header.indexOf('{') === -1 &&
          header.indexOf('}') === -1 &&
          header.indexOf('@desc:') === -1 &&
          header.indexOf('oneOther') === -1,
        `${tag}: header carries no braces, no @desc: decoy and no oneOther token (SHAPE-01 / catalog.test.ts raw scan / just-recipe safety)`,
      ).toBe(true);
      const reparsed = parseCatalog(raw, { tag, file: `catalog.${tag}.ts` });
      expect(reparsed.entries.length, `${tag}: the exporter parser reads 112 entries back`).toBe(
        112,
      );
      expect(
        reparsed.entries
          .filter((e) => nonWhitespaceCount(e.description.split('\n')[0]) < 10)
          .map((e) => e.key),
        `${tag}: every re-parsed description first line >=10 non-ws (SHAPE-01 stays green post-import)`,
      ).toEqual([]);
    }

    expect(
      countOccurrences(strippedFr, "import { cldr, selectPlural } from './plural';"),
      'fr imports cldr + selectPlural exactly once',
    ).toBe(1);
    expect(
      countOccurrences(strippedEn, "from './plural'"),
      'en (no plural) must NOT import ./plural (noUnusedLocals would red it)',
    ).toBe(0);
    expect(
      countOccurrences(strippedFr, 'const BATTLE_WEATHER_BANNER_TURNS_FORMS = cldr({'),
      'fr declares the <KEY>_<PARAM>_FORMS const once via cldr(',
    ).toBe(1);
    const formsStart = strippedFr.indexOf('const BATTLE_WEATHER_BANNER_TURNS_FORMS = cldr({');
    const formsBlock = strippedFr.slice(formsStart, strippedFr.indexOf('});', formsStart));
    expect(
      ['zero', 'one', 'two', 'few', 'many', 'other'].map((c) => {
        const at = formsBlock.indexOf(`  ${c}: `);
        return at === -1 ? `${c}: MISSING` : formsBlock.slice(at, formsBlock.indexOf(',', at) + 1);
      }),
      'six UNQUOTED keys, one per line, dead categories (zero/two/few) = the other form (kills quoted keys — SHAPE-01 would count them as entries — and a one-fill of dead categories)',
    ).toEqual([
      "  zero: 'tours',",
      "  one: 'tour',",
      "  two: 'tours',",
      "  few: 'tours',",
      "  many: 'de tours',",
      "  other: 'tours',",
    ]);
    expect(formsBlock.indexOf("'zero'") === -1, "no quoted 'zero' key").toBe(true);
    expect(
      countOccurrences(strippedFr, selectHole('fr', 'turns', 'BATTLE_WEATHER_BANNER_TURNS_FORMS')),
      'the fr plural hole is re-emitted as selectPlural over the named const',
    ).toBe(1);
  });

  it('m24s8 RT-08: importer rejections — one fixture per A7 code, asserted by err.code', () => {
    const enModel = liveModel('en');
    const frTag = { tag: 'fr', enModel };
    const rejects = (
      why: string,
      code: string,
      mutate: (json: IcuJson) => void,
      opts: { tag: string; enModel: Model } = frTag,
    ): Error => expectCode(() => validate(frJson(mutate), opts), code, why);

    // GOOD: the untouched fr export validates to 112 entries in en order (a reject-everything
    // importer would pass every rejection below).
    const good = validate(frJson(), frTag);
    expect(
      good.entries.map((e) => e.key),
      'the live fr export validates; entries in en order',
    ).toEqual(enModel.entries.map((e) => e.key));

    rejects('LOCALE-MISMATCH: json.locale de under tag fr', 'LOCALE-MISMATCH', (j) => {
      j.locale = 'de';
    });
    rejects(
      'LOCALE-UNSUPPORTED: tag xx',
      'LOCALE-UNSUPPORTED',
      (j) => {
        j.locale = 'xx';
      },
      { tag: 'xx', enModel },
    );
    const dir = scratchDir('rt08');
    const outPath = path.join(dir, 'catalog.en.ts');
    expectCode(
      () => importTag('en', exportTag('en').text, { enModel, outPath }),
      'LOCALE-IS-SOURCE',
      'LOCALE-IS-SOURCE: importLocale refuses the source locale',
    );
    expect(
      existsSync(outPath) || existsSync(`${outPath}.tmp`),
      'LOCALE-IS-SOURCE must fire BEFORE any write',
    ).toBe(false);

    const unknownKey = rejects('KEY-SET-MISMATCH: an extra key', 'KEY-SET-MISMATCH', (j) => {
      j.messages['zz.extra'] = { message: 'x', description: DESC, params: [], translated: true };
    });
    expect(
      unknownKey.message.indexOf('zz.extra') !== -1,
      'KEY-SET-MISMATCH names the unknown key',
    ).toBe(true);
    rejects('KEY-SET-MISMATCH: a missing key', 'KEY-SET-MISMATCH', (j) => {
      delete j.messages['battle.title'];
    });
    rejects('TRANSLATED-NOT-BOOLEAN: "yes"', 'TRANSLATED-NOT-BOOLEAN', (j) => {
      (j.messages['battle.title'] as unknown as { translated: unknown }).translated = 'yes';
    });
    rejects('TRANSLATED-NOT-BOOLEAN: absent', 'TRANSLATED-NOT-BOOLEAN', (j) => {
      delete (j.messages['battle.title'] as unknown as { translated?: boolean }).translated;
    });
    rejects('DESC-INVALID: not a string', 'DESC-INVALID', (j) => {
      (j.messages['battle.title'] as unknown as { description: unknown }).description = 42;
    });
    rejects('DESC-INVALID: first line < 10 non-ws chars', 'DESC-INVALID', (j) => {
      j.messages['battle.title'].description =
        'short\nbut this second line is long enough to fool a whole-text count';
    });
    rejects('DESC-INVALID: a line starting with @ (marker injection)', 'DESC-INVALID', (j) => {
      j.messages['battle.title'].description = `${DESC}\n@translated: false`;
    });
    rejects(
      'DESC-INVALID: a line ending in whitespace (biome trims comment trailing whitespace, so it could never round-trip)',
      'DESC-INVALID',
      (j) => {
        j.messages['battle.title'].description = `${DESC}\nsecond line with a trailing space `;
      },
    );
    rejects('PARAMS-MISMATCH: message drops {level}', 'PARAMS-MISMATCH', (j) =>
      setMessage(j, 'battle.card.level', 'Niv.'),
    );
    rejects('PARAMS-MISMATCH: message adds {foo} to a plain key', 'PARAMS-MISMATCH', (j) =>
      setMessage(j, 'battle.title', 'Combat {foo}'),
    );
    rejects(
      'PARAMS-MISMATCH: json params lists foo absent from the message and the roster',
      'PARAMS-MISMATCH',
      (j) => {
        j.messages['battle.title'].params = ['foo'];
      },
    );
    rejects('ICU-SYNTAX: unterminated quoted span', 'ICU-SYNTAX', (j) =>
      setMessage(j, 'battle.title', "Combat '{x"),
    );
    rejects('ICU-SYNTAX: unbalanced brace', 'ICU-SYNTAX', (j) =>
      setMessage(j, 'battle.card.level', 'Niv.{level'),
    );
    rejects('ICU-SYNTAX: bad arg name', 'ICU-SYNTAX', (j) =>
      setMessage(j, 'battle.card.level', 'Niv.{le-vel}'),
    );
    const bannerBase = '{label} ({turns} {turns, plural, ';
    rejects('ICU-UNSUPPORTED: select', 'ICU-UNSUPPORTED', (j) =>
      setMessage(
        j,
        'battle.weather.banner',
        '{label} ({turns} {turns, select, one {a} other {b}})',
      ),
    );
    rejects('ICU-UNSUPPORTED: selectordinal', 'ICU-UNSUPPORTED', (j) =>
      setMessage(
        j,
        'battle.weather.banner',
        '{label} ({turns} {turns, selectordinal, one {a} many {b} other {c}})',
      ),
    );
    rejects('ICU-UNSUPPORTED: =1 exact selector', 'ICU-UNSUPPORTED', (j) =>
      setMessage(j, 'battle.weather.banner', `${bannerBase}=1 {a} one {b} many {c} other {d}})`),
    );
    rejects('ICU-UNSUPPORTED: offset:1', 'ICU-UNSUPPORTED', (j) =>
      setMessage(j, 'battle.weather.banner', `${bannerBase}offset:1 one {a} many {b} other {c}})`),
    );
    rejects('ICU-UNSUPPORTED: nesting (unquoted { inside a branch)', 'ICU-UNSUPPORTED', (j) =>
      setMessage(j, 'battle.weather.banner', `${bannerBase}one {{label}} many {b} other {c}})`),
    );
    rejects('ICU-UNSUPPORTED: a second plural on the same arg', 'ICU-UNSUPPORTED', (j) =>
      setMessage(
        j,
        'battle.weather.banner',
        `{label} {turns, plural, one {a} many {b} other {c}} {turns, plural, one {a} many {b} other {c}}`,
      ),
    );
    rejects('ICU-UNSUPPORTED: a plural on an arg not in the roster', 'ICU-UNSUPPORTED', (j) =>
      setMessage(
        j,
        'battle.weather.banner',
        '{label} {turns} {foo, plural, one {a} many {b} other {c}}',
      ),
    );
    rejects('ICU-UNSUPPORTED: another argument type ({turns, number})', 'ICU-UNSUPPORTED', (j) =>
      setMessage(j, 'battle.weather.banner', '{label} ({turns, number})'),
    );
    rejects('ICU-UNSUPPORTED: a literal dollar-brace in the message text', 'ICU-UNSUPPORTED', (j) =>
      setMessage(j, 'battle.card.level', 'Niv.{level} $' + '{level}'),
    );
    rejects('PLURAL-CATEGORIES: fr with one+other only (many missing)', 'PLURAL-CATEGORIES', (j) =>
      setMessage(j, 'battle.weather.banner', `${bannerBase}one {a} other {b}})`),
    );
    rejects('PLURAL-CATEGORIES: fr with a dead category (few)', 'PLURAL-CATEGORIES', (j) =>
      setMessage(j, 'battle.weather.banner', `${bannerBase}one {a} few {x} many {b} other {c}})`),
    );
    const reordered = validate(
      frJson((j) =>
        setMessage(j, 'battle.weather.banner', `${bannerBase}other {c} one {a} many {b}})`),
      ),
      frTag,
    );
    expect(
      reordered.entries.find((e) => e.key === 'battle.weather.banner')?.plurals,
      'GOOD: PLURAL-CATEGORIES is ORDER-INSENSITIVE, and validateImport fills dead categories with the other form',
    ).toEqual({ turns: { zero: 'c', one: 'a', two: 'c', few: 'c', many: 'b', other: 'c' } });
    rejects('ICU-HASH: an unquoted # inside a branch', 'ICU-HASH', (j) =>
      setMessage(j, 'battle.weather.banner', `${bannerBase}one {# a} many {b} other {c}})`),
    );
    rejects('MSG-EMPTY: empty message', 'MSG-EMPTY', (j) => setMessage(j, 'battle.title', ''));
    rejects('MSG-EMPTY: empty branch', 'MSG-EMPTY', (j) =>
      setMessage(j, 'battle.weather.banner', `${bannerBase}one {} many {b} other {c}})`),
    );
    rejects('CONTROL-CHAR: U+0007 in a message', 'CONTROL-CHAR', (j) =>
      setMessage(j, 'battle.title', `Com${String.fromCharCode(7)}bat`),
    );
    rejects('CONTROL-CHAR: U+2028 in a branch', 'CONTROL-CHAR', (j) =>
      setMessage(
        j,
        'battle.weather.banner',
        `${bannerBase}one {a} many {b${String.fromCharCode(0x2028)}} other {c}})`,
      ),
    );
    // U+2029 (PARAGRAPH SEPARATOR) is legal inside an ES string literal but TERMINATES a `//`
    // comment — in a description it is marker injection, in a message it is a line break the
    // catalog cannot hold. Kills a checker that only knows U+2028 (or only `< 0x20`).
    rejects('CONTROL-CHAR: U+2029 in a description', 'CONTROL-CHAR', (j) => {
      j.messages['battle.title'].description = `ten chars ${String.fromCharCode(0x2029)}here x`;
    });
    rejects('CONTROL-CHAR: U+2029 in a message', 'CONTROL-CHAR', (j) =>
      setMessage(j, 'battle.title', `Com${String.fromCharCode(0x2029)}bat`),
    );

    // (k) EMIT-MISMATCH is unreachable through any input the validator accepts (every accepted
    // description line and value quoting round-trips by construction), so the tooth is a
    // RegExp-free ORDERING pin on the importer's own `importLocale` body: the self-re-parse and
    // the EMIT-MISMATCH check come BEFORE `writeFileSync(`, and `renameSync(` comes after it.
    // Kills "skip the self-re-parse / write before the check".
    const importerStripped = stripComments(readFileSync(IMPORT_SCRIPT, 'utf8'));
    const importLocaleBody = functionBody(importerStripped, 'export function importLocale(');
    const reparseAt = importLocaleBody.indexOf('parseCatalogSource(');
    const mismatchAt = importLocaleBody.indexOf("'EMIT-MISMATCH'");
    const writeAt = importLocaleBody.indexOf('writeFileSync(');
    const renameAt = importLocaleBody.indexOf('renameSync(');
    expect(
      {
        reparseFound: reparseAt !== -1,
        mismatchFound: mismatchAt !== -1,
        writeFound: writeAt !== -1,
        renameFound: renameAt !== -1,
        reparseBeforeMismatch: reparseAt < mismatchAt,
        mismatchBeforeWrite: mismatchAt < writeAt,
        writeBeforeRename: writeAt < renameAt,
        writeCount: countOccurrences(importLocaleBody, 'writeFileSync('),
      },
      'importLocale body order: parseCatalogSource( < EMIT-MISMATCH < writeFileSync( (exactly one) < renameSync( — kills "skip the self-re-parse" and "write before the check" mutants',
    ).toEqual({
      reparseFound: true,
      mismatchFound: true,
      writeFound: true,
      renameFound: true,
      reparseBeforeMismatch: true,
      mismatchBeforeWrite: true,
      writeBeforeRename: true,
      writeCount: 1,
    });

    // FORMS-NAME-COLLISION needs two keys whose <KEY_UPPER>_<PARAM_UPPER>_FORMS collide — impossible
    // with the live roster, so a synthetic en model: `a.b` param `c_n` and `a.b.c` param `n` both
    // become A_B_C_N_FORMS.
    const syntheticEn = parseCatalog(
      catalogSource(
        'en',
        [],
        [
          `  // @desc: ${DESC}`,
          `  'a.b': (p) => \`${hole('c_n')}\`,`,
          `  // @desc: ${DESC}`,
          `  'a.b.c': (p) => \`${hole('n')}\`,`,
        ],
      ),
      { tag: 'en', file: 'synthetic.ts' },
    );
    const collision = {
      locale: 'de',
      sourceLocale: 'en',
      generatedBy: 'scripts/catalog-export.mjs',
      messages: {
        'a.b': {
          message: '{c_n, plural, one {x} other {y}}',
          description: DESC,
          params: ['c_n'],
          translated: true,
        },
        'a.b.c': {
          message: '{n, plural, one {x} other {y}}',
          description: DESC,
          params: ['n'],
          translated: true,
        },
      },
    };
    expectCode(
      () => validate(collision, { tag: 'de', enModel: syntheticEn }),
      'FORMS-NAME-COLLISION',
      'FORMS-NAME-COLLISION: A_B_C_N_FORMS twice',
    );
  });

  it('m24s8 RT-09: quoting through the importer — decoded text via the reference decoder, emitted quote choice, byte-exact re-export', () => {
    const enModel = liveModel('en');
    const frLive = liveCats('fr');

    // Direct parseIcuMessage pins (whitespace-free ICU must parse — A7).
    expect(
      parseIcu("it''s '{'x'}'", { liveCategories: frLive, roster: [] }),
      'parseIcuMessage decodes DOUBLE_OPTIONAL quoting into plain text',
    ).toEqual({ text: "it's {x}", params: [], plurals: {} });
    expect(
      parseIcu('{n,plural,one{a}other{b}}', { liveCategories: ['one', 'other'], roster: ['n'] }),
      'whitespace-free plural ICU parses into the hole model + live-keyed branch texts',
    ).toEqual({ text: pluralHole('n'), params: ['n'], plurals: { n: { one: 'a', other: 'b' } } });
    expect(
      parseIcu('{ x }', { liveCategories: frLive, roster: ['x'] }),
      'a padded simple arg',
    ).toEqual({
      text: hole('x'),
      params: ['x'],
      plurals: {},
    });

    // Through the importer: each fixture = (key, ICU message, expected emitted TS value line).
    const fixtures: ReadonlyArray<{ key: string; icu: string; emittedLine: string }> = [
      { key: 'battle.title', icu: "it''s", emittedLine: `  'battle.title': "it's",` },
      { key: 'battle.card.you', icu: "'{'x'}'", emittedLine: `  'battle.card.you': '{x}',` },
      {
        key: 'battle.card.opponent',
        icu: "'{''}'",
        emittedLine: `  'battle.card.opponent': "{'}",`,
      },
      {
        key: 'battle.weather.banner',
        icu: "{label} ({turns} {turns, plural, one {'#' tour} many {l''an} other {tours}})",
        emittedLine: '  many: "l\'an",',
      },
      // m3: both quote kinds -> single quotes with an escaped apostrophe; a backslash is escaped
      // in the TS; a backtick inside a closure template is escaped.
      {
        key: 'battle.outcome.victory',
        icu: 'it\'\'s "q"',
        emittedLine: "  'battle.outcome.victory': 'it\\'s \"q\"',",
      },
      {
        key: 'battle.outcome.defeat',
        icu: 'a\\b',
        emittedLine: "  'battle.outcome.defeat': 'a\\\\b',",
      },
      {
        key: 'battle.card.level',
        icu: 'a`b {level}',
        emittedLine: `  'battle.card.level': (p) => \`a\\\`b ${hole('level')}\`,`,
      },
    ];
    const findings: string[] = [];
    for (const f of fixtures) {
      const json = frJson((j) => setMessage(j, f.key, f.icu));
      const emitted = emitTs('fr', validate(json, { tag: 'fr', enModel }));
      if (emitted.indexOf(f.emittedLine) === -1)
        findings.push(`${f.key}: emitted TS lacks ${JSON.stringify(f.emittedLine)}`);
      const entry = parseCatalog(emitted, { tag: 'fr', file: 'catalog.fr.ts' }).entries.find(
        (e) => e.key === f.key,
      );
      if (entry === undefined) {
        findings.push(`${f.key}: not re-parsed`);
        continue;
      }
      if (f.key === 'battle.weather.banner') {
        const branches = splitPluralBranches(f.icu, 'turns');
        for (const cat of branches.cats) {
          const expected = decodeIcuPattern(branches.bodies[cat], true);
          if (entry.plurals.turns[cat] !== expected)
            findings.push(
              `${f.key} ${cat}: ${JSON.stringify(entry.plurals.turns[cat])} vs decoder ${JSON.stringify(expected)}`,
            );
        }
      } else {
        const expected = decodeIcuPattern(f.icu, false);
        if (entry.text !== expected)
          findings.push(
            `${f.key}: text ${JSON.stringify(entry.text)} vs decoder ${JSON.stringify(expected)}`,
          );
      }
      const reExported = toIcu(entry, frLive);
      if (reExported !== f.icu)
        findings.push(
          `${f.key}: re-export ${JSON.stringify(reExported)} !== input ${JSON.stringify(f.icu)}`,
        );
    }
    expect(
      findings,
      "each quoted ICU message must (1) emit the A2 quote choice, (2) re-parse to the reference decoder's text, (3) re-export byte-identically (kills an un-quoter that leaves '' in place, a one-quote-style emitter, an emitter that escapes the wrong quote)",
    ).toEqual([]);
  });

  it('m24s8 RT-10: the translated marker — written last, once, read back, re-exported, counted', () => {
    const enModel = liveModel('en');
    const json = frJson((j) => {
      // A: French text replaced by the ENGLISH text but translated stays TRUE — a string-
      // inequality heuristic would flip it to false.
      setMessage(j, 'battle.title', 'Battle');
      // B: French text kept, translated FALSE — the marker is what the JSON says, not a diff.
      j.messages['battle.card.you'].translated = false;
    });
    const emitted = emitTs('fr', validate(json, { tag: 'fr', enModel }));
    expect(countOccurrences(emitted, '@translated: false'), 'exactly one marker in the file').toBe(
      1,
    );
    expect(
      emitted.indexOf('@translated: true') === -1,
      '`@translated: true` is never written',
    ).toBe(true);
    const lines = emitted.split('\n');
    const markerIdx = lines.indexOf('  // @translated: false');
    expect(markerIdx, 'the marker is its own `  // @translated: false` line').toBeGreaterThan(-1);
    expect(
      startsWith(lines[markerIdx + 1], "  'battle.card.you':"),
      'the marker is the LAST block line, immediately above its entry (kills writing it as a note above the desc, or above the wrong key)',
    ).toBe(true);
    const reparsed = parseCatalog(emitted, { tag: 'fr', file: 'catalog.fr.ts' });
    const flags = reparsed.entries.filter((e) => !e.translated).map((e) => e.key);
    expect(
      flags,
      'parse(emitted) flags exactly the JSON-flagged key — battle.title (en-equal text) stays true',
    ).toEqual(['battle.card.you']);
    const reExported = reparsed.entries
      .map((e) => ({ key: e.key, translated: e.translated }))
      .filter((e) => e.key === 'battle.title' || e.key === 'battle.card.you');
    expect(reExported, 'the re-exported flags follow the marker, not a string diff').toEqual([
      { key: 'battle.title', translated: true },
      { key: 'battle.card.you', translated: false },
    ]);
    expect(completionOf([reparsed]), 'computeCompletion counts the one marker as gap 1').toEqual({
      fr: { total: 112, translated: 111, gap: 1 },
    });
  });

  it('m24s8 RT-11: completion — live census, A4 gap-only OK/REGRESSION/STALE classification, exact report lines', () => {
    const live = completionOf(discover().map((tag) => liveModel(tag)));
    expect(Object.keys(live), 'completion covers exactly the registered tags, sorted').toEqual(
      Object.keys(CATALOGS).sort(),
    );
    expect(live, 'both live locales are fully translated today').toEqual({
      en: { total: 112, translated: 112, gap: 0 },
      fr: { total: 112, translated: 112, gap: 0 },
    });

    const base: Completion = {
      en: { total: 112, translated: 112, gap: 0 },
      fr: { total: 112, translated: 112, gap: 0 },
    };
    const equal = checkBaseline(base, base);
    expect(
      { exitCode: equal.exitCode, lines: equal.lines },
      'equal live/baseline -> every tag OK, exit 0, one line per tag + a summary',
    ).toEqual({
      exitCode: 0,
      lines: [
        'i18n-completion: en total=112 translated=112 gap=0 OK',
        'i18n-completion: fr total=112 translated=112 gap=0 OK',
        'i18n-completion: 2 locale(s) checked, 0 not OK',
      ],
    });

    const grew = checkBaseline({ ...base, fr: { total: 112, translated: 111, gap: 1 } }, base);
    expect(
      {
        exitCode: grew.exitCode,
        fr: lineStartingWith(grew.lines, 'i18n-completion: fr'),
        summary: grew.lines[grew.lines.length - 1],
      },
      'gap grew -> REGRESSION, exit 1, the exact report line',
    ).toEqual({
      exitCode: 1,
      fr: 'i18n-completion: fr total=112 translated=111 gap=1 REGRESSION gap 0 -> 1',
      summary: 'i18n-completion: 2 locale(s) checked, 1 not OK',
    });

    const vanished = checkBaseline({ en: base.en }, base);
    expect(
      { exitCode: vanished.exitCode, fr: lineStartingWith(vanished.lines, 'i18n-completion: fr') },
      'a baseline tag missing live -> REGRESSION, exact line (kills missing-locale = OK)',
    ).toEqual({
      exitCode: 1,
      fr: 'i18n-completion: fr total=- translated=- gap=- REGRESSION missing live (baseline gap 0)',
    });

    const totalShrank = checkBaseline(
      { ...base, fr: { total: 100, translated: 100, gap: 0 } },
      base,
    );
    expect(
      totalShrank.exitCode,
      'A4: total/translated are informational — a shrunk total with an equal gap is OK, exit 0 (kills a total-comparing ratchet)',
    ).toBe(0);

    const shrank = checkBaseline(base, { ...base, fr: { total: 112, translated: 107, gap: 5 } });
    expect(
      { exitCode: shrank.exitCode, fr: lineStartingWith(shrank.lines, 'i18n-completion: fr') },
      'gap shrank -> STALE and exit 1, exact line (kills exit 0 on STALE)',
    ).toEqual({
      exitCode: 1,
      fr: 'i18n-completion: fr total=112 translated=112 gap=0 STALE gap 5 -> 0',
    });

    const newTag = checkBaseline({ ...base, de: { total: 112, translated: 0, gap: 112 } }, base);
    expect(
      { exitCode: newTag.exitCode, de: lineStartingWith(newTag.lines, 'i18n-completion: de') },
      'a live tag absent from the baseline -> STALE, exit 1, exact line',
    ).toEqual({
      exitCode: 1,
      de: 'i18n-completion: de total=112 translated=0 gap=112 STALE not in baseline',
    });
  });

  it('m24s8 RT-12: I18N-30 over BOTH scripts — text pins, import roster, size, and the behavioural no-RegExp oracle', () => {
    const exportRaw = readFileSync(EXPORT_SCRIPT, 'utf8');
    const importRaw = readFileSync(IMPORT_SCRIPT, 'utf8');

    // Scanner proof-of-teeth (one assertion per fixture).
    expect(
      scanForRegexUse("s.replace(/a/g, '')").length,
      'a regex-literal .replace( must be a finding',
    ).toBeGreaterThan(0);
    expect(
      scanForRegexUse(spliced('new Reg', "Exp('x')")).length,
      'a dynamic constructor must be a finding',
    ).toBeGreaterThan(0);
    expect(
      scanForRegexUse(spliced('/x/.te', 'st(s)')).length,
      'a regex-literal method call must be a finding (raw pin, blind-proof)',
    ).toBeGreaterThan(0);
    expect(
      scanForRegexUse('s.split(sep)').length,
      'a non-literal .split( argument must be a finding',
    ).toBeGreaterThan(0);
    expect(scanForRegexUse("s.replace('a', '')"), 'a string-literal .replace( is clean').toEqual(
      [],
    );
    expect(scanForRegexUse("s.split('\\n')"), 'a string-literal .split( is clean').toEqual([]);
    expect(
      scanForRegexUse(spliced("const s = 'Reg", "Exp in a string';")),
      'the identifier inside a string literal is masked, not a finding',
    ).toEqual([]);
    expect(
      scanForRegexUse(spliced('// never use Reg', 'Exp here\nconst a = 1;')),
      'the identifier inside a comment is stripped, not a finding',
    ).toEqual([]);
    // B2a regex-literal detector teeth: a literal after `=`, a literal carrying a quote (which
    // also desyncs the mask — M2), and a plain division chain that must stay clean.
    expect(
      scanForRegexUse('x = /a/g;').length,
      'a regex literal after `=` must be a finding (no method call, no identifier)',
    ).toBeGreaterThan(0);
    expect(
      scanForRegexUse("const APOS = /'/;").length,
      'a regex literal carrying a quote must be a finding (literal start + dangling mask state)',
    ).toBeGreaterThan(0);
    expect(scanForRegexUse('x = a / b / c;'), 'a division chain is clean').toEqual([]);
    // M1 import-roster teeth: `export … from` and a side-effect import are collected, a string
    // payload spelling an import line is not.
    expect(
      collectImportSpecifiers(
        "export { x } from './y.mjs';\nexport * from 'node:os';\nimport 'node:child_process';\n" +
          `const s = ${JSON.stringify("import type { Catalog } from './messageIds';")};\n`,
      ),
      'every code-state `from`/bare import is collected; the string payload is not',
    ).toEqual(['./y.mjs', 'node:os', 'node:child_process']);

    expect(scanForRegexUse(exportRaw), 'catalog-export.mjs findings').toEqual([]);
    expect(scanForRegexUse(importRaw), 'catalog-import.mjs findings').toEqual([]);
    expect(
      exportRaw.split('\n').length,
      'catalog-export.mjs >= 150 lines (proves the scan read a real script)',
    ).toBeGreaterThanOrEqual(150);
    expect(importRaw.split('\n').length, 'catalog-import.mjs >= 150 lines').toBeGreaterThanOrEqual(
      150,
    );

    for (const [name, raw] of [
      ['catalog-export.mjs', exportRaw],
      ['catalog-import.mjs', importRaw],
    ] as const) {
      const specs = collectImportSpecifiers(stripComments(raw));
      expect(
        specs.length,
        `${name}: >=2 static imports (anti-vacuity for the roster scan)`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        specs.filter((s) => !ALLOWED_IMPORT_SPECIFIERS.has(s)),
        `${name}: every import specifier must be in the allowed roster (node:fs, node:path, node:url, node:process, ./catalog-export.mjs)`,
      ).toEqual([]);
    }
    expect(
      collectImportSpecifiers(stripComments(importRaw)),
      'the importer imports its parser from ./catalog-export.mjs (no third script)',
    ).toContain('./catalog-export.mjs');

    // Behavioural oracle (A11): every String.prototype method that would construct or consume a
    // RegExp, AND every RegExp.prototype entry point (reached through the spliced identifier via
    // globalThis — the token never appears verbatim in this file), throws while the whole pipeline
    // runs: parse, export, import, importLocale's write path, completion, and the rejections.
    const proto = String.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const regexProto = (
      globalThis as unknown as Record<string, { prototype: Record<PropertyKey, unknown> }>
    )[REGEXP_IDENT].prototype;
    const stringArg = ['replace', 'replaceAll', 'split'];
    const always = ['match', 'matchAll', 'search'];
    const regexKeys: readonly PropertyKey[] = [
      'test',
      'exec',
      Symbol.split,
      Symbol.replace,
      Symbol.match,
      Symbol.matchAll,
      Symbol.search,
    ];
    const saved = new Map<string, (...args: unknown[]) => unknown>();
    const savedRegex = new Map<PropertyKey, unknown>();
    const bite = (method: string): never => {
      throw Object.assign(
        new Error(`I18N-30: ${method} reached with a RegExp (or a non-string pattern)`),
        { code: 'REGEXP-USED' },
      );
    };
    for (const m of stringArg) {
      const orig = proto[m];
      saved.set(m, orig);
      proto[m] = function wrapped(this: unknown, ...args: unknown[]) {
        if (typeof args[0] !== 'string') bite(`String.prototype.${m}`);
        return orig.apply(this, args);
      };
    }
    for (const m of always) {
      saved.set(m, proto[m]);
      proto[m] = () => bite(`String.prototype.${m}`);
    }
    for (const k of regexKeys) {
      savedRegex.set(k, regexProto[k]);
      regexProto[k] = () => bite(`${REGEXP_IDENT}.prototype[${String(k)}]`);
    }
    try {
      expect(
        () => 'a'.replace(1 as never, ''),
        'anti-vacuity: the wrapper must bite a non-string pattern',
      ).toThrow();
      expect(
        'a-b'.split('-'),
        'anti-vacuity: a string pattern still works under the wrapper',
      ).toEqual(['a', 'b']);
      const enModel = liveModel('en');
      const regexpUses: string[] = [];
      /** Non-rejection labels rethrow any unexpected error (a silent swallow would let a broken
       *  pipeline pass as "no RegExp"); rejection labels must throw WITH a structured code (m5). */
      const guard = (label: string, fn: () => unknown, expectsRejection = false): void => {
        let threw = false;
        try {
          fn();
        } catch (e) {
          threw = true;
          const code = (e as { code?: unknown }).code;
          if (code === 'REGEXP-USED') {
            regexpUses.push(`${label}: ${(e as Error).message}`);
          } else if (expectsRejection) {
            if (code === undefined)
              regexpUses.push(`${label}: rejected WITHOUT a code: ${String(e)}`);
          } else {
            throw e;
          }
        }
        if (expectsRejection && !threw) regexpUses.push(`${label}: did not reject`);
      };
      for (const tag of ['en', 'fr']) {
        const src = liveSource(tag);
        guard(`parse ${tag}`, () => parseCatalog(src, { tag, file: `catalog.${tag}.ts` }));
        guard(`export ${tag}`, () => exportTag(tag));
        guard(`import ${tag}`, () => {
          const model = validate(exportTag(tag).json, { tag, enModel });
          const emitted = emitTs(tag, model);
          parseCatalog(emitted, { tag, file: `catalog.${tag}.ts` });
        });
      }
      guard('importLocale fr', () =>
        importTag('fr', exportTag('fr').text, {
          enModel,
          outPath: path.join(scratchDir('rt12'), 'catalog.fr.ts'),
        }),
      );
      guard('checkCompletion', () =>
        checkBaseline(completionOf([enModel]), { en: { total: 1, translated: 1, gap: 0 } }),
      );
      guard('discoverLocales', () => discover());
      const rejections: Array<(j: IcuJson) => void> = [
        (j) => setMessage(j, 'battle.title', "Combat '{x"),
        (j) => setMessage(j, 'battle.card.level', 'Niv.{level'),
        (j) =>
          setMessage(
            j,
            'battle.weather.banner',
            '{label} ({turns} {turns, select, one {a} other {b}})',
          ),
        (j) =>
          setMessage(
            j,
            'battle.weather.banner',
            '{label} ({turns} {turns, plural, one {# a} many {b} other {c}})',
          ),
        (j) => setMessage(j, 'battle.card.level', 'Niv.{level} $' + '{level}'),
        (j) => {
          j.messages['battle.title'].description = 'short';
        },
        (j) => {
          j.locale = 'de';
        },
        (j) => setMessage(j, 'battle.title', `Com${String.fromCharCode(7)}bat`),
      ];
      for (let i = 0; i < rejections.length; i++) {
        guard(
          `rejection ${i}`,
          () => validate(frJson(rejections[i]), { tag: 'fr', enModel }),
          true,
        );
      }
      expect(
        regexpUses,
        'no String.prototype regex-capable method may receive a non-string pattern and no RegExp.prototype entry point may run anywhere in export/import/importLocale/validation',
      ).toEqual([]);
    } finally {
      for (const [m, orig] of saved) proto[m] = orig;
      for (const [k, orig] of savedRegex) regexProto[k] = orig;
    }
    expect('a'.replace('a', 'b'), 'the wrappers were restored').toBe('b');
    expect(
      regexKeys.map((k) => typeof regexProto[k]),
      'the RegExp.prototype entry points were restored',
    ).toEqual(regexKeys.map(() => 'function'));
  });

  it(
    'm24s8 RT-13: export CLI — --out, determinism, --completion writer/--check, --seed, exit codes (process.execPath)',
    () => {
      const dir = scratchDir('rt13');
      const first = runNode([EXPORT_SCRIPT, '--out', dir], dir);
      expect(first.status, `--out must exit 0: ${first.stderr}`).toBe(0);
      const enPath = path.join(dir, 'en.icu.json');
      const frPath = path.join(dir, 'fr.icu.json');
      expect(
        existsSync(enPath) && existsSync(frPath),
        'en.icu.json + fr.icu.json written for every discovered locale',
      ).toBe(true);
      const stdoutLines = first.stdout.split('\n').filter((l) => startsWith(l, 'catalog-export:'));
      expect(stdoutLines.length, 'one `catalog-export:` stdout line per locale').toBe(2);
      expect(
        startsWith(stdoutLines[0], 'catalog-export: en 112 messages -> '),
        'the en line shape',
      ).toBe(true);
      expect(
        readFileSync(frPath, 'utf8'),
        'the CLI file is exactly exportLocale(fr).text (links the CLI to the API)',
      ).toBe(exportTag('fr').text);
      const enBytes = readFileSync(enPath, 'utf8');
      const second = runNode([EXPORT_SCRIPT, '--out', dir], dir);
      expect(second.status, 'second run exits 0').toBe(0);
      expect(
        readFileSync(enPath, 'utf8'),
        'a second run is byte-identical (no timestamp, deterministic order)',
      ).toBe(enBytes);

      const baselinePath = path.join(dir, 'b.json');
      const wrote = runNode([EXPORT_SCRIPT, '--completion', '--baseline', baselinePath], dir);
      expect(wrote.status, `--completion --baseline must exit 0: ${wrote.stderr}`).toBe(0);
      expect(
        readFileSync(baselinePath, 'utf8'),
        'the written baseline is the live completion, same serialisation',
      ).toBe(`${JSON.stringify(completionOf(discover().map((t) => liveModel(t))), null, 2)}\n`);
      const check = runNode(
        [EXPORT_SCRIPT, '--completion', '--check', '--baseline', baselinePath],
        dir,
      );
      expect(check.status, 'check against the just-written baseline -> exit 0').toBe(0);
      expect(
        check.stdout
          .split('\n')
          .filter((l) => l.length > 0)
          .pop(),
        'the OK check ends with the exact summary line',
      ).toBe('i18n-completion: 2 locale(s) checked, 0 not OK');

      // M5 — the A4 WRITER refusal, reachable only through `--i18n-dir`: a scratch i18n dir whose
      // catalog.fr.ts carries one `// @translated: false` marker (live gap 1) against a baseline
      // with gap 0 must refuse to write (exit 1, REGRESSION line, file untouched); against a
      // baseline with gap 1 it writes normally.
      const i18nDir = scratchDir('rt13-i18n');
      writeFileSync(path.join(i18nDir, 'catalog.en.ts'), liveSource('en'), 'utf8');
      const frLines = liveSource('fr').split('\n');
      const youIdx = frLines.indexOf("  'battle.card.you': 'Vous',");
      expect(
        youIdx,
        "precondition: catalog.fr.ts has the 'battle.card.you' entry line",
      ).toBeGreaterThan(0);
      frLines.splice(youIdx, 0, '  // @translated: false');
      writeFileSync(path.join(i18nDir, 'catalog.fr.ts'), frLines.join('\n'), 'utf8');
      const gap0 = `${JSON.stringify({ en: { total: 112, translated: 112, gap: 0 }, fr: { total: 112, translated: 112, gap: 0 } }, null, 2)}\n`;
      const refusePath = path.join(dir, 'refuse.json');
      writeFileSync(refusePath, gap0, 'utf8');
      const refused = runNode(
        [EXPORT_SCRIPT, '--completion', '--i18n-dir', i18nDir, '--baseline', refusePath],
        dir,
      );
      expect(
        {
          status: refused.status,
          line: lineStartingWith(refused.stdout.split('\n'), 'i18n-completion: fr'),
          unchanged: readFileSync(refusePath, 'utf8') === gap0,
        },
        'the writer refuses a grown gap: exit 1, the REGRESSION line, baseline byte-unchanged',
      ).toEqual({
        status: 1,
        line: 'i18n-completion: fr total=112 translated=111 gap=1 REGRESSION gap 0 -> 1',
        unchanged: true,
      });
      const gap1 = {
        en: { total: 112, translated: 112, gap: 0 },
        fr: { total: 112, translated: 111, gap: 1 },
      };
      const acceptPath = path.join(dir, 'accept.json');
      writeFileSync(acceptPath, `${JSON.stringify(gap1, null, 2)}\n`, 'utf8');
      const accepted = runNode(
        [EXPORT_SCRIPT, '--completion', '--i18n-dir', i18nDir, '--baseline', acceptPath],
        dir,
      );
      expect(
        { status: accepted.status, written: JSON.parse(readFileSync(acceptPath, 'utf8')) },
        'an equal gap writes normally: exit 0, the file rewritten with gap 1',
      ).toEqual({ status: 0, written: gap1 });

      // M6 — the main guard: a bare `import()` of the script must run NOTHING (no stdout, no
      // build/i18n under the cwd).
      const bare = runNode(
        [
          '--input-type=module',
          '-e',
          `import(${JSON.stringify(pathToFileURL(EXPORT_SCRIPT).href)})`,
        ],
        dir,
      );
      expect(
        {
          status: bare.status,
          out: bare.stdout,
          leaked: existsSync(path.join(dir, 'build')),
        },
        'importing the exporter as a module prints nothing and writes nothing (main is guarded)',
      ).toEqual({ status: 0, out: '', leaked: false });

      const stalePath = path.join(dir, 'stale.json');
      writeFileSync(
        stalePath,
        `${JSON.stringify({ en: { total: 112, translated: 112, gap: 0 }, fr: { total: 112, translated: 107, gap: 5 } }, null, 2)}\n`,
        'utf8',
      );
      const stale = runNode(
        [EXPORT_SCRIPT, '--completion', '--check', '--baseline', stalePath],
        dir,
      );
      expect(
        { status: stale.status, stale: stale.stdout.indexOf('STALE') !== -1 },
        'a baseline with fr gap 5 against live gap 0 -> STALE, exit 1',
      ).toEqual({ status: 1, stale: true });
      const missing = runNode(
        [EXPORT_SCRIPT, '--completion', '--check', '--baseline', path.join(dir, 'nope.json')],
        dir,
      );
      expect(
        {
          status: missing.status,
          named: `${missing.stdout}${missing.stderr}`.indexOf('BASELINE-MISSING') !== -1,
        },
        'a missing baseline -> BASELINE-MISSING, exit 1',
      ).toEqual({ status: 1, named: true });

      const seed = runNode([EXPORT_SCRIPT, '--seed', 'de', '--out', dir], dir);
      expect(seed.status, `--seed de must exit 0: ${seed.stderr}`).toBe(0);
      const seeded = JSON.parse(readFileSync(path.join(dir, 'de.icu.json'), 'utf8')) as IcuJson;
      const enJson = exportTag('en').json;
      expect(
        {
          locale: seeded.locale,
          keys: Object.keys(seeded.messages),
          allFalse: Object.values(seeded.messages).every((m) => m.translated === false),
          sameMessages: Object.keys(enJson.messages).every(
            (k) => seeded.messages[k]?.message === enJson.messages[k].message,
          ),
        },
        '--seed writes the EN messages under locale=de with every translated:false (the only sanctioned producer of a false)',
      ).toEqual({
        locale: 'de',
        keys: Object.keys(enJson.messages),
        allFalse: true,
        sameMessages: true,
      });
      const seedEn = runNode([EXPORT_SCRIPT, '--seed', 'en', '--out', dir], dir);
      expect(
        { status: seedEn.status, code: seedEn.stderr.indexOf('LOCALE-IS-SOURCE') !== -1 },
        '--seed en -> LOCALE-IS-SOURCE, exit 2',
      ).toEqual({ status: 2, code: true });
      const seedXx = runNode([EXPORT_SCRIPT, '--seed', 'xx', '--out', dir], dir);
      expect(
        { status: seedXx.status, code: seedXx.stderr.indexOf('LOCALE-UNSUPPORTED') !== -1 },
        '--seed xx -> LOCALE-UNSUPPORTED, exit 2',
      ).toEqual({ status: 2, code: true });
      const bogus = runNode([EXPORT_SCRIPT, '--bogus'], dir);
      expect(bogus.status, 'an unknown flag is a usage error, exit 2').toBe(2);
    },
    LONG_TEST_MS,
  );

  it(
    'm24s8 RT-14: import CLI — success + registration banner, ICU-UNSUPPORTED exit 2 with nothing written, usage exit 2, source-locale refusal',
    () => {
      const dir = scratchDir('rt14');
      // m7: the live tree must be byte-untouched by every CLI run below (an importer that ignores
      // `--out`, or a success path that refreshes the committed baseline, would show here).
      const liveFrPath = path.join(I18N_DIR, 'catalog.fr.ts');
      const liveBaselinePath = path.join(
        PROJECT_ROOT,
        'evals',
        'baselines',
        'i18n-locale-completion.json',
      );
      const frBefore = readFileSync(liveFrPath, 'utf8');
      const baselineBefore = existsSync(liveBaselinePath)
        ? readFileSync(liveBaselinePath, 'utf8')
        : undefined;
      const frJsonPath = path.join(dir, 'fr.icu.json');
      writeFileSync(frJsonPath, exportTag('fr').text, 'utf8');
      const outPath = path.join(dir, 'x.ts');
      const ok = runNode([IMPORT_SCRIPT, 'fr', frJsonPath, '--out', outPath], dir);
      expect(ok.status, `fr import must exit 0: ${ok.stderr}`).toBe(0);
      expect(existsSync(outPath), 'the --out file is written').toBe(true);
      expect(existsSync(`${outPath}.tmp`), 'the tmp file was renamed away').toBe(false);
      expect(
        readFileSync(outPath, 'utf8'),
        'the CLI output is exactly emitCatalogTs(fr, validateImport(json)) (links the CLI to the API)',
      ).toBe(emitTs('fr', validate(exportTag('fr').json, { tag: 'fr', enModel: liveModel('en') })));
      expect(ok.stdout.indexOf(outPath) !== -1, 'success prints the out path').toBe(true);
      expect(
        ok.stdout.indexOf('PLURAL_CATEGORIES') === -1,
        'an already-registered tag prints no registration banner',
      ).toBe(true);

      const deJsonPath = path.join(dir, 'de.icu.json');
      const seed = runNode([EXPORT_SCRIPT, '--seed', 'de', '--out', dir], dir);
      expect(seed.status, 'precondition: --seed de').toBe(0);
      const deOut = path.join(dir, 'catalog.de.ts');
      const de = runNode([IMPORT_SCRIPT, 'de', deJsonPath, '--out', deOut], dir);
      expect(de.status, `de import must exit 0: ${de.stderr}`).toBe(0);
      expect(
        ['resolver.ts', 'resolver.test.ts', 'catalogParity.test.ts', 'PLURAL_CATEGORIES'].filter(
          (n) => de.stdout.indexOf(n) === -1,
        ),
        'a NEW tag prints the manual registration edits (A12: resolver.ts CATALOGS, resolver.test.ts, catalogParity.test.ts PLURAL_CATEGORIES)',
      ).toEqual([]);
      expect(
        countOccurrences(readFileSync(deOut, 'utf8'), '// @translated: false'),
        'a seeded catalog carries 112 markers',
      ).toBe(112);

      const badPath = path.join(dir, 'bad.icu.json');
      writeFileSync(
        badPath,
        `${JSON.stringify(
          frJson((j) =>
            setMessage(
              j,
              'battle.weather.banner',
              '{label} ({turns} {turns, select, one {a} other {b}})',
            ),
          ),
          null,
          2,
        )}\n`,
        'utf8',
      );
      const badOut = path.join(dir, 'bad.ts');
      const bad = runNode([IMPORT_SCRIPT, 'fr', badPath, '--out', badOut], dir);
      expect(
        {
          status: bad.status,
          code: bad.stderr.indexOf('ICU-UNSUPPORTED') !== -1,
          written: existsSync(badOut) || existsSync(`${badOut}.tmp`),
        },
        'a select message -> exit 2, ICU-UNSUPPORTED on stderr, nothing written',
      ).toEqual({ status: 2, code: true, written: false });

      const enOut = path.join(dir, 'catalog.en.ts');
      writeFileSync(path.join(dir, 'en.icu.json'), exportTag('en').text, 'utf8');
      const en = runNode([IMPORT_SCRIPT, 'en', path.join(dir, 'en.icu.json'), '--out', enOut], dir);
      expect(
        {
          status: en.status,
          code: en.stderr.indexOf('LOCALE-IS-SOURCE') !== -1,
          written: existsSync(enOut),
        },
        'importing en -> LOCALE-IS-SOURCE, exit 2, nothing written',
      ).toEqual({ status: 2, code: true, written: false });

      const none = runNode([IMPORT_SCRIPT], dir);
      expect(
        none.status,
        'no arguments is a usage error, exit 2 (an unguarded main would have exited at collection)',
      ).toBe(2);

      // (n1) A default-path import of a NEW locale creates the very file that makes discovery say
      // "registered", so the banner decision must be taken BEFORE the write. Not testable against
      // the real dir here (nothing may be written under client/src/ui/i18n), so a RegExp-free
      // ordering pin on the CLI's `main` body: `discoverLocales()` precedes `importLocale(`.
      // Kills "banner computed after the write".
      const mainBody = functionBody(
        stripComments(readFileSync(IMPORT_SCRIPT, 'utf8')),
        'function main(',
      );
      const discoverAt = mainBody.indexOf('discoverLocales()');
      const importCallAt = mainBody.indexOf('importLocale(');
      expect(
        {
          discoverFound: discoverAt !== -1,
          importFound: importCallAt !== -1,
          discoverBeforeImport: discoverAt < importCallAt,
        },
        'main body order: discoverLocales() (the wasRegistered decision) < importLocale( (the write) — kills "banner computed after the write"',
      ).toEqual({ discoverFound: true, importFound: true, discoverBeforeImport: true });

      expect(
        {
          fr: readFileSync(liveFrPath, 'utf8') === frBefore,
          baseline:
            (existsSync(liveBaselinePath) ? readFileSync(liveBaselinePath, 'utf8') : undefined) ===
            baselineBefore,
        },
        'm7: catalog.fr.ts and evals/baselines/i18n-locale-completion.json are byte-identical after every import CLI run',
      ).toEqual({ fr: true, baseline: true });
    },
    LONG_TEST_MS,
  );
});
