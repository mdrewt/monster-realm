#!/usr/bin/env node
// catalog-export.mjs — client/src/ui/i18n/catalog.<tag>.ts -> <tag>.icu.json (ICU MessageFormat
// interchange, M24 S8, ADR-0264), plus the nightly locale-completion baseline.
//
// WHY THE SOURCE IS PARSED, NEVER IMPORTED. The translator-facing `// @desc:` block and the
// `// @translated: false` marker are comments — invisible to the runtime module — and a closure
// value is opaque at runtime (no way back to `${p.x}`). So this is a cursor walker over the RAW
// file: the contiguous `//` block directly above an entry is the description (verbatim, one line
// per comment line, exactly SHAPE-01's adjacency rule), a value is a quoted string or a
// `(p) => \`…\`` template whose holes are `${p.<name>}` or `${selectPlural('<tag>', p.<name>,
// <CONST>)}` with `<CONST>` a hoisted `cldr({…})`. Anything outside that grammar is a PARSE error
// naming `<file>:<line>:` — reject, never guess (ADR-0205 D4). The marker is the single source
// of truth for `translated`: absence means true, `true` is never written, and a string diff
// against English is NOT a signal (a glyph-only key legitimately equals its English twin).
//
// WHY ONLY LIVE CLDR CATEGORIES ARE EMITTED. A catalog's forms record is total (six keys) so the
// type stays honest, but fr never selects `zero`/`two`/`few` — exporting them hands a translator
// branches whose edits change nothing. `Intl.PluralRules(tag).resolvedOptions().pluralCategories`
// is the live set; the importer fills the dead ones from `other`.
//
// WHY THE COMPLETION RATCHET IS GAP-ONLY. `total` follows the English key count (every new key
// moves it) and `translated` follows it too; only `gap = total - translated` measures translation
// debt, so a baseline is checked on gap alone: it may not grow (REGRESSION) and the committed
// number may not lag the tree (STALE). Both are exit 1 — a nightly that disagrees with the tree
// in either direction is a lie, and the regen recipe is the fix.
//
// ZERO RegExp (ADR-0055 and the M24 convention): every scan is indexOf / charAt / a char class.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const I18N_DIR = join(PROJECT_ROOT, 'client', 'src', 'ui', 'i18n');
const BUILD_DIR = join(PROJECT_ROOT, 'build', 'i18n');
const BASELINE_PATH = join(PROJECT_ROOT, 'evals', 'baselines', 'i18n-locale-completion.json');
const GENERATED_BY = 'scripts/catalog-export.mjs';
/** Canonical CLDR order — the emission order of plural branches and of a forms record. */
export const CATEGORIES = Object.freeze(['zero', 'one', 'two', 'few', 'many', 'other']);
/** The `${` opener, concatenated so no plain string literal here holds a template hole. */
const HOLE = '$' + '{';

/** The hole-model token for a param: `${p.<name>}`. */
export function paramHole(name) {
  return `${HOLE}p.${name}}`;
}

/** The hole-model token for a plural: `${plural.<name>}`. */
export function pluralHole(name) {
  return `${HOLE}plural.${name}}`;
}

/** Every error is structured: `catalog-export: <CODE> <detail>` with `err.code`. */
function fail(code, detail) {
  throw Object.assign(new Error(`catalog-export: ${code} ${detail}`), { code });
}

// ---------------------------------------------------------------------------
// Char classes (mirrors catalogShape.test.ts — not imported: a script never depends on a test).
// ---------------------------------------------------------------------------

export function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

export function isIdentChar(ch) {
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36
  );
}

function isIdent(s) {
  if (s.length === 0) return false;
  const first = s.charCodeAt(0);
  if (first >= 48 && first <= 57) return false;
  for (let i = 0; i < s.length; i++) if (!isIdentChar(s.charAt(i))) return false;
  return true;
}

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line += 1;
  return line;
}

// ---------------------------------------------------------------------------
// Locales.
// ---------------------------------------------------------------------------

/** Canonical-order live plural categories of `tag`; LOCALE-UNSUPPORTED when ICU has no data
 *  (`new Intl.PluralRules('xx')` would silently resolve to en-US — plural.ts's reason). */
export function liveCategories(tag) {
  let supported = [];
  try {
    supported = Intl.PluralRules.supportedLocalesOf([tag]);
  } catch {
    supported = [];
  }
  if (supported.length !== 1) fail('LOCALE-UNSUPPORTED', `no CLDR plural data for '${tag}'`);
  const live = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  return CATEGORIES.filter((c) => live.includes(c));
}

