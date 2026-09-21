#!/usr/bin/env node
// catalog-import.mjs — <tag>.icu.json -> client/src/ui/i18n/catalog.<tag>.ts (M24 S8, ADR-0264).
//
// WHY THE DECODER IS DOUBLE_OPTIONAL BUT THE EMITTER (catalog-export.mjs) ALWAYS QUOTES. A TMS
// hands back whatever ICU4J accepts: `''` is one apostrophe, a `'` before a syntax char opens a
// quoted span to the next lone `'`, and any other lone `'` is literal — so the reader must be
// ICU4J-faithful or a translator's `l'objet` would be mangled. Our own exporter still writes the
// unambiguous DOUBLE_REQUIRED form so every file it produces reads the same under both modes.
//
// WHY THE SUBSET IS DEPTH-1 PLURAL-ONLY, AND WHY EVERYTHING ELSE IS A NAMED REJECTION. The
// catalog has exactly two hole kinds (`${p.x}` and a CLDR plural over one param), so `select`,
// `selectordinal`, `=N`, `offset:`, nesting, `#` and any other argument type cannot be expressed
// in the target file — a guess would ship a silent no-op; each is a code and exit 2, nothing
// written. Only the locale's LIVE CLDR categories may be authored (PLURAL-CATEGORIES); the dead
// ones are filled from `other` so the emitted forms record stays total.
//
// WHY THE EMITTED FILE IS RE-PARSED BEFORE THE WRITE. The exporter's parser is the SSOT for what
// a catalog may contain; if emit(validate(json)) does not parse back to the same model the file
// would be unreadable on the next export (EMIT-MISMATCH) — so the text goes to `<out>.tmp` and
// is renamed into place only after that self-check. The `// @translated: false` marker is written
// LAST in the block and only when the JSON says false; `true` is never written (absence = true).
//
// ZERO RegExp (ADR-0055): indexOf / charAt / char classes only; parser shared with the exporter.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  CATEGORIES,
  discoverLocales,
  I18N_DIR,
  isIdentChar,
  isWhitespace,
  liveCategories,
  paramHole,
  parseCatalogSource,
  pluralHole,
  walkHoles,
} from './catalog-export.mjs';

/** The `${` opener, concatenated so no plain string literal here holds a template hole. */
const HOLE = '$' + '{';