/** Sorted tags of every `catalog.<tag>.ts` (never a `.test.ts`) in the i18n dir. */
export function discoverLocales(i18nDir = I18N_DIR) {
  const tags = [];
  for (const name of readdirSync(i18nDir)) {
    if (!name.startsWith('catalog.') || !name.endsWith('.ts') || name.endsWith('.test.ts'))
      continue;
    const tag = name.slice('catalog.'.length, name.length - '.ts'.length);
    liveCategories(tag);
    tags.push(tag);
  }
  return tags.sort();
}

// ---------------------------------------------------------------------------
// The catalog source parser.
// ---------------------------------------------------------------------------

const ESCAPES = Object.freeze({
  n: '\n',
  t: '\t',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '`': '`',
  $: '$',
});

/** Parses RAW catalog source into `{ tag, entries }` (see the header for the grammar). */
export function parseCatalogSource(source, { tag, file }) {
  const src = source;
  let i = 0;
  const parseFail = (msg, at = i) => fail('PARSE', `${file}:${lineAt(src, at)}: ${msg}`);
  const skipWs = () => {
    while (i < src.length && isWhitespace(src.charAt(i))) i += 1;
  };
  const skipBlanks = () => {
    while (i < src.length && (src.charAt(i) === ' ' || src.charAt(i) === '\t')) i += 1;
  };
  const expect = (token) => {
    if (!src.startsWith(token, i)) parseFail(`expected ${JSON.stringify(token)}`);
    i += token.length;
  };
  const readIdent = () => {
    const start = i;
    while (i < src.length && isIdentChar(src.charAt(i))) i += 1;
    if (i === start) parseFail('expected an identifier');
    return src.slice(start, i);
  };
  const readEscape = () => {
    const decoded = ESCAPES[src.charAt(i + 1)];
    if (decoded === undefined) parseFail(`unsupported escape \\${src.charAt(i + 1)}`);
    i += 2;
    return decoded;
  };
  /** A `'…'` or `"…"` literal at the cursor, decoded (A2: biome may flip the quote). */
  const readQuoted = () => {
    const quote = src.charAt(i);
    if (quote !== "'" && quote !== '"') parseFail('expected a quoted string');
    const at = i;
    i += 1;
    let out = '';
    for (;;) {
      if (i >= src.length || src.charAt(i) === '\n') parseFail('unterminated string', at);
      const ch = src.charAt(i);
      if (ch === quote) {
        i += 1;
        return out;
      }
      out += ch === '\\' ? readEscape() : ch;
      if (ch !== '\\') i += 1;
    }
  };
  /** A hoisted `cldr({ zero: '…', … })` record at the cursor (after `cldr(`): six unquoted keys. */
  const readForms = () => {
    expect('{');
    const forms = {};
    for (;;) {
      skipWs();
      if (src.charAt(i) === '}') break;
      const at = i;
      const cat = readIdent();
      if (!CATEGORIES.includes(cat) || Object.hasOwn(forms, cat)) {
        parseFail(`bad plural category '${cat}'`, at);
      }
      skipWs();
      expect(':');
      skipWs();
      forms[cat] = readQuoted();
      skipWs();
      if (src.charAt(i) === ',') i += 1;
    }
    i += 1;
    skipWs();
    expect(')');
    expect(';');
    if (Object.keys(forms).length !== 6) parseFail('cldr({…}) must name all six categories');
    const canonical = {};
    for (const cat of CATEGORIES) canonical[cat] = forms[cat];
    return canonical;
  };
  // (a) hoisted forms: every `const <IDENT> = cldr(` line; any other shape after `= cldr(` fails.
  const hoisted = new Map();
  for (let at = src.indexOf('= cldr('); at !== -1; at = src.indexOf('= cldr(', i)) {
    const lineStart = src.lastIndexOf('\n', at) + 1;
    const head = src.slice(lineStart, at);
    i = at + '= cldr('.length;
    if (!head.startsWith('const ')) continue;
    const name = head.slice('const '.length).trim();
    if (!isIdent(name) || hoisted.has(name)) parseFail(`bad forms const '${name}'`, at);
    hoisted.set(name, readForms());
  }
  // (b) the entries between the declaration and `} satisfies Catalog);`.
  const decl = `export const CATALOG_${tag.toUpperCase().split('-').join('_')}: Catalog = Object.freeze({`;
  const declAt = src.indexOf(decl);
  if (declAt === -1 || src.indexOf(decl, declAt + 1) !== -1) {
    parseFail(`expected exactly one \`${decl}\``, 0);
  }
  const terminator = '} satisfies Catalog);';
  const termAt = src.indexOf(terminator, declAt);
  if (termAt === -1) parseFail(`missing \`${terminator}\``, declAt);
  const addParam = (entry, name) => {
    if (!entry.params.includes(name)) entry.params.push(name);
  };
  /** A `${…}` hole at the cursor: `p.<name>` or a whitespace-tolerant `selectPlural(...)`. */
  const readHole = (entry) => {
    const at = i;
    i += 2;
    skipWs();
    if (src.startsWith('p.', i)) {
      i += 2;
      const name = readIdent();
      skipWs();
      if (src.charAt(i) !== '}') parseFail('unsupported hole (only p.<name> is a param)', at);
      i += 1;
      addParam(entry, name);
      return paramHole(name);
    }
    if (!src.startsWith('selectPlural', i)) parseFail('unsupported hole', at);
    i += 'selectPlural'.length;
    skipWs();
    expect('(');
    skipWs();
    const holeTag = readQuoted();
    skipWs();
    expect(',');
    skipWs();
    expect('p.');
    const name = readIdent();
    skipWs();
    expect(',');
    skipWs();
    const constName = readIdent();
    skipWs();
    expect(')');
    skipWs();
    expect('}');
    if (holeTag !== tag) parseFail(`selectPlural tag '${holeTag}' is not '${tag}'`, at);
    if (!hoisted.has(constName)) parseFail(`unresolved forms const '${constName}'`, at);
    if (Object.hasOwn(entry.plurals, name)) parseFail(`two plurals on '${name}'`, at);
    entry.plurals[name] = hoisted.get(constName);
    addParam(entry, name);
    return pluralHole(name);
  };
  const readTemplate = (entry) => {
    const at = i;
    i += 1;
    let text = '';
    for (;;) {
      if (i >= src.length) parseFail('unterminated template', at);
      const ch = src.charAt(i);
      if (ch === '`') {
        i += 1;
        return text;
      }
      if (ch === '\\') {
        const decoded = readEscape();
        if (decoded === '$' && src.charAt(i) === '{') parseFail(`literal ${HOLE} has no hole form`);
        text += decoded;
      } else if (ch === '$' && src.charAt(i + 1) === '{') {
        text += readHole(entry);
      } else {
        text += ch;
        i += 1;
      }
    }
  };
  const readValue = (entry) => {
    const ch = src.charAt(i);
    if (ch === "'" || ch === '"') {
      entry.text = readQuoted();
      if (entry.text.indexOf(HOLE) !== -1) parseFail(`literal ${HOLE} has no hole form`);
      return;
    }
    if (!src.startsWith('(p) =>', i)) parseFail('unsupported value (quoted string or (p) => `…`)');
    i += '(p) =>'.length;
    skipWs();
    if (src.charAt(i) !== '`') parseFail('expected a template literal after (p) =>');
    entry.kind = 'closure';
    entry.text = readTemplate(entry);
  };
  /** The `//` block above an entry: `// @desc:` first, `// @translated:` read and excluded. */
  const readBlock = (block, at) => {
    if (block.length === 0) parseFail('no // @desc: block directly above the entry', at);
    if (!block[0].startsWith('// @desc:')) parseFail('the first block line must be // @desc:', at);
    const strip = (line, prefix) => {
      const rest = line.slice(prefix.length);
      return rest.startsWith(' ') ? rest.slice(1) : rest;
    };
    const lines = [strip(block[0], '// @desc:')];
    let translated = true;
    let markers = 0;
    for (const line of block.slice(1)) {
      const body = strip(line, '//');
      if (body.startsWith('@desc:')) parseFail('two // @desc: lines in one block', at);
      if (body.startsWith('@translated:')) {
        const value = body.slice('@translated:'.length).trim();
        if ((value !== 'false' && value !== 'true') || markers > 0) {
          parseFail(`bad // @translated: value '${value}'`, at);
        }
        markers += 1;
        translated = value === 'true';
      } else {
        lines.push(body);
      }
    }
    return { description: lines.join('\n'), translated };
  };
  i = declAt + decl.length;
  const entries = [];
  const seen = new Set();
  let block = [];
  let openEnded = false;
  for (;;) {
    skipBlanks();
    if (i >= termAt) break;
    const ch = src.charAt(i);
    if (ch === '\n') {
      block = [];
      i += 1;
      continue;
    }
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      block.push(src.slice(i, end));
      i = end + 1;
      continue;
    }
    const at = i;
    if (openEnded) parseFail('missing comma after the previous entry');
    const key = readQuoted();
    if (seen.has(key)) parseFail(`duplicate key '${key}'`, at);
    const { description, translated } = readBlock(block, at);
    block = [];
    expect(':');
    skipWs();
    const entry = {
      key,
      kind: 'plain',
      text: '',
      params: [],
      plurals: {},
      description,
      translated,
    };
    readValue(entry);
    skipBlanks();
    if (src.charAt(i) === ',') {
      i += 1;
      skipBlanks();
    } else {
      openEnded = true;
    }
    if (i < termAt && src.charAt(i) !== '\n') parseFail('trailing content on the entry line');
    entries.push(entry);
    seen.add(key);
  }
  return { tag, entries };
}

// ---------------------------------------------------------------------------
// ICU emission (A1: ICU4J DOUBLE_REQUIRED-compatible quoting, one span per maximal run).
// ---------------------------------------------------------------------------

/** Quotes `text` for ICU: each maximal run of `specials` (with any apostrophes inside it) becomes
 *  ONE `'…'` span with its apostrophes doubled; an apostrophe touching no special is `''`. */
function quoteIcu(text, specials) {
  let out = '';
  let i = 0;
  const isSpecial = (ch) => specials.indexOf(ch) !== -1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch !== "'" && !isSpecial(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    let j = i;
    let hasSpecial = false;
    while (j < text.length && (text.charAt(j) === "'" || isSpecial(text.charAt(j)))) {
      if (text.charAt(j) !== "'") hasSpecial = true;
      j += 1;
    }
    const run = text.slice(i, j).split("'").join("''");
    out += hasSpecial ? `'${run}'` : run;
    i = j;
  }
  return out;
}

/** Walks a hole-model text: `onText(literal)` per literal run, `onHole(inner)` per `${inner}`. */
export function walkHoles(text, onText, onHole) {
  let i = 0;
  for (;;) {
    const at = text.indexOf(HOLE, i);
    onText(text.slice(i, at === -1 ? text.length : at));
    if (at === -1) return;
    const close = text.indexOf('}', at);
    onHole(text.slice(at + 2, close));
    i = close + 1;
  }
}