function fail(code, detail) {
  throw Object.assign(new Error(`catalog-import: ${code} ${detail}`), { code });
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** CONTROL-CHAR: nothing below U+0020, no DEL, no U+2028/U+2029 (line terminators inside a
 *  quoted TS literal). `allowNewline` lets a multi-line description through. */
function checkControl(s, where, allowNewline) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (allowNewline && c === 10) continue;
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) {
      fail('CONTROL-CHAR', `${where}: U+${c.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
}

/** `<KEY_UPPER, . -> _>_<PARAM_UPPER>_FORMS` — the hoisted const name of one plural. */
function formsConstName(key, param) {
  return `${key.toUpperCase().split('.').join('_')}_${param.toUpperCase()}_FORMS`;
}

// ---------------------------------------------------------------------------
// The ICU reader (DOUBLE_OPTIONAL, depth-1 plural-only subset).
// ---------------------------------------------------------------------------

/** `{ text, params, plurals }` for one message; `roster` = the key's EN param names. */
export function parseIcuMessage(message, { liveCategories: live, roster }) {
  let i = 0;
  const params = [];
  const plurals = {};
  const icuFail = (code, msg) => fail(code, `${msg} in ${JSON.stringify(message)}`);
  const addParam = (name) => {
    if (!params.includes(name)) params.push(name);
  };
  const skipWs = () => {
    while (i < message.length && isWhitespace(message.charAt(i))) i += 1;
  };
  const readName = () => {
    const start = i;
    while (i < message.length && isIdentChar(message.charAt(i))) i += 1;
    if (i === start) icuFail('ICU-SYNTAX', 'expected an argument name');
    return message.slice(start, i);
  };
  /** Decoded literal text up to the first UNQUOTED `specials` char (the cursor stays on it). */
  const readLiteral = (specials) => {
    let out = '';
    while (i < message.length) {
      const ch = message.charAt(i);
      if (ch === "'") {
        const next = message.charAt(i + 1);
        if (next === "'") {
          out += "'";
          i += 2;
        } else if (next === '' || specials.indexOf(next) === -1) {
          out += "'";
          i += 1;
        } else {
          i += 1;
          for (;;) {
            const close = message.indexOf("'", i);
            if (close === -1) icuFail('ICU-SYNTAX', 'unterminated quoted span');
            out += message.slice(i, close);
            i = close + 1;
            if (message.charAt(i) !== "'") break;
            out += "'";
            i += 1;
          }
        }
      } else if (specials.indexOf(ch) !== -1) {
        break;
      } else {
        out += ch;
        i += 1;
      }
    }
    // A decoded `${` (a quoted brace after a dollar) is as unemittable as a raw one (A3).
    if (out.indexOf(HOLE) !== -1) icuFail('ICU-UNSUPPORTED', `literal ${HOLE} in the text`);
    return out;
  };
  const readArgument = () => {
    i += 1;
    skipWs();
    const name = readName();
    skipWs();
    if (message.charAt(i) === '}') {
      i += 1;
      addParam(name);
      return paramHole(name);
    }
    if (message.charAt(i) !== ',') icuFail('ICU-SYNTAX', `bad argument name '${name}'`);
    i += 1;
    skipWs();
    const type = readName();
    skipWs();
    if (type !== 'plural') icuFail('ICU-UNSUPPORTED', `argument type '${type}'`);
    if (message.charAt(i) !== ',') icuFail('ICU-SYNTAX', 'expected , after plural');
    i += 1;
    if (!roster.includes(name)) icuFail('ICU-UNSUPPORTED', `plural on '${name}' (not a param)`);
    if (Object.hasOwn(plurals, name)) icuFail('ICU-UNSUPPORTED', `a second plural on '${name}'`);
    const branches = {};
    for (;;) {
      skipWs();
      if (i >= message.length) icuFail('ICU-SYNTAX', 'unbalanced {');
      if (message.charAt(i) === '}') break;
      const start = i;
      while (i < message.length && !isWhitespace(message.charAt(i)) && message.charAt(i) !== '{') {
        i += 1;
      }
      const selector = message.slice(start, i);
      if (selector.startsWith('=') || selector.startsWith('offset:')) {
        icuFail('ICU-UNSUPPORTED', `plural selector '${selector}'`);
      }
      if (!CATEGORIES.includes(selector) || Object.hasOwn(branches, selector)) {
        icuFail('ICU-SYNTAX', `plural selector '${selector}'`);
      }
      skipWs();
      if (message.charAt(i) !== '{') icuFail('ICU-SYNTAX', `expected { after '${selector}'`);
      i += 1;
      const body = readLiteral('{}#');
      const stop = message.charAt(i);
      if (stop === '') icuFail('ICU-SYNTAX', 'unbalanced {');
      if (stop === '{') icuFail('ICU-UNSUPPORTED', 'nesting inside a plural branch');
      if (stop === '#') icuFail('ICU-HASH', `unquoted # in the '${selector}' branch`);
      if (body.length === 0) icuFail('MSG-EMPTY', `empty '${selector}' branch`);
      i += 1;
      branches[selector] = body;
    }
    i += 1;
    const authored = Object.keys(branches);
    if (!sameSet(authored, live)) {
      icuFail(
        'PLURAL-CATEGORIES',
        `[${authored.join(' ')}] is not the live set [${live.join(' ')}]`,
      );
    }
    const ordered = {};
    for (const cat of CATEGORIES) if (Object.hasOwn(branches, cat)) ordered[cat] = branches[cat];
    plurals[name] = ordered;
    addParam(name);
    return pluralHole(name);
  };
  let text = '';
  for (;;) {
    text += readLiteral('{}');
    if (i >= message.length) break;
    if (message.charAt(i) === '}') icuFail('ICU-SYNTAX', 'unbalanced }');
    text += readArgument();
  }
  return { text, params, plurals };
}

// ---------------------------------------------------------------------------
// Validation (pure) and emission.
// ---------------------------------------------------------------------------

/** The import model — entries in EN order, six-key plurals (dead categories = `other`). */
export function validateImport(json, { tag, enModel }) {
  const live = liveCategories(tag);
  if (!isObject(json) || json.locale !== tag) {
    fail('LOCALE-MISMATCH', `json.locale ${JSON.stringify(json?.locale)} under tag '${tag}'`);
  }
  if (!isObject(json.messages)) fail('KEY-SET-MISMATCH', 'json.messages is not an object');
  const enKeys = enModel.entries.map((e) => e.key);
  const unknown = Object.keys(json.messages).filter((k) => !enKeys.includes(k));
  const missing = enKeys.filter((k) => !Object.hasOwn(json.messages, k));
  if (unknown.length > 0 || missing.length > 0) {
    fail('KEY-SET-MISMATCH', `unknown [${unknown.join(' ')}] missing [${missing.join(' ')}]`);
  }
  const constNames = new Set();
  const entries = enModel.entries.map((en) => {
    const m = json.messages[en.key];
    const where = `'${en.key}'`;
    if (!isObject(m)) fail('KEY-SET-MISMATCH', `${where}: not an object`);
    if (typeof m.translated !== 'boolean') fail('TRANSLATED-NOT-BOOLEAN', where);
    if (typeof m.description !== 'string') fail('DESC-INVALID', `${where}: not a string`);
    checkControl(m.description, `${where} description`, true);
    const descLines = m.description.split('\n');
    let firstLineChars = 0;
    for (const ch of descLines[0]) if (!isWhitespace(ch)) firstLineChars += 1;
    if (firstLineChars < 10) fail('DESC-INVALID', `${where}: first line < 10 non-whitespace chars`);
    for (const line of descLines) {
      if (line.trim().startsWith('@')) fail('DESC-INVALID', `${where}: a line starts with @`);
      // biome trims trailing whitespace inside comments (measured), so it could never round-trip.
      if (line !== line.trimEnd()) fail('DESC-INVALID', `${where}: a line ends with whitespace`);
    }
    if (typeof m.message !== 'string' || m.message.length === 0) fail('MSG-EMPTY', where);
    checkControl(m.message, `${where} message`, false);
    if (m.message.indexOf(HOLE) !== -1) fail('ICU-UNSUPPORTED', `${where}: literal ${HOLE}`);
    const parsed = parseIcuMessage(m.message, { liveCategories: live, roster: en.params });
    if (!sameSet(parsed.params, en.params)) {
      fail(
        'PARAMS-MISMATCH',
        `${where}: message [${parsed.params.join(' ')}] vs en [${en.params.join(' ')}]`,
      );
    }
    const listed = Array.isArray(m.params) ? m.params : [];
    if (!listed.every((p) => typeof p === 'string') || !sameSet(listed, en.params)) {
      fail(
        'PARAMS-MISMATCH',
        `${where}: params [${listed.join(' ')}] vs en [${en.params.join(' ')}]`,
      );
    }
    const plurals = {};
    for (const name of Object.keys(parsed.plurals)) {
      const constName = formsConstName(en.key, name);
      if (constNames.has(constName)) fail('FORMS-NAME-COLLISION', `${constName} (${where})`);
      constNames.add(constName);
      const authored = parsed.plurals[name];
      const six = {};
      for (const cat of CATEGORIES)
        six[cat] = Object.hasOwn(authored, cat) ? authored[cat] : authored.other;
      plurals[name] = six;
    }
    return {
      key: en.key,
      kind: en.kind,
      text: parsed.text,
      params: parsed.params,
      plurals,
      description: m.description,
      translated: m.translated,
    };
  });
  return { tag, entries };
}

/** A2: biome's quote — double when the text has `'` and no `"`, else single with `\'`. */
function quoteTs(text) {
  const useDouble = text.indexOf("'") !== -1 && text.indexOf('"') === -1;
  const escaped = text.split('\\').join('\\\\');
  if (useDouble) return `"${escaped}"`;
  return `'${escaped.split("'").join("\\'")}'`;
}

function closureTs(tag, entry) {
  let body = '';
  walkHoles(
    entry.text,
    (literal) => {
      body += literal.split('\\').join('\\\\').split('`').join('\\`');
    },
    (inner) => {
      if (inner.startsWith('p.')) {
        body += `${HOLE}${inner}}`;
        return;
      }
      const name = inner.slice('plural.'.length);
      body += `${HOLE}selectPlural('${tag}', p.${name}, ${formsConstName(entry.key, name)})}`;
    },
  );
  return `(p) => \`${body}\``;
}

/** The catalog.<tag>.ts text for a validated model (unformatted — biome runs in the recipe). */
export function emitCatalogTs(tag, model) {
  const lines = [
    `// ui/i18n/catalog.${tag}.ts — generated by scripts/catalog-import.mjs from ${tag}.icu.json (ADR-0264).`,
    '// Hand-editable: the exporter re-reads every comment block and value, so an edit here survives',
    '// the next export. Dead CLDR categories of a plural mirror its other form; only entry blocks',
    '// round-trip (this header is regenerated each time the file is written).',
    '',
    "import type { Catalog } from './messageIds';",
  ];
  const withPlurals = model.entries.filter((e) => Object.keys(e.plurals).length > 0);
  if (withPlurals.length > 0) lines.push("import { cldr, selectPlural } from './plural';");
  lines.push('');
  for (const entry of withPlurals) {
    for (const name of Object.keys(entry.plurals)) {
      lines.push(`const ${formsConstName(entry.key, name)} = cldr({`);
      for (const cat of CATEGORIES) lines.push(`  ${cat}: ${quoteTs(entry.plurals[name][cat])},`);
      lines.push('});', '');
    }
  }
  lines.push(
    `export const CATALOG_${tag.toUpperCase().split('-').join('_')}: Catalog = Object.freeze({`,
  );
  for (const entry of model.entries) {
    const desc = entry.description.split('\n');
    lines.push(`  // @desc: ${desc[0]}`);
    for (const line of desc.slice(1)) lines.push(line === '' ? '  //' : `  // ${line}`);
    if (!entry.translated) lines.push('  // @translated: false');
    const value = entry.kind === 'plain' ? quoteTs(entry.text) : closureTs(tag, entry);
    lines.push(`  '${entry.key}': ${value},`);
  }
  lines.push('} satisfies Catalog);', '');
  return lines.join('\n');
}

/** The first difference between two models as text, or '' when they agree. */
function modelDiff(a, b) {
  const project = (e) =>
    JSON.stringify([e.key, e.kind, e.text, e.params, e.plurals, e.description, e.translated]);
  if (a.entries.length !== b.entries.length)
    return `${a.entries.length} vs ${b.entries.length} entries`;
  for (let k = 0; k < a.entries.length; k++) {
    if (project(a.entries[k]) !== project(b.entries[k])) return `'${a.entries[k].key}' differs`;
  }
  return '';
}

/** validate -> emit -> self re-parse -> `<outPath>.tmp` -> rename. Sync; nothing written on error. */
export function importLocale(tag, jsonText, { enModel, outPath }) {
  if (tag === 'en') fail('LOCALE-IS-SOURCE', 'en is the source locale — edit catalog.en.ts');
  let json;
  try {
    json = JSON.parse(jsonText);
  } catch (err) {
    fail('JSON-INVALID', err.message);
  }
  const model = validateImport(json, { tag, enModel });
  const emitted = emitCatalogTs(tag, model);
  const diff = modelDiff(model, parseCatalogSource(emitted, { tag, file: basename(outPath) }));
  if (diff !== '') fail('EMIT-MISMATCH', diff);
  writeFileSync(`${outPath}.tmp`, emitted, 'utf8');
  renameSync(`${outPath}.tmp`, outPath);
}

// ---------------------------------------------------------------------------
// CLI (main-guarded — a static import never runs it).
// ---------------------------------------------------------------------------

const USAGE = 'usage: node scripts/catalog-import.mjs <tag> <file.icu.json> [--out <path>]';

function main(argv) {
  const positional = [];
  let out;
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--out' && argv[k + 1] !== undefined) {
      out = argv[k + 1];
      k += 1;
    } else if (argv[k].startsWith('--')) {
      positional.push(undefined);
    } else positional.push(argv[k]);
  }
  if (positional.length !== 2 || positional.includes(undefined)) {
    console.error(USAGE);
    return 2;
  }
  const [tag, file] = positional;
  const outPath = resolve(out ?? join(I18N_DIR, `catalog.${tag}.ts`));
  const enModel = parseCatalogSource(readFileSync(join(I18N_DIR, 'catalog.en.ts'), 'utf8'), {
    tag: 'en',
    file: 'catalog.en.ts',
  });
  importLocale(tag, readFileSync(resolve(file), 'utf8'), { enModel, outPath });
  console.log(`catalog-import: ${tag} -> ${outPath}`);
  if (!discoverLocales().includes(tag)) {
    // Registration is deliberately manual (ADR-0263): four edits, none of them generated.
    console.log(
      [
        `catalog-import: '${tag}' is not registered yet — four manual edits:`,
        `  1. client/src/ui/i18n/resolver.ts: add CATALOG_${tag.toUpperCase()} (from ./catalog.${tag}) to CATALOGS`,
        `  2. client/src/ui/i18n/resolver.test.ts: extend the registry pin with '${tag}'`,
        `  3. client/src/ui/i18n/catalogParity.test.ts: add '${tag}' to PLURAL_CATEGORIES`,
        '  4. client/src/ui/i18n/catalogParity.test.ts: add to PLURAL_PARAM_KEYS every key this',
        '     locale pluralizes that en does not',
      ].join('\n'),
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
      err.message.startsWith('catalog-import:')
        ? err.message
        : `catalog-import: ${err.code} ${err.message}`,
    );
    process.exitCode = 2;
  }
}