/** The ICU message of an entry: `{x}` holes, `{n, plural, <live cat> {…} …}` plurals. */
export function toIcuMessage(entry, live) {
  let out = '';
  walkHoles(
    entry.text,
    (literal) => {
      out += quoteIcu(literal, '{}');
    },
    (inner) => {
      if (inner.startsWith('p.')) {
        out += `{${inner.slice(2)}}`;
        return;
      }
      const name = inner.slice('plural.'.length);
      const forms = entry.plurals[name];
      const branches = live.map((cat) => `${cat} {${quoteIcu(forms[cat], '{}#')}}`);
      out += `{${name}, plural, ${branches.join(' ')}}`;
    },
  );
  return out;
}

function readModel(tag, i18nDir) {
  const file = `catalog.${tag}.ts`;
  return parseCatalogSource(readFileSync(join(i18nDir, file), 'utf8'), { tag, file });
}

/** `{ json, text }` for one locale — catalog order, four fields per message, no timestamp. */
export function exportLocale(tag, { i18nDir = I18N_DIR } = {}) {
  const live = liveCategories(tag);
  const messages = {};
  for (const entry of readModel(tag, i18nDir).entries) {
    messages[entry.key] = {
      message: toIcuMessage(entry, live),
      description: entry.description,
      params: entry.params,
      translated: entry.translated,
    };
  }
  const json = { locale: tag, sourceLocale: 'en', generatedBy: GENERATED_BY, messages };
  return { json, text: `${JSON.stringify(json, null, 2)}\n` };
}

// ---------------------------------------------------------------------------
// Completion baseline (gap-only ratchet, see the header).
// ---------------------------------------------------------------------------

export function computeCompletion(models) {
  const out = {};
  for (const model of [...models].sort((a, b) => (a.tag < b.tag ? -1 : 1))) {
    const total = model.entries.length;
    const translated = model.entries.filter((e) => e.translated).length;
    out[model.tag] = { total, translated, gap: total - translated };
  }
  return out;
}

/** Per-tag rows over baseline ∪ live: `{ tag, status, grew, line }`. */
function classify(live, baseline) {
  const tags = [...new Set([...Object.keys(baseline), ...Object.keys(live)])].sort();
  return tags.map((tag) => {
    const l = live[tag];
    const b = baseline[tag];
    let status = 'OK';
    let grew = false;
    if (l === undefined) {
      status = `REGRESSION missing live (baseline gap ${b.gap})`;
      return {
        tag,
        status,
        grew,
        line: `i18n-completion: ${tag} total=- translated=- gap=- ${status}`,
      };
    }
    if (b === undefined) status = 'STALE not in the baseline';
    else if (l.gap > b.gap) {
      status = `REGRESSION gap ${b.gap} -> ${l.gap}`;
      grew = true;
    } else if (l.gap < b.gap) status = `STALE gap ${b.gap} -> ${l.gap}`;
    const line = `i18n-completion: ${tag} total=${l.total} translated=${l.translated} gap=${l.gap} ${status}`;
    return { tag, status, grew, line };
  });
}

export function checkCompletion(live, baseline) {
  const rows = classify(live, baseline);
  const notOk = rows.filter((r) => r.status !== 'OK').length;
  const lines = rows.map((r) => r.line);
  lines.push(`i18n-completion: ${rows.length} locale(s) checked, ${notOk} not OK`);
  return { lines, exitCode: notOk > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// CLI (main-guarded — a static import never runs it).
// ---------------------------------------------------------------------------

const USAGE = [
  'usage: node scripts/catalog-export.mjs [--out <dir>]',
  '       node scripts/catalog-export.mjs --completion [--check] [--baseline <path>]',
  '       node scripts/catalog-export.mjs --seed <tag> [--out <dir>]',
].join('\n');

function parseArgs(argv) {
  const opts = { mode: 'export', out: undefined, check: false, baseline: undefined, seed: '' };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    const value = argv[k + 1];
    if (arg === '--completion') opts.mode = 'completion';
    else if (arg === '--check') opts.check = true;
    else if ((arg === '--out' || arg === '--baseline' || arg === '--seed') && value !== undefined) {
      if (arg === '--out') opts.out = value;
      else if (arg === '--baseline') opts.baseline = value;
      else {
        opts.mode = 'seed';
        opts.seed = value;
      }
      k += 1;
    } else return undefined;
  }
  return opts;
}

function writeJson(outDir, tag, text) {
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${tag}.icu.json`);
  writeFileSync(outPath, text, 'utf8');
  return outPath;
}

function runCompletion(opts) {
  const baselinePath = resolve(opts.baseline ?? BASELINE_PATH);
  const live = computeCompletion(discoverLocales().map((tag) => readModel(tag, I18N_DIR)));
  let baseline;
  if (existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    } catch (err) {
      fail('BASELINE-INVALID', `${baselinePath}: ${err.message}`);
    }
  }
  if (opts.check) {
    if (baseline === undefined) {
      console.error(`catalog-export: BASELINE-MISSING ${baselinePath}`);
      return 1;
    }
    const { lines, exitCode } = checkCompletion(live, baseline);
    for (const line of lines) console.log(line);
    return exitCode;
  }
  // The writer refuses a grown gap (A4): the fix is to translate, not to move the bar.
  const grown = baseline === undefined ? [] : classify(live, baseline).filter((r) => r.grew);
  if (grown.length > 0) {
    for (const row of grown) console.log(row.line);
    console.error(`catalog-export: REGRESSION not written — ${grown.length} locale(s) lost ground`);
    return 1;
  }
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(live, null, 2)}\n`, 'utf8');
  console.log(
    `catalog-export: completion ${Object.keys(live).length} locale(s) -> ${baselinePath}`,
  );
  return 0;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts === undefined) {
    console.error(USAGE);
    return 2;
  }
  if (opts.mode === 'completion') return runCompletion(opts);
  const outDir = resolve(opts.out ?? BUILD_DIR);
  if (opts.mode === 'seed') {
    // A9: the only sanctioned producer of `translated: false` — English text under a new tag.
    if (opts.seed === 'en') fail('LOCALE-IS-SOURCE', 'en is the source locale, nothing to seed');
    liveCategories(opts.seed);
    const { json } = exportLocale('en');
    json.locale = opts.seed;
    for (const message of Object.values(json.messages)) message.translated = false;
    const outPath = writeJson(outDir, opts.seed, `${JSON.stringify(json, null, 2)}\n`);
    console.log(
      `catalog-export: ${opts.seed} ${Object.keys(json.messages).length} messages -> ${outPath} (seeded from en)`,
    );
    return 0;
  }
  for (const tag of discoverLocales()) {
    const { json, text } = exportLocale(tag);
    const outPath = writeJson(outDir, tag, text);
    console.log(
      `catalog-export: ${tag} ${Object.keys(json.messages).length} messages -> ${outPath}`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (!err || typeof err.code !== 'string') throw err;
    console.error(
      err.message.startsWith('catalog-export:')
        ? err.message
        : `catalog-export: ${err.code} ${err.message}`,
    );
    process.exitCode = 2;
  }
}
